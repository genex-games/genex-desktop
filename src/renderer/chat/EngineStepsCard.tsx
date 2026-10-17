/**
 * The engine plugin's setup card ("Unreal setup") above the composer: a quiet card, not a permission card. Its rows are the
 * plugin's own answer, asked again every few seconds while it shows a step open, so a step done outside Genex
 * (Xcode installed, opened once) is ticked by itself; with nothing left open it goes, and when the
 * plugin names words for that the agent is told, so the chat goes on. A card may carry its own
 * button that does every step it can for the person (Do it for me), and its own way out in Hide's
 * place (Don't use Unity); otherwise Hide puts it away for this game until the agent offers it again.
 */
import { type JSX, useEffect, useRef, useState } from "react";
import { SECOND_MS } from "../../shared/duration.ts";
import { isUserCancelled } from "../../shared/errors.ts";
import { readText, storageKeyFor, writeText } from "../storage.ts";
import { type Notify, notifyProblem } from "../state/toasts.ts";
import { Button } from "../ui/Button.tsx";
import { StepMark } from "./StepMark.tsx";
import { STEPS_WORDS } from "../words.ts";
import { usePlugins } from "../state/hooks.ts";
import { Icon } from "../ui/icons.tsx";
import {
  type KeptSteps,
  parseSteps,
  runButton,
  STEPS_ACTION,
  type StepButton,
  type StepRow,
  type StepsCard,
  stepsCardFor,
  type StepsOffer,
  stepsShown,
  watchSteps,
} from "./engine-steps.ts";

/** How often the card asks the plugin again while it shows. */
const STEPS_REFRESH_MS = 5 * SECOND_MS;
/** How long Copy says Copied, as the Unreal panel's own Copy does. */
const COPIED_MS = 2 * SECOND_MS;

/**
 * The plugin's rows for an offer, asked now and every few seconds while `live` and a step is open
 * (`watchSteps`); `onFinished` hears what the agent is told when the card it showed open has nothing
 * left open, or a step stopped. A card read for another game or engine is never returned.
 */
function useSteps(offer: StepsOffer | null, live: boolean, onFinished: (says: string) => void): StepsCard | null {
  const [kept, setKept] = useState<KeptSteps | null>(null);
  const finished = useRef(onFinished);
  finished.current = onFinished;
  // The offer is derived on every render; its id, plugin and game are what the asking depends on.
  const offerId = offer?.id;
  const pluginId = offer?.pluginId;
  const project = offer?.project;
  useEffect(() => {
    if (!offerId || !pluginId || !project || !live) return;
    const asked = { id: offerId, pluginId, project };
    return watchSteps({
      ask: () =>
        window.studio
          .pluginAction(pluginId, STEPS_ACTION, {}, project)
          .then(parseSteps)
          .catch(() => null),
      onCard: (card) => setKept({ offer: asked, card }),
      onFinished: (says) => finished.current(says),
      everyMs: STEPS_REFRESH_MS,
    });
  }, [offerId, pluginId, project, live]);
  return stepsCardFor(kept, offer);
}

/** A row's command copied to the clipboard; Copy says Copied for a moment, then Copy again. */
function useCopy(command: string | undefined) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = () => {
    if (!command) return;
    navigator.clipboard.writeText(command).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };
  return { copied, copy };
}

/** A step's words: its label, and while it is open its detail and the command to run. */
function StepText({ row, command }: { row: StepRow; command: string | null }): JSX.Element {
  return (
    <span className="min-w-0 flex-1">
      <span className={`block text-chat ${row.done ? "text-ink-3" : "text-ink-2"}`}>
        {row.label}
        {row.done ? <span className="sr-only"> {STEPS_WORDS.done}</span> : null}
      </span>
      {!row.done && row.detail ? <span className="block text-chat-sub text-ink-3">{row.detail}</span> : null}
      {command ? (
        <code className="mt-1 block select-all font-mono text-sm text-ink-2 [overflow-wrap:anywhere]">{command}</code>
      ) : null}
    </span>
  );
}

/** An open step's buttons: its action, and Copy for its command; beside the words when wide, under them when narrow. */
function StepButtons({
  row,
  command,
  onRun,
}: {
  row: StepRow;
  command: string | null;
  onRun: (row: StepRow) => void;
}): JSX.Element | null {
  const { copied, copy } = useCopy(command ?? undefined);
  const action = !row.done && row.action ? row.action : null;
  if (!action && !command) return null;
  return (
    <span className="col-start-2 flex flex-wrap gap-2 @md:col-start-3 @md:row-start-1">
      {action ? (
        <Button size="sm" variant="secondary" onClick={() => onRun(row)}>
          {action.label}
        </Button>
      ) : null}
      {command ? (
        <Button size="sm" variant="secondary" onClick={copy}>
          {copied ? STEPS_WORDS.copied : STEPS_WORDS.copy}
        </Button>
      ) : null}
    </span>
  );
}

/**
 * One step in a box of its own: its mark, its words (and the command to run), and its buttons, which
 * sit beside the words on a wide card and under them on a narrow one, so the words never squeeze
 * into a column.
 */
function StepLine({ row, onRun }: { row: StepRow; onRun: (row: StepRow) => void }): JSX.Element {
  const command = !row.done && row.command ? row.command : null;
  return (
    <li
      data-step={row.id}
      className="grid min-w-0 grid-cols-[1rem_minmax(0,1fr)] items-start gap-x-2.5 gap-y-1.5 rounded-[12px] border border-line-soft px-3 py-2.5 @md:grid-cols-[1rem_minmax(0,1fr)_auto]"
    >
      <StepMark done={row.done} you={row.you === true} working={row.working === true} clear />
      <StepText row={row} command={command} />
      <StepButtons row={row} command={command} onRun={onRun} />
    </li>
  );
}

/** The card's own button, which does every step it can for the person: a screen marks that Genex works on this computer. */
function PrimaryButton({ button, onRun }: { button: StepButton; onRun: (button: StepButton) => void }): JSX.Element {
  return (
    <button type="button" className="chat-question-submit" onClick={() => onRun(button)}>
      <Icon name="computer" size={15} />
      {button.label}
    </button>
  );
}

/** The card for the chat's newest offer, while a step is open and the person hasn't hidden it. */
export function EngineStepsCard({
  offer,
  onNotice,
  onFinished,
}: {
  offer: StepsOffer | null;
  onNotice: Notify;
  /** Tell the agent the card is done, or a step stopped, in the plugin's words, so the chat goes on. */
  onFinished: (says: string) => void;
}): JSX.Element | null {
  const key = offer ? storageKeyFor.engineStepsDismissed(offer.project) : null;
  const [dismissed, setDismissed] = useState(() => (key ? readText(key) : null));
  useEffect(() => setDismissed(key ? readText(key) : null), [key]);
  const shown = stepsShown(offer, dismissed);
  const card = useSteps(offer, shown, onFinished);
  const plugin = usePlugins((s) => s.list.find((p) => p.manifest.id === offer?.pluginId) ?? null);
  if (!shown || !card?.open) return null;
  const hide = () => {
    if (key) writeText(key, offer.id);
    setDismissed(offer.id);
  };
  // Saying no in the action's dialog is an answer, not a problem to show.
  const press = (button: StepButton | undefined) => {
    void runButton(plugin, offer, button).catch((error: unknown) => {
      if (!isUserCancelled(error)) notifyProblem(onNotice)(error);
    });
  };
  const run = (row: StepRow) => {
    press(row.action);
  };
  const wayOut = card.secondary;
  return (
    <section data-engine-steps aria-labelledby="engine-steps-title" className="chat-question chat-waiting-card mb-2">
      <div className="min-h-0 overflow-y-auto px-4 py-3">
        <h3 id="engine-steps-title" className="text-chat font-medium">
          {card.title}
        </h3>
        <p className="mt-0.5 text-chat-sub text-ink-3">{card.intro}</p>
        <ul className="@container mt-3 flex min-w-0 flex-col gap-2">
          {card.steps.map((row) => (
            <StepLine key={row.id} row={row} onRun={run} />
          ))}
        </ul>
      </div>
      {/* The card's buttons stay in view under the steps, which scroll above them. */}
      <div
        data-engine-steps-actions
        className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-4 py-2.5"
      >
        {wayOut ? (
          <Button size="sm" variant="secondary" onClick={() => press(wayOut)}>
            {wayOut.label}
          </Button>
        ) : (
          <Button size="sm" variant="secondary" aria-label={STEPS_WORDS.hideLabel} onClick={hide}>
            {STEPS_WORDS.hide}
          </Button>
        )}
        {card.primary ? <PrimaryButton button={card.primary} onRun={press} /> : null}
      </div>
    </section>
  );
}
