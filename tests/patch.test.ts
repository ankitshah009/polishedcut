import { describe, expect, it } from "vitest";
import { applyPatches, timeline } from "../lib/patch";
import type { EDL, PatchOp, SourceClip } from "../lib/schema";

const CLIPS: Record<string, SourceClip> = {
  a: { id: "a", path: "a.mp4", duration: 10, transcript: [] },
  b: { id: "b", path: "b.mp4", duration: 5, transcript: [] },
};

function edl(): EDL {
  return {
    title: "T",
    width: 1280,
    height: 720,
    fps: 30,
    cuts: [
      { id: "c1", clipId: "a", srcIn: 0, srcOut: 2, reason: "" },
      { id: "c2", clipId: "b", srcIn: 1, srcOut: 3, reason: "" },
    ],
    captions: [{ text: "x", start: 2, end: 3 }],
    overlays: [],
  };
}

const P = (p: Partial<PatchOp> & { op: PatchOp["op"] }) => p as PatchOp;
const ids = (e: EDL) => e.cuts.map((c) => c.id);

describe("applyPatches", () => {
  it("trim clamps to clip bounds", () => {
    const { edl: e } = applyPatches(edl(), [P({ op: "trim", cutId: "c2", srcIn: -1, srcOut: 99 })], CLIPS);
    expect([e.cuts[1].srcIn, e.cuts[1].srcOut]).toEqual([0, 5]);
  });

  it("drops cuts that become too short", () => {
    const { edl: e, skipped } = applyPatches(edl(), [P({ op: "trim", cutId: "c1", srcOut: 0.1 })], CLIPS);
    expect(ids(e)).toEqual(["c2"]);
    expect(skipped.some((s) => s.includes("c1"))).toBe(true);
  });

  it("remove_cut does not mutate input", () => {
    const orig = edl();
    const patches = [P({ op: "remove_cut", cutId: "c1" })];
    const patchesCopy = structuredClone(patches);
    const { edl: e } = applyPatches(orig, patches, CLIPS);
    expect(ids(e)).toEqual(["c2"]);
    expect(orig).toEqual(edl());
    expect(patches).toEqual(patchesCopy);
  });

  it("insert_cut", () => {
    const { edl: e } = applyPatches(edl(), [P({ op: "insert_cut", clipId: "a", srcIn: 4, srcOut: 6, index: 1 })], CLIPS);
    expect(ids(e)).toEqual(["c1", "c3", "c2"]);
  });

  it("move_cut", () => {
    const { edl: e } = applyPatches(edl(), [P({ op: "move_cut", cutId: "c2", index: 0 })], CLIPS);
    expect(ids(e)).toEqual(["c2", "c1"]);
  });

  it("captions set/add/remove", () => {
    let { edl: e } = applyPatches(
      edl(),
      [P({ op: "set_caption", index: 0, text: "y" }), P({ op: "add_caption", text: "z", start: 0.5, end: 1 })],
      CLIPS,
    );
    expect(e.captions.map((c) => c.text)).toEqual(["z", "y"]);
    ({ edl: e } = applyPatches(e, [P({ op: "remove_caption", index: 0 })], CLIPS));
    expect(e.captions.map((c) => c.text)).toEqual(["y"]);
  });

  it("set_music sets, keeps, replaces and removes the bed", () => {
    const withMusic = applyPatches(edl(), [P({ op: "set_music", text: " calm piano " })], CLIPS).edl;
    expect(withMusic.music).toEqual({ prompt: "calm piano" });

    // Same prompt again: the generated file stays valid, nothing changes.
    const same: EDL = { ...withMusic, music: { prompt: "calm piano", gainDb: -12, file: "music/bed.mp3" } };
    expect(applyPatches(same, [P({ op: "set_music", text: "calm piano" })], CLIPS).edl.music).toEqual(same.music);

    // New prompt: keep the gain, drop the stale file so it is generated again.
    expect(applyPatches(same, [P({ op: "set_music", text: "upbeat synth" })], CLIPS).edl.music).toEqual({
      prompt: "upbeat synth",
      gainDb: -12,
    });

    // Empty text removes the bed.
    expect(applyPatches(same, [P({ op: "set_music", text: "" })], CLIPS).edl.music).toBeNull();
    expect(applyPatches(same, [P({ op: "set_music" })], CLIPS).edl.music).toBeNull();
  });

  it("set_title", () => {
    expect(applyPatches(edl(), [P({ op: "set_title", text: "New" })], CLIPS).edl.title).toBe("New");
  });

  it("hands the overlay, end-title and audio ops to lib/extras.ts, in sequence with its own", () => {
    const { edl: e, skipped } = applyPatches(
      edl(),
      [
        P({ op: "add_overlay", text: "Day one", start: 2, end: 4 }),
        P({ op: "add_overlay", text: "Day two", start: 4, end: 6, position: "top" }),
        P({ op: "set_overlay", index: 0, text: "Day 1" }),
        P({ op: "remove_overlay", index: 1 }),
        P({ op: "set_end_title", text: "Thanks for watching" }),
        P({ op: "set_audio", denoise: true, gainDb: -14 }),
        P({ op: "trim", cutId: "c1", srcOut: 1.5 }),
      ],
      CLIPS,
    );
    expect(skipped).toEqual([]);
    expect(e.overlays).toEqual([{ text: "Day 1", start: 2, end: 4, position: "lower-third" }]);
    expect(e.endTitle).toBe("Thanks for watching");
    expect(e.audio).toEqual({ denoise: true, musicGainDb: -14 });
    expect(e.cuts[0].srcOut).toBe(1.5);
    expect(e.captions).toEqual(edl().captions);
  });

  it("a malformed extra op is skipped and rolled back like any other", () => {
    const { edl: e, skipped } = applyPatches(
      edl(),
      [P({ op: "add_overlay", text: "x", start: 3, end: 2 }), P({ op: "remove_overlay", index: 0 }), P({ op: "set_end_title", text: "Bye" })],
      CLIPS,
    );
    expect(skipped).toHaveLength(2);
    expect(skipped[0]).toMatch(/skipped add_overlay/);
    expect(skipped[1]).toMatch(/skipped remove_overlay/);
    expect(e.overlays ?? []).toEqual([]);
    expect(e.endTitle).toBe("Bye");
  });

  it("invalid ops are skipped with messages and leave EDL unchanged", () => {
    const orig = edl();
    const { edl: e, skipped } = applyPatches(
      orig,
      [
        P({ op: "remove_cut", cutId: "nope" }),
        P({ op: "set_caption", index: 9, text: "q" }),
        P({ op: "insert_cut", clipId: "zz", srcIn: 0, srcOut: 1 }),
      ],
      CLIPS,
    );
    expect(e).toEqual(edl());
    expect(orig).toEqual(edl());
    expect(skipped).toHaveLength(3);
    for (const s of skipped) expect(s).toMatch(/skip/i);
  });
});

describe("timeline", () => {
  it("offsets by title card", () => {
    expect(timeline(edl())).toEqual([
      { cutId: "c1", start: 2, end: 4 },
      { cutId: "c2", start: 4, end: 6 },
    ]);
  });
});
