// Live smoke test for the Gemini wiring.
//   set -a; source .env; set +a; npx tsx scripts/check-gemini.ts [clip.mp4]
// Without an argument the first clip in DEMO_DIR (footage/demo) is used.
import { readdir } from "node:fs/promises";
import path from "node:path";

import { GoogleGenAI } from "@google/genai";

import { createGeminiEditor, geminiGate, geminiKeys, listUploads } from "../lib/gemini";
import { DEMO_DIR, GEMINI_CONCURRENCY, KEEP_UPLOADS, MODELS, isVideoName } from "../lib/config";
import { probeMedia } from "../lib/media";

const short = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

async function pickClip(): Promise<string> {
  const arg = process.argv[2];
  if (arg) return path.resolve(arg);
  const names = (await readdir(DEMO_DIR).catch(() => [] as string[])).filter(isVideoName).sort();
  if (names.length === 0) throw new Error(`no clip given and none found in ${DEMO_DIR}`);
  return path.join(DEMO_DIR, names[0]);
}

async function main() {
  if (geminiKeys().length === 0) throw new Error("GEMINI_API_KEY is not set");
  for (const [name, key] of geminiKeys()) {
    const ai = new GoogleGenAI({ apiKey: key });
    for (const model of [MODELS.argon, MODELS.flash]) {
      try {
        const r = await ai.interactions.create({ model, input: "Reply with the word ok.", store: false } as never);
        console.log(`[key ${name}] ${model}: OK ->`, JSON.stringify((r as { output_text?: string }).output_text));
      } catch (e) {
        console.log(`[key ${name}] ${model}: FAIL ${short(e)}`);
      }
    }
  }

  const file = await pickClip();
  const info = await probeMedia(file);
  console.log(`clip: ${file}`);
  console.log(`  ${info.codec} ${info.width}x${info.height} rot=${info.rotation} ${info.fps.toFixed(2)}fps ${info.pixFmt} audio=${info.hasAudio} ${info.duration.toFixed(1)}s`);
  console.log(`gate: GEMINI_CONCURRENCY=${GEMINI_CONCURRENCY} (in flight now: ${geminiGate.inFlight}); KEEP_UPLOADS=${KEEP_UPLOADS ? 1 : 0}`);
  const clip = { clip: { id: "a", path: file, duration: info.duration, transcript: [] as unknown[] }, file };
  const editor = createGeminiEditor();
  const t0 = Date.now();
  const words = await editor.transcribe(clip as never);
  console.log(`transcribe: ${words.length} words in ${Date.now() - t0}ms`, JSON.stringify(words.slice(0, 5)));
  clip.clip.transcript = words;
  const t1 = Date.now();
  // Output size follows the footage (chooseOutput over the clip) unless a size is passed here.
  const edl = await editor.draft("10s recap", [clip as never]);
  console.log(`draft: ${edl.cuts.length} cuts at ${edl.width}x${edl.height}@${edl.fps} in ${Date.now() - t1}ms`, JSON.stringify(edl).slice(0, 600));
  // A clip outside RUNS_DIR/<runId> is not registered; inside a run, uploads.json would list the Files API handles.
  console.log(`registered uploads for this (non-run) clip: ${(await listUploads("0000000000")).length}`);
}

main().catch((e) => {
  console.error("FAILED:", short(e));
  process.exit(1);
});
