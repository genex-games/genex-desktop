/**
 * The editor queue: parts written without Unreal go into the one visible editor one at a time —
 * apply the part, play its test, take play shots, stop play — and it hands back what it saw. It
 * waits while Unreal doesn't answer (a crash or a restart is fine) and while the person works in
 * the editor, and it always stops a play session it started. Each play test runs with Unreal's
 * background throttle off, and the queue gives the setting back once play stops. A C++ part's code
 * is copied into the game and the game's module hot-reloaded first, outside play; code that doesn't
 * compile or load ends the part before anything is applied. Accepting or rolling back a part is the
 * caller's (snapshots are the host's).
 *
 * While a part applies and plays, the queue watches the editor for a crash (a part's C++ can crash
 * Unreal as play starts, and the part would stay "playing" while every call timed out): it looks
 * every few seconds and whenever a call fails, and a crash ends the part at once as `crashed`, with
 * Unreal's signal and call stack; nothing more reaches the crashed editor.
 *
 * A play-check is a play in the same queue (the Unreal lead's fallback for save-point thumbnails):
 * nothing is applied, the game is only played — settle, shot spawn, drive the route with frames,
 * shot ride, every check, the probes. Every wait in play counts the play world's own game seconds,
 * with a cap on the queue's clock (a loaded editor can play at 5–9 frames per second, and real-time
 * holds then gave about one second of game time); an older helper without a game clock is given
 * the seconds on the queue's clock.
 */
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { errorMessage } from "../../shared/errors.ts";
import { type CrashCheck, type CrashReport, shownLine } from "./editor-log.ts";
import { ObjectTool, readThrottleArgs, throttleIn, writeThrottleArgs } from "./editor-throttle.ts";
import { type DriveStep, frameName, type PartCheck, type PartStep, PartStepKind, type PartTest } from "./part-test.ts";

/**
 * The Genex editor helper's Loop toolset, where the queue's own editor tools live. Only Genex's
 * queue and the Loop's runner call it: the agents' bridge refuses it (`editor-mcp.ts`).
 */
export const LOOP_TOOLSET = "genex_loop.tools.GenexLoopTools";

/** The editor tools the queue calls, by the Genex editor helper's (or Epic's) tool names. */
export const LoopTool = {
  ApplyPart: "apply_part",
  StartPlay: "StartPIE",
  Hold: "hold",
  CapturePlay: "capture_play",
  GameState: "game_state",
  StopPlay: "stop_play",
  PlayState: "play_state",
  EditorActivity: "editor_activity",
  ProbeCharacters: "probe_characters",
  ProbeView: "probe_view",
  RecompileModule: "recompile_module",
  Settle: "settle",
  DriveRoute: "drive_route",
  ProbeRoute: "probe_route",
  PlayerState: "player_state",
  GetProperties: ObjectTool.GetProperties,
  SetProperties: ObjectTool.SetProperties,
} as const;
export type LoopTool = (typeof LoopTool)[keyof typeof LoopTool];

/** The probes a finished run hands back, by their key in its result (the seed's `PartProbe`). */
export const PartProbe = { Characters: "characters", View: "view" } as const;
export type PartProbe = (typeof PartProbe)[keyof typeof PartProbe];

/** Where a part's run stands. */
export const PartRunState = {
  Queued: "queued",
  Waiting: "waiting",
  Applying: "applying",
  Playing: "playing",
  Done: "done",
  Failed: "failed",
} as const;
export type PartRunState = (typeof PartRunState)[keyof typeof PartRunState];

/** What a waiting run waits for: Unreal to answer, or the person to stop working in the editor. */
export const WaitingFor = { Editor: "editor", Owner: "owner" } as const;
export type WaitingFor = (typeof WaitingFor)[keyof typeof WaitingFor];

/**
 * Why a run failed, on its record (`failure`): the person kept working in the editor for the whole
 * wait, or Unreal never answered. A crash is `crashed`. Wire values on `part-result`: never rename.
 */
export const PartRunFailure = { OwnerBusy: "owner-busy", NotAnswering: "not-answering" } as const;
export type PartRunFailure = (typeof PartRunFailure)[keyof typeof PartRunFailure];

/**
 * The play-check's named shots (the seed's `LiveCamera`): the pawn at rest where play starts, and
 * after its drive. Wire values the seed reads: never rename.
 */
export const PlayCheckShot = { Spawn: "spawn", Ride: "ride" } as const;
export type PlayCheckShot = (typeof PlayCheckShot)[keyof typeof PlayCheckShot];

/** A play-check's run, by the part it names (`part-result` reads it like a part's). */
export const PLAY_CHECK_PART = "play-check";

/** How the helper's settle goes (player_state's `settle.state`): its wire values. */
const SettleState = { Watching: "watching", Settled: "settled", Unsettled: "unsettled" } as const;
/** How the helper's drive goes (player_state's `drive.state`): its wire values. */
const DriveState = { Driving: "driving", Done: "done" } as const;
/** What player_state reports of a step under way, by its key there. */
const UnderWay = { Settle: "settle", Drive: "drive" } as const;
type UnderWay = (typeof UnderWay)[keyof typeof UnderWay];

/**
 * The one editor, as the queue reaches it; `call` answers the tool's return value or throws, and a
 * call that blocks the editor longer than most (a hot reload) names its own `timeoutMs`.
 * `watchCrash` starts watching it for a crash from now on; an editor without it is never seen to crash.
 */
export type EditorPort = {
  answering(): Promise<boolean>;
  call(tool: LoopTool, args: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  watchCrash?(): Promise<CrashCheck>;
};

/**
 * A C++ part's code as run-part hands it over: the builder's copy of the game (its
 * `unreal/Source/<module>/Parts/<part>/` holds the code), the game's linked project it lands in,
 * the game's module, and the classes part.json's `cpp` lists, which must load after the hot reload.
 */
export type PartCode = { copy: string; project: string; module: string; classes: string[] };

/** What the queue needs: the game's editor, the time, the shot files the editor writes and a C++ part's copy. */
export type QueueDeps = {
  editor(game: string): EditorPort;
  /** Copies a C++ part's folder from the builder's copy into the game's project; throws why not, nothing copied. */
  landCpp(part: string, code: PartCode): Promise<unknown>;
  now(): number;
  /** Waits `ms`; may end early (and reject) once `signal` aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  fileReady(file: string): Promise<boolean>;
  /** A shot's bytes, base64. */
  readShot(file: string): Promise<string>;
};

/** One part to run: the game, the part, its `apply.py` in the game folder, its parsed test and a C++ part's code. */
export type PartJob = { game: string; part: string; script: string; test: PartTest; cpp?: PartCode };
/** A check and what the game showed. */
export type CheckResult = { check: PartCheck; passed: boolean; saw: unknown };
/** A play shot: its name, the file the editor wrote, and its PNG bytes (base64). */
export type Shot = { name: string; file: string; data: string };
/** Each probe's answer as the Genex editor helper gave it, or `{error}` when it couldn't run. */
export type PartProbes = Record<PartProbe, unknown>;
/** What a finished part run hands back; a drive's frames are among its shots. */
export type PartRunResult = { apply: unknown; shots: Shot[]; checks: CheckResult[]; probes?: PartProbes; ms: number };
/** What crashed the editor: Unreal's signal and the top of its call stack, functions only (the Loop's `crash`). */
export type PartCrash = { signal: string; frames: string[] };
/** One run as the caller polls it; a run that crashed the editor fails with `crashed` and its `crash`. */
export type PartRun = {
  id: string;
  game: string;
  part: string;
  state: PartRunState;
  waitingFor?: WaitingFor;
  result?: PartRunResult | PlayCheckResult;
  error?: string;
  /** Why it failed, when the caller acts on the reason. */
  failure?: PartRunFailure;
  crashed?: true;
  crash?: PartCrash;
  startedAt: number;
  updatedAt: number;
};

/**
 * A play-check in the editor (`play-check`): nothing is applied, the game is only played — settle, shot spawn, drive the route, shot ride, every
 * check, the probes, stop. Its checks are keyed by their board ids; the person's work in the
 * editor is waited out for at most `ownerWaitMs`.
 */
export type PlayCheckJob = { game: string; checks: Record<string, PartCheck>; ownerWaitMs: number };
/** `probe_route`'s answer: the pawn against the route's nearest point; nulls when the game has no route. */
export type RouteProbe = {
  route: boolean;
  facingDeg: number | null;
  offRouteCm: number | null;
  progressM: number | null;
  lengthM: number | null;
};
/** How the settle step ended, on the play world's clock; `speedCmS` is the pawn's speed at its end. */
export type SettleOutcome = { settled: boolean; gameSeconds: number; speedCmS: number | null };
/** How the drive went: whether it followed a route, the game seconds it drove and how far along the route it got. */
export type DriveOutcome = { route: boolean; gameSeconds: number; progressM: number | null };
/** One play-check check: its board id, the check, whether it held and what the game showed. */
export type PlayCheckOutcome = { id: string; check: PartCheck; passed: boolean; saw: unknown };
/**
 * What a finished play-check hands back as its run's `result`: the named shots (spawn, then ride),
 * the drive's frames in order, each check, the end-of-play probes, the pawn at the spawn (after it
 * settled, before the drive), the settle and the drive, the play world's frame rate over the drive
 * and its clock at the end.
 */
export type PlayCheckResult = {
  shots: Shot[];
  frames: Shot[];
  checks: PlayCheckOutcome[];
  probes: PartProbes;
  spawn: { characters: unknown; route: RouteProbe | { error: string } };
  settle: SettleOutcome;
  drive: DriveOutcome;
  fps: number | null;
  gameSeconds: number | null;
  ms: number;
};

/** How often the queue asks again whether Unreal answers, and how long it waits at most. */
const EDITOR_POLL_MS = 2 * SECOND_MS;
const EDITOR_WAIT_MS = 10 * MINUTE_MS;
/** The person counts as working while the editor changed within this long. */
const OWNER_QUIET_MS = 3 * SECOND_MS;
/** How long the queue waits for the person to stop before it fails the part. */
const OWNER_WAIT_MS = 30 * MINUTE_MS;
/** How often and how long a shot's file and the end of play are waited for. */
const FILE_POLL_MS = 250;
const SHOT_WAIT_MS = 8 * SECOND_MS;
const PLAY_WAIT_MS = 15 * SECOND_MS;
/** The play shot's size; the helper's schema needs it on every call. */
const SHOT_WIDTH = 1280;
const SHOT_HEIGHT = 720;
const PIE_OPTIONS = { bSimulate: false, playMode: "PlayMode_InViewPort", warmupSeconds: 0 } as const;
/** How long a hot reload may block the editor: one takes 11 to 19 s, a first one with many classes longer. */
const RECOMPILE_TIMEOUT_MS = 6 * MINUTE_MS;
/** How many of the hot reload's log lines a failed part names. */
const MAX_LOG_LINES = 20;
/** A class name the helper hands back, as part.json's `cpp` spells one. */
const CLASS_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
/** How often a part in the editor looks for a crash: a crashed part ends within about this. */
const CRASH_POLL_MS = 2 * SECOND_MS;
/** How often a wait in play reads the game's clock. */
const GAME_POLL_MS = 250;
/** The most a wait of some game seconds takes on the queue's clock (a slow editor's game time lags): this many times as long, plus the extra. */
const WALL_CAP_FACTOR = 4;
const WALL_CAP_EXTRA_MS = 10 * SECOND_MS;
/**
 * The play-check's play, in game seconds: the warm-up,
 * the settle at most, and the drive with its frames; the input actions the drive presses, as the
 * Vehicle template names them.
 */
const PLAY_CHECK = { warmupSeconds: 2, settleSeconds: 8, drive: { seconds: 20, frames: 4 } } as const;
const DRIVE_INPUTS = { throttle: "Throttle", steer: "Steering" } as const;
/** What a crash during a play-check names as the thing Unreal was testing. */
const PLAY_CHECK_TESTED = "the game";

const MESSAGE = {
  NotAnswering: "Unreal isn't answering. Reopen the game's project from the Unreal button.",
  OwnerBusy: "You were working in the editor the whole time, so the part waited and wasn't run.",
  ApplyFailed: (why: string) => `The part's script failed in the editor: ${why}`,
  NoShot: (name: string) => `The play shot ${name} never appeared.`,
  PlayDidNotStart: "Play didn't start in the editor.",
  CodeNotLanded: (why: string) => `The part's C++ couldn't be copied into the game: ${why}`,
  NotCompiled: (lines: string) => `The part's C++ didn't compile in the editor.${lines}`,
  NotLoaded: (classes: string, lines: string) =>
    `The part's C++ compiled, but ${classes} didn't load in the editor: each class part.json's cpp lists needs a UCLASS() of that name (with its A or U prefix) in the part's headers.${lines}`,
  NotLive: (lines: string) => `The part's C++ compiled, but Unreal didn't load the new code.${lines}`,
  NotReloaded: (why: string) => `The editor didn't hot-reload the part's C++: ${why}`,
  Crashed: (part: string, cause: string, at: string | undefined) =>
    `Unreal crashed while testing ${part}: ${cause}${at ? ` in ${at}` : ""}`,
  StepRefused: (tool: string, why: string) => `The Genex editor helper refused ${tool}: ${why}`,
} as const;

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** Polls `ready` every `everyMs` until it says yes (true) or `limitMs` passes on `clock` (false). */
export async function pollUntil(
  clock: Pick<QueueDeps, "now" | "sleep">,
  ready: () => Promise<boolean>,
  everyMs: number,
  limitMs: number,
): Promise<boolean> {
  const ends = clock.now() + limitMs;
  while (clock.now() <= ends) {
    if (await ready()) return true;
    await clock.sleep(everyMs);
  }
  return false;
}

/** What the person could be changing in the editor, as one comparable string. */
async function fingerprint(port: EditorPort): Promise<string> {
  const activity = record(await port.call(LoopTool.EditorActivity, {}));
  return JSON.stringify([activity.camera, activity.selection, activity.dirty, activity.pie]);
}

/** A number the helper answered, or null. */
const numberOr = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** Whether a check reads every `genex:`-tagged actor in the play world rather than one part's actors. */
const readsEveryTag = (check: PartCheck) => "tag" in check;

/**
 * Whether an actor with `tag` is in the game: by the helper's count of every tagged actor, which
 * holds past the rows it lists, else (an older helper) by the rows.
 */
function tagThere(state: Record<string, unknown>, actors: Record<string, unknown>[], tag: string): boolean {
  const counts = state.tags;
  if (counts && typeof counts === "object" && !Array.isArray(counts)) {
    const count = (counts as Record<string, unknown>)[tag];
    return typeof count === "number" && count > 0;
  }
  return actors.some((a) => Array.isArray(a.tags) && a.tags.includes(tag));
}

/** Whether a check holds for what the game shows. */
function judgeCheck(check: PartCheck, state: Record<string, unknown>): CheckResult {
  const actors = Array.isArray(state.actors) ? state.actors.map(record) : [];
  if ("actor" in check) {
    const there = actors.some((a) => a.label === check.actor);
    return { check, passed: there === check.exists, saw: there };
  }
  if ("tag" in check) {
    const there = tagThere(state, actors, check.tag);
    return { check, passed: there === check.exists, saw: there };
  }
  const value = record(state.player)[check.player];
  const number = typeof value === "number" ? value : Number.NaN;
  const low = check.atLeast === undefined || number >= check.atLeast;
  const high = check.atMost === undefined || number <= check.atMost;
  return { check, passed: low && high && !Number.isNaN(number), saw: value ?? null };
}

/** The hot reload's log lines, each on a line of its own after the message, or nothing. */
function logLines(log: unknown): string {
  const lines = (Array.isArray(log) ? log : []).filter((line): line is string => typeof line === "string");
  const shown = lines.slice(0, MAX_LOG_LINES).map(shownLine).filter(Boolean);
  return shown.length > 0 ? `\n${shown.join("\n")}` : "";
}

/** Why the helper's hot reload answer fails the part, or undefined when the new code is live. */
function reloadFailure(answer: unknown): string | undefined {
  const reply = record(answer);
  if (reply.error !== undefined) return MESSAGE.NotReloaded(String(reply.error));
  if (reply.ok === true) return undefined;
  const lines = logLines(reply.log);
  if (reply.compiled !== true) return MESSAGE.NotCompiled(lines);
  const listed = Array.isArray(reply.missing) ? reply.missing : [];
  const missing = listed.filter((name): name is string => typeof name === "string" && CLASS_NAME.test(name));
  return missing.length > 0 ? MESSAGE.NotLoaded(missing.join(", "), lines) : MESSAGE.NotLive(lines);
}

/**
 * A C++ part's code into the game and live in the open editor: its folder copied in from the
 * builder's copy, then the game's module hot-reloaded with the part's classes (the editor refuses
 * during play). Throws why the code isn't live; nothing of the part is applied then.
 */
async function bringCode(deps: QueueDeps, port: EditorPort, job: PartJob) {
  const code = job.cpp;
  if (!code) return;
  try {
    await deps.landCpp(job.part, code);
  } catch (failure) {
    throw new Error(MESSAGE.CodeNotLanded(errorMessage(failure)));
  }
  const args = { module: code.module, classes: code.classes };
  const answer = await port
    .call(LoopTool.RecompileModule, args, RECOMPILE_TIMEOUT_MS)
    .catch((failure: unknown) => ({ error: errorMessage(failure) }));
  const failure = reloadFailure(answer);
  if (failure) throw new Error(failure);
}

/** Sets a run's state and stamps it; a change without `waitingFor` clears it. */
function update(deps: QueueDeps, run: PartRun, change: Partial<PartRun>) {
  Object.assign(run, change, { updatedAt: deps.now() });
  if (!change.waitingFor) delete run.waitingFor;
}

/** A wait that ran out, with why its run failed for the caller to act on. */
class WaitFailedError extends Error {
  readonly failure: PartRunFailure;
  constructor(failure: PartRunFailure, message: string) {
    super(message);
    this.failure = failure;
  }
}

async function waitForEditor(deps: QueueDeps, run: PartRun, port: EditorPort) {
  if (await port.answering()) return;
  update(deps, run, { state: PartRunState.Waiting, waitingFor: WaitingFor.Editor });
  if (!(await pollUntil(deps, () => port.answering(), EDITOR_POLL_MS, EDITOR_WAIT_MS)))
    throw new WaitFailedError(PartRunFailure.NotAnswering, MESSAGE.NotAnswering);
}

/**
 * Waits until the editor stays still for a moment: nobody moving its camera, selecting or editing;
 * at most `limitMs`.
 */
async function waitForOwner(deps: QueueDeps, run: PartRun, port: EditorPort, limitMs: number) {
  let before = await fingerprint(port);
  const ends = deps.now() + limitMs;
  while (deps.now() <= ends) {
    await deps.sleep(OWNER_QUIET_MS);
    const after = await fingerprint(port);
    if (after === before) return;
    update(deps, run, { state: PartRunState.Waiting, waitingFor: WaitingFor.Owner });
    before = after;
  }
  throw new WaitFailedError(PartRunFailure.OwnerBusy, MESSAGE.OwnerBusy);
}

async function shoot(deps: QueueDeps, port: EditorPort, name: string): Promise<Shot> {
  const answer = record(await port.call(LoopTool.CapturePlay, { name, width: SHOT_WIDTH, height: SHOT_HEIGHT }));
  const file = String(answer.file ?? "");
  if (!file || !(await pollUntil(deps, () => deps.fileReady(file), FILE_POLL_MS, SHOT_WAIT_MS)))
    throw new Error(MESSAGE.NoShot(name));
  return { name, file, data: await deps.readShot(file) };
}

/** The play world's clock in game seconds, or null from a helper that keeps none (older than 0.5). */
async function gameClock(port: EditorPort): Promise<{ gameSeconds: number | null; fps: number | null }> {
  const state = record(await port.call(LoopTool.PlayState, {}));
  return { gameSeconds: numberOr(state.gameSeconds), fps: numberOr(state.fps) };
}

/** How long a wait of `seconds` game seconds may take at most on the queue's clock. */
const wallCapMs = (seconds: number) => WALL_CAP_FACTOR * seconds * SECOND_MS + WALL_CAP_EXTRA_MS;

/**
 * Lets the game play on for `seconds` of its own time, at most {@link wallCapMs} on the queue's
 * clock; an editor whose helper keeps no game clock is given `seconds` on the queue's clock.
 */
async function playFor(deps: QueueDeps, port: EditorPort, seconds: number): Promise<void> {
  const start = (await gameClock(port)).gameSeconds;
  if (start === null) return deps.sleep(seconds * SECOND_MS);
  const reached = async () => ((await gameClock(port)).gameSeconds ?? Number.POSITIVE_INFINITY) >= start + seconds;
  await pollUntil(deps, reached, GAME_POLL_MS, wallCapMs(seconds));
}

/** Calls one of the helper's play steps, which answers at once; throws its refusal (`{error}`). */
async function startStep(port: EditorPort, tool: LoopTool, args: Record<string, unknown>) {
  const answer = record(await port.call(tool, args));
  if (answer.error !== undefined) throw new Error(MESSAGE.StepRefused(tool, String(answer.error)));
  return answer;
}

/** What player_state says of the settle or the drive under way; null when it says nothing. */
async function underWay(port: EditorPort, key: UnderWay): Promise<Record<string, unknown> | null> {
  const value = record(await port.call(LoopTool.PlayerState, {}))[key];
  return value && typeof value === "object" ? record(value) : null;
}

/**
 * Lets the player's pawn come to rest, at most `seconds` of game time (the helper watches it), and
 * answers how it ended; a pawn still moving then is unsettled, and so is a settle the helper never
 * reports.
 */
async function settle(deps: QueueDeps, port: EditorPort, seconds: number): Promise<SettleOutcome> {
  await startStep(port, LoopTool.Settle, { seconds });
  const seen: { last: Record<string, unknown> | null } = { last: null };
  const ended = async () => {
    seen.last = await underWay(port, UnderWay.Settle);
    return seen.last?.state !== SettleState.Watching;
  };
  await pollUntil(deps, ended, GAME_POLL_MS, wallCapMs(seconds));
  return {
    settled: seen.last?.state === SettleState.Settled,
    gameSeconds: numberOr(seen.last?.gameSeconds) ?? 0,
    speedCmS: numberOr(seen.last?.speedCmS),
  };
}

/** A drive's frames, named on from `firstFrame`, and how it went. */
type Driven = { frames: Shot[]; outcome: DriveOutcome };

/**
 * Drives the player's pawn along the game's route for `step.seconds` of game time (the helper
 * steers), taking `step.frames` evenly spaced play shots, the last a step before the drive ends.
 * Each frame and the end wait at most their share of {@link wallCapMs}, so a slow editor's frames
 * are still spread over the drive; a helper that reports no drive is timed on the queue's clock.
 */
async function drive(
  deps: QueueDeps,
  port: EditorPort,
  step: Omit<DriveStep, "kind">,
  firstFrame: number,
): Promise<Driven> {
  const { seconds, frames } = step;
  const answer = await startStep(port, LoopTool.DriveRoute, { seconds, ...DRIVE_INPUTS });
  const started = deps.now();
  const seen: { last: Record<string, unknown> | null } = { last: null };
  const reached = async (gameAt: number) => {
    seen.last = await underWay(port, UnderWay.Drive);
    const driven = numberOr(seen.last?.gameSeconds);
    if (driven === null) return deps.now() - started >= gameAt * SECOND_MS;
    return driven >= gameAt || seen.last?.state === DriveState.Done;
  };
  // A share whose time has passed still reads the helper once, so the outcome is its latest word.
  const until = (share: number) => {
    const leftMs = Math.max(0, started + wallCapMs(seconds) * share - deps.now());
    return pollUntil(deps, () => reached(seconds * share), GAME_POLL_MS, leftMs);
  };
  const taken: Shot[] = [];
  for (let i = 1; i <= frames; i++) {
    await until(i / (frames + 1));
    taken.push(await shoot(deps, port, frameName(firstFrame + i - 1)));
  }
  await until(1);
  const route = typeof seen.last?.route === "boolean" ? seen.last.route : answer.route === true;
  const outcome = {
    route,
    gameSeconds: numberOr(seen.last?.gameSeconds) ?? 0,
    progressM: numberOr(seen.last?.progressM),
  };
  return { frames: taken, outcome };
}

/** The play world's actors as `game_state` lists them: one part's, or (`""`) every part's and every `genex:`-tagged one. */
const gameState = async (port: EditorPort, part: string) => record(await port.call(LoopTool.GameState, { part }));

/** One part's test as it plays: where its run reaches the editor, its result so far and its drive frames' count. */
type PartPlay = { deps: QueueDeps; port: EditorPort; job: PartJob; result: PartRunResult; frames: number };

async function playStep(context: PartPlay, step: PartStep): Promise<void> {
  const { deps, port, result } = context;
  switch (step.kind) {
    case PartStepKind.Hold:
      await port.call(LoopTool.Hold, { name: step.name, x: step.x, y: step.y, seconds: step.seconds });
      return playFor(deps, port, step.seconds);
    case PartStepKind.Wait:
      return playFor(deps, port, step.seconds);
    case PartStepKind.Shot:
      result.shots.push(await shoot(deps, port, step.name));
      return;
    case PartStepKind.Expect: {
      const state = await gameState(port, readsEveryTag(step.check) ? "" : context.job.part);
      result.checks.push(judgeCheck(step.check, state));
      return;
    }
    case PartStepKind.Settle:
      await settle(deps, port, step.seconds);
      return;
    case PartStepKind.Drive: {
      const driven = await drive(deps, port, step, context.frames + 1);
      context.frames += driven.frames.length;
      result.shots.push(...driven.frames);
    }
  }
}

/** Whether the editor is in a play session. */
const playing = async (port: EditorPort) => record(await port.call(LoopTool.PlayState, {})).pie === true;

/** A probe's answer, or `{error}` when it couldn't run: a probe never fails its run. */
const askProbe = (port: EditorPort, tool: LoopTool, args: Record<string, unknown>) =>
  port.call(tool, args).catch((failure: unknown) => ({ error: errorMessage(failure) }));

/** `probe_route`'s answer as the play-check hands it on: its error, or its fields (null where it gave none). */
function routeProbe(answer: unknown): RouteProbe | { error: string } {
  const read = record(answer);
  if (read.error !== undefined) return { error: String(read.error) };
  return {
    route: read.route === true,
    facingDeg: numberOr(read.facingDeg),
    offRouteCm: numberOr(read.offRouteCm),
    progressM: numberOr(read.progressM),
    lengthM: numberOr(read.lengthM),
  };
}

/**
 * What the judge can't see reliably in a shot, measured while the game still plays: every pawn's
 * ground and facing (the player's own pawn and the ones spawned at play are untagged, so the part
 * name isn't passed) and the player's view. A probe that fails is recorded and never fails the part.
 */
async function probe(port: EditorPort): Promise<PartProbes> {
  return {
    [PartProbe.Characters]: await askProbe(port, LoopTool.ProbeCharacters, { part: "" }),
    [PartProbe.View]: await askProbe(port, LoopTool.ProbeView, {}),
  };
}

/** Starts play in the editor and waits until it runs. */
async function startPlay(deps: QueueDeps, port: EditorPort) {
  await port.call(LoopTool.StartPlay, { options: PIE_OPTIONS });
  if (!(await pollUntil(deps, () => playing(port), FILE_POLL_MS, PLAY_WAIT_MS)))
    throw new Error(MESSAGE.PlayDidNotStart);
}

async function play(deps: QueueDeps, port: EditorPort, job: PartJob, result: PartRunResult) {
  await startPlay(deps, port);
  await playFor(deps, port, job.test.warmupSeconds);
  const context: PartPlay = { deps, port, job, result, frames: 0 };
  for (const step of job.test.steps) await playStep(context, step);
  result.probes = await probe(port);
}

/**
 * The play-check's play: warm up, settle, probe the pawn where it spawned and shot
 * it, drive the route with its frames, shot the ride, judge every check against every
 * `genex:`-tagged actor, probe again; the frame rate is the play world's over the drive.
 */
async function playTheGame(deps: QueueDeps, port: EditorPort, job: PlayCheckJob): Promise<PlayCheckResult> {
  await startPlay(deps, port);
  await playFor(deps, port, PLAY_CHECK.warmupSeconds);
  const settled = await settle(deps, port, PLAY_CHECK.settleSeconds);
  const characters = await askProbe(port, LoopTool.ProbeCharacters, { part: "" });
  const route = routeProbe(await askProbe(port, LoopTool.ProbeRoute, {}));
  const spawn = await shoot(deps, port, PlayCheckShot.Spawn);
  const driven = await drive(deps, port, PLAY_CHECK.drive, 1);
  const { fps } = await gameClock(port);
  const ride = await shoot(deps, port, PlayCheckShot.Ride);
  const state = await gameState(port, "");
  const checks = Object.entries(job.checks).map(([id, check]) => ({ id, ...judgeCheck(check, state) }));
  const probes = await probe(port);
  const { gameSeconds } = await gameClock(port);
  const played = { shots: [spawn, ride], frames: driven.frames, checks, probes, spawn: { characters, route } };
  return { ...played, settle: settled, drive: driven.outcome, fps, gameSeconds, ms: 0 };
}

/** Gives a setting back; never throws. */
type GiveBack = () => Promise<void>;
const NOTHING_OWED: GiveBack = async () => {};

/**
 * Turns Unreal's background throttle off for one play test, when it is on: an editor behind Genex
 * otherwise plays at a few frames per second and the test measures a slow game. Answers what gives
 * the setting back. A setting that can't be read is left alone and the test runs anyway; one that is
 * already off (the user's choice, or the bridge's own play session) is left as it is.
 */
async function liftThrottle(port: EditorPort): Promise<GiveBack> {
  const read = await port.call(LoopTool.GetProperties, readThrottleArgs()).catch(() => undefined);
  if (throttleIn(read) !== true) return NOTHING_OWED;
  await port.call(LoopTool.SetProperties, writeThrottleArgs(false)).catch(() => undefined);
  // Writing the value it had is safe even when the write above was refused or half-done.
  return async () => {
    await port.call(LoopTool.SetProperties, writeThrottleArgs(true)).catch(() => undefined);
  };
}

/** Stops a play session the queue started, and waits for it to end; never throws. */
async function stopPlay(deps: QueueDeps, port: EditorPort) {
  try {
    await port.call(LoopTool.StopPlay, {});
    await pollUntil(deps, async () => !(await playing(port)), FILE_POLL_MS, PLAY_WAIT_MS);
  } catch {
    // An editor that went away has no play session left to stop.
  }
}

/** The editor crashed while a part was in it: Unreal's report, and the part's one line as its message. */
class EditorCrashedError extends Error {
  readonly report: CrashReport;
  constructor(part: string, report: CrashReport) {
    super(shownLine(MESSAGE.Crashed(part, report.cause, report.at)));
    this.report = report;
  }
}

/**
 * A part's watch for its editor crashing while it applies and plays. The part reaches the editor
 * and waits through `port` and `clock`: each looks for a crash when the last look is
 * {@link CRASH_POLL_MS} old, a failed call looks again (twice, a pause apart: a process gone without
 * a crash in its log counts on its second look), and once a crash is found every call and wait fails
 * at once without reaching the editor. A background look every {@link CRASH_POLL_MS} catches a crash
 * while a call hangs; `ended` rejects with it. `stop` ends the background looks.
 */
type CrashGuard = {
  port: EditorPort;
  clock: Pick<QueueDeps, "now" | "sleep">;
  ended: Promise<never>;
  crashed: () => boolean;
  stop: () => Promise<void>;
};

/** A guard for an editor that can't be watched: the part reaches the editor as it is. */
const unguarded = (deps: QueueDeps, port: EditorPort): CrashGuard => ({
  port,
  clock: deps,
  ended: new Promise<never>(() => {}),
  crashed: () => false,
  stop: async () => {},
});

/**
 * The looks of one part's crash watch, one at a time (each reads the log on from where the last
 * stopped): `look` now, `due` once the last look is {@link CRASH_POLL_MS} old; `ended` rejects with
 * the crash the first look to find one found.
 */
function crashLooks(deps: QueueDeps, check: CrashCheck, part: string) {
  let found: EditorCrashedError | undefined;
  let lastLook = deps.now();
  let looking: Promise<void> = Promise.resolve();
  let fail: (crash: EditorCrashedError) => void = () => {};
  const ended = new Promise<never>((_resolve, reject) => {
    fail = reject;
  });
  // A crash found between steps has nobody racing it yet.
  ended.catch(() => {});
  const lookOnce = async () => {
    if (found) return;
    lastLook = deps.now();
    const report = await check().catch(() => undefined);
    if (!report || found) return;
    found = new EditorCrashedError(part, report);
    fail(found);
  };
  const look = () => {
    looking = looking.then(lookOnce);
    return looking;
  };
  const due = async () => {
    if (deps.now() - lastLook >= CRASH_POLL_MS) await look();
  };
  return { ended, look, due, found: () => found, settled: () => looking };
}

/** Starts watching the editor for a crash while a part is in it (see {@link CrashGuard}). */
async function guardCrash(deps: QueueDeps, port: EditorPort, part: string): Promise<CrashGuard> {
  const check = await port.watchCrash?.().catch(() => undefined);
  if (!check) return unguarded(deps, port);
  const looks = crashLooks(deps, check, part);
  const { ended, look, due, found } = looks;
  const guarded = async <T>(work: () => Promise<T>): Promise<T> => {
    await due();
    const crash = found();
    if (crash) throw crash;
    return Promise.race([work(), ended]);
  };
  // A failed call looks twice, a pause apart, before its own failure stands.
  const confirm = async (failure: unknown): Promise<never> => {
    if (failure instanceof EditorCrashedError) throw failure;
    await look();
    if (!found()) await Promise.race([deps.sleep(CRASH_POLL_MS), ended]).catch(() => {});
    await look();
    throw found() ?? failure;
  };
  const stopping = new AbortController();
  const background = (async () => {
    while (!found() && !stopping.signal.aborted) {
      await deps.sleep(CRASH_POLL_MS, stopping.signal).catch(() => {});
      if (!stopping.signal.aborted) await look();
    }
  })();
  return {
    port: {
      answering: () => port.answering(),
      call: (tool, args, timeoutMs) => guarded(() => port.call(tool, args, timeoutMs)).catch(confirm),
    },
    clock: { now: deps.now, sleep: (ms) => guarded(() => deps.sleep(ms)) },
    ended,
    crashed: () => found() !== undefined,
    stop: async () => {
      stopping.abort();
      await background;
      await looks.settled();
    },
  };
}

/**
 * Brings a C++ part's code in and hot-reloads it, applies the part and plays its test unthrottled,
 * always stopping play and then giving the throttle back; answers what the test saw. It reaches the
 * editor only through the guard's port and clock.
 */
async function testPart(deps: QueueDeps, guard: CrashGuard, run: PartRun, job: PartJob): Promise<PartRunResult> {
  const { port } = guard;
  const watched: QueueDeps = { ...deps, ...guard.clock };
  await bringCode(watched, port, job);
  const apply = record(await port.call(LoopTool.ApplyPart, { script: job.script, part: job.part }));
  if (apply.ok !== true) throw new Error(MESSAGE.ApplyFailed(String(apply.error ?? "no answer")));
  if (!guard.crashed()) update(deps, run, { state: PartRunState.Playing });
  const result: PartRunResult = { apply, shots: [], checks: [], ms: 0 };
  await unthrottled(watched, port, () => play(watched, port, job, result));
  return result;
}

/** Plays the game for a play-check unthrottled, always stopping play and then giving the throttle back. */
async function checkPlay(deps: QueueDeps, guard: CrashGuard, job: PlayCheckJob): Promise<PlayCheckResult> {
  const watched: QueueDeps = { ...deps, ...guard.clock };
  return unthrottled(watched, guard.port, () => playTheGame(watched, guard.port, job));
}

/** Runs `work` with Unreal's background throttle off, then stops play and gives the throttle back, whatever happened. */
async function unthrottled<T>(deps: QueueDeps, port: EditorPort, work: () => Promise<T>): Promise<T> {
  const giveBack = await liftThrottle(port);
  try {
    return await work();
  } finally {
    await stopPlay(deps, port);
    await giveBack();
  }
}

/** A run's end once it failed: crashed, with Unreal's signal and frames, a wait that ran out, or with why. */
function failed(failure: unknown): Partial<PartRun> {
  if (failure instanceof WaitFailedError)
    return { state: PartRunState.Failed, error: failure.message, failure: failure.failure };
  if (!(failure instanceof EditorCrashedError)) return { state: PartRunState.Failed, error: errorMessage(failure) };
  const { signal, frames } = failure.report;
  return { state: PartRunState.Failed, error: failure.message, crashed: true, crash: { signal, frames } };
}

/**
 * How one run reaches the editor: its game, the most it waits for the person in the editor, what a
 * crash names as tested, and the state it enters once the editor is its own.
 */
type Turn = { game: string; ownerWaitMs: number; tested: string; state: PartRunState };

/**
 * One run through the editor: wait for it and for the person, then `work` while watching the editor
 * for a crash, which ends the run at once.
 */
async function inEditor(
  deps: QueueDeps,
  run: PartRun,
  turn: Turn,
  work: (guard: CrashGuard) => Promise<PartRunResult | PlayCheckResult>,
) {
  const port = deps.editor(turn.game);
  const started = deps.now();
  let guard: CrashGuard | undefined;
  try {
    await waitForEditor(deps, run, port);
    await waitForOwner(deps, run, port, turn.ownerWaitMs);
    update(deps, run, { state: turn.state });
    guard = await guardCrash(deps, port, turn.tested);
    const result = await Promise.race([work(guard), guard.ended]);
    update(deps, run, { state: PartRunState.Done, result: { ...result, ms: deps.now() - started } });
  } catch (failure) {
    update(deps, run, failed(failure));
  } finally {
    await guard?.stop();
  }
}

/** The states in which a run has the editor to itself. */
const IN_EDITOR: ReadonlySet<PartRunState> = new Set([PartRunState.Applying, PartRunState.Playing]);

/** The queue over each game's one editor: part runs and play-checks, one at a time, in order. */
export function createEditorQueue(deps: QueueDeps) {
  const runs = new Map<string, PartRun>();
  let counter = 0;
  let tail: Promise<void> = Promise.resolve();

  /** Records a run of `part` in `game` and queues `go` for it; returns its id at once. */
  function queue(game: string, part: string, go: (run: PartRun) => Promise<void>): string {
    counter += 1;
    const id = `${game}-${part}-${counter}`;
    const run: PartRun = { id, game, part, state: PartRunState.Queued, startedAt: deps.now(), updatedAt: deps.now() };
    runs.set(id, run);
    tail = tail.then(() => go(run));
    return id;
  }

  /** Puts a part in the queue; returns its run's id at once. */
  const enqueue = (job: PartJob): string =>
    queue(job.game, job.part, (run) => {
      const turn = { game: job.game, ownerWaitMs: OWNER_WAIT_MS, tested: job.part, state: PartRunState.Applying };
      return inEditor(deps, run, turn, (guard) => testPart(deps, guard, run, job));
    });

  /** Puts a play-check in the queue (its run's part is `play-check`); returns its run's id at once. */
  const enqueuePlayCheck = (job: PlayCheckJob): string =>
    queue(job.game, PLAY_CHECK_PART, (run) => {
      const turn = {
        game: job.game,
        ownerWaitMs: job.ownerWaitMs,
        tested: PLAY_CHECK_TESTED,
        state: PartRunState.Playing,
      };
      return inEditor(deps, run, turn, (guard) => checkPlay(deps, guard, job));
    });

  /** Whether a run of `game`'s has the editor now (applying or playing), so its play is the queue's own. */
  const busy = (game: string): boolean =>
    [...runs.values()].some((run) => run.game === game && IN_EDITOR.has(run.state));

  return { enqueue, enqueuePlayCheck, busy, status: (id: string): PartRun | undefined => runs.get(id) };
}

/** The queue a backend keeps. */
export type EditorQueue = ReturnType<typeof createEditorQueue>;
