//! Queries (§13): ray, shapeCast and overlap with their filters, ties by key, static keys, the
//! world as of the last step plus the commands applied since, `queriesPerStep` counted from the
//! previous step, the JSON form, and hostile queries that change nothing.

mod common;

use common::{ball, body, cube, observe, world};
use genex_physics::{
    BodyDesc, BodyType, ColliderDesc, Groups, Hit, PhysicsError, Pose, Query, QueryAnswer, QueryFilter, SetPoseOptions,
    Shape, StaticWorld, UpAxis, Vec3, World, WorldDesc,
};
use serde_json::json;

/// A vector of a y-up scene in the caller's frame (§5).
fn frame(up: UpAxis, v: Vec3) -> Vec3 {
    match up {
        UpAxis::Y => v,
        UpAxis::Z => [v[0], -v[2], v[1]],
    }
}

fn all() -> QueryFilter {
    QueryFilter::default()
}

fn close(a: Vec3, b: Vec3, tolerance: f64) -> bool {
    a.iter().zip(&b).all(|(x, y)| (x - y).abs() <= tolerance)
}

/// A world with a fixed unit-half box "wall" at x = 5 and another, "far", at x = 9.
fn walls(up: UpAxis) -> World {
    let mut w = world(up);
    w.spawn(&body("wall", BodyType::Fixed, frame(up, [5.0, 0.0, 0.0]), cube(1.0))).expect("wall");
    w.spawn(&body("far", BodyType::Fixed, frame(up, [9.0, 0.0, 0.0]), cube(1.0))).expect("far");
    w
}

fn hit_body(hit: &Option<Hit>) -> Option<&str> {
    hit.as_ref().map(|h| h.body.as_str())
}

#[test]
fn a_ray_hits_the_nearest_face_with_its_distance_point_and_normal_in_both_frames() {
    for up in [UpAxis::Y, UpAxis::Z] {
        let mut w = walls(up);
        let hit = w.ray([0.0; 3], frame(up, [3.0, 0.0, 0.0]), 10.0, &all()).expect("valid").expect("a hit");
        assert_eq!((hit.body.as_str(), hit.collider.as_str()), ("wall", "c"), "{up:?}");
        assert!((hit.dist - 4.0).abs() < 1e-5, "{up:?}: dist along the normalised direction, got {}", hit.dist);
        assert!(close(hit.point, frame(up, [4.0, 0.0, 0.0]), 1e-5), "{up:?}: {:?}", hit.point);
        assert!(close(hit.normal, frame(up, [-1.0, 0.0, 0.0]), 1e-5), "{up:?}: {:?}", hit.normal);
        assert_eq!(w.ray([0.0; 3], frame(up, [1.0, 0.0, 0.0]), 3.5, &all()).expect("valid"), None, "{up:?}: too short");
        let from_inside = w.ray(frame(up, [5.0, 0.0, 0.0]), frame(up, [1.0, 0.0, 0.0]), 10.0, &all()).expect("valid");
        assert_eq!(from_inside.map(|h| (h.body, h.dist)), Some(("wall".to_string(), 0.0)), "{up:?}: a solid hit at 0");
    }
}

#[test]
fn equal_distances_resolve_by_body_key_then_collider_key() {
    for order in [["b", "a"], ["a", "b"]] {
        let mut w = world(UpAxis::Y);
        for key in order {
            w.spawn(&body(key, BodyType::Fixed, [5.0, 0.0, 0.0], cube(1.0))).expect("box");
        }
        let hit = w.ray([0.0; 3], [1.0, 0.0, 0.0], 10.0, &all()).expect("valid").expect("a hit");
        assert_eq!(hit.body, "a", "spawned {order:?}");
    }
    let mut w = world(UpAxis::Y);
    let colliders = vec![ColliderDesc::new("c2", cube(1.0)), ColliderDesc::new("c1", cube(1.0))];
    w.spawn(&BodyDesc::new("twin", BodyType::Fixed, Pose::at([5.0, 0.0, 0.0]), colliders)).expect("twin");
    let hit = w.ray([0.0; 3], [1.0, 0.0, 0.0], 10.0, &all()).expect("valid").expect("a hit");
    assert_eq!((hit.body.as_str(), hit.collider.as_str()), ("twin", "c1"));
}

#[test]
fn filters_exclude_bodies_match_groups_and_skip_sensors_unless_asked() {
    let mut w = world(UpAxis::Y);
    let mut sensor = body("gate", BodyType::Fixed, [2.0, 0.0, 0.0], cube(0.5));
    sensor.colliders[0].sensor = true;
    w.spawn(&sensor).expect("gate");
    let mut tagged = body("red", BodyType::Fixed, [5.0, 0.0, 0.0], cube(1.0));
    tagged.colliders[0].groups = Some(Groups { member: 2.0, collides: 65535.0 });
    w.spawn(&tagged).expect("red");
    w.spawn(&body("wall", BodyType::Fixed, [9.0, 0.0, 0.0], cube(1.0))).expect("wall");
    let ray = |w: &mut World, filter: &QueryFilter| w.ray([0.0; 3], [1.0, 0.0, 0.0], 20.0, filter).expect("valid");

    assert_eq!(hit_body(&ray(&mut w, &all())), Some("red"), "sensors are skipped by default");
    let sensors = QueryFilter { include_sensors: true, ..all() };
    assert_eq!(hit_body(&ray(&mut w, &sensors)), Some("gate"));
    let skip_red = QueryFilter { exclude_bodies: vec!["red".into(), "nobody".into()], ..all() };
    assert_eq!(hit_body(&ray(&mut w, &skip_red)), Some("wall"), "an unknown excluded key is ignored");
    let group_one = QueryFilter { groups: Some(Groups { member: 1.0, collides: 1.0 }), ..all() };
    assert_eq!(hit_body(&ray(&mut w, &group_one)), Some("wall"), "red is only in group 2");
    let group_two = QueryFilter { groups: Some(Groups { member: 1.0, collides: 2.0 }), ..all() };
    assert_eq!(hit_body(&ray(&mut w, &group_two)), Some("red"));
}

#[test]
fn queries_see_commands_applied_since_the_last_step() {
    let mut w = world(UpAxis::Y);
    w.step().expect("steps");
    let ray = |w: &mut World| w.ray([0.0; 3], [1.0, 0.0, 0.0], 20.0, &all()).expect("valid");
    w.spawn(&body("crate", BodyType::Dynamic, [5.0, 0.0, 0.0], cube(1.0))).expect("crate");
    assert_eq!(hit_body(&ray(&mut w)), Some("crate"), "a body spawned since the step");
    w.set_pose("crate", Pose::at([0.0, 10.0, 0.0]), SetPoseOptions::default()).expect("moved");
    assert_eq!(hit_body(&ray(&mut w)), None, "the old place is empty");
    let up = w.ray([0.0; 3], [0.0, 1.0, 0.0], 20.0, &all()).expect("valid");
    assert_eq!(up.map(|h| (h.body, h.dist as f32)), Some(("crate".to_string(), 9.0)), "the new place");
    w.step().expect("steps");
    assert!(w.ray([0.0; 3], [0.0, 1.0, 0.0], 20.0, &all()).expect("valid").is_some(), "after a step too");
    w.remove("crate").expect("removed");
    assert_eq!(w.ray([0.0; 3], [0.0, 1.0, 0.0], 20.0, &all()).expect("valid"), None, "a removed body");
}

#[test]
fn a_kinematic_body_is_queried_where_its_last_step_left_it() {
    let mut w = world(UpAxis::Y);
    w.spawn(&body("lift", BodyType::Kinematic, [5.0, 0.0, 0.0], cube(1.0))).expect("lift");
    w.step().expect("steps");
    w.set_next_kinematic_pose("lift", Pose::at([5.0, 3.0, 0.0])).expect("target");
    w.step().expect("steps");
    let hit = w.ray([0.0, 3.0, 0.0], [1.0, 0.0, 0.0], 20.0, &all()).expect("valid").expect("a hit");
    assert_eq!((hit.body.as_str(), hit.dist as f32), ("lift", 4.0));
}

#[test]
fn static_pieces_are_hit_under_their_static_keys() {
    let mut w = world(UpAxis::Z);
    let floor = StaticWorld { boxes: vec![vec![-10.0, -10.0, -1.0, 10.0, 10.0, 0.0]], ramps: vec![] };
    w.add_static_world(&floor).expect("imports");
    let hit = w.ray([0.0, 0.0, 5.0], [0.0, 0.0, -2.0], 10.0, &all()).expect("valid").expect("a hit");
    assert_eq!((hit.body.as_str(), hit.collider.as_str()), ("static:box:0000", "static:box:0000"));
    assert!((hit.dist - 5.0).abs() < 1e-5 && close(hit.normal, [0.0, 0.0, 1.0], 1e-5), "{hit:?}");
    let skip = QueryFilter { exclude_bodies: vec!["static:box:0000".into()], ..all() };
    assert_eq!(w.ray([0.0, 0.0, 5.0], [0.0, 0.0, -1.0], 10.0, &skip).expect("valid"), None);
}

#[test]
fn a_shape_cast_stops_at_first_contact() {
    for up in [UpAxis::Y, UpAxis::Z] {
        let mut w = walls(up);
        let hit = w
            .shape_cast(&ball(0.5), Pose::at([0.0; 3]), frame(up, [2.0, 0.0, 0.0]), 20.0, &all())
            .expect("valid")
            .expect("a hit");
        assert_eq!((hit.body.as_str(), hit.collider.as_str()), ("wall", "c"), "{up:?}");
        assert!((hit.dist - 3.5).abs() < 1e-3, "{up:?}: {}", hit.dist);
        // The witness point comes from GJK, good to a few thousandths on a flat face.
        assert!(close(hit.point, frame(up, [4.0, 0.0, 0.0]), 5e-3), "{up:?}: on the wall, {:?}", hit.point);
        assert!(close(hit.normal, frame(up, [-1.0, 0.0, 0.0]), 1e-3), "{up:?}: the wall's normal, {:?}", hit.normal);
        let short = w.shape_cast(&cube(0.5), Pose::at([0.0; 3]), frame(up, [1.0, 0.0, 0.0]), 3.0, &all());
        assert_eq!(short.expect("valid"), None, "{up:?}");
        let inside = w.shape_cast(&ball(0.5), Pose::at(frame(up, [4.2, 0.0, 0.0])), frame(up, [1.0, 0.0, 0.0]), 1.0, &all());
        assert_eq!(inside.expect("valid").map(|h| h.dist), Some(0.0), "{up:?}: already touching");
    }
}

#[test]
fn an_overlap_lists_each_body_once_in_key_order() {
    let mut w = world(UpAxis::Y);
    let colliders = vec![ColliderDesc::new("left", cube(0.5)), ColliderDesc::new("right", cube(0.5))];
    let mut twin = BodyDesc::new("m.twin", BodyType::Dynamic, Pose::at([0.0; 3]), colliders);
    twin.colliders[1].offset = Some(Pose::at([1.0, 0.0, 0.0]));
    w.spawn(&twin).expect("twin");
    w.spawn(&body("a.box", BodyType::Fixed, [0.0, -1.0, 0.0], cube(0.5))).expect("a.box");
    w.spawn(&body("z.ball", BodyType::Dynamic, [0.5, 1.0, 0.0], ball(0.5))).expect("z.ball");
    let mut sensor = body("b.zone", BodyType::Fixed, [0.0; 3], cube(3.0));
    sensor.colliders[0].sensor = true;
    w.spawn(&sensor).expect("zone");
    w.spawn(&body("far", BodyType::Fixed, [20.0, 0.0, 0.0], cube(0.5))).expect("far");
    let probe = Shape::Box { half: [1.5, 1.6, 0.5] };
    let keys = w.overlap(&probe, Pose::at([0.5, 0.0, 0.0]), &all()).expect("valid");
    assert_eq!(keys, ["a.box", "m.twin", "z.ball"]);
    let with_sensors = w.overlap(&probe, Pose::at([0.5, 0.0, 0.0]), &QueryFilter { include_sensors: true, ..all() });
    assert_eq!(with_sensors.expect("valid"), ["a.box", "b.zone", "m.twin", "z.ball"]);
}

fn limited(queries: f64) -> World {
    let mut desc = WorldDesc::new(1.0 / 60.0, 1.0, [0.0, -9.81, 0.0], UpAxis::Y, 1.0);
    desc.limits.queries_per_step = Some(queries);
    let mut w = World::create(&desc).expect("valid");
    w.spawn(&body("wall", BodyType::Fixed, [5.0, 0.0, 0.0], cube(1.0))).expect("wall");
    w
}

#[test]
fn queries_count_from_the_previous_step_and_past_the_limit_give_limit_queries() {
    let mut w = limited(3.0);
    assert_eq!(w.ray([0.0; 3], [0.0; 3], 1.0, &all()).map_err(|f| f.code), Err(PhysicsError::OutOfRange));
    assert_eq!(w.stats().queries_this_step, 0, "a refused query is not counted");
    w.ray([0.0; 3], [1.0, 0.0, 0.0], 10.0, &all()).expect("1");
    w.shape_cast(&ball(0.1), Pose::at([0.0; 3]), [1.0, 0.0, 0.0], 10.0, &all()).expect("2");
    w.overlap(&ball(0.1), Pose::at([0.0; 3]), &all()).expect("3");
    assert_eq!(w.stats().queries_this_step, 3);
    let before = observe(&w);
    let refused = w.ray([0.0; 3], [1.0, 0.0, 0.0], 10.0, &all());
    assert_eq!(refused.map_err(|f| f.code), Err(PhysicsError::LimitQueries));
    assert_eq!(observe(&w), before);
    assert_eq!(w.stats().queries_this_step, 3);
    w.step().expect("steps");
    assert_eq!(w.stats().queries_this_step, 0, "a step starts a new quota");
    assert!(w.ray([0.0; 3], [1.0, 0.0, 0.0], 10.0, &all()).expect("allowed again").is_some());
    let mut none = limited(0.0);
    assert_eq!(none.overlap(&ball(1.0), Pose::at([0.0; 3]), &all()).map_err(|f| f.code), Err(PhysicsError::LimitQueries));
}

#[test]
fn queries_change_nothing() {
    let mut w = walls(UpAxis::Y);
    w.spawn(&body("ball", BodyType::Dynamic, [0.0, 3.0, 0.0], ball(0.5))).expect("ball");
    w.step().expect("steps");
    let before = observe(&w);
    for _ in 0..10 {
        w.ray([0.0; 3], [1.0, 0.0, 0.0], 20.0, &all()).expect("ray");
        w.shape_cast(&cube(0.2), Pose::at([0.0; 3]), [1.0, 0.0, 0.0], 20.0, &all()).expect("cast");
        w.overlap(&ball(5.0), Pose::at([0.0; 3]), &all()).expect("overlap");
    }
    assert_eq!(observe(&w), before);
    let mut twin = walls(UpAxis::Y);
    twin.spawn(&body("ball", BodyType::Dynamic, [0.0, 3.0, 0.0], ball(0.5))).expect("ball");
    twin.step().expect("steps");
    for _ in 0..20 {
        w.step().expect("steps");
        twin.step().expect("steps");
    }
    assert_eq!(w.state_hash(), twin.state_hash(), "a queried world steps as an unqueried one");
}

fn hostile_queries() -> Vec<(&'static str, Query, PhysicsError)> {
    let ray = |origin: Vec3, dir: Vec3, max_dist: f64, filter: QueryFilter| Query::Ray { origin, dir, max_dist, filter };
    let fine = QueryFilter::default;
    let cast = |shape: Shape, dir: Vec3| Query::ShapeCast { shape, pose: Pose::at([0.0; 3]), dir, max_dist: 5.0, filter: fine() };
    let many = QueryFilter { exclude_bodies: (0..65).map(|i| format!("b{i}")).collect(), ..fine() };
    let mesh = Shape::Trimesh { vertices: vec![[0.0; 3], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]], indices: vec![[0.0, 1.0, 2.0]] };
    let field = Shape::Heightfield { rows: 2.0, cols: 2.0, heights: vec![0.0; 4], size: [1.0; 3] };
    vec![
        ("zero dir", ray([0.0; 3], [0.0; 3], 1.0, fine()), PhysicsError::OutOfRange),
        ("dir rounding to zero", ray([0.0; 3], [1e-50, 0.0, 0.0], 1.0, fine()), PhysicsError::OutOfRange),
        ("NaN origin", ray([f64::NAN, 0.0, 0.0], [1.0, 0.0, 0.0], 1.0, fine()), PhysicsError::NonFinite),
        ("infinite dir", ray([0.0; 3], [f64::INFINITY, 0.0, 0.0], 1.0, fine()), PhysicsError::NonFinite),
        ("1e39 maxDist", ray([0.0; 3], [1.0, 0.0, 0.0], 1e39, fine()), PhysicsError::NonFinite),
        ("negative maxDist", ray([0.0; 3], [1.0, 0.0, 0.0], -1.0, fine()), PhysicsError::OutOfRange),
        ("origin past worldExtent", ray([2e5, 0.0, 0.0], [1.0, 0.0, 0.0], 1.0, fine()), PhysicsError::OutOfRange),
        ("65 excluded bodies", ray([0.0; 3], [1.0, 0.0, 0.0], 1.0, many), PhysicsError::OutOfRange),
        (
            "a malformed excluded key",
            ray([0.0; 3], [1.0, 0.0, 0.0], 1.0, QueryFilter { exclude_bodies: vec!["bad key".into()], ..fine() }),
            PhysicsError::InvalidKey,
        ),
        (
            "a group mask past 16 bits",
            ray([0.0; 3], [1.0, 0.0, 0.0], 1.0, QueryFilter { groups: Some(Groups { member: 65536.0, collides: 1.0 }), ..fine() }),
            PhysicsError::OutOfRange,
        ),
        ("a trimesh cast", cast(mesh.clone(), [1.0, 0.0, 0.0]), PhysicsError::OutOfRange),
        ("a heightfield cast", cast(field.clone(), [1.0, 0.0, 0.0]), PhysicsError::OutOfRange),
        ("a zero cast dir", cast(ball(1.0), [0.0; 3]), PhysicsError::OutOfRange),
        ("a zero-radius cast", cast(ball(0.0), [1.0, 0.0, 0.0]), PhysicsError::BadShape),
        ("a flat hull", cast(Shape::Hull { points: vec![[0.0; 3], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [1.0, 1.0, 0.0]] }, [1.0, 0.0, 0.0]), PhysicsError::BadShape),
        ("a trimesh overlap", Query::Overlap { shape: mesh, pose: Pose::at([0.0; 3]), filter: fine() }, PhysicsError::OutOfRange),
        ("a heightfield overlap", Query::Overlap { shape: field, pose: Pose::at([0.0; 3]), filter: fine() }, PhysicsError::OutOfRange),
        (
            "a non-unit pose",
            Query::Overlap { shape: ball(1.0), pose: Pose { p: [0.0; 3], q: [0.0, 0.0, 0.0, 2.0] }, filter: fine() },
            PhysicsError::OutOfRange,
        ),
        (
            "a hull past hullVertices",
            Query::Overlap {
                shape: Shape::Hull { points: (0..65).map(|i| [f64::from(i).cos(), f64::from(i).sin(), f64::from(i % 7)]).collect() },
                pose: Pose::at([0.0; 3]),
                filter: fine(),
            },
            PhysicsError::LimitHullVertices,
        ),
    ]
}

#[test]
fn hostile_queries_are_refused_with_their_code_and_change_nothing() {
    let mut w = walls(UpAxis::Y);
    w.spawn(&body("ball", BodyType::Dynamic, [0.0, 3.0, 0.0], ball(0.5))).expect("ball");
    w.step().expect("steps");
    for (name, query, code) in hostile_queries() {
        let before = (observe(&w), w.stats());
        let refused = w.query(&query).map_err(|f| f.code);
        assert_eq!(refused, Err(code), "{name}");
        assert_eq!((observe(&w), w.stats()), before, "{name}: changed something");
    }
}

#[test]
fn the_json_form_runs_the_same_queries() {
    let mut w = walls(UpAxis::Y);
    let ray = w.query_json(&json!({ "ray": { "origin": [0, 0, 0], "dir": [3, 0, 0], "maxDist": 10 } })).expect("ray");
    let typed = w.ray([0.0; 3], [3.0, 0.0, 0.0], 10.0, &all()).expect("typed");
    assert_eq!(ray, QueryAnswer::Hit(typed));
    let filtered = json!({ "ray": { "origin": [0, 0, 0], "dir": [1, 0, 0], "maxDist": 20,
        "filter": { "excludeBodies": ["wall"], "includeSensors": false, "groups": { "member": 1, "collides": 65535 } } } });
    let QueryAnswer::Hit(Some(hit)) = w.query_json(&filtered).expect("filtered") else { panic!("a hit") };
    assert_eq!(hit.body, "far");
    let cast = json!({ "shapeCast": { "shape": { "kind": "sphere", "radius": 0.5 },
        "pose": { "p": [0, 0, 0], "q": [0, 0, 0, 1] }, "dir": [1, 0, 0], "maxDist": 20 } });
    let QueryAnswer::Hit(Some(hit)) = w.query_json(&cast).expect("cast") else { panic!("a hit") };
    assert_eq!(hit.body, "wall");
    let overlap = json!({ "overlap": { "shape": { "kind": "box", "half": [10, 1, 1] }, "pose": { "p": [5, 0, 0], "q": [0, 0, 0, 1] } } });
    assert_eq!(w.query_json(&overlap).expect("overlap"), QueryAnswer::Keys(vec!["far".into(), "wall".into()]));
    let parsed = Query::from_json(&json!({ "overlap": { "shape": { "kind": "sphere", "radius": 1 }, "pose": { "p": [1, 2, 3], "q": [0, 0, 0, 1] } } }));
    assert_eq!(parsed.expect("parses"), Query::Overlap { shape: ball(1.0), pose: Pose::at([1.0, 2.0, 3.0]), filter: all() });
    let bad_value = w.query_json(&json!({ "ray": { "origin": [0, 0, 0], "dir": [0, 0, 0], "maxDist": 1 } }));
    assert_eq!(bad_value.map_err(|f| f.code), Err(PhysicsError::OutOfRange), "well-formed, bad value");
}

#[test]
fn malformed_json_queries_give_bad_command_and_change_nothing() {
    let ray = |args: serde_json::Value| json!({ "ray": args });
    let pose = json!({ "p": [0, 0, 0], "q": [0, 0, 0, 1] });
    let rows = vec![
        ("not an object", json!([1, 2])),
        ("no verb", json!({})),
        ("two verbs", json!({ "ray": {}, "overlap": {} })),
        ("an unknown verb", json!({ "sweep": {} })),
        ("args not an object", json!({ "ray": 3 })),
        ("missing maxDist", ray(json!({ "origin": [0, 0, 0], "dir": [1, 0, 0] }))),
        ("an unknown argument", ray(json!({ "origin": [0, 0, 0], "dir": [1, 0, 0], "maxDist": 1, "solid": true }))),
        ("a short vector", ray(json!({ "origin": [0, 0], "dir": [1, 0, 0], "maxDist": 1 }))),
        ("a string number", ray(json!({ "origin": [0, 0, 0], "dir": [1, 0, 0], "maxDist": "1" }))),
        ("a null maxDist", ray(json!({ "origin": [0, 0, 0], "dir": [1, 0, 0], "maxDist": null }))),
        ("a filter with an unknown field", ray(json!({ "origin": [0, 0, 0], "dir": [1, 0, 0], "maxDist": 1, "filter": { "solid": 1 } }))),
        ("excludeBodies not an array", ray(json!({ "origin": [0, 0, 0], "dir": [1, 0, 0], "maxDist": 1, "filter": { "excludeBodies": "a" } }))),
        ("a non-string excluded key", ray(json!({ "origin": [0, 0, 0], "dir": [1, 0, 0], "maxDist": 1, "filter": { "excludeBodies": [1] } }))),
        ("includeSensors not a boolean", ray(json!({ "origin": [0, 0, 0], "dir": [1, 0, 0], "maxDist": 1, "filter": { "includeSensors": 1 } }))),
        ("groups missing collides", ray(json!({ "origin": [0, 0, 0], "dir": [1, 0, 0], "maxDist": 1, "filter": { "groups": { "member": 1 } } }))),
        ("an unknown shape kind", json!({ "overlap": { "shape": { "kind": "cone", "radius": 1 }, "pose": pose } })),
        ("a shape with an extra field", json!({ "overlap": { "shape": { "kind": "sphere", "radius": 1, "half": [1, 1, 1] }, "pose": pose } })),
        ("a pose missing q", json!({ "overlap": { "shape": { "kind": "sphere", "radius": 1 }, "pose": { "p": [0, 0, 0] } } })),
        ("a cast missing dir", json!({ "shapeCast": { "shape": { "kind": "sphere", "radius": 1 }, "pose": pose, "maxDist": 1 } })),
        ("an overlap with maxDist", json!({ "overlap": { "shape": { "kind": "sphere", "radius": 1 }, "pose": pose, "maxDist": 1 } })),
    ];
    let mut w = walls(UpAxis::Y);
    for (name, value) in rows {
        let before = (observe(&w), w.stats());
        assert_eq!(w.query_json(&value).map_err(|f| f.code), Err(PhysicsError::BadCommand), "{name}");
        assert_eq!(Query::from_json(&value).map_err(|f| f.code), Err(PhysicsError::BadCommand), "{name}");
        assert_eq!((observe(&w), w.stats()), before, "{name}: changed something");
    }
}

/// A settled heap of 30 boxes and balls, built the same way every time.
fn settled_heap() -> World {
    let mut w = world(UpAxis::Y);
    w.spawn(&body("ground", BodyType::Fixed, [0.0, -0.5, 0.0], Shape::Box { half: [20.0, 0.5, 20.0] })).expect("ground");
    for i in 0..30 {
        let p = [(i % 4) as f64 * 0.6 - 0.9, 0.5 + (i / 4) as f64 * 0.7, (i % 3) as f64 * 0.5 - 0.5];
        let shape = if i % 2 == 0 { ball(0.3) } else { cube(0.3) };
        w.spawn(&body(&format!("p{i:02}"), BodyType::Dynamic, p, shape)).expect("piece");
    }
    for _ in 0..90 {
        w.step().expect("steps");
    }
    w
}

#[test]
fn queries_into_a_heap_repeat_exactly() {
    let (mut one, mut two) = (settled_heap(), settled_heap());
    for i in 0..20 {
        let angle = f64::from(i) * 0.3;
        let origin = [3.0 * angle.cos(), 1.0 + f64::from(i % 5) * 0.4, 3.0 * angle.sin()];
        let dir = [-origin[0], 0.2, -origin[2]];
        assert_eq!(one.ray(origin, dir, 10.0, &all()).expect("ray"), two.ray(origin, dir, 10.0, &all()).expect("ray"));
        let cast = |w: &mut World| w.shape_cast(&ball(0.2), Pose::at(origin), dir, 10.0, &all()).expect("cast");
        assert_eq!(cast(&mut one), cast(&mut two));
        let overlap = |w: &mut World| w.overlap(&cube(0.6), Pose::at([0.0, f64::from(i) * 0.2, 0.0]), &all()).expect("overlap");
        assert_eq!(overlap(&mut one), overlap(&mut two));
        if i % 3 == 0 {
            one.step().expect("steps");
            two.step().expect("steps");
        }
    }
}
