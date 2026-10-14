//! The pond's rules, headless through the facade runtime (no GPU): casting, bites, the egui shop,
//! buoyancy and replay determinism.

use genex::{Input, Key, Runtime, Value, json};

fn pond() -> Runtime<pond_game::World> {
    Runtime::new(pond_game::game()).expect("the pond's registrations are valid")
}

fn fishing(runtime: &Runtime<pond_game::World>) -> Value {
    runtime.probes()["fishing"].clone()
}

#[test]
fn the_cast_demo_spends_bait_and_a_fish_bites_within_the_wait() {
    let mut runtime = pond();
    let result = runtime.demo("cast").expect("cast exists");
    assert_eq!(result, json!({ "casts": 1, "phase": "idle" }), "2 s covers the longest wait and the reel");
    let fishing = fishing(&runtime);
    assert_eq!(fishing["bait"], json!(pond_game::STARTING_BAIT - 1));
    assert_eq!(fishing["score"], json!(1));
    assert_eq!(fishing["bites"], json!(1));
    assert!(!runtime.running(), "the runtime pauses after a demo");
}

#[test]
fn a_cast_without_bait_does_nothing() {
    let mut runtime = pond();
    for _ in 0..pond_game::STARTING_BAIT + 1 {
        runtime.inject(Input::key_tap(Key::Space));
        runtime.step(3000.0);
    }
    let fishing = fishing(&runtime);
    assert_eq!(fishing["casts"], json!(pond_game::STARTING_BAIT));
    assert_eq!(fishing["bait"], json!(0));
}

#[test]
fn an_injected_click_on_the_shop_button_buys_bait() {
    let mut runtime = pond();
    let result = runtime.demo("shop").expect("shop exists");
    assert_eq!(result["bought"], json!(true), "the click reached the egui button: {result}");
    let fishing = fishing(&runtime);
    assert_eq!(fishing["score"], json!(1));
    assert_eq!(fishing["bait"], json!(pond_game::STARTING_BAIT + 1));
}

#[test]
fn floaters_drop_onto_the_water_and_stay_afloat() {
    let mut runtime = pond();
    runtime.step(5000.0);
    let floaters = runtime.probes()["floaters"].clone();
    assert_eq!(floaters["count"], json!(6));
    assert_eq!(floaters["afloat"], json!(6), "buoyancy holds every floater at the surface: {floaters}");
    let mean = floaters["meanY"].as_f64().expect("a number");
    assert!(mean.abs() < 0.5, "they float near y = 0, not on the pond bed: {mean}");
}

#[test]
fn two_runtimes_replay_one_seed_identically_and_seeds_differ() {
    let run = |seed: u32| {
        let mut runtime = pond();
        runtime.seed(seed);
        runtime.demo("cast").expect("cast exists");
        runtime.step(10_000.0);
        (runtime.checksum(), runtime.probes())
    };
    assert_eq!(run(4), run(4));
    assert_ne!(run(4).0, run(5).0);
}

#[test]
fn the_game_draws_every_tag_and_the_splash_reaches_the_meter() {
    let mut runtime = pond();
    runtime.inject(Input::key_tap(Key::Space));
    runtime.step(200.0);
    runtime.frame(genex::View::Game).expect("the game's view");
    let state = runtime.state();
    let tags = &state["__render"]["tags"];
    for tag in ["ground", "water", "pond", "floaters", "rod", "bobber"] {
        assert!(tags.get(tag).is_some(), "tag {tag} drawn: {tags}");
    }
    assert_eq!(state["assets"], json!(["pond.glb", "water.glb"]));
    let quiet = runtime.state()["volatile"]["audioLevel"]["rms"].clone();
    assert_eq!(quiet, json!(0.0), "silence before the bite");
    while fishing(&runtime)["bites"] == json!(0) {
        assert!(runtime.tick() < 600, "a fish bites within the wait");
        runtime.step(genex::FIXED_STEP_MS);
    }
    let audio = &runtime.state()["volatile"]["audioLevel"];
    assert_eq!(audio["available"], json!(true));
    assert!(audio["rms"].as_f64().expect("rms") > 0.0, "the bite's splash plays through the device-less mixer: {audio}");
}

#[test]
fn a_tap_on_the_water_casts_and_a_tap_on_the_hud_does_not() {
    let mut runtime = pond();
    runtime.step(50.0);
    runtime.inject(Input::click_at(0.01, 0.01));
    runtime.step(50.0);
    assert_eq!(fishing(&runtime)["casts"], json!(0), "the tap was the HUD's");
    runtime.inject(Input::click_at(0.5, 0.6));
    runtime.step(50.0);
    assert_eq!(fishing(&runtime)["casts"], json!(1), "a touch-only player can cast");
}
