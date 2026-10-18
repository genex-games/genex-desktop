//! A.9 motion blur: the look's shutter, KinoMotion's reconstruction (desktop high and ultra) and
//! Bevy's direct blur (low, medium and phones; none on the low-tier phone), after TAA and depth of
//! field and before `post-hdr` (node 18).
//!
//! The CPU rows run everywhere. The GPU rows are `#[ignore]`d and every name contains `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked --test motion_blur -- --ignored metal --test-threads=1
//!
//! The GPU rows draw the node over synthetic frames: a CPU-built HDR scene, depth and NDC motion
//! (rectangles at world distances seen through a reverse-Z infinite projection, each moving by a
//! whole number of render pixels a frame) uploaded as the textures the renderer hands the node.
//! `GENEX_RENDER_EVIDENCE_DIR` receives the moving and tracked prop frames as BMP images and
//! `GENEX_PERF_OUT` the cost rows as JSON lines.

use genex_render::Gpu;
use genex_render::device_class::{DeviceClass, FormFactor, PerformanceTier};
use genex_render::post::motion_blur::{
    DEFAULT_SHUTTER, GpuMotionBlurParams, MotionBlur, MotionBlurFrame, MotionBlurFrameSettings, MotionBlurInput, MotionBlurNode, MotionBlurTier, MotionBlurTimestamps, frame_settings,
    max_radius_px, sources, target_bytes, targets, tile_px,
};
use genex_render::presets::preset_quality;
use genex_render::settings::{Look, Quality, QualityPreset};
use genex_render::target_pool::TargetPool;
use glam::Mat4;

const NEAR: f32 = 0.1;
const FOV_Y_DEG: f32 = 60.0;
/// The budget at 1080p (TIER-AB plan A.9: motion blur at most 0.5 ms).
const MOTION_BLUR_MS_MAX: f32 = 0.5;
/// Nodes a cost sample records back to back (a lone pass after an idle wait pays the GPU's wake-up).
const COST_NODES_PER_SAMPLE: u32 = 16;
/// Cost samples per row (the row reports their median).
const COST_SAMPLES: usize = 15;
/// Samples drawn and dropped before the measured ones (the GPU's clocks ramp up over them).
const COST_WARM_UP_SAMPLES: usize = 5;
const TIERS: [MotionBlurTier; 2] = [MotionBlurTier::Direct, MotionBlurTier::Reconstruction];

fn proj(size: (u32, u32)) -> Mat4 {
    glam::camera::rh::proj::directx::perspective_infinite_reverse(FOV_Y_DEG.to_radians(), size.0 as f32 / size.1 as f32, NEAR)
}

/// The reverse-Z depth-buffer value of a surface `distance` world units along the view axis.
fn depth_of(distance: f32) -> f32 {
    NEAR / distance
}

fn desktop(tier: PerformanceTier) -> DeviceClass {
    DeviceClass::new(FormFactor::Desktop, tier)
}

fn high() -> Quality {
    preset_quality(QualityPreset::High, desktop(PerformanceTier::High))
}

// ---------------------------------------------------------------------------------------------
// CPU rows

#[test]
fn motion_blur_is_a_look_switch_that_is_off_by_default() {
    let quality = high();
    assert_eq!(Look::default().motion_blur, MotionBlur::OFF);
    assert!(!MotionBlur::default().enabled);
    assert_eq!(MotionBlur::OFF.shutter, DEFAULT_SHUTTER);
    assert_eq!(frame_settings(&Look::default().motion_blur, &quality, true, true, MotionBlurFrame::Live), None, "off by default");
    let on = MotionBlur::shutter(0.5);
    assert_eq!(Look::default().with_motion_blur(on).motion_blur, on);
    assert_eq!(frame_settings(&on, &quality, true, true, MotionBlurFrame::Live), Some(MotionBlurFrameSettings { settings: on, tier: MotionBlurTier::Reconstruction }));
    assert_eq!(frame_settings(&on, &quality, false, true, MotionBlurFrame::Live), None, "the legacy LDR scene has no motion blur");
    assert_eq!(frame_settings(&on, &quality, true, false, MotionBlurFrame::Live), None, "a frame that wrote no motion has nothing to blur by");
    assert_eq!(frame_settings(&MotionBlur::shutter(0.0), &quality, true, true, MotionBlurFrame::Live), None, "a shut shutter blurs nothing");
    let mut off = quality;
    off.motion_blur = MotionBlurTier::Off;
    assert_eq!(frame_settings(&on, &off, true, true, MotionBlurFrame::Live), None, "the preset's tier is off");
}

#[test]
fn a_settled_capture_draws_without_motion_blur_unless_its_shot_asks() {
    let quality = preset_quality(QualityPreset::Ultra, desktop(PerformanceTier::Ultra));
    let on = MotionBlur::shutter(0.5);
    assert_eq!(frame_settings(&on, &quality, true, true, MotionBlurFrame::Settled { shot_asks: false }), None);
    assert!(frame_settings(&on, &quality, true, true, MotionBlurFrame::Settled { shot_asks: true }).is_some());
    assert!(frame_settings(&MotionBlur::OFF, &quality, true, true, MotionBlurFrame::Settled { shot_asks: true }).is_none(), "the shot asks for the look's, not its own");
}

#[test]
fn the_reconstruction_draws_at_desktop_high_and_ultra_the_direct_blur_elsewhere_and_none_on_the_low_phone() {
    for (preset, tier) in [
        (QualityPreset::Low, MotionBlurTier::Direct),
        (QualityPreset::Medium, MotionBlurTier::Direct),
        (QualityPreset::High, MotionBlurTier::Reconstruction),
        (QualityPreset::Ultra, MotionBlurTier::Reconstruction),
    ] {
        assert_eq!(preset_quality(preset, desktop(PerformanceTier::High)).motion_blur, tier, "desktop {preset:?}");
    }
    for preset in [QualityPreset::Low, QualityPreset::Medium, QualityPreset::High, QualityPreset::Ultra] {
        for tier in PerformanceTier::ALL {
            let phone = DeviceClass::new(FormFactor::Mobile, tier);
            let expected = if tier == PerformanceTier::Low { MotionBlurTier::Off } else { MotionBlurTier::Direct };
            assert_eq!(preset_quality(preset, phone).motion_blur, expected, "phone {tier:?} {preset:?}");
        }
    }
    assert_eq!(Quality::off().motion_blur, MotionBlurTier::Off);
}

#[test]
fn the_shutter_is_held_to_its_range() {
    assert_eq!(MotionBlur { enabled: true, shutter: f32::NAN }.held().shutter, DEFAULT_SHUTTER);
    assert_eq!(MotionBlur { enabled: true, shutter: 3.0 }.held().shutter, 1.0);
    assert_eq!(Look::default().with_motion_blur(MotionBlur { enabled: true, shutter: -1.0 }).motion_blur.shutter, 0.0);
}

#[test]
fn the_targets_are_core_formats_and_ledgered() {
    for render in [(1920, 1080), (1000, 563), (2560, 1440), (3840, 2160), (1, 1)] {
        for tier in TIERS {
            for target in targets(render, tier, Some(wgpu::TextureFormat::Rgba16Float)) {
                genex_render::target_pool::validate(&target).unwrap_or_else(|refusal| panic!("{tier:?} {render:?}: {refusal}"));
            }
        }
    }
    assert_eq!(target_bytes((1920, 1080), MotionBlurTier::Direct, None), 0, "the direct blur reads the motion and the depth as they are");
    let reconstruction = target_bytes((1920, 1080), MotionBlurTier::Reconstruction, None);
    println!("motion blur targets at 1080p: reconstruction {reconstruction} B, own output +{} B", 1920 * 1080 * 8);
    // Each pixel's packed velocity and distance (r32uint), the 16 px blocks (rgba16float, a storage
    // format) and the 48 px tiles' neighbourhood (rg16float).
    assert_eq!(reconstruction, 1920 * 1080 * 4 + 120 * 68 * 8 + 40 * 23 * 4);
    assert_eq!(target_bytes((1920, 1080), MotionBlurTier::Direct, Some(wgpu::TextureFormat::Rgba16Float)), 1920 * 1080 * 8);
    assert!(targets((1920, 1080), MotionBlurTier::Off, None).is_empty());
}

#[test]
fn the_row_carries_the_shutter_the_radius_and_the_tile() {
    let render = (1920, 1080);
    let frame = MotionBlurFrameSettings { settings: MotionBlur::shutter(0.5), tier: MotionBlurTier::Reconstruction };
    let row = GpuMotionBlurParams::new(&frame, proj(render), render);
    assert_eq!(size_of::<GpuMotionBlurParams>(), 64);
    // A pixel moving 100 px right and 40 px down a frame (NDC x right, y up) under a 180-degree
    // shutter: an exposure of 50 x 20 px, blurred 25 x 10 px each way.
    let ndc = [100.0 * 2.0 / 1920.0, -40.0 * 2.0 / 1080.0];
    let half = [ndc[0] * row.velocity[0], ndc[1] * row.velocity[1]];
    assert!((half[0] - 25.0).abs() < 1e-3 && (half[1] - 10.0).abs() < 1e-3, "{half:?}");
    assert!((row.velocity[2] - 37.8).abs() < 1e-3 && (row.velocity[3] * row.velocity[2] - 1.0).abs() < 1e-6);
    assert_eq!(max_radius_px(1080), row.velocity[2]);
    assert_eq!(row.size, [1920.0, 1080.0, 48.0, 3.0]);
    assert_eq!(tile_px(1080), 48);
}

/// `source` (`name`) validated against WebGPU core and written as HLSL SM 5.1, MSL 2.4 and SPIR-V
/// 1.3 (the tests/layout.rs row every renderer shader passes).
fn emits_everywhere(name: &str, source: &str) {
    use naga::back::{hlsl, msl, spv};
    let module = naga::front::wgsl::parse_str(source).unwrap_or_else(|error| panic!("{name}: {}", error.emit_to_string(source)));
    let info = naga::valid::Validator::new(naga::valid::ValidationFlags::all(), naga::valid::Capabilities::empty())
        .validate(&module)
        .unwrap_or_else(|error| panic!("{name} needs more than WebGPU core: {error:?}"));
    assert!(source.len() <= genex_render::WGSL_MAX_BYTES, "{name}: {} bytes", source.len());
    let mut hlsl_source = String::new();
    let options = hlsl::Options { shader_model: hlsl::ShaderModel::V5_1, ..Default::default() };
    hlsl::Writer::new(&mut hlsl_source, &options, &hlsl::PipelineOptions::default()).write(&module, &info, None).unwrap_or_else(|error| panic!("{name}: HLSL: {error:?}"));
    let options = msl::Options { lang_version: (2, 4), ..Default::default() };
    msl::write_string(&module, &info, &options, &msl::PipelineOptions::default()).unwrap_or_else(|error| panic!("{name}: MSL: {error:?}"));
    let options = spv::Options { lang_version: (1, 3), ..Default::default() };
    spv::write_vec(&module, &info, &options, None).unwrap_or_else(|error| panic!("{name}: SPIR-V: {error:?}"));
}

#[test]
fn every_module_validates_against_webgpu_core_and_emits_hlsl_msl_and_spirv() {
    let all = sources();
    assert_eq!(all.len(), 4);
    for (name, source) in all {
        emits_everywhere(&name, &source);
    }
}

// ---------------------------------------------------------------------------------------------
// GPU rows: synthetic frames

fn gpu() -> Option<Gpu> {
    let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
    match Gpu::headless() {
        Ok(gpu) => {
            if require {
                assert_eq!(gpu.receipt().backend, "metal", "GENEX_REQUIRE_METAL=1 but the adapter is not Metal");
            }
            Some(gpu)
        }
        Err(error) if require => panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}"),
        Err(error) => {
            eprintln!("skipped: no WebGPU-core adapter ({error})");
            None
        }
    }
}

/// How a rectangle is coloured, in its own (moving) coordinates.
#[derive(Clone, Copy)]
enum Paint {
    Solid([f32; 3]),
    /// Vertical stripes `period` pixels wide, alternating `a` and `b`.
    Stripes { a: [f32; 3], b: [f32; 3], period: u32 },
    /// Horizontal stripes `period` pixels tall.
    Rows { a: [f32; 3], b: [f32; 3], period: u32 },
    /// A deterministic texture of uneven stripes and blotches (the pan rows' wall).
    Texture,
}

impl Paint {
    /// The colour at the rectangle's own pixel `(u, v)`.
    fn at(self, u: i64, v: i64) -> [f32; 3] {
        match self {
            Paint::Solid(rgb) => rgb,
            Paint::Stripes { a, b, period } => {
                if u.div_euclid(i64::from(period)) % 2 == 0 {
                    a
                } else {
                    b
                }
            }
            Paint::Rows { a, b, period } => {
                if v.div_euclid(i64::from(period)) % 2 == 0 {
                    a
                } else {
                    b
                }
            }
            Paint::Texture => {
                let wave = libm::sinf(u as f32 * 0.37) * 0.5 + libm::sinf(u as f32 * 0.071 + v as f32 * 0.05) * 0.3 + libm::sinf(v as f32 * 0.13) * 0.2;
                let base = 0.35 + 0.3 * wave;
                [base, base * 0.9 + 0.05, base * 0.7 + 0.1]
            }
        }
    }
}

/// A rectangle: pixels `[x0, x1) x [y0, y1)` at `distance` world units, painted with `paint`
/// offset by `shift` (the content's position this frame) and moving `velocity` render pixels a
/// frame (x right, y down).
#[derive(Clone, Copy)]
struct Rect {
    x0: u32,
    y0: u32,
    x1: u32,
    y1: u32,
    distance: f32,
    paint: Paint,
    shift: (i64, i64),
    velocity: (f32, f32),
}

impl Rect {
    fn still(x0: u32, y0: u32, x1: u32, y1: u32, distance: f32, paint: Paint) -> Rect {
        Rect { x0, y0, x1, y1, distance, paint, shift: (0, 0), velocity: (0.0, 0.0) }
    }

    fn moving(self, velocity: (f32, f32)) -> Rect {
        Rect { velocity, ..self }
    }

    fn shifted(self, shift: (i64, i64)) -> Rect {
        Rect { shift, ..self }
    }
}

/// A synthetic frame: rgb, the depth-buffer value and the NDC motion per pixel (the nearest
/// rectangle wins; the sky, depth 0 and still, where none covers a pixel).
struct Frame {
    size: (u32, u32),
    colour: Vec<[f32; 3]>,
    depth: Vec<f32>,
    motion: Vec<[f32; 2]>,
}

impl Frame {
    fn new(size: (u32, u32), rects: &[Rect]) -> Frame {
        let count = (size.0 * size.1) as usize;
        let mut frame = Frame { size, colour: vec![[0.3, 0.4, 0.6]; count], depth: vec![0.0; count], motion: vec![[0.0; 2]; count] };
        for y in 0..size.1 {
            for x in 0..size.0 {
                let i = (y * size.0 + x) as usize;
                for rect in rects.iter().filter(|r| x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1) {
                    let depth = depth_of(rect.distance);
                    if depth >= frame.depth[i] {
                        frame.depth[i] = depth;
                        frame.colour[i] = rect.paint.at(i64::from(x) - rect.shift.0, i64::from(y) - rect.shift.1);
                        frame.motion[i] = [rect.velocity.0 * 2.0 / size.0 as f32, -rect.velocity.1 * 2.0 / size.1 as f32];
                    }
                }
            }
        }
        frame
    }

    fn index(&self, x: u32, y: u32) -> usize {
        (y * self.size.0 + x) as usize
    }
}

/// f32 to IEEE half bits (round to nearest even; the test's values are finite and in range).
fn f16_bits(value: f32) -> u16 {
    let bits = value.to_bits();
    let sign = ((bits >> 16) & 0x8000) as u16;
    let exponent = ((bits >> 23) & 0xff) as i32 - 127 + 15;
    let mantissa = bits & 0x7f_ffff;
    if exponent <= 0 {
        if exponent < -10 {
            return sign;
        }
        let m = mantissa | 0x80_0000;
        let shift = (14 - exponent) as u32;
        let half = m >> shift;
        let round = (m >> (shift - 1)) & 1;
        return sign | (half + round) as u16;
    }
    if exponent >= 31 {
        return sign | 0x7c00;
    }
    let half = ((exponent as u32) << 10) | (mantissa >> 13);
    let rest = mantissa & 0x1fff;
    let rounded = if rest > 0x1000 || (rest == 0x1000 && half & 1 == 1) { half + 1 } else { half };
    sign | rounded as u16
}

fn f16_value(bits: u16) -> f32 {
    let sign = if bits & 0x8000 != 0 { -1.0 } else { 1.0 };
    let exponent = i32::from((bits >> 10) & 0x1f);
    let mantissa = f32::from(bits & 0x3ff);
    match exponent {
        0 => sign * libm::ldexpf(mantissa, -24),
        31 => sign * f32::INFINITY,
        _ => sign * libm::ldexpf(1.0 + mantissa / 1024.0, exponent - 15),
    }
}

/// A half-float texture of `format` holding `texels` (each `channels` values).
fn half_texture(gpu: &Gpu, size: (u32, u32), format: wgpu::TextureFormat, channels: u32, values: &[f32]) -> wgpu::Texture {
    let extent = wgpu::Extent3d { width: size.0, height: size.1, depth_or_array_layers: 1 };
    let texture = gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("motion blur test texture"),
        size: extent,
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let bytes: Vec<u8> = values.iter().flat_map(|v| f16_bits(*v).to_le_bytes()).collect();
    gpu.queue.write_texture(texture.as_image_copy(), &bytes, wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(size.0 * channels * 2), rows_per_image: None }, extent);
    texture
}

/// The frame's colour as an `rgba16float` texture.
fn colour_texture(gpu: &Gpu, frame: &Frame) -> wgpu::Texture {
    let values: Vec<f32> = frame.colour.iter().flat_map(|rgb| [rgb[0], rgb[1], rgb[2], 1.0]).collect();
    half_texture(gpu, frame.size, wgpu::TextureFormat::Rgba16Float, 4, &values)
}

/// The frame's motion as the prepass's `rg16float` target.
fn motion_texture(gpu: &Gpu, frame: &Frame) -> wgpu::Texture {
    let values: Vec<f32> = frame.motion.iter().flatten().copied().collect();
    half_texture(gpu, frame.size, genex_render::motion::MOTION_FORMAT, 2, &values)
}

/// The frame's depth as a `depth32float` texture of `samples` per pixel: an `r32float` copy
/// written through `frag_depth` (WebGPU copies into no depth32float).
fn depth_texture(gpu: &Gpu, frame: &Frame, samples: u32) -> wgpu::Texture {
    let device = &gpu.device;
    let size = wgpu::Extent3d { width: frame.size.0, height: frame.size.1, depth_or_array_layers: 1 };
    let values = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("motion blur test depth values"),
        size,
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::R32Float,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    let bytes: Vec<u8> = frame.depth.iter().flat_map(|d| d.to_le_bytes()).collect();
    gpu.queue.write_texture(values.as_image_copy(), &bytes, wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(frame.size.0 * 4), rows_per_image: None }, size);
    let depth = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("motion blur test depth"),
        size,
        mip_level_count: 1,
        sample_count: samples,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Depth32Float,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::RENDER_ATTACHMENT,
        view_formats: &[],
    });
    let source = "@group(0) @binding(0) var values: texture_2d<f32>;\n\
        @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {\n\
            let uv = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));\n\
            return vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);\n}\n\
        @fragment fn fs(@builtin(position) p: vec4<f32>) -> @builtin(frag_depth) f32 {\n\
            return textureLoad(values, vec2<i32>(p.xy), 0).r;\n}\n";
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("motion blur test depth"), source: wgpu::ShaderSource::Wgsl(source.into()) });
    let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("motion blur test depth"),
        layout: None,
        vertex: wgpu::VertexState { module: &module, entry_point: Some("vs"), compilation_options: Default::default(), buffers: &[] },
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: Some(wgpu::DepthStencilState {
            format: wgpu::TextureFormat::Depth32Float,
            depth_write_enabled: Some(true),
            depth_compare: Some(wgpu::CompareFunction::Always),
            stencil: Default::default(),
            bias: Default::default(),
        }),
        multisample: wgpu::MultisampleState { count: samples, ..Default::default() },
        fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some("fs"), compilation_options: Default::default(), targets: &[] }),
        multiview_mask: None,
        cache: None,
    });
    let view = values.create_view(&Default::default());
    let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: None,
        layout: &pipeline.get_bind_group_layout(0),
        entries: &[wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&view) }],
    });
    let target = depth.create_view(&Default::default());
    let mut encoder = device.create_command_encoder(&Default::default());
    {
        let attachment = wgpu::RenderPassDepthStencilAttachment {
            view: &target,
            depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(0.0), store: wgpu::StoreOp::Store }),
            stencil_ops: None,
        };
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor { label: None, depth_stencil_attachment: Some(attachment), ..Default::default() });
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.draw(0..3, 0..1);
    }
    gpu.queue.submit([encoder.finish()]);
    depth
}

/// An `rgba16float` texture's texels as f32 rgba.
fn read_rgba16f(gpu: &Gpu, texture: &wgpu::Texture) -> Vec<[f32; 4]> {
    let (width, height) = (texture.width(), texture.height());
    let row = (width * 8).div_ceil(256) * 256;
    let staging = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("motion blur test readback"),
        size: u64::from(row * height),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = gpu.device.create_command_encoder(&Default::default());
    encoder.copy_texture_to_buffer(
        texture.as_image_copy(),
        wgpu::TexelCopyBufferInfo { buffer: &staging, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(row), rows_per_image: None } },
        wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
    );
    gpu.queue.submit([encoder.finish()]);
    let slice = staging.slice(..);
    slice.map_async(wgpu::MapMode::Read, |result| result.expect("map"));
    gpu.device.poll(wgpu::PollType::wait_indefinitely()).expect("poll");
    let data = slice.get_mapped_range().expect("mapped");
    let mut texels = Vec::with_capacity((width * height) as usize);
    for y in 0..height {
        for x in 0..width {
            let at = (y * row + x * 8) as usize;
            texels.push(std::array::from_fn(|c| f16_value(u16::from_le_bytes([data[at + c * 2], data[at + c * 2 + 1]]))));
        }
    }
    texels
}

/// A frame's rgba texels.
type Texels = Vec<[f32; 4]>;

/// The node drawn once over `frame` with `shutter` at `tier` (the depth with `samples` per pixel):
/// the output's texels.
fn draw(gpu: &Gpu, frame: &Frame, shutter: f32, tier: MotionBlurTier, samples: u32) -> Texels {
    let mut node = MotionBlurNode::new(&gpu.device).expect("node");
    draw_with(gpu, &mut node, frame, shutter, tier, samples)
}

fn draw_with(gpu: &Gpu, node: &mut MotionBlurNode, frame: &Frame, shutter: f32, tier: MotionBlurTier, samples: u32) -> Texels {
    let mut pool = TargetPool::new();
    node.acquire(&gpu.device, &mut pool, frame.size, tier, Some(wgpu::TextureFormat::Rgba16Float)).expect("targets");
    let scene = colour_texture(gpu, frame);
    let motion = motion_texture(gpu, frame);
    let depth = depth_texture(gpu, frame, samples);
    let (scene_view, motion_view, depth_view) = (scene.create_view(&Default::default()), motion.create_view(&Default::default()), depth.create_view(&Default::default()));
    let mut encoder = gpu.device.create_command_encoder(&Default::default());
    let input = MotionBlurInput {
        scene: &scene_view,
        motion: &motion_view,
        depth: &depth_view,
        depth_samples: samples,
        output: None,
        render: frame.size,
        proj: proj(frame.size),
        frame: MotionBlurFrameSettings { settings: MotionBlur::shutter(shutter), tier },
    };
    let passes = node.encode(&gpu.device, &gpu.queue, &mut encoder, input, None);
    assert_eq!(passes, tier.passes());
    gpu.queue.submit([encoder.finish()]);
    read_rgba16f(gpu, node.output_texture().expect("own output"))
}

fn luma(rgb: [f32; 4]) -> f32 {
    0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
}

/// The standard deviation of luma over the pixels `select` keeps.
fn luma_deviation(frame: &Frame, texels: &[[f32; 4]], select: impl Fn(u32, u32) -> bool) -> f32 {
    let values: Vec<f32> = (0..frame.size.1)
        .flat_map(|y| (0..frame.size.0).map(move |x| (x, y)))
        .filter(|&(x, y)| select(x, y))
        .map(|(x, y)| luma(texels[frame.index(x, y)]))
        .collect();
    let mean = values.iter().sum::<f32>() / values.len() as f32;
    (values.iter().map(|v| (v - mean) * (v - mean)).sum::<f32>() / values.len() as f32).sqrt()
}

fn input_texels(frame: &Frame) -> Texels {
    frame.colour.iter().map(|rgb| [f16_value(f16_bits(rgb[0])), f16_value(f16_bits(rgb[1])), f16_value(f16_bits(rgb[2])), 1.0]).collect()
}

const SIZE: (u32, u32) = (480, 270);
const GREY_A: [f32; 3] = [0.9, 0.9, 0.9];
const GREY_B: [f32; 3] = [0.05, 0.05, 0.05];
const RED: [f32; 3] = [1.0, 0.05, 0.05];
/// Film's 180-degree shutter.
const SHUTTER: f32 = 0.5;

/// The prop's rectangle on the rows' 480 x 270 frames.
const PROP: (u32, u32, u32, u32) = (180, 90, 300, 180);

/// Chebyshev distance in pixels from `(x, y)` to the prop's rectangle (0 inside).
fn prop_distance_px(x: u32, y: u32) -> u32 {
    let dx = if x < PROP.0 { PROP.0 - x } else { x.saturating_sub(PROP.2 - 1) };
    let dy = if y < PROP.1 { PROP.1 - y } else { y.saturating_sub(PROP.3 - 1) };
    dx.max(dy)
}

fn prop(distance: f32) -> Rect {
    Rect::still(PROP.0, PROP.1, PROP.2, PROP.3, distance, Paint::Solid(RED))
}

fn wall(size: (u32, u32), distance: f32, paint: Paint) -> Rect {
    Rect::still(0, 0, size.0, size.1, distance, paint)
}

/// `texels` written as a 24-bit BMP named `name` under `GENEX_RENDER_EVIDENCE_DIR` (when set),
/// tonemapped `x / (1 + x)` and sRGB-encoded, for a person to look at.
fn evidence_image(name: &str, size: (u32, u32), texels: &[[f32; 4]]) {
    let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") else { return };
    let row = (size.0 * 3).div_ceil(4) * 4;
    let mut bytes = Vec::with_capacity((54 + row * size.1) as usize);
    let file_size = 54 + row * size.1;
    bytes.extend_from_slice(b"BM");
    for value in [file_size, 0, 54, 40, size.0, size.1] {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&24u16.to_le_bytes());
    for value in [0u32, row * size.1, 2835, 2835, 0, 0] {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    for y in (0..size.1).rev() {
        for x in 0..size.0 {
            let t = texels[(y * size.0 + x) as usize];
            for c in [2, 1, 0] {
                bytes.push(level(t[c] / (1.0 + t[c])).clamp(0, 255) as u8);
            }
        }
        bytes.resize(bytes.len() + (row - size.0 * 3) as usize, 0);
    }
    std::fs::create_dir_all(&dir).expect("evidence dir");
    std::fs::write(std::path::Path::new(&dir).join(name), bytes).expect("evidence image");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_still_frame_passes_through_unchanged() {
    let Some(gpu) = gpu() else { return };
    let frame = Frame::new(SIZE, &[wall(SIZE, 20.0, Paint::Stripes { a: GREY_A, b: GREY_B, period: 2 }), prop(2.0)]);
    let input = input_texels(&frame);
    for tier in TIERS {
        let output = draw(&gpu, &frame, 1.0, tier, 1);
        let changed = output.iter().zip(&input).filter(|(a, b)| a[..3] != b[..3]).count();
        println!("still {tier:?}: {changed} pixels changed");
        assert_eq!(changed, 0, "{tier:?}: a still frame is the scene, bit for bit");
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_pan_blurs_along_its_motion_and_not_across_it() {
    let Some(gpu) = gpu() else { return };
    // The top half vertical stripes, the bottom half horizontal stripes, all panning 24 px a frame
    // to the right: a 180-degree shutter blurs 6 px each way along x.
    let (w, h) = SIZE;
    let top = Rect::still(0, 0, w, h / 2, 10.0, Paint::Stripes { a: GREY_A, b: GREY_B, period: 4 }).moving((24.0, 0.0));
    let bottom = Rect::still(0, h / 2, w, h, 10.0, Paint::Rows { a: GREY_A, b: GREY_B, period: 4 }).moving((24.0, 0.0));
    let frame = Frame::new(SIZE, &[top, bottom]);
    let input = input_texels(&frame);
    let across = |x: u32, y: u32| x > 40 && x < w - 40 && y > 20 && y < h / 2 - 20;
    let along = |x: u32, y: u32| x > 40 && x < w - 40 && y > h / 2 + 20 && y < h - 20;
    for tier in TIERS {
        let output = draw(&gpu, &frame, SHUTTER, tier, 1);
        let (stripes_before, stripes_after) = (luma_deviation(&frame, &input, across), luma_deviation(&frame, &output, across));
        let (rows_before, rows_after) = (luma_deviation(&frame, &input, along), luma_deviation(&frame, &output, along));
        println!("pan {tier:?}: stripes across the motion {stripes_before:.4} -> {stripes_after:.4}; rows along it {rows_before:.4} -> {rows_after:.4}");
        assert!(stripes_after < stripes_before * 0.3, "{tier:?}: stripes across the motion blur ({stripes_before} -> {stripes_after})");
        assert!(rows_after > rows_before * 0.95, "{tier:?}: rows along the motion stay sharp ({rows_before} -> {rows_after})");
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_moving_object_smears_over_the_still_background() {
    let Some(gpu) = gpu() else { return };
    // A red prop 2 m away moving 32 px a frame to the right over a still striped wall at 20 m.
    let frame = Frame::new(SIZE, &[wall(SIZE, 20.0, Paint::Stripes { a: GREY_A, b: GREY_B, period: 3 }), prop(2.0).moving((32.0, 0.0))]);
    let input = input_texels(&frame);
    for tier in TIERS {
        let output = draw(&gpu, &frame, SHUTTER, tier, 1);
        evidence_image(&format!("motion-blur-moving-prop-{}.bmp", tier.as_str()), SIZE, &output);
        // Red over green just outside the prop's left and right sides (2-5 px out).
        let spread = (PROP.1 + 4..PROP.3 - 4)
            .flat_map(|y| [PROP.0 - 5, PROP.0 - 4, PROP.0 - 3, PROP.0 - 2, PROP.2 + 1, PROP.2 + 2, PROP.2 + 3, PROP.2 + 4].map(|x| (x, y)))
            .map(|(x, y)| {
                let o = output[frame.index(x, y)];
                o[0] - o[1]
            })
            .sum::<f32>()
            / ((PROP.3 - PROP.1 - 8) * 8) as f32;
        // The prop's own edge is blurred into the wall (its sides 1-4 px in are no longer pure red).
        let edge = (PROP.1 + 4..PROP.3 - 4)
            .flat_map(|y| [PROP.0 + 1, PROP.0 + 2, PROP.0 + 3, PROP.2 - 4, PROP.2 - 3, PROP.2 - 2].map(|x| (x, y)))
            .map(|(x, y)| (output[frame.index(x, y)][1] - input[frame.index(x, y)][1]).abs())
            .sum::<f32>()
            / ((PROP.3 - PROP.1 - 8) * 6) as f32;
        // Beside the prop, beyond the blur's reach (12-40 px out above and below it, where the
        // moving tiles' neighbourhood still reaches), the still wall stays the scene to a display
        // level: a texel a pixel away does not soften it.
        let near_changed = (0..SIZE.1)
            .flat_map(|y| (0..SIZE.0).map(move |x| (x, y)))
            .filter(|&(x, y)| (12..40).contains(&prop_distance_px(x, y)) && (y < PROP.1 || y >= PROP.3) && (PROP.0..PROP.2).contains(&x))
            .filter(|&(x, y)| (0..3).any(|c| (level(output[frame.index(x, y)][c]) - level(input[frame.index(x, y)][c])).abs() > 1))
            .count();
        assert_eq!(near_changed, 0, "{tier:?}: the still wall near the moving prop keeps its stripes");
        // Beyond the largest radius and its tile the still wall is untouched.
        let far_changed = (0..SIZE.1)
            .flat_map(|y| (0..SIZE.0).map(move |x| (x, y)))
            .filter(|&(x, y)| prop_distance_px(x, y) > 2 * tile_px(SIZE.1) + 2)
            .filter(|&(x, y)| output[frame.index(x, y)][..3] != input[frame.index(x, y)][..3])
            .count();
        println!("moving prop {tier:?}: red spread 2-5 px outside {spread:.4}; edge change 1-4 px inside {edge:.4}; far wall pixels changed {far_changed}");
        assert!(edge >= 0.1, "{tier:?}: the moving prop's edges blur ({edge})");
        assert_eq!(far_changed, 0, "{tier:?}: the still wall far from the prop stays the scene");
        if tier == MotionBlurTier::Reconstruction {
            assert!(spread >= 0.1, "the reconstruction spreads the moving prop past its silhouette ({spread})");
        }
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_tracked_object_stays_sharp_over_its_blurred_background() {
    let Some(gpu) = gpu() else { return };
    // The camera follows the prop: the prop is still, the wall behind it pans 32 px a frame.
    let frame = Frame::new(SIZE, &[wall(SIZE, 20.0, Paint::Stripes { a: GREY_A, b: GREY_B, period: 3 }).moving((32.0, 0.0)), prop(2.0)]);
    let input = input_texels(&frame);
    for tier in TIERS {
        let output = draw(&gpu, &frame, SHUTTER, tier, 1);
        evidence_image(&format!("motion-blur-tracked-prop-{}.bmp", tier.as_str()), SIZE, &output);
        let far = |x: u32, y: u32| prop_distance_px(x, y) > 24 && x > 30 && x < SIZE.0 - 30;
        let (before, after) = (luma_deviation(&frame, &input, far), luma_deviation(&frame, &output, far));
        let (mut prop_error, mut worst_prop) = (0f32, (0, 0));
        let (mut bleed, mut worst) = (0f32, (0, 0));
        for y in 0..SIZE.1 {
            for x in 0..SIZE.0 {
                let (o, i) = (output[frame.index(x, y)], input[frame.index(x, y)]);
                let inside = (PROP.0 + 2..PROP.2 - 2).contains(&x) && (PROP.1 + 2..PROP.3 - 2).contains(&y);
                let error = (0..3).map(|c| (o[c] - i[c]).abs()).fold(0.0, f32::max);
                if inside && error > prop_error {
                    (prop_error, worst_prop) = (error, (x, y));
                }
                if prop_distance_px(x, y) > 2 && o[0] - o[1] > bleed {
                    (bleed, worst) = (o[0] - o[1], (x, y));
                }
            }
        }
        // The wall just outside the prop has no hole (a NaN weight drew black bars there). It may
        // keep more of its stripes than the wall far from it: the samples the prop occludes are
        // dropped, so fewer remain (0.36 against 0.44 at the darkest).
        let far_darkest = (0..SIZE.1)
            .flat_map(|y| (0..SIZE.0).map(move |x| (x, y)))
            .filter(|&(x, y)| far(x, y))
            .map(|(x, y)| luma(output[frame.index(x, y)]))
            .fold(f32::INFINITY, f32::min);
        let (mut darkest, mut darkest_at) = (f32::INFINITY, (0, 0));
        for y in PROP.1 + 4..PROP.3 - 4 {
            for x in (PROP.0 - 8..PROP.0 - 2).chain(PROP.2 + 2..PROP.2 + 8) {
                let value = luma(output[frame.index(x, y)]);
                if value.is_nan() || value < darkest {
                    (darkest, darkest_at) = (value, (x, y));
                }
            }
        }
        assert!(output.iter().all(|t| t.iter().all(|v| v.is_finite())), "{tier:?}: finite everywhere");
        println!("tracked prop {tier:?}: wall luma deviation {before:.4} -> {after:.4}; prop error {prop_error:.5} at {worst_prop:?}; red bleed {bleed:.5} at {worst:?}; darkest wall 2-8 px outside {darkest:.4} at {darkest_at:?} (far wall's darkest {far_darkest:.4})");
        assert!(darkest >= 0.5 * far_darkest, "{tier:?}: no hole in the wall beside the prop ({darkest} at {darkest_at:?}, far {far_darkest})");
        assert!(after < before * 0.3, "{tier:?}: the panning wall is blurred ({before} -> {after})");
        assert!(prop_error <= 1e-3, "{tier:?}: the tracked prop stays sharp 2 px inside its edge ({prop_error})");
        assert!(bleed <= 0.02, "{tier:?}: the still prop does not bleed over the blurred wall ({bleed})");
    }
}

/// An 8-bit display level of a linear value (clamped, sRGB-encoded): what a pixel's flicker is
/// counted in.
fn level(value: f32) -> i32 {
    let v = value.clamp(0.0, 1.0);
    let encoded = if v <= 0.003_130_8 { v * 12.92 } else { 1.055 * libm::powf(v, 1.0 / 2.4) - 0.055 };
    (encoded * 255.0).round() as i32
}

/// Pan flicker: over `frames` frames of `wall` panning `step` render pixels a frame, the share of
/// interior pixels whose display level moved by more than one between a frame and the last one
/// moved with the content (a pixel and the one `step` to its left last frame), and the mean
/// absolute change of luma. The sharp pan's is zero by construction (whole-pixel steps).
fn pan_flicker(size: (u32, u32), frames: u32, step: i64, mut draw_frame: impl FnMut(&Frame) -> Texels, wall: impl Fn(i64) -> Rect) -> (f32, f32) {
    let mut previous: Option<Texels> = None;
    let (mut moved, mut total, mut luma_sum) = (0usize, 0usize, 0f32);
    let margin = 48;
    for t in 0..frames {
        let frame = Frame::new(size, &[wall(step * i64::from(t))]);
        let drawn = draw_frame(&frame);
        if let Some(last) = &previous {
            for y in margin..size.1 - margin {
                for x in margin + step as u32..size.0 - margin {
                    let (now, then) = (drawn[frame.index(x, y)], last[frame.index(x - step as u32, y)]);
                    total += 1;
                    if (0..3).any(|c| (level(now[c]) - level(then[c])).abs() > 1) {
                        moved += 1;
                    }
                    luma_sum += (luma(now) - luma(then)).abs();
                }
            }
        }
        previous = Some(drawn);
    }
    (moved as f32 / total as f32, luma_sum / total as f32)
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_steady_pan_draws_a_steady_blur() {
    let Some(gpu) = gpu() else { return };
    // A textured wall at 10 m panning 16 px a frame (blurred 4 px each way): the blur moves with
    // the content, so its gather noise does not crawl over it.
    let step = 16i64;
    for tier in TIERS {
        let mut node = MotionBlurNode::new(&gpu.device).expect("node");
        let first = Frame::new(SIZE, &[wall(SIZE, 10.0, Paint::Texture).moving((step as f32, 0.0))]);
        let a = draw_with(&gpu, &mut node, &first, SHUTTER, tier, 1);
        let b = draw_with(&gpu, &mut node, &first, SHUTTER, tier, 1);
        assert!(a == b, "{tier:?}: the same frame draws the same blur (no frame-keyed noise)");
        let (share, mean) = pan_flicker(SIZE, 8, step, |frame| draw_with(&gpu, &mut node, frame, SHUTTER, tier, 1), |shift| {
            wall(SIZE, 10.0, Paint::Texture).shifted((shift, 0)).moving((step as f32, 0.0))
        });
        println!("pan flicker {tier:?}: {:.3}% pixels moved more than a level (sharp pan 0), mean luma step {mean:.5}", 100.0 * share);
        assert!(share <= 0.005, "{tier:?}: at most 0.5% of the panning pixels flicker ({:.3}%)", 100.0 * share);
        assert!(mean <= 0.002, "{tier:?}: mean luma step {mean}");
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_multisampled_depth_draws_as_its_single_sampled_twin() {
    let Some(gpu) = gpu() else { return };
    let frame = Frame::new(SIZE, &[wall(SIZE, 20.0, Paint::Stripes { a: GREY_A, b: GREY_B, period: 3 }).moving((32.0, 0.0)), prop(2.0).moving((-12.0, 6.0))]);
    for tier in TIERS {
        let single = draw(&gpu, &frame, SHUTTER, tier, 1);
        let multi = draw(&gpu, &frame, SHUTTER, tier, 4);
        assert!(single == multi, "{tier:?}: sample 0 of a 4x depth is the 1x depth");
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_render_size_off_the_tile_grid_blurs_to_its_edges() {
    let Some(gpu) = gpu() else { return };
    let size = (501, 283);
    let frame = Frame::new(size, &[wall(size, 30.0, Paint::Stripes { a: GREY_A, b: GREY_B, period: 3 }).moving((20.0, 0.0))]);
    let input = input_texels(&frame);
    for tier in TIERS {
        let output = draw(&gpu, &frame, SHUTTER, tier, 1);
        assert_eq!(output.len(), (size.0 * size.1) as usize);
        assert!(output.iter().all(|t| t.iter().all(|v| v.is_finite())), "{tier:?}: finite everywhere");
        // The last rows are blurred like the rest (the tiles past the render size repeat its edge).
        let edge = |x: u32, y: u32| y + 2 >= size.1 && x > 20 && x + 20 < size.0;
        let (before, after) = (luma_deviation(&frame, &input, edge), luma_deviation(&frame, &output, edge));
        let mean_in = input.iter().map(|t| luma(*t)).sum::<f32>() / input.len() as f32;
        let mean_out = output.iter().map(|t| luma(*t)).sum::<f32>() / output.len() as f32;
        println!("off-grid {tier:?}: bottom edge luma deviation {before:.4} -> {after:.4}; mean luma {mean_in:.4} -> {mean_out:.4}");
        assert!(after < before * 0.5, "{tier:?}: the edges blur ({before} -> {after})");
        assert!((mean_out - mean_in).abs() < 0.03 * mean_in, "{tier:?}: the blur keeps the energy");
    }
}

/// A camera turning fast at `size`: a textured wall panning 60 px a frame and a nearer prop moving
/// the other way, so every tile blurs (the cost rows' worst case).
fn fast_pan(size: (u32, u32)) -> Frame {
    let (w, h) = size;
    let wall = Rect::still(0, 0, w, h, 25.0, Paint::Texture).moving((60.0 * h as f32 / 1080.0, 0.0));
    let prop = Rect::still(w / 3, h / 3, 2 * w / 3, 4 * h / 5, 2.0, Paint::Solid(RED)).moving((-30.0 * h as f32 / 1080.0, 10.0 * h as f32 / 1080.0));
    Frame::new(size, &[wall, prop])
}

/// The node's GPU milliseconds over `frame` at `tier`: the median of [`COST_SAMPLES`] samples of
/// [`COST_NODES_PER_SAMPLE`] nodes each (None without timestamp queries). Per-pass stamps are not
/// recorded: on Apple GPUs a pass's beginning stamp lands while earlier passes still run.
fn cost_ms(gpu: &Gpu, frame: &Frame, tier: MotionBlurTier) -> Option<f32> {
    let device = &gpu.device;
    if !device.features().contains(wgpu::Features::TIMESTAMP_QUERY) {
        return None;
    }
    let mut node = MotionBlurNode::new(device).expect("node");
    let mut pool = TargetPool::new();
    node.acquire(device, &mut pool, frame.size, tier, None).expect("targets");
    let scene = colour_texture(gpu, frame);
    let motion = motion_texture(gpu, frame);
    let depth = depth_texture(gpu, frame, 1);
    let output = colour_texture(gpu, frame);
    let views = [&scene, &motion, &depth, &output].map(|t| t.create_view(&Default::default()));
    let count = 2;
    let bytes = u64::from(count) * 8;
    let query_set = device.create_query_set(&wgpu::QuerySetDescriptor { label: Some("motion blur cost"), ty: wgpu::QueryType::Timestamp, count });
    let resolve = device.create_buffer(&wgpu::BufferDescriptor { label: None, size: bytes, usage: wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC, mapped_at_creation: false });
    let staging = device.create_buffer(&wgpu::BufferDescriptor { label: None, size: bytes, usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false });
    let period = gpu.queue.get_timestamp_period();
    let mut times = Vec::new();
    for sample in 0..COST_WARM_UP_SAMPLES + COST_SAMPLES {
        let mut encoder = device.create_command_encoder(&Default::default());
        for run in 0..COST_NODES_PER_SAMPLE {
            let input = MotionBlurInput {
                scene: &views[0],
                motion: &views[1],
                depth: &views[2],
                depth_samples: 1,
                output: Some((&views[3], wgpu::TextureFormat::Rgba16Float)),
                render: frame.size,
                proj: proj(frame.size),
                frame: MotionBlurFrameSettings { settings: MotionBlur::shutter(SHUTTER), tier },
            };
            let stamps = MotionBlurTimestamps::Span(&query_set, (run == 0).then_some(0), (run + 1 == COST_NODES_PER_SAMPLE).then_some(1));
            node.encode(device, &gpu.queue, &mut encoder, input, Some(stamps));
        }
        gpu.queue.submit([encoder.finish()]);
        device.poll(wgpu::PollType::wait_indefinitely()).expect("poll");
        // Resolved after the passes completed (Metal's counters read stale in the same buffer).
        let mut encoder = device.create_command_encoder(&Default::default());
        encoder.resolve_query_set(&query_set, 0..count, &resolve, 0);
        encoder.copy_buffer_to_buffer(&resolve, 0, &staging, 0, bytes);
        gpu.queue.submit([encoder.finish()]);
        let slice = staging.slice(..);
        slice.map_async(wgpu::MapMode::Read, |result| result.expect("map"));
        device.poll(wgpu::PollType::wait_indefinitely()).expect("poll");
        let ticks: Vec<u64> = {
            let data = slice.get_mapped_range().expect("mapped");
            (0..count as usize).map(|i| u64::from_le_bytes(data[i * 8..i * 8 + 8].try_into().expect("8 bytes"))).collect()
        };
        staging.unmap();
        if sample < COST_WARM_UP_SAMPLES {
            continue;
        }
        match genex_render::timing::span_ms(ticks[0], ticks[1], period) {
            Some(ms) => times.push(ms / COST_NODES_PER_SAMPLE as f32),
            None => eprintln!("motion blur cost: unusable stamps {ticks:?}"),
        }
    }
    assert!(!times.is_empty(), "no usable timestamp sample");
    times.sort_by(f32::total_cmp);
    Some(times[times.len() / 2])
}

fn perf_row(name: &str, tier: MotionBlurTier, size: (u32, u32), median: f32, budget: Option<f32>) {
    let row = format!("{{\"row\":\"{name}\",\"tier\":\"{}\",\"size\":[{},{}],\"median_ms\":{median:.4},\"budget_ms\":{}}}", tier.as_str(), size.0, size.1, budget.map_or("null".to_owned(), |b| b.to_string()));
    println!("{row}");
    if let Ok(path) = std::env::var("GENEX_PERF_OUT") {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new().create(true).append(true).open(path).expect("perf out");
        writeln!(file, "{row}").expect("perf row");
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_motion_blur_costs_at_most_half_a_millisecond_at_1080p() {
    let Some(gpu) = gpu() else { return };
    let mut over = Vec::new();
    for size in [(1920, 1080), (2560, 1440), (3840, 2160)] {
        let frame = fast_pan(size);
        for tier in TIERS {
            let Some(median) = cost_ms(&gpu, &frame, tier) else {
                eprintln!("skipped: no timestamp queries");
                return;
            };
            let judged = (size == (1920, 1080)).then_some(MOTION_BLUR_MS_MAX);
            perf_row("motion-blur-fast-pan", tier, size, median, judged);
            if judged.is_some_and(|budget| median > budget) {
                over.push(format!("{tier:?} {size:?}: {median:.3} ms > {MOTION_BLUR_MS_MAX} ms"));
            }
        }
    }
    // Recorded, not judged: a still frame (the pass-through's fixed cost).
    let still = Frame::new((1920, 1080), &[wall((1920, 1080), 25.0, Paint::Texture)]);
    for tier in TIERS {
        if let Some(median) = cost_ms(&gpu, &still, tier) {
            perf_row("motion-blur-still", tier, still.size, median, None);
        }
    }
    assert!(over.is_empty(), "over budget: {over:?}");
}
