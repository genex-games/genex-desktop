/**
 * `genex__package`: the bundled Genex plugin's consented install of one of its two SDK packages
 * into the game a call is bound to. The agent names the package; the version comes from
 * `GENEX_GAME_PACKAGES` and the command from the game's lockfile (`GameBuilds.addPackages`), and
 * the folder must be, by real path, the game's own or a Studio worktree git registers for it. A
 * game made from Studio's template has no package manager: its page maps Studio's copies instead
 * (`GENEX_STUDIO_IMPORTS`, built at the same pins), as it maps three.js, and nothing is downloaded.
 */
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { InstallResult } from "../../shared/build-problem.ts";
import { GENEX_GAME_PACKAGES, type GenexGamePackage, genexPackageSet, isGenexGamePackage } from "../../shared/genex.ts";
import { withGenexSdkImport } from "../../shared/genex-page.ts";
import type { PluginBinding } from "../../shared/plugins.ts";
import { atomicWriteText } from "../../substrate/fsx.ts";
import { isBelow } from "../../substrate/paths.ts";
import { detectProjectShape, TEMPLATE_SHAPE } from "../../substrate/project-shape.ts";
import { git } from "../../substrate/snapshots.ts";
import { GENEX_CLI_PROMPT } from "./genex-cli-prompts.ts";

/** A Godot game's project, where the Godot plugin makes it (`godot/`): it takes Genex's multiplayer itself. */
const GODOT_PROJECT = "godot/project.godot";
/** A Unity game's project, at the game's root or in `unity/`: it takes Genex's multiplayer itself. */
const UNITY_PROJECTS = ["ProjectSettings/ProjectVersion.txt", "unity/ProjectSettings/ProjectVersion.txt"];

const isFileAt = async (dir: string, file: string) =>
  (await lstat(path.join(dir, file)).catch(() => null))?.isFile() === true;

/** The refusal for a folder with no package.json and no template page: an engine game's own words, else npm's. */
async function noPackageRefusal(dir: string): Promise<string> {
  if (await isFileAt(dir, GODOT_PROJECT)) return GENEX_CLI_PROMPT.GodotGame;
  for (const file of UNITY_PROJECTS) if (await isFileAt(dir, file)) return GENEX_CLI_PROMPT.UnityGame;
  return GENEX_CLI_PROMPT.NoPackageJson;
}

const WORKTREE_LINE = "worktree ";

/** What an install needs from Studio. */
export interface GenexPackageDeps {
  /** `GameBuilds.addPackages`: the one command, with the registry opened for it alone. */
  addPackages: (source: { project: string; dir: string }, names: readonly string[]) => Promise<InstallResult>;
  /** The game's folder in the library; throws for a name that is not a game. */
  gameDir: (project: string) => string;
  /** Studio's scratch, where its worktrees of a game live. */
  scratch: string;
}

/** What the agent reads back after an install ran. */
export interface GenexPackageAnswer {
  package: string;
  version: string;
  ok: boolean;
  lines: string[];
}

/** The package a call names, checked against Studio's pins; anything else is refused. */
function genexPackageOf(args: Record<string, unknown>): GenexGamePackage {
  const name = args.package;
  if (isGenexGamePackage(name)) return name;
  throw new Error(GENEX_CLI_PROMPT.UnknownPackage(String(name), Object.keys(GENEX_GAME_PACKAGES)));
}

/**
 * A template game's page: a regular file (never a link) in a folder the template's own marks name.
 * Null for any other folder.
 */
async function templatePageOf(dir: string): Promise<string | null> {
  const page = path.join(dir, TEMPLATE_SHAPE.entry);
  const file = await lstat(page).catch(() => null);
  if (!file?.isFile()) return null;
  return (await detectProjectShape(dir)) === null ? page : null;
}

/**
 * Map Studio's copies of `name` (and what it needs) in a template game's page and load the connect
 * module; a page already doing all of it is left alone.
 */
async function mapStudioSdk(page: string, name: GenexGamePackage): Promise<void> {
  const html = await readFile(page, "utf8");
  const next = withGenexSdkImport(html, name);
  if (next === null) throw new Error(GENEX_CLI_PROMPT.TemplatePageUnreadable);
  if (next !== html) await atomicWriteText(page, next);
}

/** What the agent reads after Studio's copies were mapped in a template game's page. */
const MAPPED_LINES: Record<GenexGamePackage, readonly string[]> = {
  "@genex-ai/embed-sdk": GENEX_CLI_PROMPT.TemplateSdkMapped,
  "@genex-ai/multiplayer": GENEX_CLI_PROMPT.TemplateMultiplayerMapped,
};

/** What the consent card shows for a `genex__package` call: the package and the version Studio pins. */
export function genexPackageConsentArgs(args: Record<string, unknown>): { package: string; version: string } {
  const name = genexPackageOf(args);
  return {
    package: genexPackageSet(name).join(", "),
    version: genexPackageSet(name)
      .map((item) => GENEX_GAME_PACKAGES[item])
      .join(", "),
  };
}

/** Whether Genex packages can go into a game folder: it has a package.json, or it is a template game. */
export async function takesGenexPackages(dir: string): Promise<boolean> {
  const manifest = await stat(path.join(dir, "package.json")).catch(() => null);
  return manifest?.isFile() === true || (await templatePageOf(dir)) !== null;
}

/** Adds a pinned Genex SDK package to the game a call is bound to, and nowhere else. */
export class GenexPackageService {
  readonly #deps: GenexPackageDeps;
  constructor(deps: GenexPackageDeps) {
    this.#deps = deps;
  }

  /**
   * Check the package and the folder, then run the install, or map Studio's copies in a template
   * game's page; nothing runs or changes when either is refused.
   */
  async add(args: Record<string, unknown>, binding: PluginBinding): Promise<GenexPackageAnswer> {
    const name = genexPackageOf(args);
    const target = await this.#target(binding);
    const version = GENEX_GAME_PACKAGES[name];
    if (target.templatePage) {
      await mapStudioSdk(target.templatePage, name);
      return { package: name, version, ok: true, lines: [...MAPPED_LINES[name]] };
    }
    const result = await this.#deps.addPackages({ project: binding.project, dir: target.dir }, genexPackageSet(name));
    return { package: name, version, ...result };
  }

  /** Refuse unsupported or foreign folders before asking for installation approval. No process is started. */
  async preflight(args: Record<string, unknown>, binding: PluginBinding): Promise<string> {
    genexPackageOf(args);
    return (await this.#target(binding)).dir;
  }

  /**
   * The bound folder, and its page when it is a template game: one with a package.json installs,
   * a template game maps Studio's copies, anything else is refused.
   */
  async #target(binding: PluginBinding): Promise<{ dir: string; templatePage?: string }> {
    const dir = await this.#boundFolder(binding);
    const manifest = await stat(path.join(dir, "package.json")).catch(() => null);
    if (manifest?.isFile()) return { dir };
    const templatePage = await templatePageOf(dir);
    if (templatePage) return { dir, templatePage };
    throw new Error(await noPackageRefusal(dir));
  }

  /** The binding's folder by real path: the game's own, or a worktree of it under Studio's scratch. */
  async #boundFolder(binding: PluginBinding): Promise<string> {
    const game = await this.#gameFolder(binding.project);
    const real = await realpath(binding.directory).catch(() => null);
    if (real && game && (real === game || (await this.#isWorktreeOf(game, real)))) return real;
    throw new Error(GENEX_CLI_PROMPT.ForeignFolder);
  }

  async #gameFolder(project: string): Promise<string | null> {
    try {
      return await realpath(this.#deps.gameDir(project));
    } catch {
      return null;
    }
  }

  /** Whether git lists `dir` as a worktree of `game`, and it lies under Studio's scratch. */
  async #isWorktreeOf(game: string, dir: string): Promise<boolean> {
    const scratch = await realpath(this.#deps.scratch).catch(() => null);
    if (!scratch || !isBelow(scratch, dir)) return false;
    const listing = await git(game, ["worktree", "list", "--porcelain"]).catch(() => "");
    const worktrees = listing.split("\n").filter((line) => line.startsWith(WORKTREE_LINE));
    const real = await Promise.all(worktrees.map((line) => realpath(line.slice(WORKTREE_LINE.length)).catch(() => "")));
    return real.includes(dir);
  }
}
