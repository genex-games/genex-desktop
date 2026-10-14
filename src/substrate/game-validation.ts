/**
 * The static check run before every judged build: does the page exist, does what it loads run in
 * a browser as written, and does it load (or can the studio attach) the contract the judge reads.
 * Read-only: nothing here writes into the game folder.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import {
  type CompiledStack,
  ContractWord,
  GameStack,
  GameValidationCode,
  isCompiledStack,
  type ProjectShape,
  stackOf,
} from "../shared/game-project.ts";
import { kindWords } from "../shared/shape-words.ts";
import { entryExists, pathExists } from "./fsx.ts";
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
import {
  cmakeCallsGenexAddGame,
  GENEX_MANIFEST,
  readGameDestinations,
  readGameText,
  readNativeSource,
  readProjectShape,
} from "./project-shape.ts";

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
  NotAPlainFile: (file: string) =>
    `${file} is not a plain file the studio can read (a link, a pipe or a folder) — the C++ lane builds only from a plain file`,
  RustNotAPlainFile: (file: string) =>
    `${file} is not a plain file the studio can read (a link, a pipe or a folder) — the Rust lane builds only from a plain file`,
  RustOwnBuildInput: (file: string) =>
    `${file} is a build input of the game's own — the studio writes the Rust manifest and lock from genex.toml and runs no build script or cargo configuration, so it refuses to build this game until ${file} is removed`,
  GenexInstallRemoved: (main: string) =>
    `${main} does not call genex::install(…) — the studio cannot step, inspect or capture this game until it does`,
  KindUnsupported:
    "a newer version of Genex made this game (studio.json names a kind this version does not know), so it opens read-only — update Genex to build or change it",
  NeedsGenexCmake:
    "CMakeLists.txt does not call genex_add_game(…) — the studio builds C++ games through it, so this one cannot be built or judged until it does",
  NativeContractRemoved: (main: string) =>
    `${main} does not call studio::install(…) — the studio cannot step, inspect or capture this game until it does`,
  StackContradictsKind: (kind: string) =>
    `studio.json names a stack this folder's files are not: it is ${kind}, and the files decide — correct or remove studio.json's "stack"`,
} as const;

/** What `validateGameDir` found: the problems that stop a judged build, the warnings, and the contract's word. */
export interface GameValidation {
  ok: boolean;
  problems: string[];
  /** The files a web page needs that are not there, by name; `problems` says the same in sentences. */
  missing: string[];
  warnings: string[];
  contract: ContractWord;
  reach: ContractReach;
  shape: ProjectShape;
  /**
   * The typed reasons among `problems`, in their order, so no reader matches a sentence. Every
   * problem of a C++ game has one; a browser game's missing files and missing contract do.
   */
  codes: GameValidationCode[];
}

/** Problems and their codes, collected side by side. */
function findings() {
  const problems: string[] = [];
  const codes: GameValidationCode[] = [];
  const fail = (problem: string, code?: GameValidationCode): void => {
    problems.push(problem);
    if (code) codes.push(code);
  };
  return { problems, codes, fail };
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
    const text = (await readGameText(file)) ?? "";
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
  const shape = await readProjectShape(dir);
  // A newer Genex's game: nothing here can judge it, and nothing runs on it.
  if (shape.readOnly) return readOnlyValidation(shape);
  // A compiled game has no page of its own: its checks are its project files and its entry.
  const stack = stackOf(shape);
  if (isCompiledStack(stack)) return COMPILED_VALIDATIONS[stack](dir, shape);
  const { problems, codes, fail } = findings();
  const warnings: string[] = [];
  const indexExists = await pathExists(path.join(dir, "index.html"));
  const missing: string[] = [];
  if (!indexExists) missing.push("index.html");
  if (!(await pathExists(path.join(dir, shape.main)))) missing.push(shape.main);
  for (const file of missing) fail(MESSAGE.MissingFile(file), GameValidationCode.MissingFile);

  // Only what the page actually loads. A template `src/main.js` left beside a Godot export or
  // a Vite game used to prove the contract on the studio's own dead scaffold, so validation
  // passed and every judge then reported "window.__studio is missing" on the real page.
  const { files: sources, unresolved } = await reachableSources(dir, shape);
  const html = (await readGameText(path.join(dir, "index.html"))) ?? "";
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
  if (contract === ContractWord.Missing) fail(NO_CONTRACT_PROBLEM, GameValidationCode.NoContract);
  warnings.push(...contractWarnings(use));
  const destinations = await readGameDestinations(dir, shape, null);
  warnings.push(...destinations.warnings);
  if (destinations.stackContradicts)
    fail(MESSAGE.StackContradictsKind(kindWords(shape.kind)), GameValidationCode.StackContradictsKind);
  return { ok: problems.length === 0, problems, missing, warnings, contract, reach, shape, codes };
}

/** The tokens of a `studio::install(` call, in order, as {@link cppToken} reads them. */
const INSTALL_CALL = ["studio", "::", "install", "("] as const;
/** The prefixes that make a string literal raw: `R"delim( … )delim"`, inside which nothing is code. */
const RAW_STRING_PREFIXES = new Set(["R", "LR", "uR", "UR", "u8R"]);
/** The longest delimiter a raw string may have. */
const MAX_RAW_DELIMITER = 16;
/** The characters C++ reads as space between tokens. */
const CPP_SPACE = new Set([" ", "\t", "\n", "\r", "\f", "\v"]);
/** The letters after which a pp-number's `+` or `-` is an exponent's sign (`1e+5`, `0x1p-3`). */
const EXPONENTS = new Set(["e", "E", "p", "P"]);

/**
 * One C++ token and where the next starts. `value` is an identifier or a punctuator; "" is a
 * literal or a number, which no call is made of; null is what the compiler never sees (space, a
 * comment), which leaves the tokens around it adjacent.
 */
interface CppToken {
  value: string | null;
  end: number;
}

function isDigit(char: string): boolean {
  return char >= "0" && char <= "9";
}

/** A letter, a digit or `_`: what an identifier or a pp-number is made of. */
function isWordChar(char: string): boolean {
  const letter = (char >= "a" && char <= "z") || (char >= "A" && char <= "Z");
  return letter || isDigit(char) || char === "_";
}

/** From just after `//`: where the comment ends, a backslash at a line's end carrying it onto the next. */
function lineCommentEnd(text: string, from: number): number {
  let newline = text.indexOf("\n", from);
  while (newline !== -1 && endsWithSplice(text, newline)) newline = text.indexOf("\n", newline + 1);
  return newline === -1 ? text.length : newline;
}

/** Whether the line ending at `newline` ends in a backslash, which splices the next line onto it. */
function endsWithSplice(text: string, newline: number): boolean {
  const last = text.charAt(newline - 1) === "\r" ? newline - 2 : newline - 1;
  return text.charAt(last) === "\\";
}

/** From just inside a block comment: the index after the star and slash that close it, or the text's end. */
function blockCommentEnd(text: string, from: number): number {
  const close = text.indexOf("*/", from);
  return close === -1 ? text.length : close + 2;
}

/** From just inside a string or character literal: the index after its closing `quote`, or its line's end. */
function literalEnd(text: string, from: number, quote: string): number {
  let at = from;
  while (at < text.length) {
    const char = text.charAt(at);
    if (char === quote) return at + 1;
    if (char === "\n") return at;
    at += char === "\\" ? 2 : 1;
  }
  return text.length;
}

/** Whether `char` may be part of a raw string's delimiter. */
function isRawDelimiterChar(char: string): boolean {
  return char !== "" && char !== ")" && char !== "\\" && char !== '"' && !CPP_SPACE.has(char);
}

/**
 * From a raw string's opening quote: the index after its `)delim"`, or the text's end when it never
 * closes; null when no valid delimiter and `(` follow, so the quote opens an ordinary string.
 */
function rawStringEnd(text: string, quote: number): number | null {
  for (let at = quote + 1; at <= quote + 1 + MAX_RAW_DELIMITER; at++) {
    const char = text.charAt(at);
    if (char === "(") {
      const closing = `)${text.slice(quote + 1, at)}"`;
      const close = text.indexOf(closing, at + 1);
      return close === -1 ? text.length : close + closing.length;
    }
    if (!isRawDelimiterChar(char)) return null;
  }
  return null;
}

/** How many characters at `at` still belong to a pp-number: digit separators and exponent signs too; 0 at its end. */
function numberStep(text: string, at: number): number {
  const char = text.charAt(at);
  if (isWordChar(char) || char === ".") return 1;
  if (char === "'" && isWordChar(text.charAt(at + 1))) return 2;
  const signed = (char === "+" || char === "-") && EXPONENTS.has(text.charAt(at - 1));
  return signed ? 1 : 0;
}

/** From a pp-number's first character: the index after it. */
function numberEnd(text: string, from: number): number {
  let at = from + 1;
  for (let step = numberStep(text, at); step > 0; step = numberStep(text, at)) at += step;
  return at;
}

/** From an identifier's first character: the identifier, or the raw string it is the prefix of. */
function wordToken(text: string, from: number): CppToken {
  let end = from + 1;
  while (isWordChar(text.charAt(end))) end++;
  const word = text.slice(from, end);
  if (RAW_STRING_PREFIXES.has(word) && text.charAt(end) === '"') {
    const raw = rawStringEnd(text, end);
    if (raw !== null) return { value: "", end: raw };
  }
  return { value: word, end };
}

/** One C++ token from `at`, which is never inside one. Every token is at least one character long. */
function cppToken(text: string, at: number): CppToken {
  const char = text.charAt(at);
  const next = text.charAt(at + 1);
  if (CPP_SPACE.has(char)) return { value: null, end: at + 1 };
  if (char === "/" && next === "/") return { value: null, end: lineCommentEnd(text, at + 2) };
  if (char === "/" && next === "*") return { value: null, end: blockCommentEnd(text, at + 2) };
  if (char === '"' || char === "'") return { value: "", end: literalEnd(text, at + 1, char) };
  if (isDigit(char) || (char === "." && isDigit(next))) return { value: "", end: numberEnd(text, at) };
  if (isWordChar(char)) return wordToken(text, at);
  if (char === ":" && next === ":") return { value: "::", end: at + 2 };
  return { value: char, end: at + 1 };
}

/** How much of `studio::install(` has been read once `value` follows its first `matched` tokens. */
function installProgress(matched: number, value: string): number {
  if (value === INSTALL_CALL[matched]) return matched + 1;
  return value === INSTALL_CALL[0] ? 1 : 0;
}

/**
 * Whether C++ source calls `studio::install(`. Read token by token in one forward pass, the way a
 * compiler reads it: comments, string, character and raw string literals never count, and a
 * hostile file costs its length and nothing more.
 */
function installsNativeContract(source: string): boolean {
  let matched = 0;
  let at = 0;
  while (at < source.length) {
    const token = cppToken(source, at);
    at = token.end;
    if (token.value === null) continue;
    matched = installProgress(matched, token.value);
    if (matched === INSTALL_CALL.length) return true;
  }
  return false;
}

/** Why a file the C++ lane needs cannot be read: it is not there, or it is not a plain file. */
async function unreadable(dir: string, file: string, notPlain = MESSAGE.NotAPlainFile): Promise<string> {
  return (await pathExists(path.join(dir, file))) ? notPlain(file) : MESSAGE.MissingFile(file);
}

/**
 * The static check of a C++ · raylib game: a CMake project that builds through `genex_add_game`,
 * an entry that installs the C++ contract, and a studio.json that does not contradict its files.
 * Every problem carries its code; nothing here asks a C++ game for a page it never has.
 * Read-only, and every file is read as a plain file only (never through a link or a pipe).
 */
export async function validateNativeDir(dir: string, known?: ProjectShape): Promise<GameValidation> {
  const shape = known ?? (await readProjectShape(dir));
  const { problems, codes, fail } = findings();
  const cmake = await readNativeSource(path.join(dir, "CMakeLists.txt"));
  if (cmake === null) fail(await unreadable(dir, "CMakeLists.txt"), GameValidationCode.NativeMissingCMake);
  else if (!cmakeCallsGenexAddGame(cmake)) fail(MESSAGE.NeedsGenexCmake, GameValidationCode.NativeNeedsGenexCmake);
  const main = await readNativeSource(path.join(dir, shape.main));
  const installed = main !== null && installsNativeContract(main);
  if (main === null) fail(await unreadable(dir, shape.main), GameValidationCode.NativeMissingMain);
  else if (!installed) fail(MESSAGE.NativeContractRemoved(shape.main), GameValidationCode.NativeContractRemoved);
  const destinations = await readGameDestinations(dir, shape, null);
  if (destinations.stackContradicts) {
    fail(MESSAGE.StackContradictsKind(kindWords(shape.kind)), GameValidationCode.StackContradictsKind);
  }
  return {
    ok: problems.length === 0,
    problems,
    missing: [],
    warnings: destinations.warnings,
    contract: installed ? ContractWord.Loaded : ContractWord.Missing,
    reach: "none",
    shape,
    codes,
  };
}

/**
 * The build inputs a Rust game folder never holds: the studio writes the cargo manifest and lock
 * from `genex.toml`, and runs no build script and no cargo configuration of the game's.
 */
const RUST_OWN_BUILD_INPUTS = ["Cargo.toml", "Cargo.lock", "build.rs", ".cargo"] as const;

/**
 * The static check of a Rust · wgpu game: its `genex.toml`, no build input of its own, an entry
 * that hands the game to `genex::install`, and a studio.json that does not contradict its files.
 * A missing or unreadable file is `missing-file` (a night has nothing to build on); a cargo file,
 * build script or cargo configuration is `rust-own-build-input` (whatever it is: a link counts,
 * and nothing is followed or opened); the call taken out of the entry is
 * `native-contract-removed`, as for a C++ game. `unsafe` code is the lane's to refuse
 * (`-F unsafe_code`). Read-only, every file read as a plain file only.
 */
export async function validateRustDir(dir: string, known?: ProjectShape): Promise<GameValidation> {
  const shape = known ?? (await readProjectShape(dir));
  const { problems, codes, fail } = findings();
  for (const input of RUST_OWN_BUILD_INPUTS) {
    if (await entryExists(path.join(dir, input)))
      fail(MESSAGE.RustOwnBuildInput(input), GameValidationCode.RustOwnBuildInput);
  }
  if ((await readNativeSource(path.join(dir, GENEX_MANIFEST))) === null)
    fail(await unreadable(dir, GENEX_MANIFEST, MESSAGE.RustNotAPlainFile), GameValidationCode.MissingFile);
  const main = await readNativeSource(path.join(dir, shape.main));
  const installed = main !== null && installsGenex(main);
  if (main === null) fail(await unreadable(dir, shape.main, MESSAGE.RustNotAPlainFile), GameValidationCode.MissingFile);
  else if (!installed) fail(MESSAGE.GenexInstallRemoved(shape.main), GameValidationCode.NativeContractRemoved);
  const destinations = await readGameDestinations(dir, shape, null);
  if (destinations.stackContradicts) {
    fail(MESSAGE.StackContradictsKind(kindWords(shape.kind)), GameValidationCode.StackContradictsKind);
  }
  return {
    ok: problems.length === 0,
    problems,
    missing: [],
    warnings: destinations.warnings,
    contract: installed ? ContractWord.Loaded : ContractWord.Missing,
    reach: "none",
    shape,
    codes,
  };
}

/** Each compiled stack's own static check. */
const COMPILED_VALIDATIONS = {
  [GameStack.RaylibCpp]: validateNativeDir,
  [GameStack.RustWgpu]: validateRustDir,
} as const satisfies Record<CompiledStack, (dir: string, known: ProjectShape) => Promise<GameValidation>>;

/** A newer Genex's game ({@link ProjectShape.readOnly}): one problem, `kind-unsupported`, and nothing read. */
function readOnlyValidation(shape: ProjectShape): GameValidation {
  const { problems, codes, fail } = findings();
  fail(MESSAGE.KindUnsupported, GameValidationCode.KindUnsupported);
  return {
    ok: false,
    problems,
    missing: [],
    warnings: [],
    contract: ContractWord.Missing,
    reach: "none",
    shape,
    codes,
  };
}

/** A `genex::install(` call, as it reads once {@link rustCode} has blanked comments and literals. */
const GENEX_INSTALL_CALL = /\bgenex\s*::\s*install\s*\(/;
/** A raw string's opening (`r"`, `r#"`, `br##"`, `cr"`…), read where it starts; group 1 is its `#`s. */
const RUST_RAW_STRING = /[bc]?r(#*)"/y;
/** The furthest a character literal's closing quote sits from its opening: `'\u{10FFFF}'`. */
const MAX_RUST_CHAR_SPAN = 11;

/** Whether a Rust entry hands its game to `genex::install(…)` in code, never in a comment or a literal. */
export function installsGenex(source: string): boolean {
  return GENEX_INSTALL_CALL.test(rustCode(source));
}

/** Rust source with every comment and every string or character literal replaced by one space. */
function rustCode(text: string): string {
  const pieces: string[] = [];
  let start = 0;
  let at = 0;
  while (at < text.length) {
    const end = rustNonCodeEnd(text, at);
    if (end === at) {
      at += 1;
      continue;
    }
    pieces.push(text.slice(start, at), " ");
    at = end;
    start = end;
  }
  pieces.push(text.slice(start));
  return pieces.join("");
}

/** Where the comment or literal that starts at `at` ends; `at` itself when code starts there. */
function rustNonCodeEnd(text: string, at: number): number {
  const char = text.charAt(at);
  const next = text.charAt(at + 1);
  if (char === "/" && next === "/") return rustLineEnd(text, at + 2);
  if (char === "/" && next === "*") return rustBlockCommentEnd(text, at + 2);
  if (char === '"') return rustStringEnd(text, at + 1);
  if (char === "'") return rustCharEnd(text, at);
  return rustRawStringEnd(text, at);
}

/** From just inside a line comment: its line's end (a backslash there splices nothing in Rust). */
function rustLineEnd(text: string, from: number): number {
  const newline = text.indexOf("\n", from);
  return newline === -1 ? text.length : newline;
}

/** From just inside a block comment: the index after the `*` `/` that closes it, nested ones counted (Rust nests them). */
function rustBlockCommentEnd(text: string, from: number): number {
  let depth = 1;
  let at = from;
  while (at < text.length && depth > 0) {
    const pair = text.slice(at, at + 2);
    if (pair === "/*") depth++;
    else if (pair === "*/") depth--;
    at += pair === "/*" || pair === "*/" ? 2 : 1;
  }
  return at;
}

/** From just inside a string literal: the index after its closing quote (a Rust string may span lines). */
function rustStringEnd(text: string, from: number): number {
  let at = from;
  while (at < text.length) {
    const char = text.charAt(at);
    if (char === '"') return at + 1;
    at += char === "\\" ? 2 : 1;
  }
  return text.length;
}

/** At a `'`: the index after the character literal it opens, or `at` for a lifetime or a label (code). */
function rustCharEnd(text: string, at: number): number {
  if (text.charAt(at + 1) === "\\") {
    const close = text.indexOf("'", at + 3);
    return close === -1 || close > at + MAX_RUST_CHAR_SPAN ? at : close + 1;
  }
  const width = (text.codePointAt(at + 1) ?? 0) > 0xffff ? 2 : 1;
  return text.charAt(at + 1 + width) === "'" ? at + 2 + width : at;
}

/** At a raw string's opening: the index after its closing quote and `#`s; `at` when none opens there. */
function rustRawStringEnd(text: string, at: number): number {
  if (at > 0 && isWordChar(text.charAt(at - 1))) return at;
  RUST_RAW_STRING.lastIndex = at;
  const open = RUST_RAW_STRING.exec(text);
  if (!open) return at;
  const hashes = open[1] ?? "";
  const close = text.indexOf(`"${hashes}`, RUST_RAW_STRING.lastIndex);
  return close === -1 ? text.length : close + 1 + hashes.length;
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
  const html = await readGameText(path.join(dir, "index.html"));
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
    const text = (await readGameText(resolved)) ?? "";
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
