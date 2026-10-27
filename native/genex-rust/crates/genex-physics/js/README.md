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
  `out-of-range`; so does an `apply` of more than 16,384 commands, as one failure in either mode. A
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
| wasm32, Node 24 | dt 1/60, 1 substep | 1.264 / 1.775 | 1.784 / 2.555 |
| wasm32, Node 24 | dt 1/20, 3 substeps | 3.666 / 4.705 | 4.207 / 5.344 |
| native x86_64-linux (droplet) | both | pending the owner-approved run | |

In WASM the 1/60 tick mean is over the authority host's 1 ms meter (§11.4); the worst tick stays under
8 ms. Correcting every body each tick (512 `exportBodyState` + `importBodyState`) costs about 10 ms a
tick more in WASM.

## Building

The package is built offline from `native/genex-rust` by `node scripts/physics-wasm.ts`
(cargo through the pinned toolchain with source paths made relative, wasm-bindgen 0.2.129, the
toolchain's own `wasm-opt -Oz`, a check that the module holds no absolute path of the build machine,
then `npm pack` into `.studio-dev/dist/` with a `.sha256` beside the tarball). `--test` builds the test flavour its
tests load (`tests/conformance/physics-wasm-real.test.ts`). The Rust exports are
`crates/genex-physics-wasm`; this wrapper is `core.js`, with the entries `index.js` and `node.js`.

## Licence

MIT (`LICENSE`). The module includes compiled code of rapier3d, parry3d, nalgebra and simba
(Apache-2.0) and of other crates under MIT, Apache-2.0, Zlib or Unicode-3.0 terms (glamx, serde,
serde_json, postcard, wasm-bindgen, libm and more). `THIRD-PARTY-NOTICES.md` lists every one with
its licence and authors, and holds their licence and notice texts.
