import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface FixtureClipOptions {
  seconds?: number;
  audio?: boolean;
  width?: number;
  height?: number;
  /** Source frame rate (default 30). */
  fps?: number;
  /** Encoder pixel format, e.g. "yuv420p10le" for a 10-bit clip (default yuv420p). */
  pixFmt?: string;
  /** Video encoder (default libx264; "libx265" for HEVC). */
  codec?: string;
  /**
   * lavfi source (default testsrc2, which is 4:2:0 and therefore always even-sized). "testsrc" is RGB,
   * so with a 4:4:4 pixel format it keeps odd sizes such as 639x361.
   */
  source?: "testsrc" | "testsrc2";
  /**
   * Display rotation written into the container (0, 90, 180, 270), the way phones record: the frames
   * stay `width`x`height`, and players turn them. 90 on a 1280x720 clip plays as 720x1280.
   */
  rotation?: number;
}

/** Generate a small real mp4 with ffmpeg so tests exercise the real pipeline. */
export async function makeFixtureClip(dir: string, name: string, opts: FixtureClipOptions = {}): Promise<string> {
  const { seconds = 3, audio = true, width = 640, height = 360, fps = 30, pixFmt = "yuv420p", rotation = 0, codec = "libx264", source = "testsrc2" } = opts;
  const out = path.join(dir, name);
  const args = [
    "-y", "-v", "error",
    "-f", "lavfi", "-t", String(seconds), "-i", `${source}=size=${width}x${height}:rate=${fps}`,
  ];
  if (audio) args.push("-f", "lavfi", "-t", String(seconds), "-i", "sine=frequency=440:sample_rate=48000");
  args.push("-c:v", codec, "-pix_fmt", pixFmt, "-preset", "ultrafast");
  if (codec === "libx265") args.push("-x265-params", "log-level=none");
  if (audio) args.push("-c:a", "aac", "-shortest");
  if (rotation === 0) {
    args.push(out);
    await execFileAsync("ffmpeg", args);
    return out;
  }
  // Encode flat first, then remux with a display matrix; -display_rotation only applies on input.
  const flat = path.join(dir, `${name}.flat.mp4`);
  await execFileAsync("ffmpeg", [...args, flat]);
  await execFileAsync("ffmpeg", ["-y", "-v", "error", "-display_rotation", String(rotation), "-i", flat, "-c", "copy", out]);
  return out;
}
