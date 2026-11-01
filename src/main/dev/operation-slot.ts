/**
 * The developer control channel's one slot for an operation on the app. An operation that acts on
 * the window or the game holds it while it runs, so two never interleave. The operations that
 * answer in any state of the launch (status, runs, stop: `answersInAnyState`) never wait for it,
 * and an operation past its deadline is answered as timed out and gives the slot back: a page
 * that never answers (a game whose start-up never ends) must not leave the session impossible to
 * inspect, drive or stop. Pure, with injectable timers, so it is tested without Electron.
 */
import { answersInAnyState, DevError, DevErrorCode, type DevMethod } from "./protocol.ts";

/** Timers, injectable so a test decides when a deadline passes. */
export interface SlotTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
const realTimers: SlotTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** The channel's slot: whether an operation holds it, and how one runs in it. */
export interface OperationSlot {
  busy(): boolean;
  /**
   * Run `work` for `method`, in the slot unless the method answers in any state. `timedOut` is
   * heard once if it is still running after the slot's deadline; the slot is free from then on,
   * and the late end of `work` never frees a slot a newer operation holds.
   */
  run<T>(method: DevMethod, work: () => Promise<T>, timedOut: () => void): Promise<T>;
}

/** A slot whose operations each have `timeoutMs` before they are answered as timed out. */
export function operationSlot(timeoutMs: number, timers: SlotTimers = realTimers): OperationSlot {
  let holder: object | null = null;
  return {
    busy: () => holder !== null,
    async run(method, work, timedOut) {
      const inSlot = !answersInAnyState(method);
      if (inSlot && holder) throw new DevError(DevErrorCode.Busy, "an operation is still executing");
      const mine = {};
      if (inSlot) holder = mine;
      const release = (): void => {
        if (holder === mine) holder = null;
      };
      const deadline = timers.setTimeout(() => {
        release();
        timedOut();
      }, timeoutMs);
      try {
        return await work();
      } finally {
        timers.clearTimeout(deadline);
        release();
      }
    },
  };
}
