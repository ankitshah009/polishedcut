/** Generate missing timeline thumbnail sprites for every run in RUNS_DIR (default runs/). */
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { RUNS_DIR, isRunId } from "../lib/config";
import { makeThumbSprite } from "../lib/thumbs";

const root = RUNS_DIR;

async function exists(f: string): Promise<boolean> {
  return access(f).then(() => true, () => false);
}

async function main(): Promise<void> {
  for (const id of await readdir(root)) {
    if (!isRunId(id)) continue;
    const runFile = path.join(root, id, "run.json");
    if (!(await exists(runFile))) continue;
    const run = JSON.parse(await readFile(runFile, "utf8")) as {
      clips: { id: string; path: string; duration?: number }[];
    };
    for (const c of run.clips) {
      const dst = path.join(root, id, "thumbs", `${c.id}.jpg`);
      if (await exists(dst) || !c.duration) continue;
      const proxy = path.join(root, id, "proxies", `${c.id}.mp4`);
      const src = (await exists(proxy)) ? proxy : path.join(root, id, c.path);
      try {
        await makeThumbSprite(src, dst, c.duration);
        console.log(`ok ${id}/${c.id}`);
      } catch (err) {
        console.error(`fail ${id}/${c.id}: ${String(err)}`);
      }
    }
  }
}

main().catch((err: unknown) => {
  console.error("FAILED:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
