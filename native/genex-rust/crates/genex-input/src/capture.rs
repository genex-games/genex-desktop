//! Listen mode: the controls panel waits for the player to press what they want bound. Each tick
//! of merged input is fed in; the first key pressed, pad button pressed or stick half pushed past
//! half travel becomes a binding of the action's kind. Escape cancels. A stick already past half
//! travel when listening starts counts as pushed (listening assumes the pad was at rest).

use genex_core::input::{PAD_AXES, PAD_BUTTONS, TickInput};

use crate::binding::{ActionKind, Binding, KeyCode, PadAxis, PadButton, Sign};

/// How far a stick half must travel to be captured.
pub const CAPTURE_AXIS_THRESHOLD: f32 = 0.5;
/// The key that leaves listen mode without binding anything.
const CANCEL_KEY: &str = "Escape";

/// What one fed tick did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CaptureStep {
    /// Nothing usable was pressed.
    Waiting,
    /// The binding the player pressed.
    Took(Binding),
    /// The player pressed Escape.
    Cancelled,
}

/// One listen session for an action of a kind.
#[derive(Clone, Debug, PartialEq)]
pub struct Capture {
    kind: ActionKind,
    /// Each axis's strongest value over every pad on the previous tick.
    before: [f32; PAD_AXES],
}

impl Capture {
    /// Start listening for a binding of `kind`.
    pub fn new(kind: ActionKind) -> Capture {
        Capture { kind, before: [0.0; PAD_AXES] }
    }

    /// Feed one tick. A 2D action takes a stick (from either of its axes) or the d-pad; a key
    /// alone cannot drive it, so keys are skipped for it.
    pub fn feed(&mut self, tick: &TickInput) -> CaptureStep {
        let axes = strongest_axes(tick);
        let before = std::mem::replace(&mut self.before, axes);
        if tick.keys.pressed(CANCEL_KEY) {
            return CaptureStep::Cancelled;
        }
        let taken = self.key(tick).or_else(|| self.button(tick)).or_else(|| self.half_axis(before, axes));
        taken.map_or(CaptureStep::Waiting, CaptureStep::Took)
    }

    fn key(&self, tick: &TickInput) -> Option<Binding> {
        if self.kind == ActionKind::Axis2 {
            return None;
        }
        // Pressed keys are canonical and sorted, so the pick is the same on every destination.
        tick.keys.pressed_keys().iter().find_map(|name| KeyCode::parse(name).ok()).map(Binding::Key)
    }

    fn button(&self, tick: &TickInput) -> Option<Binding> {
        let pads = &tick.pads;
        let pressed = (0..PAD_BUTTONS)
            .find(|&button| (0..pads.states().len()).any(|pad| pads.pressed(pad as i32, button as i32)))?;
        let button = PadButton::from_index(pressed)?;
        let dpad =
            matches!(button, PadButton::DpadUp | PadButton::DpadDown | PadButton::DpadLeft | PadButton::DpadRight);
        match self.kind {
            ActionKind::Axis2 if dpad => Some(Binding::Dpad),
            ActionKind::Axis2 => None,
            ActionKind::Button | ActionKind::Axis1 => Some(Binding::Pad(button)),
        }
    }

    fn half_axis(&self, before: [f32; PAD_AXES], now: [f32; PAD_AXES]) -> Option<Binding> {
        let crossed = |at: usize| now[at].abs() > CAPTURE_AXIS_THRESHOLD && before[at].abs() <= CAPTURE_AXIS_THRESHOLD;
        let at = (0..PAD_AXES).find(|&at| crossed(at))?;
        let axis = PadAxis::from_index(at)?;
        let sign = if now[at] < 0.0 { Sign::Negative } else { Sign::Positive };
        match self.kind {
            ActionKind::Axis2 => Some(Binding::Stick(axis.stick())),
            ActionKind::Button | ActionKind::Axis1 => Some(Binding::PadAxis(axis, sign)),
        }
    }
}

/// Each axis at its largest magnitude over the connected pads.
fn strongest_axes(tick: &TickInput) -> [f32; PAD_AXES] {
    let mut axes = [0.0f32; PAD_AXES];
    for pad in tick.pads.states().iter().filter(|pad| pad.connected) {
        for (out, value) in axes.iter_mut().zip(&pad.axes) {
            if value.abs() > out.abs() {
                *out = *value;
            }
        }
    }
    axes
}
