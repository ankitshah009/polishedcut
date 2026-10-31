"use client";

import { AlertTriangle, Check, Expand, Film, Layers, Loader2, PencilRuler } from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";

import { formatUsd } from "@/lib/format";
import type { Run } from "@/lib/schema";
import { cn } from "@/lib/utils";

import { ago, checksOf, isFinished, lastIteration, runTitle, spriteUrl, statusLabel, videoUrl } from "./shell/runs";

function StatusBadge({ run }: { run: Run }) {
  const { tone, text } = statusLabel(run);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full bg-background/90 px-2 py-0.5 text-xs font-medium backdrop-blur",
        tone === "done" && "text-success",
        tone === "failed" && "text-fail",
        tone === "live" && "text-accent-foreground",
      )}
    >
      {tone === "done" && <Check className="size-3" />}
      {tone === "failed" && <AlertTriangle className="size-3" />}
      {tone === "live" && <Loader2 className="size-3 animate-spin text-amber" />}
      {text}
    </span>
  );
}

function PastCard({ run, cost, onOpen }: { run: Run; cost: number | null; onOpen: (run: Run) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const last = lastIteration(run);
  const checks = checksOf(run);
  const firstClip = run.clips[0]?.id ?? "clip1";
  const preview = isFinished(run) && last ? videoUrl(run.id, last.video) : null;
  // Finished cuts open in theater mode; live and stopped ones go straight to the editor.
  const theater = run.iterations.length > 0 && (run.status === "done" || run.status === "error");

  const play = () => void videoRef.current?.play().catch(() => {});
  const stop = () => {
    const v = videoRef.current;
    if (!v) return;
    v.pause();
    v.currentTime = 0;
    setPlaying(false);
  };

  const thumb = (
    <>
      {preview && (
        <video
          ref={videoRef}
          src={preview}
          muted
          loop
          playsInline
          preload="none"
          onPlaying={() => setPlaying(true)}
          className={cn("absolute inset-0 size-full object-cover transition-opacity duration-300", playing ? "opacity-100" : "opacity-0")}
        />
      )}
      <div className="absolute top-3 left-3">
        <StatusBadge run={run} />
      </div>
      {theater && (
        <span className="absolute right-3 bottom-3 inline-flex items-center gap-1.5 rounded-full bg-background/90 px-2.5 py-1 text-xs font-medium opacity-0 backdrop-blur transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          <Expand className="size-3.5" /> Theater
        </span>
      )}
    </>
  );
  const thumbStyle = {
    // The sprite is N frames of 160x90 side by side; `auto 100%` + left shows just the first frame.
    backgroundImage: `url(${spriteUrl(run.id, firstClip)})`,
    backgroundSize: "auto 100%",
    backgroundPosition: "left center",
    backgroundRepeat: "no-repeat",
  };
  const thumbClass = "relative block aspect-video w-full overflow-hidden bg-muted text-left focus-visible:outline-2 focus-visible:outline-ring";

  return (
    <article
      onMouseEnter={play}
      onMouseLeave={stop}
      onFocus={play}
      onBlur={stop}
      className="group overflow-hidden rounded-2xl border bg-card shadow-tile transition-all hover:-translate-y-0.5 hover:shadow-lift"
    >
      {theater ? (
        <button type="button" onClick={() => onOpen(run)} aria-label={`Watch ${runTitle(run)} in theater mode`} className={thumbClass} style={thumbStyle}>
          {thumb}
        </button>
      ) : (
        <Link href={`/runs/${run.id}`} className={thumbClass} style={thumbStyle}>
          {thumb}
        </Link>
      )}
      <div className="p-4">
        <div className="flex items-center justify-between gap-2">
          <Link href={`/runs/${run.id}`} className="min-w-0 truncate font-medium hover:underline">
            {runTitle(run)}
          </Link>
          <Link href={`/runs/${run.id}`} aria-label="Open in editor" title="Open in editor" className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
            <PencilRuler className="size-3.5" />
          </Link>
        </div>
        <div className="mt-2 flex items-center gap-3 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <Layers className="size-3.5" />
            {run.iterations.length} version{run.iterations.length === 1 ? "" : "s"}
          </span>
          <span className={cn("inline-flex items-center gap-1 font-tc", run.status === "error" && "text-fail")}>
            <Film className="size-3.5" />
            {checks ? `${checks.passed}/${checks.total}` : run.status === "error" ? "failed" : "–"}
          </span>
          {cost != null && (
            <span className="font-tc" title="Estimated spend on this cut">
              ≈ {formatUsd(cost)}
            </span>
          )}
          <span className="ml-auto">{ago(run.createdAt)}</span>
        </div>
      </div>
    </article>
  );
}

/** Every run, newest first, as a grid of cards. `costOf` supplies the estimated spend shown on each card. */
export function PastRuns({
  runs,
  costOf = () => null,
  onOpen = () => {},
}: {
  runs: Run[] | null;
  costOf?: (run: Run) => number | null;
  onOpen?: (run: Run) => void;
}) {
  return (
    <section id="past" aria-label="Past cuts" className="mt-12 scroll-mt-8">
      <div className="flex items-baseline justify-between">
        <h2 className="text-xl font-semibold tracking-tight">Past cuts</h2>
        {runs && runs.length > 0 && (
          <span className="text-sm text-muted-foreground">
            {runs.length} cut{runs.length === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {runs === null && (
        <div className="mt-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-3" aria-hidden>
          {[0, 1, 2].map((i) => (
            <div key={i} className="overflow-hidden rounded-2xl border bg-card shadow-tile">
              <div className="aspect-video animate-pulse bg-muted" />
              <div className="space-y-2 p-4">
                <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
                <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
              </div>
            </div>
          ))}
        </div>
      )}

      {runs && runs.length === 0 && (
        <p className="mt-5 rounded-2xl border border-dashed p-8 text-center text-sm text-muted-foreground">
          No cuts yet. Drop footage above or try the demo clips.
        </p>
      )}

      {runs && runs.length > 0 && (
        <div className="mt-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {runs.map((r) => (
            <PastCard key={r.id} run={r} cost={costOf(r)} onOpen={onOpen} />
          ))}
        </div>
      )}
    </section>
  );
}
