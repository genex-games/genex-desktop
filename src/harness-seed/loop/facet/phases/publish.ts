/** The round on the record, and whether the facet goes on. */
import { isMeasured } from "../../checks.ts";
import { appliesToBuild } from "../../applies-to-build.ts";
import { Against, againstWords, observedFrom, roundRule, VerdictPass, verdictRecord } from "../../verdict.ts";
import { StopCode, stopWith } from "../../outcomes.ts";
import { RunEvent } from "../../run-events.ts";
import { CheckWeight } from "../../spec.ts";
import type { AnyRecord } from "../../../types/harness.d.ts";
import type { FacetLoop, FacetRound } from "../state.ts";
import { RoundFlow } from "../flow.ts";
import { brokenStreakWords, facetIsDone, grownCheckIds, smooth } from "../rules.ts";
import { recordDecision, unjudgedMove } from "../record.ts";
import { FacetStage, finishDone, isFinishing, roundStage } from "../stage.ts";
import { Side } from "../../judge.ts";
import { MINUTE_MS } from "../../time.ts";

/** The defects a round's record lists, at most. */
const MAX_RECORD_DEFECTS = 24;
/** Build turns the engine may fail in a row before the facet stops. */
const ENGINE_FAILURES_TO_STOP = 3;

/** The round's record, published; what the round cost, measured. */
export async function publishRound(loop: FacetLoop, round: FacetRound): Promise<RoundFlow> {
  const { emitLoopState, facet, facetThreadId, publishIteration, result, run, spec } = loop;
  result.biggest_gap = loop.biggestGap;
  result.board = loop.board;

  round.failingNow = Object.values(loop.board).filter((e) => e.pass === false);
  // Only this build's questions: a harness check it cannot answer is in no count, so in no list.
  round.applyingNow = (Object.values(round.attemptBoard) as AnyRecord[]).filter((e) => appliesToBuild(e, spec));
  round.unmeasuredNow = round.applyingNow.filter((e: AnyRecord) => !isMeasured(e));
  // A check the judge grew this run is not one the part was planned against. The verdict record
  // counts the two apart, so a card can stop reading a judge's own new question as a win.
  round.grownIds = grownCheckIds(spec, round.retiredGrown);
  round.record = {
    runId: run.runId,
    project: run.project,
    facetId: facet.id,
    facetTitle: facet.title,
    iteration: round.iteration,
    winner: round.won ? Side.Challenger : Side.Incumbent,
    satisfied: Boolean(round.verdict.satisfied),
    biggest_gap: round.verdict.biggest_gap ?? loop.biggestGap,
    // The defect list the UI shows: failing checks (identity first) then the taste judge's.
    defects: recordDefects(round),
    reason: round.verdict.reason ?? "",
    // Which judge said so: model, prompt hash, reply, usage.
    judgeCall: round.verdict.judgeCall ?? null,
    verdictSource: round.verdictSource,
    partial: round.partialWork,
    // Unmeasured is reported beside the defects, never inside them.
    unmeasured: round.unmeasuredNow.map((e: AnyRecord) => `[${e.id}] ${e.reason}`),
    scoreboard: loop.legacy ? null : scoreboardRecord(round),
    attemptBranch: round.attemptBranch,
    followedUp: round.followedUp,
    // Defects the judge named that no camera can answer: they stay in the ledger, with the
    // probe expression that would measure them, instead of becoming picture questions.
    defectNotes: round.defectNotes,
    move: round.moveRecord ?? unjudgedMove(loop.currentMove),
    fix: fixRecord(loop, round),
    // The reviewer's one big move for this part, and its polish notes apart from the defects:
    // what the director plans the part's next rung from.
    bigMove: round.taste?.bigMove ?? null,
    polish: round.taste?.polish ?? [],
    liveness: livenessRecord(round.liveness),
    spike: spikeRecord(loop, round),
    ...pictureRecord(loop, round),
    // The same record every other judge of the run writes: what was looked at, what was
    // measured, what the judge saw, and one sentence saying why. `verdictSource` and the
    // scoreboard stay where they are — this is the shape the screen reads, not a replacement.
    verdict: roundVerdict(loop, round),
    threadId: facetThreadId,
    // The worker's first, long round (facet/build-block.ts): the director sizes no round from it.
    ...(round.buildBlock ? { buildBlock: { minutes: buildMinutes(round), turns: round.blockTurns ?? 0 } } : {}),
  };
  await publishIteration(round.record);
  round.spikeText = null;
  // What this round actually cost, for the gate at the top of the next one. Measured in the
  // two halves it is spent in, and only on a round that ran all the way to a verdict — a
  // stopped or held round says nothing about how long the work takes. A build block's build is
  // long on purpose: only its verdict half says what a round costs.
  if (!round.buildBlock) loop.emaBuildMs = smooth(loop.emaBuildMs, round.buildEndedAt - round.buildStartedAt);
  loop.emaAfterMs = smooth(loop.emaAfterMs, Date.now() - round.buildEndedAt);
  // The round is decided and its cost is measured: the estimate the director sizes the next
  // worker from is only honest here.
  emitLoopState("scored", round.iteration);
}

/** How long the round's build ran, in whole minutes. */
const buildMinutes = (round: FacetRound): number =>
  Math.round((Number(round.buildEndedAt) - Number(round.buildStartedAt)) / MINUTE_MS);

/** Failing checks (identity first), then the judge's own defects. */
function recordDefects(round: FacetRound): string[] {
  const line = (e: AnyRecord) => `[${e.id}] ${e.reason}`;
  const identity = round.failingNow.filter((e: AnyRecord) => e.weight === CheckWeight.Identity).map(line);
  const rest = round.failingNow.filter((e: AnyRecord) => e.weight !== CheckWeight.Identity).map(line);
  return [...identity, ...rest, ...(round.verdict.defects ?? [])].slice(0, MAX_RECORD_DEFECTS);
}

/** The attempt's board as the card counts it: planned and grown apart, the flips, and what measured nothing. */
function scoreboardRecord(round: FacetRound): AnyRecord {
  const summary = round.attemptSummary;
  const flips: string[] = round.comparison?.flips ?? [];
  return {
    total: summary.total,
    passing: summary.passing,
    unmeasured: summary.unmeasured,
    // Planned and grown apart, so a card can say "Passed 3 · Failed 2 · Couldn't
    // measure 4 · 3 judge notes" instead of counting the judge's own notes as checks.
    plannedTotal: summary.plannedTotal,
    plannedPassing: summary.plannedPassing,
    plannedUnmeasured: summary.plannedUnmeasured,
    grownTotal: summary.grownTotal,
    grownPassing: summary.grownPassing,
    identityTotal: summary.identityTotal,
    identityPassing: summary.identityPassing,
    flips,
    // The flips that belong to the plan. A judge's own question turning green is real,
    // but it is not the part doing what it was asked, and the card must not say "+1".
    plannedFlips: flips.filter((id) => !round.grownIds.has(id)),
    regressions: round.comparison?.regressions ?? [],
    // Which checks measured nothing, not just how many: the run ledger keeps these ids
    // and a check that has told nobody anything for three rounds stops being written
    // again (`rarelyMeasurable`). Without them that warning could never fire.
    unmeasuredChecks: (summary.unmeasuredChecks ?? []).map((c: AnyRecord) => c.id),
    // The same entries the counts above are made of, so the record agrees with itself.
    results: (round.applyingNow as AnyRecord[]).map(({ id, kind, weight, pass, reason, gamed }) => ({
      id,
      kind,
      weight,
      pass,
      reason,
      ...(gamed ? { gamed: true } : {}),
    })),
  };
}

/** THE FIX the round carried, and whether it landed (nobody knows on a broken build). */
function fixRecord(loop: FacetLoop, round: FacetRound): AnyRecord | null {
  const fix = loop.currentFix;
  if (!fix) return null;
  return {
    what: fix.what,
    checkId: fix.checkId,
    streak: fix.streak,
    mandatory: fix.mandatory,
    delivered: round.challengerBroken ? null : loop.fixedForRecord,
  };
}

/** The liveness critic's card: the score, the biggest gap, and each principle's score. */
function livenessRecord(liveness: AnyRecord | null): AnyRecord | null {
  if (!liveness) return null;
  const scored = liveness.principles.filter((p: AnyRecord) => p.score !== null);
  const biggest = liveness.principles.find((p: AnyRecord) => p.key === liveness.biggest);
  return {
    total: liveness.total,
    max: liveness.max,
    biggest: liveness.biggest,
    // The fix for the principle that would change the feel most: the critic's next step.
    biggestFix: biggest?.fix || null,
    scores: Object.fromEntries(scored.map((p: AnyRecord) => [p.key, p.score])),
  };
}

/** This round's spike, when it ran one. */
function spikeRecord(loop: FacetLoop, round: FacetRound): AnyRecord | null {
  const spike = loop.lastSpike;
  const thisRound = spike?.checkId && loop.result.spikes.at(-1)?.checkId === spike.checkId && round.spikeText;
  return spike && thisRound ? { checkId: spike.checkId, ok: spike.ok } : null;
}

/** What the round looked at: its shots, its distance to the references, its pair images, its flags and its diffs. */
function pictureRecord(loop: FacetLoop, round: FacetRound): AnyRecord {
  return {
    shots: (round.evidence.shots ?? []).map(({ camera, path: p, bytes, stats }: AnyRecord) => ({
      camera,
      path: p,
      bytes,
      stats: stats ? { meanLuma: stats.meanLuma, litFraction: stats.litFraction } : null,
    })),
    style: loop.lastStyle?.current?.length
      ? loop.lastStyle.current.map((d: AnyRecord) => ({ camera: d.camera, distance: d.distance, reference: d.label }))
      : null,
    pairs: loop.lastPairs.map((p) => ({ camera: p.camera, path: p.path, reference: p.reference })),
    flags: loop.flags
      .filter((f) => f.iteration === round.iteration)
      .map((f) => ({ what: f.what, checkId: f.checkId ?? null })),
    diffs: Object.fromEntries(
      (Object.entries(round.diffs) as Array<[string, AnyRecord | null]>).map(([camera, d]) => [
        camera,
        d ? { diffFraction: d.diffFraction, heatmapPath: d.heatmapPath ?? null } : null,
      ]),
    ),
  };
}

/** The round's verdict record, in the one shape every judge of the run writes. */
function roundVerdict(loop: FacetLoop, round: FacetRound) {
  const board = Object.values(round.attemptBoard) as AnyRecord[];
  const satisfied = Boolean(round.verdict.satisfied);
  return verdictRecord({
    pass: VerdictPass.Round,
    head: round.won ? loop.incumbentCommit : null,
    worker: loop.facet.id,
    round: round.iteration,
    against: againstWords(round.iteration === 1 ? Against.Start : Against.Round),
    ...observedFrom(round.evidence),
    consoleInherited: loop.baseConsole,
    planned: board.filter((e) => !round.grownIds.has(e.id)),
    grown: board.filter((e) => round.grownIds.has(e.id)),
    flips: round.comparison?.flips ?? [],
    regressions: round.comparison?.regressions ?? [],
    unmeasured: round.unmeasuredNow.map((e: AnyRecord) => e.id),
    pick: round.verdict.pick ?? null,
    veto: round.taste ? round.taste.veto === true : null,
    satisfied,
    alive: round.liveness?.total ?? null,
    aliveMax: round.liveness?.max ?? null,
    judgeCalls: round.taste ? 1 : 0,
    kept: round.won,
    rule: roundRule({ source: round.verdictSource, won: round.won, satisfied }),
    gap: round.verdict.biggest_gap ?? "",
  });
}

/** Exit when the work is done; the circuit breaker; the engine's health. */
export async function decideExit(loop: FacetLoop, round: FacetRound): Promise<RoundFlow> {
  const { result } = loop;
  // ── exit: the work it was given is done ──
  const exit = { won: round.won, broken: round.challengerBroken, summary: round.summary };
  // A finishing worker is done when the judge preferred its polish and nothing broke: the strict
  // `satisfied` the build stage waits for is not its contract (facet/stage.ts). Only a round that
  // ran as a finish ends that way, and only while the worker still finishes: a build round in
  // flight when the steer to finish landed, or a finish round whose worker a move took back to
  // building, keeps the build stage's exit.
  const ranAsFinish = roundStage(round, loop.spec) === FacetStage.Finish;
  const finishing = ranAsFinish && isFinishing(loop.spec) && !loop.legacy;
  round.finished = finishing ? finishDone(exit) : facetIsDone({ ...exit, verdict: round.verdict, legacy: loop.legacy });
  if (round.finished) {
    result.satisfied = true;
    stopWith(result, StopCode.Done, round.finished);
    return RoundFlow.Stop;
  }
  // ── circuit breaker (WP1d): no third build on the same broken cause ──
  if (loop.circuitBreak) return breakCircuit(loop, round, loop.circuitBreak);
  // ── engine health, per facet ──
  if (!round.buildEngineError) {
    loop.engineFailures = 0;
    return;
  }
  return checkEngineHealth(loop, round);
}

/** The same unjudgeable cause, build after build: the facet stops, and says where its last attempt is. */
async function breakCircuit(loop: FacetLoop, round: FacetRound, reason: string): Promise<RoundFlow> {
  const { appendRun, facet, policy, result, run } = loop;
  stopWith(
    result,
    StopCode.CircuitBreak,
    reason + (round.attemptBranch ? ` (last attempt kept on ${round.attemptBranch})` : ""),
  );
  await appendRun(RunEvent.FacetCircuitBreak, {
    runId: run.runId,
    facetId: facet.id,
    facetTitle: facet.title,
    iteration: round.iteration,
    reason,
    branch: round.attemptBranch,
    detail: round.brokenDetail,
  });
  await recordDecision(
    loop,
    `${facet.id} stopped after ${brokenStreakWords(policy.brokenStreakLimit)} with one cause (${loop.brokenStreak.reason}) — its last attempt is on ${round.attemptBranch ?? "the worktree"}; steer it to re-enter`,
  );
  return RoundFlow.Stop;
}

/**
 * The build turn failed in the engine, three in a row stops the facet. A lost provider (a sign-in,
 * a limit, an outage) never reaches here: its round waits for the provider (facet/provider.ts).
 */
function checkEngineHealth(loop: FacetLoop, round: FacetRound): RoundFlow {
  const { result } = loop;
  loop.engineFailures += 1;
  if (loop.engineFailures < ENGINE_FAILURES_TO_STOP) return;
  stopWith(
    result,
    StopCode.EngineExhausted,
    `the engine failed ${loop.engineFailures} build turns in a row — last: ${round.buildFailed}`,
  );
  return RoundFlow.Stop;
}
