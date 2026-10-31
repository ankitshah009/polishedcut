// Generated B-roll: Gemini Omni Flash makes a short shot from a prompt (text-to-video) or from a
// Nano Banana keyframe (image-to-video). The result is normalised to the output frame/fps/codecs so
// the renderer, linter and UI treat it exactly like uploaded footage.
//
// API shape (Interactions, @google/genai >= 2.29): interactions.create({ model: "gemini-omni-1.1-flash",
// input: string | [{type:"image",data,mime_type},{type:"text",text}], response_format: {type:"video",
// aspect_ratio, resolution, delivery, duration?} }). The call is synchronous by default and the video
// comes back inline as output_video.data (base64 mp4). With delivery:"uri" (needed above ~4MB) the
// video is a Files API resource: poll files.get until ACTIVE, then files.download.
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { GoogleGenAI } from "@google/genai";

import { generateStill } from "./art";
import { EXEC_MAX_BUFFER, OUTPUT } from "./config";
import { NO_KEY_MESSAGE, geminiKeys, newGenAI, withRetry } from "./gemini";
import { reportUsage } from "./usage-context";

const execFileAsync = promisify(execFile);

export const OMNI_MODEL = process.env.OMNI_MODEL ?? "gemini-omni-1.1-flash";

/** Generated shots are between these lengths (the EDL schema enforces the same range). Seconds. */
export const MIN_SHOT_SECONDS = 2;
export const MAX_SHOT_SECONDS = 8;

/** How long to wait for an asynchronous interaction or a URI-delivered file to become ready. */
export const GENERATE_CAP_MS = 10 * 60 * 1000;
const POLL_MS = 5000;

export interface ShotOptions {
  prompt: string;
  seconds: number;
  /** Absolute path of a still to animate (image-to-video). Omit for text-to-video. */
  keyframe?: string;
  /** Absolute path of the normalised MP4 to write. */
  outFile: string;
}

export interface ShotResult {
  file: string;
  /** Actual duration of the written file (ffprobe). */
  seconds: number;
  model: string;
}

/** The slice of GoogleGenAI that generateShot uses; tests pass a fake. */
export interface BrollClient {
  interactions: {
    create(params: never): Promise<unknown>;
    get?(params: { id: string }): Promise<unknown>;
  };
  files?: {
    get(params: { name: string }): Promise<unknown>;
    download(params: { file: string; downloadPath: string }): Promise<void>;
  };
}

type VideoBlock = { type?: string; data?: string; uri?: string; mime_type?: string };

export interface GeneratedVideo {
  data?: Buffer;
  uri?: string;
  mimeType: string;
}

function defaultClient(): BrollClient {
  const apiKey = geminiKeys()[0]?.[1];
  if (!apiKey) throw new Error(NO_KEY_MESSAGE);
  return newGenAI(apiKey) as unknown as BrollClient;
}

function clampSeconds(seconds: number): number {
  if (!Number.isFinite(seconds)) return MIN_SHOT_SECONDS;
  return Math.min(MAX_SHOT_SECONDS, Math.max(MIN_SHOT_SECONDS, seconds));
}

/** The prompt Omni sees: the editor's description plus the length, framing and "no text" guard rails. */
export function shotPrompt(prompt: string, seconds: number): string {
  const n = Math.round(clampSeconds(seconds));
  return (
    `${prompt.trim()} ` +
    `A single continuous ${n} second shot, 16:9 landscape, cinematic, high quality. ` +
    "No text, captions, subtitles, logos or watermarks. Ambient sound only, no speech."
  );
}

/**
 * Build the Interactions request. With a keyframe the image goes first and the text asks the model
 * to animate it (image-to-video); otherwise the prompt alone is sent (text-to-video).
 * `duration` is the SDK's optional hint ("4s"); callers drop it when the server rejects it.
 */
export function shotRequest(
  opts: Pick<ShotOptions, "prompt" | "seconds">,
  keyframe?: { data: string; mimeType: string },
  withDuration = true,
): Record<string, unknown> {
  const text = keyframe
    ? `Animate this image as the first frame. ${shotPrompt(opts.prompt, opts.seconds)}`
    : shotPrompt(opts.prompt, opts.seconds);
  const input = keyframe
    ? [{ type: "image", data: keyframe.data, mime_type: keyframe.mimeType }, { type: "text", text }]
    : text;
  const n = Math.round(clampSeconds(opts.seconds));
  return {
    model: OMNI_MODEL,
    input,
    store: false,
    background: false,
    response_format: {
      type: "video",
      aspect_ratio: "16:9",
      resolution: "720p",
      delivery: "inline",
      ...(withDuration ? { duration: `${n}s` } : {}),
    },
    ...(keyframe ? { generation_config: { video_config: { task: "image_to_video" } } } : {}),
  };
}

/**
 * Pull the video out of an Interaction: `output_video` first (SDK convenience field), then the raw
 * steps[]/outputs[] content blocks. Returns inline bytes or a Files API uri.
 */
export function extractVideo(interaction: unknown): GeneratedVideo | null {
  const r = interaction as {
    output_video?: VideoBlock;
    steps?: Array<{ type?: string; content?: VideoBlock[] }>;
    outputs?: Array<{ content?: VideoBlock[] }>;
  };
  const blocks: Array<VideoBlock | undefined> = [
    r.output_video,
    ...(r.steps ?? []).filter((s) => !s.type || s.type === "model_output").flatMap((s) => s.content ?? []),
    ...(r.outputs ?? []).flatMap((o) => o.content ?? []),
  ];
  for (const b of blocks) {
    if (!b || (b.type && b.type !== "video")) continue;
    const mimeType = b.mime_type ?? "video/mp4";
    if (typeof b.data === "string" && b.data.length > 0) return { data: Buffer.from(b.data, "base64"), mimeType };
    if (typeof b.uri === "string" && b.uri) return { uri: b.uri, mimeType };
  }
  return null;
}

function statusOf(x: unknown): string {
  return String((x as { status?: unknown })?.status ?? "");
}

function fileState(f: unknown): string {
  const s = (f as { state?: unknown })?.state;
  return typeof s === "object" && s ? String((s as { name?: unknown }).name ?? "") : String(s ?? "");
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** If the server answered with a queued/in-progress interaction, poll interactions.get until it settles. */
async function settle(ai: BrollClient, interaction: unknown, deadline: number): Promise<unknown> {
  let cur = interaction;
  while (["queued", "in_progress"].includes(statusOf(cur))) {
    const id = (cur as { id?: string }).id;
    if (!id || !ai.interactions.get) throw new Error(`${OMNI_MODEL}: interaction is ${statusOf(cur)} and cannot be polled`);
    if (Date.now() > deadline) throw new Error(`${OMNI_MODEL}: generation did not finish within ${GENERATE_CAP_MS / 60000} minutes`);
    await sleep(POLL_MS);
    cur = await withRetry(() => ai.interactions.get!({ id }), { label: "interactions.get" });
  }
  const status = statusOf(cur);
  if (status && status !== "completed") {
    const err = (cur as { error?: { message?: string } }).error?.message;
    throw new Error(`${OMNI_MODEL}: interaction ${status}${err ? `: ${err}` : ""}`);
  }
  return cur;
}

/** Wait for a URI-delivered video to be ACTIVE in the Files API, then download it to `dst`. */
async function downloadUri(ai: BrollClient, uri: string, dst: string, deadline: number): Promise<void> {
  if (!ai.files) throw new Error(`${OMNI_MODEL}: uri delivery needs a Files API client`);
  const m = /files\/([A-Za-z0-9_-]+)/.exec(uri);
  if (!m) throw new Error(`${OMNI_MODEL}: unexpected video uri ${uri}`);
  const name = `files/${m[1]}`;
  for (;;) {
    const f = await withRetry(() => ai.files!.get({ name }), { label: "files.get" });
    const state = fileState(f);
    if (state === "ACTIVE") break;
    if (state === "FAILED") throw new Error(`${OMNI_MODEL}: generated file ${name} failed`);
    if (Date.now() > deadline) throw new Error(`${OMNI_MODEL}: file ${name} never became ACTIVE`);
    await sleep(POLL_MS);
  }
  await withRetry(() => ai.files!.download({ file: name, downloadPath: dst }), { label: "files.download" });
}

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

async function probe(file: string): Promise<{ seconds: number; audio: boolean }> {
  const out = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", file]);
  const j = JSON.parse(out) as { format?: { duration?: string }; streams?: Array<{ codec_type?: string }> };
  const seconds = Number(j.format?.duration);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`generated video ${file} has no duration`);
  return { seconds, audio: (j.streams ?? []).some((s) => s.codec_type === "audio") };
}

/**
 * Re-encode `src` to OUTPUT size/fps, h264 + aac (silent track added when the model gave none),
 * trimmed to at most `seconds`, so it concatenates with real footage without surprises.
 */
export async function normaliseShot(src: string, dst: string, seconds: number): Promise<number> {
  const { width: W, height: H, fps } = OUTPUT;
  const { audio } = await probe(src);
  const args = ["-y", "-v", "error", "-i", src];
  if (!audio) args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
  args.push(
    "-t", seconds.toFixed(3),
    "-vf", `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${fps},format=yuv420p`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
    "-map", "0:v:0", "-map", audio ? "0:a:0" : "1:a:0",
    "-shortest", "-movflags", "+faststart", dst,
  );
  await run("ffmpeg", args);
  return (await probe(dst)).seconds;
}

function mimeOf(file: string): string {
  return /\.jpe?g$/i.test(file) ? "image/jpeg" : /\.webp$/i.test(file) ? "image/webp" : "image/png";
}

function rejectsDuration(err: unknown): boolean {
  const status = (err as { status?: unknown })?.status;
  const msg = err instanceof Error ? err.message : String(err);
  return (status === 400 || status === undefined) && /duration/i.test(msg);
}

/**
 * Generate one shot with Omni and write it, normalised, to `outFile`. Image-to-video when a
 * keyframe is given, text-to-video otherwise. Waits for asynchronous or URI-delivered results
 * (10-minute cap). Throws on any failure; the loop turns that into a warning.
 */
export async function generateShot(opts: ShotOptions, client?: BrollClient): Promise<ShotResult> {
  if (!opts.prompt.trim()) throw new Error("generateShot: empty prompt");
  const seconds = clampSeconds(opts.seconds);
  const ai = client ?? defaultClient();
  const keyframe = opts.keyframe
    ? { data: (await readFile(opts.keyframe)).toString("base64"), mimeType: mimeOf(opts.keyframe) }
    : undefined;
  const deadline = Date.now() + GENERATE_CAP_MS;

  let withDuration = true;
  const video = await withRetry(async () => {
    const started = Date.now();
    let r: unknown;
    try {
      r = await ai.interactions.create(shotRequest(opts, keyframe, withDuration) as never);
    } catch (err) {
      if (!withDuration || !rejectsDuration(err)) throw err;
      withDuration = false; // the server does not know the duration hint: ask again without it
      r = await ai.interactions.create(shotRequest(opts, keyframe, false) as never);
    }
    const done = await settle(ai, r, deadline);
    reportUsage(OMNI_MODEL, done, started);
    const v = extractVideo(done);
    if (!v) throw new Error(`${OMNI_MODEL}: no video in response`);
    return v;
  }, { label: `${OMNI_MODEL} (video)`, attempts: 2 });

  await mkdir(path.dirname(path.resolve(opts.outFile)), { recursive: true });
  const raw = `${opts.outFile}.raw.mp4`;
  if (video.data) await writeFile(raw, video.data);
  else await downloadUri(ai, video.uri!, raw, deadline);
  try {
    const got = await normaliseShot(raw, opts.outFile, seconds);
    return { file: opts.outFile, seconds: got, model: OMNI_MODEL };
  } finally {
    await rm(raw, { force: true });
  }
}

/**
 * The loop's default generator: paint a Nano Banana keyframe from the prompt first, then animate it
 * (image-to-video) so the shot shares the title card's look; if the still fails, fall back to
 * text-to-video. `keyframeFile` defaults to the shot's path with a .png extension.
 */
export async function generateBroll(
  opts: ShotOptions & { keyframeFile?: string },
  deps: { still?: typeof generateStill; shot?: typeof generateShot } = {},
): Promise<ShotResult> {
  const still = deps.still ?? generateStill;
  const shot = deps.shot ?? generateShot;
  let keyframe: string | undefined;
  if (!opts.keyframe) {
    const file = opts.keyframeFile ?? opts.outFile.replace(/\.mp4$/i, "") + ".png";
    try {
      keyframe = await still(`${opts.prompt.trim()} First frame of a video shot, 16:9, no text.`, file);
    } catch {
      keyframe = undefined;
    }
  }
  return shot({ ...opts, keyframe: opts.keyframe ?? keyframe });
}
