//! `NavErrorCode`: why a navigation call refused, as a typed code with a wire spelling. Each
//! navigation work package adds the codes it refuses with, pins them in the facade vocabulary
//! (`tests/fixtures/rust-facade-vocabulary.json`) and documents them in the same change.

/// Why a navigation call refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum NavErrorCode {
    /// Bake input that cannot be used: an index past the vertices, an index count that is not a
    /// multiple of 3, a non-finite vertex, placement, height or bound, an area outline that is
    /// not a convex polygon of 3 to [`crate::input::NAV_AREA_OUTLINE_POINTS_MAX`] points, a prism
    /// whose `min_y` is above its `max_y`, a terrain grid that is not usable, or a second terrain
    /// (NAV-3, `input.rs`).
    InputInvalid,
    /// Bake input over a cap: more than [`crate::input::NAV_INPUT_TRIANGLES_MAX`] triangles or
    /// [`crate::input::NAV_AREA_VOLUMES_MAX`] area volumes (NAV-3, `input.rs`).
    TooLarge,
    /// An off-mesh link that cannot attach: a non-finite end or cost, a negative cost, or an end
    /// farther than the sample reach and `animation_link_max_vertical_distance` from every mesh
    /// (NAV-8, `links.rs`).
    LinkInvalid,
}

impl NavErrorCode {
    /// Every code, in declaration order.
    pub const ALL: [NavErrorCode; 3] = [NavErrorCode::InputInvalid, NavErrorCode::TooLarge, NavErrorCode::LinkInvalid];

    /// The code's wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            NavErrorCode::InputInvalid => "nav-input-invalid",
            NavErrorCode::TooLarge => "nav-too-large",
            NavErrorCode::LinkInvalid => "nav-link-invalid",
        }
    }
}

/// A refused navigation call: the code and what was wrong, for a person to read. Nothing changed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NavError {
    /// What was refused.
    pub code: NavErrorCode,
    /// The detail (counts, indices), never matched on.
    pub detail: String,
}

impl NavError {
    /// A `nav-input-invalid` refusal.
    pub fn input_invalid(detail: impl Into<String>) -> NavError {
        NavError { code: NavErrorCode::InputInvalid, detail: detail.into() }
    }

    /// A `nav-too-large` refusal.
    pub fn too_large(detail: impl Into<String>) -> NavError {
        NavError { code: NavErrorCode::TooLarge, detail: detail.into() }
    }

    /// A `nav-link-invalid` refusal.
    pub fn link_invalid(detail: impl Into<String>) -> NavError {
        NavError { code: NavErrorCode::LinkInvalid, detail: detail.into() }
    }
}

impl std::fmt::Display for NavError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code.wire(), self.detail)
    }
}

impl std::error::Error for NavError {}
