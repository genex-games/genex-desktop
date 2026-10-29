/**
 * A `worker_wait` inside the open lead's capped turn ends before the turn must: a wait the turn's cap
 * cut short gave the lead no answer of its own, and its continuation re-sent the session's guidance.
 * The wait returns `WAIT_ENDS_BEFORE_TURN_MS` before the turn's end, and the lead is told how long
 * is left once it returns. A module of its own, so the shipped tools need no new name from a module
 * an agent may have kept.
 */
import type { AnyRecord } from "../../../types/harness.d.ts";
import { minutes, SECOND_MS } from "../../time.ts";
import { MAX_WORKER_WAIT_S } from "../../workers/contract.ts";
import type { LoopRun } from "../loop-run.ts";
import { turnEndsOf } from "../turn-ends.ts";
import { turnEndingWords } from "./evidence-prompts.ts";

/** A wait returns this long before the lead's turn must end, leaving the lead time to end it itself. */
const WAIT_ENDS_BEFORE_TURN_MS = 90 * SECOND_MS;
/** `worker_wait`'s seconds when the lead names none (the pool's own default). */
const DEFAULT_WAIT_S = 60;

/**
 * A wait's arguments fitted into the turn: shortened (at least 1 s) to return before the turn's end,
 * with that end (`endsBy`) to tell the lead of once it returns; or left as asked (`endsBy` null) when
 * the wait, as long as the pool lets it run (`MAX_WORKER_WAIT_S`), fits or no turn end is known.
 */
export function waitWithinTurn(
  loopRun: LoopRun,
  args: AnyRecord,
  now: number,
): { args: AnyRecord; endsBy: number | null } {
  const ends = turnEndsOf(loopRun.state);
  if (!ends) return { args, endsBy: null };
  const room = Math.floor((ends.endsBy - WAIT_ENDS_BEFORE_TURN_MS - now) / SECOND_MS);
  const asked = Number(args.seconds ?? DEFAULT_WAIT_S);
  const seconds = Math.min(MAX_WORKER_WAIT_S, Number.isFinite(asked) ? asked : DEFAULT_WAIT_S);
  if (seconds <= room) return { args, endsBy: null };
  return { args: { ...args, seconds: Math.max(1, room) }, endsBy: ends.endsBy };
}

/** What the lead reads beside a wait the turn's end shortened, as it returns at `now`. */
export const turnRoomNote = (endsBy: number, now: number): string => turnEndingWords(minutes(endsBy - now));
