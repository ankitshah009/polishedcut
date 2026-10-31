import type { Metadata } from "next";

import { RunView } from "@/components/RunView";
import { loadRun } from "@/lib/store";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const run = await loadRun(id).catch(() => null);
  const brief = run?.brief.trim();
  return { title: brief ? `${brief.length > 60 ? `${brief.slice(0, 57)}…` : brief} · PolishedTake` : "Cut · PolishedTake" };
}

export default async function RunPage({ params }: Props) {
  const { id } = await params;
  return <RunView key={id} runId={id} />;
}
