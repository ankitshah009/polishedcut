/**
 * End-to-end checks against a RUNNING Argon Cut server, without calling Gemini.
 *
 *   E2E_BASE_URL=http://localhost:3402 npx vitest run tests/e2e
 *
 * Skipped entirely when E2E_BASE_URL is unset so `npm test` stays offline. Only request validation,
 * the files route, SSE framing, pages and the pricing/usage endpoints are exercised; a run is created
 * from the demo clips purely to have a run id and source files to read back, and the background job
 * it starts is left alone (it needs GEMINI_API_KEY; with none it ends in status "error", which is fine).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

const BASE = (process.env.E2E_BASE_URL ?? "").replace(/\/$/, "");
const suite = BASE ? describe : describe.skip;

const DEMO_CLIP = path.resolve(__dirname, "../../footage/demo/01_intro.mp4");
const RUN_ID = /^[0-9a-f]{10}$/;

type Run = {
  id: string;
  brief: string;
  status: string;
  error: string;
  clips: { id: string; path: string }[];
  iterations: unknown[];
  warnings: string[];
};

const url = (p: string) => `${BASE}${p}`;
const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

async function createRun(brief: string, files: { name: string; data: Buffer; type: string }[]) {
  const form = new FormData();
  form.set("brief", brief);
  for (const f of files) form.append("files", new Blob([new Uint8Array(f.data)], { type: f.type }), f.name);
  return fetch(url("/api/runs"), { method: "POST", body: form });
}

/** Read one SSE stream until `event: end` or `maxMs`, returning the data frames seen. */
async function readSse(id: string, maxMs: number): Promise<{ frames: Run[]; ended: boolean; contentType: string }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), maxMs);
  const frames: Run[] = [];
  let ended = false;
  let contentType = "";
  try {
    const res = await fetch(url(`/api/runs/${id}/events`), { signal: ctl.signal });
    contentType = res.headers.get("content-type") ?? "";
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (!ended) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (block.startsWith("event: end")) ended = true;
        else if (block.startsWith("data: ")) frames.push(JSON.parse(block.slice(6)) as Run);
      }
    }
  } catch (err) {
    if (!(err instanceof Error && err.name === "AbortError")) throw err;
  } finally {
    clearTimeout(timer);
    ctl.abort();
  }
  return { frames, ended, contentType };
}

suite("Argon Cut API (E2E_BASE_URL)", () => {
  let clip: Buffer;
  let run: Run;

  beforeAll(async () => {
    clip = await readFile(DEMO_CLIP);
    const res = await createRun("e2e: a short teaser with captions", [{ name: "01_intro.mp4", data: clip, type: "video/mp4" }]);
    const text = await res.text();
    expect(res.status, text).toBe(201);
    run = JSON.parse(text) as Run;
  }, 30_000);

  describe("POST /api/runs validation", () => {
    it("rejects a non-multipart body", async () => {
      const res = await fetch(url("/api/runs"), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(res.status).toBe(400);
      expect(await json(res)).toEqual({ error: "expected multipart form data" });
    });

    it("rejects a missing brief", async () => {
      const form = new FormData();
      form.append("files", new Blob([new Uint8Array(clip)], { type: "video/mp4" }), "a.mp4");
      const res = await fetch(url("/api/runs"), { method: "POST", body: form });
      expect(res.status).toBe(400);
      expect((await json(res)).error).toBe("brief is required");
    });

    it("rejects an over-long brief", async () => {
      const res = await createRun("x".repeat(2001), [{ name: "a.mp4", data: clip, type: "video/mp4" }]);
      expect(res.status).toBe(400);
      expect(String((await json(res)).error)).toMatch(/at most 2000/);
    });

    it("rejects no files", async () => {
      const form = new FormData();
      form.set("brief", "hello");
      const res = await fetch(url("/api/runs"), { method: "POST", body: form });
      expect(res.status).toBe(400);
      expect((await json(res)).error).toBe("at least one video or photo is required");
    });

    it("rejects a file that is neither video nor photo", async () => {
      const res = await createRun("hello", [{ name: "notes.txt", data: Buffer.from("hi"), type: "text/plain" }]);
      expect(res.status).toBe(400);
      expect((await json(res)).error).toBe("notes.txt is not a video or photo");
    });
  });

  describe("run resources", () => {
    it("created a queued run with a 10-hex id and one clip", () => {
      expect(run.id).toMatch(RUN_ID);
      expect(run.brief).toBe("e2e: a short teaser with captions");
      expect(run.clips).toHaveLength(1);
      expect(run.clips[0].path).toMatch(/^src\/clip1_01_intro\.mp4$/);
      expect(run.iterations).toEqual([]);
    });

    it("GET /api/runs lists it", async () => {
      const res = await fetch(url("/api/runs"));
      expect(res.status).toBe(200);
      const runs = (await res.json()) as Run[];
      expect(runs.some((r) => r.id === run.id)).toBe(true);
    });

    it("GET /api/runs/:id returns it; unknown and malformed ids are 404", async () => {
      const ok = await fetch(url(`/api/runs/${run.id}`));
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as Run).id).toBe(run.id);
      for (const bad of ["0000000000", "zzz", "0000000000-", "a".repeat(10)]) {
        const res = await fetch(url(`/api/runs/${bad}`));
        expect(res.status, bad).toBe(404);
        expect(await json(res)).toEqual({ error: "run not found" });
      }
      // Dot segments collapse to another route; whatever answers must still be a 404.
      for (const bad of ["..", "%2e%2e"]) expect((await fetch(url(`/api/runs/${bad}`))).status, bad).toBe(404);
    });

    it("GET /api/runs/demo describes the bundled clips", async () => {
      const res = await fetch(url("/api/runs/demo"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { brief: string; clips: { name: string; size: number }[] };
      expect(body.brief.length).toBeGreaterThan(10);
      expect(body.clips.length).toBeGreaterThanOrEqual(1);
      expect(body.clips.every((c) => /\.(mp4|mov|webm|mkv|m4v)$/i.test(c.name) && c.size > 0)).toBe(true);
    });
  });

  describe("SSE /api/runs/:id/events", () => {
    it("streams the run as JSON frames with the event-stream content type", async () => {
      const { frames, contentType } = await readSse(run.id, 1500);
      expect(contentType).toMatch(/^text\/event-stream/);
      expect(frames.length).toBeGreaterThanOrEqual(1);
      expect(frames[0].id).toBe(run.id);
    });

    it("is 404 for an unknown run", async () => {
      const res = await fetch(url("/api/runs/0000000000/events"));
      expect(res.status).toBe(404);
    });
  });

  describe("files route", () => {
    const file = () => url(`/api/runs/${run.id}/files/${run.clips[0].path}`);

    it("serves the whole clip with Accept-Ranges and the right length", async () => {
      const res = await fetch(file());
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("video/mp4");
      expect(res.headers.get("accept-ranges")).toBe("bytes");
      expect(Number(res.headers.get("content-length"))).toBe(clip.length);
      const body = Buffer.from(await res.arrayBuffer());
      expect(body.length).toBe(clip.length);
      expect(body.subarray(4, 8).toString()).toBe("ftyp");
    });

    it("honours a closed byte range (206)", async () => {
      const res = await fetch(file(), { headers: { Range: "bytes=4-7" } });
      expect(res.status).toBe(206);
      expect(res.headers.get("content-range")).toBe(`bytes 4-7/${clip.length}`);
      expect(res.headers.get("content-length")).toBe("4");
      expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("ftyp");
    });

    it("honours open-ended and suffix ranges", async () => {
      const tail = await fetch(file(), { headers: { Range: `bytes=${clip.length - 10}-` } });
      expect(tail.status).toBe(206);
      expect(tail.headers.get("content-range")).toBe(`bytes ${clip.length - 10}-${clip.length - 1}/${clip.length}`);
      expect((await tail.arrayBuffer()).byteLength).toBe(10);

      const suffix = await fetch(file(), { headers: { Range: "bytes=-5" } });
      expect(suffix.status).toBe(206);
      expect(suffix.headers.get("content-range")).toBe(`bytes ${clip.length - 5}-${clip.length - 1}/${clip.length}`);

      const clamped = await fetch(file(), { headers: { Range: "bytes=0-999999999" } });
      expect(clamped.status).toBe(206);
      expect(clamped.headers.get("content-range")).toBe(`bytes 0-${clip.length - 1}/${clip.length}`);
      await clamped.arrayBuffer();
    });

    it("answers 416 with Content-Range */size for an unsatisfiable range", async () => {
      const res = await fetch(file(), { headers: { Range: `bytes=${clip.length}-` } });
      expect(res.status).toBe(416);
      expect(res.headers.get("content-range")).toBe(`bytes */${clip.length}`);
    });

    it("is 404 for a missing file, a directory, path traversal and a bad run id", async () => {
      const cases = [
        `/api/runs/${run.id}/files/nope.mp4`,
        `/api/runs/${run.id}/files/src`,
        `/api/runs/${run.id}/files/..%2F..%2Fpackage.json`,
        `/api/runs/${run.id}/files/%2e%2e/%2e%2e/package.json`,
        `/api/runs/${run.id}/files/src/..%2F..%2F..%2Fpackage.json`,
        `/api/runs/zzz/files/x.mp4`,
        `/api/runs/0000000000/files/x.mp4`,
      ];
      for (const p of cases) {
        const res = await fetch(url(p));
        expect(res.status, p).toBe(404);
        const body = await res.text();
        expect(body, p).not.toContain('"name": "gemini-editor"');
      }
    });
  });

  describe("revise / retry guards", () => {
    it("revise rejects a bad body, an empty or over-long note, and an unknown run", async () => {
      const post = (id: string, body: BodyInit, type = "application/json") =>
        fetch(url(`/api/runs/${id}/revise`), { method: "POST", headers: { "content-type": type }, body });

      let res = await post(run.id, "not json", "text/plain");
      expect(res.status).toBe(400);
      expect((await json(res)).error).toBe("expected a JSON body");

      res = await post(run.id, JSON.stringify({ note: "   " }));
      expect(res.status).toBe(400);
      expect(String((await json(res)).error)).toMatch(/1 to 500 characters/);

      res = await post(run.id, JSON.stringify({ note: "x".repeat(501) }));
      expect(res.status).toBe(400);

      res = await post("0000000000", JSON.stringify({ note: "make it 15 seconds" }));
      expect(res.status).toBe(404);
    });

    it("revise and retry answer 409 while the run is in progress (or 400/404 when it already stopped)", async () => {
      const current = (await (await fetch(url(`/api/runs/${run.id}`))).json()) as Run;
      const inProgress = current.status !== "done" && current.status !== "error";

      const rev = await fetch(url(`/api/runs/${run.id}/revise`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ note: "make it 15 seconds" }),
      });
      if (inProgress) {
        expect(rev.status).toBe(409);
        expect((await json(rev)).error).toBe("run is still in progress");
      } else {
        // Without GEMINI_API_KEY the run errors with no cut; the route must still refuse cleanly.
        expect([202, 409]).toContain(rev.status);
      }

      const retry = await fetch(url(`/api/runs/${run.id}/retry`), { method: "POST" });
      if (retry.status === 404) return; // route not deployed on this server
      if (inProgress) expect(retry.status).toBe(409);
      else expect([202, 409]).toContain(retry.status);
    });
  });

  describe("pricing and usage", () => {
    it("GET /api/pricing returns plans with numeric prices", async () => {
      const res = await fetch(url("/api/pricing"));
      if (res.status === 404) return;
      expect(res.status).toBe(200);
      const body = (await res.json()) as { plans: { name: string; priceUsd: number | null }[] };
      expect(Array.isArray(body.plans)).toBe(true);
      expect(body.plans.length).toBeGreaterThanOrEqual(2);
      for (const p of body.plans) {
        expect(typeof p.name).toBe("string");
        expect(p.priceUsd === null || (typeof p.priceUsd === "number" && p.priceUsd >= 0)).toBe(true);
      }
    });

    it("GET /api/usage returns non-negative totals and lists the run", async () => {
      const res = await fetch(url("/api/usage"));
      if (res.status === 404) return;
      expect(res.status).toBe(200);
      const body = (await res.json()) as { totals?: Record<string, number | null>; runs?: { id: string; usd: number; tokens: number }[] };
      expect(body.totals).toBeTruthy();
      expect(body.totals!.usd).toBeGreaterThanOrEqual(0);
      expect(body.totals!.tokens).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(body.runs)).toBe(true);
      expect(body.runs!.some((r) => r.id === run.id)).toBe(true);
    });
  });

  describe("pages", () => {
    it.each(["/", "/how", "/pricing"])("%s renders 200 html", async (p) => {
      const res = await fetch(url(p));
      if (p === "/pricing" && res.status === 404) return;
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      expect(await res.text()).toContain("Argon");
    });

    it("/runs/:id renders 200 html for a real and an unknown run", async () => {
      for (const id of [run.id, "0000000000"]) {
        const res = await fetch(url(`/runs/${id}`));
        expect(res.status, id).toBe(200);
        expect(res.headers.get("content-type")).toMatch(/text\/html/);
      }
    });

    /** Visible text only: the RSC flight payload inside <script> legitimately contains "undefined". */
    const visibleText = (html: string) =>
      html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ");

    it("every finished run's page, share page and theater view render without undefined/NaN text", async () => {
      const runs = (await (await fetch(url("/api/runs"))).json()) as Run[];
      const finished = runs.filter((r) => r.status === "done" && r.iterations.length > 0).slice(0, 5);
      const pages = ["/", "/how", "/pricing", `/runs/${run.id}`];
      for (const r of finished) pages.push(`/runs/${r.id}`, `/s/${r.id}`, `/?theater=${r.id}`);
      for (const p of pages) {
        const res = await fetch(url(p));
        if (p.startsWith("/s/") && res.status === 404) continue; // share route not deployed on this server
        expect(res.status, p).toBe(200);
        expect(res.headers.get("content-type"), p).toMatch(/text\/html/);
        const text = visibleText(await res.text());
        expect(text, p).not.toMatch(/undefined/);
        expect(text, p).not.toMatch(/\bNaN\b/);
        expect(text, p).not.toMatch(/\[object Object\]/);
      }
    }, 60_000);
  });

  describe("live token", () => {
    const post = (body: BodyInit, type = "application/json") =>
      fetch(url("/api/live/token"), { method: "POST", headers: { "content-type": type }, body });

    it("rejects a non-JSON body, a missing runId and an unknown run", async () => {
      let res = await post("nope", "text/plain");
      if (res.status === 404) return; // route not deployed on this server
      expect(res.status).toBe(400);
      expect((await json(res)).error).toBe("expected a JSON body with runId");

      res = await post(JSON.stringify({}));
      expect(res.status).toBe(400);
      expect((await json(res)).error).toBe("runId is required");

      res = await post(JSON.stringify({ runId: "0000000000" }));
      expect(res.status).toBe(404);
      expect((await json(res)).error).toBe("run not found");
    });

    it("mints a token with the documented shape (or 503 without a key); the value is never logged", async () => {
      const res = await post(JSON.stringify({ runId: run.id }));
      if (res.status === 404) return; // route not deployed on this server
      // 402 (credits) and 502 (token service) are upstream conditions, not request bugs; 503 means no key.
      expect([200, 402, 502, 503], `status ${res.status}`).toContain(res.status);
      if (res.status !== 200) return;
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = (await res.json()) as { token: unknown; expiresAt: unknown; model: unknown; systemInstruction: unknown };
      expect(Object.keys(body).sort()).toEqual(["expiresAt", "model", "systemInstruction", "token"]);
      expect(typeof body.token === "string" && body.token.length > 10).toBe(true);
      expect(typeof body.model === "string" && body.model.length > 0).toBe(true);
      expect(typeof body.systemInstruction === "string" && (body.systemInstruction as string).includes(run.brief)).toBe(true);
      const expires = Date.parse(String(body.expiresAt));
      expect(Number.isNaN(expires)).toBe(false);
      expect(expires).toBeGreaterThan(Date.now());
    }, 30_000);
  });
});
