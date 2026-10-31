// Cost model. Everything here is an ESTIMATE: the Gemini API never reports money, only tokens,
// and only Argon's hackathon price is published. Every number can be overridden from the environment.
import type { RunUsage } from "./schema";

export const BILLING_URL = "https://aistudio.google.com/billing";
export const ARGON_INTRO_PRICE_ENDS = "2026-11-30";

/** USD per 1M tokens for one model family. */
export interface ModelRate {
  /** Which usage rows this rate applies to (substring of the model id, case-insensitive). */
  match: string;
  inputPerM: number;
  outputPerM: number;
  /** Price of a cached input token: inputPerM * PRICE_CACHED_MULTIPLIER. */
  cachedPerM: number;
  /** Flat USD per call for models that are not token-billed (Lyria). */
  perCall: number;
  source: "published" | "assumed";
  note: string;
}

const round = (usd: number) => Math.round(usd * 1_000_000) / 1_000_000;

function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

type RateInput = Omit<ModelRate, "cachedPerM">;

/** Read at call time so tests (and ops) can override with env vars. */
export function perModelRates(): Record<string, ModelRate> {
  const cached = cachedMultiplier();
  const raw: Record<string, RateInput> = {
    argon: {
      match: "argon",
      inputPerM: envNum("PRICE_ARGON_IN_PER_M", 2),
      outputPerM: envNum("PRICE_ARGON_OUT_PER_M", 10),
      perCall: 0,
      source: "published",
      note: `gemini-4-argon hackathon pricing, $2 in / $10 out per 1M tokens through ${ARGON_INTRO_PRICE_ENDS}`,
    },
    flash: {
      match: "flash",
      inputPerM: envNum("PRICE_FLASH_IN_PER_M", 0.5),
      outputPerM: envNum("PRICE_FLASH_OUT_PER_M", 3),
      perCall: 0,
      source: "assumed",
      note: "Flash-tier list price is not published for this model; assumed from the previous Flash generation",
    },
    transcribe: {
      match: "transcribe",
      inputPerM: envNum("PRICE_TRANSCRIBE_IN_PER_M", 1),
      outputPerM: envNum("PRICE_TRANSCRIBE_OUT_PER_M", 4),
      perCall: 0,
      source: "assumed",
      note: "Transcription model price is not published; assumed",
    },
    lyria: {
      match: "lyria",
      inputPerM: 0,
      outputPerM: 0,
      perCall: envNum("PRICE_LYRIA_PER_CALL", 0.1),
      source: "assumed",
      note: "Music generation is billed per request, not per token; assumed (not used by the current loop)",
    },
    upload: {
      match: "files.upload",
      inputPerM: 0,
      outputPerM: 0,
      perCall: 0,
      source: "published",
      note: "Files API storage is free (48h retention)",
    },
  };
  return Object.fromEntries(Object.entries(raw).map(([k, r]) => [k, { ...r, cachedPerM: round(r.inputPerM * cached) }]));
}

/** Cached prompt tokens are billed at a fraction of the input price. */
export function cachedMultiplier(): number {
  return Math.min(1, envNum("PRICE_CACHED_MULTIPLIER", 0.25));
}

const UNKNOWN_MODEL_NOTE = "Unknown model id: billed at the Argon rate as a conservative estimate";

export function rateFor(model: string): ModelRate {
  const rates = perModelRates();
  const id = model.toLowerCase();
  for (const rate of Object.values(rates)) if (id.includes(rate.match)) return rate;
  return { ...rates.argon, match: model, source: "assumed", note: UNKNOWN_MODEL_NOTE };
}

export interface CostEstimate {
  usd: number;
  byModel: Record<string, { usd: number; inputTokens: number; outputTokens: number; cachedTokens: number; calls: number }>;
  totalTokens: number;
  /** Always true: the API does not report charges, these are token counts times a rate table. */
  estimated: true;
}

/** USD for one list of usage rows. Cached tokens are a subset of inputTokens and are discounted. */
export function estimateCost(usage: readonly RunUsage[] | undefined | null): CostEstimate {
  const byModel: CostEstimate["byModel"] = {};
  let usd = 0;
  let totalTokens = 0;
  const cached = cachedMultiplier();
  for (const u of usage ?? []) {
    const rate = rateFor(u.model);
    const cachedTokens = Math.min(u.cachedTokens ?? 0, u.inputTokens);
    const fresh = u.inputTokens - cachedTokens;
    const cost =
      (fresh * rate.inputPerM + cachedTokens * rate.inputPerM * cached + u.outputTokens * rate.outputPerM) / 1_000_000 +
      rate.perCall;
    const row = (byModel[u.model] ??= { usd: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, calls: 0 });
    row.usd = round(row.usd + cost);
    row.inputTokens += u.inputTokens;
    row.outputTokens += u.outputTokens;
    row.cachedTokens += cachedTokens;
    row.calls += 1;
    usd += cost;
    totalTokens += u.inputTokens + u.outputTokens;
  }
  return { usd: round(usd), byModel, totalTokens, estimated: true };
}

// ---------------------------------------------------------------------------
// Sellable plans
// ---------------------------------------------------------------------------

/**
 * Modelled API spend for one typical cut (two source clips, ~60s, 2 iterations: 1 draft + 2 critiques),
 * used until measured run.usage data exists. Video is ~263 tokens/s at the default frame rate, so each
 * 60s video costs roughly 16k input tokens per model call on top of the prompt.
 *   Argon: draft (2 videos + prompt ~35k in, ~5k out incl. thinking) + 2 critiques (~20k in, ~5k out each) = ~75k in / ~15k out
 *   Transcription: 2 clips (~16k in, ~1k out each) = ~32k in / ~2k out
 */
export function modeledCutUsage(): RunUsage[] {
  return [
    { model: "gemini-4-argon", inputTokens: 75_000, outputTokens: 15_000, cachedTokens: 0, ms: 0 },
    { model: "gemini-3.5-transcribe", inputTokens: 32_000, outputTokens: 2_000, cachedTokens: 0, ms: 0 },
  ];
}

/** USD we expect to pay Google for one cut. COST_PER_CUT_USD overrides the model (set it from measured runs). */
export function costPerCut(): number {
  return envNum("COST_PER_CUT_USD", estimateCost(modeledCutUsage()).usd);
}

export interface Plan {
  id: string;
  name: string;
  priceUsd: number;
  /** Cuts included per month (pay-as-you-go: 1 per purchase). */
  cuts: number;
  period: "month" | "cut";
  features: string[];
  /** What the included cuts cost us at full use. */
  apiCostUsd: number;
  /** Gross margin at full use, 0..1 (negative means the plan loses money if every cut is used). */
  margin: number;
  /** Price per included cut, for comparison with pay-as-you-go. */
  perCutUsd: number;
}

function plan(p: Omit<Plan, "apiCostUsd" | "margin" | "perCutUsd">, cost: number): Plan {
  const apiCostUsd = round(p.cuts * cost);
  const margin = p.priceUsd > 0 ? Math.round(((p.priceUsd - apiCostUsd) / p.priceUsd) * 1000) / 1000 : -Infinity;
  return { ...p, apiCostUsd, margin: Number.isFinite(margin) ? margin : -1, perCutUsd: round(p.cuts ? p.priceUsd / p.cuts : 0) };
}

/** Plans derived from the measured/modelled cost. Every price and quota is env-configurable. */
export function plans(cost = costPerCut()): Plan[] {
  return [
    plan(
      {
        id: "free",
        name: "Free",
        priceUsd: 0,
        cuts: envNum("PLAN_FREE_CUTS", 3),
        period: "month",
        features: ["3 self-correcting cuts a month", "720p with watermark", "Up to 3 critique passes"],
      },
      cost,
    ),
    plan(
      {
        id: "creator",
        name: "Creator",
        priceUsd: envNum("PLAN_CREATOR_USD", 19),
        cuts: envNum("PLAN_CREATOR_CUTS", 40),
        period: "month",
        features: ["40 cuts a month", "1080p, no watermark", "Director's notes revisions", "Transcript-aware captions"],
      },
      cost,
    ),
    plan(
      {
        id: "studio",
        name: "Studio",
        priceUsd: envNum("PLAN_STUDIO_USD", 79),
        cuts: envNum("PLAN_STUDIO_CUTS", 200),
        period: "month",
        features: ["200 cuts a month", "4K export", "Director's notes revisions", "Priority queue", "Team seats"],
      },
      cost,
    ),
    plan(
      {
        id: "payg",
        name: "Pay as you go",
        priceUsd: envNum("PLAN_PAYG_USD", 0.99),
        cuts: 1,
        period: "cut",
        features: ["No subscription", "1080p, no watermark", "Credits never expire"],
      },
      cost,
    ),
  ];
}

export const PLANS = plans();

/** Human-readable caveats that ship with every pricing response. */
export function assumptions(cost = costPerCut()): string[] {
  return [
    `All API costs are estimates: token counts from each response times a rate table; the Gemini API does not report charges.`,
    `gemini-4-argon is priced at the published hackathon rate ($2/M input, $10/M output) through ${ARGON_INTRO_PRICE_ENDS}.`,
    "Other model rates are assumed and set via PRICE_*_PER_M; thinking tokens are counted as output.",
    `Modelled cost of one typical cut (2 clips, ~60s, 1 draft + 2 critiques): $${cost.toFixed(2)}; override with COST_PER_CUT_USD from measured runs.`,
    "Plan margins are gross margin at full quota use; they exclude compute for rendering and storage.",
    `Remaining credit is only visible at ${BILLING_URL}; the API returns HTTP 402 when it is exhausted.`,
  ];
}
