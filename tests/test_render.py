import subprocess

import pytest

from editor.media import probe, make_proxy
from editor.render import render
from editor.schema import EDL, Caption, Cut, SourceClip


def _gen(path, audio=True, dur=4):
    cmd = ["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", f"testsrc=size=320x240:rate=25:duration={dur}"]
    if audio:
        cmd += ["-f", "lavfi", "-i", f"sine=frequency=440:duration={dur}", "-c:a", "aac"]
    cmd += ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-shortest", str(path)]
    subprocess.run(cmd, check=True)
    return str(path)


@pytest.fixture
def clips(tmp_path):
    a = _gen(tmp_path / "a.mp4")
    b = _gen(tmp_path / "b.mp4", audio=False)
    return {"a": SourceClip(id="a", path=a, duration=probe(a)), "b": SourceClip(id="b", path=b, duration=probe(b))}


def test_probe(clips):
    assert abs(clips["a"].duration - 4) < 0.2


def test_render_title_captions(clips, tmp_path):
    edl = EDL(title="Hello: it's 100% \"fun\", ok\\", width=640, height=360, cuts=[
        Cut(id="c1", clip_id="a", src_in=0.5, src_out=2.0),
        Cut(id="c2", clip_id="b", src_in=1.0, src_out=2.5),
        Cut(id="c3", clip_id="a", src_in=3.0, src_out=4.0),
    ], captions=[Caption(text="a, b: c's 50%", start=2.2, end=3.0), Caption(text="[x]; y", start=4, end=5)])
    out = render(edl, clips, str(tmp_path / "out.mp4"))
    assert abs(probe(out) - 6.0) < 0.25


def test_render_error(clips, tmp_path):
    edl = EDL(cuts=[Cut(id="c1", clip_id="zzz", src_in=0, src_out=1)])
    with pytest.raises(ValueError):
        render(edl, clips, str(tmp_path / "x.mp4"))


def test_proxy(clips, tmp_path):
    out = make_proxy(clips["a"].path, str(tmp_path / "p.mp4"), height=120)
    assert abs(probe(out) - 4) < 0.2
