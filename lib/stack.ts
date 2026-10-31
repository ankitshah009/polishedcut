// Which Google models PolishedCut uses, read from the same constants the pipeline calls, plus evidence
// from the runs on disk that each one has actually done its job. Server-only.
import { existsSync } from "node:fs";
import path from "node:path";

import { BRIEF_MODEL } from "./brief";
import { ART_MODEL } from "./art";
import { OMNI_MODEL } from "./broll";
import { MODELS, runDir } from "./config";
import { LIVE_MODEL } from "./live";
import { LYRIA_MODELS } from "./music";
import { listRuns } from "./store";

export interface StackEntry {
  /** Model ids exactly as the code calls them. */
  models: string[];
  name: string;
  stage: string;
  role: string;
  /** What the runs on disk prove, e.g. "title art painted in 4 cuts", or null when nothing is stored. */
  evidence: string | null;
  /** Calls recorded in run usage for these models. */
  calls: number;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export async function stackStatus(): Promise<StackEntry[]> {
  const runs = await listRuns();
  const has = (id: string, rel: string | undefined) => !!rel && existsSync(path.join(runDir(id), rel));
  const calls = (match: (m: string) => boolean) =>
    runs.reduce((n, r) => n + (r.usage ?? []).filter((u) => match(u.model)).length, 0);
  const runsWith = (pred: (r: (typeof runs)[number]) => boolean) => runs.filter(pred).length;
  const stage = (r: (typeof runs)[number], s: string) => (r.timings ?? []).some((t) => t.stage === s);

  const transcribedClips = runs.reduce((n, r) => n + r.clips.filter((c) => c.transcript.length > 0).length, 0);
  const words = runs.reduce((n, r) => n + r.clips.reduce((m, c) => m + c.transcript.length, 0), 0);
  const watched = runs.reduce((n, r) => n + r.iterations.filter((i) => i.critique).length, 0);
  const notes = runs.reduce((n, r) => n + r.iterations.filter((i) => i.note).length, 0);
  const rendered = runs.reduce((n, r) => n + r.iterations.filter((i) => has(r.id, i.video)).length, 0);
  const art = runsWith((r) => has(r.id, "title.png") || has(r.id, "end.png"));
  const music = runsWith((r) => r.iterations.some((i) => has(r.id, i.edl.music?.file)));
  const shots = runs.reduce((n, r) => n + r.clips.filter((c) => /^g\d+$/.test(c.id) && has(r.id, c.path)).length, 0);
  const analyzed = runsWith((r) => stage(r, "analyze"));

  return [
    {
      models: [MODELS.transcribe, MODELS.flash],
      name: "Gemini 3.5 Transcribe",
      stage: "Transcribe",
      role: `Word-level timestamps for every clip, with ${MODELS.flash} as the fallback. Every caption is checked against these words.`,
      evidence: transcribedClips ? `${plural(transcribedClips, "clip")} transcribed, ${words.toLocaleString()} words timed` : null,
      calls: calls((m) => m === MODELS.transcribe),
    },
    {
      models: [BRIEF_MODEL],
      name: "Gemini 3.5 Flash-Lite",
      stage: "Analyze",
      role: "Reads the brief in about a second: target length, tone, captions, and the music mood for Lyria.",
      evidence: analyzed ? `briefs analyzed in ${plural(analyzed, "cut")}` : null,
      calls: calls((m) => m === BRIEF_MODEL),
    },
    {
      models: [MODELS.argon],
      name: "Gemini 4 Argon",
      stage: "Draft · Watch · Fix",
      role: "Watches every clip and drafts the edit, then watches each render and writes timestamped checks and patches. thinking_level medium, store: false.",
      evidence: watched ? `${plural(watched, "render")} watched and graded, ${plural(notes, "director's note")} applied` : null,
      calls: calls((m) => m === MODELS.argon),
    },
    {
      models: [ART_MODEL],
      name: "Nano Banana 2.1",
      stage: "Art",
      role: "Paints the title and closing-card backdrops, and the keyframes Omni animates.",
      evidence: art ? `title or end-card art painted for ${plural(art, "cut")}` : null,
      calls: calls((m) => m === ART_MODEL),
    },
    {
      models: [LYRIA_MODELS.clip, LYRIA_MODELS.song],
      name: "Lyria",
      stage: "Music",
      role: "Scores an instrumental bed from Argon's prompt; it is ducked under dialogue and loudness-normalised in the mix.",
      evidence: music ? `music scored for ${plural(music, "cut")}` : null,
      calls: calls((m) => m.startsWith("lyria")),
    },
    {
      models: [OMNI_MODEL],
      name: "Gemini Omni Flash",
      stage: "Generate shots",
      role: "Generates up to two short shots with native audio when the footage lacks something the brief needs.",
      evidence: shots ? `${plural(shots, "generated shot")} cut into edits` : null,
      calls: calls((m) => m === OMNI_MODEL),
    },
    {
      models: [LIVE_MODEL],
      name: "Gemini 3.8 Live",
      stage: "Voice",
      role: "“Talk to Argon” in the editor: narrates progress and turns spoken direction into a revision, over ephemeral tokens.",
      evidence: null,
      calls: 0,
    },
    {
      models: ["ffmpeg"],
      name: "ffmpeg",
      stage: "Render",
      role: "Renders every version deterministically from the edit list. No model touches pixels.",
      evidence: rendered ? `${plural(rendered, "version")} rendered` : null,
      calls: 0,
    },
  ];
}
