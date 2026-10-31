import { NextResponse } from "next/server";

import { BILLING_URL, assumptions, costPerCut, estimateCost, perModelRates, plans } from "@/lib/pricing";
import { listRuns } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Sellable plans plus the rate table and caveats behind them. */
export async function GET() {
  // When runs carry measured usage, report the average so the modelled cost can be checked against reality.
  let measured: { runs: number; avgCostPerCutUsd: number } | null = null;
  try {
    const priced = (await listRuns()).filter((r) => r.status === "done" && (r.usage?.length ?? 0) > 0);
    if (priced.length > 0) {
      const total = priced.reduce((sum, r) => sum + estimateCost(r.usage).usd, 0);
      measured = { runs: priced.length, avgCostPerCutUsd: Math.round((total / priced.length) * 10_000) / 10_000 };
    }
  } catch {
    measured = null;
  }

  const cost = costPerCut();
  return NextResponse.json({
    plans: plans(cost),
    perModelRates: perModelRates(),
    costPerCutUsd: cost,
    measured,
    assumptions: assumptions(cost),
    estimated: true,
    billingUrl: BILLING_URL,
  });
}
