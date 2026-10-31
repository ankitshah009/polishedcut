"use client";

import { Captions, Check, Download, Music, RectangleHorizontal, RectangleVertical, Square, X, type LucideIcon } from "lucide-react";
import { Dialog } from "radix-ui";
import { useState } from "react";

import { edlDuration, edlMusic, formatSeconds, videoUrl } from "@/lib/format";
import type { Iteration, Run } from "@/lib/schema";
import { cn } from "@/lib/utils";

type Preset = { id: string; title: string; subtitle: string; icon: LucideIcon; ready: boolean };

/**
 * Export: download the rendered mp4 as it is. The pipeline renders one aspect ratio with captions
 * and music burned in, so the other presets and the toggles are shown but honestly marked "soon".
 */
export function ExportDialog({ run, it, disabled }: { run: Run; it: Iteration | undefined; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState(0);
  const [done, setDone] = useState(false);
  const landscape = it ? it.edl.width >= it.edl.height : true;
  const music = it ? edlMusic(it.edl) : null;
  const captions = (it?.edl.captions.length ?? 0) > 0;

  const presets: Preset[] = [
    {
      id: "16x9",
      title: it ? `${it.edl.width}×${it.edl.height} · ${landscape ? "16:9" : "as rendered"}` : "As rendered",
      subtitle: it ? `MP4 · H.264 · ${it.edl.fps} fps · ${formatSeconds(edlDuration(it.edl))}` : "MP4",
      icon: RectangleHorizontal,
      ready: true,
    },
    { id: "9x16", title: "9:16 vertical", subtitle: "Reframed for Shorts and Reels", icon: RectangleVertical, ready: false },
    { id: "1x1", title: "1:1 square", subtitle: "Feed-friendly crop", icon: Square, ready: false },
  ];
  const selected = presets[format] ?? presets[0];

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setDone(false);
      }}
    >
      <Dialog.Trigger
        disabled={disabled || !it}
        className="inline-flex h-8 shrink-0 items-center gap-2 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:brightness-105 disabled:opacity-40"
      >
        <Download className="size-4" />
        Export
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content className="dark fixed top-1/2 left-1/2 z-50 flex max-h-[90dvh] w-[min(480px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-xl border bg-card p-5 text-foreground shadow-lift outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95">
          <div className="flex items-start justify-between gap-3">
            <div>
              <Dialog.Title className="text-base font-medium">Export your cut</Dialog.Title>
              <Dialog.Description className="mt-1 text-xs text-muted-foreground">
                {it ? `v${it.n} · ${formatSeconds(edlDuration(it.edl))}` : "No version yet"} · {run.brief.length > 60 ? `${run.brief.slice(0, 57)}…` : run.brief}
              </Dialog.Description>
            </div>
            <Dialog.Close aria-label="Close" className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
              <X className="size-4" />
            </Dialog.Close>
          </div>

          <div className="space-y-2">
            {presets.map((p, i) => (
              <button
                key={p.id}
                type="button"
                disabled={!p.ready}
                aria-pressed={format === i}
                onClick={() => {
                  setFormat(i);
                  setDone(false);
                }}
                className={cn(
                  "flex w-full items-center gap-4 rounded-xl border px-4 py-3.5 text-left transition-colors",
                  format === i ? "border-amber bg-accent" : "bg-panel-2 hover:bg-accent/60",
                  !p.ready && "cursor-not-allowed opacity-60 hover:bg-panel-2",
                )}
              >
                <p.icon className="size-5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-sm">
                    {p.title}
                    {!p.ready && <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">coming soon</span>}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">{p.subtitle}</span>
                </span>
                {format === i && <Check className="size-4 shrink-0 text-amber" />}
              </button>
            ))}
          </div>

          <div className="divide-y border-y">
            <Toggle icon={Captions} label="Captions" on={captions} note={captions ? "Burned in as rendered" : "This cut has no captions"} />
            <Toggle icon={Music} label="Music" on={music !== null} note={music ? "Mixed in as rendered" : "This cut has no music bed"} />
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            The file you get is the exact render Argon watched and graded. Captions and music are part of the picture and sound, so they cannot be toggled yet.
          </p>

          {it && (
            <a
              href={videoUrl(run.id, it.video)}
              download={`polishedtake-${run.id}-v${it.n}-${selected.id}.mp4`}
              onClick={() => setDone(true)}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground shadow-tile hover:brightness-105"
            >
              <Download className="size-4" />
              {done ? "Download again" : `Download v${it.n} (MP4)`}
            </a>
          )}
          {done && (
            <p role="status" className="text-center text-xs text-success">
              Your download has started.
            </p>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** A switch that reflects what the render contains. Disabled, with a "soon" badge, until exports can change it. */
function Toggle({ icon: Icon, label, on, note }: { icon: LucideIcon; label: string; on: boolean; note: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-3 text-sm">
      <span className="flex min-w-0 items-center gap-2.5">
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0">
          <span className="flex items-center gap-2">
            {label}
            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">soon</span>
          </span>
          <span className="block truncate text-xs text-muted-foreground">{note}</span>
        </span>
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={`${label} (not adjustable yet)`}
        disabled
        className={cn("relative h-5 w-9 shrink-0 cursor-not-allowed rounded-full opacity-50 transition-colors", on ? "bg-amber" : "bg-muted")}
      >
        <span className={cn("absolute top-0.5 size-4 rounded-full bg-background shadow transition-transform", on ? "left-4.5" : "left-0.5")} />
      </button>
    </div>
  );
}
