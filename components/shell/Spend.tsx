"use client";

import { ArrowUpRight, Receipt } from "lucide-react";
import Link from "next/link";

import { formatTokens, formatUsd } from "@/lib/format";
import { AI_STUDIO_BILLING, type Usage } from "@/lib/use-run";

export interface SpendSummary {
  usd: number;
  tokens: number;
  cuts: number;
  /** True when the numbers came from /api/usage rather than a client-side estimate. */
  live: boolean;
  billingUrl: string;
  note: string;
}

/** Folds the account usage (or, when the endpoint is missing, a client-side estimate) into the card's numbers. */
export function summarizeSpend(usage: Usage | null | undefined, fallback: { usd: number; tokens: number; cuts: number }): SpendSummary | null {
  if (usage === undefined) return null;
  if (usage) {
    return {
      usd: usage.usd,
      tokens: usage.totalTokens,
      cuts: usage.perRun.length || fallback.cuts,
      live: true,
      billingUrl: usage.budget.billingUrl ?? AI_STUDIO_BILLING,
      note: usage.budget.note,
    };
  }
  return { ...fallback, live: false, billingUrl: AI_STUDIO_BILLING, note: "" };
}

/** Compact estimated-spend card for the dashboard header. */
export function Spend({ summary }: { summary: SpendSummary | null }) {
  const empty = summary && summary.tokens === 0 && summary.usd === 0;
  return (
    <section aria-label="Spend" className="flex w-full flex-col justify-between gap-3 rounded-2xl border bg-card p-4 shadow-tile sm:w-auto sm:min-w-72">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span className="grid size-7 place-items-center rounded-lg bg-accent text-accent-foreground">
            <Receipt className="size-3.5" />
          </span>
          Spend
          <span className="text-xs font-normal text-muted-foreground">{summary?.live ? "estimated" : "estimated locally"}</span>
        </div>
        <Link href="/pricing" className="text-xs text-muted-foreground hover:text-foreground">
          Rates
        </Link>
      </div>

      {summary === null ? (
        <div className="space-y-2" aria-hidden>
          <div className="h-7 w-24 animate-pulse rounded bg-muted" />
          <div className="h-3 w-40 animate-pulse rounded bg-muted" />
        </div>
      ) : empty ? (
        <p className="text-sm text-muted-foreground">No tokens recorded yet. Your first cut will show up here.</p>
      ) : (
        <dl className="flex items-end gap-5">
          <div>
            <dt className="text-xs text-muted-foreground">Total</dt>
            <dd className="font-tc text-2xl font-semibold tracking-tight">≈ {formatUsd(summary.usd)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Tokens</dt>
            <dd className="font-tc text-sm">{formatTokens(summary.tokens)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Cuts</dt>
            <dd className="font-tc text-sm">{summary.cuts}</dd>
          </div>
        </dl>
      )}

      <a
        href={summary?.billingUrl ?? AI_STUDIO_BILLING}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 text-xs font-medium text-accent-foreground hover:underline"
        title={summary?.note || "PolishedCut does not see your Google balance; AI Studio does."}
      >
        Check balance in AI Studio <ArrowUpRight className="size-3" />
      </a>
    </section>
  );
}
