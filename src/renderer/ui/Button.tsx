import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "./cn.ts";
import { accentChipClass } from "./accent-chip.tsx";

/**
 * RULES (AG-893): the PRIMITIVE owns the family. A button label is Geist Mono -
 * that is the product's voice - and baking it here is what makes that true of
 * every button instead of the 35 call sites out of 165 that happened to tag it
 * by hand. `font-mono` carries the house -0.02em from globals.css, so a button
 * never needs its own `tracking-*` either.
 *
 * IT ALSO OWNS THE SIZE. A default PARAMETER in the component signature
 * (`size = "default"`) would win over `defaultVariants`: cva only falls back
 * to its own default when the prop is `undefined`, so every call site that
 * passes no size would silently get the 36px one. The rule is therefore structural: `size` and
 * `variant` take their defaults from `defaultVariants` BELOW and must never
 * carry a default in the parameter list. `data-size` restates the resolved
 * value for the drift gate, which is the only reason it needs the `??`.
 */
const buttonVariants = cva(
  "inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-(--radius-button) font-mono text-sm font-normal transition-[background-color,color,filter,box-shadow,transform] duration-(--duration-quick) motion-reduce:transition-none enabled:active:scale-[0.96] disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none",
  {
    variants: {
      variant: {
        // Solid fills choose their own readable label for both light and dark themes.
        default: "theme-primary",
        destructive: "theme-destructive",
        outline: "border-0 bg-field shadow-none hover:bg-control-hover hover:text-control-text-hover",
        // Quiet actions use a rounded fill; labels and icons identify the hit area.
        secondary:
          "control-quiet text-secondary-foreground shadow-none hover:bg-control-hover focus-visible:shadow-none",
        ghost: "hover:bg-control-hover hover:text-control-text-hover",
        link: "text-accent-ink underline-offset-4 hover:underline",
        // An affirmative fill shares the same contrast-aware accent.
        "accent-soft": "theme-primary",
        // Retain the legacy variant name with the shared borderless accent fill.
        "accent-outline": "border-0 bg-accent-primary/12 text-accent-ink hover:bg-accent-primary/20",
        // THE INVITE PILL'S DRESS as a variant (owner round 29: "the same style
        // as the invite friend button ... we'll name this style something we'll
        // see everywhere"). One definition — `accentChipClass()` — worn by the
        // header pill, the Discord FAB, the friends-modal CTA and now by any
        // Button that asks for it. Softer than `default`: it invites without
        // claiming the page's one primary action.
        "accent-tint": accentChipClass(),
        // The prompt bar's model pill: the quiet fill of an action that is available but not due.
        pill: "pill-quiet shadow-none",
      },
      size: {
        // `sm` is the DEFAULT size of this product (AG-893). It reads tighter
        // and more finished than the 36px one, and a button only steps up when
        // a surface genuinely needs the weight.
        //
        // The `max-h-[30px]` that used to ride here is GONE, and it had to go
        // before sm could be the default: it silently clamped any taller height
        // set beside it, so every touch-target button written as
        // `size="sm" h-11` was really 30px tall. `h-8` already sets the height;
        // a max-height on top of it could only ever fight a call site.
        // px-3.5 (owner round 11: "+2 pixels of padding on the left and
        // right"), and an icon-carrying button keeps the SAME padding instead
        // of the port's tighter one — the tight step is what crowded the
        // rocket against the pill's edge and read as a bigger button.
        sm: "h-8 gap-1.5 px-3.5 has-[>svg]:px-3",
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        lg: "h-10 px-6 has-[>svg]:px-4",
        // Icon-only buttons follow the same rule: small unless asked otherwise.
        icon: "size-8",
        "icon-sm": "size-8",
        "icon-md": "size-9",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "secondary",
      size: "sm",
    },
  },
);

/** The spinner a busy button leads with: current colour, still under reduced motion. */
function ButtonSpinner() {
  return (
    <span
      aria-hidden
      data-button-spinner
      className="size-3.5 shrink-0 animate-spin rounded-full border-[1.5px] border-current border-t-transparent motion-reduce:animate-none"
    />
  );
}

/**
 * `busy`: the press is being carried out. The button keeps its fill and size (a working button
 * never looks unavailable), leads with a spinner, says so to assistive tech and takes no second
 * press; the caller swaps its label to the verb in progress ("Publishing…").
 */
function Button({
  className,
  variant,
  size,
  asChild = false,
  busy = false,
  children,
  onClick,
  "aria-disabled": ariaDisabled,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
    busy?: boolean;
  }) {
  const Comp = asChild ? Slot : "button";
  const working = busy && !asChild;

  return (
    <Comp
      data-slot="button"
      data-variant={variant ?? "secondary"}
      data-size={size ?? "sm"}
      type="button"
      className={cn(
        buttonVariants({ variant, size, className }),
        working && "cursor-progress enabled:active:scale-100",
      )}
      aria-busy={working || undefined}
      aria-disabled={working || ariaDisabled}
      onClick={working ? undefined : onClick}
      {...props}
    >
      {working && <ButtonSpinner />}
      {children}
    </Comp>
  );
}

export { Button, buttonVariants };
