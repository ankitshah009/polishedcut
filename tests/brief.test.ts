import { describe, expect, it, vi } from "vitest";

import { analyzeBrief, briefAnalysisLine, briefPrompt, BRIEF_MODEL, type BriefAnalysis } from "../lib/brief";

function client(reply: (params: Record<string, unknown>) => Promise<unknown>) {
  const create = vi.fn(reply);
  return { ai: { interactions: { create } } as never, create };
}

const good: BriefAnalysis = { targetSeconds: 45, tone: "upbeat", wantsCaptions: true, wantsMusic: true, musicMood: "bright synth pop" };

describe("analyzeBrief", () => {
  it("asks flash-lite for structured JSON with store:false and returns the parsed analysis", async () => {
    const { ai, create } = client(async () => ({ output_text: JSON.stringify(good) }));
    const out = await analyzeBrief("45 second upbeat recap with music", ai);
    expect(out).toEqual(good);
    expect(create).toHaveBeenCalledTimes(1);
    const params = create.mock.calls[0][0] as Record<string, unknown>;
    expect(params.model).toBe(BRIEF_MODEL);
    expect(params.store).toBe(false);
    expect(params.input).toBe(briefPrompt("45 second upbeat recap with music"));
    const rf = params.response_format as { type: string; mime_type: string; schema: Record<string, unknown> };
    expect(rf.type).toBe("text");
    expect(rf.mime_type).toBe("application/json");
    expect(rf.schema.type).toBe("object");
  });

  it("tolerates fenced JSON, rounds the target and clears musicMood when music is unwanted", async () => {
    const reply = { ...good, targetSeconds: 29.6, wantsMusic: false, musicMood: "ignored" };
    const { ai } = client(async () => ({ output_text: "```json\n" + JSON.stringify(reply) + "\n```" }));
    const out = await analyzeBrief("a brief", ai);
    expect(out?.targetSeconds).toBe(30);
    expect(out?.musicMood).toBe("");
  });

  it("falls back to a plain prompt when the server rejects response_format", async () => {
    const { ai, create } = client(async (p) => {
      if (p.response_format) throw Object.assign(new Error("response_format schema not supported"), { status: 400 });
      return { output_text: JSON.stringify(good) };
    });
    expect(await analyzeBrief("a brief", ai)).toEqual(good);
    expect(create).toHaveBeenCalledTimes(2);
    expect((create.mock.calls[1][0] as Record<string, unknown>).response_format).toBeUndefined();
  });

  it("returns null on invalid JSON, on API errors and on an empty brief", async () => {
    expect(await analyzeBrief("a brief", client(async () => ({ output_text: "not json" })).ai)).toBeNull();
    expect(await analyzeBrief("a brief", client(async () => ({ output_text: '{"tone": 3}' })).ai)).toBeNull();
    const down = client(async () => { throw Object.assign(new Error("forbidden"), { status: 403 }); });
    expect(await analyzeBrief("a brief", down.ai)).toBeNull();
    const idle = client(async () => ({ output_text: JSON.stringify(good) }));
    expect(await analyzeBrief("   ", idle.ai)).toBeNull();
    expect(idle.create).not.toHaveBeenCalled();
  });
});

describe("briefAnalysisLine", () => {
  it("renders target, tone and music mood", () => {
    expect(briefAnalysisLine(good)).toBe("Brief analysis: target 45s; tone: upbeat; music mood: bright synth pop");
  });

  it("says when there is no target, no music and no captions", () => {
    const line = briefAnalysisLine({ targetSeconds: null, tone: "", wantsCaptions: false, wantsMusic: false, musicMood: "" });
    expect(line).toBe("Brief analysis: no target length given (keep it tight); no music; no captions");
  });
});
