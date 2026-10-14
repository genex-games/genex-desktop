// biome-ignore-all lint/suspicious/noTemplateCurlyInString: CMake's own ${VAR} references are the text this file reads.
/**
 * The Mac half of the C++ lane, on fakes: the recipe's Mac destination (two plain executables, no
 * bundle), `genex-macos.cmake` (both executables linking the lock's ANGLE explicitly, one rpath,
 * `GENEX_HEADLESS` on the headless one only, the staged assets copied into `out/assets`), the Mac
 * prewarm (the Command Line Tools first, the windowed raylib over ANGLE and the headless one from
 * a build-tree copy whose `rcore_memory.c` is Genex's headless platform, whose sha256 the prewarm
 * record keeps for the Mac alone, read without following a link or blocking), locating a Mac lock
 * (its ANGLE included), and the local-artifact install seam
 * the developer's store takes ANGLE through: verified file by file, copied, never linked, and a
 * hostile folder leaves nothing in the store.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  appendFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { BuildTarget } from "../../src/shared/game-project.ts";
import {
  MAC_GAME_RPATH,
  MAC_MINIMUM_SYSTEM_VERSION,
  NATIVE_MAC_EXECUTABLES,
  NativeRunMode,
} from "../../src/shared/native-contract.ts";
import {
  type ToolchainEntry,
  ToolchainError,
  ToolchainHost,
  ToolchainId,
  ToolchainInstallPhase,
  type ToolchainLocalArtifact,
  type ToolchainLock,
  ToolchainProblem,
  ToolchainUnhosted,
} from "../../src/shared/toolchain.ts";
import type { RunRequest, RunResult } from "../../src/substrate/spawn.ts";
import { genexCmake, type Recipe, readRecipe, recipeSha12 } from "../../src/substrate/toolchain-store/genex-cmake.ts";
import {
  installComponents,
  installLocalArtifact,
  ReceiptSource,
  readReceipts,
  type ToolchainReceipt,
} from "../../src/substrate/toolchain-store/install.ts";
import {
  locateToolchain,
  lockOutputs,
  macSdkPath,
  type XcodeExec,
} from "../../src/substrate/toolchain-store/locate.ts";
import { lockOf } from "../../src/substrate/toolchain-store/lock.ts";
import { entrySha12, manifestEntry } from "../../src/substrate/toolchain-store/manifest.ts";
import { PrewarmStep, prewarm, prewarmedTargets } from "../../src/substrate/toolchain-store/prewarm.ts";
import { tmpDir } from "../helpers/tmp.ts";

const execFileAsync = promisify(execFile);
const POSIX_ONLY = process.platform === "win32" ? { skip: "FIFOs and the store's links are POSIX" } : {};
const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

// ---------- a store tree, snapshotted byte for byte ----------

async function snapshot(root: string): Promise<string[]> {
  if (!existsSync(root)) return ["<absent>"];
  const lines: string[] = [];
  const walk = async (folder: string): Promise<void> => {
    for (const name of (await readdir(folder)).sort()) {
      const full = path.join(folder, name);
      const rel = path.relative(root, full);
      const info = await lstat(full);
      if (info.isSymbolicLink()) lines.push(`${rel} -> ${await readlink(full)}`);
      else if (info.isDirectory()) {
        lines.push(`${rel}/`);
        await walk(full);
      } else if (info.isFile()) lines.push(`${rel} ${info.mode.toString(8)} ${sha256(await readFile(full))}`);
      else lines.push(`${rel} special`);
    }
  };
  await walk(root);
  return lines;
}

// ---------- the recipe ----------

describe("the recipe's Mac destination", () => {
  it("builds two plain executables, never a bundle: the window's and the headless one", () => {
    const mac = readRecipe().targets[BuildTarget.Mac];
    assert.ok(mac, "the recipe has a Mac destination");
    assert.equal(mac.bundle, false);
    assert.equal(mac.output, NATIVE_MAC_EXECUTABLES[NativeRunMode.Window]);
    assert.equal(mac.headless?.output, NATIVE_MAC_EXECUTABLES[NativeRunMode.Headless]);
    assert.equal(mac.cmake?.CMAKE_OSX_ARCHITECTURES, "arm64");
    assert.equal(mac.cmake?.CMAKE_OSX_DEPLOYMENT_TARGET, MAC_MINIMUM_SYSTEM_VERSION);
    assert.deepEqual(mac.definitions, ["PLATFORM_DESKTOP_GLFW", "GRAPHICS_API_OPENGL_ES3"]);
    assert.ok(mac.headless?.definitions.includes("GENEX_HEADLESS"));
    assert.ok(!mac.definitions.includes("GENEX_HEADLESS"));
    for (const frameworks of [mac.frameworks, mac.headless?.frameworks ?? []])
      assert.ok(!frameworks.includes("OpenGL"), "no executable links OpenGL");
    assert.ok(!mac.headless?.frameworks.includes("Cocoa"), "the headless game links no AppKit");
  });

  it("prebuilds raylib twice for the Mac: GLFW over ANGLE's EGL, and Genex's headless platform", () => {
    const recipe = readRecipe();
    const windowed = recipe.raylib["macos-es3-angle"];
    const headless = recipe.raylib["macos-es3-angle-headless"];
    assert.ok(windowed && headless);
    assert.equal(windowed.cmake.PLATFORM, "Desktop");
    assert.equal(windowed.cmake.OPENGL_VERSION, "ES 3.0");
    assert.equal(windowed.cmake.CMAKE_OSX_ARCHITECTURES, "arm64");
    assert.equal(windowed.cmake.CMAKE_OSX_DEPLOYMENT_TARGET, MAC_MINIMUM_SYSTEM_VERSION);
    assert.deepEqual(windowed.cDefinitions, [
      "MA_NO_RUNTIME_LINKING",
      '_GLFW_EGL_LIBRARY="@executable_path/../Frameworks/libEGL.dylib"',
      '_GLFW_GLESV2_LIBRARY="@executable_path/../Frameworks/libGLESv2.dylib"',
    ]);
    assert.equal(headless.cmake.PLATFORM, undefined, "raylib's own CMake never builds the headless variant");
    assert.deepEqual(headless.headless?.definitions, ["PLATFORM_MEMORY", "GRAPHICS_API_OPENGL_ES3"]);
    assert.deepEqual(headless.headless?.sources, [
      "rcore.c",
      "rshapes.c",
      "rtextures.c",
      "rtext.c",
      "rmodels.c",
      "raudio.c",
    ]);
    assert.equal(headless.headless?.replaces, "platforms/rcore_memory.c");
  });

  it("names a Mac lock's prewarm outputs: genex-macos.cmake and both raylib prebuilds", () => {
    const outputs = lockOutputs(BuildTarget.Mac);
    assert.deepEqual(outputs, [
      "genex-macos.cmake",
      "raylib-macos-es3-angle-headless/include/raylib.h",
      "raylib-macos-es3-angle-headless/include/raymath.h",
      "raylib-macos-es3-angle-headless/include/rlgl.h",
      "raylib-macos-es3-angle-headless/lib/libraylib.a",
      "raylib-macos-es3-angle/include/raylib.h",
      "raylib-macos-es3-angle/include/raymath.h",
      "raylib-macos-es3-angle/include/rlgl.h",
      "raylib-macos-es3-angle/lib/libraylib.a",
    ]);
  });

  // Flipped (wave 5, decision T1): Windows and Linux are prewarmed beside the Mac and the web.
  it("prewarms the Mac only on an Apple silicon Mac, beside the web and the two cross destinations", () => {
    const all = [BuildTarget.Web, BuildTarget.Mac, BuildTarget.Windows, BuildTarget.Linux];
    assert.deepEqual(prewarmedTargets("darwin", "arm64"), all);
    assert.deepEqual(prewarmedTargets("darwin", "x64"), [BuildTarget.Web]);
    assert.deepEqual(prewarmedTargets("linux", "x64"), [BuildTarget.Web, BuildTarget.Windows, BuildTarget.Linux]);
    assert.deepEqual(prewarmedTargets("win32", "x64"), [BuildTarget.Web]);
  });
});

// ---------- genex-macos.cmake ----------

const LOCK: ToolchainLock = {
  version: 1,
  entries: {
    cmake: { version: "4.4.3", sha12: "0c5d65251c14" },
    ninja: { version: "1.13.2", sha12: "c99048673aa7" },
    raylib: { version: "6.0", sha12: "2b3ee1e2120c" },
    "angle-macos": { version: "c5bf49e78850", sha12: "d1a8c476a1c4" },
  },
  digest: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
};
/** genex-macos.cmake for {@link MAC_INPUT} and the recipe digest, as the Mac lane wrote them before wave 5. */
const MAC_MODULE_SHA256 = "083290a05ff126179b180252c4caf777bbe258783f09c4a3958faaa2b011a035";
const MAC_RECIPE_SHA12 = "18aa86ec0d3b";
const LOCK_DIR = "/store/locks/0123456789ab";
const ANGLE_DIR = "/store/angle-macos/c5bf49e78850-d1a8c476a1c4";
const MAC_INPUT = {
  lock: LOCK,
  raylib: {
    lib: `${LOCK_DIR}/raylib-macos-es3-angle/lib/libraylib.a`,
    include: `${LOCK_DIR}/raylib-macos-es3-angle/include`,
  },
  headless: {
    lib: `${LOCK_DIR}/raylib-macos-es3-angle-headless/lib/libraylib.a`,
    include: `${LOCK_DIR}/raylib-macos-es3-angle-headless/include`,
  },
  angle: ANGLE_DIR,
};
const macText = (recipe: Recipe = readRecipe()) => genexCmake(BuildTarget.Mac, { ...MAC_INPUT, recipe });

/** The lines of one executable's block, from its `add_executable` to the next one or the assets. */
function executableBlock(text: string, name: string): string {
  const start = text.indexOf(`add_executable(${name} `);
  assert.ok(start >= 0, `${name} is built`);
  const rest = text.slice(start + 1);
  const ends = [rest.indexOf("add_executable("), rest.indexOf("# assets"), rest.indexOf("endfunction()")].filter(
    (at) => at >= 0,
  );
  return text.slice(start, start + 1 + Math.min(...ends));
}

describe("genex-macos.cmake", () => {
  it("builds exactly two executables, game and game-headless, into out/", () => {
    const out = macText();
    assert.equal(out.match(/add_executable\(/g)?.length, 2);
    for (const name of Object.values(NATIVE_MAC_EXECUTABLES)) {
      const block = executableBlock(out, name);
      assert.ok(block.includes(`OUTPUT_NAME ${name}`), name);
      assert.ok(block.includes('RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/out"'), name);
    }
    assert.doesNotMatch(out, /MACOSX_BUNDLE/);
  });

  it("links both executables to the lock's ANGLE explicitly, with exactly one rpath, thin arm64 at the deployment target", () => {
    const out = macText();
    for (const name of Object.values(NATIVE_MAC_EXECUTABLES)) {
      const block = executableBlock(out, name);
      assert.ok(block.includes(`target_link_directories(${name} PRIVATE [=[${ANGLE_DIR}]=])`), `${name} -L ANGLE`);
      assert.match(block, new RegExp(`target_link_libraries\\(${name} PRIVATE genex_raylib\\S* EGL GLESv2 `));
      assert.equal(block.split(`-Wl,-rpath,${MAC_GAME_RPATH}`).length - 1, 1, `${name} has one rpath`);
      assert.ok(block.includes("SKIP_BUILD_RPATH TRUE"), `${name} gets no build-tree rpath`);
      assert.ok(block.includes("OSX_ARCHITECTURES arm64"), `${name} is thin arm64`);
    }
    assert.ok(out.includes(`set(CMAKE_OSX_DEPLOYMENT_TARGET "${MAC_MINIMUM_SYSTEM_VERSION}"`));
    assert.doesNotMatch(out, /OpenGL/, "never OpenGL");
    assert.doesNotMatch(out, /Electron|Chromium/, "never Electron's ANGLE");
  });

  it("defines GENEX_HEADLESS on game-headless only, which links the headless raylib and no AppKit", () => {
    const out = macText();
    const game = executableBlock(out, "game");
    const headless = executableBlock(out, "game-headless");
    assert.ok(!game.includes("GENEX_HEADLESS"));
    assert.ok(headless.includes("GENEX_HEADLESS"));
    assert.ok(game.includes("genex_raylib EGL"), "the window's game links the windowed raylib");
    assert.ok(headless.includes("genex_raylib_headless EGL"), "the headless game links the headless raylib");
    assert.ok(game.includes('"-framework Cocoa"'));
    assert.ok(!headless.includes("Cocoa") && !headless.includes("AppKit"));
    assert.ok(out.includes(`IMPORTED_LOCATION [=[${MAC_INPUT.headless.lib}]=]`));
  });

  it("copies the staged assets into out/assets, renewed whenever the stage or its stamp changes", () => {
    const out = macText();
    assert.ok(out.includes('"${CMAKE_BINARY_DIR}/out/assets"'));
    assert.ok(out.includes("GENEX_ASSETS_STAMP"));
    assert.ok(out.includes("copy_directory"));
    assert.ok(out.includes("-E rm -rf"), "a removed asset is not left behind");
  });

  it("stays offline and refuses a recipe that asks for a refused flag", () => {
    const out = macText();
    assert.ok(out.includes("FETCHCONTENT_FULLY_DISCONNECTED ON"));
    assert.doesNotMatch(out, /FetchContent_|ExternalProject/);
    const recipe = readRecipe();
    const mac = recipe.targets[BuildTarget.Mac];
    assert.ok(mac);
    const tampered: Recipe = {
      ...recipe,
      targets: { ...recipe.targets, [BuildTarget.Mac]: { ...mac, link: [...mac.link, "-ffast-math"] } },
    };
    assert.throws(
      () => macText(tampered),
      (error: unknown) => error instanceof ToolchainError && error.problem === ToolchainProblem.Prewarm,
    );
  });

  it("links both executables with the recipe's Mac link options, beside the one rpath", () => {
    const recipe = readRecipe();
    const mac = recipe.targets[BuildTarget.Mac];
    assert.ok(mac);
    const linked: Recipe = {
      ...recipe,
      targets: { ...recipe.targets, [BuildTarget.Mac]: { ...mac, link: [...mac.link, "-Wl,-dead_strip"] } },
    };
    const out = macText(linked);
    for (const name of Object.values(NATIVE_MAC_EXECUTABLES)) {
      const block = executableBlock(out, name);
      assert.ok(block.includes('"-Wl,-dead_strip"'), `${name} carries the recipe's link option`);
      assert.equal(block.split(`-Wl,-rpath,${MAC_GAME_RPATH}`).length - 1, 1, `${name} still has one rpath`);
    }
  });

  it("compiles both executables against the lock's ANGLE headers, at the mixer rate the recipe gives raylib", () => {
    const out = macText();
    const rate = readRecipe().nativeAudioRateHz;
    assert.equal(rate, 48_000);
    for (const name of Object.values(NATIVE_MAC_EXECUTABLES)) {
      const block = executableBlock(out, name);
      assert.ok(
        block.includes(`target_include_directories(${name} SYSTEM PRIVATE [=[${ANGLE_DIR}/include]=])`),
        `${name} finds EGL/egl.h in the lock's ANGLE`,
      );
      assert.match(block, new RegExp(`^\\s+GENEX_AUDIO_RATE_HZ=${rate}$`, "m"), `${name} knows the mixer rate`);
    }
  });

  it("is the module the Mac lane built before the cross destinations came (characterization)", () => {
    assert.equal(sha256(macText()), MAC_MODULE_SHA256, "genex-macos.cmake is byte-identical");
    assert.equal(recipeSha12(readRecipe()), MAC_RECIPE_SHA12, "and so is the recipe digest its prewarm records");
  });

  it("refuses to write a Mac module without the headless prebuild or the ANGLE folder", () => {
    for (const missing of ["headless", "angle"] as const) {
      const { [missing]: _dropped, ...input } = MAC_INPUT;
      assert.throws(
        () => genexCmake(BuildTarget.Mac, { ...input, recipe: readRecipe() }),
        (error: unknown) => error instanceof ToolchainError && error.problem === ToolchainProblem.Prewarm,
        missing,
      );
    }
  });
});

// ---------- the Mac prewarm, on a fake store ----------

const ANGLE_FILES = ["libEGL.dylib", "libGLESv2.dylib", "include/EGL/egl.h", "include/GLES3/gl3.h"];
const ANGLE_MANIFEST_SHA = "d1a8c476a1c471404b6b353161033f3a9ef4f53249fa42b2eb9909e84fad22cc";

const FAKE = {
  [ToolchainId.Cmake]: { version: "4.4.3", files: ["CMake.app/Contents/bin/cmake"], host: ToolchainHost.MacArm64 },
  [ToolchainId.Ninja]: { version: "1.13.2", files: ["ninja"], host: ToolchainHost.MacArm64 },
  [ToolchainId.Emsdk]: {
    version: "6.0.10",
    files: [
      "install/emscripten/emcc",
      "install/emscripten/cmake/Modules/Platform/Emscripten.cmake",
      "install/emscripten/cache/sysroot/include/stdio.h",
      "python/python-3.13.3-0/bin/python3",
      "node/bin/node",
    ],
    host: ToolchainHost.MacArm64,
  },
  [ToolchainId.RaylibSource]: {
    version: "6.0",
    files: [
      "CMakeLists.txt",
      "src/raylib.h",
      "src/rlgl.h",
      "src/raymath.h",
      "src/rcore.c",
      "src/platforms/rcore_memory.c",
    ],
    host: null,
  },
  [ToolchainId.AngleMac]: { version: "c5bf49e78850", files: [...ANGLE_FILES, "manifest.json"], host: null },
} as const;
type FakeId = keyof typeof FAKE;
/** A lock that builds both the web and the Mac. */
const EVERY_COMPONENT: readonly FakeId[] = [
  ToolchainId.Cmake,
  ToolchainId.Ninja,
  ToolchainId.Emsdk,
  ToolchainId.RaylibSource,
  ToolchainId.AngleMac,
];

interface FakeMacStore {
  root: string;
  store: string;
  lock: ToolchainLock;
  /** A headless platform file of the row's own. */
  platformFile: string;
}

async function fakeMacStore(
  ids: readonly FakeId[] = [ToolchainId.Cmake, ToolchainId.Ninja, ToolchainId.RaylibSource, ToolchainId.AngleMac],
): Promise<FakeMacStore> {
  const root = await realpath(await tmpDir("mac-lane-store-"));
  const store = path.join(root, "store");
  const entries: ToolchainLock["entries"] = {};
  for (const id of ids) {
    const { version, files, host } = FAKE[id];
    const digest = id === ToolchainId.AngleMac ? ANGLE_MANIFEST_SHA : sha256(id);
    const sha12 = digest.slice(0, 12);
    const folder = path.join(store, id, `${version}-${sha12}`);
    for (const rel of files) {
      await mkdir(path.dirname(path.join(folder, rel)), { recursive: true });
      await writeFile(path.join(folder, rel), "#!/bin/sh\n", { mode: 0o755 });
    }
    const receipt: ToolchainReceipt = {
      id,
      version,
      sha256: digest,
      sha12,
      bytes: 1,
      host,
      target: id === ToolchainId.AngleMac ? BuildTarget.Mac : null,
      source: id === ToolchainId.AngleMac ? ReceiptSource.LocalArtifact : ReceiptSource.Archive,
      installedAt: "2026-10-01T00:00:00.000Z",
    };
    await writeFile(path.join(folder, "receipt.json"), JSON.stringify(receipt));
    entries[id] = { version, sha12 };
  }
  const platformFile = path.join(root, "rcore_genex_headless.c");
  await writeFile(platformFile, "/* Genex headless platform, first cut */\n");
  return { root, store, lock: lockOf(entries), platformFile };
}

const SDK = "/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk";
const macSdk = async () => SDK;
/** A Mac prewarm runs on a Mac; the fake rows say so, so they run on any CI host. */
const ON_A_MAC = "darwin" as const;

/** The raylib variant a prebuild run installs, read from where its install step copies the library. */
function installedVariant(command: string): string | null {
  return /\/(raylib-[a-z0-9-]+)\/lib'/.exec(command)?.[1] ?? null;
}

function ok(request: RunRequest, code = 0): RunResult {
  return {
    code,
    signal: null,
    stdout: "",
    stderr: code === 0 ? "" : "failed",
    durationMs: 1,
    timedOut: false,
    truncated: false,
    sandboxed: true,
    command: request.command,
    cwd: request.cwd,
  };
}

/**
 * A prewarm runner that plays each step's part: an install writes its variant's library and
 * headers into staging; a configure records the CMakeLists.txt it was pointed at (the generated
 * headless list is read before staging goes).
 */
function macPrewarmRun(options: { skipVariant?: string } = {}) {
  const requests: RunRequest[] = [];
  const lists = new Map<string, string>();
  const run = async (request: RunRequest): Promise<RunResult> => {
    requests.push(request);
    const staging = request.policy?.allowWrite?.[0] ?? "";
    if (request.label === PrewarmStep.CloneCache)
      await mkdir(path.join(staging, "em-cache", "sysroot"), { recursive: true });
    if (request.label === PrewarmStep.RaylibConfigure) {
      const source = /'-S' '([^']+)'/.exec(request.command)?.[1] ?? "";
      const list = await readFile(path.join(source, "CMakeLists.txt"), "utf8").catch(() => "");
      lists.set(source, list);
    }
    const variant = request.label === PrewarmStep.RaylibInstall ? installedVariant(request.command) : null;
    if (variant && variant !== options.skipVariant) {
      const out = path.join(staging, variant);
      await mkdir(path.join(out, "lib"), { recursive: true });
      await mkdir(path.join(out, "include"), { recursive: true });
      await writeFile(path.join(out, "lib", "libraylib.a"), `!<arch>\n${variant}\n`);
      for (const header of ["raylib.h", "rlgl.h", "raymath.h"])
        await writeFile(path.join(out, "include", header), "//");
    }
    return ok(request);
  };
  return { run, requests, lists };
}

/** `xcode-select -p` and `xcrun` as a computer with (or without) the Command Line Tools answers them; every call recorded. */
function xcodeProbe(withTools: boolean) {
  const calls: string[][] = [];
  const exec: XcodeExec = async (file, args) => {
    calls.push([file, ...args]);
    if (!withTools) return { code: 2, stdout: "", stderr: "xcode-select: error: no developer tools" };
    const stdout = file.endsWith("xcode-select") ? "/Library/Developer/CommandLineTools\n" : `${SDK}\n`;
    return { code: 0, stdout, stderr: "" };
  };
  return { exec, calls };
}

describe("a Mac prewarm and the Command Line Tools", () => {
  it("needs the Command Line Tools: without them it refuses clt-missing before any step and leaves the store as it was", async () => {
    const { store, lock, platformFile } = await fakeMacStore();
    const before = await snapshot(store);
    for (const probe of [{ macSdk: async () => null }, { exec: xcodeProbe(false).exec }]) {
      const { run, requests } = macPrewarmRun();
      await assert.rejects(
        () =>
          prewarm(store, lock, [BuildTarget.Mac], {
            run,
            denyWrite: [],
            platform: ON_A_MAC,
            headlessPlatform: platformFile,
            ...probe,
          }),
        (error: unknown) => error instanceof ToolchainError && error.problem === ToolchainProblem.CltMissing,
      );
      assert.deepEqual(requests, [], "nothing ran");
    }
    assert.deepEqual(await snapshot(store), before);
  });

  it("asks the Command Line Tools probe itself when its caller names no SDK (the toolchain service names none)", async () => {
    const { store, lock, platformFile } = await fakeMacStore();
    const probe = xcodeProbe(true);
    const { run, requests } = macPrewarmRun();
    await prewarm(store, lock, [BuildTarget.Mac], {
      run,
      denyWrite: [],
      platform: ON_A_MAC,
      headlessPlatform: platformFile,
      exec: probe.exec,
    });
    assert.deepEqual(probe.calls, [
      ["/usr/bin/xcode-select", "-p"],
      ["/usr/bin/xcrun", "--sdk", "macosx", "--show-sdk-path"],
    ]);
    const configure = requests.find((request) => request.label === PrewarmStep.RaylibConfigure);
    assert.ok(configure?.command.includes(`'-DCMAKE_OSX_SYSROOT=${SDK}'`), "the SDK it found is the one built against");
  });
});

describe("the Mac prewarm", () => {
  it("builds both raylib prebuilds and genex-macos.cmake under the overlay, then swaps them in; the lock then locates with its ANGLE", async () => {
    const { store, lock, platformFile } = await fakeMacStore();
    const { run, requests } = macPrewarmRun();
    const record = await prewarm(store, lock, [BuildTarget.Mac], {
      run,
      denyWrite: [],
      platform: ON_A_MAC,
      macSdk,
      headlessPlatform: platformFile,
      now: () => Date.UTC(2026, 9, 1),
    });
    const real = await realpath(store);
    const staging = path.join(real, ".staging", lock.digest);
    assert.deepEqual(record.outputs, lockOutputs(BuildTarget.Mac));
    for (const request of requests) {
      assert.deepEqual(request.policy?.allowWrite, [staging], `${request.label} writes staging only`);
      assert.ok(
        request.policy?.denyWrite?.includes(path.join(real, ToolchainId.AngleMac)),
        "the store's ANGLE is write-denied",
      );
      assert.deepEqual(request.policy?.allowedDomains, [], "no network");
    }
    assert.deepEqual(
      requests.map((request) => request.label),
      [
        PrewarmStep.RaylibConfigure,
        PrewarmStep.RaylibBuild,
        PrewarmStep.RaylibInstall,
        PrewarmStep.HeadlessSource,
        PrewarmStep.RaylibConfigure,
        PrewarmStep.RaylibBuild,
        PrewarmStep.RaylibInstall,
      ],
    );
    const angle = path.join(real, ToolchainId.AngleMac, `c5bf49e78850-${ANGLE_MANIFEST_SHA.slice(0, 12)}`);
    const folder = path.join(real, "locks", lock.digest.slice(0, 12));
    const module = await readFile(path.join(folder, "genex-macos.cmake"), "utf8");
    assert.ok(module.includes(`[=[${angle}]=]`), "genex-macos.cmake links the store's own ANGLE install");
    for (const variant of ["raylib-macos-es3-angle", "raylib-macos-es3-angle-headless"])
      assert.ok(module.includes(path.join(folder, variant, "lib", "libraylib.a")), variant);
    assert.ok(!module.includes(".staging"), "and never the staging folder");
    assert.equal(existsSync(path.join(real, ".staging")), false);

    const located = await locateToolchain(store, lock, [BuildTarget.Mac], { headlessPlatform: platformFile });
    assert.ok(located.ok, JSON.stringify(located));
    assert.equal(located.toolchain.genexCmake[BuildTarget.Mac], path.join(folder, "genex-macos.cmake"));
    assert.deepEqual(located.toolchain.angle, {
      dir: angle,
      egl: path.join(angle, "libEGL.dylib"),
      gles: path.join(angle, "libGLESv2.dylib"),
      manifestSha256: ANGLE_MANIFEST_SHA,
    });
    assert.equal(located.toolchain.emscripten, null, "a Mac lock has no Emscripten to name");
  });
});

describe("the headless platform file a Mac prewarm records", () => {
  it("records the headless platform file it built: a changed file reads as stale for the Mac until prewarmed again", async () => {
    const { store, lock, platformFile } = await fakeMacStore();
    const deps = { denyWrite: [], platform: ON_A_MAC, macSdk, headlessPlatform: platformFile };
    const first = await prewarm(store, lock, [BuildTarget.Mac], { ...deps, run: macPrewarmRun().run });
    assert.equal(first.platform, sha256(await readFile(platformFile)));
    assert.ok((await locateToolchain(store, lock, [BuildTarget.Mac], { headlessPlatform: platformFile })).ok);
    await appendFile(platformFile, "/* W2-CPP-RUNTIME's final cut */\n");
    assert.deepEqual(await locateToolchain(store, lock, [BuildTarget.Mac], { headlessPlatform: platformFile }), {
      ok: false,
      missing: [ToolchainId.RaylibSource, ToolchainId.AngleMac],
      needsPrewarm: true,
    });
    const second = await prewarm(store, lock, [BuildTarget.Mac], { ...deps, run: macPrewarmRun().run });
    assert.equal(second.recipe, first.recipe, "the recipe's digest never folds in the platform file");
    assert.equal(second.recipe, recipeSha12(readRecipe()));
    assert.equal(second.platform, sha256(await readFile(platformFile)));
    assert.ok((await locateToolchain(store, lock, [BuildTarget.Mac], { headlessPlatform: platformFile })).ok);
  });

  it("keeps the web located when only the headless platform file changed: the web never builds it", async () => {
    const { store, lock, platformFile } = await fakeMacStore(EVERY_COMPONENT);
    await prewarm(store, lock, [BuildTarget.Web, BuildTarget.Mac], {
      run: macPrewarmRun().run,
      denyWrite: [],
      platform: ON_A_MAC,
      macSdk,
      headlessPlatform: platformFile,
    });
    await appendFile(platformFile, "/* an edit to the headless platform */\n");
    const options = { headlessPlatform: platformFile };
    assert.ok((await locateToolchain(store, lock, [BuildTarget.Web], options)).ok, "the web still builds");
    assert.deepEqual(await locateToolchain(store, lock, [BuildTarget.Mac], options), {
      ok: false,
      missing: [ToolchainId.RaylibSource, ToolchainId.AngleMac],
      needsPrewarm: true,
    });
  });

  it("records no platform file for a web-only prewarm, and never reads one", async () => {
    const { root, store, lock } = await fakeMacStore(EVERY_COMPONENT);
    const record = await prewarm(store, lock, [BuildTarget.Web], {
      run: macPrewarmRun().run,
      denyWrite: [],
      platform: ON_A_MAC,
      headlessPlatform: path.join(root, "absent.c"),
    });
    assert.equal(record.platform, null);
    assert.ok(
      (await locateToolchain(store, lock, [BuildTarget.Web], { headlessPlatform: path.join(root, "absent.c") })).ok,
    );
  });
});

/** What a row puts at the headless platform file's path in place of the regular file the prewarm built. */
const HOSTILE_PLATFORMS: ReadonlyArray<{ name: string; plant: (file: string, root: string) => Promise<void> }> = [
  {
    name: "a FIFO, which a blocking read would wait on forever",
    plant: async (file) => {
      await rm(file);
      await execFileAsync("mkfifo", [file]);
    },
  },
  {
    name: "a link to a copy of the very bytes it built",
    plant: async (file, root) => {
      const copy = path.join(root, "copy.c");
      await writeFile(copy, await readFile(file));
      await rm(file);
      await symlink(copy, file);
    },
  },
  {
    name: "a file bigger than any platform file",
    plant: (file) => writeFile(file, Buffer.alloc(4 * 1024 * 1024 + 1, 0x20)),
  },
];

describe("a headless platform file that is not a plain one", POSIX_ONLY, () => {
  for (const hostile of HOSTILE_PLATFORMS) {
    it(`reads ${hostile.name} as no platform file: the Mac needs a prewarm that refuses, the web still locates, nothing in the store changes`, {
      timeout: 20_000,
    }, async () => {
      const { root, store, lock, platformFile } = await fakeMacStore(EVERY_COMPONENT);
      const deps = { denyWrite: [], platform: ON_A_MAC, macSdk, headlessPlatform: platformFile };
      await prewarm(store, lock, [BuildTarget.Web, BuildTarget.Mac], { ...deps, run: macPrewarmRun().run });
      await hostile.plant(platformFile, root);
      const before = await snapshot(store);
      const options = { headlessPlatform: platformFile };
      assert.ok((await locateToolchain(store, lock, [BuildTarget.Web], options)).ok);
      assert.deepEqual(await locateToolchain(store, lock, [BuildTarget.Mac], options), {
        ok: false,
        missing: [ToolchainId.RaylibSource, ToolchainId.AngleMac],
        needsPrewarm: true,
      });
      const { run, requests } = macPrewarmRun();
      await assert.rejects(
        () => prewarm(store, lock, [BuildTarget.Mac], { ...deps, run }),
        (error: unknown) => error instanceof ToolchainError && error.problem === ToolchainProblem.Prewarm,
      );
      assert.deepEqual(requests, [], "nothing ran");
      assert.deepEqual(await snapshot(store), before);
    });
  }
});

describe("what the Mac prewarm refuses", () => {
  it("refuses a Mac prewarm with no headless platform file, running nothing", async () => {
    const { root, store, lock } = await fakeMacStore();
    const before = await snapshot(store);
    const { run, requests } = macPrewarmRun();
    await assert.rejects(
      () =>
        prewarm(store, lock, [BuildTarget.Mac], {
          run,
          denyWrite: [],
          platform: ON_A_MAC,
          macSdk,
          headlessPlatform: path.join(root, "absent.c"),
        }),
      (error: unknown) => error instanceof ToolchainError && error.problem === ToolchainProblem.Prewarm,
    );
    assert.deepEqual(requests, []);
    assert.deepEqual(await snapshot(store), before);
  });

  it("leaves the store unchanged when the headless prebuild produces nothing", async () => {
    const { store, lock, platformFile } = await fakeMacStore();
    const before = await snapshot(store);
    const { run } = macPrewarmRun({ skipVariant: "raylib-macos-es3-angle-headless" });
    await assert.rejects(
      () =>
        prewarm(store, lock, [BuildTarget.Mac], {
          run,
          denyWrite: [],
          platform: ON_A_MAC,
          macSdk,
          headlessPlatform: platformFile,
        }),
      (error: unknown) => error instanceof ToolchainError && error.problem === ToolchainProblem.Prewarm,
    );
    assert.deepEqual(await snapshot(store), before);
  });
});

describe("the Mac prebuilds' commands", () => {
  it("configures the windowed raylib as ES 3.0 on Desktop GLFW over ANGLE: arm64 at the deployment target, the SDK, ANGLE's headers and GLFW's EGL names", async () => {
    const { store, lock, platformFile } = await fakeMacStore();
    const { run, requests } = macPrewarmRun();
    await prewarm(store, lock, [BuildTarget.Mac], {
      run,
      denyWrite: [],
      platform: ON_A_MAC,
      macSdk,
      headlessPlatform: platformFile,
    });
    const real = await realpath(store);
    const raylib = path.join(real, ToolchainId.RaylibSource);
    const configure = requests.find(
      (request) => request.label === PrewarmStep.RaylibConfigure && request.command.includes(`'-S' '${raylib}`),
    );
    assert.ok(configure, "the windowed variant configures raylib's own CMake");
    const angle = path.join(real, ToolchainId.AngleMac, `c5bf49e78850-${ANGLE_MANIFEST_SHA.slice(0, 12)}`);
    for (const flag of [
      "-DPLATFORM=Desktop",
      "-DOPENGL_VERSION=ES 3.0",
      "-DUSE_EXTERNAL_GLFW=OFF",
      "-DCMAKE_OSX_ARCHITECTURES=arm64",
      `-DCMAKE_OSX_DEPLOYMENT_TARGET=${MAC_MINIMUM_SYSTEM_VERSION}`,
      `-DCMAKE_OSX_SYSROOT=${SDK}`,
      `-DCMAKE_C_STANDARD_INCLUDE_DIRECTORIES=${path.join(angle, "include")}`,
      "-DSUPPORT_FILEFORMAT_JPG=ON",
      "-DSUPPORT_SCREEN_CAPTURE=OFF",
      "-DFETCHCONTENT_FULLY_DISCONNECTED=ON",
    ])
      assert.ok(configure.command.includes(`'${flag}'`), `configure carries ${flag}`);
    const cFlags = /'-DCMAKE_C_FLAGS=([^']*)'/.exec(configure.command)?.[1] ?? "";
    assert.equal(
      cFlags,
      '-ffp-contract=off -DMA_NO_RUNTIME_LINKING -D_GLFW_EGL_LIBRARY=\\"@executable_path/../Frameworks/libEGL.dylib\\" -D_GLFW_GLESV2_LIBRARY=\\"@executable_path/../Frameworks/libGLESv2.dylib\\" -DAUDIO_DEVICE_SAMPLE_RATE=48000',
      "the define reaches the compiler as a C string through the build's shell",
    );
    assert.equal(configure.env?.CLANG_MODULE_CACHE_PATH?.startsWith(path.join(real, ".staging", lock.digest)), true);
  });

  it("builds the headless raylib from a build-tree copy whose rcore_memory.c is Genex's platform, with its own CMake list, never raylib's software renderer", async () => {
    const { store, lock, platformFile } = await fakeMacStore();
    const { run, requests, lists } = macPrewarmRun();
    await prewarm(store, lock, [BuildTarget.Mac], {
      run,
      denyWrite: [],
      platform: ON_A_MAC,
      macSdk,
      headlessPlatform: platformFile,
    });
    const real = await realpath(store);
    const staging = path.join(real, ".staging", lock.digest);
    const copy = requests.find((request) => request.label === PrewarmStep.HeadlessSource);
    assert.ok(copy);
    const raylibSrc = path.join(
      real,
      ToolchainId.RaylibSource,
      `6.0-${sha256(ToolchainId.RaylibSource).slice(0, 12)}`,
      "src",
    );
    assert.ok(copy.command.includes(`'${raylibSrc}'`), "it copies raylib's src/");
    assert.match(copy.command, /\/platforms\/rcore_memory\.c'/, "and puts the platform file in rcore_memory.c's place");
    assert.ok(copy.command.includes(staging), "inside staging");
    const [headlessList] = [...lists.entries()]
      .filter(([source]) => source.startsWith(staging))
      .map(([, list]) => list);
    assert.ok(headlessList, "the headless variant configures the generated list in staging");
    for (const source of ["rcore.c", "rshapes.c", "rtextures.c", "rtext.c", "rmodels.c", "raudio.c"])
      assert.ok(headlessList.includes(`/${source}]=]`), source);
    for (const definition of [
      "PLATFORM_MEMORY",
      "GRAPHICS_API_OPENGL_ES3",
      "EXTERNAL_CONFIG_FLAGS",
      "SUPPORT_FILEFORMAT_JPG",
      "MA_NO_RUNTIME_LINKING",
      "AUDIO_DEVICE_SAMPLE_RATE=48000",
    ])
      assert.match(headlessList, new RegExp(`^\\s+${definition}$`, "m"), definition);
    assert.doesNotMatch(headlessList, /SUPPORT_SCREEN_CAPTURE|GRAPHICS_API_OPENGL_SOFTWARE|PLATFORM=Memory|rlsw/);
    const angleInclude = path.join(
      real,
      ToolchainId.AngleMac,
      `c5bf49e78850-${ANGLE_MANIFEST_SHA.slice(0, 12)}`,
      "include",
    );
    assert.ok(headlessList.includes(`[=[${angleInclude}]=]`), "ANGLE's headers");
  });
});

describe("locating a Mac lock", () => {
  it("needs a prewarm while the headless prebuild is missing, and names no ANGLE for a web-only lock", async () => {
    const { store, lock, platformFile } = await fakeMacStore();
    await prewarm(store, lock, [BuildTarget.Mac], {
      run: macPrewarmRun().run,
      denyWrite: [],
      platform: ON_A_MAC,
      macSdk,
      headlessPlatform: platformFile,
    });
    const headless = path.join(
      store,
      "locks",
      lock.digest.slice(0, 12),
      "raylib-macos-es3-angle-headless",
      "lib",
      "libraylib.a",
    );
    await rm(headless);
    assert.deepEqual(await locateToolchain(store, lock, [BuildTarget.Mac], { headlessPlatform: platformFile }), {
      ok: false,
      missing: [ToolchainId.RaylibSource, ToolchainId.AngleMac],
      needsPrewarm: true,
    });
  });

  it("reports a Mac lock whose ANGLE is not installed as missing angle-macos", async () => {
    const { store, lock, platformFile } = await fakeMacStore([
      ToolchainId.Cmake,
      ToolchainId.Ninja,
      ToolchainId.RaylibSource,
    ]);
    const angle = { version: "c5bf49e78850", sha12: ANGLE_MANIFEST_SHA.slice(0, 12) };
    const withAngle = lockOf({ ...lock.entries, [ToolchainId.AngleMac]: angle });
    assert.deepEqual(await locateToolchain(store, withAngle, [BuildTarget.Mac], { headlessPlatform: platformFile }), {
      ok: false,
      missing: [ToolchainId.AngleMac],
    });
  });

  it("prewarms the web and the Mac into one lock folder that locates both", async () => {
    const all = [
      ToolchainId.Cmake,
      ToolchainId.Ninja,
      ToolchainId.Emsdk,
      ToolchainId.RaylibSource,
      ToolchainId.AngleMac,
    ] as const;
    const { store, lock, platformFile } = await fakeMacStore(all);
    await prewarm(store, lock, [BuildTarget.Web, BuildTarget.Mac], {
      run: macPrewarmRun().run,
      denyWrite: [],
      platform: ON_A_MAC,
      macSdk,
      headlessPlatform: platformFile,
    });
    const located = await locateToolchain(store, lock, [BuildTarget.Web, BuildTarget.Mac], {
      headlessPlatform: platformFile,
    });
    assert.ok(located.ok, JSON.stringify(located));
    assert.ok(located.toolchain.emscripten);
    assert.ok(located.toolchain.angle);
    const web = await locateToolchain(store, lock, [BuildTarget.Web], { headlessPlatform: platformFile });
    assert.ok(web.ok);
    assert.equal(web.toolchain.angle, undefined, "a web build names no ANGLE");
  });
});

describe("the Command Line Tools probe", () => {
  /** An exec that answers `xcode-select -p` and `xcrun` as told, recording each call. */
  function xcode(answers: { select: number; sdk?: { code: number; stdout: string } }) {
    const calls: string[][] = [];
    const exec: XcodeExec = async (file, args) => {
      calls.push([file, ...args]);
      if (file.endsWith("xcode-select"))
        return {
          code: answers.select,
          stdout: answers.select === 0 ? "/Library/Developer/CommandLineTools\n" : "",
          stderr: "",
        };
      return { code: answers.sdk?.code ?? 0, stdout: answers.sdk?.stdout ?? `${SDK}\n`, stderr: "" };
    };
    return { exec, calls };
  }

  it("asks xcode-select first and xcrun only when a developer folder is selected; never anything that opens Apple's installer", async () => {
    const present = xcode({ select: 0 });
    assert.equal(await macSdkPath(present.exec, "darwin"), SDK);
    assert.deepEqual(present.calls, [
      ["/usr/bin/xcode-select", "-p"],
      ["/usr/bin/xcrun", "--sdk", "macosx", "--show-sdk-path"],
    ]);
    const absent = xcode({ select: 2 });
    assert.equal(await macSdkPath(absent.exec, "darwin"), null);
    assert.deepEqual(absent.calls, [["/usr/bin/xcode-select", "-p"]]);
    const noSdk = xcode({ select: 0, sdk: { code: 1, stdout: "" } });
    assert.equal(await macSdkPath(noSdk.exec, "darwin"), null);
    const relative = xcode({ select: 0, sdk: { code: 0, stdout: "MacOSX.sdk\n" } });
    assert.equal(await macSdkPath(relative.exec, "darwin"), null, "only an absolute SDK path is taken");
    const linux = xcode({ select: 0 });
    assert.equal(await macSdkPath(linux.exec, "linux"), null);
    assert.deepEqual(linux.calls, [], "off a Mac nothing runs");
  });
});

// ---------- the local-artifact install seam ----------

interface Artifact {
  root: string;
  store: string;
  folder: string;
  entry: ToolchainEntry;
  outside: string;
}

const ARTIFACT_FILES: Record<string, string> = {
  "libEGL.dylib": "egl bytes",
  "libGLESv2.dylib": "gles bytes",
  "include/EGL/egl.h": "/* egl */",
  "licenses/ANGLE.txt": "BSD-3-Clause",
};

/** A manifest.json over `files` (`rel` to bytes) as the ANGLE builds write it. */
function manifestOf(files: Record<string, string>): string {
  const listed = Object.fromEntries(
    Object.entries(files).map(([rel, text]) => [rel, { sha256: sha256(text), size: Buffer.byteLength(text) }]),
  );
  return `${JSON.stringify({ schema: 1, target: "macos-arm64-metal", files: listed }, null, 2)}\n`;
}

/** The entry that pins `manifest`. */
function pinned(manifest: string, files: Record<string, string>): ToolchainEntry {
  const local: ToolchainLocalArtifact = {
    manifestSha256: sha256(manifest),
    manifestBytes: Buffer.byteLength(manifest),
    files: Object.keys(files).length,
    bytes: Object.values(files).reduce((sum, text) => sum + Buffer.byteLength(text), 0),
    reason: ToolchainUnhosted.NotPublished,
  };
  return {
    id: ToolchainId.AngleMac,
    version: "c5bf49e78850",
    host: null,
    target: BuildTarget.Mac,
    archives: [],
    licence: "BSD-3-Clause",
    local,
  };
}

async function artifact(
  files: Record<string, string> = ARTIFACT_FILES,
  manifest = manifestOf(files),
): Promise<Artifact> {
  const root = await realpath(await tmpDir("mac-lane-artifact-"));
  const folder = path.join(root, "angle-metal-arm64", "c5bf49e78850");
  const store = path.join(root, "store");
  const outside = path.join(root, "outside");
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(folder, rel)), { recursive: true });
    await writeFile(path.join(folder, rel), text, { mode: rel.endsWith(".dylib") ? 0o755 : 0o644 });
  }
  await writeFile(path.join(folder, "manifest.json"), manifest);
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, "secret.txt"), "GENEX_OUTSIDE_SECRET");
  await mkdir(store, { recursive: true });
  await writeFile(path.join(store, "marker.txt"), "keep me\n");
  return { root, store, folder, entry: pinned(manifest, files), outside };
}

/** Folders the seam refuses, each with the problem it is refused with. */
const HOSTILE: Array<{
  name: string;
  problem: ToolchainProblem;
  make: () => Promise<Artifact>;
  only?: { skip?: string };
}> = [
  {
    name: "a manifest.json that is not the pinned one",
    problem: ToolchainProblem.Integrity,
    make: async () => {
      const made = await artifact();
      await appendFile(path.join(made.folder, "manifest.json"), " ");
      return made;
    },
  },
  {
    name: "a listed file whose bytes are not its manifest digest",
    problem: ToolchainProblem.Integrity,
    make: async () => {
      const made = await artifact();
      await writeFile(path.join(made.folder, "libGLESv2.dylib"), "gles BYTES");
      return made;
    },
  },
  {
    name: "a listed file that is missing",
    problem: ToolchainProblem.Integrity,
    make: async () => {
      const made = await artifact();
      await rm(path.join(made.folder, "licenses", "ANGLE.txt"));
      return made;
    },
  },
  {
    name: "a listed file that is a link out of the folder",
    problem: ToolchainProblem.Archive,
    make: async () => {
      const made = await artifact();
      await rm(path.join(made.folder, "libEGL.dylib"));
      await symlink(path.join(made.outside, "secret.txt"), path.join(made.folder, "libEGL.dylib"));
      return made;
    },
  },
  {
    name: "a folder that is a link",
    problem: ToolchainProblem.Archive,
    make: async () => {
      const made = await artifact();
      await rm(path.join(made.folder, "include"), { recursive: true });
      await symlink(made.outside, path.join(made.folder, "include"));
      return made;
    },
  },
  {
    name: "manifest.json itself a link to the pinned manifest",
    problem: ToolchainProblem.Archive,
    make: async () => {
      const made = await artifact();
      const real = path.join(made.outside, "manifest.json");
      await writeFile(real, await readFile(path.join(made.folder, "manifest.json")));
      await rm(path.join(made.folder, "manifest.json"));
      await symlink(real, path.join(made.folder, "manifest.json"));
      return made;
    },
  },
  {
    name: "an unlisted extra file",
    problem: ToolchainProblem.Archive,
    make: async () => {
      const made = await artifact();
      await writeFile(path.join(made.folder, "include", "extra.h"), "/* not in the manifest */");
      return made;
    },
  },
  {
    name: "a manifest path that climbs out with ../",
    problem: ToolchainProblem.Archive,
    make: async () => {
      const files = { ...ARTIFACT_FILES, "../outside/secret.txt": "GENEX_OUTSIDE_SECRET" };
      return artifact(ARTIFACT_FILES, manifestOf(files)).then((made) => ({
        ...made,
        entry: pinned(manifestOf(files), files),
      }));
    },
  },
  {
    name: "an absolute manifest path",
    problem: ToolchainProblem.Archive,
    make: async () => {
      const made = await artifact();
      const files = { ...ARTIFACT_FILES, [path.join(made.outside, "secret.txt")]: "GENEX_OUTSIDE_SECRET" };
      const manifest = manifestOf(files);
      await writeFile(path.join(made.folder, "manifest.json"), manifest);
      return { ...made, entry: pinned(manifest, files) };
    },
  },
  {
    name: "a FIFO where a listed file should be",
    problem: ToolchainProblem.Archive,
    only: POSIX_ONLY,
    make: async () => {
      const made = await artifact();
      await rm(path.join(made.folder, "libGLESv2.dylib"));
      await execFileAsync("mkfifo", [path.join(made.folder, "libGLESv2.dylib")]);
      return made;
    },
  },
  {
    name: "a FIFO at manifest.json",
    problem: ToolchainProblem.Archive,
    only: POSIX_ONLY,
    make: async () => {
      const made = await artifact();
      await rm(path.join(made.folder, "manifest.json"));
      await execFileAsync("mkfifo", [path.join(made.folder, "manifest.json")]);
      return made;
    },
  },
];
describe("installing a local artifact (the developer's store)", () => {
  it("verifies every listed file and copies them, never links, into <id>/<version>-<sha12> with a local-artifact receipt", async () => {
    const { store, folder, entry } = await artifact();
    const installed = await installLocalArtifact(store, entry, folder, { now: () => Date.UTC(2026, 9, 1) });
    const sha12 = entrySha12(entry);
    assert.equal(installed, path.join(store, ToolchainId.AngleMac, `c5bf49e78850-${sha12}`));
    for (const [rel, text] of Object.entries(ARTIFACT_FILES)) {
      const copied = path.join(installed, rel);
      const info = await lstat(copied);
      assert.ok(info.isFile(), `${rel} is a regular file`);
      assert.notEqual(info.ino, (await lstat(path.join(folder, rel))).ino, `${rel} is a copy, not a hard link`);
      assert.equal(await readFile(copied, "utf8"), text);
    }
    assert.equal(
      (await lstat(path.join(installed, "libEGL.dylib"))).mode & 0o111,
      0o111,
      "a library keeps its execute bits",
    );
    assert.equal(
      sha256(await readFile(path.join(installed, "manifest.json"))),
      entry.local?.manifestSha256,
      "the pinned manifest comes along",
    );
    const receipt = JSON.parse(await readFile(path.join(installed, "receipt.json"), "utf8")) as ToolchainReceipt;
    assert.deepEqual(receipt, {
      id: ToolchainId.AngleMac,
      version: "c5bf49e78850",
      sha256: entry.local?.manifestSha256,
      sha12,
      bytes: entry.local?.bytes,
      host: null,
      target: BuildTarget.Mac,
      source: ReceiptSource.LocalArtifact,
      installedAt: new Date(Date.UTC(2026, 9, 1)).toISOString(),
    });
    assert.deepEqual(
      (await readReceipts(store)).map((item) => item.id),
      [ToolchainId.AngleMac],
    );
    assert.equal(existsSync(path.join(store, ".staging")), false);
    const again = await snapshot(store);
    assert.equal(await installLocalArtifact(store, entry, folder), installed, "a second install finds it there");
    assert.deepEqual(await snapshot(store), again, "and writes nothing");
  });

  for (const row of HOSTILE) {
    it(`refuses ${row.name}, leaving nothing in the store or .staging`, row.only ?? {}, async () => {
      const made = await row.make();
      const before = await snapshot(made.store);
      const outsideBefore = await snapshot(made.outside);
      await assert.rejects(
        () => installLocalArtifact(made.store, made.entry, made.folder),
        (error: unknown) => error instanceof ToolchainError && error.problem === row.problem,
      );
      assert.deepEqual(await snapshot(made.store), before, "the store is byte-identical");
      assert.equal(existsSync(path.join(made.store, ".staging")), false, "no staging is left");
      assert.deepEqual(await snapshot(made.outside), outsideBefore, "nothing outside was touched");
    });
  }

  it("refuses an entry that is not pinned as a local artifact", async () => {
    const { store, folder } = await artifact();
    const before = await snapshot(store);
    const ninja = manifestEntry(ToolchainId.Ninja, ToolchainHost.MacArm64);
    assert.ok(ninja);
    await assert.rejects(
      () => installLocalArtifact(store, ninja, folder),
      (error: unknown) => error instanceof ToolchainError && error.problem === ToolchainProblem.Unpinned,
    );
    assert.deepEqual(await snapshot(store), before);
  });
});

describe("installing components that need a local artifact the app does not bundle", () => {
  it("refuses the job with not-hosted before any fetch, and the store is unchanged", async () => {
    const { store, entry: angle } = await artifact();
    const before = await snapshot(store);
    const calls: string[] = [];
    const ninja = manifestEntry(ToolchainId.Ninja, ToolchainHost.MacArm64);
    assert.ok(angle.local && ninja);
    const job = await installComponents(store, [ninja, angle], {
      fetch: async (url) => {
        calls.push(url);
        return new Response(null, { status: 404 });
      },
      run: async (request) => ok(request),
      freeBytes: async () => 1024 ** 4,
      onJob: () => {},
    });
    assert.equal(job.phase, ToolchainInstallPhase.Failed);
    assert.equal(job.problem, ToolchainProblem.NotHosted);
    assert.deepEqual(calls, [], "the fetch spy was never called");
    assert.deepEqual(await snapshot(store), before);
  });
});
