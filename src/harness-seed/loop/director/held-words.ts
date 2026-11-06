/**
 * The words for what Genex's moments held back in a Loop: a save point, restore or restart, for the
 * lead (`heldForLead`). Genex's own hold (Plan mode, the person using an app a lock guards, Genex
 * unable to tell whether they were, something else at work there) is worded from its typed hold and
 * the lock's label, never from its reason, which is written for agents; a plugin's step's block keeps
 * its reason.
 *
 * The rest is kept for copies of the Loop's modules an agent kept from before, which import it: the
 * seed holds no start, turn, crash step or way back, and pauses no Loop, so it words none of them
 * (a held start, a lead's turns held back, a crash step or a way back Genex held, an app that
 * couldn't be brought back).
 */
import { type HookHeldBy, HookHold, holdOf } from "../hooks.ts";

/** What held something back: the reason, and Genex's hold with its lock's label when it was Genex's. */
export type HeldBack = { reason: string } & HookHeldBy;

/** The words for each of Genex's own holds, by the app it held for. */
type HoldWords = { readonly [hold in HookHold]: (app: string) => string };

/** The app a hold names when its lock gave no label. */
const THE_APP = "the project's app";

/** A name that opens a sentence, its first letter upper case. */
const upper = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1);

/** Words without the full stop they may end with, to go on in a sentence. */
export const clause = (words: string): string => words.trim().replace(/[.]+$/, "");

const MESSAGE = {
  TurnsHeld: (reason: string) => `A plugin of this game kept holding the lead's turns back: ${reason}`,
  StartHeld: (reason: string, resumed: boolean) =>
    `The Loop didn't start: a plugin of this project held it back: ${reason} ${resumed ? "Then press Resume: the Loop stays paused." : "Then start the Loop again."}`,
  AppLost:
    "The game's editor stopped and didn't open again, even after the agent worked on it. Press Resume to let the agent try again.",
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

/** Why a paused Loop didn't pick up when Genex itself held its resumed start back: it stays paused for a Resume. */
const RESUME_HELD: HoldWords = {
  [HookHold.PersonFirst]: (app) =>
    `Genex waited for you to finish in ${app}, so the Loop didn't pick up. It stays paused: press Resume once you're done there.`,
  [HookHold.CantTell]: (app) =>
    `Genex couldn't tell whether you were using ${app}, so the Loop didn't pick up. It stays paused: press Resume once ${app} answers.`,
  [HookHold.Busy]: (app) =>
    `Something else was working in ${app}, so the Loop didn't pick up. It stays paused: press Resume to try again.`,
  [HookHold.Plan]: () =>
    "The chat is in Plan mode, so the Loop didn't pick up. It stays paused: press Resume once the plan is approved.",
};

/** Why the lead's turns stopped when Genex itself kept holding them back. */
const TURNS_HELD: HoldWords = {
  [HookHold.PersonFirst]: (app) => `Genex waited for you to finish in ${app}, so the lead's next turn didn't start.`,
  [HookHold.CantTell]: (app) =>
    `Genex couldn't tell whether you were using ${app}, so the lead's next turn didn't start.`,
  [HookHold.Busy]: (app) => `Something else kept working in ${app}, so the lead's next turn didn't start.`,
  [HookHold.Plan]: () => "The chat is in Plan mode, so the lead's next turn didn't start.",
};

/** What Genex itself held a save point, a restore or a restart back for, as the lead reads it. */
const HELD_FOR_LEAD: HoldWords = {
  [HookHold.PersonFirst]: (app) => `the person is using ${app}; try again later`,
  [HookHold.CantTell]: (app) => `Genex couldn't tell whether the person was using ${app}; try again later`,
  [HookHold.Busy]: (app) => `something else was working in ${app}; try again later`,
  [HookHold.Plan]: () => "the chat is in Plan mode, so nothing changes until the plan is approved",
};

/** Why the Loop pauses when the app stopped and Genex itself held its crash steps back: nothing reopened it. */
const CRASH_HELD: HoldWords = {
  [HookHold.PersonFirst]: (app) =>
    `${upper(app)} stopped, and Genex didn't reopen it: you were using it. Resume the Loop once you're done there.`,
  [HookHold.CantTell]: (app) =>
    `${upper(app)} stopped, and Genex didn't reopen it: it couldn't tell whether you were using it. Resume the Loop to try again.`,
  [HookHold.Busy]: (app) =>
    `${upper(app)} stopped, and Genex didn't reopen it: something else was working there. Resume the Loop to try again.`,
  [HookHold.Plan]: (app) =>
    `${upper(app)} stopped, and Genex didn't reopen it: the chat is in Plan mode. Resume the Loop once the plan is approved.`,
};

/** Why the Loop pauses when the app wouldn't reopen and Genex itself held back the way to the last save point. */
const BACK_HELD: HoldWords = {
  [HookHold.PersonFirst]: (app) =>
    `${upper(app)} stopped and didn't reopen, and Genex didn't go back to the last save point: you were using it. Resume the Loop once you're done there.`,
  [HookHold.CantTell]: (app) =>
    `${upper(app)} stopped and didn't reopen, and Genex didn't go back to the last save point: it couldn't tell whether you were using it. Resume the Loop to try again.`,
  [HookHold.Busy]: (app) =>
    `${upper(app)} stopped and didn't reopen, and Genex didn't go back to the last save point: something else was working there. Resume the Loop to try again.`,
  [HookHold.Plan]: (app) =>
    `${upper(app)} stopped and didn't reopen, and Genex didn't go back to the last save point: the chat is in Plan mode. Resume the Loop once the plan is approved.`,
};

/** Genex's own hold in `words`, or null when a plugin's step held it back. */
function heldFor(held: HookHeldBy, words: HoldWords): string | null {
  const hold = holdOf(held);
  return hold ? words[hold.hold](hold.label ?? THE_APP) : null;
}

/** Why the lead's turn stopped when it was held while the run could not wait, for the person, as {@link openStartHeld} words a start. */
export function turnsHeldWords(held: HeldBack): string {
  return heldFor(held, TURNS_HELD) ?? MESSAGE.TurnsHeld(held.reason);
}

/**
 * Why a Loop didn't start, for the person: Genex's own hold in their words (which say to start it
 * again, or for a resumed Loop, which stays paused, to press Resume), a plugin's block with its
 * reason and what to do next. Kept for a `director.ts` an agent kept from before: the seed holds no
 * start back, and what its start found is its lead's first lines.
 */
export function openStartHeld(blocked: HeldBack, resumed = false): string {
  return heldFor(blocked, resumed ? RESUME_HELD : START_HELD) ?? MESSAGE.StartHeld(blocked.reason, resumed);
}

/** Why something was held back, for the lead: Genex's own hold in its words, a step's block with its reason. */
export function heldForLead(held: HeldBack): string {
  return heldFor(held, HELD_FOR_LEAD) ?? held.reason;
}

/** Why the Loop pauses when Genex held the crash steps back, or null for a step's own block. */
export const crashHeldWords = (held: HookHeldBy): string | null => heldFor(held, CRASH_HELD);

/** Why the Loop pauses when Genex held back going to the last save point, or null for a step's own block. */
export const backHeldWords = (held: HookHeldBy): string | null => heldFor(held, BACK_HELD);

/**
 * Why the Loop pauses when neither Genex nor its lead could bring the project's app back, in words the
 * person can act on: the app's own error stays the lead's, a compiler's lines never reach the person.
 */
export const appLostWords = (): string => MESSAGE.AppLost;

/**
 * A lead's turn Genex's moments held back while the run could not wait (its wrap-up, a Stop): a
 * failed turn no session ran, carrying the person's words for why (`turnsHeldWords`).
 */
export type HeldTurn = { ok: false; turns: 0; errorText: string; heldBack: true };

/** The failed turn such a hold makes, with the person's words for it. */
export const heldTurnResult = (words: string): HeldTurn => ({ ok: false, turns: 0, errorText: words, heldBack: true });

/** Why the run ended when its last failed turn was one Genex's moments held back: the person's words, or null for any other turn. */
export function heldTurnEnding(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const turn = result as Partial<HeldTurn>;
  return turn.heldBack === true && typeof turn.errorText === "string" ? turn.errorText : null;
}
