/**
 * Nebula Frame Analyst: per-clip analysis over a webhook instead of whisper.cpp + ffmpeg on this
 * machine, so the work bills Nebula credits. The local editor (lib/local-editor.ts) asks for one
 * analysis per clip and uses it for transcripts, sound regions and shot boundaries.
 *
 * Contract. The webhook is Nebula's generic inbound trigger for the job
 * "PolishedCut Frame Analysis Endpoint" (agent @frame-analyst), so it follows Nebula's rules
 * (api.nebula.gg/openapi.json, POST /webhooks/triggers/{trigger_id}/webhook):
 *
 *   POST <url>            X-Webhook-Secret: <secret>  (Nebula's shared-secret header; the same value
 *                         also goes out as Authorization: Bearer for any other host)
 *   {
 *     "task": "frame-analysis",
 *     "clip": { "id": "clip1", "url": "https://.../api/runs/<run>/files/proxies/clip1.mp4",
 *               "mime_type": "video/mp4", "duration_seconds": 97.6 },
 *     "frames": [{ "t": 0, "url": "https://.../api/runs/<run>/files/analysis/frames/clip1/f01.jpg" }, ...],
 *     "want": ["words", "sound", "shots", "summary"],
 *     "prompt": "...what to return, and that it may be POSTed to callback_url...",
 *     "callback_url": "https://.../api/frame-analysis/callback/<job>/<token>"
 *   }
 *
 *   The result can come back three ways, all accepted:
 *     1. 200 with the result in the body (a stand-in that works synchronously);
 *     2. 202 with { "status_url": "..." } (also: result_url, poll_url, url) that is GET-polled until it
 *        answers 200 with the result; a body whose "status" is pending / queued / running keeps polling;
 *     3. Nebula's own way: 200 { "success": true, "message": "..." } acknowledges the event, the agent
 *        runs as a Task and POSTs the result to callback_url
 *        (app/api/frame-analysis/callback/[job]/[token]/route.ts). One callback per request, token-checked.
 *
 *   Result (keys optional, wrapped in result / output / data or returned as text containing JSON):
 *   {
 *     "words": [{ "text": "hello", "start": 0.4, "end": 0.7 }, ...],   // seconds in the clip
 *     "sound": [[0, 12.3], [14.1, 30]],                                // or [{start,end}]; alias: speech, regions
 *     "shots": [[0, 5.2], [5.2, 18]],                                  // alias: scenes
 *     "summary": "one line about the footage"
 *   }
 *
 * No network code beyond the injected `fetch`, so tests run without credentials.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import {
  EXEC_MAX_BUFFER,
  FRAME_ANALYST_FRAMES,
  FRAME_ANALYST_POLL_MS,
  FRAME_ANALYST_SECRET,
  FRAME_ANALYST_TIMEOUT_MS,
  FRAME_ANALYST_URL,
  PUBLIC_URL,
  RUNS_DIR,
} from "./config";
import { extractJson } from "./gemini";
import type { Word } from "./schema";

const execFileAsync = promisify(execFile);

export type Region = [number, number];

export interface FrameAnalysis {
  words: Word[];
  sound: Region[];
  shots: Region[];
  summary?: string;
  /** Where the analysis came from, for logs and the run folder: the webhook URL. */
  source: string;
  /** How the result arrived: in the webhook's response, by polling its status URL, or on the callback route. */
  via: "response" | "poll" | "callback";
  /** How many stills were sent along with the clip URL. */
  frames: number;
  /** Wall-clock milliseconds for the round trip, polling or waiting for the callback included. */
  ms: number;
}

export interface ClipToAnalyze {
  clipId: string;
  /** Absolute path of the clip (normally the proxy under RUNS_DIR/<run>/proxies/). */
  file: string;
  duration: number;
}

export interface FrameAnalystOptions {
  url?: string;
  secret?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  pollMs?: number;
  /** Public https origin this app is reachable at; the webhook fetches the clip and the stills from here. */
  publicUrl?: string;
  runsDir?: string;
  /** Stills to sample from the clip for the payload (default NEBULA_FRAME_FRAMES; 0 sends the clip URL only). */
  frames?: number;
  /** Where a callback is awaited. Default: the process-wide `callbacks` registry the route serves; null disables callbacks. */
  callbacks?: CallbackRegistry | null;
  /** Test hook: replaces the real sleep between polls. */
  sleep?: (ms: number) => Promise<void>;
}

/** A clip's analysis, however it is produced. The local editor only depends on this signature. */
export type FrameAnalyzer = (clip: ClipToAnalyze) => Promise<FrameAnalysis>;

export const FRAME_ANALYST_LABEL = "Nebula Frame Analyst webhook";

// ---------------------------------------------------------------------------
// Callbacks: one pending analysis per minted job id, resolved by the callback route

export type CallbackOutcome = "resolved" | "unknown" | "forbidden";

interface Pending {
  clipId: string;
  token: string;
  resolve: (body: unknown) => void;
}

export class CallbackRegistry {
  private readonly pending = new Map<string, Pending>();

  /** Mint a job id + token for one request and the promise its callback will settle. */
  register(clipId: string): { jobId: string; token: string; promise: Promise<unknown> } {
    const jobId = randomBytes(8).toString("hex");
    const token = randomBytes(16).toString("hex");
    let resolve!: (body: unknown) => void;
    const promise = new Promise<unknown>((r) => {
      resolve = r;
    });
    this.pending.set(jobId, { clipId, token, resolve });
    return { jobId, token, promise };
  }

  /** The route calls this with whatever was POSTed. Only the first matching callback counts. */
  resolve(jobId: string, token: string, body: unknown): CallbackOutcome {
    const p = this.pending.get(jobId);
    if (!p) return "unknown";
    if (p.token !== token) return "forbidden";
    this.pending.delete(jobId);
    p.resolve(body);
    return "resolved";
  }

  forget(jobId: string): void {
    this.pending.delete(jobId);
  }

  get size(): number {
    return this.pending.size;
  }
}

/** The registry behind POST /api/frame-analysis/callback/<job>/<token>. */
export const callbacks = new CallbackRegistry();

export function callbackUrlFor(jobId: string, token: string, publicUrl = PUBLIC_URL): string {
  return `${publicUrl}/api/frame-analysis/callback/${jobId}/${token}`;
}

// ---------------------------------------------------------------------------
// Request

/**
 * The public URL the webhook downloads a run file from: RUNS_DIR/<run>/<rel> is served by
 * GET /api/runs/<run>/files/<rel>. Throws when the file is not inside RUNS_DIR or there is no public origin.
 */
export function clipUrlFor(file: string, runsDir = RUNS_DIR, publicUrl = PUBLIC_URL): string {
  if (!publicUrl) throw new Error("PUBLIC_URL is not set; the Frame Analyst webhook needs a public origin to fetch the clip from");
  const rel = path.relative(runsDir, path.resolve(file));
  const parts = rel.split(path.sep);
  if (rel.startsWith("..") || path.isAbsolute(rel) || parts.length < 2) {
    throw new Error(`clip ${file} is not inside RUNS_DIR (${runsDir}), so it has no public URL`);
  }
  const [runId, ...rest] = parts;
  return `${publicUrl}/api/runs/${encodeURIComponent(runId)}/files/${rest.map(encodeURIComponent).join("/")}`;
}

/** RUNS_DIR/<run>/<rel> -> [run, rel]; null when the file is outside RUNS_DIR. */
function locate(file: string, runsDir: string): { runId: string; rel: string } | null {
  const rel = path.relative(runsDir, path.resolve(file));
  const parts = rel.split(path.sep);
  if (rel.startsWith("..") || path.isAbsolute(rel) || parts.length < 2) return null;
  return { runId: parts[0], rel };
}

export interface Still {
  /** Seconds into the clip. */
  t: number;
  file: string;
}

/**
 * Sample `count` JPEG stills evenly over the clip (frame k at k * duration / count) into
 * RUNS_DIR/<run>/analysis/frames/<clip>/fNN.jpg, 640px wide, so the webhook can look at the footage
 * without downloading the video. Re-used when already present.
 */
export async function extractFrames(clip: ClipToAnalyze, count: number, runsDir = RUNS_DIR): Promise<Still[]> {
  if (count <= 0) return [];
  const where = locate(clip.file, runsDir);
  if (!where) throw new Error(`clip ${clip.file} is not inside RUNS_DIR (${runsDir}), so its stills have no public URL`);
  const dir = path.join(runsDir, where.runId, "analysis", "frames", clip.clipId);
  await mkdir(dir, { recursive: true });
  const duration = clip.duration > 0 ? clip.duration : 1;
  const step = duration / count;
  const expected = Array.from({ length: count }, (_, i) => path.join(dir, `f${String(i + 1).padStart(2, "0")}.jpg`));
  const have = new Set(await readdir(dir));
  if (!expected.every((f) => have.has(path.basename(f)))) {
    try {
      await execFileAsync(
        "ffmpeg",
        ["-y", "-v", "error", "-i", clip.file, "-vf", `fps=${count}/${duration},scale=640:-2`, "-frames:v", String(count), "-q:v", "4", path.join(dir, "f%02d.jpg")],
        { maxBuffer: EXEC_MAX_BUFFER },
      );
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stderr?: string };
      throw new Error(`ffmpeg could not sample stills from ${clip.clipId}: ${(e.stderr ?? e.message).trim().split("\n").slice(-3).join(" ")}`);
    }
  }
  const made = new Set(await readdir(dir));
  return expected.filter((f) => made.has(path.basename(f))).map((file, i) => ({ t: round3(i * step), file }));
}

export const PROMPT =
  "You are analysing one clip for a video editor. `frames` are JPEG stills from the clip at the given times (seconds). " +
  "Return exactly one JSON object and nothing else: " +
  '{"shots": [[start, end], ...] shot boundaries covering 0 to duration_seconds in order; ' +
  '"frames": [{"t": seconds, "verdict": "keep" | "cut" | "unsure", "note": "a few words"}] one per still; ' +
  '"sound": [[start, end], ...] stretches worth keeping if you can tell from the footage, else []; ' +
  '"words": [{"text", "start", "end"}] only if you can actually hear speech, else []; ' +
  '"summary": one line about the footage}. ' +
  "If a callback_url is given, POST that JSON object as the request body to it (no authentication needed); otherwise answer with it.";

export function requestBody(clip: ClipToAnalyze, clipUrl: string, extras: { frames?: { t: number; url: string }[]; callbackUrl?: string } = {}): Record<string, unknown> {
  return {
    task: "frame-analysis",
    clip: { id: clip.clipId, url: clipUrl, mime_type: "video/mp4", duration_seconds: clip.duration },
    frames: extras.frames ?? [],
    want: ["words", "sound", "shots", "summary"],
    prompt: PROMPT,
    ...(extras.callbackUrl ? { callback_url: extras.callbackUrl } : {}),
  };
}

// ---------------------------------------------------------------------------
// Response

const num = z.coerce.number().finite();
const RegionSchema = z.union([z.tuple([num, num]), z.object({ start: num, end: num }).transform((r): Region => [r.start, r.end])]);
const WordLoose = z
  .object({ text: z.string().optional(), word: z.string().optional(), start: num, end: num })
  .transform((w) => ({ text: (w.text ?? w.word ?? "").trim(), start: w.start, end: w.end }));
const ResultSchema = z.object({
  words: z.array(WordLoose).optional(),
  transcript: z.array(WordLoose).optional(),
  sound: z.array(RegionSchema).optional(),
  speech: z.array(RegionSchema).optional(),
  regions: z.array(RegionSchema).optional(),
  shots: z.array(RegionSchema).optional(),
  scenes: z.array(RegionSchema).optional(),
  summary: z.string().optional(),
  status: z.string().optional(),
});

const ANALYSIS_KEYS = ["words", "transcript", "sound", "speech", "regions", "shots", "scenes"];
const PENDING = /^(pending|queued|running|processing|in_progress|accepted)$/i;
const WRAPPERS = ["result", "output", "data", "analysis", "response", "reply", "content", "text", "message"];

/** Unwrap { result: {...} }, { reply: "```json ... ```" } and friends down to the object that holds the analysis. */
export function unwrapResult(body: unknown, depth = 0): unknown {
  if (depth > 6) return body;
  if (typeof body === "string") {
    try {
      return unwrapResult(extractJson(body), depth + 1);
    } catch {
      return body;
    }
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const o = body as Record<string, unknown>;
  if (ANALYSIS_KEYS.some((k) => k in o)) return o;
  for (const k of WRAPPERS) {
    if (k in o && o[k] != null) {
      const inner = unwrapResult(o[k], depth + 1);
      if (inner && typeof inner === "object") return inner;
    }
  }
  return o;
}

/** True when the body, unwrapped, carries any analysis key at all (as opposed to an acknowledgment or a status). */
export function holdsAnalysis(body: unknown): boolean {
  const inner = unwrapResult(body);
  return !!inner && typeof inner === "object" && ANALYSIS_KEYS.some((k) => k in (inner as object));
}

function clampRegions(regions: Region[] | undefined, duration: number): Region[] {
  const max = duration > 0 ? duration : Infinity;
  const out: Region[] = [];
  for (const [a, b] of regions ?? []) {
    const start = Math.max(0, Math.min(a, b));
    const end = Math.min(max, Math.max(a, b));
    if (end - start >= 0.05) out.push([round3(start), round3(end)]);
  }
  return out.sort((x, y) => x[0] - y[0]);
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Validate and normalise a webhook result for one clip. Throws on a body that holds no analysis at all. */
export function parseAnalysis(body: unknown, duration: number, source: string, ms: number, how: Pick<FrameAnalysis, "via" | "frames"> = { via: "response", frames: 0 }): FrameAnalysis {
  const inner = unwrapResult(body);
  const parsed = ResultSchema.safeParse(inner);
  if (!parsed.success) throw new Error(`Frame Analyst returned no usable analysis: ${parsed.error.issues[0]?.message ?? "unrecognised body"}`);
  const r = parsed.data;
  const max = duration > 0 ? duration : Infinity;
  const words: Word[] = [];
  for (const w of r.words ?? r.transcript ?? []) {
    if (!w.text) continue;
    const start = Math.max(0, w.start);
    const end = Math.min(max, Math.max(start + 0.02, w.end));
    if (end > start) words.push({ text: w.text, start: round3(start), end: round3(end) });
  }
  words.sort((a, b) => a.start - b.start);
  const sound = clampRegions(r.sound ?? r.speech ?? r.regions, duration);
  const shots = clampRegions(r.shots ?? r.scenes, duration);
  if (words.length === 0 && sound.length === 0 && shots.length === 0 && !holdsAnalysis(inner)) {
    throw new Error("Frame Analyst returned no usable analysis: no words, sound or shots in the body");
  }
  return { words, sound, shots, ...(r.summary ? { summary: r.summary } : {}), source, via: how.via, frames: how.frames, ms };
}

// ---------------------------------------------------------------------------
// The round trip

function isPending(body: unknown): boolean {
  return !!body && typeof body === "object" && PENDING.test(String((body as Record<string, unknown>).status ?? ""));
}

function statusUrlOf(body: unknown, base: string): string | null {
  if (!body || typeof body !== "object") return null;
  const o = body as Record<string, unknown>;
  for (const k of ["status_url", "statusUrl", "result_url", "resultUrl", "poll_url", "pollUrl", "url"]) {
    if (typeof o[k] === "string" && o[k]) return new URL(o[k] as string, base).toString();
  }
  return null;
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const brief = (body: unknown) => (typeof body === "string" ? body.slice(0, 300) : JSON.stringify(body)?.slice(0, 300));

/**
 * One clip through the webhook: sample stills, POST, then take the result from the response, from the
 * status URL it points at, or from the callback the agent posts to.
 */
export async function analyzeClip(clip: ClipToAnalyze, opts: FrameAnalystOptions = {}): Promise<FrameAnalysis> {
  const url = opts.url ?? FRAME_ANALYST_URL;
  if (!url) throw new Error("NEBULA_FRAME_WEBHOOK_URL is not set");
  const secret = opts.secret ?? FRAME_ANALYST_SECRET;
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? FRAME_ANALYST_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? FRAME_ANALYST_POLL_MS;
  const runsDir = opts.runsDir ?? RUNS_DIR;
  const publicUrl = opts.publicUrl ?? PUBLIC_URL;
  const registry = opts.callbacks === undefined ? callbacks : opts.callbacks;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const clipUrl = clipUrlFor(clip.file, runsDir, publicUrl);
  const stills = await extractFrames(clip, opts.frames ?? FRAME_ANALYST_FRAMES, runsDir);
  const frames = stills.map((s) => ({ t: s.t, url: clipUrlFor(s.file, runsDir, publicUrl) }));
  const how = { frames: frames.length };

  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  if (secret) {
    headers["x-webhook-secret"] = secret;
    headers.authorization = `Bearer ${secret}`;
  }
  const pollHeaders = { accept: headers.accept, ...(secret ? { authorization: headers.authorization } : {}) };

  const t0 = performance.now();
  const deadline = t0 + timeoutMs;
  const remaining = () => Math.max(1000, Math.ceil(deadline - performance.now()));
  const signalFor = () => AbortSignal.timeout(remaining());
  const elapsed = () => Math.round(performance.now() - t0);

  // A network failure is a bare "TypeError: fetch failed" from undici; name the webhook so the run's warning does.
  const unreachable = (target: string) => (err: unknown) => {
    const cause = (err as { cause?: { message?: string } })?.cause?.message;
    throw new Error(`Frame Analyst webhook ${target} unreachable: ${cause ?? (err instanceof Error ? err.message : String(err))}`);
  };

  const pending = registry ? registry.register(clip.clipId) : null;
  try {
    const callbackUrl = pending ? callbackUrlFor(pending.jobId, pending.token, publicUrl) : undefined;
    let res = await doFetch(url, { method: "POST", headers, body: JSON.stringify(requestBody(clip, clipUrl, { frames, callbackUrl })), signal: signalFor() }).catch(unreachable(url));
    let body = await readBody(res);
    if (!res.ok && res.status !== 202) throw new Error(`Frame Analyst webhook ${res.status}: ${brief(body)}`);

    // 1. The result itself, right away.
    if (holdsAnalysis(body) && !isPending(body)) return parseAnalysis(body, clip.duration, url, elapsed(), { via: "response", ...how });

    // 2. Somewhere to poll.
    let pollUrl = statusUrlOf(body, url);
    if (pollUrl) {
      while (pollUrl) {
        if (performance.now() > deadline) throw new Error(`Frame Analyst did not finish ${clip.clipId} within ${Math.round(timeoutMs / 1000)}s`);
        await sleep(pollMs);
        res = await doFetch(pollUrl, { method: "GET", headers: pollHeaders, signal: signalFor() }).catch(unreachable(pollUrl));
        body = await readBody(res);
        if (res.status === 202 || isPending(body)) {
          pollUrl = statusUrlOf(body, pollUrl) ?? pollUrl;
          continue;
        }
        if (!res.ok) throw new Error(`Frame Analyst status ${res.status}: ${brief(body)}`);
        pollUrl = null;
      }
      return parseAnalysis(body, clip.duration, url, elapsed(), { via: "poll", ...how });
    }

    // 3. An acknowledgment (Nebula: { success, message }): the agent will POST to callback_url.
    if (!pending) throw new Error(`Frame Analyst webhook answered ${res.status} without a result, a status_url to poll, or a callback to wait for: ${brief(body)}`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Frame Analyst did not call back for ${clip.clipId} within ${Math.round(timeoutMs / 1000)}s (webhook said ${res.status}: ${brief(body)})`)), remaining());
    });
    try {
      body = await Promise.race([pending.promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
    return parseAnalysis(body, clip.duration, url, elapsed(), { via: "callback", ...how });
  } finally {
    if (pending) registry?.forget(pending.jobId);
  }
}

/**
 * The analyzer the local editor uses when FRAME_ANALYSIS=nebula: `analyzeClip` with the configured
 * webhook, one call per clip file (cached), and the raw result kept at RUNS_DIR/<run>/analysis/<clip>.json
 * as evidence of where the analysis came from and how it arrived.
 */
export function createFrameAnalyst(opts: FrameAnalystOptions = {}): FrameAnalyzer {
  const cache = new Map<string, Promise<FrameAnalysis>>();
  return (clip) => {
    let p = cache.get(clip.file);
    if (!p) {
      p = analyzeClip(clip, opts).then(async (a) => {
        console.log(`[frame-analyst] ${clip.clipId}: ${a.words.length} words, ${a.sound.length} sound region(s), ${a.shots.length} shot(s) from ${a.source} via ${a.via} (${a.frames} stills) in ${a.ms}ms`);
        await saveEvidence(clip, a, opts.runsDir ?? RUNS_DIR).catch((err) => console.warn(`[frame-analyst] could not save analysis for ${clip.clipId}: ${String(err)}`));
        return a;
      });
      cache.set(clip.file, p);
      p.catch(() => cache.delete(clip.file));
    }
    return p;
  };
}

async function saveEvidence(clip: ClipToAnalyze, a: FrameAnalysis, runsDir: string): Promise<void> {
  const where = locate(clip.file, runsDir);
  if (!where) return;
  const dir = path.join(runsDir, where.runId, "analysis");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${clip.clipId}.json`), JSON.stringify({ ...a, at: new Date().toISOString() }, null, 2));
}
