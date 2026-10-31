// The chat adapter's conversation logic, driven with plain objects: no Spectrum SDK, no Gemini, no network.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Run } from "../lib/schema";
import { REPLIES, flattenContent, handleInbound, looksLikeBrief, resetSessions, type HandlerDeps } from "../lib/spectrum-handler";
import { UploadRejected } from "../lib/intake";

type Sent = { kind: "text"; text: string } | { kind: "attachment"; file: string; name?: string };

function fakeSpace(id = "chat1", platform = "imessage") {
  const sent: Sent[] = [];
  const space = {
    id,
    __platform: platform,
    sent,
    typing: 0,
    async send(content: unknown) {
      if (typeof content === "string") sent.push({ kind: "text", text: content });
      else sent.push(content as Sent);
      return undefined;
    },
    async startTyping() {
      this.typing++;
    },
    async stopTyping() {
      this.typing--;
    },
  };
  return space;
}

let n = 0;
function text(t: string, platform = "imessage") {
  return { id: `m${++n}`, platform, direction: "inbound" as const, sender: { id: "+15551234567", __platform: platform }, content: { type: "text" as const, text: t } };
}
function clip(name = "IMG_0001.MOV", mimeType = "video/quicktime", platform = "imessage") {
  return {
    id: `m${++n}`,
    platform,
    direction: "inbound" as const,
    sender: { id: "+15551234567", __platform: platform },
    content: {
      type: "attachment" as const,
      id: `a${n}`,
      name,
      mimeType,
      size: 1234,
      read: async () => Buffer.from("not really a video"),
      stream: async () => new ReadableStream<Uint8Array>(),
    },
  };
}

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
    settleMs: 0,
    log: () => {},
    ...over,
  };
  return d;
}

const builders = { attachment: (file: string | Buffer, options?: { name?: string }) => ({ kind: "attachment", file: String(file), name: options?.name }) };
const tick = () => new Promise((r) => setTimeout(r, 15));

beforeEach(() => resetSessions());
afterEach(() => vi.useRealTimers());

describe("flattenContent", () => {
  it("pulls text and attachments out of groups and replies", () => {
    const att = clip().content;
    const group = { type: "group" as const, items: [{ content: { type: "text", text: "cut this" } }, { content: att }] } as unknown as Parameters<typeof flattenContent>[0];
    const out = flattenContent(group);
    expect(out.texts).toEqual(["cut this"]);
    expect(out.attachments).toHaveLength(1);
    const reply = { type: "reply" as const, content: { type: "text", text: "shorter" }, target: undefined } as unknown as Parameters<typeof flattenContent>[0];
    expect(flattenContent(reply).texts).toEqual(["shorter"]);
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

describe("handleInbound", () => {
  it("answers a greeting with help and nothing else", async () => {
    const space = fakeSpace();
    await handleInbound(space, text("hi"), deps(), builders);
    expect(space.sent).toEqual([{ kind: "text", text: REPLIES.help }]);
  });

  it("acknowledges clips and waits for the brief", async () => {
    const space = fakeSpace();
    const d = deps();
    await handleInbound(space, clip(), d, builders);
    expect(space.sent).toEqual([{ kind: "text", text: REPLIES.gotClips(1) }]);
    expect(d.created).toHaveLength(0);
  });

  it("cuts once clips and brief are both in, then sends the mp4 and a summary", async () => {
    const space = fakeSpace();
    const d = deps();
    await handleInbound(space, clip("a.mov"), d, builders);
    await handleInbound(space, clip("b.mp4", "video/mp4"), d, builders);
    await handleInbound(space, text("30s recap with captions"), d, builders);
    await tick();
    expect(d.created).toHaveLength(1);
    expect(d.created[0].brief).toBe("30s recap with captions");
    expect(d.created[0].files.map((f) => f.name)).toEqual(["a.mov", "b.mp4"]);
    expect(d.created[0].files[1].type).toBe("video/mp4");
    expect(d.created[0].opts).toEqual({ source: "imessage", requester: "+15551234567" });
    // ack clip 1, ack clip 2, "on it", the mp4, the summary
    const kinds = space.sent.map((s) => s.kind);
    expect(kinds).toEqual(["text", "text", "text", "attachment", "text"]);
    expect((space.sent[2] as { text: string }).text).toBe(REPLIES.starting(2, "30s recap with captions"));
    expect(space.sent[3]).toEqual({ kind: "attachment", file: "/tmp/iter1.mp4", name: "framecut-0123456789.mp4" });
    expect((space.sent[4] as { text: string }).text).toContain('Here\'s "Hack Night"');
    expect(space.typing).toBe(0);
  });

  it("accepts the brief before the clips", async () => {
    const space = fakeSpace();
    const d = deps();
    await handleInbound(space, text("vertical recap, punchy"), d, builders);
    expect(space.sent.at(-1)).toEqual({ kind: "text", text: REPLIES.gotBrief });
    await handleInbound(space, clip(), d, builders);
    await tick();
    expect(d.created).toHaveLength(1);
    expect(d.created[0].brief).toBe("vertical recap, punchy");
  });

  it("turns a follow-up text into a director's note on the delivered cut", async () => {
    const space = fakeSpace();
    const d = deps();
    await handleInbound(space, clip(), d, builders);
    await handleInbound(space, text("30s recap"), d, builders);
    await tick();
    space.sent.length = 0;
    await handleInbound(space, text("tighter, lose the second shot"), d, builders);
    await tick();
    expect(d.revised).toEqual([{ id: "0123456789", note: "tighter, lose the second shot" }]);
    expect(space.sent[0]).toEqual({ kind: "text", text: REPLIES.revising("tighter, lose the second shot") });
    expect(space.sent.some((s) => s.kind === "attachment")).toBe(true);
  });

  it("relays a rejected upload as a plain sentence", async () => {
    const space = fakeSpace();
    const d = deps({
      createRun: async () => {
        throw new UploadRejected("a.mov is 40:00 long; the limit per clip is 30:00 (MAX_CLIP_SECONDS)");
      },
    });
    await handleInbound(space, clip("a.mov"), d, builders);
    await handleInbound(space, text("recap"), d, builders);
    await tick();
    expect(space.sent.at(-1)).toEqual({ kind: "text", text: REPLIES.rejected("a.mov is 40:00 long; the limit per clip is 30:00 (MAX_CLIP_SECONDS)") });
    expect(space.typing).toBe(0);
  });

  it("reports a failed run without attaching anything", async () => {
    const space = fakeSpace();
    const d = deps({ waitForRun: async () => ({ ...doneRun(), status: "error", error: "GEMINI_API_KEY is not set", iterations: [] }) });
    await handleInbound(space, clip(), d, builders);
    await handleInbound(space, text("recap"), d, builders);
    await tick();
    expect(space.sent.at(-1)).toEqual({ kind: "text", text: REPLIES.failed("GEMINI_API_KEY is not set") });
  });

  it("falls back to a link when the render is too large to attach", async () => {
    const space = fakeSpace();
    const d = deps({ renderFor: async () => ({ file: "/tmp/iter1.mp4", size: 10 * 1024 * 1024 * 1024 }) });
    await handleInbound(space, clip(), d, builders);
    await handleInbound(space, text("recap"), d, builders);
    await tick();
    expect(space.sent.some((s) => s.kind === "attachment")).toBe(false);
    expect((space.sent.at(-1) as { text: string }).text).toContain("too large");
  });

  it("says it is busy while a cut is in flight and ignores duplicate deliveries", async () => {
    const space = fakeSpace();
    let release!: (r: Run) => void;
    const d = deps({ waitForRun: () => new Promise<Run>((r) => (release = r)) });
    await handleInbound(space, clip(), d, builders);
    const brief = text("recap");
    await handleInbound(space, brief, d, builders);
    await tick();
    await handleInbound(space, brief, d, builders); // same message id again: dropped
    await handleInbound(space, text("another one"), d, builders);
    expect(space.sent.at(-1)).toEqual({ kind: "text", text: REPLIES.busy });
    expect(d.created).toHaveLength(1);
    release(doneRun());
    await tick();
    expect(space.sent.some((s) => s.kind === "attachment")).toBe(true);
  });

  it("keeps conversations apart and ignores outbound echoes", async () => {
    const a = fakeSpace("a");
    const b = fakeSpace("b", "telegram");
    const d = deps();
    await handleInbound(a, clip(), d, builders);
    await handleInbound(b, text("recap"), d, builders);
    await tick();
    expect(d.created).toHaveLength(0);
    await handleInbound(a, { ...text("echo"), direction: "outbound" }, d, builders);
    expect(a.sent).toHaveLength(1);
  });

  it("tells the sender when a non-media attachment arrives", async () => {
    const space = fakeSpace();
    await handleInbound(space, clip("notes.pdf", "application/pdf"), deps(), builders);
    expect(space.sent).toEqual([{ kind: "text", text: REPLIES.unsupported }]);
  });
});
