# PolishedTake: pitch and judge Q&A

## 90-second verbal pitch

I shot today on my phone. I have footage and one sentence describing the cut I want, and no editor.
That is the person this is for: me, this afternoon, and every creator whose footage exists but whose
edit does not.

PolishedTake takes the clips and the sentence. gemini-3.5-transcribe gives every clip a word-timed
transcript. Then gemini-4-argon sees every clip as video, plus every transcript, plus the brief, in
one context, and writes an edit decision list: which seconds of which clip, in what order, with
captions placed on the output timeline. ffmpeg renders it.

Then the part that needed Argon. It watches the render it did not make by hand, and grades it. Every
line of the brief becomes a named check. The craft checks are the ones a human editor does by
feel: did a cut land inside a word, are the captions in sync with what is said, is there a jump
cut, is it the length I asked for. Each failure carries a timestamp on the output timeline. Each one
comes with a patch against a specific cut id: trim c2 to start at 40.5 seconds. The patches are
applied, it renders again, it watches again. Up to three versions, or until every check passes.

You see all of it. v1, v2, v3 side by side with their scores. Click a failing check and the player
jumps to that second. The timeline has a QA track with a mark at every failure. The Fixes tab shows
each patch before and after. Nothing is published; the final file is a download you choose, and
every model call is sent with store false.

It is a cut that checked its own work, and showed you the receipts. Written today.

## Likely questions

**What does a run cost?**
Count calls, not guesses. One transcription call per clip, one Argon draft call, and one Argon
critique call per version, so at most four Argon-class calls per run plus the transcriptions. Video
is billed by duration, so the inputs that matter are total source minutes (seen once in the draft
and described as transcript text in every call) and the length of each render (watched once per
version). Proxies are 480p and cached by content hash, so re-cutting the same footage does not
upload twice. No cost is incurred outside the model calls; rendering is local ffmpeg.

**What leaves the machine, and what is kept?**
Only what the model has to watch: 480p proxies of the source clips and the 720p renders, uploaded
through the Files API. Originals never leave the laptop. Every Interactions API call is sent with
`store: false`, so the interaction is not retained server-side. Footage, renders and the run record
live in a local `runs/` directory. There are no accounts and no third-party services. The honest
caveat: the app does not delete its uploads from the Files API.

**What does Argon do here that Flash could not?**
Two things the code depends on. First, the draft holds every clip as video and every transcript in
one context and has to reason across them to pick ranges that satisfy a free-text brief and land on
word boundaries. Second, the critique has to watch a rendered video, decide pass or fail on each
requirement, localize each failure to a second, and express the fix as a structured patch against
an existing cut id. Both run with `thinking_level: medium`. Flash is in the stack where it fits: as
the fallback transcriber. We did not run a formal comparison today; the claim is about what the
loop asks the model to do, not a benchmark.

**Why not just prompt once and render?**
Because the EDL is a plan and the render is the truth. Caption drift, a cut that clips a word, a
jump cut: none of those exist until ffmpeg has produced a file, and the only way to know is to watch
it. One prompt gives you a cut you have to trust. The loop gives you a cut with a list of named
checks, each one tied to a second you can jump to. Sometimes v1 passes everything, and then the
checks are the evidence that it did; the finished run from this afternoon passed 11 of 11 first
time, and you can see why.

**What if Argon's review is wrong?**
It is a model judgment and it can be wrong in both directions, so it is never the only check. A
deterministic lint (`lib/lint.ts`, being added today) computes from the word-timed transcripts the
things that can be computed: a cut inside a word, a caption whose text does not match the words
spoken at that output time. Those appear as checks alongside Argon's. And the person is in the
loop: every check, every patch with before and after, and every skipped patch is on screen. If you
disagree, you pick a different version to export or send a director's note.

**How do people stay in control?**
The loop acts only on files in a local folder. It never posts, publishes, sends or spends. It stops
at three versions. Patches that would break the edit are skipped and listed as warnings, not
silently applied. Export is a manual download of the version you choose. A director's note
(`POST /api/runs/:id/revise`, in progress today) is the human steer: a sentence that becomes the
brief for the next version instead of a restart.

**How long does it take?**
First version in about a minute for a few short phone clips: proxy, transcribe, draft, render,
watch. Each extra version is a render, an upload and one Argon call. Long clips make it slower
mainly because the transcripts go into every prompt. The UI streams every stage over Server-Sent
Events so you see where it is.

**What is deliberately not built?**
Hard cuts only. No transitions, music, audio ducking or colour. One caption style, burned in with
ffmpeg drawtext. No multi-user, no auth, no database; `runs/` is a directory. The Remotion player
preview is optional and not on the demo path.

**Why ffmpeg rather than a video API or Remotion for the render?**
ffmpeg is deterministic, local, free, and fast enough that re-rendering three times is cheap. It
also means the thing Argon critiques is exactly the file the user downloads.

**What happens when a patch is bad?**
`applyPatches` is a pure function. Each patch is applied to a copy; one that fails (unknown cut id,
missing fields) is rolled back and reported. Cuts are clamped to clip bounds and anything shorter
than 0.3 seconds after clamping is dropped and reported. If Argon returns failures with no patches,
the loop stops early and the warning says so.

**Was this all built today?**
Yes. Four commits from an empty folder, on October 25, 2026. The legacy FastAPI prototype from the
morning is kept in `editor/` and `web/`; the Next.js app is the supported path.
