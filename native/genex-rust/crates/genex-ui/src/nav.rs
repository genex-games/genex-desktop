//! Pad and keyboard navigation for the HUD (G6 gameplay UI, UIS-4): the eight held navigation
//! buttons, a repeat counted in simulation ticks, and the egui key events they become. Pure: no
//! clock and no egui context, so the same input rows give the same events on every destination.
//!
//! By default the buttons come from the keyboard (arrows, Enter, Escape, Tab, Shift+Tab) and from
//! pads in the standard mapping (d-pad or the left stick past half way for the arrows, A for
//! accept, B for cancel, RB for next, LB for previous). A game that registers input actions fills
//! [`NavButtons`] from its `ui_*` actions instead; this module never reads them itself.

use genex_core::input::{PadAxis, PadButton, PadState};

/// Ticks a held direction waits after its first press before it repeats.
pub const NAV_REPEAT_DELAY_TICKS: u32 = 24;
/// Ticks between repeats once a held direction repeats.
pub const NAV_REPEAT_EVERY_TICKS: u32 = 6;
/// How far past centre the left stick reads as an arrow (strictly greater).
pub const NAV_STICK_THRESHOLD: f32 = 0.5;
/// How far down a pad button reads as pressed (strictly greater; triggers are analog).
pub const NAV_BUTTON_THRESHOLD: f32 = 0.5;

/// One navigation button.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum NavButton {
    /// Focus up.
    Up,
    /// Focus down.
    Down,
    /// Focus left.
    Left,
    /// Focus right.
    Right,
    /// Activate the focused widget (Enter).
    Accept,
    /// Back out (Escape).
    Cancel,
    /// The next widget in drawing order (Tab).
    Next,
    /// The previous widget in drawing order (Shift+Tab).
    Prev,
}

impl NavButton {
    /// Every button, in the order [`nav_events`] emits them.
    pub const ALL: [NavButton; 8] = [
        NavButton::Up,
        NavButton::Down,
        NavButton::Left,
        NavButton::Right,
        NavButton::Next,
        NavButton::Prev,
        NavButton::Accept,
        NavButton::Cancel,
    ];

    /// The button's wire spelling (the suffix of the matching `ui_*` input action).
    pub const fn as_str(self) -> &'static str {
        match self {
            NavButton::Up => "up",
            NavButton::Down => "down",
            NavButton::Left => "left",
            NavButton::Right => "right",
            NavButton::Accept => "accept",
            NavButton::Cancel => "cancel",
            NavButton::Next => "next",
            NavButton::Prev => "prev",
        }
    }

    /// Whether holding the button repeats it; accept and cancel fire once per press.
    pub const fn repeats(self) -> bool {
        !matches!(self, NavButton::Accept | NavButton::Cancel)
    }

    /// The egui key and modifiers the button presses.
    pub const fn egui_key(self) -> (egui::Key, egui::Modifiers) {
        match self {
            NavButton::Up => (egui::Key::ArrowUp, egui::Modifiers::NONE),
            NavButton::Down => (egui::Key::ArrowDown, egui::Modifiers::NONE),
            NavButton::Left => (egui::Key::ArrowLeft, egui::Modifiers::NONE),
            NavButton::Right => (egui::Key::ArrowRight, egui::Modifiers::NONE),
            NavButton::Accept => (egui::Key::Enter, egui::Modifiers::NONE),
            NavButton::Cancel => (egui::Key::Escape, egui::Modifiers::NONE),
            NavButton::Next => (egui::Key::Tab, egui::Modifiers::NONE),
            NavButton::Prev => (egui::Key::Tab, egui::Modifiers::SHIFT),
        }
    }

    const fn index(self) -> usize {
        match self {
            NavButton::Up => 0,
            NavButton::Down => 1,
            NavButton::Left => 2,
            NavButton::Right => 3,
            NavButton::Accept => 4,
            NavButton::Cancel => 5,
            NavButton::Next => 6,
            NavButton::Prev => 7,
        }
    }
}

/// Which navigation buttons are held (or, from [`NavRepeat::step`], which fire this tick).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct NavButtons {
    held: [bool; 8],
}

impl NavButtons {
    /// Nothing held.
    pub const NONE: NavButtons = NavButtons { held: [false; 8] };

    /// Whether `button` is held.
    pub const fn held(self, button: NavButton) -> bool {
        self.held[button.index()]
    }

    /// These buttons with `button` set to `held`.
    #[must_use]
    pub const fn with(self, button: NavButton, held: bool) -> NavButtons {
        let mut next = self;
        next.held[button.index()] = held;
        next
    }

    /// Every button held in either (two pads, or a pad and the keyboard).
    #[must_use]
    pub fn union(self, other: NavButtons) -> NavButtons {
        let mut next = self;
        for (mine, theirs) in next.held.iter_mut().zip(other.held) {
            *mine |= theirs;
        }
        next
    }

    /// Whether any button is held.
    pub fn any(self) -> bool {
        self.held.contains(&true)
    }
}

/// Turns held buttons into presses: a button fires on the tick it goes down, then (for the
/// directions, next and previous) again after [`NAV_REPEAT_DELAY_TICKS`] and every
/// [`NAV_REPEAT_EVERY_TICKS`] after that while it stays held. Counted in ticks, never in time.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct NavRepeat {
    held_ticks: [Option<u32>; 8],
}

impl NavRepeat {
    /// Nothing held yet.
    pub const fn new() -> NavRepeat {
        NavRepeat { held_ticks: [None; 8] }
    }

    /// One tick with `buttons` held: the buttons that fire on this tick.
    pub fn step(&mut self, buttons: NavButtons) -> NavButtons {
        let mut fired = NavButtons::NONE;
        for button in NavButton::ALL {
            let slot = &mut self.held_ticks[button.index()];
            if !buttons.held(button) {
                *slot = None;
                continue;
            }
            let ticks = slot.map_or(0, |held| held.saturating_add(1));
            *slot = Some(ticks);
            fired = fired.with(button, fires(ticks, button.repeats()));
        }
        fired
    }

    /// Forget what was held (a seed, or focus leaving the HUD).
    pub fn reset(&mut self) {
        *self = NavRepeat::new();
    }
}

/// Whether a button held for `ticks` ticks after its press fires now.
fn fires(ticks: u32, repeats: bool) -> bool {
    if ticks == 0 {
        return true;
    }
    repeats && ticks >= NAV_REPEAT_DELAY_TICKS && (ticks - NAV_REPEAT_DELAY_TICKS).is_multiple_of(NAV_REPEAT_EVERY_TICKS)
}

/// The egui events for the buttons that fire on a tick: each a key press and its release, in
/// [`NavButton::ALL`] order. Nothing fired gives no events.
pub fn nav_events(fired: NavButtons) -> Vec<egui::Event> {
    let mut events = Vec::new();
    for button in NavButton::ALL.into_iter().filter(|button| fired.held(*button)) {
        let (key, modifiers) = button.egui_key();
        for pressed in [true, false] {
            events.push(egui::Event::Key { key, physical_key: None, pressed, repeat: false, modifiers });
        }
    }
    events
}

/// The default navigation buttons: the keyboard keys held (DOM `code` names) and one pad in the
/// standard mapping. A disconnected pad reads nothing.
pub fn default_buttons(pad: &PadState, held_keys: &[String]) -> NavButtons {
    keyboard_buttons(held_keys).union(pad_buttons(pad))
}

fn keyboard_buttons(held_keys: &[String]) -> NavButtons {
    let held = |code: &str| held_keys.iter().any(|key| key == code);
    let shift = held("ShiftLeft") || held("ShiftRight");
    let tab = held("Tab");
    NavButtons::NONE
        .with(NavButton::Up, held("ArrowUp"))
        .with(NavButton::Down, held("ArrowDown"))
        .with(NavButton::Left, held("ArrowLeft"))
        .with(NavButton::Right, held("ArrowRight"))
        .with(NavButton::Accept, held("Enter") || held("NumpadEnter"))
        .with(NavButton::Cancel, held("Escape"))
        .with(NavButton::Next, tab && !shift)
        .with(NavButton::Prev, tab && shift)
}

fn pad_buttons(pad: &PadState) -> NavButtons {
    if !pad.connected {
        return NavButtons::NONE;
    }
    let button = |index: i32| button_value(pad, index) > NAV_BUTTON_THRESHOLD;
    let x = axis_value(pad, PadAxis::LEFT_X);
    let y = axis_value(pad, PadAxis::LEFT_Y);
    NavButtons::NONE
        .with(NavButton::Up, button(PadButton::UP) || y < -NAV_STICK_THRESHOLD)
        .with(NavButton::Down, button(PadButton::DOWN) || y > NAV_STICK_THRESHOLD)
        .with(NavButton::Left, button(PadButton::LEFT) || x < -NAV_STICK_THRESHOLD)
        .with(NavButton::Right, button(PadButton::RIGHT) || x > NAV_STICK_THRESHOLD)
        .with(NavButton::Accept, button(PadButton::A))
        .with(NavButton::Cancel, button(PadButton::B))
        .with(NavButton::Next, button(PadButton::RIGHT_BUMPER))
        .with(NavButton::Prev, button(PadButton::LEFT_BUMPER))
}

/// The pad buttons navigation reads: the d-pad, A, B and both bumpers.
const NAV_PAD_BUTTONS: [i32; 8] = [
    PadButton::UP,
    PadButton::DOWN,
    PadButton::LEFT,
    PadButton::RIGHT,
    PadButton::A,
    PadButton::B,
    PadButton::LEFT_BUMPER,
    PadButton::RIGHT_BUMPER,
];
/// The pad axes navigation reads: the left stick.
const NAV_PAD_AXES: [i32; 2] = [PadAxis::LEFT_X, PadAxis::LEFT_Y];

/// `pad` with what navigation consumes read neutral (released buttons, a centred left stick):
/// what update hooks see while a HUD widget holds focus. Every other button and axis is kept.
pub fn nav_neutral(pad: &PadState) -> PadState {
    let mut neutral = *pad;
    for index in NAV_PAD_BUTTONS {
        if let Some(value) = usize::try_from(index).ok().and_then(|i| neutral.buttons.get_mut(i)) {
            *value = 0.0;
        }
    }
    for index in NAV_PAD_AXES {
        if let Some(value) = usize::try_from(index).ok().and_then(|i| neutral.axes.get_mut(i)) {
            *value = 0.0;
        }
    }
    neutral
}

fn button_value(pad: &PadState, index: i32) -> f32 {
    usize::try_from(index).ok().and_then(|i| pad.buttons.get(i)).copied().unwrap_or(0.0)
}

fn axis_value(pad: &PadState, index: i32) -> f32 {
    usize::try_from(index).ok().and_then(|i| pad.axes.get(i)).copied().unwrap_or(0.0)
}

/// Whether `button`'s key went down on this pass (its exact modifiers), as a kit widget reads it.
pub fn pressed(ctx: &egui::Context, button: NavButton) -> bool {
    let (key, modifiers) = button.egui_key();
    ctx.input(|input| {
        input.events.iter().any(|event| {
            matches!(event, egui::Event::Key { key: pressed_key, pressed: true, modifiers: held, .. } if *pressed_key == key && *held == modifiers)
        })
    })
}
