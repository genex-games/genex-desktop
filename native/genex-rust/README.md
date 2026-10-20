# genex-rust

The Cargo workspace behind the `rust-wgpu` stack: the `genex` facade a generated game is written
against, and the runtime crates behind it. It started as M0a spike code and landed in M1.12; the
app never imports it. The game-facing contract is [docs/GENEX_API.md](docs/GENEX_API.md).

## Crates

| Crate | Role | Filled by |
| --- | --- | --- |
| `genex` | Facade: `Game<W>`, `Sim`, `Ctx`, `Frame`, `Camera`, `DemoDriver`, `genex::math`, `genex::Map`, `genex::gpu`, `install`, the `genex.toml` schema, and a headless reference runtime | M0a.1, M2.19 |
| `genex-core` | Clock, PCG32, input merger, session and checksum, safe paths, saves, from C++ goldens | M0a.2, M2.4 |
| `genex-studio` | fd 3 / named-pipe transport, verb dispatcher, Stop | M0a.3, M2.4 |
| `genex-render` | wgpu renderer on WebGPU core | M0a.4, M2.5, M2.6, M2.19 |
| `genex-hud` | egui HUD fed from the merged input | M0a.5, M2.8 |
| `genex-audio` | kira with a device-less mixer | M0a.5, M2.7 |
| `genex-platform-desktop` | winit shell, headless mode | M0a.5, M2.8 |
| `genex-frames` | GXF wire v1 sender over IOSurface (macOS) | M0a.6, M3.1 |
| `genex-gpu-memory` | the adapter's GPU-visible memory through wgpu's hal (Metal, DX12, Vulkan FFI), for the desktop memory budget; kept in the store on an eject | renderer follow-up |
| `genex-platform-web` | WebGPU-only web shell | M0a.7, M2.9 |
| `genex-assets` | glTF and image loaders | M2.7 |
| `genex-net` | multiplayer below the facade: the network as an input stream (one `NetFrame` per tick, a byte-capped journal, the tick's writes queued until after it) over Off, Loopback, Relay and Replay backends, deterministic on every destination (`tests/forbidden.rs`); Loopback with NetScript's scripted remote players and the sim-time libm port of the relay interpolator (MP-2b), and the native Relay backend over genex-multiplayer behind the `relay` feature (MP-3a), are filled; Replay and the web relay mapping are stubs until MP-3b | game systems (multiplayer) |
| `genex-multiplayer` | the Genex relay protocol 3 client, vendored byte for byte from genex-demo and held to its `PROVENANCE.toml` by `tests/conformance/rust-vendored-multiplayer.test.ts` (fixes go upstream first); `native` links libcolyseus 0.18.10 through its build script, `web` binds the JS bridge; kept in the store on an eject; a workspace member (MP-1a): its native build script links the toolchain store's pinned libcolyseus from `GENEX_COLYSEUS_LIB_DIR` and never downloads | game systems (multiplayer) |
| `genex-input` | input actions below the facade: action ids, bindings, contexts, conditions and modifiers evaluated in ticks, touch controls, rebinding, the journal and prompts (the `panel` feature adds egui); the action wire, glyphs, input track and capped journal (IN-3) are filled; the remaining stub modules name their work packages | game systems (G6 input) |
| `genex-save`, `genex-ui` | save slots, the versioned envelope, migrations and autosave; gameplay UI widgets, focus and controller navigation, Fluent text and the settings menu; every module is filled (genex-hud builds genex-ui for its UI scale bounds, keys and navigation events; the facade does not call either yet) | game systems (G6 saves and gameplay UI) |
| `genex-profile`, `genex-crash` | typed engine scopes over puffin, frame summaries and reports; typed crash records with raw frames, the panic hook and a capped file sink; the recorder, scope vocabulary, caps, counters and summary (PROF-1a), the hitches, GPU lane, memory rows, ProfileReport v2 and Chrome trace (PROF-1b), the record, vocabularies and file sink under the save root's reserved genex-crash/ (CRASH-1a) and the panic hook, frames, context and replay source (CRASH-1b) are filled; genex-render brackets frame-graph steps on the GPU while armed and times encode and submit (PROF-2), and records device loss, GPU validation errors and caught job and compile panics, which genex-studio sends as the `crash` event before `fatal` (CRASH-2) | game systems (G6 profiling and crash reports) |
| `genex-platform-ios`, `genex-platform-android` | mobile shells | M0a.16, M2.10, M5.3 |
| `examples/pond` | the pond sample | M0a.7 |
| `examples/custom-pass` | the custom GPU pass sample (`genex::gpu`, extension ladder level 3) | M2.19 |
| `examples/showcase` | the lakeside showcase: a game folder (`game/`) Studio opens, on the current renderer (its built-in physical sky and terrain with GPU grass, `frame.environment`) plus three custom passes; its named shots are the renderer before/after captures (`tests/shots.rs`; pass 1's five, plus Lakeside v2's wide golden hour, shore, forest floor and cabin room with its reflection probe and irradiance volume, and the terrain's scattered stones as retained instance groups, `tests/lakeside_v2.rs`; every shot of both scenes at 1440p and 4K with the HUD hidden, at each scene's dusk, night and day, `tests/section7.rs`; N steps either scene through its time of day, the golden hour or dusk, a moonlit night under the stars and a clear day, `tests/showcase_b.rs`), beside three renderer bench scenes (`src/bench`: materials, outdoor, a 64k-instance city; `tests/bench_scenes.rs`), two stress scenes (`src/stress.rs`: 1,024 point lights over a plaza, a 1.5 M triangle forest) and the perf harness: the scenes x profiles x sizes matrix (`tests/perf_matrix.rs`, driven by `scripts/spike/rust-wgpu/render-perf.ts`: baseline, the 10% `off` gate, interleaved A/B against saved executables, feature costs against the plan's budgets) and the earlier single-profile bench (`cargo bench --bench render-baseline`); beside it Harbour Street (`harbour/`, a second game folder: renderer pass 2's urban and interior scene, a street at dusk after rain (or at night, the street soaked), a neon alley and a café through its door, blocked out from built-in features only, CC0 scans fetched by `node scripts/showcase-assets.ts fetch --scene harbour-street`; its rules in `tests/harbour.rs`, its named shots captured by `tests/harbour_shots.rs`) | renderer follow-up, renderer pass 2 |

Every member exists from M0a.1 on as a stub that already depends on what its role needs, so a
crate work package fills its own folder and never edits the workspace manifest.

## Running cargo

Every cargo command goes through the env helper `scripts/toolchains/rust-env.ts`: the pinned
Rust 1.99 sysroot, the vendored crates as the only source, no network, `--manifest-path` to this
workspace and the shared target directory `.studio-dev/cargo-target`. It never consults rustup
or `~/.cargo`, and refuses a caller's own `--manifest-path`, `--config`, `-Z`, `+toolchain` or a
`.cargo/config` (see its header). Install the toolchain once with
`scripts/spike/rust-wgpu/setup-toolchain.sh`; until then the helper refuses and names the pinned
archives it needs.

```sh
node scripts/toolchains/rust-env.ts -- cargo test --workspace --offline --locked
node scripts/toolchains/rust-env.ts -- cargo clippy --workspace --offline --locked -- -D warnings
```

`npm run test:rust-spike` runs the workspace's tests and clippy with `-D warnings`.

`cargo test` and `cargo bench` run with `GENEX_NO_WINDOW=1`: a test that reaches the desktop
shell's window is refused `window-refused` before any event loop exists, so no test opens a
window. A test that needs the picture a window shows uses `genex::desktop_shot` (the shell's
frames headless, letterboxed into an offscreen window; `examples/pond/tests/window_path.rs`).
An owner's windowed smoke row opts out with an explicit `GENEX_NO_WINDOW=0`.

A dev-flavour game run with `cargo run` (no `assets/` beside the executable) reads its crate's
`assets/` through `CARGO_MANIFEST_DIR`; an export never does.

`genex`'s compile-fail cases live in `crates/genex/tests/ui/`. After an intended diagnostic
change, rerun with `TRYBUILD=overwrite` and review the `.stderr` diff.

## Dependencies and the lock

- A crate takes dependencies only from `[workspace.dependencies]` (`foo = { workspace = true }`).
  Each entry pins the version `scripts/spike/rust-wgpu/vendor-allowlist.toml` vendored. A crate
  missing from the vendored tree goes into the allowlist first, then
  `setup-toolchain.sh --vendor`.
- The exceptions are the mobile shells' `pond` dev-dependency, a path inside this workspace
  (their `pond_ios` and `pond_android` examples are the spike's packaged executables,
  `scripts/spike/rust-wgpu/ios-app.sh`, `android-apk.sh`), and the vendored `genex-multiplayer`,
  whose upstream manifest keeps its own version requirements; the lock resolves them to the
  workspace's versions, plus `sha2` for its build script. Its manifest differs from upstream only
  in naming the upstream edition (2021), as its `PROVENANCE.toml` declares.
- The pond's `studio` feature (on by default) is the dev flavour: started by the studio (fd 3
  and `GENEX_STUDIO_NONCE`) it serves genex-studio's verbs headless over the facade runtime
  (`examples/pond/src/studio.rs`, the stand-in for the facade adapter M2.4 lands). Export
  builds (`cross-*.sh`, `export-standalone.sh`) use `--no-default-features` and link no
  genex-studio. The web page answers `window.__studio` through `Studio::web()` in every flavour.
- Adding a dependency edge changes `Cargo.lock`. Update it offline with one
  `rust-env.ts -- cargo update -w --offline`, then go back to `--locked`.
- `Cargo.lock` lists every optional dependency of every package, so nalgebra 0.35's
  never-enabled `convert-glam030..032` put glam 0.30–0.32 in the lock text. Only glam 0.33 is
  built; `crates/genex/tests/determinism.rs` checks the feature-resolved graph for every target.

## Supply chain

The vendored crate set is the only source a game builds from. `scripts/toolchains/rust-vendor.ts
check` refuses any build script, proc macro or non-source file `scripts/toolchains/rust-inventory.json`
does not list, and any GL backend crate. `deny.toml` (licences, bans and sources over every
shipped target) and `supply-chain/` (the cargo-vet store) are read at this root, through the env
helper: `cargo deny check bans licenses sources` and `cargo vet check --locked`.
`.github/workflows/rust-toolchain.yml` runs the gate on Linux; publishing the release inputs is
an owner step ([scripts/toolchains/README.md](../../scripts/toolchains/README.md)).

`crate-policy.json` is the policy a crate a game requests is vetted against in the app (mode
`person-decides`): deny.toml's licence allow list and bans, the pinned RustSec snapshot and the
trusted audit sources. The app ships it beside `Cargo.lock` and reads only the bytes
`CRATE_POLICY_SHA256` pins; `scripts/toolchains/crate-policy.ts refresh` moves the snapshot and
every pin with it ([tool permissions](../../docs/tool-permissions.md#crate-requests)).

## Renderer rule

Rapier's `enhanced-determinism` turns on `glamx/scalar-math` and `glamx/libm`. By feature
unification every glam 0.33 user in this workspace runs scalar libm math, and glam's `Vec4`,
`Quat` and `Mat4` lose `repr(align(16))`. GPU-facing structs therefore never contain glam
types: they are `#[repr(C)]` structs of explicit `[f32; N]` arrays deriving bytemuck's `Pod`
and `Zeroable`, with padding written by hand to the WGSL layout. Convert at the boundary
(`Transform::to_cols_array()`, `Color::to_array()`). The facade's `genex::math` uses the same
libm path, so simulation math does not depend on the GPU code.

## Determinism gate

`clippy.toml` at the workspace root is the lane's game rule set: it refuses `HashMap`/`HashSet`,
wall clocks, `thread::spawn`, ambient randomness and the std f32 transcendentals (use
`genex::math`). It is also the default for every crate here, so host crates that read a clock or
start a thread carry their own `clippy.toml` saying why; `genex-core` keeps its own copy with the
f64 forms added (its audio meter's FFT is the one reasoned `#[allow]`).
`scripts/spike/rust-wgpu/parity.sh` proves each rule on a fixture, runs the pond twice for
bit-identical output and compares records across targets (see its header).
