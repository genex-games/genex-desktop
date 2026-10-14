//! The web saves sample (M2.9): a counter that `Space` raises and saves, read back by the reset
//! hook. Built as a wasm-bindgen `cdylib` for `tests/conformance/rust-web.test.ts`, which proves
//! the IndexedDB mirror holds a save across a reload (the shell loads it before the first reset)
//! and that a quota error surfaces as `save-quota`. On every other target it is empty.

#![cfg(target_arch = "wasm32")]

use genex::prelude::*;

/// The save the counter lives in.
const SAVE: &str = "count.bin";

#[derive(Default)]
struct World {
    count: u32,
    loaded: u32,
}

fn read_count(bytes: Option<Vec<u8>>) -> u32 {
    bytes.and_then(|bytes| <[u8; 4]>::try_from(bytes.as_slice()).ok()).map_or(0, u32::from_le_bytes)
}

fn game() -> Game<World> {
    let mut game = Game::new(World::default()).title("Saves").world_size(320, 180);
    game.on_reset(|sim, _seed, _rng, gfx| {
        let count = read_count(gfx.load(SAVE));
        sim.world.count = count;
        sim.world.loaded = count;
    });
    game.on_update(|sim, ctx| {
        if ctx.keys.pressed(Key::Space) {
            sim.world.count += 1;
            ctx.save(SAVE, &sim.world.count.to_le_bytes());
        }
    });
    game.on_draw(|sim, frame, _camera| {
        frame.clear(Color::BACKGROUND).tag("counter");
        for step in 0..sim.world.count.min(8) {
            let at = Vec3::new(step as f32 * 1.5 - 5.0, 0.0, 0.0);
            frame.cube(Transform { translation: at, ..Transform::IDENTITY }, Color::GREEN);
        }
    });
    game.probe("saves", |sim| json!({ "count": sim.world.count, "loaded": sim.world.loaded }));
    game
}

/// Hand the game to the web shell when the module is instantiated.
#[wasm_bindgen::prelude::wasm_bindgen(start)]
pub fn start() {
    genex_platform_web::install_named("web-saves", game(), &[]);
}
