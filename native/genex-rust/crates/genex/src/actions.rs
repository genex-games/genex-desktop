//! Input actions (`game.input`, `ctx.actions`): the facade over genex-input (G6 input, IN-11).
//!
//! A game reads actions (`jump`, `move`), never keys. It registers one [`ActionMap`] with
//! `game.input(map)`; every tick the runtime evaluates it from the tick's merged input, after the
//! HUD's focus gating (a focused text field keeps the keyboard), so `ctx.actions` in the update and
//! UI hooks is a pure function of the seed, the player's bindings and the tick rows. The player's
//! rebinds and accessibility settings live in the game's saves as `genex-input.json`: read when
//! the runtime starts (a hostile file leaves the defaults and is named in
//! `state().__input.refusal`), written outside the simulation when they change, and kept across
//! seeds. A game without `game.input` evaluates nothing, so its `state()` and checksums are
//! unchanged.
//!
//! The built-in `ui` context (off until a game enables it) hands `ui_up` .. `ui_prev` to the HUD
//! as navigation keys. [`controls_panel`] shows the player's bindings in a UI hook; what the person
//! changes there is applied after the tick's UI hooks and saved. `state().__input` is display only
//! and never hashed.

use crate::ctx::{Key, Touch};
use crate::game::Game;
use genex_core::digest::hex64;
use genex_core::input::{PAD_BUTTONS, TickInput as CoreTick};
use genex_core::json::Value as CoreValue;
use genex_core::saves::Saves;
use genex_input::glyph::{KeyLabels, action_glyph, hint};
use genex_input::panel::{ControlsChange, ControlsPanel, ControlsView};
use genex_input::state::{ActionState, Devices, evaluate_with};
use glam::Vec2;
use serde_json::{Map as JsonMap, Value, json};
use std::cell::RefCell;

pub use genex_input::access::{Access, HoldMode};
pub use genex_input::binding::{ActionKind, Binding, KeyCode, PadAxis, PadButton, PadFamily, Sign, Stick};
pub use genex_input::blob::BINDINGS_BLOB_BYTES_MAX;
pub use genex_input::condition::Condition;
pub use genex_input::error::{InputError, InputErrorCode};
pub use genex_input::glyph::{Glyph, GlyphShape};
pub use genex_input::id::{ActionId, ContextId, ControlId, NAME_MAX};
pub use genex_input::journal::{JOURNAL_BYTES_MAX, JOURNAL_RING_TICKS, JournalView};
pub use genex_input::map::{ACTIONS_MAX, ActionMap, BINDINGS_PER_ACTION_MAX, CONTEXTS_MAX, Context};
pub use genex_input::modifier::{DeadZoneKind, Modifier};
pub use genex_input::paint::glyph_ui;
pub use genex_input::state::{Device, UNKNOWN_READS_MAX};
pub use genex_input::touch::{Anchor, ShowWhen, StickMode, TouchControls};
pub use genex_input::track::{InputTrack, TrackAnchor};
pub use genex_input::ui::{UI, UiAction};

pub use crate::actions_journal::InputJournalView;

/// The player's bindings file in the game's saves.
pub const BINDINGS_FILE: &str = "genex-input.json";
/// `state()`'s input key: display only, and only while `game.input` is registered.
pub(crate) const RUNTIME_KEY: &str = "__input";
/// The DOM codes of the keys the HUD navigates with: while the `ui` context is on, the HUD gets
/// them from the `ui_*` actions (so a rebind moves them), not from the raw keys.
const NAV_KEYS: [&str; 7] = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", "Escape", "Tab"];
/// How far a stick must move to count as the player picking up that pad.
const PAD_STICK_ACTIVE: f32 = 0.5;

impl From<Key> for Binding {
    fn from(key: Key) -> Binding {
        Binding::Key(KeyCode::of(key.code()))
    }
}

impl<W> Game<W> {
    /// Read input as actions: the game's action map and contexts. Registered once; `install`
    /// refuses a second (`duplicate-input`) or an invalid map (`input-invalid`).
    pub fn input(&mut self, map: ActionMap) -> &mut Self {
        self.g6.input.maps.push(map);
        self
    }
}

/// `game.input`: the game's action map (its defaults; the player's rebinds sit on a copy).
#[derive(Debug, Default)]
pub(crate) struct Setup {
    maps: Vec<ActionMap>,
}

impl Setup {
    /// The registered map, if any.
    pub(crate) fn map(&self) -> Option<&ActionMap> {
        self.maps.first()
    }

    /// How many maps were registered (install refuses more than one).
    pub(crate) fn count(&self) -> usize {
        self.maps.len()
    }
}

/// `ctx.actions`: the tick's evaluated actions. An id the map does not declare reads false or 0
/// and is listed in `state().__input.unknownReads`.
#[derive(Debug)]
pub struct Actions {
    map: ActionMap,
    state: ActionState,
    family: PadFamily,
    labels: KeyLabels,
    free: Vec<Touch>,
}

impl Default for Actions {
    fn default() -> Actions {
        let map = ActionMap::new();
        let state = ActionState::new(&map);
        Actions { map, state, family: PadFamily::Generic, labels: KeyLabels::new(), free: Vec::new() }
    }
}

impl Actions {
    /// Whether `action` is down.
    pub fn down(&self, action: ActionId) -> bool {
        self.state.down(action)
    }

    /// Whether `action` went down on this tick.
    pub fn pressed(&self, action: ActionId) -> bool {
        self.state.pressed(action)
    }

    /// Whether `action` came up on this tick.
    pub fn released(&self, action: ActionId) -> bool {
        self.state.released(action)
    }

    /// Whether `action`'s conditions fired on this tick (with none, whether it is down).
    pub fn fired(&self, action: ActionId) -> bool {
        self.state.fired(action)
    }

    /// The value of a button or 1D axis (a 2D axis answers its x).
    pub fn value(&self, action: ActionId) -> f32 {
        self.state.value(action)
    }

    /// The value of a 2D axis, x right and y down.
    pub fn axis2(&self, action: ActionId) -> Vec2 {
        let [x, y] = self.state.axis2(action);
        Vec2::new(x, y)
    }

    /// Ticks since `action` went down (0 on that tick, and while it is up).
    pub fn held_ticks(&self, action: ActionId) -> u32 {
        self.state.held_ticks(action)
    }

    /// The device the player used last.
    pub fn device(&self) -> Device {
        self.state.device()
    }

    /// The prompt for `action` on the device in use ("Space", "Cross"): display text, never part of
    /// the simulation.
    pub fn glyph(&self, action: ActionId) -> Glyph {
        action_glyph(&self.map, action, self.device_with_family(), &self.labels)
    }

    /// Whether `context` is on this tick.
    pub fn is_on(&self, context: ContextId) -> bool {
        self.state.is_on(context)
    }

    /// Turn `context` on from the next tick.
    pub fn enable(&self, context: ContextId) {
        self.state.enable(context);
    }

    /// Turn `context` off from the next tick; its actions let go without a release edge.
    pub fn disable(&self, context: ContextId) {
        self.state.disable(context);
    }

    /// The tick's touches no on-screen control took: what a game reading raw touches handles.
    pub fn free_touches(&self) -> impl Iterator<Item = &Touch> {
        self.free.iter()
    }

    /// The device in use with the family of the pad in use.
    fn device_with_family(&self) -> Device {
        match self.state.device() {
            Device::Pad(_) => Device::Pad(self.family),
            other => other,
        }
    }
}

/// The runtime's action state: the player's map, the evaluated actions and the bindings file.
#[derive(Debug, Default)]
pub(crate) struct State {
    actions: Actions,
    registered: bool,
    /// Why the player's bindings file was not (fully) applied.
    refusal: Option<InputError>,
    /// The digest of what the saves hold (or of the loaded map, before any write).
    saved: u64,
    /// A Studio run: key labels are ignored, so judged runs read the same prompts.
    studio: bool,
    /// The Controls panel's listen mode and prompt (display state).
    panel: ControlsPanel,
}

impl State {
    /// Before the first seed: take the game's map and the player's bindings from `saves`.
    pub(crate) fn install(&mut self, setup: &Setup, saves: &Saves, studio: bool) {
        let Some(map) = setup.map() else { return };
        self.registered = true;
        self.studio = studio;
        self.actions.map = map.clone();
        self.load(setup, saves);
    }

    /// The saves moved (a phone's data folder, a Studio run's `state/`): read the player's
    /// bindings from there instead.
    pub(crate) fn rebase(&mut self, setup: &Setup, saves: &Saves, studio: bool) {
        if !self.registered {
            return;
        }
        self.studio = studio;
        if studio {
            self.actions.labels = KeyLabels::new();
        }
        self.load(setup, saves);
    }

    /// The game's map with the player's file applied, all or nothing: a refused file leaves the
    /// defaults and is never rewritten.
    fn load(&mut self, setup: &Setup, saves: &Saves) {
        let Some(defaults) = setup.map() else { return };
        let mut map = defaults.clone();
        self.refusal = None;
        if let Some(bytes) = saves.load(BINDINGS_FILE) {
            match map.apply_blob(&bytes) {
                Ok(report) => self.refusal = report.problem(),
                Err(error) => {
                    map = defaults.clone();
                    self.refusal = Some(error);
                }
            }
        }
        self.saved = map.digest();
        self.actions.state = ActionState::new(&map);
        self.actions.map = map;
    }

    /// Whether `game.input` is registered.
    pub(crate) fn registered(&self) -> bool {
        self.registered
    }

    /// The player's map.
    pub(crate) fn map(&self) -> &ActionMap {
        &self.actions.map
    }

    /// Replace the player's map (a replay's recorded bindings), outside the simulation.
    pub(crate) fn set_map(&mut self, map: ActionMap) {
        // Not the player's choice: never written to their file.
        self.saved = map.digest();
        self.actions.map = map;
    }

    /// The evaluated actions (an input snapshot).
    pub(crate) fn action_state(&self) -> &ActionState {
        &self.actions.state
    }

    /// The pad family in use (an input snapshot).
    pub(crate) fn family(&self) -> PadFamily {
        self.actions.family
    }

    /// Replace the evaluated actions and the family in use (an input restore).
    pub(crate) fn restore(&mut self, state: ActionState, family: PadFamily) {
        self.actions.state = state;
        self.actions.family = family;
    }

    /// The keyboard layout's labels (display only; ignored in a Studio run).
    pub(crate) fn set_labels(&mut self, labels: KeyLabels) {
        if !self.studio {
            self.actions.labels = labels;
        }
    }

    /// Tick steps 4 and 5: track the pad family in use, then evaluate the map from the tick's
    /// merged input. `keys_taken` (a HUD widget holds the keyboard) leaves only the mouse buttons
    /// and no text; `touch` is each on-screen control's value; `free` the touches no control took.
    pub(crate) fn evaluate(&mut self, tick: &CoreTick, keys_taken: bool, touch: &[(ControlId, [f32; 2])], free: Vec<Touch>) {
        if !self.registered {
            return;
        }
        let actions = &mut self.actions;
        actions.family = track_family(actions.family, tick);
        let devices = Devices { family: actions.family, touch };
        if keys_taken {
            evaluate_with(&actions.map, &mut actions.state, &gated(tick), &devices);
        } else {
            evaluate_with(&actions.map, &mut actions.state, tick, &devices);
        }
        actions.free = free;
    }

    /// A new seed: every action lets go and toggles unlatch; the player's bindings stay.
    pub(crate) fn reset(&mut self, _setup: &Setup) {
        self.actions.state = ActionState::new(&self.actions.map);
        self.actions.family = PadFamily::Generic;
        self.actions.free.clear();
        self.panel = ControlsPanel::default();
    }

    /// After the UI hooks, outside the simulation: write the player's bindings when they changed.
    pub(crate) fn save_if_changed(&mut self, saves: &Saves) {
        if !self.registered {
            return;
        }
        let digest = self.actions.map.digest();
        if digest != self.saved && saves.save(BINDINGS_FILE, &self.actions.map.to_blob()) {
            self.saved = digest;
        }
    }

    /// The HUD's navigation for this tick while the `ui` context is on: the events of the `ui_*`
    /// actions that fired (they replace the raw navigation keys).
    pub(crate) fn hud_navigation(&self) -> Option<Vec<egui::Event>> {
        let on = self.registered && self.actions.is_on(UI);
        on.then(|| genex_hud::Hud::ui_action_events(|name| UiAction::ALL.iter().any(|action| self.ui_fired(*action, name))))
    }

    fn ui_fired(&self, action: ActionId, name: &str) -> bool {
        action.name().strip_prefix("ui_") == Some(name) && self.actions.fired(action)
    }

    /// While alive, [`controls_panel`] in this tick's UI hooks shows the player's map; `input` is
    /// the tick's merged input (what listen mode captures).
    pub(crate) fn enter_panel(&mut self, input: &CoreTick) -> Option<PanelScope> {
        if !self.registered {
            return None;
        }
        let shared = PanelShared {
            map: self.actions.map.clone(),
            input: input.clone(),
            labels: self.actions.labels.clone(),
            device: self.actions.device_with_family(),
            panel: std::mem::take(&mut self.panel),
            changes: Vec::new(),
        };
        let previous = PANEL.with_borrow_mut(|slot| slot.replace(shared));
        Some(PanelScope { previous: Some(previous) })
    }

    /// After the UI hooks: apply what the person changed in the panel to the player's map.
    pub(crate) fn leave_panel(&mut self, scope: Option<PanelScope>) {
        let Some(mut scope) = scope else { return };
        let Some(shared) = PANEL.with_borrow_mut(|slot| std::mem::replace(slot, scope.previous.take().flatten())) else {
            return;
        };
        self.panel = shared.panel;
        let map = &mut self.actions.map;
        for change in shared.changes {
            // A refused change leaves the map as it was; the panel already showed why.
            let _ = apply_change(map, change);
        }
    }

    /// `state().__input`, only while `game.input` is registered.
    pub(crate) fn runtime_key(&self, _setup: &Setup, state: &mut CoreValue) {
        if !self.registered {
            return;
        }
        state.set(RUNTIME_KEY, CoreValue::from(&self.runtime_value()));
    }

    fn runtime_value(&self) -> Value {
        let actions = &self.actions;
        let map = &actions.map;
        let contexts: Vec<&str> = map.contexts().filter(|id| actions.is_on(*id)).map(ContextId::name).collect();
        let down: Vec<&str> = map.actions().map(|(id, _)| id).filter(|id| actions.down(*id)).map(ActionId::name).collect();
        let mut hints = JsonMap::new();
        for (id, _) in map.actions() {
            let line = hint(map, id, actions.family, &actions.labels);
            if !line.is_empty() {
                hints.insert(id.name().to_owned(), Value::String(line));
            }
        }
        let refusal = self.refusal.as_ref().map_or(Value::Null, |error| json!({ "code": error.code.as_str(), "detail": error.detail }));
        json!({
            "bindings": hex64(map.digest()),
            "device": actions.device().as_str(),
            "family": actions.family.as_str(),
            "contexts": contexts,
            "down": down,
            "hints": hints,
            "refusal": refusal,
            "unknownReads": actions.state.unknown_reads(),
        })
    }

    /// The tick's evaluated actions, for `ctx.actions`.
    pub(crate) fn ctx(&self) -> &Actions {
        &self.actions
    }
}

/// One panel change on the player's map.
fn apply_change(map: &mut ActionMap, change: ControlsChange) -> Result<(), InputError> {
    match change {
        ControlsChange::Rebind(action, slot, binding) => map.rebind(action, slot, binding),
        ControlsChange::Swap(action, slot, binding) => map.rebind_swap(action, slot, binding).map(|_| ()),
        ControlsChange::Access(access) => map.set_access(access),
        ControlsChange::Reset => {
            map.reset();
            Ok(())
        }
        ControlsChange::Listen(..) | ControlsChange::Cancel => Ok(()),
    }
}

/// What the Controls panel shows during one tick's UI hooks, and what the person changed.
struct PanelShared {
    map: ActionMap,
    input: CoreTick,
    labels: KeyLabels,
    device: Device,
    panel: ControlsPanel,
    changes: Vec<ControlsChange>,
}

thread_local! {
    /// The panel the UI hooks of the running tick reach ([`controls_panel`]).
    static PANEL: RefCell<Option<PanelShared>> = const { RefCell::new(None) };
}

/// The runtime holds one around its UI hooks while `game.input` is registered.
pub(crate) struct PanelScope {
    previous: Option<Option<PanelShared>>,
}

impl Drop for PanelScope {
    fn drop(&mut self) {
        if let Some(previous) = self.previous.take() {
            PANEL.with_borrow_mut(|slot| *slot = previous);
        }
    }
}

/// The Controls panel in a UI hook: one row per game action with a button per binding ("Rebind
/// Jump"), listen mode, the conflict prompt, the accessibility settings and a reset. What the
/// person changes applies after the tick's UI hooks and is saved as `genex-input.json`; it never
/// enters the simulation's checksum. Shows nothing without `game.input`.
pub fn controls_panel(ui: &mut egui::Ui) {
    PANEL.with_borrow_mut(|slot| {
        let Some(shared) = slot.as_mut() else { return };
        let view = ControlsView::new(&shared.map, &shared.input, &shared.labels, shared.device);
        let changes = genex_input::panel::controls_panel(ui, &mut shared.panel, &view);
        shared.changes.extend(changes);
    });
}

/// The HUD's pressed keys with the navigation keys left out, while the `ui` actions drive it.
pub(crate) fn without_nav_keys(pressed: &[String]) -> Vec<String> {
    pressed.iter().filter(|code| !NAV_KEYS.contains(&code.as_str())).cloned().collect()
}

/// The tick as the update hooks see it while a HUD widget holds the keyboard: only the mouse
/// buttons, no text.
fn gated(tick: &CoreTick) -> CoreTick {
    let mouse = |list: &[String]| -> Vec<String> { list.iter().filter(|code| is_mouse(code)).cloned().collect() };
    let mut gated = tick.clone();
    gated.keys.assign(mouse(tick.keys.held()), mouse(tick.keys.pressed_keys()), mouse(tick.keys.released_keys()));
    gated.text.clear();
    gated
}

fn is_mouse(code: &str) -> bool {
    [Key::Mouse1, Key::Mouse2, Key::Mouse3].iter().any(|button| button.code() == code)
}

/// The family of the pad the player touched this tick (a button pressed or a stick past half
/// way), else the family last seen.
fn track_family(last: PadFamily, tick: &CoreTick) -> PadFamily {
    let pads = &tick.pads;
    let index = |at: usize| i32::try_from(at).unwrap_or(i32::MAX);
    let touched = |at: &usize| {
        let pad = &pads.states()[*at];
        let pressed = (0..PAD_BUTTONS as i32).any(|button| pads.pressed(index(*at), button));
        let moved = pad.axes.iter().any(|axis| axis.abs() > PAD_STICK_ACTIVE);
        pad.connected && (pressed || moved)
    };
    (0..pads.states().len()).find(touched).map_or(last, |at| pads.family(index(at)))
}
