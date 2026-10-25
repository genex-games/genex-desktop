/**
 * The person's Plays, timed (lane PW): each Play opens a clock (`PlayTimings.start`) that its
 * stages mark as they end — the build copy, the person's window, the lane's wait and steps
 * (`PlayClock.sink`, handed to the build), the page's own boot stages, the first frame. The last
 * {@link PLAY_TIMINGS_KEPT} records stay readable (`recent`), and each is one Studio log line as it
 * ends, so a slow Play says which stage held it. A mark costs a clock read and an array push.
 */
import { randomUUID } from "node:crypto";
import type { BuildTarget } from "../../shared/game-project.ts";
import {
  type PlayMark,
  PlayStage,
  type PlayTiming,
  type PlayTimingSink,
  playTimingLine,
} from "../../shared/play-timing.ts";

/** How many finished Plays the diagnostics record keeps. */
export const PLAY_TIMINGS_KEPT = 20;

/** One Play's clock. */
export interface PlayClock {
  readonly id: string;
  /** A stage ended now; `ms` is its own length (default: since the previous mark). */
  mark(stage: PlayStage, options?: { ms?: number; detail?: string | null }): void;
  /** What a build lane calls with its own waits and steps. */
  readonly sink: PlayTimingSink;
  /** The Play reached its first frame (or failed): the record is logged and kept, and later marks are ignored. */
  end(stage: typeof PlayStage.FirstFrame | typeof PlayStage.Failed, detail?: string | null): void;
  /** The record as it stands. */
  timing(): PlayTiming;
}

/** What the recorder writes to and reads the time from. */
export interface PlayTimingsOptions {
  /** One line per finished Play, to the Studio log. */
  log?: (line: string) => void;
  now?: () => number;
}

/** The person's Plays: a clock per Play, and the last few records. */
export class PlayTimings {
  readonly #log: ((line: string) => void) | undefined;
  readonly #now: () => number;
  readonly #recent: PlayTiming[] = [];

  constructor(options: PlayTimingsOptions = {}) {
    this.#log = options.log;
    this.#now = options.now ?? Date.now;
  }

  /** The finished Plays, newest last. */
  recent(): PlayTiming[] {
    return this.#recent.map((timing) => ({ ...timing, marks: timing.marks.map((mark) => ({ ...mark })) }));
  }

  /** Opens a Play's clock: the click is now. */
  start(play: { project: string; target: BuildTarget; commit: string | null }): PlayClock {
    const startedAt = this.#now();
    const record: PlayTiming = { id: randomUUID(), ...play, startedAt, marks: [], totalMs: null };
    let last = startedAt;
    let ended = false;
    const push = (stage: PlayStage, ms: number | undefined, detail: string | null): void => {
      if (ended) return;
      const now = this.#now();
      const mark: PlayMark = { stage, at: now - startedAt, ms: Math.max(0, Math.round(ms ?? now - last)), detail };
      record.marks.push(mark);
      last = now;
    };
    push(PlayStage.Request, 0, null);
    return {
      id: record.id,
      mark: (stage, options = {}) => push(stage, options.ms, options.detail ?? null),
      sink: (stage, ms, detail) => push(stage, ms, detail ?? null),
      end: (stage, detail = null) => {
        if (ended) return;
        push(stage, undefined, detail);
        ended = true;
        record.totalMs = this.#now() - startedAt;
        this.#keep(record);
      },
      timing: () => ({ ...record, marks: record.marks.map((mark) => ({ ...mark })) }),
    };
  }

  #keep(record: PlayTiming): void {
    this.#recent.push(record);
    if (this.#recent.length > PLAY_TIMINGS_KEPT) this.#recent.shift();
    this.#log?.(`[play] ${playTimingLine(record)}`);
  }
}
