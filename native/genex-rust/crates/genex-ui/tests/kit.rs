//! UIS-5 rows: the kit's menu, dialog, grid and list, toasts, nine-slice, bar and image cache, on a
//! plain egui context run as the HUD runs it (one pass per tick, AccessKit on, the HUD's text
//! font). Every row is new behaviour except the dialog's: before the fix a menu behind an open
//! dialog still picked its back key on Escape, and a grid behind it still took a tap.
//!
//! With `GENEX_UI_CAPTURE_DIR` set, `kit_captures` also rasterizes kit scenes on the CPU and writes
//! them there as PNG files.

use egui::accesskit::{NodeId, TreeUpdate};
use egui::{FontData, FontDefinitions, FontFamily, Pos2, TextureId};
use genex_ui::keyed::ui_issues;
use genex_ui::kit::bar::Bar;
use genex_ui::kit::dialog::Dialog;
use genex_ui::kit::grid::{DRAG_DELAY_TICKS, GridAnswer, ItemGrid};
use genex_ui::kit::image::{IMAGE_SIDE_MAX, IMAGES_MAX, ImageErrorCode, decode_png, image};
use genex_ui::kit::list::ItemList;
use genex_ui::kit::menu::Menu;
use genex_ui::kit::nine_slice::NineSlice;
use genex_ui::kit::toast::{TOAST_TICKS, ToastKind, Toasts};
use genex_ui::nav::{NavButton, NavButtons, nav_events};
use std::collections::BTreeMap;
use std::num::NonZeroUsize;
use std::sync::Arc;

const WORLD: [f32; 2] = [1280.0, 720.0];
const PHONE: [f32; 2] = [390.0, 844.0];
const UHD: [f32; 2] = [3840.0, 2160.0];

fn context() -> egui::Context {
    let ctx = egui::Context::default();
    let mut fonts = FontDefinitions::empty();
    fonts.font_data.insert("text".to_owned(), Arc::new(FontData::from_static(epaint_default_fonts::UBUNTU_LIGHT)));
    fonts.families.insert(FontFamily::Proportional, vec!["text".to_owned()]);
    fonts.families.insert(FontFamily::Monospace, vec!["text".to_owned()]);
    ctx.set_fonts(fonts);
    ctx.options_mut(|options| options.max_passes = NonZeroUsize::MIN);
    ctx.enable_accesskit();
    ctx
}

fn raw_in(world: [f32; 2], tick: u64, dt: f32, events: Vec<egui::Event>) -> egui::RawInput {
    egui::RawInput {
        screen_rect: Some(egui::Rect::from_min_size(Pos2::ZERO, egui::vec2(world[0], world[1]))),
        time: Some(tick as f64 * f64::from(dt)),
        predicted_dt: dt,
        focused: true,
        events,
        ..egui::RawInput::default()
    }
}

fn raw(tick: u64, events: Vec<egui::Event>) -> egui::RawInput {
    raw_in(WORLD, tick, 1.0 / 60.0, events)
}

fn run(ctx: &egui::Context, input: egui::RawInput, ui: impl FnMut(&mut egui::Ui)) -> egui::FullOutput {
    let mut output = ctx.run_ui(input, ui);
    output.textures_delta.clear();
    output
}

fn press(button: NavButton) -> Vec<egui::Event> {
    nav_events(NavButtons::NONE.with(button, true))
}

fn pointer(pos: Pos2, pressed: bool) -> Vec<egui::Event> {
    vec![
        egui::Event::PointerMoved(pos),
        egui::Event::PointerButton { pos, button: egui::PointerButton::Primary, pressed, modifiers: egui::Modifiers::NONE },
    ]
}

/// The AccessKit tree's focused node's key.
fn focus_key(update: &TreeUpdate) -> Option<String> {
    node_key(update, update.focus)
}

fn node_key(update: &TreeUpdate, id: NodeId) -> Option<String> {
    update.nodes.iter().find(|(node_id, _)| *node_id == id).and_then(|(_, node)| node.author_id().map(str::to_owned))
}

/// Every keyed node: key to its text (the label, else the value, as `hud.widgets` reads it).
fn keyed(update: &TreeUpdate) -> BTreeMap<String, String> {
    update
        .nodes
        .iter()
        .filter_map(|(_, node)| Some((node.author_id()?.to_owned(), node.label().or_else(|| node.value()).unwrap_or_default().to_owned())))
        .collect()
}

/// The centre of the keyed node's bounds (world pixels at one pixel per point).
fn centre_of(update: &TreeUpdate, key: &str) -> Pos2 {
    let (_, node) = update.nodes.iter().find(|(_, node)| node.author_id() == Some(key)).unwrap_or_else(|| panic!("no node keyed {key}"));
    let bounds = node.bounds().expect("bounds");
    Pos2::new(((bounds.x0 + bounds.x1) / 2.0) as f32, ((bounds.y0 + bounds.y1) / 2.0) as f32)
}

fn tree(output: egui::FullOutput) -> TreeUpdate {
    output.platform_output.accesskit_update.expect("AccessKit is on")
}

#[test]
fn menu_focuses_its_first_enabled_item_within_one_tick_and_b_picks_back() {
    let ctx = context();
    let mut picked = Vec::new();
    let mut step = |tick: u64, events: Vec<egui::Event>| {
        let mut answer = None;
        let update = tree(run(&ctx, raw(tick, events), |ui| {
            answer = Menu::new("pause").item_enabled("continue", "Continue", false).item("load", "Load").item("quit", "Quit").back("resume").show(ui);
        }));
        picked.push(answer);
        focus_key(&update)
    };
    let _opening = step(0, Vec::new());
    assert_eq!(step(1, Vec::new()).as_deref(), Some("pause.load"), "the first enabled item, one tick after opening");
    // Up wraps past the disabled first item to the last.
    step(2, press(NavButton::Up));
    assert_eq!(step(3, Vec::new()).as_deref(), Some("pause.quit"));
    // B (Escape) picks the back key, and the menu keeps focus for the pad.
    step(4, press(NavButton::Cancel));
    assert_eq!(step(5, Vec::new()).as_deref(), Some("pause.quit"));
    step(6, press(NavButton::Accept));
    assert_eq!(picked, vec![None, None, None, None, Some("resume"), None, Some("quit")]);
}

/// One tick of a pause menu and a bag grid, with the quit dialog over them while `dialog` is set.
#[derive(Debug, Default, PartialEq, Eq)]
struct Behind {
    menu: Option<&'static str>,
    grid: GridAnswer,
    dialog: Option<&'static str>,
    focus: Option<String>,
}

fn behind_tick(ctx: &egui::Context, tick: u64, dialog: bool, events: Vec<egui::Event>) -> (Behind, TreeUpdate) {
    let mut seen = Behind::default();
    let update = tree(run(ctx, raw(tick, events), |ui| {
        seen.menu = Menu::new("pause").item("resume", "Resume").item("quit", "Quit").back("resume").show(ui);
        seen.grid = ItemGrid::new("bag", 4).show(ui, 8, |_, index, _| format!("Slot {index}"));
        if dialog {
            seen.dialog = Dialog::new("quit").title("Quit?").body("Unsaved progress is lost.").button("yes", "Yes").button("no", "No").cancel("no").show(ui);
        }
    }));
    seen.focus = focus_key(&update);
    (seen, update)
}

#[test]
fn a_dialog_swallows_input_behind_it() {
    let ctx = context();
    let (_, first) = behind_tick(&ctx, 0, false, Vec::new());
    let cell = centre_of(&first, "bag.1");
    assert_eq!(behind_tick(&ctx, 1, false, Vec::new()).0.focus.as_deref(), Some("pause.resume"));
    // Without the dialog a tap on a cell activates it (the control row).
    behind_tick(&ctx, 2, false, pointer(cell, true));
    assert_eq!(behind_tick(&ctx, 3, false, pointer(cell, false)).0.grid.activated, Some(1));

    behind_tick(&ctx, 4, true, Vec::new());
    assert_eq!(behind_tick(&ctx, 5, true, Vec::new()).0.focus.as_deref(), Some("quit.yes"), "the dialog takes focus");
    // Arrows, Tab and Enter drive the dialog's buttons only.
    for (tick, button) in [(6, NavButton::Right), (8, NavButton::Down), (10, NavButton::Next), (12, NavButton::Prev)] {
        let (seen, _) = behind_tick(&ctx, tick, true, press(button));
        assert_eq!((seen.menu, seen.grid.activated), (None, None));
        let focus = behind_tick(&ctx, tick + 1, true, Vec::new()).0.focus;
        assert!(focus.as_deref().is_some_and(|key| key.starts_with("quit.")), "{button:?} moved focus behind the dialog: {focus:?}");
    }
    // Escape cancels the dialog and never picks the menu's back key behind it.
    let (escape, _) = behind_tick(&ctx, 14, true, press(NavButton::Cancel));
    assert_eq!((escape.menu, escape.dialog), (None, Some("no")));
    // A tap on a cell behind it reaches the backdrop (a cancel), not the cell.
    behind_tick(&ctx, 15, true, pointer(cell, true));
    let (tap, _) = behind_tick(&ctx, 16, true, pointer(cell, false));
    assert_eq!((tap.grid, tap.menu, tap.dialog), (GridAnswer::default(), None, Some("no")));
}

#[test]
fn grid_focus_at_row_ends_stays_in_the_grid() {
    let ctx = context();
    let mut tick = 0;
    let mut step = |events: Vec<egui::Event>| {
        let mut answer = GridAnswer::default();
        let update = tree(run(&ctx, raw(tick, events), |ui| {
            ui.horizontal(|ui| {
                answer = ItemGrid::new("bag", 3).show(ui, 7, |_, index, _| format!("Slot {index}"));
                let _ = ui.button("Beside");
            });
        }));
        tick += 1;
        (answer.focused, focus_key(&update))
    };
    step(Vec::new());
    assert_eq!(step(Vec::new()), (Some(0), Some("bag.0".to_owned())));
    let mut walk = Vec::new();
    for button in [NavButton::Right, NavButton::Right, NavButton::Right, NavButton::Down, NavButton::Down, NavButton::Left, NavButton::Up, NavButton::Down] {
        step(press(button));
        walk.push(step(Vec::new()).1);
    }
    let want = ["bag.1", "bag.2", "bag.2", "bag.5", "bag.5", "bag.4", "bag.1", "bag.4"];
    assert_eq!(walk, want.map(|key| Some(key.to_owned())), "right at a row end and down at the last full row stay in the grid");
    // The short last row: down from the first column reaches it, right past its end stays.
    step(press(NavButton::Left));
    step(Vec::new());
    step(press(NavButton::Down));
    assert_eq!(step(Vec::new()).1.as_deref(), Some("bag.6"));
    step(press(NavButton::Right));
    assert_eq!(step(Vec::new()).1.as_deref(), Some("bag.6"));
    // Enter (A) activates the focused cell.
    let mut activated = None;
    run(&ctx, raw(100, press(NavButton::Accept)), |ui| {
        ui.horizontal(|ui| {
            activated = ItemGrid::new("bag", 3).show(ui, 7, |_, index, _| format!("Slot {index}")).activated;
            let _ = ui.button("Beside");
        });
    });
    assert_eq!(activated, Some(6));
}

/// Press on `from`, stay down `held` ticks, release on `to`: what the release tick answered.
fn drag(ctx: &egui::Context, first_tick: u64, from: Pos2, to: Pos2, held: u32) -> GridAnswer {
    let mut tick = first_tick;
    let mut step = |events: Vec<egui::Event>| {
        let mut answer = GridAnswer::default();
        run(ctx, raw(tick, events), |ui| {
            answer = ItemList::new("quests").show(ui, 4, |_, index, _| format!("Quest {index}"));
        });
        tick += 1;
        answer
    };
    let mut answers = vec![step(pointer(from, true))];
    for held_tick in 0..held {
        let at = if held_tick + 1 == held { to } else { from };
        answers.push(step(vec![egui::Event::PointerMoved(at)]));
    }
    let release = step(pointer(to, false));
    assert!(answers.iter().all(|answer| answer.moved.is_none() && answer.activated.is_none()), "nothing before the release: {answers:?}");
    release
}

#[test]
fn a_drag_moves_only_after_drag_delay_ticks_and_a_tap_activates() {
    assert_eq!(DRAG_DELAY_TICKS, 12);
    let ctx = context();
    let update = tree(run(&ctx, raw(0, Vec::new()), |ui| {
        ItemList::new("quests").show(ui, 4, |_, index, _| format!("Quest {index}"));
    }));
    let rows: Vec<Pos2> = (0..4).map(|index| centre_of(&update, &format!("quests.{index}"))).collect();
    let short = drag(&ctx, 1, rows[0], rows[2], DRAG_DELAY_TICKS - 1);
    assert_eq!((short.moved, short.activated), (None, None), "one tick short of the delay neither moves nor taps");
    let long = drag(&ctx, 20, rows[0], rows[2], DRAG_DELAY_TICKS);
    assert_eq!((long.moved, long.activated), (Some((0, 2)), None));
    let back = drag(&ctx, 40, rows[3], rows[3], DRAG_DELAY_TICKS + 5);
    assert_eq!((back.moved, back.activated), (None, None), "a drag dropped where it started is neither a move nor a tap");
    let tap = drag(&ctx, 60, rows[1], rows[1], 0);
    assert_eq!((tap.moved, tap.activated), (None, Some(1)));
    let slow_tap = drag(&ctx, 70, rows[2], rows[2], DRAG_DELAY_TICKS - 1);
    assert_eq!((slow_tap.moved, slow_tap.activated), (None, Some(2)));
}

/// One toast pushed on tick 0, the queue shown every tick at `dt` seconds a tick: per tick, the
/// queue's length after the show and the toast's centre if AccessKit had it.
fn toast_run(dt: f32, ticks: u64) -> Vec<(usize, Option<(i32, i32)>)> {
    let ctx = context();
    (0..ticks)
        .map(|tick| {
            let update = tree(run(&ctx, raw_in(WORLD, tick, dt, Vec::new()), |ui| {
                if tick == 0 {
                    Toasts::push(ui.ctx(), ToastKind::Success, "Saved");
                }
                Toasts::show(ui);
            }));
            let shown = update.nodes.iter().any(|(_, node)| node.author_id() == Some("toast.0"));
            let centre = shown.then(|| centre_of(&update, "toast.0")).map(|pos| (pos.x.round() as i32, pos.y.round() as i32));
            (Toasts::len(&ctx), centre)
        })
        .collect()
}

#[test]
fn toasts_expire_after_toast_ticks_simulated_ticks_equal_on_replay() {
    assert_eq!(TOAST_TICKS, 180);
    let ticks = u64::from(TOAST_TICKS) + 10;
    let at_60 = toast_run(1.0 / 60.0, ticks);
    let last_shown = at_60.iter().rposition(|(_, centre)| centre.is_some());
    assert_eq!(last_shown, Some(TOAST_TICKS as usize - 1), "drawn on ticks 0..TOAST_TICKS");
    let lengths: Vec<usize> = at_60.iter().map(|(len, _)| *len).collect();
    assert!(lengths[..TOAST_TICKS as usize - 1].iter().all(|len| *len == 1) && lengths[TOAST_TICKS as usize - 1..].iter().all(|len| *len == 0), "{lengths:?}");
    // It slides in from the right edge and rests inside the frame.
    let resting = at_60[90].1.expect("shown at tick 90");
    let entering = at_60[1].1.expect("shown at tick 1");
    assert!(entering.0 > resting.0 && (resting.0 as f32) < WORLD[0], "{entering:?} {resting:?}");
    // A replay, and a run whose wall clock runs three times slower, give the same ticks.
    assert_eq!(toast_run(1.0 / 60.0, ticks), at_60);
    assert_eq!(toast_run(1.0 / 20.0, ticks), at_60);
}

#[test]
fn a_click_dismisses_a_toast_and_the_queue_is_capped() {
    let ctx = context();
    let update = tree(run(&ctx, raw(0, Vec::new()), |ui| {
        for index in 0..10 {
            Toasts::push(ui.ctx(), ToastKind::Info, &format!("Note {index}"));
        }
        Toasts::show(ui);
    }));
    let keys: Vec<String> = keyed(&update).into_keys().filter(|key| key.starts_with("toast.")).collect();
    assert_eq!(keys, (2..10).map(|index| format!("toast.{index}")).collect::<Vec<_>>(), "the oldest two are dropped");
    // Let them slide in, then click the first one: it slides out and leaves the queue first.
    let mut tick = 1;
    while tick < 30 {
        run(&ctx, raw(tick, Vec::new()), |ui| Toasts::show(ui));
        tick += 1;
    }
    let update = tree(run(&ctx, raw(tick, Vec::new()), |ui| Toasts::show(ui)));
    let first = centre_of(&update, "toast.2");
    for pressed in [true, false] {
        tick += 1;
        run(&ctx, raw(tick, pointer(first, pressed)), |ui| Toasts::show(ui));
    }
    for _ in 0..20 {
        tick += 1;
        run(&ctx, raw(tick, vec![egui::Event::PointerGone]), |ui| Toasts::show(ui));
    }
    assert_eq!(Toasts::len(&ctx), 7);
}

/// A 48-texel frame texture: 16-texel corners and edges, a dark centre.
fn frame_texture(ctx: &egui::Context) -> egui::TextureHandle {
    let side = 48;
    let pixels: Vec<egui::Color32> = (0..side * side)
        .map(|index| {
            let (x, y) = (index % side, index / side);
            let band = |v: usize| if v < 16 { 0 } else if v < 32 { 1 } else { 2 };
            match (band(x), band(y)) {
                (1, 1) => egui::Color32::from_rgb(28, 32, 44),
                (1, _) | (_, 1) => egui::Color32::from_rgb(70, 110, 190),
                _ if (x + y) % 4 < 2 => egui::Color32::from_rgb(230, 190, 80),
                _ => egui::Color32::from_rgb(160, 110, 40),
            }
        })
        .collect();
    ctx.load_texture("frame", egui::ColorImage::new([side, side], pixels), egui::TextureOptions::NEAREST)
}

#[test]
fn nine_slice_corners_hold_at_4k_and_on_a_phone_sized_world() {
    let slice = NineSlice::new(TextureId::Managed(7), [48, 48], [16, 16, 16, 16]);
    for world in [UHD, PHONE, WORLD] {
        let rect = egui::Rect::from_min_size(egui::pos2(12.0, 12.0), egui::vec2(world[0] - 24.0, world[1] - 24.0));
        assert_eq!(slice.corners(rect), [16.0; 4], "{world:?}");
        let mesh = slice.mesh(rect);
        assert_eq!(mesh.vertices.len(), 9 * 4, "nine quads");
        // The top-left corner quad is 16 world pixels and samples exactly the corner texels.
        let corner = &mesh.vertices[..4];
        let max = corner.iter().fold(Pos2::new(f32::MIN, f32::MIN), |m, v| m.max(v.pos));
        assert_eq!(max, egui::pos2(28.0, 28.0));
        let uv = corner.iter().fold(Pos2::ZERO, |m, v| m.max(v.uv));
        assert_eq!(uv, egui::pos2(1.0 / 3.0, 1.0 / 3.0));
    }
    // A UI scale doubles the corners; a rect smaller than two corners shrinks them in proportion.
    let small = egui::Rect::from_min_size(Pos2::ZERO, egui::vec2(20.0, 100.0));
    assert_eq!(slice.scale(2.0).corners(small), [10.0, 32.0, 10.0, 32.0]);
    assert_eq!(slice.corners(egui::Rect::from_min_size(Pos2::ZERO, egui::Vec2::ZERO)), [0.0; 4]);
    // Hostile margins and scales never give negative or NaN corners.
    let hostile = NineSlice::new(TextureId::Managed(7), [0, 0], [u32::MAX, 0, u32::MAX, 5]).scale(f32::NAN);
    let corners = hostile.corners(egui::Rect::from_min_size(Pos2::ZERO, egui::vec2(64.0, 64.0)));
    assert!(corners.iter().all(|c| c.is_finite() && *c >= 0.0), "{corners:?}");
    assert!(corners[0] + corners[2] <= 64.0 && corners[1] + corners[3] <= 64.0, "{corners:?}");
}

/// Every kit widget on one tick (the dialog open), keyed and labelled.
fn whole_kit(ui: &mut egui::Ui, frame: Option<&egui::TextureHandle>, push_toast: bool) {
    if push_toast {
        Toasts::push(ui.ctx(), ToastKind::Success, "Saved");
    }
    if let Some(frame) = frame {
        let rect = egui::Rect::from_min_size(egui::pos2(600.0, 40.0), egui::vec2(300.0, 180.0));
        NineSlice::new(frame.id(), [48, 48], [16, 16, 16, 16]).paint(ui.painter(), rect);
    }
    let _ = Menu::new("pause").item("resume", "Resume").item_enabled("load", "Load", false).item("quit", "Quit").back("resume").show(ui);
    let _ = Bar::new("hp", 0.75).label("Health").show(ui);
    let _ = ItemList::new("quests").show(ui, 2, |_, index, _| format!("Quest {index}"));
    let _ = ItemGrid::new("bag", 2).show(ui, 2, |_, index, _| format!("Slot {index}"));
    Toasts::show(ui);
    let _ = Dialog::new("quit").title("Quit?").body("Unsaved progress is lost.").button("yes", "Yes").button("no", "No").cancel("no").show(ui);
}

#[test]
fn every_widget_is_labelled_and_keyed_in_accesskit() {
    let ctx = context();
    run(&ctx, raw(0, Vec::new()), |ui| whole_kit(ui, None, true));
    let update = tree(run(&ctx, raw(1, Vec::new()), |ui| whole_kit(ui, None, false)));
    let want: BTreeMap<String, String> = [
        ("pause.resume", "Resume"),
        ("pause.load", "Load"),
        ("pause.quit", "Quit"),
        ("hp", "Health"),
        ("quests.0", "Quest 0"),
        ("quests.1", "Quest 1"),
        ("bag.0", "Slot 0"),
        ("bag.1", "Slot 1"),
        ("toast.0", "Saved"),
        ("quit.title", "Quit?"),
        ("quit.body", "Unsaved progress is lost."),
        ("quit.yes", "Yes"),
        ("quit.no", "No"),
    ]
    .into_iter()
    .map(|(key, label)| (key.to_owned(), label.to_owned()))
    .collect();
    assert_eq!(keyed(&update), want);
    assert!(ui_issues(&ctx).is_empty(), "{:?}", ui_issues(&ctx));
    let (_, bar) = update.nodes.iter().find(|(_, node)| node.author_id() == Some("hp")).expect("bar");
    assert_eq!(bar.numeric_value(), Some(0.75));
}

/// Every text shape in the output.
fn galleys(shapes: &[egui::epaint::ClippedShape]) -> Vec<Arc<egui::Galley>> {
    fn walk(shape: &egui::Shape, out: &mut Vec<Arc<egui::Galley>>) {
        match shape {
            egui::Shape::Text(text) => out.push(text.galley.clone()),
            egui::Shape::Vec(shapes) => shapes.iter().for_each(|s| walk(s, out)),
            _ => {}
        }
    }
    let mut out = Vec::new();
    shapes.iter().for_each(|clipped| walk(&clipped.shape, &mut out));
    out
}

fn be16(bytes: &[u8], at: usize) -> usize {
    usize::from(u16::from_be_bytes([bytes[at], bytes[at + 1]]))
}

fn be32(bytes: &[u8], at: usize) -> usize {
    u32::from_be_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]]) as usize
}

/// Whether the TrueType font `font` maps `c` to a glyph, read from its `cmap` table (format 12, else
/// format 4). epaint's `has_glyph` cannot say: with one face, the replacement face is that face.
fn font_has(font: &[u8], c: char) -> bool {
    let code = c as usize;
    let tables = be16(font, 4);
    let Some(cmap) = (0..tables).map(|i| 12 + i * 16).find(|record| &font[*record..*record + 4] == b"cmap").map(|record| be32(font, record + 8)) else {
        return false;
    };
    let subtables: Vec<usize> = (0..be16(font, cmap + 2)).map(|i| cmap + be32(font, cmap + 4 + i * 8 + 4)).collect();
    if let Some(table) = subtables.iter().copied().find(|table| be16(font, *table) == 12) {
        let groups = be32(font, table + 12);
        return (0..groups).map(|i| table + 16 + i * 12).any(|group| (be32(font, group)..=be32(font, group + 4)).contains(&code));
    }
    let Some(table) = subtables.iter().copied().find(|table| be16(font, *table) == 4) else {
        return false;
    };
    let segments = be16(font, table + 6) / 2;
    let ends = table + 14;
    let starts = ends + segments * 2 + 2;
    let deltas = starts + segments * 2;
    let ranges = deltas + segments * 2;
    let Some(segment) = (0..segments).find(|i| code <= be16(font, ends + i * 2)) else {
        return false;
    };
    let first = be16(font, starts + segment * 2);
    if code < first {
        return false;
    }
    let range = be16(font, ranges + segment * 2);
    let glyph = if range == 0 { code } else { be16(font, ranges + segment * 2 + range + (code - first) * 2) };
    let delta = be16(font, deltas + segment * 2);
    glyph != 0 && (glyph + delta) & 0xFFFF != 0
}

/// The characters of `text` the HUD's text font has no glyph for.
fn missing_glyphs(text: &str) -> Vec<char> {
    text.chars().filter(|c| !c.is_whitespace() && !font_has(epaint_default_fonts::UBUNTU_LIGHT, *c)).collect()
}

#[test]
fn the_kit_draws_no_glyph_outside_the_hud_fonts() {
    let ctx = context();
    let frame = frame_texture(&ctx);
    run(&ctx, raw(0, Vec::new()), |ui| whole_kit(ui, Some(&frame), true));
    let output = run(&ctx, raw(1, Vec::new()), |ui| whole_kit(ui, Some(&frame), false));
    let drawn = galleys(&output.shapes);
    // Only the game's own words: no icon, close cross or arrow glyphs of the kit's own.
    let mut words: Vec<&str> = drawn.iter().map(|galley| galley.job.text.as_str()).collect();
    words.sort_unstable();
    words.dedup();
    let want = ["Load", "No", "Quit", "Quit?", "Resume", "Saved", "Unsaved progress is lost.", "Yes"];
    assert_eq!(words, want, "cells and bars draw no text of their own; the game draws inside cells");
    let missing: Vec<(String, Vec<char>)> = drawn.iter().map(|galley| (galley.job.text.clone(), missing_glyphs(&galley.job.text))).filter(|(_, chars)| !chars.is_empty()).collect();
    assert!(missing.is_empty(), "{missing:?}");
    // The check sees glyphs the HUD font lacks (a check mark, a cross, an emoji) and keeps é.
    assert_eq!(missing_glyphs("Saved \u{2714}\u{2716}\u{1F600} \u{e9}"), vec!['\u{2714}', '\u{2716}', '\u{1F600}']);
}

/// A PNG of `width` x `height` texels.
fn png(width: u32, height: u32) -> Vec<u8> {
    let mut bytes = std::io::Cursor::new(Vec::new());
    image::RgbaImage::from_pixel(width, height, image::Rgba([10, 20, 30, 128])).write_to(&mut bytes, image::ImageFormat::Png).expect("encode");
    bytes.into_inner()
}

#[test]
fn image_decoding_refuses_hostile_bytes() {
    let valid = png(2, 3);
    let decoded = decode_png(&valid).expect("a small PNG decodes");
    assert_eq!(decoded.size, [2, 3]);
    assert_eq!(decoded.pixels[0], egui::Color32::from_rgba_unmultiplied(10, 20, 30, 128));
    let mut truncated = valid.clone();
    truncated.truncate(valid.len() / 2);
    let jpeg_magic = vec![0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0];
    let rows: Vec<(&str, Vec<u8>, ImageErrorCode)> = vec![
        ("empty", Vec::new(), ImageErrorCode::Invalid),
        ("not a png", b"hello, world".to_vec(), ImageErrorCode::Invalid),
        ("another format", jpeg_magic, ImageErrorCode::Invalid),
        ("signature only", valid[..8].to_vec(), ImageErrorCode::Invalid),
        ("truncated", truncated, ImageErrorCode::Invalid),
        ("too wide", png(IMAGE_SIDE_MAX + 1, 1), ImageErrorCode::TooLarge),
        ("too tall", png(1, IMAGE_SIDE_MAX + 1), ImageErrorCode::TooLarge),
        ("too many bytes", vec![0; 16 * 1024 * 1024 + 1], ImageErrorCode::TooLarge),
    ];
    for (name, bytes, want) in rows {
        assert_eq!(decode_png(&bytes).err(), Some(want), "{name}");
    }
    assert_eq!([ImageErrorCode::Missing, ImageErrorCode::Invalid, ImageErrorCode::TooLarge].map(ImageErrorCode::wire), ["image-missing", "image-invalid", "image-too-large"]);
}

/// A PNG of `width` x `height` written by the png encoder with these samples and settings.
fn png_with(width: u32, height: u32, color: png::ColorType, depth: png::BitDepth, setup: impl FnOnce(&mut png::Encoder<'_, &mut Vec<u8>>), samples: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::new();
    let mut encoder = png::Encoder::new(&mut bytes, width, height);
    encoder.set_color(color);
    encoder.set_depth(depth);
    setup(&mut encoder);
    encoder.write_header().expect("header").write_image_data(samples).expect("data");
    bytes
}

/// The texels the image crate decodes `bytes` to (its RGBA8 conversion), the reference the kit holds to.
fn reference_texels(bytes: &[u8]) -> Vec<egui::Color32> {
    let decoded = image::load_from_memory_with_format(bytes, image::ImageFormat::Png).expect("reference decode").to_rgba8();
    decoded.pixels().map(|p| egui::Color32::from_rgba_unmultiplied(p[0], p[1], p[2], p[3])).collect()
}

#[test]
fn image_decoding_matches_the_reference_decode_for_every_png_colour_type() {
    use png::{BitDepth, ColorType};
    let ramp = |n: usize| -> Vec<u8> { (0..n).map(|i| (i * 37 % 256) as u8).collect() };
    let (w, h) = (5_u32, 3_u32);
    let texels = (w * h) as usize;
    let none = |_: &mut png::Encoder<'_, &mut Vec<u8>>| {};
    let rows: Vec<(&str, Vec<u8>)> = vec![
        ("gray 8", png_with(w, h, ColorType::Grayscale, BitDepth::Eight, none, &ramp(texels))),
        ("gray 16", png_with(w, h, ColorType::Grayscale, BitDepth::Sixteen, none, &ramp(texels * 2))),
        ("gray 1", png_with(8, 2, ColorType::Grayscale, BitDepth::One, none, &[0b1010_0110, 0b0101_1001])),
        ("gray alpha 8", png_with(w, h, ColorType::GrayscaleAlpha, BitDepth::Eight, none, &ramp(texels * 2))),
        ("gray alpha 16", png_with(w, h, ColorType::GrayscaleAlpha, BitDepth::Sixteen, none, &ramp(texels * 4))),
        ("rgb 8", png_with(w, h, ColorType::Rgb, BitDepth::Eight, none, &ramp(texels * 3))),
        ("rgb 16", png_with(w, h, ColorType::Rgb, BitDepth::Sixteen, none, &ramp(texels * 6))),
        ("rgba 8", png_with(w, h, ColorType::Rgba, BitDepth::Eight, none, &ramp(texels * 4))),
        ("rgba 16", png_with(w, h, ColorType::Rgba, BitDepth::Sixteen, none, &ramp(texels * 8))),
        (
            "palette 4 with tRNS",
            png_with(4, 2, ColorType::Indexed, BitDepth::Four, |e| {
                e.set_palette(vec![255, 0, 0, 0, 255, 0, 0, 0, 255]);
                e.set_trns(vec![255, 128]);
            }, &[0x01, 0x20, 0x12, 0x00]),
        ),
        (
            "gray with tRNS",
            png_with(w, h, ColorType::Grayscale, BitDepth::Eight, |e| e.set_trns(vec![0, 37]), &ramp(texels)),
        ),
    ];
    for (name, bytes) in rows {
        let decoded = decode_png(&bytes).unwrap_or_else(|e| panic!("{name}: {e:?}"));
        let want = reference_texels(&bytes);
        assert_eq!(decoded.pixels.len(), want.len(), "{name}");
        assert_eq!(decoded.pixels, want, "{name}");
    }
}

#[test]
fn the_image_cache_reads_each_path_once_and_is_capped() {
    let ctx = context();
    let mut reads = 0;
    let mut read = |bytes: Option<Vec<u8>>| {
        reads += 1;
        bytes
    };
    let first = image(&ctx, "ui/icon.png", |_| read(Some(png(4, 4)))).expect("decodes");
    assert_eq!(first.size(), [4, 4]);
    let again = image(&ctx, "ui/icon.png", |_| panic!("read twice")).expect("cached");
    assert_eq!(again.id(), first.id());
    assert_eq!(image(&ctx, "ui/missing.png", |_| read(None)).err(), Some(ImageErrorCode::Missing));
    assert_eq!(image(&ctx, "ui/missing.png", |_| panic!("a failure is cached too")).err(), Some(ImageErrorCode::Missing));
    assert_eq!(reads, 2);
    for index in 2..IMAGES_MAX {
        let _ = image(&ctx, &format!("ui/gone-{index}.png"), |_| None);
    }
    assert_eq!(image(&ctx, "ui/one-more.png", |_| panic!("over the cap nothing is read")).err(), Some(ImageErrorCode::TooLarge));
}

#[test]
fn bar_clamps_its_fraction() {
    let rows = [(0.5, 0.5), (-1.0, 0.0), (2.0, 1.0), (f32::NAN, 0.0), (f32::INFINITY, 1.0)];
    for (given, want) in rows {
        assert_eq!(Bar::new("hp", given).fraction(), want, "{given}");
    }
}

/// CPU rasterizer for the capture row: egui's tessellated meshes over a dark world, premultiplied
/// alpha, bilinear texels, in gamma space (a look capture, not a colour reference).
struct Capture {
    textures: BTreeMap<TextureId, (egui::ColorImage, egui::TextureOptions)>,
}

impl Capture {
    fn absorb(&mut self, delta: &egui::TexturesDelta) {
        for (id, change) in delta.set.iter().flat_map(|(id, changes)| changes.iter().map(move |change| (id, change))) {
            let egui::ImageData::Color(image) = &change.image;
            match change.pos {
                None => {
                    self.textures.insert(*id, ((**image).clone(), change.options));
                }
                Some([x0, y0]) => {
                    let (target, _) = self.textures.get_mut(id).expect("patch of a known texture");
                    for y in 0..image.size[1] {
                        for x in 0..image.size[0] {
                            target.pixels[(y0 + y) * target.size[0] + x0 + x] = image.pixels[y * image.size[0] + x];
                        }
                    }
                }
            }
        }
    }

    fn texel(&self, id: TextureId, uv: Pos2) -> [f32; 4] {
        let Some((image, options)) = self.textures.get(&id) else {
            return [1.0; 4];
        };
        let [w, h] = image.size;
        if options.magnification == egui::TextureFilter::Nearest {
            let x = ((uv.x * w as f32) as usize).min(w - 1);
            let y = ((uv.y * h as f32) as usize).min(h - 1);
            return image.pixels[y * w + x].to_array().map(|c| f32::from(c) / 255.0);
        }
        let x = (uv.x * w as f32 - 0.5).clamp(0.0, (w - 1) as f32);
        let y = (uv.y * h as f32 - 0.5).clamp(0.0, (h - 1) as f32);
        let (x0, y0) = (x.floor() as usize, y.floor() as usize);
        let (x1, y1) = ((x0 + 1).min(w - 1), (y0 + 1).min(h - 1));
        let (fx, fy) = (x - x0 as f32, y - y0 as f32);
        let at = |x: usize, y: usize| image.pixels[y * w + x].to_array().map(|c| f32::from(c) / 255.0);
        let mix = |a: [f32; 4], b: [f32; 4], t: f32| [0, 1, 2, 3].map(|i| a[i] + (b[i] - a[i]) * t);
        mix(mix(at(x0, y0), at(x1, y0), fx), mix(at(x0, y1), at(x1, y1), fx), fy)
    }

    fn render(&self, ctx: &egui::Context, output: egui::FullOutput, world: [f32; 2]) -> image::RgbaImage {
        let (w, h) = (world[0] as usize, world[1] as usize);
        let mut canvas = vec![[0.12_f32, 0.13, 0.16, 1.0]; w * h];
        for primitive in ctx.tessellate(output.shapes, output.pixels_per_point) {
            let egui::epaint::Primitive::Mesh(mesh) = primitive.primitive else { continue };
            let clip = primitive.clip_rect.intersect(egui::Rect::from_min_size(Pos2::ZERO, egui::vec2(world[0], world[1])));
            for tri in mesh.indices.as_chunks::<3>().0 {
                let [a, b, c] = tri.map(|i| mesh.vertices[i as usize]);
                self.fill(&mut canvas, w, clip, mesh.texture_id, [a, b, c]);
            }
        }
        let bytes: Vec<u8> = canvas.iter().flat_map(|px| px.map(|c| (c.clamp(0.0, 1.0) * 255.0).round() as u8)).collect();
        image::RgbaImage::from_raw(w as u32, h as u32, bytes).expect("size")
    }

    fn fill(&self, canvas: &mut [[f32; 4]], width: usize, clip: egui::Rect, texture: TextureId, [a, b, c]: [egui::epaint::Vertex; 3]) {
        let area = (b.pos - a.pos).x * (c.pos - a.pos).y - (b.pos - a.pos).y * (c.pos - a.pos).x;
        if area.abs() < 1e-6 {
            return;
        }
        let bounds = egui::Rect::from_points(&[a.pos, b.pos, c.pos]).intersect(clip);
        if !bounds.is_positive() {
            return;
        }
        for y in bounds.top().floor() as usize..bounds.bottom().ceil() as usize {
            for x in bounds.left().floor() as usize..bounds.right().ceil() as usize {
                let p = egui::pos2(x as f32 + 0.5, y as f32 + 0.5);
                let wa = ((b.pos - p).x * (c.pos - p).y - (b.pos - p).y * (c.pos - p).x) / area;
                let wb = ((c.pos - p).x * (a.pos - p).y - (c.pos - p).y * (a.pos - p).x) / area;
                let wc = 1.0 - wa - wb;
                if wa < 0.0 || wb < 0.0 || wc < 0.0 || !clip.contains(p) {
                    continue;
                }
                let colour = |v: egui::epaint::Vertex| v.color.to_array().map(|ch| f32::from(ch) / 255.0);
                let (ca, cb, cc) = (colour(a), colour(b), colour(c));
                let uv = egui::pos2(a.uv.x * wa + b.uv.x * wb + c.uv.x * wc, a.uv.y * wa + b.uv.y * wb + c.uv.y * wc);
                let texel = self.texel(texture, uv);
                let src = [0, 1, 2, 3].map(|i| (ca[i] * wa + cb[i] * wb + cc[i] * wc) * texel[i]);
                let dst = &mut canvas[y * width + x];
                *dst = [0, 1, 2, 3].map(|i| src[i] + dst[i] * (1.0 - src[3]));
            }
        }
    }
}

fn capture_scene(world: [f32; 2], ticks: u64, mut scene: impl FnMut(&mut egui::Ui, u64, &egui::TextureHandle)) -> image::RgbaImage {
    let ctx = context();
    if std::env::var_os("GENEX_UI_CAPTURE_NO_FEATHER").is_some() {
        ctx.tessellation_options_mut(|options| options.feathering = false);
    }
    let frame = frame_texture(&ctx);
    let mut capture = Capture { textures: BTreeMap::new() };
    let mut last = None;
    for tick in 0..ticks {
        let mut output = ctx.run_ui(raw_in(world, tick, 1.0 / 60.0, Vec::new()), |ui| scene(ui, tick, &frame));
        capture.absorb(&output.textures_delta);
        output.textures_delta.clear();
        last = Some(output);
    }
    capture.render(&ctx, last.expect("one tick"), world)
}

#[test]
fn kit_captures() {
    let Some(dir) = std::env::var_os("GENEX_UI_CAPTURE_DIR").map(std::path::PathBuf::from) else {
        return;
    };
    std::fs::create_dir_all(&dir).expect("capture dir");
    let kit = capture_scene(WORLD, 40, |ui, tick, frame| {
        if tick == 0 {
            Toasts::push(ui.ctx(), ToastKind::Success, "Saved");
            Toasts::push(ui.ctx(), ToastKind::Warning, "Low health");
        }
        let rect = egui::Rect::from_min_size(egui::pos2(600.0, 120.0), egui::vec2(360.0, 220.0));
        NineSlice::new(frame.id(), [48, 48], [16, 16, 16, 16]).paint(ui.painter(), rect);
        let _ = Menu::new("pause").item("resume", "Resume").item_enabled("load", "Load", false).item("quit", "Quit").back("resume").show(ui);
        ui.add_space(12.0);
        let _ = Bar::new("hp", 0.75).label("Health").show(ui);
        ui.add_space(12.0);
        let _ = ItemList::new("quests").show(ui, 3, |ui, index, _| {
            let label = format!("Quest {index}");
            ui.label(&label);
            label
        });
        ui.add_space(12.0);
        let _ = ItemGrid::new("bag", 4).show(ui, 7, |ui, index, _| {
            let label = format!("{index}");
            ui.label(&label);
            label
        });
        Toasts::show(ui);
    });
    kit.save(dir.join("kit-1280x720.png")).expect("write");
    let dialog = capture_scene(WORLD, 30, |ui, _, _| {
        let _ = Menu::new("pause").item("resume", "Resume").item("quit", "Quit").show(ui);
        let _ = Dialog::new("quit").title("Quit?").body("Unsaved progress is lost.").button("yes", "Yes").button("no", "No").cancel("no").show(ui);
    });
    dialog.save(dir.join("dialog-1280x720.png")).expect("write");
    for (name, world) in [("nine-slice-phone-390x844.png", PHONE), ("nine-slice-4k-3840x2160.png", UHD)] {
        let shot = capture_scene(world, 2, |ui, _, frame| {
            let rect = egui::Rect::from_min_size(egui::pos2(12.0, 12.0), egui::vec2(world[0] - 24.0, world[1] - 24.0));
            NineSlice::new(frame.id(), [48, 48], [16, 16, 16, 16]).paint(ui.painter(), rect);
        });
        shot.save(dir.join(name)).expect("write");
        // The top-left and bottom-right corners, 64 world pixels each, magnified 4x side by side.
        let (w, h) = (shot.width(), shot.height());
        let mut corners = image::RgbaImage::new(512, 256);
        for (slot, (x, y)) in [(0, 0), (w - 64, h - 64)].into_iter().enumerate() {
            let crop = image::imageops::crop_imm(&shot, x, y, 64, 64).to_image();
            let zoomed = image::imageops::resize(&crop, 256, 256, image::imageops::FilterType::Nearest);
            image::imageops::replace(&mut corners, &zoomed, slot as i64 * 256, 0);
        }
        corners.save(dir.join(name.replace(".png", "-corners-x4.png"))).expect("write");
    }
}
