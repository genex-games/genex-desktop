//! On-screen touch controls (G6 input, IN-8): sticks (fixed or floating), buttons and a d-pad laid
//! out in world pixels, turned into control values inside the tick from the merged touches, so
//! studio `touch` injection, desktop Mouse1 (touch 0) and replays drive them exactly as a phone
//! does. Game code reads actions: a control feeds `Binding::Touch(control)` and, when the layout
//! names a pad target, a virtual pad slot, so one path reads a pad and the screen alike.
//!
//! Rules (kept from the genex-demo touch joystick, an ecctrl port, and the ideas of
//! virtual_joystick and bevy_touch_stick; no code taken):
//! - one finger per control, one control per finger: a second finger starting in a held control's
//!   zone is ignored and stays free for the game, and a finger never presses another control by
//!   sliding onto it;
//! - only a finger that begins inside a zone takes the control;
//! - an end, or a finger missing from the tick (lost), resets the control on that tick;
//! - a floating stick's base sits where its finger lands inside a zone twice its radius;
//! - evaluation never depends on whether the controls are shown ([`ShowWhen`] is display only).
//!
//! Pure like the action evaluation: no clock, no hash order, libm math, so a replay of the same
//! touch rows gives the same values on every destination.

use genex_core::input::{PadState, TickInput, TouchPhase, TouchPoint};
use serde_json::{Map, Value, json};

use crate::binding::{ActionKind, Binding, PadButton, Stick};
use crate::error::{InputError, InputErrorCode};
use crate::id::{ControlId, name_ok};
use crate::map::ActionMap;
use crate::state::Device;

/// The most controls one layout holds.
pub const TOUCH_CONTROLS_MAX: usize = 12;
/// The longest button label, in bytes (labels are AccessKit names and painted text).
pub const TOUCH_LABEL_MAX: usize = 32;
/// A floating stick's zone, as a multiple of its radius (half the zone's side).
pub const FLOATING_ZONE_SCALE: f32 = 2.0;
/// How far from a d-pad's centre a direction reads, as a fraction of half its side.
pub const DPAD_DEAD_ZONE: f32 = 1.0 / 3.0;
/// The spelling of a touch snapshot's format.
pub const TOUCH_SNAPSHOT_FORMAT: &str = "genex-touch/1";

/// Where a control's centre sits: an offset in world pixels from a world corner, or a point.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Anchor {
    /// `[right, up]` from the bottom-left corner.
    BottomLeft([f32; 2]),
    /// `[left, up]` from the bottom-right corner.
    BottomRight([f32; 2]),
    /// `[right, down]` from the top-left corner.
    TopLeft([f32; 2]),
    /// `[left, down]` from the top-right corner.
    TopRight([f32; 2]),
    /// A world point, y down.
    At([f32; 2]),
}

impl Anchor {
    /// The centre in a world of `world` pixels, y down.
    pub fn resolve(self, world: [f32; 2]) -> [f32; 2] {
        let [w, h] = world;
        match self {
            Anchor::BottomLeft([x, y]) => [x, h - y],
            Anchor::BottomRight([x, y]) => [w - x, h - y],
            Anchor::TopLeft([x, y]) => [x, y],
            Anchor::TopRight([x, y]) => [w - x, y],
            Anchor::At(point) => point,
        }
    }

    fn offset(self) -> [f32; 2] {
        match self {
            Anchor::BottomLeft(at) | Anchor::BottomRight(at) | Anchor::TopLeft(at) | Anchor::TopRight(at) | Anchor::At(at) => at,
        }
    }
}

/// How a stick's base behaves.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StickMode {
    /// The base stays at the anchor; a finger must land on it.
    Fixed,
    /// The base moves to where the finger lands inside the stick's zone.
    Floating,
}

/// When the painter shows the controls. Display only: evaluation is the same either way.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ShowWhen {
    /// While the player's last device is the touch screen.
    #[default]
    Touch,
    /// Always.
    Always,
    /// Never (the controls still work, for a game that paints its own).
    Never,
}

/// What a control is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ControlKind {
    /// A stick: a 2D value of length at most 1, x right and y down.
    Stick(StickMode),
    /// A button: `[1, 0]` while held.
    Button,
    /// A d-pad: one of eight unit directions, or 0 in its dead centre.
    Dpad,
}

/// The virtual pad input a control drives.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PadTarget {
    /// A stick control drives a pad stick.
    Stick(Stick),
    /// A button control drives a pad button.
    Button(PadButton),
    /// A d-pad control drives the pad's d-pad buttons.
    Dpad,
}

/// One control as a layout holds it.
#[derive(Clone, Debug, PartialEq)]
pub struct Control {
    /// Its id, which `Binding::Touch` names.
    pub id: ControlId,
    /// What it is.
    pub kind: ControlKind,
    /// Its AccessKit label and painted text (a stick or d-pad is labelled by its id).
    pub label: String,
    /// Where its centre sits.
    pub at: Anchor,
    /// Its radius (a d-pad: half its side), in world pixels.
    pub radius: f32,
    /// The virtual pad input it drives, if any.
    pub pad: Option<PadTarget>,
}

impl Control {
    /// Its centre in a world of `world` pixels.
    pub fn centre(&self, world: [u32; 2]) -> [f32; 2] {
        self.at.resolve(world_f32(world))
    }

    /// Its zone, `[min x, min y, max x, max y]` in world pixels: where a finger may begin on it,
    /// the painter's box and its AccessKit rect.
    pub fn zone(&self, world: [u32; 2]) -> [f32; 4] {
        let [x, y] = self.centre(world);
        let half = self.half_side();
        [x - half, y - half, x + half, y + half]
    }

    fn half_side(&self) -> f32 {
        match self.kind {
            ControlKind::Stick(StickMode::Floating) => self.radius * FLOATING_ZONE_SCALE,
            ControlKind::Stick(StickMode::Fixed) | ControlKind::Button | ControlKind::Dpad => self.radius,
        }
    }

    /// Whether a finger beginning at `point` takes this control: inside the circle of a fixed
    /// stick or a button, inside the box of a floating stick or a d-pad.
    fn hit(&self, world: [u32; 2], point: [f32; 2]) -> bool {
        let [min_x, min_y, max_x, max_y] = self.zone(world);
        let in_box = point[0] >= min_x && point[0] <= max_x && point[1] >= min_y && point[1] <= max_y;
        match self.kind {
            ControlKind::Stick(StickMode::Fixed) | ControlKind::Button => {
                let [dx, dy] = minus(point, self.centre(world));
                dx * dx + dy * dy <= self.radius * self.radius
            }
            ControlKind::Stick(StickMode::Floating) | ControlKind::Dpad => in_box,
        }
    }

    fn fits(&self, target: PadTarget) -> bool {
        matches!(
            (self.kind, target),
            (ControlKind::Stick(_), PadTarget::Stick(_))
                | (ControlKind::Button, PadTarget::Button(_))
                | (ControlKind::Dpad, PadTarget::Dpad)
        )
    }
}

/// A layout of on-screen controls:
/// `TouchControls::new().stick(MOVE, Anchor::BottomLeft([160.0, 160.0]), 80.0, StickMode::Floating)`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TouchControls {
    controls: Vec<Control>,
    show: ShowWhen,
    /// The first builder call that had no control to apply to.
    misuse: Option<InputError>,
}

impl TouchControls {
    /// No controls, shown after a touch.
    pub fn new() -> TouchControls {
        TouchControls::default()
    }

    /// A stick of `radius` world pixels.
    #[must_use]
    pub fn stick(self, id: ControlId, at: Anchor, radius: f32, mode: StickMode) -> TouchControls {
        self.with(Control { id, kind: ControlKind::Stick(mode), label: id.name().to_owned(), at, radius, pad: None })
    }

    /// A round button of `radius` world pixels, labelled `label`.
    #[must_use]
    pub fn button(self, id: ControlId, label: &str, at: Anchor, radius: f32) -> TouchControls {
        self.with(Control { id, kind: ControlKind::Button, label: label.to_owned(), at, radius, pad: None })
    }

    /// A square d-pad `size` world pixels wide.
    #[must_use]
    pub fn dpad(self, id: ControlId, at: Anchor, size: f32) -> TouchControls {
        self.with(Control { id, kind: ControlKind::Dpad, label: id.name().to_owned(), at, radius: size / 2.0, pad: None })
    }

    /// The last control also drives `target` on the virtual pad.
    #[must_use]
    pub fn on_pad(mut self, target: PadTarget) -> TouchControls {
        match self.controls.last_mut() {
            Some(control) => control.pad = Some(target),
            None => self.note_misuse("on_pad names no control: declare a stick, button or d-pad first"),
        }
        self
    }

    /// When the painter shows the controls.
    #[must_use]
    pub fn show(self, when: ShowWhen) -> TouchControls {
        TouchControls { show: when, ..self }
    }

    /// The controls, in declaration order.
    pub fn controls(&self) -> &[Control] {
        &self.controls
    }

    /// When the painter shows the controls.
    pub fn show_when(&self) -> ShowWhen {
        self.show
    }

    /// Whether the painter shows the controls while `device` is the player's last device.
    pub fn visible(&self, device: Device) -> bool {
        match self.show {
            ShowWhen::Touch => device == Device::Touch,
            ShowWhen::Always => true,
            ShowWhen::Never => false,
        }
    }

    /// Whether any control drives the virtual pad.
    pub fn has_virtual_pad(&self) -> bool {
        self.controls.iter().any(|control| control.pad.is_some())
    }

    /// Check the layout against a world of `world` pixels: at most [`TOUCH_CONTROLS_MAX`] controls
    /// with legal, distinct ids and labels, finite positive sizes, zones inside the world that do
    /// not overlap, and pad targets that fit their control and are not shared.
    pub fn validate(&self, world: [u32; 2]) -> Result<(), InputError> {
        if let Some(misuse) = &self.misuse {
            return Err(misuse.clone());
        }
        if world[0] == 0 || world[1] == 0 {
            return Err(invalid(format!("the world is {}x{} pixels", world[0], world[1])));
        }
        if self.controls.len() > TOUCH_CONTROLS_MAX {
            return Err(invalid(format!("{} controls, at most {TOUCH_CONTROLS_MAX}", self.controls.len())));
        }
        for (at, control) in self.controls.iter().enumerate() {
            check_control(control, world)?;
            check_against_earlier(control, &self.controls[..at], world)?;
        }
        Ok(())
    }

    /// Check a map's touch bindings against the layout: each names a declared control, a stick
    /// or d-pad drives an axis action and a button a button or 1D axis action.
    pub fn check_bindings(&self, map: &ActionMap) -> Result<(), InputError> {
        for def in map.slots() {
            for binding in &def.bindings {
                let Binding::Touch(id) = binding else { continue };
                let Some(control) = self.control(*id) else {
                    let detail = format!("{} reads touch control {}, which the layout does not declare", def.id.name(), id.name());
                    return Err(invalid(detail));
                };
                if !kind_fits(control.kind, def.kind) {
                    let detail = format!("touch control {} cannot drive {} ({})", id.name(), def.id.name(), def.kind.as_str());
                    return Err(InputError::new(InputErrorCode::BindingMismatch, detail));
                }
            }
        }
        Ok(())
    }

    fn control(&self, id: ControlId) -> Option<&Control> {
        self.controls.iter().find(|control| control.id == id)
    }

    fn with(mut self, control: Control) -> TouchControls {
        self.controls.push(control);
        self
    }

    fn note_misuse(&mut self, detail: &str) {
        if self.misuse.is_none() {
            self.misuse = Some(invalid(detail));
        }
    }
}

/// One control's own checks: id, label, finite positive size, zone inside the world, pad target.
fn check_control(control: &Control, world: [u32; 2]) -> Result<(), InputError> {
    let name = control.id.name();
    if !name_ok(name) {
        return Err(invalid(format!("control id {name:?} is not 1 to 32 lowercase letters, digits or _")));
    }
    let label_ok = !control.label.is_empty()
        && control.label.len() <= TOUCH_LABEL_MAX
        && !control.label.chars().any(char::is_control);
    if !label_ok {
        return Err(invalid(format!("control {name}'s label is empty, over {TOUCH_LABEL_MAX} bytes or holds a control character")));
    }
    let [x, y] = control.at.offset();
    let finite = x.is_finite() && y.is_finite() && control.radius.is_finite();
    if !finite || control.radius <= 0.0 {
        return Err(invalid(format!("control {name} needs a finite position and a size above 0")));
    }
    let [min_x, min_y, max_x, max_y] = control.zone(world);
    let [w, h] = world_f32(world);
    let leaves_world = min_x < 0.0 || min_y < 0.0 || max_x > w || max_y > h;
    if leaves_world {
        return Err(invalid(format!("control {name}'s zone leaves the {}x{} world", world[0], world[1])));
    }
    if let Some(target) = control.pad
        && !control.fits(target)
    {
        return Err(invalid(format!("control {name} cannot drive the virtual pad's {target:?}")));
    }
    Ok(())
}

/// A control against the ones declared before it: distinct ids, no overlap, no shared pad input.
fn check_against_earlier(control: &Control, earlier: &[Control], world: [u32; 2]) -> Result<(), InputError> {
    let name = control.id.name();
    let zone = control.zone(world);
    for other in earlier {
        if other.id == control.id {
            return Err(invalid(format!("control {name} is declared twice")));
        }
        if overlap(zone, other.zone(world)) {
            return Err(invalid(format!("controls {} and {name} overlap", other.id.name())));
        }
        if control.pad.is_some() && control.pad == other.pad {
            return Err(invalid(format!("controls {} and {name} drive the same pad input", other.id.name())));
        }
    }
    Ok(())
}

/// Whether two zones share any area (touching edges do not).
fn overlap(a: [f32; 4], b: [f32; 4]) -> bool {
    a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]
}

fn kind_fits(control: ControlKind, action: ActionKind) -> bool {
    match control {
        ControlKind::Button => action != ActionKind::Axis2,
        ControlKind::Stick(_) | ControlKind::Dpad => action != ActionKind::Button,
    }
}

fn invalid(detail: impl Into<String>) -> InputError {
    InputError::new(InputErrorCode::TouchControlsInvalid, detail)
}

fn world_f32(world: [u32; 2]) -> [f32; 2] {
    // World sizes are a few thousand pixels: exact in f32.
    [world[0] as f32, world[1] as f32]
}

fn minus(a: [f32; 2], b: [f32; 2]) -> [f32; 2] {
    [a[0] - b[0], a[1] - b[1]]
}

/// Which finger holds a control, and where its base is.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct Hold {
    finger: Option<u32>,
    /// The stick's base (a floating stick's landing point); the centre for other controls.
    origin: [f32; 2],
}

/// The controls' state between ticks: which finger holds each one. Part of the input snapshot.
#[derive(Clone, Debug, PartialEq)]
pub struct TouchState {
    ids: Vec<ControlId>,
    holds: Vec<Hold>,
}

impl TouchState {
    /// No control held.
    pub fn new(controls: &TouchControls) -> TouchState {
        TouchState { ids: controls.controls.iter().map(|control| control.id).collect(), holds: vec![Hold::default(); controls.controls.len()] }
    }

    /// Let go of every control (a new seed).
    pub fn reset(&mut self) {
        self.holds.fill(Hold::default());
    }

    /// The finger holding `control`.
    pub fn finger(&self, control: ControlId) -> Option<u32> {
        self.hold(control).and_then(|hold| hold.finger)
    }

    /// The base of the held stick `control`.
    pub fn origin(&self, control: ControlId) -> Option<[f32; 2]> {
        self.hold(control).filter(|hold| hold.finger.is_some()).map(|hold| hold.origin)
    }

    /// The state as JSON: `{format: "genex-touch/1", controls: [{id, finger, origin}]}`, f32
    /// positions exact.
    pub fn snapshot(&self) -> Value {
        let controls: Vec<Value> = self
            .ids
            .iter()
            .zip(&self.holds)
            .map(|(id, hold)| json!({"id": id.name(), "finger": hold.finger, "origin": [hold.origin[0], hold.origin[1]]}))
            .collect();
        json!({"format": TOUCH_SNAPSHOT_FORMAT, "controls": controls})
    }

    /// The state a [`TouchState::snapshot`] of the same layout saved. All or nothing: a snapshot of
    /// another layout or a malformed one refuses `touch-controls-invalid`.
    pub fn restore(controls: &TouchControls, snapshot: &Value) -> Result<TouchState, InputError> {
        let refused = |detail: &str| invalid(format!("touch snapshot: {detail}"));
        let object = snapshot.as_object().ok_or_else(|| refused("not an object"))?;
        if object.get("format").and_then(Value::as_str) != Some(TOUCH_SNAPSHOT_FORMAT) {
            return Err(refused("not a genex-touch/1 snapshot"));
        }
        let rows = object.get("controls").and_then(Value::as_array).ok_or_else(|| refused("no controls"))?;
        let mut state = TouchState::new(controls);
        if rows.len() != state.ids.len() {
            return Err(refused("another layout's controls"));
        }
        for (at, row) in rows.iter().enumerate() {
            let hold = restore_hold(state.ids[at], row).ok_or_else(|| refused("a control row that cannot be read"))?;
            let shared = hold.finger.is_some() && state.holds[..at].iter().any(|earlier| earlier.finger == hold.finger);
            if shared {
                return Err(refused("one finger holds two controls"));
            }
            state.holds[at] = hold;
        }
        Ok(state)
    }

    fn hold(&self, control: ControlId) -> Option<&Hold> {
        self.ids.iter().position(|id| *id == control).map(|at| &self.holds[at])
    }

    fn holds_finger(&self, finger: u32) -> bool {
        self.holds.iter().any(|hold| hold.finger == Some(finger))
    }
}

/// One snapshot row for the control `id`.
fn restore_hold(id: ControlId, row: &Value) -> Option<Hold> {
    let row: &Map<String, Value> = row.as_object()?;
    if row.get("id")?.as_str()? != id.name() {
        return None;
    }
    let finger = match row.get("finger")? {
        Value::Null => None,
        value => Some(u32::try_from(value.as_u64()?).ok()?),
    };
    let origin = row.get("origin")?.as_array()?;
    let [x, y] = origin.as_slice() else { return None };
    // Saved from f32, so the narrowing is exact; anything else is refused as non-finite or rounded.
    let narrow = |value: &Value| {
        let wide = value.as_f64()?;
        let narrowed = wide as f32;
        (narrowed.is_finite() && f64::from(narrowed) == wide).then_some(narrowed)
    };
    Some(Hold { finger, origin: [narrow(x)?, narrow(y)?] })
}

/// The controls' values on one tick, in declaration order, and the fingers they used.
#[derive(Clone, Debug, PartialEq)]
pub struct TouchFrame {
    values: Vec<(ControlId, [f32; 2])>,
    claimed: Vec<u32>,
    pad: Option<PadState>,
}

impl TouchFrame {
    /// Every control's value, for `Devices::touch`.
    pub fn values(&self) -> &[(ControlId, [f32; 2])] {
        &self.values
    }

    /// One control's value (0 for an unknown id).
    pub fn value(&self, control: ControlId) -> [f32; 2] {
        self.values.iter().find(|(id, _)| *id == control).map_or([0.0, 0.0], |(_, value)| *value)
    }

    /// Whether a control used `finger` on this tick.
    pub fn claimed(&self, finger: u32) -> bool {
        self.claimed.contains(&finger)
    }

    /// The tick's touches no control used: what a game reading raw touches should handle.
    pub fn free<'a>(&'a self, tick: &'a TickInput) -> impl Iterator<Item = &'a TouchPoint> + 'a {
        tick.touches.iter().filter(|touch| !self.claimed(touch.id))
    }

    /// The virtual pad the controls with pad targets drive (connected, neutral at rest); `None`
    /// when no control has a pad target.
    pub fn virtual_pad(&self) -> Option<PadState> {
        self.pad
    }
}

/// Evaluate one tick of touches against the layout: `state` moves to this tick, and the frame
/// holds each control's value. The layout must have passed [`TouchControls::validate`] for
/// `world`; a state built for another layout is rebuilt first.
pub fn evaluate_touch(controls: &TouchControls, world: [u32; 2], state: &mut TouchState, tick: &TickInput) -> TouchFrame {
    if !state.ids.iter().copied().eq(controls.controls.iter().map(|control| control.id)) {
        *state = TouchState::new(controls);
    }
    release_gone(state, tick);
    let tapped = claim_new(controls, world, state, tick);
    let mut values = Vec::with_capacity(controls.controls.len());
    let mut claimed: Vec<u32> = state.holds.iter().filter_map(|hold| hold.finger).collect();
    for (at, control) in controls.controls.iter().enumerate() {
        let tap = tapped.iter().find(|(index, _)| *index == at).map(|(_, point)| *point);
        let value = match (state.holds[at].finger, tap) {
            (Some(finger), _) => finger_at(tick, finger).map_or([0.0, 0.0], |point| control_value(control, world, state.holds[at].origin, point)),
            (None, Some(point)) => tap_value(control, world, point),
            (None, None) => [0.0, 0.0],
        };
        values.push((control.id, value));
    }
    claimed.extend(tapped.iter().map(|(_, point)| point.id));
    claimed.sort_unstable();
    let pad = controls.has_virtual_pad().then(|| virtual_pad(controls, &values));
    TouchFrame { values, claimed, pad }
}

/// Let go of controls whose finger ended, began again (a reused id) or is missing from the tick.
fn release_gone(state: &mut TouchState, tick: &TickInput) {
    for hold in &mut state.holds {
        let Some(finger) = hold.finger else { continue };
        let still_down = tick.touches.iter().any(|touch| touch.id == finger && touch.phase == TouchPhase::Held);
        if !still_down {
            *hold = Hold::default();
        }
    }
}

/// Fingers that began (or tapped) on this tick take the free control they landed on, in finger
/// order. A beginning finger holds it; a tap reads for this tick only. Answers the taps.
fn claim_new(controls: &TouchControls, world: [u32; 2], state: &mut TouchState, tick: &TickInput) -> Vec<(usize, TouchPoint)> {
    let mut tapped: Vec<(usize, TouchPoint)> = Vec::new();
    let starts = tick.touches.iter().filter(|touch| matches!(touch.phase, TouchPhase::Began | TouchPhase::Tapped));
    for touch in starts {
        let point = [touch.x, touch.y];
        let Some(at) = controls.controls.iter().position(|control| control.hit(world, point)) else { continue };
        let busy = state.holds[at].finger.is_some() || tapped.iter().any(|(index, _)| *index == at);
        if busy || state.holds_finger(touch.id) {
            continue;
        }
        if touch.phase == TouchPhase::Tapped {
            tapped.push((at, *touch));
            continue;
        }
        let control = &controls.controls[at];
        let origin = match control.kind {
            ControlKind::Stick(StickMode::Floating) => point,
            ControlKind::Stick(StickMode::Fixed) | ControlKind::Button | ControlKind::Dpad => control.centre(world),
        };
        state.holds[at] = Hold { finger: Some(touch.id), origin };
    }
    tapped
}

fn finger_at(tick: &TickInput, finger: u32) -> Option<[f32; 2]> {
    tick.touches.iter().find(|touch| touch.id == finger).map(|touch| [touch.x, touch.y])
}

/// A held control's value with its finger at `point`.
fn control_value(control: &Control, world: [u32; 2], origin: [f32; 2], point: [f32; 2]) -> [f32; 2] {
    match control.kind {
        ControlKind::Stick(_) => {
            let [dx, dy] = minus(point, origin);
            unit_clamped([dx / control.radius, dy / control.radius])
        }
        ControlKind::Button => [1.0, 0.0],
        ControlKind::Dpad => dpad_direction(control, world, point),
    }
}

/// A tap's one-tick value: a button presses, a d-pad points; a stick tapped reads nothing.
fn tap_value(control: &Control, world: [u32; 2], point: TouchPoint) -> [f32; 2] {
    match control.kind {
        ControlKind::Button => [1.0, 0.0],
        ControlKind::Dpad => dpad_direction(control, world, [point.x, point.y]),
        ControlKind::Stick(_) => [0.0, 0.0],
    }
}

/// The d-pad's direction: each axis is -1, 0 or 1 past [`DPAD_DEAD_ZONE`], diagonals of length 1.
fn dpad_direction(control: &Control, world: [u32; 2], point: [f32; 2]) -> [f32; 2] {
    let [dx, dy] = minus(point, control.centre(world));
    let step = |delta: f32| {
        let fraction = delta / control.radius;
        if fraction > DPAD_DEAD_ZONE {
            1.0
        } else if fraction < -DPAD_DEAD_ZONE {
            -1.0
        } else {
            0.0
        }
    };
    unit_clamped([step(dx), step(dy)])
}

/// A vector longer than 1 scaled to length 1.
fn unit_clamped(value: [f32; 2]) -> [f32; 2] {
    let [x, y] = value;
    let length = libm::sqrtf(x * x + y * y);
    if length > 1.0 { [x / length, y / length] } else { value }
}

/// The virtual pad: each control with a pad target writes its value there.
fn virtual_pad(controls: &TouchControls, values: &[(ControlId, [f32; 2])]) -> PadState {
    let mut pad = PadState { connected: true, ..PadState::default() };
    for (control, (_, value)) in controls.controls.iter().zip(values) {
        match control.pad {
            Some(PadTarget::Stick(stick)) => {
                let (x, y) = stick.axes();
                pad.axes[x.index()] = value[0];
                pad.axes[y.index()] = value[1];
            }
            Some(PadTarget::Button(button)) => pad.buttons[button.index()] = value[0],
            Some(PadTarget::Dpad) => {
                let press = |on: bool| f32::from(u8::from(on));
                pad.buttons[PadButton::DpadLeft.index()] = press(value[0] < 0.0);
                pad.buttons[PadButton::DpadRight.index()] = press(value[0] > 0.0);
                pad.buttons[PadButton::DpadUp.index()] = press(value[1] < 0.0);
                pad.buttons[PadButton::DpadDown.index()] = press(value[1] > 0.0);
            }
            None => {}
        }
    }
    pad
}
