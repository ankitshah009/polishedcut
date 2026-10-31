import { NextResponse, after } from "next/server";

import { PHOTON_ENABLED, PHOTON_MODE, PHOTON_PROJECT_ID, PHOTON_WEBHOOK_SECRET } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET: is the chat front door on, and how. Handy for the demo checklist; reveals no secrets. */
export async function GET() {
  return NextResponse.json({
    system: "photon-beta",
    enabled: PHOTON_ENABLED,
    mode: PHOTON_MODE,
    projectId: PHOTON_PROJECT_ID ? `${PHOTON_PROJECT_ID.slice(0, 12)}…` : null,
    webhookSecret: PHOTON_WEBHOOK_SECRET !== "",
  });
}

/**
 * POST: one Photon webhook delivery (a public event object, signed with the destination's signing
 * secret). Register https://<host>/api/photon/webhook as a webhook destination on the Beta project
 * and put the returned signing secret in PHOTON_WEBHOOK_SECRET. 503 when Photon is not configured;
 * 401/400 for unsigned, stale or malformed deliveries. The event is acknowledged immediately and
 * handled after the response so Photon never waits on a cut.
 */
export async function POST(request: Request) {
  if (!PHOTON_ENABLED) return NextResponse.json({ error: "Photon is not configured" }, { status: 503 });
  const { readWebhook, handlePhotonEvent } = await import("@/lib/photon");
  const read = await readWebhook(request);
  if ("response" in read) return read.response;
  after(async () => {
    try {
      await handlePhotonEvent(read.event);
    } catch (err) {
      console.error(`[photon] webhook event ${read.event.type} ${read.event.id} failed:`, err);
    }
  });
  return NextResponse.json({ ok: true, id: read.event.id }, { status: 202 });
}
