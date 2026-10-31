// Music bed: Lyria generates an instrumental clip from a prompt; ffmpeg loops it to the edit's length.
import { execFile } from "node:child_process";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { GoogleGenAI } from "@google/genai";

import { LLM_TIMEOUT_MS } from "./config";
import { geminiKeys, withRetry } from "./gemini";
import { reportUsage } from "./usage-context";
import type { EdlDraftSchema, PatchOp } from "./schema";
import type { z } from "zod";

const execFileAsync = promisify(execFile);

export const LYRIA_MODELS = {
  clip: "lyria-3-clip-preview", // fixed 30s clip
  song: "lyria-3.5", // full song, length steered by the prompt
} as const;

export const CLIP_SECONDS = 30;
const CROSSFADE_SECONDS = 1;
const NO_VOCALS = "Instrumental only, no vocals.";

export interface MusicResult {
  file: string;
  seconds: number; // actual duration of the written file
  model: string;
}

/** The slice of GoogleGenAI that generateMusic uses; tests pass a fake. */
export interface MusicClient {
  interactions: { create(params: never): Promise<unknown> };
}

type Music = z.infer<typeof EdlDraftSchema>["music"];

function musicClient(): MusicClient {
  const apiKey = geminiKeys()[0]?.[1];
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set. Add it to .env at the repo root.");
  return new GoogleGenAI({ apiKey, httpOptions: { timeout: LLM_TIMEOUT_MS } });
}

/** Pick the Lyria model and build the prompt for a bed of `seconds`. Exported for tests. */
export function musicRequest(prompt: string, seconds: number): { model: string; input: string } {
  const base = prompt.trim().replace(/\s+$/, "");
  if (seconds <= CLIP_SECONDS) {
    return { model: LYRIA_MODELS.clip, input: `${base} ${NO_VOCALS}`.trim() };
  }
  const n = Math.ceil(seconds);
  return { model: LYRIA_MODELS.song, input: `${base} The piece is about ${n} seconds long. ${NO_VOCALS}`.trim() };
}

async function run(tool: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(tool, args, { maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { code?: number | string; stderr?: string };
    const tail = (e.stderr ?? e.message).trim().split("\n").slice(-20).join("\n");
    throw new Error(`${tool} failed (exit ${e.code ?? "?"}):\n${tail}`);
  }
}

async function duration(file: string): Promise<number> {
  const out = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", file]);
  const d = Number(JSON.parse(out).format?.duration);
  if (!Number.isFinite(d) || d <= 0) throw new Error(`music file ${file} has no duration`);
  return d;
}

/**
 * Repeat `src` with 1s crossfades (or plain concatenation for very short clips) until the
 * result is at least `seconds` long, encoded as MP3 to `dst`.
 */
export async function loopAudio(src: string, dst: string, seconds: number): Promise<number> {
  const d = await duration(src);
  if (d >= seconds) {
    if (path.resolve(src) !== path.resolve(dst)) await run("ffmpeg", ["-y", "-v", "error", "-i", src, "-c:a", "libmp3lame", "-q:a", "2", dst]);
    return d;
  }
  const xf = d > 3 * CROSSFADE_SECONDS ? CROSSFADE_SECONDS : 0;
  // each extra copy adds (d - xf) seconds
  const copies = 1 + Math.ceil((seconds - d) / (d - xf));
  const inputs: string[] = [];
  for (let i = 0; i < copies; i++) inputs.push("-i", src);
  let graph: string;
  if (xf > 0) {
    const steps: string[] = [];
    let prev = "[0:a]";
    for (let i = 1; i < copies; i++) {
      const out = i === copies - 1 ? "[out]" : `[x${i}]`;
      steps.push(`${prev}[${i}:a]acrossfade=d=${xf}:c1=tri:c2=tri${out}`);
      prev = out;
    }
    graph = steps.join(";");
  } else {
    graph = `${Array.from({ length: copies }, (_, i) => `[${i}:a]`).join("")}concat=n=${copies}:v=0:a=1[out]`;
  }
  await run("ffmpeg", ["-y", "-v", "error", ...inputs, "-filter_complex", graph, "-map", "[out]", "-c:a", "libmp3lame", "-q:a", "2", dst]);
  return duration(dst);
}

/**
 * Generate an instrumental music bed with Lyria and write it as MP3 to `outFile`.
 * Clips up to 30s use the fixed-length clip model; longer beds use lyria-3.5 and ask for the length
 * in the prompt. Whatever comes back is looped to at least `seconds`.
 */
export async function generateMusic(
  prompt: string,
  seconds: number,
  outFile: string,
  client?: MusicClient,
): Promise<MusicResult> {
  if (!(seconds > 0)) throw new Error(`generateMusic: seconds must be positive, got ${seconds}`);
  const ai = client ?? musicClient();
  const { model, input } = musicRequest(prompt, seconds);

  const data = await withRetry(async () => {
    // store: false, like every other call: the prompt and the audio are never kept server side.
    const started = Date.now();
    const r = (await ai.interactions.create({ model, input, store: false, response_format: { type: "audio" } } as never)) as {
      output_audio?: { data?: string; uri?: string };
    };
    reportUsage(model, r, started);
    const b64 = r.output_audio?.data;
    if (!b64) throw new Error(`${model}: response has no inline output_audio.data`);
    return b64;
  }, { label: model });

  await mkdir(path.dirname(path.resolve(outFile)), { recursive: true });
  const raw = `${outFile}.raw.mp3`;
  await writeFile(raw, Buffer.from(data, "base64"));
  const got = await duration(raw);
  let total: number;
  if (got >= seconds) {
    await rename(raw, outFile);
    total = got;
  } else {
    total = await loopAudio(raw, outFile, seconds);
    await rm(raw, { force: true });
  }
  return { file: outFile, seconds: total, model };
}

/**
 * Apply a `set_music` patch to an EDL (draft or full). Pure: returns a new object.
 * text = new prompt (the previous file is dropped so it is regenerated), "" or null = remove the bed.
 * Any other op returns the input unchanged.
 */
export function applyMusicPatch<T extends object>(edl: T, patch: PatchOp): T & { music?: Music } {
  if (patch.op !== "set_music") return edl;
  const prompt = (patch.text ?? "").trim();
  if (!prompt) return { ...edl, music: null };
  const gainDb = (edl as { music?: Music }).music?.gainDb;
  return { ...edl, music: { prompt, ...(gainDb != null ? { gainDb } : {}) } };
}
