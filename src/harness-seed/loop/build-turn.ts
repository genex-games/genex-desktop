/**
 * One build turn, on whichever kind of engine the run's builder is.
 *
 * A delegated engine (Claude Code, Codex) holds a session: the turn is one `engine.delegate`,
 * given a timeout that is never under a minute — a turn asked to finish in eight seconds is a turn
 * that fails for the clock, not for its work. A direct engine completes turns in the harness's own
 * tool loop: the turn is opened on the thread (`turn.begin`), run (`runTurn`) and closed with how
 * it ended (`turn.end`), and a failure still closes it before it is thrown on — a turn left open
 * reads as one still running.
 *
 * Four loops used to write this out for themselves (the classic gauntlet, the pipeline's base
 * builder, a facet's build turn and a spike). What stays theirs: the prompt, what the delegation
 * carries (its seam, its window, its images), and the effort — a caller that sends none leaves the
 * key out, and one that means "exactly the run's effort, even none" passes `effort` as it is.
 */
import { HostMethod } from "./host-methods.ts";
import { runTurn } from "./turn-loop.ts";
import { BUILD_TURN_MAX_ROUNDS, MIN_DELEGATE_TIMEOUT_MS } from "./config.ts";
import { TurnStatus } from "./turn-record.ts";
import type { HarnessCtx } from "../types/harness.d.ts";
import type { DelegateResult, HarnessDelegateParams } from "../types/host-api.d.ts";

/**
 * One build turn's request. Delegated: `timeoutMs` (floored at a minute), a run's sub-agent's
 * `attribution` and `toolAllow`, and `delegation` (selfCapture, ownership, extraReads, images …
 * spread into the call as given). Direct: `metadata` for the thread's turn, `deadlineMs`, and
 * `turn` (extra `runTurn` options such as `text`, `iteration`, `setup`).
 */
export interface BuildTurnOptions {
  delegated: boolean;
  engine: string;
  prompt: string;
  project: string;
  threadId: string;
  runId?: string;
  model?: string;
  effort?: string;
  cwd?: string | null;
  resume?: string | null;
  timeoutMs?: number;
  /** A run's sub-agent: whose plugin calls these are, so what it makes lands on its own node. */
  attribution?: HarnessDelegateParams["attribution"];
  /** A run's sub-agent: the plugin tools and connectors (or name prefixes) it may be offered. */
  toolAllow?: HarnessDelegateParams["toolAllow"];
  delegation?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  deadlineMs?: number;
  turn?: Record<string, unknown>;
}

/** What a direct engine's turn ended with (`runTurn`). */
export type TurnResult = Awaited<ReturnType<typeof runTurn>>;

/** One build turn: the delegation's answer, or what `runTurn` returned. */
export function buildTurn(ctx: HarnessCtx, options: BuildTurnOptions & { delegated: true }): Promise<DelegateResult>;
export function buildTurn(ctx: HarnessCtx, options: BuildTurnOptions & { delegated: false }): Promise<TurnResult>;
export function buildTurn(ctx: HarnessCtx, options: BuildTurnOptions): Promise<DelegateResult | TurnResult>;
export async function buildTurn(ctx: HarnessCtx, options: BuildTurnOptions): Promise<DelegateResult | TurnResult> {
  const {
    delegated,
    engine,
    prompt,
    project,
    threadId,
    runId,
    model,
    cwd = null,
    resume = null,
    timeoutMs,
    attribution,
    toolAllow,
    delegation = {},
    metadata = {},
    deadlineMs,
    turn: turnOptions = {},
  } = options;
  // Present only when the caller named it: "effort" in options, not a truthy value.
  const effort = "effort" in options ? { effort: options.effort } : {};
  if (delegated) {
    return ctx.call(HostMethod.EngineDelegate, {
      engine,
      prompt,
      project,
      ...(cwd ? { cwd } : {}),
      threadId,
      ...(model ? { model } : {}),
      ...effort,
      ...(resume ? { resume } : {}),
      timeoutMs: Math.max(MIN_DELEGATE_TIMEOUT_MS, timeoutMs ?? MIN_DELEGATE_TIMEOUT_MS),
      ...(attribution ? { attribution } : {}),
      ...(toolAllow ? { toolAllow } : {}),
      ...delegation,
    });
  }
  const turn = await ctx.call(HostMethod.TurnBegin, { threadId, input: [{ role: "user", content: prompt }], metadata });
  try {
    const outcome = await runTurn(ctx, {
      threadId,
      turnId: turn.turnId,
      ...turnOptions,
      engine,
      model,
      ...effort,
      runId,
      project,
      maxRounds: BUILD_TURN_MAX_ROUNDS,
      deadlineMs,
    });
    await ctx.call(HostMethod.TurnEnd, { turnId: turn.turnId, status: TurnStatus.Ok });
    return outcome;
  } catch (err) {
    await ctx.call(HostMethod.TurnEnd, { turnId: turn.turnId, status: TurnStatus.Error });
    throw err;
  }
}
