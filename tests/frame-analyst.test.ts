import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { analyzeClip, clipUrlFor, parseAnalysis, unwrapResult, type FrameAnalysis } from "../lib/frame-analyst";
import { createLocalEditor } from "../lib/local-editor";

const runsDir = mkdtempSync(path.join(os.tmpdir(), "pc-frames-"));
const clip = { clipId: "clip1", file: path.join(runsDir, "run1", "proxies", "clip1.mp4"), duration: 20 };
const publicUrl = "https://polishedcut.example";
const sleep = async () => {};

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

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
});

describe("analyzeClip", () => {
  it("POSTs the clip URL with the bearer secret and reads a 200 result", async () => {
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://nebula.example/hook");
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer s3cret");
      const body = JSON.parse(String(init?.body));
      expect(body.task).toBe("frame-analysis");
      expect(body.clip).toEqual({ id: "clip1", url: `${publicUrl}/api/runs/run1/files/proxies/clip1.mp4`, mime_type: "video/mp4", duration_seconds: 20 });
      return json(result);
    });
    const a = await analyzeClip(clip, { url: "https://nebula.example/hook", secret: "s3cret", fetch: fetch as unknown as typeof globalThis.fetch, publicUrl, runsDir, sleep });
    expect(a.words).toHaveLength(2);
    expect(a.source).toBe("https://nebula.example/hook");
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
    const a = await analyzeClip(clip, { url: "https://nebula.example/hook", fetch: fetch as unknown as typeof globalThis.fetch, publicUrl, runsDir, sleep, pollMs: 1 });
    expect(a.sound).toHaveLength(2);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("surfaces an HTTP error and a 202 without anywhere to poll", async () => {
    const bad = vi.fn(async () => new Response("nope", { status: 401 }));
    await expect(analyzeClip(clip, { url: "https://nebula.example/hook", fetch: bad as unknown as typeof globalThis.fetch, publicUrl, runsDir, sleep })).rejects.toThrow(/401: nope/);
    const noPoll = vi.fn(async () => json({ accepted: true }, 202));
    await expect(analyzeClip(clip, { url: "https://nebula.example/hook", fetch: noPoll as unknown as typeof globalThis.fetch, publicUrl, runsDir, sleep })).rejects.toThrow(/without a status_url/);
  });

  it("names the webhook when the network call itself fails", async () => {
    const down = vi.fn(async () => {
      throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:3799") });
    });
    await expect(analyzeClip(clip, { url: "http://127.0.0.1:3799/analyze", fetch: down as unknown as typeof globalThis.fetch, publicUrl, runsDir, sleep })).rejects.toThrow(
      /webhook http:\/\/127\.0\.0\.1:3799\/analyze unreachable: connect ECONNREFUSED/,
    );
  });
});

describe("local editor with an injected frame analyzer", () => {
  const analysis: FrameAnalysis = { words: [], sound: [[2, 8]], shots: [[0, 20]], source: "double", ms: 1 };
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
