/**
 * Game workspaces — the "nothing trapped" product principle.
 *
 * A project is a plain folder of ES modules that runs directly in the preview through the
 * `game://` protocol. There is deliberately **no bundler and no package manager**: three.js is
 * vendored with the app and resolved through an import map, so scaffolding is instantaneous,
 * works with the sandbox's network switched off, and a snapshot restore is a pure `git checkout`
 * with nothing to reinstall.
 *
 * Folders may live **anywhere the user owns** — Cursor/Codex's model. `~/AI Games` is the default
 * library for "New Folder"; "Use Existing" and Recents point at arbitrary paths. Chat history
 * stays in the app's own data; the folder is the game plus any stills the user dropped in.
 *
 * Export is therefore almost free: copy the project, copy the vendored library next to it, and
 * the result is a static site anyone can host.
 *
 * A compiled game is the exception: a C++ · raylib CMake project scaffolded from its own template
 * (`game-template-cpp`), or a Rust · wgpu `genex.toml` project from its own (`game-template-rust`,
 * behind a dev gate until its lane lands), built by the studio's lane with a pinned toolchain and
 * exported from that build. Its stack is fixed when it is made; its destinations can grow.
 *
 * What a folder's page loads lives in `game-page.ts`, how it runs in `project-shape.ts`, the
 * repositories inside it in `nested-repos.ts` and the pre-judge check in `game-validation.ts`;
 * this module re-exports what its callers have always imported from here.
 */
import type { Dirent } from "node:fs";
import { cp, lstat, mkdir, readdir, readFile, realpath, rmdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type CoverLook, firstCoverRecipe, rollCoverRecipe } from "../shared/cover-recipe.ts";
import type { StudioPlatform } from "../shared/boot.ts";
import { assetFormat } from "../shared/game-assets.ts";
import { ExportError, ExportRefusal } from "../shared/game-export-contract.ts";
import { folderNameFromTitle, MAX_SLUG_LENGTH, PROJECT_NAME_RE, slugFromName } from "../shared/game-folder-name.ts";
import {
  displayCover,
  validateGameCover,
  validateGameTitle,
  type GameLibraryEntry,
  type GameUpdate,
} from "../shared/game-library.ts";
import {
  ALL_BUILD_TARGETS,
  BuildTarget,
  type CompiledStack,
  CreationRefusal,
  DEFAULT_DESTINATIONS,
  DESKTOP_TARGETS,
  type FolderInspection,
  type FolderPreflight,
  type GameCandidate,
  type GameDestinations,
  type GameProject,
  GameStack,
  isCompiledStack,
  isGameStack,
  type ProjectRecent,
  type ProjectShape,
  stackForTargets,
  stackOf,
} from "../shared/game-project.ts";
import type { EngineBinding } from "../shared/game-engine.ts";
import { hostOf, TargetRefusal } from "../shared/game-targets.ts";
import { type DestinationCheck, parseDestinationCheck } from "../shared/native-contract.ts";
import {
  CoreFact,
  FactSource,
  FolderHolds,
  type GameKind,
  hasFact,
  isProjectStarter,
  kindPending,
  parsePortedFrom,
  parseScaffoldRecord,
  type ProjectFact,
  type ProjectStarter,
  type ScaffoldRecord,
  type SourcedFactRule,
  settleFacts,
} from "../shared/project-facts.ts";
import {
  copySkipRulesFor,
  ignoreLine,
  ignoreRulesFor,
  type PlacedRule,
  type PluginWorkspace,
} from "../shared/project-workspace.ts";
import { readEngineBinding } from "./game-engine-binding.ts";
import { EXPORT_STAGING_DIR, exportPublicGame, type ExportOptions, type ExportResult } from "./game-export.ts";
import { ownNotes, ownRules, REFERENCES_README } from "./game-workspace-prompts.ts";
import { type GameValidation, validateGameDir } from "./game-validation.ts";
import {
  atomicWriteJson,
  ensureDir,
  entryExists,
  isFillableFolder,
  isJsonObject,
  pathExists,
  readJsonForUpdate,
  readJsonIfExists,
  readOwnJsonForUpdate,
  readRegularFile,
  writeFileNoFollow,
  writeNewFile,
} from "./fsx.ts";
import { bundleIdOf, isBundleId } from "./native-bundle.ts";
import { ensureFactIgnoreRules, ensureIgnoreRules, ignoreRulesToWrite, nestedRepos } from "./nested-repos.ts";
import { isBelow, isInside, samePath, throughClaudeFolder, toPosixRelative } from "./paths.ts";
import { detectFacts, readStudioRecord, STUDIO_JSON_MAX_BYTES } from "./project-facts.ts";
import type { HookEvent } from "../shared/plugin-hooks.ts";
import {
  COMPILED_SHAPES,
  declaresDependencies,
  defaultDestinations,
  destinationVocabulary,
  detectProjectShape,
  findGameRoot,
  folderHolds,
  holdsOwnFiles,
  inBuildOrder,
  isBuiltShape,
  isDestinationList,
  playsOn,
  readGameDestinations,
  readPackageManifest,
  readProjectShape,
  readStudioJson,
  recordsShape,
  webGameSignal,
} from "./project-shape.ts";
import { ensureRepo } from "./snapshots.ts";
import { workspaceContentStamp } from "./workspace-content.ts";

/** The public shape of a game folder is a contract the UI reads too; it lives in `shared/game-project.ts`. */
export type {
  ContractWord,
  FolderInspection,
  FolderPreflight,
  GameCandidate,
  GameProject,
  ProjectKind,
  ProjectRecent,
  ProjectShape,
} from "../shared/game-project.ts";
export { type ContractReach, networkLoads, unreachableLoads } from "./game-page.ts";
export {
  type GameValidation,
  hudContractGeneration,
  NO_CONTRACT_PROBLEM,
  shippedHudGeneration,
  shippedStudioGeneration,
  studioContractGeneration,
  validateNativeDir,
  validateRustDir,
} from "./game-validation.ts";
export {
  NESTED_BACKUP,
  nestedForLanding,
  nestedRepos,
  versionNestedForLanding,
  versionNestedTrees,
} from "./nested-repos.ts";
export {
  type DestinationReading,
  detectProjectShape,
  findGameRoot,
  isBuiltShape,
  isDestinationList,
  plainRelativePath,
  RAYLIB_SHAPE,
  readGameDestinations,
  readProjectShape,
  RUST_SHAPE,
  TEMPLATE_SHAPE,
} from "./project-shape.ts";
import { isLockDigest } from "./toolchain-store/lock.ts";

/** The two template files that would land beside somebody's real game as dead scaffold. */
const OWN_ENTRY_KEEP = ["index.html", "src/main.js"] as const;

/**
 * …and the three pages that describe the *template's* project: "This project starts empty",
 * "Empty project", a contract page whose first section is "No build step, no package manager,
 * no network". In a game the user brought, every one of those sentences is false — and the
 * contractor obeyed them, keeping DOM UI out of a game whose UI is DOM and refusing the
 * downloads its own boot needs. Own-shape CLAUDE.md and NOTES.md
 * are written from `CLAUDE.own.md` / `NOTES.own.md` instead; the contract's reference tables
 * live in `src/studio.js` and `src/studio.d.ts`, which are still merged in.
 *
 * `src/hud.js` is not on this list and must not join it: the contract imports it, and a game
 * with its own build fails to bundle on a dynamic import of a file that is not there.
 */
const OWN_GAME_KEEP = [...OWN_ENTRY_KEEP, "CLAUDE.md", "NOTES.md", "docs/CONTRACT.md"] as const;

/**
 * What a raylib folder the studio did not scaffold never receives from the C++ template; a folder
 * listed here is withheld whole. Its CMakeLists.txt is its own. Nothing of the template's
 * `src/` lands: a second `main` is a duplicate symbol, and the runtime's C++20 units would join a
 * build that globs `src/*.cpp` and break it, inside the studio and out. The web shell and the
 * contract page describe the studio's own C++ project, not the one in the folder, and its rules
 * and notes are written for the game that is there (`#writeOwnPages`), never the scaffold's.
 */
const CPP_GAME_KEEP = ["CMakeLists.txt", "src", "web", "docs/CONTRACT.md", "CLAUDE.md", "NOTES.md"] as const;

/**
 * What a Rust folder the studio did not scaffold never receives from the Rust template, for the
 * same reasons: its `genex.toml` and its `src/` are its own (a second `main.rs` is a second game),
 * and the web shell, the contract page, the rules and the notes describe the template's project.
 * `docs/GENEX_API.md`, the facade's read-only reference, is not withheld.
 */
const RUST_GAME_KEEP = ["genex.toml", "src", "web", "docs/CONTRACT.md", "CLAUDE.md", "NOTES.md"] as const;

/** What each compiled stack's folders, adopted with their own files, never receive from its template. */
const COMPILED_GAME_KEEP = {
  [GameStack.RaylibCpp]: CPP_GAME_KEEP,
  [GameStack.RustWgpu]: RUST_GAME_KEEP,
} as const satisfies Record<CompiledStack, readonly string[]>;

/** Where the C++ template sits beside the Three.js one when the caller names no folder for it. */
const CPP_TEMPLATE_FOLDER = "game-template-cpp";
/** Where the Rust · wgpu template sits beside the Three.js one when the caller names no folder for it. */
const RUST_TEMPLATE_FOLDER = "game-template-rust";

/** The own-shape sources: the studio writes *from* them, never *into* a project. */
const TEMPLATE_SOURCES = ["CLAUDE.own.md", "NOTES.own.md"] as const;

/** The pages a game of its own gets from the own-shape sources instead of the template's. */
const OWN_PAGES = ["CLAUDE.md", "NOTES.md"] as const;

/** Where a folder's own description of itself may be found, in the order it is looked for. */
const README_FILES = ["README.md", "readme.md", "DESIGN.md", "docs/DESIGN.md"];

/**
 * The Three.js template files whose `__GAME_TITLE__` placeholder is filled in after a copy. A C++
 * game fills it in every file its template gave it that carries one, escaped for that file's kind.
 */
const TITLED_TEMPLATE_FILES = ["index.html", "NOTES.md"];
/** The placeholder a template file carries where the game's title goes. */
const TITLE_PLACEHOLDER = "__GAME_TITLE__";
/** C and C++ sources: the title fills a string literal's body there. */
const C_SOURCE_EXTENSIONS = [".c", ".cc", ".cpp", ".h", ".hpp"];
/** Rust sources: the title fills a plain (not raw, not `format!`) string literal's body there. */
const RUST_SOURCE_EXTENSION = ".rs";
/** TOML (`genex.toml`): the title fills a basic string's body there. */
const TOML_EXTENSION = ".toml";
/** Pages: the title fills element text there. */
const HTML_EXTENSIONS = [".html", ".htm"];
/** Characters that end a `\xNN` escape's hex digits only if a literal break follows. */
const HEX_DIGIT = /[0-9A-Fa-f]/;
/** The characters a page's text may not hold as written. */
const HTML_TEXT_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
/** The escapes a C string literal spells by name. */
const C_NAMED_ESCAPES: Readonly<Record<string, string>> = {
  "\\": "\\\\",
  '"': '\\"',
  "?": "\\?",
  "\n": "\\n",
  "\t": "\\t",
  "\r": "\\r",
};

/** The escapes a Rust string literal spells by name; any other control character is `\u{…}`. */
const RUST_NAMED_ESCAPES: Readonly<Record<string, string>> = {
  "\\": "\\\\",
  '"': '\\"',
  "\n": "\\n",
  "\t": "\\t",
  "\r": "\\r",
  "\0": "\\0",
};
/** The escapes a TOML basic string spells by name; any other control character (DEL too) is `\uXXXX`. */
const TOML_NAMED_ESCAPES: Readonly<Record<string, string>> = {
  "\\": "\\\\",
  '"': '\\"',
  "\n": "\\n",
  "\t": "\\t",
  "\r": "\\r",
  "\b": "\\b",
  "\f": "\\f",
};

/** What a new folder's `.gitignore` starts with, before the studio's own rules. */
const GITIGNORE_HEADER = "export/\n.DS_Store\n";

/** The folders a template game exports beside its `index.html` when studio.json names none. */
const DEFAULT_EXPORT_DIRS = ["src", "assets"];

/**
 * The template files this folder must not receive. A game of its own keeps its entry and is
 * never handed the empty project's pages; the sheet's answer can only narrow that further
 * ("I am bringing my own files"), never widen it, because there is no consent that puts a
 * second index.html beside a real one.
 *
 * `template: false` withholds the same five. It is what "Keep this folder" passes when the game
 * is one folder down, and the folder it keeps is a real project: dropping "This project starts
 * empty", "Empty project" and a contract page headed "No build step, no package manager, no
 * network" into somebody's repository is the same false briefing from the other side.
 */
function templateKeep(shape: ProjectShape, options: { template?: boolean }): Set<string> {
  const keep = new Set<string>(TEMPLATE_SOURCES);
  for (const file of withheldFiles(shape, options)) keep.add(file);
  return keep;
}

/** The files beyond the own-shape sources that `templateKeep` holds back from this folder. */
function withheldFiles(shape: ProjectShape, options: { template?: boolean }): readonly string[] {
  // A compiled folder is only ever adopted with its own files: the scaffold copies the whole template.
  const stack = stackOf(shape);
  if (isCompiledStack(stack)) return COMPILED_GAME_KEEP[stack];
  return isBuiltShape(shape) || options.template === false ? OWN_GAME_KEEP : [];
}

/**
 * Whether adopting a folder writes it rules and notes of its own (`#writeOwnPages`): a game of its
 * own shape, and every compiled folder, whose own pages speak of its CMake or `genex.toml` project.
 */
function getsOwnPages(shape: ProjectShape): boolean {
  return isBuiltShape(shape) || isCompiledStack(stackOf(shape));
}

/** Whether a folder holds a game already (scaffolding must not overwrite it): a page, a compiled project, or a newer Genex's game. */
async function holdsGame(dir: string): Promise<boolean> {
  if (await pathExists(path.join(dir, "index.html"))) return true;
  const shape = await readProjectShape(dir);
  return shape.readOnly !== undefined || isCompiledStack(stackOf(shape));
}

/** The destinations whose builds the lane records a check for: the desktop ones. */
const CHECKED_TARGETS: ReadonlySet<string> = new Set<BuildTarget>([
  BuildTarget.Mac,
  BuildTarget.Windows,
  BuildTarget.Linux,
]);
const isCheckedTarget = (value: unknown): value is BuildTarget =>
  typeof value === "string" && CHECKED_TARGETS.has(value);

/** A game's desktop checks from its library entry, each read back through `parseDestinationCheck`; null when none is valid. */
function nativeChecksOf(entry: GameLibraryEntry | undefined): Partial<Record<BuildTarget, DestinationCheck>> | null {
  const stored: unknown = entry?.native?.checks;
  if (!isJsonObject(stored)) return null;
  const checks: Partial<Record<BuildTarget, DestinationCheck>> = {};
  for (const [target, value] of Object.entries(stored)) {
    const check = parseDestinationCheck(value);
    if (isCheckedTarget(target) && check) checks[target] = check;
  }
  return Object.keys(checks).length > 0 ? checks : null;
}

/** `{nativeChecks}` for a game with a valid check, else nothing (the field stays absent). */
function nativeChecksField(entry: GameLibraryEntry | undefined): {
  nativeChecks?: Partial<Record<BuildTarget, DestinationCheck>>;
} {
  const nativeChecks = nativeChecksOf(entry);
  return nativeChecks ? { nativeChecks } : {};
}

/** studio.json's stack, destinations and fixed shape for a compiled game. */
function compiledFields(stack: CompiledStack, targets: readonly BuildTarget[]) {
  const shape = COMPILED_SHAPES[stack];
  return {
    stack,
    targets: [...targets],
    entry: shape.entry,
    main: shape.main,
    build: null,
    own: false,
    kind: shape.kind,
    serve: shape.serve,
  };
}

/** What a new game's studio.json records beyond its name: nothing for a Three.js game, as always. */
function destinationFields(destinations: GameDestinations | undefined) {
  if (destinations === undefined || !isCompiledStack(destinations.stack)) return {};
  return compiledFields(destinations.stack, destinations.targets);
}

/**
 * Who asks the library for a new game. Only the host itself ({@link ScaffoldCaller.Internal}:
 * tests, fixtures and smoke checks), named as such, may still make a C++ · raylib game; the
 * harness's `game.scaffold`, the person's Create game and a call that names no caller are refused
 * one (`raylib-creation-retired`), so a new call site never gets the host's authority by omission.
 * Wire values: never rename one.
 */
export const ScaffoldCaller = {
  /** The host itself: tests, fixtures and smoke checks. A call must name it; absent is not the host. */
  Internal: "internal",
  /** The harness, through `game.scaffold`. */
  Harness: "harness",
  /** The person, through Create game. */
  Person: "person",
} as const;
export type ScaffoldCaller = (typeof ScaffoldCaller)[keyof typeof ScaffoldCaller];

/** A new game the studio no longer makes, with its typed reason beside the sentence. */
export class CreationError extends Error {
  readonly code: CreationRefusal;

  constructor(code: CreationRefusal, message: string) {
    super(message);
    this.name = "CreationError";
    this.code = code;
  }
}

/**
 * Why a create request from outside the host is refused for its stack, or null: it names
 * C++ · raylib (its creation is retired), or it names no stack and a desktop destination, which
 * is how a pre-Rust caller asked for a raylib game. Checked on the request as sent, before any
 * other reading of it.
 */
export function creationRefusal(request: { stack?: unknown; targets?: unknown }): CreationRefusal | null {
  if (request.stack === GameStack.RaylibCpp) return CreationRefusal.RaylibCreationRetired;
  if (request.stack !== undefined || !Array.isArray(request.targets)) return null;
  const desktop: readonly unknown[] = DESKTOP_TARGETS;
  return request.targets.some((target) => desktop.includes(target)) ? CreationRefusal.RaylibCreationRetired : null;
}

/** A destination change the studio refused, with its typed reason beside the sentence. */
export class DestinationError extends Error {
  readonly code: TargetRefusal;

  constructor(code: TargetRefusal, message: string) {
    super(message);
    this.name = "DestinationError";
    this.code = code;
  }
}

/**
 * The refusal every write into a newer Genex's game meets ({@link ProjectShape.readOnly}:
 * `kind-unsupported`), or null for a game this version may change.
 */
export function readOnlyRefusal(shape: ProjectShape): DestinationError | null {
  return shape.readOnly ? new DestinationError(shape.readOnly, MESSAGE.KindUnsupported) : null;
}

/** Refuse, typed and before anything is written, any write into the game folder at `dir` when it is read-only. */
export async function assertWritableGame(dir: string): Promise<void> {
  const refusal = readOnlyRefusal(await readProjectShape(dir));
  if (refusal) throw refusal;
}

/** How a folder is opened: which game inside it, and whether the studio may write a starter one. */
export interface AdoptOptions {
  /** Allow project configuration only after the person explicitly trusts this folder. */
  trustProjectSettings?: boolean;
  title?: string;
  /**
   * The game to open inside the picked folder — a `rel` from `inspect`, one folder down.
   * A nested game is offered as *the* game, with the user's consent.
   */
  subdir?: string;
  /**
   * May the studio write its starter game (`index.html`, `src/main.js`) into this folder?
   * Default: only into a web game. `false` is "I am bringing my own files" — into a web folder the
   * contract module and the notes are still added. Any folder with no web page (an empty one
   * included) gets only Genex's bookkeeping unless this is `true`.
   */
  template?: boolean;
  /**
   * The user keeps a folder that holds a game of its own as a repository, and agrees that the
   * studio may make that game part of this folder's history when a build goes live. Without it a run can read and run the nested game but can never deliver a
   * change inside it. Recorded in studio.json; nothing else may set it.
   */
  versionNested?: boolean;
}

/** The caller's own rules for a chosen folder, given its real path: rejects to refuse it. */
export type LocationCheck = (real: string) => Promise<void>;

/** Where Create game makes a game: the games folder, unless the user chose another. */
export interface CreateOptions {
  /** The folder the user chose; the game gets a new folder of its own inside it. */
  parent?: string;
  /** Checked on the one real path the game is then created in, before anything is written. */
  allowed?: LocationCheck;
  /** The stack Create Game chose; absent is what `targets` imply, and with neither a Three.js browser game. */
  stack?: GameStack;
  /**
   * Where people play: destinations the stack knows (`destinationVocabulary`), none twice. Absent
   * is the browser, plus this computer for a compiled game.
   */
  targets?: readonly BuildTarget[];
  /** Who asks; absent is not the host, so a new raylib game needs {@link ScaffoldCaller.Internal} named. */
  caller?: ScaffoldCaller;
  /** The title waits for the game's first idea (`GameLibraryEntry.provisional`). */
  provisional?: boolean;
}

export interface ScaffoldOptions {
  /** Directory holding the template shipped with the app. */
  templateDir: string;
  /** Where the vendored three.js lives, copied into exports. */
  vendorDir: string;
  title?: string;
  /** The stack to scaffold for, which picks the template; absent is what `targets` imply, else Three.js. */
  stack?: GameStack;
  /** The destinations studio.json records for a C++ · raylib game; absent is the browser and this computer. */
  targets?: readonly BuildTarget[];
  /** Who asks; absent is not the host, so a new raylib game needs {@link ScaffoldCaller.Internal} named. */
  caller?: ScaffoldCaller;
}

export interface ProjectIndexFile {
  version: 1;
  aliases: Record<string, string>;
  recents: Array<{ name: string; dir: string; openedAt: string }>;
  presentation?: Record<string, GameLibraryEntry>;
}

const MESSAGE = {
  InvalidName: (name: string) =>
    `invalid project name ${JSON.stringify(name)} — use lowercase letters, digits, - and _`,
  FolderGone: "This game folder is no longer available.",
  InvalidPin: "Invalid pin state.",
  NotChosenCover: "Expected a chosen cover.",
  SubdirIsPath: "open a game folder inside the one you picked, not a path",
  NoSuchSubdir: (child: string, where: string) => `there is no "${child}" folder in ${where}`,
  BannedFolder: "pick a project folder, not your home directory or the whole library",
  AppFolder: "that folder belongs to the app itself — pick a game folder you own",
  BuildBeforeExport: "Build the current game successfully before exporting",
  DeclareExportFiles:
    "Declare the public files/directories in studio.json exportFiles before exporting this custom project",
  BadExportFiles: "exportFiles must be a nonempty list of public paths",
  InsideGame: "Choose a folder outside your games.",
  RootNotEmpty: "Choose an empty folder. This one already has other folders in it.",
  LocationGone: "That folder is no longer there. Choose another one.",
  LocationNotFolder: "Choose a folder, not a file.",
  LocationRefused: "Studio can't create games there. Choose another folder.",
  UnknownStack: "Choose a stack the studio knows: Three.js or Rust · wgpu.",
  BadTargets: "Choose one to four destinations the studio knows, each once.",
  BrowserOnly: "A Three.js game plays in the browser only. Choose Rust · wgpu to play it on the desktop too.",
  RaylibRetired:
    "New C++ · raylib games can't be made any more; existing ones still open, build and export. Make a Rust · wgpu game instead.",
  StackIsFixed: "A game's stack is chosen when it is made: destinations can be added, the stack cannot change.",
  StackGated: "Rust games aren't available in this version of Genex yet.",
  KindUnsupported: "A newer version of Genex made this game, so this one opens it read-only.",
  NotANativeGame: "Only a compiled game (C++ · raylib or Rust · wgpu) records the toolchain it was built with.",
  NoMacBundle: "Only a compiled game (C++ · raylib or Rust · wgpu) is assembled into a Mac bundle.",
  BadLockDigest: "A toolchain lock is named by its sha256 digest.",
  BadNativeCheck:
    "A destination check is for a Mac, Windows or Linux build, with a known badge, a 12-hex lock and an ISO time.",
  NoNativeCheck: "Only a compiled game's (C++ · raylib or Rust · wgpu) desktop builds are checked.",
  AlreadyKind: (facts: readonly ProjectFact[]) =>
    `This game already has a kind (${facts.map(factWords).join(", ")}), so Genex writes no starter into it.`,
  UnknownStarter: "Genex has no starter of that kind.",
  LinkInFolder: (rel: string) =>
    `Genex writes no starter here: \`${rel}\` in this game's folder is a link, and Genex never writes through one.`,
  OwnKind:
    "This folder holds files of its own of a kind Genex doesn't know, so Genex writes no starter into it: work with the files that are there.",
} as const;

/** A fact as a refusal names it: its id, and its folder when that is not the game's root. */
const factWords = (fact: ProjectFact) => (fact.path === "." ? fact.id : `${fact.id} in ${fact.path}`);

/** A game's facts and, when it has none, what its folder holds (`GameProject.holds`). */
type FolderKind = GameKind & { facts: ProjectFact[] };

/** A listed game whose folder can't be read: no facts, and no kind Genex can name. */
const unreadableKind = (): FolderKind => ({ facts: [], holds: FolderHolds.Unreadable });

/** The contract version a starter Genex writes declares in its studio.json. */
const STARTER_CONTRACT_VERSION = 1;

/** The entry a game made with a waiting title starts with. */
const provisional = (waiting: boolean | undefined): GameLibraryEntry => (waiting ? { provisional: true } : {});

/** Resolve existing ancestors too: legacy chats can precede the game folder on disk. */
async function presentationPath(dir: string): Promise<string> {
  const absolute = path.resolve(dir);
  try {
    return await realpath(absolute);
  } catch (error) {
    const parent = path.dirname(absolute);
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === absolute) throw error;
    return path.join(await presentationPath(parent), path.basename(absolute));
  }
}
const MAX_RECENTS = 16;
/** The most of a folder's README folded into its notes. */
const README_MAX_BYTES = 256 * 1024;
/** The most of a page or notes file read to fill in its title placeholder. */
const TITLED_FILE_MAX_BYTES = 64 * 1024 ** 2;

/**
 * A game's studio.json, read to be updated: never through a link, a FIFO or a folder planted at its
 * name (every agent process can write the game), so nothing the host alone can read is merged in
 * and written back into the game.
 */
function readStudioJsonForUpdate(dir: string): Promise<Record<string, unknown> | null> {
  return readOwnJsonForUpdate<Record<string, unknown>>(path.join(dir, "studio.json"), STUDIO_JSON_MAX_BYTES);
}

/** Every folder in the games root is listed as a game: a new root holds only the library's own games. */
async function assertNoOtherFolders(target: string, known: ReadonlySet<string>): Promise<void> {
  const entries = await readdir(target, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || !PROJECT_NAME_RE.test(entry.name)) continue;
    if (!known.has(await realpath(path.join(target, entry.name)))) throw new Error(MESSAGE.RootNotEmpty);
  }
}

export { slugFromName };

export function assertProjectName(name: string): void {
  if (!PROJECT_NAME_RE.test(name)) {
    throw new Error(MESSAGE.InvalidName(name));
  }
}

/** Make `dir`; false when something is already there under that name. */
async function madeFolder(dir: string): Promise<boolean> {
  try {
    await mkdir(dir);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

/** A new folder `base`, or `base 2`, `base 3`… in `parent`: never one that was already there. */
async function reserveNamedFolder(parent: string, base: string): Promise<string> {
  for (let n = 1; ; n++) {
    const dir = path.join(parent, n === 1 ? base : `${base} ${n}`);
    if (await madeFolder(dir)) return dir;
  }
}

/** `base`, or `base-2`, `base-3`… — the first name `taken` does not hold, cut before the number is added. */
function uniqueName(base: string, taken: { has(name: string): boolean }): string {
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base.slice(0, MAX_SLUG_LENGTH - `-${n}`.length)}-${n}`;
  return name;
}

export function tildePath(dir: string, home = os.homedir()): string {
  const resolved = path.resolve(dir);
  const root = path.resolve(home);
  if (resolved === root) return "~";
  if (isBelow(root, resolved)) return `~${resolved.slice(root.length)}`;
  return resolved;
}

/**
 * A plain raster picture by its extension (the `raster` rows of `ASSET_FORMATS`); the bytes are
 * still sniffed when it is read. By `path.extname`, so a dotfile such as `.png` has none.
 */
export function isImageFile(file: string): boolean {
  return assetFormat(path.extname(file))?.raster === true;
}

/** What a game's records say about its facts: its engine link, what a port replaced, New game's stamp. */
interface FactRecord {
  engine: EngineBinding | undefined;
  portedFrom: ProjectFact[];
  scaffoldStamp: string | undefined;
}

/** A game's studio.json as an object, or null when it is missing or does not parse. */
async function readStudioMeta(dir: string): Promise<Record<string, unknown> | null> {
  return readStudioRecord(dir);
}

/** The scaffold a game's studio.json records (`ScaffoldRecord`), or null when it records none that parses. */
async function readScaffold(dir: string): Promise<ScaffoldRecord | null> {
  return parseScaffoldRecord((await readStudioMeta(dir))?.scaffold);
}

/** A scaffold record's rules, each with the scaffold as the source of its facts. */
const scaffoldRules = (scaffold: ScaffoldRecord | null): SourcedFactRule[] =>
  (scaffold?.facts ?? []).map((rule) => ({ rule, source: FactSource.Scaffold }));

/**
 * The engine link as a fact: `unreal-project` at the linked `.uproject`'s folder, relative to the
 * game (`.` for its root), or absolute when the project lies outside it.
 */
async function linkFact(dir: string, engine: EngineBinding): Promise<ProjectFact> {
  const root = await realpath(dir).catch(() => dir);
  const folder = path.dirname(engine.project);
  const inside = isInside(root, folder);
  const at = inside ? toPosixRelative(path.relative(root, folder)) || "." : folder;
  return { id: CoreFact.UnrealProject, path: at, source: FactSource.Link };
}

/** A cover the user (or a render they asked for) chose: a custom shader, or a recipe that is not a placeholder. */
function isChosenCover(cover: GameLibraryEntry["cover"]): cover is NonNullable<GameLibraryEntry["cover"]> {
  if (!cover) return false;
  if (cover.kind === "shader") return Boolean(cover.custom);
  return cover.kind === "recipe" && !cover.placeholder;
}

/**
 * The game the Open Game sheet selects by default: the folder itself when it holds a game of its
 * own; otherwise the one child that does — an empty template wrapped around somebody's real game
 * is exactly the case that broke.
 */
function suggestedCandidate(candidates: GameCandidate[]): string | null {
  const own = candidates.filter((candidate) => candidate.shape.own);
  const [onlyOwn] = own;
  if (own.length === 1 && onlyOwn) return onlyOwn.rel;
  if (candidates.some((candidate) => candidate.rel === ".")) return ".";
  const [onlyCandidate] = candidates;
  if (candidates.length === 1 && onlyCandidate) return onlyCandidate.rel;
  return null;
}

export class GameWorkspaces {
  /** Where new games are created and the folder listed as the library. `changeRoot` moves it. */
  root: string;
  readonly templateDir: string;
  readonly vendorDir: string;
  readonly indexFile: string;
  readonly homeDir: string;
  readonly userData: string;
  #aliases = new Map<string, string>();
  #recents: Array<{ name: string; dir: string; openedAt: string }> = [];
  #loading: Promise<void> | undefined;
  #presentation = new Map<string, GameLibraryEntry>();
  #indexWrites: Promise<void> = Promise.resolve();
  /** The template each stack is scaffolded from. */
  readonly #templates: Readonly<Record<GameStack, string>>;
  /** The computer the studio runs on, whose own OS a compiled game made without destinations plays on. */
  readonly #host: StudioPlatform | null;
  /** Whether Rust · wgpu games may be made here: the dev gate (`stack-gated` while it is closed). */
  readonly #rustCreation: boolean;
  /** The enabled plugins' project-detection rules, read at each listing. */
  readonly #factRules: () => readonly SourcedFactRule[];
  /** The enabled plugins' `workspace` and `assets` sections, read at each write of the rules. */
  readonly #workspaceSections: () => readonly PluginWorkspace[];
  /** The moments the enabled plugins hook for a game of a kind, read at each description. */
  readonly #hookEvents: (game: GameKind) => readonly HookEvent[];
  /** Real paths of games whose starter was found changed: never stamped again in this app run. */
  readonly #touched = new Set<string>();

  constructor(options: {
    root: string;
    templateDir: string;
    /** The C++ · raylib template shipped with the app; absent is `game-template-cpp` beside `templateDir`. */
    cppTemplateDir?: string;
    /** The Rust · wgpu template shipped with the app; absent is `game-template-rust` beside `templateDir`. */
    rustTemplateDir?: string;
    /**
     * Opens the dev gate: Rust · wgpu games may be created. Absent or false (every packaged build
     * until the Rust lane ships) refuses them `stack-gated`; reading, adopting and validating a
     * Rust folder never depend on it.
     */
    rustCreation?: boolean;
    vendorDir: string;
    indexFile: string;
    userData: string;
    homeDir?: string;
    /** The platform the studio runs on (`process.platform` unless a test names one). */
    platform?: string;
    factRules?: () => readonly SourcedFactRule[];
    workspaceSections?: () => readonly PluginWorkspace[];
    hookEvents?: (game: GameKind) => readonly HookEvent[];
  }) {
    this.root = options.root;
    this.templateDir = options.templateDir;
    this.vendorDir = options.vendorDir;
    this.indexFile = options.indexFile;
    this.userData = options.userData;
    this.homeDir = options.homeDir ?? os.homedir();
    this.#templates = {
      [GameStack.ThreeJs]: options.templateDir,
      [GameStack.RaylibCpp]:
        options.cppTemplateDir ?? path.join(path.dirname(options.templateDir), CPP_TEMPLATE_FOLDER),
      [GameStack.RustWgpu]:
        options.rustTemplateDir ?? path.join(path.dirname(options.templateDir), RUST_TEMPLATE_FOLDER),
    };
    this.#host = hostOf(options.platform ?? process.platform);
    this.#rustCreation = options.rustCreation === true;
    this.#factRules = options.factRules ?? (() => []);
    this.#workspaceSections = options.workspaceSections ?? (() => []);
    this.#hookEvents = options.hookEvents ?? (() => []);
  }

  dirFor(name: string): string {
    assertProjectName(name);
    return this.#aliases.get(name) ?? path.join(this.root, name);
  }

  pathLabel(dir: string): string {
    return tildePath(dir, this.homeDir);
  }

  async loadIndex(): Promise<void> {
    this.#loading ??= this.#readIndex();
    await this.#loading;
  }

  async #readIndex(): Promise<void> {
    const stored = await readJsonIfExists<ProjectIndexFile>(this.indexFile);
    if (stored?.version !== 1) return;
    for (const [name, dir] of Object.entries(stored.aliases ?? {})) {
      if (!PROJECT_NAME_RE.test(name) || typeof dir !== "string") continue;
      this.#aliases.set(name, path.resolve(dir));
    }
    this.#recents = (stored.recents ?? [])
      .filter((row) => row && PROJECT_NAME_RE.test(row.name) && typeof row.dir === "string")
      .map((row) => ({ name: row.name, dir: path.resolve(row.dir), openedAt: row.openedAt }));
    for (const [dir, entry] of Object.entries(stored.presentation ?? {}))
      this.#presentation.set(await presentationPath(dir), entry);
  }

  async #saveIndex(): Promise<void> {
    const save = this.#indexWrites
      .catch(() => {})
      .then(() =>
        atomicWriteJson(this.indexFile, {
          version: 1,
          aliases: Object.fromEntries(this.#aliases),
          recents: this.#recents,
          presentation: Object.fromEntries(this.#presentation),
        } satisfies ProjectIndexFile),
      );
    this.#indexWrites = save;
    await save;
  }

  async list(): Promise<GameProject[]> {
    await this.loadIndex();
    await ensureDir(this.root);
    const byName = await this.#libraryFolders();
    // Aliases whose folder is now a root folder go first: such a game keeps its name, and frees
    // the folder's own name for an alias that already holds it (a games folder moved elsewhere).
    const listed = (dir: string) => [...byName.values()].some((game) => samePath(game.dir, dir));
    const aliases = [...this.#aliases];
    const ordered = [...aliases.filter(([, dir]) => listed(dir)), ...aliases.filter(([, dir]) => !listed(dir))];
    for (const [name, dir] of ordered) await this.#addAlias(byName, name, dir);

    this.#recents = this.#recents.filter((row) => [...byName.values()].some((p) => samePath(p.dir, row.dir)));
    await this.#saveIndex();
    const visible = [];
    for (const game of byName.values()) {
      if (!(await this.presentation(game.name)).removed) visible.push(game);
    }
    return visible.sort((a, b) => (a.title.toLowerCase() < b.title.toLowerCase() ? -1 : 1));
  }

  /** Every game folder directly in the default library, by its folder name. */
  async #libraryFolders(): Promise<Map<string, GameProject>> {
    const byName = new Map<string, GameProject>();
    const entries = await readdir(this.root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      if (!PROJECT_NAME_RE.test(entry.name)) continue;
      const dir = path.join(this.root, entry.name);
      byName.set(entry.name, await this.#describe(entry.name, dir));
    }
    return byName;
  }

  /** One alias into the listing: dropped when its folder is gone or already listed, renamed on a clash. */
  async #addAlias(byName: Map<string, GameProject>, name: string, dir: string): Promise<void> {
    if (!(await pathExists(dir))) {
      this.#aliases.delete(name);
      return;
    }
    const libraryHit = [...byName.values()].find((p) => samePath(p.dir, dir));
    if (libraryHit?.name === name) {
      // Folder is already in the default library under its own name — drop the alias.
      this.#aliases.delete(name);
      return;
    }
    if (libraryHit) {
      // …under another name: the game keeps the one its chats are bound to.
      byName.delete(libraryHit.name);
      byName.set(name, await this.#describe(name, dir));
      return;
    }
    const clash = byName.get(name);
    if (clash && !samePath(clash.dir, dir)) {
      const renamed = uniqueName(slugFromName(path.basename(dir)), byName);
      this.#aliases.delete(name);
      this.#aliases.set(renamed, dir);
      byName.set(renamed, await this.#describe(renamed, dir));
      return;
    }
    byName.set(name, await this.#describe(name, dir));
  }

  async recents(): Promise<ProjectRecent[]> {
    const projects = await this.list();
    const byName = new Map(projects.map((p) => [p.name, p]));
    const out: ProjectRecent[] = [];
    for (const row of this.#recents) {
      const project = byName.get(row.name) ?? projects.find((p) => samePath(p.dir, row.dir));
      if (!project) continue;
      out.push({
        name: project.name,
        title: project.title,
        pathLabel: project.pathLabel,
        dir: project.dir,
        openedAt: row.openedAt,
      });
    }
    return out;
  }

  async exists(name: string): Promise<boolean> {
    // A compiled game has no page of its own: its files say it is one, and scaffolding must not overwrite it.
    return holdsGame(this.dirFor(name));
  }

  async touch(name: string): Promise<void> {
    await this.loadIndex();
    let dir: string;
    try {
      dir = this.dirFor(name);
    } catch {
      return;
    }
    if (!(await pathExists(dir))) return;
    this.#recents = [
      { name, dir, openedAt: new Date().toISOString() },
      ...this.#recents.filter((row) => row.name !== name && !samePath(row.dir, dir)),
    ].slice(0, MAX_RECENTS);
    await this.#saveIndex();
  }

  /**
   * Records the toolchain lock digest the last build of a compiled game's own folder used, in the
   * host's library (`GameLibraryEntry.native.lock`), never in the game: studio.json is in a folder
   * every agent process writes, and a build must not change the tree it just built. A game's stack
   * is fixed, so the one digest is always a lock of its own stack's line (`LOCK_FILE_OF_STACK`):
   * raylib's for a C++ game, the Rust line's for a Rust game. Retention keeps every lock a game
   * records (`nativeLocks`). Only a build lane calls it, after a build; nothing reads trust from
   * it, and an unchanged lock writes nothing.
   */
  async writeNativeLock(name: string, digest: string): Promise<void> {
    if (!isLockDigest(digest)) throw new Error(MESSAGE.BadLockDigest);
    await this.loadIndex();
    const dir = await realpath(this.dirFor(name));
    if (!isCompiledStack(stackOf(await readProjectShape(dir)))) throw new Error(MESSAGE.NotANativeGame);
    const saved = this.#presentation.get(dir);
    if (saved?.native?.lock === digest) return;
    this.#presentation.set(dir, { ...saved, native: { ...saved?.native, lock: digest } });
    await this.#saveIndex();
  }

  /**
   * Records what the build lane learned of a Mac, Windows or Linux build of a compiled game's own
   * folder (`GameLibraryEntry.native.checks[target]`), in the host's library keyed by the folder's
   * real path, never in the game. A check `parseDestinationCheck` refuses, another destination or
   * a game that is not compiled (C++ · raylib or Rust · wgpu) is refused before anything is
   * written; an unchanged check writes nothing.
   */
  async writeNativeCheck(name: string, target: BuildTarget, check: DestinationCheck): Promise<void> {
    const parsed = parseDestinationCheck(check);
    if (!isCheckedTarget(target) || parsed === null) throw new Error(MESSAGE.BadNativeCheck);
    await this.loadIndex();
    const dir = await realpath(this.dirFor(name));
    if (!isCompiledStack(stackOf(await readProjectShape(dir)))) throw new Error(MESSAGE.NoNativeCheck);
    const saved = this.#presentation.get(dir);
    const kept = nativeChecksOf(saved) ?? {};
    if (JSON.stringify(kept[target]) === JSON.stringify(parsed)) return;
    const checks = { ...kept, [target]: parsed };
    this.#presentation.set(dir, { ...saved, native: { ...saved?.native, checks } });
    await this.#saveIndex();
  }

  /**
   * The Mac bundle identifier of a compiled game (C++ · raylib or Rust · wgpu), chosen once: `games.genex.game.<sha12>` of
   * the game folder's real path on first use (`bundleIdOf`), kept in the host's library
   * (`GameLibraryEntry.native.bundleId`) and returned ever after: across restarts, and across a
   * move that leaves a link where the folder was (the library re-keys by real path). A folder
   * moved with no link left is a new library entry, as its cover and threads are. An id the game
   * itself writes anywhere in its folder is never read.
   */
  async bundleIdFor(name: string): Promise<string> {
    await this.loadIndex();
    const dir = await realpath(this.dirFor(name));
    if (!isCompiledStack(stackOf(await readProjectShape(dir)))) throw new Error(MESSAGE.NoMacBundle);
    const saved = this.#presentation.get(dir);
    const kept = saved?.native?.bundleId;
    if (kept !== undefined && isBundleId(kept)) return kept;
    const bundleId = bundleIdOf(dir);
    this.#presentation.set(dir, { ...saved, native: { ...saved?.native, bundleId } });
    await this.#saveIndex();
    return bundleId;
  }

  /** The lock digest each listed game's last build of its own folder recorded; a game with none adds nothing. */
  async nativeLocks(): Promise<string[]> {
    const locks: string[] = [];
    for (const game of await this.list()) {
      const lock = (await this.presentation(game.name)).native?.lock;
      if (isLockDigest(lock)) locks.push(lock);
    }
    return locks;
  }

  /**
   * The stack and destinations a new game is asked for, checked before anything is written:
   * undefined when neither is named (a Three.js browser game, written exactly as always).
   */
  #requestedDestinations(options: { stack?: unknown; targets?: unknown }): GameDestinations | undefined {
    const { stack, targets } = options;
    if (stack === undefined && targets === undefined) return undefined;
    if (stack !== undefined && !isGameStack(stack)) throw new Error(MESSAGE.UnknownStack);
    // Phones are destinations only a stack that names them knows; targets alone never imply one.
    const vocabulary = stack === undefined ? undefined : destinationVocabulary(stack);
    if (targets !== undefined && !isDestinationList(targets, vocabulary)) throw new Error(MESSAGE.BadTargets);
    const chosen = stack ?? stackForTargets(targets ?? []);
    // Behind the dev gate nothing scaffolds Rust: refused, never a Three.js game in its place.
    if (!this.#creatable(chosen)) throw new DestinationError(TargetRefusal.StackGated, MESSAGE.StackGated);
    if (isCompiledStack(chosen)) {
      return targets ? { stack: chosen, targets: inBuildOrder(targets) } : defaultDestinations(chosen, this.#host);
    }
    if (targets && stackForTargets(targets) !== GameStack.ThreeJs) throw new Error(MESSAGE.BrowserOnly);
    return DEFAULT_DESTINATIONS;
  }

  /** Whether games of `stack` may be made here: every stack but Rust · wgpu, which waits on the dev gate. */
  #creatable(stack: GameStack): boolean {
    return stack !== GameStack.RustWgpu || this.#rustCreation;
  }

  /** Refuses a request whose stack is not the one the game in `dir` was made with. */
  async #assertStack(dir: string, stack: GameStack): Promise<void> {
    if (stackOf(await readProjectShape(dir)) !== stack) {
      throw new DestinationError(TargetRefusal.StackIsFixed, MESSAGE.StackIsFixed);
    }
  }

  /**
   * Create a project from its stack's template under the default library. Idempotent: an existing
   * project is returned as-is, and one of another stack than the one asked for is refused.
   */
  async scaffold(name: string, options: Partial<ScaffoldOptions> = {}): Promise<GameProject> {
    await this.loadIndex();
    const destinations = this.#requestedDestinations(options);
    return this.#scaffoldChecked(name, options.title ?? name, destinations, options.caller);
  }

  /** Refuses a new C++ · raylib game to every caller but the host itself, named as such; nothing is written. */
  #assertCreatable(destinations: GameDestinations | undefined, caller: ScaffoldCaller | undefined): void {
    if (destinations?.stack === GameStack.RaylibCpp && caller !== ScaffoldCaller.Internal) {
      throw new CreationError(CreationRefusal.RaylibCreationRetired, MESSAGE.RaylibRetired);
    }
  }

  /**
   * {@link scaffold} once the stack and destinations are checked: `create` hands over the ones it
   * checked before making a folder, so nothing it accepted can be refused after the folder exists.
   */
  async #scaffoldChecked(
    name: string,
    title: string,
    destinations: GameDestinations | undefined,
    caller?: ScaffoldCaller,
  ): Promise<GameProject> {
    assertProjectName(name);
    const dir = this.dirFor(name);
    if (await this.exists(name)) {
      if (destinations) await this.#assertStack(dir, destinations.stack);
      await this.touch(name);
      return this.#describe(name, dir);
    }
    // Only a new game is refused: an existing raylib game stays reachable by name.
    this.#assertCreatable(destinations, caller);
    await this.#writeTemplate(dir, { title, name, overwrite: true, destinations });
    await this.touch(name);
    return this.#describe(name, dir);
  }

  /**
   * A game with no kind yet under the default library: Genex's bookkeeping (its record, the ignore
   * rules, a repository with its first commit) and nothing else; its first message picks what it
   * becomes. Idempotent: a folder that already holds anything is returned untouched, as `scaffold`
   * returns an existing game, so a name that collides with a game never writes into it.
   */
  async makeEmpty(name: string, options: Partial<ScaffoldOptions> = {}): Promise<GameProject> {
    await this.loadIndex();
    assertProjectName(name);
    const dir = this.dirFor(name);
    if ((await readdir(dir).catch(() => [])).length > 0) {
      await this.touch(name);
      return this.#describe(name, dir);
    }
    await ensureDir(dir);
    await this.#writeBookkeeping(dir, { name, title: options.title ?? name });
    await this.touch(name);
    return this.#describe(name, dir);
  }

  /**
   * Write a starter into a game that has no kind yet (its facts are pending), merged around what
   * the folder holds, and forget New game's stamp so the starter counts as the game's own. A game
   * with a kind is refused and nothing is written.
   */
  async start(name: string, starter: ProjectStarter): Promise<GameProject> {
    await this.loadIndex();
    if (!isProjectStarter(starter)) throw new Error(MESSAGE.UnknownStarter);
    const dir = this.dirFor(name);
    if (!(await pathExists(path.join(dir, "studio.json")))) throw new Error(MESSAGE.FolderGone);
    const kind = await this.kindOf(name);
    if (kind.facts.length > 0) throw new Error(MESSAGE.AlreadyKind(kind.facts));
    if (!kindPending(kind)) throw new Error(MESSAGE.OwnKind);
    // The folder is the agent's: a link it planted where the starter writes is refused before any write.
    const linked = await linkOnTheWay(dir, [...(await this.#templateFiles()), ...STARTER_BOOKKEEPING]);
    if (linked !== undefined) throw new Error(MESSAGE.LinkInFolder(linked));
    const { title } = await this.#describe(name, dir);
    await this.#writeTemplate(dir, { title, name, overwrite: false });
    await this.#recordStarterContract(dir);
    const key = await presentationPath(dir);
    const entry: GameLibraryEntry = { ...this.#presentation.get(key) };
    delete entry.scaffoldStamp;
    this.#presentation.set(key, entry);
    await this.#saveIndex();
    return this.#describe(name, dir);
  }

  /**
   * Record in the game's studio.json what a port replaced (`portedFrom`), beside what an earlier
   * port recorded, each fact once, and the scaffold the call made the game with (`scaffold`, in
   * place of an earlier one); every other key stays. The replaced kinds stay in the folder as the
   * reference and no longer count as the game's kind.
   */
  async recordPort(name: string, replaced: readonly ProjectFact[], scaffold?: ScaffoldRecord): Promise<void> {
    if (replaced.length === 0 && !scaffold) return;
    const file = path.join(this.dirFor(name), "studio.json");
    const current = (await readJsonForUpdate<Record<string, unknown>>(file)) ?? {};
    const kept = parsePortedFrom(current.portedFrom);
    const added = replaced.filter((fact) => !hasFact(kept, fact.id, fact.path));
    const portedFrom = [...kept, ...added].map(({ id, path: where, source }) => ({ id, path: where, source }));
    const next = {
      ...current,
      ...(replaced.length > 0 ? { portedFrom } : {}),
      ...(scaffold ? { scaffold: { ...scaffold } } : {}),
    };
    // The folder is the agent's: a link planted at studio.json is never written through.
    await writeFileNoFollow(file, `${JSON.stringify(next, null, 2)}\n`);
  }

  /** The starter's contract version, added to a record that has none (a game made empty has none). */
  async #recordStarterContract(dir: string): Promise<void> {
    const file = path.join(dir, "studio.json");
    const current = (await readJsonForUpdate<Record<string, unknown>>(file)) ?? {};
    if (typeof current.contractVersion === "number") return;
    const record = `${JSON.stringify({ ...current, contractVersion: STARTER_CONTRACT_VERSION }, null, 2)}\n`;
    await writeFileNoFollow(file, record);
  }

  /**
   * The explicit New game action always reserves a fresh folder, even for duplicate titles: in
   * the games folder, or inside the folder the user chose (`parent`), which is never opened. The
   * game starts empty (`makeEmpty`) and its first message picks its kind, unless Create Game chose
   * a compiled stack, whose template it gets at once (`#fillNewGame`).
   */
  async create(requestedTitle: string, options: CreateOptions = {}): Promise<GameProject> {
    const title = validateGameTitle(requestedTitle);
    // Before anything is written: a stack or destination the studio cannot honour leaves no folder.
    const destinations = this.#requestedDestinations(options);
    this.#assertCreatable(destinations, options.caller);
    await this.loadIndex();
    await ensureDir(this.root);
    if (options.parent !== undefined) {
      const parent = await this.location(options.parent, options.allowed);
      if (parent !== (await realpath(this.root)))
        return this.#createIn(parent, title, destinations, options.caller, options.provisional);
    }
    const base = slugFromName(title);
    for (let suffix = 1; ; suffix++) {
      const tail = suffix === 1 ? "" : `-${suffix}`;
      const name = base.slice(0, MAX_SLUG_LENGTH - tail.length) + tail;
      if (this.#aliases.has(name)) continue;
      if (!(await madeFolder(path.join(this.root, name)))) continue;
      await this.#fillNewGame(name, title, destinations, options.caller);
      await this.#rollCover(name, provisional(options.provisional));
      return this.#describe(name, this.dirFor(name));
    }
  }

  /**
   * A folder the user chose for a new game, as its real path: an existing folder that is not a
   * game or inside one, not the app's own data, not a Claude Code settings folder and not the
   * whole disk. The games folder itself is a location too: the ordinary library. `allowed` adds
   * the caller's rules for any other folder, on the same real path.
   */
  async location(dir: string, allowed?: LocationCheck): Promise<string> {
    await this.loadIndex();
    await ensureDir(this.root);
    if (!path.isAbsolute(dir)) throw new Error(MESSAGE.LocationRefused);
    const real = await realpath(dir).catch(() => null);
    if (!real) throw new Error(MESSAGE.LocationGone);
    if (!(await stat(real)).isDirectory()) throw new Error(MESSAGE.LocationNotFolder);
    const root = await realpath(this.root);
    if (real === root) return real;
    const appData = isInside(await presentationPath(this.userData), real) && !isInside(root, real);
    const refused = real === path.parse(real).root || appData || throughClaudeFolder(real);
    if (refused) throw new Error(MESSAGE.LocationRefused);
    const games = await this.#knownGameFolders(await this.list(), real);
    if ([...games].some((game) => isInside(game, real))) throw new Error(MESSAGE.InsideGame);
    await allowed?.(real);
    return real;
  }

  /**
   * What a new game's folder gets: a compiled stack's template at once when Create Game named one
   * (Rust · wgpu, or destinations that imply it), since its stack is chosen when it is made;
   * otherwise Genex's bookkeeping only (`makeEmpty`), and its first message picks its kind.
   */
  async #fillNewGame(
    name: string,
    title: string,
    destinations: GameDestinations | undefined,
    caller: ScaffoldCaller | undefined,
  ): Promise<void> {
    if (destinations && isCompiledStack(destinations.stack)) {
      await this.#scaffoldChecked(name, title, destinations, caller);
      return;
    }
    await this.makeEmpty(name, { title });
  }

  /**
   * A game in a folder the user chose: a new folder named as the game is, kept in the library as
   * an alias. The name is checked against the library and the alias set with no wait between, so
   * two games made at once never share one.
   */
  async #createIn(
    parent: string,
    title: string,
    destinations: GameDestinations | undefined,
    caller: ScaffoldCaller | undefined,
    waiting?: boolean,
  ): Promise<GameProject> {
    const dir = await reserveNamedFolder(parent, folderNameFromTitle(title));
    // The new folder must be where the checked location is: a link swapped in since the check
    // would have put it somewhere else. It is empty, so it goes again, and nothing is recorded.
    if ((await realpath(dir)) !== dir) {
      await rmdir(dir).catch(() => {});
      throw new Error(MESSAGE.LocationRefused);
    }
    const inRoot = new Set(await readdir(this.root));
    const name = uniqueName(slugFromName(title), { has: (taken) => this.#aliases.has(taken) || inRoot.has(taken) });
    this.#aliases.set(name, dir);
    await this.#saveIndex();
    await this.#fillNewGame(name, title, destinations, caller);
    await this.#rollCover(name, provisional(waiting));
    return this.#describe(name, dir);
  }

  /**
   * Create new games in another folder. Games already in the library stay where they are: those
   * in the old folder become aliases, so their names, and the chats bound to them, hold. Every
   * folder in the root is listed as a game, so only a folder with no other folders in it (apart
   * from this library's own games) can become the root.
   */
  async changeRoot(next: string): Promise<void> {
    await this.loadIndex();
    const target = path.resolve(next);
    if (target === path.resolve(this.root)) return;
    const games = await this.list();
    await assertNoOtherFolders(target, await this.#knownGameFolders(games, target));
    for (const game of games) {
      if (isInside(this.root, game.dir) && !this.#aliases.has(game.name)) {
        this.#aliases.set(game.name, path.resolve(game.dir));
      }
    }
    await ensureDir(target);
    this.root = target;
    await this.#saveIndex();
  }

  /** The real folders of the library's games (and every presented one); refuses a new root inside a game. */
  async #knownGameFolders(games: readonly GameProject[], target: string): Promise<Set<string>> {
    const known = new Set(this.#presentation.keys());
    const newRoot = await presentationPath(target);
    for (const game of games) {
      const dir = await realpath(game.dir);
      if (isInside(dir, newRoot)) throw new Error(MESSAGE.InsideGame);
      known.add(dir);
    }
    return known;
  }

  /**
   * A new game rolls a look no other game has, and a seed, at birth; the first game is always
   * Clouds. `born` is what else the new game's entry starts with.
   */
  async #rollCover(name: string, born: GameLibraryEntry = {}): Promise<void> {
    const others = (await this.list()).some((game) => game.name !== name);
    const dir = await presentationPath(this.dirFor(name));
    const saved = this.#presentation.get(dir);
    if (saved?.cover) return;
    const cover = others ? rollCoverRecipe(await this.coverLooksInUse(name)) : firstCoverRecipe();
    this.#presentation.set(dir, { ...saved, ...born, cover });
    await this.#saveIndex();
  }

  /** The looks the library's other games show, saved or resolved at display, so a new one can differ. */
  async coverLooksInUse(except?: string): Promise<CoverLook[]> {
    const looks: CoverLook[] = [];
    for (const game of await this.list()) {
      const shown = game.name === except ? undefined : displayCover(game.cover, game.name);
      if (shown?.kind === "recipe") looks.push({ family: shown.family, palette: shown.palette, hue: shown.hue });
    }
    return looks;
  }

  async presentation(name: string): Promise<GameLibraryEntry> {
    await this.loadIndex();
    const dir = this.dirFor(name);
    return { ...this.#presentation.get(await presentationPath(dir)) };
  }

  async rememberThread(name: string, threadId: string): Promise<void> {
    await this.loadIndex();
    // Legacy run launchers can bind the chat before they scaffold its folder.
    const dir = await presentationPath(this.dirFor(name));
    this.#presentation.set(dir, { ...this.#presentation.get(dir), primaryThreadId: threadId });
    await this.#saveIndex();
  }

  /**
   * Remember the folder's content as New game just made it (`GameProject.scaffoldStamp`): a later
   * turn reads "nothing built yet" from the folder still matching it. The stamp lists files through
   * git, so the folder's repository must exist; a folder that cannot be stamped records nothing.
   */
  async rememberScaffold(name: string): Promise<GameProject> {
    await this.loadIndex();
    const dir = this.dirFor(name);
    const stamp = await workspaceContentStamp(dir);
    if (stamp) {
      const key = await presentationPath(dir);
      this.#presentation.set(key, { ...this.#presentation.get(key), scaffoldStamp: stamp });
      await this.#saveIndex();
    }
    return this.#describe(name, dir);
  }

  async update(name: string, patch: GameUpdate): Promise<GameProject> {
    await this.loadIndex();
    const dir = await realpath(this.dirFor(name));
    if (!(await pathExists(dir))) throw new Error(MESSAGE.FolderGone);
    const changes: GameUpdate = {};
    if (patch.title !== undefined) changes.title = validateGameTitle(patch.title);
    if (patch.pinned !== undefined) {
      if (typeof patch.pinned !== "boolean") throw new Error(MESSAGE.InvalidPin);
      changes.pinned = patch.pinned;
    }
    if (patch.cover !== undefined) {
      validateGameCover(patch.cover);
      changes.cover = patch.cover;
    }
    const entry: GameLibraryEntry = { ...this.#presentation.get(dir), ...changes };
    // Any title given since the game was made is the one it keeps: its first idea renames it no more.
    if (changes.title !== undefined) delete entry.provisional;
    this.#presentation.set(dir, entry);
    await this.#saveIndex();
    return this.#describe(name, dir);
  }

  /** A game that arrived without a look (an opened folder) keeps the one its row already showed. */
  async ensureCover(name: string): Promise<void> {
    await this.loadIndex();
    const dir = await presentationPath(this.dirFor(name));
    const saved = this.#presentation.get(dir);
    if (saved?.cover) return;
    this.#presentation.set(dir, { ...saved, cover: displayCover(undefined, name) });
    await this.#saveIndex();
  }

  /** Compare immediately before the write: a user upload during rendering always wins. */
  async saveGeneratedCover(
    name: string,
    expected: GameLibraryEntry["cover"],
    cover: GameLibraryEntry["cover"],
  ): Promise<boolean> {
    await this.loadIndex();
    const dir = await realpath(this.dirFor(name));
    const saved = this.#presentation.get(dir);
    if (saved?.removed || JSON.stringify(saved?.cover) !== JSON.stringify(expected)) return false;
    if (!isChosenCover(cover)) throw new Error(MESSAGE.NotChosenCover);
    validateGameCover(cover);
    this.#presentation.set(dir, { ...saved, cover });
    await this.#saveIndex();
    return true;
  }

  /**
   * Open or create a project at an arbitrary folder — or at the game one level inside it, when
   * the user chose that one in the Open Game sheet. Existing files (stills, notes) are kept;
   * missing game files are filled in from the template, never beside a real game and never into
   * a folder of somebody's own project that is no web page (`#writesStarter`).
   */
  async adopt(dir: string, options: AdoptOptions = {}): Promise<GameProject> {
    await this.loadIndex();
    const resolved = await this.#adoptTarget(dir, options.subdir);
    // Re-adding a removed folder restores its stable identity, artwork and conversations.
    const saved = this.#presentation.get(resolved);
    if (saved?.removed) this.#presentation.set(resolved, { ...saved, removed: false });
    const existing = await this.#listedAt(resolved);
    if (existing) {
      await this.touch(existing.name);
      await this.#ensurePlayable(existing.dir, existing.name, options.title ?? existing.title, options);
      await this.#rememberTrust(existing.dir, options.trustProjectSettings === true);
      return this.#describe(existing.name, existing.dir);
    }

    const taken = new Set((await this.list()).map((p) => p.name));
    const name = uniqueName(slugFromName(path.basename(resolved)), taken);
    assertProjectName(name);

    if (!isInside(this.root, resolved) || path.basename(resolved) !== name) {
      this.#aliases.set(name, resolved);
    }
    const title = options.title ?? path.basename(resolved);
    await this.#ensurePlayable(resolved, name, title, options);
    await this.#rememberTrust(resolved, options.trustProjectSettings === true);
    await this.#saveIndex();
    await this.touch(name);
    return this.#describe(name, resolved);
  }

  async #rememberTrust(dir: string, trusted: boolean): Promise<void> {
    const key = await presentationPath(dir);
    const entry = { ...this.#presentation.get(key) };
    if (trusted) entry.trustProjectSettings = true;
    else delete entry.trustProjectSettings;
    this.#presentation.set(key, entry);
    await this.#saveIndex();
  }

  /** The listed game whose folder is `resolved` (a real path), if any. */
  async #listedAt(resolved: string): Promise<GameProject | undefined> {
    for (const game of await this.list()) {
      if ((await realpath(game.dir)) === resolved) return game;
    }
    return undefined;
  }

  /**
   * Remove from the library, preserving every folder and its stable identity for re-adding.
   */
  async forget(name: string): Promise<{ dir: string; trash: boolean }> {
    await this.loadIndex();
    const dir = this.dirFor(name);
    const key = await realpath(dir);
    this.#presentation.set(key, { ...this.#presentation.get(key), removed: true });
    this.#recents = this.#recents.filter((row) => row.name !== name);
    await this.#saveIndex();
    return { dir, trash: false };
  }

  async #describe(name: string, dir: string): Promise<GameProject> {
    // Never through a link, a FIFO or past a cap: what is not a plain studio.json says nothing.
    const { meta } = await readStudioJson(dir);
    const parsed = {
      title: typeof meta?.title === "string" ? meta.title : undefined,
      createdAt: typeof meta?.createdAt === "string" ? meta.createdAt : undefined,
      portedFrom: meta?.portedFrom,
      scaffold: meta?.scaffold,
    };
    const shape = await readProjectShape(dir);
    const { destinations } = await readGameDestinations(dir, shape, this.#host);
    const presentation = this.#presentation.get(await realpath(dir));
    const engine = await readEngineBinding(dir);
    const portedFrom = parsePortedFrom(parsed.portedFrom);
    const scaffold = parseScaffoldRecord(parsed.scaffold);
    const record = { engine, portedFrom, scaffoldStamp: presentation?.scaffoldStamp };
    // A folder that can't be read is still listed: it has no facts and is of no kind Genex can name.
    const { facts, holds } = await this.#kind(dir, record).catch(unreadableKind);
    const hookEvents = this.#hookEvents({ facts, ...(holds ? { holds } : {}) });
    return {
      name,
      dir,
      title: presentation?.title ?? parsed.title ?? path.basename(dir) ?? name,
      primaryThreadId: presentation?.primaryThreadId,
      pinned: presentation?.pinned ?? false,
      cover: presentation?.cover,
      lastOpenedAt: this.#recents.find((row) => row.name === name)?.openedAt,
      ...(presentation?.provisional ? { provisional: true } : {}),
      createdAt: parsed.createdAt ?? "",
      pathLabel: this.pathLabel(dir),
      library: isInside(this.root, dir),
      shape,
      built: isBuiltShape(shape),
      destinations,
      ...nativeChecksField(presentation),
      ...(engine ? { engine } : {}),
      facts,
      ...(holds ? { holds } : {}),
      ...(hookEvents.length > 0 ? { hookEvents: [...hookEvents] } : {}),
      ...(portedFrom.length > 0 ? { portedFrom } : {}),
      ...(scaffold ? { scaffold: { plugin: scaffold.plugin, id: scaffold.id, label: scaffold.label } } : {}),
      web: hasFact(facts, CoreFact.WebGame, "."),
      ...(presentation?.scaffoldStamp ? { scaffoldStamp: presentation.scaffoldStamp } : {}),
    };
  }

  /**
   * Where a game plays, set to `targets`: one to four destinations the studio knows, each once. A
   * C++ game may add any; a Three.js game plays in the browser, and a desktop destination would
   * change its stack, which never changes ({@link TargetRefusal.StackIsFixed}). Refused before
   * anything is written.
   */
  async setDestinations(name: string, targets: readonly BuildTarget[]): Promise<GameProject> {
    if (!isDestinationList(targets, ALL_BUILD_TARGETS)) throw new Error(MESSAGE.BadTargets);
    await this.loadIndex();
    const dir = await realpath(this.dirFor(name));
    const shape = await readProjectShape(dir);
    if (shape.readOnly) throw new DestinationError(shape.readOnly, MESSAGE.KindUnsupported);
    const stack = stackOf(shape);
    // The phones are unknown to a stack that cannot name them, as they always were.
    if (!isDestinationList(targets, destinationVocabulary(stack))) throw new Error(MESSAGE.BadTargets);
    if (!targets.every((target) => playsOn(stack, target))) {
      throw new DestinationError(TargetRefusal.StackIsFixed, MESSAGE.StackIsFixed);
    }
    // The browser alone is what every Three.js game already is: there is nothing to record.
    if (isCompiledStack(stack)) {
      const current = (await readStudioJsonForUpdate(dir)) ?? {};
      await atomicWriteJson(path.join(dir, "studio.json"), { ...current, stack, targets: inBuildOrder(targets) });
    }
    return this.#describe(name, dir);
  }

  /**
   * What a game's folder holds, as listed (`GameProject.facts`): `rawFactsOf` minus what never counts.
   * Throws when the folder is gone or can't be read.
   */
  async factsOf(name: string): Promise<ProjectFact[]> {
    return (await this.kindOf(name)).facts;
  }

  /**
   * A game's facts and, when it has none, what its folder holds (`GameProject.holds`): what tells a
   * game with no kind yet (`kindPending`) from one of a kind Genex can't name. Throws when the folder
   * is gone or can't be read.
   */
  async kindOf(name: string): Promise<FolderKind> {
    await this.loadIndex();
    const dir = this.dirFor(name);
    const presentation = this.#presentation.get(await presentationPath(dir));
    const engine = await readEngineBinding(dir);
    const portedFrom = parsePortedFrom((await readStudioMeta(dir))?.portedFrom);
    return this.#kind(dir, { engine, portedFrom, scaffoldStamp: presentation?.scaffoldStamp });
  }

  /**
   * Everything a game's folder holds before anything is left out: the facts its files give (the
   * core table, the enabled plugins' `detect` and its recorded scaffold's rules) and its engine
   * link. An untouched starter, an old engine record's web template and a port's reference all
   * count here. `scaffold` stands in for the recorded one: what a call that is about to record it
   * made.
   */
  async rawFactsOf(name: string, scaffold?: ScaffoldRecord): Promise<ProjectFact[]> {
    await this.loadIndex();
    const dir = this.dirFor(name);
    return this.#rawFacts(dir, await readEngineBinding(dir), scaffold);
  }

  /**
   * The facts the folder's files give (the core table, the enabled plugins' `detect`, and the rules
   * of `scaffold`, else of the scaffold studio.json records) and its engine link.
   */
  async #rawFacts(dir: string, engine: EngineBinding | undefined, scaffold?: ScaffoldRecord): Promise<ProjectFact[]> {
    const recorded = scaffold ?? (await readScaffold(dir));
    const detected = await detectFacts(dir, [...this.#factRules(), ...scaffoldRules(recorded)]);
    if (!engine) return detected;
    // The link stands for the game's Unreal project: a project file it holds besides (one the game
    // made before it was switched to another) is no second one, and its files are the link's own.
    const others = detected.filter((fact) => fact.id !== CoreFact.UnrealProject);
    return settleFacts([await linkFact(dir, engine), ...others]);
  }

  /**
   * The ignore lines of the facts a folder holds (Genex's table and the enabled plugins'
   * `workspace`), each at its fact's folder. Raw facts, not the listed ones: a port's reference and
   * an untouched starter still hold files whose scratch must stay out of history.
   */
  async #ruleLines(dir: string): Promise<string[]> {
    return (await this.#ignoreRules(dir)).map(ignoreLine);
  }

  /** The ignore rules of the facts a folder holds now, each placed at its fact's folder (one walk). */
  async #ignoreRules(dir: string): Promise<PlacedRule[]> {
    const facts = await this.#rawFacts(dir, await readEngineBinding(dir));
    return ignoreRulesFor(facts, this.#workspaceSections());
  }

  /**
   * What a worker's copy of a game leaves out, for the facts its folder holds now (one walk):
   * `skip` is the copy-skip and ignore rules together, `ignored` the ignore rules alone (what a
   * copy that versions the game's nested repositories still leaves out).
   */
  async copyRulesOf(name: string): Promise<{ skip: PlacedRule[]; ignored: PlacedRule[] }> {
    await this.loadIndex();
    const dir = this.dirFor(name);
    const facts = await this.#rawFacts(dir, await readEngineBinding(dir));
    const sections = this.#workspaceSections();
    const ignored = ignoreRulesFor(facts, sections);
    const skipOnly = copySkipRulesFor(facts, sections).filter(
      (rule) => !ignored.some((kept) => kept.base === rule.base && kept.pattern === rule.pattern),
    );
    return { skip: [...ignored, ...skipOnly], ignored };
  }

  /**
   * Called before every commit Genex makes in a game folder (save points, rescue snapshots, chat
   * checkpoints): tops up its `.gitignore` with the lines of the facts it holds now, so a port never
   * sweeps the new engine's scratch into history, and answers the placed rules. Only the facts'
   * lines: the generic rules and the file itself were written when the folder was opened, and a
   * person who changed them since keeps their change. A file already in history stays there; a
   * linked or missing ignore file is left alone.
   */
  async ensureWorkspaceRules(dir: string): Promise<PlacedRule[]> {
    const rules = await this.#ignoreRules(dir);
    await ensureFactIgnoreRules(dir, rules.map(ignoreLine));
    return rules;
  }

  /**
   * The facts a game lists: its raw facts minus what a port replaced (`portedFrom`), minus the web
   * template an engine link left beside its project (a link with no `portedFrom` is an older
   * record), and none at all for a starter nothing has been built in yet (no kind picked). With no
   * facts, what the folder holds besides (`folderHolds`).
   */
  async #kind(dir: string, record: FactRecord): Promise<FolderKind> {
    const raw = await this.#rawFacts(dir, record.engine);
    const linkedLegacy = record.engine !== undefined && record.portedFrom.length === 0;
    const facts = raw.filter((fact) => {
      if (hasFact(record.portedFrom, fact.id, fact.path)) return false;
      return !(linkedLegacy && fact.id === CoreFact.WebGame && fact.path === ".");
    });
    // New game's untouched starter is the template as it was made: nothing of the person's yet.
    if (await this.#untouchedStarter(dir, raw, record.scaffoldStamp)) return { facts: [], holds: FolderHolds.Nothing };
    if (facts.length > 0) return { facts };
    return { facts, holds: await folderHolds(dir) };
  }

  /**
   * Whether the folder is still the web starter New game made: it holds nothing but a web game at
   * its root (`raw`), and its content stamp still equals `scaffoldStamp`. A folder found changed is
   * remembered, so it is stamped once per app run; an unknown stamp is no starter.
   */
  async #untouchedStarter(dir: string, raw: readonly ProjectFact[], scaffoldStamp?: string): Promise<boolean> {
    if (!scaffoldStamp || raw.length !== 1 || !hasFact(raw, CoreFact.WebGame, ".")) return false;
    // A compiled game's stack was chosen when it was made: never a starter whose first message picks a kind.
    if (isCompiledStack(stackOf(await readProjectShape(dir)))) return false;
    const key = await realpath(dir).catch(() => dir);
    if (this.#touched.has(key)) return false;
    const stamp = await workspaceContentStamp(dir);
    if (stamp === scaffoldStamp) return true;
    if (stamp) this.#touched.add(key);
    return false;
  }

  /** Write a detected shape into studio.json once, so the folder's way of running is explicit and editable. */
  async #recordShape(dir: string, shape: ProjectShape): Promise<void> {
    // A studio.json that does not parse is the user's to fix: never replaced by the detected shape.
    const current = (await readStudioJsonForUpdate(dir)) ?? {};
    if (recordsShape(current)) return;
    const recorded = {
      entry: shape.entry,
      main: shape.main,
      build: shape.build,
      install: shape.install,
      own: shape.own,
      kind: shape.kind,
      serve: shape.serve,
    };
    await atomicWriteJson(path.join(dir, "studio.json"), { ...current, ...recorded });
  }

  async #resolveAdoptable(dir: string): Promise<string> {
    await ensureDir(dir);
    const resolved = await realpath(dir);
    this.#assertAdoptable(resolved);
    return resolved;
  }

  /**
   * The folder adoption actually opens: the one that was picked, or the game inside it the user
   * chose. Only a folder that already exists directly under the picked one is accepted — the
   * sheet's own candidates are the only source of this name, and it is never walked as a path.
   */
  async #adoptTarget(dir: string, subdir?: string): Promise<string> {
    const resolved = await this.#resolveAdoptable(dir);
    const child = (subdir ?? ".").trim();
    if (child === "" || child === ".") return resolved;
    if (child !== path.basename(child) || child.startsWith(".")) {
      throw new Error(MESSAGE.SubdirIsPath);
    }
    const target = await realpath(path.join(resolved, child)).catch(() => null);
    if (!target || !isInside(resolved, target)) {
      throw new Error(MESSAGE.NoSuchSubdir(child, this.pathLabel(resolved)));
    }
    this.#assertAdoptable(target);
    return target;
  }

  #assertAdoptable(resolved: string): void {
    const banned = [
      this.homeDir,
      path.parse(resolved).root,
      path.join(this.homeDir, "Library"),
      this.userData,
      this.root,
    ];
    if (banned.some((item) => path.resolve(item) === resolved)) {
      throw new Error(MESSAGE.BannedFolder);
    }
    if (isInside(this.userData, resolved) && !isInside(this.root, resolved)) {
      throw new Error(MESSAGE.AppFolder);
    }
  }

  /**
   * What a folder holds, without writing a byte into it: every game in it and one level down,
   * how each runs, and what would stop a run on it. The Open Game sheet asks this before the
   * user consents to anything — the studio used to scaffold first and explain never.
   */
  async inspect(dir: string): Promise<FolderInspection> {
    const resolved = await realpath(dir);
    this.#assertAdoptable(resolved);
    const found = await findGameRoot(resolved);
    const candidates = [];
    for (const candidate of found) {
      candidates.push({
        ...candidate,
        pathLabel: this.pathLabel(candidate.dir),
        preflight: await this.#preflight(candidate),
      });
    }
    const suggested = suggestedCandidate(candidates);
    // "Keep the parent" is a real answer to a game one level down, and an empty folder has no
    // candidate at all: both need to know what opening the folder itself would write. Keeping a
    // parent never writes a starter game — a second index.html beside somebody's real one is
    // the mistake this whole sheet exists to stop.
    const nested = await nestedRepos(resolved);
    const starter = candidates.some((candidate) => candidate.rel === ".")
      ? []
      : await this.plannedWrites(resolved, {
          ...(candidates.length > 0 ? { template: false } : {}),
          ...(nested.length > 0 ? { versionNested: true } : {}),
        });
    // Files of its own and no web page: a web game by its stamp gets the starter's missing files.
    const webStarter = await this.#writesStarter(resolved, {});
    const ownFiles = !webStarter && (await holdsOwnFiles(resolved));
    const holds = { candidates, suggested, starter, nested, ownFiles, webStarter };
    return { dir: resolved, pathLabel: this.pathLabel(resolved), ...holds };
  }

  async #preflight(candidate: GameCandidate): Promise<FolderPreflight> {
    const { dir, shape } = candidate;
    const declared = declaresDependencies(await readPackageManifest(dir));
    const nested = await nestedRepos(dir);
    const checked = await this.validateAt(dir);
    return {
      entry: shape.entry,
      build: shape.build,
      serve: shape.serve,
      install: shape.install,
      needsInstall: declared && !(await pathExists(path.join(dir, "node_modules"))),
      contract: checked.contract,
      git: (await pathExists(path.join(dir, ".git"))) ? "repo" : "none",
      nested,
      problems: checked.problems,
      warnings: checked.warnings,
      // The row's button carries `versionNested` whenever this candidate holds a repository of
      // its own (shape-words `openOptions`), so the list it shows has to account for it.
      writes: await this.plannedWrites(dir, nested.length > 0 ? { versionNested: true } : {}),
    };
  }

  /**
   * The user's answer to "may the studio version the repositories inside this folder", kept with
   * the game rather than with the app: whoever lands a build reads it from the folder itself.
   */
  async nestedConsent(dir: string): Promise<boolean> {
    const { meta } = await readStudioJson(dir);
    return meta?.versionNested === true;
  }

  /** Record that consent, once, in the game's own studio.json — nothing but adoption writes it. */
  async #recordConsent(dir: string): Promise<void> {
    const current = (await readStudioJsonForUpdate(dir)) ?? {};
    if (current.versionNested === true) return;
    await atomicWriteJson(path.join(dir, "studio.json"), { ...current, versionNested: true });
  }

  async #ensurePlayable(dir: string, name: string, title: string, options: AdoptOptions = {}): Promise<void> {
    const shape = await readProjectShape(dir);
    // A newer Genex's game opens read-only: not a byte is written into it, not even its history.
    if (shape.readOnly) return;
    const stack = stackOf(shape);
    if (isCompiledStack(stack)) return this.#ensureCompiledPlayable(dir, name, title, options, stack);
    if (!(await this.#writesStarter(dir, options))) {
      // Adoption updates studio.json below; one it cannot parse stops it here, before any write.
      if (options.versionNested) await readJsonForUpdate(path.join(dir, "studio.json"));
      await this.#writeBookkeeping(dir, { name, title });
      if (options.versionNested) await this.#recordConsent(dir);
      return;
    }
    // A folder that already has a game of its own shape keeps its entry: the template's
    // index.html and src/main.js would only sit beside the real ones as dead scaffold. The
    // studio's contract module and helpers are still added — the game imports what it needs —
    // and its rules are written for the game that is actually here, not for an empty project.
    const own = isBuiltShape(shape);
    // Adoption updates studio.json below; one it cannot parse stops it here, before any write.
    if (own || options.versionNested) await readStudioJsonForUpdate(dir);
    await this.#writeTemplate(dir, { title, name, overwrite: false, keep: [...templateKeep(shape, options)] });
    if (own) {
      await this.#writeOwnPages(dir, title, shape);
      await this.#recordShape(dir, shape);
    }
    if (options.versionNested) await this.#recordConsent(dir);
  }

  /**
   * Adopting a compiled folder: never a JavaScript file, only its stack's template files it lacks
   * (not its CMake project or `genex.toml`, nothing of `src/` or `web/`: `COMPILED_GAME_KEEP`),
   * rules and notes written for this game, and studio.json recording its stack, destinations and
   * fixed shape (`own: false`, so it never reads as a built game of its own).
   */
  async #ensureCompiledPlayable(
    dir: string,
    name: string,
    title: string,
    options: AdoptOptions,
    stack: CompiledStack,
  ): Promise<void> {
    // Adoption updates studio.json below; one it cannot parse stops it here, before any write.
    await readStudioJsonForUpdate(dir);
    const shape = COMPILED_SHAPES[stack];
    const { destinations } = await readGameDestinations(dir, shape, this.#host);
    const keep = [...templateKeep(shape, options)];
    await this.#writeTemplate(dir, { title, name, overwrite: false, keep, destinations });
    await this.#writeOwnPages(dir, title, shape);
    const record = await this.#compiledRecord(dir, stack);
    if (record) await atomicWriteJson(path.join(dir, "studio.json"), record);
    if (options.versionNested) await this.#recordConsent(dir);
  }

  /** studio.json of a compiled game with its stack, destinations and shape recorded; null when it already says all of it. */
  async #compiledRecord(dir: string, stack: CompiledStack): Promise<Record<string, unknown> | null> {
    const current = (await readStudioJsonForUpdate(dir)) ?? {};
    const { destinations } = await readGameDestinations(dir, COMPILED_SHAPES[stack], this.#host);
    const next = { ...current, ...compiledFields(stack, destinations.targets) };
    return JSON.stringify(next) === JSON.stringify(current) ? null : next;
  }

  /**
   * The two pages a game of its own gets instead of the template's: rules that describe *this*
   * game (its entry, its build, its screen and input kept as they are) and a notes file seeded
   * from whatever the folder already says about itself. Neither is ever overwritten — a
   * project that came with a CLAUDE.md or a NOTES.md keeps the one its author wrote — and neither
   * is written through a link planted at its name (one to `~/.zshenv` would carry the README's
   * lines into a file outside the game): anything at all there, a dangling link included, keeps it.
   */
  async #writeOwnPages(dir: string, title: string, shape: ProjectShape): Promise<void> {
    // The pages come from the template of the game's own stack: a C++ game's speak of CMake and raylib.
    const sources = this.#templates[stackOf(shape)];
    const claude = path.join(dir, "CLAUDE.md");
    if (!(await entryExists(claude))) {
      const template = await readFile(path.join(sources, "CLAUDE.own.md"), "utf8").catch(() => null);
      if (template !== null) await writeNewFile(claude, ownRules(template, shape));
    }
    const notes = path.join(dir, "NOTES.md");
    if (!(await entryExists(notes))) {
      const template = await readFile(path.join(sources, "NOTES.own.md"), "utf8").catch(() => null);
      if (template !== null) await writeNewFile(notes, ownNotes(template, title, shape, await this.#folderReadme(dir)));
    }
  }

  /** What the folder already says about itself — the pitch nobody should have to write twice. */
  async #folderReadme(dir: string): Promise<{ file: string; text: string } | null> {
    for (const file of README_FILES) {
      // Never through a link: its text lands in the game's notes, which every agent process reads.
      const text = await readRegularFile(path.join(dir, file), README_MAX_BYTES).then(
        (bytes) => bytes.toString("utf8"),
        () => null,
      );
      if (text?.trim()) return { file, text };
    }
    return null;
  }

  /**
   * Exactly what adopting a folder would add to it, in the order it is written — the list the
   * Open Game sheet shows *before* the user agrees to anything. It follows the same two rules
   * `#ensurePlayable` follows (a game of its own keeps its entry; nothing already there is
   * overwritten), and project-shape.test.ts holds the plan against what adoption really writes:
   * a promise about somebody else's folder is only worth making if it is kept.
   */
  async plannedWrites(dir: string, options: AdoptOptions = {}): Promise<string[]> {
    const shape = await readProjectShape(dir);
    // A newer Genex's game is opened read-only (`#ensurePlayable`): nothing to promise.
    if (shape.readOnly) return [];
    const starter = await this.#getsTemplate(dir, shape, options);
    const template = this.#templates[stackOf(shape)];
    const writes = starter ? await this.#missingTemplateFiles(dir, templateKeep(shape, options), template) : [];
    // A game of its own, and every compiled folder adopted, is held out of the template's pages above and given its own two.
    if (starter && getsOwnPages(shape)) {
      for (const file of OWN_PAGES) {
        if (!(await entryExists(path.join(dir, file)))) writes.push(file);
      }
    }
    if (await this.#writesStudioJson(dir, shape, starter, options)) writes.push("studio.json");
    // A linked ignore file is left alone, so it is never promised. A template that ships its own
    // .gitignore already listed it above; the rules top that copy up.
    const ignoreLines = await ignoreRulesToWrite(dir, await this.#ruleLines(dir));
    if (ignoreLines.length > 0 && !writes.includes(".gitignore")) writes.push(".gitignore");
    // Version history is what makes a run undoable; an existing repository is left alone.
    if (!(await pathExists(path.join(dir, ".git")))) writes.push(".git");
    return writes;
  }

  /**
   * Whether opening a folder writes the web starter into it: when asked to, or when the folder is a
   * web game. Otherwise it gets only Genex's bookkeeping (`#writeBookkeeping`): an empty folder or
   * one of notes starts with no kind (its first message picks one), and a folder of somebody's own
   * project that is no web page is never handed a web game's files. The one place adoption decides
   * this for a folder that is no compiled game.
   */
  async #writesStarter(dir: string, options: AdoptOptions): Promise<boolean> {
    return options.template === true || (await webGameSignal(dir));
  }

  /**
   * Whether adopting a folder of `shape` writes its stack's template files it lacks: always for a
   * compiled game (C++ · raylib, Rust · wgpu), whose own files say what it is; otherwise when the
   * web starter is written (`#writesStarter`).
   */
  async #getsTemplate(dir: string, shape: ProjectShape, options: AdoptOptions): Promise<boolean> {
    return isCompiledStack(stackOf(shape)) || (await this.#writesStarter(dir, options));
  }

  /** Every file of the web template a merge writes from, as paths relative to the game (its sources left out). */
  async #templateFiles(): Promise<string[]> {
    return templateFiles(this.templateDir, new Set(TEMPLATE_SOURCES));
  }

  /**
   * The files of `template` that `dir` lacks, in the template's sorted order, leaving out `keep`:
   * what `mergeCopy` writes, so a name anything is at (a link included) and a folder that is a
   * link or a file are left out, as the copy leaves them.
   */
  async #missingTemplateFiles(dir: string, keep: Set<string>, template: string): Promise<string[]> {
    return missingTemplateFiles(template, dir, keep, "");
  }

  /**
   * studio.json is written when it is missing — and again when a game of its own has no shape
   * recorded yet (#recordShape merges entry/main/build/… into whatever is already there).
   * …and again when this row's button is the nested-repository consent, which is written into
   * the same file (`#recordConsent`). An edit to a file that is there is still a promise —
   * that is why `.gitignore` is on the list — and the consent must not be the one exception.
   */
  async #writesStudioJson(dir: string, shape: ProjectShape, starter: boolean, options: AdoptOptions): Promise<boolean> {
    const { meta } = await readStudioJson(dir);
    const recorded = recordsShape(meta);
    const consenting = options.versionNested === true && !(await this.nestedConsent(dir));
    if (!(await pathExists(path.join(dir, "studio.json")))) return true;
    const stack = stackOf(shape);
    if (isCompiledStack(stack)) return consenting || (await this.#compiledRecordChanges(dir, stack));
    return (starter && isBuiltShape(shape) && !recorded) || consenting;
  }

  /** Whether adopting a compiled folder would write its studio.json (one it cannot parse stops adoption, which is a write refused, not promised). */
  async #compiledRecordChanges(dir: string, stack: CompiledStack): Promise<boolean> {
    return (await this.#compiledRecord(dir, stack).catch(() => ({}))) !== null;
  }

  async #writeTemplate(
    dir: string,
    options: { title: string; name: string; overwrite: boolean; keep?: string[]; destinations?: GameDestinations },
  ): Promise<void> {
    const stack = options.destinations?.stack ?? GameStack.ThreeJs;
    const template = this.#templates[stack];
    await ensureDir(dir);
    let copied: string[];
    if (options.overwrite) {
      // The own-shape pages are sources, not project files: a fresh template game gets the
      // template's CLAUDE.md and NOTES.md, never the pair they would be rewritten from.
      await cp(template, dir, {
        recursive: true,
        filter: (source) => !(TEMPLATE_SOURCES as readonly string[]).includes(path.relative(template, source)),
      });
      copied = await templateFiles(template, new Set(TEMPLATE_SOURCES));
    } else {
      // The same holds for a merge, whoever asks for it (`games.start` names no `keep`).
      copied = await mergeCopy(template, dir, new Set([...TEMPLATE_SOURCES, ...(options.keep ?? [])]));
    }
    // A Three.js game's page keeps the title as written, as it always has; a compiled game's title
    // fills a source's string literal, a manifest's string and the page shell, so each file gets
    // it in its own escaping.
    if (!isCompiledStack(stack)) await fillTemplateTitle(dir, TITLED_TEMPLATE_FILES, () => options.title);
    else await fillTemplateTitle(dir, copied, (file) => titleFor(file, options.title));

    const studioPath = path.join(dir, "studio.json");
    if (options.overwrite || !(await pathExists(studioPath))) {
      const createdAt = new Date().toISOString();
      const record = {
        name: options.name,
        title: options.title,
        createdAt,
        contractVersion: 1,
        ...destinationFields(options.destinations),
      };
      // By rename: a link planted at its name is replaced, never written through.
      await atomicWriteJson(studioPath, record);
    }

    // Before the repository exists (`ensureRepo` below), so the first commit never sweeps in
    // what the rules exclude: the harness's own scratch, a fork's linked packages, build output,
    // secrets (see IGNORE_RULES) and the generated folders of the facts the folder holds. An
    // existing file is topped up, never rewritten: the rules the user has are theirs.
    await ensureIgnoreRules(dir, GITIGNORE_HEADER, await this.#ruleLines(dir));

    // Only into a real folder of the game's own: a `references` link would carry the page elsewhere.
    const references = path.join(dir, "references");
    if (await isFillableFolder(references)) {
      await ensureDir(references);
      await writeNewFile(path.join(references, "README.md"), REFERENCES_README);
    }

    await ensureRepo(dir);
  }

  /**
   * Genex's own bookkeeping and nothing else, for a folder that is no web game: its record
   * (studio.json without the starter's `contractVersion`), the ignore rules and version history.
   */
  async #writeBookkeeping(dir: string, options: { name: string; title: string }): Promise<void> {
    const studioPath = path.join(dir, "studio.json");
    if (!(await pathExists(studioPath))) {
      const createdAt = new Date().toISOString();
      // By rename: a link planted at its name is replaced, never written through.
      await atomicWriteJson(studioPath, { name: options.name, title: options.title, createdAt });
    }
    // Before the repository exists, as for the starter: the first commit follows the rules.
    await ensureIgnoreRules(dir, GITIGNORE_HEADER, await this.#ruleLines(dir));
    await ensureRepo(dir);
  }

  /**
   * Static check run before every judged build. It catches the two failures that would otherwise
   * waste a whole gauntlet iteration: a missing entry point, and a game that abandoned the
   * contract (hard-coded `Math.random`, no `window.__studio`).
   */
  async validate(
    name: string,
  ): Promise<Pick<GameValidation, "ok" | "problems" | "missing" | "warnings" | "contract" | "codes">> {
    return this.validateAt(this.dirFor(name));
  }

  /** {@link validateGameDir} on a folder by path. */
  async validateAt(dir: string): Promise<GameValidation> {
    return validateGameDir(dir);
  }

  /** Self-contained web bundle: the project plus the vendored library, hostable anywhere. */
  async export(
    name: string,
    targetDir: string,
    builtOutput?: string,
    options: ExportOptions = {},
  ): Promise<ExportResult> {
    const dir = this.dirFor(name);
    const recorded = await readProjectShape(dir);
    // A newer Genex's game is read-only: nothing of it, built or not, is exported here.
    if (recorded.readOnly) throw new DestinationError(recorded.readOnly, MESSAGE.KindUnsupported);
    const shape = await detectProjectShape(dir);
    const { meta: config } = await readStudioJson(dir);
    const staged = { stagingRoot: path.join(this.userData, EXPORT_STAGING_DIR), ...options };
    if (builtOutput) return exportPublicGame(builtOutput, targetDir, await readdir(builtOutput), undefined, staged);
    // A compiled game's public copy is its web build, never its sources: with no build there is nothing to export.
    if (isCompiledStack(stackOf(recorded))) {
      throw new ExportError(ExportRefusal.BuildFailed, MESSAGE.BuildBeforeExport);
    }
    if (shape?.build) throw new Error(MESSAGE.BuildBeforeExport);
    if (shape && !config?.exportFiles) throw new Error(MESSAGE.DeclareExportFiles);
    const roots = config?.exportFiles ?? (await defaultExportRoots(dir));
    if (!isExportList(roots)) throw new Error(MESSAGE.BadExportFiles);
    return exportPublicGame(dir, targetDir, roots, shape ? undefined : this.vendorDir, staged);
  }
}

/** A template game's public files: its page plus whichever of the default folders it has. */
async function defaultExportRoots(dir: string): Promise<string[]> {
  const present = await Promise.all(
    DEFAULT_EXPORT_DIRS.map(async (root) => ((await pathExists(path.join(dir, root))) ? root : null)),
  );
  return ["index.html", ...present.filter((root): root is string => root !== null)];
}

/** studio.json's `exportFiles`, as written by hand: a non-empty list of non-empty strings. */
function isExportList(roots: unknown): roots is string[] {
  if (!Array.isArray(roots) || !roots.length) return false;
  return roots.every((p) => typeof p === "string" && Boolean(p));
}

/** What `games.start` writes besides the template's files: the record, ignore rules, stills note and repository. */
const STARTER_BOOKKEEPING = ["studio.json", ".gitignore", "references/README.md", ".git"] as const;

/**
 * The first of `rels` (paths relative to `dir`) that goes through a link on its way, folder by folder,
 * named by the part that is the link; undefined when none does. A dangling link counts.
 */
async function linkOnTheWay(dir: string, rels: readonly string[]): Promise<string | undefined> {
  const checked = new Set<string>();
  for (const rel of rels) {
    const parts = rel.split("/");
    for (let depth = 1; depth <= parts.length; depth++) {
      const at = parts.slice(0, depth).join("/");
      if (checked.has(at)) continue;
      checked.add(at);
      const there = await lstat(path.join(dir, at)).catch(() => null);
      if (there?.isSymbolicLink()) return at;
      // Nothing is there yet, so nothing below it can be a link either.
      if (!there) break;
    }
  }
  return undefined;
}

/**
 * `title` as the body of a C/C++ string literal: backslash, quote and `?` (no trigraph can form)
 * escaped, `\n` `\t` `\r` by name, any other control character as `\xNN`; everything else,
 * UTF-8 included, as written. A hex escape followed by a hex digit closes the literal and opens
 * the next (`"\x01" "F"`), since C reads every hex digit into the escape.
 */
function cStringBody(title: string): string {
  let body = "";
  let afterHex = false;
  for (const char of title) {
    if (afterHex && HEX_DIGIT.test(char)) body += '" "';
    const code = char.codePointAt(0) ?? 0;
    const named = C_NAMED_ESCAPES[char];
    afterHex = named === undefined && (code < 0x20 || code === 0x7f);
    if (named !== undefined) body += named;
    else if (afterHex) body += `\\x${code.toString(16).padStart(2, "0")}`;
    else body += char;
  }
  return body;
}

/** `title` as a page's text: `& < > " '` as entities. */
function htmlText(title: string): string {
  return title.replace(/[&<>"']/g, (char) => HTML_TEXT_ESCAPES[char] ?? char);
}

/** `title` as the body of a string literal whose named escapes are `named`, any other control character spelled by `code`. */
function escapedBody(title: string, named: Readonly<Record<string, string>>, code: (point: number) => string): string {
  let body = "";
  for (const char of title) {
    const point = char.codePointAt(0) ?? 0;
    const control = point < 0x20 || point === 0x7f;
    body += named[char] ?? (control ? code(point) : char);
  }
  return body;
}

/** `title` as the body of a plain Rust string literal: `\\` `"` and the named controls escaped, any other as `\u{NN}`. */
function rustStringBody(title: string): string {
  return escapedBody(title, RUST_NAMED_ESCAPES, (point) => `\\u{${point.toString(16)}}`);
}

/** `title` as the body of a TOML basic string: `\\` `"` and the named controls escaped, any other (DEL too) as `\uXXXX`. */
function tomlStringBody(title: string): string {
  return escapedBody(title, TOML_NAMED_ESCAPES, (point) => `\\u${point.toString(16).toUpperCase().padStart(4, "0")}`);
}

/** The title as it goes into `file`: escaped for a C/C++ or Rust source, a TOML manifest or a page, and as written anywhere else. */
function titleFor(file: string, title: string): string {
  const extension = path.extname(file).toLowerCase();
  if (C_SOURCE_EXTENSIONS.includes(extension)) return cStringBody(title);
  if (extension === RUST_SOURCE_EXTENSION) return rustStringBody(title);
  if (extension === TOML_EXTENSION) return tomlStringBody(title);
  if (HTML_EXTENSIONS.includes(extension)) return htmlText(title);
  return title;
}

/**
 * Fill the title into those of `files` that carry its placeholder, as `fill` spells it for each
 * file. Read and written never through a link and never blocking on a FIFO: a folder being opened
 * may have planted either at those names.
 */
async function fillTemplateTitle(dir: string, files: readonly string[], fill: (file: string) => string): Promise<void> {
  for (const file of files) {
    const target = path.join(dir, file);
    const text = await readRegularFile(target, TITLED_FILE_MAX_BYTES).then(
      (bytes) => bytes.toString("utf8"),
      () => null,
    );
    if (text?.includes(TITLE_PLACEHOLDER)) {
      // A function, so `$'`, `` $` ``, `$&` or `$$` in a title stay the title's own characters.
      const title = fill(file);
      await writeFileNoFollow(
        target,
        text.replaceAll(TITLE_PLACEHOLDER, () => title),
      );
    }
  }
}

/**
 * Copy the template files `to` lacks, leaving out `keep`; the files it copied, relative and
 * `/`-separated. A name anything is at (a dangling link included) is left as it is, and a
 * folder that is a link or a file is not filled: nothing is written through a link the folder
 * came with. Each file is created exclusively with its template's mode.
 */
async function mergeCopy(from: string, to: string, keep: Set<string> = new Set(), rel = ""): Promise<string[]> {
  await ensureDir(to);
  const copied: string[] = [];
  const entries = await readdir(from, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    const relative = rel ? `${rel}/${entry.name}` : entry.name;
    // `keep`: template files a folder with its own game must never receive.
    if (keep.has(relative)) continue;
    if (entry.isDirectory()) {
      if (await isFillableFolder(dest)) copied.push(...(await mergeCopy(src, dest, keep, relative)));
    } else if (!(await entryExists(dest)) && (await copyNewFile(src, dest))) {
      copied.push(relative);
    }
  }
  return copied;
}

/** One template file copied to `dest` only when nothing is there, with the template's own mode. */
async function copyNewFile(src: string, dest: string): Promise<boolean> {
  const [bytes, info] = await Promise.all([readFile(src), stat(src)]);
  return writeNewFile(dest, bytes, info.mode & 0o777);
}

/** The files under the template folder `from` (at `rel`) that `dir` lacks, as `#missingTemplateFiles` lists them. */
async function missingTemplateFiles(from: string, dir: string, keep: Set<string>, rel: string): Promise<string[]> {
  const writes: string[] = [];
  for (const entry of await sortedEntries(from)) {
    const relative = rel ? `${rel}/${entry.name}` : entry.name;
    if (!keep.has(relative))
      writes.push(...(await missingTemplateEntry(entry, path.join(from, entry.name), dir, keep, relative)));
  }
  return writes;
}

/** One template entry's missing files: the file itself when nothing is at its name, a fillable folder's own. */
async function missingTemplateEntry(
  entry: Dirent,
  source: string,
  dir: string,
  keep: Set<string>,
  relative: string,
): Promise<string[]> {
  const target = path.join(dir, relative);
  if (!entry.isDirectory()) return (await entryExists(target)) ? [] : [relative];
  return (await isFillableFolder(target)) ? missingTemplateFiles(source, dir, keep, relative) : [];
}

/** A template folder's entries sorted by name; none when it cannot be read. */
async function sortedEntries(from: string): Promise<Dirent[]> {
  const entries = await readdir(from, { withFileTypes: true }).catch(() => []);
  return entries.sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** Every file of a template, relative and `/`-separated, leaving out `skip`. */
async function templateFiles(from: string, skip: ReadonlySet<string>, rel = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const relative = rel ? `${rel}/${entry.name}` : entry.name;
    if (skip.has(relative)) continue;
    if (entry.isDirectory()) files.push(...(await templateFiles(path.join(from, entry.name), skip, relative)));
    else files.push(relative);
  }
  return files;
}
