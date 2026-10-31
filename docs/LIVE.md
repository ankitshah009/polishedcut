# Talk to Argon: the Gemini Live voice assistant

A microphone button in the editor header opens a real-time voice session with Argon about the run on
screen. Argon narrates where the cut stands (status, latest score, failed checks, fixes applied) and
turns a spoken request into a director's note that re-cuts the video.

## How it works

```
browser                         Next.js server                     Gemini
LiveAssistant.tsx               app/api/live/token/route.ts
  |-- getUserMedia (mic)
  |-- POST /api/live/token {runId} --> loadRun(runId)
  |                                   buildSystemInstruction(run)    (lib/live.ts, pure)
  |                                   ai.authTokens.create(...) ---> v1alpha auth_tokens
  |<-- { token, expiresAt, model, systemInstruction }
  |-- ai.live.connect({ apiKey: token }) ==== WebSocket (BidiGenerateContent) ====> gemini-3.8-live
  |    16 kHz PCM mic frames  --->                                   AUDIO replies, 24 kHz PCM  <---
  |    input/output transcription <---
  |    toolCall revise_cut(note) <---
  |-- POST /api/runs/[id]/revise {note}  (202 -> re-cut starts; 409 -> run busy)
  |-- sendToolResponse({ ok, result | error }, scheduling: INTERRUPT)
```

1. **Mic first.** The permission prompt is the slow, visible step. Audio is captured with an
   `AudioWorklet` (a `ScriptProcessorNode` fallback where worklets are missing), resampled to 16 kHz
   when the browser refuses a 16 kHz context, converted to 16-bit little-endian PCM and sent with
   `session.sendRealtimeInput({ audio: { data, mimeType: "audio/pcm;rate=16000" } })`. Up to two
   seconds spoken while the socket is still connecting are buffered and flushed on open.
2. **Token.** `POST /api/live/token { runId }` loads the run, summarises it into the system
   instruction and mints an ephemeral token with `ai.authTokens.create` (Gemini Developer API,
   `httpOptions: { apiVersion: "v1alpha" }`).
3. **Session.** The browser builds `new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: "v1alpha" } })`
   and calls `ai.live.connect({ model: "gemini-3.8-live", config, callbacks })`. `config` is
   `liveConnectConfig(systemInstruction)` from `lib/live.ts`: `responseModalities: ["AUDIO"]`, the
   system instruction, the single `revise_cut` tool, and input and output audio transcription.
4. **Playback and transcript.** Every `serverContent.modelTurn` part with `inlineData` is 24 kHz PCM;
   it is queued gaplessly on a 24 kHz `AudioContext`. `interrupted: true` clears the queue (the user
   talked over Argon). `inputTranscription` and `outputTranscription` build the live transcript;
   `turnComplete` finalises the current lines. A speaking indicator follows the playback queue.
5. **Director's notes.** When the user asks for a change, the model calls `revise_cut(note)`
   (declared `NON_BLOCKING`, so Argon can keep talking). The component POSTs the note to
   `/api/runs/[id]/revise` and returns the outcome with `sendToolResponse(...)` using
   `scheduling: INTERRUPT`, so Argon immediately tells the user whether the note was accepted
   (202) or has to wait (409 while a version is still rendering).
6. **Narrate mode** (on by default, toggle in the panel). Whenever `run.status` or the number of
   versions changes, the component sends a one-line text turn beginning with `Status update:` via
   `sendRealtimeInput({ text })`. The system instruction tells Argon these come from the editor and
   to report them in one sentence. `statusUpdate(run)` in `lib/live.ts` builds the line.
7. **Teardown.** Stop, an error, a server close or unmounting the component closes the session,
   stops the mic tracks and closes both audio contexts.

## Files

| Path | Role |
| --- | --- |
| `lib/live.ts` | Pure, client-safe: `buildSystemInstruction(run)`, `statusUpdate(run)`, `liveConnectConfig(...)`, the `revise_cut` declaration, model and token constants. |
| `app/api/live/token/route.ts` | `POST { runId }` -> `{ token, expiresAt, model, systemInstruction }`. 400 bad body, 404 unknown run, 402 credits exhausted, 503 no key, 502 token service failure. |
| `components/live/LiveAssistant.tsx` | `"use client"` component: button, transcript panel, audio plumbing, tool handling. Props `{ run: Run; className?: string }`. Default and named export. |
| `tests/live.test.ts` | System-instruction builder, status line, session config and the token route's validation against a temp `RUNS_DIR`. No network. |

Mount it in the editor header next to Export:

```tsx
import { LiveAssistant } from "@/components/live/LiveAssistant";
// ...
<LiveAssistant run={run} />
```

## Models

| Purpose | Model |
| --- | --- |
| Voice session (audio in, audio out, tool calls, transcription) | `gemini-3.8-live` (override with `NEXT_PUBLIC_LIVE_MODEL`) |

`gemini-3.8-live` is the low-latency native-audio model. The extended-thinking variant
(`gemini-3.8-live-extended-thinking`) is not used: its background reasoning adds delay for what is a
status-and-notes conversation, and all of the heavy reasoning already happens in the Argon edit loop.

## What Argon knows

The system instruction is built from `run.json` only: product name ("PolishedTake"), the brief, the
status, the latest version's score (passed/total checks), each failed check with its output-timeline
timestamp and note, the fixes applied between versions (patch descriptions and director's notes),
clip count and warnings. The rules say to speak in one or two sentences, to narrate from those facts
only, to call `revise_cut` for change requests, and never to invent checks, scores or fixes. The
instruction is fixed at connect time; narrate mode carries later changes into the session as
`Status update:` turns. Reconnect to refresh the full picture.

## Privacy

- **The API key never reaches the browser.** The server mints an ephemeral token
  (`auth_tokens/...`) and the browser authenticates the WebSocket with that.
- **Tokens are short-lived and single-use.** `uses: 1`, a new session must start within 60 seconds
  (`newSessionExpireTime`), and the session is cut off after 5 minutes (`expireTime`). The response
  is sent with `cache-control: no-store`.
- **Tokens are locked to this assistant.** `liveConnectConstraints` pins the model and the full
  session config (system instruction, tool, modalities, transcription); with no
  `lockAdditionalFields` the server locks every field in that setup, so a captured token cannot be
  turned into a general-purpose Gemini session. (An explicit field mask, `lockAdditionalFields: []`,
  is rejected by the API when the config carries `tools`.)
- **Audio is not stored by the app.** Mic audio streams straight to Gemini and is never written to
  disk or to `run.json`; the transcript lives only in component state. The only durable effect of a
  session is a director's note posted to `/api/runs/[id]/revise`, which is recorded on the run like a
  typed note.
- **Nothing is cached server-side for the voice path.** The Live API is a streaming session; the
  app does not use Files API uploads or `store`-style persistence for it (the edit loop's own uploads
  are documented in the README).

## Limits

- Audio-only sessions last up to 15 minutes without context compression and the WebSocket is
  recycled after about 10 minutes; the token caps a session at 5 minutes anyway. The model sends
  `goAway` shortly before a disconnect; the panel shows it. Press "Talk to Argon" again to continue.
- One token is minted per click; the token route is as rate-limited as the key behind it. A 402 from
  the token service is reported inline with a link to billing.
- Response modality is audio only; the text you see is the API's transcription of that audio.
- Use headphones when demoing: speaker output picked up by the mic reads as an interruption and
  cuts Argon off.
- The run summary is a snapshot at connect time plus narrate-mode updates; per-cut EDL detail
  (exact timecodes of every cut) is not in the instruction, only failed-check timestamps and fixes.
- Ephemeral tokens are a `v1alpha` feature of the Gemini Developer API and are not available on
  Vertex AI.

## Serving polishedcut.vercel.app from the Mac (demo topology, 2026-10-31)

Vercel cannot run the pipeline: no ffmpeg, a read-only filesystem, request-scoped functions and no
process to hold the Photon Socket.IO stream. So production is `next start` on the Mac behind an SSH
reverse tunnel, and the Vercel project `polishedcut` holds a tiny deployment whose only content is a
`vercel.json` rewriting every path to that tunnel. `scripts/live-tunnel.sh` does all of it (build,
server on :3100, serveo.net tunnel, proxy deploy); `status` and `stop` are the other verbs. Redeploying
the Next app itself to Vercel (`vercel --prod` from the repo root) replaces the proxy; rerun the script
to put it back. Cloudflare quick tunnels need outbound port 7844, which is blocked on some networks;
serveo uses port 22. Uploads through the proxy are subject to the tunnel's limits; the demo clips and
the Photon path never traverse it.
