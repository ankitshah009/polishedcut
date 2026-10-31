/**
 * Photon Spectrum adapter, SDK half. Boots one Spectrum app (spectrum-ts) with the providers named in
 * SPECTRUM_PLATFORMS and feeds every inbound message to lib/spectrum-handler.ts.
 *
 * Two ways in, both supported:
 *   - stream  (default): `for await ... of app.messages` over Spectrum's long-lived connection. Needs
 *     no public URL, so the demo laptop running `next dev` is enough. Started from instrumentation.ts.
 *   - webhook: Spectrum Cloud POSTs each message to /api/spectrum/webhook; the route verifies the
 *     HMAC via `app.webhook`. For a deployment with a public URL. Needs SPECTRUM_WEBHOOK_SECRET.
 *
 * The SDK is imported lazily so a build or test run without credentials never loads gRPC.
 */
import {
  SPECTRUM_ENABLED,
  SPECTRUM_MODE,
  SPECTRUM_PLATFORMS,
  SPECTRUM_PROJECT_ID,
  SPECTRUM_PROJECT_SECRET,
  SPECTRUM_WEBHOOK_SECRET,
} from "./config";
import { handleInbound, type Builders } from "./spectrum-handler";

type SpectrumModule = typeof import("spectrum-ts");
type SpectrumApp = Awaited<ReturnType<SpectrumModule["Spectrum"]>>;

// One app per process, surviving dev hot reloads.
const g = globalThis as typeof globalThis & {
  __spectrumApp?: Promise<SpectrumApp> | null;
  __spectrumStreaming?: boolean;
};
g.__spectrumApp ??= null;
g.__spectrumStreaming ??= false;

export function spectrumEnabled(): boolean {
  return SPECTRUM_ENABLED;
}

async function providersFor(names: string[]) {
  const providers: import("spectrum-ts").PlatformProviderConfig[] = [];
  for (const name of names) {
    switch (name) {
      case "imessage": {
        const { imessage } = await import("spectrum-ts/providers/imessage");
        providers.push(imessage.config());
        break;
      }
      case "telegram": {
        const botToken = process.env.SPECTRUM_TELEGRAM_BOT_TOKEN?.trim();
        if (!botToken) {
          console.warn("[spectrum] telegram listed in SPECTRUM_PLATFORMS but SPECTRUM_TELEGRAM_BOT_TOKEN is unset; skipping");
          break;
        }
        const { telegram } = await import("spectrum-ts/providers/telegram");
        providers.push(telegram.config({ botToken }));
        break;
      }
      case "whatsapp":
      case "whatsapp-business":
      case "whatsapp_business": {
        const accessToken = process.env.SPECTRUM_WHATSAPP_BUSINESS_ACCESS_TOKEN?.trim();
        const phoneNumberId = process.env.SPECTRUM_WHATSAPP_BUSINESS_PHONE_NUMBER_ID?.trim();
        if (!accessToken || !phoneNumberId) {
          console.warn("[spectrum] whatsapp-business needs SPECTRUM_WHATSAPP_BUSINESS_ACCESS_TOKEN and _PHONE_NUMBER_ID; skipping");
          break;
        }
        const { whatsappBusiness } = await import("spectrum-ts/providers/whatsapp-business");
        providers.push(whatsappBusiness.config({ accessToken, phoneNumberId, appSecret: process.env.SPECTRUM_WHATSAPP_BUSINESS_APP_SECRET?.trim() || undefined }));
        break;
      }
      case "slack": {
        const raw = process.env.SPECTRUM_SLACK_TOKENS?.trim();
        if (!raw) {
          console.warn("[spectrum] slack needs SPECTRUM_SLACK_TOKENS (JSON { teamId: botToken }); skipping");
          break;
        }
        const { slack } = await import("spectrum-ts/providers/slack");
        providers.push(slack.config({ tokens: JSON.parse(raw) as Record<string, string> }));
        break;
      }
      case "terminal": {
        const { terminal } = await import("spectrum-ts/providers/terminal");
        providers.push(terminal.config());
        break;
      }
      default:
        console.warn(`[spectrum] unknown platform "${name}" in SPECTRUM_PLATFORMS; skipping`);
    }
  }
  return providers;
}

/** The shared Spectrum app, created on first use. Throws when credentials are missing. */
export function spectrumApp(): Promise<SpectrumApp> {
  if (!SPECTRUM_ENABLED) return Promise.reject(new Error("Spectrum is not configured (SPECTRUM_PROJECT_ID / SPECTRUM_PROJECT_SECRET)"));
  g.__spectrumApp ??= (async () => {
    const { Spectrum } = await import("spectrum-ts");
    const providers = await providersFor(SPECTRUM_PLATFORMS);
    if (providers.length === 0) throw new Error("no Spectrum providers configured");
    const app = await Spectrum({
      projectId: SPECTRUM_PROJECT_ID,
      projectSecret: SPECTRUM_PROJECT_SECRET,
      providers,
      webhookSecret: SPECTRUM_WEBHOOK_SECRET || undefined,
      options: { flattenGroups: true },
    });
    return app as SpectrumApp;
  })().catch((err: unknown) => {
    g.__spectrumApp = null; // let the next call retry
    throw err;
  });
  return g.__spectrumApp;
}

async function builders(): Promise<Builders> {
  const { attachment } = await import("spectrum-ts");
  return { attachment };
}

/**
 * Stream mode: open the connection and dispatch every inbound message. Returns once the loop is
 * running; errors are logged and the loop restarts after a pause so a blip never silences the agent.
 */
export async function startSpectrumStream(): Promise<void> {
  if (!SPECTRUM_ENABLED || SPECTRUM_MODE !== "stream") return;
  if (g.__spectrumStreaming) return;
  g.__spectrumStreaming = true;
  const b = await builders();
  const loop = async () => {
    for (;;) {
      try {
        const app = await spectrumApp();
        console.log(`[spectrum] listening on ${SPECTRUM_PLATFORMS.join(", ")} (stream mode)`);
        for await (const [space, message] of app.messages) {
          void handleInbound(space, message, undefined, b).catch((err: unknown) => console.error("[spectrum] handler failed:", err));
        }
        console.warn("[spectrum] message stream ended; reconnecting");
      } catch (err) {
        console.error("[spectrum] stream error; retrying in 10s:", err instanceof Error ? err.message : err);
        g.__spectrumApp = null;
        await new Promise((r) => setTimeout(r, 10_000));
      }
    }
  };
  void loop();
}

/** Webhook mode: verify and dispatch one Spectrum Cloud delivery. Used by app/api/spectrum/webhook/route.ts. */
export async function handleSpectrumWebhook(request: Request): Promise<Response> {
  const app = await spectrumApp();
  const b = await builders();
  return app.webhook(request, (space, message) => handleInbound(space, message, undefined, b));
}
