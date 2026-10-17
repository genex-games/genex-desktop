/**
 * The person's words for an open Loop that pauses because the project's app stopped: Genex couldn't
 * bring it back, Genex itself held the crash steps back (Plan mode, the person using the app, Genex
 * unable to tell whether they were, something else at work there), or held back the way to the last
 * save point after the app wouldn't reopen. Genex's hold is worded from its type and the lock's
 * label, never from the hold's reason, which is written for agents. Each pause says what to do: the
 * person resumes the Loop.
 */
import { type HookHeldBy, HookHold, holdOf } from "../../hooks.ts";

/** The app a hold names when its lock gave no label. */
const THE_APP = "the project's app";

/** A name that opens a sentence, its first letter upper case. */
const upper = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1);

/** The person's words for each of Genex's own holds, by the app it held for. */
type HoldWords = { readonly [hold in HookHold]: (app: string) => string };

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

/** Words without the full stop they may end with, to go on in a sentence. */
const clause = (words: string): string => words.trim().replace(/[.]+$/, "");

/** The person's words for Genex's own hold, or null when a step held it back. */
function heldFor(held: HookHeldBy, words: HoldWords): string | null {
  const hold = holdOf(held);
  return hold ? words[hold.hold](hold.label ?? THE_APP) : null;
}

/** Why the Loop pauses when Genex held the crash steps back, or null for a step's own block. */
export const crashHeldWords = (held: HookHeldBy): string | null => heldFor(held, CRASH_HELD);

/** Why the Loop pauses when Genex held back going to the last save point, or null for a step's own block. */
export const backHeldWords = (held: HookHeldBy): string | null => heldFor(held, BACK_HELD);

/** Why the Loop pauses when Genex couldn't bring the project's app back, in words the person can act on. */
export const appLostWords = (why: string): string =>
  `The project's app stopped and Genex couldn't bring it back (${clause(why)}). Open it, then Resume the Loop.`;
