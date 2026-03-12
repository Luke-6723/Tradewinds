"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cn } from "@/lib/utils";
import type React from "react";

export function Card({ className, render, ...props }: useRender.ComponentProps<"div">): React.ReactElement {
  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(
      { className: cn("relative flex flex-col rounded-2xl border bg-card not-dark:bg-clip-padding text-card-foreground shadow-xs/5", className) },
      props,
    ),
    render,
  });
}

export function CardHeader({ className, render, ...props }: useRender.ComponentProps<"div">): React.ReactElement {
  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(
      { className: cn("grid auto-rows-min grid-rows-[auto_auto] items-start gap-1.5 p-6 has-data-[slot=card-action]:grid-cols-[1fr_auto]", className) },
      props,
    ),
    render,
  });
}

export function CardTitle({ className, render, ...props }: useRender.ComponentProps<"div">): React.ReactElement {
  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(
      { className: cn("font-semibold text-lg leading-none", className) },
      props,
    ),
    render,
  });
}

export function CardDescription({ className, render, ...props }: useRender.ComponentProps<"div">): React.ReactElement {
  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(
      { className: cn("text-muted-foreground text-sm", className) },
      props,
    ),
    render,
  });
}

export function CardAction({ className, render, ...props }: useRender.ComponentProps<"div">): React.ReactElement {
  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(
      { className: cn("col-start-2 row-span-2 row-start-1 inline-flex self-start justify-self-end", className) },
      props,
    ),
    render,
  });
}

export function CardPanel({ className, render, ...props }: useRender.ComponentProps<"div">): React.ReactElement {
  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(
      { className: cn("flex-1 p-6 in-[[data-slot=card]:has(>[data-slot=card-header])]:pt-0", className) },
      props,
    ),
    render,
  });
}

export function CardFooter({ className, render, ...props }: useRender.ComponentProps<"div">): React.ReactElement {
  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(
      { className: cn("flex items-center p-6 in-[[data-slot=card]:has(>[data-slot=card-panel])]:pt-4", className) },
      props,
    ),
    render,
  });
}

export { CardPanel as CardContent };

