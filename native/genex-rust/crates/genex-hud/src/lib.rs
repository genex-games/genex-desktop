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
//! - Every widget the UI drew is recorded (role, label, world-pixel rect) from egui's AccessKit
//!   tree, so `state().hud.items` names them and a play script can click one by label.
//! - The graphics settings panel ([`settings_panel`], RQ0.7): a renderer-agnostic egui widget
//!   (preset, render scale, feature switches, the detected device class) answering
//!   [`PanelChange`]s; `genex::render::settings_panel` fills it and applies them outside the Sim.
//! - The soft-keyboard bridge ([`ImeBridge`], M5.3): a phone keyboard's typing becomes the
//!   tick's committed text and editing keys, bounded by [`NATIVE_TEXT_MAX_UNITS`], and the
//!   keyboard is up while a text field has egui's focus ([`keyboard_wanted`]).
//!
//! TODO(M2.4/M2.6): the facade owns one [`Hud`] (egui `max_passes` = 1) and one [`HudPainter`]
//! and paints into the world target before every capture and present.

mod hud;
mod ime;
mod input;
mod legacy;
mod paint;
mod record;
mod settings_panel;

pub use hud::{Hud, HudPaint, HudSummary, MAX_HUD_ITEMS, MAX_ITEM_NAME};
pub use ime::{EditKey, ImeBatch, ImeBridge, KeyboardCall, MAX_EDIT_KEYS, NATIVE_TEXT_MAX_UNITS, TextAction, keyboard_wanted, keys_taken};
pub use input::{HudInput, raw_input};
pub use legacy::Color;
pub use paint::{HudPainter, pixels_per_point};
pub use record::{HudWidget, WidgetRole};
pub use settings_panel::{PanelChange, SettingsPanel, settings_panel};

/// Pinned re-export, so games and the runtime never name egui's version themselves.
pub use egui;
