import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MUSIC_GAIN_DB, TITLE_SECONDS } from "../lib/config";
import { applyExtraPatch, isExtraOp } from "../lib/extras";
import { hasAudio, probeDuration } from "../lib/media";
import { EDL_RULES, critiquePrompt, timelineText } from "../lib/prompts";
import { musicGainDb, placeOverlays, renderEdl, renderedDuration } from "../lib/render";
import { EdlDraftSchema, PatchOpSchema, type EDL } from "../lib/schema";
import { makeFixtureClip } from "./fixtures";

let dir: string;
let files: Record<string, string>;

const base = { width: 1280, height: 720, fps: 30 };
const cut = (id: string, clipId: string, srcIn: number, srcOut: number) => ({ id, clipId, srcIn, srcOut, reason: "" });

function hasVideo(f: string): boolean {
  const out = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_type", "-of", "json", f]).toString();
  return JSON.parse(out).streams?.length === 1;
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "overlays_test_"));
  files = {
    clip1: await makeFixtureClip(dir, "c1.mp4", { seconds: 3, audio: true }),
    clip2: await makeFixtureClip(dir, "c2.mp4", { seconds: 3, audio: false, width: 480, height: 640 }),
  };
}, 60_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("schema", () => {
  it("defaults overlays to [] and position to lower-third; audio and endTitle are optional", () => {
    const d = EdlDraftSchema.parse({ cuts: [cut("c1", "clip1", 0, 1)] });
    expect(d.overlays).toEqual([]);
    expect(d.endTitle).toBeUndefined();
    expect(d.audio).toBeUndefined();
    const o = EdlDraftSchema.parse({
      cuts: [cut("c1", "clip1", 0, 1)],
      overlays: [{ text: "Step 1", start: 0, end: 2 }],
      endTitle: "Built with Argon",
      audio: { musicGainDb: -12 },
    });
    expect(o.overlays[0].position).toBe("lower-third");
    expect(o.audio).toEqual({ denoise: false, musicGainDb: -12 });
  });
  it("accepts the five extra ops with their fields", () => {
    expect(PatchOpSchema.parse({ op: "add_overlay", text: "x", start: 0, end: 1, position: "top" }).position).toBe("top");
    expect(PatchOpSchema.parse({ op: "set_audio", denoise: true, gainDb: -12 })).toMatchObject({ denoise: true, gainDb: -12 });
    for (const op of ["set_overlay", "remove_overlay", "set_end_title"]) expect(PatchOpSchema.parse({ op }).op).toBe(op);
    expect(() => PatchOpSchema.parse({ op: "add_overlay", position: "sideways" })).toThrow();
  });
});

describe("applyExtraPatch", () => {
  const edl: EDL = { ...base, title: "", cuts: [cut("c1", "clip1", 0, 2)], captions: [], overlays: [] };

  it("returns null for ops it does not own and never mutates", () => {
    expect(applyExtraPatch(edl, { op: "set_title", text: "x" })).toBeNull();
    expect(isExtraOp("set_music")).toBe(false);
    expect(isExtraOp("set_audio")).toBe(true);
    const before = structuredClone(edl);
    applyExtraPatch(edl, { op: "add_overlay", text: "a", start: 0, end: 1 });
    expect(edl).toEqual(before);
  });

  it("adds, edits, sorts and removes overlays", () => {
    let e = applyExtraPatch(edl, { op: "add_overlay", text: "Second", start: 1, end: 2, position: "center" })!;
    e = applyExtraPatch(e, { op: "add_overlay", text: "First", start: 0, end: 0.8 })!;
    expect(e.overlays.map((o) => o.text)).toEqual(["First", "Second"]);
    expect(e.overlays[0].position).toBe("lower-third");
    e = applyExtraPatch(e, { op: "set_overlay", index: 1, text: "Second edited", end: 2.5 })!;
    expect(e.overlays[1]).toEqual({ text: "Second edited", start: 1, end: 2.5, position: "center" });
    e = applyExtraPatch(e, { op: "remove_overlay", index: 0 })!;
    expect(e.overlays).toHaveLength(1);
    expect(() => applyExtraPatch(e, { op: "remove_overlay", index: 5 })).toThrow(/out of range/);
    expect(() => applyExtraPatch(e, { op: "add_overlay", text: "", start: 0, end: 1 })).toThrow(/needs text/);
    expect(() => applyExtraPatch(e, { op: "add_overlay", text: "x", start: 2, end: 1 })).toThrow(/start < end/);
  });

  it("sets and clears the end title, dropping a stale endImage", () => {
    const withCard = applyExtraPatch({ ...edl, endTitle: "Old", endImage: "end.png" }, { op: "set_end_title", text: "New line" })!;
    expect(withCard.endTitle).toBe("New line");
    expect(withCard.endImage).toBeUndefined();
    const same = applyExtraPatch({ ...edl, endTitle: "Old", endImage: "end.png" }, { op: "set_end_title", text: "Old" })!;
    expect(same.endImage).toBe("end.png");
    const cleared = applyExtraPatch(withCard, { op: "set_end_title", text: "" })!;
    expect(cleared.endTitle).toBeUndefined();
    expect("endTitle" in cleared).toBe(false);
  });

  it("set_audio merges denoise and a clamped music gain", () => {
    const a = applyExtraPatch(edl, { op: "set_audio", denoise: true })!;
    expect(a.audio).toEqual({ denoise: true });
    const b = applyExtraPatch(a, { op: "set_audio", gainDb: -12 })!;
    expect(b.audio).toEqual({ denoise: true, musicGainDb: -12 });
    expect(applyExtraPatch(b, { op: "set_audio", gainDb: 5 })!.audio?.musicGainDb).toBe(0);
    expect(musicGainDb(b)).toBe(-12);
    expect(musicGainDb({ music: { prompt: "p", gainDb: -20 } })).toBe(-20);
    expect(musicGainDb({})).toBe(MUSIC_GAIN_DB);
    expect(MUSIC_GAIN_DB).toBe(-15);
  });
});

describe("placeOverlays", () => {
  it("lifts a lower-third to top only while a caption is on screen", () => {
    const captions = [{ text: "hi", start: 1, end: 2 }];
    const placed = placeOverlays(
      [
        { text: "a", start: 0, end: 0.9, position: "lower-third" },
        { text: "b", start: 1.5, end: 3, position: "lower-third" },
        { text: "c", start: 1.5, end: 3, position: "center" },
      ],
      captions,
    );
    expect(placed.map((o) => o.position)).toEqual(["lower-third", "top", "center"]);
  });
});

describe("renderEdl with extras", () => {
  it("renders overlays in all three positions alongside a caption; duration unchanged", async () => {
    const edl: EDL = {
      ...base,
      title: "",
      cuts: [cut("c1", "clip1", 0, 1.5), cut("c2", "clip2", 0, 1)],
      captions: [{ text: "spoken words", start: 0.2, end: 1 }],
      overlays: [
        { text: `Step 1: it's "live", 100%`, start: 0, end: 1.2, position: "lower-third" },
        { text: "Top label", start: 0.5, end: 2, position: "top" },
        { text: "CHAPTER TWO", start: 1.5, end: 2.5, position: "center" },
      ],
    };
    const out = path.join(dir, "overlays.mp4");
    await renderEdl(edl, files, out);
    expect(Math.abs((await probeDuration(out)) - 2.5)).toBeLessThan(0.2);
    expect(hasVideo(out)).toBe(true);
    expect(await hasAudio(out)).toBe(true);
  }, 120_000);

  it("appends a closing card worth TITLE_SECONDS, with a black or image backdrop", async () => {
    const edl: EDL = { ...base, title: "Open", endTitle: "Built with Argon & Nano Banana: 100%", cuts: [cut("c1", "clip1", 0, 1)], captions: [], overlays: [] };
    expect(renderedDuration(edl)).toBeCloseTo(2 * TITLE_SECONDS + 1, 5);
    const out = path.join(dir, "endcard.mp4");
    await renderEdl(edl, files, out);
    expect(Math.abs((await probeDuration(out)) - (2 * TITLE_SECONDS + 1))).toBeLessThan(0.2);

    const png = path.join(dir, "end.png");
    execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=0x224466:s=1280x720", "-frames:v", "1", png]);
    const out2 = path.join(dir, "endcard_img.mp4");
    await renderEdl({ ...edl, title: "" }, files, out2, { endImage: png });
    expect(Math.abs((await probeDuration(out2)) - (TITLE_SECONDS + 1))).toBeLessThan(0.2);
    expect(hasVideo(out2)).toBe(true);
  }, 120_000);

  it("denoise path renders with and without a music bed, honouring audio.musicGainDb", async () => {
    const music = path.join(dir, "bed.mp3");
    execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-t", "1", "-i", "sine=frequency=220:sample_rate=44100", "-c:a", "libmp3lame", music]);
    const edl: EDL = {
      ...base,
      title: "",
      cuts: [cut("c1", "clip1", 0, 2), cut("c2", "clip2", 0, 1)],
      captions: [],
      overlays: [],
      audio: { denoise: true, musicGainDb: -10 },
    };
    const dry = path.join(dir, "denoise.mp4");
    await renderEdl(edl, files, dry);
    expect(Math.abs((await probeDuration(dry)) - 3)).toBeLessThan(0.2);
    expect(await hasAudio(dry)).toBe(true);

    const wet = path.join(dir, "denoise_music.mp4");
    await renderEdl({ ...edl, music: { prompt: "p", file: "music.mp3" } }, files, wet, { music });
    expect(Math.abs((await probeDuration(wet)) - 3)).toBeLessThan(0.2);
    // clip2 is silent; with the bed the tail carries signal
    const stats = spawnSync("ffmpeg", ["-v", "info", "-ss", "2.2", "-t", "0.6", "-i", wet, "-af", "volumedetect", "-f", "null", "-"]).stderr.toString();
    const mean = Number(/mean_volume:\s*(-?[\d.]+) dB/.exec(stats)?.[1]);
    expect(mean).toBeGreaterThan(-60);
  }, 120_000);
});

describe("prompts know the extras", () => {
  const clips = [{ clip: { id: "clip1", path: "a.mp4", duration: 10, transcript: [] } }];
  it("EDL_RULES documents overlays, endTitle and audio", () => {
    expect(EDL_RULES).toContain('"overlays"');
    expect(EDL_RULES).toContain('"endTitle"');
    expect(EDL_RULES).toContain('"audio"');
    expect(EDL_RULES).toMatch(/denoise/);
  });
  it("critique lists the new ops and routes notes to them", () => {
    const edl: EDL = { ...base, title: "", cuts: [cut("c1", "clip1", 0, 2)], captions: [], overlays: [] };
    const p = critiquePrompt("brief", edl, clips);
    for (const op of ["add_overlay", "set_overlay", "remove_overlay", "set_end_title", "set_audio"]) expect(p).toContain(op);
    expect(p).toMatch(/NEVER put such text in captions/);
    expect(p).toMatch(/gainDb/);
  });
  it("timelineText shows the closing card, overlays and audio", () => {
    const edl: EDL = {
      ...base,
      title: "",
      cuts: [cut("c1", "clip1", 0, 2)],
      captions: [],
      overlays: [{ text: "Label", start: 0.5, end: 1.5, position: "top" }],
      endTitle: "Bye",
      audio: { denoise: true, musicGainDb: -12 },
    };
    const t = timelineText(edl);
    expect(t).toContain(`closing card 'Bye': 2.00-${(2 + TITLE_SECONDS).toFixed(2)}`);
    expect(t).toContain(`total duration: ${(2 + TITLE_SECONDS).toFixed(2)}s`);
    expect(t).toContain('overlay[0] 0.50-1.50 (top): "Label"');
    expect(t).toContain("audio: denoise on, music -12dB");
  });
});
