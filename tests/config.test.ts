import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * lib/config reads the environment at import time, so each case sets variables, resets the module
 * registry and imports a fresh copy. Keys are restored afterwards so other test files see their own env.
 */
const KEYS = [
  "RUNS_DIR", "DEMO_DIR", "DEMO_BRIEF", "MAX_ITERATIONS", "MAX_UPLOAD_BYTES", "BRIEF_MAX_CHARS",
  "NOTE_MAX_CHARS", "OUTPUT_WIDTH", "OUTPUT_HEIGHT", "OUTPUT_FPS", "MIN_CUT_SECONDS", "PHOTO_SECONDS",
  "SSE_HEARTBEAT_MS", "LLM_TIMEOUT_MS", "PROXY_HEIGHT", "REVISE_MAX_ITERATIONS", "EXEC_MAX_BUFFER",
  "ARGON_MODEL", "FLASH_MODEL", "TRANSCRIBE_MODEL",
  "PROXY_LONG_EDGE", "PROXY_FPS", "MAX_CLIP_SECONDS", "MAX_TOTAL_SECONDS", "GEMINI_CONCURRENCY", "KEEP_UPLOADS", "ORPHAN_AFTER_MS",
  "FRAME_ANALYSIS", "NEBULA_FRAME_WEBHOOK_URL", "NEBULA_FRAME_WEBHOOK_SECRET", "NEBULA_FRAME_RETRIES", "NEBULA_FRAME_BACKOFF_MS",
  "NEBULA_FRAME_TIMEOUT_MS", "PUBLIC_URL", "NEXT_PUBLIC_URL",
];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

async function fresh(env: Record<string, string | undefined>) {
  for (const k of KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
  vi.resetModules();
  return import("../lib/config");
}

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.resetModules();
});

describe("config defaults", () => {
  it("resolves paths and uses the documented defaults when nothing is set", async () => {
    const c = await fresh({});
    expect(c.RUNS_DIR).toBe(path.resolve("runs"));
    expect(c.DEMO_DIR).toBe(path.resolve("footage/demo"));
    expect(c.DEMO_BRIEF_ENV).toBe("");
    expect(c.DEFAULT_DEMO_BRIEF).toMatch(/Lumen/);
    expect(c.MODELS).toEqual({ argon: "gemini-4-argon", flash: "gemini-3.8-flash", transcribe: "gemini-3.5-transcribe", argonFallback: "" });
    expect(c.OUTPUT).toEqual({ width: 1280, height: 720, fps: 30 });
    expect(c.MAX_ITERATIONS).toBe(3);
    expect(c.REVISE_MAX_ITERATIONS).toBe(2);
    expect(c.MIN_CUT_SECONDS).toBe(0.3);
    expect(c.PROXY_HEIGHT).toBe(480);
    expect(c.PHOTO_SECONDS).toBe(4);
    expect(c.MAX_UPLOAD_BYTES).toBe(2 * 1024 * 1024 * 1024);
    expect(c.BRIEF_MAX_CHARS).toBe(2000);
    expect(c.NOTE_MAX_CHARS).toBe(500);
    expect(c.SSE_HEARTBEAT_MS).toBe(15_000);
    expect(c.LLM_TIMEOUT_MS).toBe(15 * 60 * 1000);
    expect(c.TITLE_SECONDS).toBe(2);
    expect(c.PROXY_LONG_EDGE).toBe(854);
    expect(c.PROXY_FPS).toBe(30);
    expect(c.MAX_CLIP_SECONDS).toBe(1800);
    expect(c.MAX_TOTAL_SECONDS).toBe(7200);
    expect(c.GEMINI_CONCURRENCY).toBe(4);
    expect(c.KEEP_UPLOADS).toBe(false);
    expect(c.ORPHAN_AFTER_MS).toBe(90_000);
    expect(c.OUTPUT_PRESETS).toEqual({
      landscape: { width: 1920, height: 1080 },
      portrait: { width: 1080, height: 1920 },
      square: { width: 1080, height: 1080 },
      uhd: { width: 3840, height: 2160 },
    });
  });

  it("reads the scaling knobs from the environment and validates them", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      let c = await fresh({
        PROXY_LONG_EDGE: "1280",
        MAX_CLIP_SECONDS: "600.5",
        MAX_TOTAL_SECONDS: "3600",
        GEMINI_CONCURRENCY: "2",
        KEEP_UPLOADS: "1",
        ORPHAN_AFTER_MS: "30000",
      });
      expect(c.PROXY_LONG_EDGE).toBe(1280);
      expect(c.MAX_CLIP_SECONDS).toBe(600.5);
      expect(c.MAX_TOTAL_SECONDS).toBe(3600);
      expect(c.GEMINI_CONCURRENCY).toBe(2);
      expect(c.KEEP_UPLOADS).toBe(true);
      expect(c.ORPHAN_AFTER_MS).toBe(30_000);
      expect(warn).not.toHaveBeenCalled();

      c = await fresh({ PROXY_LONG_EDGE: "100", GEMINI_CONCURRENCY: "0", MAX_CLIP_SECONDS: "-5", ORPHAN_AFTER_MS: "10", KEEP_UPLOADS: "no" });
      expect(c.PROXY_LONG_EDGE).toBe(854);
      expect(c.GEMINI_CONCURRENCY).toBe(4);
      expect(c.MAX_CLIP_SECONDS).toBe(1800);
      expect(c.ORPHAN_AFTER_MS).toBe(90_000);
      expect(c.KEEP_UPLOADS).toBe(false);
      expect(warn).toHaveBeenCalledTimes(4);
      for (const yes of ["true", "YES", "on"]) expect((await fresh({ KEEP_UPLOADS: yes })).KEEP_UPLOADS).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("honours environment overrides", async () => {
    const c = await fresh({
      RUNS_DIR: "/tmp/argon-runs",
      DEMO_DIR: "/tmp/demo",
      DEMO_BRIEF: "  ten second teaser  ",
      ARGON_MODEL: "gemini-4-argon-exp",
      MAX_ITERATIONS: "5",
      MAX_UPLOAD_BYTES: "1048576",
      BRIEF_MAX_CHARS: "100",
      NOTE_MAX_CHARS: "42",
      OUTPUT_WIDTH: "1920",
      OUTPUT_HEIGHT: "1080",
      OUTPUT_FPS: "25",
      MIN_CUT_SECONDS: "0.5",
      PHOTO_SECONDS: "2.5",
      SSE_HEARTBEAT_MS: "5000",
    });
    expect(c.RUNS_DIR).toBe(path.resolve("/tmp/argon-runs"));
    expect(c.DEMO_DIR).toBe(path.resolve("/tmp/demo"));
    expect(c.DEMO_BRIEF_ENV).toBe("ten second teaser");
    expect(c.MODELS.argon).toBe("gemini-4-argon-exp");
    expect(c.MAX_ITERATIONS).toBe(5);
    expect(c.MAX_UPLOAD_BYTES).toBe(1048576);
    expect(c.BRIEF_MAX_CHARS).toBe(100);
    expect(c.NOTE_MAX_CHARS).toBe(42);
    expect(c.OUTPUT).toEqual({ width: 1920, height: 1080, fps: 25 });
    expect(c.MIN_CUT_SECONDS).toBe(0.5);
    expect(c.PHOTO_SECONDS).toBe(2.5);
    expect(c.SSE_HEARTBEAT_MS).toBe(5000);
  });

  it("falls back to the default (with a warning) on garbage, non-integers and out-of-range values", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const c = await fresh({ MAX_ITERATIONS: "many", MAX_UPLOAD_BYTES: "1.5", SSE_HEARTBEAT_MS: "10", OUTPUT_FPS: "0" });
      expect(c.MAX_ITERATIONS).toBe(3);
      expect(c.MAX_UPLOAD_BYTES).toBe(2 * 1024 * 1024 * 1024);
      expect(c.SSE_HEARTBEAT_MS).toBe(15_000);
      expect(c.OUTPUT.fps).toBe(30);
      expect(warn).toHaveBeenCalledTimes(4);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("frame analyst config", () => {
  const complete = {
    FRAME_ANALYSIS: "nebula",
    NEBULA_FRAME_WEBHOOK_URL: "https://api.nebula.gg/webhooks/triggers/abc/webhook",
    NEBULA_FRAME_WEBHOOK_SECRET: "s3cret",
    PUBLIC_URL: "https://polishedcut.example",
  };

  it("has nothing to check under the local analysis, even with a broken webhook URL lying around", async () => {
    let c = await fresh({});
    expect(c.FRAME_ANALYSIS).toBe("local");
    expect(c.frameAnalystConfigProblems()).toEqual([]);
    expect(() => c.validateFrameAnalystConfig()).not.toThrow();
    c = await fresh({ FRAME_ANALYSIS: "local", NEBULA_FRAME_WEBHOOK_URL: "http://nope" });
    expect(() => c.validateFrameAnalystConfig()).not.toThrow();
  });

  it("reads the retry knobs with their defaults and overrides", async () => {
    let c = await fresh({});
    expect(c.FRAME_ANALYST_RETRIES).toBe(3);
    expect(c.FRAME_ANALYST_BACKOFF_MS).toBe(1000);
    c = await fresh({ NEBULA_FRAME_RETRIES: "0", NEBULA_FRAME_BACKOFF_MS: "250" });
    expect(c.FRAME_ANALYST_RETRIES).toBe(0);
    expect(c.FRAME_ANALYST_BACKOFF_MS).toBe(250);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    c = await fresh({ NEBULA_FRAME_RETRIES: "-1", NEBULA_FRAME_BACKOFF_MS: "soon" });
    expect(c.FRAME_ANALYST_RETRIES).toBe(3);
    expect(c.FRAME_ANALYST_BACKOFF_MS).toBe(1000);
    warn.mockRestore();
  });

  it("fails loudly when FRAME_ANALYSIS=nebula has no URL, secret or PUBLIC_URL", async () => {
    const c = await fresh({ FRAME_ANALYSIS: "nebula" });
    const problems = c.frameAnalystConfigProblems();
    expect(problems).toHaveLength(3);
    expect(problems[0]).toMatch(/NEBULA_FRAME_WEBHOOK_URL is not set/);
    expect(problems[1]).toMatch(/NEBULA_FRAME_WEBHOOK_SECRET is not set/);
    expect(problems[2]).toMatch(/PUBLIC_URL is not set/);
    let err: unknown;
    try {
      c.validateFrameAnalystConfig();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as { name: string }).name).toBe("FrameAnalystError");
    expect((err as { kind: string }).kind).toBe("config");
    expect((err as Error).message).toMatch(/^FRAME_ANALYSIS=nebula but the Frame Analyst webhook is not fully configured: NEBULA_FRAME_WEBHOOK_URL is not set; NEBULA_FRAME_WEBHOOK_SECRET is not set.*; PUBLIC_URL is not set.*FRAME_ANALYSIS=local/);
  });

  it("applies when the webhook URL alone selects nebula, and names each missing piece", async () => {
    const c = await fresh({ NEBULA_FRAME_WEBHOOK_URL: complete.NEBULA_FRAME_WEBHOOK_URL, PUBLIC_URL: complete.PUBLIC_URL });
    expect(c.FRAME_ANALYSIS).toBe("nebula");
    expect(c.frameAnalystConfigProblems()).toEqual([expect.stringMatching(/NEBULA_FRAME_WEBHOOK_SECRET is not set/)]);
    expect(() => c.validateFrameAnalystConfig()).toThrow(/NEBULA_FRAME_WEBHOOK_SECRET/);
  });

  it("insists on https for the webhook URL and PUBLIC_URL, and on them being URLs at all", async () => {
    let c = await fresh({ ...complete, NEBULA_FRAME_WEBHOOK_URL: "http://api.nebula.gg/webhooks/triggers/abc/webhook" });
    expect(c.frameAnalystConfigProblems()).toEqual([expect.stringMatching(/NEBULA_FRAME_WEBHOOK_URL must be https \(got http\)/)]);
    c = await fresh({ ...complete, PUBLIC_URL: "http://localhost:3000" });
    expect(c.frameAnalystConfigProblems()).toEqual([expect.stringMatching(/PUBLIC_URL must be https.*\(got http\)/)]);
    c = await fresh({ ...complete, NEBULA_FRAME_WEBHOOK_URL: "not a url", PUBLIC_URL: "also not" });
    expect(c.frameAnalystConfigProblems()).toEqual([expect.stringMatching(/NEBULA_FRAME_WEBHOOK_URL is not a valid URL/), expect.stringMatching(/PUBLIC_URL is not a valid URL/)]);
  });

  it("passes a complete configuration (NEXT_PUBLIC_URL standing in for PUBLIC_URL)", async () => {
    let c = await fresh(complete);
    expect(c.frameAnalystConfigProblems()).toEqual([]);
    expect(() => c.validateFrameAnalystConfig()).not.toThrow();
    c = await fresh({ ...complete, PUBLIC_URL: undefined, NEXT_PUBLIC_URL: "https://polishedcut.example/" });
    expect(c.PUBLIC_URL).toBe("https://polishedcut.example");
    expect(() => c.validateFrameAnalystConfig()).not.toThrow();
  });
});

describe("config helpers", () => {
  it("runDir only accepts generated ids and never leaves RUNS_DIR", async () => {
    const c = await fresh({ RUNS_DIR: "/tmp/argon-runs" });
    expect(c.isRunId("0123456789")).toBe(true);
    expect(c.isRunId("abcdef0123")).toBe(true);
    expect(c.runDir("abcdef0123")).toBe(path.join(path.resolve("/tmp/argon-runs"), "abcdef0123"));
    for (const bad of ["", "..", "../x", "ABCDEF0123", "abcdef01234", "abcdef012", "abcdefg123", "a/bcdef0123"]) {
      expect(c.isRunId(bad), bad).toBe(false);
      expect(() => c.runDir(bad), bad).toThrow(/invalid run id/);
    }
  });

  it("safeName strips directories and hostile characters", async () => {
    const c = await fresh({});
    expect(c.safeName("../../etc/passwd")).toBe("passwd");
    expect(c.safeName("my clip (final) #2.MOV")).toBe("my_clip__final___2.MOV");
    expect(c.safeName("ünïcode.mp4")).toBe("_n_code.mp4"); // each non-ASCII character becomes "_"
    expect(c.safeName("")).toBe("clip.mp4");
    expect(c.safeName("/", "photo.jpg")).toBe("photo.jpg");
  });

  it("isVideoName matches the extensions the upload route accepts", async () => {
    const c = await fresh({});
    for (const ok of ["a.mp4", "B.MOV", "c.webm", "d.mkv", "e.m4v"]) expect(c.isVideoName(ok), ok).toBe(true);
    for (const no of ["a.mp3", "b.jpg", "c.heic", "mp4", "d.mp4.txt"]) expect(c.isVideoName(no), no).toBe(false);
  });
});
