# Animation

A rigged GLB animates in three steps. `on_reset` builds the character's graph and animator,
`on_update` advances the animator by `ctx.dt`, and `on_draw` draws it. The types are in
`genex::animation`, and `Animator` is also in the prelude. Animation needs no physics: a game
with physics off keeps all of it.

## The graph and the animator (on_reset)

```rust
let hero = gfx.character("characters/hero.glb")?;          // animation-asset-invalid
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
sim.world.hero = Some(hero.animator(&g.build()?)?);       // animation-graph-invalid
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

- `frame.character(..)` is one logical draw under the current tag. A missing file draws the
  magenta checker.
- `frame.character_with(..)` takes a `CharacterDraw`: `.tint(..)`, and `.material(..)` to replace
  the GLB's materials.
- `frame.skeleton_debug(..)` draws every bone as one line batch (one logical draw).

## Refusals

- `animation-asset-invalid`: a file that is not a GLB with a usable skin or clips, or a snapshot
  of another animator.
- `animation-graph-invalid`: a graph that cannot run (no layer, a layer without a state, a
  transition across layers, a duplicate name, a NaN or negative time), or one built over another
  character.
- `animation-retarget-unmapped`: a retarget where either character lacks a humanoid bone (the
  toes are optional). It names the bone and the character.
- `ragdoll-profile-invalid` and `character-shape-invalid`: see `docs/api/characters.md`.
