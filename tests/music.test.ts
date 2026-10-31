import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { probeDuration } from "../lib/media";
import { applyMusicPatch, generateMusic, loopAudio, LYRIA_MODELS, musicRequest, type MusicClient } from "../lib/music";
import type { EDL, PatchOp } from "../lib/schema";

let dir: string;
let tone: string; // 2s mp3

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "music_test_"));
  tone = path.join(dir, "tone.mp3");
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-t", "2", "-i", "sine=frequency=330:sample_rate=44100", "-c:a", "libmp3lame", tone]);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Fake Lyria: records the request and returns the fixture mp3 as base64. */
function fakeClient(calls: unknown[]): MusicClient {
  return {
    interactions: {
      async create(params: unknown) {
        calls.push(params);
        return { output_audio: { type: "audio", data: readFileSync(tone).toString("base64"), mime_type: "audio/mp3" } };
      },
    },
  } as MusicClient;
}

describe("musicRequest", () => {
  it("uses the 30s clip model for short beds and forbids vocals", () => {
    const r = musicRequest("warm lo-fi piano", 20);
    expect(r.model).toBe(LYRIA_MODELS.clip);
    expect(r.input).toContain("warm lo-fi piano");
    expect(r.input).toContain("Instrumental only, no vocals.");
    expect(r.input).not.toMatch(/seconds long/);
  });
  it("uses lyria-3.5 with the length in the prompt for long beds", () => {
    const r = musicRequest("driving synthwave", 45.2);
    expect(r.model).toBe(LYRIA_MODELS.song);
    expect(r.input).toContain("about 46 seconds");
    expect(r.input).toContain("Instrumental only, no vocals.");
  });
});

describe("loopAudio", () => {
  it("extends a short clip to at least the requested length", async () => {
    const out = path.join(dir, "looped.mp3");
    const d = await loopAudio(tone, out, 7);
    expect(d).toBeGreaterThanOrEqual(7);
    expect(await probeDuration(out)).toBeGreaterThanOrEqual(7);
  }, 30_000);
});

describe("generateMusic", () => {
  it("writes the model audio and loops it up to the edit length", async () => {
    const calls: unknown[] = [];
    const out = path.join(dir, "bed", "music.mp3");
    const r = await generateMusic("gentle acoustic guitar", 5, out, fakeClient(calls));
    expect(r.file).toBe(out);
    expect(r.model).toBe(LYRIA_MODELS.clip);
    expect(r.seconds).toBeGreaterThanOrEqual(5);
    expect(await probeDuration(out)).toBeGreaterThanOrEqual(5);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ model: LYRIA_MODELS.clip, store: false, response_format: { type: "audio" } });
    expect((calls[0] as { input: string }).input).toContain("Instrumental only, no vocals.");
  }, 30_000);

  it("keeps a clip that is already long enough", async () => {
    const out = path.join(dir, "short.mp3");
    const r = await generateMusic("x", 1, out, fakeClient([]));
    expect(Math.abs(r.seconds - 2)).toBeLessThan(0.2);
  }, 30_000);

  it("rejects a non-positive length", async () => {
    await expect(generateMusic("x", 0, path.join(dir, "z.mp3"), fakeClient([]))).rejects.toThrow(/positive/);
  });
});

describe("applyMusicPatch", () => {
  const edl = (): EDL => ({
    title: "",
    width: 1280,
    height: 720,
    fps: 30,
    cuts: [{ id: "c1", clipId: "a", srcIn: 0, srcOut: 1, reason: "" }],
    captions: [],
    overlays: [],
    music: { prompt: "old", gainDb: -20, file: "music.mp3" },
  });
  const P = (p: Partial<PatchOp> & { op: PatchOp["op"] }) => p as PatchOp;

  it("sets a new prompt, keeps the gain and drops the stale file", () => {
    const orig = edl();
    const next = applyMusicPatch(orig, P({ op: "set_music", text: "  bright ukulele " }));
    expect(next.music).toEqual({ prompt: "bright ukulele", gainDb: -20 });
    expect(orig).toEqual(edl());
  });
  it("removes the bed on empty text", () => {
    expect(applyMusicPatch(edl(), P({ op: "set_music", text: "" })).music).toBeNull();
    expect(applyMusicPatch(edl(), P({ op: "set_music" })).music).toBeNull();
  });
  it("ignores other ops", () => {
    const orig = edl();
    expect(applyMusicPatch(orig, P({ op: "set_title", text: "T" }))).toBe(orig);
  });
  it("works on a draft without music", () => {
    const draft = { title: "", cuts: [], captions: [] };
    expect(applyMusicPatch(draft, P({ op: "set_music", text: "p" })).music).toEqual({ prompt: "p" });
  });
});
