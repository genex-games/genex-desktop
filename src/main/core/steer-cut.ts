/**
 * Steer's cut, the host's half (`chat-steer.ts`): a session that cannot read the person's message
 * mid-turn is cut only between tool calls, never inside one, so no tool's result is lost. What a
 * session has in flight is read from its own events as they arrive (`noteEvent`, before the mirror
 * records them): the mirrored `tool_use` rows until their `tool_result`, balanced by id (a
 * subagent's nested calls, which name no parent, balance on their own ids); and, for an engine
 * whose rows arrive only once a call has ended, its activity alone, never its rows (one it mirrors
 * unanswered would hold every cut to the cap): Codex's tool item starting (`Tool`) until an item
 * completes (`Thinking`), OpenCode's step starting (`Working`, opencode-events.ts) until it
 * finishes (`Thinking`). A call waiting for the person's answer to its permission card has not
 * started (`noteAsking`): a cut does not wait for that answer. A cut waits for the rest to end, never
 * longer than `STEER_CUT_MAX_WAIT_MS`. Stop, a session's deadline and `engine.interrupt` never come through
 * here: they abort at once.
 */
import { ChatActivityPhase } from "../../shared/chat-activity.ts";
import { MINUTE_MS } from "../../shared/duration.ts";
import { EngineId } from "../../shared/providers.ts";
import { type DelegateEvent, DelegateEventType } from "../../substrate/engines/types.ts";

/**
 * How long a cut waits for a session's tools to end before it cuts anyway: longer than one bridge
 * call may take (`BRIDGE_TOOL_DEADLINE_MS`, 10 minutes), so only a call that will never answer is
 * cut inside, and a stuck id never strands a message.
 */
export const STEER_CUT_MAX_WAIT_MS = 15 * MINUTE_MS;

/** Engines whose tool rows arrive only once a call has ended: when one starts is read from their activity. */
const SPANS_FROM_ACTIVITY: ReadonlySet<string> = new Set<string>([EngineId.Codex, EngineId.OpenCode]);
/** The activity that opens a span: Codex's tool item starting, OpenCode's step starting. */
const OPENS_SPAN: ReadonlySet<string> = new Set<string>([ChatActivityPhase.Tool, ChatActivityPhase.Working]);
/** The activity that closes one: an item completed, a step finished. */
const CLOSES_SPAN: string = ChatActivityPhase.Thinking;
/** The mirrored part that starts a call, and the field that names it (`compactPart`'s shape). */
const CALL_PART = { type: "tool_use", key: "id" } as const;
/** The mirrored part that ends one, and the field that names the call it answers. */
const ANSWER_PART = { type: "tool_result", key: "tool_use_id" } as const;

/** A session's tool calls in flight, as its events say, and who waits for them to end. */
export interface ToolsInFlight {
  /** Calls mirrored and not answered yet, by id (a `tool_use` without its `tool_result`). */
  readonly ids: Set<string>;
  /** Spans its activity opened and has not closed: Codex's tool items, OpenCode's steps. */
  spans: number;
  /** Whether its engine's activity says when a call starts (`SPANS_FROM_ACTIVITY`). */
  readonly readsActivity: boolean;
  /** Calls waiting for the person's answer to their permission card, by id: not started yet. */
  readonly asking: Set<string>;
  /** Who hears, once each, that nothing is in flight any more. */
  readonly idle: Set<() => void>;
}

/** Nothing in flight yet, for a session on `engine`. */
export function toolsInFlight(engine: string): ToolsInFlight {
  return {
    ids: new Set(),
    spans: 0,
    readsActivity: SPANS_FROM_ACTIVITY.has(engine),
    asking: new Set(),
    idle: new Set(),
  };
}

/** Whether a tool call (or, for an engine that says no more, a step) is in flight now; one still asking is not. */
export function toolsRunning(tools: ToolsInFlight): boolean {
  return tools.spans > 0 || [...tools.ids].some((id) => !tools.asking.has(id));
}

/** A call's permission card is waiting for the person (`asking`), or was answered. */
export function noteAsking(tools: ToolsInFlight, toolUseId: string, asking: boolean): void {
  const before = toolsRunning(tools);
  if (asking) tools.asking.add(toolUseId);
  else tools.asking.delete(toolUseId);
  if (before && !toolsRunning(tools)) heardIdle(tools);
}

/** One event of the session, read for what it starts and ends; who waits hears it once nothing is left. */
export function noteEvent(tools: ToolsInFlight, event: DelegateEvent): void {
  const before = toolsRunning(tools);
  const payload: unknown = event.payload;
  if (tools.readsActivity) {
    if (event.type === DelegateEventType.Activity) noteActivity(tools, isRecord(payload) ? payload.phase : undefined);
  } else if (event.type === DelegateEventType.Assistant) {
    for (const id of partIds(payload, CALL_PART)) tools.ids.add(id);
  } else if (event.type === DelegateEventType.User) {
    for (const id of partIds(payload, ANSWER_PART)) tools.ids.delete(id);
  }
  if (before && !toolsRunning(tools)) heardIdle(tools);
}

/** Who waits for nothing to be in flight hears it, once each. */
function heardIdle(tools: ToolsInFlight): void {
  const waiting = [...tools.idle];
  tools.idle.clear();
  for (const hear of waiting) hear();
}

/** Codex's or OpenCode's activity: a span opens as a call or a step starts, and closes as one ends. */
function noteActivity(tools: ToolsInFlight, phase: unknown): void {
  if (typeof phase !== "string") return;
  if (OPENS_SPAN.has(phase)) tools.spans += 1;
  // Never below nothing: Codex says an item completed for items that were never tools.
  else if (phase === CLOSES_SPAN) tools.spans = Math.max(0, tools.spans - 1);
}

/** The ids of a mirrored row's parts of one kind; nothing for a row that is not one, or a part with no id. */
function partIds(payload: unknown, kind: typeof CALL_PART | typeof ANSWER_PART): string[] {
  const parts = isRecord(payload) ? payload.parts : undefined;
  if (!Array.isArray(parts)) return [];
  return parts.flatMap((part: unknown) => {
    if (!isRecord(part) || part.type !== kind.type) return [];
    const id = part[kind.key];
    return typeof id === "string" && id ? [id] : [];
  });
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** How a cut waits out its cap: real time, or a test's own clock. Its signal ends the wait early. */
export type CutWait = (ms: number, signal?: AbortSignal) => Promise<unknown>;

/** What a cut reaches of a session (`ActiveDelegation`): its stop, its end, its tools, and whether a cut waits. */
export interface CutTarget {
  abort: AbortController;
  /** Its engine call has returned. */
  ended?: boolean;
  /** Aborts once its engine has let go, before it is marked ended. */
  settled?: AbortSignal;
  tools?: ToolsInFlight;
  cutPending?: boolean;
}

/**
 * Cut the session at its next step: now when no tool is in flight, else the moment the last one
 * ends, or once `STEER_CUT_MAX_WAIT_MS` passed on `wait`. A cut already waiting is the same cut. A
 * session that ended meanwhile is never aborted after: its jobs and calls end with its own end.
 */
export function cutAtNextStep(session: CutTarget, wait: CutWait): void {
  if (session.cutPending || session.abort.signal.aborted) return;
  const { tools } = session;
  if (!tools || !toolsRunning(tools)) {
    session.abort.abort();
    return;
  }
  session.cutPending = true;
  const landed = new AbortController();
  const land = () => {
    if (landed.signal.aborted) return;
    landed.abort();
    tools.idle.delete(onIdle);
    session.cutPending = false;
    if (!hasEnded(session)) session.abort.abort();
  };
  // A microtask later, so the row that ended the call is mirrored first; a call that started in the
  // same moment keeps the cut waiting for it.
  const onIdle = () =>
    queueMicrotask(() => {
      if (toolsRunning(tools)) tools.idle.add(onIdle);
      else land();
    });
  tools.idle.add(onIdle);
  const ends = session.settled ? AbortSignal.any([landed.signal, session.settled]) : landed.signal;
  wait(STEER_CUT_MAX_WAIT_MS, ends).then(land, () => {});
}

/** Its engine call returned, or its engine let go. */
const hasEnded = (session: CutTarget): boolean => session.ended === true || session.settled?.aborted === true;
