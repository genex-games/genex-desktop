# Genex's headless raylib platform

`rcore_genex_headless.c` is the raylib platform an agent's headless run of a C++ · raylib game
draws on: no window and no WindowServer. raylib draws into an EGL pbuffer on the
store's Metal-only ANGLE, and a game takes its input only from the studio protocol. The game's
`game-headless` executable is the template compiled with `GENEX_HEADLESS` and linked against this
raylib.

## How the prebuild selects it

raylib 6.0's `rcore.c` includes one platform file per `PLATFORM_*` define, and an unknown define
includes none. So the Mac prebuild compiles raylib's sources from a build-tree copy of
`raylib-6.0/src`, in which this file replaces `platforms/rcore_memory.c`, with
`-DPLATFORM_MEMORY -DGRAPHICS_API_OPENGL_ES3` and the ANGLE headers. `PLATFORM_MEMORY` only
changes one trace line and a software-renderer flag in `rcore.c`, and the ES 3 path calls ANGLE's
GL ES directly. The prebuild uses its own CMake list
(`src/substrate/toolchain-store/genex-cmake.ts`, `headlessRaylibCmake`), never raylib's:
raylib's `PLATFORM=Memory` builds its software renderer. No raylib file is edited, and no patch
to raylib reaches a user. The prewarm recipe's digest folds this file's sha256, so a changed file
reads as a stale prewarm.

## What it does

- `InitPlatform` gets an `EGL_PLATFORM_ANGLE_ANGLE` display, asking for Metal explicitly
  (`EGL_PLATFORM_ANGLE_TYPE_METAL_ANGLE`). It chooses an RGBA8, D24S8, ES 3 pbuffer config,
  creates a pbuffer the size of the screen and an ES 3.0 context, and makes them current.
- `SwapScreenBuffer` flushes. `GetTime` is monotonic from its own base. `PollInputEvents` polls
  nothing. `ClosePlatform` releases everything.
- Every window function keeps raylib's template no-op and its `TraceLog` line.
- Readbacks keep raylib's orientation: `rlReadScreenPixels` flips, so its rows come top-down;
  `LoadImageFromTexture` of a render texture does not, so its row 0 is the bottom. The C++
  runtime's capture reads its world texture that way and flips it before writing the file.

## Checks

- `scripts/toolchains/compile-check.sh mac` compiles the file inside the build-tree `rcore.c`.
- `tests/conformance/headless-raylib.test.ts` builds this raylib and draws on it. The raylib
  comes from a build-tree copy in the test's own folder, the probe links against the store's
  ANGLE, and ANGLE must report Metal. It checks both readback orientations and runs unsandboxed
  and under the host's headless game profile.

## Licence

The file is an altered copy of raylib's `src/platforms/rcore_template.c` under zlib/libpng. Its
header marks what Genex changed and keeps raylib's notice. `THIRD-PARTY-NOTICES.md` lists it.
