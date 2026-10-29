//! On-screen touch controls (`game.touch_controls`): the facade over genex-input's touch layer
//! (G6 input, IN-12).
//!
//! Each tick the controls read the tick's touches, touch 0 following Mouse1 included (so a play
//! script's `click_at` and a desktop player reach them), before the actions are evaluated: a
//! `touch:<id>` binding reads its control's value, and the touches no control took are
//! `ctx.actions.free_touches()`. The HUD paints the controls when they are shown
//! (`TouchControls::show`); whether they are shown never changes what the game reads, so
//! `ShowWhen::Never` and `ShowWhen::Always` give equal checksums. Each control is also a HUD item
//! labelled with its label, its zone as its rect.

use crate::ctx::{Touch, TouchPhase};
use crate::game::Game;
use crate::input::TickInput;
use genex_core::input::{TickInput as CoreTick, TouchPhase as CorePhase, TouchPoint};
use genex_input::paint::{TouchArea, paint_touch_controls};
use genex_input::state::Device;
use genex_input::touch::{TouchControls, TouchFrame, TouchState, evaluate_touch_from};
use serde_json::{Value, json};

/// The touch id the facade gives the desktop mouse (Mouse1).
const MOUSE_FINGER: u32 = 0;

impl<W> Game<W> {
    /// On-screen sticks, buttons and d-pads for touch screens, read through `touch:<id>`
    /// bindings. Registered once (`duplicate-touch-controls`); `install` refuses a layout outside
    /// the world or past its caps (`input-invalid`).
    pub fn touch_controls(&mut self, controls: TouchControls) -> &mut Self {
        self.g6.touch.layouts.push(controls);
        self
    }
}

/// `game.touch_controls`: the on-screen layout.
#[derive(Debug, Default)]
pub(crate) struct Setup {
    layouts: Vec<TouchControls>,
}

impl Setup {
    /// The registered layout, if any.
    pub(crate) fn layout(&self) -> Option<&TouchControls> {
        self.layouts.first()
    }

    /// How many layouts were registered (install refuses more than one).
    pub(crate) fn count(&self) -> usize {
        self.layouts.len()
    }
}

/// The touch controls' state: which finger holds each control, and this tick's values.
#[derive(Debug, Default)]
pub(crate) struct State {
    holds: Option<TouchState>,
    frame: Option<TouchFrame>,
}

impl State {
    /// Tick step 3: this tick's touches against the layout. Answers each control's value and the
    /// touches no control took (every touch without a layout).
    pub(crate) fn step(&mut self, setup: &Setup, world: [u32; 2], input: &TickInput) -> (Vec<(genex_input::id::ControlId, [f32; 2])>, Vec<Touch>) {
        let Some(layout) = setup.layout() else {
            return (Vec::new(), input.touches.all().to_vec());
        };
        let tick = with_touches(&input.core, input.touches.all());
        let mouse = emulated_finger(&input.core, input.touches.all());
        let holds = self.holds.get_or_insert_with(|| TouchState::new(layout));
        let frame = evaluate_touch_from(layout, world, holds, &tick, mouse);
        let free = input.touches.all().iter().filter(|touch| !frame.claimed(touch.id)).copied().collect();
        let values = frame.values().to_vec();
        self.frame = Some(frame);
        (values, free)
    }

    /// A new seed: no finger holds a control.
    pub(crate) fn reset(&mut self, setup: &Setup) {
        self.holds = setup.layout().map(TouchState::new);
        self.frame = None;
    }

    /// The fingers on controls (an input snapshot), when a layout is registered.
    pub(crate) fn snapshot(&self) -> Option<Value> {
        self.holds.as_ref().map(TouchState::snapshot)
    }

    /// Put back the fingers a snapshot of the same layout saved; all or nothing.
    pub(crate) fn restore(&mut self, setup: &Setup, snapshot: &Value) -> Result<(), genex_input::error::InputError> {
        let Some(layout) = setup.layout() else { return Ok(()) };
        self.holds = Some(TouchState::restore(layout, snapshot)?);
        Ok(())
    }

    /// Whether the HUD paints the controls for a player on `device`.
    pub(crate) fn shown(setup: &Setup, device: Device) -> bool {
        setup.layout().is_some_and(|layout| layout.visible(device))
    }

    /// Paint the layout over the HUD's whole screen as this tick left it.
    pub(crate) fn paint(&self, setup: &Setup, world: [u32; 2], ui: &mut egui::Ui) {
        let (Some(layout), Some(holds), Some(frame)) = (setup.layout(), self.holds.as_ref(), self.frame.as_ref()) else { return };
        let area = TouchArea { world, rect: ui.max_rect() };
        let _ = paint_touch_controls(ui, layout, area, holds, frame);
    }

    /// `state().__input.touchControls`: whether they are shown and the controls held this tick.
    pub(crate) fn runtime_value(&self, setup: &Setup, device: Device) -> Option<Value> {
        let layout = setup.layout()?;
        let held: Vec<&str> = self
            .frame
            .iter()
            .flat_map(|frame| frame.values().iter())
            .filter(|(_, value)| value[0] != 0.0 || value[1] != 0.0)
            .map(|(id, _)| id.name())
            .collect();
        Some(json!({ "shown": layout.visible(device), "held": held }))
    }
}

/// The finger the facade emulated from Mouse1 on this tick: touch 0 when the merged tick has no
/// real finger 0 (`input::touches_of`). It presses only a layout shown on every device.
fn emulated_finger(core: &CoreTick, touches: &[Touch]) -> Option<u32> {
    let real = core.touches.iter().any(|touch| touch.id == MOUSE_FINGER);
    let emulated = !real && touches.iter().any(|touch| touch.id == MOUSE_FINGER);
    emulated.then_some(MOUSE_FINGER)
}

/// The merged tick with the facade's touches (touch 0 following Mouse1 included) as its fingers.
fn with_touches(core: &CoreTick, touches: &[Touch]) -> CoreTick {
    let mut tick = core.clone();
    tick.touches = touches.iter().map(|touch| TouchPoint { id: touch.id, x: touch.position.x, y: touch.position.y, phase: core_phase(touch.phase) }).collect();
    tick
}

fn core_phase(phase: TouchPhase) -> CorePhase {
    match phase {
        TouchPhase::Began => CorePhase::Began,
        TouchPhase::Held => CorePhase::Held,
        TouchPhase::Ended => CorePhase::Ended,
        TouchPhase::Tapped => CorePhase::Tapped,
    }
}
