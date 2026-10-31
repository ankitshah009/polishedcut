"use client";

import { ArrowUpRight, Check, Sparkles } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";

import { estimateCost, runUsage } from "@/lib/format";
import { AI_STUDIO_BILLING, usePricing, useUsage, type Plan } from "@/lib/use-run";
import { cn } from "@/lib/utils";

import { useRuns } from "../shell/runs";
import { Faq } from "./Faq";
import { CostPanel, type ExampleCut } from "./CostPanel";

const PLAN_BLURB: Record<string, string> = {
  free: "Try the loop on your own footage.",
  creator: "For people who ship a few cuts a week.",
  studio: "For teams cutting every day.",
  "pay as you go": "Metered. You only pay for the tokens a cut uses.",
};

function blurb(plan: Plan): string {
  return PLAN_BLURB[plan.name.toLowerCase()] ?? "";
}

function price(plan: Plan): { big: string; small: string } {
  if (plan.priceUsd == null) return { big: "Metered", small: `per ${plan.period}` };
  if (plan.priceUsd === 0) return { big: "$0", small: "forever" };
  return { big: `$${plan.priceUsd % 1 === 0 ? plan.priceUsd : plan.priceUsd.toFixed(2)}`, small: `per ${plan.period}` };
}

function cta(plan: Plan): string {
  if (plan.priceUsd === 0) return "Start cutting";
  if (plan.period !== "month") return "Buy credits";
  return `Choose ${plan.name}`;
}

export function Pricing() {
  const pricing = usePricing();
  const usage = useUsage();
  const runs = useRuns();

  const plans = pricing?.plans ?? null;
  const highlight = useMemo(() => {
    if (!plans) return -1;
    const flagged = plans.findIndex((p) => p.highlight);
    if (flagged >= 0) return flagged;
    // Second paid tier when the API does not say; the usual "most people pick this one".
    const paid = plans.map((p, i) => ({ p, i })).filter(({ p }) => p.priceUsd != null && p.priceUsd > 0);
    return paid[0]?.i ?? -1;
  }, [plans]);

  // The example cut: the server's number for the latest run, else a client-side estimate from run.usage.
  const example = useMemo<ExampleCut | null | undefined>(() => {
    if (usage === undefined && runs === null) return undefined;
    const fromServer = usage?.perRun[0];
    if (fromServer && fromServer.tokens > 0) {
      return { id: fromServer.id, brief: fromServer.brief, usd: fromServer.usd, tokens: fromServer.tokens, iterations: fromServer.iterations, byModel: null };
    }
    const run = (runs ?? []).find((r) => runUsage(r).length > 0);
    if (!run) return null;
    const est = estimateCost(runUsage(run), pricing?.rates);
    if (est.tokens === 0) return null;
    return { id: run.id, brief: run.brief, usd: est.usd, tokens: est.tokens, iterations: run.iterations.length, byModel: est.byModel };
  }, [usage, runs, pricing]);

  const billingUrl = pricing?.billingUrl ?? usage?.budget.billingUrl ?? AI_STUDIO_BILLING;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-6xl px-4 pt-10 pb-24 sm:px-6 lg:px-10">
        {/* Hero */}
        <header className="max-w-[60ch]">
          <p className="inline-flex items-center gap-1.5 rounded-full bg-accent px-3 py-1 text-xs font-medium text-accent-foreground">
            <Sparkles className="size-3.5" /> Pricing
          </p>
          <h1 className="mt-4 font-serif text-[clamp(38px,5.5vw,64px)] leading-[1.02] tracking-tight">Pay for cuts, not seats</h1>
          <p className="mt-4 text-[17px] leading-relaxed text-muted-foreground">
            Argon drafts, renders, watches and fixes every cut until it passes your brief. You pay a flat monthly price for a
            number of finished cuts, or meter the tokens directly. The maths behind both is below, in full.
          </p>
        </header>

        {/* Plans */}
        <section aria-label="Plans" className="mt-12">
          {plans ? (
            <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              {plans.map((plan, i) => {
                const hot = i === highlight;
                const { big, small } = price(plan);
                return (
                  <li
                    key={plan.name}
                    className={cn(
                      "relative flex flex-col rounded-2xl border bg-card p-6 shadow-tile",
                      hot && "border-amber/60 shadow-lift ring-1 ring-amber/40",
                    )}
                  >
                    {hot && (
                      <span className="absolute -top-3 left-6 rounded-full bg-primary px-2.5 py-0.5 text-xs font-medium text-primary-foreground">
                        Most popular
                      </span>
                    )}
                    <h2 className="text-lg font-semibold tracking-tight">{plan.name}</h2>
                    <p className="mt-1 min-h-10 text-sm text-muted-foreground">{blurb(plan)}</p>
                    <p className="mt-4 flex items-baseline gap-1.5">
                      <span className="font-tc text-4xl font-semibold tracking-tight">{big}</span>
                      <span className="text-sm text-muted-foreground">{small}</span>
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {plan.cutsPerMonth != null ? `${plan.cutsPerMonth} cuts a month` : "No monthly cap, no subscription"}
                    </p>
                    <ul className="mt-5 flex flex-1 flex-col gap-2 text-sm">
                      {plan.features.map((f) => (
                        <li key={f} className="flex gap-2">
                          <Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
                          <span>{f}</span>
                        </li>
                      ))}
                    </ul>
                    <Link
                      href="/#new"
                      className={cn(
                        "mt-6 inline-flex h-10 items-center justify-center rounded-lg text-sm font-medium transition-colors",
                        hot ? "bg-primary text-primary-foreground shadow-tile hover:brightness-105" : "border bg-panel-2 hover:bg-accent",
                      )}
                    >
                      {cta(plan)}
                    </Link>
                  </li>
                );
              })}
            </ul>
          ) : (
            <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-4" aria-hidden>
              {[0, 1, 2, 3].map((i) => (
                <li key={i} className="h-96 animate-pulse rounded-2xl border bg-card" />
              ))}
            </ul>
          )}
          {pricing && !pricing.live && (
            <p className="mt-3 text-xs text-muted-foreground">Showing the built-in plans; live pricing was not reachable.</p>
          )}
        </section>

        {/* Transparency */}
        <CostPanel rates={pricing?.rates ?? null} assumptions={pricing?.assumptions ?? []} example={example} />

        {/* FAQ */}
        <Faq />

        <footer className="mt-16 flex flex-wrap items-center justify-between gap-3 border-t pt-6 text-sm text-muted-foreground">
          <span>PolishedTake bills in USD. Model rates are Google’s list prices and can change.</span>
          <a href={billingUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-foreground hover:underline">
            Check balance in AI Studio <ArrowUpRight className="size-3.5" />
          </a>
        </footer>
      </div>
    </div>
  );
}
