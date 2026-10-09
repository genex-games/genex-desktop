/**
 * Building a game that builds itself — outside the user's folder, and only when something changed.
 *
 * Three things were wrong with running `npm run build` in place on every look:
 * the user's own `dist/` was overwritten by the studio on every Reload, checkpoint and health
 * check; the build ran again for a tree nobody had touched; and when it failed the stage went
 * black with the reason reaching only the game console.
 *
 * So a game the user owns is built in a **shadow**: a mirror of its source under the app's own
 * scratch, its output kept beside it. The mirror is the folder's tracked files plus whatever is
 * modified, untracked-but-not-ignored, or an `.env` — git already knows exactly which files are
 * the game and which 1.6 GB of screenshots are not. A worktree under the app's scratch is
 * already ours, so it is built where it stands.
 *
 * The last output that worked is kept, because "your last build" is a better thing to look at
 * than a black rectangle — but only the *live* stage may fall back to it. A judge scoring a
 * stale build would be scoring a lie, which is why {@link servedAfterBuild} takes the decision
 * away from the caller's memory and puts it in one testable rule.
 */
import { constants } from "node:fs";
import { cp, mkdir, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ensureDir, pathExists } from "../substrate/fsx.ts";
import { HOST_GIT_CONFIG } from "../substrate/snapshots.ts";
import { packageCommandsIn } from "../substrate/toolchain.ts";
import type { ProjectShape } from "../substrate/game-workspace.ts";
import { type RunRequest, type RunResult, shellQuote } from "../substrate/spawn.ts";
import type { BuildProblem, InstallResult } from "../shared/build-problem.ts";
import { MINUTE_MS } from "../shared/duration.ts";
import { GENEX_GAME_PACKAGES, isGenexGamePackage } from "../shared/genex.ts";
import { UNITY_EDITOR_REQUIRED } from "../shared/unity.ts";

const execFileAsync = promisify(execFile);

/** How long a game's own build may run. */
const BUILD_TIMEOUT_MS = 5 * MINUTE_MS;
/** How long a package install may run. */
const INSTALL_TIMEOUT_MS = 10 * MINUTE_MS;
/** How many files a folder that is not a repository contributes to its key and its mirror. */
const UNINDEXED_FILE_LIMIT = 4_000;
/** How deep the walk of a folder that is not a repository goes. */
const UNINDEXED_MAX_DEPTH = 8;
/** The most output a read-only git command may print. */
const GIT_MAX_BUFFER = 32 * 1024 * 1024;

/** Whether a path is the shape's output folder (or inside it), which is never part of the source. */
function isServedOutput(rel: string, serve: string | null): boolean {
  return Boolean(serve) && (rel === serve || rel.startsWith(`${serve}/`));
}

/**
 * The npm registry: opened only for an install the user pressed a button for, or a Genex package
 * install the user approved.
 */
export const REGISTRY_DOMAIN = "registry.npmjs.org";

const MESSAGE = {
  UnknownPackage: (name: string) =>
    `${name || "nothing"} is not a package Studio adds: only ${Object.keys(GENEX_GAME_PACKAGES).join(" and ")}`,
  NoPackageJson: "this game has no package.json, so it has no package manager to add packages with",
} as const;

export interface BuildSource {
  project: string;
  /** Where the sources are: the game folder, or a worktree the app made. */
  dir: string;
  shape: ProjectShape;
}

export interface BuildOutcome {
  ok: boolean;
  /** The folder holding the page to serve, when the build succeeded. */
  output: string | null;
  /** The newest output that did work — what the live stage may show while the build is broken. */
  lastGood: string | null;
  problem: BuildProblem | null;
  /** The build command actually ran. False means memoised, or the game needs no build. */
  ran: boolean;
}

/**
 * What a port should be given after a build. The live stage may show the last build that
 * worked; a judged load may not — it would score a page the run never produced.
 */
export function servedAfterBuild(
  outcome: BuildOutcome,
  options: { fallback: boolean },
): { dir: string; stale: boolean } | null {
  if (outcome.ok && outcome.output) return { dir: outcome.output, stale: false };
  if (!options.fallback || !outcome.lastGood) return null;
  return { dir: outcome.lastGood, stale: true };
}

/** The sentence the game console and the agent loop get; the stage gets the payload instead. */
export function buildFailureNote(problem: BuildProblem): string {
  return `the game's build failed (${problem.command}, exit ${problem.code}):\n${problem.lines.join("\n")}`;
}

/** Files that are never part of a build, however big the folder is. */
const NEVER_MIRRORED = new Set([".git", "node_modules", ".studio"]);

/** Where one build runs, where its output is served from, and the last output that worked. */
interface BuildPlace {
  inPlace: boolean;
  work: string;
  output: string;
  lastGood: string | null;
}

/**
 * Where a build's output is served from. A build that writes an output folder gets its own
 * `last/` beside the mirror; one that rewrites its sources in place has nowhere separate to
 * keep, so the mirror is the output.
 */
function buildOutput(p: { inPlace: boolean; dir: string; shadow: string; work: string; serve: string | null }): string {
  if (p.inPlace) return path.join(p.dir, p.serve ?? ".");
  return p.serve ? path.join(p.shadow, "last") : p.work;
}

interface Built {
  key: string;
  ok: boolean;
  output: string;
  problem: BuildProblem | null;
}

export class GameBuilds {
  readonly root: string;
  readonly #run: (request: RunRequest) => Promise<RunResult>;
  /** Whether a folder is the app's own scratch — those are built where they stand. */
  readonly #ours: (dir: string) => boolean;
  /** What each source directory last produced, so an unchanged tree is not built twice. */
  readonly #built = new Map<string, Built>();
  /** The build already running for a source, so two looks at one folder are one build. */
  readonly #inFlight = new Map<string, Promise<BuildOutcome>>();

  constructor(options: {
    root: string;
    run: (request: RunRequest) => Promise<RunResult>;
    ours?: (dir: string) => boolean;
  }) {
    this.root = options.root;
    this.#run = options.run;
    this.#ours = options.ours ?? (() => false);
  }

  /** Forget a source's memo — after an install, or when a folder is closed. */
  forget(dir: string): void {
    this.#built.delete(path.resolve(dir));
  }

  /**
   * Build `source` if it needs building and its tree has changed since the last time, and say
   * where the page to serve now lives.
   *
   * One build per folder at a time. A checkpoint's auto-reload and a click in the sidebar both
   * reach here for the live game, and the second `rm -rf`s the mirror under the first `npm run
   * build` — which then fails on vanished sources and memoises "Your game didn't build" for a
   * tree that builds fine. Whoever arrives second waits for the answer the first is getting.
   */
  async ensure(source: BuildSource): Promise<BuildOutcome> {
    if (source.shape.kind === "unity") throw new Error(UNITY_EDITOR_REQUIRED);
    const dir = path.resolve(source.dir);
    const running = this.#inFlight.get(dir);
    if (running) return await running;
    const started = this.#ensure(source, dir);
    this.#inFlight.set(dir, started);
    try {
      return await started;
    } finally {
      this.#inFlight.delete(dir);
    }
  }

  async #ensure(source: BuildSource, dir: string): Promise<BuildOutcome> {
    const serve = source.shape.serve && source.shape.serve !== "." ? source.shape.serve : null;
    // No build: the folder is served as written, from its own output folder when the shape names
    // one. This is the `build: null` + `entry: "dist/index.html"` case — served from the project
    // root, every `/assets/…` in the built page 404s and the frame is black.
    if (!source.shape.build) {
      return { ok: true, output: serve ? path.join(dir, serve) : dir, lastGood: null, problem: null, ran: false };
    }

    const place = await this.#placeBuild(source.project, dir, serve);
    const { inPlace, work, output, lastGood } = place;
    const key = await treeKey(dir, serve);
    const memoised = await this.#memoised(dir, key, lastGood);
    if (memoised) return memoised;

    if (!inPlace) await this.#mirror(dir, work, serve);
    const result = await this.#run({
      command: source.shape.build,
      cwd: work,
      timeoutMs: BUILD_TIMEOUT_MS,
      label: `build:${source.project}`,
      env: this.#cacheEnv(),
    });
    if (result.code !== 0) {
      return this.#broken(dir, key, output, lastGood, await this.#problem(source, result));
    }
    // The fresh output is kept apart from the mirror: a later build that empties its outDir
    // before failing must not take the last good build down with it.
    if (!inPlace && serve !== null) {
      const failure = await this.#keepOutput(path.join(work, serve), output, serve);
      if (failure) return this.#broken(dir, key, output, lastGood, await this.#problem(source, result, failure));
    }
    this.#built.set(dir, { key, ok: true, output, problem: null });
    return { ok: true, output, lastGood: output, problem: null, ran: true };
  }

  /** Where a build runs and where its output is served from, and the last output that worked. */
  async #placeBuild(project: string, dir: string, serve: string | null): Promise<BuildPlace> {
    const inPlace = this.#ours(dir);
    const shadow = this.#shadow(project, dir);
    const work = inPlace ? dir : path.join(shadow, "work");
    const output = buildOutput({ inPlace, dir, shadow, work, serve });
    // A shadow whose output *is* the mirror keeps no previous build: `#mirror` empties it and
    // re-copies the sources before every build, so what is there at failure time is source code,
    // not "your last build". Offering it would put un-bundled sources on the stage under a
    // sentence promising the opposite.
    const keepsLast = inPlace || output !== work;
    const lastGood = keepsLast && (await pathExists(path.join(output, "index.html"))) ? output : null;
    return { inPlace, work, output, lastGood };
  }

  /**
   * Nothing changed since the last look, so neither did the answer — including a failure.
   * A broken build was re-run (and re-waited-for) on every reload and every health check.
   */
  async #memoised(dir: string, key: string, lastGood: string | null): Promise<BuildOutcome | null> {
    const memo = this.#built.get(dir);
    if (memo?.key !== key) return null;
    if (memo.ok && (await pathExists(path.join(memo.output, "index.html")))) {
      return { ok: true, output: memo.output, lastGood, problem: null, ran: false };
    }
    if (memo.ok || !memo.problem) return null;
    return {
      ok: false,
      output: null,
      lastGood,
      problem: { ...memo.problem, showingLastBuild: lastGood !== null },
      ran: false,
    };
  }

  /**
   * Copy a shadow build's output to where it is served; the failure's sentence, or null.
   *
   * Where the output lands is a guess: `outputDir` reads a vite config and otherwise answers
   * "dist". A webpack or CRA game writes `build/`, and a `build` script that only runs `tsc`
   * writes nothing at all — copying blind threw a raw ENOENT with a shadow path in it, out of
   * `preview.load`, past every sentence the stage knows how to say, and memoised nothing, so
   * the whole build ran again on the next look.
   */
  async #keepOutput(produced: string, output: string, serve: string): Promise<string | null> {
    if (!(await pathExists(produced))) return `the build finished but wrote nothing to ${serve}/`;
    try {
      await rm(output, { recursive: true, force: true });
      await cp(produced, output, { recursive: true, force: true, mode: constants.COPYFILE_FICLONE });
      return null;
    } catch {
      // No path in the sentence: where the studio keeps its shadow is not the user's business,
      // and a raw ENOENT with one in it was exactly what the stage used to show.
      return "the build finished but its output could not be kept";
    }
  }

  /** Memoise a failure and answer with it — a build that wrote nothing counts as one. */
  #broken(dir: string, key: string, output: string, lastGood: string | null, problem: BuildProblem): BuildOutcome {
    this.#built.set(dir, { key, ok: false, output, problem });
    return {
      ok: false,
      output: null,
      lastGood,
      problem: { ...problem, showingLastBuild: lastGood !== null },
      ran: true,
    };
  }

  /**
   * Install the game's dependencies, in the user's own folder, because that is where
   * node_modules belongs and where their own `npm install` would have put it. The one place the
   * studio opens the network — behind a button the user pressed, for this command only.
   *
   * "This command" is the package manager's own install, read off the folder's lockfile, never
   * the string `studio.json` happens to record: that file ships with a downloaded game and a
   * contractor can rewrite it mid-run, and the one exemption the studio ever grants must not
   * be lent to `npm install && curl … | sh`. `readProjectShape` refuses the same string, so the
   * sheet and the button still name the command that runs.
   */
  async install(source: BuildSource): Promise<InstallResult> {
    if (!source.shape.install) return { ok: false, lines: ["this game declares no packages to install"] };
    const dir = path.resolve(source.dir);
    const command = (await packageCommandsIn(dir)).install;
    const result = await this.#run({
      command,
      cwd: dir,
      timeoutMs: INSTALL_TIMEOUT_MS,
      label: `install:${source.project}`,
      policy: { allowedDomains: [REGISTRY_DOMAIN] },
      env: this.#cacheEnv(),
    });
    this.forget(source.dir);
    return { ok: result.code === 0, lines: outputLines(result, result.code === 0 ? 3 : 6) };
  }

  /**
   * Add Genex SDK packages to the game at the versions Studio pins, with the manager its lockfile
   * names, in its own folder. The second consented registry opening beside {@link install}: the
   * user approved this one install (`genex__package`), and the command is Studio's, never the
   * agent's. Only a key of {@link GENEX_GAME_PACKAGES}; the version always comes from that table.
   * A game without package.json (Studio's template, with its import maps) is refused.
   */
  async addPackages(source: Pick<BuildSource, "project" | "dir">, names: readonly string[]): Promise<InstallResult> {
    const packages = names.filter(isGenexGamePackage);
    const unknown = names.find((name) => !isGenexGamePackage(name));
    if (unknown !== undefined || !packages.length) return { ok: false, lines: [MESSAGE.UnknownPackage(unknown ?? "")] };
    const dir = path.resolve(source.dir);
    const manifest = await stat(path.join(dir, "package.json")).catch(() => null);
    if (!manifest?.isFile()) return { ok: false, lines: [MESSAGE.NoPackageJson] };
    const pinned = packages.map((name) => shellQuote(`${name}@${GENEX_GAME_PACKAGES[name]}`));
    const result = await this.#run({
      command: `${(await packageCommandsIn(dir)).add} ${pinned.join(" ")}`,
      cwd: dir,
      timeoutMs: INSTALL_TIMEOUT_MS,
      label: `add-packages:${source.project}`,
      policy: { allowedDomains: [REGISTRY_DOMAIN] },
      env: this.#cacheEnv(),
    });
    this.forget(source.dir);
    return { ok: result.code === 0, lines: outputLines(result, result.code === 0 ? 3 : 6) };
  }

  /**
   * Package managers keep their cache and their crash logs in `$HOME` (`~/.npm`), which no
   * agent process may write. Point them at the studio's own scratch instead, or the first thing
   * an install does is fail on a directory it was never allowed to make.
   */
  #cacheEnv(): Record<string, string> {
    const cache = path.join(this.root, "package-cache");
    return { npm_config_cache: cache, YARN_CACHE_FOLDER: cache, PNPM_STORE_DIR: cache, BUN_INSTALL_CACHE: cache };
  }

  /** One shadow per source folder: six worktrees of one game must not share an output. */
  #shadow(project: string, dir: string): string {
    const key = createHash("sha256").update(dir).digest("hex").slice(0, 12);
    return path.join(this.root, `${project}-${key}`);
  }

  async #problem(source: BuildSource, result: RunResult, note?: string): Promise<BuildProblem> {
    const declared = source.shape.install !== null;
    return {
      project: source.project,
      command: source.shape.build ?? "",
      code: result.code,
      lines: [...(note ? [note] : []), ...outputLines(result, note ? 2 : 3)],
      needsInstall: declared && !(await pathExists(path.join(source.dir, "node_modules"))),
      install: source.shape.install,
      showingLastBuild: false,
      at: new Date().toISOString(),
    };
  }

  /**
   * Copy the game's sources into the shadow. Only the files git calls the project — tracked,
   * modified, untracked-but-not-ignored — plus `.env*`, which is gitignored by design and is
   * exactly what a build reads. `progress/` (11 522 screenshots, 1.6 GB) is ignored, so it never
   * moves; on APFS the rest is cloned, not copied, so it costs no space at all.
   */
  async #mirror(source: string, work: string, serve: string | null): Promise<void> {
    await rm(work, { recursive: true, force: true });
    await ensureDir(work);
    const files = await mirrorList(source, serve);
    for (const rel of files) {
      const from = path.join(source, rel);
      const to = path.join(work, rel);
      await mkdir(path.dirname(to), { recursive: true });
      await cp(from, to, { recursive: true, force: true, mode: constants.COPYFILE_FICLONE }).catch(() => {});
    }
    // node_modules is linked, never copied: hundreds of megabytes the build only reads. Each
    // shadow keeps its own dist, cache and tsbuildinfo, which is what the six-worktrees-through-
    // one-node_modules collision was really about.
    const modules = path.join(source, "node_modules");
    if (await pathExists(modules)) await symlink(modules, path.join(work, "node_modules"), "dir").catch(() => {});
    await writeFile(path.join(work, ".studio-shadow"), `${source}\n`).catch(() => {});
  }
}

/** The last lines a failed command printed — stderr first, because that is where the error is. */
export function outputLines(result: Pick<RunResult, "stdout" | "stderr">, max: number): string[] {
  const lines = `${result.stderr ?? ""}\n${result.stdout ?? ""}`
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  return lines.slice(0, max);
}

/**
 * What the tree is right now: the committed tree plus every dirty file's size and mtime. Two
 * looks a second apart at an untouched folder give the same key, and the build is skipped.
 */
export async function treeKey(dir: string, serve: string | null): Promise<string> {
  const hash = createHash("sha256");
  const tree = await gitOut(dir, ["rev-parse", "HEAD^{tree}"]);
  if (tree !== null) {
    hash.update(tree);
    const status = (await gitOut(dir, ["status", "--porcelain", "-uall"])) ?? "";
    for (const line of status.split("\n").filter(Boolean)) {
      const renamedTo = line.slice(3).split(" -> ").at(-1) ?? "";
      const rel = renamedTo.replace(/^"|"$/g, "");
      if (isServedOutput(rel, serve)) continue;
      hash.update(`${line}\n${await stamp(path.join(dir, rel))}`);
    }
    // `.env*` is gitignored by design, so `status` never mentions it — and changing it changes
    // the build. Stamp it by name.
    for (const name of (await readdir(dir).catch(() => [])).sort()) {
      if (name.startsWith(".env")) hash.update(`${name}\n${await stamp(path.join(dir, name))}`);
    }
    return hash.digest("hex");
  }
  // Not a repository: the files themselves, capped, so an unindexed folder still memoises.
  for (const rel of await walk(dir, serve, UNINDEXED_FILE_LIMIT))
    hash.update(`${rel}\n${await stamp(path.join(dir, rel))}`);
  return hash.digest("hex");
}

/** The files that make up the game, relative to `dir`. */
export async function mirrorList(dir: string, serve: string | null): Promise<string[]> {
  const listed = await gitOut(dir, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  if (listed === null) return [...new Set(await walk(dir, serve, UNINDEXED_FILE_LIMIT))];
  const out = new Set<string>();
  for (const rel of listed.split("\0").filter(Boolean)) {
    if (isServedOutput(rel, serve)) continue;
    if (NEVER_MIRRORED.has(rel.split("/")[0] ?? "")) continue;
    out.add(rel);
  }
  // Gitignored on purpose and read by every Vite build: a worker's build used the defaults
  // while the user's used their own values, and nobody could see why the two differed.
  for (const name of await readdir(dir).catch(() => [])) if (name.startsWith(".env")) out.add(name);
  return [...out];
}

async function walk(dir: string, serve: string | null, limit: number): Promise<string[]> {
  const out: string[] = [];
  await visitTree({ out, serve, limit }, dir, "", 0);
  return out.sort();
}

/** One walk of a folder that is not a repository: the files found, and what bounds it. */
interface TreeWalk {
  out: string[];
  serve: string | null;
  limit: number;
}

async function visitTree(walk: TreeWalk, current: string, rel: string, depth: number): Promise<void> {
  if (depth > UNINDEXED_MAX_DEPTH || walk.out.length >= walk.limit) return;
  for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    const excluded = NEVER_MIRRORED.has(entry.name) || (walk.serve !== null && child === walk.serve);
    if (excluded) continue;
    if (entry.isDirectory()) await visitTree(walk, path.join(current, entry.name), child, depth + 1);
    else if (walk.out.length < walk.limit) walk.out.push(child);
  }
}

async function stamp(file: string): Promise<string> {
  const info = await stat(file).catch(() => null);
  return info ? `${info.size}:${info.mtimeMs}` : "gone";
}

/** git, read-only, never throwing: a folder that is not a repository simply answers null. */
async function gitOut(dir: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", [...HOST_GIT_CONFIG, "-C", dir, ...args], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
      maxBuffer: GIT_MAX_BUFFER,
    });
    return stdout;
  } catch {
    return null;
  }
}
