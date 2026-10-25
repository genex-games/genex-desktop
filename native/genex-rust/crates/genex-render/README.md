# genex-render

The wgpu renderer behind the `genex` facade, on WebGPU core: every feature runs on the six
destinations (macOS, Windows, Linux, iOS, Android, the web) without optional features, and
degrades to a cheaper variant or off instead of refusing a game. These notes are the renderer's
architecture; they live in the crate so an ejected game keeps them. The game-facing API is
`docs/GENEX_API.md` in the workspace (and in the game template).

## Rules

- GPU-facing structs (`src/layout.rs`, `src/abi.rs`) are `#[repr(C)]` arrays of `f32`/`u32` with
  hand padding, never glam types. `tests/layout.rs` holds each size to a golden table and to the
  size naga computes for the WGSL struct of the same name (`shaders/common.wgsl`).
- Every shader validates against WebGPU core with naga and emits HLSL SM 5.1, MSL 2.4 and SPIR-V
  1.3 (`tests/layout.rs`). Compute storage textures are `rgba16float` or `rgba8unorm`
  (write-only) and `r32float` (read-write); at most 4 per stage, at most 16 KB of workgroup memory.
- Every depth-writing vertex shader computes its position with `gx_clip_position`
  (`shaders/clip_position.wgsl`) and declares it `@invariant`.
- A renderer pass's WGSL constant is wrapped in `shipped_wgsl!` (`src/shaders/minify.rs`): a web
  build embeds it without comments, indentation or blank lines (made at compile time; the same
  module, which `shaders::minify`'s rows hold to by MSL). Native builds keep the files' own lines.
  The extension preludes (and anything a game's WGSL is joined to) stay as written, because a
  game's shader diagnostics count their lines.
- The Sim never reads the GPU: captures are a pure function of (state, camera, pinned settings,
  adapter, build). Temporal effects key their sequences to the renderer frame index and reset on
  camera cuts, resizes, settled captures and device re-creation.

## Settings

`src/settings.rs`: the game's `Look` (tonemapper, exposure, bloom, AO, fog, contact shadows),
`Environment` (flat colour, physical sky, HDR map) and `Meshlets` are equal on every device; the
`Quality` a preset or a device class picks switches and sizes features. `RenderSettings::off()`
is the renderer before the follow-up, exactly; existing goldens are drawn with it.

## Frame graph

`src/graph.rs` holds a fixed, ordered node table: no scheduler, no dependency solver. A node
runs when it has landed (`NodeId::landed`), its feature switch is on (`quality_allows`) and its
renderer enables it. In-pass nodes draw inside one world pass.

| # | node | kind |
| --- | --- | --- |
| 1 | tables | queue writes |
| 2 | Level-3 `before-cull` | compute |
| 3 | skinning | compute |
| 4 | light binning | compute |
| 5 | cull (instances, an occluded cascade keeping last frame's casters; meshlets pass 1 with R2) | compute |
| 6 | shadows (an occluded cascade: first draws, its Hi-Z, cull phase 2, second draws) | pass + compute |
| 7 | depth/normal prepass, then the camera's instance Hi-Z and final cull (`occlusion`) | pass + compute |
| 8 | occlusion: Hi-Z build, meshlet cull pass 2, prepass part 2 | compute + pass |
| 9 | Level-3 `after-prepass` | pass |
| 10, 10a | ambient occlusion; contact shadows, then the sun-shadow mask (`post::sun_mask`) | pass |
| 10b | screen-space reflections: the surface pass, Hi-Z, trace and resolve (`renderer/ssr_draw.rs`) | pass + compute |
| 11 | environment: sky LUTs and aerial perspective, IBL bake, irradiance-volume bakes, reflection-probe captures, froxel fog | compute + pass |
| 12-15 | opaque, sky, Level-2 materials and `after-opaque`, transparent | in the world pass |
| 15a, 16, 17 | Level-3 in-world passes' own motion, reactive mask, MSAA resolve, TAA | pass |
| 17a, 17b | the look's depth of field and motion blur (`post::dof`, `post::motion_blur`; off by default, on frames with the depth prepass, never on a settled capture unless the shot asks) | pass / compute |
| 18-21 | `post-hdr`, bloom, exposure, tonemap | pass / compute |
| 22-25 | upscale, 2D and `ldr` post, HUD (captures), timestamps | pass / queue |

The HDR path draws camera views reverse-Z (`Greater`, cleared to 0) on `Depth32Float`; the
legacy path keeps standard Z. `GxFrameV2` and `GxPostV2` expose `depth_reversed`.

## Skinning

`SkinnedModel::from_glb` loads every primitive of every node the first skin binds, one `SkinPart`
per material in first-use order (a single-material GLB is one part in the file's primitive order).
`Renderer::add_skinned_model` (or `add_skinned_parts`) keeps the parts; `Scene::draw_skinned_parts`
names one material per part, `draw_skinned` one for all. Node 3 runs one job per part of each
distinct pose: draws of one skin with a bit-identical palette share its jobs and output (one batch,
one row each), and a job whose output the skinned table already holds is skipped, so a still
character runs no skinning and its rows read last frame's vertices equal to this frame's (zero
motion). The skinned output, its slots and last frame's copy grow to the need, then by quarter
steps rounded to 64 KiB (`tables::skinned_growth`), not to the next power of two.

Skinned levels of detail (`skinned_lod`, game systems AN-25): when every skinned primitive carries
`extras.genex_lods`, `from_glb` turns the chain into `SkinnedModel::levels`, each a skinned mesh of
its own over the base skeleton (the vertices its triangles use, their `JOINTS_0`/`WEIGHTS_0` rows
unchanged, one part per base part). `add_skinned_model` adds them with
`MeshLibrary::add_skinned_levels`, which refuses `mesh-invalid` with nothing added (another part
count, more than `LOD_MAX_LEVELS`, errors not finite and rising, a second chain); a refused or
partial chain leaves the mesh drawing whole. Each frame `pick_level` asks the cull's own keep rule
(`lod_row_keep`, measured from the base mesh's posed sphere under the output's LOD view) which
level a draw keeps, and the plan skins only that one: by compute near, in the vertex stage far
(AN-18). Inside the fade band the two crossfading levels are both skinned by compute and drawn
through the LOD-03 fade batches, so a dolly through a switch neither pops nor draws a character
twice. Every level poses with the base palette (one joint table entry per draw); a band's glass
part is drawn by the finer level only.

## Ambient occlusion: horizons, the visibility bitmask, screen-space GI

Node 10 (`post::ao`) runs one horizon search, `shaders/post/gtao.wgsl`, in one of three methods
(`settings::AoMethod`, chosen per frame through `AoSettings::with_method`; `AoSettings::of` takes
`Quality::ao_method`):

- `Horizons`: XeGTAO (Intel, MIT). Every depth sample is a wall of infinite thickness.
- `Bitmask`: the visibility bitmask (pass 2 B.4, after Therrien et al. 2023, Bevy 0.20 `ssao.wesl`
  and three.js r186 `SSGINode`). Each slice keeps 32 sectors and a sample hides only the sectors
  between its front face and a point `BITMASK_THICKNESS_PER_RADIUS` of the radius behind it, so a
  post, a trunk or an arm no longer darkens a halo on the ground or wall behind it. The open arc
  uses XeGTAO's cosine weighting, so solid creases stay as dark, and the bent normal comes from the
  open run around the view vector. The renderer's `frame_ao` takes `AoSettings::of`; phones and
  `medium` keep the horizons (owner decision D16 for phones). The
  thickness (0.125 m at the default radius) keeps a block's base darkening smooth in settled
  captures (template row `metal_the_blocks_base_darkens_smoothly_in_settled_captures_at_every_preset`).
- `BitmaskGi`: the bitmask plus one bounce of screen-space light. The sectors a sample hides first
  send the previous frame's light at that sample (`AoInput::light`: a texture and its scale to scene
  units, reprojected through last frame's camera). The term is `GI_FORMAT` (`rgba16float`: r
  visibility, gba the light as a share of the hemisphere) and carries no bent normal. The presets
  ask for it at desktop `ultra` (look integration); `high` keeps the bitmask alone, because the GI's
  terms (+18.4 MB at 1440p) take desktop-high's default past its 512 MiB budget. The screen effects
  (`renderer/effects.rs`) take GI targets through `prepare_with_ao` and the light through
  `set_ao_light`: the previous frame's resolve as TAA stored it, pre-exposed, at scale 1. Where the
  targets were taken without GI, a GI quality draws the bitmask alone. The forward pass, terrain,
  grass and Level-2 v2 materials read the term under the `GX_AO_GI` constant (`ambient.wgsl`
  `gx_ao_decode_gi`): the light divided by the frame's pre-exposure, times the surface's diffuse
  weight, is added to an opaque surface's diffuse indirect light, and no bent normal is read. A frame
  whose AO does not run binds a texel of visibility 1 and no light. The GI's reach is AO's radius
  (0.5 m by default), so it reads as bounce in corners and at contact: the Harbour café's rug row
  (`harbour_shots.rs`) holds it at least as red as A.4's irradiance volume alone.

`GX_AO_BITMASK` and `GX_AO_GI` are pipeline-overridable constants, so the horizons' pipelines
compile as before. Rows: `tests/ao.rs` (`metal_bitmask_*`: a post's halo against a ray-cast ground
truth, the log wall, open ground, a red box's bleed onto the floor, a new light on unchanged inputs,
the forward pass's GI consumer, the cost at 1080p) and `tests/extension_v2.rs` (a v2 material
reading GI where AO does not run).

## Materials: alpha masks, double-sided, occlusion

A glTF `MASK` material keeps its alpha factor and `alphaCutoff`, `doubleSided` and the occlusion
texture are read too (`GlbMaterial`, `Material::alpha_cutoff`, `double_sided`,
`occlusion_texture`). Each `scene::DrawVariant` other than plain (double-sided, alpha-tested,
both) gets its own batches after the plain ones and its own pipelines (`src/renderer/variants.rs`),
reading its region of the slot-base table through its own pass-view rows, so a scene without
them draws exactly as before. An alpha-tested batch cuts its cutout in the prepass, the sun's
casters (the plain test) and a depth step of the world pass (alpha-to-coverage under MSAA, a
hashed threshold under TAA), then shades with an `Equal` depth test and no discard. Its base
colour map uploads as `TextureKind::Cutout`, whose mips keep the alpha test's coverage (NVTT's
`scaleAlphaToCoverage`). An occlusion map (its red; an ORM texture's metallic-roughness texel) is
the smaller of it and the screen-space AO on indirect light only. The material sampler filters
anisotropically by preset (`Quality::anisotropy`: 16 on high and ultra, 8 medium, 4 low and
phones, 2 on low-tier phones). Spot casters still draw a variant whole.

## Subsurface scattering and diffuse transmission

`Material::with_subsurface(Subsurface)` (`src/subsurface.rs`, renderer pass 2 B.1; presets `WAX`,
`SKIN`, `LEAF`) writes the scatter colour, thickness, forward-scatter power, diffuse transmission
and scattering depth into the material-extension row (`GxMaterialExt.subsurface` and
`.transmission`, 64 bytes a row; no binding) with the `MATERIAL_EXT_FLAG_SUBSURFACE` flag. The
lighting chunk `shaders/lighting/subsurface.wgsl` runs after the sun for a flagged material only (a
draw-uniform branch; every other material shades byte for byte as before), in the forward pass and
the Level-2 v2 prelude: Filament v1.77.3's subsurface model (wrapped back scatter, forward scatter
about the view-to-light axis, in the scatter colour) plus Bevy v0.20's back Lambert lobe in the
base colour. Both are lit through one point-sampled gather of the sun's cascade: how far along the
light the fragment lies behind the stored casters, past a slope tolerance, attenuated as
`exp(-distance / depth)`, so a thin leaf passes its back-light, a thick candle only its rim, and a
caster between the surface and the sun shadows the light through it. Local lights add the same
lobes without the gather (a spot's shadow map multiplies them); the environment adds no subsurface
term yet. A GLB material's `KHR_materials_diffuse_transmission` imports as a `Subsurface`
(`GlbMaterialExt::subsurface`, applied by `GlbMaterial::to_material`): the back lobe at its factor in
the base colour, as Bevy imports it, no scatter, its depth `KHR_materials_volume`'s attenuation
distance, else its thickness, else a leaf's; the colour factor and the textures are read, not
shaded. Fixtures and the 1080p timing row: `tests/subsurface.rs`.

## Reflection probes

`Lighting::reflection_probes` (`probes::ReflectionProbe`; the facade's `frame.reflection_probe`)
are boxes of the world whose glossy reflections come from a cube captured inside them. The first
`EnvironmentQuality::reflection_probes` a frame declares (4 low, 8 medium, 16 high and ultra; 2 to
8 on phones by tier) get a layer of one cube array whose layer 0 is the sky's specular cube, at the
sky cube's side capped by `probe_side_max` (256 desktop, 128 phones): binding 11 of the forward
frame group, the rows (binned with the lights, `ClusterKind::Probe`) at binding 22. Node 11
captures a probe after the sky's bake: six faces drawn from its capture point through the forward
pipeline compiled for the capture (one sun cascade over the probe's box, the light loop, no
screen effects, no probes read), the sky behind the geometry, then the IBL prefilter into a
staging cube published into the probe's layer whole. A new probe is captured whole (two a frame);
a stale one (the sky rebaked, the probe moved) refreshes one of 14 steps a frame while its last
capture stays bound; a settled capture recaptures what differs. The forward pass weighs each
binned probe by its fade past the box, reads it along the reflection projected onto the box grown
by the fade (eased in with the weight) and fills what the probes leave with the sky. Captures
leave out transparent draws, alpha-masked and double-sided variants, particles, lines and
Level-2/3 passes; Level-2 v2 materials reflect the sky's cube.

## Irradiance volumes

`Lighting::irradiance_volumes` (`irradiance::IrradianceVolume`; the facade's
`frame.irradiance_volume`) are boxes of the world whose diffuse environment light comes from a
grid of cells baked in the scene instead of the sky's SH9. Each cell is an ambient cube (six
`rgba16float` texels, Bevy's `IrradianceVolume` packing: X x 2Y x 3Z texels a volume): rgb the
cosine-weighted mean radiance around each axis direction, alpha both reaches of the axis (how far
the cell sees before a surface each way, 5-bit codes). The first
`EnvironmentQuality::irradiance_volumes` a frame declares (4 medium, 8 high and ultra; 2 to 4 on
mid and high phones, none on low and the low phones) get a block of one 3D atlas, binding 32 of
the forward frame group (the stage's 15th sampled texture of 16, owner decision D1); their rows
share the probes' table at binding 22 and their bins (`ClusterKind::Probe`, after the probes).
Node 11 bakes them before the probes' captures: a cell is six 16-texel faces drawn from its centre
with the capture pipeline (both sides of every triangle, no ambient term: the bake is the scene's
first bounce, sun and local lights, the sky where no geometry covers a texel), reduced into its
ambient cube in a staging block that is copied into the volume's block once every cell is baked.
Two cells a Live frame (a cold volume fades in over 30 frames once published; a stale one rebakes
on the cadence while its last bake stays bound); a settled capture bakes what differs whole, eight
cells a submission. The forward pass (`gx_env_light`, one walk of the probe bins for the
reflection and the diffuse light) weighs each binned volume by its fade past the box, offsets the
point along its normal by 0.3 of a cell and reads the three ambient-cube faces toward the normal
through the sampler's trilinear filter; with `irradiance_leak_control` (desktop and web) the
position first moves along each axis toward the side whose cell sees the point (its reach that way
against the point's distance), so a cell behind a wall lends no light. Level-2 v2 materials take
the sky's SH9. The ledger's `irradiance-volumes` row counts the atlas, the staging block and the
bake's targets. The volumes are not updated by traced rays: DDGI with software rays measured about 11 ms
on an integrated GPU for its cheapest update (budget 2 ms), so it is not built; `tests/ddgi.rs`
holds that measurement and turns red if software rays get cheap enough to revisit it.

## Night sky and sky media

`src/night_sky.rs` and `shaders/sky/`: as the sun sets (`night_sky::night_factor`, exactly 0 with
the sun up, so day frames do not change) the background draws hashed stars (one at most per cell
of a 128 x 128 grid on each cube face, a power-law brightness, each a Gaussian at least a pixel
wide, no catalogue) and a `Moon` lit by the sun with its phase (a Lommel-Seeliger disk with
earthshine and maria). The moonlit sky is the sky-view kernel run again with the moon as its light
into a second LUT, made the first moonlit night and computed only at night; `cs_sky_cube` adds it
and the stars, so reflections and the ambient see them (the disk stays out, as the sun's).
`night_sky::ground_light` is the light the ground takes under the sky: the sun, or the moon once
it outshines the setting sun. The air is data (`sky::SkyMedium`: Earth's by default, `mars()`, or
any planet, Rayleigh, Mie and absorbing layer). No forward binding.

## Cloud panorama

`src/clouds.rs` and `shaders/sky/clouds.wgsl` (renderer pass 2 B.5): `SkyParams::with_clouds` adds a
layer of cumulus that a compute kernel marches into a panorama of the sky above the horizon
(`EnvironmentQuality::clouds`: 1024 x 256 on medium, 2048 x 512 on high, 4096 x 1024 on ultra; none
on low and phones). The sky's background and `cs_sky_cube` read it over the sky-view LUT
(`sky/clouds_map.wgsl`), so the sun's disk hides behind the clouds and reflections and the ambient
light see them; no forward binding. The noise (a Perlin-Worley shape volume, a Worley detail volume
and a weather field, after sebh's TileableVolumeNoise) is made once on the GPU; the march follows
takram's three-clouds (multiple-scattering octaves, a dual-lobe phase, the sky's light as ambient,
the air in front of the clouds from the transmittance and sky-view LUTs) without its STBN texture:
each texel starts at a fixed 2 x 2 Bayer quarter of its first step plus an interleaved gradient
noise of its position, and both composites read the panorama through `gx_clouds_at`, a [1, 2, 1] / 4
filter over a texel either side, which cancels the Bayer part of that dither (at 4K the bare texels
showed it as a cross-hatch along the clouds' edges). `Clouds::with_cirrus` adds a thin sheet of
cirrus streaks 8 km up, in patches, singly scattering the sun through the air (the planet's shadow
included) over a forward phase, composited behind the cumulus in the same march. Amortised: while
the sun or the camera's height or the layer (a drifting offset) moves, each frame marches one texel
of every 4x4 block (8x8 on ultra); a settled capture, the first frame or a sun that jumps 2 degrees
marches it whole. The clouds' ambient is the sky-view LUT's cosine-weighted mean over the sky (the
zenith and three rings), and the march towards a low sun reaches as far through the layer as the
slant asks (up to 10 km), so golden-hour bases overhead stay in their own shade instead of glowing
flat orange and dyeing the environment's ambient. On a night the moon outshines the set sun
(`night_sky::ground_light`), the moon lights the clouds with the moonlit sky-view LUT as their
ambient, and their light takes the moon's tint at its luminance (no warm cast from the low moon's
reddened light). The clouds light the scene's shade through the environment, so a heavy golden-hour
layer still warms it (the showcase Lakeside keeps 0.4 cover under 0.6 cirrus). `tests/clouds.rs`
holds the budget (1.0 ms a frame on high, march and composite), the sun-disc and cloud reprojection
row under a turning camera, the cloud-edge flicker row, the moonlit-night row, the golden-hour
ambient row, the 4K dither row and the cirrus row.

## Fog, aerial perspective and froxel fog

`Look::fog` (`settings::Fog`) is a height and distance fog lit by the environment: the sky's
horizon radiance plus the sun's forward lobe, tinted by the fog's colour (`fog.rs`, the lighting
chunk `shaders/lighting/fog.wgsl` and its CPU twin). The golden hour's warm veil is held down
(owner decision D13): the lobe takes a third of the sun's radiance in a colour a third of the way
to the sun's luminance, and half of the sun's aureole the horizon read sees beyond the ray's own
angle to the sun is taken out (`fog::sun_side_cut`), so sunlit ground seen from above towards a
low sun keeps its colour and texture while a ray along the horizon keeps its light. The sky
background, the map backdrop, particles and the froxel fog repeat the same in-scatter. On medium and above node 11 also writes the
sky's own scattering as an air volume (`fog::AerialPerspective`, 32 x 32 froxels by 32 slices):
its in-scatter in front and its transmittance per channel behind (`fog::AIR_HALVES`, renderer pass
2 SI-04), the slices even to 4 m and logarithmic out to 32 km (`fog::aerial_slice_distance`).
On desktop and web `high` and `ultra` (`EnvironmentQuality::froxel_fog`: 112 x 63 x 64 and
160 x 90 x 64; phones keep the analytic fog until measured) the fog is a lit volume (`froxel.rs`,
`shaders/sky/froxel_fog.wgsl`, a port of Godot's volumetric fog): one compute pass after the
aerial volume injects each froxel's extinction (the closed form across its slice) and light (the
sun's lobe through one shadow tap of its cascades, the sky, the binned local lights), blended with
last frame's volume at a Halton jitter, then scans each column front to back with the aerial
volume folded in behind the fog. The result has the aerial volume's layout and slice mapping and is
bound in its place at forward binding 17, so the forward pass, transparents, Level-2 v2 materials
and particles read it through the same lookup (`gx_air_sample`, no new binding); its in-scatter's
alpha 1 tells them the height fog is already in it. Unshadowed, it is the analytic fog exactly,
so the sky background (still analytic) meets it at the horizon. A history follows Live frames
only: a reset, a settled capture's frame 0 and a history-set switch start it over, unjittered.
`Fog::volumetric` off keeps the analytic fog on every preset. Level-3 passes still apply the
analytic fog from their tables (`fog_color`, `fog_params`): no shafts there.

## Decals

`Lighting::decals` (`decals::Decal`; the facade's `frame.decal`) are boxes of the world that lay a
texture onto every surface inside them before lighting: a model matrix over the unit cube (it
projects along its local -y; local x is the textures' u, local -z their image's up), up to three
layers of the material size-class arrays (an sRGB base colour whose alpha is the shape, a normal
map, an ORM map), a tint and opacity, how much of the colour it replaces, the roughness and
metallic it gives, how far it flattens the surface's own bumps (a puddle's film), and its fades
(towards the box's top and bottom, on surfaces turned 60 to 80 degrees from its face). The nearest
`LightQuality::decals` of them are drawn (64 on desktops, 16 on phones, none on `off`), the last
tenth fading towards the first dropped one. They are the second clusterable kind of the bins
(`ClusterKind::Decal`; their tile rectangles are their box corners' screen rectangle, tighter than
the sphere's), and their rows (`decals::GpuDecal`, seven `vec4`s) follow the light rows and every
shadowed spot's matrix slot in the `light_ext` table, so decals take no binding of their own: the
forward stage stays at 6 storage buffers and 15 sampled textures. The surface chunk's companion
`shaders/lighting/decals.wgsl` (`gx_decals`, after Godot 4.7.2's clustered decal loop) walks the
decals binned at the fragment, samples each one's maps at one mip from the gradients of the
fragment's position in the box, and blends overlapping decals order-independently (each channel's
weighted mean, covering 1 - prod(1 - alpha)), so the picture never depends on the camera's binned
order. Level-2 v2 materials take decals through `gx_shade_pbr` (an isotropic pixel footprint for
the mip; maps of size class 0 only, a decal with a larger map is left out there). A probe's or a
volume's capture draws none. Decals are not geometry: they cannot z-fight and follow the surface
through every level of detail.

## Particles

`particles.rs` holds GPU emitters (`EmitterDesc`; the facade's `Particles` and `frame.particles`).
A particle is a pure function of its emitter and the tick, so Live and a capture agree and nothing
is read back. A compute pass ahead of the world pass writes every row; graph node 15 draws them as
billboards after the transparent draws, through the air and the fog at their centres (the froxel
fog where it runs). Each feature is per emitter:

- **Soft** (`soft_distance`, after three.js's `SoftParticles.js`): a billboard fades as it nears
  the opaque scene behind it. It reads the prepass depth as view depth at half the render size
  (`particles_depth.wgsl`: the nearest of each 2 x 2, filtered by hand in the fragment), a copy of
  the particles' own because the world pass may hold the prepass depth as its attachment. A soft
  or colliding emitter asks for the prepass through the extension inputs; without it, it draws
  hard.
- **Flipbooks** (`Flipbook` over a `ParticleAtlas`, up to 16 x 16 cells, 16 atlases): frames
  played over a life, cross-faded on request.
- **Sorted** (`sorted`): back to front by a bitonic sort of (view depth, slot) pairs (AMD
  GPUParticles11 as Godot carries it), 2048 pairs a workgroup in 16 KiB, every sorted emitter of a
  frame in the same dispatches: the same order every run.
- **Depth collision** (`collision`): a particle's closed-form path is marched against the view
  depth; one that went behind what the camera sees rests there, fading, then is gone. Only a
  colliding frame's emit pass waits for the prepass.
- Rotation, growth, spawn boxes and streaks stretched along the motion (rain). TAA's reactive mask
  covers the billboard as drawn (`particle_billboard.wgsl`).
- **Camera fade** (`near_fade`; the rain preset's `RAIN_NEAR_FADE`, 2 m): a billboard is gone
  within a quarter of it in front of the camera and fades in over the rest, so a drop passing
  just in front of the lens draws no wide streak for one frame.

A class draws at most `particle_cap` particles a frame (every slot on desktops, 32,768 on high
phones, 8,192 on the rest; past it every n-th slot). The budget row (`tests/particles.rs`): 64k
sorted, soft, colliding rain streaks at 2560 x 1440 `high` add at most 0.5 ms on the M4 Max.

## Screen inputs and the SSR helper

`src/screen_inputs.rs` holds what lake water (Stage B's B.3) and screen-space reflections (B.9)
read from the screen, and the ray march they share. `Quality::screen_inputs` allows them on desktop
and web `high` and `ultra` (none on phones or below `high`); `frame_inputs` gives a frame only what
a consumer asks for, none on the legacy LDR scene, no colour pyramid without TAA and no opaque
copy of a multisampled world pass. The colour pyramid keeps the render size's even under TAA
upscaling, whose resolve is at output size: its first mip reads that resolve by its own uv, so the
whole picture lands in it (a render-size uv read only its top-left corner, and the reflections
vanished at scale 0.67). The lake water and the screen-space reflections ask for them;
every target is pooled under its own ledger row.

- `shaders/screen/ssr_march.wgsl` is a chunk, not a pass: `gx_ssr_march_world` (or
  `gx_ssr_march_new` with `gx_ssr_march_to` / `gx_ssr_march_toward`) sets up a ray clipped to the
  frustum and `gx_ssr_march_run(depth, march)` finds the first surface it passes behind. It is
  Bevy 0.20's `ssr/raymarch.wesl` (Stachowiak): a linear march over the pixels the ray crosses,
  bisection and a secant step, bilinear and nearest `textureLoad` depth taps. Distances come from
  `gx_view_distance`, so every projection and depth convention marches alike. `march` in the
  module is its CPU twin (`tests/screen_inputs.rs` holds the two equal on 4,096 rays).
- `encode_opaque_copy` copies the HDR scene after graph node 14 into the `opaque copy` target (the
  scene's format, render size) before the transparent draws.
- `PyramidNode` halves TAA's output (`history pyramid`, `rgba16float`, up to 6 mips) with a
  five-tap tent in one compute pass: the previous frame's colour for rough reflections.
- `shaders/screen/normal_roughness.wgsl` packs a normal-mapped normal (two 12-bit octahedral
  coordinates in rgb, within 0.06 degrees) and the perceptual roughness into one `rgba8unorm`
  texel (`prepass normal roughness`), which the screen-space reflections' surface pass writes.
- Binding 30 of the forward frame group (`FRAME_REFLECTIONS_BINDING`) holds the screen
  reflections (rgb, a confidence): the stage's 16th sampled texture of 16 (owner decision D1), a
  zero texel on frames that trace none. A frame nothing in can reflect (`ssr::frame_can_reflect`,
  lane FQ: no instance whose material's roughness factor is under the cutoff or that has a
  metallic-roughness texture, no binned decal that sets a roughness under it) traces none: the
  trace would have resolved every texel to zero, so node 10b opens no pass and the pyramid is still
  built for the next frame.
- `shaders/screen/normal_roughness_unpack.wgsl` is the readers' half of the packing (the code range
  and `gx_unpack_normal`, `gx_unpack_roughness`), which B.9's passes include alone.

## Screen-space reflections

`src/ssr.rs` (B.9) traces what a smooth surface reflects of the screen: Godot 4.7.2's Hi-Z
screen-space reflections, ported. `Quality::ssr` turns them on at desktop `high` (48 Hi-Z steps a
ray) and `ultra` (64), off on phones and lower presets; `frame_ssr` traces only with TAA's colour
pyramid on the HDR scene (`SsrQuality::asks` is A.6's `ScreenInputs::SSR`). `SsrNode::encode`
records five compute passes:

- a nearest-depth Hi-Z (`ssr hi-z`): graph node 8's build with the opposite reduction
  (`hiz_reduce`), half the render size down to 1 x 1;
- the trace (`ssr trace`, `rgba16float`, half size): parametric-t Hi-Z tracing, the
  geometric-normal bias, the hit validated by depth tolerance, facing and the screen margin, faded
  in over the first texels and out by a smoothstep from 0.4 of the screen. It reads the previous
  frame's colour pyramid at the reprojected hit, at the mip that spans the GGX lobe's spread there:
  Uludag's cone for the lobe's Phong power, times the hit's distance from the surface, projected at
  the hit's depth (Godot's `r8` mip image and its filter pass are gone: `r8` is no core storage
  format). A reflection keeps its full strength up to perceptual roughness 0.3
  (`ROUGHNESS_FADE_START`) and fades by a smoothstep to nothing at 0.7 (`ROUGHNESS_CUTOFF`), where
  the probes take over alone; surfaces from 0.7, and the sky, are not traced;
- the blur (`cs_ssr_blur_x` into the reflections' texture as scratch, then `cs_ssr_blur_y` back
  into the trace; not in Godot): a separable bilateral Gaussian over the trace, up to four texels
  each side on a surface from roughness 0.3 and nothing on a mirror, so the edge of a hole where a
  ray found nothing (a thin table top, a pendant bulb: the probes show there) spreads like the
  lobe on a rough floor instead of drawing a half-size staircase;
- the resolve (`screen reflections`, `rgba16float`, render size): Godot's bilateral upsample by
  depth, normal and roughness. rgb is the reflected radiance times the confidence, a the
  confidence: the texture for forward binding 30.

`shaders/screen/ssr_apply.wgsl` (`gx_ssr_apply`) is the forward pass's hand-over: the probe or sky
radiance times one minus the confidence plus the screen's, so where both agree nothing changes
with the confidence. `twin` in the module is the CPU twin of the trace and the resolve
(`tests/ssr.rs` holds the GPU equal to it, and holds the wet road's reflection still over TAA's
eight jitter offsets and in place on a pan).

On the frame (`src/renderer/ssr_draw.rs`, graph node 10b `ssr`, after the contact shadows) a
frame of the HDR scene under TAA whose quality traces runs, once the previous frame left its
colour pyramid on the same history and size:

- the surface texel, in the prepass (lane FR; `shaders/screen/prepass_surface.wgsl` in
  `shaders::PREPASS_SURFACE`, the forward module's surface twin): the prepass draws everything else
  first, then the opaque plain batches in a pass of their own over that depth, writing its three
  targets and the normal and roughness the forward pass shades with (`gx_ssr_surface_texel`:
  normal maps, specular AA, the decals' wet patches: Harbour's puddles are decals at roughness
  0.04 over the asphalt) in one draw. The prepass's normals stay the vertex normals. A batch that
  variants, meshlets, the terrain, grass or custom geometry hide fails the depth test and leaves
  the cleared texel (fully rough), and prepass part 2's meshlets write it
  (`fs_prepass_motion_rough`), so the probes reflect them. Before lane FR the batches were drawn a
  third time for it, `Equal` over the prepass depth (vertex 0.63 and fragment 0.49 ms busy at
  Ashen Horde's 10k peak); the texels are the same (`tests/ssr_prepass.rs`: a traced street is
  byte-identical, `FrameStats::camera_opaque_passes` 3 to 2);
- `SsrNode::encode` with the jitter-free camera, last frame's view-projection along TAA's
  reprojection row and the exposure ratio between the frames;
- after TAA, `PyramidNode` over TAA's output: the next frame's reflected colour. The water reads
  the same pyramid on such a frame and builds none of its own.

The forward pass's opaque pipelines read binding 30 at the fragment's pixel (`GX_SSR`,
`gx_screen_reflection_at`) and the ambient chunk lays it over the probes' radiance; the
transparent pipeline and Level-2 materials never read it. `examples/showcase/tests/harbour_ssr.rs`
holds Harbour Street at night: the wet asphalt reflects the neon and the café, nothing off the
ground changes, the cost against `budgets.json`'s `ssr-high` and `ssr-ultra`, and no added flicker
over a still camera. The trace reads the pyramid's mip 0 bilinear (a mirror stays sharp) and every
coarser mip through a cubic B-spline in four bilinear taps, so a rough reflection of a small bright
light spreads round rather than as a square (`tests/ssr.rs`, its twin `twin::sample_pyramid`).
Known limit: a ray passing behind a thin object (a pendant bulb) is not validated and shows the
probes there.

## Lake water

`src/water.rs` (`shaders/water/water.wgsl`) draws a flat water rectangle (`WaterBody`: centre, half
extents, `WaterMaterial`) with its own pipeline and layout, so it spends none of the forward
stage's sampled textures: group 0 the frame uniforms, group 1 a uniform (`GpuWater`), the opaque
copy, the scene depth without the water, the environment cube array and the previous frame's
colour pyramid. `WaterNode::draw_colour` composes the surface over the scene:

- the path the view ray travels under water (the depth's bed distance minus the surface's) sets a
  Beer-Lambert transmittance per channel (`transmittance`) and the water body's in-scattered light
  fills what it took (ideas from bevy-aqua-fft and bevy_water); the body and its foam are lit by
  the scene's light: the environment's sky (layer 0 at its widest level, from above) where the
  environment lights the scene, the flat ambient only where it does not, and the sun over the water
  (the flat fill is never read by the forward pass under the environment, and at a moonlit night it
  is about 100 times the sky);
- with the opaque copy (`WaterPath::Refracted`) the bed is sampled through the ripples' offset,
  which grows from nothing at the shoreline and is dropped where it would land on something in
  front of the water; without it (`WaterPath::Blended`: phones, MSAA presets, the legacy scene)
  the surface blends premultiplied over the scene, unrefracted;
- Schlick's Fresnel (F0 0.02) mixes in the reflection (`water::reflect`,
  `shaders/water/water_reflect.wgsl`): on desktop and web `high` and `ultra` the SSR helper's march
  finds the reflected surface in this frame's depth and reads last frame's colour pyramid at the
  hit's reprojected point, re-exposed by this frame's exposure over the pyramid's and at the mip
  the roughness cone spans; where it misses, and always on phones (`reflection_source`), up to four
  reflection probes over the water (`probes_for`, a uniform at group 1 binding 6, no storage
  buffer) box-projected and blended as the forward pass blends them, the sky layer filling what
  they leave. `WaterNode::set_reflection` takes the frame's row (`GpuWaterReflect::new`); a node
  never given one reads the pyramid as it is and the sky alone. A capped sun glint keeps a ripple
  facing the sun from becoming a firefly;
- the ripples a pixel's footprint on the water cannot hold (finer than half their wavelength) fade
  out of the normal, and their slopes' variance and the normal's spread over the pixel widen the
  roughness instead (`gx_water_surface`; `ripple_roughness`, `specular_aa` are the twins), and the
  sun glint's lobe widens with that roughness (`glint_power`, dimmer as it widens), so a rippled
  lake does not sparkle under TAA's jitter;
- shore foam (`shore_foam`, the idea of GodotOceanWaves) is a lace over water shallower than the
  material's width: feathered to it, broken up by two octaves of value noise into patches
  (`FOAM_BREAKUP`: none where the noise is low) and at most `FOAM_COVER_MAX` of the water, so the
  waterline is neither one unbroken white line nor a flat ribbon; a pixel shows none of it where the
  band is about a pixel wide or narrower on the screen or the view grazes the water
  (`foam_visible`: no bright rim round a far lake, no rings round posts).

`WaterNode::draw_motion` then writes the surface's own motion (reactive 0) and depth into the
motion prepass's targets, so TAA reprojects a water pixel by the water's motion, not the bed's,
and keeps its history. The node's twins and GPU rows are in `tests/water.rs` (the reflection's in
`tests/water_reflect.rs`); its budget is 1.0 ms
at a 1080p render (`WATER_MS_MAX`).

On the frame it is graph node 16a (`NodeId::Water`, `src/renderer/water_draw.rs`): a scene's
`Scene::water` (`SceneWater`: the body and the water's clock) draws after the world pass and its
resolve, in a pass of its own over the 1x HDR scene, depth-tested against the prepass depth held
read-only (the depth its shader samples). Where the preset allows the opaque copy (desktop and web
`high` and `ultra`) the scene is copied first and refracted; elsewhere the water blends over it.
It runs only where `water::drawn_at` says (the HDR scene under TAA with the prepass), so a game
knows where to stand in for it: an MSAA world pass (desktop `low` and `medium`, the phones'
defaults) draws none yet, and there the showcase Lakeside draws its own lake pass and bench-outdoor
the blended sheet it drew before (`BenchScene::scene_for`). On frames writing motion the motion key
follows in its own pass (its group binds a 1 x 1 depth: the pass writes the prepass depth the colour
pass sampled). It reflects the probes over it (`GpuWaterReflect`) and, where the preset holds the
history pyramid, the screen: after node 17 a frame with water builds the colour pyramid of TAA's
resolve (A.6's `PyramidNode`), and the next frame's water marches it (only a frame that follows it
on the same history set and size). A game draws one with `frame.water` (`genex::render::Water`),
which reaches the scene on the simulation's clock (`genex::present::water_of`); the Lakeside's lake
and bench-outdoor's are drawn this way. The look's height fog covers its surface
(`lighting/fog.wgsl` over the frame's fog row, `WaterFrame::fog`; the froxel and aerial volumes are
not read). On a water frame without MSAA the
transparent draws and the stage's blended work (graph node 15, Level-3 `after-transparent`
sprites) wait for the water and draw in a second world pass over the scene, depth-tested against
the prepass depth the motion pass wrote the surface into, so a glint or a halo over the lake is
not covered (`Renderer::transparents_after_water`). Still to come: water under MSAA.
`tests/frame_hooks.rs` holds the frame row.

## Ocean

`src/ocean.rs` is the optional open-sea tier, on for desktop `high` and `ultra` (`ocean::enabled`;
phones are unverified and off). An `OceanSpectrum` (patch size, wind speed and direction,
significant wave height, choppiness, seed) gives a directional Phillips spectrum whose Gaussian
draws are hashed from the seed, so its initial table is the same on every machine and is uploaded
once. `OceanNode::simulate` records one compute pass (`shaders/ocean/ocean_fft.wgsl`) that turns the
spectrum to the frame's time, runs a 256-point radix-2 Stockham inverse FFT along the rows and then
the columns (one 256-invocation workgroup per row, 8 KB of workgroup memory), and resolves a
displacement map (choppy x and z, height, the Jacobian) and a slope map, both `rgba16float`, 256 a
side. Every wave's frequency is a multiple of 2π/`REPEAT_S`, so the sea loops every 200 s and a
long session keeps its precision. The method is Tessendorf's; the Stockham passes follow the idea
of bevy-aqua-fft (no source copied).

`OceanNode::draw` (`shaders/ocean/ocean.wgsl`) draws a camera-centred grid whose spacing grows
with distance, displaced by the maps. Its own layout binds four sampled textures (the two maps,
the scene depth without the sea and the environment cube array), none of the forward stage's. It
shades with Schlick's Fresnel between the sky layer and the water body's in-scattered light, a
capped sun glint, light through crests that face away from the sun, foam where the waves fold and
along the coast, and Beer-Lambert absorption to the bed, blended premultiplied over the scene. Far
away the slopes fade to flat and the roughness rises, so the far sea neither aliases nor sparkles.
`OceanNode::encode_motion` then writes the displaced surface's own motion under the camera
(reactive 0) and its depth into the motion prepass's targets, as the lake does, so TAA reprojects a
sea pixel by the sea.

`OceanTwin` is the deterministic CPU twin: the same spectrum, dispersion and Stockham passes in f32
with libm. `OceanTwin::surface(t).height_at(x, z)` gives gameplay the height of the waves the
picture shows, choppy displacement included, and two runs read the same bits. `tests/ocean.rs`
holds the twin's rows, the GPU maps against the twin, a coast shot and the cost. The budget is
2.0 ms for the simulation and the surface together (`OCEAN_MS_MAX`). The frame does not record the
node yet; the scene's sea and the renderer's node 11 and 15 hooks are the next step.

## Terrain

`Renderer::set_terrain` (`terrain::TerrainDesc`; the facade's `Terrain` and `frame.terrain`) holds
one heightmap terrain: up to 2049 x 2049 heights quantized to 16 bits, a control word per sample
(base layer, overlay layer, blend, wetness) and up to 16 layers whose base colour (height in alpha)
and data (normal xy, roughness, occlusion) textures live in the material arrays (size classes and
the `MaterialSize` rung apply). Each frame the CPU selects CDLOD nodes (Strugar 2010) by their
distance from the camera, with no frustum, then culls them per view (the camera, each drawn
cascade) into one row table; every node is an instance of one 16 x 16-quad grid (a quarter node
draws its first 8 x 8). The ranges are floored at build so a node is never beside one two levels
coarser and a coarser neighbour's own morph has not started on their shared edge; odd grid
vertices slide onto their even neighbours through the morph band, at integer sample positions
exactly, so shared edges meet bit for bit and a node equals its parent's grid when it is
replaced. The terrain's own pipelines (`renderer/terrain_draw.rs`) draw it in node 6 (each drawn
cascade's casters), node 7 (depth, the per-pixel normal, and motion on TAA frames: the motion
group at group 3) and node 12 (after the opaque batches; `Equal` against the prepass depth where
the world pass reuses it), over the forward frame group, the pass view and the terrain group
(group 2: its row, the frame's rows, one storage table of heights, control words and a normal
pyramid). The surface is made per pixel: the normal from the pyramid at the pixel's footprint
(trilinear, the lost length folded into roughness), the layers from the four control texels
around the pixel blended by weight and height, hex-tiled (Mikkelsen 2022) on desktop `high` and
`ultra`, then lit by the forward pass's chunks. It adds no sampled texture and one fragment storage
buffer to the forward stage's (tests/terrain.rs). Probe captures and spot shadows leave the
terrain out. The ledger's `terrain` buffers row counts its tables and grid.

A streamed world's tiles live in `terrain::atlas` (game systems STR-21, after bevy_terrain's tile atlas). `TileAtlasGpu` holds one storage table of fixed slots, each one square tile in the single terrain's layout (heights, control words, normal pyramid). Desktops get up to 256 slots within the 128 MiB binding; phones get up to 64 within 48 MiB, so a desktop has 44 slots of 513-sample tiles and a phone 16. `TileAtlas` counts requests per tile. A released tile stays in its slot, queued oldest-first, until a new tile needs that slot, and a re-request revives it without a load. A tile still loading draws its nearest loaded ancestor (`best_tile`). A request when every slot holds a requested tile is refused `stream-arena-full`, and an upload for a tile that is no longer loading writes nothing (tests/terrain_atlas.rs).

A tiled terrain (game systems STR-22) is still one terrain a frame. `TerrainTiling` lays out square tiles of one sample count (17 to 2049, 16 quads times a power of two; 129 at most on mobile-low, `tile_samples_cap`, finer tiles thinned with `Heightfield::decimate`). Every tile quantizes over the world's height range (`Heightfield::with_range`) and each tile's origin is the previous one's plus the tile's side, so a sample two tiles share holds the same bits in both. `TerrainLod::tiled` gives one set of ranges for the world from the largest node box any tile could have, so a tile streaming in never moves a range. `TerrainTiles` selects each tile with A.7's own tree under those ranges; vertices on a shared border coincide bit for bit, neighbours one level apart included. A missing tile draws its window of the always-resident overview (16 quads a tile): one unmorphed row while its top node cannot split, the window upsampled to the tile's samples when it can, its border samples taken from loaded neighbours, so it leaves no hole. `TerrainTilesGpu` gives each tile a group over its atlas slot (`tile_terrain_row`: the heights' first sample in `counts.y`) or its window's maps, and draws each tile's rows from one rows table (tests/terrain_tiles.rs).

## Grass and scatter

A terrain layer may carry grass (`terrain::TerrainLayer::grass`, `foliage::GrassLayer`; the
facade's `Grass` and `TerrainLayer::with_grass`): blades per square metre, their height and width
ranges and colours (foot, tip, dry tips, flowers) and how much light passes through them. Nothing
is uploaded per blade. Each frame, after the tables (graph node 1), three compute passes generate a
camera-centred square of 16 x 16-cell tiles (`foliage::gpu`, `shaders/foliage/grass_gen.wgsl`): a
tile past the reach or outside the camera's frustum keeps nothing; elsewhere one lane per cell hashes
the cell's global index into a candidate (jitter, layer from the control map, keep threshold against
the layers' density times the cell's area, the quality's share and a distance falloff), compacts the
survivors by a workgroup prefix sum into the tile's region, scans the tile counts into the indirect
draw's arguments and packs the drawn order. No atomics: the drawn list equals its CPU twin
(`foliage::plan`) blade for blade, and a blade grows in and sinks out over a band of its cell's
probability, so a moving camera never pops one. A blade is a strip of `segments` (quadratic Bezier,
its lean plus the shared wind's at this tick and the last, rounded normals eased skywards with
distance, wider far away) drawn in the prepass (its sway's own motion under TAA), the world pass
(`Equal`, the forward chunks plus a back-lit Lambert lobe) and, on `high` and `ultra`, the nearest
cascade. It adds no binding to the forward stage (`tests/grass.rs`). `Quality::grass`
(`foliage::GrassQuality`, a resource knob): `medium` three in five blades to 32 m, `high` all to
44 m casting, `ultra` to 60 m, the high phones a third to 22 m from `high`, none on `low`, the low
phones or the legacy renderer. The ledger's `grass` buffers row holds its regions and order.

`foliage::scatter::scatter` (the facade's `Terrain::scatter` and `Scatter`) places instances on the
terrain's chosen layers at a loading point with the same global cell hashing: the same instances for
any area that covers them, cut by slope, leaned with the ground on request and capped evenly by a
hashed priority. The game draws them through an instance group.

## Colour grading

`Look::grading` (`post::grading`) grades inside the tonemap (node 21), with no pass of its own:
Bevy's sectional knobs (saturation, contrast, gamma, gain, lift for shadows, midtones and
highlights) on the white-balanced scene colour before the curve, contrast turning about middle
grey in log space as Filament's does, then an optional Adobe `.cube` LUT on the encoded display
colour before the dither (pmndrs/postprocessing's tetrahedral interpolation). The GPU holds each
LUT texel's change from the identity, so an identity LUT draws the ungraded picture byte for
byte; the upload is resampled to the class's side (`lut_side_max`: 65 desktops, 33 high phones,
25 mid, 16 low). `tests/grading.rs` holds the shader to its CPU twin.

## Depth of field and motion blur

The look's `depth_of_field` and `motion_blur` (`post::dof`, `post::motion_blur`) are switches a
game turns on; both are off by default (owner decision D10) and the preset only picks the tier
(`Quality::dof`, `Quality::motion_blur`). They run after TAA (nodes 17a and 17b) and before
`post-hdr`, so TAA's history never sees them and bloom and the exposure see the blurred scene, and
only on frames with the depth prepass (motion blur also needs its motion). Depth of field: Filament's
ring gather on desktop and web `high` and `ultra`, Godot's circular gather on `low`, `medium` and
phones. Motion blur: KinoMotion's reconstruction filter on desktop and web `high` and `ultra`,
Bevy's single pass on `low`, `medium` and phones, none on low-tier phones. Neither draws noise, so
a still camera draws the same picture every frame. A settled capture draws without them unless its
shot asks (`Renderer::set_capture_lens`, the Studio capture's `lens` argument). They take no
forward binding (`renderer/lens.rs` holds their targets).

## Sun cascades: the casters each one draws

`shadow::cull_to_receivers` (horde 10k) holds each cascade's cull view to the casters that can
shadow a receiver reading it, after `shadow::fit` places the cascade: a receiver reads cascade `c`
from any view depth up to `c`'s end (its own cascade, the blend band, PCSS's coarser cascade for a
wide penumbra), so its receivers lie in the camera frustum from the near plane to `c`'s end. A
caster outside that frustum's light-space polygon, widened by the widest lookup across the map
(PCSS's 16 texels and the bilinear one, or the filter's reach) and along the light by that reach
times the receiver-plane bias's slope cap (16), cannot shadow any of them and is culled; the near
plane stays open (pancaking). Seen along the light the frustum is a convex polygon of up to six
sides; `cascade_hull::sides` (lane FQ) fills the cull view's five side slots (the box's four and
the open near plane's) greedily from its edges and the box's sides, so a camera looking across the
light no longer draws the casters in the box's empty corners (the posts row with the sun beside the
camera: 1,266 casters where the box drew 1,961). The sides snap outward to 16-texel steps, so a
camera moving inside a step keeps the cull view (and the static shadow cache's key). The maps and
matrices are the fit's:
the pictures are bit for bit the same (`tests/shadow_cascades.rs`), exact for every receiver in
the frustum whose slope to the light is under the cap. It stands down under a far cadence (a held
map outlives its camera) and on frames with a Level-3 pass (`ExtensionDemand::level3`: it may read
the maps anywhere); `Renderer::set_shadow_receiver_cull(false)` turns it off.

A cascade's cost is its casters' triangles (lane FQ, Metal System Trace of 10,000 ghouls: the map's
size changes nothing, every caster at its coarsest level halves the four cascades). A sun cascade
casts each instance with levels at the coarsest mesh level whose world error is within
`shadow::caster_error_texels` of its own texels (PCSS: its narrowest kernel, 3 texels, and the
bilinear neighbour; the PCF kernels and the hardware tap their reach), never finer than the
camera's level (`GpuCullViews::shadow_lod`, `gx_cull_caster_level` and its CPU twin
`mesh::caster_level`). A silhouette's error inside the narrowest kernel the receivers read the
map through blurs into the filter's own; the near cascades' texels are too small for any level,
so contact shadows near the camera keep the camera's level, and the level is per cascade, not per
distance, so a moving camera never switches it. A skinned band's levels are skinned for the camera
alone (`mesh::LOD_PLANNED_TAG`): its casters keep the camera's band. At the 10k horde's peak the
far cascade's casters take level 1 (3.3 to 2.45 ms busy) and the picture holds (SSIM 0.9999 against
the camera-level casters, no pixel over 24 levels). A chain's casters' level (`casters` in
`genex_lods`, lane FR) gives the nearer cascades a step their texels can hide where the
half-triangle level's error is too large.

## Sun-shadow mask

On desktop `high` and `ultra` under TAA with PCSS (`post::sun_mask`, node 10a after the contact
shadows), the sun's soft-shadow visibility is made once per pixel from the prepass, accumulated
by its own temporal filter along the prepass's motion and filtered edge-aware (a port of the
FidelityFX Shadow Denoiser in fragment passes), then read by the forward pass instead of
evaluating PCSS inline, so soft shadow edges hold still on a still camera and on pans. It rides
binding 19 beside the contact shadow (r contact, g sun visibility, alpha 0 marks the mask), so it
takes no new binding. Transparent surfaces, frames without TAA and phones shade the sun inline. A
capture starts its history over and Live takes its own back afterwards.

## TAA upscaling

`post::taau` (renderer pass 2, B.8) is TAA at output size for frames drawn below it: a render-size
convert pass (dilated motion, the depth-key disocclusion, reactive coverage) and an output-size
upscale pass that weights the nearest jittered sample and its four neighbours by FSR2's Lanczos-2
and accumulates them into an `rgba16float` history at output size whose alpha carries the
accumulated sample weight (after Snapdragon GSR v2's two fragment passes, BSD-3-Clause, and FSR2,
MIT). The history is clipped to the full 3x3's colour box (the five taps' box left a diagonal
edge's history clipped to one side, a render-pixel staircase), and where the clip moves it (the
water's caustics and glints, which change every frame) the reconstruction leans to the fresh
pixel's wider kernel by as much (`taau::SHADING_CHANGE_GAIN`, as FSR2 lerps its kernel bias by its
reactive factor), so those samples land smooth instead of as render-pixel blocks (D22). Its
jitter cycle is `ceil(8 · (output / render)²)` phases (`taau::jitter_phases`) and its material mip
bias `log2(render / output) − 1` (`taau::texture_lod_bias`). Fragment only, so it fits WebGPU core.
`tests/taau.rs` holds it to native sharpness from 0.67 (still and a slow pan), to no trail behind a
moving object, to determinism and to its 4K cost (0.6 ms).

On the frame it is graph node 17 under `Quality::taau` (`high` and `ultra`): a TAA frame below scale 1
(`ScenePath::taau`) resolves into the upscale's output-size history (kept per history set in
`settle::TaaHistories`; a step below scale 1 hands TAA's last resolve over to it, whose alpha is the
depth key the convert's disocclusion test reads, so the step keeps the history; a step back to
scale 1 starts TAA over), the jitter
and mip bias follow `taau::frame_jitter` and `taau::frame_texture_lod_bias`, exposure, bloom and the
tonemap read the scene at output size (`Renderer::hdr_scene_size`), EASU does not run (nor RCAS, unless
a game asks for `TaaSharpen`) and a settled capture re-renders one cycle of its phases (within the wire's
16). A frame whose depth of field, motion blur or `post-hdr` passes read the scene at render size
keeps TAA at render size and EASU. At scale 1 nothing changes. `tests/frame_hooks.rs` holds 4K from
0.67 within 10% of native 4K's sharpness (TAA then EASU kept 0.89 of it).

## Output size and window present

A renderer is made at the game's logical `world_size` (`Renderer::logical_size`: the 2D layer's
coordinates and the default output) and draws at whatever output it is given
(`Renderer::set_output_size`; the scale, DRS, TAA, FSR1 and the ledger follow at the next frame).
Live frames draw at the window's letterbox in its own pixels (`letterbox::output_for_window`),
capped at the Live class's reference resolution's pixels, or, where Live upscales temporally to
the window, at four times its render budget (below); captures and goldens draw at the world size,
or at the size a capture asks for (`capture --size`).

Upscaling modes (`upscale`, lane UQ; owner's calls: on by default, Native only when the person or
the game asks). A Live frame renders its `UpscaleMode`'s share of the window a side: Native 1
(every pixel through TAA), Quality 0.6875 (22/32: the image rows dip at 21/32), Balanced 0.59375,
Performance 0.5. On a native desktop
the default is `upscale::calibrated_mode`: the best of Quality, Balanced and Performance whose
render pixels fit `calibrated_pixel_budget` (the class's reference pixels at its nominal scale,
2560x1440 on desktop high and ultra; Studio's measured score moves the class), never Native, held
to that budget past 5K (lane UP's render budget). Phones and browsers keep their class's own scale
until a mode is chosen. The facade multiplies every Live scale (the class's DRS steps, the nominal
scale, the budget fit) by the mode's share of the output (`upscale::output_scale`: the window's on
a TAAU desktop, more of a capped output elsewhere), so DRS moves below the mode (Quality at the
Mac's 3456x2169 full screen renders 2376x1491, its steps down to 0.53; `drs` learns how the frame's
cost follows the pixels from its step changes and climbs back when the next step fits, lane FQ,
and sheds a preset's features only for frames the lowest step cannot fit in the interval). With
dynamic resolution off the nominal step is the only one and nothing is shed. Where Live upscales
temporally to the window (`presets::upscales_to_native`: `high` and `ultra`) its output is the
window's own pixels up to four times `presets::render_pixel_budget`
(`presets::native_output_cap_px`; the floor is `RENDER_SCALE_MIN`). Screen effects hold their own pixel budget
(`presets::effect_budgeted`, `screen_effect_budget_px`: 1080p on a desktop, where ultra's AO
budget was measured): full-resolution AO runs at half resolution with the joint-bilateral upsample
past it, decided at the nominal step. SSR already traces at half the render size and bloom's chain
starts at most 540 rows; the shadow maps and cascades keep the preset's row, sized for the
reference render the budget holds. The web (its memory budget), phones and presets without TAAU
keep the reference cap. `tests/upscale_quality.rs` holds each mode's frames to native ones (SSIM,
shimmer, ghosting). Every shell (a window, the web
canvas, a phone, Studio's Live ring) shows the world target through `Resilient::present`, which
letterboxes it with `letterbox::present`: a texel-for-texel copy at its own size, FSR1 EASU + RCAS
into a larger letterbox (a window past the cap), a Catmull-Rom filter widened to the ratio into a
smaller one. `Renderer::present` and `present_to_texture` go the same way; nothing is stretched
nearest-texel. Live paints the HUD over the letterbox after that, at the window's pixels
(`genex::present::Presenter::present`); a capture paints it into the world target at its own
pixels per point (node 24). The ledger counts the window present's images (`BudgetInput::window`).

A game whose fit is `expand` (`letterbox::Fit`, `Renderer::set_fit`) fills the window instead:
Live draws at the window's own aspect (`letterbox::output_for`), the present covers the whole
window (`letterbox::present::present_view`), the 2D layer shows `Renderer::view_rect` (the world
grown on the output's long side, the world whole and centred on the letterbox's rectangle) and
the camera's aspect follows the output (the facade widens a tall output's field of view to keep
the world's width). Input and the HUD stay on the world's rectangle, and a capture at the world
size is the letterbox picture.

Each dynamic-resolution step draws into targets of its exact size (`target_pool`). On desktop a
step change keeps the targets it replaced, and those a step draws without (FSR1's at scale 1), as
spares in the ledger (`TargetPolicy::spares`, at most `SPARE_BYTES_MAX` together), so going back
to a step swaps them in instead of allocating and clearing them again; a spare idle for
`SPARE_IDLE_FRAMES` frames is released. Phones and the web keep no spares.

## glTF models

`src/mesh.rs` reads a GLB's triangles, `src/glb_material.rs` its materials, one part per
material. Each attribute is read only in a layout core glTF gives it (float positions, normals and
tangents; float or normalized 8/16-bit uvs and weights; 8/16-bit joints; unsigned indices); any
other layout, such as a `KHR_mesh_quantization` one the Studio's import step did not dequantize,
is refused `mesh-invalid` before the `gltf` reader would misread it or panic.

A normal-mapped primitive without TANGENT gets MikkTSpace tangents when it loads
(`bevy_mikktspace`, its sqrt and acos from libm so every target builds the same bits), split at
mirrored uv seams the way the Studio's import step splits them, and its part says so
(`GlbPart::runtime_tangents`, `tangents-runtime` in `__render.assetIssues`); any other primitive
without TANGENT keeps one vertex per POSITION, each with its first corner's tangent, so its
`genex_meshlets` and `genex_lods` still validate.

A part also carries its material's `KHR_materials_*` extensions (`GlbPart::material_ext`, from
`src/glb_material_ext.rs`): `ior`, `specular`, `clearcoat`, `sheen`, `transmission` (factor),
`volume` (factors) and `anisotropy`, read from the raw extension JSON with the specification's
defaults and clamped into range, textures named by their image on TEXCOORD_0. They are read, not
yet shaded: no GPU row carries them.

### The mesh arena: adding and removing meshes

The library (`MeshLibrary`) is the CPU mirror of the mesh arena (`src/mesh_arena.rs`): one GPU
buffer each for vertices, slots, indices, skin rows and the three meshlet tables. The library
places every mesh with a `RowAllocator` per stream (best fit over freed ranges, else the end; with
no removals meshes pack back to back in add order). An add writes only that mesh's rows. A full
stream is remade at twice its size, and the GPU copies the live prefix. No stream passes the
128 MiB storage binding (`buffer-too-large`). On WebGPU and phones, a growth that would hold more
than 256 MiB at once (old and new buffers) is refused `stream-arena-full`.

`Renderer::remove_mesh` removes a mesh and its levels of detail. Their rows go to the next mesh
that fits, and the slot is reused with its generation moved on. A skinned mesh and the built-in
cube and sphere are refused `mesh-invalid`. A `MeshId` carries its slot's generation, so the old id
names nothing: a draw of it is skipped and counted (`FrameStats::stale_rows`), never drawn as the
slot's new mesh. An id the library never handed out still refuses the frame. `Resilient` logs each
removal and drops an upload's data once all its meshes are removed. A replay then holds those
slots empty and frees them at the removal, so every id comes back the same.

### Compressed material textures

`src/texture_ktx2.rs` reads a KTX2 file in one fixed GPU format with the `ktx2` crate:
BC7, ASTC 4x4 or ETC2 RGBA8 (sRGB or linear), or RGBA8, one square power-of-two 2D image whose
levels are stored plain down to 1 x 1. A Basis Universal or supercompressed file is refused: the
Studio's export writes each family's levels plain, so the runtime carries no transcoder. Size-class
arrays made for a family (`ClassArrays::with_family`) take only that family's textures
(`add_compressed`); a chain is never resampled, so a larger texture drops its top levels into a
smaller class. The three compression features are renderer-owned (`floor::RENDERER_FEATURES`),
requested whenever the adapter offers them. A compressed layer takes a quarter of RGBA8's bytes.

Wired in: `Renderer::set_texture_family` (before the first texture; refused for a family the
device does not sample) stores the 512, 1024 and 2048 classes in that family, and class 0 (256)
stays RGBA8, so an image without a family file (a generated texture, a source the import step
could not encode) still loads there, at most 256 texels a side. `add_compressed_texture` places a
chain; an sRGB chain goes only to a colour slot and a linear one to a data slot. The facade picks
the family at the first frame naming a texture: the device's best (`compressed_families`: BC
first on a desktop, ASTC then ETC2 on a phone) that the game ships a `<stem>.<family>.ktx2` file
of, and loads that file in place of the image; a refused file falls back to the image. A device
loss replays the family before the textures. The budget still reserves the arrays as RGBA8.

### `genex_lods` in glTF

The Studio's import step simplifies a GLB of at least 512 triangles with meshoptimizer's
attribute-aware simplifier (normals and the first texture coordinates weighed; vertices where
primitives meet and every leaf card's vertices locked; each error at least how far the primitive's
vertices lie from the level). Each primitive's levels go in its `extras`, never as an extension:

```json
"extras": { "genex_lods": {
  "version": 1, "indices": 12,
  "levels": [ { "first": 0, "count": 1536, "error": 0.006 }, { "first": 1536, "count": 768, "error": 0.009 } ]
} }
```

`indices` is a bufferView of little-endian `u32` primitive vertex indices, level after level;
each level is whole triangles, no finer than the one before, with an object-space error never
smaller than the one before, at most four levels. `src/mesh_lod.rs` validates them (a typed
`LodFault` otherwise, and the mesh draws whole) and merges a part's primitives level by level
(`GlbPart::lods`: level k is every primitive's level k, its error the largest, scaled by each
node). `select_lod` picks the coarsest level whose error projects to at most a pixel threshold,
compared as `error * pixels_per_unit <= threshold_px * distance` so `gx_lod_select`
(`shaders/geometry/lod_select.wgsl`) picks the same level on every GPU.

`casters` (lane FR; absent for none, at most 1, never every level) counts the first levels only
shadow casters draw. The import step writes one when the chain has room and its half-triangle
level strays past 2% of the GLB's extent (a ghoul pose: 10.8 cm, thin flaps and spikes the
quadrics cannot see): a finer level simplified on positions alone, every vertex left past the
bound locked with its triangles and the level made again until none strays (a pose: 1,189 to
about 850 triangles at 2.8 to 3.0 cm). `LodChain::casters` carries it, the batches of its chain
are tagged `mesh::LOD_CASTERS_TAG`, and the camera's band (`mesh_lod::camera_band`,
`gx_cull_camera_band`) chooses among the mesh and the levels after it exactly as the chain without
it, crossfading from the mesh itself to level 2; a sun cascade's `caster_level` may cast it. A
skinned mesh drops it (its casters cast the camera's band).

A GLB without `genex_lods` (it skipped the import step) gets its chain at load:
`mesh_lod_runtime::add_runtime_chains` (game systems LOD-21), called by the facade's model load
(`genex::present`) and again by a device-loss replay. It uses the importer's parameters (half
the triangles a level, at most 0.1 of the mesh's extent, the chain's length the largest part's,
levels stop when one keeps more than 0.85 of the one before, vertices where parts meet locked,
each error at least how far the part's vertices lie from the level) with Genex's port of
meshoptimizer's simplifier, one run carried from level to level. All or nothing per model: a model
with an imported or authored chain, under 512 triangles, over `RUNTIME_LOD_MAX_TRIANGLES`
(100,000) or with geometry it cannot read is left whole (`RuntimeLodOutcome`). The result is a
pure function of the GLB (no hashing, no threads, IEEE `sqrt` only), so every destination builds
the same bits.

Drawn: `MeshLibrary::add_part` keeps each level as a mesh of its own (the vertices it uses), with
the part's bounding sphere. A frame plans a batch per level of a mesh drawn whole; each holds all
of the mesh's instance rows (`GpuBatch::first_row`) in slots of its own in the visible list
(`FramePlan::visible_slots`), and the cull keeps an instance only in the batch of the level picked
from the camera's distance at a 1-pixel threshold of the output height (`mesh_lod::lod_row_keep`,
`gx_cull_lod_fade`). Every view (cascades and spots too) draws an instance at the camera's level;
an orthographic camera turns levels off. A clustered mesh (the meshlet path) and a transparent
draw take the mesh itself.

The distance is measured from each opaque row's LOD row (`src/lod_rows.rs`, `GpuLodRow`, 32 bytes,
cull binding 6, parallel to the instance rows so the 160-byte row stays frozen): the row's own
sphere unless the draw names a model-space origin (`Scene::set_lod(DrawLod { origin, bias, .. })`),
so every part of a compound model measured from one sphere switches at the same distance; the
bias scales the chain's projected errors (2 holds each level twice as far). A retained group
computes its LOD rows once per version and uploads them over its instance rows' dirty ranges
(`Renderer::last_lod_row_upload_bytes`); the LOD table is replaced exactly when the instance
table is. With a fade band (`Scene::lod_band`, in (0, 1]; 0 by default, the hard switch) a plan
adds a fade twin of every level batch after all other batches (`FramePlan::fade_runs`, their
slot bases in `FramePlan::fade_slots`), the cull keeps an instance whose level's projected error
is within the band's last share of the threshold in the two neighbouring twins, and its scatter
writes each twin survivor's signed fade and grow into the per-slot fade table (cull binding 7,
`vec2<f32>` per visible-list slot, held only by a frame with fade batches;
`Renderer::read_view_fades`). The faded fragments read the fade at the forward frame's binding 31
and the sun casters' binding 11; the faded vertices read the grow at their own group 1, binding 2
(`PASS_FADE_GROWS_BINDING`), so no other pipeline's vertex stage counts the table (the meshlet
motion prepass holds all of core's eight).

The twins draw through faded pipelines (`renderer/variants.rs`: the `*_fade` entry points of
`forward.wgsl`, `prepass.wgsl` and `shadow.wgsl`, `GX_LOD_FADE`). The two levels of a crossfade
cover each pixel, or each MSAA sample, exactly once by a dither threshold (`gx_lod_fade_*` in
`common.wgsl`: interleaved gradient noise, turned each frame on TAA paths by the frame's base-2
radical inverse over eight frames, the shortest jitter cycle):
- MSAA covers samples with `sample_mask`, both levels in proportion, so a pixel shows no stipple;
- TAA and a one-sample path keep or drop whole pixels; any eight consecutive frames keep each
  pixel's incoming level in `floor(8 s)` or `ceil(8 s)` of them, so the resolve's average shows
  every pixel at its share and a settled crossfade steps from pixel to pixel no more than twice
  MSAA's (`tests/lod_fade.rs`);
- an `Equal` main pass and an alpha-tested batch's shading apply the cut their depth step or the
  prepass applied (coincident levels both pass the test); an alpha-tested batch keeps
  alpha-to-coverage and cuts whole pixels, never writing `sample_mask` beside it;
- the sun's and the shadowed spots' casters cut the other level's texels by the unturned
  threshold. The static shadow cache never holds a twin, a batch with levels or rows a far rule
  thins (their casting follows the camera): they are its overlay, and the twins cast through the
  faded casters over a cached layer's copy as a full draw casts them (`tests/shadow_cache.rs`:
  a fading forest's cached frames equal uncached ones byte for byte).
`tests/lod_fade.rs` holds the incoming share within 1/16 with no hole on every path. The band
stays 0 by default until LOD-06 (the band in `Quality`) lands; the first fade-in still waits for
the faded pipelines' compile (the Live fallback to whole levels is open).

Far field (`lod_rows::far_field`, `gx_far_field` in `shaders/cull.wgsl`): a draw naming a far
rule (`DrawLod::far_rule`, 1 + its index in `Scene::far_rules`, at most `FAR_RULES_MAX`; cull
binding 8) thins past the rule's start, stateless. A copy's hash (its sphere's centre on a 1 cm
grid, so any row order keeps the same copies) against a keep threshold falling smoothly to an
expected share of `keep` at `end`, then to none over `fade_out`, gives the share of its pixels
drawn, and survivors grow about their origin by `min(1 / sqrt(share kept), 2)`, so the drawn
cover holds. A thinned copy draws only through its mesh's fade twins (a mesh with a far-ruled row
gets twins with or without a band), its fade times the far share and its grow applied by the
faded vertex stages (`GX_LOD_GROW`); every whole batch drops it. The motion vectors use this
frame's grow for both positions (under a tenth of a pixel a frame at 30 m/s;
`tests/far_field.rs`). The GPU keeps the CPU twin's copies; its shares and grows may differ by
about 1e-6 (WGSL's square roots and quotients).

Impostors (`src/impostor/`, a port of kansei's, MIT): a species is baked from a model's parts
(`Renderer::bake_impostor`) into three RGBA8 atlas arrays of N x N orthographic frames on an
octahedral or hemi-octahedral grid (base colour and coverage; normal, depth and roughness;
occlusion, metallic, transmission and class), sized per class (`ImpostorClass`). Placed with
`Renderer::set_impostors` (`ImpostorInstance`: a model matrix, the species' row and a fade), each
draws after the terrain and its grass as a camera-facing quad over its bounds
(`shaders/impostor/draw.wgsl`): the three frames nearest the view direction, each reprojected
along the view ray to its stored depth in three parallax steps (off on the phone sizes), their
surface blended by sharpened weights and their coverage by the plain ones (cut at 0.35), lit
through the forward chunks like a built-in surface. The prepass gets its depth and normal and,
on motion frames, the reconstructed surface point's motion (the quad turning to face the camera
is not motion). On desktop high and ultra (`impostor::draw::writes_depth`) the fragments write
the reconstructed surface's depth (`frag_depth`); below, the quad's flat depth keeps early depth
testing for tile GPUs. A fade cuts whole pixels with the meshes' dither. The forward frame group
holds all of WebGPU core's 16 sampled textures, so the impostor pipelines bind group 0 without its
eight material arrays (`renderer::impostor_frame_layout_entries`) and group 2 their own (species
rows, instances, atlases). `tests/impostor_draw.rs` holds a cube's impostor to its mesh:
silhouette IoU at least 0.95 at the switch, mean luminance within TAA's 0.04 accumulation floor
under the sun, the sky and fog, and motion within a tenth of a pixel of the mesh's on a pan.

An impostor is also the last level of its mesh's chain in the cull (game systems LOD-15):
`MeshLibrary::set_impostor` (or `Renderer::set_impostor`) ends a chain with an impostor level
(`MeshImpostor::lead(species, error)` on the part that draws the quad, `MeshImpostor::part(error)`
on a compound's other parts), and the chain keeps at most three mesh levels
(`mesh::LOD_IMPOSTOR_MESH_LEVELS`). The impostor level's error (`mesh::impostor_level_error`: one
atlas texel a pixel, never below the last mesh level) is measured over the LOD row's radius, not
the part's, so every part of a compound drawn with one LOD sphere switches to it at the same
distance and each copy is drawn as meshes or as the impostor (or crossfades between them in the
band), never both. The lead part's impostor batch draws no mesh indices; its camera survivors
are listed in `FramePlan::impostor_batches`. Shadows take option A: in every view but the camera
a band at the impostor level reads as the last mesh level whole (`cpu_cull_view` with `caster`,
`gx_cull_lod_fade`'s `caster`), so the casters keep the mesh's shape across the switch
(`tests/impostor.rs`: zero shadow pixels change on a dolly through the band). Each frame the
impostor draw draws the placed impostors and the camera's survivors of the impostor batches
(`FramePlan::impostor_instances`: the cull's CPU twin over those batches only, equal to the GPU
cull slot for slot), a crossfading copy with its fade twin's signed share.

### `genex_textures` in glTF

The Studio's import step writes the images a GLB carries inside it out as compressed textures, the
way it encodes a loose PNG or JPEG. Each embedded PNG or JPEG a material samples is encoded once
per usage its slots give it (base colour and emissive are `color`, a normal map is `normal`,
metallic-roughness and occlusion are `data`), to one fixed-format KTX2 per texture family the
game's destinations may pick, beside the GLB as `<stem>.<family>.ktx2`. The GLB names them in its
`asset.extras`, never as an extension:

```json
"asset": { "version": "2.0", "extras": { "genex_textures": {
  "v": 1,
  "images": [ { "image": 0, "kind": "color", "stem": "crate.t0" },
              { "image": 2, "kind": "data", "stem": "crate.t2" } ]
} } }
```

`image` is a glTF image index and `kind` the usage it was encoded for, so its family files are
sRGB for `color` and linear otherwise. `stem` is a file name in the GLB's own folder:
`<model>.t<image>`, or `<model>.t<image>.<kind>` for an image sampled in more than one usage. Two
images with the same bytes and usage share one stem. A block is malformed as a whole when its `v`
is not 1, an `image` is out of range, a `kind` is unknown, a `stem` holds a `/`, a `\` or a NUL,
starts with a dot or passes 200 characters, or an image and kind appear twice; a reader then takes
the embedded images, as it does for a GLB without the block. The embedded image always stays in the
GLB as that fallback. An image the step cannot encode (a file beside the GLB, a WebP, a KTX2, a
damaged one) has no row. The runtime reads the block (`GlbModel::sidecars`, checked as above; a
malformed block loads the embedded images with a log line and never refuses the model). The
facade's presenter uploads an image from `<stem>.<family>.ktx2` in the renderer's family and
decodes the embedded image only when the block names no row for that image and usage, the game
ships no file in that family, the file is under the family's smallest size class or the renderer
refuses it (then named `texture-family-refused`). The family is chosen from the first textured
frame's loose textures and its models' sidecars together.

## Extension layouts

Level-2 materials and post passes declare `[[wgsl]] api = 1 | 2`. API 2 reads the v2 group map
of `src/abi.rs` (`MATERIAL_V2_BINDINGS`, `POST_V2_BINDINGS`): the frame (`GxFrameV2`), depth,
normals, motion, the environment and the HDR scene; group 2 is the game's. A v2 material's group
1 is the frame's read-only `gx_draws` table, and the draws of one (material, mesh) pair are one
instanced call; a fragment reading `gx_draw` is handed its instance's row (`@location(6)`) and
opens by copying it (`extension::opened_draw_row`), so `gx_draw` reads as before. API 1 keeps
loading unchanged. Level-3 passes register at stage ids (`before-cull`, `after-prepass`, `after-opaque`,
`after-transparent`, `post-hdr`, `post`) that never change once shipped.

## Instance occlusion (horde 10k)

The instance path culls by occlusion on its own (`src/occlusion.rs`, `renderer/instance_occlusion.rs`,
the phases of `shaders/cull.wgsl`), with no switch to turn on: a frame of at least
`INSTANCE_OCCLUSION_MIN_ROWS` (1024) opaque rows on the GPU-driven path occludes.

- **Camera** (one pass, exact): the prepass draws every copy in the frustum, a Hi-Z of its depth
  is built (`instance hi-z`), and the camera's lists are culled again against it (phase
  `Final`) before the world pass, the screen effects and TAA's reactive pass read them. It needs
  the prepass and a one-sample world pass.
- **Sun cascades** (two passes): the cull's first phase keeps, in an occluded cascade, the casters
  it saw last frame; the cascade draws them, its Hi-Z is built (`shadow hi-z`, shared by the
  cascades in turn), phase `Second` re-tests every caster, writes the next history and keeps the
  visible ones the first phase left, and a second depth pass draws them. Only Live frames, and
  only a cascade drawn whole this frame (not held by its cadence, not drawn from the static shadow
  cache), occlude; spot shadows do not. With a low sun a crowd's front ranks hide the rest from the
  sun as from the camera.
- **History:** one word per (view, row) in three slots (Live's pair and a spare), after each row's
  last-frame row found through its identity (the draw id, else the mesh and ordinal, as motion
  vectors match rows), so a copy that changes mesh keeps its history. A row without a match draws
  in the first phase.
- **Exactness:** each Hi-Z texel holds the farthest depth drawn so far, so a copy it hides would
  have lost every depth test: the pictures and the maps are the ones without occlusion, bit for bit
  (`tests/instance_occlusion.rs`). The history only decides what draws first.
- **When it pays:** each Hi-Z phase counts the rows it tested and those it found visible; the
  counts come back a frame or two later, and a view whose Hi-Z hid under a fifth of what it tested
  (`OCCLUSION_PAYS_MIN`: an open field, a crowd seen from above) sits out for 240 frames, then
  measures again. A walled scene, a city block or a forest behind a hill keeps it.
- `Renderer::set_instance_occlusion(InstanceOcclusion::Off)` draws every copy in a frustum
  (tests and cost rows compare against it). The cull's storage buffers are 8 of WebGPU core's 8.

## Meshlets and Hi-Z occlusion (R2)

Meshes with at least `Meshlets::min_triangles` triangles (2048 by default) draw as meshlets
where the quality has `meshlets` on; the rest draw whole. A meshlet holds at most 64 vertices
and 124 triangles (`src/meshlet.rs`).

No preset turns meshlets or occlusion on (`presets::GEOMETRY_PATH_DEFAULT`): on the M4 Max they
measured slower than the instance path on every typical scene (R2 review, `meshlet-paths` record:
meshlets +26% to +51% GPU p50 at desktop-high 1080p, occlusion +49% to +55%, and about twice the
time on the mobile-high proxy), and no immediate-mode GPU has shown a gain. A game opts in per
class with the `meshlets` and `occlusion` switches. The library clusters lazily: the first quality
that draws meshlets clusters it, and it stays clustered, so a renderer on the instance path holds
no meshlet tables. When frames stop drawing meshlets, the GPU tables, the cull's working buffers
and the Hi-Z are given back (`Renderer::meshlet_bytes` is 0), and they count in
`FrameRenderer::held_bytes` while they are up.

Occlusion runs only over a one-sample world pass (`presets::occlusion_runs_with`): the Hi-Z is
built from the single-sample prepass at pixel centres, so over MSAA it would cull a meshlet that
is seen only through an edge pixel's uncovered samples. Every preset draws MSAA 4x until TAA
lands, so today occlusion runs only where anti-aliasing is off. With one sample, the meshlet path
draws the instance path's picture to the bit. Under MSAA, meshlets alone draw it too in every
recorded scene, but two draws that tie on an edge may resolve in another order.

Library buffers (`MeshletLibrary`), uploaded as read-only storage:

| buffer | element | meaning |
| --- | --- | --- |
| meshlets | `Meshlet`, 48 bytes | bounds sphere (xyz centre, w radius), normal cone (xyz axis, w cutoff; 1 means no cone), vertex offset, triangle offset, vertex count, triangle count |
| meshlet vertices | `u32` | the library vertex id of each meshlet vertex (mesh-local ids rebased by the mesh's base vertex) |
| triangles | `u32` | three meshlet-local vertex indices, one byte each, low byte first; the top byte is 0 |

A meshlet's ranges tile both buffers in order. The cone test is meshoptimizer's: a meshlet
faces wholly away from a viewer at `p` when
`dot(centre - p, axis) >= cutoff * |centre - p| + radius`.

Per frame (`src/meshlet_cull.rs`):

- **Candidates** are (instance, meshlet) pairs in `MeshletInstance` order; candidate `c` owns
  bit `c` of the visibility bitset.
- **Two-pass occlusion:** pass 1 draws what last frame's bitset marks and the Hi-Z is built
  from that depth. Pass 2 re-tests every candidate (instance sphere, then meshlet sphere and cone
  against the frustum and the new Hi-Z) and draws those that pass and were not drawn in pass 1.
  Its result is the next frame's bitset. History is only a hint: a wrong bit costs time, never a
  missing object.
- **History:** three bitsets, two live ones (ping-pong) and one that settled captures write,
  so a capture never reads, moves or resets the live history, whatever quality it draws. Live's
  history is keyed on the candidates' layout (each row's meshlet range and first candidate), not
  on global instance indices, so one more cube drawn before the clustered meshes keeps it. A
  reset (a new candidate layout, a Live frame without occlusion, a camera cut,
  `Renderer::reset_meshlet_history`, every capture re-render) makes pass 1 draw nothing and pass
  2 draw every candidate in view, so a capture holds no visibility history.
- **Compaction:** a three-dispatch scan (keep counts per 256-item block, an exclusive scan of the
  block sums, an ordered scatter). It uses no atomics and no inter-workgroup waits, so the draw
  order is the candidate order on every run.
- **Draws:** each view gets a compacted `u32` index buffer and one `draw_indexed_indirect`. An
  index is `slot << 6 | local`: the drawn slot (`DrawnMeshlet`: instance row, meshlet row) and
  the meshlet-local vertex. The vertex shader pulls the vertex from the library through the
  meshlet vertex buffer. The group is `layout::MESHLET_DRAW_BINDINGS` in group 2, after the
  forward frame group (0) and the pass view (1). WebGPU counts every storage binding a stage can
  see in the pipeline layout, read or not: the vertex stage sees 7 (the frame group's 3 and the
  meshlet group's 4; core allows 8), so one vertex-stage table is left. The meshlet group stays
  vertex-only: the fragment stage already sees 6 of the frame group's tables.
- **Shadow views** test the frustum and the cone only.
- **Fallback:** each view's index region is sized on the CPU from the instances its frustum
  holds. A view whose region does not fit one storage binding draws its batches the instance
  way (shadow cascades fall back first, then the camera), so a frame never fails over it.

**Hi-Z** (`src/hiz.rs`): an `r32float` chain from half the render size down to 1 × 1. Mip 0 is
read from depth by `textureLoad` in compute; each later mip reads the previous one as a sampled
texture and writes an `r32float` write-only storage view. Each texel keeps
the farthest depth it covers: the maximum under standard Z, the minimum under reverse-Z.

### `genex_meshlets` in glTF

The importer may store a primitive's meshlets in the primitive's `extras`, never as an
extension and never in `extensionsRequired`, so any glTF reader still draws the primitive:

```json
"extras": { "genex_meshlets": {
  "version": 1, "max_vertices": 64, "max_triangles": 124,
  "meshlets": 7, "vertices": 8, "triangles": 9
} }
```

`meshlets`, `vertices` and `triangles` are bufferView indices, not accessors: glTF reserves
`UNSIGNED_INT` accessors for indices. The views are little-endian. `meshlets` holds the 48-byte
records above, with offsets relative to this primitive's own `vertices` and `triangles`.
`vertices` holds one `u32` primitive vertex index per meshlet vertex, and `triangles` one packed
`u32` per triangle.

At load the set goes through `meshlet::validate`: limits, ranges that tile, indices in range,
and every primitive triangle exactly once with its winding kept. A set that fails is dropped with
a typed `MeshletFault`, and the mesh is clustered at runtime instead. An unknown `version` is
ignored the same way. The faults travel with the part (`GlbPart::meshlet_warnings`), and the
facade's model load logs each one by its wire spelling.

A loaded model keeps each part's merged set (`GlbPart::meshlets`: one part per material, `None`
when any of its primitives had none or was refused) and hands it to the renderer with the part
(`Renderer::add_meshes_with_meshlets`; the facade's `Uploads::add_meshes_with_meshlets`). The
device-loss `Resilient` keeps the sets with the upload and the game's `Meshlets` setting
(`Resilient::set_meshlets`), and a recovered renderer takes the setting before it replays them. A
model or texture from the game's compiled asset table is kept as its source instead
(`Resilient::add_meshes_from`, `add_texture_from`; the facade's `ModelSource::static_bytes`): a
replay decodes it again (`GlbModel::parts_from_glb`, `image_from_glb`), so a phone or the web does
not hold the decoded copy beside the GPU's (`Resilient::kept_bytes` counts what is still kept).
