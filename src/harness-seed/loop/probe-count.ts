/**
 * How many hands-on probes a run has spent (vision-escalation.ts), counted on the run and carried
 * into its journal: a Resume starts the run from the journal's copy of it, so the cap holds across
 * a harness restart instead of starting over.
 *
 * A new module, dependency-free: the director's and autopilot's journal saves reach it, and a
 * kept older copy of either simply never carries the count.
 */
import type { AnyRecord, Run } from "../types/harness.d.ts";

/** The field of the run (and of the journal's copy of it) that counts the probes it spent. */
const PROBES_FIELD = "handsOnProbes";

/** How many probes this run has spent. */
export function probesSpent(run: Run | AnyRecord | null | undefined): number {
  const spent = Number(run?.[PROBES_FIELD]);
  return Number.isFinite(spent) && spent > 0 ? spent : 0;
}

/** Count one more probe on the run. */
export function spendProbe(run: Run | AnyRecord): void {
  run[PROBES_FIELD] = probesSpent(run) + 1;
}

/** Carry the run's count onto the journal's copy of the run, before the journal is saved. */
export function journalProbes(journal: AnyRecord | null | undefined, run: Run | AnyRecord | null | undefined): void {
  const journalRun = journal?.run;
  const spent = probesSpent(run);
  if (!journalRun || typeof journalRun !== "object" || spent === 0) return;
  journalRun[PROBES_FIELD] = Math.max(spent, probesSpent(journalRun));
}
