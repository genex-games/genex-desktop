//! Shared builders for the integration tests.
#![allow(dead_code)]

use genex_physics::{BodyDesc, BodyFilter, BodyType, ColliderDesc, Pose, Shape, UpAxis, Vec3, World, WorldDesc};

/// A 60 Hz world with gravity along the caller's up axis.
pub fn world(up: UpAxis) -> World {
    let gravity = match up {
        UpAxis::Y => [0.0, -9.81, 0.0],
        UpAxis::Z => [0.0, 0.0, -9.81],
    };
    World::create(&WorldDesc::new(1.0 / 60.0, 1.0, gravity, up, 1.0)).expect("a valid world")
}

/// A one-collider body of `shape`.
pub fn body(key: &str, body_type: BodyType, p: Vec3, shape: Shape) -> BodyDesc {
    BodyDesc::new(key, body_type, Pose::at(p), vec![ColliderDesc::new("c", shape)])
}

/// A unit-ish box.
pub fn cube(half: f64) -> Shape {
    Shape::Box { half: [half; 3] }
}

/// A sphere.
pub fn ball(radius: f64) -> Shape {
    Shape::Sphere { radius }
}

/// Everything a caller can observe about a world, to assert a refused call changed nothing.
pub fn observe(world: &World) -> (u64, u64, String, u64, usize) {
    let bodies = world.bodies(&BodyFilter::default());
    (world.tick(), world.state_hash(), format!("{bodies:?}"), world.memory_bytes(), bodies.len())
}

/// `v` given in y-up terms, in the frame `up` (§5's mapping back).
pub fn to(up: UpAxis, v: Vec3) -> Vec3 {
    match up {
        UpAxis::Y => v,
        UpAxis::Z => [v[0], -v[2], v[1]],
    }
}

/// An 8-point hull, a slightly skewed box.
pub fn hull(half: f64) -> Shape {
    let mut points = Vec::new();
    for i in 0..8 {
        let s = |bit: usize| if i & bit == 0 { -half } else { half };
        points.push([s(1) * 1.1, s(2), s(4) * 0.9]);
    }
    Shape::Hull { points }
}

/// The heap's `i`th body: boxes, balls, hulls and capsules on an 8×8 grid, layer over layer, every
/// fifth with contact events on.
pub fn heap_body(up: UpAxis, i: usize, spacing: f64) -> genex_physics::BodyDesc {
    let shape = match i % 4 {
        0 => cube(0.4),
        1 => ball(0.4),
        2 => hull(0.35),
        _ => Shape::Capsule { half_height: 0.25, radius: 0.3, axis: genex_physics::Axis::X },
    };
    let (x, z, layer) = ((i % 8) as f64, ((i / 8) % 8) as f64, (i / 64) as f64);
    let p = [(x - 3.5) * spacing + layer * 0.07, 1.0 + layer * spacing, (z - 3.5) * spacing - layer * 0.05];
    let mut desc = body(&format!("heap.{i:03}"), BodyType::Dynamic, to(up, p), shape);
    desc.colliders[0].events = i.is_multiple_of(5);
    desc.kind = Some(if i.is_multiple_of(2) { "crate".to_string() } else { "prop".to_string() });
    desc
}

/// A world that exercises most of the core in the frame `up`: a floor (the static world when
/// z-up, a fixed box otherwise), a heap of `n` mixed bodies, a motorised hinge door, a slider, a
/// rope, a kinematic lift, a fixed sensor and a CCD ball.
pub fn busy_world(up: UpAxis, n: usize) -> World {
    use genex_physics::{JointDesc, JointType, Motor, StaticWorld};
    let mut w = world(up);
    match up {
        UpAxis::Z => {
            let floor = StaticWorld {
                boxes: vec![vec![-30.0, -30.0, -1.0, 30.0, 30.0, 0.0]],
                ramps: vec![vec![10.0, -4.0, 0.0, 20.0, 4.0, 2.0, 0.0, 0.0, 2.0]],
            };
            w.add_static_world(&floor).expect("static world");
        }
        UpAxis::Y => {
            w.spawn(&body("floor", BodyType::Fixed, [0.0, -1.0, 0.0], Shape::Box { half: [30.0, 1.0, 30.0] })).expect("floor");
        }
    }
    for i in 0..n {
        w.spawn(&heap_body(up, i, 0.9)).expect("heap body");
    }
    let mut door = body("door", BodyType::Dynamic, to(up, [-10.0, 1.5, 0.0]), Shape::Box { half: to_half(up, [0.1, 1.0, 1.0]) });
    door.colliders[0].events = true;
    w.spawn(&door).expect("door");
    let mut hinge = JointDesc::new("j.door", "door", None, JointType::Hinge, to(up, [0.0, 0.0, -1.0]), to(up, [-10.0, 1.5, -1.0]));
    hinge.axis = Some(to(up, [0.0, 1.0, 0.0]));
    hinge.motor = Some(Motor { target_vel: Some(1.5), damping: Some(10.0), max_force: Some(500.0), ..Motor::default() });
    w.add_joint(&hinge).expect("hinge");
    w.spawn(&body("slide", BodyType::Dynamic, to(up, [-14.0, 3.0, 0.0]), cube(0.3))).expect("slide");
    let mut slider = JointDesc::new("j.slide", "slide", None, JointType::Slider, [0.0; 3], to(up, [-14.0, 3.0, 0.0]));
    slider.axis = Some(to(up, [0.0, 1.0, 0.0]));
    slider.limits = Some([-2.0, 0.5]);
    w.add_joint(&slider).expect("slider");
    w.spawn(&body("bob", BodyType::Dynamic, to(up, [-18.0, 4.0, 1.0]), ball(0.3))).expect("bob");
    let mut rope = JointDesc::new("j.rope", "bob", None, JointType::Rope, [0.0; 3], to(up, [-18.0, 6.0, 0.0]));
    rope.limits = Some([0.0, 2.5]);
    w.add_joint(&rope).expect("rope");
    w.spawn(&body("lift", BodyType::Kinematic, to(up, [6.0, 0.25, 6.0]), Shape::Box { half: to_half(up, [1.0, 0.25, 1.0]) })).expect("lift");
    w.spawn(&body("lift.crate", BodyType::Dynamic, to(up, [6.0, 1.0, 6.0]), cube(0.4))).expect("lift crate");
    let mut zone = body("zone", BodyType::Fixed, to(up, [0.0, 1.0, 0.0]), cube(2.0));
    zone.colliders[0].sensor = true;
    w.spawn(&zone).expect("zone");
    let mut bullet = body("bullet", BodyType::Dynamic, to(up, [-6.0, 1.0, -8.0]), ball(0.1));
    bullet.ccd = true;
    bullet.linvel = Some(to(up, [0.0, 0.0, 60.0]));
    bullet.colliders[0].events = true;
    w.spawn(&bullet).expect("bullet");
    w
}

/// Half-extents given along y-up axes, in the frame `up` (sizes are unsigned).
pub fn to_half(up: UpAxis, h: Vec3) -> Vec3 {
    match up {
        UpAxis::Y => h,
        UpAxis::Z => [h[0], h[2], h[1]],
    }
}

/// The busy scene's commands before the step that ends at tick `t + 1`: the lift's next pose (a
/// triangle wave up and down), a kick on one heap body every 15 ticks, and four queries.
pub fn drive(w: &mut World, up: UpAxis, t: u64) {
    let phase = (t % 120) as f64;
    let height = 0.25 + if phase < 60.0 { phase } else { 120.0 - phase } * 0.02;
    w.set_next_kinematic_pose("lift", Pose::at(to(up, [6.0, height, 6.0]))).expect("lift moves");
    if t.is_multiple_of(15) {
        let key = format!("heap.{:03}", (t / 15) % 8);
        let _ = w.impulse(&key, to(up, [0.5, 2.0, -0.3]), None);
    }
    let filter = genex_physics::QueryFilter::default();
    w.ray(to(up, [0.0, 10.0, 0.0]), to(up, [0.0, -1.0, 0.0]), 20.0, &filter).expect("ray");
    w.ray(to(up, [-20.0, 1.0, 0.3]), to(up, [1.0, 0.0, 0.0]), 40.0, &filter).expect("ray");
    w.shape_cast(&ball(0.3), Pose::at(to(up, [0.0, 8.0, 0.0])), to(up, [0.0, -1.0, 0.0]), 10.0, &filter).expect("cast");
    w.overlap(&cube(2.0), Pose::at(to(up, [0.0, 1.0, 0.0])), &filter).expect("overlap");
}

/// One step's observable outcome: the tick, stateHash, events, escaped bodies and memoryExceeded.
pub fn step_trace(w: &mut World) -> String {
    let result = w.step().expect("steps");
    format!("{} {:016x} {:?} {:?} {}", result.tick, w.state_hash(), result.events, result.escaped, result.memory_exceeded)
}

/// `steps` steps of the busy scene from the world's current tick, one trace per step.
pub fn run_busy(w: &mut World, up: UpAxis, steps: usize) -> Vec<String> {
    (0..steps)
        .map(|_| {
            drive(w, up, w.tick());
            step_trace(w)
        })
        .collect()
}

/// A y-up world whose memory limit is the model's empty world plus `headroom` bytes.
pub fn model_tight_world(headroom: u64) -> World {
    let mut desc = WorldDesc::new(1.0 / 60.0, 1.0, [0.0, -9.81, 0.0], UpAxis::Y, 1.0);
    desc.limits.memory_bytes = Some((genex_physics::memory::WORLD_BASE_BYTES + headroom) as f64);
    World::create(&desc).expect("world")
}

/// Five ball spawns, one by one, into a world with room by the model for three of them (§11.1):
/// the outcomes every binary must agree on, with or without the counting allocator (§1.2).
pub fn spawns_near_the_memory_limit() -> Vec<genex_physics::CommandOutcome> {
    use genex_physics::memory::{BODY_BYTES, COLLIDER_BYTES};
    let ball_bytes = BODY_BYTES + COLLIDER_BYTES + 3;
    let mut w = model_tight_world(3 * ball_bytes + 100);
    let spawns: Vec<genex_physics::Command> = (0..5)
        .map(|i| genex_physics::Command::Spawn(body(&format!("m{i}"), BodyType::Dynamic, [2.0 * f64::from(i), 1.0, 0.0], ball(0.5))))
        .collect();
    w.apply_each(&spawns)
}

/// What [`spawns_near_the_memory_limit`] gives on every target.
pub fn spawns_near_the_memory_limit_expected() -> Vec<genex_physics::CommandOutcome> {
    use genex_physics::PhysicsError::LimitMemory;
    vec![Ok(()), Ok(()), Ok(()), Err(LimitMemory), Err(LimitMemory)]
}
