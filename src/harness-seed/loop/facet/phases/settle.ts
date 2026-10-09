/** What the round settles for the next one: the move's fate, the gap streak and THE FIX's, the defect ledger and the lose streak. */
import { ChangeScale } from "../../judge.ts";
import { CheckOrigin } from "../../spec.ts";
import { RunEvent } from "../../run-events.ts";
import type { AnyRecord } from "../../../types/harness.d.ts";
import type { FacetLoop, FacetRound } from "../state.ts";
import type { RoundFlow } from "../flow.ts";
import { MoveSource, moveVerdict } from "../rules.ts";
import { countRungMiss, judgedGap, RUNG_MISSES } from "../round-judgement.ts";
import { VerdictSource } from "../../verdict.ts";
import { similarDefect } from "../defects.ts";
import { FIX_STUCK_LOSSES } from "../policy.ts";
import { recordDecision } from "../record.ts";
import { ReplanSource } from "./replans.ts";
import { CLIP_QUOTE } from "../../text.ts";
import { FINISH_POLISH_NOTES, polishCountsInStage, polishEscalates, roundStage } from "../stage.ts";
import { carryFixesOver } from "../carried-fixes.ts";

/** The judge's biggest gaps a brief remembers, newest first. */
const MAX_GAP_HISTORY = 4;
/** The longest the defect ledger grows. */
const MAX_DEFECTS = 24;
/** How much of a landed fix the lesson that records it quotes. */
const FIX_QUOTED_CHARS = 100;

/** The move's fate, the gap streak and THE FIX's, the defect ledger and the lose streak. */
export async function settleMoveAndGap(loop: FacetLoop, round: FacetRound): Promise<RoundFlow> {
  await settleMove(loop, round);
  await warnPolishStreak(loop, round);
  if (round.challengerBroken) {
    loop.lastFailure = round.brokenDetail ?? round.verdict.biggest_gap ?? null;
    return;
  }
  // A partial build that was evaluated is a verdict, not a failure report.
  loop.lastFailure = null;
  rememberGap(loop, round);
  // The streak: one meaning, however the judge words it this time.
  const fixed = judgeTheFix(loop, round);
  countGapStreak(loop, round, fixed);
  if (loop.currentFix) await settleTheFix(loop, round, loop.currentFix, fixed);
  updateDefectLedger(loop, round);
  // An undone round's demonstrated fixes ride into every next brief until the accepted build has them.
  loop.carriedFixes = carryFixesOver(loop.carriedFixes, { round, spec: loop.spec, board: loop.board });
  loop.loseStreak = round.won ? 0 : loop.loseStreak + 1;
}

/** The move's fate (§5): delivered → the milestone is climbed; polish → the streak grows. */
async function settleMove(loop: FacetLoop, round: FacetRound): Promise<void> {
  const { appendRun, facet, run } = loop;
  round.moveRecord = null;
  const move = loop.currentMove;
  const structural = round.taste?.scale === ChangeScale.Structural;
  if (!move?.what || round.challengerBroken) {
    // A finishing worker's won round is polish on purpose: it clears the streak, so a later steer
    // back to the build stage does not inherit one.
    const landed = structural || !polishCountsInStage({ stage: roundStage(round, loop.spec) });
    if (round.won && !round.challengerBroken && landed) loop.polishStreak = 0;
    return;
  }
  const fate = moveVerdict({ move, board: round.attemptBoard, taste: round.taste, won: round.won });
  const delivered = fate.delivered;
  // The note is the whole point of demoting a miss: the round stands, and the director
  // reads what was asked for and did not arrive instead of a build that was thrown away.
  round.moveRecord = {
    what: move.what,
    milestoneId: move.milestoneId,
    source: move.source,
    mandatory: move.mandatory === true,
    delivered,
    scale: round.taste?.scale ?? null,
    note: fate.note,
  };
  if (delivered) markDelivered(loop, move);
  else if (delivered === false && move.source === MoveSource.Milestone) await missRung(loop, move);
  if (round.won) loop.polishStreak = delivered || structural ? 0 : loop.polishStreak + 1;
  await appendRun(RunEvent.FacetMove, {
    runId: run.runId,
    facetId: facet.id,
    facetTitle: facet.title,
    iteration: round.iteration,
    what: move.what,
    milestoneId: move.milestoneId,
    source: move.source,
    mandatory: move.mandatory === true,
    delivered,
    scale: round.taste?.scale ?? null,
    won: round.won,
  });
}

/** A delivered move climbs its rung of the ladder, and the harness's own move of the same words is marked delivered. */
function markDelivered({ milestonesDone, moves }: FacetLoop, move: AnyRecord): void {
  if (move.milestoneId) milestonesDone.add(move.milestoneId);
  if (move.source === MoveSource.Milestone) return;
  const named = [...moves].reverse().find((m) => m.what === move.what);
  if (named) named.delivered = true;
}

/** One more judged round that missed this rung; enough of them and it is set aside, and the feed says why. */
async function missRung(loop: FacetLoop, move: AnyRecord): Promise<void> {
  const { facet } = loop;
  if (!move.milestoneId) return;
  const counted = countRungMiss(loop.rungMisses, move.milestoneId);
  loop.rungMisses = counted.misses;
  if (!counted.setAside) return;
  loop.milestonesSetAside.add(move.milestoneId);
  await recordDecision(
    loop,
    `${facet.id}: the rung "${String(move.what).slice(0, CLIP_QUOTE)}" missed ${RUNG_MISSES} judged rounds — set aside, and the ladder moves on; steer it back with worker_steer move= if it still matters`,
  );
}

/**
 * Polish, build after build, while a move stood undelivered: the next brief escalates, and says so
 * — only where it really will. A director-owned worker past its ladder gets guidance, never a
 * mandate, and a finishing worker takes no move at all; telling either "a build without it loses"
 * was false.
 */
async function warnPolishStreak(loop: FacetLoop, round: FacetRound): Promise<void> {
  const { facet, policy } = loop;
  if (!polishEscalates(loop.spec)) return;
  const escalates = loop.polishStreak >= policy.polishStreakEscalate;
  if (!escalates || !round.moveRecord) return;
  if (round.moveRecord.delivered) return;
  await recordDecision(
    loop,
    `${facet.id} has polished for ${loop.polishStreak} accepted builds in a row — the next brief escalates: the move is mandatory and a build without it loses`,
  );
}

/** A new biggest gap joins the brief's history; the judge's word stands as the gap until it names another. */
function rememberGap(loop: FacetLoop, round: FacetRound): void {
  const { gapHistory } = loop;
  const gap = round.verdict.biggest_gap;
  if (gap && gap !== loop.biggestGap) {
    gapHistory.unshift({ iteration: round.iteration, gap, won: round.won });
    if (gapHistory.length > MAX_GAP_HISTORY) gapHistory.pop();
  }
  loop.biggestGap = gap || loop.biggestGap;
}

/**
 * Did the round close THE FIX? Measured by its own check when it has one, else by the judge no
 * longer naming it; a lost round fixed nothing. Null when the round carried no fix.
 */
function judgeTheFix(loop: FacetLoop, round: FacetRound): boolean | null {
  loop.fixedForRecord = null;
  const fix = loop.currentFix;
  if (!fix) return null;
  const entry = fix.checkId ? (round.attemptBoard[fix.checkId] ?? loop.board[fix.checkId]) : null;
  const gap = round.verdict.biggest_gap;
  const closed = entry ? entry.pass === true : Boolean(gap) && !similarDefect(gap, fix.what);
  const fixed = round.won ? closed : false;
  loop.fixedForRecord = fixed;
  return fixed;
}

/** The judge's biggest gap, counted: the same gap again grows the streak, a new one starts it over. */
function countGapStreak(loop: FacetLoop, round: FacetRound, fixed: boolean | null): void {
  const gap = judgedGap(round);
  const fixLanded = loop.currentFix && fixed;
  if (!gap || fixLanded) return;
  const streak = loop.gapStreak;
  if (streak && similarDefect(streak.text, gap)) {
    streak.count += 1;
    streak.text = gap;
  } else loop.gapStreak = { text: gap, count: 1, checkId: null, losses: 0, routed: false };
  // A gap this round routed to another facet is that facet's now: it never becomes THE FIX here.
  if (round.gapRouted && loop.gapStreak) loop.gapStreak.routed = true;
}

/** THE FIX's fate: closed, or one more loss — and a fix that keeps losing goes to the planner instead. */
async function settleTheFix(loop: FacetLoop, round: FacetRound, fix: AnyRecord, fixed: boolean | null): Promise<void> {
  const { appendRun, facet, run } = loop;
  if (fixed) {
    await recordDecision(
      loop,
      `${facet.id} fixed what the judge had named ${fix.streak} times: "${String(fix.what).slice(0, FIX_QUOTED_CHARS)}"`,
    );
    loop.gapStreak = null;
  } else if (loop.gapStreak) {
    await countFixLoss(loop, round, fix, loop.gapStreak);
  }
  await appendRun(RunEvent.FacetFix, {
    runId: run.runId,
    facetId: facet.id,
    facetTitle: facet.title,
    iteration: round.iteration,
    what: fix.what,
    checkId: fix.checkId,
    streak: fix.streak,
    mandatory: fix.mandatory,
    delivered: fixed,
    won: round.won,
    verdictSource: round.verdictSource,
  });
}

/** A round lost to the fix it left counts against the fix; enough of them and the planner takes the check. */
async function countFixLoss(loop: FacetLoop, round: FacetRound, fix: AnyRecord, streak: AnyRecord): Promise<void> {
  const { facet, spec } = loop;
  if (round.verdictSource === VerdictSource.Unfixed) streak.losses = (streak.losses ?? 0) + 1;
  if ((streak.losses ?? 0) < FIX_STUCK_LOSSES) return;
  const why = `the fix "${String(fix.what).slice(0, CLIP_QUOTE)}" lost ${streak.losses} builds in a row — the builder cannot land it as asked`;
  const plannerMayTake = fix.checkId && spec.checks.find((c) => c.id === fix.checkId)?.origin !== CheckOrigin.Harness;
  if (plannerMayTake) loop.replanRequests.push({ checkId: fix.checkId, reason: why, source: ReplanSource.FixStuck });
  await recordDecision(
    loop,
    `${facet.id}: ${why}; the check goes to the planner (a recipe, another camera, or a spike) and the fix is no longer mandatory`,
  );
}

/**
 * The judge's defects and the notes no camera can answer, in one ledger for the next brief; its
 * polish notes and its big move beside it. The critic's polish fixes do not pad the ledger: a
 * ledger of nits has the builders spend their rounds on them.
 */
function updateDefectLedger(loop: FacetLoop, round: FacetRound): void {
  if (round.verdict.defects?.length) loop.defectList = round.verdict.defects;
  if (round.taste) {
    const polish = round.taste.polish ?? [];
    // A finishing worker's polish list is its work: the judge's eight, not the build stage's three.
    const counts = polishCountsInStage({ stage: roundStage(round, loop.spec) });
    loop.polishList = counts ? polish : polish.slice(0, FINISH_POLISH_NOTES);
    if (round.taste.bigMove) loop.lastBigMove = round.taste.bigMove;
  }
  // A defect no camera can answer keeps its place in the ledger, with the expression that
  // would measure it — the builder can then write the probe check the board is missing.
  for (const note of round.defectNotes) {
    const line = note.suggestedProbe
      ? `${note.text} → not visible in a frame; make it measurable with a probe check on \`${note.suggestedProbe}\``
      : `${note.text} → not visible in a frame`;
    if (!loop.defectList.some((d) => similarDefect(d, note.text)))
      loop.defectList = [...loop.defectList, line].slice(0, MAX_DEFECTS);
    else loop.defectList = loop.defectList.map((d) => (similarDefect(d, note.text) ? line : d));
  }
}
