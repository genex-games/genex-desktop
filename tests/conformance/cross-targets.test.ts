// biome-ignore-all lint/suspicious/noTemplateCurlyInString: CMake's own ${VAR} references are the text this file reads.
/**
 * The Windows x64 and Linux x64 destinations' CMake text (`cross-targets.ts`): zig 0.16.0 as
 * CMake's C and C++ compiler for `x86_64-windows-gnu` and `x86_64-linux-gnu.2.28`, archives
 * through `zig ar`, no host library ever found, raylib's own CMake told GLFW's ANGLE library
 * names, and a game module that links ANGLE's GLESv2 (never opengl32 or libGL), statically on
 * Windows and with a RUNPATH of exactly `$ORIGIN` on Linux. Goldens pin the text; hostile paths
 * are refused before any text exists; the real rows configure and link with the developer's
 * CMake and zig when they are present.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { StudioPlatform } from "../../src/shared/boot.ts";
import { GpuQualification, gpuQualificationOf, RUST_GPU_QUALIFICATION } from "../../src/shared/game-export-contract.ts";
import { ALL_BUILD_TARGETS, BuildTarget, GameStack } from "../../src/shared/game-project.ts";
import { STACK_HOST_MATRIX } from "../../src/shared/game-targets.ts";
import { NATIVE_CROSS_EXECUTABLES, STACK_CROSS_EXECUTABLES } from "../../src/shared/native-contract.ts";
import { laneRunsOn, setupTargets } from "../../src/shared/stack-setup.ts";
import {
  LANE_PLATFORMS,
  RUST_CROSS_COMPONENTS,
  ToolchainError,
  ToolchainId,
  ToolchainProblem,
  toolchainHostOf,
} from "../../src/shared/toolchain.ts";
import { LinuxAngleFile, LinuxVulkanFile } from "../../src/substrate/native-runtime-files.ts";
import { RUST_TRIPLE } from "../../src/substrate/toolchain-store/rust-locate.ts";
import {
  buildTargetOf,
  CROSS_TARGETS,
  CrossTarget,
  crossBuildEnv,
  crossFormatSha12,
  crossGenexCmake,
  crossPrewarmSha12,
  crossRaylibConfigure,
  crossRaylibProjectInclude,
  crossRuntimeFiles,
  crossTargetOf,
  crossToolchainFile,
  crossToolchainFileName,
  crossWaylandScanner,
  isCrossTarget,
  PathStyle,
  RUST_CROSS_TARGETS,
  type RustCrossTargetSpec,
  RustCrossLinker,
  rustCrossCargoArgs,
  rustCrossEnv,
  WAYLAND_PROTOCOL_OUTPUTS,
} from "../../src/substrate/toolchain-store/cross-targets.ts";
import { type Recipe, readRecipe } from "../../src/substrate/toolchain-store/genex-cmake.ts";
import { devTool, needsTools } from "../helpers/dev-toolchains.ts";
import { tmpDir } from "../helpers/tmp.ts";

const execFileAsync = promisify(execFile);
const POSIX_ONLY = process.platform === "win32" ? { skip: "the dev toolchains are macOS and Linux builds" } : {};

const DIGEST = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const ZIG = "/store/zig-0.16.0/zig";
const SYSROOT = "/store/sysroot-linux-x64-x11";
const ROOT = "/store/locks/0123456789ab";
const SCANNER = "/store/locks/0123456789ab/wayland-scanner";
const ANGLE = {
  [CrossTarget.WindowsX64]: "/store/angle-windows-x64-d3d11/c5bf49e78850",
  [CrossTarget.LinuxX64]: "/store/angle-linux-x64-vulkan/c5bf49e78850",
} as const;
const TARGETS = [CrossTarget.WindowsX64, CrossTarget.LinuxX64] as const;

const raylibOf = (target: CrossTarget) => ({
  lib: `/store/locks/0123456789ab/raylib-${CROSS_TARGETS[target].raylib}/lib/libraylib.a`,
  include: `/store/locks/0123456789ab/raylib-${CROSS_TARGETS[target].raylib}/include`,
});
const toolchain = (target: CrossTarget, zig = ZIG) =>
  crossToolchainFile(target, {
    lock: { digest: DIGEST },
    zig,
    root: ROOT,
    ...(target === CrossTarget.LinuxX64 ? { sysroot: SYSROOT } : {}),
  });
const genex = (target: CrossTarget, recipe: Recipe = readRecipe(), angle: string = ANGLE[target]) =>
  crossGenexCmake(target, { lock: { digest: DIGEST }, raylib: raylibOf(target), angle, recipe });
const projectInclude = (target: CrossTarget, angle: string = ANGLE[target], zig = ZIG) =>
  crossRaylibProjectInclude(target, {
    lock: { digest: DIGEST },
    angle,
    zig,
    ...(target === CrossTarget.LinuxX64 ? { sysroot: SYSROOT } : {}),
  });
const configure = (target: CrossTarget, recipe: Recipe = readRecipe(), scanner = SCANNER) =>
  crossRaylibConfigure(target, {
    source: "/store/raylib-6.0",
    build: "/work/raylib-build",
    ninja: "/store/ninja-1.13.2/ninja",
    toolchainFile: `/store/genex/toolchain-${target}.cmake`,
    projectInclude: `/store/genex/raylib-${target}.cmake`,
    angle: ANGLE[target],
    ...(target === CrossTarget.LinuxX64 ? { waylandScanner: scanner } : {}),
    recipe,
  });

const isPrewarmRefusal = (error: unknown) =>
  error instanceof ToolchainError && error.problem === ToolchainProblem.Prewarm;

describe("cross targets: the vocabulary", () => {
  it("names exactly the two cross destinations, each with its zig triple", () => {
    assert.deepEqual(Object.values(CrossTarget).sort(), ["linux-x64", "windows-x64"]);
    assert.equal(CROSS_TARGETS[CrossTarget.WindowsX64].triple, "x86_64-windows-gnu");
    assert.equal(CROSS_TARGETS[CrossTarget.LinuxX64].triple, "x86_64-linux-gnu.2.28");
    for (const value of ["windows-x64", "linux-x64"]) assert.equal(isCrossTarget(value), true, value);
    for (const value of ["web", "macos", "win32-x64", "Windows-x64", "", null, 3])
      assert.equal(isCrossTarget(value), false);
  });

  it("ships ANGLE beside the executable: D3D11 DLLs with d3dcompiler on Windows, Vulkan + SwiftShader on Linux", () => {
    assert.deepEqual(crossRuntimeFiles(CrossTarget.WindowsX64), ["libEGL.dll", "libGLESv2.dll", "d3dcompiler_47.dll"]);
    assert.deepEqual(crossRuntimeFiles(CrossTarget.LinuxX64), [
      "libEGL.so",
      "libGLESv2.so",
      "libvulkan.so.1",
      "libvk_swiftshader.so",
      "vk_swiftshader_icd.json",
    ]);
  });
});

describe("cross targets: toolchain-<target>.cmake", () => {
  it("makes zig CMake's C and C++ compiler for the target triple and archives through zig ar", () => {
    for (const target of TARGETS) {
      const out = toolchain(target);
      const triple = CROSS_TARGETS[target].triple;
      assert.ok(out.includes(`set(CMAKE_C_COMPILER [=[${ZIG}]=] cc -target ${triple})`), target);
      assert.ok(out.includes(`set(CMAKE_CXX_COMPILER [=[${ZIG}]=] c++ -target ${triple})`), target);
      assert.ok(out.includes('"<CMAKE_AR> ar qc <TARGET> <LINK_FLAGS> <OBJECTS>"'), target);
      assert.ok(out.includes('set(CMAKE_USER_MAKE_RULES_OVERRIDE "${CMAKE_CURRENT_LIST_FILE}")'), target);
      assert.doesNotMatch(out, /build\.zig/);
    }
  });

  it("roots every find_* in the store's folder (and the Linux sysroot), programs included", () => {
    assert.ok(toolchain(CrossTarget.WindowsX64).includes(`set(CMAKE_FIND_ROOT_PATH [=[${ROOT}]=])`));
    assert.ok(toolchain(CrossTarget.LinuxX64).includes(`set(CMAKE_FIND_ROOT_PATH [=[${ROOT}]=] [=[${SYSROOT}]=])`));
    for (const target of TARGETS)
      for (const kind of ["PROGRAM", "LIBRARY", "INCLUDE", "PACKAGE"])
        assert.ok(toolchain(target).includes(`set(CMAKE_FIND_ROOT_PATH_MODE_${kind} ONLY)`), `${target} ${kind}`);
  });

  it("compiles Windows resources with zig rc, never a host windres", () => {
    const windows = toolchain(CrossTarget.WindowsX64);
    assert.ok(windows.includes(`set(CMAKE_RC_COMPILER [=[${ZIG}]=])`));
    assert.match(windows, /CMAKE_RC_COMPILE_OBJECT "<CMAKE_RC_COMPILER> rc .* \/fo <OBJECT> -- <SOURCE>"/);
    assert.doesNotMatch(toolchain(CrossTarget.LinuxX64), /CMAKE_RC_/);
  });

  it("marks the configure with its target and lock, for the genex module to check", () => {
    for (const target of TARGETS) {
      assert.ok(toolchain(target).includes(`set(GENEX_CROSS_TARGET "${target}")`), target);
      assert.ok(toolchain(target).includes(`set(GENEX_CROSS_LOCK "${DIGEST}")`), target);
    }
  });

  it("is byte-stable for a fixed lock (golden)", () => {
    assert.equal(toolchain(CrossTarget.WindowsX64), GOLDEN_TOOLCHAIN_WINDOWS);
    assert.equal(toolchain(CrossTarget.LinuxX64), GOLDEN_TOOLCHAIN_LINUX);
  });
});

describe("cross targets: raylib's prebuild", () => {
  it("tells GLFW ANGLE's library names and compiles against ANGLE's headers", () => {
    const windows = projectInclude(CrossTarget.WindowsX64);
    assert.ok(windows.includes('_GLFW_EGL_LIBRARY="libEGL.dll" _GLFW_GLESV2_LIBRARY="libGLESv2.dll"'));
    assert.ok(windows.includes(`include_directories(SYSTEM [=[${ANGLE[CrossTarget.WindowsX64]}/include]=])`));
    const linux = projectInclude(CrossTarget.LinuxX64);
    assert.ok(linux.includes('_GLFW_EGL_LIBRARY="libEGL.so" _GLFW_GLESV2_LIBRARY="libGLESv2.so"'));
    assert.ok(linux.includes(`include_directories(SYSTEM [=[${SYSROOT}/usr/include]=])`));
  });

  it("refuses a Linux prebuild with no X11 sysroot", () => {
    assert.throws(
      () =>
        crossRaylibProjectInclude(CrossTarget.LinuxX64, {
          lock: { digest: DIGEST },
          angle: ANGLE[CrossTarget.LinuxX64],
        }),
      isPrewarmRefusal,
    );
  });

  it("configures raylib's desktop GLFW platform over GLES 3.0, every SUPPORT_* flag stated", () => {
    const recipe = readRecipe();
    for (const target of TARGETS) {
      const args = configure(target, recipe);
      for (const wanted of [
        "-DPLATFORM=Desktop",
        "-DOPENGL_VERSION=ES 3.0",
        "-DCUSTOMIZE_BUILD=ON",
        "-DUSE_EXTERNAL_GLFW=OFF",
        // Flipped (wave 5): raylib's audio device opens at the recipe's mixer rate.
        "-DCMAKE_C_FLAGS=-ffp-contract=off -DAUDIO_DEVICE_SAMPLE_RATE=48000",
        `-DCMAKE_TOOLCHAIN_FILE=/store/genex/toolchain-${target}.cmake`,
        `-DCMAKE_PROJECT_raylib_INCLUDE=/store/genex/raylib-${target}.cmake`,
      ])
        assert.ok(args.includes(wanted), `${target}: ${wanted}`);
      const support = args.filter((arg) => arg.startsWith("-DSUPPORT_"));
      assert.deepEqual(
        support.map((arg) => arg.slice(2, arg.indexOf("="))),
        Object.keys(recipe.raylibConfig).sort(),
      );
    }
  });

  it("maps the prebuild's own folders out of every compile", () => {
    for (const target of TARGETS)
      assert.ok(
        projectInclude(target).includes(
          'add_compile_options("-ffile-prefix-map=${CMAKE_SOURCE_DIR}=raylib" "-ffile-prefix-map=${CMAKE_BINARY_DIR}=raylib-build")',
        ),
        target,
      );
  });

  it("maps the store's zig, ANGLE and sysroot folders out of every compile: the prebuild names no build-host folder", () => {
    const store = [
      `"-ffile-prefix-map=${path.posix.dirname(ZIG)}=zig"`,
      `"-ffile-prefix-map=${ANGLE[CrossTarget.WindowsX64]}=angle"`,
    ];
    const windows = projectInclude(CrossTarget.WindowsX64);
    for (const map of store) assert.ok(windows.includes(map), `windows: ${map}`);
    const linux = projectInclude(CrossTarget.LinuxX64);
    for (const map of [
      `"-ffile-prefix-map=${path.posix.dirname(ZIG)}=zig"`,
      `"-ffile-prefix-map=${ANGLE[CrossTarget.LinuxX64]}=angle"`,
      `"-ffile-prefix-map=${SYSROOT}=sysroot"`,
    ])
      assert.ok(linux.includes(map), `linux: ${map}`);
    for (const out of [windows, linux])
      assert.ok(
        out.indexOf("=zig") < out.indexOf("${CMAKE_SOURCE_DIR}=raylib"),
        "the prebuild's own folders come last, so their maps win where they overlap",
      );
  });

  it("leaves a store folder whose path holds '=' unmapped rather than mis-split at its '='", () => {
    const zig = "/st=ore/zig-0.16.0/zig";
    const out = projectInclude(CrossTarget.WindowsX64, ANGLE[CrossTarget.WindowsX64], zig);
    assert.equal(out.includes("/st=ore"), false, out);
    assert.ok(out.includes(`"-ffile-prefix-map=${ANGLE[CrossTarget.WindowsX64]}=angle"`), "the other maps stay");
  });

  it("keeps the compile's command line out of the Windows prebuild's CodeView, and only there", () => {
    assert.ok(projectInclude(CrossTarget.WindowsX64).includes('"-gno-codeview-command-line"'));
    assert.equal(projectInclude(CrossTarget.LinuxX64).includes("codeview"), false);
  });

  it("refuses a recipe that asks for a refused flag", () => {
    const recipe = readRecipe();
    const tampered: Recipe = {
      ...recipe,
      flags: { ...recipe.flags, compile: [...recipe.flags.compile, "-ffast-math"] },
    };
    for (const target of TARGETS) {
      assert.throws(() => configure(target, tampered), isPrewarmRefusal);
      assert.throws(() => genex(target, tampered), isPrewarmRefusal);
    }
  });

  it("is byte-stable (golden)", () => {
    assert.equal(projectInclude(CrossTarget.WindowsX64), GOLDEN_RAYLIB_INCLUDE_WINDOWS);
    assert.equal(projectInclude(CrossTarget.LinuxX64), GOLDEN_RAYLIB_INCLUDE_LINUX);
  });
});

describe("cross targets: GLFW's X11 and Wayland backends on Linux", () => {
  it("turns the X11 image clipboard off on Linux only (it calls Xlib directly) and builds X11 and Wayland GLFW", () => {
    const linux = configure(CrossTarget.LinuxX64);
    assert.ok(linux.includes("-DSUPPORT_CLIPBOARD_IMAGE=OFF"));
    assert.ok(linux.includes("-DGLFW_BUILD_X11=ON"));
    assert.ok(linux.includes("-DGLFW_BUILD_WAYLAND=ON"));
    assert.ok(linux.includes(`-DOPENGL_INCLUDE_DIR=${ANGLE[CrossTarget.LinuxX64]}/include`));
    assert.ok(configure(CrossTarget.WindowsX64).includes("-DSUPPORT_CLIPBOARD_IMAGE=ON"));
    assert.equal(
      configure(CrossTarget.WindowsX64).some((arg) => /WAYLAND|Wayland/.test(arg)),
      false,
    );
  });

  it("hands GLFW's Wayland backend the pre-generated protocol code and answers its pkg-config check", () => {
    const linux = configure(CrossTarget.LinuxX64);
    assert.ok(linux.includes(`-DWAYLAND_SCANNER_EXECUTABLE=${SCANNER}`));
    assert.ok(linux.includes("-D__pkg_config_checked_Wayland=1"));
    assert.ok(linux.includes("-DWayland_FOUND=1"));
    assert.ok(
      linux.includes(
        "-D__pkg_config_arguments_Wayland=REQUIRED;wayland-client>=0.2.7;wayland-cursor>=0.2.7;wayland-egl>=0.2.7;xkbcommon>=0.5.0",
      ),
    );
    const { waylandScanner: _, ...noScanner } = {
      source: "/s",
      build: "/b",
      ninja: "/n",
      toolchainFile: "/t",
      projectInclude: "/i",
      angle: "/a",
      waylandScanner: SCANNER,
      recipe: readRecipe(),
    };
    assert.throws(() => crossRaylibConfigure(CrossTarget.LinuxX64, noScanner), isPrewarmRefusal);
  });
});

describe("cross targets: genex-<target>.cmake", () => {
  it("carries every recipe flag and none of the refused ones", () => {
    const recipe = readRecipe();
    for (const target of TARGETS) {
      const out = genex(target, recipe);
      for (const flag of [...recipe.flags.compile, ...recipe.flags.cxx, ...CROSS_TARGETS[target].definitions])
        assert.ok(out.includes(flag), `${target} carries ${flag}`);
      for (const refused of recipe.flags.refused)
        assert.ok(!out.includes(refused), `${target} never carries ${refused}`);
    }
  });

  it("links ANGLE's GLESv2 and never desktop OpenGL", () => {
    const windows = genex(CrossTarget.WindowsX64);
    assert.ok(windows.includes(`[=[${ANGLE[CrossTarget.WindowsX64]}/libGLESv2.dll.lib]=]`));
    assert.match(windows, /"-static"/);
    const linux = genex(CrossTarget.LinuxX64);
    assert.ok(linux.includes(`target_link_directories(game PRIVATE [=[${ANGLE[CrossTarget.LinuxX64]}]=])`));
    assert.match(linux, /target_link_libraries\(game PRIVATE genex_raylib GLESv2 /);
    for (const out of [windows, linux]) {
      assert.doesNotMatch(out, /opengl32|OpenGL|libGL\.so|[ "]-lGL[ "]| GL[ )]/);
      assert.ok(out.includes("GRAPHICS_API_OPENGL_ES3"));
    }
  });

  it("gives the Linux executable a RUNPATH of exactly $ORIGIN, no build rpath into the store, and strips it", () => {
    const linux = genex(CrossTarget.LinuxX64);
    assert.ok(linux.includes('    "-s"\n'));
    assert.ok(linux.includes('"LINKER:-rpath,$ORIGIN"'));
    assert.ok(linux.includes('"LINKER:--enable-new-dtags"'));
    assert.ok(linux.includes("SKIP_BUILD_RPATH TRUE"));
    assert.doesNotMatch(genex(CrossTarget.WindowsX64), /rpath|ORIGIN/);
  });

  it("links the Windows game stripped, its timestamp a hash of its bytes (/Brepro): no game.pdb ties game.exe to its build folder", () => {
    const windows = genex(CrossTarget.WindowsX64);
    const link = windows.slice(
      windows.indexOf("target_link_options(game PRIVATE"),
      windows.indexOf("set_target_properties(game"),
    );
    for (const flag of ['"-static"', '"-Wl,--subsystem,windows"', '"-Wl,-Brepro"', '"-s"'])
      assert.ok(link.includes(flag), `windows links with ${flag}: ${link}`);
    assert.ok(windows.includes('    "-gno-codeview-command-line"\n'), "no compile names its command line");
    assert.equal(genex(CrossTarget.LinuxX64).includes("codeview"), false, "Linux has no CodeView");
  });

  it("refuses an in-source build and a configure without its toolchain file", () => {
    for (const target of TARGETS) {
      const out = genex(target);
      assert.match(out, /in-source builds are refused/);
      const marker = `if(NOT "\${GENEX_CROSS_TARGET}" STREQUAL "${target}" OR NOT "\${GENEX_CROSS_LOCK}" STREQUAL "${DIGEST}")`;
      assert.ok(out.includes(marker), target);
      assert.ok(out.includes('"-ffile-prefix-map=${CMAKE_SOURCE_DIR}=game"'), target);
      assert.ok(out.includes('"-ffile-prefix-map=${CMAKE_BINARY_DIR}=build"'), target);
      assert.ok(out.includes('RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/out"'), target);
      assert.match(out, /file\(GLOB genex_found CONFIGURE_DEPENDS /);
    }
  });

  it("is byte-stable for a fixed lock (golden)", () => {
    assert.equal(genex(CrossTarget.WindowsX64), GOLDEN_GENEX_WINDOWS);
    assert.equal(genex(CrossTarget.LinuxX64), GOLDEN_GENEX_LINUX);
  });
});

describe("cross targets: what the merged C++ template needs from its module", () => {
  it("defines GENEX_AUDIO_RATE_HZ from the recipe's one mixer rate, as the Mac module does", () => {
    const recipe = readRecipe();
    const slower: Recipe = { ...recipe, nativeAudioRateHz: 44_100 };
    for (const target of TARGETS) {
      assert.match(genex(target, recipe), new RegExp(`^ {4}GENEX_AUDIO_RATE_HZ=${recipe.nativeAudioRateHz}$`, "m"));
      assert.match(genex(target, slower), /^ {4}GENEX_AUDIO_RATE_HZ=44100$/m, `${target} follows the recipe`);
    }
  });

  it("opens raylib's audio device at that same rate, and GLFW loads ANGLE's libraries by their names on each OS", () => {
    const recipe = readRecipe();
    const slower: Recipe = { ...recipe, nativeAudioRateHz: 44_100 };
    const cFlags = (args: readonly string[]) => args.find((arg) => arg.startsWith("-DCMAKE_C_FLAGS="));
    for (const target of TARGETS) {
      assert.equal(
        cFlags(configure(target, recipe)),
        "-DCMAKE_C_FLAGS=-ffp-contract=off -DAUDIO_DEVICE_SAMPLE_RATE=48000",
      );
      assert.equal(
        cFlags(configure(target, slower)),
        "-DCMAKE_C_FLAGS=-ffp-contract=off -DAUDIO_DEVICE_SAMPLE_RATE=44100",
      );
    }
    assert.ok(
      projectInclude(CrossTarget.WindowsX64).includes(
        'add_compile_definitions(_GLFW_EGL_LIBRARY="libEGL.dll" _GLFW_GLESV2_LIBRARY="libGLESv2.dll")',
      ),
    );
    assert.ok(
      projectInclude(CrossTarget.LinuxX64).includes(
        'add_compile_definitions(_GLFW_EGL_LIBRARY="libEGL.so" _GLFW_GLESV2_LIBRARY="libGLESv2.so")',
      ),
    );
  });

  it("links ANGLE's EGL beside its GLESv2: the game asks EGL which backend it runs on", () => {
    const windows = genex(CrossTarget.WindowsX64);
    const angleWindows = ANGLE[CrossTarget.WindowsX64];
    assert.ok(
      windows.includes(
        `target_link_libraries(game PRIVATE genex_raylib [=[${angleWindows}/libGLESv2.dll.lib]=] [=[${angleWindows}/libEGL.dll.lib]=] winmm gdi32 user32 shell32)`,
      ),
    );
    assert.ok(
      genex(CrossTarget.LinuxX64).includes("target_link_libraries(game PRIVATE genex_raylib GLESv2 EGL m pthread dl)"),
    );
  });

  it("keeps ANGLE's headers a SYSTEM include and maps the game's folders out of every compile", () => {
    for (const target of TARGETS) {
      const out = genex(target);
      assert.ok(out.includes(`target_include_directories(game SYSTEM PRIVATE [=[${ANGLE[target]}/include]=])`), target);
      assert.ok(out.includes('    "-ffile-prefix-map=${CMAKE_SOURCE_DIR}=game"'), target);
      assert.ok(out.includes('    "-ffile-prefix-map=${CMAKE_BINARY_DIR}=build"'), target);
    }
  });

  it("copies the staged assets into out/assets beside the executable, as the Mac module does", () => {
    for (const target of TARGETS) {
      const out = genex(target);
      assert.ok(out.includes('  set(genex_assets_out "${CMAKE_BINARY_DIR}/out/assets")'), target);
      assert.ok(out.includes('  set(genex_assets_done "${CMAKE_BINARY_DIR}/genex-assets.done")'), target);
      assert.ok(out.includes("GENEX_ASSETS_STAMP"), target);
      assert.ok(out.includes('    COMMAND "${CMAKE_COMMAND}" -E rm -rf "${genex_assets_out}"'), target);
      assert.ok(out.includes('  add_custom_target(genex_copy_assets ALL DEPENDS "${genex_assets_done}")'), target);
      assert.ok(
        out.indexOf("genex_copy_assets") < out.lastIndexOf("endfunction()"),
        `${target}: inside genex_add_game`,
      );
    }
  });
});

describe("cross targets: zig's caches and the format digest", () => {
  it("keeps zig's global and local caches in the folder it is given", () => {
    assert.deepEqual(crossBuildEnv("/work/zig-cache"), {
      ZIG_GLOBAL_CACHE_DIR: "/work/zig-cache/global",
      ZIG_LOCAL_CACHE_DIR: "/work/zig-cache/local",
    });
  });

  it("changes when the recipe changes and is stable otherwise", () => {
    const recipe = readRecipe();
    assert.match(crossFormatSha12(recipe), /^[0-9a-f]{12}$/);
    assert.equal(crossFormatSha12(recipe), crossFormatSha12(readRecipe()));
    const changed: Recipe = { ...recipe, flags: { ...recipe.flags, cxx: ["-std=c++23"] } };
    assert.notEqual(crossFormatSha12(changed), crossFormatSha12(recipe));
    const [flag = ""] = Object.keys(recipe.raylibConfig);
    const toggled: Recipe = { ...recipe, raylibConfig: { ...recipe.raylibConfig, [flag]: !recipe.raylibConfig[flag] } };
    assert.notEqual(crossFormatSha12(toggled), crossFormatSha12(recipe), "a configure-only change counts");
  });
});

describe("cross targets: build targets, file names and the prewarm digest", () => {
  it("maps Windows and Linux to their cross destinations and back, and nothing else", () => {
    assert.equal(crossTargetOf(BuildTarget.Windows), CrossTarget.WindowsX64);
    assert.equal(crossTargetOf(BuildTarget.Linux), CrossTarget.LinuxX64);
    for (const target of [BuildTarget.Web, BuildTarget.Mac]) assert.equal(crossTargetOf(target), null, target);
    for (const target of TARGETS) assert.equal(crossTargetOf(buildTargetOf(target)), target);
    assert.equal(crossToolchainFileName(CrossTarget.WindowsX64), "toolchain-windows-x64.cmake");
    assert.equal(crossToolchainFileName(CrossTarget.LinuxX64), "toolchain-linux-x64.cmake");
  });

  it("names the game module by its build target, as the lock folder holds it", () => {
    assert.ok(
      genex(CrossTarget.WindowsX64).startsWith(
        "# genex-windows.cmake: generated by Genex for toolchain lock 0123456789ab.",
      ),
    );
    assert.ok(
      genex(CrossTarget.LinuxX64).startsWith(
        "# genex-linux.cmake: generated by Genex for toolchain lock 0123456789ab.",
      ),
    );
  });

  it("changes the prewarm digest when the cross format, the mixer rate or the Linux sysroot pin changes", () => {
    const recipe = readRecipe();
    const pin = "0405db2d151ec8d07a905b2452917bfea0c2d0082a604e364b13c2dd8df5ee56";
    const base = crossPrewarmSha12(recipe, pin);
    assert.match(base, /^[0-9a-f]{12}$/);
    assert.equal(base, crossPrewarmSha12(readRecipe(), pin), "stable for the same inputs");
    const slower: Recipe = { ...recipe, nativeAudioRateHz: 44_100 };
    assert.notEqual(crossFormatSha12(slower), crossFormatSha12(recipe), "the rate reaches the cross texts");
    assert.notEqual(crossPrewarmSha12(slower, pin), base, "a format change counts");
    assert.notEqual(crossPrewarmSha12(recipe, "f".repeat(64)), base, "a sysroot pin change counts");
    assert.notEqual(crossPrewarmSha12(recipe, null), base, "no sysroot pin at all counts");
  });

  it("keeps the raylib cross format the Rust specs joined beside (characterization)", () => {
    // The Rust specs are their own table: a raylib prebuild made before them is still current.
    assert.equal(crossFormatSha12(readRecipe()), "a7ab86761f91");
    assert.equal(crossPrewarmSha12(readRecipe(), null), "88a2fa2bb2ba");
  });
});

const LLVM_MINGW = "/store/llvm-mingw/20260922";
const RUST_FOLDER = "/work/rust-build/linux";
const RUST_SYSROOT = "/store/linux-sysroot/0405db2d151e";
const PKG_CONFIG = "/store/linux-sysroot/0405db2d151e/bin/pkg-config";

describe("cross targets: the Rust · wgpu specs", () => {
  it("has a Rust spec for every cross destination, beside raylib's and never inside its table", () => {
    assert.deepEqual(Object.keys(RUST_CROSS_TARGETS).sort(), Object.values(CrossTarget).sort());
    const executables: Readonly<Record<string, string>> = STACK_CROSS_EXECUTABLES[GameStack.RustWgpu];
    for (const target of TARGETS) {
      const spec: RustCrossTargetSpec = RUST_CROSS_TARGETS[target];
      assert.equal(spec.rustTriple, RUST_TRIPLE[buildTargetOf(target)], target);
      assert.equal(spec.executable, executables[buildTargetOf(target)], target);
    }
    // A table missing a destination does not typecheck.
    // @ts-expect-error: the Linux spec is missing.
    const partial: Record<CrossTarget, RustCrossTargetSpec> = {
      [CrossTarget.WindowsX64]: RUST_CROSS_TARGETS[CrossTarget.WindowsX64],
    };
    assert.ok(partial);
  });

  it("builds Windows for x86_64-pc-windows-gnullvm with llvm-mingw: static CRT, no zig, nothing shipped beside", () => {
    const spec = RUST_CROSS_TARGETS[CrossTarget.WindowsX64];
    assert.equal(spec.rustTriple, "x86_64-pc-windows-gnullvm");
    assert.equal(spec.cargoTarget, "x86_64-pc-windows-gnullvm");
    assert.equal(spec.linker, RustCrossLinker.LlvmMingw);
    assert.deepEqual(rustCrossCargoArgs(CrossTarget.WindowsX64), ["build", "--target", "x86_64-pc-windows-gnullvm"]);
    assert.deepEqual(spec.rustflags, ["-C", "target-feature=+crt-static"]);
    assert.deepEqual(spec.components, [ToolchainId.RustStdWindows, ToolchainId.LlvmMingw]);
    assert.equal(spec.pkgConfig, false);
    // D3D12, DXGI and FXC's d3dcompiler_47 are System32's: a Rust game ships no ANGLE and no DLL.
    assert.deepEqual(spec.runtime, []);
  });

  it("builds Linux for glibc 2.28 with zig and cargo-zigbuild, reads the sysroot through pkg-config, ships SwiftShader", () => {
    const spec = RUST_CROSS_TARGETS[CrossTarget.LinuxX64];
    assert.equal(spec.rustTriple, "x86_64-unknown-linux-gnu");
    assert.equal(spec.cargoTarget, "x86_64-unknown-linux-gnu.2.28");
    assert.equal(spec.linker, RustCrossLinker.CargoZigbuild);
    assert.deepEqual(rustCrossCargoArgs(CrossTarget.LinuxX64), [
      "zigbuild",
      "--target",
      "x86_64-unknown-linux-gnu.2.28",
    ]);
    assert.deepEqual(spec.rustflags, []);
    assert.deepEqual(spec.components, [
      ToolchainId.RustStdLinux,
      ToolchainId.Zig,
      ToolchainId.CargoZigbuild,
      ToolchainId.LinuxSysroot,
      ToolchainId.SwiftShaderLinux,
    ]);
    assert.equal(spec.pkgConfig, true);
    assert.deepEqual(spec.runtime, Object.values(LinuxVulkanFile));
    const runtime: readonly string[] = spec.runtime;
    for (const name of Object.values(LinuxAngleFile)) assert.ok(!runtime.includes(name), name);
    assert.equal(RUST_CROSS_COMPONENTS[BuildTarget.Linux], spec.components);
    assert.equal(RUST_CROSS_COMPONENTS[BuildTarget.Windows], RUST_CROSS_TARGETS[CrossTarget.WindowsX64].components);
  });

  it("points cargo at llvm-mingw's clang, clang++ and llvm-ar for Windows, scoped to the gnullvm target", () => {
    assert.deepEqual(rustCrossEnv(CrossTarget.WindowsX64, { folder: RUST_FOLDER, llvmMingw: LLVM_MINGW }), {
      CC_x86_64_pc_windows_gnullvm: `${LLVM_MINGW}/bin/x86_64-w64-mingw32-clang`,
      CXX_x86_64_pc_windows_gnullvm: `${LLVM_MINGW}/bin/x86_64-w64-mingw32-clang++`,
      AR_x86_64_pc_windows_gnullvm: `${LLVM_MINGW}/bin/llvm-ar`,
      CARGO_TARGET_X86_64_PC_WINDOWS_GNULLVM_LINKER: `${LLVM_MINGW}/bin/x86_64-w64-mingw32-clang`,
    });
  });

  it("sets PKG_CONFIG_SYSROOT_DIR, PATH and ALLOW_CROSS for the Linux target only, with zig and its caches in the build folder", () => {
    const env = rustCrossEnv(CrossTarget.LinuxX64, {
      folder: RUST_FOLDER,
      zig: ZIG,
      sysroot: RUST_SYSROOT,
      pkgConfig: PKG_CONFIG,
    });
    const pcDirs = `${RUST_SYSROOT}/usr/lib64/pkgconfig:${RUST_SYSROOT}/usr/share/pkgconfig`;
    assert.deepEqual(env, {
      PKG_CONFIG_SYSROOT_DIR_x86_64_unknown_linux_gnu: RUST_SYSROOT,
      PKG_CONFIG_PATH_x86_64_unknown_linux_gnu: pcDirs,
      PKG_CONFIG_LIBDIR_x86_64_unknown_linux_gnu: pcDirs,
      PKG_CONFIG_ALLOW_CROSS_x86_64_unknown_linux_gnu: "1",
      PKG_CONFIG_x86_64_unknown_linux_gnu: PKG_CONFIG,
      CARGO_ZIGBUILD_ZIG_PATH: ZIG,
      CARGO_ZIGBUILD_CACHE_DIR: `${RUST_FOLDER}/zigbuild`,
      ZIG_GLOBAL_CACHE_DIR: `${RUST_FOLDER}/global`,
      ZIG_LOCAL_CACHE_DIR: `${RUST_FOLDER}/local`,
    });
    // A build-script for the host (a proc macro's) never sees the sysroot: no unscoped variable.
    for (const name of ["PKG_CONFIG_SYSROOT_DIR", "PKG_CONFIG_PATH", "PKG_CONFIG_ALLOW_CROSS", "PKG_CONFIG"])
      assert.equal(Object.hasOwn(env, name), false, name);
    const noPkgConfig = rustCrossEnv(CrossTarget.LinuxX64, { folder: RUST_FOLDER, zig: ZIG, sysroot: RUST_SYSROOT });
    assert.equal(Object.hasOwn(noPkgConfig, "PKG_CONFIG_x86_64_unknown_linux_gnu"), false);
  });

  it("refuses a missing tool or a hostile path before any variable exists", () => {
    const linux = { folder: RUST_FOLDER, zig: ZIG, sysroot: RUST_SYSROOT, pkgConfig: PKG_CONFIG };
    const rows: Array<[string, () => unknown]> = [
      ["Windows without llvm-mingw", () => rustCrossEnv(CrossTarget.WindowsX64, { folder: RUST_FOLDER })],
      ["Linux without zig", () => rustCrossEnv(CrossTarget.LinuxX64, { folder: RUST_FOLDER, sysroot: RUST_SYSROOT })],
      ["Linux without a sysroot", () => rustCrossEnv(CrossTarget.LinuxX64, { folder: RUST_FOLDER, zig: ZIG })],
      ["a sysroot with the path separator", () => rustCrossEnv(CrossTarget.LinuxX64, { ...linux, sysroot: "/a:b" })],
      ["a relative sysroot", () => rustCrossEnv(CrossTarget.LinuxX64, { ...linux, sysroot: "sysroot" })],
      ["a Windows drive path", () => rustCrossEnv(CrossTarget.LinuxX64, { ...linux, zig: "C:\\zig\\zig.exe" })],
      ["a control character", () => rustCrossEnv(CrossTarget.LinuxX64, { ...linux, pkgConfig: "/a\nb/pkg-config" })],
      ["an empty folder", () => rustCrossEnv(CrossTarget.LinuxX64, { ...linux, folder: "" })],
      [
        "a hostile llvm-mingw",
        () => rustCrossEnv(CrossTarget.WindowsX64, { folder: RUST_FOLDER, llvmMingw: "/a\u0000b" }),
      ],
    ];
    for (const [name, run] of rows) assert.throws(run, isPrewarmRefusal, name);
  });

  it("runs the Rust lanes on a Mac and Linux, never on Windows until its launcher, and nowhere for Three.js", () => {
    assert.equal(laneRunsOn(GameStack.RustWgpu, StudioPlatform.Windows), false);
    assert.equal(laneRunsOn(GameStack.RustWgpu, StudioPlatform.Mac), true);
    assert.equal(laneRunsOn(GameStack.RustWgpu, StudioPlatform.Linux), true);
    assert.deepEqual(LANE_PLATFORMS[GameStack.RustWgpu], [StudioPlatform.Mac, StudioPlatform.Linux]);
    assert.deepEqual(LANE_PLATFORMS[GameStack.RaylibCpp], [StudioPlatform.Mac, StudioPlatform.Linux]);
    // An Intel Mac has no toolchain host, so no stack's setup prepares anything there.
    assert.deepEqual(setupTargets(GameStack.RustWgpu, toolchainHostOf("darwin", "x64")), []);
  });

  it("builds Windows and Linux Rust games on a Mac and on the Linux Studio, runs no Rust Linux build, nothing on Windows", () => {
    const rust = STACK_HOST_MATRIX[GameStack.RustWgpu];
    // Flipped (M5.9): the phones joined the build rows (both on a Mac, Android on Linux), never a run row.
    assert.deepEqual(rust[StudioPlatform.Mac].build, [
      BuildTarget.Web,
      BuildTarget.Mac,
      BuildTarget.Windows,
      BuildTarget.Linux,
      BuildTarget.Ios,
      BuildTarget.Android,
    ]);
    assert.deepEqual(rust[StudioPlatform.Mac].run, [BuildTarget.Web, BuildTarget.Mac]);
    assert.deepEqual(rust[StudioPlatform.Linux].build, [
      BuildTarget.Web,
      BuildTarget.Windows,
      BuildTarget.Linux,
      BuildTarget.Android,
    ]);
    // Flipped (M4 review): no Rust Linux run is prepared or boxed yet.
    assert.deepEqual(rust[StudioPlatform.Linux].run, [BuildTarget.Web]);
    assert.deepEqual(rust[StudioPlatform.Windows], { build: [], run: [] });
  });

  it("labels a Rust Windows or Linux export untested on real GPUs until a real machine runs its row", () => {
    assert.deepEqual(Object.values(GpuQualification).sort(), ["real-gpu", "untested"]);
    assert.equal(gpuQualificationOf(GameStack.RustWgpu, BuildTarget.Windows), GpuQualification.Untested);
    assert.equal(gpuQualificationOf(GameStack.RustWgpu, BuildTarget.Linux), GpuQualification.Untested);
    assert.equal(gpuQualificationOf(GameStack.RustWgpu, BuildTarget.Mac), GpuQualification.RealGpu);
    for (const target of ALL_BUILD_TARGETS) {
      assert.equal(gpuQualificationOf(GameStack.RaylibCpp, target), null, `raylib ${target}`);
      assert.equal(gpuQualificationOf(GameStack.ThreeJs, target), null, `three.js ${target}`);
      assert.ok(Object.values(GpuQualification).includes(RUST_GPU_QUALIFICATION[target]), target);
    }
  });

  it("names the raylib executables unchanged and the Rust ones beside them", () => {
    assert.equal(STACK_CROSS_EXECUTABLES[GameStack.RaylibCpp], NATIVE_CROSS_EXECUTABLES);
    assert.deepEqual(STACK_CROSS_EXECUTABLES[GameStack.RustWgpu], {
      [BuildTarget.Windows]: "game.exe",
      [BuildTarget.Linux]: "game",
    });
  });
});

/** Every path a generator writes into CMake, refused before any text exists. */
const HOSTILE = [
  "relative/zig",
  "/a;b/zig",
  "/a\nb/zig",
  "/a\u0000b/zig",
  "/a\u007fb/zig",
  "/a/$<0:b>/zig",
  "C:\\store\\zig.exe",
  "",
] as const;

describe("cross targets: hostile paths are refused with no side effect", () => {
  for (const bad of HOSTILE) {
    it(`refuses ${JSON.stringify(bad)} in every generator and leaves the recipe untouched`, () => {
      const recipe = readRecipe();
      const before = structuredClone(recipe);
      for (const target of TARGETS) {
        assert.throws(() => toolchain(target, bad), isPrewarmRefusal, `toolchain ${target}`);
        assert.throws(() => genex(target, recipe, bad), isPrewarmRefusal, `genex ${target}`);
        assert.throws(() => projectInclude(target, bad), isPrewarmRefusal, `include ${target}`);
        assert.throws(() => projectInclude(target, ANGLE[target], bad), isPrewarmRefusal, `include ${target}: its zig`);
        const raylib = { ...raylibOf(target), lib: bad };
        assert.throws(
          () => crossGenexCmake(target, { lock: { digest: DIGEST }, raylib, angle: ANGLE[target], recipe }),
          isPrewarmRefusal,
          `raylib ${target}`,
        );
        assert.throws(
          () =>
            crossRaylibConfigure(target, {
              source: bad,
              build: "/work/b",
              ninja: "/store/ninja",
              toolchainFile: "/store/t.cmake",
              projectInclude: "/store/i.cmake",
              angle: ANGLE[target],
              waylandScanner: SCANNER,
              recipe,
            }),
          isPrewarmRefusal,
          `configure ${target}`,
        );
        assert.throws(
          () => crossToolchainFile(target, { lock: { digest: DIGEST }, zig: ZIG, root: bad }),
          isPrewarmRefusal,
          `root ${target}`,
        );
      }
      assert.throws(() => crossBuildEnv(bad), isPrewarmRefusal);
      assert.throws(() => crossWaylandScanner(bad), isPrewarmRefusal);
      assert.throws(() => configure(CrossTarget.LinuxX64, recipe, bad), isPrewarmRefusal, "wayland-scanner");
      assert.deepEqual(recipe, before);
    });
  }

  it("refuses a lock digest that is not 64 lowercase hex", () => {
    for (const digest of ["", "0123", `${DIGEST}\n`, DIGEST.toUpperCase(), `${DIGEST.slice(0, 63)}"`])
      for (const target of TARGETS)
        assert.throws(
          () => crossToolchainFile(target, { lock: { digest }, zig: ZIG, root: ROOT }),
          isPrewarmRefusal,
          digest,
        );
  });

  it("refuses a zig path CMake mis-reads as a compiler: a square bracket, a double quote or a backslash", () => {
    for (const zig of ["/store/a[b/zig", "/store/a]b/zig", "/store/[x]/zig", '/store/"q"/zig', "/store/a\\b/zig"])
      for (const target of TARGETS) assert.throws(() => toolchain(target, zig), isPrewarmRefusal, zig);
  });

  it("refuses a zig path CMake would expand when it reads its compiler back: ${...}, $ENV{...}, $CACHE{...}", () => {
    for (const zig of ["/store/a${CMAKE_HOME}b/zig", "/store/$ENV{HOME}/zig", "/store/$CACHE{X}/zig", "/store/${/zig"])
      for (const target of TARGETS) assert.throws(() => toolchain(target, zig), isPrewarmRefusal, zig);
  });

  it("writes a path with spaces, $, quotes and ]=] as one bracket argument that never closes early", () => {
    const zig = "/store with space/$HOME/#at@ 'q'/zig";
    assert.ok(
      toolchain(CrossTarget.WindowsX64, zig).includes(
        `set(CMAKE_C_COMPILER [=[${zig}]=] cc -target x86_64-windows-gnu)`,
      ),
    );
    const lib = '/store with space/$HOME/"q"/]=]/libraylib.a';
    const out = crossGenexCmake(CrossTarget.LinuxX64, {
      lock: { digest: DIGEST },
      raylib: { ...raylibOf(CrossTarget.LinuxX64), lib },
      angle: ANGLE[CrossTarget.LinuxX64],
      recipe: readRecipe(),
    });
    assert.ok(out.includes(`IMPORTED_LOCATION [==[${lib}]==]`));
  });
});

describe("cross targets: a Windows host's store paths", () => {
  const STORE = "C:\\Users\\me\\AppData\\Local\\Genex\\store";
  const SLASHED = "C:/Users/me/AppData/Local/Genex/store";
  const store = (...parts: string[]) => path.win32.join(STORE, ...parts);
  const pathStyle = PathStyle.Win32;
  const lock = { digest: DIGEST };

  it("are written with forward slashes, as CMake reads them, and zig's caches stay native", () => {
    const zig = store("zig-0.16.0", "zig.exe");
    const linux = crossToolchainFile(CrossTarget.LinuxX64, {
      lock,
      zig,
      root: store("locks", "0123456789ab"),
      sysroot: store("sysroot"),
      pathStyle,
    });
    assert.ok(
      linux.includes(`set(CMAKE_C_COMPILER [=[${SLASHED}/zig-0.16.0/zig.exe]=] cc -target x86_64-linux-gnu.2.28)`),
    );
    assert.ok(linux.includes(`set(CMAKE_FIND_ROOT_PATH [=[${SLASHED}/locks/0123456789ab]=] [=[${SLASHED}/sysroot]=])`));
    const windows = crossGenexCmake(CrossTarget.WindowsX64, {
      lock,
      raylib: { lib: store("raylib", "lib", "libraylib.a"), include: store("raylib", "include") },
      angle: store("angle"),
      recipe: readRecipe(),
      pathStyle,
    });
    assert.ok(windows.includes(`[=[${SLASHED}/angle/libGLESv2.dll.lib]=]`));
    assert.ok(windows.includes(`IMPORTED_LOCATION [=[${SLASHED}/raylib/lib/libraylib.a]=]`));
    const include = crossRaylibProjectInclude(CrossTarget.LinuxX64, {
      lock,
      angle: store("angle"),
      sysroot: store("sysroot"),
      pathStyle,
    });
    const argv = crossRaylibConfigure(CrossTarget.LinuxX64, {
      source: store("raylib-6.0"),
      build: store("work", "raylib"),
      ninja: store("ninja.exe"),
      toolchainFile: store("toolchain-linux-x64.cmake"),
      projectInclude: store("raylib-linux-x64.cmake"),
      angle: store("angle"),
      waylandScanner: store("wayland-scanner"),
      recipe: readRecipe(),
      pathStyle,
    });
    assert.ok(argv.includes(`-DCMAKE_TOOLCHAIN_FILE=${SLASHED}/toolchain-linux-x64.cmake`));
    for (const text of [linux, windows, include, ...argv]) assert.equal(text.includes("\\"), false, text);
    assert.deepEqual(crossBuildEnv(store("work", "zig-cache"), pathStyle), {
      ZIG_GLOBAL_CACHE_DIR: `${STORE}\\work\\zig-cache\\global`,
      ZIG_LOCAL_CACHE_DIR: `${STORE}\\work\\zig-cache\\local`,
    });
  });

  it("refuses one that is not drive-absolute, or that CMake would mis-read as a compiler", () => {
    for (const zig of [
      "zig.exe",
      "\\store\\zig.exe",
      "C:zig.exe",
      "\\\\server\\share\\zig.exe",
      "/posix/zig",
      "C:\\a;b\\zig.exe",
      "C:\\[x]\\zig.exe",
      "C:\\${X}\\zig.exe",
      'C:\\"q"\\zig.exe',
    ])
      for (const target of TARGETS)
        assert.throws(
          () => crossToolchainFile(target, { lock, zig, root: store("lock"), pathStyle }),
          isPrewarmRefusal,
          zig,
        );
  });
});

describe("cross targets: the wayland-scanner stand-in", () => {
  it("names one folder of pre-generated protocol code, shell-quoted, and GLFW's two commands", () => {
    const script = crossWaylandScanner("/store/glfw-wayland/it's here");
    assert.ok(script.startsWith("#!/bin/sh\n"));
    assert.ok(script.includes(`protocols='/store/glfw-wayland/it'\\''s here'`));
    for (const [command, suffix] of Object.entries(WAYLAND_PROTOCOL_OUTPUTS))
      assert.ok(script.includes(`  ${command}) suffix='${suffix}' ;;`), command);
  });

  it("copies the pre-generated file GLFW asks for", POSIX_ONLY, async () => {
    const { protocols, out, scanner } = await scannerFixture();
    for (const [command, suffix] of Object.entries(WAYLAND_PROTOCOL_OUTPUTS)) {
      const name = `xdg-shell${suffix}`;
      const result = await run("sh", [
        scanner,
        command,
        "/raylib/glfw/deps/wayland/xdg-shell.xml",
        path.join(out, name),
      ]);
      assert.equal(result.code, 0, result.out);
      assert.equal(await readFile(path.join(out, name), "utf8"), await readFile(path.join(protocols, name), "utf8"));
    }
  });

  /** Calls the stand-in refuses, each writing nothing. */
  const REFUSED: readonly (readonly string[])[] = [
    ["server-header", "/d/wayland.xml", "wayland-server-protocol.h"],
    ["client-header", "/d/xdg-shell.xml", "wayland-client-protocol.h"],
    ["client-header", "/d/missing.xml", "missing-client-protocol.h"],
    ["private-code", "/d/wayland.xml", "wayland-client-protocol.h"],
    ["client-header", "/d/wayland.xml"],
    [],
  ];
  for (const args of REFUSED)
    it(`refuses ${JSON.stringify(args)} and writes nothing`, POSIX_ONLY, async () => {
      const { out, scanner } = await scannerFixture();
      const result = await run("sh", [scanner, ...args.map((arg, index) => (index === 2 ? path.join(out, arg) : arg))]);
      assert.equal(result.code, 2, result.out);
      assert.deepEqual(await readdir(out), []);
    });
});

/** A protocols folder with two files, an empty output folder and the stand-in script. */
async function scannerFixture() {
  const root = await tmpDir("cross-targets-scanner-");
  const protocols = path.join(root, "it's protocols");
  const out = path.join(root, "out");
  await mkdir(protocols);
  await mkdir(out);
  for (const suffix of Object.values(WAYLAND_PROTOCOL_OUTPUTS))
    for (const name of ["wayland", "xdg-shell"])
      await writeFile(path.join(protocols, `${name}${suffix}`), `/* ${name}${suffix} */\n`);
  const scanner = path.join(root, "wayland-scanner");
  await writeFile(scanner, crossWaylandScanner(protocols));
  return { protocols, out, scanner };
}

// Real rows: the developer's CMake, Ninja and zig (and llvm-mingw's readers) when present.

async function run(file: string, args: readonly string[], env: Record<string, string> = {}) {
  try {
    const { stdout } = await execFileAsync(file, args, {
      env: { ...process.env, ...env },
      maxBuffer: 32 * 1024 * 1024,
    });
    return { code: 0, out: stdout };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? -1, out: `${failed.stdout ?? ""}${failed.stderr ?? ""}` };
  }
}

const tool = (name: Parameters<typeof devTool>[0]): string => {
  const found = devTool(name);
  assert.ok("path" in found, `${name} present`);
  return found.path;
};

const TINY_PROJECT = [
  "cmake_minimum_required(VERSION 3.28)",
  "project(tiny C)",
  "add_library(part STATIC part.c)",
  "add_executable(tiny main.c)",
  "if(WIN32)",
  "  target_sources(tiny PRIVATE tiny.rc)",
  "endif()",
  "target_link_libraries(tiny PRIVATE part)",
  "",
].join("\n");

describe("cross targets under the real CMake and zig (required when present)", POSIX_ONLY, () => {
  it(
    "both toolchain files, read through a hostile zig path, archive with zig ar, compile resources with zig rc and link",
    needsTools("cmake", "ninja", "zig", "llvmMingw"),
    async () => {
      const root = await tmpDir("cross-targets-real-");
      const zigDir = path.join(root, "zig dir $HOME #at@ 'q'");
      await mkdir(zigDir);
      const zig = path.join(zigDir, "zig");
      await symlink(tool("zig"), zig);
      const game = path.join(root, "tiny");
      await mkdir(game);
      await writeFile(path.join(game, "CMakeLists.txt"), TINY_PROJECT);
      await writeFile(path.join(game, "part.c"), "int part(void) { return 42; }\n");
      await writeFile(path.join(game, "main.c"), "int part(void);\nint main(void) { return part() == 42 ? 0 : 1; }\n");
      await writeFile(path.join(game, "tiny.rc"), 'STRINGTABLE\nBEGIN\n  1 "genex"\nEND\n');
      const env = crossBuildEnv(path.join(root, "zig-cache"));
      const readobj = path.join(tool("llvmMingw"), "bin", "llvm-readobj");
      for (const target of TARGETS) {
        const toolchainFile = path.join(root, `toolchain-${target}.cmake`);
        await writeFile(toolchainFile, crossToolchainFile(target, { lock: { digest: DIGEST }, zig, root }));
        const build = path.join(root, `build-${target}`);
        const generator = ["-G", "Ninja", `-DCMAKE_MAKE_PROGRAM=${tool("ninja")}`];
        const configured = await run(
          tool("cmake"),
          ["-S", game, "-B", build, ...generator, `-DCMAKE_TOOLCHAIN_FILE=${toolchainFile}`],
          env,
        );
        assert.equal(configured.code, 0, configured.out);
        const built = await run(tool("cmake"), ["--build", build, "--verbose"], env);
        assert.equal(built.code, 0, built.out);
        assert.match(built.out, / ar qc /, `${target} archives through zig ar`);
        const names = await readdir(build);
        const exe = target === CrossTarget.WindowsX64 ? "tiny.exe" : "tiny";
        assert.ok(names.includes(exe), `${target} linked ${exe}: ${names.join(", ")}`);
        const header = await run(readobj, ["--file-headers", path.join(build, exe)]);
        assert.equal(header.code, 0, header.out);
        assert.match(header.out, target === CrossTarget.WindowsX64 ? /Format: COFF-x86-64/ : /Format: elf64-x86-64/);
        if (target === CrossTarget.WindowsX64) {
          assert.match(built.out, / rc \/:output-format coff /, "resources compile through zig rc");
          const sections = await run(readobj, ["--section-headers", path.join(build, exe)]);
          assert.match(sections.out, /Name: \.rsrc/, "the resource is linked in");
        }
      }
      assert.equal(existsSync(path.join(game, "CMakeCache.txt")), false, "nothing was written into the game");
    },
  );

  it(
    "the genex module refuses an in-source build and a host-compiler configure under the real CMake",
    needsTools("cmake", "ninja"),
    async () => {
      const root = await tmpDir("cross-targets-refuse-");
      const game = path.join(root, "game");
      await mkdir(game);
      const module = path.join(root, "genex-windows-x64.cmake");
      await writeFile(module, genex(CrossTarget.WindowsX64));
      await writeFile(
        path.join(game, "CMakeLists.txt"),
        'cmake_minimum_required(VERSION 3.28)\nproject(game NONE)\ninclude("${GENEX_CMAKE}")\n',
      );
      const base = ["-G", "Ninja", `-DCMAKE_MAKE_PROGRAM=${tool("ninja")}`, `-DGENEX_CMAKE=${module}`];
      const inSource = await run(tool("cmake"), ["-S", game, "-B", game, ...base]);
      assert.notEqual(inSource.code, 0);
      assert.match(inSource.out, /in-source builds are refused/);
      const hostCompiler = await run(tool("cmake"), ["-S", game, "-B", path.join(root, "build"), ...base]);
      assert.notEqual(hostCompiler.code, 0);
      assert.match(hostCompiler.out, /toolchain-windows-x64\.cmake/);
      assert.equal(existsSync(path.join(game, "build.ninja")), false);
    },
  );
});

describe("cross targets: what the real CMake finds and refuses (required when present)", POSIX_ONLY, () => {
  it(
    "both toolchain files find nothing on the host: a host-only header, library and program come back NOTFOUND",
    needsTools("cmake", "ninja", "zig"),
    async () => {
      const root = await tmpDir("cross-targets-finds-");
      const host = path.join(root, "host");
      const storeRoot = path.join(root, "store-root");
      for (const [file, text] of [
        ["include/genex_host_only.h", "#define GENEX_HOST_ONLY 1\n"],
        ["lib/libgenex_host_only.a", "!<arch>\n"],
        ["bin/genex-host-tool", "#!/bin/sh\n"],
        ["bin/genex-host-tool.exe", "MZ"],
      ] as const) {
        await mkdir(path.dirname(path.join(host, file)), { recursive: true });
        await writeFile(path.join(host, file), text, { mode: 0o755 });
      }
      await mkdir(path.join(storeRoot, "inc"), { recursive: true });
      await writeFile(path.join(storeRoot, "inc", "genex_root.h"), "#define GENEX_ROOT 1\n");
      const project = path.join(root, "finds");
      await mkdir(project);
      await writeFile(path.join(project, "CMakeLists.txt"), findsProject(host));
      const env = crossBuildEnv(path.join(root, "zig-cache"));
      for (const target of TARGETS) {
        const toolchainFile = path.join(root, `toolchain-${target}.cmake`);
        await writeFile(
          toolchainFile,
          crossToolchainFile(target, { lock: { digest: DIGEST }, zig: tool("zig"), root: storeRoot }),
        );
        const build = path.join(root, `build-${target}`);
        const generator = ["-G", "Ninja", `-DCMAKE_MAKE_PROGRAM=${tool("ninja")}`];
        const configured = await run(
          tool("cmake"),
          ["-S", project, "-B", build, ...generator, `-DCMAKE_TOOLCHAIN_FILE=${toolchainFile}`],
          env,
        );
        assert.equal(configured.code, 0, configured.out);
        const found = Object.fromEntries(
          [...configured.out.matchAll(/genex-find (\w+)=(.*)$/gm)].map((match) => [match[1], match[2]]),
        );
        for (const name of ["GENEX_HOST_INCLUDE", "GENEX_HOST_LIBRARY", "GENEX_HOST_PROGRAM"])
          assert.match(found[name] ?? "", /-NOTFOUND$/, `${target}: ${name} = ${found[name]}`);
        const rooted = found.GENEX_ROOT_INCLUDE?.replace(/\/$/, "");
        assert.equal(rooted, path.join(storeRoot, "inc"), `${target} searches the root it is given`);
        const cache = await readFile(path.join(build, "CMakeCache.txt"), "utf8");
        for (const program of ["CMAKE_STRIP", "CMAKE_LINKER", "CMAKE_OBJDUMP", "CMAKE_RC_COMPILER"]) {
          const value = new RegExp(`^${program}:\\w+=(.*)$`, "m").exec(cache)?.[1];
          assert.ok(storeOwned(value, tool("zig")), `${target}: ${program} = ${value} is a host program`);
        }
      }
    },
  );
});

describe("cross targets: the genex module's toolchain check (required when present)", POSIX_ONLY, () => {
  it(
    "the genex module refuses a configure that did not read this lock's toolchain file, even for the right system",
    needsTools("cmake", "ninja"),
    async () => {
      const root = await tmpDir("cross-targets-marker-");
      const base = ["-G", "Ninja", `-DCMAKE_MAKE_PROGRAM=${tool("ninja")}`];
      const configure = (game: string, build: string, ...args: string[]) =>
        run(tool("cmake"), ["-S", game, "-B", path.join(root, build), ...base, ...args]);
      for (const target of TARGETS) {
        const module = path.join(root, `genex-${target}.cmake`);
        await writeFile(module, genex(target));
        const game = path.join(root, `game-${target}`);
        await mkdir(game);
        await writeFile(
          path.join(game, "CMakeLists.txt"),
          'cmake_minimum_required(VERSION 3.28)\nproject(game NONE)\ninclude("${GENEX_CMAKE}")\n',
        );
        const system = `-DCMAKE_SYSTEM_NAME=${CROSS_TARGETS[target].systemName}`;
        const plain = await configure(game, `plain-${target}`, system, `-DGENEX_CMAKE=${module}`);
        assert.notEqual(plain.code, 0, `${target}: a host compiler for the right system is refused`);
        assert.match(plain.out, new RegExp(`toolchain-${target}\\.cmake`));
        const otherLock = path.join(root, `other-${target}.cmake`);
        const other = { lock: { digest: "f".repeat(64) }, zig: ZIG, root };
        await writeFile(otherLock, crossToolchainFile(target, other));
        const stale = await configure(
          game,
          `stale-${target}`,
          `-DCMAKE_TOOLCHAIN_FILE=${otherLock}`,
          `-DGENEX_CMAKE=${module}`,
        );
        assert.notEqual(stale.code, 0, `${target}: another lock's toolchain file is refused`);
        const own = path.join(root, `own-${target}.cmake`);
        await writeFile(own, crossToolchainFile(target, { lock: { digest: DIGEST }, zig: ZIG, root }));
        const ok = await configure(game, `ok-${target}`, `-DCMAKE_TOOLCHAIN_FILE=${own}`, `-DGENEX_CMAKE=${module}`);
        assert.equal(ok.code, 0, ok.out);
      }
    },
  );
});

/** The merged C++ template, as a new game's folder starts. */
const TEMPLATE = fileURLToPath(new URL("../../src/game-template-cpp", import.meta.url));
/** Its sources that read what the module defines: the mixer rate (studio.cpp) and ANGLE's EGL headers (platform.cpp). */
const TEMPLATE_SOURCES = ["studio.cpp", "platform.cpp"] as const;

describe(
  "cross targets: the merged C++ template under the real CMake and zig (required when present)",
  POSIX_ONLY,
  () => {
    it(
      "configures the template and compiles its studio.cpp and platform.cpp for both targets against raylib's headers and the store's ANGLE",
      needsTools("cmake", "ninja", "zig", "raylib", "angleWindows", "angleLinux"),
      async () => {
        const root = await tmpDir("cross-targets-template-");
        const env = crossBuildEnv(path.join(root, "zig-cache"));
        const angle = { [CrossTarget.WindowsX64]: tool("angleWindows"), [CrossTarget.LinuxX64]: tool("angleLinux") };
        const recipe = readRecipe();
        const raylib = { lib: path.join(root, "no-link", "libraylib.a"), include: path.join(tool("raylib"), "src") };
        for (const target of TARGETS) {
          const dir = path.join(root, target);
          await mkdir(dir, { recursive: true });
          const lock = { digest: DIGEST };
          const toolchainFile = path.join(dir, `toolchain-${target}.cmake`);
          await writeFile(toolchainFile, crossToolchainFile(target, { lock, zig: tool("zig"), root: dir }));
          const module = path.join(dir, `genex-${target}.cmake`);
          await writeFile(module, crossGenexCmake(target, { lock, raylib, angle: angle[target], recipe }));
          const build = path.join(dir, "build");
          const generator = ["-G", "Ninja", `-DCMAKE_MAKE_PROGRAM=${tool("ninja")}`];
          const files = [`-DCMAKE_TOOLCHAIN_FILE=${toolchainFile}`, `-DGENEX_CMAKE=${module}`];
          const configured = await run(tool("cmake"), ["-S", TEMPLATE, "-B", build, ...generator, ...files], env);
          assert.equal(configured.code, 0, configured.out);
          const listed = await run(tool("ninja"), ["-C", build, "-t", "targets", "all"], env);
          const objects = TEMPLATE_SOURCES.map((source) => {
            const found = new RegExp(`^(\\S+/src/${source.replace(".", "\\.")}\\.o(?:bj)?):`, "m").exec(
              listed.out,
            )?.[1];
            assert.ok(found, `${target}: ninja builds ${source}: ${listed.out}`);
            return found;
          });
          const compiled = await run(tool("ninja"), ["-C", build, ...objects], env);
          assert.equal(compiled.code, 0, `${target}: ${compiled.out}`);
        }
        assert.equal(existsSync(path.join(TEMPLATE, "CMakeCache.txt")), false, "nothing was written into the template");
      },
    );
  },
);

describe("cross targets: what a cross-built game names (required when present)", POSIX_ONLY, () => {
  it(
    "a cross-built game names no build folder, and the Linux executable has no debug sections or symbol table",
    needsTools("cmake", "ninja", "zig", "llvmMingw", "angleLinux", "angleWindows"),
    async () => {
      const root = await tmpDir("cross-targets-paths-");
      const env = crossBuildEnv(path.join(root, "zig-cache"));
      const readobj = path.join(tool("llvmMingw"), "bin", "llvm-readobj");
      const angle = { [CrossTarget.WindowsX64]: tool("angleWindows"), [CrossTarget.LinuxX64]: tool("angleLinux") };
      const game = path.join(root, "game");
      await mkdir(path.join(game, "src"), { recursive: true });
      await writeFile(path.join(game, "CMakeLists.txt"), PATHS_PROJECT);
      await writeFile(path.join(game, "src", "main.c"), PATHS_MAIN);
      for (const target of TARGETS) {
        const dir = path.join(root, target);
        const raylib = await fakeRaylib(dir, target, env);
        const toolchainFile = path.join(dir, `toolchain-${target}.cmake`);
        const lock = { digest: DIGEST };
        await writeFile(toolchainFile, crossToolchainFile(target, { lock, zig: tool("zig"), root: dir }));
        const module = path.join(dir, `genex-${target}.cmake`);
        const recipe = readRecipe();
        await writeFile(module, crossGenexCmake(target, { lock, raylib, angle: angle[target], recipe }));
        const build = path.join(dir, "build");
        const generator = ["-G", "Ninja", `-DCMAKE_MAKE_PROGRAM=${tool("ninja")}`];
        const files = [`-DCMAKE_TOOLCHAIN_FILE=${toolchainFile}`, `-DGENEX_CMAKE=${module}`];
        const configured = await run(tool("cmake"), ["-S", game, "-B", build, ...generator, ...files], env);
        assert.equal(configured.code, 0, configured.out);
        const built = await run(tool("cmake"), ["--build", build], env);
        assert.equal(built.code, 0, built.out);
        const exe = path.join(build, "out", target === CrossTarget.WindowsX64 ? "game.exe" : "game");
        const bytes = await readFile(exe);
        for (const folder of [root, path.dirname(tool("zig"))])
          assert.equal(bytes.includes(folder), false, `${target} names ${folder}`);
        if (target === CrossTarget.LinuxX64) {
          const sections = await run(readobj, ["--section-headers", exe]);
          assert.equal(sections.code, 0, sections.out);
          assert.doesNotMatch(sections.out, /Name: \.debug_/, "no debug sections");
          assert.doesNotMatch(sections.out, /Name: \.symtab/, "no symbol table");
        }
      }
    },
  );
});

/** A project whose find_* results name what a toolchain file lets CMake see. */
const findsProject = (host: string) =>
  [
    "cmake_minimum_required(VERSION 3.28)",
    "project(finds C)",
    `find_path(GENEX_HOST_INCLUDE genex_host_only.h PATHS "${host}/include" NO_CACHE)`,
    `find_library(GENEX_HOST_LIBRARY NAMES genex_host_only PATHS "${host}/lib" NO_CACHE)`,
    `find_program(GENEX_HOST_PROGRAM NAMES genex-host-tool PATHS "${host}/bin" NO_CACHE)`,
    'find_path(GENEX_ROOT_INCLUDE genex_root.h PATHS "/inc" NO_CACHE)',
    "foreach(name IN ITEMS GENEX_HOST_INCLUDE GENEX_HOST_LIBRARY GENEX_HOST_PROGRAM GENEX_ROOT_INCLUDE)",
    '  message(STATUS "genex-find ${name}=${${name}}")',
    "endforeach()",
    "",
  ].join("\n");

/** A cached program CMake will run is the store's zig, or nothing at all. */
const storeOwned = (value: string | undefined, zig: string) =>
  value === undefined || value.endsWith("-NOTFOUND") || value === zig;

const PATHS_PROJECT =
  'cmake_minimum_required(VERSION 3.28)\nproject(game C CXX)\ninclude("${GENEX_CMAKE}")\ngenex_add_game(SOURCES src/*.c)\n';
const PATHS_MAIN =
  '#include <stdio.h>\nint raylib_part(void);\nint main(void) { printf("%s %d\\n", __FILE__, raylib_part()); return 0; }\n';

/** A one-function stand-in for the raylib prebuild, archived with zig for `target`. */
async function fakeRaylib(dir: string, target: CrossTarget, env: Record<string, string>) {
  await mkdir(path.join(dir, "raylib", "include"), { recursive: true });
  const part = path.join(dir, "part.c");
  await writeFile(part, "int raylib_part(void) { return 42; }\n");
  const object = path.join(dir, "part.o");
  const compiled = await run(
    tool("zig"),
    ["cc", "-target", CROSS_TARGETS[target].triple, "-c", part, "-o", object],
    env,
  );
  assert.equal(compiled.code, 0, compiled.out);
  const lib = path.join(dir, "raylib", "libraylib.a");
  const archived = await run(tool("zig"), ["ar", "qc", lib, object], env);
  assert.equal(archived.code, 0, archived.out);
  return { lib, include: path.join(dir, "raylib", "include") };
}

const GOLDEN_TOOLCHAIN_WINDOWS = `# toolchain-windows-x64.cmake: generated by Genex for toolchain lock 0123456789ab. Do not edit.
# zig cross-compiles for x86_64-windows-gnu as CMake's C and C++ compiler (pass it as CMAKE_TOOLCHAIN_FILE).
if(CMAKE_C_COMPILER_LOADED OR CMAKE_CXX_COMPILER_LOADED)
  # Read again as CMAKE_USER_MAKE_RULES_OVERRIDE, after CMake's platform rules: CMAKE_AR names one
  # program and zig takes its archiver as a subcommand, so archives go through zig ar and zig ranlib.
  foreach(genex_lang IN ITEMS C CXX)
    set(CMAKE_\${genex_lang}_ARCHIVE_CREATE "<CMAKE_AR> ar qc <TARGET> <LINK_FLAGS> <OBJECTS>")
    set(CMAKE_\${genex_lang}_ARCHIVE_APPEND "<CMAKE_AR> ar q <TARGET> <LINK_FLAGS> <OBJECTS>")
    set(CMAKE_\${genex_lang}_ARCHIVE_FINISH "<CMAKE_RANLIB> ranlib <TARGET>")
  endforeach()
  set(CMAKE_RC_COMPILE_OBJECT "<CMAKE_RC_COMPILER> rc /:output-format coff /:target x86_64 /:auto-includes gnu <DEFINES> <INCLUDES> <FLAGS> /fo <OBJECT> -- <SOURCE>")
  return()
endif()
set(CMAKE_SYSTEM_NAME Windows)
set(CMAKE_SYSTEM_PROCESSOR x86_64)
set(CMAKE_C_COMPILER [=[/store/zig-0.16.0/zig]=] cc -target x86_64-windows-gnu)
set(CMAKE_CXX_COMPILER [=[/store/zig-0.16.0/zig]=] c++ -target x86_64-windows-gnu)
set(CMAKE_AR [=[/store/zig-0.16.0/zig]=])
set(CMAKE_RANLIB [=[/store/zig-0.16.0/zig]=])
set(CMAKE_RC_COMPILER [=[/store/zig-0.16.0/zig]=])
set(CMAKE_USER_MAKE_RULES_OVERRIDE "\${CMAKE_CURRENT_LIST_FILE}")
# genex-<target>.cmake refuses a configure that did not read this file.
set(GENEX_CROSS_TARGET "windows-x64")
set(GENEX_CROSS_LOCK "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
# find_* search only these folders, never the host: no host header, library, strip, linker or windres.
set(CMAKE_FIND_ROOT_PATH [=[/store/locks/0123456789ab]=])
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)
`;

const GOLDEN_TOOLCHAIN_LINUX = `# toolchain-linux-x64.cmake: generated by Genex for toolchain lock 0123456789ab. Do not edit.
# zig cross-compiles for x86_64-linux-gnu.2.28 as CMake's C and C++ compiler (pass it as CMAKE_TOOLCHAIN_FILE).
if(CMAKE_C_COMPILER_LOADED OR CMAKE_CXX_COMPILER_LOADED)
  # Read again as CMAKE_USER_MAKE_RULES_OVERRIDE, after CMake's platform rules: CMAKE_AR names one
  # program and zig takes its archiver as a subcommand, so archives go through zig ar and zig ranlib.
  foreach(genex_lang IN ITEMS C CXX)
    set(CMAKE_\${genex_lang}_ARCHIVE_CREATE "<CMAKE_AR> ar qc <TARGET> <LINK_FLAGS> <OBJECTS>")
    set(CMAKE_\${genex_lang}_ARCHIVE_APPEND "<CMAKE_AR> ar q <TARGET> <LINK_FLAGS> <OBJECTS>")
    set(CMAKE_\${genex_lang}_ARCHIVE_FINISH "<CMAKE_RANLIB> ranlib <TARGET>")
  endforeach()
  return()
endif()
set(CMAKE_SYSTEM_NAME Linux)
set(CMAKE_SYSTEM_PROCESSOR x86_64)
set(CMAKE_C_COMPILER [=[/store/zig-0.16.0/zig]=] cc -target x86_64-linux-gnu.2.28)
set(CMAKE_CXX_COMPILER [=[/store/zig-0.16.0/zig]=] c++ -target x86_64-linux-gnu.2.28)
set(CMAKE_AR [=[/store/zig-0.16.0/zig]=])
set(CMAKE_RANLIB [=[/store/zig-0.16.0/zig]=])
set(CMAKE_USER_MAKE_RULES_OVERRIDE "\${CMAKE_CURRENT_LIST_FILE}")
# genex-<target>.cmake refuses a configure that did not read this file.
set(GENEX_CROSS_TARGET "linux-x64")
set(GENEX_CROSS_LOCK "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
# find_* search only these folders, never the host: no host header, library, strip, linker or windres.
set(CMAKE_FIND_ROOT_PATH [=[/store/locks/0123456789ab]=] [=[/store/sysroot-linux-x64-x11]=])
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)
`;

const GOLDEN_RAYLIB_INCLUDE_WINDOWS = `# raylib-windows-x64.cmake: generated by Genex for toolchain lock 0123456789ab. Do not edit.
# raylib's own CMake reads it as CMAKE_PROJECT_raylib_INCLUDE: GLFW loads ANGLE's EGL by these names.
add_compile_definitions(_GLFW_EGL_LIBRARY="libEGL.dll" _GLFW_GLESV2_LIBRARY="libGLESv2.dll")
add_compile_options("-ffile-prefix-map=/store/zig-0.16.0=zig" "-ffile-prefix-map=/store/angle-windows-x64-d3d11/c5bf49e78850=angle")
add_compile_options("-ffile-prefix-map=\${CMAKE_SOURCE_DIR}=raylib" "-ffile-prefix-map=\${CMAKE_BINARY_DIR}=raylib-build")
add_compile_options("-gno-codeview-command-line" "-fdebug-compilation-dir=.")
include_directories(SYSTEM [=[/store/angle-windows-x64-d3d11/c5bf49e78850/include]=])
`;

const GOLDEN_RAYLIB_INCLUDE_LINUX = `# raylib-linux-x64.cmake: generated by Genex for toolchain lock 0123456789ab. Do not edit.
# raylib's own CMake reads it as CMAKE_PROJECT_raylib_INCLUDE: GLFW loads ANGLE's EGL by these names.
add_compile_definitions(_GLFW_EGL_LIBRARY="libEGL.so" _GLFW_GLESV2_LIBRARY="libGLESv2.so")
add_compile_options("-ffile-prefix-map=/store/zig-0.16.0=zig" "-ffile-prefix-map=/store/angle-linux-x64-vulkan/c5bf49e78850=angle" "-ffile-prefix-map=/store/sysroot-linux-x64-x11=sysroot")
add_compile_options("-ffile-prefix-map=\${CMAKE_SOURCE_DIR}=raylib" "-ffile-prefix-map=\${CMAKE_BINARY_DIR}=raylib-build")
include_directories(SYSTEM [=[/store/angle-linux-x64-vulkan/c5bf49e78850/include]=])
include_directories(SYSTEM [=[/store/sysroot-linux-x64-x11/usr/include]=])
`;

const GOLDEN_GENEX_WINDOWS = `# genex-windows.cmake: generated by Genex for toolchain lock 0123456789ab. Do not edit.
# A game's CMakeLists.txt includes it after project() and calls genex_add_game(SOURCES <globs>...);
# the configure names this lock's toolchain-windows-x64.cmake as CMAKE_TOOLCHAIN_FILE.
include_guard(GLOBAL)

if(CMAKE_BINARY_DIR STREQUAL CMAKE_SOURCE_DIR)
  message(FATAL_ERROR "genex: in-source builds are refused; configure with -B <a folder outside the game>.")
endif()
if(NOT "\${GENEX_CROSS_TARGET}" STREQUAL "windows-x64" OR NOT "\${GENEX_CROSS_LOCK}" STREQUAL "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
  message(FATAL_ERROR "genex: a windows-x64 game is configured with this lock's toolchain-windows-x64.cmake as CMAKE_TOOLCHAIN_FILE.")
endif()

set(FETCHCONTENT_FULLY_DISCONNECTED ON CACHE BOOL "Genex builds offline" FORCE)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release CACHE STRING "Genex's default build type" FORCE)
endif()
set(GENEX_TARGET "windows-x64")
set(GENEX_LOCK "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
enable_language(RC)

add_library(genex_raylib STATIC IMPORTED GLOBAL)
set_target_properties(genex_raylib PROPERTIES
  IMPORTED_LOCATION [=[/store/locks/0123456789ab/raylib-windows-x64-es3-angle/lib/libraylib.a]=]
  INTERFACE_INCLUDE_DIRECTORIES [=[/store/locks/0123456789ab/raylib-windows-x64-es3-angle/include]=]
)

function(genex_add_game)
  cmake_parse_arguments(PARSE_ARGV 0 GENEX "" "" "SOURCES")
  if(NOT GENEX_SOURCES)
    message(FATAL_ERROR "genex_add_game: name the game's sources, as SOURCES src/*.cpp.")
  endif()
  set(genex_sources "")
  foreach(genex_glob IN LISTS GENEX_SOURCES)
    file(GLOB genex_found CONFIGURE_DEPENDS "\${CMAKE_CURRENT_SOURCE_DIR}/\${genex_glob}")
    list(APPEND genex_sources \${genex_found})
  endforeach()
  if(NOT genex_sources)
    message(FATAL_ERROR "genex_add_game: SOURCES \${GENEX_SOURCES} matched no file.")
  endif()
  add_executable(game \${genex_sources})
  target_compile_options(game PRIVATE
    "-ffp-contract=off"
    "$<$<COMPILE_LANGUAGE:CXX>:-std=c++20>"
    "-gno-codeview-command-line"
    "-fdebug-compilation-dir=."
    "-ffile-prefix-map=\${CMAKE_SOURCE_DIR}=game"
    "-ffile-prefix-map=\${CMAKE_BINARY_DIR}=build"
  )
  target_compile_definitions(game PRIVATE
    PLATFORM_DESKTOP_GLFW
    GRAPHICS_API_OPENGL_ES3
    GENEX_AUDIO_RATE_HZ=48000
  )
  target_include_directories(game SYSTEM PRIVATE [=[/store/angle-windows-x64-d3d11/c5bf49e78850/include]=])
  target_link_libraries(game PRIVATE genex_raylib [=[/store/angle-windows-x64-d3d11/c5bf49e78850/libGLESv2.dll.lib]=] [=[/store/angle-windows-x64-d3d11/c5bf49e78850/libEGL.dll.lib]=] winmm gdi32 user32 shell32)
  target_link_options(game PRIVATE
    "-static"
    "-Wl,--subsystem,windows"
    "-Wl,-Brepro"
    "-s"
  )
  set_target_properties(game PROPERTIES
    OUTPUT_NAME game
    RUNTIME_OUTPUT_DIRECTORY "\${CMAKE_BINARY_DIR}/out"
  )
  # The executable's manifest: the UTF-8 code page (getenv and fopen see a profile path whole) on Windows 10 and later.
  set(genex_manifest "\${CMAKE_BINARY_DIR}/genex/game.manifest")
  file(CONFIGURE OUTPUT "\${genex_manifest}" CONTENT [=[<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1">
    <application>
      <supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}"/>
    </application>
  </compatibility>
  <application xmlns="urn:schemas-microsoft-com:asm.v3">
    <windowsSettings>
      <activeCodePage xmlns="http://schemas.microsoft.com/SMI/2019/WindowsSettings">UTF-8</activeCodePage>
    </windowsSettings>
  </application>
</assembly>
]=] @ONLY)
  file(CONFIGURE OUTPUT "\${CMAKE_BINARY_DIR}/genex/game.rc" CONTENT [=[1 24 "@genex_manifest@"
]=] @ONLY)
  target_sources(game PRIVATE "\${CMAKE_BINARY_DIR}/genex/game.rc")
  # assets: the staged copy, renewed whole in out/assets
  if(DEFINED GENEX_ASSETS)
    set(genex_asset_dir "\${GENEX_ASSETS}")
  else()
    set(genex_asset_dir "\${CMAKE_CURRENT_SOURCE_DIR}/assets")
  endif()
  file(GLOB_RECURSE genex_assets CONFIGURE_DEPENDS "\${genex_asset_dir}/*")
  set(genex_assets_out "\${CMAKE_BINARY_DIR}/out/assets")
  set(genex_assets_done "\${CMAKE_BINARY_DIR}/genex-assets.done")
  set(genex_assets_list "\${CMAKE_BINARY_DIR}/genex-assets.list")
  set(genex_assets_known "")
  if(EXISTS "\${genex_assets_list}")
    file(READ "\${genex_assets_list}" genex_assets_known)
  endif()
  if(NOT EXISTS "\${genex_assets_list}" OR NOT genex_assets_known STREQUAL "\${genex_assets}")
    file(WRITE "\${genex_assets_list}" "\${genex_assets}")
  endif()
  set(genex_assets_depends \${genex_assets} "\${genex_assets_list}")
  if(DEFINED GENEX_ASSETS_STAMP)
    list(APPEND genex_assets_depends "\${GENEX_ASSETS_STAMP}")
  endif()
  set(genex_assets_copy COMMAND "\${CMAKE_COMMAND}" -E make_directory "\${genex_assets_out}")
  if(IS_DIRECTORY "\${genex_asset_dir}")
    list(APPEND genex_assets_copy COMMAND "\${CMAKE_COMMAND}" -E copy_directory "\${genex_asset_dir}" "\${genex_assets_out}")
  endif()
  add_custom_command(OUTPUT "\${genex_assets_done}"
    COMMAND "\${CMAKE_COMMAND}" -E rm -rf "\${genex_assets_out}"
    \${genex_assets_copy}
    COMMAND "\${CMAKE_COMMAND}" -E touch "\${genex_assets_done}"
    DEPENDS \${genex_assets_depends}
    VERBATIM)
  add_custom_target(genex_copy_assets ALL DEPENDS "\${genex_assets_done}")
endfunction()
`;

const GOLDEN_GENEX_LINUX = `# genex-linux.cmake: generated by Genex for toolchain lock 0123456789ab. Do not edit.
# A game's CMakeLists.txt includes it after project() and calls genex_add_game(SOURCES <globs>...);
# the configure names this lock's toolchain-linux-x64.cmake as CMAKE_TOOLCHAIN_FILE.
include_guard(GLOBAL)

if(CMAKE_BINARY_DIR STREQUAL CMAKE_SOURCE_DIR)
  message(FATAL_ERROR "genex: in-source builds are refused; configure with -B <a folder outside the game>.")
endif()
if(NOT "\${GENEX_CROSS_TARGET}" STREQUAL "linux-x64" OR NOT "\${GENEX_CROSS_LOCK}" STREQUAL "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
  message(FATAL_ERROR "genex: a linux-x64 game is configured with this lock's toolchain-linux-x64.cmake as CMAKE_TOOLCHAIN_FILE.")
endif()

set(FETCHCONTENT_FULLY_DISCONNECTED ON CACHE BOOL "Genex builds offline" FORCE)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release CACHE STRING "Genex's default build type" FORCE)
endif()
set(GENEX_TARGET "linux-x64")
set(GENEX_LOCK "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")

add_library(genex_raylib STATIC IMPORTED GLOBAL)
set_target_properties(genex_raylib PROPERTIES
  IMPORTED_LOCATION [=[/store/locks/0123456789ab/raylib-linux-x64-es3-angle/lib/libraylib.a]=]
  INTERFACE_INCLUDE_DIRECTORIES [=[/store/locks/0123456789ab/raylib-linux-x64-es3-angle/include]=]
)

function(genex_add_game)
  cmake_parse_arguments(PARSE_ARGV 0 GENEX "" "" "SOURCES")
  if(NOT GENEX_SOURCES)
    message(FATAL_ERROR "genex_add_game: name the game's sources, as SOURCES src/*.cpp.")
  endif()
  set(genex_sources "")
  foreach(genex_glob IN LISTS GENEX_SOURCES)
    file(GLOB genex_found CONFIGURE_DEPENDS "\${CMAKE_CURRENT_SOURCE_DIR}/\${genex_glob}")
    list(APPEND genex_sources \${genex_found})
  endforeach()
  if(NOT genex_sources)
    message(FATAL_ERROR "genex_add_game: SOURCES \${GENEX_SOURCES} matched no file.")
  endif()
  add_executable(game \${genex_sources})
  target_compile_options(game PRIVATE
    "-ffp-contract=off"
    "$<$<COMPILE_LANGUAGE:CXX>:-std=c++20>"
    "-ffile-prefix-map=\${CMAKE_SOURCE_DIR}=game"
    "-ffile-prefix-map=\${CMAKE_BINARY_DIR}=build"
  )
  target_compile_definitions(game PRIVATE
    PLATFORM_DESKTOP_GLFW
    GRAPHICS_API_OPENGL_ES3
    GENEX_AUDIO_RATE_HZ=48000
  )
  target_include_directories(game SYSTEM PRIVATE [=[/store/angle-linux-x64-vulkan/c5bf49e78850/include]=])
  target_link_directories(game PRIVATE [=[/store/angle-linux-x64-vulkan/c5bf49e78850]=])
  target_link_libraries(game PRIVATE genex_raylib GLESv2 EGL m pthread dl)
  target_link_options(game PRIVATE
    "-s"
    "LINKER:-rpath,$ORIGIN"
    "LINKER:--enable-new-dtags"
  )
  set_target_properties(game PROPERTIES
    OUTPUT_NAME game
    SKIP_BUILD_RPATH TRUE
    RUNTIME_OUTPUT_DIRECTORY "\${CMAKE_BINARY_DIR}/out"
  )
  # assets: the staged copy, renewed whole in out/assets
  if(DEFINED GENEX_ASSETS)
    set(genex_asset_dir "\${GENEX_ASSETS}")
  else()
    set(genex_asset_dir "\${CMAKE_CURRENT_SOURCE_DIR}/assets")
  endif()
  file(GLOB_RECURSE genex_assets CONFIGURE_DEPENDS "\${genex_asset_dir}/*")
  set(genex_assets_out "\${CMAKE_BINARY_DIR}/out/assets")
  set(genex_assets_done "\${CMAKE_BINARY_DIR}/genex-assets.done")
  set(genex_assets_list "\${CMAKE_BINARY_DIR}/genex-assets.list")
  set(genex_assets_known "")
  if(EXISTS "\${genex_assets_list}")
    file(READ "\${genex_assets_list}" genex_assets_known)
  endif()
  if(NOT EXISTS "\${genex_assets_list}" OR NOT genex_assets_known STREQUAL "\${genex_assets}")
    file(WRITE "\${genex_assets_list}" "\${genex_assets}")
  endif()
  set(genex_assets_depends \${genex_assets} "\${genex_assets_list}")
  if(DEFINED GENEX_ASSETS_STAMP)
    list(APPEND genex_assets_depends "\${GENEX_ASSETS_STAMP}")
  endif()
  set(genex_assets_copy COMMAND "\${CMAKE_COMMAND}" -E make_directory "\${genex_assets_out}")
  if(IS_DIRECTORY "\${genex_asset_dir}")
    list(APPEND genex_assets_copy COMMAND "\${CMAKE_COMMAND}" -E copy_directory "\${genex_asset_dir}" "\${genex_assets_out}")
  endif()
  add_custom_command(OUTPUT "\${genex_assets_done}"
    COMMAND "\${CMAKE_COMMAND}" -E rm -rf "\${genex_assets_out}"
    \${genex_assets_copy}
    COMMAND "\${CMAKE_COMMAND}" -E touch "\${genex_assets_done}"
    DEPENDS \${genex_assets_depends}
    VERBATIM)
  add_custom_target(genex_copy_assets ALL DEPENDS "\${genex_assets_done}")
endfunction()
`;
