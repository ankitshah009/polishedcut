"use client";

import { BadgeDollarSign, BookOpen, Clapperboard, Home, Plus, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSyncExternalStore } from "react";

import { cn } from "@/lib/utils";

import { Wordmark } from "./Wordmark";

type NavItem = { label: string; href: string; icon: LucideIcon; match: (pathname: string, hash: string) => boolean };

const NAV: NavItem[] = [
  { label: "Home", href: "/", icon: Home, match: (p, h) => p === "/" && (h === "" || h === "#") },
  { label: "New cut", href: "/#new", icon: Plus, match: (p, h) => p === "/" && h === "#new" },
  { label: "Past cuts", href: "/#past", icon: Clapperboard, match: (p, h) => p === "/" && h === "#past" },
  { label: "How it works", href: "/how", icon: BookOpen, match: (p) => p.startsWith("/how") },
  { label: "Pricing", href: "/pricing", icon: BadgeDollarSign, match: (p) => p.startsWith("/pricing") },
];

function subscribeHash(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

/** The current location hash, "" on the server and until the page hydrates. */
function useHash(): string {
  return useSyncExternalStore(
    subscribeHash,
    () => window.location.hash,
    () => "",
  );
}

export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const hash = useHash();
  return (
    <nav aria-label="Main" className="flex flex-col gap-0.5">
      {NAV.map(({ label, href, icon: Icon, match }) => {
        const active = match(pathname, hash);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            onClick={onNavigate}
            className={cn(
              "flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-sidebar-foreground transition-colors hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground",
              active && "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
            )}
          >
            <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

/** Sidebar body shared by the desktop rail and the mobile drawer. */
export function SidebarBody({ showHeader = true, onNavigate }: { showHeader?: boolean; onNavigate?: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col p-4">
      {showHeader && (
        <div className="px-2 pt-3 pb-5">
          <Wordmark />
        </div>
      )}
      <SidebarNav onNavigate={onNavigate} />
      <div className="mt-auto rounded-xl border bg-card p-3.5 shadow-tile">
        <p className="text-sm font-medium">Gemini 4 Argon</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Argon watches every render and fixes what it finds.
        </p>
      </div>
    </div>
  );
}
