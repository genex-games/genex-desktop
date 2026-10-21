//! NAV-16: `frame.nav_debug(&nav, NavDebug)` draws genex-nav's debug segments as one logical draw
//! (one `frame.lines` batch), whatever the mesh's size, and nothing for the default `NavDebug`.

use genex::glam::{Vec3, vec3};
use genex::nav::{Nav, NavArea, NavConfig, NavDebug, NavInput, NavMesh};
use genex::present::{AssetCache, to_scene};
use genex::{Camera, Frame};

/// A flat 24 x 24 m floor over 8 m tiles: 3x3 tiles, stitched by an update.
fn tiled_nav() -> Nav {
    let config = NavConfig::walker(0.4, 1.8).with_tile(8.0);
    let v = |x: f32, z: f32| vec3(x, 0.0, z);
    let vertices = [v(0.0, 0.0), v(24.0, 0.0), v(24.0, 24.0), v(0.0, 24.0)];
    let input = NavInput::new().with_triangles(&vertices, &[0, 2, 1, 0, 3, 2], NavArea::WALK).expect("the floor");
    let mut nav = Nav::new(&config);
    nav.add_mesh(&NavMesh::bake(&input, &config).expect("the bake")).expect("the tiles");
    nav.update(1.0 / 60.0);
    nav
}

#[test]
fn a_tiled_mesh_draws_as_one_logical_draw_with_every_segment() {
    let nav = tiled_nav();
    assert_eq!(nav.tile_count(), 9);
    for debug in [NavDebug::mesh(), NavDebug::borders(), NavDebug::everything()] {
        let expected: Vec<Vec3> = genex_nav::debug::segments(&nav, debug).into_iter().flatten().collect();
        assert!(!expected.is_empty(), "{debug:?} draws the floor");
        let mut frame = Frame::default();
        frame.nav_debug(&nav, debug);
        assert_eq!(frame.draw_calls(), 1, "{debug:?}: one logical draw");
        let scene = to_scene(&frame, &Camera::DEFAULT, &AssetCache::default());
        assert_eq!(scene.logical_draws(), 1);
        assert_eq!(scene.lines.len(), expected.len(), "{debug:?}: every segment reaches the scene");
        let mut same = Frame::default();
        same.lines(&expected, genex::Color::GREEN);
        assert_eq!(scene.lines, to_scene(&same, &Camera::DEFAULT, &AssetCache::default()).lines, "{debug:?}: the segments, in order");
    }
}

#[test]
fn the_default_overlay_draws_nothing_even_on_a_tiled_mesh() {
    let mut frame = Frame::default();
    frame.nav_debug(&tiled_nav(), NavDebug::default());
    assert_eq!(frame.draw_calls(), 0);
}
