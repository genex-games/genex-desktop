/**
 * An agent's screen — the hidden preview window one worker is driving with the computer
 * tool, as the studio window shows it: the last frame, where the cursor is, what the agent
 * just did. Main emits `preview.screen` (opened/closed) and `preview.frame` (a new picture);
 * the Builds graph shows each on the node of the part it works on, the lead's on the lead's.
 */
/** Who holds a window: the agent behind an agent screen, in its wire spelling. */
export const ScreenRole = {
  Builder: "builder",
  Playtester: "playtester",
  Scout: "scout",
  Judge: "judge",
  Director: "director",
} as const;
export type AgentScreenRole = (typeof ScreenRole)[keyof typeof ScreenRole];

/**
 * What the agent just did at its screen, as a code the Builds graph words ("Pressing Space").
 * The frame's `caption` stays the log's own sentence; nothing on screen reads it.
 */
export const ScreenDeed = {
  Load: "load",
  Look: "look",
  Click: "click",
  Press: "press",
  Type: "type",
  Drag: "drag",
  Move: "move",
  Scroll: "scroll",
  Wait: "wait",
  Reload: "reload",
} as const;
export type ScreenDeed = (typeof ScreenDeed)[keyof typeof ScreenDeed];

/** One action at a screen: what it was, and for a press the keys as the agent named them ("space", "ArrowRight"). */
export interface ScreenAct {
  deed: ScreenDeed;
  keys?: string[];
}

export interface AgentScreen {
  /** The preview-pool handle — the card's identity for the life of the session. */
  handle: string;
  /** Who is at the keyboard: the facet's title or id, "playtester", "scout", "director". */
  label: string;
  project: string;
  runId: string | null;
  facetId: string | null;
  role: AgentScreenRole;
}

export interface AgentScreenFrame extends AgentScreen {
  /** A JPEG of the window, downscaled for the card, base64. */
  jpeg: string;
  /** The window's size — the coordinate space of `cursor`. */
  width: number;
  height: number;
  cursor: { x: number; y: number };
  /** What the agent just did ("left click at 412,300", "key i", "capture default"). */
  caption: string | null;
  /** The same action as a code; absent from a producer that predates it. */
  act?: ScreenAct;
  at: number;
}

export interface AgentScreenEvent extends AgentScreen {
  state: "opened" | "closed";
  at: number;
}
