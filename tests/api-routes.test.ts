// Route handlers called directly with Fetch Requests: no server, no port, no Gemini.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { makeFixtureClip } from "./fixtures";

let tmp: string;
let demoDir: string;
let runs: typeof import("../app/api/runs/route");
let demo: typeof import("../app/api/runs/demo/route");
let files: typeof import("../app/api/runs/[id]/files/[...path]/route");
let revise: typeof import("../app/api/runs/[id]/revise/route");
let one: typeof import("../app/api/runs/[id]/route");
let config: typeof import("../lib/config");

const saved = {
  RUNS_DIR: process.env.RUNS_DIR,
  DEMO_DIR: process.env.DEMO_DIR,
  DEMO_BRIEF: process.env.DEMO_BRIEF,
  MAX_UPLOAD_BYTES: process.env.MAX_UPLOAD_BYTES,
  MAX_CLIP_SECONDS: process.env.MAX_CLIP_SECONDS,
  MAX_TOTAL_SECONDS: process.env.MAX_TOTAL_SECONDS,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  GEMINI_API_KEY_1: process.env.GEMINI_API_KEY_1,
  MODEL_PROVIDER: process.env.MODEL_PROVIDER,
};

beforeAll(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "api-routes-"));
  demoDir = path.join(tmp, "demo");
  mkdirSync(demoDir);
  process.env.RUNS_DIR = path.join(tmp, "runs");
  process.env.DEMO_DIR = demoDir;
  delete process.env.DEMO_BRIEF;
  process.env.MAX_UPLOAD_BYTES = String(400 * 1024); // 400 KiB, so a tiny fixture can be "too large"
  process.env.MAX_CLIP_SECONDS = "2"; // a 3s fixture is "too long"
  process.env.MAX_TOTAL_SECONDS = "5"; // three 1.9s fixtures together are "too much footage"; one 4s photo clip is fine
  // Gemini provider with no key: a started loop records the missing key on the run instead of
  // calling Gemini. (Unset, a missing key would select the local editor, which needs no key.)
  process.env.MODEL_PROVIDER = "gemini";
  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY_1;
  vi.resetModules();
  config = await import("../lib/config");
  runs = await import("../app/api/runs/route");
  demo = await import("../app/api/runs/demo/route");
  files = await import("../app/api/runs/[id]/files/[...path]/route");
  revise = await import("../app/api/runs/[id]/revise/route");
  one = await import("../app/api/runs/[id]/route");
}, 60_000);

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

const params = <T,>(p: T) => ({ params: Promise.resolve(p) });
const json = (r: Response) => r.json() as Promise<Record<string, unknown>>;

const zeros = (n: number): ArrayBuffer => new ArrayBuffer(n);

function upload(brief: string, parts: { name: string; bytes: ArrayBuffer; type?: string }[], headers: Record<string, string> = {}) {
  const form = new FormData();
  form.append("brief", brief);
  for (const p of parts) form.append("files", new File([p.bytes], p.name, { type: p.type ?? "" }));
  return new Request("http://local/api/runs", { method: "POST", body: form, headers });
}

describe("POST /api/runs", () => {
  it("400 on a missing brief, no files, an unknown file type and an over-long brief", async () => {
    const clip = zeros(16);
    expect((await runs.POST(upload("", [{ name: "a.mp4", bytes: clip }]))).status).toBe(400);
    expect((await runs.POST(upload("brief", []))).status).toBe(400);
    expect((await runs.POST(upload("brief", [{ name: "notes.txt", bytes: clip, type: "text/plain" }]))).status).toBe(400);
    const long = "x".repeat(config.BRIEF_MAX_CHARS + 1);
    const r = await runs.POST(upload(long, [{ name: "a.mp4", bytes: clip }]));
    expect(r.status).toBe(400);
    expect((await json(r)).error).toMatch(String(config.BRIEF_MAX_CHARS));
    expect((await runs.POST(new Request("http://local/api/runs", { method: "POST", body: "nope" }))).status).toBe(400);
  });

  it("413 when Content-Length declares more than MAX_UPLOAD_BYTES, before the body is parsed", async () => {
    const r = await runs.POST(upload("brief", [{ name: "a.mp4", bytes: zeros(16) }], { "content-length": String(config.MAX_UPLOAD_BYTES + 1) }));
    expect(r.status).toBe(413);
    expect((await json(r)).error).toMatch(/MAX_UPLOAD_BYTES/);
  });

  it("413 when the files together exceed MAX_UPLOAD_BYTES, and nothing is written", async () => {
    const half = zeros(Math.ceil(config.MAX_UPLOAD_BYTES / 2) + 1);
    const before = existsSync(config.RUNS_DIR) ? readdirSync(config.RUNS_DIR).length : 0;
    const r = await runs.POST(upload("brief", [{ name: "a.mp4", bytes: half }, { name: "b.mp4", bytes: half }]));
    expect(r.status).toBe(413);
    const after = existsSync(config.RUNS_DIR) ? readdirSync(config.RUNS_DIR).length : 0;
    expect(after).toBe(before);
  });

  it("201 with a queued run whose clips are saved under RUNS_DIR/<id>/src", async () => {
    const fixtures = path.join(tmp, "fx");
    mkdirSync(fixtures, { recursive: true });
    const file = await makeFixtureClip(fixtures, "tiny.mp4", { seconds: 1, width: 64, height: 36, audio: false });
    const buf = await (await import("node:fs/promises")).readFile(file);
    const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    expect(bytes.byteLength).toBeLessThan(config.MAX_UPLOAD_BYTES);

    const r = await runs.POST(upload("10s recap", [{ name: "../../weird name!.mp4", bytes, type: "video/mp4" }]));
    expect(r.status).toBe(201);
    const run = (await json(r)) as { id: string; status: string; clips: { id: string; path: string }[] };
    expect(config.isRunId(run.id)).toBe(true);
    // The clip is probed at upload: its duration is known before the loop starts.
    expect(run.clips).toEqual([{ id: "clip1", path: "src/clip1_weird_name_.mp4", duration: expect.closeTo(1, 1), transcript: [] }]);
    expect(existsSync(path.join(config.runDir(run.id), run.clips[0].path))).toBe(true);

    // GET /api/runs/[id] serves it back; the loop (no key) ends in an error that names the key.
    await vi.waitFor(async () => {
      const got = await one.GET(new Request("http://local"), params({ id: run.id }));
      expect(got.status).toBe(200);
      const body = (await json(got)) as { status: string; error: string };
      expect(body.status).toBe("error");
      expect(body.error).toMatch(/GEMINI_API_KEY/);
    });
  }, 60_000);

  describe("footage limits and odd inputs (real ffprobe)", () => {
    let fixtures: string;
    const bytesOf = async (file: string): Promise<ArrayBuffer> => {
      const buf = await (await import("node:fs/promises")).readFile(file);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    };
    const runsOnDisk = () => (existsSync(config.RUNS_DIR) ? readdirSync(config.RUNS_DIR).filter(config.isRunId).length : 0);

    beforeAll(() => {
      fixtures = path.join(tmp, "fx2");
      mkdirSync(fixtures, { recursive: true });
    });

    it("400 for bytes that are not a video, and the run directory is removed", async () => {
      const before = runsOnDisk();
      const r = await runs.POST(upload("brief", [{ name: "garbage.mp4", bytes: zeros(64), type: "video/mp4" }]));
      expect(r.status).toBe(400);
      expect((await json(r)).error).toMatch(/garbage\.mp4 is not a video ffmpeg can read/);
      expect(runsOnDisk()).toBe(before);
    });

    it("400 for a clip over MAX_CLIP_SECONDS, naming the clip and the limit", async () => {
      const long = await makeFixtureClip(fixtures, "long.mp4", { seconds: 3, width: 64, height: 36, audio: false });
      const r = await runs.POST(upload("brief", [{ name: "long.mp4", bytes: await bytesOf(long), type: "video/mp4" }]));
      expect(r.status).toBe(400);
      expect((await json(r)).error).toMatch(/long\.mp4 is 0:03 long; the limit per clip is 0:02 \(MAX_CLIP_SECONDS\)/);
    }, 30_000);

    it("400 when the clips together exceed MAX_TOTAL_SECONDS", async () => {
      const a = await bytesOf(await makeFixtureClip(fixtures, "a.mp4", { seconds: 1.9, width: 64, height: 36, audio: false }));
      const part = (name: string) => ({ name, bytes: a, type: "video/mp4" });
      const r = await runs.POST(upload("brief", [part("a.mp4"), part("b.mp4"), part("c.mp4")]));
      expect(r.status).toBe(400);
      expect((await json(r)).error).toMatch(/0:06 in total; the limit per run is 0:05 \(MAX_TOTAL_SECONDS\)/);
      // Two of them fit.
      expect((await runs.POST(upload("brief", [part("a.mp4"), part("b.mp4")]))).status).toBe(201);
    }, 30_000);

    it("accepts a 10-bit, odd-sized, 24fps, silent mkv-style clip and records its duration", async () => {
      const odd = await makeFixtureClip(fixtures, "odd.mp4", { seconds: 1, width: 65, height: 37, fps: 24, pixFmt: "yuv420p10le", audio: false });
      const r = await runs.POST(upload("brief", [{ name: "odd.mkv", bytes: await bytesOf(odd), type: "" }]));
      expect(r.status).toBe(201);
      const run = (await json(r)) as { clips: { duration: number }[] };
      expect(run.clips[0].duration).toBeCloseTo(1, 1);
    }, 30_000);

    it("a portrait photo becomes a portrait clip when the footage (or brief) is vertical", async () => {
      const png = path.join(fixtures, "tall.png");
      const { execFileSync } = await import("node:child_process");
      execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=90x160:rate=1", "-frames:v", "1", png]);
      const r = await runs.POST(upload("a vertical story", [{ name: "tall.png", bytes: await bytesOf(png), type: "image/png" }]));
      expect(r.status).toBe(201);
      const run = (await json(r)) as { id: string; clips: { path: string; duration: number }[] };
      expect(run.clips[0].path).toBe("src/clip1_tall.mp4");
      expect(run.clips[0].duration).toBe(config.PHOTO_SECONDS);
      const out = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", path.join(config.runDir(run.id), run.clips[0].path)]).toString().trim();
      expect(out).toBe("1080,1920");
    }, 60_000);
  });
});

describe("GET /api/runs/[id] and /revise", () => {
  it("404 for unknown or malformed ids", async () => {
    expect((await one.GET(new Request("http://local"), params({ id: "ffffffffff" }))).status).toBe(404);
    expect((await one.GET(new Request("http://local"), params({ id: "../etc" }))).status).toBe(404);
    const r = await revise.POST(new Request("http://local", { method: "POST", body: JSON.stringify({ note: "x" }) }), params({ id: "ffffffffff" }));
    expect(r.status).toBe(404);
  });
});

describe("GET /api/runs/[id]/files/...", () => {
  const id = "abcdef0123";
  beforeAll(() => {
    const dir = config.runDir(id);
    mkdirSync(path.join(dir, "thumbs"), { recursive: true });
    writeFileSync(path.join(dir, "iter1.mp4"), Buffer.from("0123456789"));
    writeFileSync(path.join(dir, "thumbs", "clip1.jpg"), Buffer.from("jpeg"));
    writeFileSync(path.join(tmp, "secret.txt"), "top secret");
  });

  it("serves whole files with a content type and length", async () => {
    const r = await files.GET(new Request("http://local"), params({ id, path: ["iter1.mp4"] }));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("video/mp4");
    expect(r.headers.get("content-length")).toBe("10");
    expect(r.headers.get("accept-ranges")).toBe("bytes");
    expect(await r.text()).toBe("0123456789");

    const jpg = await files.GET(new Request("http://local"), params({ id, path: ["thumbs", "clip1.jpg"] }));
    expect(jpg.headers.get("content-type")).toBe("image/jpeg");
  });

  it("honours byte ranges, including suffix and open-ended ones, and rejects bad ones with 416", async () => {
    const mid = await files.GET(new Request("http://local", { headers: { range: "bytes=2-4" } }), params({ id, path: ["iter1.mp4"] }));
    expect(mid.status).toBe(206);
    expect(mid.headers.get("content-range")).toBe("bytes 2-4/10");
    expect(await mid.text()).toBe("234");

    const tail = await files.GET(new Request("http://local", { headers: { range: "bytes=7-" } }), params({ id, path: ["iter1.mp4"] }));
    expect(await tail.text()).toBe("789");

    const suffix = await files.GET(new Request("http://local", { headers: { range: "bytes=-3" } }), params({ id, path: ["iter1.mp4"] }));
    expect(suffix.headers.get("content-range")).toBe("bytes 7-9/10");

    const past = await files.GET(new Request("http://local", { headers: { range: "bytes=2-99" } }), params({ id, path: ["iter1.mp4"] }));
    expect(past.headers.get("content-range")).toBe("bytes 2-9/10");

    for (const bad of ["bytes=10-", "bytes=5-2", "bytes=", "items=0-1"]) {
      const r = await files.GET(new Request("http://local", { headers: { range: bad } }), params({ id, path: ["iter1.mp4"] }));
      expect(r.status, bad).toBe(416);
      expect(r.headers.get("content-range")).toBe("bytes */10");
    }
  });

  it("never leaves the run directory: traversal, other runs, bad ids and directories are 404", async () => {
    const cases: string[][] = [["..", "secret.txt"], ["..", "..", "secret.txt"], ["thumbs", "..", "..", "secret.txt"], ["thumbs"], ["nope.mp4"]];
    for (const p of cases) {
      const r = await files.GET(new Request("http://local"), params({ id, path: p }));
      expect(r.status, p.join("/")).toBe(404);
    }
    expect((await files.GET(new Request("http://local"), params({ id: "../abcdef0123", path: ["iter1.mp4"] }))).status).toBe(404);
    expect((await files.GET(new Request("http://local"), params({ id: "ffffffffff", path: ["iter1.mp4"] }))).status).toBe(404);
  });
});

describe("/api/runs/demo", () => {
  it("GET lists the clips in DEMO_DIR and reads the brief from brief.txt, DEMO_BRIEF winning", async () => {
    let r = await json(await demo.GET());
    expect(r.clips).toEqual([]);
    expect(r.brief).toBe(config.DEFAULT_DEMO_BRIEF);

    writeFileSync(path.join(demoDir, "brief.txt"), "  Ten second teaser.\n");
    writeFileSync(path.join(demoDir, "02_b.mp4"), "bb");
    writeFileSync(path.join(demoDir, "01_a.mov"), "a");
    writeFileSync(path.join(demoDir, "notes.txt"), "ignored");
    r = await json(await demo.GET());
    expect(r.brief).toBe("Ten second teaser.");
    expect(r.clips).toEqual([{ name: "01_a.mov", size: 1 }, { name: "02_b.mp4", size: 2 }]);
  });

  it("POST copies the demo clips into a new run with the demo brief (404 when there are none)", async () => {
    const r = await demo.POST();
    expect(r.status).toBe(201);
    const run = (await json(r)) as { id: string; brief: string; clips: { path: string }[] };
    expect(run.brief).toBe("Ten second teaser.");
    expect(run.clips.map((c) => c.path)).toEqual(["src/clip1_01_a.mov", "src/clip2_02_b.mp4"]);
    expect(existsSync(path.join(config.runDir(run.id), "src", "clip2_02_b.mp4"))).toBe(true);

    for (const f of readdirSync(demoDir)) rmSync(path.join(demoDir, f));
    expect((await demo.POST()).status).toBe(404);
  });
});
