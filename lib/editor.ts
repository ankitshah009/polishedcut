/**
 * One place that decides which editor cuts a run (lib/config.ts MODEL_PROVIDER):
 *   local   lib/local-editor.ts  whisper.cpp + ffmpeg + deterministic rules; free, no key
 *   gemini  lib/gemini.ts        Google's Gemini API with GEMINI_API_KEY
 *   nebula  lib/gemini.ts        the same SDK pointed at NEBULA_BASE_URL with NEBULA_API_KEY
 */
import { MODEL_PROVIDER, MODELS } from "./config";
import { createGeminiEditor, type EditorModel, type GeminiEditorOptions } from "./gemini";
import { LOCAL_EDITOR_LABEL, createLocalEditor } from "./local-editor";

export { MODEL_PROVIDER };

/** The editor for the active provider. `opts` only matter for the hosted providers. */
export function createEditor(opts: GeminiEditorOptions = {}): EditorModel {
  return MODEL_PROVIDER === "local" ? createLocalEditor() : createGeminiEditor(opts);
}

/** True when the loop should skip the companion models (brief analysis, title art, music, generated shots). */
export const LOCAL_ONLY = MODEL_PROVIDER === "local";

/** One line for logs and the health endpoint. */
export function describeEditor(): string {
  if (LOCAL_ONLY) return LOCAL_EDITOR_LABEL;
  return `${MODEL_PROVIDER}: ${MODELS.argon}${MODELS.argonFallback ? ` (fallback ${MODELS.argonFallback})` : ""}`;
}
