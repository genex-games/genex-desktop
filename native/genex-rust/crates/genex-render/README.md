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
| 5 | cull (instances; meshlets pass 1 with R2) | compute |
| 6 | shadows | pass |
| 7 | depth/normal prepass | pass |
| 8 | occlusion: Hi-Z build, meshlet cull pass 2, prepass part 2 | compute + pass |
| 9 | Level-3 `after-prepass` | pass |
| 10, 10a | ambient occlusion; contact shadows, then the sun-shadow mask (`post::sun_mask`) | pass |
| 11 | environment: sky LUTs and aerial perspective, IBL bake, irradiance-volume bakes, reflection-probe captures, froxel fog | compute + pass |
| 12-15 | opaque, sky, Level-2 materials and `after-opaque`, transparent | in the world pass |
| 15a, 16, 17 | Level-3 in-world passes' own motion, reactive mask, MSAA resolve, TAA | pass |
| 17a, 17b | the look's depth of field and motion blur (`post::dof`, `post::motion_blur`; off by default, on frames with the depth prepass, never on a settled capture unless the shot asks) | pass / compute |
| 18-21 | `post-hdr`, bloom, exposure, tonemap | pass / compute |
| 22-25 | upscale, 2D and `ldr` post, HUD (captures), timestamps | pass / queue |

The HDR path draws camera views reverse-Z (`Greater`, cleared to 0) on `Depth32Float`; the
legacy path keeps standard Z. `GxFrameV2` and `GxPostV2` expose `depth_reversed`.

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
bake's targets.

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
copy of a multisampled world pass. No consumer asks in this build, so no frame records them yet;
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
  texel (`prepass normal roughness`), for the prepass to write on SSR presets.
- Binding 30 of the forward frame group (`FRAME_REFLECTIONS_BINDING`) is reserved for the screen
  reflections (rgb, a confidence): the stage's 16th sampled texture of 16 once B.9 binds it.

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
## Output size and window present

A renderer is made at the game's logical `world_size` (`Renderer::logical_size`: the 2D layer's
coordinates and the default output) and draws at whatever output it is given
(`Renderer::set_output_size`; the scale, DRS, TAA, FSR1 and the ledger follow at the next frame).
Live frames draw at the window's letterbox in its own pixels, capped at the Live class's
reference resolution's pixels (`letterbox::output_for_window`); captures and goldens draw at the
world size, or at the size a capture asks for (`capture --size`). Every shell (a window, the web
canvas, a phone, Studio's Live ring) shows the world target through `Resilient::present`, which
letterboxes it with `letterbox::present`: a texel-for-texel copy at its own size, FSR1 EASU + RCAS
into a larger letterbox (a window past the cap), a Catmull-Rom filter widened to the ratio into a
smaller one. `Renderer::present` and `present_to_texture` go the same way; nothing is stretched
nearest-texel. Live paints the HUD over the letterbox after that, at the window's pixels
(`genex::present::Presenter::present`); a capture paints it into the world target at its own
pixels per point (node 24). The ledger counts the window present's images (`BudgetInput::window`).

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

A part also carries its material's `KHR_materials_*` extensions (`GlbPart::material_ext`, from
`src/glb_material_ext.rs`): `ior`, `specular`, `clearcoat`, `sheen`, `transmission` (factor),
`volume` (factors) and `anisotropy`, read from the raw extension JSON with the specification's
defaults and clamped into range, textures named by their image on TEXCOORD_0. They are read, not
yet shaded: no GPU row carries them.

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

The Studio's import step simplifies a GLB of at least 512 triangles with meshoptimizer and stores
each primitive's levels in its `extras`, never as an extension:

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

Drawn: `MeshLibrary::add_part` keeps each level as a mesh of its own (the vertices it uses), with
the part's bounding sphere. A frame plans a batch per level of a mesh drawn whole; each holds all
of the mesh's instance rows (`GpuBatch::first_row`) in slots of its own in the visible list
(`FramePlan::visible_slots`), and the cull keeps an instance only in the batch of the level picked
from the camera's distance to its sphere at a 1-pixel threshold of the output height
(`mesh_lod::lod_keeps`, `gx_cull_lod_keeps`). Every view (cascades and spots too) draws an
instance at the camera's level; an orthographic camera turns levels off. A clustered mesh (the
meshlet path) and a transparent draw take the mesh itself. Level changes are not crossfaded yet.

## Extension layouts

Level-2 materials and post passes declare `[[wgsl]] api = 1 | 2`. API 2 reads the v2 group map
of `src/abi.rs` (`MATERIAL_V2_BINDINGS`, `POST_V2_BINDINGS`): the frame (`GxFrameV2`), depth,
normals, motion, the environment and the HDR scene; group 2 is the game's. A v2 material's group
1 is the frame's read-only `gx_draws` table, and the draws of one (material, mesh) pair are one
instanced call; a fragment reading `gx_draw` is handed its instance's row (`@location(6)`) and
opens by copying it (`extension::opened_draw_row`), so `gx_draw` reads as before. API 1 keeps
loading unchanged. Level-3 passes register at stage ids (`before-cull`, `after-prepass`, `after-opaque`,
`after-transparent`, `post-hdr`, `post`) that never change once shipped.

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
