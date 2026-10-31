import { NextResponse } from "next/server";

import { callbacks } from "@/lib/frame-analyst";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ job: string; token: string }> };

/**
 * Where the Nebula Frame Analyst posts a clip's analysis. The job id and token were minted by
 * `analyzeClip` for exactly one pending request (lib/frame-analyst.ts `callbacks`); anything else is
 * 404/403. The body is handed to the waiting analysis as-is; parsing and validation happen there.
 */
export async function POST(request: Request, { params }: Params) {
  const { job, token } = await params;
  const text = await request.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Some agents answer with prose around a JSON block; parseAnalysis digs the JSON out of a string.
  }
  const outcome = callbacks.resolve(job, token, body);
  if (outcome === "unknown") return NextResponse.json({ error: "no frame analysis is waiting for this callback" }, { status: 404 });
  if (outcome === "forbidden") return NextResponse.json({ error: "callback token does not match" }, { status: 403 });
  return NextResponse.json({ ok: true });
}

/** A browser or a curious agent hitting the URL: say what it is for without leaking whether a job is pending. */
export async function GET() {
  return NextResponse.json({ error: "POST the clip's analysis JSON to this URL" }, { status: 405 });
}
