import { describe, expect, it } from "vitest";
import { applyPatches } from "../lib/patch";
import { completePatches, snippet } from "../lib/patch-complete";
import type { EDL, PatchOp, SourceClip, Word } from "../lib/schema";

/** "a b c" spoken from `at`, one word every 0.5s. */
function speech(text: string, at: number): Word[] {
  return text.split(" ").map((w, i) => ({ text: w, start: at + i * 0.5, end: at + i * 0.5 + 0.4 }));
}

const CLIPS: Record<string, SourceClip> = {
  clip1: {
    id: "clip1",
    path: "clip1.mp4",
    duration: 60,
    transcript: [...speech("Welcome to the show.", 1), ...speech("Are you just trying to ship faster?", 30), ...speech("Nobody wants that.", 50)],
  },
  clip2: { id: "clip2", path: "clip2.mp4", duration: 20, transcript: speech("It's a wrap, folks!", 4) },
};

function edl(title = ""): EDL {
  return {
    title,
    width: 1280,
    height: 720,
    fps: 30,
    cuts: [
      { id: "c1", clipId: "clip1", srcIn: 28, srcOut: 36, reason: "" }, // "Are you just trying to ship faster" at 30–33.4
      { id: "c2", clipId: "clip2", srcIn: 2, srcOut: 8, reason: "" }, // "It's a wrap folks" at 4–5.9
    ],
    captions: [{ text: "Welcome", start: 0, end: 1 }],
    overlays: [],
  };
}

const P = (p: Partial<PatchOp> & { op: PatchOp["op"] }) => p as PatchOp;

describe("completePatches", () => {
  it("times an untimed add_caption from the transcript under the cut (no title card)", () => {
    const { patches, notes } = completePatches([P({ op: "add_caption", text: "Are you just trying to ship faster?" })], edl(), CLIPS);
    expect(patches).toHaveLength(1);
    // c1 starts at output 0 and source 28: words at 30.0–33.4 land at 2.0–5.4 (+0.15 tail).
    expect(patches[0]).toMatchObject({ op: "add_caption", text: "Are you just trying to ship faster?" });
    expect(patches[0].start).toBeCloseTo(2.0, 3);
    expect(patches[0].end).toBeCloseTo(5.55, 3);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/^Placed Argon's caption 'Are you just trying to ship faster\?' at 2\.0–5\.[56]s from the transcript$/);
    // And applyPatches now accepts it where it used to skip.
    const { edl: out, skipped } = applyPatches(edl(), patches, CLIPS);
    expect(skipped).toEqual([]);
    expect(out.captions.map((c) => c.text)).toEqual(["Welcome", "Are you just trying to ship faster?"]);
  });

  it("adds the title-card offset and later-cut offsets, ignoring case and punctuation", () => {
    // Title card is 2s; c1 is 8s long, so c2 begins at output 10 and source 2.
    const { patches, notes } = completePatches([P({ op: "add_caption", text: "its a WRAP folks", start: 5, end: 5 })], edl("Intro"), CLIPS);
    expect(patches[0].start).toBeCloseTo(12.0, 3);
    expect(patches[0].end).toBeCloseTo(12 + 1.9 + 0.15, 3);
    expect(notes[0]).toMatch(/^Placed Argon's caption 'its a WRAP folks' at 12\.0–14\.[01]s/);
  });

  it("prefers the occurrence inside a cut and clamps the caption to the cut", () => {
    const e = edl();
    e.cuts[0] = { id: "c1", clipId: "clip1", srcIn: 31, srcOut: 33, reason: "" }; // cuts into the phrase
    const { patches } = completePatches([P({ op: "add_caption", text: "just trying to ship" })], e, CLIPS);
    expect(patches).toHaveLength(1);
    expect(patches[0].start).toBeGreaterThanOrEqual(0);
    expect(patches[0].end).toBeLessThanOrEqual(2);
  });

  it("explains a caption whose speech is not in any cut, and drops it", () => {
    const { patches, notes } = completePatches([P({ op: "add_caption", text: "Nobody wants that" })], edl(), CLIPS);
    expect(patches).toEqual([]);
    expect(notes).toEqual(["could not place caption 'Nobody wants that' — no matching speech in the cuts (it is spoken in clip1 at 50.0s, outside the cut)"]);

    const missing = completePatches([P({ op: "add_caption", text: "Buy our thing" })], edl(), CLIPS);
    expect(missing.patches).toEqual([]);
    expect(missing.notes).toEqual(["could not place caption 'Buy our thing' — no matching speech in the cuts"]);
  });

  it("turns an out-of-range set_caption with text into a placed add_caption", () => {
    // The f138d3f5a7 case: index == captions.length.
    const { patches, notes } = completePatches([P({ op: "set_caption", index: 1, text: "Are you just trying to ship faster?" })], edl(), CLIPS);
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({ op: "add_caption", text: "Are you just trying to ship faster?" });
    expect(patches[0].start).toBeCloseTo(2.0, 3);
    expect(notes[0]).toBe("set_caption named caption 2, but the cut has 1 caption; adding 'Are you just trying to ship faster?' as a new caption instead");
    expect(notes[1]).toMatch(/^Placed Argon's caption/);
    expect(applyPatches(edl(), patches, CLIPS).skipped).toEqual([]);
  });

  it("keeps a timed out-of-range set_caption's own window when it has one", () => {
    const { patches } = completePatches([P({ op: "set_caption", index: 7, text: "Hello", start: 3, end: 4 })], edl(), CLIPS);
    expect(patches).toEqual([{ op: "add_caption", index: undefined, text: "Hello", start: 3, end: 4 }]);
  });

  it("drops an out-of-range set_caption that only moves the window", () => {
    const { patches, notes } = completePatches([P({ op: "set_caption", index: 7, start: 3, end: 4 })], edl(), CLIPS);
    expect(patches).toEqual([]);
    expect(notes).toEqual(["dropped set_caption: it named caption 8 and the cut has 1 caption, and it carried no new text to add"]);
  });

  it("drops a caption that restates an existing one at the same moment", () => {
    const { patches, notes } = completePatches([P({ op: "add_caption", text: "welcome!", start: 0.2, end: 1.2 })], edl(), CLIPS);
    expect(patches).toEqual([]);
    expect(notes).toEqual(["dropped duplicate caption 'welcome!' — caption 1 ('Welcome' at 0.0–1.0s) already says that"]);
    // Same text somewhere else is fine; different text at the same moment is fine.
    expect(completePatches([P({ op: "add_caption", text: "Welcome", start: 5, end: 6 })], edl(), CLIPS).patches).toHaveLength(1);
    expect(completePatches([P({ op: "add_caption", text: "Goodbye", start: 0.2, end: 1.2 })], edl(), CLIPS).patches).toHaveLength(1);
  });

  it("drops a set_caption that would make two captions say the same thing at once", () => {
    const e = edl();
    e.captions.push({ text: "Hi there", start: 0.1, end: 1.1 });
    const { patches, notes } = completePatches([P({ op: "set_caption", index: 1, text: "Welcome" })], e, CLIPS);
    expect(patches).toEqual([]);
    expect(notes[0]).toMatch(/dropped set_caption on caption 2: 'Welcome' would duplicate caption 1/);
    // An in-range edit that is not a duplicate passes through untouched.
    const ok = P({ op: "set_caption", index: 1, text: "Hi again" });
    expect(completePatches([ok], e, CLIPS)).toEqual({ patches: [ok], notes: [] });
  });

  it("tracks indexes through earlier patches in the same batch", () => {
    // Removing caption 1 first makes index 0 invalid for the following set_caption.
    const { patches, notes } = completePatches(
      [P({ op: "remove_caption", index: 0 }), P({ op: "set_caption", index: 0, start: 1, end: 2 })],
      edl(),
      CLIPS,
    );
    expect(patches).toEqual([{ op: "remove_caption", index: 0 }]);
    expect(notes[0]).toMatch(/dropped set_caption: it named caption 1 and the cut has 0 captions/);
  });

  it("gives plain notes for out-of-range remove_caption, insert_cut and move_cut", () => {
    const { patches, notes } = completePatches(
      [
        P({ op: "remove_caption", index: 4 }),
        P({ op: "insert_cut", clipId: "clip2", srcIn: 10, srcOut: 12, index: 9 }),
        P({ op: "move_cut", cutId: "c1", index: -1 }),
      ],
      edl(),
      CLIPS,
    );
    expect(patches).toEqual([
      { op: "insert_cut", clipId: "clip2", srcIn: 10, srcOut: 12, index: 2 },
      { op: "move_cut", cutId: "c1", index: 0 },
    ]);
    expect(notes).toEqual([
      "dropped remove_caption: it named caption 5, but the cut has 1 caption",
      "insert_cut asked for position 9, which is past the last of the 2 cuts; placed it last instead",
      "move_cut asked for position -1, which is before the first cut; placed it first instead",
    ]);
  });

  it("passes other ops through and never mutates its inputs", () => {
    const e = edl();
    const before = structuredClone(e);
    const ps = [P({ op: "trim", cutId: "c1", srcOut: 30 }), P({ op: "set_title", text: "X" }), P({ op: "set_music", text: "jazz" })];
    const psBefore = structuredClone(ps);
    expect(completePatches(ps, e, CLIPS)).toEqual({ patches: ps, notes: [] });
    expect(e).toEqual(before);
    expect(ps).toEqual(psBefore);
  });

  it("places an untimed add_overlay over its cut, turns an out-of-range set_overlay into an add, and drops bad removes", () => {
    const { patches, notes } = completePatches(
      [
        P({ op: "add_overlay", text: "Builders at work", cutId: "c2" }),
        P({ op: "set_overlay", index: 5, text: "Demo time", start: 1, end: 3 }),
        P({ op: "remove_overlay", index: 9 }),
        P({ op: "add_overlay", text: "No home" }),
      ],
      edl(),
      CLIPS,
    );
    expect(patches.map((p) => p.op)).toEqual(["add_overlay", "add_overlay"]);
    // c1 is 8s long (28–36), so c2 starts at 8.0 on the output timeline and runs 6s.
    expect(patches[0]).toMatchObject({ text: "Builders at work", start: 8, end: 14 });
    expect(patches[1]).toMatchObject({ text: "Demo time" });
    expect(notes.some((n) => n.startsWith("Placed Argon's label 'Builders at work' over c2"))).toBe(true);
    expect(notes.some((n) => n.includes("dropped remove_overlay"))).toBe(true);
    expect(notes.some((n) => n.includes("could not place label 'No home'"))).toBe(true);
    const applied = applyPatches(edl(), patches, CLIPS).edl;
    expect(applied.overlays).toHaveLength(2);
  });

  it("snippet shortens long captions for notes", () => {
    expect(snippet("short")).toBe("'short'");
    expect(snippet("Are you just trying to ship faster than everyone else in the room")).toBe("'Are you just trying to ship faster than…'");
  });
});
