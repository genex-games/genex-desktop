//! The command JSON form (§7.3): every verb reads into its command, a malformed object gives
//! `BadCommand`, and apply over JSON in both modes (§7.1).

mod common;

use common::{ball, body, observe, world};
use genex_physics::{
    Axis, BodyDesc, BodyType, ColliderDesc, Command, Groups, JointDesc, JointType, Motor, PhysicsError, Pose,
    SetPoseOptions, Shape, UpAxis,
};
use serde_json::{Value, json};

fn read(value: Value) -> Result<Command, PhysicsError> {
    Command::from_json(&value).map_err(|f| f.code)
}

#[test]
fn the_contract_example_reads() {
    let command = read(json!({ "impulse": { "key": "crate.1", "j": [0, 0, 50], "at": [0, 0, 10] } }));
    let expected = Command::Impulse { key: "crate.1".into(), j: [0.0, 0.0, 50.0], at: Some([0.0, 0.0, 10.0]) };
    assert_eq!(command, Ok(expected));
}

#[test]
fn every_short_verb_reads_into_its_command() {
    let pose = Pose { p: [1.0, 2.0, 3.0], q: [0.0, 0.0, 0.0, 1.0] };
    let rows = [
        (json!({ "remove": { "key": "a" } }), Command::Remove { key: "a".into() }),
        (json!({ "removeJoint": { "key": "j" } }), Command::RemoveJoint { key: "j".into() }),
        (json!({ "wake": { "key": "a" } }), Command::Wake { key: "a".into() }),
        (json!({ "sleep": { "key": "a" } }), Command::Sleep { key: "a".into() }),
        (json!({ "impulse": { "key": "a", "j": [1, 2, 3] } }), Command::Impulse { key: "a".into(), j: [1.0, 2.0, 3.0], at: None }),
        (
            json!({ "setVelocity": { "key": "a", "angvel": [0, 1, 0] } }),
            Command::SetVelocity { key: "a".into(), linvel: None, angvel: Some([0.0, 1.0, 0.0]) },
        ),
        (
            json!({ "setPose": { "key": "a", "pose": { "p": [1, 2, 3], "q": [0, 0, 0, 1] } } }),
            Command::SetPose { key: "a".into(), pose, options: SetPoseOptions::default() },
        ),
        (
            json!({ "setPose": { "key": "a", "pose": { "p": [1, 2, 3], "q": [0, 0, 0, 1] }, "resetVelocity": true, "wake": false } }),
            Command::SetPose { key: "a".into(), pose, options: SetPoseOptions { reset_velocity: true, wake: false } },
        ),
        (
            json!({ "setNextKinematicPose": { "key": "lift", "pose": { "p": [1, 2, 3], "q": [0, 0, 0, 1] } } }),
            Command::SetNextKinematicPose { key: "lift".into(), pose },
        ),
        (
            json!({ "areaPush": { "center": [0, 1, 0], "radius": 5, "strength": -2.5, "falloff": 0 } }),
            Command::AreaPush { center: [0.0, 1.0, 0.0], radius: 5.0, strength: -2.5, falloff: 0.0, groups: None },
        ),
        (
            json!({ "areaPush": { "center": [0, 0, 0], "radius": 1, "strength": 1, "falloff": 2, "groups": { "member": 1, "collides": 6 } } }),
            Command::AreaPush {
                center: [0.0; 3],
                radius: 1.0,
                strength: 1.0,
                falloff: 2.0,
                groups: Some(Groups { member: 1.0, collides: 6.0 }),
            },
        ),
        (
            json!({ "setMotor": { "key": "door", "motor": { "targetVel": 1.5, "maxForce": 10 } } }),
            Command::SetMotor {
                key: "door".into(),
                motor: Motor { target_vel: Some(1.5), max_force: Some(10.0), ..Motor::default() },
            },
        ),
        (json!({ "setMotor": { "key": "door", "motor": {} } }), Command::SetMotor { key: "door".into(), motor: Motor::default() }),
    ];
    for (value, expected) in rows {
        assert_eq!(read(value.clone()), Ok(expected), "{value}");
    }
}

#[test]
fn a_spawn_with_every_field_reads_into_its_body() {
    let value = json!({ "spawn": {
        "key": "player.1", "type": "dynamic", "pose": { "p": [0, 2, 0], "q": [0, 0, 0.6, 0.8] },
        "linvel": [1, 0, 0], "angvel": [0, 0.5, 0], "linearDamping": 0.1, "angularDamping": 0.2,
        "gravityScale": 0.5, "lockRotation": [true, false, true], "ccd": true, "canSleep": false, "kind": "player",
        "colliders": [
            { "key": "main", "shape": { "kind": "capsule", "halfHeight": 0.5, "radius": 0.25, "axis": "z" },
              "offset": { "p": [0, 0.1, 0], "q": [0, 0, 0, 1] }, "mass": 3, "friction": 0.9, "restitution": 0.2,
              "groups": { "member": 1, "collides": 65535 }, "events": true },
            { "key": "zone", "shape": { "kind": "sphere", "radius": 1 }, "sensor": true, "density": 0 },
            { "key": "box", "shape": { "kind": "box", "half": [1, 2, 3] } },
            { "key": "hull", "shape": { "kind": "hull", "points": [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]] } }
        ]
    }});
    let mut main = ColliderDesc::new("main", Shape::Capsule { half_height: 0.5, radius: 0.25, axis: Axis::Z });
    main.offset = Some(Pose { p: [0.0, 0.1, 0.0], q: [0.0, 0.0, 0.0, 1.0] });
    main.mass = Some(3.0);
    main.friction = Some(0.9);
    main.restitution = Some(0.2);
    main.groups = Some(Groups { member: 1.0, collides: 65_535.0 });
    main.events = true;
    let mut zone = ColliderDesc::new("zone", ball(1.0));
    zone.sensor = true;
    zone.density = Some(0.0);
    let boxed = ColliderDesc::new("box", Shape::Box { half: [1.0, 2.0, 3.0] });
    let points = vec![[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    let hull = ColliderDesc::new("hull", Shape::Hull { points });
    let pose = Pose { p: [0.0, 2.0, 0.0], q: [0.0, 0.0, 0.6, 0.8] };
    let mut desc = BodyDesc::new("player.1", BodyType::Dynamic, pose, vec![main, zone, boxed, hull]);
    desc.linvel = Some([1.0, 0.0, 0.0]);
    desc.angvel = Some([0.0, 0.5, 0.0]);
    desc.linear_damping = Some(0.1);
    desc.angular_damping = Some(0.2);
    desc.gravity_scale = Some(0.5);
    desc.lock_rotation = [true, false, true];
    desc.ccd = true;
    desc.can_sleep = false;
    desc.kind = Some("player".into());
    assert_eq!(read(value), Ok(Command::Spawn(desc)));
}

#[test]
fn mesh_shapes_read_into_their_shapes() {
    let mesh = json!({ "spawn": { "key": "m", "type": "fixed", "pose": { "p": [0, 0, 0], "q": [0, 0, 0, 1] }, "colliders": [
        { "key": "t", "shape": { "kind": "trimesh", "vertices": [[0, 0, 0], [1, 0, 0], [0, 0, 1]], "indices": [[0, 2, 1]] } },
        { "key": "h", "shape": { "kind": "heightfield", "rows": 2, "cols": 2, "heights": [0, 1, 2, 3], "size": [4, 1, 4] } }
    ] } });
    let Ok(Command::Spawn(desc)) = read(mesh) else { panic!("reads") };
    assert_eq!(desc.colliders[0].shape, Shape::Trimesh {
        vertices: vec![[0.0; 3], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]],
        indices: vec![[0.0, 2.0, 1.0]],
    });
    assert_eq!(desc.colliders[1].shape, Shape::Heightfield {
        rows: 2.0,
        cols: 2.0,
        heights: vec![0.0, 1.0, 2.0, 3.0],
        size: [4.0, 1.0, 4.0],
    });
}

#[test]
fn add_joint_reads_with_a_body_or_the_world() {
    let value = json!({ "addJoint": {
        "key": "door.hinge", "a": "door", "b": null, "type": "hinge", "anchorA": [0, 0, 0], "anchorB": [1, 0, 0],
        "axis": [0, 0, 1], "limits": [-1.5, 1.5], "motor": { "targetPos": 0, "stiffness": 10, "damping": 1 },
        "collideConnected": true
    }});
    let mut desc = JointDesc::new("door.hinge", "door", None, JointType::Hinge, [0.0; 3], [1.0, 0.0, 0.0]);
    desc.axis = Some([0.0, 0.0, 1.0]);
    desc.limits = Some([-1.5, 1.5]);
    desc.motor = Some(Motor { target_pos: Some(0.0), stiffness: Some(10.0), damping: Some(1.0), ..Motor::default() });
    desc.collide_connected = true;
    assert_eq!(read(value), Ok(Command::AddJoint(desc)));
    let rope = json!({ "addJoint": { "key": "r", "a": "x", "b": "y", "type": "rope", "anchorA": [0, 0, 0], "anchorB": [0, 0, 0], "limits": [0, 2] } });
    let Ok(Command::AddJoint(rope)) = read(rope) else { panic!("reads") };
    assert_eq!((rope.b.as_deref(), rope.joint_type), (Some("y"), JointType::Rope));
}

fn bad_rows() -> Vec<(&'static str, Value)> {
    let pose = json!({ "p": [0, 0, 0], "q": [0, 0, 0, 1] });
    let collider = json!({ "key": "c", "shape": { "kind": "sphere", "radius": 1 } });
    let spawn = |extra: Value| {
        let mut args = json!({ "key": "a", "type": "dynamic", "pose": pose, "colliders": [collider] });
        for (k, v) in extra.as_object().expect("object") {
            args[k] = v.clone();
        }
        json!({ "spawn": args })
    };
    vec![
        ("not an object", json!([1, 2])),
        ("a string", json!("impulse")),
        ("no verb", json!({})),
        ("two verbs", json!({ "wake": { "key": "a" }, "sleep": { "key": "a" } })),
        ("unknown verb", json!({ "explode": { "key": "a" } })),
        ("verb in other case", json!({ "Wake": { "key": "a" } })),
        ("arguments not an object", json!({ "wake": ["a"] })),
        ("arguments null", json!({ "wake": null })),
        ("missing key", json!({ "wake": {} })),
        ("unknown argument", json!({ "wake": { "key": "a", "hard": true } })),
        ("key a number", json!({ "remove": { "key": 7 } })),
        ("missing j", json!({ "impulse": { "key": "a" } })),
        ("j of two", json!({ "impulse": { "key": "a", "j": [1, 2] } })),
        ("j of four", json!({ "impulse": { "key": "a", "j": [1, 2, 3, 4] } })),
        ("j a string", json!({ "impulse": { "key": "a", "j": "up" } })),
        ("j with a string", json!({ "impulse": { "key": "a", "j": [1, "2", 3] } })),
        ("at null", json!({ "impulse": { "key": "a", "j": [1, 2, 3], "at": null } })),
        ("pose without q", json!({ "setPose": { "key": "a", "pose": { "p": [0, 0, 0] } } })),
        ("pose with extra", json!({ "setPose": { "key": "a", "pose": { "p": [0, 0, 0], "q": [0, 0, 0, 1], "s": 1 } } })),
        ("q of three", json!({ "setNextKinematicPose": { "key": "a", "pose": { "p": [0, 0, 0], "q": [0, 0, 1] } } })),
        ("wake a string", json!({ "setPose": { "key": "a", "pose": pose, "wake": "yes" } })),
        ("radius missing", json!({ "areaPush": { "center": [0, 0, 0], "strength": 1, "falloff": 1 } })),
        ("groups without collides", json!({ "areaPush": { "center": [0, 0, 0], "radius": 1, "strength": 1, "falloff": 1, "groups": { "member": 1 } } })),
        ("motor unknown field", json!({ "setMotor": { "key": "j", "motor": { "speed": 1 } } })),
        ("motor missing", json!({ "setMotor": { "key": "j" } })),
        ("spawn type unknown", spawn(json!({ "type": "static" }))),
        ("spawn colliders not an array", spawn(json!({ "colliders": collider }))),
        ("spawn unknown field", spawn(json!({ "mass": 1 }))),
        ("spawn ccd a number", spawn(json!({ "ccd": 1 }))),
        ("spawn kind a number", spawn(json!({ "kind": 3 }))),
        ("spawn lockRotation of two", spawn(json!({ "lockRotation": [true, false] }))),
        ("collider unknown field", spawn(json!({ "colliders": [{ "key": "c", "shape": { "kind": "sphere", "radius": 1 }, "bounce": 1 }] }))),
        ("collider without shape", spawn(json!({ "colliders": [{ "key": "c" }] }))),
        ("shape kind unknown", spawn(json!({ "colliders": [{ "key": "c", "shape": { "kind": "cone", "radius": 1 } }] }))),
        ("shape field of another kind", spawn(json!({ "colliders": [{ "key": "c", "shape": { "kind": "sphere", "radius": 1, "half": [1, 1, 1] } }] }))),
        ("capsule axis w", spawn(json!({ "colliders": [{ "key": "c", "shape": { "kind": "capsule", "halfHeight": 1, "radius": 1, "axis": "w" } }] }))),
        ("triangle of two", spawn(json!({ "colliders": [{ "key": "c", "shape": { "kind": "trimesh", "vertices": [[0, 0, 0]], "indices": [[0, 0]] } }] }))),
        ("joint without b", json!({ "addJoint": { "key": "j", "a": "x", "type": "ball", "anchorA": [0, 0, 0], "anchorB": [0, 0, 0] } })),
        ("joint type unknown", json!({ "addJoint": { "key": "j", "a": "x", "b": null, "type": "weld", "anchorA": [0, 0, 0], "anchorB": [0, 0, 0] } })),
        ("joint limits of three", json!({ "addJoint": { "key": "j", "a": "x", "b": null, "type": "hinge", "anchorA": [0, 0, 0], "anchorB": [0, 0, 0], "axis": [1, 0, 0], "limits": [0, 1, 2] } })),
    ]
}

#[test]
fn malformed_commands_give_bad_command() {
    for (name, value) in bad_rows() {
        assert_eq!(read(value), Err(PhysicsError::BadCommand), "{name}");
    }
}

#[test]
fn a_well_formed_command_with_bad_values_gives_their_own_code() {
    let rows = [
        (json!({ "impulse": { "key": "a b", "j": [1, 2, 3] } }), PhysicsError::InvalidKey),
        (json!({ "impulse": { "key": "ball", "j": [1e39, 0, 0] } }), PhysicsError::NonFinite),
        (json!({ "setVelocity": { "key": "ball", "linvel": [2000, 0, 0] } }), PhysicsError::OutOfRange),
        (json!({ "wake": { "key": "ghost" } }), PhysicsError::UnknownKey),
    ];
    let mut w = world(UpAxis::Y);
    w.spawn(&body("ball", BodyType::Dynamic, [0.0; 3], ball(0.5))).expect("ball");
    let before = observe(&w);
    for (value, code) in rows {
        let command = Command::from_json(&value).expect("well formed");
        assert_eq!(w.command(&command).err().map(|f| f.code), Some(code), "{value}");
        assert_eq!(observe(&w), before);
    }
}

#[test]
fn apply_over_json_in_each_mode_reports_every_outcome() {
    let mut w = world(UpAxis::Y);
    let batch = json!([
        { "spawn": { "key": "a", "type": "dynamic", "pose": { "p": [0, 1, 0], "q": [0, 0, 0, 1] },
                     "colliders": [{ "key": "c", "shape": { "kind": "sphere", "radius": 0.5 } }] } },
        { "impulse": { "key": "a", "j": [1, 0, 0], "extra": 1 } },
        { "impulse": { "key": "a", "j": [1, 0, 0] } },
        { "impulse": { "key": "b", "j": [1, 0, 0] } }
    ]);
    let outcomes = w.apply_json_each(&batch).expect("an array");
    assert_eq!(outcomes, [Ok(()), Err(PhysicsError::BadCommand), Ok(()), Err(PhysicsError::UnknownKey)]);
    assert!(w.body("a").expect("spawned").linvel[0] > 0.0);
    let not_array = w.apply_json_each(&json!({ "wake": { "key": "a" } })).err().map(|f| f.code);
    assert_eq!(not_array, Some(PhysicsError::BadCommand));
}

#[test]
fn apply_over_json_atomically_names_a_malformed_command_and_applies_nothing() {
    let mut w = world(UpAxis::Z);
    w.spawn(&body("a", BodyType::Dynamic, [0.0, 0.0, 1.0], ball(0.5))).expect("a");
    let before = observe(&w);
    let batch = json!([{ "impulse": { "key": "a", "j": [1, 0, 0] } }, { "impulse": { "key": "a" } }]);
    let failure = w.apply_json_atomic(&batch).expect_err("malformed");
    assert_eq!((failure.index, failure.code), (Some(1), PhysicsError::BadCommand));
    assert_eq!(observe(&w), before);
    let failure = w.apply_json_atomic(&json!("nope")).expect_err("not an array");
    assert_eq!((failure.index, failure.code), (None, PhysicsError::BadCommand));
    w.apply_json_atomic(&json!([{ "impulse": { "key": "a", "j": [1, 0, 0] } }, { "sleep": { "key": "a" } }])).expect("applies");
    assert!(w.body("a").expect("there").sleeping);
}
