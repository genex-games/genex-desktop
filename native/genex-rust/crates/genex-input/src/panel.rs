//! The Controls panel: an egui widget the settings menu's Controls tab (or a game's pause menu)
//! shows. It follows genex-hud's `settings_panel` pattern: it shows the map it is given and answers
//! what the person changed as [`ControlsChange`]s, which the caller applies outside the simulation
//! (`ActionMap::rebind`, `rebind_swap`, `set_access`, `reset`) and saves as `genex-input.json`.
//!
//! Each game action is a row of its bindings, one button per slot showing its glyph ("Space",
//! "Cross") and labelled for AccessKit as "Rebind Jump" (the second slot "Rebind Jump (2)"), so a
//! play script drives it by label. A click starts listen mode: from the next tick on, the tick's
//! merged input is fed to a [`Capture`], and the first key, pad button or stick pushed becomes the
//! answer. An input another action of the context reads opens a prompt naming that action, which
//! answers nothing until Swap (or Cancel); an input the system keeps is refused and listening goes
//! on; Escape cancels. The Accessibility section answers a whole, valid [`Access`].
//!
//! Like every HUD widget it runs inside the tick from merged input only and reads no clock (egui's
//! time comes from the caller); what it keeps between ticks ([`ControlsPanel`]) is display state
//! that no checksum reads. Everything is drawn inside the panel's own rect, the body scrolls when
//! the rect is short, and every control is reachable with Tab and Space.

use egui::Ui;
use genex_core::input::TickInput;

use crate::access::{Access, HoldMode, SLOW_PRESS_PERCENT_MAX, SLOW_PRESS_PERCENT_MIN, STICK_DEAD_ZONE_MAX};
use crate::binding::{ActionKind, Binding, PadFamily};
use crate::capture::{Capture, CaptureStep};
use crate::error::InputErrorCode;
use crate::glyph::{KeyLabels, binding_glyph};
use crate::id::ActionId;
use crate::map::{ActionMap, BINDINGS_PER_ACTION_MAX};
use crate::state::Device;
use crate::ui::UI;

/// The panel's words (user copy).
const MESSAGE: Message = Message {
    heading: "Controls",
    rebind: "Rebind",
    add: "Add binding to",
    add_button: "+",
    listening: "Press a key or button for",
    listening_hint: "(Escape cancels)",
    used_by: "is used by",
    swap: "Swap",
    cancel: "Cancel",
    reserved: "That input is kept by the system",
    unusable: "That input cannot drive this action",
    access: "Accessibility",
    toggle: "Toggle",
    dead_zone_left: "Left stick dead zone",
    dead_zone_right: "Right stick dead zone",
    trigger_press: "Trigger press",
    trigger_release: "Trigger release",
    invert_left: "Invert left stick Y",
    invert_right: "Invert right stick Y",
    swap_sticks: "Swap sticks",
    slow_press: "Slow press (%)",
    reset: "Reset controls",
};

struct Message {
    heading: &'static str,
    rebind: &'static str,
    add: &'static str,
    add_button: &'static str,
    listening: &'static str,
    listening_hint: &'static str,
    used_by: &'static str,
    swap: &'static str,
    cancel: &'static str,
    reserved: &'static str,
    unusable: &'static str,
    access: &'static str,
    toggle: &'static str,
    dead_zone_left: &'static str,
    dead_zone_right: &'static str,
    trigger_press: &'static str,
    trigger_release: &'static str,
    invert_left: &'static str,
    invert_right: &'static str,
    swap_sticks: &'static str,
    slow_press: &'static str,
    reset: &'static str,
}

/// The dead-zone and trigger sliders' step.
const THRESHOLD_STEP: f64 = 0.05;
/// The slow-press slider's step, in percent.
const SLOW_PRESS_STEP: f64 = 25.0;

/// One change the person made in the panel this tick.
#[derive(Clone, Debug, PartialEq)]
pub enum ControlsChange {
    /// Listen mode started for an action's slot (one past the last slot adds a binding).
    Listen(ActionId, usize),
    /// Listen mode or the conflict prompt was left without a change.
    Cancel,
    /// Put the binding in the action's slot (`ActionMap::rebind`).
    Rebind(ActionId, usize, Binding),
    /// Take the binding from the action that holds it, handing it this slot's binding
    /// (`ActionMap::rebind_swap`).
    Swap(ActionId, usize, Binding),
    /// The whole accessibility settings, already valid (`ActionMap::set_access`).
    Access(Access),
    /// Back to the game's bindings and the default settings (`ActionMap::reset`).
    Reset,
}

impl ControlsChange {
    /// The binding a rebind or swap answers.
    pub fn binding(&self) -> Option<Binding> {
        match self {
            ControlsChange::Rebind(_, _, binding) | ControlsChange::Swap(_, _, binding) => Some(*binding),
            _ => None,
        }
    }
}

/// What the panel keeps between ticks: listen mode or the conflict prompt (display state only).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ControlsPanel {
    mode: Mode,
}

#[derive(Clone, Debug, Default, PartialEq)]
enum Mode {
    #[default]
    Idle,
    Listening {
        action: ActionId,
        slot: usize,
        capture: Capture,
        refusal: Option<&'static str>,
    },
    Prompt {
        action: ActionId,
        slot: usize,
        binding: Binding,
        holder: ActionId,
    },
}

impl ControlsPanel {
    /// Whether the panel is waiting for an input (a menu keeps its own keys off while it is).
    pub fn is_listening(&self) -> bool {
        matches!(self.mode, Mode::Listening { .. })
    }
}

/// What the panel shows this tick.
pub struct ControlsView<'a> {
    /// The map in force.
    pub map: &'a ActionMap,
    /// This tick's merged input (what listen mode captures).
    pub input: &'a TickInput,
    /// The keyboard layout's key labels (display only).
    pub labels: &'a KeyLabels,
    /// The device in use: a pad's glyphs follow its family.
    pub device: Device,
    /// An action's title ("Jump"): [`action_title`] unless the game localizes it.
    pub title: &'a dyn Fn(ActionId) -> String,
}

impl<'a> ControlsView<'a> {
    /// A view titling actions with [`action_title`].
    pub fn new(map: &'a ActionMap, input: &'a TickInput, labels: &'a KeyLabels, device: Device) -> ControlsView<'a> {
        ControlsView { map, input, labels, device, title: &action_title }
    }

    fn family(&self) -> PadFamily {
        match self.device {
            Device::Pad(family) => family,
            Device::KeyboardMouse | Device::Touch => PadFamily::Generic,
        }
    }

    fn glyph(&self, binding: &Binding) -> String {
        binding_glyph(binding, self.family(), self.labels).label
    }

    /// The actions a player rebinds: every action but the built-in `ui` context's menu keys.
    fn game_actions(&self) -> impl Iterator<Item = (ActionId, ActionKind)> + '_ {
        self.map.actions().filter(|(action, _)| self.map.context_of(*action) != Some(UI))
    }
}

/// An action's default title: its id with `_` as spaces and the first letter capitalized.
pub fn action_title(action: ActionId) -> String {
    let words = action.name().replace('_', " ");
    let mut letters = words.chars();
    match letters.next() {
        Some(first) => first.to_ascii_uppercase().to_string() + letters.as_str(),
        None => String::new(),
    }
}

/// Show the panel in `ui`; answers the changes the person made this tick, in the order made.
pub fn controls_panel(ui: &mut Ui, panel: &mut ControlsPanel, view: &ControlsView<'_>) -> Vec<ControlsChange> {
    let mut changes = Vec::new();
    // Listen mode reads this tick's input before anything is drawn, so the click (or the Space)
    // that opens it on this tick is never its own answer.
    listen(panel, view, &mut changes);
    ui.group(|ui| {
        let height = ui.available_height();
        egui::ScrollArea::vertical().max_height(height).show(ui, |ui| {
            ui.heading(MESSAGE.heading);
            banner(ui, panel, view, &mut changes);
            let idle = panel.mode == Mode::Idle;
            ui.add_enabled_ui(idle, |ui| {
                action_rows(ui, panel, view, &mut changes);
                access_section(ui, view, &mut changes);
                if reachable(ui.button(MESSAGE.reset)).clicked() {
                    changes.push(ControlsChange::Reset);
                }
            });
        });
    });
    changes
}

/// Feed listen mode this tick's input; a taken input becomes a rebind, a prompt or a refusal.
fn listen(panel: &mut ControlsPanel, view: &ControlsView<'_>, changes: &mut Vec<ControlsChange>) {
    let Mode::Listening { action, slot, capture, refusal } = &mut panel.mode else { return };
    let (action, slot) = (*action, *slot);
    let binding = match capture.feed(view.input) {
        CaptureStep::Waiting => return,
        CaptureStep::Cancelled => {
            panel.mode = Mode::Idle;
            changes.push(ControlsChange::Cancel);
            return;
        }
        CaptureStep::Took(binding) => binding,
    };
    let mut probe = view.map.clone();
    let Err(refused) = probe.rebind(action, slot, binding) else {
        panel.mode = Mode::Idle;
        changes.push(ControlsChange::Rebind(action, slot, binding));
        return;
    };
    match (refused.code, refused.clash) {
        (InputErrorCode::BindingConflict, Some(holder)) => {
            panel.mode = Mode::Prompt { action, slot, binding, holder };
        }
        (InputErrorCode::BindingReserved, _) => *refusal = Some(MESSAGE.reserved),
        _ => *refusal = Some(MESSAGE.unusable),
    }
}

/// What listen mode waits for, or the conflict prompt with Swap and Cancel.
fn banner(ui: &mut Ui, panel: &mut ControlsPanel, view: &ControlsView<'_>, changes: &mut Vec<ControlsChange>) {
    let answer = match &panel.mode {
        Mode::Idle => return,
        Mode::Listening { action, refusal, .. } => {
            ui.label(format!("{} {} {}", MESSAGE.listening, (view.title)(*action), MESSAGE.listening_hint));
            if let Some(refusal) = refusal {
                ui.label(*refusal);
            }
            let cancel = reachable(ui.button(MESSAGE.cancel)).clicked();
            cancel.then_some(ControlsChange::Cancel)
        }
        Mode::Prompt { action, slot, binding, holder } => {
            ui.label(format!("{} {} {}", view.glyph(binding), MESSAGE.used_by, (view.title)(*holder)));
            let (swap, cancel) = ui
                .horizontal(|ui| {
                    let swap = reachable(ui.button(MESSAGE.swap)).clicked();
                    (swap, reachable(ui.button(MESSAGE.cancel)).clicked())
                })
                .inner;
            match (swap, cancel) {
                (true, _) => Some(ControlsChange::Swap(*action, *slot, *binding)),
                (false, true) => Some(ControlsChange::Cancel),
                (false, false) => None,
            }
        }
    };
    if let Some(answer) = answer {
        panel.mode = Mode::Idle;
        changes.push(answer);
    }
}

/// One row per game action: a button per binding slot, and one to add a binding while there is
/// room.
fn action_rows(ui: &mut Ui, panel: &mut ControlsPanel, view: &ControlsView<'_>, changes: &mut Vec<ControlsChange>) {
    for (action, kind) in view.game_actions() {
        let title = (view.title)(action);
        let bindings = view.map.bindings(action);
        let mut picked = None;
        ui.horizontal_wrapped(|ui| {
            ui.label(&title);
            for (slot, binding) in bindings.iter().enumerate() {
                // An on-screen control's binding follows the layout, not the player.
                if matches!(binding, Binding::Touch(_)) {
                    continue;
                }
                if labelled(ui.button(view.glyph(binding)), ui.is_enabled(), &slot_label(&title, slot)).clicked() {
                    picked = Some(slot);
                }
            }
            if bindings.len() < BINDINGS_PER_ACTION_MAX {
                let label = format!("{} {title}", MESSAGE.add);
                if labelled(ui.button(MESSAGE.add_button), ui.is_enabled(), &label).clicked() {
                    picked = Some(bindings.len());
                }
            }
        });
        if let Some(slot) = picked {
            panel.mode = Mode::Listening { action, slot, capture: Capture::new(kind), refusal: None };
            changes.push(ControlsChange::Listen(action, slot));
        }
    }
}

/// The AccessKit label of a slot's button: "Rebind Jump", then "Rebind Jump (2)" and on.
fn slot_label(title: &str, slot: usize) -> String {
    match slot {
        0 => format!("{} {title}", MESSAGE.rebind),
        _ => format!("{} {title} ({})", MESSAGE.rebind, slot + 1),
    }
}

/// The accessibility settings, folded under one header (closed until opened, as the graphics
/// panel's features): a whole valid [`Access`] is answered when anything changed.
fn access_section(ui: &mut Ui, view: &ControlsView<'_>, changes: &mut Vec<ControlsChange>) {
    let before = view.map.access();
    let mut access = before.clone();
    egui::CollapsingHeader::new(MESSAGE.access).default_open(false).show(ui, |ui| {
        hold_modes(ui, view, &mut access);
        let zone = 0.0..=f64::from(STICK_DEAD_ZONE_MAX);
        slider(ui, &mut access.stick_dead_zone[0], zone.clone(), MESSAGE.dead_zone_left);
        slider(ui, &mut access.stick_dead_zone[1], zone, MESSAGE.dead_zone_right);
        slider(ui, &mut access.trigger_press, THRESHOLD_STEP..=1.0, MESSAGE.trigger_press);
        slider(ui, &mut access.trigger_release, 0.0..=1.0 - THRESHOLD_STEP, MESSAGE.trigger_release);
        reachable(ui.checkbox(&mut access.invert_y[0], MESSAGE.invert_left));
        reachable(ui.checkbox(&mut access.invert_y[1], MESSAGE.invert_right));
        reachable(ui.checkbox(&mut access.swap_sticks, MESSAGE.swap_sticks));
        let mut percent = f64::from(access.slow_press_percent);
        let range = f64::from(SLOW_PRESS_PERCENT_MIN)..=f64::from(SLOW_PRESS_PERCENT_MAX);
        let slow = egui::Slider::new(&mut percent, range).step_by(SLOW_PRESS_STEP).text(MESSAGE.slow_press);
        reachable(ui.add(slow));
        access.slow_press_percent = percent as u16;
    });
    if access != *before && access.validate().is_ok() {
        changes.push(ControlsChange::Access(access));
    }
}

/// A "Toggle Jump" switch per button action of the game.
fn hold_modes(ui: &mut Ui, view: &ControlsView<'_>, access: &mut Access) {
    for (action, kind) in view.game_actions() {
        if kind != ActionKind::Button {
            continue;
        }
        let mut toggle = access.mode(action) == HoldMode::Toggle;
        let label = format!("{} {}", MESSAGE.toggle, (view.title)(action));
        if !reachable(ui.checkbox(&mut toggle, label)).changed() {
            continue;
        }
        if toggle {
            access.hold_mode.insert(action, HoldMode::Toggle);
        } else {
            access.hold_mode.remove(&action);
        }
    }
}

/// A threshold slider over an `f32` setting.
fn slider(ui: &mut Ui, value: &mut f32, range: std::ops::RangeInclusive<f64>, text: &str) {
    let mut wide = f64::from(*value);
    reachable(ui.add(egui::Slider::new(&mut wide, range).step_by(THRESHOLD_STEP).text(text)));
    // Written back only when moved: an untouched default (0.75) stays bit-exact.
    if wide != f64::from(*value) {
        *value = wide as f32;
    }
}

/// `response` with `label` as its AccessKit label in place of its visible text.
fn labelled(response: egui::Response, enabled: bool, label: &str) -> egui::Response {
    response.widget_info(|| egui::WidgetInfo::labeled(egui::WidgetType::Button, enabled, label));
    reachable(response)
}

/// A widget that takes keyboard focus is scrolled into view, so Tab reaches every control of a
/// short panel.
fn reachable(response: egui::Response) -> egui::Response {
    if response.gained_focus() {
        response.scroll_to_me(None);
    }
    response
}
