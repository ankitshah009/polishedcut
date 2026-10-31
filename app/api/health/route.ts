import { NextResponse } from "next/server";

import { GENAI_BASE_URL, MODELS, MODEL_PROVIDER, PHOTON_ENABLED, PHOTON_MODE } from "@/lib/config";
import { describeEditor } from "@/lib/editor";
import { geminiKeys } from "@/lib/gemini";
import { localTranscriptionAvailable } from "@/lib/local-editor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET: is the server up, which editor cuts, and is the chat front door on. No secrets. */
export async function GET() {
  const local = MODEL_PROVIDER === "local";
  return NextResponse.json({
    ok: true,
    service: "polishedcut",
    time: new Date().toISOString(),
    editor: {
      provider: MODEL_PROVIDER,
      description: describeEditor(),
      ...(local
        ? { transcription: (await localTranscriptionAvailable()) ? "whisper.cpp" : "unavailable (silence/scene detection only)" }
        : { baseUrl: GENAI_BASE_URL || "https://generativelanguage.googleapis.com", main: MODELS.argon, fallback: MODELS.argonFallback || null, keyConfigured: geminiKeys().length > 0 }),
    },
    photon: { enabled: PHOTON_ENABLED, mode: PHOTON_MODE },
  });
}
