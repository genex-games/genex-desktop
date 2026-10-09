/**
 * What a computer target is and what it can do — the vocabulary every layer of the studio's
 * computer use shares (docs/play-protocol.md). A target is whatever the `computer` tool drives:
 * the game's own hidden browser window today, a game that speaks the Genex Play Protocol, and
 * later a window, a desktop or a VM driven from outside. Each declares its abilities in levels,
 * never yes/no, so the tool shows only the verbs a target has, the session paces its clock to
 * what the target can do, and a judge weighs evidence by the route its input took.
 */

/** How the studio runs and reaches a game: its own browser window, or a process speaking the Play Protocol. */
export const TargetRuntime = {
  Browser: "browser",
  Bridge: "bridge",
} as const;
export type TargetRuntime = (typeof TargetRuntime)[keyof typeof TargetRuntime];

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
};

/** Can the target's time be stood still between moves? */
export function canPause(caps: Pick<TargetCapabilities, "clock">): boolean {
  return caps.clock === ClockLevel.StepLocked || caps.clock === ClockLevel.Replayable;
}

/** Can the target's pointer click at a point? */
export function canPoint(caps: Pick<TargetCapabilities, "pointer">): boolean {
  return caps.pointer === PointerLevel.Absolute;
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
