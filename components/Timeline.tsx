"use client";

/*
 * NLE timeline. Visual patterns (major/mid/minor ruler ticks, fixed track labels,
 * filmstrip clips, playhead with cap, hover-time ghost line, Ctrl+wheel zoom)
 * adapted from designcombo/react-video-editor (MIT) and remotion editor-starter conventions.
 */

import { Captions, Film, Minus, Music, Plus, Sparkles, Tag, Type, ZoomIn } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { TITLE_SECONDS, cutRanges, edlDuration, edlEndTitle, edlOverlays, endCardRange, formatTime, overlayCell, type MusicBed } from "@/lib/format";
import type { Check, EDL } from "@/lib/schema";

import { Tooltip } from "./ui/tooltip";

const LABEL_W = 96;
const RULER_H = 24;
const VIDEO_H = 56;
const CAP_H = 28;
const LAB_H = 28;
const MUSIC_H = 28;
const MARK_H = 28;
const FRAME_SRC_W = 160;
const FRAME_SRC_H = 90;
const ZOOMS = [1, 1.5, 2, 3, 4, 6, 8, 12, 16];

/** Pick a major tick interval (seconds) so labels are >= ~80px apart. */
function majorStep(pps: number): number {
  for (const s of [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300]) if (s * pps >= 80) return s;
  return 600;
}

function label(t: number) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${(s < 10 ? "0" : "") + (Number.isInteger(s) ? s : s.toFixed(1))}`;
}

export function spriteUrl(runId: string, clipId: string): string {
  return `/api/runs/${runId}/files/thumbs/${clipId}.jpg`;
}

/** Loads each clip's thumbnail sprite once; returns frame count per clip (0 = unavailable). */
export function useSprites(runId: string | undefined, clipIds: string[]) {
  const [frames, setFrames] = useState<Record<string, number>>({});
  const key = clipIds.join("|");
  useEffect(() => {
    if (!runId) return;
    let alive = true;
    for (const id of key.split("|").filter(Boolean)) {
      const img = new Image();
      img.onload = () => alive && setFrames((f) => ({ ...f, [id]: Math.max(1, Math.round(img.naturalWidth / FRAME_SRC_W)) }));
      img.onerror = () => alive && setFrames((f) => ({ ...f, [id]: 0 }));
      img.src = spriteUrl(runId, id);
    }
    return () => {
      alive = false;
    };
  }, [runId, key]);
  return frames;
}

/** Index of the sprite frame that shows source second `t` for a clip with `frames` frames over `duration` s. */
export function spriteFrame(t: number, frames: number, duration: number | undefined): number {
  const spf = duration && frames < Math.ceil(duration) ? duration / frames : 1;
  return Math.max(0, Math.min(frames - 1, Math.floor(t / spf)));
}

/** Inline style that crops one 16:9 frame out of a clip's sprite at the given rendered size. */
export function spriteFrameStyle(runId: string, clipId: string, frames: number, frame: number, w: number, h: number): React.CSSProperties {
  return {
    width: w,
    height: h,
    backgroundImage: `url(${spriteUrl(runId, clipId)})`,
    backgroundSize: `${frames * w}px ${h}px`,
    backgroundPosition: `${-frame * w}px 0`,
  };
}

/** Multi-track editor timeline: ruler, filmstrip video (with title and end cards), caption chips, on-screen labels, the music bed and Argon's failure marks, with a live playhead. */
export function Timeline({
  edl,
  music = null,
  titleImageUrl = null,
  endImageUrl = null,
  clipOrder,
  clipDurations = {},
  failures,
  time,
  onSeek,
  runId,
}: {
  edl: EDL;
  music?: MusicBed | null;
  titleImageUrl?: string | null;
  endImageUrl?: string | null;
  clipOrder: string[];
  clipDurations?: Record<string, number>;
  failures: Check[];
  time: number;
  onSeek: (t: number) => void;
  runId?: string;
}) {
  const titleLen = edl.title ? TITLE_SECONDS : 0;
  const musicH = music ? MUSIC_H : 0;
  const overlays = useMemo(() => edlOverlays(edl), [edl]);
  const labH = overlays.length ? LAB_H : 0;
  const endTitle = edlEndTitle(edl);
  const endCard = endCardRange(edl);
  const segments = useMemo(() => cutRanges(edl), [edl]);
  // The same helper the transport, scrubber and theater use, so the closing card counts everywhere.
  const total = Math.max(0.1, edlDuration(edl));
  const clipIds = useMemo(() => [...new Set(edl.cuts.map((c) => c.clipId))], [edl.cuts]);
  const sprites = useSprites(runId, clipIds);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewW, setViewW] = useState(800);
  const [zoom, setZoom] = useState(1);
  const [hover, setHover] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewW(el.clientWidth));
    ro.observe(el);
    setViewW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const pps = ((viewW - 24) / total) * zoom;
  const width = total * pps + 24;
  const x = (t: number) => Math.min(Math.max(t, 0), total) * pps;

  // Ctrl/Cmd + wheel zooms around the cursor (native listener so we can preventDefault).
  const zoomRef = useRef({ zoom, pps });
  useEffect(() => {
    zoomRef.current = { zoom, pps };
  });
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const { zoom: z, pps: p } = zoomRef.current;
      const nz = Math.min(16, Math.max(1, z * Math.exp(-e.deltaY * 0.01)));
      const r = el.getBoundingClientRect();
      const tAt = (e.clientX - r.left + el.scrollLeft) / p;
      setZoom(nz);
      requestAnimationFrame(() => {
        el.scrollLeft = tAt * p * (nz / z) - (e.clientX - r.left);
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Keep playhead in view while playing when zoomed.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || zoom <= 1) return;
    const px = time * pps;
    if (px < el.scrollLeft || px > el.scrollLeft + el.clientWidth - 40) el.scrollLeft = Math.max(0, px - 60);
  }, [time, pps, zoom]);

  const tFromEvent = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return Math.min(Math.max((e.clientX - r.left) / pps, 0), total);
  };

  // Three tick levels: major (labelled), mid (half-major), minor (tenths, only when there is room).
  const major = majorStep(pps);
  const showMinor = major * pps >= 110;
  const minor = major / 10;
  const ticks = Array.from({ length: Math.floor(total / minor) + 1 }, (_, i) => i).filter((i) => showMinor || i % 5 === 0);

  const step = (dir: 1 | -1) => {
    const i = ZOOMS.findIndex((z) => z >= zoom - 0.01);
    setZoom(ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, (i < 0 ? 0 : i) + dir))]);
  };

  const frameH = VIDEO_H - 12;
  const frameW = (frameH * FRAME_SRC_W) / FRAME_SRC_H;
  const tracksH = RULER_H + VIDEO_H + CAP_H + labH + musicH + MARK_H;

  return (
    <div className="flex shrink-0 flex-col border-t bg-panel select-none" aria-label="Timeline">
      {/* header */}
      <div className="flex h-9 shrink-0 items-center gap-3 border-b px-3">
        <span className="text-sm font-medium">Timeline</span>
        <span className="font-tc text-xs text-amber">{formatTime(time)}</span>
        <span className="font-tc text-xs text-faint">/ {formatTime(total)}</span>
        {overlays.length > 0 && (
          <span className="hidden items-center gap-1 text-[11px] text-muted-foreground lg:inline-flex">
            <Tag className="size-3 text-clip-1" /> O1 · {overlays.length} label{overlays.length === 1 ? "" : "s"}
          </span>
        )}
        {music && (
          <span className="hidden items-center gap-1 text-[11px] text-muted-foreground lg:inline-flex">
            <Music className="size-3 text-clip-2" /> M1 bed
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5 text-muted-foreground">
          <span className="mr-1 hidden text-[11px] text-faint sm:inline">Ctrl+scroll to zoom</span>
          <button type="button" aria-label="Zoom out" className="rounded p-0.5 hover:bg-accent hover:text-foreground" onClick={() => step(-1)}>
            <Minus className="size-3.5" />
          </button>
          <ZoomIn className="size-3.5" />
          <input
            type="range"
            aria-label="Timeline zoom"
            min={0}
            max={Math.log(16)}
            step={0.01}
            value={Math.log(zoom)}
            onChange={(e) => setZoom(Math.exp(Number(e.target.value)))}
            className="h-1 w-24 cursor-pointer accent-amber"
          />
          <button type="button" aria-label="Zoom in" className="rounded p-0.5 hover:bg-accent hover:text-foreground" onClick={() => step(1)}>
            <Plus className="size-3.5" />
          </button>
          <span className="font-tc w-8 text-right text-[11px]">{zoom.toFixed(1)}x</span>
        </div>
      </div>

      <div className="flex">
        {/* track labels */}
        <div
          className="grid shrink-0"
          style={{
            width: LABEL_W,
            gridTemplateRows: `${RULER_H}px ${VIDEO_H}px ${CAP_H}px ${labH ? `${LAB_H}px ` : ""}${music ? `${MUSIC_H}px ` : ""}${MARK_H}px`,
          }}
        >
          <div className="border-r border-b bg-panel" />
          <TrackLabel icon={<Film />} name="V1" />
          <TrackLabel icon={<Captions />} name="C1" />
          {labH > 0 && <TrackLabel icon={<Tag />} name="O1" />}
          {music && <TrackLabel icon={<Music />} name="M1" />}
          <TrackLabel icon={<Sparkles />} name="Argon" last />
        </div>

        {/* scroll area */}
        <div ref={scrollRef} className="relative min-w-0 flex-1 overflow-x-auto overflow-y-hidden">
          <div
            className="relative cursor-pointer touch-none bg-track outline-none"
            style={{ width, height: tracksH }}
            role="slider"
            tabIndex={0}
            aria-label="Timeline position"
            aria-valuemin={0}
            aria-valuemax={Math.round(total * 10) / 10}
            aria-valuenow={Math.round(time * 10) / 10}
            aria-valuetext={formatTime(time)}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              onSeek(tFromEvent(e));
            }}
            onPointerMove={(e) => {
              const t = tFromEvent(e);
              setHover(t);
              if (e.buttons === 1) onSeek(t);
            }}
            onPointerLeave={() => setHover(null)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight") onSeek(Math.min(total, time + (e.shiftKey ? 5 : 1 / 30)));
              else if (e.key === "ArrowLeft") onSeek(Math.max(0, time - (e.shiftKey ? 5 : 1 / 30)));
              else if (e.key === "Home") onSeek(0);
              else if (e.key === "End") onSeek(total);
              else if (e.key === "=" || e.key === "+") step(1);
              else if (e.key === "-") step(-1);
              else return;
              e.preventDefault();
            }}
          >
            {/* ruler */}
            <div className="absolute inset-x-0 top-0 border-b" style={{ height: RULER_H }}>
              {ticks.map((i) => {
                const t = i * minor;
                const isMajor = i % 10 === 0;
                const isMid = !isMajor && i % 5 === 0;
                return (
                  <div key={i} className="absolute bottom-0" style={{ left: x(t) }}>
                    <div className={`w-px bg-muted-foreground/40 ${isMajor ? "h-3" : isMid ? "h-2" : "h-1"}`} />
                    {isMajor && <span className="font-tc absolute -top-0.5 left-1 text-[10px] leading-none whitespace-nowrap text-muted-foreground">{label(t)}</span>}
                  </div>
                );
              })}
            </div>

            {/* grid lines through tracks */}
            <div className="pointer-events-none absolute inset-x-0 bottom-0" style={{ top: RULER_H }}>
              {ticks
                .filter((i) => i % 10 === 0)
                .map((i) => (
                  <span key={i} className="absolute inset-y-0 w-px bg-foreground/[0.04]" style={{ left: x(i * minor) }} />
                ))}
            </div>

            {/* V1 */}
            <div className="absolute inset-x-0 border-b" style={{ top: RULER_H, height: VIDEO_H }}>
              {titleLen > 0 && (
                <Tooltip label={<span>Title card · {edl.title}{titleImageUrl && " · art by Argon"}</span>}>
                  <div
                    className="absolute inset-y-1.5 flex flex-col justify-center overflow-hidden rounded-md bg-panel-2 bg-cover bg-center px-2 ring-1 ring-border"
                    style={{ left: 0, width: Math.max(2, x(titleLen) - 2), backgroundImage: titleImageUrl ? `url(${titleImageUrl})` : undefined }}
                  >
                    {titleImageUrl && <div className="absolute inset-0 bg-background/55" />}
                    <div className="relative flex items-center gap-1 truncate text-[10px] font-medium text-muted-foreground">
                      <Type className="size-3 shrink-0" /> Title
                    </div>
                    <div className="relative truncate text-[10px] text-faint">{edl.title}</div>
                  </div>
                </Tooltip>
              )}
              {segments.map(({ start, end, cut }) => {
                const len = end - start;
                const color = `var(--clip-${Math.max(0, clipOrder.indexOf(cut.clipId)) % 4})`;
                const n = sprites[cut.clipId] ?? 0;
                const w = Math.max(2, x(end) - x(start) - 2);
                const tiles = n > 0 ? Math.ceil(w / frameW) : 0;
                return (
                  <Tooltip
                    key={cut.id}
                    label={
                      <span className="block">
                        <b className="font-medium">
                          {cut.id} · {cut.clipId} {cut.srcIn.toFixed(1)}–{cut.srcOut.toFixed(1)}s
                        </b>
                        {cut.reason && <span className="mt-0.5 block text-muted-foreground">{cut.reason}</span>}
                      </span>
                    }
                  >
                    <div
                      className="group absolute inset-y-1.5 overflow-hidden rounded-md ring-1 ring-background"
                      style={{ left: x(start) + 1, width: w, background: `color-mix(in oklab, ${color} 30%, var(--color-panel-2))` }}
                    >
                      {tiles > 0 && (
                        <div className="absolute inset-0 flex">
                          {Array.from({ length: tiles }, (_, k) => {
                            const frame = spriteFrame(cut.srcIn + (k * frameW) / pps, n, clipDurations[cut.clipId]);
                            return (
                              <div
                                key={k}
                                className="h-full shrink-0 border-r border-black/40"
                                style={spriteFrameStyle(runId ?? "", cut.clipId, n, frame, frameW, frameH)}
                              />
                            );
                          })}
                        </div>
                      )}
                      <div className="absolute inset-x-0 top-0 h-[3px]" style={{ background: color }} />
                      <span className="font-tc absolute bottom-1 left-1.5 max-w-[calc(100%-12px)] truncate rounded bg-background/75 px-1 text-[10px] leading-4 backdrop-blur-sm">
                        {cut.id} · {cut.clipId}
                      </span>
                      <span className="font-tc absolute top-1.5 right-1.5 rounded bg-background/60 px-1 text-[9.5px] leading-4 text-muted-foreground">
                        {len.toFixed(1)}s
                      </span>
                      {tiles === 0 && cut.reason && <div className="absolute inset-x-1.5 top-2 truncate text-[10px] text-muted-foreground">{cut.reason}</div>}
                      <div className="absolute inset-y-0 left-0 w-[3px] bg-foreground/0 transition-colors group-hover:bg-foreground/60" />
                      <div className="absolute inset-y-0 right-0 w-[3px] bg-foreground/0 transition-colors group-hover:bg-foreground/60" />
                    </div>
                  </Tooltip>
                );
              })}
              {endCard && endTitle && (
                <Tooltip label={<span>End card · {endTitle}{endImageUrl && " · art by Argon"}</span>}>
                  <div
                    className="absolute inset-y-1.5 flex flex-col justify-center overflow-hidden rounded-md bg-panel-2 bg-cover bg-center px-2 ring-1 ring-border"
                    style={{ left: x(endCard.start) + 1, width: Math.max(2, x(endCard.end) - x(endCard.start) - 2), backgroundImage: endImageUrl ? `url(${endImageUrl})` : undefined }}
                  >
                    {endImageUrl && <div className="absolute inset-0 bg-background/55" />}
                    <div className="relative flex items-center gap-1 truncate text-[10px] font-medium text-muted-foreground">
                      <Type className="size-3 shrink-0" /> End card
                    </div>
                    <div className="relative truncate text-[10px] text-faint">{endTitle}</div>
                  </div>
                </Tooltip>
              )}
            </div>

            {/* C1 */}
            <div className="absolute inset-x-0 border-b" style={{ top: RULER_H + VIDEO_H, height: CAP_H }}>
              {edl.captions.map((c, i) => (
                <Tooltip key={i} label={c.text}>
                  <div
                    className="absolute inset-y-1 truncate rounded bg-caption/20 px-1.5 text-[10px] leading-5 text-amber ring-1 ring-caption/30"
                    style={{ left: x(c.start) + 1, width: Math.max(2, x(c.end) - x(c.start) - 2) }}
                  >
                    {c.text}
                  </div>
                </Tooltip>
              ))}
            </div>

            {/* O1: on-screen labels, each chip carrying a glyph for where it sits in the frame */}
            {labH > 0 && (
              <div className="absolute inset-x-0 border-b" style={{ top: RULER_H + VIDEO_H + CAP_H, height: LAB_H }}>
                {overlays.map((o, i) => (
                  <Tooltip
                    key={i}
                    label={
                      <span className="block">
                        <b className="font-medium">{o.text}</b>
                        <span className="mt-0.5 block text-muted-foreground">
                          Label · {o.position} · {formatTime(o.start)}–{formatTime(o.end)}
                        </span>
                      </span>
                    }
                  >
                    <div
                      className="absolute inset-y-1 flex items-center gap-1 overflow-hidden rounded px-1.5 text-[10px] leading-5 text-clip-1 ring-1 ring-clip-1/40"
                      style={{ left: x(o.start) + 1, width: Math.max(2, x(o.end) - x(o.start) - 2), background: "color-mix(in oklab, var(--clip-1) 20%, var(--color-panel-2))" }}
                    >
                      <PositionGlyph position={o.position} />
                      <span className="truncate">{o.text}</span>
                    </div>
                  </Tooltip>
                ))}
              </div>
            )}

            {/* M1: the music bed runs under the whole cut */}
            {music && (
              <div className="absolute inset-x-0 border-b" style={{ top: RULER_H + VIDEO_H + CAP_H + labH, height: MUSIC_H }}>
                <Tooltip
                  label={
                    <span className="block">
                      <b className="font-medium">Music bed</b>
                      <span className="mt-0.5 block text-muted-foreground">{music.prompt}</span>
                      {music.gainDb != null && <span className="font-tc mt-0.5 block text-muted-foreground">{music.gainDb > 0 ? "+" : ""}{music.gainDb} dB under speech</span>}
                    </span>
                  }
                >
                  <div
                    className="absolute inset-y-1 flex items-center gap-1.5 overflow-hidden rounded px-1.5 ring-1 ring-clip-2/40"
                    style={{ left: 1, width: Math.max(2, x(total) - 2), background: "color-mix(in oklab, var(--clip-2) 22%, var(--color-panel-2))" }}
                  >
                    <Waveform />
                    <span className="relative flex min-w-0 items-center gap-1 rounded bg-background/75 px-1.5 text-[10px] leading-4 backdrop-blur-sm">
                      <Music className="size-3 shrink-0 text-clip-2" />
                      <span className="truncate">{music.prompt}</span>
                    </span>
                    {music.gainDb != null && (
                      <span className="font-tc relative ml-auto shrink-0 rounded bg-background/60 px-1 text-[9.5px] leading-4 text-muted-foreground">
                        {music.gainDb > 0 ? "+" : ""}
                        {music.gainDb} dB
                      </span>
                    )}
                  </div>
                </Tooltip>
              </div>
            )}

            {/* Argon QA */}
            <div className="absolute inset-x-0" style={{ top: RULER_H + VIDEO_H + CAP_H + labH + musicH, height: MARK_H }}>
              {failures
                .filter((f) => f.at != null)
                .map((f, i) => (
                  <Tooltip key={i} label={f.name}>
                    <button
                      type="button"
                      aria-label={`Jump to failed check: ${f.name}`}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        onSeek(f.at!);
                      }}
                      className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-[2px] bg-fail ring-2 ring-track hover:scale-125"
                      style={{ left: x(f.at!) }}
                    />
                  </Tooltip>
                ))}
            </div>

            {/* hover ghost */}
            {hover != null && (
              <div className="pointer-events-none absolute inset-y-0 w-px bg-foreground/30" style={{ left: x(hover) }}>
                <span className="font-tc absolute top-0.5 left-1 rounded-sm bg-panel-2 px-1 text-[9.5px] leading-[14px] whitespace-nowrap text-muted-foreground shadow-tile">
                  {formatTime(hover)}
                </span>
              </div>
            )}

            {/* playhead */}
            <div className="pointer-events-none absolute inset-y-0 z-10 w-px bg-amber" style={{ left: x(time) }}>
              <div className="absolute top-0 -left-[5px] h-3 w-[11px] rounded-b-sm bg-amber" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Decorative pseudo-waveform behind the music bed label; a repeating gradient so it costs nothing at any width. */
function Waveform() {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-x-0 top-1/2 h-2 -translate-y-1/2 opacity-30"
      style={{
        backgroundImage: "repeating-linear-gradient(90deg, var(--clip-2) 0 2px, transparent 2px 5px)",
        maskImage: "repeating-linear-gradient(90deg, black 0 1px, transparent 1px 3px, black 3px 7px, transparent 7px 9px), linear-gradient(90deg, transparent, black 6%, black 94%, transparent)",
        maskComposite: "intersect",
      }}
    />
  );
}

/** A 3x3 frame with one lit cell: where an on-screen label sits ("top-left", "bottom", "center", ...). */
export function PositionGlyph({ position, className = "" }: { position: string; className?: string }) {
  const { row, col } = overlayCell(position);
  return (
    <span aria-hidden className={`grid size-3 shrink-0 grid-cols-3 gap-px rounded-[2px] ring-1 ring-current/50 ${className}`}>
      {Array.from({ length: 9 }, (_, k) => (
        <span key={k} className={`rounded-[1px] ${Math.floor(k / 3) === row && k % 3 === col ? "bg-current" : "bg-transparent"}`} />
      ))}
    </span>
  );
}

function TrackLabel({ icon, name, last }: { icon: React.ReactNode; name: string; last?: boolean }) {
  return (
    <div className={`flex items-center gap-2 border-r bg-panel px-3 text-xs text-muted-foreground [&_svg]:size-3.5 ${last ? "" : "border-b"}`}>
      {icon}
      <span className="font-tc">{name}</span>
    </div>
  );
}

/** Placeholder with the same footprint while the first version renders. */
export function TimelineSkeleton() {
  return (
    <div className="flex shrink-0 flex-col border-t bg-panel" aria-hidden>
      <div className="flex h-9 items-center gap-3 border-b px-3">
        <span className="text-sm font-medium">Timeline</span>
        <span className="font-tc text-xs text-muted-foreground">0:00.0</span>
      </div>
      <div className="flex">
        <div className="grid shrink-0" style={{ width: LABEL_W, gridTemplateRows: `${RULER_H}px ${VIDEO_H}px ${CAP_H}px ${MARK_H}px` }}>
          <div className="border-r border-b bg-panel" />
          <TrackLabel icon={<Film />} name="V1" />
          <TrackLabel icon={<Captions />} name="C1" />
          <TrackLabel icon={<Sparkles />} name="Argon" last />
        </div>
        <div className="relative min-w-0 flex-1 bg-track" style={{ height: RULER_H + VIDEO_H + CAP_H + MARK_H }}>
          <div className="absolute inset-x-0 top-0 border-b" style={{ height: RULER_H }} />
          <div className="absolute inset-x-0 flex gap-1 px-1 py-1.5" style={{ top: RULER_H, height: VIDEO_H }}>
            {[3, 5, 4].map((w, k) => (
              <div key={k} className="animate-pulse rounded-md bg-muted" style={{ flex: w }} />
            ))}
          </div>
          <div className="absolute inset-x-0 flex gap-1 px-1 py-1" style={{ top: RULER_H + VIDEO_H, height: CAP_H }}>
            {[2, 3, 2, 3, 2].map((w, k) => (
              <div key={k} className="animate-pulse rounded bg-muted" style={{ flex: w }} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
