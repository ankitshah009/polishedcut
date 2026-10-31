"use client";

import { usePathname } from "next/navigation";

import { MobileBar } from "./shell/MobileBar";
import { SidebarBody } from "./shell/Sidebar";
import { TooltipProvider } from "./ui/tooltip";

export { Wordmark } from "./shell/Wordmark";

/**
 * Light dashboard chrome: a left nav and a scrolling main column.
 * The editor (/runs/:id) draws its own full-height dark frame and the public share page (/s/:id)
 * has no account chrome, so both are rendered bare.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const bare = pathname.startsWith("/runs/") || pathname.startsWith("/s/");

  return (
    <TooltipProvider delayDuration={250}>
      {bare ? (
        children
      ) : (
        <div className="grid h-dvh grid-cols-[minmax(0,1fr)] overflow-hidden md:grid-cols-[240px_minmax(0,1fr)]">
          <aside className="hidden min-h-0 flex-col border-r border-sidebar-border bg-sidebar md:flex">
            <SidebarBody />
          </aside>
          <main className="flex min-h-0 min-w-0 flex-col overflow-x-hidden">
            <MobileBar />
            {children}
          </main>
        </div>
      )}
    </TooltipProvider>
  );
}
