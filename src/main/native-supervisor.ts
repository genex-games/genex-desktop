/**
 * The native supervisor's utility-process entry (`resources/native/supervisor.cjs` once built): it
 * refuses to run outside a utility process, then hands `process.parentPort`'s messages to
 * `superviseNativeRuns`, with the real parent pid, `ps`, group kill and clock. Nothing imports it;
 * the build bundles it, and it starts itself only where a parent port exists.
 */
import type { NativeTimers } from "../shared/native-contract.ts";
import { type NativeSupervisorMessage, processStartedAt, superviseNativeRuns } from "./native-supervisor-logic.ts";

const MESSAGE = {
  noParent: "the native supervisor runs only as a utility process (no parent port)",
} as const;

/** The part of `process.parentPort` the entry listens on. */
export interface NativeSupervisorParent {
  on(event: "message", listener: (event: { data: NativeSupervisorMessage }) => void): unknown;
}

const isTimeout = (handle: unknown): handle is NodeJS.Timeout => typeof handle === "object" && handle !== null;

/** The real clock. */
const TIMERS: NativeTimers = {
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => {
    if (isTimeout(handle)) clearTimeout(handle);
  },
};

/** Runs the supervisor on `parent` (`process.parentPort`); throws without one. */
export function runNativeSupervisor(parent: NativeSupervisorParent | undefined): void {
  if (!parent) throw new Error(MESSAGE.noParent);
  const handle = superviseNativeRuns({
    ppid: () => process.ppid,
    startedAt: processStartedAt,
    kill: (pgid, signal) => process.kill(-pgid, signal),
    timers: TIMERS,
    exit: () => process.exit(0),
  });
  parent.on("message", (event) => handle(event.data));
}

/** Whether `port` is a parent port the entry can listen on. */
function isParent(port: unknown): port is NativeSupervisorParent {
  return typeof port === "object" && port !== null && "on" in port && typeof port.on === "function";
}

// Started only where Electron gives this process a parent port (the utility process); a test that
// imports the module starts nothing.
const parent: unknown = Reflect.get(process, "parentPort");
if (isParent(parent)) runNativeSupervisor(parent);
