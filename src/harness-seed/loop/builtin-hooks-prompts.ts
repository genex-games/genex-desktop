/**
 * What Genex's own gates found (`builtin-hooks.ts`), as the Loop's lead reads it at its start: one
 * fact, never what to do about it. Model-facing: the lead reads it as written. A module of its own,
 * which no agent can have kept an older copy of.
 */

/** A gate's findings, in the lead's words. */
export const GATE_WORDS = {
  /** The game a descriptor names no name for. */
  theGame: "The game",
  /** `web.ready`: the files the web page needs to load that are not there, by name. */
  pageMissing: (name: string, missing: readonly string[]) => `${name}'s page is missing ${missing.join(", ")}.`,
} as const;
