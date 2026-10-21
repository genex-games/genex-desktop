//! STR-26a: settled captures of the valley on the host GPU (Metal on the Mac), drawn as the Studio
//! draws a capture (the view set drained first, STR-25), at desktop-high and mobile-high: the game
//! view nearing the first village (tick 240) and the second (tick 1,740), and the overview over the
//! anchor at tick 1,740. Two captures of one tick are equal, and a second run gives the same
//! digests on a fresh presenter.
//!
//! The row is `#[ignore]`d and named `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p stream-valley \
//!     --release --offline --test captures -- --ignored metal --nocapture
//!
//! It writes `stream-valley-<shot>-<class>.png` and `stream-valley-digests.json` to
//! `GENEX_STREAM_VALLEY_OUT` (default `.studio-dev/evidence/rust-renderer/captures/stream-valley`).

use std::path::PathBuf;

use genex::present::{Presenter, STREAM_DRAIN_MAX_MS, WallDrainClock, drain_blocking};
use genex::render::{DeviceClass, RenderChange};
use genex::{FIXED_STEP_MS, Runtime, View};
use stream_valley_game::valley::OVERVIEW;
use stream_valley_game::{WORLD_SIZE, World, assets, game};

/// The ticks the captures are taken at, and the views drawn at each.
const SHOTS: [(u64, &[(&str, View<'static>)]); 2] = [(240, &[("game", View::Game)]), (1740, &[("game", View::Game), ("overview", View::Named(OVERVIEW))])];
/// Frames drawn before the first capture.
const WARM_FRAMES: usize = 10;
/// The classes the captures are drawn at.
const CLASSES: [&str; 2] = ["desktop-high", "mobile-high"];

fn out_dir() -> PathBuf {
    let evidence = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../../.studio-dev/evidence/rust-renderer/captures/stream-valley");
    let dir = std::env::var_os("GENEX_STREAM_VALLEY_OUT").map_or(evidence, PathBuf::from);
    std::fs::create_dir_all(&dir).expect("the captures folder");
    dir
}

/// Write a BGRA capture as an opaque RGBA PNG.
fn write_png(path: &PathBuf, bgra: &[u8], size: [u32; 2]) {
    let rgba: Vec<u8> = bgra.chunks(4).flat_map(|p| [p[2], p[1], p[0], 255]).collect();
    image::save_buffer(path, &rgba, size[0], size[1], image::ExtendedColorType::Rgba8).expect("png written");
}

/// A settled capture as the studio draws one: drain the view set, then draw and read back.
fn capture(presenter: &mut Presenter, runtime: &mut Runtime<World>, view: View<'_>) -> genex_render::capture::Capture {
    let report = drain_blocking(&mut WallDrainClock::default(), STREAM_DRAIN_MAX_MS, || presenter.drain_pass(runtime, view)).expect("drained");
    presenter.note_drain(report);
    assert!(!report.timed_out, "{report:?}");
    presenter.draw_view(runtime, view).expect("a view").expect("drawn");
    presenter.resilient.capture().expect("capture")
}

fn set_class(presenter: &Presenter, class: &str) {
    let settings = presenter.render_settings().expect("the game's settings attached");
    settings.borrow_mut().apply(&RenderChange { preset: Some(None), device_class: Some(None), ..RenderChange::default() });
    settings.borrow_mut().apply(&RenderChange { device_class: Some(DeviceClass::from_wire(class)), ..RenderChange::default() });
}

/// One run's captures: (label, digest, bgra, size).
fn shoot_all(presenter: &mut Presenter) -> Vec<(String, u64, Vec<u8>, [u32; 2])> {
    let mut runtime = Runtime::with_assets(game(), Box::new(assets())).expect("installs");
    runtime.seed(1);
    assert!(runtime.start());
    assert!(presenter.install_for(&mut runtime).is_empty());
    presenter.set_capturing(true);
    // The first draws attach the game's render settings and warm the pipelines.
    for _ in 0..WARM_FRAMES {
        presenter.draw_view(&mut runtime, View::Game).expect("a view").expect("drawn");
    }
    let mut shots = Vec::new();
    let mut tick = 0;
    for (at, views) in SHOTS {
        while tick < at {
            runtime.step(FIXED_STEP_MS);
            tick += 1;
        }
        for class in CLASSES {
            set_class(presenter, class);
            for (name, view) in views {
                let (shot, again) = (capture(presenter, &mut runtime, *view), capture(presenter, &mut runtime, *view));
                let label = format!("{name}-{at}-{class}");
                assert_eq!(shot.digest(), again.digest(), "{label}: two settled captures of one tick differ");
                let lit = shot.bgra().chunks(4).filter(|p| p[..3].iter().any(|c| *c > 40)).count();
                println!("{label}: {lit} lit pixels of {}", shot.bgra().len() / 4);
                shots.push((label, shot.digest(), shot.bgra().to_vec(), [shot.width(), shot.height()]));
            }
        }
    }
    assert_eq!(presenter.failure(), None);
    shots
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_settled_captures_of_the_valley_replay_with_equal_digests() {
    let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
    let mut presenter = match Presenter::open(WORLD_SIZE, assets()) {
        Ok(presenter) => presenter,
        Err(error) if require => panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}"),
        Err(error) => return eprintln!("skipped: no WebGPU-core adapter ({error})"),
    };
    // The second run gets its own presenter, as a second process would: nothing resident, no history.
    let mut fresh = Presenter::open(WORLD_SIZE, assets()).expect("a second presenter on the same adapter");
    let dir = out_dir();
    let first = shoot_all(&mut presenter);
    let mut digests = genex::json!({});
    for (label, digest, bgra, size) in &first {
        write_png(&dir.join(format!("stream-valley-{label}.png")), bgra, *size);
        digests[label.as_str()] = genex::json!(format!("{digest:016x}"));
        println!("{label}: {digest:016x}");
    }
    std::fs::write(dir.join("stream-valley-digests.json"), digests.to_string()).expect("the digests write");
    let second = shoot_all(&mut fresh);
    for ((label, digest, ..), (_, again, ..)) in first.iter().zip(&second) {
        assert_eq!(digest, again, "{label}: a second run's capture differs");
    }
}
