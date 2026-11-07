/**
 * The same agent after the build: once a Loop run whose journal seated a lead has closed — finished
 * or paused — the chat's own session answers the chat's next message, in the game folder, with its
 * hands. It answers, and does the work it is asked for itself; it keeps the run's status as a tool,
 * `run_status`, answered live by the host (`runControls`). On the build's own engine, after a paused
 * Loop that worked in the game folder it may record `resume_run`, bridged in, which the studio does
 * once the reply ends — the resumed run's lead may be this same session, so it may not run while the
 * session still answers. A turn on another engine moves the chat's bookmark there, so a
 * lead the build seats later starts afresh.
 */
import { readJournal, writeJournal } from "./run-journal.ts";
import { HostMethod } from "./host-methods.ts";
import { hasSessionRoles, plannerModel, RoleKey, roleEngine, supportsSessions } from "./model-roles.ts";
import { EventKind, RunState } from "./run-events.ts";
import { SECOND_MS, sleep } from "./time.ts";
import { heldRuns, type RunStart, type Studio } from "./studio-state.ts";
import { MESSAGE } from "./after-loop-run-prompts.ts";
import { askedMinutes, WORK_TIME_PARAMS, workBudget } from "./work-time.ts";
import { workedBefore } from "./director/work-time.ts";
import type { AnyRecord, HostCall } from "../types/harness.d.ts";
import type { StudioToolSpec } from "../types/host-api.d.ts";

/** The run control a chat's own session records rather than calls: its reply must end first. */
export const RESUME_RUN = "resume_run";

/**
 * The resume a chat's own session may record after a paused run: no run to name — the chat resumes
 * the run it answers after, never another.
 */
const RESUME_RUN_TOOL: StudioToolSpec = {
  name: RESUME_RUN,
  description:
    "Go on with this chat's paused build and its completed work; you lead it again once your reply ends. Any work on this game beyond a quick fix goes on in it (more of the game, a change, the person's answer to your question, new guidance after Stop) instead of in your reply or a new build. Supply what to do as text, say in a line that you go on, and end your reply.",
  parameters: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description:
          "The person's latest words, quoted as they wrote them, then what to do now in a sentence or two. Add no work they didn't ask for, and where a word could mean more than one thing, read it by what they made the priority earlier in this chat.",
      },
      ...WORK_TIME_PARAMS,
    },
  },
};

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

/** A run that is over, as the chat's own session is handed its controls. */
export interface AfterLoopRun {
  runId: string;
  /** `finished` or `paused`. */
  state: string;
  /** The engine the turn runs on: the message's, else the one its lead ran on. */
  engine: string;
  /** The turn runs on the engine its lead ran on: only there may it resume the build. */
  onLeadEngine: boolean;
  /**
   * The model the turn runs on: the message's, else on the lead's engine the one its lead ran on.
   */
  model: string | null;
  /** The chat's message the session answers: the run's controls act for it (a resume records it). */
  messageId?: string;
  /**
   * The run was a Loop that worked in the game folder itself (`journal.director.open`): only such a
   * paused run goes on. A web game's Loop an earlier Genex paused is refused on Resume, so the chat
   * answers after it as after a finished run.
   */
  inPlace?: boolean;
}

/** What the harness calls the host with here. */
type Caller = { call: HostCall };

/** Does the engine this message goes to hold a session: one known by name, or described so? */
export async function holdsSession(host: Caller, engine: string): Promise<boolean> {
  if (hasSessionRoles(engine)) return true;
  const described = await host.call(HostMethod.EngineDescribe, {}).catch(() => []);
  return supportsSessions(described.find((e) => e.id === engine));
}

/**
 * The run the chat's own session answers after with the run's controls, or null for a plain turn: a
 * closed run whose journal seated a lead (`journal.director.lead`), for a message on an engine that
 * holds a session. A run under way, the classic pipeline, the long turn and a run with no journal
 * get a plain turn, and so does an engine without sessions (Ollama).
 */
export async function afterLeadLoopRun(
  host: Caller,
  action: { threadId: string; engine?: string | null; model?: string | null },
  run: AnyRecord,
): Promise<AfterLoopRun | null> {
  if (!CLOSED.includes(run.state) || !run.runId) return null;
  const leadEngine = roleEngine(run, RoleKey.Planner);
  const engine = action.engine ?? leadEngine;
  if (!(await holdsSession(host, engine))) return null;
  const journal = await readJournal(host, action.threadId, run.runId);
  if (typeof journal?.director?.lead?.chatSession !== "boolean") return null;
  const onLeadEngine = engine === leadEngine;
  const leadModel = onLeadEngine ? (plannerModel(run) ?? null) : null;
  return {
    runId: run.runId,
    state: run.state,
    engine,
    onLeadEngine,
    model: action.model ?? leadModel,
    ...(journal.director.open ? { inPlace: true } : {}),
  };
}

/** May this turn resume its run: a paused Loop that worked in place, on its lead's engine? */
function resumes(loopRun: AfterLoopRun): boolean {
  return loopRun.state === RunState.Paused && loopRun.onLeadEngine && loopRun.inPlace === true;
}

/**
 * What the chat's own session is handed on its turn after a run: the run's controls the host
 * answers for this run and message, and the resume, bridged in and recorded, when it may resume.
 */
export function afterLoopRunGrant(loopRun: AfterLoopRun): {
  runControls: { runId: string; messageId?: string };
  interviewTools?: StudioToolSpec[];
} {
  const { runId, messageId } = loopRun;
  return {
    runControls: { runId, ...(messageId ? { messageId } : {}) },
    ...(resumes(loopRun) ? { interviewTools: [RESUME_RUN_TOOL] } : {}),
  };
}

/**
 * The resume the session recorded, when it may resume: its instruction (`text`) and the time the
 * person named for it (`hours`, `minutes`), and nothing else — a run it names is not the one it was
 * granted — else null.
 */
export function resumeAsked(
  loopRun: AfterLoopRun,
  recorded: ReadonlyArray<{ name: string; args?: AnyRecord }>,
): AnyRecord | null {
  if (!resumes(loopRun)) return null;
  const call = recorded.find((c) => c.name === RESUME_RUN);
  if (!call) return null;
  const text = call.args?.text;
  return { ...(typeof text === "string" ? { text } : {}), ...timeOf(call.args) };
}

/** The `hours` and `minutes` a recorded resume named, when they name a time; nothing else of its arguments. */
function timeOf(args: AnyRecord | undefined): AnyRecord {
  if (!args || !askedMinutes(args)) return {};
  const time: AnyRecord = {};
  for (const key of Object.keys(WORK_TIME_PARAMS)) if (args[key] !== undefined) time[key] = args[key];
  return time;
}

/**
 * The time the person named for the resumed build, on its journal's run before the host resumes it:
 * the resumed run reads its budgets there (run-dispatch.ts `resumeRun`), counted from the time it has
 * worked so far (work-time.ts). Nothing when they named none, or when the run is under way here.
 */
async function askWorkTime(studio: Studio, threadId: string, runId: string, args: AnyRecord): Promise<void> {
  const minutes = askedMinutes(args);
  const running = heldRuns(studio).some((active) => active.run?.runId === runId && !active.done);
  if (!minutes || running) return;
  const journal = await readJournal(studio.host, threadId, runId);
  if (!journal?.run) return;
  journal.run.budgets = { ...journal.run.budgets, ...workBudget(minutes, workedBefore(journal)) };
  await writeJournal(studio.host, threadId, runId, journal).catch(() => {});
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
 * Resume the paused run the session asked for, now that its reply has ended: the time the person
 * named for it goes on its journal first (`askWorkTime`), then the host's own
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
  await askWorkTime(studio, threadId, runId, args);
  try {
    await studio.host.call(HostMethod.RunControl, {
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
 * Hold until run-dispatch.ts reserves the run — or holds it already, resumed meanwhile from Builds
 * — the bound passes, or Stop comes: then the reservation, when it comes, does not start the run
 * (`resumeStopped`).
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
