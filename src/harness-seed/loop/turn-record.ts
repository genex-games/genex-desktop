/**
 * How a chat turn is recorded: why it stopped (`TurnOutcome.stopped`, or a tool's `stopTurn`),
 * the status the host keeps on `turn.end`, and the reply a turn appends for the chat.
 */
import { HostMethod } from "./host-methods.ts";
import { EventKind } from "./run-events.ts";
import type { HarnessCtx } from "../types/harness.d.ts";
import type { HarnessHostApi } from "../types/host-api.d.ts";

/** Why a turn stopped. A tool's `stopTurn` is one of these too; callers read them: never rename one. */
export const TurnStop = {
  /** The turn answered. */
  Done: "done",
  /** The user pressed Stop. */
  Cancelled: "cancelled",
  /** A contractor session the user stopped; its finished edits are kept. */
  Aborted: "aborted",
  /** The engine needs a sign-in only a person can give. */
  NeedsSignin: "needs_signin",
  /** The engine is out of usage, throttled with nothing to fall back to, or its model does not fit this computer's memory. */
  EngineLimited: "engine_limited",
  /** The loop spent every tool round it was given. */
  MaxRounds: "max_rounds",
  /** The chat's session started a Loop: the outcome's `details.run` is its spec. */
  LaunchRun: "launch_run",
  /** The harness restarts itself into an edit (`restart_studio`). */
  Restart: "restart",
} as const;
export type TurnStop = (typeof TurnStop)[keyof typeof TurnStop];

/** How the host records a finished turn (`turn.end`). Wire values: never rename one. */
export const TurnStatus = {
  Ok: "ok",
  Error: "error",
  Cancelled: "cancelled",
} as const satisfies Record<string, NonNullable<HarnessHostApi["turn.end"]["params"]["status"]>>;
export type TurnStatus = (typeof TurnStatus)[keyof typeof TurnStatus];

/**
 * Why a chat turn that threw failed, as `turn.end`'s `failure` names it: the app keeps a copy
 * (`shared/engine-requests.ts`), and its analytics count turns by it. Wire values: never rename one.
 */
export const TurnFailureCode = {
  /** The model's context cannot hold the turn's instructions and tools, whatever the history. */
  ContextTooSmall: "context_too_small",
  /** The conversation still does not fit the model's context after compaction. */
  ContextFull: "context_full",
  /** A host call the turn made failed (`method` names it). */
  HostCall: "host_call",
  /** A host call outlived its deadline (`method` names it). */
  HostDeadline: "host_deadline",
  /** The engine's call failed (its kind is on the turn's `completion_call`). */
  Engine: "engine",
  /** Anything else the harness's own code threw (`name` is its error's type). */
  Harness: "harness",
} as const;
export type TurnFailureCode = (typeof TurnFailureCode)[keyof typeof TurnFailureCode];

/** The `code` a host call answered by its deadline carries (`RpcDeadline`). */
const RPC_DEADLINE_CODE = "rpc_deadline";

/** What `turn.end` is told about a turn that threw: never its words. */
export interface TurnFailureRecord {
  code: TurnFailureCode;
  method?: string;
  name?: string;
}

/** An error that says why its turn failed: the harness's own throw names its code (`turnFailure`). */
export function withTurnFailure<E extends Error>(error: E, code: TurnFailureCode): E {
  return Object.assign(error, { turnFailure: code });
}

/** The code a thrown value is read as: its own, a host call's (by `hostMethod`), an engine's (by `kind`), else the harness's. */
function failureCode(err: {
  turnFailure?: unknown;
  hostMethod?: unknown;
  code?: unknown;
  kind?: unknown;
}): TurnFailureCode {
  const own = Object.values(TurnFailureCode).find((code) => code === err.turnFailure);
  if (own) return own;
  if (typeof err.kind === "string") return TurnFailureCode.Engine;
  if (typeof err.hostMethod !== "string") return TurnFailureCode.Harness;
  return err.code === RPC_DEADLINE_CODE ? TurnFailureCode.HostDeadline : TurnFailureCode.HostCall;
}

/** Why a turn that threw `err` failed, for `turn.end`: its code, the host call and the error's type. */
export function turnFailureOf(err: unknown): TurnFailureRecord {
  const thrown = (err !== null && typeof err === "object" ? err : {}) as Record<string, unknown>;
  const { hostMethod, name } = thrown;
  return {
    code: failureCode(thrown),
    ...(typeof hostMethod === "string" ? { method: hostMethod } : {}),
    ...(typeof name === "string" ? { name } : {}),
  };
}

/** Say `content` in the chat as this turn's assistant reply: recorded on the turn, then pushed. */
export async function sayInTurn(ctx: HarnessCtx, turnId: string, content: string): Promise<void> {
  await ctx.call(HostMethod.TurnAppend, {
    turnId,
    batch: [{ type: EventKind.Messages, messages: [{ role: "assistant", content }] }],
  });
  ctx.notify("chat.message", { role: "assistant", content });
}
