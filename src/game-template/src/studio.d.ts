/**
 * The studio contract, typed — `src/studio.js` is the implementation, this file is its shape.
 *
 * A game the user brings is often TypeScript, and its build is `tsc -b && vite build`: the
 * moment its entry does what every brief asks it to do — `import { installStudio } from
 * "./studio.js"` — an untyped contract is TS7016/TS2307, the build exits non-zero, the preview
 * has nothing to serve, and every critic scores a black frame.
 * TypeScript resolves `./studio.js` to this declaration, so the same import line compiles under
 * `strict` and still runs as plain JavaScript in a folder with no build at all.
 *
 * Keep it in step with `studio.js`: a method that exists here and nowhere else is a lie the
 * compiler tells the builder.
 */

/**
 * A three-component value the harness reads both ways: `bbox("tree").size.y` and `.size[1]`
 * are the same number. Twelve iterations of one run failed on the spelling.
 */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
  readonly [index: number]: number;
  readonly length: 3;
}

/** World-space bounds of everything carrying a tag, or of one object and its descendants. */
export interface Bounds {
  min: Vec3;
  max: Vec3;
  size: Vec3;
}

/** Where the player is, as the studio reports it: every axis present, 0 where the game has none. */
export interface PlayerPose {
  x: number;
  y: number;
  z: number;
  yaw?: number;
  pitch?: number;
}

/**
 * Where the game says its player is. `x` plus at least one of `y`/`z` is a position: a
 * side-scroller locates its player in x/y and a top-down game in x/z, and the axis a game leaves
 * out is reported as 0 rather than missing, so a check that names `player.z` reads a number
 * whatever the genre.
 */
export interface PlayerLocation {
  x: number;
  y?: number;
  z?: number;
  yaw?: number;
  pitch?: number;
}

/**
 * An object in the game's scene graph. The studio does not own the game's library — three,
 * Phaser or the game's own classes — so the contract promises only `userData.tag`, the one
 * field every scene check reads, and leaves the rest of each object to the game's own types.
 */
export interface SceneObject {
  userData?: { tag?: string } & Record<string, unknown>;
  [key: string]: any;
}

/** The one input path: everything the player did since the last step, and nothing else. */
export interface UpdateContext {
  /** Seeded RNG — the only randomness a comparable run may use. */
  rng: () => number;
  frame: number;
  /** Held keys by `event.code` and `event.key`; mouse buttons arrive as `Mouse1`…`Mouse3`. */
  keys: Set<string>;
  /** Mouse movement in pixels since the last step (pointer lock or the harness's injectInput). */
  look: { x: number; y: number };
  wheel: { x: number; y: number };
  /** Cursor position as a fraction of the canvas, and whether the pointer is locked to it. */
  pointer: { x: number; y: number; locked: boolean };
}

/** One of the nine points of the frame a HUD item hangs from; `x`/`y` then move it inward. */
export type HudAnchor =
  | "top-left"
  | "top"
  | "top-right"
  | "left"
  | "center"
  | "right"
  | "bottom-left"
  | "bottom"
  | "bottom-right";

/** Where a HUD item is drawn: fractions of the frame, y from the top, measured from `anchor` (default top-left). */
export interface HudPlacement {
  x?: number;
  y?: number;
  size?: number;
  color?: string;
  align?: "left" | "center" | "right";
  anchor?: HudAnchor;
}

/** A shape's box: placed like any item, its `w` and `h` in fractions of the frame's HEIGHT (so it keeps its shape). */
export interface HudBox {
  x?: number;
  y?: number;
  anchor?: HudAnchor;
  w?: number;
  h?: number;
}

/** A gauge or ring: radius and stroke in frame heights, angles in radians (default a 270° sweep open at the bottom). */
export interface HudArc {
  x?: number;
  y?: number;
  anchor?: HudAnchor;
  r?: number;
  start?: number;
  end?: number;
  /** How much of the sweep is filled, 0–1. */
  fraction?: number;
  width?: number;
  color?: string;
  /** The unfilled track's colour; no track without it. */
  back?: string;
  cap?: "round" | "butt" | "square";
}

/** A rounded rectangle behind a group of readouts. `fill: null` draws only the outline. */
export interface HudPanel extends HudBox {
  radius?: number;
  fill?: string | null;
  stroke?: string;
  width?: number;
}

/** An SVG path (`d`), drawn through its `viewBox` (default `0 0 100 100`) into its box. */
export interface HudPath extends HudBox {
  viewBox?: string | [number, number, number, number];
  fill?: string | null;
  stroke?: string;
  width?: number;
}

/** The only UI a template game may have: one quad tagged `hud`, drawn into the canvas. */
export interface StudioHud {
  text(id: string, text: string, opts?: HudPlacement): void;
  bar(id: string, fraction: number, opts?: HudPlacement & { w?: number; h?: number; back?: string }): void;
  arc(id: string, opts?: HudArc): void;
  panel(id: string, opts?: HudPanel): void;
  path(id: string, d: string, opts?: HudPath): void;
  /** An image from `assets/` or a data URL; reported as pending until it has decoded. */
  image(id: string, src: string, opts?: HudBox): void;
  /** Register a bundled font file; text that names `family` uses it once it has loaded. */
  font(family: string, url: string): void;
  crosshair(opts?: {
    size?: number;
    gap?: number;
    thickness?: number;
    color?: string;
    visible?: boolean;
    spread?: number;
  }): void;
  flash(color?: string, alpha?: number): void;
  remove(id: string): void;
  clear(): void;
  get(id: string): unknown;
  items(): string[];
  enable(on?: boolean): void;
}

/** What the HUD is showing, as `state()` reports it: bounded however many items a game draws. */
export interface HudSummary {
  /** The first 64 item ids, each clipped to 32 characters; `count` is how many there are. */
  items: string[];
  count?: number;
  /** Items per kind (`text`, `bar`, `arc`, `panel`, `path`, `image`, `crosshair`). */
  kinds?: Record<string, number>;
  /** The share of the frame the items cover, 0–1; null until the HUD module has loaded. */
  coverage?: number | null;
  /** Pairs of item ids that run into each other, at most 8; an item sitting inside a much larger one (a readout in its dial, a label on its bar) is a group, not a pair. */
  overlaps?: Array<[string, string]>;
  /** Images still decoding and fonts still loading. */
  pending?: number;
  crosshair: boolean;
  flash: number;
}

/** Read-only scene-graph helpers a `scene` check is evaluated against. */
export interface StudioInspect {
  /** True once there is a scene to answer about — see {@link StudioUnavailable}. */
  available?: true;
  scene: unknown;
  renderer: unknown;
  camera: unknown;
  state: StudioState;
  player: PlayerPose | null;
  objects(tag?: string): SceneObject[];
  meshes(tag?: string): SceneObject[];
  materials(tag?: string): SceneObject[];
  lights(): SceneObject[];
  tags(): string[];
  untagged(): number;
  count(tag?: string): number;
  bbox(tag?: string): Bounds | null;
  bboxOf(obj: SceneObject | null | undefined): Bounds | null;
  /** Visible DOM elements outside the canvas — the UI a canvas capture never sees. */
  domUi(): string[];
  hud(): HudSummary;
  renderTargets(): Array<{ width: number; height: number }>;
  audio(): AudioProbe;
}

/**
 * What `inspect()` answers with before anything has been rendered: a game the studio attached to
 * has no scene until its first `renderer.render(scene, camera)`, and a check must be able to say
 * "not measured yet" instead of failing. Every helper on this object throws with the reason.
 */
export interface StudioUnavailable {
  available: false;
  reason: string;
  scene: null;
  renderer: unknown;
  camera: unknown;
  [helper: string]: unknown;
}

/** RMS level and spectral centroid of whatever `config.audio()` analyses. */
export interface AudioProbe {
  available: boolean;
  rms: number;
  centroid: number;
}

/** The JSON snapshot every judge and every `state.*` check reads, plus the game's own probes. */
export interface StudioState {
  version: number;
  seed: number;
  frame: number;
  simulatedMs: number;
  running: boolean;
  fps: number;
  held: string[];
  pointerLock: boolean;
  hud: HudSummary;
  camera: string;
  error: string | null;
  player: PlayerPose | null;
  /** Present only when the game passed `config.flow`: the screen it is on, and whether that is play. */
  flow?: GameFlow;
  [probe: string]: unknown;
}

/** The screens a game with a front-end reports through `config.flow()`; only `playing` decides anything. */
export declare const FlowPhase: Readonly<{
  Boot: "boot";
  Menu: "menu";
  Intro: "intro";
  Countdown: "countdown";
  Playing: "playing";
  Paused: "paused";
  Results: "results";
}>;
export type FlowPhase = (typeof FlowPhase)[keyof typeof FlowPhase];

/** `state().flow`: the phase `config.flow()` named (null when it named none) and whether it is play. */
export interface GameFlow {
  phase: FlowPhase | null;
  playing: boolean;
}

/**
 * What the game hands the studio. NOTHING is required.
 *
 * Pass `update` and the studio drives a fixed-step loop and owns the clock verbs; leave it out
 * and the studio's own shim paces the loop the game already has, and this object's job is only
 * to say the things a page cannot: where the player is, what a named camera looks at, what a
 * probe measures. `installStudio({ renderer, player })` is the whole of the two-line install.
 */
export interface StudioConfig {
  /** Simulation step in milliseconds; defaults to 1000/60. */
  fixedStepMs?: number;
  /** The fixed-step simulation. With it, `step()`/`pause()`/`start()` are this object's; without it, the studio's. */
  update?(dtSeconds: number, ctx: UpdateContext): void;
  /** May return a promise (a WebGPU `renderAsync`); `capture()` awaits it. Omit it and the studio photographs the frame the game drew itself. */
  render?(): unknown;
  /** `false` turns the HUD off entirely — a game whose UI is its own never loads `./hud.js`. */
  hud?: false;
  /** Named readings of the game's own mechanics — what `state.<name>` checks measure. */
  probes?: () => Record<string, unknown>;
  /** Named viewpoints, so two builds are photographed from the same place. */
  cameras?: Record<string, () => void>;
  /** Scripted demonstrations the generic playthrough cannot reach; each ends paused. */
  demos?: Record<string, () => unknown>;
  /** Put the game on its first screen (a title or menu is welcome) for `seed`. */
  reset?: (seed: number) => void;
  /** Which screen is up now, as a {@link FlowPhase} word: `state().flow` reports it. */
  flow?: () => FlowPhase;
  /** From where `reset` leaves the game straight into play: synchronous, deterministic, no wall clock. */
  begin?: () => void;
  /**
   * A racing game's racing line: the steering a driver on it would apply now, -1 full left … 1
   * full right, read every frame while the harness's assist is on. A pure read of the game's state.
   */
  steer?: () => number;
  canvas?: HTMLCanvasElement;
  /** The game's scene graph, renderer and camera — whatever library they come from. */
  scene?: unknown;
  renderer?: unknown;
  camera?: unknown;
  player?: () => PlayerLocation | null | undefined;
  eyeHeight?: number;
  audio?: () => AnalyserNode | null;
  input?: { pointerLock?: boolean };
}

/** `window.__studio` — every method here is one the harness calls. Never remove one. */
export interface StudioApi {
  version: number;
  /** Reseed, reset — and pause, so judging starts from a known frame. */
  seed?(value: number): number;
  /** Resume the studio's clock — not the game's Start button: the loop runs and draws from load. */
  start?(): boolean;
  pause?(): boolean;
  /** Present when the game passed `update`; otherwise the studio's shim owns the clock verbs. */
  step?(dtMs?: number): { frame: number; simulatedMs: number };
  state(): StudioState;
  debugCamera(name: string): { ok: true; camera: string } | { ok: false; available?: string[]; reason?: string };
  cameras(): string[];
  /** `eye:spawn`, `eye:here`, `eye:down`, `eye:back` — available once `camera` and `player()` are passed in. */
  eyes(): string[];
  eye(
    name: string,
  ): { ok: true; camera: string; player: PlayerPose | null } | { ok: false; available?: string[]; reason?: string };
  /** Re-render and read the canvas in the same turn — the critic's screenshot path. */
  capture(): Promise<string | null>;
  hud: StudioHud;
  demos(): string[];
  demo(name: string): { ok: true; demo: string; result: unknown } | { ok: false; available: string[] };
  /** Past the title, menu and countdown into play via `config.begin`, left paused; `ok: false` without one. */
  begin(): { ok: true; flow: GameFlow | null } | { ok: false; reason: string };
  /** The steering `config.steer` asks for now, clamped to -1…1; `ok: false` without one. */
  steer(): { ok: true; steer: number } | { ok: false; reason: string };
  /**
   * The racing-line assist on (`{ steer: true }`) or off: `config.steer` steers through the arrow
   * and A/D keys, held for the share of frames the line asks, until switched off or `seed()`.
   */
  assist(options: { steer: boolean } | boolean): { ok: true; steer: boolean } | { ok: false; reason: string };
  /** The critic's hands: key names (`KeyW`, `w`) and mouse deltas in pixels. */
  injectInput(input: {
    down?: string[];
    up?: string[];
    look?: { dx?: number; dy?: number };
    wheel?: { dx?: number; dy?: number };
  }): { keys: string[]; look: { x: number; y: number }; wheel: { x: number; y: number } };
  inspect(): StudioInspect | StudioUnavailable;
  sceneSummary(): {
    meshes: number;
    untagged: number;
    byTag: Record<string, number>;
    lights: string[];
    renderTargets: Array<{ width: number; height: number }>;
  };
  audio(): AudioProbe;
}

/** Deterministic RNG (mulberry32): same seed ⇒ same run ⇒ comparable screenshots. */
export function makeRng(seed: number): () => number;

/**
 * Install the contract on `window.__studio`. Returns the same object.
 *
 * ```js
 * installStudio({ renderer, player: () => ({ x: player.position.x, z: player.position.z }) });
 * ```
 *
 * That is the whole of it for a game with its own loop: the studio already paces the page, seeds
 * its randomness and photographs its frames, and those two lines tell it which renderer is the
 * game's and where the player stands. Pass `update` as well and the studio drives the loop.
 */
export function installStudio(config: StudioConfig): StudioApi;

/** The studio's own clock, installed on every served page before a line of game code runs. */
export interface StudioClock {
  version: number;
  mode(): "wall" | "studio";
  frozen(): boolean;
  now(): number;
  pause(): boolean;
  start(): boolean;
  /** Simulate exactly `round(ms / frameMs)` frames. Asynchronous: the stepper yields a
   * microtask between frames so a game whose animation callback awaits still advances. */
  step(ms: number): Promise<unknown>;
  seed(value: number): number;
  stats(): Record<string, unknown>;
  boot(): Record<string, unknown>;
  afterFrame(fn: () => void): () => void;
  pumpFrame(dtMs: number): boolean;
  canvases(): { elements: HTMLCanvasElement[]; descriptors: Array<Record<string, unknown>> };
}

/** The renderer hook: what the studio saw the game draw, with nothing added to the game. */
export interface StudioHook {
  version: number;
  wrapRenderer(instance: unknown): boolean;
  current(): { renderer: unknown; scene: unknown; camera: unknown; canvas: HTMLCanvasElement | null } | null;
  scenes(): unknown[];
  inspect(options?: Record<string, unknown>): StudioInspect | StudioUnavailable;
  cameras(): string[];
  state(): Record<string, unknown>;
}

declare global {
  interface Window {
    __studio?: StudioApi;
    /** The studio's clock — present on every page the studio serves. */
    __studioClock?: StudioClock;
    /** The renderer hook — how a game with no contract at all is still judgeable. */
    __studioHook?: StudioHook;
    /** The last fatal the page reported — `state().error` reads it. */
    __studio_error?: string | null;
  }
}
