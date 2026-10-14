/**
 * The C++ template's raylib-free runtime (`src/game-template-cpp/src/{json,protocol,input,clock,
 * session,paths}.cpp`, `rng.h`, `digest.h`): compiled with this machine's C++ compiler, linked
 * into the `tests/cpp/*_test.cpp` binaries and run one row at a time.
 *
 * The native studio connection on top of them: `transport.cpp` in its own rows over socket pairs,
 * and the whole runtime (every template source but `main.cpp`) built over
 * `tests/cpp/raylib_stub.h` into a stub game the runner drives over fd 3 exactly as the host
 * drives a real one, checking each reply with the host's own `isNativeResult` and each capture
 * with the host's own `fnv1a64Hex`. The stub builds get what every native lane defines
 * (`GENEX_AUDIO_RATE_HZ`, ANGLE's EGL headers); a build without either must not compile.
 *
 * The compiler is the first of `$CXX`, `c++`, `clang++` and `g++` on `PATH`; no Xcode, no store
 * and no raylib are needed, so the Linux `check` job runs every row with g++. The file skips only
 * when no compiler exists. On a Mac a `/usr/bin` compiler is a Command Line Tools shim that opens
 * Apple's installer dialog when the tools are missing, so it counts only when `xcode-select -p`
 * (which never prompts) finds them.
 */
import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { MINUTE_MS, SECOND_MS } from "../../src/shared/duration.ts";
import {
  isNativeResult,
  NATIVE_CAPTURE_FORMAT,
  NATIVE_PROTOCOL_V1,
  NativeBackend,
  NativeEnv,
  NativeEvent,
  type NativeEventMessage,
  NativeOp,
  type NativeOpResults,
  parseNativeEvent,
} from "../../src/shared/native-contract.ts";
import { fnv1a64Hex } from "../../src/substrate/native-game-port.ts";
import { tmpDir } from "../helpers/tmp.ts";

const execFileAsync = promisify(execFile);
const REPO = fileURLToPath(new URL("../..", import.meta.url));
const UNITS_DIR = path.join(REPO, "src", "game-template-cpp", "src");
const TESTS_DIR = path.join(REPO, "tests", "cpp");
/** The translation units every test binary links; the header-only `rng.h` and `digest.h` come with them. */
const UNITS = ["json", "protocol", "input", "clock", "session", "paths"] as const;
const TEST_BINARIES = ["json", "protocol", "input", "clock", "session", "paths", "digest", "frames"] as const;
/** `paths_test` built a second time as a host build names a game: genex.cmake defines both. */
const NAMED_BUILD = ['-DGENEX_GAME_NAME="Pong"', '-DGENEX_BUNDLE_ID="games.genex.game.0123456789ab"'];
const NAMED_PATHS = "paths_named";
type TestBinary = (typeof TEST_BINARIES)[number] | typeof NAMED_PATHS;
/** Threads need `-pthread` with g++ and an older glibc; a Mac's toolchain links them anyway. */
const THREAD_FLAGS = process.platform === "darwin" ? [] : ["-pthread"];
const FLAGS = ["-std=c++20", "-O1", "-Wall", "-Wextra", "-UNDEBUG", ...THREAD_FLAGS, `-I${UNITS_DIR}`];
const COMPILE_TIMEOUT_MS = 2 * MINUTE_MS;
const ROW_TIMEOUT_MS = 30 * SECOND_MS;
const CANDIDATES = ["c++", "clang++", "g++"] as const;
/** The Command Line Tools probe that answers without ever showing the installer. */
const XCODE_SELECT = "/usr/bin/xcode-select";

/** `file` when it is an executable file, else null. */
function executable(file: string): string | null {
  try {
    accessSync(file, constants.X_OK);
    return file;
  } catch {
    return null;
  }
}

/** Where `name` resolves on `PATH` (an absolute `name` stands for itself). */
function onPath(name: string, env: NodeJS.ProcessEnv): string | null {
  if (path.isAbsolute(name)) return executable(name);
  const suffixes = process.platform === "win32" ? [".exe", ""] : [""];
  for (const dir of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const suffix of suffixes) {
      const found = executable(path.join(dir, name + suffix));
      if (found) return found;
    }
  }
  return null;
}

/** A Mac's `/usr/bin` compilers are shims that need the Command Line Tools; everything else just runs. */
function usable(compiler: string): boolean {
  const shim = process.platform === "darwin" && compiler.startsWith("/usr/bin/");
  return !shim || spawnSync(XCODE_SELECT, ["-p"], { stdio: "ignore" }).status === 0;
}

/** The first usable compiler of `$CXX`, `c++`, `clang++`, `g++`, or null. */
function cppCompiler(env: NodeJS.ProcessEnv = process.env): string | null {
  const names = [env.CXX, ...CANDIDATES].filter((name): name is string => Boolean(name));
  for (const name of names) {
    const found = onPath(name, env);
    if (found && usable(found)) return found;
  }
  return null;
}

/** Compile the units once, then link every test binary against them, into `dir`. */
async function buildTests(compiler: string, dir: string): Promise<void> {
  const objects = path.join(dir, "obj");
  await mkdir(objects, { recursive: true });
  const compile = (args: string[]) => execFileAsync(compiler, [...FLAGS, ...args], { timeout: COMPILE_TIMEOUT_MS });
  await Promise.all(
    UNITS.map((unit) => compile(["-c", path.join(UNITS_DIR, `${unit}.cpp`), "-o", path.join(objects, `${unit}.o`)])),
  );
  const linked = UNITS.map((unit) => path.join(objects, `${unit}.o`));
  await Promise.all([
    ...TEST_BINARIES.map((test) =>
      compile([path.join(TESTS_DIR, `${test}_test.cpp`), ...linked, "-o", path.join(dir, `${test}_test`)]),
    ),
    compile([
      ...NAMED_BUILD,
      path.join(TESTS_DIR, "paths_test.cpp"),
      path.join(UNITS_DIR, "paths.cpp"),
      "-o",
      path.join(dir, `${NAMED_PATHS}_test`),
    ]),
  ]);
}

const compiler = cppCompiler();
const skip = compiler === null ? "not run: no C++ compiler ($CXX, c++, clang++ or g++) on PATH" : false;
/** Where the suite's `before` built the test binaries. */
let bin = "";

/** Run one row of one test binary in `cwd` and return what it printed; it passes when the binary exits 0 and says so. */
async function output(test: TestBinary, name: string, cwd = bin): Promise<string> {
  const { stdout } = await execFileAsync(path.join(bin, `${test}_test`), [name], {
    cwd,
    env: { PATH: process.env.PATH ?? "" },
    timeout: ROW_TIMEOUT_MS,
  });
  assert.match(stdout, new RegExp(`^ok ${name}$`, "m"));
  return stdout;
}

/** Run one row of one test binary in `cwd`. */
async function row(test: TestBinary, name: string, cwd = bin): Promise<void> {
  await output(test, name, cwd);
}

describe("the C++ template's raylib-free runtime units", { skip }, () => {
  before(async () => {
    bin = await tmpDir("cpp-runtime-");
    await buildTests(compiler ?? "", bin);
  });

  describe("protocol: NDJSON framing and the request envelope", () => {
    it("frames lines across reads, strips CR, skips blank lines and keeps a last line without a newline", () =>
      row("protocol", "framing"));
    it("drops a line past the 1 MiB cap up to its newline and keeps reading; exactly 1 MiB passes", () =>
      row("protocol", "cap"));
    it("refuses an array, a string, a number, null, true and bad JSON as not-an-object/bad-json", () =>
      row("protocol", "non-object"));
    it("refuses a request whose id is absent, null, a boolean or an object with missing-id", () =>
      row("protocol", "missing-id"));
    it("answers an unknown or absent op with unknown-op and the sorted `available` ops", () =>
      row("protocol", "unknown-op"));
    it("accepts nesting depth 32 and refuses depth 33 as too-deep", () => row("protocol", "depth"));
    it("answers {id, ok, op, result} or {id, ok:false, op, error} and writes events as {event, …}", () =>
      row("protocol", "replies"));
  });

  describe("json: the template's own reader and writer", () => {
    for (const name of ["round-trip", "numbers", "strings", "depth-limit", "syntax-errors", "building"]) {
      it(name, () => row("json", name));
    }
  });

  describe("session: seed, step and the per-tick input merge", () => {
    it("step(ms) runs max(1, round(ms / fixedStepMs)) ticks", async () => {
      await row("session", "step-rounding");
      await row("clock", "step-rounding");
    });
    it("injected input edges and look fire on the first tick of a step only", async () => {
      await row("session", "edges-first-tick-of-step");
      await row("input", "edges-first-tick");
      await row("input", "tap");
      await row("input", "deltas");
    });
    it("real input sampled once per frame applies its edges on the frame's first tick", () =>
      row("input", "real-edges"));
    it("real look counts only while the pointer is locked, and an injected look echoing back counts once", async () => {
      await row("input", "lock-gates-look");
      await row("input", "look-echoes");
    });
    it("an injected pointer position stands until the real mouse moves", () => row("input", "injected-pointer"));
    it("seed(n) resets the world, pauses, clears held input and marks exactly one render", () =>
      row("session", "seed-resets"));
    it("live frames tick only while running", () => row("session", "live-frames"));
    it("gamepad state and committed text reach the merged tick input", async () => {
      await row("session", "pads-and-text");
      await row("input", "pads");
      await row("input", "triggers");
      await row("input", "text");
    });
    it("reads `input` arguments in both shapes and drops hostile values", async () => {
      await row("input", "canonical-keys");
      await row("input", "parse-injection");
      await row("input", "hostile-injection");
    });
    it("the checksum covers the simulation and not the volatile fps", () => row("session", "snapshot-checksum"));
    it("PCG32 reproduces the reference sequence and stays in bounds", () => row("session", "pcg32"));
  });

  describe("clock", () => {
    it("clamps a frame to 250 ms", () => row("clock", "clamp"));
    it("carries the remainder between frames", () => row("clock", "accumulates"));
    it("treats NaN and negative frames as no time and infinity as the clamp", () => row("clock", "hostile-frames"));
    it("measures fps over the last live frames only, ignoring a clock that stalls", () => row("clock", "fps-meter"));
  });

  describe("digest", () => {
    it("matches the published FNV-1a 64 vectors and chains", async () => {
      await row("digest", "known");
      await row("digest", "chained");
    });
    it("matches the host's own FNV-1a 64 of a known buffer", async () => {
      const bytes = Uint8Array.from({ length: 4096 }, (_, i) => (i * 31 + 7) % 256);
      const stdout = await output("digest", "print");
      assert.match(stdout, new RegExp(`^digest ${fnv1a64Hex(bytes)}$`, "m"));
    });
  });

  describe("frames: the embedded run's ring (frames.h over a recording seam)", () => {
    it("a sent slot is the host's until released; a full ring skips the frame, never bursts, and seq keeps rising", async () => {
      for (const name of ["free-to-held", "full-ring-skips", "send-not-taken", "draw-failed"]) {
        await row("frames", name);
      }
    });
    it("sends at most one frame per minimum interval, whatever draws between frames", () => row("frames", "too-soon"));
    it("release frees only the current generation's slot; a stale one is ignored; a new generation frees all", async () => {
      for (const name of ["release-current-generation-only", "stale-release-ignored", "new-generation-frees-all"]) {
        await row("frames", name);
      }
    });
    it("refuses hostile surface and release arguments and an old generation, and makes no ring", async () => {
      for (const name of ["hostile-surface", "hostile-release", "stale-generation"]) await row("frames", name);
    });
    it("answers no service or a failed surface, drops the ring when the host is gone, and on close", async () => {
      for (const name of ["no-service", "host-gone", "close-drops"]) await row("frames", name);
    });
    it("letterboxes the screen into the ring and reads Live's pixel positions as fractions of the frame", async () => {
      await row("frames", "fits-the-screen");
      await row("frames", "input-in-ring-pixels");
    });
  });

  describe("paths: save roots per destination from an injected environment", () => {
    it("Genex run state/, Mac Application Support/<bundleId>, %APPDATA%, XDG or ~/.local/share, web IDBFS", async () => {
      for (const name of ["genex-run", "mac", "windows", "linux", "web"]) await row("paths", name);
    });
    it("refuses or falls back on hostile env and names, and creates nothing", async () => {
      const cwd = await tmpDir("cpp-paths-");
      for (const name of ["hostile-env", "hostile-names", "asset-paths"]) await row("paths", name, cwd);
      assert.deepEqual(readdirSync(cwd), []);
    });
    it("saves under the identity the build names, and nowhere outside Genex and the browser without one", async () => {
      assert.match(await output("paths", "build-identity"), /^identity \|$/m);
      assert.match(await output(NAMED_PATHS, "build-identity"), /^identity Pong\|games\.genex\.game\.0123456789ab$/m);
    });
    it("claims the files raylib reported loading, never a failure or a save", () => row("paths", "log-claims"));
    it("asset claims normalize contained native, bundle, Windows and web paths without hiding other files", () =>
      row("paths", "asset-claims"));
    it("puts captures only under an absolute state root, never a relative, empty or climbing one", () =>
      row("paths", "capture-roots"));
    it("a Linux window opens on X11 whenever an X server is named; with none (the studio's box) GLFW chooses", () =>
      row("paths", "window-system"));
  });
});

// ── the native studio connection ──────────────────────────────────────────────────────────

/** The nonce the runner hands every stub game, as `spawnGame` does. */
const NONCE = "runner-nonce-0123456789abcdef";
/** The stub game's world (`tests/cpp/capture_test.cpp`): what `ready.size` reports. */
const STUB_WORLD = { width: 96, height: 64 };
/** One 60 Hz frame: the stub raylib's clock advances exactly this much per frame. */
const STUB_FRAME_MS = 1000 / 60;
/** Frames the timing row waits for, so the mean covers measured intervals. */
const TIMED_FRAMES = 3;
/** `capture` scenario: the stub's 3x2 RGBA image (bottom-up) as the game must write it, top-down BGRA. */
const CAPTURE_BGRA = [
  ...[255, 255, 255, 255],
  ...[30, 20, 10, 255],
  // RGBA 200,100,50 at alpha 128, composited over black as the window shows it.
  ...[25, 50, 100, 255],
  ...[0, 0, 255, 255],
  ...[0, 255, 0, 255],
  ...[255, 0, 0, 255],
];
/** The stub's SwiftShader device (`cpu` scenario), as ANGLE's Vulkan device query names it. */
const SWIFTSHADER = "SwiftShader Device (Subzero)";
/** The stub's discrete GPU (`gpu` scenario). */
const DISCRETE_GPU = "Stub Discrete GPU";
/** The text the stub game draws itself; every other text in its frame is the runtime's. */
const GAME_TEXT = "score";
/** The mixer rate every native lane gives raylib and the game alike, as `GENEX_AUDIO_RATE_HZ`. */
const AUDIO_RATE_HZ = 48000;
/** What a native lane defines for every game, as the stub builds get it. */
const LANE_DEFINES = [`-DGENEX_AUDIO_RATE_HZ=${AUDIO_RATE_HZ}`];
/** The stub's `sine` scenario: one full-scale period every 32 frames. */
const SINE_HZ = AUDIO_RATE_HZ / 32;
/** How far a pure sine's centroid may sit from its frequency: a 44.1 kHz rate read as 48 misses by 8 %. */
const CENTROID_TOLERANCE = 0.02;
/** A full-scale sine's rms. */
const SINE_RMS = Math.SQRT1_2;
/** Why `capture` is refused when the run has no usable `state/` (the runtime's wire value). */
const NO_STATE_DIR = "no-state-dir";
/** What `hud` in `state()` names the runtime's CPU-fallback notice. */
const CPU_FALLBACK_NOTICE = "cpu-fallback";
/** What a row allows one exchange with a stub game before it fails rather than hangs. */
const EXCHANGE_TIMEOUT_MS = 10 * SECOND_MS;
const nativeSkip =
  process.platform === "win32" ? "not run: fd 3 is the POSIX transport; Windows games use a named pipe (wave 3)" : skip;

/** Whether `cxx` finds an `EGL/egl.h` of the system's own, which would stand in for ANGLE's. */
function systemEgl(cxx: string): boolean {
  const probe = spawnSync(cxx, ["-x", "c++", "-fsyntax-only", "-"], {
    input: "#include <EGL/egl.h>\n",
    stdio: ["pipe", "ignore", "ignore"],
    timeout: COMPILE_TIMEOUT_MS,
  });
  return probe.status === 0;
}

const eglSkip =
  nativeSkip ||
  (compiler !== null && systemEgl(compiler)
    ? "not run: this compiler finds the system's own EGL/egl.h, so no build here lacks EGL headers"
    : false);

/** One line a stub game sent on fd 3. */
type Line = Record<string, unknown>;
/** How a stub game ended. */
interface GameExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

const isRecord = (value: unknown): value is Line =>
  typeof value === "object" && value !== null && !Array.isArray(value);
/** Node hands the fourth stdio slot over as a socket: one duplex stream, as the game sees it. */
const isDuplex = (value: unknown): value is Duplex => value instanceof Socket;

/** Where the native build put its binaries. */
let nativeBin = "";

/** The stub include folder: `raylib.h`, `EGL/egl.h` and `EGL/eglext.h` all name `tests/cpp/raylib_stub.h`. */
async function stubIncludes(dir: string): Promise<string> {
  const include = path.join(dir, "stub-include");
  await mkdir(path.join(include, "EGL"), { recursive: true });
  const forward = `#include "${path.join(TESTS_DIR, "raylib_stub.h")}"\n`;
  for (const name of ["raylib.h", "EGL/egl.h", "EGL/eglext.h"]) await writeFile(path.join(include, name), forward);
  return include;
}

/** Why a native binary did not build, by name: a row that needs it fails with its compiler output. */
const buildFailures = new Map<string, string>();

/** The path of a built native binary, or the row fails with why it did not build. */
function nativeBinary(name: string): string {
  const failure = buildFailures.get(name);
  if (failure !== undefined) assert.fail(`${name} did not build:\n${failure}`);
  return path.join(nativeBin, name);
}

/**
 * The rows for what the Windows pipe transport shares with fd 3, as a driver built on this machine:
 * which `GENEX_STUDIO_PIPE` names a run's own pipe, and the framing a channel's bytes go through.
 */
const PIPE_TRANSPORT_DRIVER = String.raw`#include <algorithm>
#include <cassert>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <deque>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "paths.h"
#include "transport.h"

namespace {

using studio::transport::Channel;
using studio::transport::Incoming;
using studio::transport::Transport;

/** A channel handing out scripted chunks, as a pipe delivers them, then the end; it keeps what is written. */
class ScriptedChannel : public Channel {
 public:
  ScriptedChannel(std::deque<std::string> chunks, std::string* written) : chunks_(std::move(chunks)), written_(written) {}
  long read(char* into, std::size_t capacity) override {
    std::lock_guard<std::mutex> lock(mutex_);
    if (chunks_.empty()) return 0;
    std::string& chunk = chunks_.front();
    std::size_t n = std::min(capacity, chunk.size());
    std::memcpy(into, chunk.data(), n);
    chunk.erase(0, n);
    if (chunk.empty()) chunks_.pop_front();
    return static_cast<long>(n);
  }
  bool write(std::string_view bytes) override {
    written_->append(bytes);
    return true;
  }
  void interrupt() override {}

 private:
  std::mutex mutex_;
  std::deque<std::string> chunks_;
  std::string* written_;
};

studio::paths::Env envOf(std::map<std::string, std::string> vars) {
  return [vars](std::string_view name) -> std::optional<std::string> {
    auto found = vars.find(std::string(name));
    if (found == vars.end()) return std::nullopt;
    return found->second;
  };
}

std::string pipeOf(const std::string& value) {
  return studio::transport::studioPipeName(envOf({{"GENEX_STUDIO_PIPE", value}}));
}

void names() {
  const std::string prefix = "\\\\.\\pipe\\genex-game-";
  for (const std::string id : {"0123456789ab", "0123456789abcdef0123456789abcdef"}) assert(pipeOf(prefix + id) == prefix + id);
  const std::vector<std::string> refused = {
      "", prefix, prefix + "0123456789a", prefix + "0123456789abcdef0123456789abcdef0", prefix + "0123456789AB",
      prefix + "0123456789ab\\x", prefix + "../0123456789ab", "\\\\.\\pipe\\other-0123456789ab",
      "//./pipe/genex-game-0123456789ab", "genex-game-0123456789ab", "\\\\server\\pipe\\genex-game-0123456789ab",
  };
  for (const std::string& value : refused) assert(pipeOf(value).empty());
  assert(studio::transport::studioPipeName(envOf({})).empty());
  assert(studio::transport::studioPipeName(nullptr).empty());
}

void framing() {
  std::string written;
  const std::string big(2 * 1024 * 1024, 'x');
  std::deque<std::string> chunks = {"{\"id\":1,", "\"op\":\"state\"}\r\n", big, "\n", "{\"id\":2}\n"};
  Transport link(std::make_unique<ScriptedChannel>(std::move(chunks), &written), "n0nce");
  std::vector<Incoming> seen;
  auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
  while (std::chrono::steady_clock::now() < deadline) {
    link.wait(100);
    for (Incoming& item : link.take()) seen.push_back(std::move(item));
    if (!seen.empty() && seen.back().status == studio::protocol::LineStatus::End) break;
  }
  assert(seen.size() == 4);
  assert(seen[0].status == studio::protocol::LineStatus::Line && seen[0].text == "{\"id\":1,\"op\":\"state\"}");
  assert(seen[1].status == studio::protocol::LineStatus::TooLong);
  assert(seen[2].status == studio::protocol::LineStatus::Line && seen[2].text == "{\"id\":2}");
  assert(seen[3].status == studio::protocol::LineStatus::End);
  assert(link.send("{\"ok\":true}"));
  assert(written == "{\"ok\":true}\n");
}

void posixIgnoresThePipe() {
  // A POSIX game talks over descriptor 3 only: a pipe name and a nonce open nothing.
  const std::string pipe = "\\\\.\\pipe\\genex-game-0123456789ab";
  assert(!studio::transport::fromEnvironment(envOf({{"GENEX_STUDIO_PIPE", pipe}, {"GENEX_STUDIO_NONCE", "n0nce"}})));
  assert(!studio::transport::pipeChannel(pipe));
}

}  // namespace

int main(int argc, char** argv) {
  const std::map<std::string, void (*)()> rows = {{"names", names}, {"framing", framing}, {"posix", posixIgnoresThePipe}};
  for (const auto& [name, run] : rows) {
    if (argc > 1 && name != argv[1]) continue;
    run();
    std::printf("ok %s\n", name.c_str());
  }
  return 0;
}
`;

/** What the starter in `main.cpp` draws with beyond the runtime's own calls, which the stub leaves out. */
const STARTER_SHIM = `#pragma once
#include "STUB"
inline Mesh GenMeshPlane(float, float, int, int) { return Mesh{4, 2}; }
inline void BeginMode3D(Camera3D) {}
inline void EndMode3D() {}
`;

/** The stub's scenario for a whole run of the real `main.cpp`, which takes no arguments: from GENEX_STUB_SCENARIO. */
const STARTER_SCENARIO = `#include <cstdlib>
#include "raylib.h"
namespace {
[[maybe_unused]] const bool configured = [] {
  const char* scenario = std::getenv("GENEX_STUB_SCENARIO");
  stub::configure(scenario ? scenario : "basic");
  return true;
}();
}  // namespace
`;

/** An include folder for the real `main.cpp`: the stub raylib plus the starter's few extra calls. */
async function starterIncludes(dir: string): Promise<{ include: string; scenario: string }> {
  const include = path.join(dir, "starter-include");
  await mkdir(path.join(include, "EGL"), { recursive: true });
  const stub = path.join(TESTS_DIR, "raylib_stub.h");
  await writeFile(path.join(include, "raylib.h"), STARTER_SHIM.replace("STUB", stub));
  for (const name of ["EGL/egl.h", "EGL/eglext.h"]) await writeFile(path.join(include, name), `#include "${stub}"\n`);
  const scenario = path.join(dir, "starter_scenario.cpp");
  await writeFile(scenario, STARTER_SCENARIO);
  return { include, scenario };
}

/** `transport_test`, and the stub game built twice: as a window run and with `GENEX_HEADLESS`. Each builds on its own. */
async function buildNative(compiler: string, dir: string): Promise<void> {
  const include = await stubIncludes(dir);
  const starter = await starterIncludes(dir);
  const pipeDriver = path.join(dir, "pipe_transport_test.cpp");
  await writeFile(pipeDriver, PIPE_TRANSPORT_DRIVER);
  const units = readdirSync(UNITS_DIR).filter((name) => name.endsWith(".cpp") && name !== "main.cpp");
  const sources = units.map((name) => path.join(UNITS_DIR, name));
  const raylibFree = UNITS.map((unit) => path.join(UNITS_DIR, `${unit}.cpp`));
  // A Mac headless build also sends Live's frames: IOSurfaces and the frames service (frames.cpp).
  const link = process.platform === "darwin" ? ["-framework", "CoreFoundation", "-framework", "IOSurface"] : [];
  const game = path.join(TESTS_DIR, "capture_test.cpp");
  const binaries: Record<string, string[]> = {
    transport_test: [path.join(TESTS_DIR, "transport_test.cpp"), path.join(UNITS_DIR, "transport.cpp"), ...raylibFree],
    game_window: [...LANE_DEFINES, game, ...sources, ...link],
    game_headless: [...LANE_DEFINES, "-DGENEX_HEADLESS", game, ...sources, ...link],
    pipe_transport_test: [pipeDriver, path.join(UNITS_DIR, "transport.cpp"), ...raylibFree],
    // The real main.cpp: its include folder comes first, so its raylib.h is the starter's shim.
    main_window: [
      `-I${starter.include}`,
      ...LANE_DEFINES,
      path.join(UNITS_DIR, "main.cpp"),
      starter.scenario,
      ...sources,
      ...link,
    ],
  };
  await Promise.all(
    Object.entries(binaries).map(async ([name, args]) => {
      const includes = name === "main_window" ? [] : [`-I${include}`];
      try {
        await execFileAsync(compiler, [...includes, ...FLAGS, ...args, "-o", path.join(dir, name)], {
          timeout: COMPILE_TIMEOUT_MS,
          maxBuffer: 8 * 1024 * 1024,
        });
      } catch (error) {
        const output = isRecord(error) && typeof error.stderr === "string" ? error.stderr : String(error);
        buildFailures.set(name, output.slice(0, 4000));
      }
    }),
  );
}

/** A stub game the runner drives over fd 3, as the host drives a real one. */
class StubGame {
  readonly lines: Line[] = [];
  readonly state: string;
  readonly exited: Promise<GameExit>;
  #child: ChildProcess;
  #fd3: Duplex;
  #nextId = 1;
  #stderr = "";
  #waiters = new Set<() => void>();
  #exit: GameExit | null = null;

  constructor(binary: string, scenario: string, state: string, env: NodeJS.ProcessEnv, cwd?: string) {
    this.state = state;
    this.#child = spawn(nativeBinary(binary), [scenario], { stdio: ["ignore", "ignore", "pipe", "pipe"], env, cwd });
    const fd3 = this.#child.stdio[3];
    assert.ok(isDuplex(fd3), "fd 3 is a duplex pipe");
    this.#fd3 = fd3;
    this.#child.stderr?.on("data", (chunk: Buffer) => {
      this.#stderr = (this.#stderr + chunk.toString()).slice(-4096);
    });
    createInterface({ input: this.#fd3 }).on("line", (text) => {
      const line: unknown = JSON.parse(text);
      assert.ok(isRecord(line), `a JSON object per line: ${text}`);
      this.lines.push(line);
      for (const wake of this.#waiters) wake();
    });
    this.exited = new Promise((resolve) => {
      this.#child.on("exit", (code, signal) => {
        this.#exit = { code, signal };
        for (const wake of this.#waiters) wake();
        resolve(this.#exit);
      });
    });
  }

  /** The first line (in arrival order) that `match` takes; fails if the game exits without one. */
  next(match: (line: Line) => boolean): Promise<Line> {
    return new Promise((resolve, reject) => {
      const look = () => {
        const found = this.lines.find(match);
        if (found) {
          this.#waiters.delete(look);
          resolve(found);
        } else if (this.#exit) {
          this.#waiters.delete(look);
          reject(new Error(`the game exited (${JSON.stringify(this.#exit)}) first; stderr: ${this.#stderr}`));
        }
      };
      this.#waiters.add(look);
      look();
    });
  }

  /** The game's event of kind `name`, the first one. */
  async event(name: NativeEvent): Promise<NativeEventMessage> {
    const event = parseNativeEvent(await this.next((line) => line.event === name));
    assert.ok(event, `the host accepts the ${name} event`);
    return event;
  }

  /** Every event of kind `name` so far, as the host reads them. */
  events(name: NativeEvent): NativeEventMessage[] {
    return this.lines.filter((line) => line.event === name).map((line) => parseNativeEvent(line) ?? assert.fail(name));
  }

  /** Send one request and wait for its reply. */
  call(op: string, arg?: unknown): Promise<Line> {
    const id = this.#nextId++;
    this.#fd3.write(`${JSON.stringify(arg === undefined ? { id, op } : { id, op, arg })}\n`);
    return this.next((line) => line.id === id);
  }

  /** Send `op` and return its result after the host's own check of it. */
  async result<K extends keyof NativeOpResults>(op: K, arg?: unknown): Promise<NativeOpResults[K]> {
    const reply = await this.call(op, arg);
    assert.equal(reply.ok, true, `${op} answered: ${JSON.stringify(reply)}`);
    assert.ok(isNativeResult(op, reply.result), `the host accepts ${op}'s result: ${JSON.stringify(reply.result)}`);
    return reply.result;
  }

  /** Close the studio's side of fd 3, as a host that stops reading and writing does. */
  hangUp(): void {
    this.#fd3.end();
  }

  /** Make sure the process is gone before the row ends. */
  async stop(): Promise<void> {
    if (!this.#exit) this.#child.kill("SIGKILL");
    await this.exited;
  }
}

const started: StubGame[] = [];

/** How a row starts a stub game other than as a window run with its own fresh `state/`. */
interface StartOptions {
  binary?: string;
  /** What `GENEX_STATE_DIR` holds instead of a fresh folder; null leaves it out. */
  stateDir?: string | null;
  /** The folder the game starts in (the runner's own when absent). */
  cwd?: string;
  /** Variables beside the ones `spawnGame` always passes (the starter's stub scenario, an embedded run's frames service). */
  env?: NodeJS.ProcessEnv;
}

/** Start the stub game on `scenario` with the environment `spawnGame` gives a game. */
async function startGame(scenario: string, options: StartOptions = {}): Promise<StubGame> {
  const state = options.stateDir === undefined ? await tmpDir("cpp-native-state-") : (options.stateDir ?? "");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    [NativeEnv.StudioFd]: "3",
    [NativeEnv.Nonce]: NONCE,
    [NativeEnv.Home]: path.join(options.cwd ?? state, "home"),
    ...options.env,
  };
  if (options.stateDir !== null) env[NativeEnv.StateDir] = state;
  const game = new StubGame(options.binary ?? "game_window", scenario, state, env, options.cwd);
  started.push(game);
  return game;
}

/** A number the stub game's probes report in `state()`. */
async function probe(game: StubGame, name: string): Promise<number> {
  const value = (await game.result(NativeOp.State))[name];
  assert.equal(typeof value, "number", `${name} is a number`);
  return Number(value);
}

/** One text the runtime drew into the last world frame, as the stub saw it. */
interface TextDrawn {
  text: string;
  x: number;
  y: number;
  size: number;
  width: number;
}

const isTextDrawn = (value: unknown): value is TextDrawn =>
  isRecord(value) &&
  typeof value.text === "string" &&
  [value.x, value.y, value.size, value.width].every((field) => typeof field === "number");

/** The texts the runtime drew into the last world frame: everything but the stub game's own. */
function runtimeTexts(state: Record<string, unknown>): TextDrawn[] {
  const texts = Array.isArray(state.texts) ? state.texts : [];
  const drawn = texts.filter(isTextDrawn);
  assert.equal(drawn.length, texts.length, `texts the stub reported: ${JSON.stringify(state.texts)}`);
  return drawn.filter((text) => text.text !== GAME_TEXT);
}

/** Quit and expect the clean exit every host stop starts with. */
async function quit(game: StubGame): Promise<void> {
  assert.deepEqual(await game.result(NativeOp.Quit), { quitting: true });
  assert.deepEqual(await game.exited, { code: 0, signal: null });
}

/** The native binaries build once per file, for whichever describe asks first. */
let nativeBuild: Promise<void> | undefined;
function buildNativeOnce(): Promise<void> {
  nativeBuild ??= (async () => {
    nativeBin = await tmpDir("cpp-native-");
    await buildNative(compiler ?? "", nativeBin);
  })();
  return nativeBuild;
}

/** Stop every stub game a describe started, so no process outlives the file. */
async function stopStarted(): Promise<void> {
  await Promise.all(started.splice(0).map((game) => game.stop()));
}

/** Run one row of `transport_test`. */
async function transportRow(name: string): Promise<void> {
  const { stdout } = await execFileAsync(nativeBinary("transport_test"), [name], {
    env: { PATH: process.env.PATH ?? "" },
    timeout: ROW_TIMEOUT_MS,
  });
  assert.match(stdout, new RegExp(`^ok ${name}$`, "m"));
}

describe("the native studio transport (transport.cpp over socket pairs)", { skip: nativeSkip }, () => {
  before(buildNativeOnce);

  it("is inactive without GENEX_STUDIO_FD = 3 and a nonce, and then never touches fd 3", () =>
    transportRow("inactive"));
  it("answers a 2 MiB line with line-too-long and still answers the next line", () => transportRow("too-long"));
  it("answers requests in order, one whole line each, even from two threads at once", async () => {
    await transportRow("order");
    await transportRow("whole-lines");
  });
  it("reports the studio's EOF after answering everything before it", () => transportRow("eof"));
  it("stops quietly once the studio is gone (EPIPE, never SIGPIPE)", () => transportRow("epipe"));
  it("wakes a waiting frame as soon as a request arrives, and stops its reader at once", async () => {
    await transportRow("wakes");
    await transportRow("stops");
  });
});

/** Whether a failed compile's output carries the template's own `#error` about `missing`. */
function refusedFor(error: unknown, missing: RegExp): boolean {
  const stderr = isRecord(error) && typeof error.stderr === "string" ? error.stderr : "";
  return /Genex: /.test(stderr) && missing.test(stderr);
}

describe("the Windows pipe transport's shared parts, on this machine", { skip: nativeSkip }, () => {
  before(buildNativeOnce);

  /** Run one row of the pipe transport driver. */
  async function pipeRow(name: string): Promise<void> {
    const { stdout } = await execFileAsync(nativeBinary("pipe_transport_test"), [name], {
      env: { PATH: process.env.PATH ?? "" },
      timeout: ROW_TIMEOUT_MS,
    });
    assert.match(stdout, new RegExp(`^ok ${name}$`, "m"));
  }

  it("takes GENEX_STUDIO_PIPE only as a run's own pipe: the genex-game- prefix and 12-32 lowercase hex", () =>
    pipeRow("names"));
  it("frames a channel's chunks as fd 3 does: lines across reads, CR stripped, a 2 MiB line too long, then the end", () =>
    pipeRow("framing"));
  it("on POSIX opens no pipe, even named with a nonce: descriptor 3 is the transport", () => pipeRow("posix"));
});

describe("the starter's own main.cpp over the stub raylib", { skip: nativeSkip }, () => {
  before(buildNativeOnce);
  after(stopStarted);

  it("exits non-zero when its window never opens, run by a person with no studio", async () => {
    const run = execFileAsync(nativeBinary("main_window"), [], {
      env: { PATH: process.env.PATH ?? "", GENEX_STUB_SCENARIO: "nowindow" },
      timeout: ROW_TIMEOUT_MS,
    });
    await assert.rejects(run, (error: unknown) => {
      assert.ok(isRecord(error), String(error));
      assert.notEqual(error.code, 0, "a failed launch never reads as success");
      assert.equal(error.killed, false, "it ended by itself");
      return true;
    });
  });

  it("sends fatal and exits non-zero when its window never opens, run by the studio", {
    timeout: EXCHANGE_TIMEOUT_MS,
  }, async () => {
    const game = await startGame("nowindow", { binary: "main_window", env: { GENEX_STUB_SCENARIO: "nowindow" } });
    await game.event(NativeEvent.Fatal);
    const exit = await game.exited;
    assert.notEqual(exit.code, 0);
    assert.equal(game.events(NativeEvent.Ready).length, 0);
  });
});

describe("a native build the lane did not set up does not compile, and says what is missing", {
  skip: nativeSkip,
}, () => {
  it("without ANGLE's EGL headers, which could only ever report an unknown backend and no CPU notice", {
    skip: eglSkip,
    timeout: COMPILE_TIMEOUT_MS,
  }, async () => {
    const include = await tmpDir("cpp-no-egl-");
    await writeFile(path.join(include, "raylib.h"), `#include "${path.join(TESTS_DIR, "raylib_stub.h")}"\n`);
    const platform = path.join(UNITS_DIR, "platform.cpp");
    await assert.rejects(
      execFileAsync(compiler ?? "", [`-I${include}`, ...FLAGS, ...LANE_DEFINES, "-fsyntax-only", platform], {
        timeout: COMPILE_TIMEOUT_MS,
      }),
      (error) => refusedFor(error, /EGL\/egl\.h/),
    );
  });

  it("without GENEX_AUDIO_RATE_HZ, whose centroid would assume a rate raylib's mixer may not run at", {
    timeout: COMPILE_TIMEOUT_MS,
  }, async () => {
    const include = await stubIncludes(await tmpDir("cpp-no-rate-"));
    const studio = path.join(UNITS_DIR, "studio.cpp");
    await assert.rejects(
      execFileAsync(compiler ?? "", [`-I${include}`, ...FLAGS, "-fsyntax-only", studio], {
        timeout: COMPILE_TIMEOUT_MS,
      }),
      (error) => refusedFor(error, /GENEX_AUDIO_RATE_HZ/),
    );
  });
});

describe("the runtime over the stub raylib, driven over fd 3: ready, captures and the way out", {
  skip: nativeSkip,
}, () => {
  before(buildNativeOnce);
  after(stopStarted);

  it("asset claims stay stable across native run roots while raylib loads each run's real files", {
    timeout: EXCHANGE_TIMEOUT_MS,
  }, async () => {
    const applicationDirs = [
      "/native-runs/run-a/bundle/",
      "/native-runs/run-b/bundle/",
      "/Applications/Fish.app/Contents/MacOS/",
    ];
    for (const application of applicationDirs) {
      const game = await startGame("assets", { env: { GENEX_STUB_APPLICATION_DIR: application } });
      await game.event(NativeEvent.Ready);
      const state = await game.result(NativeOp.State);
      const assets = application.endsWith("Contents/MacOS/") ? "../Resources/assets/" : "assets/";
      assert.deepEqual(
        state.loadedFiles,
        ["water.png", "fish.glb", "audio/bite.wav"].map((file) => `${application}${assets}${file}`),
      );
      assert.deepEqual(state.assets, [
        "/assets/water.png",
        "/assets/fish.glb",
        "/assets/audio/bite.wav",
        "/assets/log-only.png",
        "/outside/asset.png",
      ]);
      await quit(game);
    }
  });

  it("sends ready once, with the nonce, protocol 1, the world size and the seed", {
    timeout: EXCHANGE_TIMEOUT_MS,
  }, async () => {
    const game = await startGame("basic");
    const ready = await game.event(NativeEvent.Ready);
    assert.ok(ready.event === NativeEvent.Ready);
    // A build the lane names no id says what it is: raylib's version, the OS and the mode.
    assert.match(ready.build, /^raylib-6\.0\/(macos|linux)\/window$/);
    assert.deepEqual(ready, {
      event: NativeEvent.Ready,
      nonce: NONCE,
      protocol: NATIVE_PROTOCOL_V1,
      contractVersion: 1,
      build: ready.build,
      // The stub has no EGL display: the backend is unknown, never guessed.
      backend: { api: NativeBackend.Unknown, device: null },
      size: STUB_WORLD,
      seed: 1,
    });
    await quit(game);
    assert.equal(game.events(NativeEvent.Ready).length, 1);
  });

  it("captures top-down BGRA into <state>/captures/<seq>.bgra with the FNV-1a 64 the host recomputes", {
    timeout: EXCHANGE_TIMEOUT_MS,
  }, async () => {
    const game = await startGame("capture");
    await game.event(NativeEvent.Ready);
    const first = await game.result(NativeOp.Capture);
    assert.deepEqual(
      { seq: first.seq, width: first.width, height: first.height, format: first.format },
      { seq: 1, width: 3, height: 2, format: NATIVE_CAPTURE_FORMAT },
    );
    const bytes = readFileSync(path.join(game.state, "captures", "1.bgra"));
    assert.deepEqual([...bytes], CAPTURE_BGRA);
    assert.equal(first.digest, fnv1a64Hex(bytes));
    const second = await game.result(NativeOp.Capture, { camera: "overview" });
    assert.equal(second.seq, 2);
    assert.ok(existsSync(path.join(game.state, "captures", "2.bgra")));
    const unknown = await game.call(NativeOp.Capture, { camera: "nowhere" });
    assert.deepEqual([unknown.ok, unknown.error], [false, "unknown-camera"]);
    await quit(game);
  });

  it("keeps only its last eight capture files: the host never deletes in state/ while the game runs", {
    timeout: 2 * EXCHANGE_TIMEOUT_MS,
  }, async () => {
    const game = await startGame("capture");
    await game.event(NativeEvent.Ready);
    for (let n = 1; n <= 11; n++) assert.equal((await game.result(NativeOp.Capture)).seq, n);
    const kept = (await readdir(path.join(game.state, "captures"))).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
    assert.deepEqual(kept, ["4.bgra", "5.bgra", "6.bgra", "7.bgra", "8.bgra", "9.bgra", "10.bgra", "11.bgra"]);
    await quit(game);
  });

  it("refuses capture with no-state-dir when GENEX_STATE_DIR is absent, empty, relative or climbs, and writes nothing", {
    timeout: 4 * EXCHANGE_TIMEOUT_MS,
  }, async () => {
    const root = await tmpDir("cpp-native-hostile-");
    const cwd = path.join(root, "cwd");
    for (const folder of ["a", "b", "cwd"]) await mkdir(path.join(root, folder));
    // Template strings, not path.join, which would fold the `..` away.
    const hostile: (string | null)[] = [null, "", "state", `${root}/a/../b`, `${root}/a/..`];
    for (const stateDir of hostile) {
      const game = await startGame("capture", { stateDir, cwd });
      await game.event(NativeEvent.Ready);
      const refused = await game.call(NativeOp.Capture);
      assert.deepEqual(
        [refused.ok, refused.error],
        [false, NO_STATE_DIR],
        `GENEX_STATE_DIR ${JSON.stringify(stateDir)}`,
      );
      await game.result(NativeOp.State);
      await quit(game);
    }
    assert.deepEqual((await readdir(root)).sort(), ["a", "b", "cwd"]);
    for (const folder of ["a", "b", "cwd"]) assert.deepEqual(await readdir(path.join(root, folder)), [], folder);
  });

  it("answers quit, then exits 0", { timeout: EXCHANGE_TIMEOUT_MS }, async () => {
    const game = await startGame("basic");
    await game.event(NativeEvent.Ready);
    await quit(game);
  });

  it("exits 0 when the studio closes fd 3", { timeout: EXCHANGE_TIMEOUT_MS }, async () => {
    const game = await startGame("basic");
    await game.event(NativeEvent.Ready);
    game.hangUp();
    assert.deepEqual(await game.exited, { code: 0, signal: null });
  });

  it("sends fatal and exits non-zero when the window cannot open", { timeout: EXCHANGE_TIMEOUT_MS }, async () => {
    const game = await startGame("nowindow");
    const fatal = await game.event(NativeEvent.Fatal);
    assert.equal(fatal.event, NativeEvent.Fatal);
    const exit = await game.exited;
    assert.notEqual(exit.code, 0);
    assert.equal(game.events(NativeEvent.Ready).length, 0);
  });

  it("answers an op it does not serve with unknown-op and the ops a native run serves", {
    timeout: EXCHANGE_TIMEOUT_MS,
  }, async () => {
    const game = await startGame("basic");
    await game.event(NativeEvent.Ready);
    const refused = await game.call(NativeOp.Surface, { w: 1, h: 1, dpr: 1, slots: 3, generation: 1 });
    assert.deepEqual([refused.ok, refused.error], [false, "unknown-op"]);
    const available = Array.isArray(refused.available) ? refused.available : [];
    for (const op of [NativeOp.AudioLevel, NativeOp.Timing, NativeOp.Quit, NativeOp.Front, NativeOp.Visible]) {
      assert.ok(available.includes(op), `${op} is served`);
    }
    await quit(game);
  });
});

describe("the runtime over the stub raylib, driven over fd 3: focus, meters and backend", {
  skip: nativeSkip,
}, () => {
  before(buildNativeOnce);
  after(stopStarted);

  it("sends one focus event per change of the window's focus, the first one included", {
    timeout: EXCHANGE_TIMEOUT_MS,
  }, async () => {
    const game = await startGame("focus");
    await game.event(NativeEvent.Ready);
    // The stub's window is unfocused for two frames, focused for two, then unfocused for good.
    await game.next((line) => line.event === NativeEvent.Focus && line.focused === true);
    await game.next(
      (line) =>
        line.event === NativeEvent.Focus && line.focused === false && game.events(NativeEvent.Focus).length === 3,
    );
    await game.result(NativeOp.State);
    await quit(game);
    const focus = game
      .events(NativeEvent.Focus)
      .map((event) => (event.event === NativeEvent.Focus ? event.focused : null));
    assert.deepEqual(focus, [false, true, false]);
  });

  it("measures the mixed audio: silence is 0, a full-scale square wave is about 1, a sine's centroid is its pitch", {
    timeout: EXCHANGE_TIMEOUT_MS,
  }, async () => {
    const quiet = await startGame("basic");
    await quiet.event(NativeEvent.Ready);
    assert.deepEqual(await quiet.result(NativeOp.AudioLevel), { rms: 0, centroid: 0 });
    await quit(quiet);
    const loud = await startGame("square");
    await loud.event(NativeEvent.Ready);
    const level = await loud.result(NativeOp.AudioLevel);
    assert.ok(Math.abs(level.rms - 1) < 0.001, `rms ${level.rms}`);
    assert.ok(level.centroid > 0, `centroid ${level.centroid}`);
    await quit(loud);
    // A pure tone at the lane's rate: a wrong bin-to-Hz scale or a wrong rate moves the centroid off it.
    const sine = await startGame("sine");
    await sine.event(NativeEvent.Ready);
    const tone = await sine.result(NativeOp.AudioLevel);
    assert.ok(Math.abs(tone.rms - SINE_RMS) < 0.001, `rms ${tone.rms}`);
    assert.ok(Math.abs(tone.centroid - SINE_HZ) <= SINE_HZ * CENTROID_TOLERANCE, `centroid ${tone.centroid} Hz`);
    await quit(sine);
  });

  it("counts frames and times them on the game's own clock", { timeout: EXCHANGE_TIMEOUT_MS }, async () => {
    const game = await startGame("basic");
    await game.event(NativeEvent.Ready);
    // Each request is answered on a later frame than the reply before it, so the count must grow.
    const first = await game.result(NativeOp.Timing);
    let latest = await game.result(NativeOp.Timing);
    assert.ok(latest.frames > first.frames, `${first.frames} then ${latest.frames}`);
    // The first frame has no interval yet; from the second on, each one is exactly the stub's frame.
    for (let asked = 0; asked < TIMED_FRAMES && latest.frames < TIMED_FRAMES; asked++) {
      latest = await game.result(NativeOp.Timing);
    }
    assert.ok(latest.frames >= TIMED_FRAMES, `frames ${latest.frames}`);
    assert.ok(Math.abs(latest.frameMs - STUB_FRAME_MS) < 0.01, `frameMs ${latest.frameMs}`);
    assert.ok(latest.updateMs >= 0 && latest.drawMs >= 0);
    await quit(game);
  });

  it("reports the device from ANGLE's device query and draws the CPU-fallback notice only on a CPU", {
    timeout: EXCHANGE_TIMEOUT_MS,
  }, async () => {
    const gpu = await startGame("gpu");
    const onGpu = await gpu.event(NativeEvent.Ready);
    assert.deepEqual(onGpu.event === NativeEvent.Ready && onGpu.backend, {
      api: NativeBackend.VulkanAngle,
      device: DISCRETE_GPU,
    });
    await gpu.result(NativeOp.Step, { ms: 16 });
    const plain = await gpu.result(NativeOp.State);
    assert.ok(isRecord(plain.hud) && !("notice" in plain.hud), "no notice on a GPU");
    assert.deepEqual(runtimeTexts(plain), [], "nothing drawn over the game on a GPU");
    await quit(gpu);
    const cpu = await startGame("cpu");
    const ready = await cpu.event(NativeEvent.Ready);
    assert.deepEqual(ready.event === NativeEvent.Ready && ready.backend, {
      api: NativeBackend.VulkanAngle,
      device: SWIFTSHADER,
    });
    const state = await cpu.result(NativeOp.State);
    assert.ok(isRecord(state.hud));
    assert.equal(state.hud.notice, CPU_FALLBACK_NOTICE);
    await quit(cpu);
  });

  it("fits the CPU-fallback notice inside a small world, wrapped, every line within the frame", {
    timeout: EXCHANGE_TIMEOUT_MS,
  }, async () => {
    const cpu = await startGame("cpu");
    await cpu.event(NativeEvent.Ready);
    await cpu.result(NativeOp.Step, { ms: 16 });
    const lines = runtimeTexts(await cpu.result(NativeOp.State));
    assert.ok(lines.length > 1, `the notice wraps in a ${STUB_WORLD.width} px world: ${JSON.stringify(lines)}`);
    for (const line of lines) {
      const across = line.x >= 0 && line.x + line.width <= STUB_WORLD.width;
      const down = line.y >= 0 && line.y + line.size <= STUB_WORLD.height;
      assert.ok(across && down, `inside ${STUB_WORLD.width}x${STUB_WORLD.height}: ${JSON.stringify(line)}`);
    }
    await quit(cpu);
  });
});

describe("the runtime over the stub raylib, driven over fd 3: the window", { skip: nativeSkip }, () => {
  before(buildNativeOnce);
  after(stopStarted);

  it("raises a window on front, and hides and shows it on visible", { timeout: EXCHANGE_TIMEOUT_MS }, async () => {
    const game = await startGame("basic");
    await game.event(NativeEvent.Ready);
    assert.equal(await probe(game, "fronted"), 0);
    assert.deepEqual(await game.result(NativeOp.Front), { fronted: true });
    assert.equal(await probe(game, "fronted"), 1, "front asked raylib to focus the window once");
    assert.deepEqual(await game.result(NativeOp.Visible, { visible: false }), { visible: false });
    assert.deepEqual(await game.result(NativeOp.Visible, { visible: true }), { visible: true });
    await quit(game);
  });

  it("presents nothing while its window is hidden (a hidden swap may block), and presents again once shown", {
    timeout: EXCHANGE_TIMEOUT_MS,
  }, async () => {
    const game = await startGame("basic");
    await game.event(NativeEvent.Ready);
    assert.deepEqual(await game.result(NativeOp.Visible, { visible: false }), { visible: false });
    const hidden = await probe(game, "presented");
    // Frames pass (each reply is a later frame's) and a step draws: none of it reaches the window.
    await game.result(NativeOp.Step, { ms: 100 });
    await game.result(NativeOp.Timing);
    await game.result(NativeOp.Timing);
    assert.equal(await probe(game, "presented"), hidden, "no present while hidden");
    assert.deepEqual(await game.result(NativeOp.Visible, { visible: true }), { visible: true });
    await game.result(NativeOp.Timing);
    await game.result(NativeOp.Timing);
    assert.ok((await probe(game, "presented")) > hidden, "presents again once shown");
    await quit(game);
  });

  it("a GENEX_HEADLESS game has no window: front is false, it stays invisible and sends no focus", {
    timeout: EXCHANGE_TIMEOUT_MS,
  }, async () => {
    const game = await startGame("focus", { binary: "game_headless" });
    await game.event(NativeEvent.Ready);
    assert.deepEqual(await game.result(NativeOp.Front), { fronted: false });
    assert.equal(await probe(game, "fronted"), 0, "no window to raise");
    assert.deepEqual(await game.result(NativeOp.Visible, { visible: true }), { visible: false });
    assert.ok((await game.result(NativeOp.Step, { ms: 100 })).steppedFrames >= 1);
    await quit(game);
    assert.deepEqual(game.events(NativeEvent.Focus), []);
  });
});

/** What a frames op refusal says (the runtime's wire values, `frames.h`). */
const FramesRefusal = {
  BadArgument: "bad-argument",
  NoService: "no-frames-service",
} as const;
/** Only a Mac's headless build carries Live's frames ring; everywhere else surface and release stay unknown. */
const HEADLESS_SENDS_FRAMES = process.platform === "darwin";
/** A service name of the right shape that no host checked in. */
const UNKNOWN_SERVICE = "games.genex.frames.0123456789ab";
/** The ring Live asks for first: the starter's world at one device pixel per CSS pixel. */
const FIRST_RING = { w: 960, h: 540, dpr: 1, slots: 3, generation: 1 };

/** The ops `refused` names as served. */
function served(refused: Line): unknown[] {
  return Array.isArray(refused.available) ? refused.available : [];
}

describe("the runtime over the stub raylib, driven over fd 3: Live's frames ops", { skip: nativeSkip }, () => {
  before(buildNativeOnce);
  after(stopStarted);

  it("a window build answers surface and release unknown-op and never lists them: the studio reads a game that cannot embed", {
    timeout: EXCHANGE_TIMEOUT_MS,
  }, async () => {
    const game = await startGame("basic");
    await game.event(NativeEvent.Ready);
    for (const [op, arg] of [
      [NativeOp.Surface, FIRST_RING],
      [NativeOp.Release, { slot: 0, generation: 1 }],
    ] as const) {
      const refused = await game.call(op, arg);
      assert.deepEqual([refused.ok, refused.error], [false, "unknown-op"], op);
      assert.ok(!served(refused).includes(NativeOp.Surface) && !served(refused).includes(NativeOp.Release));
    }
    await quit(game);
  });

  it("a headless build refuses hostile surface arguments before it looks for a frames service, and makes no ring", {
    timeout: 2 * EXCHANGE_TIMEOUT_MS,
  }, async () => {
    const game = await startGame("basic", {
      binary: "game_headless",
      env: { [NativeEnv.FramesService]: UNKNOWN_SERVICE },
    });
    await game.event(NativeEvent.Ready);
    if (!HEADLESS_SENDS_FRAMES) {
      const refused = await game.call(NativeOp.Surface, FIRST_RING);
      assert.deepEqual([refused.ok, refused.error], [false, "unknown-op"], "no frames ring off a Mac");
      await quit(game);
      return;
    }
    const hostile: unknown[] = [
      { ...FIRST_RING, slots: 4 },
      { ...FIRST_RING, w: 0 },
      { ...FIRST_RING, h: 0 },
      { ...FIRST_RING, w: 8193 },
      { ...FIRST_RING, generation: 0 },
      { ...FIRST_RING, dpr: null },
      { ...FIRST_RING, dpr: "NaN" },
      { ...FIRST_RING, w: "960" },
      "960x540",
      null,
    ];
    for (const arg of hostile) {
      const refused = await game.call(NativeOp.Surface, arg);
      assert.deepEqual([refused.ok, refused.error], [false, FramesRefusal.BadArgument], JSON.stringify(arg));
    }
    // A well-formed request does look the service up: no host checked this one in.
    const unknown = await game.call(NativeOp.Surface, FIRST_RING);
    assert.deepEqual([unknown.ok, unknown.error], [false, FramesRefusal.NoService]);
    const badRelease = await game.call(NativeOp.Release, { slot: 3, generation: 1 });
    assert.deepEqual([badRelease.ok, badRelease.error], [false, FramesRefusal.BadArgument]);
    // A release with no ring frees nothing and is still answered.
    assert.deepEqual(await game.result(NativeOp.Release, { slot: 0, generation: 1 }), {});
    assert.ok((await game.result(NativeOp.Step, { ms: 16 })).steppedFrames >= 1, "the game keeps running");
    await quit(game);
  });

  it("a headless run that is not embedded answers surface with no frames service, and keeps running", {
    timeout: EXCHANGE_TIMEOUT_MS,
  }, async () => {
    const game = await startGame("basic", { binary: "game_headless" });
    await game.event(NativeEvent.Ready);
    const refused = await game.call(NativeOp.Surface, FIRST_RING);
    const expected = HEADLESS_SENDS_FRAMES ? FramesRefusal.NoService : "unknown-op";
    assert.deepEqual([refused.ok, refused.error], [false, expected]);
    if (HEADLESS_SENDS_FRAMES) {
      const listed = await game.call("no-such-op");
      assert.ok(served(listed).includes(NativeOp.Surface) && served(listed).includes(NativeOp.Release));
    }
    assert.ok((await game.result(NativeOp.Step, { ms: 16 })).steppedFrames >= 1);
    await quit(game);
  });
});

/** Every symbol an object file defines or needs, as `nm` lists them. */
async function symbols(object: string): Promise<string> {
  const { stdout } = await execFileAsync("nm", [object], { timeout: ROW_TIMEOUT_MS });
  return stdout;
}

/** Whether `nm` runs here without a Command Line Tools prompt. */
function nmUsable(): boolean {
  const nm = onPath("nm", process.env);
  return nm !== null && usable(nm);
}

describe("frames.cpp's body is a Mac headless build's alone", {
  skip: nativeSkip || (nmUsable() ? false : "not run: no nm on PATH"),
}, () => {
  /** Compile `frames.cpp` with `defines` over the stub headers; the object file's path. */
  async function compileFrames(dir: string, defines: string[]): Promise<string> {
    const include = await stubIncludes(dir);
    const object = path.join(dir, `frames${defines.join("")}.o`);
    const source = path.join(UNITS_DIR, "frames.cpp");
    await execFileAsync(
      compiler ?? "",
      [`-I${include}`, ...FLAGS, ...LANE_DEFINES, ...defines, "-c", source, "-o", object],
      {
        timeout: COMPILE_TIMEOUT_MS,
      },
    );
    return object;
  }

  it("a window or web-shaped build of frames.cpp defines nothing and needs nothing", {
    timeout: COMPILE_TIMEOUT_MS,
  }, async () => {
    const dir = await tmpDir("cpp-frames-window-");
    const listed = await symbols(await compileFrames(dir, []));
    assert.doesNotMatch(listed, /IOSurface|bootstrap_look_up|eglGetProcAddress|frames/, listed);
  });

  it("a headless build defines the ring's ops and needs IOSurface and the bootstrap server only on a Mac", {
    timeout: COMPILE_TIMEOUT_MS,
  }, async () => {
    const dir = await tmpDir("cpp-frames-headless-");
    const listed = await symbols(await compileFrames(dir, ["-DGENEX_HEADLESS"]));
    if (!HEADLESS_SENDS_FRAMES) {
      assert.doesNotMatch(listed, /IOSurface|bootstrap_look_up|frames/, listed);
      return;
    }
    for (const needed of [/U _IOSurfaceCreate$/m, /U _IOSurfaceCreateMachPort$/m, /U _bootstrap_look_up$/m]) {
      assert.match(listed, needed);
    }
    assert.match(listed, /T __ZN6studio6frames7surfaceERKN4json5ValueE$/m, "studio::frames::surface is defined");
  });
});
