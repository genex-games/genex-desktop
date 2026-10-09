/**
 * The studio harness — layer 2 of the pie (PLAN.md §3, §5).
 *
 * **This file is the agent's own code.** It lives in a git-snapshotted workspace, it can rewrite
 * every line of itself, and the only fixed points below it are the substrate RPC and the
 * bootstrap that imports this module. If an edit here is broken, the process fails to load and
 * the watchdog rewinds the workspace — which is exactly why editing it is safe to allow.
 *
 * Entry point contract expected by the bootstrap:
 *   createStudio(host) -> { dispatch(action), healthcheck(), status(), shutdown() }
 *
 * The work lives beside it: a user message in chat-dispatch.ts, a run in run-dispatch.ts, the
 * boot notice in boot-notice.ts. This file keeps the loop's state, its status lines and the
 * dispatch that routes each action.
 */
import { resolveContextWindow } from "./turn-loop.ts";
import { EngineId, supportsSessions } from "./model-roles.ts";
import { compactThread } from "./compact.ts";
import { compactSession } from "./session-compact.ts";
import { directorTool } from "./director.ts";
import { runSkillOpt } from "./skillopt.ts";
import { learningOn } from "./learning.ts";
import { loadSkills } from "./skills.ts";
import { runSelftest } from "./selftest.ts";
import { MessageQueue } from "./message-queue.ts";
import * as queueParts from "./message-queue.ts";
import { HostMethod } from "./host-methods.ts";
import { handleUserMessage, rewindMoodBoard } from "./chat-dispatch.ts";
import { handleRunStart, resumeRun } from "./run-dispatch.ts";
import { handleBootNotice } from "./boot-notice.ts";
import { buildHolds, chatWaitsFor, leadDoor, stopRun, stopRunsOf } from "./live-chat.ts";
import { serveLiveChat } from "./live-chat-served.ts";
import { LOCAL_ROLES_CAPABILITY, servesLocalRoles } from "./local-roles-served.ts";
import { heldRuns, StatusLane, type Studio } from "./studio-state.ts";
import type { AnyRecord, ForwardedCall, HarnessCtx, Host, HostCall } from "../types/harness.d.ts";
import type { DispatchAction } from "../types/host-api.d.ts";

export { judgeableFirst } from "./chat-dispatch.ts";
export { loopRunRefusal } from "./run-dispatch.ts";

/** The status a thread has when nothing is working on it; the host reads it as the empty line. */
const IDLE_STATUS = "idle";

/**
 * What this self can dispatch, reported in the bootstrap's ready message. A stale copy of this
 * file simply lacks the property — that absence is how the host knows not to hand an unattended
 * commission to a loop that predates the feature. Keep this list honest when editing dispatch
 * below.
 */
const CAPABILITIES = [
  "loop",
  "autopilot",
  "run.start",
  "run.stop",
  "skillopt",
  "compact",
  "selftest",
  "scoreboard",
  "coordinator",
  "director",
  "message-queue",
  "rewind",
  "steer",
];

/**
 * Two substrate calls need to know which chat they belong to, so the ctx supplies it rather
 * than trusting every call site to remember: `engine.complete` so a Stop can abort it
 * mid-generation, and `game.scaffold` so the chat that asked for a game becomes that game's
 * chat. The scaffold binding used to live only in the delegation path, so a local model
 * calling the `new_game` tool left its chat unbound forever — and an unbound chat is the one
 * the ＋ button hands back, which is how ＋ stopped opening anything new.
 */
const CARRIES_THREAD = new Set<string>([HostMethod.EngineComplete, HostMethod.GameScaffold]);

export async function createStudio(host: Host) {
  let shuttingDown = false;
  const status = createStatusBoard(host);
  const studio: Studio = {
    host,
    cancels: new Set(),
    stoppedMessages: new Set(),
    moodBoards: new Map(),
    activeRuns: new Map(),
    startingRuns: new Map(),
    orphanRuns: new Map(),
    scoped,
  };
  const compactions: Compactions = new Map();
  const messages = new MessageQueue(
    host,
    (action, steer) => handleUserMessage(studio, action, steer),
    // Follow-ups wait for the current build to close — or go to its run's lead, when the lead
    // takes the chat (live-chat.ts). Stop closes it early and hands its saved journal to the next
    // message, so new instructions cannot race cancelled builders; the self-improvement pass after
    // a run never holds the chat. A message sent during Compact now waits for it: the session it
    // would resume is the one the compaction is ending.
    async (threadId, next) => {
      await compactions.get(threadId);
      return chatWaitsFor(studio, threadId, next);
    },
    // Steer reaches the chat's own turn only: while a build of this chat or its game is open,
    // messages keep the build's path.
    (threadId, action) => !buildHolds(studio, threadId, action.project),
    (threadId, action) => leadDoor(studio, threadId, action),
  );
  // A waking run's start says its lead takes the chat only when this queue hands messages to it.
  serveLiveChat(queueParts);

  function scoped(threadId: string, lane: StatusLane = StatusLane.Run): HarnessCtx {
    return {
      host,
      call: ((method: string, payload?: AnyRecord) =>
        (host.call as ForwardedCall)(
          method,
          CARRIES_THREAD.has(method) ? { threadId, ...payload } : payload,
        )) as HostCall,
      notify: host.notify,
      workspace: host.workspace,
      threadId,
      get cancelled() {
        return shuttingDown || studio.cancels.has(threadId);
      },
      setStatus(next: string) {
        status.set(threadId, next, lane);
      },
    };
  }

  return {
    status: () => status.summarize(),
    // A build whose jobs cross to or from a local engine only when every part it needs serves it.
    capabilities: [...CAPABILITIES, ...(servesLocalRoles() ? [LOCAL_ROLES_CAPABILITY] : [])],

    async healthcheck() {
      // Prove the loaded self can talk to the substrate and read its own state.
      const head = await host.call(HostMethod.EventsHead, {});
      const skills = await loadSkills(host.workspace);
      return { ok: true, head, skills: skills.length };
    },

    dispatch: (action: DispatchAction) =>
      dispatch({ studio, messages, compactions, busyThreads: status.threads }, action),

    async shutdown() {
      shuttingDown = true;
      messages.stop();
      abortEngineWork(host);
    },
  };
}

/** What the dispatch works with: the loop's state, its message queue, and the threads now busy. */
interface Loop {
  studio: Studio;
  messages: MessageQueue;
  compactions: Compactions;
  busyThreads(): Iterable<string>;
}

/** Each chat's Compact now while it runs, settled (never rejected) when it is over. */
type Compactions = Map<string, Promise<void>>;

async function dispatch({ studio, messages, compactions, busyThreads }: Loop, action: DispatchAction) {
  const { host } = studio;
  switch (action.type) {
    case "user_message":
      return messages.enqueue(action);
    case "queue_message":
      return messages.change(action.threadId, action.messageId, action.operation, action.text);
    case "queue_resume":
      return messages.resume(action.threadId);
    case "rewind":
      return rewindMoodBoard(studio.moodBoards, action);
    case "run_start":
      return handleRunStart(studio, action);
    case "autopilot_resume":
      return resumeRun(studio, action.threadId, action.runId);
    case "director_tool":
      // The director's session called one of its run tools; the answer travels back on
      // the dispatch result. Never throws: a tool's failure is a sentence to the director.
      return directorTool(action);
    case "run_stop": {
      const active = studio.activeRuns.get(action.runId);
      if (active) {
        // The run's own Stop too: its learning pass keeps it whatever the chat does next.
        stopRun(active);
        studio.cancels.add(active.threadId);
        abortEngineWork(host, active.threadId);
        // The director and its workers are delegations of the project, not completions
        // of the thread.
        void host.call(HostMethod.EngineAbort, { project: active.run.project }).catch(() => {});
      } else {
        // Nobody here started this run — the loop that did died under it. Its contractors
        // are hosted in the app, not in this process, so some of them may still be editing
        // worktrees; the project the run started on is the address Stop reaches them at.
        // Skipped when a *live* run owns that project, so a stale card cannot stop this run.
        const project = studio.orphanRuns.get(action.runId);
        if (project && ![...studio.activeRuns.values()].some((a) => a.run.project === project)) {
          void host.call(HostMethod.EngineAbort, { project }).catch(() => {});
        }
      }
      host.notify("run.stopping", { runId: action.runId });
      return;
    }
    case "cancel":
      // Stop is per-thread: the chat that pressed it stops, the others keep working.
      // The cancel flag lands first, so when the aborted completion rejects, the loop
      // reads it as a stop, never as a failed turn.
      if (action.threadId) {
        await cancelThread(studio, messages, action.threadId);
      } else {
        for (const threadId of busyThreads()) studio.cancels.add(threadId);
        stopRunsOf(studio);
        abortEngineWork(host);
      }
      return;
    case "skillopt_start":
      return improveOnRequest(studio, action.threadId, action.options);
    case "compact":
      return holdingChat(compactions, action.threadId, compactOnRequest(studio, action));
    case "selftest":
      // The architect's bar (and anyone else's): the loop's pure logic against fixed inputs.
      return runSelftest();
    case "boot_notice":
      return handleBootNotice(studio, messages, action.notice);
    default:
      throw new Error(`unknown action: ${action.type}`);
  }
}

/**
 * A Stop in a chat with no build of its own under way is for the message being answered or just
 * sent: its turn keeps the Stop (chat-dispatch.ts `routeMessage`) instead of clearing it as a
 * fresh message would. A build's Stop is the build's: what waits behind it takes over after.
 */
function stopCurrentMessage(studio: Studio, messages: Pick<MessageQueue, "current">, threadId: string): void {
  if (heldRuns(studio).some((active) => active.threadId === threadId && !active.done)) return;
  // A kept message-queue.ts from before this has no `current`: its Stop is the old one.
  const current = messages.current?.(threadId);
  if (current) studio.stoppedMessages?.add(current);
}

/** Mark the current work stopped before waiting for its durable queue-pause acknowledgement. */
export async function cancelThread(
  studio: Studio,
  messages: Pick<MessageQueue, "pause" | "current">,
  threadId: string,
): Promise<void> {
  stopCurrentMessage(studio, messages, threadId);
  studio.cancels.add(threadId);
  stopRunsOf(studio, threadId);
  await messages.pause(threadId);
  await abortEngineWork(studio.host, threadId);
}

/** Stop must reach *into* a generation: abort the thread's in-flight completions (all, if no thread). */
function abortEngineWork(host: Host, threadId?: string): Promise<unknown> {
  return host.call(HostMethod.EngineAbort, threadId ? { threadId } : {}).catch(() => {});
}

/** A self-improvement pass the user asked for, unless Self-improvement is switched off. */
async function improveOnRequest(
  studio: Studio,
  threadId: string,
  options: Record<string, unknown> | undefined,
): Promise<void> {
  const { host } = studio;
  studio.cancels.delete(threadId);
  const ctx = studio.scoped(threadId);
  if (!(await learningOn(ctx))) {
    host.notify("skillopt.finished", { note: "self-improvement is off" });
    return;
  }
  ctx.setStatus("self-improving");
  try {
    const report = await runSkillOpt(ctx, { threadId, ...(options ?? {}) });
    host.notify("skillopt.finished", report);
  } finally {
    ctx.setStatus("idle");
  }
}

/** A chat's compaction, its queued messages held until it is over, whatever its outcome. */
async function holdingChat(compactions: Compactions, threadId: string, compaction: Promise<void>): Promise<void> {
  const over = compaction.then(
    () => {},
    () => {},
  );
  compactions.set(threadId, over);
  try {
    await compaction;
  } finally {
    if (compactions.get(threadId) === over) compactions.delete(threadId);
  }
}

/**
 * The user's Compact now. A chat on an engine with a compaction of its own has its session compact
 * itself in place (Claude Code, Codex); a chat with any other provider session, or one whose own
 * compaction did not run, has that session write its handover, and its next turn starts fresh
 * (session-compact.ts); otherwise, or when the session wrote none, the log is summarised
 * regardless of pressure, at low effort.
 */
async function compactOnRequest(studio: Studio, action: Extract<DispatchAction, { type: "compact" }>): Promise<void> {
  const { host } = studio;
  const { threadId } = action;
  // An earlier Stop in this chat must not cancel it; a stopping run keeps its flag.
  if (![...studio.activeRuns.values()].some((a) => a.threadId === threadId)) studio.cancels.delete(threadId);
  // The chat's own work: on the run lane its "idle" erased a running build's status.
  const ctx = studio.scoped(threadId, StatusLane.Chat);
  ctx.setStatus("compacting the conversation");
  try {
    const engine = action.engine ?? EngineId.Ollama;
    const described = await host.call(HostMethod.EngineDescribe, {});
    const descriptor = described.find((e: AnyRecord) => e.id === engine);
    // Only names session-compact.ts has always exported: an agent's kept copy still links.
    const bySession = supportsSessions(descriptor)
      ? await compactSession(ctx, {
          threadId,
          engine,
          model: action.model,
          native: descriptor?.compactsNatively === true,
        })
      : null;
    const report = bySession?.compacted
      ? bySession
      : await compactThread(ctx, {
          threadId,
          engine,
          model: action.model,
          contextWindow: resolveContextWindow(described, engine, action.model),
          force: true,
        });
    host.notify("compact.finished", { threadId, ...report });
  } finally {
    ctx.setStatus("idle");
  }
}

/**
 * The status lines. Status is per-thread: chats work in parallel and each shows only its own
 * line — a run in one game must never paint "self-improving" over every chat. A thread shows its
 * run's line when it has one, else its chat's.
 */
function createStatusBoard(host: Host) {
  /** threadId → { text, since }. */
  const statuses = new Map<string, { text: string; since: number }>();
  const chatStatuses = new Map<string, string>();
  const runStatuses = new Map<string, string>();

  function summarize(): string {
    if (statuses.size === 0) return IDLE_STATUS;
    if (statuses.size === 1) return [...statuses.values()][0].text;
    return `${statuses.size} threads busy`;
  }

  function show(threadId: string, shown: string): void {
    if (!shown || shown === IDLE_STATUS) {
      statuses.delete(threadId);
      return;
    }
    const current = statuses.get(threadId);
    // `since` marks when THIS phase began, so the UI timer reads "judging for 2m", not
    // "busy for 85m" — the first run looked wedged for exactly that reason.
    if (!current || current.text !== shown) statuses.set(threadId, { text: shown, since: Date.now() });
  }

  function set(threadId: string, next: string | null | undefined, lane: StatusLane = StatusLane.Run): void {
    const laneStatuses = lane === StatusLane.Chat ? chatStatuses : runStatuses;
    if (!next || next === IDLE_STATUS) laneStatuses.delete(threadId);
    else laneStatuses.set(threadId, next);
    if (lane === StatusLane.Chat) host.notify("coordinator.status", { threadId, status: next });
    const shown = runStatuses.get(threadId) ?? chatStatuses.get(threadId) ?? IDLE_STATUS;
    show(threadId, shown);
    host.heartbeat(summarize());
    host.notify("harness.status", {
      threadId,
      status: shown,
      all: Object.fromEntries([...statuses].map(([id, s]) => [id, { status: s.text, since: s.since }])),
    });
  }

  return { summarize, set, threads: () => statuses.keys() };
}
