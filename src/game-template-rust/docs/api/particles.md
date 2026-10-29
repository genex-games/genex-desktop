# Particles

Steam from a vent, rain or snow over a street, dust in a sunbeam, sparks from a fountain: an
emitter made once and drawn every frame with `frame.particles(&emitter)`, one logical draw. A
particle is a pure function of the emitter and the tick the frame is drawn at, never of earlier
frames, so Live and a capture of the same tick draw the same particles; nothing is read back and
the simulation never sees them.

`Particles` is at the crate root: not in the prelude, and not under `genex::render`. Every call
in one line (each `with_*` takes `&self` and answers a new emitter):

```rust
use genex::{Particles, ParticlesError};                       // and PARTICLES_MAX, ParticleFlipbook
Particles::steam(origin);                                      // -> Particles; ::rain(top, half_extent), ::fountain(origin)
Particles::snow(top, half_extent);                             // -> Particles; ::dust(origin, half_extent)
emitter.with_rate(per_tick, lifetime_ticks);                   // -> Result<Particles, ParticlesError>
emitter.with_flipbook(atlas, columns, rows, frames, cycles, blend); // -> Result<Particles, ParticlesError>
emitter.with_origin(origin, half_extent);                      // -> Particles, like every with_* below
emitter.with_motion(velocity, spread, gravity);                // all Vec3 but spread: f32
emitter.with_look(size, end_scale, start, end);                // two f32 and two Colors
emitter.with_soft(metres).with_sorted(true).with_collision(thickness, rest_ticks);
emitter.with_shape(stretch_ticks, rotation_jitter, spin).with_seed(seed); // seed: u32
emitter.with_lit(1.0).with_size_variance(0.5).with_gusts(peak, period_seconds).with_flutter(reach, period_seconds);
emitter.following_camera(true);                                // an endless field around the camera
frame.particles(&emitter);                                     // -> &mut Frame
frame.weather(&Weather::heavy_snow(), seconds);                // two lit layers and their cover (docs/api/layered-materials.md)
```

```rust
// on_reset: kept in the world.
sim.world.steam = Particles::steam(vec3(4.0, 0.0, -2.0));
sim.world.rain = Particles::rain(vec3(0.0, 9.0, -10.0), vec3(6.0, 0.0, 14.0))
    .with_rate(120, 70)
    .expect("rain");
// on_draw:
frame.particles(&sim.world.steam).particles(&sim.world.rain);
```

`Particles::steam(origin)` rises slowly, grows and turns, drawn back to front and soft where it
meets walls and the ground; `Particles::rain(top, half_extent)` falls as streaks from the top of a
box and stops where it meets what the camera sees; `Particles::snow(top, half_extent)` drops soft
round flakes 2.5 cm across from the top of a box at 1 m/s, drifting, settling briefly where they
land; `Particles::dust(origin, half_extent)` hangs faint 5 mm motes throughout a box (a room, a
sunbeam: give it `.with_lit(1.0)` and the beam lights them); `Particles::fountain(origin)` throws
round warm sparks. Rain's streaks and the snow's and dust's round dots are soft sprites: never draw
weather or dust as meshes or cubes, which read as flying blocks. For weather over a whole level use
`Weather` (`docs/api/layered-materials.md`): two lit layers that follow the camera at plausible
densities, with gusts, and the cover they lay. A box moved with the camera every frame is a new
emitter every frame; `.following_camera(true)` instead wraps every particle into the emitter's box
around the camera (its `origin` then the box centre's offset from the camera), so one emitter made
once fills the view wherever the camera goes. `.with_lit(share)` lights the particles by the sun
through its shadows and by the sky (1 for snow, rain and dust; 0, the default, keeps the colour as
given, for sparks and glows), `.with_size_variance(share)` varies their sizes by up to that share
either way, `.with_gusts(peak, period_seconds)` adds up to `peak` metres a second of wind in gusts
that swell and die every `period_seconds` and sweep across as a front, and `.with_flutter(reach,
period_seconds)` sways each about its path. Change one with `.with_rate(per_tick, lifetime_ticks)` (at most
`PARTICLES_MAX`, 16384, alive at once), `.with_origin(origin, half_extent)`,
`.with_motion(velocity, spread, gravity)` (world units a tick at 60 ticks a second),
`.with_look(size, end_scale, start, end)`,
`.with_soft(distance)` (a billboard fades out over that many metres as it nears the scene behind
it instead of cutting a line; soft where the quality may run the depth prepass, desktop `medium`
and up, hard elsewhere), `.with_sorted(true)` (back to front, for smoke and steam that overlap),
`.with_collision(thickness, rest_ticks)` (a particle whose path went behind a visible surface, by
less than `thickness` metres, rests there, fading, then is gone; one hitting something out of view
is not stopped), `.with_shape(stretch_ticks, rotation_jitter, spin)` and `.with_seed(seed)`.
`.with_flipbook(atlas, columns, rows, frames, cycles, blend)` textures it from an sRGB atlas
under `assets/` (frames read row by row from the top left, played `cycles` times over a life,
cross-faded when `blend`); a missing atlas draws round particles and is logged once. Refusals
change nothing: `particles-count-invalid` (none alive, or more than 16384 at once) and
`particles-flipbook-invalid` (no frames, or a grid of no cells or more than 16 a side). Each
`with_*` answers the changed emitter and leaves the old one as it was. An emitter is its
description: the same one made again (in the next `on_reset`) is the same emitter, while a renderer
holds 16 different ones, so make them at a loading point, not a new one every frame.
A phone draws at most 32768 particles a frame (8192 on the low phones): past that every n-th
particle of each emitter is drawn.
