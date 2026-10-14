/**
 * The native supervisor's rules, kept free of Electron: a utility process the app forks beside its
 * terminals, told each native game's process group and start time, which kills every registered
 * group as soon as its parent (the app) is gone, so no game outlives a crashed or force-quit app.
 * A group is killed only while its leader's start time is still the registered one: a pid the
 * system has since given to another process is never signalled. The registry talks to it through
 * {@link nativeSupervisorClient}; `native-supervisor.ts` is the utility entry that runs
 * {@link superviseNativeRuns}.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SECOND_MS } from "../shared/duration.ts";
import type { NativeTimers } from "../shared/native-contract.ts";
import type { NativeSupervisorClient } from "./core/native-runs.ts";

const run = promisify(execFile);

/** How often the supervisor checks that its parent is still the app. */
export const OWNER_POLL_MS = 2 * SECOND_MS;
/** How long one `ps` may take. */
const PS_TIMEOUT_MS = 5 * SECOND_MS;
/** A run id as the registry makes one: 12 hex. */
const RUN_ID = /^[0-9a-f]{12}$/;
/** The longest start time `ps` prints is far shorter. */
const LSTART_MAX_CHARS = 64;

/** A message the app sends the supervisor: register a run's group, or forget a run that ended. */
export type NativeSupervisorMessage =
  | { register: { runId: string; pgid: number; lstart: string } }
  | { forget: string };

/** The part of a forked utility process the client posts to (`UtilityProcess` is one). */
export interface NativeSupervisorPort {
  postMessage(message: NativeSupervisorMessage): void;
}

/**
 * The registry's client over the supervisor, one message per call. The supervisor is forked
 * (`fork`) at the first run it registers, once: a utility process forked before the app is ready
 * ends the app, and a person who never plays a native game never needs one. A forget before any
 * run has nothing to tell.
 */
export function lazyNativeSupervisorClient(fork: () => NativeSupervisorPort): NativeSupervisorClient {
  let port: NativeSupervisorPort | null = null;
  return {
    register: (run) => {
      port ??= fork();
      port.postMessage({ register: run });
    },
    forget: (runId) => port?.postMessage({ forget: runId }),
  };
}

/** A pid's start time as `ps -o lstart=` prints it, or null when it is gone (the registry's and the supervisor's check). */
export async function processStartedAt(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const listed = await run("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { timeout: PS_TIMEOUT_MS }).catch(
    () => null,
  );
  const text = listed?.stdout.trim() ?? "";
  return text || null;
}

/** What the supervisor reaches, injected. */
export interface NativeSupervisorDeps {
  /** The supervisor's parent pid now (1 once the app is gone). */
  ppid(): number;
  /** A pid's start time (`ps -o lstart=`), or null when it is gone. */
  startedAt(pid: number): Promise<string | null>;
  /** Signals the process group `pgid`. */
  kill(pgid: number, signal: NodeJS.Signals): void;
  timers: NativeTimers;
  /** The supervisor is done: its parent is gone and every group it knew is dealt with. */
  exit(): void;
}

/** One registered run, as the app named it. */
interface Registered {
  pgid: number;
  lstart: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A `register` message's run, or null when it is not one. */
function registered(message: Record<string, unknown>): ({ runId: string } & Registered) | null {
  const body = message.register;
  if (!isRecord(body)) return null;
  const { runId, pgid, lstart } = body;
  const validId = typeof runId === "string" && RUN_ID.test(runId);
  const validGroup = typeof pgid === "number" && Number.isSafeInteger(pgid) && pgid > 1;
  const validStart = typeof lstart === "string" && lstart.length > 0 && lstart.length <= LSTART_MAX_CHARS;
  return validId && validGroup && validStart ? { runId, pgid, lstart } : null;
}

/** Kills each group whose leader still started when it was registered. */
async function killRegistered(deps: NativeSupervisorDeps, runs: ReadonlyMap<string, Registered>): Promise<void> {
  for (const { pgid, lstart } of runs.values()) {
    const now = await deps.startedAt(pgid).catch(() => null);
    if (now !== lstart) continue;
    try {
      deps.kill(pgid, "SIGKILL");
    } catch {
      // Gone between the check and the kill: nothing is left to end.
    }
  }
}

/** Watches the parent and kills every registered group once it is gone; returns the message handler. */
export function superviseNativeRuns(deps: NativeSupervisorDeps): (message: NativeSupervisorMessage) => void {
  const parent = deps.ppid();
  const runs = new Map<string, Registered>();
  let orphaned = false;
  const poll = () => {
    if (deps.ppid() === parent) {
      deps.timers.setTimeout(poll, OWNER_POLL_MS);
      return;
    }
    orphaned = true;
    void killRegistered(deps, runs).finally(() => deps.exit());
  };
  deps.timers.setTimeout(poll, OWNER_POLL_MS);
  // Messages are checked as they come: a malformed one registers or forgets nothing.
  const handle = (message: unknown): void => {
    if (orphaned || !isRecord(message)) return;
    const run = registered(message);
    if (run) runs.set(run.runId, { pgid: run.pgid, lstart: run.lstart });
    if (typeof message.forget === "string") runs.delete(message.forget);
  };
  return handle;
}
