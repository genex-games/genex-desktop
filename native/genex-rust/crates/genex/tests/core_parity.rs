//! The facade on genex-core (M2.4): the checksum is genex-core's over the C++ JSON writer's dump
//! (Q6: a Rust and a C++ game with equal seed, frame and probe leaves hash equal, `1e-7` dumping
//! as `1e-07`), `state()` is genex-core's snapshot (`__render` as `studio.cpp`'s `tallyJson`), and
//! the merged input carries genex-core's pads and contract v2's touches to `ctx`.

use genex::prelude::*;
use genex::{FIXED_STEP_MS, Runtime, View};
use genex_core::digest::{fnv1a64, hex64};
use genex_core::input::{FrameSample, parse_injection};
use genex_core::json;

#[derive(Default)]
struct World {
    walked: u32,
    pad_presses: u32,
    trigger: f32,
    touches: Vec<(u32, String, f32, f32)>,
}

fn game() -> Game<World> {
    let mut game = Game::new(World::default()).title("Parity");
    game.on_update(|sim, ctx| {
        if ctx.keys.down(Key::KeyD) {
            sim.world.walked += 1;
        }
        if ctx.pads.pressed(0, 0) {
            sim.world.pad_presses += 1;
        }
        sim.world.trigger = ctx.pads.value(0, 7);
        for touch in ctx.touches.all() {
            sim.world.touches.push((touch.id, format!("{:?}", touch.phase), touch.position.x, touch.position.y));
        }
    });
    game.probe("tiny", |_| json!({ "small": 1e-7, "n": 3, "big": 1.0e21 }));
    game.on_draw(|_, frame, _| {
        frame.tag("pond").cube(Transform::IDENTITY, Color::RED);
        frame.tag("pond").cube(Transform::IDENTITY, Color::RED);
    });
    game
}

fn runtime() -> Runtime<World> {
    let mut rt = Runtime::new(game()).expect("installs");
    rt.seed(1);
    rt
}

#[test]
fn the_checksum_is_genex_cores_over_the_cpp_writers_dump() {
    let rt = runtime();
    // The bytes the C++ `session.cpp` checksum hashes for these leaves: `%.15g`-style numbers.
    let dump = br#"{"seed":1,"frame":0,"probes":{"tiny":{"small":1e-07,"n":3,"big":1e+21}}}"#;
    assert_eq!(rt.checksum(), hex64(fnv1a64(dump)));
    let state = rt.state_value("default", 0.0);
    assert_eq!(state["checksum"].as_str(), rt.checksum());
}

#[test]
fn state_is_genex_cores_snapshot_with_the_tally_as_studio_cpp_reports_it() {
    let mut rt = runtime();
    rt.frame(View::Game).expect("the game's own view");
    rt.note_triangles(24, &[("pond".to_owned(), 24)]);
    let state = rt.state_value("top", 12.5);
    let keys: Vec<String> =
        state.members().iter().map(|(key, _)| String::from_utf8_lossy(key).into_owned()).collect();
    let runtime_keys = [
        "version",
        "contractVersion",
        "seed",
        "frame",
        "simulatedMs",
        "running",
        "fps",
        "held",
        "pointerLock",
        "hud",
        "camera",
        "error",
        "player",
        "volatile",
        "__render",
        "assets",
        "checksum",
        "tiny",
    ];
    assert_eq!(keys, runtime_keys);
    assert_eq!(state["camera"].as_str(), "top");
    assert_eq!(state["fps"].as_f64(), 12.5);
    assert_eq!(state["volatile"]["fps"].as_f64(), 12.5);
    let render = json::parse(&state["__render"].dump()).expect("JSON");
    assert_eq!(render["drawCalls"].as_f64(), 2.0);
    assert_eq!(render["triangles"].as_f64(), 24.0);
    assert_eq!(render["tags"]["pond"]["drawCalls"].as_f64(), 2.0);
    assert_eq!(render["tags"]["pond"]["triangles"].as_f64(), 24.0);
    assert_eq!(render["exact"], json::Value::Bool(false));
    assert_eq!(rt.state()["frame"], json!(0), "the serde view keeps whole numbers whole");
}

/// A model the renderer could not load (not in the table, not on disk, malformed) is named in
/// `__render.missingModels`, beside the checker it drew; the key is absent while nothing is
/// missing, so a healthy game's state is unchanged. Each drawn frame starts the list again.
#[test]
fn models_drawn_as_the_missing_checker_are_listed_only_while_some_are() {
    let mut rt = runtime();
    rt.frame(View::Game).expect("the game's own view");
    rt.note_triangles(24, &[("pond".to_owned(), 24)]);
    assert_eq!(rt.state()["__render"].get("missingModels"), None, "absent when nothing is missing");
    rt.note_missing_models(&["pond.glb".to_owned(), "water.glb".to_owned()]);
    assert_eq!(rt.state()["__render"]["missingModels"], json!(["pond.glb", "water.glb"]));
    let core = rt.state_value("default", 0.0)["__render"]["missingModels"].dump();
    assert_eq!(core, br#"["pond.glb","water.glb"]"#, "the genex-core snapshot carries it too");
    rt.frame(View::Game).expect("the next frame");
    assert_eq!(rt.state()["__render"].get("missingModels"), None, "a new frame's tally starts empty");
}

#[test]
fn injected_pads_reach_ctx_through_genex_cores_merge() {
    let mut rt = runtime();
    let arg = json::parse(br#"{"pads":[{"index":0,"buttons":[1,0,0,0,0,0,0,0.75]}]}"#).expect("JSON");
    rt.inject(Input::from_injection(parse_injection(&arg)));
    rt.step(FIXED_STEP_MS * 3.0);
    assert_eq!(rt.sim().world.pad_presses, 1, "a pad button presses on one tick only");
    assert_eq!(rt.sim().world.trigger, 0.75);
}

#[test]
fn touches_reach_ctx_by_id_in_world_pixels_with_their_phases() {
    let mut rt = runtime();
    rt.inject(Input::touch_start(3, 10.0, 20.0));
    rt.step(FIXED_STEP_MS);
    rt.inject(Input::touch_move(3, 11.0, 21.0));
    rt.step(FIXED_STEP_MS);
    rt.inject(Input::touch_end(3, 12.0, 22.0));
    rt.step(FIXED_STEP_MS * 2.0);
    let seen: Vec<(u32, &str, f32, f32)> =
        rt.sim().world.touches.iter().map(|(id, phase, x, y)| (*id, phase.as_str(), *x, *y)).collect();
    assert_eq!(seen, [(3, "Began", 10.0, 20.0), (3, "Held", 11.0, 21.0), (3, "Ended", 12.0, 22.0)]);
}

#[test]
fn real_input_a_shell_samples_merges_with_injected_input() {
    let mut rt = runtime();
    let sample = FrameSample { held: vec!["KeyD".to_owned()], ..FrameSample::default() };
    rt.sample_input(&sample);
    rt.step(FIXED_STEP_MS * 2.0);
    assert_eq!(rt.sim().world.walked, 2, "a key the person holds is held on every tick");
    assert_eq!(rt.held(), ["KeyD"]);
    rt.sample_input(&FrameSample::default());
    rt.step(FIXED_STEP_MS);
    assert_eq!(rt.sim().world.walked, 2);
}
