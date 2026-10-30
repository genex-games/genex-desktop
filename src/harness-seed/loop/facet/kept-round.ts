/**
 * A round's verdict once its board has spoken (Loop phase 4): nobody judges it. The board refuses
 * what got worse before this (phases/verify.ts `decideOnBoard`: a broken build, a check that passed
 * on the accepted build and now fails, a camera or demo another part depends on), so a round that
 * reaches here is kept — on its strong flips, or on nothing having regressed. A move or THE FIX
 * with a check of its own is measured by it; one with none is the builder's to say it built. A
 * judge's look is the lead's to ask for (the director's `judge`), never a round's. A module of its
 * own, so a kept older taste.ts or verify.ts never shadows these names.
 */
import { Side } from "../judge.ts";
import { isInvisibleDiff } from "../checks.ts";
import { VerdictSource } from "../verdict.ts";
import type { FacetLoop, FacetRound } from "./state.ts";
import { moveVerdict, strongFlips } from "./rules.ts";
import { keptByBlock } from "./build-block.ts";
import { blockReason } from "./build-block-prompts.ts";
import { FacetStage, isZeroDiff, roundStage } from "./stage.ts";
import { isUnfilledOpenRung } from "./growth.ts";
import { CheckOrigin, CheckWeight } from "../spec.ts";
import type { AnyRecord } from "../../types/harness.d.ts";

/** How much of the move a kept round's reason quotes. */
const MOVE_QUOTED = 120;
/** How much of THE FIX a kept round's reason quotes. */
const FIX_QUOTED = 160;

/** What a kept round's reason is made of. */
const KEPT_WORDS = {
  kept: "nothing that worked before stopped working",
  unseen: "no visible change and nothing regressed — kept",
  noCheckMoved: "no check moved",
  onlyGrown: (flips: readonly string[]) => `only the judge's own notes flipped (${flips.join(", ")})`,
  strong: (strong: readonly string[]) => `checks accepted (${strong.join(", ")})`,
  moveLanded: " and the move's own check passes",
  moveTaken: " and the move is taken as built (no check measures it)",
  moveOwed: (what: string) => `; the move's own check does not pass yet and the move stays owed: ${what}`,
  fixOwed: (reason: string, fix: string) => `${reason}; the fix's own check still fails — the fix stays owed: ${fix}`,
} as const;

/**
 * Keep the round on its board, with no judge call: the verdict, its source (a strong flip, or
 * nothing regressed) and the reason, the move's word and THE FIX's.
 */
export function keepOnBoard(loop: FacetLoop, round: FacetRound): void {
  const flips: string[] = round.comparison?.flips ?? [];
  const strong = round.buildBlock
    ? keptByBlock(loop.spec, round.nextBoard, round.comparison).strong
    : strongFlips(loop.spec, round.nextBoard, flips);
  round.taste = null;
  round.verdictSource = round.buildBlock || strong.length ? VerdictSource.Checks : VerdictSource.NoRegression;
  round.verdict = {
    pick: Side.Challenger,
    satisfied: false,
    biggest_gap: loop.biggestGap ?? "",
    reason: round.buildBlock ? blockReason(strong) : keptReason(loop, round, strong),
    defects: [],
  };
  holdTheFix(loop, round);
}

/** Why the round was kept, in the order the board decided it, and what became of its move. */
function keptReason(loop: FacetLoop, round: FacetRound, strong: readonly string[]): string {
  const flips: string[] = round.comparison?.flips ?? [];
  const move = moveWords(loop, round);
  if (strong.length) return `${KEPT_WORDS.strong(strong)}; ${KEPT_WORDS.kept}${move}`;
  if (flips.length) return `${KEPT_WORDS.onlyGrown(flips)}; kept: ${KEPT_WORDS.kept}${move}`;
  if (unseen(loop, round)) return `${KEPT_WORDS.unseen}${move}`;
  return `${KEPT_WORDS.noCheckMoved}; kept: ${KEPT_WORDS.kept}${move}`;
}

/** Did no camera see the round change? A finishing round's polish counts unless nothing at all was redrawn. */
function unseen(loop: FacetLoop, round: FacetRound): boolean {
  const finishing = roundStage(round, loop.spec) === FacetStage.Finish;
  return finishing ? isZeroDiff(round.diffs) : isInvisibleDiff(round.diffs);
}

/** What a kept round says about its move: its check passes, it is taken as built, or its check says it is still owed. */
function moveWords(loop: FacetLoop, round: FacetRound): string {
  const what = loop.currentMove?.what;
  if (!what) return "";
  const fate = moveVerdict({ move: loop.currentMove, board: round.nextBoard, won: true });
  if (fate.missing) return KEPT_WORDS.moveOwed(String(what).slice(0, MOVE_QUOTED));
  return fate.measured ? KEPT_WORDS.moveLanded : KEPT_WORDS.moveTaken;
}

/**
 * A mandatory fix with a check of its own that still fails stays owed, and the round counts against
 * it (settle.ts `countFixLoss`), so a fix the builder keeps leaving goes to the planner. A fix no
 * check measures is the builder's to say it made.
 */
function holdTheFix(loop: FacetLoop, round: FacetRound): void {
  const fix = loop.currentFix;
  if (!fix?.mandatory || !fix.checkId) return;
  if (round.nextBoard?.[fix.checkId]?.pass !== false) return;
  round.fixLeft = true;
  round.verdict = {
    ...round.verdict,
    biggest_gap: fix.what,
    reason: KEPT_WORDS.fixOwed(round.verdict.reason, String(fix.what).slice(0, FIX_QUOTED)),
  };
}

/**
 * Does the director's ladder still have a rung for this worker to build? Every rung not climbed and
 * not set aside, except an open rung nobody filled (it is passed over: no reviewer fills it now).
 */
export function ladderHasRungsLeft(
  spec: { milestones?: AnyRecord[] } | null | undefined,
  climbed: Iterable<string> | null | undefined,
  setAside: Iterable<string> | null | undefined,
): boolean {
  const passed = new Set([...(climbed ?? []), ...(setAside ?? [])]);
  return (spec?.milestones ?? []).some((rung) => !passed.has(rung.id) && !isUnfilledOpenRung(rung));
}

/** Who names a ship defect on a board (director/art-direction.ts): the art director, never a worker. */
const ART_DIRECTOR = "art-director";

/**
 * A spec from before Loop phase 4, as a facet loop opens it (a resumed run, a worker restarted from
 * an older plan): the questions a judge grew for itself leave the board, since no judge asks them any
 * more, and the art director's questions stay as normal-weight checks that inform, never as part of
 * the part's own contract. Changed in place: the director reads the same spec object live.
 */
export function withoutJudgesHold(spec: { checks?: AnyRecord[] } | null | undefined): void {
  if (!spec || !Array.isArray(spec.checks)) return;
  spec.checks = spec.checks
    .filter((check) => check?.origin !== CheckOrigin.Judge)
    .map((check) => (check?.askedBy === ART_DIRECTOR ? { ...check, weight: CheckWeight.Normal } : check));
}
