/**
 * The static check run before every judged build: does the page exist, does what it loads run in
 * a browser as written, and does it load (or can the studio attach) the contract the judge reads.
 * Read-only: nothing here writes into the game folder.
 */
import { createHash } from "node:crypto";
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
  unreachableLoads,
} from "./game-page.ts";
import { isInside, toPosixRelative } from "./paths.ts";
import { readProjectShape } from "./project-shape.ts";
import { validateUnityProject } from "./unity-project.ts";

/** The most modules the reachable-source walk opens; a larger game is judged on its first ones. */
const MAX_REACHABLE_SOURCES = 400;
/** How many unresolved package names the problem names before it stops listing. */
const LISTED_UNRESOLVED_IMPORTS = 3;
/** The extensions a bundler would try on a specifier written without one, in its order. */
const MODULE_EXTENSIONS = [".js", ".mjs", ".ts", ".tsx", ".jsx"];

/**
 * The one problem that decides whether a build can be judged at all. It is read by a person —
 * the Open Game sheet prints it under "Before a run can judge it" — so it says what the run
 * will do about it rather than handing the user two lines of JavaScript to type: installing the
 * contract is the base builder's first job (loop/director.ts `installContract`), and the brief
 * the engine reads is where the two lines belong.
 */
export const NO_CONTRACT_PROBLEM =
  "nothing on your page connects the studio to your game yet — the studio adds its connection to your entry before the first builder starts (until then the judge cannot score this build)";

const MESSAGE = {
  MissingFile: (file: string) => `${file} is missing`,
  UnreachableHosts: (hosts: string[]) =>
    `index.html loads code or styles from ${hosts.join(", ")}, which the studio's preview cannot reach (it allows only public library and font CDNs) — the game will not run here until those files are copied into the game folder and loaded from there`,
  UnresolvedPackages: (main: string, names: string[]) =>
    `${main} imports ${names
      .slice(0, LISTED_UNRESOLVED_IMPORTS)
      .map((name) => `"${name}"`)
      .join(
        ", ",
      )} as packages, and nothing here resolves them — this game needs a build command (studio.json "build") or an import map`,
  TypescriptUnbuilt: (file: string) =>
    `${file} is TypeScript and nothing here builds it — a browser cannot run it as written; this game needs a build command (studio.json "build")`,
  MathRandom: (file: string) => `${file} uses Math.random() — runs will not be comparable`,
  BootsPaused:
    "studio.js boots paused (`let running = false`) and nothing calls start() — the game will sit on one frozen frame",
  PredatesInspect:
    "src/studio.js predates the v2 contract (no inspect()) — scene checks and eye cameras are unavailable",
  NoPlayer: "installStudio() is called without scene/camera/player — scene checks fail and eye cameras do not exist",
  UnityEditor:
    "Unity source project: connect Unity Editor through the Unity plugin to inspect compilation, play mode, tests and builds. Browser preview and browser scoring do not apply.",
} as const;

/** What `validateGameDir` found: the problems that stop a judged build, the warnings, and the contract's word. */
export interface GameValidation {
  ok: boolean;
  problems: string[];
  warnings: string[];
  contract: ContractWord;
  reach: ContractReach;
  shape: ProjectShape;
}

/**
 * Which vintage of the contract module a copy of `src/studio.js` is, so an upgrade can compare
 * a game's copy against the shipped template's instead of sniffing for one feature. Every
 * generation carries the literals of the ones before it: a copy that predates M4 already holds
 * both `inspect()` and `hud: hud.api`, so those two alone cannot tell it from the current file
 * and every already-scaffolded game kept a contract nothing would replace.
 *
 * 0 no file at all, 1 predates `inspect()`, 2 has `inspect()` and no HUD, 3 the one-screen
 * contract (HUD and input), 4 the M4 contract: the HUD is a lazy facade over `./hud.js` and an
 * eye camera is borrowed from the game and given back, 5 the HUD facade forwards arc, panel,
 * path, image and font and reports a bounded summary before the module loads, 6 the racing-line
 * assist (`config.steer`, `assist()`) the harness's drive and its throttle-only bot steer by.
 */
export function studioContractGeneration(source: string | null): number {
  if (source === null) return 0;
  if (/\bwithAssistKeys\s*\(/.test(source)) return 6;
  if (/\bunloadedHudSummary\s*\(/.test(source)) return 5;
  if (/\bcreateHudFacade\s*[(=]/.test(source) || /\bborrowedCamera\b/.test(source)) return 4;
  if (!/\binspect\s*[(:]/.test(source)) return 1;
  return /\bhud\s*:\s*hud\.api/.test(source) ? 3 : 2;
}

/**
 * Every `src/hud.js` the studio shipped before the current generation, by the SHA-256 of its text
 * with LF line endings, and the generation it is. When the template's `HUD_GENERATION` moves on,
 * the outgoing file's digest joins this table, or games scaffolded with it keep it for good.
 */
const SHIPPED_HUD_DIGESTS: Readonly<Record<string, number>> = {
  // Generation 1 (text, bar, crosshair): as Milestone 4 shipped it, after the Biome format, and
  // after the readability pass (the copy in Genex 0.1.0).
  "09dcdfa1b7a45142c081ef972a0388857ac2e4df49432a7f17cbf88e1b5996c5": 1,
  b08796505b9628fb9fc4a0c1bfa6eb422dfa23cb801f6ea99cf88f2efddd21ad: 1,
  dbde5256b725fa00c10f81463de1975164c92413765ac76eb789d033e4be0b98: 1,
};

/**
 * Which HUD a copy of `src/hud.js` is: 0 no file at all, 1 a copy that predates `HUD_GENERATION`
 * (text, bar and crosshair only), otherwise the generation it declares.
 */
export function hudContractGeneration(source: string | null): number {
  if (source === null) return 0;
  const declared = /\bexport\s+const\s+HUD_GENERATION\s*=\s*(\d+)/.exec(source);
  return declared ? Number(declared[1]) : 1;
}

/**
 * The generation of a `src/hud.js` that is byte for byte a copy the studio shipped (line endings
 * aside, so a CRLF checkout still counts), or null for a copy anyone edited — the only copies an
 * upgrade may replace, because `src/hud.js` is the main owner's to change.
 */
export function shippedHudGeneration(source: string | null): number | null {
  if (source === null) return null;
  return SHIPPED_HUD_DIGESTS[shippedDigest(source)] ?? null;
}

/**
 * Every `src/studio.js` the studio shipped before the current contract generation, by the SHA-256
 * of its text with LF line endings, and the generation it is. When `studioContractGeneration` of
 * the template moves on, the outgoing file's digest joins this table, or every game scaffolded
 * with it keeps it for good.
 */
const SHIPPED_STUDIO_DIGESTS: Readonly<Record<string, number>> = {
  // Generation 1: the first contract and the four revisions before `inspect()`.
  e8b340183c844107ab383cea0e2c01146fc9ba8d1dd258006fe18b684eb027ad: 1,
  f1c7b794be11342132d323a9c0ff7b7e82d47c9facb8cd48f14bd297263c89ec: 1,
  "6cecdcae53ea95824171084412ca5fef0ab97b505c5dec1c603c22241ab904cc": 1,
  "4b05db6f5a84b2731d2c2bf616dfdbe90f7dbee5e57e243cac3d4e08d3ece826": 1,
  "108ea3647d1e5c2ca19f458e46506c438262930b3b1ae53584a7214a756c5ad9": 1,
  // Generation 2: `inspect()`, no HUD.
  "1e5eba4f5dc902cf2e37f5771828997ec390b7d946e46f18d0b2df8b5f26a9b5": 2,
  // Generation 3: the one-screen contract, in its three revisions.
  "39280834f2d9b7dbc3062913b887ac7eccc39d7639c0b9e750f862d9a9616b4c": 3,
  "8910ec523c731f8a46a2c010ad2a079fb3129fade999127f18492085c95b72ef": 3,
  "0e434144f125652d1d313fd754875593dfc6200270313b68975fe49af287271e": 3,
  // Generation 4: as Milestone 4 shipped it, after the Biome format, after the readability pass
  // (the copy in Genex 0.1.0 through 0.1.3), and the two front-end revisions before the HUD facade
  // grew arcs and panels.
  f84776dfbfeda103c6a5679fe074f019b3e6cf5da2605e7ac701423811e3352b: 4,
  "34918eb93990699fcac7b2c3f0d534984a5522cdb308112392e34c6a20ce8319": 4,
  "3fa898dbff35227ae6815493b46ac252aa95ab7fe180150a10e05362a1ca2ece": 4,
  "64dc5359ff81f8edd7ab815c2d48ca114db0a065dd95bb8a72df1dbccc4faf31": 4,
  a7221ced2600350b8d8ade6dd6da421fe766132c611c5b6651fa7fad86ea9102: 4,
  // Generation 5: arcs, panels, paths, images and fonts, in its two revisions before the
  // racing-line assist.
  "77f1c1d367c1e63225ff34b10136c04c4866932793a754ce0ff381ae1c7cd384": 5,
  f5f4cc72c37a789c4f1c1b66bf69bd7e63fa7fe0f1993498f36a72872a62b2da: 5,
};

/**
 * The generation of a `src/studio.js` that is byte for byte a copy the studio shipped (line endings
 * aside), or null for a copy anyone edited. The template asks the main owner to extend the file, so
 * only a shipped copy may be replaced: an edited one carries exports the game may import.
 */
export function shippedStudioGeneration(source: string | null): number | null {
  if (source === null) return null;
  return SHIPPED_STUDIO_DIGESTS[shippedDigest(source)] ?? null;
}

/** The SHA-256 a shipped-copy table keys a file by: its text with LF line endings. */
function shippedDigest(source: string): string {
  return createHash("sha256").update(source.replace(/\r\n/g, "\n")).digest("hex");
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

/** What the page's own sources do with the contract, as `scanContractUse` reads them. */
interface ContractUse {
  installsContract: boolean;
  hasPlayer: boolean;
  hasInspect: boolean;
  bootsPaused: boolean;
  callsStart: boolean;
  /** Game sources (relative to the folder) that call `Math.random()`, in the order read. */
  randomUsers: string[];
}

/** Read every reachable source for the contract's traces: the module itself, and the game's calls into it. */
async function scanContractUse(dir: string, sources: string[]): Promise<ContractUse> {
  const use: ContractUse = {
    installsContract: false,
    hasPlayer: false,
    hasInspect: false,
    bootsPaused: false,
    callsStart: false,
    randomUsers: [],
  };
  for (const file of sources) {
    const text = await readFile(file, "utf8").catch(() => "");
    // `studio.js` is the contract itself: it contains both literals whatever the game does
    // with it, and counting it made every folder holding the file report "loaded" — which is
    // how a game the studio could only attach to was told to install what was never called.
    if (file.endsWith("studio.js")) noteContractModule(use, text);
    else noteGameSource(use, toPosixRelative(path.relative(dir, file)), text);
  }
  return use;
}

function noteContractModule(use: ContractUse, text: string): void {
  if (/inspect/.test(text)) use.hasInspect = true;
  // The declaration only — seed() and pause() legitimately assign `running = false`.
  if (/let\s+running\s*=\s*false/.test(text)) use.bootsPaused = true;
}

function noteGameSource(use: ContractUse, rel: string, text: string): void {
  const installs = /installStudio\s*\(/.test(text);
  if (/window\.__studio\s*=/.test(text) || installs) use.installsContract = true;
  if (installs && /\bplayer\s*[:(]/.test(text)) use.hasPlayer = true;
  if (/\bMath\.random\s*\(/.test(text)) use.randomUsers.push(rel);
  if (/\.start\s*\(/.test(text)) use.callsStart = true;
}

/**
 * Attached, not installed: the serve layer points the page's own `three` at the studio's
 * wrapper, and the hook reads the scene, camera and renderer off the frames the game draws
 * (M4.2a). That only works on a page a browser can actually run, so a TypeScript entry with
 * no build is `missing` with the build's own sentence, never `attached`.
 */
function contractWord(installsContract: boolean, reach: ContractReach, nonExecutable: string | null): ContractWord {
  if (installsContract) return ContractWord.Loaded;
  if (reach !== "none" && !nonExecutable) return ContractWord.Attached;
  return ContractWord.Missing;
}

/** The warnings about an installed contract: a paused boot nothing starts, and a contract too old or too bare to score. */
function contractWarnings(use: ContractUse): string[] {
  if (!use.installsContract) return [];
  const warnings: string[] = [];
  if (use.bootsPaused && !use.callsStart) warnings.push(MESSAGE.BootsPaused);
  // The v2 contract (scene checks, eye cameras) is a warning, not a problem: an older game
  // still judges by taste; it just cannot be scored mechanically.
  if (!use.hasInspect) warnings.push(MESSAGE.PredatesInspect);
  else if (!use.hasPlayer) warnings.push(MESSAGE.NoPlayer);
  return warnings;
}

/**
 * Static check run before every judged build. It catches the two failures that would otherwise
 * waste a whole gauntlet iteration: a missing entry point, and a game that abandoned the
 * contract (hard-coded `Math.random`, no `window.__studio`).
 */
export async function validateGameDir(dir: string): Promise<GameValidation> {
  const problems: string[] = [];
  const warnings: string[] = [];
  const shape = await readProjectShape(dir);
  if (shape.kind === "unity") {
    const nativeProblems = await validateUnityProject(dir);
    return {
      ok: nativeProblems.length === 0,
      problems: nativeProblems,
      warnings: [MESSAGE.UnityEditor],
      contract: ContractWord.Missing,
      reach: "none",
      shape,
    };
  }
  const indexExists = await pathExists(path.join(dir, "index.html"));
  if (!indexExists) problems.push(MESSAGE.MissingFile("index.html"));
  if (!(await pathExists(path.join(dir, shape.main)))) problems.push(MESSAGE.MissingFile(shape.main));

  // Only what the page actually loads. A template `src/main.js` left beside a Godot export or
  // a Vite game used to prove the contract on the studio's own dead scaffold, so validation
  // passed and every judge then reported "window.__studio is missing" on the real page.
  const { files: sources, unresolved } = await reachableSources(dir, shape);
  const html = (await readFile(path.join(dir, "index.html"), "utf8").catch(() => "")) ?? "";
  const mapped = importMapKeys(html);
  // R6: the preview reaches only the public library/font CDNs (preview-network.ts). Said here,
  // where both the Open Game sheet and a builder's validate call read it, rather than as a
  // console warning on a page that already failed.
  const remote = unreachableLoads(html);
  if (remote.length > 0) problems.push(MESSAGE.UnreachableHosts(remote));
  // No page, nothing to compose: the serve layer rewrites the page it serves, and there is none.
  const reach: ContractReach = indexExists ? threeReach({ html, build: shape.build, mapped, unresolved }) : "none";
  const unresolvedProblem = unresolvedImportsProblem(shape, mapped, unresolved);
  if (unresolvedProblem) problems.push(unresolvedProblem);

  const use = await scanContractUse(dir, sources);
  warnings.push(...use.randomUsers.map((rel) => MESSAGE.MathRandom(rel)));
  const nonExecutable = reach === "none" ? null : nonExecutableSource(sources);
  if (nonExecutable) problems.push(MESSAGE.TypescriptUnbuilt(toPosixRelative(path.relative(dir, nonExecutable))));
  // The one problem the run can do something about on its own: a page that never loads the
  // contract is unjudgeable, and installing it is the first thing a run does (loop/director.ts
  // `installContract`). Answered as a word rather than left for every caller to match the
  // sentence in `problems` — the folder sheet already read it that way.
  const contract = contractWord(use.installsContract, reach, nonExecutable);
  if (contract === ContractWord.Missing) problems.push(NO_CONTRACT_PROBLEM);
  warnings.push(...contractWarnings(use));
  return { ok: problems.length === 0, problems, warnings, contract, reach, shape };
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
  // .html because a page may install the contract from an inline module and import from there.
  if (/\.(js|mjs|ts|tsx|jsx|html)$/.test(file) && (await pathExists(file))) return file;
  for (const candidate of [file, `${file}/index`]) {
    for (const ext of MODULE_EXTENSIONS) {
      if (await pathExists(`${candidate}${ext}`)) return `${candidate}${ext}`;
    }
  }
  // `import "./studio.js"` in a TypeScript project means studio.ts — the compiler's own rule.
  const swapped = file.replace(/\.js$/, ".ts");
  if (swapped !== file && (await pathExists(swapped))) return swapped;
  return null;
}
