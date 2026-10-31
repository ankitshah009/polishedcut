import { NextResponse } from "next/server";

import { isRunning, retryRun } from "@/lib/jobs";
import { isRevising } from "@/lib/revise";
import { isInProgress, loadRun } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/runs/[id]/retry
 * Starts a finished or failed run again from scratch, in the background.
 * 202 -> the run (status "queued", iterations cleared, warnings kept plus "Started again");
 * follow /api/runs/[id]/events for progress.
 * 404 unknown run, 409 run still in progress, being revised, or already active.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = await loadRun(id);
  if (!run) return NextResponse.json({ error: "run not found" }, { status: 404 });

  if (isRunning(run.id) || isInProgress(run.status)) {
    return NextResponse.json({ error: "run is still in progress" }, { status: 409 });
  }
  if (isRevising(run.id)) return NextResponse.json({ error: "a revision is in progress" }, { status: 409 });

  retryRun(run);
  return NextResponse.json(run, { status: 202 });
}
