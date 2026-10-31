# Scaling: any footage, and the handshake with Google

What the pipeline does with arbitrary input, where the limits are, and how a run's footage moves
through the Gemini Files API and back out again. Every knob named here lives in `lib/config.ts` and
`.env.example`.

## 1. Any video in

The upload route (`app/api/runs/route.ts`) accepts whatever ffmpeg can decode. Each file is saved,
then probed once (`probeMedia` in `lib/media.ts`: duration, coded size, rotation, fps, audio, codec,
pixel format) before anything else happens.

| Input | What happens |
| --- | --- |
| mp4 / mov / mkv / webm / m4v, h264 / hevc / prores / vp9 / av1 | decoded by ffmpeg, re-encoded to an h264 proxy |
| 10-bit, 4:2:2, 4:4:4 (`yuv420p10le`, `yuv422p10le`, ...) | proxy is `format=yuv420p` 8-bit |
| variable frame rate phone footage, 24 / 25 / 50 / 60 fps | proxy is re-timed to `PROXY_FPS` (30) constant, timestamps preserved |
| odd frame sizes (639x361) | proxy edges are rounded down to even |
| rotation metadata (phones record landscape frames + a 90 degree display matrix) | ffmpeg autorotate applies it before every filter; `probeMedia().rotation` and `displaySize()` expose it |
| no audio stream | the proxy and the render get a silent stereo track (`anullsrc`) |
| several audio / subtitle / data streams | only the first video and first audio stream are mapped (`-map 0:v:0 -map 0:a:0?`, `-sn -dn`) |
| stills (jpg / png / webp / heic) | turned into a `PHOTO_SECONDS` Ken Burns clip **at the run's output size** |
| bytes that are not a video | **400** `X is not a video ffmpeg can read` and the run directory is removed |

Limits enforced at upload, all configurable:

- `MAX_UPLOAD_BYTES` (2 GiB): the whole multipart body; over it -> **413** before the body is read.
- `MAX_CLIP_SECONDS` (1800 = 30 min): one clip; over it -> **400** naming the clip and the limit.
- `MAX_TOTAL_SECONDS` (7200 = 2 h): all clips of one run together (photos count `PHOTO_SECONDS`) -> **400**.

Why these defaults: a 30-minute 854x480 proxy at CRF 28 is roughly 150-300 MB, far below the Files API's
2 GB per file, and two hours of footage keeps one run's proxies well inside the 20 GB project quota even
with several runs in flight.

## 2. Output size follows the footage

There is no fixed output size any more. `chooseOutput(clips, brief)` (`lib/media.ts`) weighs the
clips' display orientation by duration:

| Footage | Output |
| --- | --- |
| landscape majority | 1920x1080 |
| portrait majority (phone verticals) | 1080x1920 |
| square majority | 1080x1080 |

The brief can force it: "vertical", "portrait", "9:16", "Reels", "TikTok", "Shorts", "story" ->
portrait; "square", "1:1" -> square; "landscape", "16:9", "widescreen", "YouTube" -> landscape;
"4K" / "UHD" -> 3840x2160 (2160x3840 for a vertical). fps is `OUTPUT_FPS` (30).

Where it is applied:

- `EditorModel.draft(brief, clips, output?)`: without `output`, the proxies are probed and
  `chooseOutput` sets `edl.width/height/fps`. The loop owner can pass an explicit size.
- The upload route uses the same function so photo clips are rendered at the run's size.
- `renderEdl` works at any even size: every cut is scaled to fit and letter/pillarboxed, so mixed
  landscape and portrait sources in one cut all land upright on the chosen frame.
- Proxies keep their orientation: `PROXY_LONG_EDGE` (854) is the long edge, so a vertical is 480x854.
- Thumbnail sprites stay 16:9 strips (160x90 frames) with the rotated source pillarboxed inside.

`OUTPUT_WIDTH`/`OUTPUT_HEIGHT` remain only as the fallback when nothing can be probed and the brief
says nothing (and for the companion generators that still read `OUTPUT`).

## 3. The Google handshake

### Concurrency gate

Every request to Google, Interactions and Files API alike, passes through one process-wide gate
(`geminiGate`, `createGate` in `lib/gemini.ts`) of `GEMINI_CONCURRENCY` slots (default 4). A run with
twenty clips transcribes them "in parallel" from the loop's point of view, but only four requests are
ever in flight, so one 429 cannot turn into a storm of them. The gate wraps the request only, never the
retry back-off, so a call that is waiting to retry holds no slot.

### Retries and Retry-After

`withRetry` retries 429 / 5xx / transport failures / empty replies up to 4 times with 0.5 s, 1 s, 2 s,
4 s jittered back-off. When the server says how long to wait, that wins if longer: a `Retry-After`
header (seconds or HTTP date) on the error or its response, or the text Google puts on 429s
("Please retry in 23.4s", `"retryDelay": "23s"`). The wait is capped at `RETRY_AFTER_MAX_MS` (60 s).
HTTP 402 is never retried and surfaces as "credits are exhausted". 400 / 401 / 403 / 404 are never retried.

### Files API lifecycle (upload -> ACTIVE -> use -> delete)

```
proxy.mp4 ──sha256──► .upload_cache.json hit? ──files.get ACTIVE?──► reuse handle
          │                                                            │
          └─ miss ──► files.upload ──► PROCESSING … poll every 3 s ──► ACTIVE ──► interactions.create(store:false)
                                   │                                                        │
                                   ├─ FAILED ─► error "Files API rejected X (reason)"       │
                                   └─ still PROCESSING after LLM_TIMEOUT_MS ─► error        ▼
                                                                run ends ──► files.delete for every handle in runs/<id>/uploads.json
                                                                             + the matching .upload_cache.json entries are dropped
```

1. **Upload.** Proxies (never originals) are uploaded with `files.upload`, de-duplicated by sha256
   through `RUNS_DIR/.upload_cache.json`, so a retried or revised run re-uses an upload that is still
   ACTIVE. A cache hit is verified with `files.get` first; a deleted or expired file falls through to a
   fresh upload.
2. **ACTIVE.** The file is polled every 3 s. `FAILED` raises a clear error carrying Google's reason;
   still `PROCESSING` after `LLM_TIMEOUT_MS` (15 min) raises one that names the variable to raise.
3. **Use.** Every Interactions call (Argon draft / critique, Flash / transcribe, Flash-Lite brief
   analysis, Nano Banana, Omni, Lyria) is sent with `store: false`: Google keeps neither the prompt nor
   the output beyond the request.
4. **Delete.** Each upload a run makes is recorded in `runs/<id>/uploads.json` (the registry; the run id
   is passed in by `jobs.ts` or inferred from the file's path under `RUNS_DIR/<id>/`). When the run
   reaches a terminal state, `cleanupRunUploads(runId)` calls `files.delete` for every handle and drops
   their cache entries, unless `KEEP_UPLOADS=1`. A 404 counts as deleted; anything else stays in the
   registry for the next attempt (a retry or a revision ends in a terminal state again). A revision
   after cleanup simply uploads the proxies again.

Real Files API limits (as of this writing): **2 GB per file**, **20 GB per project**, files are kept
for **48 hours** and then deleted by Google regardless. Uploads are free; only tokens are billed, and
each call's token usage is recorded on the run for `/api/usage`.

### Local state and server restarts

`ORPHAN_AFTER_MS` (90 s) is how long an in-progress run's `run.json` may stay quiet with no loop behind
it in this process before it is shown as "Interrupted"; on boot such runs are resumed, re-using proxies,
thumbnails, transcripts and still-ACTIVE uploads.

## 4. Knobs

| Variable | Default | Effect |
| --- | --- | --- |
| `PROXY_LONG_EDGE` | 854 | long edge of the proxies the model watches (never upscales) |
| `PROXY_FPS` | 30 | constant frame rate of the proxies |
| `MAX_CLIP_SECONDS` | 1800 | one clip's length limit, 400 at upload |
| `MAX_TOTAL_SECONDS` | 7200 | footage per run, 400 at upload |
| `GEMINI_CONCURRENCY` | 4 | Google requests in flight per process |
| `KEEP_UPLOADS` | 0 | 1 keeps a run's Files API uploads after it ends |
| `ORPHAN_AFTER_MS` | 90000 | quiet in-progress run -> "Interrupted" |
| `LLM_TIMEOUT_MS` | 900000 | per model call and per upload to become ACTIVE |

Invalid values fall back to the default with a warning at startup.

## 5. What is verified by tests (real ffmpeg, fake Gemini client)

- `tests/media.test.ts`: one-call probe (10-bit HEVC in mkv, rotation side data, stills); proxies keep
  portrait orientation (1080x1920 -> 480x854), rotated landscape frames come out upright, silent clips
  get audio, odd 10-bit 24 fps sources become even 8-bit h264 30 fps without upscaling; `chooseOutput`
  for every orientation, duration weighting, rotation and brief overrides (incl. 4K and no false positives).
- `tests/render.test.ts`: 1080x1920 and 1080x1080 renders from mixed sources, rotation metadata upright,
  odd sizes rejected.
- `tests/gemini-handshake.test.ts`: the gate caps in-flight uploads and interactions at
  `GEMINI_CONCURRENCY`; Retry-After parsing and honouring; FAILED / unknown / stuck-PROCESSING uploads;
  the registry; `deleteUploads` calls `files.delete` for every handle, drops cache entries, treats 404 as
  deleted and keeps failures; `KEEP_UPLOADS=1`; draft's default output size from real proxies and the brief.
- `tests/api-routes.test.ts`: 400 for non-video bytes, over `MAX_CLIP_SECONDS`, over `MAX_TOTAL_SECONDS`;
  201 for 10-bit odd-sized silent "mkv"; a portrait photo becomes a 1080x1920 clip.
- `tests/config.test.ts`: every knob above, defaults and validation.
