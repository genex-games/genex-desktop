//! The command JSON form (CONTRACT.md §7.3): one object with exactly one key, the verb, whose value
//! is an object of its named arguments. Queries (§13) share the form: `ray`, `shapeCast` or
//! `overlap` to their arguments, with an optional `filter` of `groups`, `excludeBodies` and
//! `includeSensors`.
//!
//! Anything malformed gives `BadCommand`: no key, more than one, an unknown verb, a missing or
//! unknown argument at any depth (a collider's or a shape's fields too), and a value of the wrong
//! JSON type, a wrong array length or an unknown spelling (`type`, `kind`, `axis`). `null` stands
//! only for a joint's `b`. Numbers are read as given; their checks (`NonFinite`, `OutOfRange`)
//! and the keys' (`InvalidKey`) come after, from the verb itself.

use serde_json::{Map, Value};

use crate::body::{BodyDesc, ColliderDesc, Groups, Shape};
use crate::command::{Command, SetPoseOptions};
use crate::error::{PhysicsError, PhysicsFailure, fail};
use crate::joint::{JointDesc, JointType, Motor};
use crate::query::{Query, QueryFilter};
use crate::types::{Axis, BodyType, Pose, Quat, Vec3};

type Parsed<T> = Result<T, PhysicsFailure>;

fn bad<T>(detail: impl Into<String>) -> Parsed<T> {
    fail(PhysicsError::BadCommand, detail)
}

/// An object whose fields were checked against the names it may hold.
struct Args<'a>(&'a Map<String, Value>);

impl<'a> Args<'a> {
    /// `value` as an object holding every `required` name and nothing outside `required` and
    /// `optional`.
    fn read(value: &'a Value, required: &[&str], optional: &[&str]) -> Parsed<Self> {
        let Some(map) = value.as_object() else { return bad("expected an object") };
        if let Some(name) = map.keys().find(|k| !required.contains(&k.as_str()) && !optional.contains(&k.as_str())) {
            return bad(format!("unknown argument {name}"));
        }
        if let Some(name) = required.iter().find(|name| !map.contains_key(**name)) {
            return bad(format!("missing argument {name}"));
        }
        Ok(Self(map))
    }

    fn get(&self, name: &str) -> Option<&'a Value> {
        self.0.get(name)
    }

    fn field<T>(&self, name: &str, read: impl Fn(&'a Value) -> Parsed<T>) -> Parsed<T> {
        match self.get(name) {
            Some(value) => read(value),
            None => bad(format!("missing argument {name}")),
        }
    }

    fn optional<T>(&self, name: &str, read: impl Fn(&'a Value) -> Parsed<T>) -> Parsed<Option<T>> {
        self.get(name).map(read).transpose()
    }

    fn string(&self, name: &str) -> Parsed<String> {
        self.field(name, string)
    }

    fn number(&self, name: &str) -> Parsed<f64> {
        self.field(name, number)
    }

    fn vec3(&self, name: &str) -> Parsed<Vec3> {
        self.field(name, vec3)
    }

    fn flag(&self, name: &str, default: bool) -> Parsed<bool> {
        Ok(self.optional(name, boolean)?.unwrap_or(default))
    }
}

fn string(value: &Value) -> Parsed<String> {
    value.as_str().map(str::to_string).map_or_else(|| bad("expected a string"), Ok)
}

fn number(value: &Value) -> Parsed<f64> {
    value.as_f64().map_or_else(|| bad("expected a number"), Ok)
}

fn boolean(value: &Value) -> Parsed<bool> {
    value.as_bool().map_or_else(|| bad("expected a boolean"), Ok)
}

fn array<T>(value: &Value, read: impl Fn(&Value) -> Parsed<T>) -> Parsed<Vec<T>> {
    let Some(items) = value.as_array() else { return bad("expected an array") };
    items.iter().map(read).collect()
}

fn fixed<const N: usize, T>(value: &Value, read: impl Fn(&Value) -> Parsed<T>) -> Parsed<[T; N]> {
    let items = array(value, read)?;
    let Ok(out) = <[T; N]>::try_from(items) else { return bad(format!("expected {N} values")) };
    Ok(out)
}

fn vec3(value: &Value) -> Parsed<Vec3> {
    fixed(value, number)
}

fn quat(value: &Value) -> Parsed<Quat> {
    fixed(value, number)
}

fn pose(value: &Value) -> Parsed<Pose> {
    let args = Args::read(value, &["p", "q"], &[])?;
    Ok(Pose { p: args.vec3("p")?, q: args.field("q", quat)? })
}

fn groups(value: &Value) -> Parsed<Groups> {
    let args = Args::read(value, &["member", "collides"], &[])?;
    Ok(Groups { member: args.number("member")?, collides: args.number("collides")? })
}

fn key_only(value: &Value) -> Parsed<String> {
    Args::read(value, &["key"], &[])?.string("key")
}

/// Reads one command in its JSON form.
pub(crate) fn command(value: &Value) -> Parsed<Command> {
    let Some(map) = value.as_object() else { return bad("a command is an object") };
    let mut entries = map.iter();
    let (Some((verb, args)), None) = (entries.next(), entries.next()) else {
        return bad("a command has exactly one key, its verb");
    };
    match verb.as_str() {
        "spawn" => Ok(Command::Spawn(body_desc(args)?)),
        "remove" => Ok(Command::Remove { key: key_only(args)? }),
        "addJoint" => Ok(Command::AddJoint(joint_desc(args)?)),
        "removeJoint" => Ok(Command::RemoveJoint { key: key_only(args)? }),
        "wake" => Ok(Command::Wake { key: key_only(args)? }),
        "sleep" => Ok(Command::Sleep { key: key_only(args)? }),
        "impulse" => impulse(args),
        "setVelocity" => set_velocity(args),
        "setPose" => set_pose(args),
        "setNextKinematicPose" => {
            let args = Args::read(args, &["key", "pose"], &[])?;
            Ok(Command::SetNextKinematicPose { key: args.string("key")?, pose: args.field("pose", pose)? })
        }
        "areaPush" => area_push(args),
        "setMotor" => {
            let args = Args::read(args, &["key", "motor"], &[])?;
            Ok(Command::SetMotor { key: args.string("key")?, motor: args.field("motor", motor)? })
        }
        other => bad(format!("unknown verb {other}")),
    }
}

fn impulse(value: &Value) -> Parsed<Command> {
    let args = Args::read(value, &["key", "j"], &["at"])?;
    Ok(Command::Impulse { key: args.string("key")?, j: args.vec3("j")?, at: args.optional("at", vec3)? })
}

fn set_velocity(value: &Value) -> Parsed<Command> {
    let args = Args::read(value, &["key"], &["linvel", "angvel"])?;
    Ok(Command::SetVelocity {
        key: args.string("key")?,
        linvel: args.optional("linvel", vec3)?,
        angvel: args.optional("angvel", vec3)?,
    })
}

fn set_pose(value: &Value) -> Parsed<Command> {
    let args = Args::read(value, &["key", "pose"], &["resetVelocity", "wake"])?;
    let defaults = SetPoseOptions::default();
    let options = SetPoseOptions {
        reset_velocity: args.flag("resetVelocity", defaults.reset_velocity)?,
        wake: args.flag("wake", defaults.wake)?,
    };
    Ok(Command::SetPose { key: args.string("key")?, pose: args.field("pose", pose)?, options })
}

fn area_push(value: &Value) -> Parsed<Command> {
    let args = Args::read(value, &["center", "radius", "strength", "falloff"], &["groups"])?;
    Ok(Command::AreaPush {
        center: args.vec3("center")?,
        radius: args.number("radius")?,
        strength: args.number("strength")?,
        falloff: args.number("falloff")?,
        groups: args.optional("groups", groups)?,
    })
}

fn motor(value: &Value) -> Parsed<Motor> {
    let args = Args::read(value, &[], &["targetVel", "targetPos", "stiffness", "damping", "maxForce"])?;
    Ok(Motor {
        target_vel: args.optional("targetVel", number)?,
        target_pos: args.optional("targetPos", number)?,
        stiffness: args.optional("stiffness", number)?,
        damping: args.optional("damping", number)?,
        max_force: args.optional("maxForce", number)?,
    })
}

const BODY_REQUIRED: [&str; 4] = ["key", "type", "pose", "colliders"];
const BODY_OPTIONAL: [&str; 9] =
    ["linvel", "angvel", "linearDamping", "angularDamping", "gravityScale", "lockRotation", "ccd", "canSleep", "kind"];

fn body_type(value: &Value) -> Parsed<BodyType> {
    match value.as_str() {
        Some("dynamic") => Ok(BodyType::Dynamic),
        Some("fixed") => Ok(BodyType::Fixed),
        Some("kinematic") => Ok(BodyType::Kinematic),
        _ => bad("type is \"dynamic\", \"fixed\" or \"kinematic\""),
    }
}

fn body_desc(value: &Value) -> Parsed<BodyDesc> {
    let args = Args::read(value, &BODY_REQUIRED, &BODY_OPTIONAL)?;
    let colliders = args.field("colliders", |v| array(v, collider_desc))?;
    let mut desc = BodyDesc::new(args.string("key")?, args.field("type", body_type)?, args.field("pose", pose)?, colliders);
    desc.linvel = args.optional("linvel", vec3)?;
    desc.angvel = args.optional("angvel", vec3)?;
    desc.linear_damping = args.optional("linearDamping", number)?;
    desc.angular_damping = args.optional("angularDamping", number)?;
    desc.gravity_scale = args.optional("gravityScale", number)?;
    desc.lock_rotation = args.optional("lockRotation", |v| fixed(v, boolean))?.unwrap_or_default();
    desc.ccd = args.flag("ccd", false)?;
    desc.can_sleep = args.flag("canSleep", true)?;
    desc.kind = args.optional("kind", string)?;
    Ok(desc)
}

const COLLIDER_OPTIONAL: [&str; 8] =
    ["offset", "density", "mass", "friction", "restitution", "groups", "sensor", "events"];

fn collider_desc(value: &Value) -> Parsed<ColliderDesc> {
    let args = Args::read(value, &["key", "shape"], &COLLIDER_OPTIONAL)?;
    let mut desc = ColliderDesc::new(args.string("key")?, args.field("shape", shape)?);
    desc.offset = args.optional("offset", pose)?;
    desc.density = args.optional("density", number)?;
    desc.mass = args.optional("mass", number)?;
    desc.friction = args.optional("friction", number)?;
    desc.restitution = args.optional("restitution", number)?;
    desc.groups = args.optional("groups", groups)?;
    desc.sensor = args.flag("sensor", false)?;
    desc.events = args.flag("events", false)?;
    Ok(desc)
}

fn axis(value: &Value) -> Parsed<Axis> {
    match value.as_str() {
        Some("x") => Ok(Axis::X),
        Some("y") => Ok(Axis::Y),
        Some("z") => Ok(Axis::Z),
        _ => bad("axis is \"x\", \"y\" or \"z\""),
    }
}

/// A shape: `kind` and exactly the fields of that kind (§6.2).
fn shape(value: &Value) -> Parsed<Shape> {
    let kind = value.get("kind").and_then(Value::as_str);
    let read = |fields: &[&str]| {
        let mut required = vec!["kind"];
        required.extend_from_slice(fields);
        Args::read(value, &required, &[])
    };
    match kind {
        Some("box") => Ok(Shape::Box { half: read(&["half"])?.vec3("half")? }),
        Some("sphere") => Ok(Shape::Sphere { radius: read(&["radius"])?.number("radius")? }),
        Some("capsule") => {
            let args = read(&["halfHeight", "radius", "axis"])?;
            let (half_height, radius) = (args.number("halfHeight")?, args.number("radius")?);
            Ok(Shape::Capsule { half_height, radius, axis: args.field("axis", axis)? })
        }
        Some("hull") => Ok(Shape::Hull { points: read(&["points"])?.field("points", |v| array(v, vec3))? }),
        Some("trimesh") => {
            let args = read(&["vertices", "indices"])?;
            let vertices = args.field("vertices", |v| array(v, vec3))?;
            Ok(Shape::Trimesh { vertices, indices: args.field("indices", |v| array(v, vec3))? })
        }
        Some("heightfield") => {
            let args = read(&["rows", "cols", "heights", "size"])?;
            Ok(Shape::Heightfield {
                rows: args.number("rows")?,
                cols: args.number("cols")?,
                heights: args.field("heights", |v| array(v, number))?,
                size: args.vec3("size")?,
            })
        }
        _ => bad("shape kind is box, sphere, capsule, hull, trimesh or heightfield"),
    }
}

fn joint_type(value: &Value) -> Parsed<JointType> {
    match value.as_str() {
        Some("fixed") => Ok(JointType::Fixed),
        Some("hinge") => Ok(JointType::Hinge),
        Some("ball") => Ok(JointType::Ball),
        Some("slider") => Ok(JointType::Slider),
        Some("rope") => Ok(JointType::Rope),
        _ => bad("type is fixed, hinge, ball, slider or rope"),
    }
}

/// `b`: a key, or `null` for the world.
fn other_body(value: &Value) -> Parsed<Option<String>> {
    match value {
        Value::Null => Ok(None),
        other => string(other).map(Some),
    }
}

const JOINT_REQUIRED: [&str; 6] = ["key", "a", "b", "type", "anchorA", "anchorB"];

fn joint_desc(value: &Value) -> Parsed<JointDesc> {
    let args = Args::read(value, &JOINT_REQUIRED, &["axis", "limits", "motor", "collideConnected"])?;
    let b = args.field("b", other_body)?;
    let mut desc = JointDesc::new(
        args.string("key")?,
        args.string("a")?,
        b.as_deref(),
        args.field("type", joint_type)?,
        args.vec3("anchorA")?,
        args.vec3("anchorB")?,
    );
    desc.axis = args.optional("axis", vec3)?;
    desc.limits = args.optional("limits", |v| fixed(v, number))?;
    desc.motor = args.optional("motor", motor)?;
    desc.collide_connected = args.flag("collideConnected", false)?;
    Ok(desc)
}

/// A query filter (§13): `groups`, `excludeBodies` and `includeSensors`, each optional.
fn query_filter(value: &Value) -> Parsed<QueryFilter> {
    let args = Args::read(value, &[], &["groups", "excludeBodies", "includeSensors"])?;
    Ok(QueryFilter {
        groups: args.optional("groups", groups)?,
        exclude_bodies: args.optional("excludeBodies", |v| array(v, string))?.unwrap_or_default(),
        include_sensors: args.flag("includeSensors", false)?,
    })
}

fn filter_of(args: &Args<'_>) -> Parsed<QueryFilter> {
    Ok(args.optional("filter", query_filter)?.unwrap_or_default())
}

/// Reads one query in its JSON form (§13): one key, `ray`, `shapeCast` or `overlap`, to its named
/// arguments; anything malformed gives `BadCommand`, as a command does.
pub(crate) fn query(value: &Value) -> Parsed<Query> {
    let Some(map) = value.as_object() else { return bad("a query is an object") };
    let mut entries = map.iter();
    let (Some((verb, value)), None) = (entries.next(), entries.next()) else {
        return bad("a query has exactly one key, its kind");
    };
    match verb.as_str() {
        "ray" => {
            let args = Args::read(value, &["origin", "dir", "maxDist"], &["filter"])?;
            let (origin, dir, max_dist) = (args.vec3("origin")?, args.vec3("dir")?, args.number("maxDist")?);
            Ok(Query::Ray { origin, dir, max_dist, filter: filter_of(&args)? })
        }
        "shapeCast" => {
            let args = Args::read(value, &["shape", "pose", "dir", "maxDist"], &["filter"])?;
            let (shape, pose) = (args.field("shape", shape)?, args.field("pose", pose)?);
            let (dir, max_dist) = (args.vec3("dir")?, args.number("maxDist")?);
            Ok(Query::ShapeCast { shape, pose, dir, max_dist, filter: filter_of(&args)? })
        }
        "overlap" => {
            let args = Args::read(value, &["shape", "pose"], &["filter"])?;
            Ok(Query::Overlap { shape: args.field("shape", shape)?, pose: args.field("pose", pose)?, filter: filter_of(&args)? })
        }
        other => bad(format!("unknown query {other}")),
    }
}
