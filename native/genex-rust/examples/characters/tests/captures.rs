//! AN-21: settled captures of the characters yard on the host GPU (Metal on the Mac), drawn as the
//! Studio draws a frame (genex's presenter, the game's look), at a tick where the hero slashes
//! mid-run and the walkers stride. The capture from the game camera
//! equals the capture from the observer eye placed at the same camera, two settled captures of one
//! tick are equal, and a second run from the same seed gives the same digests.
//!
//! The row is `#[ignore]`d and named `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p characters \
//!     --release --offline --test captures -- --ignored metal --nocapture
//!
//! It writes `characters-<view>-<class>.png` and `characters-digests.json` to
//! `GENEX_CHARACTERS_OUT` (default `.studio-dev/evidence/rust-renderer/captures/characters`).

use std::path::PathBuf;

use characters_game::{OBSERVER_EYE, WORLD_SIZE, World, assets, game};
use genex::present::Presenter;
use genex::render::{DeviceClass, RenderChange};
use genex::{FIXED_STEP_MS, Runtime, View};

/// The tick the captures are taken at: the hero's second slash, during its run.
const SHOT_TICK: u64 = 462;
/// The classes the captures are drawn at.
const CLASSES: [&str; 2] = ["desktop-high", "mobile-high"];

fn out_dir() -> PathBuf {
    let evidence = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../../.studio-dev/evidence/rust-renderer/captures/characters");
    let dir = std::env::var_os("GENEX_CHARACTERS_OUT").map_or(evidence, PathBuf::from);
    std::fs::create_dir_all(&dir).expect("the captures folder");
    dir
}

/// Write a BGRA capture as an opaque RGBA PNG.
fn write_png(path: &PathBuf, bgra: &[u8], size: [u32; 2]) {
    let rgba: Vec<u8> = bgra.chunks(4).flat_map(|p| [p[2], p[1], p[0], 255]).collect();
    image::save_buffer(path, &rgba, size[0], size[1], image::ExtendedColorType::Rgba8).expect("png written");
}

fn settled() -> Runtime<World> {
    let mut runtime = Runtime::with_assets(game(), Box::new(assets())).expect("installs");
    runtime.seed(1);
    assert!(runtime.start());
    for _ in 0..SHOT_TICK {
        runtime.step(FIXED_STEP_MS);
    }
    runtime
}

/// One class's captures: (class, game digest, observer digest, the game capture's bgra, size).
type Shot = (String, u64, u64, Vec<u8>, [u32; 2]);

/// One run's captures, at each class.
fn shoot_all(presenter: &mut Presenter, runtime: &mut Runtime<World>) -> Vec<Shot> {
    assert!(presenter.install_for(runtime).is_empty());
    presenter.set_capturing(true);
    // The first draw attaches the game's render settings to the presenter.
    presenter.draw_view(runtime, View::Game).expect("a view").expect("drawn");
    let mut shots = Vec::new();
    for class in CLASSES {
        let settings = presenter.render_settings().expect("the game's settings attached");
        settings.borrow_mut().apply(&RenderChange { preset: Some(None), device_class: Some(None), ..RenderChange::default() });
        settings.borrow_mut().apply(&RenderChange { device_class: Some(DeviceClass::from_wire(class)), ..RenderChange::default() });
        let mut shoot = |view: View<'_>| {
            presenter.draw_view(runtime, view).expect("a view").expect("drawn");
            presenter.resilient.capture().expect("capture")
        };
        let (game, again) = (shoot(View::Game), shoot(View::Game));
        assert_eq!(game.digest(), again.digest(), "{class}: two settled captures of one tick differ");
        let observer = shoot(View::Eye(OBSERVER_EYE));
        shots.push((class.to_owned(), game.digest(), observer.digest(), game.bgra().to_vec(), [game.width(), game.height()]));
    }
    shots
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_game_camera_and_the_observer_eye_capture_the_same_and_a_replay_too() {
    let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
    let mut presenter = match Presenter::open(WORLD_SIZE, assets()) {
        Ok(presenter) => presenter,
        Err(error) if require => panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}"),
        Err(error) => return eprintln!("skipped: no WebGPU-core adapter ({error})"),
    };
    let dir = out_dir();
    let first = shoot_all(&mut presenter, &mut settled());
    let mut digests = genex::json!({});
    for (class, game, observer, bgra, size) in &first {
        write_png(&dir.join(format!("characters-game-{class}.png")), bgra, *size);
        digests[class.as_str()] = genex::json!({ "game": format!("{game:016x}"), "observer": format!("{observer:016x}") });
        println!("{class}: game {game:016x} observer {observer:016x}");
    }
    std::fs::write(dir.join("characters-digests.json"), digests.to_string()).expect("the digests write");
    for (class, game, observer, ..) in &first {
        assert_eq!(game, observer, "{class}: the observer eye at the game camera captures the same picture");
    }
    let second = shoot_all(&mut presenter, &mut settled());
    for ((class, digest, ..), (_, again, ..)) in first.iter().zip(&second) {
        assert_eq!(digest, again, "{class}: a replay of the seed captures a different picture");
    }
}
