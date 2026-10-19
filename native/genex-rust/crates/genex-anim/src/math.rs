//! Pose math: a joint's local transform as translation, rotation and scale, and the one
//! quaternion rule every animation step shares (normalize, then pick the hemisphere of a
//! reference), so blends and samplers never disagree on which of `q` and `-q` they meant.
//! glam runs scalar libm math across the lock (workspace `Cargo.toml`), so these give the same
//! bits on every destination.

use glam::{Mat4, Quat, Vec3};

/// A joint's local transform: scale, then rotate, then translate.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Trs {
    /// Translation.
    pub translation: Vec3,
    /// Rotation.
    pub rotation: Quat,
    /// Scale.
    pub scale: Vec3,
}

impl Trs {
    /// No transform.
    pub const IDENTITY: Trs = Trs { translation: Vec3::ZERO, rotation: Quat::IDENTITY, scale: Vec3::ONE };

    /// From glTF arrays: translation, rotation xyzw, scale (taken as written: the importer
    /// checks them, the samplers normalize what they produce).
    pub fn from_arrays(translation: [f32; 3], rotation: [f32; 4], scale: [f32; 3]) -> Trs {
        Trs { translation: Vec3::from(translation), rotation: Quat::from_array(rotation), scale: Vec3::from(scale) }
    }

    /// The matrix: scale, then rotate, then translate (genex-render's `Trs::matrix`, bit for bit).
    pub fn matrix(&self) -> Mat4 {
        Mat4::from_scale_rotation_translation(self.scale, self.rotation, self.translation)
    }

    /// Every component is finite.
    pub fn is_finite(&self) -> bool {
        self.translation.is_finite() && self.rotation.is_finite() && self.scale.is_finite()
    }
}

/// `q` at unit length; a zero or non-finite quaternion becomes the identity.
pub fn normalize_quat(q: Quat) -> Quat {
    let length_squared = q.length_squared();
    if !length_squared.is_finite() || length_squared <= f32::MIN_POSITIVE {
        return Quat::IDENTITY;
    }
    q * (1.0 / length_squared.sqrt())
}

/// `q` or `-q`, whichever lies in the hemisphere of `reference` (the same rotation), so an
/// interpolation from `reference` takes the short way.
pub fn same_hemisphere(q: Quat, reference: Quat) -> Quat {
    if q.dot(reference) < 0.0 { -q } else { q }
}

