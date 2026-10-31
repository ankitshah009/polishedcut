"use client";

import { Check, Clapperboard, Expand, PencilRuler } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import type { Run } from "@/lib/schema";
import { cn } from "@/lib/utils";

import { checksOf, isFinished, lastIteration, runTitle, spriteUrl, videoUrl } from "./runs";

/** Loops the final render of the most recent finished cut. Clicking it opens theater mode. */
export function Featured({ runs, onOpen }: { runs: Run[] | null; onOpen: (run: Run) => void }) {
  const run = runs?.find(isFinished);
  const last = run ? lastIteration(run) : undefined;
  const checks = run ? checksOf(run) : null;
  const [progress, setProgress] = useState(0);

  return (
    <section aria-label="Latest cut" className="overflow-hidden rounded-2xl border bg-card shadow-tile lg:col-span-3">
      {run && last ? (
        <>
          <button
            type="button"
            onClick={() => onOpen(run)}
            aria-label={`Watch ${runTitle(run)} in theater mode`}
            className="group relative block aspect-video w-full overflow-hidden bg-muted text-left focus-visible:outline-2 focus-visible:outline-ring"
            style={{
              // First frame of the first clip sits behind the video so there is always a picture.
              backgroundImage: `url(${spriteUrl(run.id, run.clips[0]?.id ?? "clip1")})`,
              backgroundSize: "auto 100%",
              backgroundPosition: "left center",
              backgroundRepeat: "no-repeat",
            }}
          >
            <video
              key={run.id}
              src={videoUrl(run.id, last.video)}
              autoPlay
              muted
              loop
              playsInline
              onTimeUpdate={(e) => {
                const v = e.currentTarget;
                if (v.duration > 0) setProgress(v.currentTime / v.duration);
              }}
              className="absolute inset-0 size-full object-cover"
            />
            <div className="absolute inset-x-0 bottom-0 h-1 bg-foreground/20">
              <div className="h-full bg-amber" style={{ width: `${Math.round(progress * 1000) / 10}%` }} />
            </div>
            <span className="absolute top-4 left-4 inline-flex items-center gap-1.5 rounded-full bg-background/90 px-3 py-1 text-xs font-medium backdrop-blur">
              <span className="size-1.5 rounded-full bg-success" /> Latest cut · v{last.n}
            </span>
            <span className="absolute inset-0 grid place-items-center bg-black/0 transition-colors group-hover:bg-black/20">
              <span className="inline-flex items-center gap-2 rounded-full bg-background/90 px-4 py-2 text-sm font-medium opacity-0 shadow-lift backdrop-blur transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                <Expand className="size-4" /> Watch in theater
              </span>
            </span>
          </button>
          <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 p-5">
            <div className="min-w-0">
              <p className="font-medium">{runTitle(run)}</p>
              <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{run.brief}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {checks && (
                <span
                  className={cn(
                    "inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium",
                    checks.passed === checks.total ? "bg-success/15 text-success" : "bg-amber/15 text-accent-foreground",
                  )}
                >
                  <Check className="size-3.5" /> {checks.passed}/{checks.total} checks passed
                </span>
              )}
              <Link href={`/runs/${run.id}`} className="inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-sm font-medium hover:bg-muted">
                <PencilRuler className="size-3.5" /> Open in editor
              </Link>
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="grid aspect-video place-items-center bg-muted">
            {runs === null ? (
              <div className="size-full animate-pulse bg-muted" aria-hidden />
            ) : (
              <span className="flex flex-col items-center gap-2 text-sm text-muted-foreground">
                <Clapperboard className="size-6" />
                Your first finished cut will play here
              </span>
            )}
          </div>
          <div className="p-5">
            <p className="font-medium">{runs === null ? "Loading your cuts" : "No finished cut yet"}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {runs === null
                ? "One moment."
                : "Drop footage on the right or try the demo clips. Argon drafts, renders, watches and fixes the cut."}
            </p>
          </div>
        </>
      )}
    </section>
  );
}
