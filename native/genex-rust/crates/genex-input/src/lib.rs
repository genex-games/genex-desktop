//! genex-input: input actions for genex games, below the facade. Game code reads actions (`jump`,
//! `move`), never keys: bindings map devices to actions, contexts with priorities consume or pass
//! them on, conditions and modifiers run in ticks, and the whole evaluation is a pure function of
//! the tick's merged device state, so a replay presses exactly what the run pressed. Touch
//! controls, rebinding, the journal and the prompt glyphs ride on the same action map.
//!
//! Every planned module is declared now so each work package fills one body (G6 input, IN-0); a
//! module that names its work package is still a stub.

pub mod id;
pub mod error;
pub mod binding;
pub mod condition;
pub mod modifier;
pub mod map;
pub mod state;
pub mod ui;
pub mod access;
pub mod blob;
pub mod capture;
pub mod rebind;
pub mod journal;
pub mod track;
pub mod touch;
pub mod glyph;
pub mod wire;
pub mod atlas;
// The controls panel and the touch-control painter draw with egui.
#[cfg(feature = "panel")]
pub mod paint;
#[cfg(feature = "panel")]
pub mod panel;
