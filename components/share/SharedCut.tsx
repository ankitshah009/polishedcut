"use client";

import { Check, Download, Film, Layers } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { Wordmark } from "@/components/shell/Wordmark";
import { CutPlayer } from "@/components/shell/CutPlayer";
import { checksOf, runTitle, spriteUrl, videoUrl } from "@/components/shell/runs";
import type { Run } from "@/lib/schema";
import { cn } from "@/lib/utils";

/** The public, read-only page for a cut: final version first, the brief, every version, downloads. */
export function SharedCut({ run }: { run: Run }) {
  const its = run.iterations;
  const [idx, setIdx] = useState(Math.max(0, its.length - 1));
  const checks = checksOf(run);
  const title = runTitle(run);
  const last = its.at(-1);

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <header className="border-b">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5">
          <Wordmark />
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            <Film className="size-3.5" /> Shared cut
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-9">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <p className="mb-2 text-xs text-muted-foreground">
              {its.length} version{its.length === 1 ? "" : "s"} · cut by Gemini 4 Argon
            </p>
            <h1 className="font-serif text-4xl leading-tight tracking-tight">{title}</h1>
          </div>
          {checks && (
            <span
              className={cn(
                "flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium",
                checks.passed === checks.total ? "bg-success/10 text-success" : "bg-fail/10 text-fail",
              )}
            >
              <Check className="size-4" />
              {checks.passed}/{checks.total} checks passed
            </span>
          )}
        </div>

        {its.length > 0 ? (
          <CutPlayer run={run} index={idx} onIndexChange={setIdx} />
        ) : (
          <div className="grid aspect-video place-items-center rounded-xl border bg-muted text-sm text-muted-foreground">
            {run.status === "error" ? "This cut stopped before a version was rendered." : "This cut is still being made. Check back in a minute."}
          </div>
        )}

        <section className="mt-8 border-t pt-6">
          <h2 className="text-sm font-medium">The brief</h2>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">{run.brief}</p>
        </section>

        {its.length > 0 && (
          <section className="mt-8">
            <h2 className="flex items-center gap-2 text-sm font-medium">
              <Layers className="size-4 text-muted-foreground" /> Version history
            </h2>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              {its.map((v, k) => {
                const c = v.critique?.checks ?? [];
                const f = c.filter((x) => !x.passed).length;
                const label = v.note ? "Director's note" : k === 0 ? "First draft" : f === 0 ? "Fixes applied, all checks pass" : `Fixes applied`;
                return (
                  <button
                    key={v.n}
                    type="button"
                    onClick={() => setIdx(k)}
                    aria-pressed={k === idx}
                    className={cn(
                      "flex gap-3 rounded-xl border bg-card p-3 text-left shadow-tile transition-colors hover:bg-muted/60",
                      k === idx && "border-amber ring-1 ring-amber/40",
                    )}
                  >
                    <span
                      className="aspect-video w-24 shrink-0 rounded-lg bg-muted"
                      style={{
                        backgroundImage: `url(${spriteUrl(run.id, run.clips[0]?.id ?? "clip1")})`,
                        backgroundSize: "auto 100%",
                        backgroundPosition: "left center",
                        backgroundRepeat: "no-repeat",
                      }}
                    />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">
                        v{v.n} · {label}
                      </span>
                      <span className={cn("mt-1 block text-xs", !v.critique ? "text-muted-foreground" : f ? "text-fail" : "text-success")}>
                        {v.critique ? `${c.length - f}/${c.length} checks` : "not yet watched"}
                      </span>
                      {v.note && <span className="mt-1 block truncate text-xs text-muted-foreground">“{v.note}”</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {last && (
          <div className="mt-8 flex flex-wrap items-center gap-3 border-t pt-6">
            <a
              href={videoUrl(run.id, last.video)}
              download={`polishedtake-${run.id}-v${last.n}.mp4`}
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground shadow-tile hover:brightness-105"
            >
              <Download className="size-4" /> Download final (v{last.n})
            </a>
            {its.length > 1 &&
              its.slice(0, -1).map((v) => (
                <a
                  key={v.n}
                  href={videoUrl(run.id, v.video)}
                  download={`polishedtake-${run.id}-v${v.n}.mp4`}
                  className="inline-flex h-9 items-center gap-2 rounded-lg border bg-card px-4 text-sm font-medium hover:bg-muted"
                >
                  <Download className="size-4" /> v{v.n}
                </a>
              ))}
            <span className="text-xs text-muted-foreground">
              MP4 · {last.edl.width}×{last.edl.height}
            </span>
          </div>
        )}
      </main>

      <footer className="mt-4 border-t py-6 text-center text-xs text-muted-foreground">
        Made with{" "}
        <Link href="/" className="font-medium text-foreground">
          PolishedTake
        </Link>
      </footer>
    </div>
  );
}
