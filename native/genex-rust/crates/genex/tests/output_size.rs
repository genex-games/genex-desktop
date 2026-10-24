//! Live renders at the window's pixels; captures at the world size or the size asked for (renderer
//! pass 2, P2-0.9 step B; findings F1/RC-03). Before, every frame was drawn at the game's
//! `world_size` (960x540 in the template) and stretched to the window, so shadows, AO, TAA and the
//! HUD never had more pixels than the world. `world_size` stays the logical size: input, the HUD's
//! points and the default capture size.
//!
//! Metal rows (`--ignored metal`), one GPU row at a time. With `GENEX_OUTPUT_EVIDENCE_DIR` set to
//! an absolute folder the requested-size row writes its captures there as PPMs.
#![allow(clippy::disallowed_methods, reason = "test glue: the determinism row runs this binary as child processes")]
#![allow(clippy::disallowed_types, reason = "test glue: the determinism row runs this binary as child processes")]

use std::path::PathBuf;
use std::process::Command;

use genex::View;
use genex::prelude::*;
use genex::present::Presenter;
use genex::Runtime;
use genex_render::capture::Capture;
use genex_render::presets::reference_resolution;

#[path = "../../../../../src/game-template-rust/src/game.rs"]
#[allow(dead_code, reason = "the template's starter: this file uses its hooks only")]
mod template;

/// The template's world (`src/game-template-rust/src/main.rs`).
const WORLD: [u32; 2] = [960, 540];
/// A 1080p window, twice the world a side.
const WINDOW_1080P: (u32, u32) = (1920, 1080);
/// A 5K window: more pixels than any class's reference resolution.
const WINDOW_5K: (u32, u32) = (5120, 2880);
/// The 4K/1440p capture plan's sizes.
const SIZE_1440P: (u32, u32) = (2560, 1440);
const SIZE_4K: (u32, u32) = (3840, 2160);
/// One sim tick, in milliseconds.
const TICK_MS: f64 = 1000.0 / 60.0;
/// Live frames drawn before a row looks.
const LIVE_FRAMES: usize = 3;
/// Child processes per size in the determinism row.
const CHILD_RUNS: usize = 4;
/// The HUD rectangle in HUD points (one point per world pixel).
const HUD_RECT: [f32; 4] = [100.0, 20.0, 140.0, 40.0];
/// The most of a capture's detailed columns (and rows) that may repeat their neighbour exactly: a
/// 960x540 world stretched to 1920x1080 repeats every other one.
const DUPLICATE_SHARE_MAX: f64 = 0.05;
const WHITE: [u8; 3] = [255, 255, 255];
const REQUIRE_METAL_ENV: &str = "GENEX_REQUIRE_METAL";
const EVIDENCE_ENV: &str = "GENEX_OUTPUT_EVIDENCE_DIR";
/// Where a child run writes its digest, and the size it captures at.
const CHILD_OUT_ENV: &str = "GENEX_OUTPUT_CHILD_OUT";
const CHILD_SIZE_ENV: &str = "GENEX_OUTPUT_CHILD_SIZE";

static GPU_ROWS: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn gpu_rows() -> std::sync::MutexGuard<'static, ()> {
    GPU_ROWS.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn presenter() -> Option<Presenter> {
    match Presenter::open(WORLD, &[]) {
        Ok(presenter) => Some(presenter),
        Err(error) if std::env::var(REQUIRE_METAL_ENV).is_ok_and(|v| v == "1") => panic!("{REQUIRE_METAL_ENV}=1 and no WebGPU-core adapter: {error}"),
        Err(error) => {
            eprintln!("skipped: no WebGPU-core adapter ({error})");
            None
        }
    }
}

/// The template's starter under a white HUD rectangle.
fn template_game() -> Game<template::World> {
    let mut game = Game::new(template::World::default()).world_size(WORLD[0], WORLD[1]);
    template::wire(&mut game);
    game.on_ui(|_, ui, _| {
        let [left, top, right, bottom] = HUD_RECT;
        let rect = egui::Rect::from_min_max(egui::pos2(left, top), egui::pos2(right, bottom));
        ui.painter().rect_filled(rect, 0.0, egui::Color32::WHITE);
    });
    game
}

/// The template installed and ticked once, so its HUD has drawn.
fn ticked() -> Runtime<template::World> {
    let mut runtime = Runtime::new(template_game()).expect("installs");
    runtime.step(TICK_MS);
    runtime
}

fn live(presenter: &mut Presenter, runtime: &mut Runtime<template::World>) {
    presenter.draw_view(runtime, View::Game).expect("a view").expect("a Live frame");
}

/// A settled capture of the game view, read back.
fn capture(presenter: &mut Presenter, runtime: &mut Runtime<template::World>) -> Capture {
    presenter.set_capturing(true);
    presenter.draw_view(runtime, View::Game).expect("a view").expect("a capture");
    presenter.set_capturing(false);
    presenter.resilient.capture().expect("readback")
}

fn output(presenter: &Presenter) -> (u32, u32) {
    presenter.resilient.renderer().renderer().size()
}

fn rgb(capture: &Capture, x: u32, y: u32) -> [u8; 3] {
    let i = ((y * capture.width() + x) * 4) as usize;
    let bgra = capture.bgra();
    [bgra[i + 2], bgra[i + 1], bgra[i]]
}

/// The share of a capture's detailed columns that repeat the column to their right exactly, and
/// of its rows: a stretch of a smaller world repeats them; a native frame almost never does.
fn duplicate_shares(capture: &Capture) -> (f64, f64) {
    let (width, height) = (capture.width(), capture.height());
    let share = |lines: u32, line: &dyn Fn(u32) -> Vec<[u8; 3]>| {
        let (mut detailed, mut repeated) = (0_u32, 0_u32);
        for i in 0..lines - 1 {
            let this = line(i);
            if this.iter().all(|p| *p == this[0]) {
                continue;
            }
            detailed += 1;
            repeated += u32::from(this == line(i + 1));
        }
        f64::from(repeated) / f64::from(detailed.max(1))
    };
    let columns = share(width, &|x| (0..height).map(|y| rgb(capture, x, y)).collect());
    let rows = share(height, &|y| (0..width).map(|x| rgb(capture, x, y)).collect());
    (columns, rows)
}

fn write_evidence(capture: &Capture, name: &str) {
    let Some(dir) = std::env::var_os(EVIDENCE_ENV).map(PathBuf::from) else { return };
    assert!(dir.is_absolute(), "{EVIDENCE_ENV} must be absolute: {dir:?}");
    std::fs::create_dir_all(&dir).expect("evidence folder");
    let (width, height) = (capture.width(), capture.height());
    let mut ppm = format!("P6\n{width} {height}\n255\n").into_bytes();
    ppm.extend(capture.bgra().as_chunks::<4>().0.iter().flat_map(|px| [px[2], px[1], px[0]]));
    let file = dir.join(name);
    std::fs::write(&file, ppm).expect("write the PPM");
    eprintln!("evidence: {}", file.display());
}

/// F1/RC-03: a 960x540 game in a 1920x1080 window is rendered at 1920x1080. On the port head the
/// world target stayed 960x540 whatever the window, and the present stretched it.
#[test]
#[ignore = "needs the host GPU: run with --ignored metal"]
fn metal_live_renders_at_the_window_s_pixels_not_at_the_world_size() {
    let _gpu = gpu_rows();
    let Some(mut presenter) = presenter() else { return };
    let mut runtime = ticked();
    presenter.set_window_size(WINDOW_1080P);
    for _ in 0..LIVE_FRAMES {
        live(&mut presenter, &mut runtime);
    }
    assert_eq!(output(&presenter), WINDOW_1080P, "Live draws the window's pixels");
    assert_eq!(presenter.resilient.renderer().renderer().logical_size(), (WORLD[0], WORLD[1]), "the world stays the logical size");
}

/// The cap: a window with more pixels than the Live class's reference resolution renders at the
/// reference's pixels with the world's aspect, and the window present upscales the rest.
#[test]
#[ignore = "needs the host GPU: run with --ignored metal"]
fn metal_live_output_is_capped_at_the_class_reference_pixels() {
    let _gpu = gpu_rows();
    let Some(mut presenter) = presenter() else { return };
    let mut runtime = ticked();
    presenter.set_window_size(WINDOW_5K);
    for _ in 0..LIVE_FRAMES {
        live(&mut presenter, &mut runtime);
    }
    let class = runtime.render().borrow().live_class();
    let (rw, rh) = reference_resolution(class);
    let (w, h) = output(&presenter);
    eprintln!("5K window as {}: output {w}x{h} (reference {rw}x{rh})", class.wire());
    assert!(u64::from(w) * u64::from(h) <= u64::from(rw) * u64::from(rh), "{w}x{h} over the {rw}x{rh} reference");
    assert!(w > WORLD[0] && h > WORLD[1], "more pixels than the world");
    assert!((f64::from(w) / f64::from(h) - 16.0 / 9.0).abs() < 0.01, "the world's aspect: {w}x{h}");
}

/// Captures stay pinned: a capture after Live drew a 1080p window is the world-size capture of a
/// presenter that never saw a window, byte for byte, and Live goes back to the window's size.
#[test]
#[ignore = "needs the host GPU: run with --ignored metal"]
fn metal_captures_stay_at_the_world_size_whatever_the_window() {
    let _gpu = gpu_rows();
    let Some(mut windowless) = presenter() else { return };
    let mut runtime = ticked();
    let plain = capture(&mut windowless, &mut runtime);
    drop(windowless);
    let Some(mut windowed) = presenter() else { return };
    let mut runtime = ticked();
    windowed.set_window_size(WINDOW_1080P);
    for _ in 0..LIVE_FRAMES {
        live(&mut windowed, &mut runtime);
    }
    let shot = capture(&mut windowed, &mut runtime);
    assert_eq!((shot.width(), shot.height()), (WORLD[0], WORLD[1]), "captured at the world size");
    assert_eq!(shot.digest(), plain.digest(), "the window never reaches a capture");
    assert!(!windowed.last_draw_is_live(), "a world-size capture is not the window-size Live picture");
    live(&mut windowed, &mut runtime);
    assert_eq!(output(&windowed), WINDOW_1080P, "Live is back at the window's pixels");
}

/// Lane EF: under `fit = "expand"` Live draws at a 21:9 and a 4:3 window's whole pixels (the
/// present leaves no bars), while a world-size capture is the letterbox game's byte for byte (the
/// goldens do not move) and the simulation reads the same checksum under both windows.
#[test]
#[ignore = "needs the host GPU: run with --ignored metal"]
fn metal_expand_fills_any_window_and_leaves_captures_and_the_sim_alone() {
    let _gpu = gpu_rows();
    let Some(mut letterboxed) = presenter() else { return };
    let mut runtime = ticked();
    let plain = capture(&mut letterboxed, &mut runtime);
    drop(letterboxed);
    let mut checksums = Vec::new();
    for window in [(2520, 1080), (1440, 1080)] {
        let Some(mut presenter) = presenter() else { return };
        let mut runtime = Runtime::new(template_game().fit(Fit::Expand)).expect("installs");
        runtime.step(TICK_MS);
        presenter.set_window_size(window);
        for _ in 0..LIVE_FRAMES {
            live(&mut presenter, &mut runtime);
            runtime.step(TICK_MS);
        }
        assert_eq!(output(&presenter), window, "{window:?}: Live draws the whole window");
        checksums.push(runtime.checksum());
        let mut fresh = Runtime::new(template_game().fit(Fit::Expand)).expect("installs");
        fresh.step(TICK_MS);
        let shot = capture(&mut presenter, &mut fresh);
        assert_eq!((shot.width(), shot.height()), (WORLD[0], WORLD[1]), "{window:?}: captured at the world size");
        assert_eq!(shot.digest(), plain.digest(), "{window:?}: an expand capture is the letterbox game's");
    }
    assert_eq!(checksums[0], checksums[1], "the window never reaches the simulation");
}

/// `capture --size` (the 4K/1440p plan): a capture drawn natively at the size asked for, the HUD
/// at that size's pixels (two device pixels per point at 1920x1080), the same picture twice, and
/// Live's history left alone.
#[test]
#[ignore = "needs the host GPU: run with --ignored metal"]
fn metal_a_capture_at_a_requested_size_is_drawn_natively_at_that_size() {
    let _gpu = gpu_rows();
    let Some(mut presenter) = presenter() else { return };
    let mut runtime = ticked();
    for _ in 0..LIVE_FRAMES {
        live(&mut presenter, &mut runtime);
    }
    let index = presenter.resilient.renderer().frame_index();
    presenter.set_capture_size(Some(WINDOW_1080P));
    let first = capture(&mut presenter, &mut runtime);
    let second = capture(&mut presenter, &mut runtime);
    presenter.set_capture_size(None);
    write_evidence(&first, "template-capture-1080p.ppm");
    assert_eq!((first.width(), first.height()), WINDOW_1080P, "captured at the size asked for");
    assert_eq!(first.digest(), second.digest(), "the same picture twice");
    assert_eq!(presenter.resilient.renderer().frame_index(), index, "a capture leaves Live's history where it was");
    let (columns, rows) = duplicate_shares(&first);
    eprintln!("1080p capture of a 960x540 world: repeated columns {columns:.3}, rows {rows:.3}");
    assert!(columns <= DUPLICATE_SHARE_MAX && rows <= DUPLICATE_SHARE_MAX, "a stretch, not a native frame: {columns:.3} / {rows:.3}");
    let [left, top, right, bottom] = HUD_RECT.map(|v| (v * 2.0) as u32);
    let middle = (top + bottom) / 2;
    assert_eq!(rgb(&first, left + 1, middle), WHITE, "the HUD at twice its points");
    assert_eq!(rgb(&first, right - 2, middle), WHITE, "the HUD's right edge at twice its points");
    assert_ne!(rgb(&first, right + 2, middle), WHITE, "the HUD ends at twice its points");
    let plain = capture(&mut presenter, &mut runtime);
    assert_eq!((plain.width(), plain.height()), (WORLD[0], WORLD[1]), "without a size: the world size again");
}

/// A settled capture of the template at `size` in this process.
fn capture_at(size: (u32, u32)) -> Option<Capture> {
    let mut presenter = presenter()?;
    let mut runtime = ticked();
    presenter.set_capture_size(Some(size));
    Some(capture(&mut presenter, &mut runtime))
}

/// The child half of the determinism row: with [`CHILD_OUT_ENV`] set, capture at
/// [`CHILD_SIZE_ENV`] (`WxH`) and write the digest there.
#[test]
#[ignore = "needs the host GPU: run with --ignored metal"]
fn metal_output_child_capture() {
    let (Ok(out), Ok(size)) = (std::env::var(CHILD_OUT_ENV), std::env::var(CHILD_SIZE_ENV)) else { return };
    let (w, h) = size.split_once('x').expect("WxH");
    let size = (w.parse().expect("width"), h.parse().expect("height"));
    let shot = capture_at(size).expect("a GPU in the child");
    assert_eq!((shot.width(), shot.height()), size);
    std::fs::write(out, format!("{:016x}", shot.digest())).expect("child digest");
}

fn child_digest(size: (u32, u32), run: usize) -> String {
    let out = std::env::temp_dir().join(format!("genex-output-child-{}-{}x{}-{run}.txt", std::process::id(), size.0, size.1));
    let _ = std::fs::remove_file(&out);
    let status = Command::new(std::env::current_exe().expect("test binary"))
        .args(["--ignored", "--exact", "metal_output_child_capture", "--test-threads=1"])
        .env(CHILD_OUT_ENV, &out)
        .env(CHILD_SIZE_ENV, format!("{}x{}", size.0, size.1))
        .status()
        .expect("child run");
    assert!(status.success(), "child run {run} at {size:?} failed");
    let digest = std::fs::read_to_string(&out).expect("child wrote its digest");
    let _ = std::fs::remove_file(&out);
    digest
}

/// The 4K/1440p plan's stills: settled captures at 2560x1440 and 3840x2160 are the same bytes in
/// four processes.
#[test]
#[ignore = "needs the host GPU: run with --ignored metal"]
fn metal_settled_captures_at_1440p_and_4k_are_deterministic_across_processes() {
    let _gpu = gpu_rows();
    if presenter().is_none() {
        return;
    }
    for size in [SIZE_1440P, SIZE_4K] {
        let digests: Vec<String> = (0..CHILD_RUNS).map(|run| child_digest(size, run)).collect();
        eprintln!("{}x{}: {digests:?}", size.0, size.1);
        assert!(digests.iter().all(|digest| *digest == digests[0]), "{size:?} differs across processes: {digests:?}");
    }
}
