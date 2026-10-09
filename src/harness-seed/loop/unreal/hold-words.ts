/**
 * The person's words for what Genex itself held back in an Unreal run: the run's start, the close's
 * save, the lead's turns, a restore or restart between turns, and adding the game's C++ module.
 * Each is worded from Genex's typed hold (Plan mode, the person using Unreal, Genex unable to tell
 * whether they were, something else at work there) and the lock's label, never from the hold's
 * reason, which is written for agents and speaks of "the person". A plugin's step's own block keeps
 * its reason: each word function answers null for it.
 */
import { type HookHeldBy, HookHold, holdOf } from "../hooks.ts";

/** The app a hold names when its lock gave no label. */
const THE_EDITOR = "Unreal";

/** The person's words for each of Genex's own holds, by the app it held for. */
type HoldWords = { readonly [hold in HookHold]: (app: string) => string };

/** Why the Loop didn't start when Genex itself held its start back. */
const START_HELD: HoldWords = {
  [HookHold.PersonFirst]: (app) =>
    `Genex waited for you to finish in ${app}, so the Loop didn't start. Start the Loop again once you're done there.`,
  [HookHold.CantTell]: (app) =>
    `Genex couldn't tell whether you were using ${app}, so the Loop didn't start. Start the Loop again once ${app} answers.`,
  [HookHold.Busy]: (app) =>
    `Something else was working in ${app}, so the Loop didn't start. Start the Loop again to try again.`,
  [HookHold.Plan]: () =>
    "The chat is in Plan mode, so the Loop didn't start. Start the Loop again once the plan is approved.",
};

/** Why the close didn't save the editor's work when Genex itself held its checkpoint back. */
const CLOSE_HELD: HoldWords = {
  [HookHold.PersonFirst]: (app) =>
    `Genex didn't save Unreal's last work as the Loop ended: you were using ${app}. Save it there when you're done.`,
  [HookHold.CantTell]: (app) =>
    `Genex didn't save Unreal's last work as the Loop ended: it couldn't tell whether you were using ${app}. Save it there.`,
  [HookHold.Busy]: (app) =>
    `Genex didn't save Unreal's last work as the Loop ended: something else was working in ${app}. Save it in ${app}.`,
  [HookHold.Plan]: () =>
    "Genex didn't save Unreal's last work as the Loop ended: the chat is in Plan mode. Save it in Unreal.",
};

/** Why the run halts when Genex itself kept holding the lead's turns back. */
const TURNS_HELD: HoldWords = {
  [HookHold.PersonFirst]: (app) =>
    `Genex waited for you to finish in ${app} before the lead's next turn. Save your work there, then Resume the Loop.`,
  [HookHold.CantTell]: (app) =>
    `Genex couldn't tell whether you were using ${app}, so the lead's next turn didn't start. Resume the Loop once ${app} answers.`,
  [HookHold.Busy]: (app) =>
    `Something else kept working in ${app}, so the lead's next turn didn't start. Resume the Loop to try again.`,
  [HookHold.Plan]: () =>
    "The chat is in Plan mode, so the lead's next turn didn't start. Resume the Loop once the plan is approved.",
};

/** Why the run halts when Genex itself held a restore or a restart back between turns. */
const BETWEEN_HELD: HoldWords = {
  [HookHold.PersonFirst]: (app) =>
    `Genex waited for you to finish in ${app}, and nothing was changed. Save your work there, then Resume the Loop.`,
  [HookHold.CantTell]: (app) =>
    `Genex couldn't tell whether you were using ${app}, so nothing was changed. Resume the Loop once ${app} answers.`,
  [HookHold.Busy]: (app) =>
    `Something else was working in ${app}, so nothing was changed. Resume the Loop to try again.`,
  [HookHold.Plan]: () => "The chat is in Plan mode, so nothing was changed. Resume the Loop once the plan is approved.",
};

/** Why the game's C++ module wasn't added when Genex itself held the plugin's step back. */
const CPP_HELD: HoldWords = {
  [HookHold.PersonFirst]: (app) =>
    `C++ couldn't be added while you were using ${app}, so this run builds everything in Blueprints.`,
  [HookHold.CantTell]: (app) =>
    `C++ couldn't be added: Genex couldn't tell whether you were using ${app}. This run builds everything in Blueprints.`,
  [HookHold.Busy]: (app) =>
    `C++ couldn't be added: something else was working in ${app}. This run builds everything in Blueprints.`,
  [HookHold.Plan]: () =>
    "C++ couldn't be added while the chat is in Plan mode, so this run builds everything in Blueprints.",
};

/** The person's words for Genex's own hold, or null when a step held it back (its reason stands). */
function heldFor(held: HookHeldBy, words: HoldWords): string | null {
  const hold = holdOf(held);
  return hold ? words[hold.hold](hold.label ?? THE_EDITOR) : null;
}

/** Why the Loop didn't start, when Genex held its start: the person's words, or null for a step's block. */
export const startHeldWords = (held: HookHeldBy): string | null => heldFor(held, START_HELD);
/** Why the close's save wasn't made, when Genex held it: the person's words, or null for a step's block. */
export const closeHeldWords = (held: HookHeldBy): string | null => heldFor(held, CLOSE_HELD);
/** Why the run halts after Genex kept holding the lead's turns: the person's words, or null for a step's block. */
export const turnsHeldWords = (held: HookHeldBy): string | null => heldFor(held, TURNS_HELD);
/** Why the run halts when Genex held a restore or restart: the person's words, or null for a step's block. */
export const betweenHeldWords = (held: HookHeldBy): string | null => heldFor(held, BETWEEN_HELD);
/** Why the C++ module wasn't added, when Genex held the plugin's step: the person's words, or null otherwise. */
export const cppHeldWords = (held: HookHeldBy): string | null => heldFor(held, CPP_HELD);
