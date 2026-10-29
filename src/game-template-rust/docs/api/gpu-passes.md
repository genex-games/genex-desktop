# Custom GPU passes

Every type and call in one line:

```rust
use genex::gpu::{GpuError, GpuPass, GpuPassCtx, PassSetup, PassStage, RenderInputs}; // and the wgpu types a pass names
game.gpu_pass("outline", PassStage::PostHdr, Outline::default());
// PassStage::BeforeCull | AfterPrepass | AfterOpaque | AfterTransparent | PostHdr | Post
impl GpuPass<World> for Outline {
    fn rebuild(&mut self, setup: &mut PassSetup<'_>) -> Result<(), GpuError> { Ok(()) }
    fn run(&mut self, ctx: &mut GpuPassCtx<'_, '_, World>) {}
    fn api(&self) -> u32 { 2 }
    fn inputs(&self) -> RenderInputs { RenderInputs::DEPTH | RenderInputs::NORMALS } // MOTION, ENVIRONMENT, HDR_SCENE
}
setup.create_shader(label, wgsl)?; setup.world_format(); setup.tables_layout(); setup.environment_layout(); // Option
setup.world_depth(write); setup.world_multisample(); setup.motion_target(); setup.reactive_target();
setup.temporal_depth(write); setup.temporal_multisample(); // and create_buffer, create_texture, create_render_pipeline ..
ctx.sim(); ctx.tick(); ctx.prev_tick(); ctx.depth_reversed(); ctx.tables(); ctx.environment(); // &Sim<World> read-only
ctx.encoder(); ctx.draws(); ctx.motion_draws(); ctx.reactive_draws(); // -> Option<&mut ..>, by stage
ctx.prepass_depth(); ctx.prepass_normals(); ctx.prepass_motion(); ctx.world_texture(); // -> Option<&..>
```

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
shadows). The tables carry the fog row
(`gx_frame.fog_color`, `gx_frame.fog_params`) and the environment cube (`gx_env_specular`) but no
fog function, so such a pass repeats the height fog with the cube read just above the horizon as
its in-scatter (the air's aerial perspective does not reach it) and
lights a ground lantern with a soft additive disc of its own. Every resource counts against the GPU caps, WGSL is checked against WebGPU core
plus `[gpu] native_features`, no buffer is mappable, and a pass wgpu rejects stops running with
`gpu-pass-invalid` (listed with its code in `state().volatile.customPasses`). In-world draws are
checked as they are recorded (slices, usages, offsets, index and indirect ranges); on the web, where
wgpu answers a frame later, a frame whose in-world draws reach further than one already accepted
(more vertices or instances, a smaller vertex slice, another pipeline) leaves that pass out until
its own answer comes. Each pass counts one
draw under the `custom` tag; native captures and Live show its output, and the web build runs
them in the browser's WebGPU too (`PostHdr` included), so a web capture shows them.
