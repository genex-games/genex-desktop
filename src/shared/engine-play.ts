/**
 * Playing a game inside its engine's editor (`TargetRuntime.Editor`): the harness tools an engine
 * plugin provides so the studio's `computer` tool can play its games the
 * way it plays a web game — a picture of what the player sees, keys held on the game's own clock,
 * and the game's state the studio checks goals against. The tools are the plugin's, by these names
 * after `<plugin>__`; the studio's target (`main/core/editor-play-target.ts`) stays engine-agnostic.
 * Unreal's use its engine link and editor helper; Unity's use explicit project facts and Pipeline.
 *
 * Every tool is a harness step (`audience: "harness"`) that needs the plugin's editor lock for its
 * call: the person first, any other caller in turn.
 */

import {
  ClockLevel,
  EDITOR_CAPABILITIES,
  PointerLevel,
  StateLevel,
  type TargetCapabilities,
} from "./computer-target.ts";

/** The play tools, by their names after `<plugin>__`. Wire values: never rename. */
export const EnginePlayTool = {
  /** Start play (or join the play already running; `fresh`: start it over, as a judge needs): answers the view's size. */
  Open: "play-open",
  /** Hold keys together for a time on the game's own clock, then let go: answers once that time has passed. */
  Input: "play-input",
  /** A picture of what the player sees: answers a JPEG or a PNG, as its `mime` says. */
  Shot: "play-shot",
  /** The game's state: the player and the game's own numbers, as the engine plugin reads them. */
  State: "play-state",
  /** Stand the play still (`paused: true`) or let it run: the studio holds a judge's game still between moves. */
  Pause: "play-pause",
  /** Let go of every key and end the play the session started. */
  Close: "play-close",
} as const;
export type EnginePlayTool = (typeof EnginePlayTool)[keyof typeof EnginePlayTool];

/** Every play tool an engine plugin must provide for its games to be played through `computer`. */
export const ENGINE_PLAY_TOOLS: readonly EnginePlayTool[] = Object.values(EnginePlayTool);

/** The view every play shot is taken at, unless the engine says otherwise. */
export const ENGINE_PLAY_VIEW = { width: 1280, height: 720 } as const;

/** The longest one `play-input` holds keys, in game seconds. */
export const MAX_PLAY_INPUT_SECONDS = 10;

/** The most players one play may open: each is its own window of the editor's play. */
export const MAX_PLAY_PLAYERS = 8;

/**
 * What an engine's editor can do in play, as its plugin declares it (`engine.play`): how many
 * players one play opens at most, its clock, whether the mouse aims as a player's does and whether
 * the game's state can be read. Absent fields are the editor defaults.
 */
export interface EnginePlayDeclaration {
  /** 1 to `MAX_PLAY_PLAYERS`. */
  players?: number;
  clock?: ClockLevel;
  pointer?: boolean;
  state?: boolean;
}

/** The most bytes one play shot may hold: a bigger picture is refused, never shown to a model (its limit is 1 MB). */
export const MAX_PLAY_SHOT_BYTES = 1_000_000;

/** The clock levels, from none to the most the studio can do with a clock. */
const CLOCK_ORDER: readonly ClockLevel[] = [
  ClockLevel.None,
  ClockLevel.Freeze,
  ClockLevel.StepLocked,
  ClockLevel.Replayable,
];

/** The play tools pause a play and never step it: the most clock an editor's play can have. */
const EDITOR_CLOCK_MOST: ClockLevel = ClockLevel.Freeze;

/** The lower of two clock levels. */
function lowerClock(a: ClockLevel, b: ClockLevel): ClockLevel {
  return CLOCK_ORDER.indexOf(a) <= CLOCK_ORDER.indexOf(b) ? a : b;
}

/** Whether a value is one of the clock levels. */
function isClockLevel(value: unknown): value is ClockLevel {
  return (CLOCK_ORDER as readonly unknown[]).includes(value);
}

/** A player's number: a whole number from 1 to `MAX_PLAY_PLAYERS`, else null. */
export function playerArg(value: unknown): number | null {
  const valid = typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_PLAY_PLAYERS;
  return valid ? value : null;
}

/** How many players a play is asked to open: a player's number, else 1. */
export function playersArg(value: unknown): number {
  return playerArg(value) ?? 1;
}

/** The capabilities with `players` set, or left out at one player (which is what absent means). */
function withPlayers(caps: TargetCapabilities, players: number): TargetCapabilities {
  const { players: _dropped, ...rest } = caps;
  return players > 1 ? { ...rest, players } : rest;
}

/**
 * What the computer can do in an engine's editor play, as the engine's plugin declares it
 * (`engine.play`): its players, its clock (at most the play's own pause), whether the mouse aims as
 * a player's does, and whether the game's state can be read. Nothing declared is the editor's own
 * ({@link EDITOR_CAPABILITIES}).
 */
export function editorCapabilities(play: EnginePlayDeclaration = {}): TargetCapabilities {
  const caps: TargetCapabilities = { ...EDITOR_CAPABILITIES };
  if (play.clock !== undefined) caps.clock = lowerClock(play.clock, EDITOR_CLOCK_MOST);
  if (play.pointer === false) Object.assign(caps, { pointer: PointerLevel.None, aimedClicks: false });
  if (play.state === false) caps.state = StateLevel.None;
  return withPlayers(caps, playersArg(play.players));
}

/** A field of an object, when the value is an object that has it. */
function ownField(value: unknown, name: string): unknown {
  if (typeof value !== "object" || value === null || !Object.hasOwn(value, name)) return undefined;
  const field: unknown = Reflect.get(value, name);
  return field;
}

/**
 * The capabilities `caps` as a play's own answer says it can do (`play-open`'s `capabilities`, in
 * the declaration's shape): each field can only lower what was declared, never raise it, and
 * anything the answer does not say stays as declared.
 */
export function narrowCapabilities(caps: TargetCapabilities, answered: unknown): TargetCapabilities {
  const narrowed: TargetCapabilities = { ...caps };
  const clock = ownField(answered, "clock");
  if (isClockLevel(clock)) narrowed.clock = lowerClock(caps.clock, clock);
  if (ownField(answered, "pointer") === false)
    Object.assign(narrowed, { pointer: PointerLevel.None, aimedClicks: false });
  if (ownField(answered, "state") === false) narrowed.state = StateLevel.None;
  const players = playerArg(ownField(answered, "players"));
  return withPlayers(narrowed, Math.min(caps.players ?? 1, players ?? MAX_PLAY_PLAYERS));
}

/** What `play-open` is asked: how many players to open; absent is one. */
export interface EnginePlayOpenArgs {
  players?: number;
}

/**
 * What `play-open` answers: the view's size, whether the play was already running, and where the
 * engine can say so, how many players joined, what this play can do (in the declaration's shape, which
 * can only narrow it) and whether the game's live saved data can be reached from it.
 */
export interface EnginePlayOpened {
  width: number;
  height: number;
  joined: boolean;
  players?: number;
  capabilities?: EnginePlayDeclaration;
  liveData?: boolean;
}

/** Which player a play tool is for: absent is player 1, which is never sent. */
export interface EnginePlayerArgs {
  player?: number;
}

/** The arguments that name a player: nothing for player 1. */
export function playerArgs(player: number): EnginePlayerArgs {
  return player > 1 ? { player } : {};
}

/** The mouse buttons, as `play-input` names them among its keys (web key codes have none). Wire values: never rename. */
export const MouseButtonCode = { Left: "MouseLeft", Right: "MouseRight", Middle: "MouseMiddle" } as const;
export type MouseButtonCode = (typeof MouseButtonCode)[keyof typeof MouseButtonCode];

/** One frame of the player's mouse: motion in pixels (down the screen is +dy) and wheel notches (up is +). */
export interface EnginePlayMouse {
  dx?: number;
  dy?: number;
  wheel?: number;
}

/**
 * What `play-input` is asked: keys as web key codes (`KeyboardEvent.code`: `KeyW`, `Space`,
 * `ArrowUp`, `ShiftLeft`, `Digit1`) or mouse buttons ({@link MouseButtonCode}) joined by commas,
 * held together, after one frame of the mouse when it moves; the engine plugin names them in its
 * engine. Plugin tool parameters are scalars, so the keys are one string; none is a wait.
 */
export interface EnginePlayInputArgs extends EnginePlayMouse, EnginePlayerArgs {
  keys: string;
  seconds: number;
}

/** The keys a `play-input` names, in order: `"KeyW,ShiftLeft"` is `["KeyW", "ShiftLeft"]`. */
export function playInputKeys(keys: unknown): string[] {
  return typeof keys === "string"
    ? keys
        .split(",")
        .map((key) => key.trim())
        .filter(Boolean)
    : [];
}

/**
 * A `play-input`'s arguments for keys held together for `seconds`, after one frame of `mouse` when
 * it moves, by `player` (named only above 1).
 */
export function playInputArgs(
  keys: readonly string[],
  seconds: number,
  mouse: EnginePlayMouse = {},
  player = 1,
): EnginePlayInputArgs {
  return { keys: keys.join(","), seconds, ...mouse, ...playerArgs(player) };
}

/** What `play-input` answers: the keys the engine took, and the game seconds that passed. */
export interface EnginePlayInputAnswer {
  held: string[];
  gameSeconds: number | null;
}

/**
 * What `play-shot` answers: the picture as base64 `data` with its `mime` (`image/jpeg` or
 * `image/png`; anything else is read as PNG), at the view's size. `png` is the older name for a
 * PNG's data, read when `data` is absent.
 */
export interface EnginePlayShot {
  data?: string;
  png?: string;
  mime?: string;
  width: number;
  height: number;
}

/** Why a play tool did not do what it was asked, as a code: the words the model reads are the target's. */
export const EnginePlayRefusal = {
  /** The editor is not open or does not answer. */
  NoEditor: "no-editor",
  /** The engine's own queue is playing a build now; try again when it has finished. */
  Busy: "busy",
  /** No play is running (it ended, or the person stopped it). */
  NotPlaying: "not-playing",
  /** A key the engine has no name for. */
  UnknownKey: "unknown-key",
  /** The engine cannot do this at all (more players, a pause): the studio stops asking, never retries. */
  Unsupported: "unsupported",
  /** A fresh play was asked for while the person plays: their game is never started over. */
  PersonPlaying: "person-playing",
} as const;
export type EnginePlayRefusal = (typeof EnginePlayRefusal)[keyof typeof EnginePlayRefusal];

/** A play tool's refusal, as every play tool answers one. */
export interface EnginePlayRefused {
  refused: EnginePlayRefusal;
  message: string;
}

/** Whether a play tool's answer is a refusal. */
export function isEnginePlayRefused(answer: unknown): answer is EnginePlayRefused {
  if (typeof answer !== "object" || answer === null) return false;
  return (
    "refused" in answer &&
    typeof answer.refused === "string" &&
    "message" in answer &&
    typeof answer.message === "string"
  );
}
