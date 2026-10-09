/**
 * The turn loop — PLAN.md §5.1, ported from Exo's `model-runtime/turn-loop.ts`.
 *
 * Two properties are load-bearing and must survive every future self-edit:
 *
 *  1. **The prompt is materialised from the event log every round.** There is no hidden
 *     in-memory conversation: the log is the state (hard constraint #2), so a crash mid-turn
 *     costs nothing and a fork of the log is a fork of the mind.
 *  2. **The tool registry is rebuilt every round.** A tool the agent writes during this turn is
 *     callable on the next round, without a restart. That is what makes tool self-installation
 *     feel immediate rather than ceremonial.
 *
 * This module picks the turn's runner: the Studio's own chat (studio-chat.ts), a delegated
 * engine's contractor (delegated-turn.ts), or the tool loop of a direct engine (tool-loop.ts).
 */
import { EngineId, resolveRoles, supportsSessions } from "./model-roles.ts";
import { runStudioTurn } from "./studio-chat.ts";
import { interviewForReply } from "./interview-question.ts";
import { HostMethod } from "./host-methods.ts";
import { runDelegatedTurn } from "./delegated-turn.ts";
import { resolveContextWindow, runToolLoop } from "./tool-loop.ts";
import {
  buildContractorBrief,
  isContinueAsk,
  lastContractorSession,
  nameFromAsk,
  resolveChatProject,
} from "./chat-session.ts";
import type { AnyRecord, HarnessCtx } from "../types/harness.d.ts";
import type { ModelPreferences, ReferenceFrame } from "../types/host-api.d.ts";
import type { SteerHandle } from "./message-queue.ts";
import type { AfterLoopRun } from "./after-loop-run.ts";

/**
 * This runner passes the chat's turn the run its own session answers after (`afterLoopRun`) on the
 * engine and model it names, and returns the resume that turn records (after-loop-run.ts).
 * chat-dispatch.ts asks before it sends the chat there (`servesAfterLoopRun`): a kept copy from before
 * may do neither.
 */
export const SERVES_AFTER_LOOP_RUN = true;

/**
 * This runner keeps the chat's own session after its run on the model it answers on, also when a
 * Loop came with the message (`turnModel`): the run it reopens then seats that same session
 * (reopen-run.ts). chat-dispatch.ts asks before it offers the reopen (`servesReopen`): a kept copy
 * from before would move the session to the commission's planner.
 */
export const SERVES_REOPEN = true;

/** One turn's options: who is asked, where, with what, and — inside a run — under which clock. */
export interface TurnOptions {
  threadId: string;
  turnId: string;
  /** The run whose finished work the coordinator's continue_build hands this builder turn (chat-dispatch.ts). */
  followupOf?: string;
  text?: string;
  engine?: string;
  model?: string;
  effort?: string;
  preferences?: ModelPreferences;
  project?: string | null;
  newProject?: boolean;
  studioThread?: boolean;
  resume?: string | null;
  projectDir?: string;
  extraReads?: string[];
  stills?: ReferenceFrame[];
  loop?: AnyRecord | null;
  autopilot?: AnyRecord | null;
  runId?: string;
  iteration?: number;
  setup?: AnyRecord | null;
  deadlineMs?: number;
  maxRounds?: number;
  contextWindow?: number | null;
  extraSystem?: string;
  engineLabel?: string;
  candidateId?: string;
  /** The queue's door into this turn for what the person sends while it works (chat-steer.ts). */
  steer?: SteerHandle;
  /** The run this chat's own session led is over: it answers with the run's controls (after-loop-run.ts). */
  afterLoopRun?: AfterLoopRun;
  [option: string]: unknown;
}

/** How a turn ended (one of `TurnStop`, turn-record.ts), and what its last tool handed on. */
export interface TurnOutcome {
  stopped: string;
  round: number;
  engine?: string;
  details?: AnyRecord;
}

export {
  isContinueAsk,
  lastContractorSession,
  resolveChatProject,
  buildContractorBrief,
  nameFromAsk,
  resolveContextWindow,
};

/** Run one chat turn on the runner its engine calls for. */
export async function runTurn(ctx: HarnessCtx, requested: TurnOptions): Promise<TurnOutcome> {
  const options = await withInterviewCommission(ctx, requested);
  const engine = options.engine ?? EngineId.Ollama;
  const described = await ctx.call(HostMethod.EngineDescribe);
  const contextWindowOf = (model: string | undefined) => resolveContextWindow(described, engine, model);
  if (options.studioThread)
    return runStudioTurn(ctx, {
      ...options,
      engine,
      model: options.model,
      contextWindow: contextWindowOf(options.model),
    });
  const loop = options.loop ? { ...options.loop } : null;
  const autopilot = options.autopilot ? { ...options.autopilot } : null;
  // Loop and Autopilot share one shape: this chat may commission a build, with the composer's
  // engine kept as the builder.
  const commission = autopilot ?? loop;
  if (commission) stampBuilder(commission, engine, options.model);
  const model = turnModel(options, commission, engine);
  const descriptor = described.find((e) => e.id === engine);
  if (supportsSessions(descriptor)) {
    return runDelegatedTurn(ctx, {
      ...options,
      engine,
      engineLabel: descriptor?.label ?? engine,
      model,
      ...(loop ? { loop } : {}),
      ...(autopilot ? { autopilot } : {}),
    });
  }
  return runToolLoop(ctx, { ...options, engine, model, contextWindow: contextWindowOf(model), loop, autopilot });
}

/**
 * A chat turn that may answer an interview question: no commission, run, Studio thread or
 * coordinator's follow-up of its own — the builder a continue_build hands work to never commissions.
 */
function plainChat(options: TurnOptions): boolean {
  const commissioned = Boolean(options.autopilot || options.loop);
  return !commissioned && !options.runId && !options.followupOf && !options.studioThread;
}

/**
 * A reply to an interview question inherits the question's commission (interview-question.ts),
 * including after a restart. Only a plain chat turn, still inside any deadline it has, asks.
 */
async function withInterviewCommission(ctx: HarnessCtx, options: TurnOptions): Promise<TurnOptions> {
  const inTime = !options.deadlineMs || options.deadlineMs > Date.now();
  if (!plainChat(options) || !inTime) return options;
  const intakeId = interviewForReply(await ctx.call(HostMethod.EventsList, { threadId: options.threadId }));
  if (!intakeId) return options;
  const intake = (await ctx.call(HostMethod.ArtifactRead, {
    threadId: options.threadId,
    artifactId: intakeId,
  })) as AnyRecord | null;
  return intake ? { ...options, ...intake } : options;
}

/**
 * A commissioning chat needs our launch tools (start_unattended_run / start_autopilot).
 * A direct engine drives them through the tool loop; a delegated engine gets them bridged
 * in as MCP tools, so the engine the user picked is the one that talks to them — the old
 * borrow-a-local-model shortcut read as a bait-and-switch under the Claude Code label.
 * The commission remembers the *pick* (`stampBuilder`); the run resolves it into roles at launch
 * (model-roles.ts). The chat that decides and scopes a build is orchestrator work, so it runs on
 * the planner.
 */
function plannerModel(commission: AnyRecord, engine: string, model: string | undefined): string | undefined {
  return commission.roles?.planner ?? resolveRoles(engine, model).planner;
}

/**
 * The model the turn runs on. A commissioning chat decides and scopes a build: the planner. The chat's
 * own session after its run stays on the model it answers on (after-loop-run.ts `AfterLoopRun.model`, or
 * the message's): the swap would move the session to another model, and the run it reopens would
 * seat a lead of its own (director/lead-session.ts `continuesChat`).
 */
function turnModel(options: TurnOptions, commission: AnyRecord | null, engine: string): string | undefined {
  if (!commission || options.afterLoopRun) return options.model;
  return plannerModel(commission, engine, options.model);
}

/** Write the composer's engine and model onto the commission as its builder's, unless it names its own. */
function stampBuilder(commission: AnyRecord, engine: string, model: string | undefined): void {
  commission.builderEngine = commission.builderEngine ?? engine;
  if (model) commission.builderModel = commission.builderModel ?? model;
}
