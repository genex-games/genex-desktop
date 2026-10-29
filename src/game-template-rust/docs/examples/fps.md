# First-person cookbook

Each part of a first-person game on this engine, as `docs/examples/fps/` builds it. Copy the
example whole and change it, rather than writing these from scratch.

## Pointer lock and mouse look

The game never locks the pointer itself: the host does. Declare the game's traits in
`studio.json` (`"game": { "kind": "first-person", "mouseLook": true, "keyboardMove": true,
"hud": true }`) and Live locks the pointer on a click; `ctx.pointer_lock` says whether it is
locked. `ctx.look` carries the mouse's movement in pixels while it is locked, and what a check
injects (`Input::look(dx, dy)`), so apply it on every tick without asking about the lock, or the
checks' look cannot turn the camera:

```rust
// The action map: .axis2(LOOK, &[Binding::Look]) and .axis2(TURN, &[Binding::Stick(Stick::Right)])
let turn = ctx.actions.axis2(LOOK) * MOUSE_TURN + ctx.actions.axis2(TURN) * PAD_TURN * ctx.dt;
world.yaw += turn.x;
world.pitch = (world.pitch - turn.y).clamp(-PITCH_LIMIT, PITCH_LIMIT);
```

`yaw` turns about +y with 0 along +x, so the view is
`vec3(cos(yaw) * cos(pitch), sin(pitch), sin(yaw) * cos(pitch))` (`genex::math`). On a phone a
finger the touch controls did not take (`ctx.actions.free_touches()`) drags the view: keep its
last position in the world and turn by the difference.

## Moving

The player is a `Character` capsule (`docs/api/characters.md`) driven with
`CharacterMotion::Velocity { wish, jump }`, `wish` in metres per second from the move action
turned by the yaw. The level's boxes are fixed Rapier cuboids from the same numbers that draw
them, so what the player bumps, what a shot hits and what the picture shows agree.

## The camera: `FirstPersonRig`

Never write your own head-bob, roll or shake: `genex::camera::FirstPersonRig` moves the eye, and
its caps hold whatever a brief or a critic asks for ("heavy bob", "a sprint that shakes the
view"). Keep it in the world, feed it what the body did in `on_update`, and make the camera from
it in the camera hook, where the person's head-bob, screen-shake, reduced-motion and field of view
settings scale it (`docs/api/settings.md`). A shot calls `world.rig.recoil(degrees)`; an
explosion nearby `world.rig.impulse(strength)`.

```rust
use genex::camera::{FirstPersonRig, RigStep};
// on_reset: the game's own walk and sprint speeds (m/s), for the sprint's field of view kick.
world.rig = FirstPersonRig::new().with_speeds(WALK, SPRINT);
// on_update, after the drive: turn.x is this tick's yaw change, + to the right.
let step = player.drive(physics, CharacterMotion::Velocity { wish, jump }, ctx.dt);
world.rig.update(ctx.dt, RigStep { velocity: player.velocity(), turn: turn.x, ..RigStep::from(&step) });
// the camera hook: eye before any bob (the hitscan starts there), look direction, vertical fovy.
game.camera(|sim| sim.world.rig.camera(sim.world.eye(), sim.world.forward(), FOVY));
// a comfort check reads it per tick, outside the checksum.
game.probe_volatile("cameraMotion", |sim| sim.world.rig.probe());
```

`fovy` is the **vertical** field of view in degrees. Keep a first-person game between 60 and 80
(72 vertical is about 104° horizontal at 16:9; 100 vertical is about 130°, and every bob reads a
third larger). A bodycam rides on the chest at about 1.4 m with 72; an eye-height camera sits at
1.6 m with 65-75. Narrow it while aiming (52-60) with `rig.camera_with(.., &Comfort { head_bob:
comfort.head_bob * (1.0 - aim), ..comfort })`, as `docs/examples/fps-arms/` does. The person's
field of view offset (-10 to +20) is added on top.

What the rig does at 3 m/s (walk) and 5.5 m/s (sprint), and the cap no game can pass:

| Motion | Walk | Sprint | Cap |
|-|-|-|-|
| Step rate (vertical bob frequency) | 2.3 Hz | 2.8 Hz | 2.8 Hz (the stride grows with speed) |
| Bob, peak to peak | 1.5 cm | 2.8 cm | 2.8 cm |
| Sway, either way | 1.1 cm | 1.8 cm | 1.8 cm |
| Walk roll, either way | 0.7° | 1.2° | 1.2° |
| All roll (walk, turn lean), either way | | | 2° |
| Field of view kick | 0° | 4° | 4° |
| Drift and shake terms | | | 8 Hz, 1.5° |
| Under reduced motion | | | 10% of all of it |

Every term is a smooth sine of one continuous phase, and its size follows a smoothed speed, so a
sprint grows the bob over about a third of a second and no footfall makes a cusp. A step up a
stair is eased over a few ticks, and a landing dips the eye at most 6 cm. Never build a bob from
`|sin|` or `|cos|`, a fixed step length, or a per-tick random jolt; never multiply the rig's
numbers to make it "heavier".

The view model follows the camera; let it lag at most a quarter of the bob
(`world.rig.pose().bob` times `Comfort::current().bob_share()`), never more than half.

## Hitscan against Rapier colliders

A shot is a ray from the camera's eye (before its bob) along the aim, a little spread from
`ctx.rng`, skipping the shooter's own capsule:

```rust
let filter = player.body().map_or(QueryFilter::default(), |body| QueryFilter::default().exclude_rigid_body(body));
let ray = Ray::new(world.eye(), aim);
if let Some((collider, found)) = physics.cast_ray_and_get_normal(&ray, RANGE, true, filter) {
    let point = ray.point_at(found.time_of_impact); // found.normal faces the shooter
}
```

Never write your own box or slab tests: an enemy's capsule (`Character::collider()`), the walls
and every crate are already in the query. Put the hit in the world for the facet that owns the
target, and wire the weapon's facet before the enemy's (facets update in wiring order). A hole is
`Decal::on_wall(point, normal, 0.09, 0.09)` with a small depth, kept in a short ring.

## The view model

The arms and weapon are models: copy `docs/examples/fps-arms/` (rigged gloved arms on a rifle,
played by an animator) or make yours with `genex__asset` `model`. The FPS set's forearms, gloves
and pistol built from boxes are a greybox to prove the mechanics, never what ships. Draw them all
under `frame.tag("hands")` and one `frame.id(..)` between `frame.view_model()` and
`frame.end_view_model()`, so TAA moves them with the camera; keep their materials mid-tone (a
near-black glove reads as one dark slab). The draw hook gets the `Camera`: its right, up and back
axes turn a part's place in the camera's frame into the world.

- **Near plane.** The camera's near plane is 0.1 m: keep every visible part further out (a grip
  about 0.4 m ahead). Facing a wall, cast a short ray ahead each tick and pull the gun back by
  what is missing of its reach, or it pokes through the wall.
- **Sway** lags the turn: the tick's turn, scaled and clamped, eased into a kept offset.
- **Recoil** is one value set to 1 on a shot and decayed each tick: it pushes the gun back and up
  about the grip, cycles the slide, kicks the camera, and climbs the aim a little, which the hands
  pull back over the next ticks (an aim that keeps every climb sends the third shot over the
  target's head).
- **Flash.** For two ticks after a shot, a small emissive sphere at the muzzle and a short
  `point_light`, which also lights the hands.

## The enemy

`gfx.character(..)` with an animator graph: idle and walk on a `speed` float, fire and hit as
`.once()` states on triggers that return `.at_end()`, and a death state with no way out, which
holds its last frame. Its shot lands on a `g.event(fire, 0.25, "shot")` of the fire clip, so the
damage follows the animation. Hit it through its capsule's collider; on death take the capsule
out so later shots pass over the body.

## The bodycam lens

Barrel distortion, fringing, vignette, grain and compression shimmer are one Level-2 post pass
(`docs/api/custom-materials.md`): `[[wgsl]] kind = "post"`, `api = 2`, `fs_post` sampling
`gx_scene` through `gx_scene_uv`. Keep it off the HUD by running it with `frame.post_pass` (it
runs after the world, before the HUD).
