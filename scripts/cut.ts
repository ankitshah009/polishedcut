// Headless Argon Cut. Creates a run exactly like POST /api/runs does, runs the self-correcting loop
// and prints stage timings plus every iteration's checks and patches. Exits non-zero on error.
//
//   npx tsx scripts/cut.ts --brief "..." clip1.mp4 clip2.mp4 [--max-iters 3]
//
// Reads .env at the repo root itself (values are never printed), so `source .env` is not required.
import { randomBytes } from "node:crypto";
import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { Check, Run, SourceClip } from "../lib/schema";

interface Args {
  brief: string;
  clips: string[];
  maxIters?: number;
}

const USAGE = 'usage: npx tsx scripts/cut.ts --brief "..." clip1.mp4 [clip2.mp4 ...] [--max-iters 3]';

function usage(message?: string): never {
  if (message) console.error(`error: ${message}`);
  console.error(USAGE);
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const args: Args = { brief: "", clips: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--brief") {
      args.brief = argv[++i] ?? usage("--brief needs a value");
    } else if (a === "--max-iters") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) usage("--max-iters needs a positive integer");
      args.maxIters = n;
    } else if (a === "-h" || a === "--help") {
      usage();
    } else if (a.startsWith("--")) {
      usage(`unknown option ${a}`);
    } else {
      args.clips.push(a);
    }
  }
  if (!args.brief.trim()) usage("--brief is required");
  if (args.clips.length === 0) usage("at least one clip is required");
  return args;
}

/**
 * Minimal .env loader: KEY=value lines, optional `export`, single or double quotes, # comments.
 * Variables already in the environment win. Returns how many were set; values are never logged.
 */
async function loadEnv(file: string): Promise<number> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return 0;
  }
  let loaded = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, key, rawValue] = m;
    const quoted = /^(["'])(.*)\1\s*$/.exec(rawValue);
    const value = quoted ? quoted[2] : rawValue.replace(/\s+#.*$/, "").trim();
    if (process.env[key] === undefined) {
      process.env[key] = value;
      loaded++;
    }
  }
  return loaded;
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function fmtCheck(c: Check): string {
  const where = c.at != null ? ` @${c.at.toFixed(1)}s` : "";
  const note = c.note ? ` - ${c.note}` : "";
  return `    ${c.passed ? "PASS" : "FAIL"} ${c.name}${where}${note}`;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  for (const file of args.clips) {
    const s = await stat(file).catch(() => null);
    if (!s?.isFile()) usage(`not a file: ${file}`);
  }

  const loaded = await loadEnv(path.resolve(".env"));
  console.log(`env: ${loaded} variable${loaded === 1 ? "" : "s"} loaded from .env`);

  // lib/config reads RUNS_DIR and the model names at import time, so these imports come after .env.
  // safeName is the same sanitiser the API route uses, so run folders look identical.
  const [{ runDir, safeName }, { describePatch }, { createEditor }, { runEdit }, { saveRun }] = await Promise.all([
    import("../lib/config"),
    import("../lib/format"),
    import("../lib/editor"),
    import("../lib/loop"),
    import("../lib/store"),
  ]);

  const editor = createEditor(); // throws a clear message when no key is configured

  const id = randomBytes(5).toString("hex");
  const dir = runDir(id);
  await mkdir(path.join(dir, "src"), { recursive: true });
  const clips: SourceClip[] = [];
  for (const [i, file] of args.clips.entries()) {
    const rel = `src/clip${i + 1}_${safeName(file)}`;
    await copyFile(file, path.join(dir, rel));
    clips.push({ id: `clip${i + 1}`, path: rel, duration: 0, transcript: [] });
  }

  const run: Run = {
    id,
    brief: args.brief.trim(),
    createdAt: new Date().toISOString(),
    clips,
    iterations: [],
    status: "queued",
    error: "",
    warnings: [],
    timings: [],
  };
  await saveRun(run);
  console.log(`run ${id} -> ${dir}`);
  console.log(`clips: ${clips.map((c) => `${c.id}=${path.basename(c.path)}`).join(", ")}`);

  // Saves are queued so run.json is never written concurrently (same as lib/jobs.ts).
  let queue: Promise<void> = Promise.resolve();
  const save = (r: Run) => {
    const snapshot = structuredClone(r);
    queue = queue.then(() => saveRun(snapshot)).catch((err: unknown) => console.error("could not save run.json:", err));
  };

  // Progress: print each new timing and each iteration once its critique has landed.
  let shownTimings = 0;
  let shownIterations = 0;
  let lastStatus = "";
  const report = (r: Run) => {
    if (r.status !== lastStatus) {
      lastStatus = r.status;
      console.log(`[${r.status}]`);
    }
    const timings = r.timings ?? [];
    for (; shownTimings < timings.length; shownTimings++) {
      const t = timings[shownTimings];
      console.log(`  ${t.stage.padEnd(11)} ${fmtMs(t.ms)}`);
    }
    while (shownIterations < r.iterations.length) {
      const it = r.iterations[shownIterations];
      if (!it.critique) break;
      shownIterations++;
      const passed = it.critique.checks.filter((c) => c.passed).length;
      console.log(`  v${it.n}: ${it.edl.cuts.length} cuts, ${it.edl.captions.length} captions; checks ${passed}/${it.critique.checks.length} passed`);
      for (const c of it.critique.checks) console.log(fmtCheck(c));
      if (it.critique.patches.length > 0) {
        console.log(`    patches (${it.critique.patches.length}):`);
        for (const p of it.critique.patches) console.log(`      - ${describePatch(p)}`);
      }
      if (it.critique.summary) console.log(`    summary: ${it.critique.summary}`);
    }
  };

  const t0 = performance.now();
  await runEdit(run, editor, {
    maxIterations: args.maxIters,
    onUpdate: (r) => {
      report(r);
      save(r);
    },
  });
  const wall = Math.round(performance.now() - t0);
  report(run);
  save(run);
  await queue;

  console.log("");
  console.log("stage timings:");
  const timings = run.timings ?? [];
  for (const t of timings) console.log(`  ${t.stage.padEnd(11)} ${String(t.ms).padStart(7)} ms`);
  const sum = timings.reduce((acc, t) => acc + t.ms, 0);
  console.log(`  ${"total".padEnd(11)} ${String(sum).padStart(7)} ms  (wall ${fmtMs(wall)}, ${run.iterations.length} iteration${run.iterations.length === 1 ? "" : "s"})`);
  for (const w of run.warnings) console.log(`warning: ${w}`);

  if (run.status !== "done") {
    console.error(`FAILED: ${run.error || `status ${run.status}`}`);
    return 1;
  }
  const last = run.iterations.at(-1);
  if (last) console.log(`final cut: ${path.join(dir, last.video)}`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error("FAILED:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
