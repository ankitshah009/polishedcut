"""Shared contract. Every module reads and writes these types only."""
from __future__ import annotations
from typing import Literal
from pydantic import BaseModel, Field


class SourceClip(BaseModel):
    id: str                      # stable id, e.g. "clip1"
    path: str                    # local file path
    duration: float              # seconds, from ffprobe
    transcript: list["Word"] = Field(default_factory=list)


class Word(BaseModel):
    text: str
    start: float                 # seconds in the SOURCE clip
    end: float


class Cut(BaseModel):
    id: str                      # "c1", "c2", ... stable across iterations
    clip_id: str
    src_in: float                # seconds in source
    src_out: float
    reason: str = ""             # why this moment was chosen


class Caption(BaseModel):
    text: str
    start: float                 # seconds on the OUTPUT timeline
    end: float


class EDL(BaseModel):
    title: str = ""              # shown as a 2s title card if non-empty
    cuts: list[Cut]
    captions: list[Caption] = Field(default_factory=list)
    width: int = 1280
    height: int = 720
    fps: int = 30


class Check(BaseModel):
    name: str                    # e.g. "brief: shows the keynote"
    passed: bool
    at: float | None = None      # output-timeline seconds, if localized
    note: str = ""


class PatchOp(BaseModel):
    op: Literal["trim", "remove_cut", "insert_cut", "move_cut", "set_caption", "remove_caption", "add_caption", "set_title"]
    cut_id: str | None = None
    index: int | None = None     # caption index or insert/move position
    src_in: float | None = None
    src_out: float | None = None
    clip_id: str | None = None
    text: str | None = None
    start: float | None = None
    end: float | None = None


class Critique(BaseModel):
    checks: list[Check]
    patches: list[PatchOp] = Field(default_factory=list)
    summary: str = ""

    @property
    def all_passed(self) -> bool:
        return all(c.passed for c in self.checks)


class Iteration(BaseModel):
    n: int
    edl: EDL
    video: str                   # rendered mp4 path
    critique: Critique | None = None


class Run(BaseModel):
    id: str
    brief: str
    clips: list[SourceClip]
    iterations: list[Iteration] = Field(default_factory=list)
    status: Literal["queued", "drafting", "rendering", "critiquing", "done", "error"] = "queued"
    error: str = ""
