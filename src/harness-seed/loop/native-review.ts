/**
 * The code reviewer's compiled-stack rules (review.ts `mechanicalReview`): the regex half of the
 * review, read on C++ and CMake files, and on a Rust · wgpu game's `.rs` files and `genex.toml`,
 * the way the JavaScript rules read `.js` and `.ts`. A compiled game is judged in a stepped, seeded
 * run on every destination, so the wall clock, raw input, frame pacing and fast math in game code
 * are findings, and so is anything that reaches for the network at build time or a shader that
 * names its own GLSL version. The Rust rules are advisory: the Rust lane's lint refuses the same
 * paths at build time (`docs/GENEX_API.md` "Determinism"); the review names them before a build.
 *
 * A new module on purpose (the seed-upgrade rule): review.ts imports these names from here, so a
 * review.ts the agent kept from before native support still links, and simply reads no C++. The
 * names it imports keep their C++ spelling and now read every compiled stack's rules.
 */
import type { Violation } from "./review.ts";
import { GameStack } from "./native-contract.ts";

/**
 * This module reads a Rust · wgpu game's own rules (its entry, its owner files, its facets' place
 * and its determinism findings): a copy kept from before Rust games reads none, and run-dispatch.ts
 * refuses a Rust night on it (`RUST_PARTS`).
 */
export const SERVES_RUST = true;

/** The Rust template's entry: `genex::install(` and the FACET WIRING block live in it. */
export const RUST_TEMPLATE_MAIN = "src/main.rs";
/**
 * The files only the facet that owns a Rust game's entry may edit: the entry, the game's build
 * input, and the read-only API page (substrate/ownership.ts holds the same list for the host).
 */
export const RUST_OWNER_FILES: readonly string[] = [RUST_TEMPLATE_MAIN, "genex.toml", "docs/GENEX_API.md"];

/** The C++ template's entry: `studio::install(` and the FACET WIRING block live in it. */
export const CPP_TEMPLATE_MAIN = "src/main.cpp";

/** The template entry a compiled stack's cameras are wired in: `src/main.rs` for Rust, else `src/main.cpp`. */
export function templateMainOf(stack: unknown): string {
  return stack === GameStack.RustWgpu ? RUST_TEMPLATE_MAIN : CPP_TEMPLATE_MAIN;
}
/** The C++ template's build file: `genex_add_game(SOURCES src/*.cpp)` picks up every facet's file. */
const CPP_BUILD_FILE = "CMakeLists.txt";
/** The one runtime file that paces frames (guarded, for the native window): nothing else may. */
const CPP_FRAME_PACER = "src/platform.cpp";

/**
 * The studio's C++ runtime in the template (`src/game-template-cpp/src`, every file but
 * `main.cpp`): the contract, the clock, input, frame pacing, the protocol and its transport. Only
 * it may read raw input or the clock; it is the entry owner's, like `src/studio.js` in a three.js
 * game.
 */
const CPP_RUNTIME_FILES: ReadonlySet<string> = new Set(
  ["studio", "platform", "clock", "session", "input", "protocol", "transport", "hud", "paths", "json", "frames"]
    .flatMap((name) => [`src/${name}.cpp`, `src/${name}.h`])
    .concat(["src/digest.h", "src/rng.h", "src/frames_wire.h"]),
);

/** Is this file C++ game code or its build: a C or C++ source or header, or a CMake file? */
export function isCppSource(file: string): boolean {
  return /\.(c|cc|cpp|h|hpp|cmake)$/.test(file) || /(^|\/)CMakeLists\.txt$/.test(file);
}

/**
 * Does a review read a compiled stack's rules (`cppFindings`)? On a C++ · raylib or Rust · wgpu
 * game, by its stack: a three.js game's GLSL keeps its `#version` line. A caller that names no
 * stack (one written before stacks) reads them when the entry or a changed file is C++ or Rust.
 */
export function reviewsCpp(stack: unknown, main: string, files: readonly string[]): boolean {
  if (typeof stack === "string" && stack) return COMPILED_REVIEW_STACKS.includes(stack);
  const compiled = (file: string) => isCppSource(file) || isRustSource(file);
  return compiled(main) || files.some(compiled);
}

/** Is this file Rust game code or its build input: a `.rs` source or `genex.toml`? */
function isRustSource(file: string): boolean {
  return /\.rs$/.test(file) || /(^|\/)genex\.toml$/.test(file);
}

/** The compiled stacks whose own rules a review reads. */
const COMPILED_REVIEW_STACKS: readonly string[] = [GameStack.RaylibCpp, GameStack.RustWgpu];

/** A GLSL file a raylib game loads as a shader. */
function isShaderFile(file: string): boolean {
  return /\.(glsl|vs|fs|vert|frag)$/.test(file);
}

/** One of the studio's C++ runtime files (the template's contract, never game code). */
function isCppRuntimeFile(file: string): boolean {
  return CPP_RUNTIME_FILES.has(file);
}

/**
 * A file only the facet that owns a compiled entry may edit: the C++ entry, runtime and build
 * file, or a Rust game's entry, `genex.toml` and API page (`RUST_OWNER_FILES`).
 */
export function isCppOwnerFile(file: string): boolean {
  return (
    file === CPP_TEMPLATE_MAIN || file === CPP_BUILD_FILE || isCppRuntimeFile(file) || RUST_OWNER_FILES.includes(file)
  );
}

/** Where a compiled facet's own work belongs, per stack: a raylib game's `src/<id>.cpp`, a Rust game's facet module. */
const OWNED_PLACE = {
  [GameStack.RaylibCpp]: (id: string) => `src/${id}.cpp`,
  [GameStack.RustWgpu]: (id: string) => `src/facets/${id}.rs`,
} as const satisfies Record<Exclude<GameStack, typeof GameStack.ThreeJs>, (id: string) => string>;

/** Where a compiled facet's own work belongs (a caller that names no stack is a raylib one's). */
export function cppOwnedPlace(id: string, stack: unknown = GameStack.RaylibCpp): string {
  return stack === GameStack.RustWgpu ? OWNED_PLACE[GameStack.RustWgpu](id) : OWNED_PLACE[GameStack.RaylibCpp](id);
}

/**
 * Where a compiled facet's own work belongs, by the review's stack, or (a caller that names none)
 * by its entry: a Rust entry's facet module, else a raylib one's source.
 */
export function ownedPlaceFor(id: string, stack: unknown, main: string): string {
  const rust = stack === GameStack.RustWgpu || (!stack && isRustSource(main));
  return cppOwnedPlace(id, rust ? GameStack.RustWgpu : GameStack.RaylibCpp);
}

/** What the scan reads of one changed file. */
export interface CppFileReview {
  file: string;
  added: ReadonlyArray<{ line: number; text: string }>;
  removed: readonly string[];
  /** The studio's template (absent: true). A game the user brought keeps its own clock and randomness. */
  template: boolean;
}

/** A rule over added lines: what it matches, where, and the finding it makes. */
interface CppRule {
  category: string;
  pattern: RegExp;
  /** Only on the studio's template: a game the user brought keeps its own clock, randomness and input. */
  templateOnly: boolean;
  applies: (file: string) => boolean;
  what: string;
  fix: string;
}

/** C++ game code: a source the runtime does not own. */
const gameCode = (file: string): boolean => isCppSource(file) && !isCppRuntimeFile(file);
/** Any C++ source or build file, runtime included. */
const anyCpp = (file: string): boolean => isCppSource(file);
/** Any C++ source but the runtime's frame pacer. */
const notThePacer = (file: string): boolean => isCppSource(file) && file !== CPP_FRAME_PACER;
/** Game code and the GLSL files it loads. */
const shaderHolder = (file: string): boolean => (isCppSource(file) || isShaderFile(file)) && !isCppRuntimeFile(file);

const CPP_RULES: readonly CppRule[] = [
  {
    category: "determinism",
    pattern: /(?<![\w.>])(?:std::)?s?rand\s*\(|\brandom_device\b/,
    templateOnly: true,
    applies: gameCode,
    what: "rand() or std::random_device in game code — two builds cannot be compared on one seed",
    fix: "draw every random number from ctx.rng (seeded by reset(seed))",
  },
  {
    category: "wall-clock",
    pattern: /\b(?:GetTime|GetFrameTime)\s*\(|\bstd::chrono\b|\btime\s*\(\s*(?:NULL|nullptr|0)\s*\)/,
    templateOnly: true,
    applies: gameCode,
    what: "the wall clock drives the game (GetTime, GetFrameTime, std::chrono) — judging is stepped, not clocked",
    fix: "derive time from dt in update(dt, ctx)",
  },
  {
    category: "input",
    pattern: /\b(?:IsKey\w*|GetKeyPressed|GetCharPressed|GetMouse\w*|IsMouseButton\w*|IsGamepad\w*|GetGamepad\w*)\s*\(/,
    templateOnly: true,
    applies: gameCode,
    what: "raw raylib input in game code — the keys and pointer the studio drives the game with never reach it",
    fix: "read ctx.keys, ctx.look, ctx.wheel, ctx.pointer, ctx.pads and ctx.text inside update(dt, ctx)",
  },
  {
    category: "frame-pacing",
    pattern: /\b(?:SetTargetFPS|WaitTime)\s*\(/,
    templateOnly: false,
    applies: notThePacer,
    what: "SetTargetFPS or WaitTime outside src/platform.cpp — it blocks the browser build and the stepped clock",
    fix: "delete it; the runtime (src/platform.cpp) paces frames on every destination",
  },
  {
    category: "dependencies",
    pattern:
      /\bFetchContent_(?:Declare|MakeAvailable|Populate)\b|\bExternalProject_Add\b|\bfind_package\s*\(\s*(?!Genex\b)|\bfile\s*\(\s*DOWNLOAD\b|(?:^|[\s"'(:])-s\s*USE_\w+/,
    templateOnly: false,
    applies: anyCpp,
    what: "the build fetches or finds a library (FetchContent, ExternalProject, file(DOWNLOAD), find_package other than Genex, an Emscripten port) — builds are offline and pinned",
    fix: "vendor the library under third_party/<name>/ with its licence and add it with add_subdirectory",
  },
  {
    category: "float-math",
    pattern: /-(?:ffast-math|Ofast|funsafe-math[\w-]*)\b/,
    templateOnly: false,
    applies: anyCpp,
    what: "fast-math compiler flags — the browser and desktop builds stop computing the same game",
    fix: "remove -ffast-math, -Ofast and -funsafe-math-optimizations; genex.cmake sets every flag the lane needs",
  },
  {
    category: "shader",
    pattern: /#version\b/,
    templateOnly: false,
    applies: shaderHolder,
    what: "a shader names its own #version — WebGL2 and ANGLE take only the runtime's #version 300 es",
    fix: "drop the #version line and load the shader with studio::shader(vs, fs)",
  },
];

/** Rust game code: a `.rs` source (a Rust game has no runtime of its own in its folder: `genex` is a crate). */
const rustCode = (file: string): boolean => /\.rs$/.test(file);
/** A Rust game's build input. */
const genexToml = (file: string): boolean => /(^|\/)genex\.toml$/.test(file);

/** The f32 and f64 methods whose results differ per platform libm (`genex::math` has each). */
const TRANSCENDENTAL =
  "sin|cos|tan|sin_cos|asin|acos|atan|atan2|sinh|cosh|tanh|asinh|acosh|atanh|exp|exp2|exp_m1|ln|log|log2|log10|ln_1p|powf|powi|cbrt|hypot";

/**
 * A Rust · wgpu game's rules (docs/GENEX_API.md "Determinism"): the lane's lint refuses each at
 * build time, so the review names them first, in the same words.
 */
const RUST_RULES: readonly CppRule[] = [
  {
    category: "determinism",
    pattern:
      /\b(?:thread_rng|rand::random|rand::rng|getrandom|OsRng|fastrand::(?:u8|u16|u32|u64|usize|i32|i64|f32|f64|bool|shuffle)|fastrand::Rng::new)\b/,
    templateOnly: true,
    applies: rustCode,
    what: "per-process randomness in game code (thread_rng, rand::random, getrandom, the global fastrand) — two builds cannot be compared on one seed",
    fix: "draw every random number from ctx.rng or the reset rng (a fastrand::Rng built with_seed from ctx.rng is fine)",
  },
  {
    category: "wall-clock",
    pattern: /\b(?:Instant|SystemTime)\b/,
    templateOnly: true,
    applies: rustCode,
    what: "the wall clock drives the game (Instant, SystemTime) — judging is stepped, not clocked",
    fix: "take time from ctx.tick and ctx.dt in on_update; a draw reads a tick the world keeps",
  },
  {
    category: "input",
    pattern: /\bwinit::|\bWindowEvent\b|\bDeviceEvent\b/,
    templateOnly: true,
    applies: rustCode,
    what: "winit input read directly in game code — the keys, touches and pointer the studio drives the game with never reach it",
    fix: "read ctx.keys, ctx.touches, ctx.pointer, ctx.look, ctx.wheel, ctx.pads and ctx.text inside on_update",
  },
  {
    category: "frame-pacing",
    pattern: /\bthread::(?:sleep|spawn)\b|\bstd::thread\b/,
    templateOnly: false,
    applies: rustCode,
    what: "a thread sleeps or spawns in game code — the runtime paces frames, and threads reorder the simulation's work",
    fix: "delete it; the runtime paces frames on every destination and a simulation runs on one thread",
  },
  {
    category: "collections",
    pattern: /\bHash(?:Map|Set)\b/,
    templateOnly: false,
    applies: rustCode,
    what: "HashMap or HashSet in game code — iteration order differs per process, so two runs of one seed differ",
    fix: "use genex::Map and genex::Set (insertion-ordered, fixed hasher)",
  },
  {
    category: "float-math",
    pattern: new RegExp(`\\.(?:${TRANSCENDENTAL})\\s*\\(|\\bf(?:32|64)::(?:${TRANSCENDENTAL})\\b`),
    templateOnly: false,
    applies: rustCode,
    what: "a std transcendental (sin, cos, powf, exp, …) — platform libm, so the browser and desktop builds stop computing the same game",
    fix: "use genex::math (sin, cos, atan2, exp, pow, …): libm on every target; sqrt, abs, floor and mul_add stay allowed",
  },
  {
    category: "unsafe",
    pattern: /\bunsafe\b/,
    templateOnly: false,
    applies: rustCode,
    what: "unsafe in game code — a game is written against the genex facade only",
    fix: "remove the unsafe block; ask for what it needs through the genex API",
  },
  {
    category: "dependencies",
    pattern: /^\s*\[(?:dependencies|build-dependencies|patch|target)\b|\bbuild\s*=/,
    templateOnly: false,
    applies: genexToml,
    what: "genex.toml names dependencies or a build script — the host writes the cargo manifest and lock, and builds are offline and pinned",
    fix: "remove it; a crate the game needs is requested from the person (request_crate), never added by hand",
  },
];

/** A CMake file, where `#` starts a comment (in C and C++ it starts a directive). */
function isCmakeFile(file: string): boolean {
  return /(^|\/)CMakeLists\.txt$|\.cmake$/.test(file);
}

/** A comment line: it says what code does, it does not do it. */
function isComment(file: string, text: string): boolean {
  if (isCmakeFile(file) || genexToml(file)) return /^\s*#/.test(text);
  return /^\s*(\/\/|\/\*|\*)/.test(text);
}

/** Did this file's diff remove `studio::install(` without adding it back (a comment does not)? */
function droppedInstall({ file, added, removed }: CppFileReview): boolean {
  const install = /\bstudio::install\s*\(/;
  const installs = (text: string): boolean => install.test(text) && !isComment(file, text);
  return removed.some(installs) && !added.some(({ text }) => installs(text));
}

/** Did a Rust file's diff remove `genex::install(` without adding it back (a comment does not)? */
function droppedGenexInstall({ file, added, removed }: CppFileReview): boolean {
  const install = /\bgenex::install\s*\(/;
  const installs = (text: string): boolean => install.test(text) && !isComment(file, text);
  return removed.some(installs) && !added.some(({ text }) => installs(text));
}

/** The finding a removed install call makes, in each runtime's words. */
function droppedContract(review: CppFileReview): Violation | null {
  const { file } = review;
  const base = { file, line: 0, category: "contract", source: "mechanical" as const };
  if (rustCode(file) && droppedGenexInstall(review))
    return {
      ...base,
      what: "genex::install(...) removed — the build cannot be judged on any destination",
      fix: "restore genex::install(game) at the end of main()",
    };
  if (isCppSource(file) && droppedInstall(review))
    return {
      ...base,
      what: "studio::install(...) removed — the build cannot be judged on any destination",
      fix: "restore studio::install(std::move(game)) at the end of main()",
    };
  return null;
}

/**
 * A compiled stack's rules over one changed file's added (and removed) lines, `source:
 * "mechanical"`: the C++ rules on C++ and CMake files, the Rust rules on `.rs` files and
 * `genex.toml`.
 */
export function cppFindings(review: CppFileReview): Violation[] {
  const { file, added, template } = review;
  const violations: Violation[] = [];
  const contract = droppedContract(review);
  if (contract) violations.push(contract);
  for (const rule of [...CPP_RULES, ...RUST_RULES]) {
    if (!rule.applies(file) || (rule.templateOnly && !template)) continue;
    const hit = added.find(({ text }) => !isComment(file, text) && rule.pattern.test(text));
    if (hit)
      violations.push({
        file,
        line: hit.line,
        category: rule.category,
        what: rule.what,
        fix: rule.fix,
        source: "mechanical",
      });
  }
  return violations;
}
