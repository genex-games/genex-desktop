//! Every screen the game draws from `on_ui`, one per tick: the HUD while playing, and the title,
//! pause, settings, inventory and slot screens, each a panel inside the safe area. Menus come from
//! the kit (`Menu`, `Dialog`, `ItemGrid`, `ItemList`, `Bar`, `Toasts`), so the pad and the keys
//! walk them with no code here, and every word is a text key looked up with `tr`. A screen
//! ignores answers on the tick it opened, so the press that opened it never also picks in it.

use genex::prelude::*;
use genex::saves::{SlotInfo, SlotOp, SlotState};
use genex::settings::SettingValue;
use genex::ui::{Bar, Dialog, ItemGrid, ItemList, Menu, ToastKind, Toasts, safe_area, tr, tr_args};

use crate::world::{BAG_SLOTS, HEALTH_MAX, SLOT_NAMES, Screen, World, new_world};

/// A panel's fill: the night's slate, mostly opaque.
const PANEL: egui::Color32 = egui::Color32::from_rgba_premultiplied(18, 22, 32, 230);
const CELL: egui::Color32 = egui::Color32::from_rgb(40, 48, 64);
const CELL_EQUIPPED: egui::Color32 = egui::Color32::from_rgb(92, 66, 40);
const TEXT: egui::Color32 = egui::Color32::from_rgb(232, 228, 220);
const HINT: egui::Color32 = egui::Color32::from_rgb(170, 176, 190);
const HEALTH: egui::Color32 = egui::Color32::from_rgb(200, 72, 72);
/// The widest a menu panel and the settings panel grow, in world pixels.
const PANEL_WIDTH_MAX: f32 = 560.0;
const SETTINGS_WIDTH_MAX: f32 = 760.0;
/// Space above a centred panel, in world pixels.
const PANEL_TOP: f32 = 24.0;
/// A panel's inner margin, in world pixels.
const PANEL_MARGIN: i8 = 20;
/// The gap under a panel's heading, in world pixels.
const HEADING_GAP: f32 = 12.0;
/// Bag columns (a 4 by 3 grid, or 3 by 4 on a narrow screen) and a cell's side, in world pixels.
const BAG_COLUMNS: usize = 4;
const BAG_COLUMNS_NARROW: usize = 3;
const BAG_CELL: f32 = 92.0;
/// The gap between bag cells (the kit's), for the narrow-screen check.
const BAG_GAP: f32 = 6.0;
/// The widest a slot row grows and its height, in world pixels.
const SLOT_ROW_WIDTH_MAX: f32 = 520.0;
const SLOT_ROW_HEIGHT: f32 = 52.0;
/// Painted text's inset inside its cell or row, in world pixels.
const TEXT_INSET: f32 = 6.0;
/// Text sizes for painted cells and rows, in points.
const CELL_TEXT: f32 = 14.0;
const ROW_TEXT: f32 = 17.0;
/// The HUD's health bar size, in world pixels.
const HEALTH_BAR: egui::Vec2 = egui::vec2(220.0, 22.0);
/// Milliseconds in a second and seconds in a minute, for a slot's play time.
const MS_PER_SECOND: u64 = 1000;
const SECONDS_PER_MINUTE: u64 = 60;

/// The rect of the drawn world a phone's notch, island or home indicator leaves clear.
fn safe_rect(ui: &egui::Ui) -> egui::Rect {
    let margin = safe_area(ui);
    let rect = ui.max_rect();
    let min = rect.min + egui::vec2(f32::from(margin.left), f32::from(margin.top));
    let max = rect.max - egui::vec2(f32::from(margin.right), f32::from(margin.bottom));
    egui::Rect::from_min_max(min, max.max(min))
}

/// A centred panel inside the safe area: its heading, then `body`.
fn panel<R>(ui: &mut egui::Ui, heading: &str, body: impl FnOnce(&mut egui::Ui) -> R) -> R {
    panel_sized(ui, PANEL_WIDTH_MAX, heading, body)
}

/// A centred panel at most `width` wide (less on a narrow screen).
fn panel_sized<R>(ui: &mut egui::Ui, width: f32, heading: &str, body: impl FnOnce(&mut egui::Ui) -> R) -> R {
    let rect = safe_rect(ui);
    let mut column = ui.new_child(egui::UiBuilder::new().max_rect(rect).layout(egui::Layout::top_down(egui::Align::Center)));
    column.add_space(PANEL_TOP);
    let frame = egui::Frame::new().fill(PANEL).corner_radius(12.0).inner_margin(egui::Margin::same(PANEL_MARGIN));
    frame
        .show(&mut column, |ui| {
            ui.set_max_width(width.min(ui.available_width()));
            ui.vertical_centered(|ui| {
                ui.heading(heading);
                ui.add_space(HEADING_GAP);
                body(ui)
            })
            .inner
        })
        .inner
}

/// A short hint line under a panel's contents.
fn hint(ui: &mut egui::Ui, key: &str) {
    ui.add_space(HEADING_GAP);
    ui.label(egui::RichText::new(tr(key)).color(HINT).size(CELL_TEXT));
}

/// Whether the player cancelled this pass (B or Escape reach egui as Escape).
fn cancelled(ui: &egui::Ui) -> bool {
    ui.input(|input| input.key_pressed(egui::Key::Escape))
}

/// A slot's play time as minutes and seconds (`3:07`).
fn play_time(info: &SlotInfo) -> String {
    let seconds = info.play_ms / MS_PER_SECOND;
    format!("{}:{:02}", seconds / SECONDS_PER_MINUTE, seconds % SECONDS_PER_MINUTE)
}

/// The label a save writes into its slot, in the current locale.
fn slot_label(world: &World) -> String {
    tr_args("slot-label", &TextArgs::new().num("coins", world.coins).num("hp", world.hp))
}

/// Every slot that loads, newest play first (Continue picks the first).
fn loadable(ctx: &Ctx) -> Vec<SlotInfo> {
    let mut slots: Vec<SlotInfo> = ctx.slots().list().iter().filter(|info| matches!(info.state, SlotState::Ready | SlotState::NeedsMigration)).cloned().collect();
    slots.sort_by(|a, b| b.tick.cmp(&a.tick).then_with(|| a.name.as_str().cmp(b.name.as_str())));
    slots
}

/// A toast for each slot event of this tick, and for loot just found.
fn toasts(world: &mut World, ui: &egui::Ui, ctx: &Ctx) {
    for event in ctx.slots().events() {
        let slot = TextArgs::new().str("slot", event.slot.as_str());
        let (kind, text) = match (&event.result, event.op) {
            (Err(error), _) => (ToastKind::Error, tr_args("toast-refused", &TextArgs::new().str("code", error.code.wire()))),
            (Ok(_), SlotOp::Save) => (ToastKind::Success, tr_args("toast-saved", &slot)),
            (Ok(_), SlotOp::Load) => (ToastKind::Success, tr_args("toast-loaded", &slot)),
            (Ok(_), SlotOp::Autosave) => (ToastKind::Info, tr("toast-autosaved")),
            (Ok(_), _) => (ToastKind::Info, tr_args("toast-deleted", &slot)),
        };
        Toasts::push(ui.ctx(), kind, &text);
    }
    if let Some(item) = world.found.take() {
        Toasts::push(ui.ctx(), ToastKind::Info, &tr_args("toast-item", &TextArgs::new().str("item", &tr(item.text_key()))));
    }
}

/// The HUD while playing: health, coins and (by the Game tab's Hints option) the controls.
fn hud(world: &World, ui: &mut egui::Ui) {
    let rect = safe_rect(ui).shrink(16.0);
    let mut corner = ui.new_child(egui::UiBuilder::new().max_rect(rect).layout(egui::Layout::top_down(egui::Align::Min)));
    let health = format!("{} {}", tr("hud-health"), world.hp);
    let fraction = world.hp as f32 / HEALTH_MAX as f32;
    // A bar's label is what checks and screen readers read; the words on screen are this label.
    corner.label(egui::RichText::new(&health).color(TEXT).size(CELL_TEXT));
    Bar::new("hud.health", fraction).label(&health).fill(HEALTH).size(HEALTH_BAR).show(&mut corner);
    corner.label(egui::RichText::new(tr_args("hud-coins", &TextArgs::new().num("coins", world.coins))).color(TEXT).size(ROW_TEXT));
    let hint_key = match genex::settings::value("hints") {
        Some(SettingValue::Choice(0)) => None,
        Some(SettingValue::Choice(1)) => Some("hud-hint-short"),
        _ => Some("hud-hint"),
    };
    if let Some(key) = hint_key {
        corner.label(egui::RichText::new(tr(key)).color(HINT).size(CELL_TEXT));
    }
}

fn title(world: &mut World, ui: &mut egui::Ui, ctx: &Ctx, fresh: bool) {
    let slots = loadable(ctx);
    let any = !slots.is_empty();
    let (resume, new, load, settings) = (tr("title-continue"), tr("title-new"), tr("title-load"), tr("title-settings"));
    let picked = panel(ui, &tr("title-heading"), |ui| {
        Menu::new("title").item_enabled("continue", &resume, any).item("new", &new).item_enabled("load", &load, any).item("settings", &settings).show(ui)
    });
    if fresh {
        return;
    }
    match picked {
        Some("continue") => {
            if let Some(newest) = slots.first() {
                ctx.slots().load(newest.name.as_str()).ok();
            }
        }
        Some("new") => {
            *world = new_world(|bound| ctx.rng.below(bound));
            world.open(Screen::Playing, ctx.tick);
        }
        Some("load") => world.open(Screen::Slots { saving: false, from_title: true }, ctx.tick),
        Some("settings") => world.open(Screen::Settings { from_title: true }, ctx.tick),
        _ => {}
    }
}

fn pause(world: &mut World, ui: &mut egui::Ui, ctx: &Ctx, fresh: bool) {
    let any = !loadable(ctx).is_empty();
    let words = ["pause-resume", "pause-inventory", "pause-save", "pause-load", "pause-settings", "pause-title"].map(tr);
    let [resume, inventory, save, load, settings, quit] = &words;
    let picked = panel(ui, &tr("pause-heading"), |ui| {
        Menu::new("pause")
            .item("resume", resume)
            .item("inventory", inventory)
            .item("save", save)
            .item_enabled("load", load, any)
            .item("settings", settings)
            .item("title", quit)
            .back("resume")
            .show(ui)
    });
    if world.quitting {
        let (heading, body, yes, no) = (tr("quit-title"), tr("quit-body"), tr("quit-yes"), tr("quit-no"));
        let answer = Dialog::new("quit").title(&heading).body(&body).button("yes", &yes).button("no", &no).cancel("no").show(ui);
        match answer {
            Some("yes") if !fresh => {
                *world = new_world(|bound| ctx.rng.below(bound));
                world.open(Screen::Title, ctx.tick);
            }
            Some(_) if !fresh => {
                world.quitting = false;
                world.since = ctx.tick;
            }
            _ => {}
        }
        return;
    }
    if fresh {
        return;
    }
    match picked {
        Some("resume") => world.open(Screen::Playing, ctx.tick),
        Some("inventory") => world.open(Screen::Inventory, ctx.tick),
        Some("save") => world.open(Screen::Slots { saving: true, from_title: false }, ctx.tick),
        Some("load") => world.open(Screen::Slots { saving: false, from_title: false }, ctx.tick),
        Some("settings") => world.open(Screen::Settings { from_title: false }, ctx.tick),
        Some("title") => {
            world.quitting = true;
            world.since = ctx.tick;
        }
        _ => {}
    }
}

fn settings(world: &mut World, ui: &mut egui::Ui, ctx: &Ctx, fresh: bool, from_title: bool) {
    let answer = panel_sized(ui, SETTINGS_WIDTH_MAX, &tr("title-settings"), genex::settings::menu_answer);
    world.tab = Some(answer.tab.wire());
    if answer.back && !fresh {
        let back = if from_title { Screen::Title } else { Screen::Pause };
        world.open(back, ctx.tick);
    }
}

fn inventory(world: &mut World, ui: &mut egui::Ui, ctx: &Ctx, fresh: bool) {
    let bag = world.bag;
    let equipped = world.equipped;
    let health = format!("{} {}", tr("hud-health"), world.hp);
    let fraction = world.hp as f32 / HEALTH_MAX as f32;
    let mut clipped = 0;
    let wide = BAG_COLUMNS as f32 * (BAG_CELL + BAG_GAP) + 2.0 * f32::from(PANEL_MARGIN);
    let columns = if safe_rect(ui).width() >= wide { BAG_COLUMNS } else { BAG_COLUMNS_NARROW };
    let answer = panel(ui, &tr("inventory-heading"), |ui| {
        ui.label(egui::RichText::new(&health).color(TEXT).size(CELL_TEXT));
        Bar::new("inventory.health", fraction).label(&health).fill(HEALTH).size(HEALTH_BAR).show(ui);
        ui.add_space(HEADING_GAP);
        let answer = ItemGrid::new("bag", columns).cell(BAG_CELL).show(ui, BAG_SLOTS, |ui, index, rect| {
            let item = bag[index];
            let mut label = tr(item.text_key());
            if equipped == Some(index) {
                label = tr_args("inventory-equipped", &TextArgs::new().str("item", &label));
            }
            let fill = if equipped == Some(index) { CELL_EQUIPPED } else { CELL };
            ui.painter().rect_filled(rect, 4.0, fill);
            let name = tr(item.text_key());
            clipped += usize::from(paint_text(ui, rect, &name, CELL_TEXT, egui::Align2::CENTER_CENTER));
            label
        });
        hint(ui, "inventory-hint");
        answer
    });
    world.clipped = clipped;
    if fresh {
        return;
    }
    if let Some(index) = answer.activated {
        world.activate(index);
    }
    if let Some((from, to)) = answer.moved {
        world.swap(from, to);
    }
    if cancelled(ui) {
        world.open(Screen::Pause, ctx.tick);
    }
}

/// Paint `text` inside `rect`, wrapped to its width (inset from its left, or centred); true when
/// it still does not fit (taller than the rect, or one word wider than it).
fn paint_text(ui: &egui::Ui, rect: egui::Rect, text: &str, size: f32, align: egui::Align2) -> bool {
    let room = egui::vec2(rect.width() - 2.0 * TEXT_INSET, rect.height() - TEXT_INSET);
    let galley = ui.painter().layout(text.to_owned(), egui::FontId::proportional(size), TEXT, room.x);
    let at = if align == egui::Align2::LEFT_CENTER { rect.left_center() + egui::vec2(TEXT_INSET, 0.0) } else { rect.center() };
    let fits = galley.size().x <= room.x && galley.size().y <= room.y;
    let pos = align.anchor_size(at, galley.size());
    ui.painter().galley(pos.min, galley, TEXT);
    !fits
}

/// The rows a slot list shows: the named slots when saving, every loadable slot when loading.
fn slot_rows(ctx: &Ctx, saving: bool) -> Vec<(String, Option<SlotInfo>)> {
    if saving {
        return SLOT_NAMES.iter().map(|name| ((*name).to_owned(), ctx.slots().get(name).cloned())).collect();
    }
    let mut rows: Vec<(String, Option<SlotInfo>)> = loadable(ctx).into_iter().map(|info| (info.name.as_str().to_owned(), Some(info))).collect();
    rows.sort_by(|a, b| a.0.cmp(&b.0));
    rows
}

fn row_text(name: &str, info: Option<&SlotInfo>) -> String {
    match info {
        Some(info) => tr_args("slot-row", &TextArgs::new().str("slot", name).str("label", &info.label).str("time", &play_time(info))),
        None => tr_args("slot-empty", &TextArgs::new().str("slot", name)),
    }
}

fn slots(world: &mut World, ui: &mut egui::Ui, ctx: &Ctx, fresh: bool, saving: bool, from_title: bool) {
    let rows = slot_rows(ctx, saving);
    let heading = tr(if saving { "slots-save-heading" } else { "slots-load-heading" });
    let width = (safe_rect(ui).width() - 2.0 * (f32::from(PANEL_MARGIN) + TEXT_INSET)).min(SLOT_ROW_WIDTH_MAX);
    let mut clipped = 0;
    let answer = panel(ui, &heading, |ui| {
        let answer = ItemList::new("slots").row(egui::vec2(width, SLOT_ROW_HEIGHT)).show(ui, rows.len(), |ui, index, rect| {
            let (name, info) = &rows[index];
            let text = row_text(name, info.as_ref());
            ui.painter().rect_filled(rect, 4.0, CELL);
            clipped += usize::from(paint_text(ui, rect, &text, ROW_TEXT, egui::Align2::LEFT_CENTER));
            text
        });
        hint(ui, "slots-hint");
        answer
    });
    world.clipped = clipped;
    if let Some(slot) = world.confirm.clone() {
        overwrite(world, ui, ctx, fresh, &slot);
        return;
    }
    if fresh {
        return;
    }
    if let Some((name, info)) = answer.activated.and_then(|index| rows.get(index)) {
        match (saving, info) {
            (true, Some(_)) => {
                world.confirm = Some(name.clone());
                world.since = ctx.tick;
            }
            (true, None) => {
                ctx.slots().save(name, &slot_label(world)).ok();
            }
            (false, _) => {
                ctx.slots().load(name).ok();
            }
        }
        return;
    }
    if cancelled(ui) {
        let back = if from_title { Screen::Title } else { Screen::Pause };
        world.open(back, ctx.tick);
    }
}

/// The overwrite dialog over the save list.
fn overwrite(world: &mut World, ui: &mut egui::Ui, ctx: &Ctx, fresh: bool, slot: &str) {
    let heading = tr_args("overwrite-title", &TextArgs::new().str("slot", slot));
    let (yes, no) = (tr("overwrite-yes"), tr("overwrite-no"));
    let answer = Dialog::new("overwrite").title(&heading).button("yes", &yes).button("no", &no).cancel("no").show(ui);
    if fresh {
        return;
    }
    if answer == Some("yes") {
        ctx.slots().save(slot, &slot_label(world)).ok();
    }
    if answer.is_some() {
        world.confirm = None;
        world.since = ctx.tick;
    }
}

fn draw_ui(sim: &mut Sim<World>, ui: &mut egui::Ui, ctx: &Ctx) {
    let world = &mut sim.world;
    toasts(world, ui, ctx);
    world.clipped = 0;
    let fresh = ctx.tick == world.since;
    match world.screen {
        Screen::Playing => hud(world, ui),
        Screen::Title => title(world, ui, ctx, fresh),
        Screen::Pause => pause(world, ui, ctx, fresh),
        Screen::Settings { from_title } => settings(world, ui, ctx, fresh, from_title),
        Screen::Inventory => inventory(world, ui, ctx, fresh),
        Screen::Slots { saving, from_title } => slots(world, ui, ctx, fresh, saving, from_title),
    }
    // Toasts inside the safe area (once genex-ui places them in the caller's rect; today it uses
    // the whole frame).
    let safe = ui.new_child(egui::UiBuilder::new().max_rect(safe_rect(ui)));
    Toasts::show(&safe);
}

/// Register the UI hook.
pub fn wire(game: &mut Game<World>) {
    game.on_ui(draw_ui);
}
