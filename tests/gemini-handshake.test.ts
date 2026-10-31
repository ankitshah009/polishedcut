/**
 * The Google handshake: the concurrency gate, Retry-After, Files API states and the per-run upload
 * registry that lets a finished run delete its footage from the Files API. Fake client, no network.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { GoogleGenAI } from "@google/genai";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { makeFixtureClip } from "./fixtures";

let tmp: string;
let gemini: typeof import("../lib/gemini");
const RUN_ID = "abcdef0123";

const saved = { RUNS_DIR: process.env.RUNS_DIR, GEMINI_CONCURRENCY: process.env.GEMINI_CONCURRENCY, KEEP_UPLOADS: process.env.KEEP_UPLOADS };

beforeAll(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "gemini-handshake-"));
  process.env.RUNS_DIR = tmp;
  process.env.GEMINI_CONCURRENCY = "2";
  delete process.env.KEEP_UPLOADS;
  vi.resetModules();
  gemini = await import("../lib/gemini");
  mkdirSync(path.join(tmp, RUN_ID, "proxies"), { recursive: true });
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  rmSync(tmp, { recursive: true, force: true });
});

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const http =(status: number, message = `HTTP ${status}`) => Object.assign(new Error(message), { status });
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Handle = { name: string; uri: string; mimeType: string; state: string; error?: { message: string; code?: number } };
const active = (name: string): Handle => ({ name, uri: `https://files.example/${name}`, mimeType: "video/mp4", state: "ACTIVE" });
const EDL = JSON.stringify({ title: "", cuts: [{ id: "x", clipId: "clip1", srcIn: 0, srcOut: 1, reason: "" }], captions: [] });

/** A fake GoogleGenAI that records in-flight counts for uploads and interactions. */
function fakeClient(opts: { delayMs?: number; upload?: (file: string) => Promise<Handle>; get?: (name: string) => Promise<Handle> } = {}) {
  const delay = opts.delayMs ?? 30;
  const stats = { inFlight: 0, maxInFlight: 0 };
  const track = async <T>(fn: () => Promise<T>): Promise<T> => {
    stats.inFlight++;
    stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
    try {
      await tick(delay);
      return await fn();
    } finally {
      stats.inFlight--;
    }
  };
  const upload = vi.fn(({ file }: { file: string }) => track(() => (opts.upload ?? (async (f: string) => active(`files/${path.basename(f, ".mp4")}`)))(file)));
  const get = vi.fn(({ name }: { name: string }) => track(() => (opts.get ?? (async (n: string) => active(n)))(name)));
  const del = vi.fn(async () => ({}));
  const create = vi.fn(() => track(async () => ({ output_text: EDL })));
  const client = { files: { upload, get, delete: del }, interactions: { create } } as unknown as GoogleGenAI;
  return { client, stats, upload, get, del, create };
}

function clipInputs(names: string[], dir = path.join(tmp, RUN_ID, "proxies")) {
  return names.map((name, i) => {
    const file = path.join(dir, `${name}.mp4`);
    writeFileSync(file, `fake video ${name} ${i}`);
    return { clip: { id: `clip${i + 1}`, path: file, duration: 1, transcript: [] }, file };
  });
}

/** A fresh run directory (with proxies/) so registry tests never see each other's uploads. */
let runCounter = 0;
function newRun(): string {
  const id = `ab${String(++runCounter).padStart(8, "0")}`;
  mkdirSync(path.join(tmp, id, "proxies"), { recursive: true });
  return id;
}

describe("createGate", () => {
  it("never runs more than `limit` calls at once and keeps FIFO order", async () => {
    const gate = gemini.createGate(2);
    let inFlight = 0;
    let max = 0;
    const order: number[] = [];
    const tasks = Array.from({ length: 6 }, (_, i) =>
      gate(async () => {
        inFlight++;
        max = Math.max(max, inFlight);
        order.push(i);
        await tick(10);
        inFlight--;
        return i;
      }),
    );
    expect(gate.inFlight).toBe(2);
    expect(gate.waiting).toBe(4);
    expect(await Promise.all(tasks)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(order).toEqual([0, 1, 2, 3, 4, 5]);
    expect(max).toBe(2);
    expect(gate.inFlight).toBe(0);
    expect(gate.limit).toBe(2);
  });

  it("releases the slot when a call throws", async () => {
    const gate = gemini.createGate(1);
    await expect(gate(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(gate.inFlight).toBe(0);
    await expect(gate(async () => "ok")).resolves.toBe("ok");
  });

  it("rejects a non-positive limit; the shared gate follows GEMINI_CONCURRENCY", () => {
    expect(() => gemini.createGate(0)).toThrow(/positive integer/);
    expect(gemini.geminiGate.limit).toBe(2);
  });
});

describe("retryAfterMs", () => {
  it("reads a Retry-After header in seconds or as a date, on the error or its response", () => {
    expect(gemini.retryAfterMs(Object.assign(new Error("x"), { headers: new Headers({ "retry-after": "7" }) }))).toBe(7000);
    expect(gemini.retryAfterMs(Object.assign(new Error("x"), { headers: { "Retry-After": "2.5" } }))).toBe(2500);
    const now = Date.parse("2026-10-25T10:00:00Z");
    const later = new Date(now + 9000).toUTCString();
    expect(gemini.retryAfterMs({ response: { headers: { "retry-after": later } } }, () => now)).toBe(9000);
  });
  it("reads Google's 429 message and caps the wait at 60s", () => {
    expect(gemini.retryAfterMs(http(429, "Resource exhausted. Please retry in 23.4s."))).toBe(23400);
    expect(gemini.retryAfterMs(http(429, '{"error":{"details":[{"retryDelay":"12s"}]}}'))).toBe(12000);
    expect(gemini.retryAfterMs(http(429, "Please retry in 600s"))).toBe(gemini.RETRY_AFTER_MAX_MS);
    expect(gemini.retryAfterMs(http(429, "quota exceeded"))).toBeUndefined();
    expect(gemini.retryAfterMs(new Error("retry in a moment"))).toBeUndefined();
    expect(gemini.retryAfterMs("nope")).toBeUndefined();
  });
  it("withRetry waits at least the Retry-After instead of the shorter backoff", async () => {
    const delays: number[] = [];
    const sleep = async (ms: number) => {
      delays.push(ms);
    };
    const fn = vi.fn<() => Promise<string>>().mockRejectedValueOnce(http(429, "Please retry in 5s")).mockResolvedValue("ok");
    await expect(gemini.withRetry(fn, { label: "t", sleep })).resolves.toBe("ok");
    expect(delays).toEqual([5000]);
    expect(String(warn.mock.calls[0][0])).toMatch(/server asked for 5000ms/);
  });
});

describe("createGeminiEditor gate and Files API states", () => {
  it("limits parallel uploads and interactions to GEMINI_CONCURRENCY", async () => {
    const fake = fakeClient();
    const editor = gemini.createGeminiEditor({ client: fake.client, runId: RUN_ID });
    const clips = clipInputs(["g1", "g2", "g3", "g4", "g5"]);
    const out = await editor.draft("brief", clips, { width: 1280, height: 720, fps: 30 });
    expect(out.cuts.map((c) => c.id)).toEqual(["c1"]);
    expect(fake.upload).toHaveBeenCalledTimes(5);
    expect(fake.stats.maxInFlight).toBe(2);
    expect(gemini.geminiGate.inFlight).toBe(0);

    // Five parallel transcriptions share the same gate.
    fake.stats.maxInFlight = 0;
    fake.create.mockImplementation(() => Promise.resolve({ output_text: "[]" }));
    await Promise.all(clips.map((c) => editor.transcribe(c)));
    expect(fake.stats.maxInFlight).toBeLessThanOrEqual(2);
  }, 20_000);

  it("explains a FAILED upload and an unknown terminal state", async () => {
    const failed = fakeClient({
      upload: async (f) => ({ ...active(`files/${path.basename(f, ".mp4")}`), state: "FAILED", error: { message: "Unsupported codec", code: 3 } }),
    });
    const [clip] = clipInputs(["bad"]);
    await expect(gemini.createGeminiEditor(failed.client).draft("b", [clip])).rejects.toThrow(/Files API rejected bad\.mp4 \(Unsupported codec, code 3\)/);
    const weird = fakeClient({ upload: async (f) => ({ ...active(`files/${path.basename(f, ".mp4")}`), state: "STATE_UNSPECIFIED" }) });
    const [clip2] = clipInputs(["odd"]);
    await expect(gemini.createGeminiEditor(weird.client).draft("b", [clip2])).rejects.toThrow(/ended in state STATE_UNSPECIFIED/);
  });

  it("gives up on an upload that stays PROCESSING past LLM_TIMEOUT_MS with a clear message", async () => {
    process.env.LLM_TIMEOUT_MS = "1";
    vi.resetModules();
    try {
      const g = await import("../lib/gemini");
      const stuck = fakeClient({
        upload: async (f) => ({ ...active(`files/${path.basename(f, ".mp4")}`), state: "PROCESSING" }),
        get: async (n) => ({ ...active(n), state: "PROCESSING" }),
      });
      const [clip] = clipInputs(["slow"]);
      await expect(g.createGeminiEditor(stuck.client).draft("b", [clip])).rejects.toThrow(/still processing slow\.mp4 .*LLM_TIMEOUT_MS/);
    } finally {
      delete process.env.LLM_TIMEOUT_MS;
      vi.resetModules();
    }
  }, 15_000);
});

describe("upload registry and deleteUploads", () => {
  it("records every upload of a run and deletes them from the Files API afterwards, dropping the cache entries", async () => {
    const run = newRun();
    const fake = fakeClient();
    const editor = gemini.createGeminiEditor({ client: fake.client, runId: run });
    const clips = clipInputs(["r1", "r2"], path.join(tmp, run, "proxies"));
    await editor.draft("brief", clips, { width: 1280, height: 720, fps: 30 });
    // The critique upload (a render under the run directory) is registered by path, with no runId given.
    const render = path.join(tmp, run, "iter1.mp4");
    writeFileSync(render, "fake render");
    fake.create.mockImplementation(() => Promise.resolve({ output_text: JSON.stringify({ checks: [], patches: [], summary: "" }) }));
    await gemini.createGeminiEditor(fake.client).critique("brief", { width: 1280, height: 720, fps: 30, title: "", cuts: [], captions: [], overlays: [] }, render, clips);

    const registry = JSON.parse(readFileSync(path.join(tmp, run, gemini.UPLOADS_FILE), "utf8")) as Record<string, { name: string }>;
    const names = Object.values(registry).map((h) => h.name).sort();
    expect(names).toEqual(["files/iter1", "files/r1", "files/r2"]);
    expect(await gemini.listUploads(run)).toHaveLength(3);
    const cacheBefore = JSON.parse(readFileSync(path.join(tmp, ".upload_cache.json"), "utf8")) as Record<string, unknown>;
    for (const digest of Object.keys(registry)) expect(cacheBefore).toHaveProperty(digest);

    const result = await gemini.deleteUploads(run, fake.client);
    expect(result.deleted.sort()).toEqual(names);
    expect(result.failed).toEqual([]);
    expect(fake.del).toHaveBeenCalledTimes(3);
    expect(fake.del.mock.calls.map((c) => (c as unknown as [{ name: string }])[0].name).sort()).toEqual(names);
    expect(existsSync(path.join(tmp, run, gemini.UPLOADS_FILE))).toBe(false);
    const cacheAfter = JSON.parse(readFileSync(path.join(tmp, ".upload_cache.json"), "utf8")) as Record<string, unknown>;
    for (const digest of Object.keys(registry)) expect(cacheAfter).not.toHaveProperty(digest);

    // Idempotent, and a no-op without a registry.
    expect(await gemini.deleteUploads(run, fake.client)).toEqual({ deleted: [], failed: [] });
    expect(fake.del).toHaveBeenCalledTimes(3);
  });

  it("treats 404 as deleted, keeps handles the API would not delete, and needs no client without a registry", async () => {
    const run = newRun();
    const fake = fakeClient();
    const editor = gemini.createGeminiEditor({ client: fake.client, runId: run });
    const clips = clipInputs(["k1", "k2"], path.join(tmp, run, "proxies"));
    await editor.draft("brief", clips, { width: 1280, height: 720, fps: 30 });
    fake.del.mockImplementation(async (...args: unknown[]) => {
      const { name } = args[0] as { name: string };
      if (name === "files/k1") throw http(404);
      throw http(500, "flaky");
    });
    const result = await gemini.deleteUploads(run, fake.client);
    expect(result.deleted).toEqual(["files/k1"]);
    expect(result.failed).toEqual(["files/k2"]);
    expect((await gemini.listUploads(run)).map((h) => h.name)).toEqual(["files/k2"]);

    fake.del.mockImplementation(async () => ({}));
    expect(await gemini.deleteUploads(run, fake.client)).toEqual({ deleted: ["files/k2"], failed: [] });
    expect(await gemini.listUploads(run)).toEqual([]);

    // Nothing recorded for an unrelated run: resolves without touching the client or a key.
    vi.stubEnv("GEMINI_API_KEY", "");
    expect(await gemini.deleteUploads("0123456789")).toEqual({ deleted: [], failed: [] });
    vi.unstubAllEnvs();
  });

  it("files outside RUNS_DIR/<runId> are not registered; runIdOf tells them apart", () => {
    expect(gemini.runIdOf(path.join(tmp, RUN_ID, "proxies", "clip1.mp4"))).toBe(RUN_ID);
    expect(gemini.runIdOf(path.join(tmp, RUN_ID, "iter2.mp4"))).toBe(RUN_ID);
    expect(gemini.runIdOf(path.join(tmp, "clip1.mp4"))).toBeNull();
    expect(gemini.runIdOf(path.join(tmp, "not-a-run", "clip1.mp4"))).toBeNull();
    expect(gemini.runIdOf("/elsewhere/abcdef0123/clip1.mp4")).toBeNull();
  });

  it("cleanupRunUploads deletes by default and keeps everything with KEEP_UPLOADS=1", async () => {
    const run = newRun();
    const dir = path.join(tmp, run, "proxies");
    const fake = fakeClient();
    const editor = gemini.createGeminiEditor({ client: fake.client, runId: run });
    await editor.draft("brief", clipInputs(["c1"], dir), { width: 1280, height: 720, fps: 30 });
    expect(await gemini.cleanupRunUploads(run, fake.client)).toEqual({ deleted: ["files/c1"], failed: [] });

    process.env.KEEP_UPLOADS = "1";
    vi.resetModules();
    try {
      const keep = await import("../lib/gemini");
      await keep.createGeminiEditor({ client: fake.client, runId: run }).draft("brief", clipInputs(["c2"], dir), { width: 1280, height: 720, fps: 30 });
      fake.del.mockClear();
      expect(await keep.cleanupRunUploads(run, fake.client)).toBeNull();
      expect(fake.del).not.toHaveBeenCalled();
      expect((await keep.listUploads(run)).map((h) => h.name)).toEqual(["files/c2"]);
    } finally {
      delete process.env.KEEP_UPLOADS;
      vi.resetModules();
    }
  });
});

describe("draft output size", () => {
  it("defaults to landscape 1920x1080 when the proxies cannot be probed, and uses an explicit output as given", async () => {
    const fake = fakeClient();
    const editor = gemini.createGeminiEditor({ client: fake.client, runId: RUN_ID });
    const clips = clipInputs(["o1"]);
    const auto = await editor.draft("brief", clips);
    expect(auto).toMatchObject({ width: 1920, height: 1080, fps: 30 });
    const forced = await editor.draft("brief", clips, { width: 1080, height: 1080, fps: 24 });
    expect(forced).toMatchObject({ width: 1080, height: 1080, fps: 24 });
  });

  it("follows real portrait proxies to 1080x1920 and the brief to a vertical", async () => {
    const dir = path.join(tmp, RUN_ID, "proxies");
    const portrait = await makeFixtureClip(dir, "vert.mp4", { seconds: 1, width: 480, height: 854 });
    const landscape = await makeFixtureClip(dir, "wide.mp4", { seconds: 1, width: 854, height: 480 });
    const fake = fakeClient();
    const editor = gemini.createGeminiEditor({ client: fake.client, runId: RUN_ID });
    const input = (file: string, id: string) => ({ clip: { id, path: file, duration: 1, transcript: [] }, file });
    expect(await editor.draft("brief", [input(portrait, "clip1")])).toMatchObject({ width: 1080, height: 1920 });
    expect(await editor.draft("brief", [input(landscape, "clip1")])).toMatchObject({ width: 1920, height: 1080 });
    expect(await editor.draft("make it a vertical for TikTok", [input(landscape, "clip1")])).toMatchObject({ width: 1080, height: 1920 });
    expect(await gemini.outputForClips([input(portrait, "clip1"), input(landscape, "clip2")], "")).toMatchObject({ width: 1920, height: 1080 });
  }, 30_000);
});
