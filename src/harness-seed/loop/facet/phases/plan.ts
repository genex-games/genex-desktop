/** What the round works on beside its checks: the move, and THE FIX. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { CheckOrigin, CheckWeight, renderMilestones, type Check, type Milestone } from "../../spec.ts";
import { checksFromDefects, craftForNewCheck } from "../../library.ts";
import { nextMove } from "../../replan.ts";
import { facetNotes } from "../../repo.ts";
import { RunEvent } from "../../run-events.ts";
import { MINUTE_MS } from "../../time.ts";
import { clip, CLIP_QUOTE } from "../../text.ts";
import type { AnyRecord } from "../../../types/harness.d.ts";
import type { FacetLoop, FacetRound } from "../state.ts";
import { isStopped, stoppedByUser } from "../flow.ts";
import type { RoundFlow } from "../flow.ts";
import { chooseMove, isNewOwnCamera, MoveSource, movesThisRound, type MoveChoice } from "../rules.ts";
import { isUnfilledOpenRung } from "../growth.ts";
import { rungsMetOnBoard } from "../round-judgement.ts";
import { FIX_STUCK_LOSSES } from "../policy.ts";
import { similarDefect } from "../defects.ts";
import { recordDecision } from "../record.ts";
import { movesInStage, stageOf } from "../stage.ts";
import { isBeyondScope } from "../../scope.ts";
import { askUserAboutBeyond, BEYOND_MESSAGE, recallAskedBeyond } from "../beyond.ts";
import { isBuildBlock } from "../build-block.ts";

/** The planner is asked for a move only with this much of the facet's clock left (or a slice of a short one). */
const PLANNER_MOVE_MIN_MS = 8 * MINUTE_MS;

/** The move (§5): the director's ladder always; else identity first, then the pending move, the reviewer's, the critic's gap or the planner's. */
export async function chooseRoundMove(loop: FacetLoop, round: FacetRound): Promise<RoundFlow> {
  const { hasTime, legacy, milestonesDone, policy, spec } = loop;
  // ── the move (§5): the director's ladder always; else identity first, then the planner ──
  loop.currentMove = null;
  // The round's stage is fixed here, once: a steer that lands while it builds takes effect from
  // the next round, never halfway through this one (facet/stage.ts roundStage).
  round.stage = stageOf(spec);
  // So is whether it is the worker's build block: one long first build, kept on the checks.
  round.buildBlock = isBuildBlock(loop, round);
  // A finishing worker takes no move of any kind — no rung, no reviewer's or critic's move, no
  // planner call: the judge's polish list and the defect ledger are its work (facet/stage.ts).
  if (!movesInStage(round)) return;
  if (legacy || !movesThisRound(spec, loop.board)) return;
  await climbMeasuredRungs(loop);
  const choice = chooseMove({
    spec,
    moves: loop.moves,
    milestonesDone: [...milestonesDone],
    setAside: [...loop.milestonesSetAside],
    polishStreak: loop.polishStreak,
    lastLiveness: loop.lastLiveness,
    lastBigMove: loop.lastBigMove,
    policy,
  });
  if (choice.beyond) await askUserAboutBeyond(loop, choice.beyond, BEYOND_MESSAGE.reviewer);
  // Each source names its move in its own field (rules.ts `MoveChoice`).
  if (choice.milestone) takeMilestone(loop, await rungToTake(loop, choice.milestone, choice));
  else if (choice.pending) takePendingMove(loop, choice.pending);
  else if (choice.bigMove) takeReviewerMove(loop, round, choice.bigMove);
  else if (choice.gap) takeCriticMove(loop, round, choice.gap);
  else if (choice.source === MoveSource.Planner && hasTime(PLANNER_MOVE_MIN_MS)) {
    const flow = await askPlannerForMove(loop, round);
    if (flow) return flow;
  }
  if (loop.currentMove) await announceMove(loop, round, choice.mandatory);
}

/** Rungs whose own check already passes on the accepted build are climbed, and the feed says so. */
async function climbMeasuredRungs(loop: FacetLoop): Promise<void> {
  const { facet, milestonesDone, spec } = loop;
  for (const id of rungsMetOnBoard(spec, loop.board, milestonesDone)) {
    milestonesDone.add(id);
    const what = (spec.milestones ?? []).find((m: AnyRecord) => m.id === id)?.what ?? id;
    await recordDecision(
      loop,
      `${facet.id}: "${clip(what, CLIP_QUOTE)}" is already measured on the accepted build — that rung is climbed`,
    );
  }
}

/**
 * The rung this round builds. An open rung the reviewers' step fills this round is written onto the
 * ladder — the next round builds the same step however the judge words its proposal then, and the
 * lead reads it in worker_status — and the feed says who filled it. Any other rung is taken as it is.
 */
async function rungToTake(loop: FacetLoop, rung: AnyRecord, choice: MoveChoice): Promise<AnyRecord> {
  const { facet, spec } = loop;
  const ladder: Milestone[] = spec.milestones ?? [];
  const stored = ladder.find((m) => m.id === rung.id && isUnfilledOpenRung(m));
  if (!stored || !rung.filledBy) return rung;
  const filled: Milestone = {
    ...stored,
    what: String(rung.what),
    filledBy: String(rung.filledBy),
    why: `the open rung of the lead's ladder — ${fillWhy(choice)}`,
  };
  spec.milestones = ladder.map((m) => (m.id === rung.id ? filled : m));
  await recordDecision(
    loop,
    `${facet.id}: the open rung of its ladder takes ${fillerWords(choice)} — "${clip(filled.what, CLIP_QUOTE)}" — mandatory, like the lead's rungs; steer another with worker_steer move= if it should not be`,
  );
  return filled;
}

/** Who filled an open rung, as the feed says it. */
function fillerWords(choice: MoveChoice): string {
  if (choice.bigMove) return "the reviewer's big move";
  return choice.gap?.key ? `the critic's ${choice.gap.key} fix` : "the critic's step";
}

/** Why the step that filled an open rung: the reviewer's words, or the critic's principle. */
function fillWhy(choice: MoveChoice): string {
  if (choice.bigMove) return reviewerWhy(choice.bigMove);
  return choice.gap ? criticWhy(choice.gap) : "the reviewers' step for this part";
}

/** The next rung of the ladder is this round's move. */
function takeMilestone(loop: FacetLoop, milestone: AnyRecord): void {
  loop.currentMove = {
    what: milestone.what,
    milestoneId: milestone.id,
    check: milestone.check ?? null,
    source: MoveSource.Milestone,
    ...(milestone.why ? { why: milestone.why } : {}),
  };
  seedMoveCheck(loop, milestone.check);
}

/**
 * A pending or critic-named move costs nothing — it is asked even on the facet's last iteration.
 * Only the planner's call is gated by the clock; gating the whole branch left every facet's final
 * round with no move at all.
 */
function takePendingMove(loop: FacetLoop, pending: AnyRecord): void {
  pending.attempts = (pending.attempts ?? 1) + 1;
  loop.currentMove = {
    what: pending.what,
    why: pending.why,
    milestoneId: null,
    check: pending.check ?? null,
    source: pending.source,
  };
}

/** Why the reviewer's big move: its own words, when it gave them. */
function reviewerWhy(bigMove: AnyRecord): string {
  return bigMove.why ? `the reviewer: ${bigMove.why}` : "the reviewer's big move for this part";
}

/** Why the critic's principle: its score and reason, and how many cards it has stood when it is stuck. */
function criticWhy(gap: AnyRecord): string {
  const stood = gap.stuck ? ` for ${gap.stuck} critic cards running` : "";
  return `${gap.key} scored ${gap.score}/3${stood}: ${gap.reason}`;
}

/** The taste judge named the one big move it sees for this facet: the worker builds it, as guidance. */
function takeReviewerMove(loop: FacetLoop, round: FacetRound, bigMove: AnyRecord): void {
  const why = reviewerWhy(bigMove);
  loop.moves.push({
    iteration: round.iteration,
    what: bigMove.what,
    why,
    check: null,
    source: MoveSource.Reviewer,
    delivered: false,
    attempts: 1,
  });
  loop.currentMove = { what: bigMove.what, why, milestoneId: null, check: null, source: MoveSource.Reviewer };
}

/** The critic saw the frames and named what is missing: that beats a planner guess. */
function takeCriticMove(loop: FacetLoop, round: FacetRound, gap: AnyRecord): void {
  const why = criticWhy(gap);
  loop.moves.push({
    iteration: round.iteration,
    what: gap.fix,
    why,
    check: null,
    source: MoveSource.Critic,
    principle: gap.key,
    delivered: false,
    attempts: 1,
  });
  loop.currentMove = {
    what: gap.fix,
    why,
    milestoneId: null,
    check: null,
    source: MoveSource.Critic,
    principle: gap.key,
  };
}

/** Ask the planner for a move of its own; a planner with nothing usable leaves the round without one. */
async function askPlannerForMove(loop: FacetLoop, round: FacetRound): Promise<RoundFlow> {
  const { ctx, facet, moves, run, spec, workdir } = loop;
  let proposed = null;
  try {
    const notesNow = workdir ? await readFile(path.join(workdir, facetNotes(facet.id)), "utf8").catch(() => "") : "";
    proposed = await nextMove(ctx, {
      run,
      spec,
      board: loop.board,
      defects: loop.defectList,
      notes: notesNow,
      moves,
      counts: loop.incumbentEvidence?.state?.counts ?? null,
      cameras: spec.cameras,
      // What was already put to the user is theirs to answer, never the planner's to propose again —
      // before this start of the part too (facet/beyond.ts).
      asked: await recallAskedBeyond(loop),
    });
  } catch (err: any) {
    if (isStopped(err, ctx)) return stoppedByUser(loop);
    proposed = null;
  }
  if (!proposed?.what) return;
  // A move that needs something the user did not ask for is their decision, never this round's move.
  if (isBeyondScope(proposed)) {
    await askUserAboutBeyond(loop, proposed, BEYOND_MESSAGE.planner);
    return;
  }
  const { what, why, check } = proposed;
  moves.push({
    iteration: round.iteration,
    what,
    why,
    check,
    source: MoveSource.Planner,
    delivered: false,
    attempts: 1,
  });
  loop.currentMove = { what, why, milestoneId: null, check, source: MoveSource.Planner };
  seedMoveCheck(loop, check);
}

/** A move's own check joins the board as a failing entry — the move is not built yet. */
function seedMoveCheck(loop: FacetLoop, check: Check | null | undefined): void {
  const { spec } = loop;
  if (!check || spec.checks.some((c) => c.id === check.id)) return;
  spec.checks.push({ ...check });
  const camera = check.camera;
  if (isNewOwnCamera(spec.cameras, camera)) spec.cameras.push(camera);
  loop.board[check.id] = {
    id: check.id,
    kind: check.kind,
    weight: check.weight ?? CheckWeight.Normal,
    pass: false,
    reason: "the move is not built yet",
    origin: CheckOrigin.Milestone,
  };
}

/**
 * The move, on the record. Whether missing it can undo the round (M3.3): a rung of the ladder
 * can, an invented one only after two accepted builds that polished instead of moving.
 * `escalated` says which of the two made it mandatory: the brief and the prompt say ESCALATE only
 * when polish did — never for a rung the director asked for, and never for guidance.
 */
async function announceMove(loop: FacetLoop, round: FacetRound, mandatory: boolean): Promise<void> {
  const { appendRun, facet, milestonesDone, policy, run, spec } = loop;
  const move = loop.currentMove;
  if (!move) return;
  move.mandatory = mandatory;
  move.ladder = renderMilestones(spec.milestones ?? [], { done: [...milestonesDone], current: move.milestoneId });
  move.polishStreak = loop.polishStreak;
  move.escalated = escalatedByPolish(move, loop.polishStreak, policy.polishStreakEscalate);
  await appendRun(RunEvent.FacetMove, {
    runId: run.runId,
    facetId: facet.id,
    facetTitle: facet.title,
    iteration: round.iteration,
    what: move.what,
    milestoneId: move.milestoneId,
    source: move.source,
    mandatory: move.mandatory,
    delivered: null,
    scale: null,
  });
}

/** Did a polish streak make this move mandatory (and not the director's ladder)? */
function escalatedByPolish(move: AnyRecord, polishStreak: number, threshold: number): boolean {
  if (move.mandatory !== true || move.source === MoveSource.Milestone) return false;
  return polishStreak >= threshold;
}

/** THE FIX: a biggest gap the judge has repeated, named on its own and measured by its own check. */
export async function nameTheFix(loop: FacetLoop, round: FacetRound): Promise<RoundFlow> {
  const { appendRun, emitLoopState, facet, policy, run } = loop;
  // ── THE FIX: a biggest gap the judge has repeated is not one ledger item among twenty ──
  // It is named in its own section, its vision check is on the board, and once it has stood
  // three verdicts a build that leaves it failing loses — the way a missing move loses.
  loop.currentFix = null;
  const gap = loop.gapStreak;
  if (gap && fixIsDue(loop, gap)) {
    const check = fixCheckFor(loop, gap);
    if (check) gap.checkId = check.id;
    const fix: AnyRecord = {
      what: gap.text,
      checkId: check?.id ?? null,
      streak: gap.count,
      mandatory: gap.count >= policy.fixLosesAfter,
      losses: gap.losses ?? 0,
      recipe: null,
    };
    // The craft library retrieved from the defect's own words (M4.7): a repeated gap the
    // library already knows how to close is named in THE FIX and injected below, so the
    // builder ports it instead of inventing a fourth way.
    const fixCheck = checksFromDefects([gap.text], { limit: 1 })[0] ?? null;
    // Only a recipe for this kind of game: THE FIX's recipe keeps its sketch inline in BRIEF.md.
    const kind = typeof loop.game?.kind === "string" ? loop.game.kind : null;
    fix.recipe = fixCheck ? (craftForNewCheck(loop.recipes, fixCheck, { kind })[0]?.recipe ?? null) : null;
    loop.currentFix = fix;
    await appendRun(RunEvent.FacetFix, {
      runId: run.runId,
      facetId: facet.id,
      facetTitle: facet.title,
      iteration: round.iteration,
      what: fix.what,
      checkId: fix.checkId,
      streak: fix.streak,
      mandatory: fix.mandatory,
      delivered: null,
    });
  }
  // Every round reports that it started, whether or not it carries a fix — inside the block
  // above only a round with a repeated gap would say anything, and a worker that never
  // repeats a gap would never report a round at all.
  emitLoopState("building", round.iteration);
}

/** Has the judge named the same gap often enough to make it THE FIX — and not so often, unfixed, that it went to the planner? */
function fixIsDue({ legacy, policy }: FacetLoop, gap: AnyRecord): boolean {
  if (legacy || gap.routed) return false;
  return gap.count >= policy.fixAfterSameGap && (gap.losses ?? 0) < FIX_STUCK_LOSSES;
}

/** The check that measures the gap: the one it was given before, else a judge-grown check about the same defect. */
function fixCheckFor({ spec }: FacetLoop, gap: AnyRecord): Check | null {
  const named = spec.checks.find((c) => c.id === gap.checkId);
  if (named) return named;
  const grown = spec.checks.find(
    (c) => c.origin === CheckOrigin.Judge && c.defect && similarDefect(c.defect, gap.text),
  );
  return grown ?? null;
}
