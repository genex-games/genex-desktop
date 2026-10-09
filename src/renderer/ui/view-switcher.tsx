"use client";

/** Genex segmented navigation; arrow keys move and select tabs. */
import type { JSX, KeyboardEvent } from "react";
import { cn } from "./cn.ts";
import { isRovingKey, RovingAxis, rovingTarget } from "./roving-focus.ts";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip.tsx";

export interface ViewSwitcherItem<K extends string> {
  key: K;
  label: string;
  /** Optional trailing count (the friends modal's "Pending 3"); 0 renders nothing. */
  count?: number;
  /** A glyph. Rendered before the label, or INSTEAD of it under `iconOnly`. */
  icon?: React.ReactNode;
  /**
   * One explanatory sentence as the chip's hover tooltip. Text chips only —
   * `iconOnly` already owns its tooltip for the label itself, so a hint there
   * is ignored rather than fighting it. Currently unworn: the remix modal's
   * lane toggle carried the first hints, removed once the halves got icons — a
   * labelled+iconed half explains itself. The slot stays for a future half
   * that genuinely needs a sentence.
   */
  hint?: string;
}

/** A chip's look: its height and family, square when it is a glyph, and whether it is active. */
function chipClass({
  sans,
  iconOnly,
  fullWidth,
  isActive,
}: {
  sans: boolean;
  iconOnly: boolean;
  fullWidth: boolean;
  isActive: boolean;
}): string {
  return cn(
    // h-7 rather than padding: the chip's height is the control's whole
    // dimension chain, so it has to be a number and not a by-product of
    // leading.
    "flex h-7 cursor-pointer items-center gap-1.5 rounded-md text-body-sm",
    // font-geist so the family's -0.03em resolves at the chip's own 13px
    // (-0.39px) — a role may not carry it, since text-body-sm is worn by
    // both families and must stay tracking-free.
    sans ? "font-sans" : "font-mono",
    // A glyph chip is SQUARE — `px-2.5` around a 15px icon reads as a
    // wide button with something small in the middle.
    iconOnly ? "w-7 justify-center" : "px-2.5",
    fullWidth && !iconOnly && "flex-1 justify-center",
    "transition-colors duration-(--duration-quick)",
    "focus-visible:outline-none",
    // The current view is drawn as an accent button: the palette's switch fill, else its button fill, and label.
    isActive
      ? "bg-[var(--switch-fill,var(--accent-fill))] text-accent-foreground"
      : "text-control-text hover:bg-[var(--control-hover,transparent)] hover:text-control-text-hover",
  );
}

/** A glyph chip's tooltip names it; a text chip's carries its hint, when it has one. */
function withTooltip<K extends string>(chip: JSX.Element, item: ViewSwitcherItem<K>, iconOnly: boolean): JSX.Element {
  if (!iconOnly && !item.hint) return chip;
  return (
    <Tooltip key={item.key}>
      <TooltipTrigger asChild>{chip}</TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {iconOnly ? item.label : item.hint}
      </TooltipContent>
    </Tooltip>
  );
}

/** A nav chip marks the current page; a tab chip is a tab, selected or not. */
function chipRole(as: "tabs" | "nav", isActive: boolean) {
  if (as === "nav") return { "aria-current": isActive ? ("page" as const) : undefined };
  return { role: "tab", "aria-selected": isActive };
}

/** Arrow keys, Home and End move along the tabs and select the tab they land on. */
function moveTab<K extends string>(
  event: KeyboardEvent<HTMLButtonElement>,
  items: readonly ViewSwitcherItem<K>[],
  key: K,
  onSelect: (key: K) => void,
): void {
  if (!isRovingKey(event.key, RovingAxis.Horizontal)) return;
  event.preventDefault();
  const index = items.findIndex((candidate) => candidate.key === key);
  const next = rovingTarget(event.key, index, items.length, RovingAxis.Horizontal) ?? index;
  const target = items[next];
  if (target) onSelect(target.key);
  const buttons = event.currentTarget.closest('[role="tablist"]')?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
  buttons?.[next]?.focus();
}

export function ViewSwitcher<K extends string>({
  items,
  active,
  onSelect,
  label,
  as = "tabs",
  iconOnly = false,
  sans = false,
  fullWidth = false,
  className,
  dataAttribute,
}: {
  items: readonly ViewSwitcherItem<K>[];
  active: K;
  onSelect: (key: K) => void;
  /** Accessible name for the track itself. */
  label: string;
  as?: "tabs" | "nav";
  /** Glyph halves: the label becomes the accessible name and the tooltip. */
  iconOnly?: boolean;
  /** Dialog dress: the halves speak the sans instead of mono. */
  sans?: boolean;
  /** Dialog dress: the track spans its container, halves splitting it evenly. */
  fullWidth?: boolean;
  className?: string;
  dataAttribute?: `data-${string}`;
}) {
  const chips = items.map((item) => {
    const isActive = item.key === active;
    const chip = (
      <button
        key={item.key}
        type="button"
        onClick={() => onSelect(item.key)}
        {...(dataAttribute ? { [dataAttribute]: item.key, "aria-pressed": isActive } : {})}
        tabIndex={as === "tabs" && !isActive ? -1 : 0}
        onKeyDown={(event) => {
          if (as === "tabs") moveTab(event, items, item.key, onSelect);
        }}
        {...(iconOnly ? { "aria-label": item.label } : null)}
        {...chipRole(as, isActive)}
        className={chipClass({ sans, iconOnly, fullWidth, isActive })}
      >
        {item.icon}
        {iconOnly ? null : item.label}
        {item.count ? <span className="font-mono text-micro tabular-nums opacity-70">{item.count}</span> : null}
      </button>
    );
    return withTooltip(chip, item, iconOnly);
  });

  const track = cn("flex items-center gap-0.5 rounded-lg p-0.5 surface-glass", fullWidth && "w-full", className);

  return as === "nav" ? (
    <nav aria-label={label} className={track}>
      {chips}
    </nav>
  ) : (
    <div role="tablist" aria-label={label} className={track}>
      {chips}
    </div>
  );
}
