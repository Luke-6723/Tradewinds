"use client";

import { Select as SelectPrimitive } from "@base-ui/react/select";
import { cn } from "@/lib/utils";
import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import type React from "react";

// biome-ignore lint/suspicious/noExplicitAny: generic passthrough for value type
export function Select(props: any): React.ReactElement {
  return <SelectPrimitive.Root {...props} />;
}

export function SelectValue(props: React.ComponentProps<typeof SelectPrimitive.Value>): React.ReactElement {
  return <SelectPrimitive.Value {...props} />;
}

export function SelectTrigger({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Trigger>): React.ReactElement {
  return (
    <SelectPrimitive.Trigger
      className={cn(
        "relative flex h-9 w-full cursor-pointer items-center justify-between gap-2 rounded-lg border border-input bg-background not-dark:bg-clip-padding px-[calc(--spacing(3)-1px)] text-base text-foreground shadow-xs/5 ring-ring/24 transition-shadow hover:bg-accent/50 focus-visible:border-ring focus-visible:ring-[3px] data-open:border-ring data-open:ring-[3px] has-disabled:opacity-64 sm:h-8 sm:text-sm",
        className,
      )}
      {...props}
    >
      {children}
      <ChevronDownIcon className="ml-auto size-4 text-muted-foreground" />
    </SelectPrimitive.Trigger>
  );
}

export function SelectScrollUpButton({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.ScrollUpArrow>): React.ReactElement {
  return (
    <SelectPrimitive.ScrollUpArrow
      className={cn("flex items-center justify-center py-1", className)}
      {...props}
    >
      <ChevronUpIcon className="size-4 text-muted-foreground" />
    </SelectPrimitive.ScrollUpArrow>
  );
}

export function SelectScrollDownButton({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.ScrollDownArrow>): React.ReactElement {
  return (
    <SelectPrimitive.ScrollDownArrow
      className={cn("flex items-center justify-center py-1", className)}
      {...props}
    >
      <ChevronDownIcon className="size-4 text-muted-foreground" />
    </SelectPrimitive.ScrollDownArrow>
  );
}

export function SelectPopup({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Popup>): React.ReactElement {
  return (
    <SelectPrimitive.Popup
      className={cn(
        "group relative z-50 max-h-60 min-w-(--anchor-width) overflow-hidden rounded-xl border bg-popover p-1 text-popover-foreground shadow-md outline-none data-ending-style:animate-out data-ending-style:fade-out-0 data-ending-style:zoom-out-95 data-starting-style:animate-in data-starting-style:fade-in-0 data-starting-style:zoom-in-95",
        className,
      )}
      {...props}
    />
  );
}

export function SelectItem({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Item>): React.ReactElement {
  return (
    <SelectPrimitive.Item
      className={cn(
        "relative flex w-full cursor-pointer select-none items-center rounded-lg py-1.5 pl-8 pr-2 text-base outline-none data-disabled:pointer-events-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:opacity-64 sm:text-sm",
        className,
      )}
      {...props}
    >
      <span className="absolute left-2 flex size-4 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <CheckIcon className="size-3.5" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}

export function SelectGroup(props: React.ComponentProps<typeof SelectPrimitive.Group>): React.ReactElement {
  return <SelectPrimitive.Group {...props} />;
}

export function SelectGroupLabel({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.GroupLabel>): React.ReactElement {
  return (
    <SelectPrimitive.GroupLabel
      className={cn("px-2 py-1.5 font-semibold text-xs text-muted-foreground", className)}
      {...props}
    />
  );
}

export function SelectPortal(props: React.ComponentProps<typeof SelectPrimitive.Portal>): React.ReactElement {
  return <SelectPrimitive.Portal {...props} />;
}

export function SelectPositioner({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Positioner>): React.ReactElement {
  return (
    <SelectPrimitive.Positioner
      className={cn("z-50", className)}
      {...props}
    />
  );
}

export function SelectContent({ children, className, ...props }: React.ComponentProps<typeof SelectPrimitive.Popup>): React.ReactElement {
  return (
    <SelectPortal>
      <SelectPositioner>
        <SelectPopup className={className} {...props}>
          <SelectScrollUpButton />
          <div className="overflow-y-auto">{children}</div>
          <SelectScrollDownButton />
        </SelectPopup>
      </SelectPositioner>
    </SelectPortal>
  );
}
