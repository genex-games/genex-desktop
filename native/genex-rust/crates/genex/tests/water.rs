//! Facade water (renderer pass 2 B.3): what a draw hook declares with `frame.water` reaches the
//! renderer's scene (`Scene::water`) through the one conversion native and web share
//! (`genex::present::water_of`), on the simulation's clock, as one logical draw; a broken
//! rectangle is not drawn, and a frame without water draws none.

use genex::glam::{Vec2, Vec3};
use genex::present::{AssetCache, to_scene, water_of};
use genex::render::Water;
use genex::{Camera, FIXED_STEP_MS, Frame};
use genex_render::water::WaterMaterial;

fn lake() -> Water {
    Water::lake(Vec3::new(6.0, 0.0, 2.0), Vec2::new(28.0, 20.0))
}

#[test]
fn a_frames_water_reaches_the_scene_as_one_logical_draw_and_a_second_call_replaces_it() {
    let mut frame = Frame::default();
    frame.water(&lake());
    assert_eq!(frame.draw_calls(), 1, "the water is one logical draw");
    frame.water(&lake().with_foam(0.3));
    assert_eq!(frame.draw_calls(), 1, "a second call replaces the first");
    let scene = to_scene(&frame, &Camera::DEFAULT, &AssetCache::default());
    let water = scene.water.expect("the scene carries the frame's water");
    assert_eq!(water.body.centre, [6.0, 0.0, 2.0]);
    assert_eq!(water.body.half_extent, [28.0, 20.0]);
    assert_eq!(water.body.material, WaterMaterial { foam_width: 0.3, ..WaterMaterial::LAKE });
    assert_eq!(water.time, 0.0, "a scene bridge draws the water at its clock's start");
}

#[test]
fn a_lake_takes_the_built_in_lake_look_and_each_call_changes_its_own_term() {
    let body = |water: &Water| water_of(&{
        let mut frame = Frame::default();
        frame.water(water);
        frame
    }, 0)
    .expect("drawn")
    .body
    .material;
    assert_eq!(body(&lake()), WaterMaterial::LAKE);
    let look = lake().with_absorption([0.6, 0.2, 0.1]).with_scatter([0.03, 0.08, 0.05]).with_ripple(0.12, 0.15).with_refraction(0.03);
    let expected = WaterMaterial { absorption: [0.6, 0.2, 0.1], scatter: [0.03, 0.08, 0.05], ripple: 0.12, roughness: 0.15, refraction: 0.03, ..WaterMaterial::LAKE };
    assert_eq!(body(&look), expected);
}

#[test]
fn the_water_runs_on_the_simulations_clock() {
    let mut frame = Frame::default();
    frame.water(&lake());
    let at = |tick: u64| water_of(&frame, tick).expect("drawn").time;
    assert_eq!(at(0), 0.0);
    let expected = (90.0 * FIXED_STEP_MS / 1000.0) as f32;
    assert!((at(90) - expected).abs() < 1e-6, "tick 90 is {expected} s: {}", at(90));
    assert_eq!(at(90), at(90), "the same tick is the same water");
}

#[test]
fn hostile_rectangles_and_looks_are_not_drawn_or_are_held_to_their_ranges() {
    let hostile = [
        Water::lake(Vec3::new(f32::NAN, 0.0, 0.0), Vec2::new(4.0, 4.0)),
        Water::lake(Vec3::new(0.0, f32::INFINITY, 0.0), Vec2::new(4.0, 4.0)),
        Water::lake(Vec3::ZERO, Vec2::new(0.0, 4.0)),
        Water::lake(Vec3::ZERO, Vec2::new(4.0, -1.0)),
        Water::lake(Vec3::ZERO, Vec2::new(f32::NAN, 4.0)),
    ];
    for water in hostile {
        let mut frame = Frame::default();
        frame.water(&water);
        assert_eq!(frame.draw_calls(), 0, "{water:?}: not a draw");
        assert_eq!(water_of(&frame, 0), None, "{water:?}: no water reaches the renderer");
    }
    let wild = lake().with_absorption([f32::NAN, -1.0, 1e9]).with_scatter([-1.0, 2.0, f32::INFINITY]).with_foam(-3.0).with_ripple(f32::NAN, 9.0).with_refraction(5.0);
    let mut frame = Frame::default();
    frame.water(&wild);
    let material = water_of(&frame, 0).expect("a sound rectangle is drawn").body.material;
    for value in material.absorption.iter().chain(&material.scatter).chain(&[material.foam_width, material.ripple, material.roughness, material.refraction]) {
        assert!(value.is_finite() && *value >= 0.0, "{material:?}: every term finite and not negative");
    }
    assert!(material.scatter.iter().all(|s| *s <= 1.0), "an albedo is at most 1: {material:?}");
    assert!(material.roughness <= 1.0 && material.refraction <= genex::render::WATER_REFRACTION_MAX, "{material:?}");
}

#[test]
fn a_frame_without_water_draws_none() {
    let frame = Frame::default();
    assert_eq!(frame.drawn_water(), None);
    assert_eq!(water_of(&frame, 30), None);
    assert_eq!(to_scene(&frame, &Camera::DEFAULT, &AssetCache::default()).water, None);
}

// Through the presenter (a GPU)

mod presenter {
    use genex::prelude::*;
    use genex::present::Presenter;
    use genex::render::Water;
    use genex::{FIXED_STEP_MS, Runtime, View};

    const WORLD: [u32; 2] = [96, 64];

    #[derive(Default)]
    struct World;

    /// A game drawing a sunlit sandy bed sloping into a pond, with the pond's water or without.
    fn runtime(water: bool) -> Runtime<World> {
        let mut game = Game::new(World).title("Water").world_size(WORLD[0], WORLD[1]);
        game.camera(|_| Camera::look_at(vec3(0.0, 2.5, 6.0), vec3(0.0, -0.5, 0.0)));
        game.on_draw(move |_, frame, _| {
            frame.sun(vec3(0.3, 0.6, 0.2), Color::WHITE, 3.0).cube(Transform::from_xyz(0.0, -1.5, 0.0).with_scale(vec3(12.0, 1.0, 12.0)), Color::rgb(190, 170, 120));
            if water {
                frame.water(&Water::lake(vec3(0.0, -0.4, 0.0), vec2(4.0, 4.0)));
            }
        });
        let mut runtime = Runtime::new(game).expect("valid registrations");
        runtime.seed(7);
        runtime.start();
        runtime.step(10.0 * FIXED_STEP_MS);
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

    fn capture(presenter: &mut Presenter, runtime: &mut Runtime<World>) -> u64 {
        presenter.set_capturing(true);
        presenter.draw_view(runtime, View::Game).expect("game view").expect("drawn");
        presenter.resilient.capture().expect("capture").digest()
    }

    #[test]
    #[ignore = "needs a GPU: run with --ignored metal"]
    fn metal_a_frames_water_changes_the_picture_and_captures_the_same_every_time() {
        let Some(mut presenter) = presenter() else { return };
        let mut dry = runtime(false);
        let dry_digest = capture(&mut presenter, &mut dry);
        let mut wet = runtime(true);
        let wet_digest = capture(&mut presenter, &mut wet);
        assert_ne!(wet_digest, dry_digest, "the water draws over the bed");
        assert_eq!(capture(&mut presenter, &mut wet), wet_digest, "the same tick captures the same water");
        assert_eq!(capture(&mut presenter, &mut dry), dry_digest, "a frame without water draws as before");
        assert_eq!(presenter.failure(), None);
    }
}
