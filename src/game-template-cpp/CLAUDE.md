This is a C++20 game built with raylib 6.0 for the destinations in `studio.json`: browser (WebAssembly, WebGL2), macOS (Metal
through ANGLE), Windows (Direct3D 11 through ANGLE) and Linux (Vulkan through ANGLE).

1. **Read `.studio/BRIEF.md` first when it exists.**
2. **Keep the studio contract answering on every destination.** `studio::install({...})` stays in `src/main.cpp`; never
   remove a verb from `src/studio.h`. Before you finish, check the build with the studio `capture` tool: `target`
   `web`, and `macos` when the game is made for the Mac. Windows and Linux builds are not run here yet: say so
   instead of claiming them. A build the studio cannot run is a black screen for every critic. Non-owner facets touch
   `src/main.cpp` only inside the FACET WIRING block.
3. **One screen, one input path.** Draw all UI with `studio::hud` inside the frame. Read input only from
   `ctx.keys/look/wheel/pointer/pads/text` inside `update(dt, ctx)`; `IsKeyDown`/`GetMouseDelta` in game code are defects.
4. **Tag and measure.** Tag what you draw (`studio::tag`), one probe per mechanic in `probes()`, a camera that
   shows it, a demo when a generic walk cannot reach it.
5. **Deterministic, textured, modelled.** Randomness only from `ctx.rng`; time only from `dt`; never `GetTime`,
   `GetFrameTime`, `rand`, `std::random_device`, `std::chrono` clocks or `sin`-based hashes in simulation. A flat
   colour with no texture is a defect: use textures and models from `assets/` (GLB/glTF without Draco, OBJ;
   PNG/JPEG; WAV/OGG/MP3/QOA) via `studio::asset()`.
6. **Portable and offline.** Shaders have no `#version` line (the runtime adds `#version 300 es`). No
   `SetTargetFPS`, `WaitTime`, threads, ASYNCIFY, wire/point modes, compute or `#version 330`. No network, no
   `FetchContent`, no Emscripten ports: vendor small libraries under `third_party/<name>/` with their licence.
   Never run `build/…` yourself; the first `error:` of a failed build is the one that matters.

Where the game runs: `capture` builds it and looks through its cameras (`macos` runs it headless on
this Mac); Live shows the web build
when Browser is a destination; **Play on Mac** opens it in a window of its own that belongs to the
person, never to you. A studio run saves through `studio::save` into the run's own `state/` (its
captures land in `state/captures/`), never into this folder. `build/` is scratch: never committed,
served or judged. When your shell has `GENEX_CMAKE`, `cmake -S . -B build -DGENEX_CMAKE="$GENEX_CMAKE"`
then `cmake --build build` compiles there (CMake never reads `GENEX_CMAKE` from the environment).
