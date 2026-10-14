//! The egui HUD contract: egui reads only the merged input and the simulated clock, runs the UI
//! hooks exactly once per tick, forgets its memory on seed, and painting is display only, so a
//! scripted click on a shop button replays exactly, in one process or across two.

use genex_hud::{
    Color, Hud, HudInput, HudSummary, HudWidget, MAX_HUD_ITEMS, MAX_ITEM_NAME, WidgetRole, pixels_per_point, raw_input,
};
use std::process::Command;

const WORLD: [u32; 2] = [320, 180];
const TICK_MS: f64 = 1000.0 / 60.0;
const REPLAY_CHILD_ENV: &str = "GENEX_HUD_REPLAY_CHILD";
const REPLAY_LINE: &str = "genex-hud-replay ";

#[derive(Debug, Default, Clone, PartialEq, Eq, Hash)]
struct Shop {
    coins: u32,
    bait: u32,
    open_panels: u32,
}

impl Shop {
    fn probe(&self) -> (u32, u32) {
        (self.coins, self.bait)
    }
}

fn shop_ui(shop: &mut Shop, ui: &mut genex_hud::egui::Ui) {
    ui.label(format!("Coins: {}", shop.coins));
    if ui.button("Buy bait").clicked() && shop.coins > 0 {
        shop.coins -= 1;
        shop.bait += 1;
    }
    genex_hud::egui::CollapsingHeader::new("Upgrades").show(ui, |ui| {
        shop.open_panels += 1;
        ui.label("Rod +1");
    });
}

struct Session {
    hud: Hud,
    shop: Shop,
    tick: u64,
}

impl Session {
    fn new() -> Session {
        Session { hud: Hud::new(), shop: Shop { coins: 10, ..Shop::default() }, tick: 0 }
    }

    fn tick(&mut self, input: &HudInput) {
        let shop = &mut self.shop;
        self.hud.run(WORLD, self.tick as f64 * TICK_MS / 1000.0, input, |ui| shop_ui(shop, ui));
        self.tick += 1;
    }

    fn idle(&mut self) {
        self.tick(&HudInput::default());
    }

    fn widget(&self, label: &str) -> HudWidget {
        let found = self.hud.widgets().iter().find(|w| w.label == label).cloned();
        found.unwrap_or_else(|| panic!("no widget {label:?} in {:?}", self.hud.widgets()))
    }

    /// The `click_at` injection: pointer there, Mouse1 pressed and released on the same tick.
    fn click(&mut self, label: &str) {
        let pointer = self.widget(label).center_fraction(WORLD);
        self.tick(&HudInput { pointer, primary_pressed: true, primary_released: true, ..HudInput::default() });
    }
}

#[test]
fn an_injected_click_on_a_shop_button_changes_a_probe() {
    let mut session = Session::new();
    session.idle();
    assert_eq!(session.shop.probe(), (10, 0));
    session.click("Buy bait");
    assert_eq!(session.shop.probe(), (9, 1));
}

#[test]
fn a_press_and_a_later_release_click_too() {
    let mut session = Session::new();
    session.idle();
    let pointer = session.widget("Buy bait").center_fraction(WORLD);
    session.tick(&HudInput { pointer, primary_pressed: true, ..HudInput::default() });
    assert_eq!(session.shop.probe(), (10, 0), "a press alone is no click");
    session.tick(&HudInput { pointer, primary_released: true, ..HudInput::default() });
    assert_eq!(session.shop.probe(), (9, 1));
}

#[test]
fn a_click_beside_the_button_buys_nothing() {
    let mut session = Session::new();
    session.idle();
    session.tick(&HudInput { pointer: [0.95, 0.95], primary_pressed: true, primary_released: true, ..HudInput::default() });
    assert_eq!(session.shop.probe(), (10, 0));
}

#[test]
fn ui_hooks_run_exactly_once_per_tick() {
    let mut hud = Hud::new();
    let mut calls = 0;
    for tick in 0..5 {
        hud.run(WORLD, f64::from(tick) / 60.0, &HudInput::default(), |ui| {
            calls += 1;
            // A grid's first frame asks egui to discard it and run a second (sizing) pass.
            genex_hud::egui::Grid::new("inventory").show(ui, |ui| ui.label("empty"));
        });
    }
    assert_eq!(calls, 5);
}

#[test]
fn egui_memory_resets_on_seed() {
    let mut session = Session::new();
    session.idle();
    session.click("Upgrades");
    session.idle();
    assert!(session.hud.widgets().iter().any(|w| w.label == "Rod +1"), "the header opened");
    session.hud.reset();
    session.idle();
    assert!(!session.hud.widgets().iter().any(|w| w.label == "Rod +1"), "a seed closes it again");
}

/// egui's `Memory` as one comparable value: what its `Debug` shows (options, areas, layers) plus
/// what it hides there (the focused widget and how much widget state `data` holds).
fn memory(hud: &Hud) -> String {
    hud.context().memory(|m| format!("{m:?} focused={:?} data={}", m.focused(), m.data.len()))
}

/// A note field and a header: clicking the field focuses it, which egui keeps in `Memory`.
fn notes_tick(hud: &mut Hud, tick: u32, input: &HudInput, note: &mut String) {
    hud.run(WORLD, f64::from(tick) / 60.0, input, |ui| {
        ui.text_edit_singleline(note);
        genex_hud::egui::CollapsingHeader::new("Tips").show(ui, |ui| ui.label("Cast at dusk"));
    });
}

#[test]
fn egui_memory_differs_before_and_equals_a_fresh_one_after_seed() {
    let mut note = String::new();
    let mut fresh = Hud::new();
    notes_tick(&mut fresh, 0, &HudInput::default(), &mut note);
    let mut played = Hud::new();
    notes_tick(&mut played, 0, &HudInput::default(), &mut note);
    let field = played.widgets().iter().find(|w| w.role == WidgetRole::TextInput).cloned().expect("the note field");
    let header = played.widgets().iter().find(|w| w.label == "Tips").cloned().expect("the header");
    for (tick, target) in [(1, &header), (2, &field)] {
        let click =
            HudInput { pointer: target.center_fraction(WORLD), primary_pressed: true, primary_released: true, ..HudInput::default() };
        notes_tick(&mut played, tick, &click, &mut note);
    }
    notes_tick(&mut played, 3, &HudInput::default(), &mut note);
    assert!(played.context().memory(|m| m.focused().is_some()), "the click focused the note field");
    assert_ne!(memory(&played), memory(&fresh), "playing changed egui's memory");
    played.reset();
    notes_tick(&mut played, 0, &HudInput::default(), &mut note);
    assert_eq!(memory(&played), memory(&fresh), "a seed leaves the memory a fresh HUD has");
}

/// The display's device pixel ratio becomes egui's pixels per point; hostile ratios read as 1.
#[test]
fn pixels_per_point_is_the_display_ratio_within_bounds() {
    let rows = [(1.0, 1.0), (2.0, 2.0), (1.5, 1.5), (f64::NAN, 1.0), (0.0, 1.0), (-2.0, 1.0), (f64::INFINITY, 1.0), (1e9, 8.0), (1e-9, 0.25)];
    for (dpr, expected) in rows {
        assert_eq!(pixels_per_point(dpr), expected, "{dpr}");
    }
}

#[test]
fn widgets_are_recorded_in_order_with_world_pixel_rects() {
    let mut session = Session::new();
    session.idle();
    let labels: Vec<_> = session.hud.widgets().iter().map(|w| (w.role, w.label.as_str())).collect();
    assert_eq!(
        labels,
        [(WidgetRole::Label, "Coins: 10"), (WidgetRole::Button, "Buy bait"), (WidgetRole::Button, "Upgrades")]
    );
    let button = session.widget("Buy bait");
    let [x0, y0, x1, y1] = button.rect;
    assert!(0.0 <= x0 && x0 < x1 && x1 <= 320.0 && 0.0 <= y0 && y0 < y1 && y1 <= 180.0, "{button:?}");
}

#[test]
fn raw_input_reads_only_the_merged_input_and_the_simulated_clock() {
    let input = HudInput {
        pointer: [0.5, 0.25],
        primary_pressed: true,
        text: "ab".to_owned(),
        pressed_keys: vec!["Backspace".to_owned(), "NotAKey".to_owned()],
        ..HudInput::default()
    };
    let raw = raw_input(WORLD, 2.5, &input);
    assert_eq!(raw.time, Some(2.5));
    assert_eq!(raw.screen_rect.map(|r| (r.width(), r.height())), Some((320.0, 180.0)));
    let again = raw_input(WORLD, 2.5, &input);
    assert_eq!(format!("{:?}", raw.events), format!("{:?}", again.events), "a pure function of its inputs");
    let pointer = raw.events.iter().find_map(|e| match e {
        genex_hud::egui::Event::PointerMoved(pos) => Some((pos.x, pos.y)),
        _ => None,
    });
    assert_eq!(pointer, Some((160.0, 45.0)));
    let keys = raw.events.iter().filter(|e| matches!(e, genex_hud::egui::Event::Key { .. })).count();
    assert_eq!(keys, 1, "an unknown key name is dropped");
}

/// Hostile pointer values: NaN and out-of-frame fractions stay inside the world.
#[test]
fn hostile_pointer_values_are_clamped_into_the_world() {
    let rows = [([f32::NAN, f32::NAN], (160.0, 90.0)), ([-3.0, 7.0], (0.0, 180.0)), ([f32::INFINITY, 0.5], (320.0, 90.0))];
    for (pointer, expected) in rows {
        let raw = raw_input(WORLD, 0.0, &HudInput { pointer, ..HudInput::default() });
        let moved = raw.events.iter().find_map(|e| match e {
            genex_hud::egui::Event::PointerMoved(pos) => Some((pos.x, pos.y)),
            _ => None,
        });
        assert_eq!(moved, Some(expected), "{pointer:?}");
    }
}

#[test]
fn painting_is_display_only() {
    let script = |paint: bool| {
        let mut session = Session::new();
        session.idle();
        for _ in 0..3 {
            session.click("Buy bait");
            session.idle();
            if paint {
                let frame = session.hud.paint(2.0);
                assert!(!frame.primitives.is_empty(), "the HUD paints something");
            }
        }
        (session.shop.clone(), session.hud.widgets().to_vec(), session.hud.summary())
    };
    assert_eq!(script(true), script(false));
}

#[test]
fn the_first_paint_carries_the_font_atlas_and_later_ones_only_changes() {
    let mut session = Session::new();
    session.idle();
    session.idle();
    let first = session.hud.paint(1.0);
    assert!(!first.textures_delta.set.is_empty(), "the font atlas is uploaded once");
    session.idle();
    let second = session.hud.paint(1.0);
    assert!(second.textures_delta.set.is_empty(), "nothing new to upload: {:?}", second.textures_delta.set.len());
}

#[test]
fn legacy_items_are_named_in_the_summary() {
    let mut hud = Hud::new();
    hud.text("Score 3", 8, 8, 20, Color::WHITE);
    hud.bar("health", 0.5, 8, 40, 100, 10, Color::RED);
    hud.crosshair(true, 10, Color::WHITE);
    hud.flash(Color::WHITE, 0.8);
    hud.end_frame(WORLD);
    let summary = hud.summary();
    assert_eq!(summary.items, ["Score 3", "health"]);
    assert!(summary.crosshair);
    assert!((summary.flash - 0.8 * 0.85).abs() < 1e-6, "{summary:?}");
    hud.end_frame(WORLD);
    assert!(hud.summary().items.is_empty(), "items last one drawn frame");
}

#[test]
fn legacy_items_are_capped_and_named_briefly() {
    let mut hud = Hud::new();
    let long = "x".repeat(MAX_ITEM_NAME + 10);
    for _ in 0..MAX_HUD_ITEMS + 5 {
        hud.text(&long, 0, 0, 10, Color::WHITE);
    }
    hud.end_frame(WORLD);
    let summary = hud.summary();
    assert_eq!(summary.items.len(), MAX_HUD_ITEMS);
    assert!(summary.items.iter().all(|name| name.chars().count() == MAX_ITEM_NAME));
}

#[test]
fn a_flash_fades_out_and_a_seed_clears_the_legacy_hud() {
    let mut hud = Hud::new();
    hud.flash(Color::WHITE, 5.0);
    hud.crosshair(true, 0, Color::WHITE);
    for _ in 0..40 {
        hud.end_frame(WORLD);
    }
    assert_eq!(hud.summary().flash, 0.0);
    hud.text("a", 0, 0, 10, Color::WHITE);
    hud.end_frame(WORLD);
    hud.reset();
    assert_eq!(hud.summary(), HudSummary { items: vec![], crosshair: false, flash: 0.0 });
}

#[test]
fn egui_widgets_follow_legacy_items_in_the_summary() {
    let mut session = Session::new();
    session.hud.text("Score", 0, 0, 10, Color::WHITE);
    session.idle();
    session.hud.end_frame(WORLD);
    assert_eq!(session.hud.summary().items, ["Score", "Coins: 10", "Buy bait", "Upgrades"]);
}

/// What the replay digests: the sim, the HUD's record and the summary, after a scripted session
/// with the HUD painted every tick ("egui on screen").
fn replay_digest() -> String {
    let mut session = Session::new();
    session.idle();
    for round in 0..4 {
        session.click(if round == 2 { "Upgrades" } else { "Buy bait" });
        session.idle();
        session.hud.end_frame(WORLD);
        let _ = session.hud.paint(2.0);
    }
    let record = format!("{:?}|{:?}|{:?}", session.shop, session.hud.widgets(), session.hud.summary());
    let hash = record.bytes().fold(0xcbf2_9ce4_8422_2325_u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x100_0000_01b3));
    format!("{hash:016x} coins={} bait={}", session.shop.coins, session.shop.bait)
}

#[test]
fn two_process_replays_with_egui_on_screen_give_identical_digests() {
    if std::env::var_os(REPLAY_CHILD_ENV).is_some() {
        println!("{REPLAY_LINE}{}", replay_digest());
        return;
    }
    let replay = || {
        let output = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "two_process_replays_with_egui_on_screen_give_identical_digests", "--nocapture"])
            .args(["--test-threads=1"])
            .env(REPLAY_CHILD_ENV, "1")
            .output()
            .expect("re-run the test binary");
        assert!(output.status.success(), "child failed: {}", String::from_utf8_lossy(&output.stderr));
        let stdout = String::from_utf8(output.stdout).unwrap();
        let line = stdout.lines().find_map(|l| l.split_once(REPLAY_LINE)).map(|(_, digest)| digest.to_owned());
        line.unwrap_or_else(|| panic!("no replay line in {stdout:?}"))
    };
    let first = replay();
    assert!(first.ends_with("coins=7 bait=3"), "three purchases landed: {first}");
    assert_eq!(first, replay());
    assert_eq!(first, replay_digest(), "the child process agrees with this one");
}
