//! The action state and `evaluate`: one tick of merged device input in, every action's value,
//! edges and firing out. `evaluate` is a pure function of the map, the previous state and the
//! tick (no clock, no hash order, libm math), so a replay of the same tick rows on any destination
//! gives the same state bit for bit.
//!
//! Per tick: queued context switches apply, then contexts run from the highest priority down. In
//! each context that is on, chords read first (longest first) and take their inputs from the
//! context's plain bindings; then every action reads its bindings, shapes the value with the
//! player's stick settings and its modifiers, decides whether it is down (hysteresis for buttons),
//! and steps its conditions. An action that is down takes the inputs it read away from lower
//! contexts unless its context passes them through. `BlockBy` vetoes last.
//!
//! Consume-when-actuated, priority order and pass-through follow bevy_enhanced_input
//! (<https://github.com/simgine/bevy_enhanced_input>, tag v0.27.0, commit
//! d7be47fd91184c1bb1ff1f5a40d073d36a18547e, MIT side of MIT OR Apache-2.0); the button
//! hysteresis defaults are bevy_input's and the stick dead zone Godot's (see `modifier`). No code
//! was copied: the evaluation is rewritten around ticks and genex-core's merged input.

use std::cell::RefCell;

use genex_core::input::{PAD_BUTTONS, PAD_PRESS_THRESHOLD, PadState, TickInput, TouchPhase};

use crate::access::{Access, HoldMode};
use crate::binding::{ActionKind, Binding, KeyCode, PadAxis, PadButton, PadFamily, Sign, Source, Stick};
use crate::condition::{ConditionMemory, Edge};
use crate::id::{ActionId, ContextId, ControlId};
use crate::map::{ActionDef, ActionMap, Context};
use crate::modifier::{Modifier, axial, radial};

/// The most distinct unknown action ids an action state lists (`__input.unknownReads`).
pub const UNKNOWN_READS_MAX: usize = 8;
/// How far a stick must move to count as the player picking up the pad.
const PAD_STICK_ACTIVE: f32 = 0.5;

/// The device the player used last, for prompts and `state().__input.device`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Device {
    /// Keyboard and mouse (`"keyboard"`).
    #[default]
    KeyboardMouse,
    /// A pad of a family (`"pad"`).
    Pad(PadFamily),
    /// The touch screen (`"touch"`).
    Touch,
}

impl Device {
    /// The wire spelling.
    pub const fn as_str(self) -> &'static str {
        match self {
            Device::KeyboardMouse => "keyboard",
            Device::Pad(_) => "pad",
            Device::Touch => "touch",
        }
    }
}

/// What `evaluate` reads besides the merged tick: the pad family (from the device tracker) and the
/// touch controls' values this tick (from the touch-control layer, IN-8).
#[derive(Clone, Copy, Debug, Default)]
pub struct Devices<'a> {
    /// The family of the pad in use; on Nintendo the `ui` context reads South and East swapped.
    pub family: PadFamily,
    /// Each touch control's value: a button as `[0..=1, 0]`, a stick as x and y.
    pub touch: &'a [(ControlId, [f32; 2])],
}

/// One action's state between ticks.
#[derive(Clone, Debug, Default, PartialEq)]
struct Slot {
    /// Down before the player's hold mode (the hysteresis latch).
    raw_down: bool,
    /// Down this tick.
    down: bool,
    /// Down on the previous tick.
    was_down: bool,
    /// Its conditions fired this tick.
    fired: bool,
    /// The shaped value.
    value: [f32; 2],
    /// Hold tick while down.
    held: u32,
    /// The player's toggle hold mode: latched down.
    hold_latch: bool,
    /// Per condition.
    memory: Vec<ConditionMemory>,
}

impl Slot {
    fn fresh(def: &ActionDef) -> Slot {
        Slot { memory: vec![ConditionMemory::default(); def.conditions.len()], ..Slot::default() }
    }
}

/// Every action's state, in the map's declaration order. Reads take an id; an id the map does not
/// declare reads false or 0 and is listed in [`ActionState::unknown_reads`].
#[derive(Clone, Debug, PartialEq)]
pub struct ActionState {
    ids: Vec<ActionId>,
    contexts: Vec<ContextId>,
    on: Vec<bool>,
    slots: Vec<Slot>,
    device: Device,
    ticks: u64,
    /// Context switches asked for during a tick, applied at the start of the next.
    requests: RefCell<Vec<(ContextId, bool)>>,
    unknown: RefCell<Vec<&'static str>>,
}

impl ActionState {
    /// The state before the first tick: nothing down, contexts on unless they start off.
    pub fn new(map: &ActionMap) -> ActionState {
        ActionState {
            ids: map.slots().map(|def| def.id).collect(),
            contexts: map.contexts.iter().map(|context| context.id).collect(),
            on: map.contexts.iter().map(|context| !context.starts_off).collect(),
            slots: map.slots().map(Slot::fresh).collect(),
            device: Device::default(),
            ticks: 0,
            requests: RefCell::new(Vec::new()),
            unknown: RefCell::new(Vec::new()),
        }
    }

    /// Whether `action` is down.
    pub fn down(&self, action: ActionId) -> bool {
        self.slot(action).is_some_and(|slot| slot.down)
    }

    /// Whether `action` went down on this tick.
    pub fn pressed(&self, action: ActionId) -> bool {
        self.slot(action).is_some_and(|slot| slot.down && !slot.was_down)
    }

    /// Whether `action` came up on this tick.
    pub fn released(&self, action: ActionId) -> bool {
        self.slot(action).is_some_and(|slot| !slot.down && slot.was_down)
    }

    /// Whether `action`'s conditions fired on this tick (with none, whether it is down).
    pub fn fired(&self, action: ActionId) -> bool {
        self.slot(action).is_some_and(|slot| slot.fired)
    }

    /// The value of a button or 1D axis (a 2D axis answers its x).
    pub fn value(&self, action: ActionId) -> f32 {
        self.slot(action).map_or(0.0, |slot| slot.value[0])
    }

    /// The value of a 2D axis, x right and y down.
    pub fn axis2(&self, action: ActionId) -> [f32; 2] {
        self.slot(action).map_or([0.0, 0.0], |slot| slot.value)
    }

    /// Ticks since `action` went down (0 on that tick, and while it is up).
    pub fn held_ticks(&self, action: ActionId) -> u32 {
        self.slot(action).map_or(0, |slot| slot.held)
    }

    /// The device the player used last.
    pub fn device(&self) -> Device {
        self.device
    }

    /// Ticks evaluated so far.
    pub fn ticks(&self) -> u64 {
        self.ticks
    }

    /// Whether `context` is on this tick.
    pub fn is_on(&self, context: ContextId) -> bool {
        self.contexts.iter().position(|id| *id == context).is_some_and(|at| self.on[at])
    }

    /// Turn `context` on from the next tick.
    pub fn enable(&self, context: ContextId) {
        self.request(context, true);
    }

    /// Turn `context` off from the next tick; its actions reset (no release edge).
    pub fn disable(&self, context: ContextId) {
        self.request(context, false);
    }

    /// The action ids read that the map does not declare, first read first, at most
    /// [`UNKNOWN_READS_MAX`].
    pub fn unknown_reads(&self) -> Vec<&'static str> {
        self.unknown.borrow().clone()
    }

    fn request(&self, context: ContextId, on: bool) {
        let mut requests = self.requests.borrow_mut();
        match requests.iter_mut().find(|(id, _)| *id == context) {
            Some(request) => request.1 = on,
            None => requests.push((context, on)),
        }
    }

    fn slot(&self, action: ActionId) -> Option<&Slot> {
        let found = self.ids.iter().position(|id| *id == action).map(|at| &self.slots[at]);
        if found.is_none() {
            self.note_unknown(action);
        }
        found
    }

    fn note_unknown(&self, action: ActionId) {
        let mut unknown = self.unknown.borrow_mut();
        if unknown.len() < UNKNOWN_READS_MAX && !unknown.contains(&action.name()) {
            unknown.push(action.name());
        }
    }

    fn matches(&self, map: &ActionMap) -> bool {
        self.ids.iter().copied().eq(map.slots().map(|def| def.id))
            && self.contexts.iter().copied().eq(map.contexts.iter().map(|context| context.id))
    }

    fn apply_requests(&mut self) {
        let requests = std::mem::take(self.requests.get_mut());
        for (context, on) in requests {
            if let Some(at) = self.contexts.iter().position(|id| *id == context) {
                self.on[at] = on;
            }
        }
    }
}

/// Evaluate one tick with no pad family and no touch controls.
pub fn evaluate(map: &ActionMap, state: &mut ActionState, tick: &TickInput) {
    evaluate_with(map, state, tick, &Devices::default());
}

/// Evaluate one tick: `state` moves from the previous tick to this one. A state built for another
/// map is rebuilt first.
pub fn evaluate_with(map: &ActionMap, state: &mut ActionState, tick: &TickInput, devices: &Devices<'_>) {
    if !state.matches(map) {
        *state = ActionState::new(map);
    }
    state.apply_requests();
    let pad = merged_pad(tick);
    let mut reader = Reader { tick, pad, access: &map.access, devices, swap_face: false, consumed: Vec::new() };
    let offsets = slot_offsets(map);
    let mut own_fired = vec![false; state.slots.len()];
    for at in map.priority_order() {
        let context = &map.contexts[at];
        let range = offsets[at]..offsets[at] + context.actions.len();
        if !state.on[at] {
            for (slot, def) in state.slots[range].iter_mut().zip(&context.actions) {
                *slot = Slot::fresh(def);
            }
            continue;
        }
        reader.swap_face = context.family_confirm && devices.family == PadFamily::Nintendo;
        let taken = run_context(context, &mut state.slots[range.clone()], &mut own_fired[range], &reader);
        if !context.pass_through {
            reader.consumed.extend(taken);
        }
    }
    apply_blockers(map, state, &own_fired);
    state.device = track_device(state.device, tick, devices.family);
    state.ticks += 1;
}

/// The first slot index of each context.
fn slot_offsets(map: &ActionMap) -> Vec<usize> {
    let mut next = 0;
    map.contexts
        .iter()
        .map(|context| {
            let at = next;
            next += context.actions.len();
            at
        })
        .collect()
}

/// One context's actions; answers the physical inputs its down actions read.
fn run_context(context: &Context, slots: &mut [Slot], fired: &mut [bool], reader: &Reader<'_>) -> Vec<Source> {
    let (chord_values, chord_taken) = read_chords(context, reader);
    let local = Reader { consumed: [reader.consumed.as_slice(), &chord_taken].concat(), ..reader.clone() };
    let mut taken = chord_taken;
    for (index, (def, slot)) in context.actions.iter().zip(slots.iter_mut()).enumerate() {
        let (best, read) = read_action(def, chord_values[index], &local);
        let value = def.modifiers.iter().fold(best, |value, modifier| modifier.apply(value));
        fired[index] = step_slot(def, slot, value, reader.access);
        if slot.down {
            taken.extend(read);
        }
    }
    taken
}

/// An action's strongest binding value (its chord value counts as a button press) and the
/// physical inputs of every binding that read something.
fn read_action(def: &ActionDef, chord_value: f32, reader: &Reader<'_>) -> ([f32; 2], Vec<Source>) {
    let has_dead_zone = def.modifiers.iter().any(|modifier| matches!(modifier, Modifier::DeadZone { .. }));
    let mut best = [chord_value, 0.0];
    let mut read = Vec::new();
    for binding in def.bindings.iter().filter(|binding| !matches!(binding, Binding::Chord(_))) {
        let value = reader.binding(binding, def.kind, has_dead_zone);
        let strength = magnitude(value, def.kind);
        if strength > 0.0 {
            read.extend(binding.sources().into_iter().map(|source| reader.physical(source)));
        }
        // Strictly stronger: the first binding wins a tie.
        if strength > magnitude(best, def.kind) {
            best = value;
        }
    }
    (best, read)
}

/// Each action's chord value (1 when one of its chords is held) and the inputs the held chords
/// take. Longer chords read first, so Shift+Ctrl+E takes its keys before Shift+E can.
fn read_chords(context: &Context, reader: &Reader<'_>) -> (Vec<f32>, Vec<Source>) {
    let mut chords: Vec<(usize, &Binding)> = Vec::new();
    for (index, def) in context.actions.iter().enumerate() {
        let is_chord = |binding: &&Binding| def.kind == ActionKind::Button && matches!(binding, Binding::Chord(_));
        chords.extend(def.bindings.iter().filter(is_chord).map(|binding| (index, binding)));
    }
    // Stable: equal lengths keep declaration order.
    chords.sort_by_key(|(_, binding)| std::cmp::Reverse(binding.chord_inputs().len()));
    let mut values = vec![0.0; context.actions.len()];
    let mut taken: Vec<Source> = Vec::new();
    for (index, binding) in chords {
        let sources: Vec<Source> = binding.sources().into_iter().map(|source| reader.physical(source)).collect();
        let free = sources.iter().all(|source| !taken.contains(source));
        if free && sources.iter().all(|source| reader.held(*source)) {
            values[index] = 1.0;
            taken.extend(sources);
        }
    }
    (values, taken)
}

/// Down, edges, hold count and conditions for one action; answers whether its own conditions
/// fired (before `BlockBy`).
fn step_slot(def: &ActionDef, slot: &mut Slot, value: [f32; 2], access: &Access) -> bool {
    let was_raw = slot.raw_down;
    slot.value = value;
    slot.raw_down = actuated(def, was_raw, value, access);
    let toggled = def.kind == ActionKind::Button && access.mode(def.id) == HoldMode::Toggle;
    if toggled && slot.raw_down && !was_raw {
        slot.hold_latch = !slot.hold_latch;
    }
    let was_down = slot.down;
    let down = if toggled { slot.hold_latch } else { slot.raw_down };
    let press_ticks = if was_down { slot.held.saturating_add(1) } else { 0 };
    slot.held = if down && was_down { slot.held.saturating_add(1) } else { 0 };
    slot.was_down = was_down;
    slot.down = down;
    let edge = Edge { down, was_down, held: slot.held, press_ticks, slow_percent: access.slow_press_percent };
    let mut fired = down;
    if !def.conditions.is_empty() {
        fired = true;
        for (condition, memory) in def.conditions.iter().zip(slot.memory.iter_mut()) {
            // `&=` evaluates every step, so each condition's memory stays current.
            fired &= condition.step(edge, memory);
        }
    }
    slot.fired = fired;
    fired
}

/// Whether the shaped value holds the action down: buttons and actions with a hysteresis modifier
/// use press and release thresholds, other axes any non-zero value.
fn actuated(def: &ActionDef, was: bool, value: [f32; 2], access: &Access) -> bool {
    let own = def.modifiers.iter().rev().find_map(|modifier| match *modifier {
        Modifier::Hysteresis { press, release } => Some((press, release)),
        _ => None,
    });
    let thresholds = match (own, def.kind) {
        (Some(pair), _) => Some(pair),
        (None, ActionKind::Button) => Some((access.trigger_press, access.trigger_release)),
        (None, _) => None,
    };
    let amount = match def.kind {
        ActionKind::Axis2 => libm::sqrtf(magnitude(value, def.kind)),
        ActionKind::Button | ActionKind::Axis1 => magnitude(value, def.kind),
    };
    match thresholds {
        Some((_, release)) if was => amount > release,
        Some((press, _)) => amount >= press,
        None => amount > 0.0,
    }
}

/// Applies `BlockBy`: an action never fires on a tick its blocker's own conditions fired.
fn apply_blockers(map: &ActionMap, state: &mut ActionState, own_fired: &[bool]) {
    for (at, def) in map.slots().enumerate() {
        let blocked = def
            .conditions
            .iter()
            .filter_map(|condition| condition.blocker())
            .filter_map(|blocker| state.ids.iter().position(|id| *id == blocker))
            .any(|blocker| own_fired[blocker]);
        if blocked {
            state.slots[at].fired = false;
        }
    }
}

/// The device the player touched this tick, else the last one.
fn track_device(last: Device, tick: &TickInput, family: PadFamily) -> Device {
    let touched = tick.touches.iter().any(|touch| matches!(touch.phase, TouchPhase::Began | TouchPhase::Tapped));
    if touched {
        return Device::Touch;
    }
    let pads = &tick.pads;
    let buttons = 0..PAD_BUTTONS as i32;
    let pad_button = (0..pads.states().len() as i32).any(|pad| buttons.clone().any(|button| pads.pressed(pad, button)));
    let stick_moved = |pad: &PadState| pad.connected && pad.axes.iter().any(|axis| axis.abs() > PAD_STICK_ACTIVE);
    if pad_button || pads.states().iter().any(stick_moved) {
        return Device::Pad(family);
    }
    let moved = |delta: genex_core::input::Vec2| delta.x != 0.0 || delta.y != 0.0;
    let keyboard = !tick.keys.pressed_keys().is_empty() || moved(tick.look) || moved(tick.wheel);
    if keyboard { Device::KeyboardMouse } else { last }
}

/// Every connected pad as one: each button at its largest value, each axis at its largest
/// magnitude (the first pad wins a tie), so any pad drives a single-player game.
fn merged_pad(tick: &TickInput) -> PadState {
    let mut merged = PadState::default();
    for pad in tick.pads.states().iter().filter(|pad| pad.connected) {
        merged.connected = true;
        for (out, value) in merged.buttons.iter_mut().zip(&pad.buttons) {
            if *value > *out {
                *out = *value;
            }
        }
        for (out, value) in merged.axes.iter_mut().zip(&pad.axes) {
            if value.abs() > out.abs() {
                *out = *value;
            }
        }
    }
    merged
}

/// How strong a value is for an action of `kind`: a button or 1D axis by |x|, a 2D axis by its
/// squared length.
fn magnitude(value: [f32; 2], kind: ActionKind) -> f32 {
    match kind {
        ActionKind::Axis2 => value[0] * value[0] + value[1] * value[1],
        ActionKind::Button | ActionKind::Axis1 => value[0].abs(),
    }
}

/// Reads bindings against one tick, with the inputs higher contexts took read as nothing.
#[derive(Clone)]
struct Reader<'a> {
    tick: &'a TickInput,
    pad: PadState,
    access: &'a Access,
    devices: &'a Devices<'a>,
    /// This context reads South and East swapped (the `ui` context on a Nintendo pad).
    swap_face: bool,
    consumed: Vec<Source>,
}

impl Reader<'_> {
    /// The physical input a logical one reads: sticks swapped by the player, face buttons by the
    /// pad family.
    fn physical(&self, source: Source) -> Source {
        match source {
            Source::Half(axis, sign) if self.access.swap_sticks => Source::Half(swapped_axis(axis), sign),
            Source::Button(PadButton::South) if self.swap_face => Source::Button(PadButton::East),
            Source::Button(PadButton::East) if self.swap_face => Source::Button(PadButton::South),
            other => other,
        }
    }

    fn free(&self, source: Source) -> bool {
        !self.consumed.contains(&source)
    }

    /// A physical input's value, 0 when a higher context took it.
    fn source_value(&self, source: Source) -> f32 {
        if !self.free(source) {
            return 0.0;
        }
        match source {
            Source::Key(key) => key_value(self.tick, key),
            Source::Button(button) => self.pad.buttons[button.index()],
            Source::Half(axis, sign) => (self.pad.axes[axis.index()] * sign.factor()).max(0.0),
            Source::Look => self.tick.look.x,
            Source::Wheel => self.tick.wheel.y,
            Source::Touch(control) => self.touch(control)[0],
        }
    }

    /// Whether a physical input is held, for chords.
    fn held(&self, source: Source) -> bool {
        match source {
            Source::Button(_) => self.source_value(source) > PAD_PRESS_THRESHOLD,
            _ => self.source_value(source) > 0.0,
        }
    }

    fn key(&self, key: KeyCode) -> f32 {
        self.source_value(Source::Key(key))
    }

    fn button(&self, button: PadButton) -> f32 {
        self.source_value(self.physical(Source::Button(button)))
    }

    /// A logical axis: read from the physical stick the player picked, y flipped when inverted.
    fn axis(&self, axis: PadAxis) -> f32 {
        let half = |sign: Sign| self.source_value(self.physical(Source::Half(axis, sign)));
        let value = half(Sign::Positive) - half(Sign::Negative);
        let is_y = matches!(axis, PadAxis::LeftY | PadAxis::RightY);
        let inverted = is_y && self.access.invert_y[axis.stick().slot()];
        if inverted { -value } else { value }
    }

    fn touch(&self, control: ControlId) -> [f32; 2] {
        if !self.free(Source::Touch(control)) {
            return [0.0, 0.0];
        }
        self.devices.touch.iter().find(|(id, _)| *id == control).map_or([0.0, 0.0], |(_, value)| *value)
    }

    /// The dead zone of the physical stick a logical stick reads (drift belongs to the hardware).
    fn zone(&self, stick: Stick) -> f32 {
        let physical = if self.access.swap_sticks { stick.other() } else { stick };
        self.access.stick_dead_zone[physical.slot()]
    }

    /// One binding's value for an action of `kind`; sticks and half axes of axis actions get the
    /// player's dead zone unless the action names its own (a button's dead zone is its hysteresis).
    fn binding(&self, binding: &Binding, kind: ActionKind, has_dead_zone: bool) -> [f32; 2] {
        let default_zone = !has_dead_zone && kind != ActionKind::Button;
        match *binding {
            Binding::Key(key) => [self.key(key), 0.0],
            Binding::Pad(button) => [self.button(button), 0.0],
            Binding::PadAxis(axis, sign) => {
                let half = (self.axis(axis) * sign.factor()).max(0.0);
                let shaped = if default_zone { axial(half, self.zone(axis.stick()), 1.0) } else { half };
                [shaped, 0.0]
            }
            Binding::Stick(stick) => {
                let (x, y) = stick.axes();
                let raw = [self.axis(x), self.axis(y)];
                if default_zone { radial(raw, self.zone(stick), 1.0) } else { raw }
            }
            Binding::Keys2 { negative, positive } => [self.key(positive) - self.key(negative), 0.0],
            Binding::Keys4 { up, down, left, right } => {
                unit_clamped([self.key(right) - self.key(left), self.key(down) - self.key(up)])
            }
            Binding::Dpad => {
                let x = self.button(PadButton::DpadRight) - self.button(PadButton::DpadLeft);
                let y = self.button(PadButton::DpadDown) - self.button(PadButton::DpadUp);
                unit_clamped([x, y])
            }
            Binding::Touch(control) => self.touch(control),
            Binding::Look if self.free(Source::Look) => [self.tick.look.x, self.tick.look.y],
            Binding::Wheel => [self.source_value(Source::Wheel), 0.0],
            // Chords read in their own pass; a taken look reads nothing.
            Binding::Look | Binding::Chord(_) => [0.0, 0.0],
        }
    }
}

/// A key's value: 1 while held or on the tick of a tap (pressed and released before the tick).
fn key_value(tick: &TickInput, key: KeyCode) -> f32 {
    let name = key.as_str();
    f32::from(u8::from(tick.keys.down(name) || tick.keys.pressed(name)))
}

/// A vector longer than 1 scaled to length 1 (diagonals of keys and the d-pad).
fn unit_clamped(value: [f32; 2]) -> [f32; 2] {
    let [x, y] = value;
    let length = libm::sqrtf(x * x + y * y);
    if length > 1.0 { [x / length, y / length] } else { value }
}

fn swapped_axis(axis: PadAxis) -> PadAxis {
    match axis {
        PadAxis::LeftX => PadAxis::RightX,
        PadAxis::LeftY => PadAxis::RightY,
        PadAxis::RightX => PadAxis::LeftX,
        PadAxis::RightY => PadAxis::LeftY,
    }
}

/// The format tag of an action state snapshot (a save's `input` section, IN-12).
pub const ACTIONS_SNAPSHOT_FORMAT: &str = "genex-actions/1";

impl ActionState {
    /// The state between ticks as JSON, for an input snapshot: the contexts on, the context
    /// switches queued for the next tick, each action's latches, value (f32 exact), hold ticks and
    /// condition memory, the device and the ticks evaluated. Unknown reads are display only and
    /// left out.
    pub fn snapshot(&self) -> serde_json::Value {
        let slots: Vec<serde_json::Value> = self
            .ids
            .iter()
            .zip(&self.slots)
            .map(|(id, slot)| {
                let memory: Vec<serde_json::Value> = slot.memory.iter().map(|memory| serde_json::json!([memory.latch, memory.wait])).collect();
                serde_json::json!({
                    "id": id.name(),
                    "raw": slot.raw_down,
                    "down": slot.down,
                    "was": slot.was_down,
                    "fired": slot.fired,
                    "value": [slot.value[0], slot.value[1]],
                    "held": slot.held,
                    "latch": slot.hold_latch,
                    "memory": memory,
                })
            })
            .collect();
        let requests: Vec<serde_json::Value> = self.requests.borrow().iter().map(|(id, on)| serde_json::json!([id.name(), on])).collect();
        let family = match self.device {
            Device::Pad(family) => family.as_str(),
            Device::KeyboardMouse | Device::Touch => PadFamily::Generic.as_str(),
        };
        serde_json::json!({
            "format": ACTIONS_SNAPSHOT_FORMAT,
            "on": self.on,
            "requests": requests,
            "slots": slots,
            "device": self.device.as_str(),
            "family": family,
            "ticks": self.ticks,
        })
    }

    /// The state a [`ActionState::snapshot`] of the same map saved. All or nothing: a snapshot of
    /// another map refuses `input-track-mismatch`, a malformed one `input-track-invalid`.
    pub fn restore(map: &ActionMap, snapshot: &serde_json::Value) -> Result<ActionState, crate::error::InputError> {
        use crate::error::{InputError, InputErrorCode};
        let invalid = |detail: &str| InputError::new(InputErrorCode::TrackInvalid, format!("action snapshot: {detail}"));
        if snapshot["format"].as_str() != Some(ACTIONS_SNAPSHOT_FORMAT) {
            return Err(invalid("not a genex-actions/1 snapshot"));
        }
        let mut state = ActionState::new(map);
        let on = snapshot["on"].as_array().ok_or_else(|| invalid("no contexts"))?;
        let slots = snapshot["slots"].as_array().ok_or_else(|| invalid("no actions"))?;
        let same_ids = slots.iter().map(|row| row["id"].as_str()).eq(state.ids.iter().map(|id| Some(id.name())));
        if on.len() != state.on.len() || !same_ids {
            return Err(InputError::new(InputErrorCode::TrackMismatch, "the snapshot was taken with another action map"));
        }
        for (at, value) in on.iter().enumerate() {
            state.on[at] = value.as_bool().ok_or_else(|| invalid("a context that is not true or false"))?;
        }
        for (slot, row) in state.slots.iter_mut().zip(slots) {
            restore_slot(slot, row).ok_or_else(|| invalid("an action row that cannot be read"))?;
        }
        let requests = snapshot["requests"].as_array().ok_or_else(|| invalid("no context switches"))?;
        for request in requests {
            let name = request[0].as_str().ok_or_else(|| invalid("a context switch without a context"))?;
            let on = request[1].as_bool().ok_or_else(|| invalid("a context switch without on or off"))?;
            let context = state.contexts.iter().copied().find(|id| id.name() == name).ok_or_else(|| invalid("a switch of an unknown context"))?;
            state.request(context, on);
        }
        let family = snapshot["family"].as_str().and_then(PadFamily::from_wire).ok_or_else(|| invalid("an unknown pad family"))?;
        state.device = match snapshot["device"].as_str() {
            Some("keyboard") => Device::KeyboardMouse,
            Some("pad") => Device::Pad(family),
            Some("touch") => Device::Touch,
            _ => return Err(invalid("an unknown device")),
        };
        state.ticks = snapshot["ticks"].as_u64().ok_or_else(|| invalid("no tick count"))?;
        Ok(state)
    }
}

/// One action row of a snapshot into `slot`; `None` when a field is missing or malformed.
fn restore_slot(slot: &mut Slot, row: &serde_json::Value) -> Option<()> {
    let float = |value: &serde_json::Value| -> Option<f32> {
        let wide = value.as_f64()?;
        // An f32 survives JSON exactly; anything that does not narrow back exactly was edited.
        let narrow = wide as f32;
        (narrow.is_finite() && f64::from(narrow) == wide).then_some(narrow)
    };
    let memory = row["memory"].as_array()?;
    if memory.len() != slot.memory.len() {
        return None;
    }
    for (into, value) in slot.memory.iter_mut().zip(memory) {
        into.latch = value[0].as_bool()?;
        into.wait = u16::try_from(value[1].as_u64()?).ok()?;
    }
    slot.raw_down = row["raw"].as_bool()?;
    slot.down = row["down"].as_bool()?;
    slot.was_down = row["was"].as_bool()?;
    slot.fired = row["fired"].as_bool()?;
    slot.value = [float(&row["value"][0])?, float(&row["value"][1])?];
    slot.held = u32::try_from(row["held"].as_u64()?).ok()?;
    slot.hold_latch = row["latch"].as_bool()?;
    Some(())
}
