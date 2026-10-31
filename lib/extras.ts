// The patch ops that reach beyond cuts and captions: on-screen overlays, the closing card and the
// audio treatment. Pure: the input EDL is never mutated. lib/patch.ts calls applyExtraPatch first and
// falls through to its own switch when it returns null.
import type { EDL, Overlay, PatchOp } from "./schema";

const EXTRA_OPS = new Set<PatchOp["op"]>(["add_overlay", "set_overlay", "remove_overlay", "set_end_title", "set_audio"]);

export function isExtraOp(op: PatchOp["op"]): boolean {
  return EXTRA_OPS.has(op);
}

function findOverlay(overlays: Overlay[], index: number | null | undefined): number {
  if (index == null || !Number.isInteger(index) || index < 0 || index >= overlays.length) {
    throw new Error(`overlay index ${index} out of range (0..${overlays.length - 1})`);
  }
  return index;
}

function sortOverlays(overlays: Overlay[]): Overlay[] {
  return [...overlays].sort((a, b) => a.start - b.start);
}

/**
 * Apply one of add_overlay / set_overlay / remove_overlay / set_end_title / set_audio and return a new
 * EDL. Returns null for every other op so the caller can handle it. Throws on a malformed patch
 * (missing text, end <= start, index out of range), like lib/patch.ts does for its own ops.
 */
export function applyExtraPatch(edl: EDL, patch: PatchOp): EDL | null {
  const overlays = edl.overlays ?? [];
  switch (patch.op) {
    case "add_overlay": {
      const text = (patch.text ?? "").trim();
      if (!text || patch.start == null || patch.end == null || patch.end <= patch.start) {
        throw new Error("add_overlay needs text and start < end");
      }
      const overlay: Overlay = { text, start: Math.max(0, patch.start), end: patch.end, position: patch.position ?? "lower-third" };
      return { ...edl, overlays: sortOverlays([...overlays, overlay]) };
    }
    case "set_overlay": {
      const i = findOverlay(overlays, patch.index);
      const cur = overlays[i];
      const next: Overlay = {
        text: patch.text != null && patch.text.trim() ? patch.text.trim() : cur.text,
        start: patch.start ?? cur.start,
        end: patch.end ?? cur.end,
        position: patch.position ?? cur.position,
      };
      if (next.end <= next.start) throw new Error(`set_overlay ${i}: end must be after start`);
      const out = overlays.slice();
      out[i] = next;
      return { ...edl, overlays: sortOverlays(out) };
    }
    case "remove_overlay": {
      const i = findOverlay(overlays, patch.index);
      return { ...edl, overlays: overlays.filter((_, k) => k !== i) };
    }
    case "set_end_title": {
      const text = (patch.text ?? "").trim();
      const next: EDL = { ...edl };
      if (!text) {
        delete next.endTitle;
        delete next.endImage;
        return next;
      }
      // A changed line invalidates the painted backdrop, so the loop repaints it.
      if (edl.endTitle !== text) delete next.endImage;
      next.endTitle = text;
      return next;
    }
    case "set_audio": {
      const audio = { denoise: edl.audio?.denoise ?? false, ...(edl.audio?.musicGainDb != null ? { musicGainDb: edl.audio.musicGainDb } : {}) };
      if (patch.denoise != null) audio.denoise = patch.denoise;
      if (patch.gainDb != null) {
        if (!Number.isFinite(patch.gainDb)) throw new Error("set_audio gainDb must be a finite number");
        audio.musicGainDb = Math.max(-40, Math.min(0, patch.gainDb));
      }
      return { ...edl, audio };
    }
    default:
      return null;
  }
}
