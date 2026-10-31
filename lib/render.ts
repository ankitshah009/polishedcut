import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { EXEC_MAX_BUFFER, MUSIC_GAIN_DB, TITLE_SECONDS } from "./config";
import { hasAudio as hasAudioStream } from "./media";
import type { Caption, EDL, Overlay, OverlayPosition } from "./schema";

export { MUSIC_GAIN_DB };

const execFileAsync = promisify(execFile);

const FONTS = [
  "/System/Library/Fonts/Supplemental/Arial.ttf",
  "/System/Library/Fonts/Helvetica.ttc",
  "/Library/Fonts/Arial.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
];

function fontOption(): string {
  const found = FONTS.find((f) => existsSync(f));
  return found ? `fontfile='${found}':` : "";
}

/**
 * Write text to a file and return a drawtext source option that reads it.
 * textfile= with expansion=none avoids every filtergraph escaping pitfall
 * (colons, quotes, commas, backslashes, brackets) for arbitrary text.
 */
/**
 * The render font has no box-drawing or block glyphs, so Argon's text progress bars ("[██░░ 25%]")
 * would burn in as white boxes. Drop those characters and tidy what they leave behind.
 */
export function drawableText(text: string): string {
  return text
    .replace(/[─-▟■-◿]/g, "")
    .replace(/\[\s*(\d{1,3}%)\s*(?:complete)?\s*\]/gi, "· $1")
    .replace(/\[\s*\]|\(\s*\)/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

async function textFileOption(text: string, dir: string, name: string): Promise<string> {
  text = drawableText(text);
  const file = path.join(dir, name);
  await writeFile(file, text.replace(/\r/g, "").replace(/\n/g, " "), "utf8");
  const safe = file.replace(/\\/g, "/").replace(/'/g, "").replace(/:/g, "\\:");
  return `textfile='${safe}':expansion=none`;
}

function assertRenderable(edl: EDL, clipFiles: Record<string, string>): void {
  if (edl.cuts.length === 0) throw new Error("EDL has no cuts");
  for (const [k, v] of Object.entries({ width: edl.width, height: edl.height, fps: edl.fps })) {
    if (!(Number.isInteger(v) && v > 0)) throw new Error(`EDL ${k} must be a positive integer, got ${v}`);
  }
  if (edl.width % 2 !== 0 || edl.height % 2 !== 0) throw new Error(`EDL size ${edl.width}x${edl.height} must be even (yuv420p)`);
  for (const cut of edl.cuts) {
    if (!(cut.srcOut > cut.srcIn)) throw new Error(`cut ${cut.id}: non-positive duration`);
    if (!(cut.clipId in clipFiles)) throw new Error(`cut ${cut.id}: unknown clip ${cut.clipId}`);
  }
}

export interface RenderAssets {
  /** Absolute path of the music bed (edl.music.file is relative to the run directory). */
  music?: string;
  /** Absolute path of a generated title-card backdrop (edl.titleImage is relative to the run directory). */
  titleImage?: string;
  /** Absolute path of a generated closing-card backdrop (edl.endImage is relative to the run directory). */
  endImage?: string;
}

const MUSIC_FADE_IN = 1.5;
const MUSIC_FADE_OUT = 2.5;
/** Dialogue clean-up applied when edl.audio.denoise is set: rumble cut, then FFT noise reduction. */
const DENOISE_CHAIN = "highpass=f=80,afftdn=nf=-25";

/** Music level in dB for this EDL: the audio block wins, then the music block, then the default. */
export function musicGainDb(edl: Pick<EDL, "audio" | "music">): number {
  return edl.audio?.musicGainDb ?? edl.music?.gainDb ?? MUSIC_GAIN_DB;
}

/** Total output length: title card, cuts, closing card. */
export function renderedDuration(edl: Pick<EDL, "title" | "endTitle" | "cuts">): number {
  const cards = (edl.title ? TITLE_SECONDS : 0) + (edl.endTitle ? TITLE_SECONDS : 0);
  return cards + edl.cuts.reduce((s, c) => s + (c.srcOut - c.srcIn), 0);
}

/**
 * Overlays as rendered: a lower-third that shares screen time with a caption is lifted to "top" so
 * the two never collide. Pure; exported for tests.
 */
export function placeOverlays(overlays: Overlay[], captions: Caption[]): Overlay[] {
  const overlaps = (o: Overlay) => captions.some((c) => c.start < o.end && o.start < c.end);
  return overlays.map((o) => (o.position === "lower-third" && overlaps(o) ? { ...o, position: "top" } : o));
}

/** Absolute music file to mix, or null when the EDL has no music or the file is missing. */
function musicFile(edl: EDL, assets?: RenderAssets): string | null {
  if (!edl.music?.file) return null;
  const file = assets?.music ?? (path.isAbsolute(edl.music.file) ? edl.music.file : null);
  if (!file) {
    console.warn(`[render] music ${edl.music.file} is relative and no assets.music was given; rendering without music`);
    return null;
  }
  if (!existsSync(file)) {
    console.warn(`[render] music file ${file} not found; rendering without music`);
    return null;
  }
  return file;
}

/**
 * Render an EDL to an h264/aac mp4 at edl.width x edl.height (any even size: 1920x1080, 1080x1920,
 * 1080x1080, 3840x2160). Every cut is scaled to fit and letterboxed/pillarboxed onto that frame, after
 * ffmpeg's autorotate has applied the source's rotation metadata, so mixed phone and camera footage
 * lands upright. Timeline: optional title card, the cuts in order, then an optional closing card.
 * Caption and overlay times are on the output timeline, which includes the title-card offset.
 * With a music bed, the bed is looped/trimmed to the total, ducked under dialogue, faded, and the
 * final mix is loudness-normalised to -14 LUFS. Without music the output is unchanged.
 * edl.audio.denoise runs the program audio through a highpass and afftdn before the mix.
 */
export async function renderEdl(
  edl: EDL,
  clipFiles: Record<string, string>,
  outFile: string,
  assets?: RenderAssets,
): Promise<void> {
  assertRenderable(edl, clipFiles);
  const music = musicFile(edl, assets);
  const tmp = await mkdtemp(path.join(os.tmpdir(), "render_"));
  try {
    const { width: W, height: H, fps } = edl;
    const font = fontOption();
    const normV = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p`;
    const normA = "aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo";
    const inputs: string[] = [];
    const filters: string[] = [];
    const segs: string[] = [];
    let n = 0;

    // A full-frame text card (title or closing): a generated backdrop (Nano Banana) when one exists,
    // otherwise plain black. Over an image, dim it and shadow the text so it stays legible.
    const card = async (text: string, image: string | undefined, tag: string) => {
      const backdrop = image && existsSync(image) ? image : null;
      if (backdrop) inputs.push("-loop", "1", "-t", String(TITLE_SECONDS), "-i", backdrop);
      else inputs.push("-f", "lavfi", "-t", String(TITLE_SECONDS), "-i", `color=c=black:s=${W}x${H}:r=${fps}`);
      inputs.push("-f", "lavfi", "-t", String(TITLE_SECONDS), "-i", "anullsrc=r=48000:cl=stereo");
      const size = Math.max(24, Math.floor(H / 12));
      const src = await textFileOption(text, tmp, `${tag}.txt`);
      const dim = backdrop ? `${normV},colorlevels=rimax=0.6:gimax=0.6:bimax=0.6,` : "";
      const shadow = backdrop ? ":shadowcolor=black@0.7:shadowx=2:shadowy=2" : "";
      filters.push(
        `[${n}:v]${dim}drawtext=${font}${src}:fontcolor=white:fontsize=${size}:x=(w-text_w)/2:y=(h-text_h)/2${shadow},${normV}[${tag}v]`,
      );
      filters.push(`[${n + 1}:a]${normA}[${tag}a]`);
      segs.push(`[${tag}v][${tag}a]`);
      n += 2;
    };

    if (edl.title) await card(edl.title, assets?.titleImage, "title");

    for (const [i, cut] of edl.cuts.entries()) {
      const dur = cut.srcOut - cut.srcIn;
      inputs.push("-ss", cut.srcIn.toFixed(3), "-t", dur.toFixed(3), "-i", clipFiles[cut.clipId]);
      const vi = n;
      n += 1;
      filters.push(`[${vi}:v]${normV},trim=duration=${dur.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`);
      if (await hasAudioStream(clipFiles[cut.clipId])) {
        filters.push(
          `[${vi}:a]${normA},atrim=duration=${dur.toFixed(3)},apad=whole_dur=${dur.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`,
        );
      } else {
        inputs.push("-f", "lavfi", "-t", dur.toFixed(3), "-i", "anullsrc=r=48000:cl=stereo");
        filters.push(`[${n}:a]${normA}[a${i}]`);
        n += 1;
      }
      segs.push(`[v${i}][a${i}]`);
    }

    if (edl.endTitle) await card(edl.endTitle, assets?.endImage, "end");

    const total = renderedDuration(edl);
    // Program audio: concat output, optionally cleaned up, then either straight out or into the mix.
    const denoise = edl.audio?.denoise === true;
    const progOut = music ? "[pa]" : "[outa]";
    filters.push(`${segs.join("")}concat=n=${segs.length}:v=1:a=1[cv]${denoise ? "[ca]" : progOut}`);
    if (denoise) filters.push(`[ca]${DENOISE_CHAIN}${progOut}`);
    if (music) {
      const T = total.toFixed(3);
      const gain = musicGainDb(edl);
      const fadeOutAt = Math.max(0, total - MUSIC_FADE_OUT).toFixed(3);
      inputs.push("-stream_loop", "-1", "-t", T, "-i", music);
      filters.push(
        `[${n}:a]${normA},atrim=duration=${T},asetpts=PTS-STARTPTS,volume=${gain}dB,` +
          `afade=t=in:st=0:d=${MUSIC_FADE_IN},afade=t=out:st=${fadeOutAt}:d=${MUSIC_FADE_OUT}[mus]`,
        "[pa]asplit=2[prog][sc]",
        "[mus][sc]sidechaincompress=threshold=0.05:ratio=6:attack=20:release=400[ducked]",
        "[prog][ducked]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[mix]",
        "[mix]loudnorm=I=-14:TP=-1.5:LRA=11[outa]",
      );
      n += 1;
    }
    // Captions first, then overlays, so both can be on screen at once.
    const parts: string[] = [];
    const capSize = Math.max(18, Math.floor(H / 22));
    for (const [k, cap] of edl.captions.entries()) {
      parts.push(await captionFilter(cap, tmp, k + 1, font, capSize, H));
    }
    const overlays = placeOverlays(edl.overlays ?? [], edl.captions);
    for (const [k, ov] of overlays.entries()) {
      parts.push(await overlayFilter(ov, tmp, k + 1, font, W, H));
    }
    filters.push(parts.length > 0 ? `[cv]${parts.join(",")}[outv]` : "[cv]null[outv]");

    await mkdir(path.dirname(path.resolve(outFile)), { recursive: true });
    const args = [
      "-y", "-v", "error", ...inputs,
      "-filter_complex", filters.join(";"),
      "-map", "[outv]", "-map", "[outa]",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-r", String(fps),
      "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
      "-movflags", "+faststart", outFile,
    ];
    try {
      await execFileAsync("ffmpeg", args, { maxBuffer: EXEC_MAX_BUFFER });
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { code?: number | string; stderr?: string };
      const tail = (e.stderr ?? e.message).trim().split("\n").slice(-25).join("\n");
      throw new Error(`ffmpeg render failed (exit ${e.code ?? "?"}):\n${tail}`);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function captionFilter(
  cap: Caption,
  dir: string,
  k: number,
  font: string,
  size: number,
  H: number,
): Promise<string> {
  const text = await textFileOption(cap.text, dir, `caption${k}.txt`);
  return (
    `drawtext=${font}${text}:fontcolor=white:fontsize=${size}:box=1:boxcolor=black@0.6:boxborderw=12:` +
    `x=(w-text_w)/2:y=h-text_h-${Math.floor(H / 12)}:` +
    `enable='between(t\\,${cap.start.toFixed(3)}\\,${cap.end.toFixed(3)})'`
  );
}

/**
 * One on-screen label. lower-third: left-aligned dark pill at 78% height; top: centred near the top;
 * center: large and centred. Font H/24 (center: H/14); never collides with the caption band at the bottom.
 */
async function overlayFilter(ov: Overlay, dir: string, k: number, font: string, W: number, H: number): Promise<string> {
  const text = await textFileOption(ov.text, dir, `overlay${k}.txt`);
  const size = Math.max(16, Math.floor(H / 24));
  const margin = Math.floor(W / 24);
  const geometry: Record<OverlayPosition, string> = {
    "lower-third": `fontsize=${size}:box=1:boxcolor=black@0.65:boxborderw=14:x=${margin}:y=h*0.78-text_h/2`,
    top: `fontsize=${size}:box=1:boxcolor=black@0.55:boxborderw=12:x=(w-text_w)/2:y=${Math.floor(H / 14)}`,
    center: `fontsize=${Math.max(24, Math.floor(H / 14))}:shadowcolor=black@0.8:shadowx=2:shadowy=2:x=(w-text_w)/2:y=(h-text_h)/2`,
  };
  return (
    `drawtext=${font}${text}:fontcolor=white:${geometry[ov.position]}:` +
    `enable='between(t\\,${ov.start.toFixed(3)}\\,${ov.end.toFixed(3)})'`
  );
}
