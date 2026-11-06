/**
 * The run's writers in place: its pool's workers with isolation lock, which write in the game folder
 * beside the lead (a worker in a copy or a reader writes nothing there). A claim waits for one, the
 * lead's rewind or restart waits for it to end, and no autosave keeps its half-done files.
 */
import { WorkerIsolation, WorkerTool } from "../../workers/contract.ts";
import { runningRecords, type WorkerRecord } from "../../workers/records.ts";
import type { OpenLoop } from "./contract.ts";

/** The run's writers in place at work now: its pool's workers that write in the game folder under its lock. */
export function writersInPlace(open: OpenLoop): WorkerRecord[] {
  if (!open.pool) return [];
  return runningRecords(open.pool.state).filter((record) => record.isolation === WorkerIsolation.Lock);
}

/**
 * Stops the run's writers in place (`worker_stop`, the reason on each one's end record) and answers
 * the ids of those it stopped. Kept for a `health.ts` an agent kept from before, whose way back to a
 * save point stopped them first: the seed never takes the folder back by itself.
 */
export async function stopWritersInPlace(open: OpenLoop, why: string): Promise<string[]> {
  const ids = writersInPlace(open).map((record) => record.id);
  for (const id of ids) await open.pool?.call(WorkerTool.Stop, { id, why }).catch(() => "");
  return ids;
}
