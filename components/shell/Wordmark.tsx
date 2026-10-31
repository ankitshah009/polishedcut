import Link from "next/link";

import { cn } from "@/lib/utils";

/** "PolishedTake" in the display face, linking home. Shared by the sidebar, the mobile bar, the editor header and the share page. */
export function Wordmark({ className, href = "/" }: { className?: string; href?: string }) {
  return (
    <Link
      href={href}
      className={cn("font-serif text-[22px] leading-none tracking-tight whitespace-nowrap text-foreground", className)}
      aria-label="PolishedTake home"
    >
      Polished<span className="text-amber">Take</span>
    </Link>
  );
}
