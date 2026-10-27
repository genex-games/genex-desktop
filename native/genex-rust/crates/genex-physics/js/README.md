# @genex-ai/physics

Genex Physics in WebAssembly: one deterministic physics world per caller, addressed by your own keys,
for Node 24 and evergreen browsers. It is the TypeScript binding of the Layer 1 contract 1.0
(`CONTRACT.md`, shipped beside this file; § numbers below are its own), over the same Rust core as
native Genex games, with Rapier 0.36 as its backend.

Version 0.1.0 is a staging build. `1.0.0` is published with the owner's release.

## Use

```js
import { World } from "@genex-ai/physics"; // Node 24 loads the module on import

const made = World.create({ contract: "1.0", dt: 1 / 60, substeps: 1, gravity: [0, -9.81, 0], upAxis: "y", lengthUnit: 1 });
if (!made.ok) throw new Error(made.code);
const world = made.world;
world.spawn({
  key: "crate.1",
  type: "dynamic",
  pose: { p: [0, 2, 0], q: [0, 0, 0, 1] },
  colliders: [{ key: "c", shape: { kind: "box", half: [0.5, 0.5, 0.5] } }],
});
const step = world.step(); // { ok: true, tick: 1, events: [], overflowed: false, escaped: [], memoryExceeded: false }
world.free();
```

In a browser, `await init()` first. It fetches `wasm/genex_physics_wasm_bg.wasm` beside the glue,
or takes `init({ module })` (a `WebAssembly.Module` or its bytes). A bundler resolves the package's
`default` entry; Node resolves `node`. `index.d.ts` is the whole API.

## Rules

- **Errors are values.** Every call that can fail returns `{ ok: true, … }` or
  `{ ok: false, code, index?, detail }` with a code from `PhysicsError` (§14). Branch on `code`,
  never on `detail`. No method throws on any input. A failed call changes nothing.
- **Numbers become f32 on entry** (§4.1), as `Math.fround`, and every check sees the rounded value.
  NaN, ±Infinity and numbers too large for f32 give `non-finite`. The static world's values must
  already be exact float32s (§6.5).
- **Wrong types** (a string where a number belongs, a missing field, an unknown one, a BigInt, a
  cyclic object) give `bad-command`, as in the command JSON form (§7.3), and so does an argument
  that throws while it is read (a getter, a Proxy, a revoked Proxy); a snapshot that is not a real
  `Uint8Array` gives `bad-snapshot`. Arguments are read once, never handed to the module as given.
- **Each call has an input budget** (§11.1, §11.3), checked before anything crosses: the module
  parses a call's JSON whole, in linear memory no world is charged for and that WebAssembly never
  gives back. A call carries at most 524,288 JSON values and 8 Mi characters, plus one heightfield or
  trimesh as large as the world's own limits admit (`max(heightfieldSamples, 16 × triangles)` more
  values of 24 characters each); text with non-ASCII characters counts three per character. At the
  default limits that is 1,572,864 values and 32 Mi characters. Past it the call gives
  `out-of-range`; so does an `apply` of more than 16,384 commands, as one failure in either mode,
  and an `importStates` or `queryMany` of more than 16,384 entries. A
  snapshot over 512 MiB gives `bad-snapshot`. Measured at the default limits, the heaviest input
  the budget admits (a 1,048,576-sample heightfield) grows the instance's memory by about 117 MB
  once and every other stays within that; at the 4× ceiling expect about four times as much.
- **Reads with no error channel** (`body`, `bodies`, `exportChanged`, `exportBodyState`, `stats`,
  the hashes, `snapshot`, `tick`) return their empty forms for anything they cannot answer: a
  malformed filter, a freed world, a failed instance.
- **Memory per world** (§11.1): the module's allocator charges every allocation to the world whose
  call made it, so `stats().memoryBytes` is that world's exact live bytes even with many worlds in
  one instance. `LimitMemory` refusals are judged before anything is allocated.
- **`stats().stepMs`** is the wall time the wrapper measured around the last `step()`, for display
  only (§11.4).

## Bulk calls (§19, additive to 1.0, pending sign-off)

Two calls take a whole tick's work in one crossing; each means exactly a sequence of 1.0 calls.

- `world.importStates(keys, data)` imports many bodies' replicated fields, `data` a `Float32Array` (or
  number array) of 14 numbers per key in `exportChanged`'s layout, so `exportChanged`'s output imports
  as read (leave out fixed bodies). It is all or none: the first refusal names its `index` and nothing
  changes; when all pass the world ends as one `importBodyState` per key in order leaves it.
- `world.queryMany(queries)` runs §13's JSON queries and returns one result per query, each what
  `query()` would return for it, `queriesPerStep` counted the same; only a malformed call (not a list,
  over the budget or 16,384 queries, `internal`) is one failure instead of a list.

## If the instance fails (§11.3)

The core must not trap. If it ever does, the WebAssembly instance is unusable, so the wrapper marks
it poisoned: every call with a result answers `internal` on every world, the reads give their empty
forms, and `world.check()` names the failure (`desc()` stays readable). End those worlds, then
`await init()` makes a new instance, and `World.create` works again. Worlds of the old instance stay
`internal`.

## Measured worst case (§11.2)

The required scene at default limits (512 bodies in one heap, 64 joints, 16 CCD bodies, 64 queries a
step; 10 s measured after 1 s), on a Mac M-series (arm64), idle. Native is `tests/bench.rs`
(`cargo test --release --test bench -- --ignored --nocapture`), wasm32 is this package in Node
v24.18.0 (`node scripts/physics-wasm-bench.ts`). Milliseconds, mean / p99.

| Target | Schedule | step | tick (with commands and queries) |
|---|---|---|---|
| native aarch64-macos | dt 1/60, 1 substep | 0.494 / 0.787 | 0.612 / 1.054 |
| native aarch64-macos | dt 1/20, 3 substeps | 1.437 / 2.148 | 1.561 / 2.425 |
| wasm32 (SIMD), Node 24 | dt 1/60, 1 substep | 0.764 / 1.355 | 1.294 / 2.071 |
| wasm32 (SIMD), Node 24 | dt 1/20, 3 substeps | 2.149 / 3.619 | 2.707 / 4.406 |
| native x86_64-linux, DigitalOcean s5 (AMD EPYC 9555P) | dt 1/60, 1 substep | 0.746 / 1.235 | 0.897 / 1.644 |
| native x86_64-linux, DigitalOcean Premium Intel | dt 1/60, 1 substep | 1.978 / 3.795 | 2.334 / 4.442 |

The module is built with WebAssembly SIMD (simd128): every vector and the bench's `stateHash` are the
same bits as without it, and a step is 1.6-1.9x faster. Node 24 and every current browser run SIMD
(Safari since 16.4). In WASM the 1/60 tick mean is over the authority host's 1 ms meter (§11.4) on
this worst case; the worst tick stays under 8 ms. Correcting every body each tick costs, in the test build on the same Mac: about 6.3 ms as 512
`exportBodyState` + `importBodyState` calls, and about 0.3 ms as one `exportChanged` + `importStates`
(§19.1). Either way the first query after the corrections pays about 3.5 ms more, the backend
refreshing 512 moved bodies. The 64 queries as one `queryMany` take about 0.44 ms against 0.53 ms one
call each: most of a query's cost is its work and its JSON, not the crossing.

## Building

The package is built offline from `native/genex-rust` by `node scripts/physics-wasm.ts`
(cargo through the pinned toolchain with source paths made relative, wasm-bindgen 0.2.129, the
toolchain's own `wasm-opt -Oz`, a check that the module holds no absolute path of the build machine,
then `npm pack` into `.studio-dev/dist/` with a `.sha256` beside the tarball). `--test` builds the test flavour its
tests load (`tests/conformance/physics-wasm-real.test.ts`). The Rust exports are
`crates/genex-physics-wasm`, a thin shell over `crates/genex-physics-binding`; this wrapper is `core.js`, with the entries `index.js` and `node.js`.

## Licence

MIT (`LICENSE`). The module includes compiled code of rapier3d, parry3d, nalgebra and simba
(Apache-2.0) and of other crates under MIT, Apache-2.0, Zlib or Unicode-3.0 terms (glamx, serde,
serde_json, postcard, wasm-bindgen, libm and more). `THIRD-PARTY-NOTICES.md` lists every one with
its licence and authors, and holds their licence and notice texts.
