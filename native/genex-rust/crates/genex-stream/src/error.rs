//! `StreamErrorCode`: why a streaming call refused, as a typed code with a wire spelling. Each
//! streaming work package adds the codes it refuses with, pins them in the facade vocabulary
//! (`tests/fixtures/rust-facade-vocabulary.json`) and documents them in the same change.
//!
//! `StreamViewCode` is the other vocabulary: why a streamed cell or asset of the view set was
//! refused. Those are display state, reported in `state().volatile.stream.refused`, never a call's
//! refusal; the cell pack codes are pinned by `tests/fixtures/stream/cell-pack-v1.json`.

/// Why a streaming call refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum StreamErrorCode {
    /// A size, radius, count or position out of range, or not finite (STR-8, `grid.rs`).
    Invalid,
    /// More anchors than [`crate::grid::STREAM_ANCHORS_MAX`] (STR-8, `grid.rs`).
    TooManyAnchors,
    /// An anchor outside the world: past [`crate::grid::STREAM_WORLD_EXTENT_MAX`] from the origin
    /// on either axis (STR-8, `grid.rs`).
    OutOfWorld,
}

impl StreamErrorCode {
    /// Every code, in declaration order.
    pub const ALL: [StreamErrorCode; 3] = [StreamErrorCode::Invalid, StreamErrorCode::TooManyAnchors, StreamErrorCode::OutOfWorld];

    /// The code's wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            StreamErrorCode::Invalid => "stream-invalid",
            StreamErrorCode::TooManyAnchors => "stream-too-many-anchors",
            StreamErrorCode::OutOfWorld => "stream-out-of-world",
        }
    }
}

/// A refused streaming call: the code and what was wrong, for a person to read. Nothing changed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StreamError {
    /// What was refused.
    pub code: StreamErrorCode,
    /// The detail (values, limits), never matched on.
    pub detail: String,
}

impl StreamError {
    /// A refusal with `code`.
    pub fn new(code: StreamErrorCode, detail: impl Into<String>) -> StreamError {
        StreamError { code, detail: detail.into() }
    }
}

impl std::fmt::Display for StreamError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code.wire(), self.detail)
    }
}

impl std::error::Error for StreamError {}

/// Why a streamed cell or asset of the view set was refused (display state, never a call's
/// refusal).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum StreamViewCode {
    /// A cell pack that cannot be used: `world.json` or a cell body malformed, truncated, of an
    /// unknown version, over a cap, or naming a path that escapes `assets/` (STR-24, `pack.rs`).
    PackInvalid,
    /// A cell body whose FNV-1a 64 is not the one `world.json` lists (STR-24, `pack.rs`).
    PackDigest,
}

impl StreamViewCode {
    /// Every code, in declaration order.
    pub const ALL: [StreamViewCode; 2] = [StreamViewCode::PackInvalid, StreamViewCode::PackDigest];

    /// The code's wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            StreamViewCode::PackInvalid => "stream-pack-invalid",
            StreamViewCode::PackDigest => "stream-pack-digest",
        }
    }
}
