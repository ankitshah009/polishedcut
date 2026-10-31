// Client-safe helpers. No Node imports here: this file is bundled into the browser.
import type { Cut, EDL, Iteration, PatchOp, Run, RunStatus } from "./schema";

/** Seconds of the title card at the start of every render. Shared with the server pipeline. */
export const TITLE_SECONDS = 2;

export function formatTime(seconds: number): string {
  // Work in tenths so 59.96 rounds to "1:00.0", never "0:60.0".
  const tenths = Number.isFinite(seconds) ? Math.round(Math.max(0, seconds) * 10) : 0;
  const m = Math.floor(tenths / 600);
  return `${m}:${((tenths % 600) / 10).toFixed(1).padStart(4, "0")}`;
}

export function formatSeconds(seconds: number): string {
  return `${(Number.isFinite(seconds) ? seconds : 0).toFixed(1)}s`;
}

/** Wall-clock span for the "Cut in 1m 24s" label. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round((Number.isFinite(ms) ? ms : 0) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Total pipeline time recorded on the run, or null when nothing was timed. */
export function runElapsedMs(run: Pick<Run, "timings">): number | null {
  const t = run.timings ?? [];
  return t.length ? t.reduce((s, x) => s + (Number.isFinite(x.ms) ? x.ms : 0), 0) : null;
}

export function videoUrl(runId: string, relPath: string): string {
  return `/api/runs/${runId}/files/${relPath.split("/").map(encodeURIComponent).join("/")}`;
}

/* ---------- Optional run fields (music bed, title art, token usage) ----------
 * These land on the server contract incrementally. The readers below accept a run or EDL
 * whether or not the typed schema has caught up, and return nothing when the field is absent.
 */

export interface UsageEntry {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  ms?: number;
}

export interface MusicBed {
  prompt: string;
  gainDb?: number;
  file?: string;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Per-model token usage recorded on the run, or [] when the backend has not reported any. */
export function runUsage(run: Pick<Run, "id"> & { usage?: unknown }): UsageEntry[] {
  const raw = run.usage;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((u): UsageEntry[] => {
    if (!u || typeof u !== "object") return [];
    const o = u as Record<string, unknown>;
    return [
      {
        model: typeof o.model === "string" ? o.model : "unknown",
        inputTokens: num(o.inputTokens),
        outputTokens: num(o.outputTokens),
        cachedTokens: num(o.cachedTokens),
        ms: num(o.ms),
      },
    ];
  });
}

/** The music bed Argon asked for, or null when the EDL has none. */
export function edlMusic(edl: EDL & { music?: unknown }): MusicBed | null {
  const m = edl.music;
  if (!m || typeof m !== "object") return null;
  const o = m as Record<string, unknown>;
  if (typeof o.prompt !== "string" || !o.prompt.trim()) return null;
  return {
    prompt: o.prompt.trim(),
    gainDb: typeof o.gainDb === "number" && Number.isFinite(o.gainDb) ? o.gainDb : undefined,
    file: typeof o.file === "string" && o.file ? o.file : undefined,
  };
}

/** Relative path of the generated title-card art, or null. */
export function edlTitleImage(edl: EDL & { titleImage?: unknown }): string | null {
  return typeof edl.titleImage === "string" && edl.titleImage.trim() ? edl.titleImage.trim() : null;
}

/** An on-screen label (separate from the captions): where it sits and when it shows, on the output timeline. */
export interface Overlay {
  text: string;
  start: number;
  end: number;
  position: string;
}

/** Audio treatment Argon asked for on the mix. */
export interface AudioMix {
  denoise: boolean;
  musicGainDb?: number;
}

/** The labels Argon placed on screen, in start order, or [] when the EDL has none. */
export function edlOverlays(edl: { overlays?: unknown }): Overlay[] {
  const raw = edl.overlays;
  if (!Array.isArray(raw)) return [];
  return raw
    .flatMap((o): Overlay[] => {
      if (!o || typeof o !== "object") return [];
      const r = o as Record<string, unknown>;
      if (typeof r.text !== "string" || !r.text.trim()) return [];
      const start = num(r.start);
      const end = typeof r.end === "number" && Number.isFinite(r.end) ? r.end : start;
      return [{ text: r.text.trim(), start, end: Math.max(start, end), position: typeof r.position === "string" && r.position ? r.position : "lower-third" }];
    })
    .sort((a, b) => a.start - b.start);
}

/** The closing card's text, or null when the cut ends on footage. */
export function edlEndTitle(edl: { endTitle?: unknown }): string | null {
  return typeof edl.endTitle === "string" && edl.endTitle.trim() ? edl.endTitle.trim() : null;
}

/** Relative path of the closing card's art, or null. Only meaningful when edlEndTitle() is set. */
export function edlEndImage(edl: { endImage?: unknown }): string | null {
  return typeof edl.endImage === "string" && edl.endImage.trim() ? edl.endImage.trim() : null;
}

/** The audio treatment, or null when nothing beyond the plain mix was asked for. */
export function edlAudio(edl: { audio?: unknown }): AudioMix | null {
  const a = edl.audio;
  if (!a || typeof a !== "object") return null;
  const o = a as Record<string, unknown>;
  const denoise = o.denoise === true;
  const gain = typeof o.musicGainDb === "number" && Number.isFinite(o.musicGainDb) ? o.musicGainDb : undefined;
  if (!denoise && gain == null) return null;
  return { denoise, musicGainDb: gain };
}

/** Seconds the closing card adds after the last cut: TITLE_SECONDS when an end title is set, else 0. */
export function endCardSeconds(edl: EDL): number {
  return edlEndTitle(edl) ? TITLE_SECONDS : 0;
}

/** Parse a `position` like "top-left" or "bottom" into a 3x3 cell for the little position glyph. */
export function overlayCell(position: string): { row: 0 | 1 | 2; col: 0 | 1 | 2 } {
  const p = position.toLowerCase();
  const row = /top|upper/.test(p) ? 0 : /bottom|lower/.test(p) ? 2 : 1;
  const col = /left/.test(p) ? 0 : /right/.test(p) ? 2 : 1;
  return { row, col };
}

/* ---------- Run warnings, read as notes from Argon ---------- */

export type NoteTone = "info" | "caution" | "final";

export interface ArgonNote {
  /** The message without its "v2:" prefix. */
  text: string;
  tone: NoteTone;
  /** The version the note was recorded against, when the message said. */
  version?: number;
}

/**
 * One run warning as a tidy note: "v2: skipped …" becomes { text: "skipped …", version: 2 }. Things Argon did
 * ("Placed …", "Resumed …", "Started …") are information, things it could not do are cautions, and a note
 * that the loop stopped is final.
 */
export function describeWarning(warning: string): ArgonNote {
  let text = warning.trim();
  let version: number | undefined;
  const m = /^v(\d+)\s*:\s*/i.exec(text);
  if (m) {
    version = Number(m[1]);
    text = text.slice(m[0].length);
  }
  const stopped = /\bstopped\b(?:\s+at\s+v(\d+))?/i.exec(text);
  if (stopped?.[1] && version == null) version = Number(stopped[1]);
  let tone: NoteTone = "caution";
  if (stopped) tone = "final";
  else if (/^(placed|resumed|started)\b/i.test(text)) tone = "info";
  else if (/\b(skipped|dropped|could not|couldn[’']t|unavailable|ignored)\b/i.test(text)) tone = "caution";
  if (text) text = text[0].toUpperCase() + text.slice(1);
  return { text: text || warning, tone, version };
}

/* ---------- Cost estimates ---------- */

/** USD per million tokens for one model. */
export interface ModelRate {
  input: number;
  output: number;
  cached?: number;
  /** Flat USD per request, for models billed per call rather than per token. */
  perCall?: number;
  /** Substring of the model name this rate applies to, when the server says. */
  match?: string;
  /** "published" or "assumed", when the server says where the number came from. */
  source?: string;
  note?: string;
}

export type Rates = Record<string, ModelRate>;

/** Used until /api/pricing answers, and for any model it does not list. */
export const DEFAULT_RATES: Rates = {
  argon: { input: 2, output: 10, cached: 0.5 },
};

/**
 * Accepts the `perModelRates` object from /api/pricing in any of the shapes it is likely to take
 * ({ input, output } per M, `inputPerM`/`outputPerM`, or `inputUsdPerM`) and normalises it.
 */
export function normalizeRates(raw: unknown): Rates {
  const out: Rates = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [model, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const o = v as Record<string, unknown>;
    const pick = (re: RegExp) => {
      const k = Object.keys(o).find((key) => re.test(key) && typeof o[key] === "number");
      return k ? num(o[k]) : undefined;
    };
    const input = pick(/^input/i);
    const output = pick(/^output/i);
    const perCall = pick(/^perCall/i);
    if (input == null && output == null && perCall == null) continue;
    const rate: ModelRate = { input: input ?? 0, output: output ?? 0, cached: pick(/^cache/i) };
    if (perCall != null) rate.perCall = perCall;
    if (typeof o.match === "string" && o.match) rate.match = o.match;
    if (typeof o.source === "string" && o.source) rate.source = o.source;
    if (typeof o.note === "string" && o.note) rate.note = o.note;
    out[model] = rate;
  }
  return out;
}

/** Rate for `model`: exact key, then a rate whose `match` or key sits inside the model name (or vice versa), then argon's. */
export function rateFor(model: string, rates: Rates = DEFAULT_RATES): ModelRate {
  if (rates[model]) return rates[model];
  const m = model.toLowerCase();
  const hit = Object.entries(rates).find(([k, r]) => {
    const needle = (r.match ?? k).toLowerCase();
    return m.includes(needle) || needle.includes(m);
  });
  return hit?.[1] ?? rates.argon ?? DEFAULT_RATES.argon;
}

export interface CostEstimate {
  usd: number;
  tokens: number;
  /** Per model, in the order first seen. */
  byModel: { model: string; usd: number; tokens: number }[];
}

/** Client-side spend estimate for a run's usage. Cached tokens bill at the cached rate when one is known. */
export function estimateCost(usage: UsageEntry[], rates: Rates = DEFAULT_RATES): CostEstimate {
  const byModel = new Map<string, { usd: number; tokens: number }>();
  for (const u of usage) {
    const r = rateFor(u.model, rates);
    const cached = Math.min(u.cachedTokens ?? 0, u.inputTokens);
    const fresh = u.inputTokens - cached;
    const usd = (fresh * r.input + cached * (r.cached ?? r.input) + u.outputTokens * r.output) / 1e6 + (r.perCall ?? 0);
    const cur = byModel.get(u.model) ?? { usd: 0, tokens: 0 };
    byModel.set(u.model, { usd: cur.usd + usd, tokens: cur.tokens + u.inputTokens + u.outputTokens });
  }
  const list = [...byModel].map(([model, v]) => ({ model, ...v }));
  return {
    usd: list.reduce((s, x) => s + x.usd, 0),
    tokens: list.reduce((s, x) => s + x.tokens, 0),
    byModel: list,
  };
}

/** "$0.42", "$12.50", "$0.004" for sub-cent amounts, "$0.00" for nothing. */
export function formatUsd(usd: number): string {
  const v = Number.isFinite(usd) ? Math.max(0, usd) : 0;
  if (v === 0) return "$0.00";
  if (v < 0.01) return `$${v.toFixed(3)}`;
  if (v < 1000) return `$${v.toFixed(2)}`;
  return `$${Math.round(v).toLocaleString("en-US")}`;
}

/** "612", "61k", "1.2M". */
export function formatTokens(n: number): string {
  const v = Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
  if (v < 1000) return String(v);
  if (v < 1e6) return `${Math.round(v / 1000)}k`;
  return `${(v / 1e6).toFixed(v < 1e7 ? 1 : 0)}M`;
}

/** The "≈ $0.42 · 61k tokens" chip text, or null when no usage was recorded. */
export function costChip(usage: UsageEntry[], rates: Rates = DEFAULT_RATES): string | null {
  if (!usage.length) return null;
  const c = estimateCost(usage, rates);
  if (c.tokens === 0) return null;
  return `≈ ${formatUsd(c.usd)} · ${formatTokens(c.tokens)} tokens`;
}

/* ---------- Pipeline stages ---------- */

export type StageId = "transcribe" | "analyze" | "draft" | "generate" | "art" | "music" | "render" | "watch" | "fix";

const OPTIONAL_STAGE: { id: StageId; re: RegExp }[] = [
  { id: "analyze", re: /analy[sz]/i },
  { id: "generate", re: /generat|omni/i },
  { id: "art", re: /\b(art|title[-_ ]?(image|art|card)|image|poster)/i },
  { id: "music", re: /music|score|audio[-_ ]?bed/i },
];

/**
 * Stage ids to show in the stepper for this run: the core five, with "analyze", "generate", "art" and
 * "music" inserted once the run's timings show those stages ran, and "fix" only after a first version exists.
 */
export function stageIds(run: Pick<Run, "timings" | "iterations">): StageId[] {
  const names = (run.timings ?? []).map((t) => t.stage);
  const has = (id: StageId) => names.some((n) => OPTIONAL_STAGE.find((o) => o.id === id)!.re.test(n));
  const ids: StageId[] = ["transcribe"];
  if (has("analyze")) ids.push("analyze");
  ids.push("draft");
  if (has("generate")) ids.push("generate");
  if (has("art")) ids.push("art");
  if (has("music")) ids.push("music");
  ids.push("render", "watch");
  if (run.iterations.length > 0) ids.push("fix");
  return ids;
}

/** Index into stageIds(run) of the stage running now. */
export function currentStage(run: Pick<Run, "timings" | "iterations" | "status" | "clips">): number {
  const ids = stageIds(run);
  const names = (run.timings ?? []).map((t) => t.stage.toLowerCase());
  const n = run.iterations.length;
  const at = (id: StageId) => Math.max(0, ids.indexOf(id));
  switch (run.status) {
    case "queued":
      return 0;
    case "drafting": {
      // Pre-render stages finish in order; the first one without a timing is the live one.
      const pre = ids.filter((id) => ["transcribe", "analyze", "draft", "generate", "art", "music"].includes(id));
      const done = (id: StageId) => {
        if (id === "transcribe") return names.some((s) => s.startsWith("transcribe")) || run.clips.some((c) => c.transcript.length > 0);
        if (id === "draft") return names.some((s) => s.startsWith("draft"));
        return names.some((s) => OPTIONAL_STAGE.find((o) => o.id === id)!.re.test(s));
      };
      const live = pre.find((id) => !done(id));
      // Every pre-render stage has reported: the render is about to start.
      return live ? at(live) : Math.min(ids.length - 1, at(pre[pre.length - 1]) + 1);
    }
    case "rendering":
      return n > 0 ? at("fix") : at("render");
    case "critiquing":
      return at("watch");
    default:
      return at("draft");
  }
}

/* ---------- Progress narrative (ETA and stage states) ---------- */

export type StageState = "done" | "live" | "todo";

/**
 * Median wall-clock per stage, measured on the demo footage (nine phone clips, ~60 s target). The
 * critique is per version, and the fix loop may run up to MAX_ITERATIONS versions, so every ETA from
 * these is an "about", never a promise.
 */
export const STAGE_MEDIAN_MS: Record<StageId, number> = {
  transcribe: 25_000,
  analyze: 1_000,
  draft: 15_000,
  generate: 60_000,
  art: 17_000,
  music: 22_000,
  render: 6_000,
  watch: 35_000,
  fix: 41_000, // one more render plus one more critique
};

/** done / live / todo for every stage in stageIds(run), in order. */
export function stageStates(run: Pick<Run, "timings" | "iterations" | "status" | "clips">): { id: StageId; state: StageState }[] {
  const ids = stageIds(run);
  const cur = currentStage(run);
  return ids.map((id, k) => ({ id, state: k < cur ? "done" : k === cur ? "live" : "todo" }));
}

/**
 * Rough milliseconds left on a live run: the medians of every stage still to come, plus one fix round
 * when the last watched version failed a check. Null once the run has ended.
 */
export function estimateRemainingMs(run: Pick<Run, "timings" | "iterations" | "status" | "clips">, maxIterations = 3): number | null {
  if (run.status === "done" || run.status === "error") return null;
  const states = stageStates(run);
  const n = run.iterations.length;
  let ms = 0;
  for (const s of states) {
    if (s.state === "done") continue;
    if (s.id === "fix") {
      // A fix is only certain when the last critique failed and another version is allowed.
      const lastFailed = run.iterations.at(-1)?.critique?.checks.some((c) => !c.passed) ?? false;
      if (s.state === "live" || (lastFailed && n < maxIterations)) ms += STAGE_MEDIAN_MS.fix;
      else if (n < maxIterations && run.iterations.at(-1)?.critique == null) ms += STAGE_MEDIAN_MS.fix / 2;
      continue;
    }
    // "watch" is already waiting on a render that exists when the status is critiquing.
    ms += STAGE_MEDIAN_MS[s.id];
  }
  // A version that is still being drafted will be watched; a first fix is likely but not certain.
  if (n === 0 && !states.some((s) => s.id === "fix")) ms += STAGE_MEDIAN_MS.fix / 2;
  return Math.max(5_000, Math.round(ms));
}

/** "about 2 min left", "about a minute left", "under a minute left". Honest wording for a guess. */
export function formatEta(ms: number | null): string | null {
  if (ms == null || !Number.isFinite(ms)) return null;
  const s = Math.max(0, ms / 1000);
  if (s < 45) return "under a minute left";
  const m = Math.round(s / 60);
  if (m <= 1) return "about a minute left";
  return `about ${m} min left`;
}

/** One sentence on what Argon is doing right now, for the live narrative. */
export function stageSentence(run: Pick<Run, "timings" | "iterations" | "status" | "clips">): string {
  const n = run.iterations.length;
  const clips = run.clips.length;
  const live = stageStates(run).find((s) => s.state === "live")?.id ?? "draft";
  switch (live) {
    case "transcribe":
      return `Argon is listening to ${clips === 1 ? "the clip" : `all ${clips} clips`} and timing every word.`;
    case "analyze":
      return "Argon is reading your brief for a target length, a tone and the moments that must appear.";
    case "draft":
      return "Argon is watching the footage and picking the moments that answer your brief.";
    case "generate":
      return "Argon is generating the shots the footage did not have.";
    case "art":
      return "Argon is painting the title card.";
    case "music":
      return "Argon is composing an instrumental bed to the brief.";
    case "render":
      return `ffmpeg is assembling v${n + 1} from the edit list.`;
    case "watch":
      return `Argon is watching v${Math.max(n, 1)} and grading it against your brief, check by check.`;
    case "fix":
      return `Argon is patching what failed in v${n} and rendering v${n + 1}.`;
  }
}

export interface CutRange {
  cut: Cut;
  start: number; // output-timeline seconds
  end: number;
}

/** Output-timeline bounds of each cut, after the title card. Browser twin of lib/patch timeline(). */
export function cutRanges(edl: EDL): CutRange[] {
  let t = edl.title ? TITLE_SECONDS : 0;
  return edl.cuts.map((cut) => {
    const start = t;
    t += Math.max(0, cut.srcOut - cut.srcIn);
    return { cut, start, end: t };
  });
}

/** Output-timeline seconds the footage ends at: title card plus every cut, before any closing card. */
export function cutsEnd(edl: EDL): number {
  return (edl.title ? TITLE_SECONDS : 0) + edl.cuts.reduce((s, c) => s + Math.max(0, c.srcOut - c.srcIn), 0);
}

/** Total output length: title card, cuts, and the closing card when edl.endTitle is set. */
export function edlDuration(edl: EDL): number {
  return cutsEnd(edl) + endCardSeconds(edl);
}

/** Output-timeline bounds of the closing card, or null when the cut ends on footage. */
export function endCardRange(edl: EDL): { start: number; end: number } | null {
  const len = endCardSeconds(edl);
  if (!len) return null;
  const start = cutsEnd(edl);
  return { start, end: start + len };
}

/** The cut playing at output time `t`, or null during the title card, the closing card, or past the end. */
export function cutAt(edl: EDL, t: number): CutRange | null {
  const ranges = cutRanges(edl);
  return ranges.find((r) => t >= r.start && t < r.end) ?? (t >= edlDuration(edl) ? (ranges.at(-1) ?? null) : null);
}

export type CheckGroupId = "brief" | "auto" | "craft";

/** "brief: …" checks come from the user's brief, "auto: …" are deterministic transcript checks, the rest is craft. */
export function checkGroup(name: string): CheckGroupId {
  if (/^brief:/i.test(name)) return "brief";
  if (/^auto:/i.test(name)) return "auto";
  return "craft";
}

export function checkLabel(name: string): string {
  const s = name.replace(/^(brief|auto):\s*/i, "").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : name;
}

export function describePatch(op: PatchOp): string {
  const cut = op.cutId ?? "cut";
  switch (op.op) {
    case "trim": {
      const bits: string[] = [];
      if (op.srcIn != null) bits.push(`start at ${formatSeconds(op.srcIn)}`);
      if (op.srcOut != null) bits.push(`end at ${formatSeconds(op.srcOut)}`);
      return `Trim ${cut} to ${bits.join(" and ") || "new bounds"}`;
    }
    case "remove_cut":
      return `Remove ${cut}`;
    case "insert_cut": {
      const range = op.srcIn != null && op.srcOut != null ? ` ${formatSeconds(op.srcIn)}–${formatSeconds(op.srcOut)}` : "";
      const at = op.index != null ? ` at position ${op.index + 1}` : "";
      return `Insert ${op.clipId ?? "a clip"}${range}${at}`;
    }
    case "move_cut":
      return `Move ${cut} to position ${(op.index ?? 0) + 1}`;
    case "set_caption":
      return `Change caption ${(op.index ?? 0) + 1}${op.text ? ` to “${op.text}”` : ""}`;
    case "remove_caption":
      return `Remove caption ${(op.index ?? 0) + 1}`;
    case "add_caption":
      return `Add caption “${op.text ?? ""}”${op.start != null ? ` at ${formatTime(op.start)}` : ""}`;
    case "set_title":
      return op.text ? `Set title to “${op.text}”` : "Remove the title card";
    default:
      return `Unknown edit (${String((op as { op?: unknown }).op)})`;
  }
}

export interface FixCard {
  title: string;
  before: string;
  after: string;
  reason: string;
  /** Output-timeline seconds where the change lands, when it can be placed. */
  at?: number;
}

const s2 = (n: number) => `${n.toFixed(2)}s`;
const q = (t: string) => `“${t}”`;
const moved = (a: number, b: number) => Math.abs(a - b) > 1e-3;

/**
 * A before → after card for one patch: `before` is the EDL the patch was written against,
 * `after` (when the next version exists) supplies the values that were actually applied.
 */
export function describeFix(op: PatchOp, before: EDL, after?: EDL): FixCard {
  const ranges = cutRanges(before);
  const endOfCut = ranges.at(-1)?.end ?? cutsEnd(before);
  const range = (id: string | null | undefined) => ranges.find((r) => r.cut.id === id);
  const capIndex = op.index ?? -1;

  switch (op.op) {
    case "trim": {
      const r = range(op.cutId);
      if (!r) {
        const bounds = [op.srcIn, op.srcOut].filter((n): n is number => n != null).map(s2);
        return { title: `Trim ${op.cutId ?? "cut"}`, before: "—", after: bounds.join("–") || "new bounds", reason: describePatch(op) };
      }
      const { cut } = r;
      const next = after?.cuts.find((c) => c.id === cut.id);
      const newIn = next?.srcIn ?? op.srcIn ?? cut.srcIn;
      const newOut = next?.srcOut ?? op.srcOut ?? cut.srcOut;
      const inMoved = moved(newIn, cut.srcIn);
      const outMoved = moved(newOut, cut.srcOut);
      const oldLen = cut.srcOut - cut.srcIn;
      const newLen = newOut - newIn;
      const delta = newLen - oldLen;
      const change = `${Math.abs(delta).toFixed(2)}s ${delta < 0 ? "shorter" : "longer"}`;
      if (outMoved && !inMoved) {
        return {
          title: `Trim ${cut.id} end`,
          before: s2(cut.srcOut),
          after: s2(newOut),
          reason: `${cut.id} now ends at ${cut.clipId} ${s2(newOut)}, ${change}.`,
          at: r.start + Math.max(0, Math.min(oldLen, newLen)),
        };
      }
      if (inMoved && !outMoved) {
        return {
          title: `Trim ${cut.id} start`,
          before: s2(cut.srcIn),
          after: s2(newIn),
          reason: `${cut.id} now starts at ${cut.clipId} ${s2(newIn)}, ${change}.`,
          at: r.start,
        };
      }
      return {
        title: `Re-trim ${cut.id}`,
        before: `${s2(cut.srcIn)}–${s2(cut.srcOut)}`,
        after: `${s2(newIn)}–${s2(newOut)}`,
        reason: inMoved || outMoved ? `${cut.id} is re-trimmed inside ${cut.clipId}, ${change}.` : `${cut.id} keeps its bounds.`,
        at: r.start,
      };
    }
    case "remove_cut": {
      const r = range(op.cutId);
      if (!r) return { title: `Remove ${op.cutId ?? "cut"}`, before: "—", after: "removed", reason: describePatch(op) };
      const { cut } = r;
      const len = cut.srcOut - cut.srcIn;
      return {
        title: `Remove ${cut.id}`,
        before: `${cut.id} · ${formatSeconds(len)}`,
        after: "removed",
        reason: `${cut.id} (${cut.clipId} ${s2(cut.srcIn)}–${s2(cut.srcOut)}) is dropped; the cut is ${formatSeconds(len)} shorter.`,
        at: r.start,
      };
    }
    case "insert_cut": {
      const pos = op.index == null ? ranges.length : Math.max(0, Math.min(op.index, ranges.length));
      const bounds = op.srcIn != null && op.srcOut != null ? `${s2(op.srcIn)}–${s2(op.srcOut)}` : "";
      const clip = op.clipId ?? "a clip";
      return {
        title: `Insert ${clip}`,
        before: "—",
        after: [clip, bounds].filter(Boolean).join(" "),
        reason: `${clip}${bounds ? ` ${bounds}` : ""} joins the cut at position ${pos + 1}${op.text ? `: ${op.text}` : "."}`,
        at: ranges[pos]?.start ?? endOfCut,
      };
    }
    case "move_cut": {
      const i = ranges.findIndex((r) => r.cut.id === op.cutId);
      const to = (op.index ?? 0) + 1;
      if (i < 0) return { title: `Move ${op.cutId ?? "cut"}`, before: "—", after: `position ${to}`, reason: describePatch(op) };
      return {
        title: `Move ${op.cutId}`,
        before: `position ${i + 1}`,
        after: `position ${to}`,
        reason: `${op.cutId} moves from position ${i + 1} to ${to}.`,
        at: ranges[i].start,
      };
    }
    case "set_caption": {
      const cap = before.captions[capIndex];
      const n = capIndex + 1;
      if (!cap) return { title: `Caption ${n}`, before: "—", after: q(op.text ?? ""), reason: describePatch(op) };
      const next = after?.captions[capIndex];
      const text = next?.text ?? op.text ?? cap.text;
      const start = next?.start ?? op.start ?? cap.start;
      const end = next?.end ?? op.end ?? cap.end;
      if (text !== cap.text) {
        return { title: `Rewrite caption ${n}`, before: q(cap.text), after: q(text), reason: `Caption ${n} at ${formatTime(cap.start)} now reads ${q(text)}.`, at: cap.start };
      }
      return {
        title: `Retime caption ${n}`,
        before: `${s2(cap.start)}–${s2(cap.end)}`,
        after: `${s2(start)}–${s2(end)}`,
        reason: `Caption ${n} now shows from ${formatTime(start)} to ${formatTime(end)}.`,
        at: start,
      };
    }
    case "remove_caption": {
      const cap = before.captions[capIndex];
      const n = capIndex + 1;
      if (!cap) return { title: `Remove caption ${n}`, before: "—", after: "removed", reason: describePatch(op) };
      return { title: `Remove caption ${n}`, before: q(cap.text), after: "removed", reason: `The caption at ${formatTime(cap.start)} is dropped.`, at: cap.start };
    }
    case "add_caption": {
      const when = op.start != null && op.end != null ? ` from ${formatTime(op.start)} to ${formatTime(op.end)}` : "";
      return { title: "Add caption", before: "—", after: q(op.text ?? ""), reason: `New caption${when}.`, at: op.start ?? undefined };
    }
    case "set_title":
      return {
        title: op.text ? "Set title" : "Remove title card",
        before: before.title ? q(before.title) : "no title",
        after: op.text ? q(op.text) : "no title",
        reason: op.text ? `The title card now reads ${q(op.text)}.` : `The ${TITLE_SECONDS}-second title card is removed.`,
        at: 0,
      };
    default:
      return { title: describePatch(op), before: "—", after: "—", reason: "" };
  }
}

/**
 * Cards for every difference between two versions, used when no patch list explains the change
 * (a director's note, or patches the server skipped). Cuts are matched by id, captions by index.
 */
export function diffEdl(before: EDL, after: EDL): FixCard[] {
  const cards: FixCard[] = [];
  if (before.title !== after.title) cards.push(describeFix({ op: "set_title", text: after.title }, before, after));

  for (const cut of before.cuts) {
    const next = after.cuts.find((c) => c.id === cut.id);
    if (!next) cards.push(describeFix({ op: "remove_cut", cutId: cut.id }, before, after));
    else if (moved(next.srcIn, cut.srcIn) || moved(next.srcOut, cut.srcOut)) {
      cards.push(describeFix({ op: "trim", cutId: cut.id, srcIn: next.srcIn, srcOut: next.srcOut }, before, after));
    }
  }
  after.cuts.forEach((cut, i) => {
    if (!before.cuts.some((c) => c.id === cut.id)) {
      cards.push(describeFix({ op: "insert_cut", cutId: cut.id, clipId: cut.clipId, srcIn: cut.srcIn, srcOut: cut.srcOut, index: i, text: cut.reason }, before, after));
    }
  });
  const keptBefore = before.cuts.filter((c) => after.cuts.some((a) => a.id === c.id)).map((c) => c.id);
  const keptAfter = after.cuts.filter((c) => before.cuts.some((b) => b.id === c.id)).map((c) => c.id);
  if (keptBefore.join() !== keptAfter.join()) {
    cards.push({ title: "Reorder cuts", before: keptBefore.join(" "), after: keptAfter.join(" "), reason: "The cuts play in a new order.", at: 0 });
  }

  const n = Math.min(before.captions.length, after.captions.length);
  for (let i = 0; i < n; i++) {
    const a = before.captions[i];
    const b = after.captions[i];
    if (a.text !== b.text) cards.push(describeFix({ op: "set_caption", index: i, text: b.text }, before, after));
    else if (moved(a.start, b.start) || moved(a.end, b.end)) {
      cards.push(describeFix({ op: "set_caption", index: i, start: b.start, end: b.end }, before, after));
    }
  }
  for (let i = n; i < before.captions.length; i++) cards.push(describeFix({ op: "remove_caption", index: i }, before, after));
  for (let i = n; i < after.captions.length; i++) {
    const c = after.captions[i];
    cards.push(describeFix({ op: "add_caption", text: c.text, start: c.start, end: c.end }, before, after));
  }

  // Fields outside the patch vocabulary (labels, the closing card, the audio mix) still get a card.
  const labelsBefore = edlOverlays(before);
  const labelsAfter = edlOverlays(after);
  if (JSON.stringify(labelsBefore) !== JSON.stringify(labelsAfter)) {
    const count = (l: Overlay[]) => (l.length ? `${l.length} label${l.length === 1 ? "" : "s"}` : "no labels");
    cards.push({
      title: labelsAfter.length && !labelsBefore.length ? "Add labels" : labelsAfter.length ? "Change labels" : "Remove labels",
      before: count(labelsBefore),
      after: count(labelsAfter),
      reason: labelsAfter.length ? `On-screen labels: ${labelsAfter.map((l) => q(l.text)).join(", ")}.` : "The on-screen labels are removed.",
      at: labelsAfter[0]?.start ?? labelsBefore[0]?.start ?? 0,
    });
  }
  const endBefore = edlEndTitle(before);
  const endAfter = edlEndTitle(after);
  if (endBefore !== endAfter) {
    cards.push({
      title: endAfter ? (endBefore ? "Change end card" : "Add end card") : "Remove end card",
      before: endBefore ? q(endBefore) : "no end card",
      after: endAfter ? q(endAfter) : "no end card",
      reason: endAfter ? `The cut now ends on a ${TITLE_SECONDS}-second card reading ${q(endAfter)}.` : `The ${TITLE_SECONDS}-second closing card is removed.`,
      at: cutsEnd(after),
    });
  }
  const mixBefore = edlAudio(before);
  const mixAfter = edlAudio(after);
  if (JSON.stringify(mixBefore) !== JSON.stringify(mixAfter)) {
    const describe = (m: AudioMix | null) =>
      m ? [m.denoise ? "denoised" : null, m.musicGainDb != null ? `music ${m.musicGainDb > 0 ? "+" : ""}${m.musicGainDb} dB` : null].filter(Boolean).join(" · ") : "plain mix";
    cards.push({ title: "Change audio mix", before: describe(mixBefore), after: describe(mixAfter), reason: "The soundtrack is mixed differently.", at: 0 });
  }
  return cards;
}

/**
 * The fixes that turned `from` into `to`: Argon's patches diffed against the next EDL, or a plain EDL
 * diff for note-driven versions (and when no patches were recorded). Shared by the Fixes tab and the theater.
 */
export function fixCardsBetween(from: Iteration, to?: Iteration): FixCard[] {
  const patches = from.critique?.patches ?? [];
  if (to?.note) return diffEdl(from.edl, to.edl);
  if (patches.length) return patches.map((p) => describeFix(p, from.edl, to?.edl));
  return to ? diffEdl(from.edl, to.edl) : [];
}

/** "Argon re-cut twice to fix 3 issues" for the version bar, or null when there was nothing to say. */
export function recutText(iterations: Iteration[]): string | null {
  let rounds = 0;
  let issues = 0;
  let notes = 0;
  iterations.forEach((it, k) => {
    if (k === 0) return;
    if (it.note) {
      notes++;
      return;
    }
    rounds++;
    issues += iterations[k - 1].critique?.checks.filter((c) => !c.passed).length ?? 0;
  });
  const parts: string[] = [];
  if (rounds > 0) {
    const times = rounds === 1 ? "once" : rounds === 2 ? "twice" : `${rounds} times`;
    parts.push(`Argon re-cut ${times} to fix ${issues} issue${issues === 1 ? "" : "s"}`);
  } else if (iterations.length > 0 && iterations[0].critique?.checks.every((c) => c.passed)) {
    parts.push("First cut passed every check");
  }
  if (notes > 0) parts.push(`${notes} director's note${notes === 1 ? "" : "s"} applied`);
  return parts.length ? parts.join(" · ") : null;
}

/** One line for the live status bar. */
export function phaseText(run: Run): { text: string; tone: "busy" | "done" | "error" | "idle" } {
  const n = run.iterations?.length ?? 0;
  const status: RunStatus = run.status;
  switch (status) {
    case "queued":
      return { text: "Queued", tone: "busy" };
    case "drafting":
      return { text: "Argon is drafting the first cut", tone: "busy" };
    case "rendering":
      return { text: `Rendering v${n + 1}`, tone: "busy" };
    case "critiquing":
      return { text: `Argon is watching v${Math.max(n, 1)}`, tone: "busy" };
    case "done":
      return {
        text: `Final cut ready · v${Math.max(n, 1)}${n > 1 ? `, after ${n - 1} fix${n > 2 ? "es" : ""}` : ""}`,
        tone: "done",
      };
    case "error":
      return { text: run.error || "Something went wrong", tone: "error" };
    default:
      return { text: "Waiting", tone: "idle" };
  }
}
