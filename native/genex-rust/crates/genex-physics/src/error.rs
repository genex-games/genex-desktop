//! The error vocabulary (CONTRACT.md §14): every failure is a typed code, and a failed call changes
//! nothing (§1.5). `detail` is for logs only; callers branch on `code`.

use std::fmt;

/// One error code of §14, spelled on the wire by [`PhysicsError::code`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum PhysicsError {
    /// A malformed key (§3).
    InvalidKey,
    /// A key already in use for its kind.
    DuplicateKey,
    /// A key that names nothing.
    UnknownKey,
    /// A number that is not finite once rounded to f32 (§4.1).
    NonFinite,
    /// A number or field outside its bounds (§4.1).
    OutOfRange,
    /// A degenerate shape (§6.2).
    BadShape,
    /// A trimesh or heightfield on a non-fixed body (§6.2).
    DynamicMesh,
    /// A command for another body type.
    WrongBodyType,
    /// A malformed command in its JSON form (§7.3).
    BadCommand,
    /// Past `limits.bodies`.
    LimitBodies,
    /// Past `limits.collidersPerBody`.
    LimitColliders,
    /// Past `limits.hullVertices`.
    LimitHullVertices,
    /// Past `limits.triangles`.
    LimitTriangles,
    /// Past `limits.joints`.
    LimitJoints,
    /// Past `limits.ccdBodies`.
    LimitCcd,
    /// Past `limits.queriesPerStep`.
    LimitQueries,
    /// Past `limits.staticPieces`.
    LimitStatic,
    /// Past `limits.memoryBytes` (§11.1).
    LimitMemory,
    /// A snapshot that cannot be read (§9.4).
    BadSnapshot,
    /// A snapshot of another build (§9.4).
    BuildMismatch,
    /// A world description of another contract (§4).
    ContractMismatch,
    /// The core failed (§11.3).
    Internal,
}

impl PhysicsError {
    /// Every code, in §14's order.
    pub const ALL: [PhysicsError; 22] = [
        Self::InvalidKey,
        Self::DuplicateKey,
        Self::UnknownKey,
        Self::NonFinite,
        Self::OutOfRange,
        Self::BadShape,
        Self::DynamicMesh,
        Self::WrongBodyType,
        Self::BadCommand,
        Self::LimitBodies,
        Self::LimitColliders,
        Self::LimitHullVertices,
        Self::LimitTriangles,
        Self::LimitJoints,
        Self::LimitCcd,
        Self::LimitQueries,
        Self::LimitStatic,
        Self::LimitMemory,
        Self::BadSnapshot,
        Self::BuildMismatch,
        Self::ContractMismatch,
        Self::Internal,
    ];

    /// The code's exact wire spelling (§14), e.g. `"invalid-key"`.
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidKey => "invalid-key",
            Self::DuplicateKey => "duplicate-key",
            Self::UnknownKey => "unknown-key",
            Self::NonFinite => "non-finite",
            Self::OutOfRange => "out-of-range",
            Self::BadShape => "bad-shape",
            Self::DynamicMesh => "dynamic-mesh",
            Self::WrongBodyType => "wrong-body-type",
            Self::BadCommand => "bad-command",
            Self::LimitBodies => "limit-bodies",
            Self::LimitColliders => "limit-colliders",
            Self::LimitHullVertices => "limit-hull-vertices",
            Self::LimitTriangles => "limit-triangles",
            Self::LimitJoints => "limit-joints",
            Self::LimitCcd => "limit-ccd",
            Self::LimitQueries => "limit-queries",
            Self::LimitStatic => "limit-static",
            Self::LimitMemory => "limit-memory",
            Self::BadSnapshot => "bad-snapshot",
            Self::BuildMismatch => "build-mismatch",
            Self::ContractMismatch => "contract-mismatch",
            Self::Internal => "internal",
        }
    }

    /// The code for a wire spelling, or `None` for any other text.
    pub fn from_code(code: &str) -> Option<PhysicsError> {
        Self::ALL.into_iter().find(|error| error.code() == code)
    }
}

impl fmt::Display for PhysicsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}

/// A failed call (§14): its code, the failing index of an atomic batch, and a log-only detail.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PhysicsFailure {
    /// What failed; the only field a caller branches on.
    pub code: PhysicsError,
    /// The failing command's index in an atomic batch (§7.1).
    pub index: Option<usize>,
    /// Text for logs only.
    pub detail: String,
}

impl PhysicsFailure {
    /// A failure with `code` and a log-only `detail`.
    pub fn new(code: PhysicsError, detail: impl Into<String>) -> Self {
        Self { code, index: None, detail: detail.into() }
    }
}

impl fmt::Display for PhysicsFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.detail)
    }
}

impl std::error::Error for PhysicsFailure {}

/// A shorthand for a failure with `code`.
pub(crate) fn fail<T>(code: PhysicsError, detail: impl Into<String>) -> Result<T, PhysicsFailure> {
    Err(PhysicsFailure::new(code, detail))
}
