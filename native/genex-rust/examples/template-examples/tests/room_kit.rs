//! The room kit recipe (`src/game-template-rust/docs/examples/room-kit/room_kit.py`): the GLB that
//! `blender__model` exports from it, drawn as the recipe says (`frame.model` at the identity, the
//! interior example's sun, sky, probe, volume and look), so its world-scale UVs keep each scan at
//! its real size on walls, reveals and sills. The kit is made outside cargo, by Blender: the row
//! reads `kit/room-kit.glb` from `GENEX_EXAMPLES_ASSETS` and skips without it.
//!
//!   GENEX_REQUIRE_METAL=1 GENEX_EXAMPLES_ASSETS=<assets> node scripts/toolchains/rust-env.ts -- \
//!     cargo test -p template-examples --release --offline --locked --test room_kit -- --ignored metal --nocapture

mod support;

use genex::prelude::*;
use genex::render::{Environment, Fog, IrradianceVolume, QualityPreset, ReflectionProbe, RenderConfig};
use genex::{FIXED_STEP_MS, Runtime, View};

const WORLD_SIZE: [u32; 2] = [1280, 720];
const KIT: &str = "kit/room-kit.glb";

#[derive(Default)]
struct Room {
    kit: Option<Model>,
}

fn room() -> Game<Room> {
    let mut game = Game::new(Room::default()).title("Room kit").world_size(WORLD_SIZE[0], WORLD_SIZE[1]);
    game.render_settings(RenderConfig::new().fog(Fog::default().with_density(0.012)));
    game.on_reset(|sim, _, _, gfx| sim.world.kit = Some(gfx.assets().model(KIT)));
    game.on_draw(|sim, frame, _camera| {
        frame.sun(vec3(0.35, 0.32, 1.0), Color::WHITE, 3.0).environment(Environment::sky());
        let (min, max) = (vec3(-4.0, 0.0, -3.0), vec3(4.0, 3.2, 3.0));
        frame.reflection_probe(&ReflectionProbe::new(min, max).with_capture(vec3(0.0, 1.6, 0.0)).with_blend(0.25));
        frame.irradiance_volume(&IrradianceVolume::new(min, max).with_blend(0.25));
        frame.point_light(vec3(0.0, 2.9, 0.0), 6.0, Color::rgb(220, 235, 255), 1.5);
        if let Some(kit) = &sim.world.kit {
            frame.tag("shell").model(kit, Transform::IDENTITY);
        }
    });
    game.camera(|_| Camera { fovy: 62.0, ..Camera::look_at(vec3(-3.3, 1.6, -2.4), vec3(1.2, 1.1, 2.4)) });
    game.named_camera("reveal", |_| Camera { fovy: 50.0, ..Camera::look_at(vec3(-0.5, 1.4, 1.2), vec3(-2.0, 1.4, 3.1)) });
    game
}

#[test]
#[ignore = "needs a GPU and the Blender-made kit: run with --ignored metal"]
fn metal_the_blender_room_kit_draws_with_world_scale_uvs() {
    let assets = support::assets(&[]);
    if !assets.iter().any(|(name, _)| *name == KIT) {
        return eprintln!("skipped: no {KIT} in GENEX_EXAMPLES_ASSETS (run the recipe's script in Blender first)");
    }
    let Some(mut presenter) = support::presenter(WORLD_SIZE, assets) else { return };
    let mut runtime = Runtime::with_assets(room(), Box::new(assets)).expect("installs");
    runtime.seed(1);
    runtime.start();
    runtime.step(FIXED_STEP_MS * 10.0);
    assert!(presenter.install_for(&mut runtime).is_empty());
    for (view, name) in [(View::Game, "room-kit"), (View::Named("reveal"), "room-kit-reveal")] {
        let luma = support::shoot(&mut presenter, &mut runtime, view, QualityPreset::High, name);
        assert!((20.0..235.0).contains(&luma), "{name}: {luma}");
    }
    let state = runtime.state();
    assert!(state["__render"].get("missingModels").is_none(), "{:?}", state["__render"]);
}
