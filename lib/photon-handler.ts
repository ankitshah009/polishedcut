/**
 * Photon chat adapter, platform-agnostic half. One agent sits behind iMessage, Telegram, WhatsApp
 * Business and SMS through Photon's Beta (2.0) platform (app.beta.photon.codes). Whatever the
 * platform, Photon hands us a received `Message` and we answer into its `space`. This module holds
 * the conversation logic and calls the same `createRun` the dashboard upload uses, so a clip texted
 * in is cut by the very same pipeline.
 *
 * Flow per conversation (a "space": one DM or group):
 *   clip(s) + text  ->  createRun(brief, clips)  ->  wait for the loop  ->  reply with the mp4
 *   text alone, cut already delivered  ->  director's note (startRevision)  ->  reply with the new mp4
 *   text alone, nothing pending  ->  short help
 *
 * No HTTP here: `Chat` (the reply surface) and `HandlerDeps.resolveAttachment` are injected, so
 * tests/photon.test.ts drives `handleInbound` with plain objects and never touches the network.
 * The shapes below are the Beta API's public `Message` / `Content` (types from @photon-ai/api),
 * narrowed to what the conversation needs.
 */
import { stat } from "node:fs/promises";
import path from "node:path";

import {
  BRIEF_MAX_CHARS,
  NOTE_MAX_CHARS,
  PHOTON_MAX_ATTACHMENT_BYTES,
  PHOTON_RUN_TIMEOUT_MS,
  PHOTON_SETTLE_MS,
  PUBLIC_URL,
  isVideoName,
  runDir,
} from "./config";
import { isImageFile } from "./images";
import { UploadRejected, createRun as realCreateRun } from "./intake";
import { reviseBlocker, startRevision as realStartRevision } from "./revise";
import type { Run } from "./schema";
import { isInProgress, loadRun, subscribe } from "./store";

// ---------------------------------------------------------------------------
// Beta API shapes (structural subsets of @photon-ai/api's Message / Content)

/** `content` of a Beta message: text, one attachment, or a group of parts. Other kinds are ignored. */
export type InboundContent =
  | { type: "text"; text: string; format?: string }
  | { type: "attachment"; attachmentId: string; metadata?: unknown }
  | { type: "group"; parts: InboundContent[] }
  | { type: string; [key: string]: unknown };

/** The slice of a Beta `Message` the handler reads. `status: "received"` marks an inbound message. */
export interface InboundMessage {
  id: string;
  platform: string;
  status: string;
  content: InboundContent;
  /** The person who texted. `handle` is their phone number / username when the platform exposes one. */
  sentBy: { id: string; handle?: string };
  /** The agent's own line that received it; its `id` is the `senderId` of every reply. */
  receivedBy?: { id: string };
  space: { id: string; kind?: string };
}

/** An inbound attachment, resolved (metadata + bytes) by the transport. */
export interface InboundAttachment {
  id: string;
  name?: string;
  mimeType: string;
  size?: number;
  read: () => Promise<Buffer>;
}

/** The reply surface for one space. lib/photon.ts builds the real one over the HTTP API. */
export interface Chat {
  readonly spaceId: string;
  readonly platform: string;
  /** Beta iMessage carries text and images only, so a video render goes out as a link there. */
  readonly canSendVideo: boolean;
  sendText(text: string): Promise<void>;
  sendFile(file: string, opts: { name: string; mimeType: string; caption?: string }): Promise<void>;
  setTyping(on: boolean): Promise<void>;
}

// ---------------------------------------------------------------------------
// Replies (plain text: iMessage and WhatsApp render no markdown)

export const REPLIES = {
  help: [
    "Hi, this is PolishedCut. Send me a clip (or a few) and tell me the cut you want in one line,",
    'e.g. "30s recap with captions, open on the strongest moment".',
    "I'll cut it, watch my own render, fix it, and text the finished video back.",
  ].join(" "),
  gotClips: (n: number) =>
    n === 1 ? "Got the clip. What's the cut? One line is plenty." : `Got ${n} clips. What's the cut? One line is plenty.`,
  gotBrief: "Got the brief. Now send the clip(s) you want cut.",
  starting: (n: number, brief: string) => `On it: cutting ${n} clip${n === 1 ? "" : "s"} to "${brief}". This takes a few minutes; I'll text you the video.`,
  revising: (note: string) => `Applying your note: "${note}". Give me a minute.`,
  done: (run: Run) => {
    const iter = run.iterations.at(-1);
    const title = iter?.edl.title?.trim();
    const versions = run.iterations.length;
    const lines = [
      title ? `Here's "${title}".` : "Here's your cut.",
      versions > 1 ? `I rendered ${versions} versions and fixed what my own review flagged before sending this one.` : "",
      run.status === "done" && !allChecksPassed(run) ? "One check still didn't pass; reply with a note and I'll take another pass." : "Reply with a note (e.g. \"tighter, lose the second shot\") and I'll revise it.",
      PUBLIC_URL ? `Every version and the critique behind each change: ${PUBLIC_URL}/s/${run.id}` : "",
    ];
    return lines.filter(Boolean).join(" ");
  },
  linkOnly: (run: Run) =>
    PUBLIC_URL
      ? `Watch and download the video here: ${PUBLIC_URL}/s/${run.id}`
      : "I can't attach the video on this platform and PUBLIC_URL is not set on the server, so there is no link to send.",
  tooBig: (run: Run) =>
    PUBLIC_URL
      ? `The render is too large to attach here; watch and download it at ${PUBLIC_URL}/s/${run.id}`
      : "The render is too large to attach here. Set PUBLIC_URL on the server to get a link instead.",
  failed: (why: string) => `That cut didn't make it: ${why}`,
  rejected: (why: string) => `I can't cut that: ${why}`,
  busy: "I'm still working on your last cut. I'll text you as soon as it's done.",
  timeout: "This cut is taking longer than expected. I'll keep working on it; check back in a bit.",
  unsupported: "I can only work with videos and photos. Send a clip and a one-line brief.",
} as const;

function allChecksPassed(run: Run): boolean {
  const critique = run.iterations.at(-1)?.critique;
  return !critique || critique.checks.every((c) => c.passed);
}

// ---------------------------------------------------------------------------
// Session state per space

interface PendingClip {
  name: string;
  mimeType: string;
  size?: number;
  read: () => Promise<Buffer>;
}

interface Session {
  clips: PendingClip[];
  brief: string;
  /** The run this chat is currently waiting on, if any. */
  activeRunId: string | null;
  /** The last run delivered to this chat: a bare text message becomes a director's note on it. */
  lastRunId: string | null;
  timer: ReturnType<typeof setTimeout> | null;
}

// Kept on globalThis so a dev hot reload does not forget who sent what.
const g = globalThis as typeof globalThis & {
  __photonSessions?: Map<string, Session>;
  __photonSeen?: Set<string>;
};
g.__photonSessions ??= new Map();
g.__photonSeen ??= new Set();
const sessions = g.__photonSessions;
const seen = g.__photonSeen;
const SEEN_LIMIT = 5000;

function session(spaceKey: string): Session {
  let s = sessions.get(spaceKey);
  if (!s) {
    s = { clips: [], brief: "", activeRunId: null, lastRunId: null, timer: null };
    sessions.set(spaceKey, s);
  }
  return s;
}

/** Deliveries are at-least-once (Socket.IO replay and webhooks alike); drop a message id seen before. */
function firstTime(id: string): boolean {
  if (seen.has(id)) return false;
  seen.add(id);
  if (seen.size > SEEN_LIMIT) {
    for (const old of seen) {
      seen.delete(old);
      if (seen.size <= SEEN_LIMIT / 2) break;
    }
  }
  return true;
}

/** Test hook: forget every conversation. */
export function resetSessions(): void {
  for (const s of sessions.values()) if (s.timer) clearTimeout(s.timer);
  sessions.clear();
  seen.clear();
}

// ---------------------------------------------------------------------------
// Content -> clips and text

export interface Flattened {
  texts: string[];
  attachmentIds: string[];
  other: string[];
}

/** Pull texts and attachment ids out of any inbound content shape (text, attachment, group). */
export function flattenContent(content: InboundContent, out: Flattened = { texts: [], attachmentIds: [], other: [] }): Flattened {
  switch (content.type) {
    case "text": {
      const text = typeof content.text === "string" ? content.text.trim() : "";
      if (text) out.texts.push(text);
      break;
    }
    case "attachment":
      if (typeof content.attachmentId === "string") out.attachmentIds.push(content.attachmentId);
      break;
    case "group":
      if (Array.isArray(content.parts)) for (const part of content.parts) flattenContent(part as InboundContent, out);
      break;
    default:
      out.other.push(content.type);
  }
  return out;
}

function isFootage(a: InboundAttachment): boolean {
  const name = a.name ?? "";
  return a.mimeType.startsWith("video/") || isVideoName(name) || a.mimeType.startsWith("image/") || isImageFile(name, a.mimeType);
}

function fileNameFor(a: InboundAttachment, i: number): string {
  if (a.name && /\.[A-Za-z0-9]{2,5}$/.test(a.name)) return a.name;
  const ext = a.mimeType.startsWith("video/") ? (a.mimeType.includes("quicktime") ? ".mov" : ".mp4") : a.mimeType.includes("png") ? ".png" : a.mimeType.includes("heic") ? ".heic" : ".jpg";
  return `clip${i + 1}${ext}`;
}

// ---------------------------------------------------------------------------
// Waiting on the loop

/** Resolve when `id` reaches a terminal status, or reject after `timeoutMs`. Uses the store bus; no polling. */
export function waitForRun(id: string, timeoutMs: number = PHOTON_RUN_TIMEOUT_MS): Promise<Run> {
  return new Promise<Run>((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      fn();
    };
    const unsubscribe = subscribe(id, (run) => {
      if (!isInProgress(run.status)) finish(() => resolve(run));
    });
    const timer = setTimeout(() => finish(() => reject(new Error("timeout"))), timeoutMs);
    // The run may already have finished between creation and subscribe.
    void loadRun(id).then((run) => {
      if (run && !isInProgress(run.status)) finish(() => resolve(run));
    });
  });
}

// ---------------------------------------------------------------------------
// The handler

export interface HandlerDeps {
  createRun: (brief: string, files: File[], opts: { source: string; requester?: string }) => Promise<Run>;
  waitForRun: (id: string, timeoutMs?: number) => Promise<Run>;
  loadRun: (id: string) => Promise<Run | null>;
  startRevision: (run: Run, note: string) => void;
  /** Resolve the absolute path and size of the mp4 to send back, or null when it is missing. */
  renderFor: (run: Run) => Promise<{ file: string; size: number } | null>;
  /** Fetch an inbound attachment's metadata and a reader for its bytes (GET …/attachments/{id}[/content]). */
  resolveAttachment: (attachmentId: string) => Promise<InboundAttachment>;
  settleMs: number;
  log: (msg: string, ...rest: unknown[]) => void;
}

export const defaultDeps: Omit<HandlerDeps, "resolveAttachment"> = {
  createRun: realCreateRun,
  waitForRun,
  loadRun,
  startRevision: realStartRevision,
  renderFor: async (run) => {
    const video = run.iterations.at(-1)?.video;
    if (!video) return null;
    const file = path.join(runDir(run.id), video);
    try {
      return { file, size: (await stat(file)).size };
    } catch {
      return null;
    }
  },
  settleMs: PHOTON_SETTLE_MS,
  log: (msg, ...rest) => console.log(`[photon] ${msg}`, ...rest),
};

async function say(chat: Chat, text: string, log: HandlerDeps["log"]): Promise<void> {
  try {
    await chat.sendText(text);
  } catch (err) {
    log(`could not send to ${chat.platform}:${chat.spaceId}:`, err);
  }
}

async function typing(chat: Chat, on: boolean): Promise<void> {
  try {
    await chat.setTyping(on);
  } catch {
    // best effort on every platform
  }
}

/**
 * Handle one received message. Returns once the immediate acknowledgement is sent; the cut itself
 * continues in the background and replies into the space when it is done.
 */
export async function handleInbound(chat: Chat, message: InboundMessage, deps: HandlerDeps): Promise<void> {
  if (message.status !== "received") return; // our own dispatched/delivered echoes
  if (!firstTime(`${message.platform}:${message.id}`)) return;

  const key = `${chat.platform}:${chat.spaceId}`;
  const s = session(key);
  const { texts, attachmentIds, other } = flattenContent(message.content);
  const requester = message.sentBy.handle ?? message.sentBy.id;

  const attachments: InboundAttachment[] = [];
  for (const id of attachmentIds) {
    try {
      attachments.push(await deps.resolveAttachment(id));
    } catch (err) {
      deps.log(`could not resolve attachment ${id}:`, err);
    }
  }
  const footage = attachments.filter(isFootage);

  if (texts.length === 0 && footage.length === 0) {
    // A read receipt, a typing update, a sticker: nothing to cut. Only speak when they sent a file we cannot use.
    if (attachments.length > 0 || attachmentIds.length > 0) await say(chat, REPLIES.unsupported, deps.log);
    else void other;
    return;
  }

  if (s.activeRunId) {
    await say(chat, REPLIES.busy, deps.log);
    return;
  }

  for (const [i, a] of footage.entries()) {
    s.clips.push({ name: fileNameFor(a, s.clips.length + i), mimeType: a.mimeType, size: a.size, read: a.read });
  }
  const text = texts.join("\n").trim();

  // Text with no clips pending and a delivered cut behind us: a director's note.
  if (text && footage.length === 0 && s.clips.length === 0 && s.lastRunId) {
    await revise(chat, s, text, requester, deps);
    return;
  }

  if (text) s.brief = s.brief ? `${s.brief}\n${text}` : text;

  if (s.clips.length > 0 && s.brief) {
    // Both halves are here. Give the platform a moment to deliver the rest of a multi-clip send.
    schedule(chat, s, requester, deps);
    return;
  }
  if (s.clips.length > 0) {
    await say(chat, REPLIES.gotClips(s.clips.length), deps.log);
    return;
  }
  // Text only, nothing delivered yet: either a brief ahead of the clips, or a greeting.
  if (looksLikeBrief(text)) {
    await say(chat, REPLIES.gotBrief, deps.log);
  } else {
    s.brief = "";
    await say(chat, REPLIES.help, deps.log);
  }
}

/** "hi" / "hello?" / "help" are greetings; anything longer than a couple of words is a brief. */
export function looksLikeBrief(text: string): boolean {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length >= 4) return true;
  return !/^(hi|hey|hello|yo|sup|help|start|hola|test|\?+)[\s!.?]*$/i.test(text);
}

function schedule(chat: Chat, s: Session, requester: string | undefined, deps: HandlerDeps): void {
  if (s.timer) clearTimeout(s.timer);
  s.timer = setTimeout(() => {
    s.timer = null;
    void cut(chat, s, requester, deps);
  }, deps.settleMs);
}

async function cut(chat: Chat, s: Session, requester: string | undefined, deps: HandlerDeps): Promise<void> {
  const clips = s.clips.splice(0);
  const brief = s.brief.slice(0, BRIEF_MAX_CHARS);
  s.brief = "";
  if (clips.length === 0 || !brief) return;

  await typing(chat, true);
  let run: Run;
  try {
    const files: File[] = [];
    for (const c of clips) files.push(new File([new Uint8Array(await c.read())], c.name, { type: c.mimeType }));
    run = await deps.createRun(brief, files, { source: chat.platform, requester });
  } catch (err) {
    await typing(chat, false);
    if (err instanceof UploadRejected) {
      await say(chat, REPLIES.rejected(err.message), deps.log);
    } else {
      deps.log("createRun failed:", err);
      await say(chat, REPLIES.failed(err instanceof Error ? err.message : String(err)), deps.log);
    }
    return;
  }
  s.activeRunId = run.id;
  deps.log(`run ${run.id} started from ${chat.platform}:${chat.spaceId} (${clips.length} clips)`);
  await say(chat, REPLIES.starting(clips.length, brief), deps.log);
  await deliver(chat, s, run.id, deps);
}

async function revise(chat: Chat, s: Session, note: string, requester: string | undefined, deps: HandlerDeps): Promise<void> {
  const run = s.lastRunId ? await deps.loadRun(s.lastRunId) : null;
  if (!run) {
    s.lastRunId = null;
    s.brief = note;
    await say(chat, REPLIES.gotBrief, deps.log);
    return;
  }
  const blocker = reviseBlocker(run);
  if (blocker) {
    await say(chat, REPLIES.busy, deps.log);
    return;
  }
  const trimmed = note.slice(0, NOTE_MAX_CHARS);
  s.activeRunId = run.id;
  deps.startRevision(run, trimmed);
  deps.log(`revision of ${run.id} from ${chat.platform}:${chat.spaceId} (${requester ?? "unknown"}): ${trimmed}`);
  await say(chat, REPLIES.revising(trimmed), deps.log);
  await typing(chat, true);
  await deliver(chat, s, run.id, deps);
}

/** Wait for the loop, then send the render (or the reason there is none). Clears the active run either way. */
async function deliver(chat: Chat, s: Session, runId: string, deps: HandlerDeps): Promise<void> {
  let run: Run;
  try {
    run = await deps.waitForRun(runId);
  } catch {
    s.activeRunId = null;
    await typing(chat, false);
    await say(chat, REPLIES.timeout, deps.log);
    return;
  }
  s.activeRunId = null;
  s.lastRunId = run.id;
  await typing(chat, false);

  if (run.status === "error" && run.iterations.length === 0) {
    await say(chat, REPLIES.failed(run.error || "unknown error"), deps.log);
    return;
  }
  const render = await deps.renderFor(run);
  if (!render) {
    await say(chat, REPLIES.failed(run.error || "the render is missing"), deps.log);
    return;
  }
  if (render.size > PHOTON_MAX_ATTACHMENT_BYTES) {
    await say(chat, `${REPLIES.done(run)} ${REPLIES.tooBig(run)}`.trim(), deps.log);
    return;
  }
  if (!chat.canSendVideo) {
    // Beta iMessage: text and images only. The summary carries the link.
    await say(chat, `${REPLIES.done(run)} ${PUBLIC_URL ? "" : REPLIES.linkOnly(run)}`.trim(), deps.log);
    return;
  }
  try {
    await chat.sendFile(render.file, { name: `polishedcut-${run.id}.mp4`, mimeType: "video/mp4" });
  } catch (err) {
    deps.log(`could not attach the render for ${run.id} on ${chat.platform}; sending the link instead:`, err);
    await say(chat, `${REPLIES.done(run)} ${PUBLIC_URL ? "" : REPLIES.linkOnly(run)}`.trim(), deps.log);
    return;
  }
  await say(chat, REPLIES.done(run), deps.log);
}
