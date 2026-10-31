import { afterEach, describe, expect, it, vi } from "vitest";
import { createGeminiEditor, extractJson, responseSchema } from "../lib/gemini";
import { CritiqueSchema, EdlDraftSchema, RunSchema } from "../lib/schema";

describe("extractJson", () => {
  it("parses fenced JSON", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it("parses prose-wrapped JSON", () => {
    expect(extractJson('Here you go: {"a":{"b":[1,2]}} hope it helps')).toEqual({ a: { b: [1, 2] } });
  });
  it("parses arrays, fenced and wrapped", () => {
    expect(extractJson("[1,2,3]")).toEqual([1, 2, 3]);
    expect(extractJson('Words: [{"text":"hi","start":0,"end":1}] done')).toEqual([{ text: "hi", start: 0, end: 1 }]);
    expect(extractJson("```\n[]\n```")).toEqual([]);
  });
  it("throws on non-JSON", () => {
    expect(() => extractJson("no json here")).toThrow();
  });
});

describe("responseSchema", () => {
  it("CritiqueSchema has no $schema and has properties", () => {
    const s = responseSchema(CritiqueSchema) as { properties: Record<string, unknown> };
    expect(s).not.toHaveProperty("$schema");
    expect(Object.keys(s.properties)).toEqual(expect.arrayContaining(["checks", "patches", "summary"]));
  });
  it("EdlDraftSchema has no $schema and has properties", () => {
    const s = responseSchema(EdlDraftSchema) as { properties: Record<string, unknown>; type: string };
    expect(s).not.toHaveProperty("$schema");
    expect(s.type).toBe("object");
    expect(Object.keys(s.properties)).toEqual(expect.arrayContaining(["title", "cuts", "captions"]));
  });
});

describe("createGeminiEditor", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("throws a clear error with no API key", () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("GEMINI_API_KEY_1", "");
    expect(() => createGeminiEditor()).toThrow(/GEMINI_API_KEY/);
  });
  it("constructs with GEMINI_API_KEY_1 only", () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("GEMINI_API_KEY_1", "fake");
    expect(typeof createGeminiEditor().draft).toBe("function");
  });
  it("accepts an options object with onUsage and builds its own client", () => {
    vi.stubEnv("GEMINI_API_KEY", "fake");
    expect(typeof createGeminiEditor({ onUsage: () => {} }).critique).toBe("function");
  });
});

describe("RunSchema.usage", () => {
  it("defaults cachedTokens and accepts runs without usage", () => {
    const base = { id: "0123456789", brief: "b", createdAt: "2026-01-01T00:00:00Z", clips: [] };
    expect(RunSchema.parse(base).usage).toEqual([]);
    const run = RunSchema.parse({ ...base, usage: [{ model: "gemini-4-argon", inputTokens: 1, outputTokens: 2, ms: 3 }] });
    expect(run.usage?.[0]).toEqual({ model: "gemini-4-argon", inputTokens: 1, outputTokens: 2, cachedTokens: 0, ms: 3 });
  });
});
