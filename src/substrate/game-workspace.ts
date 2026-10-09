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
 * What a folder's page loads lives in `game-page.ts`, how it runs in `project-shape.ts`, the
 * repositories inside it in `nested-repos.ts` and the pre-judge check in `game-validation.ts`;
 * this module re-exports what its callers have always imported from here.
 */
import { cp, mkdir, readdir, readFile, realpath, rmdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type CoverLook, firstCoverRecipe, rollCoverRecipe } from "../shared/cover-recipe.ts";
import { assetFormat } from "../shared/game-assets.ts";
import { folderNameFromTitle, MAX_SLUG_LENGTH, PROJECT_NAME_RE, slugFromName } from "../shared/game-folder-name.ts";
import {
  displayCover,
  validateGameCover,
  validateGameTitle,
  type GameLibraryEntry,
  type GameUpdate,
} from "../shared/game-library.ts";
import type {
  FolderInspection,
  FolderPreflight,
  GameCandidate,
  GameProject,
  ProjectRecent,
  ProjectShape,
} from "../shared/game-project.ts";
import { exportPublicGame, type ExportOptions, type ExportResult } from "./game-export.ts";
import { ownNotes, ownRules, REFERENCES_README } from "./game-workspace-prompts.ts";
import { type GameValidation, validateGameDir } from "./game-validation.ts";
import { atomicWriteJson, ensureDir, pathExists, readJsonForUpdate, readJsonIfExists } from "./fsx.ts";
import { ensureIgnoreRules, missingIgnoreRules, nestedRepos } from "./nested-repos.ts";
import { isBelow, isInside, samePath, throughClaudeFolder } from "./paths.ts";
import {
  declaresDependencies,
  detectProjectShape,
  findGameRoot,
  isBuiltShape,
  readPackageManifest,
  readProjectShape,
  recordsShape,
} from "./project-shape.ts";
import { ensureRepo } from "./snapshots.ts";

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
} from "./game-validation.ts";
export {
  NESTED_BACKUP,
  nestedForLanding,
  nestedRepos,
  versionNestedForLanding,
  versionNestedTrees,
} from "./nested-repos.ts";
export {
  detectProjectShape,
  findGameRoot,
  isBuiltShape,
  plainRelativePath,
  readProjectShape,
  TEMPLATE_SHAPE,
} from "./project-shape.ts";

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

/** The own-shape sources: the studio writes *from* them, never *into* a project. */
const TEMPLATE_SOURCES = ["CLAUDE.own.md", "NOTES.own.md"] as const;

/** The pages a game of its own gets from the own-shape sources instead of the template's. */
const OWN_PAGES = ["CLAUDE.md", "NOTES.md"] as const;

/** Where a folder's own description of itself may be found, in the order it is looked for. */
const README_FILES = ["README.md", "readme.md", "DESIGN.md", "docs/DESIGN.md"];

/** The template files whose `__GAME_TITLE__` placeholder is filled in after a copy. */
const TITLED_TEMPLATE_FILES = ["index.html", "NOTES.md"];

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
  for (const file of isBuiltShape(shape) || options.template === false ? OWN_GAME_KEEP : []) {
    keep.add(file);
  }
  return keep;
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
   * Default: only into a folder that holds no game of its own. `false` is "I am bringing my own
   * files" — the contract module and the notes are still added.
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
  /** The title waits for the game's first idea (`GameLibraryEntry.provisional`). */
  provisional?: boolean;
}

export interface ScaffoldOptions {
  /** Directory holding the template shipped with the app. */
  templateDir: string;
  /** Where the vendored three.js lives, copied into exports. */
  vendorDir: string;
  title?: string;
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
} as const;

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

  constructor(options: {
    root: string;
    templateDir: string;
    vendorDir: string;
    indexFile: string;
    userData: string;
    homeDir?: string;
  }) {
    this.root = options.root;
    this.templateDir = options.templateDir;
    this.vendorDir = options.vendorDir;
    this.indexFile = options.indexFile;
    this.userData = options.userData;
    this.homeDir = options.homeDir ?? os.homedir();
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
    return pathExists(path.join(this.dirFor(name), "index.html"));
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
   * Create a project from the template under the default library. Idempotent: an existing
   * project is returned as-is.
   */
  async scaffold(name: string, options: Partial<ScaffoldOptions> = {}): Promise<GameProject> {
    await this.loadIndex();
    assertProjectName(name);
    const dir = this.dirFor(name);
    const title = options.title ?? name;
    if (await this.exists(name)) {
      await this.touch(name);
      return this.#describe(name, dir);
    }
    await this.#writeTemplate(dir, { title, name, overwrite: true });
    await this.touch(name);
    return this.#describe(name, dir);
  }

  /**
   * The explicit New game action always reserves a fresh folder, even for duplicate titles: in
   * the games folder, or inside the folder the user chose (`parent`), which is never opened.
   */
  async create(requestedTitle: string, options: CreateOptions = {}): Promise<GameProject> {
    const title = validateGameTitle(requestedTitle);
    await this.loadIndex();
    await ensureDir(this.root);
    if (options.parent !== undefined) {
      const parent = await this.location(options.parent, options.allowed);
      if (parent !== (await realpath(this.root))) return this.#createIn(parent, title, options.provisional);
    }
    const base = slugFromName(title);
    for (let suffix = 1; ; suffix++) {
      const tail = suffix === 1 ? "" : `-${suffix}`;
      const name = base.slice(0, MAX_SLUG_LENGTH - tail.length) + tail;
      if (this.#aliases.has(name)) continue;
      if (!(await madeFolder(path.join(this.root, name)))) continue;
      await this.scaffold(name, { title });
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
   * A game in a folder the user chose: a new folder named as the game is, kept in the library as
   * an alias. The name is checked against the library and the alias set with no wait between, so
   * two games made at once never share one.
   */
  async #createIn(parent: string, title: string, waiting?: boolean): Promise<GameProject> {
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
    await this.scaffold(name, { title });
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
   * missing game files are filled in from the template, and never beside a real game.
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
    const meta = await readFile(path.join(dir, "studio.json"), "utf8").catch(() => null);
    const parsed = meta ? (JSON.parse(meta) as { title?: string; createdAt?: string }) : {};
    const shape = await readProjectShape(dir);
    const presentation = this.#presentation.get(await realpath(dir));
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
    };
  }

  /** Write a detected shape into studio.json once, so the folder's way of running is explicit and editable. */
  async #recordShape(dir: string, shape: ProjectShape): Promise<void> {
    const file = path.join(dir, "studio.json");
    // A studio.json that does not parse is the user's to fix: never replaced by the detected shape.
    const current = (await readJsonForUpdate<Record<string, unknown>>(file)) ?? {};
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
    await writeFile(file, `${JSON.stringify({ ...current, ...recorded }, null, 2)}\n`);
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
    return { dir: resolved, pathLabel: this.pathLabel(resolved), candidates, suggested, starter, nested };
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
    const meta = await readJsonIfExists<{ versionNested?: unknown }>(path.join(dir, "studio.json")).catch(() => null);
    return meta?.versionNested === true;
  }

  /** Record that consent, once, in the game's own studio.json — nothing but adoption writes it. */
  async #recordConsent(dir: string): Promise<void> {
    const file = path.join(dir, "studio.json");
    const current = (await readJsonForUpdate<Record<string, unknown>>(file)) ?? {};
    if (current.versionNested === true) return;
    await writeFile(file, `${JSON.stringify({ ...current, versionNested: true }, null, 2)}\n`);
  }

  async #ensurePlayable(dir: string, name: string, title: string, options: AdoptOptions = {}): Promise<void> {
    // A folder that already has a game of its own shape keeps its entry: the template's
    // index.html and src/main.js would only sit beside the real ones as dead scaffold. The
    // studio's contract module and helpers are still added — the game imports what it needs —
    // and its rules are written for the game that is actually here, not for an empty project.
    const shape = await readProjectShape(dir);
    const own = isBuiltShape(shape);
    // Adoption updates studio.json below; one it cannot parse stops it here, before any write.
    if (own || options.versionNested) await readJsonForUpdate(path.join(dir, "studio.json"));
    await this.#writeTemplate(dir, { title, name, overwrite: false, keep: [...templateKeep(shape, options)] });
    if (own) {
      await this.#writeOwnPages(dir, title, shape);
      await this.#recordShape(dir, shape);
    }
    if (options.versionNested) await this.#recordConsent(dir);
  }

  /**
   * The two pages a game of its own gets instead of the template's: rules that describe *this*
   * game (its entry, its build, its screen and input kept as they are) and a notes file seeded
   * from whatever the folder already says about itself. Neither is ever overwritten — a
   * project that came with a CLAUDE.md or a NOTES.md keeps the one its author wrote.
   */
  async #writeOwnPages(dir: string, title: string, shape: ProjectShape): Promise<void> {
    const claude = path.join(dir, "CLAUDE.md");
    if (!(await pathExists(claude))) {
      const template = await readFile(path.join(this.templateDir, "CLAUDE.own.md"), "utf8").catch(() => null);
      if (template !== null) await writeFile(claude, ownRules(template, shape));
    }
    const notes = path.join(dir, "NOTES.md");
    if (!(await pathExists(notes))) {
      const template = await readFile(path.join(this.templateDir, "NOTES.own.md"), "utf8").catch(() => null);
      if (template !== null) await writeFile(notes, ownNotes(template, title, shape, await this.#folderReadme(dir)));
    }
  }

  /** What the folder already says about itself — the pitch nobody should have to write twice. */
  async #folderReadme(dir: string): Promise<{ file: string; text: string } | null> {
    for (const file of README_FILES) {
      const text = await readFile(path.join(dir, file), "utf8").catch(() => null);
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
    const writes = await this.#missingTemplateFiles(dir, templateKeep(shape, options));
    // A game of its own is held out of the template's pages above and given its own two.
    if (isBuiltShape(shape)) {
      for (const file of OWN_PAGES) {
        if (!(await pathExists(path.join(dir, file)))) writes.push(file);
      }
    }
    if (await this.#writesStudioJson(dir, shape, options)) writes.push("studio.json");
    const ignored = await readFile(path.join(dir, ".gitignore"), "utf8").catch(() => null);
    if (missingIgnoreRules(ignored).length > 0) writes.push(".gitignore");
    // Version history is what makes a run undoable; an existing repository is left alone.
    if (!(await pathExists(path.join(dir, ".git")))) writes.push(".git");
    return writes;
  }

  /** The template files `dir` lacks, in the template's sorted order, leaving out `keep`. */
  async #missingTemplateFiles(dir: string, keep: Set<string>): Promise<string[]> {
    const writes: string[] = [];
    const walk = async (from: string, rel: string): Promise<void> => {
      const entries = (await readdir(from, { withFileTypes: true }).catch(() => [])).sort((a, b) =>
        a.name < b.name ? -1 : 1,
      );
      for (const entry of entries) {
        const relative = rel ? `${rel}/${entry.name}` : entry.name;
        if (keep.has(relative)) continue;
        if (entry.isDirectory()) await walk(path.join(from, entry.name), relative);
        else if (!(await pathExists(path.join(dir, relative)))) writes.push(relative);
      }
    };
    await walk(this.templateDir, "");
    return writes;
  }

  /**
   * studio.json is written when it is missing — and again when a game of its own has no shape
   * recorded yet (#recordShape merges entry/main/build/… into whatever is already there).
   * …and again when this row's button is the nested-repository consent, which is written into
   * the same file (`#recordConsent`). An edit to a file that is there is still a promise —
   * that is why `.gitignore` is on the list — and the consent must not be the one exception.
   */
  async #writesStudioJson(dir: string, shape: ProjectShape, options: AdoptOptions): Promise<boolean> {
    const meta = await readJsonIfExists<{ entry?: unknown; main?: unknown; build?: unknown }>(
      path.join(dir, "studio.json"),
    ).catch(() => null);
    const recorded = recordsShape(meta);
    const consenting = options.versionNested === true && !(await this.nestedConsent(dir));
    if (!(await pathExists(path.join(dir, "studio.json")))) return true;
    return (isBuiltShape(shape) && !recorded) || consenting;
  }

  async #writeTemplate(
    dir: string,
    options: { title: string; name: string; overwrite: boolean; keep?: string[] },
  ): Promise<void> {
    await ensureDir(dir);
    if (options.overwrite) {
      // The own-shape pages are sources, not project files: a fresh template game gets the
      // template's CLAUDE.md and NOTES.md, never the pair they would be rewritten from.
      await cp(this.templateDir, dir, {
        recursive: true,
        filter: (source) => !(TEMPLATE_SOURCES as readonly string[]).includes(path.relative(this.templateDir, source)),
      });
    } else {
      await mergeCopy(this.templateDir, dir, new Set(options.keep ?? []));
    }
    await fillTemplateTitle(dir, options.title);

    const studioPath = path.join(dir, "studio.json");
    if (options.overwrite || !(await pathExists(studioPath))) {
      const createdAt = new Date().toISOString();
      await writeFile(
        studioPath,
        `${JSON.stringify({ name: options.name, title: options.title, createdAt, contractVersion: 1 }, null, 2)}\n`,
      );
    }

    // Before the repository exists (`ensureRepo` below), so the first commit never sweeps in
    // what the rules exclude: the harness's own scratch, a fork's linked packages, build output,
    // secrets (see IGNORE_RULES). An existing file is topped up, never rewritten: the rules the
    // user has are theirs.
    await ensureIgnoreRules(dir, GITIGNORE_HEADER);

    const references = path.join(dir, "references");
    await ensureDir(references);
    const readme = path.join(references, "README.md");
    if (!(await pathExists(readme))) await writeFile(readme, REFERENCES_README);

    await ensureRepo(dir);
  }

  /**
   * Static check run before every judged build. It catches the two failures that would otherwise
   * waste a whole gauntlet iteration: a missing entry point, and a game that abandoned the
   * contract (hard-coded `Math.random`, no `window.__studio`).
   */
  async validate(name: string): Promise<Pick<GameValidation, "ok" | "problems" | "warnings" | "contract">> {
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
    const shape = await detectProjectShape(dir);
    const config = await readJsonIfExists<{ exportFiles?: string[] }>(path.join(dir, "studio.json"));
    if (builtOutput) return exportPublicGame(builtOutput, targetDir, await readdir(builtOutput), undefined, options);
    if (shape?.build) throw new Error(MESSAGE.BuildBeforeExport);
    if (shape && !config?.exportFiles) throw new Error(MESSAGE.DeclareExportFiles);
    const roots = config?.exportFiles ?? (await defaultExportRoots(dir));
    if (!isExportList(roots)) throw new Error(MESSAGE.BadExportFiles);
    return exportPublicGame(dir, targetDir, roots, shape ? undefined : this.vendorDir, options);
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

/** Fill the title into the template files that carry its placeholder. */
async function fillTemplateTitle(dir: string, title: string): Promise<void> {
  for (const file of TITLED_TEMPLATE_FILES) {
    const target = path.join(dir, file);
    const text = await readFile(target, "utf8").catch(() => null);
    if (text?.includes("__GAME_TITLE__")) {
      await writeFile(target, text.replaceAll("__GAME_TITLE__", title));
    }
  }
}

async function mergeCopy(from: string, to: string, keep: Set<string> = new Set(), rel = ""): Promise<void> {
  await ensureDir(to);
  const entries = await readdir(from, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    const relative = rel ? `${rel}/${entry.name}` : entry.name;
    // `keep`: template files a folder with its own game must never receive.
    if (keep.has(relative)) continue;
    if (entry.isDirectory()) await mergeCopy(src, dest, keep, relative);
    else if (!(await pathExists(dest))) await cp(src, dest);
  }
}
