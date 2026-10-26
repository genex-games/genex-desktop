//! Contact and trigger events (§6.2, §8.1): opt-in per collider, a < b, the exact fields, the order
//! (sub-step, then kind, then keys), a begin and an end within one step, the step's summed impulse,
//! `eventsPerStep` and `overflowed`, kind tags, static keys, and removals reporting nothing.

mod common;

use common::{ball, body, world};
use genex_physics::{
    BodyDesc, BodyType, PhysicsEvent, Pose, Shape, StaticWorld, StepResult, UpAxis, Vec3, World, WorldDesc,
};

/// A point or direction of a y-up scene in the caller's frame (§5: y-up (x, y, z) is z-up (x, −z, y)).
fn frame(up: UpAxis, v: Vec3) -> Vec3 {
    match up {
        UpAxis::Y => v,
        UpAxis::Z => [v[0], -v[2], v[1]],
    }
}

/// Half-extents of a y-up scene in the caller's frame (no signs).
fn extent(up: UpAxis, v: Vec3) -> Vec3 {
    match up {
        UpAxis::Y => v,
        UpAxis::Z => [v[0], v[2], v[1]],
    }
}

fn boxed(up: UpAxis, half: Vec3) -> Shape {
    Shape::Box { half: extent(up, half) }
}

/// A fixed ground box whose top is at height 0.
fn ground(up: UpAxis, key: &str) -> BodyDesc {
    body(key, BodyType::Fixed, frame(up, [0.0, -0.5, 0.0]), boxed(up, [20.0, 0.5, 20.0]))
}

fn with_events(mut desc: BodyDesc) -> BodyDesc {
    desc.colliders[0].events = true;
    desc
}

fn with_kind(mut desc: BodyDesc, kind: &str) -> BodyDesc {
    desc.kind = Some(kind.to_string());
    desc
}

fn steps_until_events(w: &mut World, max: usize) -> StepResult {
    for _ in 0..max {
        let result = w.step().expect("steps");
        if !result.events.is_empty() {
            return result;
        }
    }
    panic!("no event in {max} steps");
}

fn close(a: Vec3, b: Vec3, tolerance: f64) -> bool {
    a.iter().zip(&b).all(|(x, y)| (x - y).abs() <= tolerance)
}

/// The bits of a vector, with −0 read as +0.
fn bits(v: Vec3) -> [u32; 3] {
    v.map(|c| if c == 0.0 { 0 } else { (c as f32).to_bits() })
}

fn landing(up: UpAxis) -> PhysicsEvent {
    let mut w = world(up);
    w.spawn(&with_kind(ground(up, "ground"), "floor")).expect("ground");
    let ball_desc = body("ball", BodyType::Dynamic, frame(up, [0.0, 1.0, 0.0]), ball(0.5));
    w.spawn(&with_kind(with_events(ball_desc), "prop")).expect("ball");
    let result = steps_until_events(&mut w, 120);
    assert_eq!(result.events.len(), 1, "{up:?}: {:?}", result.events);
    assert!(!result.overflowed);
    result.events[0].clone()
}

#[test]
fn an_opted_in_ball_reports_its_landing_with_every_field_in_both_frames() {
    let mut seen = Vec::new();
    for up in [UpAxis::Y, UpAxis::Z] {
        let event = landing(up);
        let PhysicsEvent::ContactBegin { a, b, ca, cb, ka, kb, impulse, point, normal } = event.clone() else {
            panic!("{up:?}: expected a contactBegin, got {event:?}");
        };
        assert_eq!((a.as_str(), b.as_str(), ca.as_str(), cb.as_str()), ("ball", "ground", "c", "c"));
        assert_eq!((ka.as_deref(), kb.as_deref()), (Some("prop"), Some("floor")));
        assert!(impulse > 0.0, "{up:?}: impulse {impulse}");
        assert!(close(point, frame(up, [0.0, 0.0, 0.0]), 0.05), "{up:?}: point {point:?}");
        assert!(close(normal, frame(up, [0.0, -1.0, 0.0]), 1e-3), "{up:?}: normal from a to b, got {normal:?}");
        seen.push((up, impulse, point, normal));
    }
    let (_, impulse_y, point_y, normal_y) = seen[0];
    let (_, impulse_z, point_z, normal_z) = seen[1];
    assert_eq!(impulse_y.to_bits(), impulse_z.to_bits(), "the scalar impulse is frame-free");
    assert_eq!(bits(frame(UpAxis::Z, point_y)), bits(point_z), "the z-up point is the y-up point, mapped");
    assert_eq!(bits(frame(UpAxis::Z, normal_y)), bits(normal_z), "the z-up normal is the y-up normal, mapped");
}

#[test]
fn a_pair_without_an_opted_in_collider_reports_nothing() {
    let mut w = world(UpAxis::Y);
    w.spawn(&ground(UpAxis::Y, "ground")).expect("ground");
    w.spawn(&body("ball", BodyType::Dynamic, [0.0, 1.0, 0.0], ball(0.5))).expect("ball");
    for _ in 0..120 {
        let result = w.step().expect("steps");
        assert!(result.events.is_empty(), "{:?}", result.events);
    }
    let y = w.body("ball").expect("there").pose.p[1];
    assert!((y - 0.5).abs() < 0.02, "the ball did land: {y}");
}

#[test]
fn either_collider_opting_in_is_enough_and_a_stays_the_lower_key() {
    let mut w = world(UpAxis::Y);
    w.spawn(&with_events(ground(UpAxis::Y, "ground"))).expect("ground");
    w.spawn(&body("ball", BodyType::Dynamic, [0.0, 1.0, 0.0], ball(0.5))).expect("ball");
    let result = steps_until_events(&mut w, 120);
    let PhysicsEvent::ContactBegin { a, b, ka, kb, normal, .. } = &result.events[0] else { panic!("{:?}", result.events) };
    assert_eq!((a.as_str(), b.as_str()), ("ball", "ground"));
    assert_eq!((ka, kb), (&None, &None), "no kind tags: none set");
    assert!(close(*normal, [0.0, -1.0, 0.0], 1e-3));
}

/// Four balls that land on one sub-step, spawned out of key order.
fn four_balls(desc: WorldDesc) -> World {
    let mut w = World::create(&desc).expect("valid");
    w.spawn(&ground(UpAxis::Y, "ground")).expect("ground");
    for (i, key) in ["b3", "b1", "b2", "a9"].into_iter().enumerate() {
        let x = 2.0 * i as f64 - 3.0;
        w.spawn(&with_events(body(key, BodyType::Dynamic, [x, 1.0, 0.0], ball(0.5)))).expect("ball");
    }
    w
}

fn sixty_hz() -> WorldDesc {
    WorldDesc::new(1.0 / 60.0, 1.0, [0.0, -9.81, 0.0], UpAxis::Y, 1.0)
}

fn twenty_hz_by_three() -> WorldDesc {
    WorldDesc::new(1.0 / 20.0, 3.0, [0.0, -9.81, 0.0], UpAxis::Y, 1.0)
}

fn pair_keys(event: &PhysicsEvent) -> (String, String) {
    match event {
        PhysicsEvent::ContactBegin { a, b, .. } | PhysicsEvent::ContactEnd { a, b, .. } => (a.clone(), b.clone()),
        PhysicsEvent::TriggerEnter { sensor, other, .. } | PhysicsEvent::TriggerExit { sensor, other, .. } => {
            (sensor.clone(), other.clone())
        }
    }
}

#[test]
fn begins_on_one_sub_step_come_in_key_order_whatever_the_spawn_order() {
    for desc in [sixty_hz(), twenty_hz_by_three()] {
        let mut w = four_balls(desc);
        let result = steps_until_events(&mut w, 120);
        let keys: Vec<(String, String)> = result.events.iter().map(pair_keys).collect();
        let expected = ["a9", "b1", "b2", "b3"].map(|k| (k.to_string(), "ground".to_string()));
        assert_eq!(keys, expected, "{:?}", result.events);
        assert!(result.events.iter().all(|e| matches!(e, PhysicsEvent::ContactBegin { .. })));
    }
}

#[test]
fn past_events_per_step_the_rest_is_dropped_in_order_and_overflowed_is_set() {
    let mut desc = sixty_hz();
    desc.limits.events_per_step = Some(2.0);
    let mut w = four_balls(desc);
    let result = steps_until_events(&mut w, 120);
    let keys: Vec<String> = result.events.iter().map(|e| pair_keys(e).0).collect();
    assert_eq!(keys, ["a9", "b1"]);
    assert!(result.overflowed);
    let quiet = w.step().expect("steps");
    assert!(!quiet.overflowed, "a step under the limit is not overflowed: {:?}", quiet.events);

    let mut none = sixty_hz();
    none.limits.events_per_step = Some(0.0);
    let result = steps_until_events_or_overflow(&mut four_balls(none));
    assert!(result.events.is_empty() && result.overflowed);
}

fn steps_until_events_or_overflow(w: &mut World) -> StepResult {
    for _ in 0..120 {
        let result = w.step().expect("steps");
        if result.overflowed || !result.events.is_empty() {
            return result;
        }
    }
    panic!("nothing in 120 steps");
}

/// A world of 20 Hz in 3 sub-steps without gravity.
fn weightless_three() -> World {
    World::create(&WorldDesc::new(1.0 / 20.0, 3.0, [0.0; 3], UpAxis::Y, 1.0)).expect("valid")
}

fn bouncy(mut desc: BodyDesc) -> BodyDesc {
    desc.colliders[0].restitution = Some(1.0);
    desc.colliders[0].friction = Some(0.0);
    desc
}

#[test]
fn a_begin_and_an_end_in_one_step_are_both_reported_in_sub_step_order() {
    // 15 Hz in 4 sub-steps of 1/60 s, without gravity.
    let mut w = World::create(&WorldDesc::new(1.0 / 15.0, 4.0, [0.0; 3], UpAxis::Y, 1.0)).expect("valid");
    // A thin wall at x = 0 (faces at ±0.05).
    w.spawn(&bouncy(body("w", BodyType::Fixed, [0.0, 0.0, 0.0], Shape::Box { half: [0.05, 1.0, 1.0] }))).expect("wall");
    // "a" starts just touching and bounces off at once: it begins on sub-step 1 and, still within
    // reach on sub-step 2, ends on sub-step 3 (measured one inner step per step()).
    let mut a = with_events(bouncy(body("a", BodyType::Dynamic, [-0.149, -0.5, 0.0], ball(0.1))));
    a.linvel = Some([6.0, 0.0, 0.0]);
    w.spawn(&a).expect("a");
    // "z" comes from 0.27 away at 0.1 per sub-step and begins on sub-step 4: after a's end, so
    // the sub-step orders them before the kind (Begin < End) would.
    let mut z = with_events(bouncy(body("z", BodyType::Dynamic, [-0.42, 0.5, 0.0], ball(0.1))));
    z.linvel = Some([6.0, 0.0, 0.0]);
    w.spawn(&z).expect("z");
    let result = w.step().expect("steps");
    let summary: Vec<(&str, String, String)> = result
        .events
        .iter()
        .map(|e| {
            let kind = match e {
                PhysicsEvent::ContactBegin { .. } => "begin",
                PhysicsEvent::ContactEnd { .. } => "end",
                _ => "trigger",
            };
            let (a, b) = pair_keys(e);
            (kind, a, b)
        })
        .collect();
    let expected = [("begin", "a", "w"), ("end", "a", "w"), ("begin", "w", "z")]
        .map(|(k, a, b)| (k, a.to_string(), b.to_string()));
    assert_eq!(summary, expected, "sub-step first, then kind: {:?}", result.events);
    let PhysicsEvent::ContactBegin { normal, .. } = &result.events[2] else { panic!() };
    assert!(close(*normal, [-1.0, 0.0, 0.0], 1e-3), "from a = w to b = z: {normal:?}");
}

#[test]
fn the_begin_impulse_is_the_pair_s_normal_impulse_summed_over_the_step() {
    let mass = 4.0 / 3.0 * std::f64::consts::PI * 0.125;
    for desc in [sixty_hz(), twenty_hz_by_three()] {
        let dt = desc.dt;
        let mut w = World::create(&desc).expect("valid");
        w.spawn(&ground(UpAxis::Y, "ground")).expect("ground");
        w.spawn(&with_events(body("ball", BodyType::Dynamic, [0.0, 2.0, 0.0], ball(0.5)))).expect("ball");
        let mut before = w.body("ball").expect("there").linvel[1];
        let mut found = None;
        for _ in 0..120 {
            let result = w.step().expect("steps");
            if let Some(PhysicsEvent::ContactBegin { impulse, .. }) = result.events.first() {
                found = Some(*impulse);
                break;
            }
            before = w.body("ball").expect("there").linvel[1];
        }
        let impulse = found.expect("the ball lands within 120 steps");
        let after = w.body("ball").expect("there").linvel[1];
        // m·Δv = J − m·g·dt over the whole step, as only this pair pushes the ball.
        let expected = mass * (after - before + 9.81 * dt);
        assert!(expected > 0.1, "the ball hit hard enough to measure: {expected}");
        assert!((impulse - expected).abs() <= 2e-3 * expected, "dt {dt}: impulse {impulse}, expected {expected}");
    }
}

/// A fixed sensor zone "zone" of half-extent 1 at the origin, and a kinematic "player" outside it.
fn zone_and_player(up: UpAxis) -> World {
    let mut w = World::create(&WorldDesc::new(1.0 / 60.0, 1.0, [0.0; 3], up, 1.0)).expect("valid");
    let mut zone = with_kind(body("zone", BodyType::Fixed, [0.0; 3], Shape::Box { half: [1.0; 3] }), "pickup");
    zone.colliders[0].sensor = true;
    w.spawn(&zone).expect("zone");
    let player = with_kind(body("player", BodyType::Kinematic, frame(up, [-3.0, 0.0, 0.0]), ball(0.25)), "hero");
    w.spawn(&player).expect("player");
    w
}

fn move_player(w: &mut World, up: UpAxis, x: f64) -> Vec<PhysicsEvent> {
    w.set_next_kinematic_pose("player", Pose::at(frame(up, [x, 0.0, 0.0]))).expect("target");
    let mut events = w.step().expect("steps").events;
    for _ in 0..2 {
        events.extend(w.step().expect("steps").events);
    }
    events
}

#[test]
fn a_kinematic_body_entering_and_leaving_a_fixed_sensor_reports_triggers_in_both_frames() {
    for up in [UpAxis::Y, UpAxis::Z] {
        let mut w = zone_and_player(up);
        let enter = move_player(&mut w, up, 0.0);
        let expected_enter = PhysicsEvent::TriggerEnter {
            sensor: "zone".into(),
            sc: "c".into(),
            other: "player".into(),
            oc: "c".into(),
            ks: Some("pickup".into()),
            ko: Some("hero".into()),
        };
        assert_eq!(enter, [expected_enter], "{up:?}");
        let exit = move_player(&mut w, up, 3.0);
        let expected_exit = PhysicsEvent::TriggerExit {
            sensor: "zone".into(),
            sc: "c".into(),
            other: "player".into(),
            oc: "c".into(),
            ks: Some("pickup".into()),
            ko: Some("hero".into()),
        };
        assert_eq!(exit, [expected_exit], "{up:?}");
    }
}

#[test]
fn a_body_crossing_a_sensor_within_one_step_reports_enter_then_exit() {
    let mut w = weightless_three();
    let mut plate = body("plate", BodyType::Fixed, [0.0; 3], Shape::Box { half: [0.05, 1.0, 1.0] });
    plate.colliders[0].sensor = true;
    w.spawn(&plate).expect("plate");
    let mut dart = body("dart", BodyType::Dynamic, [-0.12, 0.0, 0.0], ball(0.02));
    dart.linvel = Some([6.0, 0.0, 0.0]);
    w.spawn(&dart).expect("dart");
    let events = w.step().expect("steps").events;
    let kinds: Vec<&str> = events
        .iter()
        .map(|e| match e {
            PhysicsEvent::TriggerEnter { .. } => "enter",
            PhysicsEvent::TriggerExit { .. } => "exit",
            _ => "contact",
        })
        .collect();
    assert_eq!(kinds, ["enter", "exit"], "{events:?}");
    assert!(events.iter().all(|e| pair_keys(e) == ("plate".to_string(), "dart".to_string())), "sensor first: {events:?}");
}

#[test]
fn static_pieces_appear_under_their_static_keys() {
    let mut w = world(UpAxis::Z);
    let floor = StaticWorld { boxes: vec![vec![-10.0, -10.0, -1.0, 10.0, 10.0, 0.0]], ramps: vec![] };
    w.add_static_world(&floor).expect("imports");
    w.spawn(&with_events(body("ball", BodyType::Dynamic, [0.0, 0.0, 1.0], ball(0.5)))).expect("ball");
    let result = steps_until_events(&mut w, 120);
    let PhysicsEvent::ContactBegin { a, b, ca, cb, ka, kb, normal, .. } = &result.events[0] else {
        panic!("{:?}", result.events)
    };
    assert_eq!((a.as_str(), b.as_str()), ("ball", "static:box:0000"));
    assert_eq!((ca.as_str(), cb.as_str()), ("c", "static:box:0000"));
    assert_eq!((ka, kb), (&None, &None));
    assert!(close(*normal, [0.0, 0.0, -1.0], 1e-3), "z-up, from the ball down: {normal:?}");
}

#[test]
fn removing_a_touching_body_reports_no_end_for_it() {
    let mut w = world(UpAxis::Y);
    w.spawn(&ground(UpAxis::Y, "ground")).expect("ground");
    w.spawn(&with_events(body("ball", BodyType::Dynamic, [0.0, 1.0, 0.0], ball(0.5)))).expect("ball");
    w.spawn(&with_events(body("other", BodyType::Dynamic, [5.0, 3.0, 0.0], ball(0.5)))).expect("other");
    steps_until_events(&mut w, 120);
    w.remove("ball").expect("removed");
    for _ in 0..60 {
        for event in w.step().expect("steps").events {
            let (a, b) = pair_keys(&event);
            assert!(a != "ball" && b != "ball", "a removed body is never named: {event:?}");
        }
    }
}

/// A heap of 24 opted-in boxes and balls falling onto the ground and each other.
fn heap(desc: &WorldDesc) -> World {
    let mut w = World::create(desc).expect("valid");
    w.spawn(&ground(UpAxis::Y, "ground")).expect("ground");
    for i in 0..24 {
        let (x, z) = ((i % 3) as f64 * 0.7 - 0.7, (i / 3 % 2) as f64 * 0.7);
        let y = 1.0 + (i / 6) as f64 * 1.1 + (i % 2) as f64 * 0.3;
        let shape = if i % 2 == 0 { ball(0.3) } else { Shape::Box { half: [0.3; 3] } };
        let mut desc = with_events(body(&format!("p{i:02}"), BodyType::Dynamic, [x, y, z], shape));
        desc.kind = Some(format!("k{}", i % 3));
        w.spawn(&desc).expect("piece");
    }
    w
}

fn kind_rank(event: &PhysicsEvent) -> u8 {
    match event {
        PhysicsEvent::ContactBegin { .. } => 0,
        PhysicsEvent::ContactEnd { .. } => 1,
        PhysicsEvent::TriggerEnter { .. } => 2,
        PhysicsEvent::TriggerExit { .. } => 3,
    }
}

#[test]
fn a_heap_s_events_repeat_bit_for_bit_and_each_pair_is_named_lower_key_first() {
    let desc = twenty_hz_by_three();
    let (mut first, mut second) = (heap(&desc), heap(&desc));
    let mut total = 0;
    for step in 0..90 {
        let (one, two) = (first.step().expect("steps"), second.step().expect("steps"));
        assert_eq!(one, two, "step {step}");
        assert_eq!(first.state_hash(), second.state_hash(), "step {step}");
        for event in &one.events {
            let (a, b) = pair_keys(event);
            if kind_rank(event) < 2 {
                assert!(a < b, "a < b: {event:?}");
            }
        }
        total += one.events.len();
    }
    assert!(total > 24, "the heap produced events: {total}");
}

/// A kinematic player box with events on, driven down through the origin, z-up: every event.
fn drive_player_down(w: &mut World) -> Vec<PhysicsEvent> {
    let player = with_events(body("player", BodyType::Kinematic, [0.0, 0.0, 3.0], Shape::Box { half: [0.5; 3] }));
    w.spawn(&player).expect("player");
    let mut events = Vec::new();
    for step in 1..=60 {
        w.set_next_kinematic_pose("player", Pose::at([0.0, 0.0, 3.0 - 0.05 * f64::from(step)])).expect("moves");
        events.extend(w.step().expect("steps").events);
    }
    events
}

fn first_begin(events: &[PhysicsEvent]) -> (String, String) {
    let begin = events.first().unwrap_or_else(|| panic!("the player overlapped something and reported nothing"));
    let PhysicsEvent::ContactBegin { a, b, .. } = begin else { panic!("{begin:?}") };
    (a.clone(), b.clone())
}

#[test]
fn an_opted_in_kinematic_body_reports_contacts_with_static_pieces_and_kinematic_bodies() {
    let mut w = world(UpAxis::Z);
    let floor = StaticWorld { boxes: vec![vec![-5.0, -5.0, -1.0, 5.0, 5.0, 0.0]], ramps: vec![] };
    w.add_static_world(&floor).expect("imports");
    let begin = first_begin(&drive_player_down(&mut w));
    assert_eq!(begin, ("player".to_string(), "static:box:0000".to_string()), "§6.2: the opt-in is per collider");

    let mut w = world(UpAxis::Z);
    w.spawn(&body("door", BodyType::Kinematic, [0.0, 0.0, -0.5], Shape::Box { half: [2.0, 2.0, 0.5] })).expect("door");
    let begin = first_begin(&drive_player_down(&mut w));
    assert_eq!(begin, ("door".to_string(), "player".to_string()));
}

#[test]
fn two_overlapping_sensors_report_a_trigger_with_the_lower_key_as_the_sensor() {
    let mut w = world(UpAxis::Y);
    let mut zone = body("zone", BodyType::Fixed, [0.0, 0.0, 0.0], Shape::Box { half: [1.0; 3] });
    zone.colliders[0].sensor = true;
    w.spawn(&zone).expect("zone");
    let mut probe = body("probe", BodyType::Kinematic, [5.0, 0.0, 0.0], ball(0.5));
    probe.colliders[0].sensor = true;
    w.spawn(&probe).expect("probe");
    let mut events = Vec::new();
    for step in 1..=30 {
        w.set_next_kinematic_pose("probe", Pose::at([5.0 - 0.2 * f64::from(step), 0.0, 0.0])).expect("moves");
        events.extend(w.step().expect("steps").events);
    }
    let enter = events.first().unwrap_or_else(|| panic!("two sensors overlapped and reported nothing"));
    let PhysicsEvent::TriggerEnter { sensor, other, .. } = enter else { panic!("{enter:?}") };
    assert_eq!((sensor.as_str(), other.as_str()), ("probe", "zone"), "both are sensors: the lower key is the sensor");
}
