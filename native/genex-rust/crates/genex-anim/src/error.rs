//! `AnimationErrorCode`: why an animation call refused, as a typed code with a wire spelling. It has no codes yet: each
//! animation work package adds the codes it refuses with, pins them in the facade vocabulary
//! (`tests/fixtures/rust-facade-vocabulary.json`) and documents them in the same change.

/// Why an animation call refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum AnimationErrorCode {}

impl AnimationErrorCode {
    /// Every code, in declaration order.
    pub const ALL: [AnimationErrorCode; 0] = [];

    /// The code's wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {}
    }
}
