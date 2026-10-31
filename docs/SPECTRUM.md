# Chat front door: Photon Spectrum

Framecut's editing loop (draft -> render -> critique -> patch) does not care where the footage came
from. `lib/intake.ts` is the one place a brief and files become a run, and two callers use it:

- the dashboard upload, `POST /api/runs` (`app/api/runs/route.ts`)
- the chat adapter, `lib/spectrum-handler.ts`, fed by Photon Spectrum (`lib/spectrum.ts`)

[Photon](https://photon.codes) puts one agent behind iMessage, WhatsApp, Telegram and Slack through a
single SDK, `spectrum-ts`. A person texts a clip and a one-line brief to the agent's number; the same
pipeline cuts it; the finished mp4 comes back in the same chat. Replies carry a director's note.

## What a conversation looks like

```
you:  [IMG_4021.MOV] [IMG_4022.MOV]
bot:  Got 2 clips. What's the cut? One line is plenty.
you:  30s recap with captions, open on the strongest moment
bot:  On it: cutting 2 clips to "30s recap...". This takes a few minutes; I'll text you the video.
      ... (typing indicator while the loop runs; the dashboard shows the run live too)
bot:  [framecut-3f9a2b1c7d.mp4]
bot:  Here's "Hack Night". I rendered 2 versions and fixed what my own review flagged before
      sending this one. Reply with a note and I'll revise it. Every version and the critique
      behind each change: https://<PUBLIC_URL>/s/3f9a2b1c7d
you:  tighter, lose the second shot
bot:  Applying your note: "tighter, lose the second shot". Give me a minute.
bot:  [framecut-3f9a2b1c7d.mp4]  ...
```

Order does not matter: brief first then clips also works. Clips and the brief are collected per
chat (per "space": a DM or a group) and the cut starts `SPECTRUM_SETTLE_MS` after the last piece
arrives, so a multi-clip send is not split into several runs. One cut per chat at a time; a message
during a cut gets "I'm still working on your last cut."

Replies are plain text on purpose: iMessage and WhatsApp render no markdown.

## Setup (10 minutes)

1. Sign up at [app.photon.codes](https://app.photon.codes), create a project, and under **Settings**
   copy the project id and secret. Provision an iMessage line in the dashboard (hackathon teams:
   ask the Photon sponsors for a line and credits; integration support is ryan@photon.codes).
2. In `.env`:
   ```
   SPECTRUM_PROJECT_ID=...
   SPECTRUM_PROJECT_SECRET=...
   SPECTRUM_PLATFORMS=imessage
   PUBLIC_URL=https://your-app.example   # optional, adds the "watch every version" link
   ```
3. `npm run dev`. The server log shows `[spectrum] listening on imessage (stream mode)`.
   `GET /api/spectrum/webhook` returns `{ enabled, mode, platforms }` for a quick check.
4. Text the line a clip and a brief.

Nothing else is needed. **Stream mode** (`SPECTRUM_MODE=stream`, the default) holds a connection
open from the Next.js process to Spectrum Cloud, so the laptop running `next dev` behind hotel Wi-Fi
is enough: no public URL, no tunnel. It starts from `instrumentation.ts`, next to the
resume-interrupted-runs hook, and reconnects after 10 s if the stream drops.

### More platforms

Add them to `SPECTRUM_PLATFORMS` with their credentials (see `.env.example`):

| platform            | needs                                                                          |
| ------------------- | ------------------------------------------------------------------------------ |
| `imessage`          | a line on the Spectrum project (nothing in `.env`)                             |
| `telegram`          | `SPECTRUM_TELEGRAM_BOT_TOKEN` from @BotFather                                  |
| `whatsapp-business` | `SPECTRUM_WHATSAPP_BUSINESS_ACCESS_TOKEN`, `..._PHONE_NUMBER_ID` (Meta Cloud API) |
| `slack`             | `SPECTRUM_SLACK_TOKENS` as JSON `{ teamId: botToken }`                          |
| `terminal`          | nothing: a local chat TUI from Photon for trying the flow without a phone       |

The handler is platform-agnostic; `run.source` records which one the footage came from.

### Webhook mode (for a deployment with a public URL)

`SPECTRUM_MODE=webhook` turns the stream off. Register `https://<host>/api/spectrum/webhook` in the
Spectrum dashboard, put the signing secret it shows once in `SPECTRUM_WEBHOOK_SECRET`, and Spectrum
Cloud POSTs every inbound message there. The SDK verifies `X-Spectrum-Signature` (HMAC-SHA256 over
the raw body, 5-minute replay window) and the route answers 401/400 to anything unsigned or stale.

Webhook handlers run after the HTTP response, so the host must keep the process alive while the cut
renders. That is true of any host that can run this app at all (the loop is in-process and needs
ffmpeg); it rules out request-scoped serverless functions, as does the rest of the pipeline.

## Design notes

- `handleInbound(space, message, deps, builders)` in `lib/spectrum-handler.ts` is the whole
  conversation; `deps` (createRun, waitForRun, startRevision, renderFor) and `builders`
  (`attachment()`) are injected, so `tests/spectrum.test.ts` drives it with plain objects and never
  loads the SDK. The SDK is imported dynamically in `lib/spectrum.ts` only when credentials exist.
- Deliveries are at-least-once on both paths; message ids are deduped in a bounded set.
- The adapter waits on the store's run bus (`subscribe` in `lib/store.ts`), the same event source as
  the dashboard's SSE stream, so the chat and the UI see the same moment of completion.
- Inbound attachments are read with the SDK's `read()` into a `File`, so `createRun` sees exactly
  what a browser upload would: same probing, same limits, same photo-to-clip conversion.
- Renders above `SPECTRUM_MAX_ATTACHMENT_BYTES` (iMessage rejects very large files) are not attached;
  the reply links to `/s/<id>` instead when `PUBLIC_URL` is set.
- Without `GEMINI_API_KEY` the run records the missing key and the chat reply says so; the adapter
  never crashes the app. Everything Spectrum-related is off when `SPECTRUM_PROJECT_ID` is unset.
