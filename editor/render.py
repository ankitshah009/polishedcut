"""Render an EDL to mp4 with ffmpeg."""
from __future__ import annotations

import os
import shutil
import subprocess
import tempfile

from .media import has_audio
from .schema import EDL, SourceClip

TITLE_SECONDS = 2.0
_FONTS = ["/System/Library/Fonts/Supplemental/Arial.ttf", "/System/Library/Fonts/Helvetica.ttc",
          "/Library/Fonts/Arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"]


def _font() -> str:
    for f in _FONTS:
        if os.path.exists(f):
            return f"fontfile='{f}':"
    return ""


def _textfile(text: str, tmpdir: str, i: int) -> str:
    """Write text to a file and return a filter-safe drawtext source option.

    Using textfile= with expansion=none avoids every filtergraph escaping pitfall
    (colons, quotes, commas, backslashes, percent, brackets) for arbitrary text.
    """
    path = os.path.join(tmpdir, f"t{i}.txt")
    with open(path, "w", encoding="utf-8") as f:
        f.write(text.replace("\r", "").replace("\n", " "))
    safe = path.replace("\\", "/").replace("'", "").replace(":", "\\:")
    return f"textfile='{safe}':expansion=none"


def render(edl: EDL, clips: dict[str, SourceClip], out_path: str) -> str:
    """Render ``edl`` to ``out_path`` (h264/yuv420p/aac, +faststart).

    Timeline: optional 2s title card (if ``edl.title``) followed by cuts in order.
    Caption ``start``/``end`` are seconds on the OUTPUT timeline, which INCLUDES the
    title-card offset (i.e. a caption over the first cut starts at >= 2.0 when titled).
    """
    if not edl.cuts:
        raise ValueError("EDL has no cuts")
    tmp = tempfile.mkdtemp(prefix="render_")
    W, H, fps = edl.width, edl.height, edl.fps
    font = _font()
    norm_v = f"scale={W}:{H}:force_original_aspect_ratio=decrease,pad={W}:{H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={fps},format=yuv420p"
    norm_a = "aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo"
    inputs: list[str] = []
    filters: list[str] = []
    segs: list[str] = []
    n = 0

    if edl.title:
        inputs += ["-f", "lavfi", "-t", str(TITLE_SECONDS), "-i", f"color=c=black:s={W}x{H}:r={fps}",
                   "-f", "lavfi", "-t", str(TITLE_SECONDS), "-i", "anullsrc=r=48000:cl=stereo"]
        size = max(24, H // 12)
        filters.append(f"[{n}:v]drawtext={font}{_textfile(edl.title, tmp, 0)}:fontcolor=white:fontsize={size}:"
                       f"x=(w-text_w)/2:y=(h-text_h)/2,{norm_v}[tv]")
        filters.append(f"[{n+1}:a]{norm_a}[ta]")
        segs.append("[tv][ta]")
        n += 2

    for i, cut in enumerate(edl.cuts):
        clip = clips.get(cut.clip_id)
        if clip is None:
            raise ValueError(f"cut {cut.id}: unknown clip {cut.clip_id}")
        dur = cut.src_out - cut.src_in
        if dur <= 0:
            raise ValueError(f"cut {cut.id}: non-positive duration")
        inputs += ["-ss", f"{cut.src_in:.3f}", "-t", f"{dur:.3f}", "-i", clip.path]
        vi = n
        n += 1
        filters.append(f"[{vi}:v]{norm_v},trim=duration={dur:.3f},setpts=PTS-STARTPTS[v{i}]")
        if has_audio(clip.path):
            filters.append(f"[{vi}:a]{norm_a},atrim=duration={dur:.3f},apad=whole_dur={dur:.3f},asetpts=PTS-STARTPTS[a{i}]")
        else:
            inputs += ["-f", "lavfi", "-t", f"{dur:.3f}", "-i", "anullsrc=r=48000:cl=stereo"]
            filters.append(f"[{n}:a]{norm_a}[a{i}]")
            n += 1
        segs.append(f"[v{i}][a{i}]")

    filters.append(f"{''.join(segs)}concat=n={len(segs)}:v=1:a=1[cv][outa]")
    last = "cv"
    if edl.captions:
        size = max(18, H // 22)
        parts = [f"drawtext={font}{_textfile(c.text, tmp, k + 1)}:fontcolor=white:fontsize={size}:"
                 f"box=1:boxcolor=black@0.6:boxborderw=12:x=(w-text_w)/2:y=h-text_h-{H // 12}:"
                 f"enable='between(t\\,{c.start:.3f}\\,{c.end:.3f})'" for k, c in enumerate(edl.captions)]
        filters.append(f"[cv]{','.join(parts)}[outv]")
        last = "outv"
    else:
        filters.append("[cv]null[outv]")
        last = "outv"

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    cmd = ["ffmpeg", "-y", "-v", "error", *inputs, "-filter_complex", ";".join(filters),
           "-map", f"[{last}]", "-map", "[outa]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
           "-pix_fmt", "yuv420p", "-r", str(fps), "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
           "-movflags", "+faststart", out_path]
    try:
        p = subprocess.run(cmd, capture_output=True, text=True)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    if p.returncode != 0:
        tail = "\n".join(p.stderr.strip().splitlines()[-25:])
        raise RuntimeError(f"ffmpeg render failed (exit {p.returncode}):\n{tail}")
    return out_path
