import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { BriefAnalysis } from "../lib/brief";
import type { EditorModel } from "../lib/gemini";
import type { LoopOptions } from "../lib/loop";
import type { Check, Critique, EDL, PatchOp, Run } from "../lib/schema";
import { makeFixtureClip } from "./fixtures";

const execFileAsync = promisify(execFile);

// The deterministic linter is another module's concern; here it is a controllable stub.
const lintEdl = vi.fn((): { checks: Check[]; patches: PatchOp[] } => ({ checks: [], patches: [] }));
vi.mock("../lib/lint", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/lint")>()),
  lintEdl: (...args: unknown[]) => lintEdl(...(args as [])),
}));

let tmp: string;
let runEdit: typeof import("../lib/loop").runEdit;
let mapLimit: typeof import("../lib/loop").mapLimit;
let counter = 0;

beforeAll(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "loop-test-"));
  process.env.RUNS_DIR = tmp;
  vi.resetModules();
  const config = await import("../lib/config");
  expect(config.RUNS_DIR).toBe(path.resolve(tmp));
  ({ runEdit, mapLimit } = await import("../lib/loop"));
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  lintEdl.mockReset();
  lintEdl.mockReturnValue({ checks: [], patches: [] });
});

async function makeRun(): Promise<Run> {
  const id = (counter++).toString(16).padStart(10, "a");
  const src = path.join(tmp, id, "src");
  mkdirSync(src, { recursive: true });
  await makeFixtureClip(src, "clip1.mp4", { seconds: 2 });
  await makeFixtureClip(src, "clip2.mp4", { seconds: 2 });
  return {
    id, brief: "test brief", createdAt: new Date().toISOString(),
    clips: [
      { id: "clip1", path: "src/clip1.mp4", duration: 0, transcript: [] },
      { id: "clip2", path: "src/clip2.mp4", duration: 0, transcript: [] },
    ],
    iterations: [], status: "queued", error: "", warnings: [],
  };
}

const draftEdl = (): EDL => ({
  title: "", width: 1280, height: 720, fps: 30, captions: [], overlays: [],
  cuts: [
    { id: "c1", clipId: "clip1", srcIn: 0, srcOut: 1.5, reason: "" },
    { id: "c2", clipId: "clip2", srcIn: 0.2, srcOut: 1.8, reason: "" },
  ],
});

const pass: Critique = { checks: [{ name: "ok", passed: true, note: "" }], patches: [], summary: "" };
const fail = (patches: Critique["patches"]): Critique => ({
  checks: [{ name: "pacing", passed: false, at: 1, note: "too long" }], patches, summary: "",
});

function editor(over: Partial<EditorModel> = {}, critiques: Critique[] = [pass]): EditorModel {
  let i = 0;
  return {
    transcribe: async () => [{ text: "hi", start: 0, end: 0.5 }],
    draft: async () => draftEdl(),
    critique: async () => critiques[Math.min(i++, critiques.length - 1)],
    ...over,
  };
}

// Companion generators: no network. The music fake writes a real mp3 so the renderer can mix it.
const fakes = {
  analyzeBrief: vi.fn<NonNullable<LoopOptions["analyzeBrief"]>>(async () => null),
  generateTitleCard: vi.fn<NonNullable<LoopOptions["generateTitleCard"]>>(async (_t, _b, outFile) => {
    await mkdir(path.dirname(outFile), { recursive: true });
    await execFileAsync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=navy:s=1280x720", "-frames:v", "1", outFile]);
    return outFile;
  }),
  generateEndCard: vi.fn<NonNullable<LoopOptions["generateEndCard"]>>(async (_t, _b, outFile) => {
    await mkdir(path.dirname(outFile), { recursive: true });
    await execFileAsync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=maroon:s=1280x720", "-frames:v", "1", outFile]);
    return outFile;
  }),
  generateMusic: vi.fn<NonNullable<LoopOptions["generateMusic"]>>(async (_p, seconds, outFile) => {
    await mkdir(path.dirname(outFile), { recursive: true });
    await execFileAsync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-t", String(seconds), "-i", "sine=frequency=220:sample_rate=48000", outFile]);
    return { file: outFile, seconds, model: "fake-lyria" };
  }),
  generateShot: vi.fn<NonNullable<LoopOptions["generateShot"]>>(async ({ seconds, outFile }) => {
    await makeFixtureClip(path.dirname(outFile), path.basename(outFile), { seconds, audio: false });
    return { file: outFile, seconds, model: "fake-omni" };
  }),
};
const withFakes = (o: LoopOptions = {}): LoopOptions => ({ ...fakes, ...o });

beforeEach(() => {
  fakes.analyzeBrief.mockClear();
  fakes.analyzeBrief.mockImplementation(async () => null);
  fakes.generateTitleCard.mockClear();
  fakes.generateEndCard.mockClear();
  fakes.generateMusic.mockClear();
  fakes.generateShot.mockClear();
});

const analysis: BriefAnalysis = { targetSeconds: 20, tone: "upbeat", wantsCaptions: true, wantsMusic: true, musicMood: "bright synth" };

describe("runEdit", { timeout: 120_000 }, () => {
  it("draft -> failing critique with trim -> pass, with per-stage timings", async () => {
    const run = await makeRun();
    const statuses: string[] = [];
    const ed = editor({}, [fail([{ op: "trim", cutId: "c1", srcIn: 0.2, srcOut: 1.0 }]), pass]);
    const out = await runEdit(run, ed, withFakes({ maxIterations: 3, onUpdate: (r) => statuses.push(r.status) }));
    expect(out.error).toBe("");
    expect(out.status).toBe("done");
    expect(out.iterations).toHaveLength(2);
    expect(existsSync(path.join(tmp, run.id, "iter2.mp4"))).toBe(true);
    expect(existsSync(path.join(tmp, run.id, "proxies", "clip1.mp4"))).toBe(true);
    expect(existsSync(path.join(tmp, run.id, "thumbs", "clip2.jpg"))).toBe(true);
    expect(statuses).toContain("rendering");
    expect(statuses).toContain("critiquing");
    expect(out.clips[0].duration).toBeGreaterThan(1.5);
    expect(out.clips[0].transcript).toHaveLength(1);
    const c1 = out.iterations[1].edl.cuts.find((c) => c.id === "c1")!;
    expect(c1.srcIn).toBeCloseTo(0.2);
    expect(c1.srcOut).toBeCloseTo(1.0);

    const stages = (out.timings ?? []).map((t) => t.stage);
    expect(stages).toEqual(["prepare", "transcribe", "analyze", "draft", "render1", "critique1", "render2", "critique2"]);
    for (const t of out.timings ?? []) expect(t.ms).toBeGreaterThanOrEqual(0);
    // Every stage emitted an update after it was recorded.
    expect(statuses.length).toBeGreaterThanOrEqual(stages.length);
    // No title, no music prompt: the companion generators stay idle.
    expect(fakes.generateTitleCard).not.toHaveBeenCalled();
    expect(fakes.generateEndCard).not.toHaveBeenCalled();
    expect(fakes.generateMusic).not.toHaveBeenCalled();
  });

  it("completes Argon's untimed and mis-indexed captions from the transcript before applying them", async () => {
    const run = await makeRun();
    const transcribe: EditorModel["transcribe"] = async ({ clip }) =>
      clip.id === "clip1"
        ? [{ text: "Hello", start: 0.1, end: 0.4 }, { text: "there,", start: 0.5, end: 0.8 }, { text: "friend.", start: 0.9, end: 1.2 }]
        : [];
    const ed = editor({ transcribe }, [
      fail([
        { op: "add_caption", text: "hello there friend" }, // no start/end: the f138d3f5a7 bug
        { op: "set_caption", index: 7, text: "Hello there, friend." }, // out of range: becomes an add, then a duplicate
        { op: "add_caption", text: "not in the footage" },
      ]),
      pass,
    ]);
    const out = await runEdit(run, ed, withFakes({ maxIterations: 3 }));
    expect(out.status).toBe("done");
    expect(out.iterations).toHaveLength(2);
    const captions = out.iterations[1].edl.captions;
    expect(captions).toHaveLength(1);
    expect(captions[0].text).toBe("hello there friend");
    expect(captions[0].start).toBeCloseTo(0.1, 3);
    expect(captions[0].end).toBeCloseTo(1.35, 3);
    expect(out.warnings.filter((w) => w.includes("skipped"))).toEqual([]);
    expect(out.warnings.some((w) => /^v1: Placed Argon's caption 'hello there friend' at 0\.1–1\.[34]s from the transcript$/.test(w))).toBe(true);
    expect(out.warnings.some((w) => w.startsWith("v1: set_caption named caption 8, but the cut has 1 caption;"))).toBe(true);
    expect(out.warnings.some((w) => w.startsWith("v1: dropped duplicate caption 'Hello there, friend.'"))).toBe(true);
    expect(out.warnings).toContain("v1: could not place caption 'not in the footage' — no matching speech in the cuts");
  });

  it("paints the closing card once in the art stage and hands it to the renderer", async () => {
    const run = await makeRun();
    const ed = editor(
      { draft: async () => ({ ...draftEdl(), endTitle: "Thanks for watching" }) },
      [fail([{ op: "trim", cutId: "c1", srcOut: 1.0 }]), pass],
    );
    const out = await runEdit(run, ed, withFakes({ maxIterations: 3 }));
    expect(out.status).toBe("done");
    expect(out.error).toBe("");
    expect(out.iterations).toHaveLength(2);
    expect(fakes.generateTitleCard).not.toHaveBeenCalled();
    expect(fakes.generateEndCard).toHaveBeenCalledTimes(1);
    expect(fakes.generateEndCard).toHaveBeenCalledWith("Thanks for watching", "test brief", path.join(tmp, run.id, "end.png"));
    expect(existsSync(path.join(tmp, run.id, "end.png"))).toBe(true);
    for (const it of out.iterations) expect(it.edl.endImage).toBe("end.png");
    const stages = (out.timings ?? []).map((t) => t.stage);
    expect(stages).toEqual(["prepare", "transcribe", "analyze", "draft", "art", "render1", "critique1", "render2", "critique2"]);
  });

  it("applies set_end_title, overlay and audio patches, repainting the card when the line changes", async () => {
    const run = await makeRun();
    fakes.generateEndCard.mockImplementationOnce(async () => null); // first attempt fails: warning, no image
    const ed = editor({}, [
      fail([
        { op: "set_end_title", text: "The End" } as PatchOp,
        { op: "add_overlay", text: "Day one", start: 0.2, end: 1.0 } as PatchOp,
        { op: "set_audio", denoise: true, gainDb: -12 } as PatchOp,
      ]),
      fail([{ op: "set_end_title", text: "Fin" } as PatchOp]),
      pass,
    ]);
    const out = await runEdit(run, ed, withFakes({ maxIterations: 4 }));
    expect(out.status).toBe("done");
    expect(out.error).toBe("");
    expect(out.iterations).toHaveLength(3);
    expect(out.warnings.filter((w) => w.includes("skipped"))).toEqual([]);
    const v2 = out.iterations[1].edl;
    expect(v2.endTitle).toBe("The End");
    expect(v2.endImage).toBeUndefined();
    expect(v2.overlays).toEqual([{ text: "Day one", start: 0.2, end: 1.0, position: "lower-third" }]);
    expect(v2.audio).toEqual({ denoise: true, musicGainDb: -12 });
    expect(out.warnings).toContain("art unavailable: no closing card image was produced");
    const v3 = out.iterations[2].edl;
    expect(v3.endTitle).toBe("Fin");
    expect(v3.endImage).toBe("end.png");
    expect(fakes.generateEndCard.mock.calls.map((c) => c[0])).toEqual(["The End", "Fin"]);
    expect(existsSync(path.join(tmp, run.id, "iter3.mp4"))).toBe(true);
  });

  it("appends the brief analysis to the draft brief, seeds music from it, and generates art + music once", async () => {
    const run = await makeRun();
    fakes.analyzeBrief.mockImplementation(async () => analysis);
    const briefs: string[] = [];
    const ed = editor(
      { draft: async (brief) => { briefs.push(brief); return { ...draftEdl(), title: "Demo Day" }; } },
      [fail([{ op: "trim", cutId: "c1", srcOut: 1.0 }]), pass],
    );
    const out = await runEdit(run, ed, withFakes({ maxIterations: 3 }));
    expect(out.status).toBe("done");
    expect(out.iterations).toHaveLength(2);
    expect(fakes.analyzeBrief).toHaveBeenCalledWith("test brief");
    expect(briefs).toEqual(["test brief\n\nBrief analysis: target 20s; tone: upbeat; music mood: bright synth"]);
    // Critique and lint still see the raw brief.
    expect((lintEdl.mock.calls[0] as unknown as [EDL, unknown, string])[2]).toBe("test brief");

    const stages = (out.timings ?? []).map((t) => t.stage);
    expect(stages).toEqual(["prepare", "transcribe", "analyze", "draft", "art", "music", "render1", "critique1", "render2", "critique2"]);

    expect(fakes.generateTitleCard).toHaveBeenCalledTimes(1);
    expect(fakes.generateTitleCard).toHaveBeenCalledWith("Demo Day", "test brief", path.join(tmp, run.id, "title.png"));
    expect(fakes.generateMusic).toHaveBeenCalledTimes(1);
    const [prompt, seconds, file] = fakes.generateMusic.mock.calls[0];
    expect(prompt).toBe("bright synth instrumental background music");
    expect(seconds).toBe(Math.ceil(2 + 1.5 + 1.6) + 3); // title card + cuts + tail
    expect(file).toBe(path.join(tmp, run.id, "music.mp3"));
    expect(existsSync(file)).toBe(true);
    for (const it of out.iterations) {
      expect(it.edl.titleImage).toBe("title.png");
      expect(it.edl.music).toEqual({ prompt: "bright synth instrumental background music", file: "music.mp3" });
    }
  });

  it("set_music patches regenerate the bed with the new prompt and are kept out of applyPatches", async () => {
    const run = await makeRun();
    const ed = editor(
      { draft: async () => ({ ...draftEdl(), music: { prompt: "calm piano" } }) },
      [fail([{ op: "set_music", text: "driving drums" } as PatchOp, { op: "trim", cutId: "c1", srcOut: 1.0 }]), pass],
    );
    const out = await runEdit(run, ed, withFakes({ maxIterations: 3 }));
    expect(out.status).toBe("done");
    expect(out.iterations).toHaveLength(2);
    expect(out.warnings.filter((w) => w.includes("skipped"))).toEqual([]);
    expect(fakes.generateMusic.mock.calls.map((c) => c[0])).toEqual(["calm piano", "driving drums"]);
    expect(out.iterations[0].edl.music).toEqual({ prompt: "calm piano", file: "music.mp3" });
    expect(out.iterations[1].edl.music).toEqual({ prompt: "driving drums", file: "music.mp3" });
    expect(out.iterations[1].edl.cuts.find((c) => c.id === "c1")!.srcOut).toBeCloseTo(1.0);
  });

  it("companion failures are warnings: the cut still renders without art or music", async () => {
    const run = await makeRun();
    fakes.analyzeBrief.mockImplementation(async () => { throw new Error("lite down"); });
    fakes.generateTitleCard.mockImplementationOnce(async () => null);
    fakes.generateMusic.mockImplementationOnce(async () => { throw new Error("lyria down"); });
    const ed = editor({ draft: async () => ({ ...draftEdl(), title: "T", music: { prompt: "jazz" } }) });
    const out = await runEdit(run, ed, withFakes({ maxIterations: 1 }));
    expect(out.status).toBe("done");
    expect(out.iterations).toHaveLength(1);
    expect(out.warnings.some((w) => w.startsWith("analyze unavailable") && w.includes("lite down"))).toBe(true);
    expect(out.warnings.some((w) => w.startsWith("art unavailable"))).toBe(true);
    expect(out.warnings.some((w) => w.startsWith("music unavailable") && w.includes("lyria down"))).toBe(true);
    expect(out.iterations[0].edl.titleImage).toBeUndefined();
    expect(out.iterations[0].edl.music).toEqual({ prompt: "jazz" });
    expect(existsSync(path.join(tmp, run.id, "iter1.mp4"))).toBe(true);
  });

  it("merges auto checks after Argon's and applies auto patches last, re-derived after Argon's", async () => {
    const run = await makeRun();
    const autoFail: Check = { name: "auto: cut too long", passed: false, at: 2, note: "c2 runs long" };
    const autoPatch: PatchOp = { op: "trim", cutId: "c2", srcOut: 1.0 };
    lintEdl
      .mockReturnValueOnce({ checks: [autoFail], patches: [autoPatch] }) // critique of v1
      .mockReturnValueOnce({ checks: [], patches: [autoPatch] }) // re-lint after Argon's patches
      .mockReturnValueOnce({ checks: [{ name: "auto: cut too long", passed: true, note: "" }], patches: [] }); // v2
    const argonPatch: PatchOp = { op: "trim", cutId: "c1", srcOut: 1.2 };
    const ed = editor({}, [fail([argonPatch]), pass]);

    const out = await runEdit(run, ed, withFakes({ maxIterations: 3 }));
    expect(out.status).toBe("done");
    expect(out.iterations).toHaveLength(2);

    const first = out.iterations[0].critique!;
    expect(first.checks.map((c) => c.name)).toEqual(["pacing", "auto: cut too long"]);
    expect(first.patches).toEqual([argonPatch, autoPatch]);
    expect(first.summary).toBe("");

    const v2 = out.iterations[1].edl;
    expect(v2.cuts.find((c) => c.id === "c2")!.srcOut).toBeCloseTo(1.0);
    expect(v2.cuts.find((c) => c.id === "c1")!.srcOut).toBeCloseTo(1.2);
    expect(lintEdl).toHaveBeenCalledTimes(3);
    // The re-lint sees Argon's trim already applied.
    const [relintEdl] = lintEdl.mock.calls[1] as unknown as [EDL];
    expect(relintEdl.cuts.find((c) => c.id === "c1")!.srcOut).toBeCloseTo(1.2);
    const [edlArg, clipsArg, briefArg] = lintEdl.mock.calls[0] as unknown as [EDL, Record<string, unknown>, string];
    expect(edlArg.cuts).toHaveLength(2);
    expect(Object.keys(clipsArg).sort()).toEqual(["clip1", "clip2"]);
    expect(briefArg).toBe("test brief");
  });

  it("trims model notes and JSON debris out of screen text, dropping only what has no phrase left", async () => {
    const { sanitizePatches, cleanScreenText } = await import("../lib/loop");
    const good: PatchOp = { op: "set_caption", index: 1, text: "So you can find a lot of samples" };
    const leaked: PatchOp = { op: "set_caption", index: 1, text: "a lot of samples -> wait no, exact transcript: samples" };
    const debris: PatchOp = { op: "add_caption", text: 'Are you just trying to get like a team together?"?":null,"Wa' };
    const hopeless: PatchOp = { op: "add_caption", text: "Um -> wait" };
    const trim: PatchOp = { op: "trim", cutId: "c1", srcOut: 2 };
    const { patches, dropped } = sanitizePatches([leaked, debris, hopeless, good, trim]);
    expect(patches).toEqual([
      { ...leaked, text: "a lot of samples" },
      { ...debris, text: "Are you just trying to get like a team together?" },
      good,
      trim,
    ]);
    expect(dropped).toHaveLength(3);
    expect(dropped.filter((d) => d.startsWith("trimmed model notes"))).toHaveLength(2);
    expect(dropped.filter((d) => d.startsWith("dropped add_caption"))).toHaveLength(1);
    expect(cleanScreenText("Good morning everyone, and welcome to our launch event.0123456789").text).toBe(
      "Good morning everyone, and welcome to our launch event.",
    );
  });

  it("an auto failure alone keeps iterating even when Argon passes", async () => {
    const run = await makeRun();
    lintEdl
      .mockReturnValueOnce({
        checks: [{ name: "auto: too short", passed: false, note: "" }],
        patches: [{ op: "trim", cutId: "c1", srcIn: 0, srcOut: 1.9 }],
      })
      .mockReturnValueOnce({ checks: [], patches: [{ op: "trim", cutId: "c1", srcIn: 0, srcOut: 1.9 }] }) // re-lint
      .mockReturnValueOnce({ checks: [{ name: "auto: too short", passed: true, note: "" }], patches: [] });
    const out = await runEdit(run, editor({}, [pass]), withFakes({ maxIterations: 3 }));
    expect(out.status).toBe("done");
    expect(out.iterations).toHaveLength(2);
    expect(out.iterations[0].critique!.checks.some((c) => c.name.startsWith("auto: ") && !c.passed)).toBe(true);
    expect(out.iterations[1].critique!.checks.every((c) => c.passed)).toBe(true);
  });

  it("a linter that throws becomes a warning, not a failed run", async () => {
    const run = await makeRun();
    lintEdl.mockImplementation(() => {
      throw new Error("lint bug");
    });
    const out = await runEdit(run, editor(), withFakes({ maxIterations: 1 }));
    expect(out.status).toBe("done");
    expect(out.warnings.some((w) => w.includes("auto checks unavailable") && w.includes("lint bug"))).toBe(true);
    expect(out.iterations[0].critique!.checks.map((c) => c.name)).toEqual(["ok"]);
  });

  it("transcribe failure -> warning, still done", async () => {
    const run = await makeRun();
    const out = await runEdit(run, editor({ transcribe: async () => { throw new Error("no asr"); } }), withFakes({ maxIterations: 1 }));
    expect(out.status).toBe("done");
    expect(out.warnings.some((w) => w.includes("transcript unavailable") && w.includes("no asr"))).toBe(true);
  });

  it("transcribes clips in parallel; one failure does not lose the others", async () => {
    const run = await makeRun();
    let inFlight = 0;
    let peak = 0;
    const transcribe: EditorModel["transcribe"] = async ({ clip }) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 50));
      inFlight--;
      if (clip.id === "clip1") throw new Error("no asr for clip1");
      return [{ text: "word", start: 0, end: 0.4 }];
    };
    const out = await runEdit(run, editor({ transcribe }), withFakes({ maxIterations: 1 }));
    expect(out.status).toBe("done");
    expect(peak).toBe(2);
    expect(out.clips[0].transcript).toHaveLength(0);
    expect(out.clips[1].transcript).toHaveLength(1);
    expect(out.warnings.filter((w) => w.includes("transcript unavailable"))).toHaveLength(1);
  });

  it("draft failure -> error status with message", async () => {
    const run = await makeRun();
    const out = await runEdit(run, editor({ draft: async () => { throw new Error("argon down"); } }), withFakes());
    expect(out.status).toBe("error");
    expect(out.error).toContain("argon down");
    expect(out.iterations).toHaveLength(0);
    // The failed stage is still timed, so the UI can show where it died.
    expect((out.timings ?? []).map((t) => t.stage)).toEqual(["prepare", "transcribe", "analyze", "draft"]);
  });

  it("generates the shots Argon asked for and registers them as clips before rendering", async () => {
    const run = await makeRun();
    const ed = editor({
      draft: async () => ({
        ...draftEdl(),
        generated: [{ id: "g1", prompt: "amber particles on black", seconds: 3 }],
        cuts: [{ id: "c1", clipId: "g1", srcIn: 0, srcOut: 2.5, reason: "sting" }, ...draftEdl().cuts.map((c, i) => ({ ...c, id: `c${i + 2}` }))],
      }),
    });
    const out = await runEdit(run, ed, withFakes({ maxIterations: 1 }));
    expect(out.status).toBe("done");
    expect(out.error).toBe("");
    expect(fakes.generateShot).toHaveBeenCalledTimes(1);
    expect(fakes.generateShot.mock.calls[0][0]).toEqual({ prompt: "amber particles on black", seconds: 3, outFile: path.join(tmp, run.id, "generated", "g1.mp4") });
    const g1 = out.clips.find((c) => c.id === "g1")!;
    expect(g1).toMatchObject({ path: "generated/g1.mp4", transcript: [] });
    expect(g1.duration).toBeCloseTo(3, 0);
    expect(existsSync(path.join(tmp, run.id, "proxies", "g1.mp4"))).toBe(true);
    expect(existsSync(path.join(tmp, run.id, "thumbs", "g1.jpg"))).toBe(true);
    expect(existsSync(path.join(tmp, run.id, "iter1.mp4"))).toBe(true);
    expect((out.timings ?? []).map((t) => t.stage)).toEqual(["prepare", "transcribe", "analyze", "draft", "generate", "render1", "critique1"]);
    // The linter sees the generated clip like any other.
    const [, clipsArg] = lintEdl.mock.calls[0] as unknown as [EDL, Record<string, unknown>];
    expect(Object.keys(clipsArg).sort()).toEqual(["clip1", "clip2", "g1"]);
    expect(out.iterations[0].edl.cuts.map((c) => c.clipId)).toEqual(["g1", "clip1", "clip2"]);
  });

  it("a failed shot is a warning: its cuts are dropped and the rest still renders", async () => {
    const run = await makeRun();
    fakes.generateShot.mockImplementationOnce(async () => { throw new Error("omni down"); });
    const ed = editor({
      draft: async () => ({
        ...draftEdl(),
        generated: [{ id: "g1", prompt: "sting", seconds: 2 }, { id: "bad/id", prompt: "x", seconds: 2 }],
        cuts: [...draftEdl().cuts, { id: "c3", clipId: "g1", srcIn: 0, srcOut: 1.5, reason: "outro" }],
      }),
    });
    const out = await runEdit(run, ed, withFakes({ maxIterations: 1 }));
    expect(out.status).toBe("done");
    expect(out.warnings.some((w) => w.startsWith("generate unavailable for g1") && w.includes("omni down"))).toBe(true);
    expect(out.warnings.some((w) => w.includes("invalid or duplicate id"))).toBe(true);
    expect(fakes.generateShot).toHaveBeenCalledTimes(1);
    expect(out.clips.map((c) => c.id)).toEqual(["clip1", "clip2"]);
    expect(out.iterations[0].edl.cuts.map((c) => [c.id, c.clipId])).toEqual([["c1", "clip1"], ["c2", "clip2"]]);
    expect(out.iterations[0].edl.generated).toEqual([]);
    expect(existsSync(path.join(tmp, run.id, "iter1.mp4"))).toBe(true);
  });

  it("stops when Argon's fix and the linter's fix cancel out instead of re-rendering the same cut", async () => {
    const run = await makeRun();
    // Argon trims c1 to 1.0; the linter snaps it straight back to 1.5: the EDL is unchanged.
    lintEdl
      .mockReturnValueOnce({ checks: [], patches: [] }) // critique of v1
      .mockReturnValueOnce({ checks: [], patches: [{ op: "trim", cutId: "c1", srcOut: 1.5 }] }); // re-lint after Argon's trim
    const ed = editor({}, [fail([{ op: "trim", cutId: "c1", srcOut: 1.0 }]), fail([{ op: "trim", cutId: "c1", srcOut: 1.0 }]), pass]);
    const out = await runEdit(run, ed, withFakes({ maxIterations: 3 }));
    expect(out.status).toBe("done");
    expect(out.iterations).toHaveLength(1);
    expect(out.warnings).toContain("stopped at v1: the fixes cancelled each other out, so the cut is final");
    expect(out.iterations[0].edl.cuts[0].srcOut).toBeCloseTo(1.5);
  });

  it("failing critique without patches stops with warning", async () => {
    const run = await makeRun();
    const out = await runEdit(run, editor({}, [fail([])]), withFakes({ maxIterations: 3 }));
    expect(out.status).toBe("done");
    expect(out.iterations).toHaveLength(1);
    expect(out.warnings.some((w) => w.includes("no fixes"))).toBe(true);
  });
});

describe("mapLimit", () => {
  it("keeps order and never exceeds the limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 4, 2, 3], 2, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, n * 5));
      inFlight--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30]);
    expect(peak).toBe(2);
  });

  it("propagates the first rejection and starts no more work", async () => {
    const started: number[] = [];
    await expect(
      mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
        started.push(n);
        await new Promise((r) => setTimeout(r, 5));
        if (n === 2) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
    await new Promise((r) => setTimeout(r, 30));
    expect(started.length).toBeLessThan(6);
  });

  it("handles an empty list", async () => {
    expect(await mapLimit([], 3, async (n: number) => n)).toEqual([]);
  });
});
