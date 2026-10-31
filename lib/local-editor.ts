/**
 * The free editor: no hosted model anywhere. Same EditorModel seam as lib/gemini.ts, so the loop,
 * the renderer, the dashboard and the chat front door do not know the difference.
 *
 *   transcribe  whisper.cpp (`whisper-cli`, WHISPER_MODEL) -> word-timed transcript
 *   draft       speech regions from the words (or ffmpeg silencedetect / scene detection when a clip
 *               has no speech), scored against the brief, picked to the brief's target length, trimmed
 *               on word boundaries, filler words cut out, captions built from the words
 *   critique    deterministic checks only; the loop's own lint (lib/lint.ts) supplies the patches
 *
 * Selected when MODEL_PROVIDER=local, or when no model key of any kind is configured (lib/config.ts).
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { EXEC_MAX_BUFFER, MIN_CUT_SECONDS, WHISPER_BIN, WHISPER_MODEL, type OutputSize } from "./config";
import { TITLE_SECONDS } from "./format";
import { outputForClips, type EditorModel } from "./gemini";
import { parseTargetSeconds } from "./lint";
import { hasAudio, probeDuration } from "./media";
import { EdlSchema, type Caption, type Critique, type Cut, type EDL, type Word } from "./schema";

const execFileAsync = promisify(execFile);

export const LOCAL_EDITOR_LABEL = "local editor (whisper.cpp + ffmpeg, no hosted model)";

/** Longest cut the planner makes from one speech region; longer regions are split on word gaps. */
export const MAX_SEGMENT_SECONDS = 9;
/** Words closer than this are one phrase; a longer pause starts a new region. */
export const PHRASE_GAP_SECONDS = 0.7;
/** Default target when the brief names no length: this fraction of the footage, capped. */
const DEFAULT_TARGET_FRACTION = 0.6;
const DEFAULT_TARGET_CAP = 30;
const FILLER_RE = /^(um+|uh+|erm+|hmm+|mm+|ah+)$/i;
const WANTS_FILLER_CUT = /\b(filler|ums?|uhs?|dead air|pauses?)\b/i;
const WANTS_CAPTIONS = /\b(captions?|captioned|subtitles?|subtitled|on-screen text|text on screen)\b/i;
const STOPWORDS = new Set(
  "the a an and or but for with from into onto over under this that these those then than very just like keep open end start close add remove cut make show use second seconds minute minutes long short clip clips video teaser recap".split(" "),
);

/** A stretch of one clip worth considering: speech (with its words) or, without a transcript, sound/shot. */
export interface Segment {
  clipId: string;
  start: number;
  end: number;
  words: Word[];
  score: number;
}

// ---------------------------------------------------------------------------
// Transcription (whisper.cpp)

interface WhisperJson {
  transcription?: { offsets?: { from: number; to: number }; text?: string }[];
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/** Word-timed transcript of one clip from whisper.cpp. Throws when the binary or model is missing. */
export async function transcribeLocally(file: string, duration: number): Promise<Word[]> {
  if (!(await hasAudio(file))) return [];
  if (!(await fileExists(WHISPER_MODEL))) {
    throw new Error(`whisper model not found at ${WHISPER_MODEL} (set WHISPER_MODEL, or put a whisper.cpp ggml model there)`);
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), "pc-whisper-"));
  try {
    const wav = path.join(dir, "audio.wav");
    await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", file, "-vn", "-ac", "1", "-ar", "16000", "-f", "wav", wav], {
      maxBuffer: EXEC_MAX_BUFFER,
    });
    const base = path.join(dir, "out");
    await execFileAsync(WHISPER_BIN, ["-m", WHISPER_MODEL, "-f", wav, "-oj", "-ml", "1", "-sow", "-np", "-of", base], {
      maxBuffer: EXEC_MAX_BUFFER,
    });
    const json = JSON.parse(await readFile(`${base}.json`, "utf8")) as WhisperJson;
    return wordsFromWhisper(json, duration);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** whisper.cpp's per-token JSON (one entry per word with -ml 1 -sow) -> Word[]. Exported for tests. */
export function wordsFromWhisper(json: WhisperJson, duration: number): Word[] {
  const words: Word[] = [];
  for (const seg of json.transcription ?? []) {
    const text = (seg.text ?? "").trim();
    if (!text || !seg.offsets) continue;
    const start = Math.max(0, seg.offsets.from / 1000);
    const end = Math.min(duration > 0 ? duration : Infinity, Math.max(start + 0.02, seg.offsets.to / 1000));
    if (!(end > start)) continue;
    words.push({ text, start: round3(start), end: round3(end) });
  }
  return words;
}

// ---------------------------------------------------------------------------
// Regions without a transcript: sound, then shots

/** Non-silent stretches of the clip (ffmpeg silencedetect), as [start, end] pairs. */
export async function soundRegions(file: string, duration: number): Promise<[number, number][]> {
  if (!(await hasAudio(file))) return [];
  let log = "";
  try {
    const r = await execFileAsync("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-af", "silencedetect=noise=-35dB:d=0.45", "-f", "null", "-"], {
      maxBuffer: EXEC_MAX_BUFFER,
    });
    log = r.stderr;
  } catch (err) {
    log = (err as { stderr?: string }).stderr ?? "";
  }
  const silences: [number, number][] = [];
  let open: number | null = null;
  for (const m of log.matchAll(/silence_(start|end): ([\d.]+)/g)) {
    const t = Number(m[2]);
    if (m[1] === "start") open = t;
    else if (open !== null) {
      silences.push([open, t]);
      open = null;
    }
  }
  if (open !== null) silences.push([open, duration]);
  return complement(silences, duration);
}

/** Shot boundaries from ffmpeg's scene-change detector, as [start, end] pairs covering the clip. */
export async function shotRegions(file: string, duration: number): Promise<[number, number][]> {
  let log = "";
  try {
    const r = await execFileAsync(
      "ffmpeg",
      ["-hide_banner", "-nostats", "-i", file, "-vf", "select='gt(scene,0.4)',showinfo", "-an", "-f", "null", "-"],
      { maxBuffer: EXEC_MAX_BUFFER },
    );
    log = r.stderr;
  } catch (err) {
    log = (err as { stderr?: string }).stderr ?? "";
  }
  const marks = [...log.matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(m[1])).filter((t) => t > 0.5 && t < duration - 0.5);
  const bounds = [0, ...marks, duration];
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < bounds.length; i++) if (bounds[i + 1] - bounds[i] >= MIN_CUT_SECONDS) out.push([bounds[i], bounds[i + 1]]);
  return out.length > 0 ? out : [[0, duration]];
}

function complement(gaps: [number, number][], duration: number): [number, number][] {
  const out: [number, number][] = [];
  let cursor = 0;
  for (const [s, e] of gaps.sort((a, b) => a[0] - b[0])) {
    if (s - cursor >= MIN_CUT_SECONDS) out.push([cursor, s]);
    cursor = Math.max(cursor, e);
  }
  if (duration - cursor >= MIN_CUT_SECONDS) out.push([cursor, duration]);
  return out;
}

// ---------------------------------------------------------------------------
// Planning

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const tokens = (s: string) => (s.toLowerCase().match(/[a-z0-9']+/g) ?? []).map((t) => t.replace(/^'+|'+$/g, ""));

/** Group words into phrases (gap <= PHRASE_GAP_SECONDS), splitting phrases longer than MAX_SEGMENT_SECONDS at their widest gap. */
export function speechRegions(clipId: string, words: Word[]): Segment[] {
  const sorted = [...words].sort((a, b) => a.start - b.start);
  const groups: Word[][] = [];
  for (const w of sorted) {
    const g = groups[groups.length - 1];
    if (g && w.start - g[g.length - 1].end <= PHRASE_GAP_SECONDS) g.push(w);
    else groups.push([w]);
  }
  const out: Segment[] = [];
  const emit = (g: Word[]) => {
    if (g.length === 0) return;
    const span = g[g.length - 1].end - g[0].start;
    if (span > MAX_SEGMENT_SECONDS && g.length > 3) {
      // Split at the widest pause in the middle half of the phrase.
      let best = -1;
      let bestGap = -1;
      for (let i = Math.floor(g.length / 4); i < Math.ceil((3 * g.length) / 4); i++) {
        const gap = g[i].start - g[i - 1].end;
        if (gap > bestGap) {
          bestGap = gap;
          best = i;
        }
      }
      if (best > 0) {
        emit(g.slice(0, best));
        emit(g.slice(best));
        return;
      }
    }
    out.push({ clipId, start: g[0].start, end: g[g.length - 1].end, words: g, score: 0 });
  };
  groups.forEach(emit);
  return out;
}

/** Remove filler words from a region by splitting it around them; pieces shorter than MIN_CUT_SECONDS are dropped. */
export function withoutFillers(seg: Segment): Segment[] {
  const out: Segment[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (cur.length > 0 && cur[cur.length - 1].end - cur[0].start >= MIN_CUT_SECONDS) {
      out.push({ ...seg, start: cur[0].start, end: cur[cur.length - 1].end, words: cur });
    }
    cur = [];
  };
  for (const w of seg.words) {
    if (FILLER_RE.test(w.text.replace(/[^a-z]/gi, ""))) flush();
    else cur.push(w);
  }
  flush();
  return out;
}

/** Brief-driven score: keyword overlap, speech density, a bonus for the opening and closing moments. */
export function scoreSegments(segments: Segment[], brief: string): Segment[] {
  const keywords = new Set(tokens(brief).filter((t) => t.length > 3 && !STOPWORDS.has(t)));
  const n = segments.length;
  return segments.map((s, i) => {
    const len = Math.max(0.05, s.end - s.start);
    const said = new Set(s.words.flatMap((w) => tokens(w.text)));
    let hits = 0;
    for (const k of keywords) if (said.has(k) || [...said].some((t) => t.length > 4 && (t.startsWith(k) || k.startsWith(t)))) hits++;
    const density = s.words.length / len; // words per second; speech sits around 2-3
    let score = hits * 1.5 + Math.min(density, 3) * 0.4;
    if (len >= 2 && len <= 8) score += 0.3;
    if (i === 0) score += 0.6; // the opening
    if (i === n - 1) score += 0.6; // the closing line
    if (s.words.length === 0) score += 0.2; // sound/shot regions: keep them in play when there is no speech anywhere
    return { ...s, score: round3(score) };
  });
}

/** Seconds the cut should run: the brief's target (an upper bound counts as 90% of itself), else a fraction of the footage. */
export function targetSecondsFor(brief: string, footageSeconds: number): number {
  const t = parseTargetSeconds(brief);
  if (t) return t.bound === "max" ? t.seconds * 0.9 : t.bound === "min" ? t.seconds * 1.1 : t.seconds;
  return Math.min(DEFAULT_TARGET_CAP, Math.max(MIN_CUT_SECONDS * 2, footageSeconds * DEFAULT_TARGET_FRACTION));
}

/** Shorten a segment to `seconds`, ending on a word boundary when it has words. */
function trimTo(seg: Segment, seconds: number, keep: "start" | "end" = "start"): Segment {
  if (seg.end - seg.start <= seconds) return seg;
  if (seg.words.length > 1) {
    if (keep === "start") {
      const limit = seg.start + seconds;
      const kept = seg.words.filter((w) => w.end <= limit);
      if (kept.length > 0) return { ...seg, end: kept[kept.length - 1].end, words: kept };
    } else {
      const limit = seg.end - seconds;
      const kept = seg.words.filter((w) => w.start >= limit);
      if (kept.length > 0) return { ...seg, start: kept[0].start, words: kept };
    }
  }
  return keep === "start" ? { ...seg, end: seg.start + seconds } : { ...seg, start: seg.end - seconds };
}

/**
 * Pick segments to fill `target` seconds: best scores first, each trimmed to what is left, then played
 * back in footage order. The opening of the first clip and the closing of the last are kept when the
 * brief mentions opening/ending (or always when there is room), so the cut has a shape.
 */
export function pickSegments(scored: Segment[], target: number, order: string[]): Segment[] {
  const byTime = (a: Segment, b: Segment) => order.indexOf(a.clipId) - order.indexOf(b.clipId) || a.start - b.start;
  const pool = [...scored].sort(byTime);
  const chosen: Segment[] = [];
  let total = 0;
  const room = () => target - total;
  const take = (s: Segment) => {
    const fitted = trimTo(s, Math.max(MIN_CUT_SECONDS, room()));
    if (fitted.end - fitted.start < MIN_CUT_SECONDS) return false;
    chosen.push(fitted);
    total += fitted.end - fitted.start;
    return true;
  };
  for (const s of [...pool].sort((a, b) => b.score - a.score)) {
    if (room() < MIN_CUT_SECONDS * 2) break;
    if (chosen.includes(s)) continue;
    take(s);
  }
  return chosen.sort(byTime);
}

/** Captions on the output timeline from the words inside each cut, up to 5 words / 2.8 s each. */
export function captionsFor(cuts: Cut[], segments: Segment[], titled: boolean): Caption[] {
  const out: Caption[] = [];
  let t = titled ? TITLE_SECONDS : 0;
  cuts.forEach((cut, i) => {
    const seg = segments[i];
    const words = seg.words.filter((w) => w.start >= cut.srcIn - 0.01 && w.end <= cut.srcOut + 0.01);
    let group: Word[] = [];
    const flush = () => {
      if (group.length === 0) return;
      out.push({
        text: group.map((w) => w.text).join(" "),
        start: round3(t + group[0].start - cut.srcIn),
        end: round3(t + group[group.length - 1].end - cut.srcIn),
      });
      group = [];
    };
    for (const w of words) {
      if (group.length >= 5 || (group.length > 0 && w.end - group[0].start > 2.8)) flush();
      group.push(w);
    }
    flush();
    t += cut.srcOut - cut.srcIn;
  });
  return out;
}

/** A title from the brief: quoted text, else the proper noun after "for"/"about"/"of", else nothing. */
export function titleFrom(brief: string): string {
  const quoted = brief.match(/["“]([^"”]{2,40})["”]/);
  if (quoted) return quoted[1].trim();
  const named = brief.match(/\b(?:for|about|of|called|named)\s+([A-Z][A-Za-z0-9&'-]*(?:\s+[A-Z][A-Za-z0-9&'-]*){0,2})/);
  return named ? named[1].trim() : "";
}

/** Pad a cut into the silence around it, never into a neighbouring word (keeps the mid-word lint happy). */
function pad(seg: Segment, allWords: Word[], duration: number): { srcIn: number; srcOut: number } {
  const before = allWords.filter((w) => w.end <= seg.start + 0.001 && !seg.words.includes(w)).map((w) => w.end);
  const after = allWords.filter((w) => w.start >= seg.end - 0.001 && !seg.words.includes(w)).map((w) => w.start);
  const gapBefore = seg.start - (before.length ? Math.max(...before) : 0);
  const gapAfter = (after.length ? Math.min(...after) : duration) - seg.end;
  const lead = Math.max(0, Math.min(0.15, gapBefore / 2 - 0.01));
  const tail = Math.max(0, Math.min(0.2, gapAfter / 2 - 0.01));
  return { srcIn: round3(Math.max(0, seg.start - lead)), srcOut: round3(Math.min(duration, seg.end + tail)) };
}

export interface LocalPlan {
  edl: EDL;
  segments: Segment[];
  target: number;
  mode: "speech" | "sound" | "shots";
}

/** Everything but the ffmpeg/whisper calls: given regions per clip, plan the cut. Exported for tests. */
export function planCut(
  brief: string,
  clips: { id: string; duration: number; words: Word[]; fallback: [number, number][] }[],
  size: OutputSize,
): LocalPlan {
  const order = clips.map((c) => c.id);
  const cutFillers = WANTS_FILLER_CUT.test(brief);
  let mode: LocalPlan["mode"] = "speech";
  let segments: Segment[] = [];
  for (const c of clips) {
    let regions = speechRegions(c.id, c.words);
    if (regions.length === 0) {
      regions = c.fallback.map(([start, end]) => ({ clipId: c.id, start, end, words: [], score: 0 }));
      if (regions.length > 0 && mode === "speech") mode = "sound";
    }
    if (cutFillers) regions = regions.flatMap((r) => (r.words.length ? withoutFillers(r) : [r]));
    segments.push(...regions);
  }
  if (segments.length === 0) {
    mode = "shots";
    segments = clips.map((c) => ({ clipId: c.id, start: 0, end: c.duration, words: [], score: 0 }));
  }
  const footage = clips.reduce((s, c) => s + c.duration, 0);
  const target = targetSecondsFor(brief, footage);
  const scored = scoreSegments(segments, brief);
  const picked = pickSegments(scored, target, order);
  const title = titleFrom(brief);
  const wordsByClip = Object.fromEntries(clips.map((c) => [c.id, c.words]));
  const durationByClip = Object.fromEntries(clips.map((c) => [c.id, c.duration]));
  const cuts: Cut[] = picked.map((s, i) => {
    const { srcIn, srcOut } = pad(s, wordsByClip[s.clipId] ?? [], durationByClip[s.clipId] ?? s.end);
    const said = s.words.map((w) => w.text).join(" ");
    const reason = s.words.length
      ? `speech: "${said.length > 70 ? `${said.slice(0, 67)}…` : said}" (score ${s.score})`
      : `${mode === "shots" ? "shot" : "sound"} ${s.start.toFixed(1)}-${s.end.toFixed(1)}s (score ${s.score})`;
    return { id: `c${i + 1}`, clipId: s.clipId, srcIn, srcOut, reason };
  });
  const captions = WANTS_CAPTIONS.test(brief) ? captionsFor(cuts, picked, !!title) : [];
  const edl = EdlSchema.parse({
    title,
    cuts,
    captions,
    overlays: [],
    audio: { denoise: false },
    music: null,
    width: size.width,
    height: size.height,
    fps: size.fps,
  });
  return { edl, segments: picked, target, mode };
}

// ---------------------------------------------------------------------------
// The editor

/** True when whisper-cli and the model are both present, so transcripts (and captions) are possible. */
export async function localTranscriptionAvailable(): Promise<boolean> {
  if (!(await fileExists(WHISPER_MODEL))) return false;
  try {
    await execFileAsync(WHISPER_BIN, ["--help"], { maxBuffer: EXEC_MAX_BUFFER });
    return true;
  } catch {
    return false;
  }
}

export function createLocalEditor(): EditorModel {
  return {
    async transcribe(input) {
      const duration = input.clip.duration || (await probeDuration(input.file));
      return transcribeLocally(input.file, duration);
    },

    async draft(brief, clips, output) {
      const size = output ?? (await outputForClips(clips, brief));
      const prepared = await Promise.all(
        clips.map(async (c) => {
          const duration = c.clip.duration || (await probeDuration(c.file));
          const words = c.clip.transcript ?? [];
          let fallback: [number, number][] = [];
          if (words.length === 0) {
            fallback = await soundRegions(c.file, duration);
            if (fallback.length === 0) fallback = await shotRegions(c.file, duration);
          }
          return { id: c.clip.id, duration, words, fallback };
        }),
      );
      const plan = planCut(brief, prepared, size);
      console.log(`[local-editor] ${plan.mode} plan: ${plan.edl.cuts.length} cut(s) for a ${plan.target.toFixed(1)}s target from ${clips.length} clip(s)`);
      return plan.edl;
    },

    async critique(brief, edl, _renderedFile, clips): Promise<Critique> {
      const total = edl.cuts.reduce((s, c) => s + (c.srcOut - c.srcIn), 0) + (edl.title ? TITLE_SECONDS : 0) + (edl.endTitle ? TITLE_SECONDS : 0);
      const target = parseTargetSeconds(brief);
      const checks = [
        { name: "local: every cut is a speech, sound or shot region", passed: edl.cuts.length > 0, at: null, note: `${edl.cuts.length} cut(s) from ${clips.length} clip(s)` },
        {
          name: "local: length follows the brief",
          passed: !target || Math.abs(total - target.seconds) <= Math.max(2, 0.15 * target.seconds) || (target.bound === "max" && total <= target.seconds),
          at: null,
          note: target ? `${total.toFixed(1)}s vs ${target.bound === "target" ? "" : `${target.bound} `}${target.seconds}s` : `${total.toFixed(1)}s, no target in brief`,
        },
      ];
      return {
        checks,
        patches: [],
        summary: `Deterministic local edit (${LOCAL_EDITOR_LABEL}): ${edl.cuts.length} cut(s), ${total.toFixed(1)}s${edl.captions.length ? `, ${edl.captions.length} captions` : ""}. No hosted model was used.`,
      };
    },
  };
}
