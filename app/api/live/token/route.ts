import { GoogleGenAI } from "@google/genai";
import { NextResponse } from "next/server";
import { z } from "zod";

import { CREDITS_EXHAUSTED_MESSAGE, geminiKeys } from "@/lib/gemini";
import { LIVE_MODEL, TOKEN_TTL_MS, TOKEN_USES, buildSystemInstruction, liveConnectConfig, type LiveTokenResponse } from "@/lib/live";
import { loadRun } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({ runId: z.string().trim().min(1) });

function statusOf(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const { status, statusCode } = err as { status?: unknown; statusCode?: unknown };
  for (const v of [status, statusCode]) if (typeof v === "number" && v >= 100 && v < 600) return v;
  return undefined;
}

/**
 * POST /api/live/token  { runId }
 * Mints a short-lived ephemeral Live API token locked to this run's voice-assistant config, so the
 * browser can open a Gemini Live session without ever seeing the API key.
 * 200 -> { token, expiresAt, model, systemInstruction }
 * 400 bad body, 404 unknown run, 402 credits exhausted, 503 no key configured, 502 token service failed.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "expected a JSON body with runId" }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "runId is required" }, { status: 400 });

  const run = await loadRun(parsed.data.runId);
  if (!run) return NextResponse.json({ error: "run not found" }, { status: 404 });

  const apiKey = geminiKeys()[0]?.[1];
  if (!apiKey) return NextResponse.json({ error: "GEMINI_API_KEY is not set on the server" }, { status: 503 });

  const systemInstruction = buildSystemInstruction(run);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();
  // Ephemeral tokens are a v1alpha feature of the Gemini Developer API.
  const ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: "v1alpha" } });
  try {
    const token = await ai.authTokens.create({
      config: {
        uses: TOKEN_USES,
        expireTime: expiresAt,
        newSessionExpireTime: new Date(Date.now() + 60_000).toISOString(),
        // Lock the model and the session config into the token: a leaked token can only ever
        // open this assistant, for this run, with this system instruction and tool. No
        // `lockAdditionalFields`: the server then locks every field in the setup. (An explicit
        // field mask derived from `tools` is rejected: "field_mask is invalid for BidiGenerateContentSetup".)
        liveConnectConstraints: { model: LIVE_MODEL, config: liveConnectConfig(systemInstruction) },
      },
    });
    if (!token.name) throw new Error("token service returned no token name");
    const out: LiveTokenResponse = { token: token.name, expiresAt, model: LIVE_MODEL, systemInstruction };
    return NextResponse.json(out, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    const status = statusOf(err);
    if (status === 402) return NextResponse.json({ error: CREDITS_EXHAUSTED_MESSAGE }, { status: 402 });
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[live] token for run ${run.id} failed:`, message);
    return NextResponse.json({ error: `could not issue a Live token: ${message}` }, { status: 502 });
  }
}
