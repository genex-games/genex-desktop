//! B.3 lake water: the optics' CPU twins, the inputs and reflection source each class gets, the
//! shader's validation and binding budget, and on the GPU the water node drawn over a sloped lake
//! bed against the twins (absorption, Fresnel and the sky's reflection, shore foam, refraction),
//! its own motion key for TAA and its cost.
//!
//! The CPU rows run everywhere. The GPU rows are `#[ignore]`d and every name contains `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --release --offline --locked --test water -- --ignored metal --test-threads=1
//!
//! `GENEX_PERF_OUT` receives the cost row as a JSON line.

use genex_render::Gpu;
use genex_render::device_class::{DeviceClass, FormFactor, PerformanceTier};
use genex_render::layout::GpuFrame;
use genex_render::presets::preset_quality;
use genex_render::screen_inputs::{ScreenInputs, frame_inputs};
use genex_render::settings::QualityPreset;
use genex_render::water::{
    F0, GpuWater, ReflectionSource, SAMPLED_TEXTURES, STORAGE_BUFFERS, WATER, WATER_MS_MAX, WaterBody, WaterFormats, WaterFrame, WaterInput, WaterMaterial, WaterNode, WaterPath, asked_inputs,
    fresnel, opacity, path, reflection_source, refraction_ramp, shore_foam, transmittance,
};
use glam::{Mat4, Vec3, Vec4};

fn desktop(tier: PerformanceTier) -> DeviceClass {
    DeviceClass::new(FormFactor::Desktop, tier)
}

fn phone() -> DeviceClass {
    DeviceClass::new(FormFactor::Mobile, PerformanceTier::High)
}

// ---------------------------------------------------------------------------------------------
// The optics' twins

#[test]
fn the_lake_absorbs_red_first_and_hides_more_of_the_bed_the_deeper_it_is() {
    let lake = WaterMaterial::LAKE;
    let shallow = transmittance(lake.absorption, 0.5);
    let deep = transmittance(lake.absorption, 4.0);
    assert!(shallow[0] < shallow[1] && shallow[1] <= shallow[2] + 1e-6, "red goes first, then green: {shallow:?}");
    for c in 0..3 {
        assert!(deep[c] < shallow[c], "channel {c}: deeper water passes less of the bed");
    }
    assert_eq!(transmittance(lake.absorption, 0.0), [1.0; 3], "no water hides nothing");
    assert!(opacity(lake.absorption, 0.0).abs() < 1e-6 && opacity(lake.absorption, 100.0) > 0.99, "opacity runs from clear to opaque");
}

#[test]
fn the_surface_reflects_two_percent_head_on_and_everything_at_grazing() {
    assert!((fresnel(1.0) - F0).abs() < 1e-6);
    assert!((fresnel(0.0) - 1.0).abs() < 1e-6);
    let mut last = fresnel(1.0);
    for k in 1..=20 {
        let f = fresnel(1.0 - k as f32 / 20.0);
        assert!(f >= last, "Fresnel grows towards grazing");
        last = f;
    }
}

#[test]
fn shore_foam_covers_the_shoreline_and_is_gone_past_its_width() {
    let width = WaterMaterial::LAKE.foam_width;
    assert!(shore_foam(0.0, width, 0.5) > 0.5, "the waterline foams");
    assert_eq!(shore_foam(width, width, 1.0), 0.0, "past the width no foam, whatever the noise");
    assert_eq!(shore_foam(0.0, 0.0, 1.0), 0.0, "a material without foam has none");
    assert!(shore_foam(0.0, width, 1.0) >= shore_foam(0.0, width, 0.0), "the noise breaks it up, never adds past the shallow cover");
}

#[test]
fn the_refraction_grows_from_nothing_at_the_shoreline() {
    assert_eq!(refraction_ramp(0.0), 0.0);
    assert!(refraction_ramp(0.5) > 0.0 && refraction_ramp(0.5) < 1.0);
    assert_eq!(refraction_ramp(10.0), 1.0);
}

// ---------------------------------------------------------------------------------------------
// Inputs and reflection sources per class

#[test]
fn desktop_high_and_ultra_refract_and_march_the_screen_and_phones_reflect_the_environment() {
    for preset in [QualityPreset::High, QualityPreset::Ultra] {
        let class = desktop(PerformanceTier::High);
        let quality = preset_quality(preset, class);
        let inputs = frame_inputs(&quality, true, asked_inputs());
        assert_eq!(path(inputs), WaterPath::Refracted, "{preset:?}: the opaque copy is there");
        assert_eq!(reflection_source(&quality, class, inputs), ReflectionSource::ScreenThenEnvironment, "{preset:?}");
    }
    for preset in [QualityPreset::Low, QualityPreset::Medium, QualityPreset::High, QualityPreset::Ultra] {
        let quality = preset_quality(preset, phone());
        let inputs = frame_inputs(&quality, true, asked_inputs());
        assert_eq!(reflection_source(&quality, phone(), inputs), ReflectionSource::Environment, "{preset:?}: no SSR on phones (plan B.3)");
    }
}

#[test]
fn without_an_opaque_copy_the_water_blends_unrefracted() {
    let class = desktop(PerformanceTier::High);
    let medium = preset_quality(QualityPreset::Medium, class);
    assert_eq!(path(frame_inputs(&medium, true, asked_inputs())), WaterPath::Blended, "medium draws MSAA: no opaque copy");
    let high = preset_quality(QualityPreset::High, class);
    assert_eq!(path(frame_inputs(&high, false, asked_inputs())), WaterPath::Blended, "the legacy scene has no screen inputs");
    assert_eq!(asked_inputs(), ScreenInputs::WATER);
}

// ---------------------------------------------------------------------------------------------
// The shader

fn module() -> naga::Module {
    naga::front::wgsl::parse_str(WATER).expect("the water's WGSL parses")
}

#[test]
fn the_water_validates_against_webgpu_core_and_emits_msl_hlsl_and_spirv() {
    // Core with cube arrays, as the forward stage's environment (tests/layout.rs).
    let module = module();
    let info = naga::valid::Validator::new(naga::valid::ValidationFlags::all(), naga::valid::Capabilities::CUBE_ARRAY_TEXTURES).validate(&module).expect("valid on WebGPU core");
    use naga::back::{hlsl, msl, spv};
    assert!(WATER.len() <= genex_render::WGSL_MAX_BYTES);
    let mut hlsl_source = String::new();
    let options = hlsl::Options { shader_model: hlsl::ShaderModel::V5_1, ..Default::default() };
    hlsl::Writer::new(&mut hlsl_source, &options, &hlsl::PipelineOptions::default()).write(&module, &info, None).expect("HLSL SM 5.1");
    let options = msl::Options { lang_version: (2, 4), ..Default::default() };
    msl::write_string(&module, &info, &options, &msl::PipelineOptions::default()).expect("MSL");
    let options = spv::Options { lang_version: (1, 3), ..Default::default() };
    spv::write_vec(&module, &info, &options, None).expect("SPIR-V");
}

#[test]
fn the_water_has_its_own_layout_within_the_stage_limits_and_its_row_matches_the_wgsl() {
    let module = module();
    let (mut sampled, mut storage) = (0, 0);
    for (_, var) in module.global_variables.iter() {
        match module.types[var.ty].inner {
            naga::TypeInner::Image { .. } => sampled += 1,
            _ if var.space == naga::AddressSpace::Storage { access: naga::StorageAccess::LOAD } => storage += 1,
            _ => {}
        }
        if let Some(binding) = &var.binding {
            assert!(binding.group <= 1, "group 0 the frame, group 1 the water's own: {binding:?}");
        }
    }
    assert_eq!(sampled, SAMPLED_TEXTURES);
    assert_eq!(storage, STORAGE_BUFFERS);
    assert!(sampled <= 16 && storage <= 8, "plan section 2: at most 16 sampled textures and 8 storage buffers a stage");
    let water = module.types.iter().find(|(_, ty)| ty.name.as_deref() == Some("Water")).expect("struct Water");
    let mut layouter = naga::proc::Layouter::default();
    layouter.update(module.to_ctx()).expect("layout");
    assert_eq!(layouter[water.0].size as usize, size_of::<GpuWater>(), "GpuWater mirrors `Water`");
}

// ---------------------------------------------------------------------------------------------
// GPU rows

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

const SIZE: (u32, u32) = (320, 192);
const COLOUR: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;
const DEPTH: wgpu::TextureFormat = wgpu::TextureFormat::Depth32Float;
/// The bed's slope: its height is `-BED_SLOPE * x` (the shoreline at x = 0, land at x < 0).
const BED_SLOPE: f32 = 0.3;
/// The opaque scene behind the water (the bed's colour), the sky the environment holds and the
/// ambient light (linear, under 1 so an 8-bit target keeps them).
const BED: [f32; 3] = [0.6, 0.5, 0.4];
const SKY: [f32; 3] = [0.3, 0.5, 0.8];
const AMBIENT: [f32; 3] = [0.5, 0.6, 0.7];
/// What a GPU pixel may differ from its twin by, 8-bit levels (quantisation, the depth's precision).
const TWIN_LEVELS: f32 = 3.0;
/// The longest underwater path a pixel is compared at, metres (beyond it the view ray grazes the
/// bed: 33-42 m paths at the far shore differ by up to 4.3 levels in blue from depth rounding).
const TWIN_PATH_MAX_M: f32 = 25.0;

struct Camera {
    eye: Vec3,
    view_proj: Mat4,
    proj: Mat4,
    forward: Vec3,
}

fn camera(eye: Vec3, size: (u32, u32)) -> Camera {
    let target = vec3_target(eye);
    let proj = glam::camera::rh::proj::directx::perspective_infinite_reverse(50f32.to_radians(), size.0 as f32 / size.1 as f32, 0.1);
    let view = glam::camera::rh::view::look_at_mat4(eye, target, Vec3::Y);
    Camera { eye, view_proj: proj * view, proj, forward: (target - eye).normalize() }
}

fn vec3_target(eye: Vec3) -> Vec3 {
    Vec3::new(eye.x, 0.0, eye.z + 14.0)
}

fn eye() -> Vec3 {
    Vec3::new(3.0, 5.0, -8.0)
}

fn frame_row(camera: &Camera) -> GpuFrame {
    let mut frame = GpuFrame { view_proj: camera.view_proj.to_cols_array(), ..GpuFrame::default() };
    frame.camera_pos = [camera.eye.x, camera.eye.y, camera.eye.z, 1.0];
    frame.camera_forward = [camera.forward.x, camera.forward.y, camera.forward.z, 0.0];
    frame.sun_dir = [0.0, 1.0, 0.0, 0.0];
    frame.ambient = [AMBIENT[0], AMBIENT[1], AMBIENT[2], 1.0];
    frame.cascade_splits = [0.0, 0.0, 1.0, 0.0];
    frame
}

fn body(material: WaterMaterial) -> WaterBody {
    WaterBody { centre: [0.0, 0.0, 10.0], half_extent: [40.0, 40.0], material }
}

fn still_lake() -> WaterMaterial {
    WaterMaterial { foam_width: 0.0, refraction: 0.0, ripple: 0.0, roughness: 0.0, ..WaterMaterial::LAKE }
}

fn texture(gpu: &Gpu, size: (u32, u32), format: wgpu::TextureFormat, usage: wgpu::TextureUsages) -> wgpu::Texture {
    gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: None,
        size: wgpu::Extent3d { width: size.0, height: size.1, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage,
        view_formats: &[],
    })
}

fn unorm(c: [f32; 3]) -> [u8; 4] {
    [(c[0] * 255.0).round() as u8, (c[1] * 255.0).round() as u8, (c[2] * 255.0).round() as u8, 255]
}

/// The environment: a one-texel cube array of six sky faces.
fn sky_cube(gpu: &Gpu) -> wgpu::TextureView {
    let texture = gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("sky"),
        size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 6 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: COLOUR,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    let texels: Vec<u8> = (0..6).flat_map(|_| unorm(SKY)).collect();
    gpu.queue.write_texture(
        texture.as_image_copy(),
        &texels,
        wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(4), rows_per_image: Some(1) },
        wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 6 },
    );
    texture.create_view(&wgpu::TextureViewDescriptor { dimension: Some(wgpu::TextureViewDimension::CubeArray), ..Default::default() })
}

/// The bed's colour picture: `BED`, or with `stripes` 8-pixel vertical stripes of it and its half.
fn bed_picture(gpu: &Gpu, size: (u32, u32), stripes: bool) -> wgpu::Texture {
    let texture = texture(gpu, size, COLOUR, wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::RENDER_ATTACHMENT);
    let mut texels = Vec::with_capacity((size.0 * size.1 * 4) as usize);
    for _y in 0..size.1 {
        for x in 0..size.0 {
            let dark = stripes && (x / 8) % 2 == 1;
            texels.extend(unorm(if dark { BED.map(|c| c * 0.5) } else { BED }));
        }
    }
    gpu.queue.write_texture(
        texture.as_image_copy(),
        &texels,
        wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(size.0 * 4), rows_per_image: Some(size.1) },
        wgpu::Extent3d { width: size.0, height: size.1, depth_or_array_layers: 1 },
    );
    texture
}

/// The sloped bed drawn into `depth` (reverse-Z, cleared to 0) through `camera`.
fn draw_bed(gpu: &Gpu, camera: &Camera, depth: &wgpu::TextureView) {
    use wgpu::util::DeviceExt;
    let source = format!(
        "@group(0) @binding(0) var<uniform> view_proj: mat4x4<f32>;\n\
         @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {{\n\
           var c = array<vec2<f32>, 6>(vec2(-1.0, -1.0), vec2(1.0, -1.0), vec2(1.0, 1.0), vec2(-1.0, -1.0), vec2(1.0, 1.0), vec2(-1.0, 1.0));\n\
           let xz = c[i] * 60.0 + vec2(0.0, 20.0);\n\
           return view_proj * vec4<f32>(xz.x, -{BED_SLOPE:?} * xz.x, xz.y, 1.0);\n\
         }}\n"
    );
    let module = gpu.device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("bed"), source: wgpu::ShaderSource::Wgsl(source.into()) });
    let pipeline = gpu.device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("bed"),
        layout: None,
        vertex: wgpu::VertexState { module: &module, entry_point: Some("vs"), compilation_options: Default::default(), buffers: &[] },
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: Some(wgpu::DepthStencilState {
            format: DEPTH,
            depth_write_enabled: Some(true),
            depth_compare: Some(wgpu::CompareFunction::Greater),
            stencil: Default::default(),
            bias: Default::default(),
        }),
        multisample: Default::default(),
        fragment: None,
        multiview_mask: None,
        cache: None,
    });
    let uniform = gpu.device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: None, contents: bytemuck::cast_slice(&camera.view_proj.to_cols_array()), usage: wgpu::BufferUsages::UNIFORM });
    let group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: None,
        layout: &pipeline.get_bind_group_layout(0),
        entries: &[wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() }],
    });
    let mut encoder = gpu.device.create_command_encoder(&Default::default());
    {
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("bed"),
            color_attachments: &[],
            depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                view: depth,
                depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(0.0), store: wgpu::StoreOp::Store }),
                stencil_ops: None,
            }),
            ..Default::default()
        });
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.draw(0..6, 0..1);
    }
    gpu.queue.submit([encoder.finish()]);
}

/// One water picture: what the twins are checked against.
struct Drawn {
    rgba: Vec<[f32; 4]>,
}

struct Setup {
    camera: Camera,
    material: WaterMaterial,
    path: WaterPath,
    reflection: ReflectionSource,
    stripes: bool,
    size: (u32, u32),
}

impl Setup {
    fn still(path: WaterPath) -> Setup {
        Setup { camera: camera(eye(), SIZE), material: still_lake(), path, reflection: ReflectionSource::Environment, stripes: false, size: SIZE }
    }
}

struct Scene {
    node: WaterNode,
    colour: wgpu::Texture,
    world_depth: wgpu::TextureView,
    frame: wgpu::Buffer,
}

fn scene(gpu: &Gpu, setup: &Setup) -> Scene {
    use wgpu::util::DeviceExt;
    let device = &gpu.device;
    let depth_usage = wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING;
    let sampled_depth = texture(gpu, setup.size, DEPTH, depth_usage).create_view(&Default::default());
    let world_depth = texture(gpu, setup.size, DEPTH, depth_usage).create_view(&Default::default());
    draw_bed(gpu, &setup.camera, &sampled_depth);
    draw_bed(gpu, &setup.camera, &world_depth);
    let colour = bed_picture(gpu, setup.size, setup.stripes);
    let opaque = bed_picture(gpu, setup.size, setup.stripes).create_view(&Default::default());
    let env = sky_cube(gpu);
    let frame = device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("frame"), contents: bytemuck::bytes_of(&frame_row(&setup.camera)), usage: wgpu::BufferUsages::UNIFORM });
    let formats = WaterFormats { colour: COLOUR, depth: DEPTH, depth_reversed: true, colour_writes_depth: false };
    let mut node = WaterNode::new(device, formats).expect("the water node");
    let row = GpuWater::new(&WaterFrame {
        body: body(setup.material),
        proj: setup.camera.proj,
        prev_view_proj: setup.camera.view_proj,
        render: setup.size,
        time: 0.0,
        env_mips: 1,
        path: setup.path,
        reflection: setup.reflection,
        depth_reversed: true,
    });
    let refracting = setup.path == WaterPath::Refracted;
    node.prepare(device, &gpu.queue, &row, &WaterInput { frame: &frame, opaque: refracting.then_some(&opaque), depth: &sampled_depth, env: &env, history: None });
    Scene { node, colour, world_depth, frame }
}

fn colour_pass<'a>(encoder: &'a mut wgpu::CommandEncoder, colour: &'a wgpu::TextureView, depth: &'a wgpu::TextureView, stamps: Option<&'a wgpu::QuerySet>) -> wgpu::RenderPass<'a> {
    encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some("water"),
        color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: colour, depth_slice: None, resolve_target: None, ops: wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store } })],
        depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment { view: depth, depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store }), stencil_ops: None }),
        timestamp_writes: stamps.map(|set| wgpu::RenderPassTimestampWrites { query_set: set, beginning_of_pass_write_index: Some(0), end_of_pass_write_index: Some(1) }),
        ..Default::default()
    })
}

fn read_texture(gpu: &Gpu, texture: &wgpu::Texture, texel_bytes: u32) -> Vec<u8> {
    let (w, h) = (texture.width(), texture.height());
    let row = (w * texel_bytes).div_ceil(256) * 256;
    let staging = gpu.device.create_buffer(&wgpu::BufferDescriptor { label: None, size: u64::from(row * h), usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false });
    let mut encoder = gpu.device.create_command_encoder(&Default::default());
    encoder.copy_texture_to_buffer(
        texture.as_image_copy(),
        wgpu::TexelCopyBufferInfo { buffer: &staging, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(row), rows_per_image: Some(h) } },
        wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
    );
    gpu.queue.submit([encoder.finish()]);
    let slice = staging.slice(..);
    slice.map_async(wgpu::MapMode::Read, |result| result.expect("map"));
    gpu.device.poll(wgpu::PollType::wait_indefinitely()).expect("poll");
    let data = slice.get_mapped_range().expect("mapped");
    (0..h).flat_map(|y| data[(y * row) as usize..(y * row + w * texel_bytes) as usize].to_vec()).collect()
}

fn draw(gpu: &Gpu, setup: &Setup) -> Drawn {
    let scene = scene(gpu, setup);
    let view = scene.colour.create_view(&Default::default());
    let mut encoder = gpu.device.create_command_encoder(&Default::default());
    {
        let mut pass = colour_pass(&mut encoder, &view, &scene.world_depth, None);
        scene.node.draw_colour(&mut pass);
    }
    gpu.queue.submit([encoder.finish()]);
    let bytes = read_texture(gpu, &scene.colour, 4);
    let _ = &scene.frame;
    Drawn { rgba: bytes.as_chunks::<4>().0.iter().map(|t| t.map(|b| f32::from(b) / 255.0)).collect() }
}

/// What the twins see at pixel (x, y): the water's entry point and the bed's under it along the
/// pixel's ray, or None where the bed is above the water (land) or the ray misses the water.
struct Ray {
    view: Vec3,
    path: f32,
    below: f32,
}

fn ray(camera: &Camera, size: (u32, u32), x: u32, y: u32) -> Option<Ray> {
    let ndc = Vec4::new((x as f32 + 0.5) / size.0 as f32 * 2.0 - 1.0, 1.0 - (y as f32 + 0.5) / size.1 as f32 * 2.0, 0.5, 1.0);
    let far = camera.view_proj.inverse() * ndc;
    let dir = (far.truncate() / far.w - camera.eye).normalize();
    if dir.y >= -1e-4 {
        return None;
    }
    let to_water = -camera.eye.y / dir.y;
    // The bed plane: BED_SLOPE x + y = 0.
    let normal = Vec3::new(BED_SLOPE, 1.0, 0.0);
    let to_bed = -normal.dot(camera.eye) / normal.dot(dir);
    let hit = camera.eye + dir * to_water;
    let inside = hit.x.abs() < 40.0 && (hit.z - 10.0).abs() < 40.0;
    if !inside || to_bed <= to_water + 1e-3 {
        return None;
    }
    let path = to_bed - to_water;
    Some(Ray { view: -dir, path, below: path * dir.y.abs() })
}

/// The refracted path's twin of a still lake (no ripples, foam or offset): the bed behind,
/// absorbed and filled by the in-scattered ambient, then the sky mixed in by Fresnel.
fn twin_refracted(material: &WaterMaterial, ray: &Ray) -> [f32; 3] {
    let t = transmittance(material.absorption, ray.path);
    let f = fresnel(ray.view.y);
    std::array::from_fn(|c| (BED[c] * t[c] + material.scatter[c] * AMBIENT[c] * (1.0 - t[c])) * (1.0 - f) + SKY[c] * f)
}

/// The blended path's twin: no bed term in the water's colour; the scene behind passes through
/// the premultiplied blend by the mean transmittance.
fn twin_blended(material: &WaterMaterial, ray: &Ray) -> [f32; 3] {
    let t = transmittance(material.absorption, ray.path);
    let f = fresnel(ray.view.y);
    let alpha = opacity(material.absorption, ray.path) * (1.0 - f) + f;
    std::array::from_fn(|c| material.scatter[c] * AMBIENT[c] * (1.0 - t[c]) * (1.0 - f) + SKY[c] * f + BED[c] * (1.0 - alpha))
}

fn compare(drawn: &Drawn, setup: &Setup, twin: impl Fn(&Ray) -> [f32; 3]) -> (usize, f32) {
    let (mut compared, mut worst) = (0, 0.0f32);
    for y in 0..setup.size.1 {
        for x in 0..setup.size.0 {
            let Some(ray) = ray(&setup.camera, setup.size, x, y) else { continue };
            // Past this path the ray runs nearly along the far shore's bed, where a depth texel's
            // rounding moves the path by metres: compared there would test the depth, not the water.
            if ray.path > TWIN_PATH_MAX_M {
                continue;
            }
            let gpu = drawn.rgba[(y * setup.size.0 + x) as usize];
            let want = twin(&ray);
            for c in 0..3 {
                let off = (gpu[c] - want[c].clamp(0.0, 1.0)).abs() * 255.0;
                if off > TWIN_LEVELS {
                    eprintln!("  ({x}, {y}) channel {c}: {off:.2} levels, path {:.3} m, view.y {:.3}", ray.path, ray.view.y);
                }
                worst = worst.max(off);
            }
            compared += 1;
        }
    }
    (compared, worst)
}

/// B.3: a still lake over a sloped bed matches its twins pixel for pixel on both paths: the bed
/// absorbed red first and hidden with depth, the sky reflected by Fresnel towards grazing.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_still_lake_absorbs_and_reflects_as_its_twins_say_on_both_paths() {
    let Some(gpu) = gpu() else { return };
    for (water_path, twin) in [(WaterPath::Refracted, twin_refracted as fn(&WaterMaterial, &Ray) -> [f32; 3]), (WaterPath::Blended, twin_blended)] {
        let setup = Setup::still(water_path);
        let drawn = draw(&gpu, &setup);
        let (compared, worst) = compare(&drawn, &setup, |ray| twin(&setup.material, ray));
        eprintln!("{water_path:?}: {compared} water pixels, worst {worst:.2} levels");
        assert!(compared > (SIZE.0 * SIZE.1 / 4) as usize, "the lake covers the picture's lower part");
        assert!(worst <= TWIN_LEVELS, "{water_path:?}: a pixel {worst:.2} levels from its twin");
    }
}

/// `drawn` as a binary PPM named `name` in `GENEX_WATER_OUT`, when it is set (evidence to look at).
fn write_ppm(name: &str, drawn: &Drawn, size: (u32, u32)) {
    let Ok(dir) = std::env::var("GENEX_WATER_OUT") else { return };
    let mut bytes = format!("P6\n{} {}\n255\n", size.0, size.1).into_bytes();
    for texel in &drawn.rgba {
        bytes.extend(texel[..3].iter().map(|c| (c * 255.0).round() as u8));
    }
    std::fs::write(std::path::Path::new(&dir).join(format!("{name}.ppm")), bytes).expect("write the picture");
}

fn luma(c: [f32; 4]) -> f32 {
    0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}

/// B.3: shore foam brightens the water at its shoreline and leaves deeper water as it was.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_shoreline_foams_and_deeper_water_does_not() {
    let Some(gpu) = gpu() else { return };
    let plain = Setup::still(WaterPath::Refracted);
    let foamy = Setup { material: WaterMaterial { foam_width: 0.4, ..still_lake() }, ..Setup::still(WaterPath::Refracted) };
    let (a, b) = (draw(&gpu, &plain), draw(&gpu, &foamy));
    write_ppm("water-still", &a, SIZE);
    write_ppm("water-foam", &b, SIZE);
    let (mut shore, mut shore_n, mut deep_worst) = (0.0, 0, 0.0f32);
    for y in 0..SIZE.1 {
        for x in 0..SIZE.0 {
            let Some(ray) = ray(&plain.camera, SIZE, x, y) else { continue };
            let i = (y * SIZE.0 + x) as usize;
            if ray.below < 0.05 {
                shore += (luma(b.rgba[i]) - luma(a.rgba[i])).abs();
                shore_n += 1;
            } else if ray.below > 0.6 {
                deep_worst = deep_worst.max((luma(b.rgba[i]) - luma(a.rgba[i])).abs() * 255.0);
            }
        }
    }
    assert!(shore_n > 0, "the picture holds the shoreline");
    let lift = shore / shore_n as f32 * 255.0;
    eprintln!("shoreline change {lift:.1} levels over {shore_n} pixels, deep worst {deep_worst:.2}");
    assert!(lift.abs() > 8.0, "the shoreline foams: {lift:.1} levels");
    assert!(deep_worst <= 1.0, "deep water unchanged by the foam: {deep_worst:.2}");
}

/// B.3: the ripples bend the bed seen through deep water and leave it straight at the shoreline.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_ripples_refract_deep_water_and_not_the_shoreline() {
    let Some(gpu) = gpu() else { return };
    let rippled = WaterMaterial { ripple: 0.3, ..still_lake() };
    let straight = Setup { material: rippled, stripes: true, ..Setup::still(WaterPath::Refracted) };
    let bent = Setup { material: WaterMaterial { refraction: 0.03, ..rippled }, stripes: true, ..Setup::still(WaterPath::Refracted) };
    let (a, b) = (draw(&gpu, &straight), draw(&gpu, &bent));
    write_ppm("water-refracted", &b, SIZE);
    let (mut deep, mut deep_moved, mut shore_worst) = (0, 0, 0.0f32);
    for y in 0..SIZE.1 {
        for x in 0..SIZE.0 {
            let Some(ray) = ray(&straight.camera, SIZE, x, y) else { continue };
            let i = (y * SIZE.0 + x) as usize;
            let diff = (luma(b.rgba[i]) - luma(a.rgba[i])).abs() * 255.0;
            if ray.path < 0.005 {
                shore_worst = shore_worst.max(diff);
            } else if ray.path > 3.0 {
                deep += 1;
                deep_moved += usize::from(diff > 2.0);
            }
        }
    }
    eprintln!("deep pixels moved {deep_moved} of {deep}; shoreline worst {shore_worst:.2} levels");
    assert!(deep > 0 && deep_moved * 5 > deep, "the bed bends under deep water");
    assert!(shore_worst <= 2.0, "no offset at the shoreline");
}

/// B.3 (T-01 step 3): the water writes its own motion into the motion prepass's target, the
/// surface's NDC motion between last frame's camera and this one, not the bed's under it, and no
/// reactive coverage.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_water_writes_its_own_motion_for_taa() {
    let Some(gpu) = gpu() else { return };
    let setup = Setup::still(WaterPath::Refracted);
    let previous = camera(eye() + Vec3::new(-0.25, 0.1, -0.2), SIZE);
    let scene = scene(&gpu, &setup);
    let mut node = scene.node;
    let opaque = bed_picture(&gpu, SIZE, false).create_view(&Default::default());
    let sampled = texture(&gpu, SIZE, DEPTH, wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING).create_view(&Default::default());
    draw_bed(&gpu, &setup.camera, &sampled);
    let env = sky_cube(&gpu);
    let row = GpuWater::new(&WaterFrame {
        body: body(setup.material),
        proj: setup.camera.proj,
        prev_view_proj: previous.view_proj,
        render: SIZE,
        time: 0.0,
        env_mips: 1,
        path: WaterPath::Refracted,
        reflection: ReflectionSource::Environment,
        depth_reversed: true,
    });
    node.prepare(&gpu.device, &gpu.queue, &row, &WaterInput { frame: &scene.frame, opaque: Some(&opaque), depth: &sampled, env: &env, history: None });
    let [normals, motion_format, reactive] = genex_render::motion::TARGET_FORMATS;
    let usage = wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC;
    let targets = [texture(&gpu, SIZE, normals, usage), texture(&gpu, SIZE, motion_format, usage), texture(&gpu, SIZE, reactive, usage)];
    let views: Vec<wgpu::TextureView> = targets.iter().map(|t| t.create_view(&Default::default())).collect();
    let mut encoder = gpu.device.create_command_encoder(&Default::default());
    {
        // The motion prepass's targets hold the bed's key before the water writes its own.
        let attachments: Vec<Option<wgpu::RenderPassColorAttachment>> = views
            .iter()
            .map(|view| Some(wgpu::RenderPassColorAttachment { view, depth_slice: None, resolve_target: None, ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color { r: 9.0, g: 9.0, b: 9.0, a: 9.0 }), store: wgpu::StoreOp::Store } }))
            .collect();
        encoder.begin_render_pass(&wgpu::RenderPassDescriptor { label: Some("bed key"), color_attachments: &attachments, ..Default::default() });
    }
    node.encode_motion(&mut encoder, [&views[0], &views[1], &views[2]], &scene.world_depth);
    gpu.queue.submit([encoder.finish()]);
    assert_eq!(motion_format, wgpu::TextureFormat::Rg16Float);
    let motion = read_texture(&gpu, &targets[1], 4);
    let reactive_texels = read_texture(&gpu, &targets[2], 1);
    let (mut compared, mut worst, mut reactive_marked) = (0, 0.0f32, 0);
    for y in 0..SIZE.1 {
        for x in 0..SIZE.0 {
            let Some(ray) = ray(&setup.camera, SIZE, x, y) else { continue };
            let point = setup.camera.eye - ray.view * (-setup.camera.eye.y / -ray.view.y);
            let ndc = |m: Mat4| {
                let clip = m * point.extend(1.0);
                clip.truncate().truncate() / clip.w
            };
            let want = ndc(setup.camera.view_proj) - ndc(previous.view_proj);
            let i = ((y * SIZE.0 + x) * 4) as usize;
            let got = [genex_render::post::tonemap::f16_to_f32(u16::from_le_bytes([motion[i], motion[i + 1]])), genex_render::post::tonemap::f16_to_f32(u16::from_le_bytes([motion[i + 2], motion[i + 3]]))];
            // An f16 holds about three decimal digits; the bed's motion here differs by far more.
            worst = worst.max((got[0] - want.x).abs().max((got[1] - want.y).abs()) / want.length().max(1e-3));
            reactive_marked += usize::from(reactive_texels[(y * SIZE.0 + x) as usize] != 0);
            compared += 1;
        }
    }
    eprintln!("motion: {compared} water pixels, worst relative error {worst:.4}, {reactive_marked} marked reactive");
    assert!(compared > 0);
    assert_eq!(reactive_marked, 0, "the water keeps its history: no reactive coverage");
    assert!(worst < 0.02, "the water's motion is its own surface's: worst relative error {worst:.4}");
}

/// B.3: the water at a 1080p render (the lake over most of the picture, refracted, the screen
/// reflections marching) costs at most `WATER_MS_MAX` (median of the samples).
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_water_costs_at_most_one_millisecond_at_1080p() {
    const DRAWS: u32 = 8;
    const SAMPLES: usize = 15;
    const WARM_UP: usize = 5;
    let Some(gpu) = gpu() else { return };
    if !gpu.device.features().contains(wgpu::Features::TIMESTAMP_QUERY) {
        eprintln!("skipped: no timestamps");
        return;
    }
    let size = (1920, 1080);
    let setup = Setup { camera: camera(eye(), size), material: WaterMaterial::LAKE, reflection: ReflectionSource::ScreenThenEnvironment, size, ..Setup::still(WaterPath::Refracted) };
    let scene = scene(&gpu, &setup);
    let view = scene.colour.create_view(&Default::default());
    let set = gpu.device.create_query_set(&wgpu::QuerySetDescriptor { label: Some("water cost"), ty: wgpu::QueryType::Timestamp, count: 2 });
    let resolve = gpu.device.create_buffer(&wgpu::BufferDescriptor { label: None, size: 16, usage: wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC, mapped_at_creation: false });
    let mut times = Vec::new();
    for run in 0..WARM_UP + SAMPLES {
        let mut encoder = gpu.device.create_command_encoder(&Default::default());
        {
            let mut pass = colour_pass(&mut encoder, &view, &scene.world_depth, Some(&set));
            for _ in 0..DRAWS {
                scene.node.draw_colour(&mut pass);
            }
        }
        encoder.resolve_query_set(&set, 0..2, &resolve, 0);
        gpu.queue.submit([encoder.finish()]);
        let staging = gpu.device.create_buffer(&wgpu::BufferDescriptor { label: None, size: 16, usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false });
        let mut copy = gpu.device.create_command_encoder(&Default::default());
        copy.copy_buffer_to_buffer(&resolve, 0, &staging, 0, 16);
        gpu.queue.submit([copy.finish()]);
        let slice = staging.slice(..);
        slice.map_async(wgpu::MapMode::Read, |result| result.expect("map"));
        gpu.device.poll(wgpu::PollType::wait_indefinitely()).expect("poll");
        let ticks: Vec<u64> = {
            let data = slice.get_mapped_range().expect("mapped");
            (0..2).map(|i| u64::from_le_bytes(data[i * 8..i * 8 + 8].try_into().expect("8 bytes"))).collect()
        };
        if let (true, Some(ms)) = (run >= WARM_UP, genex_render::timing::span_ms(ticks[0], ticks[1], gpu.queue.get_timestamp_period())) {
            times.push(ms / DRAWS as f32);
        }
    }
    times.sort_by(f32::total_cmp);
    let median = times[times.len() / 2];
    let row = format!("{{\"row\":\"water-1080p\",\"size\":[1920,1080],\"median_ms\":{median:.4},\"budget_ms\":{WATER_MS_MAX}}}");
    println!("{row}");
    if let Ok(path) = std::env::var("GENEX_PERF_OUT") {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new().create(true).append(true).open(path).expect("perf out");
        writeln!(file, "{row}").expect("perf row");
    }
    assert!(median <= WATER_MS_MAX, "the water costs {median:.3} ms at 1080p against {WATER_MS_MAX}");
}
