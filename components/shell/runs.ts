"use client";

// Client-side helpers for reading runs on the dashboard. No Node imports here.
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import type { Iteration, Run, RunStatus } from "@/lib/schema";

const LIVE: ReadonlySet<RunStatus> = new Set(["queued", "drafting", "rendering", "critiquing"]);

export const isLive = (run: Run): boolean => LIVE.has(run.status);

/** Finished with at least one rendered version, so there is a video to show. */
export const isFinished = (run: Run): boolean => run.status === "done" && run.iterations.length > 0;

export const lastIteration = (run: Run): Iteration | undefined => run.iterations.at(-1);

export function checksOf(run: Run): { passed: number; total: number } | null {
  const checks = lastIteration(run)?.critique?.checks;
  if (!checks || checks.length === 0) return null;
  return { passed: checks.filter((c) => c.passed).length, total: checks.length };
}

/** Short display title: the title card Argon wrote if there is one, else the first clause of the brief. */
export function runTitle(run: Run): string {
  const card = lastIteration(run)?.edl.title.trim();
  if (card) return card;
  const clause = (run.brief.split(/[.!?\n]/)[0] ?? run.brief).trim();
  if (!clause) return "Untitled cut";
  return clause.length > 60 ? `${clause.slice(0, 57).trimEnd()}…` : clause;
}

export function statusLabel(run: Run): { tone: "done" | "live" | "failed"; text: string } {
  const n = run.iterations.length;
  switch (run.status) {
    case "done":
      return { tone: "done", text: "Done" };
    case "error":
      return { tone: "failed", text: "Failed" };
    case "rendering":
      return { tone: "live", text: `Rendering v${n + 1}` };
    case "critiquing":
      return { tone: "live", text: `Reviewing v${Math.max(n, 1)}` };
    default:
      return { tone: "live", text: "Drafting" };
  }
}

export function ago(iso: string | undefined): string {
  if (!iso) return "";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!Number.isFinite(s)) return "";
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export const videoUrl = (runId: string, rel: string): string =>
  `/api/runs/${runId}/files/${rel.split("/").map(encodeURIComponent).join("/")}`;

export const spriteUrl = (runId: string, clipId: string): string => `/api/runs/${runId}/files/thumbs/${clipId}.jpg`;

/** All runs, newest first. Re-fetched on navigation and every 4 s while any run is still cutting. */
export function useRuns(): Run[] | null {
  const pathname = usePathname();
  const [runs, setRuns] = useState<Run[] | null>(null);
  const anyLive = (runs ?? []).some(isLive);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetch("/api/runs", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : []))
        .then((data: Run[]) => !cancelled && setRuns(data))
        .catch(() => !cancelled && setRuns((cur) => cur ?? []));
    load();
    const t = anyLive ? setInterval(load, 4000) : undefined;
    return () => {
      cancelled = true;
      if (t) clearInterval(t);
    };
  }, [pathname, anyLive]);

  return runs;
}
