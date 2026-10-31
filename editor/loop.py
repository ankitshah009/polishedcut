"""Self-correcting edit loop: proxy -> transcribe -> draft -> (render -> critique -> patch)*."""
from __future__ import annotations

import argparse
import os
import shutil
import traceback
import uuid
from pathlib import Path
from typing import Callable

from editor import gemini
from editor.media import make_proxy, probe
from editor.patch import apply_patches
from editor.render import render
from editor.schema import Iteration, Run, SourceClip


def _save(run: Run, workdir: Path, on_update: Callable[[Run], None] | None) -> None:
    workdir.mkdir(parents=True, exist_ok=True)
    tmp = workdir / "run.json.tmp"
    tmp.write_text(run.model_dump_json(indent=2))
    tmp.replace(workdir / "run.json")
    if on_update:
        on_update(run)


def run_edit(run: Run, workdir, max_iters: int = 3, on_update: Callable[[Run], None] | None = None) -> Run:
    wd = Path(workdir)
    step = lambda: _save(run, wd, on_update)  # noqa: E731
    try:
        run.status = "drafting"
        step()
        proxies: list[SourceClip] = []
        for c in run.clips:
            c.duration = probe(c.path)
            pdst = wd / "proxies" / f"{c.id}.mp4"
            pdst.parent.mkdir(parents=True, exist_ok=True)
            if not pdst.exists():
                make_proxy(c.path, str(pdst))
            proxies.append(c.model_copy(update={"path": str(pdst)}))
        step()
        for c, p in zip(run.clips, proxies):
            c.transcript = gemini.transcribe(p)
            p.transcript = c.transcript
            step()
        edl = gemini.draft_edl(run.brief, proxies)
        clip_map = {c.id: c for c in run.clips}
        for n in range(1, max_iters + 1):
            run.status = "rendering"
            step()
            out = render(edl, clip_map, str(wd / f"iter{n}.mp4"))
            it = Iteration(n=n, edl=edl, video=out)
            run.iterations.append(it)
            run.status = "critiquing"
            step()
            it.critique = gemini.critique(run.brief, edl, out, proxies, iteration=n)
            step()
            if it.critique.all_passed or n == max_iters:
                break
            edl = apply_patches(edl, it.critique.patches, clip_map)
        run.status = "done"
        step()
    except Exception as e:  # noqa: BLE001
        run.status = "error"
        run.error = f"{type(e).__name__}: {e}\n{traceback.format_exc(limit=5)}"
        step()
    return run


def main() -> None:
    ap = argparse.ArgumentParser(description="Self-correcting video edit loop")
    ap.add_argument("--brief", required=True)
    ap.add_argument("--max-iters", type=int, default=3)
    ap.add_argument("clips", nargs="+")
    a = ap.parse_args()
    rid = uuid.uuid4().hex[:10]
    wd = Path(os.environ.get("RUNS_DIR", "runs")) / rid
    (wd / "src").mkdir(parents=True, exist_ok=True)
    clips = []
    for i, p in enumerate(a.clips, 1):
        dst = wd / "src" / f"clip{i}_{Path(p).name}"
        shutil.copy(p, dst)
        clips.append(SourceClip(id=f"clip{i}", path=str(dst), duration=0))
    run = Run(id=rid, brief=a.brief, clips=clips)
    seen = {"n": 0}

    def on_update(r: Run) -> None:
        print(f"[{r.status}]", flush=True)
        for it in r.iterations:
            if it.critique and it.n > seen["n"]:
                seen["n"] = it.n
                print(f"--- iteration {it.n}: {it.video}")
                for c in it.critique.checks:
                    at = f" @{c.at:.2f}s" if c.at is not None else ""
                    print(f"  [{'PASS' if c.passed else 'FAIL'}] {c.name}{at} {c.note}")
                print(f"  patches: {len(it.critique.patches)}  {it.critique.summary}")

    run_edit(run, wd, a.max_iters, on_update)
    print(f"status={run.status} run={wd / 'run.json'}")
    if run.error:
        print(run.error)


if __name__ == "__main__":
    main()
