"use client";

import { Clapperboard, Eye, Loader2, Scissors, Sparkles, Upload, Wrench, type LucideIcon } from "lucide-react";
import Link from "next/link";

import { cn } from "@/lib/utils";

import { focusNewCut, useDemo } from "./demo";

const LOOP: { n: string; icon: LucideIcon; text: string }[] = [
  { n: "Draft", icon: Scissors, text: "Argon watches every clip and writes the edit: which seconds, in what order, with captions." },
  { n: "Render", icon: Clapperboard, text: "ffmpeg assembles the cut from that list. No model touches pixels." },
  { n: "Watch", icon: Eye, text: "Argon watches the finished video and grades it against your brief, check by check." },
  { n: "Fix", icon: Wrench, text: "What failed gets patched and rendered again, up to three takes." },
];

/** First-run hero shown instead of the gallery when there are no cuts yet. */
export function EmptyState() {
  const demo = useDemo();
  return (
    <section aria-label="Get started" className="mt-10">
      <div className="rounded-3xl border bg-card p-8 shadow-tile sm:p-12">
        <p className="text-xs font-medium tracking-wide text-amber uppercase">Your first cut</p>
        <h2 className="mt-3 max-w-[18ch] font-serif text-[clamp(34px,4.5vw,56px)] leading-[1.02] tracking-tight">
          Footage in. A cut that checked itself, out.
        </h2>
        <p className="mt-4 max-w-[58ch] text-[15px] leading-relaxed text-muted-foreground">
          Drop a few clips and write one sentence about the video you want. Argon drafts the edit, renders it, then watches
          its own render and fixes what it finds before you see it.
        </p>
        <div className="mt-7 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void demo.start()}
            disabled={demo.starting || !demo.available}
            className="inline-flex h-11 items-center gap-2 rounded-xl bg-primary px-5 text-[15px] font-medium text-primary-foreground shadow-tile hover:brightness-105 disabled:opacity-50"
          >
            {demo.starting ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
            Try the demo clips
          </button>
          <button
            type="button"
            onClick={focusNewCut}
            className="inline-flex h-11 items-center gap-2 rounded-xl border bg-card px-5 text-[15px] font-medium hover:bg-muted"
          >
            <Upload className="size-4" /> Use my own footage
          </button>
          <Link href="/how" className="text-sm text-muted-foreground hover:text-foreground">
            How it works
          </Link>
        </div>
        <p className={cn("mt-3 text-xs", demo.error ? "text-fail" : "text-muted-foreground")}>
          {demo.error ??
            (demo.info === null
              ? "The demo clips are not available on this server. Drop your own footage below."
              : demo.count > 0
                ? `Lumen launch · ${demo.count} clip${demo.count === 1 ? "" : "s"} · about two minutes to the first version`
                : "About two minutes to the first version.")}
        </p>
      </div>

      <ol className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {LOOP.map((s, k) => (
          <li key={s.n} className="rounded-2xl border bg-card p-5 shadow-tile">
            <div className="flex items-center gap-3">
              <span className="grid size-9 place-items-center rounded-xl bg-accent text-accent-foreground">
                <s.icon className="size-4" />
              </span>
              <span className="font-tc text-xs text-muted-foreground">0{k + 1}</span>
              <span className="font-medium">{s.n}</span>
            </div>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{s.text}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
