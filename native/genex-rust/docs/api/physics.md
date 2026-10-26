# Physics

`sim.physics` is a Genex Physics world (`genex::phys`, the engine's own physics core, Rapier 3D
inside): crates, barrels, balls on ropes, doors on hinges, whatever is pushed, thrown or knocked
down. Every body, collider and joint has a key the game picks (`"crate.0042"`, `"door"`): there are
no handles to keep. A command that cannot apply (an unknown key, a NaN, a second body with one key)
answers a typed `PhysicsFailure` and changes nothing. The snippets below use
`use genex::phys::{self, BodyDesc, BodyType, ColliderDesc, JointDesc, JointType, PhysicsEvent, QueryFilter};`
beside `use genex::prelude::*;` and `use genex::digest;`.

- **When it steps.** The runtime steps it once per tick, after the `on_update` and `on_ui` hooks,
  by 1/60 s. An update hook spawns, moves and pushes bodies; what it reads is the last step's world
  plus its own commands. There is no step call: a second step would run the world faster than the
  game.
- **Determinism.** The same seed and input give the same bodies, to the bit, on every destination:
  `sim.physics.state_hash_hex()` is a digest of every body and joint motor, equal in two runs of one
  seed. Every seed starts from an empty world: build the level in `on_reset`. Never make bodies from
  a clock or keep them outside `sim`.
- **The world.** Y is up, lengths are metres, gravity is 9.81 m/s² down, and the contract's limits
  hold: 512 bodies, 8 colliders a body, 64 joints, 16 CCD bodies, 64 queries and 64 events a step.
  `game.physics_world(desc)` changes gravity, sub-steps, solver iterations and limits (each up to 4×
  its default): start from `phys::default_world()` (or `WorldDesc::new(dt, substeps, gravity,
  up_axis, length_unit)`) and set what differs, as in
  `WorldDesc { limits: LimitsDesc { bodies: Some(2048.0), ..LimitsDesc::default() }, ..phys::default_world() }`.
  Its `dt` must be the tick, `FIXED_STEP_MS / 1000`. It is registered once
  (`duplicate-physics-world`); a description the core refuses is `physics-world-invalid`.
- **The switch.** Physics is on by default. A game that never touches it sets
  `[physics] enabled = false` in `genex.toml` (`docs/api/genex-toml.md`).

## Bodies and colliders

```rust
/// A body of one collider at `at`.
fn body(key: &str, body_type: BodyType, at: Vec3, collider: ColliderDesc) -> BodyDesc {
    BodyDesc::new(key, body_type, phys::pose(at, Quat::IDENTITY), vec![collider])
}

game.on_reset(|sim, _seed, _rng, _gfx| {
    let (world, physics) = sim.split();
    // A fixed ground, its top at y = 0.
    let slab = ColliderDesc { friction: Some(0.8), ..ColliderDesc::new("slab", phys::cuboid(vec3(40.0, 0.5, 40.0))) };
    let _ = physics.spawn(&body("ground", BodyType::Fixed, vec3(0.0, -0.5, 0.0), slab));
    // A wall of 1 m crates of 20 kg: dynamic bodies, pushed by everything.
    for i in 0..100 {
        let at = vec3((i % 10) as f32 - 4.5, 0.5 + (i / 10) as f32, -6.0);
        let box_of = ColliderDesc { mass: Some(20.0), friction: Some(0.7), restitution: Some(0.05), ..ColliderDesc::new("box", phys::cuboid(vec3(0.5, 0.5, 0.5))) };
        let key = format!("crate.{i:04}");
        let _ = physics.spawn(&body(&key, BodyType::Dynamic, at, box_of));
        world.crates.push(key);
    }
    // A trolley the game moves (a crane, a lift): it pushes what it meets and is never pushed back.
    let hook = ColliderDesc { sensor: true, ..ColliderDesc::new("hook", phys::ball(0.2)) };
    let _ = physics.spawn(&body("trolley", BodyType::Kinematic, vec3(-8.0, 12.0, 0.0), hook));
});
game.on_update(|sim, ctx| {
    let x = -8.0 + 16.0 * ((ctx.tick % 600) as f32 / 600.0);
    let _ = sim.physics.set_next_kinematic_pose("trolley", phys::pose(vec3(x, 12.0, 0.0), Quat::IDENTITY));
});
```

- A `BodyDesc` is a key, a type (`Dynamic`, `Fixed`, `Kinematic`), a pose and 1 to 8 colliders,
  plus optional `linvel`, `angvel`, `linear_damping`, `gravity_scale`, `lock_rotation`, `ccd`,
  `can_sleep` and a `kind` tag. `physics.spawn(&desc)` adds it; `physics.remove(key)` takes the
  body, its colliders and its joints out. A removed key may be reused. Keep the keys in `World`.
- A `ColliderDesc` is a key (unique within its body), a `phys::Shape` (`Box { half }`,
  `Sphere { radius }`, `Capsule { half_height, radius, axis }`, `Hull { points }`, and for fixed
  bodies only `Trimesh` and `Heightfield`) and optional `offset`, `mass` or `density` (kg per m³, 1
  by default), `friction` (0.5), `restitution` (0), `groups`, `sensor` and `events`.
  `phys::cuboid(half)` and `phys::ball(radius)` are the cheap shapes.
- Vectors are `[f64; 3]`, rotations `[x, y, z, w]`: `phys::pose(at, rotation)` and `phys::xyz(v)`
  turn glam values into them, `phys::vec3_of(..)` and `phys::quat_of(..)` turn them back.
- **Fast things.** A fast body already sweeps fixed colliders. `ccd: true` on a small, fast body (a
  bullet, a thrown ball) makes it sweep moving bodies too; at most 16 bodies have it.

## Forces, an explosion and a shot

```rust
/// Push every dynamic body within `radius` of `at` away from it, harder the closer it is.
fn explode(physics: &mut Physics, at: Vec3, radius: f32, strength: f32) {
    let _ = physics.area_push(phys::xyz(at), f64::from(radius), f64::from(strength), 1.0, None);
}

/// Fire along `aim` from `eye`: the first body the ray hits is pushed at the point it was hit.
fn shoot(physics: &mut Physics, eye: Vec3, aim: Vec3) -> Option<String> {
    let hit = physics.ray(phys::xyz(eye), phys::xyz(aim), 100.0, &QueryFilter::default()).ok()??;
    physics.impulse(&hit.body, phys::xyz(aim * 400.0), Some(hit.point)).ok()?;
    Some(hit.body)
}
```

- `physics.impulse(key, j, at)` changes a dynamic body's velocity at once (by impulse over mass),
  and spins it when `at` is a world point; `physics.set_velocity(key, linvel, angvel)` sets it.
  Both wake the body. `physics.area_push(center, radius, strength, falloff, groups)` pushes every
  dynamic body within `radius`, `strength · (1 − d/radius)^falloff` away from the centre.
- `physics.set_pose(key, pose, options)` teleports a dynamic or fixed body;
  `physics.set_next_kinematic_pose(key, pose)` moves a kinematic one over the next step.
  `physics.wake(key)` and `physics.sleep(key)` force its sleep.
- `physics.body(key)` reads a body (`pose`, `linvel`, `angvel`, `sleeping`, `body_type`, `kind`),
  `physics.bodies(&filter)` many in key order, `physics.stats()` the counts (`awake` among them).
- Queries see the last step's world plus every command since: `physics.ray(origin, dir, max, &filter)`
  answers the first `Hit` (`body`, `collider`, `dist`, `point`, `normal`),
  `physics.shape_cast(&shape, pose, dir, max, &filter)` sweeps a shape, and
  `physics.overlap(&shape, pose, &filter)` lists the bodies a shape touches.
  `QueryFilter { exclude_bodies: vec!["player".into()], ..QueryFilter::default() }` skips the
  shooter. Past 64 queries a step a query answers `limit-queries`.

## Contacts and triggers

A collider with `events: true` reports when it starts and stops touching anything; a `sensor`
collider reports what enters and leaves it. After each step `sim.physics.events()` lists them, in
a fixed order, for the next update to read:

```rust
// A bomb (kind "bomb", `events: true`) goes off when anything but the ground hits it.
let struck = sim.physics.events().iter().any(|event| match event {
    PhysicsEvent::ContactBegin { a, b, .. } => (a == "bomb" && b != "ground") || (b == "bomb" && a != "ground"),
    _ => false,
});
if struck {
    let _ = sim.physics.remove("bomb");
}
```

`ContactBegin` carries both keys (`a` before `b`), their colliders, their `kind` tags, the impulse,
the point and the normal; `ContactEnd`, `TriggerEnter` and `TriggerExit` the keys. Past 64 events a
step the rest are dropped. A body that leaves the world's extent is frozen and listed once in
`sim.physics.escaped()`: remove it or put it back.

## Joints

```rust
// A 600 kg wrecking ball on an 8 m rope from the trolley: slack when shorter, held at 8 m.
let ball = ColliderDesc { mass: Some(600.0), restitution: Some(0.1), ..ColliderDesc::new("ball", phys::ball(1.0)) };
let _ = physics.spawn(&BodyDesc { linear_damping: Some(0.05), ..body("ball", BodyType::Dynamic, vec3(-8.0, 4.5, 0.0), ball) });
let rope = JointDesc { limits: Some([0.0, 8.0]), ..JointDesc::new("rope", "ball", Some("trolley"), JointType::Rope, [0.0; 3], [0.0; 3]) };
let _ = physics.add_joint(&rope);
// A door on a hinge at its left edge: it swings about +Y, at most 90 degrees either way.
let _ = physics.spawn(&body("post", BodyType::Fixed, vec3(10.0, 1.05, 0.0), ColliderDesc::new("pin", phys::ball(0.05))));
let panel = ColliderDesc { mass: Some(30.0), ..ColliderDesc::new("panel", phys::cuboid(vec3(0.5, 1.0, 0.05))) };
let _ = physics.spawn(&body("door", BodyType::Dynamic, vec3(10.5, 1.05, 0.0), panel));
let hinge = JointDesc { axis: Some([0.0, 1.0, 0.0]), limits: Some([-1.57, 1.57]), ..JointDesc::new("hinge", "door", Some("post"), JointType::Hinge, [-0.5, 0.0, 0.0], [0.0; 3]) };
let _ = physics.add_joint(&hinge);
```

`JointDesc::new(key, a, b, type, anchor_a, anchor_b)` joins body `a` to body `b` (or to the world
with `None`) at an anchor in each body's frame. `Fixed`, `Ball`, `Hinge` and `Slider` (both with an
`axis`), and `Rope` (with `limits: [0, length]`). `limits` and a `motor` (target velocity or
position, stiffness, damping, force) apply to a hinge, a slider or a rope; `physics.set_motor(key,
motor)` changes the motor. A ball joint has no limits. Joint limits are impulse constraints: a hard
hit can pass one by a little.

## Drawing many bodies

Draw every body from `on_draw`, where it is after this tick's step, each under its own draw id so
TAA finds where its pixels were (`docs/api/rendering.md`). A key is a draw id as it is:

```rust
game.on_draw(|sim, frame, _camera| {
    frame.tag("crates");
    for key in &sim.world.crates {
        let Some(body) = sim.physics.body(key) else { continue };
        let at = Transform::from_translation(phys::vec3_of(body.pose.p)).with_rotation(phys::quat_of(body.pose.q));
        frame.id(key).cube(at, Color::rgb(170, 120, 70));
    }
    frame.end_id();
});
```

The cube is 1 m across: scale it to the collider (`.with_scale(..)` by twice the half extents), or
draw a model (`frame.model`) at the same transform. Every body of one shape (one mesh) is one batch
for the GPU. Moving bodies stay ordinary draws: a retained instance group
(`docs/api/instance-groups.md`) is for what stands still. A body that sleeps costs the physics
nothing until something touches it or a command wakes it; `body.sleeping` says which.

## Budgets

Measured on an Apple M4 Max in a native release build, physics on one thread as everywhere: a dense
heap of 512 awake bodies with 64 joints and 64 queries a step costs about 0.5 ms a step (0.8 ms at
its worst), a pile of awake 1 m crates about 0.6 ms at 500 crates, and under 0.1 ms once the pile
sleeps (a tick has 16.7 ms for everything). The web runs the same code in WebAssembly and phones on
slower cores, neither measured: plan for a few hundred awake bodies there.

- Let piles fall asleep, and wake only what a blast or a hit reaches.
- Give moving bodies simple shapes (boxes, spheres, capsules), never a mesh.
- CCD only for what flies; remove debris once it no longer matters.

## Saving bodies

A slot holds what `World` holds (`docs/api/saves.md`), never the physics world. Keep every moving
body's key in `World` and add a section with each one's save row: `physics.export_row(key)` is its
13 numbers (position, rotation, linear and angular velocity, from `physics.export_body_state(key)`),
and `physics.import_row(key, &row)` puts it back.

```rust
game.save_world(); // the keys
game.save_section("bodies", |sim| {
    let rows: Vec<Option<[f32; phys::BODY_ROW_LEN]>> = sim.world.crates.iter().map(|key| sim.physics.export_row(key)).collect();
    json!(rows)
}, |sim, value, _gfx| {
    // The reset rebuilt every body where it starts: put each where it was.
    let rows = Vec::<Option<[f32; phys::BODY_ROW_LEN]>>::deserialize(value).map_err(|error| error.to_string())?;
    for (key, row) in sim.world.crates.clone().into_iter().zip(rows) {
        let Some(row) = row else {
            let _ = sim.physics.remove(&key); // gone when it was saved
            continue;
        };
        sim.physics.import_row(&key, &row).map_err(|failure| failure.to_string())?;
    }
    Ok(())
});
```

- The reset makes the same bodies under the same keys from the slot's seed. A fixed body is not
  imported: it is where the reset put it.
- A body's contacts and sleep are not saved: every body comes back awake and touching nothing, so a loaded
  pile settles again. Two loads of one slot replay equal, but not equal to the run that never
  stopped. A load renormalises each rotation, which can move its last bit: probe positions and
  velocities to prove a load.
- `physics.snapshot()` is the whole world as bytes, contacts included, and `physics.restore(&bytes)`
  steps on from it bit for bit: a rewind within one run. Keep the bytes in `World` only while the
  game runs.

```rust
game.probe("bodies", |sim| {
    // Positions and velocities: a load renormalises the rotation (row[3..7]).
    let mut numbers: Vec<f32> = Vec::new();
    for row in sim.world.crates.iter().filter_map(|key| sim.physics.export_row(key)) {
        numbers.extend(&row[..3]);
        numbers.extend(&row[7..]);
    }
    let bytes: Vec<u8> = numbers.into_iter().map(f32::to_bits).flat_map(u32::to_le_bytes).collect();
    json!(digest::hex64(digest::fnv1a64(&bytes)))
});
```

## Probes and refusals

Probe each mechanic by what it did, never by dumping bodies: how many crates are down
(`pose.p[1]` below a crate's half height), how many bodies a blast reached, where the wrecking ball
is, which body a shot hit. Probe how many bodies are awake with `game.probe_volatile(..)`, never
`game.probe`: a load wakes them all. A refused command answers `Err(PhysicsFailure)`: branch on its
`code` (`unknown-key`, `duplicate-key`, `wrong-body-type`, `non-finite`, `out-of-range`,
`bad-shape`, `dynamic-mesh`, a `limit-*` code), never its `detail`. A world that failed inside the
core reports it in `sim.physics.failure()` and is empty again at the next seed. With
`[physics] enabled = false`, `sim.physics` is an empty stand-in that never steps, and code that
calls it or names `genex::phys` does not compile: the build answers `build-failed` with the
compiler's error. Turn physics back on (or delete the table) to use it.

## Raw Rapier (deprecated)

Games written before Genex Physics call Rapier itself: `genex::physics` (Rapier's prelude:
`RigidBodyBuilder`, `ColliderBuilder`, `QueryFilter`), `genex::rapier3d`, and Rapier's world
through `sim.physics` (its `bodies`, `colliders`, `insert`, `cast_ray`, a `&mut PhysicsWorld`).
That still compiles for one release: `sim.physics` dereferences to a second, raw Rapier world the
runtime steps beside the Genex one. The two never touch, so never mix them in one level. Move a
game to `genex::phys` the next time its physics changes: keys instead of handles, `spawn` instead
of `insert`, `area_push` or `overlap` and `impulse` instead of `intersect_shape`, `ray` instead of
`cast_ray`, `events()` instead of `contact_pair`, and save rows from `export_row`.

### What stays raw

These game systems still live in the raw world for this release, because the Genex Physics contract
does not yet carry what they need:

- the character controller (`docs/api/characters.md`): Rapier's sliding, stepping and ground-snap
  sweeps, many shape casts a tick (the contract's quota is 64 queries a step);
- ragdolls: ball joints with swing cones and twist limits, three-axis joint motors and bodies that
  switch between kinematic and dynamic, none of which the contract has;
- streamed colliders and terrain tile colliders (`docs/api/streaming.md`): thousands of static
  colliders entering and leaving with cells, past the contract's 512 bodies;
- navigation's collider input (`docs/api/navigation.md`) and audio occlusion, which read those
  colliders.

A character walks on raw colliders only: a crate spawned with `physics.spawn` is not in its way.
