import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode } from "react";
import { RovingAxis, rovingTarget } from "./roving-focus.ts";
import { Switch } from "./switch.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip.tsx";
import { Icon } from "./icons.tsx";

/** Composer menus share one density: 6px panel inset, 32px rows, 12px group labels.
 * Everything opens on click; nothing in a panel opens or closes on hover. */
export const pickerRow =
  "picker-row flex min-h-8 w-full items-center gap-2.5 rounded-control px-2.5 py-1.5 text-left text-chat text-ink enabled:hover:bg-control-hover disabled:opacity-45";
/** A row that holds its own controls (a switch, an action), so the row itself is not a button. */
export const pickerItem =
  "picker-item flex min-h-8 w-full items-center gap-2.5 rounded-control px-2.5 py-1.5 text-chat text-ink";

export function PickerLabel({
  children,
  first = false,
  end,
}: {
  children: ReactNode;
  first?: boolean;
  end?: ReactNode;
}) {
  return (
    <div className={`picker-label ${first ? "pt-1" : "pt-2.5"}`}>
      <span>{children}</span>
      {end !== undefined && <span className="picker-label-end">{end}</span>}
    </div>
  );
}

export function PickerSeparator() {
  return <div className="picker-sep" role="separator" />;
}

export function PickerCaption({ children }: { children: ReactNode }) {
  return <p className="picker-caption">{children}</p>;
}

/** Row switch at the row's own height; the shared Switch keeps its look and keyboard behavior. */
export function PickerSwitch({
  id,
  checked,
  onChange,
  label,
  disabled,
  describedBy,
}: {
  id?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
  /** The id of words that say more about the switch, such as where it applies. */
  describedBy?: string;
}) {
  return (
    <Switch
      id={id}
      checked={checked}
      onCheckedChange={onChange}
      disabled={disabled}
      aria-label={label}
      aria-describedby={describedBy}
      className="my-0 mr-0"
    />
  );
}

/** A filled pill: a picked value that opens something on click. › drills in, ⌄ expands in place. */
export function PickerPill({
  children,
  label,
  open,
  expands = false,
  focusKey,
  onClick,
}: {
  children: ReactNode;
  label: string;
  open?: boolean;
  expands?: boolean;
  focusKey?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="picker-pill"
      aria-label={label}
      data-open={open || undefined}
      data-focus-key={focusKey}
      {...(expands ? { "aria-expanded": Boolean(open) } : {})}
      onClick={onClick}
    >
      <span className="min-w-0 truncate">{children}</span>
      <Icon name={expands ? "chevron-down" : "chevron-right"} size={12} />
    </button>
  );
}

/**
 * One choice among a few, with a sliding thumb. Arrow keys move the choice like any radio group;
 * a disabled choice is shown but never taken.
 */
export function PickerSegmented<T extends string | number>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Array<{ value: T; label: ReactNode; title?: string; disabled?: boolean }>;
  value: T | null | undefined;
  onChange: (value: T) => void;
}) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const index = options.findIndex((option) => option.value === value);
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = rovingTarget(event.key, Math.max(0, index), options.length, RovingAxis.Both);
    const option = target === null ? undefined : options[target];
    if (target === null || !option) return;
    // Arrows belong to this group, not to a menu's Back gesture.
    event.preventDefault();
    event.stopPropagation();
    if (option.disabled) return;
    onChange(option.value);
    buttons.current[target]?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="picker-seg"
      onKeyDown={move}
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      <span
        aria-hidden
        className="picker-seg-thumb"
        data-hidden={index < 0 || undefined}
        style={{
          width: `calc((100% - 4px) / ${options.length})`,
          transform: `translateX(${Math.max(0, index) * 100}%)`,
        }}
      />
      {options.map((option, i) => (
        <button
          key={String(option.value)}
          ref={(node) => {
            buttons.current[i] = node;
          }}
          type="button"
          role="radio"
          aria-checked={i === index}
          tabIndex={i === Math.max(0, index) ? 0 : -1}
          title={option.title}
          disabled={option.disabled}
          data-value={String(option.value)}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Heading of a drilled-in view. Back, Escape and ← all return one level. */
export function PickerHead({ title, onBack }: { title: ReactNode; onBack: () => void }) {
  return (
    <div className="picker-head">
      <button type="button" className="picker-back" aria-label="Back" data-focus-key="back" onClick={onBack}>
        <Icon name="chevron-left" />
      </button>
      <span className="min-w-0 truncate">{title}</span>
    </div>
  );
}

/** Tooltip for an icon-only composer control. It stays hidden while the control's own panel is
 * open, and does not pop up when that panel returns focus to the control. */
export function ComposerTip({
  content,
  hidden = false,
  align = "center",
  children,
}: {
  content: ReactNode;
  hidden?: boolean;
  align?: "start" | "center" | "end";
  children: ReactElement;
}) {
  const [open, setOpen] = useState(false);
  const quietUntil = useRef(0);
  useEffect(() => {
    if (hidden) setOpen(false);
    else quietUntil.current = Date.now() + 400;
  }, [hidden]);
  return (
    <Tooltip
      open={open && !hidden}
      onOpenChange={(next) => {
        if (!next || Date.now() >= quietUntil.current) setOpen(next);
      }}
    >
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="top" align={align} sideOffset={6}>
        {content}
      </TooltipContent>
    </Tooltip>
  );
}
