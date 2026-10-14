//! Custom GPU passes (extension ladder level 3, M2.19): raw wgpu compute and render passes a game
//! registers into the runtime frame at four fixed stages, under the GPU caps, naga admission and
//! wgpu error scopes, rebuilt after device loss and counted as `custom` logical draws.
//!
//! The CPU rows run everywhere. The GPU rows are `#[ignore]`d and every name contains `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked -- --ignored metal
//!
//! Golden rows compare against `tests/fixtures/render-goldens/custom-pass/<name>.bgra` (raw BGRA,
//! top row first); `GENEX_RENDER_GOLDEN_UPDATE=1` rewrites them instead (review the diff).

use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::rc::Rc;

use genex_render::capture::Capture;
use genex_render::custom_pass::{
    CUSTOM_PASS_API_VERSION, CUSTOM_TAG, CustomPass, CustomPasses, CustomStage, GPU_PASS_BYTES_MAX, GPU_PASSES_MAX, NoCustom, PassFrame,
    PRODUCED_INPUTS, PassSetup, PrepassViews, PassStage, PipelineFacts, RebuildReason, ScopeMode, TABLES_WGSL, check_buffer_descriptor, check_pass_name,
    TABLES_V2_BINDINGS, check_texture_descriptor, render_scene, validate_pass_wgsl,
};
use genex_render::budget::{BudgetKind, BudgetLedger};
use genex_render::device_loss::Resilient;
use genex_render::extension::ExtensionContext;
use genex_render::immediate::{FrameRenderer, HUD_TAG, ImmediateFrame, WORLD_TAG};
use genex_render::layout::{GpuInstance, GpuMaterial};
use genex_render::overlay::OverlayPainter;
use genex_render::scene::{CameraDesc, MeshId, Scene, scaled, translation};
use genex_render::{BUFFER_MAX_BYTES, CullPath, Gpu, RenderCode, RenderError, RenderOptions, Renderer, WGSL_MAX_BYTES};

const WIDTH: u32 = 128;
const HEIGHT: u32 = 72;
/// A golden pixel may differ by this much per channel (another Apple GPU family rounds differently).
const GOLDEN_CHANNEL_TOLERANCE: u8 = 2;
/// Pixels allowed beyond the channel tolerance (rasterization on edges), of 9216.
const GOLDEN_OUTLIER_PIXELS: usize = 46;
/// The ticks the post-pass row draws through: ten seconds of frames, one drawn every hundred.
const CHECKSUM_TICKS: u64 = 600;

// ---------------------------------------------------------------------------------------------
// Fixtures

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

fn goldens_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../tests/fixtures/render-goldens/custom-pass")
}

/// Compare `capture` with the golden `name`, or rewrite it under `GENEX_RENDER_GOLDEN_UPDATE=1`.
fn check_golden(name: &str, capture: &Capture) {
    assert_eq!((capture.width(), capture.height()), (WIDTH, HEIGHT));
    if let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") {
        let dir = PathBuf::from(dir);
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join(format!("{name}.bgra")), capture.bgra()).expect("evidence");
    }
    let path = goldens_dir().join(format!("{name}.bgra"));
    if std::env::var("GENEX_RENDER_GOLDEN_UPDATE").is_ok_and(|v| v == "1") {
        std::fs::create_dir_all(goldens_dir()).expect("goldens folder");
        std::fs::write(&path, capture.bgra()).expect("golden written");
        return;
    }
    let golden = std::fs::read(&path)
        .unwrap_or_else(|error| panic!("golden {path:?} missing ({error}); render it with GENEX_RENDER_GOLDEN_UPDATE=1"));
    assert_eq!(golden.len(), capture.bgra().len(), "{name}: golden size");
    let mut outliers = 0;
    let mut worst = 0u8;
    for (a, b) in golden.chunks(4).zip(capture.bgra().chunks(4)) {
        let diff = a.iter().zip(b).map(|(x, y)| x.abs_diff(*y)).max().unwrap_or(0);
        worst = worst.max(diff);
        if diff > GOLDEN_CHANNEL_TOLERANCE {
            outliers += 1;
        }
    }
    assert!(outliers <= GOLDEN_OUTLIER_PIXELS, "{name}: {outliers} pixels differ from the golden by more than {GOLDEN_CHANNEL_TOLERANCE} (worst {worst})");
}

fn camera() -> CameraDesc {
    CameraDesc::look_at([0.0, 3.0, 8.0], [0.0, 0.5, 0.0])
}

fn base_frame() -> ImmediateFrame {
    let mut frame = ImmediateFrame::new(camera(), [20, 24, 32, 255]);
    frame.mesh(MeshId::CUBE, scaled([0.0, -0.05, 0.0], [8.0, 0.1, 8.0]), genex_render::scene::Material::color([110, 110, 120, 255]));
    frame.cube(translation(-1.5, 0.5, 0.0), [200, 60, 50, 255]);
    frame.sphere([1.5, 0.6, 0.0], 0.6, [60, 160, 220, 255]);
    // A wall in front of the ring's left half: in-world passes are depth-tested against it.
    frame.cube(scaled([-0.6, 0.5, 2.2], [0.8, 1.0, 0.2]), [40, 200, 90, 255]);
    frame
}

fn base_scene() -> Scene {
    let mut scene = Scene::new(camera(), [20, 24, 32, 255]);
    scene.draw(MeshId::CUBE, scaled([0.0, -0.05, 0.0], [8.0, 0.1, 8.0]), genex_render::scene::Material::color([110, 110, 120, 255]));
    scene.draw(MeshId::CUBE, translation(-1.5, 0.5, 0.0), genex_render::scene::Material::color([200, 60, 50, 255]));
    scene
}

fn refused(error: &RenderError, code: RenderCode, pass: &str) {
    assert_eq!(error.code(), code, "{error}");
    assert!(error.to_string().contains(&format!("`{pass}`")), "the refusal names the pass: {error}");
}

// ---------------------------------------------------------------------------------------------
// The passes the GPU rows register

/// The scanline post pass: copies the frame, then darkens every fourth row (moving with the tick)
/// and rotates the colour channels half way.
const SCANLINES: &str = "
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var<uniform> params: vec4<f32>;

struct VsOut { @builtin(position) position: vec4<f32> }

@vertex
fn vs_main(@builtin(vertex_index) i: u32) -> VsOut {
    let uv = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
    var out: VsOut;
    out.position = vec4<f32>(uv * 2.0 - 1.0, 0.0, 1.0);
    return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    let p = vec2<i32>(in.position.xy);
    let c = textureLoad(source, p, 0);
    let band = select(1.0, 0.5, (u32(p.y) + u32(params.x)) % 4u == 0u);
    return vec4<f32>(mix(c.rgb, c.gbr, 0.5) * band, 1.0);
}
";

#[derive(Default)]
struct Scanlines {
    resources: Option<(wgpu::Texture, wgpu::Buffer, wgpu::BindGroup, wgpu::RenderPipeline)>,
    rebuilds: u32,
}

impl CustomPass for Scanlines {
    fn rebuild(&mut self, setup: &mut PassSetup<'_>) -> Result<(), RenderError> {
        self.rebuilds += 1;
        let (width, height) = setup.world_size();
        let copy = setup.create_texture(&wgpu::TextureDescriptor {
            label: Some("scanlines source"),
            size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: setup.world_format(),
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        })?;
        let params = setup.create_buffer(&wgpu::BufferDescriptor {
            label: Some("scanlines params"),
            size: 16,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        })?;
        let module = setup.create_shader("scanlines", SCANLINES)?;
        let layout = setup.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("scanlines"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: false },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                uniform_entry(1, wgpu::ShaderStages::FRAGMENT),
            ],
        });
        let view = copy.create_view(&wgpu::TextureViewDescriptor::default());
        let group = setup.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("scanlines"),
            layout: &layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&view) },
                wgpu::BindGroupEntry { binding: 1, resource: params.as_entire_binding() },
            ],
        });
        let pipeline_layout =
            setup.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("scanlines"), bind_group_layouts: &[Some(&layout)], immediate_size: 0 });
        let targets = [Some(wgpu::ColorTargetState { format: setup.world_format(), blend: None, write_mask: wgpu::ColorWrites::ALL })];
        let pipeline = setup.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("scanlines"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState { module: &module, entry_point: Some("vs_main"), compilation_options: Default::default(), buffers: &[] },
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some("fs_main"), compilation_options: Default::default(), targets: &targets }),
            multiview_mask: None,
            cache: None,
        });
        self.resources = Some((copy, params, group, pipeline));
        Ok(())
    }

    fn encode(&mut self, frame: &mut PassFrame<'_>) {
        let Some((copy, params, group, pipeline)) = &self.resources else { return };
        let tick = frame.tick() as f32;
        frame.write_buffer(params, 0, bytemuck::cast_slice(&[tick, 0.0, 0.0, 0.0])).expect("within the upload budget");
        let (Some(world), Some(view)) = (frame.world_texture().cloned(), frame.world_view().cloned()) else { return };
        let Some(encoder) = frame.encoder() else { return };
        encoder.copy_texture_to_texture(world.as_image_copy(), copy.as_image_copy(), world.size());
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("scanlines"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store },
            })],
            ..Default::default()
        });
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, group, &[]);
        pass.draw(0..3, 0..1);
    }
}

/// Segments of the ring the compute pass builds; three vertices each.
const RING_SEGMENTS: u32 = 24;

/// The before-cull compute pass: a ring of triangles in front of the scene, turning with the tick
/// and coloured by the first material-table row (proving read-only table access from compute).
const RING_COMPUTE: &str = "
struct RingVertex { position: vec4<f32>, color: vec4<f32> }

@group(0) @binding(0) var<uniform> gx_frame: GxFrame;
@group(0) @binding(1) var<storage, read> gx_instances: array<GxInstance>;
@group(0) @binding(2) var<storage, read> gx_materials: array<GxMaterial>;
@group(1) @binding(0) var<storage, read_write> ring: array<RingVertex>;
@group(1) @binding(1) var<uniform> params: vec4<f32>;

@compute @workgroup_size(24)
fn cs_ring(@builtin(global_invocation_id) id: vec3<u32>) {
    let k = id.x;
    let segments = 24.0;
    let tau = 6.2831853;
    let a0 = (f32(k) + params.x * 0.05) * tau / segments;
    let a1 = (f32(k) + 0.5 + params.x * 0.05) * tau / segments;
    let center = vec3<f32>(0.0, 0.4, 1.0);
    let radius = 1.1 + 0.0 * gx_instances[0].bounds.w;
    let base = gx_materials[0].base_color;
    let lit = select(base.rgb, vec3<f32>(1.0, 0.85, 0.2), k % 2u == 0u);
    let color = vec4<f32>(lit, 1.0);
    ring[k * 3u + 0u] = RingVertex(vec4<f32>(center, 1.0), color);
    ring[k * 3u + 1u] = RingVertex(vec4<f32>(center + radius * vec3<f32>(cos(a0), 0.0, sin(a0)), 1.0), color);
    ring[k * 3u + 2u] = RingVertex(vec4<f32>(center + radius * vec3<f32>(cos(a1), 0.0, sin(a1)), 1.0), color);
}
";

/// The after-opaque pass: draws the ring through the frame's camera (`gx_frame.view_proj`),
/// depth-tested and depth-writing against the world.
const RING_DRAW: &str = "
struct RingVertex { position: vec4<f32>, color: vec4<f32> }
struct VsOut { @builtin(position) clip: vec4<f32>, @location(0) color: vec4<f32> }

@group(0) @binding(0) var<uniform> gx_frame: GxFrame;
@group(1) @binding(0) var<storage, read> ring: array<RingVertex>;

@vertex
fn vs_ring(@builtin(vertex_index) i: u32) -> VsOut {
    let v = ring[i];
    var out: VsOut;
    out.clip = gx_frame.view_proj * vec4<f32>(v.position.xyz, 1.0);
    out.color = v.color;
    return out;
}

@fragment
fn fs_ring(in: VsOut) -> @location(0) vec4<f32> {
    return in.color;
}
";

/// The after-transparent pass: a half-transparent violet pane, depth-tested, not depth-writing.
const PANE_DRAW: &str = "
struct VsOut { @builtin(position) clip: vec4<f32> }

@group(0) @binding(0) var<uniform> gx_frame: GxFrame;

@vertex
fn vs_pane(@builtin(vertex_index) i: u32) -> VsOut {
    var corners = array<vec2<f32>, 6>(vec2(-0.8, 0.0), vec2(0.8, 0.0), vec2(0.8, 1.4), vec2(-0.8, 0.0), vec2(0.8, 1.4), vec2(-0.8, 1.4));
    let c = corners[i];
    var out: VsOut;
    out.clip = gx_frame.view_proj * vec4<f32>(c.x + 2.0, c.y, 1.5, 1.0);
    return out;
}

@fragment
fn fs_pane(in: VsOut) -> @location(0) vec4<f32> {
    return vec4<f32>(0.6, 0.2, 0.9, 0.5);
}
";

/// The ring buffer the compute pass writes and the draw pass reads.
type SharedRing = Rc<RefCell<Option<wgpu::Buffer>>>;

fn uniform_entry(binding: u32, visibility: wgpu::ShaderStages) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility,
        ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None },
        count: None,
    }
}

fn storage_entry(binding: u32, visibility: wgpu::ShaderStages, read_only: bool) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility,
        ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Storage { read_only }, has_dynamic_offset: false, min_binding_size: None },
        count: None,
    }
}

struct RingCompute {
    ring: SharedRing,
    resources: Option<(wgpu::Buffer, wgpu::BindGroup, wgpu::ComputePipeline)>,
}

impl CustomPass for RingCompute {
    fn rebuild(&mut self, setup: &mut PassSetup<'_>) -> Result<(), RenderError> {
        let ring = setup.create_buffer(&wgpu::BufferDescriptor {
            label: Some("ring"),
            size: u64::from(RING_SEGMENTS * 3) * 32,
            usage: wgpu::BufferUsages::STORAGE,
            mapped_at_creation: false,
        })?;
        let params = setup.create_buffer(&wgpu::BufferDescriptor {
            label: Some("ring params"),
            size: 16,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        })?;
        let module = setup.create_shader("ring compute", RING_COMPUTE)?;
        let own = setup.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("ring compute"),
            entries: &[storage_entry(0, wgpu::ShaderStages::COMPUTE, false), uniform_entry(1, wgpu::ShaderStages::COMPUTE)],
        });
        let group = setup.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("ring compute"),
            layout: &own,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: ring.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: params.as_entire_binding() },
            ],
        });
        let layout = setup.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("ring compute"),
            bind_group_layouts: &[Some(setup.tables_layout()), Some(&own)],
            immediate_size: 0,
        });
        let pipeline = setup.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("ring compute"),
            layout: Some(&layout),
            module: &module,
            entry_point: Some("cs_ring"),
            compilation_options: Default::default(),
            cache: None,
        });
        *self.ring.borrow_mut() = Some(ring);
        self.resources = Some((params, group, pipeline));
        Ok(())
    }

    fn encode(&mut self, frame: &mut PassFrame<'_>) {
        let Some((params, group, pipeline)) = &self.resources else { return };
        let tick = frame.tick() as f32;
        frame.write_buffer(params, 0, bytemuck::cast_slice(&[tick, 0.0, 0.0, 0.0])).expect("within the upload budget");
        let tables = frame.tables().clone();
        let Some(encoder) = frame.encoder() else { return };
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("ring"), timestamp_writes: None });
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, &tables, &[]);
        pass.set_bind_group(1, group, &[]);
        pass.dispatch_workgroups(1, 1, 1);
    }
}

struct RingDraw {
    ring: SharedRing,
    resources: Option<(wgpu::BindGroup, wgpu::RenderPipeline)>,
}

impl CustomPass for RingDraw {
    fn rebuild(&mut self, setup: &mut PassSetup<'_>) -> Result<(), RenderError> {
        let ring = self.ring.borrow().clone().ok_or_else(|| RenderError::refused(RenderCode::GpuPassInvalid, "the ring compute pass registers first"))?;
        let module = setup.create_shader("ring draw", RING_DRAW)?;
        let own = setup.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("ring draw"),
            entries: &[storage_entry(0, wgpu::ShaderStages::VERTEX, true)],
        });
        let group = setup.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("ring draw"),
            layout: &own,
            entries: &[wgpu::BindGroupEntry { binding: 0, resource: ring.as_entire_binding() }],
        });
        let layout = setup.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("ring draw"),
            bind_group_layouts: &[Some(setup.tables_layout()), Some(&own)],
            immediate_size: 0,
        });
        let targets = [Some(wgpu::ColorTargetState { format: setup.world_format(), blend: None, write_mask: wgpu::ColorWrites::ALL })];
        let pipeline = setup.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("ring draw"),
            layout: Some(&layout),
            vertex: wgpu::VertexState { module: &module, entry_point: Some("vs_ring"), compilation_options: Default::default(), buffers: &[] },
            primitive: wgpu::PrimitiveState { cull_mode: None, ..Default::default() },
            depth_stencil: Some(setup.world_depth(true)),
            multisample: setup.world_multisample(),
            fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some("fs_ring"), compilation_options: Default::default(), targets: &targets }),
            multiview_mask: None,
            cache: None,
        });
        self.resources = Some((group, pipeline));
        Ok(())
    }

    fn encode(&mut self, frame: &mut PassFrame<'_>) {
        let Some((group, pipeline)) = &self.resources else { return };
        let Some(draws) = frame.draws() else { return };
        draws.set_pipeline(pipeline);
        draws.bind_tables(0);
        draws.set_bind_group(1, group, &[]);
        draws.draw(0..RING_SEGMENTS * 3, 0..1);
    }
}

#[derive(Default)]
struct PaneDraw {
    pipeline: Option<wgpu::RenderPipeline>,
}

impl CustomPass for PaneDraw {
    fn rebuild(&mut self, setup: &mut PassSetup<'_>) -> Result<(), RenderError> {
        let module = setup.create_shader("pane", PANE_DRAW)?;
        let layout = setup.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("pane"),
            bind_group_layouts: &[Some(setup.tables_layout())],
            immediate_size: 0,
        });
        let targets = [Some(wgpu::ColorTargetState {
            format: setup.world_format(),
            blend: Some(wgpu::BlendState::ALPHA_BLENDING),
            write_mask: wgpu::ColorWrites::COLOR,
        })];
        self.pipeline = Some(setup.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("pane"),
            layout: Some(&layout),
            vertex: wgpu::VertexState { module: &module, entry_point: Some("vs_pane"), compilation_options: Default::default(), buffers: &[] },
            primitive: wgpu::PrimitiveState { cull_mode: None, ..Default::default() },
            depth_stencil: Some(setup.world_depth(false)),
            multisample: setup.world_multisample(),
            fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some("fs_pane"), compilation_options: Default::default(), targets: &targets }),
            multiview_mask: None,
            cache: None,
        }));
        Ok(())
    }

    fn encode(&mut self, frame: &mut PassFrame<'_>) {
        let Some(pipeline) = &self.pipeline else { return };
        let Some(draws) = frame.draws() else { return };
        draws.set_pipeline(pipeline);
        draws.bind_tables(0);
        draws.draw(0..6, 0..1);
    }
}

/// A pass whose rebuild hook runs `build` (refusal rows).
struct Builds<F: FnMut(&mut PassSetup<'_>) -> Result<(), RenderError>>(F);

impl<F: FnMut(&mut PassSetup<'_>) -> Result<(), RenderError>> CustomPass for Builds<F> {
    fn rebuild(&mut self, setup: &mut PassSetup<'_>) -> Result<(), RenderError> {
        (self.0)(setup)
    }

    fn encode(&mut self, _frame: &mut PassFrame<'_>) {}
}

/// A pass whose frame work wgpu refuses: an in-world draw with no pipeline set.
struct DrawsWithoutPipeline;

impl CustomPass for DrawsWithoutPipeline {
    fn rebuild(&mut self, _setup: &mut PassSetup<'_>) -> Result<(), RenderError> {
        Ok(())
    }

    fn encode(&mut self, frame: &mut PassFrame<'_>) {
        if let Some(draws) = frame.draws() {
            draws.draw(0..3, 0..1);
        }
    }
}

/// A post pass whose encoder work wgpu refuses: clearing a buffer that is not a copy destination.
#[derive(Default)]
struct ClearsReadOnlyBuffer {
    buffer: Option<wgpu::Buffer>,
}

impl CustomPass for ClearsReadOnlyBuffer {
    fn rebuild(&mut self, setup: &mut PassSetup<'_>) -> Result<(), RenderError> {
        let descriptor = wgpu::BufferDescriptor { label: Some("read only"), size: 256, usage: wgpu::BufferUsages::STORAGE, mapped_at_creation: false };
        self.buffer = Some(setup.create_buffer(&descriptor)?);
        Ok(())
    }

    fn encode(&mut self, frame: &mut PassFrame<'_>) {
        let Some(buffer) = self.buffer.clone() else { return };
        if let Some(encoder) = frame.encoder() {
            encoder.clear_buffer(&buffer, 0, None);
        }
    }
}

/// The in-world set: the ring's compute and draw, and the pane.
struct InWorld {
    compute: RingCompute,
    ring: RingDraw,
    pane: PaneDraw,
}

impl InWorld {
    fn new() -> InWorld {
        let shared: SharedRing = Rc::new(RefCell::new(None));
        InWorld {
            compute: RingCompute { ring: Rc::clone(&shared), resources: None },
            ring: RingDraw { ring: shared, resources: None },
            pane: PaneDraw::default(),
        }
    }

    fn register(&mut self, passes: &mut CustomPasses, gpu: &Gpu) {
        passes.register(gpu, "ring-compute", PassStage::BeforeCull, &mut self.compute).expect("compute pass");
        passes.register(gpu, "ring", PassStage::AfterOpaque, &mut self.ring).expect("ring pass");
        passes.register(gpu, "pane", PassStage::AfterTransparent, &mut self.pane).expect("pane pass");
    }

    fn list(&mut self) -> [&mut dyn CustomPass; 3] {
        [&mut self.compute, &mut self.ring, &mut self.pane]
    }
}

/// A test HUD reporting `primitives` painted.
struct CountingOverlay {
    primitives: u32,
}

impl OverlayPainter for CountingOverlay {
    fn paint(&mut self, _gpu: &Gpu, _encoder: &mut wgpu::CommandEncoder, _target: &wgpu::TextureView, _size: [u32; 2]) -> u32 {
        self.primitives
    }
}

// ---------------------------------------------------------------------------------------------
// CPU rows

#[test]
fn the_custom_pass_api_version_stages_and_refusal_code_have_their_wire_spellings() {
    // The host's NATIVE_CUSTOM_PASS_API_VERSION, which genex-studio's own copy (the receipt's) is also held to.
    let fixture = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../tests/fixtures/native-wire-v2.json"))
        .expect("native-wire-v2.json");
    let wire: serde_json::Value = serde_json::from_str(&fixture).expect("fixture json");
    assert_eq!(wire["customPassApi"].as_u64(), Some(u64::from(CUSTOM_PASS_API_VERSION)), "the host's NATIVE_CUSTOM_PASS_API_VERSION");
    assert_eq!(RenderCode::GpuPassInvalid.wire(), "gpu-pass-invalid");
    assert_eq!(CUSTOM_TAG, "custom");
    let wires: Vec<&str> = PassStage::ALL.iter().map(|stage| stage.wire()).collect();
    assert_eq!(wires, ["before-cull", "after-opaque", "after-transparent", "post", "post-hdr", "after-prepass"], "stages are appended, never renamed");
    assert_eq!(wires, genex_render::abi::CUSTOM_PASS_STAGES, "the stages the receipt serves (the host's CustomPassStage)");
    for stage in PassStage::ALL {
        assert_eq!(PassStage::from_wire(stage.wire()), Some(stage));
    }
    assert_eq!(PassStage::from_wire("before-hud"), None);
}

#[test]
fn pass_names_are_short_printable_and_never_empty() {
    check_pass_name("bloom-1").expect("a plain name");
    let long = "x".repeat(65);
    for bad in ["", " ", "tab\tname", "new\nline", long.as_str()] {
        let error = check_pass_name(bad).expect_err("refused");
        assert_eq!(error.code(), RenderCode::GpuPassInvalid, "{bad:?}");
    }
}

#[test]
fn pass_wgsl_over_wgsl_max_bytes_or_failing_naga_is_refused_gpu_pass_invalid_naming_the_pass() {
    let core = ExtensionContext::core();
    let ok = "@compute @workgroup_size(1) fn main() {}";
    assert_eq!(validate_pass_wgsl("ok", ok, &core).expect("core WGSL"), wgpu::Features::empty());
    let huge = format!("{ok}\n//{}", "x".repeat(WGSL_MAX_BYTES));
    refused(&validate_pass_wgsl("huge", &huge, &core).expect_err("too large"), RenderCode::GpuPassInvalid, "huge");
    let parse = "@compute @workgroup_size(1) fn main() { let x = ; }";
    refused(&validate_pass_wgsl("parse", parse, &core).expect_err("parse error"), RenderCode::GpuPassInvalid, "parse");
    let types = "@fragment fn main() -> @location(0) vec4<f32> { return 1u; }";
    refused(&validate_pass_wgsl("types", types, &core).expect_err("type error"), RenderCode::GpuPassInvalid, "types");
}

#[test]
fn the_tables_prelude_matches_the_renderer_rows_and_is_usable_by_pass_wgsl() {
    let module = naga::front::wgsl::parse_str(TABLES_WGSL).expect("the prelude parses");
    let mut layouter = naga::proc::Layouter::default();
    layouter.update(module.to_ctx()).expect("layout");
    let size_of_struct = |name: &str| {
        let (handle, _) = module.types.iter().find(|(_, ty)| ty.name.as_deref() == Some(name)).unwrap_or_else(|| panic!("{name}"));
        layouter[handle].size as usize
    };
    // Level-3 passes bind the frozen v1 compat frame (abi::CompatFrame), not the grown GpuFrame.
    assert_eq!(size_of_struct("GxFrame") as u64, genex_render::abi::GX_FRAME_V1_BYTES);
    assert_eq!(size_of_struct("GxInstance"), size_of::<GpuInstance>());
    assert_eq!(size_of_struct("GxMaterial"), size_of::<GpuMaterial>());
    validate_pass_wgsl("ring", RING_COMPUTE, &ExtensionContext::core()).expect("the ring compute validates with the prelude");
    validate_pass_wgsl("ring", RING_DRAW, &ExtensionContext::core()).expect("the ring draw validates with the prelude");
}

#[test]
fn pass_wgsl_needing_an_undeclared_native_feature_is_refused_native_feature_missing() {
    let subgroup = "@compute @workgroup_size(64) fn main() { let lanes = subgroupAdd(1u); }";
    refused(&validate_pass_wgsl("lanes", subgroup, &ExtensionContext::core()).expect_err("never declared"), RenderCode::NativeFeatureMissing, "lanes");
    let declared_not_offered = ExtensionContext::new(wgpu::Features::SUBGROUP, wgpu::Features::empty());
    refused(&validate_pass_wgsl("lanes", subgroup, &declared_not_offered).expect_err("not on the device"), RenderCode::NativeFeatureMissing, "lanes");
    let usable = ExtensionContext::new(wgpu::Features::SUBGROUP, wgpu::Features::SUBGROUP);
    assert_eq!(validate_pass_wgsl("lanes", subgroup, &usable).expect("declared and offered"), wgpu::Features::SUBGROUP);
}

#[test]
fn pass_buffers_and_textures_are_held_to_the_gpu_caps_and_never_read_back() {
    let buffer = |size, usage| wgpu::BufferDescriptor { label: None, size, usage, mapped_at_creation: false };
    assert_eq!(check_buffer_descriptor("b", &buffer(256, wgpu::BufferUsages::STORAGE)).expect("a small buffer"), 256);
    refused(&check_buffer_descriptor("b", &buffer(BUFFER_MAX_BYTES + 4, wgpu::BufferUsages::STORAGE)).expect_err("over"), RenderCode::BufferTooLarge, "b");
    refused(&check_buffer_descriptor("b", &buffer(0, wgpu::BufferUsages::STORAGE)).expect_err("empty"), RenderCode::BufferTooLarge, "b");
    for readable in [wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST, wgpu::BufferUsages::MAP_WRITE | wgpu::BufferUsages::COPY_SRC] {
        refused(&check_buffer_descriptor("b", &buffer(256, readable)).expect_err("mappable"), RenderCode::GpuPassInvalid, "b");
    }
    let mapped = wgpu::BufferDescriptor { label: None, size: 256, usage: wgpu::BufferUsages::STORAGE, mapped_at_creation: true };
    refused(&check_buffer_descriptor("b", &mapped).expect_err("mapped at creation"), RenderCode::GpuPassInvalid, "b");
    let texture = |width, height, layers, mips| wgpu::TextureDescriptor {
        label: None,
        size: wgpu::Extent3d { width, height, depth_or_array_layers: layers },
        mip_level_count: mips,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    };
    assert_eq!(check_texture_descriptor("t", &texture(64, 32, 1, 1)).expect("small"), 64 * 32 * 4);
    assert_eq!(check_texture_descriptor("t", &texture(4, 4, 1, 3)).expect("mips"), (16 + 4 + 1) * 4, "every mip level counts");
    refused(&check_texture_descriptor("t", &texture(8192, 8, 1, 1)).expect_err("too wide"), RenderCode::TextureTooLarge, "t");
    refused(&check_texture_descriptor("t", &texture(4096, 4096, 2, 1)).expect_err("too many bytes"), RenderCode::TextureTooLarge, "t");
    const { assert!(GPU_PASS_BYTES_MAX >= BUFFER_MAX_BYTES, "one pass may hold one buffer at the cap") };
}

// ---------------------------------------------------------------------------------------------
// GPU rows

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
/// The renderer level holds no simulation: that a pass leaves the state checksum alone over 600
/// ticks is the facade's row (`genex::gpu`'s, and the custom-pass example's on the real path).
fn metal_golden_a_post_pass_changes_the_capture_and_the_live_frame_identically() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = FrameRenderer::new(&gpu, WIDTH, HEIGHT, RenderOptions::default()).expect("renderer");
    let mut passes = CustomPasses::new(&gpu, renderer.renderer(), wgpu::Features::empty());
    let mut scanlines = Scanlines::default();
    passes.register(&gpu, "scanlines", PassStage::Post, &mut scanlines).expect("admitted");
    let mut plain = None;
    let mut with = None;
    for tick in 1..=CHECKSUM_TICKS {
        if tick % 100 != 0 {
            continue;
        }
        renderer.render(&gpu, &base_frame(), CullPath::Gpu, None).expect("frame");
        plain = Some((renderer.capture(&gpu).expect("capture"), renderer.renderer_mut().present_to_texture(&gpu, (WIDTH, HEIGHT)).expect("live")));
        let mut list: [&mut dyn CustomPass; 1] = [&mut scanlines];
        let mut run = passes.frame(&gpu, &mut list, tick).expect("frame passes");
        renderer.render_with(&gpu, &base_frame(), CullPath::Gpu, None, &mut run).expect("frame with the pass");
        drop(run);
        with = Some((renderer.capture(&gpu).expect("capture"), renderer.renderer_mut().present_to_texture(&gpu, (WIDTH, HEIGHT)).expect("live")));
    }
    assert!(passes.refusals().is_empty(), "{:?}", passes.refusals());
    let (plain_capture, plain_live) = plain.expect("plain frames");
    let (capture, live) = with.expect("pass frames");
    assert_eq!(plain_live.digest(), plain_capture.digest(), "Live shows what a capture reads");
    assert_ne!(capture.digest(), plain_capture.digest(), "the post pass changed the frame");
    assert_eq!(live.digest(), capture.digest(), "the Live frame carries the post pass exactly as the capture does");
    check_golden("post-scanlines", &capture);
}

/// Draw `ticks` through a fresh renderer with the in-world set and the scanlines; the last capture.
fn replay(gpu: &Gpu, ticks: &[u64]) -> Capture {
    let mut renderer = FrameRenderer::new(gpu, WIDTH, HEIGHT, RenderOptions::default()).expect("renderer");
    let mut passes = CustomPasses::new(gpu, renderer.renderer(), wgpu::Features::empty());
    let mut world = InWorld::new();
    world.register(&mut passes, gpu);
    let mut scanlines = Scanlines::default();
    passes.register(gpu, "scanlines", PassStage::Post, &mut scanlines).expect("post pass");
    let mut last = None;
    for &tick in ticks {
        let [compute, ring, pane] = world.list();
        let mut list: [&mut dyn CustomPass; 4] = [compute, ring, pane, &mut scanlines];
        let mut run = passes.frame(gpu, &mut list, tick).expect("frame passes");
        renderer.render_with(gpu, &base_frame(), CullPath::Gpu, None, &mut run).expect("frame");
        drop(run);
        last = Some(renderer.capture(gpu).expect("capture"));
    }
    assert!(passes.refusals().is_empty(), "{:?}", passes.refusals());
    last.expect("a frame")
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_golden_in_world_passes_draw_against_the_world_depth_and_two_replays_capture_identically() {
    let Some(gpu) = gpu() else { return };
    let first = replay(&gpu, &[10, 20, 30]);
    let second = replay(&gpu, &[10, 20, 30]);
    assert_eq!(first.digest(), second.digest(), "two replays of the same ticks give the same capture");
    let direct = replay(&gpu, &[30]);
    assert_eq!(direct.digest(), first.digest(), "a pass frame is a function of the tick, not of the frames before it");
    // Without the passes the frame differs (the ring, the pane and the scanlines drew).
    let mut renderer = FrameRenderer::new(&gpu, WIDTH, HEIGHT, RenderOptions::default()).expect("renderer");
    renderer.render(&gpu, &base_frame(), CullPath::Gpu, None).expect("frame");
    let plain = renderer.capture(&gpu).expect("capture");
    assert_ne!(plain.digest(), first.digest());
    let in_world = {
        let mut renderer = FrameRenderer::new(&gpu, WIDTH, HEIGHT, RenderOptions::default()).expect("renderer");
        let mut passes = CustomPasses::new(&gpu, renderer.renderer(), wgpu::Features::empty());
        let mut world = InWorld::new();
        world.register(&mut passes, &gpu);
        let mut list = world.list();
        let mut run = passes.frame(&gpu, &mut list, 30).expect("frame passes");
        renderer.render_with(&gpu, &base_frame(), CullPath::Gpu, None, &mut run).expect("frame");
        drop(run);
        assert!(passes.refusals().is_empty(), "{:?}", passes.refusals());
        renderer.capture(&gpu).expect("capture")
    };
    assert_ne!(in_world.digest(), plain.digest(), "the ring and the pane drew inside the world pass");
    check_golden("in-world", &in_world);
    check_golden("in-world-scanlines", &first);
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_part1_renderer_runs_custom_passes_through_render_scene_as_the_studio_does() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = Renderer::new(&gpu, WIDTH, HEIGHT).expect("renderer");
    renderer.render(&gpu, &base_scene(), CullPath::Gpu).expect("frame");
    let plain = renderer.capture(&gpu).expect("capture");
    render_scene(&mut renderer, &gpu, &base_scene(), CullPath::Gpu, &mut NoCustom).expect("frame through render_scene");
    assert_eq!(renderer.capture(&gpu).expect("capture").digest(), plain.digest(), "no passes, the same frame");
    let mut passes = CustomPasses::new(&gpu, &renderer, wgpu::Features::empty());
    let mut world = InWorld::new();
    world.register(&mut passes, &gpu);
    let mut scanlines = Scanlines::default();
    passes.register(&gpu, "scanlines", PassStage::Post, &mut scanlines).expect("post pass");
    let [compute, ring, pane] = world.list();
    let mut list: [&mut dyn CustomPass; 4] = [compute, ring, pane, &mut scanlines];
    let mut run = passes.frame(&gpu, &mut list, 30).expect("frame passes");
    render_scene(&mut renderer, &gpu, &base_scene(), CullPath::Gpu, &mut run).expect("frame");
    assert_eq!(run.custom_draws(), 4);
    drop(run);
    assert!(passes.refusals().is_empty(), "{:?}", passes.refusals());
    let with = renderer.capture(&gpu).expect("capture");
    assert_ne!(with.digest(), plain.digest());
    assert_eq!(renderer.present_to_texture(&gpu, (WIDTH, HEIGHT)).expect("live").digest(), with.digest());
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_tagged_draw_counter_counts_each_pass_as_one_custom_draw() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = FrameRenderer::new(&gpu, WIDTH, HEIGHT, RenderOptions::default()).expect("renderer");
    let mut passes = CustomPasses::new(&gpu, renderer.renderer(), wgpu::Features::empty());
    let mut world = InWorld::new();
    world.register(&mut passes, &gpu);
    let mut scanlines = Scanlines::default();
    passes.register(&gpu, "scanlines", PassStage::Post, &mut scanlines).expect("post pass");
    let plain = renderer.render(&gpu, &base_frame(), CullPath::Gpu, Some(&mut CountingOverlay { primitives: 2 })).expect("frame");
    let [compute, ring, pane] = world.list();
    let mut list: [&mut dyn CustomPass; 4] = [compute, ring, pane, &mut scanlines];
    let mut run = passes.frame(&gpu, &mut list, 5).expect("frame passes");
    let report = renderer.render_with(&gpu, &base_frame(), CullPath::Gpu, Some(&mut CountingOverlay { primitives: 2 }), &mut run).expect("frame");
    drop(run);
    assert_eq!(report.draw_calls, plain.draw_calls + 4, "four passes, four logical draws");
    let tags: Vec<(&str, u32)> = report.tags.iter().map(|(tag, n)| (tag.as_str(), *n)).collect();
    assert_eq!(tags, vec![(WORLD_TAG, 4), (CUSTOM_TAG, 4), (HUD_TAG, 2)], "custom before the HUD, which paints last");
    let culled = {
        let [compute, ring, pane] = world.list();
        let mut list: [&mut dyn CustomPass; 4] = [compute, ring, pane, &mut scanlines];
        let mut run = passes.frame(&gpu, &mut list, 5).expect("frame passes");
        let report = renderer.render_with(&gpu, &base_frame(), CullPath::Cpu, None, &mut run).expect("cpu frame");
        drop(run);
        report
    };
    assert_eq!(culled.draw_calls, report.draw_calls - 2, "the cull path never changes the logical count");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_pass_resources_over_the_caps_bad_wgsl_and_undeclared_features_are_refused_naming_the_pass() {
    let Some(gpu) = gpu() else { return };
    let renderer = FrameRenderer::new(&gpu, WIDTH, HEIGHT, RenderOptions::default()).expect("renderer");
    let mut passes = CustomPasses::new(&gpu, renderer.renderer(), wgpu::Features::empty());
    let big = wgpu::BufferDescriptor { label: None, size: BUFFER_MAX_BYTES + 256, usage: wgpu::BufferUsages::STORAGE, mapped_at_creation: false };
    let mut over = Builds(|setup: &mut PassSetup<'_>| setup.create_buffer(&big).map(drop));
    refused(&passes.register(&gpu, "over", PassStage::Post, &mut over).expect_err("a buffer over the cap"), RenderCode::BufferTooLarge, "over");
    let half = wgpu::BufferDescriptor { label: None, size: GPU_PASS_BYTES_MAX / 2 + 256, usage: wgpu::BufferUsages::STORAGE, mapped_at_creation: false };
    let mut hoard = Builds(|setup: &mut PassSetup<'_>| {
        setup.create_buffer(&half)?;
        setup.create_buffer(&half).map(drop)
    });
    refused(&passes.register(&gpu, "hoard", PassStage::Post, &mut hoard).expect_err("over the pass's bytes"), RenderCode::BufferTooLarge, "hoard");
    let readback = wgpu::BufferDescriptor { label: None, size: 256, usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false };
    let mut reader = Builds(|setup: &mut PassSetup<'_>| setup.create_buffer(&readback).map(drop));
    refused(&passes.register(&gpu, "reader", PassStage::Post, &mut reader).expect_err("no readback"), RenderCode::GpuPassInvalid, "reader");
    let huge = format!("@compute @workgroup_size(1) fn main() {{}}\n//{}", "x".repeat(WGSL_MAX_BYTES));
    let mut long = Builds(|setup: &mut PassSetup<'_>| setup.create_shader("long", &huge).map(drop));
    refused(&passes.register(&gpu, "long", PassStage::BeforeCull, &mut long).expect_err("too long"), RenderCode::GpuPassInvalid, "long");
    let mut lanes =
        Builds(|setup: &mut PassSetup<'_>| setup.create_shader("lanes", "@compute @workgroup_size(64) fn main() { let l = subgroupAdd(1u); }").map(drop));
    refused(&passes.register(&gpu, "lanes", PassStage::BeforeCull, &mut lanes).expect_err("undeclared"), RenderCode::NativeFeatureMissing, "lanes");
    // wgpu's own validation inside the rebuild hook: a pipeline whose layout lacks the shader's group.
    let mut mismatch = Builds(|setup: &mut PassSetup<'_>| {
        let module = setup.create_shader("mismatch", "@group(0) @binding(0) var<storage, read_write> out: array<u32>;\n@compute @workgroup_size(1) fn main() { out[0] = 1u; }")?;
        let layout = setup.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: None, bind_group_layouts: &[], immediate_size: 0 });
        setup.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: None,
            layout: Some(&layout),
            module: &module,
            entry_point: Some("main"),
            compilation_options: Default::default(),
            cache: None,
        });
        Ok(())
    });
    refused(&passes.register(&gpu, "mismatch", PassStage::BeforeCull, &mut mismatch).expect_err("wgpu validation"), RenderCode::GpuPassInvalid, "mismatch");
    assert_eq!(passes.len(), 0, "a refused pass is not registered");
    let mut fine = Scanlines::default();
    passes.register(&gpu, "fine", PassStage::Post, &mut fine).expect("the registry still admits a good pass");
    let mut again = Scanlines::default();
    refused(&passes.register(&gpu, "fine", PassStage::Post, &mut again).expect_err("a duplicate name"), RenderCode::GpuPassInvalid, "fine");
    for n in 1..GPU_PASSES_MAX {
        let mut extra = Builds(|_: &mut PassSetup<'_>| Ok(()));
        passes.register(&gpu, &format!("extra-{n}"), PassStage::Post, &mut extra).expect("within the cap");
    }
    let mut one_more = Builds(|_: &mut PassSetup<'_>| Ok(()));
    refused(&passes.register(&gpu, "one-more", PassStage::Post, &mut one_more).expect_err("over the pass cap"), RenderCode::GpuPassInvalid, "one-more");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_wgpu_validation_errors_while_encoding_disable_the_pass_with_gpu_pass_invalid_and_the_frame_survives() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = FrameRenderer::new(&gpu, WIDTH, HEIGHT, RenderOptions::default()).expect("renderer");
    renderer.render(&gpu, &base_frame(), CullPath::Gpu, None).expect("frame");
    let plain = renderer.capture(&gpu).expect("capture");
    let mut passes = CustomPasses::new(&gpu, renderer.renderer(), wgpu::Features::empty());
    let mut no_pipeline = DrawsWithoutPipeline;
    let mut clears = ClearsReadOnlyBuffer::default();
    passes.register(&gpu, "no-pipeline", PassStage::AfterOpaque, &mut no_pipeline).expect("admitted: nothing built");
    passes.register(&gpu, "clears", PassStage::Post, &mut clears).expect("admitted: a valid buffer");
    let mut list: [&mut dyn CustomPass; 2] = [&mut no_pipeline, &mut clears];
    let mut run = passes.frame(&gpu, &mut list, 1).expect("frame passes");
    let report = renderer.render_with(&gpu, &base_frame(), CullPath::Gpu, None, &mut run).expect("the frame itself survives");
    drop(run);
    assert_eq!(report.draw_calls, 4 + 2, "both registered passes still count");
    assert_eq!(renderer.capture(&gpu).expect("capture").digest(), plain.digest(), "nothing the refused passes encoded reached the frame");
    let refusals = passes.take_refusals();
    assert_eq!(refusals.len(), 2, "{refusals:?}");
    refused(&refusals[0], RenderCode::GpuPassInvalid, "no-pipeline");
    refused(&refusals[1], RenderCode::GpuPassInvalid, "clears");
    assert!(!passes.is_enabled("no-pipeline") && !passes.is_enabled("clears"), "a refused pass stops running");
    let mut list: [&mut dyn CustomPass; 2] = [&mut no_pipeline, &mut clears];
    let mut run = passes.frame(&gpu, &mut list, 2).expect("frame passes");
    renderer.render_with(&gpu, &base_frame(), CullPath::Gpu, None, &mut run).expect("next frame");
    drop(run);
    assert!(passes.take_refusals().is_empty(), "a disabled pass is not retried every frame");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_forced_device_loss_rebuilds_pass_resources_and_the_digest_after_recovery_equals_before() {
    let Some(gpu) = gpu() else { return };
    let mut resilient = Resilient::new(gpu, WIDTH, HEIGHT, RenderOptions::default(), Gpu::headless).expect("resilient renderer");
    let mut passes = CustomPasses::new(resilient.gpu(), resilient.renderer().renderer(), wgpu::Features::empty());
    let mut world = InWorld::new();
    world.register(&mut passes, resilient.gpu());
    let mut scanlines = Scanlines::default();
    passes.register(resilient.gpu(), "scanlines", PassStage::Post, &mut scanlines).expect("post pass");
    assert_eq!(scanlines.rebuilds, 1);
    let draw = |resilient: &mut Resilient, passes: &mut CustomPasses, world: &mut InWorld, scanlines: &mut Scanlines| {
        let [compute, ring, pane] = world.list();
        let mut list: [&mut dyn CustomPass; 4] = [compute, ring, pane, scanlines];
        let mut run = passes.frame(resilient.gpu(), &mut list, 42)?;
        resilient.render_with(&base_frame(), CullPath::Gpu, None, &mut run).map(drop)
    };
    draw(&mut resilient, &mut passes, &mut world, &mut scanlines).expect("frame");
    let before = resilient.capture().expect("capture");
    resilient.force_device_loss();
    let lost = draw(&mut resilient, &mut passes, &mut world, &mut scanlines).expect_err("a frame while lost");
    assert_eq!(lost.code(), RenderCode::DeviceLost);
    assert!(resilient.recover().expect("recovered"));
    {
        let [compute, ring, pane] = world.list();
        let mut list: [&mut dyn CustomPass; 4] = [compute, ring, pane, &mut scanlines];
        passes.rebuild(resilient.gpu(), &mut list).expect("every pass rebuilt on the new device");
    }
    assert_eq!(scanlines.rebuilds, 2, "the pass's rebuild hook ran again");
    draw(&mut resilient, &mut passes, &mut world, &mut scanlines).expect("frame after recovery");
    let after = resilient.capture().expect("capture after recovery");
    assert_eq!(after.digest(), before.digest(), "the rebuilt passes draw the identical frame");
    assert!(passes.refusals().is_empty(), "{:?}", passes.refusals());
}

// ---------------------------------------------------------------------------------------------
// Level-3 lifecycle (RQ0.3): pipeline-shaping facts, deferred error scopes, the render size and
// the budget ledger.

/// What one rebuild hook saw: why it ran, which facts changed, the stage's format and samples.
#[derive(Clone, Debug, PartialEq)]
struct Rebuilt {
    reason: RebuildReason,
    changed: Vec<&'static str>,
    format: wgpu::TextureFormat,
    samples: u32,
}

/// A pass that records every rebuild and the render size of every frame it encodes.
struct Watched<P: CustomPass> {
    inner: P,
    rebuilt: Vec<Rebuilt>,
    render_sizes: Vec<(u32, u32)>,
}

impl<P: CustomPass> Watched<P> {
    fn new(inner: P) -> Watched<P> {
        Watched { inner, rebuilt: Vec::new(), render_sizes: Vec::new() }
    }
}

impl<P: CustomPass> CustomPass for Watched<P> {
    fn rebuild(&mut self, setup: &mut PassSetup<'_>) -> Result<(), RenderError> {
        let changed = setup.pipeline_changes().wires();
        self.rebuilt.push(Rebuilt { reason: setup.rebuild_reason(), changed, format: setup.world_format(), samples: setup.samples() });
        self.inner.rebuild(setup)
    }

    fn encode(&mut self, frame: &mut PassFrame<'_>) {
        self.render_sizes.push(frame.render_size());
        self.inner.encode(frame);
    }
}

/// Draw one frame of `base_frame` with `list` at `tick`; the capture.
fn draw_with(gpu: &Gpu, renderer: &mut FrameRenderer, passes: &mut CustomPasses, list: &mut [&mut dyn CustomPass], tick: u64) -> Capture {
    let mut run = passes.frame(gpu, list, tick).expect("frame passes");
    renderer.render_with(gpu, &base_frame(), CullPath::Gpu, None, &mut run).expect("frame");
    drop(run);
    renderer.capture(gpu).expect("capture")
}

#[test]
fn rebuild_reasons_and_pipeline_changes_have_their_wire_spellings() {
    assert_eq!(RebuildReason::Install.wire(), "install");
    assert_eq!(RebuildReason::DeviceLost.wire(), "device-lost");
    assert_eq!(RebuildReason::PipelineChange.wire(), "pipeline-change");
    let base = PipelineFacts { scene_format: wgpu::TextureFormat::Bgra8Unorm, samples: 4, depth_reversed: false };
    assert!(!base.changes_to(base).any());
    let hdr = PipelineFacts { scene_format: wgpu::TextureFormat::Rgba16Float, ..base };
    assert_eq!(base.changes_to(hdr).wires(), vec!["format"]);
    let everything = PipelineFacts { scene_format: wgpu::TextureFormat::Rgba16Float, samples: 1, depth_reversed: true };
    assert_eq!(base.changes_to(everything).wires(), vec!["format", "samples", "depth"]);
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_scene_format_change_reruns_every_rebuild_naming_format_and_the_pass_keeps_drawing() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = FrameRenderer::new(&gpu, WIDTH, HEIGHT, RenderOptions::default()).expect("renderer");
    let mut passes = CustomPasses::new(&gpu, renderer.renderer(), wgpu::Features::empty());
    assert_eq!(passes.pipeline_facts(), PipelineFacts::of(renderer.renderer()));
    let mut scanlines = Watched::new(Scanlines::default());
    passes.register(&gpu, "scanlines", PassStage::Post, &mut scanlines).expect("admitted");
    let before = draw_with(&gpu, &mut renderer, &mut passes, &mut [&mut scanlines], 7);
    let hdr = PipelineFacts { scene_format: wgpu::TextureFormat::Rgba16Float, ..passes.pipeline_facts() };
    assert!(passes.set_pipeline_facts(&gpu, &mut [&mut scanlines], hdr).expect("rebuilt"), "a change rebuilds");
    assert!(!passes.set_pipeline_facts(&gpu, &mut [&mut scanlines], hdr).expect("unchanged"), "the same facts rebuild nothing");
    let reasons: Vec<(RebuildReason, Vec<&str>)> = scanlines.rebuilt.iter().map(|r| (r.reason, r.changed.clone())).collect();
    assert_eq!(reasons, vec![(RebuildReason::Install, vec![]), (RebuildReason::PipelineChange, vec!["format"])]);
    assert_eq!(scanlines.rebuilt[1].format, wgpu::TextureFormat::Bgra8Unorm, "a post pass draws on the output target");
    let after = draw_with(&gpu, &mut renderer, &mut passes, &mut [&mut scanlines], 7);
    assert!(passes.refusals().is_empty(), "{:?}", passes.refusals());
    assert!(passes.is_enabled("scanlines"));
    assert_eq!(after.digest(), before.digest(), "the rebuilt pass keeps drawing the same frame");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_sample_count_change_rebuilds_in_world_passes_for_the_new_world_pass() {
    let Some(gpu) = gpu() else { return };
    let msaa = FrameRenderer::new(&gpu, WIDTH, HEIGHT, RenderOptions::default()).expect("renderer");
    let mut single = FrameRenderer::new(&gpu, WIDTH, HEIGHT, RenderOptions { msaa: false }).expect("renderer without MSAA");
    let mut passes = CustomPasses::new(&gpu, msaa.renderer(), wgpu::Features::empty());
    let mut pane = Watched::new(PaneDraw::default());
    passes.register(&gpu, "pane", PassStage::AfterTransparent, &mut pane).expect("admitted");
    let facts = PipelineFacts::of(single.renderer());
    assert!(passes.set_pipeline_facts(&gpu, &mut [&mut pane], facts).expect("rebuilt"));
    let last = pane.rebuilt.last().cloned().expect("a rebuild");
    assert_eq!((last.reason, last.changed, last.samples), (RebuildReason::PipelineChange, vec!["samples"], 1));
    let rebuilt = draw_with(&gpu, &mut single, &mut passes, &mut [&mut pane], 5);
    assert!(passes.refusals().is_empty(), "{:?}", passes.refusals());
    let mut fresh_passes = CustomPasses::new(&gpu, single.renderer(), wgpu::Features::empty());
    let mut fresh = PaneDraw::default();
    fresh_passes.register(&gpu, "pane", PassStage::AfterTransparent, &mut fresh).expect("admitted");
    let expected = draw_with(&gpu, &mut single, &mut fresh_passes, &mut [&mut fresh], 5);
    assert_eq!(rebuilt.digest(), expected.digest(), "the rebuilt pass draws as one registered on the new renderer");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_deferred_scopes_refuse_an_invalid_pass_once_its_scope_resolves_and_it_stays_off() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = FrameRenderer::new(&gpu, WIDTH, HEIGHT, RenderOptions::default()).expect("renderer");
    renderer.render(&gpu, &base_frame(), CullPath::Gpu, None).expect("frame");
    let plain = renderer.capture(&gpu).expect("capture");
    let mut passes = CustomPasses::new(&gpu, renderer.renderer(), wgpu::Features::empty());
    passes.set_scope_mode(ScopeMode::Deferred);
    let mut no_pipeline = DrawsWithoutPipeline;
    let mut clears = ClearsReadOnlyBuffer::default();
    passes.register(&gpu, "no-pipeline", PassStage::AfterOpaque, &mut no_pipeline).expect("admitted: nothing built");
    passes.register(&gpu, "clears", PassStage::Post, &mut clears).expect("admitted: a valid buffer");
    let first = draw_with(&gpu, &mut renderer, &mut passes, &mut [&mut no_pipeline, &mut clears], 1);
    assert!(passes.refusals().is_empty(), "nothing is known before the scopes resolve: {:?}", passes.refusals());
    assert!(passes.pending_scopes() > 0, "the frame's scopes wait for the next one");
    assert_eq!(first.digest(), plain.digest(), "a pass on probation never reaches the world pass");
    let second = draw_with(&gpu, &mut renderer, &mut passes, &mut [&mut no_pipeline, &mut clears], 2);
    let refusals = passes.take_refusals();
    assert_eq!(refusals.len(), 2, "{refusals:?}");
    refused(&refusals[0], RenderCode::GpuPassInvalid, "no-pipeline");
    refused(&refusals[1], RenderCode::GpuPassInvalid, "clears");
    assert_eq!(passes.refusal_of("clears"), Some(RenderCode::GpuPassInvalid));
    assert!(!passes.is_enabled("no-pipeline") && !passes.is_enabled("clears"), "a refused pass stops running");
    assert_eq!(second.digest(), plain.digest());
    draw_with(&gpu, &mut renderer, &mut passes, &mut [&mut no_pipeline, &mut clears], 3);
    draw_with(&gpu, &mut renderer, &mut passes, &mut [&mut no_pipeline, &mut clears], 4);
    assert!(passes.take_refusals().is_empty(), "a refused pass stays off and is not retried");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_deferred_scopes_settle_asynchronously_and_admit_a_valid_in_world_pass_after_its_first_clean_proof() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = FrameRenderer::new(&gpu, WIDTH, HEIGHT, RenderOptions::default()).expect("renderer");
    renderer.render(&gpu, &base_frame(), CullPath::Gpu, None).expect("frame");
    let plain = renderer.capture(&gpu).expect("capture");
    let immediate = {
        let mut passes = CustomPasses::new(&gpu, renderer.renderer(), wgpu::Features::empty());
        let mut pane = PaneDraw::default();
        passes.register(&gpu, "pane", PassStage::AfterTransparent, &mut pane).expect("admitted");
        draw_with(&gpu, &mut renderer, &mut passes, &mut [&mut pane], 5)
    };
    let mut passes = CustomPasses::new(&gpu, renderer.renderer(), wgpu::Features::empty());
    passes.set_scope_mode(ScopeMode::Deferred);
    let mut pane = PaneDraw::default();
    let mut clears = ClearsReadOnlyBuffer::default();
    passes.register(&gpu, "pane", PassStage::AfterTransparent, &mut pane).expect("admitted");
    passes.register(&gpu, "clears", PassStage::Post, &mut clears).expect("admitted");
    let probation = draw_with(&gpu, &mut renderer, &mut passes, &mut [&mut pane, &mut clears], 5);
    assert_eq!(probation.digest(), plain.digest(), "the first frame holds the pass out until its proof resolves");
    // The web's capture path: await every pending scope, then apply what they found.
    let settled = pollster::block_on(passes.take_pending().settle());
    passes.apply_settled(settled);
    assert_eq!(passes.pending_scopes(), 0);
    assert_eq!(passes.refusal_of("clears"), Some(RenderCode::GpuPassInvalid), "the settled scope refused it");
    assert!(passes.is_enabled("pane"));
    let admitted = draw_with(&gpu, &mut renderer, &mut passes, &mut [&mut pane, &mut clears], 5);
    assert_eq!(admitted.digest(), immediate.digest(), "once proven the pass draws as in immediate mode");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_settled_first_proof_asks_for_the_capture_again_and_a_later_one_does_not() {
    // The web's capture draws, awaits the scopes and draws again only when their answers change
    // what the world pass replays: a pass proven for the first time (after a boot or a pipeline
    // change, e.g. a capture on another class's samples) must be drawn, not left out of the capture.
    let Some(gpu) = gpu() else { return };
    let mut renderer = FrameRenderer::new(&gpu, WIDTH, HEIGHT, RenderOptions::default()).expect("renderer");
    renderer.render(&gpu, &base_frame(), CullPath::Gpu, None).expect("frame");
    let plain = renderer.capture(&gpu).expect("capture");
    let mut passes = CustomPasses::new(&gpu, renderer.renderer(), wgpu::Features::empty());
    passes.set_scope_mode(ScopeMode::Deferred);
    let mut pane = PaneDraw::default();
    passes.register(&gpu, "pane", PassStage::AfterTransparent, &mut pane).expect("admitted");
    let probation = draw_with(&gpu, &mut renderer, &mut passes, &mut [&mut pane], 5);
    assert_eq!(probation.digest(), plain.digest(), "held out until its proof resolves");
    let settled = pollster::block_on(passes.take_pending().settle());
    assert!(passes.apply_settled(settled), "a first clean proof changes what the world pass replays");
    let admitted = draw_with(&gpu, &mut renderer, &mut passes, &mut [&mut pane], 5);
    assert_ne!(admitted.digest(), plain.digest(), "the redrawn capture carries the pass");
    let settled = pollster::block_on(passes.take_pending().settle());
    assert!(!passes.apply_settled(settled), "a proof of a pass already proven changes nothing");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_pass_frames_see_the_render_size_the_presenter_sets() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = FrameRenderer::new(&gpu, WIDTH, HEIGHT, RenderOptions::default()).expect("renderer");
    let mut passes = CustomPasses::new(&gpu, renderer.renderer(), wgpu::Features::empty());
    let mut scanlines = Watched::new(Scanlines::default());
    passes.register(&gpu, "scanlines", PassStage::Post, &mut scanlines).expect("admitted");
    draw_with(&gpu, &mut renderer, &mut passes, &mut [&mut scanlines], 1);
    renderer.renderer_mut().set_render_scale(0.5);
    passes.set_render_size(renderer.renderer().render_size());
    draw_with(&gpu, &mut renderer, &mut passes, &mut [&mut scanlines], 2);
    assert_eq!(scanlines.render_sizes, vec![(WIDTH, HEIGHT), (WIDTH / 2, HEIGHT / 2)]);
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_pass_bytes_enter_the_budget_ledger_and_the_passes_past_a_budget_are_named() {
    let Some(gpu) = gpu() else { return };
    let renderer = FrameRenderer::new(&gpu, WIDTH, HEIGHT, RenderOptions::default()).expect("renderer");
    let mut passes = CustomPasses::new(&gpu, renderer.renderer(), wgpu::Features::empty());
    const MIB: u64 = 1 << 20;
    let buffer_of = |size: u64| {
        move |setup: &mut PassSetup<'_>| {
            let desc = wgpu::BufferDescriptor { label: Some("bytes"), size, usage: wgpu::BufferUsages::STORAGE, mapped_at_creation: false };
            setup.create_buffer(&desc).map(drop)
        }
    };
    let mut small = Builds(buffer_of(MIB));
    let mut large = Builds(buffer_of(2 * MIB));
    passes.register(&gpu, "small", PassStage::Post, &mut small).expect("admitted");
    passes.register(&gpu, "large", PassStage::Post, &mut large).expect("admitted");
    let mut ledger = BudgetLedger::new();
    passes.register_budget(&mut ledger);
    assert_eq!(ledger.total_of(BudgetKind::Pass), 3 * MIB);
    let labels: Vec<(&str, u64)> = ledger.entries().iter().map(|entry| (entry.label.as_str(), entry.bytes)).collect();
    assert_eq!(labels, vec![("small", MIB), ("large", 2 * MIB)]);
    assert_eq!(passes.budget_passes(), vec![("small".to_owned(), MIB), ("large".to_owned(), 2 * MIB)]);
    assert_eq!(passes.over_budget(MIB, 3 * MIB), vec!["large".to_owned()], "the pass that crosses the budget, and those after it");
    assert!(passes.over_budget(0, 3 * MIB).is_empty());
}

/// A pass that declares an API version and frame inputs, and builds nothing.
struct Declares {
    api: u32,
    inputs: genex_render::abi::RenderInputs,
    rebuilt: bool,
}

impl CustomPass for Declares {
    fn rebuild(&mut self, _setup: &mut PassSetup<'_>) -> Result<(), RenderError> {
        self.rebuilt = true;
        Ok(())
    }
    fn encode(&mut self, _frame: &mut PassFrame<'_>) {}
    fn api(&self) -> u32 {
        self.api
    }
    fn inputs(&self) -> genex_render::abi::RenderInputs {
        self.inputs
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_an_unserved_api_a_v1_pass_with_inputs_or_at_post_hdr_is_refused_and_a_v2_pass_with_inputs_is_admitted() {
    use genex_render::abi::RenderInputs;
    let Some(gpu) = gpu() else { return };
    let renderer = Renderer::new(&gpu, WIDTH, HEIGHT).expect("renderer");
    let mut passes = CustomPasses::new(&gpu, &renderer, wgpu::Features::empty());
    for api in [0, 3] {
        let mut unserved = Declares { api, inputs: RenderInputs::NONE, rebuilt: false };
        let error = passes.register(&gpu, "unserved", PassStage::Post, &mut unserved).expect_err("an api this build does not serve");
        refused(&error, RenderCode::GpuPassInvalid, "unserved");
        assert!(!unserved.rebuilt, "refused before its rebuild hook runs");
    }
    // RQ2 produces the environment, RQ4 depth and normals; RQ5.6 flipped: motion is produced too
    // (the prepass's motion variant), no longer a neutral resource.
    assert_eq!(
        PRODUCED_INPUTS,
        RenderInputs::ENVIRONMENT | RenderInputs::DEPTH | RenderInputs::NORMALS | RenderInputs::MOTION,
        "the environment since RQ2, depth and normals since RQ4, motion since RQ5.6"
    );
    for input in RenderInputs::ALL.iter() {
        let mut asks = Declares { api: 1, inputs: input, rebuilt: false };
        let error = passes.register(&gpu, "asks", PassStage::Post, &mut asks).expect_err("a v1 pass reads no frame inputs");
        refused(&error, RenderCode::GpuPassInvalid, "asks");
        assert!(error.to_string().contains(input.wire()), "the refusal names {}: {error}", input.wire());
    }
    let mut v1_hdr = Declares { api: 1, inputs: RenderInputs::NONE, rebuilt: false };
    let error = passes.register(&gpu, "v1-hdr", PassStage::PostHdr, &mut v1_hdr).expect_err("post-hdr is an API v2 stage");
    refused(&error, RenderCode::GpuPassInvalid, "v1-hdr");
    let mut plain = Declares { api: 1, inputs: RenderInputs::NONE, rebuilt: false };
    passes.register(&gpu, "plain", PassStage::Post, &mut plain).expect("a v1 pass without inputs");
    let mut reads = Declares { api: 2, inputs: RenderInputs::DEPTH | RenderInputs::MOTION, rebuilt: false };
    passes.register(&gpu, "reads", PassStage::PostHdr, &mut reads).expect("a v2 pass with inputs");
    assert!(plain.rebuilt && reads.rebuilt);
    assert_eq!(passes.len(), 2, "only the admissible passes are registered");
    assert_eq!(passes.render_inputs(), RenderInputs::DEPTH | RenderInputs::MOTION, "what the graph is asked to produce (the receipt's renderInputs)");
}

// ---------------------------------------------------------------------------------------------
// Custom-pass API v2 (RQ1.3): the v2 tables, the scene format, `post-hdr`, the v1 LDR degrade

/// The v2 pane: the v1 pane's quad, drawn through the v2 tables (`GxFrameV2`), coloured by what
/// the v2 frame says about the scene (`scene_ldr`, `pre_exposure`).
const PANE_V2: &str = "
struct VsOut { @builtin(position) clip: vec4<f32> }

@group(0) @binding(0) var<uniform> gx_frame: GxFrameV2;

@vertex
fn vs_pane(@builtin(vertex_index) i: u32) -> VsOut {
    var corners = array<vec2<f32>, 6>(vec2(-0.8, 0.0), vec2(0.8, 0.0), vec2(0.8, 1.4), vec2(-0.8, 0.0), vec2(0.8, 1.4), vec2(-0.8, 1.4));
    let c = corners[i];
    var out: VsOut;
    out.clip = gx_frame.view_proj * vec4<f32>(c.x + 2.0, c.y, 1.5, 1.0);
    return out;
}

@fragment
fn fs_pane(in: VsOut) -> @location(0) vec4<f32> {
    return vec4<f32>(0.2, 0.9 * gx_frame.pre_exposure, 0.3 + 0.5 * f32(gx_frame.scene_ldr), 0.5);
}
";

/// A v2 pass drawing [`PANE_V2`] in the world (after-opaque), recording what its rebuilds saw.
#[derive(Default)]
struct PaneV2 {
    pipeline: Option<wgpu::RenderPipeline>,
    formats: Vec<wgpu::TextureFormat>,
    reasons: Vec<RebuildReason>,
}

impl CustomPass for PaneV2 {
    fn rebuild(&mut self, setup: &mut PassSetup<'_>) -> Result<(), RenderError> {
        self.formats.push(setup.world_format());
        self.reasons.push(setup.rebuild_reason());
        assert_eq!(setup.api(), 2);
        let module = setup.create_shader("pane v2", PANE_V2)?;
        let layout = setup.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("pane v2"),
            bind_group_layouts: &[Some(setup.tables_layout())],
            immediate_size: 0,
        });
        let targets = [Some(wgpu::ColorTargetState { format: setup.world_format(), blend: Some(wgpu::BlendState::ALPHA_BLENDING), write_mask: wgpu::ColorWrites::COLOR })];
        self.pipeline = Some(setup.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("pane v2"),
            layout: Some(&layout),
            vertex: wgpu::VertexState { module: &module, entry_point: Some("vs_pane"), compilation_options: Default::default(), buffers: &[] },
            primitive: wgpu::PrimitiveState { cull_mode: None, ..Default::default() },
            depth_stencil: Some(setup.world_depth(false)),
            multisample: setup.world_multisample(),
            fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some("fs_pane"), compilation_options: Default::default(), targets: &targets }),
            multiview_mask: None,
            cache: None,
        }));
        Ok(())
    }

    fn encode(&mut self, frame: &mut PassFrame<'_>) {
        let Some(pipeline) = &self.pipeline else { return };
        let Some(draws) = frame.draws() else { return };
        draws.set_pipeline(pipeline);
        draws.bind_tables(0);
        draws.draw(0..6, 0..1);
    }

    fn api(&self) -> u32 {
        2
    }
}

/// The v2 post-hdr pass: the scene's frame facts as a flat colour over the left half of the
/// target (red: `scene_ldr`, green: `pre_exposure`, blue: `depth_reversed`).
const FACTS_V2: &str = "
@group(0) @binding(0) var<uniform> gx_frame: GxFrameV2;

struct VsOut { @builtin(position) position: vec4<f32> }

@vertex
fn vs_main(@builtin(vertex_index) i: u32) -> VsOut {
    let uv = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
    var out: VsOut;
    out.position = vec4<f32>(uv * 2.0 - 1.0, 0.0, 1.0);
    return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    if in.position.x > 64.0 {
        discard;
    }
    return vec4<f32>(f32(gx_frame.scene_ldr), gx_frame.pre_exposure, f32(gx_frame.depth_reversed), 1.0);
}
";

/// A v2 pass at `post-hdr` drawing [`FACTS_V2`] over the scene target it is handed.
#[derive(Default)]
struct FactsV2 {
    pipeline: Option<wgpu::RenderPipeline>,
    seen: Vec<(wgpu::TextureFormat, bool, (u32, u32))>,
}

impl CustomPass for FactsV2 {
    fn rebuild(&mut self, setup: &mut PassSetup<'_>) -> Result<(), RenderError> {
        let module = setup.create_shader("facts v2", FACTS_V2)?;
        let layout = setup.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("facts v2"),
            bind_group_layouts: &[Some(setup.tables_layout())],
            immediate_size: 0,
        });
        let targets = [Some(wgpu::ColorTargetState { format: setup.world_format(), blend: None, write_mask: wgpu::ColorWrites::ALL })];
        self.pipeline = Some(setup.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("facts v2"),
            layout: Some(&layout),
            vertex: wgpu::VertexState { module: &module, entry_point: Some("vs_main"), compilation_options: Default::default(), buffers: &[] },
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some("fs_main"), compilation_options: Default::default(), targets: &targets }),
            multiview_mask: None,
            cache: None,
        }));
        Ok(())
    }

    fn encode(&mut self, frame: &mut PassFrame<'_>) {
        let Some(pipeline) = self.pipeline.clone() else { return };
        let tables = frame.tables().clone();
        let (Some(target), Some(view)) = (frame.world_texture().cloned(), frame.world_view().cloned()) else { return };
        self.seen.push((target.format(), frame.depth_reversed(), frame.render_size()));
        let Some(encoder) = frame.encoder() else { return };
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("facts v2"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store },
            })],
            ..Default::default()
        });
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &tables, &[]);
        pass.draw(0..3, 0..1);
    }

    fn api(&self) -> u32 {
        2
    }
}

/// An HDR-requested frame config at the test size.
fn hdr_requested() -> genex_render::FrameConfig {
    let mut quality = genex_render::Quality::off();
    quality.hdr = true;
    genex_render::RenderSettings::off()
        .with_quality(genex_render::settings::PresetChoice::Off, quality)
        .frame_config((WIDTH, HEIGHT), 1.0, 0, true)
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_v1_after_opaque_pass_switches_the_frame_to_ldr_and_a_v2_one_keeps_it_hdr() {
    use genex_render::LdrReason;
    let Some(gpu) = gpu() else { return };
    let renderer = Renderer::new(&gpu, WIDTH, HEIGHT).expect("renderer");
    let requested = hdr_requested();
    let mut v1 = CustomPasses::new(&gpu, &renderer, wgpu::Features::empty());
    let mut pane = PaneDraw::default();
    v1.register(&gpu, "pane", PassStage::AfterOpaque, &mut pane).expect("a v1 in-world pass");
    assert_eq!(v1.ldr_reason(), Some(LdrReason::CustomPassV1InWorld));
    let drawn = v1.frame_config(requested);
    assert!(!drawn.hdr && !drawn.depth_reversed, "the frame is drawn LDR with standard Z: {drawn:?}");
    assert_eq!(drawn.ldr_reason.map(LdrReason::wire), Some("custom-pass-v1-in-world"));
    let facts = PipelineFacts::for_frame(&drawn, renderer.sample_count(), wgpu::TextureFormat::Rgba16Float);
    assert_eq!(facts, PipelineFacts::of(&renderer), "an LDR-degraded frame keeps the legacy scene");
    let mut v2 = CustomPasses::new(&gpu, &renderer, wgpu::Features::empty());
    let mut pane_v2 = PaneV2::default();
    v2.register(&gpu, "pane-v2", PassStage::AfterOpaque, &mut pane_v2).expect("a v2 in-world pass");
    assert_eq!(v2.ldr_reason(), None);
    let kept = v2.frame_config(requested);
    assert_eq!(kept, requested, "a v2 in-world pass keeps the frame HDR");
    let hdr = PipelineFacts::for_frame(&kept, renderer.sample_count(), wgpu::TextureFormat::Rgba16Float);
    assert!(v2.set_pipeline_facts(&gpu, &mut [&mut pane_v2], hdr).expect("rebuilt for the HDR scene"));
    assert_eq!(pane_v2.formats, vec![wgpu::TextureFormat::Bgra8Unorm, wgpu::TextureFormat::Rgba16Float], "a v2 in-world pass draws in the scene format");
    assert!(v2.is_enabled("pane-v2") && v2.refusals().is_empty());
    let mut post = CustomPasses::new(&gpu, &renderer, wgpu::Features::empty());
    let mut scanlines = Watched::new(Scanlines::default());
    post.register(&gpu, "scanlines", PassStage::Post, &mut scanlines).expect("a v1 post pass");
    assert_eq!(post.ldr_reason(), None, "a v1 post pass never degrades the frame");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_v1_post_pass_still_sees_the_ldr_world_target() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = FrameRenderer::new(&gpu, WIDTH, HEIGHT, RenderOptions::default()).expect("renderer");
    let mut passes = CustomPasses::new(&gpu, renderer.renderer(), wgpu::Features::empty());
    let mut scanlines = Watched::new(Scanlines::default());
    passes.register(&gpu, "scanlines", PassStage::Post, &mut scanlines).expect("a v1 post pass");
    let before = draw_with(&gpu, &mut renderer, &mut passes, &mut [&mut scanlines], 3);
    let hdr = PipelineFacts::for_frame(&hdr_requested(), renderer.renderer().sample_count(), wgpu::TextureFormat::Rgba16Float);
    passes.set_pipeline_facts(&gpu, &mut [&mut scanlines], hdr).expect("rebuilt for an HDR session");
    assert_eq!(scanlines.rebuilt.last().map(|r| r.format), Some(wgpu::TextureFormat::Bgra8Unorm), "post draws on the world target");
    let after = draw_with(&gpu, &mut renderer, &mut passes, &mut [&mut scanlines], 3);
    assert!(passes.refusals().is_empty(), "{:?}", passes.refusals());
    assert_eq!(after.digest(), before.digest(), "the v1 post pass sees the same LDR world target");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_v2_pass_binds_the_v2_tables_and_runs_at_post_hdr_before_post() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = Renderer::new(&gpu, WIDTH, HEIGHT).expect("renderer");
    let mut passes = CustomPasses::new(&gpu, &renderer, wgpu::Features::empty());
    let mut facts = FactsV2::default();
    let mut scanlines = Scanlines::default();
    passes.register(&gpu, "facts", PassStage::PostHdr, &mut facts).expect("a v2 post-hdr pass");
    passes.register(&gpu, "scanlines", PassStage::Post, &mut scanlines).expect("a v1 post pass");
    let mut list: [&mut dyn CustomPass; 2] = [&mut facts, &mut scanlines];
    let mut run = passes.frame(&gpu, &mut list, 4).expect("frame passes");
    render_scene(&mut renderer, &gpu, &base_scene(), CullPath::Gpu, &mut run).expect("frame");
    drop(run);
    assert!(passes.refusals().is_empty(), "{:?}", passes.refusals());
    assert_eq!(facts.seen, vec![(wgpu::TextureFormat::Bgra8Unorm, false, (WIDTH, HEIGHT))], "the LDR scene, standard Z, at render size");
    let capture = renderer.capture(&gpu).expect("capture");
    let [b, g, r, _] = capture.bgra()[(10 * WIDTH as usize + 10) * 4..][..4] else { panic!("pixel") };
    // scene_ldr 1, pre_exposure 1, depth_reversed 0 drawn at post-hdr: (1, 1, 0); then the v1
    // scanlines mix it half way with its rotation (1, 0, 1): (1, 0.5, 0.5).
    let half = 100..160;
    assert!(r > 240 && half.contains(&g) && half.contains(&b), "post-hdr ran before post, reading the v2 frame (BGRA {b} {g} {r})");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_frame_renderer_runs_post_hdr_before_post_as_the_presenter_draws() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = FrameRenderer::new(&gpu, WIDTH, HEIGHT, RenderOptions::default()).expect("renderer");
    let mut passes = CustomPasses::new(&gpu, renderer.renderer(), wgpu::Features::empty());
    let mut facts = FactsV2::default();
    let mut scanlines = Scanlines::default();
    passes.register(&gpu, "facts", PassStage::PostHdr, &mut facts).expect("a v2 post-hdr pass");
    passes.register(&gpu, "scanlines", PassStage::Post, &mut scanlines).expect("a v1 post pass");
    let capture = draw_with(&gpu, &mut renderer, &mut passes, &mut [&mut facts, &mut scanlines], 4);
    assert!(passes.refusals().is_empty(), "{:?}", passes.refusals());
    assert_eq!(facts.seen, vec![(wgpu::TextureFormat::Bgra8Unorm, false, (WIDTH, HEIGHT))], "post-hdr ran once on the LDR world target");
    let [b, g, r, _] = capture.bgra()[(10 * WIDTH as usize + 10) * 4..][..4] else { panic!("pixel") };
    let half = 100..160;
    assert!(r > 240 && half.contains(&g) && half.contains(&b), "post-hdr ran before post (BGRA {b} {g} {r})");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_switching_the_preset_from_medium_to_high_keeps_a_v2_after_opaque_pass_running() {
    use genex_render::device_class::{DeviceClass, FormFactor, PerformanceTier};
    use genex_render::presets::preset_quality;
    use genex_render::settings::QualityPreset;
    let Some(gpu) = gpu() else { return };
    let mut renderer = FrameRenderer::new(&gpu, WIDTH, HEIGHT, RenderOptions::default()).expect("renderer");
    renderer.render(&gpu, &base_frame(), CullPath::Gpu, None).expect("frame");
    let plain = renderer.capture(&gpu).expect("capture");
    let mut passes = CustomPasses::new(&gpu, renderer.renderer(), wgpu::Features::empty());
    let mut pane = PaneV2::default();
    passes.register(&gpu, "pane-v2", PassStage::AfterOpaque, &mut pane).expect("a v2 in-world pass");
    let desktop = DeviceClass::new(FormFactor::Desktop, PerformanceTier::High);
    for preset in [QualityPreset::Medium, QualityPreset::High] {
        let mut quality = preset_quality(preset, desktop);
        // This build draws the legacy scene: the presenter hands HDR facts over once RQ1.1's
        // target lands. The preset's other switches apply.
        quality.hdr = false;
        renderer.renderer_mut().set_quality(&quality);
        passes.set_quality(quality);
        let facts = PipelineFacts::of(renderer.renderer());
        passes.set_pipeline_facts(&gpu, &mut [&mut pane], facts).expect("facts");
        let capture = draw_with(&gpu, &mut renderer, &mut passes, &mut [&mut pane], 9);
        assert!(passes.is_enabled("pane-v2") && passes.refusals().is_empty(), "{preset:?}: {:?}", passes.refusals());
        assert_ne!(capture.digest(), plain.digest(), "{preset:?}: the pane draws");
    }
    assert_eq!(pane.reasons, vec![RebuildReason::Install], "a preset switch with the same pipeline facts rebuilds nothing");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_drs_step_never_disables_a_pass() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = FrameRenderer::new(&gpu, WIDTH, HEIGHT, RenderOptions::default()).expect("renderer");
    let mut passes = CustomPasses::new(&gpu, renderer.renderer(), wgpu::Features::empty());
    let mut pane = PaneV2::default();
    let mut scanlines = Scanlines::default();
    passes.register(&gpu, "pane-v2", PassStage::AfterOpaque, &mut pane).expect("v2");
    passes.register(&gpu, "scanlines", PassStage::Post, &mut scanlines).expect("v1");
    for (tick, scale) in [(1, 1.0), (2, 0.75), (3, 0.5), (4, 1.0)] {
        renderer.renderer_mut().set_render_scale(scale);
        passes.set_render_size(renderer.renderer().render_size());
        let mut list: [&mut dyn CustomPass; 2] = [&mut pane, &mut scanlines];
        let mut run = passes.frame(&gpu, &mut list, tick).expect("frame passes");
        renderer.render_with(&gpu, &base_frame(), CullPath::Gpu, None, &mut run).expect("frame");
        drop(run);
        assert!(passes.is_enabled("pane-v2") && passes.is_enabled("scanlines"), "scale {scale}: {:?}", passes.refusals());
    }
    assert!(passes.refusals().is_empty(), "{:?}", passes.refusals());
    assert_eq!(scanlines.rebuilds, 1, "a scale step is not a pipeline change");
    assert_eq!(pane.reasons, vec![RebuildReason::Install]);
}

// ---------------------------------------------------------------------------------------------
// RQ4.5: the `after-prepass` stage and the prepass's depth and normals in the v2 tables

/// Writes a horizontal depth gradient, `(x + 0.5) / 128` at pixel column `x`.
const DEPTH_GRADIENT: &str = "
struct VsOut { @builtin(position) position: vec4<f32> }

@vertex
fn vs_main(@builtin(vertex_index) i: u32) -> VsOut {
    let uv = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
    var out: VsOut;
    out.position = vec4<f32>(uv * 2.0 - 1.0, 0.5, 1.0);
    return out;
}

@fragment
fn fs_main(in: VsOut) -> @builtin(frag_depth) f32 {
    return in.position.x / 128.0;
}
";

/// The octahedral normal every texel of [`synthetic_prepass`]'s normals holds.
const PREPASS_NORMAL: [f64; 2] = [0.5, -0.25];

/// Stand-in prepass targets at the test size (the renderer's own prepass lands with RQ4.1): depth
/// is [`DEPTH_GRADIENT`], every normal is [`PREPASS_NORMAL`].
fn synthetic_prepass(gpu: &Gpu) -> PrepassViews {
    let target = |label, format| {
        gpu.device.create_texture(&wgpu::TextureDescriptor {
            label: Some(label),
            size: wgpu::Extent3d { width: WIDTH, height: HEIGHT, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        })
    };
    let depth = target("synthetic prepass depth", genex_render::renderer::DEPTH_FORMAT).create_view(&Default::default());
    let normals = target("synthetic prepass normals", genex_render::prepass::NORMALS_FORMAT).create_view(&Default::default());
    let module = gpu.device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("depth gradient"), source: wgpu::ShaderSource::Wgsl(DEPTH_GRADIENT.into()) });
    let pipeline = gpu.device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("depth gradient"),
        layout: None,
        vertex: wgpu::VertexState { module: &module, entry_point: Some("vs_main"), compilation_options: Default::default(), buffers: &[] },
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: Some(wgpu::DepthStencilState {
            format: genex_render::renderer::DEPTH_FORMAT,
            depth_write_enabled: Some(true),
            depth_compare: Some(wgpu::CompareFunction::Always),
            stencil: Default::default(),
            bias: Default::default(),
        }),
        multisample: wgpu::MultisampleState::default(),
        fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some("fs_main"), compilation_options: Default::default(), targets: &[] }),
        multiview_mask: None,
        cache: None,
    });
    let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("synthetic prepass") });
    {
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("synthetic prepass depth"),
            color_attachments: &[],
            depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                view: &depth,
                depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(1.0), store: wgpu::StoreOp::Store }),
                stencil_ops: None,
            }),
            ..Default::default()
        });
        pass.set_pipeline(&pipeline);
        pass.draw(0..3, 0..1);
    }
    let [x, y] = PREPASS_NORMAL;
    drop(encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some("synthetic prepass normals"),
        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
            view: &normals,
            depth_slice: None,
            resolve_target: None,
            ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color { r: x, g: y, b: 0.0, a: 0.0 }), store: wgpu::StoreOp::Store },
        })],
        ..Default::default()
    }));
    gpu.queue.submit([encoder.finish()]);
    PrepassViews { depth, normals }
}

/// A v2 probe: the depth at the pixel in red, the normal's first lane (clamped to 0..1) in green.
const PREPASS_PROBE_V2: &str = "
@group(0) @binding(3) var gx_depth: texture_depth_2d;
@group(0) @binding(4) var gx_normals: texture_2d<f32>;

struct VsOut { @builtin(position) position: vec4<f32> }

@vertex
fn vs_main(@builtin(vertex_index) i: u32) -> VsOut {
    let uv = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
    var out: VsOut;
    out.position = vec4<f32>(uv * 2.0 - 1.0, 0.0, 1.0);
    return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    let size = vec2<i32>(textureDimensions(gx_depth));
    let texel = min(vec2<i32>(in.position.xy), size - vec2<i32>(1));
    let depth = textureLoad(gx_depth, texel, 0);
    let normal = textureLoad(gx_normals, min(texel, vec2<i32>(textureDimensions(gx_normals)) - vec2<i32>(1)), 0).xy;
    return vec4<f32>(depth, clamp(normal.x, 0.0, 1.0), 0.0, 1.0);
}
";

/// A v2 pass at `post-hdr` drawing [`PREPASS_PROBE_V2`] over the scene target, declaring depth and
/// normals (or what [`PrepassProbe::declaring`] says).
struct PrepassProbe {
    pipeline: Option<wgpu::RenderPipeline>,
    inputs: genex_render::abi::RenderInputs,
}

impl Default for PrepassProbe {
    fn default() -> PrepassProbe {
        PrepassProbe::declaring(genex_render::abi::RenderInputs::DEPTH | genex_render::abi::RenderInputs::NORMALS)
    }
}

impl PrepassProbe {
    /// The probe declaring `inputs` (it binds depth and normals whatever it declares).
    fn declaring(inputs: genex_render::abi::RenderInputs) -> PrepassProbe {
        PrepassProbe { pipeline: None, inputs }
    }
}

impl CustomPass for PrepassProbe {
    fn rebuild(&mut self, setup: &mut PassSetup<'_>) -> Result<(), RenderError> {
        let module = setup.create_shader("prepass probe", PREPASS_PROBE_V2)?;
        let layout = setup.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("prepass probe"),
            bind_group_layouts: &[Some(setup.tables_layout())],
            immediate_size: 0,
        });
        let targets = [Some(wgpu::ColorTargetState { format: setup.world_format(), blend: None, write_mask: wgpu::ColorWrites::ALL })];
        self.pipeline = Some(setup.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("prepass probe"),
            layout: Some(&layout),
            vertex: wgpu::VertexState { module: &module, entry_point: Some("vs_main"), compilation_options: Default::default(), buffers: &[] },
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some("fs_main"), compilation_options: Default::default(), targets: &targets }),
            multiview_mask: None,
            cache: None,
        }));
        Ok(())
    }

    fn encode(&mut self, frame: &mut PassFrame<'_>) {
        let Some(pipeline) = self.pipeline.clone() else { return };
        let tables = frame.tables().clone();
        let Some(view) = frame.world_view().cloned() else { return };
        let Some(encoder) = frame.encoder() else { return };
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("prepass probe"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store },
            })],
            ..Default::default()
        });
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &tables, &[]);
        pass.draw(0..3, 0..1);
    }

    fn api(&self) -> u32 {
        2
    }

    fn inputs(&self) -> genex_render::abi::RenderInputs {
        self.inputs
    }
}

/// The BGRA bytes at (`x`, `y`).
fn bgra_at(capture: &Capture, x: u32, y: u32) -> [u8; 4] {
    let at = ((y * capture.width() + x) * 4) as usize;
    let p = &capture.bgra()[at..at + 4];
    [p[0], p[1], p[2], p[3]]
}

/// The red byte [`DEPTH_GRADIENT`] leaves at column `x`.
fn gradient_red(x: u32) -> u8 {
    ((f64::from(x) + 0.5) / 128.0 * 255.0).round() as u8
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_v2_tables_of_post_hdr_bind_the_prepass_targets_the_stage_was_handed() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = Renderer::new(&gpu, WIDTH, HEIGHT).expect("renderer");
    let mut passes = CustomPasses::new(&gpu, &renderer, wgpu::Features::empty());
    // Declaring nothing, the probe asks nothing of the renderer, so no prepass of the frame's own
    // replaces the targets handed to the stage below.
    let mut probe = PrepassProbe::declaring(genex_render::abi::RenderInputs::NONE);
    passes.register(&gpu, "probe", PassStage::PostHdr, &mut probe).expect("a v2 post-hdr pass");
    let prepass = synthetic_prepass(&gpu);
    let mut list: [&mut dyn CustomPass; 1] = [&mut probe];
    let mut run = passes.frame(&gpu, &mut list, 2).expect("frame passes");
    run.after_prepass(&prepass);
    render_scene(&mut renderer, &gpu, &base_scene(), CullPath::Gpu, &mut run).expect("frame");
    drop(run);
    assert!(passes.refusals().is_empty(), "{:?}", passes.refusals());
    assert_eq!(renderer.last_prepass(), None, "nobody asked the renderer for a prepass");
    let capture = renderer.capture(&gpu).expect("capture");
    for x in [3, 40, 100, 124] {
        let [_, g, r, _] = bgra_at(&capture, x, 36);
        assert!(r.abs_diff(gradient_red(x)) <= 2, "column {x}: gx_depth is the prepass depth ({r}, expected {})", gradient_red(x));
        assert!(g.abs_diff(128) <= 2, "column {x}: gx_normals is the prepass normals (green {g})");
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_v2_post_hdr_pass_declaring_depth_and_normals_reads_the_frames_own_prepass_in_render_scene() {
    use genex_render::prepass::PrepassConsumers;
    let Some(gpu) = gpu() else { return };
    let mut renderer = Renderer::new(&gpu, WIDTH, HEIGHT).expect("renderer");
    assert!(!renderer.quality().prepass, "the legacy quality's prepass switch is off");
    let mut passes = CustomPasses::new(&gpu, &renderer, wgpu::Features::empty());
    let mut probe = PrepassProbe::default();
    passes.register(&gpu, "probe", PassStage::PostHdr, &mut probe).expect("a v2 post-hdr pass reading depth and normals");
    let mut list: [&mut dyn CustomPass; 1] = [&mut probe];
    let mut run = passes.frame(&gpu, &mut list, 2).expect("frame passes");
    render_scene(&mut renderer, &gpu, &base_scene(), CullPath::Gpu, &mut run).expect("frame");
    drop(run);
    assert!(passes.refusals().is_empty(), "{:?}", passes.refusals());
    let ran = renderer.last_prepass().expect("the pass's declared inputs ran the prepass, whatever the switch says");
    assert!(ran.consumers.contains(PrepassConsumers::CUSTOM_PASS), "{:?}", ran.consumers.wires());
    // The probe writes the depth it reads into red (standard Z: the scene sits close to 1).
    let capture = renderer.capture(&gpu).expect("capture");
    let sky = bgra_at(&capture, 2, 1)[2];
    let nearest = (0..HEIGHT).flat_map(|y| (0..WIDTH).map(move |x| (x, y))).map(|(x, y)| bgra_at(&capture, x, y)[2]).min().unwrap_or(u8::MAX);
    assert_eq!(sky, u8::MAX, "the sky reads the far plane");
    assert!(nearest + 2 < sky, "gx_depth is the frame's prepass depth (nearest {nearest}), not the neutral far plane");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_passes_declaring_depth_or_registered_at_after_prepass_ask_for_the_prepass() {
    use genex_render::abi::RenderInputs;
    use genex_render::prepass::{PrepassConsumers, consumers};
    let Some(gpu) = gpu() else { return };
    let renderer = Renderer::new(&gpu, WIDTH, HEIGHT).expect("renderer");
    let quality = genex_render::Quality::off();
    let mut passes = CustomPasses::new(&gpu, &renderer, wgpu::Features::empty());
    let mut scanlines = Scanlines::default();
    passes.register(&gpu, "scanlines", PassStage::Post, &mut scanlines).expect("a v1 post pass");
    assert!(consumers(&quality, passes.prepass_demand(RenderInputs::NONE)).is_empty(), "a pass reading nothing asks for nothing");
    assert_eq!(
        consumers(&quality, passes.prepass_demand(RenderInputs::NORMALS)),
        PrepassConsumers::EXTENSION,
        "a Level-2 v2 source binding gx_normals asks"
    );
    let mut reads = Declares { api: 2, inputs: RenderInputs::DEPTH, rebuilt: false };
    passes.register(&gpu, "reads", PassStage::PostHdr, &mut reads).expect("a v2 pass declaring depth");
    let demand = passes.prepass_demand(RenderInputs::NONE);
    assert_eq!(demand.custom_inputs, RenderInputs::DEPTH);
    assert!(!demand.after_prepass);
    assert_eq!(consumers(&quality, demand), PrepassConsumers::CUSTOM_PASS, "inputs drive producers, with AO and TAA off");
}

/// Whether the game frame hands its depth/normal prepass to Level-3 passes (RQ4.1 records it,
/// RQ4.5 wires the frame renderer): the end-to-end rows below need it, and say so instead of
/// passing vacuously.
fn prepass_recorded() -> bool {
    let served = genex_render::prepass::LANDED && genex_render::custom_pass::PREPASS_SERVED;
    if !served {
        eprintln!("pending: the frame renderer does not hand the prepass to passes yet (custom_pass::PREPASS_SERVED, RQ4.5)");
    }
    served
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_an_after_prepass_pass_sampling_depth_sees_the_frames_prepass_depth() {
    if !prepass_recorded() {
        return;
    }
    let Some(gpu) = gpu() else { return };
    let mut renderer = FrameRenderer::new(&gpu, WIDTH, HEIGHT, RenderOptions::default()).expect("renderer");
    let mut passes = CustomPasses::new(&gpu, renderer.renderer(), wgpu::Features::empty());
    let readback = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("after-prepass readback"),
        size: 4,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let mut copy = DepthAtCentre::from(readback.clone());
    passes.register(&gpu, "depth-at-centre", PassStage::AfterPrepass, &mut copy).expect("after-prepass is served once the prepass lands");
    let _ = draw_with(&gpu, &mut renderer, &mut passes, &mut [&mut copy], 1);
    assert!(passes.refusals().is_empty(), "{:?}", passes.refusals());
    assert_eq!(copy.runs, 1, "the pass ran once, at graph node 9");
    let slice = readback.slice(..);
    slice.map_async(wgpu::MapMode::Read, |_| {});
    gpu.device.poll(wgpu::PollType::wait_indefinitely()).expect("poll");
    let depth = f32::from_le_bytes(slice.get_mapped_range().expect("mapped")[..4].try_into().expect("4 bytes"));
    assert!(depth > 0.0 && depth < 1.0, "the floor at the centre has a depth strictly between the planes ({depth})");
}

/// Copies the prepass depth at the centre texel into a buffer of its own (compute, at
/// `after-prepass`), then into the test's readback buffer.
#[derive(Default)]
struct DepthAtCentre {
    readback: Option<wgpu::Buffer>,
    pipeline: Option<wgpu::ComputePipeline>,
    out: Option<wgpu::Buffer>,
    group: Option<wgpu::BindGroup>,
    layout: Option<wgpu::BindGroupLayout>,
    runs: u32,
}

impl From<wgpu::Buffer> for DepthAtCentre {
    fn from(readback: wgpu::Buffer) -> DepthAtCentre {
        DepthAtCentre { readback: Some(readback), ..DepthAtCentre::default() }
    }
}

const DEPTH_AT_CENTRE: &str = "
@group(0) @binding(3) var gx_depth: texture_depth_2d;
@group(1) @binding(0) var<storage, read_write> out: array<f32>;

@compute @workgroup_size(1)
fn cs_main() {
    let size = vec2<i32>(textureDimensions(gx_depth));
    out[0] = textureLoad(gx_depth, size / 2, 0);
}
";

impl CustomPass for DepthAtCentre {
    fn rebuild(&mut self, setup: &mut PassSetup<'_>) -> Result<(), RenderError> {
        let module = setup.create_shader("depth at centre", DEPTH_AT_CENTRE)?;
        let own = setup.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("depth at centre"),
            entries: &[storage_entry(0, wgpu::ShaderStages::COMPUTE, false)],
        });
        let layout = setup.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("depth at centre"),
            bind_group_layouts: &[Some(setup.tables_layout()), Some(&own)],
            immediate_size: 0,
        });
        self.pipeline = Some(setup.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("depth at centre"),
            layout: Some(&layout),
            module: &module,
            entry_point: Some("cs_main"),
            compilation_options: Default::default(),
            cache: None,
        }));
        let out = setup.create_buffer(&wgpu::BufferDescriptor {
            label: Some("depth at centre"),
            size: 4,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        })?;
        self.group = Some(setup.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("depth at centre"),
            layout: &own,
            entries: &[wgpu::BindGroupEntry { binding: 0, resource: out.as_entire_binding() }],
        }));
        self.layout = Some(own);
        self.out = Some(out);
        Ok(())
    }

    fn encode(&mut self, frame: &mut PassFrame<'_>) {
        let (Some(pipeline), Some(group), Some(out), Some(readback)) = (&self.pipeline, &self.group, &self.out, &self.readback) else { return };
        assert!(frame.prepass_depth().is_some() && frame.prepass_normals().is_some(), "an after-prepass pass gets the prepass's views");
        let tables = frame.tables().clone();
        let Some(encoder) = frame.encoder() else { return };
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("depth at centre"), timestamp_writes: None });
            pass.set_pipeline(pipeline);
            pass.set_bind_group(0, &tables, &[]);
            pass.set_bind_group(1, group, &[]);
            pass.dispatch_workgroups(1, 1, 1);
        }
        encoder.copy_buffer_to_buffer(out, 0, readback, 0, 4);
        self.runs += 1;
    }

    fn api(&self) -> u32 {
        2
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_post_hdr_pass_declaring_depth_gets_the_prepass_depth_on_a_preset_with_ao_and_taa_off() {
    use genex_render::device_class::{DeviceClass, FormFactor, PerformanceTier};
    use genex_render::presets::preset_quality;
    use genex_render::settings::{AntiAliasing, AoResolution, QualityPreset};
    if !prepass_recorded() {
        return;
    }
    let Some(gpu) = gpu() else { return };
    let mut renderer = FrameRenderer::new(&gpu, WIDTH, HEIGHT, RenderOptions::default()).expect("renderer");
    let mut quality = preset_quality(QualityPreset::Medium, DeviceClass::new(FormFactor::Desktop, PerformanceTier::High));
    quality.ao.resolution = AoResolution::Off;
    quality.anti_aliasing = AntiAliasing::Msaa4;
    quality.contact_shadows = false;
    quality.hdr = false;
    renderer.renderer_mut().set_quality(&quality);
    let mut passes = CustomPasses::new(&gpu, renderer.renderer(), wgpu::Features::empty());
    passes.set_quality(quality);
    let mut probe = PrepassProbe::default();
    passes.register(&gpu, "probe", PassStage::PostHdr, &mut probe).expect("a v2 post-hdr pass declaring depth");
    let capture = draw_with(&gpu, &mut renderer, &mut passes, &mut [&mut probe], 1);
    assert!(passes.refusals().is_empty(), "{:?}", passes.refusals());
    // The probe writes the depth it reads into red. Standard Z (the LDR scene) packs the scene
    // close to 1, so the test is "nearer than the far plane", which the neutral depth never is.
    let sky = bgra_at(&capture, 2, 1)[2];
    let nearest = (0..HEIGHT).flat_map(|y| (0..WIDTH).map(move |x| (x, y))).map(|(x, y)| bgra_at(&capture, x, y)[2]).min().unwrap_or(u8::MAX);
    assert_eq!(sky, u8::MAX, "the sky reads the far plane");
    assert!(nearest + 2 < sky, "the scene's prepass depth is nearer than the far plane (nearest {nearest}): inputs drive producers");
}

/// The v2 post-hdr pass reading the sun's shadow cascades through the tables: the left quarter of
/// the target red with the sun's visibility under the red cube, the next quarter green with the
/// visibility out in the open (cascade 0, the comparison the sun chunk makes) and blue with
/// `cascade_splits.w` (1: the sun casts shadows this frame).
const SHADOW_READ_V2: &str = "
@group(0) @binding(0) var<uniform> gx_frame: GxFrameV2;
@group(0) @binding(9) var gx_shadow_map: texture_depth_2d_array;
@group(0) @binding(10) var gx_shadow_sampler: sampler_comparison;

struct VsOut { @builtin(position) position: vec4<f32> }

@vertex
fn vs_main(@builtin(vertex_index) i: u32) -> VsOut {
    let uv = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
    var out: VsOut;
    out.position = vec4<f32>(uv * 2.0 - 1.0, 0.0, 1.0);
    return out;
}

fn visibility(p: vec3<f32>) -> f32 {
    let clip = gx_frame.cascade_view_proj[0] * vec4<f32>(p + vec3<f32>(0.0, gx_frame.cascade_offsets.x, 0.0), 1.0);
    let ndc = clip.xyz / clip.w;
    let uv = vec2<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
    return textureSampleCompareLevel(gx_shadow_map, gx_shadow_sampler, uv, 0, ndc.z - gx_frame.shadow_params.x);
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    if in.position.x > 64.0 {
        discard;
    }
    if in.position.x < 32.0 {
        return vec4<f32>(visibility(vec3<f32>(-1.5, 0.0, 0.0)), 0.0, 0.0, 1.0);
    }
    return vec4<f32>(0.0, visibility(vec3<f32>(2.5, 0.0, 2.5)), gx_frame.cascade_splits.w, 1.0);
}
";

/// A v2 pass at `post-hdr` drawing [`SHADOW_READ_V2`].
#[derive(Default)]
struct ShadowReadV2 {
    pipeline: Option<wgpu::RenderPipeline>,
}

impl CustomPass for ShadowReadV2 {
    fn rebuild(&mut self, setup: &mut PassSetup<'_>) -> Result<(), RenderError> {
        let module = setup.create_shader("shadow read v2", SHADOW_READ_V2)?;
        let layout = setup.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("shadow read v2"),
            bind_group_layouts: &[Some(setup.tables_layout())],
            immediate_size: 0,
        });
        let targets = [Some(wgpu::ColorTargetState { format: setup.world_format(), blend: None, write_mask: wgpu::ColorWrites::ALL })];
        self.pipeline = Some(setup.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("shadow read v2"),
            layout: Some(&layout),
            vertex: wgpu::VertexState { module: &module, entry_point: Some("vs_main"), compilation_options: Default::default(), buffers: &[] },
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some("fs_main"), compilation_options: Default::default(), targets: &targets }),
            multiview_mask: None,
            cache: None,
        }));
        Ok(())
    }

    fn encode(&mut self, frame: &mut PassFrame<'_>) {
        let Some(pipeline) = self.pipeline.clone() else { return };
        let tables = frame.tables().clone();
        let Some(view) = frame.world_view().cloned() else { return };
        let Some(encoder) = frame.encoder() else { return };
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("shadow read v2"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store },
            })],
            ..Default::default()
        });
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &tables, &[]);
        pass.draw(0..3, 0..1);
    }

    fn api(&self) -> u32 {
        2
    }
}

/// Pass-1 gate finding 02 (RX.R4): Level-3 passes got no sun shadows, so the showcase's grass drew
/// sunlit under the deer and they seemed to float. The v2 tables carry the sun's shadow cascades
/// (`gx_shadow_map`, `gx_shadow_sampler`; the cascades' matrices, ends, offsets and bias are in
/// `GxFrameV2`), always bound: the frame's maps, or a lit neutral map on a frame without shadows.
#[test]
fn the_v2_tables_carry_the_suns_shadow_cascades() {
    use genex_render::abi::{BindingKind, RenderInputs};
    let row = |name: &str| TABLES_V2_BINDINGS.iter().find(|row| row.name == name).copied();
    let map = row("gx_shadow_map").expect("the cascades in the v2 tables");
    let sampler = row("gx_shadow_sampler").expect("their comparison sampler");
    assert_eq!((map.binding, map.kind, map.input), (9, BindingKind::DepthArray, RenderInputs::NONE));
    assert_eq!((sampler.binding, sampler.kind, sampler.input), (10, BindingKind::ComparisonSampler, RenderInputs::NONE));
}

/// The same through a pass: a v2 post-hdr pass reads the sun's visibility from the tables, dark
/// under a cube and lit in the open.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_v2_pass_reads_the_suns_shadow_cascades_from_its_tables() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = Renderer::new(&gpu, WIDTH, HEIGHT).expect("renderer");
    let mut passes = CustomPasses::new(&gpu, &renderer, wgpu::Features::empty());
    let mut read = ShadowReadV2::default();
    passes.register(&gpu, "shadow-read", PassStage::PostHdr, &mut read).expect("a v2 pass reading the shadow cascades");
    let mut scene = base_scene();
    scene.lighting.sun_dir = [0.05, 1.0, 0.02];
    let mut list: [&mut dyn CustomPass; 1] = [&mut read];
    let mut run = passes.frame(&gpu, &mut list, 4).expect("frame passes");
    render_scene(&mut renderer, &gpu, &scene, CullPath::Gpu, &mut run).expect("frame");
    drop(run);
    assert!(passes.refusals().is_empty(), "{:?}", passes.refusals());
    let capture = renderer.capture(&gpu).expect("capture");
    let pixel = |x: usize| capture.bgra()[(10 * WIDTH as usize + x) * 4..][..4].to_vec();
    let (under, open) = (pixel(10), pixel(40));
    assert!(under[2] < 30, "under the cube the sun is hidden: BGRA {under:?}");
    assert!(open[1] > 200, "in the open the sun is seen: BGRA {open:?}");
    assert!(open[0] > 200, "the pass's frame says the sun casts shadows: BGRA {open:?}");
}
