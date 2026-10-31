// Nano Banana paints the title card background: a dark, elegant 16:9 plate with no text, so the
// renderer can draw the title over it. Optional: any failure resolves to null and the title card
// falls back to plain black.
import { execFile } from "node:child_process";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { GoogleGenAI } from "@google/genai";

import { OUTPUT } from "./config";
import { NO_KEY_MESSAGE, geminiKeys, newGenAI, withRetry } from "./gemini";
import { reportUsage } from "./usage-context";

const execFileAsync = promisify(execFile);

export const ART_MODEL = process.env.ART_MODEL ?? "gemini-nano-banana-2.1";

type Client = Pick<GoogleGenAI, "interactions">;

export interface GeneratedImage {
  data: Buffer;
  mimeType: string;
}

export function titleCardPrompt(title: string, brief: string): string {
  const hint = brief.trim() ? ` The video is about: ${brief.trim().slice(0, 300)}.` : "";
  return (
    `Cinematic 16:9 background plate for a video title card titled "${title}".${hint} ` +
    "Dark, elegant, moody and softly lit: deep shadows, subtle gradients, gentle bokeh or atmospheric haze, " +
    "muted colour palette with one restrained accent, lots of calm negative space in the centre. " +
    "Photographic, high-end, film still quality. Absolutely no text, letters, words, logos, watermarks or people."
  );
}

export function endCardPrompt(endTitle: string, brief: string): string {
  const hint = brief.trim() ? ` The video is about: ${brief.trim().slice(0, 300)}.` : "";
  return (
    `Cinematic 16:9 background plate for the closing card of a video; the card will read "${endTitle}".${hint} ` +
    "Dark, calm and resolved: deep shadows, a soft warm glow fading to black at the edges, subtle gradients, " +
    "muted colour palette with one restrained accent, lots of quiet negative space in the centre. " +
    "Photographic, high-end, film still quality. Absolutely no text, letters, words, logos, watermarks or people."
  );
}

function defaultClient(): Client {
  const apiKey = geminiKeys()[0]?.[1];
  if (!apiKey) throw new Error(NO_KEY_MESSAGE);
  return newGenAI(apiKey);
}

/**
 * Pull the inline image out of an Interaction. The SDK surfaces it as `output_image`
 * ({type:"image", data: base64, mime_type}); the raw outputs[].content[] blocks are the fallback.
 */
export function extractImage(interaction: unknown): GeneratedImage | null {
  const r = interaction as {
    output_image?: { type?: string; data?: string; mime_type?: string };
    outputs?: Array<{ content?: Array<{ type?: string; data?: string; mime_type?: string }> }>;
  };
  const blocks = [r.output_image, ...(r.outputs ?? []).flatMap((o) => o.content ?? [])];
  for (const b of blocks) {
    if (b && typeof b.data === "string" && b.data.length > 0 && (!b.type || b.type === "image")) {
      return { data: Buffer.from(b.data, "base64"), mimeType: b.mime_type ?? "image/png" };
    }
  }
  return null;
}

/** Scale/crop to the output frame so the renderer never has to think about aspect ratio. */
async function fitToFrame(src: string, out: string): Promise<void> {
  const { width: W, height: H } = OUTPUT;
  await execFileAsync("ffmpeg", [
    "-y", "-v", "error", "-i", src,
    "-vf", `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`,
    "-frames:v", "1", out,
  ]);
}

/**
 * Ask Nano Banana for one 16:9 still from `prompt` and write it to `outFile` (PNG, OUTPUT.width x
 * OUTPUT.height). Shared by the title card and the keyframes of generated B-roll shots. Throws when
 * the model returns no image; a failed fit-to-frame keeps the model's own pixels.
 */
export async function generateStill(prompt: string, outFile: string, client?: Client): Promise<string> {
  const ai = client ?? defaultClient();
  const image = await withRetry(async () => {
    const started = Date.now();
    const r = await ai.interactions.create({
      model: ART_MODEL,
      input: prompt,
      store: false,
      response_format: { type: "image", aspect_ratio: "16:9", image_size: "1K" },
    } as never);
    reportUsage(ART_MODEL, r, started);
    const img = extractImage(r);
    if (!img) throw new Error(`${ART_MODEL}: no image in response`);
    return img;
  }, { label: `${ART_MODEL} (image)`, attempts: 2 });

  await mkdir(path.dirname(path.resolve(outFile)), { recursive: true });
  const raw = `${outFile}.raw`;
  await writeFile(raw, image.data);
  try {
    await fitToFrame(raw, outFile);
    await rm(raw, { force: true });
  } catch {
    // ffmpeg missing or the image undecodable for it: keep the model's own pixels.
    await rename(raw, outFile);
  }
  return outFile;
}

/**
 * Generate the title card background and write it to `outFile` (PNG, OUTPUT.width x OUTPUT.height).
 * Returns the written path, or null when the model or the conversion failed.
 */
export async function generateTitleCard(title: string, brief: string, outFile: string, client?: Client): Promise<string | null> {
  if (!title.trim()) return null;
  try {
    return await generateStill(titleCardPrompt(title, brief), outFile, client);
  } catch {
    return null;
  }
}

/**
 * Generate the closing-card background for `endTitle` and write it to `outFile` (PNG, OUTPUT size).
 * Same contract as generateTitleCard: the written path, or null when the model or the conversion failed.
 * The loop sets edl.endImage to the run-relative path, like titleImage.
 */
export async function generateEndCard(endTitle: string, brief: string, outFile: string, client?: Client): Promise<string | null> {
  if (!endTitle.trim()) return null;
  try {
    return await generateStill(endCardPrompt(endTitle, brief), outFile, client);
  } catch {
    return null;
  }
}
