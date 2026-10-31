import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OUTPUT, PROXY_LONG_EDGE } from "../lib/config";
import { chooseOutput, displaySize, hasAudio, makeProxy, orientationOf, probeDuration, probeMedia } from "../lib/media";
import { makeFixtureClip } from "./fixtures";

let dir: string;
let withAudio: string; // 1280x720 landscape
let noAudio: string; // 640x360, silent
let portrait: string; // 1080x1920 phone vertical
let tenBit: string; // 639x361 yuv444p10le HEVC in mkv, 24 fps, odd size, silent
let rotated: string; // 1280x720 frames with a 90 degree display matrix (plays as 720x1280)

function probeVideo(file: string): { width: number; height: number; pix_fmt: string; codec_name: string; r_frame_rate: string } {
  const out = execFileSync("ffprobe", [
    "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,pix_fmt,codec_name,r_frame_rate", "-of", "json", file,
  ]).toString();
  return JSON.parse(out).streams[0];
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "media_test_"));
  [withAudio, noAudio, portrait, tenBit, rotated] = await Promise.all([
    makeFixtureClip(dir, "a.mp4", { seconds: 2, audio: true, width: 1280, height: 720 }),
    makeFixtureClip(dir, "b.mp4", { seconds: 2, audio: false }),
    makeFixtureClip(dir, "p.mp4", { seconds: 2, audio: true, width: 1080, height: 1920 }),
    makeFixtureClip(dir, "t.mkv", { seconds: 2, audio: false, width: 639, height: 361, fps: 24, pixFmt: "yuv444p10le", codec: "libx265", source: "testsrc" }),
    makeFixtureClip(dir, "r.mp4", { seconds: 2, audio: true, width: 1280, height: 720, rotation: 90 }),
  ]);
}, 120_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("probeMedia", () => {
  it("returns duration, size, fps, audio, codec and pixel format in one call", async () => {
    const info = await probeMedia(withAudio);
    expect(Math.abs(info.duration - 2)).toBeLessThan(0.2);
    expect(info).toMatchObject({ width: 1280, height: 720, rotation: 0, fps: 30, hasAudio: true, codec: "h264", pixFmt: "yuv420p" });
  });
  it("sees 10-bit odd-sized 24fps HEVC in mkv and the missing audio track", async () => {
    const info = await probeMedia(tenBit);
    expect(info).toMatchObject({ width: 639, height: 361, fps: 24, hasAudio: false, codec: "hevc", pixFmt: "yuv444p10le" });
  });
  it("reads the display rotation and displaySize swaps the edges", async () => {
    const info = await probeMedia(rotated);
    expect(info.rotation).toBe(90);
    expect(info.width).toBe(1280);
    expect(displaySize(info)).toEqual({ width: 720, height: 1280 });
    expect(orientationOf(info)).toBe("portrait");
    expect(displaySize({ width: 1280, height: 720, rotation: 180 })).toEqual({ width: 1280, height: 720 });
    expect(displaySize({ width: 1280, height: 720, rotation: 270 })).toEqual({ width: 720, height: 1280 });
  });
  it("probes a still image (no duration, no audio)", async () => {
    const png = path.join(dir, "x.png");
    execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=600x900:rate=1", "-frames:v", "1", png]);
    const info = await probeMedia(png);
    expect(info).toMatchObject({ width: 600, height: 900, duration: 0, hasAudio: false, codec: "png" });
    expect(orientationOf(info)).toBe("portrait");
  });
  it("probeDuration / hasAudio stay available", async () => {
    expect(Math.abs((await probeDuration(withAudio)) - 2)).toBeLessThan(0.2);
    expect(await hasAudio(withAudio)).toBe(true);
    expect(await hasAudio(noAudio)).toBe(false);
  });
  it("throws on a missing or non-media file", async () => {
    await expect(probeDuration(path.join(dir, "nope.mp4"))).rejects.toThrow(/ffprobe failed/);
    const txt = path.join(dir, "notes.txt");
    execFileSync("sh", ["-c", `printf 'hello' > "${txt}"`]);
    await expect(probeMedia(txt)).rejects.toThrow(/ffprobe/);
  });
});

describe("chooseOutput", () => {
  const land = { width: 1920, height: 1080, duration: 10 };
  const port = { width: 1080, height: 1920, duration: 10 };
  const sq = { width: 1080, height: 1080, duration: 10 };
  const fps = OUTPUT.fps;

  it("follows the footage: landscape, portrait, square", () => {
    expect(chooseOutput([land])).toEqual({ width: 1920, height: 1080, fps });
    expect(chooseOutput([port])).toEqual({ width: 1080, height: 1920, fps });
    expect(chooseOutput([sq])).toEqual({ width: 1080, height: 1080, fps });
  });
  it("weighs clips by duration, not count, and honours rotation metadata", () => {
    expect(chooseOutput([land, { ...port, duration: 3 }, { ...port, duration: 3 }]).height).toBe(1080);
    expect(chooseOutput([{ ...land, duration: 3 }, { ...port, duration: 30 }]).height).toBe(1920);
    expect(chooseOutput([{ width: 1280, height: 720, rotation: 90, duration: 5 }]).height).toBe(1920);
    // unknown durations: one vote each
    expect(chooseOutput([{ width: 1920, height: 1080 }, { width: 1080, height: 1920 }, { width: 1080, height: 1920 }]).height).toBe(1920);
  });
  it("defaults to landscape with nothing to go on, and clips without a size are ignored", () => {
    expect(chooseOutput([])).toEqual({ width: 1920, height: 1080, fps });
    expect(chooseOutput([{ width: 0, height: 0 }])).toEqual({ width: 1920, height: 1080, fps });
    expect(chooseOutput([{ width: 0, height: 0 }, port])).toEqual({ width: 1080, height: 1920, fps });
  });
  it("the brief can force the shape and ask for 4K", () => {
    expect(chooseOutput([land], "cut a vertical for Reels")).toEqual({ width: 1080, height: 1920, fps });
    expect(chooseOutput([land], "9:16 please")).toEqual({ width: 1080, height: 1920, fps });
    expect(chooseOutput([land], "a 1:1 square for the feed")).toEqual({ width: 1080, height: 1080, fps });
    expect(chooseOutput([port], "landscape 16:9 for YouTube")).toEqual({ width: 1920, height: 1080, fps });
    expect(chooseOutput([land], "deliver in 4K")).toEqual({ width: 3840, height: 2160, fps });
    expect(chooseOutput([land], "a vertical in 4K")).toEqual({ width: 2160, height: 3840, fps });
    expect(chooseOutput([sq], "UHD")).toEqual({ width: 1080, height: 1080, fps });
    // no false positives on ordinary words
    expect(chooseOutput([land], "a 30-second story about the launch").height).toBe(1920);
    expect(chooseOutput([land], "show the shorts they sell").height).toBe(1920);
    expect(chooseOutput([land], "keep the 4 kids in the frame").width).toBe(1920);
  });
});

describe("makeProxy", () => {
  it(`scales the long edge to PROXY_LONG_EDGE (${PROXY_LONG_EDGE}) and keeps audio`, async () => {
    const dst = path.join(dir, "proxy", "p.mp4");
    await makeProxy(withAudio, dst);
    expect(probeVideo(dst)).toMatchObject({ width: PROXY_LONG_EDGE, height: 480, pix_fmt: "yuv420p", codec_name: "h264" });
    expect(await hasAudio(dst)).toBe(true);
  }, 60_000);

  it("keeps a portrait clip portrait (1080x1920 -> 480x854)", async () => {
    const dst = path.join(dir, "proxy", "portrait.mp4");
    await makeProxy(portrait, dst, 854);
    expect(probeVideo(dst)).toMatchObject({ width: 480, height: 854 });
    expect(orientationOf(await probeMedia(dst))).toBe("portrait");
  }, 60_000);

  it("honours rotation metadata: rotated landscape frames come out as an upright portrait proxy", async () => {
    const dst = path.join(dir, "proxy", "rotated.mp4");
    await makeProxy(rotated, dst, 854);
    const info = await probeMedia(dst);
    expect(info).toMatchObject({ width: 480, height: 854, rotation: 0 });
  }, 60_000);

  it("gives a silent stereo track to a clip without audio", async () => {
    const dst = path.join(dir, "proxy", "silent.mp4");
    await makeProxy(noAudio, dst, 320);
    const info = await probeMedia(dst);
    expect(info.hasAudio).toBe(true);
    expect(Math.abs(info.duration - 2)).toBeLessThan(0.25);
    expect(probeVideo(dst)).toMatchObject({ width: 320, height: 180 });
  }, 60_000);

  it("turns 10-bit odd-sized 24fps HEVC/mkv into an even 8-bit h264 30fps proxy without upscaling", async () => {
    const dst = path.join(dir, "proxy", "tenbit.mp4");
    await makeProxy(tenBit, dst, 854);
    const v = probeVideo(dst);
    expect(v).toMatchObject({ codec_name: "h264", pix_fmt: "yuv420p", r_frame_rate: "30/1" });
    expect(v.width).toBeLessThanOrEqual(639);
    expect(v.width % 2).toBe(0);
    expect(v.height % 2).toBe(0);
    expect(await hasAudio(dst)).toBe(true);
  }, 60_000);

  it("rejects a bad long edge and a file with no video", async () => {
    await expect(makeProxy(withAudio, path.join(dir, "z.mp4"), 7)).rejects.toThrow(/long edge/);
    const wav = path.join(dir, "a.wav");
    execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-t", "1", "-i", "sine=frequency=440", wav]);
    await expect(makeProxy(wav, path.join(dir, "z.mp4"))).rejects.toThrow(/no video stream/);
  });
});
