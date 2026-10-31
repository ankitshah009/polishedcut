import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makeThumbSprite, thumbLayout } from "../lib/thumbs";
import { makeFixtureClip } from "./fixtures";

const execFileAsync = promisify(execFile);
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "thumbs-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("makeThumbSprite", () => {
  it("writes a 1fps 160x90 sprite and metadata", async () => {
    const clip = await makeFixtureClip(dir, "a.mp4", { seconds: 3 });
    const dst = path.join(dir, "thumbs", "a.jpg");
    await makeThumbSprite(clip, dst, 3);
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error", "-show_entries", "stream=width,height", "-of", "json", dst,
    ]);
    const s = JSON.parse(stdout).streams[0];
    expect([s.width, s.height]).toEqual([480, 90]);
    const meta = JSON.parse(await readFile(path.join(dir, "thumbs", "a.json"), "utf8"));
    expect(meta).toEqual({ frames: 3, secondsPerFrame: 1, width: 160, height: 90 });
  }, 30_000);

  it("caps long clips at 200 frames", () => {
    expect(thumbLayout(400)).toMatchObject({ frames: 200, secondsPerFrame: 2 });
  });
});
