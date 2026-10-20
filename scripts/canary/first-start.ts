// A person's first start, read from the app's own log (userData/logs/studio.log): whether the studio
// came up, how long its process took, and how long the sandbox start took inside it.
import { existsSync, readFileSync } from "node:fs";
import type { WaitClock } from "./links.ts";

/**
 * The lines main writes (src/main/index.ts): `studio ready at <ms> ms` once the studio is up,
 * `start: core:<mark> at <ms> ms` at each boot mark (core:games, then core:sandbox when the sandbox
 * has started), and the two failures a start does not come back from. "sandbox unavailable" is not
 * one: on a first start it is followed by the setup and a retry.
 */
const READY_LINE = /\[main\] studio ready at (\d+) ms/;
const MARK_LINE = /\[main\] start: core:(\w+) at (\d+) ms/g;
const FAILED_LINE = /\[main\] (startup failed|sandbox setup failed): ?(.*)/;
/**
 * The lines that say why a start has not come up while it waits on: the setup screen's problem
 * (`sandbox unavailable`) or a harness that will not boot (main and the core's own words).
 */
const PROBLEM_LINE =
  /\[(?:main|harness)\] (?:\[core\] )?(sandbox unavailable|harness would not start|the harness could not boot at startup): ?(.*)/g;
const GAMES_MARK = "games";
const SANDBOX_MARK = "sandbox";

/** What a log says about one start. */
export interface StartReading {
  /** The studio came up, after this many ms of its process. */
  readyMs: number | null;
  /** The last sandbox start: from the core's games mark to its sandbox mark. */
  sandboxMs: number | null;
  /** The failure line, when the start gave up. */
  failure: string | null;
  /** The last line saying why the studio has not come up yet, when there is one. */
  problem: string | null;
}

/** Read one start from the log text written since it began. */
export function readStart(log: string): StartReading {
  const ready = READY_LINE.exec(log);
  const failed = FAILED_LINE.exec(log);
  let gamesAt: number | null = null;
  let sandboxMs: number | null = null;
  for (const [, mark, at] of log.matchAll(MARK_LINE)) {
    if (mark === GAMES_MARK) gamesAt = Number(at);
    if (mark === SANDBOX_MARK && gamesAt !== null) sandboxMs = Number(at) - gamesAt;
  }
  const problems = [...log.matchAll(PROBLEM_LINE)].map(([, what, why]) => `${what}: ${why ?? ""}`.trim());
  return {
    readyMs: ready ? Number(ready[1]) : null,
    sandboxMs,
    failure: failed ? `${failed[1]}: ${failed[2] ?? ""}`.trim() : null,
    problem: problems.at(-1) ?? null,
  };
}

/** The log's text from `offset` on ("" while it does not exist). */
export function logSince(file: string, offset: number): string {
  return existsSync(file) ? readFileSync(file, "utf8").slice(offset) : "";
}

/** The log's current length, where a new start's lines will begin. */
export function logLength(file: string): number {
  return existsSync(file) ? readFileSync(file, "utf8").length : 0;
}

/** A finished wait: the reading, the wall time it took, and whether it ran out. */
export interface StartWait {
  reading: StartReading;
  wallMs: number;
  timedOut: boolean;
}

/** Wait for the start logged after `offset` in `file` to come up or give up, within `budgetMs`. */
export async function waitForStart(
  file: string,
  offset: number,
  budgetMs: number,
  clock: WaitClock,
  pollMs: number,
): Promise<StartWait> {
  const started = clock.now();
  for (;;) {
    const reading = readStart(logSince(file, offset));
    const wallMs = clock.now() - started;
    if (reading.readyMs !== null || reading.failure !== null) return { reading, wallMs, timedOut: false };
    if (wallMs >= budgetMs) return { reading, wallMs, timedOut: true };
    await clock.sleep(pollMs);
  }
}
