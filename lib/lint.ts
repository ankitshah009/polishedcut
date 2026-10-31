// Deterministic verification of an EDL against the source transcripts and the brief.
// Argon critiques what it sees; these checks cross-check what it did against the numbers it
// was given. Pure: no I/O, no randomness, inputs are never mutated, and the same inputs always
// produce the same four checks (in this order) and the same patches, so the loop can run this
// beside Argon's critique and feed the patches straight into applyPatches.
import { MIN_CUT_SECONDS, TITLE_SECONDS } from "./config";
import type { Check, Cut, EDL, PatchOp, SourceClip, Word } from "./schema";

/** A cut boundary closer than this to a word edge is not "mid-word". Seconds. */
export const WORD_TOLERANCE = 0.06;
/** srcOut may overshoot the probed clip duration by this much. Seconds. */
export const BOUNDS_TOLERANCE = 0.05;
/** A caption passes when at least this share of its tokens were spoken under it. */
export const CAPTION_MATCH_RATIO = 0.5;

export const LINT_CHECKS = {
  midWord: "auto: no mid-word cuts",
  captions: "auto: captions match speech",
  duration: "auto: duration matches brief",
  bounds: "auto: cuts inside clip bounds",
} as const;

export interface LintResult {
  checks: Check[];
  patches: PatchOp[];
}

interface Offense {
  at: number; // output-timeline seconds
  text: string;
}

const MAX_NOTED = 4; // offenses spelled out in a note before "+N more"

const fmt = (s: number) => s.toFixed(2);
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

// ---------------------------------------------------------------------------
// Timeline: output time = title offset + previous cut durations + (src - srcIn)

function titleOffset(edl: EDL): number {
  return edl.title ? TITLE_SECONDS : 0;
}

function cutDuration(cut: Cut): number {
  return Math.max(0, cut.srcOut - cut.srcIn);
}

/** Total length of the render: title card, every cut, and the closing card when there is one. */
export function totalDuration(edl: EDL): number {
  const endCard = edl.endTitle ? TITLE_SECONDS : 0;
  return edl.cuts.reduce((t, c) => t + cutDuration(c), titleOffset(edl)) + endCard;
}

/** Output-timeline time of source time `src` inside a cut, given by index or id. */
export function outputTimeOf(edl: EDL, cut: number | string, src: number): number {
  const i = typeof cut === "number" ? cut : edl.cuts.findIndex((c) => c.id === cut);
  if (!Number.isInteger(i) || i < 0 || i >= edl.cuts.length) throw new Error(`unknown cut ${String(cut)}`);
  const before = edl.cuts.slice(0, i).reduce((t, c) => t + cutDuration(c), titleOffset(edl));
  return before + (src - edl.cuts[i].srcIn);
}

export interface SourceWindow {
  cutIndex: number;
  cutId: string;
  clipId: string;
  srcStart: number;
  srcEnd: number;
}

/** The source-time windows an output window [start, end] plays: one per cut it overlaps, in order. */
export function sourceWindowsOf(edl: EDL, start: number, end: number): SourceWindow[] {
  const out: SourceWindow[] = [];
  let t = titleOffset(edl);
  edl.cuts.forEach((cut, cutIndex) => {
    const cutStart = t;
    const cutEnd = t + cutDuration(cut);
    t = cutEnd;
    const lo = Math.max(start, cutStart);
    const hi = Math.min(end, cutEnd);
    if (hi - lo <= 1e-6) return;
    out.push({
      cutIndex,
      cutId: cut.id,
      clipId: cut.clipId,
      srcStart: cut.srcIn + (lo - cutStart),
      srcEnd: cut.srcIn + (hi - cutStart),
    });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Transcript helpers

function sortedWords(clip: SourceClip | undefined): Word[] {
  return [...(clip?.transcript ?? [])].sort((a, b) => a.start - b.start || a.end - b.end);
}

/** The word that `t` falls strictly inside, beyond WORD_TOLERANCE of either edge. */
function wordAround(words: Word[], t: number): Word | undefined {
  return words.find((w) => t > w.start + WORD_TOLERANCE && t < w.end - WORD_TOLERANCE);
}

/** Move `t` out of any word it falls inside: back to word starts (-1) or forward to word ends (+1). */
function snapToGap(words: Word[], t: number, dir: -1 | 1): number {
  let out = t;
  for (let guard = 0; guard <= words.length; guard++) {
    const w = wordAround(words, out);
    if (!w) break;
    out = dir < 0 ? w.start : w.end;
  }
  return out;
}

/** Words spoken in a source window: at least half the word, or 0.2s of it, is inside. */
function wordsWithin(words: Word[], start: number, end: number): Word[] {
  return words.filter((w) => {
    const overlap = Math.min(w.end, end) - Math.max(w.start, start);
    if (overlap <= 0) return false;
    const len = Math.max(w.end - w.start, 1e-3);
    return overlap >= Math.min(0.5 * len, 0.2);
  });
}

/** Lowercased word tokens with punctuation stripped ("Don't stop!" -> ["dont", "stop"]). */
export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function buildCheck(name: string, offenses: Offense[], passNote: string): Check {
  if (offenses.length === 0) return { name, passed: true, at: null, note: passNote };
  const sorted = [...offenses].sort((a, b) => a.at - b.at);
  const shown = sorted.slice(0, MAX_NOTED).map((o) => o.text);
  const more = sorted.length - shown.length;
  return {
    name,
    passed: false,
    at: round3(sorted[0].at),
    note: shown.join("; ") + (more > 0 ? `; +${more} more` : ""),
  };
}

// ---------------------------------------------------------------------------
// auto: no mid-word cuts

/** First (srcIn, srcOut) pair that is a legal cut; the candidates are listed preferred-first. */
function pickBounds(ins: number[], outs: number[], duration: number): [number, number] {
  for (const a of ins) {
    for (const b of outs) {
      if (a >= 0 && b <= duration + BOUNDS_TOLERANCE && b - a >= MIN_CUT_SECONDS) return [a, Math.min(b, duration)];
    }
  }
  return [Math.max(0, ins[0]), Math.min(outs[0], duration)];
}

function lintMidWord(edl: EDL, clips: Record<string, SourceClip>): { check: Check; patches: PatchOp[] } {
  const offenses: Offense[] = [];
  const patches: PatchOp[] = [];
  let checked = 0;
  edl.cuts.forEach((cut, i) => {
    const clip = clips[cut.clipId];
    const words = sortedWords(clip);
    // No speech data means no judgement; an inverted cut belongs to the bounds check.
    if (!clip || words.length === 0 || !(cut.srcOut > cut.srcIn)) return;
    checked += 1;
    const inBounds = (t: number) => t >= 0 && t <= clip.duration + BOUNDS_TOLERANCE;
    const wIn = inBounds(cut.srcIn) ? wordAround(words, cut.srcIn) : undefined;
    const wOut = inBounds(cut.srcOut) ? wordAround(words, cut.srcOut) : undefined;
    if (!wIn && !wOut) return;

    const where = (w: Word) => `"${w.text}" (${fmt(w.start)}–${fmt(w.end)}s of ${cut.clipId})`;
    if (wIn) offenses.push({ at: outputTimeOf(edl, i, cut.srcIn), text: `${cut.id} starts mid-word in ${where(wIn)}` });
    if (wOut) offenses.push({ at: outputTimeOf(edl, i, cut.srcOut), text: `${cut.id} ends mid-word in ${where(wOut)}` });

    // Snap each offending boundary to a gap between words. Default: srcIn back to the start of
    // the word and srcOut forward to its end, so the word is heard whole. The far side of the
    // word is the fallback when the default would leave the clip or make the cut shorter than
    // MIN_CUT_SECONDS. One trim op per cut, carrying only the boundaries that moved.
    const ins = wIn ? [snapToGap(words, cut.srcIn, -1), snapToGap(words, cut.srcIn, 1)] : [cut.srcIn];
    const outs = wOut ? [snapToGap(words, cut.srcOut, 1), snapToGap(words, cut.srcOut, -1)] : [cut.srcOut];
    const [newIn, newOut] = pickBounds(ins, outs, clip.duration);
    const trim: PatchOp = { op: "trim", cutId: cut.id };
    if (wIn) trim.srcIn = newIn;
    if (wOut) trim.srcOut = newOut;
    patches.push(trim);
  });
  const passNote = checked === 0 ? "no transcript to check against" : "every cut boundary falls between words";
  return { check: buildCheck(LINT_CHECKS.midWord, offenses, passNote), patches };
}

// ---------------------------------------------------------------------------
// auto: captions match speech

function lintCaptions(edl: EDL, clips: Record<string, SourceClip>): { check: Check; patches: PatchOp[] } {
  const offenses: Offense[] = [];
  const sets: PatchOp[] = [];
  const removes: PatchOp[] = [];
  let judged = 0;
  edl.captions.forEach((cap, index) => {
    const windows = sourceWindowsOf(edl, cap.start, cap.end).filter(
      (w) => (clips[w.clipId]?.transcript?.length ?? 0) > 0,
    );
    if (windows.length === 0) return; // nothing under the caption has speech data: no judgement
    judged += 1;
    const spoken = windows.flatMap((w) => wordsWithin(sortedWords(clips[w.clipId]), w.srcStart, w.srcEnd));
    const spokenText = spoken.map((w) => w.text.trim()).filter(Boolean).join(" ");
    const label = `caption ${index + 1} "${cap.text}" (${fmt(cap.start)}–${fmt(cap.end)}s)`;
    if (spoken.length === 0) {
      offenses.push({ at: cap.start, text: `${label}: no speech under it` });
      removes.push({ op: "remove_caption", index });
      return;
    }
    const want = tokens(cap.text);
    if (want.length === 0) return; // nothing to contradict
    const have = new Set(tokens(spokenText));
    const hits = want.filter((t) => have.has(t)).length;
    if (hits / want.length >= CAPTION_MATCH_RATIO) return;
    offenses.push({ at: cap.start, text: `${label} vs spoken "${spokenText}" (${hits}/${want.length} words match)` });
    sets.push({ op: "set_caption", index, text: spokenText });
  });
  // set_caption first, while every index is still valid, then removals from the highest index
  // down, so the ops stay correct when applied one after another.
  removes.sort((a, b) => (b.index ?? 0) - (a.index ?? 0));
  const passNote =
    edl.captions.length === 0
      ? "no captions"
      : judged === 0
        ? "no transcript under the captions"
        : `${judged} caption${judged === 1 ? "" : "s"} match the transcript`;
  return { check: buildCheck(LINT_CHECKS.captions, offenses, passNote), patches: [...sets, ...removes] };
}

// ---------------------------------------------------------------------------
// auto: duration matches brief

export type DurationBound = "target" | "max" | "min";

export interface DurationTarget {
  seconds: number;
  bound: DurationBound;
  phrase: string; // the text in the brief the target was read from
}

const ONES = "one|two|three|four|five|six|seven|eight|nine";
const TEENS = "ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen";
const TENS = "twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety";
const WORD_VALUES: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

// "30-second", "30s", "30 seconds", "1.5 min", "2m" | "half a minute", "one minute", "forty-five seconds",
// "two and a half minutes", "a minute and a half".
const TARGET_RE = new RegExp(
  String.raw`\b(?:(?<num>\d+(?:\.\d+)?)\s*-?\s*(?<unit>seconds?|secs?|s|minutes?|mins?|m)` +
    String.raw`|(?<words>half[-\s]+an?|(?:${TENS})(?:[-\s](?:${ONES}))?|${TEENS}|${ONES}|an?)` +
    String.raw`(?<halfBefore>\s+and\s+a\s+half)?[-\s]+(?<wunit>seconds?|secs?|minutes?|mins?))` +
    String.raw`\b(?<halfAfter>\s+and\s+a\s+half\b)?`,
  "gi",
);

const QUALIFIER = String.raw`\s*(?:about|around|roughly|approximately|a|an|the)?\s*$`;
const MAX_BEFORE = new RegExp(
  String.raw`(?:\b(?:under|below|less than|no more than|not more than|no longer than|not longer than|at most|max(?:imum)?(?: of)?|within|up to|shorter than|cap(?:ped)?(?: at)?|not exceed(?:ing)?)|<=?)${QUALIFIER}`,
  "i",
);
const MAX_AFTER = /^\s*(?:or (?:less|under|shorter)|max(?:imum)?|tops|at most)\b/i;
const MIN_BEFORE = new RegExp(
  String.raw`(?:\b(?:at least|min(?:imum)?(?: of)?|no less than|not less than|no shorter than|longer than|more than)|>=?)${QUALIFIER}`,
  "i",
);
const MIN_AFTER = /^\s*(?:or (?:more|longer)|minimum|at least|plus)\b/i;

function wordValue(key: string): number {
  if (key.startsWith("half")) return 0.5;
  return key.split(" ").reduce((sum, part) => sum + (WORD_VALUES[part] ?? 0), 0);
}

function boundOf(brief: string, start: number, end: number): DurationBound {
  const before = brief.slice(Math.max(0, start - 40), start);
  const after = brief.slice(end, end + 16);
  if (MAX_BEFORE.test(before) || MAX_AFTER.test(after)) return "max";
  if (MIN_BEFORE.test(before) || MIN_AFTER.test(after)) return "min";
  return "target";
}

/**
 * Read a duration target out of the brief: the first phrase like "30-second", "30s", "30 seconds",
 * "half a minute", "one minute". Words such as "under", "at most", "within" make it an upper bound
 * ("max"); "at least" a lower bound ("min"). Null when the brief names no length.
 */
export function parseTargetSeconds(brief: string): DurationTarget | null {
  for (const m of brief.matchAll(TARGET_RE)) {
    const g = m.groups ?? {};
    let value: number;
    let unit: string;
    if (g.num != null) {
      if (/^[sm]$/i.test(g.unit) && /^\d{4,}$/.test(g.num)) continue; // "1980s" is a decade, not a length
      value = Number(g.num);
      unit = g.unit;
    } else {
      const key = g.words.toLowerCase().replace(/[-\s]+/g, " ");
      if ((key === "a" || key === "an") && /^sec/i.test(g.wunit)) continue; // "a second" is an idiom
      value = wordValue(key) + (g.halfBefore ? 0.5 : 0);
      unit = g.wunit;
    }
    if (g.halfAfter) value += 0.5;
    const seconds = /^m/i.test(unit) ? value * 60 : value;
    if (!(seconds > 0) || seconds > 3600) continue;
    const start = m.index ?? 0;
    return { seconds, bound: boundOf(brief, start, start + m[0].length), phrase: m[0].trim() };
  }
  return null;
}

function lintDuration(edl: EDL, brief: string): Check {
  const name = LINT_CHECKS.duration;
  const total = totalDuration(edl);
  const target = parseTargetSeconds(brief);
  if (!target) return { name, passed: true, at: null, note: "no target in brief" };
  const { seconds, bound, phrase } = target;
  const eps = 1e-6;
  if (bound === "max") {
    const passed = total <= seconds + eps;
    const note = `total ${fmt(total)}s vs at most ${fmt(seconds)}s ("${phrase}")`;
    return { name, passed, at: passed ? null : round3(seconds), note: passed ? note : `${note}; over by ${fmt(total - seconds)}s` };
  }
  if (bound === "min") {
    const passed = total >= seconds - eps;
    const note = `total ${fmt(total)}s vs at least ${fmt(seconds)}s ("${phrase}")`;
    return { name, passed, at: null, note: passed ? note : `${note}; short by ${fmt(seconds - total)}s` };
  }
  const tol = Math.max(2, 0.15 * seconds);
  const diff = total - seconds;
  const passed = Math.abs(diff) <= tol + eps;
  const note = `total ${fmt(total)}s vs target ${fmt(seconds)}s ("${phrase}"), allowed ±${fmt(tol)}s`;
  return {
    name,
    passed,
    at: !passed && diff > 0 ? round3(seconds) : null,
    note: passed ? note : `${note}; ${diff > 0 ? "over" : "short"} by ${fmt(Math.abs(diff))}s`,
  };
}

// ---------------------------------------------------------------------------
// auto: cuts inside clip bounds

function lintBounds(edl: EDL, clips: Record<string, SourceClip>): { check: Check; patches: PatchOp[] } {
  const offenses: Offense[] = [];
  const patches: PatchOp[] = [];
  edl.cuts.forEach((cut, i) => {
    const clip = clips[cut.clipId];
    if (!clip) {
      offenses.push({ at: outputTimeOf(edl, i, cut.srcIn), text: `${cut.id} uses unknown clip "${cut.clipId}"` });
      patches.push({ op: "remove_cut", cutId: cut.id });
      return;
    }
    const problems: string[] = [];
    if (cut.srcIn < 0) problems.push(`starts at ${fmt(cut.srcIn)}s, before the clip`);
    if (cut.srcOut > clip.duration + BOUNDS_TOLERANCE) {
      problems.push(`ends at ${fmt(cut.srcOut)}s, past the ${fmt(clip.duration)}s of ${cut.clipId}`);
    }
    if (cut.srcOut <= cut.srcIn) problems.push(`ends (${fmt(cut.srcOut)}s) at or before it starts (${fmt(cut.srcIn)}s)`);
    if (problems.length === 0) return;

    // Localize at the cut's start for a bad start or an inverted cut, else where the clip runs out.
    const atSrc = cut.srcIn < 0 || cut.srcOut <= cut.srcIn ? cut.srcIn : clip.duration;
    offenses.push({ at: outputTimeOf(edl, i, atSrc), text: `${cut.id} ${problems.join(" and ")}` });

    const lo = clamp(Math.min(cut.srcIn, cut.srcOut), 0, clip.duration);
    const hi = clamp(Math.max(cut.srcIn, cut.srcOut), 0, clip.duration);
    if (hi - lo < MIN_CUT_SECONDS) {
      patches.push({ op: "remove_cut", cutId: cut.id });
      return;
    }
    const trim: PatchOp = { op: "trim", cutId: cut.id };
    if (lo !== cut.srcIn) trim.srcIn = lo;
    if (hi !== cut.srcOut) trim.srcOut = hi;
    patches.push(trim);
  });
  return { check: buildCheck(LINT_CHECKS.bounds, offenses, "every cut lies inside its clip"), patches };
}

// ---------------------------------------------------------------------------

/**
 * Cross-check an EDL against the transcripts and the brief. Always returns the four "auto: " checks
 * in a fixed order; `at` is on the output timeline. Patches are ordered mid-word trims, caption
 * fixes, then bounds fixes, and are safe to apply sequentially with applyPatches.
 */
export function lintEdl(edl: EDL, clips: Record<string, SourceClip>, brief: string): LintResult {
  const midWord = lintMidWord(edl, clips);
  const captions = lintCaptions(edl, clips);
  const duration = lintDuration(edl, brief);
  const bounds = lintBounds(edl, clips);
  return {
    checks: [midWord.check, captions.check, duration, bounds.check],
    patches: [...midWord.patches, ...captions.patches, ...bounds.patches],
  };
}
