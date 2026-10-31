import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TITLE_SECONDS } from "../lib/config";
import { hasAudio, probeDuration } from "../lib/media";
import { renderEdl } from "../lib/render";
import type { EDL } from "../lib/schema";
import { makeFixtureClip } from "./fixtures";

let dir: string;
let files: Record<string, string>;

function dims(f: string) {
  const out = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", f]).toString();
  return JSON.parse(out).streams[0] as { width: number; height: number };
}
const base = { width: 1280, height: 720, fps: 30, overlays: [] };

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "render_test_"));
  files = {
    clip1: await makeFixtureClip(dir, "c1.mp4", { seconds: 3, audio: true }),
    clip2: await makeFixtureClip(dir, "c2.mp4", { seconds: 3, audio: false, width: 480, height: 640 }),
  };
}, 60_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("renderEdl", () => {
  it("titled 2-cut EDL with tricky captions", async () => {
    const edl: EDL = {
      ...base,
      title: `It's "Demo": one, two`,
      cuts: [
        { id: "c1", clipId: "clip1", srcIn: 0.5, srcOut: 1.5, reason: "" },
        { id: "c2", clipId: "clip2", srcIn: 0, srcOut: 1.5, reason: "" },
      ],
      captions: [
        { text: `He said "hi": yes, it's 5:00 [ok] \\ 100%`, start: 0.2, end: 1.5 },
        { text: "a,b;c:d='e'", start: 2, end: 3 },
      ],
    };
    const out = path.join(dir, "out", "titled.mp4");
    await renderEdl(edl, files, out);
    const expected = TITLE_SECONDS + 2.5;
    expect(Math.abs((await probeDuration(out)) - expected)).toBeLessThan(0.2);
    expect(dims(out)).toEqual({ width: 1280, height: 720 });
    expect(await hasAudio(out)).toBe(true);
  }, 120_000);

  it("untitled clip without audio", async () => {
    const edl: EDL = { ...base, title: "", cuts: [{ id: "c1", clipId: "clip2", srcIn: 0, srcOut: 1, reason: "" }], captions: [] };
    const out = path.join(dir, "noaudio.mp4");
    await renderEdl(edl, files, out);
    expect(Math.abs((await probeDuration(out)) - 1)).toBeLessThan(0.2);
    expect(await hasAudio(out)).toBe(true);
  }, 120_000);

  it("mixes a looped music bed under the program audio", async () => {
    const music = path.join(dir, "bed.mp3");
    execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-t", "1", "-i", "sine=frequency=220:sample_rate=44100", "-c:a", "libmp3lame", music]);
    const edl: EDL = {
      ...base,
      title: "Scored",
      cuts: [
        { id: "c1", clipId: "clip1", srcIn: 0, srcOut: 2, reason: "" },
        { id: "c2", clipId: "clip2", srcIn: 0, srcOut: 1.5, reason: "" },
      ],
      captions: [{ text: "hi", start: 2.5, end: 3.5 }],
      music: { prompt: "soft piano", file: "music.mp3" },
    };
    const out = path.join(dir, "scored.mp4");
    await renderEdl(edl, files, out, { music });
    const expected = TITLE_SECONDS + 3.5;
    expect(Math.abs((await probeDuration(out)) - expected)).toBeLessThan(0.2);
    expect(dims(out)).toEqual({ width: 1280, height: 720 });
    expect(await hasAudio(out)).toBe(true);
    // the title card is silent without music; with the bed it carries signal
    const stats = spawnSync("ffmpeg", ["-v", "info", "-t", "1.5", "-i", out, "-af", "volumedetect", "-f", "null", "-"]).stderr.toString();
    const mean = Number(/mean_volume:\s*(-?[\d.]+) dB/.exec(stats)?.[1]);
    expect(mean).toBeGreaterThan(-60);
  }, 120_000);

  it("renders without music when the file is missing", async () => {
    const edl: EDL = { ...base, title: "", cuts: [{ id: "c1", clipId: "clip1", srcIn: 0, srcOut: 1, reason: "" }], captions: [], music: { prompt: "x", file: "music.mp3" } };
    const out = path.join(dir, "nomusic.mp4");
    await renderEdl(edl, files, out, { music: path.join(dir, "does-not-exist.mp3") });
    expect(Math.abs((await probeDuration(out)) - 1)).toBeLessThan(0.2);
  }, 120_000);

  it("renders a portrait EDL at 1080x1920 from mixed landscape and portrait sources", async () => {
    const edl: EDL = {
      width: 1080,
      height: 1920,
      fps: 30,
      overlays: [],
      title: "Vertical",
      cuts: [
        { id: "c1", clipId: "clip2", srcIn: 0, srcOut: 1, reason: "" }, // 480x640 portrait, silent
        { id: "c2", clipId: "clip1", srcIn: 0, srcOut: 1, reason: "" }, // 640x360 landscape, letterboxed
      ],
      captions: [{ text: "upright", start: 0.5, end: 2.5 }],
    };
    const out = path.join(dir, "portrait.mp4");
    await renderEdl(edl, files, out);
    expect(dims(out)).toEqual({ width: 1080, height: 1920 });
    expect(Math.abs((await probeDuration(out)) - (TITLE_SECONDS + 2))).toBeLessThan(0.2);
    expect(await hasAudio(out)).toBe(true);
  }, 120_000);

  it("renders a square EDL and a clip carrying rotation metadata upright", async () => {
    const rotated = await makeFixtureClip(dir, "rot.mp4", { seconds: 2, width: 640, height: 360, rotation: 90 });
    const edl: EDL = { width: 1080, height: 1080, fps: 30, overlays: [], title: "", cuts: [{ id: "c1", clipId: "rot", srcIn: 0, srcOut: 1, reason: "" }], captions: [] };
    const out = path.join(dir, "square.mp4");
    await renderEdl(edl, { ...files, rot: rotated }, out);
    expect(dims(out)).toEqual({ width: 1080, height: 1080 });
  }, 120_000);

  it("rejects an odd or non-positive output size", async () => {
    const cut = [{ id: "c1", clipId: "clip1", srcIn: 0, srcOut: 1, reason: "" }];
    await expect(renderEdl({ ...base, width: 1079, title: "", cuts: cut, captions: [] }, files, path.join(dir, "odd.mp4"))).rejects.toThrow(/even/);
    await expect(renderEdl({ ...base, fps: 0, title: "", cuts: cut, captions: [] }, files, path.join(dir, "fps.mp4"))).rejects.toThrow(/fps/);
  });

  it("unknown clip id throws", async () => {
    const edl: EDL = { ...base, title: "", cuts: [{ id: "c1", clipId: "zzz", srcIn: 0, srcOut: 1, reason: "" }], captions: [] };
    await expect(renderEdl(edl, files, path.join(dir, "x.mp4"))).rejects.toThrow(/unknown clip/);
  });

  it("no cuts throws", async () => {
    await expect(renderEdl({ ...base, title: "t", cuts: [], captions: [] }, files, path.join(dir, "y.mp4"))).rejects.toThrow(/no cuts/);
  });
});
