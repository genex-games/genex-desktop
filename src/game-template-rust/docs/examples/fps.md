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

## The camera: chest-cam bob

A bodycam rides on the chest (about 1.4 m) with a wide lens (`fovy` about 72). Keep the metres
walked in the world (`stride += speed * dt`) and derive the bob from it in the camera hook: a
sway at the step's rate, a lift at twice it, a slight roll through `Camera::up`, all scaled by the
speed. A draw or camera hook has no `ctx`, so every motion comes from world state.

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

Build the hands and the gun from parts in the camera's frame before reaching for a model:
forearms in sleeves rising from below the camera, gloves around the grip and a support hand, a
slide over a frame, a raked grip, sights. Mid-tone materials (a near-black glove reads as one dark
slab); draw them all under `frame.tag("hands")` and one `frame.id(..)`, so TAA moves them with the
camera. The draw hook gets the `Camera`: its right, up and back axes turn a part's place in the
camera's frame into the world. Swap a part for a GLB later with `frame.model` at the same
transform.

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
