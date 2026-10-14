/**
 * The headless raylib platform (`native/raylib-platform/rcore_genex_headless.c`, D11 = A): raylib
 * 6.0 compiled the way the Mac prebuild compiles it, from a build-tree copy of its sources in which
 * this file replaces `platforms/rcore_memory.c`, with `-DPLATFORM_MEMORY -DGRAPHICS_API_OPENGL_ES3`
 * (no raylib file is edited). A small C program linked against it and the store's Metal-only ANGLE
 * draws into the pbuffer, reads the pixels back and asks ANGLE which device it drew on, then reads
 * a render texture back the way the C++ runtime reads its world texture for a capture; it runs
 * from an assembled bundle (`Game.app/Contents/{MacOS,Frameworks}`), unsandboxed and then under the
 * host's headless game profile, which reaches no WindowServer.
 *
 * Darwin only. raylib 6.0 and the Metal-only ANGLE come from the developer's toolchains
 * (`tests/helpers/dev-toolchains.ts`): skipped where absent, required under
 * `GENEX_REQUIRE_TOOLCHAINS=1`. Everything is built in the file's own temporary folder.
 */
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { copyFile, cp, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { MINUTE_MS, SECOND_MS } from "../../src/shared/duration.ts";
import { MAC_GAME_RPATH, NATIVE_BUNDLE_APP, NativeRunMode } from "../../src/shared/native-contract.ts";
import { GameProfileParam, gameProfileDefines, gameSandboxProfile } from "../../src/substrate/game-sandbox-profile.ts";
import { devTool, needsTools } from "../helpers/dev-toolchains.ts";
import { tmpDir } from "../helpers/tmp.ts";

const execFileAsync = promisify(execFile);
const REPO = fileURLToPath(new URL("../..", import.meta.url));
const PLATFORM_FILE = path.join(REPO, "native", "raylib-platform", "rcore_genex_headless.c");
const XCODE_SELECT = "/usr/bin/xcode-select";
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const COMPILE_TIMEOUT_MS = 5 * MINUTE_MS;
const RUN_TIMEOUT_MS = 30 * SECOND_MS;
/** raylib 6.0's modules, as the prebuild compiles them; the probe links what it uses from the archive. */
const RAYLIB_MODULES = ["rcore", "rshapes", "rtextures", "rtext", "rmodels", "raudio"] as const;
/** What selects the headless platform inside raylib's own `rcore.c` (§3.2.0 item 9). */
const HEADLESS_DEFINES = ["-DPLATFORM_MEMORY", "-DGRAPHICS_API_OPENGL_ES3"];
/** The executable a headless run starts (`NATIVE_MAC_EXECUTABLES.headless`). */
const EXECUTABLE = "game-headless";
/** The probe's frame, and the blue rectangle it draws over red. */
const FRAME_PX = 64;
const RECT = { x: 16, y: 8, width: 32, height: 16 };

/**
 * The probe: InitWindow on the headless platform, a red frame with a blue rectangle, the pixels read
 * back top-down, and ANGLE's own answer to which device drew them. Then a render texture, red with
 * a blue top half as raylib draws it, read back with LoadImageFromTexture as studio.cpp's capture
 * reads its world texture. One JSON line on stdout.
 */
const PROBE_SOURCE = String.raw`
#include <stdio.h>
#include <string.h>
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include "raylib.h"
#include "rlgl.h"

static const char *backend(void) {
  EGLDisplay display = eglGetCurrentDisplay();
  PFNEGLQUERYDISPLAYATTRIBEXTPROC displayAttrib = (PFNEGLQUERYDISPLAYATTRIBEXTPROC)eglGetProcAddress("eglQueryDisplayAttribEXT");
  PFNEGLQUERYDEVICESTRINGEXTPROC deviceString = (PFNEGLQUERYDEVICESTRINGEXTPROC)eglGetProcAddress("eglQueryDeviceStringEXT");
  PFNEGLQUERYDEVICEATTRIBEXTPROC deviceAttrib = (PFNEGLQUERYDEVICEATTRIBEXTPROC)eglGetProcAddress("eglQueryDeviceAttribEXT");
  EGLAttrib device = 0, metal = 0;
  if (display == EGL_NO_DISPLAY || !displayAttrib || !deviceString || !deviceAttrib) return "none";
  if (!displayAttrib(display, EGL_DEVICE_EXT, &device) || !device) return "none";
  const char *extensions = deviceString((EGLDeviceEXT)device, EGL_EXTENSIONS);
  if (!extensions || !strstr(extensions, "EGL_ANGLE_device_metal")) return "other";
  return deviceAttrib((EGLDeviceEXT)device, EGL_METAL_DEVICE_ANGLE, &metal) && metal ? "metal" : "other";
}

static void pixel(const unsigned char *pixels, int x, int y, const char *name) {
  const unsigned char *p = pixels + (y * ${FRAME_PX} + x) * 4;
  printf(",\"%s\":[%d,%d,%d,%d]", name, p[0], p[1], p[2], p[3]);
}

static void texture(void) {
  RenderTexture2D target = LoadRenderTexture(${FRAME_PX}, ${FRAME_PX});
  BeginTextureMode(target);
  ClearBackground(RED);
  DrawRectangle(0, 0, ${FRAME_PX}, ${FRAME_PX / 2}, BLUE);
  EndTextureMode();
  Image image = LoadImageFromTexture(target.texture);
  printf(",\"texture\":{\"format\":%d", image.format);
  pixel(image.data, ${FRAME_PX / 2}, 0, "row0");
  pixel(image.data, ${FRAME_PX / 2}, ${FRAME_PX - 1}, "lastRow");
  printf("}");
  UnloadImage(image);
  UnloadRenderTexture(target);
}

int main(void) {
  SetTraceLogLevel(LOG_WARNING);
  InitWindow(${FRAME_PX}, ${FRAME_PX}, "headless probe");
  if (!IsWindowReady()) { printf("{\"ready\":false}\n"); return 3; }
  BeginDrawing();
  ClearBackground(RED);
  DrawRectangle(${RECT.x}, ${RECT.y}, ${RECT.width}, ${RECT.height}, BLUE);
  EndDrawing();
  unsigned char *pixels = rlReadScreenPixels(${FRAME_PX}, ${FRAME_PX});
  printf("{\"ready\":true,\"screen\":[%d,%d],\"backend\":\"%s\"", GetScreenWidth(), GetScreenHeight(), backend());
  pixel(pixels, 0, 0, "topLeft");
  pixel(pixels, ${FRAME_PX - 1}, ${FRAME_PX - 1}, "bottomRight");
  pixel(pixels, ${RECT.x + 1}, ${RECT.y + 1}, "rectTop");
  pixel(pixels, ${RECT.x + RECT.width - 2}, ${RECT.y + RECT.height - 2}, "rectBottom");
  pixel(pixels, ${RECT.x - 1}, ${RECT.y}, "leftOfRect");
  texture();
  printf("}\n");
  MemFree(pixels);
  CloseWindow();
  return 0;
}
`;

const RED = [230, 41, 55, 255];
const BLUE = [0, 121, 241, 255];
/** raylib's PIXELFORMAT_UNCOMPRESSED_R8G8B8A8: what the runtime's capture accepts. */
const RGBA8 = 7;
/** What the probe must see on screen: raylib's RED everywhere but its BLUE rectangle, rows top-down. */
const SCREEN = {
  ready: true,
  screen: [FRAME_PX, FRAME_PX],
  backend: "metal",
  topLeft: RED,
  bottomRight: RED,
  rectTop: BLUE,
  rectBottom: BLUE,
  leftOfRect: RED,
};
/**
 * And in the render texture: rows bottom-up, so row 0 is the RED raylib drew at the bottom and the
 * last row the BLUE it drew at the top. studio.cpp flips them before writing a capture.
 */
const TEXTURE = { format: RGBA8, row0: RED, lastRow: BLUE };

/** Whether a Mac's Command Line Tools are installed, asked the one way that never prompts. */
function commandLineTools(): boolean {
  return spawnSync(XCODE_SELECT, ["-p"], { stdio: "ignore" }).status === 0;
}

function requirements(): { skip?: string } {
  if (process.platform !== "darwin") return { skip: "not run: the headless platform is the Mac's (D11 = A)" };
  if (!commandLineTools()) return { skip: "not run: the Command Line Tools are not installed" };
  return needsTools("raylib", "angleMac");
}

function toolPath(name: "raylib" | "angleMac"): string {
  const found = devTool(name);
  if ("skip" in found) throw new Error(found.skip);
  return found.path;
}

/** The assembled run folder: `bundle/Game.app` with the probe and the store's ANGLE, and `state/`. */
interface Run {
  runDir: string;
  bundle: string;
  exe: string;
  state: string;
}

/** Copy raylib's sources, put the headless platform in place of `rcore_memory.c`, build `libraylib.a`. */
async function buildRaylib(scratch: string, angleInclude: string): Promise<{ archive: string; include: string }> {
  const src = path.join(scratch, "raylib", "src");
  await cp(path.join(toolPath("raylib"), "src"), src, { recursive: true });
  await copyFile(PLATFORM_FILE, path.join(src, "platforms", "rcore_memory.c"));
  const objects = path.join(scratch, "obj");
  await mkdir(objects);
  await Promise.all(
    RAYLIB_MODULES.map((module) =>
      execFileAsync(
        "xcrun",
        [
          "clang",
          "-c",
          "-O1",
          "-std=c99",
          ...HEADLESS_DEFINES,
          `-I${src}`,
          `-isystem${angleInclude}`,
          path.join(src, `${module}.c`),
          "-o",
          path.join(objects, `${module}.o`),
        ],
        { timeout: COMPILE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      ),
    ),
  );
  const archive = path.join(scratch, "libraylib-headless.a");
  const built = (await readdir(objects)).map((name) => path.join(objects, name));
  await execFileAsync("xcrun", ["ar", "rcs", archive, ...built], { timeout: COMPILE_TIMEOUT_MS });
  return { archive, include: src };
}

/** Link the probe into an assembled bundle beside the store's ANGLE, as the host lays a run out. */
async function assembleProbe(
  scratch: string,
  angle: string,
  raylib: { archive: string; include: string },
): Promise<Run> {
  const runDir = path.join(scratch, "run");
  const bundle = path.join(runDir, "bundle");
  const contents = path.join(bundle, NATIVE_BUNDLE_APP, "Contents");
  const frameworks = path.join(contents, "Frameworks");
  const state = path.join(runDir, "state");
  await mkdir(path.join(contents, "MacOS"), { recursive: true });
  await mkdir(frameworks, { recursive: true });
  await mkdir(state, { recursive: true });
  for (const library of ["libEGL.dylib", "libGLESv2.dylib"]) {
    await copyFile(path.join(angle, library), path.join(frameworks, library));
  }
  const probe = path.join(scratch, "probe.c");
  await writeFile(probe, PROBE_SOURCE);
  const exe = path.join(contents, "MacOS", EXECUTABLE);
  await execFileAsync(
    "xcrun",
    [
      "clang",
      "-O1",
      probe,
      `-I${raylib.include}`,
      `-isystem${path.join(angle, "include")}`,
      raylib.archive,
      `-L${frameworks}`,
      "-lEGL",
      "-lGLESv2",
      `-Wl,-rpath,${MAC_GAME_RPATH}`,
      "-framework",
      "CoreFoundation",
      "-o",
      exe,
    ],
    { timeout: COMPILE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
  );
  return {
    runDir: realpathSync(runDir),
    bundle: realpathSync(bundle),
    exe: realpathSync(exe),
    state: realpathSync(state),
  };
}

/** The probe's one JSON line. */
function report(stdout: string): Record<string, unknown> {
  const line = stdout.split("\n").find((text) => text.startsWith("{"));
  assert.ok(line, `the probe printed its report: ${stdout}`);
  const parsed: unknown = JSON.parse(line);
  assert.ok(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed), line);
  return { ...parsed };
}

/** Only PATH: the platform asks ANGLE for Metal itself, so ANGLE_DEFAULT_PLATFORM is not what selects it. */
const PROBE_ENV = { PATH: "/usr/bin:/bin" };

describe(
  "the headless raylib platform draws on Metal through the store's ANGLE, with no window",
  requirements(),
  () => {
    let run: Run;
    before(async () => {
      const scratch = await tmpDir("headless-raylib-");
      const angle = toolPath("angleMac");
      const raylib = await buildRaylib(scratch, path.join(angle, "include"));
      run = await assembleProbe(scratch, angle, raylib);
    });

    it("InitWindow(64, 64) makes a pbuffer; red with a blue rectangle reads back top-down; ANGLE reports Metal", async () => {
      const { stdout } = await execFileAsync(run.exe, [], { env: PROBE_ENV, timeout: RUN_TIMEOUT_MS });
      const screen = Object.entries(report(stdout)).filter(([key]) => key !== "texture");
      assert.deepEqual(Object.fromEntries(screen), SCREEN);
    });

    it("a render texture reads back bottom-up through LoadImageFromTexture, as RGBA8", async () => {
      const { stdout } = await execFileAsync(run.exe, [], { env: PROBE_ENV, timeout: RUN_TIMEOUT_MS });
      assert.deepEqual(report(stdout).texture, TEXTURE);
    });

    it("does the same under the host's headless game profile, which reaches no WindowServer and no OpenGL", async () => {
      const profile = path.join(run.runDir, "profile.sb");
      await writeFile(profile, gameSandboxProfile({ mode: NativeRunMode.Headless }), { mode: 0o600 });
      const defines = gameProfileDefines({
        [GameProfileParam.RunTag]: `genex-headless-raylib-${process.pid}`,
        [GameProfileParam.Exe]: run.exe,
        [GameProfileParam.Bundle]: run.bundle,
        [GameProfileParam.State]: run.state,
      });
      const { stdout } = await execFileAsync(SANDBOX_EXEC, [...defines, "-f", profile, run.exe], {
        env: PROBE_ENV,
        timeout: RUN_TIMEOUT_MS,
      });
      assert.deepEqual(report(stdout), { ...SCREEN, texture: TEXTURE });
    });
  },
);
