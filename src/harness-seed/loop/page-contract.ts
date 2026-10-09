/**
 * The studio contract between the harness and a game's page, as the harness reads it: the
 * `window.__studio` verbs it calls, and the words the host uses for whether a game has the
 * contract at all. The template's `studio.d.ts` and the host define them, and every game the user
 * built answers to these names: never rename a value.
 */
import type { AttachReport, ContractWord } from "../types/host-api.d.ts";

/**
 * The game page's own verbs: the `window.__studio` methods the harness calls through
 * `preview.call` (`ctx.call(HostMethod.PreviewCall, { method: PageMethod.Step, arg: ms })`).
 */
export const PageMethod = {
  Seed: "seed",
  Start: "start",
  Pause: "pause",
  Step: "step",
  DebugCamera: "debugCamera",
  Cameras: "cameras",
  Eyes: "eyes",
  Demos: "demos",
  Demo: "demo",
  Audio: "audio",
  /** Past the game's title, menu and countdown into play (`config.begin`), left paused. */
  Begin: "begin",
  /** The racing-line assist on or off (`{ steer: true }`): the game's `config.steer` steers through the player's keys. */
  Assist: "assist",
} as const;
export type PageMethod = (typeof PageMethod)[keyof typeof PageMethod];

/**
 * The screens a game with a front-end reports (`state().flow.phase`), the template's `FlowPhase`
 * word for word. The harness decides only on `flow.playing`; a phase is reported, never matched.
 */
export const FlowPhase = {
  Boot: "boot",
  Menu: "menu",
  Intro: "intro",
  Countdown: "countdown",
  Playing: "playing",
  Paused: "paused",
  Results: "results",
} as const;
export type FlowPhase = (typeof FlowPhase)[keyof typeof FlowPhase];

/** What `game.validate` says of a game's `src/studio.js` (`contract`): loaded, attached by the hook, or missing. */
export const StudioContract = {
  Loaded: "loaded",
  Attached: "attached",
  Missing: "missing",
} as const satisfies Record<string, ContractWord>;
export type StudioContract = (typeof StudioContract)[keyof typeof StudioContract];

/** What `game.attached` found on the served page (`contract`): the game installs the studio, the hook attached, or neither. */
export const AttachedContract = {
  Installed: "installed",
  Attached: "attached",
  None: "none",
} as const satisfies Record<string, AttachReport["contract"]>;
export type AttachedContract = (typeof AttachedContract)[keyof typeof AttachedContract];
