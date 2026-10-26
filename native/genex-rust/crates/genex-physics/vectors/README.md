# Genex Physics conformance vectors

The conformance vectors of [CONTRACT.md §16](../CONTRACT.md#16-conformance-vectors): one JSON file per
scene, each a world, a command script and the hashes, events, refusals and query answers this build gives.
Any implementation of contract 1.0 on the same build replays them and must match every expectation, on
every target.

## Version

Every file carries two version fields, and a runner refuses a file whose fields differ from its own:

| Field | Value for these pins | Meaning |
|---|---|---|
| `contract` | `1.0` | the contract version (§2) the file is written against |
| `build` | `genex-physics/0.1.0+contract-1.0+rapier-0.36.0+det` | the `buildId` without its `+<target>` suffix (§2, the same string §10.2 hashes) |

Determinism is promised only between equal `buildId`s up to the target, so vectors are per build (§16).
A new core version, backend version or feature set is a new `build`: the vectors are rewritten for it and
published with that release. A rewritten hash on an unchanged `build` is a determinism change, explained in
its commit.

## Format

The format is §16's. The runner (`tests/vectors.rs`, and its JS twin `../js/conformance.js` for the
`@genex-ai/physics` package) reads it as follows where §16 leaves a detail open:

- `repeat: 0` runs no step, so a hostile entry can expect the hash its refusal left unchanged.
- `events` is the last step's list (or its length when the pin is a number), in the binding's form:
  `{ kind, a, b, ca, cb, ka?, kb?, impulse, point, normal }` for contacts, `{ kind, sensor, sc, other, oc,
  ks?, ko? }` for triggers.
- `queries` holds one answer per query, `{ hit: null | { body, collider, dist, point, normal } }`,
  `{ keys: [...] }` or `{ error: code }`.
- `refused` is `[[index, code], …]`; in `"atomic"` mode it has at most one pair, the first failing index.
- Numbers are compared as f32 (§16: every number a vector writes is f32-exact).

The first mismatch names the step entry and the field, then prints the world's full `bodies()` dump.

## Scenes

| File | Scene (§16 / PLAN P3) |
|---|---|
| `spread-kicked-props.json` | 24 boxes and spheres on a floor, every third kicked with an off-centre impulse |
| `pile-10-players-30hz.json` | four piles of six crates in inches at 30 Hz, two substeps; 10 kinematic preset-sized capsules (radius 16, height 72) walk through them |
| `dense-heap.json` | 96 boxes, spheres, hulls and capsules dropped in one heap, y-up, some with events |
| `motorised-doors-32.json` | 32 hinged doors with limits and velocity motors, then switched to position motors |
| `firstperson-static-inches.json` | the firstperson preset's `dressed` §17.7 world (z-up, inches, verbatim from genex-demo's `netcode-bench` preset vectors, §17.7 hash 1340734173): balls dropped on every kind of piece, the preset player walking through, then rays, an overlap and a shape cast |
| `vehicle-hull-pushing-props.json` | a car-sized hull at `lengthUnit` 100 driven into 12 props |
| `ccd-balls.json` | eight 200 m/s CCD balls against a 4 cm wall |
| `query-and-event-ordering.json` | keys spawned out of order, a kinematic probe through a sensor, every query kind with filters |
| `hostile-commands-each.json` | every command error code once in `"each"` mode, the hash unchanged after each refusal |
| `hostile-commands-atomic.json` | the same commands one batch each in `"atomic"` mode |
| `escaped-bodies.json` | one body leaving `worldExtent`: listed in `escaped` once, then frozen |
| `snapshot-round-trip.json` | a heap snapshotted and restored mid-scene, right after a joint edit, twice |
| `key-64-bytes.json` | a body whose key is exactly 64 bytes, with a 32-byte kind |
| `full-17-7-world.json` | the largest §17.7 world: 4096 boxes and 512 ramps, with `physicsHash` |
| `memory-limit.json` | spawns past `limits.memoryBytes` give `limit-memory` and leave the world unchanged |

Not a vector:

- **Worst case at default limits (§11.2)** is a measurement, not an expectation: `tests/bench.rs`
  (`cargo test --release --test bench -- --ignored --nocapture`) prints mean, p99 and worst per step at
  both schedules.
- **Codes no §16 operation reaches:** `limit-static` (a vector's `static` is imported when the world
  opens, so a refused one is no scene), `contract-mismatch` (the file's own `world.contract`),
  `bad-snapshot` and `build-mismatch` (`snapshotRestore` restores the world's own snapshot, never foreign
  bytes) and `internal` (a core failure). Their rows are in `tests/static_world.rs`, `tests/world_desc.rs`,
  `tests/snapshot.rs` and `tests/hostile.rs`. A test holds the vectors to every other §14 code.

## Run and rewrite

From the repository root, with the pinned toolchain:

```sh
node scripts/toolchains/rust-env.ts -- cargo test -p genex-physics --test vectors --offline --locked
GENEX_PHYSICS_WRITE_VECTORS=1 node scripts/toolchains/rust-env.ts -- \
  cargo test -p genex-physics --test vectors --offline --locked -- --ignored write_vectors
```

The second command rewrites every file from the scenes in `tests/vectors.rs` (the only generator); a test
holds each file to its scene, so a hand edit fails. The set stays under 2 MB.

## Determinism row

The same pins pass on every target the row runs; a target that differs is a determinism break.

| Target | How it ran | Result |
|---|---|---|
| aarch64-macos | native `cargo test` | every vector passes |
| x86_64-linux | `cargo zigbuild -p genex-physics --tests --target x86_64-unknown-linux-gnu --offline --locked` (the toolchain's cargo-zigbuild and zig, offline), each test binary then run in Docker `amd64/debian:bookworm-slim` with `--network none` and the crate mounted at its own path | every vector passes, and every other genex-physics test (2026-10-27; amd64 emulated on an arm64 Mac) |
| wasm32, Node 24 | `tests/conformance/physics-wasm-vectors.test.ts` on the shipped package (`../js/conformance.js`) | every vector passes on aarch64-macos, and in Docker `node:24-bookworm` linux/amd64 with `--network none` (2026-10-27) |
| wasm32, Chromium | the same file's browser row (`STUDIO_BROWSER_TESTS=1`): Playwright's headless Chromium loads the browser entry and the same runner, every request answered from disk | every vector passes (HeadlessChrome 153, aarch64-macos, 2026-10-27) |

## Release

The engine lane publishes this folder with each core release; genex-demo vendors it into
`packages/netcode-bench` with a PROVENANCE pin naming the release and `build`.
