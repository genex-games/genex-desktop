/**
 * What a computer target is and what it can do — the vocabulary every layer of the studio's
 * computer use shares (docs/play-protocol.md). A target is whatever the `computer` tool drives:
 * the game's own hidden browser window today, a game that speaks the Genex Play Protocol, and
 * later a window, a desktop or a VM driven from outside. Each declares its abilities in levels,
 * never yes/no, so the tool shows only the verbs a target has, the session paces its clock to
 * what the target can do, and a judge weighs evidence by the route its input took.
 */

/**
 * What the computer drives and how the studio reaches it: a game in its own browser window, as a
 * process speaking the Play Protocol, or in its engine's editor through its engine plugin's play
 * tools (`shared/engine-play.ts`), or — from outside any game — the person's desktop or a virtual
 * machine, through the desktop driver (cua-driver).
 */
export const TargetRuntime = {
  Browser: "browser",
  Bridge: "bridge",
  Editor: "editor",
  Desktop: "desktop",
  Vm: "vm",
} as const;
export type TargetRuntime = (typeof TargetRuntime)[keyof typeof TargetRuntime];

/**
 * The runtimes a game declares in its studio.json: never the desktop or a VM, which only the person
 * grants, nor the editor, which the game's matching engine plugin supplies.
 */
export type GameRuntime = typeof TargetRuntime.Browser | typeof TargetRuntime.Bridge;

/** The runtimes a game may declare. */
export const GAME_RUNTIMES: readonly GameRuntime[] = [TargetRuntime.Browser, TargetRuntime.Bridge];

/** How far the studio can hold the target's time still. */
export const ClockLevel = {
  /** Time runs on; nothing can pause it. */
  None: "none",
  /** The whole process can be frozen, but not stepped by an exact amount. */
  Freeze: "freeze",
  /** Pause, run, and step by a given number of milliseconds. */
  StepLocked: "step-locked",
  /** Step-locked, and the same seed and inputs replay the same run. */
  Replayable: "replayable",
} as const;
export type ClockLevel = (typeof ClockLevel)[keyof typeof ClockLevel];

/** Where the target's pointer can be put. */
export const PointerLevel = {
  None: "none",
  /** Only moved by deltas (mouse-look); no clicking at a point. */
  Relative: "relative",
  /** Moved and clicked at any point of the view. */
  Absolute: "absolute",
} as const;
export type PointerLevel = (typeof PointerLevel)[keyof typeof PointerLevel];

/** What the target can tell about itself beyond its pixels. */
export const StateLevel = {
  None: "none",
  /** The accessibility tree an app exposes: buttons and fields, not game numbers. */
  A11y: "a11y",
  /** The game's own state (`__studio.state()`, the protocol's `state`). */
  Game: "game",
} as const;
export type StateLevel = (typeof StateLevel)[keyof typeof StateLevel];

/**
 * The way an action reached the target, recorded on every one. Evidence from an outside route is
 * weaker than evidence from inside the game: a judge's confidence is capped by the weakest route
 * it used.
 */
export const InputRoute = {
  /** Input events delivered into the studio's own browser window. */
  Browser: "browser",
  /** Commands the game's own Play Protocol plugin carried out. */
  Bridge: "bridge",
  /** Synthetic OS events posted to a background window. */
  OsBackground: "os-background",
  /** Real OS events with the target in front, the user's pointer taken. */
  OsForeground: "os-foreground",
  /** Events dispatched into a web page through its browser's DevTools protocol (a separate, clean browser). */
  Page: "page",
  /** Input the engine carries into its editor play session (Unreal or Unity), on game time. */
  Editor: "editor",
} as const;
export type InputRoute = (typeof InputRoute)[keyof typeof InputRoute];

/** Why a target refused an action, as a code: the sentence the model reads lives with the tool's prompts. */
export const TargetRefusal = {
  /** The target lacks the ability the action needs. */
  Unsupported: "unsupported",
  /** The target could not be reached (it exited, it never answered). */
  Unreachable: "unreachable",
} as const;
export type TargetRefusal = (typeof TargetRefusal)[keyof typeof TargetRefusal];

/** Everything a target declares about itself before the first action. */
export interface TargetCapabilities {
  runtime: TargetRuntime;
  pointer: PointerLevel;
  clock: ClockLevel;
  state: StateLevel;
  /** Whether a seed can be set so a run repeats. */
  seed: boolean;
  /** Whether the target can rebuild and reload what it runs. */
  reload: boolean;
  /** Whether the target has named studio cameras. */
  cameras: boolean;
  /** Whether the target keeps a console the tool can read errors from. */
  console: boolean;
  /** Whether a region of the view can be photographed at full size. */
  zoom: boolean;
  /** Whether a look can choose the whole page or only what the game draws. */
  surfaces: boolean;
  /** Whether the target accepts named game actions ("jump", "attack"). */
  actions: boolean;
  /**
   * Whether the target reads and drives web pages by their structure — the page as text, each link,
   * button and field by ref — in a separate, clean browser (`web_open`, `web_read`, `web_click`, `web_type`).
   */
  dom: boolean;
  /**
   * Whether the mouse buttons press where the view is aimed, with no point to put the pointer at:
   * a game turned by mouse-look (a relative pointer). Absent is no.
   */
  aimedClicks?: boolean;
  /**
   * How many players the target plays at once, each with its own view, keys and state, addressed
   * by number (an engine's editor play of several players). Absent is one.
   */
  players?: number;
}

/** The studio's own browser window: everything, step-locked, seeded through the page shim. */
export const BROWSER_CAPABILITIES: TargetCapabilities = {
  runtime: TargetRuntime.Browser,
  pointer: PointerLevel.Absolute,
  clock: ClockLevel.StepLocked,
  state: StateLevel.Game,
  seed: true,
  reload: true,
  cameras: true,
  console: true,
  zoom: true,
  surfaces: true,
  actions: false,
  dom: false,
};

/**
 * The person's desktop, or a VM's, driven from outside: clicks and keys anywhere, the accessibility
 * tree of the app in front, and no clock, seed, camera or console — nothing can stand it still.
 */
export const DESKTOP_CAPABILITIES: TargetCapabilities = {
  runtime: TargetRuntime.Desktop,
  pointer: PointerLevel.Absolute,
  clock: ClockLevel.None,
  state: StateLevel.A11y,
  seed: false,
  reload: false,
  cameras: false,
  console: false,
  zoom: false,
  surfaces: false,
  actions: false,
  dom: true,
};

/**
 * A game played in its engine's editor: the player's view, keys held on the game's own clock (which
 * the studio can stand still between moves, though not step exactly), the mouse as a player has it
 * (mouse-look, the buttons where the view is aimed, the wheel), and the player's state. No seed,
 * cameras or console yet.
 */
export const EDITOR_CAPABILITIES: TargetCapabilities = {
  runtime: TargetRuntime.Editor,
  pointer: PointerLevel.Relative,
  aimedClicks: true,
  clock: ClockLevel.Freeze,
  state: StateLevel.Game,
  seed: false,
  reload: false,
  cameras: false,
  console: false,
  zoom: false,
  surfaces: false,
  actions: false,
  dom: false,
};

/** A VM's screen: the desktop's abilities, reached inside the machine. */
export const VM_CAPABILITIES: TargetCapabilities = { ...DESKTOP_CAPABILITIES, runtime: TargetRuntime.Vm };

/** Can the target's time be stood still between moves (frozen, or stepped)? */
export function canPause(caps: Pick<TargetCapabilities, "clock">): boolean {
  return caps.clock !== ClockLevel.None;
}

/** Can the target's time be stepped by an exact amount? */
export function canStep(caps: Pick<TargetCapabilities, "clock">): boolean {
  return caps.clock === ClockLevel.StepLocked || caps.clock === ClockLevel.Replayable;
}

/** Can the target's pointer click at a point? */
export function canPoint(caps: Pick<TargetCapabilities, "pointer">): boolean {
  return caps.pointer === PointerLevel.Absolute;
}

/** Can the target press a mouse button: at a point, or where its view is aimed? */
export function canClick(caps: Pick<TargetCapabilities, "pointer" | "aimedClicks">): boolean {
  return canPoint(caps) || caps.aimedClicks === true;
}

/** Does the target answer with its own state? */
export function hasState(caps: Pick<TargetCapabilities, "state">): boolean {
  return caps.state !== StateLevel.None;
}

/** How a computer session treats the target's clock between moves. */
export const ComputerPacing = {
  /** The game keeps running between actions (a builder, a scout, the lead). */
  Running: "running",
  /** The clock runs only during a move, on wall time (a playtester). */
  Paced: "paced",
  /** The clock is seeded and stepped by exact amounts: the same inputs replay the same run (a judge). */
  Stepped: "stepped",
} as const;
export type ComputerPacing = (typeof ComputerPacing)[keyof typeof ComputerPacing];

/** What a finished computer session's trace adds up to, as a delegation's result carries it. */
export interface ComputerTraceSummary {
  /** Where the trace was written; null before the first action. */
  path: string | null;
  steps: number;
  /** True when every move ran on a stepped clock: the same seed and inputs replay the same run. */
  deterministic: boolean;
  /** The index of the action after which the studio verified the goal was reached, or null. */
  reachedAt: number | null;
  /** Every route the session's input took: evidence is as strong as the weakest of them. */
  routes?: InputRoute[];
}
