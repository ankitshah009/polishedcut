# PolishedTake: 3-minute live demo

One presenter, one laptop, real phone footage from today. The live run starts at 0:20 and will not be
finished by 3:00, so the middle of the demo walks through a run that finished earlier. That is
deliberate: the finished run is where the v1 to v2 fix is visible, and the live run proves it is not
a recording.

## Before you go on (do this 30 minutes out)

- `npm run dev` is running and `http://localhost:3000` is open. `GEMINI_API_KEY` is set in `.env`.
  `ffmpeg -version` works in the same shell.
- Browser window at least 1100 px wide. The Checks / Fixes / Edit list inspector is hidden on
  narrower screens.
- Sound on, notifications off, zoom 100 percent.
- A Finder window with 3 to 5 phone clips from today, 20 to 90 seconds each, already converted to
  mp4 or mov. Total under five minutes of footage so the live run reaches v1 during the demo.
- At least one **finished run from today** in Past cuts, ideally one that went v1 to v2 (a red dot
  on v1, green on v2). If the last run passed everything on v1, run a harder brief once more
  ("15s teaser, no filler words, captions on, end on the price") to get a fix to show.
- Know which Past cuts entry you will click. It is the fallback for everything.
- If the director's note (`POST /api/runs/:id/revise`) has landed, confirm the note box is visible
  on a finished run and that one note has already produced a new version today.

## Script

Times are cumulative. Lines in quotes are what to say; everything else is what to do.

### 0:00 to 0:20. The problem, on the home page

Home page is up; the latest finished cut is already looping in the monitor on the right.

"I shot today on my phone. I have footage and one sentence about the cut I want, and no editor.
PolishedTake takes both, drafts the edit, renders it, then watches its own render and fixes what it
finds before I ever press play. Let me start one for real and then show you one that finished."

### 0:20 to 0:50. Start the live run

Drag the clips from Finder onto *Drop raw footage* in the left panel. Point at the duration total.

Click the **30s recap** preset, then edit the brief to something only today's footage can satisfy,
for example: `30s recap of the hackathon day. Open on the room, captions on, end on the team at the
table.` Press Cmd+Enter (or *Cut it*).

The run page opens. Point at the stepper: Transcribe, Draft, Render, Watch, Fix.

"Right now gemini-3.5-transcribe is giving every clip a word-timed transcript. Then
gemini-4-argon sees all the clips as video, plus the transcripts, plus my brief, in one context,
and writes the edit list. That is the only thing it needs to know about editing: where the words
are, so it never cuts inside one. Argon says the first version lands in about a minute. While it
works, here is one that finished."

### 0:50 to 1:50. The finished run: v1 fails, v2 passes

Click the chosen entry under **Past cuts**.

1. **Version tabs** (top left of the viewer). Point at `v1` with its red dot and score, e.g. `7/11`,
   and `v2` with its green dot and `11/11`.
   "Each version is a real render. The score is how many of Argon's checks passed when it watched
   that render."

2. Make sure `v1` is selected. Open the **Checks** tab on the right. Scroll to a failing check with
   a timestamp, for example *no mid-sentence or mid-word cuts*.
   "Every line of my brief became a named check, plus craft checks: caption sync, mid-word cuts,
   jump cuts, duration. Argon watched the mp4 ffmpeg produced, not its own plan, and timestamped
   the failures."

3. Click the **play button with the timestamp** on that failing check. The playhead jumps there.
   Press space to hear the clipped word, then space again.
   "That is the cut landing inside a word. Argon found it at 0:17.3 in the output."

4. Point at the **timeline** at the bottom: the V1 filmstrip, the C1 caption blocks, and the red
   diamond on the **QA** track under the playhead. Then the matching red tick on the scrub bar.
   "Every failure is a mark on the QA track. Ctrl+scroll zooms in on it."

5. Open the **Fixes** tab.
   "Argon does not rewrite the edit. It emits small patches against the cut ids: trim c2 to start
   at 40.5 seconds, move a caption, drop a cut. Here is the before and after for each one. These
   were applied to make v2."

6. Click `v2`. Green dot, all checks pass. Open **Checks** to show the brief checks all green.
   Press space to play two or three seconds across the fixed cut.
   "Same footage, one patch, and now it checks out. If v2 had failed, there would be a v3; then it
   stops and tells me."

Judges should notice: the checks name the brief's own words; failures carry an output time that the
UI can seek to; the fix is a diff, not a re-generation.

### 1:50 to 2:20. The director's note

If `POST /api/runs/:id/revise` has landed: type a one-line note on the finished run, for example
`Lose the second interview, hold the final shot a second longer`, and send it. Point at the new
version appearing as a tab with the note shown as its reason.

"The loop is autonomous, but I stay the director. A note is a brief for the next version, applied
to this edit rather than a restart. Nothing here publishes anywhere. The final file is a download I
choose."

If the route has not landed: skip the typing and say the second paragraph while pointing at the
**Export v2** button, then move on. Do not describe the note as working.

### 2:20 to 2:50. Back to the live run

Click the live run in Past cuts (it shows a spinner and *Drafting* / *Rendering* / *Reviewing*).

- If `v1` exists with a critique: open **Checks**. "This is the run I started two minutes ago, on
  footage from this room. Argon has watched v1." Read one passing brief check out loud.
- If `v1` exists but Argon is still watching: show the *Argon is watching v1* panel and the render
  playing. "The render exists; the review is in flight."
- If it is still drafting: show the stepper and say what stage it is on. "Four phone clips,
  one context, and it is writing the edit list."

Either way, point at the status pill in the header: it is streaming over Server-Sent Events.

### 2:50 to 3:00. Close

"Footage in, a cut with receipts out. Every model call is `store: false`, so nothing is retained
server-side, and the footage and renders stay in a folder on this laptop. The code was written
today."

Stop. Leave the run page up; it will finish on its own during questions, and you can click **Export**
then.

## Fallbacks

**The API is slow or a stage stalls.** Say "it is still transcribing" and move to the finished run
at 0:50 as scripted. Do not wait on the live run at any point. If it has not produced v1 by 2:20,
spend that time on the `/how` page instead: click **How it works** in the sidebar; it explains each
stage with data from the latest finished run.

**The live run errors.** The run page shows a red banner with the error and keeps any finished
version below it. Say "that is the error surfacing instead of a silent bad cut" and go to Past cuts.

**The upload is rejected** (not a video, no brief): the error text appears under the brief. Fix it
and press Cut it again. Re-cutting the same clips usually skips the model upload step because
uploads are cached by content hash.

**No finished run shows a fix.** Use the finished run anyway: Checks shows 11/11 with timestamps
you can seek to, and the Fixes tab reads "Nothing to fix in v1. Every check passed." Say: "This one
passed first time; the loop is insurance you can see, not a step you have to trust." Then open
`/how`, which has a static v1 to v2 example when no live fix exists.

**The dev server is down.** `npm run dev` in the repo and reload. Runs are files under `runs/`, so
nothing is lost; the finished run is still in Past cuts.

**Everything is down.** A screen recording of a finished run lives wherever you saved it before the
demo; record one at the 30-minute mark. Say that it is a recording.

## Keyboard reference

- Space: play or pause. Left / Right: step one frame. Shift+Left / Right on the scrub bar: one second.
- Ctrl+scroll (or Cmd+scroll) over the timeline: zoom around the cursor. `=` and `-` also zoom.
- Cmd+Enter in the brief box: start the cut.
