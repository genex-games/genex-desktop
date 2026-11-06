/**
 * Genex's lines about the project's app, as the open Loop's lead reads them: what a look at the app
 * (`health`) found, in its plugin's own words, and what a save point holds when the app saved nothing
 * first. Facts only: what the lead can do is in its tools' descriptions. Model-facing: the lead reads
 * them as written. A module of its own, which no agent can have kept an older copy of.
 */
import { clause } from "../held-words.ts";

/** What a look at the project's app, or a save point Genex took without its steps, tells the lead. */
export const APP_NEWS = {
  /** The app doesn't answer: its plugin's reason (a build error names its file and line). */
  notAnswering: (why: string) => `The project's app doesn't answer: ${clause(why)}.`,
  /** The app answers, but isn't ready yet (loading, compiling, the person using it): why. */
  notReady: (why: string) => `The project's app isn't ready yet: ${clause(why)}.`,
  /** A save point whose steps Genex skipped (the person was using the app): only the files on disk are in it. */
  notSavedFirst: "The project's app saved nothing of its own first, so this save point holds only the files on disk.",
} as const;
