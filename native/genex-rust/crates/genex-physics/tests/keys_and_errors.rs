//! Keys (§3), kinds (§6.1) and the error vocabulary (§14).

mod common;

use common::{body, cube, observe, world};
use genex_physics::key::{check_key, check_kind, check_object_key};
use genex_physics::{BodyType, ColliderDesc, PhysicsError, UpAxis};

#[test]
fn keys_take_one_to_sixty_four_bytes_of_the_charset() {
    let at_max = "k".repeat(64);
    for key in ["a", "crate.001", "player:1", "e12", "1.7.3", "A-Z_z.9:-", at_max.as_str()] {
        assert_eq!(check_key(key), Ok(()), "{key}");
    }
}

#[test]
fn malformed_keys_give_invalid_key() {
    let over_max = "k".repeat(65);
    let rows = ["", over_max.as_str(), "a b", "a/b", "é", "a\0", "a\n", "a#", "__proto__", "constructor", "prototype"];
    for key in rows {
        let refused = check_key(key).expect_err(key);
        assert_eq!(refused.code, PhysicsError::InvalidKey, "{key:?}");
    }
}

#[test]
fn near_names_of_the_refused_three_are_keys() {
    for key in ["__proto", "Constructor", "prototype1", "_prototype"] {
        assert_eq!(check_key(key), Ok(()), "{key}");
    }
}

#[test]
fn the_static_prefix_is_reserved_for_static_pieces() {
    assert_eq!(check_key("static:box:0000"), Ok(()));
    let refused = check_object_key("static:box:0000").expect_err("reserved");
    assert_eq!(refused.code, PhysicsError::InvalidKey);
    assert_eq!(check_object_key("statics:1"), Ok(()));
}

#[test]
fn kinds_take_one_to_thirty_two_bytes_of_the_charset_and_the_empty_kind_is_no_kind() {
    assert_eq!(check_kind(&"k".repeat(32)), Ok(()));
    assert_eq!(check_kind(""), Ok(()), "'' means no kind (§6.1)");
    for kind in [&"k".repeat(33), "a b", "ü"] {
        assert_eq!(check_kind(kind).expect_err(kind).code, PhysicsError::InvalidKey, "{kind:?}");
    }
}

#[test]
fn spawn_refuses_every_malformed_key_and_changes_nothing() {
    let mut w = world(UpAxis::Y);
    w.spawn(&body("ground", BodyType::Fixed, [0.0, 0.0, 0.0], cube(1.0))).expect("ground");
    let before = observe(&w);
    let mut bad_collider = body("ok", BodyType::Dynamic, [0.0, 5.0, 0.0], cube(0.5));
    bad_collider.colliders = vec![ColliderDesc::new("static:x", cube(0.5))];
    let mut bad_kind = body("ok", BodyType::Dynamic, [0.0, 5.0, 0.0], cube(0.5));
    bad_kind.kind = Some("no spaces".to_string());
    let rows = [
        body("", BodyType::Dynamic, [0.0, 5.0, 0.0], cube(0.5)),
        body("__proto__", BodyType::Dynamic, [0.0, 5.0, 0.0], cube(0.5)),
        body("static:box:0001", BodyType::Dynamic, [0.0, 5.0, 0.0], cube(0.5)),
        body(&"k".repeat(65), BodyType::Dynamic, [0.0, 5.0, 0.0], cube(0.5)),
        bad_collider,
        bad_kind,
    ];
    for desc in rows {
        let refused = w.spawn(&desc).expect_err(&desc.key);
        assert_eq!(refused.code, PhysicsError::InvalidKey, "{:?}", desc.key);
        assert_eq!(observe(&w), before, "{:?} changed the world", desc.key);
    }
}

#[test]
fn a_key_at_the_sixty_four_byte_maximum_is_a_body() {
    let mut w = world(UpAxis::Y);
    let key = "m".repeat(64);
    w.spawn(&body(&key, BodyType::Dynamic, [0.0, 1.0, 0.0], cube(0.5))).expect("max key");
    assert_eq!(w.body(&key).map(|b| b.key), Some(key));
}

#[test]
fn error_codes_are_spelled_as_the_contract_spells_them() {
    let table = [
        (PhysicsError::InvalidKey, "invalid-key"),
        (PhysicsError::DuplicateKey, "duplicate-key"),
        (PhysicsError::UnknownKey, "unknown-key"),
        (PhysicsError::NonFinite, "non-finite"),
        (PhysicsError::OutOfRange, "out-of-range"),
        (PhysicsError::BadShape, "bad-shape"),
        (PhysicsError::DynamicMesh, "dynamic-mesh"),
        (PhysicsError::WrongBodyType, "wrong-body-type"),
        (PhysicsError::BadCommand, "bad-command"),
        (PhysicsError::LimitBodies, "limit-bodies"),
        (PhysicsError::LimitColliders, "limit-colliders"),
        (PhysicsError::LimitHullVertices, "limit-hull-vertices"),
        (PhysicsError::LimitTriangles, "limit-triangles"),
        (PhysicsError::LimitJoints, "limit-joints"),
        (PhysicsError::LimitCcd, "limit-ccd"),
        (PhysicsError::LimitQueries, "limit-queries"),
        (PhysicsError::LimitStatic, "limit-static"),
        (PhysicsError::LimitMemory, "limit-memory"),
        (PhysicsError::BadSnapshot, "bad-snapshot"),
        (PhysicsError::BuildMismatch, "build-mismatch"),
        (PhysicsError::ContractMismatch, "contract-mismatch"),
        (PhysicsError::Internal, "internal"),
    ];
    assert_eq!(table.len(), PhysicsError::ALL.len());
    for (error, code) in table {
        assert_eq!(error.code(), code);
        assert_eq!(PhysicsError::from_code(code), Some(error));
    }
    assert_eq!(PhysicsError::from_code("Invalid-Key"), None);
}

#[test]
fn a_spawn_with_the_empty_kind_has_no_kind_in_its_state_and_its_events() {
    use genex_physics::{BodyFilter, PhysicsEvent};
    let mut w = world(UpAxis::Y);
    w.spawn(&body("ground", BodyType::Fixed, [0.0, -0.5, 0.0], genex_physics::Shape::Box { half: [5.0, 0.5, 5.0] })).expect("ground");
    let mut falling = body("box", BodyType::Dynamic, [0.0, 1.0, 0.0], cube(0.5));
    falling.kind = Some(String::new());
    falling.colliders[0].events = true;
    w.spawn(&falling).expect("the empty kind is no kind");
    assert_eq!(w.body("box").expect("spawned").kind, None);
    let tagged = BodyFilter { kinds: Some(vec![String::new()]), ..BodyFilter::default() };
    assert!(w.bodies(&tagged).is_empty(), "no body carries the empty kind");
    let begin = (0..120).flat_map(|_| w.step().expect("steps").events).next().expect("the box lands");
    let PhysicsEvent::ContactBegin { a, ka, kb, .. } = begin else { panic!("a contact begins first") };
    assert_eq!((a.as_str(), ka, kb), ("box", None, None));
}
