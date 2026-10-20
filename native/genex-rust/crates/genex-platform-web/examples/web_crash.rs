//! The web crash sample (game systems CRASH-3): `KeyP` panics in an update hook (one `panic`
//! record from the crash hook, then the module traps), `KeyU` traps with no panic at all (the
//! shell makes the `wasm-trap` record). Built as a wasm-bindgen `cdylib` for
//! `tests/conformance/rust-web-crash.test.ts`. On every other target it is empty.

#![cfg(target_arch = "wasm32")]

use genex::prelude::*;

#[derive(Default)]
struct World {
    ticks: u32,
}

fn game() -> Game<World> {
    let mut game = Game::new(World::default()).title("Crash").world_size(320, 180);
    game.on_update(|sim, ctx| {
        sim.world.ticks += 1;
        if ctx.keys.pressed(Key::KeyP) {
            panic!("forced panic at tick {}", sim.world.ticks);
        }
        if ctx.keys.pressed(Key::KeyU) {
            // A WebAssembly `unreachable` with no Rust panic before it (no hook runs).
            core::arch::wasm32::unreachable();
        }
    });
    game.on_draw(|_sim, frame, _camera| {
        frame.clear(Color::BACKGROUND).tag("crash");
        frame.cube(Transform::IDENTITY, Color::GREEN);
    });
    game.probe("crash", |sim| json!({ "ticks": sim.world.ticks }));
    game
}

/// Hand the game to the web shell when the module is instantiated.
#[wasm_bindgen::prelude::wasm_bindgen(start)]
pub fn start() {
    genex_platform_web::install_named("web-crash", game(), &[]);
}
