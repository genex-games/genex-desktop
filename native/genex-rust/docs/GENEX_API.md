# The genex API

This page is the contract a game's Rust code is written against. Studio copies it read-only
into every Rust game folder as `docs/GENEX_API.md`. The facade crate is `genex`; everything
below comes from `use genex::prelude::*;`.

## A game

```rust
use genex::prelude::*;

#[derive(Default)]
struct World { score: u32 }

fn main() {
    let mut game = Game::new(World::default()).title("Pond").world_size(960, 540);
    game.on_update(|sim, ctx| if ctx.keys.pressed(Key::Space) { sim.world.score += 1; });
    game.on_draw(|sim, frame, _camera| { frame.tag("score").cube(Transform::IDENTITY, Color::WHITE); });
    game.probe("score", |sim| json!(sim.world.score));
    genex::install(game);
}
```

The game folder holds `src/main.rs`, `src/facets/*.rs`, `assets/` and `genex.toml`. It has no
`Cargo.toml`: the host writes the manifest and lock. Game code never uses `unsafe`, build
scripts, cargo configuration or renderer internals.

## Hooks

Every hook gets a `Sim<W>`: `sim.world` (your `W`), `sim.physics` (Rapier 3D) and
`sim.facets` (each facet's private state). `sim.split()` lends the world and physics together.

| Hook | Signature | Kind |
| --- | --- | --- |
| `on_reset` | `(&mut Sim<W>, seed: u32, rng: &mut Pcg32, gfx: &Gfx)` | mutating |
| `on_update` | `(&mut Sim<W>, &Ctx)` | mutating |
| `on_ui` | `(&mut Sim<W>, &mut egui::Ui, &Ctx)` | mutating |
| `demo(name, ..)` | `(&mut DemoDriver<W>) -> Value` | mutating |
| `on_draw` | `(&Sim<W>, &mut Frame, &Camera)` | read |
| `camera` | `(&Sim<W>) -> Camera` | read, single |
| `named_camera(name, ..)`, `eye(name, ..)` | `(&Sim<W>) -> Camera` | read |
| `probe(name, ..)`, `probe_volatile(name, ..)` | `(&Sim<W>) -> Value` | read |
| `player` | `(&Sim<W>) -> Value` | read, single |

Read hooks take `&Sim` and are `Fn`, so the compiler refuses a draw, camera or probe that
changes the simulation: captures, observer cameras and Live frames never move the checksum.
Animation that exists only on screen derives from simulation state: a read hook has no `ctx`,
so a draw that needs the time reads a tick the world keeps from `on_update` (`ctx.tick`).

- **Seed.** `seed(n)` rebuilds the `Sim` from `W::default()`, each facet's `T::default()` and an
  empty physics world, then runs every `on_reset` in registration order with `rng` seeded from
  `n`. The runtime starts on seed 1 and is paused after every seed.
- **Tick.** A tick is 1/60 s. It runs every `on_update` in registration order, then every
  `on_ui`, then steps physics once. `step(ms)` runs `max(1, round(ms / 16.667))` ticks, at most
  36,000.
- **Single-valued hooks.** A second `camera` or `player` makes `install` panic
  (`duplicate-camera`, `duplicate-player`) unless it is marked as the replacement:
  `game.camera(..).camera_override();`, `game.player(..).player_override();`.
- **Probes.** Probes are `state()` leaves the checks read, merged in registration order. Write
  one per mechanic, each a small JSON value that says whether the mechanic works (a count, a
  position, a flag), never a dump of the world. A probe never reuses a key `state()` owns or
  another probe's name; `probe_volatile` values appear under `state().volatile` and stay out of
  the checksum (use it for anything that is not a function of the seed and the input).
- **State keys.** `state()` owns `version`, `contractVersion`, `seed`, `frame`, `simulatedMs`,
  `running`, `fps`, `held`, `pointerLock`, `hud`, `camera`, `error`, `player`, `volatile`,
  `__render`, `assets` and `checksum`. `hud.items` lists the label of every egui widget the last
  tick drew, in drawing order, so a check can find a widget by its label.
- **Demos.** A demo scripts what a generic walk cannot reach (a state behind a menu, a long
  chain of inputs). Its driver offers `sim()`, `sim_mut()`, `inject(input)`, `advance_ms(ms)`
  and `save(file, bytes)`, and the value it returns is the demo's answer (a check captures the
  frame after the demo with the `capture` verb). The runtime
  is paused after a demo. Only a demo can advance time: `advance` inside `on_update` does not
  compile.
- **Names.** Probe, camera, eye and demo names are non-empty, at most 64 characters, without
  control characters, and unique within their kind. `"default"` is not a camera name.
- **Install refusals.** `install` checks the registrations and panics with one typed code before
  anything runs: `duplicate-camera`, `duplicate-player`, `duplicate-probe`, `reserved-probe`
  (a probe named like a `state()` key), `duplicate-camera-name`, `duplicate-eye`,
  `duplicate-demo`, `invalid-name`, `duplicate-facet-state` (one state type registered twice)
  and `invalid-world-size`. `game.gpu_pass` panics `gpu-pass-invalid` as it is registered: an
  empty, overlong or repeated pass name, or one pass over the cap.

## Verbs

The studio and its checks drive a running game through a fixed set of verbs; the game never
calls them and cannot add one. `seed(n)`, `start`, `pause` and `step(ms)` control time;
`state` reads the probes and runtime keys; `input` injects keys, pointer, look, wheel, text,
pads and touches; `capture` renders a view; `renderSettings` reads or changes the renderer's
quality for this session (see Rendering); `cameras`, `eyes`, `debugCamera`, `demos` and `demo`
reach what the game registered. `docs/CONTRACT.md` lists each verb and the refusals a run can
answer.

## Ctx

`ctx.keys` (`down`, `pressed`, `released` by `Key`, the DOM code names), `ctx.touches`,
`ctx.pads`, `ctx.pointer` (fraction of the frame, y down), `ctx.look`, `ctx.wheel`,
`ctx.text`, `ctx.rng` (the only randomness), `ctx.dt` (1/60), `ctx.tick` (ticks since the last
seed), `ctx.world_size`, and `ctx.save(file, bytes)` / `ctx.load(file)` for the game's own save
folder (a safe relative name; a folder the studio gives each run). On Vulkan the renderer keeps
its pipeline cache in the same folder (`genex-pipeline-cache/<adapter>.bin`): leave that name alone.

`world_size` is the game's logical size on every screen: touches, the pointer, the HUD's points
and a capture's default size are measured in it. It is not the resolution: Live frames are drawn
at the window's own pixels (capped per device class), so a larger window is sharper, never a
stretched picture, and a capture is drawn at the world size unless a check asks for another.

Edges fire on the first tick after input arrives, so a long step never presses a key twice.
`Input::key_tap(Key::Space)`, `Input::key_down`, `Input::key_up`, `Input::click_at(x, y)`,
`Input::pointer`, `Input::look`, `Input::wheel` and `Input::text` build injections;
`a.and(b)` combines them.

**Touch** is the first-class pointer on phones and tablets, and every destination delivers it
the same way. `ctx.touches.all()` lists the fingers this tick, each a `Touch` with a stable
`id`, a world position in pixels (y down, the game's own `world_size` before any letterbox) and a
phase: `Began`, `Held`, `Ended` or `Tapped` (down and up between two ticks). `tapped()` and
`began()` answer for any finger. The mouse's first button arrives as touch 0, so one code path
serves a desktop and a phone: do not also read `ctx.pointer` for the same action. Multi-touch
needs only the list. `Input::touch_start(id, x, y)`, `Input::touch_move(id, x, y)` and
`Input::touch_end(id, x, y)` inject a finger (the `touch` input kind; the others are `gamepad`,
`text`), which is how a demo and the checks play a touch game.

## UI

`on_ui` draws egui widgets inside the tick; this is the whole HUD (score, health, a menu, a
button), and a game has no other UI path. It runs exactly once per tick with the egui `Ui` laid
over the world: one egui point is one world pixel, y down. egui reads only the merged input
(keys, touches and the pointer as touch 0) and the simulated clock, and its memory resets on
every seed, so a scripted click on a button replays exactly and the HUD of two runs on one seed
is the same picture. Painting is display only. It never changes what a later tick sees, so keep
state in the world and let `on_ui` read it. Give a widget its visible label: checks find widgets
by it (`state().hud.items`). While a widget holds the keyboard's focus (Tab to it, or a tapped
text field), keys are the widget's and the update hooks see none until Escape or a click
elsewhere; mouse buttons and touches stay the game's. On a phone keep tap targets large and clear
of the screen edges.

## Drawing

`frame.tag(name)` names what the following draws count under (`state().__render.tags`);
`frame.model(&model, transform)`, `frame.cube`, `frame.sphere`, `frame.line` and
`frame.clear(color)` record draws. `gfx.assets().model("pond.glb")` in `on_reset` gives a model
handle; a missing or unsafe path (absolute, `..`, `.`, backslash) gives a missing model that
draws as a magenta checker, never a crash. A model the renderer could not load (not in
`assets/`, or malformed) is named in `state().__render.missingModels`, a key that is absent
while every model loads. The Studio's asset import writes a compressed (Draco, meshopt) or
quantized (`KHR_mesh_quantization`, gltfpack's default) GLB back plain with float attributes; at
runtime an attribute stored in any other layout than core glTF's is refused, never misread. A
model of 512 or more triangles gets simplified levels at import, and each drawn copy far from the
camera draws a coarser one, in its shadows too.
`Camera::look_at(position, target)` places a view;
`Camera { projection: Projection::Orthographic, fovy: 12.0, ..Camera::look_at(position, target) }`
draws it orthographic, `fovy` then being the view's height in world units (a 2D or isometric
game: an object keeps its size at any distance).

## Lighting, materials and environment

Light a frame with `frame.sun(direction, color, intensity)` (towards the sun; it casts the
shadows), `frame.ambient(color, intensity)`, `frame.point_light(position, range, color,
intensity)` and `frame.spot_light(position, direction, range, color, intensity)` (a cone, full
strength within 20 degrees of `direction` and dark past 30); a frame that names none keeps the
defaults (a white sun at 2.5 from `(0.4, 1, 0.3)`, white ambient at 0.08). For another cone or a
shadow map, `frame.spot_light_with(&SpotLight::new(position, direction, range, color, intensity)
.with_cone_degrees(25.0, 40.0).with_shadow(true))` (`use genex::render::SpotLight;`); the
device's quality decides how many spots get a shadow map (none on `low` and `medium`, two on
`high`, four on `ultra`, at most one on a phone), given to the asking spots on screen nearest the
camera, and the rest light unshadowed. A spot keeps its map until another stays clearly nearer
for a quarter of a second; the two shadows then cross-fade over a quarter of a second, so none pops
as the camera moves (a capture gives the maps to the nearest spots). Point and spot lights fade smoothly to nothing
at their range, so give each the range it needs, not more: a lantern 3 to 4 units, a street lamp
8. Every preset bins them by screen tile and depth, on the HDR and the LDR scene alike, so a scene
may hold hundreds; the preset caps how many a frame lights (phones at most 256), nearest first,
fading the farthest kept ones out so a light crossing the cap never pops. Give a draw its surface with a `Material`:
`Material::color(Color::rgb(255, 200, 80)).with_metallic(1.0).with_roughness(0.25)`, textures by
asset path with `.with_base_texture("textures/bark.png")`, drawn with `frame.cube_with`,
`frame.sphere_with` or `frame.model_with` (a GLB's own materials, emission and textures load by
themselves: an alpha-`MASK` leaf or fence is cut out in its shadow too, a `doubleSided` card
draws both faces, an occlusion map darkens its crevices' ambient light). A missing texture leaves the surface untextured; `.with_untextured_color(color)` names
the colour drawn then, so optional downloaded textures keep a stand-in. A texture keeps its resolution up to the size class the device and the game's
`[render]` choose at load (512 texels on `low`, 1024 on `medium`, 2048 from `high` on desktops;
phones stop at 1024), so author it at the size it is seen at; the classes stay fixed until the
game reloads (a person's preset change in the panel, or a capture "as a phone", keeps them), and
captures on one device always draw the same textures. Normal maps lose no sparkle with distance
or in a smaller class (their mips widen the roughness by what was averaged away). A
surface glows with `Material::emissive(color, strength)` or
`.with_emissive(color, strength)` (strength in a light's units: 1 is white lit to radiance 1,
above it the look's bloom haloes it; `.with_emissive_texture(path)` masks it). Emission lights
the picture, not other surfaces: pair a lantern's glowing glass with a `frame.point_light`, a lit
window with a `frame.spot_light` shining out of it.

A room's polished floor reflects the sky until it has a reflection probe:
`frame.reflection_probe(&ReflectionProbe::new(min, max).with_capture(eye).with_blend(0.4))`
(`use genex::render::ReflectionProbe;`) covers the axis-aligned box `min..max`, the room's inside
from its floor to its ceiling; glossy surfaces in it reflect a cube captured from `capture`
(default the box's centre; put it at eye height in the room), each wall seen where it stands,
fading into the sky and the next probe over `blend` units past the box's faces (overlapping probes
share their light, so no seam shows). The cube is
captured from the scene the first frame the probe appears, and again when the sky changes or the
probe's box or capture point moves: objects that move later are not in it. The device's quality
gives cubes to the first probes a frame declares (4 on `low`, 8 on `medium`, 16 on `high` and
`ultra`; 2 to 8 on phones); the rest reflect the sky. Give a probe to each room or courtyard,
not to open ground (the sky is its reflection already).

Give a frame an environment with `frame.environment(..)` (`use genex::render::Environment;`): it
lights the scene beyond its lights and is drawn behind it, the same on every device.
`Environment::sky()` is the physical sky, coloured by the frame's own sun, tuned with
`Environment::Sky(SkyParams::default().with_ground_albedo([0.1, 0.12, 0.06]))` (also
`with_sun_angular_radius_degrees`, `with_intensity`). Under the sky `frame.sun` is the light
outside the atmosphere: give it a white colour and let its elevation do the rest. The sky and the
surfaces both see it through the atmosphere, so a sun 5 to 12 degrees up gives a golden hour (sky
and ground warm alike), a lower one a sunset, and one below the horizon a dusk that no longer
lights the ground. `Environment::hdri("env/sky.hdr")` lights the scene with an equirectangular
Radiance `.hdr` under `assets/` (`HdriEnvironment::new(path).with_rotation_degrees(90.0)
.with_intensity(0.5)`, inside `Environment::Hdri(..)`) and is drawn behind it. By default
(`HdriSun::Analytic`) the map's sun becomes the frame's sun: it is clamped out of the map's light
and replaces `frame.sun`'s direction and colour (turned and scaled with the map), so the shadows
fall where the map's light comes from; a map without a sun keeps `frame.sun`.
`.with_sun(HdriSun::Off)` keeps the map as it is and `frame.sun` as you set it. A map that is
missing or does not decode is logged once and the frame keeps the flat colour.
`Environment::Color`, what a frame that names none draws, is `frame.ambient` with `frame.clear`
behind. Where the device's quality turns image-based lighting on, the environment replaces
`frame.ambient` for built-in materials and `gx_shade_pbr` alike, and where it turns the sky on it
replaces the clear colour; elsewhere the flat ambient light and the clear colour stay, so keep
both sensible. An environment's light is brighter than a flat ambient: retune
`ev_compensation` (or the map's `with_intensity`) against a capture after adding one.

Sun shadows are a row of the preset table, per device class, drawn as listed (the switch is `shadows`; `genex.toml`'s `[render.shadows]` sets `distance` and `blend_band` on every preset):

| preset | cascades x side | filter | depth, far cascades | reach | cascade blend, end fade |
| --- | --- | --- | --- | --- | --- |
| `low` | 2 x 1024 (phones: 2 x 768) | PCF 3x3 (phones: hardware 2x2) | 16-bit, every frame | 50 units | none, last 15 % |
| `medium` | 2 x 1536 | PCF 3x3 | 32-bit, every frame | 50 units | 10 %, last 10 % |
| `high` | 3 x 2048 | PCSS-lite (soft contact shadows) | 32-bit, every frame | 80 units | 10 %, last 10 % |
| `ultra` | 4 x 4096 | PCSS | 32-bit, every frame | 80 units | 10 %, last 10 % |

Neighbouring cascades blend across the band, so no seam shows where one ends, and the shadows fade
out before the shadow distance instead of stopping on a line. Shadows hold still while the camera
moves: the band lerps both cascades on every frame, PCSS finds the same blockers on every frame,
and the depth bias is one world-space distance per cascade, so a contact gap never changes size as
other objects come into view. At `high` and `ultra` under TAA an opaque surface's soft sun shadow
comes from a screen mask that averages PCSS over frames and filters it edge-aware, so a penumbra
holds still on a pan; transparent surfaces filter inline. Phones are held to 2 cascades of at
most 1536 px, no PCSS, 16-bit depth and 40 units, and the far cascade redraws every second frame
(and on every frame something in it moves, so a walking character's shadow never steps at half
rate); the weakest phone class draws 512 px cascades. The low desktop tier also draws 16-bit depth with the far cascade every second frame. A request never passes a class's caps, so one config is right
on every device. To ask for more at one preset, from code:
`RenderConfig::new().shadows_at(QualityPreset::High, ShadowConfig::new().cascades(4))`
(`genex::render::ShadowConfig`: `.cascades(1..=4)`, `.map_size(512..=4096)`,
`.filter(ShadowFilter::Pcf5x5)`, `.distance(10..=400)` world units, `.blend_band(0.0..=0.5)` of
each cascade; the other presets keep their rows, and a later call for the same preset wins key by
key). Per class, `RenderConfig::class(class, ClassOverride { shadows, ..Default::default() })`.


Size the reach to the world: a small arena wants `distance = 30` (sharper shadows near the camera,
since the cascades cover less ground), an open landscape the preset's or more. A cascade covers more
ground the farther it is, so a distant shadow is softer and less exact by design. The light size is
the sky's sun: by default the real sun (0.27 degrees), so a PCSS penumbra is narrow, contact
shadows soften a little and a long cast shadow a lot more. A softer, overcast look is
`frame.environment(Environment::Sky(SkyParams::default().with_sun_angular_radius_degrees(2.0)))`
(0 to 5 degrees; the drawn sun disk grows with it), and only the PCSS filters (`high`, `ultra`)
widen their penumbra with it, up to 1 world unit on every preset; the flat colour and an HDR map
keep the real sun's size.

## Rendering

One game runs on desktops, phones and browsers, so the renderer adapts at runtime and a game
states only what is its own. A **look** is the game's art direction
and is the same on every device. A **quality** belongs to the device: a preset (`auto`, `low`,
`medium`, `high`, `ultra`), one switch per feature, a render scale and a frame-rate target. The
renderer probes the adapter at boot into a device class (`desktop-ultra`, `desktop-high`,
`desktop-mid`, `desktop-low`, `mobile-high`, `mobile-mid`, `mobile-low`; a browser from its own
hints) and starts on the class's preset: `auto` is `ultra`, `high`, `medium` and `low` on the four
desktop classes, `medium` on `mobile-high` (scale 0.75), `low` on `mobile-mid` (0.67, 30 fps when
hot) and `mobile-low` (0.6, 30 fps); a browser stops at `high`. A dynamic-resolution controller
steps the render scale to hold the class's frame time. What does not fit the adapter or the
class's memory budget turns cheaper or off, is listed in `state().volatile.render.degraded` with a
typed reason (`budget`, naming the rung dropped; `format-unrenderable`, `pass-over-budget`,
`pipeline-change-deferred`, `transient-unsupported`, `not-landed`, `custom-pass-v1-in-world`,
`material-v1-in-hdr`) and never refuses the game. Desktop budgets grow with GPU memory (an eighth,
up to 2 GiB).

| preset | anti-aliasing | sun cascades | bloom | AO | contact shadows | lights (shadowed spots) |
| --- | --- | --- | --- | --- | --- | --- |
| `low` | MSAA 4x | 2 | off | off | off | 64 (0) |
| `medium` | MSAA 4x | 2 | on | half size | off | 256 (0) |
| `high` | TAA | 3 | on | half size, history | on | 1024 (2) |
| `ultra` | TAA, RCAS | 4 | on | full size | on | 1024 (4) |

Every preset draws HDR, image-based lighting, the sky and fog; below a render scale of 1 it
upscales (EASU with RCAS, bilinear on a desktop's `low`). Phones are capped whatever the preset:
256 lights, at most one shadowed spot, TAA only on `mobile-high` at `high` and up, and no AO or contact
shadows while the world pass is multisampled.

The look maps the linear HDR scene to the display. `tonemapper`: `khronos-neutral`
(default) keeps authored colours; `agx-punchy` is the filmic choice
for a bright, high-contrast scene (AgX's middle grey, more contrast and colour); plain `agx` is
muted; `aces` is a punchier film curve; `none` clamps.
`exposure`: `manual` (default) is fixed at `ev_compensation` EV (0 is 1.0, +1 doubles it); `auto`
meters the scene (`metering`: `average`, `center`, `spot`, sky-aware `ground`), holds it within `ev_min..=ev_max`,
adds the compensation and adapts at `adaptation_speed_up` (default 1) and `adaptation_speed_down`
(3) EV per simulated second. Use `auto` where light meets shade, with `ev_compensation = 0.5`
for a sunlit scene; keep `manual` for flat, stylized colour. Keep dusk dark with
`.exposure_curve(&[(-8.0, -6.0), (0.0, 0.0)])` (metered EV, EV added). The rest of
`[render.look]` is equal on every preset: `bloom_intensity` (default 0.04, threshold-free),
`bloom_threshold`, `bloom_radius` (the glow's spread); fog lit by the sky, off at `fog_density` 0, shaped by
`fog_height_falloff`, `fog_base_height`, `fog_start`, `fog_max_opacity`, `fog_color` and
`fog_aerial_perspective`; `ao_intensity`, `ao_radius`; `contact_shadow_length`. Keep `fog_color`
white and warm the whole frame in code with `.temperature(0.3, 0.0)` (a blue sky stays blue) or
`.white_balance([1.0, 0.85, 0.65])`. In code:
`RenderConfig::new().tonemap(Tonemap::KhronosNeutral).exposure(Exposure::auto().compensation(0.5)).grading(Grading::NEUTRAL.with_contrast(1.15))`
(`genex::render`; contrast turns about middle grey; `.with_lut(GradingLut::parse_cube(text)?.intern()?, 0.8)` adds a `.cube` LUT).

Each feature has a switch; off is its cheaper variant, never a refusal:

| switch | draws | off |
| --- | --- | --- |
| `hdr`, `tonemap`, `exposure` | the HDR scene, the look's curve, metering | the old LDR scene, fixed exposure |
| `ibl`, `sky` | environment lighting, the physical sky | flat `frame.ambient`, the clear colour |
| `shadows`, `contact-shadows`, `spot-shadows` | sun cascades, screen-space contact, spot maps | that shadow |
| `bloom`, `ao`, `fog` | the look's effects | none of it |
| `taa`, `upscaler` | TAA with RCAS; EASU below scale 1 | MSAA; bilinear |
| `clustered` | tile-binned point and spot lights | a per-pixel loop over the nearest 8 (4 on phones) |
| `prepass` | depth, normals, motion for AO, contact shadows, TAA and Level-2/3 inputs | those fall back |
| `meshlets`, `occlusion` | clustered big meshes, Hi-Z culling (off on every preset) | the instance path |
| `texture-quality` | texture size classes above 256 texels (read at load) | 256 texels |

On an M4 Max at 1080p (GPU p50) HDR with tonemap and exposure costs about 0.1 ms,
bloom 0.25-0.4, AO 0.45-0.6 (1.4 at `ultra`), contact shadows 0.15-0.3, TAA 0.2, EASU with RCAS under
0.3 and `ultra`'s sun shadows about 0.6.

Quality resolves in order, each layer overriding the one before it key by key: the class's preset
table, the game's `[render]`, the person's choice in the settings panel (saved per device in the
game's saves, never in the simulation), and the studio's `renderSettings` verb (this session only).

```toml
[render]                    # all optional; a game that names nothing gets the device's defaults
form_factors = ["desktop", "mobile"]
preset = "auto"             # auto | low | medium | high | ultra

[render.look]
tonemapper = "agx-punchy"
exposure = "auto"
ev_compensation = 0.5       # EV, within ±10

[render.shadows]            # every preset, held to each class's caps
distance = 60               # world units, 10..=400
blend_band = 0.1            # of each cascade, 0..=0.5

[render.class.mobile-mid]   # what this game wants on older phones
render_scale = 0.67         # 0.5..=1
fps = 30                    # 30 | 60
bloom = false               # any switch above
```

The build lane compiles `[render]` into every destination. In code,
`game.render_settings(RenderConfig::new().preset(QualityPreset::Medium))` (then `[render]` is not
read). Give the person the last word: call
`genex::render::settings_panel(ui)` from `on_ui` (an options menu); it shows the detected class, a
row of presets (none drawing less than the one below), the render scale and a
switch per feature (Tab, Space). A preset change rebuilds the renderer for its anti-aliasing (a short
hitch). A switch this build does not draw is reported off and listed `not-landed`.

TAA jitters the camera by a fraction of a pixel and blends with last frame through motion vectors
that match each draw (`frame.custom` ones too) to its last frame by id. Name everything that moves
on its own with `frame.id(key)` (a string or integer that stays with the object) until
`frame.end_id()` or the next id; unnamed draws match by order within their mesh, which suits still
scenery. Call
`frame.camera_cut()` on the frame a shot changes (respawn, cutscene, teleport), never every frame:
TAA, auto exposure and AO history start over. A camera that jumps on its own is a cut already.
Shaders under TAA: see Custom materials and post passes.

Extensions get every new input through versioned layouts. Write sources and passes at `api = 2`:
a v2 source reads the frame's `depth`, `normals`, `motion`, `environment` and `hdr-scene`
(`RenderInputs::DEPTH`, `NORMALS`, `MOTION`, `ENVIRONMENT`, `HDR_SCENE`) and the look's exposure;
v1 keeps working but holds the whole frame on the LDR scene. Level-3 passes register at
`PassStage::BeforeCull`, `AfterPrepass`, `AfterOpaque`, `AfterTransparent`, `PostHdr` (before the
tonemap) or `Post`. Bloom, fog, lights, shadows and the environment
reach a v2 material as they reach a built-in surface, so prefer the built-ins and the look to a
custom pass.

Captures are drawn on a pinned profile (a fixed reference class, the game's `[render]`, the verb's
layer, the nominal scale), ignore the person's saved choice and settle on their own history: TAA a
whole jitter cycle (8 frames, 16 on `ultra`) with AO weighing those frames alike, auto exposure at
once, a custom pass starting empty. Desktop-high and desktop-ultra captures assume that 2 GiB, so
1440p and 4K captures keep their preset. Each capture's `render` names its preset, class, settings
source and settle frames: one build on one adapter gives one picture, except that under TAA two
captures of one tick can differ by one level in a few pixels. `state().volatile.render` (class, preset, scale, `features`,
`degraded`, `gpuMs`, `cpuMs`) describes the last drawn frame, sits outside the checksum and is
never compared.

Rules for agents:

- Never hard-code `ultra`, a resolution or a render scale, and never read render settings in a
  simulation hook. Make content cheap at `low` and let presets add to it.
- Never switch `shadows`, `meshlets` or `occlusion` off to save frame time, nor ask for more
  cascades than a preset has outside `shadows_at`: presets and class caps already scale them.
- Test as a phone: `renderSettings` `{set: {deviceClass: "mobile-mid"}}`, `{set: {preset: "low"}}`,
  `{set: {features: {bloom: false}}}` or `{set: {renderScaleLock: 0.75}}` answer the settings in
  force (`features` as of the last drawn frame, so capture, then read), and a capture shows the
  game as that class draws it; `{set: {frameBudgetMs: 4}}` makes dynamic resolution hold 4 ms. Check `mobile-mid` and `low` before calling it done; the picture
  must read as the same game; `{set: {features: {hdr: false}}}` compares the look against the
  old LDR scene. `{set: {preset: null, features: null, deviceClass: null,
  renderScaleLock: null, frameBudgetMs: null}}` gives the game's own settings back.

## Big meshes (meshlets)

Big meshes can draw as meshlets (R2): a mesh of at least 2048 triangles is split once into
clusters of at most 124 triangles, the GPU culls each cluster on its own (outside the view, facing
away), and with occlusion a second pass against a depth pyramid of what was just drawn (two-pass
Hi-Z occlusion) drops the clusters hidden behind others. No preset turns them on, on any device,
because they measured slower: on an M4 Max at 1080p `high`, meshlets cost 26% to 51% more GPU time
than the instance path and occlusion 49% to 55% more, even in a walled scene where occlusion draws
a thirtieth of the vertices; on the phone proxy about twice the time. A tile GPU (phones, Apple
Silicon Macs) already rejects hidden pixels on chip, and no PC GPU has shown a gain yet. A game
opts in per class, only where its own measurement shows a gain (a huge world that hides most of
its geometry):

```toml
[render.class.desktop-high]
meshlets = true
occlusion = true    # runs only over a one-sample world pass: off under MSAA, so on with TAA
```

In code: `RenderConfig::new().class(class, ClassOverride { switches: vec![(RenderFeature::Meshlets,
true)], ..Default::default() })`. Occlusion builds its depth pyramid from one sample per pixel, so
under MSAA (`low` and `medium`) the switch resolves off and `volatile.render.features`
says so; the picture never changes, only the cost. The game's `Meshlets` setting then narrows what
runs: `.with_enabled(false)` opts out, `.with_occlusion(false)` drops occlusion,
`.with_min_triangles(4096)` clusters fewer meshes (at least 124); `genex::render::Meshlets`.
Nothing is clustered until a quality draws meshlets. A model imported through the Studio's asset
import already carries its clusters (meshoptimizer's, stored in the GLB); the renderer checks them
when it clusters, and a set that fails the check is logged with its typed fault
(`meshlets-unknown-version`, ...) and the mesh is clustered at runtime, so a hand-made GLB needs
nothing extra. The person's settings panel has the last word. If you opt in, model the world as a
few big meshes (terrain, walls, a building, a statue) rather than thousands of small ones, and
leave small props as instances. Every candidate is re-tested against the new depth each frame,
so a moving camera never shows a stale hole; a camera cut and a capture start with no visibility
history. A meshlet picture is not guaranteed bit-equal to the instance path's: where two draws tie in
depth they may resolve in another order.

## Retained instance groups

Many copies of one shape that rarely move (a forest, rocks, fence posts, a city's buildings)
draw as a retained group: made once, drawn every frame, its instance rows computed and uploaded
once instead of every frame (a 50,000-instance scatter drawn one by one writes 8 MB of rows a
frame; as a group, none after its first frame).

```rust
// on_reset: keep the group in the world.
let trees = (0..5000).map(|i| Transform::from_xyz((i % 100) as f32, 0.0, (i / 100) as f32)).collect();
sim.world.forest = Some(InstanceGroup::models(&pine, trees).expect("a group"));
// on_draw:
if let Some(forest) = &sim.world.forest { frame.group(forest); }
```

`InstanceGroup::cubes(transforms, &material)`, `InstanceGroup::spheres(transforms, &material)`
(radius 1: scale the transform), `InstanceGroup::models(&model, transforms)` (the GLB's materials)
and `InstanceGroup::models_with(&model, transforms, &material)` make one; `frame.group(&group)`
draws it, one logical draw, and the picture is the one drawing each transform with `frame.cube`,
`frame.sphere` or `frame.model` gives. `group.update(first, &transforms)` (in `on_update`)
replaces a range and only those rows are uploaded again. A group holds at most
`INSTANCE_GROUP_MAX` transforms (`too-many-instances`); an update past its end is refused
(`range-out-of-group`) and changes nothing. A missing model draws the checker at every transform.
Things that move every tick stay ordinary draws.

## Terrain

Ground that spans the world (hills, a valley, a beach) is a heightmap terrain: made once, drawn
every frame with `frame.terrain(&terrain)`, one logical draw. The renderer draws it finer near
the camera and coarser far away (continuous levels of detail that morph, so the ground never
pops or cracks), casts it into the sun's shadows, and shades it per pixel from up to
`TERRAIN_LAYER_MAX` (16) material layers.

```rust
// on_reset: heights every 0.5 m over 192 m, two layers, a control texel per height sample.
let terrain = Terrain::from_fn([385, 385], vec2(-96.0, -96.0), 0.5, |x, z| hills(x, z))
    .expect("heights")
    .with_layers(vec![
        TerrainLayer::textured("ground/grass-layer.png", "ground/grass-data.png", 2.0).with_fallback(Color::rgb(54, 79, 34)),
        TerrainLayer::flat(Color::rgb(138, 134, 126)),
    ])
    .expect("layers");
let texels: Vec<TerrainTexel> = samples.iter().map(|s| TerrainTexel::blend(0, 1, s.rockiness)).collect();
sim.world.ground = Some(terrain.with_control(&texels).expect("a control texel per sample"));
// on_draw:
if let Some(ground) = &sim.world.ground { frame.terrain(ground); }
```

`Terrain::from_fn(samples, origin, spacing, |x, z| height)` or `Terrain::from_heights(samples,
origin, spacing, &heights)` (row-major, x fastest) make one: at most `TERRAIN_SAMPLES_MAX` (2049)
samples a side. A layer is `TerrainLayer::textured(albedo, data, tile)` (two files under
`assets/`: the base colour with the layer's height in alpha, and a data texture with the normal's
x and y in red and green, roughness in blue and occlusion in alpha, one tile every `tile` metres,
`.with_tint(..)`, `.with_fallback(..)` for the colour it draws without its texture) or
`TerrainLayer::flat(color)`. `terrain.with_layers(..)` sets them; without a control map every
sample is layer 0. `TerrainTexel::layer(i)`, `TerrainTexel::blend(base, overlay, amount)` and
`.with_wetness(..)` make one control texel per height sample for `terrain.with_control(..)`; the
renderer blends the texels around each pixel by weight and by each layer's height, and hex-tiles
the layers on desktop `high` and `ultra` so no tile repeats visibly. `terrain.height(x, z)`
answers the ground's height anywhere (the same bits on every destination): place things and
build colliders with it. Refusals change nothing: `terrain-heights-invalid` (a side outside
2..=2049, a spacing that is not positive, a height that is not a number),
`terrain-layers-invalid` (no layer, more than 16, a tile that is not positive) and
`terrain-control-invalid` (a control map of another size, a texel naming a missing layer). A
frame draws one terrain.

## Custom materials and post passes

Level 2 of the extension ladder is a WGSL source: declare each WGSL source in `genex.toml` as a `[[wgsl]]` row (`path`,
`kind = "material"` or `"post"`, `api = 1`) and compile it in with
`game.wgsl("shaders/glow.wgsl", include_str!("../shaders/glow.wgsl"))`: web, phone and export builds
have no game folder to read it from. In `on_reset`, `gfx.material(path, &uniforms)` returns a
`CustomMaterial` you draw with `frame.custom(mesh, transform, &material, tint)` (`mesh` is a `Model`,
`CustomMesh::Cube` or `CustomMesh::Sphere`, radius 1; change its uniforms later with
`gfx.set_material_uniforms(&material, &uniforms)`), and `gfx.post_pass(path)`, or
`gfx.post_pass_with(path, &uniforms)` for a source with a uniform block, returns a `PostPass` you run
with `frame.post_pass(&pass)` after the world and before the HUD. Uniforms are `f32`s in WGSL's
layout (pad a vec3 to four). Each counts one draw, and shaders read the tick's simulated seconds,
never wall time. A refused source never crashes: its material draws the magenta checker, its pass
is skipped, and `state().volatile.extensions` names it with a typed code (`wgsl-undeclared`,
`wgsl-kind-mismatch`, `extension-api-unavailable`, `wgsl-too-large`, `native-feature-missing`).
Custom materials cast no shadow yet (the shadow pass draws only the plain draws), so a
character or prop drawn only with `frame.custom` stands without one. Write new sources at
`api = 2`: a v2 material's `fs_material(in: GxMaterialInV2)` builds a surface with
`gx_surface_v2(..)` and returns `vec4(gx_shade_pbr(surface) + gx_expose(glow), 1.0)`, so the
renderer's sun, shadows (the preset's filter, cascade blend and end fade, the sun's contact
shadows), lights, environment (`frame.environment`), ambient occlusion (with its bent normal),
the aerial perspective and fog reach it as they reach a built-in surface, on the HDR and the LDR
scene alike (`gx_expose` holds even a blinding emissive
under the scene's limit). `gx_surface_v2` takes no derivatives, so it does not filter a shiny
highlight against sparkle; wrap it as built-in surfaces are, in uniform control flow:
`let n = normalize(in.normal); let s = gx_filter_specular_v2(gx_surface_v2(in.world_position, n,
albedo, 0.0, 0.2), dpdx(n), dpdy(n));` `gx_draw.prev_model` is the draw's model last frame
(matched by its id) and `gx_draw.params.z` last frame's simulated seconds (`params.x` this
frame's), so a vertex animation can place itself at both times. The draws of one v2 material
and one mesh are one instanced call, and `gx_draw` is still the drawing instance's own row (group
1 holds the frame's read-only `gx_draws` table). A v2 post pass reads `gx_scene` and `gx_frame` (and `gx_env_sh`, the
environment's SH9) on the display-ready frame after the tonemap, and `gx_depth`, `gx_normals` and
`gx_motion` (the prepass's motion vectors, written whenever a source declares them; the
formula is under Custom GPU passes) (an effect on the HDR scene before it is a Level-3 `PostHdr` pass; Level-3 passes do not read the sun's shadow maps yet, so grass or water drawn by a pass is not shadowed), and
textures from `gfx.texture(path)` bind through `gfx.material_textured(path, &uniforms,
&[&texture])` (a missing texture binds a white 1x1 texel, never the checker; game textures carry
their mips, and the linear sampler filters anisotropically). A v1 material keeps working
but its frame stays on the legacy LDR scene (`material-v1-in-hdr` in `degraded`). Where this build does not serve a source's `api` yet it is refused
`extension-api-unavailable`: write it at `api = 1` there.

The look's fog reaches a v2 material and particles as it reaches a built-in surface (`gx_shade_pbr`
applies it; call `gx_apply_fog` on linear radiance only for a surface shaded its own way), and
under the physical sky the air's aerial perspective with it (`fog_aerial_perspective = false`
turns that off).

Shaders under TAA: a v2 material and a v2 pass in the world draw through `gx_frame.view_proj`,
which carries the jitter, so they line up with the scene; `inv_view_proj` is its inverse (the depth
they read was drawn jittered), `prev_jitter` last frame's jitter, and their motion uses
`unjittered_view_proj` and `prev_view_proj`. Post stages (`PostHdr`, `Post`, v2 post passes) read
TAA's resolved scene, which has no jitter, beside the jittered depth, normals and motion: project
markers and outlines with `unjittered_view_proj` and read the depth at that uv plus
`gx_frame.jitter * vec2(0.5, -0.5)` (`gx_post.jitter` in a post pass). Under TAA (`gx_frame.jitter`
is never zero then) key stochastic per-pixel noise (a dither, a jittered ray start, a slice offset)
to `frame_index` so the history averages it: noise that never moves stays as grain, and RCAS
sharpens it. The world pass draws one sample per pixel under TAA (MSAA is off, on every
destination). A budget refit that asks for other anti-aliasing draws the closest one the world
pass has and is listed `pipeline-change-deferred`, as a Studio run's preset change is while its
pipelines compile off the frame thread (Live keeps the last preset until then). TAA's knobs are the preset's; a game may tune
them per class from code only: `RenderConfig::new().class(class, ClassOverride { taa:
Some(TaaQuality::DEFAULT.with_jitter_cycle(JitterCycle::Sixteen)), ..Default::default() })`
(`.with_alpha_min(..)` for a steadier history, `.with_lod_bias(..)` for sharper textures).

## Custom GPU passes

`game.gpu_pass(name, stage, pass)` registers raw wgpu work into the frame (extension ladder level
3). `pass` implements `genex::gpu::GpuPass<World>`: `rebuild(&mut self, setup)` creates its
shaders, buffers, textures and pipelines through `PassSetup`, at install and again after the GPU
device is lost or the pipeline facts change; `run(&mut self, ctx)` records one frame through
`GpuPassCtx`, which reads `ctx.sim()` and `ctx.tick()` and never writes the simulation. Stages:
`PassStage::BeforeCull` (compute on `ctx.encoder()`), `AfterOpaque` and `AfterTransparent` (draws
inside the world pass on `ctx.draws()`, with `setup.world_depth(..)` and
`setup.world_multisample()`), `AfterPrepass` (after the depth/normal prepass and before the
world pass, on `ctx.encoder()`: work that reads the scene's depth and normals, `ctx.prepass_depth()`
and `ctx.prepass_normals()`), `PostHdr` (the scene before the tonemap, `ctx.world_texture()` at
render size) and `Post` (the finished frame, `ctx.world_texture()`, before the HUD).

Write passes at custom-pass API v2: `fn api(&self) -> u32 { 2 }` and `api = 2` on the source's
`[[wgsl]]` row. Bind the v2 tables with `setup.tables_layout()`; WGSL sees `GxFrameV2` (the
matrices, `sun_dir`, `sun_color`, `ambient`, `render_size`, `pre_exposure`, `depth_reversed`,
`scene_ldr`, `frame_index`), `GxInstance` and `GxMaterial`, and the inputs the pass declares
with `fn inputs(&self) -> RenderInputs` (`RenderInputs::DEPTH`, ...). Inputs drive producers: a
pass declaring `DEPTH` or `NORMALS`, a pass at `AfterPrepass`, or a Level-2 v2 source binding
`gx_depth` or `gx_normals` makes the renderer draw its depth/normal prepass that frame on every
preset and device, and `AfterPrepass`, `PostHdr`, `Post` and the v2 post passes read the frame's
real depth (`gx_depth`, in the frame's depth convention) and octahedral normals (`gx_normals`,
`gx_oct_decode`); the in-world stages read neutral ones. A pass declaring `MOTION` reads the
prepass's motion vectors at the same stages, as `gx_motion` and `ctx.prepass_motion()` (the
declaration alone makes the prepass write them, with or without TAA): `rg16float` NDC motion,
current minus previous with the jitter removed, so the pixel at `uv` was at
`uv - motion * vec2(0.5, -0.5)` last frame (where no geometry drew, the sky included, the motion is
the camera's own). Under TAA an in-world pass hands TAA what it moves itself:
`ctx.motion_draws()` draws its motion (a vertex animation evaluated at `ctx.tick()` and
`ctx.prev_tick()`, for example with the shared `gx_wind`; pipelines use `setup.motion_target()`,
`setup.temporal_depth(true)` and `setup.temporal_multisample()`), and `ctx.reactive_draws()` the
coverage of blended work moving over the scene (a glow sprite: `setup.reactive_target()`,
`setup.temporal_depth(false)`), so neither trails; without them its pixels keep the motion of what
is behind them. In the world and at `PostHdr` a v2 pass draws in the scene format
(`setup.world_format()`): write linear radiance times `pre_exposure` on the HDR scene, and
sRGB-encoded colour when `scene_ldr` is 1; under `depth_reversed` the far plane is depth 0 and
`setup.world_depth(..)` already compares `Greater`. A v2 pass that lights with the environment
declares `RenderInputs::ENVIRONMENT`, binds `setup.environment_layout()` in a group of its own and
`ctx.environment()` in it each frame (both `Some` at API v2): `@binding(0) var gx_env_specular: texture_cube<f32>` (the
prefiltered specular cube, one roughness per mip, spaced perceptually: read perceptual roughness `r`
at level `(textureNumLevels(..) - 1) * r * (2 - r)`), `@binding(1) var<uniform> gx_env_sh: GxEnvSh`
(SH9 irradiance), `@binding(2) var gx_brdf_lut: texture_2d<f32>` (the split-sum LUT) and
`@binding(3) var gx_env_sampler: sampler`; the v2 tables also carry `gx_env_specular` and
`gx_env_sh` (bindings 6 and 7). They are the frame's own environment: the first bake lands the
frame it is set; a later change (a new environment, a sun that moved, a new cube size) is rebaked
over 13 steps behind the bound one and swapped in whole when done, while the frame keeps the
previous bake; captures always bake whole. With the flat colour they hold no light. Bloom and fog are the look's
(Rendering); a grade of your own, or an effect they cannot express, belongs at `PostHdr`,
where the look's tonemapper still follows. Auto exposure meters the scene after `PostHdr`, so add
nothing there in absolute amounts (a shadow lift, a flare): scale such constants by
`gx_frame.pre_exposure` and the metering stays exact; a capture of a game with a `PostHdr` pass
re-meters once more (three re-renders instead of two) for constants that are not scaled. A v1 pass (no `api`) at `AfterOpaque` or
`AfterTransparent` expects the sRGB world target, so it keeps the whole frame on the legacy LDR
scene: nothing is refused, and `state().volatile.render.degraded` says `custom-pass-v1-in-world`.
A v1 `Post` pass is unaffected. The look's fog and the frame's point and spot lights do not
reach geometry a pass draws yet (grass, water), but the sun's shadows do: the v2 tables always
bind its cascades, `@binding(9) var gx_shadow_map: texture_depth_2d_array` and `@binding(10) var
gx_shadow_sampler: sampler_comparison` (in the cascade `c` whose `gx_frame.cascade_ends[c]` holds the
point's view depth, compare the depth of the point lifted by `cascade_offsets[c]` along its normal
in `cascade_view_proj[c]` less `shadow_params.x`, the comparison bias every cascade shares;
`cascade_splits.w` is 0 on a frame without sun
shadows; the showcase's grass does this). The tables carry the fog row
(`gx_frame.fog_color`, `gx_frame.fog_params`) and the environment cube (`gx_env_specular`) but no
fog function, so such a pass repeats the height fog with the cube read just above the horizon as
its in-scatter (the showcase's `look_fog`; the air's aerial perspective does not reach it) and
lights a ground lantern with a soft additive disc of its own. Every resource counts against the GPU caps, WGSL is checked against WebGPU core
plus `[gpu] native_features`, no buffer is mappable, and a pass wgpu rejects stops running with
`gpu-pass-invalid` (listed with its code in `state().volatile.customPasses`). In-world draws are
checked as they are recorded (slices, usages, offsets, index and indirect ranges); on the web, where
wgpu answers a frame later, a frame whose in-world draws reach further than one already accepted
(more vertices or instances, a smaller vertex slice, another pipeline) leaves that pass out until
its own answer comes. Each pass counts one
draw under the `custom` tag; native captures and Live show its output, and the web build runs
them in the browser's WebGPU too (`PostHdr` included), so a web capture shows them.

## Determinism

A simulation replays bit for bit from its seed on every destination, or two builds cannot be
compared. The studio's build lints every game with a file of refused paths, and a refused path is
a build failure, not a warning.

- Use `genex::math` (`sin`, `cos`, `atan2`, `exp`, `pow`, `sqrt`, ...) for transcendental math:
  it is libm on every target. The lane refuses std's `f32::sin`, `f32::powf`, `f32::powi` and
  the other transcendental methods of `f32`. `sqrt`, `abs`, `floor` and `mul_add` stay allowed.
- Use `genex::Map` and `genex::Set` (insertion-ordered, fixed hasher) instead of `HashMap` and
  `HashSet`, which the lane refuses.
- Never read a clock: `Instant` and `SystemTime` are refused. Time comes from `ctx.tick` and
  `ctx.dt`.
- Never spawn a `thread` (`std::thread::spawn`): threads reorder the simulation's work.
- Randomness comes only from `ctx.rng` or the reset `rng`. The lane refuses `rand`'s
  `thread_rng`, `rng` and `random`, `getrandom`, and the global `fastrand` functions and
  `fastrand::Rng::new`; a `fastrand::Rng` is fine when built `with_seed` from `ctx.rng`.
- Animation that exists only on screen derives from simulation state, never from a clock.

## Facets

A facet is `src/facets/<slug>.rs` with `pub fn wire(game: &mut Game<World>)`. It keeps its own
state in a type registered with `game.facet_state::<T>()` and read with
`sim.facets.get::<T>()` / `get_mut::<T>()`. The entry file wires facets in one block:

```rust
// ── FACET WIRING ── two lines per facet, nothing else
#[path = "facets/fishing.rs"] mod fishing;
#[path = "facets/shop.rs"] mod shop;
fishing::wire(&mut game);
shop::wire(&mut game);
// ── END FACET WIRING ──
```

Both lines of each facet live inside the block in `main`, so workers that add facets in
parallel merge by keeping every line. Facets reach the entry file's types as `super::World`.

## genex.toml

```toml
[game]
title = "Pond"            # required
world_size = [960, 540]   # optional, each side 64..=4096
save_name = "pond"        # optional: letters, digits, space, _ - .

[crates]                  # optional: the reviewed allowlist (noise, fastrand), or a crate the
noise = "0.9"             # person approved through request_crate, pinned exactly: tidy = "=1.0.0"

[[crate_request]]         # optional: asks the person for a crate, as request_crate does
name = "tidy"
version = "1.0.0"         # one exact release
reason = "tidy layouts"   # optional, one sentence for the person

[[wgsl]]                  # optional WGSL sources: a custom pass reads one with include_str!, Level 2
path = "shaders/water.wgsl"   # loads material and post sources through Gfx (see Custom materials and post passes)
kind = "pass"             # pass | material | post
api = 1                   # optional: the extension API it is written against (default 1)

[gpu]                     # optional native-enhanced features; a game that names any has no web build
native_features = ["subgroup"]

[web]                     # optional: the browser build's code budget, in MB of gzip
wasm_budget_mb = 8        # 1..=32, default 4
```

Unknown keys are refused. A `[[crate_request]]` row is a request, never an approval: keep it
(Studio files it for the person, who decides), and do not move the crate into `[crates]` yourself.
Native features: `shader-int64-atomic-min-max`,
`shader-int64-atomic-all-ops`, `subgroup`, `ray-query`, `mesh-shader`,
`texture-binding-array`, `multi-draw-indirect-count`. Every destination guarantees WebGPU
core (compute shaders, storage buffers, indirect draws) without declaring anything. The device
is opened with exactly the declared features, and one without them ends the run
`native-feature-missing`.

A `[[wgsl]]` source is staged with the game, size-checked and validated by naga. A `pass` source
is read by a custom GPU pass with `include_str!("../shaders/water.wgsl")` and built through
`PassSetup`; a `material` or `post` source is loaded by name through `Gfx` (see Custom materials and post passes). A
`[render]` table sets the look and the per-device quality (see Rendering).

A web export is built for size. Past its budget (`[web] wasm_budget_mb`, default 4 MB of gzip) it
still exports, with a warning that it loads slower on phones and weak devices; raise the budget
only when the brief targets strong desktops. Past 32 MB it is refused `wasm-over-budget`, and a
budget outside 1..=32 is refused `invalid-web-budget`. Live builds have no budget.

## Extension ladder

A game reaches past the facade one level at a time: hooks (level 0), its own safe Rust modules
(1), WGSL sources (2), custom GPU passes through `genex::gpu` (3), crates the person approved
through `request_crate` (4), and an ejected engine (5). Agents start at the lowest level that
works. At level 4 Genex still refuses an approved crate when a known security advisory, a licence
it does not allow or a banned crate is in it or in a crate it brings in, and a crate with a build
script or a proc macro needs the person's separate approval of that kind. Every level keeps the conformance suite's guarantees (every verb answers, a seed replays
to the same state and capture digest, Stop ends the game and its children), and none loosens the
sandbox the build and the game run in.

An eject is the person's act in Studio, never an agent's. It copies the genex crates of the
game's toolchain lock into `engine/<crate>` with their digests in `engine/genex-engine.json`, and
the studio writes the `[engine]` row of `genex.toml`:

```toml
[engine]                  # written by the studio on an eject; never edited by the game
ejected_from = "0.1.0"    # the genex release copied into engine/
```

The build then links the copy instead of the studio's engine, under the same policy: offline,
locked, clippy, no `unsafe` and no build scripts. The studio writes each copied crate's
`Cargo.toml`, so the engine's own build scripts and proc macros never build; `genex-studio`,
`genex-frames`, `genex-gpu-memory` and the phone shells stay the studio's. An ejected game gets
no engine updates, and its Live, capture and export wait for a passing conformance run (`check_conformance`) on
each new build: `conformance-required` until then. The person's per-game trust flag lets
`unsafe` and build scripts in the game's own crates build (`unsafe-code` and
`build-script-refused` without it); the sandbox is the same either way.
