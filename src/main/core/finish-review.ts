/**
 * A Loop's finish check, the app's side: the reviewer's verdict is the app's. The harness gathers
 * what the reviewer reads and asks (`finish.review`); the host records the round's `checking` step,
 * runs the reviewer in the seat it gives reviewers, reads its yes or no (`reviewerVerdict`) and holds
 * that answer. The harness then settles the round (`finish.settle`): it may turn the held answer into
 * no answer (a yes that lapsed, a turn that ended), never into a yes. The host counts the no's in a
 * row from its own records (a finished run reopened for a new ask starts them over; a resumed one goes
 * on) and writes the outcome: `MAX_FINISH_REJECTIONS` no's in a row stop the Loop, unless the settle
 * names more than `FINISH_TIME_LEFT_MS` of a timed Loop's working time left (then it goes on). A
 * run's start, pause or close drops its held round: nothing more is recorded for it, and the graph
 * reads the round as one the Loop ended before. A round answered and never settled gives way to the
 * run's next claim, recorded as no answer.
 *
 * Its ports keep it free of the core, so the seed's tests drive the same rules over their fake host.
 */
import { CustomEvent, customRecord } from "../../shared/custom-events.ts";
import { errorMessage } from "../../shared/errors.ts";
import type { EventEnvelope } from "../../shared/event-log.ts";
import {
  clipReason,
  FINISH_TIME_LEFT_MS,
  type FinishCheckPayload,
  FinishCheckStep,
  type FinishRecord,
  finishRecordOf,
  MAX_FINISH_REJECTIONS,
  type ReviewerVerdict,
  rejectionsInRow,
  reviewerVerdict,
} from "../../shared/finish-check.ts";
import type { HarnessDelegateParams, HarnessParams, HarnessResult, HostMethod } from "../../shared/harness-api.ts";
import { executionStep, isExecutionEvent, type RunExecution } from "../../shared/run-state.ts";

/** How long the lead's claim reads in its round's record. */
const CLAIM_CHARS = 2_000;
/** The fields a settle takes: any other (a step, a verdict) is refused. */
const SETTLE_FIELDS: ReadonlySet<string> = new Set(["project", "runId", "round", "unanswered", "timeLeftMs"]);

/** Why a review or a settle is refused, and why a review got no answer (persisted in `why`). */
const MESSAGE = {
  notRunning: "That run is not a running run of this game",
  held: "A reviewer is already checking a claim of this run",
  notHeld: "That round of the run is not waiting to be settled",
  badSettle: "A settle names its project, run, round and, at most, why the answer is none and the time left",
  failed: (why: string) => `the reviewer's session failed: ${why}`,
  notSettled: "the harness never settled this round before the run's next claim",
  noAnswer: "no answer",
} as const;

type ReviewParams = HarnessParams<typeof HostMethod.FinishReview>;
type SettleParams = HarnessParams<typeof HostMethod.FinishSettle>;

/** What the finish checks reach of the app: the run's chat, its records, the log and the reviewer's seat. */
export interface FinishReviewPorts {
  /** The chat a running run of this game reports to; null for any other run. */
  runningChat(project: string, runId: string): Promise<string | null>;
  /** A run's `finish_check` payloads in its chat, oldest first (`finishHistory`). */
  history(threadId: string, runId: string): Promise<FinishHistory>;
  /** Write one `finish_check` record into the chat. */
  append(threadId: string, payload: FinishCheckPayload): Promise<unknown>;
  /** Run a session as the host runs `engine.delegate` (a reviewer grant seats a reviewer). */
  delegate(params: HarnessDelegateParams): Promise<unknown>;
  now?: () => number;
}

/** A run's `finish_check` payloads, oldest first: all of them, and those of its current ask. */
export interface FinishHistory {
  all: ReadonlyArray<Record<string, unknown>>;
  /** Since the run was last opened: a finished run reopened for a new ask starts here; a resume after a pause does not. */
  sinceOpened: ReadonlyArray<Record<string, unknown>>;
}

/** A run's finish check records in a chat's log, and those since the run was last opened (`RunExecution.openedAt`). */
export function finishHistory(events: readonly EventEnvelope[], runId: string): FinishHistory {
  const all: Array<Record<string, unknown>> = [];
  let sinceOpened: Array<Record<string, unknown>> = [];
  let run: RunExecution | null = null;
  let opened: string | null = null;
  for (const event of events) {
    const custom = customRecord(event.data);
    if (custom?.payload.runId !== runId) continue;
    if (custom.event_type === CustomEvent.FinishCheck) {
      all.push(custom.payload);
      sinceOpened.push(custom.payload);
    }
    if (!isExecutionEvent(custom)) continue;
    run = executionStep(run, runId, { ...custom, at: event.created_at });
    if ((run?.openedAt ?? null) === opened) continue;
    opened = run?.openedAt ?? null;
    sinceOpened = [];
  }
  return { all, sinceOpened };
}

/** A round under review or waiting to be settled. */
interface Held {
  project: string;
  round: number;
  /** Null while the reviewer is still at work. */
  verdict: ReviewerVerdict | null;
  reviewer: { engine: string; model?: string };
  observers: string[];
}

/** Why a session that did not answer failed, in its own words when it gave some. */
function failureOf(result: Record<string, unknown>): string {
  const words = [result.errorText, result.stopReason].find((one) => typeof one === "string" && one.trim());
  return clipReason(typeof words === "string" ? words : MESSAGE.noAnswer);
}

/** A reviewer session's result as its answer: a failed session is no answer, with its words. */
function verdictOfResult(result: unknown): ReviewerVerdict {
  const record = typeof result === "object" && result !== null ? (result as Record<string, unknown>) : {};
  if (record.ok !== true) return { step: FinishCheckStep.Unanswered, why: MESSAGE.failed(failureOf(record)) };
  return reviewerVerdict(String(record.summary ?? ""));
}

/** An answer's fields, as the harness and the record read them: what isn't done and what is only when the reviewer named some. */
const answerFields = (verdict: ReviewerVerdict) =>
  verdict.step === FinishCheckStep.Unanswered
    ? { why: verdict.why }
    : {
        reasons: verdict.reasons,
        ...(verdict.notDone.length ? { notDone: verdict.notDone } : {}),
        ...(verdict.done.length ? { done: verdict.done } : {}),
      };

/** A run's own `finish_check` payloads as a reader places them. */
function placed(payloads: ReadonlyArray<Record<string, unknown>>, runId: string): FinishRecord[] {
  return payloads.map(finishRecordOf).filter((record): record is FinishRecord => record?.runId === runId);
}

/** Whether settle params name only the fields a settle takes, with no answer smuggled in. */
function wellFormedSettle(p: SettleParams): boolean {
  const unanswered = p.unanswered;
  const why = unanswered === undefined || unanswered === null || (typeof unanswered === "string" && unanswered !== "");
  const left = p.timeLeftMs === undefined || p.timeLeftMs === null || isTimeLeft(p.timeLeftMs);
  return Object.keys(p).every((key) => SETTLE_FIELDS.has(key)) && why && left && Number.isSafeInteger(p.round);
}

/** A working time left: whole milliseconds, zero or more. */
const isTimeLeft = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** Whether a settle names more of a timed Loop's working time left than the no's in a row may stop. */
const goesOnFor = (timeLeftMs: unknown): boolean => isTimeLeft(timeLeftMs) && timeLeftMs > FINISH_TIME_LEFT_MS;

/** The finish checks of every running Loop: one per core. */
export class FinishReviews {
  readonly #ports: FinishReviewPorts;
  readonly #held = new Map<string, Held>();
  /** How many times each run's rounds were dropped: a settle that waited across a drop records nothing. */
  readonly #drops = new Map<string, number>();

  constructor(ports: FinishReviewPorts) {
    this.#ports = ports;
  }

  /** Review a run's claim: record the round's start, run the reviewer, hold and answer its yes or no. */
  async review(p: ReviewParams): Promise<HarnessResult<typeof HostMethod.FinishReview>> {
    const prior = this.#held.get(p.runId);
    // A round still read is the only one that holds a run's claims back; one answered and never settled gives way.
    if (prior && !prior.verdict) throw new Error(MESSAGE.held);
    const reviewer = { engine: p.engine, ...(p.model ? { model: p.model } : {}) };
    const held: Held = { project: p.project, round: 0, verdict: null, reviewer, observers: [...p.observers] };
    // Taken before any wait, so a second review of the run is refused while this one starts.
    this.#held.set(p.runId, held);
    // A pause or close lands while this waits: it dropped the round, so nothing more is written or started.
    const stillHeld = () => {
      if (this.#held.get(p.runId) !== held) throw new Error(MESSAGE.notRunning);
    };
    try {
      const threadId = await this.#ports.runningChat(p.project, p.runId);
      if (!threadId) throw new Error(MESSAGE.notRunning);
      if (prior?.verdict) {
        const unsettled = { step: FinishCheckStep.Unanswered, why: MESSAGE.notSettled } as const;
        await this.#outcome(threadId, p.runId, prior, unsettled, stillHeld);
      }
      held.round = (await this.#lastRound(threadId, p.runId)) + 1;
      stillHeld();
      await this.#record(threadId, {
        runId: p.runId,
        round: held.round,
        step: FinishCheckStep.Checking,
        claim: clipReason(p.claim, CLAIM_CHARS),
        proof: [...p.proof],
      });
    } catch (err) {
      if (this.#held.get(p.runId) === held) this.#held.delete(p.runId);
      throw err;
    }
    stillHeld();
    held.verdict = await this.#ask(p);
    return { round: held.round, step: held.verdict.step, ...answerFields(held.verdict) };
  }

  /** Settle the held round: record its outcome (no answer when `unanswered` says why) and the row of no's. */
  async settle(p: SettleParams): Promise<HarnessResult<typeof HostMethod.FinishSettle>> {
    if (!wellFormedSettle(p)) throw new Error(MESSAGE.badSettle);
    const held = this.#held.get(p.runId);
    const ours = held?.verdict && held.project === p.project && held.round === p.round;
    if (!held?.verdict || !ours) throw new Error(MESSAGE.notHeld);
    // Let go before any wait: a second settle of the round finds nothing held.
    this.#held.delete(p.runId);
    const generation = this.#drops.get(p.runId) ?? 0;
    const notDropped = () => {
      if ((this.#drops.get(p.runId) ?? 0) !== generation) throw new Error(MESSAGE.notRunning);
    };
    const threadId = await this.#ports.runningChat(p.project, p.runId);
    if (!threadId) throw new Error(MESSAGE.notRunning);
    const verdict: ReviewerVerdict =
      typeof p.unanswered === "string"
        ? { step: FinishCheckStep.Unanswered, why: clipReason(p.unanswered) }
        : held.verdict;
    const goesOn = goesOnFor(p.timeLeftMs);
    const { rejections, stopped, timeLeft } = await this.#outcome(threadId, p.runId, held, verdict, notDropped, goesOn);
    return {
      round: held.round,
      step: verdict.step,
      ...answerFields(verdict),
      rejections,
      stopped,
      ...(timeLeft ? { timeLeft } : {}),
    };
  }

  /**
   * Record a held round's outcome and the row of no's it leaves; `stillOurs` throws once the run's
   * round was dropped. A no the Loop had time left at (`goesOn`) never stops it, and says so.
   */
  async #outcome(
    threadId: string,
    runId: string,
    held: Held,
    verdict: ReviewerVerdict,
    stillOurs: () => void,
    goesOn = false,
  ): Promise<{ rejections: number; stopped: boolean; timeLeft: boolean }> {
    const { sinceOpened } = await this.#ports.history(threadId, runId);
    stillOurs();
    const outcome = { runId, round: held.round, step: verdict.step, ...answerFields(verdict) };
    const rejections = rejectionsInRow(placed([...sinceOpened, outcome], runId), runId);
    const rejected = verdict.step === FinishCheckStep.Rejected;
    const timeLeft = rejected && goesOn;
    const stopped = rejected && !timeLeft && rejections >= MAX_FINISH_REJECTIONS;
    await this.#record(threadId, {
      ...outcome,
      ...(stopped ? { stopped: true } : {}),
      ...(timeLeft ? { timeLeft: true } : {}),
      rejections,
      observers: held.observers,
      reviewer: held.reviewer,
    });
    return { rejections, stopped, timeLeft };
  }

  /** A run started, paused or closed: its held round is dropped, and nothing more is recorded for it. */
  drop(runId: string): void {
    this.#held.delete(runId);
    this.#drops.set(runId, (this.#drops.get(runId) ?? 0) + 1);
  }

  /** Run the reviewer in its seat and read its answer; a session that throws (stopped, refused) is no answer. */
  async #ask(p: ReviewParams): Promise<ReviewerVerdict> {
    try {
      const result = await this.#ports.delegate({
        engine: p.engine,
        ...(p.model ? { model: p.model } : {}),
        ...(p.effort ? { effort: p.effort } : {}),
        project: p.project,
        prompt: p.prompt,
        readOnly: true,
        reviewer: { runId: p.runId, reads: p.reads },
        images: p.images,
        toolAllow: [],
        timeoutMs: p.timeoutMs,
        maxTurns: p.maxTurns,
      });
      return verdictOfResult(result);
    } catch (err) {
      return { step: FinishCheckStep.Unanswered, why: MESSAGE.failed(clipReason(errorMessage(err))) };
    }
  }

  /** The highest round the run's records hold, whatever ask it was (0 for none). */
  async #lastRound(threadId: string, runId: string): Promise<number> {
    const { all } = await this.#ports.history(threadId, runId);
    return Math.max(0, ...placed(all, runId).map((record) => record.round));
  }

  /** One `finish_check` record of the run, stamped with the host's time. */
  #record(threadId: string, payload: FinishCheckPayload): Promise<unknown> {
    const at = new Date(this.#ports.now?.() ?? Date.now()).toISOString();
    return this.#ports.append(threadId, { ...payload, at });
  }
}
