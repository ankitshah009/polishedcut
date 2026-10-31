# Chat front door: Photon (Beta 2.0)

PolishedCut's editing loop (draft -> render -> critique -> patch) does not care where the footage
came from. `lib/intake.ts` is the one place a brief and files become a run, and two callers use it:

- the dashboard upload, `POST /api/runs` (`app/api/runs/route.ts`)
- the chat adapter, `lib/photon-handler.ts`, fed by Photon (`lib/photon.ts`)

[Photon](https://photon.codes) puts one agent behind iMessage, Telegram, WhatsApp Business and SMS.
A person texts a clip and a one-line brief to the agent's number; the same pipeline cuts it; the
finished mp4 (or a link to it) comes back in the same chat. Replies carry a director's note.

## Which Photon

Photon runs two platforms with different credentials and APIs:

| | Stable | **Beta (2.0)** — what this repo targets |
| - | - | - |
| Dashboard | app.photon.codes | **app.beta.photon.codes** |
| Credentials | project id + project secret | **`pho_prj_…` project id + `pho_sk_…` API key** |
| SDK | `spectrum-ts` (gRPC to `*.spectrum.photon.codes`) | **HTTP API `https://api.photon.codes/v1` (`@photon-ai/api` types) + Socket.IO events** |
| Docs | docs.photon.codes/spectrum-ts | **photon.codes/docs/beta** |

Verified against: [Beta overview](https://photon.codes/docs/beta), [Set up your project](https://photon.codes/docs/beta/get-started/project),
[Build an iMessage agent](https://photon.codes/docs/beta/get-started/imessage), [API reference](https://photon.codes/docs/beta/api-reference),
[API client](https://photon.codes/docs/beta/api-client), [Event delivery over Socket.IO](https://photon.codes/docs/beta/websocket)
(connect, session, events, cursors, frames), and the machine contracts
[`openapi.json`](https://api.photon.codes/openapi.json) / [`asyncapi.yaml`](https://api.photon.codes/asyncapi.yaml).

**Beta limits that matter here.** Photon's own docs: "Beta is a preview"; iMessage on Beta supports
only text and images. So on iMessage the finished video is delivered as a link (`PUBLIC_URL/s/<id>`),
and the clips themselves should be sent over Telegram or WhatsApp Business, where MP4 travels as an
attachment both ways. Shared iMessage lines are DM-only and the person must text first.

## What a conversation looks like

```
you:  [IMG_4021.MOV] [IMG_4022.MOV]
bot:  Got 2 clips. What's the cut? One line is plenty.
you:  30s recap with captions, open on the strongest moment
bot:  On it: cutting 2 clips to "30s recap...". This takes a few minutes; I'll text you the video.
      ... (typing indicator while the loop runs; the dashboard shows the run live too)
bot:  [polishedcut-3f9a2b1c7d.mp4]
bot:  Here's "Hack Night". I rendered 2 versions and fixed what my own review flagged before
      sending this one. Reply with a note and I'll revise it. Every version and the critique
      behind each change: https://<PUBLIC_URL>/s/3f9a2b1c7d
you:  tighter, lose the second shot
bot:  Applying your note: "tighter, lose the second shot". Give me a minute.
bot:  [polishedcut-3f9a2b1c7d.mp4]  ...
```

Order does not matter: brief first then clips also works. Clips and the brief are collected per
chat (per "space": a DM or a group) and the cut starts `PHOTON_SETTLE_MS` after the last piece
arrives. One cut per chat at a time; a message during a cut gets "I'm still working on your last cut."

Replies are plain text on purpose: iMessage and WhatsApp render no markdown.

## Setup (10 minutes)

1. Sign in at [app.beta.photon.codes](https://app.beta.photon.codes). In the project: **Settings**
   -> copy the Project ID (`pho_prj_…`); **API keys** -> **New API key** with `project:read` and
   `project:write` (add `platforms:read` if you want the doctor to list lines) -> copy the `pho_sk_…`
   key (shown once).
2. Connect a channel in the dashboard: **Telegram** (a bot token from @BotFather) or **WhatsApp
   Business** for video both ways; **iMessage** (add your own number as the sender, assign a shared
   line) for text + images, video back as a link.
3. In `.env`:
   ```
   PHOTON_PROJECT_ID=pho_prj_...
   PHOTON_API_KEY=pho_sk_...
   PUBLIC_URL=https://polishedcut.vercel.app   # the "watch every version" link, and the video on iMessage
   ```
4. `node scripts/photon-doctor.mjs` proves the key, the project and the lines; `--watch` tails
   received messages while you text the line; `--reply <messageId> "text"` answers one by hand.
5. `npm run dev`. The log shows `[photon] listening on project pho_prj_… (stream mode …)`.
   `GET /api/photon/webhook` returns `{ system, enabled, mode }` for a quick check.
6. Text the line a clip and a brief.

**Stream mode** (`PHOTON_MODE=stream`, the default) holds a Socket.IO connection from this process
to `https://api.photon.codes/v1/projects/<id>/events/ws` (websocket transport, Bearer key in the
handshake headers). On every connect it sends `subscribe { startSeq }` with the cursor saved in
`PHOTON_CURSOR_FILE`; each `delivery` carries the public event object plus `{ seq, replyExpected }`.
Events are handled one at a time and the cursor advances only after the handler succeeds, so a
crash replays unfinished work (deliveries are at-least-once; message ids are deduped). The Mac
running `next dev` is enough: no public URL, no tunnel.

### Webhook mode (for a deployment with a public URL)

`PHOTON_MODE=webhook` turns the stream off. Create a webhook destination on the project
(`POST /v1/projects/{id}/webhooks/destinations` with `url: https://<host>/api/photon/webhook`,
`apiVersion`, `enabledEvents`), keep the `signingSecret` it returns once in `PHOTON_WEBHOOK_SECRET`.
The route verifies `X-Photon-Signature` (`v0=` HMAC-SHA256 over `v0:{timestamp}:{raw body}`) and
`X-Photon-Timestamp` (5-minute window), answers 202 at once and handles the event after the
response (`after()` from `next/server`). The signature scheme matches Photon's published webhook
tooling; confirm it against the first real delivery (the route logs refusals) before relying on it.

Webhook handlers must outlive the HTTP response for as long as the cut renders, so the host must
keep the process alive; request-scoped serverless functions cap that, as does the rest of the
pipeline (in-process loop, ffmpeg). Stream mode on a machine you control is the recommended way.

## How a message becomes a run

1. A `message.*` event arrives. `messageIdFromEvent` pulls the message id; unless the event embeds
   the full message, `GET /messages/{id}` reads the canonical `Message` (so payload layout changes
   never reach the handler). Only `status: "received"` messages are handled.
2. `content` is `text`, `attachment { attachmentId }` or `group { parts }`. Each attachment is
   resolved with `GET /attachments/{id}` (contentType, filename, sizeBytes) and read with
   `GET /attachments/{id}/content` into a `File`, so `createRun` sees exactly what a browser upload
   would: same probing, same limits, same photo-to-clip conversion.
3. Replies go to the same space: `POST /messages { spaceId, senderId: receivedBy.id,
   parentMessageId, content }` with an `idempotency-key`. Typing is `POST /spaces/{id}/typing`.
4. The render is uploaded with `POST /attachments` (multipart/related: JSON
   `{ contentType, sizeBytes, filename }` + bytes) and sent as `content: { type: "attachment",
   attachmentId }`. Over `PHOTON_MAX_ATTACHMENT_BYTES`, or on a platform that cannot carry video
   (Beta iMessage), the reply links to `/s/<id>` instead.

## Design notes

- `handleInbound(chat, message, deps)` in `lib/photon-handler.ts` is the whole conversation; `chat`
  (sendText / sendFile / setTyping) and `deps` (createRun, waitForRun, startRevision, renderFor,
  resolveAttachment) are injected, so `tests/photon.test.ts` drives it with plain objects and never
  touches the network. The HTTP and Socket.IO code lives only in `lib/photon.ts`.
- The adapter waits on the store's run bus (`subscribe` in `lib/store.ts`), the same event source as
  the dashboard's SSE stream, so the chat and the UI see the same moment of completion.
- Without `GEMINI_API_KEY` the run records the missing key and the chat reply says so; the adapter
  never crashes the app. Everything Photon-related is off when `PHOTON_PROJECT_ID` is unset.
