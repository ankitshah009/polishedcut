import { describe, expect, it } from "vitest";

import {
  checkGroup,
  checkLabel,
  costChip,
  currentStage,
  cutAt,
  cutRanges,
  cutsEnd,
  describeFix,
  describePatch,
  describeWarning,
  diffEdl,
  edlAudio,
  edlDuration,
  edlEndImage,
  edlEndTitle,
  edlMusic,
  edlOverlays,
  edlTitleImage,
  endCardRange,
  endCardSeconds,
  overlayCell,
  estimateCost,
  estimateRemainingMs,
  formatDuration,
  formatEta,
  formatSeconds,
  formatTime,
  formatTokens,
  formatUsd,
  normalizeRates,
  phaseText,
  rateFor,
  recutText,
  runElapsedMs,
  runUsage,
  stageIds,
  stageSentence,
  stageStates,
  STAGE_MEDIAN_MS,
  videoUrl,
} from "../lib/format";
import type { EDL, Iteration, PatchOp, Run } from "../lib/schema";

const edl = (over: Partial<EDL> = {}): EDL => ({
  title: "T",
  cuts: [
    { id: "c1", clipId: "clip1", srcIn: 0, srcOut: 8.2, reason: "" },
    { id: "c2", clipId: "clip2", srcIn: 1, srcOut: 4.1, reason: "" },
  ],
  captions: [
    { text: "hello", start: 2, end: 4 },
    { text: "world", start: 4, end: 6 },
  ],
  overlays: [],
  width: 1280,
  height: 720,
  fps: 30,
  ...over,
});

const run = (status: Run["status"], iterations = 0, error = ""): Run =>
  ({ id: "r", brief: "", createdAt: "", clips: [], iterations: Array(iterations).fill({}), status, error, warnings: [] }) as Run;

describe("formatTime", () => {
  it("formats minutes and tenths", () => {
    expect(formatTime(0)).toBe("0:00.0");
    expect(formatTime(5.25)).toBe("0:05.3");
    expect(formatTime(75.4)).toBe("1:15.4");
  });
  it("rolls 59.96 over to the next minute", () => expect(formatTime(59.96)).toBe("1:00.0"));
  it("clamps negatives and non-finite", () => {
    expect(formatTime(-3)).toBe("0:00.0");
    expect(formatTime(NaN)).toBe("0:00.0");
  });
});

describe("formatSeconds / videoUrl", () => {
  it("works", () => {
    expect(formatSeconds(1.234)).toBe("1.2s");
    expect(formatSeconds(NaN)).toBe("0.0s");
    expect(videoUrl("a", "x y/v.mp4")).toBe("/api/runs/a/files/x%20y/v.mp4");
  });
});

describe("describePatch", () => {
  const cases: [PatchOp, string][] = [
    [{ op: "trim", cutId: "c1", srcIn: 1, srcOut: 2 }, "Trim c1 to start at 1.0s and end at 2.0s"],
    [{ op: "trim", cutId: "c1" }, "Trim c1 to new bounds"],
    [{ op: "remove_cut", cutId: "c2" }, "Remove c2"],
    [{ op: "insert_cut", clipId: "k", srcIn: 0, srcOut: 1.5, index: 0 }, "Insert k 0.0s–1.5s at position 1"],
    [{ op: "insert_cut" }, "Insert a clip"],
    [{ op: "move_cut", cutId: "c3", index: 2 }, "Move c3 to position 3"],
    [{ op: "set_caption", index: 0, text: "Hi" }, "Change caption 1 to “Hi”"],
    [{ op: "remove_caption", index: 1 }, "Remove caption 2"],
    [{ op: "add_caption", text: "Yo", start: 61 }, "Add caption “Yo” at 1:01.0"],
    [{ op: "set_title", text: "T" }, "Set title to “T”"],
    [{ op: "set_title" }, "Remove the title card"],
  ];
  it.each(cases)("%j", (op, want) => expect(describePatch(op)).toBe(want));
});

describe("timeline helpers", () => {
  it("places cuts after the title card", () => {
    const r = cutRanges(edl());
    expect(r.map((x) => [x.cut.id, x.start, Math.round(x.end * 100) / 100])).toEqual([
      ["c1", 2, 10.2],
      ["c2", 10.2, 13.3],
    ]);
    expect(edlDuration(edl())).toBeCloseTo(13.3);
    expect(cutAt(edl(), 1)).toBeNull();
    expect(cutAt(edl(), 10.2)?.cut.id).toBe("c2");
    expect(cutAt(edl(), 99)?.cut.id).toBe("c2");
  });
  it("adds the closing card to the total but not to the cuts", () => {
    const plain = edl();
    expect(endCardSeconds(plain)).toBe(0);
    expect(endCardRange(plain)).toBeNull();
    const withEnd = { ...edl(), endTitle: "Built with Argon" } as EDL;
    expect(endCardSeconds(withEnd)).toBe(2);
    expect(cutsEnd(withEnd)).toBeCloseTo(13.3);
    expect(edlDuration(withEnd)).toBeCloseTo(15.3);
    expect(endCardRange(withEnd)).toEqual({ start: expect.closeTo(13.3, 5), end: expect.closeTo(15.3, 5) });
    // Cuts keep their places; the card is not a cut.
    expect(cutRanges(withEnd).map((r) => r.cut.id)).toEqual(["c1", "c2"]);
    expect(cutAt(withEnd, 14)).toBeNull();
    expect(cutAt(withEnd, 15.3)?.cut.id).toBe("c2");
    expect(edlDuration({ ...edl(), endTitle: "   " } as EDL)).toBeCloseTo(13.3);
  });
  it("formats durations and sums timings", () => {
    expect(formatDuration(48_000)).toBe("48s");
    expect(formatDuration(84_000)).toBe("1m 24s");
    expect(formatDuration(3_720_000)).toBe("1h 02m");
    expect(runElapsedMs({ timings: [{ stage: "a", ms: 1000 }, { stage: "b", ms: 500 }] })).toBe(1500);
    expect(runElapsedMs({ timings: [] })).toBeNull();
    expect(runElapsedMs({})).toBeNull();
  });
  it("groups and labels checks", () => {
    expect(checkGroup("brief: shows the keynote")).toBe("brief");
    expect(checkGroup("auto: no mid-word cuts")).toBe("auto");
    expect(checkGroup("title card readable")).toBe("craft");
    expect(checkLabel("brief: shows the keynote")).toBe("Shows the keynote");
    expect(checkLabel("auto:no filler")).toBe("No filler");
  });
});

describe("describeFix", () => {
  it("trim end reads from the applied version", () => {
    const after = edl({ cuts: [{ id: "c1", clipId: "clip1", srcIn: 0, srcOut: 7.72, reason: "" }, edl().cuts[1]] });
    const f = describeFix({ op: "trim", cutId: "c1", srcOut: 7.72 }, edl(), after);
    expect(f.title).toBe("Trim c1 end");
    expect(f.before).toBe("8.20s");
    expect(f.after).toBe("7.72s");
    expect(f.at).toBeCloseTo(2 + 7.72);
    expect(f.reason).toContain("0.48s shorter");
  });
  it("trim start and both bounds", () => {
    expect(describeFix({ op: "trim", cutId: "c2", srcIn: 1.5 }, edl())).toMatchObject({ title: "Trim c2 start", before: "1.00s", after: "1.50s", at: 10.2 });
    expect(describeFix({ op: "trim", cutId: "c2", srcIn: 1.5, srcOut: 3 }, edl())).toMatchObject({ title: "Re-trim c2", before: "1.00s–4.10s", after: "1.50s–3.00s" });
    expect(describeFix({ op: "trim", cutId: "zz", srcOut: 3 }, edl())).toMatchObject({ title: "Trim zz", before: "—", after: "3.00s" });
  });
  it("remove, insert and move cuts", () => {
    expect(describeFix({ op: "remove_cut", cutId: "c2" }, edl())).toMatchObject({ title: "Remove c2", before: "c2 · 3.1s", after: "removed", at: 10.2 });
    expect(describeFix({ op: "insert_cut", clipId: "clip3", srcIn: 0, srcOut: 2, index: 1 }, edl())).toMatchObject({
      title: "Insert clip3",
      before: "—",
      after: "clip3 0.00s–2.00s",
      at: 10.2,
    });
    expect(describeFix({ op: "insert_cut", clipId: "clip3", srcIn: 0, srcOut: 2 }, edl()).at).toBeCloseTo(13.3);
    expect(describeFix({ op: "move_cut", cutId: "c2", index: 0 }, edl())).toMatchObject({ before: "position 2", after: "position 1", at: 10.2 });
  });
  it("captions and title", () => {
    expect(describeFix({ op: "set_caption", index: 0, text: "hi" }, edl())).toMatchObject({ title: "Rewrite caption 1", before: "“hello”", after: "“hi”", at: 2 });
    expect(describeFix({ op: "set_caption", index: 1, start: 4.5, end: 6 }, edl())).toMatchObject({ title: "Retime caption 2", before: "4.00s–6.00s", after: "4.50s–6.00s", at: 4.5 });
    expect(describeFix({ op: "set_caption", index: 7, text: "x" }, edl())).toMatchObject({ before: "—", after: "“x”" });
    expect(describeFix({ op: "remove_caption", index: 1 }, edl())).toMatchObject({ before: "“world”", after: "removed", at: 4 });
    expect(describeFix({ op: "add_caption", text: "new", start: 6, end: 8 }, edl())).toMatchObject({ title: "Add caption", before: "—", after: "“new”", at: 6 });
    expect(describeFix({ op: "set_title", text: "U" }, edl())).toMatchObject({ before: "“T”", after: "“U”", at: 0 });
    expect(describeFix({ op: "set_title" }, edl({ title: "" }))).toMatchObject({ title: "Remove title card", before: "no title", after: "no title" });
  });
  it("diffEdl explains a version pair without patches", () => {
    const after = edl({
      title: "U",
      cuts: [
        { id: "c2", clipId: "clip2", srcIn: 1, srcOut: 4.1, reason: "" },
        { id: "c3", clipId: "clip3", srcIn: 0, srcOut: 1, reason: "why" },
      ],
      captions: [{ text: "hello!", start: 2, end: 4 }],
    });
    const titles = diffEdl(edl(), after).map((c) => c.title);
    expect(titles).toEqual(["Set title", "Remove c1", "Insert clip3", "Rewrite caption 1", "Remove caption 2"]);
    expect(diffEdl(edl(), edl())).toEqual([]);
  });
});

describe("recutText", () => {
  const it_ = (n: number, fails: number, note?: string): Iteration =>
    ({
      n,
      edl: edl(),
      video: "",
      note,
      critique: { checks: [...Array(fails).fill({ name: "x", passed: false, note: "" }), { name: "y", passed: true, note: "" }], patches: [], summary: "" },
    }) as Iteration;
  it("counts automatic rounds and notes separately", () => {
    expect(recutText([])).toBeNull();
    expect(recutText([it_(1, 0)])).toBe("First cut passed every check");
    expect(recutText([it_(1, 2)])).toBeNull();
    expect(recutText([it_(1, 2), it_(2, 0)])).toBe("Argon re-cut once to fix 2 issues");
    expect(recutText([it_(1, 1), it_(2, 1), it_(3, 0)])).toBe("Argon re-cut twice to fix 2 issues");
    expect(recutText([it_(1, 0), it_(2, 0, "tighter")])).toBe("First cut passed every check · 1 director's note applied");
  });
});

describe("optional run fields", () => {
  it("reads usage, music and title art when present and stays quiet when not", () => {
    expect(runUsage({ id: "r" })).toEqual([]);
    expect(runUsage({ id: "r", usage: "nope" })).toEqual([]);
    expect(runUsage({ id: "r", usage: [{ model: "gemini-4-argon", inputTokens: 1000, outputTokens: 50, cachedTokens: 200, ms: 3 }, null, { inputTokens: "x" }] })).toEqual([
      { model: "gemini-4-argon", inputTokens: 1000, outputTokens: 50, cachedTokens: 200, ms: 3 },
      { model: "unknown", inputTokens: 0, outputTokens: 0, cachedTokens: 0, ms: 0 },
    ]);
    expect(edlMusic(edl())).toBeNull();
    expect(edlMusic({ ...edl(), music: { prompt: "  warm synth pad ", gainDb: -14, file: "music.mp3" } })).toEqual({ prompt: "warm synth pad", gainDb: -14, file: "music.mp3" });
    expect(edlMusic({ ...edl(), music: { prompt: "" } })).toBeNull();
    expect(edlTitleImage(edl())).toBeNull();
    expect(edlTitleImage({ ...edl(), titleImage: "title.png" })).toBe("title.png");
  });
  it("reads labels, the closing card and the audio mix defensively", () => {
    expect(edlOverlays(edl())).toEqual([]);
    expect(edlOverlays({ ...edl(), overlays: "nope" })).toEqual([]);
    expect(
      edlOverlays({
        ...edl(),
        overlays: [
          { text: " Keynote ", start: 5, end: 8, position: "top-left" },
          { text: "", start: 1, end: 2, position: "top" },
          { text: "Demo", start: 2, end: 1 },
          null,
        ],
      }),
    ).toEqual([
      { text: "Demo", start: 2, end: 2, position: "lower-third" },
      { text: "Keynote", start: 5, end: 8, position: "top-left" },
    ]);
    expect(edlEndTitle(edl())).toBeNull();
    expect(edlEndTitle({ ...edl(), endTitle: " Thanks " })).toBe("Thanks");
    expect(edlEndImage({ ...edl(), endImage: "end.png" })).toBe("end.png");
    expect(edlEndImage(edl())).toBeNull();
    expect(edlAudio(edl())).toBeNull();
    expect(edlAudio({ ...edl(), audio: {} })).toBeNull();
    expect(edlAudio({ ...edl(), audio: { denoise: false } })).toBeNull();
    expect(edlAudio({ ...edl(), audio: { denoise: true } })).toEqual({ denoise: true, musicGainDb: undefined });
    expect(edlAudio({ ...edl(), audio: { musicGainDb: -8 } })).toEqual({ denoise: false, musicGainDb: -8 });
    expect(overlayCell("top")).toEqual({ row: 0, col: 1 });
    expect(overlayCell("lower-third")).toEqual({ row: 2, col: 1 });
    expect(overlayCell("center")).toEqual({ row: 1, col: 1 });
    expect(overlayCell("top-left")).toEqual({ row: 0, col: 0 });
    expect(overlayCell("lower right")).toEqual({ row: 2, col: 2 });
  });
  it("diffs labels, the closing card and the mix between versions", () => {
    const after = { ...edl(), overlays: [{ text: "Keynote", start: 3, end: 6, position: "top" }], endTitle: "Built with Argon", audio: { denoise: true } } as EDL;
    const cards = diffEdl(edl(), after);
    expect(cards.map((c) => c.title)).toEqual(["Add labels", "Add end card", "Change audio mix"]);
    expect(cards[0]).toMatchObject({ before: "no labels", after: "1 label", at: 3 });
    expect(cards[1]).toMatchObject({ before: "no end card", after: "“Built with Argon”" });
    expect(cards[1].at).toBeCloseTo(13.3);
    expect(cards[2]).toMatchObject({ before: "plain mix", after: "denoised" });
    expect(diffEdl(after, edl()).map((c) => c.title)).toEqual(["Remove labels", "Remove end card", "Change audio mix"]);
  });
});

describe("describeWarning", () => {
  it("strips the version prefix into a badge and picks a tone", () => {
    expect(describeWarning("v2: skipped add_caption: add_caption needs text and start < end")).toEqual({
      text: "Skipped add_caption: add_caption needs text and start < end",
      tone: "caution",
      version: 2,
    });
    expect(describeWarning("Placed Argon's caption 'Hi' at 36.3–38.3s from the transcript")).toEqual({
      text: "Placed Argon's caption 'Hi' at 36.3–38.3s from the transcript",
      tone: "info",
      version: undefined,
    });
    expect(describeWarning("v3: Resumed after a network error")).toMatchObject({ tone: "info", version: 3 });
    expect(describeWarning("Started again from v2")).toMatchObject({ tone: "info" });
    expect(describeWarning("v2: dropped 1 patch that targeted a missing cut")).toMatchObject({ tone: "caution", text: "Dropped 1 patch that targeted a missing cut" });
    expect(describeWarning("art could not be generated")).toMatchObject({ tone: "caution" });
    expect(describeWarning("stopped at v3: the fixes cancelled each other out, so the cut is final")).toMatchObject({ tone: "final", version: 3 });
    expect(describeWarning("v3: stopped: Argon reported failures with no fixes")).toMatchObject({ tone: "final", version: 3 });
    expect(describeWarning("music unavailable: quota")).toMatchObject({ tone: "caution", text: "Music unavailable: quota" });
  });
});

describe("cost estimates", () => {
  const usage = [
    { model: "gemini-4-argon", inputTokens: 50_000, outputTokens: 10_000, cachedTokens: 10_000 },
    { model: "gemini-3.5-transcribe", inputTokens: 1_000, outputTokens: 0 },
  ];
  it("prices with default rates and bills cached input at the cached rate", () => {
    // argon: 40k fresh * $2 + 10k cached * $0.5 + 10k out * $10 = 0.08 + 0.005 + 0.1; transcribe falls back to argon input rate.
    const c = estimateCost(usage);
    expect(c.usd).toBeCloseTo(0.185 + 0.002, 6);
    expect(c.tokens).toBe(61_000);
    expect(c.byModel.map((m) => m.model)).toEqual(["gemini-4-argon", "gemini-3.5-transcribe"]);
    expect(costChip(usage)).toBe("≈ $0.19 · 61k tokens");
    expect(costChip([])).toBeNull();
  });
  it("normalises rate shapes and matches model names loosely", () => {
    const rates = normalizeRates({
      "gemini-4-argon": { inputPerM: 3, outputPerM: 12, cachedPerM: 0.75 },
      flash: { input: 0.3, output: 2.5 },
      lyria: { match: "lyria", inputPerM: 0, outputPerM: 0, perCall: 0.1, source: "assumed", note: "per request" },
      junk: "x",
    });
    expect(rates).toEqual({
      "gemini-4-argon": { input: 3, output: 12, cached: 0.75 },
      flash: { input: 0.3, output: 2.5, cached: undefined },
      lyria: { input: 0, output: 0, cached: undefined, perCall: 0.1, match: "lyria", source: "assumed", note: "per request" },
    });
    expect(rateFor("gemini-4-argon", rates).input).toBe(3);
    expect(rateFor("gemini-3.8-flash", rates).output).toBe(2.5);
    expect(rateFor("lyria-2-music", rates).perCall).toBe(0.1);
    expect(rateFor("something-else", rates).input).toBe(2); // DEFAULT argon
    expect(estimateCost([{ model: "lyria-2-music", inputTokens: 0, outputTokens: 0 }], rates).usd).toBeCloseTo(0.1);
    expect(normalizeRates(null)).toEqual({});
  });
  it("formats money and tokens", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.004)).toBe("$0.004");
    expect(formatUsd(0.42)).toBe("$0.42");
    expect(formatUsd(1234.5)).toBe("$1,235");
    expect(formatTokens(612)).toBe("612");
    expect(formatTokens(61_234)).toBe("61k");
    expect(formatTokens(1_234_567)).toBe("1.2M");
  });
});

describe("stages", () => {
  const r = (status: Run["status"], timings: { stage: string; ms: number }[], iterations = 0, transcribed = false): Run =>
    ({
      ...run(status, iterations),
      timings,
      clips: transcribed ? [{ id: "clip1", path: "", duration: 1, transcript: [{ text: "a", start: 0, end: 1 }] }] : [],
    }) as Run;
  const t = (...stages: string[]) => stages.map((stage) => ({ stage, ms: 1 }));
  it("adds analyze, art and music once their timings exist", () => {
    expect(stageIds(r("drafting", []))).toEqual(["transcribe", "draft", "render", "watch"]);
    expect(stageIds(r("done", t("transcribe", "analyze", "draft", "title-art", "music", "render1"), 1))).toEqual(["transcribe", "analyze", "draft", "art", "music", "render", "watch", "fix"]);
  });
  it("points at the live stage", () => {
    expect(currentStage(r("queued", []))).toBe(0);
    expect(currentStage(r("drafting", []))).toBe(0);
    expect(currentStage(r("drafting", [], 0, true))).toBe(1); // transcripts exist -> Draft
    expect(currentStage(r("drafting", t("transcribe", "analyze")))).toBe(2); // Analyze done -> Draft
    expect(currentStage(r("drafting", t("transcribe", "draft", "title-art")))).toBe(3); // everything before the render reported -> Render
    expect(currentStage(r("rendering", t("transcribe", "draft")))).toBe(2);
    expect(currentStage(r("critiquing", t("transcribe", "draft", "render1"), 1))).toBe(3);
    expect(currentStage(r("rendering", t("transcribe", "draft", "render1", "critique1"), 1))).toBe(4);
  });
  it("adds a generate stage after draft when Omni made shots", () => {
    expect(stageIds(r("drafting", t("transcribe", "draft", "generate")))).toEqual(["transcribe", "draft", "generate", "render", "watch"]);
    expect(currentStage(r("drafting", t("transcribe", "draft", "generate")))).toBe(3); // Generate reported -> Render
  });
  it("marks stages done / live / todo in order", () => {
    expect(stageStates(r("drafting", t("transcribe"))).map((s) => s.state)).toEqual(["done", "live", "todo", "todo"]);
    expect(stageStates(r("critiquing", t("transcribe", "draft", "render1"), 1)).map((s) => `${s.id}:${s.state}`)).toEqual([
      "transcribe:done",
      "draft:done",
      "render:done",
      "watch:live",
      "fix:todo",
    ]);
  });
});

describe("eta", () => {
  const r = (status: Run["status"], timings: { stage: string; ms: number }[], iterations: Partial<Iteration>[] = []): Run =>
    ({ ...run(status), timings, iterations, clips: [] }) as Run;
  const t = (...stages: string[]) => stages.map((stage) => ({ stage, ms: 1 }));
  const failed = { critique: { checks: [{ name: "x", passed: false, note: "" }], patches: [], summary: "" } };
  const passed = { critique: { checks: [{ name: "x", passed: true, note: "" }], patches: [], summary: "" } };
  it("sums the medians of the stages still to come", () => {
    const ms = estimateRemainingMs(r("drafting", t("transcribe")))!;
    // draft + render + watch, plus half a fix round since nothing has been watched yet
    expect(ms).toBe(STAGE_MEDIAN_MS.draft + STAGE_MEDIAN_MS.render + STAGE_MEDIAN_MS.watch + STAGE_MEDIAN_MS.fix / 2);
  });
  it("adds a fix round only when the last watched version failed", () => {
    const base = t("transcribe", "draft", "render1", "critique1");
    expect(estimateRemainingMs(r("rendering", base, [failed]))).toBe(STAGE_MEDIAN_MS.fix);
    expect(estimateRemainingMs(r("critiquing", t("transcribe", "draft", "render1"), [{}]))).toBe(STAGE_MEDIAN_MS.watch + STAGE_MEDIAN_MS.fix / 2);
    expect(estimateRemainingMs(r("critiquing", [...base, ...t("render2")], [failed, {}]))).toBe(STAGE_MEDIAN_MS.watch + STAGE_MEDIAN_MS.fix / 2);
    expect(estimateRemainingMs(r("critiquing", [...base, ...t("render2")], [failed, passed]), 2)).toBe(STAGE_MEDIAN_MS.watch);
  });
  it("is null once the run has ended and never below five seconds", () => {
    expect(estimateRemainingMs(r("done", t("transcribe"), [passed]))).toBeNull();
    expect(estimateRemainingMs(r("error", []))).toBeNull();
    expect(estimateRemainingMs(r("critiquing", t("transcribe", "draft", "render1", "critique1", "render2", "critique2", "render3"), [failed, failed, passed]), 3)).toBe(
      STAGE_MEDIAN_MS.watch,
    );
  });
  it("formats honestly", () => {
    expect(formatEta(null)).toBeNull();
    expect(formatEta(20_000)).toBe("under a minute left");
    expect(formatEta(70_000)).toBe("about a minute left");
    expect(formatEta(130_000)).toBe("about 2 min left");
  });
  it("says what Argon is doing now", () => {
    expect(stageSentence(r("queued", []))).toMatch(/listening/);
    expect(stageSentence(r("drafting", t("transcribe")))).toMatch(/picking the moments/);
    expect(stageSentence(r("critiquing", t("transcribe", "draft", "render1"), [{}]))).toBe("Argon is watching v1 and grading it against your brief, check by check.");
    expect(stageSentence(r("rendering", t("transcribe", "draft", "render1", "critique1"), [failed]))).toBe("Argon is patching what failed in v1 and rendering v2.");
  });
});

describe("phaseText", () => {
  it("covers every status", () => {
    expect(phaseText(run("queued"))).toEqual({ text: "Queued", tone: "busy" });
    expect(phaseText(run("drafting")).tone).toBe("busy");
    expect(phaseText(run("rendering", 1)).text).toBe("Rendering v2");
    expect(phaseText(run("critiquing", 2)).text).toBe("Argon is watching v2");
    expect(phaseText(run("done", 1))).toEqual({ text: "Final cut ready · v1", tone: "done" });
    expect(phaseText(run("done", 2)).text).toBe("Final cut ready · v2, after 1 fix");
    expect(phaseText(run("done", 3)).text).toBe("Final cut ready · v3, after 2 fixes");
    expect(phaseText(run("error", 0, "boom"))).toEqual({ text: "boom", tone: "error" });
    expect(phaseText(run("error")).text).toBe("Something went wrong");
  });
});
