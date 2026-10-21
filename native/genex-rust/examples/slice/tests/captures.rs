//! EP-V1: the slice's settled capture on the host GPU (Metal on the Mac), drawn as the Studio draws
//! a frame (genex's presenter, the game's look) at [`SHOT_TICK`], with the walker on its way home
//! past the villagers. Two settled captures of one tick are equal; the capture from the observer
//! camera (where the game camera is) has the game camera's digest; and a replay from the same seed
//! gives the same digest.
//!
//! The row is `#[ignore]`d and named `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p slice \
//!     --release --offline --test captures -- --ignored metal --nocapture
//!
//! It writes `slice-<view>-<class>.png` and `slice-digests.json` to `GENEX_SLICE_OUT` (default
//! `.studio-dev/evidence/rust-renderer/captures/slice`).

use std::path::PathBuf;

use genex::present::Presenter;
use genex::render::{DeviceClass, RenderChange};
use genex::{FIXED_STEP_MS, Runtime, View};
use slice_game::{ASSETS, OBSERVER, WORLD_SIZE, World, game};

/// The tick the capture is taken at: the walker on its way home, the villagers' cells back in.
const SHOT_TICK: u64 = 3300;
/// The classes the captures are drawn at.
const CLASSES: [&str; 2] = ["desktop-high", "mobile-high"];

fn out_dir() -> PathBuf {
    let evidence = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../../.studio-dev/evidence/rust-renderer/captures/slice");
    let dir = std::env::var_os("GENEX_SLICE_OUT").map_or(evidence, PathBuf::from);
    std::fs::create_dir_all(&dir).expect("the captures folder");
    dir
}

/// Write a BGRA capture as an opaque RGBA PNG.
fn write_png(path: &PathBuf, bgra: &[u8], size: [u32; 2]) {
    let rgba: Vec<u8> = bgra.chunks(4).flat_map(|p| [p[2], p[1], p[0], 255]).collect();
    image::save_buffer(path, &rgba, size[0], size[1], image::ExtendedColorType::Rgba8).expect("png written");
}

fn settled() -> Runtime<World> {
    let mut runtime = Runtime::with_assets(game(), Box::new(ASSETS)).expect("installs");
    assert!(runtime.start());
    runtime.seed(1);
    for _ in 0..SHOT_TICK {
        runtime.step(FIXED_STEP_MS);
    }
    runtime
}

/// One run's captures: (label, digest, bgra, size) for each view at each class.
fn shoot_all(presenter: &mut Presenter, runtime: &mut Runtime<World>) -> Vec<(String, u64, Vec<u8>, [u32; 2])> {
    assert!(presenter.install_for(runtime).is_empty());
    presenter.set_capturing(true);
    // The first draw attaches the game's render settings to the presenter.
    presenter.draw_view(runtime, View::Game).expect("a view").expect("drawn");
    let mut shots = Vec::new();
    for class in CLASSES {
        let settings = presenter.render_settings().expect("the game's settings attached");
        settings.borrow_mut().apply(&RenderChange { preset: Some(None), device_class: Some(None), ..RenderChange::default() });
        settings.borrow_mut().apply(&RenderChange { device_class: Some(DeviceClass::from_wire(class)), ..RenderChange::default() });
        for (name, view) in [("game", View::Game), ("observer", View::Named(OBSERVER))] {
            let mut shoot = || {
                presenter.draw_view(runtime, view).expect("a view").expect("drawn");
                presenter.resilient.capture().expect("capture")
            };
            let (capture, again) = (shoot(), shoot());
            let label = format!("{name}-{class}");
            assert_eq!(capture.digest(), again.digest(), "{label}: two settled captures of one tick differ");
            shots.push((label, capture.digest(), capture.bgra().to_vec(), [capture.width(), capture.height()]));
        }
    }
    shots
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_settled_capture_is_equal_from_the_game_camera_and_the_observer_and_replays_from_the_seed() {
    let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
    let mut presenter = match Presenter::open(WORLD_SIZE, ASSETS) {
        Ok(presenter) => presenter,
        Err(error) if require => panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}"),
        Err(error) => return eprintln!("skipped: no WebGPU-core adapter ({error})"),
    };
    let dir = out_dir();
    let first = shoot_all(&mut presenter, &mut settled());
    let mut digests = genex::json!({});
    for (label, digest, bgra, size) in &first {
        write_png(&dir.join(format!("slice-{label}.png")), bgra, *size);
        digests[label.as_str()] = genex::json!(format!("{digest:016x}"));
        println!("{label}: {digest:016x}");
    }
    std::fs::write(dir.join("slice-digests.json"), digests.to_string()).expect("the digests write");
    for pair in first.chunks(2) {
        assert_eq!(pair[0].1, pair[1].1, "{} and {}: the observer where the game camera is sees the same picture", pair[0].0, pair[1].0);
    }
    let replay = shoot_all(&mut presenter, &mut settled());
    for ((label, digest, ..), (_, again, ..)) in first.iter().zip(&replay) {
        assert_eq!(digest, again, "{label}: a replay from the seed captures a different picture");
    }
}
