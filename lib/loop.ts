import { access, mkdir } from "node:fs/promises";
import path from "node:path";

import { generateEndCard, generateTitleCard } from "./art";
import { analyzeBrief, briefAnalysisLine, type BriefAnalysis } from "./brief";
import { generateBroll, type ShotOptions, type ShotResult } from "./broll";
import { MAX_ITERATIONS, runDir, TITLE_SECONDS } from "./config";
import type { ClipInput, EditorModel } from "./gemini";
import { lintEdl } from "./lint";
import { makeProxy, probeDuration } from "./media";
import { applyMusicPatch, generateMusic, type MusicResult } from "./music";
import { applyPatches } from "./patch";
import { completePatches } from "./patch-complete";
import { renderEdl, type RenderAssets } from "./render";
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
import { makeThumbSprite } from "./thumbs";

export interface LoopOptions {
  maxIterations?: number;
  onUpdate?: (run: Run) => void;
  /** Companion-model generators. Defaults are the real Lyria / Nano Banana / Flash-Lite calls; tests pass fakes. */
  generateMusic?: (prompt: string, seconds: number, outFile: string) => Promise<MusicResult>;
  generateTitleCard?: (title: string, brief: string, outFile: string) => Promise<string | null>;
  generateEndCard?: (endTitle: string, brief: string, outFile: string) => Promise<string | null>;
  analyzeBrief?: (brief: string) => Promise<BriefAnalysis | null>;
  /** Draw title and closing cards as plain text on black and never call the art model (the local editor). */
  plainCards?: boolean;
  /** Omni B-roll generator (keyframe via Nano Banana, then image-to-video). Tests pass a fake. */
  generateShot?: (opts: ShotOptions) => Promise<ShotResult>;
}

/** Directory inside a run where generated shots live. */
export const GENERATED_DIR = "generated";
/** Ids Argon may give generated shots: g1, g2 (a bounded, path-safe set). */
const GENERATED_ID = /^g[1-9]$/;

/** ffmpeg jobs in flight at once during prepare. More than this just fights for the same cores. */
export const PREPARE_CONCURRENCY = 3;

/** Seconds of music bed generated beyond the edit's length, so the fade-out never runs dry. */
export const MUSIC_TAIL_SECONDS = 3;

export const TITLE_IMAGE = "title.png";
export const END_IMAGE = "end.png";
export const MUSIC_FILE = "music.mp3";

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

/**
 * Promise.all with at most `limit` tasks running at once. Results keep input order.
 * The first rejection propagates and no further tasks are started.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

/** Output length in seconds: title card, every cut, and the closing card when there is one. */
export function totalSeconds(edl: EDL): number {
  const cards = (edl.title ? TITLE_SECONDS : 0) + (edl.endTitle ? TITLE_SECONDS : 0);
  return cards + edl.cuts.reduce((s, c) => s + Math.max(0, c.srcOut - c.srcIn), 0);
}

/**
 * Self-correcting edit loop: prepare (probe, proxy, thumbs; clips in parallel) -> transcribe (in parallel)
 * -> analyze (Flash-Lite hints) -> draft -> (art/music assets -> render -> critique -> patch)*.
 * Iterations stay sequential: each one watches the last render. Argon's critique is merged with the
 * deterministic checks from lintEdl ("auto: ..."), and auto patches are applied after Argon's.
 * The companion stages (analyze, art, music) are never fatal: a failure is a warning and the cut goes on
 * without that asset. Mutates and returns `run`. Persistence is the caller's job, through onUpdate.
 */
export async function runEdit(run: Run, editor: EditorModel, opts: LoopOptions = {}): Promise<Run> {
  const max = opts.maxIterations ?? MAX_ITERATIONS;
  const music = opts.generateMusic ?? generateMusic;
  const art = opts.generateTitleCard ?? generateTitleCard;
  const endArt = opts.generateEndCard ?? generateEndCard;
  const analyze = opts.analyzeBrief ?? analyzeBrief;
  const shot = opts.generateShot ?? generateBroll;
  const dir = runDir(run.id);
  const abs = (rel: string) => path.join(dir, rel);
  const emit = () => opts.onUpdate?.(run);
  const setStatus = (status: RunStatus) => {
    run.status = status;
    emit();
  };
  const timings = (run.timings ??= []);
  /** Run `work`, record its wall-clock time under `stage` (even when it throws), then notify. */
  const timed = async <T>(stage: string, work: () => Promise<T>): Promise<T> => {
    const t0 = performance.now();
    try {
      return await work();
    } finally {
      timings.push({ stage, ms: Math.round(performance.now() - t0) });
      emit();
    }
  };
  /** A companion stage: timed, and any failure becomes a warning plus `fallback`. */
  const optional = async <T>(stage: string, fallback: T, work: () => Promise<T>): Promise<T> => {
    try {
      return await timed(stage, work);
    } catch (err) {
      run.warnings.push(`${stage} unavailable: ${describeError(err)}`);
      return fallback;
    }
  };

  try {
    setStatus("drafting");

    // One chain per clip (probe -> proxy -> thumbnail sprite), PREPARE_CONCURRENCY chains at a time.
    const inputs: ClipInput[] = await timed("prepare", () =>
      mapLimit(run.clips, PREPARE_CONCURRENCY, async (c) => {
        c.duration = await probeDuration(abs(c.path));
        const proxy = abs(`proxies/${c.id}.mp4`);
        if (!(await exists(proxy))) await makeProxy(abs(c.path), proxy);
        const sprite = abs(`thumbs/${c.id}.jpg`);
        if (!(await exists(sprite))) {
          try {
            await makeThumbSprite(proxy, sprite, c.duration);
          } catch (err) {
            run.warnings.push(`thumbnails unavailable for ${c.id}: ${describeError(err)}`);
          }
        }
        return { clip: c, file: proxy };
      }),
    );
    const clipsById: Record<string, SourceClip> = Object.fromEntries(run.clips.map((c) => [c.id, c]));
    const clipFiles: Record<string, string> = Object.fromEntries(run.clips.map((c) => [c.id, abs(c.path)]));

    // Every clip is transcribed at once; a failed clip becomes a warning and the draft goes on without it.
    await timed("transcribe", async () => {
      const results = await Promise.allSettled(inputs.map((input) => editor.transcribe(input)));
      results.forEach((r, i) => {
        if (r.status === "fulfilled") inputs[i].clip.transcript = r.value;
        else run.warnings.push(`transcript unavailable for ${inputs[i].clip.id}: ${describeError(r.reason)}`);
      });
    });

    // Flash-Lite reads the brief first; its hints ride along with the brief Argon drafts from.
    const analysis = await optional("analyze", null, () => analyze(run.brief));
    const draftBrief = analysis ? `${run.brief}\n\n${briefAnalysisLine(analysis)}` : run.brief;

    let edl = await timed("draft", () => editor.draft(draftBrief, inputs));
    if (analysis?.wantsMusic && analysis.musicMood && !edl.music?.prompt) {
      edl = { ...edl, music: { prompt: `${analysis.musicMood} instrumental background music` } };
    }

    // Generated shots: Omni makes each one, then it is registered like uploaded footage (proxy,
    // thumbnails, clipsById, clipFiles). A failed shot is a warning and its cuts are dropped.
    const failed = new Set<string>(); // generated ids whose cuts must go
    const wanted = (edl.generated ?? []).filter((g) => {
      if (!GENERATED_ID.test(g.id) || g.id in clipsById) {
        run.warnings.push(`generate: ignored shot with invalid or duplicate id ${JSON.stringify(g.id)}`);
        failed.add(g.id);
        return false;
      }
      return true;
    });
    if (wanted.length > 0) {
      for (const g of wanted) failed.add(g.id);
      await optional("generate", undefined, async () => {
        await mkdir(abs(GENERATED_DIR), { recursive: true });
        const results = await Promise.allSettled(
          wanted.map(async (g) => {
            const rel = `${GENERATED_DIR}/${g.id}.mp4`;
            const made = await shot({ prompt: g.prompt, seconds: g.seconds, outFile: abs(rel) });
            const clip: SourceClip = { id: g.id, path: rel, duration: await probeDuration(made.file), transcript: [] };
            const proxy = abs(`proxies/${g.id}.mp4`);
            await makeProxy(abs(rel), proxy);
            try {
              await makeThumbSprite(proxy, abs(`thumbs/${g.id}.jpg`), clip.duration);
            } catch (err) {
              run.warnings.push(`thumbnails unavailable for ${g.id}: ${describeError(err)}`);
            }
            run.clips.push(clip);
            clipsById[g.id] = clip;
            clipFiles[g.id] = abs(rel);
            inputs.push({ clip, file: proxy });
            failed.delete(g.id);
            emit();
          }),
        );
        results.forEach((r, i) => {
          if (r.status === "rejected") run.warnings.push(`generate unavailable for ${wanted[i].id}: ${describeError(r.reason)}`);
        });
      });
    }
    edl = dropCutsOf(edl, failed);

    let musicPrompt: string | null = null; // prompt the current music.mp3 was generated from

    for (let n = 1; n <= max; n++) {
      setStatus("rendering");
      const current = edl;

      // Title card background: once per run (the plate carries no text, so a retitled card reuses it).
      if (current.title && !current.titleImage && !opts.plainCards) {
        const file = abs(TITLE_IMAGE);
        const made = (await exists(file)) ? file : await optional("art", null, () => art(current.title, run.brief, file));
        if (made) current.titleImage = TITLE_IMAGE;
        else if (!run.warnings.some((w) => w.startsWith("art unavailable"))) run.warnings.push("art unavailable: no title card image was produced");
      }
      // Closing card background, same discipline: painted once per run, reused until the line changes
      // (set_end_title drops endImage when it does, so a retitled card is repainted).
      if (current.endTitle && !current.endImage && !opts.plainCards) {
        const file = abs(END_IMAGE);
        const made = (await exists(file)) ? file : await optional("art", null, () => endArt(current.endTitle!, run.brief, file));
        if (made) current.endImage = END_IMAGE;
        else if (!run.warnings.some((w) => w.startsWith("art unavailable: no closing"))) run.warnings.push("art unavailable: no closing card image was produced");
      }

      // Music bed: generated for the edit's length, regenerated only when the prompt changes.
      const prompt = current.music?.prompt?.trim();
      if (current.music && prompt && (prompt !== musicPrompt || !current.music.file)) {
        const seconds = Math.ceil(totalSeconds(current)) + MUSIC_TAIL_SECONDS;
        const made = await optional("music", null, () => music(prompt, seconds, abs(MUSIC_FILE)));
        if (made) {
          current.music.file = MUSIC_FILE;
          musicPrompt = prompt;
        } else {
          delete current.music.file;
        }
      }

      const video = `iter${n}.mp4`;
      const assets: RenderAssets = {};
      if (current.music?.file) assets.music = abs(current.music.file);
      if (current.titleImage) assets.titleImage = abs(current.titleImage);
      if (current.endImage) assets.endImage = abs(current.endImage);
      await timed(`render${n}`, () => renderEdl(current, clipFiles, abs(video), assets));
      const it: Iteration = { n, edl: current, video, critique: null };
      run.iterations.push(it);

      setStatus("critiquing");
      const argon = await timed(`critique${n}`, () => editor.critique(run.brief, current, abs(video), inputs));
      it.critique = mergeCritique(argon, autoChecks(current, clipsById, run));
      emit();

      if (allPassed(it.critique)) break;
      if (it.critique.patches.length === 0) {
        run.warnings.push(`stopped at v${n}: Argon reported failures with no fixes`);
        break;
      }
      if (n === max) break;

      // Argon's patches first, then the deterministic ones re-derived from the patched EDL, so a
      // transcript-backed caption fix always lands last and cannot be overwritten by a model rewrite.
      // set_music is applied ahead of the cut/caption patches; a new prompt drops the old file.
      const { patches: argonPatches, dropped } = sanitizePatches(argon.patches);
      const withMusic = withMusicPatches(current, argonPatches);
      // Captions Argon left untimed or mis-indexed are repaired from the transcript before they are applied.
      const { patches: completed, notes } = completePatches(withoutMusicPatches(argonPatches), withMusic, clipsById);
      run.warnings.push(...[...dropped, ...notes].map((s) => `v${n}: ${s}`));
      const first = applyPatches(withMusic, completed, clipsById);
      const auto = autoChecks(first.edl, clipsById, run).patches;
      const second = applyPatches(withMusicPatches(first.edl, auto), withoutMusicPatches(auto), clipsById);
      run.warnings.push(...[...first.skipped, ...second.skipped].map((s) => `v${n}: ${s}`));
      // Argon and the linter can undo each other (a trim snapped straight back): the same EDL
      // would render the same video, so stop instead of paying for an identical critique.
      if (fingerprint(second.edl) === fingerprint(current)) {
        run.warnings.push(`stopped at v${n}: the fixes cancelled each other out, so the cut is final`);
        break;
      }
      edl = second.edl;
    }

    setStatus("done");
  } catch (err) {
    run.status = "error";
    run.error = describeError(err);
    emit();
  }
  return run;
}

/** What decides the rendered picture and sound: cuts, captions, overlays, cards, music prompt, audio. Assets and ids do not. */
export function fingerprint(edl: EDL): string {
  return JSON.stringify({
    title: edl.title,
    endTitle: edl.endTitle ?? "",
    cuts: edl.cuts.map((c) => [c.clipId, c.srcIn, c.srcOut]),
    captions: edl.captions.map((c) => [c.text, c.start, c.end]),
    overlays: (edl.overlays ?? []).map((o) => [o.text, o.start, o.end, o.position]),
    music: edl.music?.prompt ?? null,
    audio: [edl.audio?.denoise ?? false, edl.audio?.musicGainDb ?? null],
  });
}

/** Remove every cut that references one of `clipIds` and renumber the rest c1..cN. Pure. */
export function dropCutsOf(edl: EDL, clipIds: Set<string>): EDL {
  if (clipIds.size === 0) return edl;
  const cuts = edl.cuts.filter((c) => !clipIds.has(c.clipId)).map((c, i) => ({ ...c, id: `c${i + 1}` }));
  return { ...edl, cuts, generated: (edl.generated ?? []).filter((g) => !clipIds.has(g.id)) };
}

const isMusicPatch = (p: PatchOp) => p.op === "set_music";

function withMusicPatches(edl: EDL, patches: PatchOp[]): EDL {
  return patches.filter(isMusicPatch).reduce((acc, p) => applyMusicPatch(acc, p), edl);
}

function withoutMusicPatches(patches: PatchOp[]): PatchOp[] {
  return patches.filter((p) => !isMusicPatch(p));
}

type AutoResult = ReturnType<typeof lintEdl>;

/** Deterministic checks for the EDL. A bug in the linter must not kill the run, so it degrades to a warning. */
function autoChecks(edl: Iteration["edl"], clips: Record<string, SourceClip>, run: Run): AutoResult {
  try {
    return lintEdl(edl, clips, run.brief);
  } catch (err) {
    run.warnings.push(`auto checks unavailable: ${describeError(err)}`);
    return { checks: [], patches: [] };
  }
}

/** Argon's checks and patches first, then the auto ones (the order they are applied in). */
export function mergeCritique(argon: Critique, auto: AutoResult): Critique {
  return {
    ...argon,
    checks: [...argon.checks, ...auto.checks],
    patches: [...argon.patches, ...auto.patches],
  };
}

/** Where model deliberation or JSON debris starts inside text meant for the screen. */
const DEBRIS =
  /->|\bwait\b|exact transcript|\bcontext:|\n|"\s*[?:,}\]]|\[\d+(?:\.\d+)?-\d+(?:\.\d+)?\]|\d{6,}|_changed_|_ignore/i;
const TEXT_OPS = new Set<PatchOp["op"]>(["set_caption", "add_caption", "add_overlay", "set_overlay", "set_title", "set_end_title"]);
/** Longest sensible on-screen line per kind: a caption is a sentence, a label or a card is a few words. */
const MAX_TEXT: Partial<Record<PatchOp["op"], number>> = {
  set_caption: 160,
  add_caption: 160,
  add_overlay: 80,
  set_overlay: 80,
  set_title: 80,
  set_end_title: 80,
};

/** The clean, on-screen part of a model-written line, and whether anything was cut away. */
export function cleanScreenText(text: string, max = 160): { text: string; trimmed: boolean } {
  const m = DEBRIS.exec(text);
  let t = (m ? text.slice(0, m.index) : text).trim().replace(/[\s"'(\[{,;:\-–—]+$/u, "");
  if (t.length > max) t = t.slice(0, max).replace(/\s+\S*$/, "");
  return { text: t, trimmed: t !== text.trim() };
}

/**
 * The model occasionally writes its deliberation into a caption ("... -> wait no, exact transcript: ...")
 * or lets JSON debris spill into it. That text would be burned into the video, so it is trimmed back to
 * the clean phrase when one survives, and dropped otherwise. The notes are shown to the person.
 */
export function sanitizePatches(patches: PatchOp[]): { patches: PatchOp[]; dropped: string[] } {
  const kept: PatchOp[] = [];
  const dropped: string[] = [];
  // A critique sometimes degenerates into the same patch repeated dozens of times (often paired with
  // a remove of what it just added). One copy carries the whole intention.
  const seen = new Set<string>();
  let repeats = 0;
  const unique = patches.filter((p) => {
    const key = JSON.stringify(p);
    if (seen.has(key)) {
      repeats++;
      return false;
    }
    seen.add(key);
    return true;
  });
  if (repeats > 0) dropped.push(`collapsed ${repeats} repeated patch${repeats === 1 ? "" : "es"} from Argon's reply`);
  for (const p of unique) {
    if (!TEXT_OPS.has(p.op) || p.text == null) {
      kept.push(p);
      continue;
    }
    const { text, trimmed } = cleanScreenText(p.text, MAX_TEXT[p.op]);
    if (!trimmed) {
      kept.push(p);
      continue;
    }
    if (text.split(/\s+/).filter(Boolean).length >= 3) {
      dropped.push(`trimmed model notes from ${p.op}: kept ${JSON.stringify(text.length > 60 ? `${text.slice(0, 60)}…` : text)}`);
      kept.push({ ...p, text });
    } else {
      dropped.push(`dropped ${p.op}: its text looked like model notes (${JSON.stringify(p.text.slice(0, 60))}…)`);
    }
  }
  return { patches: kept, dropped };
}
