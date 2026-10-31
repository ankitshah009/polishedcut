import { EventEmitter } from "node:events";
import { access, readdir, readFile, rename, stat, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { ORPHAN_AFTER_MS, RUNS_DIR, isRunId, runDir } from "./config";
import { RunSchema, type Run, type RunStatus } from "./schema";

// Kept on globalThis so live state, subscribers and the active set survive Next.js dev hot reloads.
const g = globalThis as typeof globalThis & {
  __editorLive?: Map<string, Run>;
  __editorBus?: EventEmitter;
  __editorActive?: Set<string>;
  __editorSweepHolds?: { count: number };
};
g.__editorLive ??= new Map();
g.__editorBus ??= new EventEmitter().setMaxListeners(0);
g.__editorActive ??= new Set();
g.__editorSweepHolds ??= { count: 0 };
const live = g.__editorLive;
const bus = g.__editorBus;
const active = g.__editorActive;
const sweepHolds = g.__editorSweepHolds;

/** A run whose loop has not reported a terminal status within this long, and is not active here, was orphaned. */
export { ORPHAN_AFTER_MS };
export const INTERRUPTED_ERROR =
  "Interrupted: the server restarted during this cut. It resumes automatically on the next start, or press Start again.";
export const MISSING_SOURCE_ERROR = "Interrupted: a source clip is missing from disk, so this cut cannot continue.";
export const IN_PROGRESS: ReadonlySet<RunStatus> = new Set<RunStatus>(["queued", "drafting", "rendering", "critiquing"]);

export function isInProgress(status: RunStatus): boolean {
  return IN_PROGRESS.has(status);
}

/** True while this process is driving the edit loop for `id`. */
export function isRunning(id: string): boolean {
  return active.has(id);
}

export function markActive(id: string): void {
  active.add(id);
}

export function markInactive(id: string): void {
  active.delete(id);
}

/**
 * Suspend the orphan sweep until the returned function is called. Used on boot: between listing the
 * runs left in progress by the previous process and marking them active again, a concurrent request
 * must not record them as interrupted.
 */
export function holdSweeps(): () => void {
  sweepHolds.count++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    sweepHolds.count--;
  };
}

export async function saveRun(run: Run): Promise<void> {
  const dir = runDir(run.id);
  await mkdir(dir, { recursive: true });
  // Unique per write: two concurrent saves must never share a temp file, or one rename fails with ENOENT.
  const tmp = path.join(dir, `run.json.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`);
  await writeFile(tmp, JSON.stringify(run, null, 2));
  await rename(tmp, path.join(dir, "run.json"));
  const copy = structuredClone(run);
  live.set(run.id, copy);
  bus.emit(`run:${run.id}`, copy);
}

async function missingSource(run: Run): Promise<boolean> {
  for (const clip of run.clips) {
    try {
      await access(path.join(runDir(run.id), clip.path));
    } catch {
      return true;
    }
  }
  return false;
}

/**
 * A run that looks in progress but has no loop driving it in this process (the server restarted
 * mid-cut) would spin forever in the UI. It is marked as an error only when it cannot be resumed
 * (a source clip is gone) or when its run.json has been quiet for ORPHAN_AFTER_MS with nothing
 * active behind it. Runs being resumed on boot are active, so they are never swept.
 */
async function sweepOrphan(run: Run): Promise<Run> {
  if (!IN_PROGRESS.has(run.status) || active.has(run.id) || sweepHolds.count > 0) return run;
  let error: string;
  if (await missingSource(run)) {
    error = MISSING_SOURCE_ERROR;
  } else {
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(path.join(runDir(run.id), "run.json"))).mtimeMs;
    } catch {
      return run;
    }
    if (Date.now() - mtimeMs < ORPHAN_AFTER_MS) return run;
    error = INTERRUPTED_ERROR;
  }
  // The checks above awaited; a loop may have claimed the run meanwhile.
  if (active.has(run.id) || sweepHolds.count > 0) return run;
  run.status = "error";
  run.error = error;
  try {
    await saveRun(run);
  } catch (err) {
    console.error(`[run ${run.id}] could not record interruption:`, err);
  }
  return run;
}

export interface LoadOptions {
  /** Pass false to read the run exactly as stored, without the orphan sweep (used when resuming on boot). */
  sweep?: boolean;
}

export async function loadRun(id: string, opts: LoadOptions = {}): Promise<Run | null> {
  if (!isRunId(id)) return null;
  const sweep = opts.sweep ?? true;
  const hit = live.get(id);
  if (hit) {
    const copy = structuredClone(hit);
    return sweep ? sweepOrphan(copy) : copy;
  }
  try {
    const parsed = RunSchema.safeParse(JSON.parse(await readFile(path.join(runDir(id), "run.json"), "utf8")));
    if (!parsed.success) return null;
    return sweep ? sweepOrphan(parsed.data) : parsed.data;
  } catch {
    return null;
  }
}

export async function listRuns(opts: LoadOptions = {}): Promise<Run[]> {
  let entries: string[];
  try {
    entries = await readdir(RUNS_DIR);
  } catch {
    return [];
  }
  const runs: Run[] = [];
  for (const name of entries) {
    if (!isRunId(name)) continue;
    try {
      if (!(await stat(path.join(RUNS_DIR, name))).isDirectory()) continue;
    } catch {
      continue;
    }
    const run = await loadRun(name, opts);
    if (run) runs.push(run);
  }
  return runs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

export function subscribe(id: string, listener: (run: Run) => void): () => void {
  const event = `run:${id}`;
  bus.on(event, listener);
  return () => {
    bus.off(event, listener);
  };
}
