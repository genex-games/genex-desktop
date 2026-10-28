# Soldier kit

A rigged soldier for shooters as one GLB, `soldier.glb` (5.4 MB, about 20k triangles):
- **Body and clips:** Quaternius' Universal Animation Library mannequin (CC0) and its clips.
- **Gear:** combat clothes, a plate carrier with pouches, a helmet and knee pads.
- **Rifle:** the arms kit's AK-pattern rifle on a `weapon` bone, its magazine, charging handle and
  `muzzle` socket included.

`soldier.py` makes it in Blender. This folder is also a complete game's `src/` that animates it
from a remote player's replicated state, framed close so every animation can be seen.

## Use it

1. Copy `docs/examples/soldier/soldier.glb` to `assets/kits/soldier.glb`.
2. Copy `src/facets/soldier.rs`, and `SoldierNet` from `src/game.rs` into your world: one per
   remote soldier, written by your network code (or your AI) and nothing else.
3. Switch `[animation]` on in `genex.toml`.

## What drives it

`SoldierNet` is what a network game replicates:
- position, velocity, yaw, pitch, crouch and health;
- counters of shots, reloads and hits, with the hit's direction.

Counters, not events, so a late or lost packet still shows the shot once. The facet reads only
that, so two machines given the same state show the same soldier, to the bit (a test row checks).

| From the state | The animation |
| --- | --- |
| velocity in the soldier's own frame | idle, walk, run, strafe left or right, back (the walk at -1), each sped to the ground speed |
| crouch | crouched idle or walk |
| pitch | two additive layers (RifleAimUp, RifleAimDown over RifleAim) weighted by it: the rifle and torso tilt with the aim |
| running | the rifle held low (RifleLow) instead of aimed |
| shots counter | RifleFire, additive: kick and the carrier cycling; a flash at the `muzzle` socket |
| reloads counter | RifleReload on the upper body |
| hits counter, hit direction | HitFront, HitBack, HitLeft or HitRight, additive, from where the round came |
| health 0 | Death: the upper body's layers fade out and the rifle falls along the body |

The upper body is masked from `upper_chest` down, so the legs' gait never moves the rifle off the
aim. Feet are planted on the ground after each update (`plant_feet`). The draw is one
`frame.character` under the `soldier` tag and one `frame.id`.

## Measured

- The `soldier` probe gives the animator's layer states, the `muzzle` and `sight` sockets, and its
  digest.
- The `soldier-aim` demo holds the pitch at +0.5 then -0.5 and returns `muzzleRiseM`: how much
  higher the muzzle is aiming up.
- The game camera frames the soldier close from ahead; `side` and `yard` are named cameras.
- The script (`game.rs`) walks it through idle, walk, run, strafes, back, crouch, an aim sweep,
  fire, reload, four hits and death. `paused` stops the script, so a demo or your network writes
  the state.

## Change it

Copy `soldier.py` and `docs/examples/fps-arms/fps_arms.py` to `assets/src/`. Fetch the UAL's
Godot GLB and the scans, then run:

```
blender__model {name: "soldier", rig: true, model: "<the UAL GLB>", inputs: "assets/src/fps_arms.py,<scans>"}
```

- **What the script does:** it renames the body's bones to humanoid names, turns each kept clip
  so its chest faces ahead, and makes the strafes from the walk. The rifle clips are solved by IK
  and baked in.
- **What to edit:** the outfit's scans and tints (`OUTFIT`), the hold (`RIFLE_AT`, `GRIP`,
  `BLADE`) and `AIM_PITCH`, all at the top of the file.
