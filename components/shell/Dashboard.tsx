"use client";

import { useSearchParams } from "next/navigation";
import { useMemo, useState, useSyncExternalStore } from "react";

import { PastRuns } from "@/components/PastRuns";
import { UploadPanel } from "@/components/UploadPanel";
import { estimateCost, runUsage } from "@/lib/format";
import type { Run } from "@/lib/schema";
import { usePricing, useUsage } from "@/lib/use-run";

import { EmptyState } from "./EmptyState";
import { Featured } from "./Featured";
import { QuickStart } from "./QuickStart";
import { useRuns } from "./runs";
import { Spend, summarizeSpend } from "./Spend";
import { Theater } from "./Theater";

// Optional: NEXT_PUBLIC_USER_NAME="Sam" turns "Good evening" into "Good evening, Sam".
const USER_NAME = (process.env.NEXT_PUBLIC_USER_NAME ?? "").trim();

function greeting(hour: number): string {
  if (hour < 5) return "Good evening";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

const noop = () => () => {};
const now = () => greeting(new Date().getHours());

export function Dashboard() {
  // Same machine on server and client, so the snapshots agree; the h1 tolerates a timezone mismatch.
  const hello = useSyncExternalStore(noop, now, now);
  const runs = useRuns();
  const pricing = usePricing();
  const usage = useUsage(runs?.length ?? 0);

  // Theater mode: which cut is open in the lightbox. `/?theater=<id>` deep-links it (and lets screenshots open it).
  const params = useSearchParams();
  const [theaterId, setTheaterId] = useState<string | null>(() => params.get("theater"));
  const theaterRun = useMemo(() => (theaterId ? (runs?.find((r) => r.id === theaterId) ?? null) : null), [runs, theaterId]);
  const openTheater = (run: Run) => {
    setTheaterId(run.id);
    const url = new URL(window.location.href);
    url.searchParams.set("theater", run.id);
    window.history.replaceState(null, "", url);
  };
  const closeTheater = () => {
    setTheaterId(null);
    const url = new URL(window.location.href);
    url.searchParams.delete("theater");
    window.history.replaceState(null, "", url);
  };

  // Per-run cost: the server's number when it has one, else a client-side estimate from run.usage.
  const costOf = useMemo(() => {
    const server = new Map((usage?.perRun ?? []).map((r) => [r.id, r.usd]));
    return (run: Run): number | null => {
      const s = server.get(run.id);
      if (s != null && s > 0) return s;
      const est = estimateCost(runUsage(run), pricing?.rates);
      return est.tokens > 0 ? est.usd : null;
    };
  }, [usage, pricing]);

  const spend = useMemo(() => {
    const list = runs ?? [];
    const fallback = list.reduce(
      (acc, r) => {
        const est = estimateCost(runUsage(r), pricing?.rates);
        return { usd: acc.usd + est.usd, tokens: acc.tokens + est.tokens, cuts: acc.cuts + 1 };
      },
      { usd: 0, tokens: 0, cuts: 0 },
    );
    return runs === null && usage === undefined ? null : summarizeSpend(usage, fallback);
  }, [runs, usage, pricing]);

  const firstRun = runs !== null && runs.length === 0;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-10 lg:py-10">
        <header className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight" suppressHydrationWarning>
              {USER_NAME ? `${hello}, ${USER_NAME}` : hello}
            </h1>
            <p className="mt-1 text-muted-foreground">{firstRun ? "Let’s make your first cut." : "What are we cutting today?"}</p>
          </div>
          {!firstRun && <Spend summary={spend} />}
        </header>

        {firstRun ? (
          <>
            <EmptyState />
            <div className="mt-8 grid gap-6 lg:grid-cols-5">
              <div className="hidden lg:col-span-3 lg:block" aria-hidden />
              <UploadPanel />
            </div>
          </>
        ) : (
          <>
            <QuickStart runs={runs} />

            <div className="mt-8 grid gap-6 lg:grid-cols-5">
              <Featured runs={runs} onOpen={openTheater} />
              <UploadPanel />
            </div>

            <PastRuns runs={runs} costOf={costOf} onOpen={openTheater} />
          </>
        )}
      </div>

      <Theater run={theaterRun} onClose={closeTheater} />
    </div>
  );
}
