/**
 * How a game folder runs: its entry, its build, the folder the preview serves and what kind of
 * game it is — recorded in studio.json, or read from the evidence in the folder itself — and
 * where people play it (its stack and destinations).
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { StudioPlatform } from "../shared/boot.ts";
import {
  ALL_BUILD_TARGETS,
  BUILD_TARGETS,
  BuildTarget,
  type CompiledStack,
  DEFAULT_DESTINATIONS,
  type GameCandidate,
  type GameDestinations,
  GameStack,
  isCompiledStack,
  isGameStack,
  ProjectKind,
  type ProjectShape,
  STACK_OF_KIND,
  STACK_TARGETS,
  stackOf,
} from "../shared/game-project.ts";
import { hostTarget, TargetRefusal } from "../shared/game-targets.ts";
import { pageLoadsGenexSdk } from "../shared/genex-page.ts";
import { CoreFact, FolderHolds, hasFact } from "../shared/project-facts.ts";
import { entryExists, isJsonObject, pathExists, readRegularFile } from "./fsx.ts";
import { isRemoteSrc, pageScripts, projectRelative } from "./game-page.ts";
import { detectFacts, STUDIO_JSON_MAX_BYTES } from "./project-facts.ts";
import { declaredBootMs } from "./preview-ready.ts";
import { isInstallCommand, packageCommands } from "./toolchain.ts";

const PROJECT_KINDS: readonly ProjectKind[] = Object.values(ProjectKind);

/** The most of a CMakeLists.txt or C++ source the studio reads; a larger one is not a file it judges. */
const MAX_NATIVE_SOURCE_BYTES = 4 * 1024 * 1024;

/** The most entries a studio.json `targets` list may hold before the studio ignores the whole list. */
const MAX_RECORDED_TARGETS = 16;

/** The most of a game's page or main entry read to tell what it is; a single-file game inlines its assets. */
const MAX_PAGE_BYTES = 64 * 1024 * 1024;
/** The most of a package.json or bundler config read to tell how a game builds. */
const MAX_CONFIG_BYTES = 4 * 1024 * 1024;

/** What the person reads when studio.json names destinations the studio ignores. */
const MESSAGE = {
  UnknownStack: "studio.json names a stack the studio does not know; the game's files decide its stack instead",
  TargetsNotAList: "studio.json's targets is not a short list of destinations, so the studio ignores it",
  UnknownTargets: (count: number) =>
    count === 1
      ? "studio.json lists a destination the studio does not know; it is ignored"
      : `studio.json lists ${count} destinations the studio does not know; they are ignored`,
  BrowserOnly: "a Three.js game plays in the browser only, so studio.json's desktop destinations are ignored",
  StudioJsonIgnored:
    "studio.json is not a plain file the studio can read (a link, a pipe, a folder or too large), so it is ignored",
} as const;

/** A game's studio.json as read: its object (null when absent or not one), and why it was ignored, if it was. */
export interface StudioJsonReading {
  meta: Record<string, unknown> | null;
  /** Set when something other than a plain, small file sits at studio.json's name. */
  warning: string | null;
}

/**
 * A game's studio.json, which any agent process can write: never through a link, never blocking on
 * a FIFO, never past {@link STUDIO_JSON_MAX_BYTES}. A link, FIFO, folder or oversize file reads as
 * absent with a warning; a file that does not parse reads as absent, as it always has.
 */
export async function readStudioJson(dir: string): Promise<StudioJsonReading> {
  let bytes: Buffer;
  try {
    bytes = await readRegularFile(path.join(dir, "studio.json"), STUDIO_JSON_MAX_BYTES);
  } catch (error) {
    const absent = (error as NodeJS.ErrnoException).code === "ENOENT";
    return { meta: null, warning: absent ? null : MESSAGE.StudioJsonIgnored };
  }
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    return { meta: isJsonObject(value) ? value : null, warning: null };
  } catch {
    return { meta: null, warning: null };
  }
}

/**
 * A text file of the game read to tell what it is or what it loads (its page, main entry, sources,
 * package.json, bundler config): a link is followed, as a game's own may be one, but a FIFO or a
 * device is never waited on and nothing past `maxBytes` is read. Null when it is missing or is not
 * such a file.
 */
export async function readGameText(file: string, maxBytes: number = MAX_PAGE_BYTES): Promise<string | null> {
  return readRegularFile(file, maxBytes, { followLinks: true }).then(
    (bytes) => bytes.toString("utf8"),
    () => null,
  );
}

/**
 * What in a folder's top level is not the folder's own work: Genex's own bookkeeping, and the notes
 * a person gathers before any game exists. Neither says what kind of project the folder is, so a
 * folder holding only these (or nothing) is still an empty one.
 */
const NOT_OWN_FILES = {
  /** Genex's record of the game and the stills folder the starter makes. */
  Bookkeeping: ["studio.json", "references"],
  /**
   * The folder Genex's asset tools deliver into (`main/game-assets.ts`): what they write into a game
   * with no kind yet never makes it a project of its own. `public/` counts only while it holds
   * nothing but this folder (the bundled shape's `public/assets/`).
   */
  AssetFolder: "assets",
  BundledParent: "public",
  /** A loose note at the root, by its lower-cased extension. */
  NoteExtensions: [".md", ".txt"],
} as const;

function isProjectKind(value: unknown): value is ProjectKind {
  return typeof value === "string" && (PROJECT_KINDS as readonly string[]).includes(value);
}

/**
 * A kind studio.json may decide for a folder that has a page of its own: every kind but the
 * compiled ones (C++ · raylib, Rust · wgpu), which only a folder without a page is (the files
 * decide, never studio.json alone).
 */
function isRecordedKind(value: unknown): value is ProjectKind {
  return isProjectKind(value) && !isCompiledStack(STACK_OF_KIND[value]);
}

/**
 * Kinds an earlier studio recorded and then retired: a folder that records one is read from its
 * own evidence, as it always was, never mistaken for a newer Genex's game. `unity-project` lived
 * from 2026-09-11 to 2026-09-17.
 */
const RETIRED_KINDS: ReadonlySet<string> = new Set(["unity-project"]);

/**
 * Whether studio.json records a kind this version does not know: a newer Genex made the game
 * (forward compatibility). Such a folder is never read from its files, because what they are is
 * exactly what this version cannot tell, and reading it as the template would scaffold over it.
 */
export function recordsUnknownKind(meta: { kind?: unknown } | null): boolean {
  const kind = meta?.kind;
  return typeof kind === "string" && !isProjectKind(kind) && !RETIRED_KINDS.has(kind);
}

/**
 * The shape of every C++ · raylib game, whatever its studio.json says. `entry` is the page the C++
 * lane builds into its own output folder, never a file in the game folder; the game has no build
 * command of its own and nothing to install, because the lane builds it with the studio's pinned
 * toolchain. `own` is false: the studio's template and harness drive it (`wiring`, the chip).
 */
export const RAYLIB_SHAPE: ProjectShape = {
  entry: "index.html",
  main: "src/main.cpp",
  build: null,
  install: null,
  own: false,
  kind: ProjectKind.RaylibCpp,
  serve: ".",
};

/**
 * The shape of every Rust · wgpu game, whatever its studio.json says: `src/main.rs` hands the game
 * to `genex::install`, and `entry` is the page the Rust lane builds into its own output folder,
 * never a file in the game folder. Like {@link RAYLIB_SHAPE}, nothing here is built or installed
 * by a command of the game's own: the lane builds it with the studio's pinned toolchain.
 */
export const RUST_SHAPE: ProjectShape = {
  entry: "index.html",
  main: "src/main.rs",
  build: null,
  install: null,
  own: false,
  kind: ProjectKind.RustWgpu,
  serve: ".",
};

/** The fixed shape of each compiled stack's games. */
export const COMPILED_SHAPES = {
  [GameStack.RaylibCpp]: RAYLIB_SHAPE,
  [GameStack.RustWgpu]: RUST_SHAPE,
} as const satisfies Record<CompiledStack, ProjectShape>;

export const TEMPLATE_SHAPE: ProjectShape = {
  entry: "index.html",
  main: "src/main.js",
  build: null,
  install: null,
  own: false,
  kind: "studio-template",
  serve: ".",
};

/** Whether a shape is the studio's own or the game's own — the flag detection recorded, nothing inferred. */
export function isBuiltShape(shape: ProjectShape): boolean {
  return shape.own;
}

/** The import map only the studio writes: `three` resolved to the copy vendored with the app. */
const STUDIO_IMPORT_MAP = "/vendor/three.module.js";

/** The query a Genex game reads to skip its authorization redirect in a local test run. */
const GENEX_LOCAL_TEST_QUERY = "?genex_local_test=1";

/** Where a bundler writes the built page when its config says nothing else. */
const DEFAULT_OUTPUT_DIR = "dist";

/** The Vite config files `outputDir` reads, in order. */
const VITE_CONFIGS = ["vite.config.ts", "vite.config.js", "vite.config.mjs", "vite.config.mts"];

/** A folder's package.json, as far as shape detection reads it. */
export interface PackageManifest {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** The package's dependencies and dev dependencies together. */
function packageDependencies(pkg: PackageManifest | null): Record<string, string> {
  return { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
}

/** Whether a package declares any dependency at all — the ones an install would fetch. */
export function declaresDependencies(pkg: PackageManifest | null): boolean {
  return Object.keys(packageDependencies(pkg)).length > 0;
}

/** A folder's package.json, or null when it is missing, is not a plain file or does not parse. */
export async function readPackageManifest(dir: string): Promise<PackageManifest | null> {
  const text = await readGameText(path.join(dir, "package.json"), MAX_CONFIG_BYTES);
  try {
    const value: unknown = text === null ? null : JSON.parse(text);
    return isJsonObject(value) ? (value as PackageManifest) : null;
  } catch {
    return null;
  }
}

interface KindEvidence {
  html: string;
  srcs: string[];
  names: string[];
  pkg: PackageManifest | null;
  entryText: string | null;
  build: boolean;
}

/**
 * An engine export ships its runtime beside the page and leaves its sources elsewhere: Godot's
 * `.pck` payload, Unity's `Build/*.loader.js`. The studio can play and photograph one; it
 * cannot edit it, and saying so early is the whole point of naming the kind.
 */
function isEngineExport({ srcs, names }: KindEvidence, text: string): boolean {
  const godot = names.some((name) => name.endsWith(".pck")) || /\.pck\b/.test(text);
  const unity = /createUnityInstance/.test(text) || srcs.some((src) => /\.loader\.js(\?|$)/i.test(src));
  return godot || unity;
}

function usesPhaser({ srcs }: KindEvidence, deps: Record<string, string>, text: string): boolean {
  return "phaser" in deps || srcs.some((src) => /phaser/i.test(src)) || /["']phaser["']/.test(text);
}

function usesThree({ html, srcs }: KindEvidence, deps: Record<string, string>, text: string): boolean {
  return (
    "three" in deps ||
    srcs.some((src) => /\bthree(\.module|\.webgpu)?\.js\b/i.test(src)) ||
    /\bfrom\s*["']three["']/.test(text) ||
    /["']three["']\s*:/.test(html)
  );
}

function kindOf(evidence: KindEvidence): ProjectKind {
  const deps = packageDependencies(evidence.pkg);
  const text = `${evidence.html}\n${evidence.entryText ?? ""}`;
  if (isEngineExport(evidence, text)) return "engine-export";
  if (usesPhaser(evidence, deps, text)) return "phaser";
  if (usesThree(evidence, deps, text)) return evidence.build ? "three-vite" : "three-modules";
  if (/getContext\s*\(\s*["']2d["']/.test(text)) return "canvas2d";
  return "own-script";
}

/** Where the bundler writes the built page. Vite (and most others) use dist/ unless told otherwise. */
async function outputDir(dir: string): Promise<string> {
  for (const name of VITE_CONFIGS) {
    const text = await readGameText(path.join(dir, name), MAX_CONFIG_BYTES);
    const found = text ? /\boutDir\s*:\s*["']([^"']+)["']/.exec(text)?.[1] : null;
    if (found) return found.replace(/^\.\//, "").replace(/\/+$/, "") || ".";
  }
  return DEFAULT_OUTPUT_DIR;
}

/**
 * A Genex game redirects to genex.games to authorize unless its embed SDK is told this is a
 * local test run — the same query its own tooling uses (`?genex_local_test=1`). The query
 * rides on the entry: the preview serves the page by path and the page reads the query.
 */
function isGenexGame(pkg: PackageManifest | null): boolean {
  return Boolean(pkg?.dependencies?.["@genex-ai/embed-sdk"] ?? pkg?.devDependencies?.["@genex-ai/embed-sdk"]);
}

/**
 * A text file in a folder someone else writes, read as the C++ checks read it: never through a
 * link, never blocking on a pipe, never more than {@link MAX_NATIVE_SOURCE_BYTES}. Null when it is
 * missing or is not a plain file.
 */
export async function readNativeSource(file: string): Promise<string | null> {
  return readRegularFile(file, MAX_NATIVE_SOURCE_BYTES).then(
    (bytes) => bytes.toString("utf8"),
    () => null,
  );
}

/** What one step of the CMake scanner read. */
const CMakeToken = {
  Open: "open",
  Close: "close",
  /** Space or a comment: never an argument, never a command's name. */
  Gap: "gap",
  /** An unquoted argument; at the top level, the name of the command it may call. */
  Word: "word",
  /** A quoted or bracket argument: an argument, never a command's name. */
  Literal: "literal",
} as const;
type CMakeToken = (typeof CMakeToken)[keyof typeof CMakeToken];

/** One step of the CMake scanner: what it read, an argument's text, and where the next step starts. */
interface CMakeStep {
  token: CMakeToken;
  text: string;
  end: number;
}

/** One CMake command call: its name in lower case (CMake matches command names case-blind) and its arguments. */
interface CMakeCall {
  name: string;
  args: string[];
}

/** Where a quoted or bracket argument's content ends, and where the text after it starts. */
interface Closing {
  content: number;
  end: number;
}

/** A command name as CMake spells one. */
const CMAKE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The characters CMake reads as space between arguments. */
const CMAKE_SPACE = new Set([" ", "\t", "\n", "\r"]);

/** Whether `char` ends an unquoted argument: space, a parenthesis, a comment or a quote. */
function endsUnquoted(char: string): boolean {
  return CMAKE_SPACE.has(char) || char === "(" || char === ")" || char === "#" || char === '"';
}

/** At `at`, a bracket's opening `[`, `[=[`, `[==[`…: its level (how many `=`) and where its content starts. */
function bracketOpening(text: string, at: number): { level: number; content: number } | null {
  if (text.charAt(at) !== "[") return null;
  let next = at + 1;
  while (text.charAt(next) === "=") next++;
  return text.charAt(next) === "[" ? { level: next - at - 1, content: next + 1 } : null;
}

/**
 * Where a bracket of `level` closes (`]` and as many `=` and `]`), searched from `from`; the end of
 * the text when it never does. Each run of `=` is read once, so the search never steps back.
 */
function bracketClosing(text: string, from: number, level: number): Closing {
  let close = text.indexOf("]", from);
  while (close !== -1) {
    let next = close + 1;
    while (text.charAt(next) === "=") next++;
    if (next - close - 1 === level && text.charAt(next) === "]") return { content: close, end: next + 1 };
    close = text.indexOf("]", next);
  }
  return { content: text.length, end: text.length };
}

/** From just inside a quoted argument: its closing quote, an escaped character never being one. */
function quotedClosing(text: string, from: number): Closing {
  let at = from;
  while (at < text.length) {
    const char = text.charAt(at);
    if (char === '"') return { content: at, end: at + 1 };
    at += char === "\\" ? 2 : 1;
  }
  return { content: text.length, end: text.length };
}

/** From just after `#`: where the comment ends, a bracket comment at its closing and any other at its line's end. */
function commentEnd(text: string, from: number): number {
  const bracket = bracketOpening(text, from);
  if (bracket) return bracketClosing(text, bracket.content, bracket.level).end;
  const newline = text.indexOf("\n", from);
  return newline === -1 ? text.length : newline;
}

/** From an unquoted argument's first character: the index after it (an escape takes the next character along). */
function unquotedEnd(text: string, from: number): number {
  let at = from;
  while (at < text.length && !endsUnquoted(text.charAt(at))) at += text.charAt(at) === "\\" ? 2 : 1;
  return Math.min(at, text.length);
}

/** From the first character of a run of space: the index after it. */
function spaceEnd(text: string, from: number): number {
  let at = from;
  while (CMAKE_SPACE.has(text.charAt(at))) at++;
  return at;
}

/** A quoted or bracket argument whose content starts at `content`. */
function literalStep(text: string, content: number, closing: Closing): CMakeStep {
  return { token: CMakeToken.Literal, text: text.slice(content, closing.content), end: closing.end };
}

/** One step of the CMake scanner from `at`, which is never inside a token. Every step reads at least one character. */
function cmakeStep(text: string, at: number): CMakeStep {
  const char = text.charAt(at);
  if (char === "(") return { token: CMakeToken.Open, text: "", end: at + 1 };
  if (char === ")") return { token: CMakeToken.Close, text: "", end: at + 1 };
  if (char === "#") return { token: CMakeToken.Gap, text: "", end: commentEnd(text, at + 1) };
  if (CMAKE_SPACE.has(char)) return { token: CMakeToken.Gap, text: "", end: spaceEnd(text, at) };
  if (char === '"') return literalStep(text, at + 1, quotedClosing(text, at + 1));
  const bracket = bracketOpening(text, at);
  if (bracket) return literalStep(text, bracket.content, bracketClosing(text, bracket.content, bracket.level));
  const end = unquotedEnd(text, at);
  return { token: CMakeToken.Word, text: text.slice(at, end), end };
}

/**
 * A call's arguments, read from just after its `(` to the `)` that closes it, parentheses inside it
 * counted; `closed` is false when the text ends first.
 */
function cmakeArguments(text: string, from: number): { args: string[]; end: number; closed: boolean } {
  const args: string[] = [];
  let depth = 1;
  let at = from;
  while (at < text.length) {
    const step = cmakeStep(text, at);
    at = step.end;
    if (step.token === CMakeToken.Open) depth++;
    else if (step.token === CMakeToken.Close) depth--;
    else if (step.token !== CMakeToken.Gap) args.push(step.text);
    if (depth === 0) return { args, end: at, closed: true };
  }
  return { args, end: at, closed: false };
}

/**
 * Every command call in a CMakeLists.txt, read the way CMake reads one: a comment (`#…`, `#[[…]]`),
 * a quoted argument and a bracket argument are never calls, and neither is anything inside a call's
 * own arguments. One forward pass that never steps back, so a hostile file costs its length.
 */
function* cmakeCalls(text: string): Generator<CMakeCall> {
  let name: string | null = null;
  let at = 0;
  while (at < text.length) {
    const step = cmakeStep(text, at);
    at = step.end;
    if (step.token === CMakeToken.Gap) continue;
    if (step.token === CMakeToken.Open && name !== null) {
      const call = cmakeArguments(text, at);
      at = call.end;
      if (call.closed) yield { name, args: call.args };
    }
    const names = step.token === CMakeToken.Word && CMAKE_IDENTIFIER.test(step.text);
    name = names ? step.text.toLowerCase() : null;
  }
}

/** Whether any command call in a CMakeLists.txt passes `test`; reading stops at the first that does. */
function anyCMakeCall(cmake: string, test: (call: CMakeCall) => boolean): boolean {
  for (const call of cmakeCalls(cmake)) {
    if (test(call)) return true;
  }
  return false;
}

/** The studio's own CMake entry point, defined by the lane's `genex.cmake`: a game that calls it builds in the C++ lane. */
const GENEX_ADD_GAME = "genex_add_game";

/** Whether a CMakeLists.txt calls `genex_add_game(`: the one way the C++ lane builds a game. */
export function cmakeCallsGenexAddGame(cmake: string): boolean {
  return anyCMakeCall(cmake, (call) => call.name === GENEX_ADD_GAME);
}

/** One CMake command that names raylib: its package, a link to it, or a fetch of its sources. */
function namesRaylib({ name, args }: CMakeCall): boolean {
  if (name === GENEX_ADD_GAME) return true;
  if (name === "find_package") return /^raylib\b/i.test(args[0] ?? "");
  if (name === "target_link_libraries") return args.some((arg) => /(?:^|[\s:])raylib\b/i.test(arg));
  const fetches = name === "fetchcontent_declare" || name === "externalproject_add";
  return fetches && args.some((arg) => /raylib/i.test(arg));
}

/**
 * Whether a CMakeLists.txt builds with raylib: `genex_add_game(`, `find_package(raylib`, a
 * `raylib` link target, or a FetchContent/ExternalProject of raylib. Comments, quoted and bracket
 * arguments do not count.
 */
export function cmakeNamesRaylib(cmake: string): boolean {
  return anyCMakeCall(cmake, namesRaylib);
}

/** Whether a folder's own CMakeLists.txt, read as a plain file, builds with raylib. */
async function cmakeBuildsRaylib(dir: string): Promise<boolean> {
  const cmake = await readNativeSource(path.join(dir, "CMakeLists.txt"));
  return cmake !== null && cmakeNamesRaylib(cmake);
}

/** The manifest a Rust · wgpu game keeps at its root (title, sizes, allowed crates); there is no Cargo.toml. */
export const GENEX_MANIFEST = "genex.toml";

/**
 * Whether anything is at the folder's `genex.toml`. Its name alone says Rust: detection never
 * opens it, so a link, a FIFO or a folder planted there is never followed or waited on (validation
 * reads it as a plain file, and says so when it is not one).
 */
async function hasGenexManifest(dir: string): Promise<boolean> {
  return entryExists(path.join(dir, GENEX_MANIFEST));
}

/** The compiled shape a folder's own files give it: a `genex.toml` is Rust, a raylib CMake project is C++. */
async function compiledShapeByFiles(dir: string): Promise<ProjectShape | null> {
  if (await hasGenexManifest(dir)) return RUST_SHAPE;
  return (await cmakeBuildsRaylib(dir)) ? RAYLIB_SHAPE : null;
}

/** The compiled shape studio.json records by its kind, or null for any other kind. */
function recordedCompiledShape(kind: unknown): ProjectShape | null {
  if (!isProjectKind(kind)) return null;
  const stack = STACK_OF_KIND[kind];
  return isCompiledStack(stack) ? COMPILED_SHAPES[stack] : null;
}

/**
 * A compiled game's fixed shape: a folder with no page of its own whose studio.json recorded a
 * compiled kind (a game that lost its `genex.toml` or CMakeLists.txt is still one, and validation
 * says what is missing), or whose files say so. A page of its own always makes it a browser game.
 */
async function compiledFolderShape(dir: string, meta: { kind?: unknown } | null): Promise<ProjectShape | null> {
  if (await pathExists(path.join(dir, "index.html"))) return null;
  return recordedCompiledShape(meta?.kind) ?? compiledShapeByFiles(dir);
}

/**
 * Whether a template game's page loads the Genex SDK through Studio's copy. The SDK keeps a preview
 * from sending anyone to genex.games to sign in only in its local test mode, which only a loopback
 * origin gets: the preview serves such a game there, as it does a built one.
 */
export async function templateLoadsGenexSdk(dir: string): Promise<boolean> {
  const html = await readFile(path.join(dir, TEMPLATE_SHAPE.entry), "utf8").catch(() => null);
  return html !== null && pageLoadsGenexSdk(html);
}

/**
 * Read a folder's own shape from the evidence in it: every script the page loads, the package's
 * build script and dependencies, the bundler's output folder, the engine's runtime files.
 * `null` means the studio's own template — recognised only by the two things the studio itself
 * writes, the `contractVersion` in studio.json and the vendored-three import map. Everything
 * else in the world is somebody's own game. A folder without a page is a compiled game when its
 * files say so: a `genex.toml` makes it Rust · wgpu ({@link RUST_SHAPE}), a CMakeLists.txt that
 * builds with raylib makes it C++ ({@link RAYLIB_SHAPE}).
 */
export async function detectProjectShape(dir: string): Promise<ProjectShape | null> {
  const html = await readGameText(path.join(dir, "index.html"), MAX_PAGE_BYTES);
  if (html === null) {
    const compiled = await compiledShapeByFiles(dir);
    return compiled ? { ...compiled } : null;
  }
  const { meta } = await readStudioJson(dir);
  if (typeof meta?.contractVersion === "number" && html.includes(STUDIO_IMPORT_MAP)) return null;

  const srcs = pageScripts(html);
  const [firstLocal] = srcs.filter((src) => !isRemoteSrc(src));
  // A page whose scripts are all inline or all CDN tags still has an entry: itself. Naming
  // index.html keeps `main` a file the owner can open, and keeps the ownership rules honest.
  const main = firstLocal === undefined ? "index.html" : projectRelative(firstLocal);
  const pkg = await readPackageManifest(dir);
  const hasBuild = typeof pkg?.scripts?.build === "string" && pkg.scripts.build.trim().length > 0;
  const names = (await readdir(dir, { withFileTypes: true }).catch(() => [])).map((entry) => entry.name);
  const entryText = main === "index.html" ? null : await readGameText(path.join(dir, main), MAX_PAGE_BYTES);
  const kind = kindOf({ html, srcs, names, pkg, entryText, build: hasBuild });
  const query = isGenexGame(pkg) ? GENEX_LOCAL_TEST_QUERY : "";
  const serve = hasBuild ? await outputDir(dir) : ".";
  const entry = `${serve === "." ? "index.html" : path.posix.join(serve, "index.html")}${query}`;
  // The lockfile names the manager, not the habit: `npm run build` in a pnpm workspace builds
  // against a node_modules the user never installed.
  const commands = packageCommands(names);
  return {
    entry,
    main,
    build: hasBuild ? commands.build : null,
    install: declaresDependencies(pkg) ? commands.install : null,
    own: true,
    kind,
    serve,
  };
}

/**
 * A path inside the folder, spelled plainly: relative, no `..`, and none of the characters a shell
 * acts on (M3). studio.json sits in the folder a contractor writes, and its `main` reaches the
 * loop's merge command line; a name that is not plain is not an entry the studio will use.
 */
export function plainRelativePath(value: string): boolean {
  // Empty, absolute, or read as an option by the command it reaches.
  const unusable = !value || value.startsWith("/") || value.startsWith("-");
  if (unusable) return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point: they are refused.
  if (/[\0-\x1f\x7f;&|$`<>()'"\\*?!{}[\]~#]/.test(value)) return false;
  return !value.split("/").some((part) => part === ".." || part === "");
}

/** The folder a served entry lives in — `dist/index.html?x=1` is served out of `dist`. */
function serveDirOf(entry: string): string {
  const dir = path.posix.dirname((entry.split(/[?#]/)[0] ?? entry).replace(/^\.?\//, ""));
  return dir === "" ? "." : dir;
}

/** studio.json as `readProjectShape` reads it: every field unchecked until it is used. */
interface ShapeMeta {
  entry?: unknown;
  main?: unknown;
  build?: unknown;
  install?: unknown;
  own?: unknown;
  kind?: unknown;
  serve?: unknown;
  bootMs?: unknown;
}

/** A non-blank string field, trimmed; null for anything else. */
function trimmedText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Whether studio.json records a shape at all: an entry, a main module or a build. */
export function recordsShape(meta: { entry?: unknown; main?: unknown; build?: unknown } | null): boolean {
  return typeof meta?.entry === "string" || typeof meta?.main === "string" || typeof meta?.build === "string";
}

/**
 * Running the recorded `install` is the one thing that opens the network, and
 * this file sits inside the folder the user brought — a downloaded game ships one, and any
 * contractor can rewrite it mid-run. So only a package manager's own install is taken from
 * it; anything else falls back to what the lockfile actually names, and the sheet, the
 * button's label and the command that runs stay the same string.
 */
function recordedInstall(meta: ShapeMeta, detected: ProjectShape | null): string | null {
  if (isInstallCommand(meta.install)) return (meta.install as string).trim();
  if (meta.install === null) return null;
  return detected?.install ?? null;
}

/**
 * The shape of a game a newer Genex made ({@link recordsUnknownKind}): somebody's own game as far as
 * this version can tell, so no template is ever written beside it, with no build and no install,
 * so nothing it records is ever run, and marked read-only with `kind-unsupported`.
 */
function readOnlyShape(meta: ShapeMeta): ProjectShape {
  const main = typeof meta.main === "string" && plainRelativePath(meta.main.trim()) ? meta.main.trim() : "index.html";
  return {
    entry: "index.html",
    main,
    build: null,
    install: null,
    own: true,
    kind: ProjectKind.OwnScript,
    serve: ".",
    readOnly: TargetRefusal.KindUnsupported,
  };
}

/** The shape studio.json records, with what it leaves out detected once from the folder. */
async function recordedShape(dir: string, meta: ShapeMeta): Promise<ProjectShape> {
  const entry = trimmedText(meta.entry) ?? TEMPLATE_SHAPE.entry;
  const main =
    typeof meta.main === "string" && plainRelativePath(meta.main.trim()) ? meta.main.trim() : TEMPLATE_SHAPE.main;
  const build = trimmedText(meta.build);
  // (See `recordedInstall` for why only a package manager's own install is read from here.)
  const declaresInstall = meta.install === null || isInstallCommand(meta.install);
  // studio.json written before shapes carried own/kind/serve/install: the folder is still there
  // to read, so those are detected once rather than guessed from the entry filename. A recorded
  // shape always meant "the game's own" — that is exactly what the old flag computed.
  const detected = isRecordedKind(meta.kind) && declaresInstall ? null : await detectProjectShape(dir);
  const kind = isRecordedKind(meta.kind) ? meta.kind : (detected?.kind ?? null);
  const own = typeof meta.own === "boolean" ? meta.own : build !== null || main !== TEMPLATE_SHAPE.main;
  return {
    entry,
    main,
    build,
    install: recordedInstall(meta, detected),
    own,
    kind: kind ?? (own ? "own-script" : TEMPLATE_SHAPE.kind),
    serve: trimmedText(meta.serve) ?? serveDirOf(entry),
  };
}

/**
 * The shape studio.json records, else what the folder itself says, else the studio's own. One
 * function so that everything asking "how does this folder run" — describe, validate, the
 * inspector — gets the same answer.
 */
export async function readProjectShape(dir: string): Promise<ProjectShape> {
  const meta: ShapeMeta | null = (await readStudioJson(dir)).meta;
  // Before anything reads the folder's files: a kind this version does not know is a newer
  // Genex's game, and the template fallback below would scaffold over it.
  if (meta && recordsUnknownKind(meta)) return readOnlyShape(meta);
  // A folder may declare only how long it takes to boot, so the number is read before the
  // shape's own early return — and attached with a spread, never a mutation: TEMPLATE_SHAPE is
  // shared, and an undefined-valued key would break every shape a test compares whole.
  const bootMs = declaredBootMs(meta?.bootMs);
  const declaredBoot = bootMs === null ? {} : { bootMs };
  // A compiled game's shape is fixed, whatever studio.json records beside it: an `own` or a
  // `build` it claims would switch the lane off and serve sources nothing can run.
  const compiled = await compiledFolderShape(dir, meta);
  if (compiled) return { ...compiled, ...declaredBoot };
  if (!meta || !recordsShape(meta)) {
    const detected = (await detectProjectShape(dir)) ?? TEMPLATE_SHAPE;
    return bootMs === null ? detected : { ...detected, ...declaredBoot };
  }
  return { ...(await recordedShape(dir, meta)), ...declaredBoot };
}

/**
 * Whether a folder holds a web game at its root, by its facts (`detectFacts`): an `index.html` at
 * its root, or the web starter's stamp (`contractVersion`) in its `studio.json`. A folder that can't
 * be read holds none.
 */
export async function webGameSignal(dir: string): Promise<boolean> {
  const facts = await detectFacts(dir, []).catch(() => []);
  return hasFact(facts, CoreFact.WebGame, ".");
}

/** A top-level entry as these reads take it. */
type TopEntry = { name: string; isFile(): boolean; isDirectory(): boolean };

/** Whether a top-level entry is the folder's own work, not bookkeeping, a hidden file or a loose note. */
function isOwnEntry(entry: TopEntry): boolean {
  if (entry.name.startsWith(".")) return false;
  if ((NOT_OWN_FILES.Bookkeeping as readonly string[]).includes(entry.name)) return false;
  if (entry.isDirectory() && entry.name === NOT_OWN_FILES.AssetFolder) return false;
  const extension = path.extname(entry.name).toLowerCase();
  return !(entry.isFile() && (NOT_OWN_FILES.NoteExtensions as readonly string[]).includes(extension));
}

/**
 * Whether a top-level entry is the folder's own work (`isOwnEntry`), reading into `public/`: one that
 * holds nothing but Genex's asset folder (and hidden files) is Genex's output, not the folder's own.
 */
async function ownEntry(dir: string, entry: TopEntry): Promise<boolean> {
  if (!isOwnEntry(entry)) return false;
  if (!entry.isDirectory() || entry.name !== NOT_OWN_FILES.BundledParent) return true;
  const inside = await readdir(path.join(dir, entry.name), { withFileTypes: true }).catch(() => null);
  if (!inside) return true;
  return inside.some(
    (child) => !child.name.startsWith(".") && !(child.isDirectory() && child.name === NOT_OWN_FILES.AssetFolder),
  );
}

/** Whether any top-level entry is the folder's own work (`ownEntry`). */
async function anyOwnEntry(dir: string, entries: readonly TopEntry[]): Promise<boolean> {
  for (const entry of entries) if (await ownEntry(dir, entry)) return true;
  return false;
}

/** Whether a top-level entry is a loose note: a visible `*.md` or `*.txt` file. */
function isNote(entry: TopEntry): boolean {
  const extension = path.extname(entry.name).toLowerCase();
  return (
    entry.isFile() &&
    !entry.name.startsWith(".") &&
    (NOT_OWN_FILES.NoteExtensions as readonly string[]).includes(extension)
  );
}

/**
 * Whether a folder holds files of its own: any top-level entry but a hidden one, Genex's own
 * bookkeeping (`studio.json`, `references/`), the folder its asset tools deliver into (`assets/`, or a
 * `public/` holding only that) and loose notes at the root (`*.md`, `*.txt`).
 */
export async function holdsOwnFiles(dir: string): Promise<boolean> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return anyOwnEntry(dir, entries);
}

/**
 * What a folder holds at its top level, besides hidden files, Genex's bookkeeping and its asset
 * deliveries: files of its own (`holdsOwnFiles`), loose notes only, or nothing. Throws when the folder
 * can't be read.
 */
export async function folderHolds(dir: string): Promise<FolderHolds> {
  const entries = await readdir(dir, { withFileTypes: true });
  if (await anyOwnEntry(dir, entries)) return FolderHolds.OwnFiles;
  return entries.some(isNote) ? FolderHolds.Notes : FolderHolds.Nothing;
}

/** Folders that are output, dependencies or notes — a game is never *these*, so the scan skips them. */
const NOT_A_GAME = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "export",
  "assets",
  "references",
  "docs",
  "public",
  "coverage",
]);

/** A child folder a scan for games (or for repositories inside a game folder) looks into. */
export function isScannedChild(entry: { name: string; isDirectory(): boolean }): boolean {
  return entry.isDirectory() && !entry.name.startsWith(".") && !NOT_A_GAME.has(entry.name);
}

/**
 * The file that makes a folder a game candidate: a page a browser can open, a Rust manifest, a
 * raylib CMake project, or a studio.json a newer Genex wrote (opened read-only). Null for none.
 */
async function candidateEvidence(target: string): Promise<string | null> {
  if (await pathExists(path.join(target, "index.html"))) return "index.html";
  if (await hasGenexManifest(target)) return GENEX_MANIFEST;
  if (await cmakeBuildsRaylib(target)) return "CMakeLists.txt";
  return recordsUnknownKind((await readStudioJson(target)).meta) ? "studio.json" : null;
}

/** One folder as a game candidate, or null when nothing in it makes it a game ({@link candidateEvidence}). */
async function gameCandidate(target: string, rel: string): Promise<GameCandidate | null> {
  const evidence = await candidateEvidence(target);
  if (evidence === null) return null;
  const pkg = await readPackageManifest(target);
  const shape = await readProjectShape(target);
  const why = [evidence];
  if (pkg) why.push(pkg.scripts?.build ? `package.json (build: ${pkg.scripts.build})` : "package.json");
  if (await pathExists(path.join(target, ".git"))) why.push("its own git repository");
  return { rel, dir: target, shape, why };
}

/**
 * Every game in a folder and one level under it. A user who drops their game inside a project
 * folder used to be told the folder was empty, wrapped in a template and hand-ported for the whole run
 *; the fix is to look one level down and say what is there.
 *
 * A candidate is a folder with an `index.html` — the page a browser can open — a `genex.toml`,
 * a CMake project that builds with raylib, or a game a newer Genex made. Nothing is written,
 * nothing is chosen: the caller decides, and can ask.
 */
export async function findGameRoot(dir: string): Promise<GameCandidate[]> {
  const found: GameCandidate[] = [];
  const own = await gameCandidate(dir, ".");
  if (own) found.push(own);
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!isScannedChild(entry)) continue;
    const child = await gameCandidate(path.join(dir, entry.name), entry.name);
    if (child) found.push(child);
  }
  return found;
}

/** studio.json's word on where a game plays, every field unchecked until it is used. */
interface DestinationMeta {
  stack?: unknown;
  targets?: unknown;
}

/** Where a game plays as the studio reads it, and what in studio.json it ignored on the way. */
export interface DestinationReading {
  destinations: GameDestinations;
  /** Sentences for the person: what studio.json names that the studio ignores. */
  warnings: string[];
  /** studio.json names a stack the folder's files are not: the files win, and validation reports it. */
  stackContradicts: boolean;
}

/**
 * The destinations the studio knows for a game of `stack`, in list order: the browser and the
 * desktop for every stack (a Three.js game's desktop ones are known, and refused as not its own),
 * and the phones too where the stack can name them ({@link STACK_TARGETS}).
 */
export function destinationVocabulary(stack: GameStack): readonly BuildTarget[] {
  return ALL_BUILD_TARGETS.filter((target) => BUILD_TARGETS.includes(target) || playsOn(stack, target));
}

/** Whether a game of `stack` may name `target` at all ({@link STACK_TARGETS}): a Three.js game the browser only. */
export function playsOn(stack: GameStack, target: BuildTarget): boolean {
  const own: readonly BuildTarget[] = STACK_TARGETS[stack];
  return own.includes(target);
}

/**
 * A list of destinations the studio will write: at least one of `vocabulary` (the browser and the
 * desktop unless named), none twice. Every index is read, an empty slot too: `every` skips one,
 * and a renderer's structured clone keeps it.
 */
export function isDestinationList(
  value: unknown,
  vocabulary: readonly BuildTarget[] = BUILD_TARGETS,
): value is BuildTarget[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > vocabulary.length) return false;
  const entries: unknown[] = Array.from(value);
  const known = entries.every((entry) => (vocabulary as readonly unknown[]).includes(entry));
  return known && new Set(entries).size === entries.length;
}

/** `targets` in the order the create dialog lists destinations, each once. */
export function inBuildOrder(targets: readonly BuildTarget[]): BuildTarget[] {
  return ALL_BUILD_TARGETS.filter((target) => targets.includes(target));
}

/** Where a game of `stack` plays when studio.json names nowhere: a compiled game in the browser and on this computer. */
export function defaultDestinations(stack: GameStack, host: StudioPlatform | null): GameDestinations {
  if (!isCompiledStack(stack)) return DEFAULT_DESTINATIONS;
  return { stack, targets: host ? [BuildTarget.Web, hostTarget(host)] : [BuildTarget.Web] };
}

/**
 * The destinations studio.json lists, as far as the studio can honour them: ones it does not know
 * for this stack ({@link destinationVocabulary}: the phones are unknown to all but a Rust game) and
 * ones the stack cannot play on (a Three.js game's desktop ones) dropped with a warning, null when
 * none is left or the field is not a short list at all.
 */
function recordedTargets(value: unknown, stack: GameStack, warnings: string[]): BuildTarget[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length > MAX_RECORDED_TARGETS) {
    warnings.push(MESSAGE.TargetsNotAList);
    return null;
  }
  const vocabulary = destinationVocabulary(stack);
  const isKnown = (target: unknown): target is BuildTarget => (vocabulary as readonly unknown[]).includes(target);
  const unknown = value.filter((target) => !isKnown(target)).length;
  if (unknown > 0) warnings.push(MESSAGE.UnknownTargets(unknown));
  const known = inBuildOrder(value.filter(isKnown));
  // Only a browser game's vocabulary is wider than where it plays: its desktop destinations.
  const playable = known.filter((target) => playsOn(stack, target));
  if (playable.length < known.length) warnings.push(MESSAGE.BrowserOnly);
  return playable.length > 0 ? playable : null;
}

/** {@link readGameDestinations} over a studio.json already read. */
function destinationsFrom(
  meta: DestinationMeta,
  shape: Pick<ProjectShape, "kind">,
  host: StudioPlatform | null,
): DestinationReading {
  const stack = stackOf(shape);
  const warnings: string[] = [];
  const unknownStack = meta.stack !== undefined && !isGameStack(meta.stack);
  if (unknownStack) warnings.push(MESSAGE.UnknownStack);
  const targets = recordedTargets(meta.targets, stack, warnings);
  return {
    destinations: targets ? { stack, targets } : defaultDestinations(stack, host),
    warnings,
    stackContradicts: isGameStack(meta.stack) && meta.stack !== stack,
  };
}

/**
 * Where a game plays. The kind decides the stack (a C++ folder is C++ whatever studio.json says,
 * and a stack that contradicts it is flagged); studio.json's valid `targets` are its
 * destinations; a C++ game that names none plays in the browser and on `host`'s own OS; anything
 * else is a Three.js browser game. Never throws: a studio.json nobody can read is one that says
 * nothing, and one that is not a plain file (a link, a FIFO, a folder, too large) says so in a warning.
 */
export async function readGameDestinations(
  dir: string,
  shape: Pick<ProjectShape, "kind">,
  host: StudioPlatform | null,
): Promise<DestinationReading> {
  const { meta, warning } = await readStudioJson(dir);
  const reading = destinationsFrom(meta ?? {}, shape, host);
  return warning ? { ...reading, warnings: [warning, ...reading.warnings] } : reading;
}
