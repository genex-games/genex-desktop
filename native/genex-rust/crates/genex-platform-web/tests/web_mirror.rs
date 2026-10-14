//! The saves mirror in a wasm32 build (M2.9), run by wasm-bindgen-test-runner: a browser's process
//! saves to the in-memory mirror (no file system exists there), a game's state answers its account
//! and a refused flush's `save-quota`. Empty on every other target (`saves_mirror.rs` covers the
//! mirror natively).

#![cfg(target_arch = "wasm32")]

use genex::Runtime;
use genex::prelude::*;
use genex_core::saves::mirror;
use genex_platform_web::GameHandle;
use wasm_bindgen_test::wasm_bindgen_test;

#[derive(Default)]
struct World {
    loaded: u32,
}

fn saving_game() -> Runtime<World> {
    let mut game = Game::new(World::default()).world_size(64, 64);
    game.on_reset(|sim, _seed, _rng, gfx| {
        sim.world.loaded = gfx.load("n.bin").map_or(0, |bytes| u32::from(bytes.first().copied().unwrap_or(0)));
    });
    game.on_update(|_sim, ctx| {
        if ctx.keys.pressed(Key::Space) {
            ctx.save("n.bin", &[9]);
        }
    });
    game.probe("loaded", |sim| json!(sim.world.loaded));
    Runtime::new(game).expect("a valid game")
}

#[wasm_bindgen_test]
fn a_browser_process_saves_into_the_mirror() {
    mirror::preload(vec![("n.bin".to_owned(), vec![4])]);
    let mut runtime = saving_game();
    assert!(runtime.saves().is_mirrored(), "wasm32 is the web destination");
    assert_eq!(runtime.state()["loaded"], 4, "the first reset read the preloaded save");
    runtime.inject(Input::key_tap(Key::Space));
    runtime.step(17.0);
    assert_eq!(mirror::take_dirty(), vec![("n.bin".to_owned(), vec![9])]);
}

#[wasm_bindgen_test]
fn a_refused_flush_is_save_quota_in_the_game_state() {
    mirror::preload(Vec::new());
    let mut runtime = saving_game();
    runtime.inject(Input::key_tap(Key::Space));
    runtime.step(17.0);
    let taken: Vec<String> = mirror::take_dirty().into_iter().map(|(name, _)| name).collect();
    mirror::flushed(Err((mirror::MirrorError::Quota, taken)));
    let state = GameHandle::state(&runtime);
    assert_eq!(state["error"], "save-quota");
    assert_eq!(state["volatile"]["saves"]["pending"], 1);
}
