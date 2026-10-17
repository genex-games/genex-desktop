/**
 * A run's own worker pool: the generic workers a run's lead starts beside the workers of its own
 * method (the director's builders, the Unreal lead's typed workers). It opens on the first start,
 * keeps its records in the run's own artifact and its copies' work on the run's refs, answers the
 * worker tools for the ids it holds, and closes with the run. Its workers belong to the run: their
 * delegations carry `worker {id, title, runId}`, so the host seats them in the mode of the chat the
 * run was started in.
 */
import type { AnyRecord } from "../../types/harness.d.ts";
import { openPool, type WorkerPool } from "./pool.ts";
import { recordOf, runWorkersArtifact, type WorkerScope } from "./records.ts";

/** Each run's open pool, by run id (a promise while it opens, so two starts at once share one). */
const pools = new Map<string, Promise<WorkerPool>>();

/** What a run's pool is opened with: everything a pool's scope holds but its artifact, which is the run's. */
export type RunPoolSeat = Omit<WorkerScope, "artifactId" | "runId" | "turn"> & { runId: string };

/** The run's pool, opened on first use. */
export function runPool(seat: RunPoolSeat): Promise<WorkerPool> {
  const open = pools.get(seat.runId);
  if (open) return open;
  const opening = openPool({ ...seat, artifactId: runWorkersArtifact(seat.runId) });
  pools.set(seat.runId, opening);
  opening.catch(() => pools.delete(seat.runId));
  return opening;
}

/** The run's pool when it is already open, else null: a call for one of its workers opens nothing. */
export async function openRunPool(runId: string): Promise<WorkerPool | null> {
  const open = pools.get(runId);
  return open ? open.catch(() => null) : null;
}

/** Whether the run's open pool holds a worker of this id. */
export async function holdsWorker(runId: string, id: unknown): Promise<boolean> {
  const pool = await openRunPool(runId);
  return Boolean(pool && recordOf(pool.state, id));
}

/** A worker tool call for one of the run pool's workers, answered by it; null when the id is not one of them. */
export async function runPoolCall(runId: string, name: string, args: AnyRecord): Promise<string | null> {
  const pool = await openRunPool(runId);
  const id = args.id ?? args.worker;
  if (!pool || !recordOf(pool.state, id)) return null;
  return pool.call(name, { ...args, id });
}

/** Every line of the run pool's workers, or "" when it holds none. */
export async function runPoolStatus(runId: string, call: (pool: WorkerPool) => Promise<string>): Promise<string> {
  const pool = await openRunPool(runId);
  return pool?.state.records.length ? call(pool) : "";
}

/** The run ended: its pool closes (running workers stop, a copy's work is kept on the run's refs). */
export async function closeRunPool(runId: string): Promise<void> {
  const open = pools.get(runId);
  if (!open) return;
  pools.delete(runId);
  const pool = await open.catch(() => null);
  await pool?.close();
}
