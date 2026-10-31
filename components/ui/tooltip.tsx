"use client";

import { Tooltip as TooltipPrimitive } from "radix-ui";
import { createContext, useContext } from "react";

import { cn } from "@/lib/utils";

export const TooltipProvider = TooltipPrimitive.Provider;

/**
 * Tooltips portal to <body>, outside any `.dark` wrapper. A themed region (the editor) sets this
 * context to "dark" so its tooltips carry the class themselves and pick up the dark tokens.
 */
export const TooltipTheme = createContext<string>("");

export function Tooltip({
  label,
  children,
  side = "top",
}: {
  label: React.ReactNode;
  children: React.ReactNode;
  side?: "top" | "bottom" | "left" | "right";
}) {
  const theme = useContext(TooltipTheme);
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className={cn(
            theme,
            "z-50 max-w-72 rounded-md border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-lift",
            "animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
          )}
        >
          {label}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
