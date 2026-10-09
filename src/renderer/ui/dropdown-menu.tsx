"use client";

import * as React from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Icon } from "./icons.tsx";

import { cn } from "./cn.ts";

function DropdownMenu({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) {
  return <DropdownMenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}

function DropdownMenuTrigger({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>) {
  return <DropdownMenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}

function DropdownMenuPortal({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Portal>) {
  return <DropdownMenuPrimitive.Portal data-slot="dropdown-menu-portal" {...props} />;
}

/**
 * ONE HIGHLIGHT THAT GLIDES from row to row, instead of every row toggling its
 * own background, in every dropdown. It is the same gesture as the header's
 * segmented control and the nav's sliding pill, and it belongs to the PRIMITIVE
 * so no menu has to opt in.
 *
 * It reads Radix's own `data-highlighted`, which is set for the pointer AND the
 * keyboard, so arrow keys glide it too and no row needs a single prop. A
 * MutationObserver rather than per-item handlers for the same reason: the rows
 * are the caller's children and this file never sees them.
 *
 * The box is KEPT when nothing is highlighted (only the opacity drops), so
 * leaving the menu and coming back glides from where it was rather than
 * snapping. At `null` it is a zero-height sliver at the top, invisible, which is
 * why the first hover grows into place instead of sliding in from off-screen.
 */
function useGlidingHighlight() {
  // The node we hold is the HIGHLIGHT ITSELF, and the menu is read as its
  // `parentElement`. Measured: a ref forwarded to
  // `DropdownMenuPrimitive.Content` was still null when this effect ran, so the
  // observer was never installed and the highlight sat at zero height forever
  // while Radix happily set `data-highlighted` on every hover. Our own element,
  // through a callback ref that re-runs the effect when the node appears, cannot
  // have that problem.
  const [node, setNode] = React.useState<HTMLSpanElement | null>(null);
  const [box, setBox] = React.useState<{ top: number; height: number } | null>(null);
  const [lit, setLit] = React.useState(false);

  React.useEffect(() => {
    const el = node?.parentElement;
    if (!el) return;
    const measure = () => {
      const row = el.querySelector<HTMLElement>("[data-highlighted]");
      if (!row) {
        setLit(false);
        return;
      }
      // offsetTop is measured against the content box, which is `relative`.
      setBox({ top: row.offsetTop, height: row.offsetHeight });
      setLit(true);
    };
    measure();
    const observer = new MutationObserver(measure);
    observer.observe(el, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-highlighted"],
    });
    return () => observer.disconnect();
  }, [node]);

  return { ref: setNode, box, lit };
}

function DropdownMenuContent({
  className,
  children,
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  const { ref: highlightRef, box, lit } = useGlidingHighlight();
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        data-slot="dropdown-menu-content"
        sideOffset={sideOffset}
        className={cn(
          // Grow out of the trigger: Radix exposes the trigger-aware origin;
          // durations and easing read the motion tokens in theme.css.
          // motion-reduce zeroes it.
          "origin-(--radix-dropdown-menu-content-transform-origin)",
          "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.97] data-[state=open]:duration-(--duration-fast)",
          "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-[0.99] data-[state=closed]:duration-(--duration-quick)",
          "ease-(--ease-smooth-out) motion-reduce:animate-none",
          // Portals into <body>; data-theme on <html> resolves tokens for the
          // active theme (no per-portal theme class needed).
          // `relative` is load-bearing: the gliding highlight measures its rows
          // against this box.
          // bg-popover, NOT bg-background: a menu is a floating surface and
          // owes the page a step of contrast (see the token's note in
          // globals.css). It used to be the page colour exactly.
          "relative z-[230] min-w-[10rem] overflow-hidden rounded-xl border border-border bg-popover p-1 shadow-lg",
          className,
        )}
        {...props}
      >
        {/* Behind the rows by DOM ORDER, not by z-index: every row is
            `relative`, and two positioned siblings paint in document order. */}
        <span
          ref={highlightRef}
          aria-hidden
          data-slot="dropdown-menu-highlight"
          className={cn(
            "pointer-events-none absolute inset-x-1 rounded-lg bg-control-hover",
            "transition-[top,height,opacity] duration-(--duration-fast)",
            "ease-(--ease-smooth-out) motion-reduce:transition-none",
          )}
          style={{ top: box?.top ?? 0, height: box?.height ?? 0, opacity: lit ? 1 : 0 }}
        />
        {children}
      </DropdownMenuPrimitive.Content>
    </DropdownMenuPrimitive.Portal>
  );
}

function DropdownMenuGroup({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Group>) {
  return <DropdownMenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />;
}

/** One row's look, shared by Item and RadioItem so the two cannot drift. */
const rowClass = [
  // `relative` puts the row above the gliding highlight; Geist Sans because a
  // menu is written AT a person, in the regular font. Mono stays the voice of
  // the chrome elsewhere - buttons, chips, tabs.
  "relative flex cursor-pointer select-none items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-foreground/85 outline-none",
  // No `focus:bg-*`: the highlight is one gliding element now, so a per-row
  // background would double it and kill the movement it exists for.
  "transition-colors duration-(--duration-quick) focus:text-control-text-hover",
  "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
  "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
];

function DropdownMenuItem({ className, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Item>) {
  return <DropdownMenuPrimitive.Item data-slot="dropdown-menu-item" className={cn(rowClass, className)} {...props} />;
}

function DropdownMenuRadioGroup({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.RadioGroup>) {
  return <DropdownMenuPrimitive.RadioGroup data-slot="dropdown-menu-radio-group" {...props} />;
}

/**
 * "Pick exactly one", inside a menu. Radix gives the row `role="menuitemradio"`
 * and `aria-checked`, which an ordinary Item wearing a check icon only LOOKS
 * like - and this shape is a chooser, so the semantics have to be real.
 *
 * The indicator is baked here, at the row's RIGHT end rather than as a leading
 * column: the caller (the composer's model picker) is a two-line row whose name
 * and sentence share one left edge, and a leading indicator would indent the
 * sentence under nothing. Its box is reserved whether or not the row is the
 * checked one, so choosing cannot reflow the menu.
 */
function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem>) {
  return (
    <DropdownMenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      className={cn(rowClass, className)}
      {...props}
    >
      <span className="min-w-0 flex-1">{children}</span>
      <span className="flex size-4 shrink-0 items-center justify-center text-foreground">
        <DropdownMenuPrimitive.ItemIndicator>
          <Icon name="check" size={14} />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
    </DropdownMenuPrimitive.RadioItem>
  );
}

function DropdownMenuLabel({ className, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Label>) {
  return (
    <DropdownMenuPrimitive.Label
      data-slot="dropdown-menu-label"
      className={cn("px-2.5 py-1.5 text-xs text-muted-foreground", className)}
      {...props}
    />
  );
}

function DropdownMenuSeparator({ className, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn("-mx-1 my-1 h-px bg-foreground/[0.08]", className)}
      {...props}
    />
  );
}

export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
};
