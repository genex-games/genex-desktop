# Rendering

Every type and call in one line:

```rust
use genex::render::{ClassOverride, DeviceClass, Exposure, FormFactor, LodConfig, Metering, PerformanceTier};
use genex::render::{QualityPreset, RenderConfig, ResolutionPreset, Tonemap, UpscaleMode, lock_upscale, settings_panel};
game.render_settings(RenderConfig::new().preset(QualityPreset::Medium)); // or RenderConfig::from_build()
config.tonemap(Tonemap::AgxPunchy).exposure(Exposure::auto().compensation(0.5).metering(Metering::Ground));
config.upscale(UpscaleMode::Quality); config.upscale_locked(UpscaleMode::Native);
let class = DeviceClass::new(FormFactor::Mobile, PerformanceTier::Mid);
config.class(class, ClassOverride { render_scale: Some(0.67), ..Default::default() });
config.lod_at(class, LodConfig::new().threshold_px(3.0));
settings_panel(ui); lock_upscale(Some(UpscaleMode::Native));
frame.id("hero"); frame.end_id(); frame.camera_cut();
```

The renderer adapts to each desktop, phone and browser; a game states only what is its own. A **look** is the game's art direction, the same on every device. A **quality** belongs to the device: a preset (`auto`, `low`,
`medium`, `high`, `ultra`), one switch per feature, an upscaling mode, a render scale and a
frame-rate target. The renderer probes the adapter at boot into a device class (`desktop-ultra`, `desktop-high`,
`desktop-mid`, `desktop-low`, `mobile-high`, `mobile-mid`, `mobile-low`; a browser from its own
hints) and starts on the class's preset: `auto` is `ultra`, `high`, `medium` and `low` on the four
desktop classes, `medium` on `mobile-high` (scale 0.75), `low` on `mobile-mid` (0.67, 30 fps when
hot) and `mobile-low` (0.6, 30 fps); a browser stops at `high`. What does not fit the adapter or the
class's memory budget turns cheaper or off, is listed in `state().volatile.render.degraded` with a
typed reason (`budget`, naming the rung or switch dropped; `format-unrenderable`, `pass-over-budget`,
`pipeline-change-deferred`, `transient-unsupported`, `not-landed`, `custom-pass-v1-in-world`,
`material-v1-in-hdr`) and never refuses the game.

| preset | anti-aliasing | sun cascades | bloom | AO | contact shadows | lights (shadowed spots) |
| --- | --- | --- | --- | --- | --- | --- |
| `low` | MSAA 4x | 2 | off | off | off | 64 (0) |
| `medium` | MSAA 4x | 2 | on | half size | off | 256 (0) |
| `high` | TAA | 3 | on | half size, history, GI | on | 1024 (4) |
| `ultra` | TAA | 4 | on | full size, GI | on | 1024 (4) |

Every preset draws HDR, image-based lighting, the sky and fog; below scale 1 it upscales (TAA at
output size on `high` and `ultra` without lens effects or `post-hdr` passes, else EASU with RCAS;
bilinear on desktop `low`). An `UpscaleMode` renders a share of
the window a side, `Native` (all of it, through TAA), `Quality` (0.69), `Balanced` (0.59) or
`Performance` (0.5). A native desktop starts on what its class and window afford (Quality below
4K on `desktop-high`), never Native; phones and browsers keep their class's scale. Dynamic
resolution moves below the mode to hold the frame-rate target (30 or 60: frames draw once per
60 Hz tick), or holds the mode when off; the render scale is a share of the mode. AO halves past
1080p rendered. Phones are capped whatever the preset:
256 lights, at most one shadowed spot, TAA only on `mobile-high` at `high` and up, and no AO or contact
shadows while the world pass is multisampled.

Sides, texture classes, budgets: `docs/api/resolution.md`.

The look's `tonemapper`: `khronos-neutral` (default) keeps
authored colours; `agx-punchy` is filmic, for bright, high-contrast scenes; `agx` is muted;
`aces` punchier; `none` clamps.
`exposure`: `manual` (default) is fixed at `ev_compensation` EV (0 is 1.0, +1 doubles it); `auto`
meters the scene (`metering`: `average`, `center`, `spot`, sky-aware `ground`), holds it within `ev_min..=ev_max` (-8..8),
adds the compensation and adapts at `adaptation_speed_up` (default 4) and `adaptation_speed_down`
(3) EV per simulated second (`doorway_adaptation`: Lighting): `auto` where light meets shade,
`manual` for flat colour (`docs/look-recipes.md` calibrates). The rest of
`[render.look]` is equal on every preset: `bloom_intensity` (default 0.04, threshold-free),
`bloom_threshold`, `bloom_radius` (its spread); fog lit by the sky, off at `fog_density` 0, shaped by
`fog_height_falloff`, `fog_base_height`, `fog_start`, `fog_max_opacity`, `fog_color` and
`fog_aerial_perspective`; `ao_intensity`, `ao_radius`; `contact_shadow_length`;
`local_exposure_highlights`, `local_exposure_shadows` (Lighting). The grade, white balance,
exposure curve and lens are code only: see Grading and the lens.

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

Quality resolves in layers, each overriding the last key by key: the class's preset table, the
game's `[render]`, the person's panel choice (saved per device, never in the simulation), the
studio's `renderSettings` verb (this session).

```toml
[render]                    # all optional: the device's defaults
form_factors = ["desktop", "mobile"]
preset = "auto"             # auto | low | medium | high | ultra

[render.look]
tonemapper = "agx-punchy"
exposure = "auto"
ev_compensation = 0.5       # EV, within ±10

[render.shadows]            # held to each class's caps
distance = 60               # world units, 10..=400
blend_band = 0.1            # of each cascade, 0..=0.5

[render.loading]            # see Loading screen

[render.class.mobile-mid]   # older phones
render_scale = 0.67         # 0.5..=1
fps = 30                    # 30 | 60
bloom = false               # any switch
lod_threshold_px = 3.0      # with lod_fade_band, far_density (docs/api/drawing.md)
```

The build lane compiles `[render]` into every destination; `game.render_settings(..)` replaces
it, and `RenderConfig::from_build()` starts from it. Give the person the last word:
`genex::settings::menu(ui)` holds `settings_panel(ui)`; it shows the detected class, presets (none
drawing less than the one below; Max is `ultra` at Native), Upscaling, Frame rate, Dynamic
resolution, the render scale, Detail distance and feature switches. A preset change
rebuilds the renderer; a mode change only resizes the next frame. A switch this
build does not draw reads off, listed `not-landed`. A game may start devices on a mode (`.upscale(..)`),
hold one (`.upscale_locked(..)`: the panel hides Upscaling), or hold Native in a photo mode
(`genex::render::lock_upscale(Some(UpscaleMode::Native))` from `on_ui`, `None` after).

TAA blends with last frame through motion vectors that match each draw
(`frame.custom` ones too) by id. Name everything that moves
on its own with `frame.id(key)` (a stable string or integer) until
`frame.end_id()` or the next id; unnamed draws match by order within their mesh. Call
`frame.camera_cut()` on the frame a shot changes (respawn, cutscene, teleport), never every frame:
TAA, auto exposure and AO history start over. A camera that jumps alone is a cut already.
Shaders under TAA: see Custom materials and post passes.

Write sources and passes at `api = 2`:
a v2 source reads the frame's `depth`, `normals`, `motion`, `environment` and `hdr-scene`
(`RenderInputs::DEPTH`, `NORMALS`, `MOTION`, `ENVIRONMENT`, `HDR_SCENE`) and the look's exposure;
v1 keeps working but holds the whole frame on the LDR scene. Level-3 passes register at
`PassStage::BeforeCull`, `AfterPrepass`, `AfterOpaque`, `AfterTransparent`, `PostHdr` (before the
tonemap) or `Post`. A v2 material is lit, fogged and shadowed like a built-in; prefer the
built-ins and the look to a custom pass.

Captures are drawn on a pinned profile (a fixed reference class, the game's `[render]`, the verb's
layer, the nominal scale, no upscaling mode), ignore the person's saved choice and settle on their
own history: TAA a whole jitter cycle (8 frames, 16 on `ultra`), auto exposure at once, a custom
pass starting empty; 1440p and 4K captures keep their preset. Each capture's `render` names its preset, class, settings
source and settle frames: one build on one adapter gives one picture (under TAA, within one level
in a few pixels). `state().volatile.render` (class, preset, scale, `features`,
`degraded`, `gpuMs`, `cpuMs`) describes the last drawn frame, outside the checksum, never compared.

Rules for agents:

- Never hard-code `ultra`, a resolution, a render scale or an upscaling mode (only a photo mode
  or a resolution tier holds Native); never read render settings in simulation. Author
  for desktop `ultra`; check `low` and phones.
- Never switch `shadows`, `meshlets` or `occlusion` off to save frame time, nor ask for more
  cascades than a preset has outside `shadows_at`: presets and class caps scale them.
- Test as a phone: `renderSettings` `{set: {deviceClass: "mobile-mid"}}`, `{set: {preset: "low"}}`,
  `{set: {features: {bloom: false}}}` or `{set: {renderScaleLock: 0.75}}` answer the settings in
  force (`features` as of the last drawn frame: capture, then read); a capture shows the game as
  that class draws it; `{set: {frameBudgetMs: 4}}` makes dynamic resolution hold 4 ms.
  Check `mobile-mid` and `low` before done: the picture must read as the same game;
  `{set: {features: {hdr: false}}}` compares the look with the old LDR scene. `{set: {preset: null, features: null, deviceClass: null,
  renderScaleLock: null, frameBudgetMs: null}}` gives the game's own settings back.
