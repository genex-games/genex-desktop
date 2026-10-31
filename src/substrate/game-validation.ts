/**
 * The static check of a game folder: does the page exist, and does what it loads run in a browser
 * as written. Read-only: nothing here writes into the game folder.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ContractWord, type ProjectShape } from "../shared/game-project.ts";
import { pathExists } from "./fsx.ts";
import {
  type ContractReach,
  importMapKeys,
  INSERTED_MAP_SPECIFIERS,
  isRemoteSrc,
  moduleSpecifiers,
  pageScripts,
  projectRelative,
  resolvedByMap,
  threeReach,
} from "./game-page.ts";
import { isInside, toPosixRelative } from "./paths.ts";
import { readProjectShape } from "./project-shape.ts";

/** The most modules the reachable-source walk opens; a larger game is checked on its first ones. */
const MAX_REACHABLE_SOURCES = 400;
/** How many unresolved package names the problem names before it stops listing. */
const LISTED_UNRESOLVED_IMPORTS = 3;
/** The extensions a bundler would try on a specifier written without one, in its order. */
const MODULE_EXTENSIONS = [".js", ".mjs", ".ts", ".tsx", ".jsx"];

const MESSAGE = {
  MissingFile: (file: string) => `${file} is missing`,
  UnresolvedPackages: (main: string, names: string[]) =>
    `${main} imports ${names
      .slice(0, LISTED_UNRESOLVED_IMPORTS)
      .map((name) => `"${name}"`)
      .join(
        ", ",
      )} as packages, and nothing here resolves them — this game needs a build command (studio.json "build") or an import map`,
  TypescriptUnbuilt: (file: string) =>
    `${file} is TypeScript and nothing here builds it — a browser cannot run it as written; this game needs a build command (studio.json "build")`,
} as const;

/** What `validateGameDir` found: the problems that stop the page running, the warnings, and whether the studio's hook reaches it. */
export interface GameValidation {
  ok: boolean;
  problems: string[];
  /** The files a web page needs that are not there, by name; `problems` says the same in sentences. */
  missing: string[];
  warnings: string[];
  contract: ContractWord;
  reach: ContractReach;
  shape: ProjectShape;
}

/**
 * A browser runs JavaScript. Inserting an import map does not make TypeScript run in Chromium,
 * so a folder whose reachable sources are `.ts` is not attachable however its three resolves —
 * telling a run the page attaches and then judging a blank screen is the failure this whole
 * milestone exists to remove.
 */
function nonExecutableSource(sources: string[]): string | null {
  return sources.find((file) => /\.(ts|tsx|jsx)$/.test(file)) ?? null;
}

/**
 * A dev-only game (Vite with no build script) is served exactly as written, and the browser
 * has no bundler: `import … from "three"` simply fails and the stage goes black. Say so here
 * rather than let a run be judged on a page that never ran. The exception is what the
 * studio's own inserted map answers: a page with no map of its own gets the five vendored
 * keys from the serve layer, so `three` there is resolved, not missing.
 */
function unresolvedImportsProblem(shape: ProjectShape, mapped: string[], unresolved: string[]): string | null {
  const unresolvedHere =
    mapped.length === 0 ? unresolved.filter((name) => !resolvedByMap(INSERTED_MAP_SPECIFIERS, name)) : unresolved;
  const servedAsWritten = shape.own && !shape.build;
  if (!servedAsWritten || unresolvedHere.length === 0) return null;
  return MESSAGE.UnresolvedPackages(shape.main, unresolvedHere);
}

/**
 * Whether the studio's hook reaches the page: the serve layer points the page's own `three` at the
 * studio's wrapper, which counts what the game draws (M4.2a). Informational only — a page the hook
 * does not reach (a canvas, the DOM, a bundle) runs and is photographed all the same. A TypeScript
 * entry with no build is `missing`: a browser cannot run it.
 */
function contractWord(reach: ContractReach, nonExecutable: string | null): ContractWord {
  if (reach !== "none" && !nonExecutable) return ContractWord.Attached;
  return ContractWord.Missing;
}

/**
 * Static check of a game folder: a missing entry point, packages nothing resolves, TypeScript
 * nothing builds. A game owes the studio nothing else.
 */
export async function validateGameDir(dir: string): Promise<GameValidation> {
  const shape = await readProjectShape(dir);
  const indexExists = await pathExists(path.join(dir, "index.html"));
  const missing: string[] = [];
  if (!indexExists) missing.push("index.html");
  if (!(await pathExists(path.join(dir, shape.main)))) missing.push(shape.main);
  const problems = missing.map((file) => MESSAGE.MissingFile(file));

  // Only what the page actually loads: a template `src/main.js` left beside a Godot export or a
  // Vite game is not the game.
  const { files: sources, unresolved } = await reachableSources(dir, shape);
  const html = (await readFile(path.join(dir, "index.html"), "utf8").catch(() => "")) ?? "";
  const mapped = importMapKeys(html);
  // No page, nothing to compose: the serve layer rewrites the page it serves, and there is none.
  const reach: ContractReach = indexExists ? threeReach({ html, build: shape.build, mapped, unresolved }) : "none";
  const unresolvedProblem = unresolvedImportsProblem(shape, mapped, unresolved);
  if (unresolvedProblem) problems.push(unresolvedProblem);

  // A build turns TypeScript into what the browser runs; without one the browser gets it as written.
  const nonExecutable = shape.build === null ? nonExecutableSource(sources) : null;
  if (nonExecutable) problems.push(MESSAGE.TypescriptUnbuilt(toPosixRelative(path.relative(dir, nonExecutable))));
  const contract = contractWord(reach, nonExecutable);
  return { ok: problems.length === 0, problems, missing, warnings: [], contract, reach, shape };
}

/** The reachable-source walk's state: what it found, what it still has to open, and what it has seen. */
interface SourceWalk {
  dir: string;
  files: string[];
  unresolved: Set<string>;
  queue: string[];
  /** Queue a project-relative path, once, and only when it stays inside the folder. */
  enqueue: (rel: string) => void;
}

function sourceWalk(dir: string): SourceWalk {
  const seen = new Set<string>();
  const walk: SourceWalk = {
    dir,
    files: [],
    unresolved: new Set(),
    queue: [],
    enqueue: (rel) => {
      const full = path.resolve(dir, rel);
      if (!isInside(dir, full) || seen.has(full)) return;
      seen.add(full);
      walk.queue.push(full);
    },
  };
  return walk;
}

/**
 * One specifier a module imports: a project path is walked next, a bare name either resolves
 * through the page's own map or is recorded as unresolved, and a remote URL is not the folder's.
 */
function followSpecifier(walk: SourceWalk, from: string, specifier: string, mapped: string[]): void {
  if (isRemoteSrc(specifier)) return;
  if (specifier.startsWith("/")) {
    walk.enqueue(projectRelative(specifier));
    return;
  }
  if (specifier.startsWith(".")) {
    walk.enqueue(toPosixRelative(path.relative(walk.dir, path.resolve(path.dirname(from), specifier))));
    return;
  }
  if (!resolvedByMap(mapped, specifier)) walk.unresolved.add(specifier);
}

/**
 * The files the served page really runs: every local `<script src>` on `index.html`, then
 * everything those modules import, transitively. `index.html` is the source page even for a
 * bundled game — Vite builds *from* it — so the walk works before any build has run.
 *
 * Bare specifiers (`three`, `phaser`) belong to the import map or the bundler, not to the
 * folder, and stop the walk; so does anything outside the project. The bare ones nothing
 * resolves come back too — a browser cannot load them, so they decide whether the game can be
 * served as written at all.
 */
async function reachableSources(dir: string, shape: ProjectShape): Promise<{ files: string[]; unresolved: string[] }> {
  const walk = sourceWalk(dir);
  const html = await readFile(path.join(dir, "index.html"), "utf8").catch(() => null);
  for (const src of html === null ? [] : pageScripts(html)) {
    if (!isRemoteSrc(src)) walk.enqueue(projectRelative(src));
  }
  // A page the studio cannot read still has a recorded entry — judge that rather than nothing.
  if (walk.queue.length === 0) walk.enqueue(shape.main);
  const mapped = html === null ? [] : importMapKeys(html);

  while (walk.files.length < MAX_REACHABLE_SOURCES) {
    const file = walk.queue.shift();
    if (file === undefined) break;
    const resolved = await resolveModule(file);
    if (!resolved) continue;
    walk.files.push(resolved);
    const text = await readFile(resolved, "utf8").catch(() => "");
    for (const specifier of moduleSpecifiers(text)) followSpecifier(walk, resolved, specifier, mapped);
  }
  return { files: walk.files, unresolved: [...walk.unresolved] };
}

/** A specifier without an extension is a file with one — the resolution a bundler would do. */
async function resolveModule(file: string): Promise<string | null> {
  // .html because a page may run an inline module and import from there.
  if (/\.(js|mjs|ts|tsx|jsx|html)$/.test(file) && (await pathExists(file))) return file;
  for (const candidate of [file, `${file}/index`]) {
    for (const ext of MODULE_EXTENSIONS) {
      if (await pathExists(`${candidate}${ext}`)) return `${candidate}${ext}`;
    }
  }
  // `import "./game.js"` in a TypeScript project means game.ts — the compiler's own rule.
  const swapped = file.replace(/\.js$/, ".ts");
  if (swapped !== file && (await pathExists(swapped))) return swapped;
  return null;
}
