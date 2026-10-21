//! IN-14: settled captures of input-twinstick on the host GPU (Metal on the Mac), drawn as the
//! Studio draws a frame (genex's presenter, the HUD over the scene), after three demos: `play`
//! (keyboard prompts), `pad_glyphs` (the prompts read the PlayStation pad's "Cross", "R2",
//! "Options") and `touch` (the on-screen sticks and buttons shown), plus the pause menu with the
//! Controls panel. Two settled captures of one tick are equal, and a second run's captures have
//! the same digests.
//!
//! The row is `#[ignore]`d and named `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p input-twinstick \
//!     --release --offline --test captures -- --ignored metal --nocapture
//!
//! It writes `input-twinstick-<scene>-<class>.png` and `input-twinstick-digests.json` to
//! `GENEX_INPUT_TWINSTICK_OUT` (default `.studio-dev/evidence/rust-renderer/captures/input-twinstick`).

use std::path::PathBuf;

use genex::present::Presenter;
use genex::render::{DeviceClass, RenderChange};
use genex::{FIXED_STEP_MS, Input, Key, Runtime, View};
use input_twinstick_game::{WORLD_SIZE, World, game};

const SCENES: [&str; 4] = ["play", "pad_glyphs", "touch", "paused"];
const CLASSES: [&str; 2] = ["desktop-high", "mobile-high"];

fn out_dir() -> PathBuf {
    let evidence = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../../.studio-dev/evidence/rust-renderer/captures/input-twinstick");
    let dir = std::env::var_os("GENEX_INPUT_TWINSTICK_OUT").map_or(evidence, PathBuf::from);
    std::fs::create_dir_all(&dir).expect("the captures folder");
    dir
}

fn write_png(path: &PathBuf, bgra: &[u8], size: [u32; 2]) {
    let rgba: Vec<u8> = bgra.chunks(4).flat_map(|p| [p[2], p[1], p[0], 255]).collect();
    image::save_buffer(path, &rgba, size[0], size[1], image::ExtendedColorType::Rgba8).expect("png written");
}

/// The scene's runtime, saving into a temporary folder (never the person's save folder).
fn settled(scene: &str) -> Runtime<World> {
    let dir = std::env::temp_dir().join(format!("genex-input-twinstick-captures-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("a temp folder");
    let mut runtime = Runtime::new(game()).expect("installs");
    runtime.use_studio_saves(&format!("{}/", dir.display()));
    runtime.seed(1);
    if scene == "paused" {
        assert!(runtime.start());
        runtime.inject(Input::key_tap(Key::KeyP));
        for _ in 0..6 {
            runtime.step(FIXED_STEP_MS);
        }
    } else {
        runtime.demo(scene).expect("the demo exists");
    }
    runtime
}

fn shoot_all(presenter: &mut Presenter) -> Vec<(String, u64, Vec<u8>, [u32; 2])> {
    let mut shots = Vec::new();
    for scene in SCENES {
        let mut runtime = settled(scene);
        assert!(presenter.install_for(&mut runtime).is_empty());
        presenter.set_capturing(true);
        // The first draw attaches the game's render settings to the presenter.
        presenter.draw_view(&mut runtime, View::Game).expect("a view").expect("drawn");
        for class in CLASSES {
            let settings = presenter.render_settings().expect("the game's settings attached");
            settings.borrow_mut().apply(&RenderChange { preset: Some(None), device_class: Some(None), ..RenderChange::default() });
            settings.borrow_mut().apply(&RenderChange { device_class: Some(DeviceClass::from_wire(class)), ..RenderChange::default() });
            let mut shoot = || {
                presenter.draw_view(&mut runtime, View::Game).expect("a view").expect("drawn");
                presenter.resilient.capture().expect("capture")
            };
            let (capture, again) = (shoot(), shoot());
            let label = format!("{scene}-{class}");
            assert_eq!(capture.digest(), again.digest(), "{label}: two settled captures of one tick differ");
            shots.push((label, capture.digest(), capture.bgra().to_vec(), [capture.width(), capture.height()]));
        }
    }
    shots
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_settled_captures_of_the_demos_and_the_pause_menu_replay_with_equal_digests() {
    let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
    let mut presenter = match Presenter::open(WORLD_SIZE, &[]) {
        Ok(presenter) => presenter,
        Err(error) if require => panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}"),
        Err(error) => return eprintln!("skipped: no WebGPU-core adapter ({error})"),
    };
    let dir = out_dir();
    let first = shoot_all(&mut presenter);
    let mut digests = genex::json!({});
    for (label, digest, bgra, size) in &first {
        write_png(&dir.join(format!("input-twinstick-{label}.png")), bgra, *size);
        digests[label.as_str()] = genex::json!(format!("{digest:016x}"));
        println!("{label}: {digest:016x}");
    }
    std::fs::write(dir.join("input-twinstick-digests.json"), digests.to_string()).expect("the digests write");
    let second = shoot_all(&mut presenter);
    for ((label, digest, ..), (_, again, ..)) in first.iter().zip(&second) {
        assert_eq!(digest, again, "{label}: a second run's capture differs");
    }
}
