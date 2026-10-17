/**
 * The inspector's shell: the card a selected node opens into, its sections and quotes, the rows
 * that open in place and the technical-details grid. A card ends with Follow up in chat: replies go
 * through the chat's composer, so the app keeps one input.
 */
import type { JSX, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import type { NoteInfo } from "../../run-graph.ts";
import { Button } from "../../ui/Button.tsx";
import { Icon, type IconName } from "../../ui/icons.tsx";
import { formatTime } from "./format.ts";
import type { Reply } from "./types.ts";

/** The entrance every overlay of the Builds tab shares. */
export const FADE_UP = "fade-up .18s cubic-bezier(0.16, 1, 0.3, 1)";

/** A square glyph button of the panel's header and the lightbox. */
export function PanelButton({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon: IconName;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="inline-flex size-7 cursor-pointer items-center justify-center rounded-[8px] text-ink-3 hover:bg-control-hover hover:text-control-text-hover focus-visible:outline-2 focus-visible:outline-accent"
    >
      <Icon name={icon} size={15} />
    </button>
  );
}

/** The card's heading: its title with its one status beside it, and a line under them. */
function PanelHeading({ title, sub, status }: { title: string; sub?: string | null; status?: ReactNode }): JSX.Element {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="text-name font-semibold text-ink [overflow-wrap:anywhere]">{title}</h2>
        {status}
      </div>
      {sub ? (
        <p className="line-clamp-2 text-body-sm text-ink-3" title={sub}>
          {sub}
        </p>
      ) : null}
    </div>
  );
}

/** The card's own actions, then Follow up in chat when there is a chat to reply in. */
function CardFooter({
  actions,
  reply,
  onReply,
}: {
  actions?: ReactNode;
  reply?: Reply | null;
  onReply?: ((reply: Reply) => void) | null;
}): JSX.Element | null {
  const canReply = Boolean(reply && onReply);
  if (!actions && !canReply) return null;
  return (
    <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-line px-4 py-3">
      {actions}
      {reply && onReply ? (
        <Button onClick={() => onReply(reply)}>
          <Icon name="chat" size={14} />
          Follow up in chat
        </Button>
      ) : null}
    </footer>
  );
}

const SIDE_BUTTON =
  "pointer-events-auto absolute top-1/2 hidden size-10 -translate-y-1/2 cursor-pointer place-items-center rounded-full bg-surface text-ink-2 shadow-card hover:bg-control-hover hover:text-control-text-hover focus-visible:outline-2 focus-visible:outline-accent @2xl/stage:grid";

/** Previous and next beside the card, on a stage wide enough to have room for them. */
function SideNav({ onPrev, onNext }: { onPrev: () => void; onNext: () => void }): JSX.Element {
  return (
    <>
      <button
        type="button"
        aria-label="Previous (←)"
        title="Previous (←)"
        className={`${SIDE_BUTTON} left-4`}
        onClick={onPrev}
      >
        <Icon name="chevron-left" size={18} />
      </button>
      <button
        type="button"
        aria-label="Next (→)"
        title="Next (→)"
        className={`${SIDE_BUTTON} right-4`}
        onClick={onNext}
      >
        <Icon name="chevron-right" size={18} />
      </button>
    </>
  );
}

/** The ring and the entrance of an open card: it opens in place, over the canvas. */
const CARD_STYLE = {
  boxShadow: "0 0 0 1.5px var(--accent), 0 0 0 6px var(--accent-tint), var(--shadow-overlay)",
  animation: "focus-in .22s var(--ease)",
};

/**
 * A card whose own status carries the colour (the finish check's) wears a neutral edge instead of
 * the accent ring, so a Not yet, Done or Stopped check never reads blue.
 */
const NEUTRAL_CARD_STYLE = { ...CARD_STYLE, boxShadow: "0 0 0 1px var(--line), var(--shadow-overlay)" };

/**
 * The card a selected node opens into. It sits over the canvas, centred where the camera
 * put the node; the graph stays visible and live around it. Previous and next walk the graph
 * beside the card (inside it when the stage is narrow); ← and → do the same.
 */
export function Panel({
  id,
  label,
  title,
  sub,
  status,
  media,
  nav = true,
  onPrev,
  onNext,
  onClose,
  reply,
  onReply,
  actions,
  neutralEdge = false,
  children,
}: {
  id: string;
  label: string;
  title: string;
  sub?: string | null;
  status?: ReactNode;
  media?: ReactNode;
  nav?: boolean;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
  reply?: Reply | null;
  onReply?: ((reply: Reply) => void) | null;
  actions?: ReactNode;
  /** A neutral edge for the open card instead of the accent ring: only the finish check's card. */
  neutralEdge?: boolean;
  children?: ReactNode;
}): JSX.Element {
  const card = useRef<HTMLElement>(null);
  // Keyboard users land in the card they opened; Tab walks its controls, Esc gives the graph back.
  useEffect(() => {
    card.current?.focus({ preventScroll: true });
  }, []);
  return (
    <div className="pointer-events-none absolute inset-0 z-[4] flex items-center justify-center px-3 pt-4 pb-14 @2xl/stage:px-[72px]">
      <section
        ref={card}
        tabIndex={-1}
        role="dialog"
        data-graph-panel={id}
        aria-label={label}
        className="pointer-events-auto flex max-h-full w-full max-w-[560px] flex-col overflow-hidden rounded-[18px] bg-surface outline-none select-text"
        style={neutralEdge ? NEUTRAL_CARD_STYLE : CARD_STYLE}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          <header className="flex items-start gap-2">
            <PanelHeading title={title} sub={sub} status={status} />
            <div className="-mt-1 -mr-1.5 flex shrink-0 gap-0.5">
              {nav ? (
                <span className="contents @2xl/stage:hidden">
                  <PanelButton label="Previous (←)" icon="chevron-left" onClick={onPrev} />
                  <PanelButton label="Next (→)" icon="chevron-right" onClick={onNext} />
                </span>
              ) : null}
              <PanelButton label="Close (Esc)" icon="close" onClick={onClose} />
            </div>
          </header>
          {media}
          {children}
        </div>
        <CardFooter actions={actions} reply={reply} onReply={onReply} />
      </section>
      {nav ? <SideNav onPrev={onPrev} onNext={onNext} /> : null}
    </div>
  );
}

/** A labelled group of the panel's body. */
export function Section({
  label,
  children,
  gap = "gap-1.5",
}: {
  label: string;
  children: ReactNode;
  gap?: string;
}): JSX.Element {
  return (
    <section className={`flex flex-col ${gap}`}>
      <h3 className="text-body-sm text-ink-3">{label}</h3>
      {children}
    </section>
  );
}

/** A paragraph of the panel, or a quieter one. */
export function Para({ children, quiet = false }: { children: ReactNode; quiet?: boolean }): JSX.Element {
  return (
    <p className={`[overflow-wrap:anywhere] ${quiet ? "text-body-sm text-ink-3" : "text-chat-sub text-ink-2"}`}>
      {children}
    </p>
  );
}

/** Someone's own words, with who said them. */
export function Quote({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <figure className="flex flex-col gap-1 rounded-[10px] bg-inset px-3 py-2.5">
      <figcaption className="text-xs text-ink-3">{label}</figcaption>
      <blockquote className="text-body-sm text-ink-2 [overflow-wrap:anywhere]">{children}</blockquote>
    </figure>
  );
}

/** A row that opens in place — Checks, Technical details — or, with `onOpen`, opens elsewhere. */
export function Row({
  label,
  right,
  defaultOpen = false,
  onOpen,
  children,
}: {
  label: string;
  right?: string | null;
  /** The row opens already open: the card was opened to show what it holds. */
  defaultOpen?: boolean;
  onOpen?: () => void;
  children?: ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="flex flex-col border-t border-line first:border-t-0">
      <button
        type="button"
        data-panel-row={label.toLowerCase().replace(/[^a-z]+/g, "-")}
        aria-expanded={onOpen ? undefined : open}
        onClick={() => (onOpen ? onOpen() : setOpen((value) => !value))}
        className="flex h-10 cursor-pointer items-center justify-between gap-3 text-left text-chat-sub text-ink hover:text-control-text-hover focus-visible:outline-2 focus-visible:outline-accent"
      >
        <span className="truncate">{label}</span>
        <span className="flex min-w-0 items-center gap-1.5 text-body-sm text-ink-3">
          {right ? <span className="truncate">{right}</span> : null}
          <span className="transition-transform duration-150" style={{ transform: open ? "rotate(90deg)" : undefined }}>
            <Icon name="chevron-right" size={14} />
          </span>
        </span>
      </button>
      {open && children ? <div className="pb-3">{children}</div> : null}
    </div>
  );
}

/** The column the disclosure rows stack in. */
export function Rows({ children }: { children: ReactNode }): JSX.Element {
  return <div className="flex flex-col">{children}</div>;
}

/** One technical fact: a key and its value, left out when the value is empty. */
export type DetailRow = [string, string | null | undefined];

/** The technical-details grid: key and value, empty values left out. */
export function Details({ rows }: { rows: DetailRow[] }): JSX.Element {
  return (
    <div className="grid grid-cols-[112px_minmax(0,1fr)] gap-x-2.5 gap-y-1 font-mono text-micro text-ink-2 [overflow-wrap:anywhere]">
      {rows
        .filter(([, value]) => value)
        .map(([key, value]) => (
          <span key={key} className="contents">
            <span className="text-ink-3">{key}</span>
            <span>{value}</span>
          </span>
        ))}
    </div>
  );
}

/** A note the user sent, and whether a round's brief took it in yet. */
export function NoteRow({ note }: { note: NoteInfo }): JSX.Element {
  return (
    <div className="flex flex-col gap-1 rounded-[10px] bg-inset px-3 py-2">
      <span className="text-body-sm text-ink [overflow-wrap:anywhere]">{note.text}</span>
      <span className="text-micro text-ink-3">
        {note.landedIn ? `In round ${note.landedIn}'s brief` : "Sent"} · {formatTime(note.at)}
      </span>
    </div>
  );
}

/** The user's notes on a part or a try, when there are any. */
export function NotesSection({ notes }: { notes: NoteInfo[] }): JSX.Element | null {
  if (!notes.length) return null;
  return (
    <Section label="Your notes">
      {notes.map((note) => (
        <NoteRow key={note.id} note={note} />
      ))}
    </Section>
  );
}
