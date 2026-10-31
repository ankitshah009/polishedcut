import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { EXEC_MAX_BUFFER, OUTPUT, OUTPUT_PRESETS, PROXY_FPS, PROXY_LONG_EDGE, type OutputSize } from "./config";

const execFileAsync = promisify(execFile);

async function run(tool: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(tool, args, { maxBuffer: EXEC_MAX_BUFFER });
    return stdout;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { code?: number | string; stderr?: string };
    const tail = (e.stderr ?? e.message).trim().split("\n").slice(-20).join("\n");
    throw new Error(`${tool} failed (exit ${e.code ?? "?"}):\n${tail}`);
  }
}

// ---------------------------------------------------------------------------
// Probe

/** What one ffprobe call tells us about a clip (or a still image: duration 0, no audio, fps 0). */
export interface MediaInfo {
  /** Seconds; 0 for a still image. */
  duration: number;
  /** Coded (stored) frame size, before any rotation. 0 when there is no video stream. */
  width: number;
  height: number;
  /** Display rotation from the container, normalised to 0 | 90 | 180 | 270. */
  rotation: number;
  /** Average frame rate; 0 when unknown (stills, broken headers). */
  fps: number;
  hasAudio: boolean;
  /** Video codec name as ffprobe reports it: h264, hevc, prores, vp9, av1, png, ... "" when there is no video. */
  codec: string;
  /** Pixel format, e.g. yuv420p, yuv420p10le, yuv422p10le. */
  pixFmt: string;
}

type ProbeStream = {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
  tags?: { rotate?: string | number };
  side_data_list?: { rotation?: number; side_data_type?: string }[];
};

function fraction(s: string | undefined): number {
  if (!s) return 0;
  const [n, d] = s.split("/").map(Number);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return 0;
  const v = n / d;
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function normaliseRotation(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  // Display matrices report counter-clockwise angles (-90 for a phone held upright); the sign does
  // not matter for sizing, only whether the frame is turned a quarter turn.
  const r = ((Math.round(n / 90) * 90) % 360 + 360) % 360;
  return r;
}

function rotationOf(v: ProbeStream): number {
  const side = v.side_data_list?.find((s) => typeof s.rotation === "number");
  if (side) return normaliseRotation(side.rotation);
  if (v.tags?.rotate !== undefined) return normaliseRotation(v.tags.rotate);
  return 0;
}

/**
 * Everything the pipeline needs to know about a file, in one ffprobe call. Only the first video and
 * the first audio stream count, which is also what makeProxy maps. Throws when ffprobe cannot read
 * the file at all (not a media file, truncated, unsupported container).
 */
export async function probeMedia(file: string): Promise<MediaInfo> {
  const out = await run("ffprobe", [
    "-v", "error",
    "-show_entries",
    "format=duration:stream=index,codec_type,codec_name,width,height,pix_fmt,avg_frame_rate,r_frame_rate,duration:stream_tags=rotate:stream_side_data=rotation",
    "-of", "json", file,
  ]);
  const json = JSON.parse(out) as { format?: { duration?: string }; streams?: ProbeStream[] };
  const streams = json.streams ?? [];
  const v = streams.find((s) => s.codec_type === "video");
  const a = streams.find((s) => s.codec_type === "audio");
  if (!v && !a) throw new Error(`ffprobe found no audio or video stream in ${path.basename(file)}`);
  let duration = Number(json.format?.duration);
  if (!Number.isFinite(duration)) duration = Number(v?.duration ?? a?.duration);
  if (!Number.isFinite(duration) || duration < 0) duration = 0;
  return {
    duration,
    width: v?.width ?? 0,
    height: v?.height ?? 0,
    rotation: v ? rotationOf(v) : 0,
    fps: fraction(v?.avg_frame_rate) || fraction(v?.r_frame_rate),
    hasAudio: !!a,
    codec: v?.codec_name ?? "",
    pixFmt: v?.pix_fmt ?? "",
  };
}

/** Width and height as displayed, after the container's rotation is applied. */
export function displaySize(info: { width: number; height: number; rotation?: number }): { width: number; height: number } {
  const turned = (info.rotation ?? 0) % 180 !== 0;
  return turned ? { width: info.height, height: info.width } : { width: info.width, height: info.height };
}

export async function probeDuration(file: string): Promise<number> {
  return (await probeMedia(file)).duration;
}

export async function hasAudio(file: string): Promise<boolean> {
  return (await probeMedia(file)).hasAudio;
}

// ---------------------------------------------------------------------------
// Output size

export type Orientation = "landscape" | "portrait" | "square";

const WANTS_PORTRAIT = /\b(vertical|portrait|9\s*[:x]\s*16|reels?|tiktok|shorts?|stories|story)\b/i;
const WANTS_SQUARE = /\b(square|1\s*[:x]\s*1)\b/i;
const WANTS_LANDSCAPE = /\b(landscape|horizontal|widescreen|16\s*[:x]\s*9|youtube)\b/i;
const WANTS_UHD = /\b(4k|uhd|2160p?)\b/i;

/** Orientation of one clip from its display size; square within 2%. */
export function orientationOf(info: { width: number; height: number; rotation?: number }): Orientation | null {
  const { width, height } = displaySize(info);
  if (!(width > 0 && height > 0)) return null;
  const ratio = width / height;
  if (Math.abs(ratio - 1) <= 0.02) return "square";
  return ratio > 1 ? "landscape" : "portrait";
}

/**
 * Pick the delivery size for a set of clips. The footage decides: the orientation that carries the
 * most seconds (count, when durations are unknown) wins: landscape -> 1920x1080, portrait -> 1080x1920
 * (phone verticals), square -> 1080x1080. The brief can force it ("vertical", "9:16", "square",
 * "landscape") and ask for 4K ("4K", "UHD": 3840x2160, or 2160x3840 for a vertical). With no usable
 * clip and no hint in the brief the result is landscape. fps is OUTPUT.fps.
 */
export function chooseOutput(
  clips: readonly { width: number; height: number; rotation?: number; duration?: number }[],
  brief = "",
): OutputSize {
  let orientation: Orientation | null = null;
  if (WANTS_PORTRAIT.test(brief)) orientation = "portrait";
  else if (WANTS_SQUARE.test(brief)) orientation = "square";
  else if (WANTS_LANDSCAPE.test(brief)) orientation = "landscape";

  if (!orientation) {
    const weight: Record<Orientation, number> = { landscape: 0, portrait: 0, square: 0 };
    for (const clip of clips) {
      const o = orientationOf(clip);
      if (!o) continue;
      const d = clip.duration;
      weight[o] += Number.isFinite(d) && d! > 0 ? d! : 1;
    }
    orientation = (Object.keys(weight) as Orientation[]).reduce((best, o) => (weight[o] > weight[best] ? o : best), "landscape");
  }

  let { width, height }: { width: number; height: number } = OUTPUT_PRESETS[orientation];
  if (WANTS_UHD.test(brief) && orientation !== "square") {
    ({ width, height } = OUTPUT_PRESETS.uhd);
    if (orientation === "portrait") [width, height] = [height, width];
  }
  return { width, height, fps: OUTPUT.fps };
}

/** The configured fallback (OUTPUT_WIDTH x OUTPUT_HEIGHT), for callers that have nothing to probe. */
export function fallbackOutput(): OutputSize {
  return { ...OUTPUT };
}

// ---------------------------------------------------------------------------
// Proxies

/**
 * Low-resolution h264/aac copy of a clip, small enough to upload to the model, from any input ffmpeg
 * can decode: hevc/prores/vp9/av1, 10-bit, mkv/webm/mov, variable frame rate, rotated phone footage.
 *  - the long edge is scaled to `longEdge` (never upscaled), the other side follows with even rounding,
 *    so a portrait source stays portrait; ffmpeg's autorotate applies the container rotation first;
 *  - constant `PROXY_FPS` and yuv420p, so timestamps the model reports map 1:1 onto the source;
 *  - only the first video and first audio stream are mapped; a clip without audio gets a silent
 *    stereo track so every proxy has the same shape downstream.
 */
export async function makeProxy(src: string, dst: string, longEdge: number = PROXY_LONG_EDGE): Promise<void> {
  if (!(Number.isInteger(longEdge) && longEdge >= 16)) throw new Error(`makeProxy: bad long edge ${longEdge}`);
  await mkdir(path.dirname(dst), { recursive: true });
  const info = await probeMedia(src);
  if (!info.width || !info.height) throw new Error(`makeProxy: ${path.basename(src)} has no video stream`);
  // The long edge is min(longEdge, source) rounded down to even; -2 derives the other edge, also even
  // (yuv420p needs both), so odd-sized sources like 639x361 encode without a crop.
  const even = (edge: string) => `trunc(min(${longEdge},${edge})/2)*2`;
  const vf = [
    `scale=w='if(gt(iw,ih),${even("iw")},-2)':h='if(gt(iw,ih),-2,${even("ih")})'`,
    `fps=${PROXY_FPS}`,
    "format=yuv420p",
  ].join(",");
  const args = ["-y", "-v", "error", "-i", src];
  if (!info.hasAudio) args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
  args.push("-map", "0:v:0", "-map", info.hasAudio ? "0:a:0?" : "1:a", "-sn", "-dn");
  if (!info.hasAudio) args.push("-shortest");
  args.push(
    "-vf", vf,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "96k", "-ar", "48000", "-ac", "2",
    "-movflags", "+faststart", dst,
  );
  await run("ffmpeg", args);
}
