from editor.patch import apply_patches, timeline
from editor.schema import EDL, Caption, Cut, PatchOp, SourceClip

CLIPS = {"a": SourceClip(id="a", path="a.mp4", duration=10), "b": SourceClip(id="b", path="b.mp4", duration=5)}


def edl():
    return EDL(title="T", cuts=[Cut(id="c1", clip_id="a", src_in=0, src_out=2),
                                Cut(id="c2", clip_id="b", src_in=1, src_out=3)],
               captions=[Caption(text="x", start=2, end=3)])


def P(**k):
    return PatchOp(**k)


def test_trim_clamps():
    e = apply_patches(edl(), [P(op="trim", cut_id="c2", src_in=-1, src_out=99)], CLIPS)
    assert (e.cuts[1].src_in, e.cuts[1].src_out) == (0, 5)


def test_trim_short_dropped():
    e = apply_patches(edl(), [P(op="trim", cut_id="c1", src_out=0.1)], CLIPS)
    assert [c.id for c in e.cuts] == ["c2"]


def test_remove_cut_and_immutability():
    orig = edl()
    e = apply_patches(orig, [P(op="remove_cut", cut_id="c1")], CLIPS)
    assert [c.id for c in e.cuts] == ["c2"] and len(orig.cuts) == 2


def test_insert_cut():
    e = apply_patches(edl(), [P(op="insert_cut", clip_id="a", src_in=4, src_out=6, index=1)], CLIPS)
    assert [c.id for c in e.cuts] == ["c1", "c3", "c2"]


def test_move_cut():
    e = apply_patches(edl(), [P(op="move_cut", cut_id="c2", index=0)], CLIPS)
    assert [c.id for c in e.cuts] == ["c2", "c1"]


def test_captions():
    e = apply_patches(edl(), [P(op="set_caption", index=0, text="y"),
                              P(op="add_caption", text="z", start=0.5, end=1)], CLIPS)
    assert [c.text for c in e.captions] == ["z", "y"]
    e = apply_patches(e, [P(op="remove_caption", index=0)], CLIPS)
    assert [c.text for c in e.captions] == ["y"]


def test_set_title():
    assert apply_patches(edl(), [P(op="set_title", text="New")], CLIPS).title == "New"


def test_invalid_skipped(caplog):
    e = apply_patches(edl(), [P(op="remove_cut", cut_id="nope"), P(op="set_caption", index=9, text="q"),
                              P(op="insert_cut", clip_id="zz", src_in=0, src_out=1)], CLIPS)
    assert e == edl() and "skipping" in caplog.text


def test_timeline():
    assert timeline(edl()) == [("c1", 2.0, 4.0), ("c2", 4.0, 6.0)]
