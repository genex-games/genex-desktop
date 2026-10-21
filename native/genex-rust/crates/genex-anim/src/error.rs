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
    /// An animation graph that cannot run: no layer, a layer with no state, a transition across
    /// layers, a name used twice, a handle of another graph, a NaN or negative blend time, a NaN
    /// threshold, or more than a cap (AN-5, `graph.rs`).
    GraphInvalid,
    /// A ragdoll that cannot be built: a profile [`crate::ragdoll_profile::RagdollProfile::check`]
    /// refuses, a profile bone or tip the rig's humanoid map lacks, or a bone of zero length
    /// (AN-20).
    RagdollProfileInvalid,
    /// A retarget between rigs one of which lacks a humanoid bone the retarget needs (every
    /// profile bone but the toes), named with the rig it is missing from (AN-12).
    RetargetUnmapped,
}

impl AnimationErrorCode {
    /// Every code, in declaration order.
    pub const ALL: [AnimationErrorCode; 4] = [AnimationErrorCode::AssetInvalid, AnimationErrorCode::GraphInvalid, AnimationErrorCode::RagdollProfileInvalid, AnimationErrorCode::RetargetUnmapped];

    /// The code's wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            AnimationErrorCode::AssetInvalid => "animation-asset-invalid",
            AnimationErrorCode::GraphInvalid => "animation-graph-invalid",
            AnimationErrorCode::RagdollProfileInvalid => "ragdoll-profile-invalid",
            AnimationErrorCode::RetargetUnmapped => "animation-retarget-unmapped",
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

    /// A `ragdoll-profile-invalid` refusal.
    pub fn ragdoll_profile_invalid(detail: impl Into<String>) -> AnimationError {
        AnimationError { code: AnimationErrorCode::RagdollProfileInvalid, detail: detail.into() }
    }

    /// An `animation-retarget-unmapped` refusal.
    pub fn retarget_unmapped(detail: impl Into<String>) -> AnimationError {
        AnimationError { code: AnimationErrorCode::RetargetUnmapped, detail: detail.into() }
    }

    /// An `animation-graph-invalid` refusal.
    pub fn graph_invalid(detail: impl Into<String>) -> AnimationError {
        AnimationError { code: AnimationErrorCode::GraphInvalid, detail: detail.into() }
    }
}

impl std::fmt::Display for AnimationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code.wire(), self.detail)
    }
}

impl std::error::Error for AnimationError {}
