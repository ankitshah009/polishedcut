import { access } from "node:fs/promises";
import path from "node:path";

import { generateEndCard } from "./art";
import { REVISE_MAX_ITERATIONS, runDir } from "./config";
import { createEditor } from "./editor";
import { type ClipInput, type EditorModel } from "./gemini";
import { lintEdl } from "./lint";
import { END_IMAGE, mergeCritique, sanitizePatches } from "./loop";
import { makeProxy, probeDuration } from "./media";
import { applyPatches } from "./patch";
import { completePatches } from "./patch-complete";
import { renderEdl, type RenderAssets } from "./render";
import { isRunning, markActive, markInactive, saveRun } from "./store";
import { withUsageSink } from "./usage-context";
import {
  allPassed,
  type Critique,
  type EDL,
  type Iteration,
  type PatchOp,
  type Run,
  type RunStatus,
  type SourceClip,
} from "./schema";

export { REVISE_MAX_ITERATIONS };

export interface ReviseOptions {
  /** Extra render -> critique -> patch rounds after the note is applied (default REVISE_MAX_ITERATIONS). */
  maxIterations?: number;
  onUpdate?: (run: Run) => void;
  /** Closing-card painter for a note that adds or retitles the end card. Default is Nano Banana; tests pass a fake. */
  generateEndCard?: (endTitle: string, brief: string, outFile: string) => Promise<string | null>;
}

export const NOTHING_TO_CHANGE = "Argon found nothing to change for this note";

// Kept on globalThis so an active revision is not started twice across dev hot reloads.
const g = globalThis as typeof globalThis & { __editorRevising?: Set<string> };
g.__editorRevising ??= new Set();
const revising = g.__editorRevising;

export function isRevising(id: string): boolean {
  return revising.has(id);
}

/** Why `run` cannot take a director's note right now, or null when it can. Drives the route's 409. */
export function reviseBlocker(run: Run): string | null {
  if (isRevising(run.id)) return "a revision is already in progress";
  if (isRunning(run.id) || (run.status !== "done" && run.status !== "error")) return "run is still in progress";
  if (run.iterations.length === 0) return "run has no cut to revise";
  return null;
}

/** The brief Argon critiques against while revising: the original brief plus the note it must satisfy. */
export function revisionBrief(brief: string, note: string, insist = false): string {
  const base = `${brief}\n\nDIRECTOR'S NOTE (must be satisfied, overrides earlier choices): ${note}`;
  return insist ? `${base}\nReturn at least one patch that applies this note.` : base;
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

function sameEdl(a: EDL, b: EDL): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The deterministic transcript checks, degraded to a warning if the linter itself fails. */
function autoChecks(edl: EDL, clips: Record<string, SourceClip>, run: Run): ReturnType<typeof lintEdl> {
  try {
    return lintEdl(edl, clips, run.brief);
  } catch (err) {
    run.warnings.push(`auto checks unavailable: ${describeError(err)}`);
    return { checks: [], patches: [] };
  }
}

/**
 * Same patch discipline as the main loop: Argon's patches (minus any caption that leaked model
 * notes) first, then the transcript-derived fixes re-computed on the result, so a deterministic
 * caption fix is never overwritten by a model rewrite.
 */
function patchLikeLoop(
  edl: EDL,
  argonPatches: PatchOp[],
  clips: Record<string, SourceClip>,
  run: Run,
  tag: string,
): EDL {
  const { patches, dropped } = sanitizePatches(argonPatches);
  // Captions Argon left untimed or mis-indexed are repaired from the transcript before they are applied.
  const { patches: completed, notes } = completePatches(patches, edl, clips);
  const first = applyPatches(edl, completed, clips);
  const second = applyPatches(first.edl, autoChecks(first.edl, clips, run).patches, clips);
  run.warnings.push(...[...dropped, ...notes, ...first.skipped, ...second.skipped].map((s) => `${tag}: ${s}`));
  return second.edl;
}

/**
 * Revise a finished run from its LAST cut instead of starting over:
 * critique(last video, brief + note) -> patch -> (render -> critique -> patch)*.
 * Mutates and returns `run`; new iterations continue numbering and carry `note`.
 * Persistence is the caller's job, through onUpdate. Throws (without touching the run)
 * when the run is not finished or has no iteration to revise.
 */
export async function reviseRun(run: Run, note: string, editor: EditorModel, opts: ReviseOptions = {}): Promise<Run> {
  if (run.status !== "done" && run.status !== "error") {
    throw new Error(`cannot revise a run with status ${run.status}`);
  }
  const base = run.iterations.at(-1);
  if (!base) throw new Error("cannot revise a run with no iterations");

  const max = opts.maxIterations ?? REVISE_MAX_ITERATIONS;
  const dir = runDir(run.id);
  const abs = (rel: string) => path.join(dir, rel);
  const emit = () => opts.onUpdate?.(run);
  const setStatus = (status: RunStatus) => {
    run.status = status;
    emit();
  };

  run.error = "";
  setStatus("critiquing");

  try {
    if (!(await exists(abs(base.video)))) throw new Error(`rendered cut ${base.video} is missing`);

    const clipsById: Record<string, SourceClip> = {};
    const clipFiles: Record<string, string> = {};
    for (const c of run.clips) {
      if (!(c.duration > 0)) c.duration = await probeDuration(abs(c.path));
      clipsById[c.id] = c;
      clipFiles[c.id] = abs(c.path);
    }
    const inputs: ClipInput[] = [];
    for (const c of run.clips) {
      const proxy = `proxies/${c.id}.mp4`;
      if (!(await exists(abs(proxy)))) await makeProxy(abs(c.path), abs(proxy));
      inputs.push({ clip: c, file: abs(proxy) });
    }

    const brief = revisionBrief(run.brief, note);

    // Pass 1: ask for the patches that apply the note to the current cut. Insist once if none come back.
    let critique: Critique = await editor.critique(brief, base.edl, abs(base.video), inputs);
    if (critique.patches.length === 0) {
      critique = await editor.critique(revisionBrief(run.brief, note, true), base.edl, abs(base.video), inputs);
    }
    const patched = critique.patches.length > 0 ? patchLikeLoop(base.edl, critique.patches, clipsById, run, `v${base.n} note`) : null;
    if (!patched || sameEdl(patched, base.edl)) {
      run.warnings.push(NOTHING_TO_CHANGE);
      setStatus("done");
      return run;
    }
    let edl = patched;

    const endArt = opts.generateEndCard ?? generateEndCard;
    /** The run's generated assets, by absolute path, plus a closing card painted on demand (never fatal). */
    const assetsFor = async (e: EDL): Promise<RenderAssets> => {
      if (e.endTitle && !e.endImage) {
        const file = abs(END_IMAGE);
        try {
          const made = (await exists(file)) ? file : await endArt(e.endTitle, run.brief, file);
          if (made) e.endImage = END_IMAGE;
          else if (!run.warnings.some((w) => w.startsWith("art unavailable: no closing"))) {
            run.warnings.push("art unavailable: no closing card image was produced");
          }
        } catch (err) {
          const line = `art unavailable: ${describeError(err)}`;
          if (!run.warnings.includes(line)) run.warnings.push(line);
        }
      }
      const assets: RenderAssets = {};
      if (e.music?.file && (await exists(abs(e.music.file)))) assets.music = abs(e.music.file);
      if (e.titleImage && (await exists(abs(e.titleImage)))) assets.titleImage = abs(e.titleImage);
      if (e.endImage && (await exists(abs(e.endImage)))) assets.endImage = abs(e.endImage);
      return assets;
    };

    const start = base.n + 1;
    const last = base.n + max;
    for (let n = start; n <= last; n++) {
      setStatus("rendering");
      const video = `iter${n}.mp4`;
      await renderEdl(edl, clipFiles, abs(video), await assetsFor(edl));
      const it: Iteration = { n, edl, video, critique: null, note };
      run.iterations.push(it);

      setStatus("critiquing");
      const argon = await editor.critique(brief, edl, abs(video), inputs);
      it.critique = mergeCritique(argon, autoChecks(edl, clipsById, run));
      emit();

      if (allPassed(it.critique)) break;
      if (it.critique.patches.length === 0) {
        run.warnings.push(`stopped at v${n}: Argon reported failures with no fixes`);
        break;
      }
      if (n === last) break;

      edl = patchLikeLoop(edl, argon.patches, clipsById, run, `v${n}`);
    }

    setStatus("done");
  } catch (err) {
    run.status = "error";
    run.error = describeError(err);
    emit();
  }
  return run;
}

/**
 * Apply a director's note to `run` in the background. Returns immediately; `run.status` is already
 * "critiquing" when it does. A missing API key or any other failure is recorded on the run, not thrown.
 */
export function startRevision(run: Run, note: string): void {
  if (revising.has(run.id) || isRunning(run.id)) return;
  revising.add(run.id);
  // Also mark the run active in the store: a long critique writes nothing to run.json, and without
  // this the orphan sweep in loadRun would flag the in-flight revision as an interrupted cut.
  markActive(run.id);

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
      // Same as lib/jobs.ts geminiFor(run): every Gemini call's token usage lands on the run for cost estimates.
      run.usage ??= [];
      const editor = createEditor({ onUsage: (u) => run.usage!.push(u) });
      await withUsageSink(
        (u) => (run.usage ??= []).push(u),
        () => reviseRun(run, note, editor, { onUpdate: (r) => void save(r) }),
      );
    } catch (err) {
      run.status = "error";
      run.error = describeError(err);
    } finally {
      // Persist the terminal status before releasing the guards, so a reader never sees an
      // in-progress status with no revision behind it.
      await save(run);
      revising.delete(run.id);
      markInactive(run.id);
    }
  })();
}
