import { describe, expect, it } from "vitest";
import { draftPrompt, timelineText } from "../lib/prompts";
import type { EDL, SourceClip } from "../lib/schema";

const base = { width: 1080, height: 1920, fps: 30, overlays: [] };
const cuts = [
  { id: "c1", clipId: "clip1", srcIn: 1, srcOut: 4, reason: "hook" },
  { id: "c2", clipId: "clip2", srcIn: 0.5, srcOut: 2, reason: "end" },
];

describe("timelineText", () => {
  it("offsets cuts by a 2s title card and totals", () => {
    const edl: EDL = { ...base, title: "Hi", cuts, captions: [{ text: "hey", start: 2, end: 3 }] };
    const t = timelineText(edl);
    expect(t).toContain("title card 'Hi': 0.00-2.00");
    expect(t).toContain("c1: output 2.00-5.00 <- clip1 [1.00-4.00]");
    expect(t).toContain("c2: output 5.00-6.50 <- clip2 [0.50-2.00]");
    expect(t).toContain("total duration: 6.50s");
    expect(t).toContain('caption[0] 2.00-3.00: "hey"');
  });
  it("no title starts at 0", () => {
    const t = timelineText({ ...base, title: "", cuts, captions: [] });
    expect(t).not.toContain("title card");
    expect(t).toContain("c1: output 0.00-3.00");
    expect(t).toContain("total duration: 4.50s");
  });
});

describe("draftPrompt", () => {
  it("includes the brief and clip ids", () => {
    const clips: { clip: SourceClip }[] = [
      { clip: { id: "clip1", path: "a.mp4", duration: 10, transcript: [{ text: "hello", start: 0, end: 0.5 }] } },
      { clip: { id: "clip2", path: "b.mp4", duration: 5, transcript: [] } },
    ];
    const p = draftPrompt("Make a 20s teaser", clips);
    expect(p).toContain("Make a 20s teaser");
    expect(p).toContain("clipId=clip1");
    expect(p).toContain("clipId=clip2");
    expect(p).toContain("hello");
  });
});
