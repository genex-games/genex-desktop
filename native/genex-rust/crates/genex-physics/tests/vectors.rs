//! Conformance vectors (§16): the runner, and the required 1.0 scenes pinned on this build in
//! `vectors/*.json` beside this crate.
//!
//! A vector is the JSON file §16 shows. Each step entry runs, in order: `snapshotRestore` (the
//! world snapshotted and restored into a fresh world), `apply` (in the file's `mode`), `query`, then
//! `step()` `repeat` times (default 1; 0 runs no step, so a hostile entry can expect the hash it
//! left unchanged), then checks `expect` after the last step: `stateHash`, `events` (a count or the
//! full list, of the last step), `refused` (`[[index, code], …]` from `apply`), `queries` (each
//! answer in the binding's form, `{ hit }` or `{ keys }`), `escaped` and `physicsHash`. The first
//! mismatch names the step and the field, and prints the world's full `bodies()` dump.
//!
//! The pins are this build's. `GENEX_PHYSICS_WRITE_VECTORS=1 cargo test --test vectors -- --ignored
//! write_vectors` rewrites them from the scenes below; a rewritten pin is a determinism change to
//! explain in the commit. The worst-case scene (§11.2) is a measurement: `tests/bench.rs`.

use std::path::PathBuf;

use genex_physics::{
    BodyFilter, PhysicsError, PhysicsEvent, PhysicsFailure, QueryAnswer, StaticWorld, StepResult, World, WorldDesc,
    build_id, build_id_without_target,
};
use serde_json::{Map, Value, json};

const VECTOR_CONTRACT: &str = "1.0";

/// The codes no §16 operation can give, so no vector shows them: a vector's `static` is imported
/// when the world opens (a refused one is no scene at all, and its codes are §6.5's), `world.contract`
/// is the file's own, `snapshotRestore` restores this world's own snapshot (never foreign bytes), and
/// `internal` is a core failure. `tests/static_world.rs`, `world_desc.rs`, `snapshot.rs` and
/// `hostile.rs` hold each one's rows.
const UNREACHABLE_BY_VECTOR_OPERATIONS: [PhysicsError; 5] =
    [PhysicsError::LimitStatic, PhysicsError::BadSnapshot, PhysicsError::BuildMismatch, PhysicsError::ContractMismatch, PhysicsError::Internal];

fn vectors_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("vectors")
}

/// Every pinned vector: the `.json` files of `vectors/`, sorted (the README beside them is not one).
fn vector_files() -> Vec<PathBuf> {
    let entries = std::fs::read_dir(vectors_dir()).expect("vectors/");
    let mut files: Vec<PathBuf> = entries.filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.extension().is_some_and(|x| x == "json")).collect();
    files.sort();
    files
}

// ---------------------------------------------------------------------------------------------
// The runner.

/// What one step entry produced, in the vector's JSON forms.
#[derive(Default)]
struct Observed {
    refused: Vec<Value>,
    queries: Vec<Value>,
    last: Option<StepResult>,
}

/// `value` with every non-integer number rounded to f32. Vector numbers are f32 values (§16), and
/// serde_json's default parser may land one f64 ulp off the written decimal, which this undoes.
fn as_f32(value: &Value) -> Value {
    match value {
        Value::Number(n) if n.is_f64() => n.as_f64().map_or(Value::Null, |x| json!(f64::from(x as f32))),
        Value::Array(items) => Value::Array(items.iter().map(as_f32).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), as_f32(v))).collect()),
        other => other.clone(),
    }
}

fn f32_number(x: f64) -> Value {
    json!(f64::from(x as f32))
}

fn vec_json(v: [f64; 3]) -> Value {
    Value::Array(v.iter().map(|x| f32_number(*x)).collect())
}

/// The kind tags an event carries, under their names, when set.
fn put_kinds(out: &mut Map<String, Value>, tags: [(&str, &Option<String>); 2]) {
    for (key, kind) in tags {
        if let Some(kind) = kind {
            out.insert(key.to_string(), json!(kind));
        }
    }
}

fn event_json(event: &PhysicsEvent) -> Value {
    let mut out = Map::new();
    match event {
        PhysicsEvent::ContactBegin { a, b, ca, cb, ka, kb, impulse, point, normal } => {
            out.extend([("kind", json!("contactBegin")), ("a", json!(a)), ("b", json!(b)), ("ca", json!(ca)), ("cb", json!(cb))].map(|(k, v)| (k.to_string(), v)));
            put_kinds(&mut out, [("ka", ka), ("kb", kb)]);
            out.extend([("impulse", f32_number(*impulse)), ("point", vec_json(*point)), ("normal", vec_json(*normal))].map(|(k, v)| (k.to_string(), v)));
        }
        PhysicsEvent::ContactEnd { a, b, ca, cb, ka, kb } => {
            out.extend([("kind", json!("contactEnd")), ("a", json!(a)), ("b", json!(b)), ("ca", json!(ca)), ("cb", json!(cb))].map(|(k, v)| (k.to_string(), v)));
            put_kinds(&mut out, [("ka", ka), ("kb", kb)]);
        }
        PhysicsEvent::TriggerEnter { sensor, sc, other, oc, ks, ko } | PhysicsEvent::TriggerExit { sensor, sc, other, oc, ks, ko } => {
            let kind = if matches!(event, PhysicsEvent::TriggerEnter { .. }) { "triggerEnter" } else { "triggerExit" };
            out.extend([("kind", json!(kind)), ("sensor", json!(sensor)), ("sc", json!(sc)), ("other", json!(other)), ("oc", json!(oc))].map(|(k, v)| (k.to_string(), v)));
            put_kinds(&mut out, [("ks", ks), ("ko", ko)]);
        }
    }
    Value::Object(out)
}

fn answer_json(answer: Result<QueryAnswer, PhysicsFailure>) -> Value {
    match answer {
        Err(failure) => json!({ "error": failure.code.code() }),
        Ok(QueryAnswer::Keys(keys)) => json!({ "keys": keys }),
        Ok(QueryAnswer::Hit(None)) => json!({ "hit": null }),
        Ok(QueryAnswer::Hit(Some(hit))) => json!({ "hit": {
            "body": hit.body, "collider": hit.collider, "dist": f32_number(hit.dist),
            "point": vec_json(hit.point), "normal": vec_json(hit.normal),
        } }),
    }
}

fn static_world(value: &Value) -> StaticWorld {
    let rows = |key: &str| -> Vec<Vec<f64>> {
        let rows = value.get(key).and_then(Value::as_array).cloned().unwrap_or_default();
        rows.iter().map(|row| row.as_array().map(|r| r.iter().filter_map(Value::as_f64).collect()).unwrap_or_default()).collect()
    };
    StaticWorld { boxes: rows("boxes"), ramps: rows("ramps") }
}

fn open_world(vector: &Value) -> Result<World, String> {
    let desc = WorldDesc::from_json(&vector["world"]).map_err(|f| format!("world: {f:?}"))?;
    let mut w = World::create(&desc).map_err(|f| format!("world: {f:?}"))?;
    let world = static_world(&vector["static"]);
    if !(world.boxes.is_empty() && world.ramps.is_empty()) {
        w.add_static_world(&world).map_err(|f| format!("static: {f:?}"))?;
    }
    Ok(w)
}

fn apply(w: &mut World, commands: &Value, atomic: bool) -> Vec<Value> {
    if atomic {
        return match w.apply_json_atomic(commands) {
            Ok(()) => Vec::new(),
            Err(failure) => vec![json!([failure.index, failure.code.code()])],
        };
    }
    match w.apply_json_each(commands) {
        Err(failure) => vec![json!([null, failure.code.code()])],
        Ok(outcomes) => {
            let refused = outcomes.into_iter().enumerate().filter_map(|(index, outcome)| outcome.err().map(|code| (index, code)));
            refused.map(|(index, code)| json!([index, code.code()])).collect()
        }
    }
}

/// Runs one step entry on `w` (which a snapshotRestore may replace).
fn run_entry(w: &mut World, vector: &Value, entry: &Value, atomic: bool) -> Result<Observed, String> {
    if entry.get("snapshotRestore").and_then(Value::as_bool) == Some(true) {
        let bytes = w.snapshot().map_err(|f| format!("snapshot: {f:?}"))?;
        let mut fresh = open_world(vector)?;
        fresh.restore(&bytes).map_err(|f| format!("restore: {f:?}"))?;
        *w = fresh;
    }
    let mut observed = Observed::default();
    if let Some(commands) = entry.get("apply") {
        observed.refused = apply(w, commands, atomic);
    }
    for query in entry.get("query").and_then(Value::as_array).into_iter().flatten() {
        observed.queries.push(answer_json(w.query_json(query)));
    }
    let repeat = entry.get("repeat").and_then(Value::as_u64).unwrap_or(1);
    for _ in 0..repeat {
        observed.last = Some(w.step().map_err(|f| format!("step: {f:?}"))?);
    }
    Ok(observed)
}

/// The value of one expected field, as this world gives it.
fn actual(w: &World, observed: &Observed, field: &str, expected: &Value) -> Value {
    let last = observed.last.as_ref();
    match field {
        "stateHash" => json!(w.state_hash_hex()),
        "physicsHash" => json!(w.physics_hash()),
        "refused" => Value::Array(observed.refused.clone()),
        "queries" => Value::Array(observed.queries.clone()),
        "escaped" => json!(last.map(|r| r.escaped.clone()).unwrap_or_default()),
        "events" if expected.is_number() => json!(last.map_or(0, |r| r.events.len())),
        "events" => Value::Array(last.map(|r| r.events.iter().map(event_json).collect()).unwrap_or_default()),
        _ => json!(format!("unknown expect field {field}")),
    }
}

/// Runs `vector`, which must be pinned on this build (`build`, the buildId without its target, §2).
/// With `record`, every expected value is replaced by what this build gives and
/// the recorded vector is returned; without, the first mismatch is an error naming its step.
fn run_vector(vector: &Value, record: bool) -> Result<Value, String> {
    let ours = build_id_without_target();
    if !record && vector.get("build").and_then(Value::as_str) != Some(ours.as_str()) {
        return Err(format!("build: the vector is pinned on {}, this core is {ours}; vectors are per build (§16)", vector["build"]));
    }
    let atomic = vector.get("mode").and_then(Value::as_str) == Some("atomic");
    let mut w = open_world(vector)?;
    let mut recorded = vector.clone();
    let entries = vector["steps"].as_array().ok_or("no steps")?;
    for (index, entry) in entries.iter().enumerate() {
        let observed = run_entry(&mut w, vector, entry, atomic).map_err(|e| format!("step {index}: {e}"))?;
        let Some(expect) = entry.get("expect").and_then(Value::as_object) else { continue };
        for (field, expected) in expect {
            let got = actual(&w, &observed, field, expected);
            if record {
                recorded["steps"][index]["expect"][field] = got;
            } else if as_f32(&got) != as_f32(expected) {
                let dump = w.bodies(&BodyFilter::default());
                return Err(format!("step {index}: {field} expected {expected} got {got}; bodies: {dump:?}"));
            }
        }
    }
    Ok(recorded)
}

// ---------------------------------------------------------------------------------------------
// The scenes.

fn world(dt: f64, substeps: u32, gravity: [f64; 3], up: &str, length_unit: f64) -> Value {
    json!({ "contract": "1.0", "dt": f32_number(dt), "substeps": substeps, "gravity": vec_json(gravity), "upAxis": up, "lengthUnit": f32_number(length_unit) })
}

fn pose(p: [f64; 3]) -> Value {
    json!({ "p": vec_json(p), "q": [0, 0, 0, 1] })
}

fn cuboid(half: [f64; 3]) -> Value {
    json!({ "kind": "box", "half": vec_json(half) })
}

fn sphere(radius: f64) -> Value {
    json!({ "kind": "sphere", "radius": f32_number(radius) })
}

/// A body of one collider `c`; `extra` adds body fields, `collider` collider fields.
fn spawn(key: &str, body_type: &str, p: [f64; 3], shape: Value, extra: Value, collider: Value) -> Value {
    let mut c = json!({ "key": "c", "shape": shape });
    merge(&mut c, collider);
    let mut desc = json!({ "key": key, "type": body_type, "pose": pose(p), "colliders": [c] });
    merge(&mut desc, extra);
    json!({ "spawn": desc })
}

fn merge(into: &mut Value, extra: Value) {
    if let (Some(into), Value::Object(extra)) = (into.as_object_mut(), extra) {
        into.extend(extra);
    }
}

fn none() -> Value {
    json!({})
}

fn vector(name: &str, world: Value, statics: Value, mode: &str, steps: Vec<Value>) -> Value {
    json!({ "contract": VECTOR_CONTRACT, "build": build_id_without_target(), "name": name, "world": world, "static": statics, "mode": mode, "steps": steps })
}

fn no_static() -> Value {
    json!({ "boxes": [], "ramps": [] })
}

fn hash() -> Value {
    json!({ "stateHash": null })
}

fn z_floor() -> Value {
    json!({ "boxes": [[-50, -50, -1, 50, 50, 0]], "ramps": [] })
}

fn spread_kicked_props() -> Value {
    let props: Vec<Value> = (0..24)
        .map(|i| {
            let p = [f64::from(i % 6) * 2.0 - 5.0, f64::from(i / 6) * 2.0 - 3.0, 0.6];
            let shape = if i % 2 == 0 { cuboid([0.4, 0.4, 0.4]) } else { sphere(0.45) };
            spawn(&format!("prop.{i:02}"), "dynamic", p, shape, json!({ "kind": "prop" }), none())
        })
        .collect();
    let kicks: Vec<Value> = (0..24).step_by(3).map(|i| json!({ "impulse": { "key": format!("prop.{i:02}"), "j": vec_json([3.0, -2.0, 4.0]), "at": vec_json([0.0, 0.0, 0.8]) } })).collect();
    let steps = vec![
        json!({ "apply": props, "repeat": 30, "expect": hash() }),
        json!({ "apply": kicks, "repeat": 90, "expect": { "stateHash": null, "events": null } }),
    ];
    vector("spread-kicked-props", world(1.0 / 60.0, 1, [0.0, 0.0, -9.81], "z", 1.0), z_floor(), "each", steps)
}

fn player_pose(i: u32, t: u32) -> [f64; 3] {
    let angle = f64::from(i) * 0.6283;
    let r = 260.0 - 4.0 * f64::from(t);
    [r * series_cos(angle), r * series_sin(angle), 36.0]
}

/// cos and sin by a short series, so a vector writer's numbers never depend on a platform's libm.
fn series_cos(x: f64) -> f64 {
    (0..12).fold((0.0, 1.0), |(sum, term), n| (sum + term, -term * x * x / f64::from((2 * n + 1) * (2 * n + 2)))).0
}

fn series_sin(x: f64) -> f64 {
    (0..12).fold((0.0, x), |(sum, term), n| (sum + term, -term * x * x / f64::from((2 * n + 2) * (2 * n + 3)))).0
}

fn pile_10_players_30hz() -> Value {
    let mut setup = Vec::new();
    for pile in 0..4 {
        for level in 0..6 {
            let p = [f64::from(pile) * 60.0 - 90.0, 0.0, 12.0 + 24.5 * f64::from(level)];
            setup.push(spawn(&format!("crate.{pile}.{level}"), "dynamic", p, cuboid([12.0, 12.0, 12.0]), json!({ "kind": "crate" }), none()));
        }
    }
    let capsule = json!({ "kind": "capsule", "halfHeight": 20, "radius": 16, "axis": "z" });
    for i in 0..10 {
        setup.push(spawn(&format!("player.{i}"), "kinematic", player_pose(i, 0), capsule.clone(), json!({ "kind": "player" }), json!({ "events": true })));
    }
    let mut steps = vec![json!({ "apply": setup, "repeat": 10, "expect": hash() })];
    for t in 1..=45 {
        let moves: Vec<Value> = (0..10).map(|i| json!({ "setNextKinematicPose": { "key": format!("player.{i}"), "pose": pose(player_pose(i, t)) } })).collect();
        let mut entry = json!({ "apply": moves });
        if t % 15 == 0 {
            entry["expect"] = json!({ "stateHash": null, "events": null });
        }
        steps.push(entry);
    }
    let statics = json!({ "boxes": [[-2000, -2000, -50, 2000, 2000, 0]], "ramps": [] });
    vector("pile-10-players-30hz", world(1.0 / 30.0, 2, [0.0, 0.0, -800.0], "z", 39.37), statics, "each", steps)
}

fn heap_shape(i: u32) -> Value {
    match i % 4 {
        0 => cuboid([0.4, 0.4, 0.4]),
        1 => sphere(0.4),
        2 => json!({ "kind": "hull", "points": (0..8).map(|k| vec_json([if k & 1 == 0 { -0.38 } else { 0.38 }, if k & 2 == 0 { -0.35 } else { 0.35 }, if k & 4 == 0 { -0.32 } else { 0.32 }])).collect::<Vec<_>>() }),
        _ => json!({ "kind": "capsule", "halfHeight": 0.25, "radius": 0.3, "axis": "x" }),
    }
}

fn dense_heap() -> Value {
    let mut setup = vec![spawn("floor", "fixed", [0.0, -1.0, 0.0], cuboid([20.0, 1.0, 20.0]), none(), none())];
    for i in 0..96 {
        let (x, z, layer) = (f64::from(i % 6), f64::from((i / 6) % 6), f64::from(i / 36));
        let p = [(x - 2.5) * 0.85 + layer * 0.07, 0.6 + layer * 0.85, (z - 2.5) * 0.85 - layer * 0.05];
        setup.push(spawn(&format!("heap.{i:03}"), "dynamic", p, heap_shape(i), none(), json!({ "events": i % 5 == 0 })));
    }
    let steps = vec![json!({ "apply": setup, "repeat": 60, "expect": hash() }), json!({ "repeat": 90, "expect": { "stateHash": null, "events": null } })];
    vector("dense-heap", world(1.0 / 60.0, 1, [0.0, -9.81, 0.0], "y", 1.0), no_static(), "each", steps)
}

fn motorised_doors_32() -> Value {
    let mut setup = Vec::new();
    for i in 0..32 {
        let x = f64::from(i % 8) * 3.0;
        let z = f64::from(i / 8) * 3.0;
        setup.push(spawn(&format!("door.{i:02}"), "dynamic", [x, 1.5, z], cuboid([0.6, 1.0, 0.05]), json!({ "kind": "door" }), none()));
        let vel = if i % 2 == 0 { 1.5 } else { -1.5 };
        setup.push(json!({ "addJoint": {
            "key": format!("hinge.{i:02}"), "a": format!("door.{i:02}"), "b": null, "type": "hinge",
            "anchorA": vec_json([-0.6, 0.0, 0.0]), "anchorB": vec_json([x - 0.6, 1.5, z]), "axis": [0, 1, 0],
            "limits": [-1.5, 1.5], "motor": { "targetVel": f32_number(vel), "damping": 10, "maxForce": 200 },
        } }));
    }
    let close: Vec<Value> = (0..32).map(|i| json!({ "setMotor": { "key": format!("hinge.{i:02}"), "motor": { "targetPos": 0, "stiffness": 50, "damping": 5 } } })).collect();
    let steps = vec![
        json!({ "apply": setup, "repeat": 120, "expect": hash() }),
        json!({ "apply": close, "repeat": 120, "expect": hash() }),
    ];
    vector("motorised-doors-32", world(1.0 / 60.0, 1, [0.0, -9.81, 0.0], "y", 1.0), no_static(), "each", steps)
}

/// The firstperson preset's `dressed` world (§17.7), verbatim from genex-demo's
/// `packages/netcode-bench/conformance/authority/presets/firstperson.json` (`worlds`, name `dressed`,
/// §17.7 hash 1340734173): a floor, a wall, two stairs, a crate, a floating slab, a platform and
/// three ramps on both axes, in inches, z-up.
fn firstperson_dressed_world() -> Value {
    json!({
        "boxes": [[-4096, -4096, -64, 4096, 4096, 0], [200, -300, 0, 260, 300, 120], [-400, 150, 0, -150, 210, 16], [-400, 210, 0, -150, 270, 32], [-420, -420, 0, -300, -300, 40], [-60, -60, 100, 60, 60, 110], [500, -50, 0, 900, 50, 64]],
        "ramps": [[-100, -500, 0, 100, -300, 64, 1, 0, 64], [260, 300, 0, 500, 400, 48, 0, 48, 0], [-300, 300, 0, -200, 500, 200, 1, 0, 200]],
    })
}

/// The preset player walking +x along y = 0 under the slab, kicking the ball in its path.
const FIRSTPERSON_WALK_STEPS: u32 = 40;
const FIRSTPERSON_WALK_INCHES: f64 = 20.0;

fn firstperson_static_inches() -> Value {
    // A ball over every kind of piece: both stairs, the crate, the slab, the platform, the wall's
    // top, each ramp, and one on the floor in the player's path.
    let drops = [(-275.0, 180.0), (-275.0, 240.0), (-360.0, -360.0), (0.0, 0.0), (700.0, 0.0), (230.0, 0.0), (0.0, -400.0), (380.0, 350.0), (-250.0, 400.0), (-300.0, 0.0)];
    let mut setup = Vec::new();
    for (i, (x, y)) in drops.into_iter().enumerate() {
        setup.push(spawn(&format!("ball.{i}"), "dynamic", [x, y, 320.0], sphere(8.0), json!({ "kind": "prop" }), json!({ "events": true })));
    }
    setup.push(spawn("player", "kinematic", [-700.0, 0.0, 36.0], json!({ "kind": "capsule", "halfHeight": 20, "radius": 16, "axis": "z" }), json!({ "kind": "player" }), json!({ "events": true })));
    let mut steps = vec![json!({ "apply": setup, "repeat": 60, "expect": { "stateHash": null, "events": null } })];
    for t in 1..=FIRSTPERSON_WALK_STEPS {
        let walk = json!([{ "setNextKinematicPose": { "key": "player", "pose": pose([-700.0 + FIRSTPERSON_WALK_INCHES * f64::from(t), 0.0, 36.0]) } }]);
        let mut entry = json!({ "apply": walk });
        if t % 10 == 0 {
            entry["expect"] = json!({ "stateHash": null, "events": null });
        }
        steps.push(entry);
    }
    steps.push(json!({ "repeat": 30, "expect": { "stateHash": null, "physicsHash": null } }));
    steps.push(json!({ "query": [
        { "ray": { "origin": vec_json([0.0, 0.0, 400.0]), "dir": [0, 0, -1], "maxDist": 1000 } },
        { "ray": { "origin": vec_json([800.0, 0.0, 400.0]), "dir": [0, 0, -1], "maxDist": 1000 } },
        { "ray": { "origin": vec_json([-800.0, 0.0, 36.0]), "dir": [1, 0, 0], "maxDist": 2000, "filter": { "excludeBodies": ["player"] } } },
        { "overlap": { "shape": sphere(40.0), "pose": pose([380.0, 350.0, 40.0]) } },
        { "shapeCast": { "shape": sphere(16.0), "pose": pose([-275.0, 240.0, 200.0]), "dir": [0, 0, -1], "maxDist": 400 } },
    ], "repeat": 0, "expect": { "queries": null } }));
    vector("firstperson-static-inches", world(1.0 / 30.0, 2, [0.0, 0.0, -800.0], "z", 39.37), firstperson_dressed_world(), "each", steps)
}

fn vehicle_hull_pushing_props() -> Value {
    let corners: Vec<Value> = (0..8)
        .map(|k| vec_json([if k & 1 == 0 { -150.0 } else { 150.0 }, if k & 2 == 0 { -75.0 } else { 75.0 }, if k & 4 == 0 { -40.0 } else if k & 1 == 0 { 20.0 } else { 40.0 }]))
        .collect();
    let mut setup = vec![spawn("car", "dynamic", [0.0, 0.0, 45.0], json!({ "kind": "hull", "points": corners }), json!({ "kind": "vehicle" }), json!({ "events": true, "density": 0.0002 }))];
    for i in 0..12 {
        let p = [400.0 + f64::from(i / 3) * 60.0, f64::from(i % 3) * 60.0 - 60.0, 25.0];
        setup.push(spawn(&format!("prop.{i:02}"), "dynamic", p, cuboid([25.0, 25.0, 25.0]), json!({ "kind": "prop" }), json!({ "density": 0.0001 })));
    }
    let mut steps = vec![json!({ "apply": setup, "repeat": 20, "expect": hash() })];
    for _ in 0..6 {
        steps.push(json!({ "apply": [{ "setVelocity": { "key": "car", "linvel": [900, 0, 0] } }], "repeat": 10, "expect": { "stateHash": null, "events": null } }));
    }
    let statics = json!({ "boxes": [[-5000, -5000, -100, 5000, 5000, 0]], "ramps": [] });
    vector("vehicle-hull-pushing-props", world(1.0 / 60.0, 1, [0.0, 0.0, -650.0], "z", 100.0), statics, "each", steps)
}

fn ccd_balls() -> Value {
    let mut setup = vec![spawn("wall", "fixed", [10.0, 0.0, 1.5], cuboid([0.02, 5.0, 1.5]), none(), json!({ "events": true }))];
    for i in 0..8 {
        let p = [0.0, f64::from(i) * 1.0 - 3.5, 1.0];
        setup.push(spawn(&format!("bullet.{i}"), "dynamic", p, sphere(0.05), json!({ "ccd": true, "linvel": vec_json([200.0, 0.0, 0.0]) }), none()));
    }
    let steps = vec![
        json!({ "apply": setup, "repeat": 4, "expect": { "stateHash": null, "events": null } }),
        json!({ "repeat": 30, "expect": hash() }),
    ];
    vector("ccd-balls", world(1.0 / 60.0, 1, [0.0, 0.0, -9.81], "z", 1.0), z_floor(), "each", steps)
}

fn query_and_event_ordering() -> Value {
    let mut setup = vec![spawn("ground", "fixed", [0.0, -0.5, 0.0], cuboid([20.0, 0.5, 20.0]), json!({ "kind": "floor" }), none())];
    for (i, key) in ["b3", "b1", "b2", "a9"].into_iter().enumerate() {
        setup.push(spawn(key, "dynamic", [2.0 * i as f64 - 3.0, 1.0, 0.0], sphere(0.5), json!({ "kind": "ball" }), json!({ "events": true })));
    }
    setup.push(spawn("zone", "fixed", [0.0, 0.5, 4.0], cuboid([2.0, 2.0, 2.0]), none(), json!({ "sensor": true })));
    setup.push(spawn("probe", "kinematic", [0.0, 0.5, 8.0], sphere(0.5), none(), none()));
    let queries = json!([
        { "ray": { "origin": [0, 5, 0], "dir": [0, -1, 0], "maxDist": 10 } },
        { "ray": { "origin": [-6, 0.5, 0], "dir": [1, 0, 0], "maxDist": 20, "filter": { "excludeBodies": ["a9"] } } },
        { "shapeCast": { "shape": sphere(0.25), "pose": pose([-1.0, 5.0, 0.0]), "dir": [0, -1, 0], "maxDist": 10 } },
        { "overlap": { "shape": cuboid([4.0, 1.0, 1.0]), "pose": pose([0.0, 0.5, 0.0]) } },
        { "overlap": { "shape": cuboid([1.0, 1.0, 1.0]), "pose": pose([0.0, 0.5, 4.0]), "filter": { "includeSensors": true } } },
    ]);
    let mut steps = vec![json!({ "apply": setup, "repeat": 0 })];
    for t in 1..=40 {
        let moves = json!([{ "setNextKinematicPose": { "key": "probe", "pose": pose([0.0, 0.5, 8.0 - 0.2 * f64::from(t)]) } }]);
        steps.push(json!({ "apply": moves, "expect": { "events": null } }));
    }
    steps.push(json!({ "query": queries, "repeat": 0, "expect": { "queries": null, "stateHash": null } }));
    vector("query-and-event-ordering", world(1.0 / 60.0, 1, [0.0, -9.81, 0.0], "y", 1.0), no_static(), "each", steps)
}

/// A limited z-up world and its bodies for the hostile and memory scenes.
fn limited_world(memory: Option<u64>) -> Value {
    let mut w = world(1.0 / 30.0, 2, [0.0, 0.0, -9.81], "z", 1.0);
    let mut limits = json!({ "bodies": 5, "collidersPerBody": 2, "hullVertices": 8, "triangles": 4, "joints": 1, "ccdBodies": 0, "queriesPerStep": 2 });
    if let Some(bytes) = memory {
        limits["memoryBytes"] = json!(bytes);
    }
    w["limits"] = limits;
    w
}

fn hostile_setup() -> Vec<Value> {
    vec![
        spawn("d", "dynamic", [0.0, 0.0, 1.0], cuboid([0.5, 0.5, 0.5]), none(), none()),
        spawn("d2", "dynamic", [2.0, 0.0, 1.0], sphere(0.5), none(), none()),
        spawn("f", "fixed", [0.0, 0.0, -1.0], cuboid([10.0, 10.0, 1.0]), none(), none()),
        spawn("k", "kinematic", [4.0, 0.0, 1.0], cuboid([0.5, 0.5, 0.5]), none(), none()),
        json!({ "addJoint": { "key": "j", "a": "d", "b": null, "type": "ball", "anchorA": [0, 0, 0], "anchorB": [0, 0, 1] } }),
    ]
}

/// One command per code a command can give (§16: every error code once).
fn hostile_commands() -> Vec<Value> {
    let tri = json!({ "kind": "trimesh", "vertices": [[0, 0, 0], [1, 0, 0], [0, 1, 0]], "indices": [[0, 1, 2], [0, 1, 2], [0, 1, 2], [0, 1, 2], [0, 1, 2]] });
    let nine: Vec<Value> = (0..9).map(|i| vec_json([f64::from(i % 2), f64::from((i / 2) % 2), f64::from(i / 4) + 0.01 * f64::from(i)])).collect();
    vec![
        json!({ "wake": { "key": "a b" } }),
        spawn("d", "dynamic", [0.0, 0.0, 5.0], cuboid([0.5, 0.5, 0.5]), none(), none()),
        json!({ "wake": { "key": "nope" } }),
        json!({ "impulse": { "key": "d", "j": [1e39, 0, 0] } }),
        json!({ "setPose": { "key": "d", "pose": pose([0.0, 0.0, 1e30]) } }),
        spawn("n", "dynamic", [0.0, 0.0, 5.0], cuboid([0.0, 1.0, 1.0]), none(), none()),
        spawn("n", "dynamic", [0.0, 0.0, 5.0], tri.clone(), none(), none()),
        json!({ "impulse": { "key": "f", "j": [0, 0, 1] } }),
        json!({ "explode": { "key": "d" } }),
        spawn("n", "dynamic", [0.0, 0.0, 5.0], cuboid([0.5, 0.5, 0.5]), json!({ "colliders": [
            { "key": "c1", "shape": sphere(0.1) }, { "key": "c2", "shape": sphere(0.1) }, { "key": "c3", "shape": sphere(0.1) },
        ] }), none()),
        spawn("n", "dynamic", [0.0, 0.0, 5.0], json!({ "kind": "hull", "points": nine }), none(), none()),
        spawn("n", "fixed", [0.0, 0.0, 5.0], tri, none(), none()),
        json!({ "addJoint": { "key": "j2", "a": "d", "b": "d2", "type": "ball", "anchorA": [0, 0, 0], "anchorB": [0, 0, 0] } }),
        spawn("n", "dynamic", [0.0, 0.0, 5.0], cuboid([0.5, 0.5, 0.5]), json!({ "ccd": true }), none()),
    ]
}

/// A spawn that fits (the fifth body, at `limits.bodies`).
fn fifth_body(key: &str) -> Value {
    spawn(key, "dynamic", [0.0, 3.0, 5.0], cuboid([0.5, 0.5, 0.5]), none(), none())
}

fn hostile(mode: &str) -> Value {
    let mut steps = vec![json!({ "apply": hostile_setup(), "repeat": 5, "expect": hash() })];
    match mode {
        "atomic" => steps.extend(hostile_commands().into_iter().map(|c| json!({ "apply": [c], "repeat": 0, "expect": { "refused": null, "stateHash": null } }))),
        _ => steps.push(json!({ "apply": hostile_commands(), "repeat": 0, "expect": { "refused": null, "stateHash": null } })),
    }
    steps.push(json!({ "apply": [fifth_body("n1")], "repeat": 0, "expect": hash() }));
    steps.push(json!({ "apply": [fifth_body("n2")], "repeat": 0, "expect": { "refused": null, "stateHash": null } }));
    let rays = |n: usize| -> Vec<Value> { (0..n).map(|_| json!({ "ray": { "origin": [0, 0, 9], "dir": [0, 0, -1], "maxDist": 20 } })).collect() };
    steps.push(json!({ "query": rays(3), "repeat": 0, "expect": { "queries": null, "stateHash": null } }));
    steps.push(json!({ "repeat": 1, "expect": hash() }));
    vector(&format!("hostile-commands-{mode}"), limited_world(None), no_static(), mode, steps)
}

fn memory_limit() -> Value {
    let spawns: Vec<Value> = (0..8).map(|i| spawn(&format!("m{i}"), "dynamic", [2.0 * f64::from(i), 0.0, 1.0], sphere(0.5), none(), none())).collect();
    let steps = vec![
        json!({ "apply": [], "repeat": 0, "expect": hash() }),
        json!({ "apply": spawns, "repeat": 0, "expect": { "refused": null, "stateHash": null } }),
        json!({ "repeat": 10, "expect": hash() }),
    ];
    let bytes = genex_physics::memory::WORLD_BASE_BYTES + 3 * (genex_physics::memory::BODY_BYTES + genex_physics::memory::COLLIDER_BYTES + 3) + 100;
    let mut w = world(1.0 / 60.0, 1, [0.0, 0.0, -9.81], "z", 1.0);
    w["limits"] = json!({ "memoryBytes": bytes });
    vector("memory-limit", w, no_static(), "each", steps)
}

fn escaped_bodies() -> Value {
    let mut w = world(1.0 / 60.0, 1, [0.0, 0.0, -9.81], "z", 1.0);
    w["limits"] = json!({ "worldExtent": 50 });
    let setup = vec![
        spawn("rocket", "dynamic", [0.0, 0.0, 1.0], sphere(0.5), json!({ "linvel": [0, 0, 300] }), none()),
        spawn("stay", "dynamic", [5.0, 0.0, 0.5], sphere(0.5), none(), none()),
    ];
    let mut steps = vec![json!({ "apply": setup, "repeat": 0 })];
    for _ in 0..12 {
        steps.push(json!({ "expect": { "escaped": null, "stateHash": null } }));
    }
    vector("escaped-bodies", w, z_floor(), "each", steps)
}

fn snapshot_round_trip() -> Value {
    let mut setup = Vec::new();
    for i in 0..16 {
        setup.push(spawn(&format!("heap.{i:02}"), "dynamic", [f64::from(i % 4) * 0.9 - 1.35, 0.5 + f64::from(i / 4) * 0.9, 0.0], heap_shape(i), none(), json!({ "events": i % 3 == 0 })));
    }
    setup.push(spawn("floor", "fixed", [0.0, -1.0, 0.0], cuboid([10.0, 1.0, 10.0]), none(), none()));
    let joint = json!({ "addJoint": { "key": "j.late", "a": "heap.00", "b": "heap.05", "type": "ball", "anchorA": [0, 0, 0], "anchorB": [0, 0, 0] } });
    let steps = vec![
        json!({ "apply": setup, "repeat": 40, "expect": hash() }),
        json!({ "apply": [joint, { "impulse": { "key": "heap.03", "j": [2, 3, 0] } }], "repeat": 0 }),
        json!({ "snapshotRestore": true, "repeat": 60, "expect": { "stateHash": null, "events": null } }),
        json!({ "snapshotRestore": true, "apply": [{ "removeJoint": { "key": "j.late" } }], "repeat": 60, "expect": hash() }),
    ];
    vector("snapshot-round-trip", world(1.0 / 60.0, 1, [0.0, -9.81, 0.0], "y", 1.0), no_static(), "each", steps)
}

fn key_at_64_bytes() -> Value {
    let key = "k".repeat(62) + ".1";
    let steps = vec![
        json!({ "apply": [spawn(&key, "dynamic", [0.0, 0.0, 2.0], sphere(0.5), json!({ "kind": "k".repeat(32) }), json!({ "events": true }))], "repeat": 60, "expect": { "stateHash": null, "events": null } }),
    ];
    vector("key-64-bytes", world(1.0 / 60.0, 1, [0.0, 0.0, -9.81], "z", 1.0), z_floor(), "each", steps)
}

fn full_17_7_world() -> Value {
    let boxes: Vec<Value> = (0..4096)
        .map(|i| {
            let (x, y) = (f64::from(i % 64) * 16.0 - 512.0, f64::from(i / 64) * 16.0 - 512.0);
            let h = f64::from(1 + (i * 7) % 5) * 2.0;
            json!([x, y, 0, x + 12.0, y + 12.0, h])
        })
        .collect();
    let ramps: Vec<Value> = (0..512)
        .map(|i| {
            let (x, y) = (f64::from(i % 32) * 32.0 - 512.0, f64::from(i / 32) * 32.0 + 600.0);
            let axis = i % 2;
            let (lo, hi) = if i % 3 == 0 { (8.0, 0.0) } else { (0.0, 8.0) };
            json!([x, y, 0, x + 24.0, y + 24.0, 8, axis, lo, hi])
        })
        .collect();
    let statics = json!({ "boxes": boxes, "ramps": ramps });
    let balls: Vec<Value> = (0..16)
        .map(|i| spawn(&format!("ball.{i:02}"), "dynamic", [f64::from(i) * 60.0 - 480.0, f64::from(i % 4) * 300.0 - 300.0, 40.0], sphere(2.0), none(), none()))
        .collect();
    let steps = vec![json!({ "apply": balls, "repeat": 60, "expect": { "stateHash": null, "physicsHash": null } })];
    vector("full-17-7-world", world(1.0 / 30.0, 2, [0.0, 0.0, -800.0], "z", 39.37), statics, "each", steps)
}

fn scenes() -> Vec<Value> {
    vec![
        spread_kicked_props(),
        pile_10_players_30hz(),
        dense_heap(),
        motorised_doors_32(),
        firstperson_static_inches(),
        vehicle_hull_pushing_props(),
        ccd_balls(),
        query_and_event_ordering(),
        hostile("each"),
        hostile("atomic"),
        escaped_bodies(),
        snapshot_round_trip(),
        key_at_64_bytes(),
        full_17_7_world(),
        memory_limit(),
    ]
}

fn file_of(vector: &Value) -> PathBuf {
    vectors_dir().join(format!("{}.json", vector["name"].as_str().unwrap_or("unnamed")))
}

#[test]
#[ignore = "rewrites the pins: GENEX_PHYSICS_WRITE_VECTORS=1 cargo test --test vectors -- --ignored write_vectors"]
fn write_vectors() {
    if std::env::var("GENEX_PHYSICS_WRITE_VECTORS").as_deref() != Ok("1") {
        return;
    }
    std::fs::create_dir_all(vectors_dir()).expect("the vectors directory");
    for scene in scenes() {
        let recorded = run_vector(&scene, true).unwrap_or_else(|e| panic!("{}: {e}", scene["name"]));
        let text = serde_json::to_string_pretty(&recorded).expect("JSON") + "\n";
        std::fs::write(file_of(&scene), text).expect("writes");
    }
}

#[test]
fn every_pinned_vector_passes_on_this_build() {
    let names = vector_files();
    assert!(names.len() >= scenes().len(), "every required scene is pinned");
    for path in names {
        let text = std::fs::read_to_string(&path).expect("reads");
        let vector: Value = serde_json::from_str(&text).expect("JSON");
        assert_eq!(vector["contract"], VECTOR_CONTRACT, "{path:?}");
        if let Err(e) = run_vector(&vector, false) {
            panic!("{path:?}: {e}");
        }
    }
}

#[test]
fn the_pins_are_the_scenes_this_file_writes() {
    for scene in scenes() {
        let pinned: Value = serde_json::from_str(&std::fs::read_to_string(file_of(&scene)).expect("pinned")).expect("JSON");
        let mut unpinned = pinned.clone();
        for entry in unpinned["steps"].as_array_mut().into_iter().flatten() {
            if let Some(expect) = entry.get_mut("expect").and_then(Value::as_object_mut) {
                expect.values_mut().for_each(|v| *v = Value::Null);
            }
        }
        assert_eq!(as_f32(&unpinned), as_f32(&scene), "{}: the pinned file's scene", scene["name"]);
    }
}

#[test]
fn a_changed_expectation_is_reported_with_its_step() {
    let mut vector = key_at_64_bytes();
    vector["steps"][0]["expect"] = json!({ "stateHash": "0000000000000000" });
    let error = run_vector(&vector, false).expect_err("a wrong hash");
    assert!(error.starts_with("step 0: stateHash expected \"0000000000000000\""), "{error}");
    assert!(error.contains("bodies: ["), "the dump follows");
}

#[test]
fn every_pinned_vector_names_this_build_without_its_target() {
    for path in vector_files() {
        let vector: Value = serde_json::from_str(&std::fs::read_to_string(&path).expect("reads")).expect("JSON");
        assert_eq!(vector["build"], json!(build_id_without_target()), "{path:?}");
    }
}

#[test]
fn a_vector_pinned_on_another_build_is_refused_naming_both_builds() {
    let pinned: Value = serde_json::from_str(&std::fs::read_to_string(file_of(&key_at_64_bytes())).expect("pinned")).expect("JSON");
    let other = "genex-physics/9.9.9+contract-1.0+rapier-0.36.0+det";
    let cases = [json!(other), Value::Null, json!(""), json!(build_id())];
    for build in cases {
        let mut vector = pinned.clone();
        vector["build"] = build.clone();
        let error = run_vector(&vector, false).expect_err("another build's vector");
        assert!(error.starts_with("build:"), "{build}: {error}");
        assert!(error.contains(&build_id_without_target()), "{build}: names this build: {error}");
    }
}

#[test]
fn the_vectors_reach_every_code_their_operations_can_give() {
    let mut seen = std::collections::BTreeSet::new();
    for path in vector_files() {
        let vector: Value = serde_json::from_str(&std::fs::read_to_string(&path).expect("reads")).expect("JSON");
        for entry in vector["steps"].as_array().expect("steps") {
            for pair in entry["expect"].get("refused").and_then(Value::as_array).into_iter().flatten() {
                seen.insert(pair[1].as_str().expect("a code").to_string());
            }
            for answer in entry["expect"].get("queries").and_then(Value::as_array).into_iter().flatten() {
                if let Some(code) = answer.get("error").and_then(Value::as_str) {
                    seen.insert(code.to_string());
                }
            }
        }
    }
    let wanted: std::collections::BTreeSet<String> =
        PhysicsError::ALL.iter().filter(|code| !UNREACHABLE_BY_VECTOR_OPERATIONS.contains(code)).map(|code| code.code().to_string()).collect();
    assert_eq!(seen, wanted);
}

#[test]
fn the_readme_names_every_pinned_vector() {
    let readme = std::fs::read_to_string(vectors_dir().join("README.md")).expect("vectors/README.md");
    for path in vector_files() {
        let name = path.file_name().and_then(|n| n.to_str()).expect("a file name");
        assert!(readme.contains(&format!("`{name}`")), "README.md lists {name}");
    }
    assert!(readme.contains(&build_id_without_target()), "README.md names the build the pins are for");
}

#[test]
fn the_hostile_vectors_leave_the_hash_unchanged_on_every_refusal() {
    for mode in ["each", "atomic"] {
        let path = vectors_dir().join(format!("hostile-commands-{mode}.json"));
        let vector: Value = serde_json::from_str(&std::fs::read_to_string(path).expect("pinned")).expect("JSON");
        let mut previous: Option<Value> = None;
        let mut refusals = 0;
        for entry in vector["steps"].as_array().expect("steps") {
            let refused = entry["expect"].get("refused").and_then(Value::as_array).is_some_and(|r| !r.is_empty());
            let unstepped = entry.get("repeat").and_then(Value::as_u64) == Some(0);
            let hash = entry["expect"].get("stateHash").cloned();
            if refused && unstepped {
                refusals += entry["expect"]["refused"].as_array().map_or(0, Vec::len);
                assert_eq!(hash, previous, "{mode}: a refused entry left the hash as it was");
            }
            if hash.is_some() {
                previous = hash;
            }
        }
        assert!(refusals >= 15, "{mode}: every command code at least once ({refusals})");
    }
}
