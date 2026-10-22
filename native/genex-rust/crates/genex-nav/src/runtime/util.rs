//! Bounding boxes, a bounding-box hierarchy, ray segments, an ordered float and the island
//! transform (translation plus a turn about the up axis).
//!
//! Ported from landmass 0.9.3 `src/util.rs` (MIT OR Apache-2.0, used under Apache 2.0). Changed:
//! formatting only; the hierarchy sorts with the stable `sort_by_key` upstream already used, so
//! equal centres keep their input order on every run.

use core::cmp::Ordering;
use core::mem::swap;
use core::ops::Deref;

use glam::{Quat, Vec3};

use super::coords::CoordinateSystem;

/// An f32 that supports `Ord` (NaN sorts last).
pub(crate) struct FloatOrd(pub(crate) f32);

impl PartialEq for FloatOrd {
    fn eq(&self, other: &Self) -> bool {
        if self.0.is_nan() {
            return other.0.is_nan();
        }
        self.0 == other.0
    }
}

impl Eq for FloatOrd {}

impl PartialOrd for FloatOrd {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for FloatOrd {
    fn cmp(&self, other: &Self) -> Ordering {
        if self.0.is_nan() {
            return if other.0.is_nan() { Ordering::Equal } else { Ordering::Greater };
        }
        if self.0 > other.0 {
            Ordering::Greater
        } else if self.0 == other.0 {
            Ordering::Equal
        } else {
            // Also other = NaN: other is neither smaller nor equal.
            Ordering::Less
        }
    }
}

impl Deref for FloatOrd {
    type Target = f32;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

/// A bounding box.
#[derive(PartialEq, Clone, Copy, Debug)]
pub(crate) enum BoundingBox {
    /// The bounding box has no points in it.
    Empty,
    /// The bounding box has some points in it.
    Box {
        /// The minimum bounds.
        min: Vec3,
        /// The maximum bounds, component-wise at least `min`.
        max: Vec3,
    },
}

impl BoundingBox {
    /// A box from valid `min` and `max` (unchecked).
    pub(crate) fn new_box(min: Vec3, max: Vec3) -> Self {
        Self::Box { min, max }
    }

    /// Whether the box is empty.
    pub(crate) fn is_empty(&self) -> bool {
        matches!(self, Self::Empty)
    }

    /// The centre, when non-empty.
    pub(crate) fn center(&self) -> Option<Vec3> {
        match self {
            Self::Empty => None,
            &Self::Box { min, max } => Some((min + max) * 0.5),
        }
    }

    /// The size (zero when empty).
    pub(crate) fn size(&self) -> Vec3 {
        match self {
            Self::Empty => Vec3::ZERO,
            &Self::Box { min, max } => max - min,
        }
    }

    /// Whether min <= max on every axis.
    pub(crate) fn is_valid(&self) -> bool {
        let size = self.size();
        size.x >= 0.0 && size.y >= 0.0 && size.z >= 0.0
    }

    /// The box grown to contain `other`.
    pub(crate) fn expand_to_bounds(&self, other: &Self) -> Self {
        match (self, other) {
            (Self::Empty, Self::Empty) => Self::Empty,
            (Self::Box { .. }, Self::Empty) => *self,
            (Self::Empty, Self::Box { .. }) => *other,
            (Self::Box { min, max }, Self::Box { min: other_min, max: other_max }) => {
                Self::Box { min: min.min(*other_min), max: max.max(*other_max) }
            }
        }
    }

    /// The box grown to contain `point` (only `point` when it was empty).
    pub(crate) fn expand_to_point(&self, point: Vec3) -> Self {
        match self {
            Self::Empty => Self::Box { min: point, max: point },
            &Self::Box { min, max } => Self::Box { min: min.min(point), max: max.max(point) },
        }
    }

    /// The box grown by `size` on every side (an empty box stays empty).
    pub(crate) fn expand_by_size(&self, size: Vec3) -> BoundingBox {
        self.add_to_corners(-size, size)
    }

    /// `delta_min` added to the min corner and `delta_max` to the max corner; empty when that
    /// inverts the box.
    pub(crate) fn add_to_corners(&self, delta_min: Vec3, delta_max: Vec3) -> BoundingBox {
        let expanded_box = match self {
            BoundingBox::Empty => BoundingBox::Empty,
            &BoundingBox::Box { min, max } => BoundingBox::Box { min: min + delta_min, max: max + delta_max },
        };
        if !expanded_box.is_valid() {
            return BoundingBox::Empty;
        }
        expanded_box
    }

    /// Whether `point` is inside.
    pub(crate) fn contains_point(&self, point: Vec3) -> bool {
        match self {
            Self::Empty => false,
            Self::Box { min, max } => min.cmple(point).all() && point.cmple(*max).all(),
        }
    }

    /// Whether `other` touches this box at all.
    pub(crate) fn intersects_bounds(&self, other: &Self) -> bool {
        let (other_min, other_max) = match other {
            Self::Empty => return false,
            Self::Box { min, max } => (min, max),
        };
        match self {
            Self::Empty => false,
            Self::Box { min, max } => min.cmple(*other_max).all() && other_min.cmple(*max).all(),
        }
    }

    /// Whether the segment touches this box (slab test).
    pub(crate) fn intersects_ray_segment(&self, ray: &RaySegment) -> bool {
        let (min, max) = match self {
            Self::Empty => return false,
            Self::Box { min, max } => (*min, *max),
        };
        // After https://www.scratchapixel.com/lessons/3d-basic-rendering/minimal-ray-tracer-rendering-simple-shapes/ray-box-intersection.html
        let sign = [ray.sign[0] as usize, ray.sign[1] as usize, ray.sign[2] as usize];
        let bounds_x = [min.x, max.x];
        let bounds_y = [min.y, max.y];
        let bounds_z = [min.z, max.z];

        let mut tmin: f32 = (bounds_x[sign[0]] - ray.origin.x) * ray.inv_dir.x;
        let mut tmax: f32 = (bounds_x[1 - sign[0]] - ray.origin.x) * ray.inv_dir.x;
        if tmin >= 1.0 || tmax <= 0.0 {
            return false;
        }

        let tymin = (bounds_y[sign[1]] - ray.origin.y) * ray.inv_dir.y;
        let tymax = (bounds_y[1 - sign[1]] - ray.origin.y) * ray.inv_dir.y;
        if (tmin > tymax) || (tymin > tmax) {
            return false;
        }
        tmin = tmin.max(tymin);
        tmax = tmax.min(tymax);
        if tmin >= 1.0 || tmax <= 0.0 {
            return false;
        }

        let tzmin = (bounds_z[sign[2]] - ray.origin.z) * ray.inv_dir.z;
        let tzmax = (bounds_z[1 - sign[2]] - ray.origin.z) * ray.inv_dir.z;
        if (tmin > tzmax) || (tzmin > tmax) {
            return false;
        }
        tmin = tmin.max(tzmin);
        tmax = tmax.min(tzmax);
        tmin < 1.0 && tmax > 0.0
    }

    /// A conservative box around this one after `transform`.
    pub(crate) fn transform<CS: CoordinateSystem>(&self, transform: &Transform<CS>) -> Self {
        let (min, max) = match self {
            BoundingBox::Empty => return BoundingBox::Empty,
            BoundingBox::Box { min, max } => (min, max),
        };
        let points = [
            transform.apply(*min),
            transform.apply(Vec3::new(max.x, max.y, min.z)),
            transform.apply(Vec3::new(min.x, max.y, min.z)),
            transform.apply(Vec3::new(max.x, min.y, min.z)),
        ];
        let low = points[1..].iter().fold(points[0], |acc, p| acc.min(*p));
        let high = points[1..].iter().fold(points[0], |acc, p| acc.max(*p));
        BoundingBox::Box {
            min: Vec3::new(low.x, low.y, points[0].z),
            max: Vec3::new(high.x, high.y, points[0].z + (max.z - min.z)),
        }
    }
}

/// A transform of an island: a translation and a turn about the up axis.
pub struct Transform<CS: CoordinateSystem> {
    /// The translation to apply.
    pub translation: CS::Coordinate,
    /// The rotation about the up direction (perpendicular to the plane of movement), in radians.
    pub rotation: f32,
}

// Manual impls avoid bounds on `CS` itself.
impl<CS: CoordinateSystem> Clone for Transform<CS> {
    fn clone(&self) -> Self {
        Self { translation: self.translation.clone(), rotation: self.rotation }
    }
}

impl<CS: CoordinateSystem<Coordinate: core::fmt::Debug>> core::fmt::Debug for Transform<CS> {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("Transform").field("translation", &self.translation).field("rotation", &self.rotation).finish()
    }
}

impl<CS: CoordinateSystem<Coordinate: Default>> Default for Transform<CS> {
    fn default() -> Self {
        Self { translation: Default::default(), rotation: Default::default() }
    }
}

impl<CS: CoordinateSystem<Coordinate: PartialEq>> PartialEq for Transform<CS> {
    fn eq(&self, other: &Self) -> bool {
        self.translation == other.translation && self.rotation == other.rotation
    }
}

impl<CS: CoordinateSystem> Transform<CS> {
    /// Applies the transformation to a standard-frame point. glam's scalar-math and libm build
    /// gives the same bits on every destination.
    pub fn apply(&self, point: Vec3) -> Vec3 {
        Quat::from_rotation_z(self.rotation) * point + CS::to_landmass(&self.translation)
    }

    /// [`Transform::apply`] with its rotation made once, for many points (the same bits).
    pub(crate) fn applier(&self) -> impl Fn(Vec3) -> Vec3 + use<CS> {
        let rotation = Quat::from_rotation_z(self.rotation);
        let translation = CS::to_landmass(&self.translation);
        move |point| rotation * point + translation
    }

    /// Undoes the transformation.
    pub fn apply_inverse(&self, point: Vec3) -> Vec3 {
        Quat::from_rotation_z(-self.rotation) * (point - CS::to_landmass(&self.translation))
    }
}

/// A bounding-box hierarchy over values.
#[derive(Clone)]
pub(crate) enum BoundingBoxHierarchy<ValueType> {
    Leaf { bounds: BoundingBox, value: ValueType },
    Branch { bounds: BoundingBox, children: Box<(BoundingBoxHierarchy<ValueType>, BoundingBoxHierarchy<ValueType>)> },
}

impl<ValueType> BoundingBoxHierarchy<ValueType> {
    /// A hierarchy from values and their boxes; every value must be `Some` and is moved in.
    ///
    /// # Panics
    ///
    /// When `values` is empty or holds a `None`.
    pub(crate) fn new(values: &mut [(BoundingBox, Option<ValueType>)]) -> Self {
        assert!(!values.is_empty());
        if values.len() == 1 {
            let mut value = (BoundingBox::Empty, None);
            swap(&mut values[0], &mut value);
            return Self::Leaf { bounds: value.0, value: value.1.expect("a value per box") };
        }

        let bounding_box = values.iter().map(|v| &v.0).fold(BoundingBox::Empty, |acc, b| acc.expand_to_bounds(b));
        let bounds_size = bounding_box.size();
        let centre = |v: &(BoundingBox, Option<ValueType>)| v.0.center().unwrap_or(Vec3::ZERO);
        if bounds_size.x > bounds_size.y && bounds_size.x > bounds_size.z {
            values.sort_by_key(|v| FloatOrd(centre(v).x));
        } else if bounds_size.y > bounds_size.z {
            values.sort_by_key(|v| FloatOrd(centre(v).y));
        } else {
            values.sort_by_key(|v| FloatOrd(centre(v).z));
        }

        let split_index = values.len() / 2;
        Self::Branch {
            bounds: bounding_box,
            children: Box::new((Self::new(&mut values[..split_index]), Self::new(&mut values[split_index..]))),
        }
    }

    /// The values whose boxes touch `query`.
    pub(crate) fn query_box(&self, query: BoundingBox) -> Vec<&ValueType> {
        let mut result = Vec::new();
        if let BoundingBox::Box { .. } = &query {
            self.query_box_recursive(&query, &mut result);
        }
        result
    }

    fn query_box_recursive<'a>(&'a self, query: &BoundingBox, result: &mut Vec<&'a ValueType>) {
        match self {
            Self::Leaf { bounds, value } => {
                if query.intersects_bounds(bounds) {
                    result.push(value);
                }
            }
            Self::Branch { bounds, children } => {
                if query.intersects_bounds(bounds) {
                    children.0.query_box_recursive(query, result);
                    children.1.query_box_recursive(query, result);
                }
            }
        }
    }

    /// The values whose boxes the segment touches.
    pub(crate) fn query_ray_segment(&self, query: RaySegment) -> Vec<&ValueType> {
        let mut result = Vec::new();
        self.query_ray_segment_recursive(&query, &mut result);
        result
    }

    fn query_ray_segment_recursive<'a>(&'a self, query: &RaySegment, result: &mut Vec<&'a ValueType>) {
        match self {
            Self::Leaf { bounds, value } => {
                if bounds.intersects_ray_segment(query) {
                    result.push(value);
                }
            }
            Self::Branch { bounds, children } => {
                if bounds.intersects_ray_segment(query) {
                    children.0.query_ray_segment_recursive(query, result);
                    children.1.query_ray_segment_recursive(query, result);
                }
            }
        }
    }
}

/// A segment prepared for slab tests.
#[derive(Clone, Copy)]
pub(crate) struct RaySegment {
    origin: Vec3,
    inv_dir: Vec3,
    sign: [u8; 3],
}

impl RaySegment {
    /// The segment from `line_0` to `line_1` (they must differ).
    pub(crate) fn new(line_0: Vec3, line_1: Vec3) -> Self {
        let dir = line_1 - line_0;
        debug_assert_ne!(dir, Vec3::ZERO);
        let inv_dir = 1.0 / dir;
        Self { origin: line_0, inv_dir, sign: [u8::from(dir.x < 0.0), u8::from(dir.y < 0.0), u8::from(dir.z < 0.0)] }
    }
}
