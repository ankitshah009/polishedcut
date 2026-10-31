// Live smoke test for Lyria music generation (ONE real call).
// Run: set -a; source .env; set +a; npx tsx scripts/check-music.ts [seconds] [prompt]
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { generateMusic } from "../lib/music";

const short = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 400);

async function main() {
  const seconds = Number(process.argv[2] ?? 12);
  const prompt = process.argv[3] ?? "Warm, optimistic lo-fi hip hop with soft piano chords and a relaxed beat, for a product demo video.";
  const dir = path.resolve("runs/.music-check");
  mkdirSync(dir, { recursive: true });
  const out = path.join(dir, "music.mp3");

  const t0 = Date.now();
  const r = await generateMusic(prompt, seconds, out);
  const ms = Date.now() - t0;

  const probe = JSON.parse(
    execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration,size:stream=codec_name,sample_rate,channels", "-of", "json", r.file]).toString(),
  ) as { format: { duration: string; size: string }; streams: { codec_name: string; sample_rate: string; channels: number }[] };
  console.log(`model: ${r.model}`);
  console.log(`requested: ${seconds}s  got: ${Number(probe.format.duration).toFixed(2)}s  (${ms}ms)`);
  console.log(`file: ${r.file} (${probe.format.size} bytes) ${probe.streams.map((s) => `${s.codec_name} ${s.sample_rate}Hz ${s.channels}ch`).join(", ")}`);
}

main().catch((e) => {
  console.error("FAILED:", short(e));
  process.exit(1);
});
