//! Batched lines (NAV-15): `frame.lines(&points, color)` draws many segments (pairs of points) as
//! one logical draw, in `draw_calls()`, the frame's tags and the renderer's scene, and draws the
//! same pixels as the same segments through `frame.line`.

use genex::glam::Vec3;
use genex::present::{AssetCache, to_scene};
use genex::{Camera, Color, Frame};

/// Segments in the large rows.
const SEGMENTS: usize = 10_000;
/// The tag draws count under until the game names one (`frame.tag`).
const DEFAULT_TAG: &str = "world";

/// `count` segments on a 100-column grid in the ground plane, alternating two directions.
fn grid_points(count: usize) -> Vec<Vec3> {
    (0..count)
        .flat_map(|n| {
            let (x, z) = ((n % 100) as f32 * 0.05 - 2.5, (n / 100) as f32 * 0.05 - 2.5);
            let to = if n % 2 == 0 { Vec3::new(x + 0.04, 0.0, z) } else { Vec3::new(x, 0.0, z + 0.04) };
            [Vec3::new(x, 0.0, z), to]
        })
        .collect()
}

fn one_by_one(points: &[Vec3], color: Color) -> Frame {
    let mut frame = Frame::default();
    for [from, to] in points.as_chunks::<2>().0 {
        frame.line(*from, *to, color);
    }
    frame
}

fn batched(points: &[Vec3], color: Color) -> Frame {
    let mut frame = Frame::default();
    frame.lines(points, color);
    frame
}

#[test]
fn ten_thousand_segments_through_frame_line_count_ten_thousand_draws() {
    // Characterizes `frame.line`: one logical draw per segment, as before NAV-15.
    let frame = one_by_one(&grid_points(SEGMENTS), Color::GREEN);
    assert_eq!(frame.draw_calls(), SEGMENTS as u32);
    assert_eq!(frame.tags().get(DEFAULT_TAG), Some(&(SEGMENTS as u32)));
    assert_eq!(to_scene(&frame, &Camera::DEFAULT, &AssetCache::default()).logical_draws(), SEGMENTS as u32);
}

#[test]
fn ten_thousand_segments_through_frame_lines_count_one_draw_and_reach_the_scene_whole() {
    let points = grid_points(SEGMENTS);
    let frame = batched(&points, Color::GREEN);
    assert_eq!(frame.draw_calls(), 1, "one logical draw for the whole batch");
    assert_eq!(frame.tags().get(DEFAULT_TAG), Some(&1));
    let scene = to_scene(&frame, &Camera::DEFAULT, &AssetCache::default());
    assert_eq!(scene.logical_draws(), 1);
    let single = to_scene(&one_by_one(&points, Color::GREEN), &Camera::DEFAULT, &AssetCache::default());
    assert_eq!(scene.lines.len(), 2 * SEGMENTS);
    assert_eq!(scene.lines, single.lines, "the same vertices, in the same order, as one segment at a time");
}

#[test]
fn a_batch_counts_under_the_tag_current_when_drawn() {
    let mut frame = Frame::default();
    frame.tag("nav").lines(&grid_points(3), Color::RED).tag("hud").line(Vec3::ZERO, Vec3::X, Color::WHITE);
    assert_eq!(frame.draw_calls(), 2);
    assert_eq!(frame.tags().get("nav"), Some(&1));
    assert_eq!(frame.tags().get("hud"), Some(&1));
}

#[test]
fn a_trailing_point_is_dropped_and_no_segment_draws_nothing() {
    let mut points = grid_points(2);
    points.push(Vec3::ONE);
    let frame = batched(&points, Color::WHITE);
    assert_eq!(frame.draw_calls(), 1);
    assert_eq!(to_scene(&frame, &Camera::DEFAULT, &AssetCache::default()).lines.len(), 4, "the odd point is not half a segment");
    for empty in [&[][..], &[Vec3::ONE][..]] {
        let frame = batched(empty, Color::WHITE);
        assert_eq!(frame.draw_calls(), 0, "no segment, no draw");
        assert!(frame.draws().is_empty());
        assert!(to_scene(&frame, &Camera::DEFAULT, &AssetCache::default()).lines.is_empty());
    }
}

#[test]
fn an_empty_nav_debug_overlay_draws_nothing() {
    let nav = genex::nav::Nav::default();
    let mut frame = Frame::default();
    frame.nav_debug(&nav, genex::nav::NavDebug::default());
    assert_eq!(frame.draw_calls(), 0);
}

// Through the presenter (a GPU)

mod presenter {
    use super::{SEGMENTS, grid_points};
    use genex::prelude::*;
    use genex::present::Presenter;
    use genex::{FIXED_STEP_MS, Runtime, View};

    const WORLD: [u32; 2] = [256, 160];

    #[derive(Default)]
    struct World;

    /// A game drawing a lit floor and the grid of segments, one at a time or as one batch.
    fn runtime(batch: bool) -> Runtime<World> {
        let mut game = Game::new(World).title("Lines").world_size(WORLD[0], WORLD[1]);
        game.camera(|_| Camera::look_at(vec3(0.0, 3.0, 3.5), Vec3::ZERO));
        game.on_draw(move |_, frame, _| {
            frame.sun(vec3(0.3, 0.6, 0.2), Color::WHITE, 3.0).cube(Transform::from_xyz(0.0, -0.51, 0.0).with_scale(vec3(6.0, 1.0, 6.0)), Color::rgb(60, 60, 70));
            let points = grid_points(SEGMENTS);
            let color = Color::rgb(80, 220, 120);
            if batch {
                frame.lines(&points, color);
            } else {
                for [from, to] in points.as_chunks::<2>().0 {
                    frame.line(*from, *to, color);
                }
            }
        });
        let mut runtime = Runtime::new(game).expect("valid registrations");
        runtime.seed(1);
        runtime.start();
        runtime.step(FIXED_STEP_MS);
        runtime
    }

    fn presenter() -> Option<Presenter> {
        let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
        match Presenter::open_with_root(WORLD, &[], None) {
            Ok(presenter) => Some(presenter),
            Err(error) if require => panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}"),
            Err(_) => None,
        }
    }

    fn capture(presenter: &mut Presenter, runtime: &mut Runtime<World>, name: &str) -> Vec<u8> {
        presenter.set_capturing(true);
        presenter.draw_view(runtime, View::Game).expect("game view").expect("drawn");
        let bgra = presenter.resilient.capture().expect("capture").bgra().to_vec();
        if let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") {
            let _ = std::fs::create_dir_all(&dir);
            std::fs::write(std::path::Path::new(&dir).join(format!("{name}-{}x{}.bgra", WORLD[0], WORLD[1])), &bgra).expect("evidence");
        }
        bgra
    }

    #[test]
    #[ignore = "needs a GPU: run with --ignored metal"]
    fn metal_a_frame_lines_capture_equals_the_frame_line_capture_byte_for_byte() {
        let Some(mut presenter) = presenter() else { return };
        let mut single = runtime(false);
        let single_bgra = capture(&mut presenter, &mut single, "lines-one-by-one");
        assert_eq!(single.state()["__render"]["drawCalls"], json!(1 + SEGMENTS));
        let mut batch = runtime(true);
        let batch_bgra = capture(&mut presenter, &mut batch, "lines-batched");
        assert_eq!(batch.state()["__render"]["drawCalls"], json!(2), "the floor and one batch");
        assert!(single_bgra == batch_bgra, "frame.lines draws the pixels frame.line draws");
        assert_eq!(presenter.failure(), None);
    }
}
