// Live smoke test for the companion models: one Flash-Lite brief analysis and one Nano Banana title card.
// Run: set -a; source .env; set +a; npx tsx scripts/check-stack.ts [outDir]
import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { ART_MODEL, generateTitleCard } from "../lib/art";
import { analyzeBrief, briefAnalysisLine, BRIEF_MODEL } from "../lib/brief";

const execFileAsync = promisify(execFile);
const short = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

const BRIEF =
  "Cut a 40 second upbeat recap of the hackathon demo day. Keep the audience laughing moment, " +
  "add captions for the quotes, and put some bright electronic music under it.";

async function main() {
  const outDir = path.resolve(process.argv[2] ?? "runs/.check-stack");
  await mkdir(outDir, { recursive: true });
  let failed = false;

  const t0 = Date.now();
  const analysis = await analyzeBrief(BRIEF);
  if (analysis) {
    console.log(`[${BRIEF_MODEL}] analyzeBrief OK in ${Date.now() - t0}ms:`, JSON.stringify(analysis));
    console.log(`  -> ${briefAnalysisLine(analysis)}`);
  } else {
    failed = true;
    console.log(`[${BRIEF_MODEL}] analyzeBrief FAIL (null) after ${Date.now() - t0}ms`);
  }

  const t1 = Date.now();
  const out = path.join(outDir, "title.png");
  const file = await generateTitleCard("Demo Day", BRIEF, out);
  if (file) {
    const size = (await stat(file)).size;
    let probe = "";
    try {
      const { stdout } = await execFileAsync("ffprobe", [
        "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height", "-of", "csv=p=0", file,
      ]);
      probe = stdout.trim();
    } catch (e) {
      probe = `ffprobe failed: ${short(e)}`;
    }
    console.log(`[${ART_MODEL}] generateTitleCard OK in ${Date.now() - t1}ms: ${file} (${size} bytes, ${probe})`);
  } else {
    failed = true;
    console.log(`[${ART_MODEL}] generateTitleCard FAIL (null) after ${Date.now() - t1}ms`);
  }

  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error("FAILED:", short(e));
  process.exit(1);
});
