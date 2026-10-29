/**
 * The native run registry: every C++ · raylib game the studio started, by run id — the person's Play
 * window, agents' headless runs and embedded ones — with how each one is stopped (`quit`, then
 * SIGTERM to its group, then SIGKILL to the group and every listed descendant, reaped within
 * `NATIVE_STOP_BUDGET_MS`), never paused. It announces each change as `UiEvent.NativeStatus`, the
 * game's stderr as `UiEvent.NativeLog`, keeps a pidfile per run so the next boot sweeps an orphan
 * (pid and start time must both match), and samples each game's memory: on a Mac its
 * `phys_footprint`, on Linux the private memory of bubblewrap and every process below it
 * (`linuxTreeMemory`). The run's status keeps the peak (`NativeRunMemory`): past
 * `NATIVE_GAME_MEMORY_BUDGET_BYTES` the game keeps running and is marked over budget; past the host's
 * cap (`nativeGameMemoryCapBytes` of its physical memory) it is killed `memory-cap`. On Windows the
 * launcher's Job Object holds the same cap.
 * Every timer goes through `NativeTimers`. On Windows the run's child is the game launcher, whose
 * kill-on-close Job Object holds the game: a stop ends it through that one handle (fd 3 closed,
 * then the launcher ended), never a process group, and lists no descendants.
 *
 * An embedded run (Live's Native view) is a headless build whose frames reach the studio window
 * through `main/native-frames.ts`: its frames channel opens before the spawn (the game profile
 * names the channel's service), takes the game's pid right after it, gets a ring of the size Live
 * asked for once the game is ready (`surface`, a new generation per debounced resize), rests while
 * Live hides it, stops sending the moment a stop begins, and closes after the game is gone. A
 * contract v2 (Rust · wgpu) game that restores a lost GPU device gets a new ring generation at once.
 *
 * A game the port ends (a missed step or capture deadline taken for a GPU hang, a protocol
 * violation, the memory cap) has its descendants killed with its group, and the run ends killed
 * with that refusal within `NATIVE_REAP_MARGIN_MS` even when the kernel is slow to reap it. Each
 * capture's provenance carries the run id and the build `prepare` admitted.
 *
 * A run that ends crashed (the game's own `crash` record, a kill for a missed call deadline, or an
 * abnormal exit) names its record in its last status, and the record goes to the crash store
 * (`core/game-crashes.ts`) before the run dir is removed.
 */
import { PlayStage, type PlayTimingSink } from "../../shared/play-timing.ts";
import type { PlayClock, PlayTimings } from "./play-timings.ts";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants as FS } from "node:fs";
import { lstat, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { StudioPlatform } from "../../shared/boot.ts";
import type { BuildIdentity } from "../../shared/build-preview.ts";
import type { BuildProblem } from "../../shared/build-problem.ts";
import { SECOND_MS } from "../../shared/duration.ts";
import type { CrashRecordV1 } from "../../shared/crash-record.ts";
import { errorMessage } from "../../shared/errors.ts";
import { type BuildTarget, isCompiledStack } from "../../shared/game-project.ts";
import type { ToolchainLock } from "../../shared/toolchain.ts";
import {
  type GameBoxProblem,
  NATIVE_GAME_MEMORY_BUDGET_BYTES,
  NATIVE_HEARTBEAT_MS,
  NATIVE_LOG_BATCH_MAX,
  NATIVE_QUIT_GRACE_MS,
  NATIVE_REAP_MARGIN_MS,
  NATIVE_RESIZE_DEBOUNCE_MS,
  NATIVE_TERM_GRACE_MS,
  NativeError,
  NativeEvent,
  type NativeEventMessage,
  type NativeInputAction,
  NativeOp,
  NativeOpError,
  NativeRefusal,
  NativeRunMode,
  type NativeRunMemory,
  NativeRunState,
  type NativeRunStatus,
  type NativeTimers,
  nativeGameMemoryCapBytes,
  parseNativeInput,
} from "../../shared/native-contract.ts";
import { UiEvent, uiEvent } from "../../shared/ui-events.ts";
import { openNoFollow, readRegularFile } from "../../substrate/fsx.ts";
import { type AdmittedOutputFile, removeRunDir } from "../../substrate/native-bundle.ts";
import {
  type NativeGamePort,
  NativeExitError,
  NativeOpRefusedError,
  type NativePortIo,
} from "../../substrate/native-game-port.ts";
import { descendants as processDescendants } from "../../substrate/plugins/native-process.ts";
import type { GameChild, GameExit, GameSpawnRequest } from "../../substrate/spawn.ts";
import type { FramesSlot, NativeFramesHost } from "../native-frames.ts";
import { processStartedAt } from "../native-supervisor-logic.ts";
import type { CrashBuild } from "./crash-symbolicate.ts";
import { crashIdOf, type GameCrashStore, hostCrashRecord } from "./game-crashes.ts";

const run = promisify(execFile);

/** Bytes in a MiB, for the memory lines. */
const MIB_BYTES = 1024 ** 2;
const mib = (bytes: number): string => (bytes / MIB_BYTES).toFixed(1);
const gib = (bytes: number): string => (bytes / 1024 / MIB_BYTES).toFixed(1);

const MESSAGE = {
  notReaped: (runId: string, pid: number) => `native run ${runId}: pid ${pid} was not reaped after SIGKILL`,
  notSupervised: (runId: string, error: string) => `native run ${runId}: the supervisor was not told of it: ${error}`,
  killFailed: (runId: string, pid: number, error: string) => `native run ${runId}: signalling ${pid} failed: ${error}`,
  pidfile: (runId: string, error: string) => `native run ${runId}: its pidfile was not written: ${error}`,
  sweep: (dir: string, error: string) => `native runs: ${dir} was not removed: ${error}`,
  overMemory: (runId: string, bytes: number, cap: number) =>
    `native run ${runId}: footprint ${mib(bytes)} MiB is over the ${mib(cap)} MiB cap; killed ${NativeRefusal.MemoryCap}`,
  /** What the game's pending calls reject with, which reaches the harness: the footprint and the cap, in GiB. */
  memoryCap: (bytes: number, cap: number) =>
    `the game used ${gib(bytes)} GiB of memory, over this computer's ${gib(cap)} GiB cap, and was stopped (${NativeRefusal.MemoryCap})`,
  stopped: "the run was stopped before it was ready",
  listener: (error: string) => `native runs: a status listener threw: ${error}`,
  cannotEmbed: (refusal: NativeRefusal) => `Live cannot show a Mac build here (${refusal})`,
  noSurface: "an embedded run needs the size of Live's canvas",
  predatesEmbedding: "the game was made before Live could show Mac builds: it has no frames ring",
} as const;

/**
 * Start failures that are the host declining a game it cannot show, not ending one that misbehaved:
 * the run ends refused, not killed. `unsupported` is a game with the ring that refused its
 * `surface` (`surface-failed`, `no-frames-service`, …): Live could not start it, and may next time.
 */
const DECLINED_STARTS: ReadonlySet<NativeRefusal> = new Set([
  NativeRefusal.GamePredatesEmbedding,
  NativeRefusal.Unsupported,
]);

/** Which of a game's runs `portOf` answers with no mode: the window, Live's Native view, then an agent's run. */
const PORT_OF_ORDER: readonly NativeRunMode[] = [NativeRunMode.Window, NativeRunMode.Embedded, NativeRunMode.Headless];
/** The run's pidfile, in its run dir: `{pid, lstart}`. */
const PIDFILE = "pid.json";
/** The most bytes a pidfile the sweep reads may have. */
const PIDFILE_MAX_BYTES = 4096;
/** How often a running game's memory is sampled. */
const MEMORY_SAMPLE_MS = 5 * SECOND_MS;
/** How long stderr lines gather before they go out as one `native.log` event (a full batch goes at once). */
const LOG_FLUSH_MS = SECOND_MS / 4;
/**
 * The most stderr lines one flush window passes on (4,000 a second): far past a game's honest
 * logging, short of a print loop flooding the renderer. Past it lines are dropped and the window's
 * last batch says `truncated`; the next window passes lines again.
 */
const LOG_WINDOW_LINES_MAX = 1000;
/** How long `footprint` may take for one pid. */
const PROBE_TIMEOUT_MS = 5 * SECOND_MS;
/** `footprint`'s summary line for the number the cap reads. */
const PHYS_FOOTPRINT = /phys_footprint:\s*(\d+)\s*B/;
/** A run id: 12 hex, from the host's own random source. */
const RUN_ID_BYTES = 6;
/** A folder in the runs root named as a run dir (which `removeRunDir` takes). */
const RUN_DIR_NAME = /^[0-9a-f]{12,32}$/;
const NONCE_BYTES = 16;

/** What starts one run. */
export interface NativeStartRequest {
  project: string;
  target: BuildTarget;
  mode: NativeRunMode;
  /** A playable worktree to build instead of the game folder, already checked by the caller (`assertHarnessRoot` / the previews root check). */
  root?: string;
  /** The harness lease owner, so harness death ends its runs. */
  owner?: string;
  signal?: AbortSignal;
  /** Embedded runs: the ring Live's canvas asks for. */
  surface?: NativeSurfaceSize;
  /**
   * The game conformance suite's own run (`game.conformance`, set by the host, never from a
   * caller's params): the conformance gate it feeds does not hold it back.
   */
  conformance?: boolean;
  /**
   * The build lane's bake step (NAV-14b, `rust-bake.ts`, set by the host, never from a caller's
   * params): the admitted output of the build in flight, which prepare assembles without asking
   * the lane again (that build is the one waiting on this run).
   */
  prebuilt?: NativePrebuilt;
  /** The person's Play timing this run's build (set by the registry for a Play window or Live's Native view). */
  timing?: PlayTimingSink;
}

/** An admitted Rust build a run starts from without building: its `out/`, lock and admitted digests. */
export interface NativePrebuilt {
  output: string;
  lock: ToolchainLock;
  admittedFiles: readonly AdmittedOutputFile[];
}

/** The ring an embedded run's canvas asks for: device pixels (`ringSizeFor`) and the screen's device-pixel ratio. */
export interface NativeSurfaceSize {
  width: number;
  height: number;
  dpr: number;
}

/** What starts a game inside Live: the game, its destination, the size of Live's canvas and the folder Live serves. */
export interface NativeEmbedRequest {
  project: string;
  target: BuildTarget;
  surface: NativeSurfaceSize;
  /** The build copy Live serves (a shown build, a run's worktree), already checked by the previews; absent: the game folder. */
  root?: string;
}

/** What `prepare` is handed: the request, its run id, and the step that says the build is done. */
export type NativePrepareRequest = NativeStartRequest & {
  runId: string;
  /** The build is done and the bundle is being admitted. */
  onAdmitting?(): void;
};

/** What `prepare` hands back: an assembled run dir (`assembleRunDir`) and the bundle id it was signed with. */
export interface PreparedRun {
  runId: string;
  runDir: string;
  exe: string;
  bundle: string;
  state: string;
  /** Null for a Windows or Linux run: no bundle id and no codesign off the Mac. */
  bundleId: string | null;
  /** The admitted build, carried in every capture's provenance; absent or null where prepare did not say. */
  build?: BuildIdentity | null;
  /** Where the admitted build's debug files are, for a crash record's symbolication; absent or null: none. */
  crashBuild?: CrashBuild | null;
}

/** What the registry tells the supervisor utility process, which kills every registered group if the app dies. */
export interface NativeSupervisorClient {
  register(run: { runId: string; pgid: number; lstart: string }): void;
  forget(runId: string): void;
}

/** What the registry reaches, injected. */
export interface NativeRunsOptions {
  /** `layout.nativeRuns`. */
  root: string;
  /** Build → admit → assemble (`core/native-prepare.ts`); throws `NativeError`. */
  prepare(request: NativePrepareRequest, signal: AbortSignal): Promise<PreparedRun>;
  spawn(request: GameSpawnRequest): Promise<GameChild>;
  connect(child: GameChild, io: Omit<NativePortIo, "child" | "encodeJpeg">): NativeGamePort;
  emit(event: UiEvent): void;
  timers: NativeTimers;
  /** `footprint -p`'s phys_footprint in bytes, or null. */
  sampleFootprint?(pid: number): Promise<number | null>;
  /** The host's physical memory in bytes, which sets the kill cap (default: `os.totalmem()`, read once). */
  ramBytes?: number;
  /** A pid's descendants (the injected `ps`). */
  descendants?(pid: number): Promise<number[]>;
  /** Linux: `/proc/<pid>/status`, or null when it cannot be read (default: reads it). */
  readProcStatus?(pid: number): Promise<string | null>;
  /** A pid's start time (`ps -o lstart=`), for the orphan sweep. */
  startedAt?(pid: number): Promise<string | null>;
  /** The supervisor utility process, when it runs. */
  supervisor?: NativeSupervisorClient;
  /** Signals one pid, or a group as `-pgid` (default: `process.kill`). */
  signal?(pid: number, signal: NodeJS.Signals): void;
  /** Where a failure that changes no outcome is written (default: `console.warn`). */
  log?(line: string): void;
  /** Live's embedded frames (`main/native-frames.ts`); absent or null where no run can be embedded. */
  frames?: NativeFramesHost | null;
  /** The host's platform, which decides how a stop ends a game (default: this one's). */
  platform?: NodeJS.Platform;
  /** Where a crashed run's record is kept (`core/game-crashes.ts`); absent or null keeps none and names none. */
  crashes?: GameCrashStore | null;
  /** The person's Plays, timed (`play-timings.ts`): a Play window's or Live's Native view's start is one; absent: none is. */
  playTimings?: PlayTimings;
}

/** A live run: its status and its port. */
export interface NativeRun {
  status: NativeRunStatus;
  port: NativeGamePort;
}

/** The registry's public surface: `StudioCore.nativeRuns` is typed by it, so the native-game fixture can stand in a scripted registry. */
export interface NativeRunsHost {
  start(request: NativeStartRequest): Promise<NativeRun>;
  stop(runId: string): Promise<void>;
  stopAll(): Promise<void>;
  /** Every agent (headless) run; the person's window keeps running. */
  stopAgentRuns(): Promise<void>;
  stopProject(project: string, modes: readonly NativeRunMode[]): Promise<void>;
  stopMode(mode: NativeRunMode): Promise<void>;
  stopOwnedBy(owner: string): Promise<void>;
  /** The live run of `project` in `mode` (the window, by default), or null. */
  state(project: string, mode?: NativeRunMode): NativeRunStatus | null;
  /** The live run's port in `mode`, else (dev-control `--surface native`) the window's, Live's embedded run's or an agent run's; or null. */
  portOf(project: string, mode?: NativeRunMode): NativeGamePort | null;
  front(project: string): Promise<boolean>;
  sweepOrphans(): Promise<number>;
  /** Subscribe to window-run focus changes (`previews.ts` drives the game's sound with it). */
  onFocus(listener: (run: NativeRunStatus, focused: boolean) => void): () => void;
  /** Subscribe to every run's status changes, as `native.status` announces them; returns the unsubscribe. */
  onStatus(listener: (run: NativeRunStatus) => void): () => void;
  /**
   * Shows `project`'s Mac build inside Live, ending its embedded run before, and answers the new
   * run's status once it is ready. Where Live cannot embed it rejects `NativeError` before any run
   * is registered; a failed start rejects as `start` does.
   */
  embed(request: NativeEmbedRequest): Promise<NativeRunStatus>;
  /**
   * Live now serves another folder of `project` (`root`, absent: the game folder): its embedded run,
   * when there is one, starts again on that folder at the size Live's canvas last asked for, as
   * `embed` does. Null when Live draws no run of `project`.
   */
  reembed(project: string, root: string | undefined): Promise<NativeRunStatus | null>;
  /** Live's canvas changed: `project`'s embedded run gets a new ring once it holds still; false when there is none. */
  resize(project: string, surface: NativeSurfaceSize): boolean;
  /** Checked input to `project`'s ready embedded run; false when there is none or it refused. */
  input(project: string, actions: NativeInputAction[]): Promise<boolean>;
  /** Live shows or hides `project`'s embedded run: while hidden, its clock rests and no frame is sent. */
  showEmbedded(project: string, visible: boolean): void;
  /** Ends `runId` for `refusal` (its frames failed): SIGKILL to its group, and it ends killed with that refusal. */
  kill(runId: string, refusal: NativeRefusal): void;
}

/** A process's `phys_footprint` in bytes (`/usr/bin/footprint`), or null where it cannot be read. */
export async function physFootprint(pid: number): Promise<number | null> {
  const args = ["-p", String(pid), "-f", "bytes", "--noCategories"];
  const listed = await run("/usr/bin/footprint", args, { timeout: PROBE_TIMEOUT_MS }).catch(() => null);
  const found = listed ? PHYS_FOOTPRINT.exec(listed.stdout) : null;
  return found?.[1] ? Number(found[1]) : null;
}

/** The fields of `/proc/<pid>/status` that are a process's own memory: anonymous and shared-memory pages, in kB. */
const PRIVATE_MEMORY = /^(?:RssAnon|RssShmem):\s+(\d+)\s+kB$/gmu;
const KIB = 1024;

/** `/proc/<pid>/status`, or null when the process is gone or it cannot be read. */
function readProcStatus(pid: number): Promise<string | null> {
  return readFile(`/proc/${pid}/status`, "utf8").catch(() => null);
}

/** A process's own memory in bytes from its `/proc/<pid>/status`, or null when the text names none. */
function privateMemory(status: string | null): number | null {
  if (status === null) return null;
  const found = [...status.matchAll(PRIVATE_MEMORY)];
  return found.length ? found.reduce((sum, match) => sum + Number(match[1]) * KIB, 0) : null;
}

/**
 * A boxed Linux game's memory in bytes: the anonymous and shared-memory pages (`RssAnon`,
 * `RssShmem`) of bubblewrap's pid and every descendant (the box's own init and the game, which
 * live in a pid namespace of their own), or null when none can be read. File-backed pages, the
 * shared libraries, are left out, as `phys_footprint` leaves out clean file pages on a Mac.
 */
export async function linuxTreeMemory(
  pid: number,
  deps: { descendants(pid: number): Promise<number[]>; readStatus(pid: number): Promise<string | null> },
): Promise<number | null> {
  const tree = [pid, ...(await deps.descendants(pid).catch(() => [] as number[]))];
  const each = await Promise.all(tree.map(async (member) => privateMemory(await deps.readStatus(member))));
  const known = each.filter((bytes): bytes is number => bytes !== null);
  return known.length ? known.reduce((sum, bytes) => sum + bytes, 0) : null;
}

/** One promise and the hands that settle it. */
interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** One run the registry holds, from its first status to its removal. */
interface RunEntry {
  status: NativeRunStatus;
  readonly request: NativeStartRequest;
  readonly controller: AbortController;
  /** Settles with the started run, or with why it did not start. */
  readonly started: Deferred<NativeRun>;
  child: GameChild | null;
  port: NativeGamePort | null;
  runDir: string;
  stopping: Promise<void> | null;
  stopAsked: boolean;
  /** The stop needed SIGKILL: the run ends killed. */
  escalated: boolean;
  /** The start failed after the game was spawned: the host killed it, and the run ends killed with this refusal. */
  startFailed: { refusal: NativeRefusal | null } | null;
  finished: boolean;
  readonly ended: Deferred<void>;
  timers: { heartbeat: unknown; silent: unknown; memory: unknown; flush: unknown };
  /** The batch gathering, whether it cut or dropped a line, and the lines this flush window passed on. */
  log: { lines: string[]; truncated: boolean; windowLines: number };
  /** Embedded runs: Live's canvas and the frames channel; null for every other run. */
  readonly embed: EmbedState | null;
  /** The build a crash record is symbolicated against, once prepared. */
  crashBuild: CrashBuild | null;
}

/** An embedded run's side of Live: the size it is asked for, its ring, its channel and its sight. */
interface EmbedState {
  /** The size Live's canvas asked for last. */
  surface: NativeSurfaceSize;
  /** The size the current ring was made for; null before the first ring. */
  ringed: NativeSurfaceSize | null;
  /** The frames channel is open: from just before the spawn to the end of the run. */
  opened: boolean;
  /** Live shows the run. */
  visible: boolean;
  /** The pending debounced resize. */
  resize: unknown;
  /** The game re-created its GPU device and dropped its ring: a new generation is owed. */
  lost: boolean;
  /** A new generation after a device loss is being announced. */
  announcing: boolean;
}

const sameSurface = (a: NativeSurfaceSize, b: NativeSurfaceSize): boolean =>
  a.width === b.width && a.height === b.height && a.dpr === b.dpr;

/** A new embedded run's side of Live: asked for `surface`, shown, no ring or channel yet. */
const embedState = (surface: NativeSurfaceSize): EmbedState => ({
  surface: { ...surface },
  ringed: null,
  opened: false,
  visible: true,
  resize: null,
  lost: false,
  announcing: false,
});

/** How a run ended, as its last status says it. */
interface Ending {
  state: NativeRunState;
  refusal: NativeRefusal | null;
  problem: BuildProblem | null;
  exit: { code: number | null; signal: string | null } | null;
  /** Why the host's game box refused the run, when it did. */
  box?: GameBoxProblem | null;
}

const copyStatus = (status: NativeRunStatus): NativeRunStatus => ({
  ...status,
  exit: status.exit ? { ...status.exit } : null,
  ...(status.progress ? { progress: { ...status.progress } } : {}),
  ...(status.memory ? { memory: { ...status.memory } } : {}),
});

/** A run's memory after one sample of `bytes`: the peak only rises, and once past the budget it stays over. */
function memoryAfter(previous: NativeRunMemory | null | undefined, bytes: number, capBytes: number): NativeRunMemory {
  const peakBytes = Math.max(previous?.peakBytes ?? 0, bytes);
  return {
    peakBytes,
    budgetBytes: NATIVE_GAME_MEMORY_BUDGET_BYTES,
    capBytes,
    overBudget: peakBytes > NATIVE_GAME_MEMORY_BUDGET_BYTES,
  };
}

/** How a game that ran ended: a stop the host asked for, a refusal it killed for, or the game's own exit. */
function endingOf(entry: RunEntry, ended: GameExit | null): Ending {
  const failure = entry.port?.failure ?? null;
  const exit = ended ? { code: ended.code, signal: ended.signal } : null;
  if (entry.stopAsked) {
    const state = entry.escalated || exit === null ? NativeRunState.Killed : NativeRunState.Stopped;
    return { state, refusal: null, problem: null, exit };
  }
  if (failure) return { state: NativeRunState.Killed, refusal: failure, problem: null, exit };
  // The box itself failed (the Windows launcher's own failure): the run was refused, not crashed.
  const refused = ended?.refused;
  if (refused)
    return { state: NativeRunState.Refused, refusal: refused.refusal, problem: null, exit, box: refused.box };
  if (entry.startFailed) {
    const { refusal } = entry.startFailed;
    const declined = refusal !== null && DECLINED_STARTS.has(refusal);
    return { state: declined ? NativeRunState.Refused : NativeRunState.Killed, refusal, problem: null, exit };
  }
  const closed = exit !== null && exit.code === 0 && exit.signal === null;
  return { state: closed ? NativeRunState.Stopped : NativeRunState.Crashed, refusal: null, problem: null, exit };
}

/** What an aborted start rejects with: the signal's own reason when it is an error, else an `AbortError`. */
function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new DOMException(MESSAGE.stopped, "AbortError");
}

/** A pidfile's record, or null when it is not one. */
function pidRecord(text: string): { pid: number; lstart: string } | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null) return null;
    const pid = "pid" in value ? value.pid : null;
    const lstart = "lstart" in value ? value.lstart : null;
    const valid = typeof pid === "number" && Number.isSafeInteger(pid) && pid > 1;
    return valid && typeof lstart === "string" && lstart ? { pid, lstart } : null;
  } catch {
    return null;
  }
}

/**
 * The registry. Each run is built and admitted by `prepare`, started by `spawn` under the game
 * profile, spoken to through the port `connect` makes, and ended by `stop` or by its own exit.
 */
export class NativeRuns implements NativeRunsHost {
  readonly #options: NativeRunsOptions;
  /** The footprint past which a game is killed `memory-cap`, from the host's memory, once. */
  readonly #memoryCapBytes: number;
  readonly #runs = new Map<string, RunEntry>();
  readonly #focus = new Set<(run: NativeRunStatus, focused: boolean) => void>();
  readonly #statusListeners = new Set<(run: NativeRunStatus) => void>();
  #sweep: Promise<number> | null = null;

  constructor(options: NativeRunsOptions) {
    this.#options = options;
    this.#memoryCapBytes = nativeGameMemoryCapBytes(options.ramBytes ?? os.totalmem());
    // Bound to this registry: a caller may hold a method apart from it, or stand a wrapper in
    // (`Object.create(runs)` with one member replaced) and still reach this registry's runs.
    this.start = this.start.bind(this);
    this.stop = this.stop.bind(this);
    this.stopAll = this.stopAll.bind(this);
    this.stopAgentRuns = this.stopAgentRuns.bind(this);
    this.stopProject = this.stopProject.bind(this);
    this.stopMode = this.stopMode.bind(this);
    this.stopOwnedBy = this.stopOwnedBy.bind(this);
    this.state = this.state.bind(this);
    this.portOf = this.portOf.bind(this);
    this.front = this.front.bind(this);
    this.sweepOrphans = this.sweepOrphans.bind(this);
    this.onFocus = this.onFocus.bind(this);
    this.onStatus = this.onStatus.bind(this);
    this.embed = this.embed.bind(this);
    this.reembed = this.reembed.bind(this);
    this.resize = this.resize.bind(this);
    this.input = this.input.bind(this);
    this.showEmbedded = this.showEmbedded.bind(this);
    this.kill = this.kill.bind(this);
  }

  /** Builds, admits and starts a run (`prepare` → `spawn` → `connect` → `ready`); a second Play fronts the live window. */
  async start(request: NativeStartRequest): Promise<NativeRun> {
    const refused = request.mode === NativeRunMode.Embedded ? this.#embedRefusal(request) : null;
    if (refused) throw refused;
    const live = request.mode === NativeRunMode.Window ? this.#newest(request.project, NativeRunMode.Window) : null;
    // A window being stopped is on its way out: Play then starts a fresh one.
    if (live && !live.stopAsked) return this.#again(live);
    return this.#open(request).started.promise;
  }

  /** `quit` → SIGTERM → SIGKILL with reaping inside `NATIVE_STOP_BUDGET_MS`; resolves even when a kill fails. */
  async stop(runId: string): Promise<void> {
    const entry = this.#runs.get(runId);
    if (!entry || entry.finished) return;
    entry.stopAsked = true;
    entry.stopping ??= this.#stopEntry(entry);
    await entry.stopping;
  }

  /** Every run. */
  stopAll(): Promise<void> {
    return this.#stopWhere(() => true);
  }

  /** Every agent (headless) run; the person's window keeps running. */
  stopAgentRuns(): Promise<void> {
    return this.#stopWhere((status) => status.mode === NativeRunMode.Headless);
  }

  /** `project`'s runs in `modes`; other modes and other games keep running. */
  stopProject(project: string, modes: readonly NativeRunMode[]): Promise<void> {
    return this.#stopWhere((status) => status.project === project && modes.includes(status.mode));
  }

  /** Every run in `mode`. */
  stopMode(mode: NativeRunMode): Promise<void> {
    return this.#stopWhere((status) => status.mode === mode);
  }

  /** Every run a harness lease `owner` started. */
  stopOwnedBy(owner: string): Promise<void> {
    return this.#stopWhere((status) => status.owner === owner);
  }

  /** The live run of `project` in `mode` (the window, by default), or null. */
  state(project: string, mode: NativeRunMode = NativeRunMode.Window): NativeRunStatus | null {
    const entry = this.#newest(project, mode);
    return entry ? copyStatus(entry.status) : null;
  }

  /** The live run's port: `mode`'s, or with none named the first of {@link PORT_OF_ORDER} that has one. */
  portOf(project: string, mode?: NativeRunMode): NativeGamePort | null {
    if (mode) return this.#newest(project, mode)?.port ?? null;
    // The run the person looks at first: the Play window, then Live's Native view, then an agent's.
    for (const shown of PORT_OF_ORDER) {
      const port = this.#newest(project, shown)?.port;
      if (port) return port;
    }
    return null;
  }

  /** Raises `project`'s window run (the `front` op); false when there is none or it cannot. */
  async front(project: string): Promise<boolean> {
    const port = this.#newest(project, NativeRunMode.Window)?.port;
    if (!port) return false;
    return port.call(NativeOp.Front).then(
      (result) => result.fronted,
      () => false,
    );
  }

  /**
   * At boot: kills each pidfile's group whose pid and start time both still match, and removes every
   * run dir no run of this registry owns. Never follows a link. Answers how many groups it killed.
   */
  sweepOrphans(): Promise<number> {
    this.#sweep = this.#sweepOnce();
    return this.#sweep;
  }

  /** Subscribe to window-run focus changes. */
  onFocus(listener: (run: NativeRunStatus, focused: boolean) => void): () => void {
    this.#focus.add(listener);
    return () => this.#focus.delete(listener);
  }

  /** Subscribe to every run's status changes. */
  onStatus(listener: (run: NativeRunStatus) => void): () => void {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  // ── embedded runs ─────────────────────────────────────────────────────────────────────────

  /**
   * Shows `project`'s Mac build inside Live. The new run is registered at once (so `state` finds
   * it); the game's embedded run before it is stopped, and its frames stop at once.
   */
  async embed(request: NativeEmbedRequest): Promise<NativeRunStatus> {
    const before = this.#newest(request.project, NativeRunMode.Embedded);
    const starting = this.start({ ...request, mode: NativeRunMode.Embedded });
    if (before) void this.stop(before.status.runId);
    return (await starting).status;
  }

  /** Live serves another folder of `project`: its live embedded run starts again there at its canvas's last size. */
  async reembed(project: string, root: string | undefined): Promise<NativeRunStatus | null> {
    const entry = this.#newest(project, NativeRunMode.Embedded);
    const embed = entry?.embed;
    if (!entry || !embed || entry.stopAsked) return null;
    const request: NativeEmbedRequest = { project, target: entry.status.target, surface: { ...embed.surface } };
    return this.embed(root === undefined ? request : { ...request, root });
  }

  /** Live's canvas changed size: a new ring `NATIVE_RESIZE_DEBOUNCE_MS` after the last change. */
  resize(project: string, surface: NativeSurfaceSize): boolean {
    const entry = this.#newest(project, NativeRunMode.Embedded);
    const embed = entry?.embed;
    if (!entry || !embed || entry.stopAsked) return false;
    embed.surface = { ...surface };
    // Before the first ring the start rings at the size asked last, and catches up after it.
    if (embed.ringed) this.#armResize(entry, embed);
    return true;
  }

  /** Live's captured input to `project`'s ready embedded run (positions in ring pixels, `px: true`: the template maps them through its letterbox). */
  async input(project: string, actions: NativeInputAction[]): Promise<boolean> {
    const entry = this.#newest(project, NativeRunMode.Embedded);
    const port = entry?.status.state === NativeRunState.Ready ? entry.port : null;
    const checked = parseNativeInput(actions);
    if (!port || !checked) return false;
    return port.call(NativeOp.Input, { actions: checked }).then(
      () => true,
      () => false,
    );
  }

  /** Live shows or hides `project`'s embedded run: its clock and its frames follow. */
  showEmbedded(project: string, visible: boolean): void {
    const entry = this.#newest(project, NativeRunMode.Embedded);
    const embed = entry?.embed;
    if (!entry || !embed || embed.visible === visible) return;
    embed.visible = visible;
    const frames = embed.opened ? this.#options.frames : null;
    if (visible) frames?.resume(entry.status.runId);
    else frames?.pause(entry.status.runId);
    entry.port?.setVisible(visible);
  }

  /** Ends `runId` for `refusal`: its frames stop, its group is killed, and it ends killed with that refusal. */
  kill(runId: string, refusal: NativeRefusal): void {
    const entry = this.#runs.get(runId);
    if (!entry || entry.finished) return;
    this.#pauseFrames(entry);
    if (entry.port) entry.port.kill(refusal);
    else if (entry.child) this.#killStranded(entry, entry.child, new NativeError(refusal, refusal));
  }

  /** Why an embedded run cannot start here, or null: Live's frames are unavailable, or no canvas size was given. */
  #embedRefusal(request: NativeStartRequest): NativeError | null {
    const frames = this.#options.frames;
    const refusal = frames ? frames.available() : NativeRefusal.EmbedUnsupported;
    if (refusal) return new NativeError(refusal, MESSAGE.cannotEmbed(refusal));
    return request.surface ? null : new NativeError(NativeRefusal.EmbedUnsupported, MESSAGE.noSurface);
  }

  /** Embedded runs: the frames channel, opened before the spawn; its service is the spawn's `frames` field. */
  #openFrames(entry: RunEntry): { frames?: string } {
    const { embed } = entry;
    if (!embed) return {};
    const frames = this.#options.frames;
    if (!frames)
      throw new NativeError(NativeRefusal.EmbedUnsupported, MESSAGE.cannotEmbed(NativeRefusal.EmbedUnsupported));
    const { runId, project } = entry.status;
    const { service } = frames.open({ runId, project, release: (slot) => this.#releaseSlot(entry, slot) });
    embed.opened = true;
    if (!embed.visible) frames.pause(runId);
    return { frames: service };
  }

  /** A slot every reference let go of goes back to the game (`release`). */
  #releaseSlot(entry: RunEntry, slot: FramesSlot): void {
    void entry.port?.call(NativeOp.Release, { slot: slot.slot, generation: slot.generation }).catch(() => {});
  }

  /** Embedded runs, once ready: hidden Live rests the clock, then the first ring at the size asked last. */
  async #firstRing(entry: RunEntry, port: NativeGamePort): Promise<void> {
    const { embed } = entry;
    if (!embed) return;
    if (!embed.visible) port.setVisible(false);
    await this.#ring(entry, embed, port);
  }

  /**
   * The next ring generation at the size asked last (`expectRing`), then the game's `surface` op
   * for it. A game made before embedding has no such op (`unknown-op`): it is declined
   * `game-predates-embedding`. Any other refusal of a game with the ring stays `unsupported`.
   */
  async #ring(entry: RunEntry, embed: EmbedState, port: NativeGamePort): Promise<void> {
    const frames = this.#options.frames;
    if (!frames) return;
    const asked = { ...embed.surface };
    const ring = frames.ring(entry.status.runId, { width: asked.width, height: asked.height });
    const arg = { w: ring.width, h: ring.height, dpr: asked.dpr, slots: ring.slots, generation: ring.generation };
    try {
      await port.call(NativeOp.Surface, arg);
    } catch (error) {
      const predates = error instanceof NativeOpRefusedError && error.gameError === NativeOpError.UnknownOp;
      throw predates ? new NativeError(NativeRefusal.GamePredatesEmbedding, MESSAGE.predatesEmbedding) : error;
    }
    embed.ringed = asked;
    if (!sameSurface(asked, embed.surface)) this.#armResize(entry, embed);
  }

  #armResize(entry: RunEntry, embed: EmbedState): void {
    const { timers } = this.#options;
    timers.clearTimeout(embed.resize);
    embed.resize = timers.setTimeout(() => void this.#reRing(entry, embed), NATIVE_RESIZE_DEBOUNCE_MS);
  }

  /** The canvas held still: a new ring, unless the run is ending or the ring already has that size. */
  async #reRing(entry: RunEntry, embed: EmbedState): Promise<void> {
    embed.resize = null;
    const { port } = entry;
    const current = embed.ringed;
    if (!port || !current) return;
    const ending = entry.finished || entry.stopAsked;
    if (ending || sameSurface(current, embed.surface)) return;
    try {
      await this.#ring(entry, embed, port);
    } catch (error) {
      // A ring the addon or the game refused ends the run with that refusal; a game already gone ends itself.
      if (error instanceof NativeError) port.kill(error.refusal);
    }
  }

  /**
   * The game re-created its lost GPU device, and the ring it had went with the old one: Live gets a
   * new generation at the size asked last, at once, so the addon refuses every slot of the old one
   * from now. Restorations that arrive while one is announced are one more generation, not one each.
   */
  #ringAfterLoss(entry: RunEntry): void {
    const { embed, port } = entry;
    if (!embed?.ringed || !port || entry.finished || entry.stopAsked) return;
    embed.lost = true;
    if (!embed.announcing) void this.#announceAfterLoss(entry, embed, port);
  }

  async #announceAfterLoss(entry: RunEntry, embed: EmbedState, port: NativeGamePort): Promise<void> {
    embed.announcing = true;
    this.#options.timers.clearTimeout(embed.resize);
    embed.resize = null;
    try {
      while (embed.lost && !entry.finished && !entry.stopAsked) {
        embed.lost = false;
        await this.#ring(entry, embed, port);
      }
    } catch (error) {
      // A ring the addon or the game refused ends the run with that refusal; a game already gone ends itself.
      if (error instanceof NativeError) port.kill(error.refusal);
    } finally {
      embed.announcing = false;
    }
  }

  /** An embedded run stopping or killed sends no frame more, from this moment. */
  #pauseFrames(entry: RunEntry): void {
    if (entry.embed?.opened) this.#options.frames?.pause(entry.status.runId);
  }

  /** The run is over: its frames channel closes (after its game is gone) and no resize is pending. */
  #closeFrames(entry: RunEntry): void {
    const { embed } = entry;
    if (!embed) return;
    this.#options.timers.clearTimeout(embed.resize);
    if (embed.opened) this.#options.frames?.close(entry.status.runId);
    embed.opened = false;
  }

  // ── starting ──────────────────────────────────────────────────────────────────────────────

  /** Registers the run at once (so a second Play finds it) and starts it. */
  #open(request: NativeStartRequest): RunEntry {
    const runId = randomBytes(RUN_ID_BYTES).toString("hex");
    const at = new Date(this.#options.timers.now()).toISOString();
    const entry: RunEntry = {
      status: {
        project: request.project,
        runId,
        target: request.target,
        state: NativeRunState.Building,
        mode: request.mode,
        pid: null,
        backend: null,
        refusal: null,
        problem: null,
        exit: null,
        owner: request.owner ?? null,
        startedAt: at,
        endedAt: null,
      },
      request,
      controller: new AbortController(),
      started: deferred<NativeRun>(),
      child: null,
      port: null,
      runDir: path.join(this.#options.root, runId),
      stopping: null,
      stopAsked: false,
      escalated: false,
      startFailed: null,
      finished: false,
      ended: deferred<void>(),
      timers: { heartbeat: null, silent: null, memory: null, flush: null },
      log: { lines: [], truncated: false, windowLines: 0 },
      embed: request.mode === NativeRunMode.Embedded && request.surface ? embedState(request.surface) : null,
      crashBuild: null,
    };
    this.#runs.set(runId, entry);
    this.#linkAbort(entry);
    this.#emit(entry);
    // Whoever started it hears how; nobody else's await is needed for a refusal to be handled.
    entry.started.promise.catch(() => {});
    void this.#run(entry).then(entry.started.resolve, entry.started.reject);
    return entry;
  }

  /** The caller's own signal ends the start as Stop does. */
  #linkAbort(entry: RunEntry): void {
    const signal = entry.request.signal;
    if (!signal) return;
    const abort = () => void this.stop(entry.status.runId);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  }

  async #run(entry: RunEntry): Promise<NativeRun> {
    const { runId } = entry.status;
    const clock = this.#playClock(entry);
    try {
      await this.#sweep?.catch(() => 0);
      const prepared = await this.#options.prepare(
        {
          ...entry.request,
          runId,
          onAdmitting: () => this.#set(entry, { state: NativeRunState.Admitting }),
          ...(clock ? { timing: clock.sink } : {}),
        },
        entry.controller.signal,
      );
      entry.controller.signal.throwIfAborted();
      clock?.mark(PlayStage.Built);
      entry.crashBuild = prepared.crashBuild ?? null;
      this.#set(entry, { state: NativeRunState.Starting });
      const nonce = randomBytes(NONCE_BYTES).toString("hex");
      const { runDir, exe, bundle, state } = prepared;
      const frames = this.#openFrames(entry);
      const { mode } = entry.request;
      const stack = prepared.build?.stack;
      const built = stack && isCompiledStack(stack) ? { stack } : {};
      const child = await this.#options.spawn({ runId, runDir, exe, bundle, state, mode, nonce, ...frames, ...built });
      await this.#adopt(entry, child);
      entry.controller.signal.throwIfAborted();
      const run = await this.#connect(entry, child, { nonce, stateDir: state, runId, build: prepared.build ?? null });
      clock?.mark(PlayStage.Served);
      await this.#firstRing(entry, run.port);
      clock?.end(PlayStage.FirstFrame);
      return run;
    } catch (error) {
      clock?.end(PlayStage.Failed, errorMessage(error));
      // A game that was spawned ends through its exit, killed here if nothing else will end it;
      // one that never was ends here.
      if (!entry.child) this.#refuse(entry, error);
      else if (!entry.stopAsked) this.#killStranded(entry, entry.child, error);
      // Stop (or the caller's abort) ended it, whatever step noticed: the start says so as an AbortError.
      if (entry.stopAsked) throw abortReason(entry.controller.signal);
      throw error;
    }
  }

  /** A person's run (a Play window, Live's Native view) is a Play, timed; an agent's run is not. */
  #playClock(entry: RunEntry): PlayClock | null {
    const { mode, project, target } = entry.request;
    if (mode === NativeRunMode.Headless || !this.#options.playTimings) return null;
    return this.#options.playTimings.start({ project, target, commit: null });
  }

  /** The spawned game is this run's: its exit ends the run, its pidfile and the supervisor know it. */
  async #adopt(entry: RunEntry, child: GameChild): Promise<void> {
    entry.child = child;
    // The pid rides on the next change (ready): starting is one state, said once.
    entry.status = { ...entry.status, pid: child.pid };
    void child.exited.then(
      (exit) => this.#finish(entry, endingOf(entry, exit)),
      () => this.#finish(entry, endingOf(entry, null)),
    );
    // Before anything is awaited: the addon takes frames from this pid only.
    if (entry.embed?.opened) this.#options.frames?.peer(entry.status.runId, child.pid);
    const lstart = await (this.#options.startedAt ?? processStartedAt)(child.pid).catch(() => null);
    await this.#writePidfile(entry, child.pid, lstart);
    if (!lstart) return;
    try {
      this.#options.supervisor?.register({ runId: entry.status.runId, pgid: child.pid, lstart });
    } catch (error) {
      // The pidfile still lets the next boot end the game; the run itself goes on.
      this.#log(MESSAGE.notSupervised(entry.status.runId, errorMessage(error)));
    }
  }

  /**
   * A start that failed after its game was spawned (a port that could not be made, a handshake the
   * port refused): unless the game already ended itself, it is killed now, since without a port
   * nothing else would end it, and its exit ends the run killed, freeing Play for a fresh start.
   */
  #killStranded(entry: RunEntry, child: GameChild, error: unknown): void {
    if (entry.finished || error instanceof NativeExitError) return;
    entry.startFailed = { refusal: error instanceof NativeError ? error.refusal : null };
    this.#signalGroup(entry, child, "SIGKILL");
  }

  /** The port, its events and stderr, then the handshake; a run that is ready is watched. */
  async #connect(
    entry: RunEntry,
    child: GameChild,
    io: { nonce: string; stateDir: string; runId: string; build: BuildIdentity | null },
  ): Promise<NativeRun> {
    const { timers } = this.#options;
    const { mode, project } = entry.request;
    const onKill = () => void this.#reapAfterKill(entry, child);
    const port = this.#options.connect(child, { ...io, mode, timers, project, onKill });
    entry.port = port;
    port.onEvent((event) => this.#event(entry, event));
    port.onStderr((line, cut) => this.#stderr(entry, line, cut));
    const ready = await port.ready();
    this.#set(entry, {
      state: NativeRunState.Ready,
      backend: ready.backend.api,
      receipt: ready.receipt ?? null,
      progress: null,
    });
    this.#heartbeat(entry);
    this.#sampleMemory(entry);
    return this.#handle(entry, port);
  }

  /** A second Play: the live window, fronted. */
  async #again(entry: RunEntry): Promise<NativeRun> {
    const live = await entry.started.promise;
    await this.front(entry.status.project);
    return live;
  }

  /** What `start` answers: the run's live status (a fresh copy each read) and its port. */
  #handle(entry: RunEntry, port: NativeGamePort): NativeRun {
    return {
      get status() {
        return copyStatus(entry.status);
      },
      port,
    };
  }

  /** A start that ended before any game ran: refused with its typed refusal, or stopped when Stop asked. */
  #refuse(entry: RunEntry, error: unknown): void {
    const typed = error instanceof NativeError ? error : null;
    const ending: Ending = entry.stopAsked
      ? { state: NativeRunState.Stopped, refusal: null, problem: null, exit: null }
      : {
          state: NativeRunState.Refused,
          refusal: typed?.refusal ?? null,
          problem: typed?.problem ?? null,
          exit: null,
          ...(typed?.box ? { box: typed.box } : {}),
        };
    this.#finish(entry, ending);
  }

  async #writePidfile(entry: RunEntry, pid: number, lstart: string | null): Promise<void> {
    const file = path.join(entry.runDir, PIDFILE);
    try {
      const handle = await openNoFollow(file, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL, 0o600);
      try {
        await handle.writeFile(JSON.stringify({ pid, lstart }));
      } finally {
        await handle.close();
      }
    } catch (error) {
      this.#log(MESSAGE.pidfile(entry.status.runId, errorMessage(error)));
    }
  }

  // ── watching ──────────────────────────────────────────────────────────────────────────────

  /**
   * A `state` every `NATIVE_HEARTBEAT_MS`; one unanswered that long ends the game unresponsive. While
   * a v2 game owes a step or capture (it serves one op at a time, so a beat would queue behind a long
   * CPU-bound step) the beat waits: that call's own deadline decides `gpu-hang` (CONTRACT.md).
   */
  #heartbeat(entry: RunEntry): void {
    const { timers } = this.#options;
    const beat = () => {
      entry.timers.heartbeat = null;
      const port = entry.port;
      if (!port || entry.finished || entry.stopAsked) return;
      if (port.awaitingGpu) {
        entry.timers.heartbeat = timers.setTimeout(beat, NATIVE_HEARTBEAT_MS);
        return;
      }
      entry.timers.silent = timers.setTimeout(() => port.kill(NativeRefusal.Unresponsive), NATIVE_HEARTBEAT_MS);
      void port.call(NativeOp.State).then(
        () => {
          timers.clearTimeout(entry.timers.silent);
          if (!entry.finished && !entry.stopAsked)
            entry.timers.heartbeat = timers.setTimeout(beat, NATIVE_HEARTBEAT_MS);
        },
        () => timers.clearTimeout(entry.timers.silent),
      );
    };
    entry.timers.heartbeat = timers.setTimeout(beat, NATIVE_HEARTBEAT_MS);
  }

  /** How this host measures a game's memory: `phys_footprint` on a Mac, the box's process tree on Linux. */
  #memorySampler(): (pid: number) => Promise<number | null> {
    const injected = this.#options.sampleFootprint;
    if (injected) return injected;
    if ((this.#options.platform ?? process.platform) !== StudioPlatform.Linux) return physFootprint;
    const readStatus = this.#options.readProcStatus ?? readProcStatus;
    return (pid) => linuxTreeMemory(pid, { descendants: (root) => this.#descendants(root), readStatus });
  }

  /**
   * The game's memory every `MEMORY_SAMPLE_MS` (`#memorySampler`): a new peak goes on its status
   * (past the budget it is marked over budget and keeps running); past the cap it ends `memory-cap`.
   */
  #sampleMemory(entry: RunEntry): void {
    const { timers } = this.#options;
    const sampler = this.#memorySampler();
    const cap = this.#memoryCapBytes;
    const sample = async () => {
      entry.timers.memory = null;
      const { port, child } = entry;
      if (!port || !child || entry.finished || entry.stopAsked) return;
      const bytes = await sampler(child.pid).catch(() => null);
      if (entry.finished || entry.stopAsked) return;
      if (bytes !== null) this.#recordMemory(entry, bytes);
      if (bytes !== null && bytes > cap) {
        // The person sees the reason on the card; the log keeps what was measured, for a kill nobody watched.
        this.#log(MESSAGE.overMemory(entry.status.runId, bytes, cap));
        return port.kill(NativeRefusal.MemoryCap, MESSAGE.memoryCap(bytes, cap));
      }
      entry.timers.memory = timers.setTimeout(() => void sample(), MEMORY_SAMPLE_MS);
    };
    entry.timers.memory = timers.setTimeout(() => void sample(), MEMORY_SAMPLE_MS);
  }

  /** One memory sample on the run's status, announced only when it raised the peak. */
  #recordMemory(entry: RunEntry, bytes: number): void {
    const previous = entry.status.memory;
    if (previous && bytes <= previous.peakBytes) return;
    this.#set(entry, { memory: memoryAfter(previous, bytes, this.#memoryCapBytes) });
  }

  /**
   * A restored device owes Live a new ring; a starting game's progress goes on its status; a window
   * run's focus is the person's; any other event is ignored.
   */
  #event(entry: RunEntry, event: NativeEventMessage): void {
    if (event.event === NativeEvent.DeviceRestored) {
      this.#ringAfterLoss(entry);
      return;
    }
    if (event.event === NativeEvent.Starting) {
      if (event.progress && entry.status.state === NativeRunState.Starting)
        this.#set(entry, { progress: event.progress });
      return;
    }
    if (event.event !== NativeEvent.Focus || entry.status.mode !== NativeRunMode.Window) return;
    for (const listener of this.#focus) listener(copyStatus(entry.status), event.focused);
  }

  /**
   * stderr lines gather into `native.log` batches: a full batch (`NATIVE_LOG_BATCH_MAX`) goes out at
   * once, the rest when the flush window ends. Past `LOG_WINDOW_LINES_MAX` in one window lines are
   * dropped, and the batch says so.
   */
  #stderr(entry: RunEntry, line: string, cut: boolean): void {
    const { log } = entry;
    entry.timers.flush ??= this.#options.timers.setTimeout(() => this.#endLogWindow(entry), LOG_FLUSH_MS);
    if (log.windowLines >= LOG_WINDOW_LINES_MAX) {
      log.truncated = true;
      return;
    }
    log.windowLines += 1;
    log.lines.push(line);
    if (cut) log.truncated = true;
    if (log.lines.length >= NATIVE_LOG_BATCH_MAX) this.#flush(entry);
  }

  /** The flush window is over: what gathered goes out, and the next window passes lines again. */
  #endLogWindow(entry: RunEntry): void {
    entry.timers.flush = null;
    this.#flush(entry);
    entry.log.windowLines = 0;
  }

  /** The gathered batch as one `native.log` event (a batch that only dropped lines says `truncated`). */
  #flush(entry: RunEntry): void {
    const { lines, truncated } = entry.log;
    if (lines.length === 0 && !truncated) return;
    entry.log = { ...entry.log, lines: [], truncated: false };
    const { project, runId } = entry.status;
    this.#options.emit(uiEvent(UiEvent.NativeLog, { project, runId, lines, truncated }));
  }

  // ── stopping ──────────────────────────────────────────────────────────────────────────────

  async #stopWhere(match: (status: NativeRunStatus) => boolean): Promise<void> {
    const chosen = [...this.#runs.values()].filter((entry) => !entry.finished && match(entry.status));
    await Promise.all(chosen.map((entry) => this.stop(entry.status.runId)));
  }

  async #stopEntry(entry: RunEntry): Promise<void> {
    const { timers } = this.#options;
    timers.clearTimeout(entry.timers.silent);
    this.#pauseFrames(entry);
    if (entry.embed) timers.clearTimeout(entry.embed.resize);
    if (!entry.child) {
      entry.controller.abort();
      await entry.started.promise.catch(() => {});
    }
    if (entry.child && !entry.finished) {
      this.#set(entry, { state: NativeRunState.Stopping });
      await this.#escalate(entry, entry.child);
    }
    await entry.ended.promise;
  }

  /**
   * quit, then SIGTERM to the group, then SIGKILL to the group and its listed descendants; each step
   * only if needed. A game stopped before it had a port is not asked to quit: nobody can ask it.
   */
  async #escalate(entry: RunEntry, child: GameChild): Promise<void> {
    const exited = child.exited.then(
      () => true,
      () => true,
    );
    const port = entry.port;
    if (port) {
      void port.call(NativeOp.Quit).catch(() => {});
      if (await this.#within(exited, NATIVE_QUIT_GRACE_MS)) return;
    }
    this.#signalGroup(entry, child, "SIGTERM");
    if (await this.#within(exited, NATIVE_TERM_GRACE_MS)) return;
    entry.escalated = true;
    const tree = await this.#descendants(child.pid);
    this.#signalGroup(entry, child, "SIGKILL");
    for (const pid of tree) this.#signal(entry.status.runId, pid, "SIGKILL");
    if (await this.#within(exited, NATIVE_REAP_MARGIN_MS)) return;
    this.#log(MESSAGE.notReaped(entry.status.runId, child.pid));
    this.#finish(entry, endingOf(entry, null));
  }

  /**
   * The port ended the game (a missed step or capture deadline taken for a GPU hang, a protocol
   * violation, the memory cap): its group already has SIGKILL. Descendants outside the group get it
   * too, and a game the kernel has not reaped `NATIVE_REAP_MARGIN_MS` later (one stuck in a GPU
   * wait) still ends the run, killed with the port's refusal, so the run is over inside the budget.
   */
  async #reapAfterKill(entry: RunEntry, child: GameChild): Promise<void> {
    if (entry.finished || entry.stopAsked) return;
    const exited = child.exited.then(
      () => true,
      () => true,
    );
    for (const pid of await this.#descendants(child.pid)) this.#signal(entry.status.runId, pid, "SIGKILL");
    if (await this.#within(exited, NATIVE_REAP_MARGIN_MS)) return;
    this.#log(MESSAGE.notReaped(entry.status.runId, child.pid));
    this.#finish(entry, endingOf(entry, null));
  }

  /** True when `done` settles within `ms`, false when the clock gets there first. */
  #within(done: Promise<boolean>, ms: number): Promise<boolean> {
    const { timers } = this.#options;
    return new Promise((resolve) => {
      const timer = timers.setTimeout(() => resolve(false), ms);
      void done.then(() => {
        timers.clearTimeout(timer);
        resolve(true);
      });
    });
  }

  /** The game's descendants to kill with its group; none on Windows, where the launcher's Job Object holds them. */
  async #descendants(pid: number): Promise<number[]> {
    if (this.#onWindows()) return [];
    return (this.#options.descendants ?? processDescendants)(pid).catch(() => [] as number[]);
  }

  #onWindows(): boolean {
    return (this.#options.platform ?? process.platform) === StudioPlatform.Windows;
  }

  #signalGroup(entry: RunEntry, child: GameChild, signal: NodeJS.Signals): void {
    try {
      child.kill(signal);
    } catch (error) {
      this.#log(MESSAGE.killFailed(entry.status.runId, child.pid, errorMessage(error)));
    }
  }

  #signal(runId: string, pid: number, signal: NodeJS.Signals): void {
    try {
      (this.#options.signal ?? process.kill)(pid, signal);
    } catch (error) {
      this.#log(MESSAGE.killFailed(runId, pid, errorMessage(error)));
    }
  }

  /** The run is over: its timers stop, its last logs and status go out, and its run dir is removed. */
  #finish(entry: RunEntry, ending: Ending): void {
    if (entry.finished) return;
    entry.finished = true;
    const { timers } = this.#options;
    for (const handle of Object.values(entry.timers)) timers.clearTimeout(handle);
    this.#flush(entry);
    const endedAt = new Date(timers.now()).toISOString();
    const crash = this.#crashOf(entry, ending);
    const named = crash ? { crash: { crashId: crashIdOf(entry.status.runId), kind: crash.kind } } : {};
    this.#set(entry, { ...ending, endedAt, ...named });
    this.#runs.delete(entry.status.runId);
    this.#closeFrames(entry);
    if (entry.child) this.#options.supervisor?.forget(entry.status.runId);
    // The record is in memory (the port's or the host's): it never needs the run dir removed next.
    if (crash) {
      const run = { project: entry.request.project, runId: entry.status.runId, build: entry.crashBuild };
      void this.#options.crashes?.keep(run, crash);
    }
    // The bundle is read-only to the game: `removeRunDir` gives its folders their write bit back first.
    void removeRunDir(entry.runDir)
      .catch((error: unknown) => this.#log(MESSAGE.sweep(entry.runDir, errorMessage(error))))
      .finally(() => entry.ended.resolve());
  }

  /** The record a run that ended so leaves: the game's own last one, else the host's; null with no store. */
  #crashOf(entry: RunEntry, ending: Ending): CrashRecordV1 | null {
    if (!this.#options.crashes || !entry.child) return null;
    const sent = entry.port?.lastCrash ?? null;
    if (sent) return sent;
    return hostCrashRecord(ending, { destination: entry.request.target, tick: entry.port?.lastTick ?? null });
  }

  // ── the boot sweep ────────────────────────────────────────────────────────────────────────

  async #sweepOnce(): Promise<number> {
    const names = await readdir(this.#options.root).catch(() => [] as string[]);
    let killed = 0;
    for (const name of names) {
      if (this.#runs.has(name)) continue;
      const dir = path.join(this.#options.root, name);
      const info = await lstat(dir).catch(() => null);
      if (info?.isDirectory() && (await this.#killOrphan(dir))) killed += 1;
      const removal = RUN_DIR_NAME.test(name) ? removeRunDir(dir) : rm(dir, { recursive: true, force: true });
      await removal.catch((error: unknown) => this.#log(MESSAGE.sweep(dir, errorMessage(error))));
    }
    return killed;
  }

  /** Kills the group a pidfile names when that pid still started when the pidfile says; true when it did. */
  async #killOrphan(dir: string): Promise<boolean> {
    const text = await readRegularFile(path.join(dir, PIDFILE), PIDFILE_MAX_BYTES).catch(() => null);
    const record = text ? pidRecord(text.toString("utf8")) : null;
    if (!record) return false;
    const now = await (this.#options.startedAt ?? processStartedAt)(record.pid).catch(() => null);
    if (now === null || now !== record.lstart) return false;
    // A POSIX game leads its own process group; on Windows the pid is the launcher, whose job ends the game.
    this.#signal(path.basename(dir), this.#onWindows() ? record.pid : -record.pid, "SIGKILL");
    return true;
  }

  // ── status ────────────────────────────────────────────────────────────────────────────────

  /** The newest run of `project` in `mode` that has not ended. */
  #newest(project: string, mode: NativeRunMode): RunEntry | null {
    let found: RunEntry | null = null;
    for (const entry of this.#runs.values()) {
      const match = entry.status.project === project && entry.status.mode === mode;
      if (match && !entry.finished) found = entry;
    }
    return found;
  }

  #set(entry: RunEntry, patch: Partial<NativeRunStatus>): void {
    entry.status = { ...entry.status, ...patch };
    this.#emit(entry);
  }

  #emit(entry: RunEntry): void {
    this.#options.emit(uiEvent(UiEvent.NativeStatus, copyStatus(entry.status)));
    for (const listener of this.#statusListeners) {
      try {
        listener(copyStatus(entry.status));
      } catch (error) {
        this.#log(MESSAGE.listener(errorMessage(error)));
      }
    }
  }

  #log(line: string): void {
    (this.#options.log ?? console.warn)(line);
  }
}
