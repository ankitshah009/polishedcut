// A per-run sink for token usage, so companion models (Flash-Lite, Nano Banana, Lyria, Omni) are metered
// like Argon without threading a callback through every function. The job runner opens the sink; each
// module reports right after its Interactions call. Outside a run (scripts, tests) reporting is a no-op.
import { AsyncLocalStorage } from "node:async_hooks";

import { usageRecord, type UsageRecord } from "./gemini";

type Sink = (u: UsageRecord) => void;

const store = new AsyncLocalStorage<Sink>();

/** Run `fn` with every reported model call delivered to `sink`. */
export function withUsageSink<T>(sink: Sink, fn: () => Promise<T>): Promise<T> {
  return store.run(sink, fn);
}

/** Record one model call made inside a run: the response's `usage` block and the wall time since `startedAt`. */
export function reportUsage(model: string, response: unknown, startedAt: number): void {
  const sink = store.getStore();
  if (!sink) return;
  try {
    const usage = (response as { usage?: Parameters<typeof usageRecord>[1] } | null)?.usage;
    sink(usageRecord(model, usage, Date.now() - startedAt));
  } catch (err) {
    console.warn("[usage] could not record a model call:", err);
  }
}
