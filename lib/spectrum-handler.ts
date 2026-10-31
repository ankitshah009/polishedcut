/**
 * Photon Spectrum adapter, platform-agnostic half. One agent sits behind iMessage, WhatsApp,
 * Telegram and Slack (photon.codes); whatever the platform, Spectrum hands us `[space, message]`
 * pairs and we answer into the space. This module holds the conversation logic and calls the same
 * `createRun` the dashboard upload uses, so a clip texted in is cut by the very same pipeline.
 *
 * Flow per conversation (a "space": one DM or group):
 *   clip(s) + text  ->  createRun(brief, clips)  ->  wait for the loop  ->  reply with the mp4
 *   text alone, cut already delivered  ->  director's note (startRevision)  ->  reply with the new mp4
 *   text alone, nothing pending  ->  short help
 *
 * No SDK import here beyond types: tests drive `handleInbound` with plain objects (tests/spectrum.test.ts).
 */
import { stat } from "node:fs/promises";
import path from "node:path";

import type { Attachment, Content, Message } from "spectrum-ts";

import {
  BRIEF_MAX_CHARS,
  NOTE_MAX_CHARS,
  PUBLIC_URL,
  SPECTRUM_MAX_ATTACHMENT_BYTES,
  SPECTRUM_RUN_TIMEOUT_MS,
  SPECTRUM_SETTLE_MS,
  isVideoName,
  runDir,
} from "./config";
import { isImageFile } from "./images";
import { UploadRejected, createRun as realCreateRun } from "./intake";
import { reviseBlocker, startRevision as realStartRevision } from "./revise";
import type { Run } from "./schema";
import { isInProgress, loadRun, subscribe } from "./store";

// ---------------------------------------------------------------------------
// Replies (plain text: iMessage and WhatsApp have no markdown)

export const REPLIES = {
  help: [
    "Hi, this is Framecut. Send me a clip (or a few) and tell me the cut you want in one line,",
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
  __spectrumSessions?: Map<string, Session>;
  __spectrumSeen?: Set<string>;
};
g.__spectrumSessions ??= new Map();
g.__spectrumSeen ??= new Set();
const sessions = g.__spectrumSessions;
const seen = g.__spectrumSeen;
const SEEN_LIMIT = 5000;

function session(spaceKey: string): Session {
  let s = sessions.get(spaceKey);
  if (!s) {
    s = { clips: [], brief: "", activeRunId: null, lastRunId: null, timer: null };
    sessions.set(spaceKey, s);
  }
  return s;
}

/** Deliveries are at-least-once (stream and webhook alike); drop a message id seen before. */
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
  attachments: Attachment[];
  other: string[];
}

/** Pull texts and attachments out of any inbound content shape (text, attachment, group, reply, markdown). */
export function flattenContent(content: Content, out: Flattened = { texts: [], attachments: [], other: [] }): Flattened {
  switch (content.type) {
    case "text":
      if (content.text.trim()) out.texts.push(content.text.trim());
      break;
    case "markdown":
      if (content.markdown.trim()) out.texts.push(content.markdown.trim());
      break;
    case "attachment":
      out.attachments.push(content);
      break;
    case "group":
      for (const item of content.items) flattenContent(item.content, out);
      break;
    case "reply":
      flattenContent(content.content as Content, out);
      break;
    default:
      out.other.push(content.type);
  }
  return out;
}

function isFootage(a: Attachment): boolean {
  return a.mimeType.startsWith("video/") || isVideoName(a.name) || a.mimeType.startsWith("image/") || isImageFile(a.name, a.mimeType);
}

function fileNameFor(a: Attachment, i: number): string {
  if (a.name && /\.[A-Za-z0-9]{2,5}$/.test(a.name)) return a.name;
  const ext = a.mimeType.startsWith("video/") ? (a.mimeType.includes("quicktime") ? ".mov" : ".mp4") : a.mimeType.includes("png") ? ".png" : a.mimeType.includes("heic") ? ".heic" : ".jpg";
  return `clip${i + 1}${ext}`;
}

// ---------------------------------------------------------------------------
// Waiting on the loop

/** Resolve when `id` reaches a terminal status, or reject after `timeoutMs`. Uses the store bus; no polling. */
export function waitForRun(id: string, timeoutMs: number = SPECTRUM_RUN_TIMEOUT_MS): Promise<Run> {
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
  settleMs: number;
  log: (msg: string, ...rest: unknown[]) => void;
}

export const defaultDeps: HandlerDeps = {
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
  settleMs: SPECTRUM_SETTLE_MS,
  log: (msg, ...rest) => console.log(`[spectrum] ${msg}`, ...rest),
};

/** `spectrum-ts` content builders are injected too, so tests need no SDK at runtime. */
export interface Builders {
  attachment: (input: string | Buffer, options?: { mimeType?: string; name?: string }) => unknown;
}

/** The slice of a Spectrum `Space` the handler uses; loose enough for a plain object in tests. */
export interface Sendable {
  readonly id: string;
  readonly __platform: string;
  send(content: unknown): Promise<unknown>;
  startTyping(): Promise<void>;
  stopTyping(): Promise<void>;
}

async function say(space: Sendable, text: string, log: HandlerDeps["log"]): Promise<void> {
  try {
    await space.send(text);
  } catch (err) {
    log(`could not send to ${space.__platform}:${space.id}:`, err);
  }
}

async function typing(space: Sendable, on: boolean): Promise<void> {
  try {
    await (on ? space.startTyping() : space.stopTyping());
  } catch {
    // best effort on every platform
  }
}

/**
 * Handle one inbound `[space, message]`. Returns once the immediate acknowledgement is sent; the
 * cut itself continues in the background and replies into the space when it is done.
 */
export async function handleInbound(
  space: Sendable,
  message: Pick<Message, "id" | "content" | "sender" | "direction" | "platform">,
  deps: HandlerDeps = defaultDeps,
  builders?: Builders,
): Promise<void> {
  if (message.direction === "outbound") return;
  if (!firstTime(`${message.platform}:${message.id}`)) return;

  const key = `${space.__platform}:${space.id}`;
  const s = session(key);
  const { texts, attachments, other } = flattenContent(message.content);
  const footage = attachments.filter(isFootage);
  const requester = message.sender?.id;

  if (texts.length === 0 && footage.length === 0) {
    // A reaction, a sticker, a contact card: nothing to cut. Only speak when they sent a file we cannot use.
    if (attachments.length > 0 || other.includes("attachment")) await say(space, REPLIES.unsupported, deps.log);
    return;
  }

  if (s.activeRunId) {
    await say(space, REPLIES.busy, deps.log);
    return;
  }

  for (const [i, a] of footage.entries()) {
    s.clips.push({ name: fileNameFor(a, s.clips.length + i), mimeType: a.mimeType, size: a.size, read: a.read });
  }
  const text = texts.join("\n").trim();

  // Text with no clips pending and a delivered cut behind us: a director's note.
  if (text && footage.length === 0 && s.clips.length === 0 && s.lastRunId) {
    await revise(space, s, text, requester, deps, builders);
    return;
  }

  if (text) s.brief = s.brief ? `${s.brief}\n${text}` : text;

  if (s.clips.length > 0 && s.brief) {
    // Both halves are here. Give the platform a moment to deliver the rest of a multi-clip send.
    schedule(space, s, requester, deps, builders);
    return;
  }
  if (s.clips.length > 0) {
    await say(space, REPLIES.gotClips(s.clips.length), deps.log);
    return;
  }
  // Text only, nothing delivered yet: either a brief ahead of the clips, or a greeting.
  if (looksLikeBrief(text)) {
    await say(space, REPLIES.gotBrief, deps.log);
  } else {
    s.brief = "";
    await say(space, REPLIES.help, deps.log);
  }
}

/** "hi" / "hello?" / "help" are greetings; anything longer than a couple of words is a brief. */
export function looksLikeBrief(text: string): boolean {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length >= 4) return true;
  return !/^(hi|hey|hello|yo|sup|help|start|hola|test|\?+)[\s!.?]*$/i.test(text);
}

function schedule(space: Sendable, s: Session, requester: string | undefined, deps: HandlerDeps, builders?: Builders): void {
  if (s.timer) clearTimeout(s.timer);
  s.timer = setTimeout(() => {
    s.timer = null;
    void cut(space, s, requester, deps, builders);
  }, deps.settleMs);
}

async function cut(space: Sendable, s: Session, requester: string | undefined, deps: HandlerDeps, builders?: Builders): Promise<void> {
  const clips = s.clips.splice(0);
  const brief = s.brief.slice(0, BRIEF_MAX_CHARS);
  s.brief = "";
  if (clips.length === 0 || !brief) return;

  await typing(space, true);
  let run: Run;
  try {
    const files: File[] = [];
    for (const c of clips) files.push(new File([new Uint8Array(await c.read())], c.name, { type: c.mimeType }));
    run = await deps.createRun(brief, files, { source: space.__platform, requester });
  } catch (err) {
    await typing(space, false);
    if (err instanceof UploadRejected) {
      await say(space, REPLIES.rejected(err.message), deps.log);
    } else {
      deps.log("createRun failed:", err);
      await say(space, REPLIES.failed(err instanceof Error ? err.message : String(err)), deps.log);
    }
    return;
  }
  s.activeRunId = run.id;
  deps.log(`run ${run.id} started from ${space.__platform}:${space.id} (${clips.length} clips)`);
  await say(space, REPLIES.starting(clips.length, brief), deps.log);
  await deliver(space, s, run.id, deps, builders);
}

async function revise(space: Sendable, s: Session, note: string, requester: string | undefined, deps: HandlerDeps, builders?: Builders): Promise<void> {
  const run = s.lastRunId ? await deps.loadRun(s.lastRunId) : null;
  if (!run) {
    s.lastRunId = null;
    s.brief = note;
    await say(space, REPLIES.gotBrief, deps.log);
    return;
  }
  const blocker = reviseBlocker(run);
  if (blocker) {
    await say(space, REPLIES.busy, deps.log);
    return;
  }
  const trimmed = note.slice(0, NOTE_MAX_CHARS);
  s.activeRunId = run.id;
  deps.startRevision(run, trimmed);
  deps.log(`revision of ${run.id} from ${space.__platform}:${space.id}: ${trimmed}`);
  await say(space, REPLIES.revising(trimmed), deps.log);
  await typing(space, true);
  void requester;
  await deliver(space, s, run.id, deps, builders);
}

/** Wait for the loop, then send the render (or the reason there is none). Clears the active run either way. */
async function deliver(space: Sendable, s: Session, runId: string, deps: HandlerDeps, builders?: Builders): Promise<void> {
  let run: Run;
  try {
    run = await deps.waitForRun(runId);
  } catch {
    s.activeRunId = null;
    await typing(space, false);
    await say(space, REPLIES.timeout, deps.log);
    return;
  }
  s.activeRunId = null;
  s.lastRunId = run.id;
  await typing(space, false);

  if (run.status === "error" && run.iterations.length === 0) {
    await say(space, REPLIES.failed(run.error || "unknown error"), deps.log);
    return;
  }
  const render = await deps.renderFor(run);
  if (!render) {
    await say(space, REPLIES.failed(run.error || "the render is missing"), deps.log);
    return;
  }
  if (render.size > SPECTRUM_MAX_ATTACHMENT_BYTES || !builders) {
    await say(space, `${REPLIES.done(run)} ${REPLIES.tooBig(run)}`.trim(), deps.log);
    return;
  }
  try {
    const name = `framecut-${run.id}.mp4`;
    await space.send(builders.attachment(render.file, { mimeType: "video/mp4", name }));
    await say(space, REPLIES.done(run), deps.log);
  } catch (err) {
    deps.log(`could not attach render for ${run.id}:`, err);
    await say(space, `${REPLIES.done(run)} ${REPLIES.tooBig(run)}`.trim(), deps.log);
  }
}
