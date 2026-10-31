/**
 * Photon Beta (2.0) adapter, transport half. Talks to the platform behind app.beta.photon.codes:
 *
 *   - HTTP API    https://api.photon.codes/v1/projects/{projectId}/…   Authorization: Bearer pho_sk_…
 *   - Events      Socket.IO at the same origin, path /v1/projects/{projectId}/events/ws
 *                 (websocket transport only, Bearer key in the handshake headers, `subscribe`
 *                 with a replay cursor, `delivery` frames carrying the public event object)
 *   - Webhooks    optional: a webhook destination created with the API POSTs the same event
 *                 objects to /api/photon/webhook, signed with the destination's signing secret.
 *
 * Verified against https://photon.codes/docs/beta (API reference, api-client, websocket/*) and the
 * published contracts at https://api.photon.codes/openapi.json and /asyncapi.yaml. Types come from
 * the official client, @photon-ai/api; requests are plain fetch so the binary attachment endpoints
 * (multipart/related upload, raw download) are handled in one place.
 *
 * Two ways in, both feeding lib/photon-handler.ts:
 *   - stream  (default): Socket.IO from this process. Needs no public URL: the Mac running
 *     `next dev` is enough. Started from instrumentation.ts; cursor checkpointed to disk.
 *   - webhook: Photon POSTs each event to /api/photon/webhook; the route verifies the signature
 *     with PHOTON_WEBHOOK_SECRET. For a deployment with a public URL.
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Attachment as ApiAttachment, Message as ApiMessage, SendMessageRequest } from "@photon-ai/api";

// ApiMessage is the union the HTTP endpoints return; the handler narrows it through LooseMessage below.

import {
  PHOTON_API_KEY,
  PHOTON_API_URL,
  PHOTON_API_VERSION,
  PHOTON_CURSOR_FILE,
  PHOTON_ENABLED,
  PHOTON_MODE,
  PHOTON_PROJECT_ID,
  PHOTON_WEBHOOK_SECRET,
} from "./config";
import { type Chat, type HandlerDeps, type InboundAttachment, type InboundMessage, defaultDeps, handleInbound } from "./photon-handler";

export function photonEnabled(): boolean {
  return PHOTON_ENABLED;
}

// ---------------------------------------------------------------------------
// HTTP

export class PhotonApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "PhotonApiError";
  }
}

const projectBase = () => `${PHOTON_API_URL}/v1/projects/${encodeURIComponent(PHOTON_PROJECT_ID)}`;

async function api<T>(pathname: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${PHOTON_API_KEY}`);
  if (init.body !== undefined && !headers.has("content-type") && !(init.body instanceof Blob)) headers.set("content-type", "application/json");
  const res = await fetch(`${projectBase()}${pathname}`, { ...init, headers });
  if (!res.ok) throw await problem(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Errors are RFC 9457 problem documents (application/problem+json). */
async function problem(res: Response): Promise<PhotonApiError> {
  let detail = `${res.status} ${res.statusText}`;
  let code: string | undefined;
  try {
    const body = (await res.json()) as { title?: string; detail?: string; code?: string };
    code = body.code;
    detail = [body.code, body.title, body.detail].filter(Boolean).join(": ") || detail;
  } catch {
    // not JSON
  }
  return new PhotonApiError(`Photon API ${res.status}: ${detail}`, res.status, code, res.headers.get("x-request-id") ?? undefined);
}

export function getMessage(messageId: string): Promise<ApiMessage> {
  return api<ApiMessage>(`/messages/${encodeURIComponent(messageId)}`);
}

export function getAttachment(attachmentId: string): Promise<ApiAttachment> {
  return api<ApiAttachment>(`/attachments/${encodeURIComponent(attachmentId)}`);
}

export async function downloadAttachment(attachmentId: string): Promise<Buffer> {
  const res = await fetch(`${projectBase()}/attachments/${encodeURIComponent(attachmentId)}/content`, {
    headers: { authorization: `Bearer ${PHOTON_API_KEY}` },
  });
  if (!res.ok) throw await problem(res);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * POST /attachments is multipart/related with exactly two parts: a JSON document
 * `{ contentType, sizeBytes, filename? }` and the file bytes. `sizeBytes` must equal the file length.
 */
export async function uploadAttachment(bytes: Buffer, opts: { contentType: string; filename?: string }): Promise<ApiAttachment> {
  const boundary = `photon-${randomUUID()}`;
  const meta = JSON.stringify({ contentType: opts.contentType, sizeBytes: bytes.byteLength, ...(opts.filename ? { filename: opts.filename } : {}) });
  const head = Buffer.from(`--${boundary}\r\nContent-Type: application/json\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${opts.contentType}\r\n\r\n`, "utf8");
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  const body = Buffer.concat([head, bytes, tail]);
  const res = await fetch(`${projectBase()}/attachments`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${PHOTON_API_KEY}`,
      "content-type": `multipart/related; boundary=${boundary}`,
      "content-length": String(body.byteLength),
      "idempotency-key": randomUUID(),
    },
    body: new Uint8Array(body),
  });
  if (!res.ok) throw await problem(res);
  return (await res.json()) as ApiAttachment;
}

/** POST /messages. Acceptance (202) is asynchronous; it is not delivery confirmation. */
export function sendMessage(body: SendMessageRequest, idempotencyKey: string = randomUUID()): Promise<ApiMessage> {
  return api<ApiMessage>("/messages", { method: "POST", headers: { "idempotency-key": idempotencyKey }, body: JSON.stringify(body) });
}

export function setSpaceTyping(spaceId: string, senderId: string, on: boolean): Promise<unknown> {
  return api(`/spaces/${encodeURIComponent(spaceId)}/typing`, { method: "POST", body: JSON.stringify({ senderId, typing: on }) });
}

// ---------------------------------------------------------------------------
// Message -> handler input

type Snapshot = { id?: string; handle?: string } | undefined;
/** The fields every platform variant of a Beta `Message` shares, loosely typed for narrowing. */
type LooseMessage = { id?: unknown; platform?: unknown; status?: string; content?: unknown; sentBy?: Snapshot; receivedBy?: Snapshot; space?: { id?: string; kind?: string } };

/** Narrow a Beta `Message` (@photon-ai/api `Message`) to what the handler reads. Null when it is not something we can answer. */
export function toInbound(message: unknown): InboundMessage | null {
  const m = message as LooseMessage | null;
  if (!m || typeof m.id !== "string" || typeof m.platform !== "string") return null;
  if (!m.space?.id || !m.sentBy?.id || !m.content) return null;
  return {
    id: m.id,
    platform: m.platform,
    status: m.status ?? "",
    content: m.content as InboundMessage["content"],
    sentBy: { id: m.sentBy.id, handle: m.sentBy.handle },
    receivedBy: m.receivedBy?.id ? { id: m.receivedBy.id } : undefined,
    space: { id: m.space.id, kind: m.space.kind },
  };
}

/** Beta iMessage carries text and images only; everything else gets the mp4 as an attachment. */
const VIDEO_PLATFORMS = new Set(["telegram", "whatsapp", "whatsapp_business", "whatsapp-business", "sms", "email"]);

/** The reply surface for one received message's space, over the HTTP API. */
export function chatFor(message: InboundMessage): Chat {
  const senderId = message.receivedBy?.id;
  if (!senderId) throw new Error(`message ${message.id} has no receivedBy; cannot reply`);
  const spaceId = message.space.id;
  return {
    spaceId,
    platform: message.platform,
    canSendVideo: VIDEO_PLATFORMS.has(message.platform),
    async sendText(text) {
      await sendMessage({ spaceId, senderId, parentMessageId: message.id, content: { type: "text", format: "plain", text } });
    },
    async sendFile(file, opts) {
      const bytes = await readFile(file);
      const uploaded = await uploadAttachment(bytes, { contentType: opts.mimeType, filename: opts.name });
      await sendMessage({
        spaceId,
        senderId,
        parentMessageId: message.id,
        content: { type: "attachment", attachmentId: uploaded.id, ...(opts.caption ? { metadata: { caption: { format: "plain", text: opts.caption } } } : {}) },
      });
    },
    async setTyping(on) {
      await setSpaceTyping(spaceId, senderId, on);
    },
  };
}

async function resolveAttachment(attachmentId: string): Promise<InboundAttachment> {
  const meta = await getAttachment(attachmentId);
  return {
    id: meta.id,
    name: meta.filename,
    mimeType: meta.contentType,
    size: meta.sizeBytes,
    read: () => downloadAttachment(attachmentId),
  };
}

export const liveDeps: HandlerDeps = { ...defaultDeps, resolveAttachment };

/** Dispatch one received message to the conversation handler. Exported for the webhook route and the doctor script. */
export async function dispatchMessage(raw: unknown, deps: HandlerDeps = liveDeps): Promise<boolean> {
  const inbound = toInbound(raw);
  if (!inbound || inbound.status !== "received") return false;
  await handleInbound(chatFor(inbound), inbound, deps);
  return true;
}

// ---------------------------------------------------------------------------
// Events -> messages

/**
 * One public event object, as delivered over Socket.IO or a webhook. Only `id` and `type` are
 * guaranteed by the contract; the payload layout is per event type and API version. We take a
 * message id from the usual places and read the canonical message back over HTTP, so a payload
 * revision never changes what the handler sees.
 */
export interface PhotonEvent {
  id: string;
  type: string;
  [key: string]: unknown;
}

export function messageIdFromEvent(event: PhotonEvent): string | null {
  if (!/^message\b/i.test(event.type)) return null;
  const data = (event.data ?? event.payload ?? event.object ?? event) as Record<string, unknown>;
  // Beta events (apiVersion 2026-07-01) carry the Message as `data.object`; the other shapes are kept
  // for older payloads and webhooks.
  const candidates = [
    (data.object as { id?: unknown } | undefined)?.id,
    (data.message as { id?: unknown } | undefined)?.id,
    data.messageId,
    data.id !== event.id ? data.id : undefined,
  ];
  for (const c of candidates) if (typeof c === "string" && c) return c;
  return null;
}

export async function handlePhotonEvent(event: PhotonEvent, deps: HandlerDeps = liveDeps): Promise<void> {
  const messageId = messageIdFromEvent(event);
  if (!messageId) {
    // A message event we cannot place is a contract change, not noise: say so instead of advancing past it quietly.
    if (/^message\b/i.test(event.type)) console.warn(`[photon] ${event.type} ${event.id} carries no message id; payload keys: ${Object.keys((event.data as object) ?? {}).join(",")}`);
    return;
  }
  const data = (event.data ?? {}) as Record<string, unknown>;
  const embedded = (data.object ?? data.message ?? data) as Record<string, unknown>;
  // Use the embedded message when the event carries a full one; otherwise read it back.
  const full = embedded && embedded.content && embedded.space && embedded.sentBy ? embedded : await getMessage(messageId);
  await dispatchMessage(full, deps);
}

// ---------------------------------------------------------------------------
// Stream mode: Socket.IO

const g = globalThis as typeof globalThis & { __photonStreaming?: boolean };
g.__photonStreaming ??= false;

async function readCursor(): Promise<number> {
  try {
    const parsed = JSON.parse(await readFile(PHOTON_CURSOR_FILE, "utf8")) as { projectId?: string; seq?: number };
    return parsed.projectId === PHOTON_PROJECT_ID && Number.isSafeInteger(parsed.seq) && parsed.seq! >= 0 ? parsed.seq! : 0;
  } catch {
    return 0;
  }
}

async function writeCursor(seq: number): Promise<void> {
  await mkdir(path.dirname(PHOTON_CURSOR_FILE), { recursive: true });
  await writeFile(PHOTON_CURSOR_FILE, JSON.stringify({ projectId: PHOTON_PROJECT_ID, seq, savedAt: new Date().toISOString() }));
}

/**
 * Open the event stream and dispatch every message event. Deliveries are processed one at a
 * time; the cursor advances only after a handler succeeds, so a crash replays unfinished work.
 * Socket.IO reconnects on its own; every (re)connect subscribes again from the saved cursor.
 */
export async function startPhotonStream(): Promise<void> {
  if (!PHOTON_ENABLED || PHOTON_MODE !== "stream") return;
  if (g.__photonStreaming) return;
  g.__photonStreaming = true;

  const { io } = await import("socket.io-client");
  let cursor = await readCursor();
  let queue: Promise<void> = Promise.resolve();
  let epoch = 0;

  const socket = io(PHOTON_API_URL, {
    path: `/v1/projects/${PHOTON_PROJECT_ID}/events/ws`,
    addTrailingSlash: false,
    transports: ["websocket"],
    extraHeaders: { Authorization: `Bearer ${PHOTON_API_KEY}` },
    autoConnect: false,
    reconnectionDelayMax: 30_000,
  });

  socket.on("connect", () => {
    const myEpoch = ++epoch;
    const payload: { startSeq: number; apiVersion?: string } = { startSeq: cursor };
    if (PHOTON_API_VERSION) payload.apiVersion = PHOTON_API_VERSION;
    socket.timeout(10_000).emit("subscribe", payload, (err: unknown, result: { ok: boolean; connectionId?: string; apiVersion?: string; error?: { code: string; message: string } }) => {
      if (err) {
        console.error("[photon] subscribe transport error; reconnecting:", err instanceof Error ? err.message : err);
        socket.io.engine.close();
        return;
      }
      if (!result.ok) {
        console.error(`[photon] subscribe rejected: ${result.error?.code} ${result.error?.message ?? ""}`);
        return;
      }
      if (myEpoch === epoch) console.log(`[photon] listening on project ${PHOTON_PROJECT_ID} (stream mode, connection ${result.connectionId}, apiVersion ${result.apiVersion}, from seq ${cursor})`);
    });
  });

  socket.on("delivery", (event: PhotonEvent, meta: { seq: number; replyExpected: boolean }) => {
    const myEpoch = epoch;
    queue = queue.then(async () => {
      if (myEpoch !== epoch) return; // from before a disconnect; the resubscribe will replay it
      if (meta.seq <= cursor) return;
      try {
        await handlePhotonEvent(event);
        cursor = meta.seq;
        await writeCursor(cursor);
      } catch (err) {
        console.error(`[photon] event ${event.type} ${event.id} failed; reconnecting to replay from ${cursor}:`, err instanceof Error ? err.message : err);
        epoch++;
        socket.io.engine.close();
      }
    });
  });

  socket.on("delivery_error", (e: { code: string; message: string; fatal: boolean; retryable: boolean }) => {
    console.error(`[photon] delivery_error ${e.code}: ${e.message} (fatal=${e.fatal}, retryable=${e.retryable})`);
  });
  socket.on("connect_error", (err) => console.error("[photon] connect_error:", err.message));
  socket.on("disconnect", (reason) => console.warn(`[photon] disconnected (${reason}); Socket.IO will reconnect`));

  socket.connect();
}

// ---------------------------------------------------------------------------
// Webhook mode

/**
 * Verify a webhook delivery. Photon signs with the destination's signing secret: HMAC-SHA256 over
 * `v0:{timestamp}:{raw body}`, sent as `X-Photon-Signature: v0=<hex>` with `X-Photon-Timestamp`
 * (unix seconds). Deliveries older than five minutes are refused. Compare in constant time.
 */
export function verifyWebhookSignature(rawBody: string, headers: Headers, secret: string = PHOTON_WEBHOOK_SECRET, now: number = Date.now()): { ok: true } | { ok: false; reason: string } {
  if (!secret) return { ok: false, reason: "PHOTON_WEBHOOK_SECRET is not set" };
  const signature = headers.get("x-photon-signature") ?? headers.get("photon-signature") ?? "";
  const timestamp = headers.get("x-photon-timestamp") ?? headers.get("photon-timestamp") ?? "";
  if (!signature || !timestamp) return { ok: false, reason: "missing signature headers" };
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: "bad timestamp" };
  const tsMs = ts > 1e12 ? ts : ts * 1000;
  if (Math.abs(now - tsMs) > 5 * 60 * 1000) return { ok: false, reason: "stale delivery" };
  const expected = createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex");
  const given = signature.replace(/^v0=/, "").trim();
  if (given.length !== expected.length) return { ok: false, reason: "bad signature" };
  return timingSafeEqual(Buffer.from(given, "hex"), Buffer.from(expected, "hex")) ? { ok: true } : { ok: false, reason: "bad signature" };
}

/** Parse and verify one webhook delivery; returns the event or a Response explaining the refusal. */
export async function readWebhook(request: Request): Promise<{ event: PhotonEvent } | { response: Response }> {
  const raw = await request.text();
  const verdict = verifyWebhookSignature(raw, request.headers);
  if (!verdict.ok) return { response: Response.json({ error: verdict.reason }, { status: verdict.reason.includes("secret") ? 503 : 401 }) };
  try {
    const event = JSON.parse(raw) as PhotonEvent;
    if (!event || typeof event.id !== "string" || typeof event.type !== "string") throw new Error("not an event");
    return { event };
  } catch {
    return { response: Response.json({ error: "malformed event" }, { status: 400 }) };
  }
}
