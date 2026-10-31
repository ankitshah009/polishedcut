"use client";

import { ArrowUpRight, Check, Download, Share2, X } from "lucide-react";
import Link from "next/link";
import { Dialog } from "radix-ui";
import { useEffect, useState } from "react";

import type { Run } from "@/lib/schema";

import { CutPlayer } from "./CutPlayer";
import { checksOf, runTitle, videoUrl } from "./runs";

/**
 * Theater mode: a full-screen lightbox over the dashboard that plays any version of a cut.
 * Version pills (and ← →) switch the source; the scrubber carries the failed checks of that version
 * in red and the fixes that went into it in amber. The editor stays one click away.
 */
export function Theater({ run, onClose }: { run: Run | null; onClose: () => void }) {
  return (
    <Dialog.Root open={run !== null} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/80 backdrop-blur-sm data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          aria-describedby="theater-description"
          className="dark fixed inset-0 z-50 flex items-center overflow-y-auto bg-background px-4 py-6 text-foreground outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 sm:px-12 sm:py-8"
        >
          {run && <TheaterBody key={run.id} run={run} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function TheaterBody({ run }: { run: Run }) {
  const its = run.iterations;
  const [idx, setIdx] = useState(Math.max(0, its.length - 1));
  const it = its[Math.min(idx, its.length - 1)];
  const checks = checksOf(run);

  // ← → switch versions. The video keeps keyboard focus for space, so only the arrows are intercepted.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      setIdx((i) => Math.min(its.length - 1, Math.max(0, i + (e.key === "ArrowLeft" ? -1 : 1))));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [its.length]);

  return (
    <div className="m-auto w-full max-w-5xl">
      <header className="mb-5 flex items-center justify-between gap-4">
        <div className="min-w-0">
          <Dialog.Title className="truncate text-lg font-medium">{runTitle(run)}</Dialog.Title>
          <Dialog.Description id="theater-description" className="mt-1 truncate text-xs text-muted-foreground">
            {its.length} version{its.length === 1 ? "" : "s"}
            {checks ? ` · ${checks.passed}/${checks.total} checks passed on v${its.length}` : ""} · ← → switch versions · Esc closes
          </Dialog.Description>
        </div>
        <Dialog.Close aria-label="Close theater" className="grid size-9 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
          <X className="size-5" />
        </Dialog.Close>
      </header>

      <CutPlayer run={run} index={idx} onIndexChange={setIdx} autoPlay />

      <div className="mt-6 flex flex-wrap gap-2 border-t pt-5">
        <Link href={`/runs/${run.id}`} className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground shadow-tile hover:brightness-105">
          <ArrowUpRight className="size-4" /> Open in editor
        </Link>
        {it && (
          <a
            href={videoUrl(run.id, it.video)}
            download={`polishedcut-${run.id}-v${it.n}.mp4`}
            className="inline-flex h-9 items-center gap-2 rounded-lg border bg-panel-2 px-4 text-sm font-medium hover:bg-accent"
          >
            <Download className="size-4" /> Download v{it.n}
          </a>
        )}
        <Link href={`/s/${run.id}`} className="inline-flex h-9 items-center gap-2 rounded-lg border bg-panel-2 px-4 text-sm font-medium hover:bg-accent">
          <Share2 className="size-4" /> Share
        </Link>
        {it && (
          <span className="ml-auto inline-flex items-center gap-1.5 self-center text-xs text-muted-foreground">
            <Check className="size-3.5" /> {it.edl.width}×{it.edl.height} · {it.edl.fps} fps
          </span>
        )}
      </div>
    </div>
  );
}
