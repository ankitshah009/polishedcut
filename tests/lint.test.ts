import { describe, expect, it } from "vitest";

import {
  LINT_CHECKS,
  lintEdl,
  outputTimeOf,
  parseTargetSeconds,
  sourceWindowsOf,
  totalDuration,
  type LintResult,
} from "../lib/lint";
import type { Caption, Cut, EDL, SourceClip, Word } from "../lib/schema";

const w = (text: string, start: number, end: number): Word => ({ text, start, end });

// Clip "a": speech 0–4.2s, silence, then "hello world" at 6.0–7.2s. Clip "b": no transcript.
const CLIPS: Record<string, SourceClip> = {
  a: {
    id: "a",
    path: "a.mp4",
    duration: 10,
    transcript: [
      w("we", 0, 0.3), w("went", 0.4, 0.8), w("to", 0.9, 1.0), w("the", 1.1, 1.3), w("park", 1.4, 2.0),
      w("today", 2.2, 2.9), w("and", 3.0, 3.2), w("it", 3.3, 3.4), w("rained", 3.5, 4.2),
      w("hello", 6.0, 6.5), w("world", 6.6, 7.2),
    ],
  },
  b: { id: "b", path: "b.mp4", duration: 5, transcript: [] },
};

const cut = (id: string, clipId: string, srcIn: number, srcOut: number): Cut => ({ id, clipId, srcIn, srcOut, reason: "" });
const cap = (text: string, start: number, end: number): Caption => ({ text, start, end });

/** Title card 0–2, c1 (a 0–2.0) at 2–4, c2 (a 2.1–4.2) at 4–6.1, c3 (b 0–2) at 6.1–8.1. Total 8.1s. */
function edl(over: Partial<EDL> = {}): EDL {
  const base: EDL = {
    title: "T",
    width: 1280,
    height: 720,
    fps: 30,
    cuts: [cut("c1", "a", 0, 2.0), cut("c2", "a", 2.1, 4.2), cut("c3", "b", 0, 2)],
    captions: [],
    overlays: [],
  };
  return { ...base, ...over } as EDL;
}

const NAMES = [LINT_CHECKS.midWord, LINT_CHECKS.captions, LINT_CHECKS.duration, LINT_CHECKS.bounds];
const find = (r: LintResult, name: string) => {
  const c = r.checks.find((x) => x.name === name);
  if (!c) throw new Error(`missing check ${name}`);
  return c;
};
const lint = (e: EDL, brief = "cut this together") => lintEdl(e, CLIPS, brief);

describe("lintEdl", () => {
  it("returns the four auto checks in a fixed order, all passing on a clean edit", () => {
    const r = lint(edl());
    expect(r.checks.map((c) => c.name)).toEqual(NAMES);
    for (const c of r.checks) {
      expect(c.name.startsWith("auto: ")).toBe(true);
      expect(c.passed).toBe(true);
      expect(c.at).toBeNull();
    }
    expect(r.patches).toEqual([]);
  });

  it("is pure and deterministic", () => {
    const e = edl({ cuts: [cut("c1", "a", 0.5, 1.7), cut("c2", "a", 2.5, 12)], captions: [cap("Buy now", 2, 3)] });
    const snapshot = structuredClone(e);
    const clipsSnapshot = structuredClone(CLIPS);
    const first = lintEdl(e, CLIPS, "a 30-second promo");
    const second = lintEdl(e, CLIPS, "a 30-second promo");
    expect(first).toEqual(second);
    expect(e).toEqual(snapshot);
    expect(CLIPS).toEqual(clipsSnapshot);
    expect(first.checks.map((c) => c.name)).toEqual(NAMES);
  });
});

describe("outputTimeOf / sourceWindowsOf / totalDuration", () => {
  it("offsets by the title card and previous cuts", () => {
    const e = edl();
    expect(outputTimeOf(e, "c1", 0)).toBe(2);
    expect(outputTimeOf(e, 0, 1.5)).toBeCloseTo(3.5);
    expect(outputTimeOf(e, 1, 3.0)).toBeCloseTo(2 + 2.0 + 0.9);
    expect(outputTimeOf(e, "c3", 1)).toBeCloseTo(7.1);
    expect(outputTimeOf(edl({ title: "" }), "c1", 0)).toBe(0);
    expect(() => outputTimeOf(e, "nope", 0)).toThrow(/unknown cut/);
    expect(() => outputTimeOf(e, 7, 0)).toThrow(/unknown cut/);
  });

  it("maps an output window back to the source windows it plays", () => {
    const windows = sourceWindowsOf(edl(), 3.5, 5.0);
    expect(windows.map((x) => x.cutId)).toEqual(["c1", "c2"]);
    expect(windows[0].srcStart).toBeCloseTo(1.5);
    expect(windows[0].srcEnd).toBeCloseTo(2.0);
    expect(windows[1].srcStart).toBeCloseTo(2.1);
    expect(windows[1].srcEnd).toBeCloseTo(3.1);
    expect(sourceWindowsOf(edl(), 0, 2)).toEqual([]); // title card only
  });

  it("totals the title card and the cuts", () => {
    expect(totalDuration(edl())).toBeCloseTo(8.1);
    expect(totalDuration(edl({ title: "" }))).toBeCloseTo(6.1);
  });

  it("adds the closing card when endTitle is set", () => {
    expect(totalDuration(edl({ endTitle: "Thanks" }))).toBeCloseTo(10.1);
    expect(totalDuration(edl({ title: "", endTitle: "Thanks" }))).toBeCloseTo(8.1);
    expect(totalDuration(edl({ endTitle: "" }))).toBeCloseTo(8.1);
    // The end card plays after the last cut, so cut times do not move.
    expect(outputTimeOf(edl({ endTitle: "Thanks" }), "c3", 1)).toBeCloseTo(7.1);
  });

  it("counts the closing card toward the brief's duration target", () => {
    const r = lintEdl(edl({ endTitle: "Thanks" }), CLIPS, "a 10-second promo");
    expect(find(r, LINT_CHECKS.duration).note).toContain("total 10.10s");
  });
});

describe("overlays", () => {
  it("are on-screen labels, not captions: the caption check ignores them", () => {
    // A lower-third over silence in clip b, and a chapter label that contradicts the speech under it.
    const overlays = [
      { text: "Chapter 2: the park", start: 6.5, end: 7.5, position: "lower-third" as const },
      { text: "Totally unrelated words here", start: 2, end: 4, position: "top" as const },
    ];
    const r = lint(edl({ overlays }));
    const captions = find(r, LINT_CHECKS.captions);
    expect(captions.passed).toBe(true);
    expect(captions.note).toBe("no captions");
    expect(r.patches).toEqual([]);
  });
});

describe("auto: no mid-word cuts", () => {
  it("passes when every boundary sits in a gap or within tolerance of a word edge", () => {
    const r = lint(edl({ cuts: [cut("c1", "a", 0, 1.95), cut("c2", "a", 2.15, 4.2)] }));
    expect(find(r, LINT_CHECKS.midWord).passed).toBe(true);
    expect(r.patches).toEqual([]);
  });

  it("flags a srcOut inside a word, localized on the output timeline, and snaps it to the word end", () => {
    const r = lint(edl({ cuts: [cut("c1", "a", 0, 1.7), cut("c2", "a", 2.1, 4.2)] }));
    const c = find(r, LINT_CHECKS.midWord);
    expect(c.passed).toBe(false);
    expect(c.at).toBeCloseTo(2 + 1.7);
    expect(c.note).toContain("c1");
    expect(c.note).toContain('"park"');
    expect(r.patches).toEqual([{ op: "trim", cutId: "c1", srcOut: 2.0 }]);
  });

  it("flags a srcIn inside a word and snaps it to the word start", () => {
    const r = lint(edl({ cuts: [cut("c1", "a", 0, 2.0), cut("c2", "a", 2.5, 4.2)] }));
    const c = find(r, LINT_CHECKS.midWord);
    expect(c.passed).toBe(false);
    expect(c.at).toBeCloseTo(4.0);
    expect(c.note).toContain('"today"');
    expect(r.patches).toEqual([{ op: "trim", cutId: "c2", srcIn: 2.2 }]);
  });

  it("emits a single trim per offending cut when both boundaries are mid-word", () => {
    const r = lint(edl({ cuts: [cut("c1", "a", 0, 2.0), cut("c2", "a", 2.5, 3.1)] }));
    const c = find(r, LINT_CHECKS.midWord);
    expect(c.passed).toBe(false);
    expect(c.at).toBeCloseTo(4.0); // the earliest offense
    expect(c.note).toContain('"today"');
    expect(c.note).toContain('"and"');
    expect(r.patches).toEqual([{ op: "trim", cutId: "c2", srcIn: 2.2, srcOut: 3.2 }]);
  });

  it("falls back to the near side of the word when the word runs past the clip", () => {
    const clips: Record<string, SourceClip> = {
      ...CLIPS,
      z: { id: "z", path: "z.mp4", duration: 10, transcript: [w("start", 0, 0.5), w("world", 9.8, 10.3)] },
    };
    const r = lintEdl(edl({ cuts: [cut("c1", "z", 8, 10.0)] }), clips, "");
    expect(find(r, LINT_CHECKS.midWord).passed).toBe(false);
    expect(r.patches).toEqual([{ op: "trim", cutId: "c1", srcOut: 9.8 }]);
  });

  it("makes no judgement on clips without a transcript", () => {
    const r = lint(edl({ cuts: [cut("c1", "b", 0.37, 1.23)] }));
    const c = find(r, LINT_CHECKS.midWord);
    expect(c.passed).toBe(true);
    expect(c.note).toMatch(/no transcript/);
    expect(r.patches).toEqual([]);
  });

  it("leaves out-of-bounds and inverted cuts to the bounds check", () => {
    const r = lint(edl({ cuts: [cut("c1", "a", -1, 2.0), cut("c2", "a", 4.2, 2.5)] }));
    expect(find(r, LINT_CHECKS.midWord).passed).toBe(true);
    expect(find(r, LINT_CHECKS.bounds).passed).toBe(false);
  });
});

describe("auto: captions match speech", () => {
  it("passes a caption that quotes the speech under it, ignoring case and punctuation", () => {
    const r = lint(edl({ captions: [cap("We went to the PARK!", 2, 4)] }));
    const c = find(r, LINT_CHECKS.captions);
    expect(c.passed).toBe(true);
    expect(c.note).toContain("1 caption");
    expect(r.patches).toEqual([]);
  });

  it("passes at exactly half the tokens matched and fails below", () => {
    expect(find(lint(edl({ captions: [cap("we went nowhere fast", 2, 4)] })), LINT_CHECKS.captions).passed).toBe(true);
    const r = lint(edl({ captions: [cap("we skipped nowhere fast", 2, 4)] }));
    expect(find(r, LINT_CHECKS.captions).passed).toBe(false);
    expect(find(r, LINT_CHECKS.captions).note).toContain("1/4");
  });

  it("fails a caption that contradicts the speech and rewrites it to what was said", () => {
    const r = lint(edl({ captions: [cap("Buy our product now", 2, 4)] }));
    const c = find(r, LINT_CHECKS.captions);
    expect(c.passed).toBe(false);
    expect(c.at).toBe(2);
    expect(c.note).toContain('"Buy our product now"');
    expect(c.note).toContain('"we went to the park"');
    expect(r.patches).toEqual([{ op: "set_caption", index: 0, text: "we went to the park" }]);
  });

  it("gathers speech across a cut boundary", () => {
    const r = lint(edl({ captions: [cap("park today and", 3.5, 5.05), cap("something else entirely", 3.5, 5.05)] }));
    const c = find(r, LINT_CHECKS.captions);
    expect(c.passed).toBe(false);
    expect(r.patches).toEqual([{ op: "set_caption", index: 1, text: "park today and" }]);
  });

  it("removes a caption over silence", () => {
    // c2 now plays a 4.3–5.9: the gap between "rained" and "hello". Output 4–5.6.
    const e = edl({ cuts: [cut("c1", "a", 0, 2.0), cut("c2", "a", 4.3, 5.9)], captions: [cap("anything", 4.2, 5.4)] });
    const r = lint(e);
    const c = find(r, LINT_CHECKS.captions);
    expect(c.passed).toBe(false);
    expect(c.at).toBe(4.2);
    expect(c.note).toMatch(/no speech/);
    expect(r.patches).toEqual([{ op: "remove_caption", index: 0 }]);
  });

  it("makes no judgement over the title card or clips without a transcript", () => {
    const r = lint(edl({ captions: [cap("Nonsense title text", 0, 2), cap("more nonsense", 6.5, 8)] }));
    const c = find(r, LINT_CHECKS.captions);
    expect(c.passed).toBe(true);
    expect(c.note).toMatch(/no transcript/);
    expect(r.patches).toEqual([]);
  });

  it("orders set_caption before remove_caption and removals from the highest index down", () => {
    const e = edl({
      cuts: [cut("c1", "a", 0, 2.0), cut("c2", "a", 4.3, 5.9)],
      captions: [cap("wrong words here", 2, 4), cap("silent one", 4.2, 5.0), cap("silent two", 5.0, 5.5)],
    });
    const r = lint(e);
    expect(find(r, LINT_CHECKS.captions).at).toBe(2);
    expect(r.patches).toEqual([
      { op: "set_caption", index: 0, text: "we went to the park" },
      { op: "remove_caption", index: 2 },
      { op: "remove_caption", index: 1 },
    ]);
  });
});

describe("parseTargetSeconds", () => {
  it.each([
    ["Make a 30-second highlight", 30, "target"],
    ["keep it to 30s", 30, "target"],
    ["about 30 seconds of the best bits", 30, "target"],
    ["45 secs, upbeat", 45, "target"],
    ["half a minute recap", 30, "target"],
    ["one minute sizzle", 60, "target"],
    ["a one-minute sizzle", 60, "target"],
    ["a minute of highlights", 60, "target"],
    ["1.5 minutes", 90, "target"],
    ["forty-five seconds", 45, "target"],
    ["a minute and a half", 90, "target"],
    ["two and a half minutes", 150, "target"],
    ["under 20 seconds", 20, "max"],
    ["no more than 45 secs", 45, "max"],
    ["keep it within a minute", 60, "max"],
    ["20 seconds max", 20, "max"],
    ["at least 10 seconds", 10, "min"],
  ])("%s -> %d (%s)", (brief, seconds, bound) => {
    expect(parseTargetSeconds(brief)).toMatchObject({ seconds, bound });
  });

  it("returns null when the brief names no length", () => {
    expect(parseTargetSeconds("Make it punchy and fun")).toBeNull();
    expect(parseTargetSeconds("take a second look at the footage")).toBeNull();
    expect(parseTargetSeconds("1980s vibe, 1080p, 30 fps")).toBeNull();
    expect(parseTargetSeconds("")).toBeNull();
  });

  it("uses the first length in the brief and reports the phrase", () => {
    expect(parseTargetSeconds("a 20-second teaser, not the 2 minute version")).toMatchObject({ seconds: 20, phrase: "20-second" });
  });
});

describe("auto: duration matches brief", () => {
  const total = 8.1;

  it("passes with a note when the brief has no target", () => {
    const c = find(lint(edl(), "make it fun"), LINT_CHECKS.duration);
    expect(c).toEqual({ name: LINT_CHECKS.duration, passed: true, at: null, note: "no target in brief" });
  });

  it("fails when the total misses the target by more than max(2s, 15%), without a patch", () => {
    const r = lint(edl(), "Make a 30-second highlight");
    const c = find(r, LINT_CHECKS.duration);
    expect(c.passed).toBe(false);
    expect(c.note).toContain(`${total.toFixed(2)}s`);
    expect(c.note).toContain("30.00s");
    expect(c.note).toMatch(/short by/);
    expect(r.patches).toEqual([]);
  });

  it("applies the 2s floor of the tolerance", () => {
    expect(find(lint(edl(), "about 10 seconds"), LINT_CHECKS.duration).passed).toBe(true); // off by 1.9
    const c = find(lint(edl(), "about 10.5 seconds"), LINT_CHECKS.duration);
    expect(c.passed).toBe(false); // off by 2.4
    expect(c.at).toBeNull(); // too short: nothing to point at
  });

  it("points at the target when the cut runs over", () => {
    const c = find(lint(edl(), "a 5 second bumper"), LINT_CHECKS.duration);
    expect(c.passed).toBe(false);
    expect(c.at).toBe(5);
    expect(c.note).toMatch(/over by/);
  });

  it("treats 'under N' as an upper bound", () => {
    expect(find(lint(edl(), "under 20 seconds"), LINT_CHECKS.duration).passed).toBe(true);
    const c = find(lint(edl(), "under 5 seconds"), LINT_CHECKS.duration);
    expect(c.passed).toBe(false);
    expect(c.at).toBe(5);
    expect(c.note).toContain("at most 5.00s");
  });

  it("treats 'at least N' as a lower bound", () => {
    expect(find(lint(edl(), "at least 5 seconds"), LINT_CHECKS.duration).passed).toBe(true);
    expect(find(lint(edl(), "at least 10 seconds"), LINT_CHECKS.duration).passed).toBe(false);
  });
});

describe("auto: cuts inside clip bounds", () => {
  it("allows srcOut to overshoot the probed duration by up to 0.05s", () => {
    const r = lint(edl({ cuts: [cut("c1", "a", 0, 10.03)] }));
    expect(find(r, LINT_CHECKS.bounds).passed).toBe(true);
    expect(r.patches).toEqual([]);
  });

  it("trims a srcOut past the clip to the clip duration, localized where the clip runs out", () => {
    const r = lint(edl({ cuts: [cut("c1", "a", 0, 12)] }));
    const c = find(r, LINT_CHECKS.bounds);
    expect(c.passed).toBe(false);
    expect(c.at).toBe(12); // title 2s + 10s of clip
    expect(c.note).toContain("c1");
    expect(r.patches).toEqual([{ op: "trim", cutId: "c1", srcOut: 10 }]);
  });

  it("trims a negative srcIn to zero", () => {
    const r = lint(edl({ cuts: [cut("c1", "a", -1, 2.0)] }));
    const c = find(r, LINT_CHECKS.bounds);
    expect(c.passed).toBe(false);
    expect(c.at).toBe(2);
    expect(r.patches).toEqual([{ op: "trim", cutId: "c1", srcIn: 0 }]);
  });

  it("swaps an inverted cut back into order", () => {
    const r = lint(edl({ cuts: [cut("c1", "a", 0, 2.0), cut("c2", "a", 4.2, 2.1)] }));
    const c = find(r, LINT_CHECKS.bounds);
    expect(c.passed).toBe(false);
    expect(c.at).toBe(4);
    expect(r.patches).toEqual([{ op: "trim", cutId: "c2", srcIn: 2.1, srcOut: 4.2 }]);
  });

  it("removes a cut that cannot be trimmed into a usable length", () => {
    const r = lint(edl({ cuts: [cut("c1", "a", 0, 2.0), cut("c2", "a", 3, 3)] }));
    expect(find(r, LINT_CHECKS.bounds).passed).toBe(false);
    expect(r.patches).toEqual([{ op: "remove_cut", cutId: "c2" }]);
  });

  it("removes a cut on an unknown clip", () => {
    const r = lint(edl({ cuts: [cut("c1", "a", 0, 2.0), cut("c2", "zzz", 0, 1)] }));
    const c = find(r, LINT_CHECKS.bounds);
    expect(c.passed).toBe(false);
    expect(c.note).toContain("zzz");
    expect(r.patches).toEqual([{ op: "remove_cut", cutId: "c2" }]);
  });

  it("lists several offenses in timeline order and counts the overflow", () => {
    const cuts = [-1, -2, -3, -4, -5].map((srcIn, i) => cut(`c${i + 1}`, "a", srcIn, 1));
    const c = find(lint(edl({ cuts })), LINT_CHECKS.bounds);
    expect(c.passed).toBe(false);
    expect(c.at).toBe(2);
    expect(c.note).toMatch(/^c1 .*; c2 .*; c3 .*; c4 .*; \+1 more$/);
  });
});

describe("patch ordering across rules", () => {
  it("emits mid-word trims, then caption fixes, then bounds fixes", () => {
    const e = edl({
      cuts: [cut("c1", "a", 0, 1.7), cut("c2", "a", 2.1, 4.2), cut("c3", "a", 5, 12)],
      captions: [cap("Buy now", 2, 3.7)],
    });
    const r = lint(e);
    expect(r.checks.filter((c) => !c.passed).map((c) => c.name)).toEqual([
      LINT_CHECKS.midWord,
      LINT_CHECKS.captions,
      LINT_CHECKS.bounds,
    ]);
    expect(r.patches).toEqual([
      { op: "trim", cutId: "c1", srcOut: 2.0 },
      { op: "set_caption", index: 0, text: "we went to the park" },
      { op: "trim", cutId: "c3", srcOut: 10 },
    ]);
  });
});
