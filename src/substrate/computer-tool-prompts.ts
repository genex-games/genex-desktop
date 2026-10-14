/**
 * What the model reads about the `computer` tool: its description, its parameters, and the
 * sentences it gets back instead of an action when the arguments do not add up. Written once,
 * for both engines; `computer-tool.ts` decides when each is used.
 */
import { type CompiledStack, GameStack } from "../shared/game-project.ts";

/** Who holds the tool, which changes whose build the window shows and whether it can reload. */
export type ComputerToolRole = "builder" | "playtester" | "scout" | "director";

/** Whose build the window shows, by role. */
const WHOSE_BUILD: Record<ComputerToolRole, string> = {
  builder: "YOUR build (this workspace, uncommitted edits included)",
  director:
    "the build your window is pointed at (your own integration worktree by default; `look` points it at a worker's build or the live folder)",
  playtester: "the build under test",
  scout: "the build under test",
};

/** The reload sentence, for the roles that edit files. */
const RELOAD_LINE =
  " reload — rebuild and reload the window after you edit files (until you do, the window keeps running the build it last loaded).";

/**
 * The reload sentence of a compiled game's session, by stack: its window shows the web build, which
 * the studio rebuilds through the stack's own lane before it reloads.
 */
const COMPILED_RELOAD_LINE = {
  [GameStack.RaylibCpp]:
    " reload — rebuild and reload the window after you edit files (the studio rebuilds this C++ · raylib game through its own lane, and a failed build says so; until you reload, the window keeps running the build it last loaded).",
  [GameStack.RustWgpu]:
    " reload — rebuild and reload the window after you edit files (the studio rebuilds this Rust · wgpu game through its own lane, and a failed build says so; until you reload, the window keeps running the build it last loaded).",
} as const satisfies Record<CompiledStack, string>;

/**
 * The tool's description, for a role, a window size and the cameras the game names; `stack` for a
 * compiled game's session, whose reload rebuilds through that stack's lane (`cpp`, the older
 * spelling, is a C++ · raylib game's).
 */
export function computerToolDescription(options: {
  role: ComputerToolRole;
  view: { width: number; height: number };
  cameras: string;
  cpp?: boolean;
  stack?: CompiledStack;
}): string {
  const whose = WHOSE_BUILD[options.role];
  const edits = options.role === "builder" || options.role === "director";
  const stack = options.stack ?? (options.cpp ? GameStack.RaylibCpp : null);
  const reloadLine = stack ? COMPILED_RELOAD_LINE[stack] : RELOAD_LINE;
  const reload = edits ? reloadLine : "";
  const clock = options.role === "playtester" ? PACED_CLOCK_LINE : RUNNING_CLOCK_LINE;
  return (
    `Your hands and eyes on ${whose}, running live in its own hidden ${options.view.width}×${options.view.height} window (Chromium, the same one the judges use). ` +
    "Actions — screenshot: what the window shows now (Claude: the image comes back in the result; Codex: it prints a file path, view it). " +
    "zoom region=x0,y0,x1,y1: that part of the last screenshot at full size. " +
    "left_click | right_click | middle_click | double_click | triple_click coordinate=x,y (text=shift|ctrl+alt holds modifiers). " +
    "left_click_drag start_coordinate=x,y coordinate=x,y. mouse_move coordinate=x,y. left_mouse_down / left_mouse_up. " +
    "scroll scroll_direction=up|down|left|right scroll_amount=<notches> [coordinate=x,y]. " +
    "type text=<literal text>. key text=<a key or +chord: w, i, Return, Escape, space, ctrl+s> [repeat=n]. hold_key text=w duration=<seconds> (walks, grinds). " +
    "wait duration=<seconds>. cursor_position. " +
    `camera text=<name>: jump the view to a studio camera (eye:here is the player's eyes, default the game's own).${options.cameras} ` +
    "state: the game's own __studio.state() numbers (a claim — a screenshot is the proof). console: errors since load." +
    reload +
    " screenshot, camera and zoom take surface=screen|canvas: screen is the whole page — a DOM menu, an HTML HUD, a loading screen — and canvas is only what the game draws. Leave it out and the studio picks. " +
    `Coordinates are pixels of the last screenshot, origin top-left. ${clock} ` +
    "Menus, map pickers and mode switches are reached the way a player reaches them: click or press the key, then screenshot to see that you are where you think you are."
  );
}

/** The game's clock for a builder, a scout and the lead: it runs between actions. */
const RUNNING_CLOCK_LINE = "The game keeps running between actions.";
/**
 * The game's clock for a playtester, who takes seconds to look and decide: it stands still between
 * moves, as a player's reflexes would have it (golden-boot-glory: one key press ran four match minutes).
 */
const PACED_CLOCK_LINE =
  "The game's clock stands still between your actions: it runs only while you press, hold, click or wait, so take your time to look.";

/** The known cameras, as the sentence the description carries (empty when the game names none). */
export function knownCamerasLine(cameras: string[]): string {
  return cameras.length ? ` Known cameras: ${cameras.join(", ")}.` : "";
}

/** Each parameter's description, beside the action list the schema is built with. */
export const COMPUTER_PARAMETER_TEXT = {
  action: (actions: string) => `one of ${actions}`,
  coordinate: "x,y pixels of the last screenshot (clicks, mouse_move, drag end, scroll origin)",
  start_coordinate: "x,y where a left_click_drag starts",
  region: "x0,y0,x1,y1 pixels to zoom into",
  text: "text to type; key or +chord for key/hold_key; modifiers for a click; camera name for camera",
  repeat: "times to press the key (key only), 1–100",
  duration: "seconds for wait / hold_key, up to 300",
  scroll_direction: "up, down, left or right",
  scroll_amount: "wheel notches, default 3",
  surface:
    "surface=screen|canvas for screenshot, camera and zoom: screen is the whole page (DOM menus, an HTML HUD, a loader), canvas is only what the game draws; omit it and the studio picks",
} as const;

/** What the model is told instead of an action, when its arguments cannot run. */
export const COMPUTER_ARG_PROBLEM = {
  noAction: (actions: string) => `computer needs an action — one of ${actions}`,
  unknownAction: (action: string, actions: string) => `computer has no action "${action}" — use one of ${actions}`,
  dragNeedsPoints: "left_click_drag needs start_coordinate=x,y and coordinate=x,y",
  moveNeedsPoint: "mouse_move needs coordinate=x,y",
  zoomNeedsRegion: "zoom needs region=x0,y0,x1,y1 (pixels of the last screenshot)",
  scrollNeedsDirection: "scroll needs scroll_direction=up|down|left|right (and scroll_amount, default 3)",
  typeNeedsText: "type needs text=<what to type>",
  keyNeedsText: (action: string) => `${action} needs text=<key or combo, e.g. Return, Escape, ctrl+s, w>`,
  cameraNeedsName: "camera needs text=<camera name> (eye:here is your own eyes; default is the game's camera)",
  unknownSurface: (raw: string) => `surface "${raw}" is not screen or canvas — the studio picked the surface itself`,
} as const;
