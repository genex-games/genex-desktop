//! `StreamErrorCode`: why a streaming call refused, as a typed code with a wire spelling. It has no codes yet: each
//! streaming work package adds the codes it refuses with, pins them in the facade vocabulary
//! (`tests/fixtures/rust-facade-vocabulary.json`) and documents them in the same change.

/// Why a streaming call refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum StreamErrorCode {}

impl StreamErrorCode {
    /// Every code, in declaration order.
    pub const ALL: [StreamErrorCode; 0] = [];

    /// The code's wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {}
    }
}
