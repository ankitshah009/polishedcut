// A reference implementation of the Frame Analyst webhook contract (header of lib/frame-analyst.ts),
// for exercising FRAME_ANALYSIS=nebula end to end before the real Nebula job is reachable, and for
// checking that the Nebula job answers the same way. It is NOT Nebula: the analysis here is the same
// whisper.cpp + ffmpeg work the local editor would do, served over HTTP.
//
//   npx tsx scripts/frame-analyst-stub.ts [--port 3777] [--secret s3cret] [--sync]
//
// Then, in another shell, with the app serving runs (PUBLIC_URL must point at it):
//   FRAME_ANALYSIS=nebula NEBULA_FRAME_WEBHOOK_URL=http://127.0.0.1:3777/analyze \
//   NEBULA_FRAME_WEBHOOK_SECRET=s3cret PUBLIC_URL=http://localhost:3100 MODEL_PROVIDER=local \
//   npx tsx scripts/cut.ts --brief "..." clip.mp4
//
// POST /analyze answers 202 with a status_url (or 200 with the result under --sync); GET /jobs/<id>
// answers { status: "running" } until the analysis is done, then the result:
//   { words: [{text,start,end}], sound: [[s,e]], shots: [[s,e]], summary }
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

interface Args {
  port: number;
  secret: string;
  sync: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { port: 3777, secret: "", sync: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") args.port = Number(argv[++i]);
    else if (a === "--secret") args.secret = argv[++i] ?? "";
    else if (a === "--sync") args.sync = true;
    else {
      console.error(`unknown option ${a}`);
      process.exit(2);
    }
  }
  if (!Number.isInteger(args.port) || args.port < 1) {
    console.error("--port needs a positive integer");
    process.exit(2);
  }
  return args;
}

type Job = { status: "running" } | { status: "done"; result: unknown } | { status: "failed"; error: string };

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : null;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // lib/config.ts reads the environment at import time; nothing here changes it, but keep the import
  // dynamic so the usage message above never needs the pipeline to load.
  const { transcribeLocally, soundRegions, shotRegions } = await import("../lib/local-editor");

  const jobs = new Map<string, Job>();

  async function analyze(clipUrl: string, duration: number): Promise<unknown> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "frame-stub-"));
    try {
      const res = await fetch(clipUrl);
      if (!res.ok) throw new Error(`fetching ${clipUrl}: HTTP ${res.status}`);
      const file = path.join(dir, "clip.mp4");
      await writeFile(file, Buffer.from(await res.arrayBuffer()));
      const [words, sound, shots] = await Promise.all([
        transcribeLocally(file, duration),
        soundRegions(file, duration),
        shotRegions(file, duration),
      ]);
      const said = words.map((w) => w.text).join(" ");
      return {
        words,
        sound,
        shots,
        summary: `stub analysis (whisper.cpp + ffmpeg over HTTP): ${words.length} words${said ? `, opens "${said.slice(0, 60)}"` : ""}`,
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      if (args.secret && req.headers.authorization !== `Bearer ${args.secret}`) return send(res, 401, { error: "bad or missing bearer secret" });

      if (req.method === "POST" && url.pathname === "/analyze") {
        const body = (await readJson(req)) as { task?: string; clip?: { id?: string; url?: string; duration_seconds?: number } } | null;
        const clip = body?.clip;
        if (body?.task !== "frame-analysis" || !clip?.url) return send(res, 400, { error: "expected { task: 'frame-analysis', clip: { url } }" });
        const duration = Number(clip.duration_seconds ?? 0);
        console.log(`[stub] ${clip.id ?? "clip"}: analysing ${clip.url}`);
        if (args.sync) return send(res, 200, await analyze(clip.url, duration));
        const id = randomBytes(6).toString("hex");
        jobs.set(id, { status: "running" });
        analyze(clip.url, duration)
          .then((result) => jobs.set(id, { status: "done", result }))
          .catch((err) => jobs.set(id, { status: "failed", error: String(err) }));
        return send(res, 202, { status: "queued", status_url: `/jobs/${id}` });
      }

      const m = url.pathname.match(/^\/jobs\/([0-9a-f]+)$/);
      if (req.method === "GET" && m) {
        const job = jobs.get(m[1]);
        if (!job) return send(res, 404, { error: "no such job" });
        if (job.status === "running") return send(res, 202, { status: "running", status_url: url.pathname });
        if (job.status === "failed") return send(res, 500, { error: job.error });
        console.log(`[stub] job ${m[1]} delivered`);
        return send(res, 200, { status: "done", result: job.result });
      }

      send(res, 404, { error: "not found" });
    } catch (err) {
      console.error(`[stub] ${String(err)}`);
      send(res, 500, { error: String(err) });
    }
  });

  server.listen(args.port, "127.0.0.1", () => {
    console.log(`[stub] Frame Analyst stand-in on http://127.0.0.1:${args.port}/analyze (${args.sync ? "sync 200" : "202 + poll"}${args.secret ? ", bearer secret" : ""})`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
