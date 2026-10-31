import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Run, RunStatus } from "../lib/schema";

let tmp: string;
let store: typeof import("../lib/store");

beforeAll(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "store-test-"));
  process.env.RUNS_DIR = tmp;
  vi.resetModules();
  const config = await import("../lib/config");
  expect(config.RUNS_DIR).toBe(path.resolve(tmp));
  store = await import("../lib/store");
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Write a run.json on disk whose mtime is `ageMs` in the past. */
function writeRun(id: string, status: RunStatus, ageMs: number, createdAt: string): Run {
  const run: Run = { id, brief: "b", createdAt, clips: [], iterations: [], status, error: "", warnings: [] };
  const dir = path.join(tmp, id);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "run.json");
  writeFileSync(file, JSON.stringify(run));
  const t = (Date.now() - ageMs) / 1000;
  utimesSync(file, t, t);
  return run;
}

const onDisk = (id: string) => JSON.parse(readFileSync(path.join(tmp, id, "run.json"), "utf8")) as Run;

const STALE = 5 * 60_000;

describe("ORPHAN_AFTER_MS", () => {
  it("is the configured value re-exported from lib/config", async () => {
    const config = await import("../lib/config");
    expect(store.ORPHAN_AFTER_MS).toBe(config.ORPHAN_AFTER_MS);
    expect(store.ORPHAN_AFTER_MS).toBe(90_000);
  });
});

describe("active set", () => {
  it("isRunning follows markActive / markInactive", () => {
    expect(store.isRunning("a000000000")).toBe(false);
    store.markActive("a000000000");
    expect(store.isRunning("a000000000")).toBe(true);
    store.markInactive("a000000000");
    expect(store.isRunning("a000000000")).toBe(false);
  });
});

describe("orphan sweep", () => {
  it("marks an old in-progress run that nothing is driving as interrupted", async () => {
    writeRun("a000000001", "drafting", STALE, "2026-01-01T00:00:01.000Z");
    const run = await store.loadRun("a000000001");
    expect(run?.status).toBe("error");
    expect(run?.error).toBe(store.INTERRUPTED_ERROR);
    expect(run?.error).toMatch(/Interrupted: the server restarted/);
    expect(onDisk("a000000001").status).toBe("error");
  });

  it("leaves a fresh in-progress run alone", async () => {
    writeRun("a000000002", "rendering", 0, "2026-01-01T00:00:02.000Z");
    const run = await store.loadRun("a000000002");
    expect(run?.status).toBe("rendering");
    expect(run?.error).toBe("");
    expect(onDisk("a000000002").status).toBe("rendering");
  });

  it("leaves an old run alone while it is active, then sweeps it once released", async () => {
    writeRun("a000000003", "critiquing", STALE, "2026-01-01T00:00:03.000Z");
    store.markActive("a000000003");
    expect((await store.loadRun("a000000003"))?.status).toBe("critiquing");
    store.markInactive("a000000003");
    expect((await store.loadRun("a000000003"))?.status).toBe("error");
  });

  it("never touches terminal runs", async () => {
    writeRun("a000000004", "done", STALE, "2026-01-01T00:00:04.000Z");
    expect((await store.loadRun("a000000004"))?.status).toBe("done");
    writeRun("a000000005", "error", STALE, "2026-01-01T00:00:05.000Z");
    const run = await store.loadRun("a000000005");
    expect(run?.status).toBe("error");
    expect(run?.error).toBe("");
  });

  it("sweeps an in-progress run whose source clip is gone, however fresh", async () => {
    const run = writeRun("a000000007", "drafting", 0, "2026-01-01T00:00:07.000Z");
    run.clips.push({ id: "clip1", path: "src/missing.mp4", duration: 0, transcript: [] });
    writeFileSync(path.join(tmp, run.id, "run.json"), JSON.stringify(run));
    const loaded = await store.loadRun(run.id);
    expect(loaded?.status).toBe("error");
    expect(loaded?.error).toBe(store.MISSING_SOURCE_ERROR);
  });

  it("does not sweep while sweeps are held (boot resume window), and sweeps once released", async () => {
    writeRun("a000000008", "queued", STALE, "2026-01-01T00:00:08.000Z");
    const release = store.holdSweeps();
    expect((await store.loadRun("a000000008"))?.status).toBe("queued");
    expect((await store.listRuns()).find((r) => r.id === "a000000008")?.status).toBe("queued");
    expect(onDisk("a000000008").status).toBe("queued");
    release();
    release(); // idempotent
    expect((await store.loadRun("a000000008"))?.status).toBe("error");
  });

  it("loadRun/listRuns with sweep:false read runs exactly as stored", async () => {
    writeRun("a000000009", "rendering", STALE, "2026-01-01T00:00:09.000Z");
    expect((await store.loadRun("a000000009", { sweep: false }))?.status).toBe("rendering");
    expect((await store.listRuns({ sweep: false })).find((r) => r.id === "a000000009")?.status).toBe("rendering");
    expect(onDisk("a000000009").status).toBe("rendering");
    expect((await store.loadRun("a000000009"))?.status).toBe("error");
  });

  it("listRuns sweeps too and keeps newest-first order", async () => {
    writeRun("a00000000f", "queued", STALE, "2026-01-01T00:00:15.000Z");
    const runs = await store.listRuns();
    const ids = runs.map((r) => r.id);
    expect(ids[0]).toBe("a00000000f");
    expect(ids).toEqual([...ids].sort().reverse());
    expect(runs.find((r) => r.id === "a00000000f")?.status).toBe("error");
    expect(runs.find((r) => r.id === "a000000002")?.status).toBe("rendering");
  });
});
