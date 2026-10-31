import path from "node:path";

import { TITLE_SECONDS } from "./format";
import { FrameAnalystError } from "./frame-analyst-error";

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

// ---------------------------------------------------------------------------
// Model provider
//
// Every model call goes through the Gemini SDK (@google/genai). MODEL_PROVIDER picks who answers:
//   gemini  (default)  Google directly with GEMINI_API_KEY.
//   nebula             a Nebula-hosted, Gemini-protocol gateway: NEBULA_BASE_URL + NEBULA_API_KEY, model ids
//                      such as google:gemini-3.8-flash / google:gemini-4-argon. NEBULA_MODEL is the main cut
//                      model (draft, critique, patch); NEBULA_FALLBACK_MODEL is tried when it errors.
// Unset, the provider is nebula when both NEBULA_BASE_URL and NEBULA_API_KEY are present, else gemini.
// GENAI_BASE_URL points the SDK at any other Gemini-compatible endpoint without changing provider.
export type ModelProvider = "local" | "gemini" | "nebula";
export const NEBULA_BASE_URL = (process.env.NEBULA_BASE_URL ?? "").trim().replace(/\/+$/, "");
export const NEBULA_API_KEY = (process.env.NEBULA_API_KEY ?? "").trim();
//   local              no hosted model at all: whisper.cpp transcripts + ffmpeg analysis + deterministic cut
//                      rules (lib/local-editor.ts). Free. The default when no key of any kind is configured.
const GEMINI_KEY_PRESENT = !!(process.env.GEMINI_API_KEY?.trim() || process.env.GEMINI_API_KEY_1?.trim());
export const MODEL_PROVIDER: ModelProvider = (() => {
  const v = process.env.MODEL_PROVIDER?.trim().toLowerCase();
  if (v === "nebula" || v === "gemini" || v === "local") return v;
  if (NEBULA_BASE_URL && NEBULA_API_KEY) return "nebula";
  return GEMINI_KEY_PRESENT ? "gemini" : "local";
})();
// ---------------------------------------------------------------------------
// Frame analysis (lib/frame-analyst.ts)
//
// Under the local editor, per-clip analysis (word-timed transcript, sound regions, shot boundaries) is
// either computed on this machine (whisper.cpp + ffmpeg) or fetched from the Nebula Frame Analyst
// webhook, so the work bills Nebula credits instead of running here. FRAME_ANALYSIS picks; unset, the
// webhook is used whenever NEBULA_FRAME_WEBHOOK_URL is set. With the webhook configured there is no
// silent fallback to whisper/ffmpeg: a failed call is reported, not papered over.
export type FrameAnalysisProvider = "local" | "nebula";
export const FRAME_ANALYST_URL = (process.env.NEBULA_FRAME_WEBHOOK_URL ?? "").trim();
export const FRAME_ANALYST_SECRET = (process.env.NEBULA_FRAME_WEBHOOK_SECRET ?? "").trim();
export const FRAME_ANALYSIS: FrameAnalysisProvider = (() => {
  const v = process.env.FRAME_ANALYSIS?.trim().toLowerCase();
  if (v === "nebula" || v === "local") return v;
  return FRAME_ANALYST_URL ? "nebula" : "local";
})();
/** Wall-clock budget for one clip's analysis round trip, polling included. */
export const FRAME_ANALYST_TIMEOUT_MS = envInt("NEBULA_FRAME_TIMEOUT_MS", 10 * 60 * 1000);
/** Pause between polls when the webhook answers 202 with a status URL. */
export const FRAME_ANALYST_POLL_MS = envInt("NEBULA_FRAME_POLL_MS", 3000, 100);
/** JPEG stills sampled evenly from each clip and listed (as URLs) in the webhook payload; 0 sends the clip URL only. */
export const FRAME_ANALYST_FRAMES = envInt("NEBULA_FRAME_FRAMES", 8, 0);
/** Extra attempts for the webhook POST after a network error, 429 or 5xx (4xx is never retried); 0 disables retries. */
export const FRAME_ANALYST_RETRIES = envInt("NEBULA_FRAME_RETRIES", 3, 0);
/** First pause before a retry; doubles each attempt (1s, 2s, 4s) and never outlives NEBULA_FRAME_TIMEOUT_MS. */
export const FRAME_ANALYST_BACKOFF_MS = envInt("NEBULA_FRAME_BACKOFF_MS", 1000, 0);

/**
 * Everything the Nebula Frame Analyst path needs, checked once at startup (instrumentation.ts, scripts/cut.ts)
 * so a half-configured webhook fails before a run does. Returns the problems instead of throwing so callers
 * can decide how loud to be; `validateFrameAnalystConfig` throws a FrameAnalystError(kind "config") on any.
 * Nothing to check when FRAME_ANALYSIS is local (the webhook is never called then).
 */
export function frameAnalystConfigProblems(): string[] {
  if (FRAME_ANALYSIS !== "nebula") return [];
  const problems: string[] = [];
  if (!FRAME_ANALYST_URL) problems.push("NEBULA_FRAME_WEBHOOK_URL is not set");
  else {
    let parsed: URL | null = null;
    try {
      parsed = new URL(FRAME_ANALYST_URL);
    } catch {
      problems.push(`NEBULA_FRAME_WEBHOOK_URL is not a valid URL: ${JSON.stringify(FRAME_ANALYST_URL)}`);
    }
    if (parsed && parsed.protocol !== "https:") problems.push(`NEBULA_FRAME_WEBHOOK_URL must be https (got ${parsed.protocol.replace(/:$/, "")}): the shared secret travels in a header`);
  }
  if (!FRAME_ANALYST_SECRET) problems.push("NEBULA_FRAME_WEBHOOK_SECRET is not set (Nebula authenticates the trigger with X-Webhook-Secret)");
  if (!PUBLIC_URL) problems.push("PUBLIC_URL is not set (the webhook fetches the clip, the stills and posts its callback there)");
  else {
    let parsed: URL | null = null;
    try {
      parsed = new URL(PUBLIC_URL);
    } catch {
      problems.push(`PUBLIC_URL is not a valid URL: ${JSON.stringify(PUBLIC_URL)}`);
    }
    if (parsed && parsed.protocol !== "https:") problems.push(`PUBLIC_URL must be https for Nebula to reach it (got ${parsed.protocol.replace(/:$/, "")})`);
  }
  return problems;
}

export function validateFrameAnalystConfig(): void {
  const problems = frameAnalystConfigProblems();
  if (problems.length === 0) return;
  throw new FrameAnalystError(
    "config",
    `FRAME_ANALYSIS=nebula but the Frame Analyst webhook is not fully configured: ${problems.join("; ")}. Fix .env (see .env.example) or set FRAME_ANALYSIS=local.`,
  );
}

/** whisper.cpp model for the local editor's transcripts; `whisper-cli` (brew install whisper-cpp) must be on PATH. */
export const WHISPER_MODEL = path.resolve(/*turbopackIgnore: true*/ process.env.WHISPER_MODEL ?? "models/ggml-base.en.bin");
export const WHISPER_BIN = process.env.WHISPER_BIN?.trim() || "whisper-cli";
/** Base URL for the SDK: the Nebula gateway under the nebula provider, else GENAI_BASE_URL, else Google's default. */
export const GENAI_BASE_URL = MODEL_PROVIDER === "nebula" ? NEBULA_BASE_URL : (process.env.GENAI_BASE_URL ?? "").trim().replace(/\/+$/, "");
const viaNebula = MODEL_PROVIDER === "nebula";
const NEBULA_MODEL = process.env.NEBULA_MODEL?.trim() || "google:gemini-3.8-flash";
export const NEBULA_FALLBACK_MODEL = process.env.NEBULA_FALLBACK_MODEL?.trim() || "google:gemini-4-argon";

export const MODELS = {
  argon: process.env.ARGON_MODEL ?? (viaNebula ? NEBULA_MODEL : "gemini-4-argon"),
  flash: process.env.FLASH_MODEL ?? (viaNebula ? "google:gemini-3.8-flash" : "gemini-3.8-flash"),
  transcribe: process.env.TRANSCRIBE_MODEL ?? (viaNebula ? "google:gemini-3.8-flash" : "gemini-3.5-transcribe"),
  /** Tried for the main cut model when `argon` errors; empty disables the fallback. */
  argonFallback: process.env.ARGON_FALLBACK_MODEL ?? (viaNebula ? NEBULA_FALLBACK_MODEL : ""),
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

// ---------------------------------------------------------------------------
// Chat front door: Photon Beta (2.0) (lib/photon.ts, lib/photon-handler.ts; see docs/PHOTON.md)
//
// This targets the Beta platform at app.beta.photon.codes: project ids `pho_prj_…`, project API keys
// `pho_sk_…`, the HTTP API at https://api.photon.codes/v1 and Socket.IO event delivery. It is not the
// Stable `spectrum-ts` SDK (project id + secret over gRPC); the two systems do not share credentials.

/** Beta project id (`pho_prj_…`, Settings in the Beta dashboard) and a project API key (`pho_sk_…`, API keys). */
export const PHOTON_PROJECT_ID = process.env.PHOTON_PROJECT_ID?.trim() ?? "";
export const PHOTON_API_KEY = (process.env.PHOTON_API_KEY ?? process.env.PHOTON_SPECTRUM_API_KEY ?? "").trim();
/** HTTP API origin; the documented default. The Socket.IO event stream hangs off the same origin. */
export const PHOTON_API_URL = (process.env.PHOTON_API_URL ?? "https://api.photon.codes").trim().replace(/\/+$/, "");
/** Optional event-contract date pinned on the Socket.IO subscription (`apiVersion`); unset -> server default. */
export const PHOTON_API_VERSION = process.env.PHOTON_API_VERSION?.trim() ?? "";
/** Signing secret from `createWebhookDestination`, for POST /api/photon/webhook; unused in stream mode. */
export const PHOTON_WEBHOOK_SECRET = process.env.PHOTON_WEBHOOK_SECRET?.trim() ?? "";
/** "stream" holds a Socket.IO connection open from this process (no public URL needed); "webhook" relies on the route. */
export const PHOTON_MODE = process.env.PHOTON_MODE?.trim().toLowerCase() === "webhook" ? "webhook" : "stream";
/** Set to 0/false to keep the adapter from booting even when credentials are present. */
export const PHOTON_ENABLED = !envFlagIsFalse("PHOTON_ENABLED") && PHOTON_PROJECT_ID !== "" && PHOTON_API_KEY !== "";
/** Clips and the brief rarely land in one message; wait this long after the last one before starting the cut. */
export const PHOTON_SETTLE_MS = envInt("PHOTON_SETTLE_MS", 2500, 0);
/** Give up waiting for a cut (and say so in the chat) after this long. */
export const PHOTON_RUN_TIMEOUT_MS = envInt("PHOTON_RUN_TIMEOUT_MS", 30 * 60 * 1000, 10_000);
/** A render larger than this is not attached; the link is sent instead. */
export const PHOTON_MAX_ATTACHMENT_BYTES = envInt("PHOTON_MAX_ATTACHMENT_BYTES", 95 * 1024 * 1024, 1024 * 1024);
/** Where the Socket.IO replay cursor is checkpointed between restarts. */
export const PHOTON_CURSOR_FILE = path.resolve(/*turbopackIgnore: true*/ process.env.PHOTON_CURSOR_FILE ?? path.join(RUNS_DIR, ".photon-cursor.json"));
/** Public origin of this app, used for the "watch every version" link in chat replies (e.g. https://framecut.example). */
export const PUBLIC_URL = (process.env.PUBLIC_URL ?? process.env.NEXT_PUBLIC_URL ?? "").trim().replace(/\/+$/, "");

/** "0", "false", "no", "off" (any case) are false; anything else, including unset, is not-false. */
function envFlagIsFalse(name: string): boolean {
  return /^(0|false|no|off)$/i.test(process.env[name]?.trim() ?? "");
}
