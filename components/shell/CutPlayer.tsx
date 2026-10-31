"use client";

import { Check, Pause, Play } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { edlDuration, endCardRange, fixCardsBetween, formatTime } from "@/lib/format";
import type { Run } from "@/lib/schema";
import { cn } from "@/lib/utils";

import { spriteUrl, videoUrl } from "./runs";

/**
 * A real <video> for one version of a run, with a scrubber that marks the failed checks of that
 * version (red bars, from its critique) and the fixes that went into it (amber dots, from the
 * previous version's patches). Shared by theater mode and the public share page.
 */
export function CutPlayer({
  run,
  index,
  onIndexChange,
  autoPlay = false,
  className,
}: {
  run: Run;
  index: number;
  onIndexChange: (i: number) => void;
  autoPlay?: boolean;
  className?: string;
}) {
  const its = run.iterations;
  const idx = Math.min(Math.max(0, index), Math.max(0, its.length - 1));
  const it = its[idx];
  const ref = useRef<HTMLVideoElement>(null);
  const [time, setTime] = useState(0);
  const [dur, setDur] = useState(0);
  const [playing, setPlaying] = useState(false);

  const checks = it?.critique?.checks ?? [];
  const fails = checks.filter((c) => !c.passed);
  const fixes = useMemo(() => (it && idx > 0 ? fixCardsBetween(its[idx - 1], it).filter((f) => f.at != null) : []), [its, it, idx]);
  // edlDuration() is the shared total (title card + cuts + closing card), the same number the editor's
  // timeline and transport show; the file's own metadata replaces it once the video has loaded.
  const length = dur || (it ? edlDuration(it.edl) : 0);
  const endCard = it ? endCardRange(it.edl) : null;

  const seek = (t: number) => {
    const v = ref.current;
    const clamped = Math.min(Math.max(0, t), length);
    if (v) v.currentTime = clamped;
    setTime(clamped);
  };
  const toggle = () => {
    const v = ref.current;
    if (!v) return;
    if (!v.paused) v.pause();
    else {
      if (v.ended) seek(0);
      void v.play().catch(() => setPlaying(false));
    }
  };

  return (
    <div className={cn("w-full", className)}>
      <div
        className="relative aspect-video overflow-hidden rounded-xl bg-track shadow-lift ring-1 ring-border"
        style={{
          backgroundImage: `url(${spriteUrl(run.id, run.clips[0]?.id ?? "clip1")})`,
          backgroundSize: "auto 100%",
          backgroundPosition: "left center",
          backgroundRepeat: "no-repeat",
        }}
      >
        {it ? (
          <video
            key={it.video}
            ref={ref}
            src={videoUrl(run.id, it.video)}
            autoPlay={autoPlay}
            playsInline
            preload="auto"
            onLoadedMetadata={(e) => setDur(e.currentTarget.duration || 0)}
            onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
            className="absolute inset-0 size-full bg-black object-contain"
          />
        ) : (
          <p className="absolute inset-0 grid place-items-center text-sm text-muted-foreground">No version has been rendered yet.</p>
        )}
        {it && (
          <button
            type="button"
            onClick={toggle}
            aria-label={playing ? "Pause video" : "Play video"}
            className={cn("absolute inset-0 grid place-items-center transition-opacity", playing ? "opacity-0 hover:opacity-100 focus-visible:opacity-100" : "bg-black/20")}
          >
            <span className="grid size-16 place-items-center rounded-full bg-black/70 text-white shadow-tile backdrop-blur">
              {playing ? <Pause className="size-7 fill-current" /> : <Play className="ml-1 size-7 fill-current" />}
            </span>
          </button>
        )}
        {it && (
          <span className="font-tc pointer-events-none absolute top-4 right-4 rounded-lg bg-black/70 px-2.5 py-1 text-xs text-white">
            v{it.n}
            {it.note ? " · note" : ""}
          </span>
        )}
      </div>

      {/* Scrubber */}
      <div className="mt-4 flex items-center gap-3">
        <span className="font-tc w-12 text-xs text-muted-foreground">{formatTime(time)}</span>
        <div className="relative flex-1">
          <input
            aria-label="Video scrubber"
            type="range"
            min={0}
            max={Math.max(0.1, length)}
            step={0.1}
            value={Math.min(time, length)}
            onChange={(e) => seek(Number(e.target.value))}
            className="block h-6 w-full cursor-pointer accent-amber"
          />
          {length > 0 && endCard && (
            <span
              aria-hidden
              title="End card"
              className="pointer-events-none absolute top-1/2 h-2 -translate-y-1/2 rounded-sm bg-foreground/25"
              style={{ left: `${Math.min(100, (endCard.start / length) * 100)}%`, width: `${Math.max(0, Math.min(100, ((endCard.end - endCard.start) / length) * 100))}%` }}
            />
          )}
          {length > 0 &&
            fails.map(
              (f, i) =>
                f.at != null && (
                  <button
                    key={`f${i}`}
                    type="button"
                    title={`Failed: ${f.name}${f.note ? ` — ${f.note}` : ""}`}
                    aria-label={`Failed check: ${f.name}`}
                    onClick={() => seek(f.at ?? 0)}
                    className="absolute top-1/2 h-4 w-1 -translate-x-1/2 -translate-y-1/2 rounded-sm bg-fail ring-2 ring-background"
                    style={{ left: `${Math.min(100, (f.at / length) * 100)}%` }}
                  />
                ),
            )}
          {length > 0 &&
            fixes.map((f, i) => (
              <button
                key={`x${i}`}
                type="button"
                title={f.reason || f.title}
                aria-label={`Fix: ${f.title}`}
                onClick={() => seek(f.at ?? 0)}
                className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-amber ring-2 ring-background"
                style={{ left: `${Math.min(100, ((f.at ?? 0) / length) * 100)}%` }}
              />
            ))}
        </div>
        <span className="font-tc text-xs text-muted-foreground">{formatTime(length)}</span>
      </div>

      {/* Versions and score */}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
        <div role="tablist" aria-label="Versions" className="flex gap-1">
          {its.map((v, k) => {
            const f = v.critique?.checks.filter((c) => !c.passed).length ?? 0;
            const active = k === idx;
            return (
              <button
                key={v.n}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => onIndexChange(k)}
                className={cn(
                  "inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-sm transition-colors",
                  active ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )}
              >
                v{v.n}
                {v.critique && <span className={cn("size-1.5 rounded-full", f ? "bg-fail" : "bg-success")} />}
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {fails.length > 0 && (
            <span className="inline-flex items-center gap-1.5">
              <span className="h-3 w-1 rounded-sm bg-fail" /> {fails.length} failed
            </span>
          )}
          {fixes.length > 0 && (
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-amber" /> {fixes.length} fix{fixes.length === 1 ? "" : "es"} into v{it?.n}
            </span>
          )}
          {checks.length > 0 && (
            <span className={cn("inline-flex items-center gap-1.5 text-sm font-medium", fails.length ? "text-fail" : "text-success")}>
              <Check className="size-4" />
              {checks.length - fails.length}/{checks.length} checks passed
            </span>
          )}
        </div>
      </div>

      {/* Why this cut */}
      <p className="mt-3 text-sm leading-relaxed text-muted-foreground" title={it?.critique?.summary}>
        {it?.critique?.summary || (it ? (it.critique ? `v${it.n}: no summary was written.` : `Argon has not watched v${it.n} yet.`) : "")}
      </p>
    </div>
  );
}
