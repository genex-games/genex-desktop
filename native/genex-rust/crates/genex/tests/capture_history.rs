//! A capture whose pinned samples differ from Live's leaves Live's temporal history where it was
//! (review F5): the Live renderer swapped back after the capture keeps counting its frames instead
//! of starting its TAA, temporal AO and auto-exposure history over (a visible pop or blink in the
//! Live view after every agent capture). A renderer that stayed out for long starts over.
//!
//! Metal rows (`--ignored metal`), one GPU row at a time.

use genex::View;
use genex::prelude::*;
use genex::present::Presenter;
use genex::render::{ClassOverride, QualityPreset};
use genex::Runtime;

/// How many Live frames the rows draw before a capture.
const LIVE_FRAMES: u64 = 12;
/// Frames drawn at another preset in the long-out row: past the spare's history window.
const LONG_OUT_FRAMES: u64 = 80;

static GPU_ROWS: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn gpu_rows() -> std::sync::MutexGuard<'static, ()> {
    GPU_ROWS.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// A studio-style presenter (settings changes warmed off the frame thread, one spare kept).
fn presenter() -> Option<Presenter> {
    match Presenter::open([160, 90], &[]) {
        Ok(mut presenter) => {
            presenter.set_off_thread_changes(true);
            Some(presenter)
        }
        Err(error) if std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|value| value == "1") => {
            panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}")
        }
        Err(error) => {
            eprintln!("skipped: no WebGPU-core adapter ({error})");
            None
        }
    }
}

#[derive(Default)]
struct Scene;

fn scene_game() -> Game<Scene> {
    let mut game = Game::new(Scene).world_size(160, 90).background(Color::rgb(30, 40, 60));
    game.camera(|_| Camera::look_at(vec3(3.0, 3.0, 6.0), Vec3::ZERO));
    game.on_draw(|_, frame, _| {
        frame.cube(Transform::from_xyz(0.0, 0.5, 0.0), Color::RED);
        frame.cube(Transform::from_xyz(0.0, -0.5, 0.0).with_scale(vec3(6.0, 0.2, 6.0)), Color::rgb(90, 160, 90));
    });
    game
}

fn live(presenter: &mut Presenter, runtime: &mut Runtime<Scene>) {
    presenter.draw_view(runtime, View::Game).expect("a view").expect("a Live frame");
}

/// Live's world pass samples.
fn samples(presenter: &Presenter) -> u32 {
    presenter.resilient.renderer().renderer().sample_count()
}

/// Live frames until Live draws with `wanted` samples (a warmed renderer landed).
fn live_until_samples(presenter: &mut Presenter, runtime: &mut Runtime<Scene>, wanted: u32) {
    for _ in 0..2000 {
        if samples(presenter) == wanted {
            return;
        }
        live(presenter, runtime);
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    panic!("Live never landed on {wanted} samples");
}

fn capture(presenter: &mut Presenter, runtime: &mut Runtime<Scene>) {
    presenter.set_capturing(true);
    presenter.draw_view(runtime, View::Game).expect("a view").expect("a capture");
    presenter.set_capturing(false);
}

fn medium() -> ClassOverride {
    ClassOverride { preset: Some(QualityPreset::Medium), ..ClassOverride::default() }
}

/// Live on medium (MSAA, 4 samples) on a reference-class host whose pinned capture profile is
/// high (TAA, 1 sample): its frames drawn and counted.
fn live_on_medium() -> Option<(Presenter, Runtime<Scene>)> {
    let mut presenter = presenter()?;
    let mut runtime = Runtime::new(scene_game()).expect("installs");
    live(&mut presenter, &mut runtime);
    runtime.render().borrow_mut().set_person(medium());
    live_until_samples(&mut presenter, &mut runtime, 4);
    for _ in 0..LIVE_FRAMES {
        live(&mut presenter, &mut runtime);
    }
    Some((presenter, runtime))
}

#[test]
#[ignore = "needs the host GPU: run with --ignored metal"]
fn metal_live_s_history_keeps_counting_across_a_capture_on_other_samples() {
    let _gpu = gpu_rows();
    let Some((mut presenter, mut runtime)) = live_on_medium() else { return };
    let before = presenter.resilient.renderer().frame_index();
    assert!(before >= LIVE_FRAMES, "Live counted its frames ({before})");
    capture(&mut presenter, &mut runtime);
    assert_eq!(samples(&presenter), 1, "the capture drew the pinned profile's one sample");
    live(&mut presenter, &mut runtime);
    assert_eq!(samples(&presenter), 4, "Live is back on its own renderer");
    let after = presenter.resilient.renderer().frame_index();
    assert_eq!(after, before + 1, "Live's frame index went on from {before} (a reset starts it over)");
}

#[test]
#[ignore = "needs the host GPU: run with --ignored metal"]
fn metal_a_renderer_that_stayed_out_long_starts_its_history_over() {
    let _gpu = gpu_rows();
    let Some((mut presenter, mut runtime)) = live_on_medium() else { return };
    let person = ClassOverride { preset: Some(QualityPreset::High), ..ClassOverride::default() };
    runtime.render().borrow_mut().set_person(person);
    live_until_samples(&mut presenter, &mut runtime, 1);
    for _ in 0..LONG_OUT_FRAMES {
        live(&mut presenter, &mut runtime);
    }
    runtime.render().borrow_mut().set_person(medium());
    live_until_samples(&mut presenter, &mut runtime, 4);
    let index = presenter.resilient.renderer().frame_index();
    assert!(index <= 2, "medium's renderer came back after {LONG_OUT_FRAMES} frames at high with its old history ({index})");
}
