//! apply() in both modes (§7.1): atomic is all or none and names the first failing index; each
//! applies every command that succeeds, in order, and a failed one changes nothing.

mod common;

use common::{ball, body, observe, world};
use genex_physics::{BodyType, Command, PhysicsError, UpAxis, World, WorldDesc};

fn spawn(key: &str, x: f64) -> Command {
    Command::Spawn(body(key, BodyType::Dynamic, [x, 1.0, 0.0], ball(0.5)))
}

fn impulse(key: &str) -> Command {
    Command::Impulse { key: key.to_string(), j: [1.0, 0.0, 0.0], at: None }
}

fn remove(key: &str) -> Command {
    Command::Remove { key: key.to_string() }
}

#[test]
fn an_atomic_batch_applies_in_order_and_sees_its_own_earlier_commands() {
    let mut w = world(UpAxis::Y);
    w.spawn(&body("old", BodyType::Dynamic, [9.0, 1.0, 0.0], ball(0.5))).expect("old");
    let batch = [spawn("a", 0.0), impulse("a"), remove("old"), spawn("old", 3.0), impulse("old")];
    w.apply_atomic(&batch).expect("all apply");
    assert!(w.body("a").expect("there").linvel[0] > 0.0);
    let reborn = w.body("old").expect("respawned");
    assert_eq!(reborn.pose.p[0], 3.0);
    assert!(reborn.linvel[0] > 0.0);
}

#[test]
fn a_failing_atomic_batch_applies_nothing_and_names_the_first_failure() {
    let mut w = world(UpAxis::Z);
    w.spawn(&body("a", BodyType::Dynamic, [0.0, 0.0, 1.0], ball(0.5))).expect("a");
    w.step().expect("steps");
    let before = observe(&w);
    let rows: [(&str, Vec<Command>, usize, PhysicsError); 5] = [
        ("unknown after a spawn", vec![spawn("b", 2.0), impulse("ghost"), impulse("b")], 1, PhysicsError::UnknownKey),
        ("removed earlier in the batch", vec![impulse("a"), remove("a"), impulse("a")], 2, PhysicsError::UnknownKey),
        ("duplicate within the batch", vec![spawn("b", 2.0), spawn("b", 4.0)], 1, PhysicsError::DuplicateKey),
        ("first of two failures", vec![impulse("a"), impulse(""), impulse("ghost")], 1, PhysicsError::InvalidKey),
        ("wrong type", vec![Command::Wake { key: "a".into() }, Command::SetNextKinematicPose { key: "a".into(), pose: genex_physics::Pose::at([0.0; 3]) }], 1, PhysicsError::WrongBodyType),
    ];
    for (name, batch, index, code) in rows {
        let failure = w.apply_atomic(&batch).expect_err(name);
        assert_eq!((failure.index, failure.code), (Some(index), code), "{name}");
        assert_eq!(observe(&w), before, "{name} changed the world");
    }
}

#[test]
fn an_atomic_batch_counts_limits_across_its_commands() {
    let mut desc = WorldDesc::new(1.0 / 60.0, 1.0, [0.0, -9.81, 0.0], UpAxis::Y, 1.0);
    desc.limits.bodies = Some(2.0);
    let mut w = World::create(&desc).expect("valid");
    w.spawn(&body("a", BodyType::Dynamic, [0.0, 1.0, 0.0], ball(0.5))).expect("a");
    let before = observe(&w);
    let failure = w.apply_atomic(&[spawn("b", 2.0), spawn("c", 4.0)]).expect_err("one too many");
    assert_eq!((failure.index, failure.code), (Some(1), PhysicsError::LimitBodies));
    assert_eq!(observe(&w), before);
    w.apply_atomic(&[remove("a"), spawn("b", 2.0), spawn("c", 4.0)]).expect("a removal frees a slot");
    assert_eq!(w.bodies(&Default::default()).len(), 2);
}

#[test]
fn an_each_batch_applies_what_succeeds_and_reports_every_outcome() {
    let mut w = world(UpAxis::Y);
    let batch = [impulse("a"), spawn("a", 0.0), impulse("a"), spawn("a", 5.0), remove("a"), impulse("a")];
    let outcomes = w.apply_each(&batch);
    let expected = [
        Err(PhysicsError::UnknownKey),
        Ok(()),
        Ok(()),
        Err(PhysicsError::DuplicateKey),
        Ok(()),
        Err(PhysicsError::UnknownKey),
    ];
    assert_eq!(outcomes, expected);
    assert!(w.body("a").is_none());
}

#[test]
fn an_each_batch_matches_the_same_commands_one_by_one() {
    let batch = [spawn("a", 0.0), impulse("ghost"), spawn("b", 2.0), impulse("b"), remove("a")];
    let mut batched = world(UpAxis::Z);
    batched.apply_each(&batch);
    let mut single = world(UpAxis::Z);
    for command in &batch {
        let _ = single.command(command);
    }
    assert_eq!(observe(&batched), observe(&single));
    let mut atomic = world(UpAxis::Z);
    let valid: Vec<Command> = batch.iter().filter(|c| !matches!(c, Command::Impulse { key, .. } if key == "ghost")).cloned().collect();
    atomic.apply_atomic(&valid).expect("all valid");
    assert_eq!(observe(&atomic), observe(&single), "atomic and each agree when nothing fails");
}
