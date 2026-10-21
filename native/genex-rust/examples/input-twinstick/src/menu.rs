//! The HUD and the pause menu. The HUD shows the score, the hit points and a prompt per action
//! drawn with the glyph of the device in use ("Space" on a keyboard, "Cross" on a PlayStation pad).
//! The pause menu holds Resume and the Controls panel: what the person rebinds there is applied
//! after the tick's UI hooks and saved as `genex-input.json`, and the `ui` context lets a pad or the
//! keyboard walk it (Tab or the shoulders move the focus, Enter or the confirm button presses).

use genex::actions::{ActionId, Device, controls_panel, glyph_ui};
use genex::egui;
use genex::prelude::*;

use crate::arena::{World, set_paused};
use crate::controls::{DASH, FIRE, PAUSE};

/// User copy.
const MESSAGE: Message = Message {
    score: "Score",
    hp: "HP",
    dash: "Dash",
    fire: "Fire",
    pause: "Pause",
    paused: "Paused",
    resume: "Resume",
    over: "Game over",
    restart: "to play again",
};

struct Message {
    score: &'static str,
    hp: &'static str,
    dash: &'static str,
    fire: &'static str,
    pause: &'static str,
    paused: &'static str,
    resume: &'static str,
    over: &'static str,
    restart: &'static str,
}

/// The pause menu's width, in points.
const MENU_WIDTH: f32 = 420.0;
/// The pause menu's height, in points (the Controls panel scrolls inside it).
const MENU_HEIGHT: f32 = 400.0;

/// The UI hook.
pub fn hud(sim: &mut Sim<World>, ui: &mut egui::Ui, ctx: &Ctx) {
    let world = &mut sim.world;
    remember_prompts(world, ctx);
    // On a touch screen the controls themselves are on screen, so the prompts step aside.
    let prompts = ctx.actions.device() != Device::Touch;
    ui.horizontal(|ui| {
        ui.label(format!("{} {}   {} {}", MESSAGE.score, world.score, MESSAGE.hp, world.hp));
        if prompts {
            prompt(ui, ctx, MESSAGE.fire, FIRE);
            prompt(ui, ctx, MESSAGE.dash, DASH);
            prompt(ui, ctx, MESSAGE.pause, PAUSE);
        }
    });
    if world.over {
        ui.horizontal(|ui| {
            ui.label(MESSAGE.over);
            glyph_ui(ui, &ctx.actions.glyph(FIRE));
            ui.label(MESSAGE.restart);
        });
    }
    world.shown.focused = None;
    if world.paused {
        pause_menu(world, ui, ctx);
    }
}

/// One prompt: the action's name and its glyph.
fn prompt(ui: &mut egui::Ui, ctx: &Ctx, name: &str, action: ActionId) {
    ui.separator();
    ui.label(name);
    glyph_ui(ui, &ctx.actions.glyph(action));
}

/// What the prompts read this pass (display only: never a rule, a save or the checksum).
fn remember_prompts(world: &mut World, ctx: &Ctx) {
    let actions = ctx.actions;
    let dash = actions.glyph(DASH);
    world.shown.device = dash.device.as_str().to_owned();
    world.shown.dash = dash.label;
    world.shown.fire = actions.glyph(FIRE).label;
    world.shown.pause = actions.glyph(PAUSE).label;
}

/// The pause menu: Resume and the Controls panel, in a window in the middle of the screen.
fn pause_menu(world: &mut World, ui: &mut egui::Ui, ctx: &Ctx) {
    let mut resume = false;
    egui::Window::new(MESSAGE.paused)
        .collapsible(false)
        .resizable(false)
        .anchor(egui::Align2::CENTER_CENTER, [0.0, 0.0])
        .fixed_size([MENU_WIDTH, MENU_HEIGHT])
        .show(ui.ctx(), |ui| {
            resume = ui.button(MESSAGE.resume).clicked();
            ui.separator();
            egui::ScrollArea::vertical().show(ui, controls_panel);
        });
    world.shown.focused = focused_label(ui.ctx());
    if resume {
        set_paused(world, ctx, false);
    }
}

/// The AccessKit label of the widget holding the keyboard focus ("Resume", "Rebind Dash"): what a
/// demo walking the menu with Tab reads to find a widget by its label.
fn focused_label(context: &egui::Context) -> Option<String> {
    let id = context.memory(|memory| memory.focused())?;
    context.accesskit_node_builder(id, |node| node.label().map(str::to_owned)).flatten()
}
