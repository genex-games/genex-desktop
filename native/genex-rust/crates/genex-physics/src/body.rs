//! Bodies and colliders as a caller describes them (CONTRACT.md §6.1, §6.2), and their validation
//! into the backend's specs: keys, f32 rounding, bounds, shapes and the z-up mapping.

use crate::axes::{flags_in, quat_in, vec_in};
use crate::backend::{BodySpec, ColliderSpec, MassSpec, ShapeSpec};
use crate::error::{PhysicsError, PhysicsFailure, fail};
use crate::key::{check_kind, check_object_key};
use crate::limits::Limits;
use crate::num::{finite, finite_vec, integer, length_squared, non_negative, unit_quat};
use crate::shape::{ShapeFacts, validate_shape};
use crate::types::{Axis, BodyType, Pose, UpAxis, Vec3};

/// The default collider density, kg per caller-unit³.
pub const DEFAULT_DENSITY: f32 = 1.0;
/// The default friction.
pub const DEFAULT_FRICTION: f32 = 0.5;
/// The default restitution.
pub const DEFAULT_RESTITUTION: f32 = 0.0;
/// The largest group mask (16 bits); also the default "all".
pub const GROUPS_ALL: u32 = 0xFFFF;

/// A collider shape (§6.2), in the caller frame.
#[derive(Clone, Debug, PartialEq)]
pub enum Shape {
    /// A box by its half-extents.
    Box {
        /// Half-extents per caller axis.
        half: Vec3,
    },
    /// A sphere.
    Sphere {
        /// Its radius.
        radius: f64,
    },
    /// A capsule along a caller axis.
    Capsule {
        /// Half the length of its segment.
        half_height: f64,
        /// Its radius.
        radius: f64,
        /// Its axis in the caller frame.
        axis: Axis,
    },
    /// The convex hull of 4..`limits.hullVertices` points.
    Hull {
        /// The points; the core computes the hull.
        points: Vec<Vec3>,
    },
    /// A triangle mesh; fixed bodies only.
    Trimesh {
        /// Vertices.
        vertices: Vec<Vec3>,
        /// Triangles as vertex indices (integers).
        indices: Vec<[f64; 3]>,
    },
    /// A heightfield grid; fixed bodies only (§6.3).
    Heightfield {
        /// Rows, an integer >= 2.
        rows: f64,
        /// Columns, an integer >= 2.
        cols: f64,
        /// `rows × cols` heights, row-major.
        heights: Vec<f64>,
        /// The grid's size: ground axes and the height scale.
        size: Vec3,
    },
}

/// Collision groups: 16-bit masks (§6.2).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Groups {
    /// The groups the collider is in.
    pub member: f64,
    /// The groups it collides with.
    pub collides: f64,
}

/// One collider of a body (§6.2).
#[derive(Clone, Debug, PartialEq)]
pub struct ColliderDesc {
    /// Unique within its body.
    pub key: String,
    /// Its shape.
    pub shape: Shape,
    /// Its pose relative to the body.
    pub offset: Option<Pose>,
    /// kg per caller-unit³; default 1. Not with `mass`.
    pub density: Option<f64>,
    /// kg. Not with `density`.
    pub mass: Option<f64>,
    /// Default 0.5.
    pub friction: Option<f64>,
    /// Default 0.
    pub restitution: Option<f64>,
    /// Default all.
    pub groups: Option<Groups>,
    /// A trigger: no contact response, only trigger events.
    pub sensor: bool,
    /// Report contact events (§8.1).
    pub events: bool,
}

impl ColliderDesc {
    /// A collider with every default.
    pub fn new(key: impl Into<String>, shape: Shape) -> Self {
        Self {
            key: key.into(),
            shape,
            offset: None,
            density: None,
            mass: None,
            friction: None,
            restitution: None,
            groups: None,
            sensor: false,
            events: false,
        }
    }
}

/// A body to spawn (§6.1).
#[derive(Clone, Debug, PartialEq)]
pub struct BodyDesc {
    /// The body's key (§3).
    pub key: String,
    /// Its type.
    pub body_type: BodyType,
    /// Its pose in the caller frame.
    pub pose: Pose,
    /// Dynamic only.
    pub linvel: Option<Vec3>,
    /// Dynamic only.
    pub angvel: Option<Vec3>,
    /// 1..`limits.collidersPerBody` colliders.
    pub colliders: Vec<ColliderDesc>,
    /// >= 0; default 0.
    pub linear_damping: Option<f64>,
    /// >= 0; default 0.
    pub angular_damping: Option<f64>,
    /// Default 1.
    pub gravity_scale: Option<f64>,
    /// Rotation locks per caller axis.
    pub lock_rotation: [bool; 3],
    /// Counts toward `limits.ccdBodies`.
    pub ccd: bool,
    /// Default true.
    pub can_sleep: bool,
    /// An optional caller tag, echoed in events and exports; `''` means no kind (§6.1).
    pub kind: Option<String>,
}

impl BodyDesc {
    /// A body with every default.
    pub fn new(key: impl Into<String>, body_type: BodyType, pose: Pose, colliders: Vec<ColliderDesc>) -> Self {
        Self {
            key: key.into(),
            body_type,
            pose,
            linvel: None,
            angvel: None,
            colliders,
            linear_damping: None,
            angular_damping: None,
            gravity_scale: None,
            lock_rotation: [false; 3],
            ccd: false,
            can_sleep: true,
            kind: None,
        }
    }
}

/// A body that passed every check that needs no world state.
#[derive(Clone, Debug)]
pub(crate) struct ValidBody {
    pub key: String,
    pub kind: Option<String>,
    pub spec: BodySpec,
    pub collider_keys: Vec<String>,
    pub facts: ShapeFacts,
}

/// Checks `desc` against everything but the world's contents (§6, §4.1), in the documented order.
pub(crate) fn validate_body(desc: &BodyDesc, up: UpAxis, limits: &Limits) -> Result<ValidBody, PhysicsFailure> {
    check_keys(desc)?;
    if desc.colliders.is_empty() {
        return fail(PhysicsError::OutOfRange, "a body has at least one collider");
    }
    let (translation, rotation) = body_pose(&desc.pose, limits)?;
    let linvel = velocity(desc.linvel, desc.body_type, "linvel", limits.max_speed)?;
    let angvel = velocity(desc.angvel, desc.body_type, "angvel", limits.max_angular_speed)?;
    let linear_damping = optional(desc.linear_damping, 0.0, |v| non_negative(v, "linearDamping"))?;
    let angular_damping = optional(desc.angular_damping, 0.0, |v| non_negative(v, "angularDamping"))?;
    let gravity_scale = optional(desc.gravity_scale, 1.0, |v| finite(v, "gravityScale"))?;
    let mut facts = ShapeFacts::default();
    let mut colliders = Vec::with_capacity(desc.colliders.len());
    for collider in &desc.colliders {
        colliders.push(validate_collider(collider, desc.body_type, up, limits, &mut facts)?);
    }
    check_unique_colliders(desc)?;
    let spec = BodySpec {
        body_type: desc.body_type,
        translation: vec_in(up, translation),
        rotation: quat_in(up, rotation),
        linvel: vec_in(up, linvel),
        angvel: vec_in(up, angvel),
        linear_damping,
        angular_damping,
        gravity_scale,
        locked_rotations: flags_in(up, desc.lock_rotation),
        ccd: desc.ccd,
        can_sleep: desc.can_sleep,
        colliders,
    };
    let collider_keys = desc.colliders.iter().map(|c| c.key.clone()).collect();
    let kind = desc.kind.clone().filter(|kind| !kind.is_empty());
    Ok(ValidBody { key: desc.key.clone(), kind, spec, collider_keys, facts })
}

fn check_keys(desc: &BodyDesc) -> Result<(), PhysicsFailure> {
    check_object_key(&desc.key)?;
    if let Some(kind) = &desc.kind {
        check_kind(kind)?;
    }
    desc.colliders.iter().try_for_each(|collider| check_object_key(&collider.key))
}

fn check_unique_colliders(desc: &BodyDesc) -> Result<(), PhysicsFailure> {
    let mut keys: Vec<&str> = desc.colliders.iter().map(|c| c.key.as_str()).collect();
    keys.sort_unstable();
    if keys.windows(2).any(|pair| pair[0] == pair[1]) {
        return fail(PhysicsError::DuplicateKey, "two colliders of one body share a key");
    }
    Ok(())
}

/// `value` checked by `check`, or `default` when absent.
fn optional(value: Option<f64>, default: f32, check: impl Fn(f64) -> Result<f32, PhysicsFailure>) -> Result<f32, PhysicsFailure> {
    value.map_or(Ok(default), check)
}

/// A body pose in the caller frame: position within `worldExtent` per axis, rotation a unit
/// quaternion renormalised in f32 (§4.1, §6.1).
pub(crate) fn body_pose(pose: &Pose, limits: &Limits) -> Result<([f32; 3], [f32; 4]), PhysicsFailure> {
    Ok((position(pose.p, "pose.p", limits)?, unit_quat(pose.q, "pose.q")?))
}

/// A position a command sets: finite in f32 and within `worldExtent` per axis (§4.1).
pub(crate) fn position(p: Vec3, what: &str, limits: &Limits) -> Result<[f32; 3], PhysicsFailure> {
    let p = finite_vec(p, what)?;
    if p.iter().any(|c| c.abs() > limits.world_extent) {
        return fail(PhysicsError::OutOfRange, format!("{what} lies outside limits.worldExtent"));
    }
    Ok(p)
}

/// A velocity: dynamic bodies only, finite, and at most `max` in length.
fn velocity(value: Option<Vec3>, body_type: BodyType, what: &str, max: f32) -> Result<[f32; 3], PhysicsFailure> {
    let Some(v) = value else { return Ok([0.0; 3]) };
    if body_type != BodyType::Dynamic {
        return fail(PhysicsError::OutOfRange, format!("{what} is for dynamic bodies only"));
    }
    bounded_speed(v, what, max)
}

/// A velocity a command sets (§4.1): finite, and at most `max` in length.
pub(crate) fn bounded_speed(v: Vec3, what: &str, max: f32) -> Result<[f32; 3], PhysicsFailure> {
    let v = finite_vec(v, what)?;
    if length_squared(v) > f64::from(max) * f64::from(max) {
        return fail(PhysicsError::OutOfRange, format!("{what} is above its limit"));
    }
    Ok(v)
}

fn validate_collider(
    desc: &ColliderDesc,
    body_type: BodyType,
    up: UpAxis,
    limits: &Limits,
    facts: &mut ShapeFacts,
) -> Result<ColliderSpec, PhysicsFailure> {
    let shape = validate_shape(&desc.shape, up, limits, facts)?;
    let is_mesh = matches!(shape, ShapeSpec::Trimesh { .. } | ShapeSpec::Heightfield { .. });
    if is_mesh && body_type != BodyType::Fixed {
        return fail(PhysicsError::DynamicMesh, "a trimesh or heightfield needs a fixed body");
    }
    let (translation, rotation) = offset(desc.offset.as_ref())?;
    Ok(ColliderSpec {
        shape,
        translation: vec_in(up, translation),
        rotation: quat_in(up, rotation),
        mass: mass(desc)?,
        friction: optional(desc.friction, DEFAULT_FRICTION, |v| non_negative(v, "friction"))?,
        restitution: optional(desc.restitution, DEFAULT_RESTITUTION, |v| non_negative(v, "restitution"))?,
        member: group(desc.groups.map(|g| g.member), "groups.member")?,
        collides: group(desc.groups.map(|g| g.collides), "groups.collides")?,
        sensor: desc.sensor,
        events: desc.events,
    })
}

fn offset(pose: Option<&Pose>) -> Result<([f32; 3], [f32; 4]), PhysicsFailure> {
    let Some(pose) = pose else { return Ok(([0.0; 3], [0.0, 0.0, 0.0, 1.0])) };
    Ok((finite_vec(pose.p, "offset.p")?, unit_quat(pose.q, "offset.q")?))
}

fn mass(desc: &ColliderDesc) -> Result<MassSpec, PhysicsFailure> {
    match (desc.density, desc.mass) {
        (Some(_), Some(_)) => fail(PhysicsError::OutOfRange, "a collider sets density or mass, not both"),
        (Some(density), None) => Ok(MassSpec::Density(non_negative(density, "density")?)),
        (None, Some(mass)) => Ok(MassSpec::Mass(non_negative(mass, "mass")?)),
        (None, None) => Ok(MassSpec::Density(DEFAULT_DENSITY)),
    }
}

/// A 16-bit group mask (§6.2); absent is all groups.
pub(crate) fn group(value: Option<f64>, what: &str) -> Result<u16, PhysicsFailure> {
    let mask = value.map_or(Ok(GROUPS_ALL), |v| integer(v, what, 0, GROUPS_ALL))?;
    Ok(mask as u16)
}
