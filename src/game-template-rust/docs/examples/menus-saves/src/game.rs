//! GREYBOX: the courtyard and its markings are boxes to show the menus over; replace
//! them with the game's own world. Copy the menus, slots, settings and toasts.
//!
//! Menus and saves, distilled from the engine's menus-saves example: a courtyard where coins
//! respawn and health drains, under a title menu (Continue, New game, Load, Settings), a pause menu
//! (Resume, Save, Load, Settings, Quit to title behind a confirm), slot lists for saving and loading,
//! the facade's whole settings menu, and a toast for every slot event.
//!
//! Every menu is the kit's (`genex::ui::Menu`, `Bar`, `Toasts`): keys, a pad and a tap all walk
//! and pick it with no code here. Which screen is open is display state, skipped by serde, so a
//! load always lands in play; everything the game plays with is in `World` and saved whole by
//! `game.save_world()`. A screen ignores answers on the tick it opened, so the press that opened it
//! (Escape opening a pause menu whose back key is Escape too) never also picks in it. The HUD's
//! arrow and pause buttons are the phone's way to every action.

use genex::prelude::*;
use genex::saves::{SaveConfig, SlotInfo, SlotOp, SlotState};
use genex::ui::{Bar, Menu, ToastKind, Toasts};

/// Tiles from the centre to an edge, coins lying at once, full health and ticks per point lost.
const HALF: i32 = 3;
const COINS: usize = 4;
pub const HEALTH_MAX: u32 = 100;
const DRAIN_TICKS: u64 = 60;
/// The named slots the save list offers, the autosave interval (a minute of play) and ring.
pub const SLOTS: [&str; 3] = ["slot-1", "slot-2", "slot-3"];
const AUTOSAVE_TICKS: u64 = 3600;
const AUTOSAVE_RING: u8 = 2;
/// The widest a menu panel grows (the settings menu's tabs need about this much), in world pixels.
const PANEL_WIDTH: f32 = 720.0;
const PANEL: egui::Color32 = egui::Color32::from_rgba_premultiplied(18, 22, 32, 230);

/// Which screen is open: display state, never saved.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Screen {
    #[default]
    Playing,
    Title,
    Pause,
    Slots { saving: bool, from_title: bool },
    Settings { from_title: bool },
}

impl Screen {
    /// Its name in the `menus` probe.
    const fn wire(self) -> &'static str {
        match self {
            Screen::Playing => "playing",
            Screen::Title => "title",
            Screen::Pause => "pause",
            Screen::Slots { saving: true, .. } => "save-slots",
            Screen::Slots { saving: false, .. } => "load-slots",
            Screen::Settings { .. } => "settings",
        }
    }
}

/// The courtyard and its menus. Every seed rebuilds it from `World::default()`.
#[derive(Default, Serialize, Deserialize)]
#[serde(crate = "genex::serde")]
pub struct World {
    player: [i32; 2],
    coins_at: Vec<[i32; 2]>,
    coins: u32,
    hp: u32,
    played: u64,
    #[serde(skip)]
    screen: Screen,
    /// The tick the open screen opened on.
    #[serde(skip)]
    since: u64,
    #[serde(skip)]
    quitting: bool,
    /// A step the HUD's arrow buttons asked for, taken on the next tick.
    #[serde(skip)]
    step: [i32; 2],
}

impl World {
    fn open(&mut self, screen: Screen, tick: u64) {
        (self.screen, self.since, self.quitting) = (screen, tick, false);
    }

    /// A fresh game: the player in the middle, full health, coins placed by `draw`.
    fn fresh(mut draw: impl FnMut(u32) -> u32) -> World {
        let mut world = World { hp: HEALTH_MAX, ..World::default() };
        for _ in 0..COINS {
            let tile = world.free_tile(&mut draw);
            world.coins_at.push(tile);
        }
        world
    }

    /// A tile with no player and no coin on it, from `draw` (the reset's or the tick's rng).
    fn free_tile(&self, mut draw: impl FnMut(u32) -> u32) -> [i32; 2] {
        let side = (2 * HALF + 1) as u32;
        let mut tile = [0, 0];
        for _ in 0..16 {
            tile = [draw(side) as i32 - HALF, draw(side) as i32 - HALF];
            if tile != self.player && !self.coins_at.contains(&tile) {
                break;
            }
        }
        tile
    }
}

/// Register every hook, the slots and the probes.
pub fn wire(game: &mut Game<World>) {
    game.saves(SaveConfig::schema(1).autosave(AUTOSAVE_TICKS, AUTOSAVE_RING));
    game.save_world();
    game.on_reset(|sim, _seed, rng, _gfx| {
        sim.world = World::fresh(|bound| rng.below(bound));
        sim.world.screen = Screen::Title;
    });
    game.on_update(update);
    game.on_ui(draw_ui);
    game.on_draw(|sim, frame, _camera| draw(&sim.world, frame));
    game.camera(|_| Camera::look_at(vec3(0.0, 7.5, 6.5), Vec3::ZERO));
    // What a save holds, so a load's checksum self-check covers it; the open screen is volatile.
    game.probe("world", |sim| {
        let world = &sim.world;
        json!({ "player": world.player, "coins": world.coins, "coinsAt": world.coins_at, "hp": world.hp, "played": world.played })
    });
    game.probe_volatile("menus", |sim| json!({ "screen": sim.world.screen.wire(), "quitting": sim.world.quitting }));
}

fn update(sim: &mut Sim<World>, ctx: &Ctx<'_>) {
    let world = &mut sim.world;
    if world.screen != Screen::Playing {
        return;
    }
    if ctx.keys.pressed(Key::Escape) {
        world.open(Screen::Pause, ctx.tick);
        return;
    }
    let pressed = |keys: [Key; 2]| i32::from(keys.iter().any(|key| ctx.keys.pressed(*key)));
    let x = pressed([Key::ArrowRight, Key::KeyD]) - pressed([Key::ArrowLeft, Key::KeyA]) + world.step[0];
    let z = pressed([Key::ArrowDown, Key::KeyS]) - pressed([Key::ArrowUp, Key::KeyW]) + world.step[1];
    world.step = [0, 0];
    world.player = [(world.player[0] + x).clamp(-HALF, HALF), (world.player[1] + z).clamp(-HALF, HALF)];
    if let Some(index) = world.coins_at.iter().position(|tile| *tile == world.player) {
        world.coins += 1;
        world.coins_at.remove(index);
        let tile = world.free_tile(|bound| ctx.rng.below(bound));
        world.coins_at.push(tile);
    }
    world.played += 1;
    if world.played.is_multiple_of(DRAIN_TICKS) {
        world.hp = world.hp.saturating_sub(1);
    }
}

/// A centred panel with a heading over `body`.
fn panel<R>(ui: &mut egui::Ui, heading: &str, body: impl FnOnce(&mut egui::Ui) -> R) -> R {
    let mut column = ui.new_child(egui::UiBuilder::new().max_rect(ui.max_rect()).layout(egui::Layout::top_down(egui::Align::Center)));
    column.add_space(24.0);
    let frame = egui::Frame::new().fill(PANEL).corner_radius(12.0).inner_margin(egui::Margin::same(20));
    let shown = frame.show(&mut column, |ui| {
        ui.set_max_width(PANEL_WIDTH.min(ui.available_width()));
        ui.vertical_centered(|ui| {
            ui.heading(heading);
            ui.add_space(12.0);
            body(ui)
        })
    });
    shown.inner.inner
}

/// Every slot that loads, the newest play first (Continue loads the first).
fn loadable(ctx: &Ctx<'_>) -> Vec<SlotInfo> {
    let ready = |info: &&SlotInfo| matches!(info.state, SlotState::Ready | SlotState::NeedsMigration);
    let mut slots: Vec<SlotInfo> = ctx.slots().list().iter().filter(ready).cloned().collect();
    slots.sort_by(|a, b| b.tick.cmp(&a.tick).then_with(|| a.name.as_str().cmp(b.name.as_str())));
    slots
}

/// One tick of UI: the toasts for this tick's slot events, then the open screen.
fn draw_ui(sim: &mut Sim<World>, ui: &mut egui::Ui, ctx: &Ctx<'_>) {
    for event in ctx.slots().events() {
        let text = match (&event.result, event.op) {
            (Err(error), _) => format!("Refused: {}", error.code.wire()),
            (Ok(_), SlotOp::Save) => format!("Saved {}", event.slot.as_str()),
            (Ok(_), SlotOp::Load) => format!("Loaded {}", event.slot.as_str()),
            (Ok(_), SlotOp::Autosave) => "Autosaved".to_owned(),
            (Ok(_), _) => format!("Deleted {}", event.slot.as_str()),
        };
        let kind = if event.result.is_ok() { ToastKind::Success } else { ToastKind::Error };
        Toasts::push(ui.ctx(), kind, &text);
    }
    let world = &mut sim.world;
    let fresh = ctx.tick == world.since;
    match world.screen {
        Screen::Playing => hud(world, ui, ctx),
        Screen::Title => title(world, ui, ctx, fresh),
        Screen::Pause => pause(world, ui, ctx, fresh),
        Screen::Slots { saving, from_title } => slots(world, ui, ctx, fresh, saving, from_title),
        Screen::Settings { from_title } => {
            let answer = panel(ui, "Settings", genex::settings::menu_answer);
            if answer.back && !fresh {
                world.open(if from_title { Screen::Title } else { Screen::Pause }, ctx.tick);
            }
        }
    }
    Toasts::show(ui);
}

/// Health, coins, and the buttons a phone plays with: four steps and a pause.
fn hud(world: &mut World, ui: &mut egui::Ui, ctx: &Ctx<'_>) {
    let health = format!("Health {}", world.hp);
    ui.label(egui::RichText::new(&health).color(egui::Color32::WHITE));
    Bar::new("hud.health", world.hp as f32 / HEALTH_MAX as f32).label(&health).show(ui);
    ui.label(egui::RichText::new(format!("Coins {}", world.coins)).color(egui::Color32::WHITE).size(20.0));
    let pad = egui::Rect::from_min_size(ui.max_rect().left_bottom() - egui::vec2(0.0, 150.0), egui::vec2(240.0, 150.0));
    let mut buttons = ui.new_child(egui::UiBuilder::new().max_rect(pad));
    let size = egui::vec2(72.0, 44.0);
    buttons.horizontal(|ui| {
        ui.add_space(size.x + 6.0);
        if ui.add_sized(size, egui::Button::new("Up")).clicked() {
            world.step = [0, -1];
        }
    });
    buttons.horizontal(|ui| {
        for (label, step) in [("Left", [-1, 0]), ("Down", [0, 1]), ("Right", [1, 0])] {
            if ui.add_sized(size, egui::Button::new(label)).clicked() {
                world.step = step;
            }
        }
    });
    let corner = egui::Rect::from_min_size(ui.max_rect().right_top() - egui::vec2(110.0, 0.0), egui::vec2(110.0, 50.0));
    if ui.new_child(egui::UiBuilder::new().max_rect(corner)).add_sized(egui::vec2(100.0, 44.0), egui::Button::new("Pause")).clicked() {
        world.open(Screen::Pause, ctx.tick);
    }
}

fn title(world: &mut World, ui: &mut egui::Ui, ctx: &Ctx<'_>, fresh: bool) {
    let slots = loadable(ctx);
    let any = !slots.is_empty();
    let picked = panel(ui, "Menus and saves", |ui| {
        Menu::new("title").item_enabled("continue", "Continue", any).item("new", "New game").item_enabled("load", "Load game", any).item("settings", "Settings").show(ui)
    });
    match picked.filter(|_| !fresh) {
        Some("continue") => {
            if let Some(newest) = slots.first() {
                ctx.slots().load(newest.name.as_str()).ok();
            }
        }
        Some("new") => {
            *world = World::fresh(|bound| ctx.rng.below(bound));
            world.open(Screen::Playing, ctx.tick);
        }
        Some("load") => world.open(Screen::Slots { saving: false, from_title: true }, ctx.tick),
        Some("settings") => world.open(Screen::Settings { from_title: true }, ctx.tick),
        _ => {}
    }
}

fn pause(world: &mut World, ui: &mut egui::Ui, ctx: &Ctx<'_>, fresh: bool) {
    if world.quitting {
        confirm_quit(world, ui, ctx, fresh);
        return;
    }
    let any = !loadable(ctx).is_empty();
    let picked = panel(ui, "Paused", |ui| {
        let menu = Menu::new("pause").item("resume", "Resume").item("save", "Save game").item_enabled("load", "Load game", any);
        menu.item("settings", "Settings").item("title", "Quit to title").back("resume").show(ui)
    });
    match picked.filter(|_| !fresh) {
        Some("resume") => world.open(Screen::Playing, ctx.tick),
        Some("save") => world.open(Screen::Slots { saving: true, from_title: false }, ctx.tick),
        Some("load") => world.open(Screen::Slots { saving: false, from_title: false }, ctx.tick),
        Some("settings") => world.open(Screen::Settings { from_title: false }, ctx.tick),
        Some("title") => (world.quitting, world.since) = (true, ctx.tick),
        _ => {}
    }
}

/// Quit to the title only once asked: a panel of its own in place of the pause menu, Stay first
/// and on Escape, so a stray press never throws the run away.
fn confirm_quit(world: &mut World, ui: &mut egui::Ui, ctx: &Ctx<'_>, fresh: bool) {
    let picked = panel(ui, "Quit to title?", |ui| {
        ui.label("Progress since your last save is lost.");
        ui.add_space(12.0);
        Menu::new("quit").item("no", "Stay").item("yes", "Quit").back("no").show(ui)
    });
    match picked.filter(|_| !fresh) {
        Some("yes") => {
            *world = World::fresh(|bound| ctx.rng.below(bound));
            world.open(Screen::Title, ctx.tick);
        }
        Some(_) => (world.quitting, world.since) = (false, ctx.tick),
        None => {}
    }
}

/// The save list (the named slots, empty or not) or the load list (every slot that loads,
/// autosaves too). Saving writes the slot with a label of the run so far; it lands in play.
fn slots(world: &mut World, ui: &mut egui::Ui, ctx: &Ctx<'_>, fresh: bool, saving: bool, from_title: bool) {
    let rows: Vec<(String, Option<SlotInfo>)> = if saving {
        SLOTS.iter().map(|name| ((*name).to_owned(), ctx.slots().get(name).cloned())).collect()
    } else {
        loadable(ctx).into_iter().map(|info| (info.name.as_str().to_owned(), Some(info))).collect()
    };
    let labels: Vec<String> = rows
        .iter()
        .map(|(name, info)| match info {
            Some(info) => format!("{name}: {} ({}:{:02})", info.label, info.play_ms / 60_000, info.play_ms / 1000 % 60),
            None => format!("{name}: empty"),
        })
        .collect();
    let picked = panel(ui, if saving { "Save game" } else { "Load game" }, |ui| {
        let menu = rows.iter().zip(&labels).fold(Menu::new("slots"), |menu, ((name, _), label)| menu.item(name, label));
        menu.item("back", "Back").back("back").show(ui)
    });
    let back = if from_title { Screen::Title } else { Screen::Pause };
    match picked.filter(|_| !fresh) {
        Some("back") => world.open(back, ctx.tick),
        Some(slot) if saving => {
            let label = format!("{} coins, health {}", world.coins, world.hp);
            ctx.slots().save(slot, &label).ok();
            world.open(Screen::Playing, ctx.tick);
        }
        Some(slot) => {
            ctx.slots().load(slot).ok();
        }
        None => {}
    }
}

fn draw(world: &World, frame: &mut Frame) {
    frame.clear(Color::rgb(24, 28, 38)).ambient(Color::rgb(170, 185, 210), 0.3).sun(vec3(0.3, 0.8, 0.4), Color::WHITE, 2.5);
    let side = (2 * HALF + 1) as f32;
    frame.tag("courtyard").cube_with(Transform::from_xyz(0.0, -0.1, 0.0).with_scale(vec3(side, 0.2, side)), &Material::color(Color::rgb(52, 70, 60)).with_roughness(0.9));
    let line = Material::color(Color::rgb(70, 92, 78));
    for at in -HALF..=HALF + 1 {
        let at = at as f32 - 0.5;
        frame.cube_with(Transform::from_xyz(at, 0.01, 0.0).with_scale(vec3(0.03, 0.02, side)), &line);
        frame.cube_with(Transform::from_xyz(0.0, 0.01, at).with_scale(vec3(side, 0.02, 0.03)), &line);
    }
    frame.tag("coins");
    let gold = Material::color(Color::rgb(240, 196, 60)).with_metallic(1.0).with_roughness(0.3).with_emissive(Color::rgb(240, 180, 60), 0.4);
    for [x, z] in &world.coins_at {
        frame.cube_with(Transform::from_xyz(*x as f32, 0.25, *z as f32).with_scale(vec3(0.4, 0.4, 0.12)), &gold);
    }
    frame.tag("player").sphere_with(vec3(world.player[0] as f32, 0.45, world.player[1] as f32), 0.42, &Material::color(Color::rgb(90, 160, 230)));
}
