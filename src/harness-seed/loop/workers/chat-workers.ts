/**
 * Workers in a chat: the chat's own session, answering a turn on a delegated engine, is offered the
 * worker tools; the host forwards each call (`worker_tool`) to the pool of that turn. A pool opens
 * before the turn's session and closes when the turn ends, failure and Stop included: the workers
 * belong to the turn that started them. A call for a turn that is not the live one starts nothing.
 */
import type { AnyRecord, HarnessCtx } from "../../types/harness.d.ts";
import type { FactRef, FolderHolds } from "../folder-facts.ts";
import type { HookedGame } from "../hooks.ts";
import { isDelegated, modelOn, RoleKey, roleEngine, withRoles } from "../model-roles.ts";
import { carriedEnd, carryPool, landWorkers, WorkersEnd } from "./carry.ts";
import { POOL_WORDS } from "./prompts.ts";
import { openPool, type WorkerPool } from "./pool.ts";
import { isWorking, REAL_CLOCK, type PoolClock } from "./records.ts";
import { workerTools } from "./specs.ts";

/** Each chat's open pool, with the turn it serves. */
const pools = new Map<string, { turn: string; pool: WorkerPool }>();

/** What a chat turn offers its workers from: its thread, turn, engine and model, and its game. */
export interface ChatWorkersSeat {
  threadId: string;
  /** The message the turn answers (its steer handle's `messageId`). */
  turn: string;
  /** What the person asked in it: its workers' start records keep it. */
  ask?: string;
  engine: string;
  model?: string;
  effort?: string;
  /** A Loop's or Autopilot's commission the message carries: its Workers role picks their engine. */
  commission?: AnyRecord | null;
  project: string;
  gameDir: string;
  folderLabel: string;
  facts: readonly FactRef[];
  holds?: FolderHolds | null;
  /** The game as far as Genex's moments go: its workers' starts and ends are announced when its plugins hook them. */
  game?: HookedGame;
}

/** The workers' engine and model: the message's Workers role when it carries roles, else the chat's. */
function workersEngine(seat: ChatWorkersSeat): { engine: string; model?: string } {
  const roles = seat.commission?.roles;
  if (!roles) return { engine: seat.engine, ...(seat.model ? { model: seat.model } : {}) };
  const run = withRoles({ engine: seat.engine, model: seat.model, roles });
  const engine = roleEngine(run, RoleKey.Builder);
  const model = modelOn(run, engine);
  return { engine, ...(model ? { model } : {}) };
}

/** Open the pool of a chat turn; a pool the chat had open for another turn closes first. */
export async function openChatWorkers(
  ctx: HarnessCtx,
  seat: ChatWorkersSeat,
  clock: PoolClock = REAL_CLOCK,
): Promise<WorkerPool> {
  await pools.get(seat.threadId)?.pool.close();
  const { threadId, turn, project, gameDir, folderLabel, facts, holds } = seat;
  const pool = await openPool({
    ctx,
    project,
    threadId,
    turn,
    ...(seat.ask ? { ask: seat.ask } : {}),
    ...workersEngine(seat),
    ...(seat.effort ? { effort: seat.effort } : {}),
    gameDir,
    ...(seat.game ? { game: seat.game } : {}),
    leadFolder: { project },
    identity: { folderLabel, facts, holds: holds ?? null },
    clock,
  });
  pools.set(threadId, { turn, pool });
  return pool;
}

/** Close the pool of a chat turn (its workers stop; a copy's work is kept), if it is still the open one. */
export async function closeChatWorkers(threadId: string, turn: string): Promise<void> {
  const open = pools.get(threadId);
  if (!open || open.turn !== turn) return;
  pools.delete(threadId);
  await open.pool.close();
}

/**
 * The turn went on with a message's settings (turn-switch.ts): workers it starts from now on run on
 * them — the message's Workers role when it carries roles, else its engine, model and effort. Those
 * already at work keep their own.
 */
export function rescopeChatWorkers(
  threadId: string,
  turn: string,
  settings: Pick<ChatWorkersSeat, "engine" | "model" | "effort" | "commission">,
): void {
  const open = pools.get(threadId);
  if (!open || open.turn !== turn) return;
  const { scope } = open.pool.state;
  const { engine, model } = workersEngine({ ...settings, threadId, turn } as ChatWorkersSeat);
  open.pool.state.scope = { ...scope, engine, model, effort: settings.effort };
}

/** How many workers the chat's open pool for this turn has still at work (running, or waiting on the person). */
export function runningChatWorkers(threadId: string, turn: string): number {
  const open = pools.get(threadId);
  if (!open || open.turn !== turn) return 0;
  return open.pool.state.records.filter(isWorking).length;
}

/**
 * Would a Loop in the game folder take this turn's workers over as they are now (carry.ts
 * `carriedEnd`)? Not while one of them writes in the game folder itself: the launch lets it finish.
 */
export function chatWorkersCarry(threadId: string, turn: string): boolean {
  const open = pools.get(threadId);
  if (!open || open.turn !== turn) return false;
  return carriedEnd(open.pool) === WorkersEnd.Carry;
}

/** The worker grant a chat turn's delegation carries: the six tools, while its pool is open. */
export function chatWorkersGrant(threadId: string, turn: string | undefined): AnyRecord {
  const open = pools.get(threadId);
  if (!open || !turn || open.turn !== turn) return {};
  return { workers: { tools: workerTools(open.pool.state.types, open.pool.state.allowed) } };
}

/** The host forwarded a worker tool call of a chat turn: the pool of that turn answers, never another's. */
export async function chatWorkerTool(action: {
  threadId: unknown;
  turn: unknown;
  name: unknown;
  args: unknown;
}): Promise<string> {
  const open = pools.get(String(action.threadId ?? ""));
  if (!open || open.turn !== action.turn) return POOL_WORDS.noWorkersForTurn;
  const args = action.args && typeof action.args === "object" ? (action.args as AnyRecord) : {};
  return open.pool.call(String(action.name ?? ""), args);
}

/**
 * Run a chat turn with its workers: the pool opens first (a pool that cannot open leaves the turn
 * without workers) and closes when `work` ends, however it ends — unless `endOf` says the turn
 * launched a Loop (the person switched it on while the workers worked): a Loop in the game folder
 * then takes them over, and any other lets them finish first (carry.ts). No seat, or a chat on an
 * engine that carries no worker's seat (a local model's session): `work` alone, offered no worker tools.
 */
export async function withChatWorkers<T>(
  ctx: HarnessCtx,
  seat: ChatWorkersSeat | null,
  work: () => Promise<T>,
  endOf: (result: T) => WorkersEnd = () => WorkersEnd.Stop,
  clock: PoolClock = REAL_CLOCK,
): Promise<T> {
  if (!seat || !isDelegated(seat.engine)) return work();
  const opened = await openChatWorkers(ctx, seat, clock).catch(() => null);
  let end: WorkersEnd = WorkersEnd.Stop;
  try {
    const result = await work();
    end = ctx.cancelled ? WorkersEnd.Stop : endOf(result);
    return result;
  } finally {
    if (opened) await endChatWorkers(ctx, seat, end).catch(() => {});
  }
}

/** The turn's pool as the turn ends: carried into its build, its workers left to finish, or closed. */
async function endChatWorkers(ctx: HarnessCtx, seat: ChatWorkersSeat, asked: WorkersEnd): Promise<void> {
  const open = pools.get(seat.threadId);
  if (!open || open.turn !== seat.turn) return;
  const working = open.pool.state.records.some(isWorking);
  const end = asked === WorkersEnd.Carry && working ? carriedEnd(open.pool) : asked;
  if (end === WorkersEnd.Stop || !working) return closeChatWorkers(seat.threadId, seat.turn);
  pools.delete(seat.threadId);
  if (end === WorkersEnd.Carry) return carryPool(seat.threadId, seat.turn, open.pool);
  await landWorkers(open.pool, ctx);
}
