//! RQ3.2: the sun chunk's shadow filters (shaders/lighting/sun.wgsl). The GPU rows (`#[ignore]`d,
//! every name contains `metal`) compile the forward shader the renderer draws with
//! ([`genex_render::shaders::FORWARD`]) with a compute probe appended, so the chunk under test is
//! the text the forward pass and the Level-2 v2 prelude are built from:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked --test shadow_filter -- --ignored metal
//!
//! The scene is analytic: an 8 m pole (a 1 m square box) on a ground plane under a sun 45 degrees
//! up, written into each cascade's depth layer by a ray cast per shadow texel, so the map holds
//! exactly the scene's depths and nothing of the renderer's caster path. Goldens live in
//! `tests/fixtures/render-goldens/shadows-filter/<name>.bgra` (raw BGRA, top row first, 128x128:
//! the chunk's visibility on the ground around the pole, seen from above; not a renderer frame);
//! `GENEX_RENDER_GOLDEN_UPDATE=1` rewrites them instead. `GENEX_RENDER_EVIDENCE_DIR` also writes
//! each picture there; `GENEX_PERF_OUT` receives the cost rows as JSON.

use std::path::{Path, PathBuf};
use std::sync::{PoisonError, RwLock, RwLockReadGuard, RwLockWriteGuard};

use genex_render::capture::Capture;
use genex_render::layout::{GpuFrame, MAX_CASCADES};
use genex_render::scene::{CameraDesc, Material, MeshId, Scene, scaled};
use genex_render::settings::{ShadowFilter, SkyParams};
use genex_render::{CullPath, Environment, Gpu, Quality, Renderer};
use glam::{Mat4, Vec3};

/// Each cascade's side in texels in the filter rows (today's map size).
const MAP_PX: u32 = 1024;
/// How far beyond a cascade's box towards the sun its light frustum starts (casters' reach).
const REACH: f32 = 30.0;
/// The comparison's constant depth bias (the renderer's `shadow::DEPTH_BIAS`).
const BIAS: f32 = 0.0015;
/// Normal offset in texels (the renderer's).
const NORMAL_OFFSET_TEXELS: f32 = 1.5;
/// The sun's angular radius in the PCSS rows, degrees: a soft sun, so penumbrae span many texels.
const SUN_RADIUS_DEG: f32 = 2.0;
/// The camera looks straight down from 10 m, so every ground point is at view depth 10.
const CAMERA: [f32; 3] = [0.0, 10.0, 0.0];
const GROUND_DEPTH: f32 = 10.0;
/// The pole's half width (it stands on x, z in -0.5..0.5; its shadow's edge is the line x = 0.5).
const POLE_HALF: f32 = 0.5;
/// Sample spacing across the shadow's edge, metres.
const STEP: f32 = 0.002;
/// The two cascades of the filter rows: centre and half extent (cascade 0 one texel is 1.6 cm,
/// cascade 1 one texel is 3.9 cm).
const NEAR_CASCADE: ([f32; 3], f32) = ([0.0, 0.0, -3.0], 8.0);
const FAR_CASCADE: ([f32; 3], f32) = ([0.0, 0.0, -3.0], 20.0);
/// Cascade ends that put the ground (view depth 10) in cascade 0, or in cascade 1.
const IN_NEAR: [f32; 4] = [100.0, 200.0, 0.0, 0.0];
const IN_FAR: [f32; 4] = [5.0, 200.0, 0.0, 0.0];
/// The golden pictures' side, pixels, and the ground square they show (x, z from the corner).
const GOLDEN_SIDE: u32 = 128;
const GOLDEN_ORIGIN: [f32; 2] = [-4.0, -8.0];
const GOLDEN_EXTENT: f32 = 8.0;
const GOLDEN_CHANNEL_TOLERANCE: u8 = 2;
/// Pixels a golden may miss by more than the tolerance (1 %).
const GOLDEN_OUTLIER_PIXELS: usize = 164;
/// The plan's budget for 4-cascade PCSS 16/32 at 1080p, GPU ms (the filter's share is measured here).
const PCSS_BUDGET_MS: f64 = 1.5;
/// Timed dispatches per cost row, after `COST_WARMUP` untimed ones (the GPU's clocks ramp up).
const COST_RUNS: usize = 60;
const COST_WARMUP: usize = 8;

// ---------------------------------------------------------------------------------------------
// GPU harness

/// The harness runs rows on parallel threads: every GPU row shares this lock and the cost row
/// takes it alone, so its timed dispatches never share the GPU with another row's work.
static GPU_TURN: RwLock<()> = RwLock::new(());

fn gpu_shared() -> RwLockReadGuard<'static, ()> {
    GPU_TURN.read().unwrap_or_else(PoisonError::into_inner)
}

fn gpu_alone() -> RwLockWriteGuard<'static, ()> {
    GPU_TURN.write().unwrap_or_else(PoisonError::into_inner)
}

fn gpu_with(features: wgpu::Features) -> Option<Gpu> {
    let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
    match Gpu::headless_with(features) {
        Ok(gpu) => {
            if require {
                assert_eq!(gpu.receipt().backend, "metal", "GENEX_REQUIRE_METAL=1 but the adapter is not Metal");
            }
            Some(gpu)
        }
        Err(error) if require && features.is_empty() => panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}"),
        Err(error) => {
            eprintln!("skipped: no adapter with {features:?} ({error})");
            None
        }
    }
}

fn gpu() -> Option<Gpu> {
    gpu_with(wgpu::Features::empty())
}

fn buffer_with(gpu: &Gpu, label: &str, usage: wgpu::BufferUsages, bytes: &[u8]) -> wgpu::Buffer {
    use wgpu::util::DeviceExt;
    gpu.device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some(label), contents: bytes, usage })
}

/// The bytes of `buffer` (`bytes` long), mapped after the queue is idle.
fn read_buffer(gpu: &Gpu, buffer: &wgpu::Buffer, bytes: u64) -> Vec<u8> {
    let staging = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("shadow probe readback"),
        size: bytes,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("shadow probe readback") });
    encoder.copy_buffer_to_buffer(buffer, 0, &staging, 0, bytes);
    gpu.queue.submit([encoder.finish()]);
    staging.slice(..).map_async(wgpu::MapMode::Read, |result| result.expect("mapped"));
    let _ = gpu.device.poll(wgpu::PollType::wait_indefinitely());
    let data = staging.slice(..).get_mapped_range().expect("mapped range").to_vec();
    staging.unmap();
    data
}

/// The sun's unit direction (towards it): 45 degrees up, from +z, so the pole's shadow runs to -z.
fn sun() -> Vec3 {
    Vec3::new(0.0, 1.0, 1.0).normalize()
}

/// One cascade's orthographic light view-projection around `center`, `half` metres each side,
/// with the renderer's conventions (right-handed look-at, D3D depth 0..1, near plane `REACH`
/// beyond the box towards the sun).
fn light_view_proj(center: Vec3, half: f32) -> Mat4 {
    let sun = sun();
    let eye = center + sun * (half + REACH);
    let view = glam::camera::rh::view::look_at_mat4(eye, center, Vec3::Y);
    let proj = glam::camera::rh::proj::directx::orthographic(-half, half, -half, half, 0.0, 2.0 * half + REACH);
    proj * view
}

/// The analytic shadow map: each texel's nearest hit of the pole or the ground along the light.
const CASTER_WGSL: &str = r"
struct Caster {
    inverse: mat4x4<f32>,
    size: vec4<f32>,
}
@group(0) @binding(0) var<uniform> caster: Caster;

const POLE_HALF: f32 = 0.5;
const POLE_HEIGHT: f32 = 8.0;

@vertex
fn vs_caster(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
    let corner = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
    return vec4<f32>(corner * 2.0 - 1.0, 0.0, 1.0);
}

fn away_from_zero(v: f32) -> f32 {
    if abs(v) < 1e-9 {
        return 1e-9;
    }
    return v;
}

struct CasterOut {
    @builtin(frag_depth) depth: f32,
}

@fragment
fn fs_caster(@builtin(position) p: vec4<f32>) -> CasterOut {
    let ndc = vec2<f32>(p.x / caster.size.x * 2.0 - 1.0, 1.0 - p.y / caster.size.y * 2.0);
    let a = caster.inverse * vec4<f32>(ndc, 0.0, 1.0);
    let b = caster.inverse * vec4<f32>(ndc, 1.0, 1.0);
    let origin = a.xyz / a.w;
    let d = b.xyz / b.w - origin;
    var t = 1.0;
    if d.y < 0.0 {
        t = min(t, clamp(-origin.y / d.y, 0.0, 1.0));
    }
    let inv = vec3<f32>(1.0 / away_from_zero(d.x), 1.0 / away_from_zero(d.y), 1.0 / away_from_zero(d.z));
    let t0 = (vec3<f32>(-POLE_HALF, 0.0, -POLE_HALF) - origin) * inv;
    let t1 = (vec3<f32>(POLE_HALF, POLE_HEIGHT, POLE_HALF) - origin) * inv;
    let lo = min(t0, t1);
    let hi = max(t0, t1);
    let enter = max(max(lo.x, lo.y), lo.z);
    let leave = min(min(hi.x, hi.y), hi.z);
    if leave >= max(enter, 0.0) && enter <= 1.0 {
        t = min(t, max(enter, 0.0));
    }
    var out: CasterOut;
    out.depth = t;
    return out;
}
";

/// The cascades' depth array of the analytic scene and the renderer's comparison sampler.
struct ShadowMap {
    _texture: wgpu::Texture,
    array: wgpu::TextureView,
    sampler: wgpu::Sampler,
    matrices: Vec<Mat4>,
    texel_world: Vec<f32>,
}

fn shadow_map(gpu: &Gpu, cascades: &[([f32; 3], f32)], px: u32) -> ShadowMap {
    let layers = cascades.len() as u32;
    let texture = gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("analytic shadow map"),
        size: wgpu::Extent3d { width: px, height: px, depth_or_array_layers: layers },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Depth32Float,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    });
    let module = gpu.device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("caster"), source: wgpu::ShaderSource::Wgsl(CASTER_WGSL.into()) });
    let pipeline = gpu.device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("caster"),
        layout: None,
        vertex: wgpu::VertexState { module: &module, entry_point: Some("vs_caster"), compilation_options: Default::default(), buffers: &[] },
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: Some(wgpu::DepthStencilState {
            format: wgpu::TextureFormat::Depth32Float,
            depth_write_enabled: Some(true),
            depth_compare: Some(wgpu::CompareFunction::Always),
            stencil: wgpu::StencilState::default(),
            bias: wgpu::DepthBiasState::default(),
        }),
        multisample: wgpu::MultisampleState::default(),
        fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some("fs_caster"), compilation_options: Default::default(), targets: &[] }),
        multiview_mask: None,
        cache: None,
    });
    let matrices: Vec<Mat4> = cascades.iter().map(|(center, half)| light_view_proj(Vec3::from(*center), *half)).collect();
    let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("caster") });
    for (layer, matrix) in matrices.iter().enumerate() {
        let mut uniform = matrix.inverse().to_cols_array().to_vec();
        uniform.extend([px as f32, px as f32, 0.0, 0.0]);
        let buffer = buffer_with(gpu, "caster", wgpu::BufferUsages::UNIFORM, bytemuck::cast_slice(&uniform));
        let group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("caster"),
            layout: &pipeline.get_bind_group_layout(0),
            entries: &[wgpu::BindGroupEntry { binding: 0, resource: buffer.as_entire_binding() }],
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor {
            dimension: Some(wgpu::TextureViewDimension::D2),
            base_array_layer: layer as u32,
            array_layer_count: Some(1),
            ..Default::default()
        });
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("caster"),
            color_attachments: &[],
            depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                view: &view,
                depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(1.0), store: wgpu::StoreOp::Store }),
                stencil_ops: None,
            }),
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.draw(0..3, 0..1);
    }
    gpu.queue.submit([encoder.finish()]);
    let array = texture.create_view(&wgpu::TextureViewDescriptor { dimension: Some(wgpu::TextureViewDimension::D2Array), ..Default::default() });
    // The renderer's shadow sampler: linear comparison (a hardware 2x2 tap), clamped to the edge.
    let sampler = gpu.device.create_sampler(&wgpu::SamplerDescriptor {
        label: Some("shadow"),
        mag_filter: wgpu::FilterMode::Linear,
        min_filter: wgpu::FilterMode::Linear,
        compare: Some(wgpu::CompareFunction::LessEqual),
        ..Default::default()
    });
    let texel_world = cascades.iter().map(|(_, half)| 2.0 * half / px as f32).collect();
    ShadowMap { _texture: texture, array, sampler, matrices, texel_world }
}

/// The forward frame over `map` with cascades ending at `ends`, the sun `radius_deg` wide.
fn frame(map: &ShadowMap, camera: [f32; 3], forward: [f32; 3], ends: [f32; 4], radius_deg: f32, px: u32) -> GpuFrame {
    let sun = sun();
    let drawn = map.matrices.len();
    let lane = |values: &[f32], c: usize| if c < drawn { values[c] } else { 0.0 };
    let offsets: Vec<f32> = map.texel_world.iter().map(|texel| texel * NORMAL_OFFSET_TEXELS).collect();
    let mut cascade_matrices = [[0.0; 16]; MAX_CASCADES];
    for (c, matrix) in map.matrices.iter().enumerate() {
        cascade_matrices[c] = matrix.to_cols_array();
    }
    let radius = radius_deg.to_radians();
    GpuFrame {
        view_proj: Mat4::IDENTITY.to_cols_array(),
        camera_pos: [camera[0], camera[1], camera[2], 1.0],
        camera_forward: [forward[0], forward[1], forward[2], 0.0],
        sun_dir: [sun.x, sun.y, sun.z, radius],
        sun_color: [1.0, 1.0, 1.0, 0.0],
        cascade_view_proj: [cascade_matrices[0], cascade_matrices[1]],
        cascade_splits: [ends[0], ends[1], 0.0, 1.0],
        shadow_params: [BIAS, lane(&offsets, 0), lane(&offsets, 1), 1.0 / px as f32],
        cascade_matrices,
        cascade_ends: ends,
        cascade_offsets: std::array::from_fn(|c| lane(&offsets, c)),
        cascade_texels: std::array::from_fn(|c| lane(&map.texel_world, c)),
        shadow_soft: [libm::tanf(radius), 0.0, 0.0, 0.0],
        shadow_counts: [drawn as u32, 0, 0, 0],
        ..GpuFrame::default()
    }
}

/// How a probe runs the chunk: its filter (None: the pipeline constant's default), whether TAA
/// follows, and the context the fragment entry would hand it (None: the entry never calls it).
#[derive(Clone, Copy)]
struct Run {
    filter: Option<ShadowFilter>,
    temporal: bool,
    context: Option<Context>,
}

/// What `gx_sun_shadow_context` receives besides each row's pixel, and the end fade
/// `gx_sun_shadow_end_fade` receives.
#[derive(Clone, Copy)]
struct Context {
    frame_key: u32,
    blend_band: f32,
    end_fade: f32,
}

impl Run {
    fn filter(filter: ShadowFilter) -> Run {
        Run { filter: Some(filter), temporal: false, context: None }
    }

    fn with_context(self, frame_key: u32, blend_band: f32) -> Run {
        Run { context: Some(Context { frame_key, blend_band, end_fade: 0.0 }), ..self }
    }

    fn with_end_fade(self, end_fade: f32) -> Run {
        let context = self.context.unwrap_or(Context { frame_key: 0, blend_band: 0.0, end_fade: 0.0 });
        Run { context: Some(Context { end_fade, ..context }), ..self }
    }

    fn temporal(self) -> Run {
        Run { temporal: true, ..self }
    }

    fn constants(&self) -> Vec<(&'static str, f64)> {
        let mut constants = Vec::new();
        if let Some(filter) = self.filter {
            constants.push(("GX_SHADOW_FILTER", f64::from(filter.shader_id())));
        }
        if self.temporal {
            constants.push(("GX_SHADOW_TEMPORAL", 1.0));
        }
        constants
    }
}

/// The forward shader plus the probe: each row is a ground point (xyz) and a pixel; the probe
/// writes the sun's visibility at the point into the row's w.
fn probe_source(context: bool) -> String {
    let hand_over = if context {
        "gx_sun_shadow_context(pixel.xy, probe.frame_key, probe.blend_band);\n    gx_sun_shadow_end_fade(probe.end_fade);"
    } else {
        "_ = pixel;"
    };
    format!(
        "{}\n{}",
        genex_render::shaders::FORWARD,
        r"
struct ShadowProbe {
    frame_key: u32,
    blend_band: f32,
    end_fade: f32,
    pad1: u32,
}
@group(0) @binding(40) var<storage, read_write> probe_rows: array<vec4<f32>>;
@group(0) @binding(41) var<uniform> probe: ShadowProbe;

@compute @workgroup_size(64)
fn cs_shadow_probe(@builtin(global_invocation_id) id: vec3<u32>) {
    _ = probe.frame_key;
    _ = probe.end_fade;
    let rows = arrayLength(&probe_rows) / 2u;
    if id.x >= rows {
        return;
    }
    let at = id.x * 2u;
    let pixel = probe_rows[at + 1u];
    HAND_OVER
    probe_rows[at].w = sun_shadow(probe_rows[at].xyz, vec3<f32>(0.0, 1.0, 0.0));
}
"
        .replace("HAND_OVER", hand_over)
    )
}

/// The chunk's visibility at each `(point, pixel)` row under `run`, through `map` and `frame`.
fn visibility(gpu: &Gpu, map: &ShadowMap, frame: &GpuFrame, run: Run, rows: &[([f32; 3], [f32; 2])]) -> Vec<f32> {
    let source = probe_source(run.context.is_some());
    let module = gpu.device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("shadow probe"), source: wgpu::ShaderSource::Wgsl(source.into()) });
    let constants = run.constants();
    let pipeline = gpu.device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("shadow probe"),
        layout: None,
        module: &module,
        entry_point: Some("cs_shadow_probe"),
        compilation_options: wgpu::PipelineCompilationOptions { constants: &constants, ..Default::default() },
        cache: None,
    });
    let context = run.context.unwrap_or(Context { frame_key: 0, blend_band: 0.0, end_fade: 0.0 });
    let params: [u32; 4] = [context.frame_key, context.blend_band.to_bits(), context.end_fade.to_bits(), 0];
    let data: Vec<[f32; 4]> = rows.iter().flat_map(|(p, pixel)| [[p[0], p[1], p[2], -1.0], [pixel[0], pixel[1], 0.0, 0.0]]).collect();
    let storage = buffer_with(gpu, "shadow probe rows", wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC, bytemuck::cast_slice(&data));
    let frame_buffer = buffer_with(gpu, "shadow probe frame", wgpu::BufferUsages::UNIFORM, bytemuck::bytes_of(frame));
    let params = buffer_with(gpu, "shadow probe params", wgpu::BufferUsages::UNIFORM, bytemuck::cast_slice(&params));
    let group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("shadow probe"),
        layout: &pipeline.get_bind_group_layout(0),
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: frame_buffer.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 6, resource: wgpu::BindingResource::TextureView(&map.array) },
            wgpu::BindGroupEntry { binding: 7, resource: wgpu::BindingResource::Sampler(&map.sampler) },
            wgpu::BindGroupEntry { binding: 40, resource: storage.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 41, resource: params.as_entire_binding() },
        ],
    });
    let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("shadow probe") });
    {
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("shadow probe"), timestamp_writes: None });
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups((rows.len() as u32).div_ceil(64), 1, 1);
    }
    gpu.queue.submit([encoder.finish()]);
    let bytes = read_buffer(gpu, &storage, (data.len() * 16) as u64);
    bytemuck::cast_slice::<u8, [f32; 4]>(&bytes).chunks(2).map(|pair| pair[0][3]).collect()
}

// ---------------------------------------------------------------------------------------------
// Measuring an edge

/// The ground line across the shadow's x = 0.5 edge, `behind` metres behind the pole (z), from
/// the shadow's middle out into the light; every row's pixel is 0 (an unrotated pattern, so the
/// profile measures the kernel and not the noise).
fn edge_line(behind: f32) -> Vec<([f32; 3], [f32; 2])> {
    let z = -POLE_HALF - behind;
    (0..=(1.5 / STEP) as usize).map(|i| ([i as f32 * STEP, 0.0, z], [0.0, 0.0])).collect()
}

/// Where `profile` (rising along x, `STEP` apart from x = 0) first reaches `level`, interpolated.
fn crossing(profile: &[f32], level: f32) -> Option<f32> {
    profile.windows(2).enumerate().find(|(_, pair)| pair[0] < level && pair[1] >= level).map(|(i, pair)| {
        let t = (level - pair[0]) / (pair[1] - pair[0]);
        (i as f32 + t) * STEP
    })
}

/// The 10 %..90 % width of the edge in `profile`, metres.
fn penumbra(profile: &[f32]) -> f32 {
    let low = crossing(profile, 0.1).expect("the profile leaves the umbra");
    let high = crossing(profile, 0.9).expect("the profile reaches the light");
    high - low
}

fn sun_lit_profile(gpu: &Gpu, map: &ShadowMap, ends: [f32; 4], run: Run, behind: f32) -> Vec<f32> {
    let frame = frame(map, CAMERA, [0.0, -1.0, 0.0], ends, SUN_RADIUS_DEG, MAP_PX);
    let profile = visibility(gpu, map, &frame, run, &edge_line(behind));
    assert!(profile[0] < 0.05, "the line starts in the pole's umbra ({})", profile[0]);
    assert!(*profile.last().expect("rows") > 0.95, "the line ends in the light ({:?})", profile.last());
    profile
}

fn two_cascades(gpu: &Gpu) -> ShadowMap {
    shadow_map(gpu, &[NEAR_CASCADE, FAR_CASCADE], MAP_PX)
}

// ---------------------------------------------------------------------------------------------
// Rows

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_pcss_penumbra_widens_with_the_distance_to_the_blocker() {
    let _shared = gpu_shared();
    let Some(gpu) = gpu() else { return };
    let map = two_cascades(&gpu);
    for filter in [ShadowFilter::Pcss, ShadowFilter::PcssLite] {
        let near = penumbra(&sun_lit_profile(&gpu, &map, IN_NEAR, Run::filter(filter), 0.5));
        let far = penumbra(&sun_lit_profile(&gpu, &map, IN_NEAR, Run::filter(filter), 4.0));
        eprintln!("{filter:?}: penumbra {near:.4} m at 0.5 m from the pole, {far:.4} m at 4 m");
        assert!(far > 2.0 * near, "{filter:?}: the penumbra at 4 m ({far} m) is not over twice the one at 0.5 m ({near} m)");
    }
}

/// The 10 %..90 % width of a straight edge's penumbra under a uniform disk of radius 1: the chord
/// offsets where a disk's segment holds 10 % and 90 % of its area are -+0.687.
const DISK_EDGE_WIDTH_PER_RADIUS: f32 = 1.374;
/// How far the measured growth of the penumbra with the blocker distance may stray from a disk
/// sun's.
const DISK_LAW_TOLERANCE: f32 = 0.15;

/// Pass-1 fix gate, live-app finding 3 (the lakeside's leaf shadows at high and ultra read softer
/// than at low and medium, whose PCF draws every shadow as hard at 50 m from its caster as at
/// 1 m): PCSS's penumbra grows with the distance to the blocker as a disk sun of the frame's
/// angular radius casts it, w(10-90 %) = 1.374 d tan(r). Under the 45 degree sun the pole's edge
/// `behind` metres behind it is sqrt(2) behind metres from the ground along the light.
#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_pcss_penumbra_grows_as_a_disk_sun_of_its_angular_radius_casts_it() {
    let _shared = gpu_shared();
    let Some(gpu) = gpu() else { return };
    let map = two_cascades(&gpu);
    let law = DISK_EDGE_WIDTH_PER_RADIUS * libm::tanf(SUN_RADIUS_DEG.to_radians());
    for filter in [ShadowFilter::Pcss, ShadowFilter::PcssLite] {
        let (near, far) = (2.0, 4.0);
        let width = |behind: f32| penumbra(&sun_lit_profile(&gpu, &map, IN_NEAR, Run::filter(filter), behind));
        let growth = (width(far) - width(near)) / ((far - near) * std::f32::consts::SQRT_2);
        eprintln!("{filter:?}: the penumbra grows {growth:.4} m per metre to the blocker; a disk sun of {SUN_RADIUS_DEG} degrees, {law:.4}");
        assert!((growth - law).abs() <= DISK_LAW_TOLERANCE * law, "{filter:?}: the penumbra grows {growth:.4} m a metre, a disk sun {law:.4}");
    }
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_pcss_penumbra_in_world_units_is_continuous_across_cascades() {
    let _shared = gpu_shared();
    let Some(gpu) = gpu() else { return };
    let map = two_cascades(&gpu);
    for behind in [2.0, 4.0] {
        let near = penumbra(&sun_lit_profile(&gpu, &map, IN_NEAR, Run::filter(ShadowFilter::Pcss), behind));
        let far = penumbra(&sun_lit_profile(&gpu, &map, IN_FAR, Run::filter(ShadowFilter::Pcss), behind));
        let difference = (near - far).abs() / near.max(far);
        eprintln!("{behind} m behind: penumbra {near:.4} m in cascade 0, {far:.4} m in cascade 1 ({:.1} %)", difference * 100.0);
        assert!(difference < 0.15, "{behind} m behind the pole the penumbra jumps {:.1} % across the cascade boundary", difference * 100.0);
    }
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_a_penumbra_wider_than_a_fine_cascades_kernel_keeps_its_width_across_the_split() {
    // RQ3 review: PCSS capped its radius at 16 texels of the cascade it sampled, so under a wide
    // sun the penumbra halved at each split (cascade 0's cap 0.25 m here, cascade 1's 0.62 m) and
    // a finer map drew harder shadows. The cap is now in world units and a radius wider than a
    // cascade's 16 texels is read from the coarser cascade.
    let _shared = gpu_shared();
    let Some(gpu) = gpu() else { return };
    let map = two_cascades(&gpu);
    let wide_sun = 5.0;
    let fine_cap = 16.0 * map.texel_world[0];
    for (filter, search) in [(ShadowFilter::Pcss, 16), (ShadowFilter::PcssLite, 8)] {
        let profile = |ends| {
            let frame = frame(&map, CAMERA, [0.0, -1.0, 0.0], ends, wide_sun, MAP_PX);
            visibility(&gpu, &map, &frame, Run::filter(filter), &edge_line(4.0))
        };
        let near = penumbra(&profile(IN_NEAR));
        let far = penumbra(&profile(IN_FAR));
        let difference = (near - far).abs() / near.max(far);
        eprintln!("{filter:?} ({search} blocker taps), 5 degree sun, 4 m behind: {near:.4} m in cascade 0, {far:.4} m in cascade 1 ({:.1} %)", difference * 100.0);
        assert!(near > 1.5 * fine_cap, "{filter:?}: the penumbra ({near} m) is wider than cascade 0's 16 texels ({fine_cap} m)");
        assert!(difference < 0.15, "{filter:?}: the penumbra jumps {:.1} % across the split", difference * 100.0);
    }
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_the_hardware_filter_draws_a_one_texel_edge() {
    let _shared = gpu_shared();
    let Some(gpu) = gpu() else { return };
    let map = two_cascades(&gpu);
    let texel = map.texel_world[0];
    let profile = sun_lit_profile(&gpu, &map, IN_NEAR, Run::filter(ShadowFilter::Hardware2x2), 2.0);
    let start = crossing(&profile, 0.001).expect("the edge starts");
    let end = crossing(&profile, 0.999).expect("the edge ends");
    let width = end - start;
    eprintln!("hardware 2x2: edge {width:.4} m, one texel {texel:.4} m");
    assert!(width <= texel + 2.0 * STEP, "the hardware edge spans {width} m, over one texel ({texel} m)");
    assert!(width >= 0.5 * texel, "the hardware edge spans {width} m: a bilinear tap ramps over one texel ({texel} m)");
    let pcf5 = penumbra(&sun_lit_profile(&gpu, &map, IN_NEAR, Run::filter(ShadowFilter::Pcf5x5), 2.0));
    let pcf3 = penumbra(&sun_lit_profile(&gpu, &map, IN_NEAR, Run::filter(ShadowFilter::Pcf3x3), 2.0));
    eprintln!("pcf3 {pcf3:.4} m, pcf5 {pcf5:.4} m");
    assert!(pcf5 > pcf3 && pcf3 > 0.8 * width, "the PCF kernels widen the edge in order: hard {width}, 3x3 {pcf3}, 5x5 {pcf5}");
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_pcf3_is_the_default_filter_bit_for_bit() {
    let _shared = gpu_shared();
    let Some(gpu) = gpu() else { return };
    let map = two_cascades(&gpu);
    let frame = frame(&map, CAMERA, [0.0, -1.0, 0.0], IN_NEAR, SUN_RADIUS_DEG, MAP_PX);
    let rows = golden_rows();
    let default = visibility(&gpu, &map, &frame, Run { filter: None, temporal: false, context: None }, &rows);
    let pcf3 = visibility(&gpu, &map, &frame, Run::filter(ShadowFilter::Pcf3x3), &rows);
    let handed = visibility(&gpu, &map, &frame, Run::filter(ShadowFilter::Pcf3x3).with_context(7, 0.0), &rows);
    assert!(default.iter().zip(&pcf3).all(|(a, b)| a.to_bits() == b.to_bits()), "the default pipeline constant is 3x3 PCF");
    assert!(default.iter().zip(&handed).all(|(a, b)| a.to_bits() == b.to_bits()), "the context leaves 3x3 PCF alone");
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_without_taa_two_frames_of_a_static_scene_are_byte_identical() {
    let _shared = gpu_shared();
    let Some(gpu) = gpu() else { return };
    let map = two_cascades(&gpu);
    let frame = frame(&map, CAMERA, [0.0, -1.0, 0.0], IN_NEAR, SUN_RADIUS_DEG, MAP_PX);
    let rows = golden_rows();
    let still = Run::filter(ShadowFilter::Pcss);
    let first = visibility(&gpu, &map, &frame, still.with_context(1, 0.0), &rows);
    let second = visibility(&gpu, &map, &frame, still.with_context(2, 0.0), &rows);
    assert!(first.iter().zip(&second).all(|(a, b)| a.to_bits() == b.to_bits()), "without TAA the frame key moves nothing");
    let moving = still.temporal();
    let first = visibility(&gpu, &map, &frame, moving.with_context(1, 0.0), &rows);
    let second = visibility(&gpu, &map, &frame, moving.with_context(2, 0.0), &rows);
    let changed = first.iter().zip(&second).filter(|(a, b)| a.to_bits() != b.to_bits()).count();
    eprintln!("under TAA {changed} of {} penumbra samples turn with the frame key", rows.len());
    assert!(changed > 0, "under TAA the tap pattern turns with the frame index");
    let again = visibility(&gpu, &map, &frame, moving.with_context(1, 0.0), &rows);
    assert!(first.iter().zip(&again).all(|(a, b)| a.to_bits() == b.to_bits()), "under TAA a frame index is the same bits every time");
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_the_cascade_band_lerps_without_taa_and_dithers_under_it() {
    let _shared = gpu_shared();
    let Some(gpu) = gpu() else { return };
    let map = two_cascades(&gpu);
    let rows = edge_line(3.0);
    let band = 0.1;
    // Cascade 0 ends at 10.5 and its band starts at 9.45: the ground (depth 10) is 52 % through it.
    let ends = [10.5, 200.0, 0.0, 0.0];
    let fade = (GROUND_DEPTH - (ends[0] - band * ends[0])) / (band * ends[0]);
    let at = |ends: [f32; 4], run: Run| visibility(&gpu, &map, &frame(&map, CAMERA, [0.0, -1.0, 0.0], ends, SUN_RADIUS_DEG, MAP_PX), run, &rows);
    let pcss = Run::filter(ShadowFilter::Pcss);
    let near = at(IN_NEAR, pcss);
    let far = at(IN_FAR, pcss);
    let blended = at(ends, pcss.with_context(0, band));
    for ((n, f), b) in near.iter().zip(&far).zip(&blended) {
        let want = n + (f - n) * fade;
        assert!((b - want).abs() <= 1e-5, "the band lerps the two cascades {fade}: {n} .. {f} gave {b}, want {want}");
    }
    let unblended = at(ends, pcss.with_context(0, 0.0));
    assert!(near.iter().zip(&unblended).all(|(a, b)| a.to_bits() == b.to_bits()), "no band is a hard switch");
    let dithered = at(ends, pcss.temporal().with_context(0, band));
    let near_t = at(IN_NEAR, pcss.temporal());
    let far_t = at(IN_FAR, pcss.temporal());
    let from_far = dithered.iter().zip(&near_t).zip(&far_t).filter(|((d, n), f)| d.to_bits() == f.to_bits() && d.to_bits() != n.to_bits()).count();
    assert!(
        dithered.iter().zip(&near_t).zip(&far_t).all(|((d, n), f)| d.to_bits() == n.to_bits() || d.to_bits() == f.to_bits()),
        "under TAA each pixel takes one cascade's lookup"
    );
    eprintln!("under TAA {from_far} of {} band samples took the next cascade", rows.len());
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_the_last_cascade_fades_its_shadows_out_before_the_shadow_distance() {
    // RQ3 review: past the last cascade the sun's visibility jumped to 1 on one pixel row.
    let _shared = gpu_shared();
    let Some(gpu) = gpu() else { return };
    let map = shadow_map(&gpu, &[NEAR_CASCADE], MAP_PX);
    let rows = edge_line(2.0);
    // One cascade ending at 12: its last 30 % starts at 8.4, so the ground (depth 10) is 44 % in.
    let (ends, fade) = ([12.0, 0.0, 0.0, 0.0], 0.3);
    let t = (GROUND_DEPTH - (ends[0] - fade * ends[0])) / (fade * ends[0]);
    let ending = frame(&map, CAMERA, [0.0, -1.0, 0.0], ends, SUN_RADIUS_DEG, MAP_PX);
    let pcf3 = Run::filter(ShadowFilter::Pcf3x3);
    let hard_end = visibility(&gpu, &map, &ending, pcf3.with_context(0, 0.0), &rows);
    let faded = visibility(&gpu, &map, &ending, pcf3.with_end_fade(fade), &rows);
    assert!(hard_end[0] < 0.05, "the line starts in the umbra");
    for (hard, soft) in hard_end.iter().zip(&faded) {
        let want = hard + (1.0 - hard) * t;
        assert!((soft - want).abs() <= 1e-5, "the end fade lifts {hard} by {t}: got {soft}, want {want}");
    }
    let before = visibility(&gpu, &map, &frame(&map, CAMERA, [0.0, -1.0, 0.0], [40.0, 0.0, 0.0, 0.0], SUN_RADIUS_DEG, MAP_PX), pcf3.with_end_fade(fade), &rows);
    assert!(before.iter().zip(&hard_end).all(|(a, b)| a.to_bits() == b.to_bits()), "before the fade starts the shadow is untouched");
}

// ---------------------------------------------------------------------------------------------
// Goldens

fn golden_rows() -> Vec<([f32; 3], [f32; 2])> {
    let pixel = GOLDEN_EXTENT / GOLDEN_SIDE as f32;
    (0..GOLDEN_SIDE)
        .flat_map(|y| {
            (0..GOLDEN_SIDE).map(move |x| {
                let world = [GOLDEN_ORIGIN[0] + (x as f32 + 0.5) * pixel, 0.0, GOLDEN_ORIGIN[1] + (y as f32 + 0.5) * pixel];
                (world, [x as f32, y as f32])
            })
        })
        .collect()
}

fn to_bgra(visibility: &[f32]) -> Vec<u8> {
    visibility
        .iter()
        .flat_map(|v| {
            let grey = (v.clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
            [grey, grey, grey, 255]
        })
        .collect()
}

fn goldens_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../tests/fixtures/render-goldens/shadows-filter")
}

fn write_evidence(name: &str, bgra: &[u8]) {
    if let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") {
        let dir = PathBuf::from(dir);
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join(format!("{name}.bgra")), bgra).expect("evidence");
    }
}

/// Compare `bgra` with the golden `name`, or rewrite it under `GENEX_RENDER_GOLDEN_UPDATE=1`.
fn check_golden(name: &str, bgra: &[u8]) {
    write_evidence(name, bgra);
    let path = goldens_dir().join(format!("{name}.bgra"));
    if std::env::var("GENEX_RENDER_GOLDEN_UPDATE").is_ok_and(|v| v == "1") {
        std::fs::create_dir_all(goldens_dir()).expect("goldens folder");
        std::fs::write(&path, bgra).expect("golden written");
        return;
    }
    let golden = std::fs::read(&path).unwrap_or_else(|error| panic!("golden {path:?} missing ({error}); render it with GENEX_RENDER_GOLDEN_UPDATE=1"));
    assert_eq!(golden.len(), bgra.len());
    let mut outliers = 0;
    let mut worst = 0u8;
    for (a, b) in golden.chunks(4).zip(bgra.chunks(4)) {
        let diff = a.iter().zip(b).map(|(p, q)| p.abs_diff(*q)).max().unwrap_or(0);
        worst = worst.max(diff);
        outliers += usize::from(diff > GOLDEN_CHANNEL_TOLERANCE);
    }
    assert!(outliers <= GOLDEN_OUTLIER_PIXELS, "{name}: {outliers} pixels differ from the golden by more than {GOLDEN_CHANNEL_TOLERANCE} (worst {worst})");
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_the_filters_match_their_goldens() {
    let _shared = gpu_shared();
    let Some(gpu) = gpu() else { return };
    let map = two_cascades(&gpu);
    let frame = frame(&map, CAMERA, [0.0, -1.0, 0.0], IN_NEAR, SUN_RADIUS_DEG, MAP_PX);
    let rows = golden_rows();
    let picture = |run: Run| to_bgra(&visibility(&gpu, &map, &frame, run, &rows));
    check_golden("pcf5", &picture(Run::filter(ShadowFilter::Pcf5x5).with_context(0, 0.0)));
    check_golden("pcss", &picture(Run::filter(ShadowFilter::Pcss).with_context(0, 0.0)));
    // Evidence only: the other filters and PCSS-lite, and PCSS's pattern on two TAA frames.
    write_evidence("hard", &picture(Run::filter(ShadowFilter::Hardware2x2)));
    write_evidence("pcf3", &picture(Run::filter(ShadowFilter::Pcf3x3)));
    write_evidence("pcss-lite", &picture(Run::filter(ShadowFilter::PcssLite).with_context(0, 0.0)));
    write_evidence("pcss-taa-frame-1", &picture(Run::filter(ShadowFilter::Pcss).temporal().with_context(1, 0.0)));
    write_evidence("pcss-taa-frame-2", &picture(Run::filter(ShadowFilter::Pcss).temporal().with_context(2, 0.0)));
}

// ---------------------------------------------------------------------------------------------
// Cost

/// The 1080p cost probe: one ground point per pixel of a view looking along -z from z = 20, so
/// the points' view depths (2..60 m) fall in all four cascades.
const COST_WGSL: &str = r"
struct CostGrid {
    origin: vec4<f32>,
    step: vec4<f32>,
    size: vec4<u32>,
}
@group(0) @binding(40) var<storage, read_write> cost_out: array<f32>;
@group(0) @binding(41) var<uniform> grid: CostGrid;

@compute @workgroup_size(8, 8)
fn cs_shadow_cost(@builtin(global_invocation_id) id: vec3<u32>) {
    if id.x >= grid.size.x || id.y >= grid.size.y {
        return;
    }
    let world = vec3<f32>(grid.origin.x + f32(id.x) * grid.step.x, 0.0, grid.origin.z + f32(id.y) * grid.step.z);
    gx_sun_shadow_context(vec2<f32>(id.xy), 0u, 0.0);
    cost_out[id.y * grid.size.x + id.x] = sun_shadow(world, vec3<f32>(0.0, 1.0, 0.0));
}
";

/// Four cascades along the cost view (camera at z = 20 looking along -z): their slices' centres
/// and half extents for view depths 0..8, 8..16, 16..32 and 32..64.
const COST_CASCADES: [([f32; 3], f32); 4] =
    [([0.0, 0.0, 16.0], 12.0), ([0.0, 0.0, 8.0], 16.0), ([0.0, 0.0, -4.0], 24.0), ([0.0, 0.0, -28.0], 40.0)];
const COST_ENDS: [f32; 4] = [8.0, 16.0, 32.0, 64.0];
const COST_MAP_PX: u32 = 2048;
const COST_SIZE: (u32, u32) = (1920, 1080);

/// GPU ms of each of `COST_RUNS` dispatches of the cost probe under `filter` (the device has
/// `TIMESTAMP_QUERY`).
fn cost_ms(gpu: &Gpu, map: &ShadowMap, frame: &GpuFrame, filter: ShadowFilter) -> Vec<f64> {
    let source = format!("{}\n{COST_WGSL}", genex_render::shaders::FORWARD);
    let module = gpu.device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("shadow cost"), source: wgpu::ShaderSource::Wgsl(source.into()) });
    let constants = [("GX_SHADOW_FILTER", f64::from(filter.shader_id()))];
    let pipeline = gpu.device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("shadow cost"),
        layout: None,
        module: &module,
        entry_point: Some("cs_shadow_cost"),
        compilation_options: wgpu::PipelineCompilationOptions { constants: &constants, ..Default::default() },
        cache: None,
    });
    let (width, height) = COST_SIZE;
    let out = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("shadow cost out"),
        size: u64::from(width * height) * 4,
        usage: wgpu::BufferUsages::STORAGE,
        mapped_at_creation: false,
    });
    let grid: [f32; 12] = [-24.0, 0.0, -40.0, 0.0, 48.0 / width as f32, 0.0, 58.0 / height as f32, 0.0, f32::from_bits(width), f32::from_bits(height), 0.0, 0.0];
    let grid = buffer_with(gpu, "shadow cost grid", wgpu::BufferUsages::UNIFORM, bytemuck::cast_slice(&grid));
    let frame_buffer = buffer_with(gpu, "shadow cost frame", wgpu::BufferUsages::UNIFORM, bytemuck::bytes_of(frame));
    let group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("shadow cost"),
        layout: &pipeline.get_bind_group_layout(0),
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: frame_buffer.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 6, resource: wgpu::BindingResource::TextureView(&map.array) },
            wgpu::BindGroupEntry { binding: 7, resource: wgpu::BindingResource::Sampler(&map.sampler) },
            wgpu::BindGroupEntry { binding: 40, resource: out.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 41, resource: grid.as_entire_binding() },
        ],
    });
    let queries = gpu.device.create_query_set(&wgpu::QuerySetDescriptor { label: Some("shadow cost"), ty: wgpu::QueryType::Timestamp, count: 2 });
    let resolve = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("shadow cost resolve"),
        size: 16,
        usage: wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let period = f64::from(gpu.queue.get_timestamp_period());
    let mut times = Vec::new();
    for run in 0..COST_WARMUP + COST_RUNS {
        let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("shadow cost") });
        {
            let writes = wgpu::ComputePassTimestampWrites { query_set: &queries, beginning_of_pass_write_index: Some(0), end_of_pass_write_index: Some(1) };
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("shadow cost"), timestamp_writes: Some(writes) });
            pass.set_pipeline(&pipeline);
            pass.set_bind_group(0, &group, &[]);
            pass.dispatch_workgroups(width.div_ceil(8), height.div_ceil(8), 1);
        }
        encoder.resolve_query_set(&queries, 0..2, &resolve, 0);
        gpu.queue.submit([encoder.finish()]);
        let stamps = read_buffer(gpu, &resolve, 16);
        let stamps: Vec<u64> = stamps.chunks(8).map(|b| u64::from_le_bytes(b.try_into().expect("8 bytes"))).collect();
        if run >= COST_WARMUP {
            times.push(stamps[1].saturating_sub(stamps[0]) as f64 * period / 1.0e6);
        }
    }
    times
}

fn percentile(sorted: &[f64], share: f64) -> f64 {
    sorted[((sorted.len() as f64 * share) as usize).min(sorted.len() - 1)]
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_four_cascade_pcss_at_1080p_costs_within_the_budget() {
    let _alone = gpu_alone();
    let Some(gpu) = gpu_with(wgpu::Features::TIMESTAMP_QUERY) else {
        eprintln!("skipped: no TIMESTAMP_QUERY");
        return;
    };
    let map = shadow_map(&gpu, &COST_CASCADES, COST_MAP_PX);
    let frame = frame(&map, [0.0, 10.0, 20.0], [0.0, 0.0, -1.0], COST_ENDS, SUN_RADIUS_DEG, COST_MAP_PX);
    let mut rows = Vec::new();
    let mut pcss_p50 = f64::INFINITY;
    for filter in ShadowFilter::ALL {
        let mut times = cost_ms(&gpu, &map, &frame, filter);
        times.sort_by(f64::total_cmp);
        let (p50, p95) = (percentile(&times, 0.5), percentile(&times, 0.95));
        eprintln!("{filter:?} 4 x {COST_MAP_PX} cascades at 1080p: p50 {p50:.3} ms, p95 {p95:.3} ms");
        if filter == ShadowFilter::Pcss {
            pcss_p50 = p50;
        }
        rows.push(serde_json::json!({ "filter": format!("{filter:?}"), "p50_ms": p50, "p95_ms": p95 }));
    }
    if let Ok(path) = std::env::var("GENEX_PERF_OUT") {
        let report = serde_json::json!({
            "row": "shadow-filter-cost", "adapter": gpu.receipt().adapter, "render": [COST_SIZE.0, COST_SIZE.1],
            "cascades": COST_CASCADES.len(), "map_px": COST_MAP_PX, "runs": COST_RUNS, "warmup": COST_WARMUP, "budget_ms": PCSS_BUDGET_MS,
            "note": "the sun chunk's filter alone, one compute invocation per pixel; cascade rendering is RQ3.1's row",
            "rows": rows,
        });
        std::fs::write(path, serde_json::to_string_pretty(&report).expect("json")).expect("perf written");
    }
    assert!(pcss_p50 <= PCSS_BUDGET_MS, "4-cascade PCSS 16/32 costs {pcss_p50} ms at 1080p, over {PCSS_BUDGET_MS} ms");
}

// ---------------------------------------------------------------------------------------------
// Renderer frames
//
// The rows above hand the chunk its frame and context directly; these draw through the renderer,
// whose frame carries the sun's angular radius in `sun_dir.w` (scene.rs) and whose forward entry
// hands the chunk its pixel, frame key and blend band (forward.wgsl).

/// The renderer rows' frame size: one pixel is about 1.6 cm of ground.
const FRAME_SIZE: (u32, u32) = (1024, 576);
/// The renderer rows' orthographic view height, metres (16 m wide at 16:9).
const FRAME_VIEW_HEIGHT: f32 = 9.0;
/// How far the renderer rows' sun shadows reach, metres (the camera is 30 m above the ground).
const FRAME_SHADOW_DISTANCE: f32 = 40.0;

/// An 8 m pole (1 m square, on x, z in -0.5..0.5) on a wide ground plane under `sun()`, seen
/// straight down by an orthographic camera centred over the pole's shadow (which runs to -z).
fn pole_scene() -> Scene {
    let above = CameraDesc { up: [0.0, 0.0, -1.0], ..CameraDesc::look_at([0.0, 30.0, -4.0], [0.0, 0.0, -4.0]) };
    let mut scene = Scene::new(above.orthographic(FRAME_VIEW_HEIGHT), [120, 160, 210, 255]);
    scene.lighting.sun_dir = sun().to_array();
    scene.lighting.shadow_distance = FRAME_SHADOW_DISTANCE;
    scene.draw(MeshId::CUBE, scaled([0.0, -0.1, -4.0], [40.0, 0.2, 40.0]), Material::color([210, 210, 200, 255]));
    scene.draw(MeshId::CUBE, scaled([0.0, 4.0, 0.0], [2.0 * POLE_HALF, 8.0, 2.0 * POLE_HALF]), Material::color([60, 60, 70, 255]));
    scene
}

/// The legacy quality with one 2048 px cascade drawn with `filter`.
fn pole_quality(filter: ShadowFilter) -> Quality {
    let mut quality = Quality::off();
    quality.shadows.cascades = 1;
    quality.shadows.map_size = 2048;
    quality.shadows.filter = filter;
    quality
}

/// A renderer under `quality` and a sky whose sun is `SUN_RADIUS_DEG` wide (PCSS's light size).
fn pole_renderer(gpu: &Gpu, quality: &Quality) -> Renderer {
    let mut renderer = Renderer::new(gpu, FRAME_SIZE.0, FRAME_SIZE.1).expect("renderer");
    renderer.set_quality(quality);
    renderer.set_environment(&Environment::Sky(SkyParams::default().with_sun_angular_radius_degrees(SUN_RADIUS_DEG)));
    renderer
}

fn pole_frame(gpu: &Gpu, renderer: &mut Renderer, frame_index: u64) -> Capture {
    renderer.set_frame_index(frame_index);
    renderer.render(gpu, &pole_scene(), CullPath::Gpu).expect("frame");
    renderer.capture(gpu).expect("capture")
}

/// The green channel of `capture` at the ground point `(x, z)` (the nearest pixel).
fn ground_green(capture: &Capture, scene: &Scene, x: f32, z: f32) -> f32 {
    let (width, height) = (capture.width(), capture.height());
    let view_proj = scene.camera.projection(width as f32 / height as f32, false);
    let clip = view_proj * Vec3::new(x, 0.0, z).extend(1.0);
    let px = ((clip.x / clip.w * 0.5 + 0.5) * width as f32).floor().clamp(0.0, width as f32 - 1.0) as usize;
    let py = ((0.5 - clip.y / clip.w * 0.5) * height as f32).floor().clamp(0.0, height as f32 - 1.0) as usize;
    f32::from(capture.bgra()[(py * width as usize + px) * 4 + 1])
}

/// The frame's ground across the shadow's x = 0.5 edge, `behind` metres behind the pole, from
/// the shadow's middle out into the light (`STEP` apart, as `edge_line`), scaled so the umbra is
/// 0 and the light 1.
fn frame_profile(capture: &Capture, behind: f32) -> Vec<f32> {
    let scene = pole_scene();
    let raw: Vec<f32> = edge_line(behind).iter().map(|(world, _)| ground_green(capture, &scene, world[0], world[2])).collect();
    let (umbra, light) = (raw[0], *raw.last().expect("rows"));
    assert!(light > umbra + 20.0, "{behind} m behind the pole the frame shows its shadow (umbra {umbra}, light {light})");
    raw.iter().map(|v| (v - umbra) / (light - umbra)).collect()
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_a_pcss_frames_penumbra_widens_with_the_distance_to_the_blocker() {
    let _shared = gpu_shared();
    let Some(gpu) = gpu() else { return };
    let mut renderer = pole_renderer(&gpu, &pole_quality(ShadowFilter::Pcss));
    let capture = pole_frame(&gpu, &mut renderer, 0);
    write_evidence("frame-pcss", capture.bgra());
    let near = penumbra(&frame_profile(&capture, 0.5));
    let far = penumbra(&frame_profile(&capture, 4.0));
    eprintln!("PCSS frame: penumbra {near:.4} m at 0.5 m from the pole, {far:.4} m at 4 m");
    assert!(far > 2.0 * near, "a PCSS frame's penumbra at 4 m ({far} m) is not over twice the one at 0.5 m ({near} m)");
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_without_taa_two_pcss_frames_of_a_static_scene_are_byte_identical() {
    let _shared = gpu_shared();
    let Some(gpu) = gpu() else { return };
    let mut renderer = pole_renderer(&gpu, &pole_quality(ShadowFilter::Pcss));
    let first = pole_frame(&gpu, &mut renderer, 1);
    let second = pole_frame(&gpu, &mut renderer, 2);
    assert_eq!(first.digest(), second.digest(), "without TAA the frame index moves nothing");
    let mut hard = pole_renderer(&gpu, &pole_quality(ShadowFilter::Hardware2x2));
    let hard = pole_frame(&gpu, &mut hard, 1);
    write_evidence("frame-hard", hard.bgra());
    assert_ne!(hard.digest(), first.digest(), "PCSS draws another penumbra than one hardware tap");
}
