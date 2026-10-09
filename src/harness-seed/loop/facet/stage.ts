/**
 * The facet's stage: a worker either BUILDS —
 * bold structural moves, a ladder, polish that only escalates — or FINISHES what exists, where
 * polish is the work and wins on the judge's blind preference. The stage lives on the spec
 * (`spec.stage`), like `moveOwner`: a director sets it with `worker_start stage=` and flips it
 * live with `worker_steer stage=`, and the loop reads it at the top of every round.
 *
 * A new module on purpose: a workspace that kept an older, agent-edited rules.ts, policy.ts or
 * judge.ts still loads, because only updated callers import from here. A missing or unknown
 * stage is the build stage, so old journals and specs behave exactly as they always did.
 */
import { MoveOwner } from "../spec.ts";

/** The two stages of a worker's work. Journals keep it: never rename a value. */
export const FacetStage = {
  Build: "build",
  Finish: "finish",
} as const;
export type FacetStage = (typeof FacetStage)[keyof typeof FacetStage];

/** The polish notes a finish-stage judge keeps and a finish-stage brief lists: they are the work now. */
export const FINISH_POLISH_NOTES = 8;

/** How much of an unknown stage a refusal quotes. */
const QUOTED_STAGE_CHARS = 40;

/** The polish streak the brief and prompt said ESCALATE at before a move carried `escalated`. */
const UNSTAMPED_ESCALATE_STREAK = 2;

/** What a stage is read from: a spec, or anything carrying `stage`. */
type Staged = { stage?: unknown; moveOwner?: unknown; [field: string]: unknown } | null | undefined;

/** The spec's stage: finish only when it says exactly that; anything else is the build stage. */
export function stageOf(spec: Staged): FacetStage {
  return spec?.stage === FacetStage.Finish ? FacetStage.Finish : FacetStage.Build;
}

/**
 * The stage a round runs in: fixed once, when its move is chosen (`chooseRoundMove` stamps
 * `round.stage`), so a `worker_steer stage=` that lands while the builder works takes effect from
 * the next round — the round in flight is judged, gated, settled and exited in the stage it was
 * briefed in. A round that has no stamp yet reads the spec.
 */
export function roundStage(round: Staged, spec: Staged): FacetStage {
  return Object.values(FacetStage).find((s) => s === round?.stage) ?? stageOf(spec);
}

/**
 * Did a polish streak make this move mandatory? `escalated`, when the move carries it (stamped by
 * announceMove). A workspace that kept an older plan.ts stamps none, so it is read off what that
 * one did stamp: mandatory, not a rung of the director's ladder, and two polished builds behind it.
 */
export function moveEscalated(move: Staged): boolean {
  if (typeof move?.escalated === "boolean") return move.escalated;
  const rung = Boolean(move?.milestoneId);
  return move?.mandatory === true && !rung && Number(move?.polishStreak) >= UNSTAMPED_ESCALATE_STREAK;
}

/** Is this worker finishing what exists? */
export const isFinishing = (spec: Staged): boolean => stageOf(spec) === FacetStage.Finish;

/** May this round take a move at all? Never in the finish stage: no rung, no invented, reviewer or critic move. */
export const movesInStage = (spec: Staged): boolean => !isFinishing(spec);

/** Does an accepted polish-only build count toward the polish streak? Not in the finish stage, where polish is the job. */
export const polishCountsInStage = (spec: Staged): boolean => !isFinishing(spec);

/**
 * Can a polish streak make the next move mandatory? Only in the build stage of a worker whose
 * ladder nobody owns: a director-owned worker past its ladder is handed the reviewer's move as
 * guidance, never as a mandate, so telling it "a build without the move loses" would be false.
 */
export const polishEscalates = (spec: Staged): boolean =>
  polishCountsInStage(spec) && spec?.moveOwner !== MoveOwner.Director;

/**
 * Is a finish-stage worker done? The judge preferred its build, the build runs and every identity
 * check holds: the polish is in, so the worker ends. The strict `satisfied` the build stage waits
 * for is not required — a finisher's contract is "better, and nothing broken". Returns the
 * sentence for `stoppedBecause`, or null while there is still work to do.
 */
export function finishDone({
  won,
  broken = false,
  summary = null,
}: {
  won: unknown;
  broken?: boolean;
  summary?: { identityAllPass?: boolean } | null;
}): string | null {
  const done = Boolean(won) && !broken && summary?.identityAllPass === true;
  return done ? "the finish is in: the judge preferred the polished build and every identity check holds" : null;
}

/**
 * Was nothing at all redrawn? The finish stage's invisible-diff gate. Fine polish at the judge's
 * window size can sit under the build stage's "no visible change" fraction and be refused before
 * any judge looks; a finish round is refused unseen only when every compared camera is
 * pixel-identical to the accepted build.
 */
export function isZeroDiff(
  diffs: Record<string, { diffFraction?: unknown; compared?: unknown } | null | undefined> | null | undefined,
): boolean {
  const compared = Object.values(diffs ?? {}).filter(
    (d) => typeof d?.diffFraction === "number" && typeof d?.compared === "number" && d.compared > 0,
  );
  return compared.length > 0 && compared.every((d) => d?.diffFraction === 0);
}

/**
 * A stage a director typed: absent is no change (null), a known one is that stage, anything else
 * is refused by name. A finish stage with a move or a ladder is a contradiction and refused too.
 */
export function stageArg(
  value: unknown,
  { move = "", milestones = null }: { move?: unknown; milestones?: unknown } = {},
): { stage: FacetStage | null; error?: undefined } | { error: string } {
  const typed = String(value ?? "").trim();
  if (!typed) return { stage: null };
  const stage = Object.values(FacetStage).find((s) => s === typed);
  if (!stage)
    return {
      error: `stage: "${typed.slice(0, QUOTED_STAGE_CHARS)}" is not a stage (${Object.values(FacetStage).join(", ")})`,
    };
  const asksForMoves = String(move ?? "").trim() !== "" || String(milestones ?? "").trim() !== "";
  if (stage === FacetStage.Finish && asksForMoves)
    return {
      error:
        "stage=finish and move=/milestones= contradict: a finishing worker builds no move — polish is its work. Drop one",
    };
  return { stage };
}
