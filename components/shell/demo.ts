"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

export type DemoInfo = { brief: string; clips: { name: string; size: number }[] };

/**
 * The bundled demo clips: what they are (GET /api/runs/demo) and a `start` that copies them into a
 * new run and navigates to it (POST). Shared by the quick-start card and the first-run hero.
 */
export function useDemo() {
  const router = useRouter();
  const [info, setInfo] = useState<DemoInfo | null | undefined>(undefined);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/runs/demo")
      .then((r) => (r.ok ? (r.json() as Promise<DemoInfo>) : null))
      .then((i) => !cancelled && setInfo(i))
      .catch(() => !cancelled && setInfo(null));
    return () => {
      cancelled = true;
    };
  }, []);

  const start = async () => {
    if (starting) return;
    setStarting(true);
    setError(null);
    try {
      const res = await fetch("/api/runs/demo", { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!res.ok || !body.id) throw new Error(body.error ?? `Could not start the demo (${res.status}).`);
      router.push(`/runs/${body.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the demo.");
      setStarting(false);
    }
  };

  const count = info?.clips.length ?? 0;
  return { info, count, starting, error, start, available: info !== null && (info === undefined || count > 0) };
}

/** Scrolls to the upload panel and focuses its file input. */
export function focusNewCut() {
  document.getElementById("new")?.scrollIntoView({ behavior: "smooth", block: "start" });
  document.getElementById("footage-input")?.focus({ preventScroll: true });
}
