/**
 * The C++ · raylib starter project (`src/game-template-cpp/`): what ships in resources, the four
 * build lines the host's `genex.cmake` expects, the FACET WIRING block the harness union-merges,
 * the web shell's `window.__studio`, and the syntax checks of the raylib-including sources
 * against the real raylib 6.0 and ANGLE headers, as window, headless and web builds, with the
 * headless raylib platform inside raylib's own `rcore.c` (`scripts/toolchains/compile-check.sh`).
 *
 * The syntax checks need the developer's toolchains (`tests/helpers/dev-toolchains.ts`): they are
 * skipped where the toolchains are absent and required under `GENEX_REQUIRE_TOOLCHAINS=1`.
 */
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import vm from "node:vm";
import { verifyWiringMerge, WIRING_END, WIRING_START } from "../../src/harness-seed/loop/merge.ts";
import { MINUTE_MS } from "../../src/shared/duration.ts";
import { DEV_TOOLCHAINS, devTool, needsTools } from "../helpers/dev-toolchains.ts";
import { makeResources } from "../helpers/resources.ts";
import { tmpDir } from "../helpers/tmp.ts";

const execFileAsync = promisify(execFile);
const REPO = fileURLToPath(new URL("../..", import.meta.url));
const TEMPLATE = path.join(REPO, "src", "game-template-cpp");
const COMPILE_CHECK = path.join(REPO, "scripts", "toolchains", "compile-check.sh");
const CHECK_TIMEOUT_MS = 5 * MINUTE_MS;
const template = (rel: string) => readFileSync(path.join(TEMPLATE, rel), "utf8");
const lines = (text: string) => text.split("\n").filter((line) => line.trim() !== "");

/** The Command Line Tools probe that answers without ever showing Apple's installer. */
const XCODE_SELECT = "/usr/bin/xcode-select";
const UBUNTU_IMAGE = "ubuntu:24.04";

/** Run one mode of the compile check, with a scratch dir of its own unless `env` names one. */
async function compileCheck(mode: string, env: NodeJS.ProcessEnv = {}): Promise<{ stdout: string; stderr: string }> {
  const scratch = await tmpDir(`compile-check-${mode}-`);
  return execFileAsync("/bin/sh", [COMPILE_CHECK, mode], {
    cwd: REPO,
    env: { ...process.env, GENEX_DEV_TOOLCHAINS: DEV_TOOLCHAINS, GENEX_COMPILE_CHECK_SCRATCH: scratch, ...env },
    timeout: CHECK_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
}

/** Whether a Mac's Command Line Tools are installed, asked the one way that never prompts. */
function commandLineTools(): boolean {
  return spawnSync(XCODE_SELECT, ["-p"], { stdio: "ignore" }).status === 0;
}

/** Whether the local Docker holds the Linux image the check runs in (it is never pulled). */
function ubuntuImage(): boolean {
  return spawnSync("docker", ["image", "inspect", UBUNTU_IMAGE], { stdio: "ignore" }).status === 0;
}

describe("the C++ template ships and builds the way the host expects", () => {
  it("makeResources() yields game-template-cpp/ beside game-template/", async () => {
    const resources = await makeResources({ tsc: false });
    for (const rel of ["CMakeLists.txt", "src/main.cpp", "src/studio.h", "web/shell.html", "CLAUDE.md"]) {
      assert.ok(existsSync(path.join(resources, "game-template-cpp", rel)), `${rel} ships`);
    }
    assert.ok(existsSync(path.join(resources, "game-template", "index.html")), "the web template still ships");
  });

  it("CMakeLists.txt is exactly the four lines genex.cmake is written for", () => {
    assert.deepEqual(lines(template("CMakeLists.txt")), [
      "cmake_minimum_required(VERSION 3.28)",
      "project(game CXX C)",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a CMake variable reference, not a JS placeholder
      'include("${GENEX_CMAKE}")',
      "genex_add_game(SOURCES src/*.cpp)",
    ]);
  });

  it(".gitignore lists the five build and studio entries, and nothing else", () => {
    assert.deepEqual(lines(template(".gitignore")), ["build/", "CMakeCache.txt", "CMakeFiles/", "dist/", ".studio/"]);
  });

  it("src/frames_wire.h is the frames addon's wire header, byte for byte: game and host read one layout", () => {
    const addon = readFileSync(path.join(REPO, "native", "genex-frames", "include", "gxf_wire.h"));
    assert.ok(readFileSync(path.join(TEMPLATE, "src", "frames_wire.h")).equals(addon));
  });

  it("src/main.cpp carries one FACET WIRING block the seed's union merge accepts", () => {
    const main = template("src/main.cpp");
    const starts = main.split("\n").filter((line) => WIRING_START.test(line));
    const ends = main.split("\n").filter((line) => WIRING_END.test(line));
    assert.equal(starts.length, 1, "one opening marker");
    assert.equal(ends.length, 1, "one closing marker");
    assert.ok(main.indexOf(starts[0] ?? "") < main.indexOf(ends[0] ?? ""), "the block opens before it closes");
    const merged = verifyWiringMerge(main);
    assert.equal(merged.ok, true);
    assert.equal(merged.text, main, "the template's own block has nothing to deduplicate");
  });
});

/** What a fake page holds besides the module's exports. */
interface ShellPageOptions {
  /** Whether the runtime reports itself ready, as `studio::install` does once the first reset ran. */
  ready?: boolean;
  /** Globals the studio's page scripts would have installed (`__studioCapture`, `__studioDraw`). */
  globals?: Record<string, unknown>;
}

/** A fake page for `web/shell.html`'s inline script: the elements, observers and module it touches. */
function shellPage(exports: Record<string, (arg: unknown) => unknown>, options: ShellPageOptions = {}) {
  const calls: Array<{ name: string; arg: unknown }> = [];
  const element = () => ({
    style: {} as Record<string, string>,
    width: 0,
    height: 0,
    hidden: false,
    clientWidth: 400,
    clientHeight: 300,
    listeners: {} as Record<string, () => void>,
    addEventListener(type: string, fn: () => void) {
      this.listeners[type] = fn;
    },
    remove() {
      this.hidden = true;
    },
    focus() {},
    getBoundingClientRect: () => ({ width: 400, height: 300 }),
    toDataURL: () => "data:image/png;base64,AAAA",
  });
  const canvas = element();
  const start = element();
  const page: Record<string, unknown> = {
    devicePixelRatio: 2,
    console: { log() {}, warn() {}, error() {} },
    document: {
      getElementById: (id: string) => ({ canvas, "genex-start": start })[id] ?? null,
      addEventListener() {},
    },
    ResizeObserver: class {
      observe() {}
    },
    JSON,
    Promise,
    ...options.globals,
  };
  page.window = page;
  const context = vm.createContext(page);
  const script = /<script id="genex-shell">([\s\S]*?)<\/script>/.exec(template("web/shell.html"))?.[1] ?? "";
  vm.runInContext(script, context);
  const module = page.Module as Record<string, unknown>;
  // What emcc's glue does: add the exports and `ccall`, then report the runtime ready.
  for (const name of Object.keys(exports)) module[`_${name}`] = () => 0;
  module.ccall = (name: string, _returns: string, _types: string[], args: string[]) => {
    const arg = args.length ? JSON.parse(args[0] ?? "null") : null;
    calls.push({ name, arg });
    const answer = exports[name];
    return JSON.stringify(answer ? { ok: true, result: answer(arg) } : { ok: false, error: "absent" });
  };
  (module.onRuntimeInitialized as () => void)();
  if (options.ready !== false) (module.genexReady as (() => void) | undefined)?.();
  const studio = () => page.__studio as Record<string, (...args: unknown[]) => unknown> | undefined;
  return { studio: studio(), current: studio, module, calls, canvas };
}

describe("web/shell.html builds window.__studio from the module's exports", () => {
  it("assigns nothing for a module with no studio exports, so a plain C program still loads", () => {
    const { studio, calls } = shellPage({});
    assert.equal(studio, undefined);
    assert.deepEqual(calls, []);
  });

  it("binds exactly the verbs whose exports exist, and passes their arguments as JSON", async () => {
    const { studio, calls } = shellPage({
      studio_seed: (arg) => ({ seed: (arg as { seed: number }).seed, paused: true }),
      studio_step: () => ({ frame: 6, simulatedMs: 100, steppedFrames: 6, drawCalls: 3 }),
      studio_state: () => ({ frame: 6, seed: 5 }),
    });
    assert.ok(studio);
    assert.deepEqual(Object.keys(studio).sort(), ["player", "seed", "state", "step", "version"]);
    assert.equal(studio.seed?.(5), 5);
    assert.deepEqual(studio.step?.(100), { frame: 6, simulatedMs: 100, steppedFrames: 6, drawCalls: 3 });
    assert.deepEqual(studio.state?.(), { frame: 6, seed: 5 });
    assert.deepEqual(calls, [
      { name: "studio_seed", arg: { seed: 5 } },
      { name: "studio_step", arg: { ms: 100 } },
      { name: "studio_state", arg: {} },
    ]);
  });

  it("binds nothing until the runtime reports it is ready, after the first reset read the save folder", () => {
    const { studio, current, module } = shellPage({ studio_state: () => ({ frame: 0 }) }, { ready: false });
    assert.equal(studio, undefined);
    (module.genexReady as () => void)();
    assert.deepEqual(Object.keys(current() ?? {}).sort(), ["player", "state", "version"]);
  });

  it("captures the frame the export just drew, as a PNG data URL", async () => {
    const { studio, calls } = shellPage({ studio_capture: () => ({ width: 800, height: 450 }) });
    assert.equal(await studio?.capture?.(), "data:image/png;base64,AAAA");
    assert.deepEqual(calls, [{ name: "studio_capture", arg: {} }]);
  });

  it("hands the frame to the studio's capture shim with the page's own draw count, and returns what it painted", async () => {
    let draws = 10;
    const painted: unknown[][] = [];
    const { studio } = shellPage(
      {
        studio_capture: () => {
          draws += 3; // the export drew the world, the HUD and the present
          return { width: 800, height: 450, drawCalls: 1 };
        },
      },
      {
        globals: {
          __studioDraw: { totals: () => ({ drawCalls: draws }) },
          __studioCapture: {
            paint: (url: unknown, record: unknown) => {
              painted.push([url, record]);
              return Promise.resolve("data:image/png;base64,PAINTED");
            },
          },
        },
      },
    );
    assert.equal(await studio?.capture?.("overview"), "data:image/png;base64,PAINTED");
    assert.deepEqual(JSON.parse(JSON.stringify(painted)), [
      ["data:image/png;base64,AAAA", { reason: null, drawCalls: 3, ladder: ["render"] }],
    ]);
  });

  it("an older shim only takes note; one that paints nothing gets the picture as it was taken", async () => {
    const noted: unknown[] = [];
    const capture = { studio_capture: () => ({ width: 800, height: 450, drawCalls: 2 }) };
    const older = shellPage(capture, { globals: { __studioCapture: { note: (patch: unknown) => noted.push(patch) } } });
    assert.equal(await older.studio?.capture?.(), "data:image/png;base64,AAAA");
    assert.deepEqual(JSON.parse(JSON.stringify(noted)), [
      { reason: null, drawCalls: 2, ladder: ["render"], composited: false },
    ]);
    const blank = shellPage(capture, { globals: { __studioCapture: { paint: () => Promise.resolve(null) } } });
    assert.equal(await blank.studio?.capture?.(), "data:image/png;base64,AAAA");
    const broken = shellPage(capture, {
      globals: {
        __studioCapture: {
          paint: () => {
            throw new Error("no canvas");
          },
        },
      },
    });
    assert.equal(await broken.studio?.capture?.(), "data:image/png;base64,AAAA");
  });

  it("translates injectInput's page shape into the input op and back", () => {
    const { studio, calls } = shellPage({ studio_input: () => ({ held: ["KeyW"] }) });
    const answer = studio?.injectInput?.({ down: ["KeyW"], look: { dx: 3, dy: -2 }, wheel: { dy: 1 } });
    assert.deepEqual(calls, [
      { name: "studio_input", arg: { down: ["KeyW"], up: [], look: { x: 3, y: -2 }, wheel: { x: 0, y: 1 } } },
    ]);
    // Built inside the page's realm: compared as JSON, as the harness receives it.
    assert.deepEqual(JSON.parse(JSON.stringify(answer)), {
      keys: ["KeyW"],
      look: { x: 3, y: -2 },
      wheel: { x: 0, y: 1 },
    });
  });
});

describe("the raylib-including sources compile against raylib 6.0", () => {
  const onMac = process.platform === "darwin";
  const macCheck = () => {
    if (!onMac) return { skip: "not run: the mac syntax check runs on a Mac" };
    if (!commandLineTools()) return { skip: "not run: the Command Line Tools are not installed" };
    return needsTools("raylib", "angleMac", "emsdk", "emscriptenCache");
  };
  it(
    "mac: clang++ -fsyntax-only of every source as a window and a GENEX_HEADLESS build with ANGLE's EGL headers, and for PLATFORM_WEB with emsdk's clang; the headless platform inside a build-tree rcore.c",
    macCheck(),
    async () => {
      await compileCheck("mac");
    },
  );
  it(
    "zig-cross: zig c++ compiles every source for x86_64-windows-gnu and x86_64-linux-gnu with that target's ANGLE headers",
    needsTools("raylib", "zig", "angleWindows", "angleLinux"),
    async () => {
      await compileCheck("zig-cross");
    },
  );
});

describe("the Windows studio transport (transport.cpp's named pipe)", () => {
  const SOURCES = path.join(TEMPLATE, "src");
  const STRICT = ["-std=c++20", "-Wall", "-Wextra", "-Werror"];

  /** transport.cpp compiled by zig for x86_64-windows-gnu into `dir` (zig 0.16's -fsyntax-only fails, so to an object). */
  async function windowsObject(zig: string, dir: string): Promise<string> {
    const object = path.join(dir, "transport.o");
    const env = {
      ...process.env,
      ZIG_GLOBAL_CACHE_DIR: path.join(dir, "zig-global-cache"),
      ZIG_LOCAL_CACHE_DIR: path.join(dir, "zig-local-cache"),
    };
    const source = path.join(SOURCES, "transport.cpp");
    await execFileAsync(
      zig,
      ["c++", "-target", "x86_64-windows-gnu", ...STRICT, "-c", `-I${SOURCES}`, source, "-o", object],
      {
        env,
        timeout: CHECK_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    return object;
  }

  it("compiles warning-free for x86_64-windows-gnu with zig", needsTools("zig"), async () => {
    const zig = devTool("zig");
    if ("skip" in zig) return;
    const object = await windowsObject(zig.path, await tmpDir("transport-win-"));
    assert.ok(existsSync(object));
  });

  it("opens the pipe overlapped and never reaches for a POSIX descriptor", needsTools("zig", "llvmMingw"), async () => {
    const zig = devTool("zig");
    const mingw = devTool("llvmMingw");
    if ("skip" in zig || "skip" in mingw) return;
    const object = await windowsObject(zig.path, await tmpDir("transport-win-"));
    const { stdout } = await execFileAsync(path.join(mingw.path, "bin", "llvm-nm"), ["-u", object]);
    const undefinedSymbols = new Set(stdout.split("\n").map((line) => line.trim().replace(/^U\s+/, "")));
    for (const api of ["CreateFileW", "ReadFile", "WriteFile", "CancelIoEx", "WaitForMultipleObjects", "SetEvent"]) {
      assert.ok(undefinedSymbols.has(`__imp_${api}`), `imports ${api}`);
    }
    for (const posix of ["poll", "pipe", "fcntl"]) assert.equal(undefinedSymbols.has(posix), false, posix);
  });
});

describe("compile-check.sh touches nothing it did not create", () => {
  it(
    "mac: a /usr/bin compiler without the Command Line Tools is not run, so Apple's installer never opens",
    process.platform === "darwin" ? {} : { skip: "not run: the Command Line Tools shim exists only on a Mac" },
    async () => {
      const dir = await tmpDir("compile-check-clt-");
      const probe = path.join(dir, "xcode-select");
      writeFileSync(probe, "#!/bin/sh\nexit 2\n");
      chmodSync(probe, 0o755);
      const scratch = path.join(dir, "scratch");
      mkdirSync(scratch);
      await assert.rejects(
        compileCheck("mac", {
          GENEX_COMPILE_CHECK_CXX: "/usr/bin/clang++",
          GENEX_COMPILE_CHECK_XCODE_SELECT: probe,
          GENEX_COMPILE_CHECK_SCRATCH: scratch,
        }),
        (error: { stderr?: string; stdout?: string }) => {
          assert.match(error.stderr ?? "", /not run: .*Command Line Tools/);
          assert.doesNotMatch(error.stdout ?? "", /PLATFORM_/, "nothing was compiled");
          return true;
        },
      );
      assert.deepEqual(readdirSync(scratch), [], "the script left nothing in the scratch folder");
    },
  );

  it(
    "linux-docker: a caller's scratch folder keeps everything it held, even when the check fails",
    ubuntuImage() ? {} : { skip: `not run: docker or the ${UBUNTU_IMAGE} image absent (it is never pulled)` },
    async () => {
      const dir = await tmpDir("compile-check-scratch-");
      const toolchains = path.join(dir, "toolchains");
      mkdirSync(path.join(toolchains, "downloads"), { recursive: true });
      // Not an archive: the check fails at unpacking, after it chose where to unpack.
      writeFileSync(path.join(toolchains, "downloads", "zig-x86_64-linux-0.16.0.tar.xz"), "not an archive");
      const scratch = path.join(dir, "scratch");
      for (const kept of ["zig", "bin"]) {
        mkdirSync(path.join(scratch, kept), { recursive: true });
        writeFileSync(path.join(scratch, kept, "keep"), "the caller's");
      }
      await assert.rejects(
        compileCheck("linux-docker", { GENEX_DEV_TOOLCHAINS: toolchains, GENEX_COMPILE_CHECK_SCRATCH: scratch }),
      );
      assert.deepEqual(readdirSync(scratch).sort(), ["bin", "zig"]);
      for (const kept of ["zig", "bin"]) {
        assert.equal(readFileSync(path.join(scratch, kept, "keep"), "utf8"), "the caller's");
      }
    },
  );
});
