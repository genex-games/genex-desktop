//! EP-X1: settled captures of the frontier on the host GPU (Metal on the Mac), drawn as the Studio
//! draws a capture (the view set drained first), at desktop-high and mobile-high: the town with its
//! agents, door and watchtower while the rider waits (tick 420), and the road east through the
//! impostor forest and its far field (tick 1,500). At each, two captures of one tick are equal, the
//! observer camera (where the game camera is) has the game camera's digest, and a second run on a
//! fresh presenter gives the same digests.
//!
//! The row is `#[ignore]`d and named `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p frontier \
//!     --release --offline --test captures -- --ignored metal --nocapture
//!
//! It writes `frontier-<view>-<tick>-<class>.png` and `frontier-digests.json` to
//! `GENEX_FRONTIER_OUT` (default `.studio-dev/evidence/rust-renderer/captures/frontier`).

use std::path::PathBuf;

use frontier_game::{OBSERVER, WORLD_SIZE, World, assets, game};
use genex::present::{Presenter, STREAM_DRAIN_MAX_MS, WallDrainClock, drain_blocking};
use genex::render::{DeviceClass, RenderChange};
use genex::{FIXED_STEP_MS, Runtime, View};

/// The ticks the captures are taken at.
const SHOTS: [u64; 2] = [420, 1500];
/// The views drawn at each: the game camera and the observer where it is.
const VIEWS: [(&str, View<'static>); 2] = [("game", View::Game), ("observer", View::Named(OBSERVER))];
/// Frames drawn before the first capture.
const WARM_FRAMES: usize = 10;
/// The classes the captures are drawn at.
const CLASSES: [&str; 2] = ["desktop-high", "mobile-high"];

fn out_dir() -> PathBuf {
    let evidence = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../../.studio-dev/evidence/rust-renderer/captures/frontier");
    let dir = std::env::var_os("GENEX_FRONTIER_OUT").map_or(evidence, PathBuf::from);
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

/// One run's captures: (label, digest, bgra, size), game then observer at each tick and class.
fn shoot_all(presenter: &mut Presenter) -> Vec<(String, u64, Vec<u8>, [u32; 2])> {
    let mut runtime = Runtime::with_assets(game(), Box::new(assets())).expect("installs");
    runtime.seed(1);
    assert!(runtime.start());
    assert!(presenter.install_for(&mut runtime).is_empty());
    presenter.set_capturing(true);
    for _ in 0..WARM_FRAMES {
        presenter.draw_view(&mut runtime, View::Game).expect("a view").expect("drawn");
    }
    let mut shots = Vec::new();
    let mut tick = 0;
    for at in SHOTS {
        while tick < at {
            runtime.step(FIXED_STEP_MS);
            tick += 1;
        }
        for class in CLASSES {
            set_class(presenter, class);
            for (name, view) in VIEWS {
                let (shot, again) = (capture(presenter, &mut runtime, view), capture(presenter, &mut runtime, view));
                let label = format!("{name}-{at}-{class}");
                assert_eq!(shot.digest(), again.digest(), "{label}: two settled captures of one tick differ");
                shots.push((label, shot.digest(), shot.bgra().to_vec(), [shot.width(), shot.height()]));
            }
        }
    }
    assert_eq!(presenter.failure(), None);
    shots
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_settled_captures_equal_from_the_game_camera_and_the_observer_and_replay() {
    let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
    let mut presenter = match Presenter::open(WORLD_SIZE, assets()) {
        Ok(presenter) => presenter,
        Err(error) if require => panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}"),
        Err(error) => return eprintln!("skipped: no WebGPU-core adapter ({error})"),
    };
    let mut fresh = Presenter::open(WORLD_SIZE, assets()).expect("a second presenter on the same adapter");
    let dir = out_dir();
    let first = shoot_all(&mut presenter);
    let mut digests = genex::json!({});
    for (label, digest, bgra, size) in &first {
        write_png(&dir.join(format!("frontier-{label}.png")), bgra, *size);
        digests[label.as_str()] = genex::json!(format!("{digest:016x}"));
        println!("{label}: {digest:016x}");
    }
    std::fs::write(dir.join("frontier-digests.json"), digests.to_string()).expect("the digests write");
    // The forest's impostor is one job, resolved. A streamed model never bakes mid-game: it loads
    // the build's atlas (`game.impostor_bake`, baked by the host's bake runner after a dev build),
    // and a cargo test has none, so here the pines keep their mesh (`impostor-not-baked`).
    let tally = presenter.impostor_tally();
    println!("impostors: bakes {}, loads {}, jobs {}/{} finished, stats {:?}", presenter.impostor_bakes(), presenter.impostor_loads(), tally.finished, tally.submitted, presenter.impostor_stats());
    assert_eq!((tally.submitted, tally.finished), (1, 1), "the pine's impostor is one resolved job");
    for pair in first.chunks(2) {
        assert_eq!(pair[0].1, pair[1].1, "{} and {}: the observer where the game camera is sees the same picture", pair[0].0, pair[1].0);
    }
    let second = shoot_all(&mut fresh);
    for ((label, digest, ..), (_, again, ..)) in first.iter().zip(&second) {
        assert_eq!(digest, again, "{label}: a second run's capture differs");
    }
}
