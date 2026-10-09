import { keepCheckpoint } from "./progress.ts";
import { retainSpan, timedOperation } from "./timing.ts";
import { GoalBlocker, GoalStatus, goalDecision, recordGoalEvidence, replanGoal } from "./goals.ts";
/**
 * The director's tools as its session calls them: the handler the studio forwards every call to,
 * and the tools that only look — `run_status`, `worker_wait`, `judge`, `playtest`, `show`. The
 * worker tools follow Genex's one worker model (`loop/workers/`): `worker_mark` and a reader's calls
 * are answered there.
 */

import { renderScoreboard, runDeterministicChecks, summarizeScoreboard, toScoreboard, unmeasured } from "../checks.ts";
import { FACET_POLICY } from "../facet-loop.ts";
import { GIT, gitAt, headOf, shortSha } from "../git.ts";
import { HostMethod } from "../host-methods.ts";
import { askVisionBoard, blindCompare, Side, visionCheck } from "../judge.ts";
import { EngineFailure, outageDelays, withProviderPatience } from "../outage.ts";
import { isRunning, WorkerMode } from "../outcomes.ts";
import { runPlaytest } from "../playtester.ts";
import { attemptRef } from "../repo.ts";
import { RunEvent, SteeringSource } from "../run-events.ts";
import { CheckKind, CheckWeight, MoveOwner, normalizeFacetSpec, normalizeMilestone } from "../spec.ts";
import { FacetStage, isFinishing, stageArg } from "../facet/stage.ts";
import { playtestStepWords } from "../facet/beyond.ts";
import { withOpenRung } from "../facet/growth.ts";
import {
  STEER_BACK_TO_BUILD,
  STEER_EMPTY_REFUSAL,
  steerStageRefusal,
  steerStageWords,
} from "../facet/stage-prompts.ts";
import { CLIP_REASON } from "../text.ts";
import { MINUTE_MS, minutes, SECOND_MS, sleep } from "../time.ts";
import { Against, againstWords, observedFrom, VerdictPass, VerdictRule } from "../verdict.ts";
import { list, namedTitle, num, parseJson, slug, yes } from "./args.ts";
import { MAX_WAIT_S, MAX_WORKERS, workerWindows } from "./budgets.ts";
import { waitDigest, workerDigest } from "./digests.ts";
import { priorWorkerStatus, priorWorkersStatus } from "./journal.ts";
import { setAsideStrays } from "./lead-session.ts";
import { LEAD_DIRTY, LEAD_LIVE_DIRTY } from "./lead-session-prompts.ts";
import { BuildTarget, WindowLease } from "./loop-run.ts";
import { finalJudgeQuestion } from "./close-prompts.ts";
import { routeShipDefects, shipParts } from "./art-direction.ts";
import { defectsByPart, SHIP_ALONE, SHIP_QUESTION, shipNext } from "./art-direction-prompts.ts";
import { SHIP_VIEW, shipReview } from "../ship-review.ts";
import { JudgeParse } from "../judge-provenance.ts";
import { plainly } from "./rules.ts";
import { DirectorTool, headSynced } from "./tool-specs.ts";
import { passDeadline } from "./wake-schedule.ts";
import { workingGoal } from "../goal-prompts.ts";
import { WorkerTool } from "../workers/contract.ts";
import {
  briefOf,
  markWorker,
  pooledAnswer,
  readerLines,
  rejectedNews,
  unrejected,
  waitingBuilders,
} from "../workers/director-pool.ts";
import type { LastJudge, LoopRun, Worker } from "./loop-run.ts";
import type { LastShip } from "./art-direction.ts";
import type { CheckResult } from "../checks.ts";
import type { Evidence, Shot } from "../evidence.ts";
import type { ShipReview } from "../ship-review.ts";
import type { VisionAsk } from "../judge.ts";
import type { Check } from "../spec.ts";
import type { AnyRecord } from "../../types/harness.d.ts";

/**
 * This part serves a lead that is its chat's own session and writes nothing (one session): a run
 * seats one only when every part it depends on says so (lead-session.ts `servesLead`).
 */
export const SERVES_LEAD = true;

/** What a stopped run answers every tool call with but the studio's own. */
const STOPPED_BY_USER = "STOPPED BY THE USER: the run is over; end your session now without starting anything";
/** How much of a build's state a judge's answer quotes. */
const JUDGE_STATE_CHARS = 1_200;
/** How many GPU errors a judge's answer carries. */
const JUDGE_GPU_ERRORS = 4;
/**
 * How soon after it starts the close's own judge must be done asking (`judgeTheLanding`). The close
 * runs inside the lead's `finish` call, which the engine gives up on after ten minutes, and the
 * settle, the close's look and the judge's own look share that time.
 */
const FINAL_JUDGE_MS = 4 * MINUTE_MS;
/** judge.ts's confidence for an answer that states none — a coin flip; the close counts only a surer one. */
const COIN_FLIP = 0.5;
/** A playtest's minutes: at least two, at most eight, five unless the director says otherwise. */
const PLAYTEST_MIN_MINUTES = 2;
const PLAYTEST_MAX_MINUTES = 8;
const PLAYTEST_DEFAULT_MINUTES = 5;
/** The most actions a director's playtester takes. */
const PLAYTEST_MAX_ACTIONS = 20;
/** A `worker_wait` that names no length waits a minute. */
const WAIT_DEFAULT_S = 60;
/** How much of a worker's brief, iterations and attempts `worker_status` carries. */
const STATUS_BRIEF_CHARS = 600;
const STATUS_ITERATIONS = 6;
const STATUS_ATTEMPTS = 4;
/** How much of a note the journal keeps, and of its plain sentence. */
const NOTE_CHARS = 2_000;
const NOTE_PLAIN_CHARS = 400;

/** A check's answer as a yes, a no, or neither. */
function answerOf(pass: boolean | null | undefined): boolean | null {
  if (pass === true) return true;
  if (pass === false) return false;
  return null;
}

/** The judge's last word on the integration branch, as `run_status` shows it. */
function lastJudgeStatus(lastJudge: AnyRecord | null): AnyRecord | null {
  if (!lastJudge) return null;
  return {
    head: shortSha(lastJudge.head),
    ok: lastJudge.ok,
    pick: lastJudge.pick ?? null,
    answer: lastJudge.answer ?? null,
    allChecksPassed: lastJudge.boardAllPass ?? null,
  };
}

/** The plan the user is reading, so a compacted or resumed session knows it has one. */
function planStatus(state: AnyRecord): AnyRecord | null {
  if (!state.plan) return null;
  const waiting = state.planReviewUntil && !state.planGo;
  return {
    summary: state.plan.summary,
    parts: state.plan.workers.map((w: Worker) => w.id),
    ...(waiting ? { waitingForTheUser: minutes(state.planReviewUntil - Date.now()) } : {}),
  };
}

/**
 * The pool as `run_status` shows it, when the studio could say: its windows, and how many
 * workers may run at once — the user's Maximum concurrent workers, the lead's own windows apart.
 */
function capacityStatus(cap: AnyRecord | null): AnyRecord | null {
  if (!cap) return null;
  const workersAtOnce = cap.headless === false ? 1 : Math.min(MAX_WORKERS, workerWindows(cap.max));
  return {
    workersAtOnce,
    windowsFree: cap.free ?? cap.max,
    windowsMax: cap.max,
    memoryFreeMb: cap.memory?.freeMb ?? null,
  };
}

/** Where the integration branch stands, as `run_status` shows it. */
function integrationStatus(loopRun: LoopRun): AnyRecord {
  const { baseCommit, integrationRef, integrationWorktree, ledgerLines, state } = loopRun;
  return {
    worktree: integrationWorktree,
    head: state.integrationHead ? shortSha(state.integrationHead) : null,
    base: baseCommit ? shortSha(baseCommit) : null,
    ref: integrationRef,
    lastHealthPass: state.integrationHealthy,
    lastJudge: lastJudgeStatus(state.lastJudge),
    ...(state.ledger.length ? { defectsNobodyOwns: ledgerLines() } : {}),
  };
}

export async function statusText(loopRun: LoopRun) {
  const { ctx, finalDeadline, inbox, run, runRoundMinutes, softDeadline, started, state, workersEngineLimit } = loopRun;
  const cap = await ctx.call(HostMethod.PreviewCapacity, {}).catch(() => null);
  const screens = await ctx.call(HostMethod.PreviewScreens, {}).catch(() => []);
  const pending = await inbox.backlog().catch(() => []);
  const iterationMinutes = runRoundMinutes();
  const workersLimit = workersEngineLimit();
  const before = priorWorkersStatus(loopRun);
  return {
    time: {
      elapsedMin: minutes(Date.now() - started),
      sessionMinutesLeft: minutes(softDeadline - Date.now()),
      hardMinutesLeft: minutes(finalDeadline - Date.now()),
      ...(iterationMinutes === null ? {} : { iterationMinutes }),
    },
    integration: integrationStatus(loopRun),
    plan: planStatus(state),
    acceptance: state.goals ?? null,
    checkpoint: loopRun.journal.director.latestVerifiedCheckpoint ?? null,
    completion: state.goals ? goalDecision(state.goals, state.integrationHead) : null,
    workers: [...state.workers.values()].map((w) => workerDigest(w)),
    // A resumed run's workers from before the pause (the journal kept them): none runs, their work is on their refs.
    ...(before.length ? { workersBeforeThePause: before } : {}),
    // The thresholds every loop worker runs on unless its own worker_start set them. Here
    // once, so a worker's digest can carry only what it was actually given.
    assets: await ctx
      .call(HostMethod.AssetsInventory, { project: run.project })
      .catch((error: any) => ({ unavailable: String(error?.message ?? error) })),
    policy: FACET_POLICY,
    capacity: capacityStatus(cap),
    screens: (Array.isArray(screens) ? screens : []).map((s) => ({
      label: s.label,
      role: s.role,
      caption: s.caption ?? null,
    })),
    user: { unreadInstructions: pending.length, finishRequested: await inbox.finishing().catch(() => false) },
    // The workers' own subscription ran out (cross-provider roles): named here, once, with
    // when it happened and when it resets, so a director on the other subscription knows
    // its next worker_start will meet the same wall — and that its own session is fine.
    ...(workersLimit ? { workersEngineLimit: workersLimit } : {}),
  };
}

/** The workers' engine's limit as run_status shows it: which engine, since when, until when. */
export function workersEngineLimit(loopRun: LoopRun) {
  const { state } = loopRun;
  const w = state.workerLimit;
  if (!w) return null;
  const resetAt = w.retryAfterMs !== null ? w.at + w.retryAfterMs : null;
  // Reset: gone from the run, so worker_start is not warned off and no wake says it again.
  if (resetAt !== null && resetAt <= Date.now()) {
    state.workerLimit = null;
    return null;
  }
  const until =
    resetAt !== null ? ` for about ${Math.max(0, minutes(resetAt - Date.now()))} more minutes` : " until it resets";
  return {
    engine: w.engine,
    kind: w.kind === EngineFailure.UsageLimit ? "usage cap" : "session limit",
    worker: w.worker,
    minutesAgo: minutes(Date.now() - w.at),
    minutesUntilReset: resetAt !== null ? Math.max(0, minutes(resetAt - Date.now())) : null,
    message: w.message,
    note: `the workers' engine (${w.engine}) is out; your own session is not. worker_start will hit the same limit${until} — wait it out, or do the work in your own worktree.`,
  };
}

// ── judge ──

/** What a judge was asked to look at and against, read off the call. */
interface JudgeAsk {
  target: ReturnType<LoopRun["resolveRoot"]> & { root: string; label: string };
  againstKey: string;
  cameras: string[];
  checksRaw: unknown;
  question: unknown;
  n: number;
  head: string | null;
  /** The close's own judge of the build it makes live (`LastJudge.final`). */
  final: boolean;
  /** When the judge's calls must be done by, when that is sooner than the pass's deadline (`judgeRun`). */
  until: number;
  /** The art director's absolute look at the whole game (`ship=yes`), at `SHIP_VIEW`. */
  ship?: boolean;
}

/** How a judge is asked for: by the lead (the defaults), or by the close (`judgeTheLanding`). */
interface JudgeOptions {
  /** Look through the studio's own window when every pool window is a worker's: a judge nobody may skip. */
  borrow?: boolean;
  /** The close's own judge of the build it is about to make live. */
  final?: boolean;
  /** See `JudgeAsk.until`. */
  until?: number;
}

/** One pass of a judge, on the window it leased. */
interface JudgePass extends JudgeAsk {
  handle: string | null;
  evidence: Evidence;
  out: AnyRecord;
  judgement: AnyRecord;
}

/**
 * What is being looked at, so the pass can forgive what that build inherited and so the run's
 * own starting point is judged as a starting point. A worker that has not committed yet is its
 * own uncommitted work, not a commit anyone can fork from: it gets no entry, so nobody dry-runs
 * a later worker against it.
 */
async function judgedHead(loopRun: LoopRun, target: JudgeAsk["target"]): Promise<string | null> {
  const { baseCommit, ctx, integrationWorktree, projectDir, state } = loopRun;
  if (target.root === integrationWorktree) return headOf(ctx, integrationWorktree).catch(() => state.integrationHead);
  return target.worker?.lastCommit ?? (target.root === projectDir ? baseCommit : null);
}

/** The judge's answer before anything is scored: what it saw of the build. */
function judgeOut(loopRun: LoopRun, label: string, evidence: Evidence): AnyRecord {
  const { shotsOf } = loopRun;
  return {
    target: label,
    ok: evidence.ok,
    problems: evidence.problems ?? [],
    warnings: evidence.warnings ?? [],
    requestedState: evidence.requestedState ?? null,
    shots: shotsOf(evidence),
    consoleErrors: evidence.consoleErrors ?? [],
    gpuErrors: (evidence.gpuErrors ?? []).slice(0, JUDGE_GPU_ERRORS),
    state: evidence.state ? JSON.stringify(evidence.state).slice(0, JUDGE_STATE_CHARS) : null,
  };
}

/** What a judge learned about a commit, kept for every later pass over the same head. */
function rememberJudgedHead(loopRun: LoopRun, head: string | null, evidence: Evidence): void {
  const { errorsLogged, rememberEvidence, state } = loopRun;
  if (!head) return;
  if (evidence.ok === true) state.healthByHead.set(head, true);
  state.consoleByHead.set(head, errorsLogged(evidence));
  rememberEvidence(head, evidence);
}

/** The frame a check is judged on: its own camera's, else the first one taken. */
const shotFor = (evidence: Evidence, camera: unknown): Shot | undefined =>
  (evidence.shots ?? []).find((s: Shot) => s.camera === camera) ?? evidence.shots?.[0];

/**
 * The board's picture questions, asked of the judge a camera at a time, not one session per
 * question: a six-question board cost six Claude sessions before (M3.10). A play check has no
 * picture to ask about; it is unmeasured here, and playtest measures it.
 */
async function visionAsksFor(loopRun: LoopRun, pass: JudgePass, pending: Check[], results: CheckResult[]) {
  const { ctx, run } = loopRun;
  const asks: VisionAsk[] = [];
  for (const check of pending) {
    if (check.kind !== CheckKind.Vision) {
      results.push(unmeasured(check, "play checks need playtest; use it"));
      continue;
    }
    const shot = shotFor(pass.evidence, check.camera);
    if (!shot) {
      results.push(unmeasured(check, "no frame for its camera"));
      continue;
    }
    let crop: { base64?: string; path?: string | null } = { base64: shot.base64, path: shot.path };
    if (check.crop && shot.path)
      crop =
        (await ctx
          .call(HostMethod.PreviewCrop, {
            runId: run.runId,
            path: shot.path,
            crop: check.crop,
            label: `director/judge_${pass.n}/crops/${check.id}`,
            ...(pass.handle ? { handle: pass.handle } : {}),
          })
          .catch(() => null)) ?? crop;
    asks.push({ check, crop, camera: shot.camera });
  }
  return asks;
}

/** Score the typed checks the director handed the judge; the checks it scored, one entry each. */
async function scoreJudgeChecks(loopRun: LoopRun, pass: JudgePass): Promise<CheckResult[]> {
  const { ctx, run } = loopRun;
  const { cameras, checksRaw, evidence, handle, n, out, judgement } = pass;
  const namesChecks = Array.isArray(checksRaw) && checksRaw.length > 0;
  if (!namesChecks || !evidence.ok) return [];
  const spec = normalizeFacetSpec({ id: `judge-${n}`, title: "judge", intent: "", checks: checksRaw, cameras }, 0);
  const { results, pending } = await runDeterministicChecks(ctx, {
    spec,
    evidence,
    diffs: {},
    handle,
    references: null,
  });
  const asks = await visionAsksFor(loopRun, pass, pending, results);
  if (asks.length) {
    const answered = await askVisionBoard(ctx, { run, asks }).catch((err) =>
      asks.map((ask) => unmeasured(ask.check, `judge unavailable: ${err?.message ?? err}`)),
    );
    results.push(...answered);
  }
  const board = toScoreboard(results);
  out.board = { summary: summarizeScoreboard(board, spec), lines: renderScoreboard(board, null, spec) };
  judgement.boardAllPass = out.board.summary.total > 0 && out.board.summary.passing === out.board.summary.total;
  return Object.values(board);
}

/**
 * Until when this pass may wait out a busy provider: the working deadline while there is working
 * time, the wrap-up's own end once it is over (`passDeadline`), or the close's sooner `until`.
 */
function judgeDeadline(loopRun: LoopRun, pass: JudgeAsk): number {
  const { finalDeadline, softDeadline } = loopRun;
  return Math.min(passDeadline({ now: Date.now(), softDeadline, finalDeadline }), pass.until);
}

/**
 * The run as this pass's judge calls read it. The close's judge runs inside the lead's `finish`
 * call, which the engine gives up on after ten minutes, so its calls are held to `until` the way
 * judge.ts holds any judge with a deadline (`run.optimizationDeadline`): each call times out by it,
 * no retry starts past it, and the call is the run's, so the user's Stop aborts it.
 */
function judgeRun(loopRun: LoopRun, pass: JudgeAsk): LoopRun["run"] {
  const { run } = loopRun;
  return Number.isFinite(pass.until) ? { ...run, optimizationDeadline: pass.until } : run;
}

/** The vision judge's own yes or no, when it was surer than a coin flip: null for an answer nobody could use. */
function sureAnswer(result: Partial<CheckResult>): boolean | null {
  if (!(typeof result.confidence === "number" && result.confidence > COIN_FLIP)) return null;
  if (result.answer === "yes") return true;
  if (result.answer === "no") return false;
  return null;
}

/** The one yes/no question the director asked of the vision judge, on its first (or default) camera. */
async function askJudgeQuestion(loopRun: LoopRun, pass: JudgePass): Promise<void> {
  const { ctx, run } = loopRun;
  const { cameras, evidence, judgement, out, question } = pass;
  if (!question || !evidence.ok) return;
  const camera = cameras[0] ?? "default";
  const shot = shotFor(evidence, camera);
  if (!shot) return;
  const check = { id: "question", kind: CheckKind.Vision, camera: shot.camera, ask: String(question), expect: "yes" };
  const asking = () =>
    visionCheck(ctx, {
      run: judgeRun(loopRun, pass),
      check: check as Check,
      crop: { base64: shot.base64, path: shot.path },
    });
  // The close's question waits out a busy provider until its own deadline; a lead's asks once.
  const patience = { deadline: judgeDeadline(loopRun, pass), delays: outageDelays(run), label: "the director's judge" };
  const answer = await (pass.final ? withProviderPatience(ctx, asking, patience) : asking()).catch(
    (err): Partial<CheckResult> => ({ pass: null, reason: String(err?.message ?? err) }),
  );
  // The close's word is what the judge said, not whether it passed: an answer it could not give is no "no".
  const said = pass.final ? sureAnswer(answer) : answerOf(answer.pass);
  out.answer = { question: String(question), camera: shot.camera, yes: said, note: answer.note ?? answer.reason ?? "" };
  judgement.answer = said;
}

/** The other side of a blind comparison: the start, or another build looked at on this window. */
async function otherBuild(
  loopRun: LoopRun,
  pass: JudgePass,
): Promise<{ other: Evidence | null; worker: Worker | null }> {
  const { consoleInheritedBy, evidenceOf, resolveRoot, run, state } = loopRun;
  const { againstKey, cameras, handle, n, out } = pass;
  if (againstKey === Against.Start) return { other: state.startEvidence, worker: null };
  const against = resolveRoot(againstKey);
  if (against.error !== undefined) {
    out.against = against.error;
    return { other: null, worker: null };
  }
  // Whose build this one is put beside — its title is what the record names, not the title of
  // the build being judged.
  const other = await evidenceOf(against.root, {
    handle,
    label: `judge_${n}_against`,
    cameras: cameras.length ? cameras : null,
    setup: against.worker?.setup ?? run.setup ?? null,
    inheritedConsole: consoleInheritedBy(against.worker),
  }).catch(() => null);
  return { other, worker: against.worker ?? null };
}

/** A build's frames that are views of the game: its cameras and its player's eyes, not demos or the user's page. */
function viewsOf(evidence: Evidence): string[] {
  const views = (evidence.shots ?? [])
    .map((shot: Shot) => shot.camera)
    .filter((camera): camera is string => typeof camera === "string" && camera !== "user:view")
    .filter((camera) => !camera.startsWith("demo:"));
  return [...new Set(views)];
}

/**
 * The cameras a whole-game blind verdict shows when the lead named none: every view both builds
 * have, in this build's order — so neither side is judged on a camera the other lacks. The tool
 * has always said "default: every registered camera"; the judge saw the default one alone.
 */
function camerasBothShow(evidence: Evidence, other: Evidence): string[] {
  const theirs = new Set(viewsOf(other));
  return viewsOf(evidence).filter((camera) => theirs.has(camera));
}

/** The blind verdict between this build and the other one, with the provider's patience. */
async function blindVerdict(loopRun: LoopRun, pass: JudgePass, other: Evidence): Promise<void> {
  const { ctx, run } = loopRun;
  const { againstKey, cameras, evidence, judgement, n, out } = pass;
  // In the wrap-up the working deadline has passed (or moved to its start): the wrap-up's own end holds.
  const deadline = judgeDeadline(loopRun, pass);
  const both = cameras.length ? [] : camerasBothShow(evidence, other);
  const shown = cameras.length ? cameras : both;
  try {
    const verdict = await withProviderPatience(
      ctx,
      () =>
        blindCompare(ctx, {
          run: judgeRun(loopRun, pass),
          challenger: evidence,
          incumbentSnapshot: null,
          incumbentEvidence: other,
          iterationId: `director_${n}`,
          cameras: shown.length ? shown : null,
          everyCamera: both.length > 0,
        }),
      { deadline, delays: outageDelays(run), label: "the director's judge" },
    );
    out.verdict = {
      against: againstKey,
      picks: verdict.facets ?? null,
      pick: verdict.pick ?? null,
      defects: verdict.defects ?? [],
      reason: verdict.reason ?? "",
    };
    judgement.against = againstKey;
    judgement.pick = out.verdict.pick ?? null;
  } catch (err: any) {
    out.verdict = { against: againstKey, error: String(err?.message ?? err) };
  }
}

/** The comparison the director asked for; answers the worker whose build this one was put beside. */
async function compareJudged(loopRun: LoopRun, pass: JudgePass): Promise<Worker | null> {
  const { state } = loopRun;
  const { againstKey, evidence, out } = pass;
  if (!evidence.ok || againstKey === Against.None) return null;
  if (againstKey === Against.Start && state.fromScratch) {
    // A run that began on an empty scaffold has no "before": a blind verdict against a
    // blank frame is a coin toss dressed as evidence, and answering "the other build could
    // not be observed" made the run's own first look read like a failure.
    out.verdict = {
      against: Against.Start,
      firstBuild: true,
      pick: null,
      note: "first build — nothing to compare: this run began from an empty starting point, so this build is judged on its own evidence (its checks, a question, or against another build)",
    };
    return null;
  }
  if (againstKey === Against.Start && !state.startEvidence) {
    // The run began on a build nobody could photograph. Saying "the other build could
    // not be observed" sent directors back to judge it again and again; say what is true
    // and what to do instead, once.
    out.verdict = {
      against: Against.Start,
      pick: null,
      note: "no start evidence: the starting build rendered black, so there is nothing to compare with — judge this build on its own evidence (checks, a question) or against another build",
    };
    return null;
  }
  const { other, worker } = await otherBuild(loopRun, pass);
  if (other?.ok) await blindVerdict(loopRun, pass, other);
  else out.verdict = { against: againstKey, error: "the other build could not be observed" };
  return worker;
}

/** An answer the art director could not give: no verdict, never a "no". */
const unreadShip = (why: unknown): ShipReview => ({
  ship: null,
  defects: [],
  doNotRegress: [],
  reason: String((why as Error)?.message ?? why).slice(0, CLIP_REASON),
  parse: JudgeParse.Invalid,
});

/**
 * The do-not-regress list the run keeps after a review on integration: a review with a verdict
 * replaces it, and one nobody could read leaves the last list standing.
 */
function doNotRegressAfter(last: LastShip | null | undefined, review: ShipReview): string[] {
  if (typeof review.ship !== "boolean") return last?.doNotRegress ?? [];
  return review.doNotRegress ?? [];
}

/**
 * The art director's absolute look (`ship=yes`, loop/ship-review.ts) at the build this pass saw at
 * `SHIP_VIEW`: ship or not, the defects grouped by the plan part that owns them, what already works
 * and must stay, and what next. On the integration branch its defects go to their owners and its
 * do-not-regress list to every running loop worker (art-direction.ts), and its word is kept as
 * `state.lastShip` for that head, which the journal carries across a Resume.
 */
async function shipStep(loopRun: LoopRun, pass: JudgePass): Promise<void> {
  const { ctx, integrationWorktree, run, state } = loopRun;
  const { evidence, handle, head, out, target } = pass;
  if (!pass.ship) return;
  if (!evidence.ok) {
    out.ship = { ship: null, error: "the build could not be looked at, so the art director did not judge it" };
    return;
  }
  // Only a leased window is sized (evidence.ts `sizeWindow`): a look with none was taken at its own size.
  const view = handle ? SHIP_VIEW : null;
  const asking = () => shipReview(ctx, { run: judgeRun(loopRun, pass), evidence, parts: shipParts(state.plan), view });
  const patience = { deadline: judgeDeadline(loopRun, pass), delays: outageDelays(run), label: "the art director" };
  const review = await withProviderPatience(ctx, asking, patience).catch(unreadShip);
  const onIntegration = target.root === integrationWorktree;
  if (onIntegration) {
    routeShipDefects(loopRun, review);
    const doNotRegress = doNotRegressAfter(state.lastShip, review);
    state.lastShip = { head, ship: review.ship, defects: review.defects, doNotRegress, at: Date.now() };
  }
  out.ship = {
    ship: review.ship,
    defects: review.defects,
    defectsByPart: defectsByPart(review.defects),
    doNotRegress: review.doNotRegress ?? [],
    reason: review.reason,
    next: shipNext(review),
    ...(review.judged ? { judged: review.judged } : {}),
  };
}

/**
 * The question and answer a judge's one verdict record carries: the lead's own question when it
 * asked one, else the art director's (`SHIP_QUESTION`), so one look is one record and one line in
 * the chat. The judge calls are the blind verdict's and the art director's.
 */
function askedOnRecord(out: AnyRecord): { question: string | null; answer: boolean | null; judgeCalls: number } {
  const shipCalls = typeof out.ship?.ship === "boolean" ? 1 : 0;
  const judgeCalls = (out.verdict?.pick ? 1 : 0) + shipCalls;
  if (out.answer?.question) return { question: out.answer.question, answer: out.answer.yes ?? null, judgeCalls };
  if (out.ship) return { question: SHIP_QUESTION, answer: out.ship.ship ?? null, judgeCalls };
  return { question: null, answer: null, judgeCalls };
}

/**
 * Which of the four things this pass actually established, in the order the user cares about: a
 * preference over another build, then a first build with nothing to compare, then whether it ran
 * at all. Saying "the judge passed it" for any of the others would be a lie — so a pass that only
 * looked decides nothing (`kept: null`).
 */
function judgeRule(evidence: Evidence, verdict: AnyRecord | undefined): VerdictRule {
  if (!evidence.ok) return VerdictRule.DoesNotStart;
  if (verdict?.firstBuild) return VerdictRule.FirstBuild;
  if (verdict?.pick === Side.Challenger) return VerdictRule.Preferred;
  if (verdict?.pick) return VerdictRule.NotPreferred;
  return VerdictRule.Starts;
}

/** What a judge's rule keeps: only a preference keeps a build, and a look alone decides nothing. */
function keptByJudge(rule: VerdictRule): boolean | null {
  if (rule === VerdictRule.Preferred) return true;
  if (rule === VerdictRule.Starts || rule === VerdictRule.FirstBuild) return null;
  return false;
}

/** The judge's one line in the run's log. */
function judgedNote(label: string, evidence: Evidence, out: AnyRecord): string {
  const seen = evidence.ok ? "observed" : `not judgeable (${(evidence.problems ?? []).join("; ")})`;
  let verdict = "";
  if (out.verdict?.pick) verdict = `, verdict ${out.verdict.pick}`;
  else if (out.verdict?.firstBuild) verdict = ", the first build — nothing to compare it with";
  return `judged ${label}: ${seen}${verdict}`;
}

/** The judge's record: its verdict file, the verdict every pass writes, and the evidence card. */
async function recordJudgement(loopRun: LoopRun, pass: JudgePass, scored: CheckResult[], againstWorker: Worker | null) {
  const { appendRun, ctx, recordVerdict, run, consoleInheritedBy } = loopRun;
  const { againstKey, evidence, head, n, out, target } = pass;
  await ctx
    .call(HostMethod.RunArtifact, {
      runId: run.runId,
      name: `director/judge_${n}/verdict.json`,
      base64: Buffer.from(JSON.stringify(out, null, 2)).toString("base64"),
    })
    .catch(() => {});
  const rule = judgeRule(evidence, out.verdict);
  await recordVerdict({
    pass: VerdictPass.Judge,
    head,
    worker: target.worker?.id ?? null,
    against: out.verdict?.pick ? againstWords(againstKey, { workerTitle: namedTitle(againstWorker) }) : null,
    ...observedFrom(evidence),
    consoleInherited: consoleInheritedBy(target.worker),
    planned: scored,
    unmeasured: scored.filter((entry) => entry.pass !== true && entry.pass !== false).map((entry) => entry.id),
    pick: out.verdict?.pick ?? null,
    ...askedOnRecord(out),
    kept: keptByJudge(rule),
    rule,
  });
  if (out.answer?.question)
    await appendRun(RunEvent.RunVisualEvidence, {
      head,
      question: out.answer.question,
      answer: out.answer.yes,
      note: out.answer.note ?? null,
    }).catch(() => {});
}

/** One judge pass on the window it leased: look, score, ask, compare, and write it all down. */
async function judgeOnWindow(loopRun: LoopRun, ask: JudgeAsk, handle: string | null): Promise<string> {
  const { consoleInheritedBy, ctx, integrationWorktree, journal, note, patientEvidence, run, saveJournal, state } =
    loopRun;
  const { target, n, head, cameras } = ask;
  ctx.setStatus(`run ${run.runId} · director judging ${target.label}`);
  const evidence = await patientEvidence(target.root, {
    handle,
    label: `judge_${n}`,
    cameras: cameras.length ? cameras : null,
    setup: target.worker?.setup ?? run.setup ?? null,
    scaffold: state.baseHeads.has(head),
    inheritedConsole: consoleInheritedBy(target.worker),
    // The art director looks at a real screen's size; the window is 960×600 again once released.
    // Its whole-game look also races the throttle-only bot, so it is told how hard the race is.
    ...(ask.ship ? { viewport: SHIP_VIEW, challenge: true } : {}),
  });
  const onIntegration = target.root === integrationWorktree;
  rememberJudgedHead(loopRun, head, evidence);
  // The judge's word on the integration branch counts at the close, next to the health
  // pass — but only for what it is. Filled in below with the pick, what the pick was
  // against, the answer and the board, because "the judge could look at it" is not "the
  // judge preferred it", and a pick over a worker's dead end is not one over the start.
  const judgement: AnyRecord = {
    head,
    ok: evidence.ok === true,
    against: null,
    pick: null,
    answer: null,
    boardAllPass: null,
    at: Date.now(),
    ...(ask.final ? { final: true } : {}),
  };
  // A look only the art director asked for never replaces a verdict already standing on this head.
  const keepsJudgement = onIntegration && !(shipOnly(ask) && holdsVerdict(state.lastJudge, head));
  if (keepsJudgement) state.lastJudge = judgement;
  const pass: JudgePass = { ...ask, handle, evidence, out: judgeOut(loopRun, target.label, evidence), judgement };
  /** The checks this pass scored, one entry each — the verdict record keeps them, not only their tally. */
  const scored = await scoreJudgeChecks(loopRun, pass);
  await askJudgeQuestion(loopRun, pass);
  /** The worker whose build this one was put beside, when it was put beside one. */
  const againstWorker = await compareJudged(loopRun, pass);
  await shipStep(loopRun, pass);
  pass.out.head = head ?? null;
  if (keepsJudgement) journal.director.lastJudge = judgement;
  if (onIntegration) await saveJournal();
  await recordJudgement(loopRun, pass, scored, againstWorker);
  note(judgedNote(target.label, evidence, pass.out));
  ctx.setStatus(`run ${run.runId} · director`);
  return JSON.stringify(pass.out);
}

export async function judge(
  loopRun: LoopRun,
  args: AnyRecord,
  { borrow = false, final = false, until = Number.POSITIVE_INFINITY }: JudgeOptions = {},
) {
  const { resolveRoot, state, withLease } = loopRun;
  const target = resolveRoot(args.target);
  if (target.error !== undefined) return target.error;
  const ship = yes(args.ship, false);
  const named = String(args.against ?? "").trim();
  // The art director's look is absolute and at its own size: never beside a build seen at another.
  if (ship && named && named !== Against.None) return SHIP_ALONE;
  const againstKey = named || (ship ? Against.None : Against.Start);
  const cameras = list(args.cameras);
  const checksRaw = parseJson(args.checks);
  if (checksRaw?.__error) return `checks: ${checksRaw.__error}`;
  const n = ++state.judges;
  const head = await judgedHead(loopRun, target);
  const ask: JudgeAsk = {
    target,
    againstKey,
    cameras,
    checksRaw,
    question: args.question,
    n,
    head,
    final,
    until,
    ship,
  };
  // The lead's judge is a choice, not an obligation: when every window is a worker's, the director
  // is told so and picks its moment, rather than the studio taking the user's window for it. The
  // close's judge of what it makes live is not a choice, and borrows the window as the close's look does.
  const looked = await withLease(WindowLease.Judge, (handle: string | null) => judgeOnWindow(loopRun, ask, handle), {
    borrow,
  });
  return typeof looked === "string" ? looked : looked.noWindow;
}

/** Is this pass the art director's look alone: no comparison, question or checks of the lead's. */
function shipOnly(ask: JudgeAsk): boolean {
  const checks = Array.isArray(ask.checksRaw) && ask.checksRaw.length > 0;
  return ask.ship === true && ask.againstKey === Against.None && !ask.question && !checks;
}

/** Does the judge standing on `head` hold a verdict: a blind pick, or a sure answer. */
function holdsVerdict(judged: LastJudge | null, head: string | null): boolean {
  return Boolean(judged && judged.head === head && (judged.pick || typeof judged.answer === "boolean"));
}

/**
 * Whether the judge standing on `head` is already the final word the close owes: the close's own
 * verdict or answer (one that came to nothing, on a resume, is asked again), or a lead's blind pick
 * over the build the user had. A lead's free-text question, or a pick over a worker's branch, is
 * not that judgement, and the close judges again.
 */
function finallyJudged(judged: LastJudge | null, head: string | null): boolean {
  if (!judged || judged.head !== head) return false;
  if (judged.final === true) return Boolean(judged.pick) || typeof judged.answer === "boolean";
  const againstTheStart = judged.against === Against.Start || judged.against === Against.Live;
  return againstTheStart && Boolean(judged.pick);
}

/**
 * The close's judge of the build it is about to make live (integrate.ts `landWhatRuns`), whoever
 * ended the run and however fast the user wanted it. Judging was the lead's choice, and every
 * prompt of a hurried run (the wrap-up, the user's finish, the goal card) sent it straight to
 * finish, so builds went live with no judge having looked. A build the user had a picture of is
 * compared blind with it; a new game, or one whose start nobody could photograph, is asked whether
 * it shows what the user asked for. It looks through the studio's window when every other is
 * taken, its calls end by `FINAL_JUDGE_MS` (and with the user's Stop), and its word is kept as
 * every judge's is (`state.lastJudge`, a judge verdict), for the landing's claim.
 */
export async function judgeTheLanding(loopRun: LoopRun, head: string | null): Promise<void> {
  const { note } = loopRun;
  const ask = closeJudgeAsk(loopRun, head);
  if (!ask) return;
  const options = { borrow: true, final: true, until: Date.now() + FINAL_JUDGE_MS };
  await judge(loopRun, ask, options).catch((err: unknown) =>
    note(
      `the close could not judge ${shortSha(head)}: ${String((err as Error)?.message ?? err).slice(0, CLIP_REASON)}`,
    ),
  );
}

/**
 * The judge the close owes `head`, as `judge` arguments: blind against the build the user had when
 * there is a picture of it, else the goal question on its own — or null when the run is stopping or
 * a judge on that head already holds the close's word (`finallyJudged`). The art director's finish
 * gate reads it, so its one look can answer the question and the close need not look again.
 */
export function closeJudgeAsk(loopRun: LoopRun, head: string | null): AnyRecord | null {
  const { ctx, run, state } = loopRun;
  if (ctx.cancelled || finallyJudged(state.lastJudge, head)) return null;
  const comparable = !state.fromScratch && Boolean(state.startEvidence);
  return comparable
    ? { target: BuildTarget.Integration, against: Against.Start }
    : { target: BuildTarget.Integration, against: Against.None, question: finalJudgeQuestion(workingGoal(run)) };
}

// ── playtest ──

/** A playtester's answer, three ways: its pass as a word, as a status, and as a yes/no. */
const PLAY_WORDS = {
  yes: { status: "passed", said: "yes", answer: "yes" },
  no: { status: "failed", said: "no", answer: "no" },
  none: { status: "incomplete", said: "no answer", answer: "unmeasured" },
} as const;
const playWords = (pass: boolean | null | undefined) => {
  if (pass === true) return PLAY_WORDS.yes;
  if (pass === false) return PLAY_WORDS.no;
  return PLAY_WORDS.none;
};

/**
 * The playtester is a session of its own, and the studio allows one session per folder: the
 * director's own session lives in the integration worktree — or, for a lead that is its chat's
 * own session, in the game folder — so a playtest of the folder it sits in gets a worktree of its
 * own at the same commit (otherwise every playtest of the integrated build is refused), and so
 * does one of integration, which a merge may move under it. Answers the folder to
 * play in, or the refusal.
 */
async function playFolder(
  loopRun: LoopRun,
  root: string,
  n: number,
): Promise<{ playRoot: string; tempWorktree: string | null } | { refusal: string }> {
  const { ctx, integrationWorktree, lead, run, state } = loopRun;
  const leadSits = lead?.folder === root;
  if (root !== integrationWorktree && !leadSits) return { playRoot: root, tempWorktree: null };
  const refusal = await dirtyRefusal(loopRun, root, leadSits);
  if (refusal) return { refusal };
  const head = await headOf(ctx, root).catch(() => (leadSits ? null : state.integrationHead));
  const tempWorktree = (
    await ctx.call(HostMethod.SnapshotWorktree, {
      project: run.project,
      commit: head ?? undefined,
      name: `play-${n}`,
      runId: run.runId,
    })
  ).path;
  return { playRoot: tempWorktree, tempWorktree };
}

/**
 * Why a folder with uncommitted changes cannot be played from a copy of its commit, or null once it
 * is clean: the game folder a lead sits in is the user's own; a director with its own hands commits
 * first; and for a lead that writes nothing the studio sets aside what no worker made in the
 * integration worktree (lead-session.ts `setAsideStrays`).
 */
async function dirtyRefusal(loopRun: LoopRun, root: string, leadSits: boolean): Promise<string | null> {
  const { ctx, lead, run } = loopRun;
  const dirty = await gitAt(ctx, root, GIT.status).catch(() => "");
  if (!dirty) return null;
  if (leadSits) return LEAD_LIVE_DIRTY;
  if (!lead)
    return "your integration worktree has uncommitted edits — commit them first so the playtester plays what you see";
  try {
    await setAsideStrays(loopRun, `director:${run.runId}:playtest`);
    return null;
  } catch (err: any) {
    return LEAD_DIRTY(err?.message ?? err);
  }
}

/** Is the folder clean and where is it: a play only counts as evidence on a head nobody moved. */
async function folderState(loopRun: LoopRun, root: string): Promise<{ head: string | null; clean: boolean }> {
  const { ctx } = loopRun;
  const head = await headOf(ctx, root).catch(() => null);
  const clean = await gitAt(ctx, root, GIT.status)
    .then((status) => !status)
    .catch(() => false);
  return { head, clean };
}

/** One playtest in a folder that is the build: play it, record what it established, and answer. */
async function playIn(
  loopRun: LoopRun,
  { target, ask, n, playRoot, handle, budget, goalId, scenario }: AnyRecord,
): Promise<string> {
  const { appendRun, ctx, finalDeadline, note, run, softDeadline } = loopRun;
  const before = await folderState(loopRun, playRoot);
  // A playtest in the wrap-up plays until the wrap-up's end, not the working deadline behind it.
  const until = passDeadline({ now: Date.now(), softDeadline, finalDeadline });
  const played = await runPlaytest(ctx, {
    run: { ...run, setup: target.worker?.setup ?? run.setup ?? null },
    spec: { id: `play-${n}`, title: "director playtest", intent: ask, cameras: ["default"] },
    checks: [{ id: "director-play", kind: CheckKind.Play, ask, expect: "yes", weight: CheckWeight.Normal }] as Check[],
    root: playRoot,
    handle,
    deadline: Math.min(until, Date.now() + budget),
    iteration: n,
    labelPrefix: `director/play_${n}`,
    maxActions: PLAYTEST_MAX_ACTIONS,
  });
  const after = await folderState(loopRun, playRoot);
  const untouched = before.clean && after.clean && before.head === after.head;
  const result = played?.results?.[0] ?? null;
  const words = playWords(result?.pass);
  await appendRun(RunEvent.RunInteractionEvidence, {
    head: untouched ? before.head : null,
    label: ask,
    status: words.status,
    note: result?.note ?? result?.reason ?? null,
    source: "independent-playtester",
  }).catch(() => {});
  if (goalId && loopRun.state.goals && untouched && before.head && target.root === loopRun.integrationWorktree) {
    recordGoalEvidence(loopRun.state.goals, goalId, before.head, result?.pass ?? undefined, scenario);
    await keepCheckpoint(loopRun, before.head);
    await loopRun.saveJournal();
  }
  const bigMove = played?.report?.bigMove ?? null;
  // A step beyond the ask is labelled for the lead and put to the user (facet/beyond.ts), never a move.
  const step = playtestStepWords(bigMove);
  note(`playtested ${target.label}: ${words.said}${step.note}`);
  if (step.card) await loopRun.decision(step.card, step.card);
  return JSON.stringify({
    target: target.label,
    question: ask,
    answer: words.answer,
    note: result?.note ?? result?.reason ?? "",
    actions: played?.report?.actions ?? 0,
    report: played?.report?.report ?? "",
    bigMove,
    ...(step.card ? { bigMoveOutsideAsk: "put to the user as a decision card; never a move" } : {}),
  });
}

export async function playtest(loopRun: LoopRun, args: AnyRecord) {
  const { ctx, resolveRoot, run, state, withLease } = loopRun;
  const target = resolveRoot(args.target);
  if (target.error !== undefined) return target.error;
  const goal = state.goals?.entries.find((entry) => entry.id === args.goal);
  if (args.goal && !goal) return "Unknown required goal; read run_status.";
  if (goal && target.root !== loopRun.integrationWorktree) return "Goal evidence must verify the integration revision.";
  const scenario = args.scenario === undefined ? undefined : Number(args.scenario);
  if (
    goal &&
    scenario !== undefined &&
    (!Number.isInteger(scenario) || scenario < 0 || scenario >= goal.acceptance.length)
  )
    return "scenario must name a zero-based acceptance index from run_status";
  const scenarios = scenario === undefined ? goal?.acceptance : [goal?.acceptance[scenario]];
  const ask = goal
    ? `Verify every required scenario through actual interaction: ${scenarios?.join("; ")}. Report no or unmeasured when a dependency or hosted two-client route is unavailable. Screenshots and protocol tests alone cannot prove multiplayer.`
    : String(args.ask ?? "").trim();
  if (!ask) return "playtest needs one yes/no question (ask)";
  const n = ++state.plays;
  const budget =
    Math.min(PLAYTEST_MAX_MINUTES, Math.max(PLAYTEST_MIN_MINUTES, num(args.minutes, PLAYTEST_DEFAULT_MINUTES))) *
    MINUTE_MS;
  // A playtest is a whole session of its own; it waits for a window rather than taking the user's.
  const answer = await withLease(WindowLease.Playtest, async (handle: string | null) => {
    ctx.setStatus(`run ${run.runId} · director playtesting ${target.label}`);
    const folder = await playFolder(loopRun, target.root, n);
    if ("refusal" in folder) return folder.refusal;
    try {
      return await playIn(loopRun, {
        target,
        ask,
        n,
        playRoot: folder.playRoot,
        handle,
        budget,
        goalId: goal?.id,
        scenario,
      });
    } catch (err: any) {
      return `playtest failed: ${err?.message ?? err}`;
    } finally {
      if (folder.tempWorktree)
        await ctx
          .call(HostMethod.SnapshotRemoveWorktree, { project: run.project, path: folder.tempWorktree })
          .catch(() => {});
      ctx.setStatus(`run ${run.runId} · director`);
    }
  });
  await finishBlockedGoals(loopRun);
  return typeof answer === "string" ? answer : answer.noWindow;
}

export async function show(loopRun: LoopRun, args: AnyRecord) {
  const { appendRun, ctx, projectDir, resolveRoot, run } = loopRun;
  const target = resolveRoot(args.target);
  if (target.error !== undefined) return target.error;
  try {
    await ctx.call(HostMethod.PreviewLoad, {
      project: run.project,
      ...(target.root !== projectDir ? { root: target.root } : {}),
    });
    await appendRun(RunEvent.DirectorShow, { target: target.label, root: target.root });
    const what = target.root === projectDir ? "the game folder" : target.label;
    return `Live's Reload now offers ${what}: the user sees it when they press it`;
  } catch (err: any) {
    return `could not show ${target.label}: ${err?.message ?? err}`;
  }
}

/** Does this line of the run's log wake a `worker_wait` that asked only about `only` (or about nobody)? */
const wakes = (only: string | null, text: string): boolean =>
  !only || text.includes(`worker ${only}`) || text.startsWith("USER");

export async function wait(loopRun: LoopRun, args: AnyRecord) {
  const { ctx, finalDeadline, inbox, ledgerLines, note, notesSince, routeUserSteers, softDeadline, state } = loopRun;
  const seconds = Math.min(MAX_WAIT_S, Math.max(1, num(args.seconds, WAIT_DEFAULT_S)));
  const asked = args.worker ?? args.id;
  const only = asked ? slug(asked) : null;
  const from = loopRun.waitSeq;
  const until = Date.now() + seconds * SECOND_MS;
  const finishing0 = await inbox.finishing().catch(() => false);
  while (Date.now() < until && !ctx.cancelled) {
    // Only the steers no wait this run has passed on yet: the director hears each one once. A
    // resumed run says them all once more, since its director may be a fresh session.
    const fresh = await inbox.steering(undefined, true, { onlyNew: true }).catch(() => []);
    for (const text of fresh) note(`USER SAYS: ${text}`);
    await routeUserSteers().catch(() => {});
    const finishing = await inbox.finishing().catch(() => false);
    if (finishing && !finishing0)
      note("USER ASKS TO FINISH: wrap up the current work, integrate what is ready, and call finish");
    // A builder that newly waits on the person is told in the log, which wakes this wait.
    await waitingBuilders(loopRun).catch(() => null);
    const news = notesSince(from).filter((entry: { text: string }) => !rejectedNews(loopRun, entry.text));
    if (news.some((entry: { text: string }) => wakes(only, entry.text))) break;
    await sleep(SECOND_MS);
  }
  const asking = await waitingBuilders(loopRun).catch(() => new Map<string, string>());
  const unread = notesSince(from);
  // A worker the lead rejected is not news any more (`worker_mark rejected`).
  const happened = unread.map((e: { text: string }) => e.text).filter((text) => !rejectedNews(loopRun, text));
  // Snapshot before the later status awaits: a note arriving during those awaits belongs
  // to the next response. Never consume a notification that has not been returned.
  const lastUnread = unread.at(-1);
  if (lastUnread) loopRun.waitSeq = Math.max(loopRun.waitSeq, lastUnread.seq);
  // What a waiting director needs is what changed: the news, one line per worker (the monitor's
  // included), where integration stands and what the user has said — never the whole status
  // blob (every board, the window pool, the screen strip), which every turn would carry again.
  // `run_status` is one call away for the rest.
  const now = Date.now();
  return JSON.stringify({
    waitedSeconds: Math.round(seconds - Math.max(0, until - now) / SECOND_MS),
    happened: happened.length ? happened : ["nothing yet"],
    status: {
      time: { sessionMinutesLeft: minutes(softDeadline - now), hardMinutesLeft: minutes(finalDeadline - now) },
      integration: {
        head: state.integrationHead ? shortSha(state.integrationHead) : null,
        lastHealthPass: state.integrationHealthy,
        ...(state.ledger.length ? { defectsNobodyOwns: ledgerLines() } : {}),
      },
      workers: unrejected(loopRun, [...state.workers.values()]).map((w) => withQuestion(waitDigest(w, now), asking)),
      // What the user said is already in `happened`, as USER SAYS; this is the standing request.
      user: { finishRequested: await inbox.finishing().catch(() => false) },
    },
  });
}

// ── the tools that act on one worker, and the note ──

/** A builder's digest, with the question it waits on the person with, if any. */
function withQuestion(digest: AnyRecord, asking: ReadonlyMap<string, string>): AnyRecord {
  const question = asking.get(String(digest.id));
  return question ? { ...digest, waitingForPerson: question } : digest;
}

/** Every worker: this session's, then those from before a pause (what the journal kept of them), then its readers. */
async function everyWorkerStatus(loopRun: LoopRun): Promise<string> {
  const { state } = loopRun;
  const asking = await waitingBuilders(loopRun).catch(() => new Map<string, string>());
  const current = [...state.workers.values()].map((w) => withQuestion(workerDigest(w), asking));
  const builders = [...current, ...priorWorkersStatus(loopRun)];
  const readers = await readerLines(loopRun);
  return JSON.stringify(readers ? [...builders, { readers: readers.split("\n") }] : builders);
}

/** One worker in detail — one from before a pause as the journal kept it — or every worker when no id is given. */
async function workerStatus(loopRun: LoopRun, args: AnyRecord): Promise<string> {
  const { state } = loopRun;
  if (!args.id) return everyWorkerStatus(loopRun);
  const worker = state.workers.get(slug(args.id));
  if (!worker) {
    const prior = priorWorkerStatus(loopRun, slug(args.id));
    return prior ? JSON.stringify(prior) : `no worker "${args.id}"`;
  }
  const asking = await waitingBuilders(loopRun).catch(() => new Map<string, string>());
  return JSON.stringify({
    ...withQuestion(workerDigest(worker), asking),
    brief: worker.brief.slice(0, STATUS_BRIEF_CHARS),
    iterationsDetail: worker.iterations.slice(-STATUS_ITERATIONS),
    attempts: (worker.result?.attempts ?? []).slice(-STATUS_ATTEMPTS),
    summary: worker.summary || undefined,
    problems: worker.problems.length ? worker.problems : undefined,
    unsatisfiable: worker.unsatisfiable?.length ? worker.unsatisfiable : undefined,
    steeringQueued: worker.steering.length,
    board: worker.result?.board ? renderScoreboard(worker.result.board) : undefined,
  });
}

/**
 * A rung on the running worker's ladder (M3.3). The loop reads `spec.milestones` at the top of
 * every iteration, and a `steered` rung goes ahead of the rest of the ladder, so the next one
 * builds this and not what the harness would have named, nor the rung it was on — and from here
 * on the ladder is the director's, ending with an open rung (facet/growth.ts) when it had none.
 * Answers the rung, or why there is none.
 */
function addRung(worker: Worker, moveText: string): { rung: AnyRecord } | { refusal: string } {
  if (!worker.spec)
    return {
      refusal: `worker ${worker.id} has no ladder to add a move to — it is a single session; send it text instead`,
    };
  const climbed = worker.spec.milestones ?? [];
  const milestone = normalizeMilestone({ what: moveText }, climbed.length);
  if (!milestone) return { refusal: "move: one sentence saying what the game IS after this iteration" };
  // The same sentence twice is a new rung, not the one already climbed.
  const id = climbed.some((m: { id: string }) => m.id === milestone.id)
    ? `${milestone.id}-${climbed.length + 1}`
    : milestone.id;
  const rung = { ...milestone, id, steered: true };
  worker.spec.milestones = withOpenRung([...climbed, rung]);
  worker.spec.moveOwner = MoveOwner.Director;
  return { rung };
}

/** Where a steer is now: interrupted into the build turn, waiting a minute for the next one, or queued. */
function arrivalWords(worker: Worker, text: string, reached: boolean, nowAsked: boolean): string {
  if (!text) return "";
  if (reached)
    return `${worker.id}'s build turn was interrupted and it is carrying on with your instruction in front of everything`;
  if (nowAsked)
    return `${worker.id} is between turns; it reads your instruction at the top of the next one, a minute away`;
  return `queued for ${worker.id}'s next round`;
}

/** The answer to a steer: where the instruction is, and the move its next round builds. */
function steerAnswer(worker: Worker, arrival: string, rung: AnyRecord | null, text: string): string {
  if (rung && text) return `${arrival}. Its next round builds the move you named.`;
  if (rung) return `${worker.id}'s next round builds it as THE MOVE (mandatory)`;
  return arrival;
}

/**
 * The stage a steer names, set on the spec the loop reads every round (facet/stage.ts); a move
 * always takes a finishing worker back to the build stage, because the director's explicit move
 * wins. Answers the sentence to add to the steer's answer ("" when the stage did not change).
 */
function steerStage(worker: Worker, stage: FacetStage | null, moved: boolean): string {
  if (!worker.spec) return "";
  if (stage !== null) {
    worker.spec.stage = stage;
    return steerStageWords(worker.id, stage === FacetStage.Finish);
  }
  if (!moved || !isFinishing(worker.spec)) return "";
  worker.spec.stage = FacetStage.Build;
  return STEER_BACK_TO_BUILD;
}

/** What a steer puts on the run's record when it carries no text of its own. */
function steerRecordText(moveText: string, stage: FacetStage | null): string {
  if (moveText) return `the next move: ${moveText}`;
  return `the stage: ${stage}`;
}

/** Why this steer cannot be taken: nothing in it, a worker that is not running, or a stage for a single session. */
function steerRefusal(worker: Worker, text: string, moveText: string, stage: FacetStage | null): string | null {
  if (!text && !moveText && !stage) return STEER_EMPTY_REFUSAL;
  if (!isRunning(worker))
    return `worker ${worker.id} is ${worker.state}; start a new worker with the instruction in its brief`;
  if (stage && !worker.spec) return steerStageRefusal(worker.id);
  return null;
}

/** The steer's move and stage, on the spec the loop reads: the rung it added and the stage sentence, or a refusal. */
function steerLadder(
  worker: Worker,
  moveText: string,
  stage: FacetStage | null,
): { rung: AnyRecord | null; words: string } | { refusal: string } {
  const added = moveText ? addRung(worker, moveText) : { rung: null };
  if ("refusal" in added) return added;
  return { rung: added.rung, words: steerStage(worker, stage, Boolean(added.rung)) };
}

async function steerWorker(loopRun: LoopRun, args: AnyRecord): Promise<string> {
  const { appendRun, interruptWorker, state } = loopRun;
  const worker = state.workers.get(slug(args.id));
  if (!worker) return `no worker "${args.id}"`;
  const text = String(args.text ?? "").trim();
  const moveText = String(args.move ?? "").trim();
  const staged = stageArg(args.stage, { move: moveText });
  if (staged.error !== undefined) return staged.error;
  const refusal = steerRefusal(worker, text, moveText, staged.stage);
  if (refusal) return refusal;
  const ladder = steerLadder(worker, moveText, staged.stage);
  if ("refusal" in ladder) return ladder.refusal;
  const { rung } = ladder;
  // A single session is only ever steered now — it has no boundary to wait for.
  const nowAsked = worker.mode !== WorkerMode.Loop || yes(args.now, false);
  if (text) worker.steering.push(text);
  await appendRun(RunEvent.RunSteering, {
    text: text || steerRecordText(moveText, staged.stage),
    facetId: worker.id,
    source: SteeringSource.Director,
    now: nowAsked,
    at: new Date().toISOString(),
  });
  const reached = text && nowAsked ? await interruptWorker(worker) : false;
  const answer = steerAnswer(worker, arrivalWords(worker, text, reached, nowAsked), rung, text);
  return [answer, ladder.words].filter(Boolean).join(". ");
}

async function stopWorkerTool(loopRun: LoopRun, args: AnyRecord): Promise<string> {
  const { decision, run, state, stopWorker } = loopRun;
  const worker = state.workers.get(slug(args.id));
  if (!worker) return `no worker "${args.id}"`;
  if (!isRunning(worker)) return `worker ${worker.id} is already ${worker.state}`;
  const why = String(args.why ?? "").trim();
  const at = worker.mode === WorkerMode.Loop ? worker.iterations.length + 1 : 1;
  await stopWorker(worker, why);
  await decision(
    `director stopped worker ${worker.id}${why ? `: ${why}` : ""}`,
    `stopped the builder working on ${worker.title}${why ? ` — ${why}` : ""}`,
  );
  // What actually happens, so the director does not have to guess: the edits it had
  // written are committed where they stand, the round is recorded as stopped rather
  // than judged, and integrate still takes only what the loop accepted.
  return [
    `stop requested for ${worker.id}${why ? ` (${why})` : ""}.`,
    worker.mode === WorkerMode.Loop
      ? `Its unfinished edits are committed in ${worker.worktree}, kept on ${attemptRef(run.runId, worker.id, at, { stopped: true })} — nothing is reset, and that round is recorded as stopped, not judged.`
      : `Whatever it had written is committed in ${worker.worktree} as its last commit.`,
    `Its last accepted commit${worker.lastCommit ? ` (${shortSha(worker.lastCommit)})` : ""} is what integrate would take; worker_status once it settles.`,
  ].join(" ");
}

async function noteTool(loopRun: LoopRun, args: AnyRecord): Promise<string> {
  const { decision, journal, saveJournal } = loopRun;
  const text = String(args.text ?? "").trim();
  if (!text) return "note needs text";
  journal.director.notes.push({
    at: new Date().toISOString(),
    text: text.slice(0, NOTE_CHARS),
    plain: plainly(String(args.plain ?? "").trim() || text).slice(0, NOTE_PLAIN_CHARS),
  });
  await saveJournal();
  await decision(`director: ${text}`, String(args.plain ?? "").trim() || null);
  return "noted";
}

/** Pause only when no independent required work remains; preserve the integrated checkpoint. */
async function finishBlockedGoals(loopRun: LoopRun): Promise<void> {
  const ledger = loopRun.state.goals;
  if (!ledger || goalDecision(ledger, loopRun.state.integrationHead) !== GoalStatus.Blocked) return;
  const blockers = ledger.entries
    .filter((goal) => goal.status === GoalStatus.Blocked)
    .map((goal) => `${goal.id}: ${goal.blocker}`);
  await loopRun.finish({
    summary: `Required work is blocked (${blockers.join("; ")}). The integration checkpoint is retained. Resolve the prerequisite or revise the approach, then Resume.`,
    land: "no",
    victory: "no",
  });
}

/** Goal updates can explain missing work, but cannot create acceptance evidence. */
async function updateGoal(loopRun: LoopRun, args: AnyRecord): Promise<string> {
  const goal = loopRun.state.goals?.entries.find((entry) => entry.id === args.goal);
  if (!goal) return "Unknown required goal; read run_status.";
  const blocker = Object.values(GoalBlocker).find((code) => code === args.blocker);
  if (blocker) {
    goal.status = GoalStatus.Blocked;
    goal.blocker = blocker;
  } else if (!replanGoal(goal, args.replan))
    return "Supply a typed blocker or the one concrete replan; passing requires independent playtest evidence.";

  await loopRun.saveJournal();
  await finishBlockedGoals(loopRun);
  return JSON.stringify(goal);
}

/** A tool's answer to the director's session: a sentence, or a JSON string. */
type ToolAnswer = unknown;
type Tool = (loopRun: LoopRun, args: AnyRecord) => ToolAnswer | Promise<ToolAnswer>;

/**
 * The run's plan and its worker starts, one at a time. A lead that calls them in parallel (a
 * Codex lead does) had a start read the plan another call was still writing, and two starts claim
 * the same id or window. Each waits for the one before; a failure does not block the next.
 */
const PLAN_CHANGES = new WeakMap<LoopRun, Promise<unknown>>();

function oneAtATime<T>(loopRun: LoopRun, change: () => T | Promise<T>): Promise<T> {
  const next = (PLAN_CHANGES.get(loopRun) ?? Promise.resolve()).then(change);
  PLAN_CHANGES.set(
    loopRun,
    next.catch(() => {}),
  );
  return next;
}

/**
 * The tools another part of the run answers (workers.ts, integrate.ts, the looks above). The
 * handler returns their answer as it comes, as the switch it replaced always did: a failure in one
 * of them rejects the dispatch instead of becoming a `<tool> failed: …` sentence.
 */
const HANDED_OFF = {
  [DirectorTool.Plan]: (loopRun, args) => oneAtATime(loopRun, () => loopRun.setPlan(args)),
  // `task` is the brief's name; a kept prompt's `brief` is still read (`briefOf`).
  [DirectorTool.WorkerStart]: (loopRun, args) =>
    oneAtATime(loopRun, () => loopRun.startWorker({ ...args, brief: briefOf(args) })),
  [DirectorTool.Wait]: (loopRun, args) => loopRun.wait(args),
  [DirectorTool.Judge]: (loopRun, args) => loopRun.judge(args),
  [DirectorTool.Playtest]: (loopRun, args) => loopRun.playtest(args),
  [DirectorTool.Integrate]: (loopRun, args) => loopRun.integrate(args),
  [DirectorTool.Show]: (loopRun, args) => loopRun.show(args),
  [DirectorTool.Finish]: (loopRun, args) => loopRun.finish(args),
} satisfies Partial<Record<DirectorTool, Tool>>;

/** The tools this handler answers itself: it waits for each, so a failure is said as a sentence. */
const ANSWERED_HERE = {
  [DirectorTool.ResolveRoot]: (loopRun, args) => {
    const target = loopRun.resolveRoot(args.target);
    return target.error ?? target.root;
  },
  [DirectorTool.RunStatus]: async (loopRun) => JSON.stringify(await loopRun.statusText()),
  [DirectorTool.WorkerStatus]: workerStatus,
  [DirectorTool.WorkerSteer]: steerWorker,
  [DirectorTool.WorkerStop]: stopWorkerTool,
  [DirectorTool.Note]: noteTool,
  [DirectorTool.GoalUpdate]: updateGoal,
} satisfies Record<Exclude<DirectorTool, keyof typeof HANDED_OFF>, Tool>;

/** The worker tools of Genex's one model the director answers beside its own (no `DirectorTool` key of theirs). */
const WORKER_TOOLS_HERE = { [WorkerTool.Mark]: markWorker } satisfies Record<string, Tool>;

/**
 * The names a tool used to have: not offered, but a playbook or a journal an agent kept may still
 * call it, so it is answered as the tool it became.
 */
const OLD_NAMES: Readonly<Record<string, DirectorTool>> = { wait: DirectorTool.Wait };

/** A tool by the name the session called it, or null for a name the run does not answer. */
function toolNamed(called: string): { tool: Tool; answeredHere: boolean } | null {
  const name = Object.hasOwn(OLD_NAMES, called) ? (OLD_NAMES[called] as string) : called;
  if (Object.hasOwn(WORKER_TOOLS_HERE, name))
    return { tool: WORKER_TOOLS_HERE[name as keyof typeof WORKER_TOOLS_HERE], answeredHere: true };
  if (Object.hasOwn(ANSWERED_HERE, name))
    return { tool: ANSWERED_HERE[name as keyof typeof ANSWERED_HERE], answeredHere: true };
  if (Object.hasOwn(HANDED_OFF, name))
    return { tool: HANDED_OFF[name as keyof typeof HANDED_OFF], answeredHere: false };
  return null;
}

export async function handler(loopRun: LoopRun, name: string, args: AnyRecord): Promise<unknown> {
  if (loopRun.ctx.cancelled && name !== DirectorTool.ResolveRoot) return STOPPED_BY_USER;
  loopRun.toolCalls++;
  // Counted until its answer settles: the chat never cuts a turn short inside a call (wake.ts).
  loopRun.toolsInFlight = (loopRun.toolsInFlight ?? 0) + 1;
  try {
    return await timedOperation(
      name,
      typeof args.goal === "string" ? args.goal : null,
      () => answer(loopRun, name, args),
      (span) => {
        const director = loopRun.journal?.director;
        if (!director) return;
        retainSpan(director, { ...span, runId: loopRun.run.runId, head: loopRun.state.integrationHead });
      },
    );
  } finally {
    loopRun.toolsInFlight = (loopRun.toolsInFlight ?? 1) - 1;
    if (loopRun.state.finished) await loopRun.saveJournal().catch(() => {});
  }
}

/** One tool call's answer: a sentence, or the answer the part it hands off to gives. */
async function answer(loopRun: LoopRun, name: string, args: AnyRecord): Promise<unknown> {
  const { keepMemory, syncHead } = loopRun;
  try {
    // Every declared tool starts at the head the worktree actually stands on (`headSynced`).
    if (headSynced(name)) await syncHead();
    // Whatever the director last wrote into its memory file, kept where a resume can read it.
    await keepMemory();
    // A reader of the run's shared pool, or a start the web method refuses (`pooledAnswer`).
    const pooled = await pooledAnswer(loopRun, name, args);
    if (pooled !== null) return pooled;
    const named = toolNamed(name);
    if (!named) return `unknown director tool: ${name}`;
    if (named.answeredHere) return await named.tool(loopRun, args);
    // Not awaited on purpose: a handed-off tool's rejection passes this catch (see HANDED_OFF).
    return named.tool(loopRun, args);
  } catch (err: any) {
    return `${name} failed: ${err?.message ?? err}`;
  }
}
