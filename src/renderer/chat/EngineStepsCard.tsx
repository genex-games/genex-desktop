/**
 * The engine plugin's setup card ("Unreal setup") above the composer: a quiet card, not a permission card. Its rows are the
 * plugin's own answer, asked again every few seconds while it shows, so a step done outside Genex
 * (Xcode installed, opened once) is ticked by itself; with nothing left open it goes. Not now hides
 * it for this game until the agent offers it again.
 */
import { type JSX, useEffect, useState } from "react";
import { SECOND_MS } from "../../shared/duration.ts";
import { readText, storageKeyFor, writeText } from "../storage.ts";
import { type Notify, notifyProblem } from "../state/toasts.ts";
import { Button } from "../ui/Button.tsx";
import { StepMark } from "./StepMark.tsx";
import { STEPS_WORDS } from "../words.ts";
import { parseSteps, STEPS_ACTION, type StepRow, type StepsCard, type StepsOffer, stepsShown } from "./engine-steps.ts";

/** How often the card asks the plugin again while it shows. */
const STEPS_REFRESH_MS = 5 * SECOND_MS;
/** How long Copy says Copied, as the Unreal panel's own Copy does. */
const COPIED_MS = 2 * SECOND_MS;

/** The plugin's rows for an offer, asked now and every few seconds while `live`. */
function useSteps(offer: StepsOffer | null, live: boolean): StepsCard | null {
  const [card, setCard] = useState<StepsCard | null>(null);
  // The offer is derived on every render; its plugin and game are what the asking depends on.
  const pluginId = offer?.pluginId;
  const project = offer?.project;
  useEffect(() => {
    if (!pluginId || !project || !live) return;
    let stopped = false;
    const ask = () =>
      window.studio
        .pluginAction(pluginId, STEPS_ACTION, {}, project)
        .then((answer) => !stopped && setCard(parseSteps(answer)))
        .catch(() => !stopped && setCard(null));
    void ask();
    const timer = setInterval(() => void ask(), STEPS_REFRESH_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [pluginId, project, live]);
  return card;
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
 * One step: its mark, its words (and the command to run), and its buttons, which sit beside the
 * words on a wide card and under them on a narrow one, so the words never squeeze into a column.
 */
function StepLine({ row, onRun }: { row: StepRow; onRun: (row: StepRow) => void }): JSX.Element {
  const command = !row.done && row.command ? row.command : null;
  return (
    <li
      data-step={row.id}
      className="grid min-w-0 grid-cols-[1rem_minmax(0,1fr)] items-start gap-x-2.5 gap-y-1.5 py-1 @md:grid-cols-[1rem_minmax(0,1fr)_auto]"
    >
      <StepMark done={row.done} />
      <StepText row={row} command={command} />
      <StepButtons row={row} command={command} onRun={onRun} />
    </li>
  );
}

/** The card for the chat's newest offer, while a step is open and the person hasn't said Not now. */
export function EngineStepsCard({
  offer,
  onNotice,
}: {
  offer: StepsOffer | null;
  onNotice: Notify;
}): JSX.Element | null {
  const key = offer ? storageKeyFor.engineStepsDismissed(offer.project) : null;
  const [dismissed, setDismissed] = useState(() => (key ? readText(key) : null));
  useEffect(() => setDismissed(key ? readText(key) : null), [key]);
  const shown = stepsShown(offer, dismissed);
  const card = useSteps(offer, shown);
  if (!shown || !card?.open) return null;
  const notNow = () => {
    if (key) writeText(key, offer.id);
    setDismissed(offer.id);
  };
  const run = (row: StepRow) => {
    if (!row.action) return;
    void window.studio
      .pluginAction(offer.pluginId, row.action.name, row.action.args, offer.project)
      .catch(notifyProblem(onNotice));
  };
  return (
    <section data-engine-steps aria-labelledby="engine-steps-title" className="chat-question chat-waiting-card mb-2">
      <div className="min-h-0 overflow-y-auto px-4 py-3">
        <h3 id="engine-steps-title" className="text-chat font-medium">
          {card.title}
        </h3>
        <p className="mt-0.5 text-chat-sub text-ink-3">{card.intro}</p>
        <ul className="@container mt-2 flex min-w-0 flex-col">
          {card.steps.map((row) => (
            <StepLine key={row.id} row={row} onRun={run} />
          ))}
        </ul>
        <div className="mt-1.5 flex justify-end">
          <Button size="sm" variant="ghost" onClick={notNow}>
            {STEPS_WORDS.notNow}
          </Button>
        </div>
      </div>
    </section>
  );
}
