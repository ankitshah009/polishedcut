"""Apply critique PatchOps to an EDL."""
from __future__ import annotations

import logging

from .schema import EDL, Caption, Cut, PatchOp, SourceClip

log = logging.getLogger(__name__)
MIN_CUT = 0.3
TITLE_SECONDS = 2.0


def _clamp(cut: Cut, clips: dict[str, SourceClip]) -> Cut:
    clip = clips.get(cut.clip_id)
    hi = clip.duration if clip else max(cut.src_in, cut.src_out)
    a = min(max(0.0, cut.src_in), hi)
    b = min(max(0.0, cut.src_out), hi)
    return cut.model_copy(update={"src_in": a, "src_out": b})


def _next_id(cuts: list[Cut]) -> str:
    nums = [int(c.id[1:]) for c in cuts if c.id[1:].isdigit()]
    return f"c{max(nums, default=0) + 1}"


def _find(cuts: list[Cut], cut_id: str | None) -> int:
    for i, c in enumerate(cuts):
        if c.id == cut_id:
            return i
    raise ValueError(f"unknown cut_id {cut_id!r}")


def _apply(e: EDL, p: PatchOp, clips: dict[str, SourceClip]) -> None:
    if p.op == "trim":
        i = _find(e.cuts, p.cut_id)
        upd = {k: v for k, v in (("src_in", p.src_in), ("src_out", p.src_out)) if v is not None}
        if not upd:
            raise ValueError("trim needs src_in or src_out")
        e.cuts[i] = e.cuts[i].model_copy(update=upd)
    elif p.op == "remove_cut":
        e.cuts.pop(_find(e.cuts, p.cut_id))
    elif p.op == "insert_cut":
        if p.clip_id not in clips or p.src_in is None or p.src_out is None:
            raise ValueError("insert_cut needs a known clip_id, src_in, src_out")
        cid = p.cut_id if p.cut_id and all(c.id != p.cut_id for c in e.cuts) else _next_id(e.cuts)
        idx = len(e.cuts) if p.index is None else max(0, min(p.index, len(e.cuts)))
        e.cuts.insert(idx, Cut(id=cid, clip_id=p.clip_id, src_in=p.src_in, src_out=p.src_out, reason=p.text or ""))
    elif p.op == "move_cut":
        if p.index is None:
            raise ValueError("move_cut needs index")
        cut = e.cuts.pop(_find(e.cuts, p.cut_id))
        e.cuts.insert(max(0, min(p.index, len(e.cuts))), cut)
    elif p.op == "set_caption":
        if p.index is None or not 0 <= p.index < len(e.captions):
            raise ValueError(f"bad caption index {p.index}")
        upd = {k: v for k, v in (("text", p.text), ("start", p.start), ("end", p.end)) if v is not None}
        e.captions[p.index] = e.captions[p.index].model_copy(update=upd)
    elif p.op == "remove_caption":
        if p.index is None or not 0 <= p.index < len(e.captions):
            raise ValueError(f"bad caption index {p.index}")
        e.captions.pop(p.index)
    elif p.op == "add_caption":
        if not p.text or p.start is None or p.end is None or p.end <= p.start:
            raise ValueError("add_caption needs text and start<end")
        e.captions.append(Caption(text=p.text, start=max(0.0, p.start), end=p.end))
        e.captions.sort(key=lambda c: c.start)
    elif p.op == "set_title":
        e.title = p.text or ""
    else:
        raise ValueError(f"unknown op {p.op}")


def apply_patches(edl: EDL, patches: list[PatchOp], clips: dict[str, SourceClip]) -> EDL:
    """Return a new EDL with patches applied; invalid ops are logged and skipped."""
    e = edl.model_copy(deep=True)
    for p in patches:
        snapshot = e.model_copy(deep=True)
        try:
            _apply(e, p, clips)
        except Exception as exc:  # noqa: BLE001
            log.warning("skipping patch %s: %s", p.model_dump(exclude_none=True), exc)
            e = snapshot
    cuts = []
    for c in e.cuts:
        c = _clamp(c, clips)
        if c.src_out - c.src_in < MIN_CUT:
            log.warning("dropping cut %s: shorter than %.1fs after clamping", c.id, MIN_CUT)
            continue
        cuts.append(c)
    e.cuts = cuts
    return e


def timeline(edl: EDL) -> list[tuple[str, float, float]]:
    """(cut_id, out_start, out_end) on the output timeline, including title-card offset."""
    t = TITLE_SECONDS if edl.title else 0.0
    out = []
    for c in edl.cuts:
        d = c.src_out - c.src_in
        out.append((c.id, t, t + d))
        t += d
    return out
