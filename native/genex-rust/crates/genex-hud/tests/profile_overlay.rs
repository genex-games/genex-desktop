//! The player profile overlay (G6 PROFILE, PROF-8): its own egui context beside the HUD's, nothing
//! drawn while hidden, the Ctrl+Shift+P chord, and the view read from the profiler's summary.
//! Every row is new behaviour (there was no overlay before PROF-8); the facade's capture, hud.items
//! and checksum rows are in `crates/genex/tests/profile_overlay.rs`.

use genex_hud::egui::epaint::Primitive;
use genex_hud::{Hud, HudInput, HudPaint, PROFILE_OVERLAY_TOP_ROWS, ProfileOverlay, ProfileView};

const WORLD: [u32; 2] = [320, 180];
const WINDOW: [u32; 2] = [1280, 720];
const SUMMARY: &[u8] = br#"{"v":1,"on":true,"frames":120,"cpu":{"p50":4.25,"p95":6.5},"gpu":{"p50":3.0,"p95":3.75,"source":"timestamps"},
"top":[{"scope":"tick","game":false,"p95":2.5},{"scope":"enemy_ai","game":true,"p95":1.25}],"counters":{"enemies":12},
"memory":[],"hitches":{"count":2,"last":90},"nodes":"off","dropped":{"scopes":0,"counters":0,"frames":0}}"#;

fn keys(names: &[&str]) -> Vec<String> {
    names.iter().map(|name| (*name).to_owned()).collect()
}

fn vertices(paint: &HudPaint) -> usize {
    paint
        .primitives
        .iter()
        .map(|primitive| match &primitive.primitive {
            Primitive::Mesh(mesh) => mesh.vertices.len(),
            Primitive::Callback(_) => 0,
        })
        .sum()
}

/// Handled: epaint asserts a texture delta is applied before it drops.
fn done(mut paint: HudPaint) {
    paint.textures_delta.clear();
}

fn hud_tick(hud: &mut Hud, tick: u32) {
    hud.run(WORLD, f64::from(tick) / 60.0, &HudInput::default(), |ui| {
        ui.label("Score 3");
        let _ = ui.button("Play");
    });
}

#[test]
fn a_hidden_overlay_draws_nothing_and_a_shown_one_draws_its_panel() {
    let mut overlay = ProfileOverlay::new();
    assert!(!overlay.shown(), "hidden until toggled");
    assert!(overlay.tessellate(WINDOW, 2.0).is_none());
    overlay.set_shown(true);
    let empty = overlay.tessellate(WINDOW, 2.0).expect("shown");
    assert!(!empty.primitives.is_empty(), "with no profiler it still says so");
    assert!(!empty.textures_delta.set.is_empty(), "its font atlas goes up with its first paint");
    assert_eq!(empty.pixels_per_point, 2.0);
    let without = vertices(&empty);
    done(empty);
    overlay.set_view(ProfileView::from_summary(SUMMARY));
    let full = overlay.tessellate(WINDOW, 2.0).expect("shown");
    assert!(vertices(&full) > without, "the frame times, hitches, scopes and counters add lines");
    done(full);
}

#[test]
fn the_overlay_has_its_own_egui_context_and_never_touches_the_huds() {
    let mut hud = Hud::new();
    let mut control = Hud::new();
    let mut overlay = ProfileOverlay::new();
    overlay.set_shown(true);
    overlay.set_view(ProfileView::from_summary(SUMMARY));
    assert!(overlay.context() != hud.context(), "a separate context");
    for tick in 0..3 {
        hud_tick(&mut hud, tick);
        hud_tick(&mut control, tick);
        if let Some(paint) = overlay.tessellate(WINDOW, 1.0) {
            done(paint);
        }
        assert_eq!(hud.summary(), control.summary(), "the HUD's items are the same with the overlay painted");
        assert_eq!(hud.widgets(), control.widgets());
    }
    assert_eq!(hud.summary().items, ["Score 3", "Play"], "the overlay's words are never HUD items");
    done(hud.paint(1.0));
    done(control.paint(1.0));
}

#[test]
fn ctrl_shift_p_toggles_on_its_press_only() {
    let mut overlay = ProfileOverlay::new();
    assert!(!overlay.note_keys(&keys(&["KeyP"])), "P alone is the game's");
    assert!(!overlay.note_keys(&keys(&["ControlLeft", "KeyP"])));
    assert!(overlay.note_keys(&keys(&["ControlLeft", "ShiftRight", "KeyP"])), "the chord's press toggles");
    assert!(overlay.shown());
    assert!(!overlay.note_keys(&keys(&["ControlLeft", "ShiftRight", "KeyP"])), "holding it does not toggle again");
    assert!(!overlay.note_keys(&keys(&["ControlLeft", "ShiftRight"])));
    assert!(overlay.note_keys(&keys(&["ControlRight", "ShiftLeft", "KeyP"])), "a second press hides it");
    assert!(!overlay.shown());
}

#[test]
fn the_view_reads_the_profilers_summary_and_refuses_junk() {
    let view = ProfileView::from_summary(SUMMARY).expect("a summary");
    assert_eq!((view.frames, view.cpu_ms, view.gpu_ms, view.hitches), (120, [4.25, 6.5], Some([3.0, 3.75]), 2));
    assert_eq!(view.top, [("tick".to_owned(), false, 2.5), ("enemy_ai".to_owned(), true, 1.25)]);
    assert_eq!(view.counters, [("enemies".to_owned(), 12.0)]);
    let no_gpu = ProfileView::from_summary(br#"{"frames":3,"cpu":{"p50":1,"p95":2},"gpu":null,"top":[],"counters":{},"hitches":{"count":0}}"#);
    assert_eq!(no_gpu.expect("a summary").gpu_ms, None);
    assert_eq!(ProfileView::from_summary(b"not json"), None);
    let many: Vec<String> = (0..9).map(|at| format!(r#"{{"scope":"s{at}","game":true,"p95":1}}"#)).collect();
    let long = format!(r#"{{"frames":1,"cpu":{{"p50":1,"p95":1}},"top":[{}],"counters":{{}},"hitches":{{"count":0}}}}"#, many.join(","));
    assert_eq!(ProfileView::from_summary(long.as_bytes()).expect("a summary").top.len(), PROFILE_OVERLAY_TOP_ROWS);
}

#[test]
fn the_panel_scales_with_the_window_not_the_world() {
    assert_eq!(ProfileOverlay::window_scale([960, 540]), 1.0);
    assert_eq!(ProfileOverlay::window_scale([1920, 1080]), 2.0);
    assert_eq!(ProfileOverlay::window_scale([320, 180]), 1.0, "never below a pixel per point");
    assert_eq!(ProfileOverlay::window_scale([7680, 4320]), 3.0, "and at most three");
}
