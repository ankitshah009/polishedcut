"use client";

import { Menu, X } from "lucide-react";
import { usePathname } from "next/navigation";
import { Dialog } from "radix-ui";
import { useState } from "react";

import { SidebarBody } from "./Sidebar";
import { Wordmark } from "./Wordmark";

/** Below md: top bar with a menu button that opens the nav as a slide-in drawer. */
export function MobileBar() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [openedAt, setOpenedAt] = useState(pathname);
  // Close the drawer whenever navigation happens.
  if (open && openedAt !== pathname) {
    setOpen(false);
  }

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b bg-sidebar px-4 md:hidden">
      <Wordmark className="text-xl" />
      <Dialog.Root
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          setOpenedAt(pathname);
        }}
      >
        <Dialog.Trigger
          aria-label="Open menu"
          className="grid size-9 place-items-center rounded-lg text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
        >
          <Menu className="size-5" />
        </Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-foreground/30 backdrop-blur-[2px] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
          <Dialog.Content className="fixed inset-y-0 left-0 z-50 flex w-[min(300px,86vw)] flex-col border-r border-sidebar-border bg-sidebar shadow-lift outline-none data-[state=closed]:animate-out data-[state=closed]:slide-out-to-left data-[state=open]:animate-in data-[state=open]:slide-in-from-left">
            <div className="flex h-14 shrink-0 items-center justify-between border-b px-4">
              <Dialog.Title asChild>
                <span>
                  <Wordmark className="text-xl" />
                </span>
              </Dialog.Title>
              <Dialog.Description className="sr-only">Go home, start a new cut, open past cuts, read how it works or see pricing.</Dialog.Description>
              <Dialog.Close
                aria-label="Close menu"
                className="grid size-9 place-items-center rounded-lg text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
              >
                <X className="size-5" />
              </Dialog.Close>
            </div>
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
              <SidebarBody showHeader={false} onNavigate={() => setOpen(false)} />
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </header>
  );
}
