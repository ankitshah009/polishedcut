import type { Metadata } from "next";

import { Pricing } from "@/components/pricing/Pricing";

export const metadata: Metadata = {
  title: "Pricing · PolishedCut",
  description: "Plans for PolishedCut, and an honest look at what every self-correcting cut costs in model time.",
};

export default function PricingPage() {
  return <Pricing />;
}
