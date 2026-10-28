# First-person arms kit

Gloved arms on an AK-pattern rifle as one rigged GLB, `fps-arms.glb` (2.5 MB, about 14k
triangles). The rifle is built from parts: receiver, dust cover, barrel, gas tube, wooden
handguards, grip and stock, iron sights and a side rail. Its magazine, charging handle and
trigger are bones of their own, with the clips a view model plays. `fps_arms.py` makes it in
Blender; this folder is also a complete game's `src/` that plays it, so start any first-person
shooter from it rather than from boxes.

## Use it

1. Copy `docs/examples/fps-arms/fps-arms.glb` to `assets/kits/fps-arms.glb`.
2. Copy `src/facets/viewmodel.rs` and `src/facets/rifle.rs`. Wire them in that order (rifle
   first), and add the world fields and actions `src/game.rs` declares (or copy the folder whole).
3. Switch `[animation]` and `[physics]` on in `genex.toml`, as this folder's does.

The kit is in the camera's frame: the eye at its origin, looking along -z. `viewmodel.rs` draws
it at the camera with `frame.character`, under `frame.tag("hands")` and one `frame.id`.

## What the GLB holds

| Clip | Seconds | What it shows |
| --- | --- | --- |
| `Idle` | 4, loop | breathing at the hip |
| `Walk` | 1, loop | two steps of sway |
| `Sprint` | 0.67, loop | the rifle across the chest |
| `AdsIn`, `Ads`, `AdsOut` | 0.25, 2 (loop), 0.25 | up to the sights, held, back down |
| `Fire` | 0.1 | one round at 600 a minute: kick, carrier back and forward, trigger |
| `DryFire` | 0.3 | the trigger clicks |
| `Reload` | 2.6 | magazine rocked out and held clear (0.6–0.85 s), dropped; a new one up, hooked and rocked in (1.85 s); the handle racked (2.3 s) |
| `Inspect` | 3.2 | the left side, then the right |

Joints: `weapon` carries the rifle; `magazine`, `charging_handle` and `trigger` move under it.
`muzzle`, `sight` (the rear notch), `sight_front` (the post's top) and `eject` are sockets for
`animator.socket(..)`. The arms (`upperarm`, `forearm`, `hand` per side) were solved onto the
rifle by IK in Blender and baked into every clip, so the hands stay on it with no IK in the game.

## How `viewmodel.rs` plays it

- **The graph.** The base layer holds idle, walk and sprint (on `speed` and `sprint`), the
  sights (on `aim`), and Reload and Inspect (on triggers). Fire and DryFire play on an additive
  layer whose reference is Fire's first frame, the hip pose. A round fired down the sights still
  kicks and cycles the carrier. Two fire states take turns, so every round restarts the clip.
- **Rules first.** `rifle.rs` decides rounds, cadence and the reload's timing on its own clock,
  using the clips' numbers: 6 ticks a round, 156 ticks a reload, the new magazine counted in at
  tick 111. The view model only fires the trigger of what began this tick.
- **Sim-state motion.** The sway against the turn, the kick and the pull-back from a wall move
  the whole kit through the transform it is drawn at. They shrink down the sights, so the sight
  line settles on the centre.
- **Muzzle.** The flash (a short emissive sphere and point light) and the tracer start at the
  `muzzle` socket, wherever the clip has the rifle.
- **Measured.** The `viewmodel` probe gives `sightsOffAxisDeg` (rear notch, front post: both
  under 0.3° when aimed) and `magazineOutM` (0 seated, about 0.15 held clear mid-reload). The
  `ads` and `reload` demos return the same.

## Change it

Copy `fps_arms.py` to `assets/src/fps_arms.py` and run
`blender__model {name: "fps-arms", rig: true}`. Its `SEED`, `LOOK` (colours and roughness), `HIP`
and `ADS` poses, and each clip's function are at the top of the file. Its textures are made by
the script itself (tileable, at world scale), so it needs no inputs and nothing is fetched. A
different rifle keeps the joint names and moves `SIGHT_HEIGHT`, `MAG_TOP` and the other points.
