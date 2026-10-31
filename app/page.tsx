import type { Metadata } from "next";
import { Suspense } from "react";

import { Dashboard } from "@/components/shell/Dashboard";

export const metadata: Metadata = {
  title: "PolishedTake",
  description: "Drop footage, write a one-line brief, and let Argon cut, watch and fix your video.",
};

export default function Home() {
  return (
    // The dashboard reads `?theater=` with useSearchParams, which needs a Suspense boundary to prerender.
    <Suspense fallback={<div className="flex-1" />}>
      <Dashboard />
    </Suspense>
  );
}
