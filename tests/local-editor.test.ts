import { describe, expect, it } from "vitest";

import { planCut } from "../lib/local-editor";
import type { Word } from "../lib/schema";

const size = { width: 1920, height: 1080, fps: 30 };

function speech(text: string, from = 0, step = 0.4): Word[] {
  return text.split(" ").map((t, i) => ({ text: t, start: from + i * step, end: from + (i + 1) * step - 0.05 }));
}

const clips = [{ id: "clip1", duration: 20, words: speech("robots can see but they cannot remember what they saw a moment ago"), fallback: [] as [number, number][] }];

describe("local editor planCut captions", () => {
  it.each(["Add captions.", "add caption", "with subtitles", "Subtitled please", "CAPTIONS on"])("builds captions for brief %j", (brief) => {
    const plan = planCut(`Cut a 10-second teaser. ${brief}`, clips, size);
    expect(plan.edl.cuts.length).toBeGreaterThan(0);
    expect(plan.edl.captions.length).toBeGreaterThan(0);
  });

  it("leaves captions off when the brief never asks", () => {
    const plan = planCut("Cut a 10-second teaser.", clips, size);
    expect(plan.edl.captions).toEqual([]);
  });
});
