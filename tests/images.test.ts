import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { IMAGE_EXT, imageToClip, isImageFile } from "../lib/images";
import { hasAudio, probeDuration } from "../lib/media";

let dir: string;
let png: string;

function probeVideo(file: string): { codec_name: string; width: number; height: number; pix_fmt: string } {
  const out = execFileSync("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=codec_name,width,height,pix_fmt", "-of", "json", file,
  ]).toString();
  return JSON.parse(out).streams[0];
}

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "images_test_"));
  // Portrait 600x900 still, so the 16:9 letterboxing path is exercised.
  png = path.join(dir, "x.png");
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=600x900:rate=1", "-frames:v", "1", png]);
}, 60_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("isImageFile", () => {
  it("accepts phone photo extensions regardless of mime", () => {
    for (const name of ["IMG_0001.HEIC", "IMG_0002.heic", "shot.heif", "a.jpg", "b.JPEG", "c.png", "d.webp"]) {
      expect(isImageFile(name, ""), name).toBe(true);
      expect(IMAGE_EXT.test(name), name).toBe(true);
    }
  });
  it("accepts image/* mime when the name has no useful extension", () => {
    expect(isImageFile("blob", "image/jpeg")).toBe(true);
    expect(isImageFile("upload", "image/heic")).toBe(true);
  });
  it("rejects videos and other files", () => {
    expect(isImageFile("clip.mp4", "video/mp4")).toBe(false);
    expect(isImageFile("clip.mov", "")).toBe(false);
    expect(isImageFile("notes.txt", "text/plain")).toBe(false);
    expect(isImageFile("photo.jpg.bak", "")).toBe(false);
  });
});

describe("imageToClip", () => {
  it("turns a portrait PNG into a 4s 1280x720 h264 clip with a silent audio track", async () => {
    const dst = path.join(dir, "out", "x.mp4");
    await imageToClip(png, dst);
    expect(existsSync(dst)).toBe(true);
    expect(Math.abs((await probeDuration(dst)) - 4)).toBeLessThan(0.2);
    const v = probeVideo(dst);
    expect(v.codec_name).toBe("h264");
    expect(v.width).toBe(1280);
    expect(v.height).toBe(720);
    expect(v.pix_fmt).toBe("yuv420p");
    expect(await hasAudio(dst)).toBe(true);
  }, 90_000);

  it("honours opts.seconds", async () => {
    const dst = path.join(dir, "out", "short.mp4");
    await imageToClip(png, dst, { seconds: 2 });
    expect(Math.abs((await probeDuration(dst)) - 2)).toBeLessThan(0.2);
  }, 90_000);

  it("fails with a tool-named error on a missing input", async () => {
    await expect(imageToClip(path.join(dir, "nope.png"), path.join(dir, "out", "nope.mp4"))).rejects.toThrow(/ffmpeg failed \(exit/);
  }, 30_000);

  it.skipIf(process.platform !== "darwin")("converts a real HEIC (via the sips fallback when ffmpeg lacks HEIF)", async () => {
    const heic = path.join(dir, "x.heic");
    execFileSync("sips", ["-s", "format", "heic", png, "--out", heic], { stdio: "ignore" });
    const dst = path.join(dir, "out", "heic.mp4");
    await imageToClip(heic, dst);
    expect(Math.abs((await probeDuration(dst)) - 4)).toBeLessThan(0.2);
    const v = probeVideo(dst);
    expect([v.width, v.height]).toEqual([1280, 720]);
    expect(await hasAudio(dst)).toBe(true);
  }, 90_000);
});
