// Gemini Live voice assistant ("Talk to Argon"): the pieces shared by the token route and the
// browser component. Everything here is pure and has no Node imports, so it bundles into the client.
// The run is summarised into a system instruction on the server; the browser only ever sees an
// ephemeral token plus that text, never the API key.
import { Behavior, Modality, type FunctionDeclaration, type LiveConnectConfig } from "@google/genai";

import { checkLabel, describePatch, formatTime } from "./format";
import type { Iteration, Run } from "./schema";

export const PRODUCT_NAME = "PolishedCut";
export const LIVE_MODEL = process.env.NEXT_PUBLIC_LIVE_MODEL ?? "gemini-3.8-live";
/** How long a freshly issued token may open a session and keep talking. */
export const TOKEN_TTL_MS = 5 * 60 * 1000;
/** A token may be used by this browser at most once (resuming a session does not count). */
export const TOKEN_USES = 1;
export const REVISE_CUT = "revise_cut";

/** The one tool the assistant has: turn a spoken note into POST /api/runs/[id]/revise. */
export const REVISE_CUT_DECLARATION: FunctionDeclaration = {
  name: REVISE_CUT,
  description:
    "Apply a director's note to the current cut. Call it whenever the user asks for a change to the video " +
    "(trim, remove, reorder, captions, title, music, pacing). Restate the request as one clear imperative note.",
  behavior: Behavior.NON_BLOCKING,
  parametersJsonSchema: {
    type: "object",
    properties: {
      note: { type: "string", description: "The director's note, 1 to 2 sentences, imperative, in the user's words." },
    },
    required: ["note"],
  },
};

export interface LiveTokenRequest {
  runId: string;
}

export interface LiveTokenResponse {
  /** The ephemeral token (`auth_tokens/...`); passed to the browser SDK as `apiKey`. */
  token: string;
  /** ISO 8601: after this the token's session is rejected. */
  expiresAt: string;
  model: string;
  systemInstruction: string;
}

const STATUS_TEXT: Record<Run["status"], string> = {
  queued: "queued, waiting for Argon to start",
  drafting: "Argon is drafting the first cut",
  rendering: "a new version is rendering",
  critiquing: "Argon is watching the latest render and checking it against the brief",
  done: "finished; the final cut is ready to export",
  error: "stopped on an error",
};

function pct(passed: number, total: number): string {
  return total === 0 ? "no checks yet" : `${passed}/${total} checks passed (${Math.round((100 * passed) / total)}%)`;
}

function scoreOf(it: Iteration | undefined): { passed: number; total: number } {
  const checks = it?.critique?.checks ?? [];
  return { passed: checks.filter((c) => c.passed).length, total: checks.length };
}

/** One line per failed check in the latest version, with the output-timeline timestamp when known. */
export function failedCheckLines(it: Iteration | undefined): string[] {
  const checks = it?.critique?.checks ?? [];
  return checks
    .filter((c) => !c.passed)
    .map((c) => {
      const at = c.at != null ? ` at ${formatTime(c.at)}` : "";
      const note = c.note ? ` — ${c.note}` : "";
      return `- ${checkLabel(c.name)}${at}${note}`;
    });
}

/** Fixes applied so far: the patches each version's critique wrote, and the notes that drove revisions. */
export function fixLines(run: Pick<Run, "iterations">): string[] {
  const lines: string[] = [];
  run.iterations.forEach((it, k) => {
    if (it.note) lines.push(`- v${it.n}: director's note "${it.note}"`);
    const patches = it.critique?.patches ?? [];
    if (patches.length > 0 && k < run.iterations.length - 1) {
      lines.push(`- v${it.n} -> v${run.iterations[k + 1].n}: ${patches.map(describePatch).join("; ")}`);
    }
  });
  return lines;
}

/**
 * The system instruction for the live session. Pure: it reads only the run passed in, so the
 * assistant can never report a check that is not in run.json.
 */
export function buildSystemInstruction(run: Run): string {
  const its = run.iterations;
  const last = its[its.length - 1];
  const { passed, total } = scoreOf(last);
  const failed = failedCheckLines(last);
  const fixes = fixLines(run);
  const warnings = run.warnings.filter(Boolean);

  const facts = [
    `Brief: ${run.brief}`,
    `Status: ${STATUS_TEXT[run.status]}${run.status === "error" && run.error ? ` (${run.error})` : ""}.`,
    `Versions so far: ${its.length}${last ? ` (latest is v${last.n})` : ""}.`,
    `Latest score: ${last ? pct(passed, total) : "no version rendered yet"}.`,
    `Failed checks in the latest version:\n${failed.length ? failed.join("\n") : "- none"}`,
    `Fixes applied so far:\n${fixes.length ? fixes.join("\n") : "- none yet"}`,
    `Source clips: ${run.clips.length}.`,
    warnings.length ? `Warnings:\n${warnings.map((w) => `- ${w}`).join("\n")}` : "",
  ].filter(Boolean);

  return [
    `You are Argon, the voice of ${PRODUCT_NAME}, a self-correcting AI video editor. The user is a director watching ` +
      "the editor cut a video. You narrate what is happening and take spoken director's notes.",
    "",
    "Current run:",
    ...facts,
    "",
    "Rules:",
    "- Speak concisely: one or two short sentences per reply. No lists, no markdown, no preamble.",
    "- When asked how it is going, narrate progress from the facts above: status, latest score, what failed, what was fixed.",
    `- When the user asks for a change to the cut, call the function ${REVISE_CUT} with the note; then tell them it is being applied. ` +
      "If the run is still in progress, say the note will have to wait until this version finishes before you call it.",
    "- Never invent checks, scores, timestamps or fixes. If something is not in the facts, say you do not know yet.",
    "- Messages that start with \"Status update:\" come from the editor, not the user. Report them in one sentence.",
    "- Refer to yourself as Argon and to the product as " + PRODUCT_NAME + ".",
  ].join("\n");
}

/** The short text turn the client sends in narrate mode when the run changes. */
export function statusUpdate(run: Run): string {
  const last = run.iterations[run.iterations.length - 1];
  const { passed, total } = scoreOf(last);
  const bits = [`Status update: the run is now ${STATUS_TEXT[run.status]}.`];
  if (last) bits.push(`Latest version v${last.n}, ${pct(passed, total)}.`);
  const failed = failedCheckLines(last);
  if (failed.length) bits.push(`Still failing: ${failed.map((l) => l.replace(/^- /, "")).join("; ")}.`);
  if (run.status === "error" && run.error) bits.push(`Error: ${run.error}`);
  return bits.join(" ");
}

/** The session config, identical on the server (locked into the token) and in the browser. */
export function liveConnectConfig(systemInstruction: string): LiveConnectConfig {
  return {
    responseModalities: [Modality.AUDIO],
    systemInstruction,
    tools: [{ functionDeclarations: [REVISE_CUT_DECLARATION] }],
    inputAudioTranscription: {},
    outputAudioTranscription: {},
  };
}
