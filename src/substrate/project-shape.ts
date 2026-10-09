/**
 * How a game folder runs: its entry, its build, the folder the preview serves and what kind of
 * game it is — recorded in studio.json, or read from the evidence in the folder itself.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { GameCandidate, ProjectKind, ProjectShape } from "../shared/game-project.ts";
import { pathExists, readJsonIfExists } from "./fsx.ts";
import { isRemoteSrc, pageScripts, projectRelative } from "./game-page.ts";
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
 * Read a folder's own shape from the evidence in it: every script the page loads, the package's
 * build script and dependencies, the bundler's output folder, the engine's runtime files.
 * `null` means the studio's own template — recognised only by the two things the studio itself
 * writes, the `contractVersion` in studio.json and the vendored-three import map. Everything
 * else in the world is somebody's own game.
 */
export async function detectProjectShape(dir: string): Promise<ProjectShape | null> {
  const html = await readFile(path.join(dir, "index.html"), "utf8").catch(() => null);
  if (html === null) return null;
  const meta = await readJsonIfExists<{ contractVersion?: unknown }>(path.join(dir, "studio.json")).catch(() => null);
  if (typeof meta?.contractVersion === "number" && html.includes(STUDIO_IMPORT_MAP)) return null;

  const srcs = pageScripts(html);
  const [firstLocal] = srcs.filter((src) => !isRemoteSrc(src));
  // A page whose scripts are all inline or all CDN tags still has an entry: itself. Naming
  // index.html keeps `main` a file the owner can open, and keeps the ownership rules honest.
  const main = firstLocal === undefined ? "index.html" : projectRelative(firstLocal);
  const pkg = await readPackageManifest(dir);
  const hasBuild = typeof pkg?.scripts?.build === "string" && pkg.scripts.build.trim().length > 0;
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
  const detected = isProjectKind(meta.kind) && declaresInstall ? null : await detectProjectShape(dir);
  const kind = isProjectKind(meta.kind) ? meta.kind : (detected?.kind ?? null);
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
  const meta = await readJsonIfExists<ShapeMeta>(path.join(dir, "studio.json")).catch(() => null);
  // A folder may declare only how long it takes to boot, so the number is read before the
  // shape's own early return — and attached with a spread, never a mutation: TEMPLATE_SHAPE is
  // shared, and an undefined-valued key would break every shape a test compares whole.
  const bootMs = declaredBootMs(meta?.bootMs);
  const declaredBoot = bootMs === null ? {} : { bootMs };
  if (!meta || !recordsShape(meta)) {
    const detected = (await detectProjectShape(dir)) ?? TEMPLATE_SHAPE;
    return bootMs === null ? detected : { ...detected, ...declaredBoot };
  }
  return { ...(await recordedShape(dir, meta)), ...declaredBoot };
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
