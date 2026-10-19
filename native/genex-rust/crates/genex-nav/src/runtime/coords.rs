//! Coordinate systems: how a caller's points map into the runtime's standard frame (X right,
//! Y forward, Z up), and how far point sampling reaches.
//!
//! Ported from landmass 0.9.3 `src/coords.rs` (MIT OR Apache-2.0, used under Apache 2.0;
//! crates.io sha256 `fd2fd988b81194c6f02c293a28b510b44f1d8581c80b1bfe498e85e9c3f57b93`).
//! Changed: P6 adds [`GenexCoords`], genex's Y-up frame; `CorePointSampleDistance` is public so
//! the stitching code's callers in this crate can build one.

use glam::{Vec2, Vec3};

/// A coordinate system used to convert from a user-facing coordinate system into the runtime's
/// standard coordinate system, [`XYZ`].
pub trait CoordinateSystem {
    /// The user-facing coordinate type.
    type Coordinate: Clone;
    /// The type to use for point sampling options.
    type SampleDistance: PointSampleDistance;

    /// Whether to flip polygons after conversion.
    ///
    /// The runtime expects counter-clockwise polygons. A coordinate system that flips one axis
    /// turns its counter-clockwise polygons clockwise, and sets this.
    const FLIP_POLYGONS: bool;

    /// Converts a coordinate in this system to the standard coordinate system.
    fn to_landmass(v: &Self::Coordinate) -> Vec3;

    /// Converts a standard coordinate into this system's coordinate.
    fn from_landmass(v: &Vec3) -> Self::Coordinate;
}

/// A trait to create a default instance based on an agent's radius.
pub trait FromAgentRadius {
    /// Creates an instance given the agent's radius.
    fn from_agent_radius(radius: f32) -> Self;
}

/// How far point sampling reaches, horizontally and vertically.
pub trait PointSampleDistance {
    /// The horizontal distance within which a node may be sampled.
    fn horizontal_distance(&self) -> f32;

    /// The vertical distance above the query point within which a node may be sampled. Must be
    /// greater than the negated [`PointSampleDistance::distance_below`] (preferably positive).
    fn distance_above(&self) -> f32;

    /// The vertical distance below the query point within which a node may be sampled. Must be
    /// greater than the negated [`PointSampleDistance::distance_above`] (preferably positive).
    fn distance_below(&self) -> f32;

    /// The ratio between vertical and horizontal distance to prefer: at 2.0 a sample 1.9 below
    /// beats one 1.0 away horizontally. Must be positive.
    fn vertical_preference_ratio(&self) -> f32;

    /// The max vertical distance an animation link may be from the nav mesh and still connect.
    fn animation_link_max_vertical_distance(&self) -> f32;
}

/// The standard coordinate system: X right, Y forward, Z up.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct XYZ;

impl CoordinateSystem for XYZ {
    type Coordinate = Vec3;
    type SampleDistance = PointSampleDistance3d;

    const FLIP_POLYGONS: bool = false;

    fn to_landmass(v: &Self::Coordinate) -> Vec3 {
        *v
    }

    fn from_landmass(v: &Vec3) -> Self::Coordinate {
        *v
    }
}

/// genex's world frame: X right, Y up, −Z forward (right-handed). A point `(x, y, z)` is
/// `(x, −z, y)` in the standard frame: a proper rotation, so counter-clockwise polygons seen from
/// above stay counter-clockwise (no flip). Avoidance (`avoidance.rs`) uses the same mapping.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct GenexCoords;

impl CoordinateSystem for GenexCoords {
    type Coordinate = Vec3;
    type SampleDistance = PointSampleDistance3d;

    const FLIP_POLYGONS: bool = false;

    fn to_landmass(v: &Self::Coordinate) -> Vec3 {
        Vec3::new(v.x, -v.z, v.y)
    }

    fn from_landmass(v: &Vec3) -> Self::Coordinate {
        Vec3::new(v.x, v.z, -v.y)
    }
}

/// A [`PointSampleDistance`] for 3D coordinate systems.
#[derive(Debug, PartialEq, Clone)]
pub struct PointSampleDistance3d {
    /// The horizontal distance within which a node may be sampled.
    pub horizontal_distance: f32,
    /// The vertical distance above the query point within which a node may be sampled.
    pub distance_above: f32,
    /// The vertical distance below the query point within which a node may be sampled.
    pub distance_below: f32,
    /// The ratio between vertical and horizontal distance to prefer. Must be positive.
    pub vertical_preference_ratio: f32,
    /// The max vertical distance an animation link may be from the nav mesh and still connect.
    pub animation_link_max_vertical_distance: f32,
}

impl PointSampleDistance for PointSampleDistance3d {
    fn horizontal_distance(&self) -> f32 {
        self.horizontal_distance
    }
    fn distance_above(&self) -> f32 {
        self.distance_above
    }
    fn distance_below(&self) -> f32 {
        self.distance_below
    }
    fn vertical_preference_ratio(&self) -> f32 {
        self.vertical_preference_ratio
    }
    fn animation_link_max_vertical_distance(&self) -> f32 {
        self.animation_link_max_vertical_distance
    }
}

impl FromAgentRadius for PointSampleDistance3d {
    fn from_agent_radius(radius: f32) -> Self {
        Self {
            horizontal_distance: 0.2 * radius,
            distance_above: 0.5 * radius,
            distance_below: radius,
            vertical_preference_ratio: 2.0,
            animation_link_max_vertical_distance: 0.5 * radius,
        }
    }
}

/// A 2D coordinate system: X right, Y forward.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct XY;

impl CoordinateSystem for XY {
    type Coordinate = Vec2;
    type SampleDistance = f32;

    const FLIP_POLYGONS: bool = false;

    fn to_landmass(v: &Self::Coordinate) -> Vec3 {
        Vec3::new(v.x, v.y, 0.0)
    }

    fn from_landmass(v: &Vec3) -> Self::Coordinate {
        Vec2::new(v.x, v.y)
    }
}

impl PointSampleDistance for f32 {
    fn horizontal_distance(&self) -> f32 {
        *self
    }
    fn distance_above(&self) -> f32 {
        1.0
    }
    fn distance_below(&self) -> f32 {
        1.0
    }
    fn vertical_preference_ratio(&self) -> f32 {
        1.0
    }
    fn animation_link_max_vertical_distance(&self) -> f32 {
        1.0
    }
}

impl FromAgentRadius for f32 {
    fn from_agent_radius(radius: f32) -> Self {
        0.2 * radius
    }
}

/// An evaluated [`PointSampleDistance`].
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CorePointSampleDistance {
    /// See [`PointSampleDistance::horizontal_distance`].
    pub horizontal_distance: f32,
    /// See [`PointSampleDistance::distance_above`].
    pub distance_above: f32,
    /// See [`PointSampleDistance::distance_below`].
    pub distance_below: f32,
    /// See [`PointSampleDistance::vertical_preference_ratio`].
    pub vertical_preference_ratio: f32,
}

impl CorePointSampleDistance {
    /// Evaluates `point_sample_distance`.
    pub fn new<T: PointSampleDistance>(point_sample_distance: &T) -> Self {
        Self {
            horizontal_distance: point_sample_distance.horizontal_distance(),
            distance_above: point_sample_distance.distance_above(),
            distance_below: point_sample_distance.distance_below(),
            vertical_preference_ratio: point_sample_distance.vertical_preference_ratio(),
        }
    }
}
