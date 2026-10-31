// The voice assistant's pure pieces (lib/live.ts) and the token route's input validation. No network:
// the route is called directly with Fetch Requests against a temp RUNS_DIR and never reaches Gemini.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createGeminiEditor } from "../lib/gemini";
import { LIVE_MODEL, PRODUCT_NAME, REVISE_CUT, buildSystemInstruction, failedCheckLines, fixLines, liveConnectConfig, statusUpdate } from "../lib/live";
import type { Run } from "../lib/schema";

const edl = { title: "", cuts: [{ id: "c1", clipId: "clip1", srcIn: 0, srcOut: 4, reason: "" }], captions: [], overlays: [], width: 1280, height: 720, fps: 30 };

function fixtureRun(over: Partial<Run> = {}): Run {
  return {
    id: "abcdef0123",
    brief: "Cut a 20-second teaser; keep the product reveal.",
    createdAt: "2026-10-25T10:00:00.000Z",
    clips: [{ id: "clip1", path: "src/clip1.mp4", duration: 30, transcript: [] }],
    status: "done",
    error: "",
    warnings: [],
    iterations: [
      {
        n: 1,
        edl,
        video: "iter1.mp4",
        critique: {
          checks: [
            { name: "brief: shows the product reveal", passed: true, note: "" },
            { name: "auto: caption overlaps a cut", passed: false, at: 4.2, note: "caption 1 crosses the cut at 4.2s" },
          ],
          patches: [{ op: "set_caption", index: 0, text: "Meet Lumen" }],
          summary: "one caption to fix",
        },
      },
      {
        n: 2,
        edl,
        video: "iter2.mp4",
        critique: { checks: [{ name: "brief: shows the product reveal", passed: true, note: "" }, { name: "auto: caption overlaps a cut", passed: false, at: 4.2, note: "still crosses" }], patches: [], summary: "" },
        note: "make the opening tighter",
      },
    ],
    ...over,
  };
}

describe("buildSystemInstruction", () => {
  it("names the product, quotes the brief, and reports status, score, failures with timestamps and fixes", () => {
    const text = buildSystemInstruction(fixtureRun());
    expect(text).toContain(PRODUCT_NAME);
    expect(text).toContain("Brief: Cut a 20-second teaser; keep the product reveal.");
    expect(text).toContain("Status: finished; the final cut is ready to export.");
    expect(text).toContain("Latest score: 1/2 checks passed (50%).");
    expect(text).toContain("- Caption overlaps a cut at 0:04.2 — still crosses");
    expect(text).toContain("v1 -> v2: Change caption 1 to “Meet Lumen”");
    expect(text).toContain('v2: director\'s note "make the opening tighter"');
    expect(text).toContain(`call the function ${REVISE_CUT}`);
    expect(text).toMatch(/Never invent checks/);
    expect(text).toMatch(/one or two short sentences/);
  });

  it("says nothing is known yet for a run with no versions, and surfaces the error of a stopped run", () => {
    const fresh = buildSystemInstruction(fixtureRun({ status: "drafting", iterations: [] }));
    expect(fresh).toContain("Status: Argon is drafting the first cut.");
    expect(fresh).toContain("Latest score: no version rendered yet.");
    expect(fresh).toContain("Failed checks in the latest version:\n- none");
    expect(fresh).toContain("Fixes applied so far:\n- none yet");

    const stopped = buildSystemInstruction(fixtureRun({ status: "error", error: "ffmpeg exited with code 1" }));
    expect(stopped).toContain("stopped on an error (ffmpeg exited with code 1)");
  });

  it("only ever lists checks that are in the run", () => {
    const run = fixtureRun();
    const lines = failedCheckLines(run.iterations[1]);
    expect(lines).toHaveLength(1);
    expect(failedCheckLines(undefined)).toEqual([]);
    expect(fixLines({ iterations: [] })).toEqual([]);
    // Patches on the last version have not produced a next version yet, so they are not "applied".
    expect(fixLines({ iterations: [run.iterations[0]] })).toEqual([]);
  });
});

describe("statusUpdate", () => {
  it("is a short editor-originated turn with status, score and remaining failures", () => {
    const text = statusUpdate(fixtureRun({ status: "critiquing" }));
    expect(text.startsWith("Status update: ")).toBe(true);
    expect(text).toContain("Argon is watching the latest render");
    expect(text).toContain("v2, 1/2 checks passed (50%)");
    expect(text).toContain("Still failing: Caption overlaps a cut at 0:04.2");
    expect(text.split("\n")).toHaveLength(1);
  });
});

describe("liveConnectConfig", () => {
  it("is an audio session with transcription and exactly the revise_cut tool", () => {
    const cfg = liveConnectConfig("sys");
    expect(cfg.responseModalities).toEqual(["AUDIO"]);
    expect(cfg.systemInstruction).toBe("sys");
    expect(cfg.inputAudioTranscription).toBeDefined();
    expect(cfg.outputAudioTranscription).toBeDefined();
    const tools = cfg.tools as { functionDeclarations?: { name?: string; behavior?: string }[] }[];
    expect(tools).toHaveLength(1);
    expect(tools[0].functionDeclarations?.map((f) => f.name)).toEqual([REVISE_CUT]);
    expect(tools[0].functionDeclarations?.[0].behavior).toBe("NON_BLOCKING");
    expect(LIVE_MODEL).toMatch(/live/);
  });
});

describe("POST /api/live/token", () => {
  let tmp: string;
  let route: typeof import("../app/api/live/token/route");
  const saved = { RUNS_DIR: process.env.RUNS_DIR, GEMINI_API_KEY: process.env.GEMINI_API_KEY, GEMINI_API_KEY_1: process.env.GEMINI_API_KEY_1 };
  const run = fixtureRun();

  beforeAll(async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "live-token-"));
    process.env.RUNS_DIR = tmp;
    // No key: a valid request must fail before any network call, with 503.
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY_1;
    mkdirSync(path.join(tmp, run.id));
    writeFileSync(path.join(tmp, run.id, "run.json"), JSON.stringify(run));
    vi.resetModules();
    route = await import("../app/api/live/token/route");
  });

  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  const post = (body: BodyInit | null) => route.POST(new Request("http://local/api/live/token", { method: "POST", body, headers: { "content-type": "application/json" } }));
  const json = (r: Response) => r.json() as Promise<{ error?: string }>;

  it("400 without a JSON body or without runId", async () => {
    expect((await post("not json")).status).toBe(400);
    expect((await post(JSON.stringify({}))).status).toBe(400);
    expect((await post(JSON.stringify({ runId: "" }))).status).toBe(400);
    expect((await json(await post(JSON.stringify({ runId: 7 })))).error).toMatch(/runId/);
  });

  it("404 for an unknown or malformed run id", async () => {
    expect((await post(JSON.stringify({ runId: "0123456789" }))).status).toBe(404);
    expect((await post(JSON.stringify({ runId: "../../etc" }))).status).toBe(404);
  });

  it("503 for a known run when no key is configured, without touching the network", async () => {
    const r = await post(JSON.stringify({ runId: run.id }));
    expect(r.status).toBe(503);
    expect((await json(r)).error).toMatch(/GEMINI_API_KEY/);
  });
});

// Pre-existing end-to-end check against the real API; runs only when a key is exported in the shell.
const hasKey = Boolean(process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY_1);

describe.skipIf(!hasKey)("live Gemini", () => {
  it("transcribes and drafts footage/a.mp4", { timeout: 300_000 }, async () => {
    const file = path.resolve("footage/a.mp4");
    const input = { clip: { id: "a", path: file, duration: 8, transcript: [] as { text: string; start: number; end: number }[] }, file };
    const editor = createGeminiEditor();
    const words = await editor.transcribe(input);
    expect(Array.isArray(words)).toBe(true);
    input.clip.transcript = words;
    const edl = await editor.draft("10s recap", [input]);
    expect(edl.cuts.length).toBeGreaterThan(0);
    expect(edl.cuts[0].id).toBe("c1");
    expect(edl.cuts.every((c) => c.clipId === "a" && c.srcOut > c.srcIn)).toBe(true);
  });
});
