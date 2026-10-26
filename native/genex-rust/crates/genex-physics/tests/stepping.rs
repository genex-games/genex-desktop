//! step() (§8): substeps and schedules, lengthUnit, determinism, escaped bodies (§8.2), change
//! tracking (§9.1), memory after a step (§11.1) and stateHash (§10.1).

mod common;

use common::{ball, body, cube, world};
use genex_physics::{
    BodyDesc, BodyFilter, BodyType, ColliderDesc, Pose, Shape, UpAxis, Vec3, World, WorldDesc,
};

fn schedule(hz: f64, substeps: f64) -> World {
    World::create(&WorldDesc::new(1.0 / hz, substeps, [0.0, 0.0, -9.81], UpAxis::Z, 1.0)).expect("valid")
}

fn bits(v: Vec3) -> [u32; 3] {
    v.map(|c| (c as f32).to_bits())
}

#[test]
fn twenty_thirty_and_sixty_hertz_give_the_same_trajectory_each_second() {
    let schedules = [(20.0, 3.0, 20), (30.0, 2.0, 30), (60.0, 1.0, 60)];
    let mut samples: Vec<Vec<([u32; 3], [u32; 3])>> = Vec::new();
    for (hz, substeps, per_second) in schedules {
        let mut w = schedule(hz, substeps);
        w.spawn(&body("rock", BodyType::Dynamic, [1.0, 2.0, 1000.0], ball(0.5))).expect("spawns");
        let mut seconds = Vec::new();
        for _ in 0..3 {
            for _ in 0..per_second {
                w.step().expect("steps");
            }
            let state = w.body("rock").expect("there");
            seconds.push((bits(state.pose.p), bits(state.linvel)));
        }
        samples.push(seconds);
    }
    assert_eq!(samples[0], samples[2], "20 Hz x 3 against 60 Hz x 1");
    assert_eq!(samples[1], samples[2], "30 Hz x 2 against 60 Hz x 1");
    let fall = 1000.0 - f64::from(f32::from_bits(samples[2][2].0[2]));
    assert!((fall - 0.5 * 9.81 * 9.0).abs() < 0.5, "fell {fall}");
}

#[test]
fn the_tick_counts_steps_not_substeps() {
    let mut w = schedule(20.0, 3.0);
    assert_eq!(w.tick(), 0);
    let result = w.step().expect("steps");
    assert_eq!((result.tick, w.tick()), (1, 1));
    assert!(result.events.is_empty());
    assert!(!result.overflowed && !result.memory_exceeded);
    assert!(result.escaped.is_empty());
}

/// A ball dropped on a ground box, every length scaled by `unit`, gravity 9.81 m/s² in that unit.
fn scaled_scene(unit: f64) -> World {
    let desc = WorldDesc::new(1.0 / 60.0, 1.0, [0.0, -9.81 * unit, 0.0], UpAxis::Y, unit);
    let mut w = World::create(&desc).expect("valid");
    let ground = Shape::Box { half: [10.0 * unit, 0.5 * unit, 10.0 * unit] };
    w.spawn(&body("ground", BodyType::Fixed, [0.0, -0.5 * unit, 0.0], ground)).expect("ground");
    w.spawn(&body("ball", BodyType::Dynamic, [0.0, 2.0 * unit, 0.0], ball(0.5 * unit))).expect("ball");
    w
}

#[test]
fn metres_and_inches_agree_after_scaling() {
    const INCHES: f64 = 39.37;
    let mut metres = scaled_scene(1.0);
    let mut inches = scaled_scene(INCHES);
    for step in 1..=150 {
        metres.step().expect("steps");
        inches.step().expect("steps");
        let m = metres.body("ball").expect("there");
        let i = inches.body("ball").expect("there");
        let height = (m.pose.p[1], i.pose.p[1] / INCHES);
        let speed = (m.linvel[1], i.linvel[1] / INCHES);
        if step <= 30 {
            // Free fall: no tolerance involved, so only f32 rounding of the scaled numbers differs.
            assert!((height.0 - height.1).abs() < 1e-4, "step {step}: {height:?}");
            assert!((speed.0 - speed.1).abs() < 1e-3, "step {step}: {speed:?}");
        }
    }
    let rest_m = metres.body("ball").expect("there").pose.p[1];
    let rest_i = inches.body("ball").expect("there").pose.p[1] / INCHES;
    assert!((rest_m - 0.5).abs() < 0.02, "metres rest at {rest_m}");
    assert!((rest_i - rest_m).abs() < 0.005, "inches rest at {rest_i}, metres at {rest_m}");
}

fn pile(world: &mut World) {
    world.spawn(&body("ground", BodyType::Fixed, [0.0, -0.5, 0.0], Shape::Box { half: [20.0, 0.5, 20.0] })).expect("ground");
    for i in 0..24 {
        let p = [(i % 3) as f64 * 0.6 - 0.6, 0.6 + i as f64 * 0.9, (i % 2) as f64 * 0.3];
        let shape = match i % 4 {
            0 => cube(0.3),
            1 => ball(0.3),
            2 => Shape::Capsule { half_height: 0.2, radius: 0.2, axis: genex_physics::Axis::X },
            _ => Shape::Hull { points: vec![[0.0, 0.0, 0.0], [0.5, 0.0, 0.0], [0.0, 0.5, 0.0], [0.0, 0.0, 0.5], [0.4, 0.4, 0.4]] },
        };
        world.spawn(&body(&format!("piece.{i:02}"), BodyType::Dynamic, p, shape)).expect("piece");
    }
}

fn run_script() -> Vec<u64> {
    let mut w = world(UpAxis::Y);
    pile(&mut w);
    let mut hashes = vec![w.state_hash()];
    for step in 0..150 {
        if step == 40 {
            w.remove("piece.05").expect("removes");
            w.spawn(&body("late", BodyType::Dynamic, [0.0, 8.0, 0.0], cube(0.4))).expect("spawns");
        }
        w.step().expect("steps");
        hashes.push(w.state_hash());
    }
    hashes
}

#[test]
fn the_same_script_twice_gives_the_same_state_hash_every_step() {
    let first = run_script();
    let second = run_script();
    assert_eq!(first, second);
    let distinct: std::collections::BTreeSet<u64> = first.iter().copied().collect();
    assert!(distinct.len() > 100, "the hash follows the state: {} distinct", distinct.len());
}

#[test]
fn state_hash_covers_tick_keys_types_and_poses() {
    let base = || {
        let mut w = world(UpAxis::Y);
        w.spawn(&body("a", BodyType::Dynamic, [0.0, 1.0, 0.0], ball(0.5))).expect("spawns");
        w
    };
    let reference = base().state_hash();
    assert_eq!(base().state_hash(), reference);
    let mut stepped = base();
    stepped.step().expect("steps");
    assert_ne!(stepped.state_hash(), reference);
    let mut other_key = world(UpAxis::Y);
    other_key.spawn(&body("b", BodyType::Dynamic, [0.0, 1.0, 0.0], ball(0.5))).expect("spawns");
    assert_ne!(other_key.state_hash(), reference);
    let mut other_type = world(UpAxis::Y);
    other_type.spawn(&body("a", BodyType::Kinematic, [0.0, 1.0, 0.0], ball(0.5))).expect("spawns");
    assert_ne!(other_type.state_hash(), reference);
    let mut other_pose = world(UpAxis::Y);
    other_pose.spawn(&body("a", BodyType::Dynamic, [0.0, 1.5, 0.0], ball(0.5))).expect("spawns");
    assert_ne!(other_pose.state_hash(), reference);
}

#[test]
fn the_z_up_world_is_the_y_up_world_turned_bit_for_bit() {
    let mut y = world(UpAxis::Y);
    let mut z = world(UpAxis::Z);
    y.spawn(&body("ground", BodyType::Fixed, [0.0, -0.5, 0.0], Shape::Box { half: [10.0, 0.5, 10.0] })).expect("ground");
    z.spawn(&body("ground", BodyType::Fixed, [0.0, 0.0, -0.5], Shape::Box { half: [10.0, 10.0, 0.5] })).expect("ground");
    y.spawn(&body("ball", BodyType::Dynamic, [0.25, 3.0, -0.5], ball(0.5))).expect("ball");
    z.spawn(&body("ball", BodyType::Dynamic, [0.25, 0.5, 3.0], ball(0.5))).expect("ball");
    for _ in 0..120 {
        y.step().expect("steps");
        z.step().expect("steps");
        let (a, b) = (y.body("ball").expect("there"), z.body("ball").expect("there"));
        let turned = [a.pose.p[0], -a.pose.p[2], a.pose.p[1]];
        assert_eq!(bits(b.pose.p).map(zero_free), bits(turned).map(zero_free));
    }
}

/// Bits with −0 read as +0, as the hash reads them.
fn zero_free(bits: u32) -> u32 {
    if bits == 0x8000_0000 { 0 } else { bits }
}

#[test]
fn a_body_past_world_extent_escapes_once_and_stays_frozen() {
    let mut desc = WorldDesc::new(1.0 / 60.0, 1.0, [0.0, 0.0, 0.0], UpAxis::Y, 1.0);
    desc.limits.world_extent = Some(100.0);
    let mut w = World::create(&desc).expect("valid");
    let mut runner = body("runner", BodyType::Dynamic, [99.0, 0.0, 0.0], ball(0.5));
    runner.linvel = Some([120.0, 0.0, 0.0]);
    w.spawn(&runner).expect("spawns");
    w.spawn(&body("stay", BodyType::Dynamic, [0.0, 0.0, 0.0], ball(0.5))).expect("spawns");
    let first = w.step().expect("steps");
    assert_eq!(first.escaped, ["runner"]);
    let frozen = w.body("runner").expect("still there until removed");
    assert!(frozen.pose.p[0] > 100.0);
    assert_eq!((frozen.linvel, frozen.angvel, frozen.sleeping), ([0.0; 3], [0.0; 3], true));
    for _ in 0..5 {
        let later = w.step().expect("steps");
        assert!(later.escaped.is_empty(), "listed once");
        assert_eq!(w.body("runner").expect("there").pose, frozen.pose);
    }
    w.remove("runner").expect("the host removes escaped bodies");
}

#[test]
fn changed_since_tick_lists_what_moved_after_that_tick() {
    let mut w = world(UpAxis::Y);
    w.spawn(&body("floor", BodyType::Fixed, [0.0, -0.5, 0.0], Shape::Box { half: [10.0, 0.5, 10.0] })).expect("floor");
    w.spawn(&body("faller", BodyType::Dynamic, [0.0, 5.0, 0.0], ball(0.5))).expect("faller");
    let since = |w: &World, tick: u64| -> Vec<String> {
        let filter = BodyFilter { changed_since_tick: Some(tick), ..BodyFilter::default() };
        w.bodies(&filter).into_iter().map(|b| b.key).collect()
    };
    assert_eq!(since(&w, 0), ["faller", "floor"], "spawned after tick 0");
    w.step().expect("steps");
    assert_eq!(since(&w, 0), ["faller", "floor"]);
    assert_eq!(since(&w, 1), Vec::<String>::new(), "nothing after tick 1 yet");
    w.step().expect("steps");
    assert_eq!(since(&w, 1), ["faller"], "the fixed floor did not move");
    w.spawn(&body("late", BodyType::Fixed, [5.0, 0.0, 5.0], cube(0.2))).expect("late");
    assert_eq!(since(&w, 2), ["late"]);
}

#[test]
fn the_body_filter_selects_by_kind_and_wakefulness() {
    let mut w = world(UpAxis::Y);
    let mut prop = body("prop", BodyType::Dynamic, [0.0, 3.0, 0.0], ball(0.5));
    prop.kind = Some("prop".to_string());
    let mut wall = body("wall", BodyType::Fixed, [5.0, 0.0, 0.0], cube(1.0));
    wall.kind = Some("wall".to_string());
    w.spawn(&prop).expect("prop");
    w.spawn(&wall).expect("wall");
    w.spawn(&body("plain", BodyType::Dynamic, [9.0, 3.0, 0.0], ball(0.5))).expect("plain");
    let keys = |filter: BodyFilter| -> Vec<String> { w.bodies(&filter).into_iter().map(|b| b.key).collect() };
    assert_eq!(keys(BodyFilter { kinds: Some(vec!["prop".into(), "wall".into()]), ..BodyFilter::default() }), ["prop", "wall"]);
    assert_eq!(keys(BodyFilter { kinds: Some(vec![]), ..BodyFilter::default() }), Vec::<String>::new());
    assert_eq!(keys(BodyFilter { awake_only: true, ..BodyFilter::default() }), ["plain", "prop"]);
}

#[test]
fn a_step_that_ends_over_memory_bytes_reports_it() {
    let scene = |limit: Option<f64>| {
        let mut desc = WorldDesc::new(1.0 / 60.0, 1.0, [0.0, -9.81, 0.0], UpAxis::Y, 1.0);
        desc.limits.memory_bytes = limit;
        let mut w = World::create(&desc).expect("valid");
        w.spawn(&body("floor", BodyType::Fixed, [0.0, -0.5, 0.0], Shape::Box { half: [10.0, 0.5, 10.0] })).expect("floor");
        w.spawn(&body("box", BodyType::Dynamic, [0.0, 0.49, 0.0], cube(0.5))).expect("box");
        w
    };
    let bodies_only = scene(None).memory_bytes();
    let mut w = scene(Some((bodies_only + 100) as f64));
    let result = w.step().expect("steps");
    assert!(w.memory_bytes() > bodies_only, "a contact pair is accounted");
    assert!(result.memory_exceeded);
    assert!(!scene(None).step().expect("steps").memory_exceeded);
}

#[test]
fn kinematic_bodies_keep_their_pose_without_a_target() {
    let mut w = world(UpAxis::Z);
    let pose = Pose { p: [1.0, 2.0, 3.0], q: [0.0, 0.0, 0.6, 0.8] };
    w.spawn(&BodyDesc::new("lift", BodyType::Kinematic, pose, vec![ColliderDesc::new("c", cube(1.0))])).expect("spawns");
    let before = w.body("lift").expect("there");
    for _ in 0..10 {
        w.step().expect("steps");
    }
    let after = w.body("lift").expect("there");
    assert_eq!(after.pose, before.pose);
    assert_eq!(after.linvel, [0.0; 3]);
}
