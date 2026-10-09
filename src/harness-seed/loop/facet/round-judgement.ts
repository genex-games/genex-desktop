/**
 * What a judged round may claim, beside the acceptance rule (rules.ts): a rung of the director's
 * ladder already built or set aside, a regression a second look reproduces, a gap a judge named.
 * Without them a worker loses round after round to a rung it built long ago, a round to a probe
 * that sampled one frame, and a vision judge is asked whether "regressed play-loop" is gone. A module of its own, so a workspace that kept an
 * older rules.ts or policy.ts still loads the parts that read these names.
 */
import { CheckKind } from "../spec.ts";
import { VerdictSource } from "../verdict.ts";
import type { AnyRecord } from "../../types/harness.d.ts";

/** A rung of the director's ladder missed by this many judged rounds is set aside, and the ladder moves on. */
export const RUNG_MISSES = 3;

/** The kinds a second look at the same build can score again: checks that measure themselves, not a playtest (a whole session). */
const REMEASURED_KINDS: readonly string[] = [
  CheckKind.Scene,
  CheckKind.Pixel,
  CheckKind.Metric,
  CheckKind.Probe,
  CheckKind.Demo,
];

/**
 * The rungs whose own check already passes on the accepted build: built, whatever round built
 * them, so the ladder climbs them before the round picks its move instead of asking for them again.
 */
export function rungsMetOnBoard(
  spec: { milestones?: AnyRecord[] } | null | undefined,
  board: Record<string, { pass?: boolean | null } | undefined> | null | undefined,
  climbed: Iterable<string>,
): string[] {
  const done = new Set(climbed);
  return (spec?.milestones ?? [])
    .filter((m) => !done.has(m.id) && m.check?.id && board?.[m.check.id]?.pass === true)
    .map((m) => m.id);
}

/**
 * One more judged round that missed this rung. At `RUNG_MISSES` it is set aside: the ladder moves
 * on, and the director reads why and may steer it back.
 */
export function countRungMiss(
  misses: Readonly<Record<string, number>>,
  id: string,
): { misses: Record<string, number>; setAside: boolean } {
  const count = (misses[id] ?? 0) + 1;
  return { misses: { ...misses, [id]: count }, setAside: count >= RUNG_MISSES };
}

/** The regressions a second look at the same build can score again. */
export function remeasurable(
  regressions: readonly string[],
  board: Record<string, { kind?: string } | undefined> | null | undefined,
): string[] {
  return regressions.filter((id) => REMEASURED_KINDS.includes(board?.[id]?.kind ?? ""));
}

/**
 * The regressions a second look at the same build did not reproduce: they passed this time, so
 * the first look caught a frame, not a build. A probe that samples one frame of moving AI fails
 * on whichever frame catches a dead ball; the builder then tunes the game to keep the probe green.
 */
export function noisyRegressions(
  regressed: readonly string[],
  remeasured: Record<string, { pass?: boolean | null } | undefined> | null | undefined,
): string[] {
  return regressed.filter((id) => remeasured?.[id]?.pass === true);
}

/**
 * The biggest gap a judge named this round, or null when the verdict came from something else —
 * a regression, an invisible diff, a broken build, an outage — whose "gap" is the harness's own
 * words. Only a judge's gap grows a picture question or counts toward THE FIX.
 */
export function judgedGap(round: AnyRecord): string | null {
  const byJudge = Boolean(round.taste) || round.verdictSource === VerdictSource.Legacy;
  return byJudge ? round.verdict?.biggest_gap || null : null;
}
