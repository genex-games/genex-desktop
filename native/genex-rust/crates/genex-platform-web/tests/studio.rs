//! The web page verbs through `Studio::web()` over a facade runtime: the shapes the C++ web build
//! answers (and the host's `preview.witness` reads), on a painter that only counts draws.

use genex::prelude::*;
use genex::{Camera, Runtime};
use genex_core::json::{self, Value};
use genex_platform_web::GameHandle;
use genex_platform_web::studio::{HandleGame, Held, Painter, verb_changes_frame};
use genex_studio::{Op, Studio};

#[derive(Default)]
struct World {
    x: f32,
    presses: u32,
}

/// Counts the draws of the view it is asked for and remembers which view that was.
#[derive(Default)]
struct Counting {
    views: Vec<Option<String>>,
}

impl Painter for Counting {
    fn paint(&mut self, game: &mut dyn GameHandle, view: Option<&str>) -> u32 {
        self.views.push(view.map(str::to_owned));
        game.view_frame(view).map_or(0, |(frame, _)| frame.draw_calls())
    }
}

fn runtime() -> Runtime<World> {
    let mut game = Game::new(World::default()).world_size(64, 64);
    game.on_update(|sim, ctx| {
        if ctx.keys.down(Key::KeyD) {
            sim.world.x += 1.0;
        }
        if ctx.keys.pressed(Key::Space) {
            sim.world.presses += 1;
        }
    });
    game.on_draw(|sim, frame, _| {
        frame.cube(Transform::default(), Color::WHITE);
        frame.sphere(vec3(sim.world.x, 0.0, 0.0), 1.0, Color::WHITE);
    });
    game.named_camera("top", |_| Camera::look_at(vec3(0.0, 10.0, 0.0), Vec3::ZERO));
    game.eye("eye:spawn", |_| Camera::look_at(vec3(0.0, 1.0, 5.0), Vec3::ZERO));
    game.probe("x", |sim| json!(sim.world.x));
    game.demo("walk", |d| {
        d.inject(Input::key_down(Key::KeyD));
        d.advance_ms(100);
        json!({ "x": d.sim().world.x })
    });
    Runtime::new(game).expect("a valid game")
}

/// One page call's `{id:null, ok, op, result}` envelope, parsed.
fn call(studio: &mut Studio, game: &mut Runtime<World>, painter: &mut Counting, op: &str, arg: &str) -> Value {
    let (mut view, mut draws) = (None, 0);
    let mut adapter = HandleGame { game, painter, view: &mut view, draws: &mut draws };
    let arg = json::parse(arg.as_bytes()).expect("an argument");
    let reply = json::parse(&studio.call(&mut adapter, op, &arg)).expect("a JSON reply");
    assert_eq!(reply["id"], Value::Null, "{op}: the web envelope carries no id");
    reply
}

fn result(studio: &mut Studio, game: &mut Runtime<World>, painter: &mut Counting, op: &str, arg: &str) -> Value {
    let reply = call(studio, game, painter, op, arg);
    assert_eq!(reply["ok"], Value::Bool(true), "{op}: {}", String::from_utf8_lossy(&reply.dump()));
    reply["result"].clone()
}

#[test]
fn step_answers_the_counters_preview_witness_reads_and_seed_answers_the_seed() {
    let (mut studio, mut game, mut painter) = (Studio::web(), runtime(), Counting::default());
    studio.mark_ready();
    let seeded = result(&mut studio, &mut game, &mut painter, Op::SEED, r#"{"seed":7}"#);
    assert_eq!(seeded.dump(), br#"{"seed":7,"paused":true}"#.to_vec());
    let step = result(&mut studio, &mut game, &mut painter, Op::STEP, r#"{"ms":1000}"#);
    assert_eq!(step["frame"], Value::from(60));
    assert_eq!(step["steppedFrames"], Value::from(60));
    assert_eq!(step["drawCalls"], Value::from(2), "the step drew the frame and counted its draws");
    assert!(matches!(step["simulatedMs"], Value::Number(_)));
}

#[test]
fn demo_input_and_cameras_have_the_cpp_page_shapes() {
    let (mut studio, mut game, mut painter) = (Studio::web(), runtime(), Counting::default());
    studio.mark_ready();
    let walked = result(&mut studio, &mut game, &mut painter, Op::DEMO, r#"{"name":"walk"}"#);
    assert_eq!((walked["ok"].clone(), walked["demo"].as_str()), (Value::Bool(true), "walk"));
    assert_eq!(walked["result"]["x"], Value::from(6));
    let missing = result(&mut studio, &mut game, &mut painter, Op::DEMO, r#"{"name":"fly"}"#);
    assert_eq!(missing.dump(), br#"{"ok":false,"available":["walk"]}"#.to_vec());
    let input = result(&mut studio, &mut game, &mut painter, Op::INPUT, r#"{"down":["KeyD","NoSuchKey"]}"#);
    // An unknown name is answered, never thrown (the old export threw `bad-input`). v1 holds any
    // name; the facade's typed keys drop it until its input moves onto genex-core's merger (M2.4).
    assert_eq!(input["held"].items().iter().map(Value::as_str).collect::<Vec<_>>(), ["KeyD"]);
    assert_eq!(input["ignored"], Value::from(0));
    let cameras = result(&mut studio, &mut game, &mut painter, Op::CAMERAS, "null");
    assert_eq!(cameras.dump(), br#"{"cameras":["default","top"]}"#.to_vec());
    let eyes = result(&mut studio, &mut game, &mut painter, Op::EYES, "null");
    assert_eq!(eyes.dump(), br#"{"eyes":["eye:spawn"]}"#.to_vec());
    let sky = result(&mut studio, &mut game, &mut painter, Op::DEBUG_CAMERA, r#"{"camera":"sky"}"#);
    assert_eq!(sky.dump(), br#"{"ok":false,"available":["default","top"]}"#.to_vec());
}

#[test]
fn a_capture_from_a_named_camera_draws_that_view_and_state_reports_it() {
    let (mut studio, mut game, mut painter) = (Studio::web(), runtime(), Counting::default());
    studio.mark_ready();
    let shot = result(&mut studio, &mut game, &mut painter, Op::CAPTURE, r#"{"camera":"top"}"#);
    assert_eq!(shot.dump(), br#"{"width":64,"height":64,"camera":"top","drawCalls":2}"#.to_vec());
    assert_eq!(painter.views.last(), Some(&Some("top".to_owned())), "the capture drew the named camera");
    let state = result(&mut studio, &mut game, &mut painter, Op::STATE, "null");
    assert_eq!(state["camera"].as_str(), "top");
    let refused = call(&mut studio, &mut game, &mut painter, Op::CAPTURE, r#"{"camera":"sky"}"#);
    assert_eq!(refused["error"].as_str(), "unknown-camera");
}

// RX review: the shell held animation frames while a capture was in flight, but a page verb that
// draws (`step`, `seed`, `demo`, `debugCamera`) still painted Live into the target the capture reads.
#[test]
fn a_verb_issued_while_a_capture_is_in_flight_runs_but_draws_nothing() {
    let (mut studio, mut game, mut painter) = (Studio::web(), runtime(), Counting::default());
    studio.mark_ready();
    let before = result(&mut studio, &mut game, &mut painter, Op::STEP, r#"{"ms":100}"#);
    let drawn = painter.views.len();
    let (mut view, mut draws) = (None, 7);
    let mut held = Held::new(&mut painter, draws);
    let mut adapter = HandleGame { game: &mut game, painter: &mut held, view: &mut view, draws: &mut draws };
    for (op, arg) in [(Op::STEP, r#"{"ms":1000}"#), (Op::DEMO, r#"{"name":"walk"}"#), (Op::DEBUG_CAMERA, r#"{"camera":"top"}"#)] {
        let reply = json::parse(&studio.call(&mut adapter, op, &json::parse(arg.as_bytes()).expect("an argument"))).expect("a JSON reply");
        assert_eq!(reply["ok"], Value::Bool(true), "{op}: {}", String::from_utf8_lossy(&reply.dump()));
    }
    assert_eq!(painter.views.len(), drawn, "nothing was drawn while the capture was in flight");
    assert!(game.tick() > before["frame"].as_f64() as u64, "the step still ran");
    assert_eq!(draws, 7, "the last frame's draw calls stand");
}

// Pass-1 gate (Web Live pacing): every page verb made the next animation frame redraw, so Live's
// stage polling `state()` once a second put an extra frame one refresh after the last, between
// two ticks. A read changes nothing on screen; a verb that can move the view or the picture does.
#[test]
fn only_a_verb_that_can_change_the_picture_makes_the_next_frame_redraw() {
    let parse = |arg: &str| json::parse(arg.as_bytes()).expect("an argument");
    for (op, arg) in [
        (Op::STATE, "null"),
        (Op::CAMERAS, "{}"),
        (Op::EYES, "{}"),
        (Op::DEMOS, "{}"),
        (Op::RENDER_SETTINGS, "{}"),
        (Op::RENDER_SETTINGS, "null"),
    ] {
        assert!(!verb_changes_frame(op, &parse(arg)), "{op} {arg} is a read");
    }
    for (op, arg) in [
        (Op::SEED, r#"{"seed":3}"#),
        (Op::START, "{}"),
        (Op::PAUSE, "{}"),
        (Op::STEP, r#"{"ms":16}"#),
        (Op::INPUT, r#"{"down":["KeyW"]}"#),
        (Op::CAPTURE, "{}"),
        (Op::DEBUG_CAMERA, r#"{"camera":"top"}"#),
        (Op::DEMO, r#"{"name":"walk"}"#),
        (Op::AUDIO, r#"{"muted":true}"#),
        (Op::RENDER_SETTINGS, r#"{"set":{"preset":"low"}}"#),
        ("someFutureOp", "{}"),
    ] {
        assert!(verb_changes_frame(op, &parse(arg)), "{op} {arg} may change the picture");
    }
}

const TONE: &[u8] = include_bytes!("../../../../../tests/fixtures/asset-import/tone.wav");
static TONE_TABLE: genex::AssetTable = &[("sfx/tone.wav", TONE)];

/// A game that plays the tone on its first tick through `ctx.audio`.
fn tone_runtime() -> Runtime<Option<genex::audio::Sound>> {
    let mut game = Game::new(None::<genex::audio::Sound>).world_size(64, 64);
    game.on_reset(|sim, _, _, gfx| sim.world = Some(gfx.sound("sfx/tone.wav")));
    game.on_update(|sim, ctx| {
        if let (0, Some(sound)) = (ctx.tick, sim.world.as_ref()) {
            ctx.audio.play(sound);
        }
    });
    Runtime::with_assets(game, Box::new(TONE_TABLE)).expect("a valid game")
}

/// AU-8 red row: the page's `audio()` answers `{available: true}` with the tone game's own level
/// (rms > 0; the web build answered `{available: false}`), and the page's `audio({muted})` verb
/// mutes only the device: `volatile.audio.device.muted` turns true and the level stays.
#[test]
fn the_page_audio_probe_reads_the_tone_and_its_mute_leaves_the_level() {
    use genex_platform_web::audio::level_answer;
    let (mut studio, mut painter) = (Studio::web(), Counting::default());
    studio.mark_ready();
    let mut game = tone_runtime();
    let mut adapter_call = |game: &mut Runtime<Option<genex::audio::Sound>>, op: &str, arg: &str| {
        let (mut view, mut draws) = (None, 0);
        let mut adapter = HandleGame { game, painter: &mut painter, view: &mut view, draws: &mut draws };
        let arg = json::parse(arg.as_bytes()).expect("an argument");
        json::parse(&studio.call(&mut adapter, op, &arg)).expect("a JSON reply")
    };
    adapter_call(&mut game, Op::STEP, r#"{"ms":167}"#);
    let probe = level_answer(GameHandle::audio_level(&game));
    assert_eq!(probe["available"], serde_json::json!(true), "{probe}");
    let rms = probe["rms"].as_f64().unwrap_or_default();
    assert!(rms > 0.05, "the tone's level, not silence: {probe}");
    let muted = adapter_call(&mut game, Op::AUDIO, r#"{"muted":true}"#);
    assert_eq!(muted["result"]["muted"], Value::Bool(true));
    assert!(GameHandle::output_muted(&game));
    assert_eq!(level_answer(GameHandle::audio_level(&game)), probe, "the mute leaves the meter");
    let state = GameHandle::state(&game);
    assert_eq!(state["volatile"]["audio"]["device"]["muted"], serde_json::json!(true), "{state}");
}
