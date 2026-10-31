// Fill in what Argon left out of its caption patches before they reach applyPatches, so a usable
// intention ("add this caption", "retitle caption 8") is not silently thrown away for a missing
// timestamp or an off-by-one index. Pure: inputs are never mutated. The notes are shown in the UI,
// so they are written for a person.
import { outputTimeOf, tokens } from "./lint";
import { applyPatches } from "./patch";
import type { Caption, Cut, EDL, PatchOp, SourceClip, Word } from "./schema";

/** Seconds a placed caption lingers after its last word. */
export const CAPTION_TAIL_SECONDS = 0.15;
/** Share of positions that must match for a transcript window to count as the caption's speech. */
export const PLACE_MATCH_RATIO = 0.75;
/** Two captions whose windows overlap by more than this share (of the shorter one) are "the same moment". */
export const DUPLICATE_OVERLAP = 0.5;
/** Share of tokens two caption texts must share to count as "near-identical". */
export const DUPLICATE_TEXT_RATIO = 0.8;

export interface CompletionResult {
  patches: PatchOp[];
  notes: string[];
}

const fmt = (s: number) => s.toFixed(1);
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** The first few words of a caption for a note: 'Are you just trying…'. */
export function snippet(text: string, max = 40): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length <= max ? `'${t}'` : `'${t.slice(0, max).trimEnd()}…'`;
}

function hasWindow(p: PatchOp): p is PatchOp & { start: number; end: number } {
  return p.start != null && p.end != null && Number.isFinite(p.start) && Number.isFinite(p.end) && p.end > p.start;
}

// ---------------------------------------------------------------------------
// Locating caption text in the transcripts

interface Placement {
  cutIndex: number;
  start: number; // output-timeline seconds
  end: number;
}

interface Hit {
  words: Word[];
  ratio: number;
}

/** Best positional token match of `want` against `words`: the window of words covering it, or null. */
function matchWords(words: Word[], want: string[]): Hit | null {
  if (want.length === 0) return null;
  // Flatten to tokens, remembering which word each token came from ("well-known" -> two tokens).
  const flat: Array<{ token: string; word: number }> = [];
  words.forEach((w, i) => tokens(w.text).forEach((token) => flat.push({ token, word: i })));
  let best: Hit | null = null;
  for (let at = 0; at + want.length <= flat.length; at++) {
    let hits = 0;
    for (let k = 0; k < want.length; k++) if (flat[at + k].token === want[k]) hits++;
    const ratio = hits / want.length;
    if (ratio < PLACE_MATCH_RATIO || (best && ratio <= best.ratio)) continue;
    const first = flat[at].word;
    const last = flat[at + want.length - 1].word;
    best = { words: words.slice(first, last + 1), ratio };
    if (ratio === 1) break; // first exact occurrence wins
  }
  return best;
}

function sortedWords(clip: SourceClip | undefined): Word[] {
  return [...(clip?.transcript ?? [])].sort((a, b) => a.start - b.start || a.end - b.end);
}

/** Words that are at least half (or 0.2s) inside the cut's source window. */
function wordsInCut(words: Word[], cut: Cut): Word[] {
  return words.filter((w) => {
    const overlap = Math.min(w.end, cut.srcOut) - Math.max(w.start, cut.srcIn);
    if (overlap <= 0) return false;
    return overlap >= Math.min(0.5 * Math.max(w.end - w.start, 1e-3), 0.2);
  });
}

function cutBounds(edl: EDL, i: number): [number, number] {
  return [outputTimeOf(edl, i, edl.cuts[i].srcIn), outputTimeOf(edl, i, edl.cuts[i].srcOut)];
}

/** Where `text` is spoken on the output timeline: the first cut whose speech contains it. */
function placeInCuts(text: string, edl: EDL, clips: Record<string, SourceClip>): Placement | null {
  const want = tokens(text);
  if (want.length === 0) return null;
  let best: (Placement & { ratio: number }) | null = null;
  edl.cuts.forEach((cut, i) => {
    if (!(cut.srcOut > cut.srcIn)) return;
    const hit = matchWords(wordsInCut(sortedWords(clips[cut.clipId]), cut), want);
    if (!hit || (best && hit.ratio <= best.ratio)) return;
    const [lo, hi] = cutBounds(edl, i);
    const first = hit.words[0];
    const last = hit.words[hit.words.length - 1];
    const start = Math.max(lo, Math.min(hi, outputTimeOf(edl, i, first.start)));
    const end = Math.max(lo, Math.min(hi, outputTimeOf(edl, i, last.end) + CAPTION_TAIL_SECONDS));
    if (end - start < 0.05) return;
    best = { cutIndex: i, start: round3(start), end: round3(end), ratio: hit.ratio };
  });
  return best;
}

/** Where `text` is spoken in any clip at all, for the "it exists, but not in the cut" note. */
function spokenAnywhere(text: string, clips: Record<string, SourceClip>): string | null {
  const want = tokens(text);
  for (const clip of Object.values(clips)) {
    const hit = matchWords(sortedWords(clip), want);
    if (hit) return `${clip.id} at ${fmt(hit.words[0].start)}s`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Duplicates

function nearIdentical(a: string, b: string): boolean {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.length === 0 || tb.length === 0) return ta.length === tb.length;
  const setB = new Set(tb);
  const shared = ta.filter((t) => setB.has(t)).length;
  return shared / Math.max(ta.length, tb.length) >= DUPLICATE_TEXT_RATIO;
}

/** Index of an existing caption that already says `text` at the same moment, or -1. */
function duplicateOf(captions: Caption[], text: string, start: number, end: number, skip = -1): number {
  return captions.findIndex((c, i) => {
    if (i === skip) return false;
    const overlap = Math.min(c.end, end) - Math.max(c.start, start);
    const shorter = Math.max(Math.min(c.end - c.start, end - start), 1e-3);
    return overlap / shorter > DUPLICATE_OVERLAP && nearIdentical(c.text, text);
  });
}

// ---------------------------------------------------------------------------

const captionLabel = (c: Caption, i: number) => `caption ${i + 1} (${snippet(c.text)} at ${fmt(c.start)}–${fmt(c.end)}s)`;

/**
 * Repair Argon's patches against the EDL they will be applied to:
 * - add_caption without a usable start/end is timed from the transcript under the cuts;
 * - set_caption on a caption that does not exist becomes add_caption when it carries text;
 * - captions that restate an existing caption at the same moment are dropped;
 * - out-of-range caption/cut indexes get a plain-language note instead of a generic skip.
 * Patches are checked in order against the EDL as it will look when each one is applied, so
 * indexes stay right after earlier adds and removes. Unknown or unaffected ops pass through as is.
 */
export function completePatches(patches: PatchOp[], edl: EDL, clips: Record<string, SourceClip>): CompletionResult {
  const out: PatchOp[] = [];
  const notes: string[] = [];
  let working: EDL = structuredClone(edl);

  const keep = (p: PatchOp) => {
    out.push(p);
    const { edl: next } = applyPatches(working, [p], clips);
    working = next;
  };
  const count = () => `the cut has ${working.captions.length} caption${working.captions.length === 1 ? "" : "s"}`;
  const inRange = (index: number | null | undefined): index is number =>
    index != null && Number.isInteger(index) && index >= 0 && index < working.captions.length;

  /**
   * Give an add_caption a window (from the transcript if needed) and push it unless it is a duplicate.
   * `later` is the rest of the batch: a caption that a later patch removes or retexts is not a duplicate.
   */
  const addCaption = (p: PatchOp, text: string, later: PatchOp[] = []) => {
    let start: number;
    let end: number;
    if (hasWindow(p)) {
      start = p.start;
      end = p.end;
    } else {
      const placed = placeInCuts(text, working, clips);
      if (!placed) {
        const elsewhere = spokenAnywhere(text, clips);
        notes.push(
          `could not place caption ${snippet(text)} — no matching speech in the cuts` +
            (elsewhere ? ` (it is spoken in ${elsewhere}, outside the cut)` : ""),
        );
        return;
      }
      start = placed.start;
      end = placed.end;
      notes.push(`Placed Argon's caption ${snippet(text)} at ${fmt(start)}–${fmt(end)}s from the transcript`);
    }
    const dup = duplicateOf(working.captions, text, start, end);
    const goesAway = later.some(
      (q) => (q.op === "remove_caption" && q.index === dup) || (q.op === "set_caption" && q.index === dup && q.text?.trim()),
    );
    if (dup >= 0 && !goesAway) {
      notes.push(`dropped duplicate caption ${snippet(text)} — ${captionLabel(working.captions[dup], dup)} already says that`);
      return;
    }
    keep({ ...p, op: "add_caption", index: undefined, text, start, end });
  };

  for (const [pi, p] of patches.entries()) {
    const later = patches.slice(pi + 1);
    switch (p.op) {
      case "add_caption": {
        const text = p.text?.trim() ?? "";
        if (!text) {
          notes.push("dropped add_caption: it carried no text");
          break;
        }
        addCaption(p, text, later);
        break;
      }
      case "set_caption": {
        const text = p.text?.trim();
        if (!inRange(p.index)) {
          const which = p.index == null ? "no caption index" : `caption ${p.index + 1}`;
          if (text) {
            notes.push(`set_caption named ${which}, but ${count()}; adding ${snippet(text)} as a new caption instead`);
            addCaption(p, text, later);
          } else {
            notes.push(`dropped set_caption: it named ${which} and ${count()}, and it carried no new text to add`);
          }
          break;
        }
        const current = working.captions[p.index];
        const merged: Caption = {
          text: text ?? current.text,
          start: p.start ?? current.start,
          end: p.end ?? current.end,
        };
        const dup = duplicateOf(working.captions, merged.text, merged.start, merged.end, p.index);
        if (dup >= 0) {
          notes.push(
            `dropped set_caption on caption ${p.index + 1}: ${snippet(merged.text)} would duplicate ${captionLabel(working.captions[dup], dup)}`,
          );
          break;
        }
        // Whitespace-only text would burn an empty box into the video; treat it as "keep the text".
        keep({ ...p, text: text || undefined });
        break;
      }
      case "remove_caption": {
        if (!inRange(p.index)) {
          const which = p.index == null ? "no caption index" : `caption ${p.index + 1}`;
          notes.push(`dropped remove_caption: it named ${which}, but ${count()}`);
          break;
        }
        keep(p);
        break;
      }
      case "insert_cut":
      case "move_cut": {
        const n = working.cuts.length;
        const max = p.op === "insert_cut" ? n : Math.max(0, n - 1);
        if (p.index != null && (p.index < 0 || p.index > max)) {
          const where = p.index < 0 ? "before the first cut" : `past the last of the ${n} cut${n === 1 ? "" : "s"}`;
          notes.push(`${p.op} asked for position ${p.index}, which is ${where}; placed it ${p.index < 0 ? "first" : "last"} instead`);
          keep({ ...p, index: Math.max(0, Math.min(p.index, max)) });
          break;
        }
        keep(p);
        break;
      }
      case "add_overlay":
      case "set_overlay":
      case "remove_overlay": {
        const overlays = working.overlays ?? [];
        const ocount = `the cut has ${overlays.length} label${overlays.length === 1 ? "" : "s"}`;
        const oinRange = (i: number | null | undefined): i is number =>
          i != null && Number.isInteger(i) && i >= 0 && i < overlays.length;
        const text = p.text?.trim();
        if (p.op === "remove_overlay") {
          if (!oinRange(p.index)) {
            notes.push(`dropped remove_overlay: it named ${p.index == null ? "no label" : `label ${p.index + 1}`}, but ${ocount}`);
            break;
          }
          keep(p);
          break;
        }
        if (p.op === "set_overlay" && oinRange(p.index)) {
          keep(p);
          break;
        }
        // add_overlay, or a set_overlay that names a label that does not exist: treat as an add.
        if (!text) {
          notes.push(`dropped ${p.op}: it carried no text`);
          break;
        }
        let start = p.start;
        let end = p.end;
        if (start == null || end == null || !(end > start)) {
          // No usable window: the named cut, else the cut at the given position, else the first cut
          // that has no label yet. A label somewhere sensible beats a label thrown away.
          const byId = working.cuts.find((c) => c.id === p.cutId);
          const byIndex = p.index != null && p.index >= 0 && p.index < working.cuts.length ? working.cuts[p.index] : undefined;
          const unlabeled = working.cuts.find((c) => {
            const s = outputTimeOf(working, c.id, c.srcIn);
            const e = outputTimeOf(working, c.id, c.srcOut);
            return !overlays.some((o) => o.start < e && o.end > s);
          });
          const cut = byId ?? byIndex ?? unlabeled;
          if (!cut) {
            notes.push(`could not place label ${snippet(text)} — Argon gave no time range and every cut already has a label`);
            break;
          }
          start = outputTimeOf(working, cut.id, cut.srcIn);
          end = outputTimeOf(working, cut.id, cut.srcOut);
          const how = byId ? "" : byIndex ? " (by position)" : " (first unlabeled cut)";
          notes.push(`Placed Argon's label ${snippet(text)} over ${cut.id} at ${fmt(start)}–${fmt(end)}s${how}`);
        } else if (p.op === "set_overlay") {
          notes.push(`set_overlay named label ${(p.index ?? 0) + 1}, but ${ocount}; adding ${snippet(text)} as a new label instead`);
        }
        keep({ ...p, op: "add_overlay", index: undefined, text, start: round3(start), end: round3(end) });
        break;
      }
      default:
        keep(p);
    }
  }
  // Identical notes (the same repair applied to repeated patches) are reported once.
  return { patches: out, notes: [...new Set(notes)] };
}
