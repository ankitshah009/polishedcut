/**
 * Nebula Frame Analyst: per-clip analysis over a webhook instead of whisper.cpp + ffmpeg on this
 * machine, so the work bills Nebula credits. The local editor (lib/local-editor.ts) asks for one
 * analysis per clip and uses it for transcripts, sound regions and shot boundaries.
 *
 * Contract (the Nebula job behind NEBULA_FRAME_WEBHOOK_URL must honour it):
 *
 *   POST <url>            Authorization: Bearer <secret>   (when a secret is configured)
 *   {
 *     "task": "frame-analysis",
 *     "clip": { "id": "clip1", "url": "https://.../api/runs/<run>/files/proxies/clip1.mp4",
 *               "mime_type": "video/mp4", "duration_seconds": 97.6 },
 *     "want": ["words", "sound", "shots"]
 *   }
 *
 *   200 with the result, or 202 with { "status_url": "..." } (also accepted: result_url, poll_url,
 *   url) that is GET-polled until it answers 200 with the result. A body whose "status" is
 *   pending / queued / running keeps polling.
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
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { FRAME_ANALYST_POLL_MS, FRAME_ANALYST_SECRET, FRAME_ANALYST_TIMEOUT_MS, FRAME_ANALYST_URL, PUBLIC_URL, RUNS_DIR } from "./config";
import { extractJson } from "./gemini";
import type { Word } from "./schema";

export type Region = [number, number];

export interface FrameAnalysis {
  words: Word[];
  sound: Region[];
  shots: Region[];
  summary?: string;
  /** Where the analysis came from, for logs and the run folder: the webhook URL. */
  source: string;
  /** Wall-clock milliseconds for the round trip, polling included. */
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
  /** Public https origin this app is reachable at; the webhook fetches the clip from here. */
  publicUrl?: string;
  runsDir?: string;
  /** Test hook: replaces the real sleep between polls. */
  sleep?: (ms: number) => Promise<void>;
}

/** A clip's analysis, however it is produced. The local editor only depends on this signature. */
export type FrameAnalyzer = (clip: ClipToAnalyze) => Promise<FrameAnalysis>;

export const FRAME_ANALYST_LABEL = "Nebula Frame Analyst webhook";

// ---------------------------------------------------------------------------
// Request

/**
 * The public URL the webhook downloads the clip from: RUNS_DIR/<run>/<rel> is served by
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

export function requestBody(clip: ClipToAnalyze, clipUrl: string): Record<string, unknown> {
  return {
    task: "frame-analysis",
    clip: { id: clip.clipId, url: clipUrl, mime_type: "video/mp4", duration_seconds: clip.duration },
    want: ["words", "sound", "shots"],
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
  if ("words" in o || "transcript" in o || "sound" in o || "speech" in o || "regions" in o || "shots" in o || "scenes" in o) return o;
  for (const k of WRAPPERS) {
    if (k in o && o[k] != null) {
      const inner = unwrapResult(o[k], depth + 1);
      if (inner && typeof inner === "object") return inner;
    }
  }
  return o;
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
export function parseAnalysis(body: unknown, duration: number, source: string, ms: number): FrameAnalysis {
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
  const explicit = ["words", "transcript", "sound", "speech", "regions", "shots", "scenes"].some((k) => k in (inner as object));
  if (!explicit) throw new Error("Frame Analyst returned no usable analysis: no words, sound or shots in the body");
  return { words, sound, shots, ...(r.summary ? { summary: r.summary } : {}), source, ms };
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

/** One clip through the webhook: POST, follow a 202 to its status URL, parse the result. */
export async function analyzeClip(clip: ClipToAnalyze, opts: FrameAnalystOptions = {}): Promise<FrameAnalysis> {
  const url = opts.url ?? FRAME_ANALYST_URL;
  if (!url) throw new Error("NEBULA_FRAME_WEBHOOK_URL is not set");
  const secret = opts.secret ?? FRAME_ANALYST_SECRET;
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? FRAME_ANALYST_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? FRAME_ANALYST_POLL_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const clipUrl = clipUrlFor(clip.file, opts.runsDir, opts.publicUrl);
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  if (secret) headers.authorization = `Bearer ${secret}`;

  const t0 = performance.now();
  const deadline = t0 + timeoutMs;
  const signalFor = () => AbortSignal.timeout(Math.max(1000, Math.ceil(deadline - performance.now())));

  let res = await doFetch(url, { method: "POST", headers, body: JSON.stringify(requestBody(clip, clipUrl)), signal: signalFor() });
  let body = await readBody(res);
  if (!res.ok && res.status !== 202) {
    throw new Error(`Frame Analyst webhook ${res.status}: ${typeof body === "string" ? body.slice(0, 300) : JSON.stringify(body)?.slice(0, 300)}`);
  }

  // Asynchronous jobs: 202 (or a pending status) with somewhere to poll.
  let pollUrl = res.status === 202 || isPending(body) ? statusUrlOf(body, url) : null;
  if ((res.status === 202 || isPending(body)) && !pollUrl) {
    throw new Error(`Frame Analyst webhook answered ${res.status} without a status_url to poll`);
  }
  while (pollUrl) {
    if (performance.now() > deadline) throw new Error(`Frame Analyst did not finish ${clip.clipId} within ${Math.round(timeoutMs / 1000)}s`);
    await sleep(pollMs);
    res = await doFetch(pollUrl, { method: "GET", headers: { accept: headers.accept, ...(secret ? { authorization: headers.authorization } : {}) }, signal: signalFor() });
    body = await readBody(res);
    if (res.status === 202 || isPending(body)) {
      pollUrl = statusUrlOf(body, pollUrl) ?? pollUrl;
      continue;
    }
    if (!res.ok) throw new Error(`Frame Analyst status ${res.status}: ${typeof body === "string" ? body.slice(0, 300) : JSON.stringify(body)?.slice(0, 300)}`);
    pollUrl = null;
  }

  return parseAnalysis(body, clip.duration, url, Math.round(performance.now() - t0));
}

/**
 * The analyzer the local editor uses when FRAME_ANALYSIS=nebula: `analyzeClip` with the configured
 * webhook, one call per clip file (cached), and the raw result kept at RUNS_DIR/<run>/analysis/<clip>.json
 * as evidence of where the analysis came from.
 */
export function createFrameAnalyst(opts: FrameAnalystOptions = {}): FrameAnalyzer {
  const cache = new Map<string, Promise<FrameAnalysis>>();
  return (clip) => {
    let p = cache.get(clip.file);
    if (!p) {
      p = analyzeClip(clip, opts).then(async (a) => {
        console.log(`[frame-analyst] ${clip.clipId}: ${a.words.length} words, ${a.sound.length} sound region(s), ${a.shots.length} shot(s) from ${a.source} in ${a.ms}ms`);
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
  const rel = path.relative(runsDir, path.resolve(clip.file));
  const runId = rel.split(path.sep)[0];
  if (!runId || rel.startsWith("..")) return;
  const dir = path.join(runsDir, runId, "analysis");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${clip.clipId}.json`), JSON.stringify({ ...a, at: new Date().toISOString() }, null, 2));
}
