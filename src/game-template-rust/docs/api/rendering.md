# Rendering

One game runs on desktops, phones and browsers, so the renderer adapts and a game
states only what is its own. A **look** is the game's art direction
and is the same on every device. A **quality** belongs to the device: a preset (`auto`, `low`,
`medium`, `high`, `ultra`), one switch per feature, a render scale and a frame-rate target. The
renderer probes the adapter at boot into a device class (`desktop-ultra`, `desktop-high`,
`desktop-mid`, `desktop-low`, `mobile-high`, `mobile-mid`, `mobile-low`; a browser from its own
hints) and starts on the class's preset: `auto` is `ultra`, `high`, `medium` and `low` on the four
desktop classes, `medium` on `mobile-high` (scale 0.75), `low` on `mobile-mid` (0.67, 30 fps when
hot) and `mobile-low` (0.6, 30 fps); a browser stops at `high`. Dynamic resolution
steps the render scale to hold the class's frame time. What does not fit the adapter or the
class's memory budget turns cheaper or off, is listed in `state().volatile.render.degraded` with a
typed reason (`budget`, naming the rung or switch dropped; `format-unrenderable`, `pass-over-budget`,
`pipeline-change-deferred`, `transient-unsupported`, `not-landed`, `custom-pass-v1-in-world`,
`material-v1-in-hdr`) and never refuses the game. Desktop budgets grow with GPU memory (an eighth,
up to 2 GiB).

| preset | anti-aliasing | sun cascades | bloom | AO | contact shadows | lights (shadowed spots) |
| --- | --- | --- | --- | --- | --- | --- |
| `low` | MSAA 4x | 2 | off | off | off | 64 (0) |
| `medium` | MSAA 4x | 2 | on | half size | off | 256 (0) |
| `high` | TAA | 3 | on | half size, history | on | 1024 (2) |
| `ultra` | TAA | 4 | on | full size | on | 1024 (4) |

Every preset draws HDR, image-based lighting, the sky and fog; below a render scale of 1 it
upscales (TAA at output size on `high` and `ultra` without lens effects or `post-hdr` passes,
else EASU with RCAS; bilinear on a desktop's `low`). Phones are capped whatever the preset:
256 lights, at most one shadowed spot, TAA only on `mobile-high` at `high` and up, and no AO or contact
shadows while the world pass is multisampled.

The look maps the linear HDR scene to the display. `tonemapper`: `khronos-neutral`
(default) keeps authored colours; `agx-punchy` is filmic, for a bright,
high-contrast scene; plain `agx` is
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
`fog_aerial_perspective`; `ao_intensity`, `ao_radius`; `contact_shadow_length`. In code:
`RenderConfig::new().tonemap(Tonemap::KhronosNeutral).exposure(Exposure::auto().compensation(0.5))`
(`genex::render`). The grade, white balance and lens are code only: see Grading and the lens.

Each feature has a switch; off is its cheaper variant, never a refusal:

| switch | draws | off |
| --- | --- | --- |
| `hdr`, `tonemap`, `exposure` | the HDR scene, the look's curve, metering | the old LDR scene, fixed exposure |
| `ibl`, `sky` | environment lighting, the physical sky | flat `frame.ambient`, the clear colour |
| `shadows`, `contact-shadows`, `spot-shadows` | sun cascades, screen-space contact, spot maps | that shadow |
| `bloom`, `ao`, `fog` | the look's effects | none of it |
| `taa`, `upscaler` | TAA; below scale 1 TAA at output size or EASU with RCAS | MSAA; bilinear |
| `clustered` | tile-binned point and spot lights | a per-pixel loop over the nearest 8 (4 on phones) |
| `prepass` | depth, normals, motion for AO, contact shadows, TAA and Level-2/3 inputs | those fall back |
| `meshlets`, `occlusion` | clustered big meshes, Hi-Z culling (off on every preset) | the instance path |
| `texture-quality` | texture size classes above 256 texels (read at load) | 256 texels |
| `lod-fade`, `impostors` | level crossfades, impostors past the last level | hard switches, the last level |

Quality resolves in order, each layer overriding the one before it key by key: the class's preset
table, the game's `[render]`, the person's choice in the settings panel (saved per device in the
game's saves, never in the simulation), and the studio's `renderSettings` verb (this session only).

```toml
[render]                    # all optional: the device's defaults
form_factors = ["desktop", "mobile"]
preset = "auto"             # auto | low | medium | high | ultra

[render.look]
tonemapper = "agx-punchy"
exposure = "auto"
ev_compensation = 0.5       # EV, within ±10

[render.shadows]            # every preset, held to each class's caps
distance = 60               # world units, 10..=400
blend_band = 0.1            # of each cascade, 0..=0.5

[render.loading]            # see Loading screen

[render.class.mobile-mid]   # what this game wants on older phones
render_scale = 0.67         # 0.5..=1
fps = 30                    # 30 | 60
bloom = false               # any switch above
lod_threshold_px = 3.0      # with lod_fade_band, far_density: see Drawing
```

The build lane compiles `[render]` into every destination. In code,
`game.render_settings(RenderConfig::new().preset(QualityPreset::Medium))` replaces `[render]`;
`RenderConfig::from_build()` starts from it instead. Give the person the last word: call
`genex::render::settings_panel(ui)` from `on_ui` (an options menu); it shows the detected class, a
row of presets (none drawing less than the one below), the render scale, a Detail distance slider and a switch per feature (Tab, Space). A preset change rebuilds the renderer for its anti-aliasing (a short
hitch). A switch this build does not draw is reported off and listed `not-landed`.

TAA jitters the camera by a fraction of a pixel and blends with last frame through motion vectors
that match each draw (`frame.custom` ones too) to its last frame by id. Name everything that moves
on its own with `frame.id(key)` (a string or integer that stays with the object) until
`frame.end_id()` or the next id; unnamed draws match by order within their mesh, which suits still
scenery. Call
`frame.camera_cut()` on the frame a shot changes (respawn, cutscene, teleport), never every frame:
TAA, auto exposure and AO history start over (auto exposure snaps on the first frame that shows
anything lit). A camera that jumps on its own is a cut already.
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
