import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { GoogleGenAI } from "@google/genai";
import { z } from "zod";

import { GEMINI_CONCURRENCY, KEEP_UPLOADS, LLM_TIMEOUT_MS, MODELS, RUNS_DIR, isRunId, runDir, type OutputSize } from "./config";
import { chooseOutput, probeMedia, type MediaInfo } from "./media";
import { critiquePrompt, draftPrompt } from "./prompts";
import {
  CritiqueSchema,
  EdlDraftSchema,
  EdlSchema,
  WordSchema,
  type Critique,
  type EDL,
  type SourceClip,
  type Word,
} from "./schema";

export interface ClipInput {
  clip: SourceClip;
  file: string; // absolute path of the proxy that is uploaded to the model
}

export interface EditorModel {
  /** Throws when every transcription model fails. */
  transcribe(input: ClipInput): Promise<Word[]>;
  /**
   * Returns a complete EDL: output size and fps are set, cut ids are renumbered c1..cN.
   * `output` fixes the delivery size; without it the footage decides (chooseOutput over the proxies
   * and the brief: landscape 1920x1080, portrait 1080x1920, square 1080x1080).
   */
  draft(brief: string, clips: ClipInput[], output?: OutputSize): Promise<EDL>;
  critique(brief: string, edl: EDL, renderedFile: string, clips: ClipInput[]): Promise<Critique>;
}

/** One model call (or file upload), as recorded on the run for cost estimates. */
export interface UsageRecord {
  /** Model id, or "files.upload" for an upload (no tokens, free). */
  model: string;
  inputTokens: number;
  /** Billable output: generated text plus thinking tokens. */
  outputTokens: number;
  /** Prompt tokens served from the context cache (a subset of inputTokens). */
  cachedTokens: number;
  /** Wall-clock milliseconds of the call, including retries. */
  ms: number;
}

export interface GeminiEditorOptions {
  /** Injected client (tests). Production builds one from the configured key. */
  client?: GoogleGenAI;
  /** Called once per Interactions request and once per file upload. */
  onUsage?: (usage: UsageRecord) => void;
  /**
   * Run the uploads belong to, so deleteUploads(runId) can remove them from the Files API later.
   * Without it the run is inferred from the file path (RUNS_DIR/<runId>/...).
   */
  runId?: string;
}

export const BILLING_URL = "https://aistudio.google.com/billing";
export const CREDITS_EXHAUSTED_MESSAGE = `Gemini credits are exhausted for this key. Top up at ${BILLING_URL}`;

/** HTTP 402 from the API: the key's prepaid credit is gone. Never retried. */
export class CreditsExhaustedError extends Error {
  override name = "CreditsExhaustedError";
  readonly status = 402;
  constructor() {
    super(CREDITS_EXHAUSTED_MESSAGE);
  }
}

type Thinking = "low" | "medium" | "high";
type Part = { type: "text"; text: string } | { type: "video"; uri: string; mime_type: string };
type Client = GoogleGenAI;
type InteractionParams = Parameters<Client["interactions"]["create"]>[0];
type OnUsage = (usage: UsageRecord) => void;

const UPLOAD_CACHE = path.join(RUNS_DIR, ".upload_cache.json");
/** Per-run list of Files API handles, deleted by deleteUploads once the run is over. */
export const UPLOADS_FILE = "uploads.json";
const POLL_MS = 3000;

// ---------------------------------------------------------------------------
// Concurrency gate
// ---------------------------------------------------------------------------

export interface Gate {
  /** Run `fn` once a slot is free; the slot is held until it settles. */
  <T>(fn: () => Promise<T>): Promise<T>;
  readonly limit: number;
  /** Calls running right now. */
  readonly inFlight: number;
  /** Calls waiting for a slot. */
  readonly waiting: number;
}

/**
 * A counting semaphore: at most `limit` calls in flight, the rest queue in FIFO order. Every request
 * to Google (Interactions, Files API) goes through one of these so a run with twenty clips cannot fire
 * twenty transcriptions at once and turn one 429 into a storm of them.
 */
export function createGate(limit: number): Gate {
  if (!(Number.isInteger(limit) && limit >= 1)) throw new Error(`createGate: limit must be a positive integer, got ${limit}`);
  let inFlight = 0;
  const queue: (() => void)[] = [];
  const acquire = () =>
    new Promise<void>((resolve) => {
      if (inFlight < limit) {
        inFlight++;
        resolve();
      } else {
        queue.push(resolve);
      }
    });
  const release = () => {
    const next = queue.shift();
    if (next) next(); // hands the slot straight over: inFlight stays the same
    else inFlight--;
  };
  const gate = (async <T>(fn: () => Promise<T>): Promise<T> => {
    await acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }) as Gate;
  Object.defineProperties(gate, {
    limit: { get: () => limit },
    inFlight: { get: () => inFlight },
    waiting: { get: () => queue.length },
  });
  return gate;
}

/** The process-wide gate, sized by GEMINI_CONCURRENCY. */
export const geminiGate: Gate = createGate(GEMINI_CONCURRENCY);

const TRANSCRIBE_PROMPT =
  "Transcribe all speech in this video with word-level timestamps in seconds from the start of the file. " +
  'Return ONLY a JSON array: [{"text": string, "start": number, "end": number}, ...]. ' +
  "Return [] if there is no speech.";

/** Parse model text as JSON: strips code fences and falls back to the outermost {...} or [...]. */
export function extractJson(text: string): unknown {
  let body = (text ?? "").trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(body);
  if (fenced) body = fenced[1].trim();
  try {
    return JSON.parse(body);
  } catch (err) {
    const starts = [body.indexOf("{"), body.indexOf("[")].filter((i) => i >= 0);
    if (starts.length === 0) throw err;
    const start = Math.min(...starts);
    const end = Math.max(body.lastIndexOf("}"), body.lastIndexOf("]"));
    return JSON.parse(body.slice(start, end + 1));
  }
}

/** JSON Schema for Gemini structured output, derived from the zod schema. */
export function responseSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: "output", unrepresentable: "any" }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

export const RETRY_ATTEMPTS = 4;
const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 4000;
/** A Retry-After longer than this is not honoured verbatim: the attempt waits this long instead. */
export const RETRY_AFTER_MAX_MS = 60_000;
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const NETWORK_ERROR =
  /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|EPIPE|socket hang up|fetch failed|network error|Connection error/i;

/** Thrown for responses that came back fine but are unusable (empty output); always retried. */
export class RetryableError extends Error {
  override name = "RetryableError";
}

export interface RetryOptions {
  /** Short name for the log line, e.g. "files.upload". */
  label: string;
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Clock for Retry-After dates (tests). */
  now?: () => number;
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  const h = headers as { get?: (k: string) => string | null } & Record<string, unknown>;
  if (typeof h.get === "function") return h.get(name) ?? undefined;
  for (const [k, v] of Object.entries(h)) if (k.toLowerCase() === name && typeof v === "string") return v;
  return undefined;
}

/**
 * How long the server asked us to wait, in ms, or undefined. Looks at a Retry-After header (seconds
 * or an HTTP date) on the error or its response, then at the message Google puts on 429s
 * ("Please retry in 23.4s", `"retryDelay": "23s"`). Capped at RETRY_AFTER_MAX_MS.
 */
export function retryAfterMs(err: unknown, now: () => number = Date.now): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const e = err as { headers?: unknown; response?: { headers?: unknown }; message?: unknown; retryAfter?: unknown };
  let ms: number | undefined;
  const header = headerValue(e.headers, "retry-after") ?? headerValue(e.response?.headers, "retry-after");
  if (header !== undefined) {
    const secs = Number(header);
    if (Number.isFinite(secs)) ms = secs * 1000;
    else {
      const date = Date.parse(header);
      if (Number.isFinite(date)) ms = date - now();
    }
  } else if (typeof e.retryAfter === "number") {
    ms = e.retryAfter * 1000;
  } else if (typeof e.message === "string") {
    const m = /retry(?:\s+again)?\s+in\s+(\d+(?:\.\d+)?)\s*s\b/i.exec(e.message) ?? /retryDelay"?\s*:\s*"?(\d+(?:\.\d+)?)s/i.exec(e.message);
    if (m) ms = Number(m[1]) * 1000;
  }
  if (ms === undefined || !Number.isFinite(ms)) return undefined;
  return Math.min(RETRY_AFTER_MAX_MS, Math.max(0, Math.round(ms)));
}

function statusOf(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const { status, statusCode } = err as { status?: unknown; statusCode?: unknown };
  for (const v of [status, statusCode]) if (typeof v === "number" && v >= 100 && v < 600) return v;
  return undefined;
}

/** Message plus the cause chain, so Node's `TypeError: fetch failed { cause: { code } }` is visible. */
function errorText(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 4; depth++) {
    if (cur instanceof Error) {
      parts.push(cur.message);
      const code = (cur as { code?: unknown }).code;
      if (typeof code === "string") parts.push(code);
      cur = cur.cause;
    } else if (typeof cur === "object") {
      const o = cur as { message?: unknown; code?: unknown; cause?: unknown };
      if (typeof o.message === "string") parts.push(o.message);
      if (typeof o.code === "string") parts.push(o.code);
      cur = o.cause;
    } else {
      parts.push(String(cur));
      break;
    }
  }
  return parts.join(" ");
}

/** 429/5xx, transport failures and empty outputs are retried; 400/401/403 and other 4xx never are. */
export function isRetryable(err: unknown): boolean {
  if (err instanceof RetryableError) return true;
  const status = statusOf(err);
  if (status !== undefined) return RETRY_STATUS.has(status);
  return NETWORK_ERROR.test(errorText(err));
}

/** One line for the log: never contains an API key, bounded in length. */
function describeError(err: unknown): string {
  let text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  for (const [, key] of geminiKeys()) text = text.split(key).join("[redacted]");
  text = text.replace(/([?&]key=)[^&\s"]+/gi, "$1[redacted]").replace(/\s+/g, " ");
  return text.length > 240 ? `${text.slice(0, 240)}...` : text;
}

/** 0.5s, 1s, 2s, 4s (capped) with +/-20% jitter so parallel callers do not stampede. */
function backoffMs(attempt: number): number {
  const base = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempt - 1));
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run `fn` up to `attempts` times, backing off between retryable failures. A Retry-After from the
 * server (header or message) wins over the backoff when it is longer. A 402 becomes CreditsExhaustedError.
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  const attempts = opts.attempts ?? RETRY_ATTEMPTS;
  const sleep = opts.sleep ?? defaultSleep;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (statusOf(err) === 402) throw new CreditsExhaustedError();
      if (attempt >= attempts || !isRetryable(err)) throw err;
      const asked = retryAfterMs(err, opts.now);
      const delay = Math.max(backoffMs(attempt), asked ?? 0);
      const why = asked !== undefined ? ` (server asked for ${asked}ms)` : "";
      console.warn(`[gemini] retry ${opts.label} ${attempt}/${attempts} failed, waiting ${delay}ms${why}: ${describeError(err)}`);
      await sleep(delay);
    }
  }
}

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export type UploadHandle = { uri: string; mimeType: string; name: string };
type Registry = Record<string, UploadHandle>; // sha256 -> handle

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2));
  await rename(tmp, file);
}

const readCache = () => readJson<Registry>(UPLOAD_CACHE, {});

// Writes to each registry file are serialised so parallel uploads never clobber each other's entries.
const writeQueues = new Map<string, Promise<void>>();

function updateJson(file: string, mutate: (current: Registry) => Registry | null, what: string): Promise<void> {
  const next = (writeQueues.get(file) ?? Promise.resolve())
    .then(async () => {
      const updated = mutate(await readJson<Registry>(file, {}));
      if (updated === null) await rm(file, { force: true });
      else await writeJsonAtomic(file, updated);
    })
    .catch((err: unknown) => console.warn(`[gemini] could not save ${what}: ${describeError(err)}`));
  writeQueues.set(file, next);
  return next;
}

function rememberUpload(digest: string, handle: UploadHandle): Promise<void> {
  return updateJson(UPLOAD_CACHE, (cache) => ({ ...cache, [digest]: handle }), "upload cache");
}

function forgetUploads(digests: Iterable<string>): Promise<void> {
  const gone = new Set(digests);
  return updateJson(UPLOAD_CACHE, (cache) => Object.fromEntries(Object.entries(cache).filter(([d]) => !gone.has(d))), "upload cache");
}

function registryFile(runId: string): string {
  return path.join(runDir(runId), UPLOADS_FILE);
}

/** The run a file under RUNS_DIR/<runId>/... belongs to, or null for anything else. */
export function runIdOf(file: string): string | null {
  const rel = path.relative(RUNS_DIR, path.resolve(file));
  const first = rel.split(path.sep)[0];
  return first && !rel.startsWith("..") && isRunId(first) ? first : null;
}

function registerUpload(runId: string | null, digest: string, handle: UploadHandle): Promise<void> {
  if (!runId) return Promise.resolve();
  return updateJson(registryFile(runId), (reg) => ({ ...reg, [digest]: handle }), `upload registry of run ${runId}`);
}

/** Files API handles recorded for a run (empty when it has none, or has already been cleaned up). */
export async function listUploads(runId: string): Promise<UploadHandle[]> {
  return Object.values(await readJson<Registry>(registryFile(runId), {}));
}

function stateOf(file: { state?: unknown }): string {
  return String(file.state ?? "");
}

function fileError(file: { error?: { message?: string; code?: number } }): string {
  const e = file.error;
  return e?.message ? ` (${e.message}${e.code ? `, code ${e.code}` : ""})` : "";
}

// One upload per distinct file content at a time, even when callers ask in parallel.
const inflight = new Map<string, Promise<UploadHandle>>();

/**
 * Upload a proxy (cached by sha256) and wait until the file is ACTIVE. Cache hits report no usage.
 * The handle is recorded in the run's registry (uploads.json) so deleteUploads can remove it later.
 */
async function uploadVideo(ai: Client, file: string, onUsage?: OnUsage, runId: string | null = runIdOf(file)): Promise<UploadHandle> {
  const digest = await sha256(file);
  let pending = inflight.get(digest);
  if (!pending) {
    pending = uploadByDigest(ai, file, digest, onUsage).finally(() => inflight.delete(digest));
    inflight.set(digest, pending);
  }
  const handle = await pending;
  await registerUpload(runId, digest, handle);
  return handle;
}

async function uploadByDigest(ai: Client, file: string, digest: string, onUsage?: OnUsage): Promise<UploadHandle> {
  const cached = (await readCache())[digest];
  if (cached) {
    try {
      const f = await withRetry(() => geminiGate(() => ai.files.get({ name: cached.name })), { label: "files.get" });
      if (stateOf(f) === "ACTIVE") return cached;
    } catch {
      // stale or deleted upload: fall through and upload again
    }
  }

  const base = path.basename(file);
  const started = Date.now();
  let f = await withRetry(() => geminiGate(() => ai.files.upload({ file, config: { mimeType: "video/mp4" } })), { label: "files.upload" });
  onUsage?.({ model: "files.upload", inputTokens: 0, outputTokens: 0, cachedTokens: 0, ms: Date.now() - started });
  const deadline = Date.now() + LLM_TIMEOUT_MS;
  while (stateOf(f) === "PROCESSING") {
    if (Date.now() > deadline) {
      throw new Error(
        `Files API is still processing ${base} after ${Math.round(LLM_TIMEOUT_MS / 1000)}s (LLM_TIMEOUT_MS); ` +
          "the upload was not used. Try again, or raise LLM_TIMEOUT_MS for very long clips.",
      );
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
    const name = f.name!;
    f = await withRetry(() => geminiGate(() => ai.files.get({ name })), { label: "files.get" });
  }
  if (stateOf(f) === "FAILED") {
    throw new Error(`Files API rejected ${base}${fileError(f)}: the file could not be processed as video/mp4`);
  }
  if (stateOf(f) !== "ACTIVE") throw new Error(`upload of ${base} ended in state ${stateOf(f) || "unknown"}${fileError(f)}`);

  const handle: UploadHandle = { uri: f.uri!, mimeType: f.mimeType ?? "video/mp4", name: f.name! };
  await rememberUpload(digest, handle);
  return handle;
}

export interface DeleteUploadsResult {
  /** Files API names that are gone (deleted now, or already absent). */
  deleted: string[];
  /** Names the API would not delete; they stay in the registry for a later attempt. */
  failed: string[];
}

/**
 * Delete every Files API upload recorded for `runId` and drop the matching upload-cache entries, so
 * nothing of the footage stays with Google after the run (uploads otherwise expire after 48 hours).
 * A 404/403 counts as deleted. Without a registry (no uploads, or already cleaned) it is a no-op and
 * needs no key. Idempotent; the registry file is removed once every handle is gone.
 */
export async function deleteUploads(runId: string, client?: Client): Promise<DeleteUploadsResult> {
  const file = registryFile(runId);
  const reg = await readJson<Registry>(file, {});
  const result: DeleteUploadsResult = { deleted: [], failed: [] };
  const entries = Object.entries(reg);
  if (entries.length === 0) {
    await rm(file, { force: true });
    return result;
  }
  const ai = client ?? defaultClient();
  if (!ai) {
    result.failed = entries.map(([, h]) => h.name);
    console.warn(`[gemini] cannot delete ${entries.length} upload(s) of run ${runId}: no API key is configured`);
    return result;
  }
  const gone: string[] = [];
  await Promise.all(
    entries.map(async ([digest, h]) => {
      try {
        await withRetry(() => geminiGate(() => ai.files.delete({ name: h.name })), { label: "files.delete", attempts: 2 });
        result.deleted.push(h.name);
        gone.push(digest);
      } catch (err) {
        const status = statusOf(err);
        if (status === 404 || status === 403) {
          result.deleted.push(h.name);
          gone.push(digest);
        } else {
          result.failed.push(h.name);
          console.warn(`[gemini] could not delete upload ${h.name} of run ${runId}: ${describeError(err)}`);
        }
      }
    }),
  );
  await forgetUploads(gone);
  const goneSet = new Set(gone);
  await updateJson(
    file,
    (current) => {
      const left = Object.fromEntries(Object.entries(current).filter(([d]) => !goneSet.has(d)));
      return Object.keys(left).length === 0 ? null : left;
    },
    `upload registry of run ${runId}`,
  );
  return result;
}

/**
 * What a run does with its uploads when it ends: delete them unless KEEP_UPLOADS=1. Never throws;
 * a failure is logged and the registry stays, so the next terminal state (a retry, a revision) tries again.
 */
export async function cleanupRunUploads(runId: string, client?: Client): Promise<DeleteUploadsResult | null> {
  if (KEEP_UPLOADS) return null;
  try {
    const r = await deleteUploads(runId, client);
    if (r.deleted.length > 0) console.log(`[gemini] run ${runId}: deleted ${r.deleted.length} upload(s) from the Files API`);
    return r;
  } catch (err) {
    console.warn(`[gemini] run ${runId}: upload cleanup failed: ${describeError(err)}`);
    return null;
  }
}

function videoPart(h: UploadHandle): Part {
  return { type: "video", uri: h.uri, mime_type: h.mimeType };
}

// ---------------------------------------------------------------------------
// Model calls
// ---------------------------------------------------------------------------

/** Calls here never stream, so the result is always an Interaction with output_text. */
function outputText(r: unknown): string {
  return (r as { output_text?: string }).output_text ?? "";
}

type InteractionUsage = {
  total_input_tokens?: number;
  total_output_tokens?: number;
  total_thought_tokens?: number;
  total_cached_tokens?: number;
};

/** Map the Interactions `usage` block to a UsageRecord. Thinking tokens are billed as output, so they are folded in. */
export function usageRecord(model: string, usage: InteractionUsage | undefined, ms: number): UsageRecord {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    model,
    inputTokens: n(usage?.total_input_tokens),
    outputTokens: n(usage?.total_output_tokens) + n(usage?.total_thought_tokens),
    cachedTokens: n(usage?.total_cached_tokens),
    ms,
  };
}

/**
 * One Interactions request with retries; an empty reply counts as a failure and is retried too.
 * Usage is reported once per successful response (failed attempts return no usage block).
 */
async function interact(
  ai: Client,
  params: InteractionParams,
  label: string,
  onUsage?: OnUsage,
  retryEmpty = true,
): Promise<string> {
  const started = Date.now();
  return withRetry(async () => {
    // The gate wraps only the request, never the backoff sleep, so a waiting retry holds no slot.
    const response = (await geminiGate(() => ai.interactions.create(params))) as { output_text?: string; usage?: InteractionUsage };
    onUsage?.(usageRecord(String((params as { model?: unknown }).model ?? ""), response.usage, Date.now() - started));
    const text = outputText(response);
    if (!text.trim()) {
      // Some models (gemini-3.5-transcribe) answer a structured request with nothing at all; the
      // caller falls back to a plain prompt at once instead of paying for retries of the same request.
      if (!retryEmpty) throw new Error(`${label}: empty output_text`);
      throw new RetryableError(`${label}: empty output_text`);
    }
    return text;
  }, { label });
}

/** One model call. Falls back to a plain prompt if the server rejects the structured-output request. */
async function call(
  ai: Client,
  model: string,
  parts: Part[],
  jsonSchema: Record<string, unknown>,
  thinking: Thinking | null,
  onUsage?: OnUsage,
  allowEmpty = false,
): Promise<string> {
  const base = {
    model,
    input: parts,
    store: false,
    ...(thinking ? { generation_config: { thinking_level: thinking } } : {}),
  };
  try {
    return await interact(
      ai,
      {
        ...base,
        response_format: { type: "text", mime_type: "application/json", schema: jsonSchema },
      } as InteractionParams,
      `${model} (structured)`,
      onUsage,
      false,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/schema|response_format|empty output_text/i.test(msg)) throw err;
  }
  // When the caller can read an empty reply as a real answer (a silent clip has no words), one plain
  // attempt is enough; retrying the same request four times only burns time.
  return interact(ai, base as InteractionParams, `${model} (plain)`, onUsage, !allowEmpty);
}

/** Ask for JSON that validates against `schema`. One retry feeds the validation error back. */
async function askJson<T>(
  ai: Client,
  model: string,
  parts: Part[],
  schema: z.ZodType<T>,
  thinking: Thinking | null,
  onUsage?: OnUsage,
  opts: { emptyValue?: T } = {},
): Promise<T> {
  const jsonSchema = responseSchema(schema);
  const allowEmpty = opts.emptyValue !== undefined;
  let text: string;
  try {
    text = await call(ai, model, parts, jsonSchema, thinking, onUsage, allowEmpty);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (allowEmpty && /empty output_text/i.test(msg)) return opts.emptyValue as T;
    throw err;
  }
  const first = schema.safeParse(tryExtract(text));
  if (first.success) return first.data;

  const retry: Part[] = [
    ...parts,
    {
      type: "text",
      text:
        `Your previous reply was:\n${text.slice(0, 4000)}\n\nIt failed validation:\n${first.error.message}\n` +
        "Reply again with ONLY corrected JSON, no prose.",
    },
  ];
  const again = await call(ai, model, retry, jsonSchema, thinking, onUsage);
  return schema.parse(extractJson(again));
}

function tryExtract(text: string): unknown {
  try {
    return extractJson(text);
  } catch {
    return undefined;
  }
}

/** Configured keys in preference order. GEMINI_KEY_ORDER=1 puts GEMINI_API_KEY_1 first. */
export function geminiKeys(): [string, string][] {
  const keys: [string, string][] = [];
  for (const name of ["GEMINI_API_KEY", "GEMINI_API_KEY_1"]) {
    const v = process.env[name];
    if (v && !keys.some(([, k]) => k === v)) keys.push([name, v]);
  }
  return process.env.GEMINI_KEY_ORDER === "1" ? keys.reverse() : keys;
}

function isClient(x: unknown): x is Client {
  return !!x && typeof x === "object" && "interactions" in x && "files" in x;
}

/** A client from the configured key, or undefined when there is none. */
function defaultClient(): Client | undefined {
  const apiKey = geminiKeys()[0]?.[1];
  return apiKey ? new GoogleGenAI({ apiKey, httpOptions: { timeout: LLM_TIMEOUT_MS } }) : undefined;
}

/**
 * Delivery size for a draft: probe the proxies (they keep the footage's orientation) and let
 * chooseOutput weigh them with the brief. A proxy that cannot be probed is skipped; with none left
 * the brief alone decides (landscape when it says nothing).
 */
export async function outputForClips(clips: ClipInput[], brief: string): Promise<OutputSize> {
  const infos = await Promise.all(
    clips.map(async (c): Promise<MediaInfo | null> => {
      try {
        return await probeMedia(c.file);
      } catch {
        return null;
      }
    }),
  );
  return chooseOutput(infos.filter((i): i is MediaInfo => i !== null), brief);
}

/**
 * Build the editor. Accepts a bare client (tests, legacy) or `{ client?, onUsage? }`.
 * With no argument, a client is built from the configured key.
 */
export function createGeminiEditor(clientOrOptions?: Client | GeminiEditorOptions): EditorModel {
  const opts: GeminiEditorOptions = isClient(clientOrOptions) ? { client: clientOrOptions } : (clientOrOptions ?? {});
  const ai = opts.client ?? defaultClient();
  if (!ai) throw new Error("GEMINI_API_KEY is not set. Add it to .env at the repo root.");
  const model = ai;
  const upload = (file: string) => uploadVideo(model, file, onUsage, opts.runId ?? runIdOf(file));
  // A throwing callback must never break the cut; usage is bookkeeping.
  const onUsage: OnUsage | undefined = opts.onUsage
    ? (u) => {
        try {
          opts.onUsage!(u);
        } catch (err) {
          console.warn(`[gemini] onUsage callback failed: ${describeError(err)}`);
        }
      }
    : undefined;

  return {
    async transcribe({ file }) {
      const errors: string[] = [];
      for (const name of [MODELS.transcribe, MODELS.flash]) {
        try {
          const h = await upload(file);
          // An empty reply is how a silent clip comes back: no words, not a failure.
          return await askJson(model, name, [videoPart(h), { type: "text", text: TRANSCRIBE_PROMPT }], z.array(WordSchema), null, onUsage, {
            emptyValue: [] as Word[],
          });
        } catch (err) {
          if (err instanceof CreditsExhaustedError) throw err; // no point trying the fallback model
          errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      throw new Error(`transcription failed (${errors.join("; ")})`);
    },

    async draft(brief, clips, output) {
      // All proxies go up at once; uploadVideo dedupes by content, the gate bounds what is in flight.
      const [handles, size] = await Promise.all([
        Promise.all(clips.map((c) => upload(c.file))),
        output ? Promise.resolve(output) : outputForClips(clips, brief),
      ]);
      const parts: Part[] = [];
      clips.forEach((c, i) => {
        parts.push({ type: "text", text: `Video for clipId=${c.clip.id}:` });
        parts.push(videoPart(handles[i]));
      });
      parts.push({ type: "text", text: draftPrompt(brief, clips) });

      const draft = await askJson(model, MODELS.argon, parts, EdlDraftSchema, "medium", onUsage);
      return EdlSchema.parse({
        ...draft,
        cuts: draft.cuts.map((cut, i) => ({ ...cut, id: `c${i + 1}` })),
        width: size.width,
        height: size.height,
        fps: size.fps,
      });
    },

    async critique(brief, edl, renderedFile, clips) {
      const parts: Part[] = [{ type: "text", text: "RENDERED EDIT:" }];
      parts.push(videoPart(await upload(renderedFile)));
      parts.push({ type: "text", text: critiquePrompt(brief, edl, clips) });
      return askJson(model, MODELS.argon, parts, CritiqueSchema, "medium", onUsage);
    },
  };
}
