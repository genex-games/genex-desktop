//! UIS-4 rows (new behaviour): pad and keyboard navigation in ticks, keyed widgets as AccessKit
//! author ids, and focus memory per menu, on a plain egui context with AccessKit on.

use egui::accesskit::TreeUpdate;
use egui::{FontData, FontDefinitions, FontFamily};
use genex_core::input::{PadAxis, PadButton, PadState};
use genex_ui::focus::{FocusLayout, FocusScope};
use genex_ui::keyed::{Keyed, UiIssueCode, ui_issues};
use genex_ui::nav::{
    NAV_REPEAT_DELAY_TICKS, NAV_REPEAT_EVERY_TICKS, NavButton, NavButtons, NavRepeat, default_buttons, nav_events, nav_neutral,
};
use std::num::NonZeroUsize;
use std::sync::Arc;

const WORLD: [f32; 2] = [1280.0, 720.0];
const ITEMS: [&str; 5] = ["Resume", "Load", "Settings", "Credits", "Quit"];

fn context() -> egui::Context {
    let ctx = egui::Context::default();
    let mut fonts = FontDefinitions::empty();
    fonts.font_data.insert("text".to_owned(), Arc::new(FontData::from_static(epaint_default_fonts::UBUNTU_LIGHT)));
    fonts.families.insert(FontFamily::Proportional, vec!["text".to_owned()]);
    fonts.families.insert(FontFamily::Monospace, vec!["text".to_owned()]);
    ctx.set_fonts(fonts);
    // As the HUD runs it: one pass per tick, AccessKit on.
    ctx.options_mut(|options| options.max_passes = NonZeroUsize::MIN);
    ctx.enable_accesskit();
    ctx
}

fn raw(tick: u64, events: Vec<egui::Event>) -> egui::RawInput {
    egui::RawInput {
        screen_rect: Some(egui::Rect::from_min_size(egui::Pos2::ZERO, egui::vec2(WORLD[0], WORLD[1]))),
        time: Some(tick as f64 / 60.0),
        predicted_dt: 1.0 / 60.0,
        focused: true,
        events,
        ..egui::RawInput::default()
    }
}

/// One pass; the font atlas upload is dropped (nothing paints here).
fn run(ctx: &egui::Context, input: egui::RawInput, ui: impl FnMut(&mut egui::Ui)) -> egui::FullOutput {
    let mut output = ctx.run_ui(input, ui);
    output.textures_delta.clear();
    output
}

/// What one tick of the 5-item menu showed: the focused item as drawn, the item clicked.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct MenuTick {
    focused: Option<usize>,
    clicked: Option<usize>,
}

fn menu_tick(ctx: &egui::Context, tick: u64, events: Vec<egui::Event>) -> (MenuTick, Option<TreeUpdate>) {
    let mut seen = MenuTick { focused: None, clicked: None };
    let output = run(ctx, raw(tick, events), |ui| {
        let mut scope = FocusScope::new("pause");
        for (index, label) in ITEMS.iter().enumerate() {
            let response = ui.button(*label).key(ui, &format!("pause.item-{}", index + 1));
            scope.item(&response);
            if response.has_focus() {
                seen.focused = Some(index);
            }
            if response.clicked() {
                seen.clicked = Some(index);
            }
        }
        scope.end(ui.ctx());
    });
    (seen, output.platform_output.accesskit_update)
}

fn pad(buttons: &[(i32, f32)], axes: &[(i32, f32)]) -> PadState {
    let mut pad = PadState { connected: true, ..PadState::default() };
    for (index, value) in buttons {
        pad.buttons[*index as usize] = *value;
    }
    for (index, value) in axes {
        pad.axes[*index as usize] = *value;
    }
    pad
}

/// A pad script: one pad state per tick, through NavRepeat into the menu.
fn walk(script: &[PadState]) -> Vec<MenuTick> {
    let ctx = context();
    let mut repeat = NavRepeat::new();
    let mut ticks = Vec::new();
    for (tick, state) in script.iter().enumerate() {
        let fired = repeat.step(default_buttons(state, &[]));
        ticks.push(menu_tick(&ctx, tick as u64, nav_events(fired)).0);
    }
    ticks
}

/// Taps of one pad button, each followed by a released tick, after an idle opening tick.
fn taps(buttons: &[i32]) -> Vec<PadState> {
    let idle = pad(&[], &[]);
    let mut script = vec![idle];
    for button in buttons {
        script.push(pad(&[(*button, 1.0)], &[]));
        script.push(idle);
    }
    script.push(idle);
    script
}

#[test]
fn pad_only_walk_of_a_five_item_menu_picks_item_five() {
    // down x4 reaches item 5, a fifth down wraps to item 1, up wraps back to item 5, A picks it.
    let script = taps(&[PadButton::DOWN, PadButton::DOWN, PadButton::DOWN, PadButton::DOWN, PadButton::DOWN, PadButton::UP, PadButton::A]);
    let ticks = walk(&script);
    let focus: Vec<Option<usize>> = ticks.iter().map(|t| t.focused).collect();
    // The menu focuses its first item on the tick it opens (drawn focused from the next tick).
    assert_eq!(focus[1], Some(0), "{focus:?}");
    let after_each_tap: Vec<Option<usize>> = (0..7).map(|tap| focus[2 + tap * 2]).collect();
    assert_eq!(after_each_tap, vec![Some(1), Some(2), Some(3), Some(4), Some(0), Some(4), Some(4)], "{focus:?}");
    let clicked: Vec<(usize, usize)> = ticks.iter().enumerate().filter_map(|(tick, t)| t.clicked.map(|i| (tick, i))).collect();
    assert_eq!(clicked, vec![(13, 4)], "A on item 5 clicks it once, on the tick A goes down");
}

#[test]
fn stick_repeat_fires_on_ticks_0_24_30_36() {
    assert_eq!((NAV_REPEAT_DELAY_TICKS, NAV_REPEAT_EVERY_TICKS), (24, 6));
    let held = pad(&[], &[(PadAxis::LEFT_Y, 0.9)]);
    let mut repeat = NavRepeat::new();
    let fired: Vec<usize> = (0..40).filter(|_| repeat.step(default_buttons(&held, &[])).held(NavButton::Down)).collect();
    assert_eq!(fired, vec![0, 24, 30, 36]);
    // Releasing and holding again starts over from a fresh press.
    assert!(!repeat.step(NavButtons::NONE).any());
    assert!(repeat.step(default_buttons(&held, &[])).held(NavButton::Down));
    // Accept and cancel never repeat.
    let mut repeat = NavRepeat::new();
    let a = pad(&[(PadButton::A, 1.0)], &[]);
    let presses = (0..60).filter(|_| repeat.step(default_buttons(&a, &[])).held(NavButton::Accept)).count();
    assert_eq!(presses, 1);
}

#[test]
fn stick_inside_the_threshold_is_neutral() {
    let rows: [(f32, f32, NavButtons); 5] = [
        (0.5, 0.0, NavButtons::NONE),
        (0.0, -0.5, NavButtons::NONE),
        (f32::NAN, f32::NAN, NavButtons::NONE),
        (0.51, 0.0, NavButtons::NONE.with(NavButton::Right, true)),
        (0.0, -0.6, NavButtons::NONE.with(NavButton::Up, true)),
    ];
    for (x, y, want) in rows {
        let state = pad(&[], &[(PadAxis::LEFT_X, x), (PadAxis::LEFT_Y, y)]);
        assert_eq!(default_buttons(&state, &[]), want, "stick ({x}, {y})");
    }
}

#[test]
fn lb_walks_backwards_as_shift_tab() {
    let lb = default_buttons(&pad(&[(PadButton::LEFT_BUMPER, 1.0)], &[]), &[]);
    assert_eq!(lb, NavButtons::NONE.with(NavButton::Prev, true));
    let events = nav_events(lb);
    let shift_tab = events.iter().any(|event| {
        matches!(event, egui::Event::Key { key: egui::Key::Tab, pressed: true, modifiers, .. } if modifiers.shift_only())
    });
    assert!(shift_tab, "{events:?}");
    // The keyboard's Shift+Tab is the same button; Tab alone is next.
    let keys = |names: &[&str]| names.iter().map(|name| (*name).to_owned()).collect::<Vec<_>>();
    assert_eq!(default_buttons(&PadState::default(), &keys(&["ShiftLeft", "Tab"])), lb);
    assert_eq!(default_buttons(&PadState::default(), &keys(&["Tab"])), NavButtons::NONE.with(NavButton::Next, true));

    // On the menu: down x3 to item 4, then LB steps back to item 3.
    let script = taps(&[PadButton::DOWN, PadButton::DOWN, PadButton::DOWN, PadButton::LEFT_BUMPER]);
    let ticks = walk(&script);
    let last = ticks.last().copied().map(|t| t.focused);
    assert_eq!(ticks[7].focused, Some(3), "{ticks:?}");
    assert_eq!(last, Some(Some(2)), "{ticks:?}");
}

#[test]
fn key_appears_as_the_accesskit_author_id() {
    let ctx = context();
    let (_, update) = menu_tick(&ctx, 0, Vec::new());
    let update = update.expect("AccessKit is on");
    let mut keyed: Vec<(String, String)> = update
        .nodes
        .iter()
        .filter_map(|(_, node)| Some((node.author_id()?.to_owned(), node.label().unwrap_or_default().to_owned())))
        .collect();
    keyed.sort();
    let want: Vec<(String, String)> = ITEMS.iter().enumerate().map(|(i, label)| (format!("pause.item-{}", i + 1), (*label).to_owned())).collect();
    assert_eq!(keyed, want);
    assert!(ui_issues(&ctx).is_empty());
}

#[test]
fn invalid_and_duplicate_keys_are_issues_and_never_author_ids() {
    let ctx = context();
    let long = "a".repeat(65);
    let output = run(&ctx, raw(0, Vec::new()), |ui| {
        let _ = ui.button("Upper").key(ui, "Menu.Play");
        let _ = ui.button("Long").key(ui, &long);
        let _ = ui.button("Empty").key(ui, "");
        let _ = ui.button("First").key(ui, "menu.same");
        let _ = ui.button("Second").key(ui, "menu.same");
    });
    let update = output.platform_output.accesskit_update.expect("AccessKit is on");
    let ids: Vec<String> = update.nodes.iter().filter_map(|(_, node)| node.author_id().map(str::to_owned)).collect();
    assert_eq!(ids, vec!["menu.same".to_owned()], "only the first of a duplicate key is kept");
    let codes: Vec<(&str, String)> = ui_issues(&ctx).iter().map(|issue| (issue.code.wire(), issue.key.clone())).collect();
    assert_eq!(
        codes,
        vec![
            (UiIssueCode::KeyInvalid.wire(), "Menu.Play".to_owned()),
            (UiIssueCode::KeyInvalid.wire(), "a".repeat(64)),
            (UiIssueCode::KeyInvalid.wire(), String::new()),
            (UiIssueCode::KeyDuplicate.wire(), "menu.same".to_owned()),
        ]
    );
    assert_eq!((UiIssueCode::KeyInvalid.wire(), UiIssueCode::KeyDuplicate.wire()), ("ui-key-invalid", "ui-key-duplicate"));
    // The next pass starts a fresh ledger.
    run(&ctx, raw(1, Vec::new()), |ui| {
        let _ = ui.button("Fine").key(ui, "menu.fine");
    });
    assert!(ui_issues(&ctx).is_empty());
}

#[test]
fn two_runs_give_equal_focus_sequences() {
    let script = taps(&[PadButton::DOWN, PadButton::DOWN, PadButton::UP, PadButton::DOWN, PadButton::DOWN, PadButton::DOWN, PadButton::DOWN]);
    let first = walk(&script);
    let second = walk(&script);
    assert_eq!(first, second);
    assert!(first.iter().any(|t| t.focused == Some(4)));
}

#[test]
fn no_pad_means_no_events() {
    // A disconnected slot reads nothing, whatever its buttons say.
    let ghost = PadState { connected: false, ..pad(&[(PadButton::A, 1.0), (PadButton::DOWN, 1.0)], &[(PadAxis::LEFT_Y, 1.0)]) };
    let mut repeat = NavRepeat::new();
    for _ in 0..60 {
        let fired = repeat.step(default_buttons(&ghost, &[]));
        assert!(nav_events(fired).is_empty());
    }
    // And the menu's focus never moves after it opens.
    let ticks = walk(&vec![ghost; 30]);
    assert!(ticks.iter().skip(1).all(|t| t.focused == Some(0) && t.clicked.is_none()), "{ticks:?}");
}

#[test]
fn focus_memory_returns_to_the_last_item_when_a_menu_reopens() {
    let ctx = context();
    let down = || nav_events(NavButtons::NONE.with(NavButton::Down, true));
    let mut tick = 0;
    let mut step = |events: Vec<egui::Event>, open: bool| {
        let mut focused = None;
        run(&ctx, raw(tick, events), |ui| {
            if !open {
                return;
            }
            let mut scope = FocusScope::new("bag");
            for label in ITEMS {
                let response = ui.button(label);
                scope.item(&response);
                if response.has_focus() {
                    focused = Some(label);
                }
            }
            scope.end(ui.ctx());
        });
        tick += 1;
        focused
    };
    step(Vec::new(), true);
    step(down(), true);
    step(down(), true);
    assert_eq!(step(Vec::new(), true), Some("Settings"));
    // Closed for a while (focus lost), then reopened: Settings again, not the first item.
    for _ in 0..5 {
        step(Vec::new(), false);
    }
    step(Vec::new(), true);
    assert_eq!(step(Vec::new(), true), Some("Settings"));
}

#[test]
fn grid_layout_moves_by_rows_and_stays_inside_at_row_ends() {
    let ctx = context();
    let press = |button: NavButton| nav_events(NavButtons::NONE.with(button, true));
    let mut tick = 0;
    let mut step = |events: Vec<egui::Event>| {
        let mut focused = None;
        run(&ctx, raw(tick, events), |ui| {
            let mut scope = FocusScope::new("inventory").layout(FocusLayout::Grid { columns: 3 });
            egui::Grid::new("inventory").show(ui, |ui| {
                for index in 0..6 {
                    let response = ui.button(format!("Slot {index}"));
                    scope.item(&response);
                    if response.has_focus() {
                        focused = Some(index);
                    }
                    if index % 3 == 2 {
                        ui.end_row();
                    }
                }
            });
            scope.end(ui.ctx());
        });
        tick += 1;
        focused
    };
    // egui lays a grid out invisibly on its first pass; the scope focuses its first cell after.
    step(Vec::new());
    step(Vec::new());
    assert_eq!(step(press(NavButton::Right)), Some(0));
    assert_eq!(step(press(NavButton::Right)), Some(1));
    assert_eq!(step(press(NavButton::Right)), Some(2));
    // Right at the row's end stays; down goes to the next row; down at the last row stays.
    assert_eq!(step(press(NavButton::Down)), Some(2));
    assert_eq!(step(press(NavButton::Down)), Some(5));
    assert_eq!(step(press(NavButton::Left)), Some(5));
    assert_eq!(step(Vec::new()), Some(4));
}

#[test]
fn nav_neutral_hides_what_navigation_consumed() {
    let state = pad(
        &[(PadButton::A, 1.0), (PadButton::B, 1.0), (PadButton::X, 1.0), (PadButton::DOWN, 1.0), (PadButton::LEFT_BUMPER, 1.0), (PadButton::RIGHT_TRIGGER, 0.7)],
        &[(PadAxis::LEFT_X, 0.8), (PadAxis::RIGHT_X, -0.4)],
    );
    let neutral = nav_neutral(&state);
    assert_eq!(default_buttons(&neutral, &[]), NavButtons::NONE);
    assert_eq!(neutral.buttons[PadButton::X as usize], 1.0, "X is not a navigation button");
    assert_eq!(neutral.buttons[PadButton::RIGHT_TRIGGER as usize], 0.7);
    assert_eq!(neutral.axes[PadAxis::RIGHT_X as usize], -0.4);
    assert!(neutral.connected);
}
