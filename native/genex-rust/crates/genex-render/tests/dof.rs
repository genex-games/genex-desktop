//! A.9 depth of field: the look's thin lens, Filament's ring gather (desktop high and ultra) and
//! Godot's circular gather (everywhere else), between TAA (node 17) and `post-hdr` (node 18).
//!
//! The CPU rows run everywhere. The GPU rows are `#[ignore]`d and every name contains `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked --test dof -- --ignored metal
//!
//! The GPU rows draw the node over synthetic frames: a CPU-built HDR scene and depth (rectangles
//! at world distances seen through a reverse-Z infinite projection) uploaded as the textures the
//! renderer hands the node. `GENEX_RENDER_EVIDENCE_DIR` writes each frame there (tonemapped PNG
//! strips are not needed: raw rgba16f values are summarised in the printed rows); `GENEX_PERF_OUT`
//! receives the cost rows as JSON lines.

use genex_render::Gpu;
use genex_render::device_class::{DeviceClass, FormFactor, PerformanceTier};
use genex_render::post::dof::{
    CIRCULAR_MAX_COC_PX, CocParams, DepthOfField, DofFrame, DofFrameSettings, DofInput, DofNode, DofTier, DofTimestamps, GpuDofParams, MAX_IN_FOCUS_COC,
    RING_MAX_COC_PX, frame_settings, half_size, sources, target_bytes, targets,
};
use genex_render::presets::preset_quality;
use genex_render::settings::{Look, Quality, QualityPreset};
use genex_render::target_pool::TargetPool;
use glam::Mat4;

const NEAR: f32 = 0.1;
const FOV_Y_DEG: f32 = 60.0;
/// The ring tier's budget at 1080p (TIER-AB plan A.9: DoF at most 1.0 ms at high).
const RING_MS_MAX: f32 = 1.0;
/// The circular tier's budget at 1080p (at most 0.4 ms in the Godot tier).
const CIRCULAR_MS_MAX: f32 = 0.4;
/// Nodes a cost sample records back to back (a lone pass after an idle wait pays the GPU's wake-up;
/// the AO, contact-shadow and sun-mask cost rows do the same).
const COST_NODES_PER_SAMPLE: u32 = 16;
/// Cost samples per row (the row reports their median).
const COST_SAMPLES: usize = 15;

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

// ---------------------------------------------------------------------------------------------
// CPU rows

#[test]
fn depth_of_field_is_a_look_switch_that_is_off_by_default() {
    let quality = preset_quality(QualityPreset::High, desktop(PerformanceTier::High));
    let p = proj((1920, 1080));
    assert_eq!(Look::default().depth_of_field, DepthOfField::OFF);
    assert!(!DepthOfField::default().enabled);
    assert_eq!(frame_settings(&Look::default().depth_of_field, &quality, true, p, DofFrame::Live), None, "off by default");
    let on = DepthOfField::focused(2.0, 2.8);
    let look = Look::default().with_depth_of_field(on);
    assert_eq!(look.depth_of_field, on);
    assert_eq!(frame_settings(&on, &quality, true, p, DofFrame::Live), Some(DofFrameSettings { settings: on, tier: DofTier::Ring }));
    assert_eq!(frame_settings(&on, &quality, false, p, DofFrame::Live), None, "the legacy LDR scene has no depth of field");
    let ortho = glam::camera::rh::proj::directx::orthographic(-1.0, 1.0, -1.0, 1.0, 0.1, 100.0);
    assert_eq!(frame_settings(&on, &quality, true, ortho, DofFrame::Live), None, "an orthographic camera has no lens");
    assert_eq!(frame_settings(&on.with_coc_scale(0.0), &quality, true, p, DofFrame::Live), None, "a zero CoC blurs nothing");
}

#[test]
fn a_settled_capture_draws_without_depth_of_field_unless_its_shot_asks() {
    let quality = preset_quality(QualityPreset::Ultra, desktop(PerformanceTier::Ultra));
    let on = DepthOfField::focused(1.5, 2.0);
    let p = proj((1920, 1080));
    assert_eq!(frame_settings(&on, &quality, true, p, DofFrame::Settled { shot_asks: false }), None);
    assert!(frame_settings(&on, &quality, true, p, DofFrame::Settled { shot_asks: true }).is_some());
    assert!(frame_settings(&DepthOfField::OFF, &quality, true, p, DofFrame::Settled { shot_asks: true }).is_none(), "the shot asks for the look's, not its own");
}

#[test]
fn the_ring_gather_draws_at_desktop_high_and_ultra_and_the_circular_gather_elsewhere() {
    for (preset, tier) in [(QualityPreset::Low, DofTier::Circular), (QualityPreset::Medium, DofTier::Circular), (QualityPreset::High, DofTier::Ring), (QualityPreset::Ultra, DofTier::Ring)] {
        assert_eq!(preset_quality(preset, desktop(PerformanceTier::High)).dof, tier, "desktop {preset:?}");
    }
    for preset in [QualityPreset::Low, QualityPreset::Medium, QualityPreset::High, QualityPreset::Ultra] {
        let phone = DeviceClass::new(FormFactor::Mobile, PerformanceTier::High);
        assert_eq!(preset_quality(preset, phone).dof, DofTier::Circular, "phone {preset:?}");
    }
    assert_eq!(Quality::off().dof, DofTier::Circular);
}

#[test]
fn the_coc_follows_the_thin_lens_and_the_render_height() {
    let p = proj((1920, 1080));
    let settings = DepthOfField::focused(2.0, 2.0);
    let coc = CocParams::new(&settings, p, 1080);
    // The thin lens: K (1 - S / d), K = (f / N) f / (S - f) * height / sensor.
    // The projection's y scale is 1 / tan(fov / 2).
    let focal = 0.5 * 0.024 * p.y_axis.y;
    let k = (focal / 2.0) * focal / (2.0 - focal) * (1080.0 / 0.024);
    for distance in [0.5f32, 1.0, 2.0, 4.0, 50.0] {
        let expected = k * (1.0 - 2.0 / distance);
        let drawn = coc.scale * depth_of(distance) + coc.bias;
        assert!((drawn - expected).abs() <= 1e-3 * k.max(1.0), "{distance} m: {drawn} vs {expected}");
    }
    assert!((coc.bias - k).abs() < 1e-3 * k, "the sky (depth 0) takes the lens's whole K");
    let wider = CocParams::new(&DepthOfField::focused(2.0, 1.0), p, 1080);
    assert!(wider.bias > coc.bias * 1.9, "half the f-number, twice the blur");
    let taller = CocParams::new(&settings, p, 2160);
    assert!((taller.bias - 2.0 * coc.bias).abs() < 1e-3 * coc.bias, "the CoC is in render pixels");
    assert_eq!(coc.radius(depth_of(2.0), RING_MAX_COC_PX), 0.0, "in focus at the focus distance");
    assert_eq!(coc.radius(0.0, RING_MAX_COC_PX), RING_MAX_COC_PX.min(coc.bias * 0.5));
}

#[test]
fn the_knobs_are_held_to_their_ranges() {
    let wild = DepthOfField { enabled: true, focus_distance: f32::NAN, f_stop: 0.01, coc_scale: 100.0 }.held();
    assert_eq!((wild.focus_distance, wild.f_stop, wild.coc_scale), (10.0, 0.7, 8.0));
    let wild = DepthOfField { enabled: true, focus_distance: -3.0, f_stop: f32::NAN, coc_scale: f32::NAN }.held();
    assert_eq!((wild.focus_distance, wild.f_stop, wild.coc_scale), (0.05, 2.8, 1.0));
    let look = Look::default().with_depth_of_field(DepthOfField { enabled: true, focus_distance: 1e9, f_stop: 999.0, coc_scale: -1.0 });
    assert_eq!((look.depth_of_field.focus_distance, look.depth_of_field.f_stop, look.depth_of_field.coc_scale), (10_000.0, 64.0, 0.0));
}

#[test]
fn the_targets_are_padded_to_whole_tiles_core_formats_and_ledgered() {
    for tier in [DofTier::Circular, DofTier::Ring] {
        for render in [(1920, 1080), (1000, 563), (2560, 1440), (3840, 2160)] {
            for target in targets(render, tier, Some(wgpu::TextureFormat::Rgba16Float)) {
                genex_render::target_pool::validate(&target).unwrap_or_else(|refusal| panic!("{tier:?} {render:?}: {refusal}"));
            }
            let half = half_size(render);
            assert_eq!((half.0 % 8, half.1 % 8), (0, 0), "{render:?}: whole tiles of 8 half texels");
            assert!(half.0 * 2 >= render.0 && half.1 * 2 >= render.1);
        }
    }
    // 1080p: the ring tier's half colour with three mips, two tile maps, the gather and the median.
    let ring = target_bytes((1920, 1080), DofTier::Ring, None);
    let circular = target_bytes((1920, 1080), DofTier::Circular, None);
    println!("dof targets at 1080p: ring {ring} B, circular {circular} B, own output +{} B", 1920 * 1080 * 8);
    assert!(ring < 16 << 20, "ring {ring} B");
    assert!(circular < ring);
    assert_eq!(target_bytes((1920, 1080), DofTier::Ring, Some(wgpu::TextureFormat::Rgba16Float)) - ring, 1920 * 1080 * 8);
}

#[test]
fn the_row_carries_the_madd_the_clamps_and_the_padded_size() {
    let render = (1000, 563);
    let frame = DofFrameSettings { settings: DepthOfField::focused(3.0, 2.8), tier: DofTier::Circular };
    let row = GpuDofParams::new(&frame, proj(render), render);
    let coc = CocParams::new(&frame.settings, proj(render), 563);
    assert_eq!(row.coc, [coc.scale, coc.bias, -CIRCULAR_MAX_COC_PX, CIRCULAR_MAX_COC_PX]);
    assert_eq!(row.size, [1000.0, 563.0, 1.0 / 504.0, 1.0 / 288.0]);
    assert_eq!(size_of::<GpuDofParams>(), 64);
    // Below a pixel of CoC the pixel is in focus.
    assert_eq!(coc.radius(depth_of(3.0) * 1.0001, CIRCULAR_MAX_COC_PX), 0.0);
    // A 21 mm lens (60 degrees over 24 mm) at f/2.8 focused at 3 m: the far field stays under a
    // pixel of radius even at infinity (k / 2 = 0.61 px at 563 px), and a surface half a metre
    // away is blurred in front of the focus (negative: the near field).
    assert!(coc.bias * 0.5 < MAX_IN_FOCUS_COC);
    assert!(coc.radius(depth_of(0.5), CIRCULAR_MAX_COC_PX) <= -MAX_IN_FOCUS_COC);
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
    assert_eq!(all.len(), 5);
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

/// How a rectangle is coloured.
#[derive(Clone, Copy)]
enum Paint {
    Solid([f32; 3]),
    /// Vertical stripes `period` pixels wide, alternating `a` and `b`.
    Stripes { a: [f32; 3], b: [f32; 3], period: u32 },
}

/// A rectangle of the synthetic frame: pixels `[x0, x1) x [y0, y1)` at `distance` world units.
#[derive(Clone, Copy)]
struct Rect {
    x0: u32,
    y0: u32,
    x1: u32,
    y1: u32,
    distance: f32,
    paint: Paint,
}

/// A synthetic frame: rgb per pixel and the depth-buffer value (the nearest rectangle wins; the
/// sky, depth 0, where none covers a pixel).
struct Frame {
    size: (u32, u32),
    colour: Vec<[f32; 3]>,
    depth: Vec<f32>,
}

impl Frame {
    fn new(size: (u32, u32), rects: &[Rect]) -> Frame {
        let count = (size.0 * size.1) as usize;
        let mut frame = Frame { size, colour: vec![[0.3, 0.4, 0.6]; count], depth: vec![0.0; count] };
        for y in 0..size.1 {
            for x in 0..size.0 {
                let i = (y * size.0 + x) as usize;
                for rect in rects.iter().filter(|r| x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1) {
                    let depth = depth_of(rect.distance);
                    if depth >= frame.depth[i] {
                        frame.depth[i] = depth;
                        frame.colour[i] = match rect.paint {
                            Paint::Solid(rgb) => rgb,
                            Paint::Stripes { a, b, period } => {
                                if (x / period) % 2 == 0 {
                                    a
                                } else {
                                    b
                                }
                            }
                        };
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

/// The frame's colour as an `rgba16float` texture.
fn colour_texture(gpu: &Gpu, frame: &Frame) -> wgpu::Texture {
    let texture = gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("dof test scene"),
        size: wgpu::Extent3d { width: frame.size.0, height: frame.size.1, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba16Float,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let bytes: Vec<u8> = frame.colour.iter().flat_map(|rgb| [rgb[0], rgb[1], rgb[2], 1.0]).flat_map(|v| f16_bits(v).to_le_bytes()).collect();
    gpu.queue.write_texture(
        texture.as_image_copy(),
        &bytes,
        wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(frame.size.0 * 8), rows_per_image: None },
        wgpu::Extent3d { width: frame.size.0, height: frame.size.1, depth_or_array_layers: 1 },
    );
    texture
}

/// The frame's depth as a `depth32float` texture of `samples` per pixel: an `r32float` copy
/// written through `frag_depth` (WebGPU copies into no depth32float).
fn depth_texture(gpu: &Gpu, frame: &Frame, samples: u32) -> wgpu::Texture {
    let device = &gpu.device;
    let size = wgpu::Extent3d { width: frame.size.0, height: frame.size.1, depth_or_array_layers: 1 };
    let values = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("dof test depth values"),
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
        label: Some("dof test depth"),
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
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("dof test depth"), source: wgpu::ShaderSource::Wgsl(source.into()) });
    let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("dof test depth"),
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
        label: Some("dof test readback"),
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

/// The node drawn once over `frame` with `settings` at `tier` (the depth with `samples` per
/// pixel): the output's texels.
fn draw(gpu: &Gpu, frame: &Frame, settings: DepthOfField, tier: DofTier, samples: u32) -> Vec<[f32; 4]> {
    let mut node = DofNode::new(&gpu.device).expect("node");
    draw_with(gpu, &mut node, frame, settings, tier, samples)
}

fn draw_with(gpu: &Gpu, node: &mut DofNode, frame: &Frame, settings: DepthOfField, tier: DofTier, samples: u32) -> Vec<[f32; 4]> {
    let mut pool = TargetPool::new();
    node.acquire(&gpu.device, &mut pool, frame.size, tier, Some(wgpu::TextureFormat::Rgba16Float)).expect("targets");
    let scene = colour_texture(gpu, frame);
    let depth = depth_texture(gpu, frame, samples);
    let (scene_view, depth_view) = (scene.create_view(&Default::default()), depth.create_view(&Default::default()));
    let mut encoder = gpu.device.create_command_encoder(&Default::default());
    let input = DofInput {
        scene: &scene_view,
        depth: &depth_view,
        depth_samples: samples,
        output: None,
        render: frame.size,
        proj: proj(frame.size),
        frame: DofFrameSettings { settings, tier },
    };
    let passes = node.encode(&gpu.device, &gpu.queue, &mut encoder, input, None);
    assert_eq!(passes, tier.passes());
    gpu.queue.submit([encoder.finish()]);
    read_rgba16f(gpu, node.output_texture().expect("own output"))
}

/// A frame's rgba texels.
type Texels = Vec<[f32; 4]>;

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

fn input_texels(frame: &Frame) -> Vec<[f32; 4]> {
    frame.colour.iter().map(|rgb| [f16_value(f16_bits(rgb[0])), f16_value(f16_bits(rgb[1])), f16_value(f16_bits(rgb[2])), 1.0]).collect()
}

const SIZE: (u32, u32) = (480, 270);
const GREY_A: [f32; 3] = [0.9, 0.9, 0.9];
const GREY_B: [f32; 3] = [0.05, 0.05, 0.05];
const RED: [f32; 3] = [1.0, 0.05, 0.05];
const TIERS: [DofTier; 2] = [DofTier::Circular, DofTier::Ring];
/// Focused 1 m away at f/1.4, scaled 8x: on the rows' 270 px frames the far wall's CoC is about
/// 14 px (the thin lens alone gives 1.7 px at that height; a 1080p frame's 7 px).
const STRONG: DepthOfField = DepthOfField::focused(1.0, 1.4).with_coc_scale(8.0);

/// A grey striped wall `distance` away behind a red prop at `prop_distance` (pixels 180..300 x
/// 90..180).
fn prop_frame(size: (u32, u32), distance: f32, prop_distance: f32) -> Frame {
    let wall = Rect { x0: 0, y0: 0, x1: size.0, y1: size.1, distance, paint: Paint::Stripes { a: GREY_A, b: GREY_B, period: 3 } };
    let prop = Rect { x0: 180, y0: 90, x1: 300, y1: 180, distance: prop_distance, paint: Paint::Solid(RED) };
    Frame::new(size, &[wall, prop])
}

/// Chebyshev distance in pixels from `(x, y)` to the prop's rectangle (0 inside).
fn prop_distance_px(x: u32, y: u32) -> u32 {
    let dx = if x < 180 { 180 - x } else { x.saturating_sub(299) };
    let dy = if y < 90 { 90 - y } else { y.saturating_sub(179) };
    dx.max(dy)
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_an_in_focus_frame_passes_through_unchanged() {
    let Some(gpu) = gpu() else { return };
    // Everything 4 m away, focused at 4 m.
    let frame = Frame::new(SIZE, &[Rect { x0: 0, y0: 0, x1: SIZE.0, y1: SIZE.1, distance: 4.0, paint: Paint::Stripes { a: GREY_A, b: RED, period: 2 } }]);
    let input = input_texels(&frame);
    for tier in TIERS {
        let output = draw(&gpu, &frame, DepthOfField::focused(4.0, 2.8), tier, 1);
        let changed = output.iter().zip(&input).filter(|(a, b)| a[..3] != b[..3]).count();
        println!("in focus {tier:?}: {changed} pixels changed");
        assert_eq!(changed, 0, "{tier:?}: an in-focus frame is the scene, bit for bit");
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_far_wall_blurs_and_a_focused_prop_keeps_its_edges_without_bleeding() {
    let Some(gpu) = gpu() else { return };
    let frame = prop_frame(SIZE, 60.0, 1.0);
    let input = input_texels(&frame);
    for tier in TIERS {
        let output = draw(&gpu, &frame, STRONG, tier, 1);
        let far = |x: u32, y: u32| prop_distance_px(x, y) > 48 && x > 40 && x < SIZE.0 - 40 && y > 40 && y < SIZE.1 - 40;
        let (before, after) = (luma_deviation(&frame, &input, far), luma_deviation(&frame, &output, far));
        // The prop: unchanged 2 px inside its edge.
        let mut prop_error = 0f32;
        // The wall around it: no red from the sharp prop beyond 2 px of its edge (the wall is grey,
        // so any red over green there came from the prop).
        let mut bleed = 0f32;
        let mut worst = (0, 0);
        let mut worst_prop = (0, 0);
        for y in 0..SIZE.1 {
            for x in 0..SIZE.0 {
                let (o, i) = (output[frame.index(x, y)], input[frame.index(x, y)]);
                let inside = (182..298).contains(&x) && (92..178).contains(&y);
                let error = (0..3).map(|c| (o[c] - i[c]).abs()).fold(0.0, f32::max);
                if inside && error > prop_error {
                    prop_error = error;
                    worst_prop = (x, y);
                }
                if prop_distance_px(x, y) > 2 && o[0] - o[1] > bleed {
                    bleed = o[0] - o[1];
                    worst = (x, y);
                }
            }
        }
        println!("focused prop {tier:?}: far wall luma deviation {before:.4} -> {after:.4}; prop error {prop_error:.5} at {worst_prop:?}; red bleed {bleed:.5} at {worst:?}, {} px from the prop", prop_distance_px(worst.0, worst.1));
        assert!(after < before * 0.2, "{tier:?}: the far wall is blurred ({before} -> {after})");
        assert!(prop_error <= 1e-3, "{tier:?}: the focused prop stays sharp ({prop_error})");
        assert!(bleed <= 0.02, "{tier:?}: the sharp prop does not bleed over the blurred wall ({bleed})");
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_blurred_foreground_spreads_over_the_sharp_wall_behind_it() {
    let Some(gpu) = gpu() else { return };
    // The wall in focus at 6 m; the prop 0.4 m from the lens.
    let frame = prop_frame(SIZE, 6.0, 0.4);
    let input = input_texels(&frame);
    for tier in TIERS {
        let output = draw(&gpu, &frame, DepthOfField::focused(6.0, 1.4).with_coc_scale(6.0), tier, 1);
        // Red over green just outside the prop's silhouette (3-6 px out, on its left and right).
        let spread = (93..177)
            .flat_map(|y| [174u32, 175, 176, 177, 302, 303, 304, 305].map(|x| (x, y)))
            .map(|(x, y)| {
                let o = output[frame.index(x, y)];
                o[0] - o[1]
            })
            .sum::<f32>()
            / (84.0 * 8.0);
        // Far from the prop the in-focus wall is untouched.
        let far_changed = (0..SIZE.1)
            .flat_map(|y| (0..SIZE.0).map(move |x| (x, y)))
            .filter(|&(x, y)| prop_distance_px(x, y) > 80)
            .filter(|&(x, y)| output[frame.index(x, y)][..3] != input[frame.index(x, y)][..3])
            .count();
        println!("blurred foreground {tier:?}: mean red spread 3-6 px outside {spread:.4}; far wall pixels changed {far_changed}");
        assert!(spread >= 0.1, "{tier:?}: the out-of-focus prop spreads over the wall ({spread})");
        assert_eq!(far_changed, 0, "{tier:?}: the wall far from the prop stays the scene");
    }
}

/// A frame of `frame` whose colours carry a deterministic ±`amplitude` relative wobble keyed by
/// `seed` (TAA's still-camera residual).
fn wobbled(frame: &Frame, seed: u32, amplitude: f32) -> Frame {
    let colour = frame
        .colour
        .iter()
        .enumerate()
        .map(|(i, rgb)| {
            let hash = (i as u32).wrapping_mul(2_654_435_761).wrapping_add(seed.wrapping_mul(40_503)).rotate_left(13).wrapping_mul(2_246_822_519);
            let unit = (hash >> 8) as f32 / (1u32 << 24) as f32 * 2.0 - 1.0;
            rgb.map(|c| c * (1.0 + amplitude * unit))
        })
        .collect();
    Frame { size: frame.size, colour, depth: frame.depth.clone() }
}

/// An 8-bit display level of a linear value (clamped, sRGB-encoded): what a pixel's flicker is
/// counted in.
fn level(value: f32) -> i32 {
    let v = value.clamp(0.0, 1.0);
    let encoded = if v <= 0.003_130_8 { v * 12.92 } else { 1.055 * libm::powf(v, 1.0 / 2.4) - 0.055 };
    (encoded * 255.0).round() as i32
}

/// Pixels whose display level moved by more than one between `a` and `b`, and the mean absolute
/// change of luma.
fn flicker(a: &[[f32; 4]], b: &[[f32; 4]]) -> (usize, f32) {
    let pixels = a.iter().zip(b).filter(|(p, q)| (0..3).any(|c| (level(p[c]) - level(q[c])).abs() > 1)).count();
    let mean = a.iter().zip(b).map(|(p, q)| (luma(*p) - luma(*q)).abs()).sum::<f32>() / a.len() as f32;
    (pixels, mean)
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_still_camera_draws_the_same_blur_every_frame_and_damps_the_taa_residual() {
    let Some(gpu) = gpu() else { return };
    let frame = prop_frame(SIZE, 60.0, 1.0);
    let settings = STRONG;
    for tier in TIERS {
        let mut node = DofNode::new(&gpu.device).expect("node");
        let first = draw_with(&gpu, &mut node, &frame, settings, tier, 1);
        let second = draw_with(&gpu, &mut node, &frame, settings, tier, 1);
        assert!(first == second, "{tier:?}: the same frame draws the same blur (no frame-keyed noise)");
        // Eight frames of a 2% residual: the blurred picture moves no more than the sharp one.
        let (mut off, mut on) = ((0usize, 0f32), (0usize, 0f32));
        let mut previous: Option<(Texels, Texels)> = None;
        for seed in 0..8 {
            let shaken = wobbled(&frame, seed, 0.02);
            let drawn = draw_with(&gpu, &mut node, &shaken, settings, tier, 1);
            let plain = input_texels(&shaken);
            if let Some((last_plain, last_drawn)) = &previous {
                let (a, b) = (flicker(last_plain, &plain), flicker(last_drawn, &drawn));
                off = (off.0 + a.0, off.1 + a.1 / 7.0);
                on = (on.0 + b.0, on.1 + b.1 / 7.0);
            }
            previous = Some((plain, drawn));
        }
        let pixels = (SIZE.0 * SIZE.1 * 7) as f32;
        println!(
            "still flicker {tier:?}: off {:.3}% pixels (mean luma step {:.5}), dof {:.3}% (mean {:.5})",
            100.0 * off.0 as f32 / pixels,
            off.1,
            100.0 * on.0 as f32 / pixels,
            on.1
        );
        assert!(on.0 <= off.0, "{tier:?}: depth of field adds no flicker ({} > {})", on.0, off.0);
        assert!(on.1 <= off.1, "{tier:?}: the mean step is no larger");
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_multisampled_depth_draws_as_its_single_sampled_twin() {
    let Some(gpu) = gpu() else { return };
    let frame = prop_frame(SIZE, 60.0, 1.0);
    for tier in TIERS {
        let single = draw(&gpu, &frame, STRONG, tier, 1);
        let multi = draw(&gpu, &frame, STRONG, tier, 4);
        assert!(single == multi, "{tier:?}: sample 0 of a 4x depth is the 1x depth");
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_render_size_off_the_tile_grid_blurs_to_its_edges() {
    let Some(gpu) = gpu() else { return };
    let size = (501, 283);
    let frame = Frame::new(size, &[Rect { x0: 0, y0: 0, x1: size.0, y1: size.1, distance: 80.0, paint: Paint::Stripes { a: GREY_A, b: GREY_B, period: 3 } }]);
    let input = input_texels(&frame);
    for tier in TIERS {
        let output = draw(&gpu, &frame, STRONG, tier, 1);
        assert_eq!(output.len(), (size.0 * size.1) as usize);
        assert!(output.iter().all(|t| t.iter().all(|v| v.is_finite())), "{tier:?}: finite everywhere");
        // The last column and row are blurred like the rest (the padding repeats the edge).
        let edge = |x: u32, y: u32| x + 1 == size.0 || y + 1 == size.1;
        let (before, after) = (luma_deviation(&frame, &input, |x, y| edge(x, y) && y > 20), luma_deviation(&frame, &output, |x, y| edge(x, y) && y > 20));
        let mean_in = input.iter().map(|t| luma(*t)).sum::<f32>() / input.len() as f32;
        let mean_out = output.iter().map(|t| luma(*t)).sum::<f32>() / output.len() as f32;
        println!("off-grid {tier:?}: edge luma deviation {before:.4} -> {after:.4}; mean luma {mean_in:.4} -> {mean_out:.4}");
        assert!(after < before * 0.5, "{tier:?}: the edges blur ({before} -> {after})");
        assert!((mean_out - mean_in).abs() < 0.03 * mean_in, "{tier:?}: the blur keeps the energy");
    }
}

/// A close-up at `size`: a striped wall far behind (blurred to the tier's radius), the prop in focus
/// in the middle third and a blurred ledge across the bottom fifth.
fn close_up(size: (u32, u32)) -> Frame {
    let (w, h) = size;
    let wall = Rect { x0: 0, y0: 0, x1: w, y1: h, distance: 40.0, paint: Paint::Stripes { a: GREY_A, b: GREY_B, period: 5 } };
    let prop = Rect { x0: w / 3, y0: h / 3, x1: 2 * w / 3, y1: 4 * h / 5, distance: 1.0, paint: Paint::Solid(RED) };
    let ledge = Rect { x0: 0, y0: 4 * h / 5, x1: w, y1: h, distance: 0.45, paint: Paint::Stripes { a: [0.4, 0.3, 0.2], b: [0.1, 0.08, 0.05], period: 7 } };
    Frame::new(size, &[wall, prop, ledge])
}

/// The node's GPU milliseconds over `frame` at `tier`: the median of [`COST_SAMPLES`] samples of
/// [`COST_NODES_PER_SAMPLE`] nodes each (None without timestamp queries).
fn cost_ms(gpu: &Gpu, frame: &Frame, settings: DepthOfField, tier: DofTier) -> Option<(f32, Vec<f32>)> {
    let device = &gpu.device;
    if !device.features().contains(wgpu::Features::TIMESTAMP_QUERY) {
        return None;
    }
    let mut node = DofNode::new(device).expect("node");
    let mut pool = TargetPool::new();
    node.acquire(device, &mut pool, frame.size, tier, None).expect("targets");
    let scene = colour_texture(gpu, frame);
    let depth = depth_texture(gpu, frame, 1);
    let output = colour_texture(gpu, frame);
    let (scene_view, depth_view, output_view) = (scene.create_view(&Default::default()), depth.create_view(&Default::default()), output.create_view(&Default::default()));
    let query_set = device.create_query_set(&wgpu::QuerySetDescriptor { label: Some("dof cost"), ty: wgpu::QueryType::Timestamp, count: 2 });
    let resolve = device.create_buffer(&wgpu::BufferDescriptor { label: None, size: 16, usage: wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC, mapped_at_creation: false });
    let staging = device.create_buffer(&wgpu::BufferDescriptor { label: None, size: 16, usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false });
    let period = gpu.queue.get_timestamp_period();
    let mut costs = Vec::new();
    // One warm-up sample, then the measured ones.
    for sample in 0..=COST_SAMPLES {
        let mut encoder = device.create_command_encoder(&Default::default());
        for run in 0..COST_NODES_PER_SAMPLE {
            let input = DofInput {
                scene: &scene_view,
                depth: &depth_view,
                depth_samples: 1,
                output: Some((&output_view, wgpu::TextureFormat::Rgba16Float)),
                render: frame.size,
                proj: proj(frame.size),
                frame: DofFrameSettings { settings, tier },
            };
            let stamps = DofTimestamps::Span(&query_set, (run == 0).then_some(0), (run + 1 == COST_NODES_PER_SAMPLE).then_some(1));
            node.encode(device, &gpu.queue, &mut encoder, input, Some(stamps));
        }
        gpu.queue.submit([encoder.finish()]);
        device.poll(wgpu::PollType::wait_indefinitely()).expect("poll");
        // Resolved after the passes completed (Metal's counters read stale in the same buffer).
        let mut encoder = device.create_command_encoder(&Default::default());
        encoder.resolve_query_set(&query_set, 0..2, &resolve, 0);
        encoder.copy_buffer_to_buffer(&resolve, 0, &staging, 0, 16);
        gpu.queue.submit([encoder.finish()]);
        let slice = staging.slice(..);
        slice.map_async(wgpu::MapMode::Read, |result| result.expect("map"));
        device.poll(wgpu::PollType::wait_indefinitely()).expect("poll");
        let ticks: [u64; 2] = {
            let data = slice.get_mapped_range().expect("mapped");
            std::array::from_fn(|i| u64::from_le_bytes(data[i * 8..i * 8 + 8].try_into().expect("8 bytes")))
        };
        staging.unmap();
        if sample == 0 {
            continue;
        }
        match genex_render::timing::span_ms(ticks[0], ticks[1], period) {
            Some(ms) => costs.push(ms / COST_NODES_PER_SAMPLE as f32),
            None => eprintln!("dof cost: unusable stamps {ticks:?}"),
        }
    }
    assert!(!costs.is_empty(), "no usable timestamp sample");
    let mut sorted = costs.clone();
    sorted.sort_by(f32::total_cmp);
    Some((sorted[sorted.len() / 2], costs))
}

/// The node's GPU milliseconds per pass over `frame` (one node a sample, median of the samples).
fn pass_breakdown(gpu: &Gpu, frame: &Frame, settings: DepthOfField, tier: DofTier) -> Option<Vec<f32>> {
    let device = &gpu.device;
    if !device.features().contains(wgpu::Features::TIMESTAMP_QUERY) {
        return None;
    }
    let passes = tier.passes();
    let mut node = DofNode::new(device).expect("node");
    let mut pool = TargetPool::new();
    node.acquire(device, &mut pool, frame.size, tier, None).expect("targets");
    let scene = colour_texture(gpu, frame);
    let depth = depth_texture(gpu, frame, 1);
    let output = colour_texture(gpu, frame);
    let (scene_view, depth_view, output_view) = (scene.create_view(&Default::default()), depth.create_view(&Default::default()), output.create_view(&Default::default()));
    let count = 2 * passes;
    let bytes = u64::from(count) * 8;
    let query_set = device.create_query_set(&wgpu::QuerySetDescriptor { label: Some("dof passes"), ty: wgpu::QueryType::Timestamp, count });
    let resolve = device.create_buffer(&wgpu::BufferDescriptor { label: None, size: bytes, usage: wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC, mapped_at_creation: false });
    let staging = device.create_buffer(&wgpu::BufferDescriptor { label: None, size: bytes, usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false });
    let period = gpu.queue.get_timestamp_period();
    let mut per_pass: Vec<Vec<f32>> = vec![Vec::new(); passes as usize];
    for sample in 0..=COST_SAMPLES {
        let mut encoder = device.create_command_encoder(&Default::default());
        let input = DofInput {
            scene: &scene_view,
            depth: &depth_view,
            depth_samples: 1,
            output: Some((&output_view, wgpu::TextureFormat::Rgba16Float)),
            render: frame.size,
            proj: proj(frame.size),
            frame: DofFrameSettings { settings, tier },
        };
        node.encode(device, &gpu.queue, &mut encoder, input, Some(DofTimestamps::PerPass(&query_set)));
        gpu.queue.submit([encoder.finish()]);
        device.poll(wgpu::PollType::wait_indefinitely()).expect("poll");
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
        if sample == 0 {
            continue;
        }
        for (pass, times) in per_pass.iter_mut().enumerate() {
            if let Some(ms) = genex_render::timing::span_ms(ticks[2 * pass], ticks[2 * pass + 1], period) {
                times.push(ms);
            }
        }
    }
    Some(
        per_pass
            .into_iter()
            .map(|mut times| {
                times.sort_by(f32::total_cmp);
                times.get(times.len() / 2).copied().unwrap_or(f32::NAN)
            })
            .collect(),
    )
}

fn perf_row(name: &str, tier: DofTier, size: (u32, u32), median: f32, budget: Option<f32>) {
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
fn metal_depth_of_field_costs_at_most_1_ms_ring_and_0_4_ms_circular_at_1080p() {
    let Some(gpu) = gpu() else { return };
    let settings = DepthOfField::focused(1.0, 1.4);
    let mut over = Vec::new();
    for size in [(1920, 1080), (2560, 1440)] {
        let frame = close_up(size);
        for (tier, budget) in [(DofTier::Ring, RING_MS_MAX), (DofTier::Circular, CIRCULAR_MS_MAX)] {
            let Some((median, costs)) = cost_ms(&gpu, &frame, settings, tier) else {
                eprintln!("skipped: no timestamp queries");
                return;
            };
            let judged = (size == (1920, 1080)).then_some(budget);
            perf_row("dof-close-up", tier, size, median, judged);
            println!("  samples {costs:?}");
            if judged.is_some_and(|budget| median > budget) {
                over.push(format!("{tier:?} {size:?}: {median:.3} ms > {budget} ms"));
            }
        }
    }
    // Recorded, not judged: the fixed overhead (every tile in focus) and the heaviest blur (the
    // wall and the ledge at the tier's radius).
    let frame = close_up((1920, 1080));
    for tier in TIERS {
        let focused = Frame { size: frame.size, colour: frame.colour.clone(), depth: vec![depth_of(1.0); frame.depth.len()] };
        if let Some((median, _)) = cost_ms(&gpu, &focused, settings, tier) {
            perf_row("dof-in-focus", tier, frame.size, median, None);
        }
        if let Some((median, _)) = cost_ms(&gpu, &frame, settings.with_coc_scale(8.0), tier) {
            perf_row("dof-close-up-max-blur", tier, frame.size, median, None);
        }
        if let Some(passes) = pass_breakdown(&gpu, &frame, settings, tier) {
            println!("dof-close-up {tier:?} 1080p per pass (lone node, ms): {passes:.3?}");
        }
    }
    assert!(over.is_empty(), "over budget: {over:?}");
}
