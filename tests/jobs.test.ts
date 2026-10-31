import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { ClipInput, EditorModel } from "../lib/gemini";
import type { Critique, EDL, Run, RunStatus } from "../lib/schema";
import { makeFixtureClip } from "./fixtures";

// The deterministic linter is another module's concern; keep it quiet so every cut passes first time.
vi.mock("../lib/lint", () => ({ lintEdl: () => ({ checks: [], patches: [] }) }));

let tmp: string;
let store: typeof import("../lib/store");
let jobs: typeof import("../lib/jobs");
let counter = 0;

beforeAll(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "jobs-test-"));
  process.env.RUNS_DIR = tmp;
  vi.resetModules();
  const config = await import("../lib/config");
  expect(config.RUNS_DIR).toBe(path.resolve(tmp));
  store = await import("../lib/store");
  jobs = await import("../lib/jobs");
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const STALE = 5 * 60_000;
const onDisk = (id: string) => JSON.parse(readFileSync(path.join(tmp, id, "run.json"), "utf8")) as Run;

/** A run on disk with two real clips; clip1 already has a transcript. run.json's mtime is `ageMs` ago. */
async function writeRun(status: RunStatus, ageMs: number, over: Partial<Run> = {}): Promise<Run> {
  const id = (counter++).toString(16).padStart(10, "b");
  const src = path.join(tmp, id, "src");
  mkdirSync(src, { recursive: true });
  await makeFixtureClip(src, "clip1.mp4", { seconds: 2 });
  await makeFixtureClip(src, "clip2.mp4", { seconds: 2 });
  const run: Run = {
    id, brief: "test brief", createdAt: new Date().toISOString(),
    clips: [
      { id: "clip1", path: "src/clip1.mp4", duration: 0, transcript: [{ text: "kept", start: 0, end: 0.5 }] },
      { id: "clip2", path: "src/clip2.mp4", duration: 0, transcript: [] },
    ],
    iterations: [], status, error: "", warnings: [],
    ...over,
  };
  const file = path.join(tmp, id, "run.json");
  writeFileSync(file, JSON.stringify(run));
  const t = (Date.now() - ageMs) / 1000;
  utimesSync(file, t, t);
  return run;
}

const draftEdl = (): EDL => ({
  title: "", width: 1280, height: 720, fps: 30, captions: [], overlays: [],
  cuts: [
    { id: "c1", clipId: "clip1", srcIn: 0, srcOut: 1.5, reason: "" },
    { id: "c2", clipId: "clip2", srcIn: 0.2, srcOut: 1.8, reason: "" },
  ],
});
const pass: Critique = { checks: [{ name: "ok", passed: true, note: "" }], patches: [], summary: "" };

/** Hand-written editor double that records which clips it was asked to transcribe. */
function editor(over: Partial<EditorModel> = {}) {
  const transcribed: string[] = [];
  const model: EditorModel = {
    transcribe: async ({ clip }: ClipInput) => {
      transcribed.push(clip.id);
      return [{ text: "fresh", start: 0, end: 0.4 }];
    },
    draft: async () => draftEdl(),
    critique: async () => pass,
    ...over,
  };
  return { model, transcribed };
}

/** Resolve once the loop has released the run and its terminal status is on disk. */
async function waitForIdle(id: string, timeoutMs = 90_000): Promise<Run> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (!jobs.isRunning(id)) {
      const run = onDisk(id);
      if (run.status === "done" || run.status === "error") return run;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`run ${id} did not finish within ${timeoutMs}ms`);
}

describe("withCachedTranscripts", () => {
  it("skips transcribe for clips that already have words and delegates the rest", async () => {
    const { model, transcribed } = editor();
    const wrapped = jobs.withCachedTranscripts(model);
    const withWords: ClipInput = { clip: { id: "a", path: "x", duration: 1, transcript: [{ text: "w", start: 0, end: 1 }] }, file: "x" };
    const without: ClipInput = { clip: { id: "b", path: "y", duration: 1, transcript: [] }, file: "y" };
    expect(await wrapped.transcribe(withWords)).toEqual(withWords.clip.transcript);
    expect(await wrapped.transcribe(without)).toEqual([{ text: "fresh", start: 0, end: 0.4 }]);
    expect(transcribed).toEqual(["b"]);
    expect((await wrapped.draft("b", [])).cuts).toHaveLength(2);
    expect(await wrapped.critique("b", draftEdl(), "r.mp4", [])).toBe(pass);
  });
});

describe("resume after restart", { timeout: 120_000 }, () => {
  it("re-queues a stale in-progress run, reuses transcripts, and finishes the cut", async () => {
    const stale = await writeRun("rendering", STALE, {
      iterations: [{ n: 1, edl: draftEdl(), video: "iter1.mp4", critique: null }],
      error: "",
      warnings: ["earlier warning"],
      timings: [{ stage: "prepare", ms: 1 }],
    });
    const { model, transcribed } = editor();

    const resumed = await jobs.resumeInterruptedRuns(model);
    expect(resumed.map((r) => r.id)).toEqual([stale.id]);
    const run = resumed[0];
    // Marked active and re-queued synchronously: the sweep cannot touch it from here on.
    expect(jobs.isRunning(run.id)).toBe(true);
    expect(run.status).toBe("queued");
    expect(run.error).toBe("");
    expect(run.iterations).toEqual([]);
    expect(run.warnings).toEqual(["earlier warning", jobs.RESUMED_WARNING]);
    expect(run.clips[0].transcript).toEqual([{ text: "kept", start: 0, end: 0.5 }]);
    const seen = await store.loadRun(run.id);
    expect(seen?.status).not.toBe("error");

    const out = await waitForIdle(run.id);
    expect(out.status).toBe("done");
    expect(out.error).toBe("");
    expect(out.iterations).toHaveLength(1);
    expect(out.warnings).toContain(jobs.RESUMED_WARNING);
    expect(existsSync(path.join(tmp, run.id, "iter1.mp4"))).toBe(true);
    // clip1's words were reused; only clip2 went to the model.
    expect(transcribed).toEqual(["clip2"]);
    expect(out.clips[0].transcript).toEqual([{ text: "kept", start: 0, end: 0.5 }]);
    expect(out.clips[1].transcript).toEqual([{ text: "fresh", start: 0, end: 0.4 }]);
    expect(jobs.isRunning(run.id)).toBe(false);
  });

  it("leaves finished and active runs alone", async () => {
    const done = await writeRun("done", STALE);
    const failed = await writeRun("error", STALE, { error: "boom" });
    const busy = await writeRun("drafting", STALE);
    store.markActive(busy.id);
    try {
      const resumed = await jobs.resumeInterruptedRuns(editor().model);
      expect(resumed.map((r) => r.id)).not.toContain(done.id);
      expect(resumed.map((r) => r.id)).not.toContain(failed.id);
      expect(resumed.map((r) => r.id)).not.toContain(busy.id);
      expect(onDisk(done.id).status).toBe("done");
      expect(onDisk(failed.id).error).toBe("boom");
      await Promise.all(resumed.map((r) => waitForIdle(r.id)));
    } finally {
      store.markInactive(busy.id);
    }
  });

  it("the orphan sweep leaves a resuming run alone while its loop is still working", async () => {
    const stale = await writeRun("critiquing", STALE);
    let finishDraft!: () => void;
    const gate = new Promise<void>((r) => (finishDraft = r));
    const { model } = editor({
      draft: async () => {
        await gate;
        return draftEdl();
      },
    });
    jobs.resumeRun(stale, model);
    expect(jobs.isRunning(stale.id)).toBe(true);
    // Give the loop a moment to write "drafting", then read through the sweeping path repeatedly.
    await new Promise((r) => setTimeout(r, 200));
    for (let i = 0; i < 3; i++) {
      const seen = await store.loadRun(stale.id);
      expect(seen?.status).not.toBe("error");
      expect(["queued", "drafting"]).toContain(seen?.status);
    }
    expect((await store.listRuns()).find((r) => r.id === stale.id)?.status).not.toBe("error");
    finishDraft();
    const out = await waitForIdle(stale.id);
    expect(out.status).toBe("done");
  });

  it("resumeRun is a no-op for an already active run", async () => {
    const run = await writeRun("drafting", 0);
    store.markActive(run.id);
    try {
      jobs.resumeRun(run, editor().model);
      expect(run.status).toBe("drafting");
      expect(run.warnings).toEqual([]);
    } finally {
      store.markInactive(run.id);
    }
  });
});

describe("retry", { timeout: 120_000 }, () => {
  it("resets a failed run, keeps warnings, adds 'Started again', and cuts it again", async () => {
    const failed = await writeRun("error", 0, {
      error: store.INTERRUPTED_ERROR,
      iterations: [{ n: 1, edl: draftEdl(), video: "iter1.mp4", critique: null }],
      warnings: ["old warning"],
    });
    const { model, transcribed } = editor();
    jobs.retryRun(failed, model);
    expect(jobs.isRunning(failed.id)).toBe(true);
    expect(failed.status).toBe("queued");
    expect(failed.error).toBe("");
    expect(failed.iterations).toEqual([]);
    expect(failed.warnings).toEqual(["old warning", jobs.RETRIED_WARNING]);

    const out = await waitForIdle(failed.id);
    expect(out.status).toBe("done");
    expect(out.iterations).toHaveLength(1);
    expect(out.warnings).toEqual(["old warning", jobs.RETRIED_WARNING]);
    expect(transcribed).toEqual(["clip2"]);
  });

  it("a second retry while the first is active is ignored", async () => {
    const done = await writeRun("done", 0);
    let finishDraft!: () => void;
    const gate = new Promise<void>((r) => (finishDraft = r));
    const { model } = editor({
      draft: async () => {
        await gate;
        return draftEdl();
      },
    });
    jobs.retryRun(done, model);
    jobs.retryRun(done, model);
    expect(done.warnings).toEqual([jobs.RETRIED_WARNING]);
    finishDraft();
    expect((await waitForIdle(done.id)).status).toBe("done");
  });
});

describe("startRun", { timeout: 120_000 }, () => {
  it("records a failing editor on the run instead of throwing", async () => {
    const run = await writeRun("queued", 0, { clips: [] });
    jobs.startRun(run, editor({ draft: async () => { throw new Error("argon down"); } }).model);
    const out = await waitForIdle(run.id);
    expect(out.status).toBe("error");
    expect(out.error).toContain("argon down");
  });
});
