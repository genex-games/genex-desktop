/**
 * The queue in front of play-time AI's doors. Build work comes first: a game's call on this Mac's
 * model or on the person's plan waits while a build runs (the build shares the GPU or the plan),
 * and is refused with a wait when the build outlasts it, so the game plays its fallback instead of
 * hanging. Each door runs at most its own number of calls at once (the plan and this Mac's model one
 * at a time); waiters are served in arrival order; a call whose signal aborts (Stop, a page that
 * navigated) leaves the line with no slot taken. A game's call never preempts a build.
 */
import { SECOND_MS } from "../../shared/duration.ts";
import { AiDoor, AiErrorCode, type AiGameKey } from "../../shared/game-ai.ts";
import type { AiSlotResult, GameAiQueue } from "./types.ts";

/** Calls at once, per door: one for this Mac's model, OpenCode's CLI and the plan; more for doors that only wait on a network. */
export const DOOR_CONCURRENCY = {
  [AiDoor.Local]: 1,
  [AiDoor.OpenCode]: 1,
  [AiDoor.Byok]: 4,
  [AiDoor.Plan]: 1,
  [AiDoor.PlanWatcher]: 1,
  [AiDoor.GenexCredits]: 4,
  [AiDoor.GenexDev]: 4,
  [AiDoor.Tape]: 8,
  [AiDoor.Fixture]: 8,
} as const satisfies Record<AiDoor, number>;

/** The doors a running build holds: they share this Mac's GPU or the builder's plan. */
const YIELDS_TO_BUILDS: ReadonlySet<AiDoor> = new Set([AiDoor.Local, AiDoor.Plan, AiDoor.OpenCode]);

/** How long a call waits for a running build before it is refused. */
const BUILD_WAIT_MS = 10 * SECOND_MS;
/** How long a refused call is told to wait before it asks again while a build runs. */
const BUILD_RETRY_MS = 30 * SECOND_MS;
/** How long a call waits for a busy door's slot. */
const SLOT_WAIT_MS = 30 * SECOND_MS;
/** The most calls one door's line holds; a call past it is refused at once. */
const MAX_WAITING = 16;

/** The queue's waits, injectable so a test holds them short. */
export interface GameAiQueueOptions {
  buildWaitMs?: number;
  buildRetryMs?: number;
  slotWaitMs?: number;
  maxWaiting?: number;
}

/** One call waiting for its door. */
interface Waiter {
  game: AiGameKey;
  grant(): void;
}

/** One door's line: calls running and calls waiting, in order. */
interface DoorLine {
  running: number;
  waiting: Waiter[];
}

/** A new queue; one per profile. */
export function createGameAiQueue(options: GameAiQueueOptions = {}): GameAiQueue {
  return new DoorQueue(options);
}

/** The queue, one line per door. */
class DoorQueue implements GameAiQueue {
  readonly #waits: Required<GameAiQueueOptions>;
  readonly #lines = new Map<AiDoor, DoorLine>();
  /** Builds running now; overlapping builds each end once. */
  #builds = 0;

  constructor(options: GameAiQueueOptions) {
    this.#waits = {
      buildWaitMs: options.buildWaitMs ?? BUILD_WAIT_MS,
      buildRetryMs: options.buildRetryMs ?? BUILD_RETRY_MS,
      slotWaitMs: options.slotWaitMs ?? SLOT_WAIT_MS,
      maxWaiting: options.maxWaiting ?? MAX_WAITING,
    };
  }

  building(on: boolean): void {
    this.#builds = Math.max(0, this.#builds + (on ? 1 : -1));
    if (this.#builds === 0) for (const door of this.#lines.keys()) this.#pump(door);
  }

  acquire(door: AiDoor, game: AiGameKey, signal: AbortSignal): Promise<AiSlotResult> {
    if (signal.aborted) return Promise.resolve(refusal(AiErrorCode.Canceled, null));
    const line = this.#line(door);
    if (this.#free(door, line)) return Promise.resolve(this.#take(door, line));
    if (line.waiting.length >= this.#waits.maxWaiting) return Promise.resolve(refusal(AiErrorCode.Concurrency, null));
    return this.#wait(door, game, line, signal);
  }

  /** Wait in line until a slot frees, the build outlasts the wait, or the signal aborts. */
  #wait(door: AiDoor, game: AiGameKey, line: DoorLine, signal: AbortSignal): Promise<AiSlotResult> {
    return new Promise<AiSlotResult>((resolve) => {
      const leave = (result: AiSlotResult) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        line.waiting = line.waiting.filter((entry) => entry !== waiter);
        resolve(result);
      };
      const waiter: Waiter = { game, grant: () => leave(this.#take(door, line)) };
      const onAbort = () => leave(refusal(AiErrorCode.Canceled, null));
      const held = this.#heldByBuild(door);
      const timer = setTimeout(
        () => leave(this.#heldByBuild(door) ? refusal(AiErrorCode.DoorUnavailable, this.#waits.buildRetryMs) : busy()),
        held ? this.#waits.buildWaitMs : this.#waits.slotWaitMs,
      );
      signal.addEventListener("abort", onAbort, { once: true });
      line.waiting.push(waiter);
    });
  }

  #line(door: AiDoor): DoorLine {
    let line = this.#lines.get(door);
    if (!line) {
      line = { running: 0, waiting: [] };
      this.#lines.set(door, line);
    }
    return line;
  }

  #heldByBuild(door: AiDoor): boolean {
    return this.#builds > 0 && YIELDS_TO_BUILDS.has(door);
  }

  /** A slot is free for a newcomer: nobody waits ahead, no build holds the door, and it has room. */
  #free(door: AiDoor, line: DoorLine): boolean {
    return line.waiting.length === 0 && !this.#heldByBuild(door) && line.running < DOOR_CONCURRENCY[door];
  }

  /** Take a slot; its release frees it once and lets the next waiter in. */
  #take(door: AiDoor, line: DoorLine): AiSlotResult {
    line.running += 1;
    let held = true;
    return {
      ok: true,
      release: () => {
        if (!held) return;
        held = false;
        line.running -= 1;
        this.#pump(door);
      },
    };
  }

  /** Let waiters in, in order, while the door has room and no build holds it. */
  #pump(door: AiDoor): void {
    const line = this.#line(door);
    while (!this.#heldByBuild(door) && line.running < DOOR_CONCURRENCY[door]) {
      const next = line.waiting[0];
      if (!next) return;
      next.grant();
    }
  }
}

const refusal = (code: AiErrorCode, retryAfterMs: number | null): AiSlotResult => ({ ok: false, code, retryAfterMs });

/** A door still busy past the wait: the game may ask again shortly. */
const busy = (): AiSlotResult => refusal(AiErrorCode.Concurrency, null);
