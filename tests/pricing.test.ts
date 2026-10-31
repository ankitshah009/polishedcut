import { afterEach, describe, expect, it, vi } from "vitest";

import { assumptions, costPerCut, estimateCost, modeledCutUsage, perModelRates, plans, rateFor } from "../lib/pricing";

afterEach(() => vi.unstubAllEnvs());

describe("estimateCost", () => {
  it("prices Argon at $2/M in and $10/M out", () => {
    const c = estimateCost([{ model: "gemini-4-argon", inputTokens: 1_000_000, outputTokens: 100_000, cachedTokens: 0, ms: 10 }]);
    expect(c.usd).toBeCloseTo(2 + 1, 6);
    expect(c.estimated).toBe(true);
    expect(c.totalTokens).toBe(1_100_000);
    expect(c.byModel["gemini-4-argon"]).toMatchObject({ usd: 3, inputTokens: 1_000_000, outputTokens: 100_000, calls: 1 });
  });

  it("discounts cached input tokens and sums several models", () => {
    const c = estimateCost([
      { model: "gemini-4-argon", inputTokens: 1_000_000, outputTokens: 0, cachedTokens: 1_000_000, ms: 1 },
      { model: "gemini-3.8-flash", inputTokens: 1_000_000, outputTokens: 0, cachedTokens: 0, ms: 1 },
      { model: "files.upload", inputTokens: 0, outputTokens: 0, cachedTokens: 0, ms: 1 },
    ]);
    expect(c.byModel["gemini-4-argon"].usd).toBeCloseTo(2 * 0.25, 6);
    expect(c.byModel["gemini-3.8-flash"].usd).toBeCloseTo(0.5, 6);
    expect(c.byModel["files.upload"].usd).toBe(0);
    expect(c.usd).toBeCloseTo(1.0, 6);
  });

  it("handles empty or missing usage", () => {
    expect(estimateCost([])).toEqual({ usd: 0, byModel: {}, totalTokens: 0, estimated: true });
    expect(estimateCost(undefined).usd).toBe(0);
  });

  it("bills unknown models at the Argon rate and labels them assumed", () => {
    const r = rateFor("gemini-9-mystery");
    expect(r.inputPerM).toBe(2);
    expect(r.source).toBe("assumed");
  });
});

describe("env overrides", () => {
  it("reads PRICE_* at call time", () => {
    vi.stubEnv("PRICE_ARGON_IN_PER_M", "4");
    vi.stubEnv("PRICE_ARGON_OUT_PER_M", "20");
    vi.stubEnv("PRICE_FLASH_IN_PER_M", "1");
    vi.stubEnv("PRICE_CACHED_MULTIPLIER", "0.5");
    expect(perModelRates().argon).toMatchObject({ inputPerM: 4, outputPerM: 20 });
    expect(perModelRates().flash.inputPerM).toBe(1);
    const c = estimateCost([{ model: "gemini-4-argon", inputTokens: 1_000_000, outputTokens: 1_000_000, cachedTokens: 500_000, ms: 1 }]);
    expect(c.usd).toBeCloseTo(0.5 * 4 + 0.5 * 4 * 0.5 + 20, 6);
  });

  it("ignores garbage and negative values", () => {
    vi.stubEnv("PRICE_ARGON_IN_PER_M", "lots");
    vi.stubEnv("PRICE_ARGON_OUT_PER_M", "-3");
    expect(perModelRates().argon).toMatchObject({ inputPerM: 2, outputPerM: 10 });
  });

  it("COST_PER_CUT_USD overrides the modelled cost", () => {
    vi.stubEnv("COST_PER_CUT_USD", "0.5");
    expect(costPerCut()).toBe(0.5);
    expect(plans()[1].apiCostUsd).toBeCloseTo(40 * 0.5, 6);
  });
});

describe("plans", () => {
  it("modelled cut lands around 30-40 cents at hackathon rates", () => {
    const cut = estimateCost(modeledCutUsage()).usd;
    expect(cut).toBeGreaterThan(0.25);
    expect(cut).toBeLessThan(0.45);
    expect(costPerCut()).toBe(cut);
  });

  it("every paid plan has positive margin at full use and exposes per-cut price", () => {
    const all = plans();
    expect(all.map((p) => p.id)).toEqual(["free", "creator", "studio", "payg"]);
    for (const p of all.filter((p) => p.priceUsd > 0)) {
      expect(p.margin).toBeGreaterThan(0);
      expect(p.apiCostUsd).toBeCloseTo(p.cuts * costPerCut(), 4);
      expect(p.perCutUsd).toBeCloseTo(p.priceUsd / p.cuts, 4);
    }
    expect(all[0].margin).toBe(-1); // free tier is pure cost
    expect(all[3].period).toBe("cut");
  });

  it("plan prices and quotas come from env", () => {
    vi.stubEnv("PLAN_CREATOR_USD", "29");
    vi.stubEnv("PLAN_CREATOR_CUTS", "100");
    vi.stubEnv("PLAN_PAYG_USD", "1.49");
    const [, creator, , payg] = plans();
    expect(creator).toMatchObject({ priceUsd: 29, cuts: 100 });
    expect(payg.priceUsd).toBe(1.49);
  });

  it("assumptions label everything as an estimate and link billing", () => {
    const text = assumptions().join("\n");
    expect(text).toMatch(/estimate/i);
    expect(text).toContain("aistudio.google.com/billing");
    expect(text).toContain("402");
  });
});
