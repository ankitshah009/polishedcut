import { NextResponse } from "next/server";

import { callbacks, holdsAnalysis, unwrapResult } from "@/lib/frame-analyst";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ job: string; token: string }> };

/** A callback body larger than this is not an analysis; it is refused before it is parsed. */
export const CALLBACK_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Where the Nebula Frame Analyst posts a clip's analysis. The job id and token were minted by
 * `analyzeClip` for exactly one pending request (lib/frame-analyst.ts `callbacks`); anything else is
 * 404/403. The body must carry an analysis (words / sound / shots, possibly wrapped or inside a prose
 * reply with a JSON block); anything else is a 400 and the analysis keeps waiting, so a stray or
 * malformed delivery never ends a run with "no usable analysis". Accepted deliveries answer { ok: true }.
 */
export async function POST(request: Request, { params }: Params) {
  const { job, token } = await params;
  // Identity first, so a probe with a made-up job learns nothing about the body rules.
  const who = callbacks.check(job, token);
  if (who === "unknown") return NextResponse.json({ error: "no frame analysis is waiting for this callback" }, { status: 404 });
  if (who === "forbidden") return NextResponse.json({ error: "callback token does not match" }, { status: 403 });

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > CALLBACK_MAX_BYTES) return NextResponse.json({ error: `callback body is too large (max ${CALLBACK_MAX_BYTES} bytes)` }, { status: 400 });
  let text: string;
  try {
    text = await request.text();
  } catch {
    return NextResponse.json({ error: "callback body could not be read" }, { status: 400 });
  }
  if (text.length > CALLBACK_MAX_BYTES) return NextResponse.json({ error: `callback body is too large (max ${CALLBACK_MAX_BYTES} bytes)` }, { status: 400 });
  if (!text.trim()) return NextResponse.json({ error: "callback body is empty; POST the clip's analysis JSON" }, { status: 400 });

  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Some agents answer with prose around a JSON block; unwrapResult digs the JSON out of a string.
  }
  const inner = unwrapResult(body);
  if (!inner || typeof inner !== "object" || Array.isArray(inner)) {
    return NextResponse.json({ error: "callback body is not a JSON object (or text containing one)" }, { status: 400 });
  }
  if (!holdsAnalysis(inner)) {
    return NextResponse.json({ error: "callback body holds no analysis: expected words, sound and/or shots" }, { status: 400 });
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
