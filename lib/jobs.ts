import { readdir, rm } from "node:fs/promises";
import path from "node:path";

import { runDir } from "./config";
import { LOCAL_ONLY, createEditor } from "./editor";
import { cleanupRunUploads, type EditorModel } from "./gemini";
import { runEdit } from "./loop";
import { holdSweeps, isInProgress, isRunning, listRuns, markActive, markInactive, saveRun } from "./store";
import type { Run } from "./schema";
import { withUsageSink } from "./usage-context";

// The active set lives in store.ts (on globalThis, so it survives dev hot reloads) so that
// loadRun/listRuns can tell a live cut from one orphaned by a server restart.
export { isRunning };

export const RESUMED_WARNING = "Resumed after a server restart";
export const RETRIED_WARNING = "Started again";

/**
 * Wrap `editor` so clips that already carry a transcript are not transcribed again.
 * A resumed or retried run keeps its clips, so the words from the first attempt are reused.
 */
export function withCachedTranscripts(editor: EditorModel): EditorModel {
  return {
    transcribe: (input) => (input.clip.transcript.length > 0 ? Promise.resolve(input.clip.transcript) : editor.transcribe(input)),
    draft: (brief, clips, output) => editor.draft(brief, clips, output),
    critique: (brief, edl, rendered, clips) => editor.critique(brief, edl, rendered, clips),
  };
}

/**
 * Drive the edit loop for `run` in the background. The caller has already marked the run active.
 * The editor is created inside the task so a missing API key is recorded on the run, not thrown.
 */
function launch(run: Run, makeEditor: () => EditorModel): void {
  // Saves for one run are queued so they never write run.json concurrently.
  let queue: Promise<void> = Promise.resolve();
  const save = (r: Run) => {
    const snapshot = structuredClone(r);
    queue = queue
      .then(() => saveRun(snapshot))
      .catch((err: unknown) => console.error(`[run ${r.id}] could not save run.json:`, err));
    return queue;
  };

  void (async () => {
    try {
      await save(run);
      // Companion models (Flash-Lite, Nano Banana, Lyria, Omni) report their calls into run.usage too.
      await withUsageSink(
        (u) => (run.usage ??= []).push(u),
        () => runEdit(run, makeEditor(), { onUpdate: (r) => void save(r), ...(LOCAL_ONLY ? { analyzeBrief: async () => null, plainCards: true } : {}) }),
      );
    } catch (err) {
      run.status = "error";
      run.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    } finally {
      // Persist the terminal status before releasing the id, so a reader never sees an
      // in-progress status with no active loop behind it.
      await save(run);
      markInactive(run.id);
      // The footage leaves the Files API with the run (unless KEEP_UPLOADS=1); see docs/SCALING.md.
      void cleanupRunUploads(run.id);
    }
  })();
}

/**
 * Start the edit loop for `run` in the background. Returns immediately.
 * A missing API key or any other failure is recorded on the run, not thrown to the caller.
 * `editor` defaults to the Gemini editor; tests pass a double.
 */
/** The real editor for `run` (lib/editor.ts), recording every hosted model call's token usage on the run. */
function geminiFor(run: Run): EditorModel {
  run.usage ??= [];
  return createEditor({ runId: run.id, onUsage: (u) => run.usage!.push(u) });
}

export function startRun(run: Run, editor?: EditorModel): void {
  if (isRunning(run.id)) return;
  markActive(run.id);
  launch(run, () => editor ?? geminiFor(run));
}

/** Put `run` back to the start of the loop: no iterations, no error, clips (and their transcripts) kept. */
function requeue(run: Run, warning: string): void {
  run.warnings.push(warning);
  run.status = "queued";
  run.error = "";
  run.iterations = [];
  run.timings = [];
  void removeOldRenders(run.id);
}

/** Old renders would otherwise sit next to the new ones with stale numbering. */
async function removeOldRenders(runId: string): Promise<void> {
  const dir = runDir(runId);
  try {
    const names = (await readdir(dir)).filter((n) => /^iter\d+\.mp4$/.test(n));
    await Promise.all(names.map((n) => rm(path.join(dir, n), { force: true })));
  } catch (err) {
    console.warn(`[run ${runId}] could not remove old renders:`, err);
  }
}

/**
 * Continue a run the previous server process left in progress. Marks it active synchronously, so the
 * orphan sweep cannot touch it, re-queues it and runs the normal loop. Proxies and thumbnails on disk
 * are reused by the loop; transcripts already on the clips are reused through withCachedTranscripts.
 */
export function resumeRun(run: Run, editor?: EditorModel): void {
  if (isRunning(run.id)) return;
  markActive(run.id);
  requeue(run, RESUMED_WARNING);
  launch(run, () => withCachedTranscripts(editor ?? geminiFor(run)));
}

/**
 * Start a finished or failed run again from scratch (the "Start again" button). Keeps the warnings so
 * the history of the cut stays visible, drops the old iterations and reuses the clips' transcripts.
 */
export function retryRun(run: Run, editor?: EditorModel): void {
  if (isRunning(run.id)) return;
  markActive(run.id);
  requeue(run, RETRIED_WARNING);
  launch(run, () => withCachedTranscripts(editor ?? geminiFor(run)));
}

/**
 * On boot: every run still marked in progress on disk was interrupted by the restart; resume each one.
 * Sweeps are held while the runs are listed, so a request that lands meanwhile cannot mark one as an
 * error before it is active again. Returns the runs that were resumed.
 */
export async function resumeInterruptedRuns(editor?: EditorModel): Promise<Run[]> {
  const release = holdSweeps();
  try {
    const runs = await listRuns({ sweep: false });
    const resumed: Run[] = [];
    for (const run of runs) {
      if (!isInProgress(run.status) || isRunning(run.id)) continue;
      resumeRun(run, editor);
      resumed.push(run);
    }
    if (resumed.length > 0) console.log(`[argon] resumed ${resumed.length} interrupted run(s): ${resumed.map((r) => r.id).join(", ")}`);
    return resumed;
  } finally {
    release();
  }
}
