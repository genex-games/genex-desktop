# Animation

A rigged GLB animates in three steps. `on_reset` makes the character's animator, `on_update`
advances it by `ctx.dt`, and `on_draw` draws it. Start with the simple animator; move to a graph
when you need parameters, layers or blend spaces. The types are in `genex::animation`, and
`Animator` is also in the prelude. Animation needs no physics: a game with physics off keeps
all of it.

## The simple animator (start here)

```rust
// on_reset (it returns nothing, so a refusal returns early; `docs/api/assets.md` shows reading its code)
let Ok(hero) = gfx.character("characters/hero.glb") else { return };   // animation-asset-invalid
let (Some(idle), Some(walk), Some(slash)) = (hero.clip("Idle"), hero.clip("Walk"), hero.clip("Sword_Attack")) else { return };
let Ok(mut animator) = Animator::simple(&hero) else { return };
animator.play(idle);
sim.world.hero = Some(animator);

// on_update
let Some(hero) = sim.world.hero.as_mut() else { return };
if moving { hero.crossfade(walk, 0.25); } else { hero.crossfade(idle, 0.3); }
if ctx.keys.pressed(Key::Space) { hero.play_once(slash); }
hero.speed(1.0);
let step = hero.update(ctx.dt);
```

- `Animator::simple(&hero)` shows the rest pose until the first call.
- `.play(clip)` cuts to a looping clip. Playing the clip already looping changes nothing.
- `.crossfade(clip, seconds)` blends into a looping clip from the next update. The seconds round
  to the nearest step of `CROSSFADE_LADDER_SECONDS` (0.05 s steps up to 0.5 s, then up to 2 s);
  0 cuts.
- `.play_once(clip)` cuts to a clip played once. From the tick it ends, it blends back over 0.2 s
  into the looping clip it interrupted. Started from the rest pose, it holds its last frame.
  `.play(..)` or another `.play_once(..)` interrupts it; a `.crossfade(..)` meanwhile only
  changes the clip it returns to, so calling `crossfade` every tick is fine.
- `.speed(s)` scales every clip (1 is as authored).
- `.playing_clip()` is the clip it plays or blends into.
- Each verb returns false, and changes nothing, for a clip the character lacks or on a graph
  animator. The last call before an update wins.
- It is an ordinary animator underneath. `update`, root motion, events (declare them with
  `hero.graph()`, `g.event(..)` and then `g.build_simple()`), `reach`, `look_at`, `socket`,
  `probe`, `snapshot` and drawing all work as below. A character takes at most
  `SIMPLE_CLIPS_MAX` (215) clips.

## The graph and the animator (on_reset)

```rust
let Ok(hero) = gfx.character("characters/hero.glb") else { return };   // animation-asset-invalid
let (Some(idle), Some(walk), Some(slash)) = (hero.clip("Idle"), hero.clip("Walk"), hero.clip("Sword_Attack")) else { return };
let mut g = hero.graph();
let speed = g.float("speed", 0.0);
let attack = g.trigger("attack");
let base = g.layer("base");
let idle = g.state(base, "idle", Motion::clip(idle));
let walk = g.state(base, "walk", Motion::clip(walk));
g.transition(idle, walk).when(speed.above(0.1)).inertialize(0.15);
g.transition(walk, idle).when(speed.below(0.1)).inertialize(0.2);
let upper = g.layer("upper");
g.layer_mask(upper, Mask::Humanoid(BodyPart::UpperBody));
let none = g.state(upper, "none", Motion::Empty);
let swing = g.state(upper, "slash", Motion::clip(slash).once());
g.transition(none, swing).when(attack.fired()).crossfade(0.08);
g.transition(swing, none).at_end().crossfade(0.15);
let hit = g.event(slash, 0.3, "hit");
let Ok(graph) = g.build() else { return };                           // animation-graph-invalid
let Ok(animator) = hero.animator(&graph) else { return };
sim.world.hero = Some(animator);
```

- `hero.clip("Walk")` is the clip of that glTF animation name, or `None`.
  `hero.clip_names()` lists them in file order.
- `hero.graph()` gives the builder: parameters (`.float(..)`, `.vec2(..)`, `.bool(..)`,
  `.trigger(..)`), layers with masks, additive layers and weights, states, and transitions.
  A transition takes `.when(condition)`, `.at_end()`, `.synced()`, `.crossfade(s)` or
  `.inertialize(s)` (the default, 0.2 s), `.priority(..)` and `.interruptible(..)`.
  `.build()` checks the graph.
- `hero.animator(&graph)` starts in each layer's first state. It refuses a graph built over
  another character.
- `hero.with_root_motion(&MotionSettings::DEFAULT)` extracts the clips' root motion. Without it,
  clips play in place.
- `hero.with_retargeted_clips(&ual)?` adds another humanoid's clips, retargeted onto this
  skeleton (a UAL walk on a Meshy hero). Each limb points where the source's does, and the hips'
  travel scales by leg length. Call `.with_root_motion(..)` after it.

## Advancing (on_update)

```rust
let Some(hero) = sim.world.hero.as_mut() else { return };
hero.set_float(speed, wish.length());
if ctx.keys.pressed(Key::Space) { hero.fire(attack); }
let step = hero.update(ctx.dt);
if step.events.iter().any(|event| event.event == hit) { /* deal damage */ }
```

- `animator.update(dt)` steps the graph by `ctx.dt`. It returns the tick's events and root
  motion. Both come from clip time, so they are the same on every destination. Hand the root
  motion to the controller: `character.drive(physics, CharacterMotion::Root(step.root_motion), ctx.dt)`.
- Only the simulation moves an animator. A draw or probe hook reads `&Sim`, so
  `animator.update(..)` there does not compile.
- `animator.set_float(..)`, `.set_vec2(..)`, `.set_bool(..)`, `.fire(..)`, `.jump_to(state)` and
  `.set_layer_weight(..)` drive the graph. `.state_name(layer)`, `.normalized_time(layer)` and
  `.in_transition(layer)` read it.
- `animator.reach(limb, target)` and `.look_at(target)` aim limbs and the head (IK, character
  space). `.socket(joint, model)` is a joint's world matrix, for a sword tip.
- `animator.snapshot()` and `.restore(..)` carry the whole state, floats as bits.
- `game.probe("hero", |sim| sim.world.hero.as_ref().map_or(Value::Null, Animator::probe))` gives each layer's state, clip time and
  transition, and the parameters. `animator.digest()` hashes the whole state.

## Drawing (on_draw)

```rust
let Some(hero) = &sim.world.hero else { return };
frame.tag("hero").character(hero, sim.world.body.transform().into());
frame.character_with(hero, at, &CharacterDraw::new().tint(Color::RED).material(&cloth));
frame.skeleton_debug(hero, at);
```

- `frame.character(..)` is one logical draw under the current tag. The presenter skins the GLB in
  the animator's pose (every skinned primitive, each part with its own material). A missing file
  draws the magenta checker; a file the renderer cannot skin draws its model in bind pose.
- In Live a far character's pose is held between evaluations: every tick near the camera, every
  2nd, 4th or 8th tick as its projected height (LOD's screen-size metric, from the game camera)
  falls past 240, 120 and 60 pixels of a 1080-pixel view. A capture is always full rate. Drawing
  never moves the animator or the simulation.
- A character under 240 pixels whose materials are all plain and opaque is skinned in the vertex
  stage. Nearer characters, and characters with masked, double-sided or transparent parts, are
  skinned by a compute pass. The vertex path keeps no skinned vertex buffers, and it draws the
  same picture as the compute pass, including the shadows and the motion vectors.
- Each device class skins at most so many characters by compute in a frame: 128 on
  `desktop-ultra`, 100 on `desktop-high`, 64 on `desktop-mid`, 32 on `desktop-low`, 16 on
  `mobile-high`, 12 on `mobile-mid`, 8 on `mobile-low`, and at most 40 in a browser. Past it the
  smallest on screen are skinned in the vertex stage too (masked, double-sided and transparent ones
  stay on compute), so a crowd keeps its picture and holds no more skinned memory.
  `state().volatile.render.characters` shows the last frame's `drawn`, `evaluated` and `held`
  characters and its `computeSkinned` and `vertexSkinned` counts against `computeMax`; it is never
  part of the checksum.
- A character GLB with simplified levels (the Studio's import writes them on every primitive of a
  model of 512 or more triangles, skinned ones included) skins only the level its distance picks,
  with the screen-size metric and crossfades models use: the compute pass near, the vertex stage
  far. During a crossfade both levels are skinned by the compute pass. Every level keeps the
  joints and weights of the vertices it uses and poses with the same skeleton, so nothing changes
  in the animator. A file whose parts' levels do not line up draws whole.
- `frame.character_with(..)` takes a `CharacterDraw`: `.tint(..)`, and `.material(..)` to replace
  the GLB's materials.
- `frame.skeleton_debug(..)` draws every bone as one line batch (one logical draw).

## Rigid node clips (doors, platforms, props)

A GLB without a skin whose nodes move by its own animations (a door, a lift, a turning sign)
plays through a node animator, not a character:

```rust
// on_reset (a refusal returns early)
let Ok(clips) = gfx.node_clips("props/door.glb") else { return }; // animation-clip-missing: no animations
sim.world.door = Some(clips.animator());
sim.world.door_model = gfx.assets().model("props/door.glb");

// on_update
let Some(door) = sim.world.door.as_mut() else { return };
if opening { let _ = door.play_once("open"); } // .play("open") loops; .stop() rests
door.update(ctx.dt);

// on_draw
if let Some(door) = &sim.world.door { frame.model_posed(&sim.world.door_model, door, transform); }
```

- The animator is the clip and its time: simulation state that replays exactly, and
  `door.probe()` (`{clip, time, once, finished}`) for a probe. It holds the file's clips, so it is
  not a serde field: save `door.snapshot()` in a save section and put it back with
  `.restore(..)`, which continues mid-swing exactly. `.finished()` says a clip played
  once reached its end; `.clips()` names the file's clips (`.clip_names()`).
- `frame.model_posed` is one logical draw with every node at the pose, its GLB's materials, its
  shadows; a model of another file than the animator's draws at rest, as `frame.model` does.
- `frame.model` of the same file stays at rest: node animations play only through the animator.

## Refusals

- `animation-asset-invalid`: a file that is not a GLB with a usable skin or clips, or a snapshot
  of another animator.
- `animation-graph-invalid`: a graph that cannot run (no layer, a layer without a state, a
  transition across layers, a duplicate name, a NaN or negative time), or one built over another
  character.
- `animation-clip-missing`: `gfx.node_clips` of a GLB with no animations, or a clip name the
  file does not have (`play`, `play_once`).
- `animation-retarget-unmapped`: a retarget where either character lacks a humanoid bone (the
  toes are optional). It names the bone and the character.
- `animation-disabled`: `gfx.character`, `gfx.node_clips` or an animator in a game whose
  genex.toml sets `[animation] enabled = false`. Turn animation back on.
- `ragdoll-profile-invalid` and `character-shape-invalid`: see `docs/api/characters.md`.
