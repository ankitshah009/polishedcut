import { MIN_CUT_SECONDS, TITLE_SECONDS } from "./config";
import { applyExtraPatch } from "./extras";
import { type Caption, type Cut, type EDL, type PatchOp, type SourceClip } from "./schema";

export interface PatchResult {
  edl: EDL;
  skipped: string[]; // one message per patch that could not be applied
}

function clampCut(cut: Cut, clips: Record<string, SourceClip>): Cut {
  const clip = clips[cut.clipId];
  const hi = clip ? clip.duration : Math.max(cut.srcIn, cut.srcOut);
  return { ...cut, srcIn: Math.min(Math.max(0, cut.srcIn), hi), srcOut: Math.min(Math.max(0, cut.srcOut), hi) };
}

function nextCutId(cuts: Cut[]): string {
  const nums = cuts.map((c) => Number(c.id.slice(1))).filter((n) => Number.isInteger(n));
  return `c${Math.max(0, ...nums) + 1}`;
}

function findCut(cuts: Cut[], cutId: string | null | undefined): number {
  const i = cuts.findIndex((c) => c.id === cutId);
  if (i < 0) throw new Error(`unknown cutId ${cutId ?? "(none)"}`);
  return i;
}

function findCaption(captions: Caption[], index: number | null | undefined): number {
  if (index == null || index < 0 || index >= captions.length) throw new Error(`bad caption index ${index ?? "(none)"}`);
  return index;
}

function apply(edl: EDL, p: PatchOp, clips: Record<string, SourceClip>): void {
  switch (p.op) {
    case "trim": {
      const i = findCut(edl.cuts, p.cutId);
      const update: Partial<Cut> = {};
      if (p.srcIn != null) update.srcIn = p.srcIn;
      if (p.srcOut != null) update.srcOut = p.srcOut;
      if (Object.keys(update).length === 0) throw new Error("trim needs srcIn or srcOut");
      edl.cuts[i] = { ...edl.cuts[i], ...update };
      return;
    }
    case "remove_cut":
      edl.cuts.splice(findCut(edl.cuts, p.cutId), 1);
      return;
    case "insert_cut": {
      if (!p.clipId || !(p.clipId in clips) || p.srcIn == null || p.srcOut == null) {
        throw new Error("insert_cut needs a known clipId, srcIn and srcOut");
      }
      const free = p.cutId != null && edl.cuts.every((c) => c.id !== p.cutId);
      const id = free ? p.cutId! : nextCutId(edl.cuts);
      const at = p.index == null ? edl.cuts.length : Math.max(0, Math.min(p.index, edl.cuts.length));
      edl.cuts.splice(at, 0, { id, clipId: p.clipId, srcIn: p.srcIn, srcOut: p.srcOut, reason: p.text ?? "" });
      return;
    }
    case "move_cut": {
      if (p.index == null) throw new Error("move_cut needs index");
      const [cut] = edl.cuts.splice(findCut(edl.cuts, p.cutId), 1);
      edl.cuts.splice(Math.max(0, Math.min(p.index, edl.cuts.length)), 0, cut);
      return;
    }
    case "set_caption": {
      const i = findCaption(edl.captions, p.index);
      const update: Partial<Caption> = {};
      if (p.text != null) update.text = p.text;
      if (p.start != null) update.start = p.start;
      if (p.end != null) update.end = p.end;
      edl.captions[i] = { ...edl.captions[i], ...update };
      return;
    }
    case "remove_caption":
      edl.captions.splice(findCaption(edl.captions, p.index), 1);
      return;
    case "add_caption": {
      if (!p.text || p.start == null || p.end == null || p.end <= p.start) {
        throw new Error("add_caption needs text and start < end");
      }
      edl.captions.push({ text: p.text, start: Math.max(0, p.start), end: p.end });
      edl.captions.sort((a, b) => a.start - b.start);
      return;
    }
    case "set_title":
      edl.title = p.text ?? "";
      return;
    case "set_music": {
      // text = the new Lyria prompt; empty removes the bed. A changed prompt invalidates the old file.
      const prompt = (p.text ?? "").trim();
      if (!prompt) {
        edl.music = null;
        return;
      }
      if (edl.music?.prompt === prompt) return;
      edl.music = { prompt, ...(edl.music?.gainDb != null ? { gainDb: edl.music.gainDb } : {}) };
      return;
    }
    default:
      // The extra ops were handled by applyExtraPatch before we got here.
      throw new Error(`unknown op ${String(p.op)}`);
  }
}

/**
 * Return a new EDL with the patches applied. Pure: the input is not mutated.
 * A patch that fails is rolled back and reported in `skipped`. Cuts are clamped to clip bounds,
 * and cuts shorter than MIN_CUT_SECONDS after clamping are dropped.
 */
export function applyPatches(edl: EDL, patches: PatchOp[], clips: Record<string, SourceClip>): PatchResult {
  let working: EDL = structuredClone(edl);
  const skipped: string[] = [];
  for (const p of patches) {
    const snapshot = structuredClone(working);
    try {
      // Overlays, the closing card and the audio treatment live in lib/extras.ts; everything else is ours.
      const extra = applyExtraPatch(working, p);
      if (extra) working = extra;
      else apply(working, p, clips);
    } catch (err) {
      working = snapshot;
      skipped.push(`skipped ${p.op}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const cuts: Cut[] = [];
  for (const raw of working.cuts) {
    const cut = clampCut(raw, clips);
    if (cut.srcOut - cut.srcIn < MIN_CUT_SECONDS) {
      skipped.push(`dropped ${cut.id}: shorter than ${MIN_CUT_SECONDS}s after clamping`);
      continue;
    }
    cuts.push(cut);
  }
  return { edl: { ...working, cuts }, skipped };
}

/** Output-timeline bounds of each cut, including the title-card offset. */
export function timeline(edl: EDL): Array<{ cutId: string; start: number; end: number }> {
  let t = edl.title ? TITLE_SECONDS : 0;
  return edl.cuts.map((c) => {
    const start = t;
    t += c.srcOut - c.srcIn;
    return { cutId: c.id, start, end: t };
  });
}
