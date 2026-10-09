import { CompletionPolicy } from "../completion-policy.ts";
import { createGoals, GoalBlocker, GoalStatus, restoreGoals } from "./goals.ts";
import { durationCommission, goalCommission } from "./commission.ts";
/**
 * The run's record in its run journal (`autopilot_<runId>`, the harness's own and durable):
 * everything a run needs to go on after a restart, a crash or a pause, and not only in the
 * harness's memory — the run's own clock; each worker's brief, seam, deadline, rounds and last
 * commit; the defects nobody owns; the plan and its review window; the integration's health; the
 * log and how much of it the lead has heard; and the wake loop's own state.
 *
 * Every save writes it (`recordLoopRun`, called by loop-run.ts `saveJournal`). A resumed run reads it
 * back (`restoreLoopRun`, called by setup.ts `prepareLoopRun`), and its lead's first message is a
 * digest built from it (wake.ts). The journal counts the time the run has worked, and a Resume
 * goes on with what the budget has left (`loopRunClock`): every Resume used to start the whole
 * budget again, so a run paused twice could run three times as long as the user gave it; and a
 * resumed lead knew nothing of its workers but their names.
 *
 * Its functions take the run explicitly; they are not bound onto it. It imports only names the
 * seed exported before it existed (tests/fixtures/seed-exports-pre-journal.json), and names from
 * modules newer than it (director/reopen.ts, loop/ship-review.ts): a seed upgrade keeps a module the
 * agent edited, and a name newer than that copy would not link.
 */
import { doNotRegressOf } from "../do-not-regress.ts";
import { WorkerState } from "../outcomes.ts";
import { FacetStage, isFinishing } from "../facet/stage.ts";
import { runRef } from "../repo.ts";
import { clip } from "../text.ts";
import { restoreVision } from "../vision.ts";
import { MAX_LEDGER, wrapReserveMs } from "./budgets.ts";
import {
  priorCommitWords,
  priorIdTaken,
  priorWorkerLeft,
  priorWorkersLine,
  priorWorkerState,
} from "./journal-prompts.ts";
import { priorEra } from "./reopen.ts";
import { DirectorLoop, WAKE_WINDOW_MS } from "./wake-schedule.ts";
import type { AnyRecord } from "../../types/harness.d.ts";
import type { ContractModule, ContractShared, ModuleContract } from "./module-contract.ts";
import type { LoopRun, LoopRunLogEntry, LoopRunState, Worker, WorkerLimit } from "./loop-run.ts";
import type { ShelvedDefect } from "./rules.ts";
import type { DigestWorker } from "./wake-prompts.ts";
import type { WakeState } from "./wake.ts";

/**
 * This part serves a lead that is its chat's own session and writes nothing (one session): a run
 * seats one only when every part it depends on says so (lead-session.ts `servesLead`).
 */
export const SERVES_LEAD = true;

/** How many of the run's log lines the journal keeps, the newest: a digest's news and a fresh start's past. */
export const JOURNAL_LOG_LINES = 60;
/** How much of a worker's brief the journal keeps. */
export const JOURNAL_BRIEF_CHARS = 600;
/** How much of why a worker or its last round stopped the journal keeps. */
export const JOURNAL_REASON_CHARS = 300;
/** How much of a worker-from-before's brief `run_status` carries. */
const STATUS_BRIEF_CHARS = 300;
/** The fewest characters of a commit's sha that name it, as `worker_start from=` reads one. */
const MIN_SHA_CHARS = 7;

/**
 * The run's own clock: when its working time ends and when it ends. `started` is when the run
 * would have started had it never paused, so the time it has worked is always `now - started`.
 */
export interface LoopRunClock {
  started: number;
  softDeadline: number;
  finalDeadline: number;
}

/** A worker from before the pause, as the journal kept it: not running now, but its work is on its ref. */
export interface PriorWorker {
  id: string;
  title: string;
  /** Its state when the journal last saw it: running means the run paused under it. */
  state: string;
  stoppedBecause: string | null;
  brief: string;
  owns: string[];
  from: string | null;
  rounds: number;
  accepted: number;
  /** Its last commit — its last accepted round's while it built. */
  lastCommit: string | null;
  ref: string;
  /** It was finishing (`stage=finish`): a lead that starts it again starts it in that stage. */
  stage?: FacetStage;
}

/** What the wake loop takes back from the journal on a Resume. */
export interface RestoredWake {
  idleAsked: boolean;
  wakesAt: number[];
  /** Lost sessions the run has already replaced: the allowance does not start again on a Resume. */
  freshSessions?: number;
  /** The finish mark was said: a Resume does not say it again. */
  finishMarkSaid?: boolean;
  /** The working time the art director's next regular look is due at (art-direction.ts `shipLookAt`). */
  nextShipLookWorkedMs?: number;
  /** The working time the lead was last nudged to verify its outcomes (progress.ts `verifyNudgeDue`). */
  verifyNudgedWorkedMs?: number;
}

/** A time for the journal: ISO, or null. */
const iso = (ms: number | null | undefined): string | null =>
  typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null;

/** A time from the journal — ISO or milliseconds — or null when it is not one. */
function msOf(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** A count from the journal. */
const countOf = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** How long the run had worked when its journal was last saved, or null when it kept no count (a run from before it did). */
function workedMsOf(saved: unknown): number | null {
  const worked = (saved as AnyRecord | null | undefined)?.workedMs;
  return typeof worked === "number" && Number.isFinite(worked) && worked >= 0 ? worked : null;
}

/**
 * The run's clock. A new run starts one; a resumed run goes on with the working time it had
 * left — the budget less the time it has worked, which its journal counts (`recordLoopRun`), never
 * the wall clock: time spent paused does not count, and time worked is never given back. A run
 * whose worked time used its working time gets only its wrap-up, the reserve long, to land what it
 * built.
 */
export function loopRunClock({ saved, now, totalMs }: { saved: unknown; now: number; totalMs: number }): LoopRunClock {
  const reserve = wrapReserveMs(totalMs);
  const worked = workedMsOf(saved) ?? 0;
  const started = now - worked;
  const clock = { started, softDeadline: started + totalMs - reserve, finalDeadline: started + totalMs };
  if (worked === 0 || now < clock.softDeadline) return clock;
  return { started, softDeadline: now, finalDeadline: now + reserve };
}

/** Why a worker stopped, in the words it was given (as digests.ts says it). */
const stopReasonOf = (worker: Worker): string | null =>
  worker.result?.stoppedBecause ?? worker.stopWhy ?? worker.error ?? null;

/** A worker's last round, as the journal keeps it. */
function lastRoundOf(rounds: readonly AnyRecord[]): AnyRecord | null {
  const last = rounds.at(-1);
  if (!last) return null;
  return {
    iteration: last.iteration,
    won: last.won === true,
    stopped: last.stopped === true,
    reason: clip(last.reason, JOURNAL_REASON_CHARS),
  };
}

/** One worker as the journal keeps it: enough to name it, go on from its work, and start it again. */
function workerRecord(worker: Worker, runId: string): AnyRecord {
  const rounds = worker.iterations as readonly AnyRecord[];
  const because = stopReasonOf(worker);
  return {
    id: worker.id,
    title: worker.title,
    mode: worker.mode,
    from: worker.from,
    startedAt: iso(worker.startedAt),
    endedAt: iso(worker.endedAt),
    deadline: iso(worker.deadline),
    state: worker.state,
    stoppedBecause: because ? clip(because, JOURNAL_REASON_CHARS) : null,
    brief: clip(worker.brief, JOURNAL_BRIEF_CHARS),
    owns: [...(worker.owns ?? [])],
    ownsMain: worker.ownsMain === true,
    rounds: rounds.length,
    accepted: rounds.filter((round) => round.won).length,
    lastRound: lastRoundOf(rounds),
    lastCommit: worker.lastCommit ?? worker.lastAccepted ?? null,
    ref: runRef(runId, "workers", worker.id),
    ...(worker.spec && isFinishing(worker.spec) ? { stage: FacetStage.Finish } : {}),
  };
}

/** The newest lines of the run's log, as the journal keeps them. */
function logRecord(log: readonly LoopRunLogEntry[]): LoopRunLogEntry[] {
  return log.slice(-JOURNAL_LOG_LINES).map(({ at, seq, text, kind }) => ({ at, seq, text, ...(kind ? { kind } : {}) }));
}

/** The run's own clock: the one prepareLoopRun kept on it, else the one it runs on (a kept older setup.ts). */
function clockOf(loopRun: LoopRun): LoopRunClock {
  return (
    loopRun.clock ?? {
      started: loopRun.started,
      softDeadline: loopRun.softDeadline,
      finalDeadline: loopRun.finalDeadline,
    }
  );
}

/** The workers' engine limit, as the journal keeps it. */
function limitRecord(limit: WorkerLimit | null): AnyRecord | null {
  return limit ? { ...limit, at: iso(limit.at) } : null;
}

/**
 * Put the run's record on its journal (`journal.director`), as every save does: its clock (its
 * own — a wrap-up that started early moves the working deadline, never this) and the time it has
 * worked, the plan and its review window, the defects nobody owns, the integration's last health
 * pass, the workers' engine limit, the log and how much of it the lead has heard, and every worker
 * of this session. Workers from before a pause keep the records the journal already had.
 * Idempotent: the wake loop writes it too (wake.ts `journalWake`), for a kept older loop-run.ts whose
 * save does not.
 */
export function recordLoopRun(loopRun: LoopRun, now = Date.now()): void {
  const director = loopRun.journal?.director;
  if (!director || !loopRun.state) return;
  const { state } = loopRun;
  const clock = clockOf(loopRun);
  Object.assign(director, {
    clock: {
      started: iso(clock.started),
      softDeadline: iso(clock.softDeadline),
      finalDeadline: iso(clock.finalDeadline),
      workedMs: Math.max(0, now - clock.started),
    },
    plan: state.plan,
    // Null, not absent: this run's outcomes wait for its plan, so a Resume never makes the old
    // plan's parts its outcomes (`restoreLoopRun`); absent is a journal from before outcomes were kept.
    goals: state.goals ?? null,
    planReview: { until: iso(state.planReviewUntil), go: state.planGo, saidFrom: state.planSaidFrom },
    ledger: [...state.ledger],
    integrationHealthy: state.integrationHealthy,
    workerLimit: limitRecord(state.workerLimit),
    log: logRecord(state.log),
    logSeq: loopRun.logSeq,
    heardSeq: loopRun.waitSeq,
    // A resumed or reopened run numbers its judge and playtest folders on from here (`restoreLoopRun`).
    judges: state.judges,
    plays: state.plays,
    // The module contract and the last wave's head, only once there is one: a journal of a run
    // with neither reads exactly as it did.
    ...(state.contract ? { contract: state.contract } : {}),
    ...(state.waveHead ? { waveHead: state.waveHead } : {}),
    // Written by a director that holds loop workers to a contract: a journal without it is from
    // before the gate, and a Resume of it goes on as it did (`restoreIntegration`). A run resumed
    // from one keeps not writing it until its lead commits a contract.
    ...(state.contractLegacy ? {} : { contractGate: true }),
  });
  // The art director's last word and a goal build's one turned-back finish: kept once there is one.
  if (state.lastShip) director.lastShip = { ...state.lastShip, at: iso(state.lastShip.at) };
  if (state.shipFinishRefused) director.shipFinishRefused = true;
  director.completionPolicy = durationCommission(loopRun.run) ? CompletionPolicy.Duration : CompletionPolicy.Goal;
  director.workers ??= {};
  for (const worker of state.workers.values()) director.workers[worker.id] = workerRecord(worker, loopRun.run.runId);
}

/**
 * The journal as a save compares it with what the last save wrote (loop-run.ts `saveJournal`): all of
 * it but the count of worked time, which moves every moment and is alone no reason to write a
 * version — the store keeps every one. Null when it cannot be read as JSON; it is then written.
 */
export function journalText(journal: AnyRecord): string | null {
  const clock = journal?.director?.clock;
  const director = clock ? { ...journal.director, clock: { ...clock, workedMs: undefined } } : journal?.director;
  try {
    return JSON.stringify({ ...journal, director });
  } catch {
    return null;
  }
}

/** The wake loop's own state, as the journal keeps it (wake.ts `journalWake` writes it). */
export function wakeRecord(
  wake: Pick<WakeState, "idleAsked" | "wrapCause" | "wakes" | "wakesAt" | "lastWakeAt" | "asleepSince"> & {
    freshSessions?: number;
    finishMarkSaid?: boolean;
    nextShipLookWorkedMs?: number | null;
    verifyNudgedWorkedMs?: number | null;
  },
): AnyRecord {
  return {
    loop: DirectorLoop.Wake,
    idleAsked: wake.idleAsked,
    freshSessions: wake.freshSessions ?? 0,
    wrapCause: wake.wrapCause,
    wakes: wake.wakes,
    wakesAt: wake.wakesAt.map(iso),
    lastWakeAt: iso(wake.lastWakeAt),
    asleepSince: iso(wake.asleepSince),
    ...(wake.finishMarkSaid ? { finishMarkSaid: true } : {}),
    // Working time, not wall time: a Resume's clock goes on from the time worked (`loopRunClock`).
    ...(workedMsOrNull(wake.nextShipLookWorkedMs) === null ? {} : { nextShipLookWorkedMs: wake.nextShipLookWorkedMs }),
    ...(workedMsOrNull(wake.verifyNudgedWorkedMs) === null ? {} : { verifyNudgedWorkedMs: wake.verifyNudgedWorkedMs }),
  };
}

/** A span of working time from the journal, or null when it is not one. */
function workedMsOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Does this run pick up one its journal kept: a Resume of a director's run? */
export function resumedFromJournal(loopRun: Pick<LoopRun, "resume" | "priorJournal">): boolean {
  return loopRun.resume === true && Boolean(loopRun.priorJournal?.director);
}

/** The defects nobody owns, as the journal kept them. */
function restoredLedger(saved: unknown): ShelvedDefect[] {
  if (!Array.isArray(saved)) return [];
  return saved
    .filter((defect): defect is AnyRecord => typeof defect?.text === "string" && defect.text.length > 0)
    .map((defect) => ({
      text: defect.text,
      from: String(defect.from ?? ""),
      owner: String(defect.owner ?? ""),
      at: msOf(defect.at) ?? 0,
    }))
    .slice(-MAX_LEDGER);
}

/**
 * The plan's review window, as the journal kept it. The window keeps its own closing time: a user
 * who had not answered when the run paused still has until then. A window that closed while the
 * run was paused has closed — the plan goes as it stands, and nothing waits or wakes for it.
 */
function restorePlanWindow(state: LoopRunState, saved: unknown, now: number): void {
  const window = (saved ?? {}) as AnyRecord;
  const until = msOf(window.until);
  const closedWhilePaused = until !== null && until <= now;
  if (window.go === true || closedWhilePaused) {
    state.planGo = true;
    return;
  }
  if (until === null) return;
  state.planReviewUntil = until;
  state.planSaidFrom = countOf(window.saidFrom);
}

/**
 * The workers' engine limit, as the journal kept it — none when it was not one, or when its reset
 * time passed while the run was paused. A limit with no reset time stands until a worker's
 * session comes back (workers.ts).
 */
function restoredWorkerLimit(saved: unknown, now: number): WorkerLimit | null {
  const limit = (saved ?? {}) as AnyRecord;
  const at = msOf(limit.at);
  if (at === null || typeof limit.kind !== "string" || typeof limit.engine !== "string") return null;
  const retryAfterMs = typeof limit.retryAfterMs === "number" ? limit.retryAfterMs : null;
  if (retryAfterMs !== null && at + retryAfterMs <= now) return null;
  return {
    engine: limit.engine,
    kind: limit.kind,
    message: String(limit.message ?? ""),
    retryAfterMs,
    at,
    worker: String(limit.worker ?? ""),
  };
}

/** A commit's hash, as the journal kept one. */
const commitOf = (value: unknown): string | null =>
  typeof value === "string" && /^[0-9a-f]{7,64}$/.test(value) ? value : null;

/**
 * The module contract its loop workers were held to and the head the last wave closed on, as the
 * journal kept them: a resumed run goes on holding its workers to the same contract.
 */
function restoreIntegration(state: LoopRunState, saved: AnyRecord): void {
  const contract = saved.contract as AnyRecord | undefined;
  const commit = commitOf(contract?.commit);
  if (commit && Array.isArray(contract?.spec?.modules)) {
    state.contract = { commit, spec: restoredSpec(contract.spec) };
    // Written on the run's start, it is still the start (contract-gate.ts): `startingHeads` gives
    // a resumed run its scaffold and base commit, and the contract's commit only from here.
    if (contract.onStart === true) state.contract.onStart = true;
    if (contract.baseHead === true) {
      state.contract.baseHead = true;
      state.baseHeads?.add(commit);
    }
    // The vision committed beside it: a resumed run does not ask its lead for it again.
    const vision = restoreVision(contract.vision);
    if (vision) state.contract.vision = vision;
  }
  // A plan saved by a director from before the contract gate (no `contractGate` mark): its parts
  // never said which run alone, and its workers' commits predate any contract, so its loop workers
  // start as they always did until its lead commits one (contract-gate.ts `exempt`).
  if (saved.plan && saved.contractGate !== true && !state.contract) state.contractLegacy = true;
  // A finished build reopened forks from the game folder as it is now (reopen.ts): the finished
  // run's wave head is an ancestor its workers would follow, missing the lead's new commits.
  const waveHead = saved.reopened ? null : commitOf(saved.waveHead);
  if (waveHead) state.waveHead = waveHead;
}

/** A saved contract with every list it is read by present: a partial journal never throws on the next worker_start. */
function restoredSpec(spec: AnyRecord): ModuleContract {
  const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
  const owned = (entry: unknown): entry is AnyRecord =>
    typeof (entry as AnyRecord)?.path === "string" && typeof (entry as AnyRecord)?.owner === "string";
  return {
    ...spec,
    conventions: array(spec.conventions).map(String),
    modules: array(spec.modules)
      .filter(owned)
      .map((module) => ({ ...module, api: array(module.api).map(String) }) as ContractModule),
    shared: array(spec.shared)
      .filter(owned)
      .map((entry) => entry as ContractShared),
  };
}

/** The log's newest lines as the journal kept them, and how much of it the lead has heard. */
function restoreLog(loopRun: LoopRun, saved: AnyRecord): void {
  const log = (Array.isArray(saved.log) ? saved.log : []).filter(
    (entry: AnyRecord): entry is LoopRunLogEntry => typeof entry?.seq === "number" && typeof entry.text === "string",
  );
  loopRun.state.log = log;
  loopRun.logSeq = Math.max(countOf(saved.logSeq), log.at(-1)?.seq ?? 0);
  loopRun.waitSeq = Math.min(countOf(saved.heardSeq), loopRun.logSeq);
}

/** The workers the journal named, as a resumed run knows them: from before the pause. */
function priorWorkersOf(saved: unknown, runId: string): PriorWorker[] {
  return Object.entries((saved ?? {}) as Record<string, AnyRecord>).map(([key, record]) => {
    const id = String(record?.id ?? key);
    return {
      id,
      title: String(record?.title ?? id),
      // A worker the journal saw start and never end was building when the run stopped.
      state: String(record?.state ?? WorkerState.Running),
      stoppedBecause: typeof record?.stoppedBecause === "string" ? record.stoppedBecause : null,
      brief: String(record?.brief ?? ""),
      owns: Array.isArray(record?.owns) ? record.owns.map(String) : [],
      from: typeof record?.from === "string" ? record.from : null,
      rounds: countOf(record?.rounds),
      accepted: countOf(record?.accepted),
      lastCommit: typeof record?.lastCommit === "string" ? record.lastCommit : null,
      ref: String(record?.ref ?? runRef(runId, "workers", id)),
      ...(record?.stage === FacetStage.Finish ? { stage: FacetStage.Finish } : {}),
    };
  });
}

/**
 * What the resumed run's own journal keeps naming from the one before: the workers (so a second
 * pause loses none of them) and the plan's parts, which the app checks a steer addressed to a
 * worker against — a resumed run that dropped them refused every such steer until it re-planned.
 */
function carryForward(loopRun: LoopRun): void {
  const { journal, priorJournal } = loopRun;
  if (!journal?.director) return;
  journal.director.workers = { ...(priorJournal?.director?.workers ?? {}), ...(journal.director.workers ?? {}) };
  const facets = priorJournal?.plan?.facets;
  if (Array.isArray(facets) && facets.length) journal.plan = { ...journal.plan, facets };
}

/** A count of passes a journal kept, or none. */
const passesSoFar = (value: unknown): number =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0;

/**
 * A resumed run reads its journal back: the defects nobody owns, the plan window, the last
 * health pass, the workers' engine limit, the log and how much of it the lead had heard, and the
 * workers from before the pause. The plan, the integration head and the last judge come back
 * through `loopRunState` and `startingCommits`, the clock through `loopRunClock`. Called before the
 * run writes a line of its own.
 */
export function restoreLoopRun(loopRun: LoopRun, now = Date.now()): void {
  loopRun.priorWorkers = [];
  if (!resumedFromJournal(loopRun)) return;
  const saved = loopRun.priorJournal?.director ?? {};
  const { state } = loopRun;
  state.ledger = restoredLedger(saved.ledger);
  loopRun.journal.director.operationSpans = [...(saved.operationSpans ?? [])];
  for (const key of ["firstVerifiedCheckpoint", "latestVerifiedCheckpoint", "softReviewAt"]) {
    if (saved[key] !== undefined) loopRun.journal.director[key] = saved[key];
  }
  state.goals = restoreGoals(saved.goals) ?? outcomesFromPlan(saved, loopRun);
  // Resume is an explicit user decision to revisit the prerequisite; it grants no tool permission.
  for (const goal of state.goals?.entries ?? []) {
    if (goal.status !== GoalStatus.Blocked) continue;
    if (goal.blocker === GoalBlocker.NoProgress) {
      goal.attempts = 0;
      goal.replan = null;
    }
    goal.status = GoalStatus.Pending;
    goal.blocker = null;
  }
  restorePlanWindow(state, saved.planReview, now);
  if (typeof saved.integrationHealthy === "boolean") state.integrationHealthy = saved.integrationHealthy;
  state.workerLimit = restoredWorkerLimit(saved.workerLimit, now);
  restoreIntegration(state, saved);
  restoreLog(loopRun, saved);
  // Its judge_N and play_N folders go on from the earlier sessions', never over them.
  state.judges = passesSoFar(saved.judges);
  state.plays = passesSoFar(saved.plays);
  loopRun.priorWorkers = priorWorkersOf(saved.workers, loopRun.run.runId);
  state.lastShip = restoredShip(saved.lastShip);
  if (saved.shipFinishRefused === true) state.shipFinishRefused = true;
  carryForward(loopRun);
}

/**
 * The outcomes a journal from before outcomes were kept takes from its plan, on a goal commission;
 * none for one that kept them — `null` waits for the next plan (a finished build reopened,
 * director/reopen.ts), whose parts are the new commission's.
 */
function outcomesFromPlan(saved: AnyRecord, loopRun: LoopRun) {
  const parts = saved.goals === undefined && goalCommission(loopRun.run) ? loopRun.state.plan?.workers : undefined;
  return parts ? createGoals(parts) : undefined;
}

/** The art director's last word as the journal kept it, or none when it is not one. */
function restoredShip(saved: unknown): LoopRunState["lastShip"] {
  const ship = (saved ?? {}) as AnyRecord;
  if (typeof ship.head !== "string" || !Array.isArray(ship.defects)) return null;
  const verdict = typeof ship.ship === "boolean" ? ship.ship : null;
  const doNotRegress = doNotRegressOf({ doNotRegress: ship.doNotRegress });
  return { head: ship.head, ship: verdict, defects: ship.defects, doNotRegress, at: msOf(ship.at) ?? 0 };
}

/** The wake loop's own state as the journal kept it: whether the lead was asked what next, and the wakes still in the cap's window. */
export function restoredWake(saved: unknown, now: number): RestoredWake {
  const record = (saved ?? {}) as AnyRecord;
  const wakesAt = (Array.isArray(record.wakesAt) ? record.wakesAt : [])
    .map(msOf)
    .filter((at: number | null): at is number => at !== null && at > now - WAKE_WINDOW_MS && at <= now);
  const freshSessions = Number.isInteger(record.freshSessions) && record.freshSessions > 0 ? record.freshSessions : 0;
  const nextShipLookWorkedMs = workedMsOrNull(record.nextShipLookWorkedMs);
  const verifyNudgedWorkedMs = workedMsOrNull(record.verifyNudgedWorkedMs);
  return {
    idleAsked: record.idleAsked === true,
    wakesAt,
    ...(freshSessions ? { freshSessions } : {}),
    ...(record.finishMarkSaid === true ? { finishMarkSaid: true } : {}),
    ...(nextShipLookWorkedMs === null ? {} : { nextShipLookWorkedMs }),
    ...(verifyNudgedWorkedMs === null ? {} : { verifyNudgedWorkedMs }),
  };
}

/** The workers from before the pause that no worker of this session has taken the id of. */
function priorNotSuperseded(loopRun: LoopRun): PriorWorker[] {
  return (loopRun.priorWorkers ?? []).filter((worker) => !loopRun.state.workers.has(worker.id));
}

/** The worker from before the pause of this id that no worker of this session has taken it from, or null. */
function priorNamed(loopRun: LoopRun, id: string): PriorWorker | null {
  return priorNotSuperseded(loopRun).find((worker) => worker.id === id) ?? null;
}

/** A worker from before the pause that left a commit of its own: work a new worker of its id would move its ref off. */
type PriorWithWork = PriorWorker & { lastCommit: string };
const leftWork = (worker: PriorWorker): worker is PriorWithWork =>
  Boolean(worker.lastCommit) && worker.lastCommit !== worker.from;

/** Does `from=` (as a slug) name this worker's work: its id, or its last commit, in full or a short sha? */
function buildsOn(worker: PriorWithWork, from: string): boolean {
  if (from === worker.id) return true;
  return from.length >= MIN_SHA_CHARS && worker.lastCommit.toLowerCase().startsWith(from);
}

/**
 * Why `worker_start` may not give a new worker this id, or null when it may. A worker from before
 * the pause had it and left work of its own on its ref, which the new worker's first accepted
 * round would move off and leave unreachable — unless the new one builds on that work (`from=` its
 * id or its last commit), so the old commits stay under the new ones. `from` is a slug.
 */
export function priorIdRefusal(loopRun: LoopRun, id: string, from: string): string | null {
  const prior = priorNamed(loopRun, id);
  if (!prior || !leftWork(prior) || buildsOn(prior, from)) return null;
  return priorIdTaken({ id, lastCommit: prior.lastCommit, ref: prior.ref, era: priorEra(loopRun) });
}

/** The id a worker the lead named none for gets: the next `w<n>` no worker has had, this session's or one from before the pause. */
export function defaultWorkerId(loopRun: LoopRun): string {
  const { state } = loopRun;
  const taken = new Set([...state.workers.keys(), ...(loopRun.priorWorkers ?? []).map((worker) => worker.id)]);
  let n = state.workers.size + 1;
  while (taken.has(`w${n}`)) n += 1;
  return `w${n}`;
}

/** The ids of the workers from before the pause (`worker_start replaces=` may name one). */
export function priorWorkerIds(loopRun: LoopRun): string[] {
  return (loopRun.priorWorkers ?? []).map((worker) => worker.id);
}

/**
 * What `worker_start from=<id>` forks from when `id` is a worker from before the pause: its last
 * commit, else the commit it forked from (null when it left neither) — or null when no worker from
 * before the pause has that id.
 */
export function priorFork(loopRun: LoopRun, id: string): { commit: string | null } | null {
  const prior = priorNamed(loopRun, id);
  return prior ? { commit: prior.lastCommit ?? prior.from } : null;
}

/** The workers from before the pause, as a digest names them: what they left, and how to go on from it. */
export function priorDigestWorkers(loopRun: LoopRun): DigestWorker[] {
  return priorNotSuperseded(loopRun).map((worker) => ({
    id: worker.id,
    title: worker.title,
    state: priorWorkerState(worker.state, priorEra(loopRun)),
    accepted: worker.accepted,
    ...(worker.stoppedBecause ? { stoppedBecause: worker.stoppedBecause } : {}),
    fromBefore: priorWorkerLeft({ ...worker, lead: Boolean(loopRun.lead) }),
  }));
}

/** A worker from before the pause, as `run_status` and `worker_status` show it. */
function statusOf(worker: PriorWorker): AnyRecord {
  return {
    id: worker.id,
    title: worker.title,
    stateBeforeThePause: worker.state,
    rounds: worker.rounds,
    accepted: worker.accepted,
    lastCommit: worker.lastCommit,
    ref: worker.ref,
    owns: worker.owns,
    brief: clip(worker.brief, STATUS_BRIEF_CHARS),
    ...(worker.stage ? { stage: worker.stage } : {}),
  };
}

/** The workers from before the pause, as `run_status` shows them. */
export function priorWorkersStatus(loopRun: LoopRun): AnyRecord[] {
  return priorNotSuperseded(loopRun).map(statusOf);
}

/** One worker from before the pause, as `worker_status <id>` answers: its record, and how to go on from its work. Null when there is none of that id. */
export function priorWorkerStatus(loopRun: LoopRun, id: string): AnyRecord | null {
  const prior = priorNamed(loopRun, id);
  return prior ? { ...statusOf(prior), notRunning: priorCommitWords({ ...prior, lead: Boolean(loopRun.lead) }) } : null;
}

/**
 * The workers from before the pause in one line, for every digest after a resumed run's first —
 * which gave each its full line (`priorDigestWorkers`). Null when there are none.
 */
export function priorWorkersSummary(loopRun: LoopRun): string | null {
  const ids = priorNotSuperseded(loopRun).map((worker) => worker.id);
  return ids.length ? priorWorkersLine(ids, priorEra(loopRun)) : null;
}
