//! UI scale (G6 gameplay UI, UIS-7): the HUD's points per world pixel. `Auto` picks by the output's
//! class (larger on a phone, where a thumb is the pointer) only in exports; a Genex run pins the
//! person layer, so `Auto` is 1.0 there on any output and a capture never depends on the device.
//! A `Fixed` scale is the game's or the person's own choice and applies everywhere.

/// The smallest UI scale.
pub const UI_SCALE_MIN: f32 = 0.5;
/// The largest UI scale.
pub const UI_SCALE_MAX: f32 = 3.0;
/// `Auto` on a phone-class output.
pub const AUTO_PHONE_SCALE: f32 = 1.5;
/// An output whose shorter side is below this many logical points is phone-class.
pub const PHONE_SHORT_SIDE_MAX: f32 = 600.0;

/// How the HUD scales.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
#[non_exhaustive]
pub enum UiScale {
    /// By the output's class in exports; 1.0 in a pinned (Genex) run.
    #[default]
    Auto,
    /// This scale, clamped to `UI_SCALE_MIN..=UI_SCALE_MAX` (a non-finite one reads 1.0).
    Fixed(f32),
}

/// The Accessibility tab's `ui.scale` choice options, by index: Auto, then fixed steps from 0.75
/// to 2.0.
pub const UI_SCALE_CHOICES: [UiScale; 6] =
    [UiScale::Auto, UiScale::Fixed(0.75), UiScale::Fixed(1.0), UiScale::Fixed(1.25), UiScale::Fixed(1.5), UiScale::Fixed(2.0)];

/// The text keys of [`UI_SCALE_CHOICES`], for a `SettingDef::choice`.
pub const UI_SCALE_CHOICE_KEYS: [&str; 6] = ["ui-scale-auto", "ui-scale-75", "ui-scale-100", "ui-scale-125", "ui-scale-150", "ui-scale-200"];

/// What class of output the HUD draws on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum OutputClass {
    /// A monitor, a laptop or a tablet.
    Desktop,
    /// A phone.
    Phone,
}

impl OutputClass {
    /// The class of an output `size` logical points large (either orientation).
    pub fn of(size: [f32; 2]) -> OutputClass {
        let short = size[0].min(size[1]);
        if short < PHONE_SHORT_SIDE_MAX { OutputClass::Phone } else { OutputClass::Desktop }
    }
}

impl UiScale {
    /// The scale on an output of `class`; `pinned` in a Genex run, where `Auto` is 1.0.
    pub fn resolve(self, class: OutputClass, pinned: bool) -> f32 {
        match self {
            UiScale::Fixed(scale) if scale.is_finite() => scale.clamp(UI_SCALE_MIN, UI_SCALE_MAX),
            UiScale::Fixed(_) => 1.0,
            UiScale::Auto if pinned => 1.0,
            UiScale::Auto => match class {
                OutputClass::Phone => AUTO_PHONE_SCALE,
                OutputClass::Desktop => 1.0,
            },
        }
    }

    /// The scale a `ui.scale` choice index picks (an unknown index reads `Auto`).
    pub fn from_choice(index: u16) -> UiScale {
        UI_SCALE_CHOICES.get(usize::from(index)).copied().unwrap_or(UiScale::Auto)
    }
}
