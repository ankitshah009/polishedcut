import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { EXEC_MAX_BUFFER } from "./config";

const execFileAsync = promisify(execFile);

export const THUMB_WIDTH = 160;
export const THUMB_HEIGHT = 90;
/** Sprites never exceed this many frames; longer clips get frames spaced duration/N seconds apart. */
export const MAX_THUMB_FRAMES = 200;

export interface ThumbMeta {
  frames: number;
  secondsPerFrame: number;
  width: number;
  height: number;
}

/** Frame count and spacing for a clip: one frame per second, capped at MAX_THUMB_FRAMES. */
export function thumbLayout(duration: number): ThumbMeta {
  const wanted = Math.max(1, Math.ceil(duration));
  const frames = Math.min(wanted, MAX_THUMB_FRAMES);
  const secondsPerFrame = frames === wanted ? 1 : duration / frames;
  return { frames, secondsPerFrame, width: THUMB_WIDTH, height: THUMB_HEIGHT };
}

/**
 * Write a horizontal JPEG sprite (frames x 160x90, letterboxed) to `dst`, plus `dst` with .json
 * holding ThumbMeta. Frame k shows time k * secondsPerFrame. Frames are always 16:9 so the timeline
 * strip has one shape; portrait and rotated sources (ffmpeg autorotate applies the container's
 * rotation before the filters) are pillarboxed inside it.
 */
export async function makeThumbSprite(src: string, dst: string, duration: number): Promise<ThumbMeta> {
  const meta = thumbLayout(duration);
  await mkdir(path.dirname(dst), { recursive: true });
  const fps = meta.secondsPerFrame === 1 ? "1" : `${meta.frames}/${duration}`;
  const vf = [
    `fps=${fps}`,
    `scale=${THUMB_WIDTH}:${THUMB_HEIGHT}:force_original_aspect_ratio=decrease`,
    `pad=${THUMB_WIDTH}:${THUMB_HEIGHT}:(ow-iw)/2:(oh-ih)/2:black`,
    `tile=${meta.frames}x1`,
  ].join(",");
  try {
    await execFileAsync(
      "ffmpeg",
      ["-y", "-v", "error", "-i", src, "-vf", vf, "-frames:v", "1", "-q:v", "5", dst],
      { maxBuffer: EXEC_MAX_BUFFER },
    );
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    const tail = (e.stderr ?? e.message).trim().split("\n").slice(-20).join("\n");
    throw new Error(`ffmpeg failed (exit ${e.code ?? "?"}):\n${tail}`);
  }
  await writeFile(dst.replace(/\.jpg$/, ".json"), JSON.stringify(meta));
  return meta;
}
