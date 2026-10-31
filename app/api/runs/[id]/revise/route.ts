import { NextResponse } from "next/server";
import { z } from "zod";

import { NOTE_MAX_CHARS } from "@/lib/config";
import { reviseBlocker, startRevision } from "@/lib/revise";
import { loadRun } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({ note: z.string().trim().min(1).max(NOTE_MAX_CHARS) });

/**
 * POST /api/runs/[id]/revise  { note: string }
 * Applies a director's note to the run's latest cut in the background.
 * 202 -> the run (status already "critiquing"); follow /api/runs/[id]/events for progress.
 * 404 unknown run, 400 bad body or note, 409 run still in progress / revision already active.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = await loadRun(id);
  if (!run) return NextResponse.json({ error: "run not found" }, { status: 404 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "expected a JSON body" }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: `note must be 1 to ${NOTE_MAX_CHARS} characters` }, { status: 400 });
  }

  const blocker = reviseBlocker(run);
  if (blocker) return NextResponse.json({ error: blocker }, { status: 409 });

  startRevision(run, parsed.data.note);
  return NextResponse.json(run, { status: 202 });
}
