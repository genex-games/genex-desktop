//! State reads (§9.1, §9.2, §11): changedSinceTick by each body's last change, exportChanged's flat
//! 14 numbers per body, exportBodyState and importBodyState (a hostile table that changes nothing),
//! and stats().

mod common;

use common::{ball, body, cube, observe, world};
use genex_physics::{
    BodyFilter, BodyType, ColliderDesc, EXPORT_STRIDE, JointDesc, JointType, NetBodyState, PhysicsError, Pose, Shape,
    StaticWorld, UpAxis, World,
};

fn changed_keys(w: &World, since: u64) -> Vec<String> {
    let filter = BodyFilter { changed_since_tick: Some(since), ..BodyFilter::default() };
    w.bodies(&filter).into_iter().map(|b| b.key).collect()
}

/// A fixed "floor", a dynamic "ball" falling onto it and a kinematic "lift", all spawned at tick 0.
fn scene(up: UpAxis) -> World {
    let mut w = world(up);
    let floor_half = match up {
        UpAxis::Y => [10.0, 0.5, 10.0],
        UpAxis::Z => [10.0, 10.0, 0.5],
    };
    let below = match up {
        UpAxis::Y => [0.0, -0.5, 0.0],
        UpAxis::Z => [0.0, 0.0, -0.5],
    };
    let above = match up {
        UpAxis::Y => [0.0, 2.0, 0.0],
        UpAxis::Z => [0.0, 0.0, 2.0],
    };
    w.spawn(&body("floor", BodyType::Fixed, below, Shape::Box { half: floor_half })).expect("floor");
    w.spawn(&body("ball", BodyType::Dynamic, above, ball(0.5))).expect("ball");
    w.spawn(&body("lift", BodyType::Kinematic, [5.0, 5.0, 5.0], cube(0.5))).expect("lift");
    w
}

fn flat(state: &NetBodyState) -> Vec<f32> {
    let values = state.p.iter().chain(&state.q).chain(&state.v).chain(&state.w);
    let mut out: Vec<f32> = values.map(|v| *v as f32).collect();
    out.push(if state.sleeping { 1.0 } else { 0.0 });
    out
}

/// The bits of each value, with −0 read as +0: §5's mapping may swap the sign of a zero.
fn bits(values: &[f32]) -> Vec<u32> {
    values.iter().map(|v| if *v == 0.0 { 0 } else { v.to_bits() }).collect()
}

#[test]
fn export_body_state_is_the_body_s_replicated_fields() {
    for up in [UpAxis::Y, UpAxis::Z] {
        let mut w = scene(up);
        for _ in 0..10 {
            w.step().expect("steps");
        }
        let state = w.body("ball").expect("there");
        let net = w.export_body_state("ball").expect("there");
        assert_eq!((net.p, net.q, net.v, net.w, net.sleeping), (state.pose.p, state.pose.q, state.linvel, state.angvel, state.sleeping));
        assert!(net.v.iter().any(|v| *v != 0.0), "{up:?}: the ball is falling");
        assert_eq!(w.export_body_state("nobody"), None);
        assert_eq!(w.export_body_state("bad key"), None);
    }
}

#[test]
fn export_changed_is_the_changed_bodies_flat_in_key_order() {
    let mut w = scene(UpAxis::Y);
    let all = w.export_changed(0);
    assert_eq!(all.keys, ["ball", "floor", "lift"], "spawned after tick 0: changed");
    assert_eq!(all.data.len(), 3 * EXPORT_STRIDE);
    for (i, key) in all.keys.iter().enumerate() {
        let expected = flat(&w.export_body_state(key).expect("there"));
        assert_eq!(bits(&all.data[i * EXPORT_STRIDE..(i + 1) * EXPORT_STRIDE]), bits(&expected), "{key}");
    }
    assert_eq!(all.data[2 * EXPORT_STRIDE - 1], 1.0, "the fixed floor reports sleeping as 1");
    w.step().expect("steps");
    w.step().expect("steps");
    let recent = w.export_changed(1);
    assert_eq!(recent.keys, ["ball"], "only the falling ball changed after tick 1");
    assert_eq!(recent.keys, changed_keys(&w, 1), "the same rule as bodies(changedSinceTick)");
    assert_eq!(bits(&recent.data), bits(&flat(&w.export_body_state("ball").expect("there"))));
    let none = w.export_changed(w.tick());
    assert!(none.keys.is_empty() && none.data.is_empty());
}

#[test]
fn import_then_export_round_trips_every_bit_awake_or_asleep() {
    for up in [UpAxis::Y, UpAxis::Z] {
        let mut source = scene(up);
        for _ in 0..7 {
            source.step().expect("steps");
        }
        let awake = source.export_body_state("ball").expect("there");
        let asleep = NetBodyState { sleeping: true, ..awake };
        for state in [awake, asleep] {
            let mut copy = scene(up);
            copy.import_body_state("ball", &state).expect("imports");
            let back = copy.export_body_state("ball").expect("there");
            assert_eq!(bits(&flat(&back)), bits(&flat(&state)), "{up:?} sleeping {}", state.sleeping);
        }
    }
}

#[test]
fn an_imported_sleeping_body_stays_put_and_an_awake_one_moves_on() {
    let mut w = scene(UpAxis::Y);
    let hover = NetBodyState { p: [0.0, 5.0, 0.0], q: [0.0, 0.0, 0.0, 1.0], v: [1.0, 0.0, 0.0], w: [0.0; 3], sleeping: true };
    w.import_body_state("ball", &hover).expect("imports");
    assert!(w.body("ball").expect("there").sleeping);
    for _ in 0..5 {
        w.step().expect("steps");
    }
    assert_eq!(w.body("ball").expect("there").pose.p, [0.0, 5.0, 0.0], "asleep: gravity does not move it");
    w.import_body_state("ball", &NetBodyState { sleeping: false, ..hover }).expect("imports");
    w.step().expect("steps");
    let state = w.body("ball").expect("there");
    assert!(!state.sleeping && state.pose.p[0] > 0.0 && state.pose.p[1] < 5.0, "{state:?}");
}

#[test]
fn an_import_marks_the_body_changed_only_when_a_bit_moves() {
    let mut w = scene(UpAxis::Y);
    w.step().expect("steps");
    w.step().expect("steps");
    let lift = w.export_body_state("lift").expect("there");
    assert!(!changed_keys(&w, 2).contains(&"lift".to_string()));
    w.import_body_state("lift", &lift).expect("same state");
    assert!(!changed_keys(&w, 2).contains(&"lift".to_string()), "the same bits: not changed");
    let moved = NetBodyState { p: [5.0, 6.0, 5.0], ..lift };
    w.import_body_state("lift", &moved).expect("kinematic accepted");
    assert_eq!(changed_keys(&w, 2), ["lift"], "the ball's fall in the step that ended tick 2 is not after it");
    assert_eq!(w.body("lift").expect("there").pose.p, [5.0, 6.0, 5.0]);
}

#[test]
fn an_import_puts_an_escaped_body_back_into_the_simulation() {
    let mut w = scene(UpAxis::Y);
    let mut far = body("rocket", BodyType::Dynamic, [0.0, 0.0, 99_999.0], ball(0.5));
    far.linvel = Some([0.0, 0.0, 900.0]);
    w.spawn(&far).expect("rocket");
    let escaped = w.step().expect("steps").escaped;
    assert_eq!(escaped, ["rocket"]);
    let back = NetBodyState { p: [3.0, 3.0, 0.0], q: [0.0, 0.0, 0.0, 1.0], v: [0.0; 3], w: [0.0; 3], sleeping: false };
    w.import_body_state("rocket", &back).expect("imports");
    w.step().expect("steps");
    let state = w.body("rocket").expect("there");
    assert!(state.pose.p[1] < 3.0 && !state.sleeping, "it falls again: {state:?}");
}

fn hostile_imports() -> Vec<(&'static str, &'static str, NetBodyState, PhysicsError)> {
    let fine = NetBodyState { p: [0.0, 1.0, 0.0], q: [0.0, 0.0, 0.0, 1.0], v: [0.0; 3], w: [0.0; 3], sleeping: false };
    vec![
        ("a malformed key", "bad key", fine, PhysicsError::InvalidKey),
        ("a refused name", "__proto__", fine, PhysicsError::InvalidKey),
        ("an unknown key", "nobody", fine, PhysicsError::UnknownKey),
        ("a fixed body", "floor", fine, PhysicsError::WrongBodyType),
        ("a static key", "static:box:0000", fine, PhysicsError::UnknownKey),
        ("a NaN position", "ball", NetBodyState { p: [f64::NAN, 0.0, 0.0], ..fine }, PhysicsError::NonFinite),
        ("1e39 velocity", "ball", NetBodyState { v: [1e39, 0.0, 0.0], ..fine }, PhysicsError::NonFinite),
        ("an infinite spin", "ball", NetBodyState { w: [0.0, f64::NEG_INFINITY, 0.0], ..fine }, PhysicsError::NonFinite),
        ("past worldExtent", "ball", NetBodyState { p: [0.0, 100_001.0, 0.0], ..fine }, PhysicsError::OutOfRange),
        ("a non-unit rotation", "ball", NetBodyState { q: [0.0, 0.0, 0.0, 1.1], ..fine }, PhysicsError::OutOfRange),
        ("a zero rotation", "ball", NetBodyState { q: [0.0; 4], ..fine }, PhysicsError::OutOfRange),
        ("past maxSpeed", "ball", NetBodyState { v: [1001.0, 0.0, 0.0], ..fine }, PhysicsError::OutOfRange),
        ("past maxAngularSpeed", "ball", NetBodyState { w: [0.0, 0.0, 1001.0], ..fine }, PhysicsError::OutOfRange),
    ]
}

#[test]
fn hostile_imports_are_refused_with_their_code_and_change_nothing() {
    for up in [UpAxis::Y, UpAxis::Z] {
        let mut w = scene(up);
        if up == UpAxis::Z {
            let floor = StaticWorld { boxes: vec![vec![20.0, 20.0, -1.0, 30.0, 30.0, 0.0]], ramps: vec![] };
            w.add_static_world(&floor).expect("imports");
        }
        w.step().expect("steps");
        for (name, key, state, code) in hostile_imports() {
            let before = (observe(&w), w.export_changed(0));
            assert_eq!(w.import_body_state(key, &state).map_err(|f| f.code), Err(code), "{up:?}: {name}");
            assert_eq!((observe(&w), w.export_changed(0)), before, "{up:?}: {name} changed something");
        }
    }
}

#[test]
fn stats_count_the_world() {
    let mut w = world(UpAxis::Z);
    let floor = StaticWorld { boxes: vec![vec![-10.0, -10.0, -1.0, 10.0, 10.0, 0.0]], ramps: vec![] };
    w.add_static_world(&floor).expect("imports");
    let mut pair = body("pair", BodyType::Dynamic, [0.0, 0.0, 0.6], cube(0.5));
    pair.colliders.push(ColliderDesc::new("top", ball(0.3)));
    pair.colliders[1].offset = Some(Pose::at([0.0, 0.0, 0.8]));
    w.spawn(&pair).expect("pair");
    w.spawn(&body("post", BodyType::Fixed, [5.0, 0.0, 1.0], cube(0.5))).expect("post");
    w.spawn(&body("lift", BodyType::Kinematic, [-5.0, 0.0, 1.0], cube(0.5))).expect("lift");
    w.add_joint(&JointDesc::new("tie", "lift", None, JointType::Ball, [0.0; 3], [-5.0, 0.0, 1.0])).expect("joint");
    let stats = w.stats();
    assert_eq!((stats.tick, stats.bodies, stats.colliders, stats.joints), (0, 3, 4, 1), "static pieces excluded");
    assert_eq!(stats.awake, 2, "the fixed post is never awake");
    assert_eq!(stats.memory_bytes, w.memory_bytes());
    for _ in 0..30 {
        w.step().expect("steps");
    }
    let stats = w.stats();
    assert_eq!(stats.tick, 30);
    assert!(stats.contact_pairs >= 1, "the pair rests on the floor: {stats:?}");
    assert_eq!(stats.memory_bytes, w.memory_bytes());
    assert_eq!(stats.step_ms, 0.0, "the core reads no clock: 0 until a binding records a time");
    w.record_step_ms(1.25).expect("recorded");
    assert_eq!(w.stats().step_ms, 1.25);
    assert_eq!(w.record_step_ms(f64::NAN).map_err(|f| f.code), Err(PhysicsError::NonFinite));
    assert_eq!(w.record_step_ms(-1.0).map_err(|f| f.code), Err(PhysicsError::OutOfRange));
    assert_eq!(w.stats().step_ms, 1.25, "a refused time changes nothing");
    w.ray([0.0, 0.0, 5.0], [0.0, 0.0, -1.0], 10.0, &Default::default()).expect("ray");
    assert_eq!(w.stats().queries_this_step, 1);
    let awake = w.bodies(&BodyFilter { awake_only: true, ..BodyFilter::default() }).len();
    assert_eq!(w.stats().awake, awake, "the same rule as bodies(awakeOnly)");
}
