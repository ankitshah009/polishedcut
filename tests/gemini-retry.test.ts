import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { GoogleGenAI } from "@google/genai";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// RUNS_DIR is fixed at import time (the upload cache lives there), so point it at a temp dir first.
let tmp: string;
let gemini: typeof import("../lib/gemini");

beforeAll(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "gemini-retry-test-"));
  process.env.RUNS_DIR = tmp;
  vi.resetModules();
  gemini = await import("../lib/gemini");
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const noSleep = async () => {};
const http = (status: number, message = `HTTP ${status}`) => Object.assign(new Error(message), { status });

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

describe("withRetry", () => {
  it("retries a 503 then succeeds, logging one warning", async () => {
    const fn = vi.fn<() => Promise<string>>().mockRejectedValueOnce(http(503)).mockResolvedValue("ok");
    await expect(gemini.withRetry(fn, { label: "t", sleep: noSleep })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/^\[gemini\] retry t 1\/4 /);
  });

  it("gives up after 4 attempts", async () => {
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(http(503, "unavailable"));
    await expect(gemini.withRetry(fn, { label: "t", sleep: noSleep })).rejects.toThrow("unavailable");
    expect(fn).toHaveBeenCalledTimes(4);
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it("does not retry 400, 401 or 403", async () => {
    for (const status of [400, 401, 403]) {
      const fn = vi.fn<() => Promise<string>>().mockRejectedValue(http(status));
      await expect(gemini.withRetry(fn, { label: "t", sleep: noSleep })).rejects.toThrow(`HTTP ${status}`);
      expect(fn).toHaveBeenCalledTimes(1);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it("retries network errors with 0.5s, 1s, 2s backoff (jittered)", async () => {
    const delays: number[] = [];
    const sleep = async (ms: number) => {
      delays.push(ms);
    };
    const fetchFailed = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    const timedOut = Object.assign(new Error("connect ETIMEDOUT 1.2.3.4:443"), { code: "ETIMEDOUT" });
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(fetchFailed)
      .mockRejectedValueOnce(timedOut)
      .mockRejectedValueOnce(http(429))
      .mockResolvedValue("ok");
    await expect(gemini.withRetry(fn, { label: "t", sleep })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(4);
    expect(delays).toHaveLength(3);
    for (const [i, base] of [500, 1000, 2000].entries()) {
      expect(delays[i]).toBeGreaterThanOrEqual(base * 0.8);
      expect(delays[i]).toBeLessThanOrEqual(base * 1.2);
    }
  });

  it("maps HTTP 402 to CreditsExhaustedError without retrying", async () => {
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(http(402, "Payment Required"));
    const p = gemini.withRetry(fn, { label: "t", sleep: noSleep });
    await expect(p).rejects.toBeInstanceOf(gemini.CreditsExhaustedError);
    await expect(p).rejects.toThrow("Gemini credits are exhausted for this key. Top up at https://aistudio.google.com/billing");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    expect(gemini.isRetryable(http(402))).toBe(false);
  });

  it("never prints the API key", async () => {
    vi.stubEnv("GEMINI_API_KEY", "sk-super-secret-value");
    try {
      const fn = vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(http(503, "boom sk-super-secret-value ?key=sk-super-secret-value"))
        .mockResolvedValue("ok");
      await gemini.withRetry(fn, { label: "t", sleep: noSleep });
      expect(String(warn.mock.calls[0][0])).not.toContain("sk-super-secret-value");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("isRetryable", () => {
  it("classifies HTTP statuses and transport errors", () => {
    for (const s of [429, 500, 502, 503, 504]) expect(gemini.isRetryable(http(s))).toBe(true);
    for (const s of [400, 401, 403, 404, 422]) expect(gemini.isRetryable(http(s))).toBe(false);
    expect(gemini.isRetryable(Object.assign(new Error("x"), { statusCode: 502 }))).toBe(true);
    expect(gemini.isRetryable(new TypeError("fetch failed"))).toBe(true);
    expect(gemini.isRetryable(new Error("Connection error."))).toBe(true);
    expect(gemini.isRetryable(new gemini.RetryableError("empty"))).toBe(true);
    expect(gemini.isRetryable(new Error("boom"))).toBe(false);
    expect(gemini.isRetryable("nope")).toBe(false);
  });
});

describe("createGeminiEditor with a fake client", () => {
  it("reads an empty transcription reply as a silent clip after one structured and one plain attempt", async () => {
    const file = path.join(tmp, "silent.mp4");
    writeFileSync(file, "fake silent video");
    const handle = { name: "files/silent", uri: "https://files.example/silent", mimeType: "video/mp4", state: "ACTIVE" };
    const create = vi.fn().mockResolvedValue({ output_text: "" });
    const client = {
      files: { upload: vi.fn(async () => handle), get: vi.fn(async () => handle) },
      interactions: { create },
    } as unknown as GoogleGenAI;

    const words = await gemini.createGeminiEditor(client).transcribe({ clip: { id: "clip1", path: file, duration: 3, transcript: [] }, file });

    expect(words).toEqual([]);
    // One structured attempt, one plain attempt, no retries and no fallback model.
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls.every((c) => c[0].model === process.env.TRANSCRIBE_MODEL || typeof c[0].model === "string")).toBe(true);
    expect(new Set(create.mock.calls.map((c) => c[0].model)).size).toBe(1);
  });

  it("draft uploads every proxy in parallel and falls back to a plain prompt after an empty structured reply", { timeout: 15_000 }, async () => {
    const files = ["clip1.mp4", "clip2.mp4"].map((name, i) => {
      const f = path.join(tmp, name);
      writeFileSync(f, `fake video ${i}`);
      return f;
    });

    let inFlight = 0;
    let maxInFlight = 0;
    const handle = (name: string) => ({ name, uri: `https://files.example/${name}`, mimeType: "video/mp4", state: "ACTIVE" });
    const upload = vi.fn(async ({ file }: { file: string }) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 40));
      inFlight--;
      return handle(`files/${path.basename(file, ".mp4")}`);
    });
    const get = vi.fn(async ({ name }: { name: string }) => handle(name));
    const edl = JSON.stringify({
      title: "",
      cuts: [
        { id: "x", clipId: "clip1", srcIn: 0, srcOut: 1, reason: "" },
        { id: "y", clipId: "clip2", srcIn: 0, srcOut: 1, reason: "" },
      ],
      captions: [],
    });
    const create = vi.fn().mockResolvedValueOnce({ output_text: "" }).mockResolvedValue({ output_text: edl });
    const client = { files: { upload, get }, interactions: { create } } as unknown as GoogleGenAI;

    const editor = gemini.createGeminiEditor(client);
    const clips = files.map((file, i) => ({ clip: { id: `clip${i + 1}`, path: file, duration: 1, transcript: [] }, file }));
    const out = await editor.draft("brief", clips);

    expect(out.cuts.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(upload).toHaveBeenCalledTimes(2);
    expect(maxInFlight).toBe(2);
    // The empty structured reply is not retried: the second call is the plain-prompt fallback.
    expect(create.mock.calls.map((c) => (c[0].response_format ? "structured" : "plain"))).toEqual(["structured", "plain"]);
    expect(warn).not.toHaveBeenCalledWith(expect.stringMatching(/retry .*empty output_text/));

    // Both parallel uploads landed in the cache (no lost write), and a second draft reuses them.
    const cache = JSON.parse(readFileSync(path.join(tmp, ".upload_cache.json"), "utf8")) as Record<string, { name?: string }>;
    const cachedNames = Object.values(cache).map((h) => h.name);
    expect(cachedNames).toEqual(expect.arrayContaining(["files/clip1", "files/clip2"]));
    await editor.draft("brief", clips);
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it("reports usage for every interaction and upload through onUsage", async () => {
    const file = path.join(tmp, "usage.mp4");
    writeFileSync(file, "fake video for usage");
    const handle = { name: "files/usage", uri: "https://files.example/usage", mimeType: "video/mp4", state: "ACTIVE" };
    const upload = vi.fn(async () => handle);
    const get = vi.fn(async () => handle);
    const edl = JSON.stringify({ title: "", cuts: [{ id: "x", clipId: "clip1", srcIn: 0, srcOut: 1, reason: "" }], captions: [] });
    const create = vi
      .fn()
      // empty reply: still billed, still reported, then retried
      .mockResolvedValueOnce({ output_text: "", usage: { total_input_tokens: 100, total_output_tokens: 0 } })
      .mockResolvedValue({
        output_text: edl,
        usage: { total_input_tokens: 20_000, total_output_tokens: 500, total_thought_tokens: 1_500, total_cached_tokens: 4_000 },
      });
    const client = { files: { upload, get }, interactions: { create } } as unknown as GoogleGenAI;

    const usage: import("../lib/gemini").UsageRecord[] = [];
    const editor = gemini.createGeminiEditor({ client, onUsage: (u) => usage.push(u) });
    await editor.draft("brief", [{ clip: { id: "clip1", path: file, duration: 1, transcript: [] }, file }]);

    expect(usage.map((u) => u.model)).toEqual(["files.upload", "gemini-4-argon", "gemini-4-argon"]);
    expect(usage[0]).toMatchObject({ inputTokens: 0, outputTokens: 0, cachedTokens: 0 });
    expect(usage[1]).toMatchObject({ inputTokens: 100, outputTokens: 0, cachedTokens: 0 });
    expect(usage[2]).toMatchObject({ inputTokens: 20_000, outputTokens: 2_000, cachedTokens: 4_000 });
    for (const u of usage) expect(u.ms).toBeGreaterThanOrEqual(0);

    // No-arg and bare-client forms still work, and a throwing callback is contained.
    expect(typeof gemini.createGeminiEditor(client).draft).toBe("function");
    const noisy = gemini.createGeminiEditor({
      client,
      onUsage: () => {
        throw new Error("bookkeeping bug");
      },
    });
    await expect(noisy.draft("brief", [{ clip: { id: "clip1", path: file, duration: 1, transcript: [] }, file }])).resolves.toBeTruthy();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/onUsage callback failed/));
  });

  it("stops transcription fallback on exhausted credits", async () => {
    const file = path.join(tmp, "credits.mp4");
    writeFileSync(file, "fake video for credits");
    const handle = { name: "files/credits", uri: "https://files.example/credits", mimeType: "video/mp4", state: "ACTIVE" };
    const create = vi.fn().mockRejectedValue(http(402));
    const client = { files: { upload: async () => handle, get: async () => handle }, interactions: { create } } as unknown as GoogleGenAI;
    const editor = gemini.createGeminiEditor({ client });
    await expect(editor.transcribe({ clip: { id: "clip1", path: file, duration: 1, transcript: [] }, file })).rejects.toThrow(/credits are exhausted/);
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe("usageRecord", () => {
  it("folds thinking into output and tolerates a missing usage block", () => {
    expect(gemini.usageRecord("m", undefined, 5)).toEqual({ model: "m", inputTokens: 0, outputTokens: 0, cachedTokens: 0, ms: 5 });
    expect(gemini.usageRecord("m", { total_input_tokens: 10, total_output_tokens: 2, total_thought_tokens: 3 }, 1)).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
    });
  });
});
