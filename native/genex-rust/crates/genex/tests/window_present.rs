//! A game in a window larger than its world (renderer pass 2, P2-0.9 step A; findings F1/RC-03):
//! the desktop shell's own frames, presented into an offscreen window the way the shell presents
//! onto a real one (`genex::desktop_shot`). The world is drawn at the window's own pixels (step B),
//! never stretched nearest-texel (which repeated three window columns and rows in five at 2.5x and
//! made every edge a staircase), and the HUD is painted after it at the window's own pixels.
//!
//! GPU rows: they skip when the host has no WebGPU-core adapter, and `GENEX_REQUIRE_METAL=1` turns
//! that skip into a failure. With `GENEX_WINDOW_EVIDENCE_DIR` set to an absolute folder the
//! template's row writes its window there as a PPM.

use std::path::PathBuf;

use genex::prelude::*;
use genex::{DesktopShot, DesktopShotError, desktop_shot};

#[path = "../../../../../src/game-template-rust/src/game.rs"]
#[allow(dead_code, reason = "the template's starter: this file uses its hooks only")]
mod template;

/// A world 2.5 window pixels a side smaller than the window: no nearest stretch draws it evenly.
const WORLD: [u32; 2] = [480, 270];
const WINDOW: [u32; 2] = [1200, 675];
const SCALE: f32 = 2.5;
/// Frames the shell runs before the shot.
const FRAMES: u64 = 4;
/// The most of the window's detailed columns (and rows) that may repeat their neighbour exactly.
const DUPLICATE_SHARE_MAX: f64 = 0.01;
/// The HUD rectangle in HUD points: its left edge lands on window column 251 at 2.5 pixels a
/// point, between the columns a world texel covers (250 to 252.5), so only a HUD painted at the
/// window's pixels has its edge there.
const HUD_LEFT: f32 = 100.4;
const HUD_TOP: f32 = 20.0;
const HUD_RIGHT: f32 = 140.4;
const HUD_BOTTOM: f32 = 40.0;
const WHITE: [u8; 3] = [255, 255, 255];
const REQUIRE_METAL_ENV: &str = "GENEX_REQUIRE_METAL";
const EVIDENCE_ENV: &str = "GENEX_WINDOW_EVIDENCE_DIR";
/// The template's world (`src/game-template-rust/src/main.rs`) and a 1080p window, twice its size.
const TEMPLATE_WORLD: [u32; 2] = [960, 540];
const TEMPLATE_WINDOW: [u32; 2] = [1920, 1080];
/// The stack the shot's frames run on: a desktop shell runs them on the game's main thread (8 MiB
/// on macOS). A test thread's default 2 MiB is too small for an unoptimized (debug) build of the
/// renderer, whose moves are not elided, so `cargo test --workspace` overflowed it.
const SHELL_STACK_BYTES: usize = 8 * 1024 * 1024;

#[derive(Default)]
struct Shapes;

/// Cubes and spheres in rows (edges and highlights everywhere) under a white HUD rectangle.
fn game() -> Game<Shapes> {
    let mut game = Game::new(Shapes).world_size(WORLD[0], WORLD[1]).background(Color::rgb(30, 40, 60));
    game.camera(|_| Camera::look_at(vec3(0.0, 4.0, 10.0), vec3(0.0, 0.5, 0.0)));
    game.on_draw(|_, frame, _| {
        let colors = [Color::RED, Color::rgb(0, 228, 48), Color::rgb(0, 121, 241), Color::rgb(253, 249, 0), Color::WHITE];
        for row in 0..4 {
            for (i, color) in colors.iter().enumerate() {
                let x = i as f32 * 1.6 - 3.2 + row as f32 * 0.3;
                let z = -(row as f32) * 1.8;
                if (row + i) % 2 == 0 {
                    frame.cube(Transform::from_xyz(x, 0.0, z), *color);
                } else {
                    frame.sphere(vec3(x, 0.0, z), 0.5, *color);
                }
            }
        }
    });
    game.on_ui(|_, ui, _| {
        let rect = egui::Rect::from_min_max(egui::pos2(HUD_LEFT, HUD_TOP), egui::pos2(HUD_RIGHT, HUD_BOTTOM));
        ui.painter().rect_filled(rect, 0.0, egui::Color32::WHITE);
    });
    game
}

/// The shot of `game()` in `WINDOW`, or None when the host has no GPU (unless one is required).
fn shot() -> Option<DesktopShot> {
    on_shell_stack(|| shot_of(game(), WINDOW))
}

/// `run` on a thread with the shell's stack ([`SHELL_STACK_BYTES`]); its panic is this thread's.
fn on_shell_stack<T: Send + 'static>(run: impl FnOnce() -> T + Send + 'static) -> T {
    let thread = std::thread::Builder::new().name("shell-stack".to_owned()).stack_size(SHELL_STACK_BYTES).spawn(run);
    thread.expect("the shot's thread starts").join().unwrap_or_else(|panic| std::panic::resume_unwind(panic))
}

/// The shot of `game` in `window`, or None when the host has no GPU (unless one is required).
fn shot_of<W: Default + 'static>(game: Game<W>, window: [u32; 2]) -> Option<DesktopShot> {
    match desktop_shot(game, &[], FRAMES, window) {
        Ok(shot) => Some(shot),
        Err(DesktopShotError::Gpu(error)) if std::env::var(REQUIRE_METAL_ENV).is_ok_and(|v| v == "1") => {
            panic!("{REQUIRE_METAL_ENV}=1 but no GPU: {error}")
        }
        Err(DesktopShotError::Gpu(error)) => {
            eprintln!("skipped: no WebGPU-core adapter ({error})");
            None
        }
        Err(error) => panic!("the shot failed: {error}"),
    }
}

/// The shot's pixel at window `(x, y)` as [r, g, b].
fn rgb(shot: &DesktopShot, x: u32, y: u32) -> [u8; 3] {
    let i = ((y * shot.window[0] + x) * 4) as usize;
    [shot.bgra[i + 2], shot.bgra[i + 1], shot.bgra[i]]
}

/// The share of the window's columns that repeat the column to their right exactly, and of its
/// rows, among the lines that are not one flat colour.
fn duplicate_shares(shot: &DesktopShot) -> (f64, f64) {
    let [width, height] = shot.window;
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
    let columns = share(width, &|x| (0..height).map(|y| rgb(shot, x, y)).collect());
    let rows = share(height, &|y| (0..width).map(|x| rgb(shot, x, y)).collect());
    (columns, rows)
}

#[test]
fn metal_a_window_larger_than_the_world_shows_it_upscaled_not_nearest_blocky() {
    let Some(shot) = shot() else { return };
    let (columns, rows) = duplicate_shares(&shot);
    eprintln!("2.5x window: repeated columns {columns:.3}, rows {rows:.3}");
    assert!(columns <= DUPLICATE_SHARE_MAX && rows <= DUPLICATE_SHARE_MAX, "nearest-blocky: {columns:.3} of columns and {rows:.3} of rows repeat");
}

#[test]
fn metal_the_hud_is_painted_after_the_upscale_at_the_windows_pixels() {
    let Some(shot) = shot() else { return };
    let left = (HUD_LEFT * SCALE).round() as u32;
    let right = (HUD_RIGHT * SCALE).round() as u32;
    let (top, bottom) = ((HUD_TOP * SCALE) as u32, (HUD_BOTTOM * SCALE) as u32);
    for y in top + 1..bottom - 1 {
        let row: Vec<[u8; 3]> = (left - 2..left + 3).map(|x| rgb(&shot, x, y)).collect();
        assert_ne!(rgb(&shot, left - 1, y), WHITE, "row {y}: the HUD starts at column {left}, not before: {row:?}");
        assert_eq!(rgb(&shot, left, y), WHITE, "row {y}: the HUD's left edge is on column {left}: {row:?}");
        assert_eq!(rgb(&shot, right - 1, y), WHITE, "row {y}: the HUD's right edge");
        assert_ne!(rgb(&shot, right, y), WHITE, "row {y}: the HUD ends before column {right}");
    }
}

/// Write the shot as a binary PPM under `GENEX_WINDOW_EVIDENCE_DIR` when it names an absolute folder.
fn write_evidence(shot: &DesktopShot, name: &str) {
    let Some(dir) = std::env::var_os(EVIDENCE_ENV).map(PathBuf::from) else { return };
    assert!(dir.is_absolute(), "{EVIDENCE_ENV} must be absolute: {dir:?}");
    std::fs::create_dir_all(&dir).expect("evidence folder");
    let [width, height] = shot.window;
    let mut ppm = format!("P6\n{width} {height}\n255\n").into_bytes();
    ppm.extend(shot.bgra.as_chunks::<4>().0.iter().flat_map(|px| [px[2], px[1], px[0]]));
    let file = dir.join(name);
    std::fs::write(&file, ppm).expect("write the PPM");
    eprintln!("evidence: {}", file.display());
}

#[test]
fn metal_the_template_in_a_1080p_window_is_upscaled_not_nearest_blocky() {
    let template_shot = || {
        let mut game = Game::new(template::World::default()).world_size(TEMPLATE_WORLD[0], TEMPLATE_WORLD[1]);
        template::wire(&mut game);
        shot_of(game, TEMPLATE_WINDOW)
    };
    let Some(shot) = on_shell_stack(template_shot) else { return };
    write_evidence(&shot, "template-1080p-window.ppm");
    // Step B (F1/RC-03): rendered at the window's own pixels, not upscaled from 960x540.
    assert_eq!(shot.output, TEMPLATE_WINDOW, "the template is rendered natively at 1080p");
    let (columns, rows) = duplicate_shares(&shot);
    eprintln!("template at 2x: repeated columns {columns:.3}, rows {rows:.3}");
    assert!(columns <= DUPLICATE_SHARE_MAX && rows <= DUPLICATE_SHARE_MAX, "nearest-blocky: {columns:.3} of columns and {rows:.3} of rows repeat");
}
