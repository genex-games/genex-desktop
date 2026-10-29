"use client";

/**
 * An ANCHORED floating surface — a panel that hangs off the control that opened
 * it, leaving the page lit and usable behind it.
 *
 * WHY THIS EXISTS RATHER THAN `dropdown-menu.tsx`. That primitive is a Radix
 * *menu*: it owns roving focus and typeahead, and it announces itself to a
 * screen reader as a list of commands. That is right for a kebab and wrong for a
 * scrollable panel of links carrying its own buttons — arrow keys would fight the
 * scroll, and typeahead would swallow letters. A popover is the honest shape for
 * "a surface, positioned near a trigger".
 *
 * Built on `@base-ui/react`, which `dom/ui/combobox.tsx` already uses and which
 * this file follows exactly: Portal -> Positioner (placement, `z-[230]`) -> Popup
 * (the surface). No second floating token is minted — `bg-popover` is THE
 * floating surface in this design system, shared with dialogs and menus.
 */
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { cn } from "./cn.ts";

function Popover(props: PopoverPrimitive.Root.Props) {
  return <PopoverPrimitive.Root {...props} />;
}

function PopoverTrigger({ ...props }: PopoverPrimitive.Trigger.Props) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

function PopoverContent({
  className,
  side = "bottom",
  sideOffset = 8,
  align = "end",
  alignOffset = 0,
  anchor,
  collisionBoundary,
  collisionAvoidance,
  surface = "popover",
  ...props
}: PopoverPrimitive.Popup.Props &
  Pick<
    PopoverPrimitive.Positioner.Props,
    "side" | "align" | "sideOffset" | "alignOffset" | "anchor" | "collisionBoundary" | "collisionAvoidance"
  > & {
    /**
     * The material. `popover` is THE floating surface and the default — nothing
     * mints a second one. `none` drops the fill and the edge so a
     * caller can wear a NAMED material instead (today: the mention picker in
     * `surface-glass`, the composer's own glass, because that panel is the bar's
     * drawer rather than a menu near it).
     *
     * A PROP RATHER THAN OVERRIDING CLASSES, because `surface-glass` is a
     * Tailwind `@utility` and `bg-popover` is a utility too: tailwind-merge
     * cannot know they collide, so both would survive into the DOM and which
     * one painted would be decided by stylesheet order — invisible here and
     * different after a production build. Not rendering the fill is the only
     * way to be sure it is not there.
     */
    surface?: "popover" | "none";
  }) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        anchor={anchor}
        {...(collisionBoundary ? { collisionBoundary } : {})}
        {...(collisionAvoidance ? { collisionAvoidance } : {})}
        // `isolate` + z-[230] is the combobox's own stacking, and z-[230] is the tier
        // dialogs, menus and tooltips already share.
        className="isolate z-[230]"
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cn(
            "text-popover-foreground rounded-xl shadow-lg",
            // One edge, every menu's (`--menu-edge`): a ring beside it would draw a second line.
            surface === "popover" && "bg-popover border border-menu-edge",
            "origin-(--transform-origin) max-w-(--available-width)",
            // Motion tokens only — open on --duration-fast, close quicker on
            // --duration-quick, the pairing every overlay here uses.
            "data-open:animate-in data-closed:animate-out data-open:fade-in-0 data-closed:fade-out-0",
            "data-open:zoom-in-[0.97] data-closed:zoom-out-[0.99]",
            "data-open:duration-(--duration-fast) data-closed:duration-(--duration-quick)",
            "ease-(--ease-smooth-out) motion-reduce:animate-none",
            className,
          )}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

export { Popover, PopoverTrigger, PopoverContent };
