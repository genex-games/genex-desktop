/** What the round teaches the board: the liveness critic, and the defects that become checks. */
import { livenessCritique } from "../../judge.ts";
import { summarizeScoreboard } from "../../checks.ts";
import { CheckKind, CheckOrigin, type Check } from "../../spec.ts";
import { RunEvent } from "../../run-events.ts";
import type { AnyRecord } from "../../../types/harness.d.ts";
import type { FacetLoop, FacetRound } from "../state.ts";
import { isStopped, stoppedByUser } from "../flow.ts";
import type { RoundFlow } from "../flow.ts";
import { isNewOwnCamera, judgeChecksToRetire, RetireReason } from "../rules.ts";
import { judgedGap } from "../round-judgement.ts";
import { defectClass, defectsToChecks, similarDefect } from "../defects.ts";
import { roundFields } from "../record.ts";
import { askUserAboutBeyond, BEYOND_MESSAGE } from "../beyond.ts";
import { countPrincipleStreaks, withStuckPrinciples } from "../growth.ts";

/** The harness's eyes the liveness critic looks through beside the facet's own cameras. */
const LIVENESS_EYES = ["eye:spawn", "eye:here"];
/** The retired and blocked defects a spec remembers, newest last. */
const MAX_REMEMBERED_DEFECTS = 24;

/** The liveness critic: why the better build does not feel like a real place yet. */
export async function critiqueLiveness(loop: FacetLoop, round: FacetRound): Promise<RoundFlow> {
  const { appendRun, critic, ctx, facet, legacy, run, spec } = loop;
  // ── the liveness critic: why the better build does not feel like a real place yet ──
  // One call per judged iteration on the build that stands after it. Grow gaps become the
  // next moves, polish gaps join the ledger; the score is on the record so a run can be read
  // as "alive 9/24 → 17/24" and not only as checks passed.
  round.liveness = null;
  // The clock does not gate it: the run that motivated it lost the critic on every facet's
  // last round, exactly where "what is still wrong" mattered most.
  if (legacy || round.challengerBroken || ctx.cancelled) return;
  const judged = round.won ? round.evidence : loop.incumbentEvidence;
  if (!judged?.shots?.length) return;
  try {
    const eyes = (judged.eyes ?? []).filter((e: string) => LIVENESS_EYES.includes(e));
    const cameras = [...new Set([...spec.cameras, ...eyes])];
    round.liveness = await livenessCritique(ctx, {
      run,
      facet,
      evidence: judged,
      cameras,
      iterationId: round.iterationId,
      critic,
    });
  } catch (err: any) {
    if (isStopped(err, ctx)) return stoppedByUser(loop);
    round.liveness = null;
  }
  if (!(round.liveness?.max > 0)) return;
  // A principle kept short of convincing card after card is stuck, and actionable at a 2.
  loop.principleStreaks = countPrincipleStreaks(loop.principleStreaks, round.liveness);
  round.liveness = withStuckPrinciples(round.liveness, loop.principleStreaks);
  loop.lastLiveness = round.liveness;
  // A fix that needs something the user did not ask for is theirs to decide (facet/beyond.ts).
  for (const principle of round.liveness.beyond ?? [])
    await askUserAboutBeyond(loop, { what: principle.fix }, BEYOND_MESSAGE.critic);
  await appendRun(RunEvent.FacetLiveness, {
    runId: run.runId,
    facetId: facet.id,
    facetTitle: facet.title,
    iteration: round.iteration,
    critic,
    total: round.liveness.total,
    max: round.liveness.max,
    biggest: round.liveness.biggest,
    summary: round.liveness.summary,
    grow: round.liveness.grow.map((g: AnyRecord) => g.key),
    polish: round.liveness.polish.map((p: AnyRecord) => p.key),
    principles: round.liveness.principles,
  });
}

/** Defects become checks; judge-grown checks that did their job retire. */
export async function growDefectChecks(loop: FacetLoop, round: FacetRound): Promise<RoundFlow> {
  const { ctx, legacy, spec } = loop;
  // ── defects become checks ──
  // Every defect the judge names (worst three, deduplicated) becomes a vision check on the
  // camera it names, so the scoreboard can never read 10/10 while the judge sees eight
  // defects. Judge-origin checks that pass twice retire, and so do the ones a picture cannot
  // answer; ones that keep failing feed the catalogue for the next run.
  round.gapRouted = false;
  round.defectNotes = [];
  /** Judge-grown checks retired this round: gone from the spec, still not the plan's flips. */
  round.retiredGrown = new Set();
  if (!legacy && !round.challengerBroken && !ctx.cancelled) {
    countJudgePasses(loop, round);
    await retireJudgeChecks(loop, round);
    await growFromDefects(loop, round);
  }
  round.summary = summarizeScoreboard(round.won ? round.attemptBoard : loop.board, spec);
  round.attemptSummary = summarizeScoreboard(round.attemptBoard, spec);
}

/** One more pass for every judge-grown check this attempt passed. */
function countJudgePasses({ judgePasses, spec }: FacetLoop, round: FacetRound): void {
  for (const check of spec.checks.filter((c) => c.origin === CheckOrigin.Judge)) {
    if (round.attemptBoard[check.id]?.pass === true) judgePasses[check.id] = (judgePasses[check.id] ?? 0) + 1;
  }
}

/** Judge-grown checks that have done their job, or that no picture can answer, leave the board. */
async function retireJudgeChecks(loop: FacetLoop, round: FacetRound): Promise<void> {
  const { appendRun, judgePasses, policy, retiredChecks, spec, stucks } = loop;
  for (const { check, why, count } of judgeChecksToRetire(spec, { passes: judgePasses, stucks, policy })) {
    rememberRetiredDefect(loop, check, why);
    round.retiredGrown.add(check.id);
    if (!retiredChecks.includes(check.id)) retiredChecks.push(check.id);
    spec.checks = spec.checks.filter((c) => c.id !== check.id);
    delete loop.board[check.id];
    if (round.nextBoard) delete round.nextBoard[check.id];
    delete stucks[check.id];
    await appendRun(RunEvent.FacetCheckRetired, {
      ...roundFields(loop, round.iteration),
      checkId: check.id,
      why,
      ...(why === RetireReason.Passed ? { passes: count } : { stuck: count }),
    });
  }
}

/**
 * "Passed" means solved, so the defect never re-grows. "Unanswerable" means the question was
 * wrong, not the game: the complaint stays in the ledger for the builder, and only this wording
 * of it is blocked from opening the same dead question again.
 */
function rememberRetiredDefect({ spec }: FacetLoop, check: AnyRecord, why: string): void {
  if (!check.defect) return;
  if (why === RetireReason.Passed)
    spec.retiredDefects = [...(spec.retiredDefects ?? []), check.defect].slice(-MAX_REMEMBERED_DEFECTS);
  if (why === RetireReason.Unanswerable)
    spec.blockedDefects = [
      ...(spec.blockedDefects ?? []),
      { text: check.defect, class: defectClass(check.defect) },
    ].slice(-MAX_REMEMBERED_DEFECTS);
}

/** The judge's defects (the biggest gap first) as new vision checks, each seeded as a measured fail on the build it was named on. */
async function growFromDefects(loop: FacetLoop, round: FacetRound): Promise<void> {
  const { appendRun, spec } = loop;
  // A taste veto names its regression as the gap, and that already grew its own check.
  const vetoGap = round.taste?.regression?.what && round.verdict.biggest_gap === round.taste.regression.what;
  const priorityGap = vetoGap ? null : judgedGap(round);
  const added = defectsToChecks(spec, [priorityGap, ...(round.verdict.defects ?? [])].filter(Boolean), {
    evidence: round.evidence,
    iteration: round.iteration,
    facets: loop.facets,
    policy: loop.policy,
    priority: priorityGap,
    noteDefect: (note) => round.defectNotes.push(note),
    routeDefect: defectRouter(loop, round, priorityGap),
  });
  // The judge named the defect on the better build — the challenger if it won, else the
  // incumbent. That is a measured fail on that build: seeded so the check's first pass on a
  // changed frame is a real flip, and an unchanged frame is not.
  const seedInto = round.won ? round.nextBoard : loop.board;
  for (const grown of added) {
    addGrownCheck(loop, grown);
    if (seedInto)
      seedInto[grown.id] = {
        id: grown.id,
        kind: CheckKind.Vision,
        weight: grown.weight,
        pass: false,
        reason: `named as a defect by the judge at iteration ${round.iteration}: ${grown.defect}`,
        origin: CheckOrigin.Judge,
      };
    await appendRun(RunEvent.FacetCheckAdded, {
      ...roundFields(loop, round.iteration),
      check: grown,
      origin: CheckOrigin.Judge,
    });
  }
}

/** The grown check joins the spec, and its camera joins the facet's cameras when it is one of the game's own. */
function addGrownCheck({ spec }: FacetLoop, grown: Check): void {
  spec.checks.push(grown);
  const camera = grown.camera;
  if (isNewOwnCamera(spec.cameras, camera)) spec.cameras.push(camera);
}

/** How a defect that reads as another facet's is handed over: on the record, and to the orchestrator's router. */
function defectRouter(loop: FacetLoop, round: FacetRound, priorityGap: string | null) {
  const { appendRun, facet, routeDefect, run } = loop;
  if (!routeDefect) return null;
  return (facetId: string, check: AnyRecord) => {
    const routesTheGap = priorityGap && check.defect && similarDefect(check.defect, priorityGap);
    if (routesTheGap) round.gapRouted = true;
    void appendRun(RunEvent.FacetDefectRouted, {
      runId: run.runId,
      from: facet.id,
      to: facetId,
      iteration: round.iteration,
      check,
    });
    return routeDefect(facetId, check);
  };
}
