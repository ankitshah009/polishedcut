import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { extractVideo, generateBroll, generateShot, OMNI_MODEL, shotPrompt, shotRequest, type BrollClient } from "../lib/broll";
import { makeFixtureClip } from "./fixtures";

const execFileAsync = promisify(execFile);

let tmp: string;
let mp4Base64: string;
let fixture: string;

beforeAll(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "broll-test-"));
  // A real 6s 640x360 clip without audio: the normaliser must scale it, add a silent track and trim it.
  fixture = await makeFixtureClip(tmp, "omni.mp4", { seconds: 6, audio: false });
  mp4Base64 = readFileSync(fixture).toString("base64");
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function client(reply: (params: Record<string, unknown>) => Promise<unknown>, files?: BrollClient["files"]) {
  const create = vi.fn(reply);
  const ai = { interactions: { create }, files } as unknown as BrollClient;
  return { ai, create };
}

async function probe(file: string) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,r_frame_rate", "-of", "json", file,
  ]);
  const j = JSON.parse(stdout) as {
    format: { duration: string };
    streams: { codec_type: string; codec_name: string; width?: number; height?: number; r_frame_rate?: string }[];
  };
  const v = j.streams.find((s) => s.codec_type === "video")!;
  const a = j.streams.find((s) => s.codec_type === "audio");
  return { seconds: Number(j.format.duration), width: v.width, height: v.height, fps: v.r_frame_rate, vcodec: v.codec_name, acodec: a?.codec_name };
}

describe("shotRequest", () => {
  it("text-to-video: prompt carries the length, 16:9 720p inline video, no store", () => {
    const r = shotRequest({ prompt: "amber particles", seconds: 4 });
    expect(r.model).toBe(OMNI_MODEL);
    expect(r.store).toBe(false);
    expect(r.input).toBe(shotPrompt("amber particles", 4));
    expect(String(r.input)).toMatch(/4 second shot/);
    expect(r.response_format).toEqual({ type: "video", aspect_ratio: "16:9", resolution: "720p", delivery: "inline", duration: "4s" });
    expect(shotRequest({ prompt: "x", seconds: 4 }, undefined, false).response_format).not.toHaveProperty("duration");
  });

  it("image-to-video: keyframe first, then the text, with the image_to_video task", () => {
    const r = shotRequest({ prompt: "city at dawn", seconds: 3 }, { data: "aGk=", mimeType: "image/png" });
    expect(r.input).toEqual([
      { type: "image", data: "aGk=", mime_type: "image/png" },
      { type: "text", text: expect.stringMatching(/^Animate this image as the first frame\. city at dawn/) },
    ]);
    expect(r.generation_config).toEqual({ video_config: { task: "image_to_video" } });
  });

  it("clamps the length to 2..8s", () => {
    expect(shotPrompt("x", 20)).toMatch(/8 second shot/);
    expect(shotPrompt("x", 0.5)).toMatch(/2 second shot/);
  });
});

describe("extractVideo", () => {
  it("reads output_video, then steps[] model_output video blocks, inline or uri", () => {
    const inline = extractVideo({ output_video: { type: "video", data: "aGk=", mime_type: "video/mp4" } });
    expect(inline?.data?.toString()).toBe("hi");
    expect(inline?.mimeType).toBe("video/mp4");
    const uri = extractVideo({ steps: [{ type: "model_output", content: [{ type: "text", text: "..." }, { type: "video", uri: "https://x/files/abc" }] }] });
    expect(uri).toEqual({ uri: "https://x/files/abc", mimeType: "video/mp4" });
    expect(extractVideo({ output_text: "nope" })).toBeNull();
  });
});

describe("generateShot", () => {
  it("decodes the inline mp4 and normalises it to 1280x720 30fps h264+aac trimmed to seconds", async () => {
    const { ai, create } = client(async () => ({ status: "completed", output_video: { type: "video", data: mp4Base64, mime_type: "video/mp4" } }));
    const out = path.join(tmp, "run", "generated", "g1.mp4");
    const r = await generateShot({ prompt: "amber particles on black", seconds: 4, outFile: out }, ai);
    expect(r).toEqual({ file: out, seconds: expect.any(Number), model: OMNI_MODEL });
    expect(existsSync(`${out}.raw.mp4`)).toBe(false);
    const p = await probe(out);
    expect(p).toMatchObject({ width: 1280, height: 720, fps: "30/1", vcodec: "h264", acodec: "aac" });
    expect(p.seconds).toBeCloseTo(4, 0);
    expect(r.seconds).toBeCloseTo(p.seconds, 2);
    expect(create).toHaveBeenCalledTimes(1);
    expect((create.mock.calls[0][0] as Record<string, unknown>).model).toBe(OMNI_MODEL);
  });

  it("sends the keyframe as an image part when one is given", async () => {
    const png = path.join(tmp, "key.png");
    await execFileAsync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=navy:s=320x180", "-frames:v", "1", png]);
    const { ai, create } = client(async () => ({ output_video: { data: mp4Base64 } }));
    await generateShot({ prompt: "p", seconds: 2, keyframe: png, outFile: path.join(tmp, "k.mp4") }, ai);
    const input = (create.mock.calls[0][0] as { input: Array<{ type: string; data?: string; mime_type?: string }> }).input;
    expect(input[0]).toEqual({ type: "image", data: readFileSync(png).toString("base64"), mime_type: "image/png" });
  });

  it("retries without the duration hint when the server rejects it", async () => {
    let calls = 0;
    const { ai, create } = client(async (params) => {
      calls++;
      if ((params.response_format as { duration?: string }).duration) throw Object.assign(new Error("Unknown name \"duration\""), { status: 400 });
      return { output_video: { data: mp4Base64 } };
    });
    await generateShot({ prompt: "p", seconds: 3, outFile: path.join(tmp, "d.mp4") }, ai);
    expect(calls).toBe(2);
    expect((create.mock.calls[1][0] as { response_format: object }).response_format).not.toHaveProperty("duration");
  });

  it("polls an in-progress interaction, then downloads a uri-delivered file once ACTIVE", { timeout: 30_000 }, async () => {
    {
      const get = vi.fn()
        .mockResolvedValueOnce({ id: "i1", status: "in_progress" })
        .mockResolvedValueOnce({ id: "i1", status: "completed", output_video: { type: "video", uri: "https://generativelanguage.googleapis.com/v1beta/files/abc123" } });
      const filesGet = vi.fn().mockResolvedValueOnce({ state: { name: "PROCESSING" } }).mockResolvedValueOnce({ state: "ACTIVE" });
      const download = vi.fn(async ({ downloadPath }: { file: string; downloadPath: string }) => { copyFileSync(fixture, downloadPath); });
      const ai = { interactions: { create: async () => ({ id: "i1", status: "queued" }), get }, files: { get: filesGet, download } } as unknown as BrollClient;
      const out = path.join(tmp, "uri.mp4");
      const r = await generateShot({ prompt: "p", seconds: 2, outFile: out }, ai);
      expect(r.seconds).toBeCloseTo(2, 0);
      expect(get).toHaveBeenCalledWith({ id: "i1" });
      expect(filesGet).toHaveBeenCalledWith({ name: "files/abc123" });
      expect(download).toHaveBeenCalledWith({ file: "files/abc123", downloadPath: `${out}.raw.mp4` });
    }
  });

  it("throws when the model returns no video or the interaction failed", async () => {
    const none = client(async () => ({ output_text: "sorry" }));
    await expect(generateShot({ prompt: "p", seconds: 2, outFile: path.join(tmp, "n.mp4") }, none.ai)).rejects.toThrow(/no video/);
    const failed = client(async () => ({ id: "x", status: "failed", error: { message: "safety" } }));
    await expect(generateShot({ prompt: "p", seconds: 2, outFile: path.join(tmp, "f.mp4") }, failed.ai)).rejects.toThrow(/failed: safety/);
    await expect(generateShot({ prompt: "  ", seconds: 2, outFile: path.join(tmp, "e.mp4") }, none.ai)).rejects.toThrow(/empty prompt/);
  });
});

describe("generateBroll", () => {
  it("paints a keyframe first and animates it; a failed still falls back to text-to-video", async () => {
    const still = vi.fn(async (_p: string, file: string) => file);
    const shot = vi.fn(async (o: { keyframe?: string; outFile: string }) => ({ file: o.outFile, seconds: 3, model: "fake" }));
    const out = "/r/generated/g1.mp4";
    await generateBroll({ prompt: "p", seconds: 3, outFile: out }, { still, shot });
    expect(still).toHaveBeenCalledWith(expect.stringMatching(/^p First frame/), "/r/generated/g1.png");
    expect(shot.mock.calls[0][0].keyframe).toBe("/r/generated/g1.png");

    still.mockRejectedValueOnce(new Error("banana down"));
    await generateBroll({ prompt: "p", seconds: 3, outFile: out }, { still, shot });
    expect(shot.mock.calls[1][0].keyframe).toBeUndefined();
  });
});
