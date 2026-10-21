//! Per-cell groups and scatter (game systems STR-20): a cell builder scatters on the terrain within
//! its cell's bounds (`CellInputs::scatter`) and draws the result as a retained group
//! (`CellBuild::group`). The view set keeps a cell's groups while the cell is wanted; a cell that
//! leaves the view drops them and their rows stop uploading.
//!
//! The rows drive `genex::present::StreamView` with an inline pool, the presenter's own source and
//! no GPU: what a frame draws, the renderer's scene and its frame plan.

use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::Duration;

use genex::present::{AssetCache, ModelSource, StreamView, Uploads, ViewIo, ViewLimits, to_scene};
use genex::{Camera, CellBuild, CellId, Color, Frame, Game, InstanceGroup, Material, Runtime, Scatter, Shape, Streaming, Terrain, Transform};
use genex_render::RenderError;
use genex_render::device_class::{DeviceClass, FormFactor, PerformanceTier, TargetOs};
use genex_render::jobs::Pool;
use genex_render::mesh::MeshData;
use genex_render::scene::{FramePlan, MeshId, MeshLibrary};
use genex_render::tables::instance_upload_ranges;
use genex_render::texture::{TextureData, TextureId, TextureKind};
use genex_render::timing::Clock;
use glam::{Vec2, vec2, vec3};

/// The cell side of the rows' worlds, in metres.
const CELL: f32 = 32.0;
/// The forest's square of cells a side (49 cells).
const FOREST_SIDE: i32 = 7;
/// Instances a square metre in the forest: about 50,000 over its 49 cells.
const FOREST_DENSITY: f32 = 1.0;
/// Frames each encode path is timed over.
const ENCODE_FRAMES: usize = 40;
/// Frames before timing starts (the retained rows' first upload, the caches warm).
const ENCODE_WARM_FRAMES: usize = 3;
/// The A.0b budget: retained groups encode at most this share of drawing every instance alone
/// (CPU encode p95 −40%, renderer pass 2 TIER-AB A.0b).
const ENCODE_SHARE_MAX: f64 = 0.6;

#[derive(Default)]
struct World;

/// No files: the rows' groups draw cubes.
struct NoFiles;

impl ModelSource for NoFiles {
    fn model_bytes(&self, _path: &str) -> Option<Vec<u8>> {
        None
    }
}

/// A renderer stand-in that uploads nothing (cube groups need no mesh of their own).
struct NoRenderer;

impl Uploads for NoRenderer {
    fn add_mesh(&mut self, _mesh: MeshData) -> Result<MeshId, RenderError> {
        Ok(MeshId::CUBE)
    }

    fn add_texture(&mut self, _data: &TextureData, kind: TextureKind) -> Result<TextureId, RenderError> {
        Ok(TextureId::new(kind, 0))
    }

    fn remove_mesh(&mut self, _id: MeshId) -> Result<(), RenderError> {
        Ok(())
    }
}

/// A gentle hill over `[-CELL, (FOREST_SIDE + 1) * CELL]` on both axes, one sample a metre.
fn terrain() -> Terrain {
    let samples = ((FOREST_SIDE + 2) as f32 * CELL) as u32 + 1;
    Terrain::from_fn([samples, samples], vec2(-CELL, -CELL), 1.0, |x, z| 0.05 * x + 0.02 * z + 0.5 * libm::sinf(0.1 * x)).expect("terrain")
}

fn rule(density: f32) -> Scatter {
    Scatter::new(density, &[0]).with_scale(0.5, 1.5).following_ground(0.5).with_seed(11)
}

/// A streaming game whose cells in `cells` scatter `rule` on `terrain` and draw it as a cube group.
fn runtime(terrain: &Terrain, rule: Scatter, cells: impl Fn(CellId) -> bool + Send + Sync + 'static, view_metres: f32) -> Runtime<World> {
    let mut game = Game::new(World).title("Stream scatter");
    game.streaming(Streaming::grid(CELL).view_radius(view_metres));
    let terrain = terrain.clone();
    let material = Material::color(Color::rgb(60, 120, 50));
    game.cell_content(move |cell, inputs| {
        let build = CellBuild::<()>::default();
        if !cells(cell) {
            return build;
        }
        let placed = inputs.scatter(&terrain, &rule);
        build.group(InstanceGroup::cubes(placed, &material).expect("within the group cap"))
    });
    let mut runtime = Runtime::new(game).expect("valid registrations");
    runtime.seed(1);
    runtime
}

fn view() -> StreamView {
    let class = DeviceClass::new(FormFactor::Desktop, PerformanceTier::High);
    let mut view = StreamView::new(ViewLimits::for_class(class, TargetOs::MacOs));
    view.use_pool(Arc::new(Pool::inline()));
    view
}

/// The camera over the ground point `at`, looking down at it.
fn camera_at(at: Vec2) -> Camera {
    Camera::look_at(vec3(at.x, 120.0, at.y - 60.0), vec3(at.x, 0.0, at.y))
}

fn still_clock() -> Clock {
    Arc::new(|| Duration::ZERO)
}

/// One frame: update the view set from above `at` and draw it into an empty frame.
fn frame(view: &mut StreamView, runtime: &Runtime<World>, at: Vec2, assets: &mut AssetCache) -> Frame {
    let clock = still_clock();
    let io = ViewIo { assets, source: &NoFiles, uploads: &mut NoRenderer, clock: &clock, log: &mut |line| panic!("nothing is refused: {line}") };
    view.update(runtime, &camera_at(at), io).expect("no device loss");
    let mut frame = Frame::default();
    view.draw_into(&mut frame);
    frame
}

/// Every group transform a frame draws, as bits, sorted: a multiset.
fn drawn_transforms(frame: &Frame) -> Vec<[u32; 16]> {
    let mut all: Vec<[u32; 16]> = frame
        .draws()
        .iter()
        .filter_map(|draw| match &draw.shape {
            Shape::Group { group, .. } => Some(group.transforms().iter().map(bits).collect::<Vec<_>>()),
            _ => None,
        })
        .flatten()
        .collect();
    all.sort_unstable();
    all
}

fn bits(transform: &Transform) -> [u32; 16] {
    transform.to_cols_array().map(f32::to_bits)
}

fn groups_in(frame: &Frame) -> usize {
    frame.draws().iter().filter(|draw| matches!(draw.shape, Shape::Group { .. })).count()
}

#[test]
fn the_scatters_of_two_cells_drawn_as_groups_equal_the_scatter_of_their_union() {
    // New behaviour (STR-20): no cell drew a group and no builder could scatter by its bounds.
    let terrain = terrain();
    let pair = |cell: CellId| cell.z == 0 && (0..2).contains(&cell.x);
    let runtime = runtime(&terrain, rule(0.6), pair, 4.0 * CELL);
    let mut view = view();
    let mut assets = AssetCache::default();
    let drawn = frame(&mut view, &runtime, vec2(CELL, 0.5 * CELL), &mut assets);
    assert_eq!(groups_in(&drawn), 2, "one group per cell");
    let mut union: Vec<[u32; 16]> = terrain.scatter(&rule(0.6), vec2(0.0, 0.0), vec2(2.0 * CELL, CELL)).iter().map(bits).collect();
    union.sort_unstable();
    assert!(union.len() > 500, "a dense enough pair: {}", union.len());
    assert_eq!(drawn_transforms(&drawn), union, "scatter(A) ∪ scatter(B) = scatter(A ∪ B), bit for bit");
    assert_eq!(view.stats().group_instances, union.len() as u64);
    assert_eq!(view.stats().volatile_value()["groupInstances"].as_f64(), union.len() as f64);
}

#[test]
fn a_cell_that_leaves_the_view_drops_its_group_and_its_rows_stop_uploading() {
    // New behaviour (STR-20).
    let terrain = terrain();
    let runtime = runtime(&terrain, rule(0.3), |cell| cell == CellId::new(0, 0), 2.0 * CELL);
    let mut view = view();
    let mut assets = AssetCache::default();
    let library = MeshLibrary::new();
    let near = vec2(0.5 * CELL, 0.5 * CELL);
    let plan_of = |frame: &Frame, at: Vec2, assets: &AssetCache| FramePlan::build(&to_scene(frame, &camera_at(at), assets), &library, 16.0 / 9.0).expect("plan");
    let first = plan_of(&frame(&mut view, &runtime, near, &mut assets), near, &assets);
    assert_eq!(first.retained.len(), 1, "the cell's group is a retained span");
    let ids: BTreeSet<u64> = first.retained.iter().map(|span| span.group.id()).collect();
    let again = plan_of(&frame(&mut view, &runtime, near, &mut assets), near, &assets);
    let rows = again.instances.len();
    assert!(instance_upload_ranges(rows, &again.retained, Some(&first.retained)).is_empty(), "a held group uploads no row again");
    let far = vec2(40.0 * CELL, 40.0 * CELL);
    let gone = frame(&mut view, &runtime, far, &mut assets);
    assert_eq!(groups_in(&gone), 0, "the evicted cell's group is not drawn");
    let after = plan_of(&gone, far, &assets);
    assert!(after.retained.iter().all(|span| !ids.contains(&span.group.id())), "its rows are not in the frame's table");
    assert_eq!(view.stats().groups, 0);
    // Back in view: a new build, a new group (uploaded once more), drawn again.
    let back = frame(&mut view, &runtime, near, &mut assets);
    assert_eq!(groups_in(&back), 1);
}

#[test]
fn a_cell_whose_groups_pass_the_instance_cap_is_refused_and_draws_nothing() {
    // New behaviour (STR-20): the cap the sim counts parts' instances against holds for groups.
    let mut game = Game::new(World).title("Stream scatter cap");
    game.streaming(Streaming::grid(CELL).view_radius(4.0 * CELL));
    game.cell_content(|cell, _inputs| {
        let count = if cell == CellId::new(0, 0) { genex::STREAM_CELL_INSTANCES_MAX as usize + 1 } else { 1 };
        let transforms = vec![Transform::IDENTITY; count];
        CellBuild::<()>::default().group(InstanceGroup::cubes(transforms, &Material::color(Color::WHITE)).expect("group"))
    });
    let mut runtime = Runtime::new(game).expect("valid registrations");
    runtime.seed(1);
    let mut view = view();
    let mut assets = AssetCache::default();
    let drawn = frame(&mut view, &runtime, vec2(0.5 * CELL, 0.5 * CELL), &mut assets);
    let stats = view.stats();
    assert_eq!(stats.cells_refused, 1, "{stats:?}");
    assert_eq!(drawn_transforms(&drawn).len() as u32, stats.cells_wanted - 1, "only the other cells' one-cube groups are drawn");
}

/// Milliseconds since `start`, on the wall clock (a lane timing row: advisory until a gate).
#[allow(clippy::disallowed_types, reason = "an encode timing row reads the wall clock; nothing simulated sees it")]
fn time_ms(work: impl FnOnce()) -> f64 {
    let start = std::time::Instant::now();
    work();
    start.elapsed().as_secs_f64() * 1000.0
}

fn p95(samples: &mut [f64]) -> f64 {
    samples.sort_by(f64::total_cmp);
    samples[(samples.len() * 95).div_ceil(100) - 1]
}

#[test]
fn a_50k_instance_forest_over_49_cells_holds_the_a0b_cpu_encode_budget() {
    // Accept (STR-20): the forest's frames encode as retained groups, held after their first
    // upload, at most ENCODE_SHARE_MAX of drawing every tree alone.
    let terrain = terrain();
    let in_forest = |cell: CellId| (0..FOREST_SIDE).contains(&cell.x) && (0..FOREST_SIDE).contains(&cell.z);
    let side = FOREST_SIDE as f32 * CELL;
    let centre = vec2(0.5 * side, 0.5 * side);
    let runtime = runtime(&terrain, rule(FOREST_DENSITY), in_forest, side);
    let mut view = view();
    let mut assets = AssetCache::default();
    let library = MeshLibrary::new();
    let camera = camera_at(centre);
    let warm = frame(&mut view, &runtime, centre, &mut assets);
    let trees = drawn_transforms(&warm).len();
    let stats = view.stats();
    assert_eq!(groups_in(&warm), (FOREST_SIDE * FOREST_SIDE) as usize, "one group per forest cell: {stats:?}");
    assert!((45_000..=55_000).contains(&trees), "about 50,000 trees: {trees}");
    // Every tree as its own cube: what a frame drew before retained groups.
    let alone: Vec<Transform> = warm
        .draws()
        .iter()
        .filter_map(|draw| match &draw.shape {
            Shape::Group { group, .. } => Some(group.transforms().to_vec()),
            _ => None,
        })
        .flatten()
        .collect();
    let mut held = None;
    let (mut retained_ms, mut alone_ms) = (Vec::new(), Vec::new());
    for n in 0..ENCODE_WARM_FRAMES + ENCODE_FRAMES {
        let mut plan = None;
        let ms = time_ms(|| {
            let drawn = frame(&mut view, &runtime, centre, &mut assets);
            plan = Some(FramePlan::build(&to_scene(&drawn, &camera, &assets), &library, 16.0 / 9.0).expect("plan"));
        });
        let plan = plan.expect("planned");
        if let Some(last) = &held {
            let FramePlan { retained, .. } = last;
            assert!(instance_upload_ranges(plan.instances.len(), &plan.retained, Some(retained)).is_empty(), "frame {n}: no tree row uploads again");
        }
        held = Some(plan);
        let alone_frame_ms = time_ms(|| {
            let mut drawn = Frame::default();
            for transform in &alone {
                drawn.cube(*transform, Color::rgb(60, 120, 50));
            }
            let _ = FramePlan::build(&to_scene(&drawn, &camera, &assets), &library, 16.0 / 9.0).expect("plan");
        });
        if n >= ENCODE_WARM_FRAMES {
            retained_ms.push(ms);
            alone_ms.push(alone_frame_ms);
        }
    }
    let (retained, alone) = (p95(&mut retained_ms), p95(&mut alone_ms));
    println!("forest of {trees} trees over 49 cells: CPU encode p95 {retained:.3} ms retained, {alone:.3} ms one cube each ({:.1}%)", 100.0 * retained / alone);
    assert!(retained <= ENCODE_SHARE_MAX * alone, "retained p95 {retained:.3} ms over {ENCODE_SHARE_MAX} of {alone:.3} ms");
}
