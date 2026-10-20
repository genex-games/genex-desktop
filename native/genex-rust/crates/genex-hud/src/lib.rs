//! egui HUD fed from the merged input and the simulated clock; legacy text/bar/crosshair/flash; hud.items.
//!
//! The contract (plan "The game API agents write", HUD row):
//! - UI hooks run inside the tick, exactly once per tick, with an egui `RawInput` built only from
//!   that tick's merged input (real plus injected, letterbox-mapped to world fractions) and the
//!   simulated clock ([`raw_input`]). Nothing reads the wall clock or a window.
//! - egui's `Memory` resets on `seed` ([`Hud::reset`] makes a fresh context).
//! - Painting is display only: [`Hud::paint`] tessellates what the last tick and the last drawn
//!   frame produced and never changes what a later tick sees. [`HudPainter`] draws it with
//!   egui-wgpu over a target the runtime owns (the world target a capture reads included), at
//!   [`pixels_per_point`] of the display's ratio; egui's tick itself always runs at one point per
//!   world pixel, so widget rects, clicks and captures are the same headless and windowed and on
//!   every display.
//! - Every widget the UI drew is recorded (role, label, world-pixel rect, its genex-ui key and
//!   whether it has focus) from egui's AccessKit tree, so `state().hud.items` names them and a
//!   play script can click one by label or key.
//! - The UI scale ([`HudInput::ui_scale`], UIS-8) is egui's points per world pixel: the input is
//!   divided by it and the recorded rects multiplied by it, so a rect and its click hit agree at
//!   any scale. Modifiers and extra events (the UI kit's navigation keys) reach egui with the tick.
//! - Locale fallback fonts ([`Hud::set_locale_fonts`]) sit behind the text fonts and survive a seed.
//! - The graphics settings panel ([`settings_panel`], RQ0.7): a renderer-agnostic egui widget
//!   (preset, render scale, feature switches, the detected device class) answering
//!   [`PanelChange`]s; `genex::render::settings_panel` fills it and applies them outside the Sim.
//! - The loading screen ([`LoadingScreen`], renderer pass 2 D11): what a native window shows
//!   from its first frame until the game's first lit frame, in the game's `[render.loading]` look.
//! - The soft-keyboard bridge ([`ImeBridge`], M5.3): a phone keyboard's typing becomes the
//!   tick's committed text and editing keys, bounded by [`NATIVE_TEXT_MAX_UNITS`], and the
//!   keyboard is up while a text field has egui's focus ([`keyboard_wanted`]).
//!
//! TODO(M2.4/M2.6): the facade owns one [`Hud`] (egui `max_passes` = 1) and one [`HudPainter`]
//! and paints into the world target before every capture and present.

mod fonts;
mod hud;
mod ime;
mod input;
mod legacy;
mod loading;
mod paint;
mod record;
mod settings_panel;

pub use fonts::{
    FontRefusal, LocaleFont, MAX_LOCALE_FONT_BYTES, MAX_LOCALE_FONT_NAME, MAX_LOCALE_FONTS, fonts, gear_shapes, install_fonts, settings_button,
};
pub use hud::{Hud, HudPaint, HudSummary, MAX_HUD_ITEMS, MAX_ITEM_NAME};
pub use ime::{EditKey, ImeBatch, ImeBridge, KeyboardCall, MAX_EDIT_KEYS, NATIVE_TEXT_MAX_UNITS, TextAction, keyboard_wanted, keys_taken};
pub use input::{HudInput, raw_input};
pub use legacy::Color;
pub use loading::{LoadingLook, LoadingProgress, LoadingScreen, parse_hex_color};
pub use paint::{HudPainter, pixels_per_point};
pub use record::{HudWidget, WidgetRole};
pub use settings_panel::{PanelChange, PanelWords, SettingsPanel, settings_panel, settings_panel_with_words};

/// Pinned re-export, so games and the runtime never name egui's version themselves.
pub use egui;
