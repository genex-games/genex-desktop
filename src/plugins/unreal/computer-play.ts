/**
 * The studio's `computer` tool playing an Unreal game (`shared/engine-play.ts`): a play session in
 * the game's own editor (Play In Editor), driven through the Genex editor helper the editor queue
 * already uses — keys held on the game's own clock, one frame of the player's mouse (looking, the
 * wheel; its buttons are keys), a shot of what the player sees, the player's state. Each tool takes the editor lock for its call (`needs: ["editor"]`), the person first.
 *
 * A session joins a play that is already running rather than restarting it, and ends only a play
 * it started itself. A play it started is marked as the agent's (`agent-play.ts`) while it runs, so
 * the lock's person-first probe does not read it as the person playing; a session whose plugin
 * restarted takes over the play that mark still claims, and ends it. While the editor queue still has a part or a play-check of the game to run,
 * the editor is the queue's: a session is refused (`busy`) rather than playing over it.
 *
 * Unreal plays one player: a play of more players, or a call for any player but the first, is
 * refused as `unsupported` before anything reaches the editor.
 */
import {
  ENGINE_PLAY_VIEW,
  type EnginePlayInputAnswer,
  type EnginePlayLooked,
  EnginePlayLookState,
  type EnginePlayOpened,
  EnginePlayOptionalTool,
  EnginePlayRefusal,
  type EnginePlayRefused,
  type EnginePlayShot,
  EnginePlayTool,
  type EnginePlayWalked,
  EnginePlayWalkState,
  lookedOf,
  MAX_PLAY_INPUT_SECONDS,
  MouseButtonCode,
  PilotPhase,
  playerArg,
  playInputKeys,
  walkedOf,
} from "../../shared/engine-play.ts";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { SECOND_MS } from "../../shared/duration.ts";
import { StillMimeType } from "../../shared/preview-contract.ts";
import type { PluginContext } from "../../plugin-sdk/index.d.ts";
import { type AgentPlayMarker, agentPlayFolder, agentPlayMarker, agentPlaying, NO_AGENT_PLAY } from "./agent-play.ts";
import {
  type EditorQueue,
  followMotion,
  gameClock,
  type GiveBack,
  LoopTool,
  liftThrottle,
  PlayMotion,
  playFor,
  playForWhileRunning,
  playing,
  type QueueDeps,
  shoot,
  startPlay,
  startStep,
  stopPlay,
} from "./editor-queue.ts";
import { linkedProject } from "./editor-port.ts";
import { writeRunRecord } from "./playtest-record.ts";
import { ensureStarterPilot } from "./starter-pilot.ts";

/** How long a play this session starts runs before the first look, in game seconds, as the play-check's does. */
const WARMUP_SECONDS = 2;
/** A play whose clock stands still this long has paused itself (a title menu): it is warm. */
const WARMUP_STILL_MS = 1.5 * SECOND_MS;
/** The shortest hold the helper takes, in game seconds: about a tap. */
const MIN_HOLD_SECONDS = 0.05;
/** A walk's most game seconds when the call names none, the most it may name, and how near it stops (m). */
const WALK_SECONDS = 20;
const MAX_WALK_SECONDS = 120;
const WALK_WITHIN_M = 1.2;
/** A turn of the view's most game seconds: a slow editor takes a few game seconds for its frames. */
const LOOK_SECONDS = 6;
/** A pilot's game seconds when the call names none, and the most it may name (the helper's own cap). */
const PILOT_SECONDS = 60;
const MAX_PILOT_SECONDS = 300;
/** A play shot's name: the helper takes 1 to 64 letters, digits, `_` or `-`. */
const SHOT_PREFIX = "genex-computer";

/** Web key codes (`KeyboardEvent.code`) by Unreal's key names: letters and digits are by rule, below. */
const UNREAL_KEYS: Readonly<Record<string, string>> = {
  Space: "SpaceBar",
  Enter: "Enter",
  NumpadEnter: "Enter",
  Escape: "Escape",
  Tab: "Tab",
  Backspace: "BackSpace",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ShiftLeft: "LeftShift",
  ShiftRight: "RightShift",
  ControlLeft: "LeftControl",
  ControlRight: "RightControl",
  AltLeft: "LeftAlt",
  AltRight: "RightAlt",
  MetaLeft: "LeftCommand",
  MetaRight: "RightCommand",
  Minus: "Hyphen",
  Equal: "Equals",
  Comma: "Comma",
  Period: "Period",
  Slash: "Slash",
  Semicolon: "Semicolon",
  Quote: "Apostrophe",
  BracketLeft: "LeftBracket",
  BracketRight: "RightBracket",
  Backslash: "Backslash",
  Backquote: "Tilde",
  [MouseButtonCode.Left]: "LeftMouseButton",
  [MouseButtonCode.Right]: "RightMouseButton",
  [MouseButtonCode.Middle]: "MiddleMouseButton",
};
/** Unreal's names for the digit keys, `Digit0` to `Digit9`. */
const DIGITS = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"] as const;
/** The function keys Unreal names, `F1` to `F12`. */
const FUNCTION_KEY = /^F(?:[1-9]|1[0-2])$/;

const MESSAGE = {
  busy: "Unreal is playing a build for the Loop right now; try again once it has finished.",
  noEditor: "This game's Unreal Editor is not open or does not answer; call unreal__open-editor, then try again.",
  notPlaying: "No play is running in Unreal (it ended, or the person stopped it); look again to start one.",
  personPlaying: "The person is playing in Unreal; a fresh play waits until they stop.",
  unknownKey: (keys: string[]) => `Unreal has no key for ${keys.join(", ")}.`,
  onePlayer: "Unreal plays one player here; play with one.",
} as const;

/** Unreal's own names for the keys the table maps to. */
const UNREAL_KEY_NAMES: ReadonlySet<string> = new Set(Object.values(UNREAL_KEYS));

/** Unreal's name for a web key code, or null when Unreal has none. */
export function unrealKey(code: string): string | null {
  // Unreal's own name for a key (LeftMouseButton, SpaceBar, E), as an agent who read the game's code writes it.
  if (UNREAL_KEY_NAMES.has(code) || /^[A-Z]$/.test(code)) return code;
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1] ?? null;
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return DIGITS[Number(digit[1])] ?? null;
  if (FUNCTION_KEY.test(code)) return code;
  return UNREAL_KEYS[code] ?? null;
}

const refused = (code: EnginePlayRefusal, message: string): EnginePlayRefused => ({ refused: code, message });

/** Whether a call asks for more than Unreal's one player: more players to open, or another player than the first. */
function beyondOnePlayer(args: Record<string, unknown>, name: "players" | "player"): boolean {
  return args[name] !== undefined && playerArg(args[name]) !== 1;
}

/** A play tool's handler: its arguments, the call's context and the plugin's storage. */
type PlayHandler = (args: Record<string, unknown>, context: PluginContext, storage: string) => Promise<unknown>;

/** A handler that refuses, as unsupported, a call beyond Unreal's one player before anything reaches the editor. */
function onePlayerOnly(name: "players" | "player", handler: PlayHandler): PlayHandler {
  // Not an async wrapper: an allowed call starts in the same tick, as the handler alone would.
  return (args, context, storage) =>
    beyondOnePlayer(args, name)
      ? Promise.resolve(refused(EnginePlayRefusal.Unsupported, MESSAGE.onePlayer))
      : handler(args, context, storage);
}

/** A finite number argument, else 0. */
const numberArg = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** The game's folder name the call is for, as the queue names a game. */
type GameOf = (context: PluginContext) => string;

/** Why a fresh play could not start over the one running. */
const RestartRefusal = { PersonPlaying: "person-playing" } as const;
type RestartRefusal = (typeof RestartRefusal)[keyof typeof RestartRefusal];

/** What a session owes when it ends: the throttle back, and whether to stop the play it started. */
interface PlaySession {
  giveBack: GiveBack;
  started: boolean;
}

/** One session per game in one storage. */
const keyOf = (storage: string, game: string) => `${storage}\u0000${game}`;

/** The mark that says a play is the agent's own, or none when the game has no folder. */
function markerOf(storage: string, game: string, queueDeps: QueueDeps): AgentPlayMarker {
  const folder = agentPlayFolder(storage, game);
  return folder ? agentPlayMarker(folder, queueDeps.now) : NO_AGENT_PLAY;
}

/**
 * Ends a play left running so a fresh one can start: an agent's (the session's own, or one its mark
 * claims) is stopped; the person's is never touched. Null when nothing ran or it was stopped.
 */
async function endForFresh(
  sessions: ReadonlyMap<string, PlaySession>,
  storage: string,
  game: string,
  queueDeps: QueueDeps,
  port: ReturnType<QueueDeps["editor"]>,
): Promise<RestartRefusal | null> {
  if (!(await playing(port))) return null;
  const ours = sessions.get(keyOf(storage, game))?.started || (await agentPlaying(storage, game, queueDeps.now()));
  if (!ours) return RestartRefusal.PersonPlaying;
  await stopPlay(queueDeps, port);
  await markerOf(storage, game, queueDeps).stopped();
  return null;
}

/**
 * What a new play session takes from the editor and gives back when it ends: the background throttle,
 * and the full rendering (an agent's play renders lighter, so a heavy game plays at a usable rate). An
 * older helper without the light switch is left as it renders.
 */
async function liftThrottleAndLight(
  port: ReturnType<QueueDeps["editor"]>,
  platform: NodeJS.Platform | undefined,
): Promise<GiveBack> {
  const throttle = await liftThrottle(port, platform);
  const lit = await port.call(LoopTool.LightPlay, { on: true }).catch(() => null);
  const lightened = typeof lit === "object" && lit !== null && Reflect.get(lit, "light") === true;
  return async () => {
    if (lightened) await port.call(LoopTool.LightPlay, { on: false }).catch(() => undefined);
    await throttle();
  };
}

/** Where a call's game plays: its queue's clock and its editor's port. */
type PortOf = (
  storage: string,
  context: PluginContext,
) => { game: string; queueDeps: QueueDeps; port: ReturnType<QueueDeps["editor"]> };

/** The play tools that walk the player and turn its view by themselves, through the helper. */
function motionHandlers(portOf: PortOf) {
  const walk = async (args: Record<string, unknown>, context: PluginContext, storage: string) => {
    const { queueDeps, port } = portOf(storage, context);
    if (!(await playing(port))) return refused(EnginePlayRefusal.NotPlaying, MESSAGE.notPlaying);
    const target = typeof args.target === "string" ? args.target.trim() : "";
    const asked = numberArg(args.seconds);
    const seconds = Math.min(MAX_WALK_SECONDS, asked > 0 ? asked : WALK_SECONDS);
    const start = { tool: LoopTool.WalkTo, key: PlayMotion.Walk, args: { target, within: WALK_WITHIN_M, seconds } };
    const last = await followMotion(queueDeps, port, start, seconds);
    const answer: EnginePlayWalked =
      typeof last.error === "string"
        ? walkedOf({ state: EnginePlayWalkState.Failed, reason: last.error }, target)
        : walkedOf(last, target);
    return answer;
  };

  const look = async (args: Record<string, unknown>, context: PluginContext, storage: string) => {
    const { queueDeps, port } = portOf(storage, context);
    if (!(await playing(port))) return refused(EnginePlayRefusal.NotPlaying, MESSAGE.notPlaying);
    const target = typeof args.target === "string" ? args.target.trim() : "";
    const start = { tool: LoopTool.LookAt, key: PlayMotion.Look, args: { target, seconds: LOOK_SECONDS } };
    const last = await followMotion(queueDeps, port, start, LOOK_SECONDS);
    const answer: EnginePlayLooked =
      typeof last.error === "string"
        ? lookedOf({ state: EnginePlayLookState.Failed, reason: last.error }, target)
        : lookedOf(last, target);
    return answer;
  };
  return { walk, look, ...pilotHandlers(portOf) };
}

/**
 * The pilot file the helper is given: a `.py` of the game folder (Genex's own, `pilots/<goal>.py`, so
 * writing one changes nothing of the game) by its real path, when it is a plain file there with no
 * link on the way; otherwise the text as it came, which the helper reads relative to the project.
 */
export async function pilotFileFor(file: string, gameFolder: string | undefined): Promise<string> {
  const plain = file.endsWith(".py") && !path.isAbsolute(file) && !file.split(/[\\/]/).includes("..");
  if (!plain || !gameFolder) return file;
  try {
    const root = await realpath(gameFolder);
    const wanted = path.join(root, file);
    const real = await realpath(wanted);
    const inside = real === wanted && !path.relative(root, real).startsWith("..");
    return inside && (await stat(real)).isFile() ? real : file;
  } catch {
    return file; // not in the game folder: the project's own, or nothing the helper will find
  }
}

/**
 * The play tools that run a pilot through the helper: start it, then step it. The decisions'
 * loop is the studio's (`main/core/editor-play-target.ts`); these only carry its calls to the play.
 */
function pilotHandlers(portOf: PortOf) {
  const pilot = async (args: Record<string, unknown>, context: PluginContext, storage: string) => {
    const { port } = portOf(storage, context);
    if (!(await playing(port))) return refused(EnginePlayRefusal.NotPlaying, MESSAGE.notPlaying);
    const file = await pilotFileFor(typeof args.file === "string" ? args.file.trim() : "", context.directory);
    const asked = numberArg(args.seconds);
    const seconds = Math.min(MAX_PILOT_SECONDS, asked > 0 ? asked : PILOT_SECONDS);
    return port.call(LoopTool.Pilot, { file, seconds, decide: args.decide === true });
  };
  const pilotStep = async (args: Record<string, unknown>, context: PluginContext, storage: string) => {
    const { game, port } = portOf(storage, context);
    const answer = typeof args.answer === "string" ? args.answer : "";
    const step = await port.call(LoopTool.PilotStep, { answer, stop: args.stop === true });
    return recorded(step, context.directory, () => linkedProject(storage, game));
  };
  return { pilot, pilotStep };
}

/**
 * A step that says the run is over gets the run's record written into the game folder (whatever the
 * agent does next), and the record's path in its report; a record that cannot be written leaves the
 * step as it was.
 */
async function recorded(step: unknown, gameFolder: string | undefined, project: () => Promise<string | undefined>) {
  const report: unknown = typeof step === "object" && step !== null ? Reflect.get(step, "report") : undefined;
  const over = typeof step === "object" && step !== null && Reflect.get(step, "phase") === PilotPhase.Over;
  if (!over || !gameFolder || typeof report !== "object" || report === null) return step;
  try {
    const record = await writeRunRecord(gameFolder, await project(), report);
    if (record) Reflect.set(report, "record", record);
  } catch {
    // The run's report reaches the agent with or without its record.
  }
  return step;
}

/** The optional play tools (walking, looking, pilots), each for player 1 only. */
function optionalHandlers(portOf: PortOf) {
  const { walk, look, pilot, pilotStep } = motionHandlers(portOf);
  return {
    [EnginePlayOptionalTool.Walk]: onePlayerOnly("player", walk),
    [EnginePlayOptionalTool.Look]: onePlayerOnly("player", look),
    [EnginePlayOptionalTool.Pilot]: onePlayerOnly("player", pilot),
    [EnginePlayOptionalTool.PilotStep]: onePlayerOnly("player", pilotStep),
  } as const;
}

/** The play tools over the queue's own editor port and clock. */
export function createComputerPlay(deps: {
  queueDeps(storage: string): QueueDeps;
  queue(storage: string): EditorQueue;
  game: GameOf;
}) {
  const sessions = new Map<string, PlaySession>();
  let shots = 0;
  const portOf = (storage: string, context: PluginContext) => {
    const game = deps.game(context);
    const queueDeps = deps.queueDeps(storage);
    return { game, queueDeps, port: queueDeps.editor(game) };
  };

  const open = async (args: Record<string, unknown>, context: PluginContext, storage: string) => {
    const { game, queueDeps, port } = portOf(storage, context);
    if (deps.queue(storage).busy(game)) return refused(EnginePlayRefusal.Busy, MESSAGE.busy);
    if (!(await port.answering())) return refused(EnginePlayRefusal.NoEditor, MESSAGE.noEditor);
    const key = keyOf(storage, game);
    const restarted = args.fresh === true ? await endForFresh(sessions, storage, game, queueDeps, port) : null;
    if (restarted === RestartRefusal.PersonPlaying)
      return refused(EnginePlayRefusal.PersonPlaying, MESSAGE.personPlaying);
    const joined = await playing(port);
    // A session that is already open keeps what it owes; only a new one lifts the throttle.
    const known = sessions.get(key);
    const giveBack = known?.giveBack ?? (await liftThrottleAndLight(port, queueDeps.platform));
    if (!joined) {
      // Marked before play starts: a probe between the two would read the play as the person's.
      await markerOf(storage, game, queueDeps).started();
      await startPlay(queueDeps, port).catch(async (error: unknown) => {
        // No session will hold what this one took, so it goes back now.
        await markerOf(storage, game, queueDeps).stopped();
        if (!known) await giveBack();
        throw error;
      });
      // UE 5.8 has nothing to capture in a play's first moments.
      await playForWhileRunning(queueDeps, port, WARMUP_SECONDS, WARMUP_STILL_MS);
    }
    // A play the agent's mark still claims is the agent's own, left by a session whose plugin restarted.
    const agents = joined && !known && (await agentPlaying(storage, game, queueDeps.now()));
    sessions.set(key, { giveBack, started: (known?.started ?? false) || !joined || agents });
    // A game with no pilot yet gets Genex's starter, so a playtest can start playing at once.
    await ensureStarterPilot(context.directory);
    const opened: EnginePlayOpened = { ...ENGINE_PLAY_VIEW, joined };
    return opened;
  };

  const input = async (args: Record<string, unknown>, context: PluginContext, storage: string) => {
    const { queueDeps, port } = portOf(storage, context);
    const codes = playInputKeys(args.keys);
    const names = codes.map((code) => ({ code, name: unrealKey(code) }));
    const unknown = names.filter((key) => key.name === null).map((key) => key.code);
    if (unknown.length) return refused(EnginePlayRefusal.UnknownKey, MESSAGE.unknownKey(unknown));
    if (!(await playing(port))) return refused(EnginePlayRefusal.NotPlaying, MESSAGE.notPlaying);
    const asked = typeof args.seconds === "number" ? args.seconds : MIN_HOLD_SECONDS;
    const seconds = Math.min(MAX_PLAY_INPUT_SECONDS, Math.max(MIN_HOLD_SECONDS, asked));
    const held = names.flatMap((key) => (key.name ? [key.name] : []));
    const mouse = { dx: numberArg(args.dx), dy: numberArg(args.dy), wheel: numberArg(args.wheel) };
    // One frame of the mouse first, as a player turns to aim, then presses.
    if (mouse.dx || mouse.dy || mouse.wheel) await startStep(port, LoopTool.Mouse, mouse);
    for (const name of held) await startStep(port, LoopTool.Hold, { name, x: 1, y: 0, seconds });
    await playFor(queueDeps, port, seconds);
    const answer: EnginePlayInputAnswer = { held, gameSeconds: (await gameClock(port)).gameSeconds };
    return answer;
  };

  const shot = async (_args: Record<string, unknown>, context: PluginContext, storage: string) => {
    const { queueDeps, port } = portOf(storage, context);
    if (!(await playing(port))) return refused(EnginePlayRefusal.NotPlaying, MESSAGE.notPlaying);
    shots += 1;
    const name = `${SHOT_PREFIX}-${shots}`;
    // What the player sees, its HUD and menus included: a UI-only change shows in it. A project's
    // older helper takes no UI shot: the 3D frame alone still shows the game.
    const taken = await shoot(queueDeps, port, name, true).catch(() => shoot(queueDeps, port, name, false));
    // The helper captures PNG; `png` stays beside `data` for a studio that reads only the older name.
    const answer: EnginePlayShot = { data: taken.data, mime: StillMimeType.Png, png: taken.data, ...ENGINE_PLAY_VIEW };
    return answer;
  };

  const state = async (_args: Record<string, unknown>, context: PluginContext, storage: string) => {
    const { port } = portOf(storage, context);
    if (!(await playing(port))) return refused(EnginePlayRefusal.NotPlaying, MESSAGE.notPlaying);
    // Only the computer's own read takes the detectors' findings: the plugin's polls only peek.
    return port.call(LoopTool.PlayerState, { take_findings: true });
  };

  const pause = async (args: Record<string, unknown>, context: PluginContext, storage: string) => {
    const { port } = portOf(storage, context);
    if (!(await playing(port))) return refused(EnginePlayRefusal.NotPlaying, MESSAGE.notPlaying);
    return port.call(LoopTool.Pause, { paused: args.paused === true });
  };

  const close = async (_args: Record<string, unknown>, context: PluginContext, storage: string) => {
    const { game, queueDeps, port } = portOf(storage, context);
    const key = keyOf(storage, game);
    const session = sessions.get(key);
    sessions.delete(key);
    if (!session) return { closed: false };
    // A paused game is never left behind, the person's own play least of all.
    if (await playing(port)) await port.call(LoopTool.Pause, { paused: false }).catch(() => undefined);
    // A play the person or the queue started goes on; one this session started ends with it.
    if (session.started) {
      await stopPlay(queueDeps, port);
      await markerOf(storage, game, queueDeps).stopped();
    }
    await session.giveBack();
    return { closed: true };
  };

  const handlers = {
    [EnginePlayTool.Open]: onePlayerOnly("players", open),
    [EnginePlayTool.Input]: onePlayerOnly("player", input),
    [EnginePlayTool.Shot]: onePlayerOnly("player", shot),
    [EnginePlayTool.State]: onePlayerOnly("player", state),
    [EnginePlayTool.Pause]: pause,
    [EnginePlayTool.Close]: close,
    ...optionalHandlers(portOf),
  } as const satisfies Record<EnginePlayTool | EnginePlayOptionalTool, PlayHandler>;
  return { handlers };
}
