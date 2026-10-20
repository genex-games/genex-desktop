/**
 * A C++ game's own window: Play on Mac (native: a window on the desktop), its state, Stop and
 * Bring to front (native: it raises a desktop window); and its Mac build inside Live (embed,
 * unembed, input, resize: fixture-safe, no desktop window); and reads of a run's frame profile
 * and the game's crash records (fixture-safe, answering unavailable for now). Every handler first
 * checks that `project` names a game in the library, inside the allowed games root, and the
 * renderer's size, input or profile request against its shape (`parseNativeEmbedSize`,
 * `parseNativeInput`, `parseFrameProfileRequest`), and refuses anything else
 * before the registry is asked; then it delegates to `core.nativeRuns`. Input and resize, sent
 * once a frame, only reach a run embed started for a listed game: they check the name's shape and
 * go to the registry at once, so the game takes them in the order they were sent.
 *
 * Play and embed answer the run they started. The registry announces every change of that run as
 * it goes (`native.status`, sent before this answer), so a start that failed answers in the run's
 * own terms rather than as an error: a refusal (where Live cannot embed, a status with no run), or a
 * Stop the person asked for. An error crossing IPC keeps only its sentence, and the card already
 * says how the run ended.
 */
import { gameCrashesUnavailable } from "../../shared/crash-record.ts";
import { CustomEvent, customEventData } from "../../shared/custom-events.ts";
import { ProfileUnavailableReason, parseFrameProfileRequest, profileUnavailable } from "../../shared/frame-profile.ts";
import type { DeviceLaunchResult } from "../../shared/device-launch.ts";
import { BuildTarget, type GameProject } from "../../shared/game-project.ts";
import {
  NATIVE_NO_RUN_ID,
  NativeError,
  NativeRunMode,
  NativeRunState,
  type NativeRunStatus,
  parseNativeEmbedSize,
  parseNativeInput,
  ringSizeFor,
} from "../../shared/native-contract.ts";
import { NativeExitError } from "../../substrate/native-game-port.ts";
import {
  type DeviceLaunchDeps,
  type DeviceTools,
  hostDeviceTools,
  launchOnDevice,
  parseDeviceLaunchRequest,
  type AdmittedPackages,
} from "../core/device-launch.ts";
import type { NativeSurfaceSize } from "../core/native-runs.ts";
import type { StudioCore } from "../studio-core.ts";
import type { IpcHandle } from "./registrar.ts";

/** Why a native request is refused before the registry is asked. */
const MESSAGE = {
  noGame: "Open a game before playing it in its own window.",
  badSize: "Live's canvas size is not one a game can be shown at.",
  badInput: "That input is not one a game takes.",
  badProfile: "That is not a frame profile request a game takes.",
} as const;

/** The longest game name the library makes; anything longer is not one of its games. */
const PROJECT_NAME_MAX = 255;

/**
 * What the native registrar reaches: the registry, the library and the games-root check; for a
 * device launch also the exports root (`layout.exports`) and the event log it is recorded in.
 */
export type NativeIpcCore = Pick<StudioCore, "nativeRuns" | "games" | "assertProjectAllowed" | "layout" | "append">;

/** The clock a refused status is stamped with, and a device launch's host and tools (tests pass their own). */
export interface NativeIpcOptions {
  now?: () => number;
  /** The device launch's host, tools and admitted phone packages (tests stand them in). */
  device?: { host?: NodeJS.Platform; tools?: DeviceTools; packages?: AdmittedPackages | null };
}

/** How a start that ran no game ended, in a status's own fields. */
type Ending = Pick<NativeRunStatus, "state" | "refusal" | "problem" | "exit">;

/** The `key` field of a payload the renderer sent, whatever its shape; null when there is none. */
function field(payload: unknown, key: "project" | "size" | "actions" | "request"): unknown {
  const holds = typeof payload === "object" && payload !== null && Object.hasOwn(payload, key);
  return holds ? Reflect.get(payload, key) : null;
}

/** Whether `value` has the shape of a game's name: a plain folder name, never a path. */
function isProjectName(value: unknown): value is string {
  const named = typeof value === "string" && value.length > 0 && value.length <= PROJECT_NAME_MAX;
  return named && !/[/\\\0]/.test(value) && value !== "." && value !== "..";
}

/** `payload.project` with a game name's shape, unlisted: the registry runs only games embed listed; throws otherwise. */
function namedGame(payload: unknown): string {
  const project = field(payload, "project");
  if (!isProjectName(project)) throw new Error(MESSAGE.noGame);
  return project;
}

/** The game `payload.project` names in the library inside the allowed root; throws otherwise. */
async function listedProject(core: NativeIpcCore, payload: unknown): Promise<GameProject> {
  const project = namedGame(payload);
  const game = (await core.games.list()).find((item) => item.name === project);
  if (!game) throw new Error(MESSAGE.noGame);
  await core.assertProjectAllowed(game.dir);
  return game;
}

/** `payload.project` when it names a game in the library inside the allowed root; throws otherwise. */
async function listedGame(core: NativeIpcCore, payload: unknown): Promise<string> {
  return (await listedProject(core, payload)).name;
}

/** Whether `error` is an abort: the registry's Stop of a run still on its way. */
function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * How a start that failed with `error` ended, as the registry ends one: refused with its typed
 * refusal, stopped when Stop aborted it, or the game's own exit before it was ready (a clean exit
 * stopped, anything else crashed); null for anything else, which stays an error.
 */
function endingOf(error: unknown): Ending | null {
  if (error instanceof NativeError)
    return { state: NativeRunState.Refused, refusal: error.refusal, problem: error.problem, exit: null };
  if (isAbort(error)) return { state: NativeRunState.Stopped, refusal: null, problem: null, exit: null };
  if (error instanceof NativeExitError) {
    const closed = error.exit.code === 0 && error.exit.signal === null;
    const state = closed ? NativeRunState.Stopped : NativeRunState.Crashed;
    return { state, refusal: null, problem: null, exit: error.exit };
  }
  return null;
}

/**
 * The ring Live's canvas asks for: its checked CSS size in device pixels, capped (`ringSizeFor`),
 * with the screen's dpr. Throws for a size outside its shape.
 */
function surfaceOf(payload: unknown): NativeSurfaceSize {
  const size = parseNativeEmbedSize(field(payload, "size"));
  if (!size) throw new Error(MESSAGE.badSize);
  return { ...ringSizeFor(size), dpr: size.dpr };
}

/** A start's answer when it failed before the registry registered any run: a status of its own, with no run id. */
function failedBeforeAnyRun(project: string, mode: NativeRunMode, error: unknown, at: string): NativeRunStatus | null {
  const ending = endingOf(error);
  if (!ending) return null;
  return {
    project,
    runId: NATIVE_NO_RUN_ID,
    target: BuildTarget.Mac,
    mode,
    pid: null,
    backend: null,
    owner: null,
    ...ending,
    startedAt: at,
    endedAt: at,
  };
}

/**
 * A start's answer when the start of `opened` failed with `error`, or null to say it as an error.
 * Once the run ended, its last word (`last`, heard as the registry announced it) is the answer,
 * exactly. While it is still ending, its live status is, and its last word follows. A run whose
 * end was never heard answers the ending `error` names.
 */
function failedStart(
  core: NativeIpcCore,
  opened: NativeRunStatus,
  failed: { error: unknown; last: NativeRunStatus | null },
  at: string,
): NativeRunStatus | null {
  if (failed.last?.endedAt) return failed.last;
  const live = core.nativeRuns.state(opened.project, opened.mode);
  if (live?.runId === opened.runId) return live;
  const ending = endingOf(failed.error);
  return ending ? { ...opened, ...ending, pid: null, endedAt: at } : null;
}

/**
 * What a start answers: the run's status once it is ready, or how it ended in the run's own terms.
 * The registry registers a run at once (so a second Play finds it): `opened` is read right after the
 * start was asked for, and a failed start's answer is about that run.
 */
async function startAnswer(
  core: NativeIpcCore,
  project: string,
  mode: NativeRunMode,
  starting: Promise<NativeRunStatus>,
  at: () => string,
): Promise<NativeRunStatus> {
  const opened = core.nativeRuns.state(project, mode);
  let last: NativeRunStatus | null = null;
  const stopListening = core.nativeRuns.onStatus((status) => {
    if (status.runId === opened?.runId) last = status;
  });
  try {
    return await starting;
  } catch (error) {
    const answer = opened
      ? failedStart(core, opened, { error, last }, at())
      : failedBeforeAnyRun(project, mode, error, at());
    if (answer) return answer;
    throw error;
  } finally {
    stopListening();
  }
}

/**
 * The embedded run's four channels. Embed starts the game inside Live (the registry ends its
 * embedded run before); unembed stops it; input and resize reach it, and answer false when there
 * is none. Where Live cannot embed, embed answers a refused status with no run.
 */
function registerEmbedIpc(handle: IpcHandle, core: NativeIpcCore, iso: () => string): void {
  handle("studio:native.embed", async (payload) => {
    const project = await listedGame(core, payload);
    const surface = surfaceOf(payload);
    const embedding = core.nativeRuns.embed({ project, target: BuildTarget.Mac, surface });
    return startAnswer(core, project, NativeRunMode.Embedded, embedding, iso);
  });
  handle("studio:native.unembed", async (payload) => {
    const running = core.nativeRuns.state(await listedGame(core, payload), NativeRunMode.Embedded);
    if (!running) return false;
    await core.nativeRuns.stop(running.runId);
    return true;
  });
  // No await before the registry: each call reaches the game's port in the order it was sent.
  handle("studio:native.input", async (payload) => {
    const project = namedGame(payload);
    const actions = parseNativeInput(field(payload, "actions"));
    if (!actions) throw new Error(MESSAGE.badInput);
    return core.nativeRuns.input(project, actions);
  });
  handle("studio:native.resize", async (payload) => {
    const project = namedGame(payload);
    return core.nativeRuns.resize(project, surfaceOf(payload));
  });
}

/**
 * Registers the eleven channels: the window's four, the profile and crash reads, the embedded
 * run's four and the person's device launch.
 */
export function registerNativeIpc(handle: IpcHandle, core: NativeIpcCore, options: NativeIpcOptions = {}): void {
  const iso = () => new Date(options.now?.() ?? Date.now()).toISOString();
  handle("studio:native.run", async (payload) => {
    const project = await listedGame(core, payload);
    const mode = NativeRunMode.Window;
    const starting = core.nativeRuns.start({ project, target: BuildTarget.Mac, mode }).then((run) => run.status);
    return startAnswer(core, project, mode, starting, iso);
  });
  handle("studio:native.stop", async (payload) => {
    const running = core.nativeRuns.state(await listedGame(core, payload), NativeRunMode.Window);
    if (!running) return false;
    await core.nativeRuns.stop(running.runId);
    return true;
  });
  handle("studio:native.state", async (payload) =>
    core.nativeRuns.state(await listedGame(core, payload), NativeRunMode.Window),
  );
  handle("studio:native.front", async (payload) => core.nativeRuns.front(await listedGame(core, payload)));
  registerProfileAndCrashesIpc(handle, core);
  registerDeviceLaunchIpc(handle, core, { ...options, iso });
  registerEmbedIpc(handle, core, iso);
}

/** The run of `project` Live or its window shows, embedded first; null when none runs. */
function shownRun(core: NativeIpcCore, project: string): NativeRunStatus | null {
  return core.nativeRuns.state(project, NativeRunMode.Embedded) ?? core.nativeRuns.state(project, NativeRunMode.Window);
}

/**
 * A game's frame profile and crash records, both fixture-safe reads. The game and the request are
 * checked first; until the host reads profiles (PROF-6) and keeps records (CRASH-5) each answers
 * `unavailable`: a profile `no-run` when no run is shown, else `not-served`.
 */
function registerProfileAndCrashesIpc(handle: IpcHandle, core: NativeIpcCore): void {
  handle("studio:native.profile", async (payload) => {
    const project = await listedGame(core, payload);
    if (!parseFrameProfileRequest(field(payload, "request"))) throw new Error(MESSAGE.badProfile);
    const reason = shownRun(core, project) ? ProfileUnavailableReason.NotServed : ProfileUnavailableReason.NoRun;
    return profileUnavailable(reason);
  });
  handle("studio:game.crashes", async (payload) => {
    await listedGame(core, payload);
    return gameCrashesUnavailable();
  });
}

/**
 * The person's launch on a Simulator, emulator or phone (containment stage 1: the one run outside
 * ProcessSandbox, so it is this native channel alone, refused in fixtures, and no harness method).
 * A request the host takes is launched and recorded as a `device_launch` event, refused or not;
 * a malformed request or an unlisted game is an error and records nothing.
 */
function registerDeviceLaunchIpc(
  handle: IpcHandle,
  core: NativeIpcCore,
  options: NativeIpcOptions & { iso: () => string },
): void {
  const host = options.device?.host ?? process.platform;
  const tools = options.device?.tools ?? hostDeviceTools(host);
  handle("studio:native.launchDevice", async (payload) => {
    const game = await listedProject(core, payload);
    const request = parseDeviceLaunchRequest(field(payload, "request"));
    const deps: DeviceLaunchDeps = {
      host,
      // The phone packages the exports admitted (`StudioCore.phonePackages`, passed by main); a
      // registrar given none refuses every launch `unsupported` before any device tool runs.
      packages: options.device?.packages ?? null,
      bundleIdFor: (project) => core.games.bundleIdFor(project),
      tools,
      at: options.iso,
    };
    const result: DeviceLaunchResult = await launchOnDevice(deps, game, request);
    await core.append([customEventData(CustomEvent.DeviceLaunch, { project: game.name, ...result })]);
    return result;
  });
}
