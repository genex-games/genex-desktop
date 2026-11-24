/**
 * The creator's saved funnels: each one its steps with the players who reached them, the share
 * that goes on and the share of the first step that reached the end. A funnel is removed after a
 * question asked in its own place, and a new one is made with the form that opens under the title.
 * A game keeps `FUNNELS_MAX`; at that number the button that makes another is gone.
 */
import type { JSX, KeyboardEvent } from "react";
import { useEffect, useId, useRef, useState } from "react";
import { type EventFunnel, type EventFunnelDraft, FUNNELS_MAX } from "../../../shared/game-analytics.ts";
import { Button } from "../../ui/Button.tsx";
import { FunnelEditor } from "./events-funnel-editor.tsx";
import type { FunnelsView, FunnelView } from "./events-view.ts";
import { EVENTS_WORDS as WORDS } from "./events-words.ts";
import { EmptyNote, formatNumber, FunnelSteps, ReportSection } from "./kit/index.ts";
import { focusAfterRemoval } from "./page-view.ts";

/** Where a funnel is on its way out. */
export const Removal = { Idle: "idle", Asking: "asking", Removing: "removing", Failed: "failed" } as const;
export type Removal = (typeof Removal)[keyof typeof Removal];

/** The question that opens in a funnel's own place, and the buttons that answer it. */
export function RemoveAsk({
  removal,
  onYes,
  onKeep,
}: {
  removal: Removal;
  onYes: () => void;
  onKeep: () => void;
}): JSX.Element {
  const keep = useRef<HTMLButtonElement>(null);
  const question = useId();
  const removing = removal === Removal.Removing;
  const keepOnEscape = (pressed: KeyboardEvent<HTMLButtonElement>): void => {
    if (pressed.key !== "Escape" || removing) return;
    pressed.stopPropagation();
    onKeep();
  };
  useEffect(() => keep.current?.focus(), []);
  return (
    <div className="game-analytics-events-ask" data-game-analytics-remove-ask>
      <span className="game-analytics-events-asktext" id={question}>
        {removal === Removal.Failed ? WORDS.funnels.removeFailed : WORDS.funnels.removeAsk}
      </span>
      <Button
        ref={keep}
        variant="secondary"
        aria-describedby={question}
        disabled={removing}
        onKeyDown={keepOnEscape}
        data-game-analytics-remove-keep
        onClick={onKeep}
      >
        {WORDS.funnels.removeKeep}
      </Button>
      <Button
        variant="destructive"
        busy={removing}
        onKeyDown={keepOnEscape}
        data-game-analytics-remove-yes
        onClick={onYes}
      >
        {removing ? WORDS.funnels.removing : WORDS.funnels.removeYes}
      </Button>
    </div>
  );
}

/** One saved funnel, with its Remove and the question it asks. */
function FunnelCard({
  funnel,
  onRemove,
}: {
  funnel: FunnelView;
  onRemove: (id: string) => Promise<void>;
}): JSX.Element {
  const heading = useId();
  const [removal, setRemoval] = useState<Removal>(Removal.Idle);
  const opener = useRef<HTMLButtonElement>(null);
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current && removal === Removal.Idle) opener.current?.focus();
    asked.current = removal !== Removal.Idle;
  }, [removal]);
  const remove = async (): Promise<void> => {
    setRemoval(Removal.Removing);
    try {
      await onRemove(funnel.id);
      // The card is gone with the answer; one that is still here (the re-read failed) can be removed again.
      setRemoval(Removal.Idle);
    } catch {
      setRemoval(Removal.Failed);
    }
  };
  return (
    <article
      className="game-analytics-events-funnel"
      data-game-analytics-funnel-card={funnel.id}
      aria-labelledby={heading}
    >
      <header className="game-analytics-events-funnelhead">
        <div className="game-analytics-events-funneltitle">
          <h3 id={heading} className="game-analytics-events-funnelname" data-analytics-mask>
            {funnel.name}
          </h3>
          <p className="game-analytics-events-note">
            <span>{funnel.within}</span>
            {funnel.outcome && <span>{funnel.outcome}</span>}
          </p>
        </div>
        {removal === Removal.Idle ? (
          <Button
            ref={opener}
            variant="secondary"
            data-game-analytics-remove-funnel={funnel.id}
            onClick={() => setRemoval(Removal.Asking)}
          >
            {WORDS.funnels.remove}
          </Button>
        ) : (
          <RemoveAsk removal={removal} onYes={remove} onKeep={() => setRemoval(Removal.Idle)} />
        )}
      </header>
      <FunnelSteps id={funnel.id} label={WORDS.funnels.stepsLabel(funnel.name)} steps={funnel.steps} mask />
    </article>
  );
}

/** What `FunnelsSection` is given. */
export interface FunnelsSectionProps {
  view: FunnelsView;
  /** The event a new funnel's first step starts on: the one in view, else the first listed. */
  firstEvent: string | null;
  onSave: (draft: EventFunnelDraft) => Promise<EventFunnel>;
  onRemove: (id: string) => Promise<void>;
}

/** A funnel's Remove inside `list`, by the funnel's id. */
const removeButton = (list: HTMLElement | null, id: string | null): HTMLElement | null =>
  id === null
    ? null
    : (list?.querySelector<HTMLElement>(`[data-game-analytics-remove-funnel="${CSS.escape(id)}"]`) ?? null);

/**
 * Where the focus goes once a removed funnel's card is gone: `next` (the neighbour's Remove), else
 * New funnel. A card still there (its re-read failed) keeps the focus on its own Remove.
 */
interface FocusAfterRemoval {
  removed: string;
  next: string | null;
}

/**
 * The saved funnels and the form that makes another. The keyboard's focus never falls to the page:
 * after a save it returns to New funnel, or, once the list is full and New funnel is gone, to the
 * new funnel's Remove; after a removal it moves to a neighbour's Remove, else New funnel.
 */
export function FunnelsSection({ view, firstEvent, onSave, onRemove }: FunnelsSectionProps): JSX.Element {
  const [creating, setCreating] = useState(false);
  const [removed, setRemoved] = useState<FocusAfterRemoval | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const saved = useRef<string | null>(null);
  const wasCreating = useRef(false);
  useEffect(() => {
    if (wasCreating.current && !creating) (opener.current ?? removeButton(list.current, saved.current))?.focus();
    wasCreating.current = creating;
  }, [creating]);
  useEffect(() => {
    if (!removed || list.current?.querySelector(`[data-game-analytics-funnel-card="${CSS.escape(removed.removed)}"]`))
      return;
    (removeButton(list.current, removed.next) ?? opener.current)?.focus();
  }, [removed]);
  const save = async (draft: EventFunnelDraft): Promise<EventFunnel> => {
    const funnel = await onSave(draft);
    saved.current = funnel.id;
    return funnel;
  };
  const remove = async (id: string): Promise<void> => {
    const next = focusAfterRemoval(
      view.funnels.map((funnel) => funnel.id),
      id,
    );
    await onRemove(id);
    setRemoved({ removed: id, next });
  };
  const start = firstEvent !== null && view.events.includes(firstEvent) ? firstEvent : view.events[0];
  const canCreate = !view.full && start !== undefined;
  return (
    <ReportSection
      id="funnels"
      title={WORDS.funnels.title}
      hint={WORDS.funnels.hint}
      controls={
        canCreate &&
        !creating && (
          <Button ref={opener} variant="secondary" data-game-analytics-new-funnel onClick={() => setCreating(true)}>
            {WORDS.funnels.new}
          </Button>
        )
      }
      footnote={view.full ? WORDS.funnels.limit(FUNNELS_MAX, formatNumber(FUNNELS_MAX)) : undefined}
    >
      {creating && start !== undefined && (
        <FunnelEditor
          events={view.events}
          firstEvent={start}
          onSave={save}
          onSaved={() => setCreating(false)}
          onCancel={() => setCreating(false)}
        />
      )}
      {view.funnels.length === 0 && !creating && <EmptyNote>{WORDS.funnels.empty}</EmptyNote>}
      {view.funnels.length > 0 && (
        <ul ref={list} className="game-analytics-events-funnels" aria-label={WORDS.funnels.label}>
          {view.funnels.map((funnel) => (
            <li key={funnel.id}>
              <FunnelCard funnel={funnel} onRemove={remove} />
            </li>
          ))}
        </ul>
      )}
    </ReportSection>
  );
}
