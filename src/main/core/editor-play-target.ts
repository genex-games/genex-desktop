/**
 * A game played in its engine's editor (`TargetRuntime.Editor`): the `computer` tool's target over
 * the game's engine plugin's play tools (`shared/engine-play.ts`) — Unreal's Play In Editor first
 * (`plugins/unreal/computer-play.ts`). The target stays engine-agnostic: keys go out as web key
 * codes and the plugin names them in its engine; a picture is what the player sees; state is the
 * player as the plugin reads it, which the session checks goals against.
 *
 * Every play tool takes the plugin's editor lock for its call (the person first, another caller in
 * turn), and opening is refused while the engine's own queue plays a build. The play's own pause is
 * the target's clock: a judge's game stands still between its moves. The lock is not held
 * between calls: the agent's own editor calls in the same turn go on as they would. The session's
 * release ends the play it started.
 *
 * What the target can do is what the engine's plugin declares (`editorCapabilities`), narrowed by
 * what the opened play says of itself. A play of several players addresses one at a time; player 1
 * is never named on the wire, so an engine with one player sees exactly what it always has. A
 * picture is the engine's JPEG or PNG, refused over `MAX_PLAY_SHOT_BYTES`; a pause the engine
 * cannot do is asked once, then the clock is known to run on.
 */
import { SECOND_MS } from "../../shared/duration.ts";
import {
  ENGINE_PLAY_VIEW,
  type EnginePlayMouse,
  EnginePlayRefusal,
  EnginePlayTool,
  isEnginePlayRefused,
  MAX_PLAY_INPUT_SECONDS,
  MAX_PLAY_SHOT_BYTES,
  MouseButtonCode,
  narrowCapabilities,
  playerArgs,
  playInputArgs,
} from "../../shared/engine-play.ts";
import { ClockLevel, EDITOR_CAPABILITIES, InputRoute, type TargetCapabilities } from "../../shared/computer-target.ts";
import { errorMessage } from "../../shared/errors.ts";
import { StillMimeType } from "../../shared/preview-contract.ts";
import type { ScreenAct } from "../../shared/agent-screen.ts";
import type { ComputerTarget, TargetLoad, TargetShot } from "../../substrate/computer-target.ts";
import { SCROLL_NOTCH_PX } from "../../substrate/computer-vocabulary.ts";
import { normalizeKey, parseCombo, type PreviewInputAction } from "../../substrate/preview-input.ts";
import type { TargetSource } from "./computer-session.ts";

/** How long a key pressed once is held, in game seconds: a tap. */
const TAP_SECONDS = 0.1;
/** How long the game runs after one frame of the mouse, in game seconds, so the frame has been played. */
const MOUSE_SECONDS = 0.05;

/** The engine plugin's name for each mouse button. */
const BUTTON_CODE = {
  left: MouseButtonCode.Left,
  right: MouseButtonCode.Right,
  middle: MouseButtonCode.Middle,
} as const satisfies Record<"left" | "right" | "middle", MouseButtonCode>;

/** One `play-input`: keys held together for game seconds, after one frame of the mouse when it moves. */
type Hold = { keys: string[]; seconds: number; mouse?: EnginePlayMouse };

/** Calls one of the game's engine plugin's play tools, under the session's hold on the editor. */
export type EnginePlayCall = (tool: EnginePlayTool, args: Record<string, unknown>) => Promise<unknown>;

/** Bytes in a megabyte, as a picture's size is said. */
const MEGABYTE = 1_000_000;

const MESSAGE = {
  noAnswer: (tool: string) => `the engine's ${tool} answered nothing usable`,
  unreachable: "The game's editor could not be reached.",
  tooLarge: (bytes: number) =>
    `the engine's picture is too large to show (${megabytes(bytes)} MB; the most is ${megabytes(MAX_PLAY_SHOT_BYTES)} MB)`,
} as const;

/** A size in megabytes, to one decimal place. */
function megabytes(bytes: number): string {
  return (bytes / MEGABYTE).toFixed(1);
}

/** A play tool's answer, or the refusal's words as an error. */
async function answered(call: EnginePlayCall, tool: EnginePlayTool, args: Record<string, unknown> = {}) {
  const answer = await call(tool, args);
  if (isEnginePlayRefused(answer)) throw new Error(answer.message);
  return answer;
}

/** A field of a play tool's answer, when the answer is an object that has it. */
function field(answer: unknown, name: string): unknown {
  if (typeof answer !== "object" || answer === null || !Object.hasOwn(answer, name)) return undefined;
  const value: unknown = Reflect.get(answer, name);
  return value;
}

/** A size field of `play-open`'s answer, or the default view's. */
function sizeOf(answer: unknown, name: "width" | "height"): number {
  const value = field(answer, name);
  return typeof value === "number" && value > 0 ? value : ENGINE_PLAY_VIEW[name];
}

/** The web key codes of one combo (`shift+w`): its modifiers, then its key. */
function comboCodes(combo: string): string[] {
  const { modifiers, key } = parseCombo(combo);
  return [...modifiers.map((k) => k.code), ...(key ? [key.code] : [])];
}

/** The keys that type one character: Shift with an upper-case letter. */
function charCodes(char: string): string[] {
  const key = normalizeKey(char);
  if (!key) return [];
  return /[A-Z]/.test(char) ? ["ShiftLeft", key.code] : [key.code];
}

/** The holds one mouse action is carried out as: buttons pressed where the view is aimed, a look, the wheel. */
function mouseHolds(action: PreviewInputAction): Hold[] | null {
  switch (action.type) {
    case "click": {
      const keys = [...(action.modifiers ?? []), BUTTON_CODE[action.button ?? "left"]];
      return Array.from({ length: Math.max(1, action.clicks ?? 1) }, () => ({ keys, seconds: TAP_SECONDS }));
    }
    case "look":
      return [{ keys: [], seconds: MOUSE_SECONDS, mouse: { dx: action.dx, dy: action.dy } }];
    case "scroll":
      // A wheel turned down the page is notches down: negative, as engines count them.
      return [{ keys: [], seconds: MOUSE_SECONDS, mouse: { wheel: -(action.dy ?? 0) / SCROLL_NOTCH_PX } }];
    default:
      return null;
  }
}

/** The holds one input action is carried out as, each keys and game seconds; null when the editor has no way to do it. */
function holdsOf(action: PreviewInputAction): Hold[] | null {
  switch (action.type) {
    case "tap":
      return [{ keys: action.keys, seconds: action.stepMs ? action.stepMs / SECOND_MS : TAP_SECONDS }];
    case "press": {
      const keys = comboCodes(action.combo);
      return Array.from({ length: Math.max(1, action.repeat ?? 1) }, () => ({ keys, seconds: TAP_SECONDS }));
    }
    case "hold": {
      // A long hold goes out in turns of the longest one call holds.
      let left = (action.ms ?? TAP_SECONDS * SECOND_MS) / SECOND_MS;
      const turns: Hold[] = [];
      while (left > 0) {
        turns.push({ keys: action.keys, seconds: Math.min(left, MAX_PLAY_INPUT_SECONDS) });
        left -= MAX_PLAY_INPUT_SECONDS;
      }
      return turns;
    }
    case "type":
      return [...action.text].map((char) => ({ keys: charCodes(char), seconds: TAP_SECONDS }));
    case "wait":
      return [{ keys: [], seconds: action.ms / SECOND_MS }];
    default:
      return mouseHolds(action);
  }
}

/** The target over a play that is open: its view, its keys, its picture and its state. */
export interface EditorPlayTarget extends ComputerTarget {
  readonly caps: TargetCapabilities;
}

/** A play shot's picture: its bytes and how they are encoded (a JPEG only when the engine says so). */
function shotOf(answer: unknown): TargetShot {
  const data = field(answer, "data") ?? field(answer, "png");
  if (typeof data !== "string") throw new Error(MESSAGE.noAnswer(EnginePlayTool.Shot));
  const bytes = Buffer.from(data, "base64");
  if (bytes.length > MAX_PLAY_SHOT_BYTES) throw new Error(MESSAGE.tooLarge(bytes.length));
  const mime = field(answer, "mime") === StillMimeType.Jpeg ? StillMimeType.Jpeg : StillMimeType.Png;
  return { jpeg: bytes, mime, stats: null, surface: null };
}

function editorPlayTarget(
  call: EnginePlayCall,
  view: { width: number; height: number },
  opened: TargetCapabilities,
): EditorPlayTarget {
  let caps = opened;
  let player = 1;
  // The play's own pause: a judge's game stands still while it looks; no exact step. An engine
  // that cannot pause is asked once; from then on its clock is known to run on.
  const setPaused = async (paused: boolean) => {
    if (caps.clock === ClockLevel.None) return;
    const answer = await call(EnginePlayTool.Pause, { paused });
    if (isEnginePlayRefused(answer) && answer.refused === EnginePlayRefusal.Unsupported) {
      caps = { ...caps, clock: ClockLevel.None };
      return;
    }
    if (isEnginePlayRefused(answer)) throw new Error(answer.message);
  };
  return {
    get caps() {
      return caps;
    },
    viewSize: () => view,
    pointer: () => null,
    selectPlayer: (next) => {
      player = next;
    },
    screenshot: async () => shotOf(await answered(call, EnginePlayTool.Shot, { ...playerArgs(player) })),
    input: async (actions) => {
      let applied = 0;
      for (const action of actions) {
        const holds = holdsOf(action);
        if (!holds) break;
        for (const hold of holds)
          await answered(call, EnginePlayTool.Input, { ...playInputArgs(hold.keys, hold.seconds, hold.mouse, player) });
        applied += 1;
      }
      return { applied, route: InputRoute.Editor };
    },
    state: () => answered(call, EnginePlayTool.State, { ...playerArgs(player) }),
    clock: { pause: () => setPaused(true), start: () => setPaused(false) },
  };
}

/** A target that answers nothing: what the session holds when the editor could not be reached. */
function unreachableTarget(caps: TargetCapabilities): EditorPlayTarget {
  const refuse = async (): Promise<never> => {
    throw new Error(MESSAGE.unreachable);
  };
  return {
    caps,
    viewSize: () => ENGINE_PLAY_VIEW,
    pointer: () => null,
    screenshot: refuse,
    input: refuse,
    state: refuse,
  };
}

/** A source of the editor target: its capabilities, its loads, and its release. */
export interface EditorPlaySource extends TargetSource<EditorPlayTarget> {
  release(): Promise<void>;
}

/** The editor's capabilities for a play of `asked` players: no more players than the engine declares. */
function askedCapabilities(declared: TargetCapabilities, asked: number): TargetCapabilities {
  return narrowCapabilities(declared, { players: Math.max(1, asked) });
}

/**
 * The editor target's source. `call` reaches the plugin's play tools (each under the editor lock);
 * `caps` is what the engine's plugin declares its play can do (the editor's own when absent), and
 * `players` how many players to open (one when absent, never more than declared); `frame` puts a
 * picture on the agent's screen; `fresh` asks for a play started over, never one joined mid-level
 * (a judge's or a playtester's, who judge the game from its start); `afterOpen` runs once, with the
 * open's answer, right after the session's play first opens and before any move (a judge's probe).
 */
export function editorPlaySource(options: {
  call: EnginePlayCall;
  caps?: TargetCapabilities;
  players?: number;
  frame?: (target: EditorPlayTarget, jpeg: Buffer | null, caption: string, act: ScreenAct) => Promise<void>;
  fresh?: boolean;
  afterOpen?: (opened: unknown) => Promise<void>;
}): EditorPlaySource {
  const caps = askedCapabilities(options.caps ?? EDITOR_CAPABILITIES, options.players ?? 1);
  const players = caps.players ?? 1;
  let open: EditorPlayTarget | null = null;
  let afterOpen = options.afterOpen;
  const load = async (_root: string, force: boolean): Promise<TargetLoad<EditorPlayTarget> & { fresh: boolean }> => {
    if (open && !force) return { target: open, problem: null, note: null, fresh: false };
    try {
      const asked = { ...(players > 1 ? { players } : {}), ...(options.fresh ? { fresh: true } : {}) };
      const opened = await answered(options.call, EnginePlayTool.Open, asked);
      const view = { width: sizeOf(opened, "width"), height: sizeOf(opened, "height") };
      // The play's own word on what it can do, and how many players joined: it only ever narrows.
      const joined = { players: field(opened, "players") };
      const played = narrowCapabilities(narrowCapabilities(caps, field(opened, "capabilities")), joined);
      open = editorPlayTarget(options.call, view, played);
      const after = afterOpen;
      afterOpen = undefined;
      await after?.(opened);
      return { target: open, problem: null, note: null, fresh: true };
    } catch (error) {
      return { target: unreachableTarget(caps), problem: errorMessage(error), note: null, fresh: true };
    }
  };
  return {
    caps,
    load,
    frame: (target, jpeg, caption, act) => options.frame?.(target, jpeg, caption, act) ?? Promise.resolve(),
    release: async () => {
      if (!open) return;
      open = null;
      await options.call(EnginePlayTool.Close, {}).catch(() => undefined);
    },
  };
}
