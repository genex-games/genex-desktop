//! Joints (§6.4, §7): every type with limits and motors, setMotor, removeJoint, remove cascading to
//! joints, the joint section of stateHash (§10.1), and refusals that change nothing.

mod common;

use common::{ball, body, cube, observe, world};
use genex_physics::{
    BodyType, JointDesc, JointType, Motor, PhysicsError, PhysicsFailure, Shape, UpAxis, Vec3, World, WorldDesc,
};

/// `v` given in y-up terms, in the frame `up`.
fn to(up: UpAxis, v: Vec3) -> Vec3 {
    match up {
        UpAxis::Y => v,
        UpAxis::Z => [v[0], -v[2], v[1]],
    }
}

fn joint(key: &str, a: &str, b: Option<&str>, joint_type: JointType) -> JointDesc {
    JointDesc::new(key, a, b, joint_type, [0.0; 3], [0.0; 3])
}

fn run(w: &mut World, steps: usize) {
    for _ in 0..steps {
        w.step().expect("steps");
    }
}

/// The caller-up component of a position.
fn height(up: UpAxis, p: Vec3) -> f64 {
    match up {
        UpAxis::Y => p[1],
        UpAxis::Z => p[2],
    }
}

#[test]
fn every_joint_type_joins_bodies_and_the_world_in_both_frames() {
    for up in [UpAxis::Y, UpAxis::Z] {
        let mut w = world(up);
        for (i, key) in ["a", "b", "c", "d", "e", "f"].iter().enumerate() {
            w.spawn(&body(key, BodyType::Dynamic, to(up, [i as f64 * 3.0, 5.0, 0.0]), cube(0.5))).expect("spawns");
        }
        let mut hinge = joint("j.hinge", "a", Some("b"), JointType::Hinge);
        hinge.axis = Some(to(up, [0.0, 0.0, 1.0]));
        hinge.limits = Some([-1.0, 1.0]);
        hinge.motor = Some(Motor { target_vel: Some(1.0), damping: Some(5.0), ..Motor::default() });
        let mut slider = joint("j.slider", "c", None, JointType::Slider);
        slider.axis = Some(to(up, [0.0, 1.0, 0.0]));
        slider.anchor_b = to(up, [6.0, 5.0, 0.0]);
        slider.limits = Some([-1.0, 0.0]);
        let mut rope = joint("j.rope", "d", Some("e"), JointType::Rope);
        rope.limits = Some([0.0, 4.0]);
        rope.collide_connected = true;
        let joints = [
            joint("j.fixed", "e", Some("f"), JointType::Fixed),
            joint("j.ball", "f", None, JointType::Ball),
            hinge,
            slider,
            rope,
        ];
        for desc in &joints {
            w.add_joint(desc).unwrap_or_else(|f| panic!("{} in {up:?}: {f}", desc.key));
        }
        assert_eq!(w.joint_count(), joints.len());
        run(&mut w, 30);
    }
}

#[test]
fn a_ball_joint_to_the_world_holds_its_body_up() {
    for up in [UpAxis::Y, UpAxis::Z] {
        let mut w = world(up);
        w.spawn(&body("bob", BodyType::Dynamic, to(up, [0.0, 5.0, 0.0]), ball(0.5))).expect("bob");
        let mut pin = joint("pin", "bob", None, JointType::Ball);
        pin.anchor_b = to(up, [0.0, 5.0, 0.0]);
        w.add_joint(&pin).expect("pin");
        run(&mut w, 60);
        let p = w.body("bob").expect("there").pose.p;
        assert!((height(up, p) - 5.0).abs() < 0.01, "{up:?}: {p:?}");
    }
}

#[test]
fn a_rope_stops_its_body_at_its_length() {
    let mut w = world(UpAxis::Y);
    w.spawn(&body("bob", BodyType::Dynamic, [0.0, 9.0, 0.0], ball(0.25))).expect("bob");
    let mut rope = joint("rope", "bob", None, JointType::Rope);
    rope.anchor_b = [0.0, 10.0, 0.0];
    rope.limits = Some([0.0, 2.0]);
    w.add_joint(&rope).expect("rope");
    run(&mut w, 120);
    let y = w.body("bob").expect("there").pose.p[1];
    assert!((y - 8.0).abs() < 0.02, "hangs at the rope's length: {y}");
}

#[test]
fn a_slider_moves_along_its_axis_within_its_limits() {
    for up in [UpAxis::Y, UpAxis::Z] {
        let mut w = world(up);
        w.spawn(&body("car", BodyType::Dynamic, to(up, [0.0, 5.0, 0.0]), cube(0.25))).expect("car");
        let mut rail = joint("rail", "car", None, JointType::Slider);
        rail.axis = Some(to(up, [0.0, 1.0, 0.0]));
        rail.anchor_b = to(up, [0.0, 5.0, 0.0]);
        rail.limits = Some([-1.0, 0.0]);
        w.add_joint(&rail).expect("rail");
        run(&mut w, 120);
        let p = w.body("car").expect("there").pose.p;
        assert!((height(up, p) - 4.0).abs() < 0.02, "{up:?}: stops at the lower limit, {p:?}");
    }
}

#[test]
fn a_hinge_motor_spins_its_body_and_set_motor_changes_it() {
    let still = WorldDesc::new(1.0 / 60.0, 1.0, [0.0; 3], UpAxis::Y, 1.0);
    let mut w = World::create(&still).expect("valid");
    w.spawn(&body("wheel", BodyType::Dynamic, [0.0, 0.0, 0.0], ball(0.5))).expect("wheel");
    let mut axle = joint("axle", "wheel", None, JointType::Hinge);
    axle.axis = Some([0.0, 0.0, 1.0]);
    axle.motor = Some(Motor { target_vel: Some(2.0), damping: Some(1000.0), ..Motor::default() });
    w.add_joint(&axle).expect("axle");
    run(&mut w, 60);
    let spin = w.body("wheel").expect("there").angvel;
    assert!((spin[2] - 2.0).abs() < 0.05, "{spin:?}");
    let before = w.state_hash();
    w.set_motor("axle", Motor { target_vel: Some(-1.0), damping: Some(1000.0), ..Motor::default() }).expect("motor");
    assert_ne!(w.state_hash(), before, "the motor is in the state hash");
    run(&mut w, 60);
    let spin = w.body("wheel").expect("there").angvel;
    assert!((spin[2] + 1.0).abs() < 0.05, "{spin:?}");
}

#[test]
fn a_hinge_stops_at_its_limit() {
    let mut w = world(UpAxis::Y);
    w.spawn(&body("door", BodyType::Dynamic, [1.0, 0.0, 0.0], cube(0.25))).expect("door");
    let mut hinge = joint("hinge", "door", None, JointType::Hinge);
    hinge.axis = Some([0.0, 0.0, 1.0]);
    hinge.anchor_a = [-1.0, 0.0, 0.0];
    hinge.limits = Some([-0.5, 0.5]);
    w.add_joint(&hinge).expect("hinge");
    run(&mut w, 120);
    let q = w.body("door").expect("there").pose.q;
    let angle = 2.0 * q[2].atan2(q[3]);
    assert!((angle + 0.5).abs() < 0.03, "falls to −0.5 rad about z: {angle}");
}

#[test]
fn a_fixed_joint_moves_two_bodies_as_one() {
    let still = WorldDesc::new(1.0 / 60.0, 1.0, [0.0; 3], UpAxis::Z, 1.0);
    let mut w = World::create(&still).expect("valid");
    w.spawn(&body("a", BodyType::Dynamic, [0.0, 0.0, 0.0], cube(0.5))).expect("a");
    w.spawn(&body("b", BodyType::Dynamic, [2.0, 0.0, 0.0], cube(0.5))).expect("b");
    let mut weld = joint("weld", "a", Some("b"), JointType::Fixed);
    weld.anchor_a = [1.0, 0.0, 0.0];
    weld.anchor_b = [-1.0, 0.0, 0.0];
    w.add_joint(&weld).expect("weld");
    // Through the pair's centre of mass, so the welded pair translates without turning.
    w.impulse("a", [0.0, 3.0, 0.0], Some([1.0, 0.0, 0.0])).expect("push a");
    run(&mut w, 60);
    let (a, b) = (w.body("a").expect("a").pose.p, w.body("b").expect("b").pose.p);
    assert!(a[1] > 0.5 && (a[1] - b[1]).abs() < 0.01 && (b[0] - a[0] - 2.0).abs() < 0.01, "{a:?} {b:?}");
}

#[test]
fn remove_takes_the_joints_of_its_body_with_it() {
    let mut w = world(UpAxis::Y);
    for key in ["a", "b", "c"] {
        w.spawn(&body(key, BodyType::Dynamic, [0.0, 5.0, 0.0], ball(0.5))).expect("spawns");
    }
    w.add_joint(&joint("ab", "a", Some("b"), JointType::Ball)).expect("ab");
    w.add_joint(&joint("ca", "c", Some("a"), JointType::Ball)).expect("ca");
    w.add_joint(&joint("bc", "b", Some("c"), JointType::Ball)).expect("bc");
    let memory = w.memory_bytes();
    w.remove("a").expect("removes");
    assert_eq!(w.joint_count(), 1);
    assert!(w.memory_bytes() < memory);
    assert_eq!(w.remove_joint("ab").err().map(|f| f.code), Some(PhysicsError::UnknownKey));
    w.remove_joint("bc").expect("removes");
    assert_eq!(w.joint_count(), 0);
    w.add_joint(&joint("bc", "b", None, JointType::Fixed)).expect("a removed key is free again");
    run(&mut w, 5);
}

#[test]
fn the_state_hash_covers_each_joint_by_key_and_motor() {
    let scene = |motor: Option<Motor>, key: &str| -> u64 {
        let mut w = world(UpAxis::Y);
        w.spawn(&body("a", BodyType::Fixed, [0.0; 3], cube(0.5))).expect("a");
        let mut desc = joint(key, "a", None, JointType::Hinge);
        desc.axis = Some([1.0, 0.0, 0.0]);
        desc.motor = motor;
        w.add_joint(&desc).expect("joint");
        w.state_hash()
    };
    let empty = scene(None, "j");
    assert_eq!(empty, scene(Some(Motor::default()), "j"), "absent values hash as 0");
    assert_eq!(empty, scene(Some(Motor { target_vel: Some(-0.0), ..Motor::default() }), "j"), "−0 hashes as 0");
    assert_ne!(empty, scene(None, "k"), "the key is hashed");
    assert_ne!(empty, scene(Some(Motor { max_force: Some(1.0), ..Motor::default() }), "j"));
    let mut w = world(UpAxis::Y);
    w.spawn(&body("a", BodyType::Fixed, [0.0; 3], cube(0.5))).expect("a");
    let bodies_only = w.state_hash();
    w.add_joint(&joint("j", "a", None, JointType::Fixed)).expect("joint");
    assert_ne!(w.state_hash(), bodies_only, "a joint is in the hash");
}

type Row = (&'static str, fn() -> JointDesc, PhysicsError);

fn hinge() -> JointDesc {
    let mut desc = joint("new", "a", Some("b"), JointType::Hinge);
    desc.axis = Some([0.0, 1.0, 0.0]);
    desc
}

fn edited(edit: fn(&mut JointDesc)) -> JointDesc {
    let mut desc = hinge();
    edit(&mut desc);
    desc
}

const NAN: f64 = f64::NAN;

fn hostile_joints() -> Vec<Row> {
    vec![
        ("key malformed", || edited(|d| d.key = "a b".into()), PhysicsError::InvalidKey),
        ("key static", || edited(|d| d.key = "static:box:0000".into()), PhysicsError::InvalidKey),
        ("a malformed", || edited(|d| d.a = String::new()), PhysicsError::InvalidKey),
        ("b refused name", || edited(|d| d.b = Some("__proto__".into())), PhysicsError::InvalidKey),
        ("a unknown", || edited(|d| d.a = "ghost".into()), PhysicsError::UnknownKey),
        ("b unknown", || edited(|d| d.b = Some("ghost".into())), PhysicsError::UnknownKey),
        ("b a static piece", || edited(|d| d.b = Some("static:box:0000".into())), PhysicsError::UnknownKey),
        ("duplicate", || edited(|d| d.key = "old".into()), PhysicsError::DuplicateKey),
        ("a to itself", || edited(|d| d.b = Some("a".into())), PhysicsError::OutOfRange),
        ("anchorA past worldExtent", || edited(|d| d.anchor_a = [0.0, 0.0, 200_000.0]), PhysicsError::OutOfRange),
        ("anchorB NaN", || edited(|d| d.anchor_b = [NAN, 0.0, 0.0]), PhysicsError::NonFinite),
        ("anchorA 1e39", || edited(|d| d.anchor_a = [1e39, 0.0, 0.0]), PhysicsError::NonFinite),
        ("hinge without axis", || edited(|d| d.axis = None), PhysicsError::OutOfRange),
        ("axis zero", || edited(|d| d.axis = Some([0.0, -0.0, 0.0])), PhysicsError::OutOfRange),
        ("axis NaN", || edited(|d| d.axis = Some([NAN, 1.0, 0.0])), PhysicsError::NonFinite),
        ("axis on a ball", || {
            let mut d = joint("new", "a", Some("b"), JointType::Ball);
            d.axis = Some([1.0, 0.0, 0.0]);
            d
        }, PhysicsError::OutOfRange),
        ("limits on a fixed joint", || {
            let mut d = joint("new", "a", Some("b"), JointType::Fixed);
            d.limits = Some([0.0, 1.0]);
            d
        }, PhysicsError::OutOfRange),
        ("limits reversed", || edited(|d| d.limits = Some([1.0, -1.0])), PhysicsError::OutOfRange),
        ("limits NaN", || edited(|d| d.limits = Some([0.0, NAN])), PhysicsError::NonFinite),
        ("rope without limits", || joint("new", "a", Some("b"), JointType::Rope), PhysicsError::OutOfRange),
        ("rope negative min", || {
            let mut d = joint("new", "a", Some("b"), JointType::Rope);
            d.limits = Some([-1.0, 2.0]);
            d
        }, PhysicsError::OutOfRange),
        ("rope zero length", || {
            let mut d = joint("new", "a", Some("b"), JointType::Rope);
            d.limits = Some([0.0, 0.0]);
            d
        }, PhysicsError::OutOfRange),
        ("motor on a ball", || {
            let mut d = joint("new", "a", Some("b"), JointType::Ball);
            d.motor = Some(Motor::default());
            d
        }, PhysicsError::OutOfRange),
        ("motor targetVel past maxAngularSpeed", || edited(|d| d.motor = Some(Motor { target_vel: Some(1_001.0), ..Motor::default() })), PhysicsError::OutOfRange),
        ("motor negative stiffness", || edited(|d| d.motor = Some(Motor { stiffness: Some(-1.0), ..Motor::default() })), PhysicsError::OutOfRange),
        ("motor NaN damping", || edited(|d| d.motor = Some(Motor { damping: Some(NAN), ..Motor::default() })), PhysicsError::NonFinite),
        ("motor negative maxForce", || edited(|d| d.motor = Some(Motor { max_force: Some(-2.0), ..Motor::default() })), PhysicsError::OutOfRange),
        ("motor targetPos inf", || edited(|d| d.motor = Some(Motor { target_pos: Some(f64::INFINITY), ..Motor::default() })), PhysicsError::NonFinite),
    ]
}

type MotorRow = (&'static str, &'static str, Motor, PhysicsError);

fn hostile_motors() -> Vec<MotorRow> {
    vec![
        ("unknown joint", "ghost", Motor::default(), PhysicsError::UnknownKey),
        ("malformed key", "a b", Motor::default(), PhysicsError::InvalidKey),
        ("ball joint", "ball", Motor::default(), PhysicsError::OutOfRange),
        ("NaN target", "old", Motor { target_pos: Some(NAN), ..Motor::default() }, PhysicsError::NonFinite),
        ("slider targetVel past maxSpeed", "slide", Motor { target_vel: Some(-1_001.0), ..Motor::default() }, PhysicsError::OutOfRange),
    ]
}

/// Two bodies, a hinge "old", a ball joint "ball" and a slider "slide", stepped once.
fn jointed(up: UpAxis) -> World {
    let mut w = world(up);
    w.spawn(&body("a", BodyType::Dynamic, [0.0, 0.0, 5.0], cube(0.5))).expect("a");
    w.spawn(&body("b", BodyType::Dynamic, [2.0, 0.0, 5.0], cube(0.5))).expect("b");
    let mut old = hinge();
    old.key = "old".into();
    w.add_joint(&old).expect("old");
    w.add_joint(&joint("ball", "b", None, JointType::Ball)).expect("ball");
    let mut slide = joint("slide", "a", None, JointType::Slider);
    slide.axis = Some([1.0, 0.0, 0.0]);
    w.add_joint(&slide).expect("slide");
    w.step().expect("steps");
    w
}

#[test]
fn hostile_joints_and_motors_are_refused_with_their_code_and_change_nothing() {
    for up in [UpAxis::Y, UpAxis::Z] {
        let mut w = jointed(up);
        let before = observe(&w);
        for (name, desc, expected) in hostile_joints() {
            assert_eq!(w.add_joint(&desc()).err().map(|f| f.code), Some(expected), "{name} in {up:?}");
            assert_eq!((observe(&w), w.joint_count()), (before.clone(), 3), "{name} changed the world");
        }
        for (name, key, motor, expected) in hostile_motors() {
            assert_eq!(w.set_motor(key, motor).err().map(|f| f.code), Some(expected), "{name} in {up:?}");
            assert_eq!(observe(&w), before, "{name} changed the world");
        }
    }
}

fn limited(edit: fn(&mut WorldDesc)) -> World {
    let mut desc = WorldDesc::new(1.0 / 60.0, 1.0, [0.0, -9.81, 0.0], UpAxis::Y, 1.0);
    edit(&mut desc);
    World::create(&desc).expect("valid")
}

#[test]
fn joints_past_their_limit_or_memory_are_refused_and_change_nothing() {
    let mut w = limited(|d| d.limits.joints = Some(1.0));
    w.spawn(&body("a", BodyType::Dynamic, [0.0, 1.0, 0.0], ball(0.5))).expect("a");
    w.add_joint(&joint("one", "a", None, JointType::Ball)).expect("one");
    let before = observe(&w);
    let refused: Result<(), PhysicsFailure> = w.add_joint(&joint("two", "a", None, JointType::Ball));
    assert_eq!(refused.err().map(|f| f.code), Some(PhysicsError::LimitJoints));
    assert_eq!(observe(&w), before);

    let mut w = limited(|_| {});
    w.spawn(&body("a", BodyType::Dynamic, [0.0, 1.0, 0.0], ball(0.5))).expect("a");
    let used = w.memory_bytes();
    let mut tight = WorldDesc::new(1.0 / 60.0, 1.0, [0.0, -9.81, 0.0], UpAxis::Y, 1.0);
    tight.limits.memory_bytes = Some((used + 100) as f64);
    let mut w = World::create(&tight).expect("valid");
    w.spawn(&body("a", BodyType::Dynamic, [0.0, 1.0, 0.0], ball(0.5))).expect("a");
    let before = observe(&w);
    let refused = w.add_joint(&joint("j", "a", None, JointType::Ball));
    assert_eq!(refused.err().map(|f| f.code), Some(PhysicsError::LimitMemory));
    assert_eq!((observe(&w), w.joint_count()), (before, 0));
}

/// A hinged pendulum and a sliding block in either frame, stepped 90 times.
fn turned_joints(up: UpAxis) -> World {
    let mut w = World::create(&WorldDesc::new(1.0 / 60.0, 1.0, to(up, [0.0, -9.81, 0.0]), up, 1.0)).expect("valid");
    w.spawn(&body("arm", BodyType::Dynamic, to(up, [1.0, 5.0, 0.0]), Shape::Box { half: [1.0, 0.1, 0.1] })).expect("arm");
    let mut pivot = joint("pivot", "arm", None, JointType::Hinge);
    pivot.axis = Some(to(up, [0.0, 0.0, 1.0]));
    pivot.anchor_a = to(up, [-1.0, 0.0, 0.0]);
    pivot.anchor_b = to(up, [0.0, 5.0, 0.0]);
    pivot.motor = Some(Motor { target_pos: Some(0.3), stiffness: Some(50.0), damping: Some(2.0), ..Motor::default() });
    w.add_joint(&pivot).expect("pivot");
    w.spawn(&body("block", BodyType::Dynamic, to(up, [4.0, 5.0, 2.0]), cube(0.3))).expect("block");
    let mut rail = joint("rail", "block", None, JointType::Slider);
    rail.axis = Some(to(up, [0.0, 1.0, 0.0]));
    rail.anchor_b = to(up, [4.0, 5.0, 2.0]);
    rail.limits = Some([-2.0, 0.0]);
    w.add_joint(&rail).expect("rail");
    run(&mut w, 90);
    w
}

#[test]
fn a_z_up_joint_scene_is_its_y_up_turn_bit_for_bit_ignoring_the_sign_of_zero() {
    let magnitudes = |w: &World, key: &str| -> Vec<u32> {
        let b = w.body(key).expect("there");
        let values: Vec<f64> = b.pose.p.iter().chain(&b.pose.q).chain(&b.linvel).chain(&b.angvel).copied().collect();
        values.into_iter().map(|v| (v as f32).to_bits() & 0x7fff_ffff).collect()
    };
    let (y, z) = (turned_joints(UpAxis::Y), turned_joints(UpAxis::Z));
    for key in ["arm", "block"] {
        let mut turned = magnitudes(&z, key);
        for base in [0, 3, 7, 10] {
            turned.swap(base + 1, base + 2);
        }
        assert_eq!(magnitudes(&y, key), turned, "{key}");
    }
    // Without its motor the arm would hang at −90° (q.z ≈ −0.71); the position motor holds it near level.
    let y_arm = y.body("arm").expect("arm").pose.q;
    assert!(y_arm[2] > -0.2, "the motor holds the arm up: {y_arm:?}");
}

#[test]
fn joints_are_deterministic_run_to_run() {
    let hashes = || -> Vec<u64> {
        let mut w = turned_joints(UpAxis::Z);
        (0..30)
            .map(|_| {
                w.step().expect("steps");
                w.state_hash()
            })
            .collect()
    };
    assert_eq!(hashes(), hashes());
}
