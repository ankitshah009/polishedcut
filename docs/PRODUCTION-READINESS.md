# Production readiness

An honest review of where PolishedTake stands after the hackathon day (Oct 25, 2026), what is safe to demo, and what must change before charging customers. It combines an independent architecture review (run through Lovable's agent in plan mode against the architecture description, without access to this repo) with what we verified ourselves.

## What is solid today

- The loop is real and verified live: transcripts, brief analysis, Argon draft, title and end-card art, Lyria music, Omni shots, ffmpeg render, Argon critique, deterministic transcript lint, patch repair, revisions, retries and resume-on-boot. A two-version 60-second cut takes 88–165 s wall time.
- Every Gemini call is made through the Interactions API with `store: false`, retried with backoff and `Retry-After`, gated to a concurrency limit, and uploads are deleted from the Files API after the run.
- 328 unit and integration tests on real ffmpeg, plus an e2e API suite against a running server; typecheck and lint are clean; the production build passes.
- Nothing is hard-coded: 40+ env vars with validated defaults (`.env.example`).

## Blockers before any public, paid deployment

1. **No authentication.** Every route is callable by anyone, and each call spends Gemini, Lyria and Omni budget; `/api/runs/:id/files/*` would expose a user's raw footage. Add accounts, put every run under an owner, and check ownership on every route including SSE and file streaming. Scope `/api/live/token` to a session and limit tokens per user per hour. Rate-limit or pre-render `/api/runs/demo`.
2. **Share pages use the run id.** Use a separate, revocable, unguessable share token and serve only the final render through short-lived signed URLs.
3. **No spend limits.** Reserve an estimated cost against a per-user quota before a run, settle the real cost after, cap minutes of input, versions, Omni shots and revisions per run, add a wall-clock timeout, and a global daily budget that pauses new runs. Set billing alerts in Google Cloud.
4. **Upload and ffmpeg hardening.** Validate type by magic bytes, cap file count, duration, resolution and frame rate before transcoding (duration caps exist today), run ffmpeg with `-protocol_whitelist file` and CPU/memory/time limits. Keep the current practice of `textfile=` for all drawn text and argument arrays (never shell strings).
5. **Treat all model and user text as data.** EDLs and patches are already schema-validated and sanitized; keep that strict, and never let transcripts or notes act as instructions.

## Reliability under load

6. **Single machine, no queue.** Split web and worker roles; use a durable queue (Cloud Tasks, Pub/Sub or BullMQ) with one job per step and a checkpoint after each, so a resume repeats only the unfinished step.
7. **Run state is a JSON file plus an in-process active set.** Move to Postgres with a status machine and optimistic locking; keep `run.json` as a debug export.
8. **SSE is single-server.** Fan out through Postgres `LISTEN/NOTIFY` or Redis, support `Last-Event-ID` replay, keep the 15 s heartbeat.
9. **The Gemini concurrency gate is per process.** Use a shared limiter; separate pools for transcription, critique and media generation; a circuit breaker on repeated 5xx.
10. **402 handling.** Distinguish the platform running out of credits (pause everything, page the team) from a user exhausting a quota (upgrade prompt).
11. **Observability.** Structured logs with run id and step, per-step timings, tokens and cost per run, failures to an error tracker, alerts on failed-run rate and queue depth.

## Data and privacy

12. Move media to object storage with server-side encryption and signed URLs (keep Range support).
13. Publish a retention policy (for example, delete sources 30 days after a run) and give users "delete this run"; alert when Files API deletion fails.
14. Keep `store: false`; confirm the data terms for Lyria, Omni and Live and disclose them.
15. Move the API key to a secret manager, separate dev and prod keys, rotate them.
16. Uploads contain other people's likenesses: terms of service, a takedown path for share pages, labels on AI-generated shots and music, and a check of Lyria/Omni output licensing for commercial use.

## Cost control

17. Price from a usage ledger of real token and media usage per call, not from the model estimate.
18. Cache transcripts by file hash, critique a low-resolution proxy at lower fps, send only changed segments on later versions, require opt-in for Omni shots, meter Live sessions separately and cap their length.

## Journey gaps

- Vertical and square exports are marked "coming soon" in the UI; build reframing or keep them hidden. Never charge for a missing feature.
- Upload progress exists; add resumable uploads straight to object storage for large files.
- Failed runs should say which step failed and whether it cost credits, with one-click retry (retry exists); credit back system-caused failures.
- Show the cost estimate and remaining quota before "Cut it" and the real cost after.
- Share pages: private, unlisted or public, with expiry and Open Graph metadata.
- Caption export (SRT/VTT), keyboard control of the timeline, contrast checks; theater and share pages on phones.

## Suggested order

1. Auth, ownership, share tokens, rate limits, upload and ffmpeg hardening, cost caps.
2. Postgres, queue and workers, object storage, shared limiter, cross-server SSE.
3. Usage ledger, payments with webhooks and an entitlements table, quotas in the UI, retention and deletion, legal pages.
4. Export formats, resumable uploads, failure messaging, a load test with 20 concurrent runs.
