/**
 * What the loop's dispatch keeps between actions (main.ts `createStudio`), shared with the modules
 * that do the work: the chat turn (chat-dispatch.ts), the run (run-dispatch.ts) and the boot
 * notice (boot-notice.ts).
 */
import type { HarnessCtx, Host, Run } from "../types/harness.d.ts";
import type { RunSpec } from "../types/host-api.d.ts";

/** Which status line a unit of work paints: the chat's own reply, or the run under way on it. */
export const StatusLane = {
  Chat: "chat",
  Run: "run",
} as const;
export type StatusLane = (typeof StatusLane)[keyof typeof StatusLane];

/**
 * Which loop conducts a run. Never persisted: a spec names only the unattended one (`mode:
 * "autopilot"`, the persisted `RunMode` in run-events.ts), and `chooseRunner` decides whether the
 * director or the classic pipeline conducts it.
 */
export const RunnerKind = {
  Director: "director",
  Autopilot: "autopilot",
  Gauntlet: "gauntlet",
  /** A game built live in the user's Unreal editor by one lead (`loop/unreal/lead.ts`). */
  Unreal: "unreal",
} as const;
export type RunnerKind = (typeof RunnerKind)[keyof typeof RunnerKind];

/**
 * A run this loop is conducting (or reserving), and the promise that settles when it is over —
 * its self-improvement pass included. `closed` settles, and `done` is set, as soon as the run
 * itself is over, before that pass: the chat is free from then on (live-chat.ts). A run-dispatch.ts
 * kept from before live chat sets neither, and the chat waits for `settled` as it did. `stopped` is
 * the run's own Stop (live-chat.ts `stopRun`), which its pass keeps whatever the chat does next.
 */
export interface ActiveRun {
  run: Run;
  threadId: string;
  settled: Promise<unknown>;
  closed?: Promise<unknown>;
  done?: boolean;
  stopped?: boolean;
}

/** A finished build reopened: the reopened run hears what was said after `after` (reopen-run.ts). */
export interface RunReopen {
  after: string | null;
}

/** A run to start: from the interview, the run IPC, a resumed journal, or a finished build reopened (`reopen`). */
export type RunStart = {
  type: "run_start";
  threadId: string;
  run: RunSpec | Run;
  resume?: boolean;
  reopen?: RunReopen;
};

/** The loop's own state, and the scoped ctx every unit of work runs with. */
export interface Studio {
  host: Host;
  /** Threads whose current work the user stopped. A fresh message in a thread clears its flag. */
  cancels: Set<string>;
  /**
   * Messages a Stop was pressed for before their turn began (still sending, or waiting at the
   * front): their turn keeps the Stop instead of clearing it. Absent from an older main.ts.
   */
  stoppedMessages?: Set<string>;
  // Mood boards outlive their message: the composer clears the chips the moment they are sent,
  // but the interview spans several messages — the board rides along until a run launches.
  moodBoards: Map<string, unknown[]>;
  /** runId → { run, threadId }, kept through the post-run self-improvement so Stop still lands. */
  activeRuns: Map<string, ActiveRun>;
  startingRuns: Map<string, ActiveRun>;
  /**
   * runId → project for the runs the *previous* incarnation of this loop was running when it
   * died (the host names them in the boot notice). Their builders may still be alive in the
   * host — a contractor does not always die on the first signal — and the project they were
   * hired for is the only address a Stop pressed afterwards can still reach them at.
   */
  orphanRuns: Map<string, string>;
  /** Each unit of work gets a ctx scoped to its thread: its own status line, its own stop flag. */
  scoped(threadId: string, lane?: StatusLane): HarnessCtx;
}

/** Every run this loop holds: the ones under way, then the ones still being reserved. */
export function heldRuns(studio: Studio): ActiveRun[] {
  return [...studio.activeRuns.values(), ...studio.startingRuns.values()];
}
