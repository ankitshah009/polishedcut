import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { SharedCut } from "@/components/share/SharedCut";
import { loadRun } from "@/lib/store";

type Props = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const run = await loadRun(id).catch(() => null);
  if (!run) return { title: "Cut not found · PolishedCut" };
  const title = run.iterations.at(-1)?.edl.title.trim() || run.brief.split(/[.!?\n]/)[0]?.trim() || "A cut";
  return {
    title: `${title} · PolishedCut`,
    description: run.brief,
    openGraph: { title, description: run.brief, type: "video.other" },
  };
}

/** Public, read-only view of a cut. Reads the run from the store; no editing controls. */
export default async function SharePage({ params }: Props) {
  const { id } = await params;
  const run = await loadRun(id).catch(() => null);
  if (!run) notFound();
  return <SharedCut run={run} />;
}
