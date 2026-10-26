//! The full hostile-input table (§1.5, §14): every verb fed NaN, infinities, f32-overflowing and
//! out-of-range numbers, unknown, duplicate, invalid and static keys, inputs past every limit,
//! malformed JSON and malformed snapshots. Each row asserts its code and that nothing a caller can
//! observe changed, the world's own snapshot bytes included. Commands run alone, as an atomic
//! batch and as an each batch (§7.1); together the rows produce every error code but `internal`
//! (`world.rs`'s unit test), once each at least.

mod common;

use std::collections::BTreeSet;

use common::{ball, body, cube};
use genex_physics::{
    BodyDesc, BodyType, ColliderDesc, Command, Groups, JointDesc, JointType, Motor, NetBodyState, PhysicsError, PhysicsFailure, Pose,
    QUAT_IDENTITY, QueryFilter, SetPoseOptions, Shape, StaticWorld, UpAxis, World, WorldDesc,
};
use serde_json::json;

const NAN: f64 = f64::NAN;
const INF: f64 = f64::INFINITY;
/// Finite in f64, infinite once rounded to f32 (§4.1).
const F32_OVERFLOW: f64 = 1e39;
/// Finite in f32, past every default bound.
const HUGE: f64 = 1e30;

/// The worlds the rows run against.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Fixture {
    /// z-up, limits lowered so each is one step away, its joint quota and query quota used up.
    Main,
    /// z-up with its static world.
    Static,
    /// z-up with 300 bytes of memory to spare.
    Tight,
    /// y-up.
    YUp,
}

fn limited_desc(up: UpAxis) -> WorldDesc {
    let gravity = if up == UpAxis::Z { [0.0, 0.0, -9.81] } else { [0.0, -9.81, 0.0] };
    let mut desc = WorldDesc::new(1.0 / 30.0, 2.0, gravity, up, 1.0);
    desc.limits.bodies = Some(6.0);
    desc.limits.colliders_per_body = Some(2.0);
    desc.limits.hull_vertices = Some(8.0);
    desc.limits.triangles = Some(4.0);
    desc.limits.joints = Some(1.0);
    desc.limits.ccd_bodies = Some(0.0);
    desc.limits.queries_per_step = Some(2.0);
    desc.limits.static_pieces = Some(1.0);
    desc
}

fn populate(w: &mut World, up: UpAxis) {
    let p = |v: [f64; 3]| common::to(up, v);
    w.spawn(&body("d", BodyType::Dynamic, p([0.0, 1.0, 0.0]), cube(0.5))).expect("d");
    w.spawn(&body("d2", BodyType::Dynamic, p([2.0, 1.0, 0.0]), ball(0.5))).expect("d2");
    w.spawn(&body("f", BodyType::Fixed, p([0.0, -1.0, 0.0]), Shape::Box { half: [10.0, 1.0, 10.0] })).expect("f");
    w.spawn(&body("k", BodyType::Kinematic, p([4.0, 1.0, 0.0]), cube(0.5))).expect("k");
    let mut sensor = body("s", BodyType::Fixed, p([0.0, 1.0, 0.0]), cube(2.0));
    sensor.colliders[0].sensor = true;
    w.spawn(&sensor).expect("s");
    let mut hinge = JointDesc::new("j", "d", None, JointType::Hinge, [0.0; 3], p([0.0, 1.0, 0.0]));
    hinge.axis = Some(p([0.0, 0.0, 1.0]));
    hinge.motor = Some(Motor { target_vel: Some(1.0), damping: Some(2.0), ..Motor::default() });
    w.add_joint(&hinge).expect("j");
    for _ in 0..5 {
        w.step().expect("steps");
    }
    w.set_next_kinematic_pose("k", Pose::at(p([4.0, 1.5, 0.0]))).expect("a pending target");
}

fn fixture(which: Fixture) -> World {
    let up = if which == Fixture::YUp { UpAxis::Y } else { UpAxis::Z };
    let mut desc = limited_desc(up);
    if which == Fixture::Tight {
        let mut probe = World::create(&desc).expect("probe");
        populate(&mut probe, up);
        desc.limits.memory_bytes = Some((probe.memory_bytes() + 300) as f64);
    }
    let mut w = World::create(&desc).expect("world");
    if which == Fixture::Static {
        let floor = StaticWorld { boxes: vec![vec![-50.0, -50.0, -5.0, 50.0, 50.0, -2.0]], ramps: vec![] };
        w.add_static_world(&floor).expect("static");
    }
    populate(&mut w, up);
    let filter = QueryFilter::default();
    for _ in 0..2 {
        w.ray([0.0, 0.0, 10.0], [0.0, 0.0, -1.0], 20.0, &filter).expect("uses the query quota");
    }
    w
}

/// Everything a caller can observe, the world's snapshot bytes included.
fn observe(w: &World) -> (String, Vec<u8>) {
    let seen = format!(
        "{} {:016x} {} {:?} {:?} {} {:?} {}",
        w.tick(),
        w.state_hash(),
        w.physics_hash(),
        w.bodies(&Default::default()),
        w.stats(),
        w.joint_count(),
        w.export_changed(0),
        w.memory_bytes()
    );
    (seen, w.snapshot().expect("snapshots"))
}

fn pose(p: [f64; 3]) -> Pose {
    Pose::at(p)
}

fn spawn_with(key: &str, body_type: BodyType, shape: Shape) -> Command {
    Command::Spawn(body(key, body_type, [0.0, 0.0, 5.0], shape))
}

fn spawn_edit(edit: impl FnOnce(&mut BodyDesc)) -> Command {
    let mut desc = body("n", BodyType::Dynamic, [0.0, 0.0, 5.0], cube(0.5));
    edit(&mut desc);
    Command::Spawn(desc)
}

fn joint_edit(edit: impl FnOnce(&mut JointDesc)) -> Command {
    let mut desc = JointDesc::new("j2", "d", Some("d2"), JointType::Ball, [0.0; 3], [0.0; 3]);
    edit(&mut desc);
    Command::AddJoint(desc)
}

fn key(k: &str) -> String {
    k.to_string()
}

fn impulse(k: &str, j: [f64; 3], at: Option<[f64; 3]>) -> Command {
    Command::Impulse { key: key(k), j, at }
}

fn set_pose(k: &str, p: Pose) -> Command {
    Command::SetPose { key: key(k), pose: p, options: SetPoseOptions::default() }
}

fn push(center: [f64; 3], radius: f64, falloff: f64, groups: Option<Groups>) -> Command {
    Command::AreaPush { center, radius, strength: 1.0, falloff, groups }
}

fn motor(target_vel: f64) -> Command {
    Command::SetMotor { key: key("j"), motor: Motor { target_vel: Some(target_vel), ..Motor::default() } }
}

fn long_key() -> String {
    "k".repeat(65)
}

fn hull_points(n: usize) -> Vec<[f64; 3]> {
    (0..n).map(|i| [(i % 2) as f64, ((i / 2) % 2) as f64, (i / 4) as f64 + 0.01 * i as f64]).collect()
}

fn trimesh(triangles: usize) -> Shape {
    let vertices = vec![[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]];
    Shape::Trimesh { vertices, indices: vec![[0.0, 1.0, 2.0]; triangles] }
}

/// Every command row: its fixture, the command and its code.
fn command_rows() -> Vec<(&'static str, Fixture, Command, PhysicsError)> {
    use Fixture::{Main, Static, Tight};
    use PhysicsError::*;
    let m = |name, command, code| (name, Main, command, code);
    vec![
        m("spawn: empty key", spawn_with("", BodyType::Dynamic, cube(0.5)), InvalidKey),
        m("spawn: a space", spawn_with("a b", BodyType::Dynamic, cube(0.5)), InvalidKey),
        m("spawn: __proto__", spawn_with("__proto__", BodyType::Dynamic, cube(0.5)), InvalidKey),
        m("spawn: 65 bytes", Command::Spawn(body(&long_key(), BodyType::Dynamic, [0.0; 3], cube(0.5))), InvalidKey),
        m("spawn: static: prefix", spawn_with("static:box:0009", BodyType::Dynamic, cube(0.5)), InvalidKey),
        m("spawn: bad kind", spawn_edit(|d| d.kind = Some("no spaces".into())), InvalidKey),
        m("spawn: duplicate key", spawn_with("d", BodyType::Dynamic, cube(0.5)), DuplicateKey),
        m("spawn: duplicate collider key", spawn_edit(|d| d.colliders.push(ColliderDesc::new("c", ball(0.1)))), DuplicateKey),
        m("spawn: NaN position", spawn_edit(|d| d.pose.p[0] = NAN), NonFinite),
        m("spawn: infinite position", spawn_edit(|d| d.pose.p[1] = -INF), NonFinite),
        m("spawn: position past f32", spawn_edit(|d| d.pose.p[2] = F32_OVERFLOW), NonFinite),
        m("spawn: position past worldExtent", spawn_edit(|d| d.pose.p[2] = HUGE), OutOfRange),
        m("spawn: zero quaternion", spawn_edit(|d| d.pose.q = [0.0; 4]), OutOfRange),
        m("spawn: NaN quaternion", spawn_edit(|d| d.pose.q = [NAN, 0.0, 0.0, 1.0]), NonFinite),
        m("spawn: linvel past maxSpeed", spawn_edit(|d| d.linvel = Some([HUGE, 0.0, 0.0])), OutOfRange),
        m("spawn: infinite angvel", spawn_edit(|d| d.angvel = Some([0.0, INF, 0.0])), NonFinite),
        m("spawn: negative damping", spawn_edit(|d| d.linear_damping = Some(-1.0)), OutOfRange),
        m("spawn: NaN density", spawn_edit(|d| d.colliders[0].density = Some(NAN)), NonFinite),
        m("spawn: no colliders", spawn_edit(|d| d.colliders.clear()), OutOfRange),
        m("spawn: zero box", spawn_with("n", BodyType::Dynamic, Shape::Box { half: [0.0, 1.0, 1.0] }), BadShape),
        m("spawn: flat hull", spawn_with("n", BodyType::Dynamic, Shape::Hull { points: vec![[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [1.0, 1.0, 0.0]] }), BadShape),
        m("spawn: dynamic trimesh", spawn_with("n", BodyType::Dynamic, trimesh(1)), DynamicMesh),
        m("spawn: a trimesh of repeated indices", spawn_with("n", BodyType::Fixed, Shape::Trimesh {
            vertices: vec![[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
            indices: vec![[0.0, 0.0, 1.0], [2.0, 2.0, 2.0]],
        }), BadShape),
        m("spawn: a trimesh at one point", spawn_with("n", BodyType::Fixed, Shape::Trimesh {
            vertices: vec![[1.0, 2.0, 3.0]; 3],
            indices: vec![[0.0, 1.0, 2.0]],
        }), BadShape),
        m("spawn: a trimesh on one line", spawn_with("n", BodyType::Fixed, Shape::Trimesh {
            vertices: vec![[0.0, 0.0, 0.0], [1.0, 1.0, 1.0], [2.0, 2.0, 2.0]],
            indices: vec![[0.0, 1.0, 2.0]],
        }), BadShape),
        m("spawn: groups past 16 bits", spawn_edit(|d| d.colliders[0].groups = Some(Groups { member: 65536.0, collides: 1.0 })), OutOfRange),
        m("spawn: fractional groups", spawn_edit(|d| d.colliders[0].groups = Some(Groups { member: 1.5, collides: 1.0 })), OutOfRange),
        m("spawn: three colliders", spawn_edit(|d| {
            d.colliders.push(ColliderDesc::new("c2", ball(0.1)));
            d.colliders.push(ColliderDesc::new("c3", ball(0.1)));
        }), LimitColliders),
        m("spawn: nine hull points", spawn_with("n", BodyType::Dynamic, Shape::Hull { points: hull_points(9) }), LimitHullVertices),
        m("spawn: five triangles", spawn_with("n", BodyType::Fixed, trimesh(5)), LimitTriangles),
        m("spawn: a CCD body", spawn_edit(|d| d.ccd = true), LimitCcd),
        ("spawn: past memoryBytes", Tight, spawn_with("n", BodyType::Dynamic, cube(0.5)), LimitMemory),
        m("remove: unknown", Command::Remove { key: key("nope") }, UnknownKey),
        m("remove: malformed", Command::Remove { key: key("") }, InvalidKey),
        ("remove: a static piece", Static, Command::Remove { key: key("static:box:0000") }, UnknownKey),
        m("addJoint: malformed key", joint_edit(|j| j.key = "bad key".into()), InvalidKey),
        m("addJoint: duplicate key", joint_edit(|j| j.key = "j".into()), DuplicateKey),
        m("addJoint: unknown body", joint_edit(|j| j.a = "nope".into()), UnknownKey),
        m("addJoint: unknown body and a duplicate key", joint_edit(|j| {
            j.key = "j".into();
            j.b = Some("nope".into());
        }), UnknownKey),
        ("addJoint: a static piece", Static, joint_edit(|j| j.b = Some("static:box:0000".into())), UnknownKey),
        m("addJoint: NaN anchor", joint_edit(|j| j.anchor_a[0] = NAN), NonFinite),
        m("addJoint: anchor past worldExtent", joint_edit(|j| j.anchor_b[1] = HUGE), OutOfRange),
        m("addJoint: a to itself", joint_edit(|j| j.b = Some("d".into())), OutOfRange),
        m("addJoint: zero hinge axis", joint_edit(|j| {
            j.joint_type = JointType::Hinge;
            j.axis = Some([0.0; 3]);
        }), OutOfRange),
        m("addJoint: past the joint limit", joint_edit(|_| {}), LimitJoints),
        m("removeJoint: unknown", Command::RemoveJoint { key: key("nope") }, UnknownKey),
        m("removeJoint: malformed", Command::RemoveJoint { key: key("__proto__") }, InvalidKey),
        m("impulse: unknown", impulse("nope", [0.0, 0.0, 1.0], None), UnknownKey),
        m("impulse: malformed", impulse("a/b", [0.0, 0.0, 1.0], None), InvalidKey),
        m("impulse: fixed body", impulse("f", [0.0, 0.0, 1.0], None), WrongBodyType),
        m("impulse: kinematic body", impulse("k", [0.0, 0.0, 1.0], None), WrongBodyType),
        m("impulse: NaN", impulse("d", [NAN, 0.0, 0.0], None), NonFinite),
        m("impulse: past f32", impulse("d", [0.0, F32_OVERFLOW, 0.0], None), NonFinite),
        m("impulse: infinite point", impulse("d", [0.0, 0.0, 1.0], Some([INF, 0.0, 0.0])), NonFinite),
        m("setVelocity: kinematic", Command::SetVelocity { key: key("k"), linvel: Some([1.0, 0.0, 0.0]), angvel: None }, WrongBodyType),
        m("setVelocity: past maxSpeed", Command::SetVelocity { key: key("d"), linvel: Some([HUGE, 0.0, 0.0]), angvel: None }, OutOfRange),
        m("setVelocity: past maxAngularSpeed", Command::SetVelocity { key: key("d"), linvel: None, angvel: Some([0.0, 0.0, 2000.0]) }, OutOfRange),
        m("setVelocity: NaN", Command::SetVelocity { key: key("d"), linvel: None, angvel: Some([NAN; 3]) }, NonFinite),
        m("setVelocity: unknown", Command::SetVelocity { key: key("nope"), linvel: None, angvel: None }, UnknownKey),
        m("setPose: kinematic", set_pose("k", pose([0.0, 0.0, 1.0])), WrongBodyType),
        m("setPose: past worldExtent", set_pose("d", pose([0.0, -HUGE, 0.0])), OutOfRange),
        m("setPose: non-unit quaternion", set_pose("d", Pose { p: [0.0; 3], q: [0.0, 0.0, 0.0, 2.0] }), OutOfRange),
        m("setPose: NaN", set_pose("d", pose([NAN, 0.0, 0.0])), NonFinite),
        m("setPose: unknown", set_pose("nope", pose([0.0; 3])), UnknownKey),
        ("setPose: a static piece", Static, set_pose("static:box:0000", pose([0.0; 3])), UnknownKey),
        m("setNextKinematicPose: dynamic", Command::SetNextKinematicPose { key: key("d"), pose: pose([0.0; 3]) }, WrongBodyType),
        m("setNextKinematicPose: NaN", Command::SetNextKinematicPose { key: key("k"), pose: pose([0.0, NAN, 0.0]) }, NonFinite),
        m("setNextKinematicPose: past f32", Command::SetNextKinematicPose { key: key("k"), pose: pose([F32_OVERFLOW, 0.0, 0.0]) }, NonFinite),
        m("setNextKinematicPose: unknown", Command::SetNextKinematicPose { key: key("nope"), pose: pose([0.0; 3]) }, UnknownKey),
        m("areaPush: zero radius", push([0.0; 3], 0.0, 1.0, None), OutOfRange),
        m("areaPush: NaN radius", push([0.0; 3], NAN, 1.0, None), NonFinite),
        m("areaPush: negative falloff", push([0.0; 3], 5.0, -1.0, None), OutOfRange),
        m("areaPush: infinite centre", push([0.0, INF, 0.0], 5.0, 1.0, None), NonFinite),
        m("areaPush: groups past 16 bits", push([0.0; 3], 5.0, 1.0, Some(Groups { member: 1.0, collides: 70000.0 })), OutOfRange),
        m("setMotor: unknown joint", Command::SetMotor { key: key("nope"), motor: Motor::default() }, UnknownKey),
        m("setMotor: malformed", Command::SetMotor { key: key(""), motor: Motor::default() }, InvalidKey),
        m("setMotor: NaN", motor(NAN), NonFinite),
        m("setMotor: past maxAngularSpeed", motor(HUGE), OutOfRange),
        m("wake: unknown", Command::Wake { key: key("nope") }, UnknownKey),
        m("wake: malformed", Command::Wake { key: long_key() }, InvalidKey),
        m("sleep: unknown", Command::Sleep { key: key("nope") }, UnknownKey),
        ("sleep: a static piece", Static, Command::Sleep { key: key("static:box:0000") }, UnknownKey),
    ]
}

/// Runs `call` on a fresh `which` world; asserts the code and that nothing changed.
fn refuse<T: std::fmt::Debug>(which: Fixture, name: &str, code: PhysicsError, call: impl FnOnce(&mut World) -> Result<T, PhysicsFailure>) {
    let mut w = fixture(which);
    let before = observe(&w);
    let got = call(&mut w).map_err(|f| f.code);
    assert_eq!(got.map(|_| ()), Err(code), "{name}");
    assert!(observe(&w) == before, "{name}: the world changed");
    w.check().expect("a refusal never poisons");
}

#[test]
fn every_hostile_command_is_refused_alone_and_in_both_batch_modes_with_no_side_effect() {
    for (name, which, command, code) in command_rows() {
        refuse(which, name, code, |w| w.command(&command));
        refuse(which, name, code, |w| w.apply_atomic(std::slice::from_ref(&command)));
        let mut w = fixture(which);
        let before = observe(&w);
        assert_eq!(w.apply_each(std::slice::from_ref(&command)), vec![Err(code)], "{name} (each)");
        assert!(observe(&w) == before, "{name} (each): the world changed");
    }
}

#[test]
fn a_hostile_command_late_in_an_atomic_batch_names_its_index_and_applies_nothing() {
    for (name, which, command, code) in command_rows() {
        let batch = [impulse("d", [0.0, 0.0, 5.0], None), Command::Wake { key: key("d2") }, command];
        refuse(which, name, code, |w| {
            let failure = w.apply_atomic(&batch);
            if let Err(f) = &failure {
                assert_eq!(f.index, Some(2), "{name}");
            }
            failure
        });
    }
}

#[test]
fn an_each_batch_of_every_hostile_command_applies_nothing() {
    for which in [Fixture::Main, Fixture::Static, Fixture::Tight] {
        let rows: Vec<_> = command_rows().into_iter().filter(|row| row.1 == which).collect();
        let commands: Vec<Command> = rows.iter().map(|row| row.2.clone()).collect();
        let mut w = fixture(which);
        let before = observe(&w);
        let outcomes = w.apply_each(&commands);
        let expected: Vec<_> = rows.iter().map(|row| Err(row.3)).collect();
        assert_eq!(outcomes, expected, "{which:?}");
        assert!(observe(&w) == before, "{which:?}: the world changed");
    }
}

#[test]
fn the_body_limit_refuses_the_spawn_past_it() {
    let batch = [spawn_with("n1", BodyType::Dynamic, cube(0.5)), spawn_with("n2", BodyType::Dynamic, cube(0.5))];
    refuse(Fixture::Main, "two spawns past bodies", PhysicsError::LimitBodies, |w| w.apply_atomic(&batch));
}

/// A call on a world that is not a command.
type Call = Box<dyn Fn(&mut World) -> Result<(), PhysicsFailure>>;

/// The rows that are not commands: queries, the static world, imports, JSON, stepMs, restore.
fn other_rows() -> Vec<(&'static str, Fixture, PhysicsError, Call)> {
    use Fixture::{Main, Static, YUp};
    use PhysicsError::*;
    let free = QueryFilter::default();
    let net = NetBodyState { p: [0.0, 0.0, 1.0], q: QUAT_IDENTITY, v: [0.0; 3], w: [0.0; 3], sleeping: false };
    let static_two = StaticWorld { boxes: vec![vec![0.0, 0.0, 0.0, 1.0, 1.0, 1.0], vec![2.0, 0.0, 0.0, 3.0, 1.0, 1.0]], ramps: vec![] };
    let static_one = |values: Vec<f64>| StaticWorld { boxes: vec![values], ramps: vec![] };
    let other_build = {
        let mut probe = fixture(Main);
        probe.step().expect("steps");
        let good = probe.snapshot().expect("snapshots");
        let mut bytes = good[..8].to_vec();
        let id = "genex-physics/0.0.1+contract-1.0+rapier-0.36.0+det+wasm32";
        bytes.extend_from_slice(&(id.len() as u16).to_le_bytes());
        bytes.extend_from_slice(id.as_bytes());
        let old_len = usize::from(u16::from_le_bytes([good[8], good[9]]));
        bytes.extend_from_slice(&good[10 + old_len..]);
        bytes
    };
    let filter = |f: QueryFilter| move |w: &mut World| w.ray([0.0, 0.0, 9.0], [0.0, 0.0, -1.0], 5.0, &f).map(drop);
    vec![
        ("ray: past the query quota", Main, LimitQueries, Box::new(move |w| w.ray([0.0, 0.0, 9.0], [0.0, 0.0, -1.0], 5.0, &free.clone()).map(drop))),
        ("ray: zero direction", Main, OutOfRange, Box::new(|w| w.ray([0.0; 3], [0.0; 3], 5.0, &QueryFilter::default()).map(drop))),
        ("ray: NaN origin", Main, NonFinite, Box::new(|w| w.ray([NAN, 0.0, 0.0], [0.0, 0.0, 1.0], 5.0, &QueryFilter::default()).map(drop))),
        ("ray: negative maxDist", Main, OutOfRange, Box::new(|w| w.ray([0.0; 3], [0.0, 0.0, 1.0], -1.0, &QueryFilter::default()).map(drop))),
        ("ray: malformed excluded key", Main, InvalidKey, Box::new(filter(QueryFilter { exclude_bodies: vec![key("")], ..QueryFilter::default() }))),
        ("ray: 65 excluded keys", Main, OutOfRange, Box::new(filter(QueryFilter { exclude_bodies: (0..65).map(|i| format!("x{i}")).collect(), ..QueryFilter::default() }))),
        ("shapeCast: a trimesh", Main, OutOfRange, Box::new(|w| w.shape_cast(&trimesh(1), Pose::at([0.0; 3]), [0.0, 0.0, 1.0], 5.0, &QueryFilter::default()).map(drop))),
        ("shapeCast: nine hull points", Main, LimitHullVertices, Box::new(|w| w.shape_cast(&Shape::Hull { points: hull_points(9) }, Pose::at([0.0; 3]), [0.0, 0.0, 1.0], 5.0, &QueryFilter::default()).map(drop))),
        ("overlap: a zero sphere", Main, BadShape, Box::new(|w| w.overlap(&ball(0.0), Pose::at([0.0; 3]), &QueryFilter::default()).map(drop))),
        ("overlap: pose past worldExtent", Main, OutOfRange, Box::new(|w| w.overlap(&ball(1.0), Pose::at([HUGE, 0.0, 0.0]), &QueryFilter::default()).map(drop))),
        ("query JSON: unknown verb", Main, BadCommand, Box::new(|w| w.query_json(&json!({"sweep": {}})).map(drop))),
        ("addStaticWorld: past staticPieces", Main, LimitStatic, Box::new(move |w| w.add_static_world(&static_two))),
        ("addStaticWorld: NaN", Main, NonFinite, Box::new(move |w| w.add_static_world(&static_one(vec![0.0, 0.0, NAN, 1.0, 1.0, 1.0])))),
        ("addStaticWorld: not float32", Main, OutOfRange, Box::new(move |w| w.add_static_world(&static_one(vec![0.1, 0.0, 0.0, 1.0, 1.0, 1.0])))),
        ("addStaticWorld: min = max", Main, BadShape, Box::new(move |w| w.add_static_world(&static_one(vec![0.0, 0.0, 0.0, 0.0, 1.0, 1.0])))),
        ("addStaticWorld: seven values", Main, OutOfRange, Box::new(move |w| w.add_static_world(&static_one(vec![0.0; 7])))),
        ("addStaticWorld: a second time", Static, DuplicateKey, Box::new(move |w| w.add_static_world(&static_one(vec![0.0, 0.0, 0.0, 1.0, 1.0, 1.0])))),
        ("addStaticWorld: y-up", YUp, OutOfRange, Box::new(move |w| w.add_static_world(&static_one(vec![0.0, 0.0, 0.0, 1.0, 1.0, 1.0])))),
        ("importBodyState: fixed", Main, WrongBodyType, Box::new(move |w| w.import_body_state("f", &net))),
        ("importBodyState: static piece", Static, UnknownKey, Box::new(move |w| w.import_body_state("static:box:0000", &net))),
        ("importBodyState: NaN", Main, NonFinite, Box::new(move |w| w.import_body_state("d", &NetBodyState { p: [NAN; 3], ..net }))),
        ("importBodyState: past maxSpeed", Main, OutOfRange, Box::new(move |w| w.import_body_state("d", &NetBodyState { v: [HUGE, 0.0, 0.0], ..net }))),
        ("importBodyState: malformed", Main, InvalidKey, Box::new(move |w| w.import_body_state("", &net))),
        ("JSON atomic: unknown verb", Main, BadCommand, Box::new(|w| w.apply_json_atomic(&json!([{"explode": {"key": "d"}}])))),
        ("JSON atomic: two verbs", Main, BadCommand, Box::new(|w| w.apply_json_atomic(&json!([{"wake": {"key": "d"}, "sleep": {"key": "d"}}])))),
        ("JSON atomic: unknown argument", Main, BadCommand, Box::new(|w| w.apply_json_atomic(&json!([{"wake": {"key": "d", "now": true}}])))),
        ("JSON atomic: missing argument", Main, BadCommand, Box::new(|w| w.apply_json_atomic(&json!([{"impulse": {"key": "d"}}])))),
        ("JSON atomic: not an array", Main, BadCommand, Box::new(|w| w.apply_json_atomic(&json!({"wake": {"key": "d"}})))),
        ("JSON each: not an array", Main, BadCommand, Box::new(|w| w.apply_json_each(&json!("wake")).map(drop))),
        ("stepMs: NaN", Main, NonFinite, Box::new(|w| w.record_step_ms(NAN))),
        ("stepMs: negative", Main, OutOfRange, Box::new(|w| w.record_step_ms(-1.0))),
        ("restore: garbage", Main, BadSnapshot, Box::new(|w| w.restore(b"not a snapshot"))),
        ("restore: another build", Main, BuildMismatch, Box::new(move |w| w.restore(&other_build))),
    ]
}

#[test]
fn every_hostile_query_import_static_json_and_snapshot_call_is_refused_with_no_side_effect() {
    for (name, which, code, call) in other_rows() {
        refuse(which, name, code, |w| call(w));
    }
}

#[test]
fn a_bad_world_description_creates_nothing() {
    let rows: Vec<(&str, PhysicsError, WorldDesc)> = vec![
        ("contract 2.0", PhysicsError::ContractMismatch, WorldDesc { contract: "2.0".into(), ..limited_desc(UpAxis::Z) }),
        ("NaN dt", PhysicsError::NonFinite, WorldDesc { dt: NAN, ..limited_desc(UpAxis::Z) }),
        ("9 substeps", PhysicsError::OutOfRange, WorldDesc { substeps: 9.0, ..limited_desc(UpAxis::Z) }),
        ("gravity past f32", PhysicsError::NonFinite, WorldDesc { gravity: [0.0, 0.0, F32_OVERFLOW], ..limited_desc(UpAxis::Z) }),
    ];
    for (name, code, desc) in rows {
        assert_eq!(World::create(&desc).map(drop).map_err(|f| f.code), Err(code), "{name}");
    }
}

#[test]
fn the_rows_cover_every_error_code_but_internal() {
    let mut codes: BTreeSet<PhysicsError> = command_rows().into_iter().map(|row| row.3).collect();
    codes.extend(other_rows().into_iter().map(|row| row.2));
    codes.extend([PhysicsError::LimitBodies, PhysicsError::ContractMismatch]);
    let missing: Vec<_> = PhysicsError::ALL.into_iter().filter(|code| !codes.contains(code) && *code != PhysicsError::Internal).collect();
    assert!(missing.is_empty(), "no row for {missing:?}");
}

#[test]
fn this_binary_reports_the_model_without_the_counting_allocator() {
    let w = fixture(Fixture::Main);
    assert!(!w.memory_is_measured());
    assert!(!genex_physics::accounting::installed());
}
