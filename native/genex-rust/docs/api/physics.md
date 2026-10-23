# Physics

`sim.physics` is a Rapier 3D world (Rapier 0.36's `PhysicsWorld`): crates, barrels, balls on
ropes, doors on hinges, whatever is pushed, thrown or knocked down. Its bodies, colliders, joints
and queries are Rapier's own, named through `genex::physics` (Rapier's prelude). The snippets below
use `use genex::physics::{Ball, ColliderBuilder, Pose, QueryFilter, Ray, RevoluteJointBuilder,
RigidBody, RigidBodyBuilder, RigidBodyHandle, RopeJointBuilder};` beside `use genex::prelude::*;`
and `use genex::digest;`. The character controller and ragdolls live in the same world
(`docs/api/characters.md`).

- **When it steps.** The runtime steps it once per tick, after the `on_update` and `on_ui` hooks,
  by 1/60 s. An update hook moves, pushes and adds bodies; what it reads is the last step's world.
  Never step `sim.physics` yourself or change its time step: a second step runs the world faster
  than the game.
- **Determinism.** Rapier is built with `enhanced-determinism` and no thread pool, so the same seed
  and input give the same bodies, to the bit, on every destination. Every seed starts from an
  empty world: build the level in `on_reset`. Never make bodies from a clock or keep them outside
  `sim`.
- **The switch.** Physics is on by default. A game that never touches it sets
  `[physics] enabled = false` in `genex.toml` (`docs/api/genex-toml.md`).

## Bodies and colliders

```rust
game.on_reset(|sim, _seed, _rng, _gfx| {
    let (world, physics) = sim.split();
    // A fixed ground, its top at y = 0.
    let ground = ColliderBuilder::cuboid(40.0, 0.5, 40.0).friction(0.8);
    physics.insert(RigidBodyBuilder::fixed().translation(vec3(0.0, -0.5, 0.0)), ground);
    // A wall of 1 m crates of 20 kg: dynamic bodies, pushed by everything.
    for i in 0..100 {
        let at = vec3((i % 10) as f32 - 4.5, 0.5 + (i / 10) as f32, -6.0);
        let collider = ColliderBuilder::cuboid(0.5, 0.5, 0.5).mass(20.0).friction(0.7).restitution(0.05);
        let (body, _) = physics.insert(RigidBodyBuilder::dynamic().translation(at), collider);
        world.crates.push(body);
    }
    // A barrel: half height 0.6 m, radius 0.4 m, 300 kg per cubic metre.
    physics.insert(RigidBodyBuilder::dynamic().translation(vec3(3.0, 0.6, -2.0)), ColliderBuilder::cylinder(0.6, 0.4).density(300.0));
    // A trolley the game moves (a crane, a lift): it pushes what it meets and is never pushed back.
    let trolley = physics.insert_body(RigidBodyBuilder::kinematic_position_based().translation(vec3(-8.0, 12.0, 0.0)));
    world.trolley = Some(trolley);
});
game.on_update(|sim, ctx| {
    let x = -8.0 + 16.0 * ((ctx.tick % 600) as f32 / 600.0);
    if let Some(body) = sim.world.trolley.and_then(|h| sim.physics.bodies.get_mut(h)) {
        body.set_next_kinematic_translation(vec3(x, 12.0, 0.0));
    }
});
```

- `physics.insert(body, collider)` answers both handles; `physics.insert_body(..)` makes a body
  with no collider (an anchor); `physics.remove_body(handle)` takes a body, its colliders and its
  joints out. Keep handles in `World`, which every seed rebuilds with the bodies.
- `.mass(kg)` sets a collider's mass, `.density(kg per m³)` derives it from its volume (1 by
  default). `.friction(..)` (0.5 by default) and `.restitution(..)` (bounce, 0 by default) are
  per collider. `ColliderBuilder::ball(r)`, `ColliderBuilder::cuboid(hx, hy, hz)` (half extents)
  and `ColliderBuilder::cylinder(half_height, r)` are the cheap shapes.
- **Fast things.** A fast body already sweeps fixed colliders, so a shot does not pass a wall.
  `.ccd_enabled(true)` on a small, fast body (a bullet, a thrown ball) makes it sweep moving bodies
  too: without it a 90 m/s shot passes a 10 cm plank that hangs free. It costs more; give it only to
  what flies.
- `.linvel(v)` starts a body moving and `.linear_damping(..)` slows it (air).

## Forces, an explosion and a shot

```rust
/// Push every dynamic body within `radius` of `at` away from it, harder the closer it is: a change
/// of velocity of up to `strength` m/s. Answers how many bodies it pushed.
fn explode(physics: &mut PhysicsWorld, at: Vec3, radius: f32, strength: f32) -> usize {
    let near: Vec<RigidBodyHandle> = physics
        .intersect_shape(Pose::from_translation(at), &Ball::new(radius), QueryFilter::only_dynamic())
        .filter_map(|(_, collider)| collider.parent())
        .collect();
    for handle in &near {
        let Some(body) = physics.bodies.get_mut(*handle) else { continue };
        let away = body.translation() - at;
        let falloff = 1.0 - (away.length() / radius).min(1.0);
        let push = (away.normalize_or_zero() + Vec3::Y * 0.5) * strength * falloff * body.mass();
        body.apply_impulse(push, true);
    }
    near.len()
}

/// Fire along `aim` from `eye`: the first collider the ray hits is pushed at the point it was hit.
fn shoot(physics: &mut PhysicsWorld, eye: Vec3, aim: Vec3) -> Option<RigidBodyHandle> {
    let ray = Ray::new(eye, aim);
    let (handle, toi) = physics.cast_ray(&ray, 100.0, true, QueryFilter::default())?;
    let hit = ray.point_at(toi);
    let parent = physics.colliders.get(handle).and_then(|collider| collider.parent())?;
    let body = physics.bodies.get_mut(parent)?;
    body.apply_impulse_at_point(aim * 400.0, hit, true);
    Some(parent)
}
```

- `body.apply_impulse(newton_seconds, true)` changes a body's velocity at once (by impulse over
  mass); `body.apply_impulse_at_point(..)` also spins it. `true` wakes a sleeping body.
- `body.linvel()` and `body.angvel()` read its velocity, `body.translation()` and
  `body.rotation()` where it is.
- Queries read the last step's world: `physics.cast_ray(&ray, max_toi, solid, filter)` answers the
  first collider and the distance along the ray (`ray.point_at(toi)` is the point);
  `QueryFilter::default().exclude_rigid_body(player)` skips the shooter's own body.
  `physics.intersect_shape(pose, &shape, filter)` lists the colliders overlapping a shape.
- Contacts: `physics.contact_pair(a, b)` (two collider handles) is their contact after the last
  step; `pair.has_any_active_contact()` says whether they touch, so a barrel the ball hit can go
  off in the next update.

## Joints

```rust
// A 600 kg wrecking ball on an 8 m rope from the trolley: slack when shorter, held at 8 m.
let wrecking = RigidBodyBuilder::dynamic().translation(vec3(-8.0, 4.5, 0.0)).linear_damping(0.05);
let (ball, _) = physics.insert(wrecking, ColliderBuilder::ball(1.0).mass(600.0).restitution(0.1));
physics.insert_impulse_joint(trolley, ball, RopeJointBuilder::new(8.0));
// A door on a hinge at its left edge: it swings about +Y, at most 90 degrees either way.
let post = physics.insert_body(RigidBodyBuilder::fixed().translation(vec3(10.0, 1.05, 0.0)));
let (door, _) = physics.insert(RigidBodyBuilder::dynamic().translation(vec3(10.5, 1.05, 0.0)), ColliderBuilder::cuboid(0.5, 1.0, 0.05).mass(30.0));
let hinge = RevoluteJointBuilder::new(Vec3::Y).local_anchor2(vec3(-0.5, 0.0, 0.0)).limits([-1.57, 1.57]);
physics.insert_impulse_joint(post, door, hinge);
```

`RopeJointBuilder::new(length)` holds two bodies at most `length` apart; `RevoluteJointBuilder::new(axis)`
is a hinge, `.local_anchor2(..)` where it sits on the second body, `.limits([min, max])` its
angles in radians. Swing the ball with `body.apply_impulse(..)` on it, or by moving the trolley.
Joint limits are impulse constraints: a hard hit can pass one by a little.

## Drawing many bodies

Draw every body from `on_draw`, where it is after this tick's step, each under its own draw id so
TAA finds where its pixels were (`docs/api/rendering.md`):

```rust
/// A draw id that stays with one body: its handle's slot and generation.
fn body_id(handle: RigidBodyHandle) -> u64 {
    let (slot, generation) = handle.into_raw_parts();
    u64::from(slot) | (u64::from(generation) << 32)
}

game.on_draw(|sim, frame, _camera| {
    frame.tag("crates");
    for handle in &sim.world.crates {
        let Some(body) = sim.physics.bodies.get(*handle) else { continue };
        let at = Transform::from_translation(body.translation()).with_rotation(*body.rotation());
        frame.id(body_id(*handle)).cube(at, Color::rgb(170, 120, 70));
    }
    frame.end_id();
});
```

The cube is 1 m across: scale it to the collider (`.with_scale(..)` by twice the half extents),
or draw a model (`frame.model`) at the same transform. Every body of one shape (one mesh) is one
batch for the GPU, whatever its colour and however many draws it takes. Moving bodies stay ordinary draws: a retained
instance group (`docs/api/instance-groups.md`) is for what stands still, and an update hook that
copied bodies into one would draw them a tick behind. A body that sleeps costs the physics nothing
until something touches it or `true` wakes it; `physics.active_bodies()` lists the awake ones and
`body.is_sleeping()` asks one.

## Budgets

Measured on an Apple M4 Max, a native release build, physics on one thread as everywhere: a pile
of awake 1 m crates costs about 0.6 ms a tick at 500 crates, 3 ms at 1,000 and 9 ms at 2,000 (a
tick has 16.7 ms for everything), and under 0.1 ms once the pile sleeps. Drawing 2,000 crates in
`on_draw` takes 0.2 ms of the CPU; the GPU's share was not measured. The web runs the same code in
WebAssembly and phones on slower cores, neither measured: plan for a few hundred awake bodies there.

- Let piles fall asleep, and wake only what a blast or a hit reaches (a body touching an awake one
  wakes too, so one pile wakes whole).
- Give moving bodies simple shapes (cuboids, balls, cylinders), never a mesh collider.
- CCD only for what flies; remove debris once it no longer matters.

## Saving bodies

A slot holds what `World` holds (`docs/api/saves.md`), never Rapier's world. Keep every moving
body's handle in `World` in the order the reset makes them, and add a section with each one's pose
and velocities as f32 bits. Never write a float as a JSON number: one that does not read back to
the same text makes the slot refuse to load (`save-corrupt`), while bits come back exact.

```rust
/// One body's pose and velocities as f32 bits.
fn body_bits(body: &RigidBody) -> [u32; 13] {
    let (at, turn, linvel, angvel) = (body.translation(), *body.rotation(), body.linvel(), body.angvel());
    let floats = [at.x, at.y, at.z, turn.x, turn.y, turn.z, turn.w, linvel.x, linvel.y, linvel.z, angvel.x, angvel.y, angvel.z];
    floats.map(f32::to_bits)
}

game.save_world(); // the handles
game.save_section("bodies", |sim| {
    let rows: Vec<Option<[u32; 13]>> = sim.world.crates.iter().map(|handle| sim.physics.bodies.get(*handle).map(body_bits)).collect();
    json!(rows)
}, |sim, value, _gfx| {
    // The reset rebuilt every body where it starts: put each where it was.
    let rows = Vec::<Option<[u32; 13]>>::deserialize(value).map_err(|error| error.to_string())?;
    for (handle, row) in sim.world.crates.clone().into_iter().zip(rows) {
        let Some(row) = row else {
            sim.physics.remove_body(handle); // gone when it was saved
            continue;
        };
        let Some(body) = sim.physics.bodies.get_mut(handle) else { continue };
        let f = row.map(f32::from_bits);
        body.set_position(Pose::from_parts(vec3(f[0], f[1], f[2]), Quat::from_xyzw(f[3], f[4], f[5], f[6])), true);
        body.set_linvel(vec3(f[7], f[8], f[9]), true);
        body.set_angvel(vec3(f[10], f[11], f[12]), true);
    }
    Ok(())
});
```

- The reset makes the same bodies in the same order from the slot's seed, so each handle in
  `World` is the body it was. A kinematic body keeps only its position: its velocity is where the
  game moves it next.
- Rapier's contacts and sleep are not saved: every body comes back awake and touching nothing, so a
  loaded pile settles again. Two loads of one slot replay equal, but not equal to the run that never
  stopped. Probe how many bodies are awake with `game.probe_volatile(..)`, never `game.probe`: a
  load wakes them all, and a probe that counted them would differ from the saved one.
- To prove a load, probe a digest of the dynamic bodies' bits: `checksumMatch` is then true only
  when every body came back exactly.

```rust
game.probe("bodies", |sim| {
    let bodies = sim.world.crates.iter().filter_map(|h| sim.physics.bodies.get(*h)).filter(|body| body.is_dynamic());
    let bytes: Vec<u8> = bodies.flat_map(body_bits).flat_map(u32::to_le_bytes).collect();
    json!(digest::hex64(digest::fnv1a64(&bytes)))
});
```

## Probes and refusals

Probe each mechanic by what it did, never by dumping bodies: how many crates are down
(`translation().y` below a crate's half height), how many bodies a blast pushed, where the
wrecking ball is, which body a shot hit. Rapier refuses nothing: a body the handle no longer names
answers `None`, and a non-finite position, velocity or impulse spreads through every body it
touches, so keep them finite. With `[physics] enabled = false`, `sim.physics` is an empty stand-in
that never steps, and code that names `genex::physics` or calls Rapier on `sim.physics` (bodies,
`Character::spawn`, ragdolls, `CellColliders`) does not compile: the build answers `build-failed`
with the compiler's error. Turn physics back on (or delete the table) to use it.
