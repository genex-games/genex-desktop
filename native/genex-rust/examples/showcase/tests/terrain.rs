//! Renderer pass 2 A.7: the lakeside's ground on the built-in terrain, measured the way Live draws
//! it (genex's presenter, the game's look). A dolly across the meadow towards the lake brings the
//! far hills across the terrain's level boundaries; the same path is drawn again with the whole view
//! at the terrain's finest level (`Renderer::set_terrain_detail`, a ground without levels of
//! detail), and what the levels add is theirs: one-frame pops (luma more than 16 levels away from
//! both neighbouring frames' values within the path's motion radius, for exactly one frame) and
//! the background seen through the ground (a crack shows the far plane's depth below the horizon).
//! The game's own custom passes (grass, water, sprites, clouds) are switched off in both runs.
//!
//! The rows are `#[ignore]`d and named `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p showcase --release \
//!     --offline --locked --test terrain -- --ignored metal --nocapture --test-threads 1
//!
//! `GENEX_TERRAIN_OUT` names a folder for each run's pop map (raw BGRA, magenta where it popped).
mod support;

use genex::math::{Vec3, vec3};
use genex::present::Presenter;
use genex::render::{PresetChoice, RenderChange, RenderFeature};
use genex::{FIXED_STEP_MS, View};
use genex_render::device_class::{DeviceClass, FormFactor, PerformanceTier};
use genex_render::settings::QualityPreset;
use showcase_game::world::{CameraMode, FreeCam};
use support::{SHOT_TICK, lakeside_at};

/// A pixel pops when its luma jumps by more than this for exactly one frame (SH-15).
const POP_LEVELS: f32 = 16.0;
/// Frames drawn on the first pose before measuring (TAA and auto exposure settle).
const WARM_FRAMES: u32 = 30;
/// Frames measured along the path.
const PATH_FRAMES: u32 = 100;
/// The dolly's speed, metres a frame (a run).
const DOLLY_METRES_PER_FRAME: f32 = 0.08;
/// How far a pixel's value moves in a frame along the dolly: the motion envelope's radius.
const DOLLY_RADIUS: usize = 6;
/// The eye's height over the ground.
const EYE_HEIGHT: f32 = 1.7;
/// The whole view at the finest level: the reference ground without levels of detail.
const NO_LEVELS_DETAIL: f32 = 1000.0;

/// The camera at measured frame `k`: walking from the meadow west of the cabin towards the lake,
/// looking over it at the far hills.
fn dolly(k: f32) -> (Vec3, Vec3) {
    let start = vec3(-52.0, 0.0, 16.0);
    let toward = (vec3(10.0, 0.0, 2.0) - start).normalize();
    let at = start + toward * (k.max(0.0) * DOLLY_METRES_PER_FRAME);
    let eye = vec3(at.x, showcase_game::layout::height(at.x, at.z).max(showcase_game::layout::WATER_LEVEL) + EYE_HEIGHT, at.z);
    (eye, eye + toward * 20.0 + vec3(0.0, -1.0, 0.0))
}

/// Rec. 709 luma (0..255) of every pixel.
fn lumas(capture: &genex_render::capture::Capture) -> Vec<f32> {
    capture.bgra().chunks(4).map(|p| 0.0722 * f32::from(p[0]) + 0.7152 * f32::from(p[1]) + 0.2126 * f32::from(p[2])).collect()
}

/// Per pixel, the least and the most of `values` within `radius`.
fn envelope(values: &[f32], (width, height): (usize, usize), radius: usize) -> (Vec<f32>, Vec<f32>) {
    let mut least = vec![0.0; values.len()];
    let mut most = vec![0.0; values.len()];
    for y in 0..height {
        let (y0, y1) = (y.saturating_sub(radius), (y + radius).min(height - 1));
        for x in 0..width {
            let (x0, x1) = (x.saturating_sub(radius), (x + radius).min(width - 1));
            let (mut lo, mut hi) = (f32::INFINITY, f32::NEG_INFINITY);
            for row in y0..=y1 {
                for v in &values[row * width + x0..=row * width + x1] {
                    lo = lo.min(*v);
                    hi = hi.max(*v);
                }
            }
            least[y * width + x] = lo;
            most[y * width + x] = hi;
        }
    }
    (least, most)
}

fn holds(env: &(Vec<f32>, Vec<f32>), i: usize, value: f32) -> bool {
    env.0[i] - value <= POP_LEVELS && value - env.1[i] <= POP_LEVELS
}

/// The pixels that popped in each measured frame (frames 1..n-1).
fn pops(frames: &[Vec<f32>], size: (usize, usize)) -> Vec<Vec<usize>> {
    let envelopes: Vec<_> = frames.iter().map(|luma| envelope(luma, size, DOLLY_RADIUS)).collect();
    (1..frames.len().saturating_sub(1))
        .map(|k| {
            (0..frames[k].len())
                .filter(|&i| {
                    let value = frames[k][i];
                    let came_back = holds(&envelopes[k + 1], i, frames[k - 1][i]) || holds(&envelopes[k - 1], i, frames[k + 1][i]);
                    !holds(&envelopes[k - 1], i, value) && !holds(&envelopes[k + 1], i, value) && came_back
                })
                .collect()
        })
        .collect()
}

/// Where the ground is farther than this along a pixel's ray, its geometry may be drawn at a
/// coarser level than the finest (the lakeside's finest range is 43 m on `medium`, 54 m on `high`);
/// the rows count pops there. Nearer, both runs draw the same finest level and differ only by the
/// last bit of auto exposure, which moves a few borderline pixels across the pop threshold in one
/// run and not the other.
const FAR_GROUND_M: f32 = 35.0;
/// The far-ground mask is ray-marched once per block of this many pixels a side.
const MASK_BLOCK: usize = 8;

/// One run of the dolly: each measured frame's lumas and far-ground mask, and the terrain's
/// selection changes. None without an adapter.
struct Run {
    frames: Vec<Vec<f32>>,
    far: Vec<Vec<bool>>,
    size: (usize, usize),
    switches: u32,
}

/// Which pixels of a `size` picture from `camera` see the lakeside's ground farther than
/// [`FAR_GROUND_M`] (marched over the layout's heights, block by block).
fn far_ground(camera: &genex::Camera, size: (usize, usize)) -> Vec<bool> {
    let f = (camera.target - camera.position).normalize();
    let r = f.cross(camera.up).normalize();
    let u = r.cross(f);
    let half = genex::math::tan(camera.fovy.to_radians() * 0.5);
    let aspect = size.0 as f32 / size.1 as f32;
    let mut mask = vec![false; size.0 * size.1];
    for by in (0..size.1).step_by(MASK_BLOCK) {
        for bx in (0..size.0).step_by(MASK_BLOCK) {
            let x = ((bx + MASK_BLOCK / 2) as f32 / size.0 as f32) * 2.0 - 1.0;
            let y = 1.0 - ((by + MASK_BLOCK / 2) as f32 / size.1 as f32) * 2.0;
            let dir = (f + r * (x * half * aspect) + u * (y * half)).normalize();
            let hit = (1..800).map(|k| k as f32 * 0.25).find(|t| {
                let p = camera.position + dir * *t;
                p.y < showcase_game::layout::height(p.x, p.z).max(showcase_game::layout::WATER_LEVEL)
            });
            let far = hit.is_some_and(|t| t >= FAR_GROUND_M);
            for yy in by..(by + MASK_BLOCK).min(size.1) {
                for xx in bx..(bx + MASK_BLOCK).min(size.0) {
                    mask[yy * size.0 + xx] = far;
                }
            }
        }
    }
    mask
}

/// The lakeside drawn Live along the dolly at `preset` on desktop-high (bloom off: the sun's glare
/// is screen-space and moves alike in both runs), the terrain at `detail` over the quality's.
fn run(preset: QualityPreset, detail: Option<f32>) -> Option<Run> {
    let mut presenter = Presenter::open(showcase_game::showcase::WORLD_SIZE, showcase_game::assets()).ok()?;
    let mut runtime = lakeside_at(SHOT_TICK);
    assert!(presenter.install_for(&mut runtime).is_empty(), "every pass installs");
    // The game's own passes (grass, water, sprites, clouds) move in the wind and drift: drawn alike
    // in both runs, they are left out so the ground's own pops stand out.
    presenter.set_custom_passes_enabled(false);
    let pose = |runtime: &mut genex::Runtime<showcase_game::world::World>, k: f32| {
        let (eye, target) = dolly(k);
        let world = &mut runtime.sim_mut().world;
        world.mode = CameraMode::Free;
        world.hud_hidden = true;
        world.free = FreeCam::looking(eye, target);
    };
    pose(&mut runtime, 0.0);
    presenter.draw_view(&mut runtime, View::Game).expect("a view").expect("drawn");
    let change = RenderChange {
        preset: Some(Some(PresetChoice::Preset(preset))),
        device_class: Some(Some(DeviceClass::new(FormFactor::Desktop, PerformanceTier::High))),
        features: vec![(RenderFeature::Bloom, false)],
        render_scale_lock: Some(Some(1.0)),
        ..RenderChange::default()
    };
    presenter.render_settings().expect("the game's settings attached").borrow_mut().apply(&change);
    let mut out = Run { frames: Vec::new(), far: Vec::new(), size: (0, 0), switches: 0 };
    let mut last: Option<Vec<genex_render::terrain::TerrainRow>> = None;
    for k in 0..WARM_FRAMES + PATH_FRAMES {
        runtime.step(FIXED_STEP_MS);
        pose(&mut runtime, k as f32 - WARM_FRAMES as f32);
        // Asked every frame: a warmed renderer swapped in by the settings change starts at the
        // quality's detail.
        presenter.resilient.renderer_mut().renderer_mut().set_terrain_detail(detail);
        presenter.draw_view(&mut runtime, View::Game).expect("a view").expect("drawn");
        if k < WARM_FRAMES {
            continue;
        }
        let renderer = presenter.resilient.renderer().renderer();
        // The selection as a set: the rows' order follows the camera within each draw.
        let rows = renderer.terrain_frame().map(|frame| {
            let mut rows = frame.rows.clone();
            rows.sort();
            rows
        });
        if last.is_some() && rows != last {
            out.switches += 1;
        }
        last = rows;
        let capture = presenter.resilient.capture().expect("the Live picture");
        out.size = (capture.width() as usize, capture.height() as usize);
        out.frames.push(lumas(&capture));
        let camera = runtime.camera(View::Game).expect("the camera");
        out.far.push(far_ground(&camera, out.size));
    }
    Some(out)
}

/// The terrain's levels of detail add no one-frame pop to the lakeside along the dolly: on the
/// ground farther than [`FAR_GROUND_M`] (where a level coarser than the finest can be drawn), the
/// path pops no more with the levels than with the whole view at the finest level; the pixels
/// that pop with the levels alone are printed.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_lakeside_ground_adds_no_pop_on_a_dolly() {
    let mut rows = Vec::new();
    for preset in [QualityPreset::Medium, QualityPreset::High] {
        let (Some(levels), Some(reference)) = (run(preset, None), run(preset, Some(NO_LEVELS_DETAIL))) else {
            eprintln!("skipped: no adapter");
            return;
        };
        // The pops of each measured frame on the far ground.
        let far = |run: &Run| -> Vec<Vec<usize>> { pops(&run.frames, run.size).into_iter().enumerate().map(|(k, popped)| popped.into_iter().filter(|i| run.far[k + 1][*i]).collect()).collect() };
        let (with, without) = (far(&levels), far(&reference));
        let added: Vec<usize> = with.iter().zip(&without).map(|(a, b)| a.iter().filter(|i| !b.contains(i)).count()).collect();
        let total: usize = added.iter().sum();
        if let Some(dir) = std::env::var_os("GENEX_TERRAIN_OUT").map(std::path::PathBuf::from) {
            std::fs::create_dir_all(&dir).expect("the out folder");
            let last = &levels.frames[levels.frames.len() - 1];
            let mut map: Vec<u8> = last.iter().flat_map(|l| [*l as u8, *l as u8, *l as u8, 255]).collect();
            for (a, b) in with.iter().zip(&without) {
                for i in a.iter().filter(|i| !b.contains(i)) {
                    map[i * 4..i * 4 + 4].copy_from_slice(&[255, 0, 255, 255]);
                }
            }
            std::fs::write(dir.join(format!("lakeside-terrain-pops-{}-{}x{}.bgra", preset.wire(), levels.size.0, levels.size.1)), map).expect("the pop map");
        }
        let row = format!(
            "{}: {total} pops the levels add on the far ground over {} frames (with levels {}, without {}), {} selection changes",
            preset.wire(),
            added.len(),
            with.iter().map(Vec::len).sum::<usize>(),
            without.iter().map(Vec::len).sum::<usize>(),
            levels.switches
        );
        eprintln!("{row}");
        let counts = (with.iter().map(Vec::len).sum::<usize>(), without.iter().map(Vec::len).sum::<usize>());
        rows.push((row, counts, levels.switches));
    }
    // Where the levels draw coarser geometry, a silhouette's aliased pixel lands a pixel away from
    // the finest level's: the pixel sets cannot match exactly (2026-10-15: 3 pixels over 98 frames
    // at medium, 1 at high, `wp-A.7.md`), so the row holds the count: the levels never pop more.
    for (row, (with, without), switches) in rows {
        assert!(switches > 0, "the dolly changes the terrain's selection: {row}");
        assert!(with <= without, "the terrain's levels popped: {row}");
    }
}
