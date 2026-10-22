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
  type EnginePlayOpened,
  EnginePlayRefusal,
  type EnginePlayRefused,
  type EnginePlayShot,
  EnginePlayTool,
  MAX_PLAY_INPUT_SECONDS,
  MouseButtonCode,
  playerArg,
  playInputKeys,
} from "../../shared/engine-play.ts";
import { StillMimeType } from "../../shared/preview-contract.ts";
import type { PluginContext } from "../../plugin-sdk/index.d.ts";
import { type AgentPlayMarker, agentPlayFolder, agentPlayMarker, agentPlaying, NO_AGENT_PLAY } from "./agent-play.ts";
import {
  type EditorQueue,
  gameClock,
  type GiveBack,
  LoopTool,
  liftThrottle,
  playFor,
  playing,
  type QueueDeps,
  shoot,
  startPlay,
  startStep,
  stopPlay,
} from "./editor-queue.ts";

/** How long a play this session starts runs before the first look, in game seconds, as the play-check's does. */
const WARMUP_SECONDS = 2;
/** The shortest hold the helper takes, in game seconds: about a tap. */
const MIN_HOLD_SECONDS = 0.05;
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
  noEditor: "This game's Unreal Editor is not open or does not answer; open it (the Unreal button) and try again.",
  notPlaying: "No play is running in Unreal (it ended, or the person stopped it); look again to start one.",
  personPlaying: "The person is playing in Unreal; a fresh play waits until they stop.",
  unknownKey: (keys: string[]) => `Unreal has no key for ${keys.join(", ")}.`,
  onePlayer: "Unreal plays one player here; play with one.",
} as const;

/** Unreal's name for a web key code, or null when Unreal has none. */
export function unrealKey(code: string): string | null {
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
    const giveBack = known?.giveBack ?? (await liftThrottle(port, queueDeps.platform));
    if (!joined) {
      // Marked before play starts: a probe between the two would read the play as the person's.
      await markerOf(storage, game, queueDeps).started();
      await startPlay(queueDeps, port);
      // UE 5.8 has nothing to capture in a play's first moments.
      await playFor(queueDeps, port, WARMUP_SECONDS);
    }
    // A play the agent's mark still claims is the agent's own, left by a session whose plugin restarted.
    const agents = joined && !known && (await agentPlaying(storage, game, queueDeps.now()));
    sessions.set(key, { giveBack, started: (known?.started ?? false) || !joined || agents });
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
    const taken = await shoot(queueDeps, port, `${SHOT_PREFIX}-${shots}`);
    // The helper captures PNG; `png` stays beside `data` for a studio that reads only the older name.
    const answer: EnginePlayShot = { data: taken.data, mime: StillMimeType.Png, png: taken.data, ...ENGINE_PLAY_VIEW };
    return answer;
  };

  const state = async (_args: Record<string, unknown>, context: PluginContext, storage: string) => {
    const { port } = portOf(storage, context);
    if (!(await playing(port))) return refused(EnginePlayRefusal.NotPlaying, MESSAGE.notPlaying);
    return port.call(LoopTool.PlayerState, {});
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
  } as const satisfies Record<EnginePlayTool, PlayHandler>;
  return { handlers };
}
