//! The bulk calls, additive to 1.0 (CONTRACT.md §19, pending the owner's sign-off): `import_states`
//! takes `export_changed`'s flat layout and equals `import_body_state` per key in order, atomically
//! (a hostile table that changes nothing); `query_many` equals one `query` per item, its
//! `queriesPerStep` accounting included.

mod common;

use common::{body, busy_world, cube, drive, observe};
use genex_physics::{
    BodyType, ChangedExport, EXPORT_STRIDE, NetBodyState, PhysicsError, Pose, Query, QueryFilter, Shape, UpAxis, World, WorldDesc,
};
use serde_json::json;

const HEAP: usize = 24;
const SOURCE_TICKS: u64 = 40;
const TARGET_TICKS: u64 = 10;
const AFTER_TICKS: u64 = 30;

fn stepped(up: UpAxis, ticks: u64) -> World {
    let mut w = busy_world(up, HEAP);
    for t in 0..ticks {
        drive(&mut w, up, t);
        w.step().expect("steps");
    }
    w
}

/// `export`'s entries for the bodies an import takes (dynamic and kinematic), in its order.
fn importable(w: &World, export: &ChangedExport) -> (Vec<String>, Vec<f32>) {
    let mut keys = Vec::new();
    let mut data = Vec::new();
    for (key, values) in export.keys.iter().zip(export.data.as_chunks::<EXPORT_STRIDE>().0) {
        let body_type = w.body(key).expect("exported bodies exist").body_type;
        if body_type == BodyType::Fixed {
            continue;
        }
        keys.push(key.clone());
        data.extend_from_slice(values);
    }
    (keys, data)
}

/// One entry of the flat layout as the state `import_body_state` takes.
fn state_at(data: &[f32], index: usize) -> NetBodyState {
    let v = |at: usize| f64::from(data[index * EXPORT_STRIDE + at]);
    NetBodyState {
        p: [v(0), v(1), v(2)],
        q: [v(3), v(4), v(5), v(6)],
        v: [v(7), v(8), v(9)],
        w: [v(10), v(11), v(12)],
        sleeping: data[index * EXPORT_STRIDE + 13] == 1.0,
        rest: None,
    }
}

fn import_each(w: &mut World, keys: &[String], data: &[f32]) {
    for (index, key) in keys.iter().enumerate() {
        w.import_body_state(key, &state_at(data, index)).expect("imports");
    }
}

#[test]
fn a_bulk_import_equals_one_import_per_key_in_order_and_steps_on_the_same() {
    for up in [UpAxis::Y, UpAxis::Z] {
        let source = stepped(up, SOURCE_TICKS);
        let (keys, data) = importable(&source, &source.export_changed(0));
        assert!(keys.len() > HEAP, "{up:?}: the heap and the rest are exported");
        let mut each = stepped(up, TARGET_TICKS);
        let mut bulk = stepped(up, TARGET_TICKS);
        import_each(&mut each, &keys, &data);
        bulk.import_states(&keys, &data).expect("imports");
        assert_eq!(bulk.state_hash(), each.state_hash(), "{up:?}");
        assert_eq!(bulk.export_changed(0), each.export_changed(0), "{up:?}: the same changed marks too");
        for t in TARGET_TICKS..TARGET_TICKS + AFTER_TICKS {
            drive(&mut each, up, t);
            drive(&mut bulk, up, t);
            each.step().expect("steps");
            bulk.step().expect("steps");
            assert_eq!(bulk.state_hash(), each.state_hash(), "{up:?}: tick {t}");
        }
    }
}

/// How far renormalising an exported rotation in f32 may move a component: a few ulps of 1.
const RENORMALISED_Q: f64 = 4.0 * f32::EPSILON as f64;

#[test]
fn an_export_imported_in_bulk_reads_back_exactly_but_the_rotation_renormalised_as_one_import_does() {
    let up = UpAxis::Y;
    let source = stepped(up, SOURCE_TICKS);
    let (keys, data) = importable(&source, &source.export_changed(0));
    let mut copy = stepped(up, TARGET_TICKS);
    copy.import_states(&keys, &data).expect("imports");
    for (index, key) in keys.iter().enumerate() {
        let exported = state_at(&data, index);
        let back = copy.export_body_state(key).expect("there");
        assert_eq!((back.p, back.v, back.w, back.sleeping), (exported.p, exported.v, exported.w, exported.sleeping), "{key}");
        let moved = back.q.iter().zip(&exported.q).map(|(a, b)| (a - b).abs()).fold(0.0, f64::max);
        assert!(moved <= RENORMALISED_Q, "{key}: {:?} -> {:?}", exported.q, back.q);
    }
}

#[test]
fn a_duplicate_key_is_imported_twice_in_order_as_two_calls_are() {
    let mut each = stepped(UpAxis::Y, TARGET_TICKS);
    let mut bulk = stepped(UpAxis::Y, TARGET_TICKS);
    let first = NetBodyState { p: [1.0, 4.0, 1.0], q: [0.0, 0.0, 0.0, 1.0], v: [2.0, 0.0, 0.0], w: [0.0; 3], sleeping: false, rest: None };
    let second = NetBodyState { p: [-1.0, 3.0, 2.0], sleeping: true, ..first };
    each.import_body_state("bob", &first).expect("imports");
    each.import_body_state("bob", &second).expect("imports");
    let keys = ["bob", "bob"];
    let data: Vec<f32> = [first, second].iter().flat_map(flat).collect();
    bulk.import_states(&keys, &data).expect("imports");
    assert_eq!(bulk.state_hash(), each.state_hash());
    let without_timer = bulk.export_body_state("bob").map(|net| NetBodyState { rest: None, ..net });
    assert_eq!(without_timer, Some(second), "the last one wins");
}

fn flat(state: &NetBodyState) -> Vec<f32> {
    let values = state.p.iter().chain(&state.q).chain(&state.v).chain(&state.w);
    let mut out: Vec<f32> = values.map(|v| *v as f32).collect();
    out.push(f32::from(u8::from(state.sleeping)));
    out
}

/// A row of the hostile table: the second entry's change, and the refusal (with its index) it gives.
type Spoil = fn(&mut Vec<String>, &mut Vec<f32>);

fn hostile_bulk_imports() -> Vec<(&'static str, Spoil, PhysicsError, Option<usize>)> {
    vec![
        ("a short data", |_, d| d.truncate(d.len() - 1), PhysicsError::BadCommand, None),
        ("a long data", |_, d| d.push(0.0), PhysicsError::BadCommand, None),
        ("a key without data", |k, _| k.push("bob".into()), PhysicsError::BadCommand, None),
        ("a NaN position", |_, d| d[EXPORT_STRIDE] = f32::NAN, PhysicsError::NonFinite, Some(1)),
        ("an infinite spin", |_, d| d[EXPORT_STRIDE + 11] = f32::INFINITY, PhysicsError::NonFinite, Some(1)),
        ("a sleeping of 0.5", |_, d| d[EXPORT_STRIDE + 13] = 0.5, PhysicsError::BadCommand, Some(1)),
        ("a sleeping of NaN", |_, d| d[EXPORT_STRIDE + 13] = f32::NAN, PhysicsError::BadCommand, Some(1)),
        ("a zero rotation", |_, d| d[EXPORT_STRIDE + 3..EXPORT_STRIDE + 7].fill(0.0), PhysicsError::OutOfRange, Some(1)),
        ("past worldExtent", |_, d| d[EXPORT_STRIDE + 1] = 200_000.0, PhysicsError::OutOfRange, Some(1)),
        ("past maxSpeed", |_, d| d[EXPORT_STRIDE + 7] = 1_001.0, PhysicsError::OutOfRange, Some(1)),
        ("a malformed key", |k, _| k[1] = "bad key".into(), PhysicsError::InvalidKey, Some(1)),
        ("an empty key", |k, _| k[1] = String::new(), PhysicsError::InvalidKey, Some(1)),
        ("an unknown key", |k, _| k[1] = "nobody".into(), PhysicsError::UnknownKey, Some(1)),
        ("a fixed body", |k, _| k[1] = "zone".into(), PhysicsError::WrongBodyType, Some(1)),
        ("a static key", |k, _| k[1] = "static:box:0000".into(), PhysicsError::UnknownKey, Some(1)),
    ]
}

#[test]
fn hostile_bulk_imports_are_refused_whole_with_their_index_and_change_nothing() {
    let moved = NetBodyState { p: [2.0, 5.0, 2.0], q: [0.0, 0.0, 0.0, 1.0], v: [0.0; 3], w: [0.0; 3], sleeping: false, rest: None };
    for (name, spoil, code, index) in hostile_bulk_imports() {
        let mut w = stepped(UpAxis::Y, TARGET_TICKS);
        let mut keys = vec!["slide".to_string(), "bob".to_string()];
        let mut data: Vec<f32> = [moved, moved].iter().flat_map(flat).collect();
        spoil(&mut keys, &mut data);
        let before = (observe(&w), w.export_changed(0));
        let refused = w.import_states(&keys, &data).expect_err(name);
        assert_eq!((refused.code, refused.index), (code, index), "{name}");
        assert_eq!((observe(&w), w.export_changed(0)), before, "{name}: the valid first entry was not applied either");
        w.check().expect("a refusal never poisons the world");
    }
}

#[test]
fn an_empty_bulk_import_is_accepted_and_changes_nothing() {
    let mut w = stepped(UpAxis::Y, TARGET_TICKS);
    let before = observe(&w);
    w.import_states::<&str>(&[], &[]).expect("nothing to import");
    assert_eq!(observe(&w), before);
}

fn limited(queries: f64) -> World {
    let mut desc = WorldDesc::new(1.0 / 60.0, 1.0, [0.0, -9.81, 0.0], UpAxis::Y, 1.0);
    desc.limits.queries_per_step = Some(queries);
    let mut w = World::create(&desc).expect("valid");
    let wall = body("wall", BodyType::Fixed, [5.0, 0.0, 0.0], cube(1.0));
    w.spawn(&wall).expect("wall");
    w
}

fn mixed_queries() -> serde_json::Value {
    json!([
        { "ray": { "origin": [0, 0, 0], "dir": [1, 0, 0], "maxDist": 10 } },
        { "ray": { "origin": [0, 0, 0], "dir": [0, 0, 0], "maxDist": 10 } },
        { "cone": {} },
        { "overlap": { "shape": { "kind": "sphere", "radius": 1 }, "pose": { "p": [5, 0, 0], "q": [0, 0, 0, 1] } } },
        { "shapeCast": {
            "shape": { "kind": "sphere", "radius": 0.1 },
            "pose": { "p": [0, 0, 0], "q": [0, 0, 0, 1] },
            "dir": [1, 0, 0],
            "maxDist": 10,
        } },
        { "ray": { "origin": [0, 0, 0], "dir": [1, 0, 0], "maxDist": 10 } },
        { "ray": { "origin": [0, 0, 0], "dir": [-1, 0, 0], "maxDist": 10 } },
    ])
}

#[test]
fn query_many_equals_one_query_per_item_with_the_same_limit_accounting() {
    let queries = mixed_queries();
    let mut single = limited(3.0);
    let mut many = limited(3.0);
    let one_by_one: Vec<_> = queries.as_array().expect("a list").iter().map(|query| single.query_json(query)).collect();
    let together = many.query_many_json(&queries).expect("a list");
    assert_eq!(together, one_by_one);
    let codes: Vec<_> = together.iter().map(|outcome| outcome.as_ref().err().map(|failure| failure.code)).collect();
    let refused = |code| Some(code);
    assert_eq!(
        codes,
        [
            None,
            refused(PhysicsError::OutOfRange),
            refused(PhysicsError::BadCommand),
            None,
            None,
            refused(PhysicsError::LimitQueries),
            refused(PhysicsError::LimitQueries),
        ],
        "a refused query is not counted; the fourth success is past the limit"
    );
    assert_eq!((many.stats().queries_this_step, single.stats().queries_this_step), (3, 3));
    assert_eq!(many.state_hash(), single.state_hash());
}

#[test]
fn query_many_over_query_values_matches_its_json_form() {
    let mut by_value = limited(64.0);
    let mut by_json = limited(64.0);
    let ray = Query::Ray { origin: [0.0; 3], dir: [1.0, 0.0, 0.0], max_dist: 10.0, filter: QueryFilter::default() };
    let overlap = Query::Overlap { shape: Shape::Sphere { radius: 1.0 }, pose: Pose::at([5.0, 0.0, 0.0]), filter: QueryFilter::default() };
    let values = by_value.query_many(&[ray.clone(), overlap]).expect("answers");
    let json = by_json
        .query_many_json(&json!([
            { "ray": { "origin": [0, 0, 0], "dir": [1, 0, 0], "maxDist": 10 } },
            { "overlap": { "shape": { "kind": "sphere", "radius": 1 }, "pose": { "p": [5, 0, 0], "q": [0, 0, 0, 1] } } },
        ]))
        .expect("answers");
    assert_eq!(values, json);
    assert_eq!(by_value.query_many(&[]).expect("an empty list"), vec![]);
}

#[test]
fn query_many_of_something_not_a_list_is_bad_command_and_counts_nothing() {
    let mut w = limited(3.0);
    for hostile in [json!({ "ray": {} }), json!("ray"), json!(null), json!(3)] {
        let refused = w.query_many_json(&hostile).expect_err("not a list");
        assert_eq!(refused.code, PhysicsError::BadCommand, "{hostile}");
    }
    assert_eq!(w.stats().queries_this_step, 0);
}
