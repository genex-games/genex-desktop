/**
 * How a game folder runs: its entry, its build, the folder the preview serves and what kind of
 * game it is — recorded in studio.json, or read from the evidence in the folder itself.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { GAME_RUNTIMES, TargetRuntime } from "../shared/computer-target.ts";
import type { GameCandidate, PlayCommand, PlayEngine, ProjectKind, ProjectShape } from "../shared/game-project.ts";
import { DESIGN_FOLDER } from "../shared/design-board.ts";
import { pageLoadsGenexSdk } from "../shared/genex-page.ts";
import { CoreFact, FolderHolds, hasFact } from "../shared/project-facts.ts";
import { pathExists, readJsonIfExists } from "./fsx.ts";
import { isRemoteSrc, pageScripts, projectRelative } from "./game-page.ts";
import { containedReal } from "./paths.ts";
import { detectFacts } from "./project-facts.ts";
import { declaredBootMs } from "./preview-ready.ts";
import { isInstallCommand, packageCommands } from "./toolchain.ts";

const PROJECT_KINDS: readonly ProjectKind[] = [
  "studio-template",
  "three-vite",
  "three-modules",
  "canvas2d",
  "phaser",
  "engine-export",
  "own-script",
];

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
   * with no kind yet never makes it a project of its own.
   */
  AssetFolder: "assets",
  /**
   * A top-level folder that is Genex's output while it holds nothing but the one folder Genex writes
   * there: the bundled shape's `public/assets/`.
   */
  GenexInside: new Map([["public", "assets"]]),
  /**
   * The project's notes folder (`docs/`), never files of a kind Genex can't name, whatever is in
   * it: the design board a new game gets before it is built (`docs/design/`), and the research, data
   * and scripts a design session saves beside it, so the game it designs still starts as its first
   * build decides. Anything in it but the board counts as notes to read first.
   */
  NotesFolder: path.posix.dirname(DESIGN_FOLDER),
  /** The design board inside the notes folder: on its own, not yet a note. */
  DesignBoard: path.posix.basename(DESIGN_FOLDER),
  /** A loose note at the root, by its lower-cased extension. */
  NoteExtensions: [".md", ".txt"],
} as const;

function isProjectKind(value: unknown): value is ProjectKind {
  return typeof value === "string" && (PROJECT_KINDS as readonly string[]).includes(value);
}

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

/** A folder's package.json, or null when it is missing or does not parse. */
export function readPackageManifest(dir: string): Promise<PackageManifest | null> {
  return readJsonIfExists<PackageManifest>(path.join(dir, "package.json")).catch(() => null);
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
    const text = await readFile(path.join(dir, name), "utf8").catch(() => null);
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
 * Whether a template game's page loads the Genex SDK through Studio's copy. The SDK keeps a preview
 * from sending anyone to genex.games to sign in only in its local test mode, which only a loopback
 * origin gets: the preview serves such a game there, as it does a built one.
 */
export async function templateLoadsGenexSdk(dir: string): Promise<boolean> {
  const html = await readFile(path.join(dir, TEMPLATE_SHAPE.entry), "utf8").catch(() => null);
  return html !== null && pageLoadsGenexSdk(html);
}

/** The SDK calls that reach a play-time model, by name: any of them means the game calls one. */
const MODEL_CALL_NAMES = /\b(?:requestSpendGrant|generateStream|getGenerationModels)\b|\bjudge\s*\(/;
/** A call of `generate(`, which counts only where the code imports it from the SDK. */
const GENERATE_CALL = /(?<![\w$])generate\s*\(/;
/** An import of `generate` from the SDK, by its package name or Studio's copy (`/vendor/genex/`). */
const GENERATE_IMPORT =
  /import\s*\{[^}]*\bgenerate\b[^}]*\}\s*from\s*["'](?:@genex-ai\/embed-sdk[^"']*|[^"']*\/vendor\/genex\/[^"']*)["']/;
/** The most of one file the check reads: a larger file is a bundle or data, not the game's own code. */
const MODEL_SCAN_MAX_BYTES = 1024 * 1024;
/** The most files of a game the check reads. */
const MODEL_SCAN_MAX_FILES = 400;
/** How deep in a game's folders the check looks. */
const MODEL_SCAN_MAX_DEPTH = 6;
/** The files that hold a web game's code. */
const CODE_EXTENSIONS: ReadonlySet<string> = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".tsx", ".jsx", ".html"]);
/** Folders that hold no code of the game's own: packages, builds, Studio's copies. */
const NOT_OWN_CODE: ReadonlySet<string> = new Set(["node_modules", "dist", "build", "out", "vendor"]);

/** The quotes a JavaScript string opens with. */
const QUOTES: ReadonlySet<string> = new Set(['"', "'", "`"]);

/**
 * `code` with its comments and the insides of its strings blanked, so a name in a comment or a
 * message is not a call. A rough reader of JavaScript (no regular-expression literals): it only
 * ever blanks too much, never too little.
 */
function codeOnly(code: string): string {
  let out = "";
  let at = 0;
  while (at < code.length) {
    const char = code[at] ?? "";
    const end = skippedEnd(code, at);
    if (end === null) {
      out += char;
      at += 1;
      continue;
    }
    // A string keeps its quotes, so an import's source can still be read as one.
    out += QUOTES.has(char) ? quotedSource(code.slice(at, end)) : " ";
    at = end;
  }
  return out;
}

/** Just past the comment or string that opens at `at`, or null where none opens. */
function skippedEnd(code: string, at: number): number | null {
  const two = code.slice(at, at + 2);
  if (two === "//") {
    const line = code.indexOf("\n", at);
    return line === -1 ? code.length : line;
  }
  if (two === "/*") {
    const close = code.indexOf("*/", at + 2);
    return close === -1 ? code.length : close + 2;
  }
  const char = code[at] ?? "";
  return QUOTES.has(char) ? stringEnd(code, at, char) : null;
}

/** Just past the string that opens at `at` with `quote`, or the end of the code. */
function stringEnd(code: string, at: number, quote: string): number {
  for (let i = at + 1; i < code.length; i++) {
    if (code[i] === "\\") i++;
    else if (code[i] === quote) return i + 1;
    else if (code[i] === "\n" && quote !== "`") return i;
  }
  return code.length;
}

/** A string as the check keeps it: whole when it names a module (an import's source), else empty quotes. */
function quotedSource(text: string): string {
  const inside = text.slice(1, -1);
  return /^(?:@genex-ai\/embed-sdk|[^\s]*\/vendor\/genex\/)[^\s]*$/.test(inside) ? text : '""';
}

/**
 * Whether a game's code calls a play-time model through the Genex SDK: it names
 * `requestSpendGrant`, `generateStream`, `getGenerationModels` or calls `judge(`, or calls
 * `generate(` it imports from the SDK. Comments and strings do not count; neither does a file over
 * {@link MODEL_SCAN_MAX_BYTES}.
 */
export function codeCallsPlayTimeModels(code: string): boolean {
  if (code.length > MODEL_SCAN_MAX_BYTES) return false;
  const plain = codeOnly(code);
  if (MODEL_CALL_NAMES.test(plain)) return true;
  return GENERATE_CALL.test(plain) && GENERATE_IMPORT.test(plain);
}

/** The game's own code files, never through a link out of it, at most {@link MODEL_SCAN_MAX_FILES}. */
async function ownCodeFiles(dir: string, depth = 0, found: string[] = []): Promise<string[]> {
  if (depth > MODEL_SCAN_MAX_DEPTH) return found;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (found.length >= MODEL_SCAN_MAX_FILES) break;
    if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && !NOT_OWN_CODE.has(entry.name)) await ownCodeFiles(full, depth + 1, found);
    else if (entry.isFile() && CODE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) found.push(full);
  }
  return found;
}

/**
 * Whether a game calls play-time models in its preview: its page loads the Genex SDK (Studio's copy
 * in its import map, or the SDK in its package) and its own code calls a model
 * ({@link codeCallsPlayTimeModels}). Such a game gets a practice helper beside its preview.
 */
export async function gameCallsPlayTimeModels(dir: string): Promise<boolean> {
  const html = await readFile(path.join(dir, TEMPLATE_SHAPE.entry), "utf8").catch(() => null);
  const loadsSdk = (html !== null && pageLoadsGenexSdk(html)) || isGenexGame(await readPackageManifest(dir));
  if (!loadsSdk) return false;
  for (const file of await ownCodeFiles(dir)) {
    const code = await readFile(file, "utf8").catch(() => "");
    if (codeCallsPlayTimeModels(code)) return true;
  }
  return false;
}

/**
 * Read a folder's own shape from the evidence in it: every script the page loads, the package's
 * build script and dependencies, the bundler's output folder, the engine's runtime files.
 * `null` means the studio's own template — recognised by the one thing the studio itself records,
 * the starter's `contractVersion` in studio.json, while the folder has no build script. What the
 * page's text says never decides it. Everything else in the world is somebody's own game.
 */
export async function detectProjectShape(dir: string): Promise<ProjectShape | null> {
  const html = await readFile(path.join(dir, "index.html"), "utf8").catch(() => null);
  if (html === null) return null;
  const meta = await readJsonIfExists<{ contractVersion?: unknown }>(path.join(dir, "studio.json")).catch(() => null);
  const pkg = await readPackageManifest(dir);
  const hasBuild = typeof pkg?.scripts?.build === "string" && pkg.scripts.build.trim().length > 0;
  if (typeof meta?.contractVersion === "number" && !hasBuild) return null;

  const srcs = pageScripts(html);
  const [firstLocal] = srcs.filter((src) => !isRemoteSrc(src));
  // A page whose scripts are all inline or all CDN tags still has an entry: itself. Naming
  // index.html keeps `main` a file the owner can open, and keeps the ownership rules honest.
  const main = firstLocal === undefined ? "index.html" : projectRelative(firstLocal);
  const names = (await readdir(dir, { withFileTypes: true }).catch(() => [])).map((entry) => entry.name);
  const entryText = main === "index.html" ? null : await readFile(path.join(dir, main), "utf8").catch(() => null);
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

/** The most arguments a declared play command may carry. */
const MAX_PLAY_ARGS = 32;
/** The longest single argument of a declared play command. */
const MAX_PLAY_ARG_CHARS = 1024;

/** One argument of a play command: a string of bounded length with no NUL, which no shell word can carry. */
function usablePlayArg(arg: unknown): arg is string {
  return typeof arg === "string" && arg.length <= MAX_PLAY_ARG_CHARS && !arg.includes("\0");
}

/**
 * A play command as studio.json declares it, or null when any part is unusable: the command a
 * plain path inside the folder (never absolute, never `..`, never a shell character or an
 * option), the arguments a short list of strings. Nothing is resolved here — the command's real
 * path is checked by {@link resolvePlayCommand} right before it runs.
 */
function declaredPlay(raw: unknown): PlayCommand | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const { command, args, engine } = raw as { command?: unknown; args?: unknown; engine?: unknown };
  if (typeof command !== "string" || !plainRelativePath(command)) return null;
  const words = playArgs(args);
  if (!words) return null;
  const runs = declaredEngine(engine);
  return runs ? { command, args: words, engine: runs } : { command, args: words };
}

/** A play's arguments: none when absent, else at most 32 usable words; null when unusable. */
function playArgs(args: unknown): string[] | null {
  if (args === undefined) return [];
  if (!Array.isArray(args) || args.length > MAX_PLAY_ARGS || !args.every(usablePlayArg)) return null;
  return [...args];
}

/** A plugin runtime's id as a manifest declares it: never a path, never a shell word. */
const ENGINE_RUNTIME = /^[a-z][a-z0-9-]{0,39}$/;

/** The engine a play names: a runtime id and its arguments; null when absent or unusable (the command still stands). */
function declaredEngine(raw: unknown): PlayEngine | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const { runtime, args } = raw as { runtime?: unknown; args?: unknown };
  if (typeof runtime !== "string" || !ENGINE_RUNTIME.test(runtime)) return null;
  const words = playArgs(args);
  return words ? { runtime, args: words } : null;
}

/**
 * The runtime studio.json declares, and a bridge game's play command; nothing for an unknown
 * runtime — or for the desktop or a VM, which a game's folder never grants itself.
 */
function declaredRuntime(meta: ShapeMeta | null): Pick<ProjectShape, "runtime" | "play"> {
  const runtime = GAME_RUNTIMES.find((known) => known === meta?.runtime);
  if (!runtime) return {};
  const play = runtime === TargetRuntime.Bridge ? declaredPlay(meta?.play) : null;
  return play ? { runtime, play } : { runtime };
}

/**
 * The real path of a bridge game's play command: inside the project once every link is
 * followed, or a throw. Checked right before the command runs, because studio.json and the
 * folder it names are both writable by any contractor between a read and a launch.
 */
export async function resolvePlayCommand(dir: string, play: PlayCommand): Promise<string> {
  if (!plainRelativePath(play.command)) throw new Error(`not a plain path inside the project: ${play.command}`);
  return containedReal(dir, play.command);
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
  runtime?: unknown;
  play?: unknown;
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

/** The shape studio.json records, with what it leaves out detected once from the folder. */
async function recordedShape(dir: string, meta: ShapeMeta): Promise<ProjectShape> {
  const entry = trimmedText(meta.entry) ?? TEMPLATE_SHAPE.entry;
  const main =
    typeof meta.main === "string" && plainRelativePath(meta.main.trim()) ? meta.main.trim() : TEMPLATE_SHAPE.main;
  const build = trimmedText(meta.build);
  // (See `recordedInstall` for why only a package manager's own install is read from here.)
  const declaresInstall = meta.install === null || isInstallCommand(meta.install);
  // studio.json written before shapes carried own/kind/serve/install: the folder is still there
  // to read, so those are detected once. A shape recorded without the flag always meant "the
  // game's own": adoption is the only writer of one, and it records only a game of its own.
  const detected = isProjectKind(meta.kind) && declaresInstall ? null : await detectProjectShape(dir);
  const kind = isProjectKind(meta.kind) ? meta.kind : (detected?.kind ?? null);
  const own = typeof meta.own === "boolean" ? meta.own : true;
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
  const meta = await readJsonIfExists<ShapeMeta>(path.join(dir, "studio.json")).catch(() => null);
  // A folder may declare only how long it takes to boot, so the number is read before the
  // shape's own early return — and attached with a spread, never a mutation: TEMPLATE_SHAPE is
  // shared, and an undefined-valued key would break every shape a test compares whole.
  const bootMs = declaredBootMs(meta?.bootMs);
  const declaredBoot = { ...(bootMs === null ? {} : { bootMs }), ...declaredRuntime(meta) };
  if (!meta || !recordsShape(meta)) {
    const detected = (await detectProjectShape(dir)) ?? TEMPLATE_SHAPE;
    return { ...detected, ...declaredBoot };
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
  if (isNotesFolder(entry)) return false;
  const extension = path.extname(entry.name).toLowerCase();
  return !(entry.isFile() && (NOT_OWN_FILES.NoteExtensions as readonly string[]).includes(extension));
}

/** Whether a top-level entry is the project's notes folder (`docs/`). */
const isNotesFolder = (entry: TopEntry): boolean => entry.isDirectory() && entry.name === NOT_OWN_FILES.NotesFolder;

/**
 * Whether a folder holds anything visible but the one folder Genex writes there (`genexFolder`); one
 * that can't be read does.
 */
async function holdsBesides(folder: string, genexFolder: string): Promise<boolean> {
  const inside = await readdir(folder, { withFileTypes: true }).catch(() => null);
  if (!inside) return true;
  return inside.some((child) => !child.name.startsWith(".") && !(child.isDirectory() && child.name === genexFolder));
}

/**
 * Whether a top-level entry is the folder's own work (`isOwnEntry`), reading into `public/`: one that
 * holds nothing but the folder Genex writes there (and hidden files) is Genex's output, not the
 * folder's own.
 */
async function ownEntry(dir: string, entry: TopEntry): Promise<boolean> {
  if (!isOwnEntry(entry)) return false;
  const genexFolder = entry.isDirectory() ? NOT_OWN_FILES.GenexInside.get(entry.name) : undefined;
  if (!genexFolder) return true;
  return holdsBesides(path.join(dir, entry.name), genexFolder);
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
 * Whether a top-level entry is a note: a loose one (`isNote`), or the notes folder (`docs/`) holding
 * anything but the design board.
 */
async function noteEntry(dir: string, entry: TopEntry): Promise<boolean> {
  if (isNote(entry)) return true;
  return isNotesFolder(entry) && holdsBesides(path.join(dir, entry.name), NOT_OWN_FILES.DesignBoard);
}

/** Whether any top-level entry is a note (`noteEntry`). */
async function anyNoteEntry(dir: string, entries: readonly TopEntry[]): Promise<boolean> {
  for (const entry of entries) if (await noteEntry(dir, entry)) return true;
  return false;
}

/**
 * Whether a folder holds files of its own: any top-level entry but a hidden one, Genex's own
 * bookkeeping (`studio.json`, `references/`), the folder its asset tools deliver into (`assets/`, or a
 * `public/` holding only that), the project's notes folder (`docs/`, its design board included) and
 * loose notes at the root (`*.md`, `*.txt`).
 */
export async function holdsOwnFiles(dir: string): Promise<boolean> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return anyOwnEntry(dir, entries);
}

/**
 * What a folder holds at its top level, besides hidden files, Genex's bookkeeping and its asset
 * deliveries: files of its own (`holdsOwnFiles`), notes only (`noteEntry`), or nothing. Throws when the folder
 * can't be read.
 */
export async function folderHolds(dir: string): Promise<FolderHolds> {
  const entries = await readdir(dir, { withFileTypes: true });
  if (await anyOwnEntry(dir, entries)) return FolderHolds.OwnFiles;
  return (await anyNoteEntry(dir, entries)) ? FolderHolds.Notes : FolderHolds.Nothing;
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

/** One folder as a game candidate, or null when it has no page a browser can open. */
async function gameCandidate(target: string, rel: string): Promise<GameCandidate | null> {
  if (!(await pathExists(path.join(target, "index.html")))) return null;
  const pkg = await readPackageManifest(target);
  const shape = await readProjectShape(target);
  const why = ["index.html"];
  if (pkg) why.push(pkg.scripts?.build ? `package.json (build: ${pkg.scripts.build})` : "package.json");
  if (await pathExists(path.join(target, ".git"))) why.push("its own git repository");
  return { rel, dir: target, shape, why };
}

/**
 * Every game in a folder and one level under it. A user who drops their game inside a project
 * folder used to be told the folder was empty, wrapped in a template and hand-ported for the whole run
 *; the fix is to look one level down and say what is there.
 *
 * A candidate is a folder with an `index.html` — the page a browser can open. Nothing is
 * written, nothing is chosen: the caller decides, and can ask.
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
