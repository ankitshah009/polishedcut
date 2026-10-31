import { NextResponse } from "next/server";

import { SPECTRUM_ENABLED, SPECTRUM_MODE, SPECTRUM_PLATFORMS } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET: is the chat front door on, and how. Handy for the demo checklist; reveals no secrets. */
export async function GET() {
  return NextResponse.json({ enabled: SPECTRUM_ENABLED, mode: SPECTRUM_MODE, platforms: SPECTRUM_PLATFORMS });
}

/**
 * POST: a native Spectrum Cloud webhook delivery (HMAC in X-Spectrum-Signature, verified by the SDK
 * against SPECTRUM_WEBHOOK_SECRET). Register this URL in the Spectrum dashboard. 503 when Spectrum
 * is not configured; the SDK answers 400/401 for unsigned or stale deliveries.
 */
export async function POST(request: Request) {
  if (!SPECTRUM_ENABLED) return NextResponse.json({ error: "Spectrum is not configured" }, { status: 503 });
  const { handleSpectrumWebhook } = await import("@/lib/spectrum");
  try {
    return await handleSpectrumWebhook(request);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: detail }, { status: 500 });
  }
}
