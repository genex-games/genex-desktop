//! Renderer pass 2, B.7: Level-3 in-world geometry under TAA. A pass that moves what it draws (a
//! vertex animation swaying in the shared wind, a glow sprite flying over the scene) used to keep
//! the motion of what the prepass drew behind it, so TAA trailed or popped it (the Lakeside's
//! grass tips and firefly halos). A pass now draws its own motion
//! (`PassFrame::motion_draws`, evaluated at `PassFrame::prev_tick` too) and its reactive coverage
//! (`PassFrame::reactive_draws`) into graph node 15a.
//!
//! The CPU rows run everywhere. The GPU rows are `#[ignore]`d and every name contains `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked --test custom_pass_motion -- --ignored metal

use genex_render::custom_pass::{CustomPass, CustomPasses, PassFrame, PassSetup, PassStage, PipelineFacts, TABLES_V2_WGSL, validate_pass_wgsl_api};
use genex_render::device_class::{DeviceClass, FormFactor, PerformanceTier};
use genex_render::extension::ExtensionContext;
use genex_render::immediate::{FrameRenderer, ImmediateFrame};
use genex_render::scene::{CameraDesc, MeshId, scaled};
use genex_render::settings::{AntiAliasing, Quality, SceneFormat};
use genex_render::wind::wind;
use genex_render::{CullPath, Gpu, RenderError, RenderOptions};

const WIDTH: u32 = 160;
const HEIGHT: u32 = 96;
/// Simulated seconds per tick (the facade's fixed step).
const TICK_SECONDS: f32 = 1.0 / 60.0;
/// How far the swaying quad leans per unit of gust away from its mean, world units: about two
/// pixels a tick at this camera, far more than the half-precision motion target resolves.
const SWAY_AMPLITUDE: f32 = 6.0;
/// The glow sprite's speed, world units a second (about three pixels a frame).
const GLOW_SPEED: f32 = 6.0;
/// The reactive coverage the glow writes over itself.
const GLOW_COVERAGE: f32 = 0.9;

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

fn camera() -> CameraDesc {
    CameraDesc::look_at([0.0, 0.0, 4.0], [0.0, 0.0, 0.0])
}

/// The HDR scene under TAA at the reference class, nothing else keeping history.
fn taa_quality() -> Quality {
    let mut quality = Quality::off();
    quality.hdr = true;
    quality.tonemap = true;
    quality.prepass = true;
    quality.anti_aliasing = AntiAliasing::Taa;
    quality
}

/// A grey wall behind everything (the prepass draws it; its motion is zero under a still camera).
fn frame_at(tick: u64) -> ImmediateFrame {
    let mut frame = ImmediateFrame::new(camera(), [10, 12, 16, 255]);
    frame.mesh(MeshId::CUBE, scaled([0.0, 0.0, -2.0], [20.0, 20.0, 0.1]), genex_render::scene::Material::color([90, 90, 96, 255]));
    frame.set_tick(tick);
    frame
}

// ---------------------------------------------------------------------------------------------
// The passes

/// A quad swaying in the shared wind (`gx_wind`) and a glow square flying along +x; `params.w`
/// picks which (0 sway, 1 glow). Each has a world, a motion and a reactive entry point.
const PASS_WGSL: &str = "
@group(0) @binding(0) var<uniform> gx_frame: GxFrameV2;
// x: this tick's seconds; y: the previous frame's; z: the amplitude or speed; w: 0 sway, 1 glow.
@group(1) @binding(0) var<uniform> params: vec4<f32>;

struct Out {
    @builtin(position) @invariant clip: vec4<f32>,
    @location(0) now: vec4<f32>,
    @location(1) before: vec4<f32>,
}

fn corner(i: u32) -> vec2<f32> {
    let corners = array<vec2<f32>, 6>(vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, 1.0));
    return corners[i];
}

// Where corner `i` is `t` seconds in.
fn place(i: u32, t: f32) -> vec3<f32> {
    let c = corner(i);
    if params.w > 0.5 {
        return vec3<f32>(c * 0.12 + vec2<f32>(-2.0 + params.z * t, 0.0), 0.5);
    }
    let lean = params.z * (gx_wind(vec3<f32>(0.0), t).gust - 0.5);
    return vec3<f32>(c.x * 0.5 + lean, c.y * 0.5, 0.0);
}

@vertex
fn vs_main(@builtin(vertex_index) i: u32) -> Out {
    let p = place(i, params.x);
    var out: Out;
    out.clip = gx_frame.view_proj * vec4<f32>(p, 1.0);
    out.now = gx_frame.unjittered_view_proj * vec4<f32>(p, 1.0);
    out.before = gx_frame.prev_view_proj * vec4<f32>(place(i, params.y), 1.0);
    return out;
}

@fragment
fn fs_world(in: Out) -> @location(0) vec4<f32> {
    return vec4<f32>(vec3<f32>(select(0.6, 8.0, params.w > 0.5)) * gx_frame.pre_exposure, 1.0);
}

@fragment
fn fs_motion(in: Out) -> @location(0) vec4<f32> {
    return vec4<f32>(in.now.xy / in.now.w - in.before.xy / in.before.w, 0.0, 1.0);
}

@fragment
fn fs_reactive(in: Out) -> @location(0) vec4<f32> {
    return vec4<f32>(0.9, 0.0, 0.0, 1.0);
}
";

/// Which of [`PASS_WGSL`]'s shapes a [`Mover`] draws.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Shape {
    /// The quad swaying in the wind (opaque, at `after-opaque`).
    Sway,
    /// The glow square flying along +x (additive, at `after-transparent`).
    Glow,
}

/// One of the moving shapes, drawing its motion and reactive coverage when `temporal` says so.
struct Mover {
    shape: Shape,
    temporal: bool,
    resources: Option<(wgpu::Buffer, wgpu::BindGroup, [wgpu::RenderPipeline; 3])>,
}

impl Mover {
    fn new(shape: Shape, temporal: bool) -> Mover {
        Mover { shape, temporal, resources: None }
    }
}

impl CustomPass for Mover {
    fn rebuild(&mut self, setup: &mut PassSetup<'_>) -> Result<(), RenderError> {
        let module = setup.create_shader("mover", PASS_WGSL)?;
        let params = setup.create_buffer(&wgpu::BufferDescriptor {
            label: Some("mover params"),
            size: 16,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        })?;
        let entry = wgpu::BindGroupLayoutEntry {
            binding: 0,
            visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
            ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None },
            count: None,
        };
        let layout = setup.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("mover"), entries: &[entry] });
        let group = setup.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("mover"),
            layout: &layout,
            entries: &[wgpu::BindGroupEntry { binding: 0, resource: params.as_entire_binding() }],
        });
        let pipeline_layout =
            setup.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("mover"), bind_group_layouts: &[Some(setup.tables_layout()), Some(&layout)], immediate_size: 0 });
        let additive = wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, dst_factor: wgpu::BlendFactor::One, operation: wgpu::BlendOperation::Add };
        let world_blend = (self.shape == Shape::Glow).then_some(wgpu::BlendState { color: additive, alpha: additive });
        let world_target = wgpu::ColorTargetState { format: setup.world_format(), blend: world_blend, write_mask: wgpu::ColorWrites::ALL };
        let pipeline = |fragment: &str, target: wgpu::ColorTargetState, depth: wgpu::DepthStencilState, multisample: wgpu::MultisampleState| {
            setup.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(fragment),
                layout: Some(&pipeline_layout),
                vertex: wgpu::VertexState { module: &module, entry_point: Some("vs_main"), compilation_options: Default::default(), buffers: &[] },
                primitive: wgpu::PrimitiveState { cull_mode: None, ..Default::default() },
                depth_stencil: Some(depth),
                multisample,
                fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some(fragment), compilation_options: Default::default(), targets: &[Some(target)] }),
                multiview_mask: None,
                cache: None,
            })
        };
        let opaque = self.shape == Shape::Sway;
        let pipelines = [
            pipeline("fs_world", world_target, setup.world_depth(opaque), setup.world_multisample()),
            pipeline("fs_motion", setup.motion_target(), setup.temporal_depth(true), setup.temporal_multisample()),
            pipeline("fs_reactive", setup.reactive_target(), setup.temporal_depth(false), setup.temporal_multisample()),
        ];
        self.resources = Some((params, group, pipelines));
        Ok(())
    }

    fn encode(&mut self, frame: &mut PassFrame<'_>) {
        let Some((params, group, [world, motion, reactive])) = &self.resources else { return };
        let (amount, kind) = match self.shape {
            Shape::Sway => (SWAY_AMPLITUDE, 0.0),
            Shape::Glow => (GLOW_SPEED, 1.0),
        };
        let now = frame.tick() as f32 * TICK_SECONDS;
        let before = frame.prev_tick() as f32 * TICK_SECONDS;
        let bytes: Vec<u8> = [now, before, amount, kind].iter().flat_map(|v| v.to_le_bytes()).collect();
        frame.write_buffer(params, 0, &bytes).expect("params");
        if let Some(draws) = frame.draws() {
            draws.set_pipeline(world).bind_tables(0).set_bind_group(1, group, &[]).draw(0..6, 0..1);
        }
        if !self.temporal {
            return;
        }
        match self.shape {
            Shape::Sway => {
                if let Some(draws) = frame.motion_draws() {
                    draws.set_pipeline(motion).bind_tables(0).set_bind_group(1, group, &[]).draw(0..6, 0..1);
                }
            }
            Shape::Glow => {
                if let Some(draws) = frame.reactive_draws() {
                    draws.set_pipeline(reactive).bind_tables(0).set_bind_group(1, group, &[]).draw(0..6, 0..1);
                }
            }
        }
    }

    fn api(&self) -> u32 {
        2
    }
}

/// A TAA frame renderer and its passes with `mover` registered at its stage.
fn setup(gpu: &Gpu, mover: &mut Mover) -> (FrameRenderer, CustomPasses) {
    let mut renderer = FrameRenderer::new(gpu, WIDTH, HEIGHT, RenderOptions { msaa: false }).expect("renderer");
    let quality = taa_quality();
    renderer.renderer_mut().set_scene_format(SceneFormat::Rgba16Float);
    renderer.renderer_mut().set_device_class(DeviceClass::new(FormFactor::Desktop, PerformanceTier::High));
    renderer.renderer_mut().set_quality(&quality);
    renderer.renderer_mut().set_depth_readback(true);
    let mut passes = CustomPasses::new(gpu, renderer.renderer(), wgpu::Features::empty());
    passes.set_quality(quality);
    let facts = PipelineFacts::for_scene(&renderer.renderer().next_scene(None), 1);
    passes.set_pipeline_facts(gpu, &mut [], facts).expect("facts");
    let stage = if mover.shape == Shape::Sway { PassStage::AfterOpaque } else { PassStage::AfterTransparent };
    passes.register(gpu, "mover", stage, mover).expect("admitted");
    (renderer, passes)
}

/// Draw ticks `ticks`, one frame each.
fn draw(gpu: &Gpu, renderer: &mut FrameRenderer, passes: &mut CustomPasses, mover: &mut Mover, ticks: std::ops::Range<u64>) {
    for tick in ticks {
        let mut list: [&mut dyn CustomPass; 1] = [mover];
        let mut run = passes.frame(gpu, &mut list, tick).expect("frame passes");
        renderer.render_with(gpu, &frame_at(tick), CullPath::Gpu, None, &mut run).expect("frame");
    }
    assert!(passes.refusals().is_empty(), "{:?}", passes.refusals());
}

/// The NDC x of the swaying quad's centre `t` seconds in (the CPU twin of `place`).
fn sway_ndc_x(t: f32) -> f32 {
    let lean = SWAY_AMPLITUDE * (wind([0.0; 3], t).gust - 0.5);
    let clip = camera().view_proj_reversed(WIDTH as f32 / HEIGHT as f32) * glam::Vec4::new(lean, 0.0, 0.0, 1.0);
    clip.x / clip.w
}

/// The pixel (x, y) of NDC (x, 0).
fn pixel_of(ndc_x: f32) -> (usize, usize) {
    (((ndc_x * 0.5 + 0.5) * WIDTH as f32) as usize, (HEIGHT / 2) as usize)
}

// ---------------------------------------------------------------------------------------------
// CPU rows

#[test]
fn the_v2_tables_declare_the_shared_wind_and_a_pass_using_it_is_admitted() {
    assert!(TABLES_V2_WGSL.contains("fn gx_wind("), "the shared wind is in the v2 prelude");
    let context = ExtensionContext::core();
    validate_pass_wgsl_api("mover", 2, PASS_WGSL, &context).expect("a v2 pass evaluating gx_wind at two times validates");
}

// ---------------------------------------------------------------------------------------------
// GPU rows

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_level_3_pass_swaying_in_the_wind_draws_its_own_motion() {
    let Some(gpu) = gpu() else { return };
    let mut mover = Mover::new(Shape::Sway, true);
    let (mut renderer, mut passes) = setup(&gpu, &mut mover);
    let ticks = 100..112;
    draw(&gpu, &mut renderer, &mut passes, &mut mover, ticks.clone());
    let motion = renderer.renderer().read_motion(&gpu).expect("motion");
    let (now, before) = (ticks.end - 1, ticks.end - 2);
    let expected = sway_ndc_x(now as f32 * TICK_SECONDS) - sway_ndc_x(before as f32 * TICK_SECONDS);
    let (x, y) = pixel_of(sway_ndc_x(now as f32 * TICK_SECONDS));
    let at = motion[y * WIDTH as usize + x];
    eprintln!("sway motion at ({x}, {y}): {at:?}, expected x {expected}");
    assert!(expected.abs() > 0.01, "the quad moves about a pixel a tick or more ({expected})");
    assert!((at[0] - expected).abs() <= expected.abs() * 0.05 + 2e-3, "the quad's own motion: {at:?} against {expected}");
    assert!(at[1].abs() < 2e-3, "it sways along x only: {at:?}");
    let wall = motion[(HEIGHT as usize / 2) * WIDTH as usize + 4];
    assert!(wall[0].abs() < 1e-3 && wall[1].abs() < 1e-3, "the still wall beside it keeps zero motion: {wall:?}");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_settled_capture_s_re_renders_give_the_swaying_pass_no_motion_of_its_own() {
    let Some(gpu) = gpu() else { return };
    let mut mover = Mover::new(Shape::Sway, true);
    let (mut renderer, mut passes) = setup(&gpu, &mut mover);
    draw(&gpu, &mut renderer, &mut passes, &mut mover, 100..104);
    // The same tick drawn again: the previous frame showed it too, so nothing moved.
    draw(&gpu, &mut renderer, &mut passes, &mut mover, 103..104);
    let motion = renderer.renderer().read_motion(&gpu).expect("motion");
    let (x, y) = pixel_of(sway_ndc_x(103.0 * TICK_SECONDS));
    let at = motion[y * WIDTH as usize + x];
    assert!(at[0].abs() < 1e-3 && at[1].abs() < 1e-3, "one tick shown twice has no sway motion: {at:?}");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_moving_level_3_glow_writes_its_reactive_coverage() {
    let Some(gpu) = gpu() else { return };
    let mut mover = Mover::new(Shape::Glow, true);
    let (mut renderer, mut passes) = setup(&gpu, &mut mover);
    let ticks = 10..20;
    draw(&gpu, &mut renderer, &mut passes, &mut mover, ticks.clone());
    let reactive = renderer.renderer().read_reactive(&gpu).expect("reactive");
    let x_world = -2.0 + GLOW_SPEED * (ticks.end - 1) as f32 * TICK_SECONDS;
    let clip = camera().view_proj_reversed(WIDTH as f32 / HEIGHT as f32) * glam::Vec4::new(x_world, 0.0, 0.5, 1.0);
    let (x, y) = pixel_of(clip.x / clip.w);
    let at = reactive[y * WIDTH as usize + x];
    let away = reactive[(HEIGHT as usize / 2) * WIDTH as usize + 4];
    eprintln!("glow reactive at ({x}, {y}): {at}, beside it {away}");
    assert!((at - GLOW_COVERAGE).abs() < 0.01, "the glow's own coverage takes the current sample: {at}");
    assert!(away < 0.01, "the wall beside it keeps its history: {away}");
}
