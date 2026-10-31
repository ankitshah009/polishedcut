import time

from fastapi.testclient import TestClient

from editor import server
from editor.schema import Check, Critique, EDL, Cut, Iteration


def test_upload_creates_run(monkeypatch, tmp_path):
    monkeypatch.setattr(server, "RUNS_DIR", tmp_path)

    def fake_run_edit(run, workdir, max_iters=3, on_update=None):
        run.status = "rendering"
        on_update(run)
        run.iterations.append(Iteration(
            n=1, video=f"{workdir}/v1.mp4",
            edl=EDL(cuts=[Cut(id="c1", clip_id="clip1", src_in=0, src_out=2)]),
            critique=Critique(checks=[Check(name="ok", passed=True)])))
        run.status = "done"
        on_update(run)

    monkeypatch.setattr(server, "run_edit", fake_run_edit)
    c = TestClient(server.app)
    r = c.post("/api/runs", data={"brief": "make it punchy"},
               files=[("files", ("a.mp4", b"x" * 10, "video/mp4")),
                      ("files", ("b.mp4", b"y", "video/mp4"))])
    assert r.status_code == 200
    run = r.json()
    assert [cl["id"] for cl in run["clips"]] == ["clip1", "clip2"]
    assert (tmp_path / run["id"] / "src").is_dir()

    for _ in range(50):
        got = c.get(f"/api/runs/{run['id']}").json()
        if got["status"] == "done":
            break
        time.sleep(0.05)
    assert got["brief"] == "make it punchy"
    assert got["status"] == "done" and len(got["iterations"]) == 1
    assert any(x["id"] == run["id"] for x in c.get("/api/runs").json())
    assert c.get("/api/runs/nope").status_code == 404
