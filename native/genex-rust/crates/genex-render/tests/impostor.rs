//! Octahedral impostors (game systems LOD-12, LOD-13; a port of kansei's impostors, MIT).
//!
//! CPU rows (LOD-12): the frame mapping, the per-class atlas table and its ledger, and the species
//! cap. GPU rows (LOD-13, skipped without a WebGPU-core adapter): the bake against an independent
//! orthographic capture, coverage-preserving mips, the storage formats and a re-bake on a fresh
//! device.
//!
//!   node scripts/toolchains/rust-env.ts -- cargo test -p genex-render --test impostor --offline --locked

use genex_render::budget::{BudgetKind, BudgetLedger};
use genex_render::device_class::{DeviceClass, FormFactor, PerformanceTier};
use genex_render::impostor::{
    ImpostorClass, ImpostorLayout, ImpostorRefusal, admit_species, decode, encode, frame_axes, frame_direction, frame_of, impostor_class,
};
use genex_render::settings::QualityPreset;

const LAYOUTS: [ImpostorLayout; 2] = [ImpostorLayout::Hemi, ImpostorLayout::Sphere];
const MB: f64 = 1.0e6;

fn length(v: [f32; 3]) -> f32 {
    (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt()
}

fn distance(a: [f32; 3], b: [f32; 3]) -> f32 {
    length([a[0] - b[0], a[1] - b[1], a[2] - b[2]])
}

fn dot(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// The six axes and a golden-angle spiral over the sphere (kansei's test directions).
fn directions() -> Vec<[f32; 3]> {
    let mut dirs = vec![[1.0, 0.0, 0.0], [-1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, -1.0, 0.0], [0.0, 0.0, 1.0], [0.0, 0.0, -1.0]];
    for i in 0..200 {
        let y = 1.0 - (i as f32 + 0.5) / 100.0;
        let r = (1.0 - y * y).max(0.0).sqrt();
        let a = i as f32 * 2.399_963;
        dirs.push([r * libm::cosf(a), y, r * libm::sinf(a)]);
    }
    dirs
}

#[test]
fn frame_direction_round_trips_through_encode_for_every_frame() {
    for layout in LAYOUTS {
        for frames in [8, 10, 12] {
            for row in 0..frames {
                for column in 0..frames {
                    let dir = frame_direction(frames, layout, column, row);
                    assert!((length(dir) - 1.0).abs() < 1e-5, "{layout:?} {frames}: frame ({column}, {row}) is a unit direction");
                    let grid = encode(dir, layout);
                    let centre = [((column as f32 + 0.5) / frames as f32) * 2.0 - 1.0, ((row as f32 + 0.5) / frames as f32) * 2.0 - 1.0];
                    let off = (grid[0] - centre[0]).abs().max((grid[1] - centre[1]).abs());
                    assert!(off < 1e-5, "{layout:?} {frames}: frame ({column}, {row}) encodes to {grid:?}, its cell centre is {centre:?}");
                    assert_eq!(frame_of(dir, frames, layout), (column, row), "{layout:?} {frames}: the cell holding frame ({column}, {row})");
                }
            }
        }
    }
}

#[test]
fn the_octahedral_mapping_round_trips_and_the_hemi_layout_folds_below_the_horizon() {
    for d in directions() {
        let g = encode(d, ImpostorLayout::Sphere);
        assert!(g[0].abs().max(g[1].abs()) <= 1.0 + 1e-6, "{d:?} -> {g:?}");
        assert!(distance(decode(g, ImpostorLayout::Sphere), d) < 1e-5, "sphere {d:?}");
        let h = encode(d, ImpostorLayout::Hemi);
        assert!(h[0].abs().max(h[1].abs()) <= 1.0 + 1e-6, "hemi {d:?} -> {h:?}");
        if d[1] >= 0.0 {
            assert!(distance(decode(h, ImpostorLayout::Hemi), d) < 1e-5, "hemi {d:?}");
        } else if d[0].abs() + d[2].abs() > 1e-3 {
            let flat_len = (d[0] * d[0] + d[2] * d[2]).sqrt();
            let flat = [d[0] / flat_len, 0.0, d[2] / flat_len];
            assert!(distance(decode(h, ImpostorLayout::Hemi), flat) < 1e-4, "hemi {d:?} below the horizon lands on it");
        }
    }
}

#[test]
fn frames_cover_their_layout_and_their_axes_are_the_bake_cameras() {
    for layout in LAYOUTS {
        let n = 8;
        let frames: Vec<[f32; 3]> = (0..n * n).map(|k| frame_direction(n, layout, k % n, k / n)).collect();
        for d in directions().into_iter().filter(|d| layout == ImpostorLayout::Sphere || d[1] >= 0.05) {
            let nearest = frames.iter().map(|f| dot(*f, d)).fold(-1.0f32, f32::max);
            assert!(nearest > 0.93, "{layout:?}: {d:?} is {:.1} deg from a frame", libm::acosf(nearest).to_degrees());
        }
        for &d in &frames {
            let axes = frame_axes(d);
            let view = glam::camera::rh::view::look_at_mat4(glam::Vec3::from(d) * 3.0, glam::Vec3::ZERO, glam::Vec3::from(axes.up_reference));
            assert!(view.transform_vector3(axes.right.into()).distance(glam::Vec3::X) < 1e-5, "{d:?}: right is the camera's x");
            assert!(view.transform_vector3(axes.up.into()).distance(glam::Vec3::Y) < 1e-5, "{d:?}: up is the camera's y");
            assert!(view.transform_vector3(d.into()).distance(glam::Vec3::Z) < 1e-5, "{d:?}: the direction is the camera's z");
        }
    }
}

/// The design's table (MB = 10^6 bytes): three RGBA8 atlases with mips per species, and the cap.
const TABLE: [(ImpostorClass, u32, u32, f64, u32, f64); 5] = [
    (ImpostorClass::Ultra, 12, 96, 21.2, 8, 170.0),
    (ImpostorClass::High, 10, 64, 6.6, 12, 79.0),
    (ImpostorClass::Mid, 8, 64, 4.2, 12, 50.0),
    (ImpostorClass::Low, 8, 48, 2.4, 8, 19.0),
    (ImpostorClass::Mobile, 8, 32, 1.05, 6, 6.3),
];

#[test]
fn class_table_bytes_match_the_ledger() {
    for (class, frames, frame_px, species_mb, cap, cap_mb) in TABLE {
        let spec = class.spec();
        assert_eq!((spec.frames, spec.frame_px, spec.species_cap), (frames, frame_px, cap), "{class:?}'s frames, frame size and cap");
        let species = spec.species_bytes() as f64 / MB;
        let digits = if species_mb < 2.0 { 0.005 } else { 0.05 };
        assert!((species - species_mb).abs() <= digits, "{class:?}: {species:.3} MB per species, the table says {species_mb}");
        let at_cap = spec.cap_bytes() as f64 / MB;
        let cap_digits = if cap_mb < 10.0 { 0.05 } else { 0.5 };
        assert!((at_cap - cap_mb).abs() <= cap_digits, "{class:?}: {at_cap:.2} MB at the cap, the table says {cap_mb}");
        // The atlas mips stop where a frame's side would turn odd: blocks never straddle frames.
        assert_eq!(spec.frame_px >> (spec.mip_levels() - 1) & 1, 1, "{class:?}: the last mip's frame side is odd or 1");
        let mut ledger = BudgetLedger::new();
        let names: Vec<String> = (0..cap).map(|k| format!("species-{k}")).collect();
        let admission = admit_species(class, &names, &mut ledger);
        assert!(admission.refused.is_empty());
        assert_eq!(ledger.total_of(BudgetKind::Impostors), spec.cap_bytes(), "{class:?}: the ledger holds the cap's bytes");
        assert_eq!(ledger.total(), spec.cap_bytes(), "{class:?}: and nothing else");
    }
}

#[test]
fn species_past_the_cap_are_degraded_budget() {
    let class = ImpostorClass::High;
    let names: Vec<String> = (0..14).map(|k| format!("tree-{k:02}")).collect();
    let mut ledger = BudgetLedger::new();
    let admission = admit_species(class, &names, &mut ledger);
    assert_eq!(admission.admitted, names[..12].to_vec(), "the first twelve, in declaration order");
    assert_eq!(admission.refused, vec![(names[12].clone(), ImpostorRefusal::Budget), (names[13].clone(), ImpostorRefusal::Budget)]);
    assert_eq!(ImpostorRefusal::Budget.wire(), "budget", "listed in `degraded` as the budget reason");
    assert_eq!(ledger.total_of(BudgetKind::Impostors), 12 * class.spec().species_bytes());
    // Admitting the same species again replaces their entries; it never double counts.
    let again = admit_species(class, &names, &mut ledger);
    assert_eq!(again.admitted.len(), 12);
    assert_eq!(ledger.total_of(BudgetKind::Impostors), 12 * class.spec().species_bytes());
}

#[test]
fn each_preset_and_device_class_takes_its_row_of_the_table() {
    let desktop = |tier| DeviceClass::new(FormFactor::Desktop, tier);
    let mobile = |tier| DeviceClass::new(FormFactor::Mobile, tier);
    assert_eq!(impostor_class(QualityPreset::Ultra, desktop(PerformanceTier::Ultra)), ImpostorClass::Ultra);
    assert_eq!(impostor_class(QualityPreset::High, desktop(PerformanceTier::High)), ImpostorClass::High);
    assert_eq!(impostor_class(QualityPreset::Medium, desktop(PerformanceTier::Mid)), ImpostorClass::Mid);
    assert_eq!(impostor_class(QualityPreset::Low, desktop(PerformanceTier::Low)), ImpostorClass::Low);
    assert_eq!(impostor_class(QualityPreset::High, mobile(PerformanceTier::High)), ImpostorClass::Low);
    assert_eq!(impostor_class(QualityPreset::Medium, mobile(PerformanceTier::Mid)), ImpostorClass::Mobile);
    assert_eq!(impostor_class(QualityPreset::Low, mobile(PerformanceTier::Low)), ImpostorClass::Mobile);
    assert_eq!(impostor_class(QualityPreset::Low, mobile(PerformanceTier::High)), ImpostorClass::Mobile, "a phone's low preset");
    // Depth parallax only above the phone sizes.
    assert!(ImpostorClass::Mid.spec().depth_parallax && !ImpostorClass::Low.spec().depth_parallax && !ImpostorClass::Mobile.spec().depth_parallax);
}

// --- LOD-13: the GPU bake -------------------------------------------------------------------

use genex_render::Gpu;
use genex_render::impostor::bake::{
    ATLAS_FORMAT, BakeMaterials, BakeMesh, BakePart, IMPOSTOR_BAKE, IMPOSTOR_COVERAGE_CUTOFF, IMPOSTOR_MIP, IMPOSTOR_PACK, ImpostorAtlases, ImpostorBaker, MipRule,
};
use genex_render::impostor::{ImpostorBounds, ImpostorSpec};
use genex_render::layout::{GpuMaterial, NO_TEXTURE};
use genex_render::mesh::MeshData;
use wgpu::util::DeviceExt;

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

/// The cube's base colour (linear): exactly representable steps of 1/255 apart from rounding.
const CUBE_COLOR: [f32; 4] = [0.8, 0.3, 0.2, 1.0];

/// The material table, extension rows and 1 x 1 texture arrays a test bake samples.
struct TestMaterials {
    materials: wgpu::Buffer,
    material_ext: wgpu::Buffer,
    arrays: Vec<wgpu::TextureView>,
    sampler: wgpu::Sampler,
}

impl TestMaterials {
    fn new(device: &wgpu::Device, rows: &[GpuMaterial]) -> TestMaterials {
        let storage = |label, contents: &[u8]| device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some(label), contents, usage: wgpu::BufferUsages::STORAGE });
        let ext = vec![0f32; 16 * rows.len()];
        let arrays = (0..8)
            .map(|_| {
                device
                    .create_texture(&wgpu::TextureDescriptor {
                        label: Some("test-array"),
                        size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
                        mip_level_count: 1,
                        sample_count: 1,
                        dimension: wgpu::TextureDimension::D2,
                        format: wgpu::TextureFormat::Rgba8Unorm,
                        usage: wgpu::TextureUsages::TEXTURE_BINDING,
                        view_formats: &[],
                    })
                    .create_view(&wgpu::TextureViewDescriptor { dimension: Some(wgpu::TextureViewDimension::D2Array), ..Default::default() })
            })
            .collect();
        TestMaterials {
            materials: storage("test-materials", bytemuck::cast_slice(rows)),
            material_ext: storage("test-material-ext", bytemuck::cast_slice(&ext)),
            arrays,
            sampler: device.create_sampler(&wgpu::SamplerDescriptor::default()),
        }
    }

    fn bind(&self) -> BakeMaterials<'_> {
        let a = &self.arrays;
        BakeMaterials {
            materials: &self.materials,
            material_ext: &self.material_ext,
            arrays: [&a[0], &a[1], &a[2], &a[3], &a[4], &a[5], &a[6], &a[7]],
            sampler: &self.sampler,
        }
    }
}

fn plain_material(color: [f32; 4]) -> GpuMaterial {
    GpuMaterial { base_color: color, params: [0.0, 0.5, 0.0, 1.0], textures: [NO_TEXTURE; 4] }
}

/// A mesh in library layout on the GPU.
struct TestMesh {
    vertices: wgpu::Buffer,
    indices: wgpu::Buffer,
    index_count: u32,
    bounds: ImpostorBounds,
}

impl TestMesh {
    fn new(device: &wgpu::Device, mesh: &MeshData) -> TestMesh {
        let vertices = device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("test-vertices"), contents: bytemuck::cast_slice(&mesh.vertices), usage: wgpu::BufferUsages::VERTEX });
        let indices = device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("test-indices"), contents: bytemuck::cast_slice(&mesh.indices), usage: wgpu::BufferUsages::INDEX });
        let bounds = ImpostorBounds::of_points(mesh.vertices.iter().map(|vertex| vertex.position)).expect("vertices");
        TestMesh { vertices, indices, index_count: mesh.indices.len() as u32, bounds }
    }
}

/// Bake `mesh` with material row 0 at `spec` into layer 0 of fresh atlases.
fn bake(gpu: &Gpu, mesh: &TestMesh, materials: &TestMaterials, spec: ImpostorSpec, layout: ImpostorLayout) -> ImpostorAtlases {
    let baker = ImpostorBaker::new(&gpu.device).expect("bake pipelines");
    let atlases = ImpostorAtlases::new(&gpu.device, spec, 1);
    let parts = [BakePart { first_index: 0, index_count: mesh.index_count, base_vertex: 0, material: 0 }];
    let source = BakeMesh { vertices: &mesh.vertices, indices: &mesh.indices, parts: &parts };
    baker.bake(&gpu.device, &gpu.queue, &source, &materials.bind(), &mesh.bounds, layout, &atlases, 0);
    atlases
}

/// One layer and level of an RGBA8 texture, row by row.
fn read_level(gpu: &Gpu, texture: &wgpu::Texture, layer: u32, level: u32) -> (u32, Vec<[u8; 4]>) {
    let size = texture.size().mip_level_size(level, texture.dimension());
    let (w, h) = (size.width, size.height);
    let row = (w * 4).div_ceil(256) * 256;
    let buffer = gpu.device.create_buffer(&wgpu::BufferDescriptor { label: None, size: u64::from(row * h), usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false });
    let mut encoder = gpu.device.create_command_encoder(&Default::default());
    encoder.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo { texture, mip_level: level, origin: wgpu::Origin3d { x: 0, y: 0, z: layer }, aspect: wgpu::TextureAspect::All },
        wgpu::TexelCopyBufferInfo { buffer: &buffer, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(row), rows_per_image: None } },
        wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
    );
    gpu.queue.submit(Some(encoder.finish()));
    buffer.slice(..).map_async(wgpu::MapMode::Read, |_| {});
    gpu.device.poll(wgpu::PollType::wait_indefinitely()).expect("poll");
    let bytes = buffer.slice(..).get_mapped_range().expect("mapped");
    let texels = (0..h).flat_map(|y| (0..w).map(move |x| (x, y))).map(|(x, y)| bytes[(y * row + x * 4) as usize..][..4].try_into().expect("texel")).collect();
    (w, texels)
}

/// An unlit orthographic capture of `mesh` from frame direction `dir` (the bake's camera: on the
/// bake sphere, looking at its centre), `side` texels square, alpha 1 where drawn: `color`
/// (entry `fs_color`) or the object normal as `n * 0.5 + 0.5` (entry `fs_normal`).
const CAPTURE_WGSL: &str = r#"
struct Capture { view_proj: mat4x4<f32>, color: vec4<f32> }
struct Varyings { @builtin(position) clip: vec4<f32>, @location(0) normal: vec3<f32> }
@group(0) @binding(0) var<uniform> capture: Capture;
@vertex fn vs(@location(0) position: vec3<f32>, @location(1) normal: vec3<f32>) -> Varyings {
    return Varyings(capture.view_proj * vec4<f32>(position, 1.0), normal);
}
@fragment fn fs_color() -> @location(0) vec4<f32> {
    return capture.color;
}
@fragment fn fs_normal(in: Varyings) -> @location(0) vec4<f32> {
    return vec4<f32>(normalize(in.normal) * 0.5 + 0.5, 1.0);
}
"#;

fn capture(gpu: &Gpu, mesh: &TestMesh, color: [f32; 4], dir: [f32; 3], side: u32, entry: &str) -> Vec<[u8; 4]> {
    let device = &gpu.device;
    let r = mesh.bounds.radius;
    let center = glam::Vec3::from(mesh.bounds.center);
    let proj = glam::camera::rh::proj::directx::orthographic(-r, r, -r, r, 0.0, 2.0 * r);
    let view = glam::camera::rh::view::look_at_mat4(center + glam::Vec3::from(dir) * r, center, glam::Vec3::from(frame_axes(dir).up_reference));
    let mut uniform = (proj * view).to_cols_array().to_vec();
    uniform.extend(color);
    let uniform = device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: None, contents: bytemuck::cast_slice(&uniform), usage: wgpu::BufferUsages::UNIFORM });
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: None, source: wgpu::ShaderSource::Wgsl(CAPTURE_WGSL.into()) });
    let attributes = wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x3];
    let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: None,
        layout: None,
        vertex: wgpu::VertexState { module: &module, entry_point: Some("vs"), compilation_options: Default::default(), buffers: &[Some(wgpu::VertexBufferLayout { array_stride: 48, step_mode: wgpu::VertexStepMode::Vertex, attributes: &attributes })] },
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: Some(wgpu::DepthStencilState {
            format: wgpu::TextureFormat::Depth32Float,
            depth_write_enabled: Some(true),
            depth_compare: Some(wgpu::CompareFunction::Less),
            stencil: Default::default(),
            bias: Default::default(),
        }),
        multisample: Default::default(),
        fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some(entry), compilation_options: Default::default(), targets: &[Some(wgpu::TextureFormat::Rgba8Unorm.into())] }),
        multiview_mask: None,
        cache: None,
    });
    let target = |format, usage| {
        device.create_texture(&wgpu::TextureDescriptor {
            label: None,
            size: wgpu::Extent3d { width: side, height: side, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage,
            view_formats: &[],
        })
    };
    let color_target = target(wgpu::TextureFormat::Rgba8Unorm, wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC);
    let depth = target(wgpu::TextureFormat::Depth32Float, wgpu::TextureUsages::RENDER_ATTACHMENT);
    let group = device.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &pipeline.get_bind_group_layout(0), entries: &[wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() }] });
    let mut encoder = device.create_command_encoder(&Default::default());
    {
        let color_view = color_target.create_view(&Default::default());
        let depth_view = depth.create_view(&Default::default());
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: None,
            color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: &color_view, depth_slice: None, resolve_target: None, ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store } })],
            depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment { view: &depth_view, depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(1.0), store: wgpu::StoreOp::Store }), stencil_ops: None }),
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.set_vertex_buffer(0, mesh.vertices.slice(..));
        pass.set_index_buffer(mesh.indices.slice(..), wgpu::IndexFormat::Uint32);
        pass.draw_indexed(0..mesh.index_count, 0, 0..1);
    }
    gpu.queue.submit(Some(encoder.finish()));
    read_level(gpu, &color_target, 0, 0).1
}

/// Atlas B's normal: the whole-sphere octahedral encoding (the mapping's own `decode`).
fn oct_decode(e: [u8; 2]) -> [f32; 3] {
    decode([f32::from(e[0]) / 255.0 * 2.0 - 1.0, f32::from(e[1]) / 255.0 * 2.0 - 1.0], ImpostorLayout::Sphere)
}

#[test]
fn a_baked_cube_frame_matches_an_orthographic_capture_within_one_level() {
    let Some(gpu) = gpu() else { return };
    let spec = ImpostorClass::Mid.spec();
    let mesh = TestMesh::new(&gpu.device, &MeshData::cube());
    let materials = TestMaterials::new(&gpu.device, &[plain_material(CUBE_COLOR)]);
    let atlases = bake(&gpu, &mesh, &materials, spec, ImpostorLayout::Hemi);
    let (side, atlas_a) = read_level(&gpu, &atlases.textures[0], 0, 0);
    let (_, atlas_b) = read_level(&gpu, &atlases.textures[1], 0, 0);
    let ss = genex_render::impostor::bake::BAKE_SUPERSAMPLE;
    let px = spec.frame_px;
    let mut worst = (0u8, 0u8);
    let mut covered_texels = 0;
    let mut worst_degrees = 0.0f32;
    for (column, row) in [(0, 0), (3, 4), (7, 7), (2, 6), (5, 1)] {
        let dir = frame_direction(spec.frames, ImpostorLayout::Hemi, column, row);
        let reference = capture(&gpu, &mesh, CUBE_COLOR, dir, px * ss, "fs_color");
        let normals = capture(&gpu, &mesh, CUBE_COLOR, dir, px * ss, "fs_normal");
        for y in 0..px {
            for x in 0..px {
                let at = |k: u32| ((y * ss + k / ss) * px * ss + x * ss + k % ss) as usize;
                let drawn: Vec<usize> = (0..ss * ss).map(at).filter(|&i| reference[i][3] > 0).collect();
                let coverage = (drawn.len() as f32 / (ss * ss) as f32 * 255.0).round() as u8;
                let texel = ((row * px + y) * side + column * px + x) as usize;
                let baked = atlas_a[texel];
                worst.0 = worst.0.max(baked[3].abs_diff(coverage));
                if drawn.is_empty() {
                    continue;
                }
                covered_texels += 1;
                for channel in 0..3 {
                    let mean = drawn.iter().map(|&i| f32::from(reference[i][channel])).sum::<f32>() / drawn.len() as f32;
                    worst.1 = worst.1.max(baked[channel].abs_diff(mean.round() as u8));
                }
                // The capture's normals averaged over the drawn render texels, against atlas B's.
                let sum = drawn.iter().fold([0.0f32; 3], |sum, &i| [0, 1, 2].map(|c| sum[c] + f32::from(normals[i][c]) / 255.0 * 2.0 - 1.0));
                let wanted = [0, 1, 2].map(|c| sum[c] / length(sum));
                let b = atlas_b[texel];
                let got = oct_decode([b[0], b[1]]);
                worst_degrees = worst_degrees.max(libm::acosf(dot(got, wanted).min(1.0)).to_degrees());
            }
        }
    }
    assert!(covered_texels > 1000, "the cube covers the frames ({covered_texels} texels)");
    assert!(worst.0 <= 1, "coverage within one level of the capture's (worst {})", worst.0);
    assert!(worst.1 <= 1, "base colour within one level of the capture's (worst {})", worst.1);
    // Two 8-bit octahedral components resolve about a degree.
    assert!(worst_degrees <= 2.0, "the object normal within 2 degrees of the capture's (worst {worst_degrees:.2})");
    eprintln!("cube bake vs capture: worst coverage {} levels, worst colour {} levels, worst normal {worst_degrees:.2} deg over {covered_texels} texels", worst.0, worst.1);
}

/// A frame's share of texels at or above the cutoff, per frame, at one level.
fn frame_coverage(texels: &[[u8; 4]], side: u32, frames: u32) -> Vec<f32> {
    let px = side / frames;
    let cutoff = (IMPOSTOR_COVERAGE_CUTOFF * 255.0).round() as u8;
    (0..frames * frames)
        .map(|k| {
            let (fx, fy) = (k % frames, k / frames);
            let kept = (0..px * px).filter(|i| texels[((fy * px + i / px) * side + fx * px + i % px) as usize][3] >= cutoff).count();
            kept as f32 / (px * px) as f32
        })
        .collect()
}

/// A crown of sparse leaves per frame: alpha u² (u a stable hash) inside a disc, empty outside.
fn sparse_crown(spec: &ImpostorSpec) -> Vec<[u8; 4]> {
    let side = spec.atlas_side();
    let px = spec.frame_px;
    (0..side * side)
        .map(|i| {
            let (x, y): (u32, u32) = (i % side, i / side);
            let (lx, ly) = ((x % px) as f32 + 0.5 - px as f32 * 0.5, (y % px) as f32 + 0.5 - px as f32 * 0.5);
            let inside = lx * lx + ly * ly < (px as f32 * 0.45) * (px as f32 * 0.45);
            let hash = (x.wrapping_mul(73_856_093) ^ y.wrapping_mul(19_349_663)).wrapping_mul(2_654_435_761) >> 8;
            let u = (hash & 0xffff) as f32 / 65535.0;
            let alpha = if inside { (u * u * 255.0).round() as u8 } else { 0 };
            [60, 140, 50, alpha]
        })
        .collect()
}

fn upload_level0(gpu: &Gpu, atlases: &ImpostorAtlases, texels: &[[u8; 4]]) {
    let side = atlases.spec.atlas_side();
    for texture in &atlases.textures {
        gpu.queue.write_texture(
            wgpu::TexelCopyTextureInfo { texture, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            bytemuck::cast_slice(texels),
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(side * 4), rows_per_image: None },
            wgpu::Extent3d { width: side, height: side, depth_or_array_layers: 1 },
        );
    }
}

/// The worst relative coverage error over the frames, at each level whose frames are at least 8
/// texels wide.
fn mip_coverage_errors(gpu: &Gpu, rule: MipRule) -> Vec<f32> {
    let spec = ImpostorClass::Mid.spec();
    let atlases = ImpostorAtlases::new(&gpu.device, spec, 1);
    upload_level0(gpu, &atlases, &sparse_crown(&spec));
    let baker = ImpostorBaker::new(&gpu.device).expect("bake pipelines");
    baker.build_mips(&gpu.device, &gpu.queue, &atlases, 0, rule);
    let (side, base) = read_level(gpu, &atlases.textures[0], 0, 0);
    let base = frame_coverage(&base, side, spec.frames);
    (1..spec.mip_levels())
        .filter(|level| spec.frame_px >> level >= 8)
        .map(|level| {
            let (side, texels) = read_level(gpu, &atlases.textures[0], 0, level);
            let shares = frame_coverage(&texels, side, spec.frames);
            shares.iter().zip(&base).map(|(share, wanted)| (share - wanted).abs() / wanted.max(1e-6)).fold(0.0f32, f32::max)
        })
        .collect()
}

#[test]
fn coverage_above_cutoff_holds_across_mips_within_5_percent() {
    let Some(gpu) = gpu() else { return };
    let kept = mip_coverage_errors(&gpu, MipRule::CoveragePreserving);
    let plain = mip_coverage_errors(&gpu, MipRule::PlainAverage);
    eprintln!("relative coverage error per level (32, 16, 8 px frames): coverage-preserving {kept:?}, plain average {plain:?}");
    assert_eq!(kept.len(), 3);
    assert!(kept.iter().all(|error| *error <= 0.05), "every level keeps its frames' coverage within 5%: {kept:?}");
    assert!(plain.iter().any(|error| *error > 0.05), "the plain average (kansei's) thins the crown: {plain:?}");
}

/// The storage textures `module` declares: (name, format, access).
fn storage_textures(module: &naga::Module) -> Vec<(String, naga::StorageFormat, naga::StorageAccess)> {
    module
        .global_variables
        .iter()
        .filter_map(|(_, global)| match module.types[global.ty].inner {
            naga::TypeInner::Image { class: naga::ImageClass::Storage { format, access }, .. } => Some((global.name.clone().unwrap_or_default(), format, access)),
            _ => None,
        })
        .collect()
}

#[test]
fn bake_writes_only_rgba8unorm_storage_on_webgpu_core() {
    let mut written = 0;
    for (name, source) in [("impostor-bake", IMPOSTOR_BAKE), ("impostor-pack", IMPOSTOR_PACK), ("impostor-mip", IMPOSTOR_MIP)] {
        let module = naga::front::wgsl::parse_str(source).unwrap_or_else(|error| panic!("{name}: {}", error.emit_to_string(source)));
        naga::valid::Validator::new(naga::valid::ValidationFlags::all(), naga::valid::Capabilities::empty())
            .validate(&module)
            .unwrap_or_else(|error| panic!("{name} needs more than WebGPU core: {error:?}"));
        assert!(module.global_variables.iter().all(|(_, global)| global.space != naga::AddressSpace::WorkGroup), "{name}: no workgroup memory");
        for (global, format, access) in storage_textures(&module) {
            assert_eq!(format, naga::StorageFormat::Rgba8Unorm, "{name}: {global} is rgba8unorm");
            assert_eq!(access, naga::StorageAccess::STORE, "{name}: {global} is write-only");
            written += 1;
        }
    }
    assert_eq!(written, 6, "the pack's and the mips' three atlases each");
    assert_eq!(ATLAS_FORMAT, wgpu::TextureFormat::Rgba8Unorm);
}

/// The size naga lays struct `name` out at in `source`.
fn wgsl_struct_size(source: &str, name: &str) -> usize {
    let module = naga::front::wgsl::parse_str(source).expect("parses");
    let mut layouter = naga::proc::Layouter::default();
    layouter.update(module.to_ctx()).expect("layout");
    module.types.iter().find(|(_, ty)| ty.name.as_deref() == Some(name)).map(|(handle, _)| layouter[handle].size as usize).unwrap_or_else(|| panic!("no struct {name}"))
}

#[test]
fn the_bake_uniforms_equal_the_wgsl_sizes_naga_computes() {
    use genex_render::impostor::GpuImpostor;
    use genex_render::impostor::bake::{MipUniform, PackUniform};
    assert_eq!(wgsl_struct_size(IMPOSTOR_PACK, "GxImpostorPack"), size_of::<PackUniform>());
    assert_eq!(wgsl_struct_size(IMPOSTOR_MIP, "GxImpostorMip"), size_of::<MipUniform>());
    assert_eq!(wgsl_struct_size(IMPOSTOR_BAKE, "GxImpostorBake"), 64, "one column-major matrix");
    assert_eq!(size_of::<GpuImpostor>(), 48, "the draw's row (LOD-14 declares GxImpostor at this size)");
}

#[test]
fn ledger_equals_atlas_bytes() {
    let Some(gpu) = gpu() else { return };
    for class in ImpostorClass::ALL {
        let spec = class.spec();
        let atlases = ImpostorAtlases::new(&gpu.device, spec, spec.species_cap);
        assert_eq!(atlases.bytes(), spec.cap_bytes(), "{class:?}: the arrays at the cap hold the ledger's bytes");
        let mut ledger = BudgetLedger::new();
        let names: Vec<String> = (0..spec.species_cap).map(|k| k.to_string()).collect();
        admit_species(class, &names, &mut ledger);
        assert_eq!(ledger.total_of(BudgetKind::Impostors), atlases.bytes());
    }
}

/// Every level of every atlas of layer 0.
fn read_all(gpu: &Gpu, atlases: &ImpostorAtlases) -> Vec<Vec<[u8; 4]>> {
    atlases.textures.iter().flat_map(|texture| (0..texture.mip_level_count()).map(move |level| read_level(gpu, texture, 0, level).1)).collect()
}

#[test]
fn after_a_device_loss_a_species_bakes_again_to_the_same_atlases() {
    let Some(first) = gpu() else { return };
    let mesh_data = MeshData::sphere();
    let baked = |gpu: &Gpu| {
        let mesh = TestMesh::new(&gpu.device, &mesh_data);
        let materials = TestMaterials::new(&gpu.device, &[plain_material([0.25, 0.6, 0.3, 1.0])]);
        read_all(gpu, &bake(gpu, &mesh, &materials, ImpostorClass::Mobile.spec(), ImpostorLayout::Sphere))
    };
    let before = baked(&first);
    drop(first);
    // The replacement device (a lost device is never reused): the same parts bake the same bits.
    let Some(second) = gpu() else { return };
    let after = baked(&second);
    assert_eq!(before.len(), after.len());
    assert!(before == after, "every level of the three atlases is byte-identical after the re-bake");
}

#[test]
#[allow(clippy::disallowed_types, reason = "the timing record reads the wall clock; no atlas depends on it")]
fn bake_ms_per_species_is_recorded() {
    let Some(gpu) = gpu() else { return };
    let mesh = TestMesh::new(&gpu.device, &MeshData::sphere());
    let materials = TestMaterials::new(&gpu.device, &[plain_material(CUBE_COLOR)]);
    let baker = ImpostorBaker::new(&gpu.device).expect("bake pipelines");
    let parts = [BakePart { first_index: 0, index_count: mesh.index_count, base_vertex: 0, material: 0 }];
    let source = BakeMesh { vertices: &mesh.vertices, indices: &mesh.indices, parts: &parts };
    for class in ImpostorClass::ALL {
        let spec = class.spec();
        let atlases = ImpostorAtlases::new(&gpu.device, spec, 1);
        // One warm bake (pipelines, first allocations), then the median of five.
        baker.bake(&gpu.device, &gpu.queue, &source, &materials.bind(), &mesh.bounds, spec.layout, &atlases, 0);
        gpu.device.poll(wgpu::PollType::wait_indefinitely()).expect("poll");
        let mut ms: Vec<f64> = (0..5)
            .map(|_| {
                let start = std::time::Instant::now();
                baker.bake(&gpu.device, &gpu.queue, &source, &materials.bind(), &mesh.bounds, spec.layout, &atlases, 0);
                gpu.device.poll(wgpu::PollType::wait_indefinitely()).expect("poll");
                start.elapsed().as_secs_f64() * 1000.0
            })
            .collect();
        ms.sort_by(f64::total_cmp);
        eprintln!("impostor bake {class:?} ({}x{} at {} px, sphere 1024 triangles): median {:.2} ms per species on {}", spec.frames, spec.frames, spec.frame_px, ms[2], gpu.receipt().backend);
    }
}

/// Writes `texels` (`side` square, RGBA8) as `<name>.rgba` under `GENEX_IMPOSTOR_DUMP` when set
/// (evidence: a script turns them into PNGs to look at).
fn dump(name: &str, side: u32, texels: &[[u8; 4]]) {
    let Ok(folder) = std::env::var("GENEX_IMPOSTOR_DUMP") else { return };
    let path = std::path::Path::new(&folder).join(format!("{name}-{side}.rgba"));
    std::fs::write(&path, bytemuck::cast_slice::<[u8; 4], u8>(texels)).expect("dump");
    eprintln!("dumped {}", path.display());
}

#[test]
fn a_two_part_object_bakes_each_part_with_its_own_material() {
    let Some(gpu) = gpu() else { return };
    let cube = MeshData::cube();
    let sphere = MeshData::sphere();
    let mut vertices = cube.vertices.clone();
    vertices.extend(sphere.vertices.iter().map(|vertex| {
        let mut moved = *vertex;
        moved.position = [vertex.position[0] * 0.5 + 0.9, vertex.position[1] * 0.5 + 0.4, vertex.position[2] * 0.5];
        moved
    }));
    let mut indices = cube.indices.clone();
    indices.extend(&sphere.indices);
    let parts = [
        BakePart { first_index: 0, index_count: cube.indices.len() as u32, base_vertex: 0, material: 0 },
        BakePart { first_index: cube.indices.len() as u32, index_count: sphere.indices.len() as u32, base_vertex: cube.vertices.len() as i32, material: 1 },
    ];
    let mesh = TestMesh::new(&gpu.device, &MeshData { vertices, indices });
    let materials = TestMaterials::new(&gpu.device, &[plain_material(CUBE_COLOR), plain_material([0.1, 0.7, 0.2, 1.0])]);
    let spec = ImpostorClass::Mid.spec();
    let baker = ImpostorBaker::new(&gpu.device).expect("bake pipelines");
    let atlases = ImpostorAtlases::new(&gpu.device, spec, 1);
    let source = BakeMesh { vertices: &mesh.vertices, indices: &mesh.indices, parts: &parts };
    baker.bake(&gpu.device, &gpu.queue, &source, &materials.bind(), &mesh.bounds, ImpostorLayout::Hemi, &atlases, 0);
    let (side, a) = read_level(&gpu, &atlases.textures[0], 0, 0);
    let red = a.iter().filter(|texel| texel[3] == 255 && texel[0] > 200 && texel[1] < 90).count();
    let green = a.iter().filter(|texel| texel[3] == 255 && texel[1] > 170 && texel[0] < 40).count();
    assert!(red > 5000 && green > 2000, "both parts with their own colours (red {red}, green {green} texels)");
    for (atlas, name) in ["a", "b", "c"].iter().enumerate() {
        for level in [0, 2] {
            let (level_side, texels) = read_level(&gpu, &atlases.textures[atlas], 0, level);
            dump(&format!("two-part-{name}-mip{level}"), level_side, &texels);
        }
    }
    assert_eq!(side, spec.atlas_side());
}

#[test]
fn the_renderer_bakes_species_from_its_library_and_refuses_them_past_the_cap() {
    use genex_render::scene::{CameraDesc, Material, MeshId, Scene, translation};
    use genex_render::{CullPath, Renderer};
    let Some(gpu) = gpu() else { return };
    let mut renderer = Renderer::new(&gpu, 64, 64).expect("renderer");
    // One frame uploads the material table: the cube's colour is row 0.
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 2.0, 4.0], [0.0, 0.0, 0.0]), [18, 20, 28, 255]);
    scene.draw(MeshId::CUBE, translation(0.0, 0.0, 0.0), Material::color([204, 77, 51, 255]));
    renderer.render(&gpu, &scene, CullPath::Cpu).expect("frame");
    let class = ImpostorClass::Mobile;
    let cap = class.spec().species_cap;
    for layer in 0..cap {
        let row = renderer.bake_impostor(&gpu, &[(MeshId::CUBE, 0)], ImpostorLayout::Hemi, class).expect("bake").expect("under the cap");
        assert_eq!(row.layer, layer);
    }
    assert_eq!(renderer.bake_impostor(&gpu, &[(MeshId::CUBE, 0)], ImpostorLayout::Hemi, class).expect("bake"), None, "past the cap: refused (budget)");
    let stage = renderer.impostors();
    assert_eq!(stage.species().len() as u32, cap);
    assert_eq!(stage.bytes(), class.spec().cap_bytes(), "the stage holds the ledger's bytes");
    let atlases = stage.atlases().expect("atlases");
    let (_, a) = read_level(&gpu, &atlases.textures[0], cap - 1, 0);
    let covered: Vec<&[u8; 4]> = a.iter().filter(|texel| texel[3] == 255).collect();
    assert!(covered.len() > 2000, "the cube covers its frames ({} texels)", covered.len());
    assert!(covered.iter().all(|texel| texel[0] > texel[1] && texel[1] > texel[2]), "with the material table's colour (linear 204, 77, 51)");
    // Reserved for two species, the arrays hold exactly the two the ledger admits.
    renderer.reserve_impostors(&gpu, class, 2);
    assert!(renderer.impostors().species().is_empty(), "a reserve drops the species baked before");
    for _ in 0..2 {
        renderer.bake_impostor(&gpu, &[(MeshId::CUBE, 0)], ImpostorLayout::Hemi, class).expect("bake").expect("reserved");
    }
    assert_eq!(renderer.bake_impostor(&gpu, &[(MeshId::CUBE, 0)], ImpostorLayout::Hemi, class).expect("bake"), None, "past the reserve");
    assert_eq!(renderer.impostors().bytes(), 2 * class.spec().species_bytes());
}
