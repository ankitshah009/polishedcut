import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { ClipInput, EditorModel } from "../lib/gemini";
import type { Critique, EDL, Run } from "../lib/schema";
import { makeFixtureClip } from "./fixtures";

let tmp: string;
let revise: typeof import("../lib/revise");
let renderEdl: typeof import("../lib/render").renderEdl;
let counter = 0;

const NOTE = "make it shorter, open on clip2";

const savedProvider = process.env.MODEL_PROVIDER;

beforeAll(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "revise-test-"));
  process.env.RUNS_DIR = tmp;
  // Pin the Gemini provider: the "missing API key" test below needs a provider that requires a key
  // (unset, a keyless environment selects the local editor and the revision would simply succeed).
  process.env.MODEL_PROVIDER = "gemini";
  vi.resetModules();
  const config = await import("../lib/config");
  expect(config.RUNS_DIR).toBe(path.resolve(tmp));
  revise = await import("../lib/revise");
  ({ renderEdl } = await import("../lib/render"));
});

afterAll(() => {
  if (savedProvider === undefined) delete process.env.MODEL_PROVIDER;
  else process.env.MODEL_PROVIDER = savedProvider;
  rmSync(tmp, { recursive: true, force: true });
});

const baseEdl = (): EDL => ({
  title: "", width: 1280, height: 720, fps: 30, captions: [], overlays: [],
  cuts: [
    { id: "c1", clipId: "clip1", srcIn: 0, srcOut: 1.5, reason: "" },
    { id: "c2", clipId: "clip2", srcIn: 0.2, srcOut: 1.8, reason: "" },
  ],
});

const pass: Critique = { checks: [{ name: "ok", passed: true, note: "" }], patches: [], summary: "" };
const fail = (patches: Critique["patches"]): Critique => ({
  checks: [{ name: "brief: note", passed: false, at: 1, note: "note not applied" }], patches, summary: "",
});

/** A run that Argon's loop already finished: real clips, a real iter1.mp4, no proxies, durations unprobed. */
async function finishedRun(status: Run["status"] = "done", iterations = 1): Promise<Run> {
  const id = (counter++).toString(16).padStart(10, "b");
  const src = path.join(tmp, id, "src");
  mkdirSync(src, { recursive: true });
  await makeFixtureClip(src, "clip1.mp4", { seconds: 2 });
  await makeFixtureClip(src, "clip2.mp4", { seconds: 2 });
  const edl = baseEdl();
  if (iterations > 0) {
    await renderEdl(edl, { clip1: path.join(src, "clip1.mp4"), clip2: path.join(src, "clip2.mp4") }, path.join(tmp, id, "iter1.mp4"));
  }
  return {
    id, brief: "test brief", createdAt: new Date().toISOString(),
    clips: [
      { id: "clip1", path: "src/clip1.mp4", duration: 0, transcript: [] },
      { id: "clip2", path: "src/clip2.mp4", duration: 0, transcript: [] },
    ],
    iterations: iterations > 0 ? [{ n: 1, edl, video: "iter1.mp4", critique: pass }] : [],
    status, error: "", warnings: [],
  };
}

type Call = { brief: string; edl: EDL; file: string; clips: ClipInput[] };

/** EditorModel double: critique replays `critiques` in order (last one repeats) and records every call. */
function editor(critiques: Critique[]): { model: EditorModel; calls: Call[] } {
  const calls: Call[] = [];
  const model: EditorModel = {
    transcribe: async () => { throw new Error("revise must not transcribe"); },
    draft: async () => { throw new Error("revise must not redraft"); },
    critique: async (brief, edl, file, clips) => {
      calls.push({ brief, edl, file, clips });
      return critiques[Math.min(calls.length - 1, critiques.length - 1)];
    },
  };
  return { model, calls };
}

describe("reviseRun", { timeout: 120_000 }, () => {
  it("applies the note to the last cut: one new iteration carrying the note, status done", async () => {
    const run = await finishedRun();
    const statuses: string[] = [];
    const { model, calls } = editor([fail([{ op: "trim", cutId: "c1", srcIn: 0.2, srcOut: 1.0 }]), pass]);

    const out = await revise.reviseRun(run, NOTE, model, { onUpdate: (r) => statuses.push(r.status) });

    expect(out.error).toBe("");
    expect(out.status).toBe("done");
    expect(out.iterations).toHaveLength(2);
    expect(out.iterations[0]).toMatchObject({ n: 1, critique: pass });
    expect(out.iterations[0].note).toBeUndefined();
    const it2 = out.iterations[1];
    expect(it2).toMatchObject({ n: 2, video: "iter2.mp4", note: NOTE });
    // Argon's checks come first, then the four deterministic "auto:" checks, exactly as in the main loop.
    expect(it2.critique?.checks[0]).toEqual(pass.checks[0]);
    expect(it2.critique?.checks.slice(1).map((c) => c.name)).toEqual([
      "auto: no mid-word cuts",
      "auto: captions match speech",
      "auto: duration matches brief",
      "auto: cuts inside clip bounds",
    ]);
    expect(it2.critique?.checks.every((c) => c.passed)).toBe(true);
    expect(it2.critique?.patches).toEqual([]);
    expect(existsSync(path.join(tmp, run.id, "iter2.mp4"))).toBe(true);
    const c1 = it2.edl.cuts.find((c) => c.id === "c1")!;
    expect(c1.srcIn).toBeCloseTo(0.2);
    expect(c1.srcOut).toBeCloseTo(1.0);

    // Pass 1 critiques the LAST rendered cut against brief + note; pass 2 critiques the new render.
    expect(calls).toHaveLength(2);
    expect(calls[0].brief.startsWith("test brief")).toBe(true);
    expect(calls[0].brief).toContain(`DIRECTOR'S NOTE (must be satisfied, overrides earlier choices): ${NOTE}`);
    expect(calls[0].brief).not.toContain("Return at least one patch");
    expect(calls[0].file).toBe(path.join(tmp, run.id, "iter1.mp4"));
    expect(calls[0].edl).toEqual(baseEdl());
    expect(calls[1].file).toBe(path.join(tmp, run.id, "iter2.mp4"));
    // Proxies and durations are produced on demand when the original loop's are not available.
    expect(calls[0].clips.every((c) => existsSync(c.file))).toBe(true);
    expect(out.clips[0].duration).toBeGreaterThan(1.5);

    expect(statuses[0]).toBe("critiquing");
    expect(statuses).toContain("rendering");
    expect(statuses.at(-1)).toBe("done");
  });

  it("insists once when the first critique returns no patches, then revises", async () => {
    const run = await finishedRun();
    const { model, calls } = editor([pass, fail([{ op: "remove_cut", cutId: "c1" }]), pass]);

    const out = await revise.reviseRun(run, NOTE, model);

    expect(out.status).toBe("done");
    expect(out.iterations).toHaveLength(2);
    expect(out.iterations[1].edl.cuts.map((c) => c.id)).toEqual(["c2"]);
    expect(calls).toHaveLength(3);
    expect(calls[1].brief).toContain("Return at least one patch that applies this note.");
    expect(out.warnings).not.toContain(revise.NOTHING_TO_CHANGE);
  });

  it("finishes with a warning and no new iteration when the note changes nothing", async () => {
    const run = await finishedRun();
    const { model, calls } = editor([pass]);

    const out = await revise.reviseRun(run, NOTE, model);

    expect(out.status).toBe("done");
    expect(out.error).toBe("");
    expect(out.iterations).toHaveLength(1);
    expect(out.warnings).toContain(revise.NOTHING_TO_CHANGE);
    expect(calls).toHaveLength(2);
    expect(existsSync(path.join(tmp, run.id, "iter2.mp4"))).toBe(false);
  });

  it("continues numbering and stops after maxIterations extra rounds", async () => {
    const run = await finishedRun();
    const { model, calls } = editor([fail([{ op: "trim", cutId: "c1", srcOut: 1.2 }])]); // never satisfied

    const out = await revise.reviseRun(run, NOTE, model, { maxIterations: 2 });

    expect(out.status).toBe("done");
    expect(out.iterations.map((i) => i.n)).toEqual([1, 2, 3]);
    expect(out.iterations.slice(1).every((i) => i.note === NOTE)).toBe(true);
    expect(calls).toHaveLength(3); // note pass + one critique per new render
  });

  it("accepts an errored run and records a failed render as an error", async () => {
    const run = await finishedRun("error");
    run.error = "earlier failure";
    const { model } = editor([fail([{ op: "remove_cut", cutId: "c1" }, { op: "remove_cut", cutId: "c2" }])]);

    const out = await revise.reviseRun(run, NOTE, model);

    expect(out.status).toBe("error");
    expect(out.error).toContain("no cuts");
    expect(out.iterations).toHaveLength(1);
  });

  it("rejects runs that are in progress or have no cut, without touching them", async () => {
    const busy = await finishedRun("rendering");
    const before = structuredClone(busy);
    await expect(revise.reviseRun(busy, NOTE, editor([pass]).model)).rejects.toThrow(/status rendering/);
    expect(busy).toEqual(before);

    const empty = await finishedRun("done", 0);
    await expect(revise.reviseRun(empty, NOTE, editor([pass]).model)).rejects.toThrow(/no iterations/);
    expect(empty.status).toBe("done");
  });
});

describe("revision guard (409 logic)", () => {
  it("reviseBlocker names why a run cannot take a note", async () => {
    const ok = await finishedRun();
    expect(revise.reviseBlocker(ok)).toBeNull();
    expect(revise.reviseBlocker({ ...ok, status: "error" })).toBeNull();
    expect(revise.reviseBlocker({ ...ok, status: "critiquing" })).toMatch(/in progress/);
    expect(revise.reviseBlocker({ ...ok, iterations: [] })).toMatch(/no cut/);

    const g = globalThis as typeof globalThis & { __editorRevising?: Set<string> };
    g.__editorRevising!.add(ok.id);
    try {
      expect(revise.isRevising(ok.id)).toBe(true);
      expect(revise.reviseBlocker(ok)).toMatch(/revision is already in progress/);
    } finally {
      g.__editorRevising!.delete(ok.id);
    }
    expect(revise.isRevising(ok.id)).toBe(false);
  });

  it("drops Argon captions that leak model notes, like the main loop does", async () => {
    const run = await finishedRun();
    const leaked = { op: "set_caption" as const, index: 0, text: "price -> wait, exact transcript: two ninety nine" };
    const { model } = editor([fail([{ op: "add_caption", text: "ok", start: 0.2, end: 1.0 }, leaked]), pass]);

    const out = await revise.reviseRun(run, NOTE, model);

    expect(out.status).toBe("done");
    expect(out.iterations).toHaveLength(2);
    expect(out.iterations[1].edl.captions.map((c) => c.text)).toEqual(["ok"]);
    expect(out.warnings.some((w) => /dropped set_caption/.test(w))).toBe(true);
  });

  it("completes untimed and mis-indexed captions from the transcript, like the main loop does", async () => {
    const run = await finishedRun();
    run.clips[0].transcript = [{ text: "Hello", start: 0.1, end: 0.4 }, { text: "there,", start: 0.5, end: 0.8 }, { text: "friend.", start: 0.9, end: 1.2 }];
    const { model } = editor([
      fail([
        { op: "add_caption", text: "hello there friend" }, // no start/end
        { op: "set_caption", index: 7, text: "Hello there, friend." }, // the f138d3f5a7 case: no such caption
      ]),
      pass,
    ]);

    const out = await revise.reviseRun(run, NOTE, model);

    expect(out.status).toBe("done");
    expect(out.iterations).toHaveLength(2);
    const captions = out.iterations[1].edl.captions;
    expect(captions).toHaveLength(1);
    expect(captions[0].text).toBe("hello there friend");
    expect(captions[0].start).toBeCloseTo(0.1, 3);
    expect(out.warnings.filter((w) => w.includes("skipped"))).toEqual([]);
    expect(out.warnings.some((w) => /^v1 note: Placed Argon's caption 'hello there friend' at 0\.1–1\.[34]s from the transcript$/.test(w))).toBe(true);
    expect(out.warnings.some((w) => w.startsWith("v1 note: set_caption named caption 8, but the cut has 1 caption;"))).toBe(true);
    expect(out.warnings.some((w) => w.startsWith("v1 note: dropped duplicate caption"))).toBe(true);
  });

  it("applies a set_end_title note, paints the closing card once and renders with it", async () => {
    const run = await finishedRun();
    const generateEndCard = vi.fn(async (_t: string, _b: string, outFile: string) => {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      await promisify(execFile)("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=maroon:s=1280x720", "-frames:v", "1", outFile]);
      return outFile;
    });
    const { model } = editor([fail([{ op: "set_end_title", text: "Thanks" }]), fail([{ op: "trim", cutId: "c1", srcOut: 1.0 }]), pass]);

    const out = await revise.reviseRun(run, NOTE, model, { generateEndCard });

    expect(out.status).toBe("done");
    expect(out.error).toBe("");
    expect(out.iterations).toHaveLength(3);
    expect(generateEndCard).toHaveBeenCalledTimes(1);
    expect(generateEndCard).toHaveBeenCalledWith("Thanks", "test brief", path.join(tmp, run.id, "end.png"));
    expect(existsSync(path.join(tmp, run.id, "end.png"))).toBe(true);
    for (const it of out.iterations.slice(1)) expect(it.edl).toMatchObject({ endTitle: "Thanks", endImage: "end.png" });
    expect(out.warnings.filter((w) => w.includes("skipped") || w.startsWith("art unavailable"))).toEqual([]);
  });

  it("startRevision records a missing API key on the run, saves it and releases the guard", async () => {
    const saved = { key: process.env.GEMINI_API_KEY, key1: process.env.GEMINI_API_KEY_1 };
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY_1;
    try {
      const run = await finishedRun();
      const store = await import("../lib/store");
      revise.startRevision(run, NOTE);
      // While the revision is in flight the run counts as active, so the orphan sweep leaves it alone.
      expect(store.isRunning(run.id)).toBe(true);
      await vi.waitFor(async () => {
        expect(revise.isRevising(run.id)).toBe(false);
        expect(store.isRunning(run.id)).toBe(false);
        const onDisk = JSON.parse(await readFile(path.join(tmp, run.id, "run.json"), "utf8")) as Run;
        expect(onDisk.status).toBe("error");
        expect(onDisk.error).toContain("GEMINI_API_KEY");
      });
      expect(run.iterations).toHaveLength(1);
    } finally {
      if (saved.key !== undefined) process.env.GEMINI_API_KEY = saved.key;
      if (saved.key1 !== undefined) process.env.GEMINI_API_KEY_1 = saved.key1;
    }
  });
});
