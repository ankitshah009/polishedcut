// Adapted from shadcn/ui Skeleton (https://github.com/shadcn-ui/ui, MIT License).
import { cn } from "@/lib/utils";

export function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return <div aria-hidden className={cn("animate-pulse rounded-lg bg-muted/60", className)} {...props} />;
}
