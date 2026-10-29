import type { ComponentProps, JSX, ReactNode } from "react";
import { t } from "../../shared/i18n.ts";
import { Icon } from "../ui/icons.tsx";

const MESSAGE = { open: t("Open in Builds") } as const;

/** What opening the card does: its click, and the run it opens when it names one. */
export interface BuildCardOpen {
  onClick: () => void;
  runId?: string;
}

/** The card as a disclosure: whether what it holds (`below`) is open, the element it opens, and the turn. */
export interface BuildCardToggle {
  expanded: boolean;
  controls: string;
  onToggle: () => void;
  /** The toggle's name for a screen reader, beside its title. */
  label: string;
}

/** The disclosure's chevron, turned up while what it opens is open. */
const chevronClass = (expanded: boolean): string => (expanded ? "chat-chevron rotate-180" : "chat-chevron");

/**
 * The card's title: a button stretched over the whole card (opening Builds, or the card's own list),
 * else plain. One button either way, so a card that gains its list keeps the focus it had.
 */
function CardTitle({
  title,
  open,
  toggle,
}: {
  title: string;
  open?: BuildCardOpen;
  toggle?: BuildCardToggle;
}): JSX.Element {
  if (!toggle && !open) return <p className="m-0 truncate text-chat text-ink">{title}</p>;
  const turns = toggle
    ? {
        "aria-expanded": toggle.expanded,
        // Only an open list is there to point at.
        ...(toggle.expanded ? { "aria-controls": toggle.controls } : {}),
        "aria-label": toggle.label,
        "data-build-toggle": true,
      }
    : { title: MESSAGE.open, "data-open-build": open?.runId };
  return (
    <button
      type="button"
      {...turns}
      onClick={toggle ? toggle.onToggle : open?.onClick}
      className="build-card-open text-chat text-ink"
    >
      <span className="truncate">{title}</span>
      <Icon
        name={toggle ? "chevron-down" : "chevron-right"}
        size={12}
        strokeWidth={2}
        {...(toggle ? { className: chevronClass(toggle.expanded) } : {})}
      />
    </button>
  );
}

/**
 * The chat's one card for a build, running or finished: its picture, a title and one line, and
 * what sits on the right — and, below them, what the card opens to (`below`, a running build's
 * parts). Given `open` or `toggle`, the title is a button stretched over the whole card, so the
 * card itself opens the build on Builds, or its own list; whatever sits on the right (Play) and
 * what it opened to stay targets of their own.
 */
export function BuildCard({
  picture,
  title,
  line,
  aside,
  open,
  toggle,
  below,
  ...props
}: {
  /** the build's picture, omitted until one exists */
  picture?: ReactNode;
  title: string;
  /** the one line under the title */
  line?: ReactNode;
  /** what sits on the right: the clock, or Play */
  aside?: ReactNode;
  open?: BuildCardOpen;
  toggle?: BuildCardToggle;
  /** what the card holds under its row once opened */
  below?: ReactNode;
} & Omit<ComponentProps<"div">, "title" | "className">): JSX.Element {
  return (
    <div {...props} className="build-card flex min-w-0 flex-col rounded-card bg-composer p-2">
      <div className="flex min-w-0 items-center gap-3">
        {picture}
        <div
          className={`build-card-text flex min-h-[55px] min-w-0 flex-1 flex-col justify-center ${picture ? "" : "ps-2"}`}
        >
          <CardTitle title={title} {...(open ? { open } : {})} {...(toggle ? { toggle } : {})} />
          {line}
        </div>
        {aside}
      </div>
      {below}
    </div>
  );
}
