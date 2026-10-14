//! egui's input for one tick, built only from the tick's merged input and the simulated clock.

/// One simulation tick, in seconds (egui's `predicted_dt`).
const TICK_SECONDS: f32 = 1.0 / 60.0;
/// Where the pointer is when nothing has moved it: the frame's centre, as the merger starts.
const POINTER_CENTRE: [f32; 2] = [0.5, 0.5];

/// The protocol keys egui's widgets act on (text editing, focus, activation), by DOM `code`.
const EGUI_KEYS: [(&str, egui::Key); 10] = [
    ("Backspace", egui::Key::Backspace),
    ("Enter", egui::Key::Enter),
    ("Tab", egui::Key::Tab),
    ("Escape", egui::Key::Escape),
    ("Space", egui::Key::Space),
    ("ArrowUp", egui::Key::ArrowUp),
    ("ArrowDown", egui::Key::ArrowDown),
    ("ArrowLeft", egui::Key::ArrowLeft),
    ("ArrowRight", egui::Key::ArrowRight),
    ("Delete", egui::Key::Delete),
];

/// What the HUD reads from one tick's merged input.
#[derive(Clone, Debug, PartialEq)]
pub struct HudInput {
    /// The pointer as a fraction of the world frame (x right, y down).
    pub pointer: [f32; 2],
    /// Mouse1 (and touch 0) went down on this tick.
    pub primary_pressed: bool,
    /// Mouse1 (and touch 0) went up on this tick; with `primary_pressed` it is a tap.
    pub primary_released: bool,
    /// Wheel movement, in world pixels.
    pub wheel: [f32; 2],
    /// Committed text.
    pub text: String,
    /// Keys pressed on this tick, by DOM `code`; those egui does not act on are ignored.
    pub pressed_keys: Vec<String>,
}

impl Default for HudInput {
    fn default() -> HudInput {
        HudInput {
            pointer: POINTER_CENTRE,
            primary_pressed: false,
            primary_released: false,
            wheel: [0.0, 0.0],
            text: String::new(),
            pressed_keys: Vec::new(),
        }
    }
}

/// egui's `RawInput` for a tick at `seconds` of simulated time, over a world of `world_size`
/// pixels (egui points are world pixels). A pure function of its arguments.
pub fn raw_input(world_size: [u32; 2], seconds: f64, input: &HudInput) -> egui::RawInput {
    let size = egui::vec2(world_size[0] as f32, world_size[1] as f32);
    let pos = egui::pos2(fraction(input.pointer[0]) * size.x, fraction(input.pointer[1]) * size.y);
    let mut events = vec![egui::Event::PointerMoved(pos)];
    let button = |pressed| egui::Event::PointerButton {
        pos,
        button: egui::PointerButton::Primary,
        pressed,
        modifiers: egui::Modifiers::NONE,
    };
    if input.primary_pressed {
        events.push(button(true));
    }
    if input.primary_released {
        events.push(button(false));
    }
    if input.wheel.iter().all(|d| d.is_finite()) && input.wheel != [0.0, 0.0] {
        events.push(egui::Event::MouseWheel {
            unit: egui::MouseWheelUnit::Point,
            delta: egui::vec2(-input.wheel[0], -input.wheel[1]),
            phase: egui::TouchPhase::Move,
            modifiers: egui::Modifiers::NONE,
        });
    }
    for code in &input.pressed_keys {
        if let Some((_, key)) = EGUI_KEYS.iter().find(|(name, _)| name == code) {
            events.push(egui::Event::Key {
                key: *key,
                physical_key: None,
                pressed: true,
                repeat: false,
                modifiers: egui::Modifiers::NONE,
            });
        }
    }
    if !input.text.is_empty() {
        events.push(egui::Event::Text(input.text.clone()));
    }
    egui::RawInput {
        screen_rect: Some(egui::Rect::from_min_size(egui::Pos2::ZERO, size)),
        time: Some(seconds),
        predicted_dt: TICK_SECONDS,
        focused: true,
        events,
        ..egui::RawInput::default()
    }
}

/// A pointer fraction inside the frame; NaN reads as the centre.
fn fraction(value: f32) -> f32 {
    if value.is_nan() { 0.5 } else { value.clamp(0.0, 1.0) }
}
