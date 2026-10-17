//! RQ5.1: motion vectors. Rows find last frame's transform by their draw id and ordinal within it,
//! else by (mesh, ordinal within the batch); an unmatched row, or an ordinal match that jumped,
//! keeps its current transform and writes the no-history flag; skinned rows read last frame's
//! skinned output; the prepass writes NDC motion with the jitter removed.
//!
//! The CPU rows run everywhere. The GPU rows are `#[ignore]`d and every name contains `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked --test motion -- --ignored metal
//!
//! `GENEX_RENDER_EVIDENCE_DIR` receives each row's motion as raw RGBA8 (`<name>-WxH.rgba`: red and
//! green are the motion at 0.5 + 8 × NDC, blue the reactive flag); `GENEX_PERF_OUT` receives the
//! motion cost row as JSON.

use std::path::PathBuf;

use genex_render::Gpu;
use genex_render::layout::{GpuPrevModel, GpuSkinVertex};
use genex_render::mesh::MeshData;
use genex_render::motion::{
    CustomMotion, CustomRow, DrawId, GpuMotionFrame, MOTION_FLAG_MATCHED_BY_ID, MOTION_FLAG_NO_HISTORY, MOTION_FLAG_STILL, MotionFrameInput, MotionHistory, MotionImage, MotionScope, MotionStep, NO_PREV_VERTICES, RowKind,
    motion_gpu_ms, motion_images, motion_of,
};
use genex_render::scene::{CameraDesc, FramePlan, Material, MeshId, MeshLibrary, Scene, scaled, translation};
use genex_render::skin::{Skeleton, SkeletonNode, SkinnedMeshData, Trs};

const WIDTH: u32 = 128;
const HEIGHT: u32 = 72;
const SIZE: (u32, u32) = (WIDTH, HEIGHT);
/// The record's tolerance on the 1 px row (uv units).
const ONE_PX_TOLERANCE: f32 = 1e-4;
/// The camera row's tolerance against the CPU reprojection, NDC (0.03 px at 128 wide): f16
/// storage of the motion and the depth readback's reconstruction.
const REPROJECTION_TOLERANCE: f32 = 5e-4;
/// The motion pass's budget over the prepass at 1080p (RQ5.1 acceptance), GPU ms.
const MOTION_BUDGET_MS: f32 = 0.1;

// ---------------------------------------------------------------------------------------------
// Fixtures

/// An orthographic camera whose pixels are 0.1 world units on a 128x72 target.
fn ortho_camera() -> CameraDesc {
    CameraDesc::look_at([0.0, 0.0, 10.0], [0.0, 0.0, 0.0]).orthographic(HEIGHT as f32 * 0.1)
}

/// One world unit per ten pixels: a translation of `px` pixels to the right.
fn px(px: f32) -> f32 {
    px * 0.1
}

fn scene(camera: CameraDesc) -> Scene {
    let mut scene = Scene::new(camera, [0, 0, 0, 255]);
    scene.lighting.shadows = false;
    scene
}

fn grey() -> Material {
    Material::color([180, 180, 180, 255])
}

/// A one-joint skinned cube: its joint matrix places it.
fn skinned_cube() -> SkinnedMeshData {
    let mesh = MeshData::cube();
    let skin = vec![GpuSkinVertex { joints: [0; 4], weights: [1.0, 0.0, 0.0, 0.0] }; mesh.vertices.len()];
    let skeleton = Skeleton {
        nodes: vec![SkeletonNode { parent: None, rest: Trs::IDENTITY }],
        joints: vec![0],
        inverse_bind: vec![translation(0.0, 0.0, 0.0)],
        mesh_node: None,
    };
    SkinnedMeshData { mesh, skin, skeleton, animations: Vec::new() }
}

fn frame(scene: Scene, jitter_px: [f32; 2], reset: bool) -> MotionFrameInput {
    MotionFrameInput { scene, jitter_px, reset }
}

fn plan(scene: &Scene, library: &MeshLibrary) -> FramePlan {
    FramePlan::build(scene, library, WIDTH as f32 / HEIGHT as f32).expect("plan")
}

/// Plan `scene` and match it against `history` (no jitter, no reset, previous vertices bound).
fn matched(history: &mut MotionHistory, scene: &Scene, library: &MeshLibrary) -> FramePlan {
    let mut plan = plan(scene, library);
    history.apply(&mut plan, MotionStep { jitter_ndc: [0.0; 2], reset: false, prev_vertices: true });
    plan
}

/// The previous-model row of the instance row whose model translates to `x`.
fn row_at(plan: &FramePlan, x: f32) -> GpuPrevModel {
    let at = plan.instances.iter().position(|row| (row.model[12] - x).abs() < 1e-6).expect("a row at x");
    plan.prev_models[at]
}

/// The pixel a world point at (`x`, `y`) lands on under [`ortho_camera`].
fn pixel_of(x: f32, y: f32) -> usize {
    let column = (WIDTH as f32 * 0.5 + x / 0.1) as usize;
    let row = (HEIGHT as f32 * 0.5 - y / 0.1) as usize;
    row * WIDTH as usize + column
}

fn write_evidence(name: &str, image: &MotionImage) {
    let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") else { return };
    let dir = PathBuf::from(dir);
    let _ = std::fs::create_dir_all(&dir);
    let channel = |v: f32| ((0.5 + 8.0 * v).clamp(0.0, 1.0) * 255.0).round() as u8;
    let bytes: Vec<u8> = image.motion.iter().zip(&image.reactive).flat_map(|(m, r)| [channel(m[0]), channel(m[1]), (r * 255.0).round() as u8, 255]).collect();
    std::fs::write(dir.join(format!("{name}-{}x{}.rgba", image.size.0, image.size.1)), bytes).expect("evidence");
}

// ---------------------------------------------------------------------------------------------
// CPU rows: identity and matching

#[test]
fn a_scene_s_draw_id_scopes_the_following_draws_like_the_facade_s() {
    let mut scene = scene(ortho_camera());
    scene.draw(MeshId::CUBE, translation(0.0, 0.0, 0.0), grey());
    scene.set_id(Some(DrawId::from("fox")));
    scene.draw_instanced(MeshId::SPHERE, &[translation(1.0, 0.0, 0.0), translation(2.0, 0.0, 0.0)], grey());
    scene.set_id(None);
    scene.draw(MeshId::CUBE, translation(3.0, 0.0, 0.0), grey());
    let ids: Vec<Option<DrawId>> = scene.draws.iter().map(|draw| draw.id).collect();
    let fox = Some(DrawId::from("fox"));
    assert_eq!(ids, [None, fox, fox, None]);
    let plan = plan(&scene, &MeshLibrary::new());
    assert_eq!(plan.motion.len(), plan.instances.len(), "one identity per instance row");
    let scopes: Vec<(MotionScope, u32)> = plan.motion.iter().map(|row| (row.key.scope, row.key.ordinal)).collect();
    let cubes = MotionScope::Mesh { mesh: MeshId::CUBE, kind: RowKind::Opaque };
    let fox_scope = MotionScope::Id { id: DrawId::from("fox"), skinned: false };
    // Batches by ascending mesh id: the cube's rows, then the sphere's.
    assert_eq!(scopes, [(cubes, 0), (cubes, 1), (fox_scope, 0), (fox_scope, 1)]);
}

#[test]
fn the_first_frame_and_a_reset_have_no_history_and_last_frame_s_camera_is_the_current_one() {
    let library = MeshLibrary::new();
    let mut scene = scene(CameraDesc::look_at([0.0, 2.0, 8.0], [0.0, 0.0, 0.0]));
    scene.draw(MeshId::CUBE, translation(0.0, 0.0, 0.0), grey());
    let mut history = MotionHistory::new();
    let mut first = plan(&scene, &library);
    let row = history.apply(&mut first, MotionStep::default());
    assert_eq!(row.prev_view_proj, first.frame.view_proj, "no camera history: zero camera motion");
    // RQ5 review: a row without history, or one that did not move, is also flagged still (the motion
    // pass then skips its second transform).
    assert_eq!(first.prev_models[0].flags[0], MOTION_FLAG_NO_HISTORY | MOTION_FLAG_STILL);
    let second = matched(&mut history, &scene, &library);
    assert_eq!(second.prev_models[0].flags[0], MOTION_FLAG_STILL, "matched by mesh ordinal, and still");
    scene.camera.eye = [1.0, 2.0, 8.0];
    let mut cut = plan(&scene, &library);
    let row = history.apply(&mut cut, MotionStep { reset: true, ..MotionStep::default() });
    assert_eq!(row.prev_view_proj, cut.frame.view_proj, "a camera cut forgets the last camera");
    assert_eq!(cut.prev_models[0].flags[0], MOTION_FLAG_NO_HISTORY | MOTION_FLAG_STILL);
    let jittered = history.apply(&mut plan(&scene, &library), MotionStep { jitter_ndc: [0.25, -0.5], ..MotionStep::default() });
    assert_eq!(jittered.jitter, [0.25, -0.5, 0.0, 0.0]);
    // Renderer pass 2, P2-0.8b (T-03) flipped 80 -> 144: the camera's reprojection
    // (`GpuMotionFrame::reproject`), which the background's motion reads.
    assert_eq!(size_of::<GpuMotionFrame>(), 144);
}

/// Renderer pass 2, P2-0.8b (T-03): the frame row carries last frame's unjittered view_proj times
/// this frame's inverse, the matrix the background's motion and TAA's disocclusion test read
/// (identity for a still camera and after a reset).
#[test]
fn the_motion_frame_carries_the_cameras_reprojection() {
    let library = MeshLibrary::new();
    let mut history = MotionHistory::new();
    let looking = |x: f32| scene(CameraDesc::look_at([0.0, 1.0, 6.0], [x, 1.0, 0.0]));
    let mut first = plan(&looking(0.0), &library);
    let still = history.apply(&mut first, MotionStep::default());
    let identity = genex_render::post::taa::IDENTITY;
    let near = |a: &[f32; 16], b: &[f32; 16]| a.iter().zip(b).all(|(x, y)| (x - y).abs() < 1e-5);
    assert!(near(&still.reproject, &identity), "no history: {:?}", still.reproject);
    let mut turned = plan(&looking(0.3), &library);
    let row = history.apply(&mut turned, MotionStep::default());
    assert_eq!(row.reproject, genex_render::post::taa::reprojection(&first.frame.view_proj, &turned.frame.view_proj));
    assert!(!near(&row.reproject, &identity), "a turned camera reprojects");
    let mut cut = plan(&looking(0.6), &library);
    let reset = history.apply(&mut cut, MotionStep { reset: true, ..MotionStep::default() });
    assert!(near(&reset.reproject, &identity), "a cut forgets the camera");
}

// ---------------------------------------------------------------------------------------------
// CPU rows: custom draws (renderer pass 2, P2-0.8b: T-04, LG-05)

/// A custom draw of `mesh` at `x` (radius 1), under `id`.
fn custom_row(id: Option<&str>, mesh: MeshId, x: f32) -> CustomRow {
    CustomRow { id: id.map(DrawId::from), mesh, model: translation(x, 0.0, 0.0), bounds: [x, 0.0, 0.0, 1.0] }
}

#[test]
fn a_custom_draw_takes_last_frame_s_model_by_id_or_mesh_ordinal_and_has_none_unmatched() {
    let mut motion = CustomMotion::new();
    let first = [custom_row(Some("mover"), MeshId::CUBE, 0.0), custom_row(None, MeshId::SPHERE, 5.0), custom_row(None, MeshId::SPHERE, 9.0)];
    let (prevs, prev_seconds) = motion.apply(&first, 1.0);
    assert!(prevs.iter().all(|prev| !prev.history), "the first frame has no history");
    assert!(prevs.iter().zip(&first).all(|(prev, row)| prev.model == row.model), "and moves with the camera alone");
    assert_eq!(prev_seconds, 1.0, "the first frame's previous time is its own");
    // The id'd cube jumps far (an id match is trusted), the spheres creep and an id-less cube appears.
    let second = [
        custom_row(None, MeshId::CUBE, -4.0),
        custom_row(Some("mover"), MeshId::CUBE, 6.0),
        custom_row(None, MeshId::SPHERE, 5.2),
        custom_row(None, MeshId::SPHERE, 9.2),
    ];
    let (prevs, prev_seconds) = motion.apply(&second, 1.05);
    assert_eq!(prev_seconds, 1.0, "last frame's simulated seconds (GxDrawV2 params.z)");
    assert!(!prevs[0].history, "a new id-less cube has no history");
    assert_eq!((prevs[1].history, prevs[1].model), (true, first[0].model), "matched by its id");
    assert_eq!((prevs[2].history, prevs[2].model), (true, first[1].model), "matched by mesh ordinal");
    assert_eq!((prevs[3].history, prevs[3].model), (true, first[2].model));
    // The first sphere goes: the second's ordinal now names the first's slot, five radii away.
    let third = [custom_row(Some("mover"), MeshId::CUBE, 6.0), custom_row(None, MeshId::SPHERE, 9.4)];
    let (prevs, _) = motion.apply(&third, 1.1);
    assert_eq!((prevs[0].history, prevs[0].model), (true, second[1].model), "still: last frame's model is its own");
    assert!(!prevs[1].history, "an ordinal match that jumped has no history");
    let mut broken = custom_row(Some("mover"), MeshId::CUBE, 6.0);
    broken.model[12] = f32::NAN;
    let (prevs, _) = motion.apply(&[broken], 1.15);
    assert!(!prevs[0].history, "a non-finite transform has no history");
    motion.reset();
    let (prevs, prev_seconds) = motion.apply(&third, 2.0);
    assert!(prevs.iter().all(|prev| !prev.history) && prev_seconds == 2.0, "a reset forgets the draws and the time");
}

#[test]
fn a_custom_draw_s_prepass_row_carries_last_frame_s_model_and_its_history() {
    use genex_render::prepass::{GpuPrepassDraw, PrepassDraw};
    let moved = PrepassDraw { mesh: MeshId::CUBE, model: translation(1.0, 0.0, 0.0), prev_model: translation(0.5, 0.0, 0.0), history: true };
    let row = GpuPrepassDraw::of(&moved);
    assert_eq!((row.prev_model, row.flags), (moved.prev_model, [0; 4]));
    let fresh = GpuPrepassDraw::of(&PrepassDraw { history: false, ..moved });
    assert_eq!(fresh.flags[0], MOTION_FLAG_NO_HISTORY, "a draw without history writes the reactive flag");
    assert_eq!(PrepassDraw::still(MeshId::CUBE, moved.model).prev_model, moved.model);
}

#[test]
fn an_id_less_row_takes_last_frame_s_model_by_mesh_ordinal_unless_it_jumped() {
    let library = MeshLibrary::new();
    let mut history = MotionHistory::new();
    let row_of = |xs: &[f32]| {
        let mut scene = scene(ortho_camera());
        for x in xs {
            scene.draw(MeshId::CUBE, translation(*x, 0.0, 0.0), grey());
        }
        scene
    };
    matched(&mut history, &row_of(&[-4.0, -2.0, 0.0, 2.0, 4.0]), &library);
    // A small move keeps the ordinal match: last frame's model, no flag.
    let moved = matched(&mut history, &row_of(&[-4.0, -2.0, 0.0, 2.0, 4.1]), &library);
    let kept = row_at(&moved, 4.1);
    assert_eq!((kept.flags[0], kept.model[12]), (0, 4.0));
    // Removing the second instance shifts the ordinals after it by one spacing (2 units, more than
    // the unit cube's radius): those rows jump and have no history; the first keeps its own.
    let removed = matched(&mut history, &row_of(&[-4.0, 0.0, 2.0, 4.1]), &library);
    assert_eq!(row_at(&removed, -4.0).flags[0], MOTION_FLAG_STILL, "it did not move");
    for x in [0.0, 2.0, 4.1] {
        let shifted = row_at(&removed, x);
        assert_eq!(shifted.flags[0], MOTION_FLAG_NO_HISTORY | MOTION_FLAG_STILL, "x = {x}");
        assert_eq!(shifted.model[12], x, "a jumped row keeps its own model: zero object motion");
    }
}

#[test]
fn an_id_keeps_its_history_across_reorders_while_id_less_rows_fall_back() {
    let library = MeshLibrary::new();
    let with_ids = |order: &[(&str, f32)], ids: bool| {
        let mut scene = scene(ortho_camera());
        for (name, x) in order {
            scene.set_id(ids.then(|| DrawId::from(*name)));
            scene.draw(MeshId::CUBE, translation(*x, 0.0, 0.0), grey());
        }
        scene
    };
    for ids in [true, false] {
        let mut history = MotionHistory::new();
        matched(&mut history, &with_ids(&[("a", -2.0), ("b", 2.0)], ids), &library);
        let swapped = matched(&mut history, &with_ids(&[("b", 2.1), ("a", -2.1)], ids), &library);
        let (a, b) = (row_at(&swapped, -2.1), row_at(&swapped, 2.1));
        if ids {
            assert_eq!((a.flags[0], a.model[12]), (MOTION_FLAG_MATCHED_BY_ID, -2.0));
            assert_eq!((b.flags[0], b.model[12]), (MOTION_FLAG_MATCHED_BY_ID, 2.0));
        } else {
            // The ordinals swapped: each row's ordinal match is the other cube, four units away.
            let none = MOTION_FLAG_NO_HISTORY | MOTION_FLAG_STILL;
            assert_eq!((a.flags[0], b.flags[0]), (none, none));
            assert_eq!((a.model[12], b.model[12]), (-2.1, 2.1));
        }
        assert!(swapped.prev_models.iter().all(|row| row.model.iter().all(|v| v.is_finite())));
    }
}

#[test]
fn a_non_finite_transform_has_no_history_and_never_reaches_the_table_as_a_previous_model() {
    let library = MeshLibrary::new();
    let mut history = MotionHistory::new();
    let mut scene = scene(ortho_camera());
    scene.draw(MeshId::CUBE, translation(f32::NAN, 0.0, 0.0), grey());
    matched(&mut history, &scene, &library);
    scene.draws[0].model = translation(0.0, 0.0, 0.0);
    let plan = matched(&mut history, &scene, &library);
    assert_eq!(plan.prev_models[0].flags[0], MOTION_FLAG_NO_HISTORY | MOTION_FLAG_STILL);
    assert!(plan.prev_models[0].model.iter().all(|v| v.is_finite()));
}

#[test]
fn a_skinned_row_points_at_last_frame_s_skinned_vertices_of_the_same_mesh_only() {
    let mut library = MeshLibrary::new();
    let skin = library.add_skinned(&skinned_cube()).expect("skinned");
    let other = library.add_skinned(&skinned_cube()).expect("skinned");
    let joint = vec![translation(0.0, 0.0, 0.0)];
    let draw = |order: &[(&str, genex_render::skin::SkinId)]| {
        let mut scene = scene(ortho_camera());
        for (name, skin) in order {
            scene.set_id(Some(DrawId::from(*name)));
            scene.draw_skinned(*skin, translation(0.0, 0.0, 0.0), joint.clone(), grey());
        }
        scene
    };
    let mut history = MotionHistory::new();
    let first = matched(&mut history, &draw(&[("deer", skin), ("fox", skin)]), &library);
    let first_bases: Vec<u32> = first.prev_models.iter().map(|row| row.flags[2]).collect();
    assert_eq!(first.prev_models.iter().map(|row| row.flags[1]).collect::<Vec<_>>(), [NO_PREV_VERTICES; 2], "no last frame");
    // Reordered by id: each row reads the other's previous base.
    let second = matched(&mut history, &draw(&[("fox", skin), ("deer", skin)]), &library);
    let prev_bases: Vec<u32> = second.prev_models.iter().map(|row| row.flags[1]).collect();
    assert_eq!(prev_bases, [first_bases[1], first_bases[0]]);
    assert_eq!(second.prev_models.iter().map(|row| row.flags[2]).collect::<Vec<_>>(), first_bases, "this frame's bases follow draw order");
    // The same id on another mesh keeps the model match but not the vertices.
    let third = matched(&mut history, &draw(&[("fox", other), ("deer", skin)]), &library);
    // Its model did not move and it reads no previous vertices: still (RQ5 review's flag).
    let still = MOTION_FLAG_MATCHED_BY_ID | MOTION_FLAG_STILL;
    assert_eq!((third.prev_models[0].flags[0], third.prev_models[0].flags[1]), (still, NO_PREV_VERTICES));
    assert_eq!(third.prev_models[1].flags[0] & MOTION_FLAG_STILL, 0, "a row reading previous vertices is never still");
    assert_ne!(third.prev_models[1].flags[1], NO_PREV_VERTICES);
    // Without last frame's output bound, no row reads previous vertices.
    let mut plan = plan(&draw(&[("fox", other), ("deer", skin)]), &library);
    history.apply(&mut plan, MotionStep { prev_vertices: false, ..MotionStep::default() });
    assert!(plan.prev_models.iter().all(|row| row.flags[1] == NO_PREV_VERTICES));
}

#[test]
fn the_cpu_reference_is_ndc_now_minus_ndc_then() {
    let camera = ortho_camera();
    let vp = camera.view_proj(WIDTH as f32 / HEIGHT as f32).to_cols_array();
    let m = motion_of(&vp, &vp, [px(1.0), 0.0, 0.0], [0.0, 0.0, 0.0]);
    assert!((m[0] - 2.0 / WIDTH as f32).abs() < 1e-6 && m[1].abs() < 1e-6, "{m:?}");
}

#[test]
fn the_motion_frame_and_previous_model_rows_match_the_prepass_shader() {
    let module = naga::front::wgsl::parse_str(genex_render::shaders::PREPASS).expect("the prepass parses");
    let mut layouter = naga::proc::Layouter::default();
    layouter.update(module.to_ctx()).expect("layout");
    let size_of_named = |name: &str| {
        let (handle, _) = module.types.iter().find(|(_, ty)| ty.name.as_deref() == Some(name)).unwrap_or_else(|| panic!("{name} is declared"));
        layouter[handle].size as usize
    };
    assert_eq!(size_of_named("MotionFrame"), size_of::<GpuMotionFrame>());
    assert_eq!(size_of_named("PrevModel"), size_of::<GpuPrevModel>());
    assert_eq!(size_of_named("PrepassDraw"), size_of::<genex_render::prepass::GpuPrepassDraw>());
    let mut validator = naga::valid::Validator::new(naga::valid::ValidationFlags::all(), naga::valid::Capabilities::empty());
    validator.validate(&module).expect("the motion entry points validate in WebGPU core");
    for entry in ["vs_prepass_motion", "vs_prepass_draw_motion", "fs_prepass_motion"] {
        assert!(module.entry_points.iter().any(|point| point.name == entry), "{entry}");
    }
    // T-03: the background's module mirrors the frame row too.
    let background = naga::front::wgsl::parse_str(genex_render::motion::BACKGROUND_MOTION).expect("the background motion parses");
    let mut layouter = naga::proc::Layouter::default();
    layouter.update(background.to_ctx()).expect("layout");
    let (handle, _) = background.types.iter().find(|(_, ty)| ty.name.as_deref() == Some("MotionFrame")).expect("MotionFrame");
    assert_eq!(layouter[handle].size as usize, size_of::<GpuMotionFrame>());
    let mut validator = naga::valid::Validator::new(naga::valid::ValidationFlags::all(), naga::valid::Capabilities::empty());
    validator.validate(&background).expect("the background motion validates in WebGPU core");
}

/// The locations `entry` (a fragment entry point of `module`) writes.
fn fragment_output_locations(module: &naga::Module, entry: &str) -> Vec<u32> {
    let point = module.entry_points.iter().find(|point| point.name == entry).unwrap_or_else(|| panic!("{entry} is declared"));
    let Some(result) = point.function.result.as_ref() else { return Vec::new() };
    let binding_location = |binding: Option<&naga::Binding>| match binding {
        Some(naga::Binding::Location { location, .. }) => Some(*location),
        _ => None,
    };
    if let naga::TypeInner::Struct { members, .. } = &module.types[result.ty].inner {
        return members.iter().filter_map(|member| binding_location(member.binding.as_ref())).collect();
    }
    binding_location(result.binding.as_ref()).into_iter().collect()
}

#[test]
fn the_background_motion_pipeline_writes_only_targets_its_fragment_stage_outputs() {
    // WebGPU (Dawn, Chrome) refuses a colour target with a non-zero write mask and no fragment
    // output at its location; wgpu's Metal path does not, so the web went black at every TAA preset
    // (G0 perf-platform: "Invalid RenderPipeline vs_background_motion").
    let module = naga::front::wgsl::parse_str(genex_render::motion::BACKGROUND_MOTION).expect("the background motion parses");
    let outputs = fragment_output_locations(&module, genex_render::motion::BACKGROUND_FRAGMENT_ENTRY);
    let targets = genex_render::motion::background_targets();
    for (location, target) in targets.iter().enumerate() {
        let target = target.as_ref().expect("every prepass target is bound");
        let written = !target.write_mask.is_empty();
        let output = outputs.contains(&(location as u32));
        assert_eq!(written, output, "target {location} ({:?}): write mask {:?}, fragment output {output}", target.format, target.write_mask);
    }
    assert_eq!(outputs, vec![genex_render::motion::MOTION_LOCATION], "the background writes the motion alone");
}

// ---------------------------------------------------------------------------------------------
// GPU rows

static GPU_ROWS: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn gpu() -> Option<(std::sync::MutexGuard<'static, ()>, Gpu)> {
    let lock = GPU_ROWS.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
    match Gpu::headless() {
        Ok(gpu) => {
            if require {
                assert_eq!(gpu.receipt().backend, "metal", "GENEX_REQUIRE_METAL=1 but the adapter is not Metal");
            }
            Some((lock, gpu))
        }
        Err(error) if require => panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}"),
        Err(error) => {
            eprintln!("skipped: no WebGPU-core adapter ({error})");
            None
        }
    }
}

fn assert_finite(image: &MotionImage, what: &str) {
    let bad = image.motion.iter().filter(|m| !m[0].is_finite() || !m[1].is_finite()).count();
    assert_eq!(bad, 0, "{what}: non-finite motion texels");
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_a_cube_translated_one_pixel_per_frame_writes_one_pixel_of_motion_at_its_centre() {
    let Some((_rows, gpu)) = gpu() else { return };
    let library = MeshLibrary::new();
    let cube_at = |x: f32| {
        let mut scene = scene(ortho_camera());
        scene.draw(MeshId::CUBE, scaled([x, 0.0, 0.0], [2.0; 3]), grey());
        scene
    };
    for reversed in [true, false] {
        for jitter in [[0.0, 0.0], [0.37, -0.21]] {
            let frames = [frame(cube_at(0.0), [0.0; 2], true), frame(cube_at(px(1.0)), jitter, false), frame(cube_at(px(2.0)), [-jitter[0], jitter[1]], false)];
            let images = motion_images(&gpu, &library, SIZE, reversed, &frames).expect("motion");
            let centre = pixel_of(px(1.0), 0.0);
            assert_eq!(images[0].reactive[centre], 1.0, "the first frame has no history");
            for (k, image) in images.iter().enumerate().skip(1) {
                assert_finite(image, "translated cube");
                let at = pixel_of(px(k as f32), 0.0);
                let uv = [image.motion[at][0] * 0.5, -image.motion[at][1] * 0.5];
                eprintln!("reversed {reversed} jitter {jitter:?} frame {k}: motion {:?} (uv {uv:?})", image.motion[at]);
                assert!((uv[0] - 1.0 / WIDTH as f32).abs() <= ONE_PX_TOLERANCE, "frame {k}: {uv:?} is not (1/width, 0)");
                assert!(uv[1].abs() <= ONE_PX_TOLERANCE, "frame {k}: {uv:?}");
                assert_eq!(image.reactive[at], 0.0, "matched by its mesh ordinal");
            }
            if reversed && jitter == [0.37, -0.21] {
                write_evidence("rq5.1-translated-cube-jittered", &images[1]);
            }
        }
    }
}

/// A static field of spheres and cubes over a ground, from `eye`.
fn static_scene(eye: [f32; 3]) -> Scene {
    let mut scene = scene(CameraDesc::look_at(eye, [0.0, 0.4, 0.0]));
    for i in 0..6 {
        let (x, z) = (i as f32 * 0.9 - 2.2, -(i as f32) * 0.8);
        scene.draw(MeshId::SPHERE, scaled([x, 0.6, z], [0.7; 3]), grey());
        scene.draw(MeshId::CUBE, scaled([-x, 0.4, z - 0.4], [0.6; 3]), grey());
    }
    scene.draw(MeshId::CUBE, scaled([0.0, -0.1, -2.0], [12.0, 0.2, 10.0]), grey());
    scene
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_camera_motion_of_a_static_scene_equals_the_cpu_reprojection() {
    let Some((_rows, gpu)) = gpu() else { return };
    let library = MeshLibrary::new();
    for reversed in [true, false] {
        let frames = [frame(static_scene([0.0, 2.5, 7.0]), [0.0; 2], true), frame(static_scene([0.25, 2.4, 6.8]), [0.0; 2], false)];
        let images = motion_images(&gpu, &library, SIZE, reversed, &frames).expect("motion");
        let image = &images[1];
        assert_finite(image, "camera motion");
        let inverse = glam::Mat4::from_cols_array(&image.view_proj).inverse();
        let clear = if reversed { 0.0 } else { 1.0 };
        let (mut covered, mut worst, mut largest) = (0usize, 0.0f32, 0.0f32);
        for y in 0..HEIGHT {
            for x in 0..WIDTH {
                let at = (y * WIDTH + x) as usize;
                if image.depth[at] == clear {
                    continue;
                }
                let ndc = [(x as f32 + 0.5) / WIDTH as f32 * 2.0 - 1.0, 1.0 - (y as f32 + 0.5) / HEIGHT as f32 * 2.0];
                let world = inverse.project_point3(glam::Vec3::new(ndc[0], ndc[1], image.depth[at])).to_array();
                let expected = motion_of(&image.view_proj, &image.frame.prev_view_proj, world, world);
                let error = (image.motion[at][0] - expected[0]).abs().max((image.motion[at][1] - expected[1]).abs());
                worst = worst.max(error);
                largest = largest.max(expected[0].abs().max(expected[1].abs()));
                covered += 1;
                assert_eq!(image.reactive[at], 0.0, "every row of a static scene keeps its history");
            }
        }
        eprintln!("reversed {reversed}: {covered} covered pixels, largest motion {largest:.4} NDC, worst error {worst:.6}");
        assert!(covered > (WIDTH * HEIGHT / 3) as usize, "the scene covers the frame: {covered}");
        assert!(largest > 0.02, "the camera moved visibly: {largest}");
        assert!(worst <= REPROJECTION_TOLERANCE, "worst error {worst} NDC");
        if reversed {
            write_evidence("rq5.1-camera-motion", image);
        }
    }
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_id_less_draws_reordered_between_frames_fall_back_without_nans_and_ids_keep_their_history() {
    let Some((_rows, gpu)) = gpu() else { return };
    let library = MeshLibrary::new();
    let pair = |order: [(&str, f32); 2], ids: bool| {
        let mut scene = scene(ortho_camera());
        for (name, x) in order {
            scene.set_id(ids.then(|| DrawId::from(name)));
            scene.draw(MeshId::CUBE, scaled([x, 0.0, 0.0], [1.5; 3]), grey());
        }
        scene
    };
    for ids in [false, true] {
        let frames = [frame(pair([("a", -2.0), ("b", 2.0)], ids), [0.0; 2], true), frame(pair([("b", 2.0), ("a", -2.0)], ids), [0.0; 2], false)];
        let images = motion_images(&gpu, &library, SIZE, true, &frames).expect("motion");
        let image = &images[1];
        assert_finite(image, "reordered");
        let worst = image.motion.iter().map(|m| m[0].abs().max(m[1].abs())).fold(0.0f32, f32::max);
        assert!(worst <= 1e-6, "neither cube moved and the camera is still: {worst}");
        let expected = if ids { 0.0 } else { 1.0 };
        for x in [-2.0, 2.0] {
            assert_eq!(image.reactive[pixel_of(x, 0.0)], expected, "ids {ids}, cube at {x}");
        }
        write_evidence(if ids { "rq5.1-reordered-with-ids" } else { "rq5.1-reordered-id-less" }, image);
    }
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_removing_one_of_five_id_less_instances_leaves_no_trails_on_the_rest() {
    let Some((_rows, gpu)) = gpu() else { return };
    let library = MeshLibrary::new();
    let row_of = |xs: &[f32]| {
        let mut scene = scene(ortho_camera());
        let models: Vec<[f32; 16]> = xs.iter().map(|x| translation(*x, 0.0, 0.0)).collect();
        scene.draw_instanced(MeshId::CUBE, &models, grey());
        scene
    };
    let frames = [frame(row_of(&[-4.0, -2.0, 0.0, 2.0, 4.0]), [0.0; 2], true), frame(row_of(&[-4.0, 0.0, 2.0, 4.0]), [0.0; 2], false)];
    let images = motion_images(&gpu, &library, SIZE, true, &frames).expect("motion");
    let image = &images[1];
    assert_finite(image, "removal");
    // Without the jump check the shifted rows would reproject from their neighbours' positions,
    // two units (20 px, 0.31 NDC) away: a trail.
    let worst = image.motion.iter().map(|m| m[0].abs().max(m[1].abs())).fold(0.0f32, f32::max);
    assert!(worst <= 1e-6, "no instance moved: {worst} NDC of motion is a trail");
    assert_eq!(image.reactive[pixel_of(-4.0, 0.0)], 0.0, "the first instance keeps its ordinal and its history");
    for x in [0.0, 2.0, 4.0] {
        assert_eq!(image.reactive[pixel_of(x, 0.0)], 1.0, "the shifted ordinal at {x} has no history");
    }
    write_evidence("rq5.1-removed-instance", image);
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_a_skinned_draw_reads_last_frame_s_skinned_positions() {
    let Some((_rows, gpu)) = gpu() else { return };
    let mut library = MeshLibrary::new();
    let skin = library.add_skinned(&skinned_cube()).expect("skinned");
    // The model stays put; only the joint moves, one pixel per frame: the motion comes from last
    // frame's skinned vertices alone.
    let posed = |x: f32| {
        let mut scene = scene(ortho_camera());
        scene.set_id(Some(DrawId::from("deer")));
        scene.draw_skinned(skin, translation(0.0, 0.0, 0.0), vec![scaled([x, 0.0, 0.0], [2.0; 3])], grey());
        scene
    };
    let frames: Vec<MotionFrameInput> = (0..4).map(|k| frame(posed(px(k as f32)), [0.0; 2], k == 0)).collect();
    let images = motion_images(&gpu, &library, SIZE, true, &frames).expect("motion");
    assert_eq!(images[0].reactive[pixel_of(0.0, 0.0)], 1.0, "the first frame has no history");
    for (k, image) in images.iter().enumerate().skip(1) {
        assert_finite(image, "skinned");
        let at = pixel_of(px(k as f32), 0.0);
        let uv = [image.motion[at][0] * 0.5, -image.motion[at][1] * 0.5];
        assert!((uv[0] - 1.0 / WIDTH as f32).abs() <= ONE_PX_TOLERANCE && uv[1].abs() <= ONE_PX_TOLERANCE, "frame {k}: {uv:?}");
        assert_eq!(image.reactive[at], 0.0);
        assert_ne!(image.prev_models[0].flags[1], NO_PREV_VERTICES, "frame {k} reads the other buffer of the pair");
    }
    write_evidence("rq5.1-skinned", &images[1]);
}

/// The cost scene: a field of 400 overlapping spheres over a ground at 1080p (vertex- and
/// overdraw-heavy), as tests/prepass.rs's cost row draws.
fn cost_scene() -> Scene {
    let mut scene = scene(CameraDesc::look_at([0.0, 3.0, 12.0], [0.0, 0.5, 0.0]));
    for i in 0..400 {
        let (x, z) = ((i % 20) as f32 * 0.6 - 5.7, -((i / 20) as f32) * 0.9);
        scene.draw(MeshId::SPHERE, scaled([x, 0.5, z], [0.55; 3]), grey());
    }
    scene.draw(MeshId::CUBE, scaled([0.0, -0.1, -8.0], [30.0, 0.2, 30.0]), grey());
    scene
}

fn percentile(sorted: &[f32], q: f32) -> f32 {
    sorted[((sorted.len() - 1) as f32 * q) as usize]
}

/// Independent trials of the cost row; the gate reads their median.
const COST_TRIALS: usize = 3;

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_the_motion_pass_adds_at_most_0_1_ms_over_the_prepass_at_1080p() {
    let Some((_rows, gpu)) = gpu() else { return };
    let library = MeshLibrary::new();
    let scene = cost_scene();
    let mut deltas = Vec::new();
    let mut trials = Vec::new();
    for _ in 0..COST_TRIALS {
        let Some(mut cost) = motion_gpu_ms(&gpu, &library, &scene, (1920, 1080), 40).expect("cost") else {
            eprintln!("skipped: no timestamp queries");
            return;
        };
        cost.prepass.sort_by(f32::total_cmp);
        cost.motion.sort_by(f32::total_cmp);
        let (prepass, motion) = ((percentile(&cost.prepass, 0.5), percentile(&cost.prepass, 0.95)), (percentile(&cost.motion, 0.5), percentile(&cost.motion, 0.95)));
        deltas.push(motion.0 - prepass.0);
        trials.push(format!(
            "{{\"samples\":{},\"prepassP50Ms\":{:.4},\"prepassP95Ms\":{:.4},\"motionP50Ms\":{:.4},\"motionP95Ms\":{:.4},\"deltaP50Ms\":{:.4},\"deltaP95Ms\":{:.4}}}",
            cost.motion.len(),
            prepass.0,
            prepass.1,
            motion.0,
            motion.1,
            motion.0 - prepass.0,
            motion.1 - prepass.1
        ));
    }
    deltas.sort_by(f32::total_cmp);
    let median = deltas[COST_TRIALS / 2];
    let row = format!(
        "{{\"row\":\"motion-1080p\",\"adapter\":\"{}\",\"budgetMs\":{MOTION_BUDGET_MS},\"medianDeltaP50Ms\":{median:.4},\"trials\":[{}]}}",
        gpu.receipt().adapter,
        trials.join(",")
    );
    println!("{row}");
    if let Ok(path) = std::env::var("GENEX_PERF_OUT") {
        std::fs::write(path, format!("{row}\n")).expect("perf row");
    }
    assert!(median <= MOTION_BUDGET_MS, "the motion pass adds {median:.4} ms over the prepass at 1080p (median of {COST_TRIALS}; budget {MOTION_BUDGET_MS} ms)");
}

/// Renderer pass 2, P2-0.8b (T-03): a camera turning over a lone cube writes the camera's own
/// motion at the far plane wherever no geometry drew (the sky reprojects with the turn, as Bevy's
/// background motion does), the CPU reprojection's to f16 precision, and leaves the reactive mask
/// at 0 there (the sky keeps its history); the cube's pixels keep their own motion. Before T-03 the
/// background read zero.
#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_a_turning_camera_writes_the_camera_s_motion_where_no_geometry_drew() {
    let Some((_rows, gpu)) = gpu() else { return };
    let library = MeshLibrary::new();
    let turned = |yaw: f32| {
        let ahead = glam::Vec3::new(libm::sinf(yaw), 0.0, -libm::cosf(yaw));
        let mut scene = scene(CameraDesc::look_at([0.0, 0.0, 6.0], (glam::Vec3::new(0.0, 0.0, 6.0) + ahead).to_array()));
        scene.draw(MeshId::CUBE, scaled([0.0, 0.0, 0.0], [1.5; 3]), grey());
        scene
    };
    let aspect = WIDTH as f32 / HEIGHT as f32;
    for reversed in [true, false] {
        for jitter in [[0.0, 0.0], [0.31, -0.27]] {
            let frames = [frame(turned(0.0), [0.0; 2], true), frame(turned(0.02), jitter, false)];
            let images = motion_images(&gpu, &library, SIZE, reversed, &frames).expect("motion");
            let image = &images[1];
            write_evidence(&format!("background-turn-{}-{}", if reversed { "rev" } else { "std" }, jitter[0]), image);
            let jitter_ndc = genex_render::jitter::offset_ndc(jitter, SIZE);
            let reproject = image.frame.reproject;
            let far = if reversed { 0.0 } else { 1.0 };
            let (mut background, mut worst, mut reactive) = (0, 0.0f32, 0.0f32);
            for (at, depth) in image.depth.iter().enumerate() {
                if *depth != far {
                    continue;
                }
                background += 1;
                let (x, y) = ((at % WIDTH as usize) as f32, (at / WIDTH as usize) as f32);
                let ndc = [(x + 0.5) / WIDTH as f32 * 2.0 - 1.0 - jitter_ndc[0], 1.0 - (y + 0.5) / HEIGHT as f32 * 2.0 - jitter_ndc[1]];
                let prev = glam::Mat4::from_cols_array(&reproject) * glam::Vec4::new(ndc[0], ndc[1], far, 1.0);
                let expected = [ndc[0] - prev.x / prev.w, ndc[1] - prev.y / prev.w];
                let got = image.motion[at];
                worst = worst.max((got[0] - expected[0]).abs()).max((got[1] - expected[1]).abs());
                reactive = reactive.max(image.reactive[at]);
            }
            let turn_ndc = libm::tanf(0.02) / libm::tanf(CameraDesc::look_at([0.0; 3], [0.0, 0.0, -1.0]).fovy_degrees.to_radians() * 0.5) / aspect;
            let centre = image.motion[pixel_of(0.0, 0.0)];
            eprintln!("reversed {reversed} jitter {jitter:?}: {background} background pixels, worst error {worst:.6} NDC (turn about {turn_ndc:.4}), reactive {reactive}, cube centre {centre:?}");
            assert!(background > (WIDTH * HEIGHT / 2) as usize, "the cube leaves most of the frame to the background ({background})");
            assert!(worst < REPROJECTION_TOLERANCE, "the background's motion is the camera's reprojection at the far plane (worst {worst} NDC)");
            assert_eq!(reactive, 0.0, "the background keeps its history");
            assert!(centre[0].abs() > turn_ndc * 0.5, "the cube's own pixels carry the turn too: {centre:?}");
        }
    }
}
