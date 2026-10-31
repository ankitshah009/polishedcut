import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

import { NextResponse } from "next/server";

import { isRunId, runDir } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Everything a run directory can hold: renders, proxies, originals, thumbnail sprites, title art, music beds. */
const TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Stream a file slice as a web ReadableStream. Readable.toWeb throws "Controller is already closed"
 * when the browser aborts a range request mid-flight (it does this constantly while seeking video),
 * which crashes the server, so cancellation is handled explicitly here.
 */
function fileStream(file: string, opts: { start?: number; end?: number } = {}): ReadableStream<Uint8Array> {
  const node = createReadStream(file, opts);
  const chunks = node[Symbol.asyncIterator]();
  // Pull-based: a chunk is read only when the consumer asks for one, and never after cancel.
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await chunks.next();
        if (done) controller.close();
        else controller.enqueue(new Uint8Array(value as Buffer));
      } catch (err) {
        controller.error(err);
      }
    },
    cancel() {
      node.destroy();
    },
  });
}

type Params = { params: Promise<{ id: string; path: string[] }> };

/** Parse "bytes=start-end". Returns null when the header is malformed or unsatisfiable. */
function parseRange(header: string, size: number): { start: number; end: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start: number;
  let end: number;
  if (m[1] === "") {
    const suffix = Number(m[2]);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return null;
  return { start, end };
}

export async function GET(request: Request, { params }: Params) {
  const { id, path: segments } = await params;
  if (!isRunId(id)) return NextResponse.json({ error: "file not found" }, { status: 404 });

  const root = runDir(id);
  const target = path.resolve(root, ...segments);
  if (!target.startsWith(root + path.sep)) {
    return NextResponse.json({ error: "file not found" }, { status: 404 });
  }

  let size: number;
  try {
    const info = await stat(target);
    if (!info.isFile()) throw new Error("not a file");
    size = info.size;
  } catch {
    return NextResponse.json({ error: "file not found" }, { status: 404 });
  }

  const type = TYPES[path.extname(target).toLowerCase()] ?? "application/octet-stream";
  const headers: Record<string, string> = {
    "Content-Type": type,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=0, must-revalidate",
  };

  const rangeHeader = request.headers.get("range");
  if (rangeHeader) {
    const range = parseRange(rangeHeader, size);
    if (!range) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    }
    const { start, end } = range;
    const body = fileStream(target, { start, end });
    return new Response(body, {
      status: 206,
      headers: {
        ...headers,
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Content-Length": String(end - start + 1),
      },
    });
  }

  const body = fileStream(target);
  return new Response(body, { headers: { ...headers, "Content-Length": String(size) } });
}
