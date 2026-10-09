/**
 * The run's coordinator: a read-only session of its own, in a scratch home per chat, that answers
 * the chat for a run with the coordinator's tools (run-inbox.ts `coordinatorTools`). After a run a
 * lead of the chat's own led, the chat's own session answers instead (after-loop-run.ts); this stays
 * the fallback — the long turn, the classic pipeline, a kept older seed, a lead that was a session
 * of its own, a model without sessions — for one release (docs/harness-runtime.md). After a
 * finished build that seated a lead, when a message came with Loop on and this coordinator answers
 * in a session, its continue_build reopens that run with the Loop's time and the build's models
 * (reopen-run.ts `finishedLoopRun`), if its parts serve it (chat-dispatch.ts `coordinatorReopens`).
 */
import { EngineId, plannerModel, roleEffort, RoleKey, supportsSessions } from "./model-roles.ts";
import { coordinatorTools, conversationThrough } from "./run-inbox.ts";
import { steeredCall } from "./chat-steer.ts";
import type { SteerHandle } from "./message-queue.ts";
import { COORDINATOR_SYSTEM, coordinatorPrompt } from "./coordinator-prompts.ts";
import { HostMethod } from "./host-methods.ts";
import { readJournal } from "./run-journal.ts";
import { EventKind, RunEvent } from "./run-events.ts";
import { MINUTE_MS } from "./time.ts";
import { resolveContextWindow } from "./tool-loop.ts";
import type { AnyRecord, HarnessCtx, HarnessEvent } from "../types/harness.d.ts";
import type { DelegateImage, DelegateResult, Message, ReferenceFrame } from "../types/host-api.d.ts";

/**
 * The coordinator is told a Loop's reopen when the chat offers one (`reopen`): chat-dispatch.ts
 * keeps a Loop for it only when this and coordinator-prompts.ts say so (`coordinatorReopens`).
 */
export const SERVES_REOPEN = true;

/** How long a delegated coordinator may take to answer one message. */
const DELEGATE_TIMEOUT_MS = 5 * MINUTE_MS;
/** How many tool rounds a completion-only coordinator may take for one message. */
const MAX_TOOL_ROUNDS = 8;
/** How many recent user and assistant messages the prompt carries. */
const HISTORY_MESSAGES = 20;
/** A rough count of characters per token, and the share of the model's window the run's record may fill. */
const CHARS_PER_TOKEN = 4;
const RECORD_WINDOW_SHARE = 0.5;
/**
 * A delegated session's records as the app mirrors them into the chat (`delegated.<engine>`,
 * main/core/delegation-events.ts): what one said is an `assistant` record, and the chat's own
 * sessions — a run's lead, this coordinator — are `planner`s. Copied here as chat-session.ts
 * copies the prefix: the seed cannot import the app.
 */
const MIRRORED_PREFIX = "delegated.";
const Mirrored = { Assistant: "assistant", Planner: "planner", Text: "text" } as const;

/** A message the game's chat answers while its run exists: the dispatch action, and the run. */
export interface CoordinatorTurnOptions {
  threadId: string;
  turnId: string;
  run: AnyRecord;
  text?: string;
  engine?: string;
  model?: string;
  effort?: string;
  messageId?: string;
  stills?: ReferenceFrame[];
  /** The queue's door into this turn for what the person sends while it works (chat-steer.ts). */
  steer?: SteerHandle;
  /**
   * A Loop came with the message after a finished build: its continue_build reopens it for these hours
   * (null: ∞), and the stills the coordinator was shown with the message are to be put in words.
   */
  reopen?: { hours: number | null; frameCount?: number } | null;
  [field: string]: unknown;
}

/** One coordinator turn's settled inputs: the engine and model it answers with, and its prompt. */
interface CoordinatorTurn {
  ctx: HarnessCtx;
  options: CoordinatorTurnOptions;
  engine: string;
  model: string | undefined;
  prompt: string;
  /** The coordinator's own saved session, when it has one. */
  prior: AnyRecord | null;
  say: (content: string | null | undefined) => Promise<void>;
}

/** The conversational registrar has its own session; worker sessions never replace it. */
export async function runCoordinatorTurn(ctx: HarnessCtx, options: CoordinatorTurnOptions): Promise<void> {
  const { threadId, turnId, run, text } = options;
  const engine = options.engine ?? run.engine ?? EngineId.Ollama;
  const model = options.model ?? plannerModel(run);
  const events = await ctx.call(HostMethod.EventsList, { threadId });
  const prior = (await ctx
    .call(HostMethod.ArtifactRead, { threadId, artifactId: sessionKeyOf(engine) })
    .catch(() => null)) as AnyRecord | null;
  const journal = await readJournal(ctx, threadId, run.runId);
  const described = await ctx.call(HostMethod.EngineDescribe);
  const prompt = coordinatorPrompt({
    events,
    run,
    text,
    journal,
    savedPlan: savedPlanOf(events, journal),
    history: recentHistory(events, options.messageId, run.runId),
    reopen: options.reopen ?? null,
    ...recordBudget(resolveContextWindow(described, engine, model)),
  });
  const say = async (content: string | null | undefined): Promise<void> => {
    if (!content?.trim()) return;
    await ctx.call(HostMethod.TurnAppend, {
      turnId,
      batch: [{ type: EventKind.Messages, messages: [{ role: "assistant", content }] }],
    });
    ctx.notify("chat.message", { threadId, role: "assistant", content });
  };
  const turn: CoordinatorTurn = { ctx, options, engine, model, prompt, prior, say };
  if (supportsSessions(described.find((e) => e.id === engine))) {
    await answerDelegated(turn);
    return;
  }
  await answerWithTools(turn);
}

/**
 * How much of the run's record a model whose window is known can take: half its window, in
 * characters. An unknown window keeps the prompt's own ceiling.
 */
function recordBudget(contextWindow: number | null): { budgetChars?: number } {
  return contextWindow ? { budgetChars: Math.floor(contextWindow * CHARS_PER_TOKEN * RECORD_WINDOW_SHARE) } : {};
}

/** The artifact the coordinator's session on `engine` is saved under. */
function sessionKeyOf(engine: string): string {
  return `coordinator_${engine}`;
}

/** The plan the run is building: the director's, the classic journal's, or the last reviewed one. */
function savedPlanOf(events: readonly HarnessEvent[], journal: AnyRecord | null): unknown {
  const reviews = events.filter((e) => e.data?.event_type === RunEvent.PlanReview && e.data.payload?.plan);
  return journal?.director?.plan ?? journal?.plan ?? reviews.at(-1)?.data.payload?.plan ?? null;
}

/**
 * The conversation up to this message, as `role: content` lines — with what the run's lead said in
 * the chat while its run ran (live chat), which only the mirrored records of its session hold.
 */
function recentHistory(events: readonly HarnessEvent[], messageId: string | undefined, runId: string): string {
  return historyLines(conversationThrough(events, messageId), runId)
    .slice(-HISTORY_MESSAGES)
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");
}

/**
 * The chat's words in log order: its messages, and the run's lead's — a planner of the run speaking
 * outside any coordinator turn. A coordinator's own session (one seen inside the turn it answers)
 * is left out: its reply is in the chat's messages already.
 */
function historyLines(events: readonly HarnessEvent[], runId: string): Array<{ role: string; content: string }> {
  const lines: Array<{ role: string; content: string }> = [];
  const answering = new Set<unknown>();
  const coordinators = new Set<unknown>();
  for (const event of events) {
    const d = event.data;
    if (d?.type === EventKind.Messages) lines.push(...(d.messages ?? []).filter(isChatLine));
    if (d?.type !== EventKind.Custom) continue;
    trackAnswering(answering, d.event_type, d.payload?.messageId);
    const mirrored = d.event_type.startsWith(MIRRORED_PREFIX) ? (d.payload ?? {}) : null;
    if (mirrored && answering.size) coordinators.add(mirrored.delegationId);
    const lead = mirrored && !answering.size && !coordinators.has(mirrored.delegationId);
    if (lead) lines.push(...leadSaid(mirrored, runId));
  }
  return lines;
}

/** A user's or an assistant's message. */
const isChatLine = (m: { role?: string }): m is { role: string; content: string } =>
  m.role === "user" || m.role === "assistant";

/** A coordinator turn opens when its message is taken, and ends when it is answered or put back. */
function trackAnswering(answering: Set<unknown>, eventType: string, messageId: unknown): void {
  if (eventType === RunEvent.CoordinatorMessageProcessing) answering.add(messageId);
  const ended = eventType === RunEvent.CoordinatorMessageHandled || eventType === RunEvent.CoordinatorMessageRequeued;
  if (ended) answering.delete(messageId);
}

/** What a planner of this run said in one mirrored record, as assistant lines. */
function leadSaid(payload: AnyRecord, runId: string): Array<{ role: string; content: string }> {
  const said = payload.kind === Mirrored.Assistant && payload.role === Mirrored.Planner && payload.runId === runId;
  if (!said) return [];
  const parts: AnyRecord[] = Array.isArray(payload.data?.parts) ? payload.data.parts : [];
  return parts
    .filter((part) => part?.type === Mirrored.Text && String(part.text ?? "").trim())
    .map((part) => ({ role: "assistant", content: String(part.text) }));
}

/** A session-capable engine answers in its own resumable, read-only session. */
async function answerDelegated({ ctx, options, engine, model, prompt, prior, say }: CoordinatorTurn): Promise<void> {
  const { threadId, run, steer } = options;
  const delegate = (leg: string, resume: string | null, images: DelegateImage[]): Promise<DelegateResult> =>
    ctx.call(HostMethod.EngineDelegate, {
      engine,
      model,
      effort: options.effort ?? roleEffort(run, RoleKey.Planner),
      preferences: run.preferences,
      ...(images.length ? { images } : {}),
      threadId,
      project: run.project,
      prompt: leg,
      coordinator: { runId: run.runId, messageId: options.messageId },
      readOnly: true,
      ...(resume ? { resume } : {}),
      timeoutMs: DELEGATE_TIMEOUT_MS,
      // This session is the chat's current turn: what the person sends meanwhile reaches it.
      ...(steer ? { chatTurn: { messageId: steer.messageId } } : {}),
    });
  const result = await steeredCall(ctx, steer, {
    prompt,
    resume: prior?.sessionId ?? null,
    images: options.stills ?? [],
    call: delegate,
  });
  if (result.sessionId)
    await ctx.call(HostMethod.ArtifactWrite, {
      threadId,
      artifactId: sessionKeyOf(engine),
      value: { sessionId: result.sessionId, engine },
    });
  if (ctx.cancelled) return;
  await say(result.summary || delegatedFallback(result));
}

/** What the chat says when a delegated answer came back without a summary. */
function delegatedFallback(result: DelegateResult): string {
  if (result.ok) return "Done.";
  return `I could not answer that: ${result.errorText ?? result.stopReason ?? "provider error"}. The build was not restarted.`;
}

/** A completion-only engine answers through the coordinator's tools, a bounded number of rounds. */
async function answerWithTools({ ctx, options, engine, model, prompt, say }: CoordinatorTurn): Promise<void> {
  const { threadId, run } = options;
  // A delegated session has the builders' capabilities appended by the host; this path asks for them.
  const capabilities = await ctx
    .call(HostMethod.CapabilitiesDescribe, { threadId, project: run.project })
    .catch(() => "");
  const messages: Message[] = [{ role: "user", content: [prompt, capabilities].filter(Boolean).join("\n\n") }];
  for (let round = 0; round < MAX_TOOL_ROUNDS && !ctx.cancelled; round++) {
    const response = await ctx.call(HostMethod.EngineComplete, {
      threadId,
      engine,
      model,
      messages,
      tools: coordinatorTools,
      systemPrompt: COORDINATOR_SYSTEM,
    });
    if (response.message) messages.push(response.message);
    await say(response.message?.content);
    const calls = response.message?.tool_calls ?? [];
    if (!calls.length) return;
    for (const call of calls) {
      const content = await runCoordinatorTool(ctx, options, call);
      messages.push({ role: "tool", tool_call_id: call.id, content });
    }
  }
}

/** One coordinator tool call, answered by the host; a failure is the tool's answer. */
async function runCoordinatorTool(
  ctx: HarnessCtx,
  { threadId, run, messageId }: CoordinatorTurnOptions,
  call: { name: string; arguments?: unknown },
): Promise<string> {
  try {
    const content = await ctx.call(HostMethod.CoordinatorTool, {
      threadId,
      runId: run.runId,
      messageId,
      name: call.name,
      args: (call.arguments ?? {}) as Record<string, unknown>,
    });
    return String(content);
  } catch (err: any) {
    return String(err?.message ?? err);
  }
}
