// biome-ignore-all lint/suspicious/noTemplateCurlyInString: CMake's own ${VAR} references are the text this file writes and reads.
/**
 * `genex.cmake`, the toolchain-side CMake module a game's `CMakeLists.txt` includes: it defines
 * `genex_add_game(SOURCES <globs>...)`, links the lock's raylib prebuild, sets the destination's
 * flags from `recipe.json`, refuses in-source builds and writes the served output to
 * `<binaryDir>/out/`. `recipe.json` is the one recipe: the raylib prebuild (`prewarm.ts`) and this
 * module both read it.
 *
 * A Mac module builds two plain executables from the same sources, `game` (windowed raylib, GLFW
 * over ANGLE's EGL) and `game-headless` (Genex's headless raylib platform, `GENEX_HEADLESS`), both
 * linking the lock's ANGLE explicitly with one rpath into the bundle the host assembles, and copies
 * the staged assets into `out/assets`. The headless raylib itself is built from a CMake list this
 * module writes ({@link headlessRaylibCmake}), never raylib's own, whose `PLATFORM=Memory` forces
 * the software renderer.
 *
 * raylib's definitions and link options are restated here because an imported static library
 * carries neither. Paths are written as CMake bracket arguments, so no `$`, `"` or `\` in a store
 * path is ever read as syntax.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BuildTarget } from "../../shared/game-project.ts";
import { MAC_GAME_RPATH } from "../../shared/native-contract.ts";
import { ToolchainError, type ToolchainLock, ToolchainProblem } from "../../shared/toolchain.ts";
import { readRegularFile } from "../fsx.ts";
import shippedRecipe from "./recipe.json" with { type: "json" };

/** The developer build's checkout, set by `scripts/build.mjs` (null in a release build, absent from source). */
declare const __STUDIO_DEV_BUILD__: { checkout: string; buildId: string } | null | undefined;

const MESSAGE = {
  NoTarget: (target: string) => `The toolchain recipe has no ${target} destination yet.`,
  NoVariant: (variant: string) => `The toolchain recipe has no raylib prebuild named ${variant}.`,
  RefusedFlag: (flag: string) => `The toolchain recipe asks for ${flag}, which Genex never builds with.`,
  UnquotablePath: (value: string) =>
    `${JSON.stringify(value)} cannot be written into genex.cmake: it must be absolute, with no ';' or control character.`,
  MacParts: "A Mac genex.cmake names the headless raylib prebuild and the lock's ANGLE folder; one is missing.",
  NotHeadless: (variant: string) => `The raylib prebuild ${variant} is not a headless one.`,
} as const;

/** The second executable a Mac build makes: the same sources over the headless raylib. */
export interface HeadlessRecipe {
  /** The raylib prebuild variant it links (`raylib-<variant>/` in the lock folder). */
  readonly raylib: string;
  /** Its compile definitions: raylib's headless ones and `GENEX_HEADLESS`. */
  readonly definitions: readonly string[];
  /** Apple frameworks it links: never AppKit. */
  readonly frameworks: readonly string[];
  /** Its output name (`NATIVE_MAC_EXECUTABLES.headless`). */
  readonly output: string;
}

/** How one destination compiles and links a game. */
export interface TargetRecipe {
  /** The raylib prebuild variant it links (`raylib-<variant>/` in the lock folder). */
  readonly raylib: string;
  /** raylib's own compile definitions, restated for the game. */
  readonly definitions: readonly string[];
  /** Link options raylib's CMake would have added (an imported library carries none). */
  readonly link: readonly string[];
  /** Apple frameworks to link. */
  readonly frameworks: readonly string[];
  /** A `MACOSX_BUNDLE` executable. */
  readonly bundle: boolean;
  /** The executable's output name. */
  readonly output: string;
  /** `CMAKE_EXECUTABLE_SUFFIX` (`.html` for the web); empty to keep the platform's. */
  readonly suffix: string;
  /** CMake cache values a game's configure takes for this destination (the Mac's arch and deployment target). */
  readonly cmake?: Readonly<Record<string, string>>;
  /** A second executable over the headless raylib (the Mac's `game-headless`). */
  readonly headless?: HeadlessRecipe;
}

/** How a headless prebuild compiles raylib: its own CMake list over a build-tree copy of raylib's `src/`. */
export interface HeadlessVariant {
  /** raylib's definitions for it (`PLATFORM_MEMORY`, `GRAPHICS_API_OPENGL_ES3`). */
  readonly definitions: readonly string[];
  /** raylib's sources it compiles, relative to `src/`. */
  readonly sources: readonly string[];
  /** The platform file in the copy that Genex's headless platform replaces. */
  readonly replaces: string;
}

/** One raylib prebuild: the CMake cache values its configure takes. */
export interface RaylibVariant {
  readonly target: BuildTarget;
  /** `-D<name>=<value>` for raylib's own CMake (or the generated headless list). */
  readonly cmake: Readonly<Record<string, string>>;
  /**
   * C definitions added to `CMAKE_C_FLAGS` (`MA_NO_RUNTIME_LINKING` on a Mac; GLFW's EGL library
   * names, whose quotes reach the compiler escaped).
   */
  readonly cDefinitions: readonly string[];
  /** Compiled against the lock's ANGLE headers (`GLES3/gl3.h`, `EGL/egl.h`). */
  readonly angle?: boolean;
  /** Built from a build-tree copy with Genex's headless platform, not by raylib's own CMake. */
  readonly headless?: HeadlessVariant;
}

/** `recipe.json`: the flags every game builds with, raylib's configuration and each destination's options. */
export interface Recipe {
  readonly schema: 1;
  readonly flags: {
    /** Every C and C++ compile, games and prebuilds alike. */
    readonly compile: readonly string[];
    /** C++ only. */
    readonly cxx: readonly string[];
    /** Never allowed in a compile. */
    readonly refused: readonly string[];
  };
  /**
   * The one rate a native game mixes at: its raylib opens the audio device at it
   * (`AUDIO_DEVICE_SAMPLE_RATE`; miniaudio resamples to the hardware) and the game is told it
   * (`GENEX_AUDIO_RATE_HZ`), so the two can never disagree.
   */
  readonly nativeAudioRateHz: number;
  /**
   * Every `SUPPORT_*` flag raylib's `config.h` names, stated: with `CUSTOMIZE_BUILD=ON`, raylib
   * 6.0's CMake turns every flag it parses on (custom frame control, busy waiting, HDR, FLAC)
   * unless it is given a value.
   */
  readonly raylibConfig: Readonly<Record<string, boolean>>;
  /** Per raylib prebuild variant (`web-es3`, `macos-es3-angle`, `macos-es3-angle-headless`). */
  readonly raylib: Readonly<Record<string, RaylibVariant>>;
  /** Per destination. */
  readonly targets: Readonly<Partial<Record<BuildTarget, TargetRecipe>>>;
}

/** The shipped `recipe.json`. */
export function readRecipe(): Recipe {
  return shippedRecipe as Recipe;
}

/** JSON with every object's keys sorted, so equal values give equal text. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

/**
 * What genex.cmake's text is made of besides the recipe: raised whenever this module writes it
 * differently, so a store prewarmed by an earlier app re-prewarms instead of building with it
 * (3: a Mac module writes its assets list even for a game with no asset yet; 4: the Mac's
 * executables compile against ANGLE's headers and are told the mixer rate).
 */
const GENEX_CMAKE_FORMAT = 4;

/** Genex's headless raylib platform, compiled in place of raylib's `platforms/rcore_memory.c`. */
export const HEADLESS_PLATFORM_FILE = "rcore_genex_headless.c";
/** Where the repository keeps it, and where `scripts/build.mjs` copies it into a build's resources. */
const HEADLESS_PLATFORM_REL = ["native", "raylib-platform", HEADLESS_PLATFORM_FILE] as const;
/** The most of the platform file a prewarm or a locate reads; a bigger one reads as absent. */
const HEADLESS_PLATFORM_MAX_BYTES = 4 * 1024 * 1024;

/** The checkout this code runs from: the developer build's, or (from source) the repository this file is in. */
function checkoutRoot(): string {
  const build = typeof __STUDIO_DEV_BUILD__ === "undefined" ? null : __STUDIO_DEV_BUILD__;
  return build?.checkout ?? fileURLToPath(new URL("../../../", import.meta.url));
}

/**
 * The headless platform file this app prewarms with: the copy in `resources` when the caller names
 * a packaged app's resources folder (a release build has no checkout), else the checkout's
 * (source, tests and developer builds). The copy is byte for byte, so both digest the same.
 */
export function headlessPlatformPath(resources?: string): string {
  return path.join(resources ?? checkoutRoot(), ...HEADLESS_PLATFORM_REL);
}

/**
 * The headless platform file's bytes, or null when `file` is not a regular file of at most
 * {@link HEADLESS_PLATFORM_MAX_BYTES}: opened without following a link and without blocking (a
 * FIFO at its name is no file, never a wait).
 */
export async function readHeadlessPlatform(file: string = headlessPlatformPath()): Promise<Buffer | null> {
  return readRegularFile(file, HEADLESS_PLATFORM_MAX_BYTES).catch(() => null);
}

/** The sha256 of the headless platform file at `file`, or null when there is no such regular file. */
export async function headlessPlatformSha256(file: string = headlessPlatformPath()): Promise<string | null> {
  const bytes = await readHeadlessPlatform(file);
  return bytes && createHash("sha256").update(bytes).digest("hex");
}

/**
 * The first 12 hex of sha256 over the genex.cmake format and the recipe's canonical JSON
 * (`prewarm.json`'s `recipe`): a prewarm made from an older recipe or an older genex.cmake reads as
 * one to redo. The headless platform file is recorded on its own (`prewarm.json`'s `platform`), so
 * only the Mac, which compiles it, reads as stale when it changes.
 */
export function recipeSha12(recipe: Recipe): string {
  return createHash("sha256")
    .update(`${GENEX_CMAKE_FORMAT}\n${canonicalJson(recipe)}`)
    .digest("hex")
    .slice(0, 12);
}

/** A destination's recipe, or a typed refusal when the recipe has none yet. */
export function targetRecipe(recipe: Recipe, target: BuildTarget): TargetRecipe {
  const found = recipe.targets[target];
  if (!found) throw new ToolchainError(ToolchainProblem.Prewarm, MESSAGE.NoTarget(target));
  return found;
}

/** The lock-folder name of a destination's raylib prebuild (`raylib-web-es3`). */
export function raylibFolder(recipe: Recipe, target: BuildTarget): string {
  return `raylib-${targetRecipe(recipe, target).raylib}`;
}

/** Every raylib prebuild variant a destination links: its own, then its headless one. */
export function raylibVariants(recipe: Recipe, target: BuildTarget): string[] {
  const wanted = targetRecipe(recipe, target);
  return wanted.headless ? [wanted.raylib, wanted.headless.raylib] : [wanted.raylib];
}

/** A raylib prebuild variant, or a typed refusal when the recipe has none of that name. */
export function raylibVariant(recipe: Recipe, variant: string): RaylibVariant {
  const found = recipe.raylib[variant];
  if (!found) throw new ToolchainError(ToolchainProblem.Prewarm, MESSAGE.NoVariant(variant));
  return found;
}

/**
 * A raylib prebuild's C definitions: the variant's own, and on a native destination the rate its
 * audio device opens at ({@link Recipe.nativeAudioRateHz}). The web keeps the browser's rate.
 */
export function raylibCDefinitions(recipe: Recipe, variant: RaylibVariant): readonly string[] {
  if (variant.target === BuildTarget.Web) return variant.cDefinitions;
  return [...variant.cDefinitions, deviceRateDefinition(recipe)];
}

/** The definition that opens a native raylib's audio device at the recipe's one mixer rate (every native prebuild). */
export function deviceRateDefinition(recipe: Recipe): string {
  return `AUDIO_DEVICE_SAMPLE_RATE=${recipe.nativeAudioRateHz}`;
}

/** The definition that tells a native game the rate its raylib mixes at (every native module). */
export function gameRateDefinition(recipe: Recipe): string {
  return `GENEX_AUDIO_RATE_HZ=${recipe.nativeAudioRateHz}`;
}

/** Throws when any compile flag the recipe asks for is one it also refuses. */
export function assertNoRefusedFlag(recipe: Recipe, flags: readonly string[]): void {
  const refused = flags.find((flag) => recipe.flags.refused.includes(flag));
  if (refused !== undefined) throw new ToolchainError(ToolchainProblem.Prewarm, MESSAGE.RefusedFlag(refused));
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses.
const UNQUOTABLE = /[;\x00-\x1f\x7f]/;

/**
 * `value` as one CMake bracket argument (`[=[…]=]`, with as many `=` as it takes to never close
 * early): read literally, no escape or variable reference. A `;` (a CMake list), a control
 * character or a relative path is refused.
 */
export function cmakePath(value: string): string {
  if (UNQUOTABLE.test(value) || !path.isAbsolute(value))
    throw new ToolchainError(ToolchainProblem.Prewarm, MESSAGE.UnquotablePath(value));
  let level = "=";
  while (value.includes(`]${level}]`) || value.endsWith(`]${level}`)) level += "=";
  return `[${level}[${value}]${level}]`;
}

const quoted = (flag: string) => `    ${JSON.stringify(flag)}`;

/** A game target's compile options from the recipe, one quoted flag a line; the C++ ones behind a generator expression. */
export function compileOptionLines(recipe: Recipe): string[] {
  return [
    ...recipe.flags.compile.map(quoted),
    ...recipe.flags.cxx.map((flag) => quoted(`$<$<COMPILE_LANGUAGE:CXX>:${flag}>`)),
  ];
}

/** One imported raylib prebuild. */
function importedRaylib(name: string, prebuild: { lib: string; include: string }): string[] {
  return [
    `add_library(${name} STATIC IMPORTED GLOBAL)`,
    `set_target_properties(${name} PROPERTIES`,
    `  IMPORTED_LOCATION ${cmakePath(prebuild.lib)}`,
    `  INTERFACE_INCLUDE_DIRECTORIES ${cmakePath(prebuild.include)}`,
    ")",
    "",
  ];
}

/** CMake's own docstrings for the destination's cache values (the Mac's arch and deployment target). */
const CACHE_DOC: Readonly<Record<string, string>> = {
  CMAKE_OSX_ARCHITECTURES: "Genex's Mac games are thin",
  CMAKE_OSX_DEPLOYMENT_TARGET: "The oldest macOS a Genex Mac game runs on",
};

/** The destination's cache values, forced: an agent's own configure gets them too. */
function cacheValues(wanted: TargetRecipe): string[] {
  return Object.entries(wanted.cmake ?? {}).map(
    ([name, value]) =>
      `set(${name} ${JSON.stringify(value)} CACHE STRING ${JSON.stringify(CACHE_DOC[name] ?? "Genex")} FORCE)`,
  );
}

/** The module's opening: the in-source refusal, offline FetchContent, the build type and the imported raylib. */
function preamble(target: BuildTarget, wanted: TargetRecipe, input: GenexCmakeInput): string[] {
  const suffix = wanted.suffix ? [`set(CMAKE_EXECUTABLE_SUFFIX ${JSON.stringify(wanted.suffix)})`] : [];
  const headless = input.headless ? importedRaylib(HEADLESS_RAYLIB, input.headless) : [];
  return [
    `# genex-${target}.cmake: generated by Genex for toolchain lock ${input.lock.digest.slice(0, 12)}. Do not edit.`,
    "# A game's CMakeLists.txt includes it after project() and calls genex_add_game(SOURCES <globs>...).",
    ...GENEX_BLOCKS.guard,
    "",
    ...GENEX_BLOCKS.defaults,
    ...suffix,
    ...cacheValues(wanted),
    `set(GENEX_TARGET ${JSON.stringify(target)})`,
    `set(GENEX_LOCK ${JSON.stringify(input.lock.digest)})`,
    "",
    ...importedRaylib(RAYLIB, input.raylib),
    ...headless,
  ];
}

/** The imported raylib a game links, and the headless one. */
const RAYLIB = "genex_raylib";
const HEADLESS_RAYLIB = "genex_raylib_headless";

/** The include guard and the in-source refusal every module opens with. */
const GUARD_BLOCK = [
  "include_guard(GLOBAL)",
  "",
  "if(CMAKE_BINARY_DIR STREQUAL CMAKE_SOURCE_DIR)",
  '  message(FATAL_ERROR "genex: in-source builds are refused; configure with -B <a folder outside the game>.")',
  "endif()",
];

/** Offline FetchContent and the default build type. */
const DEFAULTS_BLOCK = [
  'set(FETCHCONTENT_FULLY_DISCONNECTED ON CACHE BOOL "Genex builds offline" FORCE)',
  "if(NOT CMAKE_BUILD_TYPE)",
  `  set(CMAKE_BUILD_TYPE Release CACHE STRING "Genex's default build type" FORCE)`,
  "endif()",
];

/** `genex_add_game`'s source globs: `CONFIGURE_DEPENDS`, so a new file re-runs them. */
const SOURCES_BLOCK = [
  "function(genex_add_game)",
  '  cmake_parse_arguments(PARSE_ARGV 0 GENEX "" "" "SOURCES")',
  "  if(NOT GENEX_SOURCES)",
  `    message(FATAL_ERROR "genex_add_game: name the game's sources, as SOURCES src/*.cpp.")`,
  "  endif()",
  '  set(genex_sources "")',
  "  foreach(genex_glob IN LISTS GENEX_SOURCES)",
  '    file(GLOB genex_found CONFIGURE_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/${genex_glob}")',
  "    list(APPEND genex_sources ${genex_found})",
  "  endforeach()",
  "  if(NOT genex_sources)",
  '    message(FATAL_ERROR "genex_add_game: SOURCES ${GENEX_SOURCES} matched no file.")',
  "  endif()",
];

/**
 * The web page around the game (`web/shell.html`) and its assets, notes (`*.md`) excluded. The
 * studio's lane passes `GENEX_ASSETS`, its own filtered copy of `assets/` (no dotfile, key or
 * link: `cpp-assets.ts`), and `GENEX_ASSETS_STAMP`, rewritten whenever that copy changed, so a
 * replaced or removed asset relinks whatever its time; a build without them (the agent's own, in
 * `build/`) packs `assets/` itself.
 */
const WEB_PACKAGING = [
  '  set_property(TARGET game APPEND PROPERTY LINK_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/web/shell.html")',
  "  if(DEFINED GENEX_ASSETS)",
  '    set(genex_asset_dir "${GENEX_ASSETS}")',
  "  else()",
  '    set(genex_asset_dir "${CMAKE_CURRENT_SOURCE_DIR}/assets")',
  "  endif()",
  '  file(GLOB_RECURSE genex_assets CONFIGURE_DEPENDS "${genex_asset_dir}/*")',
  '  list(FILTER genex_assets EXCLUDE REGEX "\\\\.md$")',
  "  if(genex_assets)",
  '    string(REPLACE "@" "@@" genex_asset_root "${genex_asset_dir}")',
  '    target_link_options(game PRIVATE "--preload-file=${genex_asset_root}@/assets" "--exclude-file=*.md")',
  "    set_property(TARGET game APPEND PROPERTY LINK_DEPENDS ${genex_assets})",
  "  endif()",
  "  if(DEFINED GENEX_ASSETS_STAMP)",
  '    set_property(TARGET game APPEND PROPERTY LINK_DEPENDS "${GENEX_ASSETS_STAMP}")',
  "  endif()",
];

/**
 * The file in a native build folder (the Mac's, Windows' or Linux') that says `out/assets` holds the
 * current copy: when `out/assets` is gone (a seeded worker, a removed folder), the lane drops it so
 * the copy runs again.
 */
export const MAC_ASSETS_MARKER = "genex-assets.done";

/**
 * A native build's assets (the Mac's, Windows' and Linux'): the lane's staged copy (`GENEX_ASSETS`,
 * filtered by the host) or, for an agent's own build, `assets/`, copied whole into `out/assets`
 * (a Mac bundle's `Resources/assets`; beside the executable on Windows and Linux).
 * The copy is redone, `out/assets` emptied first, whenever a file, the list of files (written when
 * it is missing or changed, so a game with no asset yet has one too) or the lane's stamp changes,
 * so a removed or replaced asset never lingers.
 */
const NATIVE_ASSETS = [
  "  # assets: the staged copy, renewed whole in out/assets",
  "  if(DEFINED GENEX_ASSETS)",
  '    set(genex_asset_dir "${GENEX_ASSETS}")',
  "  else()",
  '    set(genex_asset_dir "${CMAKE_CURRENT_SOURCE_DIR}/assets")',
  "  endif()",
  '  file(GLOB_RECURSE genex_assets CONFIGURE_DEPENDS "${genex_asset_dir}/*")',
  '  set(genex_assets_out "${CMAKE_BINARY_DIR}/out/assets")',
  `  set(genex_assets_done "\${CMAKE_BINARY_DIR}/${MAC_ASSETS_MARKER}")`,
  '  set(genex_assets_list "${CMAKE_BINARY_DIR}/genex-assets.list")',
  '  set(genex_assets_known "")',
  '  if(EXISTS "${genex_assets_list}")',
  '    file(READ "${genex_assets_list}" genex_assets_known)',
  "  endif()",
  '  if(NOT EXISTS "${genex_assets_list}" OR NOT genex_assets_known STREQUAL "${genex_assets}")',
  '    file(WRITE "${genex_assets_list}" "${genex_assets}")',
  "  endif()",
  '  set(genex_assets_depends ${genex_assets} "${genex_assets_list}")',
  "  if(DEFINED GENEX_ASSETS_STAMP)",
  '    list(APPEND genex_assets_depends "${GENEX_ASSETS_STAMP}")',
  "  endif()",
  '  set(genex_assets_copy COMMAND "${CMAKE_COMMAND}" -E make_directory "${genex_assets_out}")',
  '  if(IS_DIRECTORY "${genex_asset_dir}")',
  '    list(APPEND genex_assets_copy COMMAND "${CMAKE_COMMAND}" -E copy_directory "${genex_asset_dir}" "${genex_assets_out}")',
  "  endif()",
  '  add_custom_command(OUTPUT "${genex_assets_done}"',
  '    COMMAND "${CMAKE_COMMAND}" -E rm -rf "${genex_assets_out}"',
  "    ${genex_assets_copy}",
  '    COMMAND "${CMAKE_COMMAND}" -E touch "${genex_assets_done}"',
  "    DEPENDS ${genex_assets_depends}",
  "    VERBATIM)",
  '  add_custom_target(genex_copy_assets ALL DEPENDS "${genex_assets_done}")',
];

/**
 * The CMake blocks every genex module writes the same way, so one implementation (and one golden)
 * covers the Mac's and the Windows and Linux ones (`cross-targets.ts`); the web's writes all but
 * the assets, which Emscripten packs itself.
 */
export const GENEX_BLOCKS = {
  /** `include_guard` and the in-source refusal. */
  guard: GUARD_BLOCK,
  /** Offline FetchContent and the default build type. */
  defaults: DEFAULTS_BLOCK,
  /** `genex_add_game`'s opening: its arguments and the source globs. */
  sources: SOURCES_BLOCK,
  /** A native build's assets, renewed whole in `out/assets` beside the executables ({@link MAC_ASSETS_MARKER}). */
  assets: NATIVE_ASSETS,
} as const satisfies Record<string, readonly string[]>;

/**
 * One Mac executable: its flags, its raylib, the lock's ANGLE headers and libraries (linked
 * explicitly), the mixer rate its raylib opens the device at, the recipe's link options beside one
 * rpath, thin arm64, into `out/`.
 */
function macExecutable(
  name: string,
  raylib: string,
  parts: { definitions: readonly string[]; frameworks: readonly string[]; link: readonly string[]; angle: string },
  recipe: Recipe,
): string[] {
  const frameworks = parts.frameworks.map((framework) => ` ${JSON.stringify(`-framework ${framework}`)}`).join("");
  const link = [`-Wl,-rpath,${MAC_GAME_RPATH}`, ...parts.link].map((flag) => JSON.stringify(flag)).join(" ");
  return [
    `  add_executable(${name} \${genex_sources})`,
    `  target_compile_options(${name} PRIVATE`,
    ...compileOptionLines(recipe),
    "  )",
    `  target_compile_definitions(${name} PRIVATE`,
    ...parts.definitions.map((definition) => `    ${definition}`),
    `    ${gameRateDefinition(recipe)}`,
    "  )",
    `  target_include_directories(${name} SYSTEM PRIVATE ${cmakePath(path.join(parts.angle, "include"))})`,
    `  target_link_directories(${name} PRIVATE ${cmakePath(parts.angle)})`,
    `  target_link_libraries(${name} PRIVATE ${raylib} EGL GLESv2${frameworks})`,
    `  target_link_options(${name} PRIVATE ${link})`,
    `  set_target_properties(${name} PROPERTIES`,
    `    OUTPUT_NAME ${name}`,
    "    OSX_ARCHITECTURES arm64",
    "    SKIP_BUILD_RPATH TRUE",
    '    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/out"',
    "  )",
  ];
}

/** The Mac's two executables, from the same sources, and the assets beside them. */
function macBlock(wanted: TargetRecipe, input: GenexCmakeInput): string[] {
  const { headless } = wanted;
  if (!headless || !input.headless || !input.angle)
    throw new ToolchainError(ToolchainProblem.Prewarm, MESSAGE.MacParts);
  const { recipe, angle } = input;
  const { link } = wanted;
  return [
    ...macExecutable(wanted.output, RAYLIB, { ...wanted, angle }, recipe),
    ...macExecutable(headless.output, HEADLESS_RAYLIB, { ...headless, link, angle }, recipe),
    ...NATIVE_ASSETS,
    "endfunction()",
    "",
  ];
}

/** The game target: its flags, raylib, the destination's link options and the one output folder. */
function gameBlock(target: BuildTarget, wanted: TargetRecipe, recipe: Recipe): string[] {
  const web = target === BuildTarget.Web;
  const link = [...wanted.link, ...(web ? ["--shell-file=${CMAKE_CURRENT_SOURCE_DIR}/web/shell.html"] : [])];
  const frameworks = wanted.frameworks.map((framework) => ` ${JSON.stringify(`-framework ${framework}`)}`).join("");
  const linkOptions = link.length ? ["  target_link_options(game PRIVATE", ...link.map(quoted), "  )"] : [];
  return [
    `  add_executable(game${wanted.bundle ? " MACOSX_BUNDLE" : ""} \${genex_sources})`,
    "  target_compile_options(game PRIVATE",
    ...compileOptionLines(recipe),
    "  )",
    "  target_compile_definitions(game PRIVATE",
    ...wanted.definitions.map((definition) => `    ${definition}`),
    "  )",
    `  target_link_libraries(game PRIVATE genex_raylib${frameworks})`,
    ...linkOptions,
    ...(web ? WEB_PACKAGING : []),
    "  set_target_properties(game PROPERTIES",
    `    OUTPUT_NAME ${wanted.output}`,
    '    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/out"',
    "  )",
    "endfunction()",
    "",
  ];
}

/** What {@link genexCmake} writes a module for: the lock and its raylib prebuilds' final paths. */
export interface GenexCmakeInput {
  lock: ToolchainLock;
  raylib: { lib: string; include: string };
  /** The Mac's headless raylib prebuild. */
  headless?: { lib: string; include: string };
  /** The Mac: the lock's ANGLE install folder (`libEGL.dylib`, `libGLESv2.dylib`), never Electron's. */
  angle?: string;
  recipe: Recipe;
}

/** The text of `genex-<target>.cmake` for one lock and its raylib prebuilds. */
export function genexCmake(target: BuildTarget, input: GenexCmakeInput): string {
  const { recipe } = input;
  const wanted = targetRecipe(recipe, target);
  assertNoRefusedFlag(recipe, [...recipe.flags.compile, ...recipe.flags.cxx, ...wanted.link]);
  const block = wanted.headless ? macBlock(wanted, input) : gameBlock(target, wanted, recipe);
  return [...preamble(target, wanted, input), ...SOURCES_BLOCK, ...block].join("\n");
}

/** What {@link headlessRaylibCmake} writes a list for: the build-tree copy of raylib's `src/` and ANGLE's headers. */
export interface HeadlessListInput {
  /** The copy of raylib's `src/` whose platform file is Genex's. */
  source: string;
  /** The lock's ANGLE `include/`. */
  angleInclude: string;
  variant: string;
  recipe: Recipe;
}

/**
 * The CMake list a headless raylib prebuild configures: a static `raylib` over the recipe's
 * sources in the build-tree copy, with raylib's headless definitions, every `SUPPORT_*` flag the
 * recipe turns on (as raylib's own CMake states them, `EXTERNAL_CONFIG_FLAGS` first), the
 * variant's C definitions and the lock's ANGLE headers. The archive lands at `raylib/libraylib.a`
 * in the build folder, as raylib's own CMake leaves it.
 */
export function headlessRaylibCmake(input: HeadlessListInput): string {
  const { recipe, source } = input;
  const variant = raylibVariant(recipe, input.variant);
  const headless = variant.headless;
  if (!headless) throw new ToolchainError(ToolchainProblem.Prewarm, MESSAGE.NotHeadless(input.variant));
  assertNoRefusedFlag(recipe, recipe.flags.compile);
  const flags = Object.keys(recipe.raylibConfig)
    .sort()
    .filter((flag) => recipe.raylibConfig[flag]);
  const definitions = [
    ...headless.definitions,
    "EXTERNAL_CONFIG_FLAGS",
    ...flags,
    ...raylibCDefinitions(recipe, variant),
  ];
  return [
    `# ${input.variant}: generated by Genex. raylib's sources from a build-tree copy whose ${headless.replaces}`,
    `# is Genex's ${HEADLESS_PLATFORM_FILE}; raylib's own CMake is not used: its Memory platform builds the software renderer.`,
    "cmake_minimum_required(VERSION 3.28)",
    "project(genex_raylib_headless C)",
    'set(FETCHCONTENT_FULLY_DISCONNECTED ON CACHE BOOL "Genex builds offline" FORCE)',
    "add_library(raylib STATIC",
    ...headless.sources.map((file) => `  ${cmakePath(path.join(source, file))}`),
    ")",
    `target_include_directories(raylib PRIVATE ${cmakePath(source)} ${cmakePath(input.angleInclude)})`,
    "target_compile_options(raylib PRIVATE",
    ...recipe.flags.compile.map((flag) => `  ${JSON.stringify(flag)}`),
    ")",
    "target_compile_definitions(raylib PRIVATE",
    ...definitions.map((definition) => `  ${definition}`),
    ")",
    'set_target_properties(raylib PROPERTIES ARCHIVE_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/raylib")',
    "",
  ].join("\n");
}
