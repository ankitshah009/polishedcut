// Live smoke test for Omni Flash video generation (ONE real text-to-video call).
// Run: set -a; source .env; set +a; npx tsx scripts/check-omni.ts [seconds] [prompt]
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { generateShot, OMNI_MODEL, shotRequest } from "../lib/broll";

const short = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 600);

async function main() {
  const seconds = Number(process.argv[2] ?? 4);
  const prompt = process.argv[3] ?? "Abstract cinematic amber particles drifting slowly on black, soft bokeh, slow drift.";
  const dir = path.resolve("runs/.omni-check");
  mkdirSync(dir, { recursive: true });
  const out = path.join(dir, "shot.mp4");

  console.log(`request: ${JSON.stringify(shotRequest({ prompt, seconds }))}`);
  const t0 = Date.now();
  const r = await generateShot({ prompt, seconds, outFile: out });
  const ms = Date.now() - t0;

  const probe = JSON.parse(
    execFileSync("ffprobe", [
      "-v", "error", "-show_entries", "format=duration,size:stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels", "-of", "json", r.file,
    ]).toString(),
  ) as {
    format: { duration: string; size: string };
    streams: { codec_type: string; codec_name: string; width?: number; height?: number; r_frame_rate?: string; sample_rate?: string; channels?: number }[];
  };
  console.log(`model: ${r.model} (${OMNI_MODEL})`);
  console.log(`requested: ${seconds}s  got: ${Number(probe.format.duration).toFixed(2)}s  (${ms}ms)`);
  console.log(
    `file: ${r.file} (${probe.format.size} bytes) ` +
      probe.streams
        .map((s) => (s.codec_type === "video" ? `${s.codec_name} ${s.width}x${s.height}@${s.r_frame_rate}` : `${s.codec_name} ${s.sample_rate}Hz ${s.channels}ch`))
        .join(", "),
  );
}

main().catch((e) => {
  console.error("FAILED:", short(e));
  process.exit(1);
});
