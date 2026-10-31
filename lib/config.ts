import path from "node:path";

import { TITLE_SECONDS } from "./format";

export { TITLE_SECONDS };

// Server-side only. Every tunable the pipeline uses lives here and is read from the environment
// once, at process start. `.env.example` lists each variable with its default.

function envNumber(name: string, fallback: number, opts: { min?: number; integer?: boolean } = {}): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  const ok = Number.isFinite(n) && (!opts.integer || Number.isInteger(n)) && (opts.min === undefined || n >= opts.min);
  if (!ok) {
    console.warn(`[config] ${name}=${JSON.stringify(raw)} is not a valid value; using ${fallback}`);
    return fallback;
  }
  return n;
}

const envInt = (name: string, fallback: number, min = 1) => envNumber(name, fallback, { min, integer: true });

/** "1", "true", "yes", "on" (any case) are true; anything else, including unset, is false. */
function envFlag(name: string): boolean {
  return /^(1|true|yes|on)$/i.test(process.env[name]?.trim() ?? "");
}

// ---------------------------------------------------------------------------
// Paths

// Runs live outside the bundle; the ignore comment stops Turbopack tracing the whole repo.
export const RUNS_DIR = path.resolve(/*turbopackIgnore: true*/ process.env.RUNS_DIR ?? "runs");

/** The bundled demo footage (mp4/mov/... plus an optional brief.txt). */
export const DEMO_DIR = path.resolve(/*turbopackIgnore: true*/ process.env.DEMO_DIR ?? "footage/demo");
/** Name of the file inside DEMO_DIR that holds the demo brief. DEMO_BRIEF in the environment wins over it. */
export const DEMO_BRIEF_FILE = "brief.txt";
export const DEMO_BRIEF_ENV = process.env.DEMO_BRIEF?.trim() ?? "";
/** Used only when neither DEMO_BRIEF nor DEMO_DIR/brief.txt is present. */
export const DEFAULT_DEMO_BRIEF =
  "Cut a 30-second launch teaser for Lumen. Open on the welcome, remove filler words like um, keep the product reveal, end on the price and the closing line. Add captions.";

// ---------------------------------------------------------------------------
// Models

export const MODELS = {
  argon: process.env.ARGON_MODEL ?? "gemini-4-argon",
  flash: process.env.FLASH_MODEL ?? "gemini-3.8-flash",
  transcribe: process.env.TRANSCRIBE_MODEL ?? "gemini-3.5-transcribe",
} as const;

/** Wall-clock budget for one model call, one Files API upload to become ACTIVE, and the SDK's HTTP timeout. */
export const LLM_TIMEOUT_MS = envInt("LLM_TIMEOUT_MS", 15 * 60 * 1000);
/** Gemini requests (Interactions + Files API uploads) in flight at once per process; more than this invites 429 storms. */
export const GEMINI_CONCURRENCY = envInt("GEMINI_CONCURRENCY", 4);
/** KEEP_UPLOADS=1 leaves a run's proxies in the Files API after the run ends (default: deleted, see docs/SCALING.md). */
export const KEEP_UPLOADS = envFlag("KEEP_UPLOADS");

// ---------------------------------------------------------------------------
// Render

/**
 * Fallback output size: used only when the footage cannot be probed. The real output size follows the
 * footage (chooseOutput in lib/media.ts): 1920x1080 landscape, 1080x1920 portrait, 1080x1080 square.
 */
export const OUTPUT = {
  width: envInt("OUTPUT_WIDTH", 1280, 16),
  height: envInt("OUTPUT_HEIGHT", 720, 16),
  fps: envInt("OUTPUT_FPS", 30, 1),
} as const;
export interface OutputSize {
  width: number;
  height: number;
  fps: number;
}
/** Delivery sizes chooseOutput picks from. "uhd" is 4K and is only used when the brief asks for it. */
export const OUTPUT_PRESETS = {
  landscape: { width: 1920, height: 1080 },
  portrait: { width: 1080, height: 1920 },
  square: { width: 1080, height: 1080 },
  uhd: { width: 3840, height: 2160 },
} as const;
/** Render -> critique -> patch rounds for a fresh cut. */
export const MAX_ITERATIONS = envInt("MAX_ITERATIONS", 3);
/** Extra rounds after a director's note is applied. */
export const REVISE_MAX_ITERATIONS = envInt("REVISE_MAX_ITERATIONS", 2);
/** Cuts shorter than this after clamping are dropped. Seconds. */
export const MIN_CUT_SECONDS = envNumber("MIN_CUT_SECONDS", 0.3, { min: 0.05 });
/**
 * Long edge of the h264 proxies uploaded for the model to watch: 854 gives 854x480 for landscape and
 * 480x854 for portrait footage, so a phone vertical stays vertical. Never upscales.
 */
export const PROXY_LONG_EDGE = envInt("PROXY_LONG_EDGE", 854, 144);
/** @deprecated proxies are sized by PROXY_LONG_EDGE; kept for scripts that still read it. */
export const PROXY_HEIGHT = envInt("PROXY_HEIGHT", 480, 144);
/** Proxies are re-timed to a constant frame rate so VFR phone footage keeps its timestamps for the model. */
export const PROXY_FPS = envInt("PROXY_FPS", 30, 1);
/** A single uploaded clip longer than this is rejected at upload with 400. Seconds. */
export const MAX_CLIP_SECONDS = envNumber("MAX_CLIP_SECONDS", 1800, { min: 1 });
/** All clips of one run together may not exceed this. Seconds. */
export const MAX_TOTAL_SECONDS = envNumber("MAX_TOTAL_SECONDS", 7200, { min: 1 });
/** Length of the clip a still photo becomes. Seconds. */
export const PHOTO_SECONDS = envNumber("PHOTO_SECONDS", 4, { min: 0.5 });
/** Default level of the music bed under the dialogue, in dB; edl.audio.musicGainDb and edl.music.gainDb override it. */
export const MUSIC_GAIN_DB = envNumber("MUSIC_GAIN_DB", -15);
/** stdout/stderr buffer for every ffmpeg/ffprobe child process. */
export const EXEC_MAX_BUFFER = envInt("EXEC_MAX_BUFFER", 16 * 1024 * 1024, 1024 * 1024);

// ---------------------------------------------------------------------------
// HTTP limits

/** Total multipart body a POST /api/runs may carry; larger uploads get 413. */
export const MAX_UPLOAD_BYTES = envInt("MAX_UPLOAD_BYTES", 2 * 1024 * 1024 * 1024);
export const BRIEF_MAX_CHARS = envInt("BRIEF_MAX_CHARS", 2000);
export const NOTE_MAX_CHARS = envInt("NOTE_MAX_CHARS", 500);
/** Comment frame sent on an idle Server-Sent Events stream so proxies keep it open. */
export const SSE_HEARTBEAT_MS = envInt("SSE_HEARTBEAT_MS", 15_000, 1000);
/** An in-progress run whose run.json has been quiet this long, with no loop driving it here, is marked interrupted. */
export const ORPHAN_AFTER_MS = envInt("ORPHAN_AFTER_MS", 90_000, 1000);

// ---------------------------------------------------------------------------
// Files

export const VIDEO_EXT = /\.(mp4|mov|webm|mkv|m4v)$/i;

export function isVideoName(name: string): boolean {
  return VIDEO_EXT.test(name);
}

/** Basename with everything but [A-Za-z0-9._-] replaced, so a run folder never gets a hostile name. */
export function safeName(name: string, fallback = "clip.mp4"): string {
  return path.basename(name).replace(/[^A-Za-z0-9._-]/g, "_") || fallback;
}

const RUN_ID = /^[0-9a-f]{10}$/;

export function isRunId(id: string): boolean {
  return RUN_ID.test(id);
}

/** Absolute directory for one run. Rejects anything that is not a generated run id. */
export function runDir(id: string): string {
  if (!isRunId(id)) throw new Error(`invalid run id: ${id}`);
  return path.join(RUNS_DIR, id);
}
