/**
 * How the Builds panel marks a try and says how a run ended. The words come from words.ts; this
 * is which glyph and ink each status wears, so a stopped or unjudged try reads grey and never as
 * broken (tests/conformance/stopped-round.test.ts, tests/conformance/words.test.ts).
 */
import type { IconName } from "./ui/icons.tsx";
import { type IterationNode, IterationStatus, type RunGraph } from "./run-graph.ts";
import { WorkerStopCode } from "../shared/workers.ts";
import { stoppedWords } from "./words.ts";

/** The mark a try wears in a step's row of tries: its glyph and the ink it is drawn in. */
export const TRY_GLYPH: Record<IterationNode["status"], { icon: IconName | null; color: string }> = {
  accepted: { icon: "check", color: "var(--green)" },
  rolled: { icon: "undo", color: "var(--red)" },
  stopped: { icon: "stop", color: "var(--ink-3)" },
  unjudged: { icon: "stop", color: "var(--ink-3)" },
  abandoned: { icon: "stop", color: "var(--ink-3)" },
  building: { icon: null, color: "var(--accent)" },
};

/** What a try's button says it is, after "Try n:". */
export const TRY_WORD: Record<IterationNode["status"], string> = {
  accepted: "kept",
  rolled: "undone",
  stopped: "stopped by the lead",
  unjudged: "no verdict recorded",
  abandoned: "not reviewed",
  building: "in hand",
};

/** A try stopped by the run's own close (its pause or end), as its button says it: nobody's decision. */
const STOPPED_BY_RUN_CLOSE = "stopped when the build paused or ended";

/** What a try's button says it is, after "Try n:": a stop by the run's close is not the lead's. */
export function tryWord(node: Pick<IterationNode, "status" | "stopCode">): string {
  const byRunClose = node.status === IterationStatus.Stopped && node.stopCode === WorkerStopCode.RunEnded;
  return byRunClose ? STOPPED_BY_RUN_CLOSE : TRY_WORD[node.status];
}

/**
 * The result panel's "Ended because …" line for a finished run with a recorded reason, or null.
 * The recorded stop reason is read through stoppedWords like every other one: the harness's own
 * sentence never reaches the screen.
 */
export function endedWords(graph: Pick<RunGraph, "active" | "summary">): string | null {
  if (graph.active || !graph.summary?.reason) return null;
  return `Ended because ${stoppedWords(graph.summary.reason)}.`;
}
