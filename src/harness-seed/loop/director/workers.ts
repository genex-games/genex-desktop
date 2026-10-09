import { requireMultiplayer } from "./prerequisites.ts";
import { reviseGoals, createGoals, goalAttemptRefusal, goalDecision, GoalStatus, startGoalAttempt } from "./goals.ts";
import { goalCommission } from "./commission.ts";
/**
 * The director's workers: the plan the user reads, starting a worker (its fork gate, its
 * contract, its worktree and window), running it (a judged facet loop or one builder session),
 * the monitor that looks into running worktrees, and pulling a worker off.
 *
 * Stopping and interrupting a worker (`stopWorker`, `interruptWorker`, and the stop checks in
 * `runWorker`) moved here unchanged from director.ts.
 */

import { MIN_DELEGATE_TIMEOUT_MS, PAGE_SEED } from "../config.ts";
import { normalizeFacetPolicy, runFacetLoop, steerPrompt } from "../facet-loop.ts";
import { carryOnPrompt } from "./single-worker-prompts.ts";
import { commitAll, GIT, gitAt, gitExec, headOf, LABEL_SHA_LENGTH, shortSha, updateRef } from "../git.ts";
import { runScope as runMoment, workerEndHooks, workerStartHooks } from "../hooks.ts";
import { HOOK_PROMPTS } from "../hooks-prompts.ts";
import { HostMethod } from "../host-methods.ts";
import { CRITIC_PRINCIPLES } from "../judge.ts";
import { isGameKind, KIND_NAMES, writeDeclaredGame } from "../kinds.ts";
import { refusalRecord, roundRecord } from "../ledger.ts";
import { roleEffort, roleEngine, RoleKey } from "../model-roles.ts";
import { EngineFailure, isEngineLimit, limitWords, StopReason } from "../outage.ts";
import { lossWords, noteProviderLoss } from "../provider-loss.ts";
import { isRunning, setWorkerState, WorkerMode, WorkerState } from "../outcomes.ts";
import { runRef } from "../repo.ts";
import { RunEvent } from "../run-events.ts";
import { normalizeScoutSetup } from "../scout.ts";
import { FacetStage, isFinishing, stageArg } from "../facet/stage.ts";
import { FINISH_SINGLE_REFUSAL, FINISH_START_MOVES } from "../facet/stage-prompts.ts";
import { isOpenRung } from "../facet/growth.ts";
import { isCommit } from "../shell.ts";
import { addToScope, restoreScope, runScope, type RunScope } from "../scope.ts";
import { linkScreenOwner, runningScreenOwner, SCREEN_CRITIC } from "../screen-owner.ts";
import { CheckWeight, MAX_DONE, MAX_MILESTONES } from "../spec.ts";
import { CLIP_BRIEF, CLIP_DETAIL, CLIP_QUOTE, CLIP_REASON, clip } from "../text.ts";
import { MINUTE_MS, minutes, SECOND_MS, sleep } from "../time.ts";
import { observedFrom, VerdictPass, VerdictRule } from "../verdict.ts";
import { KIND_QUOTED, list, num, parseJson, slug, withoutFrames, yes } from "./args.ts";
import {
  CLOSE_SETTLE_MS,
  MAX_WORKERS,
  MIN_FREE_MB,
  monitorEveryMs,
  planReviewWaitMs,
  shortBudgetWarning,
  WORKER_FLOOR_MS,
  workerWindows,
} from "./budgets.ts";
import { singleWorkerBrief } from "./briefs.ts";
import { iterationDigest, loopNote, workerDigest } from "./digests.ts";
import { conflictMergeOf, markersLeft, mergeFirst } from "./conflict-worker.ts";
import {
  briefWithContract,
  contractAtFork,
  contractBeforeFork,
  contractOnPlan,
  contractSeam,
} from "./contract-gate.ts";
import { defaultWorkerId, priorFork, priorIdRefusal, priorWorkerIds } from "./journal.ts";
import { LEAD_FORK_REFUSED, LEAD_START_DIRTY } from "./lead-session-prompts.ts";
import { BuildTarget } from "./loop-run.ts";
import {
  compilePlan,
  compileWorkerSpec,
  makeRouteDefect,
  monitorFindings,
  monitorNote,
  PlanHold,
  waitForPlanGo,
} from "./rules.ts";
import { planHeldWords, planSetWords, WAKE_START_NEXT } from "./wake-prompts.ts";
import { NoteKind } from "./wake-schedule.ts";
import { runIdentity } from "../workers/identity.ts";
import { stoppableRoomClock, withWorkerRoom } from "../workers/room.ts";
import { briefOf, recordBuilderEnded, recordBuilderStarted } from "../workers/director-pool.ts";
import type { LoopRun, StartingWorker, Worker } from "./loop-run.ts";
import type { FacetSpec } from "../spec.ts";
import type { AnyRecord } from "../../types/harness.d.ts";
import type { DelegateOwnership } from "../../types/host-api.d.ts";

/**
 * This part serves a lead that is its chat's own session and writes nothing (one session): a run
 * seats one only when every part it depends on says so (lead-session.ts `servesLead`).
 */
export const SERVES_LEAD = true;

/** What `worker_start` tells a director with its own hands whose integration worktree has uncommitted edits. */
const START_DIRTY =
  "your integration worktree has uncommitted edits; this worker forked from HEAD without them — commit first if workers should see them";

/** What `worker_start` tells the lead of a goal commission whose plan set no required outcomes yet. */
const MESSAGE_OUTCOMES_FIRST =
  "call plan first for what the user asks now: its parts' done scenarios become the outcomes this build must verify before it finishes — then start the workers they need.";
/** Ids a worker may not take: the builds a director names by word, and the director itself. */
const RESERVED_WORKER_IDS = new Set<string>([BuildTarget.Integration, BuildTarget.Live, "director"]);
/** A worker's budget: forty-five minutes unless the director says otherwise, and never under three. */
const WORKER_DEFAULT_MINUTES = 45;
const WORKER_MIN_MINUTES = 3;
/** How long a round was assumed to take before this run measured one (observed: nine to forty-six). */
const ASSUMED_ROUND_MS = 8 * MINUTE_MS;
/** A worker's loop runs at least this many rounds when its budget is sized from the median round. */
const MIN_SIZED_ROUNDS = 2;
/** How much of `git status` and `git diff` one monitor look reads. */
const MONITOR_STATUS_BYTES = 40_000;
const MONITOR_DIFF_BYTES = 200_000;
/** How often the monitor loop wakes, and how often it delivers steers the user addressed to a worker. */
const MONITOR_WAKE_MS = SECOND_MS;
const ROUTE_STEERS_EVERY_MS = 10 * SECOND_MS;
/** How much of a single session's summary the worker keeps. */
const SUMMARY_CHARS = 4_000;
/** How much of a worker's title the feed shows, and how much of its brief the start card quotes. */
const TITLE_CHARS = 80;
const BRIEF_QUOTED = 200;
/** A worker's own contract file in a game the user brought: the studio contract module. */
const STUDIO_CONTRACT = "src/studio.js";
/**
 * Interrupts in a row a single session carries on from with nothing new to hear — a second
 * steer's interrupt landing on the turn that already took it — before one ends the session.
 */
const MAX_EMPTY_INTERRUPTS = 2;

/**
 * A worker's engine hit its limit. On a run whose workers
 * run on the other subscription this is not the director's own limit and must not pause the
 * run: the director keeps its session, and run_status says which engine is out, since when
 * and for how long, so it can wait it out or do the work with its own hands.
 */
export function noteWorkerLimit(loopRun: LoopRun, worker: Worker, limit: AnyRecord): void {
  const { note, run, state } = loopRun;
  if (!limit || !isEngineLimit(limit.kind)) return;
  worker.limit = limit;
  state.workerLimit = {
    engine: limit.engine ?? roleEngine(run, RoleKey.Builder),
    kind: limit.kind,
    message: clip(limit.message, CLIP_DETAIL),
    retryAfterMs: typeof limit.retryAfterMs === "number" ? limit.retryAfterMs : null,
    at: Date.now(),
    worker: worker.id,
  };
  const resets =
    state.workerLimit.retryAfterMs !== null
      ? ` — resets in about ${minutes(state.workerLimit.retryAfterMs)} minutes`
      : "";
  note(
    `worker ${worker.id}: the workers' engine (${state.workerLimit.engine}) hit its ${limitWords(limit.kind)}${resets}`,
    NoteKind.WorkerLimit,
  );
}

/**
 * Wait for every worker that was ever started to reach the end of its own run — bounded.
 *
 * Both closes used to spin a 500 ms poll on `runningWorkers()`, and `worker.state` is set at
 * the END of runWorker's `try`, before the `finally` that releases its window and writes its
 * protective ref. So the poll returned while that ref was still in flight, and the close read
 * a HEAD the worker had not finished committing to. Each worker resolves its own deferred as
 * the first statement of that `finally` instead: when this returns, every worker either
 * finished its close-out or the window expired, and the sentence says which.
 */
export async function settleWorkers(loopRun: LoopRun, ms = CLOSE_SETTLE_MS) {
  const { state } = loopRun;
  const pending = [...state.workers.values()].filter((w) => w.settled !== true).map((w) => w.settle);
  if (!pending.length) return true;
  let timer = null;
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(0, ms));
    // A close that finishes early must not hold the process open for the rest of the window.
    timer?.unref?.();
  });
  const settled = await Promise.race([Promise.all(pending).then(() => true), expired]);
  if (timer) clearTimeout(timer);
  return settled === true;
}

/**
 * A worker's own ref — the insurance `protectHead` gives the integration branch. A worker's
 * worktree is detached: whatever it committed and nobody integrated is unreferenced the
 * moment the worktree is removed, and one morning's report named a worker's `lastCommit`
 * that `git for-each-ref --contains` could not find anywhere. Written when the worker ends
 * and again immediately before the teardown, because the close's settle is bounded on
 * purpose: a loop still judging when the run's clock runs out must not lose its commits.
 */
export async function protectWorker(loopRun: LoopRun, worker: Worker) {
  const { ctx, run } = loopRun;
  const label = `director:${run.runId}:protect:${worker.id}`;
  const head =
    (worker.worktree ? await headOf(ctx, worker.worktree, { label }).catch(() => null) : null) ??
    worker.lastCommit ??
    null;
  // Nothing of its own: the fork point belongs to the branch it forked from, already kept.
  if (!isCommit(head) || head === worker.from) return null;
  await updateRef(ctx, { project: run.project }, runRef(run.runId, "workers", worker.id), head, { label }).catch(
    () => {},
  );
  return head;
}

/**
 * What a look found when nothing moved: the files and violations the last look already saw. The
 * same entry files the reviewer will judge it by at the end of the round (reviewAttempt), so the
 * monitor never warns about a file the reviewer would allow, or miss one it reverts.
 */
async function lookedFindings(loopRun: LoopRun, worker: Worker, status: string, label: string) {
  const { ctx, ownShape, shape } = loopRun;
  const last = worker.monitor;
  if (last && status === (last.status ?? null)) return { files: last.files, violations: last.violations };
  // Only when something moved, and never the whole diff of a big game: a regex needs no context.
  const diff = await gitAt(ctx, worker.worktree, GIT.diffReadOnly(MONITOR_DIFF_BYTES), { label }).catch(() => "");
  return monitorFindings({
    status,
    diff,
    spec: contractOf(worker),
    ownsMain: worker.ownsMain,
    template: !ownShape,
    ...(ownShape && shape?.main ? { main: shape.main, studio: STUDIO_CONTRACT } : {}),
  });
}

/**
 * The worker monitor. Between "worker started" and "iteration 1 accepted" nothing wrote a
 * note, so nothing could wake the lead: a director asking for news heard "nothing yet" while
 * every worker made the same mistake, and learned of it only when their rounds were over.
 *
 * So the studio looks for it. Every few minutes (`monitorEveryMs`) it reads each running
 * loop worker's worktree with the reviewer it already owns — `git status`, `git diff` and
 * `mechanicalReview`, a regex over a diff: no model, no window, no judge call — and says
 * something only when what it sees has changed. The look never writes: `--no-optional-locks`
 * and no `git add`, so it cannot take the index lock from the worker's own commit.
 */
export async function lookAtWorker(loopRun: LoopRun, worker: Worker, screens: AnyRecord | null | undefined) {
  const { ctx, run } = loopRun;
  const label = `director:${run.runId}:monitor:${worker.id}`;
  const status = await gitAt(ctx, worker.worktree, GIT.statusReadOnly(MONITOR_STATUS_BYTES), { label }).catch(
    () => null,
  );
  // A worktree that would not answer (git busy, the worker being torn down): look again next tick.
  if (status === null) return;
  const found = await lookedFindings(loopRun, worker, status, label);
  const screen = (Array.isArray(screens) ? screens : []).find((s) => s.label === worker.id || s.label === worker.title);
  const now = {
    id: worker.id,
    at: Date.now(),
    round: worker.iterations.length + 1,
    // How long this round has been going: since the last round it finished, or since it started.
    minutesInRound: minutes(Date.now() - (worker.lastIterationAt ?? worker.startedAt)),
    files: found.files,
    violations: found.violations,
    look: screen?.caption ?? worker.monitor?.look ?? null,
    status,
    silentSaid: worker.monitor?.silentSaid === true,
  };
  const said = monitorNote(worker.monitor, now);
  worker.monitor = { ...now, silentSaid: now.silentSaid || said?.silent === true };
  // Returned, not said: the sweep looks at every worker at once and then speaks in worker
  // order, so a feed cannot read as though the workers were looked at in a shuffled order.
  return said ? { text: said.text, kind: said.kind } : null;
}

/** Is this worker due a look: a running loop worker with a worktree, not looked at for a while? */
function dueALook(w: Worker): boolean {
  const loopAtWork = w.mode === WorkerMode.Loop && w.spec && w.worktree;
  if (!loopAtWork) return false;
  const lastLook = w.monitor?.at ?? w.lastIterationAt ?? w.startedAt;
  return Date.now() - lastLook >= monitorEveryMs(w.deadline - w.startedAt);
}

export async function monitorSweep(loopRun: LoopRun) {
  const { ctx, lookAtWorker, note, runningWorkers } = loopRun;
  const due = runningWorkers().filter(dueALook);
  if (!due.length) return;
  const screens = await ctx.call(HostMethod.PreviewScreens, {}).catch(() => []);
  // Two read-only git commands in different worktrees, with `--no-optional-locks` and no
  // `git add`: nothing here can take another worker's index lock, so six workers cost one
  // look and not six in a row.
  const said = await Promise.all(due.map((worker: Worker) => lookAtWorker(worker, screens).catch(() => null)));
  for (const line of said) if (line) note(line.text, line.kind);
}

/**
 * One loop for every worker, started with the first of them and ending with the run: the
 * studio's looks into the running worktrees, and the delivery of steers the user addressed to
 * a worker — those must not wait for the director's next turn.
 */
export function startMonitor(loopRun: LoopRun) {
  const { ctx, monitorSweep, routeUserSteers, state } = loopRun;
  if (state.monitor) return;
  state.monitor = (async () => {
    let routedAt = 0;
    while (!state.finished && !ctx.cancelled) {
      await sleep(MONITOR_WAKE_MS);
      await monitorSweep().catch(() => {});
      if (Date.now() - routedAt >= ROUTE_STEERS_EVERY_MS) {
        routedAt = Date.now();
        await routeUserSteers().catch(() => {});
      }
    }
  })();
}

// ── the plan ──

/**
 * What kind of game this is, on the run record: every judge, brief and check reads it from
 * there. A kind the director declared is written back into the user's studio.json once, so the
 * next run on this game starts knowing it.
 */
async function declareGameKind(loopRun: LoopRun, game: AnyRecord): Promise<void> {
  const { ctx, journal, note, run } = loopRun;
  const changed = JSON.stringify(run.game ?? null) !== JSON.stringify(game);
  run.game = game;
  journal.run = { ...journal.run, game };
  if (!changed || !game.kind) return;
  const declared = await writeDeclaredGame(ctx, run.project, game, { from: "plan" }).catch(() => null);
  // …and committed where it was written. This is the folder the user sees, and the run's
  // only snapshot of it was taken before this session opened, so an uncommitted studio.json
  // left the folder dirty at the close — and "Make it my game" refuses to land onto a dirty
  // folder with a sentence that blames the user for an edit only the studio made. Only
  // that one path is committed; whatever else the folder holds stays as it is.
  if (!declared?.written) return;
  const committed = await gitExec(
    ctx,
    { project: run.project },
    GIT.commit(`studio: this game is a ${game.kind} game`, { only: ["studio.json"] }),
    { label: `director:${run.runId}:declare-kind` },
  ).catch(() => null);
  if (committed?.code !== 0)
    note(`the game kind was written into studio.json but not committed — the folder ends the run with that edit in it`);
}

/** The review window opens once, at the first plan: how long the user has, and what they had already said. */
async function openPlanReview(loopRun: LoopRun): Promise<void> {
  const { inbox, resume, run, softDeadline, state } = loopRun;
  const waitMs = planReviewWaitMs({
    reviewPlan: run.reviewPlan === true,
    resume,
    sessionMsLeft: softDeadline - Date.now(),
  });
  state.planReviewUntil = waitMs > 0 ? Date.now() + waitMs : null;
  // What they had already said is not an answer to a plan they had not seen.
  state.planSaidFrom = waitMs > 0 ? (await inbox.steering(undefined, false).catch(() => [])).length : 0;
}

/**
 * The plan tool (M3.8). It writes the same `autopilot_plan_review` card the classic pipeline
 * has always written, so the chat renders it with nothing new to learn, and it keeps the plan
 * on the journal where a resumed session finds it. The review window opens once, at the first
 * plan: a director that re-plans after the user has spoken cannot make them wait again.
 */
async function planAcceptance(
  loopRun: LoopRun,
  args: AnyRecord,
  workers: Array<{ id: string; done: string[]; added?: boolean }>,
): Promise<string | null> {
  const { state } = loopRun;
  // Parts beyond the ask are optional goals (goals.ts createGoals): a plan of nothing else would
  // leave no goal that can ever pass.
  const nothingAsked = workers.length > 0 && workers.every((part) => part.added === true);
  if (goalCommission(loopRun.run) && nothingAsked) return MESSAGE_GOALS.nothingAsked;
  // Built aside and kept only when the plan is taken: a refused plan sets no outcomes.
  let goals = state.goals;
  if (goalCommission(loopRun.run) && !goals) {
    if (workers.some((part: { done: string[] }) => !part.done.length))
      return "Goal mode needs measurable done scenarios for every initial required outcome.";
    goals = createGoals(workers);
  }
  if (goals && args.scope_instruction) {
    const revised = reviseGoals(
      goals,
      workers,
      String(args.scope_instruction),
      await loopRun.inbox.steering(undefined, false),
    );
    if (!revised)
      return "Scope revision needs a new user instruction quoted exactly; ordinary replans cannot change required outcomes.";
    goals = revised;
  }
  state.goals = goals;
  return null;
}

/** What the plan tool answers about a goal-mode plan's parts. */
const MESSAGE_GOALS = {
  nothingAsked:
    "Goal mode: at least one part must be what the user asked for. Parts marked added are optional goals, so a plan of only those leaves no goal that can pass.",
} as const;

/** A card about something a plan builds beyond the user's ask: the record, and the sentence the user reads. */
const MESSAGE_ADDED = {
  text: (item: string) => `plan: added beyond the user's ask — ${item}`,
  plain: (item: string) =>
    `The plan adds ${item}, which is outside what you asked; say so to keep it, or say "cut it" to drop it`,
  notCut: (items: string[]) => `plan: not cut — the user asked for ${items.join("; ")}`,
} as const;

/**
 * When an addition's card went to the user: how many of their steers its run's inbox held by
 * then, and the time. A count holds only within one inbox: a reopened build hears the user from its
 * ask on, while the plan and its cards go on, so the time is what orders a card against a later
 * run's steers. A card kept before the time was has its count alone.
 */
interface AddedAsked {
  item: string;
  steers: number;
  at?: string;
}

/** One of the user's steers to the build, and when the log took it (null: it did not say). */
interface SentSteer {
  text: string;
  at: string | null;
}

/**
 * The plan's cut and added lists against the run's scope (loop/scope.ts). Cuts only ever grow the
 * scope's cut list, and never take what the user asked for. An addition joins the scope only when
 * the plan quotes a steer the user sent after its card (`scope_instruction`, scope.ts
 * `addToScope`); every other one waits on the scope as `added` and is put to the user once, as a
 * card. Answers the additions to put to the user now. A run from before scope keeps no scope, but
 * its additions are still asked about, once each.
 */
async function settlePlanScope(
  loopRun: LoopRun,
  plan: AnyRecord,
  previous: AnyRecord | null,
  args: AnyRecord,
): Promise<string[]> {
  const added: string[] = plan.added ?? [];
  const scope = runScope(loopRun.run);
  const withCuts = scope ? scopeWith(scope, { cut: cutsOutsideAsk(loopRun, plan, scope) }) : undefined;
  const { sent, steers } = added.length ? await buildSteering(loopRun) : { sent: null, steers: [] };
  const askedAt: AddedAsked[] = Array.isArray(previous?.addedAskedAt) ? [...previous.addedAskedAt] : [];
  const instruction = String(args.scope_instruction ?? "");
  const next = withCuts
    ? widenedByUser(withCuts, answeredBy(added, instruction, steers, askedAt, sent), instruction, steers)
    : undefined;
  const asked = [...new Set<string>([...(previous?.addedAsked ?? []), ...(scope?.added ?? [])])];
  const fresh = added.filter((item) => !asked.includes(item) && !next?.inScope.includes(item));
  const askedNow = new Date().toISOString();
  for (const item of fresh) askedAt.push({ item, steers: steers.length, at: askedNow });
  if (asked.length || fresh.length) plan.addedAsked = [...asked, ...fresh];
  if (askedAt.length) plan.addedAskedAt = askedAt;
  const kept = next ? scopeWith(next, { added: fresh }) : undefined;
  if (kept && kept !== scope) {
    loopRun.run.scope = kept;
    loopRun.journal.run = { ...loopRun.journal.run, scope: kept };
  }
  return fresh;
}

/** The plan's cuts that are not what the user asked for; the others leave the plan, and the lead hears it. */
function cutsOutsideAsk(loopRun: LoopRun, plan: AnyRecord, scope: RunScope): string[] {
  const cut: string[] = plan.cut ?? [];
  const asked = cut.filter((item) => scope.inScope.includes(item));
  if (!asked.length) return cut;
  loopRun.note(MESSAGE_ADDED.notCut(asked));
  const kept = cut.filter((item) => !asked.includes(item));
  if (kept.length) plan.cut = kept;
  else delete plan.cut;
  return kept;
}

/**
 * The user's steers to the build with when each was sent, or null from a kept run-inbox.ts from
 * before it could say (or when the log cannot be read): the cards are then ordered by count.
 */
async function sentSteering(loopRun: LoopRun): Promise<SentSteer[] | null> {
  const { inbox } = loopRun;
  if (typeof inbox.sentSteering !== "function") return null;
  return inbox.sentSteering().catch(() => null);
}

/**
 * The user's steers to the build, in log order, and when each was sent (`sent`, null when the
 * inbox could not say: they are then the inbox's plain ones).
 */
async function buildSteering(loopRun: LoopRun): Promise<{ sent: SentSteer[] | null; steers: string[] }> {
  const sent = await sentSteering(loopRun);
  if (sent) return { sent, steers: sent.map((steer) => steer.text) };
  return { sent, steers: await loopRun.inbox.steering(undefined, false).catch(() => []) };
}

/**
 * The additions the quoted steer can answer: those whose card had gone to the user before it
 * arrived. A steer sent before any card asked about an item (an acceptance revision, say) is an
 * answer to something else.
 */
function answeredBy(
  added: readonly string[],
  instruction: string,
  steers: readonly string[],
  askedAt: readonly AddedAsked[],
  sent: readonly SentSteer[] | null = null,
): string[] {
  const at = instruction ? steers.lastIndexOf(instruction) : -1;
  if (at < 0) return [];
  const sentMs = timeOf(sent?.[at]?.at);
  return added.filter((item) => askedAt.some((asked) => asked.item === item && askedBefore(asked, at, sentMs)));
}

/**
 * Did this card go to the user before the steer at `at` in this inbox, sent at `sentMs`? By time
 * when both say when; by count otherwise, which only holds when the card was asked in this inbox.
 */
function askedBefore(asked: AddedAsked, at: number, sentMs: number | null): boolean {
  const askedMs = timeOf(asked.at);
  if (sentMs === null || askedMs === null) return asked.steers <= at;
  return askedMs <= sentMs;
}

/** An ISO time in milliseconds, or null when it is not one. */
function timeOf(iso: unknown): number | null {
  const ms = typeof iso === "string" ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(ms) ? null : ms;
}

/** A scope with more cut or added items (each list only grows, capped as scope.ts caps it); the same scope when none. */
function scopeWith(scope: RunScope, more: { cut?: string[]; added?: string[] }): RunScope {
  const cut = more.cut ?? [];
  const added = more.added ?? [];
  if (!cut.length && !added.length) return scope;
  return restoreScope({ ...scope, cut: [...scope.cut, ...cut], added: [...scope.added, ...added] }) ?? scope;
}

/** The plan's additions moved into scope, when the plan quotes the user's own steer (scope.ts `addToScope`). */
function widenedByUser(scope: RunScope, added: string[], instruction: string, steers: readonly string[]): RunScope {
  if (!added.length || !instruction) return scope;
  return addToScope(scope, added, instruction, steers) ?? scope;
}

/**
 * The vision the plan carries, or the one the plan before it gave — a re-plan never has to repeat
 * it to keep it — set on the run too: every worker brief and every judge of the game reads
 * `run.vision` (vision-prompts.ts), and the journal's run brings it back on a Resume.
 */
function keepVision(loopRun: LoopRun, plan: AnyRecord, previous: AnyRecord | null): void {
  const vision = plan.vision ?? previous?.vision ?? null;
  if (!vision) return;
  plan.vision = vision;
  loopRun.run.vision = vision;
  loopRun.journal.run = { ...loopRun.journal.run, vision };
}

export async function setPlan(loopRun: LoopRun, args: AnyRecord) {
  const { journal, saveJournal, state } = loopRun;
  const compiled = compilePlan(args);
  if (compiled.error !== undefined) return compiled.error;
  const plan = compiled.plan;
  const first = !state.plan;
  const previous = state.plan;
  // Outcomes this plan sets (a reopened build's first plan for the ask) are shown like a first plan's.
  const acceptanceKept = Boolean(state.goals);
  const scopeError = await planAcceptance(loopRun, args, plan.workers);
  if (scopeError) return scopeError;
  const additions = await settlePlanScope(loopRun, plan, previous, args);
  keepVision(loopRun, plan, previous);
  state.plan = plan;
  if (plan.game) await declareGameKind(loopRun, plan.game);
  journal.director.plan = plan;
  journal.plan = {
    ...journal.plan,
    facets: plan.workers.map((w: AnyRecord) => ({ id: w.id, title: w.title, identity: w.done })),
  };
  await saveJournal();
  for (const item of additions) await loopRun.decision(MESSAGE_ADDED.text(item), MESSAGE_ADDED.plain(item));
  if (first) await openPlanReview(loopRun);
  // A plan of several looping parts with a module contract: committed as docs/MODULE-CONTRACT.md,
  // with its vision beside it as docs/VISION.md.
  const contracted = await contractOnPlan(loopRun);
  const answer = await planAnswer(loopRun, plan, { first, acceptanceKept, args });
  return contracted ? `${answer} ${contracted}` : answer;
}

/** What `plan` answers once the plan is kept: the card on the user's screen, and what to do next. */
async function planAnswer(
  loopRun: LoopRun,
  plan: AnyRecord,
  { first, acceptanceKept, args }: { first: boolean; acceptanceKept: boolean; args: AnyRecord },
): Promise<string> {
  const { appendRun, note, state } = loopRun;
  const acceptanceUnchanged = !first && acceptanceKept && !args.scope_instruction;
  if (acceptanceUnchanged)
    return "Worker assignments updated; required acceptance is unchanged. Read run_status only if the supplied snapshot is stale.";
  const waitMinutes =
    state.planReviewUntil && !state.planGo ? Math.max(1, minutes(state.planReviewUntil - Date.now())) : 0;
  await appendRun(RunEvent.AutopilotPlanReview, {
    waitMinutes,
    summary: plan.summary,
    // What kind of game the run decided this is, on the one card the user reads before the
    // builders start: it decides the critic, the harness's own checks and the controls the
    // studio drives before every judgement, and it is written back into their studio.json —
    // so the window meant for objecting to the plan showed the one decision it never named.
    ...(plan.game ? { game: plan.game } : {}),
    facets: plan.workers.map((w: AnyRecord) => ({
      id: w.id,
      title: w.title,
      identity: w.done,
      cameras: [],
      checks: [],
    })),
    ...(plan.base ? { base: plan.base } : {}),
    ...(plan.risks.length ? { risks: plan.risks } : {}),
  });
  note(`the plan is on the user's screen: ${plan.workers.map((w: AnyRecord) => w.id).join(", ")}`);
  if (state.goals)
    return `Required acceptance is frozen: ${state.goals.entries.map((goal) => goal.id).join(", ")}. Use worker_start goal=<id> and playtest goal=<id> on integration. Report prerequisites through goal_update; finish once verified. Plan edits do not replace required outcomes.`;
  if (!waitMinutes)
    return `the plan is in the user's chat. Start the parts it names; call plan again if the run turns and the plan changes.`;
  if (loopRun.waking) return planSetWords(waitMinutes);
  return `the plan is in the user's chat. They asked to read it before the run builds, so your first worker_start waits for their word — up to ${waitMinutes} min, and then it builds the plan as it stands.`;
}

/**
 * Somebody who has spoken has read the plan: the window closes here too, or the next
 * worker_start blocks another four-minute slice and answers "nobody has answered yet" after
 * this call has just said they did.
 */
async function planAnswered(loopRun: LoopRun, id: string, said: string[]): Promise<string> {
  const { decision, state } = loopRun;
  state.planSaidFrom += said.length;
  state.planGo = true;
  state.planReviewUntil = null;
  await decision(
    `plan review: the user answered the plan — the builders start with their words in hand: ${said.join(" / ").slice(0, CLIP_DETAIL)}`,
    "you answered the plan, so the builders are starting with what you said",
  );
  return `the user answered your plan: "${said.join(" / ").slice(0, CLIP_BRIEF)}". Their instruction outranks it — note what you will do, call plan again if the run changes shape, then start "${id}".`;
}

/** The window closed on a go, or on nobody's word: the plan is built as it stands. */
async function planGoes(loopRun: LoopRun, go: boolean): Promise<void> {
  const { decision, state } = loopRun;
  state.planGo = true;
  state.planReviewUntil = null;
  await decision(
    go
      ? "plan review: the user said go — the workers start on the plan as written"
      : "plan review: nobody answered within the window — building the plan as it stands",
    go
      ? "you said go, so the builders are starting on the plan"
      : "nobody answered the plan, so the builders are starting on it as it stands",
  );
}

/**
 * The plan the user asked to read. The first worker waits for their word, never past the window:
 * a run nobody answers still builds, the way the classic pipeline's review always did. On a
 * run the wake loop drives (`run.waking`) the hold is a timer, not a blocked call: the inbox
 * is read once, and the lead ends its turn and is woken when the user answers or the window
 * closes (wake.ts). The long turn's hold — a kept older director.ts's too — blocks inside one
 * bounded slice. Answers the sentence `worker_start` returns instead of starting `id`, or null
 * when the worker may start.
 */
export async function holdForPlanReview(loopRun: LoopRun, id: string): Promise<string | null> {
  const { ctx, inbox, state } = loopRun;
  if (!state.planReviewUntil || state.planGo) return null;
  const waking = loopRun.waking === true;
  const held = await waitForPlanGo({
    until: state.planReviewUntil,
    ...(waking ? { sliceMs: 0 } : {}),
    read: async () => (await inbox.steering(undefined, false).catch(() => [])).slice(state.planSaidFrom),
    sleep: (ms) => sleep(ms),
    stopped: async () =>
      ctx.cancelled === true || state.finish !== null || (await inbox.finishing().catch(() => false)),
  });
  if (held.reason === PlanHold.Stopped) return "the run is finishing; no new workers";
  if (held.reason === PlanHold.Answered) return planAnswered(loopRun, id, held.said);
  if (held.reason === PlanHold.Slice && waking) return planHeldWords(id, state.planReviewUntil, Date.now());
  if (held.reason === PlanHold.Slice) {
    return `the user asked to read the plan first and has not answered yet; the studio waits ${minutes(state.planReviewUntil - Date.now())} more minutes and then builds it as it stands. Call worker_wait, then start "${id}" again.`;
  }
  await planGoes(loopRun, held.go);
  return null;
}

// ── starting a worker ──

/**
 * The two refusals a game the user brought earns (M4.6). A seam nobody named is not a capacity
 * problem, and answering it with "no window free" sends the director to wait for something that
 * would not help. A worker with no seam in somebody's own repository may edit anything but the
 * entry, the contract and the page, which is far wider than the template's `src/`; and that
 * entry is the game's own code, with no FACET WIRING block for a second owner to meet the first
 * in. Answers the refusal, or null.
 */
function seamRefusal(loopRun: LoopRun, id: string, args: AnyRecord): string | null {
  const { ownShape, runningWorkers, shape } = loopRun;
  if (!ownShape) return null;
  const running: Worker[] = runningWorkers();
  const seamOthers = running.length;
  // A loop worker under the module contract with no owns= takes its contract modules as its seam.
  const seam = list(args.owns).length ? list(args.owns) : contractSeam(loopRun, id, args, workerModeOf(args));
  if (seamOthers > 0 && seam.length === 0) {
    return `worker "${id}" needs a seam: this game is the user's own, so a worker with no owns= may edit anything but the entry, the contract and index.html — and ${seamOthers === 1 ? "another worker is" : `${seamOthers} other workers are`} already running. Give it owns= (files, folders or a quoted glob), or wait for the others to finish.`;
  }
  // …and the same rule read the other way round. A seamless worker owns nearly the whole
  // repository whichever order they were started in, so a seamed worker may not start beside
  // one either: only the first half was enforced, and a `core` started alone followed by a
  // `hud` with a seam of its own left two worktrees rewriting the same file, met by a merge
  // this game's entry has no wiring block to resolve.
  const wide = running.find((w: Worker) => w.owns.length === 0);
  if (wide) {
    return `worker "${wide.id}" is running with no seam, so it may edit anything in this game but the entry, the contract and index.html — stop it or wait for it before starting "${id}".`;
  }
  const seamOwnsMain = yes(args.owns_main, seamOthers === 0);
  const entryOwners = running.filter((w: Worker) => w.ownsMain).map((w: Worker) => w.id);
  if (!seamOwnsMain || !entryOwners.length) return null;
  const already = entryOwners.join(", ");
  return `worker "${already}" already owns ${shape?.main ?? "the entry module"} for this run, and this game's entry has no FACET WIRING block for two owners to meet in — start "${id}" with owns_main=no and a seam of its own, or wait for "${already}" to finish.`;
}

/**
 * Whether the machine has a window and the memory for one more worker. Windows the director
 * keeps for itself (`workerWindows`): the one its session looks through and the one its judges
 * lease. The old gate reserved a single window, and only in a pool of three or more, counting
 * whatever was free at this instant — so the director's own window, which it takes lazily on
 * its first look, was handed to a worker and every later judge, health and close pass had
 * nothing left but the user's own window. A capacity call that failed says nothing about the
 * pool; it must not refuse the run.
 */
function capacityRefusal(running: number, cap: AnyRecord | null, pooled: boolean): string | null {
  const pool = pooled ? cap : null;
  const forWorkers = typeof pool?.max === "number" ? workerWindows(pool.max) : null;
  if (forWorkers !== null && running >= forWorkers)
    return `no worker window free (${running} of ${forWorkers} in use; the rest stay with you, for looking and judging) — wait for a worker to finish or stop one`;
  const poolFull = typeof pool?.free === "number" && pool.free <= 0;
  if (poolFull)
    return `no worker window free (${pool.inUse}/${pool.max} in use) — wait for a worker to finish or stop one`;
  if (!pooled && running > 0)
    return "this studio has no worker windows: one worker at a time on the live view — wait for it to finish";
  if (cap?.memory && cap.memory.freeMb < MIN_FREE_MB)
    return `only ${cap.memory.freeMb} MB of memory free — a worker window needs at least ${MIN_FREE_MB} MB; wait for a worker to finish`;
  return null;
}

/** The mode a `worker_start` asks for: a single session only when it says so. */
function workerModeOf(args: AnyRecord): WorkerMode {
  return /^single$/i.test(String(args.mode ?? "")) ? WorkerMode.Single : WorkerMode.Loop;
}

/**
 * Why `id` cannot start now, in the sentence the director reads — a run that is finishing, a
 * mistyped restart or policy, a seam a game the user brought needs, a machine with no window or
 * memory to spare, a session with too little left — or, when it can, what the answer was read
 * from: `{ pooled, remaining, replaces, policySpec }`.
 */
export async function startRefusal(loopRun: LoopRun, id: string, args: AnyRecord) {
  const { ctx, runningWorkers, softDeadline, state } = loopRun;
  if (state.finish) return "the run is finishing; no new workers";
  if (runningWorkers().length >= MAX_WORKERS) return `${MAX_WORKERS} workers are already running`;
  // A restart is the same part, not a new one: the feed folds the rows together (M3.8). Checked
  // before the machine is, because a mistyped id is not a capacity problem and answering it
  // with "no window free" sends the director to wait for something that would not help. A
  // worker from before a pause is one of this run's too.
  const replaces = slug(args.replaces);
  const known = [...state.workers.keys(), ...priorWorkerIds(loopRun)];
  if (replaces && !known.includes(replaces))
    return `replaces: no worker "${args.replaces}" in this run (${known.join(", ") || "none started"})`;
  // The eight thresholds this worker's loop runs on (M4.10), read here for the same reason:
  // a threshold nobody has is a typo in the call, not a capacity problem, and it is refused
  // by name rather than silently ignored — a typo that changed nothing would be read as a
  // policy that did.
  const policySpec = normalizeFacetPolicy(args.policy);
  if (policySpec.error !== undefined) return policySpec.error;
  // The stage, for the same reason: an unknown one, or a finish asked to build a ladder, is the call's.
  const stage = stageArg(args.stage, { move: args.move, milestones: args.milestones });
  if (stage.error !== undefined) return stage.error;
  if (stage.stage === FacetStage.Finish && workerModeOf(args) === WorkerMode.Single) return FINISH_SINGLE_REFUSAL;
  const seam = seamRefusal(loopRun, id, args);
  if (seam) return seam;
  const screen = screenOwnerRefusal(runningWorkers(), id, args);
  if (screen) return screen;
  const cap = await ctx.call(HostMethod.PreviewCapacity, {}).catch(() => null);
  // The wake digest's room line reads the newest pool the studio gave (the user may change the
  // setting mid-run).
  if (cap) loopRun.capacity = cap;
  // A build without worker windows (no headless preview) lends the live view to one worker at a time.
  const pooled = cap?.headless !== false;
  const capacity = capacityRefusal(runningWorkers().length, cap, pooled);
  if (capacity) return capacity;
  const remaining = softDeadline - Date.now();
  if (remaining < WORKER_FLOOR_MS)
    return `only ${minutes(remaining)} minutes left in your session — too little for a worker; finish instead`;
  return { pooled, remaining, replaces, policySpec };
}

/**
 * One owner of the screen (loop/screen-owner.ts): a part reviewed as a screen owns it, so a second
 * one is refused while the first runs — the same way two owners of the entry are. The owner's own
 * restart (`replaces`) takes the screen over instead.
 */
function screenOwnerRefusal(running: Worker[], id: string, args: AnyRecord): string | null {
  if (String(args.critic ?? "").trim() !== SCREEN_CRITIC) return null;
  const owner = runningScreenOwner(running);
  if (!owner || owner === slug(args.replaces)) return null;
  return `worker "${owner}" already owns the screen (critic=screen) for this run: one part draws the HUD, menus and layout. Start "${id}" without critic=screen and have it expose its values, steer "${owner}" to draw them, or wait for "${owner}" to finish.`;
}

/** A JSON-array argument: null when absent, the array, or the sentence that says what is wrong. */
function jsonArrayArg(value: unknown, name: string): { value: any[] | null; error?: undefined } | { error: string } {
  const raw = parseJson(value);
  if (raw?.__error) return { error: `${name}: ${raw.__error}` };
  if (raw !== null && !Array.isArray(raw)) return { error: `${name} must be a JSON array` };
  return { value: raw };
}

/** A `done` entry the loop can finish on: a sentence a player could check, and the check that measures it. */
const isDoneEntry = (entry: AnyRecord | null): boolean =>
  Boolean(entry) &&
  typeof entry === "object" &&
  String(entry?.what ?? "").trim() !== "" &&
  Boolean(entry?.check) &&
  typeof entry?.check === "object";

/** A rung the lead wrote: one structural step, in a sentence. */
const isWrittenRung = (entry: AnyRecord | null): boolean =>
  Boolean(entry) && typeof entry === "object" && String(entry?.what ?? "").trim() !== "";

/** A rung of the ladder: a written step, or the open rung (`{"open":true}`) the reviewers' step fills. */
const isRung = (entry: AnyRecord | null): boolean => isWrittenRung(entry) || isOpenRung(entry);

/** `done`, read and held to its shape: 2–4 {what, check}. */
function doneArg(value: unknown): { value: any[] | null; error?: undefined } | { error: string } {
  const done = jsonArrayArg(value, "done");
  if (done.error !== undefined) return done;
  if (done.value?.some((entry: AnyRecord | null) => !isDoneEntry(entry)))
    return {
      error: `done: every entry is {"what":"one sentence a player could check","check":{…}} — the sentence says what the work is, the check measures it`,
    };
  if (done.value && done.value.length > MAX_DONE)
    return { error: `done: ${done.value.length} entries — keep it to ${MAX_DONE}; the rest are checks` };
  return done;
}

/** The ladder the director owns: `move` is simply its first rung (M3.3). */
function ladderArg(args: AnyRecord): { value: AnyRecord[]; error?: undefined } | { error: string } {
  const milestones = jsonArrayArg(args.milestones, "milestones");
  if (milestones.error !== undefined) return milestones;
  const moveText = String(args.move ?? "").trim();
  const ladder = [...(moveText ? [{ what: moveText }] : []), ...(milestones.value ?? [])];
  if (ladder.length > MAX_MILESTONES)
    return {
      error: `milestones: ${ladder.length} rungs (the move counts as one) — keep it to ${MAX_MILESTONES}; steer another in later with worker_steer move=`,
    };
  if (ladder.some((entry) => !isRung(entry)))
    return {
      error: `milestones: every rung is {"what":"one structural step — what the game IS after it","check":{…}} and "check" is optional; the last may be {"open":true}`,
    };
  return { value: ladder };
}

/** What a worker's contract is compiled from, read off the call. */
interface WorkerArgs {
  setup: AnyRecord | null;
  checks: unknown[] | null;
  done: unknown[] | null;
  ladder: AnyRecord[];
}

/**
 * A worker's own setup from `worker_start`. One that says only `begin` (the front-end's owner,
 * `{"begin":false}`) keeps the run's requested state and adds the flag: that worker's windows and
 * judges open on the run's map or mode, on its menu. Any other setup is the worker's own.
 */
export function workerSetupOf(raw: AnyRecord, runSetup: AnyRecord | null | undefined): AnyRecord | null {
  const own = normalizeScoutSetup(raw);
  if (!own || !onlyBegin(own)) return own;
  return { ...(runSetup ?? {}), ...own };
}

/** Whether a normalized setup says nothing but `begin` (and a note). */
function onlyBegin(setup: AnyRecord): boolean {
  return Object.keys(setup).every((key) => key === "begin" || key === "note");
}

/** The JSON arguments of `worker_start`, parsed and held to their shapes — or the sentence that says what is wrong. */
function parseWorkerArgs(loopRun: LoopRun, args: AnyRecord): WorkerArgs | string {
  const { run } = loopRun;
  const setupRaw = parseJson(args.setup);
  if (setupRaw?.__error) return `setup: ${setupRaw.__error}`;
  const checks = jsonArrayArg(args.checks, "checks");
  if (checks.error !== undefined) return checks.error;
  const done = doneArg(args.done);
  if (done.error !== undefined) return done.error;
  const ladder = ladderArg(args);
  if (ladder.error !== undefined) return ladder.error;
  return {
    setup: setupRaw ? workerSetupOf(setupRaw, run.setup) : (run.setup ?? null),
    checks: checks.value,
    done: done.value,
    ladder: ladder.value,
  };
}

/** What a worker forks from: the integration branch, another worker's last commit, or a commit hash. */
async function resolveForkCommit(
  loopRun: LoopRun,
  rawFrom: unknown,
): Promise<{ from: string; commit: string | null; refusal?: undefined } | { refusal: string }> {
  const { ctx, integrationWorktree, run, state, workerCommit } = loopRun;
  const from = String(rawFrom ?? BuildTarget.Integration).trim() || BuildTarget.Integration;
  if (from === BuildTarget.Integration) {
    const commit = await headOf(ctx, integrationWorktree, { label: `director:${run.runId}:fork` }).catch(
      () => state.integrationHead,
    );
    return { from, commit };
  }
  const source = state.workers.get(slug(from));
  if (source) {
    const commit = await workerCommit(source);
    if (!commit) return { refusal: `worker "${from}" has no commit to fork from yet` };
    return { from, commit };
  }
  // A worker from before a pause: its last commit, which its ref keeps.
  const prior = priorFork(loopRun, slug(from));
  if (prior)
    return prior.commit ? { from, commit: prior.commit } : { refusal: `worker "${from}" left no commit to fork from` };
  if (/^[0-9a-f]{7,40}$/i.test(from)) return { from, commit: from };
  return { refusal: `from: "${from}" is neither integration, a worker id nor a commit` };
}

/** Everything a new worker record is made of. */
interface NewWorker {
  id: string;
  args: AnyRecord;
  mode: WorkerMode;
  brief: string;
  owns: string[];
  ownsMain: boolean;
  cameras: string[];
  identity: string[];
  setup: AnyRecord | null;
  commit: string | null;
  replaces: string;
  baseConsole: string[];
  budgetMs: number;
  policySpec: AnyRecord;
}

/** A worker as the run keeps it, from the moment it is started. */
function newWorkerRecord(fields: NewWorker): StartingWorker {
  const { id, args, mode, brief, owns, ownsMain, cameras, identity, setup, commit, replaces, baseConsole } = fields;
  /** Resolved by the record's own `resolveSettle`, assigned in the same statement below. */
  let resolveSettle: (value?: unknown) => void = () => {};
  const worker: StartingWorker = {
    id,
    title: String(args.title ?? id).slice(0, TITLE_CHARS),
    mode,
    brief,
    owns,
    ownsMain,
    cameras,
    identity,
    setup,
    from: commit,
    /** The worker this one restarts, if any: one part on the user's page, not two. */
    replaces: replaces || null,
    baseConsole,
    worktree: null,
    handle: null,
    threadId: null,
    startedAt: Date.now(),
    endedAt: null,
    deadline: Date.now() + fields.budgetMs,
    state: WorkerState.Running,
    stopRequested: false,
    /** Why the director stopped it, in the words the owner reads. */
    stopWhy: null,
    iterationsCap: args.iterations,
    steering: [],
    iterations: [],
    /** How long each finished round took, for sizing the next worker (`iterationMinutes`). */
    roundMs: [],
    /** When the round now running began — the monitor's "minutes in this turn". */
    lastIterationAt: null,
    /** The last look the monitor took into its worktree: files, violations, its last frame. */
    monitor: null,
    result: null,
    lastCommit: null,
    summary: "",
    error: null,
    spec: null,
    problems: [],
    unsatisfiable: [],
    stateKeys: null,
    notVerified: null,
    /** Checks the game's ledger says have never measured anything (loop/ledger.ts). */
    rarelyMeasurable: [],
    /** The loop's own thresholds for this worker, and only what the director changed. */
    policy: fields.policySpec.policy,
    policyOverrides: fields.policySpec.overrides,
    /** The last LoopState its loop reported (`loopDigest` renders it). */
    loop: null,
    /**
     * Has its run reached the end? The deferred is made in the same statement as the record,
     * before any await, so a close racing `worker_start` can never see a running worker with
     * nothing to wait on. It is resolved by the FIRST statement of runWorker's `finally` —
     * the rest of that block saves a journal and builds a digest, either of which can throw.
     */
    settled: false,
    settle: new Promise((resolve) => {
      resolveSettle = resolve;
    }),
    resolveSettle: () => {
      worker.settled = true;
      resolveSettle();
    },
    merging: conflictMergeOf(args),
  };
  return worker;
}

/** A worker being started whose worktree is open, and whose thread is not yet (`openWorkspace`). */
type OpenedWorker = StartingWorker & { worktree: string };

/** Give back a worker's window and remove its worktree: a start that refused after they were made. */
async function releaseWorkspace(loopRun: LoopRun, worker: OpenedWorker): Promise<void> {
  const { ctx, run } = loopRun;
  if (worker.handle) await ctx.call(HostMethod.PreviewRelease, { handle: worker.handle }).catch(() => {});
  await ctx.call(HostMethod.SnapshotRemoveWorktree, { project: run.project, path: worker.worktree }).catch(() => {});
}

/**
 * A worktree and a window — each undone if what comes next refuses. Answers the worker in its
 * worktree, or the refusal.
 */
async function openWorkspace(
  loopRun: LoopRun,
  worker: StartingWorker,
  pooled: boolean,
): Promise<OpenedWorker | string> {
  const { ctx, run } = loopRun;
  try {
    const { path: worktree } = await ctx.call(HostMethod.SnapshotWorktree, {
      project: run.project,
      commit: worker.from ?? undefined,
      name: worker.id,
      runId: run.runId,
    });
    const opened = Object.assign(worker, { worktree });
    if (!pooled) return opened;
    try {
      opened.handle = (await ctx.call(HostMethod.PreviewAcquire, { label: worker.id })).handle;
    } catch (err: any) {
      await ctx
        .call(HostMethod.SnapshotRemoveWorktree, { project: run.project, path: opened.worktree })
        .catch(() => {});
      return `no worker window free (${err?.message ?? err}) — wait for a worker to finish or stop one`;
    }
    return opened;
  } catch (err: any) {
    return `could not start "${worker.id}": ${err?.message ?? err}`;
  }
}

/**
 * The clean-base gate: a worker forked from a build that does not run loses every iteration to
 * the same error (five did, once, to one shader line nobody owned). The harness looks at the
 * fork point once per commit — whatever it was forked from, not only the integration branch —
 * and it looks at THIS worker's worktree, which is that commit and nobody else's uncommitted
 * work. The run's own starting point is looked at as a base: an empty scaffold is allowed to be
 * blank, and refusing every worker over it is how a run from scratch used to end before it
 * began. Answers the refusal (the worker's workspace given back), or null.
 */
async function forkGate(loopRun: LoopRun, worker: OpenedWorker, from: string): Promise<string | null> {
  const { consoleInheritedBy, errorsLogged, ledgerFacts, note, patientEvidence, recordVerdict, remember } = loopRun;
  const { rememberEvidence, shotsOf, state } = loopRun;
  const commit = worker.from;
  if (!commit || state.healthByHead.get(commit) === true) return null;
  const gate = await patientEvidence(worker.worktree, {
    ...(worker.handle ? { handle: worker.handle } : {}),
    label: `gate_${shortSha(commit, LABEL_SHA_LENGTH)}`,
    motion: 0,
    setup: worker.setup,
    scaffold: state.baseHeads.has(commit),
    inheritedConsole: consoleInheritedBy(),
  });
  state.healthByHead.set(commit, gate.ok === true);
  worker.baseConsole = errorsLogged(gate);
  state.consoleByHead.set(commit, worker.baseConsole);
  rememberEvidence(commit, gate);
  const gateVerdict = await recordVerdict({
    pass: VerdictPass.Gate,
    head: commit,
    worker: worker.id,
    ...observedFrom(gate),
    consoleInherited: consoleInheritedBy(),
    kept: gate.ok === true,
    rule: gate.ok === true ? VerdictRule.Starts : VerdictRule.DoesNotStart,
  });
  if (gate.ok === true) return null;
  // A lead writes nothing (one session): a single session is its hands, and it starts on a build
  // that does not run — repairing it is the job.
  if (loopRun.lead && worker.mode === WorkerMode.Single) {
    note(`worker ${worker.id} starts on ${shortSha(commit)}, which does not run — ${(gate.problems ?? []).join("; ")}`);
    return null;
  }
  await releaseWorkspace(loopRun, worker);
  // A builder that never started is the loss the user feels first; the ledger keeps it so
  // the next run on this game reads "fix the fork point" before it hands out work.
  await remember(
    refusalRecord({
      ...ledgerFacts(),
      part: worker.id,
      title: worker.title,
      because: gateVerdict.because,
      problems: gate.problems ?? [],
      brief: worker.brief,
    }),
  );
  note(`worker ${worker.id} refused: ${shortSha(commit)} does not run — ${(gate.problems ?? []).join("; ")}`);
  return JSON.stringify({
    refused: worker.id,
    reason: forkRefusal(loopRun, commit, from),
    problems: gate.problems ?? [],
    consoleErrors: gate.consoleErrors ?? [],
    shots: shotsOf(gate),
  });
}

/** Why a worker may not fork from a build that does not run, in the words its lead can act on. */
function forkRefusal(loopRun: LoopRun, commit: string, from: string): string {
  if (loopRun.lead) return LEAD_FORK_REFUSED(commit, from);
  if (from === BuildTarget.Integration)
    return `the build at ${shortSha(commit)} does not run — fix it in your worktree and commit before starting workers on it`;
  return `the build at ${shortSha(commit)} (from=${from}) does not run — fork from something that runs, or fix it first`;
}

/** A new thread's id: the host answers with the id itself (an older host answered `{ id }`). */
function threadIdOf(thread: string | { id?: string }): string {
  return typeof thread === "string" ? thread : String(thread.id ?? thread);
}

/** The worker's own thread. Answers the worker, now started, or the refusal (its workspace given back). */
async function openThread(loopRun: LoopRun, worker: OpenedWorker): Promise<Worker | string> {
  const { ctx, run } = loopRun;
  try {
    const thread: string | { id?: string } = await ctx.call(HostMethod.ThreadCreate, {
      title: `${run.runId} · ${worker.title}`,
    });
    return Object.assign(worker, { threadId: threadIdOf(thread) });
  } catch (err: any) {
    await releaseWorkspace(loopRun, worker);
    return `could not start "${worker.id}": ${err?.message ?? err}`;
  }
}

/** The kind this part is judged as: what the director named for it, else the run's own. */
function workerKindOf(loopRun: LoopRun, id: string, args: AnyRecord): string | null {
  const { note, run } = loopRun;
  const namedKind = String(args.kind ?? "").trim();
  const quoted = namedKind.slice(0, KIND_QUOTED);
  const workerKind = isGameKind(namedKind) ? namedKind : (run.game?.kind ?? null);
  if (namedKind && !isGameKind(namedKind)) {
    note(
      `worker ${id}: kind "${quoted}" is not a kind (${KIND_NAMES.join(", ")}) — judged as ${workerKind ?? "a game that declares nothing"}`,
    );
  }
  return workerKind;
}

/** The critic this part is reviewed by when the director named one (`screen` for a UI or HUD part); else null, its kind's. */
function workerCriticOf(loopRun: LoopRun, id: string, args: AnyRecord): string | null {
  const named = String(args.critic ?? "").trim();
  if (!named) return null;
  if (Object.hasOwn(CRITIC_PRINCIPLES, named)) return named;
  loopRun.note(
    `worker ${id}: critic "${named.slice(0, KIND_QUOTED)}" is not a critic (${Object.keys(CRITIC_PRINCIPLES).join(", ")}) — reviewed by its kind's`,
  );
  return null;
}

/** The contract, compiled and read against what the fork point reports (see compileWorkerSpec). */
function compileContract(loopRun: LoopRun, worker: Worker, parsed: WorkerArgs, args: AnyRecord): void {
  const { neverMeasured, note, ownShape, state } = loopRun;
  const { id } = worker;
  const workerKind = workerKindOf(loopRun, id, args);
  if (worker.mode !== WorkerMode.Loop) return;
  const compiled = compileWorkerSpec(
    {
      id,
      title: worker.title,
      brief: briefWithContract(loopRun, worker.brief, [id, args.replaces, args.goal]),
      owns: worker.owns,
      identity: worker.identity,
      cameras: worker.cameras,
      checks: parsed.checks ?? [],
      done: parsed.done ?? [],
      milestones: parsed.ladder,
      traits: list(args.traits),
      kind: workerKind,
      critic: workerCriticOf(loopRun, id, args),
      ownsMain: worker.ownsMain,
      setup: worker.setup,
      screen: !ownShape,
      index: state.workers.size,
      forkedFrom: worker.from,
      stage: String(args.stage ?? "").trim() || null,
    },
    state.evidenceByHead.get(worker.from) ?? null,
    { rarelyMeasurable: neverMeasured() },
  );
  worker.problems = compiled.problems;
  worker.unsatisfiable = compiled.unsatisfiable;
  worker.stateKeys = compiled.stateKeys;
  worker.notVerified = compiled.notVerified;
  worker.rarelyMeasurable = compiled.rarelyMeasurable;
  worker.spec = compiled.spec;
  // Live, not a snapshot: a worker started later is one this worker's judge can route to.
  state.facetSpecs.push(worker.spec);
  // …and who owns the screen, both ways round (loop/screen-owner.ts).
  linkScreenOwner(state.facetSpecs, worker.spec, worker.replaces);
  if (compiled.unsatisfiable.length) {
    note(
      `worker ${id}: ${compiled.unsatisfiable.length} check(s) name paths ${shortSha(worker.from)} does not report — ${compiled.unsatisfiable.map((u) => `${u.id} (${u.missing.join(", ")})`).join("; ")}`,
    );
  }
  if (compiled.rarelyMeasurable.length) {
    note(
      `worker ${id}: ${compiled.rarelyMeasurable.map((c) => `${c.id} has come back unmeasured on ${c.rounds} rounds of this kind of game`).join("; ")} — re-point it or drop it`,
    );
  }
}

/** A loop worker's contract (compileContract): a loop worker without one is a bug, and says so. */
function contractOf(worker: Worker): FacetSpec {
  if (!worker.spec) throw new Error(`worker ${worker.id} has no contract`);
  return worker.spec;
}

/** How many of a worker's checks are identity checks — what it can finish on. */
const identityChecks = (worker: Worker): number =>
  contractOf(worker).checks.filter((c: AnyRecord) => c.weight === CheckWeight.Identity).length;

/** The worker on the run's record: its state, the journal, the card, the decision and the log. */
async function announceWorker(loopRun: LoopRun, worker: Worker, { budgetMs, replaces, roundWarning }: AnyRecord) {
  const { appendRun, decision, journal, note, saveJournal, state } = loopRun;
  const { id, mode, brief } = worker;
  state.workers.set(id, worker);
  journal.director.workers[id] = {
    id,
    title: worker.title,
    mode,
    from: worker.from,
    startedAt: new Date(worker.startedAt).toISOString(),
  };
  await saveJournal();
  // The contract on the card: what it is measured by, and what nobody could read on the base.
  await appendRun(RunEvent.DirectorWorker, {
    workerId: id,
    title: worker.title,
    mode,
    worktree: worker.worktree,
    from: worker.from,
    state: WorkerState.Running,
    minutes: minutes(budgetMs),
    ...(replaces ? { replaces } : {}),
    ...(mode === WorkerMode.Loop
      ? {
          checks: contractOf(worker).checks.length,
          identityChecks: identityChecks(worker),
          unusableChecks: worker.unsatisfiable.map((u: AnyRecord) => u.id),
        }
      : {}),
  });
  // The same start in Genex's one worker model, which the Builds graph and the chat read.
  await recordBuilderStarted(loopRun, worker);
  const quoted = `${brief.slice(0, BRIEF_QUOTED)}${brief.length > BRIEF_QUOTED ? "…" : ""}`;
  await decision(
    `director started worker "${worker.title}" (${id}, ${mode}, ${minutes(budgetMs)} min): ${quoted}${roundWarning ? ` — ${roundWarning}` : ""}`,
    `started a builder on ${worker.title}, for about ${minutes(budgetMs)} minutes`,
  );
  note(`worker ${id} started (${mode})`);
}

/** Set the worker going in the background; the monitor looks into it from here on. */
function launchWorker(loopRun: LoopRun, worker: Worker): void {
  const { runWorker, startMonitor } = loopRun;
  startMonitor();
  worker.promise = runWorker(worker).catch((err: any) => {
    worker.error = String(err?.message ?? err);
    setWorkerState(worker, WorkerState.Failed);
  });
}

/**
 * The ladder it will climb, one rung per accepted build — or a warning that the harness's own
 * planner will name the move instead, which is rarely your brief. A finishing worker takes no
 * move at all, and says so.
 */
function ladderFields(spec: FacetSpec): AnyRecord {
  if (isFinishing(spec)) return { stage: FacetStage.Finish, moves: FINISH_START_MOVES };
  if (spec.milestones?.length) return { milestones: spec.milestones.map((m: AnyRecord) => m.what) };
  return {
    moves:
      "no move and no milestones: the harness's planner names one structural move per iteration once identity holds — give `move` (and `milestones`) if the order matters to you",
  };
}

/** What `worker_start` answers about a loop worker's contract: what it finishes on, its ladder, its warnings. */
function loopStartFields(worker: Worker): AnyRecord {
  const spec = contractOf(worker);
  return {
    checks: spec.checks.length,
    // What it will finish on. No identity check means no exit but "every check passes".
    identityChecks: identityChecks(worker),
    ...(spec.done?.length ? { done: spec.done.map((d: AnyRecord) => d.id) } : {}),
    ...ladderFields(spec),
    ...(identityChecks(worker) > 0
      ? {}
      : {
          warning:
            "no identity checks: this worker can only finish when every check on its board passes, judge-grown ones included — give it `done` (2–4 {what, check})",
        }),
    ...(worker.problems.length ? { checkProblems: worker.problems } : {}),
    // The dry run against the fork point: a path it does not report is a note in the
    // builder's brief, not a refusal — but you should know before the first iteration.
    ...(worker.unsatisfiable?.length
      ? { unsatisfiable: worker.unsatisfiable, stateReports: worker.stateKeys ?? [] }
      : {}),
    // What the game's own ledger says about these checks: a check nobody has ever been
    // able to read is not a contract, however well it dry-runs against one commit.
    ...(worker.rarelyMeasurable?.length
      ? {
          rarelyMeasurable: worker.rarelyMeasurable,
          rarelyMeasurableWarning: `these checks came back unmeasured on ${worker.rarelyMeasurable.map((c: AnyRecord) => `${c.id} (${c.rounds} rounds)`).join(", ")} of earlier runs on this kind of game — re-point them at something the build reports, or drop them`,
        }
      : {}),
    ...(worker.notVerified ? { notVerified: worker.notVerified } : {}),
  };
}

/**
 * What `worker_start` answers once the worker is running; `waking` for a lead that ends its turn
 * instead of waiting, `lead` for one that writes nothing (one session) and so commits nothing first.
 */
function startAnswer(worker: Worker, { budgetMs, roundWarning, policySpec, dirty, waking, lead }: AnyRecord): string {
  return JSON.stringify({
    started: worker.id,
    mode: worker.mode,
    worktree: worker.worktree,
    forkedFrom: shortSha(worker.from ?? ""),
    minutes: minutes(budgetMs),
    ...(roundWarning ? { roundWarning } : {}),
    ...(Object.keys(policySpec.overrides).length ? { policy: policySpec.overrides } : {}),
    ...(policySpec.warnings.length ? { policyWarnings: policySpec.warnings } : {}),
    ...(worker.mode === WorkerMode.Loop ? loopStartFields(worker) : {}),
    ...(dirty ? { note: lead ? LEAD_START_DIRTY : START_DIRTY } : {}),
    next: waking ? WAKE_START_NEXT : "worker_wait, or start another worker; worker_status for detail",
  });
}

/**
 * Whether `id` may be started at all: a free id — not this session's, nor one a worker from before
 * a pause left work under, unless it builds on that work — a brief, a plan, and the plan review's word.
 */
async function startPreconditions(loopRun: LoopRun, id: string, args: AnyRecord): Promise<string | null> {
  const { holdForPlanReview, state } = loopRun;
  if (RESERVED_WORKER_IDS.has(id)) return `"${id}" is reserved; pick another id`;
  if (state.workers.has(id)) return `worker "${id}" already exists (${state.workers.get(id)?.state}); pick another id`;
  const buried = priorIdRefusal(loopRun, id, slug(args.from));
  if (buried) return buried;
  if (!briefOf(args)) return "a worker needs a brief (task)";
  if (!state.plan) {
    return `call plan first: the user must be able to read what this run is for before a builder starts. plan takes a summary in plain words and the parts you mean to hand out (id, title, seam, owns, done, minutes) — then start "${id}".`;
  }
  return goalRefusal(loopRun, id, args) ?? holdForPlanReview(id);
}

/** Whether the run's required outcomes let `id` start: none verified or blocked, and its own goal open. */
function goalRefusal(loopRun: LoopRun, id: string, args: AnyRecord): string | null {
  const { state } = loopRun;
  // A goal commission with no outcomes yet stands on a plan that set none: a finished build reopened
  // with Loop ∞, whose outcomes are what its lead plans for the ask (director/reopen.ts).
  if (!state.goals) return goalCommission(loopRun.run) ? MESSAGE_OUTCOMES_FIRST : null;
  const decision = goalDecision(state.goals, state.integrationHead);
  if (decision === GoalStatus.Passed) return "Required outcomes are verified: finish instead of adding optional work.";
  if (decision === GoalStatus.Blocked)
    return "Required work is blocked: finish honestly without victory and report the prerequisite.";
  // A conflict worker finishes work a goal's worker already did: resolving its merge is not a new
  // attempt at any goal, and it names none.
  if (conflictMergeOf(args)) return null;
  return goalAttemptRefusal(state.goals, String(args.goal ?? id));
}

/**
 * The fork point, held to the module contract a plan of several looping parts carries
 * (contract-gate.ts): the commit, and the seam the worker starts with — its contract modules when
 * it named none — or the refusal.
 */
async function contractedFork(
  loopRun: LoopRun,
  id: string,
  args: AnyRecord,
  mode: WorkerMode,
): Promise<{ from: string; commit: string | null; owns: string[]; refusal?: undefined } | { refusal: string }> {
  const uncontracted = await contractBeforeFork(loopRun, args, mode);
  if (uncontracted) return { refusal: uncontracted };
  const fork = await resolveForkCommit(loopRun, args.from);
  if (fork.refusal !== undefined) return fork;
  const contracted = await contractAtFork(loopRun, { id, args, mode, commit: fork.commit });
  if (contracted.refusal !== undefined) return { refusal: contracted.refusal };
  return { from: fork.from, commit: fork.commit, owns: contracted.owns ?? list(args.owns) };
}

export async function startWorker(loopRun: LoopRun, args: AnyRecord) {
  const { ctx, integrationWorktree, medianRoundMs, note, run, runningWorkers, startRefusal, state } = loopRun;
  const id = slug(args.id) || defaultWorkerId(loopRun);
  const goal = String(args.goal ?? id);
  const precondition = await startPreconditions(loopRun, id, args);
  if (precondition) return precondition;
  const missingPrerequisite = await requireMultiplayer(loopRun, goal);
  if (missingPrerequisite) return missingPrerequisite;
  const allowed = await startRefusal(id, args);
  if (typeof allowed === "string") return allowed;
  const { pooled, remaining, replaces, policySpec } = allowed;
  const mode = workerModeOf(args);
  const budgetMs = Math.min(
    Math.max(WORKER_MIN_MINUTES, num(args.minutes, WORKER_DEFAULT_MINUTES)) * MINUTE_MS,
    remaining,
  );
  // What a round on this game has actually cost, against what this worker is being given.
  const roundWarning = shortBudgetWarning(budgetMs, medianRoundMs());
  const ownsMain = yes(args.owns_main, runningWorkers().length === 0);
  const parsed = parseWorkerArgs(loopRun, args);
  if (typeof parsed === "string") return parsed;
  const fork = await contractedFork(loopRun, id, args, mode);
  if (fork.refusal !== undefined) return fork.refusal;
  const { from, commit, owns } = fork;
  const dirty = await gitAt(ctx, integrationWorktree, GIT.status, { label: `director:${run.runId}:dirty` }).catch(
    () => "",
  );
  const starting = newWorkerRecord({
    id,
    args,
    mode,
    brief: briefOf(args),
    owns,
    ownsMain,
    cameras: list(args.cameras),
    identity: list(args.identity),
    setup: parsed.setup,
    commit,
    replaces,
    baseConsole: state.consoleByHead?.get(commit) ?? [],
    budgetMs,
    policySpec,
  });
  // A plugin of the game may hold the builder back before anything of it is made.
  const held = await workerStartHooks(ctx, loopRun.game, runMoment(loopRun), starting);
  if (held) return HOOK_PROMPTS.workerHeld(held);
  const opened = await openWorkspace(loopRun, starting, pooled);
  if (typeof opened === "string") return startRefused(loopRun, starting, opened);
  const refused = await forkGate(loopRun, opened, from);
  if (refused) return startRefused(loopRun, starting, refused);
  const worker = await openThread(loopRun, opened);
  if (typeof worker === "string") return startRefused(loopRun, starting, worker);
  worker.goal = goal;
  compileContract(loopRun, worker, parsed, args);
  // A part the art director found defects in while nobody ran it: they are this worker's questions now.
  loopRun.takeShelvedShipDefects?.(worker);
  for (const warning of policySpec.warnings) note(`worker ${id}: policy ${warning}`);
  await announceWorker(loopRun, worker, { budgetMs, replaces, roundWarning });
  await chargeGoalAttempt(loopRun, goal);
  launchWorker(loopRun, worker);
  return startAnswer(worker, {
    budgetMs,
    roundWarning,
    policySpec,
    dirty,
    waking: loopRun.waking === true,
    lead: Boolean(loopRun.lead),
  });
}

/** A builder refused after its start was announced: its end is announced too, and the refusal is the answer. */
async function startRefused(loopRun: LoopRun, starting: StartingWorker, refusal: string): Promise<string> {
  await workerEndHooks(loopRun.ctx, loopRun.game, runMoment(loopRun), starting);
  return refusal;
}

async function chargeGoalAttempt(loopRun: LoopRun, goal: string): Promise<void> {
  if (!loopRun.state.goals) return;
  startGoalAttempt(loopRun.state.goals, goal);
  await loopRun.saveJournal();
}

// ── running a worker ──

/**
 * A judged or stopped round, kept: the worker's own digest, the game's ledger (before anything
 * else can lose it: what was decided, why, what it measured, and what the builder was told),
 * what the round cost, the report and the run's log.
 */
export function recordRound(loopRun: LoopRun, worker: Worker, record: AnyRecord): void {
  const { ledgerFacts, note, remember, report } = loopRun;
  const kept = withoutFrames(iterationDigest(record));
  worker.iterations.push(kept);
  void remember(
    roundRecord({
      ...ledgerFacts(),
      part: worker.id,
      title: worker.title,
      round: record.iteration,
      winner: record.winner ?? null,
      satisfied: record.satisfied === true,
      verdictSource: record.verdictSource ?? null,
      scoreboard: record.scoreboard ?? null,
      gap: record.biggest_gap ?? "",
      minutes: minutes(Date.now() - (worker.lastIterationAt ?? worker.startedAt)),
      brief: worker.brief,
    }),
  );
  // What the round cost, kept so the next worker's budget is sized from data and not
  // from the eight minutes a round was assumed to take (observed: nine to forty-six). A build
  // block is one long first round on purpose (facet/build-block.ts), not what a round costs.
  if (!record.buildBlock) worker.roundMs.push(Date.now() - (worker.lastIterationAt ?? worker.startedAt));
  // The next round starts here, and with it the monitor's clock and its blank slate.
  worker.lastIterationAt = Date.now();
  worker.monitor = null;
  report.iterations.push({ facetId: worker.id, ...kept });
  // The round a stop cut short is the lead's own doing: it opens the next digest, and wakes nobody.
  const stoppedByLead = worker.stopRequested && kept.stopped === true;
  note(roundNote(worker.id, kept), stoppedByLead ? NoteKind.WorkerStopped : NoteKind.WorkerRound);
  void keepRound(loopRun, worker, kept).catch(() => {});
}

/**
 * The workers' engine answered again: a session of a worker started after that engine's limit has
 * come back. The limit is gone, so `run_status` stops saying `worker_start` will meet it — most of
 * all when the engine gave no reset time for the wake loop to wait out.
 */
function workersLimitOutlived(loopRun: LoopRun, worker: Worker): void {
  const { state } = loopRun;
  if (state.workerLimit && worker.startedAt > state.workerLimit.at) state.workerLimit = null;
}

/**
 * A round, on the journal before the lead has heard of it: a restart in between must not lose it.
 * While the lead rests, the wake the round causes saves it — or the news the wake loop saves when
 * that wake is held (wake.ts) — so it makes no save of its own. An accepted round's commit is the
 * worktree's HEAD, which the loop has just made its incumbent (and written to the worker's ref):
 * the journal names it as the worker's last commit while it builds. An accepted round is also its
 * builder's engine answering again. A lost one says nothing of that: a round whose build turn a
 * rate or usage limit cut short is published too (facet publish.ts runs before the engine's health
 * is read), and only a build that ran can win.
 */
async function keepRound(loopRun: LoopRun, worker: Worker, kept: AnyRecord): Promise<void> {
  const { ctx, saveJournal } = loopRun;
  if (kept.won) workersLimitOutlived(loopRun, worker);
  if (kept.won && worker.worktree)
    worker.lastAccepted = await headOf(ctx, worker.worktree).catch(() => worker.lastAccepted ?? null);
  if (loopRun.resting === true) return;
  await saveJournal();
}

/** A round in the run's log: accepted, lost or stopped, and why. */
function roundNote(id: string, kept: AnyRecord): string {
  let outcome = "lost";
  if (kept.stopped) outcome = "stopped before it was judged";
  else if (kept.won) outcome = "accepted";
  const why = kept.reason ? ` — ${String(kept.reason).slice(0, CLIP_QUOTE)}` : "";
  const move = kept.move?.note ? ` (${kept.move.note})` : "";
  return `worker ${id}: iteration ${kept.iteration} ${outcome}${why}${move}`;
}

/**
 * The integration hook a loop worker's facet loop merges from: the head the last wave closed on,
 * so running workers take the integration branch once per wave and not after every commit the
 * lead makes (integrate.ts); the integration head itself until a wave has closed. `latest` is the
 * lead's newest head, which a worker may have been told to merge before its wave closes: its
 * review walks back from there (facet/merged-heads.ts).
 */
export function loopIntegration(loopRun: LoopRun): {
  head: () => Promise<string | null>;
  latest: () => Promise<string | null>;
} {
  const { state } = loopRun;
  return { head: async () => state.waveHead ?? state.integrationHead, latest: async () => state.integrationHead };
}

/**
 * Does this loop worker open with a build block (facet/build-block.ts)? A new part does; a restart
 * of one this run already had — `replaces=`, or an id from before a pause — builds on what exists
 * and is judged side by side from its first round.
 */
function opensWithBuildBlock(loopRun: LoopRun, worker: Worker): boolean {
  return !worker.replaces && !priorWorkerIds(loopRun).includes(worker.id);
}

/** The judged loop a loop worker runs, until its `done` checks pass or its budget ends. */
async function runLoopWorker(loopRun: LoopRun, worker: Worker): Promise<void> {
  const { ctx, medianRoundMs, note, noteWorkerLimit, ownShape, projectDir, run, shape, state, threadId } = loopRun;
  const result = await runFacetLoop(ctx, {
    runThreadId: threadId,
    facetThreadId: worker.threadId,
    run,
    facet: contractOf(worker),
    ownsMain: worker.ownsMain,
    shape,
    ownShape,
    seed: PAGE_SEED,
    worktree: worker.worktree,
    handle: worker.handle,
    deadline: worker.deadline,
    buildBlock: opensWithBuildBlock(loopRun, worker),
    // How many rounds fit, sized from what a round on this game has actually cost. Eight
    // minutes was the assumption; the rounds of one real run took nine to forty-six.
    maxIterations: Math.max(
      1,
      num(
        worker.iterationsCap,
        Math.max(
          MIN_SIZED_ROUNDS,
          Math.round((worker.deadline - worker.startedAt) / (medianRoundMs() ?? ASSUMED_ROUND_MS)),
        ),
      ),
    ),
    // And what the loop holds a round to before it starts one, until this worker has
    // finished a round of its own and can measure itself.
    minIterationMs: medianRoundMs(),
    policy: worker.policy,
    // A worker of the run: its build turns carry the grant (`worker: {`), so the host seats them in
    // the mode of the chat the run was started in.
    worker: workerGrant(loopRun, worker),
    // Genex's identity opens each fresh build session: the game's folder and what it holds.
    identity: runIdentity(loopRun),
    // The director's window into the machinery deciding its worker's run (M4.10). The
    // note only fires on a transition, so the lead is woken on what changed and on nothing else.
    onLoopState: (loop: AnyRecord) => {
      const said = loopNote(worker.id, worker.loop, loop);
      worker.loop = loop;
      if (said) note(said, NoteKind.WorkerLoop);
    },
    // A round that waits for a lost provider wakes the lead; a lost sign-in then pauses the run (wake.ts).
    onProviderLost: (lost: AnyRecord) =>
      note(
        `worker ${worker.id}: its round waits for the model provider (${lost.engine}: ${lossWords(lost.kind)}) — nothing is counted against it`,
        NoteKind.WorkerLimit,
      ),
    steering: async () => {
      const own = worker.steering.splice(0, worker.steering.length);
      return own;
    },
    // Who stopped it, in words. Nothing here is ever the user's doing: the director
    // stops its own workers, and a run that stops five to fix a shader must not tell
    // the owner they asked for it.
    finishRequested: async () => {
      if (worker.stopRequested) return { by: "director", reason: worker.stopWhy ?? "stopped by the director" };
      if (state.finish) return { by: "director", reason: "stopped by the director: the build is wrapping up" };
      return false;
    },
    // Once a wave has closed, a worker takes the integration branch once per wave (integrate.ts).
    integration: loopIntegration(loopRun),
    projectDir,
    onIteration: (record: AnyRecord) => recordRound(loopRun, worker, record),
    facets: state.facetSpecs,
    // A defect that belongs to another worker's seam goes to that worker, not onto this
    // one's board (WP2d); the classic pipeline has always done this and the director's
    // workers never did — see makeRouteDefect.
    routeDefect: makeRouteDefect({ workers: state.workers, from: worker.id, ledger: state.ledger, note }),
    baseShots: state.startEvidence?.shots ?? [],
    baseConsole: worker.baseConsole ?? [],
  });
  worker.result = withoutFrames({
    board: result.board,
    spec: result.spec,
    attempts: result.attempts,
    stoppedBecause: result.stoppedBecause,
    satisfied: result.satisfied,
    iterations: result.iterations,
    sessionId: result.sessionId,
    loopState: result.loopState ?? null,
  });
  if (result.limit) noteWorkerLimit(worker, result.limit);
  worker.lastCommit = result.lastCommit ?? (await headOf(ctx, worker.worktree).catch(() => null));
  setWorkerState(worker, worker.stopRequested ? WorkerState.Stopped : WorkerState.Done);
}

/**
 * A single session's ownership. A single-session worker had no ownership at all: the hook never
 * fired and the locks never ran, so the seam the director typed was a sentence in a brief and
 * nothing else. It carries the same object a loop worker's rounds do.
 */
function singleOwnership(loopRun: LoopRun, worker: Worker): DelegateOwnership {
  const { ownShape, shape } = loopRun;
  return {
    facetId: worker.id,
    owns: worker.owns ?? [],
    ownsMain: worker.ownsMain,
    ...(ownShape ? { template: false } : {}),
    ...(ownShape && shape?.serve && shape.serve !== "." ? { neverLock: [shape.serve] } : {}),
    ...(ownShape && shape?.main ? { main: shape.main, studio: STUDIO_CONTRACT } : {}),
  };
}

/** A delegation that threw, as the answer the session loop reads: failed, and the engine's own limit kept by kind. */
function failedDelegation(loopRun: LoopRun, err: any): AnyRecord {
  const { run } = loopRun;
  return {
    ok: false,
    errorText: String(err?.message ?? err),
    stopReason: err?.kind === EngineFailure.Aborted ? StopReason.Aborted : StopReason.Error,
    summary: "",
    // The engine's own limit, kept by kind: the director is told which engine is out.
    ...(isEngineLimit(err?.kind) ? { limit: workerLimitOf(err, roleEngine(run, RoleKey.Builder)) } : {}),
  };
}

/** The limit a worker's engine died of, with the engine named (the workers may be on the other subscription). */
function workerLimitOf(err: any, engine: string): AnyRecord {
  return {
    kind: err.kind,
    engine,
    message: String(err?.message ?? err),
    retryAfterMs: typeof err?.retryAfterMs === "number" ? err.retryAfterMs : null,
  };
}

/**
 * One turn of a single-session worker: its brief (or a steer) delegated to the builder's engine. A
 * turn the chat's Settings ceiling has no room for yet waits for room until the worker's deadline
 * (`withWorkerRoom`), unless the run or the worker is stopped meanwhile.
 */
function delegateSingle(loopRun: LoopRun, worker: Worker, prompt: string, resume: string | null): Promise<AnyRecord> {
  const { ctx, run } = loopRun;
  // A stop the director asked for ends the wait too: the worker never takes the turn it waited for.
  const stopped = () => Boolean(ctx.cancelled) || worker.stopRequested || !isRunning(worker);
  return withWorkerRoom(
    () => singleTurn(loopRun, worker, prompt, resume),
    worker.deadline,
    stoppableRoomClock(stopped),
  ).catch((err: any) => {
    // A sign-in or a limit the builders' engine lost holds it for the whole run (provider-loss.ts).
    noteProviderLoss(run.runId, roleEngine(run, RoleKey.Builder), err);
    return failedDelegation(loopRun, err);
  });
}

/** One delegation of a single-session worker's turn, as the host answers it (a refusal throws). */
function singleTurn(loopRun: LoopRun, worker: Worker, prompt: string, resume: string | null): Promise<AnyRecord> {
  const { ctx, run } = loopRun;
  return ctx.call(HostMethod.EngineDelegate, {
    engine: roleEngine(run, RoleKey.Builder),
    prompt,
    project: run.project,
    cwd: worker.worktree,
    threadId: worker.threadId,
    ...(run.model ? { model: run.model } : {}),
    ...(roleEffort(run, RoleKey.Builder) ? { effort: roleEffort(run, RoleKey.Builder) } : {}),
    ...(resume ? { resume } : {}),
    timeoutMs: Math.max(MIN_DELEGATE_TIMEOUT_MS, worker.deadline - Date.now()),
    selfCapture: {
      project: run.project,
      root: worker.worktree,
      runId: run.runId,
      facetId: worker.id,
      iteration: 1,
      handle: worker.handle ?? undefined,
      ...(worker.setup ? { setup: worker.setup } : {}),
      label: worker.title,
    },
    ownership: singleOwnership(loopRun, worker),
    // A worker of the run (`worker: {`): the host seats it in the mode of the run's chat.
    worker: workerGrant(loopRun, worker),
  });
}

/** The worker grant a builder's delegations carry: its id and title, and the run that started it. */
function workerGrant(loopRun: LoopRun, worker: Worker): { id: string; title: string; runId: string } {
  return { id: worker.id, title: worker.title, runId: loopRun.run.runId };
}

/** Whatever a single session made is committed — partial work is worth more than a clean tree. */
async function commitSingleWork(loopRun: LoopRun, worker: Worker, delegation: AnyRecord): Promise<void> {
  const { ctx, run } = loopRun;
  try {
    await commitAll(
      ctx,
      worker.worktree,
      `worker ${worker.id}: ${worker.title}${delegation.ok ? "" : " (unfinished)"}`,
      {
        allowEmpty: true,
        label: `director:${run.runId}:commit:${worker.id}`,
      },
    );
    worker.lastCommit = await headOf(ctx, worker.worktree);
  } catch (err: any) {
    worker.error = `${worker.error ? `${worker.error}; ` : ""}commit failed: ${err?.message ?? err}`;
  }
}

/** Where a single session ended: stopped by the director, done, or failed. */
function singleEndState(worker: Worker, delegation: AnyRecord): WorkerState {
  if (worker.stopRequested) return WorkerState.Stopped;
  return delegation.ok ? WorkerState.Done : WorkerState.Failed;
}

/** Has a single session's turn ended in a way it resumes from: interrupted, and nobody stopping it? */
function resumable(loopRun: LoopRun, worker: Worker, delegation: AnyRecord): boolean {
  const interrupted = !delegation.ok && delegation.stopReason === "stopped" && Boolean(delegation.sessionId);
  return interrupted && !worker.stopRequested && !loopRun.ctx.cancelled;
}

/**
 * The session's turns: its brief, then each interrupt resumed with the steers that caused it. An
 * interrupt with nothing new to hear — a second steer's, landing on the turn that already took
 * it — resumes it to carry on, a few times in a row at most. Answers the last turn.
 */
async function runSingleSession(loopRun: LoopRun, worker: Worker, brief: string): Promise<AnyRecord> {
  const { appendRun, run } = loopRun;
  let prompt = brief;
  let resume: string | null = null;
  let emptyInterrupts = 0;
  for (;;) {
    const delegation = await delegateSingle(loopRun, worker, prompt, resume);
    if (!resumable(loopRun, worker, delegation)) return delegation;
    resume = delegation.sessionId;
    const arrived = worker.steering.splice(0, worker.steering.length).filter(Boolean);
    if (!arrived.length) {
      if (++emptyInterrupts > MAX_EMPTY_INTERRUPTS) return delegation;
      prompt = carryOnPrompt();
      continue;
    }
    emptyInterrupts = 0;
    await appendRun(RunEvent.FacetSteered, {
      runId: run.runId,
      facetId: worker.id,
      iteration: 1,
      texts: arrived.map((t: unknown) => String(t).slice(0, CLIP_REASON)),
      delivered: "mid-session",
    });
    prompt = steerPrompt(arrived);
  }
}

/**
 * One builder session on the director's brief. A single session has no round boundary for a
 * steer to wait for, so a steer is handed to it the only way in: the turn is interrupted and the
 * same session resumes with the instruction in front of it. It used to be told it could not be
 * steered at all.
 */
async function runSingleWorker(loopRun: LoopRun, worker: Worker): Promise<void> {
  const { gameFacts, noteWorkerLimit, ownShape, projectDir, run, shape } = loopRun;
  // A conflict worker's merge is opened first; one that went through, or failed, needs no session.
  if (await mergeFirst(loopRun, worker)) return;
  // Genex's identity opens the brief: the game's folder and what the run found it holds.
  const brief = singleWorkerBrief({
    run,
    worker,
    shape,
    ownShape,
    setup: worker.setup,
    facts: gameFacts ?? null,
    gameFolder: projectDir || null,
  });
  const delegation = await runSingleSession(loopRun, worker, brief);
  worker.summary = String(delegation.summary ?? "").slice(0, SUMMARY_CHARS);
  if (delegation.limit) noteWorkerLimit(worker, delegation.limit);
  else if (delegation.ok) workersLimitOutlived(loopRun, worker);
  // A session the director aborted did not fail — it obeyed. Its reason is `stopWhy`.
  if (!delegation.ok && !worker.stopRequested)
    worker.error = delegation.errorText || delegation.stopReason || "the session did not finish";
  // A conflict worker that left markers commits nothing, however its session ended (conflict-worker.ts).
  if (await markersLeft(loopRun, worker)) {
    setWorkerState(worker, WorkerState.Failed);
    return;
  }
  await commitSingleWork(loopRun, worker, delegation);
  setWorkerState(worker, singleEndState(worker, delegation));
}

/**
 * A worker's close-out, whatever ended it: its window given back, its ref written, and its end
 * on the journal, the report, the feed and the run's log.
 */
async function closeOutWorker(loopRun: LoopRun, worker: Worker): Promise<void> {
  const { appendRun, ctx, journal, note, protectWorker, report, saveJournal } = loopRun;
  worker.endedAt = Date.now();
  if (worker.handle) await ctx.call(HostMethod.PreviewRelease, { handle: worker.handle }).catch(() => {});
  worker.handle = null;
  await protectWorker(worker).catch(() => {});
  journal.director.workers[worker.id] = {
    ...journal.director.workers[worker.id],
    state: worker.state,
    lastCommit: worker.lastCommit,
    endedAt: new Date().toISOString(),
  };
  report.workers[worker.id] = workerDigest(worker);
  await saveJournal();
  const because = worker.result?.stoppedBecause ?? worker.stopWhy ?? worker.error ?? null;
  await appendRun(RunEvent.DirectorWorker, {
    workerId: worker.id,
    title: worker.title,
    mode: worker.mode,
    state: worker.state,
    lastCommit: worker.lastCommit,
    stoppedBecause: because,
    ...(worker.replaces ? { replaces: worker.replaces } : {}),
  });
  await recordBuilderEnded(loopRun, worker, because);
  await workerEndHooks(loopRun.ctx, loopRun.game, runMoment(loopRun), worker);
  // A worker the lead stopped settling is its own doing: it opens the next digest, and wakes nobody.
  note(
    `worker ${worker.id} ${worker.state}${because ? ` — ${because}` : ""}`,
    worker.stopRequested ? NoteKind.WorkerStopped : NoteKind.WorkerEnded,
  );
}

export async function runWorker(loopRun: LoopRun, worker: Worker) {
  try {
    if (worker.mode === WorkerMode.Loop) await runLoopWorker(loopRun, worker);
    else await runSingleWorker(loopRun, worker);
  } catch (err: any) {
    worker.error = String(err?.message ?? err);
    setWorkerState(worker, worker.stopRequested ? WorkerState.Stopped : WorkerState.Failed);
  } finally {
    // First, before anything that can throw: a close is waiting on this, and a journal write
    // or a digest that fails would otherwise leave it waiting for the whole settle window.
    worker.resolveSettle();
    await closeOutWorker(loopRun, worker);
  }
}

/**
 * Pull a worker off. The abort reaches the engine, which reports the turn as `stopped`; the
 * loop then keeps the half-written tree (committed, un-reset) instead of judging it. `why` is
 * the sentence the owner reads in place of "at the user's request".
 */
export async function stopWorker(loopRun: LoopRun, worker: Worker, why: string | null = null, source = "director") {
  const { appendRun, ctx } = loopRun;
  if (!isRunning(worker)) return;
  worker.stopRequested = true;
  await appendRun(RunEvent.WorkerStopRequested, {
    workerId: worker.id,
    source,
    reason: String(why ?? "").trim() || null,
  }).catch(() => {});
  const said = String(why ?? "").trim();
  worker.stopWhy = said ? `stopped by the director: ${said}` : "stopped by the director";
  if (worker.worktree) await ctx.call(HostMethod.EngineAbort, { cwd: worker.worktree }).catch(() => {});
}

/**
 * Steering that cannot wait. A build turn is one long delegation, so the only way into it is
 * to interrupt it: the engine reports the turn as `stopped` and hands back its session id, and
 * the worker resumes that same session with the steer in front of everything. Between rounds
 * there is nothing to interrupt — the queue is read at the top of the next one, a minute away
 * rather than the fifteen to twenty-three minutes a steer used to wait for a boundary.
 * Answers whether a turn was actually interrupted.
 */
export async function interruptWorker(loopRun: LoopRun, worker: Worker) {
  const { ctx } = loopRun;
  if (!worker.worktree || !isRunning(worker)) return false;
  const answer = await ctx.call(HostMethod.EngineInterrupt, { cwd: worker.worktree }).catch(() => null);
  return answer?.interrupted === true;
}

// ── waiting and talking ──
/**
 * A steer the user addressed to one worker (`to=<id>` in the chat). The director's own drain
 * only ever sees the unaddressed ones, so in a director's run these were written,
 * acknowledged in the chat and delivered to nobody at all. They go straight to the worker's
 * own queue and interrupt its build turn: the point of naming a worker is that the answer
 * arrives in a minute, not at a boundary twenty minutes away. The director hears about each
 * one either way — it is still the run's to act on when nobody by that name is building.
 */
export async function routeUserSteers(loopRun: LoopRun) {
  const { inbox, interruptWorker, note, state } = loopRun;
  for (const { facetId, text } of await inbox.addressed().catch(() => [])) {
    const worker = state.workers.get(slug(facetId));
    if (!worker || !isRunning(worker)) {
      note(
        `USER SAYS about ${facetId}: ${text} — no worker of that name is building, so it is yours to act on`,
        NoteKind.UserToWorker,
      );
      continue;
    }
    worker.steering.push(`THE USER ASKS: ${text}`);
    const reached = await interruptWorker(worker);
    note(
      `USER SAYS to worker ${worker.id}: ${text} — handed to it ${reached ? "now, mid-round" : "for the top of its next round"}`,
      NoteKind.UserToWorker,
    );
  }
}
