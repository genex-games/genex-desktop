/**
 * The public shape of a game folder: what the library lists, how a project runs, and what the Open
 * Game sheet shows about a picked folder. `substrate/game-workspace.ts` decides and writes these
 * and re-exports the types; the renderer reads them through `window.studio`.
 */
import type { EngineBinding } from "./game-engine.ts";
import type { GameLibraryEntry } from "./game-library.ts";
import type { HookEvent } from "./plugin-hooks.ts";
import type { FolderHolds, ProjectFact } from "./project-facts.ts";

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
 */
export type ProjectKind =
  | "studio-template"
  | "three-vite"
  | "three-modules"
  | "canvas2d"
  | "phaser"
  | "engine-export"
  | "own-script";

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
