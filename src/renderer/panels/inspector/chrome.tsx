/**
 * The inspector's shell: the card a selected node opens into, its sections and quotes, the rows
 * that open in place and the technical-details grid. A card ends with Follow up in chat: replies go
 * through the chat's composer, so the app keeps one input.
 */
import type { JSX, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { t } from "../../../shared/i18n.ts";
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
          {t("Follow up in chat")}
        </Button>
      ) : null}
    </footer>
  );
}

/** An open card's edge and entrance: it opens in its row's place in the list. */
const CARD_STYLE = {
  boxShadow: "0 0 0 1px var(--line-strong)",
  animation: "focus-in .22s var(--ease)",
};

/**
 * The card a pressed row opens into, in that row's place in the list: the list stays live around
 * it. Wide enough, what there is to look at sits on the left and what there is to read on the
 * right; otherwise they stack. ← and → walk to the rows beside it; Esc closes it.
 */
export function Panel({
  id,
  label,
  title,
  sub,
  status,
  media,
  onClose,
  reply,
  onReply,
  actions,
  children,
}: {
  id: string;
  label: string;
  title: string;
  sub?: string | null;
  status?: ReactNode;
  media?: ReactNode;
  onClose: () => void;
  reply?: Reply | null;
  onReply?: ((reply: Reply) => void) | null;
  actions?: ReactNode;
  children?: ReactNode;
}): JSX.Element {
  const card = useRef<HTMLElement>(null);
  // Keyboard users land in the card they opened; Tab walks its controls, Esc gives the list back.
  useEffect(() => {
    card.current?.focus({ preventScroll: true });
    card.current?.scrollIntoView({ block: "nearest" });
  }, []);
  const sides = media ? "@min-[760px]/card:grid-cols-[minmax(0,520px)_minmax(0,1fr)]" : "";
  return (
    <section
      ref={card}
      tabIndex={-1}
      data-graph-panel={id}
      aria-label={label}
      className="@container/card -mx-3 my-1 flex flex-col rounded-card bg-surface outline-none select-text"
      style={CARD_STYLE}
    >
      <header className="flex items-start gap-2 px-4 pt-3">
        <PanelHeading title={title} sub={sub} status={status} />
        <div className="-mt-0.5 -mr-1.5 flex shrink-0">
          <PanelButton label={t("Close (Esc)")} icon="caret-up" onClick={onClose} />
        </div>
      </header>
      {/* A card shows the build's own work: its steps, notes, files and pictures. */}
      <div data-analytics-mask className={`grid gap-x-6 gap-y-4 p-4 ${sides}`}>
        {media ? <div className="flex min-w-0 flex-col gap-4">{media}</div> : null}
        <div className="flex max-w-[720px] min-w-0 flex-col gap-4">{children}</div>
      </div>
      <CardFooter actions={actions} reply={reply} onReply={onReply} />
    </section>
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

/**
 * The disclosure rows a card holds, by their `data-panel-row` value: the smoke opens rows by it,
 * whatever language their label is in. Never rename a value.
 */
export const PanelRow = {
  TechnicalDetails: "technical-details",
  Checks: "checks",
  ReviewersNotes: "reviewers-notes",
  StudioLearned: "what-the-studio-learned",
} as const;
export type PanelRow = (typeof PanelRow)[keyof typeof PanelRow];

/** A row that opens in place — Checks, Technical details — or, with `onOpen`, opens elsewhere. */
export function Row({
  row,
  label,
  right,
  defaultOpen = false,
  onOpen,
  children,
}: {
  /** which row this is, for selectors; the label is only what it says */
  row: PanelRow;
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
        data-panel-row={row}
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
        {note.landedIn ? t("In round {round}'s brief", { round: note.landedIn }) : t("Sent")} · {formatTime(note.at)}
      </span>
    </div>
  );
}

/** The user's notes on a part or a try, when there are any. */
export function NotesSection({ notes }: { notes: NoteInfo[] }): JSX.Element | null {
  if (!notes.length) return null;
  return (
    <Section label={t("Your notes")}>
      {notes.map((note) => (
        <NoteRow key={note.id} note={note} />
      ))}
    </Section>
  );
}
