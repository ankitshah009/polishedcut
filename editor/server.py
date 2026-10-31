"""FastAPI server: upload clips + brief, run the self-correcting edit loop, stream progress."""
from __future__ import annotations

import asyncio
import json
import os
import threading
import uuid
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles

from editor.schema import Run, SourceClip

ROOT = Path(__file__).resolve().parent.parent
RUNS_DIR = Path(os.environ.get("EDITOR_RUNS_DIR", ROOT / "runs"))
WEB_DIR = ROOT / "web"

run_edit = None  # override in tests; defaults to editor.loop.run_edit
_live: dict[str, Run] = {}
_lock = threading.Lock()

app = FastAPI(title="Argon Editor")


def _run_edit_fn():
    if run_edit is not None:
        return run_edit
    from editor.loop import run_edit as fn
    return fn


def _save(run: Run) -> None:
    d = RUNS_DIR / run.id
    d.mkdir(parents=True, exist_ok=True)
    tmp = d / "run.json.tmp"
    tmp.write_text(run.model_dump_json(indent=2))
    tmp.replace(d / "run.json")


def _load(run_id: str) -> Run | None:
    with _lock:
        if run_id in _live:
            return _live[run_id].model_copy(deep=True)
    p = RUNS_DIR / run_id / "run.json"
    if not p.is_file():
        return None
    try:
        return Run.model_validate_json(p.read_text())
    except Exception:
        return None


def _worker(run: Run, workdir: str) -> None:
    def on_update(r: Run) -> None:
        with _lock:
            _live[r.id] = r.model_copy(deep=True)

    try:
        _run_edit_fn()(run, workdir, max_iters=3, on_update=on_update)
    except Exception as e:  # noqa: BLE001
        run.status = "error"
        run.error = run.error or f"{type(e).__name__}: {e}"
    on_update(run)
    _save(run)


@app.post("/api/runs")
async def create_run(brief: str = Form(...), files: list[UploadFile] = File(...)):
    if not files:
        raise HTTPException(400, "no files")
    run_id = uuid.uuid4().hex[:10]
    src = RUNS_DIR / run_id / "src"
    src.mkdir(parents=True, exist_ok=True)
    clips = []
    for i, f in enumerate(files, 1):
        name = Path(f.filename or f"clip{i}.mp4").name
        dest = src / f"clip{i}_{name}"
        with dest.open("wb") as out:
            while chunk := await f.read(1 << 20):
                out.write(chunk)
        clips.append(SourceClip(id=f"clip{i}", path=str(dest), duration=0))
    run = Run(id=run_id, brief=brief, clips=clips)
    _save(run)
    with _lock:
        _live[run_id] = run.model_copy(deep=True)
    threading.Thread(target=_worker, args=(run, str(RUNS_DIR / run_id)), daemon=True).start()
    return run.model_dump()


@app.get("/api/runs")
def list_runs():
    out = []
    if RUNS_DIR.is_dir():
        for d in sorted(RUNS_DIR.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
            r = _load(d.name)
            if r:
                out.append({"id": r.id, "brief": r.brief, "status": r.status,
                            "iterations": len(r.iterations)})
    return out


@app.get("/api/runs/{run_id}")
def get_run(run_id: str):
    r = _load(run_id)
    if not r:
        raise HTTPException(404, "run not found")
    return r.model_dump()


@app.get("/api/runs/{run_id}/events")
async def run_events(run_id: str):
    if not _load(run_id):
        raise HTTPException(404, "run not found")

    async def gen():
        last = None
        while True:
            r = _load(run_id)
            if r:
                body = r.model_dump_json()
                if body != last:
                    last = body
                    yield f"data: {body}\n\n"
                if r.status in ("done", "error"):
                    yield "event: end\ndata: {}\n\n"
                    return
            else:
                yield ": waiting\n\n"
            await asyncio.sleep(0.5)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


RUNS_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/runs", StaticFiles(directory=str(RUNS_DIR)), name="runs")  # Range-capable
if WEB_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(WEB_DIR), html=True), name="web")
