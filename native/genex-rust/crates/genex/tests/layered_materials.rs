//! AAA materials lane: the facade's layered materials and weather reach the renderer's draws: a
//! material's cover, detail maps, second layer, parallax and lobes; the frame's world cover on
//! every draw without its own (never the view model); a model's own cover; and the weather's two
//! layers and growing cover.

use genex::glam::Vec3;
use genex::present::{AssetCache, to_scene};
use genex::{Camera, Color, Cover, Frame, MaterialLayer, LayerMask, Material, Transform, Weather, WeatherKind};
use genex_render::layers::Cover as RenderCover;
use genex_render::scene::Scene;

fn scene_of(frame: &Frame) -> Scene {
    to_scene(frame, &Camera::DEFAULT, &AssetCache::default())
}

#[test]
fn a_material_s_cover_and_lobes_reach_its_draw() {
    let stone = Material::color(Color::rgb(110, 105, 98)).with_cover(Cover::snow(0.8, 50.0, 0.3)).with_clearcoat(1.0, 0.1).with_sheen(Color::WHITE, 0.4);
    let glass = Material::color(Color::WHITE).with_transmission(0.9);
    let mut frame = Frame::default();
    frame.cube_with(Transform::IDENTITY, &stone).cube_with(Transform::IDENTITY, &glass).cube(Transform::IDENTITY, Color::RED);
    let scene = scene_of(&frame);
    let layers = scene.draws[0].material.layers;
    assert_eq!(layers.cover, Some(RenderCover::SNOW.shaped(0.8, 50.0, 0.3)));
    assert_eq!((layers.lobes.clearcoat, layers.lobes.clearcoat_roughness), (1.0, 0.1));
    assert_eq!(layers.lobes.sheen_color, [1.0; 3]);
    assert!(scene.draws[1].material.is_transparent(), "glass draws blended");
    assert_eq!(scene.draws[2].material.layers, genex_render::layers::MaterialLayers::default(), "a plain draw layers nothing");
    assert_eq!(stone.cover().map(|c| c.amount()), Some(0.8));
}

#[test]
fn maps_that_did_not_load_are_left_out_of_the_layers() {
    let layered = Material::color(Color::WHITE)
        .with_detail("textures/grain.png", "", 8.0)
        .with_layer(MaterialLayer::textured("textures/moss.png", "textures/moss_n.png", "textures/moss_orm.png", 2.0).masked_by(LayerMask::Up, 1.0))
        .with_parallax("textures/bricks_h.png", 0.05);
    let mut frame = Frame::default();
    frame.cube_with(Transform::IDENTITY, &layered);
    let layers = scene_of(&frame).draws[0].material.layers;
    let detail = layers.detail.expect("the detail is kept");
    assert_eq!((detail.albedo, detail.normal, detail.tiles), (None, None, 8.0), "no texture loaded");
    let layer = layers.layer.expect("the layer keeps its tint and mask");
    assert_eq!((layer.mask, layer.base, layer.tiles), (LayerMask::Up, None, 2.0));
    assert_eq!(layers.parallax, None, "parallax without its height map is off");
}

#[test]
fn the_world_cover_snows_every_draw_without_its_own_but_never_the_view_model() {
    let mut frame = Frame::default();
    frame.cover_world(Cover::snow(1.0, 55.0, 0.2));
    frame.cube(Transform::IDENTITY, Color::RED);
    frame.cube_with(Transform::IDENTITY, &Material::color(Color::WHITE).with_cover(Cover::dust(0.5, 60.0, 0.4)));
    frame.cube_with(Transform::IDENTITY, &Material::color(Color::WHITE).with_cover(Cover::none()));
    frame.view_model();
    frame.cube(Transform::IDENTITY, Color::BLUE);
    frame.end_view_model();
    let scene = scene_of(&frame);
    let covers: Vec<Option<f32>> = scene.draws.iter().map(|draw| draw.material.layers.cover.map(|c| c.amount)).collect();
    assert_eq!(covers, vec![Some(1.0), Some(0.5), Some(0.0), None]);
    assert_eq!(scene.draws[1].material.layers.cover.map(|c| c.color), Some(RenderCover::DUST.color), "a material's own cover wins");
}

#[test]
fn weather_draws_its_two_layers_and_lays_its_cover_as_it_falls() {
    let snow = Weather::heavy_snow();
    assert_eq!(snow.kind(), WeatherKind::HeavySnow);
    let mut frame = Frame::default();
    frame.weather(&snow, 0.0);
    assert_eq!(frame.drawn_particles().len(), 2);
    assert_eq!(frame.world_cover(), None, "nothing is covered before it starts");
    let mut later = Frame::default();
    later.weather(&snow, WeatherKind::HeavySnow.seconds_to_cover() * 0.25);
    assert_eq!(later.world_cover().map(|c| c.amount()), Some(0.25));
    assert!(snow.layers().iter().all(|layer| layer.desc().follow_camera && layer.desc().lit > 0.0));
    assert_eq!(Weather::heavy_snow(), snow, "the same preset is the same emitters (the renderer holds them once)");
}

#[test]
fn a_model_with_its_own_cover_keeps_the_cover_on_its_glb_materials() {
    let mut frame = Frame::default();
    frame.model_with_cover(&genex::Model::default(), Transform::IDENTITY, Cover::moss(0.7, 75.0, 0.6));
    match &frame.draws()[0].shape {
        genex::Shape::Model { cover, .. } => assert_eq!(cover.map(|c| c.amount()), Some(0.7)),
        other => panic!("a model draw, not {other:?}"),
    }
    let _ = Vec3::ZERO;
}

/// The cover drawn through the presenter, as a game draws it: a wooden slab's top seen from
/// above, bare, under its own snow and under the world's.
mod gpu {
    use genex::present::Presenter;
    use genex::prelude::*;
    use genex::render::{Exposure, QualityPreset, RenderConfig};
    use genex::{FIXED_STEP_MS, Runtime, View};

    const WORLD: [u32; 2] = [128, 96];
    const WOOD: Color = Color::rgb(120, 72, 40);

    #[derive(Clone, Copy, PartialEq)]
    enum Snow {
        Bare,
        Own,
        World,
        /// Its own cover under a lamp too: the frame binds its local lights' tables.
        OwnLamplit,
    }

    fn runtime(snow: Snow, preset: QualityPreset) -> Runtime<()> {
        let mut game = Game::new(()).title("Cover").world_size(WORLD[0], WORLD[1]);
        game.render_settings(RenderConfig::new().preset(preset).exposure(Exposure::manual(0.0)));
        game.camera(|_| Camera::look_at(vec3(0.0, 4.0, 0.01), Vec3::ZERO));
        game.on_draw(move |_sim, frame, _| {
            frame.clear(Color::BLACK).sun(vec3(0.2, 1.0, 0.3), Color::WHITE, 3.0).ambient(Color::WHITE, 0.3);
            if snow == Snow::World {
                frame.cover_world(Cover::snow(1.0, 45.0, 0.0));
            }
            if snow == Snow::OwnLamplit {
                frame.point_light(vec3(2.0, 1.5, 2.0), 4.0, Color::rgb(255, 200, 140), 0.5);
            }
            let wood = Material::color(WOOD).with_roughness(0.8);
            let owned = matches!(snow, Snow::Own | Snow::OwnLamplit);
            let wood = if owned { wood.with_cover(Cover::snow(1.0, 45.0, 0.0)) } else { wood };
            frame.cube_with(Transform::IDENTITY.with_scale(vec3(6.0, 0.2, 6.0)), &wood);
        });
        let mut runtime = Runtime::new(game).expect("valid registrations");
        runtime.seed(7);
        runtime.start();
        runtime.step(5.0 * FIXED_STEP_MS);
        runtime
    }

    /// The mean luma (0..255) of `snow`'s game view at `preset`, or None without a GPU.
    fn luma(snow: Snow, preset: QualityPreset) -> Option<f32> {
        let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
        let mut presenter = match Presenter::open_with_root(WORLD, &[], None) {
            Ok(presenter) => presenter,
            Err(error) if require => panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}"),
            Err(_) => return None,
        };
        let mut runtime = runtime(snow, preset);
        presenter.set_capturing(true);
        for _ in 0..8 {
            presenter.draw_view(&mut runtime, View::Game).expect("game view").expect("drawn");
        }
        assert_eq!(presenter.failure(), None);
        let bgra = presenter.resilient.capture().expect("capture").bgra().to_vec();
        let sum: f32 = bgra.chunks(4).map(|p| 0.0722 * f32::from(p[0]) + 0.7152 * f32::from(p[1]) + 0.2126 * f32::from(p[2])).sum();
        Some(sum / (bgra.len() / 4) as f32)
    }

    #[test]
    #[ignore = "needs a GPU: run with --ignored metal"]
    fn metal_a_game_s_own_and_world_cover_whiten_a_slab_through_the_presenter() {
        for preset in [QualityPreset::Low, QualityPreset::High] {
            let Some(bare) = luma(Snow::Bare, preset) else { return };
            let own = luma(Snow::Own, preset).expect("a presenter");
            let world = luma(Snow::World, preset).expect("a presenter");
            let lamplit = luma(Snow::OwnLamplit, preset).expect("a presenter");
            println!("{}: bare {bare:.1}, own cover {own:.1}, world cover {world:.1}, own under a lamp {lamplit:.1}", preset.wire());
            assert!(own > 1.5 * bare, "a material's own cover whitens the slab at {}", preset.wire());
            assert!(world > 1.5 * bare, "the world's cover whitens the slab at {}", preset.wire());
            assert!(lamplit > 1.5 * bare, "a lamp in the frame keeps the cover at {}", preset.wire());
        }
    }
}
