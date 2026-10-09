/**
 * Who lays a game's foundation when the project is empty: the studio's starting scene, or the lead
 * itself. A lead that splits the game into modules throws a starting scene away, so a run with room
 * for a team starts with the lead laying interfaces and crude stubs and handing the content to its
 * owners (setup.ts `buildStartingPoint`); a short run or a pool of one still gets a starting scene.
 *
 * Pure, and a new module: a kept older budgets.ts never shadows these names.
 */
import { MINUTE_MS } from "../time.ts";
import { MAX_WORKERS, workerWindows } from "./budgets.ts";

/**
 * A run lays its own foundation, with no starting scene, only with this much working time left and
 * room for this many loop workers at once.
 */
const FOUNDATION_RUN_MIN_MS = 60 * MINUTE_MS;
const FOUNDATION_MIN_WORKERS = 2;

/** The pool as the studio reports it (`preview.capacity`): its windows, and whether they are hidden. */
export interface PoolCapacity {
  max?: number;
  headless?: boolean;
}

/**
 * How many workers may run at once on this pool: one when its windows are visible (not headless),
 * else the windows left once the director has its own, never more than `MAX_WORKERS`; 0 when
 * nobody knows the pool.
 */
export function workersAtOnce(capacity: PoolCapacity | null | undefined): number {
  if (!capacity?.max) return 0;
  if (capacity.headless === false) return 1;
  return Math.min(MAX_WORKERS, workerWindows(capacity.max));
}

/**
 * Will this run's lead lay the foundation itself — the module contract, the vision and crude
 * playable stubs — before two or more loop workers start? Only with an hour of working time and
 * room for a team; then the studio builds no starting scene first.
 */
export function foundationFirst({
  remainingMs,
  capacity,
}: {
  remainingMs: number;
  capacity: PoolCapacity | null | undefined;
}): boolean {
  return remainingMs >= FOUNDATION_RUN_MIN_MS && workersAtOnce(capacity) >= FOUNDATION_MIN_WORKERS;
}
