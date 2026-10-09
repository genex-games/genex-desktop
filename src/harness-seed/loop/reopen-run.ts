/**
 * A finished build reopened. After a build its lead led as the chat's own session has
 * finished (after-loop-run.ts), a message with Loop on that asks for more work reopens the SAME run — its
 * runId, plan, workers and Builds graph — with the working time the Loop gives it, led again by that
 * same session (director/lead-session.ts). The session decides from the message and records
 * `reopen_run`; once its reply has ended the chat rewrites the run's journal (director/reopen.ts
 * `reopenedJournal`), records the ask on the run, and starts it again as a resume that hears the chat
 * from the ask on (`RunStart.reopen`). Only an explicit start over launches a new build. A question is
 * answered. A paused build is not this: it resumes with the time it had left (`resume_run`).
 *
 * A finished build the run's coordinator answers for (its lead was a session of its own, the
 * message went to another engine, or a kept older part hands the chat to it) reopens the same way when a Loop came with the message: the
 * coordinator is told, and its continue_build reopens the build instead of handing the work to one
 * builder turn (`finishedLoopRun`), with the models the build was made with. A finished build no Loop
 * can go on from — no lead seated, a coordinator on a model without sessions, a kept older part — is
 * answered as with Loop off, and the chat says so once (`firstLoopUnused`). A game built in Unreal is
 * neither: its finished Unreal Loop is never reopened, and the person's Loop message after it may
 * start the next one (chat-dispatch.ts `startsNextUnrealLoop`).
 *
 * chat-dispatch.ts offers it only when every part it depends on says so (`servesReopen`): a seed
 * upgrade keeps a part the agent edited before, which would plan on the commission's model, bridge
 * the launch, word the old rules or read the reopened run's inbox from its start — then the message
 * is answered as with Loop off. This module imports only names every older seed exported
 * (tests/fixtures/seed-exports-pre-reopen.json).
 */
import { CompletionPolicy } from "./completion-policy.ts";
import { clampRunHours, MAX_RUN_HOURS } from "./config.ts";
import { reopenedJournal } from "./director/reopen.ts";
import { runAsks } from "./goal-prompts.ts";
import { HostMethod } from "./host-methods.ts";
import { runUnderWay } from "./live-chat.ts";
import { RoleKey, roleEngine, withRoles } from "./model-roles.ts";
import { MESSAGE, REOPEN_RUN, reopenPromise } from "./reopen-run-prompts.ts";
import { EventKind, RunEvent, RunState } from "./run-events.ts";
import { latestRun } from "./run-inbox.ts";
import { readJournal, writeJournal } from "./run-journal.ts";
import { addToScope, runScope, userWordsInLog } from "./scope.ts";
import { isCommit } from "./shell.ts";
import { HOUR_MS } from "./time.ts";
import type { AfterLoopRun } from "./after-loop-run.ts";
import type { RunReopen, Studio } from "./studio-state.ts";
import type { AnyRecord, HarnessCtx, HarnessEvent, Host } from "../types/harness.d.ts";
import type { EventData, ModelPreferences, RunRoles, RunSpec } from "../types/host-api.d.ts";

type RunBudgets = RunSpec["budgets"];

/** The model an engine picks for itself: a lead that names no model runs on it. */
const ENGINE_DEFAULT = "default";
/** The asks a reopened build keeps ahead of its commission (goal-prompts.ts `workingGoal`), the latest first. */
const MAX_REOPEN_ASKS = 4;

/** Does every part a reopen depends on serve it (`SERVES_REOPEN`)? */
export function servesReopen(parts: readonly Readonly<Record<string, unknown>>[]): boolean {
  return parts.every((part) => part.SERVES_REOPEN === true);
}

/** A finished run the chat may reopen (`reopenable`, set by chat-dispatch.ts once its parts serve it). */
function mayReopen(loopRun: AfterLoopRun | null | undefined): boolean {
  return loopRun?.reopenable === true && loopRun.state === RunState.Finished;
}

/**
 * Does a routed message keep its commission: one for no run, or one for a finished run the chat's
 * own session or the run's coordinator may reopen (`reopenable`) — never a run under way or a paused
 * run, where it could commission a second run.
 */
export function keepsCommission(existing: unknown, loopRun: AfterLoopRun | null): boolean {
  if (!existing) return true;
  return mayReopen(loopRun);
}

/**
 * A finished build the run's coordinator answers for, as a run its continue_build may reopen: one
 * whose journal seated a lead (the chat's own session, or one of its own), which goes on as the same
 * run. The long turn and a kept older run seat none, and the classic pipeline and a gauntlet keep no
 * director journal: none of them can. Its model is none — the build goes on with the models it was
 * made with.
 */
export async function finishedLoopRun(
  host: Pick<HarnessCtx, "call">,
  threadId: string,
  run: AnyRecord,
  messageId?: string,
): Promise<AfterLoopRun | null> {
  if (run?.state !== RunState.Finished || !run.runId) return null;
  const journal = await readJournal(host, threadId, run.runId);
  if (typeof journal?.director?.lead?.chatSession !== "boolean") return null;
  return {
    runId: run.runId,
    state: RunState.Finished,
    goal: typeof run.goal === "string" ? run.goal : null,
    landed: typeof run.landed === "boolean" ? run.landed : null,
    stoppedBecause: typeof run.stoppedBecause === "string" ? run.stoppedBecause : null,
    engine: roleEngine(run, RoleKey.Planner),
    model: null,
    ...(messageId ? { messageId } : {}),
    reopenable: true,
  };
}

/** The finished builds each loop's chats were told no Loop can go on from, by run. */
const loopUnusedSaid = new WeakMap<object, Set<string>>();

/**
 * Is this the first time a Loop came to this finished build that none can go on from? The chat says
 * so once, not on every message it answers as with Loop off; a restarted loop says it once again.
 */
export function firstLoopUnused(studio: object, runId: string): boolean {
  const said = loopUnusedSaid.get(studio) ?? new Set<string>();
  loopUnusedSaid.set(studio, said);
  if (said.has(runId)) return false;
  said.add(runId);
  return true;
}

/** Does this turn offer the reopen: the chat may, and a Loop came with the message (or the question it answers). */
export function reopens(loopRun: AfterLoopRun | null | undefined, commission: AnyRecord | null | undefined): boolean {
  return Boolean(commission) && mayReopen(loopRun);
}

/** The Loop's hours for a build; null for ∞. */
export function commissionHours(commission: AnyRecord | null | undefined): number | null {
  const hours = commission?.hours;
  return typeof hours === "number" && hours > 0 ? hours : null;
}

/**
 * What the reopening message picked for the build's workers and judges, taken as a launch from it
 * takes them: the Loop's roles (start_autopilot takes only an object) — the models, a crossed
 * engine, per-role efforts — and the message's effort and preferences (chat-dispatch.ts `intakeRun`).
 */
export interface ReopenPicks {
  roles?: RunRoles;
  effort?: string;
  preferences?: ModelPreferences;
}

/** What a reopened build's workers and judges run on: the message's model and picks, resolved as a launch resolves them. */
export interface ReopenModels extends ReopenPicks {
  /** The model the session answers on: the lead's, and the one the workers' and judges' resolve from. */
  model: string | null;
}

/** What the session asked: its words for the build, the Loop's hours (null: ∞) and the Loop's roles. */
export interface ReopenAsk {
  hours: number | null;
  text?: string;
  roles?: RunRoles;
}

/**
 * The reopen recorded, when this turn may reopen: only its words — a run it names is not the one
 * granted — with the Loop it reopens with: the message's, or the question's it answers.
 */
export function reopenAsked(
  loopRun: AfterLoopRun | null | undefined,
  commission: AnyRecord | null | undefined,
  recorded: ReadonlyArray<{ name: string; args?: AnyRecord }>,
): ReopenAsk | null {
  if (!reopens(loopRun, commission)) return null;
  const call = recorded.find((c) => c.name === REOPEN_RUN);
  if (!call) return null;
  const text = typeof call.args?.text === "string" ? call.args.text.trim() : "";
  const roles = commission?.roles;
  return {
    hours: commissionHours(commission),
    ...(text ? { text } : {}),
    ...(roles && typeof roles === "object" ? { roles } : {}),
  };
}

/**
 * The working time a Loop gives a build, exactly as a launch gives it (tools/game-tools.ts
 * `start_autopilot`, then chat-dispatch.ts `intakeBudgets`): its hours held to the run limits, or for
 * ∞ the day's ceiling, recorded as until satisfied — a goal to verify rather than a time to spend.
 */
export function loopBudgets(hours: number | null): RunBudgets {
  const capped = typeof hours === "number" && hours > 0;
  const held = capped ? clampRunHours(hours) : MAX_RUN_HOURS;
  return {
    wallClockMs: Math.round(held * HOUR_MS),
    completionPolicy: capped ? CompletionPolicy.Duration : CompletionPolicy.Goal,
    ...(capped ? {} : { untilSatisfied: true }),
  };
}

/**
 * The run's budgets with the Loop's new time: its other knobs kept, its time, its ∞ and its policy
 * replaced. A reopened build has an ask to finish, not hours to spend, so it is always a goal
 * commission: the Loop's hours are its ceiling, and the lead finishes once the ask is checked
 * (golden-boot-glory: a seventy-second fix was refused `finish` for 159 working minutes).
 */
export function reopenBudgets(saved: Partial<RunBudgets> | undefined, hours: number | null): RunBudgets {
  const { wallClockMs: _spent, untilSatisfied: _before, completionPolicy: _old, ...knobs } = saved ?? {};
  return { ...knobs, ...loopBudgets(hours), completionPolicy: CompletionPolicy.Goal };
}

/**
 * The run a reopen registers: the new budgets; its workers, judges, their engines, effort and
 * preferences resolved from the message's picks exactly as a launch from it resolves them
 * (model-roles.ts `withRoles`, the finished run's stamps dropped first); planned on the model this
 * session answers on (so `leadSeat` seats it again), else the planner it had — never the builders'
 * model, which `plannerModel` would read in its place; its engine, goal, reference and plan kept;
 * the launch's readiness dropped (the folder is asked again). With no models (`null`: the run's
 * coordinator reopens it) every model stays the one the build was made with.
 */
export function reopenedRun(
  saved: RunSpec & AnyRecord,
  budgets: RunBudgets,
  picks: ReopenModels | null,
): RunSpec & AnyRecord {
  if (!picks) {
    const { readiness: _launched, ...kept } = saved;
    return { ...kept, budgets };
  }
  const {
    readiness: _launched,
    model: _builders,
    roles: finished,
    rolesApplied: _resolved,
    builderEngine: _crossed,
    judgeEngine: _judges,
    judgeModel: _judge,
    effort: _effort,
    preferences: _preferences,
    ...spec
  } = saved;
  const resolved = withRoles({
    ...spec,
    ...(picks.model ? { model: picks.model } : {}),
    ...(picks.roles ? { roles: picks.roles } : {}),
    ...(picks.effort ? { effort: picks.effort } : {}),
    ...(picks.preferences ? { preferences: picks.preferences } : {}),
  });
  const planner = picks.model ?? finished?.planner ?? ENGINE_DEFAULT;
  return { ...resolved, budgets, roles: { ...resolved.roles, planner } };
}

/**
 * The asks a reopened build is judged by, the latest first, ahead of its commission (goal-prompts.ts
 * `workingGoal`); a replayed message's ask is not kept twice.
 */
export function withAsk(saved: AnyRecord, text: string): string[] {
  const earlier = runAsks(saved).filter((ask) => ask !== text);
  return (text ? [text, ...earlier] : earlier).slice(0, MAX_REOPEN_ASKS);
}

/**
 * The build's scope with the reopening message among the user's words (scope.ts `addToScope`): only
 * the message's own words as the log has them (edits applied, never the chat's own report), once.
 * Nothing for a build from before scope.
 */
function reopenedScope(saved: AnyRecord, words: string, events: readonly HarnessEvent[]): AnyRecord {
  const scope = runScope(saved);
  if (!scope) return {};
  return { scope: addToScope(scope, [], words.trim(), userWordsInLog(events)) ?? scope };
}

/** How the chat starts a reopened run (chat-dispatch.ts: `handleRunStart`, resumed, keeping a Stop). */
export type StartReopened = (run: RunSpec & AnyRecord, reopen: RunReopen) => Promise<void>;

/** The chat that reopens: its thread, and whether Stop was pressed since its message began. */
interface ReopeningChat {
  threadId: string;
  readonly cancelled: boolean;
}

/**
 * Reopen the finished run once the reply has ended: its journal read, the finished run's learning
 * pass waited out, a Stop since honoured, the run still the chat's latest and finished in the log,
 * its journal reopened, the ask recorded, the chat told, then started. A refusal is said, durably.
 */
export async function reopenAfterReply(
  studio: Studio,
  ctx: ReopeningChat,
  loopRun: AfterLoopRun,
  ask: ReopenAsk & { words: string; models: ReopenModels | null },
  start: StartReopened,
  now: () => number = Date.now,
): Promise<void> {
  const { host } = studio;
  const { threadId } = ctx;
  try {
    const journal = await readJournal(host, threadId, loopRun.runId);
    if (!journal?.run || !journal.director) throw new Error(MESSAGE.noJournal);
    const busy = await runUnderWay(studio, threadId, String(journal.run.project));
    if (busy) throw new Error(MESSAGE.alreadyBuilding(String(busy.run.project)));
    // Stop while that pass was waited out was for this build too.
    if (ctx.cancelled) throw new Error(MESSAGE.stoppedFirst);
    const events = await host.call(HostMethod.EventsList, { threadId });
    const { close, closeAt } = finishedClose(events, loopRun.runId);
    const text = (ask.text ?? ask.words).trim();
    const reopened = reopenedRun(journal.run, reopenBudgets(journal.run.budgets, ask.hours), ask.models);
    const run = { ...reopened, asks: withAsk(journal.run, text), ...reopenedScope(journal.run, ask.words, events) };
    const finishedHead = isCommit(close.integrationHead) ? close.integrationHead : null;
    const at = new Date(now()).toISOString();
    await writeJournal(host, threadId, loopRun.runId, reopenedJournal(journal, run, { at, finishedHead }));
    // The reopened run hears from its ask on — the one recorded now, or the one a turn replayed after
    // a restart finds recorded since the close — and nothing before it, an ask a Stop left behind included.
    const after = await askTheBuild(host, threadId, { events, closeAt }, loopRun, { text, at });
    studio.moodBoards.delete(threadId);
    await tell(host, threadId, {
      type: EventKind.Messages,
      messages: [{ role: "assistant", content: reopenPromise(run.budgets, now()) }],
    });
    void start(run, { after }).catch((err: unknown) =>
      host.notify("run.failed", { runId: loopRun.runId, error: String(err) }),
    );
  } catch (err: unknown) {
    await tell(host, threadId, { type: EventKind.Error, message: MESSAGE.notReopened(errorWords(err)) });
  }
}

/**
 * The finished run's close, from the log, and where it stands there: the run must still be the
 * chat's latest and finished. The journal is not asked — a reopen rewound away leaves it paused on
 * withdrawn work, while the log shows the build as it finished.
 */
function finishedClose(events: readonly HarnessEvent[], runId: string): { close: AnyRecord; closeAt: number } {
  const latest = latestRun(events);
  if (latest?.runId !== runId || latest.state !== RunState.Finished) throw new Error(MESSAGE.notTheLatest);
  const closeAt = events.findLastIndex(
    (event) => event.data?.event_type === RunEvent.RunFinished && event.data.payload?.runId === runId,
  );
  return { close: events[closeAt]?.data.payload ?? {}, closeAt };
}

/** The log the reopen read, and where the close it reopens stands in it. */
interface ReadLog {
  events: readonly HarnessEvent[];
  closeAt: number;
}

/** The ask as the reopened run's lead hears it first: its words, and when it was made. */
interface Ask {
  text: string;
  at: string;
}

/**
 * Is this the chat's own record of the same ask on the run — its message and words (a replayed turn)?
 * One a run's lead took from the message (`how`, live chat) is not: the lead heard it, or it came
 * back to the chat, which records its words anew (as the host's `resume_run` does).
 */
function sameAsk(event: HarnessEvent, runId: string, messageId: string, text: string): boolean {
  const payload = event.data?.event_type === RunEvent.RunSteering ? event.data.payload : null;
  if (!payload || payload.how !== undefined) return false;
  return payload.runId === runId && payload.sourceMessageId === messageId && payload.text === text;
}

/**
 * The user's ask on the run, as a Resume's instruction is (the host's `resume_run`): the reopened
 * run's inbox reads it first. Once per message and words since the close: a turn replayed after a
 * restart finds the ask its first answer recorded, and does not record it twice. Answers where that
 * inbox reads from: the record just before the ask, found or recorded now — never the finished run's.
 */
async function askTheBuild(
  host: Host,
  threadId: string,
  { events, closeAt }: ReadLog,
  loopRun: AfterLoopRun,
  { text, at }: Ask,
): Promise<string | null> {
  const { runId, messageId } = loopRun;
  const last = events.at(-1)?.id ?? null;
  if (!text) return last;
  const recorded = messageId
    ? events.findIndex((event, i) => i > closeAt && sameAsk(event, runId, messageId, text))
    : -1;
  if (recorded >= 0) return events[recorded - 1]?.id ?? null;
  const payload = { runId, text, ...(messageId ? { sourceMessageId: messageId } : {}), at };
  await host.call(HostMethod.EventsAppend, {
    threadId,
    batch: [{ type: EventKind.Custom, event_type: RunEvent.RunSteering, payload }],
  });
  return last;
}

/** One record to the chat, durably; a log that will not take it loses only the word. */
async function tell(host: Host, threadId: string, record: EventData): Promise<void> {
  await host.call(HostMethod.EventsAppend, { threadId, batch: [record] }).catch(() => {});
}

/** What went wrong, in words. */
function errorWords(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
