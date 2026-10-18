//! `install` refuses inconsistent registrations with a typed panic before any runtime starts.

use genex::prelude::*;
use genex::{InstallErrorCode, Runtime};

#[derive(Default)]
struct World {
    x: f32,
}

fn game() -> Game<World> {
    Game::new(World::default())
}

fn at(x: f32) -> Camera {
    Camera::look_at(vec3(x, 2.0, 10.0), Vec3::ZERO)
}

#[test]
#[should_panic(expected = "duplicate-camera")]
fn install_panics_on_a_second_camera_without_override() {
    let mut game = game();
    game.camera(|_| at(1.0));
    game.camera(|_| at(2.0));
    genex::install(game);
}

#[test]
fn a_second_camera_with_camera_override_replaces_the_first() {
    let mut game = game();
    game.camera(|_| at(1.0));
    game.camera(|sim| at(sim.world.x + 2.0)).camera_override();
    let mut runtime = Runtime::new(game).expect("an override is a valid second camera");
    runtime.seed(3);
    assert_eq!(runtime.camera(View::Game).expect("the game camera").position, vec3(2.0, 2.0, 10.0));
}

#[test]
#[should_panic(expected = "duplicate-player")]
fn install_panics_on_a_second_player_without_override() {
    let mut game = game();
    game.player(|_| json!({ "x": 0 }));
    game.player(|_| json!({ "x": 1 }));
    genex::install(game);
}

#[test]
#[should_panic(expected = "duplicate-probe")]
fn install_panics_on_duplicate_probe_names() {
    let mut game = game();
    game.probe("fishing", |_| json!(1));
    game.probe("fishing", |_| json!(2));
    genex::install(game);
}

#[test]
#[should_panic(expected = "duplicate-probe")]
fn install_panics_when_a_volatile_probe_reuses_a_probe_name() {
    let mut game = game();
    game.probe("fishing", |_| json!(1));
    game.probe_volatile("fishing", |_| json!(2));
    genex::install(game);
}

#[test]
fn every_runtime_key_is_refused_as_a_probe_name() {
    for key in genex::RUNTIME_KEYS {
        let mut game = game();
        game.probe(key, |_| json!(0));
        let error = Runtime::new(game).err().expect("a runtime key is not a probe name");
        assert_eq!(error.code(), InstallErrorCode::ReservedProbe, "probe {key}");
    }
}

#[test]
fn each_inconsistent_registration_has_its_own_code() {
    let cases: Vec<(&str, Game<World>, InstallErrorCode)> = vec![
        ("empty probe name", with(|g| _ = g.probe("", |_| json!(0))), InstallErrorCode::InvalidName),
        (
            "duplicate named camera",
            with(|g| {
                g.named_camera("top", |_| at(0.0));
                g.named_camera("top", |_| at(1.0));
            }),
            InstallErrorCode::DuplicateCameraName,
        ),
        ("named camera called default", with(|g| _ = g.named_camera("default", |_| at(0.0))), InstallErrorCode::InvalidName),
        (
            "duplicate eye",
            with(|g| {
                g.eye("eye:spawn", |_| at(0.0));
                g.eye("eye:spawn", |_| at(1.0));
            }),
            InstallErrorCode::DuplicateEye,
        ),
        (
            "duplicate demo",
            with(|g| {
                g.demo("cast", |_| json!(null));
                g.demo("cast", |_| json!(null));
            }),
            InstallErrorCode::DuplicateDemo,
        ),
        (
            "facet state registered twice",
            with(|g| {
                g.facet_state::<u32>();
                g.facet_state::<u32>();
            }),
            InstallErrorCode::DuplicateFacetState,
        ),
        ("zero world size", Game::new(World::default()).world_size(0, 540), InstallErrorCode::InvalidWorldSize),
        ("huge world size", Game::new(World::default()).world_size(960, 9000), InstallErrorCode::InvalidWorldSize),
        ("world side below MIN_WORLD_PX", Game::new(World::default()).world_size(32, 32), InstallErrorCode::InvalidWorldSize),
        ("world side above the host's 4096", Game::new(World::default()).world_size(8192, 4608), InstallErrorCode::InvalidWorldSize),
    ];
    for (name, game, code) in cases {
        let error = Runtime::new(game).err().unwrap_or_else(|| panic!("{name}: expected {code:?}"));
        assert_eq!(error.code(), code, "{name}");
        assert!(error.to_string().starts_with(code.as_str()), "{name}: {error}");
    }
}

fn with(register: impl FnOnce(&mut Game<World>)) -> Game<World> {
    let mut game = game();
    register(&mut game);
    game
}

// Game systems EP-0a1: streaming registers once, with a cell size inside the caps; its runtime key
// `__stream` is display only, so a probe named `stream` keeps working and no checksum moves.

#[test]
#[should_panic(expected = "duplicate-streaming")]
fn install_panics_on_a_second_streaming_registration() {
    let mut game = game();
    game.streaming(genex::Streaming::grid(64.0));
    game.streaming(genex::Streaming::grid(64.0));
    genex::install(game);
}

#[test]
fn a_cell_size_outside_the_caps_is_refused_streaming_invalid() {
    for cell in [4.0, 0.0, -64.0, f32::NAN, f32::INFINITY, genex::STREAM_CELL_SIZE_MAX * 2.0] {
        let error = Runtime::new(with(|g| _ = g.streaming(genex::Streaming::grid(cell)))).err();
        let error = error.unwrap_or_else(|| panic!("cell size {cell} installed"));
        assert_eq!(error.code(), InstallErrorCode::StreamingInvalid, "cell size {cell}");
        assert!(error.to_string().starts_with("streaming-invalid"), "{error}");
    }
    for cell in [genex::STREAM_CELL_SIZE_MIN, 64.0, genex::STREAM_CELL_SIZE_MAX] {
        assert!(Runtime::new(with(|g| _ = g.streaming(genex::Streaming::grid(cell)))).is_ok(), "cell size {cell}");
    }
}

fn counting(game: &mut Game<World>) {
    game.on_update(|sim, ctx| sim.world.x += ctx.rng.unit());
    game.probe("stream", |sim| json!(sim.world.x));
}

#[test]
fn a_probe_named_stream_still_installs_with_an_unchanged_checksum() {
    let mut plain = Runtime::new(with(counting)).expect("a probe named stream installs");
    let mut streaming = Runtime::new(with(|g| {
        counting(g);
        g.streaming(genex::Streaming::grid(64.0));
    }))
    .expect("a streaming game with a probe named stream installs");
    for runtime in [&mut plain, &mut streaming] {
        runtime.seed(7);
        runtime.step(1000.0);
    }
    assert_eq!(streaming.checksum(), plain.checksum(), "__stream never enters the checksum");
    let state = streaming.state();
    assert_eq!(state["stream"], plain.state()["stream"], "the game's probe keeps its key");
    assert_eq!(state["__stream"]["active"], json!(0), "{state}");
    assert!(state["__stream"]["cells"].is_string(), "{state}");
}

#[test]
fn a_game_without_streaming_has_no_stream_key() {
    let mut runtime = Runtime::new(with(counting)).expect("installs");
    runtime.step(100.0);
    assert!(runtime.state().get("__stream").is_none(), "{}", runtime.state());
}
