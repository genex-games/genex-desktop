//! addStaticWorld (§6.5): §17.7's validation exactly, upAxis z only, once per world, a fixed body
//! per piece under its static: key, ramps as 8-point (or 6-point) hulls, limits.staticPieces,
//! memory, and physicsHash's static section (§10.2).

mod common;

use common::{ball, body, observe, world};
use genex_physics::{
    BodyFilter, BodyType, JointDesc, JointType, PhysicsError, PhysicsFailure, Pose, SetPoseOptions, StaticWorld, UpAxis, World,
    WorldDesc,
};

fn small() -> StaticWorld {
    StaticWorld {
        boxes: vec![vec![-10.0, -10.0, -1.0, 10.0, 10.0, 0.0], vec![20.0, -2.0, 0.0, 22.0, 2.0, 3.0]],
        ramps: vec![
            // Rising along x from 0 at x = 30 to 2 at x = 50: its low end lies on the floor (6 points).
            vec![30.0, -5.0, 0.0, 50.0, 5.0, 2.0, 0.0, 0.0, 2.0],
            // Rising along y from 1 at y = 30 to 3 at y = 50 over a floor at 0 (8 points).
            vec![-5.0, 30.0, 0.0, 5.0, 50.0, 3.0, 1.0, 1.0, 3.0],
        ],
    }
}

/// Where a ball of radius 0.25 dropped at (x, y) from height 6 is after `steps`, along z.
fn drop_height(x: f64, y: f64, steps: usize) -> f64 {
    let mut w = world(UpAxis::Z);
    w.add_static_world(&small()).expect("imports");
    w.spawn(&body("ball", BodyType::Dynamic, [x, y, 6.0], ball(0.25))).expect("ball");
    for _ in 0..steps {
        w.step().expect("steps");
    }
    w.body("ball").expect("there").pose.p[2]
}

#[test]
fn balls_land_on_boxes_and_on_each_ramp_at_its_height() {
    assert!((drop_height(0.0, 0.0, 120) - 0.25).abs() < 0.01, "on the floor box");
    assert!((drop_height(21.0, 0.0, 120) - 3.25).abs() < 0.01, "on the tall box");
    // Three quarters up each ramp (a mirrored ramp would be a quarter up): the x ramp is at 1.5
    // there, the y ramp at 2.5. The slope is 1 in 10, so the ball's centre sits about r / cos θ
    // above it, and it rolls only a little in the time it takes to land.
    let on_x_ramp = drop_height(45.0, 0.0, 70);
    assert!((on_x_ramp - 1.75).abs() < 0.1, "on the x ramp: {on_x_ramp}");
    let on_y_ramp = drop_height(0.0, 45.0, 70);
    assert!((on_y_ramp - 2.75).abs() < 0.1, "on the y ramp: {on_y_ramp}");
}

#[test]
fn static_pieces_stay_out_of_bodies_the_state_hash_and_every_command() {
    let mut w = world(UpAxis::Z);
    w.spawn(&body("ball", BodyType::Dynamic, [0.0, 0.0, 9.0], ball(0.5))).expect("ball");
    let before = (w.bodies(&BodyFilter::default()), w.state_hash());
    w.add_static_world(&small()).expect("imports");
    assert_eq!((w.bodies(&BodyFilter::default()), w.state_hash()), before);
    let pinned = observe(&w);
    let rows: [(&str, Result<(), PhysicsFailure>); 7] = [
        ("remove", w.remove("static:box:0000")),
        ("setPose", w.set_pose("static:box:0001", Pose::at([0.0; 3]), SetPoseOptions::default())),
        ("impulse", w.impulse("static:ramp:0000", [1.0; 3], None)),
        ("wake", w.wake("static:ramp:0001")),
        ("sleep", w.sleep("static:box:0000")),
        ("joint to a piece", w.add_joint(&JointDesc::new("j", "ball", Some("static:box:0000"), JointType::Ball, [0.0; 3], [0.0; 3]))),
        ("joint from a piece", w.add_joint(&JointDesc::new("j", "static:box:0000", None, JointType::Ball, [0.0; 3], [0.0; 3]))),
    ];
    for (name, result) in rows {
        assert_eq!(result.err().map(|f| f.code), Some(PhysicsError::UnknownKey), "{name}");
    }
    assert_eq!(observe(&w), pinned);
    let named = body("static:box:0000", BodyType::Fixed, [0.0; 3], ball(1.0));
    assert_eq!(w.spawn(&named).err().map(|f| f.code), Some(PhysicsError::InvalidKey), "the prefix is reserved");
}

#[test]
fn the_static_world_is_once_per_world_and_z_up_only() {
    let mut w = world(UpAxis::Z);
    w.add_static_world(&small()).expect("imports");
    let (before, hash) = (observe(&w), w.physics_hash());
    let again = w.add_static_world(&StaticWorld::default()).err().map(|f| f.code);
    assert_eq!(again, Some(PhysicsError::DuplicateKey));
    assert_eq!((observe(&w), w.physics_hash()), (before, hash));
    let mut y_up = world(UpAxis::Y);
    let before = (observe(&y_up), y_up.physics_hash());
    assert_eq!(y_up.add_static_world(&small()).err().map(|f| f.code), Some(PhysicsError::OutOfRange));
    assert_eq!((observe(&y_up), y_up.physics_hash()), before);
}

#[test]
fn physics_hash_covers_the_static_world_as_given() {
    let mut w = world(UpAxis::Z);
    let empty = w.physics_hash();
    let given = StaticWorld {
        boxes: vec![vec![-1.0, -0.0, 0.0, 1.0, 1.0, 0.5]],
        ramps: vec![vec![0.0, 0.0, 0.0, 4.0, 1.0, 1.5, 1.0, 1.5, 0.0]],
    };
    w.add_static_world(&given).expect("imports");
    let text = w.physics_json();
    let expected = r#""static":{"boxes":[[-1,0,0,1,1,0.5]],"ramps":[[0,0,0,4,1,1.5,1,1.5,0]]}"#;
    assert!(text.contains(expected), "{text}");
    assert_ne!(w.physics_hash(), empty);
}

/// A valid world with one value of one entry replaced.
fn with_box(values: Vec<f64>) -> StaticWorld {
    StaticWorld { boxes: vec![vec![0.0, 0.0, 0.0, 1.0, 1.0, 1.0], values], ramps: vec![] }
}

fn with_ramp(values: Vec<f64>) -> StaticWorld {
    StaticWorld { boxes: vec![], ramps: vec![values] }
}

fn hostile_worlds() -> Vec<(&'static str, StaticWorld, PhysicsError)> {
    let unit_box = vec![0.0, 0.0, 0.0, 1.0, 1.0, 1.0];
    let ramp = |axis: f64, lo: f64, hi: f64, max_z: f64| vec![0.0, 0.0, 0.0, 4.0, 4.0, max_z, axis, lo, hi];
    vec![
        ("4097 boxes", StaticWorld { boxes: vec![unit_box.clone(); 4097], ramps: vec![] }, PhysicsError::OutOfRange),
        ("513 ramps", StaticWorld { boxes: vec![], ramps: vec![ramp(0.0, 0.0, 1.0, 1.0); 513] }, PhysicsError::OutOfRange),
        ("a box of five", with_box(vec![0.0, 0.0, 0.0, 1.0, 1.0]), PhysicsError::OutOfRange),
        ("a box of seven", with_box(vec![0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0]), PhysicsError::OutOfRange),
        ("a ramp of eight", with_ramp(vec![0.0, 0.0, 0.0, 4.0, 4.0, 1.0, 0.0, 1.0]), PhysicsError::OutOfRange),
        ("0.1 is not a float32", with_box(vec![0.1, 0.0, 0.0, 1.0, 1.0, 1.0]), PhysicsError::OutOfRange),
        ("above 1e9", with_box(vec![0.0, 0.0, 0.0, 2e9, 1.0, 1.0]), PhysicsError::OutOfRange),
        ("below -1e9", with_box(vec![-1_000_000_064.0, 0.0, 0.0, 1.0, 1.0, 1.0]), PhysicsError::OutOfRange),
        ("NaN", with_box(vec![0.0, f64::NAN, 0.0, 1.0, 1.0, 1.0]), PhysicsError::NonFinite),
        ("infinity", with_box(vec![0.0, 0.0, f64::NEG_INFINITY, 1.0, 1.0, 1.0]), PhysicsError::NonFinite),
        ("1e39", with_box(vec![0.0, 0.0, 0.0, 1e39, 1.0, 1.0]), PhysicsError::NonFinite),
        ("min = max", with_box(vec![0.0, 1.0, 0.0, 1.0, 1.0, 1.0]), PhysicsError::BadShape),
        ("min > max", with_box(vec![0.0, 0.0, 2.0, 1.0, 1.0, 1.0]), PhysicsError::BadShape),
        ("ramp axis 2", with_ramp(ramp(2.0, 0.0, 1.0, 1.0)), PhysicsError::OutOfRange),
        ("ramp axis 0.5", with_ramp(ramp(0.5, 0.0, 1.0, 1.0)), PhysicsError::OutOfRange),
        ("ramp lo below minZ", with_ramp(ramp(0.0, -1.0, 1.0, 1.0)), PhysicsError::BadShape),
        ("ramp hi below minZ", with_ramp(ramp(1.0, 1.0, -0.5, 1.0)), PhysicsError::BadShape),
        ("ramp maxZ above max(lo, hi)", with_ramp(ramp(0.0, 0.5, 1.0, 2.0)), PhysicsError::BadShape),
        ("ramp maxZ below max(lo, hi)", with_ramp(ramp(0.0, 0.5, 3.0, 2.0)), PhysicsError::BadShape),
        ("ramp with min > max", with_ramp(vec![4.0, 0.0, 0.0, 0.0, 4.0, 1.0, 0.0, 0.0, 1.0]), PhysicsError::BadShape),
    ]
}

#[test]
fn worlds_section_17_7_refuses_are_refused_with_their_code_and_change_nothing() {
    let mut w = world(UpAxis::Z);
    w.spawn(&body("ball", BodyType::Dynamic, [0.0, 0.0, 9.0], ball(0.5))).expect("ball");
    w.step().expect("steps");
    let before = (observe(&w), w.physics_hash());
    for (name, given, expected) in hostile_worlds() {
        assert_eq!(w.add_static_world(&given).err().map(|f| f.code), Some(expected), "{name}");
        assert_eq!((observe(&w), w.physics_hash()), before, "{name} changed the world");
    }
    w.add_static_world(&small()).expect("a refusal left the import unused");
}

#[test]
fn the_edges_section_17_7_accepts_are_accepted() {
    let edges = StaticWorld {
        boxes: vec![
            vec![-1e9, -0.0, -1_000_000_000.0, 1e9, 2f64.powi(-100), -999_999_936.0],
            vec![0.0, 0.0, 0.0, 1.401_298_464_324_817e-45 * 2.0, 1.0, 1.0],
        ],
        ramps: vec![vec![0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 0.0, 1.0, 1.0]],
    };
    let mut w = world(UpAxis::Z);
    w.add_static_world(&edges).expect("every value is a float32 within 1e9; a flat-topped ramp is a box");
    w.step().expect("steps");
}

#[test]
fn static_pieces_count_toward_static_pieces_and_memory_not_bodies() {
    let mut desc = WorldDesc::new(1.0 / 60.0, 1.0, [0.0, 0.0, -9.81], UpAxis::Z, 1.0);
    desc.limits.static_pieces = Some(3.0);
    desc.limits.bodies = Some(1.0);
    let mut w = World::create(&desc).expect("valid");
    let four = StaticWorld { boxes: small().boxes, ramps: small().ramps };
    let before = observe(&w);
    assert_eq!(w.add_static_world(&four).err().map(|f| f.code), Some(PhysicsError::LimitStatic));
    assert_eq!(observe(&w), before);
    let three = StaticWorld { boxes: small().boxes, ramps: vec![small().ramps[0].clone()] };
    w.add_static_world(&three).expect("three pieces fit");
    w.spawn(&body("ball", BodyType::Dynamic, [0.0, 0.0, 9.0], ball(0.5))).expect("static pieces are not bodies");

    let probe = world(UpAxis::Z);
    let mut tight = WorldDesc::new(1.0 / 60.0, 1.0, [0.0, 0.0, -9.81], UpAxis::Z, 1.0);
    tight.limits.memory_bytes = Some((probe.memory_bytes() + 2_000) as f64);
    let mut w = World::create(&tight).expect("valid");
    let before = observe(&w);
    assert_eq!(w.add_static_world(&small()).err().map(|f| f.code), Some(PhysicsError::LimitMemory));
    assert_eq!(observe(&w), before);
}

#[test]
fn the_full_section_17_7_world_of_4096_boxes_and_512_ramps_imports() {
    let boxes: Vec<Vec<f64>> = (0..4096)
        .map(|i| {
            let (x, y) = (f64::from(i % 64) * 4.0, f64::from(i / 64) * 4.0);
            vec![x, y, 0.0, x + 2.0, y + 2.0, 1.0 + f64::from(i % 3)]
        })
        .collect();
    let ramps: Vec<Vec<f64>> = (0..512)
        .map(|i| {
            let (x, y) = (f64::from(i % 32) * 8.0, 300.0 + f64::from(i / 32) * 8.0);
            let axis = f64::from(i % 2);
            let (lo, hi) = if i % 4 < 2 { (0.0, 2.0) } else { (1.0, 0.5) };
            vec![x, y, 0.0, x + 6.0, y + 6.0, f64::max(lo, hi), axis, lo, hi]
        })
        .collect();
    let mut w = world(UpAxis::Z);
    let empty = w.memory_bytes();
    w.add_static_world(&StaticWorld { boxes, ramps }).expect("the largest world §17.7 accepts");
    assert!(w.memory_bytes() > empty);
    w.spawn(&body("ball", BodyType::Dynamic, [1.0, 1.0, 9.0], ball(0.5))).expect("ball");
    for _ in 0..120 {
        w.step().expect("steps");
    }
    let z = w.body("ball").expect("there").pose.p[2];
    assert!((z - 1.5).abs() < 0.01, "rests on box 0: {z}");
}

/// Ramps §17.7 accepts at extreme aspect ratios: a key of the wedge or 8-point ramp each makes.
fn extreme_ramps() -> Vec<(&'static str, Vec<f64>)> {
    let subnormal = 1.401_298_464_324_817e-45;
    let ulp_above_one = 1.0 + 2f64.powi(-23);
    vec![
        ("2e9 wide, a subnormal tall", vec![-1e9, -1e9, 0.0, 1e9, 1e9, subnormal, 0.0, 0.0, subnormal]),
        ("one ulp tall", vec![0.0, 0.0, 1.0, 4.0, 2.0, ulp_above_one, 1.0, 1.0, ulp_above_one]),
        ("1e9 by 1e9, two units of rise", vec![0.0, 0.0, 0.0, 1e9, 1e9, 3.0, 0.0, 1.0, 3.0]),
        ("2^-100 wide, 2e9 of rise", vec![0.0, 0.0, -1e9, 2f64.powi(-100), 1.0, 1e9, 0.0, -1e9, 1e9]),
        ("1e9 long, 2^-100 across", vec![-1e9, 0.0, 0.0, 1e9, 2f64.powi(-100), 2.0, 0.0, 2.0, 1.0]),
    ]
}

#[test]
fn ramps_at_extreme_aspect_ratios_are_accepted_and_step() {
    for (name, ramp) in extreme_ramps() {
        let mut w = world(UpAxis::Z);
        w.add_static_world(&StaticWorld { boxes: vec![], ramps: vec![ramp] }).unwrap_or_else(|f| panic!("{name}: {f:?}"));
        w.spawn(&body("ball", BodyType::Dynamic, [1e3, 1e3, 10.0], ball(0.25))).expect("ball");
        for _ in 0..90 {
            w.step().unwrap_or_else(|f| panic!("{name}: {f:?}"));
        }
        w.check().unwrap_or_else(|f| panic!("{name}: {f:?}"));
    }
}

/// Contact on a hull is computed in f32 relative to the hull's own size, so a ramp a billion units
/// wide is accepted and steps, but a ball is held by it only where f32 resolves the ramp: this one
/// spans the default worldExtent (1e5), a ramp 20 units high over 2e5.
#[test]
fn a_ball_lands_on_a_ramp_as_wide_as_the_world() {
    let mut w = world(UpAxis::Z);
    let ramp = vec![-1e5, -1e5, 0.0, 1e5, 1e5, 21.0, 0.0, 1.0, 21.0];
    w.add_static_world(&StaticWorld { boxes: vec![], ramps: vec![ramp] }).expect("imports");
    w.spawn(&body("ball", BodyType::Dynamic, [0.0, 0.0, 14.0], ball(0.25))).expect("ball");
    for _ in 0..120 {
        w.step().expect("steps");
    }
    let z = w.body("ball").expect("there").pose.p[2];
    assert!(z > 10.0 && z < 11.5, "on the ramp's top near its middle (11): {z}");
}
