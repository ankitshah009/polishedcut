# Working on PolishedCut

Read this before touching the repo. Each note below cost someone time today.

## Ground rules

- **Never restart `next dev` / `next start` while a run is in flight.** Runs are driven by an
  in-process loop (`lib/jobs.ts`); killing the server mid-cut interrupts every active run.
  `instrumentation.ts` resumes interrupted runs on the next boot (and the orphan sweep in
  `lib/store.ts` marks a run as an error if its `run.json` has been quiet for `ORPHAN_AFTER_MS`),
  but the person waiting on the demo still loses minutes. Check `GET /api/runs` for any status in
  `queued | drafting | rendering | critiquing` first.
- **The app owns port 3000.** Do not start anything else there and do not `next build` in the
  checkout while the dev server runs: both write to `.next/` and the running server breaks.
- **One `npm install` at a time.** Parallel installs corrupt `node_modules` and `package-lock.json`.
  If you need a package, say so and let one person add it.
- **Tests must not need a key or the network.** Every Gemini-facing module takes an injected client
  or an `EditorModel` double (`tests/revise.test.ts`, `tests/loop.test.ts` show the pattern). The
  only live test is `tests/live.test.ts`, which skips itself without `GEMINI_API_KEY`.
- **Nothing hard-coded.** Ports, paths, model ids, limits, prices and the demo brief are read from
  the environment in `lib/config.ts` (and `lib/pricing.ts` for money). `.env.example` lists every
  variable the code reads; keep it in sync (`grep -rn process.env lib app components scripts`).

## Codebase quirks

- `lib/config.ts` reads `process.env` **at import time**. Scripts that load `.env` themselves
  (`scripts/cut.ts`) import it dynamically afterwards; tests that change `RUNS_DIR` call
  `vi.resetModules()` and re-import (`tests/config.test.ts`).
- `lib/format.ts` is bundled into the browser: no Node imports there. Server-only constants that
  the UI also needs (`TITLE_SECONDS`) are defined in `format.ts` and re-exported by `config.ts`.
- `.gitignore` anchors `/runs/` and `/footage/` to the repo root on purpose (`runs/` would also
  ignore `app/runs/`). Everything under `footage/` is ignored, including `footage/demo/brief.txt`:
  the demo brief therefore also has an env override (`DEMO_BRIEF`) and a built-in default.
- Route handlers import `@/lib/...`; `vitest.config.mts` maps that alias so the handlers can be
  tested directly with Fetch `Request` objects (`tests/api-routes.test.ts`). No server, no port.
- `Readable.toWeb(createReadStream(...))` throws `Controller is already closed` when the browser
  aborts a range request mid-flight, which it does constantly while scrubbing video, and that
  crashed the whole server. `app/api/runs/[id]/files/[...path]/route.ts` builds a pull-based
  `ReadableStream` by hand instead. Keep it that way.
- The SSE route (`/api/runs/[id]/events`) must unsubscribe on `request.signal` abort **and** on
  stream `cancel()`; otherwise every closed tab leaves a listener on the run bus.
- Headless Chrome (Playwright/Lighthouse screenshots) cannot decode H.264, so `<video>` elements
  show a black frame there. That is not a render bug; check the mp4 with `ffprobe` or a real
  browser.
- Caption and title text goes through drawtext `textfile=` with `expansion=none`
  (`lib/render.ts`); never inline user text into a filtergraph.
- Model output occasionally leaks reasoning into caption text. `sanitizePatches` in `lib/loop.ts`
  drops those; `lib/revise.ts` reuses it so revisions behave like the main loop.
- Deterministic lint patches (`lib/lint.ts`) are applied **after** Argon's so a transcript-backed
  caption fix is never overwritten by a model rewrite. Preserve that order.
- `lib/frame-analyst.ts` is the local editor's analysis over the Nebula Frame Analyst webhook
  (`FRAME_ANALYSIS=nebula`). It has no network code beyond an injected `fetch`, so
  `tests/frame-analyst.test.ts` runs offline; keep it that way. When the webhook is configured a failed
  call is a warning/error, never a silent fall back to whisper/ffmpeg: otherwise "did Nebula do this
  cut?" has no honest answer. (Words are the one exception, logged: the agent looks at stills, so
  whisper.cpp transcribes when the analysis carries no words.) Each clip's raw result lands in
  `runs/<id>/analysis/<clip>.json` with `source` (the URL) and `via` (response / poll / callback).
- Nebula's inbound webhook (`api.nebula.gg/webhooks/triggers/<id>/webhook`) authenticates with
  `X-Webhook-Secret` and only acknowledges (`{ success, message }`); the agent posts the result to the
  payload's `callback_url`, served by `app/api/frame-analysis/callback/[job]/[token]/route.ts` from the
  process-wide `callbacks` registry. The callback therefore only works in the server process behind
  `PUBLIC_URL`, not in `scripts/cut.ts`.
- `set_music` is a patch op (`lib/schema.ts`). `lib/loop.ts` applies it through
  `applyMusicPatch` before the cut/caption patches; `lib/patch.ts` also handles it so any other
  `applyPatches` caller gets the same result.

## Chat adapter (Photon Beta 2.0)

- Run creation lives in `lib/intake.ts` (`createRun`). `POST /api/runs` and the chat adapter both call
  it; change intake rules there, not in the route.
- The integration targets Photon's **Beta** platform (app.beta.photon.codes): `pho_prj_…` project id,
  `pho_sk_…` API key, HTTP API at api.photon.codes/v1, Socket.IO events. It is not the Stable
  `spectrum-ts` SDK; do not reintroduce it. Contracts: docs/PHOTON.md, api.photon.codes/openapi.json.
- `lib/photon-handler.ts` has no network code (types only from `@photon-ai/api`). Keep it that way so
  `tests/photon.test.ts` runs without credentials. HTTP, Socket.IO and webhook verification live in
  `lib/photon.ts`; `socket.io-client` is in `serverExternalPackages` (`next.config.ts`).
- The adapter boots from `instrumentation.ts` only when `PHOTON_PROJECT_ID`/`PHOTON_API_KEY` are set.
  In stream mode it holds a Socket.IO connection open from the dev server and checkpoints the replay
  cursor in `PHOTON_CURSOR_FILE`; restarting `next dev` drops the per-chat state (pending clips/brief),
  though runs themselves resume as usual.
- Beta iMessage carries text and images only; the handler sends the mp4 as an attachment on Telegram
  / WhatsApp and as a `PUBLIC_URL/s/<id>` link on iMessage (`Chat.canSendVideo`).
- Chat replies are plain text (iMessage/WhatsApp render no markdown). Strings live in `REPLIES`.
- `node scripts/photon-doctor.mjs` checks credentials, lines and recent messages with plain fetch.

## Lovable / dashboard port notes

- The dashboard (`components/shell/*`) was ported from a Lovable prototype. Lovable previews run on
  their own origin, so anything that used to be an absolute URL is now relative (`/api/runs/...`).
- The greeting name comes from `NEXT_PUBLIC_USER_NAME`; `NEXT_PUBLIC_*` values are inlined at
  build time, so changing them needs a restart of `next dev`.
- `useSyncExternalStore` is used for the time-of-day greeting so server and client render the same
  string; `suppressHydrationWarning` covers a timezone mismatch.

## Test conventions

- `npm test` runs vitest over `tests/**/*.test.ts` (see `vitest.config.mts`). `npm run typecheck`
  and `npm run lint` must both be clean before you hand work back.
- One test file per module (`tests/<module>.test.ts`). Fixtures are real: `tests/fixtures.ts`
  makes tiny mp4s with ffmpeg so the render, proxy and thumbnail code paths are exercised for real.
- Tests that write files use `mkdtempSync` under `os.tmpdir()` and point `RUNS_DIR` there; never
  write into the repo's `runs/`.
- Python tests under `tests/*.py` belong to the legacy prototype in `editor/`; they are not part
  of `npm test`.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
