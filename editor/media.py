"""ffprobe/ffmpeg helpers."""
from __future__ import annotations

import json
import subprocess


def _run(cmd: list[str]) -> subprocess.CompletedProcess:
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        tail = "\n".join(p.stderr.strip().splitlines()[-20:])
        raise RuntimeError(f"{cmd[0]} failed (exit {p.returncode}):\n{tail}")
    return p


def probe(path: str) -> float:
    """Return container duration in seconds."""
    p = _run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", path])
    return float(json.loads(p.stdout)["format"]["duration"])


def has_audio(path: str) -> bool:
    p = _run(["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "json", path])
    return bool(json.loads(p.stdout).get("streams"))


def make_proxy(src: str, dst: str, height: int = 480) -> str:
    """Low-res h264/aac mp4 suitable for model upload."""
    _run(["ffmpeg", "-y", "-v", "error", "-i", src, "-vf", f"scale=-2:{height}",
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p",
          "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", dst])
    return dst
