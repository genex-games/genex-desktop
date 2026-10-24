//! Character budgets (game systems AN-23): the per-class compute-skinning cap, the overflow to the
//! vertex stage it forces, and the budget rows.
//!
//! - **Cap.** Each device class skins at most `skinned_compute_instances_max` instances by compute
//!   in a frame (genex-render's presets). Past it the smallest on screen skin in the vertex stage
//!   (AN-18's path, no skinned output), and `state().volatile.render.characters` counts both.
//! - **Budgets** (plan section 10): desktop-high 100 characters within 2.0 ms of CPU animation and
//!   1.0 ms of GPU skinning; web 40 characters; mobile-high 30 characters within 48 MB of skinned
//!   memory; mobile-low 12 within 16 MB. Lane timings are advisory (plan 4.4): the rows record their
//!   numbers and assert only the counts and the memory, which do not depend on the machine's load.
//!
//! The CPU rows run everywhere. The CPU timing row is `#[ignore]`d with `timed` in its name, the
//! GPU rows with `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p showcase --release \
//!     --offline --locked --test characters_perf -- --ignored --nocapture
//!
//! `GENEX_CHARACTERS_OUT` names a folder for the numbers (`characters-perf.txt`).
#![allow(clippy::disallowed_types, reason = "a perf harness reads the wall clock; the simulation never does")]

#[path = "../../../crates/genex-anim/tests/support/mod.rs"]
mod rigs;
mod support;

use std::sync::LazyLock;
use std::time::Instant;

use genex::animation::{BodyPart, Limb, LimbTarget, Mask, Motion};
use genex::present::{AssetCache, ModelSource, Uploads};
use genex::prelude::*;
use genex::{AssetTable, FIXED_STEP_MS, Runtime, View};
use genex_render::RenderError;
use genex_render::device_class::{DeviceClass, FormFactor, PerformanceTier, TargetOs};
use genex_render::mesh::MeshData;
use genex_render::presets::{preset_quality, skinned_compute_instances_max};
use genex_render::scene::{CameraDesc, FramePlan, Material as RenderMaterial, MeshId, MeshLibrary, PlanOptions, Scene};
use genex_render::skin::{SkinId, SkinnedMeshData, SkinnedModel};
use genex_render::skin_vertex::{SkinVertexPolicy, SkinnedInstances, vertex_skinned_draws, vertex_skinned_draws_within};
use genex_render::texture::{TextureData, TextureId, TextureKind};
use showcase_game::bench::{geometry, walk, walker};

/// Copies of the bench walker one dense character holds: about 20,000 vertices, the plan's
/// character (section 10, "50 x 20k vertices").
const DENSE_COPIES: usize = 9;
/// Mobile-high's skinned memory for 30 characters (AN-25's row holds the same cap).
const MOBILE_HIGH_SKINNED_BYTES_MAX: u64 = 48 * 1024 * 1024;
/// Mobile-low's skinned memory for 12 characters.
const MOBILE_LOW_SKINNED_BYTES_MAX: u64 = 16 * 1024 * 1024;
/// The ledger rows that hold skinned memory: both output copies, the slots and the vertex table.
const SKINNED_LABELS: [&str; 4] = ["skinned vertices", "previous skinned vertices", "skinned slots", "vertex skin table"];
/// Desktop-high's budget: characters, CPU animation milliseconds, GPU skinning milliseconds.
const DESKTOP_HIGH_BUDGET: (usize, f64, f64) = (100, 2.0, 1.0);
/// The web's character budget (its compute cap too).
const WEB_CHARACTERS: usize = 40;
/// Rounds of the interleaved A/B and frames per block in each.
const AB_ROUNDS: usize = 5;
const AB_FRAMES: u32 = 24;
/// Frames before the rounds start (pipelines, arenas).
const WARMUP_FRAMES: u32 = 8;

fn desktop(tier: PerformanceTier) -> DeviceClass {
    DeviceClass::new(FormFactor::Desktop, tier)
}

fn mobile(tier: PerformanceTier) -> DeviceClass {
    DeviceClass::new(FormFactor::Mobile, tier)
}

/// The bench walker tiled [`DENSE_COPIES`] times over itself: its vertex count, not its look, is
/// what skinning costs and holds.
fn dense_walker() -> SkinnedMeshData {
    let one = walker();
    let meshes: Vec<MeshData> = (0..DENSE_COPIES).map(|_| one.mesh.clone()).collect();
    let skin = (0..DENSE_COPIES).flat_map(|_| one.skin.iter().copied()).collect();
    SkinnedMeshData { mesh: geometry::merged(&meshes), skin, skeleton: one.skeleton.clone(), animations: Vec::new() }
}

fn translation(x: f32, y: f32, z: f32) -> [f32; 16] {
    let mut m = [0.0; 16];
    m[0] = 1.0;
    m[5] = 1.0;
    m[10] = 1.0;
    m[15] = 1.0;
    m[12] = x;
    m[13] = y;
    m[14] = z;
    m
}

/// The camera every crowd is seen from: 2 m up, looking down the -z crowd.
fn crowd_camera() -> CameraDesc {
    CameraDesc::look_at([0.0, 2.0, 2.0], [0.0, 0.9, -4.0])
}

/// `count` walkers in rows of ten, 0.6 m apart from 1 m in front of the camera: every one nearer
/// than 10 m, so every one is over the 240 px the vertex stage starts below. Each walks its own
/// phase at `seconds` (no two share a pose, so no two share a skin job).
fn crowd(skin: SkinId, walker: &SkinnedMeshData, count: usize, seconds: f32) -> Scene {
    let mut scene = Scene::new(crowd_camera(), [20, 24, 30, 255]);
    for i in 0..count {
        let (column, row) = ((i % 10) as f32, (i / 10) as f32);
        let model = translation(column * 0.6 - 2.7, 0.0, -1.0 - row * 0.6);
        scene.set_id(Some(genex_render::motion::DrawId::from_key(&format!("walker-{i}"))));
        scene.draw_skinned(skin, model, walk(walker, seconds + 0.013 * i as f32), RenderMaterial::color([200, 140, 90, 255]));
    }
    scene
}

/// `count` walkers in one file down the view axis, 0.2 m apart from 1 m in front of the camera
/// (every one nearer than 9 m): the later the draw, the smaller on screen.
fn file(skin: SkinId, walker: &SkinnedMeshData, count: usize) -> Scene {
    let mut scene = Scene::new(crowd_camera(), [20, 24, 30, 255]);
    for i in 0..count {
        scene.draw_skinned(skin, translation(0.0, 0.0, -1.0 - 0.2 * i as f32), walk(walker, 0.013 * i as f32), RenderMaterial::color([200, 140, 90, 255]));
    }
    scene
}

// ---------------------------------------------------------------------------------------------
// CPU rows

#[test]
fn each_class_has_its_compute_cap_and_the_web_holds_forty() {
    let rows = [
        (desktop(PerformanceTier::Ultra), 128),
        (desktop(PerformanceTier::High), 100),
        (desktop(PerformanceTier::Mid), 64),
        (desktop(PerformanceTier::Low), 32),
        (mobile(PerformanceTier::Ultra), 16),
        (mobile(PerformanceTier::High), 16),
        (mobile(PerformanceTier::Mid), 12),
        (mobile(PerformanceTier::Low), 8),
    ];
    for (class, cap) in rows {
        assert_eq!(skinned_compute_instances_max(class, TargetOs::MacOs), cap, "{}", class.wire());
        assert_eq!(skinned_compute_instances_max(class, TargetOs::Ios), cap, "{} on a phone OS", class.wire());
        assert_eq!(skinned_compute_instances_max(class, TargetOs::Web), cap.min(WEB_CHARACTERS as u32), "{} in a browser", class.wire());
    }
    assert!(skinned_compute_instances_max(desktop(PerformanceTier::High), TargetOs::MacOs) as usize >= DESKTOP_HIGH_BUDGET.0, "desktop-high's budget is all compute");
}

#[test]
fn past_the_cap_the_smallest_draws_skin_in_the_vertex_stage_and_take_no_job() {
    let mut library = MeshLibrary::new();
    let one = walker();
    let skin = library.add_skinned(&one).expect("the walker");
    let scene = file(skin, &one, 30);
    // Head behaviour: under Auto every near walker is compute skinned.
    assert!(vertex_skinned_draws(&scene, &library, SkinVertexPolicy::Auto).is_empty(), "30 near walkers: all over 240 px");

    let cap = skinned_compute_instances_max(mobile(PerformanceTier::High), TargetOs::Ios);
    let vertex = vertex_skinned_draws_within(&scene, &library, SkinVertexPolicy::Auto, cap, &[]);
    let counts = SkinnedInstances::of(scene.skinned.len(), &vertex, Some(cap));
    assert_eq!((counts.compute, counts.vertex), (16, 14), "{counts:?}");
    // The overflow is the smallest on screen: the farthest 14 of the file.
    let moved: Vec<usize> = vertex.iter().enumerate().filter(|(_, flag)| **flag).map(|(at, _)| at).collect();
    assert_eq!(moved, (16..30).collect::<Vec<_>>(), "the nearest 16 stay on compute");
    let options = PlanOptions { shadows: None, depth_reversed: false, sun: None };
    let plan = FramePlan::build_with_skin_paths(&scene, &library, 16.0 / 9.0, &options, false, &vertex).expect("plan");
    assert_eq!(plan.skin_jobs.len(), 16, "one job per compute instance, none for the overflow");

    // Within the cap nothing changes; the explicit policies ignore it.
    assert_eq!(vertex_skinned_draws_within(&scene, &library, SkinVertexPolicy::Auto, 30, &[]), vertex_skinned_draws(&scene, &library, SkinVertexPolicy::Auto));
    assert!(vertex_skinned_draws_within(&scene, &library, SkinVertexPolicy::Compute, 4, &[]).is_empty(), "Compute keeps every draw on compute");
    assert_eq!(vertex_skinned_draws_within(&scene, &library, SkinVertexPolicy::Vertex, 4, &[]), vec![true; 30]);
}

#[test]
fn a_transparent_draw_past_the_cap_stays_on_compute_and_ties_go_to_the_later_job() {
    let mut library = MeshLibrary::new();
    let one = walker();
    // Three copies of the walker (three jobs, lane CP: the cap counts jobs) in one pose at one spot
    // (an exact tie on screen); the farthest of all is glass.
    let skins: Vec<SkinId> = (0..3).map(|_| library.add_skinned(&one).expect("the walker")).collect();
    let mut scene = Scene::new(crowd_camera(), [20, 24, 30, 255]);
    for skin in &skins {
        scene.draw_skinned(*skin, translation(0.0, 0.0, -2.0), walk(&one, 0.1), RenderMaterial::color([200, 140, 90, 255]));
    }
    scene.draw_skinned(skins[0], translation(0.0, 0.0, -6.0), walk(&one, 0.5), RenderMaterial::color([200, 200, 255, 120]));
    // Four jobs against a cap of 2: two must move, the glass cannot, so two of the tied three.
    let vertex = vertex_skinned_draws_within(&scene, &library, SkinVertexPolicy::Auto, 2, &[]);
    assert_eq!(vertex, [false, true, true, false], "the glass stays on compute; of the tied three the later two move");
    let alone = vertex_skinned_draws_within(&scene, &library, SkinVertexPolicy::Auto, 0, &[]);
    assert_eq!(alone, [true, true, true, false], "a cap of 0 still keeps the glass on compute");
}

#[test]
fn draws_sharing_a_pose_are_one_job_under_the_cap_and_leave_it_together() {
    let mut library = MeshLibrary::new();
    let one = walker();
    let skin = library.add_skinned(&one).expect("the walker");
    let mut scene = Scene::new(crowd_camera(), [20, 24, 30, 255]);
    // Three walkers in one pose (one job), then glass (another).
    for x in [-1.0, 0.0, 1.0] {
        scene.draw_skinned(skin, translation(x, 0.0, -2.0), walk(&one, 0.1), RenderMaterial::color([200, 140, 90, 255]));
    }
    scene.draw_skinned(skin, translation(0.0, 0.0, -6.0), walk(&one, 0.5), RenderMaterial::color([200, 200, 255, 120]));
    assert!(vertex_skinned_draws_within(&scene, &library, SkinVertexPolicy::Auto, 2, &[]).is_empty(), "two jobs under a cap of 2");
    let vertex = vertex_skinned_draws_within(&scene, &library, SkinVertexPolicy::Auto, 1, &[]);
    assert_eq!(vertex, [true, true, true, false], "the shared job leaves whole; the glass stays");
}

// ---------------------------------------------------------------------------------------------
// CPU animation: the presenter's poses and the sim's updates of a 60-joint rig

/// genex-anim's humanoid with 38 finger joints (60 joints) and three clips that turn every joint.
fn rig60_glb() -> Vec<u8> {
    use genex::glam::Quat;
    let mut spec = rigs::humanoid22();
    for hand in ["LeftHand", "RightHand"] {
        let parent = spec.nodes.iter().position(|node| node.name == hand).expect("a hand");
        let side = if hand == "LeftHand" { 1.0 } else { -1.0 };
        for finger in 0..5 {
            let mut at = parent;
            let count = if finger == 4 { 3 } else { 4 };
            for bone in 0..count {
                at = spec.joint(&format!("{hand}Finger{finger}_{bone}"), Some(at), [side * 0.03, 0.0, 0.01 * finger as f32 - 0.02], Quat::from_rotation_z(0.05 * bone as f32));
            }
        }
    }
    let every = |name: &str, seconds: f32, amplitude: f32| rigs::ClipSpec {
        name: name.to_owned(),
        channels: spec
            .joints
            .iter()
            .map(|node| rigs::ChannelSpec {
                node: *node,
                path: rigs::ChannelPath::Rotation,
                interpolation: rigs::ChannelInterpolation::Linear,
                times: (0..4).map(|k| seconds * k as f32 / 3.0).collect(),
                values: [0.0, amplitude, -amplitude, 0.0].iter().flat_map(|a| Quat::from_rotation_x(*a).to_array()).collect(),
            })
            .collect(),
    };
    let clips = vec![every("Walk", 0.8, 0.3), every("Run", 0.6, 0.5), every("Wave", 1.2, 0.2)];
    spec.clips = clips;
    spec.glb()
}

static RIG60: LazyLock<&'static [u8]> = LazyLock::new(|| Box::leak(rig60_glb().into_boxed_slice()));

fn table() -> AssetTable {
    static TABLE: LazyLock<AssetTable> = LazyLock::new(|| Box::leak(vec![("hero60.glb", *RIG60)].into_boxed_slice()));
    *TABLE
}

#[derive(Default)]
struct Crowd {
    heroes: Vec<Animator>,
}

/// A game of `count` 60-joint characters, each crossfading walk into run under an upper-body wave
/// layer with IK on four limbs (genex-anim's full-evaluation row, AN-2), drawn in rows of ten.
fn crowd_game(count: usize) -> Game<Crowd> {
    let mut game = Game::new(Crowd::default()).title("Characters perf").world_size(320, 180);
    game.camera(|_| Camera::look_at(vec3(0.0, 2.0, 2.0), vec3(0.0, 0.9, -4.0)));
    game.on_reset(move |sim, _, _, gfx| {
        let hero = gfx.character("hero60.glb").expect("the 60-joint hero loads");
        let ids: Vec<_> = ["Walk", "Run", "Wave"].iter().map(|name| hero.clip(name).expect("a clip")).collect();
        let mut g = hero.graph();
        let fast = g.bool("fast", false);
        let base = g.layer("base");
        let walk = g.state(base, "walk", Motion::clip(ids[0]));
        let run = g.state(base, "run", Motion::clip(ids[1]));
        g.transition(walk, run).when(fast.is(true)).crossfade(1000.0);
        let upper = g.layer("upper");
        g.layer_mask(upper, Mask::Humanoid(BodyPart::UpperBody)).layer_weight(upper, 0.6);
        g.state(upper, "wave", Motion::clip(ids[2]));
        let graph = g.build().expect("the graph builds");
        let limbs = [
            (Limb::LeftLeg, vec3(0.1, 0.15, 0.1), Vec3::Z),
            (Limb::RightLeg, vec3(-0.1, 0.1, -0.05), Vec3::Z),
            (Limb::LeftArm, vec3(0.4, 1.2, 0.2), Vec3::NEG_Y),
            (Limb::RightArm, vec3(-0.4, 1.2, 0.2), Vec3::NEG_Y),
        ];
        sim.world.heroes = (0..count)
            .map(|_| {
                let mut animator = hero.animator(&graph).expect("an animator");
                animator.set_bool(fast, true);
                for (limb, target, pole) in limbs {
                    animator.reach(limb, Some(LimbTarget { target, pole, weight: 1.0 }));
                }
                animator
            })
            .collect();
    });
    game.on_update(|sim, ctx| {
        for hero in &mut sim.world.heroes {
            hero.update(ctx.dt);
        }
    });
    game.on_draw(|sim, frame, _| {
        frame.sun(vec3(0.4, 0.8, 1.0), Color::WHITE, 3.0);
        for (i, hero) in sim.world.heroes.iter().enumerate() {
            let (column, row) = ((i % 10) as f32, (i / 10) as f32);
            frame.character(hero, Transform::from_xyz(column * 0.6 - 2.7, 0.0, -1.0 - row * 0.6));
        }
    });
    game
}

/// A renderer stand-in over a CPU mesh library (the presenter's uploads without a GPU).
#[derive(Default)]
struct Library {
    library: MeshLibrary,
}

impl Uploads for Library {
    fn add_mesh(&mut self, mesh: MeshData) -> Result<MeshId, RenderError> {
        self.library.add(mesh)
    }

    fn add_texture(&mut self, _data: &TextureData, kind: TextureKind) -> Result<TextureId, RenderError> {
        Ok(TextureId::new(kind, 0))
    }

    fn add_skinned_model(&mut self, model: &SkinnedModel) -> Result<SkinId, RenderError> {
        self.library.add_skinned_parts(&model.data, &model.parts)
    }
}

/// The median of `values`.
fn median(values: &mut [f64]) -> f64 {
    values.sort_by(f64::total_cmp);
    support::percentile(values, 0.5)
}

/// CPU animation of `count` characters: the sim's update (a tick of the crowd against a tick of an
/// empty crowd, interleaved) and the presenter's full-rate poses, median of [`AB_ROUNDS`] rounds of
/// [`AB_FRAMES`] ticks, in milliseconds per frame: (update, pose).
fn cpu_animation_ms(count: usize) -> (f64, f64) {
    let start = |count: usize| {
        let mut runtime = Runtime::with_assets(crowd_game(count), Box::new(table())).expect("valid game");
        runtime.seed(1);
        runtime.start();
        runtime.step(f64::from(WARMUP_FRAMES) * FIXED_STEP_MS);
        runtime
    };
    let (mut crowd, mut empty) = (start(count), start(0));
    let frame = crowd.frame(View::Game).expect("the game view");
    let mut cache = AssetCache::default();
    let source: &dyn ModelSource = &table();
    cache.load(&frame, source, &mut Library::default(), &mut |line| eprintln!("{line}")).expect("no device to lose");
    let block = |runtime: &mut Runtime<Crowd>| {
        let started = Instant::now();
        for _ in 0..AB_FRAMES {
            runtime.step(FIXED_STEP_MS);
        }
        started.elapsed().as_secs_f64() * 1000.0 / f64::from(AB_FRAMES)
    };
    let (mut updates, mut poses) = (Vec::new(), Vec::new());
    for _ in 0..AB_ROUNDS {
        let with = block(&mut crowd);
        let without = block(&mut empty);
        updates.push((with - without).max(0.0));
        let frame = crowd.frame(View::Game).expect("the game view");
        let camera = crowd.camera(View::Game).expect("the game camera");
        let started = Instant::now();
        for _ in 0..AB_FRAMES {
            cache.pose_characters(&frame, &camera, crowd.tick(), false);
        }
        poses.push(started.elapsed().as_secs_f64() * 1000.0 / f64::from(AB_FRAMES));
        assert_eq!(cache.character_stats().evaluated as usize, count, "a full-rate frame evaluates every character");
    }
    (median(&mut updates), median(&mut poses))
}

fn record(line: &str) {
    eprintln!("{line}");
    let Some(dir) = std::env::var_os("GENEX_CHARACTERS_OUT") else { return };
    let dir = std::path::PathBuf::from(dir);
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("characters-perf.txt");
    let mut text = std::fs::read_to_string(&path).unwrap_or_default();
    text.push_str(line);
    text.push('\n');
    std::fs::write(&path, text).expect("the numbers");
}

#[test]
#[ignore = "a timing row: run with --release --ignored timed"]
fn timed_cpu_animation_of_the_desktop_and_web_crowds_is_recorded() {
    let (count, budget_ms, _) = DESKTOP_HIGH_BUDGET;
    for characters in [count, WEB_CHARACTERS] {
        let (update, pose) = cpu_animation_ms(characters);
        let build = if cfg!(debug_assertions) { "debug" } else { "release" };
        record(&format!(
            "cpu animation, {characters} characters of 60 joints (3 clips, 1 crossfade, upper-body layer, 4-limb IK), {build}: sim update {update:.3} ms + presenter poses {pose:.3} ms = {:.3} ms per frame (budget {budget_ms} ms desktop-high; median of {AB_ROUNDS} interleaved rounds of {AB_FRAMES} ticks)",
            update + pose
        ));
    }
}

// ---------------------------------------------------------------------------------------------
// GPU rows

mod metal {
    use super::*;
    use genex_render::settings::QualityPreset;
    use genex_render::{CullPath, Gpu, Renderer};

    /// The skinned bytes `renderer` holds (both output copies, the slots and the vertex table).
    fn skinned_bytes(renderer: &Renderer) -> u64 {
        renderer.buffer_ledger().entries().iter().filter(|entry| SKINNED_LABELS.contains(&entry.label.as_str())).map(|entry| entry.bytes).sum()
    }

    /// A renderer of `size` at `class`'s own preset, holding the dense walker.
    fn stage(gpu: &Gpu, class: DeviceClass, preset: QualityPreset, size: (u32, u32)) -> (Renderer, SkinId, SkinnedMeshData) {
        let mut renderer = Renderer::new(gpu, size.0, size.1).expect("renderer");
        renderer.set_device_class(class);
        renderer.set_quality(&preset_quality(preset, class));
        let dense = dense_walker();
        let skin = renderer.add_skinned_mesh(gpu, &dense).expect("the dense walker");
        (renderer, skin, dense)
    }

    /// Three frames of a `count` crowd (the arenas settled); answers the instances and the bytes.
    fn crowd_frames(gpu: &Gpu, renderer: &mut Renderer, skin: SkinId, dense: &SkinnedMeshData, count: usize) -> (SkinnedInstances, u32, u64) {
        for frame in 0..3 {
            renderer.set_frame_index(frame);
            let scene = crowd(skin, dense, count, frame as f32 / 60.0);
            renderer.render(gpu, &scene, CullPath::Gpu).expect("frame");
        }
        (renderer.last_skinned_instances(), renderer.last_stats().skin_jobs, skinned_bytes(renderer))
    }

    #[test]
    #[ignore = "needs a GPU: run with --ignored metal"]
    fn metal_phone_classes_draw_the_overflow_in_the_vertex_stage_within_their_skinned_memory() {
        let Some(gpu) = support::gpu() else { return };
        let rows = [
            ("mobile-high", mobile(PerformanceTier::High), 30, (16, 14), MOBILE_HIGH_SKINNED_BYTES_MAX),
            ("mobile-low", mobile(PerformanceTier::Low), 12, (8, 4), MOBILE_LOW_SKINNED_BYTES_MAX),
        ];
        for (name, class, count, (compute, vertex), cap_bytes) in rows {
            let (mut renderer, skin, dense) = stage(&gpu, class, QualityPreset::High, (1170, 540));
            let (instances, jobs, bytes) = crowd_frames(&gpu, &mut renderer, skin, &dense, count);
            record(&format!(
                "{name}: {count} characters of {} vertices at its compute cap {:?}: compute {} + vertex {} instances, skin jobs {jobs}, skinned bytes {bytes} (cap {cap_bytes})",
                dense.mesh.vertices.len(),
                instances.compute_max,
                instances.compute,
                instances.vertex
            ));
            assert_eq!(jobs, compute, "{name}: one skin job per compute instance (every walker has its own pose)");
            assert_eq!((instances.compute, instances.vertex), (compute, vertex), "{name}: the overflow skins in the vertex stage");
            assert!(bytes <= cap_bytes, "{name}: {bytes} skinned bytes over {cap_bytes}");
        }
    }

    /// Pixels allowed to differ (by more than a level) between the capped crowd and the all-compute
    /// one: AN-18's vertex path matches compute skinning within 1 LSB, so only edge pixels move.
    const CAPPED_LOOK_PIXELS_MAX: usize = 120;

    #[test]
    #[ignore = "needs a GPU: run with --ignored metal"]
    fn metal_the_capped_crowd_looks_like_the_all_compute_crowd() {
        let Some(gpu) = support::gpu() else { return };
        let class = mobile(PerformanceTier::High);
        let mut captures = Vec::new();
        for (name, policy) in [("capped", SkinVertexPolicy::Auto), ("all-compute", SkinVertexPolicy::Compute)] {
            let (mut renderer, skin, dense) = stage(&gpu, class, QualityPreset::High, (1170, 540));
            renderer.set_skin_vertex_policy(policy);
            let (instances, _, _) = crowd_frames(&gpu, &mut renderer, skin, &dense, 30);
            let capture = renderer.capture(&gpu).expect("capture");
            if let Some(dir) = std::env::var_os("GENEX_CHARACTERS_OUT") {
                let dir = std::path::PathBuf::from(dir);
                let _ = std::fs::create_dir_all(&dir);
                support::write_png(&dir.join(format!("an23-mobile-high-thirty-{name}.png")), &capture);
            }
            record(&format!("look {name}: compute {} + vertex {} instances", instances.compute, instances.vertex));
            captures.push(capture.bgra().to_vec());
        }
        let differing = captures[0].as_chunks::<4>().0.iter().zip(captures[1].as_chunks::<4>().0).filter(|(a, b)| (0..3).any(|c| a[c].abs_diff(b[c]) > 1)).count();
        record(&format!("capped vs all-compute at mobile-high: {differing} pixels differ by more than 1 level"));
        assert!(differing <= CAPPED_LOOK_PIXELS_MAX, "{differing} pixels differ");
    }

    #[test]
    #[ignore = "needs a GPU: run with --ignored metal"]
    fn metal_volatile_render_characters_shows_the_overflow_on_an_emulated_phone() {
        use genex::present::Presenter;
        use genex::render::RenderChange;
        let presenter = Presenter::open_with_root([320, 180], table(), None);
        let mut presenter = match presenter {
            Ok(presenter) => presenter,
            Err(error) => {
                assert!(!support::metal_required(), "GENEX_REQUIRE_METAL=1 and no adapter: {error}");
                return;
            }
        };
        let mut runtime = Runtime::with_assets(crowd_game(30), Box::new(table())).expect("valid game");
        runtime.seed(1);
        runtime.start();
        runtime.step(2.0 * FIXED_STEP_MS);
        let phone = RenderChange::from_spellings(None, Some(Some("mobile-high")), &[], None).expect("a class to emulate");
        runtime.render().borrow_mut().apply(&phone);
        presenter.set_capturing(false);
        for _ in 0..2 {
            runtime.step(FIXED_STEP_MS);
            presenter.draw_view(&mut runtime, View::Game).expect("a view").expect("drawn");
        }
        let characters = runtime.render().borrow().status().characters;
        let wire = characters.to_json();
        record(&format!("volatile.render.characters on an emulated mobile-high, 30 near characters: {wire}"));
        assert_eq!(characters.drawn, 30, "{wire}");
        assert_eq!((characters.compute_skinned, characters.vertex_skinned, characters.compute_max), (16, 14, Some(16)), "{wire}");
        assert_eq!(wire["vertexSkinned"], 14, "the wire spelling");
        // The probed (desktop) class gives every one back to compute.
        let probed = RenderChange::from_spellings(None, Some(None), &[], None).expect("the probed class");
        runtime.render().borrow_mut().apply(&probed);
        runtime.step(FIXED_STEP_MS);
        presenter.draw_view(&mut runtime, View::Game).expect("a view").expect("drawn");
        let desktop = runtime.render().borrow().status().characters;
        assert_eq!((desktop.compute_skinned, desktop.vertex_skinned), (30, 0), "{}", desktop.to_json());
    }

    /// GPU timestamps around a frame (perf_matrix's method): a stamped dispatch first in the frame's
    /// first encoder, a stamped pass on the world target after it.
    struct Stamps {
        set: wgpu::QuerySet,
        resolve: wgpu::Buffer,
        read: wgpu::Buffer,
        tick: wgpu::ComputePipeline,
        period_ns: f32,
    }

    impl Stamps {
        fn new(gpu: &Gpu) -> Stamps {
            let device = &gpu.device;
            let buffer = |label, usage| device.create_buffer(&wgpu::BufferDescriptor { label: Some(label), size: 16, usage, mapped_at_creation: false });
            let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("characters stamp"), source: wgpu::ShaderSource::Wgsl("@compute @workgroup_size(1) fn main() {}".into()) });
            Stamps {
                set: device.create_query_set(&wgpu::QuerySetDescriptor { label: Some("characters stamps"), ty: wgpu::QueryType::Timestamp, count: 2 }),
                resolve: buffer("characters stamp resolve", wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC),
                read: buffer("characters stamp read", wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST),
                tick: device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                    label: Some("characters stamp"),
                    layout: None,
                    module: &module,
                    entry_point: Some("main"),
                    compilation_options: wgpu::PipelineCompilationOptions::default(),
                    cache: None,
                }),
                period_ns: gpu.queue.get_timestamp_period(),
            }
        }

        fn start(&self, encoder: &mut wgpu::CommandEncoder) {
            let writes = wgpu::ComputePassTimestampWrites { query_set: &self.set, beginning_of_pass_write_index: Some(0), end_of_pass_write_index: None };
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("characters start stamp"), timestamp_writes: Some(writes) });
            pass.set_pipeline(&self.tick);
            pass.dispatch_workgroups(1, 1, 1);
        }

        fn end(&self, gpu: &Gpu, world: &wgpu::TextureView) {
            let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("characters end stamp") });
            let writes = wgpu::RenderPassTimestampWrites { query_set: &self.set, beginning_of_pass_write_index: None, end_of_pass_write_index: Some(1) };
            drop(encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("characters end stamp"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: world,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: Some(writes),
                occlusion_query_set: None,
                multiview_mask: None,
            }));
            gpu.queue.submit([encoder.finish()]);
        }

        fn read_ms(&self, gpu: &Gpu) -> f64 {
            let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("characters stamp resolve") });
            encoder.resolve_query_set(&self.set, 0..2, &self.resolve, 0);
            encoder.copy_buffer_to_buffer(&self.resolve, 0, &self.read, 0, 16);
            gpu.queue.submit([encoder.finish()]);
            let slice = self.read.slice(..);
            slice.map_async(wgpu::MapMode::Read, |_| {});
            gpu.device.poll(wgpu::PollType::wait_indefinitely()).expect("stamps mapped");
            let ticks: Vec<u64> = slice.get_mapped_range().expect("stamps read").chunks(8).map(|c| u64::from_le_bytes(c.try_into().unwrap_or([0; 8]))).collect();
            self.read.unmap();
            ticks[1].saturating_sub(ticks[0]) as f64 * f64::from(self.period_ns) / 1.0e6
        }
    }

    /// The GPU milliseconds of one frame of `scene`.
    fn gpu_frame_ms(gpu: &Gpu, renderer: &mut Renderer, stamps: &Stamps, scene: &Scene) -> f64 {
        support::render_marked(renderer, gpu, scene, &mut |encoder| stamps.start(encoder));
        stamps.end(gpu, renderer.world_view());
        gpu.device.poll(wgpu::PollType::wait_indefinitely()).expect("the frame finished");
        stamps.read_ms(gpu)
    }

    #[test]
    #[ignore = "needs a GPU: run with --ignored metal"]
    fn metal_desktop_high_skins_its_hundred_characters_and_the_cost_is_recorded() {
        let Ok(gpu) = Gpu::headless_with(wgpu::Features::TIMESTAMP_QUERY) else {
            assert!(!support::metal_required(), "GENEX_REQUIRE_METAL=1 and no adapter with timestamps");
            return;
        };
        let (count, _, budget_ms) = DESKTOP_HIGH_BUDGET;
        let (mut renderer, skin, dense) = stage(&gpu, desktop(PerformanceTier::High), QualityPreset::High, (1280, 720));
        let stamps = Stamps::new(&gpu);
        let mut frame = 0u32;
        let moving = |renderer: &mut Renderer, frame: &mut u32| {
            *frame += 1;
            renderer.set_frame_index(u64::from(*frame));
            gpu_frame_ms(&gpu, renderer, &stamps, &crowd(skin, &dense, count, *frame as f32 / 60.0))
        };
        for _ in 0..WARMUP_FRAMES {
            moving(&mut renderer, &mut frame);
        }
        let instances = renderer.last_skinned_instances();
        assert_eq!((instances.compute, instances.vertex), (count as u32, 0), "desktop-high skins all {count} by compute: {instances:?}");
        assert_eq!(renderer.last_stats().skin_jobs, count as u32);
        // A: every pose moves (every job runs). B: the same poses again (no job runs, AN-16b).
        let mut costs = Vec::new();
        let (mut a_all, mut b_all) = (Vec::new(), Vec::new());
        for _ in 0..AB_ROUNDS {
            let mut a: Vec<f64> = (0..AB_FRAMES).map(|_| moving(&mut renderer, &mut frame)).collect();
            let held = crowd(skin, &dense, count, frame as f32 / 60.0);
            let mut b: Vec<f64> = (0..AB_FRAMES)
                .map(|_| {
                    frame += 1;
                    renderer.set_frame_index(u64::from(frame));
                    gpu_frame_ms(&gpu, &mut renderer, &stamps, &held)
                })
                .collect();
            assert_eq!(renderer.last_stats().skin_jobs, 0, "held poses run no job");
            let (a, b) = (median(&mut a), median(&mut b));
            costs.push(a - b);
            a_all.push(a);
            b_all.push(b);
        }
        let skinning = median(&mut costs);
        record(&format!(
            "desktop-high 1280x720 high: {count} characters of {} vertices, GPU frame moving {:.3} ms vs held {:.3} ms: skinning {skinning:.3} ms (budget {budget_ms} ms; interleaved median of {AB_ROUNDS} rounds of {AB_FRAMES} frames; rounds {costs:.3?}); skinned bytes {}",
            dense.mesh.vertices.len(),
            median(&mut a_all),
            median(&mut b_all),
            skinned_bytes(&renderer)
        ));
    }
}
