//! The value types every call shares (CONTRACT.md §3, §5, §15): vectors, quaternions and poses in the
//! caller frame, body types and axes.
//!
//! Numbers a caller passes are `f64`, as JavaScript numbers are: the core rounds each to f32 on entry
//! (§4.1). Numbers the core returns are `f64` too, each holding an f32 value exactly.

/// A vector in the caller frame (§5).
pub type Vec3 = [f64; 3];
/// A quaternion `[x, y, z, w]` in the caller frame (§15).
pub type Quat = [f64; 4];

/// The identity rotation.
pub const QUAT_IDENTITY: Quat = [0.0, 0.0, 0.0, 1.0];

/// A position and rotation in the caller frame.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Pose {
    /// The position.
    pub p: Vec3,
    /// The rotation, `[x, y, z, w]`; |q| within 1e-4 of 1 (§6.1).
    pub q: Quat,
}

impl Pose {
    /// A pose at `p` with the identity rotation.
    pub fn at(p: Vec3) -> Self {
        Self { p, q: QUAT_IDENTITY }
    }
}

/// A body type (§6.1); its stateHash byte is [`BodyType::hash_byte`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum BodyType {
    /// Moved by the solver.
    Dynamic,
    /// Moved only by `setPose`.
    Fixed,
    /// Moved only by `setNextKinematicPose`.
    Kinematic,
}

impl BodyType {
    /// The wire spelling (`"dynamic"`, `"fixed"`, `"kinematic"`).
    pub fn name(self) -> &'static str {
        match self {
            Self::Dynamic => "dynamic",
            Self::Fixed => "fixed",
            Self::Kinematic => "kinematic",
        }
    }

    /// The u8 stateHash writes for the type (§10.1: dynamic 0, fixed 1, kinematic 2).
    pub fn hash_byte(self) -> u8 {
        match self {
            Self::Dynamic => 0,
            Self::Fixed => 1,
            Self::Kinematic => 2,
        }
    }
}

/// The caller's up axis (§5).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum UpAxis {
    /// Y up: no mapping.
    Y,
    /// Z up (the authority server): mapped to the core's Y-up frame bit for bit.
    Z,
}

impl UpAxis {
    /// The wire spelling (`"y"` or `"z"`).
    pub fn name(self) -> &'static str {
        match self {
            Self::Y => "y",
            Self::Z => "z",
        }
    }
}

/// A coordinate axis in the caller frame (a capsule's axis, §6.2).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Axis {
    /// The x axis.
    X,
    /// The y axis.
    Y,
    /// The z axis.
    Z,
}
