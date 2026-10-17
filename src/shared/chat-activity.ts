import { CustomEvent, customPayload, customRecord, type CustomEventData } from "./custom-events.ts";
import { EventKind } from "./event-log.ts";
/** Reporting only. Explicit activity events win; normal model EOS "stop" is not cancellation. */
export const ChatActivityPhase = {
  Idle: "idle",
  Working: "working",
  Connecting: "connecting",
  Thinking: "thinking",
  Responding: "responding",
  Tool: "tool",
  Waiting: "waiting",
  Compacting: "compacting",
  LoadingModel: "loading-model",
  Queued: "queued",
  Stopping: "stopping",
  Completed: "completed",
  Failed: "failed",
  Interrupted: "interrupted",
} as const;
export type ChatActivityPhase = (typeof ChatActivityPhase)[keyof typeof ChatActivityPhase];

/** Whose session a `session_activity` record reports (`delegationActivityScope`). Persisted: never rename a value. */
export const SessionActivityRole = {
  /** The conversation's own session: the director or the coordinator. */
  Planner: "planner",
  /** A playtester or another read-only checker. */
  Reviewer: "reviewer",
  /** A builder working on the game. */
  Builder: "builder",
} as const;
export type SessionActivityRole = (typeof SessionActivityRole)[keyof typeof SessionActivityRole];

export interface ChatActivity {
  phase: ChatActivityPhase;
  label: string;
  sessionId?: string;
  engine?: string;
  /** The delegation whose report this is, when a delegated session made it. */
  delegationId?: string;
}
interface ActivityEvent {
  data: CustomEventData;
}
/** What a delegated session was started for, as `delegationActivityScope` reads it. */
interface DelegatedSession {
  director?: { runId?: string } | null;
  coordinator?: { runId?: string } | null;
  selfCapture?: { runId?: string; facetId?: string } | null;
  playtest?: { runId?: string; facetId?: string } | null;
  ownership?: unknown;
  candidateId?: string;
  readOnly?: boolean;
  /** A worker of a chat's lead: its words are a worker's in the chat, never the chat's own reply. */
  worker?: unknown;
}

/**
 * A lead's own session plans; a worker of a chat's lead, reader or writer, is a worker; a checker
 * reviews; a session that owns work builds; anything else plans.
 */
function sessionRole(input: DelegatedSession): SessionActivityRole {
  if (input.director || input.coordinator) return SessionActivityRole.Planner;
  if (input.worker) return SessionActivityRole.Builder;
  if (input.playtest || input.readOnly) return SessionActivityRole.Reviewer;
  const ownsWork = Boolean(input.selfCapture?.runId || input.ownership || input.candidateId);
  return ownsWork ? SessionActivityRole.Builder : SessionActivityRole.Planner;
}

/** Background builders/checkers must never own the conversation's reply or busy phase. */
export function delegationActivityScope(input: DelegatedSession) {
  return {
    role: sessionRole(input),
    runId: input.director?.runId ?? input.coordinator?.runId ?? input.selfCapture?.runId ?? input.playtest?.runId,
    facetId: input.selfCapture?.facetId ?? input.playtest?.facetId,
  };
}
const labels: Record<ChatActivityPhase, string> = {
  idle: "Idle",
  working: "Working",
  connecting: "Connecting tools",
  thinking: "Thinking",
  responding: "Writing a reply",
  tool: "Running a tool",
  waiting: "Waiting for your answer",
  compacting: "Compacting context",
  "loading-model": "Loading local model",
  queued: "Waiting for local inference",
  stopping: "Stopping",
  completed: "Response completed",
  failed: "Response failed",
  interrupted: "Response interrupted",
};
/** The records that close a run's session. */
const RUN_CLOSES: ReadonlySet<string> = new Set<string>([CustomEvent.RunFinished, CustomEvent.AutopilotPaused]);
/** The phases a finished reply keeps showing once the conversation is no longer active. */
const SETTLED_PHASES: ReadonlySet<ChatActivityPhase> = new Set<ChatActivityPhase>([
  ChatActivityPhase.Failed,
  ChatActivityPhase.Interrupted,
  ChatActivityPhase.Completed,
]);

const idleOrWorking = (active: boolean): ChatActivity =>
  active ? { phase: ChatActivityPhase.Working, label: "Working" } : { phase: ChatActivityPhase.Idle, label: "Idle" };

/**
 * A settled phase from another delegation than the one being shown: a lead's turn ending while
 * the chat's own reply is being written does not end that reply.
 */
function endsAnotherDelegation(current: ChatActivity, phase: ChatActivityPhase, delegationId?: string): boolean {
  const both = Boolean(current.delegationId && delegationId);
  return both && current.delegationId !== delegationId && SETTLED_PHASES.has(phase);
}

/** The activity after one more record of the conversation. */
function activityAfter(current: ChatActivity, data: CustomEventData, active: boolean): ChatActivity {
  if (data.type === EventKind.TurnStarted) return { phase: ChatActivityPhase.Thinking, label: "Thinking" };
  if (data.type === EventKind.TurnEnded)
    return active ? { phase: ChatActivityPhase.Working, label: "Working" } : current;
  // The run's end resets the line. Each director turn ends on a host-written settled phase, but
  // an idle chat would keep showing the lead's last "Response completed" after the run, and a
  // turn that never got one (the app quit mid-turn, or a log older than those records) would
  // label a learning pass or the next turn with the lead's last "Thinking".
  const custom = customRecord(data);
  if (custom && RUN_CLOSES.has(custom.event_type)) return idleOrWorking(active);
  const p = customPayload(data, CustomEvent.SessionActivity);
  if (!p || (p.role && p.role !== SessionActivityRole.Planner)) return current;
  if (!p.phase || !labels[p.phase]) return current;
  if (endsAnotherDelegation(current, p.phase, p.delegationId)) return current;
  return {
    phase: p.phase,
    label: p.label || labels[p.phase],
    sessionId: p.sessionId,
    engine: p.engine,
    ...(p.delegationId ? { delegationId: p.delegationId } : {}),
  };
}

/** What the conversation is doing now, from its records and whether a turn is active. */
export function chatActivity(events: readonly ActivityEvent[], active: boolean, fallback = ""): ChatActivity {
  let result = idleOrWorking(active);
  for (const event of events) result = activityAfter(result, event.data, active);
  if (!active && !SETTLED_PHASES.has(result.phase)) return { phase: ChatActivityPhase.Idle, label: "Idle" };
  const finishedReply = result.phase === ChatActivityPhase.Idle || SETTLED_PHASES.has(result.phase);
  if (active && finishedReply) return { phase: ChatActivityPhase.Working, label: fallback || "Working" };
  if (result.phase === ChatActivityPhase.Working && fallback && !/^building$/i.test(fallback))
    return { ...result, label: fallback };
  return result;
}
