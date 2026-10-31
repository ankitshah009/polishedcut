import { NextResponse } from "next/server";

import { SSE_HEARTBEAT_MS } from "@/lib/config";
import { loadRun, subscribe } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const first = await loadRun(id);
  if (!first) return NextResponse.json({ error: "run not found" }, { status: 404 });

  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
          cleanup();
        }
      };
      const finish = () => {
        if (closed) return;
        closed = true;
        cleanup();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      const sendRun = (run: Awaited<ReturnType<typeof loadRun>>) => {
        if (!run) return;
        send(`data: ${JSON.stringify(run)}\n\n`);
        if (run.status === "done" || run.status === "error") {
          send("event: end\ndata: {}\n\n");
          finish();
        }
      };

      const unsubscribe = subscribe(id, (run) => sendRun(run));
      const heartbeat = setInterval(() => send(": ping\n\n"), SSE_HEARTBEAT_MS);
      cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
      };
      request.signal.addEventListener("abort", () => finish(), { once: true });
      if (request.signal.aborted) {
        finish();
        return;
      }

      sendRun(first);
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
