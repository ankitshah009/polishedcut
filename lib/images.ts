import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { EXEC_MAX_BUFFER, OUTPUT, PHOTO_SECONDS, type OutputSize } from "./config";

const execFileAsync = promisify(execFile);

/** Still-image extensions a phone camera roll produces. */
export const IMAGE_EXT = /\.(jpe?g|png|webp|heic|heif)$/i;
const HEIF_EXT = /\.(heic|heif)$/i;

const DEFAULT_SECONDS = PHOTO_SECONDS;
/** Ken Burns end zoom: 1.0 at the first frame, this at the last. */
const END_ZOOM = 1.08;

export function isImageFile(name: string, type: string): boolean {
  return type.startsWith("image/") || IMAGE_EXT.test(name);
}

async function run(tool: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(tool, args, { maxBuffer: EXEC_MAX_BUFFER });
    return stdout;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { code?: number | string; stderr?: string };
    const tail = (e.stderr || e.message).trim().split("\n").slice(-20).join("\n");
    throw new Error(`${tool} failed (exit ${e.code ?? "?"}):\n${tail}`);
  }
}

let heifSupport: Promise<boolean> | undefined;

/** True when this ffmpeg build can demux HEIF/HEIC itself (`ffmpeg -formats | grep -i heif`). */
function ffmpegSupportsHeif(): Promise<boolean> {
  heifSupport ??= execFileAsync("ffmpeg", ["-hide_banner", "-formats"], { maxBuffer: EXEC_MAX_BUFFER })
    .then(({ stdout }) => /heif/i.test(stdout), () => false);
  return heifSupport;
}

/** macOS fallback: let the OS image stack decode HEIC and hand ffmpeg a JPEG. */
async function heifToJpeg(src: string, dst: string): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error(`cannot decode ${path.basename(src)}: this ffmpeg has no HEIF support and sips is only available on macOS`);
  }
  await run("sips", ["-s", "format", "jpeg", src, "--out", dst]);
}

export interface ImageClipOptions {
  seconds?: number;
  /**
   * Frame the photo clip is rendered at. Pass the run's delivery size (chooseOutput) so a portrait
   * photo in a vertical cut fills the frame instead of being pillarboxed onto 16:9 and scaled again.
   * Defaults to the configured OUTPUT.
   */
  size?: OutputSize;
}

/**
 * Turn a still photo into a short h264 clip (OUTPUT size by default, or `opts.size`) with a silent
 * stereo AAC track so it can be cut like any other source clip. Photos of another shape are
 * letterboxed onto that frame first, then a gentle Ken Burns push-in (1.0 -> END_ZOOM over the whole
 * clip) keeps the frame from feeling frozen. EXIF orientation is applied by ffmpeg's autorotate.
 */
export async function imageToClip(src: string, dst: string, opts: ImageClipOptions = {}): Promise<void> {
  const seconds = opts.seconds ?? DEFAULT_SECONDS;
  if (!(seconds > 0)) throw new Error(`imageToClip: seconds must be > 0, got ${seconds}`);
  const { width: OUT_W, height: OUT_H, fps: FPS } = opts.size ?? OUTPUT;
  for (const [k, v] of Object.entries({ width: OUT_W, height: OUT_H, fps: FPS })) {
    if (!(Number.isInteger(v) && v > 0)) throw new Error(`imageToClip: ${k} must be a positive integer, got ${v}`);
  }
  const frames = Math.max(2, Math.round(seconds * FPS));
  await mkdir(path.dirname(dst), { recursive: true });

  let input = src;
  let tmp: string | undefined;
  if (HEIF_EXT.test(src) && !(await ffmpegSupportsHeif())) {
    tmp = await mkdtemp(path.join(os.tmpdir(), "argon_heic_"));
    input = path.join(tmp, "frame.jpg");
    await heifToJpeg(src, input);
  }

  // Work at 2x the output size so the zoom crop never upsamples below the output frame.
  const w2 = OUT_W * 2;
  const h2 = OUT_H * 2;
  const filter = [
    `scale=${w2}:${h2}:force_original_aspect_ratio=decrease`,
    `pad=${w2}:${h2}:(ow-iw)/2:(oh-ih)/2:color=black`,
    "setsar=1",
    `zoompan=z='1+${END_ZOOM - 1}*on/${frames - 1}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${OUT_W}x${OUT_H}:fps=${FPS}`,
    "format=yuv420p",
  ].join(",");

  try {
    await run("ffmpeg", [
      "-y", "-v", "error",
      "-i", input,
      "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
      "-filter_complex", `[0:v]${filter}[v]`,
      "-map", "[v]", "-map", "1:a",
      "-t", String(seconds),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-r", String(FPS),
      "-c:a", "aac", "-b:a", "96k",
      "-movflags", "+faststart", dst,
    ]);
  } finally {
    if (tmp) await rm(tmp, { recursive: true, force: true });
  }
}
