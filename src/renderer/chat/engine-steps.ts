/**
 * The steps card an engine plugin offers in a game's chat (Unreal's is "Unreal setup").
 * The chat's log says when it was offered (`engine_steps`); its rows are the plugin's `steps`
 * action's answer, read live so a step the person finishes is ticked without being told. The
 * answer comes from plugin code, so only well-formed rows are drawn.
 */
import { CustomEvent, customEvent } from "../../shared/custom-events.ts";
import type { PluginInfo } from "../../shared/plugins.ts";
import { runPluginAction } from "../plugin-actions.ts";
import { type PollTimers, startStatusPoll } from "../status-poll.ts";
import type { EventEnvelope } from "../types.ts";
import { STEPS_WORDS } from "../words.ts";

/** The plugin action the card reads its rows from. */
export const STEPS_ACTION = "steps";

/** Where the card was last offered: the record's id (Hide remembers it), the plugin and the game. */
export type StepsOffer = { id: string; pluginId: string; project: string };

/** A step's button: the plugin action it runs, with its arguments, and its label. */
export type StepButton = { name: string; args: Record<string, string>; label: string };
/**
 * One row: a done step is ticked; an open one may have a button, or a line to run in Terminal.
 * `you` marks a step only the person can do (signing in), or one that stopped and waits for them;
 * `working` one Genex is doing now.
 */
export type StepRow = {
  id: string;
  label: string;
  detail: string;
  done: boolean;
  you?: true;
  working?: true;
  action?: StepButton;
  command?: string;
};
/**
 * The card as the plugin answers it. `primary` is the card's own button that does every step it
 * can for the person (Do it for me); `doneSays` is what the agent is told once nothing is open, and
 * `stuckSays` what it is told when a step Genex ran for the person stopped, so it can finish it
 * another way (with computer control) or tell the person.
 */
export type StepsCard = {
  title: string;
  intro: string;
  open: boolean;
  steps: StepRow[];
  primary?: StepButton;
  /** The plugin's own way out in Hide's place (Don't use Unity, or Stop while it works). */
  secondary?: StepButton;
  doneSays?: string;
  stuckSays?: string;
};

/** The newest offer in a chat's log, or null. */
export function stepsOffer(events: readonly EventEnvelope[]): StepsOffer | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    const offered = event ? customEvent(event, CustomEvent.EngineSteps) : null;
    if (!event || !offered) continue;
    return offered.pluginId && offered.project
      ? { id: event.id, pluginId: offered.pluginId, project: offered.project }
      : null;
  }
  return null;
}

/** Whether an offer still shows: the person hid an earlier one, or none. */
export const stepsShown = (offer: StepsOffer | null, dismissed: string | null): offer is StepsOffer =>
  offer !== null && offer.id !== dismissed;

const isText = (value: unknown): value is string => typeof value === "string";
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

function parseButton(raw: unknown): StepButton | undefined {
  if (!isRecord(raw) || !isText(raw.name) || !isText(raw.label) || !isRecord(raw.args)) return undefined;
  const args = Object.fromEntries(
    Object.entries(raw.args).filter((entry): entry is [string, string] => isText(entry[1])),
  );
  return { name: raw.name, args, label: raw.label };
}

function parseRow(raw: unknown): StepRow | undefined {
  if (!isRecord(raw) || !isText(raw.id) || !isText(raw.label) || typeof raw.done !== "boolean") return undefined;
  const action = parseButton(raw.action);
  return {
    id: raw.id,
    label: raw.label,
    detail: isText(raw.detail) ? raw.detail : "",
    done: raw.done,
    ...(raw.you === true ? { you: true as const } : {}),
    ...(raw.working === true ? { working: true as const } : {}),
    ...(action ? { action } : {}),
    ...(isText(raw.command) && raw.command ? { command: raw.command } : {}),
  };
}

/** The plugin's answer as the card draws it, or null when it isn't a card at all. */
export function parseSteps(raw: unknown): StepsCard | null {
  if (!isRecord(raw) || !isText(raw.title) || !isText(raw.intro) || !Array.isArray(raw.steps)) return null;
  const steps = raw.steps.map(parseRow).filter((row): row is StepRow => row !== undefined);
  const primary = parseButton(raw.primary);
  const secondary = parseButton(raw.secondary);
  return {
    title: raw.title,
    intro: raw.intro,
    open: raw.open === true,
    steps,
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
    ...(isText(raw.doneSays) && raw.doneSays ? { doneSays: raw.doneSays } : {}),
    ...(isText(raw.stuckSays) && raw.stuckSays ? { stuckSays: raw.stuckSays } : {}),
  };
}

/**
 * What the agent is told when a card it showed open has nothing left open (the person, or Genex for
 * them, finished it), so the chat goes on by itself; null while a step is open, for a card never
 * seen open, and for a plugin that names nothing to say.
 */
export function finishedSays(previous: StepsCard | null, next: StepsCard | null): string | null {
  if (!previous?.open || !next || next.open) return null;
  return next.doneSays ?? null;
}

/**
 * What the agent is told when a step the card showed going stopped while the chat looked on: once
 * per stop, never for a stop from before the chat opened (it was told then), and null otherwise.
 */
export function stuckSays(previous: StepsCard | null, next: StepsCard | null): string | null {
  if (!previous || !next?.stuckSays || next.stuckSays === previous.stuckSays) return null;
  return next.stuckSays;
}

/** A card as last read, with the offer it was read for. */
export type KeptSteps = { offer: StepsOffer; card: StepsCard | null };

/**
 * The kept card while the chat's offer is still for the same plugin and game, else nothing: a card
 * read for one game never shows, or runs its buttons, in another game's chat.
 */
export function stepsCardFor(kept: KeptSteps | null, offer: StepsOffer | null): StepsCard | null {
  const same = kept !== null && offer !== null && kept.offer.pluginId === offer.pluginId;
  return same && kept.offer.project === offer.project ? kept.card : null;
}

/** What `watchSteps` asks with and tells. */
export type StepsWatch = {
  /** The plugin's rows, read now; null when the read failed or isn't a card. */
  ask: () => Promise<StepsCard | null>;
  onCard: (card: StepsCard | null) => void;
  /** What the agent is told: a finish (at most once) or a step that stopped. */
  onFinished: (says: string) => void;
  everyMs: number;
  timers?: PollTimers;
};

/**
 * The card's rows, asked now and every `everyMs` (one ask at a time) while a step is open: a card
 * with nothing left open is asked no more, and its finish is told once. A failed read shows nothing
 * and is asked again. Returns the stop, after which no answer lands.
 */
export function watchSteps({ ask, onCard, onFinished, everyMs, timers }: StepsWatch): () => void {
  let previous: StepsCard | null = null;
  let toldDone = false;
  const poll = startStatusPoll(
    ask,
    (next) => {
      const done = toldDone ? null : finishedSays(previous, next);
      const says = done ?? stuckSays(previous, next);
      if (done) toldDone = true;
      previous = next;
      if (next && !next.open) poll.stop();
      onCard(next);
      if (says) onFinished(says);
    },
    everyMs,
    timers,
  );
  return poll.stop;
}

/**
 * A step's button pressed: its plugin action, run as every surface runs one (`runPluginAction`),
 * so an action that declares a confirmation is reviewed and approved in the native dialog first.
 * The card shows no picture review, so a review that asks for one is cancelled.
 */
export async function runStep(plugin: PluginInfo | null, offer: StepsOffer, row: StepRow): Promise<unknown> {
  return runButton(plugin, offer, row.action);
}

/** One of the card's buttons pressed (a step's, Do it for me, or the plugin's own way out), run as `runStep` runs one. */
export async function runButton(
  plugin: PluginInfo | null,
  offer: StepsOffer,
  action: StepButton | undefined,
): Promise<unknown> {
  if (!action) return undefined;
  if (!plugin) throw new Error(STEPS_WORDS.pluginGone);
  return runPluginAction({
    plugin,
    name: action.name,
    args: action.args,
    project: offer.project,
    review: ({ resolve }) => resolve(false),
  });
}
