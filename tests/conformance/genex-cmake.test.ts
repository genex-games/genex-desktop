// biome-ignore-all lint/suspicious/noTemplateCurlyInString: CMake's own ${VAR} references are the text this file writes and reads.
/**
 * `genex-<target>.cmake`, the CMake module a C++ · raylib game includes (`genex-cmake.ts` from
 * `recipe.json`): the recipe's flags and none of the refused ones, raylib's definitions and link
 * options restated (an imported prebuild carries neither), no Emscripten port, no OpenGL on a Mac,
 * globs that re-run on a new file, one output folder, in-source builds refused, and paths that
 * CMake reads back exactly. The real rows configure with the developer's CMake and, when the dev
 * store exists, build a tiny raylib game against it under the real sandbox.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BuildTarget } from "../../src/shared/game-project.ts";
import { ToolchainError, type ToolchainLock, ToolchainProblem } from "../../src/shared/toolchain.ts";
import { ProcessSandbox, shellQuote } from "../../src/substrate/spawn.ts";
import { CrossTarget, crossGenexCmake } from "../../src/substrate/toolchain-store/cross-targets.ts";
import {
  compileOptionLines,
  deviceRateDefinition,
  GENEX_BLOCKS,
  gameRateDefinition,
  genexCmake,
  HEADLESS_PLATFORM_FILE,
  headlessPlatformPath,
  headlessPlatformSha256,
  type Recipe,
  readRecipe,
} from "../../src/substrate/toolchain-store/genex-cmake.ts";
import { execXcode, locateToolchain, macSdkPath } from "../../src/substrate/toolchain-store/locate.ts";
import { devStoreLock, devTool, needsTools } from "../helpers/dev-toolchains.ts";
import { tmpDir } from "../helpers/tmp.ts";

const execFileAsync = promisify(execFile);
const POSIX_ONLY = process.platform === "win32" ? { skip: "the dev store is built on macOS and Linux" } : {};

const LOCK: ToolchainLock = {
  version: 1,
  entries: {
    cmake: { version: "4.4.3", sha12: "0c5d65251c14" },
    ninja: { version: "1.13.2", sha12: "c99048673aa7" },
    emsdk: { version: "6.0.10", sha12: "4b1a2f3e9d10" },
    raylib: { version: "6.0", sha12: "dbc56a87da87" },
  },
  digest: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
};
const PREBUILD = {
  lib: "/store/locks/0123456789ab/raylib-web-es3/lib/libraylib.a",
  include: "/store/locks/0123456789ab/raylib-web-es3/include",
};
const TARGETS = [BuildTarget.Web, BuildTarget.Mac] as const;
/** What a Mac module also names: the headless prebuild and the lock's ANGLE folder. */
const MAC_EXTRAS = {
  headless: {
    lib: "/store/locks/0123456789ab/raylib-macos-es3-angle-headless/lib/libraylib.a",
    include: "/store/locks/0123456789ab/raylib-macos-es3-angle-headless/include",
  },
  angle: "/store/angle-macos/c5bf49e78850-d1a8c476a1c4",
};

const text = (target: BuildTarget, recipe: Recipe = readRecipe(), raylib = PREBUILD) =>
  genexCmake(target, { lock: LOCK, raylib, recipe, ...(target === BuildTarget.Mac ? MAC_EXTRAS : {}) });

const REPO = fileURLToPath(new URL("../..", import.meta.url));
/** Where the repository keeps the headless platform, and where a built app's resources keep its copy. */
const PLATFORM_REL = ["native", "raylib-platform", HEADLESS_PLATFORM_FILE] as const;

describe("the headless platform file a prewarm reads", () => {
  it("is the checkout's from source; a packaged app's resources copy is preferred when given, with the same digest", async () => {
    const checkout = path.join(REPO, ...PLATFORM_REL);
    assert.equal(headlessPlatformPath(), checkout);
    const resources = await tmpDir("packaged-resources-");
    const shipped = path.join(resources, ...PLATFORM_REL);
    await mkdir(path.dirname(shipped), { recursive: true });
    await copyFile(checkout, shipped);
    assert.equal(headlessPlatformPath(resources), shipped);
    const digest = await headlessPlatformSha256(checkout);
    assert.match(digest ?? "", /^[0-9a-f]{64}$/);
    // Same bytes, same digest: a release build's prewarm is keyed like the developer's, never re-keyed.
    assert.equal(await headlessPlatformSha256(headlessPlatformPath(resources)), digest);
  });

  it(
    "reads a resources copy that is a link, a folder or missing as no platform, and writes nothing",
    POSIX_ONLY,
    async () => {
      const checkout = path.join(REPO, ...PLATFORM_REL);
      const cases: Array<[string, (file: string) => Promise<void>]> = [
        ["a link to the checkout's file", (file) => symlink(checkout, file)],
        ["a folder", (file) => mkdir(file)],
        ["missing", async () => {}],
      ];
      for (const [name, plant] of cases) {
        const resources = await tmpDir("packaged-resources-");
        const folder = path.join(resources, ...PLATFORM_REL.slice(0, -1));
        await mkdir(folder, { recursive: true });
        await plant(path.join(folder, HEADLESS_PLATFORM_FILE));
        const before = await readdir(folder);
        assert.equal(await headlessPlatformSha256(headlessPlatformPath(resources)), null, name);
        assert.deepEqual(await readdir(folder), before, `${name}: nothing written`);
      }
    },
  );
});

describe("genex.cmake: the recipe's flags", () => {
  it("every recipe flag is present for each target and every refused flag absent", () => {
    const recipe = readRecipe();
    for (const target of TARGETS) {
      const out = text(target, recipe);
      const wanted = recipe.targets[target];
      assert.ok(wanted, `the recipe has ${target}`);
      const headless = wanted.headless ?? { definitions: [], frameworks: [] };
      const flags = [...recipe.flags.compile, ...recipe.flags.cxx, ...wanted.definitions, ...headless.definitions];
      for (const flag of [...flags, ...wanted.link]) assert.ok(out.includes(flag), `${target} carries ${flag}`);
      for (const framework of [...wanted.frameworks, ...headless.frameworks])
        assert.ok(out.includes(`-framework ${framework}`), `${target} links ${framework}`);
      for (const refused of recipe.flags.refused)
        assert.ok(!out.includes(refused), `${target} never carries ${refused}`);
    }
    assert.deepEqual(recipe.flags.compile, ["-ffp-contract=off"]);
    assert.deepEqual(recipe.flags.cxx, ["-std=c++20"]);
    assert.deepEqual(recipe.flags.refused, ["-ffast-math", "-Ofast", "-funsafe-math-optimizations"]);
  });

  it("a recipe that asks for a refused flag is refused", () => {
    const recipe = readRecipe();
    const tampered: Recipe = { ...recipe, flags: { ...recipe.flags, compile: [...recipe.flags.compile, "-Ofast"] } };
    assert.throws(
      () => text(BuildTarget.Web, tampered),
      (error: unknown) => error instanceof ToolchainError && error.problem === ToolchainProblem.Prewarm,
    );
  });

  it("the web module restates WebGL2 and -sUSE_GLFW=3 and never names a port", () => {
    const out = text(BuildTarget.Web);
    for (const option of [
      "-sUSE_GLFW=3",
      "-sMIN_WEBGL_VERSION=2",
      "-sMAX_WEBGL_VERSION=2",
      "-sENVIRONMENT=web",
      "-sEXPORTED_RUNTIME_METHODS=ccall,requestFullscreen",
      "-sALLOW_MEMORY_GROWTH=1",
      "-lidbfs.js",
    ])
      assert.ok(out.includes(option), option);
    for (const definition of ["PLATFORM_WEB", "GRAPHICS_API_OPENGL_ES3"]) assert.ok(out.includes(definition));
    assert.doesNotMatch(out, /--use-port|embuilder|-sUSE_(?!GLFW=3)/);
  });

  it("the Mac module never names OpenGL and makes no bundle: the host assembles every .app", () => {
    const out = text(BuildTarget.Mac);
    assert.doesNotMatch(out, /OpenGL/);
    assert.doesNotMatch(out, /MACOSX_BUNDLE/);
    for (const definition of ["PLATFORM_DESKTOP_GLFW", "GRAPHICS_API_OPENGL_ES3"]) assert.ok(out.includes(definition));
  });

  it("globs carry CONFIGURE_DEPENDS and the output goes to <binary dir>/out", () => {
    for (const target of TARGETS) {
      const out = text(target);
      assert.match(out, /file\(GLOB genex_found CONFIGURE_DEPENDS /);
      assert.ok(out.includes('RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/out"'));
      assert.ok(out.includes("FETCHCONTENT_FULLY_DISCONNECTED ON"));
    }
  });

  it("refuses a path CMake cannot hold as one argument", () => {
    for (const bad of ["/store/a;b/libraylib.a", "/store/a\nb/libraylib.a", "relative/libraylib.a"])
      assert.throws(
        () => text(BuildTarget.Web, readRecipe(), { ...PREBUILD, lib: bad }),
        (error: unknown) => error instanceof ToolchainError && error.problem === ToolchainProblem.Prewarm,
        JSON.stringify(bad),
      );
  });

  it("is byte-stable for a fixed lock (golden)", () => {
    assert.equal(text(BuildTarget.Web), GOLDEN_WEB);
    assert.equal(text(BuildTarget.Web), text(BuildTarget.Web));
  });
});

/** Every block the native genex modules share, in one text: what the shared golden pins. */
function sharedBlocks(recipe: Recipe = readRecipe()): string {
  const { guard, defaults, sources, assets } = GENEX_BLOCKS;
  const rates = [gameRateDefinition(recipe), deviceRateDefinition(recipe)];
  return [guard, defaults, sources, assets, compileOptionLines(recipe), rates]
    .map((lines) => lines.join("\n"))
    .join("\n---\n");
}

/** The two cross modules over the same lock, written by `cross-targets.ts`. */
const crossTexts = (recipe: Recipe = readRecipe()) =>
  [CrossTarget.WindowsX64, CrossTarget.LinuxX64].map((target) =>
    crossGenexCmake(target, {
      lock: { digest: LOCK.digest },
      raylib: { lib: `/store/locks/0123456789ab/raylib-${target}/lib/libraylib.a`, include: "/store/include" },
      angle: `/store/angle-${target}`,
      recipe,
    }),
  );

describe("genex modules: the blocks every native module shares", () => {
  it("are one implementation, pinned by one golden", () => {
    assert.equal(sharedBlocks(), GOLDEN_SHARED_BLOCKS);
  });

  it("the Mac module and both cross modules write every shared block verbatim; the web module its guard, defaults and sources", () => {
    const recipe = readRecipe();
    const { guard, defaults, sources, assets } = GENEX_BLOCKS;
    const native = {
      mac: text(BuildTarget.Mac, recipe),
      ...Object.fromEntries(crossTexts(recipe).map((out, at) => [`cross-${at}`, out])),
    };
    for (const [name, out] of Object.entries(native)) {
      for (const block of [guard, defaults, sources, assets, compileOptionLines(recipe)])
        assert.ok(out.includes(block.join("\n")), `${name} writes ${block[0]}`);
      assert.ok(out.includes(`    ${gameRateDefinition(recipe)}\n`), `${name} tells the game the mixer rate`);
    }
    const web = text(BuildTarget.Web, recipe);
    for (const block of [guard, defaults, sources]) assert.ok(web.includes(block.join("\n")), `web writes ${block[0]}`);
    assert.ok(!web.includes(gameRateDefinition(recipe)), "the browser keeps its own rate");
  });

  it("follows the recipe in every module at once: one rate for the game and for raylib's device", () => {
    const slower: Recipe = { ...readRecipe(), nativeAudioRateHz: 44_100 };
    assert.equal(gameRateDefinition(slower), "GENEX_AUDIO_RATE_HZ=44100");
    assert.equal(deviceRateDefinition(slower), "AUDIO_DEVICE_SAMPLE_RATE=44100");
    for (const out of [text(BuildTarget.Mac, slower), ...crossTexts(slower)])
      assert.ok(out.includes("    GENEX_AUDIO_RATE_HZ=44100\n"));
  });
});

describe("raylib's own configuration", () => {
  it(
    "states every SUPPORT_* flag raylib's config.h names, at config.h's value except JPEG on and screen capture off",
    needsTools("raylib"),
    async () => {
      const raylib = devTool("raylib");
      assert.ok("path" in raylib);
      const header = await readFile(path.join(raylib.path, "src", "config.h"), "utf8");
      const defaults = new Map(
        [...header.matchAll(/^\s*#define\s+(SUPPORT_\w+)\s+([01])\b/gm)].map((match) => [match[1], match[2] === "1"]),
      );
      assert.ok(defaults.size > 50, `config.h names ${defaults.size} flags`);
      const recipe = readRecipe();
      assert.deepEqual(Object.keys(recipe.raylibConfig).sort(), [...defaults.keys()].sort());
      const changed = Object.entries(recipe.raylibConfig).filter(([flag, on]) => defaults.get(flag) !== on);
      assert.deepEqual(changed.sort(), [
        ["SUPPORT_FILEFORMAT_JPG", true],
        ["SUPPORT_SCREEN_CAPTURE", false],
      ]);
    },
  );
});

async function configure(game: string, build: string, genex: string): Promise<{ code: number; stderr: string }> {
  const cmake = devTool("cmake");
  const ninja = devTool("ninja");
  assert.ok("path" in cmake && "path" in ninja);
  const args = ["-S", game, "-B", build, "-G", "Ninja", `-DCMAKE_MAKE_PROGRAM=${ninja.path}`, `-DGENEX_CMAKE=${genex}`];
  try {
    await execFileAsync(cmake.path, args);
    return { code: 0, stderr: "" };
  } catch (error) {
    const failed = error as { code?: number; stderr?: string };
    return { code: failed.code ?? -1, stderr: failed.stderr ?? "" };
  }
}

describe("genex.cmake under the real CMake (required when present)", () => {
  it(
    "an in-source build fails fast; the same project out of source configures",
    needsTools("cmake", "ninja"),
    async () => {
      const root = await tmpDir("genex-cmake-insource-");
      const game = path.join(root, "game");
      await mkdir(game, { recursive: true });
      const genex = path.join(root, "genex-web.cmake");
      await writeFile(genex, text(BuildTarget.Web));
      await writeFile(
        path.join(game, "CMakeLists.txt"),
        'cmake_minimum_required(VERSION 3.28)\nproject(game NONE)\ninclude("${GENEX_CMAKE}")\n',
      );
      const inSource = await configure(game, game, genex);
      assert.notEqual(inSource.code, 0);
      assert.match(inSource.stderr, /in-source/);
      assert.equal(existsSync(path.join(game, "build.ninja")), false);
      assert.equal(existsSync(path.join(game, "Makefile")), false, "nothing was generated in the game folder");
      const outOfSource = await configure(game, path.join(root, "build"), genex);
      assert.equal(outOfSource.code, 0, outOfSource.stderr);
    },
  );

  const PATHS = [
    "/store with space/lib/libraylib.a",
    "/store/$HOME/lib/libraylib.a",
    "/store/${HOME}/lib/libraylib.a",
    '/store/"quoted"/lib/libraylib.a',
    "/store/back\\slash/lib/libraylib.a",
    "/store/]=]/lib/libraylib.a",
    "/store/#hash/@at/lib/libraylib.a",
  ];
  for (const lib of PATHS) {
    it(`reads ${JSON.stringify(lib)} back exactly`, needsTools("cmake", "ninja"), async () => {
      const root = await tmpDir("genex-cmake-paths-");
      const game = path.join(root, "game");
      await mkdir(game, { recursive: true });
      const genex = path.join(root, "genex-web.cmake");
      await writeFile(genex, text(BuildTarget.Web, readRecipe(), { lib, include: "/store/include" }));
      await writeFile(
        path.join(game, "CMakeLists.txt"),
        [
          "cmake_minimum_required(VERSION 3.28)",
          "project(game NONE)",
          'include("${GENEX_CMAKE}")',
          "get_target_property(where genex_raylib IMPORTED_LOCATION)",
          'file(WRITE "${CMAKE_BINARY_DIR}/where.txt" "${where}")',
          "",
        ].join("\n"),
      );
      const outcome = await configure(game, path.join(root, "build"), genex);
      assert.equal(outcome.code, 0, outcome.stderr);
      assert.equal(await readFile(path.join(root, "build", "where.txt"), "utf8"), lib);
    });
  }
});

/** The link command `build.ninja` holds for one executable: its flags and libraries, joined. */
function linkOf(ninja: string, output: string): string {
  const at = ninja.indexOf(`build ${output}:`);
  assert.ok(at >= 0, `build.ninja links ${output}`);
  const rest = ninja.slice(at);
  const end = rest.indexOf("\n\n");
  return rest.slice(0, end < 0 ? undefined : end);
}

/** The compile `build.ninja` holds for one executable's `src/main.cpp`: its definitions, includes and flags. */
function compileOf(ninja: string, target: string): string {
  const at = ninja.indexOf(`build CMakeFiles/${target}.dir/src/main.cpp.o:`);
  assert.ok(at >= 0, `build.ninja compiles ${target}`);
  const rest = ninja.slice(at);
  const end = rest.indexOf("\n\n");
  return rest.slice(0, end < 0 ? undefined : end);
}

/** A game folder with `src/main.cpp`, configured for the Mac with a genex-macos.cmake over empty prebuild and ANGLE folders. */
async function configuredMacGame(
  prefix: string,
): Promise<{ game: string; build: string; angle: string; ninja: string }> {
  const sdk = await macSdkPath(execXcode, process.platform);
  assert.ok(sdk, "the Command Line Tools name an SDK");
  const root = await tmpDir(prefix);
  const game = path.join(root, "game");
  await mkdir(path.join(game, "src"), { recursive: true });
  // CMake checks an imported library's include folder exists: the prebuilds' folders are made, empty.
  const prebuild = (variant: string) => ({
    lib: path.join(root, "store", "locks", "0123456789ab", variant, "lib", "libraylib.a"),
    include: path.join(root, "store", "locks", "0123456789ab", variant, "include"),
  });
  const raylib = prebuild("raylib-macos-es3-angle");
  const headless = prebuild("raylib-macos-es3-angle-headless");
  const angle = path.join(root, "store", "angle-macos", "c5bf49e78850-d1a8c476a1c4");
  for (const folder of [raylib.include, headless.include, angle]) await mkdir(folder, { recursive: true });
  const genex = path.join(root, "genex-macos.cmake");
  await writeFile(genex, genexCmake(BuildTarget.Mac, { lock: LOCK, raylib, headless, angle, recipe: readRecipe() }));
  await writeFile(
    path.join(game, "CMakeLists.txt"),
    'cmake_minimum_required(VERSION 3.28)\nproject(game CXX C)\ninclude("${GENEX_CMAKE}")\ngenex_add_game(SOURCES src/*.cpp)\n',
  );
  await writeFile(path.join(game, "src", "main.cpp"), "int main() { return 0; }\n");
  const build = path.join(root, "build");
  const cmake = devTool("cmake");
  const ninja = devTool("ninja");
  assert.ok("path" in cmake && "path" in ninja);
  await execFileAsync(cmake.path, [
    "-S",
    game,
    "-B",
    build,
    "-G",
    "Ninja",
    `-DCMAKE_MAKE_PROGRAM=${ninja.path}`,
    `-DGENEX_CMAKE=${genex}`,
    `-DCMAKE_OSX_SYSROOT=${sdk}`,
  ]);
  return { game, build, angle, ninja: ninja.path };
}

const MAC_REAL = {
  ...needsTools("cmake", "ninja"),
  ...(process.platform === "darwin" ? {} : { skip: "Apple's SDK" }),
};

describe("genex-macos.cmake under the real CMake (required when present)", () => {
  it(
    "links game and game-headless to the lock's ANGLE with one rpath, thin arm64 at the deployment target",
    MAC_REAL,
    async () => {
      const { build, angle } = await configuredMacGame("genex-cmake-mac-");
      const rules = await readFile(path.join(build, "build.ninja"), "utf8");
      for (const name of ["game", "game-headless"]) {
        const link = linkOf(rules, `out/${name}`);
        assert.ok(link.includes(`-L${angle}`), `${name} -L the lock's ANGLE`);
        assert.match(link, /-lEGL\s+-lGLESv2/, `${name} imports EGL and GLESv2 at link time`);
        assert.equal(link.match(/-rpath/g)?.length, 1, `${name} carries one rpath`);
        assert.ok(link.includes("-Wl,-rpath,@executable_path/../Frameworks"), name);
        assert.match(link, /-arch arm64/, `${name} is arm64`);
        assert.doesNotMatch(link, /-arch x86_64/, `${name} is thin`);
        assert.match(link, /-mmacosx-version-min=13\.0|-target arm64-apple-macos13\.0/, `${name} targets macOS 13.0`);
        assert.doesNotMatch(link, /OpenGL/);
      }
      assert.match(linkOf(rules, "out/game"), /-framework Cocoa/);
      assert.doesNotMatch(linkOf(rules, "out/game-headless"), /Cocoa|AppKit/);
    },
  );

  it(
    "compiles game and game-headless with the lock's ANGLE headers and the mixer rate the template requires",
    MAC_REAL,
    async () => {
      const { build, angle } = await configuredMacGame("genex-cmake-mac-compile-");
      const rules = await readFile(path.join(build, "build.ninja"), "utf8");
      for (const name of ["game", "game-headless"]) {
        const compile = compileOf(rules, name);
        assert.ok(compile.includes(`-isystem ${path.join(angle, "include")}`), `${name} finds EGL/egl.h`);
        assert.match(compile, /-DGENEX_AUDIO_RATE_HZ=48000\b/, `${name} knows the mixer rate`);
      }
    },
  );

  it(
    "copies the assets of a game that has none yet (the template's are notes only), then the first one it gets",
    MAC_REAL,
    async () => {
      const { game, build, ninja } = await configuredMacGame("genex-cmake-mac-assets-");
      const copy = () => execFileAsync(ninja, ["-C", build, "genex_copy_assets"]);
      await copy();
      assert.deepEqual(await readdir(path.join(build, "out", "assets")), [], "out/assets is made, empty");
      await mkdir(path.join(game, "assets"), { recursive: true });
      await writeFile(path.join(game, "assets", "level.txt"), "level one\n");
      await copy();
      assert.equal(await readFile(path.join(build, "out", "assets", "level.txt"), "utf8"), "level one\n");
    },
  );
});

describe("a tiny raylib game against the dev store (required when present)", () => {
  it("configures and builds under the real sandbox with the store write-denied", {
    ...needsTools("devStore"),
    ...POSIX_ONLY,
  }, async () => {
    const store = devTool("devStore");
    assert.ok("path" in store);
    const lock = await devStoreLock();
    assert.ok(lock, "the dev store has a current lock (node scripts/toolchains/dev-store.ts)");
    const located = await locateToolchain(store.path, lock, [BuildTarget.Web]);
    assert.ok(located.ok, JSON.stringify(located));
    const { toolchain } = located;
    const emscripten = toolchain.emscripten;
    const genex = toolchain.genexCmake[BuildTarget.Web];
    assert.ok(emscripten && genex);

    const root = await tmpDir("genex-cmake-game-");
    const game = path.join(root, "game with space");
    const build = path.join(root, "build");
    for (const folder of ["src", "web", "assets"]) await mkdir(path.join(game, folder), { recursive: true });
    await writeFile(
      path.join(game, "CMakeLists.txt"),
      'cmake_minimum_required(VERSION 3.28)\nproject(game CXX C)\ninclude("${GENEX_CMAKE}")\ngenex_add_game(SOURCES src/*.cpp)\n',
    );
    await writeFile(
      path.join(game, "src", "main.cpp"),
      '#include "raylib.h"\nint main() { InitWindow(64, 64, "tiny"); CloseWindow(); return 0; }\n',
    );
    await writeFile(path.join(game, "web", "shell.html"), "<!doctype html><canvas id=canvas></canvas>{{{ SCRIPT }}}\n");
    await writeFile(path.join(game, "assets", "sprite.txt"), "pixels\n");
    await writeFile(path.join(game, "assets", "README.md"), "notes for people, never packaged\n");

    const sandbox = await ProcessSandbox.create({
      writableRoots: [root],
      scratchDir: path.join(root, "scratch"),
      secretPaths: [],
      denyWrite: [store.path],
    });
    after(() => sandbox.dispose());
    const env = {
      EM_CACHE: path.join(root, "em-cache"),
      EM_CONFIG: emscripten.config,
      EMSDK_PYTHON: emscripten.python,
      EMCC_SKIP_SANITY_CHECK: "1",
      PYTHONDONTWRITEBYTECODE: "1",
    };
    const clone = process.platform === "darwin" ? "cp -c -R" : "cp -R --reflink=auto";
    const steps = [
      `${clone} ${shellQuote(emscripten.cache)} ${shellQuote(env.EM_CACHE)}`,
      [
        toolchain.cmake,
        "-S",
        game,
        "-B",
        build,
        "-G",
        "Ninja",
        `-DCMAKE_MAKE_PROGRAM=${toolchain.ninja}`,
        `-DGENEX_CMAKE=${genex}`,
        `-DCMAKE_TOOLCHAIN_FILE=${emscripten.toolchainFile}`,
      ]
        .map(shellQuote)
        .join(" "),
      [toolchain.cmake, "--build", build].map(shellQuote).join(" "),
    ];
    for (const command of steps) {
      const outcome = await sandbox.run({ command, cwd: root, env, timeoutMs: 5 * 60_000 });
      assert.equal(outcome.code, 0, `${command}\n${outcome.stdout}\n${outcome.stderr}`);
      assert.equal(outcome.sandboxed, true);
    }
    for (const name of ["index.html", "index.js", "index.wasm", "index.data"])
      assert.equal(existsSync(path.join(build, "out", name)), true, `out/${name}`);
    const glue = await readFile(path.join(build, "out", "index.js"), "utf8");
    assert.ok(glue.includes("/assets/sprite.txt"), "the asset is packaged");
    assert.ok(!glue.includes("README.md"), "notes are not");
    assert.equal(existsSync(path.join(build, "CMakeFiles", "VerifyGlobs.cmake")), true, "the globs re-run");

    await writeFile(path.join(game, "src", "second.cpp"), "int genex_second() { return 2; }\n");
    const rebuild = await sandbox.run({ command: steps[2], cwd: root, env, timeoutMs: 5 * 60_000 });
    assert.equal(rebuild.code, 0, rebuild.stderr);
    assert.ok(
      (await readFile(path.join(build, "build.ninja"), "utf8")).includes("second.cpp"),
      "a new source is picked up",
    );
  });
});

const GOLDEN_WEB = `# genex-web.cmake: generated by Genex for toolchain lock 0123456789ab. Do not edit.
# A game's CMakeLists.txt includes it after project() and calls genex_add_game(SOURCES <globs>...).
include_guard(GLOBAL)

if(CMAKE_BINARY_DIR STREQUAL CMAKE_SOURCE_DIR)
  message(FATAL_ERROR "genex: in-source builds are refused; configure with -B <a folder outside the game>.")
endif()

set(FETCHCONTENT_FULLY_DISCONNECTED ON CACHE BOOL "Genex builds offline" FORCE)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release CACHE STRING "Genex's default build type" FORCE)
endif()
set(CMAKE_EXECUTABLE_SUFFIX ".html")
set(GENEX_TARGET "web")
set(GENEX_LOCK "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")

add_library(genex_raylib STATIC IMPORTED GLOBAL)
set_target_properties(genex_raylib PROPERTIES
  IMPORTED_LOCATION [=[/store/locks/0123456789ab/raylib-web-es3/lib/libraylib.a]=]
  INTERFACE_INCLUDE_DIRECTORIES [=[/store/locks/0123456789ab/raylib-web-es3/include]=]
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
  )
  target_compile_definitions(game PRIVATE
    PLATFORM_WEB
    GRAPHICS_API_OPENGL_ES3
  )
  target_link_libraries(game PRIVATE genex_raylib)
  target_link_options(game PRIVATE
    "-sUSE_GLFW=3"
    "-sMIN_WEBGL_VERSION=2"
    "-sMAX_WEBGL_VERSION=2"
    "-sENVIRONMENT=web"
    "-sEXPORTED_RUNTIME_METHODS=ccall,requestFullscreen"
    "-sALLOW_MEMORY_GROWTH=1"
    "-lidbfs.js"
    "--shell-file=\${CMAKE_CURRENT_SOURCE_DIR}/web/shell.html"
  )
  set_property(TARGET game APPEND PROPERTY LINK_DEPENDS "\${CMAKE_CURRENT_SOURCE_DIR}/web/shell.html")
  if(DEFINED GENEX_ASSETS)
    set(genex_asset_dir "\${GENEX_ASSETS}")
  else()
    set(genex_asset_dir "\${CMAKE_CURRENT_SOURCE_DIR}/assets")
  endif()
  file(GLOB_RECURSE genex_assets CONFIGURE_DEPENDS "\${genex_asset_dir}/*")
  list(FILTER genex_assets EXCLUDE REGEX "\\\\.md$")
  if(genex_assets)
    string(REPLACE "@" "@@" genex_asset_root "\${genex_asset_dir}")
    target_link_options(game PRIVATE "--preload-file=\${genex_asset_root}@/assets" "--exclude-file=*.md")
    set_property(TARGET game APPEND PROPERTY LINK_DEPENDS \${genex_assets})
  endif()
  if(DEFINED GENEX_ASSETS_STAMP)
    set_property(TARGET game APPEND PROPERTY LINK_DEPENDS "\${GENEX_ASSETS_STAMP}")
  endif()
  set_target_properties(game PROPERTIES
    OUTPUT_NAME index
    RUNTIME_OUTPUT_DIRECTORY "\${CMAKE_BINARY_DIR}/out"
  )
endfunction()
`;

const GOLDEN_SHARED_BLOCKS = `include_guard(GLOBAL)

if(CMAKE_BINARY_DIR STREQUAL CMAKE_SOURCE_DIR)
  message(FATAL_ERROR "genex: in-source builds are refused; configure with -B <a folder outside the game>.")
endif()
---
set(FETCHCONTENT_FULLY_DISCONNECTED ON CACHE BOOL "Genex builds offline" FORCE)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release CACHE STRING "Genex's default build type" FORCE)
endif()
---
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
---
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
---
    "-ffp-contract=off"
    "$<$<COMPILE_LANGUAGE:CXX>:-std=c++20>"
---
GENEX_AUDIO_RATE_HZ=48000
AUDIO_DEVICE_SAMPLE_RATE=48000`;
