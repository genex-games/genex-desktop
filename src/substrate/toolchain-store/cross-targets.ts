// biome-ignore-all lint/suspicious/noTemplateCurlyInString: CMake's own ${VAR} references and the scanner's shell text are what this file writes.
/**
 * Cross destinations use Zig and pinned raylib/ANGLE: toolchain-<target>.cmake isolates discovery
 * from host headers and libraries; raylib-<target>.cmake supplies EGL/GLES and Linux's X11/Wayland
 * headers; genex-<target>.cmake builds a game's out/ and copies its assets. Windows uses D3D11,
 * Linux Vulkan and a RUNPATH of exactly $ORIGIN. Paths are CMake bracket arguments with forward
 * slashes. The store prewarms these modules and raylib under the same lock (prewarm.ts).
 *
 * A Rust · wgpu game is cross-built by cargo, never CMake: {@link RUST_CROSS_TARGETS} says how
 * (llvm-mingw for `x86_64-pc-windows-gnullvm`, zig with cargo-zigbuild for glibc 2.28) and
 * {@link rustCrossEnv} the environment its lane hands cargo. They sit beside raylib's table, outside
 * its format digest, so a raylib prebuild stays current.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { BuildTarget, GameStack } from "../../shared/game-project.ts";
import { STACK_CROSS_EXECUTABLES } from "../../shared/native-contract.ts";
import { RUST_CROSS_COMPONENTS, ToolchainError, type ToolchainId, ToolchainProblem } from "../../shared/toolchain.ts";
import { LinuxRuntimeFile, LinuxVulkanFile, WindowsRuntimeFile } from "../native-runtime-files.ts";
import { shellQuote } from "../shell-quote.ts";
import {
  assertNoRefusedFlag,
  canonicalJson,
  compileOptionLines,
  deviceRateDefinition,
  GENEX_BLOCKS,
  gameRateDefinition,
  type Recipe,
} from "./genex-cmake.ts";

/** A destination built by cross-compiling with zig. */
export const CrossTarget = { WindowsX64: "windows-x64", LinuxX64: "linux-x64" } as const;
export type CrossTarget = (typeof CrossTarget)[keyof typeof CrossTarget];

const CROSS_TARGET_VALUES: ReadonlySet<string> = new Set(Object.values(CrossTarget));

/** Whether `value` names a cross destination. */
export function isCrossTarget(value: unknown): value is CrossTarget {
  return typeof value === "string" && CROSS_TARGET_VALUES.has(value);
}

/** The build target each cross destination is (`windows`, `linux`). */
const CROSS_BUILD_TARGET = {
  [CrossTarget.WindowsX64]: BuildTarget.Windows,
  [CrossTarget.LinuxX64]: BuildTarget.Linux,
} as const satisfies Record<CrossTarget, BuildTarget>;

/** The build target a cross destination is. */
export function buildTargetOf(target: CrossTarget): BuildTarget {
  return CROSS_BUILD_TARGET[target];
}

/** The cross destination a build target is cross-compiled as, or null for the web and the Mac. */
export function crossTargetOf(target: BuildTarget): CrossTarget | null {
  const found = Object.values(CrossTarget).find((cross) => CROSS_BUILD_TARGET[cross] === target);
  return found ?? null;
}

/** The toolchain file's name in a lock folder (`toolchain-windows-x64.cmake`). */
export function crossToolchainFileName(target: CrossTarget): string {
  return `toolchain-${target}.cmake`;
}

/**
 * The lock folder's copy of zig's global cache for a destination (`zig-cache-windows-x64`): what
 * the prewarm's zig built for the target, the clone source of a new build folder's cache.
 */
export function crossZigCacheName(target: CrossTarget): string {
  return `zig-cache-${target}`;
}

/** How the host spells the absolute paths it hands a generator. */
export const PathStyle = { Posix: "posix", Win32: "win32" } as const;
export type PathStyle = (typeof PathStyle)[keyof typeof PathStyle];

const HOST_PATH_STYLE: PathStyle = process.platform === "win32" ? PathStyle.Win32 : PathStyle.Posix;

/** How one cross destination is compiled, linked and shipped. */
export interface CrossTargetSpec {
  /** zig's `-target`. */
  readonly triple: string;
  /** `CMAKE_SYSTEM_NAME`. */
  readonly systemName: string;
  /** The raylib prebuild variant (`raylib-<variant>/` in the lock folder). */
  readonly raylib: string;
  /** raylib's compile definitions, restated for the game (an imported prebuild carries none). */
  readonly definitions: readonly string[];
  /** The EGL library GLFW loads at run time (ANGLE's). */
  readonly egl: string;
  /** The GLES library GLFW loads, and the one the executable imports. */
  readonly glesv2: string;
  /** System libraries the game links by name. */
  readonly libraries: readonly string[];
  /** The game's link options. */
  readonly link: readonly string[];
  /** ANGLE's files that ship beside the executable, overwritten by the host from the store. */
  readonly runtime: readonly string[];
  /** raylib's own CMake cache values for this platform, beside the recipe's common ones. */
  readonly raylibCache: Readonly<Record<string, string>>;
  /** `SUPPORT_*` values that differ from the recipe's `raylibConfig` on this destination. */
  readonly raylibConfig: Readonly<Record<string, boolean>>;
}

/**
 * The two cross destinations. Windows: D3D11-only ANGLE through its import library, the C++
 * runtime linked in (`-static`), no console window, stripped with a reproducible COFF timestamp.
 * Zig cannot override its PDB path through this driver, so no PDB is shipped. Linux: Vulkan-only ANGLE with SwiftShader found through `$ORIGIN`, the
 * executable stripped (`-s`: no debug sections, no symbol table naming build folders); GLFW is
 * built for X11 and Wayland, and raylib's X11 image clipboard is off because it calls Xlib
 * directly, which would make every game link `libX11` (GLFW loads X11 and Wayland at run time).
 */
export const CROSS_TARGETS = {
  [CrossTarget.WindowsX64]: {
    triple: "x86_64-windows-gnu",
    systemName: "Windows",
    raylib: "windows-x64-es3-angle",
    definitions: ["PLATFORM_DESKTOP_GLFW", "GRAPHICS_API_OPENGL_ES3"],
    egl: WindowsRuntimeFile.Egl,
    glesv2: WindowsRuntimeFile.Gles,
    libraries: ["winmm", "gdi32", "user32", "shell32"],
    link: ["-static", "-Wl,--subsystem,windows", "-Wl,-Brepro", "-s"],
    runtime: Object.values(WindowsRuntimeFile),
    raylibCache: {},
    raylibConfig: {},
  },
  [CrossTarget.LinuxX64]: {
    triple: "x86_64-linux-gnu.2.28",
    systemName: "Linux",
    raylib: "linux-x64-es3-angle",
    definitions: ["PLATFORM_DESKTOP_GLFW", "GRAPHICS_API_OPENGL_ES3"],
    egl: LinuxRuntimeFile.Egl,
    glesv2: LinuxRuntimeFile.Gles,
    libraries: ["m", "pthread", "dl"],
    link: ["-s", "LINKER:-rpath,$ORIGIN", "LINKER:--enable-new-dtags"],
    runtime: Object.values(LinuxRuntimeFile),
    raylibCache: { GLFW_BUILD_X11: "ON", GLFW_BUILD_WAYLAND: "ON" },
    raylibConfig: { SUPPORT_CLIPBOARD_IMAGE: false },
  },
} as const satisfies Record<CrossTarget, CrossTargetSpec>;

/** raylib's CMake cache values every cross prebuild configures with. */
const RAYLIB_CACHE: Readonly<Record<string, string>> = {
  PLATFORM: "Desktop",
  OPENGL_VERSION: "ES 3.0",
  BUILD_EXAMPLES: "OFF",
  CUSTOMIZE_BUILD: "ON",
  USE_EXTERNAL_GLFW: "OFF",
  CMAKE_BUILD_TYPE: "Release",
};

/**
 * GLFW 3.4's `pkg_check_modules(Wayland REQUIRED ...)` arguments in raylib 6.0. pkg-config only
 * tells GLFW the include folders, which the project include already gives every compile, so the
 * configure records this check as FindPkgConfig's own finished one instead of running a host
 * pkg-config. A raylib whose GLFW asks differently re-runs the check and fails loudly.
 */
const GLFW_WAYLAND_PKG_CONFIG = [
  "REQUIRED",
  "wayland-client>=0.2.7",
  "wayland-cursor>=0.2.7",
  "wayland-egl>=0.2.7",
  "xkbcommon>=0.5.0",
] as const;

/** The file GLFW's CMake has `wayland-scanner <command> <protocol>.xml <output>` write, by command. */
export const WAYLAND_PROTOCOL_OUTPUTS = {
  "client-header": "-client-protocol.h",
  "private-code": "-client-protocol-code.h",
} as const;

/** ANGLE's import libraries on Windows (the DLLs themselves are resolved at run time): GLESv2, then EGL. */
const WINDOWS_ANGLE_IMPORTS = ["libGLESv2.dll.lib", "libEGL.dll.lib"] as const;
/** ANGLE's libraries on Linux, by the names the linker finds in ANGLE's folder. */
const LINUX_ANGLE_LIBRARIES = ["GLESv2", "EGL"] as const;

/**
 * Raised on a structural change {@link crossFormatSha12}'s generated sample would not show (3: the
 * game module links EGL, is told the mixer rate, copies the assets and shares the Mac's blocks; 4:
 * the Windows game carries its manifest resource; 6: the lock folder keeps zig's global cache).
 */
const CROSS_CMAKE_FORMAT = 6;

/**
 * The Windows game's application manifest (RT_MANIFEST 1, compiled by zig rc): the UTF-8 active
 * code page, so `getenv` and raylib's `fopen` see a profile path outside the system's ANSI code
 * page whole instead of with `?`, on Windows 10 and later. GLFW sets DPI awareness itself.
 */
const WINDOWS_MANIFEST = [
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
  '<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">',
  '  <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1">',
  "    <application>",
  '      <supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}"/>',
  "    </application>",
  "  </compatibility>",
  '  <application xmlns="urn:schemas-microsoft-com:asm.v3">',
  "    <windowsSettings>",
  '      <activeCodePage xmlns="http://schemas.microsoft.com/SMI/2019/WindowsSettings">UTF-8</activeCodePage>',
  "    </windowsSettings>",
  "  </application>",
  "</assembly>",
] as const;

/**
 * The game module's lines that write the manifest and its resource script (RT_MANIFEST 24, id 1,
 * naming the manifest by its absolute path) into the build and compile them in. `file(CONFIGURE)`
 * writes a file only when its text changes, so a configure of an unchanged game rebuilds nothing;
 * bracket arguments keep every quote literal, as no generated text holds a backslash.
 */
const WINDOWS_RESOURCE_BLOCK = [
  "  # The executable's manifest: the UTF-8 code page (getenv and fopen see a profile path whole) on Windows 10 and later.",
  '  set(genex_manifest "${CMAKE_BINARY_DIR}/genex/game.manifest")',
  `  file(CONFIGURE OUTPUT "\${genex_manifest}" CONTENT [=[${WINDOWS_MANIFEST.join("\n")}`,
  "]=] @ONLY)",
  '  file(CONFIGURE OUTPUT "${CMAKE_BINARY_DIR}/genex/game.rc" CONTENT [=[1 24 "@genex_manifest@"',
  "]=] @ONLY)",
  '  target_sources(game PRIVATE "${CMAKE_BINARY_DIR}/genex/game.rc")',
] as const;

const LOCK_DIGEST = /^[0-9a-f]{64}$/;

const MESSAGE = {
  BadDigest: (digest: string) => `${JSON.stringify(digest)} is not a toolchain lock digest.`,
  NoSysroot: "A Linux raylib prebuild needs the X11 and Wayland headers' sysroot.",
  NoWaylandScanner: "A Linux raylib prebuild needs the wayland-scanner stand-in for GLFW's protocol code.",
  UnwritablePath: (value: string) =>
    `${JSON.stringify(value)} cannot be written into a cross toolchain file: it must be absolute, with no ';', control character or '$<'.`,
  UnreadableZig: (zig: string) =>
    `${JSON.stringify(zig)} cannot be CMake's compiler: CMake mis-reads a compiler path with '[', ']', '"', '\\', '\${', '$ENV{' or '$CACHE{'.`,
} as const;

const refusal = (message: string) => new ToolchainError(ToolchainProblem.Prewarm, message);

const WIN32_ABSOLUTE = /^[A-Za-z]:[\\/]/;
/** `;` splits a CMake list, a control character ends a line, `$<` opens a generator expression. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses.
const UNWRITABLE = /[;\x00-\x1f\x7f]|\$</;
/**
 * What CMake mis-reads in a compiler path: a square bracket stops it splitting `zig;cc;-target;…`
 * at the `;` after it, and it writes the path unescaped into `CMakeCCompiler.cmake` and reads that
 * back, so a double quote or a backslash breaks the file and a variable reference is expanded
 * into another path than the one checked.
 */
const UNREADABLE_COMPILER = /[[\]"\\]|\$(?:ENV|CACHE)?\{/;

/** `value` as CMake spells it (forward slashes), refused unless it is absolute and writable. */
function cmakeForm(value: string, style: PathStyle): string {
  const absolute = style === PathStyle.Win32 ? WIN32_ABSOLUTE.test(value) : value.startsWith("/");
  if (!absolute || UNWRITABLE.test(value)) throw refusal(MESSAGE.UnwritablePath(value));
  return style === PathStyle.Win32 ? value.replaceAll("\\", "/") : value;
}

/** A CMake bracket argument holding `value`, at a level no `]=…]` inside it can close. */
function bracket(value: string): string {
  let level = "=";
  while (value.includes(`]${level}]`) || value.endsWith(`]${level}`)) level += "=";
  return `[${level}[${value}]${level}]`;
}

const cmakeArg = (value: string, style: PathStyle) => bracket(cmakeForm(value, style));

/** `parts` joined the way the host's own paths join (`\` on Windows), before CMake's spelling. */
const joined = (style: PathStyle, ...parts: string[]) =>
  (style === PathStyle.Win32 ? path.win32 : path.posix).join(...parts);

/** The lock a generated file names. */
export interface CrossLock {
  readonly digest: string;
}

function lockLabel(lock: CrossLock): string {
  if (!LOCK_DIGEST.test(lock.digest)) throw refusal(MESSAGE.BadDigest(lock.digest));
  return lock.digest.slice(0, 12);
}

const header = (file: string, lock: CrossLock) =>
  `# ${file}: generated by Genex for toolchain lock ${lockLabel(lock)}. Do not edit.`;

/** The ANGLE files that ship beside a cross destination's executable. */
export function crossRuntimeFiles(target: CrossTarget): readonly string[] {
  return CROSS_TARGETS[target].runtime;
}

/**
 * zig's caches inside `folder`, as the environment of every configure and build: zig otherwise
 * writes to the user's home cache, outside the build's sandbox. `local` puts the local cache
 * elsewhere (a prewarm keeps only the global one, which holds the target's libc).
 */
export function crossBuildEnv(
  folder: string,
  pathStyle: PathStyle = HOST_PATH_STYLE,
  local?: string,
): Record<string, string> {
  cmakeForm(folder, pathStyle);
  return {
    ZIG_GLOBAL_CACHE_DIR: joined(pathStyle, folder, "global"),
    ZIG_LOCAL_CACHE_DIR: local ?? joined(pathStyle, folder, "local"),
  };
}

/** What {@link crossToolchainFile} writes a toolchain file for. */
export interface CrossToolchainInput {
  lock: CrossLock;
  /** The store's zig executable. */
  zig: string;
  /** A folder the store owns (the lock folder): find_* search it instead of the host. */
  root: string;
  /** The Linux raylib prebuild's X11 and Wayland headers' sysroot, searched beside the root. */
  sysroot?: string;
  pathStyle?: PathStyle;
}

/** zig rc as CMake's resource compiler; `--` keeps a source path that starts with `/` from reading as an option. */
const ZIG_RC_RULE =
  '  set(CMAKE_RC_COMPILE_OBJECT "<CMAKE_RC_COMPILER> rc /:output-format coff /:target x86_64 /:auto-includes gnu <DEFINES> <INCLUDES> <FLAGS> /fo <OBJECT> -- <SOURCE>")';

/**
 * Read a second time as `CMAKE_USER_MAKE_RULES_OVERRIDE`, after CMake's platform modules have set
 * their archive rules (Windows-GNU sets them unconditionally), and replace them.
 */
function rulesOverride(target: CrossTarget): string[] {
  return [
    "if(CMAKE_C_COMPILER_LOADED OR CMAKE_CXX_COMPILER_LOADED)",
    "  # Read again as CMAKE_USER_MAKE_RULES_OVERRIDE, after CMake's platform rules: CMAKE_AR names one",
    "  # program and zig takes its archiver as a subcommand, so archives go through zig ar and zig ranlib.",
    "  foreach(genex_lang IN ITEMS C CXX)",
    '    set(CMAKE_${genex_lang}_ARCHIVE_CREATE "<CMAKE_AR> ar qc <TARGET> <LINK_FLAGS> <OBJECTS>")',
    '    set(CMAKE_${genex_lang}_ARCHIVE_APPEND "<CMAKE_AR> ar q <TARGET> <LINK_FLAGS> <OBJECTS>")',
    '    set(CMAKE_${genex_lang}_ARCHIVE_FINISH "<CMAKE_RANLIB> ranlib <TARGET>")',
    "  endforeach()",
    ...(target === CrossTarget.WindowsX64 ? [ZIG_RC_RULE] : []),
    "  return()",
    "endif()",
  ];
}

/** The text of `toolchain-<target>.cmake`: zig as the compiler for the target, nothing found on the host. */
export function crossToolchainFile(target: CrossTarget, input: CrossToolchainInput): string {
  const spec = CROSS_TARGETS[target];
  const style = input.pathStyle ?? HOST_PATH_STYLE;
  const zigPath = cmakeForm(input.zig, style);
  if (UNREADABLE_COMPILER.test(zigPath)) throw refusal(MESSAGE.UnreadableZig(input.zig));
  const zig = bracket(zigPath);
  const roots = [input.root, ...(input.sysroot === undefined ? [] : [input.sysroot])];
  const findRoot = roots.map((root) => cmakeArg(root, style)).join(" ");
  const resources = target === CrossTarget.WindowsX64 ? [`set(CMAKE_RC_COMPILER ${zig})`] : [];
  return [
    header(crossToolchainFileName(target), input.lock),
    `# zig cross-compiles for ${spec.triple} as CMake's C and C++ compiler (pass it as CMAKE_TOOLCHAIN_FILE).`,
    ...rulesOverride(target),
    `set(CMAKE_SYSTEM_NAME ${spec.systemName})`,
    "set(CMAKE_SYSTEM_PROCESSOR x86_64)",
    `set(CMAKE_C_COMPILER ${zig} cc -target ${spec.triple})`,
    `set(CMAKE_CXX_COMPILER ${zig} c++ -target ${spec.triple})`,
    `set(CMAKE_AR ${zig})`,
    `set(CMAKE_RANLIB ${zig})`,
    ...resources,
    'set(CMAKE_USER_MAKE_RULES_OVERRIDE "${CMAKE_CURRENT_LIST_FILE}")',
    "# genex-<target>.cmake refuses a configure that did not read this file.",
    `set(GENEX_CROSS_TARGET ${JSON.stringify(target)})`,
    `set(GENEX_CROSS_LOCK ${JSON.stringify(input.lock.digest)})`,
    "# find_* search only these folders, never the host: no host header, library, strip, linker or windres.",
    `set(CMAKE_FIND_ROOT_PATH ${findRoot})`,
    "set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM ONLY)",
    "set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)",
    "set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)",
    "set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)",
    "",
  ].join("\n");
}

/** What {@link crossRaylibProjectInclude} writes raylib's project include for. */
export interface CrossRaylibIncludeInput {
  /** The compiler executable, for mapping store paths in debug records. */
  zig?: string;
  lock: CrossLock;
  /** The lock's ANGLE folder for the target (`include/` holds the EGL and GLES headers). */
  angle: string;
  /** Linux only: the sysroot whose `usr/include` holds the X11 and Wayland headers GLFW compiles against. */
  sysroot?: string;
  pathStyle?: PathStyle;
}

/** No compile names the folder it ran in: a game's and a prebuild's source and build folders read as these. */
const prefixMaps = (source: string, build: string) => [
  `"-ffile-prefix-map=\${CMAKE_SOURCE_DIR}=${source}"`,
  `"-ffile-prefix-map=\${CMAKE_BINARY_DIR}=${build}"`,
];

/** Store maps precede the source/build maps, which win when roots overlap. */
function storePrefixMaps(input: CrossRaylibIncludeInput, style: PathStyle): string[] {
  if (input.zig !== undefined) cmakeForm(input.zig, style);
  const hostPath = style === PathStyle.Win32 ? path.win32 : path.posix;
  const zig = input.zig ? hostPath.dirname(input.zig) : null;
  const folders = [
    [zig, "zig"],
    [input.angle, "angle"],
    [input.sysroot, "sysroot"],
  ];
  return folders.flatMap(([folder, label]) =>
    folder && !folder.includes("=") ? [JSON.stringify(`-ffile-prefix-map=${cmakeForm(folder, style)}=${label}`)] : [],
  );
}

/** The text of `raylib-<target>.cmake`, raylib's `CMAKE_PROJECT_raylib_INCLUDE` for its prebuild. */
export function crossRaylibProjectInclude(target: CrossTarget, input: CrossRaylibIncludeInput): string {
  const spec = CROSS_TARGETS[target];
  const style = input.pathStyle ?? HOST_PATH_STYLE;
  const linux = target === CrossTarget.LinuxX64;
  if (linux && input.sysroot === undefined) throw refusal(MESSAGE.NoSysroot);
  const includes = [joined(style, input.angle, "include")];
  if (linux && input.sysroot !== undefined) includes.push(joined(style, input.sysroot, "usr", "include"));
  const written = includes.map((include) => `include_directories(SYSTEM ${cmakeArg(include, style)})`);
  return [
    header(`raylib-${target}.cmake`, input.lock),
    "# raylib's own CMake reads it as CMAKE_PROJECT_raylib_INCLUDE: GLFW loads ANGLE's EGL by these names.",
    `add_compile_definitions(_GLFW_EGL_LIBRARY=${JSON.stringify(spec.egl)} _GLFW_GLESV2_LIBRARY=${JSON.stringify(spec.glesv2)})`,
    `add_compile_options(${storePrefixMaps(input, style).join(" ")})`,
    `add_compile_options(${prefixMaps("raylib", "raylib-build").join(" ")})`,
    ...(linux ? [] : ['add_compile_options("-gno-codeview-command-line" "-fdebug-compilation-dir=.")']),
    ...written,
    "",
  ].join("\n");
}

/** What {@link crossRaylibConfigure} configures raylib's prebuild from. */
export interface CrossRaylibConfigureInput {
  /** raylib's source folder. */
  source: string;
  /** The build folder. */
  build: string;
  ninja: string;
  /** `toolchain-<target>.cmake`. */
  toolchainFile: string;
  /** `raylib-<target>.cmake`. */
  projectInclude: string;
  /** The lock's ANGLE folder for the target. */
  angle: string;
  /** Linux only: the {@link crossWaylandScanner} script that hands GLFW its pre-generated protocol code. */
  waylandScanner?: string;
  recipe: Recipe;
  pathStyle?: PathStyle;
}

/** raylib's Linux-only cache: GLES headers from ANGLE, GLFW's Wayland protocol code and pkg-config answered. */
function linuxCache(input: CrossRaylibConfigureInput, style: PathStyle): Record<string, string> {
  if (input.waylandScanner === undefined) throw refusal(MESSAGE.NoWaylandScanner);
  return {
    OPENGL_INCLUDE_DIR: cmakeForm(joined(style, input.angle, "include"), style),
    WAYLAND_SCANNER_EXECUTABLE: cmakeForm(input.waylandScanner, style),
    __pkg_config_checked_Wayland: "1",
    __pkg_config_arguments_Wayland: GLFW_WAYLAND_PKG_CONFIG.join(";"),
    Wayland_FOUND: "1",
  };
}

/**
 * The argv after `cmake` that configures raylib's prebuild for a cross destination: raylib's
 * desktop GLFW platform over GLES 3.0, the recipe's compile flags and every `SUPPORT_*` flag
 * stated (with `CUSTOMIZE_BUILD=ON`, raylib's CMake turns on any flag it is not given).
 */
export function crossRaylibConfigure(target: CrossTarget, input: CrossRaylibConfigureInput): string[] {
  const spec: CrossTargetSpec = CROSS_TARGETS[target];
  const style = input.pathStyle ?? HOST_PATH_STYLE;
  const { recipe } = input;
  assertNoRefusedFlag(recipe, recipe.flags.compile);
  const form = (value: string) => cmakeForm(value, style);
  const [source, build, ninja, toolchainFile] = [
    form(input.source),
    form(input.build),
    form(input.ninja),
    form(input.toolchainFile),
  ];
  const projectInclude = form(input.projectInclude);
  form(input.angle);
  const platform = target === CrossTarget.LinuxX64 ? linuxCache(input, style) : {};
  const cache = { ...RAYLIB_CACHE, ...spec.raylibCache, ...platform };
  const support = { ...recipe.raylibConfig, ...spec.raylibConfig };
  return [
    "-S",
    source,
    "-B",
    build,
    "-G",
    "Ninja",
    `-DCMAKE_MAKE_PROGRAM=${ninja}`,
    `-DCMAKE_TOOLCHAIN_FILE=${toolchainFile}`,
    `-DCMAKE_PROJECT_raylib_INCLUDE=${projectInclude}`,
    ...Object.entries(cache).map(([name, value]) => `-D${name}=${value}`),
    `-DCMAKE_C_FLAGS=${[...recipe.flags.compile, `-D${deviceRateDefinition(recipe)}`].join(" ")}`,
    ...Object.keys(support)
      .sort()
      .map((flag) => `-D${flag}=${support[flag] ? "ON" : "OFF"}`),
  ];
}

/**
 * The POSIX shell script given to GLFW's CMake as `WAYLAND_SCANNER_EXECUTABLE`: wayland-scanner
 * runs on the glibc floor (it is not built for the build host), so this copies the file it
 * generated there from `protocols` and refuses any other command or name, writing nothing.
 */
export function crossWaylandScanner(protocols: string): string {
  const folder = shellQuote(cmakeForm(protocols, PathStyle.Posix));
  const cases = Object.entries(WAYLAND_PROTOCOL_OUTPUTS).map(
    ([command, suffix]) => `  ${command}) suffix=${shellQuote(suffix)} ;;`,
  );
  return [
    "#!/bin/sh",
    "# wayland-scanner for GLFW's Wayland backend, generated by Genex: copies the protocol code",
    "# wayland-scanner generated on the glibc floor, since it does not run on this build host.",
    "set -eu",
    `protocols=${folder}`,
    'case "${1-}" in',
    ...cases,
    '  *) echo "genex wayland-scanner: ${1-} is not pre-generated" >&2; exit 2 ;;',
    "esac",
    '[ "$#" -eq 3 ] || { echo "genex wayland-scanner: expected <command> <protocol>.xml <output>" >&2; exit 2; }',
    'name="$(basename -- "$2" .xml)$suffix"',
    'if [ "$name" != "$(basename -- "$3")" ] || [ ! -f "$protocols/$name" ]; then',
    '  echo "genex wayland-scanner: no pre-generated $name for $3" >&2',
    "  exit 2",
    "fi",
    'cp -- "$protocols/$name" "$3"',
    "",
  ].join("\n");
}

/** What {@link crossGenexCmake} writes a game module for. */
export interface CrossGenexInput {
  lock: CrossLock;
  /** The lock's raylib prebuild for the target: its archive and headers. */
  raylib: { lib: string; include: string };
  /** The lock's ANGLE folder for the target. */
  angle: string;
  recipe: Recipe;
  pathStyle?: PathStyle;
}

/** The module's opening: the refusals, offline FetchContent, the build type and the imported raylib. */
function preamble(target: CrossTarget, input: CrossGenexInput, style: PathStyle): string[] {
  const toolchainRead = `"\${GENEX_CROSS_TARGET}" STREQUAL ${JSON.stringify(target)}`;
  const lockRead = `"\${GENEX_CROSS_LOCK}" STREQUAL ${JSON.stringify(input.lock.digest)}`;
  const toolchainFile = crossToolchainFileName(target);
  return [
    header(`genex-${buildTargetOf(target)}.cmake`, input.lock),
    "# A game's CMakeLists.txt includes it after project() and calls genex_add_game(SOURCES <globs>...);",
    `# the configure names this lock's ${toolchainFile} as CMAKE_TOOLCHAIN_FILE.`,
    ...GENEX_BLOCKS.guard,
    `if(NOT ${toolchainRead} OR NOT ${lockRead})`,
    `  message(FATAL_ERROR "genex: a ${target} game is configured with this lock's ${toolchainFile} as CMAKE_TOOLCHAIN_FILE.")`,
    "endif()",
    "",
    ...GENEX_BLOCKS.defaults,
    `set(GENEX_TARGET ${JSON.stringify(target)})`,
    `set(GENEX_LOCK ${JSON.stringify(input.lock.digest)})`,
    ...(target === CrossTarget.WindowsX64 ? ["enable_language(RC)"] : []),
    "",
    "add_library(genex_raylib STATIC IMPORTED GLOBAL)",
    "set_target_properties(genex_raylib PROPERTIES",
    `  IMPORTED_LOCATION ${cmakeArg(input.raylib.lib, style)}`,
    `  INTERFACE_INCLUDE_DIRECTORIES ${cmakeArg(input.raylib.include, style)}`,
    ")",
    "",
  ];
}

const quoted = (flag: string) => `    ${JSON.stringify(flag)}`;

/**
 * How the game links ANGLE's GLESv2 and EGL (the template asks EGL which backend it runs on): the
 * import libraries by path on Windows, by name from ANGLE's folder on Linux.
 */
function angleLink(target: CrossTarget, angle: string, libraries: string, style: PathStyle): string[] {
  if (target === CrossTarget.WindowsX64) {
    const imports = WINDOWS_ANGLE_IMPORTS.map((name) => cmakeArg(joined(style, angle, name), style)).join(" ");
    return [`  target_link_libraries(game PRIVATE genex_raylib ${imports} ${libraries})`];
  }
  return [
    `  target_link_directories(game PRIVATE ${cmakeArg(angle, style)})`,
    `  target_link_libraries(game PRIVATE genex_raylib ${LINUX_ANGLE_LIBRARIES.join(" ")} ${libraries})`,
  ];
}

/**
 * The game target: its flags, raylib, ANGLE, the mixer rate, the destination's link options, the one
 * output folder, on Windows its manifest resource, and the assets beside it.
 */
function gameBlock(target: CrossTarget, input: CrossGenexInput, style: PathStyle): string[] {
  const spec: CrossTargetSpec = CROSS_TARGETS[target];
  const { recipe, angle } = input;
  const linux = target === CrossTarget.LinuxX64;
  return [
    ...GENEX_BLOCKS.sources,
    "  add_executable(game ${genex_sources})",
    "  target_compile_options(game PRIVATE",
    ...compileOptionLines(recipe),
    ...(linux ? [] : ['    "-gno-codeview-command-line"', '    "-fdebug-compilation-dir=."']),
    ...prefixMaps("game", "build").map((flag) => `    ${flag}`),
    "  )",
    "  target_compile_definitions(game PRIVATE",
    ...spec.definitions.map((definition) => `    ${definition}`),
    `    ${gameRateDefinition(recipe)}`,
    "  )",
    `  target_include_directories(game SYSTEM PRIVATE ${cmakeArg(joined(style, angle, "include"), style)})`,
    ...angleLink(target, angle, spec.libraries.join(" "), style),
    "  target_link_options(game PRIVATE",
    ...spec.link.map(quoted),
    "  )",
    "  set_target_properties(game PROPERTIES",
    "    OUTPUT_NAME game",
    // The build rpath would name ANGLE's store folder; the RUNPATH is only $ORIGIN.
    ...(linux ? ["    SKIP_BUILD_RPATH TRUE"] : []),
    '    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/out"',
    "  )",
    ...(linux ? [] : WINDOWS_RESOURCE_BLOCK),
    ...GENEX_BLOCKS.assets,
    "endfunction()",
    "",
  ];
}

/** The text of `genex-<target>.cmake` for one lock, its raylib prebuild and its ANGLE. */
export function crossGenexCmake(target: CrossTarget, input: CrossGenexInput): string {
  const { recipe } = input;
  const style = input.pathStyle ?? HOST_PATH_STYLE;
  assertNoRefusedFlag(recipe, [...recipe.flags.compile, ...recipe.flags.cxx, ...CROSS_TARGETS[target].link]);
  return [...preamble(target, input, style), ...gameBlock(target, input, style)].join("\n");
}

/** How a Rust cross destination links. */
export const RustCrossLinker = {
  /** llvm-mingw's clang as cargo's linker and the `cc` crate's compiler. */
  LlvmMingw: "llvm-mingw",
  /** cargo-zigbuild drives zig as the linker for a glibc-versioned target. */
  CargoZigbuild: "cargo-zigbuild",
} as const;
export type RustCrossLinker = (typeof RustCrossLinker)[keyof typeof RustCrossLinker];

/** How one cross destination's Rust build is compiled, linked and shipped. */
export interface RustCrossTargetSpec {
  /** rustc's target triple: its `rust-std` and the folder Cargo's JSON messages name. */
  readonly rustTriple: string;
  /** What `cargo --target` is handed (cargo-zigbuild reads a glibc version after the triple). */
  readonly cargoTarget: string;
  readonly linker: RustCrossLinker;
  /** The cargo subcommand that builds it. */
  readonly cargoCommand: string;
  /** rustflags the destination adds to the lane's own. */
  readonly rustflags: readonly string[];
  /** Store components it needs beyond the host's Rust sysroot and the vendored crates. */
  readonly components: readonly ToolchainId[];
  /** The executable the lane leaves at the top of `out/`. */
  readonly executable: string;
  /** Store files shipped beside the executable. */
  readonly runtime: readonly string[];
  /** Whether build scripts find the destination's libraries through pkg-config over the Linux sysroot. */
  readonly pkgConfig: boolean;
}

/**
 * The Rust · wgpu cross destinations. Windows: `x86_64-pc-windows-gnullvm` linked by llvm-mingw
 * (ucrt) with the C runtime static, so libunwind links in and no `libunwind.dll` ships; D3D12 only,
 * with FXC's `d3dcompiler_47.dll` from System32, so nothing ships beside `game.exe`. Linux:
 * `x86_64-unknown-linux-gnu` linked by cargo-zigbuild against glibc 2.28 (zig 0.16, never an
 * Apple target); cpal and gilrs-core find libasound and libudev through pkg-config over the Linux
 * sysroot, and the game ships SwiftShader with the Vulkan loader for GPU-less machines.
 */
export const RUST_CROSS_TARGETS = {
  [CrossTarget.WindowsX64]: {
    rustTriple: "x86_64-pc-windows-gnullvm",
    cargoTarget: "x86_64-pc-windows-gnullvm",
    linker: RustCrossLinker.LlvmMingw,
    cargoCommand: "build",
    rustflags: ["-C", "target-feature=+crt-static"],
    components: RUST_CROSS_COMPONENTS[BuildTarget.Windows],
    executable: STACK_CROSS_EXECUTABLES[GameStack.RustWgpu][BuildTarget.Windows],
    runtime: [],
    pkgConfig: false,
  },
  [CrossTarget.LinuxX64]: {
    rustTriple: "x86_64-unknown-linux-gnu",
    cargoTarget: "x86_64-unknown-linux-gnu.2.28",
    linker: RustCrossLinker.CargoZigbuild,
    cargoCommand: "zigbuild",
    rustflags: [],
    components: RUST_CROSS_COMPONENTS[BuildTarget.Linux],
    executable: STACK_CROSS_EXECUTABLES[GameStack.RustWgpu][BuildTarget.Linux],
    runtime: Object.values(LinuxVulkanFile),
    pkgConfig: true,
  },
} as const satisfies Record<CrossTarget, RustCrossTargetSpec>;

/** The cargo subcommand and `--target` that build a Rust game for `target` (the lane adds the rest). */
export function rustCrossCargoArgs(target: CrossTarget): string[] {
  const spec: RustCrossTargetSpec = RUST_CROSS_TARGETS[target];
  return [spec.cargoCommand, "--target", spec.cargoTarget];
}

/** What {@link rustCrossEnv} writes a Rust cross build's environment from: absolute store and build paths. */
export interface RustCrossEnvInput {
  /** The build's own folder: zig's and cargo-zigbuild's caches go inside it, never the user's home. */
  folder: string;
  /** Windows: the store's llvm-mingw root (`bin/` holds its clang and llvm-ar). */
  llvmMingw?: string;
  /** Linux: the store's zig executable, which cargo-zigbuild drives. */
  zig?: string;
  /** Linux: the store's Linux sysroot, whose `.pc` files and libraries pkg-config reads. */
  sysroot?: string;
  /** Linux: the pkg-config the sysroot carries, when the host has none of its own (a Mac). */
  pkgConfig?: string;
}

const RUST_MESSAGE = {
  NoLlvmMingw: "A Rust Windows build needs the store's llvm-mingw.",
  NoZig: "A Rust Linux build needs the store's zig for cargo-zigbuild.",
  NoSysroot: "A Rust Linux build needs the Linux sysroot pkg-config reads.",
  UnwritablePath: (value: string) =>
    `${JSON.stringify(value)} cannot be handed to a Rust cross build: it must be absolute, with no ':' or control character.`,
} as const;

/** `:` splits PKG_CONFIG_PATH; a control character ends a value. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses.
const UNWRITABLE_ENV = /[:\x00-\x1f\x7f]/;

/** `value` as a variable may carry it: an absolute POSIX path (the Rust lanes run on a Mac or Linux), else refused. */
function envPath(value: string): string {
  if (!value.startsWith("/") || UNWRITABLE_ENV.test(value)) throw refusal(RUST_MESSAGE.UnwritablePath(value));
  return value;
}

/** A triple as the `cc` and pkg-config crates read it in a variable name (`x86_64_pc_windows_gnullvm`). */
const envTriple = (triple: string) => triple.replaceAll("-", "_");

/** llvm-mingw's compilers and archiver as cargo's linker and the `cc` crate's tools, scoped to the target. */
function windowsRustEnv(input: RustCrossEnvInput, triple: string): Record<string, string> {
  if (input.llvmMingw === undefined) throw refusal(RUST_MESSAGE.NoLlvmMingw);
  const bin = path.posix.join(envPath(input.llvmMingw), "bin");
  const clang = path.posix.join(bin, "x86_64-w64-mingw32-clang");
  const scoped = envTriple(triple);
  return {
    [`CC_${scoped}`]: clang,
    [`CXX_${scoped}`]: `${clang}++`,
    [`AR_${scoped}`]: path.posix.join(bin, "llvm-ar"),
    [`CARGO_TARGET_${scoped.toUpperCase()}_LINKER`]: clang,
  };
}

/**
 * pkg-config over the sysroot for the Linux target only (a host build script never sees it):
 * `LIBDIR` as well as `PATH`, so the host's own `.pc` folders are never searched; zig for
 * cargo-zigbuild, with both caches in the build folder.
 */
function linuxRustEnv(input: RustCrossEnvInput, triple: string): Record<string, string> {
  if (input.zig === undefined) throw refusal(RUST_MESSAGE.NoZig);
  if (input.sysroot === undefined) throw refusal(RUST_MESSAGE.NoSysroot);
  const sysroot = envPath(input.sysroot);
  const zig = envPath(input.zig);
  const pcDirs = ["usr/lib64/pkgconfig", "usr/share/pkgconfig"].map((dir) => path.posix.join(sysroot, dir)).join(":");
  const scoped = envTriple(triple);
  const pkgConfig = input.pkgConfig === undefined ? {} : { [`PKG_CONFIG_${scoped}`]: envPath(input.pkgConfig) };
  return {
    [`PKG_CONFIG_SYSROOT_DIR_${scoped}`]: sysroot,
    [`PKG_CONFIG_PATH_${scoped}`]: pcDirs,
    [`PKG_CONFIG_LIBDIR_${scoped}`]: pcDirs,
    [`PKG_CONFIG_ALLOW_CROSS_${scoped}`]: "1",
    ...pkgConfig,
    CARGO_ZIGBUILD_ZIG_PATH: zig,
    CARGO_ZIGBUILD_CACHE_DIR: path.posix.join(input.folder, "zigbuild"),
    ...crossBuildEnv(input.folder, PathStyle.Posix),
  };
}

/**
 * The variables a Rust cross build of `target` adds to the lane's environment, from the store's
 * tools: refused before any variable exists when a tool is missing or a path is not absolute or
 * holds `:` or a control character.
 */
export function rustCrossEnv(target: CrossTarget, input: RustCrossEnvInput): Record<string, string> {
  envPath(input.folder);
  const { rustTriple } = RUST_CROSS_TARGETS[target];
  return target === CrossTarget.WindowsX64 ? windowsRustEnv(input, rustTriple) : linuxRustEnv(input, rustTriple);
}

/** Fixed paths the format digest generates every text from. */
const FORMAT_SAMPLE = {
  lock: { digest: "0".repeat(64) },
  store: "/genex/lock",
  pathStyle: PathStyle.Posix,
} as const;

/** Every text and argv this module generates for one target, from {@link FORMAT_SAMPLE}. */
function sampleTexts(target: CrossTarget, recipe: Recipe): unknown[] {
  const { lock, store, pathStyle } = FORMAT_SAMPLE;
  const at = (name: string) => path.posix.join(store, name);
  const sysroot = at("sysroot");
  return [
    crossToolchainFile(target, { lock, zig: at("zig"), root: store, sysroot, pathStyle }),
    crossRaylibProjectInclude(target, { lock, angle: at("angle"), sysroot, pathStyle }),
    crossRaylibConfigure(target, {
      source: at("raylib"),
      build: at("build"),
      ninja: at("ninja"),
      toolchainFile: at("toolchain.cmake"),
      projectInclude: at("raylib.cmake"),
      angle: at("angle"),
      waylandScanner: at("wayland-scanner"),
      recipe,
      pathStyle,
    }),
    crossGenexCmake(target, {
      lock,
      raylib: { lib: at("libraylib.a"), include: at("include") },
      angle: at("angle"),
      recipe,
      pathStyle,
    }),
  ];
}

/**
 * The first 12 hex of sha256 over this module's format, the recipe, the cross table and every
 * text it generates for a fixed sample: a cross prebuild made from an older one reads as one to
 * redo, whichever constant changed.
 */
export function crossFormatSha12(recipe: Recipe): string {
  const texts = Object.values(CrossTarget).map((target) => sampleTexts(target, recipe));
  return createHash("sha256")
    .update(`${CROSS_CMAKE_FORMAT}\n${canonicalJson({ recipe, targets: CROSS_TARGETS, texts })}`)
    .digest("hex")
    .slice(0, 12);
}

/**
 * What a lock folder's `prewarm.json` records for its Windows and Linux outputs (`cross`): the
 * first 12 hex of sha256 over {@link crossFormatSha12} and the Linux sysroot's pin (its
 * `manifest.json` sha256, null without one), so a cross prewarm made from an older format, recipe
 * or sysroot reads as one to redo.
 */
export function crossPrewarmSha12(recipe: Recipe, sysrootPin: string | null): string {
  return createHash("sha256")
    .update(`${crossFormatSha12(recipe)}\n${sysrootPin ?? "-"}`)
    .digest("hex")
    .slice(0, 12);
}
