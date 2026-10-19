//! `AnimationErrorCode`: why an animation call refused, as a typed code with a wire spelling. Each
//! animation work package adds the codes it refuses with, pins them in the facade vocabulary
//! (`tests/fixtures/rust-facade-vocabulary.json`) and documents them in the same change.

/// Why an animation call refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum AnimationErrorCode {
    /// A rig or clip file that cannot be used: not a GLB, no skin, more than
    /// [`crate::skeleton::MAX_JOINTS`] joints, a node with two parents, a cycle, a joint outside
    /// the scene, an accessor past its data, or a non-finite transform (AN-1).
    AssetInvalid,
}

impl AnimationErrorCode {
    /// Every code, in declaration order.
    pub const ALL: [AnimationErrorCode; 1] = [AnimationErrorCode::AssetInvalid];

    /// The code's wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            AnimationErrorCode::AssetInvalid => "animation-asset-invalid",
        }
    }
}

/// A refused animation call: the code and what was wrong, for a person to read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AnimationError {
    /// What was refused.
    pub code: AnimationErrorCode,
    /// The detail (counts, indices), never matched on.
    pub detail: String,
}

impl AnimationError {
    /// An `animation-asset-invalid` refusal.
    pub fn asset_invalid(detail: impl Into<String>) -> AnimationError {
        AnimationError { code: AnimationErrorCode::AssetInvalid, detail: detail.into() }
    }
}

impl std::fmt::Display for AnimationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code.wire(), self.detail)
    }
}

impl std::error::Error for AnimationError {}
