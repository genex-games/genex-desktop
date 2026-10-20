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
| `genex-platform-ios`, `genex-platform-android` | mobile shells | M0a.16, M2.10, M5.3 |
| `genex-ai` | play-time AI (`genex::ai`, `ctx.ai`): ask, say, judge and act over the studio's `ai` lines, results only through `drain()`, the closed schema dialect; held to the TypeScript wire by `tests/fixtures/play-ai-wire-v1.json`; no network crate in its graph | play-time AI |
| `genex-ai-derive` | `#[derive(genex_ai::Schema)]`: a type as the closed dialect, in step with its serde names; an enum of documented variants as an act call's tools | play-time AI |
| `examples/pond` | the pond sample | M0a.7 |
| `examples/custom-pass` | the custom GPU pass sample (`genex::gpu`, extension ladder level 3) | M2.19 |
| `examples/showcase` | the lakeside showcase: a game folder (`game/`) Studio opens, on the current renderer (its built-in physical sky, `frame.environment`) plus five custom passes; its named shots are the renderer before/after captures (`tests/shots.rs`), beside three renderer bench scenes (`src/bench`: materials, outdoor, a 64k-instance city; `tests/bench_scenes.rs`), two stress scenes (`src/stress.rs`: 1,024 point lights over a plaza, a 1.5 M triangle forest) and the perf harness: the scenes x profiles x sizes matrix (`tests/perf_matrix.rs`, driven by `scripts/spike/rust-wgpu/render-perf.ts`: baseline, the 10% `off` gate, interleaved A/B against saved executables, feature costs against the plan's budgets) and the earlier single-profile bench (`cargo bench --bench render-baseline`) | renderer follow-up |

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
- The one exception is the mobile shells' `pond` dev-dependency, a path inside this workspace:
  their `pond_ios` and `pond_android` examples are the spike's packaged executables
  (`scripts/spike/rust-wgpu/ios-app.sh`, `android-apk.sh`).
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

## Play-time AI on the studio connection

A Rust game speaks the play-time AI lines of `docs/play-protocol.md` ("Play-time AI") on its
studio connection (fd 3, the Windows pipe) rather than on a Play Protocol stdout, with the
native envelope around the studio's ops:

- A game that calls `game.ai(..)` declares it in `ready`: `"capabilities": {"ai": true}`.
- The studio takes the game's AI only by starting it with `GENEX_STUDIO_AI=1`
  (`genex_studio::AI_ENV`). Without it the game writes no `ai` line (a host that reads an
  unknown event as a violation never sees one), answers `ai.reply` / `ai.delta` `unknown-op`, and
  every call fails `ai_off` at once so the game plays its fallbacks. A host sets the variable
  only once its port reads `ai` events.
- Lines are id-less events, `{"event":"ai","rid":"rsai-…","op":…,"body":…}`, byte for byte the
  TypeScript's `JSON.stringify` of the same message (`tests/fixtures/play-ai-wire-v1.json`). Each
  goes out before the reply of the request whose ticks printed it, and after each live frame.
- The studio answers with `{"id":…,"op":"ai.reply","arg":{"rid":…,"reply":…}}` and streams a
  `say` with `{"id":…,"op":"ai.delta","arg":{"rid":…,"text":…}}`; the game replies
  `{"taken": bool}` (false for a rid it is not waiting for, such as a line of a run before a
  `seed`), or `bad-argument` for an argument without a string `rid`.
- `state().volatile.ai` is `{asked, answered, status}`: the rids sent and answered this run and
  the AI's status, outside the checksum.

`scripts/toolchains/play-ai-wire-fixture.ts check --from <checkout>` holds the fixture to the
TypeScript modules of a checkout that has them.
