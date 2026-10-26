# Genex Physics: Layer 1 contract 1.0

Status: **1.0, signed by the owner on 2026-10-27.** It is shared by this repo (the core and its bindings)
and genex-demo (the authority host), whose PROTOCOL §17.10 references it. A change is a reviewed change both
sides sign off (§2).

Words: **must** is required of every build (native, WASM/TS, C later); **should** is recommended. "Core" is
the Genex Physics library. "Backend" is the physics engine inside it (Rapier 0.36 in 1.0). "Caller" is whoever
owns the world: the authority host, a Rust game, or a predicting client in release 2.

---

## 1. Principles

1. **One world per caller instance, single-threaded.** No threads, no random numbers, no clock, no
   allocation-order dependence visible through the API.
2. **Deterministic per build.** For the same `buildId`, the same world description and the same sequence of
   calls give the same `stateHash()` after every step, on every target in the published determinism row. In
   1.0 the row is Mac ARM native, Linux x86_64 native, and wasm32 in Node and Chromium. Other targets
   (Windows, iOS, Android) join when they are added to the row.
3. **No backend types cross the API.** The backend's handles, sets and structs are never visible. Everything
   is addressed by caller keys. A different backend is a different `buildId`, never a different API.
4. **The caller owns time and space.**
   - The caller passes `dt`, `substeps`, `upAxis` and `lengthUnit`.
   - The core never picks a time step and never rescales coordinates.
5. **Errors are values.** No call panics, throws an unhandled exception or aborts on any input. Every
   failure is a typed `PhysicsError` code, and a failed call changes nothing. §11.3 says what happens if the
   core itself fails.
6. **Network state is not bit-exact on its own in contract 1.x.** Stepping from imported pose, velocity and
   sleep alone may differ from the world that exported them (§9.3). The `canonicalize()` operation that
   would close this gap is reserved for release 2 (§12).

## 2. Versioning and identity

- **Contract version:** semver. A breaking change is a major version and needs both chats and the owner. An
  additive change is a minor version.
- **`buildId`:** a string that names everything that can change results:

  `genex-physics/<core semver>+contract-<major.minor>+<backend>-<backend version>+<features>+<target>`

  For example `genex-physics/1.0.0+contract-1.0+rapier-0.36.0+det+wasm32`. Determinism is promised only
  between equal `buildId`s up to the `+<target>` suffix.
- **`physicsHash`:** 16 lowercase hex digits, the FNV-1a 64 of the canonical JSON in §10.2. Only the core
  computes it (`world.physicsHash()`).
  - PROTOCOL §17.10 carries it as a `physics` field in the resolved module config. Preset `params` are
    per-preset tables of numbers, and a room may have no preset, so it can't live there.
  - A client that joins compares it with the server's; a mismatch is reported, never silently stepped.
  - It is **not** §17.7's `params.world`, the 32-bit FNV-1a of the static world alone, which presets use
    and which stays unchanged.

## 3. Keys

- A **key** is 1 to 64 bytes from `[A-Za-z0-9_.:\-]`. Anything else gives `InvalidKey`: another character,
  empty, over 64 bytes, or one of the names `__proto__`, `constructor` and `prototype`. Those three fit the
  charset, so they are refused by name.
- The prefix `static:` is reserved for static pieces (§6.5). A body, collider or joint key that starts with
  it gives `InvalidKey`.
- **Authority entity ids are wider:** any 1-64 UTF-16 characters except those three names, with no charset.
  So the narrowing happens on the protocol side. Host fresh ids (`e<n>`) and projectile ids
  (`<seat>.<cseq>.<n>`) fit; ids a module chooses may not. PROTOCOL §17.10 states that an entity with a
  physics body must have a contract key, and `ctx.physics` refuses any other id with `InvalidKey` before the
  command reaches the core.
- Keys are unique per kind: bodies, colliders (scoped to their body), joints and static pieces.
- **Order:** wherever the contract says "key order", it means byte-wise ascending order. For this ASCII
  charset that equals JavaScript's default string order, so a TS caller may sort with `<`.
- Every list the core returns (bodies, events, query results, stats) is in key order unless stated.
- A removed key may be reused in a later call; the new object is unrelated to the old one.

## 4. World description

```ts
interface WorldDesc {
  contract: "1.0";
  dt: number;            // seconds per step(), > 0 and <= 0.1
  substeps: number;      // integer 1..8; each inner step is dt / substeps
  gravity: Vec3;         // caller frame and units per s²
  upAxis: "y" | "z";     // the caller's up axis (§5)
  lengthUnit: number;    // caller length units per metre, > 0: 1 for metres, 39.37 for Source inches (§5)
  limits?: Partial<Limits>;   // defaults in §11
  solver?: { iterations?: number /* integer 1..16, default 4 */ };
}
```

- `dt` and `substeps` are fixed for a world's life; changing them means a new world.
- **Recommended schedules:** an authority room at 20 / 30 / 60 Hz uses `dt` 1/20, 1/30, 1/60 with `substeps`
  3, 2, 1. Rust games use `dt = 1/60, substeps = 1`.
- A `contract` other than `"1.0"` gives `ContractMismatch`. Any other bad field gives `OutOfRange` or
  `NonFinite`, and no world is created.
- **The resolved description** is the description with every default filled in, `limits` included. It is
  what `physicsHash` covers and what `snapshot()` carries.

### 4.1 Numbers

- **Every number is rounded to f32 on entry** (round to nearest, ties to even, as `Math.fround`). Every check
  applies to the rounded value, so 1e39 gives `NonFinite`. The core computes in f32.
- `-0` is read as `0` wherever a sign is meaningless (sizes, radii, limits).
- **Integer fields** (`substeps`, `iterations`, `rows`, `cols`, masks, indices, limits) must hold an integer;
  1.5 gives `OutOfRange`.
- **Bounds:**
  - every body position and joint anchor a command sets lies within `limits.worldExtent` of the origin, per
    axis;
  - every linear speed a command sets is at most `limits.maxSpeed`, every angular speed at most
    `limits.maxAngularSpeed`;
  - otherwise the command gives `OutOfRange`. Static pieces (§6.5) are exempt, so any world §17.7 accepts
    is accepted.

## 5. Axes and units

- **The core's internal frame is right-handed and Y-up.**
- **`upAxis: "z"`** (the authority server): the core maps every caller vector and point (x, y, z) to internal
  (x, z, −y), and back with (x, y, z) → (x, −z, y). This applies to:
  - positions, velocities, gravity, impulses, normals, ray origins and directions, half-extents, and joint
    anchors and axes;
  - quaternion vector parts, (qx, qy, qz, qw) → (qx, qz, −qy, qw). This is the same rotation, 90° about x;
    `w` is unchanged.
  - **Heightfields:** the caller's grid lies on its ground plane (x, y) with heights along z. Internally it
    lies on (x, −z) with heights along y, so the core flips the grid's row order (§6.3).

  The mapping is only component swaps and sign flips, so it's **bit-exact** and invertible. Round-tripping
  any finite value gives the same bits, except that −0.0 and +0.0 may swap under negation. The hash
  normalizes zero (§10).
- **`upAxis: "y"`:** no mapping.
- **Units:**
  - **Length:** the caller's own units. The core never multiplies coordinates. `lengthUnit` only tunes the
    backend's tolerances (for Rapier, `IntegrationParameters::length_unit`).
  - **Time:** seconds. **Angles:** radians. **Mass:** kilograms.
  - **Density:** kg per caller-unit³. **Impulse:** kg · caller-unit / s.
  - **Friction and restitution:** unitless.
- **Authority presets differ in units:** `firstperson` is in Source inches (`lengthUnit` 39.37, gravity
  800), `vehicle` in about centimetres (`lengthUnit` about 100, gravity 650), `topdown` in metres.

## 6. Objects

### 6.1 Bodies

```ts
interface BodyDesc {
  key: Key;
  type: "dynamic" | "fixed" | "kinematic";
  pose: Pose;                  // { p: Vec3, q: Quat } in the caller frame; |q| within 1e-4 of 1, renormalised by the core
  linvel?: Vec3; angvel?: Vec3; // dynamic only
  colliders: ColliderDesc[];   // 1..limits.collidersPerBody
  linearDamping?: number; angularDamping?: number; // >= 0
  gravityScale?: number;       // default 1
  lockRotation?: [boolean, boolean, boolean];      // per caller axis
  ccd?: boolean;               // counts toward limits.ccdBodies
  canSleep?: boolean;          // default true
  kind?: string;               // optional caller tag: 1..32 bytes of the key charset, echoed in events and exports
}
```

- **Kinematic bodies** move only through `setNextKinematicPose` (§7.2).
- **Fixed bodies** move only through `setPose` (a teleport).
- **Mass** comes from collider densities, unless a collider sets `mass`.
- **`kind`:** authority kinds are any string up to 64 characters, `''` included. PROTOCOL §17.10 limits
  physics kinds to 1-32 bytes of the key charset; `''` means no kind.

### 6.2 Colliders

```ts
type Shape =
  | { kind: "box"; half: Vec3 }
  | { kind: "sphere"; radius: number }
  | { kind: "capsule"; halfHeight: number; radius: number; axis: "x" | "y" | "z" }   // axis in the caller frame
  | { kind: "hull"; points: Vec3[] }          // 4..limits.hullVertices points; the core computes the hull
  | { kind: "trimesh"; vertices: Vec3[]; indices: [number, number, number][] }  // fixed bodies only
  | { kind: "heightfield"; rows: number; cols: number; heights: number[]; size: Vec3 }; // fixed bodies only (§6.3)

interface ColliderDesc {
  key: Key;                    // unique within its body
  shape: Shape;
  offset?: Pose;               // relative to the body
  density?: number; mass?: number;      // one of them; default density 1
  friction?: number;           // default 0.5
  restitution?: number;        // default 0
  groups?: { member: number; collides: number };  // 16-bit masks each; default all
  sensor?: boolean;            // a trigger: no contact response, only trigger events
  events?: boolean;            // report contact events (§8.1); default false
}
```

- A trimesh or heightfield on a non-fixed body gives `DynamicMesh`.
- A degenerate shape (a zero extent, a hull whose points are all in one plane) gives `BadShape`.
- **Contact events are opt-in.** A contacting pair reports `contactBegin`/`contactEnd` only when either of
  its colliders has `events: true`. Sensors always report trigger events. Without the opt-in, a dense heap
  would fill `limits.eventsPerStep` every step and drop the events a game cares about.

### 6.3 Heightfield grid

- `heights` is row-major, `rows × cols` values; `rows` and `cols` are integers ≥ 2, and
  `rows × cols ≤ limits.heightfieldSamples`.
- Sample (r, c) lies at ground coordinates (`size.x · (c / (cols − 1) − 0.5)`, `size.<ground2> · (r / (rows − 1) − 0.5)`)
  with height `heights[r·cols + c] · size.<up>`.
- For `upAxis: "y"`, ground2 is z and up is y. For `upAxis: "z"`, ground2 is y and up is z, and the core
  reverses the row order internally to apply §5's mapping. A caller never reorders anything.
- Each cell's split into two triangles follows the backend's internal grid. Which diagonal that is in the
  caller's grid is stated in the core's docs, per `upAxis`.

### 6.4 Joints

```ts
interface JointDesc {
  key: Key; a: Key; b: Key | null;     // b = null attaches to the world
  type: "fixed" | "hinge" | "ball" | "slider" | "rope";
  anchorA: Vec3; anchorB: Vec3;        // in each body's local frame (the caller frame's axes)
  axis?: Vec3;                         // hinge and slider; non-zero
  limits?: [number, number];           // radians (hinge) or caller units (slider, rope max length)
  motor?: { targetVel?: number; targetPos?: number; stiffness?: number; damping?: number; maxForce?: number };
  collideConnected?: boolean;          // default false
}
```

### 6.5 Static world import

`addStaticWorld({ boxes, ramps })` takes PROTOCOL §17.7's *World* exactly. Quoted verbatim from §17.7:

> *World.* `{ boxes: [[minX, minY, minZ, maxX, maxY, maxZ], …], ramps: [[minX, minY, minZ, maxX, maxY, maxZ, axis, lo, hi], …] }`. A ramp is a box whose top is a plane rising along x (`axis` 0) or y (`axis` 1), at height `lo` at that axis's min end and `hi` at its max end. A world is refused unless it has at most 4096 boxes and 512 ramps, each an array of exactly six (box) or nine (ramp) numbers, every value is a float32 (`float32(v) = v`) of magnitude at most 1e9 (−0 is read as 0), min < max on every axis, and each ramp has `axis` 0 or 1, `minZ ≤ lo`, `minZ ≤ hi` and `maxZ = max(lo, hi)`. Its order is the order given: solids are indexed boxes first (0 … B−1), then ramps (B … B+R−1). The world is fixed for a room's life and never enters the state or crosses the wire.

- **Validation:** the same rules as §17.7, so a world §17.7 refuses is refused here, with `OutOfRange`,
  `NonFinite` or `BadShape`.
- **Frame:** §17.7 worlds are z-up, so `addStaticWorld` requires `upAxis: "z"`; otherwise it gives
  `OutOfRange`.
- **Once per world.** A second call gives `DuplicateKey`.
- **Pieces:** one fixed body per solid, with one collider. Its body key and collider key are both
  `static:box:NNNN` or `static:ramp:NNNN`, where `NNNN` is the solid's index within its own list,
  zero-padded to 4 digits. Key order then equals §17.7's index order, and events, queries and `overlap`
  name a piece the same way. `remove`, `setPose` and every other command on a static key give `UnknownKey`.
  - A **box** is a `box` collider centred on its middle.
  - A **ramp** is a `hull` of 8 points: its 4 bottom corners at `minZ`, its 2 top corners at the `axis` min
    end at height `lo`, and its 2 top corners at the max end at height `hi`. Corners that coincide (`lo = minZ`
    or `hi = minZ`) are merged, leaving a 6-point wedge. Because `maxZ = max(lo, hi) > minZ`, the hull is
    never flat. (The ramp's top at a point is `lo + (hi − lo) / (m1 − m0) · (u − m0)`, with `m0`, `m1` its min
    and max along `axis`.)
- **Limits:** static pieces don't count toward `limits.bodies` or `collidersPerBody`; they count toward
  `limits.staticPieces` (default 4608 = 4096 + 512), so any world §17.7 accepts is accepted here.
- **How the host gets the world:** today the world is validated and compiled inside the sandbox prelude
  only, and a full world is far over the 32 KiB InitOut cap. PROTOCOL §17.10 defines the host's path.
- **Same geometry, different shapes:** presets collide against an axis-aligned sweep of their own hull (box or
  car) grown by `r`, while physics bodies collide against the true hull. The geometry is shared; the shapes
  that hit it differ, so preset and physics contacts are not expected to agree bit for bit.

## 7. Commands

All commands are applied **in the order given**, before the next `step()`. The authority host fixes that
order from the module's `phys` array, so it's deterministic. Every command that names a key also gives
`InvalidKey` for a malformed one, and every command that takes numbers also gives `NonFinite` and
`OutOfRange` (§4.1).

| Command | Effect | Errors (besides the above) |
|---|---|---|
| `spawn(BodyDesc)` | inserts the body and its colliders | `DuplicateKey`, `LimitBodies`, `LimitColliders`, `LimitHullVertices`, `LimitTriangles`, `LimitCcd`, `LimitMemory`, `BadShape`, `DynamicMesh` |
| `remove(key)` | removes the body and its colliders, and every joint that references it | `UnknownKey` |
| `addJoint(JointDesc)` / `removeJoint(key)` | joints | `DuplicateKey`, `UnknownKey`, `LimitJoints`, `LimitMemory` |
| `impulse(key, j, at?)` | applies a linear impulse (and torque, if `at` is a world point) to a dynamic body; wakes it | `UnknownKey`, `WrongBodyType` |
| `setVelocity(key, linvel?, angvel?)` | sets velocities on a dynamic body; wakes it | `UnknownKey`, `WrongBodyType` |
| `setPose(key, pose, { resetVelocity?: boolean /* default false */, wake?: boolean /* default true */ })` | teleports a dynamic or fixed body. A respawn (the module changes the entity's `epoch`) is one command: `resetVelocity: true, wake: true` | `UnknownKey`, `WrongBodyType` (kinematic) |
| `setNextKinematicPose(key, pose)` | target pose for a kinematic body at the end of the next `step()` (§7.2) | `UnknownKey`, `WrongBodyType` |
| `areaPush(center, radius, strength, falloff, groups?)` | an impulse on every dynamic body whose origin lies within `radius` of `center`: `strength · (1 − d/radius)^falloff` along (centre → body origin), in key order; pushed bodies wake. A body at exactly the centre gets no push. `radius` > 0, `falloff` ≥ 0 | (none) |
| `setMotor(jointKey, motor)` | changes the motor targets | `UnknownKey` |
| `wake(key)` / `sleep(key)` | forces the sleep state | `UnknownKey` |

### 7.1 Batches

`apply(commands[], mode: "atomic" | "each")` applies a list, in order.
- **`"atomic"`:** if any command fails, none applies, and the result names the first failing index and its
  code.
- **`"each"`:** every command that succeeds is applied, in order. It returns one result per command,
  `{ ok: true } | { ok: false, code }`. A failed command changes nothing, and the commands after it still apply.

The authority host uses `"each"`, so one stale key (a body removed earlier in the tick) can't cancel the rest
of the tick. It hands failures back to the module in the next `tickIn` as `physRefused: [[index, code], …]`.
What repeated refusals cost the module is the host's rule (PROTOCOL §17.10). Rust games may use `"atomic"`.

### 7.2 Kinematic interpolation

Over a `step()` with `n` sub-steps, a kinematic body moves from its current pose to the target:
- the position by linear interpolation at fractions k/n;
- the rotation by normalized linear interpolation (nlerp) at k/n, taking the shorter arc.

Without a new target, it keeps its last pose (velocity zero).

### 7.3 The command JSON form

`apply()`, the conformance vectors (§16) and §17.10's `phys` array share one form. A command is an object
with exactly one key, the verb's name, whose value is an object of its named arguments:

| Verb | Arguments |
|---|---|
| `spawn` | a `BodyDesc` |
| `remove`, `removeJoint`, `wake`, `sleep` | `{ key }` |
| `addJoint` | a `JointDesc` |
| `impulse` | `{ key, j: Vec3, at?: Vec3 }` |
| `setVelocity` | `{ key, linvel?: Vec3, angvel?: Vec3 }` |
| `setPose` | `{ key, pose, resetVelocity?, wake? }` |
| `setNextKinematicPose` | `{ key, pose }` |
| `areaPush` | `{ center: Vec3, radius, strength, falloff, groups? }` |
| `setMotor` | `{ key, motor }` |

For example `{ "impulse": { "key": "crate.1", "j": [0, 0, 50], "at": [0, 0, 10] } }`. An object with no key,
more than one key, an unknown verb, a missing argument or an unknown argument gives `BadCommand`.

## 8. Stepping

`step()` advances `dt`: `substeps` inner steps of `dt / substeps`, the commands queued before it applied
first. It returns a `StepResult`:

```ts
interface StepResult {
  tick: number;                // world tick counter after this step (starts at 0)
  events: PhysicsEvent[];      // §8.1
  overflowed: boolean;         // true when events were dropped past limits.eventsPerStep
  escaped: Key[];              // §8.2, key order
  memoryExceeded: boolean;     // true when the world ended this step over limits.memoryBytes (§11.1)
}
```

### 8.1 Events

```ts
type PhysicsEvent =
  | { kind: "contactBegin"; a: Key; b: Key; ca: Key; cb: Key; ka?: string; kb?: string; impulse: number; point: Vec3; normal: Vec3 }
  | { kind: "contactEnd";   a: Key; b: Key; ca: Key; cb: Key; ka?: string; kb?: string }
  | { kind: "triggerEnter"; sensor: Key; sc: Key; other: Key; oc: Key; ks?: string; ko?: string }
  | { kind: "triggerExit";  sensor: Key; sc: Key; other: Key; oc: Key; ks?: string; ko?: string };
// ka/kb (ks/ko) are the bodies' `kind` tags, so a module can filter by kind without looking keys up.
```

- Contact events come only from pairs with an opted-in collider (§6.2).
- `a < b` in key order (and for triggers, by sensor). `ca` and `cb` are collider keys.
- `impulse` is the total normal impulse over the step. `point` and `normal` are the deepest contact at the
  first sub-step where the pair touched, normal pointing from a to b.
- **Order:** by (sub-step, kind order Begin < End < Enter < Exit, a, b, ca, cb).
- A pair that begins and ends within one step reports both.
- Static pieces appear with their `static:` keys.
- Past `limits.eventsPerStep`, the remaining events are dropped in order and `overflowed` is set.
- **The sandbox form is the host's:** today's TickIn and TickOut use objects. §17.10 defines a fixed-array
  form for physics events in `tickIn`, `[kindCode, a, b, ca, cb, ka, kb, impulse, px, py, pz, nx, ny, nz]`
  (end and trigger events stop after `kb`), with `overflowed` passed on. The core only produces the events
  above.

### 8.2 Escaped bodies

After each `step()`, a body is **escaped** when its position lies outside `limits.worldExtent` on any axis,
or any of its state is non-finite.
- A non-finite body is put back to its pose at the start of that step.
- An escaped body is frozen: velocities zero, asleep, and it no longer wakes.
- It is listed in `StepResult.escaped` once, on the step it escaped. It stays frozen until it is removed or
  `setPose` puts it back inside.
- The authority host removes escaped bodies (PROTOCOL §17.10).

## 9. State

### 9.1 Reading

- `body(key) → BodyState | null`, where
  `BodyState = { key, kind?, type, pose, linvel, angvel, sleeping }`, in the caller frame.
- `bodies(filter?) → BodyState[]`, in key order. The filter takes `{ kinds?, awakeOnly?, changedSinceTick? }`.
  - **"Changed after tick T"** means some command or step after tick T changed the f32 bits of any
    `NetBodyState` field. The core keeps one last-changed tick per body. A body spawned after T is changed;
    an awake body that didn't move isn't.
  - Removals aren't listed: the caller issued them.
- **`exportChanged(sinceTick) → { keys: string[], data: Float32Array }`:** the flat per-tick read for the
  host. One call and one copy instead of N objects.
  - `data` holds 14 numbers per body, in the same key order as `keys`: p(3), q(4), v(3), w(3), sleeping(1, as
    0 or 1).
  - It uses the same "changed" rule as above.

### 9.2 Network state

- `exportBodyState(key) → NetBodyState`, where
  `NetBodyState = { p: Vec3, q: Quat, v: Vec3, w: Vec3, sleeping: boolean }`. These are exactly the
  replicated fields, as f32 values in the caller frame.
- `importBodyState(key, NetBodyState)` sets them on an existing dynamic or kinematic body.
  - It wakes or sleeps the body as given.
  - Importing quantized values is allowed, so an imported state is never assumed equal to the exporting
    world's f32 state. (The §17.10 wire packs q into ±1, v into ±64 · `lengthUnit` per second and w into
    ±64 rad/s; angular velocity doesn't scale with length. Those ranges are the wire's, not the core's.)
  - An import is a correction: on its own, it isn't a promise of bit-exact future steps (§9.3).

### 9.3 What is and isn't reproducible

- `snapshot()` / `restore()` (§9.4) restore everything, including solver caches, so stepping after a restore
  matches the original world bit for bit for the same `buildId`.
- Rebuilding a world from `NetBodyState`s alone (spawning from descriptors, then importing) does **not**
  promise to match. Warm-start impulses, contact caches, internal ordering and sleep timers are missing.
- Release 2's `canonicalize()` (§12) is how that gap may close.

### 9.4 Snapshot and restore

- `snapshot() → bytes`: an opaque byte string, specific to the backend.
  - It starts with a header: the magic `GXPH`, the contract major and minor, the `buildId`, the tick, and an
    FNV-1a 64 checksum of the payload.
  - It carries the resolved `WorldDesc` (limits included), the static world, and every body, collider and
    joint.
  - It's for the same `buildId` (any target).
- `restore(bytes)` replaces the whole world, its description and limits included.
  - A wrong magic, a truncated input or a bad checksum gives `BadSnapshot`.
  - A different `buildId` (ignoring the target) gives `BuildMismatch`.
  - A world that wouldn't fit `limits.memoryBytes` gives `LimitMemory`.
  - On failure the world is unchanged.
- Snapshots are for server replay, resync and saves, never sent to clients in release 1.

## 10. Hashes

### 10.1 `stateHash() → u64`

Shown as 16 lowercase hex digits in JSON. It's FNV-1a 64 over:
1. the tick (u64 LE);
2. for each body in key order (static pieces excluded): the key bytes, a 0 byte, the type (u8: dynamic 0,
   fixed 1, kinematic 2), then `p`, `q`, `v` and `w` as f32 little-endian bits in the **caller frame**, with
   −0.0 written as +0.0, then `sleeping` (u8);
3. for each joint in key order: the key bytes, a 0 byte, and its motor's `targetVel`, `targetPos`,
   `stiffness`, `damping` and `maxForce` as f32 bits, in that order, an absent value as 0.

### 10.2 `physicsHash`

FNV-1a 64 over canonical JSON of `{"build": …, "static": …, "world": …}`:
- `build`: the `buildId` without its `+<target>` suffix;
- `static`: the static world as given to `addStaticWorld`, or `{"boxes":[],"ramps":[]}`;
- `world`: the resolved `WorldDesc` (§4), every default filled, `limits` included.

Canonical JSON: object keys sorted, no whitespace, strings JSON-escaped. Each number is written as
ECMAScript's `Number.prototype.toString` of the shortest decimal that round-trips the f32 the core holds,
with −0 as 0. So `dt: 1/30` and `dt: 0.0333333333` hash the same when they round to the same f32.

Hashes cover exactly what the contract exposes. Two builds may differ internally and still hash equal; that
is fine.

## 11. Limits

```ts
interface Limits {
  bodies: number;          // default 512: every body type, preset players included; static pieces excluded
  collidersPerBody: number;// default 8
  hullVertices: number;    // default 64
  triangles: number;       // default 65536 across all trimeshes (fixed only)
  joints: number;          // default 64
  ccdBodies: number;       // default 16
  queriesPerStep: number;  // default 64, counted from the previous step(): queries the host runs between
                           // steps count against the next step's quota
  eventsPerStep: number;   // default 64
  heightfieldSamples: number; // default 1_048_576
  staticPieces: number;    // default 4608 (§17.7's 4096 boxes + 512 ramps); not counted in bodies/collidersPerBody
  memoryBytes: number;     // default 64 MiB per world (§11.1)
  worldExtent: number;     // default 100_000 · lengthUnit: |coordinate| bound per axis, caller units (§4.1, §8.2)
  maxSpeed: number;        // default 1_000 · lengthUnit per second: the largest linear speed a command may set
  maxAngularSpeed: number; // default 1_000 rad/s: the largest angular speed a command may set
}
```

- A limit can be **lowered** by the caller, and **raised** only up to a compile-time ceiling of 4× each
  default, which a paid tier uses.
- Exceeding a limit gives the matching `Limit*` error, and the command doesn't apply.

### 11.1 Memory per world

- The core accounts every allocation it makes for a world, through its own allocator accounting. That's exact
  per world even when many worlds share one WASM instance.
- The core checks a command against `limits.memoryBytes` **before** it allocates, and never relies on an
  allocation failing. A command that would take the world past the limit (spawn, joint, static world,
  restore) is refused with `LimitMemory`, and the world is left unchanged.
- A `step()` can grow memory too (new contact pairs). If a step ends over the limit, `StepResult.memoryExceeded`
  is `true`, and the caller decides (PROTOCOL §17.10 for the host).
- `stats().memoryBytes` reports the same accounting.

So the authority host may share one WASM instance per worker process: a room's `free()` returns its memory to
the shared instance, and one room can't grow past its own limit.

### 11.2 The worst step is bounded by the limits

A WASM call can't be interrupted, so a per-tick hard limit can only be judged after a step returns. The
guarantee therefore comes from the limits.
- **Required scene, "worst case at default limits":**
  - 512 bodies in one dense heap, 64 joints, 16 CCD bodies, 64 queries per step;
  - run at both `dt 1/60, substeps 1` and `dt 1/20, substeps 3`;
  - reports p99 per step and per tick, per target.
- The contract's docs state the measured bound per target. The proxy figure is 1.25 ms mean and 1.6 ms p99
  per 1/60 s step for a 500-body heap on an M4, with `rapier3d-compat` 0.19; it gets replaced by the real
  core's.
- The 4× paid ceiling is offered only after the same scene passes at 4× the limits.

### 11.3 If the core fails

The core must not trap. If it ever does (a bug), the WASM instance is unusable. The binding then returns the
code `internal` for every later call on every world in that instance; the caller ends those worlds and makes a
new instance. A native build reports the same code for the world that failed.

### 11.4 Time is the caller's

- **The CPU budget is not the core's job.** `stats().stepMs` reports wall time measured by the binding, for
  display. Callers that enforce a budget measure CPU time themselves (the authority host uses thread CPU time
  around `step()`). The core never reads a clock for its results, and `stepMs` is excluded from every hash.
- **The authority host's physics meter** (owner's release-1 numbers; what a breach does is PROTOCOL
  §17.10's): a mean of at most 1 ms per 1/60 s of simulated time over 300 ticks, and at most 8 ms per
  1/60 s of simulated time in any one tick, so 8 ms for a 60 Hz tick, 16 ms at 30 Hz and 24 ms at 20 Hz.

```ts
interface Stats { tick: number; bodies: number; awake: number; colliders: number; joints: number;
  contactPairs: number; queriesThisStep: number; stepMs: number; memoryBytes: number }
```

## 12. Reserved for release 2

- `canonicalize()`: drop warm-start impulses and contact manifolds, rebuild internal order by key, set sleep
  from each body's flag and reset the counters. Its exact promise is written after the R2-0 experiment.
- The C ABI (`libgenex_physics`) mirrors the TS shapes as plain C structs and length-prefixed buffers.

## 13. Queries

All queries count toward `limits.queriesPerStep` (past it: `LimitQueries`). They see the world as of the last
completed `step()` plus any commands already applied.

```ts
ray(origin: Vec3, dir: Vec3, maxDist: number, filter?: QueryFilter): RayHit | null
  // dir need not be normalised; zero gives OutOfRange. Hit = { body, collider, dist, point, normal }
shapeCast(shape: Shape, pose: Pose, dir: Vec3, maxDist: number, filter?): CastHit | null
  // only box, sphere, capsule and hull; { body, collider, dist, point, normal }
overlap(shape: Shape, pose: Pose, filter?): Key[]   // body keys, key order, unique
interface QueryFilter { groups?: { member: number; collides: number }; excludeBodies?: Key[] /* at most 64 */; includeSensors?: boolean }
```

- Static pieces are hit like any body and named by their `static:` keys.
- Ties at equal `dist`, to the bit, resolve by key order, so results are deterministic.
- The JSON form of a query, for vectors and §17.10, is a one-key object like a command:
  `{ "ray": { origin, dir, maxDist, filter? } }`, `{ "shapeCast": { shape, pose, dir, maxDist, filter? } }`,
  `{ "overlap": { shape, pose, filter? } }`.

## 14. Errors

```ts
const PhysicsError = {
  InvalidKey: "invalid-key", DuplicateKey: "duplicate-key", UnknownKey: "unknown-key",
  NonFinite: "non-finite", OutOfRange: "out-of-range", BadShape: "bad-shape", DynamicMesh: "dynamic-mesh",
  WrongBodyType: "wrong-body-type", BadCommand: "bad-command", LimitBodies: "limit-bodies",
  LimitColliders: "limit-colliders", LimitHullVertices: "limit-hull-vertices", LimitTriangles: "limit-triangles",
  LimitJoints: "limit-joints", LimitCcd: "limit-ccd", LimitQueries: "limit-queries", LimitStatic: "limit-static",
  LimitMemory: "limit-memory", BadSnapshot: "bad-snapshot", BuildMismatch: "build-mismatch",
  ContractMismatch: "contract-mismatch", Internal: "internal",
} as const;
```

- Each binding returns `{ ok: true, ... } | { ok: false, code, index?, detail }`. In Rust it's
  `Result<_, PhysicsFailure>`.
- `detail` is for logs only. Callers branch on `code`, never on text.

## 15. Bindings (names line up across languages)

- **Rust:** `genex_physics::{World, WorldDesc, BodyDesc, ...}`, with methods in snake_case (`spawn`,
  `set_next_kinematic_pose`, `state_hash`). The genex facade's `sim.physics` is a `World`.
- **TypeScript (`@genex-ai/physics`):**
  - `await init()`, then `World.create(desc)` (a result, since errors are values) and the same methods in
    camelCase;
  - `Vec3` is `[number, number, number]` and `Quat` is `[x, y, z, w]`;
  - `world.free()` releases the world's memory;
  - `init()` is idempotent, and the package works in Node 24 and evergreen browsers.
- **The module API** (`ctx.physics`, genex-demo) uses `{ x, y, z }` vectors like `ctx.rewind`; the sandbox
  prelude converts. The core never sees that form.
- **C** (release 2): `gxph_*` functions, with this contract as the source of truth.

## 16. Conformance vectors

A vector file is JSON:

```json
{
  "contract": "1.0",
  "name": "pile-10-players-30hz",
  "world": { "contract": "1.0", "dt": 0.033333335, "substeps": 2, "gravity": [0, 0, -800],
             "upAxis": "z", "lengthUnit": 39.37 },
  "static": { "boxes": [], "ramps": [] },
  "mode": "each",
  "steps": [
    { "apply": [ { "spawn": { "key": "crate.001", "type": "dynamic", "...": "..." } },
                 { "setNextKinematicPose": { "key": "player.1", "pose": { "p": [0, 0, 36], "q": [0, 0, 0, 1] } } } ],
      "expect": { "stateHash": "9f2c...e01a", "events": 0 } },
    { "repeat": 60, "expect": { "stateHash": "..." } }
  ]
}
```

- **Numbers:** written in shortest round-trip form. Vector writers must emit f32-exact values, meaning a
  decimal that parses to the intended f32.
- **A step entry** runs, in order:
  1. `snapshotRestore: true` (optional): snapshot the world, restore it into a fresh world, and continue on
     the restored one;
  2. `apply`: commands in the file's `mode` (`"each"` by default, or `"atomic"`);
  3. `query`: queries, after the commands;
  4. `step()`, repeated `repeat` times (default 1; `apply` and `query` run only before the first);
  5. `expect`, after the last step: any of `stateHash`, `events` (a count or the full list), `refused`
     (`[[index, code], …]` from `apply`), `queries` (the results, in order), `escaped`, `physicsHash`.
- **Run:** a runner checks every `expect`. The first mismatch reports the step, then the first differing body
  from a full `bodies()` dump.
- **Release:** the engine chat publishes the vectors with each core release; the multiplayer chat vendors
  them into `packages/netcode-bench` with a PROVENANCE pin.
- **Vectors are per backend:** a different backend has its own `buildId` and its own vectors.
- **Required scenes for 1.0:**
  - spread kicked props;
  - tall piles with 10 kinematic players;
  - a dense heap;
  - 32 motorised doors;
  - the firstperson static world, z-up, in inches;
  - a vehicle hull pushing props;
  - CCD balls;
  - query and event ordering;
  - hostile commands (every error code once, with the world hash unchanged after), run in both modes;
  - escaped bodies (one past `worldExtent`);
  - a snapshot/restore round trip, mid-scene;
  - a body with a key at the 64-byte maximum;
  - the full §17.7 static world: 4096 boxes and 512 ramps;
  - **worst case at default limits** (§11.2), at both schedules, reporting p99 per target;
  - a memory-limit scene: spawning past `limits.memoryBytes` gives `LimitMemory` with the world unchanged.

## 17. Changes from the reviewed draft (signed 2026-10-27)

- **B1** `physicsHash` is computed by the core over the resolved description, numbers as f32, and carried as
  §17.10's resolved-config `physics` field (§2, §10.2).
- **B2** numbers become f32 on entry; `worldExtent`, `maxSpeed`, `maxAngularSpeed`; escaped bodies (§4.1,
  §8.2, §11).
- **B3** contact events are opt-in per collider (§6.2).
- **B4** the command JSON form and `BadCommand` (§7.3), and the query JSON form (§13).
- **B5** the `internal` code and the no-trap rule (§11.1, §11.3).
- **B6** static world: full quote, `upAxis: "z"` only, once per world, a body per piece, the reserved
  `static:` prefix, and the host's path is §17.10's (§3, §6.5).
- **B7** host policy left to §17.10; the worst-case scene at both schedules; the owner's meter numbers per
  1/60 s of simulated time, option (a) (§11.2, §11.4).
- **C1-C13** wording: entity ids and the three refused names, kinds, `epoch`, fixed bodies, error columns,
  `areaPush`, "changed", wire ranges, hash details, the determinism row, the vector format, preset units,
  snapshot header, event forms, the `bodies` count.
- **C14** backend-neutral `buildId` and wording (§1, §2, §5, §9.4, §16).

## 18. Still open

- **The measured worst-case bound per target (§11.2):** filled in by P1/P2 with the real core, and on a
  production droplet when the owner approves the run.
