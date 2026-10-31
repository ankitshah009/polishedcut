import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { POST as callbackPost } from "../app/api/frame-analysis/callback/[job]/[token]/route";
import { CallbackRegistry, analyzeClip, callbackUrlFor, callbacks, clipUrlFor, extractFrames, holdsAnalysis, parseAnalysis, unwrapResult, type FrameAnalysis } from "../lib/frame-analyst";
import { createLocalEditor } from "../lib/local-editor";
import { makeFixtureClip } from "./fixtures";

const runsDir = mkdtempSync(path.join(os.tmpdir(), "pc-frames-"));
const clip = { clipId: "clip1", file: path.join(runsDir, "run1", "proxies", "clip1.mp4"), duration: 20 };
const publicUrl = "https://polishedcut.example";
const hook = "https://nebula.example/hook";
const sleep = async () => {};
type Fetch = typeof globalThis.fetch;

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** No stills (the clip file need not exist) and no process-wide callback registry unless a test says so. */
const base = { url: hook, publicUrl, runsDir, sleep, frames: 0, callbacks: null as CallbackRegistry | null };

const result = {
  words: [
    { text: "hello", start: 0.5, end: 0.9 },
    { text: "world", start: 1.0, end: 1.4 },
  ],
  sound: [[0, 2.5], [4, 20]],
  shots: [{ start: 0, end: 10 }, { start: 10, end: 25 }],
  summary: "someone greets the camera",
};

describe("clipUrlFor", () => {
  it("maps RUNS_DIR/<run>/<rel> onto the files route under PUBLIC_URL", () => {
    expect(clipUrlFor(clip.file, runsDir, publicUrl)).toBe(`${publicUrl}/api/runs/run1/files/proxies/clip1.mp4`);
  });
  it("refuses files outside RUNS_DIR and a missing public origin", () => {
    expect(() => clipUrlFor("/tmp/elsewhere.mp4", runsDir, publicUrl)).toThrow(/not inside RUNS_DIR/);
    expect(() => clipUrlFor(clip.file, runsDir, "")).toThrow(/PUBLIC_URL/);
  });
});

describe("parseAnalysis", () => {
  it("normalises words and both region shapes, clamping to the clip", () => {
    const a = parseAnalysis(result, 20, "u", 5);
    expect(a.words.map((w) => w.text)).toEqual(["hello", "world"]);
    expect(a.sound).toEqual([[0, 2.5], [4, 20]]);
    expect(a.shots).toEqual([[0, 10], [10, 20]]);
    expect(a.summary).toBe("someone greets the camera");
    expect(a.via).toBe("response");
  });
  it("unwraps a wrapped or text reply from the agent", () => {
    expect(unwrapResult({ result: result })).toEqual(result);
    const text = { reply: "Here you go:\n```json\n" + JSON.stringify(result) + "\n```" };
    expect(parseAnalysis(text, 20, "u", 1).words).toHaveLength(2);
  });
  it("rejects a body with no analysis in it", () => {
    expect(() => parseAnalysis({ ok: true }, 20, "u", 1)).toThrow(/no usable analysis/);
    expect(() => parseAnalysis("thanks!", 20, "u", 1)).toThrow(/no usable analysis/);
  });
  it("tells an analysis from an acknowledgment", () => {
    expect(holdsAnalysis({ success: true, message: "Webhook received" })).toBe(false);
    expect(holdsAnalysis({ status: "queued", status_url: "/jobs/1" })).toBe(false);
    expect(holdsAnalysis({ output: { shots: [[0, 5]] } })).toBe(true);
    expect(holdsAnalysis("```json\n{\"shots\": [[0, 5]]}\n```")).toBe(true);
  });
});

describe("extractFrames", () => {
  it("samples evenly spaced stills under <run>/analysis/frames/<clip> and gives them public URLs", async () => {
    const dir = path.join(runsDir, "run2", "proxies");
    mkdirSync(dir, { recursive: true });
    const file = await makeFixtureClip(dir, "clip7.mp4", { seconds: 2, audio: false });
    const stills = await extractFrames({ clipId: "clip7", file, duration: 2 }, 4, runsDir);
    expect(stills.map((s) => s.t)).toEqual([0, 0.5, 1, 1.5]);
    for (const s of stills) expect(existsSync(s.file)).toBe(true);
    expect(clipUrlFor(stills[0].file, runsDir, publicUrl)).toBe(`${publicUrl}/api/runs/run2/files/analysis/frames/clip7/f01.jpg`);
    // The payload lists them.
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.frames).toHaveLength(4);
      expect(body.frames[3]).toEqual({ t: 1.5, url: `${publicUrl}/api/runs/run2/files/analysis/frames/clip7/f04.jpg` });
      expect(body.prompt).toMatch(/JSON/);
      return json(result);
    });
    const a = await analyzeClip({ clipId: "clip7", file, duration: 2 }, { ...base, frames: 4, fetch: fetch as unknown as Fetch });
    expect(a.frames).toBe(4);
  });
  it("sends nothing when asked for zero", async () => {
    await expect(extractFrames(clip, 0, runsDir)).resolves.toEqual([]);
  });
});

describe("analyzeClip", () => {
  it("POSTs the clip URL with the secret in Nebula's header and reads a 200 result", async () => {
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(hook);
      expect(init?.method).toBe("POST");
      const headers = init?.headers as Record<string, string>;
      expect(headers["x-webhook-secret"]).toBe("s3cret");
      expect(headers.authorization).toBe("Bearer s3cret");
      const body = JSON.parse(String(init?.body));
      expect(body.task).toBe("frame-analysis");
      expect(body.clip).toEqual({ id: "clip1", url: `${publicUrl}/api/runs/run1/files/proxies/clip1.mp4`, mime_type: "video/mp4", duration_seconds: 20 });
      expect(body.frames).toEqual([]);
      expect(body.callback_url).toBeUndefined();
      return json(result);
    });
    const a = await analyzeClip(clip, { ...base, secret: "s3cret", fetch: fetch as unknown as Fetch });
    expect(a.words).toHaveLength(2);
    expect(a.source).toBe(hook);
    expect(a.via).toBe("response");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("follows a 202 to its status URL until the job finishes", async () => {
    let polls = 0;
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") return json({ status: "queued", status_url: "/jobs/42" }, 202);
      expect(String(url)).toBe("https://nebula.example/jobs/42");
      polls += 1;
      return polls < 3 ? json({ status: "running" }) : json({ status: "done", output: result });
    });
    const a = await analyzeClip(clip, { ...base, fetch: fetch as unknown as Fetch, pollMs: 1 });
    expect(a.sound).toHaveLength(2);
    expect(a.via).toBe("poll");
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("surfaces an HTTP error and an acknowledgment with nowhere to get the result from", async () => {
    const bad = vi.fn(async () => new Response("nope", { status: 401 }));
    await expect(analyzeClip(clip, { ...base, fetch: bad as unknown as Fetch })).rejects.toThrow(/401: nope/);
    const ack = vi.fn(async () => json({ success: true, message: "Webhook received" }));
    await expect(analyzeClip(clip, { ...base, fetch: ack as unknown as Fetch })).rejects.toThrow(/without a result, a status_url to poll, or a callback/);
  });

  it("names the webhook when the network call itself fails", async () => {
    const down = vi.fn(async () => {
      throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:3799") });
    });
    await expect(analyzeClip(clip, { ...base, url: "http://127.0.0.1:3799/analyze", fetch: down as unknown as Fetch })).rejects.toThrow(
      /webhook http:\/\/127\.0\.0\.1:3799\/analyze unreachable: connect ECONNREFUSED/,
    );
  });
});

describe("analyzeClip over Nebula's acknowledge-then-callback flow", () => {
  const post = (url: string, body: unknown) => {
    const [, job, token] = url.match(/\/callback\/([0-9a-f]+)\/([0-9a-f]+)$/)!;
    return callbackPost(new Request(url, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }), { params: Promise.resolve({ job, token }) });
  };

  it("includes callback_url, accepts { success, message }, and resolves when the route receives the result", async () => {
    let callbackUrl = "";
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      callbackUrl = JSON.parse(String(init?.body)).callback_url;
      return json({ success: true, message: "Webhook received" });
    });
    const pending = analyzeClip(clip, { ...base, callbacks, fetch: fetch as unknown as Fetch, timeoutMs: 5000 });
    await vi.waitFor(() => expect(callbackUrl).toMatch(new RegExp(`^${publicUrl}/api/frame-analysis/callback/[0-9a-f]{16}/[0-9a-f]{32}$`)));
    expect(callbacks.size).toBe(1);

    // Wrong token and unknown job are refused and leave the analysis waiting.
    const wrong = await post(callbackUrl.replace(/[0-9a-f]{32}$/, "0".repeat(32)), result);
    expect(wrong.status).toBe(403);
    const unknown = await post(callbackUrl.replace(/\/callback\/[0-9a-f]{16}\//, "/callback/0000000000000000/"), result);
    expect(unknown.status).toBe(404);
    expect(callbacks.size).toBe(1);

    // The agent's answer, as prose around JSON, the way a model tends to reply.
    const ok = await post(callbackUrl, "Here is the analysis:\n```json\n" + JSON.stringify({ shots: [[0, 8], [8, 20]], summary: "a desk, then a window" }) + "\n```");
    expect(ok.status).toBe(200);
    const a = await pending;
    expect(a.via).toBe("callback");
    expect(a.shots).toEqual([[0, 8], [8, 20]]);
    expect(a.words).toEqual([]);
    expect(a.summary).toBe("a desk, then a window");
    expect(callbacks.size).toBe(0);
    // A second delivery has nothing to land on.
    expect((await post(callbackUrl, result)).status).toBe(404);
  });

  it("gives up when nothing calls back within the budget, and forgets the job", async () => {
    const registry = new CallbackRegistry();
    const fetch = vi.fn(async () => json({ success: true, message: "Webhook received" }));
    await expect(analyzeClip(clip, { ...base, callbacks: registry, fetch: fetch as unknown as Fetch, timeoutMs: 1 })).rejects.toThrow(/did not call back for clip1 within 0s \(webhook said 200/);
    expect(registry.size).toBe(0);
  });

  it("builds the callback URL under PUBLIC_URL", () => {
    expect(callbackUrlFor("abc", "def", publicUrl)).toBe(`${publicUrl}/api/frame-analysis/callback/abc/def`);
  });
});

describe("local editor with an injected frame analyzer", () => {
  const analysis: FrameAnalysis = { words: [], sound: [[2, 8]], shots: [[0, 20]], source: "double", via: "response", frames: 0, ms: 1 };
  const spoken: FrameAnalysis = { ...analysis, words: "robots can see but they cannot remember what they saw".split(" ").map((t, i) => ({ text: t, start: 1 + i * 0.4, end: 1.35 + i * 0.4 })) };

  it("takes transcripts from the analyzer, never whisper", async () => {
    const frames = vi.fn(async () => spoken);
    const editor = createLocalEditor({ frames });
    const words = await editor.transcribe({ clip: { id: "clip1", path: "src/clip1.mp4", duration: 20, transcript: [] }, file: clip.file });
    expect(words).toHaveLength(10);
    expect(frames).toHaveBeenCalledWith({ clipId: "clip1", file: clip.file, duration: 20 });
  });

  it("drafts a silent clip from the analyzer's sound regions, never ffmpeg", async () => {
    const frames = vi.fn(async () => analysis);
    const editor = createLocalEditor({ frames });
    const edl = await editor.draft("Cut a 5-second teaser.", [{ clip: { id: "clip1", path: "src/clip1.mp4", duration: 20, transcript: [] }, file: clip.file }], { width: 1920, height: 1080, fps: 30 });
    expect(edl.cuts.length).toBeGreaterThan(0);
    // The planner pads a cut slightly into the silence around its region.
    for (const c of edl.cuts) {
      expect(c.srcIn).toBeGreaterThanOrEqual(1.5);
      expect(c.srcOut).toBeLessThanOrEqual(8.5);
    }
    expect(frames).toHaveBeenCalledTimes(1);
  });

  it("does not hide an analyzer failure behind the local tools", async () => {
    const frames = vi.fn(async () => {
      throw new Error("Frame Analyst webhook 503: busy");
    });
    const editor = createLocalEditor({ frames });
    await expect(editor.transcribe({ clip: { id: "clip1", path: "src/clip1.mp4", duration: 20, transcript: [] }, file: clip.file })).rejects.toThrow(/503/);
  });
});
