"use client";

import { Check, Loader2, ShieldCheck } from "lucide-react";

import { estimateRemainingMs, formatEta, stageSentence, stageStates, type StageId } from "@/lib/format";
import type { Run } from "@/lib/schema";
import { cn } from "@/lib/utils";

import { spriteUrl } from "./shell/runs";

export const STAGE_NAMES: Record<StageId, string> = {
  transcribe: "Transcribe",
  analyze: "Analyze brief",
  draft: "Draft",
  generate: "Generate shots",
  art: "Title art",
  music: "Music",
  render: "Render",
  watch: "Watch & critique",
  fix: "Fix",
};

/**
 * What a cut in progress looks like: a vertical stage list driven by run.timings and run.status, an
 * honest ETA from measured stage medians, one sentence on what Argon is doing, the footage, and the
 * note that leaving the page is fine. `compact` fits the inspector column once a first version exists.
 */
export function RunProgress({ run, compact = false }: { run: Run; compact?: boolean }) {
  const stages = stageStates(run);
  const eta = formatEta(estimateRemainingMs(run));
  const sentence = stageSentence(run);
  const n = run.iterations.length;

  if (compact) {
    return (
      <div className="space-y-3 p-3">
        <div className="flex items-start justify-between gap-3 px-1">
          <p className="flex items-center gap-2 text-sm text-amber">
            <Loader2 className="size-3.5 animate-spin" /> {n > 0 ? `Working on v${n + 1}` : "Cut in progress"}
          </p>
          {eta && <p className="font-tc shrink-0 text-xs text-muted-foreground">{eta}</p>}
        </div>
        <p className="px-1 text-xs leading-relaxed text-muted-foreground" aria-live="polite">
          {sentence}
        </p>
        <StageList stages={stages} dense />
        <p className="flex items-start gap-2 px-1 text-xs leading-relaxed text-faint">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-success" />
          You can leave this page; the cut continues and resumes if the server restarts.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 lg:py-10">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="mb-3 flex items-center gap-2 text-sm text-amber">
            <Loader2 className="size-4 animate-spin" /> Cut in progress
          </p>
          <h2 className="font-serif text-4xl leading-tight tracking-tight sm:text-5xl">A good cut takes a second, polished take.</h2>
          <p className="mt-4 text-sm text-muted-foreground" aria-live="polite">
            {sentence}
          </p>
        </div>
        <div className="text-right">
          <p className="font-tc text-lg">{eta ?? "finishing up"}</p>
          <p className="mt-1 text-xs text-muted-foreground">Estimated from past cuts; yours may differ</p>
        </div>
      </div>

      <div className="grid gap-10 md:grid-cols-[1fr_1.15fr]">
        <StageList stages={stages} />
        <div>
          <h3 className="mb-4 text-sm font-medium">Your footage</h3>
          <div className="grid grid-cols-3 gap-3">
            {run.clips.map((c) => (
              <div key={c.id}>
                <div
                  role="img"
                  aria-label={c.path.split("/").pop() ?? c.id}
                  className="aspect-video w-full rounded-xl bg-track shadow-tile ring-1 ring-border"
                  style={{
                    backgroundImage: `url(${spriteUrl(run.id, c.id)})`,
                    backgroundSize: "auto 100%",
                    backgroundPosition: "left center",
                    backgroundRepeat: "no-repeat",
                  }}
                />
                <p className="font-tc mt-2 truncate text-xs text-muted-foreground" title={c.path}>
                  {c.id} · {c.duration.toFixed(1)}s{c.transcript.length ? ` · ${c.transcript.length} words` : ""}
                </p>
              </div>
            ))}
          </div>
          <div className="mt-6 flex items-start gap-3 border-t pt-5 text-xs leading-relaxed text-muted-foreground">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" />
            <p>
              You can leave this page; the cut continues and resumes if the server restarts.
              <span className="mt-2 block text-faint">Every version is saved to disk as it lands, with the critique behind it.</span>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function StageList({ stages, dense = false }: { stages: { id: StageId; state: "done" | "live" | "todo" }[]; dense?: boolean }) {
  return (
    <ol aria-label="Progress">
      {stages.map((s, i) => (
        <li key={s.id} className={cn("relative flex gap-3", dense ? "pb-2.5 last:pb-0" : "gap-4 pb-5 last:pb-0")}>
          {i < stages.length - 1 && (
            <span className={cn("absolute w-px", dense ? "top-6 left-3 h-4" : "top-8 left-4 h-7", s.state === "done" ? "bg-success/40" : "bg-border")} />
          )}
          <span
            className={cn(
              "grid shrink-0 place-items-center rounded-full border",
              dense ? "size-6" : "size-8",
              s.state === "done" && "border-success/30 bg-success/10 text-success",
              s.state === "live" && "border-amber bg-amber/10 text-amber",
              s.state === "todo" && "text-muted-foreground",
            )}
          >
            {s.state === "done" ? (
              <Check className={dense ? "size-3" : "size-4"} />
            ) : s.state === "live" ? (
              <Loader2 className={cn("animate-spin", dense ? "size-3" : "size-4")} />
            ) : (
              <span className={cn("font-tc", dense ? "text-[10px]" : "text-xs")}>{i + 1}</span>
            )}
          </span>
          <div className="flex min-w-0 flex-1 items-center justify-between gap-2">
            <span className={cn("text-sm", s.state === "live" && "font-medium text-amber", s.state === "todo" && "text-muted-foreground")}>{STAGE_NAMES[s.id]}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{s.state === "done" ? "Complete" : s.state === "live" ? "In progress" : "Up next"}</span>
          </div>
        </li>
      ))}
    </ol>
  );
}
