/**
 * The `native-game` fixture's seam: a scripted native registry that stands in for real game
 * processes, so the native run card renders in a fixture profile without a window. It holds the
 * cpp-game fixture's two games: pong-mac's Mac window already runs (no process, no port), pong-cpp
 * has none. Stop ends a run and announces `stopping`, then `stopped`, as the real registry does.
 * It starts nothing: Play on Mac and Bring to front are refused before it by the fixture policy
 * (`native-policy.ts`), and a start that still reaches it (an agent's lease) is refused typed.
 *
 * Live's Native view is scripted too (its four channels are fixture-safe): embed answers a ready
 * embedded run with no process and no frames, and the input, resizes and sight it then receives are
 * said in that run's `native.log` (`embed: 1280x720 @2`, `input: tap`, `resize: …`, `hidden`, `shown`), so a
 * fixture run can read what Live sent.
 *
 * The `cross-game` fixture's seed is here too: the cpp-game fixture plus pong-cross, made for all
 * four destinations (so on a Mac its Export for list offers Browser, Mac, Windows and Linux), whose
 * library holds the checks the lane records after cross-building it on a Mac (Windows admitted and
 * not run here, Linux refused by the ELF gate). No build runs, and no export: `studio:export` is
 * native, refused in a fixture profile.
 */
import { BuildTarget, GameStack } from "../../shared/game-project.ts";
import { DestinationBadge } from "../../shared/game-targets.ts";
import {
  type DestinationCheck,
  NativeBackend,
  NativeError,
  type NativeInputAction,
  NativeRefusal,
  NativeRunMode,
  NativeRunState,
  type NativeRunStatus,
} from "../../shared/native-contract.ts";
import { UiEvent } from "../../shared/ui-events.ts";
import type {
  NativeEmbedRequest,
  NativeRun,
  NativeRunsHost,
  NativeRunsOptions,
  NativeStartRequest,
  NativeSurfaceSize,
} from "../core/native-runs.ts";
import type { NativeGamePort } from "../../substrate/native-game-port.ts";
import { readCurrentLock } from "../../substrate/toolchain-store/lock.ts";
import type { StudioCore } from "../studio-core.ts";
import { FixtureName } from "./fixture-kit.ts";
import { FIXTURE_CPP_GAMES, seedCppGame } from "./fixture-toolchains.ts";
import { ScaffoldCaller } from "../../substrate/game-workspace.ts";

const MESSAGE = {
  noGame: "The native-game fixture starts no game: its runs are scripted.",
  input: (actions: readonly NativeInputAction[]) => `input: ${actions.map((action) => action.type).join(", ")}`,
  resize: (surface: NativeSurfaceSize) => `resize: ${surface.width}x${surface.height} @${surface.dpr}`,
  embed: (surface: NativeSurfaceSize) => `embed: ${surface.width}x${surface.height} @${surface.dpr}`,
  hidden: "hidden",
  shown: "shown",
} as const;

/** Whether a fixture game is made for the Mac alone. */
function macOnly(game: { targets: readonly BuildTarget[] }): boolean {
  return !game.targets.includes(BuildTarget.Web);
}

/** The game whose window the fixture shows running: the Mac-only one (pong-mac). */
const RUNNING_GAME = FIXTURE_CPP_GAMES.find(macOnly)?.name ?? "pong-mac";

/** States a run has ended in. */
const ENDED: ReadonlySet<NativeRunState> = new Set([
  NativeRunState.Stopped,
  NativeRunState.Crashed,
  NativeRunState.Killed,
  NativeRunState.Refused,
]);

/** Whether `run` is `project`'s live run in `mode`. */
function liveRunOf(run: NativeRunStatus, project: string, mode: NativeRunMode): boolean {
  if (run.project !== project || run.mode !== mode) return false;
  return !ENDED.has(run.state);
}

/** A scripted registry: in-memory runs, each change announced as `native.status`. */
class ScriptedNativeRuns implements NativeRunsHost {
  readonly #options: Pick<NativeRunsOptions, "emit" | "timers">;
  /** Every run it knows, by run id. */
  readonly #runs = new Map<string, NativeRunStatus>();
  readonly #statusListeners = new Set<(run: NativeRunStatus) => void>();
  /** Embedded runs scripted so far, for their run ids. */
  #embeds = 0;

  constructor(options: Pick<NativeRunsOptions, "emit" | "timers">) {
    this.#options = options;
    const at = this.#iso();
    this.#announce({
      project: RUNNING_GAME,
      runId: `fixture-${RUNNING_GAME}-window`,
      target: BuildTarget.Mac,
      state: NativeRunState.Ready,
      mode: NativeRunMode.Window,
      pid: null,
      backend: NativeBackend.MetalAngle,
      refusal: null,
      problem: null,
      exit: null,
      owner: null,
      startedAt: at,
      endedAt: null,
    });
  }

  /** Nothing starts in a fixture profile. */
  async start(_request: NativeStartRequest): Promise<NativeRun> {
    throw new NativeError(NativeRefusal.Unsupported, MESSAGE.noGame);
  }

  /** Stopping, then stopped: what the real registry announces for a game that quits when asked. */
  async stop(runId: string): Promise<void> {
    const run = this.#runs.get(runId);
    if (!run || ENDED.has(run.state)) return;
    this.#announce({ ...run, state: NativeRunState.Stopping });
    this.#announce({
      ...run,
      state: NativeRunState.Stopped,
      pid: null,
      exit: { code: 0, signal: null },
      endedAt: this.#iso(),
    });
  }

  /** A ready embedded run with no process: the game's run before it ends first, as in the real registry. */
  async embed(request: NativeEmbedRequest): Promise<NativeRunStatus> {
    const before = this.state(request.project, NativeRunMode.Embedded);
    if (before) await this.stop(before.runId);
    this.#embeds += 1;
    const status: NativeRunStatus = {
      project: request.project,
      runId: `fixture-${request.project}-embedded-${this.#embeds}`,
      target: request.target,
      state: NativeRunState.Ready,
      mode: NativeRunMode.Embedded,
      pid: null,
      backend: NativeBackend.MetalAngle,
      refusal: null,
      problem: null,
      exit: null,
      owner: null,
      startedAt: this.#iso(),
      endedAt: null,
    };
    this.#announce(status);
    this.#say(request.project, MESSAGE.embed(request.surface));
    return { ...status };
  }

  /** Said in the embedded run's log; false when there is none. */
  resize(project: string, surface: NativeSurfaceSize): boolean {
    return this.#say(project, MESSAGE.resize(surface));
  }

  /** Said in the embedded run's log; false when there is none. */
  async input(project: string, actions: NativeInputAction[]): Promise<boolean> {
    return this.#say(project, MESSAGE.input(actions));
  }

  /** Said in the embedded run's log. */
  showEmbedded(project: string, visible: boolean): void {
    this.#say(project, visible ? MESSAGE.shown : MESSAGE.hidden);
  }

  /** Ends the run killed with `refusal`, as the real registry's frames failure does. */
  kill(runId: string, refusal: NativeRefusal): void {
    const run = this.#runs.get(runId);
    if (!run || ENDED.has(run.state)) return;
    this.#announce({ ...run, state: NativeRunState.Killed, refusal, pid: null, endedAt: this.#iso() });
  }

  onStatus(listener: (run: NativeRunStatus) => void): () => void {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  async stopAll(): Promise<void> {
    await this.#stopWhere(() => true);
  }

  async stopAgentRuns(): Promise<void> {
    await this.#stopWhere((run) => run.mode === NativeRunMode.Headless);
  }

  async stopProject(project: string, modes: readonly NativeRunMode[]): Promise<void> {
    await this.#stopWhere((run) => run.project === project && modes.includes(run.mode));
  }

  async stopMode(mode: NativeRunMode): Promise<void> {
    await this.#stopWhere((run) => run.mode === mode);
  }

  async stopOwnedBy(owner: string): Promise<void> {
    await this.#stopWhere((run) => run.owner === owner);
  }

  /** The live run of `project` in `mode` (the window, by default), or null. */
  state(project: string, mode: NativeRunMode = NativeRunMode.Window): NativeRunStatus | null {
    for (const run of this.#runs.values()) if (liveRunOf(run, project, mode)) return run;
    return null;
  }

  /** A scripted run has no port. */
  portOf(_project: string, _mode?: NativeRunMode): NativeGamePort | null {
    return null;
  }

  /** Whether `project` has a window to raise; no window exists to raise. */
  async front(project: string): Promise<boolean> {
    return this.state(project) !== null;
  }

  async sweepOrphans(): Promise<number> {
    return 0;
  }

  /** A scripted window never gains focus. */
  onFocus(_listener: (run: NativeRunStatus, focused: boolean) => void): () => void {
    return () => {};
  }

  async #stopWhere(match: (run: NativeRunStatus) => boolean): Promise<void> {
    for (const run of [...this.#runs.values()]) if (match(run)) await this.stop(run.runId);
  }

  #announce(status: NativeRunStatus): void {
    this.#runs.set(status.runId, status);
    this.#options.emit({ type: UiEvent.NativeStatus, payload: { ...status } });
    for (const listener of this.#statusListeners) listener({ ...status });
  }

  /** One line in `project`'s embedded run's log; false when it has none. */
  #say(project: string, line: string): boolean {
    const run = this.state(project, NativeRunMode.Embedded);
    if (!run) return false;
    const payload = { project, runId: run.runId, lines: [line], truncated: false };
    this.#options.emit({ type: UiEvent.NativeLog, payload });
    return true;
  }

  #iso(): string {
    return new Date(this.#options.timers.now()).toISOString();
  }
}

/** The registry factory a fixture profile hands the core (`StudioCoreOptions.createNativeRuns`), or undefined. */
export function fixtureNativeRuns(
  fixture: string | undefined,
): ((options: NativeRunsOptions) => NativeRunsHost) | undefined {
  if (fixture !== FixtureName.NativeGame) return undefined;
  return (options) => new ScriptedNativeRuns(options);
}

/** The cross-game fixture's game: made for every destination, as Create game makes one, so every export is offered. */
export const FIXTURE_CROSS_GAME = {
  name: "pong-cross",
  title: "Pong everywhere",
  targets: [BuildTarget.Web, BuildTarget.Mac, BuildTarget.Windows, BuildTarget.Linux],
} as const;

/** When the fixture's checks say they were made: fixed, so a reused profile writes nothing new. */
const CROSS_CHECKED_AT = "2026-10-01T00:00:00.000Z";
/** The lock a check names when the fixture's store has none (12 hex, as a check records it). */
const NO_LOCK = "000000000000";
const LOCK_HEX = 12;

/** The checks a Mac's lane records for pong-cross: Windows built and admitted but not run here, Linux refused for linking libGL. */
function crossChecks(lock: string): Array<[BuildTarget, DestinationCheck]> {
  const at = CROSS_CHECKED_AT;
  return [
    [BuildTarget.Windows, { badge: DestinationBadge.NotRunHere, lock, at }],
    [BuildTarget.Linux, { badge: DestinationBadge.Failed, lock, at, refusal: NativeRefusal.ImportsLibGl }],
  ];
}

/**
 * The `cross-game` fixture's seed: the cpp-game fixture (its games and store), then pong-cross,
 * scaffolded once through the real path, and its checks written through the library as the lane
 * writes them. It runs on every launch; an unchanged check writes nothing.
 */
export async function seedCrossGame(core: StudioCore): Promise<void> {
  await seedCppGame(core);
  const game = FIXTURE_CROSS_GAME;
  if (!(await core.games.list()).some((listed) => listed.name === game.name)) {
    await core.games.scaffold(game.name, {
      title: game.title,
      stack: GameStack.RaylibCpp,
      caller: ScaffoldCaller.Internal,
      targets: [...game.targets],
    });
    await core.threadForGame(game.name);
  }
  const lock = (await readCurrentLock(core.layout.toolchains))?.digest.slice(0, LOCK_HEX) ?? NO_LOCK;
  for (const [target, check] of crossChecks(lock)) await core.games.writeNativeCheck(game.name, target, check);
}
