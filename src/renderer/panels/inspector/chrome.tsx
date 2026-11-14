/**
 * The inspector's shell: the card a selected node opens into (under its row's header in Builds), its
 * sections and quotes. A card ends with Follow up in chat: replies go through the chat's composer,
 * so the app keeps one input.
 */
import type { JSX, ReactNode } from "react";
import { createContext, useContext, useEffect, useRef } from "react";
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
  inset,
}: {
  actions?: ReactNode;
  reply?: Reply | null;
  onReply?: ((reply: Reply) => void) | null;
  /** the card's side padding */
  inset: string;
}): JSX.Element | null {
  const canReply = Boolean(reply && onReply);
  if (!actions && !canReply) return null;
  return (
    <footer className={`flex shrink-0 flex-wrap items-center gap-2 border-t border-line py-3 ${inset}`}>
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

/** The soft line around an open card, or around an open row with its card: it does not take up room. */
export const OPEN_EDGE = "0 0 0 1px var(--line-soft)";

/**
 * True inside a row of the Builds list that is open: the row's own header (its mark, name and how
 * it stands) heads the card, which draws only its body under it (BuildsList.tsx).
 */
export const UnderRowHeader = createContext(false);

/** A card's side padding under its row's header: its text starts where the row's name does. */
const UNDER_ROW_INSET = "pl-10 pr-3";
/** A card's side padding on its own. */
const OWN_INSET = "px-4";

/** How a card under its row's header says how it stands: the status and the line its own heading would carry. */
function UnderRowLine({ sub, status }: { sub?: string | null; status?: ReactNode }): JSX.Element | null {
  if (!sub && !status) return null;
  return (
    <div className={`flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 ${UNDER_ROW_INSET}`}>
      {status}
      {sub ? (
        <p className="line-clamp-2 text-body-sm text-ink-3" title={sub}>
          {sub}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The card a pressed row opens into. In the list it opens in place under the row's own header,
 * which stays where it was, and pushes the rows below it down; with no row above it (Your build)
 * it carries its own heading. Wide enough, what there is to look at sits on the left and what there
 * is to read on the right; otherwise they stack. ← and → walk to the rows beside it; Esc closes it.
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
  const underRow = useContext(UnderRowHeader);
  // Keyboard users land in the card they opened; Tab walks its controls, Esc gives the list back.
  // The list does not move for it: the card opens where it is.
  // Once per card: showing the Builds tab again (a kept, hidden panel) leaves the focus where it is.
  const focused = useRef(false);
  useEffect(() => {
    if (focused.current) return;
    focused.current = true;
    card.current?.focus({ preventScroll: true });
  }, []);
  const sides = media ? "@min-[760px]/card:grid-cols-[minmax(0,520px)_minmax(0,1fr)]" : "";
  const inset = underRow ? UNDER_ROW_INSET : OWN_INSET;
  return (
    <section
      ref={card}
      tabIndex={-1}
      data-graph-panel={id}
      aria-label={label}
      className={`@container/card flex flex-col outline-none select-text ${underRow ? "-mx-3 w-[calc(100%+24px)]" : "-mx-3 my-1 rounded-card bg-surface"}`}
      style={underRow ? undefined : { boxShadow: OPEN_EDGE }}
    >
      {underRow ? (
        <UnderRowLine sub={sub} status={status} />
      ) : (
        <header className="flex items-start gap-2 px-4 pt-3">
          <PanelHeading title={title} sub={sub} status={status} />
          <div className="-mt-0.5 -mr-1.5 flex shrink-0">
            <PanelButton label={t("Close (Esc)")} icon="caret-up" onClick={onClose} />
          </div>
        </header>
      )}
      {/* A card shows the build's own work: its steps, notes, files and pictures. */}
      <div data-analytics-mask className={`grid gap-x-6 gap-y-4 pb-4 ${underRow ? "pt-3" : "pt-4"} ${inset} ${sides}`}>
        {media ? <div className="flex min-w-0 flex-col gap-4">{media}</div> : null}
        <div className="flex max-w-[720px] min-w-0 flex-col gap-4">{children}</div>
      </div>
      <CardFooter actions={actions} reply={reply} onReply={onReply} inset={inset} />
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
