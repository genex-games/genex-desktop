//! Level-3 in-world replay under deferred error scopes (renderer pass 2, RC-11): a pass proven
//! once is replayed into the world pass while its later proofs are still pending (the web's mode),
//! so a pass whose draws go bad after its first clean proof must never reach the world pass. What
//! the CPU can check (index and indirect ranges, buffer usages and alignment) refuses the pass at
//! once; anything wider than a proven frame's draws (more vertices or instances, a smaller vertex
//! slice, another pipeline) waits for its own proof.
//!
//! The GPU rows are `#[ignore]`d and every name contains `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked --test custom_pass_replay -- --ignored metal

use std::cell::Cell;
use std::rc::Rc;

use genex_render::capture::Capture;
use genex_render::custom_pass::{CustomPass, CustomPasses, PassFrame, PassSetup, PassStage, ScopeMode, WorldDraws};
use genex_render::immediate::{FrameRenderer, ImmediateFrame};
use genex_render::scene::{CameraDesc, MeshId, scaled, translation};
use genex_render::{CullPath, Gpu, RenderCode, RenderError, RenderOptions};

const WIDTH: u32 = 128;
const HEIGHT: u32 = 72;
/// Vertices (and indices) the pass's buffers hold: one triangle.
const VERTICES: u32 = 3;
/// Bytes of one vertex: a `vec2<f32>`.
const VERTEX_STRIDE: u64 = 8;
/// Bytes of one indirect draw's arguments.
const INDIRECT_BYTES: u64 = 16;

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

fn base_frame() -> ImmediateFrame {
    let mut frame = ImmediateFrame::new(CameraDesc::look_at([0.0, 3.0, 8.0], [0.0, 0.5, 0.0]), [20, 24, 32, 255]);
    frame.mesh(MeshId::CUBE, scaled([0.0, -0.05, 0.0], [8.0, 0.1, 8.0]), genex_render::scene::Material::color([110, 110, 120, 255]));
    frame.cube(translation(-1.5, 0.5, 0.0), [200, 60, 50, 255]);
    frame
}

/// What the pass draws this frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Turn {
    /// Its triangle: the vertex buffer's three vertices.
    Triangle,
    /// The same triangle through its index buffer.
    Indexed,
    /// Six vertices from a three-vertex buffer (WebGPU refuses the draw; the CPU cannot tell
    /// without the pipeline's stride).
    PastVertices,
    /// Six indices from a three-index buffer.
    PastIndices,
    /// Indirect arguments read past the end of their buffer.
    PastIndirect,
    /// A draw with no pipeline set.
    NoPipeline,
}

/// The vertex shader reads one `vec2<f32>` per vertex: a triangle beside the scene's cube.
const TRIANGLE: &str = "
struct VsOut { @builtin(position) clip: vec4<f32> }

@group(0) @binding(0) var<uniform> gx_frame: GxFrame;

@vertex
fn vs_main(@location(0) corner: vec2<f32>) -> VsOut {
    var out: VsOut;
    out.clip = gx_frame.view_proj * vec4<f32>(corner.x + 2.0, corner.y, 1.5, 1.0);
    return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    return vec4<f32>(0.9, 0.8, 0.1, 1.0);
}
";

struct Built {
    pipeline: wgpu::RenderPipeline,
    vertices: wgpu::Buffer,
    indices: wgpu::Buffer,
    indirect: wgpu::Buffer,
}

/// An in-world pass that draws what `turn` says.
struct Turns {
    turn: Rc<Cell<Turn>>,
    built: Option<Built>,
}

impl CustomPass for Turns {
    fn rebuild(&mut self, setup: &mut PassSetup<'_>) -> Result<(), RenderError> {
        let module = setup.create_shader("turns", TRIANGLE)?;
        let layout = setup.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("turns"),
            bind_group_layouts: &[Some(setup.tables_layout())],
            immediate_size: 0,
        });
        let targets = [Some(wgpu::ColorTargetState { format: setup.world_format(), blend: None, write_mask: wgpu::ColorWrites::ALL })];
        let attributes = wgpu::vertex_attr_array![0 => Float32x2];
        let buffers = [Some(wgpu::VertexBufferLayout { array_stride: VERTEX_STRIDE, step_mode: wgpu::VertexStepMode::Vertex, attributes: &attributes })];
        let pipeline = setup.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("turns"),
            layout: Some(&layout),
            vertex: wgpu::VertexState { module: &module, entry_point: Some("vs_main"), compilation_options: Default::default(), buffers: &buffers },
            primitive: wgpu::PrimitiveState { cull_mode: None, ..Default::default() },
            depth_stencil: Some(setup.world_depth(true)),
            multisample: setup.world_multisample(),
            fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some("fs_main"), compilation_options: Default::default(), targets: &targets }),
            multiview_mask: None,
            cache: None,
        });
        let corners: [f32; 6] = [-0.8, 0.0, 0.8, 0.0, 0.0, 1.4];
        let corner_bytes: Vec<u8> = corners.iter().flat_map(|c| c.to_le_bytes()).collect();
        let vertices = setup.create_buffer_init("turns vertices", &corner_bytes, wgpu::BufferUsages::VERTEX)?;
        let index_bytes: Vec<u8> = (0..VERTICES).flat_map(u32::to_le_bytes).collect();
        let indices = setup.create_buffer_init("turns indices", &index_bytes, wgpu::BufferUsages::INDEX)?;
        let arguments: Vec<u8> = [VERTICES, 1, 0, 0].iter().flat_map(|v| v.to_le_bytes()).collect();
        let indirect = setup.create_buffer_init("turns indirect", &arguments, wgpu::BufferUsages::INDIRECT)?;
        self.built = Some(Built { pipeline, vertices, indices, indirect });
        Ok(())
    }

    fn encode(&mut self, frame: &mut PassFrame<'_>) {
        let Some(built) = &self.built else { return };
        let Some(draws) = frame.draws() else { return };
        let turn = self.turn.get();
        if turn != Turn::NoPipeline {
            draws.set_pipeline(&built.pipeline);
        }
        draws.bind_tables(0);
        draws.set_vertex_buffer(0, &built.vertices, ..);
        match turn {
            Turn::Triangle => {
                draws.draw(0..VERTICES, 0..1);
            }
            Turn::Indexed => {
                draws.set_index_buffer(&built.indices, wgpu::IndexFormat::Uint32, ..);
                draws.draw_indexed(0..VERTICES, 0, 0..1);
            }
            Turn::PastVertices | Turn::NoPipeline => {
                draws.draw(0..VERTICES * 2, 0..1);
            }
            Turn::PastIndices => {
                draws.set_index_buffer(&built.indices, wgpu::IndexFormat::Uint32, ..);
                draws.draw_indexed(0..VERTICES * 2, 0, 0..1);
            }
            Turn::PastIndirect => {
                draws.draw_indirect(&built.indirect, INDIRECT_BYTES);
            }
        }
    }
}

/// Draw one frame of `base_frame` with `pass` at `tick` inside a validation scope: the capture and
/// the validation error the frame raised, if any.
fn scoped_frame(gpu: &Gpu, renderer: &mut FrameRenderer, passes: &mut CustomPasses, pass: &mut Turns, tick: u64) -> (Capture, Option<String>) {
    let scope = gpu.device.push_error_scope(wgpu::ErrorFilter::Validation);
    {
        let mut list: [&mut dyn CustomPass; 1] = [pass];
        let mut run = passes.frame(gpu, &mut list, tick).expect("frame passes");
        renderer.render_with(gpu, &base_frame(), CullPath::Gpu, None, &mut run).expect("the frame draws");
    }
    let error = pollster::block_on(scope.pop()).map(|error| error.to_string());
    (renderer.capture(gpu).expect("capture"), error)
}

/// A deferred-scope registry holding `pass`, drawn until the pass is proven: one frame on
/// probation, its scopes settled, one frame replayed. Answers the plain frame and the frame with
/// the pass drawn.
fn proven(gpu: &Gpu, renderer: &mut FrameRenderer, passes: &mut CustomPasses, pass: &mut Turns) -> (Capture, Capture) {
    passes.set_scope_mode(ScopeMode::Deferred);
    passes.register(gpu, "turns", PassStage::AfterOpaque, pass).expect("admitted");
    let (plain, error) = scoped_frame(gpu, renderer, passes, pass, 1);
    assert_eq!(error, None, "probation frame");
    let settled = pollster::block_on(passes.take_pending().settle());
    assert!(passes.apply_settled(settled), "the first clean proof admits the pass");
    let (drawn, error) = scoped_frame(gpu, renderer, passes, pass, 2);
    assert_eq!(error, None, "a proven pass's valid draws");
    assert_ne!(drawn.digest(), plain.digest(), "the proven pass draws its triangle");
    (plain, drawn)
}

/// A row's device, renderer, deferred registry, pass and the switch that turns the pass.
type Rig = (Gpu, FrameRenderer, CustomPasses, Turns, Rc<Cell<Turn>>);

fn setup(turn: Turn) -> Option<Rig> {
    let gpu = gpu()?;
    let renderer = FrameRenderer::new(&gpu, WIDTH, HEIGHT, RenderOptions::default()).expect("renderer");
    let passes = CustomPasses::new(&gpu, renderer.renderer(), wgpu::Features::empty());
    let cell = Rc::new(Cell::new(turn));
    let pass = Turns { turn: Rc::clone(&cell), built: None };
    Some((gpu, renderer, passes, pass, cell))
}

fn assert_refused(passes: &mut CustomPasses) {
    let refusals = passes.take_refusals();
    assert_eq!(refusals.len(), 1, "{refusals:?}");
    assert_eq!(refusals[0].code(), RenderCode::GpuPassInvalid, "{}", refusals[0]);
    assert!(refusals[0].to_string().contains("`turns`"), "the refusal names the pass: {}", refusals[0]);
    assert!(!passes.is_enabled("turns"), "a refused pass stops running");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_proven_pass_whose_indexed_draw_runs_past_its_index_buffer_is_refused_at_once_and_never_reaches_the_world_pass() {
    let Some((gpu, mut renderer, mut passes, mut pass, turn)) = setup(Turn::Indexed) else { return };
    let (plain, _) = proven(&gpu, &mut renderer, &mut passes, &mut pass);
    turn.set(Turn::PastIndices);
    let (bad, error) = scoped_frame(&gpu, &mut renderer, &mut passes, &mut pass, 3);
    assert_eq!(error, None, "the world pass stays valid");
    assert_refused(&mut passes);
    assert_eq!(bad.digest(), plain.digest(), "nothing of the refused pass is drawn");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_proven_pass_whose_indirect_arguments_run_past_their_buffer_is_refused_at_once() {
    let Some((gpu, mut renderer, mut passes, mut pass, turn)) = setup(Turn::Triangle) else { return };
    let (plain, _) = proven(&gpu, &mut renderer, &mut passes, &mut pass);
    turn.set(Turn::PastIndirect);
    let (bad, error) = scoped_frame(&gpu, &mut renderer, &mut passes, &mut pass, 3);
    assert_eq!(error, None, "the world pass stays valid");
    assert_refused(&mut passes);
    assert_eq!(bad.digest(), plain.digest());
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_proven_pass_drawing_more_vertices_than_any_proven_frame_waits_for_its_own_proof_and_is_refused_by_it() {
    let Some((gpu, mut renderer, mut passes, mut pass, turn)) = setup(Turn::Triangle) else { return };
    let (plain, _) = proven(&gpu, &mut renderer, &mut passes, &mut pass);
    turn.set(Turn::PastVertices);
    let (held, error) = scoped_frame(&gpu, &mut renderer, &mut passes, &mut pass, 3);
    assert_eq!(error, None, "the world pass stays valid");
    assert!(passes.take_refusals().is_empty(), "wgpu's answer is still pending");
    assert_eq!(held.digest(), plain.digest(), "draws wider than every proven frame's are held out");
    let settled = pollster::block_on(passes.take_pending().settle());
    assert!(passes.apply_settled(settled), "the pending proof refuses it");
    assert_refused(&mut passes);
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_proven_pass_that_drops_its_pipeline_waits_for_its_own_proof() {
    let Some((gpu, mut renderer, mut passes, mut pass, turn)) = setup(Turn::Triangle) else { return };
    let (plain, _) = proven(&gpu, &mut renderer, &mut passes, &mut pass);
    turn.set(Turn::NoPipeline);
    let (held, error) = scoped_frame(&gpu, &mut renderer, &mut passes, &mut pass, 3);
    assert_eq!(error, None, "the world pass stays valid");
    assert_eq!(held.digest(), plain.digest());
    let settled = pollster::block_on(passes.take_pending().settle());
    passes.apply_settled(settled);
    assert_refused(&mut passes);
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_proven_pass_drawing_within_a_proven_frame_keeps_drawing_while_its_proof_is_pending() {
    let Some((gpu, mut renderer, mut passes, mut pass, _turn)) = setup(Turn::Triangle) else { return };
    let (_, drawn) = proven(&gpu, &mut renderer, &mut passes, &mut pass);
    for tick in 3..6 {
        let (again, error) = scoped_frame(&gpu, &mut renderer, &mut passes, &mut pass, tick);
        assert_eq!(error, None);
        assert_eq!(again.digest(), drawn.digest(), "tick {tick}: the pass keeps drawing between proofs");
    }
    assert!(passes.take_refusals().is_empty());
}

/// One hostile command list: its name and how it records against the pass's own buffers.
type Hostile = (&'static str, fn(&mut WorldDraws, &Built));

/// Command lists the CPU refuses as they are recorded, each after a valid pipeline and tables.
const HOSTILE: &[Hostile] = &[
    ("vertex buffer without VERTEX usage", |draws, built| {
        draws.set_vertex_buffer(0, &built.indices, ..).draw(0..VERTICES, 0..1);
    }),
    ("vertex offset not a multiple of 4", |draws, built| {
        draws.set_vertex_buffer(0, &built.vertices, 2..).draw(0..1, 0..1);
    }),
    ("vertex slot past the core limit", |draws, built| {
        draws.set_vertex_buffer(8, &built.vertices, ..).draw(0..VERTICES, 0..1);
    }),
    ("bind group index past the core limit", |draws, _| {
        draws.bind_tables(4);
    }),
    ("an inverted vertex range", |draws, built| {
        #[allow(clippy::reversed_empty_ranges, reason = "the hostile input under test")]
        draws.set_vertex_buffer(0, &built.vertices, ..).draw(3..0, 0..1);
    }),
    ("index buffer without INDEX usage", |draws, built| {
        draws.set_vertex_buffer(0, &built.vertices, ..).set_index_buffer(&built.vertices, wgpu::IndexFormat::Uint32, ..).draw_indexed(0..1, 0, 0..1);
    }),
    ("index offset not a multiple of the index size", |draws, built| {
        draws.set_vertex_buffer(0, &built.vertices, ..).set_index_buffer(&built.indices, wgpu::IndexFormat::Uint32, 2..).draw_indexed(0..1, 0, 0..1);
    }),
    ("an indexed draw with no index buffer of its own", |draws, built| {
        draws.set_vertex_buffer(0, &built.vertices, ..).draw_indexed(0..VERTICES, 0, 0..1);
    }),
    ("an indexed indirect draw with no index buffer of its own", |draws, built| {
        draws.set_vertex_buffer(0, &built.vertices, ..).draw_indexed_indirect(&built.indirect, 0);
    }),
    ("indirect arguments without INDIRECT usage", |draws, built| {
        draws.set_vertex_buffer(0, &built.vertices, ..).draw_indirect(&built.vertices, 0);
    }),
    ("an indirect offset not a multiple of 4", |draws, built| {
        draws.set_vertex_buffer(0, &built.vertices, ..).draw_indirect(&built.indirect, 2);
    }),
];

/// A pass recording one hostile command list after its pipeline and tables.
struct HostilePass {
    turns: Turns,
    record: fn(&mut WorldDraws, &Built),
}

impl CustomPass for HostilePass {
    fn rebuild(&mut self, setup: &mut PassSetup<'_>) -> Result<(), RenderError> {
        self.turns.rebuild(setup)
    }

    fn encode(&mut self, frame: &mut PassFrame<'_>) {
        let Some(built) = &self.turns.built else { return };
        let Some(draws) = frame.draws() else { return };
        draws.set_pipeline(&built.pipeline).bind_tables(0);
        (self.record)(draws, built);
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_hostile_in_world_commands_are_refused_on_the_cpu_before_any_proof_or_replay() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = FrameRenderer::new(&gpu, WIDTH, HEIGHT, RenderOptions::default()).expect("renderer");
    renderer.render(&gpu, &base_frame(), CullPath::Gpu, None).expect("frame");
    let plain = renderer.capture(&gpu).expect("capture");
    for (name, record) in HOSTILE {
        // Deferred scopes: nothing wgpu says is known in the frame, so a refusal there is the CPU's.
        let mut passes = CustomPasses::new(&gpu, renderer.renderer(), wgpu::Features::empty());
        passes.set_scope_mode(ScopeMode::Deferred);
        let mut pass = HostilePass { turns: Turns { turn: Rc::new(Cell::new(Turn::Triangle)), built: None }, record: *record };
        passes.register(&gpu, "hostile", PassStage::AfterOpaque, &mut pass).expect("admitted");
        let scope = gpu.device.push_error_scope(wgpu::ErrorFilter::Validation);
        {
            let mut list: [&mut dyn CustomPass; 1] = [&mut pass];
            let mut run = passes.frame(&gpu, &mut list, 1).expect("frame passes");
            renderer.render_with(&gpu, &base_frame(), CullPath::Gpu, None, &mut run).expect("the frame draws");
        }
        assert_eq!(pollster::block_on(scope.pop()).map(|e| e.to_string()), None, "{name}: the world pass stays valid");
        assert_eq!(passes.refusal_of("hostile"), Some(RenderCode::GpuPassInvalid), "{name}: refused in the frame that recorded it");
        assert_eq!(renderer.capture(&gpu).expect("capture").digest(), plain.digest(), "{name}: nothing drawn");
    }
}
