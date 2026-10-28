//! The look recipes (`src/game-template-rust/docs/examples/looks`) as a game gets them: every scene
//! type wires, keeps its scene over a seed, draws the stage with its probe and volume, its lamps by
//! night and its weather, and (on the host GPU) settles at ultra inside its luma band
//! (`Scene::luma`, the bands `docs/look-recipes.md` lists), and stays readable at low:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- \
//!     cargo test -p template-examples --release --offline --locked --test looks -- --ignored metal --nocapture
//!
//! The ultra captures are the example's golden frames (`docs/examples/looks/captures/<scene>.jpg`).

#[path = "../../../../../src/game-template-rust/docs/examples/looks/src/game.rs"]
mod game;
#[path = "../../../../../src/game-template-rust/docs/examples/looks/src/looks.rs"]
mod looks;
mod support;

use genex::render::{QualityPreset, RenderConfig};
use genex::{FIXED_STEP_MS, Game, Runtime, View};

use game::World;
use looks::Scene;

const GENEX_TOML: &str = include_str!("../../../../../src/game-template-rust/docs/examples/looks/genex.toml");
const WORLD_SIZE: [u32; 2] = [1280, 720];

/// The stage for `scene` as its `main.rs` builds it, with its genex.toml's `[render]` as a lane build reads it.
fn stage(scene: Scene) -> Game<World> {
    let mut game = Game::new(World::default()).title("Looks").world_size(WORLD_SIZE[0], WORLD_SIZE[1]);
    game.render_settings(scene.look(RenderConfig::from_toml(GENEX_TOML).expect("the example's [render] is admitted")));
    game::wire(&mut game, scene);
    game
}

fn started(scene: Scene) -> Runtime<World> {
    let mut runtime = Runtime::with_assets(stage(scene), Box::new(support::assets(&[]))).expect("the example installs");
    runtime.seed(1);
    runtime.start();
    runtime.step(FIXED_STEP_MS * 30.0);
    runtime
}

#[test]
fn every_scene_draws_the_stage_on_a_terrain_with_its_room_probe_and_volume() {
    for scene in Scene::ALL {
        let mut runtime = started(scene);
        let frame = runtime.frame(View::Game).expect("a frame");
        let tags: Vec<&str> = frame.draws().iter().map(|draw| draw.tag.as_str()).collect();
        for tag in ["room", "street"] {
            assert!(tags.contains(&tag), "{} draws {tag}", scene.name());
        }
        assert!(frame.drawn_terrain().is_some(), "{} stands on a terrain, never a box", scene.name());
        let lights = frame.lights();
        assert_eq!((lights.reflection_probes.len(), lights.irradiance_volumes.len()), (1, 1), "{}: one probe and one volume on the room", scene.name());
        assert!(frame.declared_environment().is_some(), "{} declares its sky", scene.name());
        assert_eq!(runtime.state()["look"]["scene"], scene.name(), "the probe names the scene");
    }
}

#[test]
fn only_snow_and_rain_draw_weather_and_only_the_night_lights_its_lamps() {
    for scene in Scene::ALL {
        let mut runtime = started(scene);
        let frame = runtime.frame(View::Game).expect("a frame");
        let weather = matches!(scene, Scene::OvercastSnow | Scene::Rain);
        assert_eq!(frame.drawn_particles().len(), usize::from(weather), "{} weather", scene.name());
        let lamps = frame.lights().points.len() + frame.lights().spots.len();
        assert_eq!(lamps > 0, scene.night(), "{} lamps lit only by night ({lamps})", scene.name());
    }
}

#[test]
fn a_seed_keeps_the_scene_and_its_weather() {
    for scene in [Scene::OvercastSnow, Scene::Rain, Scene::ExteriorDay] {
        let mut runtime = started(scene);
        runtime.seed(2);
        runtime.step(FIXED_STEP_MS * 10.0);
        let state = runtime.state();
        assert_eq!(state["look"]["scene"], scene.name());
        let weather = matches!(scene, Scene::OvercastSnow | Scene::Rain);
        assert_eq!(state["look"]["weather"], weather, "{} falls only with weather", scene.name());
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_every_scene_settles_inside_its_luma_band_at_ultra_and_reads_at_low() {
    let mut misses = Vec::new();
    for scene in Scene::ALL {
        let Some(mut presenter) = support::presenter(WORLD_SIZE, support::assets(&[])) else { return };
        let mut runtime = started(scene);
        assert!(presenter.install_for(&mut runtime).is_empty());
        let [lo, hi] = scene.luma();
        let ultra = support::shoot(&mut presenter, &mut runtime, View::Game, QualityPreset::Ultra, scene.name());
        let low = support::shoot(&mut presenter, &mut runtime, View::Game, QualityPreset::Low, scene.name());
        eprintln!("{} ultra {ultra:.1} (band {lo}..{hi}), low {low:.1}", scene.name());
        if !(lo..=hi).contains(&ultra) {
            misses.push(format!("{} at ultra: {ultra:.1} outside {lo}..{hi}", scene.name()));
        }
        if !(10.0..245.0).contains(&low) {
            misses.push(format!("{} at low is black or blown out: {low:.1}", scene.name()));
        }
    }
    assert!(misses.is_empty(), "{misses:#?}");
}
