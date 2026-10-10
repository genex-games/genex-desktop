/**
 * A game that speaks the Genex Play Protocol (docs/play-protocol.md) as a computer target: the
 * game runs as its own process, started through the ProcessSandbox, and every look, key, click
 * and clock move the `computer` session makes becomes a protocol op on its stdin. What the game
 * can do comes from its `hello`, never assumed; a game that speaks another protocol version is
 * refused at load. An op it refuses ends that action (keys and buttons it pressed are let go),
 * is not counted as applied and is kept for the session to read (`refusals`), never retried.
 *
 * `gameBridgeSource` is the session's source for such a game: it reads the play command the
 * project's studio.json declares, starts it, hands the session the target, and stops the
 * process (quit, then kill after a grace) when the session is released or the build changes.
 */
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { ScreenAct } from "../../shared/agent-screen.ts";
import {
  ClockLevel,
  canPause,
  InputRoute,
  PointerLevel,
  StateLevel,
  type TargetCapabilities,
  TargetRefusal,
  TargetRuntime,
} from "../../shared/computer-target.ts";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { errorMessage } from "../../shared/errors.ts";
import {
  PLAY_MAX_STEP_MS,
  PLAY_PROTOCOL_CAPABILITIES,
  PLAY_PROTOCOL_VERSION,
  PlayButton,
  type PlayErrorCode,
  type PlayHello,
  PlayImageFormat,
  PlayFailure,
  PlayOp,
  type PlayRequestArgs,
  readHello,
  readScreenshot,
  readStep,
} from "../../shared/play-protocol.ts";
import { type PreviewInputAction, StillMimeType } from "../../shared/preview-contract.ts";
import type { ComputerTarget, TargetLoad, TargetShot } from "../../substrate/computer-target.ts";
import {
  PLAY_CALL_TIMEOUT_MS,
  type PlayClient,
  type PlayClientOptions,
  type PlayExit,
  PlayProtocolError,
  openPlayClient,
  playStreamsOf,
} from "../../substrate/play-protocol-client.ts";
import {
  MAX_HOLD_KEY_MS,
  clampLook,
  clickModifiers,
  normalizeKeys,
  parseCombo,
  pointInView,
  typedText,
  clampRepeat,
} from "../../substrate/preview-input.ts";
import { readProjectShape, resolvePlayCommand } from "../../substrate/project-shape.ts";
import { type ProcessSandbox, killChild, shellQuote } from "../../substrate/spawn.ts";
import type { TargetSource } from "./computer-session.ts";

/** How long a key or button is held when the plan names no time: a few frames of a 60 Hz game. */
const TAP_HOLD_MS = 50;
/** The most clicks one `pointer` op carries: a triple click. */
const MAX_CLICKS = 3;
/** How long a game is given to quit on its own before it is killed. */
const QUIT_GRACE_MS = 2 * SECOND_MS;
/** How long a killed game is waited for before the studio stops waiting. */
const KILL_WAIT_MS = 2 * SECOND_MS;
/** How long `hello` may take once the game said ready. */
const HELLO_TIMEOUT_MS = 5 * SECOND_MS;
/** What a `step` call is given beyond the time its simulation takes: the usual per-call wait. */
const STEP_DEADLINE_BASE_MS = PLAY_CALL_TIMEOUT_MS;
/** Wall milliseconds a game is given per simulated millisecond it is asked to step. */
const STEP_DEADLINE_PER_SIMULATED_MS = 2;
/** The longest one `step` call is waited for, however much it simulates. */
const MAX_STEP_DEADLINE_MS = 3 * MINUTE_MS;
/** The most refusals kept between two reads, so a session that never reads them holds no more. */
const MAX_KEPT_REFUSALS = 32;

const MESSAGE = {
  notBridge: "this build does not declare a Play Protocol game: studio.json needs a runtime and a play command",
  noCommand: (why: string) => `the game's play command cannot be used: ${why}`,
  failedStart: (why: string) => `the game failed to start: ${why}`,
  badHello: "the game's hello answer names no protocol version or view size",
  otherVersion: (version: number) =>
    `the game speaks Play Protocol ${version} and this studio speaks ${PLAY_PROTOCOL_VERSION}, so it was not played: rebuild it with a version ${PLAY_PROTOCOL_VERSION} engine plugin`,
  build: (build: NonNullable<PlayHello["build"]>) =>
    `playing build ${build.id}${build.sourceHash ? ` (source ${build.sourceHash})` : ""}`,
  unreachable: "the game process is not running",
  restarted: (exit: PlayExit) =>
    `the game process had exited (code ${exit.code ?? exit.signal ?? "unknown"}) and was started again`,
  badShot: "the game's screenshot carried no picture the studio can read",
} as const;

/** One op the game refused: which op, its refusal code, and its own sentence. */
export interface BridgeRefusal {
  op: string;
  code: PlayErrorCode | PlayFailure;
  message: string;
}

/** A Play Protocol game as the computer tool's target. */
export interface GameBridgeTarget extends ComputerTarget {
  /** The game's own `hello`; null on a target that never started. */
  readonly hello: PlayHello | null;
  /** The ops the game refused since the last read, oldest first; reading clears them. */
  refusals(): BridgeRefusal[];
}

/** What a target needs beyond its client: a sleep the tests can replace. */
export interface GameBridgeOptions {
  sleep?: (ms: number) => Promise<void>;
}

/**
 * A game's declared abilities as the studio's capability levels. The protocol has no reload,
 * cameras, console, zoom or second surface; everything else is what `hello` said, read safely
 * (`readHello` already turned anything unknown into "none").
 */
export function capabilitiesFromHello(hello: PlayHello | null): TargetCapabilities {
  const caps = hello?.capabilities;
  return {
    ...PLAY_PROTOCOL_CAPABILITIES,
    runtime: TargetRuntime.Bridge,
    pointer: caps?.pointer ?? PointerLevel.None,
    clock: caps?.clock ?? ClockLevel.None,
    state: caps?.state ?? StateLevel.None,
    seed: caps?.seed === true,
    actions: (caps?.actions.length ?? 0) > 0,
  };
}

/** The clock's own state, kept so a hold can step a stopped game instead of sleeping. */
interface BridgeState {
  pointer: { x: number; y: number } | null;
  /** The game's clock is stopped (pause or step), so a hold advances it exactly. */
  held: boolean;
}

/** The context every input handler shares. */
interface InputContext {
  client: PlayClient;
  view: { width: number; height: number };
  state: BridgeState;
  /** Let `ms` of game time pass: stepped when the clock is held and can step, slept otherwise. */
  hold: (ms: number) => Promise<void>;
}

/** How long a `step` of `ms` simulated milliseconds may take to answer. */
function stepDeadlineMs(ms: number): number {
  return Math.min(MAX_STEP_DEADLINE_MS, STEP_DEADLINE_BASE_MS + ms * STEP_DEADLINE_PER_SIMULATED_MS);
}

/**
 * Advance the game `ms` simulated milliseconds, in calls of at most {@link PLAY_MAX_STEP_MS}
 * (the longest step every game takes), each waited for as long as its simulation may take. The
 * simulated milliseconds, or null when the game did not say; nothing is sent for `ms` ≤ 0.
 */
async function stepGame(client: PlayClient, ms: number): Promise<number | null> {
  let simulated = 0;
  for (let left = ms; left > 0; left -= PLAY_MAX_STEP_MS) {
    const piece = Math.min(left, PLAY_MAX_STEP_MS);
    const ran = readStep(await client.call(PlayOp.Step, { ms: piece }, { timeoutMs: stepDeadlineMs(piece) }));
    if (ran === null) return null;
    simulated += ran;
  }
  return simulated;
}

/** Run `during`, then `release` whether or not it failed; the first failure is the one that is thrown. */
async function thenRelease(during: () => Promise<void>, release: () => Promise<void>): Promise<void> {
  let failed: { error: unknown } | null = null;
  try {
    await during();
  } catch (error) {
    failed = { error };
  }
  try {
    await release();
  } catch (error) {
    failed ??= { error };
  }
  if (failed) throw failed.error;
}

/** Send one core op and wait for its answer. */
async function op<O extends PlayOp>(ctx: InputContext, name: O, args: PlayRequestArgs[O]): Promise<void> {
  await ctx.client.call(name, args);
}

/** Put the game's pointer somewhere (and press, release or click there), remembering where it is. */
async function point(ctx: InputContext, args: PlayRequestArgs["pointer"]): Promise<void> {
  await ctx.client.call(PlayOp.Pointer, args);
  ctx.state.pointer = { x: args.x, y: args.y };
}

/** Where a planned point lands, in view pixels: pixels when `px`, a fraction of the view when both are in 0…1. */
function viewPoint(ctx: InputContext, x: unknown, y: unknown, px: boolean | undefined): { x: number; y: number } {
  const unset = x === undefined || y === undefined;
  if (unset && ctx.state.pointer) return ctx.state.pointer;
  return pointInView(x, y, ctx.view.width, ctx.view.height, { exact: px === true });
}

/** Press keys down in order, run `during`, then let go of every key that went down, in reverse — even when something failed. */
async function holdingKeys(ctx: InputContext, codes: string[], during: () => Promise<void>): Promise<void> {
  const down: string[] = [];
  const press = async () => {
    for (const code of codes) {
      await op(ctx, PlayOp.Key, { code, down: true });
      down.push(code);
    }
    await during();
  };
  await thenRelease(press, async () => {
    for (const code of down.reverse()) await op(ctx, PlayOp.Key, { code, down: false });
  });
}

/** Hold keys down for `ms`, then let them go in reverse order. */
function strike(ctx: InputContext, codes: string[], ms: number): Promise<void> {
  return holdingKeys(ctx, codes, () => ctx.hold(ms));
}

/** A button name the protocol takes. */
function buttonOf(raw: string | undefined): PlayButton {
  return Object.values(PlayButton).find((button) => button === raw) ?? PlayButton.Left;
}

type InputHandler = (ctx: InputContext, action: PreviewInputAction) => Promise<void>;

/** Each studio input action, as the protocol ops that carry it out. */
const INPUT: {
  [K in PreviewInputAction["type"]]: (
    ctx: InputContext,
    action: Extract<PreviewInputAction, { type: K }>,
  ) => Promise<void>;
} = {
  tap: (ctx, a) => strike(ctx, codesOf(a.keys), a.stepMs ?? TAP_HOLD_MS),
  hold: (ctx, a) => strike(ctx, codesOf(a.keys), Math.min(MAX_HOLD_KEY_MS, Math.max(0, a.ms ?? TAP_HOLD_MS))),
  down: async (ctx, a) => {
    for (const code of codesOf(a.keys)) await op(ctx, PlayOp.Key, { code, down: true });
  },
  up: async (ctx, a) => {
    for (const code of codesOf(a.keys)) await op(ctx, PlayOp.Key, { code, down: false });
  },
  press: async (ctx, a) => {
    const { modifiers, key } = parseCombo(a.combo);
    if (!key) return;
    const codes = [...modifiers.map((k) => k.code), key.code];
    for (let i = 0; i < clampRepeat(a.repeat ?? 1); i++) await strike(ctx, codes, TAP_HOLD_MS);
  },
  type: (ctx, a) => op(ctx, PlayOp.Type, { text: typedText(a.text) }),
  look: (ctx, a) => op(ctx, PlayOp.Look, { dx: clampLook(a.dx), dy: clampLook(a.dy) }),
  scroll: async (ctx, a) => {
    if (a.x !== undefined && a.y !== undefined) await point(ctx, viewPoint(ctx, a.x, a.y, true));
    await op(ctx, PlayOp.Wheel, { dx: a.dx ?? 0, dy: a.dy ?? 0 });
  },
  wait: (ctx, a) => ctx.hold(Math.min(MAX_HOLD_KEY_MS, Math.max(0, a.ms))),
  click: (ctx, a) => {
    const modifiers = (a.modifiers ?? []).flatMap((name) => clickModifiers(name));
    const at = viewPoint(ctx, a.x, a.y, a.px);
    const clicks = Math.max(1, Math.min(MAX_CLICKS, a.clicks ?? 1));
    return holdingKeys(ctx, modifiers, () => point(ctx, { ...at, button: buttonOf(a.button), click: clicks }));
  },
  move: (ctx, a) => point(ctx, viewPoint(ctx, a.x, a.y, a.px)),
  drag: async (ctx, a) => {
    const button = buttonOf(a.button);
    const to = viewPoint(ctx, a.x, a.y, a.px);
    const from = viewPoint(ctx, a.fromX, a.fromY, a.px);
    await point(ctx, { ...from, button, down: true });
    const glide = async () => {
      await ctx.hold(TAP_HOLD_MS);
      await point(ctx, to);
      await ctx.hold(TAP_HOLD_MS);
    };
    await thenRelease(glide, () => point(ctx, { ...(ctx.state.pointer ?? from), button, down: false }));
  },
  mousedown: (ctx, a) =>
    point(ctx, { ...viewPoint(ctx, undefined, undefined, true), button: buttonOf(a.button), down: true }),
  mouseup: (ctx, a) =>
    point(ctx, { ...viewPoint(ctx, undefined, undefined, true), button: buttonOf(a.button), down: false }),
};

/** Key names as `KeyboardEvent.code` names, the protocol's spelling. */
function codesOf(keys: string[]): string[] {
  return normalizeKeys(keys).map((key) => key.code);
}

/**
 * Run one studio action: true when the game accepted every op it took. An op the game refuses
 * ends that action and is handed to `refused`; a dead or silent process ends them all.
 */
async function runAction(
  ctx: InputContext,
  action: PreviewInputAction,
  refused: (error: PlayProtocolError) => void,
): Promise<boolean> {
  // The table is keyed by the action's own type, which TypeScript cannot correlate through a union.
  const handler = INPUT[action.type] as InputHandler;
  try {
    await handler(ctx, action);
    return true;
  } catch (error) {
    if (!isRefusal(error)) throw error;
    refused(error);
    return false;
  }
}

/** A failure that says the process cannot be reached, as opposed to one op it refused. */
function isUnreachable(error: PlayProtocolError): boolean {
  return error.code === PlayFailure.Exited || error.code === PlayFailure.Timeout;
}

/** A failure of one op the game is still there to have refused (or answered unreadably). */
function isRefusal(error: unknown): error is PlayProtocolError {
  return error instanceof PlayProtocolError && !isUnreachable(error);
}

/**
 * The target's clock: pause, play and step, as far as the game declared them. A step the game
 * refuses answers null ("cannot step"), its refusal handed to `refused`; a dead process still throws.
 */
function bridgeClock(
  client: PlayClient,
  caps: TargetCapabilities,
  state: BridgeState,
  refused: (error: PlayProtocolError) => void,
): ComputerTarget["clock"] {
  if (caps.clock === ClockLevel.None) return undefined;
  const pause = async () => {
    await client.call(PlayOp.Pause, {});
    state.held = true;
  };
  const start = async () => {
    await client.call(PlayOp.Play, {});
    state.held = false;
  };
  if (!canPause(caps)) return { pause, start };
  const step = async (ms: number) => {
    try {
      const ran = await stepGame(client, ms);
      state.held = true;
      return ran;
    } catch (error) {
      if (!isRefusal(error)) throw error;
      refused(error);
      return null;
    }
  };
  return { pause, start, step };
}

/** The refusals a target keeps for the session: added as they happen, taken (and cleared) on read. */
function refusalLog() {
  let kept: BridgeRefusal[] = [];
  return {
    add: (error: PlayProtocolError) => {
      kept = [...kept, { op: error.op, code: error.code, message: error.message }].slice(-MAX_KEPT_REFUSALS);
    },
    take: (): BridgeRefusal[] => {
      const taken = kept;
      kept = [];
      return taken;
    },
  };
}

/** The game's picture: JPEG when it can, else its PNG, kept as it is and named as what it is. */
async function bridgeShot(client: PlayClient, hello: PlayHello, quality: number): Promise<TargetShot> {
  const format = hello.capabilities.screenshot.includes(PlayImageFormat.Jpeg)
    ? PlayImageFormat.Jpeg
    : PlayImageFormat.Png;
  const shot = readScreenshot(await client.call(PlayOp.Screenshot, { format, quality }));
  if (!shot) throw new PlayProtocolError(PlayFailure.BadReply, PlayOp.Screenshot, MESSAGE.badShot);
  const stats = shot.stats
    ? { ...shot.stats, width: shot.width, height: shot.height, sampled: shot.width * shot.height, canvas: true }
    : null;
  const mime = shot.format === PlayImageFormat.Png ? StillMimeType.Png : StillMimeType.Jpeg;
  return { jpeg: Buffer.from(shot.data, "base64"), stats, surface: null, mime };
}

/** A Play Protocol game, through its open client, as a computer target. */
export function gameBridgeTarget(
  client: PlayClient,
  hello: PlayHello,
  options: GameBridgeOptions = {},
): GameBridgeTarget {
  const caps = capabilitiesFromHello(hello);
  const state: BridgeState = { pointer: null, held: false };
  const refusals = refusalLog();
  const clock = bridgeClock(client, caps, state, refusals.add);
  const pause = options.sleep ?? ((ms: number) => sleep(ms).then(() => {}));
  // Inside an action a refused step is thrown, so the action counts as not applied.
  const hold = async (ms: number) => {
    if (state.held && canPause(caps)) await stepGame(client, ms);
    else await pause(ms);
  };
  const ctx: InputContext = { client, view: hello.view, state, hold };
  return {
    hello,
    caps,
    refusals: refusals.take,
    viewSize: () => hello.view,
    pointer: () => state.pointer,
    screenshot: ({ quality }) => bridgeShot(client, hello, quality),
    input: async (actions) => {
      let applied = 0;
      for (const action of actions) if (await runAction(ctx, action, refusals.add)) applied++;
      return { applied, route: InputRoute.Bridge };
    },
    ...(caps.state === StateLevel.None ? {} : { state: () => client.call(PlayOp.State, {}) }),
    ...(clock ? { clock } : {}),
    ...(caps.seed
      ? {
          seed: async (seed: number) => {
            await client.call(PlayOp.Reset, { seed });
          },
        }
      : {}),
    ...(caps.actions
      ? {
          act: async (list) => {
            await client.call(PlayOp.Act, { list });
            return { applied: list.length, route: InputRoute.Bridge };
          },
        }
      : {}),
  };
}

/** A target with no game behind it: what a failed load hands the session beside its problem. */
function unreachableTarget(): GameBridgeTarget {
  const refuse = () => Promise.reject(new Error(`${TargetRefusal.Unreachable}: ${MESSAGE.unreachable}`));
  return {
    hello: null,
    refusals: () => [],
    caps: capabilitiesFromHello(null),
    viewSize: () => ({ width: 1, height: 1 }),
    pointer: () => null,
    screenshot: refuse,
    input: refuse,
  };
}

/** One running game: its target, client and process, and how to stop it. */
export interface GameBridgeLaunch {
  target: GameBridgeTarget;
  client: PlayClient;
  child: ChildProcess;
  /** Settles once the process is gone. */
  exited: Promise<PlayExit>;
  /** Whether the process is still running. */
  running(): boolean;
  /** Ask the game to quit, kill it after a grace, and wait until it is gone. */
  stop(): Promise<void>;
}

/** How a game is launched. */
export interface GameBridgeLaunchOptions {
  sandbox: Pick<ProcessSandbox, "spawnLongLived">;
  /** The shell command line that starts the game, its words already quoted. */
  command: string;
  cwd: string;
  label?: string;
  client?: PlayClientOptions;
  target?: GameBridgeOptions;
  /** How long a game is given to quit on its own before it is killed. */
  stopGraceMs?: number;
}

/** A process to stop, the client that can ask it to quit, and how long it is given. */
interface StopPlan {
  child: ChildProcess;
  client: PlayClient | null;
  exited: Promise<PlayExit>;
  graceMs: number;
}

/** Stop a game: `quit`, then kill its process tree when it has not gone within the grace. */
async function stopGame({ child, client, exited, graceMs }: StopPlan): Promise<void> {
  const gone = () => child.exitCode !== null || child.signalCode !== null;
  const within = (ms: number) => Promise.race([exited.then(() => true), sleep(ms, false, { ref: false })]);
  if (!gone() && client && !client.exited) {
    await client.call(PlayOp.Quit, {}, { timeoutMs: graceMs }).catch(() => null);
    client.close();
    if (await within(graceMs)) return;
  }
  if (gone()) return;
  killChild(child);
  await within(KILL_WAIT_MS);
}

/**
 * Start a game through the sandbox, wait for its ready line and its `hello`, and wrap it as a
 * target. Throws a {@link PlayProtocolError} (the process stopped first) when it never becomes one.
 */
export async function launchGameBridge(options: GameBridgeLaunchOptions): Promise<GameBridgeLaunch> {
  const { child } = await options.sandbox.spawnLongLived({
    command: options.command,
    cwd: options.cwd,
    label: options.label ?? `play:${path.basename(options.cwd)}`,
  });
  const streams = playStreamsOf(child);
  const graceMs = options.stopGraceMs ?? QUIT_GRACE_MS;
  let client: PlayClient | null = null;
  try {
    client = await openPlayClient(streams, options.client);
    const hello = readHello(await client.call(PlayOp.Hello, {}, { timeoutMs: HELLO_TIMEOUT_MS }));
    if (!hello) throw new PlayProtocolError(PlayFailure.BadReply, PlayOp.Hello, MESSAGE.badHello);
    if (hello.protocol !== PLAY_PROTOCOL_VERSION)
      throw new PlayProtocolError(PlayFailure.Version, PlayOp.Hello, MESSAGE.otherVersion(hello.protocol));
    const opened = client;
    return {
      target: gameBridgeTarget(opened, hello, options.target),
      client: opened,
      child,
      exited: streams.exited,
      running: () => !opened.exited,
      stop: () => stopGame({ child, client: opened, exited: streams.exited, graceMs }),
    };
  } catch (error) {
    await stopGame({ child, client, exited: streams.exited, graceMs });
    throw error;
  }
}

/** How a bridge source starts its games and shows their frames. */
export interface GameBridgeSourceOptions {
  sandbox: Pick<ProcessSandbox, "spawnLongLived">;
  /** A picture of the game for the agent's screen; the default shows none. */
  frame?: (target: GameBridgeTarget, jpeg: Buffer | null, caption: string, act: ScreenAct) => Promise<void>;
  client?: PlayClientOptions;
  target?: GameBridgeOptions;
  stopGraceMs?: number;
}

/** A target source that also stops what it started. */
export interface GameBridgeSource extends TargetSource<GameBridgeTarget> {
  release(): Promise<void>;
}

/** The shell command line studio.json declares for the build at `root`, or why there is none. */
async function playCommandAt(root: string): Promise<{ command: string } | { problem: string }> {
  const shape = await readProjectShape(root);
  if (shape.runtime !== TargetRuntime.Bridge || !shape.play) return { problem: MESSAGE.notBridge };
  const resolved = await resolvePlayCommand(root, shape.play).catch((error: unknown) => error);
  if (typeof resolved !== "string") return { problem: MESSAGE.noCommand(errorMessage(resolved)) };
  return { command: [resolved, ...shape.play.args].map(shellQuote).join(" ") };
}

/** Why a launch gave no target, as the load's problem: a version refusal as it is, anything else as a failed start. */
function launchProblem(error: unknown): string {
  const otherVersion = error instanceof PlayProtocolError && error.code === PlayFailure.Version;
  return otherVersion ? error.message : MESSAGE.failedStart(errorMessage(error));
}

/** The game a source has running: the build it runs, and how it exited once it has. */
interface RunningGame {
  root: string;
  launch: GameBridgeLaunch;
  exit: PlayExit | null;
}

/**
 * The session's source for a Play Protocol game: started on the first action from the play
 * command the build's studio.json declares, kept running between actions, started again when it
 * exited or the build changed, and stopped on release.
 */
export function gameBridgeSource(options: GameBridgeSourceOptions): GameBridgeSource {
  let running: RunningGame | null = null;
  const stopRunning = async () => {
    const current = running;
    running = null;
    if (current) await current.launch.stop();
  };
  const start = async (root: string, note: string | null) => {
    const planned = await playCommandAt(root);
    if ("problem" in planned) return { target: unreachableTarget(), problem: planned.problem, note: null, fresh: true };
    try {
      const launch = await launchGameBridge({ ...options, command: planned.command, cwd: root });
      const current: RunningGame = { root, launch, exit: null };
      void launch.exited.then((exit) => {
        current.exit = exit;
      });
      running = current;
      const build = launch.target.hello?.build;
      const notes = [note, build ? MESSAGE.build(build) : null].filter(Boolean);
      return { target: launch.target, problem: null, note: notes.join("; ") || null, fresh: true };
    } catch (error) {
      return { target: unreachableTarget(), problem: launchProblem(error), note: null, fresh: true };
    }
  };
  return {
    get caps() {
      return running?.launch.target.caps ?? PLAY_PROTOCOL_CAPABILITIES;
    },
    load: async (root, force): Promise<TargetLoad<GameBridgeTarget> & { fresh: boolean }> => {
      const current = running;
      const reusable = current && !force && current.root === root && current.launch.running();
      if (current && reusable) return { target: current.launch.target, problem: null, note: null, fresh: false };
      const died =
        current && !current.launch.running() ? MESSAGE.restarted(current.exit ?? { code: null, signal: null }) : null;
      await stopRunning();
      return start(root, died);
    },
    frame: (target, jpeg, caption, act) => options.frame?.(target, jpeg, caption, act) ?? Promise.resolve(),
    release: stopRunning,
  };
}
