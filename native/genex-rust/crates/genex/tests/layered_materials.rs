//! AAA materials lane: the facade's layered materials and weather reach the renderer's draws: a
//! material's cover, detail maps, second layer, parallax and lobes; the frame's world cover on
//! every draw without its own (never the view model); a model's own cover; and the weather's two
//! layers and growing cover.

use genex::glam::Vec3;
use genex::present::{AssetCache, to_scene};
use genex::{Camera, Color, Cover, Frame, Layer, LayerMask, Material, Transform, Weather, WeatherKind};
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
        .with_layer(Layer::textured("textures/moss.png", "textures/moss_n.png", "textures/moss_orm.png", 2.0).masked_by(LayerMask::Up, 1.0))
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
