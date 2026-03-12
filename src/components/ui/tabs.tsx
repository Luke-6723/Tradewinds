"use client";

import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { cn } from "@/lib/utils";
import type React from "react";

export function Tabs({ className, ...props }: TabsPrimitive.Root.Props): React.ReactElement {
  return (
    <TabsPrimitive.Root
      className={cn("flex flex-col gap-2", className)}
      data-slot="tabs"
      {...props}
    />
  );
}

export function TabsList({ className, children, ...props }: TabsPrimitive.List.Props): React.ReactElement {
  return (
    <TabsPrimitive.List
      className={cn("relative z-0 flex w-fit items-center justify-center gap-x-0.5 rounded-lg bg-muted p-0.5 text-muted-foreground/72", className)}
      data-slot="tabs-list"
      {...props}
    >
      {children}
      <TabsPrimitive.Indicator className="absolute bottom-0 left-0 h-(--active-tab-height) w-(--active-tab-width) translate-x-(--active-tab-left) -translate-y-(--active-tab-bottom) -z-1 rounded-md bg-background shadow-sm/5 transition-[width,translate] duration-200 ease-in-out dark:bg-input" />
    </TabsPrimitive.List>
  );
}

export function TabsTab({ className, ...props }: TabsPrimitive.Tab.Props): React.ReactElement {
  return (
    <TabsPrimitive.Tab
      className={cn(
        "relative flex h-9 shrink-0 grow cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-transparent px-[calc(--spacing(2.5)-1px)] font-medium text-base outline-none transition-[color,background-color] data-active:text-foreground hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring sm:h-8 sm:text-sm",
        className,
      )}
      data-slot="tabs-tab"
      {...props}
    />
  );
}

export function TabsPanel({ className, ...props }: TabsPrimitive.Panel.Props): React.ReactElement {
  return (
    <TabsPrimitive.Panel
      className={cn("flex-1 outline-none", className)}
      data-slot="tabs-content"
      {...props}
    />
  );
}

export { TabsTab as TabsTrigger, TabsPanel as TabsContent };

