/**
 * The person's words for a run Genex's moments held back: its start, or its lead's turns past every
 * ask. Genex's own hold (Plan mode, the person using an app a lock guards, Genex unable to tell
 * whether they were, something else at work there) is worded for the person from its typed hold,
 * never from its reason, which is written for agents; a plugin's step's block keeps its reason. A
 * module of its own, so the shipped director and wake loop need no new name from a module an agent
 * may have kept.
 */
import { type HookHeldBy, HookHold, holdOf } from "../hooks.ts";

/** What held something back: the reason, and Genex's hold with its lock's label when it was Genex's. */
export type HeldBack = { reason: string } & HookHeldBy;

/** The person's words for each of Genex's own holds, by the app it held for. */
type HoldWords = { readonly [hold in HookHold]: (app: string) => string };

/** The app a hold names when its lock gave no label. */
const THE_APP = "the game's app";

const MESSAGE = {
  RunHeld: (reason: string) => `The run didn't start: a plugin of this game held it back: ${reason}`,
  TurnsHeld: (reason: string) => `A plugin of this game kept holding the lead's turns back: ${reason}`,
} as const;

/** Why the run didn't start when Genex itself held its start back. */
const START_HELD: HoldWords = {
  [HookHold.PersonFirst]: (app) =>
    `Genex waited for you to finish in ${app}, so the run didn't start. Start it again once you're done there.`,
  [HookHold.CantTell]: (app) =>
    `Genex couldn't tell whether you were using ${app}, so the run didn't start. Start it again once ${app} answers.`,
  [HookHold.Busy]: (app) =>
    `Something else was working in ${app}, so the run didn't start. Start it again to try again.`,
  [HookHold.Plan]: () => "The chat is in Plan mode, so the run didn't start. Start it again once the plan is approved.",
};

/** Why the lead's turns stopped when Genex itself kept holding them back. */
const TURNS_HELD: HoldWords = {
  [HookHold.PersonFirst]: (app) => `Genex waited for you to finish in ${app}, so the lead's next turn didn't start.`,
  [HookHold.CantTell]: (app) =>
    `Genex couldn't tell whether you were using ${app}, so the lead's next turn didn't start.`,
  [HookHold.Busy]: (app) => `Something else kept working in ${app}, so the lead's next turn didn't start.`,
  [HookHold.Plan]: () => "The chat is in Plan mode, so the lead's next turn didn't start.",
};

/** Genex's own hold in the person's words, or null when a plugin's step held it back. */
function heldFor(held: HeldBack, words: HoldWords): string | null {
  const hold = holdOf(held);
  return hold ? words[hold.hold](hold.label ?? THE_APP) : null;
}

/** Why a run didn't start, for the person: Genex's hold in their words, a plugin's block with its reason. */
export function runHeldWords(held: HeldBack): string {
  return heldFor(held, START_HELD) ?? MESSAGE.RunHeld(held.reason);
}

/** Why the lead's turns stopped after every ask was held, for the person, as {@link runHeldWords} words it. */
export function turnsHeldWords(held: HeldBack): string {
  return heldFor(held, TURNS_HELD) ?? MESSAGE.TurnsHeld(held.reason);
}
