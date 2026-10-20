//! egui's input for one tick, built only from the tick's merged input and the simulated clock.
//!
//! The UI scale (UIS-8) is egui's points per world pixel: egui lays out in points, so at scale 2
//! every widget is twice as large in world pixels. The pointer, the wheel and the screen are
//! divided by the scale on the way in and the recorded rects multiplied by it on the way out
//! ([`crate::HudWidget`]), so a rect and its click hit always agree.

use genex_ui::settings::scale::{UI_SCALE_MAX, UI_SCALE_MIN};

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
    /// The modifier keys held on this tick, on every key and pointer event (Shift+Tab walks focus
    /// back).
    pub modifiers: egui::Modifiers,
    /// Events appended after the tick's own (the navigation keys the UI kit fired); positions in
    /// them are egui points.
    pub extra_events: Vec<egui::Event>,
    /// egui points per world pixel, bounded to genex-ui's UI scale range; a non-finite or
    /// non-positive scale reads 1.
    pub ui_scale: f32,
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
            modifiers: egui::Modifiers::NONE,
            extra_events: Vec::new(),
            ui_scale: 1.0,
        }
    }
}

/// The UI scale `input` asks for, bounded: a non-finite or non-positive scale reads 1.
pub(crate) fn ui_scale(input: &HudInput) -> f32 {
    let usable = input.ui_scale.is_finite() && input.ui_scale > 0.0;
    if usable { input.ui_scale.clamp(UI_SCALE_MIN, UI_SCALE_MAX) } else { 1.0 }
}

/// egui's `RawInput` for a tick at `seconds` of simulated time, over a world of `world_size`
/// pixels (egui points are world pixels divided by the UI scale). A pure function of its
/// arguments.
pub fn raw_input(world_size: [u32; 2], seconds: f64, input: &HudInput) -> egui::RawInput {
    let scale = ui_scale(input);
    let size = egui::vec2(world_size[0] as f32, world_size[1] as f32) / scale;
    let pos = egui::pos2(fraction(input.pointer[0]) * size.x, fraction(input.pointer[1]) * size.y);
    let modifiers = input.modifiers;
    // The tick's modifiers first, so egui's held state never outlives the tick that held them.
    let mut events = vec![egui::Event::ModifiersChanged(modifiers), egui::Event::PointerMoved(pos)];
    let button = |pressed| egui::Event::PointerButton { pos, button: egui::PointerButton::Primary, pressed, modifiers };
    if input.primary_pressed {
        events.push(button(true));
    }
    if input.primary_released {
        events.push(button(false));
    }
    if input.wheel.iter().all(|d| d.is_finite()) && input.wheel != [0.0, 0.0] {
        events.push(egui::Event::MouseWheel {
            unit: egui::MouseWheelUnit::Point,
            delta: egui::vec2(-input.wheel[0], -input.wheel[1]) / scale,
            phase: egui::TouchPhase::Move,
            modifiers,
        });
    }
    for code in &input.pressed_keys {
        if let Some((_, key)) = EGUI_KEYS.iter().find(|(name, _)| name == code) {
            events.push(egui::Event::Key { key: *key, physical_key: None, pressed: true, repeat: false, modifiers });
        }
    }
    if !input.text.is_empty() {
        events.push(egui::Event::Text(input.text.clone()));
    }
    events.extend(input.extra_events.iter().cloned());
    let mut raw = egui::RawInput {
        screen_rect: Some(egui::Rect::from_min_size(egui::Pos2::ZERO, size)),
        time: Some(seconds),
        predicted_dt: TICK_SECONDS,
        focused: true,
        events,
        ..egui::RawInput::default()
    };
    // At scale 1 nothing is announced, so today's input stays byte for byte what it was.
    if scale != 1.0 {
        raw.viewports.entry(egui::ViewportId::ROOT).or_default().native_pixels_per_point = Some(scale);
    }
    raw
}

/// A pointer fraction inside the frame; NaN reads as the centre.
fn fraction(value: f32) -> f32 {
    if value.is_nan() { 0.5 } else { value.clamp(0.0, 1.0) }
}
