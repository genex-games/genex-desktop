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
  cyclic object) give `bad-command`, as in the command JSON form (§7.3). An input larger than any
  world accepts (over 128 Mi characters of JSON) gives `out-of-range` before it reaches the
  instance; a snapshot over 512 MiB gives `bad-snapshot`.
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

## Building

The package is built offline from `native/genex-rust` by `node scripts/physics-wasm.ts`
(cargo through the pinned toolchain, wasm-bindgen 0.2.129, `wasm-opt -Oz`, then `npm pack` into
`.studio-dev/dist/` with a `.sha256` beside the tarball). `--test` builds the test flavour its
tests load (`tests/conformance/physics-wasm-real.test.ts`). The Rust exports are
`crates/genex-physics-wasm`; this wrapper is `core.js`, with the entries `index.js` and `node.js`.

## Licence

MIT. The module includes compiled code of rapier3d, parry3d, nalgebra and simba (Apache-2.0), of
glamx, serde, serde_json, postcard and wasm-bindgen (MIT or Apache-2.0) and of libm (MIT).
