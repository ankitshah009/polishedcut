/**
 * The one error the Nebula Frame Analyst path throws, with a `kind` that says which contract broke.
 * Kept in its own module so lib/config.ts (startup validation) and lib/frame-analyst.ts (the round
 * trip) can both throw it without importing each other, and lib/loop.ts can recognise it by `instanceof`.
 *
 *   config       the environment is incomplete or wrong (no URL, no secret, no PUBLIC_URL, not https)
 *   unreachable  the webhook or its status URL could not be reached at all (DNS, refused, reset)
 *   http         the webhook answered with an HTTP error that is not worth retrying, or kept failing
 *   timeout      the clip's round trip (POST, polls or callback wait) ran out of NEBULA_FRAME_TIMEOUT_MS
 *   bad_payload  the response, poll result or callback body holds no usable analysis
 */
export type FrameAnalystErrorKind = "config" | "unreachable" | "http" | "timeout" | "bad_payload";

export class FrameAnalystError extends Error {
  readonly kind: FrameAnalystErrorKind;
  /** HTTP status when `kind` is http (or the last status seen before giving up). */
  readonly status?: number;

  constructor(kind: FrameAnalystErrorKind, message: string, opts: { status?: number; cause?: unknown } = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "FrameAnalystError";
    this.kind = kind;
    if (opts.status !== undefined) this.status = opts.status;
  }
}

export function isFrameAnalystError(err: unknown): err is FrameAnalystError {
  return err instanceof FrameAnalystError || (!!err && typeof err === "object" && (err as { name?: string }).name === "FrameAnalystError");
}
