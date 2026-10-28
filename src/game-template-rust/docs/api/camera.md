# Camera

The game's view is the `Camera` its camera hook returns; first-person motion comes from
`FirstPersonRig`, never from code of your own. Every type and call in one line:

```rust
use genex::camera::{Comfort, FirstPersonRig, RigPose, RigStep}; // Camera and Projection are in the prelude
Camera::look_at(position, target);                          // Camera { position, target, up, fovy, projection }
FirstPersonRig::new().with_speeds(walk, sprint);            // -> FirstPersonRig, kept in the world
rig.update(ctx.dt, RigStep { velocity, turn, ..RigStep::from(&step) }); // in on_update, step: CharacterStep
rig.recoil(degrees); rig.impulse(strength);                 // a shot's kick; a blast's shake, strength 0..=1
rig.camera(eye, forward, fovy);                             // -> Camera, in the camera hook
rig.camera_with(eye, forward, fovy, &comfort);              // the same under a Comfort of your own
rig.pose(); rig.cadence(); rig.probe();                     // -> RigPose, steps per second, Value
Comfort::current();                                         // -> Comfort { head_bob, screen_shake, reduced_motion, fov_offset }
comfort.bob_share(); comfort.shake_share();                 // -> f32, 0..=1
```

## The field of view

`fovy` is the **vertical** field of view in degrees (for an orthographic camera, the view's height
in metres). The horizontal angle follows the window: 72 vertical is about 104° at 16:9, 100 is
about 130°. Pick from this range and never go wider to "feel fast":

| Game | `fovy` |
|-|-|
| First person (eye height 1.6 m) | 65-75 |
| Bodycam (chest, 1.4 m) | 70-75 |
| Aiming down sights | 50-60 |
| Third person, behind the shoulder | 50-60 |
| Top-down, strategy | 35-50 |

Every motion on screen grows with the field of view, so a wide lens makes the same bob look
larger. The person's field of view offset (`graphics.fov_offset`, -10 to +20) is added by
`rig.camera`; a camera of your own adds `Comfort::current().fov_offset`.

## First-person motion

`FirstPersonRig` turns what the body did into the eye's motion: walk bob, sway and roll from a
stride that grows with speed, a turn's lean, a landing's dip, recoil, slow handheld drift, a
blast's shake, the step up a stair eased over a few ticks, and a sprint's field of view kick. Its
state is a pure function of the simulation; the person's settings scale only the view, in the
camera hook, so nothing they pick enters the checksum. `docs/examples/fps.md` shows the wiring.

| Cap | Value |
|-|-|
| Step rate (the vertical bob's frequency) | at most 2.8 Hz |
| Bob, peak to peak | at most 2.8 cm |
| Walk roll | at most 1.2° either way |
| All roll together | at most 2° either way |
| Sprint field of view kick | at most 4° |
| Drift and shake | sines of at most 8 Hz, at most 1.5° |
| `ui.reduced_motion` | 10% of everything |
| `ui.head_bob` off | no bob, sway, roll or kick |
| `ui.screen_shake` | scales recoil, landings, drift and shake |

A brief or a critic that asks for a "heavier" or "shakier" camera gets this rig unchanged: the
caps keep the view comfortable for the person playing, and the settings menu lets them turn it
down further. Never add `|sin|` or `|cos|` bob, a fixed step length, per-tick random jolts or a
roll of your own on top.

Common mistakes:

- `RigStep::turn` is this tick's yaw change in radians, positive to the right (a mouse moved
  right), not a rate.
- Make the hitscan ray from the eye before the rig moves it (`world.eye()`), never from the
  camera the hook returns.
- A draw or probe hook may read `rig.pose()`; scale what it shows with
  `Comfort::current().bob_share()` so the view model obeys the person's settings too.
- `game.probe("camera", ..)` would put the rig into the checksum; a comfort check reads
  `game.probe_volatile("camera", |sim| sim.world.rig.probe())`.

## Third person

Keep the camera behind the shoulder at 50-60 vertical and ease its position toward the target
(`math::lerp` by a share each tick, kept in the world), never snapped. Leave the character's
walk to its animation: a third-person camera never bobs.
