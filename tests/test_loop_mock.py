import subprocess

import pytest

from editor.schema import Run, SourceClip


def _clip(path, freq):
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error",
                    "-f", "lavfi", "-i", "testsrc=size=320x240:rate=30:duration=5",
                    "-f", "lavfi", "-i", f"sine=frequency={freq}:duration=5",
                    "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(path)], check=True)
    return str(path)


def test_mock_loop_two_iterations(tmp_path, monkeypatch):
    monkeypatch.setenv("EDITOR_MOCK", "1")
    from editor.loop import run_edit
    clips = [SourceClip(id=f"clip{i}", path=_clip(tmp_path / f"in{i}.mp4", 300 * i), duration=0) for i in (1, 2)]
    run = Run(id="t1", brief="Make a 6 second montage", clips=clips)
    updates = []
    run_edit(run, tmp_path / "run", max_iters=3, on_update=lambda r: updates.append(r.status))
    assert run.status == "done", run.error
    assert len(run.iterations) == 2
    assert not run.iterations[0].critique.all_passed
    assert run.iterations[1].critique.all_passed
    c1a, c1b = run.iterations[0].edl.cuts[0], run.iterations[1].edl.cuts[0]
    assert c1b.src_out < c1a.src_out
    assert (tmp_path / "run" / "run.json").exists()
    assert {"drafting", "rendering", "critiquing", "done"} <= set(updates)
