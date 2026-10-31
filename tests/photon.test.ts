// The chat adapter's conversation logic, driven with plain objects: no network, no Gemini.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { messageIdFromEvent, toInbound, verifyWebhookSignature } from "../lib/photon";
import { REPLIES, flattenContent, handleInbound, looksLikeBrief, resetSessions, type Chat, type HandlerDeps, type InboundAttachment, type InboundMessage } from "../lib/photon-handler";
import type { Run } from "../lib/schema";
import { UploadRejected } from "../lib/intake";
import { createHmac } from "node:crypto";

type Sent = { kind: "text"; text: string } | { kind: "file"; file: string; name?: string; mimeType?: string };

function fakeChat(spaceId = "spc_1", platform = "telegram", canSendVideo = true) {
  const sent: Sent[] = [];
  const chat: Chat & { sent: Sent[]; typing: number } = {
    spaceId,
    platform,
    canSendVideo,
    sent,
    typing: 0,
    async sendText(text) {
      sent.push({ kind: "text", text });
    },
    async sendFile(file, opts) {
      sent.push({ kind: "file", file, name: opts.name, mimeType: opts.mimeType });
    },
    async setTyping(on) {
      chat.typing += on ? 1 : -1;
    },
  };
  return chat;
}

let n = 0;
const base = (platform: string): Omit<InboundMessage, "content"> => ({
  id: `msg_${++n}`,
  platform,
  status: "received",
  sentBy: { id: "usr_person", handle: "+15551234567" },
  receivedBy: { id: "usr_agent" },
  space: { id: "spc_1", kind: "dm" },
});
function text(t: string, platform = "telegram"): InboundMessage {
  return { ...base(platform), content: { type: "text", format: "plain", text: t } };
}
function clip(id = "att_1", platform = "telegram"): InboundMessage {
  return { ...base(platform), content: { type: "attachment", attachmentId: id } };
}

const attachments: Record<string, InboundAttachment> = {
  att_1: { id: "att_1", name: "IMG_0001.MOV", mimeType: "video/quicktime", size: 1234, read: async () => Buffer.from("not really a video") },
  att_2: { id: "att_2", name: "b.mp4", mimeType: "video/mp4", size: 1234, read: async () => Buffer.from("nope") },
  att_pdf: { id: "att_pdf", name: "notes.pdf", mimeType: "application/pdf", size: 10, read: async () => Buffer.from("pdf") },
};

function doneRun(id = "0123456789", iterations = 1): Run {
  return {
    id,
    brief: "30s recap",
    createdAt: new Date().toISOString(),
    clips: [],
    status: "done",
    error: "",
    warnings: [],
    iterations: Array.from({ length: iterations }, (_, i) => ({
      n: i + 1,
      video: `iter${i + 1}.mp4`,
      edl: { title: "Hack Night", cuts: [], captions: [] } as unknown as Run["iterations"][number]["edl"],
      critique: { summary: "", checks: [{ name: "x", passed: true, at: 0, note: "" }], patches: [] } as unknown as Run["iterations"][number]["critique"],
    })),
  };
}

function deps(over: Partial<HandlerDeps> = {}) {
  const created: { brief: string; files: File[]; opts: unknown }[] = [];
  const revised: { id: string; note: string }[] = [];
  const d: HandlerDeps & { created: typeof created; revised: typeof revised } = {
    created,
    revised,
    createRun: async (brief, files, opts) => {
      created.push({ brief, files, opts });
      return { ...doneRun(), status: "queued", iterations: [] };
    },
    waitForRun: async () => doneRun(),
    loadRun: async (id) => doneRun(id),
    startRevision: (run, note) => {
      revised.push({ id: run.id, note });
    },
    renderFor: async () => ({ file: "/tmp/iter1.mp4", size: 10_000 }),
    resolveAttachment: async (id) => {
      const a = attachments[id];
      if (!a) throw new Error(`no attachment ${id}`);
      return a;
    },
    settleMs: 0,
    log: () => {},
    ...over,
  };
  return d;
}

const tick = () => new Promise((r) => setTimeout(r, 15));

beforeEach(() => resetSessions());
afterEach(() => vi.useRealTimers());

describe("flattenContent", () => {
  it("pulls text and attachment ids out of groups and ignores status parts", () => {
    const out = flattenContent({
      type: "group",
      parts: [
        { type: "text", format: "plain", text: "cut this" },
        { type: "attachment", attachmentId: "att_1" },
        { type: "message.read" },
      ],
    });
    expect(out.texts).toEqual(["cut this"]);
    expect(out.attachmentIds).toEqual(["att_1"]);
    expect(out.other).toEqual(["message.read"]);
  });
});

describe("looksLikeBrief", () => {
  it("treats greetings as not-a-brief and sentences as briefs", () => {
    expect(looksLikeBrief("hi")).toBe(false);
    expect(looksLikeBrief("Hello!")).toBe(false);
    expect(looksLikeBrief("help")).toBe(false);
    expect(looksLikeBrief("30s recap with captions")).toBe(true);
    expect(looksLikeBrief("vertical recap")).toBe(true);
  });
});

describe("toInbound / messageIdFromEvent", () => {
  it("narrows a Beta message and rejects partial objects", () => {
    const m = toInbound({ id: "msg_x", platform: "imessage", status: "received", content: { type: "text", format: "plain", text: "hi" }, sentBy: { id: "u1", handle: "+1555" }, receivedBy: { id: "u2" }, space: { id: "s1", kind: "dm" } });
    expect(m).toMatchObject({ id: "msg_x", platform: "imessage", sentBy: { handle: "+1555" }, receivedBy: { id: "u2" }, space: { id: "s1" } });
    expect(toInbound({ id: "x" })).toBeNull();
  });
  it("finds the message id in the common event layouts and ignores non-message events", () => {
    // Beta 2026-07-01 contract: the Message rides in data.object (see webhooks/event-types/message.received/schema).
    expect(messageIdFromEvent({ id: "evt_0", type: "message.received", data: { object: { id: "msg_0", status: "received" }, projectId: "pho_prj_x" } })).toBe("msg_0");
    expect(messageIdFromEvent({ id: "evt_1", type: "message.received", data: { message: { id: "msg_a" } } })).toBe("msg_a");
    expect(messageIdFromEvent({ id: "evt_2", type: "message.received", data: { messageId: "msg_b" } })).toBe("msg_b");
    expect(messageIdFromEvent({ id: "evt_3", type: "message.received", data: { id: "msg_c", content: {} } })).toBe("msg_c");
    expect(messageIdFromEvent({ id: "evt_4", type: "platform.sending.paused", data: { id: "x" } })).toBeNull();
  });
});

describe("verifyWebhookSignature", () => {
  it("accepts a fresh HMAC and refuses stale or wrong ones", () => {
    const body = JSON.stringify({ id: "evt_1", type: "message.received" });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = `v0=${createHmac("sha256", "whsec").update(`v0:${ts}:${body}`).digest("hex")}`;
    expect(verifyWebhookSignature(body, new Headers({ "x-photon-signature": sig, "x-photon-timestamp": ts }), "whsec")).toEqual({ ok: true });
    expect(verifyWebhookSignature(body, new Headers({ "x-photon-signature": sig, "x-photon-timestamp": ts }), "other").ok).toBe(false);
    const old = String(Math.floor(Date.now() / 1000) - 3600);
    const oldSig = `v0=${createHmac("sha256", "whsec").update(`v0:${old}:${body}`).digest("hex")}`;
    expect(verifyWebhookSignature(body, new Headers({ "x-photon-signature": oldSig, "x-photon-timestamp": old }), "whsec")).toEqual({ ok: false, reason: "stale delivery" });
    expect(verifyWebhookSignature(body, new Headers(), "").ok).toBe(false);
  });
});

describe("handleInbound", () => {
  it("answers a greeting with help and nothing else", async () => {
    const chat = fakeChat();
    await handleInbound(chat, text("hi"), deps());
    expect(chat.sent).toEqual([{ kind: "text", text: REPLIES.help }]);
  });

  it("acknowledges clips and waits for the brief", async () => {
    const chat = fakeChat();
    const d = deps();
    await handleInbound(chat, clip(), d);
    expect(chat.sent).toEqual([{ kind: "text", text: REPLIES.gotClips(1) }]);
    expect(d.created).toHaveLength(0);
  });

  it("cuts once clips and brief are both in, then sends the mp4 and a summary", async () => {
    const chat = fakeChat();
    const d = deps();
    await handleInbound(chat, clip("att_1"), d);
    await handleInbound(chat, clip("att_2"), d);
    await handleInbound(chat, text("30s recap with captions"), d);
    await tick();
    expect(d.created).toHaveLength(1);
    expect(d.created[0].brief).toBe("30s recap with captions");
    expect(d.created[0].files.map((f) => f.name)).toEqual(["IMG_0001.MOV", "b.mp4"]);
    expect(d.created[0].files[1].type).toBe("video/mp4");
    expect(d.created[0].opts).toEqual({ source: "telegram", requester: "+15551234567" });
    // ack clip 1, ack clip 2, "on it", the mp4, the summary
    expect(chat.sent.map((s) => s.kind)).toEqual(["text", "text", "text", "file", "text"]);
    expect((chat.sent[2] as { text: string }).text).toBe(REPLIES.starting(2, "30s recap with captions"));
    expect(chat.sent[3]).toEqual({ kind: "file", file: "/tmp/iter1.mp4", name: "polishedcut-0123456789.mp4", mimeType: "video/mp4" });
    expect((chat.sent[4] as { text: string }).text).toContain('Here\'s "Hack Night"');
    expect(chat.typing).toBe(0);
  });

  it("sends the summary and link, not a file, where the platform cannot carry video (Beta iMessage)", async () => {
    const chat = fakeChat("spc_im", "imessage", false);
    const d = deps();
    await handleInbound(chat, clip("att_1", "imessage"), d);
    await handleInbound(chat, text("recap", "imessage"), d);
    await tick();
    expect(chat.sent.some((s) => s.kind === "file")).toBe(false);
    expect((chat.sent.at(-1) as { text: string }).text).toContain("Here's");
  });

  it("falls back to the link when attaching fails", async () => {
    const chat = fakeChat();
    chat.sendFile = async () => {
      throw new Error("attachment rejected");
    };
    const d = deps();
    await handleInbound(chat, clip(), d);
    await handleInbound(chat, text("recap"), d);
    await tick();
    expect((chat.sent.at(-1) as { text: string }).text).toContain("Here's");
  });

  it("accepts the brief before the clips", async () => {
    const chat = fakeChat();
    const d = deps();
    await handleInbound(chat, text("vertical recap, punchy"), d);
    expect(chat.sent.at(-1)).toEqual({ kind: "text", text: REPLIES.gotBrief });
    await handleInbound(chat, clip(), d);
    await tick();
    expect(d.created).toHaveLength(1);
    expect(d.created[0].brief).toBe("vertical recap, punchy");
  });

  it("turns a follow-up text into a director's note on the delivered cut", async () => {
    const chat = fakeChat();
    const d = deps();
    await handleInbound(chat, clip(), d);
    await handleInbound(chat, text("30s recap"), d);
    await tick();
    chat.sent.length = 0;
    await handleInbound(chat, text("tighter, lose the second shot"), d);
    await tick();
    expect(d.revised).toEqual([{ id: "0123456789", note: "tighter, lose the second shot" }]);
    expect(chat.sent[0]).toEqual({ kind: "text", text: REPLIES.revising("tighter, lose the second shot") });
    expect(chat.sent.some((s) => s.kind === "file")).toBe(true);
  });

  it("relays a rejected upload as a plain sentence", async () => {
    const chat = fakeChat();
    const d = deps({
      createRun: async () => {
        throw new UploadRejected("a.mov is 40:00 long; the limit per clip is 30:00 (MAX_CLIP_SECONDS)");
      },
    });
    await handleInbound(chat, clip(), d);
    await handleInbound(chat, text("recap"), d);
    await tick();
    expect(chat.sent.at(-1)).toEqual({ kind: "text", text: REPLIES.rejected("a.mov is 40:00 long; the limit per clip is 30:00 (MAX_CLIP_SECONDS)") });
    expect(chat.typing).toBe(0);
  });

  it("reports a failed run without attaching anything", async () => {
    const chat = fakeChat();
    const d = deps({ waitForRun: async () => ({ ...doneRun(), status: "error", error: "GEMINI_API_KEY is not set", iterations: [] }) });
    await handleInbound(chat, clip(), d);
    await handleInbound(chat, text("recap"), d);
    await tick();
    expect(chat.sent.at(-1)).toEqual({ kind: "text", text: REPLIES.failed("GEMINI_API_KEY is not set") });
  });

  it("falls back to a link when the render is too large to attach", async () => {
    const chat = fakeChat();
    const d = deps({ renderFor: async () => ({ file: "/tmp/iter1.mp4", size: 10 * 1024 * 1024 * 1024 }) });
    await handleInbound(chat, clip(), d);
    await handleInbound(chat, text("recap"), d);
    await tick();
    expect(chat.sent.some((s) => s.kind === "file")).toBe(false);
    expect((chat.sent.at(-1) as { text: string }).text).toContain("too large");
  });

  it("says it is busy while a cut is in flight and ignores duplicate deliveries", async () => {
    const chat = fakeChat();
    let release!: (r: Run) => void;
    const d = deps({ waitForRun: () => new Promise<Run>((r) => (release = r)) });
    await handleInbound(chat, clip(), d);
    const brief = text("recap");
    await handleInbound(chat, brief, d);
    await tick();
    await handleInbound(chat, brief, d); // same message id again (replay): dropped
    await handleInbound(chat, text("another one"), d);
    expect(chat.sent.at(-1)).toEqual({ kind: "text", text: REPLIES.busy });
    expect(d.created).toHaveLength(1);
    release(doneRun());
    await tick();
    expect(chat.sent.some((s) => s.kind === "file")).toBe(true);
  });

  it("keeps conversations apart and ignores our own dispatched echoes", async () => {
    const a = fakeChat("spc_a");
    const b = fakeChat("spc_b", "whatsapp_business");
    const d = deps();
    await handleInbound(a, clip(), d);
    await handleInbound(b, text("recap"), d);
    await tick();
    expect(d.created).toHaveLength(0);
    await handleInbound(a, { ...text("echo"), status: "dispatched" }, d);
    expect(a.sent).toHaveLength(1);
  });

  it("tells the sender when a non-media attachment arrives", async () => {
    const chat = fakeChat();
    await handleInbound(chat, clip("att_pdf"), deps());
    expect(chat.sent).toEqual([{ kind: "text", text: REPLIES.unsupported }]);
  });
});
