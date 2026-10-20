# The genex API

This index and its topic pages are the contract a game's Rust code is written against. Studio
copies them read-only into every Rust game folder as `docs/GENEX_API.md` and `docs/api/`. The
facade crate is `genex`; everything they teach comes from `use genex::prelude::*;`, except
where a page names its own `use genex::…;` line.

## A game

```rust
use genex::prelude::*;

#[derive(Default)]
struct World { score: u32 }

fn main() {
    let mut game = Game::new(World::default()).title("Pond").world_size(960, 540);
    game.on_update(|sim, ctx| if ctx.keys.pressed(Key::Space) { sim.world.score += 1; });
    game.on_draw(|sim, frame, _camera| { frame.tag("score").cube(Transform::IDENTITY, Color::WHITE); });
    game.probe("score", |sim| json!(sim.world.score));
    genex::install(game);
}
```

The game folder holds `src/main.rs`, `src/facets/*.rs`, `assets/` and `genex.toml`. It has no
`Cargo.toml`: the host writes the manifest and lock. Game code never uses `unsafe`, build
scripts, cargo configuration or renderer internals.

## Topics

This index holds the hooks and the rules every game follows. Every other topic is a page of its
own beside it in `docs/api/`: read the page of each topic a change touches (nearly every game
needs Ctx and Drawing).

| Topic | Page | What it covers |
|-|-|-|
| Ctx | `docs/api/ctx.md` | What a tick reads: keys, touches, pads, the pointer, look, wheel and text, `ctx.rng`, `ctx.dt`, `ctx.tick` and the game's own saves. |
| UI | `docs/api/ui.md` | `on_ui`: the egui HUD and menus, a game's only UI path. |
| Drawing | `docs/api/drawing.md` | Tags, models, cubes, spheres, lines and the clear colour, and loading models from `assets/`. |
| Reading assets | `docs/api/assets.md` | What a reset may read from `assets/` (a level's JSON, a model's triangles), its refusals and why the checksum stays the same everywhere. |
| Streaming a large world | `docs/api/streaming.md` | A world in cells: anchors, the sim radius, cell builders, entered and left cells, holds and their refusals. |
| Navigation | `docs/api/navigation.md` | The walker, nav input, baking and `.navmesh` bytes, tiles, area costs, carved obstacles and refusals. |
| Lighting, materials and environment | `docs/api/lighting.md` | The sun, ambient, point and spot lights, materials and emission, reflection probes, irradiance volumes, decals, the sky and HDR maps. |
| Rendering | `docs/api/rendering.md` | Look and quality: presets, device classes, features, `[render]`, the settings panel, shadows, draw ids and camera cuts. |
| Grading and the lens | `docs/api/grading.md` | The order a look is built in, the grade, white balance, LUTs, depth of field and motion blur. |
| Loading screen | `docs/api/loading-screen.md` | The loading screen every destination draws and its style. |
| Big meshes (meshlets) | `docs/api/meshlets.md` | Meshlets and occlusion culling for big meshes, and when a game opts in. |
| Retained instance groups | `docs/api/instance-groups.md` | Many copies of one shape (a forest, rocks, buildings) made once and drawn as a group. |
| Terrain | `docs/api/terrain.md` | Heightmap ground across the world: making it, drawing it and its refusals. |
| Particles | `docs/api/particles.md` | Emitters (steam, rain, sparks) drawn as a pure function of the tick. |
| Water | `docs/api/water.md` | Lakes, ponds and flooded quarries: `frame.water`, one flat level the ground hides. |
| Custom materials and post passes | `docs/api/custom-materials.md` | Extension ladder level 2: WGSL materials and post passes declared in `genex.toml`. |
| Custom GPU passes | `docs/api/gpu-passes.md` | Extension ladder level 3: raw wgpu work through `genex::gpu`, at the frame's stages. |
| genex.toml | `docs/api/genex-toml.md` | Every key of the game's build input: the game, physics, crates, WGSL sources, native features and the web. |

## Hooks

Every hook gets a `Sim<W>`: `sim.world` (your `W`), `sim.physics` (Rapier 3D) and
`sim.facets` (each facet's private state). `sim.split()` lends the world and physics together.

| Hook | Signature | Kind |
| --- | --- | --- |
| `on_reset` | `(&mut Sim<W>, seed: u32, rng: &mut Pcg32, gfx: &Gfx)` | mutating |
| `on_update` | `(&mut Sim<W>, &Ctx)` | mutating |
| `on_ui` | `(&mut Sim<W>, &mut egui::Ui, &Ctx)` | mutating |
| `demo(name, ..)` | `(&mut DemoDriver<W>) -> Value` | mutating |
| `on_draw` | `(&Sim<W>, &mut Frame, &Camera)` | read |
| `camera` | `(&Sim<W>) -> Camera` | read, single |
| `named_camera(name, ..)`, `eye(name, ..)` | `(&Sim<W>) -> Camera` | read |
| `probe(name, ..)`, `probe_volatile(name, ..)` | `(&Sim<W>) -> Value` | read |
| `player` | `(&Sim<W>) -> Value` | read, single |

Read hooks take `&Sim` and are `Fn`, so the compiler refuses a draw, camera or probe that
changes the simulation: captures, observer cameras and Live frames never move the checksum.
Animation that exists only on screen derives from simulation state: a read hook has no `ctx`,
so a draw that needs the time reads a tick the world keeps from `on_update` (`ctx.tick`).

- **Seed.** `seed(n)` rebuilds the `Sim` from `W::default()`, each facet's `T::default()` and an
  empty physics world, then runs every `on_reset` in registration order with `rng` seeded from
  `n`. The runtime starts on seed 1 and is paused after every seed.
- **Tick.** A tick is 1/60 s. It runs every `on_update` in registration order, then every
  `on_ui`, then steps physics once. `step(ms)` runs `max(1, round(ms / 16.667))` ticks, at most
  36,000. A streamed world's held commit can end a step early (`docs/api/streaming.md`).
- **Single-valued hooks.** A second `camera` or `player` makes `install` panic
  (`duplicate-camera`, `duplicate-player`) unless it is marked as the replacement:
  `game.camera(..).camera_override();`, `game.player(..).player_override();`.
- **Probes.** Probes are `state()` leaves the checks read, merged in registration order. Write
  one per mechanic, each a small JSON value that says whether the mechanic works (a count, a
  position, a flag), never a dump of the world. A probe never reuses a key `state()` owns or
  another probe's name; `probe_volatile` values appear under `state().volatile` and stay out of
  the checksum (use it for anything that is not a function of the seed and the input).
- **State keys.** `state()` owns `version`, `contractVersion`, `seed`, `frame`, `simulatedMs`,
  `running`, `fps`, `held`, `pointerLock`, `hud`, `camera`, `error`, `player`, `volatile`,
  `__render`, `assets` and `checksum`, `__stream` while `game.streaming` is registered and
  `__input` while `game.input` is registered (display only and never in the checksum, so a probe
  may be named `stream` or `input`). A streamed world
  (`docs/api/streaming.md`) registers `Streaming::grid(64.0).sim_radius(1)` with
  `game.streaming(..)` and builds cells with `game.cell_content(..)` (`CellBuild::default()`,
  `.thing(..)`; `.hysteresis(..)`, `.prefetch(..)` and `.anchors(..)` tune it); the sim moves it
  with `sim.stream.set_anchor(..)` and `sim.stream.clear_anchor(..)` and reads
  `sim.stream.entered()` and `sim.stream.left()` each tick. `game.navigation(..)` registers a
  walker and `sim.nav` holds its nav (`docs/api/navigation.md`); `frame.nav_debug` draws nothing
  yet. `hud.items` lists
  the label of every egui widget the last tick drew, in drawing order, so a check can find a
  widget by its label.
- **Demos.** A demo scripts what a generic walk cannot reach (a state behind a menu, a long
  chain of inputs). Its driver offers `sim()`, `sim_mut()`, `inject(input)`, `advance_ms(ms)`
  and `save(file, bytes)`, and the value it returns is the demo's answer (a check captures the
  frame after the demo with the `capture` verb). The runtime
  is paused after a demo. Only a demo can advance time: `advance` inside `on_update` does not
  compile.
- **Names.** Probe, camera, eye and demo names are non-empty, at most 64 characters, without
  control characters, and unique within their kind. `"default"` is not a camera name.
- **Install refusals.** `install` checks the registrations and panics with one typed code before
  anything runs: `duplicate-camera`, `duplicate-player`, `duplicate-probe`, `reserved-probe`
  (a probe named like a `state()` key), `duplicate-camera-name`, `duplicate-eye`,
  `duplicate-demo`, `invalid-name`, `duplicate-facet-state` (one state type registered twice),
  `invalid-world-size`, `duplicate-streaming` (a second `game.streaming`), `streaming-invalid`
  (a cell size outside 8..=1024 metres, a radius or anchor count outside its range, a
  registration past the simulated cells' memory cap, or, with `game.navigation`, a stream cell
  that is not a whole number of nav tiles), `duplicate-input` (a second `game.input`),
  `input-invalid` (an action map or touch layout genex-input refuses) and
  `duplicate-touch-controls` (a second `game.touch_controls`). `game.gpu_pass` panics `gpu-pass-invalid` as it is
  registered: an empty, overlong or repeated pass name, or one pass over the cap.

## Verbs

The studio and its checks drive a running game through a fixed set of verbs; the game never
calls them and cannot add one. `seed(n)`, `start`, `pause` and `step(ms)` control time;
`state` reads the probes and runtime keys; `input` injects keys, pointer, look, wheel, text,
pads and touches; `capture` renders a view; `renderSettings` reads or changes the renderer's
quality for this session (see Rendering); `cameras`, `eyes`, `debugCamera`, `demos` and `demo`
reach what the game registered. `docs/CONTRACT.md` lists each verb and the refusals a run can
answer.

## Determinism

A simulation replays bit for bit from its seed on every destination, or two builds cannot be
compared. The studio's build lints every game with a file of refused paths, and a refused path is
a build failure, not a warning.

- Use `genex::math` (`sin`, `cos`, `atan2`, `exp`, `pow`, `sqrt`, ...) for transcendental math:
  it is libm on every target. The lane refuses std's `f32::sin`, `f32::powf`, `f32::powi` and
  the other transcendental methods of `f32`. `sqrt`, `abs`, `floor` and `mul_add` stay allowed.
- Use `genex::Map` and `genex::Set` (insertion-ordered, fixed hasher) instead of `HashMap` and
  `HashSet`, which the lane refuses.
- Never read a clock: `Instant` and `SystemTime` are refused. Time comes from `ctx.tick` and
  `ctx.dt`.
- Never spawn a `thread` (`std::thread::spawn`): threads reorder the simulation's work.
- Randomness comes only from `ctx.rng` or the reset `rng`. The lane refuses `rand`'s
  `thread_rng`, `rng` and `random`, `getrandom`, and the global `fastrand` functions and
  `fastrand::Rng::new`; a `fastrand::Rng` is fine when built `with_seed` from `ctx.rng`.
- Animation that exists only on screen derives from simulation state, never from a clock.

## Facets

A facet is `src/facets/<slug>.rs` with `pub fn wire(game: &mut Game<World>)`. It keeps its own
state in a type registered with `game.facet_state::<T>()` and read with
`sim.facets.get::<T>()` / `get_mut::<T>()`. The entry file wires facets in one block:

```rust
// ── FACET WIRING ── two lines per facet, nothing else
#[path = "facets/fishing.rs"] mod fishing;
#[path = "facets/shop.rs"] mod shop;
fishing::wire(&mut game);
shop::wire(&mut game);
// ── END FACET WIRING ──
```

Both lines of each facet live inside the block in `main`, so workers that add facets in
parallel merge by keeping every line. Facets reach the entry file's types as `super::World`.

## Extension ladder

A game reaches past the facade one level at a time: hooks (level 0), its own safe Rust modules
(1), WGSL sources (2), custom GPU passes through `genex::gpu` (3), crates the person approved
through `request_crate` (4), and an ejected engine (5). Agents start at the lowest level that
works. At level 4 Genex still refuses an approved crate when a known security advisory, a licence
it does not allow or a banned crate is in it or in a crate it brings in, and a crate with a build
script or a proc macro needs the person's separate approval of that kind. Every level keeps the conformance suite's guarantees (every verb answers, a seed replays
to the same state and capture digest, Stop ends the game and its children), and none loosens the
sandbox the build and the game run in.

An eject is the person's act in Studio, never an agent's. It copies the genex crates of the
game's toolchain lock into `engine/<crate>` with their digests in `engine/genex-engine.json`, and
the studio writes the `[engine]` row of `genex.toml`:

```toml
[engine]                  # written by the studio on an eject; never edited by the game
ejected_from = "0.1.0"    # the genex release copied into engine/
```

The build then links the copy instead of the studio's engine, under the same policy: offline,
locked, clippy, no `unsafe` and no build scripts. The studio writes each copied crate's
`Cargo.toml`, so the engine's own build scripts and proc macros never build; `genex-studio`,
`genex-frames`, `genex-gpu-memory` and the phone shells stay the studio's. An ejected game gets
no engine updates, and its Live, capture and export wait for a passing conformance run (`check_conformance`) on
each new build: `conformance-required` until then. The person's per-game trust flag lets
`unsafe` and build scripts in the game's own crates build (`unsafe-code` and
`build-script-refused` without it); the sandbox is the same either way.
