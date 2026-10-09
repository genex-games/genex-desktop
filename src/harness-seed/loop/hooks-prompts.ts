/**
 * What a lead is told when a plugin of its game holds one of its moments back (`hooks.ts`): the
 * step's own reason, and what goes on instead. A module of its own, so the shipped parts that say it
 * (the director's start, wake loop, tools and builders) need no new name from a module an agent
 * may have kept.
 */

/** The words a held moment answers with. Model-facing: the lead reads them as written. */
export const HOOK_PROMPTS = {
  finishHeld: (reason: string) =>
    `Not finished: a plugin of this game holds the finish back: ${reason} Deal with it, then call finish again; the run goes on meanwhile.`,
  workerHeld: (reason: string) => `Not started: a plugin of this game holds the worker back: ${reason}`,
  turnHeld: (reason: string) => `A plugin of this game held your last turn back before it started: ${reason}`,
} as const;
