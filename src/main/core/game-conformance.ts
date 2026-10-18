/**
 * The game conformance suite (extension ladder, M7.0): behaviour checks any built Rust · wgpu game
 * must pass, however far it extends the engine. It speaks to the game only through its protocol
 * port (`substrate/native-game-port.ts`) and the process it runs as:
 *
 * - `verbs`: every contract verb answers in its shape and says what it did, refusals included (an
 *   unknown camera or demo answers `ok: false` with what exists);
 * - `seed-determinism`: the same seed and demo in two runs of the game give the same state checksum
 *   and capture digest;
 * - `capture-digest`: the FNV-1a of the capture file the game wrote is the digest it reported, and
 *   the file is a regular file in the run's own captures folder of exactly `width × height × 4` bytes;
 * - `live-ring`: on a Mac, Live's ring delivers frames with a strictly increasing seq on the ring's
 *   own generation; elsewhere, or with no frames host, `unavailable` (counted green by
 *   `conformancePassed` until a caller has a frames host: not judged yet);
 * - `stop-reap`: Stop ends the game on `quit` within `NATIVE_STOP_BUDGET_MS`, its group reaped and no
 *   process it started left behind. A game that had already ended when Stop came (a check's reply
 *   made the port end it) is judged on its leftovers only: its failure is that check's;
 * - `render-extensions` and `render-presets` (`game-conformance-render.ts`): a game whose `ready`
 *   receipt advertises `renderSettings` keeps its custom passes and typed degrades under every preset
 *   and an emulated phone class, and serves every preset and phone class (temporal features on)
 *   with a round-tripping verb, a `volatile.render` in shape, settled reproducible captures, one look
 *   from low to high and a pinned profile across the two runs' cold boots. A game without the verb
 *   (C++, a Rust game built before it) is `unavailable` with `render-settings-unsupported` on both,
 *   counted green.
 *
 * Both runs must start the same build: two builds (the folder changed between the launches) fail
 * `seed-determinism` with `build-changed`, so a green report never rests on another build's runs.
 *
 * Launching and stopping are injected (`ConformanceDeps`): `registryLauncher` runs the game through
 * the native run registry (the harness's `HostMethod.GameConformance`), and `stopGameChild` stops a
 * game the caller spawned itself the way the registry does (`npm run conformance:game`, the tests).
 */
import { lstat } from "node:fs/promises";
import path from "node:path";
import { setImmediate, setTimeout as sleep } from "node:timers/promises";
import { SECOND_MS } from "../../shared/duration.ts";
import {
  CONFORMANCE_CHECKS,
  CONFORMANCE_SEED,
  ConformanceCheck,
  type ConformanceCheckResult,
  ConformanceOutcome,
  ConformanceProblem,
  conformancePassed,
  type GameConformanceReport,
} from "../../shared/game-conformance.ts";
import { BuildTarget } from "../../shared/game-project.ts";
import {
  NATIVE_CAPTURE_MAX_BYTES,
  NATIVE_QUIT_GRACE_MS,
  NATIVE_REAP_MARGIN_MS,
  NATIVE_STOP_BUDGET_MS,
  NATIVE_TERM_GRACE_MS,
  NativeOp,
  NativeRunState,
  type NativeRunStatus,
} from "../../shared/native-contract.ts";
import { readRegularFile } from "../../substrate/fsx.ts";
import { fnv1a64Hex, type NativeGamePort } from "../../substrate/native-game-port.ts";
import { descendants as processDescendants } from "../../substrate/plugins/native-process.ts";
import type { GameChild } from "../../substrate/spawn.ts";
import {
  type ColdCapture,
  checkRenderExtensions,
  checkRenderPresets,
  judgeColdBoots,
} from "./game-conformance-render.ts";
import { always, asFailure, CheckFailure, failed, judged, passed, result, verb } from "./game-conformance-verdict.ts";
import type { NativeRunsHost, NativeStartRequest } from "./native-runs.ts";

/** How long the determinism run steps a game that lists no demo. */
const DETERMINISM_STEP_MS = SECOND_MS;
/** How long the verbs check steps. */
const VERB_STEP_MS = 50;
/** A camera and demo name no game registers (names are at most 64 characters): its answer must be a refusal. */
const NO_SUCH_NAME = "genex-conformance-no-such-name";
/** The camera every game has (`studio::DEFAULT_CAMERA`). */
const DEFAULT_CAMERA = "default";
/** Frames Live's ring must deliver, and how long it has. */
export const LIVE_FRAMES_WANTED = 30;
export const LIVE_FRAMES_WITHIN_MS = 3 * SECOND_MS;
/** How often a stopped game's leftovers are looked for within `NATIVE_REAP_MARGIN_MS`. */
const REAP_POLL_MS = 50;
/** The folders under a run's `state/` a capture is read from. */
const CAPTURES_FOLDER = "captures";
const CAPTURE_EXTENSION = ".bgra";
/** Bytes per BGRA pixel. */
const BGRA_BYTES = 4;

const MESSAGE = {
  launch: (why: string) => `the game did not start: ${why}`,
  demoMissing: (demo: string) => `the game lists no demo "${demo}"`,
  checksum: "state() carries no checksum",
  differs: (what: string, first: string, second: string) => `${what}: ${first} then ${second}`,
  captureSize: (got: number, want: number) => `the capture file has ${got} bytes; its size says ${want}`,
  captureDigest: (got: string, want: string) => `the capture file hashes to ${got}; the game reported ${want}`,
  captureFolder: "the capture is not a regular file in the run's own captures folder",
  liveNotMac: "Live embeds Mac builds only",
  liveNoHost: "no frames host here",
  ringFrames: (got: number, want: number, ms: number) => `${got} frames in ${ms} ms; the check waits for ${want}`,
  ringSeq: (before: number, after: number) => `seq ${after} came after ${before}`,
  ringGeneration: (got: number, want: number) => `a frame of generation ${got} on ring ${want}`,
  orphans: (pids: readonly number[]) => `left running after the game ended: ${pids.join(", ")}`,
  buildChanged: (first: string | null, second: string | null) =>
    `the two runs started different builds: ${first ?? "unknown"} then ${second ?? "unknown"}`,
  stopTook: (ms: number) => `reaped ${ms} ms after Stop (budget ${NATIVE_STOP_BUDGET_MS} ms)`,
  stopIgnored: "the game did not end on quit: its group was signalled",
  web: "the web build's suite runs in the browser preview, not here yet",
} as const;

/** The port the suite speaks to: a native run's protocol port, and its `ready` (the receipt). */
export type ConformancePort = Pick<NativeGamePort, "call" | "screenshotWithStats" | "ready">;

/** How a stop went, as the stopper saw it. */
export interface ConformanceStop {
  /** `quit` alone did not end the game: its group was signalled. */
  escalated: boolean;
  /** The game had already ended (or been ended by the host) before Stop was asked: Stop is not judged. */
  ended?: boolean;
}

/** One started game the suite speaks to. */
export interface ConformanceLaunch {
  port: ConformancePort;
  /** The game's pid (its process group's id), or null where the launcher does not know it. */
  pid: number | null;
  /** The run's `state/`, when the launcher knows it: the suite reads each capture file itself. */
  stateDir: string | null;
  /** The admitted build's SHA-256, when known. */
  buildDigest: string | null;
  /** Stops the game the way the studio does: `quit`, then its group signalled. */
  stop(): Promise<ConformanceStop>;
}

/** One frame Live's ring delivered. */
export interface LiveRingFrame {
  seq: number;
  generation: number;
}

/** What watching Live's ring found: its frames, or why it could not be watched here. */
export type LiveRingObservation =
  | { available: false; code: ConformanceProblem }
  | { available: true; generation: number; frames: LiveRingFrame[] };

/** Watches a game's frames on Live's ring (an embedded run of its own). */
export interface LiveRingProbe {
  observe(wanted: { frames: number; withinMs: number }): Promise<LiveRingObservation>;
}

/** What the suite reaches, injected. */
export interface ConformanceDeps {
  /** Starts the game once (ready, or rejects). Called once per run the suite needs. */
  launch(): Promise<ConformanceLaunch>;
  /** The host's platform: the Live ring is watched on a Mac only. */
  platform: NodeJS.Platform;
  now(): number;
  /** Live's ring, where a frames host can be borrowed; absent or null: `unavailable`. */
  liveRing?: LiveRingProbe | null;
  /** A pid's descendants (default: `ps`). */
  descendants?(pid: number): Promise<number[]>;
  /** Whether a pid, or a group as `-pgid`, still has a process (default: signal 0). */
  alive?(pid: number): boolean;
  /** Ends a leftover pid, or a group as `-pgid` (default: SIGKILL). */
  kill?(pid: number): void;
  sleep?(ms: number): Promise<void>;
}

/** What one suite run judges. */
export interface ConformanceRequest {
  project: string | null;
  target: BuildTarget;
  /** The demo the determinism runs play; the game's first when absent, a fixed step when it lists none. */
  demo?: string | null;
  seed?: number;
}

/** One verb the verbs check sends: what it calls and what its answer must say. */
type VerbCase = (port: ConformancePort, seed: number) => Promise<unknown>;

/** A verb case whose answer is typed by its op. */
function verbCase<T>(
  op: string,
  call: (port: ConformancePort, seed: number) => Promise<T>,
  valid: (answer: T, seed: number) => boolean,
): VerbCase {
  return (port, seed) =>
    verb(
      op,
      () => call(port, seed),
      (answer) => valid(answer, seed),
    );
}

/**
 * Every contract verb but `capture` (its own check), `quit` (Stop's) and the ring's (Live's), in
 * the order sent: an unknown camera or demo must be refused with what exists.
 */
const VERB_CASES: readonly VerbCase[] = [
  verbCase(
    NativeOp.Seed,
    (port, seed) => port.call(NativeOp.Seed, { seed }),
    (r, seed) => r.seed === seed && r.paused,
  ),
  verbCase(
    NativeOp.Start,
    (port) => port.call(NativeOp.Start),
    (r) => r.running,
  ),
  verbCase(
    NativeOp.Pause,
    (port) => port.call(NativeOp.Pause),
    (r) => !r.running,
  ),
  verbCase(
    NativeOp.Step,
    (port) => port.call(NativeOp.Step, { ms: VERB_STEP_MS }),
    (r) => r.steppedFrames >= 1,
  ),
  verbCase(NativeOp.State, (port) => port.call(NativeOp.State), always),
  verbCase(
    NativeOp.Input,
    (port) => port.call(NativeOp.Input, { actions: [] }),
    (r) => r.held.length === 0,
  ),
  verbCase(NativeOp.Cameras, (port) => port.call(NativeOp.Cameras), always),
  verbCase(NativeOp.Eyes, (port) => port.call(NativeOp.Eyes), always),
  verbCase(NativeOp.Demos, (port) => port.call(NativeOp.Demos), always),
  verbCase(
    NativeOp.DebugCamera,
    (port) => port.call(NativeOp.DebugCamera, { camera: DEFAULT_CAMERA }),
    (r) => r.ok,
  ),
  verbCase(
    NativeOp.DebugCamera,
    (port) => port.call(NativeOp.DebugCamera, { camera: NO_SUCH_NAME }),
    (r) => !r.ok && Array.isArray(r.available),
  ),
  verbCase(
    NativeOp.Demo,
    (port) => port.call(NativeOp.Demo, { name: NO_SUCH_NAME }),
    (r) => !r.ok && Array.isArray(r.available),
  ),
  verbCase(
    NativeOp.Audio,
    (port) => port.call(NativeOp.Audio, { muted: true }),
    (r) => r.muted,
  ),
  verbCase(
    NativeOp.Audio,
    (port) => port.call(NativeOp.Audio, { muted: false }),
    (r) => !r.muted,
  ),
  verbCase(NativeOp.AudioLevel, (port) => port.call(NativeOp.AudioLevel), always),
  verbCase(NativeOp.Timing, (port) => port.call(NativeOp.Timing), always),
  verbCase(NativeOp.Front, (port) => port.call(NativeOp.Front), always),
  verbCase(NativeOp.Visible, (port) => port.call(NativeOp.Visible, { visible: true }), always),
];

/** The verbs check: every case in order; the first that fails names its verb. */
async function checkVerbs(port: ConformancePort, seed: number): Promise<void> {
  for (const sent of VERB_CASES) await sent(port, seed);
}

/** What one seeded run ended on: its first capture after boot, so also a cold boot's (`render-presets`). */
type SeededRun = ColdCapture;

/** The demo both determinism runs play: the named one, else the game's first, else none (a fixed step). */
async function demoToPlay(port: ConformancePort, named: string | null): Promise<string | null> {
  if (named) return named;
  const listed = await verb(
    NativeOp.Demos,
    () => port.call(NativeOp.Demos),
    () => true,
  );
  return listed.demos[0] ?? null;
}

/** Seed, play the demo (or step), then the state checksum and a capture's digest. */
async function seededRun(port: ConformancePort, seed: number, named: string | null): Promise<SeededRun> {
  const demo = await demoToPlay(port, named);
  await verb(
    NativeOp.Seed,
    () => port.call(NativeOp.Seed, { seed }),
    (r) => r.seed === seed,
  );
  if (demo) {
    const played = await verb(
      NativeOp.Demo,
      () => port.call(NativeOp.Demo, { name: demo }),
      () => true,
    );
    if (!played.ok) throw new CheckFailure(ConformanceProblem.DemoMissing, MESSAGE.demoMissing(demo));
  } else {
    await verb(
      NativeOp.Step,
      () => port.call(NativeOp.Step, { ms: DETERMINISM_STEP_MS }),
      () => true,
    );
  }
  const state = await verb(
    NativeOp.State,
    () => port.call(NativeOp.State),
    () => true,
  );
  const { checksum } = state;
  const stated = typeof checksum === "string" || typeof checksum === "number";
  if (!stated) throw new CheckFailure(ConformanceProblem.ChecksumMissing, MESSAGE.checksum);
  const shot = await verb(
    NativeOp.Capture,
    () => port.call(NativeOp.Capture, {}),
    () => true,
  );
  return { checksum: String(checksum), digest: shot.digest, render: shot.render ?? null };
}

/** A seeded run, or the failure that stopped it. */
async function trySeededRun(
  port: ConformancePort,
  seed: number,
  demo: string | null,
): Promise<SeededRun | CheckFailure> {
  try {
    return await seededRun(port, seed, demo);
  } catch (error) {
    return asFailure(error);
  }
}

/** The determinism check over the two runs' endings. */
function compareRuns(first: SeededRun | CheckFailure, second: SeededRun | CheckFailure): ConformanceCheckResult {
  const check = ConformanceCheck.SeedDeterminism;
  if (first instanceof CheckFailure) return failed(check, first);
  if (second instanceof CheckFailure) return failed(check, second);
  if (first.checksum !== second.checksum) {
    const detail = MESSAGE.differs("checksum", first.checksum, second.checksum);
    return result(check, ConformanceOutcome.Fail, ConformanceProblem.Nondeterministic, detail);
  }
  if (first.digest !== second.digest) {
    const detail = MESSAGE.differs("capture digest", first.digest, second.digest);
    return result(check, ConformanceOutcome.Fail, ConformanceProblem.Nondeterministic, detail);
  }
  return passed(check);
}

/** Whether `dir` is a real folder (never a link to one). */
async function isRealFolder(dir: string): Promise<boolean> {
  const stat = await lstat(dir).catch(() => null);
  return stat?.isDirectory() === true;
}

/** The capture file the reply names, read the host's way (no links, regular only, capped). */
async function captureBytes(stateDir: string, seq: number): Promise<Buffer> {
  const folder = path.join(stateDir, CAPTURES_FOLDER);
  const real = (await isRealFolder(stateDir)) && (await isRealFolder(folder));
  if (!real) throw new CheckFailure(ConformanceProblem.CaptureFile, MESSAGE.captureFolder);
  try {
    return await readRegularFile(path.join(folder, `${seq}${CAPTURE_EXTENSION}`), NATIVE_CAPTURE_MAX_BYTES);
  } catch {
    throw new CheckFailure(ConformanceProblem.CaptureFile, MESSAGE.captureFolder);
  }
}

/** The capture check: the file the game wrote is the one its digest names. */
async function checkCapture(launch: ConformanceLaunch): Promise<void> {
  const { port, stateDir } = launch;
  if (stateDir === null) {
    // No run folder to read: the port reads the file itself and refuses a size or digest it was not told.
    await verb(
      NativeOp.Capture,
      () => port.screenshotWithStats(),
      () => true,
    );
    return;
  }
  const reply = await verb(
    NativeOp.Capture,
    () => port.call(NativeOp.Capture, {}),
    () => true,
  );
  const bytes = await captureBytes(stateDir, reply.seq);
  const declared = reply.width * reply.height * BGRA_BYTES;
  if (bytes.length !== declared)
    throw new CheckFailure(ConformanceProblem.CaptureFile, MESSAGE.captureSize(bytes.length, declared));
  const digest = fnv1a64Hex(bytes);
  if (digest !== reply.digest)
    throw new CheckFailure(ConformanceProblem.CaptureDigest, MESSAGE.captureDigest(digest, reply.digest));
}

/** The frames' problems, or null: enough of them, each seq above the last, all on the ring's generation. */
function ringProblem(observed: { generation: number; frames: LiveRingFrame[] }): CheckFailure | null {
  const { generation, frames } = observed;
  if (frames.length < LIVE_FRAMES_WANTED) {
    const detail = MESSAGE.ringFrames(frames.length, LIVE_FRAMES_WANTED, LIVE_FRAMES_WITHIN_MS);
    return new CheckFailure(ConformanceProblem.RingNoFrames, detail);
  }
  let last = -1;
  for (const frame of frames) {
    if (generation < 1 || frame.generation !== generation)
      return new CheckFailure(ConformanceProblem.RingGeneration, MESSAGE.ringGeneration(frame.generation, generation));
    if (frame.seq <= last) return new CheckFailure(ConformanceProblem.RingSeq, MESSAGE.ringSeq(last, frame.seq));
    last = frame.seq;
  }
  return null;
}

/** Live's ring on a Mac; `unavailable` anywhere else or with no frames host, never a pass. */
async function checkLiveRing(deps: ConformanceDeps): Promise<ConformanceCheckResult> {
  const check = ConformanceCheck.LiveRing;
  if (deps.platform !== "darwin")
    return result(check, ConformanceOutcome.Unavailable, ConformanceProblem.LiveNotMac, MESSAGE.liveNotMac);
  if (!deps.liveRing)
    return result(check, ConformanceOutcome.Unavailable, ConformanceProblem.LiveNoFramesHost, MESSAGE.liveNoHost);
  let observed: LiveRingObservation;
  try {
    observed = await deps.liveRing.observe({ frames: LIVE_FRAMES_WANTED, withinMs: LIVE_FRAMES_WITHIN_MS });
  } catch (error) {
    return failed(check, new CheckFailure(ConformanceProblem.LaunchFailed, MESSAGE.launch(asFailure(error).message)));
  }
  if (!observed.available) return result(check, ConformanceOutcome.Unavailable, observed.code, null);
  const problem = ringProblem(observed);
  return problem ? failed(check, problem) : passed(check);
}

/** The process checks Stop's verdict needs, with their defaults. */
function processDeps(deps: ConformanceDeps) {
  return {
    descendants: deps.descendants ?? processDescendants,
    alive: deps.alive ?? signalZero,
    kill: deps.kill ?? killQuietly,
    sleep: deps.sleep ?? ((ms: number) => sleep(ms)),
  };
}

/** Whether a pid (or a group, `-pgid`) still has a process. */
function signalZero(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, it is just not ours to signal.
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function killQuietly(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

/** Stops one launch and judges it: ended on quit, reaped within the budget, nothing left behind. */
async function stopAndReap(deps: ConformanceDeps, launch: ConformanceLaunch): Promise<ConformanceCheckResult> {
  const check = ConformanceCheck.StopReap;
  const io = processDeps(deps);
  const { pid } = launch;
  const tree = pid === null ? [] : await io.descendants(pid).catch(() => [] as number[]);
  const started = deps.now();
  let stopped: ConformanceStop;
  try {
    stopped = await launch.stop();
  } catch (error) {
    return failed(check, error);
  }
  const took = deps.now() - started;
  const watched = pid === null ? tree : [-pid, ...tree];
  let left = watched.filter(io.alive);
  for (let waited = 0; left.length > 0 && waited < NATIVE_REAP_MARGIN_MS; waited += REAP_POLL_MS) {
    await io.sleep(REAP_POLL_MS);
    left = left.filter(io.alive);
  }
  for (const leftover of left) io.kill(leftover);
  const orphans = left.map(Math.abs);
  if (orphans.length > 0)
    return result(check, ConformanceOutcome.Fail, ConformanceProblem.Orphan, MESSAGE.orphans(orphans));
  if (stopped.ended === true) return passed(check);
  if (took > NATIVE_STOP_BUDGET_MS)
    return result(check, ConformanceOutcome.Fail, ConformanceProblem.StopDeadline, MESSAGE.stopTook(took));
  if (stopped.escalated)
    return result(check, ConformanceOutcome.Fail, ConformanceProblem.StopIgnored, MESSAGE.stopIgnored);
  return passed(check);
}

/** `build-changed` when the second run started another build than the first; null when they agree (or it never started). */
function sameBuild(first: ConformanceLaunch, second: ConformanceLaunch | CheckFailure): ConformanceCheckResult | null {
  if (second instanceof CheckFailure || second.buildDigest === first.buildDigest) return null;
  const detail = MESSAGE.buildChanged(first.buildDigest, second.buildDigest);
  return result(ConformanceCheck.SeedDeterminism, ConformanceOutcome.Fail, ConformanceProblem.BuildChanged, detail);
}

/** The first failure among `results`, else the first of them. */
const worst = (results: readonly ConformanceCheckResult[]): ConformanceCheckResult =>
  results.find((each) => each.outcome === ConformanceOutcome.Fail) ?? results[0] ?? passed(ConformanceCheck.StopReap);

/** A launch, or the failure every check of its run reports. */
async function tryLaunch(deps: ConformanceDeps): Promise<ConformanceLaunch | CheckFailure> {
  try {
    return await deps.launch();
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return new CheckFailure(ConformanceProblem.LaunchFailed, MESSAGE.launch(why));
  }
}

/** The report, every check in run order. */
function report(
  request: ConformanceRequest,
  deps: ConformanceDeps,
  buildDigest: string | null,
  results: ReadonlyMap<ConformanceCheck, ConformanceCheckResult>,
): GameConformanceReport {
  const checks = CONFORMANCE_CHECKS.map(
    (check) => results.get(check) ?? result(check, ConformanceOutcome.Unavailable, null, null),
  );
  const at = new Date(deps.now()).toISOString();
  return {
    project: request.project,
    target: request.target,
    buildDigest,
    passed: conformancePassed(checks),
    checks,
    at,
  };
}

/** A web build's report: its suite runs in the browser preview, which this suite does not drive yet. */
function webReport(request: ConformanceRequest, deps: ConformanceDeps): GameConformanceReport {
  const unsupported = (check: ConformanceCheck) =>
    [check, result(check, ConformanceOutcome.Unavailable, ConformanceProblem.TargetUnsupported, MESSAGE.web)] as const;
  return report(request, deps, null, new Map(CONFORMANCE_CHECKS.map(unsupported)));
}

/** A seeded run's cold-boot capture, or null where the run failed (its failure is `seed-determinism`'s). */
const coldCapture = (run: SeededRun | CheckFailure): ColdCapture | null => (run instanceof CheckFailure ? null : run);

/**
 * Runs the suite on one build: run A judges the verbs, the capture, the renderer's extensions and
 * presets and its own Stop; run B repeats A's seeded run for determinism (and, for `render-presets`,
 * a second cold boot) and is stopped the same way; Live's ring is watched on its own.
 */
export async function runGameConformance(
  deps: ConformanceDeps,
  request: ConformanceRequest,
): Promise<GameConformanceReport> {
  if (request.target === BuildTarget.Web) return webReport(request, deps);
  const seed = request.seed ?? CONFORMANCE_SEED;
  const demo = request.demo ?? null;
  const results = new Map<ConformanceCheck, ConformanceCheckResult>();
  const first = await tryLaunch(deps);
  if (first instanceof CheckFailure) {
    for (const check of CONFORMANCE_CHECKS) results.set(check, failed(check, first));
    results.set(ConformanceCheck.LiveRing, await checkLiveRing(deps));
    return report(request, deps, null, results);
  }
  const runA = await trySeededRun(first.port, seed, demo);
  results.set(ConformanceCheck.Verbs, await judged(ConformanceCheck.Verbs, () => checkVerbs(first.port, seed)));
  results.set(ConformanceCheck.CaptureDigest, await judged(ConformanceCheck.CaptureDigest, () => checkCapture(first)));
  // Extensions first: its as-booted look at the custom passes comes before any preset was set.
  const clock = { now: () => deps.now(), sleep: processDeps(deps).sleep };
  results.set(ConformanceCheck.RenderExtensions, await checkRenderExtensions(first.port, clock));
  const presets = await checkRenderPresets(first.port, clock);
  const stops = [await stopAndReap(deps, first)];
  const second = await tryLaunch(deps);
  const runB = second instanceof CheckFailure ? second : await trySeededRun(second.port, seed, demo);
  if (!(second instanceof CheckFailure)) stops.push(await stopAndReap(deps, second));
  const buildChanged = sameBuild(first, second);
  results.set(ConformanceCheck.SeedDeterminism, buildChanged ?? compareRuns(runA, runB));
  // Two builds' cold boots say nothing about one build's pinned profile.
  const secondBoot = buildChanged ? null : coldCapture(runB);
  results.set(ConformanceCheck.RenderPresets, judgeColdBoots(presets, coldCapture(runA), secondBoot));
  results.set(ConformanceCheck.LiveRing, await checkLiveRing(deps));
  results.set(ConformanceCheck.StopReap, worst(stops));
  return report(request, deps, first.buildDigest, results);
}

// ── launchers ──────────────────────────────────────────────────────────────────────────────

/** Whether a run's last status says the registry had to signal its group to end it. */
const signalled = (status: NativeRunStatus): boolean =>
  status.state === NativeRunState.Killed || (status.exit?.signal ?? null) !== null;

/** The states of a run still going: a Stop is judged only on one of these. */
const GOING: ReadonlySet<NativeRunState> = new Set([NativeRunState.Ready, NativeRunState.Paused]);

/**
 * Launches through the native run registry, as the harness's runs start: `prepare` builds and
 * admits the current build, the game box runs it, and `stop` is the registry's own Stop. The build
 * digest is the one a capture's provenance carries.
 */
export function registryLauncher(runs: NativeRunsHost, request: NativeStartRequest): () => Promise<ConformanceLaunch> {
  return async () => {
    const run = await runs.start(request);
    await run.port.ready();
    const { runId } = run.status;
    let last = run.status;
    const unsubscribe = runs.onStatus((status) => {
      if (status.runId === runId) last = status;
    });
    const shot = await run.port.screenshotWithStats().catch(() => null);
    return {
      port: run.port,
      pid: run.status.pid,
      stateDir: null,
      buildDigest: shot?.provenance.build?.digest ?? null,
      stop: async () => {
        // A run the host already ended (the port killed it for a reply, or it crashed) was never asked
        // to quit. The port's own kill is read from the port, not the status: the registry's notice of
        // that reap may still be on its way when Stop is asked.
        const ended = run.port.failure !== null || !GOING.has(last.state);
        try {
          await runs.stop(runId);
        } finally {
          unsubscribe();
        }
        return ended ? { escalated: false, ended } : { escalated: signalled(last) };
      },
    };
  };
}

/** Whether `exited` settles within `ms`. */
async function within(exited: Promise<unknown>, ms: number, wait: (ms: number) => Promise<void>): Promise<boolean> {
  const settled = exited.then(() => true);
  return await Promise.race([settled, wait(ms).then(() => false)]);
}

/**
 * Stops a game the caller spawned itself the way the registry stops a run: `quit`, then SIGTERM to
 * its group, then SIGKILL to the group and every listed descendant, each step only if needed.
 */
export async function stopGameChild(
  child: GameChild,
  port: Pick<NativeGamePort, "call">,
  deps: { descendants?(pid: number): Promise<number[]>; sleep?(ms: number): Promise<void> } = {},
): Promise<ConformanceStop> {
  const wait = deps.sleep ?? ((ms: number) => sleep(ms));
  const exited = child.exited.then(
    () => true,
    () => true,
  );
  // A game already gone (the port ended it for a reply) was never asked to quit.
  if (await Promise.race([exited, setImmediate(false)])) return { escalated: false, ended: true };
  void port.call(NativeOp.Quit).catch(() => {});
  if (await within(exited, NATIVE_QUIT_GRACE_MS, wait)) return { escalated: false };
  child.kill("SIGTERM");
  if (await within(exited, NATIVE_TERM_GRACE_MS, wait)) return { escalated: true };
  const tree = await (deps.descendants ?? processDescendants)(child.pid).catch(() => [] as number[]);
  child.kill("SIGKILL");
  for (const pid of tree) killQuietly(pid);
  await within(exited, NATIVE_REAP_MARGIN_MS, wait);
  return { escalated: true };
}
