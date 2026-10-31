import { NextResponse } from "next/server";

import { BILLING_URL, estimateCost } from "@/lib/pricing";
import { listRuns } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Token and estimated-dollar totals across every run on disk. */
export async function GET() {
  const runs = await listRuns();
  const all = runs.flatMap((r) => r.usage ?? []);
  const total = estimateCost(all);

  const perRun = runs.map((r) => {
    const cost = estimateCost(r.usage);
    return {
      id: r.id,
      brief: r.brief,
      status: r.status,
      createdAt: r.createdAt,
      usd: cost.usd,
      tokens: cost.totalTokens,
      inputTokens: (r.usage ?? []).reduce((n, u) => n + u.inputTokens, 0),
      outputTokens: (r.usage ?? []).reduce((n, u) => n + u.outputTokens, 0),
      calls: (r.usage ?? []).length,
      iterations: r.iterations.length,
      ms: (r.usage ?? []).reduce((n, u) => n + u.ms, 0),
    };
  });

  const tracked = perRun.filter((r) => r.calls > 0);
  return NextResponse.json({
    totals: {
      runs: runs.length,
      runsWithUsage: tracked.length,
      tokens: total.totalTokens,
      inputTokens: all.reduce((n, u) => n + u.inputTokens, 0),
      outputTokens: all.reduce((n, u) => n + u.outputTokens, 0),
      cachedTokens: all.reduce((n, u) => n + (u.cachedTokens ?? 0), 0),
      usd: total.usd,
      avgUsdPerRun: tracked.length ? Math.round((total.usd / tracked.length) * 10_000) / 10_000 : null,
    },
    byModel: total.byModel,
    runs: perRun,
    estimated: true,
    budget: {
      remaining: null,
      note: "The Gemini API does not expose balance; check AI Studio billing",
      billingUrl: BILLING_URL,
    },
  });
}
