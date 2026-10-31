"use client";

import { ArrowRight, History, Loader2, Sparkles, Upload, type LucideIcon } from "lucide-react";
import Link from "next/link";

import type { Run } from "@/lib/schema";
import { cn } from "@/lib/utils";

import { focusNewCut, useDemo } from "./demo";
import { checksOf, isFinished, runTitle } from "./runs";

const CARD =
  "group flex w-full items-center gap-4 rounded-2xl border bg-card p-5 text-left shadow-tile transition-all hover:-translate-y-0.5 hover:shadow-lift focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:hover:translate-y-0 disabled:hover:shadow-tile";

function CardBody({
  icon: Icon,
  tint,
  title,
  detail,
  detailTone = "muted",
  busy,
}: {
  icon: LucideIcon;
  tint: string;
  title: string;
  detail: string;
  detailTone?: "muted" | "fail";
  busy?: boolean;
}) {
  return (
    <>
      <span className={cn("grid size-11 shrink-0 place-items-center rounded-xl", tint)}>
        <Icon className="size-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{title}</span>
        <span className={cn("block truncate text-sm", detailTone === "fail" ? "text-fail" : "text-muted-foreground")}>
          {detail}
        </span>
      </span>
      {busy ? (
        <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
      ) : (
        <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
      )}
    </>
  );
}

/** Three ways in: your own footage, the bundled demo clips, or the last finished cut. */
export function QuickStart({ runs }: { runs: Run[] | null }) {
  const demo = useDemo();
  const last = runs?.find(isFinished);
  const lastChecks = last ? checksOf(last) : null;

  return (
    <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <button type="button" onClick={focusNewCut} className={CARD}>
        <CardBody icon={Upload} tint="bg-accent text-accent-foreground" title="New cut from footage" detail="Drop clips and write a brief" />
      </button>

      <button type="button" onClick={() => void demo.start()} disabled={demo.starting || !demo.available} className={CARD}>
        <CardBody
          icon={Sparkles}
          tint="bg-success/15 text-success"
          title="Try the demo clips"
          busy={demo.starting}
          detailTone={demo.error ? "fail" : "muted"}
          detail={
            demo.error ??
            (demo.starting
              ? "Copying clips and starting Argon"
              : demo.info === undefined
                ? "Lumen launch"
                : demo.count > 0
                  ? `Lumen launch, ${demo.count} clip${demo.count === 1 ? "" : "s"}`
                  : "No demo clips in footage/demo")
          }
        />
      </button>

      {last && (
        <Link href={`/runs/${last.id}`} className={CARD}>
          <CardBody
            icon={History}
            tint="bg-clip-1/15 text-clip-1"
            title="Open your last cut"
            detail={[runTitle(last), `v${last.iterations.length}`, lastChecks && `${lastChecks.passed}/${lastChecks.total}`]
              .filter(Boolean)
              .join(" · ")}
          />
        </Link>
      )}
    </div>
  );
}
