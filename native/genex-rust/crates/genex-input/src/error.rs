//! Refusals: every way an action map, a bindings file, a track or a wire payload is turned away,
//! as a typed code in its exact wire spelling plus a human detail. Callers branch on the code,
//! never on the detail text.

use std::fmt;

use crate::id::ActionId;

/// Why genex-input refused something. The wire spelling (`as_str`) is what `state().__input`, a
/// build problem and the docs print.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum InputErrorCode {
    /// An action or context name is not lowercase letters, digits and `_` of at most 32 bytes, or a
    /// condition or modifier names an action or a parameter that cannot work.
    ActionInvalid,
    /// The same action id is declared twice in one map.
    ActionDuplicate,
    /// The same context id is declared twice in one map.
    ContextDuplicate,
    /// A binding cannot drive its action's kind (a stick on a button, a chord on an axis).
    BindingMismatch,
    /// Two actions of one context read the same input.
    BindingConflict,
    /// A binding the system keeps (`key:Escape`, `pad:home`) outside the built-in `ui` context.
    BindingReserved,
    /// The map has more actions, contexts or bindings per action than the caps allow.
    MapTooLarge,
    /// Accessibility settings out of range (a dead zone of 2.0, a release at or above the press).
    AccessInvalid,
    /// A bindings file that is not a `genex-input/1` file within the caps.
    BindingsInvalid,
    /// A bindings file has rows for actions the map no longer declares; the rest applied.
    BindingsStale,
    /// An input track that cannot be read.
    TrackInvalid,
    /// An input track over the journal cap.
    TrackTooLarge,
    /// An input track recorded for another seed, contract, world size or bindings.
    TrackMismatch,
    /// Touch controls that do not fit the world or repeat an id.
    TouchControlsInvalid,
    /// A multiplayer action payload that cannot be read against this map.
    WireInvalid,
}

impl InputErrorCode {
    /// Every code, in declaration order.
    pub const ALL: [InputErrorCode; 15] = [
        InputErrorCode::ActionInvalid,
        InputErrorCode::ActionDuplicate,
        InputErrorCode::ContextDuplicate,
        InputErrorCode::BindingMismatch,
        InputErrorCode::BindingConflict,
        InputErrorCode::BindingReserved,
        InputErrorCode::MapTooLarge,
        InputErrorCode::AccessInvalid,
        InputErrorCode::BindingsInvalid,
        InputErrorCode::BindingsStale,
        InputErrorCode::TrackInvalid,
        InputErrorCode::TrackTooLarge,
        InputErrorCode::TrackMismatch,
        InputErrorCode::TouchControlsInvalid,
        InputErrorCode::WireInvalid,
    ];

    /// The wire spelling.
    pub const fn as_str(self) -> &'static str {
        match self {
            InputErrorCode::ActionInvalid => "input-action-invalid",
            InputErrorCode::ActionDuplicate => "input-action-duplicate",
            InputErrorCode::ContextDuplicate => "input-context-duplicate",
            InputErrorCode::BindingMismatch => "input-binding-mismatch",
            InputErrorCode::BindingConflict => "input-binding-conflict",
            InputErrorCode::BindingReserved => "input-binding-reserved",
            InputErrorCode::MapTooLarge => "input-map-too-large",
            InputErrorCode::AccessInvalid => "input-access-invalid",
            InputErrorCode::BindingsInvalid => "input-bindings-invalid",
            InputErrorCode::BindingsStale => "input-bindings-stale",
            InputErrorCode::TrackInvalid => "input-track-invalid",
            InputErrorCode::TrackTooLarge => "input-track-too-large",
            InputErrorCode::TrackMismatch => "input-track-mismatch",
            InputErrorCode::TouchControlsInvalid => "touch-controls-invalid",
            InputErrorCode::WireInvalid => "input-wire-invalid",
        }
    }

    /// The code a wire spelling names; an unknown spelling answers `None`.
    pub fn from_wire(name: &str) -> Option<InputErrorCode> {
        InputErrorCode::ALL.into_iter().find(|code| code.as_str() == name)
    }
}

impl fmt::Display for InputErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A refusal: the code, what was refused, and for a conflict the action that already reads the
/// input.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InputError {
    /// Why.
    pub code: InputErrorCode,
    /// What, for a person (never matched on).
    pub detail: String,
    /// The action that already holds the input, for `input-binding-conflict`.
    pub clash: Option<ActionId>,
}

impl InputError {
    /// A refusal with no clashing action.
    pub fn new(code: InputErrorCode, detail: impl Into<String>) -> InputError {
        InputError { code, detail: detail.into(), clash: None }
    }

    /// The same refusal naming the action that holds the input.
    pub fn with_clash(self, clash: ActionId) -> InputError {
        InputError { clash: Some(clash), ..self }
    }
}

impl fmt::Display for InputError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.detail)
    }
}

impl std::error::Error for InputError {}
