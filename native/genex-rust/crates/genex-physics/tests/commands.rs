//! The body commands of §7: impulse, setVelocity, setPose, setNextKinematicPose (§7.2), areaPush,
//! wake and sleep; every refusal changes nothing (stateHash included); escaped bodies (§8.2).

mod common;

use common::{ball, body, cube, observe};
use genex_physics::{
    BodyDesc, BodyFilter, ColliderDesc, BodyType, Groups, Motor, PhysicsError, PhysicsFailure, Pose, SetPoseOptions, Shape, UpAxis, Vec3, World,
    WorldDesc,
};

const ZERO_G_Y: [f64; 3] = [0.0, 0.0, 0.0];

/// A 60 Hz world without gravity.
fn still_world(up: UpAxis, substeps: f64) -> World {
    World::create(&WorldDesc::new(1.0 / 60.0, substeps, ZERO_G_Y, up, 1.0)).expect("valid")
}

fn bits(v: Vec3) -> [u32; 3] {
    v.map(|c| (c as f32).to_bits())
}

fn qbits(q: [f64; 4]) -> [u32; 4] {
    q.map(|c| (c as f32).to_bits())
}

/// A world with one dynamic ball "ball", one fixed box "wall" and one kinematic box "lift".
fn three_bodies(up: UpAxis) -> World {
    let mut w = still_world(up, 1.0);
    w.spawn(&body("ball", BodyType::Dynamic, [0.0, 0.0, 0.0], ball(0.5))).expect("ball");
    w.spawn(&body("wall", BodyType::Fixed, [10.0, 0.0, 0.0], cube(0.5))).expect("wall");
    w.spawn(&body("lift", BodyType::Kinematic, [-10.0, 0.0, 0.0], cube(0.5))).expect("lift");
    w
}

fn ball_mass() -> f64 {
    4.0 / 3.0 * std::f64::consts::PI * 0.125
}

#[test]
fn impulse_changes_velocity_at_once_and_at_a_point_adds_spin() {
    for up in [UpAxis::Y, UpAxis::Z] {
        let mut w = three_bodies(up);
        w.impulse("ball", [2.0, 0.0, 0.0], None).expect("impulse");
        let state = w.body("ball").expect("there");
        assert!((state.linvel[0] * ball_mass() - 2.0).abs() < 1e-5, "{up:?}: {:?}", state.linvel);
        assert_eq!(state.angvel, [0.0; 3]);
        w.impulse("ball", [0.0, 1.0, 0.0], Some([0.5, 0.0, 0.0])).expect("impulse at a point");
        let spin = w.body("ball").expect("there").angvel;
        assert!(spin[2] > 0.0 && spin[0] == 0.0 && spin[1] == 0.0, "{up:?}: r x j is +z, got {spin:?}");
    }
}

#[test]
fn impulse_and_set_velocity_wake_a_sleeping_body() {
    let mut w = three_bodies(UpAxis::Y);
    w.sleep("ball").expect("sleeps");
    assert!(w.body("ball").expect("there").sleeping);
    w.impulse("ball", [1.0, 0.0, 0.0], None).expect("impulse");
    assert!(!w.body("ball").expect("there").sleeping);
    w.sleep("ball").expect("sleeps");
    w.set_velocity("ball", None, None).expect("no velocities still wakes");
    assert!(!w.body("ball").expect("there").sleeping);
}

#[test]
fn set_velocity_reads_back_bit_for_bit_in_either_frame() {
    for up in [UpAxis::Y, UpAxis::Z] {
        let mut w = three_bodies(up);
        let (v, omega) = ([1.5, -2.25, 3.0e-3], [-0.0, 0.75, -12.5]);
        w.set_velocity("ball", Some(v), Some(omega)).expect("sets");
        let state = w.body("ball").expect("there");
        assert_eq!(bits(state.linvel), bits(v), "{up:?}");
        assert_eq!(bits(state.angvel).map(|b| b & 0x7fff_ffff), bits(omega).map(|b| b & 0x7fff_ffff), "{up:?}");
        w.set_velocity("ball", Some([0.0, 4.0, 0.0]), None).expect("linear only");
        assert_eq!(w.body("ball").expect("there").angvel, state.angvel, "angvel kept");
    }
}

#[test]
fn set_pose_teleports_dynamic_and_fixed_bodies_with_its_options() {
    for up in [UpAxis::Y, UpAxis::Z] {
        let mut w = three_bodies(up);
        let pose = Pose { p: [3.0, -4.5, 6.25], q: [0.0, 0.6, 0.0, 0.8] };
        w.set_velocity("ball", Some([1.0, 0.0, 0.0]), None).expect("moving");
        w.set_pose("ball", pose, SetPoseOptions::default()).expect("teleports");
        let state = w.body("ball").expect("there");
        assert_eq!((bits(state.pose.p), qbits(state.pose.q)), (bits(pose.p), qbits(pose.q)), "{up:?}");
        assert_eq!(state.linvel, [1.0, 0.0, 0.0], "velocity kept by default");
        assert!(!state.sleeping);
        let respawn = SetPoseOptions { reset_velocity: true, wake: true };
        w.set_pose("ball", Pose::at([0.0; 3]), respawn).expect("respawn");
        assert_eq!(w.body("ball").expect("there").linvel, [0.0; 3]);
        w.sleep("ball").expect("sleeps");
        let quiet = SetPoseOptions { reset_velocity: false, wake: false };
        w.set_pose("ball", Pose::at([1.0, 1.0, 1.0]), quiet).expect("teleports asleep");
        assert!(w.body("ball").expect("there").sleeping, "wake: false keeps it asleep");
        w.set_pose("wall", Pose::at([20.0, 1.0, 2.0]), SetPoseOptions::default()).expect("fixed teleports");
        assert_eq!(w.body("wall").expect("there").pose.p, [20.0, 1.0, 2.0]);
    }
}

#[test]
fn wake_and_sleep_force_the_sleep_state() {
    let mut w = World::create(&WorldDesc::new(1.0 / 60.0, 1.0, [0.0, -9.81, 0.0], UpAxis::Y, 1.0)).expect("valid");
    w.spawn(&body("ball", BodyType::Dynamic, [0.0, 10.0, 0.0], ball(0.5))).expect("ball");
    w.step().expect("steps");
    w.sleep("ball").expect("sleeps");
    let asleep = w.body("ball").expect("there");
    assert!(asleep.sleeping);
    assert_eq!(asleep.linvel, [0.0; 3]);
    for _ in 0..5 {
        w.step().expect("steps");
    }
    assert_eq!(w.body("ball").expect("there").pose, asleep.pose, "a sleeping body does not fall");
    w.wake("ball").expect("wakes");
    assert!(!w.body("ball").expect("there").sleeping);
    w.step().expect("steps");
    assert!(w.body("ball").expect("there").pose.p[1] < asleep.pose.p[1], "it falls again");
}

#[test]
fn a_kinematic_body_reaches_its_target_exactly_then_keeps_it_with_velocity_zero() {
    for up in [UpAxis::Y, UpAxis::Z] {
        let mut w = still_world(up, 4.0);
        w.spawn(&body("lift", BodyType::Kinematic, [0.0, 0.0, 0.0], cube(0.5))).expect("lift");
        let half = std::f64::consts::FRAC_1_SQRT_2;
        // +90° about the first axis written as its negated quaternion: the shorter arc still turns +90°.
        let target = Pose { p: [1.0, 2.0, -3.0], q: [-half, 0.0, 0.0, -half] };
        // A fixed marker at the target holds the target as the core renormalised it.
        w.spawn(&BodyDesc::new("marker", BodyType::Fixed, target, vec![ColliderDesc::new("c", ball(0.01))]))
            .expect("marker");
        let target = w.body("marker").expect("there").pose;
        w.set_next_kinematic_pose("lift", target).expect("target");
        assert_eq!(w.body("lift").expect("there").pose.p, [0.0; 3], "nothing moves before the step");
        w.step().expect("steps");
        let moved = w.body("lift").expect("there");
        assert_eq!((bits(moved.pose.p), qbits(moved.pose.q)), (bits(target.p), qbits(target.q)), "{up:?}");
        let speed = moved.linvel;
        assert!((speed[0] - 60.0).abs() < 1e-3 && (speed[1] - 120.0).abs() < 1e-3, "{up:?}: {speed:?}");
        // nlerp is not uniform in angle: the last sub-step turns near, not exactly, the mean rate.
        let mean_rate = std::f64::consts::FRAC_PI_2 * 60.0;
        assert!((moved.angvel[0] / mean_rate - 1.0).abs() < 0.1, "{up:?}: {:?}", moved.angvel);
        w.step().expect("steps");
        let resting = w.body("lift").expect("there");
        assert_eq!(resting.pose, moved.pose, "{up:?}: keeps its last pose");
        assert_eq!((resting.linvel, resting.angvel), ([0.0; 3], [0.0; 3]), "{up:?}: velocity zero");
    }
}

#[test]
fn a_kinematic_platform_carries_a_resting_box_along() {
    let mut w = World::create(&WorldDesc::new(1.0 / 60.0, 2.0, [0.0, -9.81, 0.0], UpAxis::Y, 1.0)).expect("valid");
    let slab = Shape::Box { half: [2.0, 0.25, 2.0] };
    w.spawn(&body("lift", BodyType::Kinematic, [0.0, 0.0, 0.0], slab)).expect("lift");
    w.spawn(&body("crate", BodyType::Dynamic, [0.0, 0.75, 0.0], cube(0.25))).expect("crate");
    for _ in 0..30 {
        w.step().expect("settles");
    }
    for tick in 1..=60 {
        let p = [0.0, f64::from(tick) * 0.02, 0.0];
        w.set_next_kinematic_pose("lift", Pose::at(p)).expect("target");
        w.step().expect("steps");
    }
    let crate_y = w.body("crate").expect("there").pose.p[1];
    assert!((crate_y - (1.2 + 0.5)).abs() < 0.05, "the crate rode up with the lift: {crate_y}");
}

#[test]
fn area_push_pushes_dynamic_bodies_in_its_radius_by_its_falloff() {
    for up in [UpAxis::Y, UpAxis::Z] {
        let mut w = still_world(up, 1.0);
        let spots: [(&str, Vec3, BodyType); 6] = [
            ("near", [1.0, 0.0, 0.0], BodyType::Dynamic),
            ("mid", [0.0, 0.0, -2.0], BodyType::Dynamic),
            ("far", [5.0, 0.0, 0.0], BodyType::Dynamic),
            ("centre", [0.0, 0.0, 0.0], BodyType::Dynamic),
            ("post", [0.0, 1.0, 0.0], BodyType::Fixed),
            ("lift", [0.0, -1.0, 0.0], BodyType::Kinematic),
        ];
        for (key, p, body_type) in spots {
            w.spawn(&body(key, body_type, p, ball(0.5))).expect("spawns");
        }
        w.sleep("mid").expect("sleeps");
        w.area_push([0.0; 3], 4.0, 10.0, 1.0, None).expect("pushes");
        let v = |key: &str| w.body(key).expect("there").linvel;
        let expected_near = 10.0 * (1.0 - 1.0 / 4.0) / ball_mass();
        assert!((v("near")[0] - expected_near).abs() < 1e-4, "{up:?}: {:?}", v("near"));
        let expected_mid = 10.0 * (1.0 - 2.0 / 4.0) / ball_mass();
        assert!((v("mid")[2] + expected_mid).abs() < 1e-4, "{up:?}: {:?}", v("mid"));
        assert!(!w.body("mid").expect("there").sleeping, "a pushed body wakes");
        for still in ["far", "centre", "post", "lift"] {
            assert_eq!(v(still), [0.0; 3], "{up:?}: {still}");
        }
    }
}

#[test]
fn area_push_falloff_zero_is_flat_and_groups_filter_bodies() {
    let mut w = still_world(UpAxis::Y, 1.0);
    let mut tagged = body("tagged", BodyType::Dynamic, [2.0, 0.0, 0.0], ball(0.5));
    tagged.colliders[0].groups = Some(Groups { member: 2.0, collides: 0xFFFF as f64 });
    w.spawn(&tagged).expect("tagged");
    let mut plain = body("plain", BodyType::Dynamic, [-2.0, 0.0, 0.0], ball(0.5));
    plain.colliders[0].groups = Some(Groups { member: 1.0, collides: 0xFFFF as f64 });
    w.spawn(&plain).expect("plain");
    w.area_push([0.0; 3], 4.0, 3.0, 0.0, Some(Groups { member: 0xFFFF as f64, collides: 2.0 })).expect("pushes");
    let tagged_v = w.body("tagged").expect("there").linvel[0];
    assert!((tagged_v - 3.0 / ball_mass()).abs() < 1e-4, "falloff 0 gives the full strength: {tagged_v}");
    let plain_v = w.body("plain").expect("there").linvel;
    assert_eq!(plain_v[0], 0.0, "plain is in group 1, not 2");
}

/// Each row: a description, the call, the code it must give.
type Row = (&'static str, fn(&mut World) -> Result<(), PhysicsFailure>, PhysicsError);

const NAN: f64 = f64::NAN;

fn hostile_rows() -> Vec<Row> {
    vec![
        ("impulse malformed key", |w| w.impulse("a b", [1.0; 3], None), PhysicsError::InvalidKey),
        ("impulse refused name", |w| w.impulse("__proto__", [1.0; 3], None), PhysicsError::InvalidKey),
        ("impulse unknown", |w| w.impulse("ghost", [1.0; 3], None), PhysicsError::UnknownKey),
        ("impulse static key", |w| w.impulse("static:box:0000", [1.0; 3], None), PhysicsError::UnknownKey),
        ("impulse NaN", |w| w.impulse("ball", [NAN, 0.0, 0.0], None), PhysicsError::NonFinite),
        ("impulse 1e39", |w| w.impulse("ball", [1e39, 0.0, 0.0], None), PhysicsError::NonFinite),
        ("impulse at NaN", |w| w.impulse("ball", [1.0; 3], Some([0.0, NAN, 0.0])), PhysicsError::NonFinite),
        ("impulse fixed", |w| w.impulse("wall", [1.0; 3], None), PhysicsError::WrongBodyType),
        ("impulse kinematic", |w| w.impulse("lift", [1.0; 3], None), PhysicsError::WrongBodyType),
        ("setVelocity malformed", |w| w.set_velocity("", None, None), PhysicsError::InvalidKey),
        ("setVelocity unknown", |w| w.set_velocity("ghost", None, None), PhysicsError::UnknownKey),
        ("setVelocity past maxSpeed", |w| w.set_velocity("ball", Some([1_000.5, 0.0, 0.0]), None), PhysicsError::OutOfRange),
        ("setVelocity diagonal past maxSpeed", |w| w.set_velocity("ball", Some([800.0, 800.0, 0.0]), None), PhysicsError::OutOfRange),
        ("setVelocity past maxAngularSpeed", |w| w.set_velocity("ball", None, Some([0.0, 0.0, -1_001.0])), PhysicsError::OutOfRange),
        ("setVelocity NaN", |w| w.set_velocity("ball", None, Some([NAN, 0.0, 0.0])), PhysicsError::NonFinite),
        ("setVelocity fixed", |w| w.set_velocity("wall", Some([1.0; 3]), None), PhysicsError::WrongBodyType),
        ("setVelocity kinematic", |w| w.set_velocity("lift", Some([1.0; 3]), None), PhysicsError::WrongBodyType),
        ("setPose malformed", |w| w.set_pose("x".repeat(65).as_str(), Pose::at([0.0; 3]), unit_options()), PhysicsError::InvalidKey),
        ("setPose unknown", |w| w.set_pose("ghost", Pose::at([0.0; 3]), unit_options()), PhysicsError::UnknownKey),
        ("setPose past worldExtent", |w| w.set_pose("ball", Pose::at([0.0, -100_001.0, 0.0]), unit_options()), PhysicsError::OutOfRange),
        ("setPose q not unit", |w| w.set_pose("ball", Pose { p: [0.0; 3], q: [0.0, 0.0, 0.0, 0.9] }, unit_options()), PhysicsError::OutOfRange),
        ("setPose p NaN", |w| w.set_pose("ball", Pose::at([NAN, 0.0, 0.0]), unit_options()), PhysicsError::NonFinite),
        ("setPose kinematic", |w| w.set_pose("lift", Pose::at([0.0; 3]), unit_options()), PhysicsError::WrongBodyType),
        ("target malformed", |w| w.set_next_kinematic_pose("a/b", Pose::at([0.0; 3])), PhysicsError::InvalidKey),
        ("target unknown", |w| w.set_next_kinematic_pose("ghost", Pose::at([0.0; 3])), PhysicsError::UnknownKey),
        ("target past worldExtent", |w| w.set_next_kinematic_pose("lift", Pose::at([1e6, 0.0, 0.0])), PhysicsError::OutOfRange),
        ("target q inf", |w| w.set_next_kinematic_pose("lift", Pose { p: [0.0; 3], q: [0.0, 0.0, 0.0, f64::INFINITY] }), PhysicsError::NonFinite),
        ("target dynamic", |w| w.set_next_kinematic_pose("ball", Pose::at([0.0; 3])), PhysicsError::WrongBodyType),
        ("target fixed", |w| w.set_next_kinematic_pose("wall", Pose::at([0.0; 3])), PhysicsError::WrongBodyType),
        ("areaPush radius 0", |w| w.area_push([0.0; 3], 0.0, 1.0, 1.0, None), PhysicsError::OutOfRange),
        ("areaPush radius negative", |w| w.area_push([0.0; 3], -1.0, 1.0, 1.0, None), PhysicsError::OutOfRange),
        ("areaPush falloff negative", |w| w.area_push([0.0; 3], 1.0, 1.0, -0.5, None), PhysicsError::OutOfRange),
        ("areaPush strength NaN", |w| w.area_push([0.0; 3], 1.0, NAN, 1.0, None), PhysicsError::NonFinite),
        ("areaPush centre 1e39", |w| w.area_push([0.0, 0.0, -1e39], 1.0, 1.0, 1.0, None), PhysicsError::NonFinite),
        ("areaPush group 1.5", |w| w.area_push([0.0; 3], 1.0, 1.0, 1.0, Some(Groups { member: 1.5, collides: 1.0 })), PhysicsError::OutOfRange),
        ("areaPush group past 16 bits", |w| w.area_push([0.0; 3], 1.0, 1.0, 1.0, Some(Groups { member: 1.0, collides: 65_536.0 })), PhysicsError::OutOfRange),
        ("wake malformed", |w| w.wake("constructor"), PhysicsError::InvalidKey),
        ("wake unknown", |w| w.wake("ghost"), PhysicsError::UnknownKey),
        ("sleep malformed", |w| w.sleep("ü"), PhysicsError::InvalidKey),
        ("sleep unknown", |w| w.sleep("ghost"), PhysicsError::UnknownKey),
        ("remove unknown", |w| w.remove("ghost"), PhysicsError::UnknownKey),
        ("removeJoint unknown", |w| w.remove_joint("ghost"), PhysicsError::UnknownKey),
        ("removeJoint malformed", |w| w.remove_joint("prototype"), PhysicsError::InvalidKey),
        ("setMotor unknown", |w| w.set_motor("ghost", Motor::default()), PhysicsError::UnknownKey),
        ("setMotor malformed", |w| w.set_motor("", Motor::default()), PhysicsError::InvalidKey),
    ]
}

fn unit_options() -> SetPoseOptions {
    SetPoseOptions::default()
}

#[test]
fn hostile_commands_are_refused_with_their_code_and_change_nothing() {
    for up in [UpAxis::Y, UpAxis::Z] {
        let mut w = three_bodies(up);
        w.set_velocity("ball", Some([0.5, 0.0, 0.0]), None).expect("moving");
        w.step().expect("steps");
        let before = observe(&w);
        for (name, call, expected) in hostile_rows() {
            assert_eq!(call(&mut w).err().map(|f| f.code), Some(expected), "{name} in {up:?}");
            assert_eq!(observe(&w), before, "{name} changed the world");
        }
        let after = w.step().expect("steps");
        assert!(after.escaped.is_empty());
    }
}

#[test]
fn a_command_marks_its_body_changed_at_once() {
    let mut w = three_bodies(UpAxis::Y);
    w.step().expect("steps");
    let changed = |w: &World| -> Vec<String> {
        let filter = BodyFilter { changed_since_tick: Some(w.tick()), ..BodyFilter::default() };
        w.bodies(&filter).into_iter().map(|b| b.key).collect()
    };
    assert!(changed(&w).is_empty());
    w.set_pose("wall", Pose::at([10.0, 1.0, 0.0]), SetPoseOptions::default()).expect("moves");
    assert_eq!(changed(&w), ["wall"]);
    w.set_pose("ball", Pose::at([0.0; 3]), SetPoseOptions { reset_velocity: false, wake: false }).expect("same pose");
    assert_eq!(changed(&w), ["wall"], "a setPose that moves no bit changes nothing");
}

/// A world whose extent is 50 with a ball "runner" heading out of it.
fn runaway() -> World {
    let mut desc = WorldDesc::new(1.0 / 60.0, 1.0, ZERO_G_Y, UpAxis::Y, 1.0);
    desc.limits.world_extent = Some(50.0);
    let mut w = World::create(&desc).expect("valid");
    let mut runner = body("runner", BodyType::Dynamic, [49.5, 0.0, 0.0], ball(0.5));
    runner.linvel = Some([60.0, 0.0, 0.0]);
    w.spawn(&runner).expect("runner");
    w
}

#[test]
fn an_escaped_body_ignores_pushes_until_set_pose_puts_it_back() {
    let mut w = runaway();
    assert_eq!(w.step().expect("steps").escaped, ["runner"]);
    let frozen = observe(&w);
    w.impulse("runner", [5.0, 0.0, 0.0], None).expect("accepted");
    w.set_velocity("runner", Some([1.0, 0.0, 0.0]), None).expect("accepted");
    w.wake("runner").expect("accepted");
    w.area_push([50.0, 0.0, 0.0], 10.0, 100.0, 0.0, None).expect("accepted");
    assert_eq!(observe(&w), frozen, "a frozen body stays frozen");
    w.set_pose("runner", Pose::at([0.0; 3]), SetPoseOptions::default()).expect("back inside");
    w.set_velocity("runner", Some([6.0, 0.0, 0.0]), None).expect("simulated again");
    let result = w.step().expect("steps");
    assert!(result.escaped.is_empty());
    let state = w.body("runner").expect("there");
    assert!((state.pose.p[0] - 0.1).abs() < 1e-6 && !state.sleeping, "{state:?}");
}

#[test]
fn a_set_pose_with_wake_false_returns_an_escaped_body_asleep() {
    let mut w = runaway();
    w.step().expect("escapes");
    w.set_pose("runner", Pose::at([1.0, 2.0, 3.0]), SetPoseOptions { reset_velocity: false, wake: false }).expect("back");
    let state = w.body("runner").expect("there");
    assert_eq!((state.pose.p, state.linvel, state.sleeping), ([1.0, 2.0, 3.0], [0.0; 3], true));
}

#[test]
fn a_body_gone_non_finite_returns_to_its_start_of_step_pose_frozen_and_listed_once() {
    let mut w = still_world(UpAxis::Z, 1.0);
    w.spawn(&body("rocket", BodyType::Dynamic, [1.0, 2.0, 3.0], ball(0.5))).expect("rocket");
    w.spawn(&body("bystander", BodyType::Dynamic, [9.0, 0.0, 0.0], ball(0.5))).expect("bystander");
    w.step().expect("steps");
    w.impulse("rocket", [3.0e38, 0.0, 0.0], None).expect("a finite impulse");
    let result = w.step().expect("steps");
    assert_eq!(result.escaped, ["rocket"]);
    let state = w.body("rocket").expect("there");
    assert_eq!((state.pose.p, state.linvel, state.angvel, state.sleeping), ([1.0, 2.0, 3.0], [0.0; 3], [0.0; 3], true));
    assert!(w.step().expect("steps").escaped.is_empty(), "listed once");
    assert_eq!(w.body("bystander").expect("there").pose.p, [9.0, 0.0, 0.0]);
}

/// The scene of `turned_scene_matches`, in either frame (`to` maps a y-up vector to the frame).
fn turned_scene(up: UpAxis) -> World {
    let to = |v: Vec3| -> Vec3 {
        match up {
            UpAxis::Y => v,
            UpAxis::Z => [v[0], -v[2], v[1]],
        }
    };
    let mut w = World::create(&WorldDesc::new(1.0 / 30.0, 2.0, to([0.0, -9.81, 0.0]), up, 1.0)).expect("valid");
    w.spawn(&body("floor", BodyType::Fixed, to([0.0, -0.5, 0.0]), cube(20.0))).expect("floor");
    for i in 0..4 {
        let p = to([f64::from(i) * 1.5 - 2.0, 20.0 + f64::from(i), 0.5]);
        w.spawn(&body(&format!("crate.{i}"), BodyType::Dynamic, p, cube(0.5))).expect("crate");
    }
    w.spawn(&body("lift", BodyType::Kinematic, to([0.0, 20.0, 4.0]), cube(1.0))).expect("lift");
    for tick in 0..40 {
        if tick == 3 {
            w.impulse("crate.1", to([3.0, 0.0, 1.0]), Some(to([-1.0, 21.5, 0.5]))).expect("impulse");
            w.area_push(to([0.0, 20.0, 0.0]), 6.0, 4.0, 1.5, None).expect("push");
        }
        let angle = f64::from(tick) * 0.05;
        let (s, c) = (angle.sin(), angle.cos());
        let q = match up {
            UpAxis::Y => [0.0, s, 0.0, c],
            UpAxis::Z => [0.0, 0.0, s, c],
        };
        let p = to([f64::from(tick) * 0.1, 20.0, 4.0]);
        w.set_next_kinematic_pose("lift", Pose { p, q }).expect("target");
        w.step().expect("steps");
    }
    w
}

#[test]
fn turned_scene_matches_bit_for_bit_ignoring_the_sign_of_zero() {
    let strip = |w: &World| -> Vec<(String, [u32; 13])> {
        w.bodies(&BodyFilter::default())
            .into_iter()
            .map(|b| {
                let mut out = [0u32; 13];
                let values = b.pose.p.iter().chain(&b.pose.q).chain(&b.linvel).chain(&b.angvel);
                for (slot, v) in out.iter_mut().zip(values) {
                    *slot = (*v as f32).to_bits() & 0x7fff_ffff;
                }
                (b.key, out)
            })
            .collect()
    };
    let y = turned_scene(UpAxis::Y);
    let z = turned_scene(UpAxis::Z);
    let turn = |v: [u32; 13]| -> [u32; 13] {
        // (x, y, z) z-up is (x, z, −y) y-up: compare magnitudes with y and z swapped.
        let mut out = v;
        for base in [0, 3, 7, 10] {
            out.swap(base + 1, base + 2);
        }
        out
    };
    let ys = strip(&y);
    let zs: Vec<_> = strip(&z).into_iter().map(|(k, v)| (k, turn(v))).collect();
    assert_eq!(ys, zs);
}

#[test]
fn the_same_commands_twice_give_the_same_state_hash_every_step() {
    let run = || -> Vec<u64> {
        let mut w = turned_scene(UpAxis::Z);
        let mut hashes = Vec::new();
        for tick in 0..30 {
            if tick % 7 == 0 {
                w.area_push([0.0, 0.0, 20.0], 8.0, 2.0, 1.0, None).expect("push");
            }
            w.step().expect("steps");
            hashes.push(w.state_hash());
        }
        hashes
    };
    assert_eq!(run(), run());
}
