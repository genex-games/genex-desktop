/**
 * The internal switch back to the Unreal runner a Loop on an Unreal game had before the one Loop:
 * for developers, until a live Unreal Loop passes on the one Loop. The studio hands it on from its
 * own environment (shared/protocol.ts `UNREAL_RUNNER_ENV`, which this copies). It is never a run
 * record field and never shown: a Loop the one Loop wrote a journal for never goes to it.
 */
import { CoreFact, type FactsOfDescriptor, hasFact, servedFactsOf } from "./folder-facts.ts";

/** The studio's environment variable that names the Unreal runner. */
export const UNREAL_RUNNER_ENV = "STUDIO_UNREAL_RUNNER";

/** What the switch may name: the Unreal runner. Never rename a value. */
export const UnrealRunnerChoice = { Lead: "lead" } as const;
export type UnrealRunnerChoice = (typeof UnrealRunnerChoice)[keyof typeof UnrealRunnerChoice];

/** The journal kind the Unreal runner writes (`kind: "unreal-lead"`): read here, never written. */
const UNREAL_RUNNER_JOURNAL = "unreal-lead";

/** What the switch decides from: the environment, the game, and on a resume the saved journal's kind. */
export interface UnrealRunnerAsk {
  env: Readonly<Record<string, string | undefined>>;
  game: FactsOfDescriptor | null | undefined;
  resume: boolean;
  /** The saved journal's `kind` on a resume (null: none, or one the one Loop wrote). */
  journalKind?: unknown;
}

/** Whether the environment names the Unreal runner. */
export function switchNamed(env: Readonly<Record<string, string | undefined>>): boolean {
  return env[UNREAL_RUNNER_ENV]?.trim() === UnrealRunnerChoice.Lead;
}

/**
 * Does the Unreal runner lead this run? Only when the switch names it, the game serves an Unreal
 * project, and, on a resume, the journal is the Unreal runner's own.
 */
export function unrealRunnerOn({ env, game, resume, journalKind }: UnrealRunnerAsk): boolean {
  if (!switchNamed(env) || !game) return false;
  if (!hasFact(servedFactsOf(game), CoreFact.UnrealProject)) return false;
  return !resume || journalKind === UNREAL_RUNNER_JOURNAL;
}
