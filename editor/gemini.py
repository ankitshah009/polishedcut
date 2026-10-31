"""Gemini calls: upload, transcribe, draft EDL, critique render. EDITOR_MOCK=1 -> offline fakes."""
from __future__ import annotations

import hashlib
import json
import os
import re
import time
from pathlib import Path
from typing import Any, TypeVar

from pydantic import BaseModel, TypeAdapter, ValidationError

from editor.schema import EDL, Critique, Cut, Check, PatchOp, SourceClip, Word

ARGON_MODEL = os.environ.get("ARGON_MODEL", "gemini-4-argon")
FLASH_MODEL = os.environ.get("FLASH_MODEL", "gemini-3.8-flash")
TRANSCRIBE_MODEL = os.environ.get("TRANSCRIBE_MODEL", "gemini-3.5-transcribe")
TITLE_SECONDS = 2.0
TIMEOUT_S = 15 * 60
CACHE_PATH = Path(os.environ.get("RUNS_DIR", "runs")) / ".upload_cache.json"

T = TypeVar("T")


def is_mock() -> bool:
    return os.environ.get("EDITOR_MOCK") == "1"


_client = None


def client():
    global _client
    if _client is None:
        from google import genai
        _client = genai.Client(http_options={"timeout": TIMEOUT_S * 1000})
    return _client


# ---------------------------------------------------------------- upload
def _sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def upload_video(path: str) -> dict:
    """Upload (cached by sha256) and wait for ACTIVE. Returns {"uri","mime_type","name"}."""
    if is_mock():
        return {"uri": f"mock://{Path(path).name}", "mime_type": "video/mp4", "name": "files/mock"}
    digest = _sha256(path)
    cache: dict = {}
    if CACHE_PATH.exists():
        try:
            cache = json.loads(CACHE_PATH.read_text())
        except Exception:
            cache = {}
    c = client()
    if digest in cache:
        try:
            f = c.files.get(name=cache[digest]["name"])
            if str(getattr(f.state, "value", f.state)) == "ACTIVE":
                return cache[digest]
        except Exception:
            pass
    f = c.files.upload(file=path, config={"mime_type": "video/mp4"})
    deadline = time.time() + TIMEOUT_S
    while str(getattr(f.state, "value", f.state)) == "PROCESSING":
        if time.time() > deadline:
            raise TimeoutError(f"upload of {path} never became ACTIVE")
        time.sleep(3)
        f = c.files.get(name=f.name)
    if str(getattr(f.state, "value", f.state)) != "ACTIVE":
        raise RuntimeError(f"upload of {path} failed: state={f.state}")
    handle = {"uri": f.uri, "mime_type": f.mime_type or "video/mp4", "name": f.name}
    cache[digest] = handle
    CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    CACHE_PATH.write_text(json.dumps(cache, indent=2))
    return handle


def _video_part(handle: dict) -> dict:
    return {"type": "video", "uri": handle["uri"], "mime_type": handle["mime_type"]}


# ---------------------------------------------------------------- JSON calls
def _extract_json(text: str) -> Any:
    text = (text or "").strip()
    m = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
    if m:
        text = m.group(1).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        starts = [i for i in (text.find("{"), text.find("[")) if i >= 0]
        if not starts:
            raise
        s = min(starts)
        e = max(text.rfind("}"), text.rfind("]"))
        return json.loads(text[s:e + 1])


def _call(model: str, parts: list[dict], schema: dict | None, thinking: str = "medium") -> str:
    kwargs: dict[str, Any] = dict(model=model, input=parts, timeout=TIMEOUT_S)
    if thinking:
        kwargs["generation_config"] = {"thinking_level": thinking}
    if schema is not None:
        try:
            r = client().interactions.create(
                **kwargs, response_format={"type": "text", "mime_type": "application/json", "schema": schema})
            return r.output_text or ""
        except Exception as e:  # structured output rejected -> plain JSON prompt
            if "schema" not in str(e).lower() and "response_format" not in str(e).lower():
                raise
    return client().interactions.create(**kwargs).output_text or ""


def _ask_json(model: str, parts: list[dict], type_: Any, thinking: str = "medium") -> Any:
    """Ask for JSON validated against `type_`; one retry feeding back the error."""
    adapter = TypeAdapter(type_)
    schema = None
    try:
        schema = adapter.json_schema()
    except Exception:
        pass
    text = _call(model, parts, schema, thinking)
    try:
        return adapter.validate_python(_extract_json(text))
    except (ValidationError, ValueError) as e:
        retry = parts + [{"type": "text", "text": (
            f"Your previous reply was:\n{text[:4000]}\n\nIt failed validation:\n{e}\n"
            "Reply again with ONLY corrected JSON, no prose.")}]
        text = _call(model, retry, schema, thinking)
        return adapter.validate_python(_extract_json(text))


# ---------------------------------------------------------------- transcribe
def transcribe(clip: SourceClip) -> list[Word]:
    if is_mock():
        return [Word(text=f"word{i}", start=i * 0.5, end=i * 0.5 + 0.4)
                for i in range(int(min(clip.duration, 10) / 0.5))]
    prompt = {"type": "text", "text": (
        "Transcribe all speech in this video with word-level timestamps in seconds from the start "
        'of the file. Return ONLY a JSON array: [{"text": str, "start": float, "end": float}, ...]. '
        "Return [] if there is no speech.")}
    for model in (TRANSCRIBE_MODEL, FLASH_MODEL):
        try:
            h = upload_video(clip.path)
            return _ask_json(model, [_video_part(h), prompt], list[Word], thinking="")
        except Exception as e:
            print(f"[transcribe] {model} failed for {clip.id}: {e}")
    return []


# ---------------------------------------------------------------- draft
EDL_RULES = f"""EDL schema (JSON):
{{"title": str (optional; if non-empty a {TITLE_SECONDS:.0f}s title card is shown BEFORE the first cut),
 "cuts": [{{"id": "c1", "clip_id": str, "src_in": float, "src_out": float, "reason": str}}, ...],
 "captions": [{{"text": str, "start": float, "end": float}}, ...],
 "width": 1280, "height": 720, "fps": 30}}
Rules:
- Cuts play back-to-back in list order. src_in/src_out are seconds in the SOURCE clip, 0 <= src_in < src_out <= clip duration.
- Cut ids are c1..cN in order.
- Caption start/end are on the OUTPUT timeline: output time = (title ? {TITLE_SECONDS:.0f}s : 0) + sum of previous cut durations + (source time - src_in).
  Captions must match the words actually spoken at that output time.
- Never cut in the middle of a word or sentence: place src_in/src_out in pauses between words using the transcripts.
- Hit the target duration from the brief (total = title card + sum of cut durations); if none given, keep it tight (~30s).
- Avoid jarring jump cuts (e.g. two very similar shots from the same clip separated by a tiny gap)."""


def _clip_desc(clips: list[SourceClip]) -> str:
    out = []
    for c in clips:
        words = " ".join(f"[{w.start:.2f}-{w.end:.2f}]{w.text}" for w in c.transcript) or "(no speech / no transcript)"
        out.append(f"clip_id={c.id} duration={c.duration:.2f}s\ntranscript: {words}")
    return "\n\n".join(out)


def draft_edl(brief: str, clips: list[SourceClip]) -> EDL:
    if is_mock():
        return EDL(title="Mock Edit", cuts=[
            Cut(id=f"c{i+1}", clip_id=c.id, src_in=0.0, src_out=min(3.0, c.duration), reason="mock: first 3s")
            for i, c in enumerate(clips)],
            captions=[])
    parts: list[dict] = []
    for c in clips:
        parts.append({"type": "text", "text": f"Video for clip_id={c.id}:"})
        parts.append(_video_part(upload_video(c.path)))
    parts.append({"type": "text", "text": (
        "You are a professional video editor. Watch every clip above and build an edit decision list "
        f"that fulfils this brief.\n\nBRIEF:\n{brief}\n\nCLIPS:\n{_clip_desc(clips)}\n\n{EDL_RULES}\n\n"
        "Return ONLY the EDL JSON.")})
    edl = _ask_json(ARGON_MODEL, parts, EDL)
    for i, cut in enumerate(edl.cuts):
        cut.id = f"c{i+1}"
    return edl


# ---------------------------------------------------------------- critique
def _timeline_text(edl: EDL) -> str:
    t = TITLE_SECONDS if edl.title else 0.0
    lines = [f"title card '{edl.title}': 0.00-{t:.2f}"] if edl.title else []
    for c in edl.cuts:
        d = c.src_out - c.src_in
        lines.append(f"{c.id}: output {t:.2f}-{t+d:.2f} <- {c.clip_id} [{c.src_in:.2f}-{c.src_out:.2f}] ({c.reason})")
        t += d
    lines.append(f"total duration: {t:.2f}s")
    for i, cap in enumerate(edl.captions):
        lines.append(f"caption[{i}] {cap.start:.2f}-{cap.end:.2f}: {cap.text!r}")
    return "\n".join(lines)


_mock_critique_calls: dict[str, int] = {}


def critique(brief: str, edl: EDL, rendered_path: str, clips: list[SourceClip], iteration: int | None = None) -> Critique:
    if is_mock():
        key = str(Path(rendered_path).parent)
        n = iteration or _mock_critique_calls.get(key, 0) + 1
        _mock_critique_calls[key] = n
        if n <= 1:
            c1 = edl.cuts[0]
            return Critique(
                checks=[Check(name="brief: fulfilled", passed=True, note="mock"),
                        Check(name="no mid-word cuts", passed=False, at=(TITLE_SECONDS if edl.title else 0) + (c1.src_out - c1.src_in),
                              note="mock: c1 ends mid-word")],
                patches=[PatchOp(op="trim", cut_id=c1.id, src_in=c1.src_in, src_out=max(c1.src_in + 0.5, c1.src_out - 0.5))],
                summary="mock: trim c1")
        return Critique(checks=[Check(name="brief: fulfilled", passed=True), Check(name="no mid-word cuts", passed=True)],
                        summary="mock: all good")
    parts: list[dict] = [{"type": "text", "text": "RENDERED EDIT:"}, _video_part(upload_video(rendered_path))]
    parts.append({"type": "text", "text": (
        "You are a demanding senior editor reviewing the rendered edit above against the brief.\n\n"
        f"BRIEF:\n{brief}\n\nSOURCE CLIPS:\n{_clip_desc(clips)}\n\n"
        f"CURRENT EDL (JSON):\n{edl.model_dump_json()}\n\nCOMPUTED OUTPUT TIMELINE:\n{_timeline_text(edl)}\n\n{EDL_RULES}\n\n"
        "Watch the rendered video and produce checks (each with name, passed, at = output-timeline seconds, note):\n"
        "- one check per requirement in the brief (name it 'brief: ...')\n"
        "- captions in sync with speech and text matches what is said\n"
        "- no mid-sentence or mid-word cuts\n- no jarring jump cuts\n- duration matches target\n"
        "- title card readable (if a title is set)\n\n"
        "For every failure, add patches that fix it. PatchOp fields: op in "
        "[trim, remove_cut, insert_cut, move_cut, set_caption, remove_caption, add_caption, set_title], "
        "cut_id (existing ids like c1), index (caption index or insert/move position), src_in, src_out, clip_id, "
        "text, start, end. Source times are source-clip seconds; caption times are output-timeline seconds.\n"
        "Return empty patches ONLY if every check passes.\n"
        'Return ONLY JSON: {"checks": [...], "patches": [...], "summary": str}')})
    return _ask_json(ARGON_MODEL, parts, Critique)
