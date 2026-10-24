//! The LOD crossfade's faded draws (game systems LOD-04): a fade batch's survivors draw through
//! the faded entry points (`*_fade` in `shaders/forward.wgsl`, `prepass.wgsl`, `shadow.wgsl`),
//! which keep a pixel, or an MSAA sample, of each level by the instance fade table (frame binding
//! 31) and a dither threshold (`gx_lod_fade_threshold`, `gx_lod_fade_keeps` and
//! `gx_lod_fade_coverage` in `shaders/common.wgsl`). The two levels of one crossfade cover each
//! pixel, or each sample, exactly once, the incoming level in proportion to its share:
//! - MSAA covers samples (`sample_mask`), so a pixel holds both levels in proportion, no stipple;
//! - TAA turns the threshold each frame through evenly spaced eighths, so the resolve's average
//!   over a jitter cycle shows each pixel at its share, no stipple (R-12);
//! - an alpha-tested fade keeps alpha-to-coverage and cuts whole pixels (WebGPU refuses
//!   `sample_mask` with alpha-to-coverage);
//! - the sun's casters cut the other level's texels by the unturned threshold.
//!
//! The CPU rows run everywhere. The GPU rows are `#[ignore]`d and their names contain `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked --test lod_fade -- --ignored metal
//!
//! `GENEX_RENDER_EVIDENCE_DIR` receives the compared frames (raw BGRA, top row first, the size in
//! the name).

use std::path::PathBuf;

use genex_render::capture::Capture;
use genex_render::device_class::DeviceClass;
use genex_render::lod_rows::DrawLod;
use genex_render::mesh::{LOD_FADE_TAG, LodChain, LodLevel, MeshData, Vertex};
use genex_render::presets::preset_quality;
use genex_render::scene::{CameraDesc, FramePlan, Material, MeshId, ModelPart, Scene, scaled, translation};
use genex_render::settings::{QualityPreset, SceneFormat};
use genex_render::{CullPath, FrameRenderer, Gpu, ImmediateFrame, RenderOptions};

const WIDTH: u32 = 320;
const HEIGHT: u32 = 180;
/// The fade band the rows draw with (the design's default share of the threshold).
const BAND: f32 = 0.15;
/// The two-faced quad's coarser level's object-space error: its band sits a few metres away.
const QUAD_ERROR: f32 = 0.01;
/// The incoming share a crossfade shows may differ from its fade by this much (plan LOD-04).
const SHARE_TOLERANCE: f32 = 1.0 / 16.0;
/// Pixels covered by both levels alone that a crossfade may leave uncovered (plan LOD-04).
const HOLE_PIXELS_MAX: usize = 2;
/// A pixel is inside the quad when its two levels differ by at least this much (linear luma,
/// 0..255).
const CONTRAST_MIN: f32 = 12.0;
/// The variance of an MSAA crossfade's per-pixel share over the quad's inside (D22: 1:1 crops
/// show no stipple). Four samples cover a pixel in quarters, so the variance of the steps alone
/// is at most 1/64; a one-sample dither's is `s(1 - s)`, 0.1875 at a quarter.
const MSAA_SHARE_VARIANCE_MAX: f32 = 0.02;
/// Pixels of the ground and shadow under a fading pair that may differ from the whole cube's
/// (the P2-0.5 bound).
const PAIR_GROUND_PIXELS_MAX: usize = 88;
/// A pixel differs when a channel moves by more than this.
const CHANNEL_TOLERANCE: u8 = 8;

// ---------------------------------------------------------------------------------------------
// The shaders

fn naga_module(name: &str, source: &str) -> (naga::Module, naga::valid::ModuleInfo) {
    use naga::valid::{Capabilities, ValidationFlags, Validator};
    let module = naga::front::wgsl::parse_str(source).unwrap_or_else(|error| panic!("{name} parses: {}", error.emit_to_string(source)));
    // WebGPU core's cube arrays (the forward pass's probe array).
    let info = Validator::new(ValidationFlags::all(), Capabilities::CUBE_ARRAY_TEXTURES).validate(&module).unwrap_or_else(|error| panic!("{name} validates on WebGPU core: {error:?}"));
    (module, info)
}

/// Whether entry point `entry` of `module` writes the `sample_mask` builtin.
fn writes_sample_mask(module: &naga::Module, entry: &str) -> bool {
    let point = module.entry_points.iter().find(|point| point.name == entry).unwrap_or_else(|| panic!("{entry} declared"));
    let Some(result) = &point.function.result else { return false };
    let is_mask = |binding: &Option<naga::Binding>| matches!(binding, Some(naga::Binding::BuiltIn(naga::BuiltIn::SampleMask)));
    if is_mask(&result.binding) {
        return true;
    }
    match &module.types[result.ty].inner {
        naga::TypeInner::Struct { members, .. } => members.iter().any(|member| is_mask(&member.binding)),
        _ => false,
    }
}

/// The faded entry points of each pipeline the fade twins draw with.
const FADED_ENTRIES: [(&str, &[&str]); 3] = [
    ("forward", &["vs_main_fade", "fs_main_fade", "fs_mask_depth_fade"]),
    (
        "prepass",
        &[
            "vs_prepass_fade",
            "fs_prepass_fade",
            "vs_prepass_mask_fade",
            "fs_prepass_mask_fade",
            "vs_prepass_motion_fade",
            "fs_prepass_motion_fade",
            "vs_prepass_motion_mask_fade",
            "fs_prepass_motion_mask_fade",
        ],
    ),
    ("shadow", &["vs_shadow_fade", "fs_shadow_fade", "fs_shadow_caster_fade", "vs_shadow_mask_fade", "fs_shadow_mask_fade", "fs_shadow_mask_depth_fade"]),
];

fn source(name: &str) -> &'static str {
    match name {
        "forward" => genex_render::shaders::FORWARD,
        "prepass" => genex_render::shaders::PREPASS,
        "shadow" => genex_render::shaders::SHADOW,
        _ => panic!("{name}"),
    }
}

#[test]
fn the_faded_entries_validate_on_webgpu_core_and_emit_hlsl_msl_and_spirv() {
    use naga::back::{hlsl, msl, spv};
    for (name, entries) in FADED_ENTRIES {
        let (module, info) = naga_module(name, source(name));
        for entry in entries {
            assert!(module.entry_points.iter().any(|point| point.name == *entry), "{name} declares {entry}");
        }
        // The faded pipelines' constants: the fade on, four samples, the dither turned.
        let declared: Vec<String> = module.overrides.iter().filter_map(|(_, o)| o.name.clone()).collect();
        let constants: naga::back::PipelineConstants =
            [("GX_LOD_FADE", 1.0), ("GX_LOD_FADE_SAMPLES", 4.0), ("GX_LOD_FADE_TEMPORAL", 1.0)].into_iter().filter(|(key, _)| declared.iter().any(|d| d == key)).map(|(key, value)| (key.to_owned(), value)).collect();
        let (module, info) = naga::back::pipeline_constants::process_overrides(&module, &info, None, &constants).unwrap_or_else(|error| panic!("{name}: overrides: {error:?}"));
        let (module, info) = (module.into_owned(), info.into_owned());
        let mut hlsl_source = String::new();
        let hlsl_options = hlsl::Options { shader_model: hlsl::ShaderModel::V5_1, ..Default::default() };
        hlsl::Writer::new(&mut hlsl_source, &hlsl_options, &hlsl::PipelineOptions::default()).write(&module, &info, None).unwrap_or_else(|error| panic!("{name}: HLSL SM 5.1: {error}"));
        assert!(!name.eq("forward") || hlsl_source.contains("SV_Coverage"), "the faded colour entry emits SV_Coverage on DX12");
        let msl_options = msl::Options { lang_version: (2, 4), ..Default::default() };
        msl::write_string(&module, &info, &msl_options, &msl::PipelineOptions::default()).unwrap_or_else(|error| panic!("{name}: MSL 2.4: {error}"));
        let spv_options = spv::Options { lang_version: (1, 3), ..Default::default() };
        spv::write_vec(&module, &info, &spv_options, None).unwrap_or_else(|error| panic!("{name}: SPIR-V 1.3: {error}"));
    }
}

/// The plan's row: an alpha-tested fade keeps alpha-to-coverage (which owns the samples'
/// coverage) and never writes `sample_mask`, which WebGPU refuses beside it; only the opaque
/// colour entry covers samples. naga here; Tint (Chrome) is the gate's row.
#[test]
fn masked_fade_keeps_alpha_to_coverage_and_never_writes_sample_mask() {
    for (name, entries) in FADED_ENTRIES {
        let (module, _) = naga_module(name, source(name));
        for entry in entries.iter().filter(|entry| entry.starts_with("fs_")) {
            assert_eq!(writes_sample_mask(&module, entry), *entry == "fs_main_fade", "{name} {entry}");
        }
    }
    let (forward, _) = naga_module("forward", source("forward"));
    assert!(!writes_sample_mask(&forward, "fs_mask_depth") && !writes_sample_mask(&forward, "fs_main"), "the whole entries are untouched");
}

// ---------------------------------------------------------------------------------------------
// The dither (WGSL, run on the GPU)

/// One dither case: a crossfade's two fades (fade-out `1 - s`, fade-in `-s`), a pixel, the frame
/// key and the samples per pixel. Laid out as the WGSL `Case` (32 bytes).
#[repr(C)]
#[derive(Clone, Copy, Debug, bytemuck::Pod, bytemuck::Zeroable)]
struct DitherCase {
    fade_out: f32,
    fade_in: f32,
    pixel: [f32; 2],
    frame_key: u32,
    samples: u32,
    pad: [u32; 2],
}

/// `common.wgsl`'s dither inside a compute entry: each case's two coverage masks.
fn dither_shader() -> String {
    format!(
        "{}\nstruct Case {{ fade_out: f32, fade_in: f32, pixel: vec2<f32>, frame_key: u32, samples: u32, pad: vec2<u32> }}\n\
         @group(0) @binding(0) var<storage, read> cases: array<Case>;\n\
         @group(0) @binding(1) var<storage, read_write> masks: array<vec2<u32>>;\n\
         @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3<u32>) {{\n\
           let at = id.x + id.y * 65535u * 64u;\n\
           if (at >= arrayLength(&cases)) {{ return; }}\n\
           let c = cases[at];\n\
           let t = gx_lod_fade_threshold(c.pixel, c.frame_key);\n\
           masks[at] = vec2<u32>(gx_lod_fade_coverage(c.fade_out, t, c.samples), gx_lod_fade_coverage(c.fade_in, t, c.samples));\n\
         }}\n",
        include_str!("../shaders/common.wgsl")
    )
}

/// Shares a crossfade passes through, as the cull writes them (a whole number of 1/1024 steps).
fn dither_cases() -> Vec<DitherCase> {
    let mut cases = Vec::new();
    for step in [1u32, 64, 256, 300, 512, 700, 768, 1000, 1023] {
        let share = step as f32 / 1024.0;
        for samples in [1u32, 4] {
            for frame_key in [0u32, 1, 7, 63] {
                for y in 0..32 {
                    for x in 0..32 {
                        cases.push(DitherCase { fade_out: 1.0 - share, fade_in: -share, pixel: [x as f32 + 0.5, y as f32 + 0.5], frame_key, samples, pad: [0; 2] });
                    }
                }
            }
        }
    }
    cases
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_dither_covers_each_sample_once_and_the_incoming_share_in_proportion() {
    let Some(gpu) = gpu() else { return };
    let cases = dither_cases();
    let masks = run_dither(&gpu, &cases);
    let mut groups: std::collections::BTreeMap<(u32, u32, u32), (u32, u32)> = Default::default();
    for (case, [out, fade_in]) in cases.iter().zip(&masks) {
        let full = (1u32 << case.samples) - 1;
        assert_eq!(out & fade_in, 0, "no sample is covered twice: {case:?}");
        assert_eq!(out | fade_in, full, "every sample is covered: {case:?}");
        let key = ((-case.fade_in * 1024.0) as u32, case.samples, case.frame_key);
        let entry = groups.entry(key).or_default();
        entry.0 += fade_in.count_ones();
        entry.1 += case.samples;
    }
    for ((step, samples, frame_key), (covered, total)) in groups {
        let share = step as f32 / 1024.0;
        let shown = covered as f32 / total as f32;
        assert!((shown - share).abs() <= SHARE_TOLERANCE, "share {share}, {samples} samples, frame {frame_key}: the incoming level covers {shown}");
        if samples == 4 && frame_key == 0 {
            // Each pixel's own samples: within a quarter of the share (no stipple).
            for (case, [_, fade_in]) in cases.iter().zip(&masks).filter(|(case, _)| case.samples == 4 && case.frame_key == 0 && (-case.fade_in * 1024.0) as u32 == step) {
                let pixel_share = fade_in.count_ones() as f32 / 4.0;
                assert!((pixel_share - share).abs() <= 0.25, "share {share} at {:?}: pixel {pixel_share}", case.pixel);
            }
        }
    }
}

/// The frames of the shortest TAA jitter cycle (`JitterCycle::Eight`): a settled capture averages
/// them, and every longer cycle (sixteen, TAA upscaling's) holds whole runs of them.
const TEMPORAL_CYCLE: u32 = 8;

/// R-12 (D22: no crossfade stipple under TAA): over any [`TEMPORAL_CYCLE`] consecutive frames the
/// turned one-sample dither keeps each pixel's incoming level in `floor(8 s)` or `ceil(8 s)` of
/// them, so the resolve's average over a cycle shows every pixel at its share (within a frame's
/// eighth) and no pixel-to-pixel stipple. The golden-ratio walk left a pixel up to three eighths
/// off at a half (the 6.74 neighbour luma of GC's 50 % captures against MSAA's 0.35).
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_turned_dither_keeps_each_pixel_by_its_share_over_a_jitter_cycle() {
    let Some(gpu) = gpu() else { return };
    let mut cases = Vec::new();
    let steps = [1u32, 64, 128, 256, 300, 512, 700, 768, 1000, 1023];
    let starts = [0u32, 3, 60, 61, 1_000_003];
    for step in steps {
        let share = step as f32 / 1024.0;
        for start in starts {
            for frame in 0..TEMPORAL_CYCLE {
                for y in 0..16 {
                    for x in 0..16 {
                        let pixel = [x as f32 * 7.0 + 0.5, y as f32 * 5.0 + 0.5];
                        cases.push(DitherCase { fade_out: 1.0 - share, fade_in: -share, pixel, frame_key: start + frame, samples: 1, pad: [0; 2] });
                    }
                }
            }
        }
    }
    let masks = run_dither(&gpu, &cases);
    // (share step, the cycle's first frame, pixel) -> frames the incoming level kept the pixel.
    let mut kept: std::collections::BTreeMap<(u32, u32, [u32; 2]), u32> = Default::default();
    let pixels_per_frame = 16 * 16;
    for (at, (case, [_, fade_in])) in cases.iter().zip(&masks).enumerate() {
        let start = starts[(at / (pixels_per_frame * TEMPORAL_CYCLE as usize)) % starts.len()];
        let step = (-case.fade_in * 1024.0).round() as u32;
        *kept.entry((step, start, case.pixel.map(|v| v as u32))).or_default() += fade_in.count_ones();
    }
    let mut worst = Vec::new();
    for ((step, start, pixel), frames) in kept {
        let exact = step as f32 / 1024.0 * TEMPORAL_CYCLE as f32;
        if (frames as f32) < exact.floor() || (frames as f32) > exact.ceil() {
            worst.push(format!("share {step}/1024 from frame {start} at {pixel:?}: kept {frames} of {TEMPORAL_CYCLE}"));
        }
    }
    assert!(worst.is_empty(), "{} pixels off their share over a cycle, e.g. {:?}", worst.len(), &worst[..worst.len().min(6)]);
}

fn run_dither(gpu: &Gpu, cases: &[DitherCase]) -> Vec<[u32; 2]> {
    let device = &gpu.device;
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("lod dither"), source: wgpu::ShaderSource::Wgsl(dither_shader().into()) });
    let input = wgpu::util::DeviceExt::create_buffer_init(
        device,
        &wgpu::util::BufferInitDescriptor { label: Some("cases"), contents: bytemuck::cast_slice(cases), usage: wgpu::BufferUsages::STORAGE },
    );
    let size = (cases.len() * 8) as u64;
    let output = device.create_buffer(&wgpu::BufferDescriptor { label: Some("masks"), size, usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC, mapped_at_creation: false });
    let staging = device.create_buffer(&wgpu::BufferDescriptor { label: Some("staging"), size, usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("lod dither"),
        layout: None,
        module: &module,
        entry_point: Some("main"),
        compilation_options: Default::default(),
        cache: None,
    });
    let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: None,
        layout: &pipeline.get_bind_group_layout(0),
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: input.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 1, resource: output.as_entire_binding() },
        ],
    });
    let groups = (cases.len() as u32).div_ceil(64);
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
    {
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor::default());
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups(groups.min(65_535), groups.div_ceil(65_535), 1);
    }
    encoder.copy_buffer_to_buffer(&output, 0, &staging, 0, size);
    gpu.queue.submit([encoder.finish()]);
    staging.slice(..).map_async(wgpu::MapMode::Read, |result| result.expect("mapped"));
    device.poll(wgpu::PollType::wait_indefinitely()).expect("done");
    bytemuck::cast_slice(&staging.slice(..).get_mapped_range().expect("mapped range")).to_vec()
}

// ---------------------------------------------------------------------------------------------
// Frames

fn gpu() -> Option<Gpu> {
    let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
    match Gpu::headless() {
        Ok(gpu) => Some(gpu),
        Err(error) if require => panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}"),
        Err(error) => {
            eprintln!("skipped: no WebGPU-core adapter ({error})");
            None
        }
    }
}

fn write_evidence(name: &str, capture: &Capture) {
    if let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") {
        let dir = PathBuf::from(dir);
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join(format!("{name}-{}x{}.bgra", capture.width(), capture.height())), capture.bgra()).expect("evidence");
    }
}

/// A unit square facing +z, twice: level 0 lit from the camera's side (normals +z), its one
/// coarser level the same square with its normals turned away (-z), so a pixel shows which level
/// drew it. The coarser level's error is [`QUAD_ERROR`].
fn two_faced_quad() -> ModelPart {
    let corners = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]];
    let vertices = [1.0f32, -1.0]
        .into_iter()
        .flat_map(|facing| corners.map(|[x, y]| Vertex { position: [x, y, 0.0], normal: [0.0, 0.0, facing], uv: [x + 0.5, 0.5 - y], tangent: [1.0, 0.0, 0.0, 1.0] }))
        .collect();
    let square = |base: u32| vec![base, base + 1, base + 2, base, base + 2, base + 3];
    let lods = LodChain { levels: vec![LodLevel { indices: square(4), error: QUAD_ERROR }] };
    ModelPart { mesh: MeshData { vertices, indices: square(0) }, meshlets: None, lods: Some(lods) }
}

/// A unit cube whose one coarser level is the cube again (the same triangles), error `error`:
/// a crossfade of it should look like the whole cube.
fn twin_cube(error: f32) -> ModelPart {
    let mesh = MeshData::cube();
    let lods = LodChain { levels: vec![LodLevel { indices: mesh.indices.clone(), error }] };
    ModelPart { mesh, meshlets: None, lods: Some(lods) }
}

/// One output path the plan names.
#[derive(Clone, Copy, Debug)]
struct Path {
    name: &'static str,
    preset: QualityPreset,
    class: &'static str,
    /// Force the `Equal`-depth main pass over the prepass (1x paths only).
    equal: bool,
}

const PATHS: [Path; 4] = [
    Path { name: "desktop-medium-msaa", preset: QualityPreset::Medium, class: "desktop-mid", equal: false },
    Path { name: "desktop-high-taa", preset: QualityPreset::High, class: "desktop-high", equal: false },
    Path { name: "desktop-high-equal", preset: QualityPreset::High, class: "desktop-high", equal: true },
    Path { name: "mobile-high", preset: QualityPreset::High, class: "mobile-high", equal: false },
];

fn frame_renderer(gpu: &Gpu, path: Path) -> FrameRenderer {
    let class = DeviceClass::from_wire(path.class).unwrap_or_else(|| panic!("{} is a class", path.class));
    // The preset's paths (anti-aliasing, prepass, `Equal`) with the tonemapper and exposure off,
    // so the picture is linear light under the sRGB encoding and a share reads as a mix.
    let mut quality = preset_quality(path.preset, class);
    quality.tonemap = false;
    quality.exposure = false;
    let options = RenderOptions { msaa: genex_render::renderer::landed_samples(quality.anti_aliasing) > 1 };
    let mut renderer = FrameRenderer::new(gpu, WIDTH, HEIGHT, options).expect("renderer");
    let inner = renderer.renderer_mut();
    inner.set_scene_format(SceneFormat::Rgba16Float);
    inner.set_device_class(class);
    inner.set_quality(&quality);
    if path.equal {
        inner.set_equal_depth_reuse(Some(true));
    }
    renderer
}

/// The camera at the origin looking down -z.
fn down_z() -> CameraDesc {
    CameraDesc::look_at([0.0, 0.0, 0.0], [0.0, 0.0, -1.0])
}

/// The quad `distance` metres down -z, its levels chosen with `bias` (huge: level 0 whole; tiny:
/// the coarser level whole), under a sun behind the camera.
fn quad_scene(mesh: MeshId, distance: f32, bias: f32, band: f32) -> Scene {
    let mut scene = Scene::new(down_z(), [10, 12, 16, 255]);
    scene.lighting.sun_dir = [0.0, 0.2, 1.0];
    scene.lighting.shadows = false;
    scene.lod_band = band;
    scene.set_lod(DrawLod { origin: None, bias, ..DrawLod::OWN });
    scene.draw(mesh, translation(0.0, 0.0, -distance), Material::color([150, 140, 125, 255]));
    scene
}

fn plan_of(scene: &Scene, renderer: &FrameRenderer) -> FramePlan {
    let mut plan = FramePlan::build(scene, renderer.renderer().library(), WIDTH as f32 / HEIGHT as f32).expect("plan");
    // At the renderer's quality threshold, as its frames choose levels (game systems LOD-06).
    plan.set_lod_view(HEIGHT, renderer.renderer().quality().lod.threshold_px);
    plan
}

/// The camera view's incoming share of row 0 (the fade-in batch's survivor), if it is fading.
fn incoming_share(plan: &FramePlan) -> Option<f32> {
    let cull = plan.cpu_cull();
    plan.batches.iter().zip(&cull.counts).filter(|(batch, count)| batch.lod[0] & LOD_FADE_TAG != 0 && **count > 0).find_map(|(batch, _)| {
        let fade = cull.fades[batch.first_instance as usize][0];
        (fade <= 0.0).then_some(-fade)
    })
}

/// The distance at which the row `scene_at` draws fades in with share `target`: a bisection over
/// its progress through the band (0 the finer level whole, its incoming share while fading, 1 the
/// coarser level whole), which rises with distance.
fn distance_for(renderer: &FrameRenderer, scene_at: &dyn Fn(f32) -> Scene, target: f32) -> f32 {
    let progress = |distance: f32| {
        let scene = scene_at(distance);
        incoming_share(&plan_of(&scene, renderer)).unwrap_or(if is_coarse(renderer, &scene) { 1.0 } else { 0.0 })
    };
    let (mut near, mut far) = (0.5_f32, 200.0_f32);
    for _ in 0..60 {
        let middle = 0.5 * (near + far);
        if progress(middle) >= target {
            far = middle;
        } else {
            near = middle;
        }
    }
    far
}

/// Whether `scene`'s row 0 is drawn whole by its coarser level.
fn is_coarse(renderer: &FrameRenderer, scene: &Scene) -> bool {
    let plan = plan_of(scene, renderer);
    let cull = plan.cpu_cull();
    plan.batches.iter().zip(&cull.counts).any(|(batch, count)| batch.lod[0] & LOD_FADE_TAG == 0 && batch.lod[0] & 0xF > 0 && *count > 0)
}

/// A settled capture of `scene` (a whole jitter cycle on temporal paths).
fn settled(gpu: &Gpu, renderer: &mut FrameRenderer, scene: Scene) -> Capture {
    let frames = renderer.settle_frames();
    renderer.render_settled(gpu, &ImmediateFrame::from_scene(scene), CullPath::Gpu, None, frames).expect("settled frame");
    renderer.capture(gpu).expect("capture")
}

/// A BGRA pixel's linear luminance, 0..255 (its sRGB encoding undone: shares mix linear light).
fn luma(pixel: &[u8]) -> f32 {
    let linear = |byte: u8| {
        let c = f32::from(byte) / 255.0;
        if c <= 0.04045 { c / 12.92 } else { libm::powf((c + 0.055) / 1.055, 2.4) }
    };
    255.0 * (0.0722 * linear(pixel[0]) + 0.7152 * linear(pixel[1]) + 0.2126 * linear(pixel[2]))
}

/// What a crossfade's capture shows against its two levels drawn whole.
#[derive(Debug)]
struct Shown {
    /// The incoming level's mean share over the quad's inside.
    share: f32,
    /// The variance of the per-pixel share there.
    variance: f32,
    /// Pixels both levels cover that the crossfade left at the clear colour.
    holes: usize,
    /// The mean linear-luma step (0..255) from each inside pixel to its right and lower
    /// neighbours: a stipple lifts it far above the quad's own shading gradient.
    neighbour: f32,
    /// The inside's pixels.
    inside: usize,
}

/// The incoming share `pair` shows, per pixel `(finer - pair) / (finer - coarser)` in luma over
/// the pixels whose 3x3 neighbourhood the two levels tell apart.
fn shown(finer: &Capture, coarser: &Capture, pair: &Capture, clear: [u8; 3]) -> Shown {
    let (w, h) = (finer.width() as usize, finer.height() as usize);
    let px = |capture: &Capture, x: usize, y: usize| -> [u8; 4] {
        let at = (y * w + x) * 4;
        capture.bgra()[at..at + 4].try_into().expect("pixel")
    };
    let contrast = |x: usize, y: usize| (luma(&px(finer, x, y)) - luma(&px(coarser, x, y))).abs() >= CONTRAST_MIN;
    let is_clear = |p: [u8; 4]| p[..3].iter().zip([clear[2], clear[1], clear[0]]).all(|(a, b)| a.abs_diff(b) <= CHANNEL_TOLERANCE);
    let (mut shares, mut holes) = (Vec::new(), 0);
    let mut steps = Vec::new();
    for y in 1..h - 1 {
        for x in 1..w - 1 {
            let covered = !is_clear(px(finer, x, y)) && !is_clear(px(coarser, x, y));
            holes += usize::from(covered && is_clear(px(pair, x, y)));
            if (0..9).all(|k| contrast(x + k % 3 - 1, y + k / 3 - 1)) {
                let (f, c, p) = (luma(&px(finer, x, y)), luma(&px(coarser, x, y)), luma(&px(pair, x, y)));
                shares.push(((f - p) / (f - c)).clamp(0.0, 1.0));
                steps.push((p - luma(&px(pair, x + 1, y))).abs());
                steps.push((p - luma(&px(pair, x, y + 1))).abs());
            }
        }
    }
    let inside = shares.len();
    let share = shares.iter().sum::<f32>() / inside.max(1) as f32;
    let variance = shares.iter().map(|s| (s - share) * (s - share)).sum::<f32>() / inside.max(1) as f32;
    let neighbour = steps.iter().sum::<f32>() / steps.len().max(1) as f32;
    Shown { share, variance, holes, neighbour, inside }
}

/// The plan's red row: a crossfading pair at shares 0.25, 0.5 and 0.75 on `path` shows the
/// incoming level within 1/16 of its share with at most two hole pixels.
fn crossfade_row(gpu: &Gpu, path: Path) -> Vec<(f32, Shown)> {
    let mut renderer = frame_renderer(gpu, path);
    let mesh = renderer.add_model_parts(gpu, vec![two_faced_quad()]).expect("added")[0];
    let clear = [10, 12, 16];
    let mut rows = Vec::new();
    for target in [0.25, 0.5, 0.75] {
        let distance = distance_for(&renderer, &|distance| quad_scene(mesh, distance, 1.0, BAND), target);
        let finer = settled(gpu, &mut renderer, quad_scene(mesh, distance, 1.0e6, 0.0));
        let coarser = settled(gpu, &mut renderer, quad_scene(mesh, distance, 1.0e-6, 0.0));
        let pair = settled(gpu, &mut renderer, quad_scene(mesh, distance, 1.0, BAND));
        let plan = plan_of(&quad_scene(mesh, distance, 1.0, BAND), &renderer);
        let share = incoming_share(&plan).expect("the pair is fading");
        let gpu_fades = renderer.renderer().read_view_fades(gpu, 0).expect("fades");
        let cpu = plan.cpu_cull();
        for (batch, count) in plan.batches.iter().zip(&cpu.counts).filter(|(batch, _)| batch.lod[0] & LOD_FADE_TAG != 0) {
            let range = batch.first_instance as usize..(batch.first_instance + count) as usize;
            assert_eq!(gpu_fades[range.clone()], cpu.fades[range], "{}: the GPU cull's fades are the CPU's", path.name);
        }
        let tag = format!("lod-fade-{}-{}", path.name, (target * 100.0) as u32);
        write_evidence(&format!("{tag}-finer"), &finer);
        write_evidence(&format!("{tag}-coarser"), &coarser);
        write_evidence(&format!("{tag}-pair"), &pair);
        let result = shown(&finer, &coarser, &pair, clear);
        eprintln!("{}: target {target} at {distance:.4} m: fade-in share {share}, shown {result:?}", path.name);
        assert!(result.inside > 2_000, "{}: the quad fills the frame's middle ({} pixels)", path.name, result.inside);
        rows.push((share, result));
    }
    rows
}

fn assert_crossfade(path: Path, rows: &[(f32, Shown)]) {
    for (share, result) in rows {
        assert!((result.share - share).abs() <= SHARE_TOLERANCE, "{}: share {share}, the incoming level shows {}", path.name, result.share);
        assert!(result.holes <= HOLE_PIXELS_MAX, "{}: share {share}: {} hole pixels", path.name, result.holes);
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_crossfading_pair_shows_its_share_on_desktop_medium_msaa_without_stipple() {
    let Some(gpu) = gpu() else { return };
    let path = PATHS[0];
    let quality = preset_quality(path.preset, DeviceClass::from_wire(path.class).expect("class"));
    assert!(genex_render::renderer::landed_samples(quality.anti_aliasing) > 1, "desktop-medium draws MSAA: {:?}", quality.anti_aliasing);
    let rows = crossfade_row(&gpu, path);
    assert_crossfade(path, &rows);
    for (share, result) in &rows {
        assert!(result.variance <= MSAA_SHARE_VARIANCE_MAX, "share {share}: per-pixel share variance {} (a stipple)", result.variance);
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_crossfading_pair_shows_its_share_on_desktop_high_taa_with_the_motion_prepass() {
    let Some(gpu) = gpu() else { return };
    let path = PATHS[1];
    let quality = preset_quality(path.preset, DeviceClass::from_wire(path.class).expect("class"));
    assert!(quality.anti_aliasing.temporal(), "desktop-high draws TAA: {:?}", quality.anti_aliasing);
    assert_crossfade(path, &crossfade_row(&gpu, path));
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_crossfading_pair_shows_its_share_with_an_equal_main_pass() {
    let Some(gpu) = gpu() else { return };
    let path = PATHS[2];
    assert_crossfade(path, &crossfade_row(&gpu, path));
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_crossfading_pair_shows_its_share_on_mobile_high() {
    let Some(gpu) = gpu() else { return };
    let path = PATHS[3];
    assert_crossfade(path, &crossfade_row(&gpu, path));
}

/// How much more pixel-to-pixel step a temporal path's settled crossfade may show than MSAA's
/// (R-12: within 2x of MSAA, whose four samples cover each pixel in proportion).
const TEMPORAL_NEIGHBOUR_RATIO_MAX: f32 = 2.0;

/// R-12 (D22: no crossfade stipple): a crossfading pair's settled capture on each temporal path
/// (TAA with the motion prepass, the `Equal` main pass, mobile-high) steps from pixel to pixel
/// within [`TEMPORAL_NEIGHBOUR_RATIO_MAX`] of the MSAA path's at the same share. Red on the
/// golden-ratio walk: 6.74 against 0.35 at a half (GC visual r2).
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_temporal_crossfades_show_no_more_stipple_than_msaa() {
    let Some(gpu) = gpu() else { return };
    let msaa = crossfade_row(&gpu, PATHS[0]);
    let mut failures = Vec::new();
    for path in &PATHS[1..] {
        for ((share, temporal), (_, reference)) in crossfade_row(&gpu, *path).iter().zip(&msaa) {
            eprintln!("{}: share {share}: neighbour step {:.3} against MSAA's {:.3}", path.name, temporal.neighbour, reference.neighbour);
            if temporal.neighbour > TEMPORAL_NEIGHBOUR_RATIO_MAX * reference.neighbour {
                failures.push(format!("{} at {share}: {:.3} against MSAA's {:.3}", path.name, temporal.neighbour, reference.neighbour));
            }
        }
    }
    assert!(failures.is_empty(), "a stipple under the temporal crossfade: {failures:?}");
}

/// The plan's acceptance: a cube crossfading with itself (its coarser level the same triangles)
/// over a ground, in the sun's shadows, looks like the whole cube: the ground and the shadow
/// differ in at most [`PAIR_GROUND_PIXELS_MAX`] pixels (the casters' faded entries cover each
/// shadow texel once).
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_ground_and_shadow_under_a_fading_pair_match_the_whole_cubes() {
    let Some(gpu) = gpu() else { return };
    for path in [PATHS[0], PATHS[1]] {
        let mut renderer = frame_renderer(&gpu, path);
        let mesh = renderer.add_model_parts(&gpu, vec![twin_cube(0.02)]).expect("added")[0];
        let scene_at = |distance: f32, band: f32| {
            let mut camera = CameraDesc::look_at([0.0, 1.2, 0.0], [0.0, 0.0, -distance]);
            camera.far = 500.0;
            let mut scene = Scene::new(camera, [40, 50, 70, 255]);
            scene.lighting.shadows = true;
            scene.lighting.sun_dir = [0.5, 1.0, 0.3];
            scene.lod_band = band;
            scene.draw(MeshId::CUBE, scaled([0.0, -0.05, -distance], [8.0, 0.1, 8.0]), Material::color([190, 190, 190, 255]));
            scene.draw(mesh, translation(0.0, 0.5, -distance), Material::color([200, 120, 60, 255]));
            scene
        };
        let distance = distance_for(&renderer, &|distance| scene_at(distance, BAND), 0.5);
        let plan = plan_of(&scene_at(distance, BAND), &renderer);
        assert!(incoming_share(&plan).is_some(), "{}: the cube is fading", path.name);
        let whole = settled(&gpu, &mut renderer, scene_at(distance, 0.0));
        let pair = settled(&gpu, &mut renderer, scene_at(distance, BAND));
        write_evidence(&format!("lod-fade-shadow-{}-whole", path.name), &whole);
        write_evidence(&format!("lod-fade-shadow-{}-pair", path.name), &pair);
        let differing = whole.bgra().chunks(4).zip(pair.bgra().chunks(4)).filter(|(a, b)| a.iter().zip(b.iter()).any(|(p, q)| p.abs_diff(*q) > CHANNEL_TOLERANCE)).count();
        eprintln!("{}: at {distance:.3} m, {differing} pixels differ from the whole cube's", path.name);
        assert!(differing <= PAIR_GROUND_PIXELS_MAX, "{}: {differing} pixels differ", path.name);
    }
}

/// A cube whose one coarser level is its bottom face alone (which a light above never casts
/// through, its back face culled): a crossfade's spot shadow is the cube's, cut to the finer
/// level's share.
fn cube_and_its_bottom() -> ModelPart {
    let mesh = MeshData::cube();
    // The cube's fourth face (normal -y): indices 18..24.
    let bottom = mesh.indices[18..24].to_vec();
    assert!(bottom.iter().all(|at| mesh.vertices[*at as usize].normal == [0.0, -1.0, 0.0]), "the bottom face");
    let lods = LodChain { levels: vec![LodLevel { indices: bottom, error: 0.02 }] };
    ModelPart { mesh, meshlets: None, lods: Some(lods) }
}

/// The rows' shadowed spot: high to the side of the cube, aimed at it.
fn side_spot(shadow: bool) -> genex_render::lights::SpotLight {
    let (position, target): ([f32; 3], [f32; 3]) = ([2.5, 6.0, 0.0], [0.0, 0.0, 0.0]);
    let d = [target[0] - position[0], target[1] - position[1], target[2] - position[2]];
    let length = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
    genex_render::lights::SpotLight {
        position,
        direction: d.map(|v| v / length),
        range: 20.0,
        color: [255, 255, 255],
        intensity: 60.0,
        inner_angle: 30f32.to_radians(),
        outer_angle: 40f32.to_radians(),
        shadow,
    }
}

/// The plan's casters row for spots: a shadowed spot casts a crossfade's two levels as the sun's
/// casters do, each texel by one level, so the shadow of a cube crossfading into its own bottom
/// face (which casts nothing) holds the cube's share of the whole cube's shadow. Before the faded
/// spot casters both levels cast whole: the cube's whole shadow.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_spot_casts_each_level_of_a_crossfade_by_its_share() {
    use genex_render::layout::MAX_LOCAL_LIGHTS;
    let Some(gpu) = gpu() else { return };
    let class = DeviceClass::from_wire("desktop-ultra").expect("class");
    let mut quality = genex_render::settings::Quality::off();
    quality.hdr = true;
    quality.shadows = preset_quality(QualityPreset::High, class).shadows;
    quality.shadows.screen_mask = false;
    quality.lights.clustered = true;
    quality.lights.cap = MAX_LOCAL_LIGHTS as u32;
    quality.lights.tile_px = 16;
    quality.lights.shadowed_spots = 1;
    let mut renderer = genex_render::Renderer::with_options(&gpu, WIDTH, HEIGHT, RenderOptions { msaa: false }).expect("renderer");
    renderer.set_quality(&quality);
    renderer.set_scene_format(SceneFormat::Rgba16Float);
    let mesh = renderer.add_model_parts(&gpu, vec![cube_and_its_bottom()]).expect("added")[0];
    let scene_at = |bias: f32, band: f32, cube: bool, shadow: bool| {
        let mut camera = CameraDesc::look_at([-1.0, 5.0, 7.0], [-1.5, 0.0, 0.0]);
        camera.far = 200.0;
        let mut scene = Scene::new(camera, [10, 12, 16, 255]);
        scene.lighting.sun_intensity = 0.0;
        scene.lighting.shadows = true;
        scene.lighting.spots.push(side_spot(shadow));
        scene.lod_band = band;
        scene.draw(MeshId::CUBE, scaled([0.0, -0.05, 0.0], [12.0, 0.1, 12.0]), Material::color([200, 200, 200, 255]));
        if cube {
            scene.set_lod(DrawLod { bias, ..DrawLod::OWN });
            scene.draw(mesh, translation(0.0, 0.5, 0.0), Material::color([200, 120, 60, 255]));
        }
        scene
    };
    // The bias that makes the cube fade in to its bottom with share 0.5 (the share falls as the
    // bias rises): a bisection in log space.
    let share_at = |bias: f32| {
        let mut plan = FramePlan::build(&scene_at(bias, BAND, true, true), renderer.library(), WIDTH as f32 / HEIGHT as f32).expect("plan");
        plan.set_lod_height(HEIGHT);
        incoming_share(&plan).unwrap_or(if is_coarse_plan(&plan) { 1.0 } else { 0.0 })
    };
    let (mut low, mut high) = (-6.0_f32, 6.0_f32);
    for _ in 0..60 {
        let middle = 0.5 * (low + high);
        if share_at(libm::powf(10.0, middle)) >= 0.5 {
            low = middle;
        } else {
            high = middle;
        }
    }
    let bias = libm::powf(10.0, low);
    let share = share_at(bias);
    assert!((share - 0.5).abs() < 0.01, "the cube fades to its bottom at {share}");
    let mut capture = |scene: Scene| {
        renderer.render(&gpu, &scene, CullPath::Gpu).expect("frame");
        renderer.capture(&gpu).expect("capture")
    };
    let bare = capture(scene_at(bias, 0.0, false, true));
    let whole = capture(scene_at(1.0e6, 0.0, true, true));
    let pair = capture(scene_at(bias, BAND, true, true));
    let unshadowed = capture(scene_at(1.0e6, 0.0, true, false));
    write_evidence("lod-fade-spot-bare", &bare);
    write_evidence("lod-fade-spot-whole", &whole);
    write_evidence("lod-fade-spot-pair", &pair);
    write_evidence("lod-fade-spot-unshadowed", &unshadowed);
    // The shadow: ground pixels the whole cube darkens, the cube's own pixels left out.
    let (mut ratio, mut pixels) = (0.0f64, 0usize);
    for at in (0..bare.bgra().len()).step_by(4) {
        let px = |c: &Capture| luma(&c.bgra()[at..at + 4]);
        let cube_here = (px(&unshadowed) - px(&bare)).abs() > 1.0;
        let darkened = px(&bare) - px(&whole);
        if cube_here || darkened < 4.0 {
            continue;
        }
        ratio += f64::from(((px(&bare) - px(&pair)) / darkened).clamp(0.0, 1.5));
        pixels += 1;
    }
    let shown = (ratio / pixels.max(1) as f64) as f32;
    eprintln!("spot shadow under a crossfade of share {share}: {shown:.3} of the whole cube's over {pixels} pixels");
    assert!(pixels > 200, "the cube's spot shadow is in view ({pixels} pixels)");
    assert!((shown - (1.0 - share)).abs() <= 0.15, "the finer level's share {} of the shadow, shown {shown}", 1.0 - share);
}

/// Whether `plan`'s row 0 is drawn whole by its coarser level (the fixture's one LOD draw).
fn is_coarse_plan(plan: &FramePlan) -> bool {
    let cull = plan.cpu_cull();
    plan.batches.iter().zip(&cull.counts).any(|(batch, count)| batch.lod[0] & LOD_FADE_TAG == 0 && batch.lod[0] & 0xF > 0 && *count > 0)
}
