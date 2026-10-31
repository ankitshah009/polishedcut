"use client";

import { useEffect, useState } from "react";

import { DEFAULT_RATES, normalizeRates, type Rates } from "./format";
import type { Run } from "./schema";

const MAX_BACKOFF_MS = 15_000;

/* ---------- Pricing and usage (GET /api/pricing, GET /api/usage) ---------- */

export interface Plan {
  name: string;
  priceUsd: number | null;
  period: string;
  cutsPerMonth: number | null;
  features: string[];
  /** Set by the UI to pick the highlighted plan when the API does not say. */
  highlight?: boolean;
}

export interface Pricing {
  plans: Plan[];
  rates: Rates;
  assumptions: string[];
  billingUrl: string | null;
  /** False when /api/pricing was unreachable and the built-in plans are showing. */
  live: boolean;
}

export interface UsagePerRun {
  id: string;
  brief: string;
  usd: number;
  tokens: number;
  iterations: number;
}

export interface Usage {
  totalTokens: number;
  usd: number;
  perRun: UsagePerRun[];
  budget: { remaining: number | null; note: string; billingUrl: string | null };
}

export const AI_STUDIO_BILLING = "https://aistudio.google.com/usage";

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : typeof v === "string" && v ? [v] : []);

/** What the pricing page shows until the backend answers (or when it never does). */
export const FALLBACK_PLANS: Plan[] = [
  { name: "Free", priceUsd: 0, period: "month", cutsPerMonth: 3, features: ["3 cuts a month", "Up to 90 seconds each", "Watch and fix loop, up to 3 versions", "720p export"] },
  { name: "Creator", priceUsd: 19, period: "month", cutsPerMonth: 40, features: ["40 cuts a month", "Up to 3 minutes each", "Director's notes", "Title art and music beds", "1080p export"], highlight: true },
  { name: "Studio", priceUsd: 79, period: "month", cutsPerMonth: 250, features: ["250 cuts a month", "Up to 10 minutes each", "Priority rendering", "Brand presets and fonts", "4K export", "Shared workspace"] },
  { name: "Pay as you go", priceUsd: null, period: "cut", cutsPerMonth: null, features: ["Metered on tokens used", "Same editor, no cap", "Bring your own Gemini key", "Invoice monthly"] },
];

export function parsePricing(raw: unknown): Pricing {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const plans = Array.isArray(o.plans)
    ? o.plans.flatMap((p): Plan[] => {
        if (!p || typeof p !== "object") return [];
        const q = p as Record<string, unknown>;
        const period = str(q.period, "month");
        // Metered plans report cuts as "1 per cut"; that is not a monthly allowance.
        const cuts = period === "month" ? (numOrNull(q.cutsPerMonth) ?? numOrNull(q.cuts)) : null;
        return [{ name: str(q.name, "Plan"), priceUsd: numOrNull(q.priceUsd), period, cutsPerMonth: cuts, features: strList(q.features) }];
      })
    : [];
  const rates = { ...DEFAULT_RATES, ...normalizeRates(o.perModelRates) };
  return {
    plans: plans.length ? plans : FALLBACK_PLANS,
    rates,
    assumptions: strList(o.assumptions),
    billingUrl: str(o.billingUrl) || null,
    live: plans.length > 0,
  };
}

/** Accepts both the flat contract ({ totalTokens, usd, perRun }) and the nested one the server ships ({ totals, runs }). */
export function parseUsage(raw: unknown): Usage {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const b = (o.budget && typeof o.budget === "object" ? o.budget : {}) as Record<string, unknown>;
  const totals = (o.totals && typeof o.totals === "object" ? o.totals : {}) as Record<string, unknown>;
  const list = Array.isArray(o.perRun) ? o.perRun : Array.isArray(o.runs) ? o.runs : [];
  const perRun = list.flatMap((r): UsagePerRun[] => {
    if (!r || typeof r !== "object") return [];
    const q = r as Record<string, unknown>;
    return [{ id: str(q.id), brief: str(q.brief), usd: numOrNull(q.usd) ?? 0, tokens: numOrNull(q.tokens) ?? 0, iterations: numOrNull(q.iterations) ?? 0 }];
  });
  return {
    totalTokens: numOrNull(o.totalTokens) ?? numOrNull(totals.tokens) ?? perRun.reduce((s, r) => s + r.tokens, 0),
    usd: numOrNull(o.usd) ?? numOrNull(totals.usd) ?? perRun.reduce((s, r) => s + r.usd, 0),
    perRun,
    budget: { remaining: numOrNull(b.remaining), note: str(b.note), billingUrl: str(b.billingUrl) || null },
  };
}

const FALLBACK_PRICING: Pricing = { plans: FALLBACK_PLANS, rates: DEFAULT_RATES, assumptions: [], billingUrl: null, live: false };

let pricingPromise: Promise<Pricing> | null = null;

/** Fetches /api/pricing once per page load; every caller shares the result. Falls back to built-in rates. */
export function loadPricing(): Promise<Pricing> {
  pricingPromise ??= fetch("/api/pricing", { cache: "no-store" })
    .then(async (r) => (r.ok ? parsePricing(await r.json()) : FALLBACK_PRICING))
    .catch(() => FALLBACK_PRICING)
    .then((p) => {
      // Let a later visit retry a failed fetch.
      if (!p.live) pricingPromise = null;
      return p;
    });
  return pricingPromise;
}

/** Plans and per-model rates. `null` until the first answer arrives. */
export function usePricing(): Pricing | null {
  const [pricing, setPricing] = useState<Pricing | null>(null);
  useEffect(() => {
    let alive = true;
    void loadPricing().then((p) => alive && setPricing(p));
    return () => {
      alive = false;
    };
  }, []);
  return pricing;
}

/**
 * Account-wide usage. `undefined` while loading, `null` when the endpoint is unavailable.
 * Re-fetched whenever `refreshKey` changes (the dashboard passes its run count).
 */
export function useUsage(refreshKey: unknown = 0): Usage | null | undefined {
  const [usage, setUsage] = useState<Usage | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    fetch("/api/usage", { cache: "no-store" })
      .then(async (r) => (r.ok ? parseUsage(await r.json()) : null))
      .catch(() => null)
      .then((u) => alive && setUsage(u));
    return () => {
      alive = false;
    };
  }, [refreshKey]);
  return usage;
}

/* ---------- Retry (POST /api/runs/[id]/retry) ---------- */

export type RetryResult = { ok: true; run: Run } | { ok: false; message: string };

/** Asks the server to start a stopped cut again. 202 carries the re-queued run. */
export async function retryRun(id: string): Promise<RetryResult> {
  try {
    const res = await fetch(`/api/runs/${encodeURIComponent(id)}/retry`, { method: "POST" });
    if (res.status === 202 || res.ok) return { ok: true, run: (await res.json()) as Run };
    if (res.status === 404) return { ok: false, message: "Starting again isn’t available on this server yet. Start a new cut from the dashboard." };
    if (res.status === 409) return { ok: false, message: "Argon is still busy with this cut. Try again when it finishes." };
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return { ok: false, message: body?.error ?? `Couldn’t start again (${res.status}).` };
  } catch {
    return { ok: false, message: "Couldn’t reach the server. Check your connection and try again." };
  }
}

function isFinished(run: Run | null): boolean {
  return run?.status === "done" || run?.status === "error";
}

/**
 * Loads a run once, then keeps it live over Server-Sent Events until the run ends.
 * Mount it under a key of the run id so switching runs starts from fresh state.
 */
export function useRun(id: string): { run: Run | null; error: string | null } {
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let finished = false;
    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const stop = () => {
      finished = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      es?.close();
      es = null;
    };

    const accept = (data: Run) => {
      if (cancelled) return;
      setRun(data);
      if (isFinished(data)) stop();
    };

    fetch(`/api/runs/${encodeURIComponent(id)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(r.status === 404 ? "This cut does not exist." : "Could not load this cut.");
        return (await r.json()) as Run;
      })
      .then(accept)
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Could not load this cut.");
        if (err instanceof Error && err.message === "This cut does not exist.") stop();
      });

    const connect = () => {
      if (cancelled || finished) return;
      const source = new EventSource(`/api/runs/${encodeURIComponent(id)}/events`);
      es = source;
      source.onopen = () => {
        attempt = 0;
      };
      source.onmessage = (e) => {
        try {
          accept(JSON.parse(e.data) as Run);
        } catch {
          // ignore a malformed frame; the next one replaces it
        }
      };
      source.addEventListener("end", stop);
      source.onerror = () => {
        source.close();
        if (es === source) es = null;
        if (cancelled || finished) return;
        const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt) * (0.75 + Math.random() * 0.5);
        attempt++;
        retryTimer = setTimeout(connect, delay);
      };
    };
    connect();

    return () => {
      cancelled = true;
      stop();
    };
  }, [id]);

  return { run, error };
}
