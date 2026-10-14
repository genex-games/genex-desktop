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
