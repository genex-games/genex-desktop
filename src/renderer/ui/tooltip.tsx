"use client";

import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";

import { paddingOffNativeView } from "../native-view.ts";
import { cn } from "./cn.ts";

/**
 * SMALL AND QUICK: a minimalist tooltip, around 12pt, that opens fast.
 *
 * A tooltip is the one label that is NOT part of the chat's one-size rule: it
 * is chrome about a control, not a sentence in the conversation, so it sits at
 * 12/16 while everything in the column stays at 14/20. 200ms rather than
 * Radix's 700 or our previous 500 — long enough that sweeping the pointer
 * across a toolbar does not fire it, short enough that pausing on a control
 * feels answered rather than waited out.
 */
function TooltipProvider({ delayDuration = 200, ...props }: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return <TooltipPrimitive.Provider data-slot="tooltip-provider" delayDuration={delayDuration} {...props} />;
}

/** The element a tooltip opens beside, so its content can see where that is as it opens. */
const TriggerContext = React.createContext<React.RefObject<HTMLElement | null> | null>(null);

function Tooltip({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  const trigger = React.useRef<HTMLElement | null>(null);
  return (
    <TooltipProvider>
      <TriggerContext value={trigger}>
        <TooltipPrimitive.Root data-slot="tooltip" {...props} />
      </TriggerContext>
    </TooltipProvider>
  );
}

/**
 * Opens on hover, and on focus only when that focus is shown (a keyboard's). Focus a closing
 * dialog hands back to the button that opened it, or a click leaves behind, would otherwise leave
 * the tooltip standing beside a button nobody is pointing at.
 */
function TooltipTrigger({ onFocus, ref, ...props }: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  const trigger = React.use(TriggerContext);
  const element = React.useCallback(
    (node: HTMLButtonElement | null) => {
      if (trigger) trigger.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [trigger, ref],
  );
  return (
    <TooltipPrimitive.Trigger
      ref={element}
      data-slot="tooltip-trigger"
      onFocus={(event) => {
        onFocus?.(event);
        // Radix opens on focus unless the event was prevented first.
        if (!event.currentTarget.matches(":focus-visible")) event.preventDefault();
      }}
      {...props}
    />
  );
}

/** What a tooltip's content takes: everything Radix's does but where it may go, which is decided as it opens. */
type TooltipContentProps = Omit<React.ComponentProps<typeof TooltipPrimitive.Content>, "collisionPadding">;

function TooltipContent(props: TooltipContentProps) {
  // The portal mounts what it holds as the tooltip opens, so the content reads its place then.
  return (
    <TooltipPrimitive.Portal>
      <PlacedTooltipContent {...props} />
    </TooltipPrimitive.Portal>
  );
}

/**
 * The tooltip as it opens beside its trigger. Live's game is a native view that paints over the
 * whole page, so no z-index lifts a tooltip above it: one that would reach over the game shifts or
 * turns to keep off it instead (renderer/native-view.ts).
 */
function PlacedTooltipContent({ className, sideOffset = 0, children, ...props }: TooltipContentProps) {
  const trigger = React.use(TriggerContext);
  const [collisionPadding] = React.useState(() => paddingOffNativeView(trigger?.current ?? null));
  return (
    <TooltipPrimitive.Content
      data-slot="tooltip-content"
      sideOffset={sideOffset}
      collisionPadding={collisionPadding}
      className={cn(
        "bg-foreground text-background animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-[230] w-fit origin-(--radix-tooltip-content-transform-origin) rounded-md px-2 py-1 text-xs text-balance",
        className,
      )}
      {...props}
    >
      {children}
      <TooltipPrimitive.Arrow className="bg-foreground fill-foreground z-[230] size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px]" />
    </TooltipPrimitive.Content>
  );
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
