//! A body's and a joint's descriptor in canonical form (contract 1.1 draft, §20.5): the JSON a
//! client spawns the server's body (or adds its joint) from. The descriptor is judged first as
//! `spawn` (`addJoint`) judges it on its own (keys, numbers, bounds, shapes; not the world's
//! contents), then written with every documented default filled in, every number as the f32 the
//! core rounds it to on entry (−0 kept as `-0`), object keys sorted, no whitespace. Equal
//! descriptors give equal text, and spawning from the text makes exactly the body the descriptor
//! makes: the core reads back the very f32s it would have rounded the descriptor to.

use std::collections::BTreeMap;

use crate::body::{BodyDesc, ColliderDesc, DEFAULT_DENSITY, DEFAULT_FRICTION, DEFAULT_RESTITUTION, GROUPS_ALL, Shape, validate_body};
use crate::canon::Canon;
use crate::error::PhysicsFailure;
use crate::joint::{JointDesc, Motor, validate_joint};
use crate::limits::Limits;
use crate::num::fround;
use crate::types::{Axis, BodyType, Pose, UpAxis};

/// An object's members from `(key, value)` pairs, to add optional ones to before writing.
fn members<const N: usize>(pairs: [(&str, Canon); N]) -> BTreeMap<String, Canon> {
    pairs.into_iter().map(|(key, value)| (key.to_string(), value)).collect()
}

fn num(x: f64) -> Canon {
    Canon::Signed(fround(x))
}

fn nums(values: &[f64]) -> Canon {
    Canon::Arr(values.iter().map(|x| num(*x)).collect())
}

fn pose(pose: &Pose) -> Canon {
    Canon::object([("p", nums(&pose.p)), ("q", nums(&pose.q))])
}

fn identity() -> Pose {
    Pose { p: [0.0; 3], q: [0.0, 0.0, 0.0, 1.0] }
}

fn axis_name(axis: Axis) -> &'static str {
    match axis {
        Axis::X => "x",
        Axis::Y => "y",
        Axis::Z => "z",
    }
}

fn shape(shape: &Shape) -> Canon {
    let kind = |name: &str| ("kind", Canon::Str(name.to_string()));
    match shape {
        Shape::Box { half } => Canon::object([kind("box"), ("half", nums(half))]),
        Shape::Sphere { radius } => Canon::object([kind("sphere"), ("radius", num(*radius))]),
        Shape::Capsule { half_height, radius, axis } => Canon::object([
            kind("capsule"),
            ("halfHeight", num(*half_height)),
            ("radius", num(*radius)),
            ("axis", Canon::Str(axis_name(*axis).to_string())),
        ]),
        Shape::Hull { points } => Canon::object([kind("hull"), ("points", Canon::Arr(points.iter().map(|p| nums(p)).collect()))]),
        Shape::Trimesh { vertices, indices } => Canon::object([
            kind("trimesh"),
            ("vertices", Canon::Arr(vertices.iter().map(|v| nums(v)).collect())),
            ("indices", Canon::Arr(indices.iter().map(|i| nums(i)).collect())),
        ]),
        Shape::Heightfield { rows, cols, heights, size } => Canon::object([
            kind("heightfield"),
            ("rows", num(*rows)),
            ("cols", num(*cols)),
            ("heights", nums(heights)),
            ("size", nums(size)),
        ]),
    }
}

fn collider(desc: &ColliderDesc) -> Canon {
    let mass = match desc.mass {
        Some(kg) => ("mass", num(kg)),
        None => ("density", desc.density.map_or(Canon::Signed(DEFAULT_DENSITY), num)),
    };
    let groups = desc.groups.map_or_else(
        || Canon::object([("member", Canon::Num(GROUPS_ALL as f32)), ("collides", Canon::Num(GROUPS_ALL as f32))]),
        |g| Canon::object([("member", num(g.member)), ("collides", num(g.collides))]),
    );
    Canon::object([
        ("key", Canon::Str(desc.key.clone())),
        ("shape", shape(&desc.shape)),
        ("offset", pose(&desc.offset.unwrap_or_else(identity))),
        mass,
        ("friction", desc.friction.map_or(Canon::Signed(DEFAULT_FRICTION), num)),
        ("restitution", desc.restitution.map_or(Canon::Signed(DEFAULT_RESTITUTION), num)),
        ("groups", groups),
        ("sensor", Canon::Bool(desc.sensor)),
        ("events", Canon::Bool(desc.events)),
    ])
}

/// `desc` in canonical form (§20.5), or the refusal `spawn` would give it on its own.
pub(crate) fn body_desc_canonical(desc: &BodyDesc, up: UpAxis, limits: &Limits) -> Result<String, PhysicsFailure> {
    validate_body(desc, up, limits)?;
    let zero = [0.0; 3];
    let mut out = members([
        ("key", Canon::Str(desc.key.clone())),
        ("type", Canon::Str(desc.body_type.name().to_string())),
        ("pose", pose(&desc.pose)),
        ("colliders", Canon::Arr(desc.colliders.iter().map(collider).collect())),
        ("linearDamping", desc.linear_damping.map_or(Canon::Signed(0.0), num)),
        ("angularDamping", desc.angular_damping.map_or(Canon::Signed(0.0), num)),
        ("gravityScale", desc.gravity_scale.map_or(Canon::Signed(1.0), num)),
        ("lockRotation", Canon::Arr(desc.lock_rotation.iter().map(|b| Canon::Bool(*b)).collect())),
        ("ccd", Canon::Bool(desc.ccd)),
        ("canSleep", Canon::Bool(desc.can_sleep)),
    ]);
    if desc.body_type == BodyType::Dynamic {
        out.insert("linvel".into(), nums(&desc.linvel.unwrap_or(zero)));
        out.insert("angvel".into(), nums(&desc.angvel.unwrap_or(zero)));
    }
    if let Some(kind) = desc.kind.as_ref().filter(|kind| !kind.is_empty()) {
        out.insert("kind".into(), Canon::Str(kind.clone()));
    }
    Ok(Canon::Obj(out).write())
}

fn motor(motor: &Motor) -> Canon {
    let fields = [
        ("targetVel", motor.target_vel),
        ("targetPos", motor.target_pos),
        ("stiffness", motor.stiffness),
        ("damping", motor.damping),
        ("maxForce", motor.max_force),
    ];
    Canon::Obj(fields.into_iter().filter_map(|(name, value)| Some((name.to_string(), num(value?)))).collect())
}

/// `desc` in canonical form (§20.5), or the refusal `addJoint` would give it on its own. A motor
/// keeps the values it was given (an absent one is not 0 for `maxForce`), and `axis` and `limits`
/// appear when given.
pub(crate) fn joint_desc_canonical(desc: &JointDesc, up: UpAxis, limits: &Limits) -> Result<String, PhysicsFailure> {
    validate_joint(desc, up, limits)?;
    let mut out = members([
        ("key", Canon::Str(desc.key.clone())),
        ("a", Canon::Str(desc.a.clone())),
        ("b", desc.b.clone().map_or(Canon::Null, Canon::Str)),
        ("type", Canon::Str(desc.joint_type.name().to_string())),
        ("anchorA", nums(&desc.anchor_a)),
        ("anchorB", nums(&desc.anchor_b)),
        ("collideConnected", Canon::Bool(desc.collide_connected)),
    ]);
    if let Some(axis) = &desc.axis {
        out.insert("axis".into(), nums(axis));
    }
    if let Some(range) = &desc.limits {
        out.insert("limits".into(), nums(range));
    }
    if let Some(m) = &desc.motor {
        out.insert("motor".into(), motor(m));
    }
    Ok(Canon::Obj(out).write())
}
