//! Lazy slot bodies on the web (G6 UIS-12): the mirror keeps a `.sav` body's name and size only,
//! a load asks the shell for the body and holds the tick (zero ticks per step) until it arrives,
//! and the replay after it equals a run whose body was resident before the load. A body that never
//! arrives is `save-load-timeout` on the injected clock and ticks resume; a body the store does not
//! keep is `save-slot-missing` at once. `state().volatile.saves` keeps the facade's account and
//! takes the shell's persistent-storage answer.
//!
//! The defect row: `with_saves` replaced a slotted game's `volatile.saves` with the mirror's
//! shorter account. The others are new behaviour (section 0 of the game systems plan).
//!
//! Off wasm32 the runtime stands in for a page through `Runtime::use_web_saves`: the mirror and
//! the slot driver are the same code a web build runs. On wasm32 the same rows run inline under
//! `wasm-bindgen-test-runner` (Node), where `use_web_saves` changes nothing.

use std::cell::Cell;
use std::rc::Rc;

use genex::prelude::*;
use genex::saves::SaveConfig;
use genex::{FIXED_STEP_MS, Runtime};
use genex_core::saves::mirror;
use genex_platform_web::web_saves::{saves_state, set_persistent, with_saves};

const SAVE_TICK: u64 = 120;
const LOAD_TICK: u64 = 200;
const END_TICK: u64 = 400;
const SLOT: &str = "camp";
/// How long a holding test waits for the body, in steps (each one runs no tick).
const HOLD_STEPS: u32 = 5;

/// A camp whose fire and wood come from the tick rng.
#[derive(Default)]
struct World {
    wood: u32,
    fire: u32,
    sparks: Vec<u32>,
    /// The refused slot operations the hooks saw, as `op:code` (never probed, never saved).
    refused: Vec<String>,
}

/// The camp, saving `SLOT` on the tick before `SAVE_TICK` when `saves` (the first page only) and
/// loading it on `KeyL`.
fn camp(saves: bool) -> Game<World> {
    let mut game = Game::new(World::default()).title("Camp").world_size(320, 240);
    game.saves(SaveConfig::schema(1).autosave(1_000, 2));
    camp_section(&mut game);
    game.on_reset(|sim, seed, rng, _gfx| sim.world.wood = seed % 5 + rng.below(9));
    game.on_update(move |sim, ctx| {
        let w = &mut sim.world;
        for event in ctx.slots().events() {
            if let Err(error) = &event.result {
                w.refused.push(format!("{}:{}", event.op.wire(), error.code.wire()));
            }
        }
        if ctx.rng.below(4) == 0 {
            w.wood += 1;
        }
        if ctx.tick.is_multiple_of(11) && w.wood > 0 {
            w.wood -= 1;
            w.fire += ctx.rng.below(3);
            w.sparks.push(ctx.rng.below(100));
        }
        if saves && ctx.tick + 1 == SAVE_TICK {
            ctx.slots().save(SLOT, "Night 1").expect("the save is queued");
        }
        if ctx.keys.pressed(Key::KeyL) {
            ctx.slots().load(SLOT).expect("the load is queued");
        }
    });
    game.probe("camp", |sim| json!({ "wood": sim.world.wood, "fire": sim.world.fire, "sparks": sim.world.sparks }));
    game
}

/// The whole camp as one section (this crate has no serde derive).
fn camp_section(game: &mut Game<World>) {
    game.save_section("camp", |sim| json!([sim.world.wood, sim.world.fire, sim.world.sparks]), |sim, value, _gfx| {
        let parts: (u32, u32, Vec<u32>) = serde_json::from_value(value.clone()).map_err(|error| error.to_string())?;
        (sim.world.wood, sim.world.fire, sim.world.sparks) = parts;
        Ok(())
    });
}

fn page(game: Game<World>) -> Runtime<World> {
    let mut rt = Runtime::new(game).expect("the camp installs");
    rt.use_web_saves();
    rt.seed(1);
    rt
}

fn run_to(rt: &mut Runtime<World>, tick: u64) {
    while rt.tick() < tick {
        rt.step(FIXED_STEP_MS);
    }
}

/// The files the first page saved, as IndexedDB would hold them after its flush.
fn first_page_files() -> Vec<(String, Vec<u8>)> {
    mirror::preload(Vec::new());
    let mut rt = page(camp(true));
    run_to(&mut rt, SAVE_TICK + 1);
    let files = mirror::take_dirty();
    mirror::flushed(Ok(()));
    assert!(files.iter().any(|(name, _)| name.ends_with(".sav")), "the slot body was saved: {files:?}");
    files
}

/// A second page booted as the shell boots one: every file but the `.sav` bodies preloaded, the
/// bodies indexed by name and size only.
fn second_page(files: &[(String, Vec<u8>)]) -> Runtime<World> {
    let (bodies, rest): (Vec<_>, Vec<_>) = files.iter().cloned().partition(|(name, _)| name.ends_with(".sav"));
    mirror::preload(rest);
    mirror::preload_index(bodies.iter().map(|(name, bytes)| (name.clone(), bytes.len() as u64)).collect());
    page(camp(false))
}

fn body_of(files: &[(String, Vec<u8>)]) -> (String, Vec<u8>) {
    files.iter().find(|(name, _)| name.ends_with(".sav")).cloned().expect("a body")
}

/// Tap `KeyL`: the load is queued on this tick and swapped in before the next.
fn press_load(rt: &mut Runtime<World>) {
    rt.inject(Input::key_tap(Key::KeyL));
    rt.step(FIXED_STEP_MS);
}

fn last_load(rt: &Runtime<World>) -> serde_json::Value {
    rt.state()["volatile"]["saves"]["lastLoad"].clone()
}

fn saves_text(rt: &Runtime<World>) -> String {
    rt.state()["volatile"]["saves"].to_string()
}

#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
fn a_lazy_body_holds_the_tick_until_it_arrives_and_the_replay_equals_the_preloaded_body_run() {
    let files = first_page_files();
    let (name, body) = body_of(&files);

    // The preloaded-body run: the body is resident before the load asks for it.
    let mut resident = second_page(&files);
    assert!(mirror::provide(&name, body.clone()));
    run_to(&mut resident, LOAD_TICK);
    press_load(&mut resident);
    run_to(&mut resident, END_TICK);
    assert_eq!(last_load(&resident)["checksumMatch"], true, "{}", saves_text(&resident));

    // The lazy run: the load asks for the body and holds the tick until the shell provides it.
    let mut lazy = second_page(&files);
    assert_eq!(mirror::status().lazy, 1, "only the body's name and size are known");
    run_to(&mut lazy, LOAD_TICK);
    press_load(&mut lazy);
    let held = lazy.tick();
    for _ in 0..HOLD_STEPS {
        assert_eq!(lazy.step(FIXED_STEP_MS).ticks, 0, "a load waiting for its body runs no tick");
    }
    assert_eq!(lazy.tick(), held);
    assert_eq!(lazy.state()["volatile"]["saves"]["lazy"], 1);
    assert_eq!(mirror::take_requests(), vec![name.clone()], "the body is asked of the shell once");
    assert!(mirror::take_requests().is_empty());
    assert!(mirror::provide(&name, body));
    run_to(&mut lazy, END_TICK);

    assert_eq!(last_load(&lazy), last_load(&resident));
    assert_eq!(lazy.checksum(), resident.checksum(), "the replay never depends on when the body arrived");
    assert_eq!(lazy.probes(), resident.probes());
}

#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
fn a_body_that_never_arrives_is_save_load_timeout_and_ticks_resume() {
    let files = first_page_files();
    let mut rt = second_page(&files);
    let now = Rc::new(Cell::new(0_u64));
    let clock = Rc::clone(&now);
    rt.use_saves_clock(Box::new(move || clock.get()));
    run_to(&mut rt, LOAD_TICK);
    let before = rt.checksum();
    press_load(&mut rt);
    let held = rt.tick();
    assert_eq!(rt.step(FIXED_STEP_MS).ticks, 0, "the load holds");
    now.set(genex::saves::SAVE_LOAD_HOLD_MAX_MS - 1);
    assert_eq!(rt.step(FIXED_STEP_MS).ticks, 0, "still within the hold");
    now.set(genex::saves::SAVE_LOAD_HOLD_MAX_MS);
    assert_eq!(rt.step(FIXED_STEP_MS).ticks, 1, "past the hold the tick runs again");
    assert_eq!(rt.tick(), held + 1);
    assert_eq!(last_load(&rt), serde_json::Value::Null, "nothing was restored");
    assert_ne!(rt.checksum(), before, "the running game went on");
    // The refusal reaches the hooks as the load's event in the tick after it.
    rt.step(FIXED_STEP_MS);
    assert_eq!(rt.sim().world.refused, vec!["load:save-load-timeout".to_owned()]);
}

#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
fn a_body_the_store_does_not_keep_is_save_slot_missing_at_once() {
    let files = first_page_files();
    let (name, _) = body_of(&files);
    let mut rt = second_page(&files);
    run_to(&mut rt, LOAD_TICK);
    press_load(&mut rt);
    let held = rt.tick();
    assert_eq!(rt.step(FIXED_STEP_MS).ticks, 0);
    assert_eq!(mirror::take_requests(), vec![name.clone()]);
    assert!(genex_platform_web::web_saves::provide(&name, None), "a missing body settles the request");
    assert_eq!(rt.step(FIXED_STEP_MS).ticks, 1, "the load refused; the tick runs");
    assert_eq!(rt.tick(), held + 1);
    assert_eq!(last_load(&rt), serde_json::Value::Null);
    rt.step(FIXED_STEP_MS);
    assert_eq!(rt.sim().world.refused, vec!["load:save-slot-missing".to_owned()]);
}

#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
fn the_shell_cannot_plant_or_drop_a_resident_file_through_provide() {
    mirror::preload(vec![("best.bin".to_owned(), vec![1, 2])]);
    mirror::preload_index(vec![("slots/a.sav".to_owned(), 3)]);
    assert!(!genex_platform_web::web_saves::provide("best.bin", None), "a resident file is not lazy");
    assert!(!genex_platform_web::web_saves::provide("best.bin", Some(vec![9])));
    assert!(!genex_platform_web::web_saves::provide("slots/unknown.sav", Some(vec![9])), "an unknown body is not planted");
    assert!(!genex_platform_web::web_saves::provide("../x.sav", None));
    assert_eq!(mirror::status().files, 2);
    assert!(genex_platform_web::web_saves::provide("slots/a.sav", Some(vec![7, 7, 7])));
    assert!(mirror::is_resident("slots/a.sav"));
}

#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
fn a_suspend_save_writes_the_oldest_autosave_once_per_call_into_the_mirror() {
    mirror::preload(Vec::new());
    let mut rt = page(camp(true));
    run_to(&mut rt, 30);
    let written = rt.suspend_save().expect("the camp autosaves").expect("written");
    assert_eq!(written.name.as_str(), "autosave-0");
    assert_eq!(written.tick, 30);
    let dirty: Vec<String> = mirror::take_dirty().into_iter().map(|(name, _)| name).collect();
    assert_eq!(dirty.iter().filter(|name| name.ends_with(".sav")).count(), 1, "{dirty:?}");
    mirror::flushed(Ok(()));
    let mut quiet = Game::new(World::default());
    quiet.saves(SaveConfig::schema(1));
    camp_section(&mut quiet);
    let mut no_ring = page(quiet);
    assert!(no_ring.suspend_save().is_none(), "no ring, nothing to write");
}

#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
fn a_slotted_game_keeps_its_volatile_saves_and_takes_the_persistent_answer() {
    mirror::preload(Vec::new());
    let mut rt = page(camp(true));
    run_to(&mut rt, SAVE_TICK + 1);
    let state = with_saves(rt.state(), &mirror::status());
    let saves = &state["volatile"]["saves"];
    assert_eq!(saves["lastSave"]["slot"], SLOT, "the facade's account stays: {saves}");
    assert_eq!(saves["persistent"], false, "best-effort until the shell reports");
    set_persistent(true);
    let state = with_saves(rt.state(), &mirror::status());
    assert_eq!(state["volatile"]["saves"]["persistent"], true);
    assert_eq!(state["volatile"]["saves"]["slots"].as_array().map(Vec::len), Some(1));
    // A game without slots gets the mirror's account, with the same answer.
    let plain = with_saves(json!({ "volatile": {} }), &mirror::status());
    assert_eq!(plain["volatile"]["saves"]["persistent"], true);
    assert_eq!(saves_state(&mirror::status())["persistent"], true);
    set_persistent(false);
}
