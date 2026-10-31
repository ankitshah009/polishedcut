// Fast leaf task: a Flash-Lite pass over the brief that turns prose into a few hints Argon can
// cut against (target length, tone, whether music/captions are wanted). Always optional: every
// failure here resolves to null and the caller drafts from the raw brief alone.
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";


import { extractJson, NO_KEY_MESSAGE, geminiKeys, newGenAI, responseSchema, withRetry } from "./gemini";
import { reportUsage } from "./usage-context";

export const BRIEF_MODEL = process.env.BRIEF_MODEL ?? "gemini-3.5-flash-lite";

export const BriefAnalysisSchema = z.object({
  targetSeconds: z.number().nullable(), // null when the brief names no length
  tone: z.string(), // e.g. "energetic", "calm and reflective"
  wantsCaptions: z.boolean(),
  wantsMusic: z.boolean(),
  musicMood: z.string(), // e.g. "upbeat electronic"; "" when music is unwanted
});
export type BriefAnalysis = z.infer<typeof BriefAnalysisSchema>;

type Client = Pick<GoogleGenAI, "interactions">;

export function briefPrompt(brief: string): string {
  return (
    "You prepare notes for a video editor. Read the brief and answer with JSON only:\n" +
    '{"targetSeconds": number|null, "tone": string, "wantsCaptions": boolean, "wantsMusic": boolean, "musicMood": string}\n' +
    "- targetSeconds: the requested total length in seconds (convert minutes), or null if the brief gives none.\n" +
    "- tone: two to four words describing the feel the brief asks for.\n" +
    "- wantsCaptions: true unless the brief says no captions/subtitles.\n" +
    "- wantsMusic: true if the brief asks for music or a soundtrack, or describes a mood that clearly calls for one.\n" +
    "- musicMood: a short music description (genre, energy, instruments) matching the tone; empty string if wantsMusic is false.\n\n" +
    `BRIEF:\n${brief}`
  );
}

function defaultClient(): Client {
  const apiKey = geminiKeys()[0]?.[1];
  if (!apiKey) throw new Error(NO_KEY_MESSAGE);
  return newGenAI(apiKey);
}

async function ask(ai: Client, params: Record<string, unknown>, label: string): Promise<string> {
  return withRetry(async () => {
    const started = Date.now();
    const r = (await ai.interactions.create(params as never)) as { output_text?: string };
    reportUsage(String(params.model ?? ""), r, started);
    return r.output_text ?? "";
  }, { label, attempts: 2 });
}

/** One structured Flash-Lite call. Null on any failure, never throws. */
export async function analyzeBrief(brief: string, client?: Client): Promise<BriefAnalysis | null> {
  if (!brief.trim()) return null;
  try {
    const ai = client ?? defaultClient();
    const base = { model: BRIEF_MODEL, input: briefPrompt(brief), store: false };
    let text: string;
    try {
      text = await ask(
        ai,
        { ...base, response_format: { type: "text", mime_type: "application/json", schema: responseSchema(BriefAnalysisSchema) } },
        `${BRIEF_MODEL} (structured)`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/schema|response_format/i.test(msg)) throw err;
      text = await ask(ai, base, `${BRIEF_MODEL} (plain)`);
    }
    const parsed = BriefAnalysisSchema.safeParse(extractJson(text));
    if (!parsed.success) return null;
    const a = parsed.data;
    const target = a.targetSeconds != null && a.targetSeconds > 0 ? Math.round(a.targetSeconds) : null;
    return { ...a, targetSeconds: target, tone: a.tone.trim(), musicMood: a.wantsMusic ? a.musicMood.trim() : "" };
  } catch {
    return null;
  }
}

/** One line appended to the brief Argon drafts from, so the hints travel with the brief itself. */
export function briefAnalysisLine(a: BriefAnalysis): string {
  const parts = [
    a.targetSeconds != null ? `target ${a.targetSeconds}s` : "no target length given (keep it tight)",
    a.tone ? `tone: ${a.tone}` : "",
    a.wantsMusic && a.musicMood ? `music mood: ${a.musicMood}` : "no music",
    a.wantsCaptions ? "" : "no captions",
  ].filter(Boolean);
  return `Brief analysis: ${parts.join("; ")}`;
}
