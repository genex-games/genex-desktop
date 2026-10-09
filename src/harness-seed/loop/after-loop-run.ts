/**
 * The same agent after the build: once a run a lead led as its chat's own session
 * (one session, director/lead-session.ts) has closed — finished or paused — the chat's next message
 * goes to that same session, in the game folder, with its hands back, instead of to a separate
 * read-only coordinator. It answers, and does the work it is asked for itself; it keeps the run's
 * controls as tools: `run_status`, `show_build` and `land_build` answered live by the host
 * (`runControls`), and after a paused run `resume_run`, bridged in and recorded, which the studio
 * does once the reply ends — the resumed run's lead is this same session, so it may not run while
 * the session still answers. After a finished run with Loop on it may record `reopen_run` instead,
 * and the chat reopens that same run once the reply ends (reopen-run.ts).
 *
 * The coordinator (coordinator.ts) still answers after the long turn (`directorLoop: "turn"`), the
 * classic pipeline, a kept director.ts or part that seats no lead, a lead that was a session of its
 * own, and a message on another engine than the lead's — and whenever a kept chat runner, turn or
 * brief does not serve this (`servesAfterLoopRun`). After a finished run that seated a lead, a
 * message with Loop on lets that coordinator's continue_build reopen the same run once its reply
 * ends, when it answers in a session (reopen-run.ts `finishedLoopRun`).
 */
import { coordinatorTools } from "./run-inbox.ts";
import { readJournal } from "./run-journal.ts";
import { HostMethod } from "./host-methods.ts";
import { hasSessionRoles, plannerModel, RoleKey, roleEngine, supportsSessions } from "./model-roles.ts";
import { EventKind, RunState } from "./run-events.ts";
import { SECOND_MS, sleep } from "./time.ts";
import { heldRuns, type RunStart, type Studio } from "./studio-state.ts";
import { MESSAGE } from "./after-loop-run-prompts.ts";
import type { AnyRecord, HostCall } from "../types/harness.d.ts";
import type { StudioToolSpec } from "../types/host-api.d.ts";

/** The run control a chat's own session records rather than calls: its reply must end first. */
export const RESUME_RUN = "resume_run";

/**
 * How long the chat holds its next message for the run it asked to resume to be reserved
 * (run-dispatch.ts `handleRunStart`). It is reserved within moments of the host's resume, unless
 * the paused run's learning pass is still being waited out; past this the chat is free again.
 */
const RESUME_RESERVED_WITHIN_MS = 30 * SECOND_MS;
/** How often the chat looks for that reservation while it holds. */
const RESERVE_POLL_MS = SECOND_MS / 20;

/** The states a run is over in: the chat's own session answers after either. */
const CLOSED: readonly string[] = [RunState.Finished, RunState.Paused];

/** A run that is over, as the chat's own session is told it and handed its controls. */
export interface AfterLoopRun {
  runId: string;
  /** `finished` or `paused`. */
  state: string;
  goal: string | null;
  /** Whether its close put the build in the game folder; null when it did not say. */
  landed: boolean | null;
  /** Why it stopped, as its close said. */
  stoppedBecause: string | null;
  /**
   * The engine its lead ran on, where the chat's own session is: the turn runs on it, also for a
   * message that names no engine. A message on another engine is another session's (the coordinator's).
   */
  engine: string;
  /**
   * The model the turn runs on: the message's, else the one its lead ran on — so a Resume's lead
   * still continues the session (lead-session.ts `continuesChat` compares the bookmark's model).
   */
  model: string | null;
  /** The chat's message the session answers: the run's controls act for it (a resume records it). */
  messageId?: string;
  /** chat-dispatch.ts may reopen this finished run (reopen-run.ts) once its parts serve it. */
  reopenable?: boolean;
}

/** What the harness calls the host with here. */
type Caller = { call: HostCall };

/**
 * Does every part the chat's own session after a run depends on serve it (`SERVES_AFTER_LOOP_RUN`):
 * its runner passes it the run, its turn hands it the run's controls, its brief tells it the build
 * is over? A seed upgrade keeps a part the agent edited before, which never exported the mark — and
 * could give the session no run controls and tell it to pick up where it left off. Then the
 * coordinator answers, as before.
 */
export function servesAfterLoopRun(parts: readonly Readonly<Record<string, unknown>>[]): boolean {
  return parts.every((part) => part.SERVES_AFTER_LOOP_RUN === true);
}

/** Does the engine this message goes to hold a session: one known by name, or described so? */
async function holdsSession(host: Caller, engine: string): Promise<boolean> {
  if (hasSessionRoles(engine)) return true;
  const described = await host.call(HostMethod.EngineDescribe, {}).catch(() => []);
  return supportsSessions(described.find((e) => e.id === engine));
}

/**
 * The run the chat's own session answers after, or null for the coordinator: a closed run whose
 * lead was the chat's own session (`journal.director.lead.chatSession`), for a message on the lead's
 * engine (or none), which holds a session. A run under way, a run no lead led, one whose lead was a
 * session of its own and a message on another engine — another session — are the coordinator's.
 */
export async function afterLeadLoopRun(
  host: Caller,
  action: { threadId: string; engine?: string | null; model?: string | null },
  run: AnyRecord,
): Promise<AfterLoopRun | null> {
  if (!CLOSED.includes(run.state) || !run.runId) return null;
  const engine = roleEngine(run, RoleKey.Planner);
  if (action.engine && action.engine !== engine) return null;
  if (!(await holdsSession(host, engine))) return null;
  const journal = await readJournal(host, action.threadId, run.runId);
  if (journal?.director?.lead?.chatSession !== true) return null;
  return {
    runId: run.runId,
    state: run.state,
    goal: typeof run.goal === "string" ? run.goal : null,
    landed: typeof run.landed === "boolean" ? run.landed : null,
    stoppedBecause: typeof run.stoppedBecause === "string" ? run.stoppedBecause : null,
    engine,
    model: action.model ?? plannerModel(run) ?? null,
  };
}

/**
 * The resume a chat's own session may record after a paused run: the run's own `resume_run`,
 * without its `runId` — the chat resumes the run it answers after, never another it could name.
 */
function resumeTool(): StudioToolSpec[] {
  return (coordinatorTools as StudioToolSpec[])
    .filter((tool) => tool.name === RESUME_RUN)
    .map((tool) => {
      const { runId: _anotherRun, ...properties } = tool.parameters.properties;
      return { ...tool, parameters: { ...tool.parameters, properties } };
    });
}

/**
 * What the chat's own session is handed on its turn after a run: the run's controls the host
 * answers for this run and message, and after a paused run the resume, bridged in and recorded.
 */
export function afterLoopRunGrant(loopRun: AfterLoopRun): {
  runControls: { runId: string; messageId?: string };
  interviewTools?: StudioToolSpec[];
} {
  const { runId, messageId } = loopRun;
  return {
    runControls: { runId, ...(messageId ? { messageId } : {}) },
    ...(loopRun.state === RunState.Paused ? { interviewTools: resumeTool() } : {}),
  };
}

/**
 * The resume the session recorded, when its run is paused: its instruction (`text`) and nothing
 * else — a run it names is not the one it was granted — else null.
 */
export function resumeAsked(
  loopRun: AfterLoopRun,
  recorded: ReadonlyArray<{ name: string; args?: AnyRecord }>,
): AnyRecord | null {
  if (loopRun.state !== RunState.Paused) return null;
  const call = recorded.find((c) => c.name === RESUME_RUN);
  if (!call) return null;
  const text = call.args?.text;
  return typeof text === "string" ? { text } : {};
}

/**
 * A resume the chat asked for, until run-dispatch.ts reserves its run: `taken` once
 * `handleRunStart` has seen it, `stopped` when the chat saw Stop first. Forgotten once `until` passes.
 */
interface AskedResume {
  runId: string;
  until: number;
  taken: boolean;
  stopped: boolean;
}

/** The resumes each loop's chats asked for, by thread, until their runs are reserved. */
const askedResumes = new WeakMap<object, Map<string, AskedResume>>();

function askedOf(studio: object): Map<string, AskedResume> {
  const asked = askedResumes.get(studio) ?? new Map<string, AskedResume>();
  askedResumes.set(studio, asked);
  return asked;
}

/**
 * Resume the paused run the session asked for, now that its reply has ended: the host's own
 * `resume_run` records the instruction on the run and resumes its journal, and the run's lead
 * continues this same session (lead-session.ts). The chat is held until the run is reserved, so
 * its next message waits for that run — or goes to its lead — instead of being answered as after
 * a paused run again; bounded by `within`. A refusal is said in the chat, durably.
 */
export async function resumeAfterReply(
  studio: Studio,
  ctx: { threadId: string; readonly cancelled: boolean },
  loopRun: AfterLoopRun,
  args: AnyRecord,
  within: number = RESUME_RESERVED_WITHIN_MS,
): Promise<void> {
  const { threadId } = ctx;
  const { runId, messageId } = loopRun;
  const asked: AskedResume = { runId, until: Date.now() + within, taken: false, stopped: false };
  askedOf(studio).set(threadId, asked);
  try {
    await studio.host.call(HostMethod.CoordinatorTool, {
      threadId,
      runId,
      ...(messageId ? { messageId } : {}),
      name: RESUME_RUN,
      args,
    });
  } catch (err: any) {
    forget(studio, threadId, asked);
    await say(studio.host, threadId, MESSAGE.notResumed(err?.message ?? String(err)));
    return;
  }
  await untilReserved(studio, ctx, asked);
}

/**
 * Hold until run-dispatch.ts reserves the run (or, from an older copy that never looks here, until
 * it is among the loop's runs), the bound passes, or Stop comes: then the reservation, when it
 * comes, does not start the run (`resumeStopped`).
 */
async function untilReserved(
  studio: Studio,
  ctx: { threadId: string; readonly cancelled: boolean },
  asked: AskedResume,
): Promise<void> {
  const reserved = (): boolean =>
    asked.taken || heldRuns(studio).some((active) => active.run?.runId === asked.runId && !active.done);
  while (!reserved()) {
    if (ctx.cancelled) {
      asked.stopped = true;
      return;
    }
    if (Date.now() >= asked.until) break;
    await sleep(RESERVE_POLL_MS);
  }
  forget(studio, ctx.threadId, asked);
}

/** The chat no longer holds for this resume. */
function forget(studio: object, threadId: string, asked: AskedResume): void {
  const resumes = askedOf(studio);
  if (resumes.get(threadId) === asked) resumes.delete(threadId);
}

/**
 * A run the chat's own session asked to resume, reached by Stop before it was reserved: it stays
 * paused, and the chat is told. Asked by `handleRunStart` just before it reserves a run — which clears
 * the thread's Stop, so a Stop pressed in that window would be lost. The chat cleared its Stop when
 * the message began, so a Stop now is one pressed since. False for every other start.
 */
export function resumeStopped(studio: Studio, start: RunStart): boolean {
  const resumes = askedOf(studio);
  const asked = resumes.get(start.threadId);
  if (!asked || asked.runId !== start.run.runId) return false;
  resumes.delete(start.threadId);
  asked.taken = true;
  const live = Date.now() < asked.until && start.resume === true;
  if (!live || !(asked.stopped || studio.cancels.has(start.threadId))) return false;
  void say(studio.host, start.threadId, MESSAGE.notResumed(MESSAGE.stoppedFirst));
  return true;
}

/** A word to the chat, durably; a log that will not take it loses only the word. */
async function say(host: Caller, threadId: string, message: string): Promise<void> {
  await host.call(HostMethod.EventsAppend, { threadId, batch: [{ type: EventKind.Error, message }] }).catch(() => {});
}
