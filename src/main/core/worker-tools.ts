/**
 * The worker tools of the chat's own session: which of the harness's tools it is handed (only the
 * six worker tools, and only while the harness serves workers), and how a call reaches the
 * harness's pool for the turn it answers (`worker_tool`). Plan holds writers here, before anything
 * is dispatched: a copy or an in-place writer waits for the plan's approval, and so does merging a
 * worker's work (`worker_mark used`); a reader runs. A run's lead is held the same way
 * (`heldInPlan`, delegation.ts `#forwardDirectorTool`).
 */
import { errorMessage } from "../../shared/errors.ts";
import { DispatchActionType, type DispatchAction, HarnessCapability } from "../../shared/protocol.ts";
import {
  isWorkerIsolation,
  isWorkerTool,
  WorkerIsolation,
  WorkerTool,
  type WorkerType,
  WorkerVerdict,
} from "../../shared/workers.ts";
import type { LiveToolResult, LiveToolSpec } from "../../substrate/engines/types.ts";
import { WORKER_TOOL_ANSWER } from "./worker-tools-prompts.ts";

/** What forwarding a worker tool needs of the host: the harness, the chat's mode and the worker types on offer. */
export interface WorkerToolHost {
  hasCapability(capability: HarnessCapability): boolean;
  dispatch(action: DispatchAction, timeoutMs: number): Promise<unknown>;
  planning(threadId: string): Promise<boolean>;
  workerTypes(): WorkerType[];
}

/** One worker tool call of the chat's own session: its chat, the turn it answers, the tool and its arguments. */
export interface WorkerToolCall {
  threadId: string;
  turn: string;
  name: string;
  args: Record<string, unknown>;
}

/**
 * The worker tools a session is handed from the harness's grant: none unless it is honoured (the
 * chat's own session answering a turn, never a worker) and the harness serves workers; then only
 * the grant's tools that are worker tools, each once.
 */
export function offeredWorkerTools(asked: unknown, honoured: boolean, harnessServes: boolean): LiveToolSpec[] {
  const tools = (asked as { tools?: unknown } | null | undefined)?.tools;
  if (!honoured || !harnessServes || !Array.isArray(tools)) return [];
  const seen = new Set<string>();
  return tools.filter((tool): tool is LiveToolSpec => {
    const name = (tool as LiveToolSpec | null)?.name;
    if (!isWorkerTool(name) || seen.has(name)) return false;
    seen.add(name);
    return true;
  });
}

/** The worker type a start names: its `type`, or a journaled Unreal call's `kind`; null when it names none. */
function typeNamed(args: Record<string, unknown>): string | null {
  for (const field of [args.type, args.kind]) if (typeof field === "string" && field.trim()) return field.trim();
  return null;
}

/**
 * How a start stands in the project. A start that names a type stands as that type declares,
 * whatever isolation it asks for: a lead's typed worker may run in a copy of its own however the
 * call is worded, so only a type declared read-only reads, and a type the host does not know
 * writes. A start with no type stands as asked; null when it says nothing.
 */
function isolationOf(args: Record<string, unknown>, types: readonly WorkerType[]): WorkerIsolation | null {
  const named = typeNamed(args);
  if (named !== null) return types.find((known) => known.id === named)?.isolation ?? WorkerIsolation.Copy;
  return isWorkerIsolation(args.isolation) ? args.isolation : null;
}

/**
 * The run tools of a director that write beyond the worker tools: its merge of a worker's work, and
 * its finish, which lands the run's build in the game. The seed's names (`DirectorTool`), held to
 * them by `seed-contracts.test.ts`.
 */
export const RunWriteTool = {
  Integrate: "integrate",
  Finish: "finish",
} as const;

/** What a yes/no field says is yes, as the seed reads one (`director/args.ts` `yes`). */
const YES = /^(y|yes|true|1)$/i;

/** Whether a `finish` lands the build: unless its `land` says no; an empty one lands, as the seed's `yes(land, true)` reads it. */
export function finishLands(args: Record<string, unknown>): boolean {
  const land = args.land;
  if (land === undefined || land === null || String(land).trim() === "") return true;
  return YES.test(String(land).trim());
}

/**
 * What Plan holds of a worker tool call, or null: a start of a worker that would write (or might:
 * one that does not say), a verdict that merges a worker's work into the lead's folder, a director's
 * merge, or a finish that lands the run's build in the game.
 */
export function heldInPlan(
  name: string,
  args: Record<string, unknown>,
  types: () => readonly WorkerType[],
): string | null {
  if (name === WorkerTool.Mark)
    return args.verdict === WorkerVerdict.Used ? WORKER_TOOL_ANSWER.mergesWaitForPlan : null;
  if (name === RunWriteTool.Integrate) return WORKER_TOOL_ANSWER.mergesWaitForPlan;
  if (name === RunWriteTool.Finish) return finishLands(args) ? WORKER_TOOL_ANSWER.landingWaitsForPlan : null;
  if (name !== WorkerTool.Start || isolationOf(args, types()) === WorkerIsolation.Read) return null;
  return WORKER_TOOL_ANSWER.writersWaitForPlan;
}

/**
 * A worker tool call, answered by the harness's pool for its turn. In Plan a writer's start or a
 * merge is answered here and nothing is dispatched: no snapshot, no copy, no delegation, no merge.
 */
export async function forwardWorkerTool(
  host: WorkerToolHost,
  call: WorkerToolCall,
  timeoutMs: number,
): Promise<LiveToolResult> {
  if (!host.hasCapability(HarnessCapability.Workers)) return WORKER_TOOL_ANSWER.unavailable(call.name);
  const held = heldInPlan(call.name, call.args, () => host.workerTypes());
  if (held && (await host.planning(call.threadId))) return held;
  try {
    const value = await host.dispatch({ type: DispatchActionType.WorkerTool, ...call }, timeoutMs);
    return typeof value === "string" ? value : JSON.stringify(value ?? null);
  } catch (err) {
    return { text: WORKER_TOOL_ANSWER.failed(call.name, errorMessage(err)), isError: true };
  }
}
