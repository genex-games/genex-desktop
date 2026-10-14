/**
 * The public shape of a game folder: what the library lists, how a project runs, and what the Open
 * Game sheet shows about a picked folder. `substrate/game-workspace.ts` decides and writes these
 * and re-exports the types; the renderer reads them through `window.studio`.
 */
import type { EngineBinding } from "./game-engine.ts";
import type { ExportWarning, GpuQualification } from "./game-export-contract.ts";
import type { GameLibraryEntry } from "./game-library.ts";
import type { TargetRefusal } from "./game-targets.ts";
import type { DestinationCheck } from "./native-contract.ts";
import type { HookEvent } from "./plugin-hooks.ts";
import type { FolderHolds, ProjectFact } from "./project-facts.ts";

/** The runtime a game is written for. Wire values (studio.json `stack`): never rename one. */
export const GameStack = {
  ThreeJs: "three-js",
  RaylibCpp: "raylib-cpp",
  /** Rust gameplay on the genex facade, drawn by wgpu: the default where its lane runs ({@link CREATABLE_STACKS}). */
  RustWgpu: "rust-wgpu",
} as const;
export type GameStack = (typeof GameStack)[keyof typeof GameStack];

/** A stack the studio compiles with a managed toolchain: every stack but Three.js. */
export type CompiledStack = Exclude<GameStack, typeof GameStack.ThreeJs>;

/** Does `stack` build with a managed toolchain (C++ · raylib, Rust · wgpu)? */
export function isCompiledStack(stack: GameStack): stack is CompiledStack {
  return stack !== GameStack.ThreeJs;
}

/**
 * Can Live show this stack's Mac build in its canvas (Web | Native, an embedded run)? Every
 * compiled stack: a raylib game's headless build and a Rust game's studio mode both draw into
 * Live's frames ring.
 */
export function liveEmbedsStack(stack: GameStack): stack is CompiledStack {
  return isCompiledStack(stack);
}

/**
 * Does this stack's Mac build play in its own window (Play on Mac, Pop out)? raylib's only: a
 * Rust game's studio mode serves headless, so a window run would show no window.
 */
export function playsInOwnWindow(stack: GameStack): boolean {
  return stack === GameStack.RaylibCpp;
}

/** Where people play, as a destination the studio builds for. Wire values (studio.json `targets`). */
export const BuildTarget = {
  Web: "web",
  Mac: "macos",
  Windows: "windows",
  Linux: "linux",
  /** iPhone and iPad: a Rust · wgpu destination only. */
  Ios: "ios",
  /** Android phones and tablets: a Rust · wgpu destination only. */
  Android: "android",
} as const;
export type BuildTarget = (typeof BuildTarget)[keyof typeof BuildTarget];

/**
 * The destinations the studio offers and accepts today, in the order the create dialog lists
 * them: the browser and the desktop. The mobile destinations are vocabulary only until their lane
 * lands, so input naming one is still refused as unknown.
 */
export const BUILD_TARGETS: readonly BuildTarget[] = Object.freeze([
  BuildTarget.Web,
  BuildTarget.Mac,
  BuildTarget.Windows,
  BuildTarget.Linux,
]);

/**
 * The stacks a new game may be created with: Three.js and Rust · wgpu. C++ · raylib creation ended
 * when Rust · wgpu creation shipped (owner decision 2026-10-06): existing raylib games stay
 * openable, buildable and exportable, and no switch, host or destination set re-enables it.
 */
export type CreatableStack = Exclude<GameStack, typeof GameStack.RaylibCpp>;

/** {@link CreatableStack} in the order the create dialog lists them. */
export const CREATABLE_STACKS: readonly CreatableStack[] = Object.freeze([GameStack.ThreeJs, GameStack.RustWgpu]);

/** May a new game be created with `value`? Never raylib, never a stack this version does not know. */
export function isCreatableStack(value: unknown): value is CreatableStack {
  return typeof value === "string" && (CREATABLE_STACKS as readonly string[]).includes(value);
}

/** Why a create request is refused for its stack. Wire values (the error's `code`): never rename one. */
export const CreationRefusal = {
  /**
   * The request names C++ · raylib, by stack or kind, or only desktop destinations as a pre-Rust
   * caller did: raylib creation is retired, and nothing is written.
   */
  RaylibCreationRetired: "raylib-creation-retired",
} as const;
export type CreationRefusal = (typeof CreationRefusal)[keyof typeof CreationRefusal];

/**
 * The settings switch for a new game's default stack. Wire values (the `stackDefault` setting):
 * never rename one. Host-conditional is Rust · wgpu where its lane runs and Three.js elsewhere;
 * the reverted switch is Three.js everywhere, with Rust · wgpu still creatable when chosen.
 */
export const StackDefaultSwitch = {
  HostConditional: "host-conditional",
  ThreeJs: "three-js",
} as const;
export type StackDefaultSwitch = (typeof StackDefaultSwitch)[keyof typeof StackDefaultSwitch];

/** The switch this version ships: the rollback is setting it (or this constant) to {@link StackDefaultSwitch.ThreeJs}. */
export const SHIPPED_STACK_DEFAULT_SWITCH: StackDefaultSwitch = StackDefaultSwitch.HostConditional;

/** The setting's key in the studio's settings. */
export const STACK_DEFAULT_SETTING = "stackDefault";

const STACK_DEFAULT_SWITCHES: readonly string[] = Object.freeze(Object.values(StackDefaultSwitch));

const isStackDefaultSwitch = (value: unknown): value is StackDefaultSwitch =>
  typeof value === "string" && STACK_DEFAULT_SWITCHES.includes(value);

/** The switch a stored setting names; anything else (absent, unknown, a stack name) is the shipped switch. */
export function parseStackDefaultSwitch(value: unknown): StackDefaultSwitch {
  return isStackDefaultSwitch(value) ? value : SHIPPED_STACK_DEFAULT_SWITCH;
}

/** The phone and tablet destinations, which only a Rust · wgpu game can name. */
export const MOBILE_TARGETS: readonly BuildTarget[] = Object.freeze([BuildTarget.Ios, BuildTarget.Android]);

/** Every destination in the vocabulary, mobile included, in list order. */
export const ALL_BUILD_TARGETS: readonly BuildTarget[] = Object.freeze([...BUILD_TARGETS, ...MOBILE_TARGETS]);

/** The desktop destinations: a new game naming any of them is Rust · wgpu ({@link stackForTargets}). */
export const DESKTOP_TARGETS: readonly BuildTarget[] = Object.freeze([
  BuildTarget.Mac,
  BuildTarget.Windows,
  BuildTarget.Linux,
]);

export interface GameProject {
  primaryThreadId?: string;
  pinned?: boolean;
  cover?: GameLibraryEntry["cover"];
  lastOpenedAt?: string;
  name: string;
  dir: string;
  title: string;
  createdAt: string;
  /** `~/AI Games/pong` or `~/coding/my-game` — what the UI shows. */
  pathLabel: string;
  /** False when this folder is not a child of the default library. */
  library: boolean;
  /** How the game runs — the studio's own no-build shape, or a project with its own build. */
  shape: ProjectShape;
  /** `shape.own`: the folder brought its own game, so the studio builds it and serves its output. */
  built: boolean;
  /**
   * The stack and destinations the game was created with. Optional so older literals still
   * compile; `GameWorkspaces` always fills it, and readers go through {@link destinationsOf}.
   */
  destinations?: GameDestinations;
  /** A C++ game's desktop checks from the host's library (`GameLibraryEntry.native.checks`); absent when it has none. */
  nativeChecks?: Partial<Record<BuildTarget, DestinationCheck>>;
  /** The engine project Genex linked this game to; absent for a web game (`shared/game-engine.ts`). */
  engine?: EngineBinding;
  /**
   * What the folder holds, by `shared/project-facts.ts`: the core table, the enabled plugins'
   * `detect` and the engine link. Empty while the first message has not picked a kind.
   */
  facts: ProjectFact[];
  /**
   * What the folder holds while it has no facts (`FolderHolds`): nothing or notes (no kind yet), files
   * of its own of a kind no rule knows, or unreadable. Absent once it has facts, and from older lists.
   */
  holds?: FolderHolds;
  /** The moments the plugins that are on hook for this folder (`shared/plugin-hooks.ts`); absent: none. */
  hookEvents?: HookEvent[];
  /** What a port replaced, kept in the folder as the reference and no longer a kind of this game. */
  portedFrom?: ProjectFact[];
  /**
   * The scaffold a plugin's tool made this project with, as studio.json records it (its rules stay
   * there): what the sidebar names a project that isn't a game ("Unreal plugin").
   */
  scaffold?: { plugin: string; id: string; label: string };
  /**
   * Whether `facts` hold `web-game` at the root; kept for parts that read it. Absent from a
   * descriptor made before it was recorded, read as a web game.
   */
  web?: boolean;
  /**
   * The folder's content stamp (`game.contentStamp`'s `all`) as New game made it from the template;
   * absent for a folder the studio did not make that way. While the folder's stamp still equals
   * it, nothing has been built in the game yet.
   */
  scaffoldStamp?: string;
  /** Named before anyone said what the game is: its first idea renames it in place (`nameFromIdea`). */
  provisional?: boolean;
}

/**
 * What kind of game a folder holds, decided from the libraries and runtimes it actually loads —
 * never from the entry filename. `src/main.js` is Vite's stock layout as much as the studio's,
 * and reading it as "the template" is what served the user's own three.js game raw, with a bare
 * `three` import nothing could resolve.
 *
 * The kind says what the game *is*; `build` and `serve` say how it runs. A bundled Phaser game
 * is `phaser`, not `three-vite`.
 *
 * Now an object as well as a type: existing call sites keep their string literals; new ones
 * write `ProjectKind.RaylibCpp`. Wire values (studio.json `kind`): never rename one.
 */
export const ProjectKind = {
  StudioTemplate: "studio-template",
  ThreeVite: "three-vite",
  ThreeModules: "three-modules",
  Canvas2d: "canvas2d",
  Phaser: "phaser",
  EngineExport: "engine-export",
  OwnScript: "own-script",
  /** A CMake project that builds with raylib: C++ for the browser and the desktop. */
  RaylibCpp: "raylib-cpp",
  /** A `genex.toml` project: Rust gameplay on the genex facade, built by the host's Rust lane. */
  RustWgpu: "rust-wgpu",
} as const;
export type ProjectKind = (typeof ProjectKind)[keyof typeof ProjectKind];

/** The stack each kind is: raylib and Rust are their own, every other kind is a browser game. */
export const STACK_OF_KIND = {
  [ProjectKind.StudioTemplate]: GameStack.ThreeJs,
  [ProjectKind.ThreeVite]: GameStack.ThreeJs,
  [ProjectKind.ThreeModules]: GameStack.ThreeJs,
  [ProjectKind.Canvas2d]: GameStack.ThreeJs,
  [ProjectKind.Phaser]: GameStack.ThreeJs,
  [ProjectKind.EngineExport]: GameStack.ThreeJs,
  [ProjectKind.OwnScript]: GameStack.ThreeJs,
  [ProjectKind.RaylibCpp]: GameStack.RaylibCpp,
  [ProjectKind.RustWgpu]: GameStack.RustWgpu,
} as const satisfies Record<ProjectKind, GameStack>;

/** Every destination a game of each stack may name, in list order; a host's own abilities are `STACK_HOST_MATRIX`. */
export const STACK_TARGETS = {
  [GameStack.ThreeJs]: Object.freeze([BuildTarget.Web]),
  // Raylib's own list, never `BUILD_TARGETS`: that one grows when the phone lanes land, and raylib
  // games never gain them (the seed's mirror pins the same four).
  [GameStack.RaylibCpp]: Object.freeze([BuildTarget.Web, ...DESKTOP_TARGETS]),
  [GameStack.RustWgpu]: ALL_BUILD_TARGETS,
} as const satisfies Record<GameStack, readonly BuildTarget[]>;

/**
 * How a project runs. The studio's own template needs no build: `index.html` loads `src/main.js`
 * as a native ES module. A folder the user brings — Vite, TypeScript, any bundler — keeps its
 * own entry and build; the studio runs the build and serves its output instead of the sources
 * (served raw, `/src/main.ts` is refused by the browser and every critic judges a black frame).
 */
export interface ProjectShape {
  /** The page the preview serves, relative to the project — inside the build output when there is a build. */
  entry: string;
  /** The game's real entry module: what the main owner edits and other facets wire into. */
  main: string;
  /** Shell command that produces `entry` from the sources; null when the game runs as written. */
  build: string | null;
  /**
   * What "Install packages" runs — the manager the folder's own lockfile names, because
   * `npm install` in a pnpm project writes a second, divergent node_modules. Null when the
   * folder declares no dependencies at all.
   */
  install: string | null;
  /**
   * The folder brought its own game. Explicit, because no filename can carry it: a game may keep
   * the template's entry name and still be entirely its own, and the studio must never write its
   * scaffold beside a real one.
   */
  own: boolean;
  /** What the folder is, from its own evidence. */
  kind: ProjectKind;
  /** The folder the served page lives in, relative to the project; "." when it is served as written. */
  serve: string;
  /**
   * How long this game asks the studio to wait for it to boot, in milliseconds — clamped to a
   * minute, so a rewritten studio.json can cost at most that much patience. The user's knob (or
   * a worker's): the studio reads it and never writes it. Absent when the folder declares none,
   * and then the studio waits its own default.
   */
  bootMs?: number;
  /**
   * Set when studio.json records a kind this version of Genex does not know: a newer Genex made the
   * game. The studio lists and shows it but writes nothing into it, runs no command it records and
   * refuses every change with `kind-unsupported`. Absent for every kind this version knows.
   */
  readOnly?: TargetRefusal;
}

/** The stack and destinations a game was created with; a game that records none is a Three.js browser game. */
export interface GameDestinations {
  stack: GameStack;
  targets: readonly BuildTarget[];
}

/** What every existing game is: Three.js for the browser. */
export const DEFAULT_DESTINATIONS: GameDestinations = Object.freeze({
  stack: GameStack.ThreeJs,
  targets: Object.freeze([BuildTarget.Web]),
});

/** Is `value` a destination the studio knows? */
export function isBuildTarget(value: unknown): value is BuildTarget {
  return typeof value === "string" && (BUILD_TARGETS as readonly string[]).includes(value);
}

const GAME_STACKS: readonly GameStack[] = Object.freeze(Object.values(GameStack));

/** Is `value` a stack the studio knows? */
export function isGameStack(value: unknown): value is GameStack {
  return typeof value === "string" && (GAME_STACKS as readonly string[]).includes(value);
}

/**
 * The stack a set of destinations implies for a new game: any destination beyond the browser (a
 * desktop or a phone) means Rust · wgpu, the browser alone Three.js; `chosen` Rust · wgpu forces it
 * for a browser-only game. Never C++ · raylib (its creation is retired, M6): a `chosen` raylib is
 * ignored, and refusing a request that names it is the create path's (`raylib-creation-retired`).
 */
export function stackForTargets(targets: readonly BuildTarget[], chosen?: GameStack): CreatableStack {
  if (chosen === GameStack.RustWgpu) return GameStack.RustWgpu;
  return targets.some((target) => target !== BuildTarget.Web) ? GameStack.RustWgpu : GameStack.ThreeJs;
}

/** The stack a shape belongs to ({@link STACK_OF_KIND}). */
export function stackOf(shape: Pick<ProjectShape, "kind">): GameStack {
  return STACK_OF_KIND[shape.kind];
}

/** Typed reasons `game.validate` reports beside its sentences, so no reader matches English. Never rename a value. */
export const GameValidationCode = {
  MissingFile: "missing-file",
  EngineExport: "engine-export",
  NoContract: "no-contract",
  NativeMissingCMake: "native-missing-cmake",
  NativeMissingMain: "native-missing-main",
  NativeContractRemoved: "native-contract-removed",
  /** A raylib CMake project that does not call `genex_add_game(`: the lane cannot build it until it does. */
  NativeNeedsGenexCmake: "native-needs-genex-cmake",
  /** studio.json names a stack the folder's files are not (the files win; a night refuses). */
  StackContradictsKind: "stack-contradicts-kind",
  /** studio.json records a kind only a newer Genex knows: the game opens read-only and nothing runs on it. */
  KindUnsupported: "kind-unsupported",
  /**
   * A Rust game folder holds a build input of its own (`Cargo.toml`, `Cargo.lock`, `build.rs`,
   * `.cargo/`): the studio writes the manifest and lock from `genex.toml`, so the lane refuses it.
   */
  RustOwnBuildInput: "rust-own-build-input",
} as const;
export type GameValidationCode = (typeof GameValidationCode)[keyof typeof GameValidationCode];

/** The destinations a project has, whether or not its description carries them (older literals do not). */
export function destinationsOf(project: { destinations?: GameDestinations }): GameDestinations {
  return project.destinations ?? DEFAULT_DESTINATIONS;
}

/** What the served page does with the contract the judge reads — a word, not a sentence. Wire values: never rename one. */
export const ContractWord = {
  Loaded: "loaded",
  Attached: "attached",
  Missing: "missing",
} as const;
export type ContractWord = (typeof ContractWord)[keyof typeof ContractWord];

/** A game found in a picked folder, or one folder under it. */
export interface GameCandidate {
  /** Where it sits inside the folder the user picked: "." for the folder itself. */
  rel: string;
  dir: string;
  shape: ProjectShape;
  /** The evidence that made this folder a game, in the words the sheet shows. */
  why: string[];
}

/** What would stop a run on a candidate — read before anything is written. */
export interface FolderPreflight {
  /** The page the preview will serve, relative to the candidate. */
  entry: string;
  build: string | null;
  serve: string;
  /** What "Install packages" would run here — the folder's own manager. */
  install: string | null;
  /** Dependencies are declared and `node_modules` is not there: the build cannot run yet. */
  needsInstall: boolean;
  /** Whether the page the studio serves actually loads the contract the judge reads. */
  contract: ContractWord;
  /** The candidate's own repository, and any repository one folder under it. */
  git: "none" | "repo";
  nested: string[];
  problems: string[];
  warnings: string[];
  /** Every file adopting this candidate would add to it, in the order it is written. */
  writes: string[];
}

/** A folder the user chose for a new game: the path for main, and how the dialog shows it. */
/** What a game started from its first request is named from: the request, and the model the user picked. */
export interface GameNameRequest {
  prompt: string;
  engine?: string;
  model?: string;
}

/** The name a game started from its first request gets (`main/core/game-naming.ts`). */
export interface GameName {
  title: string;
  /** The message named no game (a greeting, a test) or the model gave no name: the title waits for an idea. */
  provisional?: boolean;
}

export interface GameLocation {
  dir: string;
  /** `~/Projects` — what the UI shows. */
  pathLabel: string;
}

/** What a picked folder holds, without touching it. */
export interface FolderInspection {
  dir: string;
  pathLabel: string;
  candidates: Array<GameCandidate & { pathLabel: string; preflight: FolderPreflight }>;
  /** The candidate the studio would open — `rel` of one of them, or null when it must ask. */
  suggested: string | null;
  /** Repositories of their own directly inside the picked folder — what keeping it has to answer for. */
  nested: string[];
  /**
   * What opening the picked folder *itself* would write into it: the starter game when the folder
   * holds nothing of its own, and only Genex's bookkeeping when it holds files of its own and no
   * web page, including a folder whose game is one level down (keeping the parent never writes a
   * game beside the real one). Empty when the folder is a game of its own — its own candidate
   * answers that instead.
   */
  starter: string[];
  /** The folder holds files of its own and no web page: opening it writes only Genex's bookkeeping. */
  ownFiles: boolean;
  /**
   * Opening the folder itself writes the web starter's missing files: it is a web game by the
   * starter's stamp in its studio.json, though no page of its own is a candidate.
   */
  webStarter: boolean;
}

export interface ProjectRecent {
  name: string;
  title: string;
  pathLabel: string;
  dir: string;
  openedAt: string;
}

/**
 * A game folder's content stamps from one walk (`game.contentStamp` with `split`): everything,
 * and the game's sources without docs/ and Markdown. Null is unknown: the preview check runs.
 */
export interface ContentStamps {
  all: string | null;
  source: string | null;
}

/** What `game.export` wrote: the public roots it assembled, and what it left out. */
export interface ExportResult {
  dir: string;
  files: number;
  included: string[];
  excluded: string[];
  /** The build exported; absent for a browser game's own export (the web folder). */
  destination?: BuildTarget;
  /** The one artifact a desktop export made (the `.app`, the Windows `.zip`, the Linux `.tar.gz`), inside `dir`; absent for a web folder. */
  artifact?: string;
  /** Whether the export's GPU path ran on a real GPU of its destination (`gpuQualificationOf`); absent where the receipt carries none. */
  gpuQualification?: GpuQualification;
  /** What the export made but warns about (a browser game's code past its budget); absent: none. */
  warnings?: ExportWarning[];
}

/**
 * What the studio's instrumentation actually got hold of on a page it just served (M4.2b).
 *
 * `game.validate` answers the same question from the folder's sources — a static judgement
 * about a page nobody loaded. This is the live one: the page is served, waited for and asked
 * what the hook attached to. `installed` is a game that calls `installStudio` itself,
 * `attached` is a game the hook found by watching it render, `none` is neither.
 */
export interface AttachReport {
  ok: boolean;
  contract: "installed" | "attached" | "none";
  /**
   * Did the studio's own page layer load at all? Every number below is read through it, so a
   * `false` here says the report is empty because the instrumentation never arrived — not
   * because the game is unconnected.
   */
  shim: boolean;
  reach: string | null;
  renderer: string | null;
  scene: string | null;
  camera: string | null;
  cameras: string[];
  eyes: string[];
  player: boolean;
  renders: number;
  frames: number;
  three: string[];
  reason: string | null;
  loadError: string | null;
  consoleErrors: number | null;
}
