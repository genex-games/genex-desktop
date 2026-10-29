# Grading and the lens

Every type and call in one line (each a `RenderConfig` or `Grading` builder):

```rust
use genex::render::{CameraLens, DepthOfField, Grading, GradingLut, GradingSection, MotionBlur, RenderConfig};
game.render_settings(RenderConfig::from_build().grading(grade)); // from_build keeps genex.toml's [render]
Grading::NEUTRAL.with_contrast(1.1).with_saturation(0.95).with_vibrance(1.1); // each 0..=2, 1 is none
Grading { shadows: GradingSection { lift: -0.01, ..GradingSection::NEUTRAL }, ..Grading::NEUTRAL }; // midtones, highlights
grade.with_lut(GradingLut::parse_cube(text)?.intern()?, 0.8);  // -> Result<_, GradingLutError>
config.temperature(0.3, 0.0).white_balance([1.0, 0.85, 0.65]).exposure_curve(&[(-8.0, -6.0), (0.0, 0.0)]);
config.depth_of_field(DepthOfField::focused(3.0, 2.0)).motion_blur(MotionBlur::shutter(0.5));
game.gpu_pass("camera-lens", PassStage::Post, CameraLens::bodycam().grain(0.5, 1.5)); // found_footage(), cinematic()
```

Grade last. Build a scene's look in this order and check a capture after each step: the
environment and the sun's elevation, the local lights, a reflection probe and an irradiance volume
for each room or courtyard, the fog, the exposure (auto, with its curve), and only then the grade.
A grade never fixes light: a dark room wants a light, a probe or a volume, not lift; a grey
meadow wants less fog, not saturation.

Tune `[render.look]` live, no rebuild: the `renderSettings` verb's `{set: {look: {ev_compensation:
0.7, bloom_intensity: 0.03, exposure: "auto"}}}` lays those keys over the running game's look (an
unknown key or value answers `invalid-look`). Capture, adjust, then copy the values into
`genex.toml` `[render.look]`; `{set: {look: null}}` gives the game's look back.

The grade is code only (`use genex::render::{Grading, GradingLut, RenderConfig};`). A config
set in code replaces `genex.toml`'s `[render]`, so start from the one the build compiled in and
the toml's look, fog and per-class wishes stay: `game.render_settings(RenderConfig::from_build()
.grading(Grading::NEUTRAL.with_contrast(1.1).with_saturation(0.95).with_vibrance(1.1)))`.
Each knob is held to `0..=2` and 1 changes nothing. The knobs grade the HDR scene before the
tonemapper: contrast turns about middle grey, so it never moves the exposure;
`.with_vibrance(..)` saturates most the colours whose red does not already lead (skin and warm
light keep their tone), the gentler first reach for a dull scene; `.with_saturation(..)` turns
every colour alike. Per section (`shadows`, `midtones`, `highlights`, Blender's cut-offs), lift, gamma and gain are fields:
`Grading { shadows: GradingSection { lift: -0.01, ..GradingSection::NEUTRAL }, ..Grading::NEUTRAL }`.
A display LUT grades after the tonemapper: `.with_lut(GradingLut::parse_cube(include_str!(
"../assets/looks/warm.cube"))?.intern()?, 0.8)` (a `.cube` file, its intensity `0..=1`). Warm or
cool the frame with `.temperature(0.3, 0.0)` (temperature and tint, each `-1..=1`;
neutrals warm while a blue sky stays blue) or `.white_balance([1.0, 0.85, 0.65])` (linear gains
that keep the brightness), never with `fog_color`. Keep a dusk dark under auto exposure with
`.exposure_curve(&[(-8.0, -6.0), (0.0, 0.0)])` (metered EV, EV added; at most 8 points). The grade,
white balance and curve are the look: the same on every preset and device.

Expose before you grade. Calibration (`[render.look]`; scene EV 0 is EV100 12, `genex::render::units`):

| scene | `exposure` | `metering` | `ev_compensation` | `ev_min` | settled `meanLuma` |
| --- | --- | --- | --- | --- | --- |
| sunlit exterior | `auto` | `ground` | 0.5 | default | 110-140 |
| lit interior with windows (a classroom, an office) | `auto` | `center` or `ground` | 0 to 0.5 | default (-8) or lower | 90-130 |
| night or horror interior (declared as such) | `auto` | `center` | -0.5 to -1 | -10 | 50-80 |
| stylized, flat colour | `manual` | - | 0 | - | the palette's |

In a lit interior keep the darkest tenth of the histogram below 15 % of the frame: light the room
with its fixtures at their real flux and give it a volume; never raise `ev_min`, never push
`ev_compensation` below 0, never pair a negative lift with contrast above 1.15 (Grading).
`state().__render.exposure` reports what the exposure did on the last frame read back, a few frames
late: `mode`, `meteredEv` and `targetEv` (null under manual), `appliedEv` (the frame is drawn at
`2^(compensation - appliedEv)`), `evMin`, `evMax`, a 16-bin `histogram` of the metered scene EV
over `histogramEv` (shares summing to 1), `doorwayBoost`, `ageFrames` and `warnings`
(`ev-min-raised-with-doorway-adaptation`, `doorway-adaptation-under-manual`). A `meteredEv` at
`evMin` means the room is darker than the exposure may follow: light it. `__render.exposureTrace`
holds `{t, appliedEv, meteredEv}` for each read-back of the last 10 simulated seconds, so a
doorway walk's state carries its transition.

The lens is off by default and is the look's too:
`.depth_of_field(DepthOfField::focused(3.0, 2.0))` keeps three metres sharp at f/2 (a cutscene, a
photo mode, an inspected object), and `.motion_blur(MotionBlur::shutter(0.5))` blurs what moved by
half its motion each frame (a 180-degree shutter; a racer or a fast camera). Depth of field draws
on frames with the depth prepass, `medium` and up (a ring gather on desktop and web `high` and
`ultra`, a cheaper circular one elsewhere and on phones); motion blur draws on frames under TAA
(a reconstruction on `high` and `ultra`, one pass on phones, none on the low phones). Leave both
off for play the person steers: they hide detail and some people find them uncomfortable. A
capture leaves them out unless its `lens` asks.

A camera body is the engine's `CameraLens`, never a hand-written lens shader:
`game.gpu_pass("camera-lens", PassStage::Post, CameraLens::bodycam())` (or `found_footage()`,
`cinematic()`, `new()` and the builders `.vignette(a)`, `.grain(a, size)`, `.chromatic_aberration(a)`,
`.distortion(a)`, `.roundness(r)`, each `0..=1`). It draws on the finished frame: a vignette, grain
strongest in the mid-tones, a fringe growing towards the corners and none at the centre, and a barrel
zoomed to keep the corners filled (widen the camera's `fovy` tangent by `lens.fov_scale()` to keep
the view). On `high` and `ultra` the bend resamples with Catmull-Rom so edges stay sharp; elsewhere
with one bilinear tap. Grain cells and fringes are sized for 1080 rows and scale with the output.
Captures stay clean unless `.in_captures(true)`: checks and judges see the frame without it.
