# Characters

A world holds its characters and ragdolls and drives them in `on_update`, before the runtime's
physics step. `Character`, `CharacterMotion` and `CharacterNav` are in the prelude; the rest is
at the crate root. Every type and call in one line:

```rust
use genex::{CharacterError, CharacterParams, CharacterStep, RootMotion};
use genex::{HumanoidBone, Ragdoll, RagdollPart, RagdollProfile}; // physics builds only
use genex::physics::{ColliderHandle, RigidBodyHandle};
Character::spawn(&mut sim.physics, feet, params);              // -> Result<Character, CharacterError>
CharacterParams { jump_speed: 9.0, ..CharacterParams::default() }; // every field an f32 (below)
// radius, height, max_slope_degrees, step_height, snap_to_ground, gravity, jump_speed, accel, decel, turn_rate
character.drive(physics, CharacterMotion::Velocity { wish, jump }, dt); // -> CharacterStep
// CharacterStep { moved: Vec3, grounded, sliding, landed, left_ground } (bools)
// CharacterMotion::Velocity { wish, jump } | Root(RootMotion) | Mixed { root, wish, jump, root_share }
character.feet(); character.velocity();                        // -> Vec3
character.facing(); character.grounded();                      // -> Quat, bool
character.transform().into();                                  // -> Transform
character.body(); character.collider();                        // -> Option<RigidBodyHandle>, Option<ColliderHandle>
character.ground_ray(&sim.physics); character.nav_config(); character.remove(physics);
Character::on_ground(feet, params);                            // -> Result<Character, CharacterError>, no physics
character.drive_on(|x, z| terrain.height(x, z), motion, dt);    // -> CharacterStep
Ragdoll::build(&mut sim.physics, &animator, model, &profile);   // model: Mat4 -> Result<Ragdoll, AnimationError>
ragdoll.follow(physics, &animator, model); ragdoll.go_limp(physics, part, velocity);
ragdoll.power(physics, part, strength); ragdoll.recover(physics, part, seconds);
```

Exclude the capsule from your own ray casts with
`QueryFilter::default().exclude_rigid_body(body)` (`docs/api/physics.md`).

## The controller

`Character::spawn(&mut sim.physics, feet, CharacterParams::default())` puts a kinematic capsule
(radius 0.35, height 1.8; slope 45°, step 0.3, snap 0.2, gravity 22, jump 7, accel 24, decel 30,
turn 12 rad/s) in the physics world:

```rust
let (world, physics) = sim.split();
let step = world.hero.drive(physics, CharacterMotion::Velocity { wish, jump }, ctx.dt);
```

- `CharacterMotion::Root(root_motion)` lets the clip move the capsule;
  `CharacterMotion::Mixed { root, wish, jump, root_share }` blends both (nav steering with
  clip-driven feet). `CharacterStep { moved, grounded, sliding, landed, left_ground }` reports the
  tick.
- Walls stop and slide it, steps up to `step_height` are climbed, and slopes steeper than
  `max_slope_degrees` slide it down. `character.ground_ray(physics)` is a ray `(from, to)` into the
  ground that skips the character, sensors and ragdolls; `character.remove(physics)` takes it out.
- `character.feet()`, `character.facing()`, `character.velocity()` and `character.grounded()` read
  it; `character.transform().into()` is the `Transform` to draw it with.
- To stand its feet on a slope or a step, call
  `animator.plant_feet(character.transform().into(), character.ground_ray(&sim.physics))` after
  the animator's update (`docs/api/animation.md`).
- `character.nav_config()` is the `NavConfig` whose climb and slope match the controller, so every
  path its bake finds is one the character can walk (`docs/api/navigation.md`).
- `character.snapshot()` and `character.restore(..)` carry the controller state (floats as bits).
- Without physics, `Character::on_ground(feet, params)` and
  `character.drive_on(|x, z| terrain.height(x, z), motion, dt)` follow a height function with
  the same rules (no walls).
- A character spawned in the reset that built its level does not fall on its first drive.
- Refusal: `character-shape-invalid` (a capsule or motion parameter outside its range, feet that
  are not finite, or a snapshot of another version or parameter set).

## Ragdolls (physics)

`Ragdoll::build(&mut sim.physics, &animator, model, &RagdollProfile::humanoid().with_mass(70.0))`
makes 11 bodies and 10 joints at the animator's pose (`docs/api/animation.md`), all animated
(kinematic).

- Each tick after the animator, `ragdoll.follow(physics, &animator, model)`.
- `ragdoll.go_limp(physics, RagdollPart::Whole, velocity)` (or
  `RagdollPart::Limb(HumanoidBone::LeftUpperArm)` for one arm) hands bodies to physics.
- `ragdoll.power(physics, part, strength)` keeps them dynamic with motors chasing the animation
  (the root stays animated: hit reactions); `ragdoll.recover(physics, part, seconds)` blends back.
- `ragdoll.view(&sim.physics).apply(&animator, model, &mut pose)` is the pose to draw.
- Ragdoll colliders are in `RAGDOLL_GROUP`: they never collide with each other or block a
  character.
- Joint limits are Rapier impulse constraints: a hard landing can pass a limit by about 0.16 rad at
  Rapier's default 4 solver iterations.
- Refusal: `ragdoll-profile-invalid` (a profile or rig the humanoid builder cannot use).
