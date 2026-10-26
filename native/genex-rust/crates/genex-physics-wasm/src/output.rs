//! What the binding hands back to JavaScript, as JSON text in the TypeScript shapes of
//! `genex-physics/js/index.d.ts`: results (`{ ok: true, … }` or a failure), body states, events,
//! hits, stats and the resolved description. Every number the core returns holds an f32 exactly;
//! it is written as that f64, so `JSON.parse` gives back the very value the core holds.

use genex_physics::{
    BodyState, CommandOutcome, Hit, Limits, NetBodyState, PhysicsEvent, PhysicsFailure, Pose, QueryAnswer, ResolvedWorldDesc,
    Stats, StepResult,
};
use serde_json::{Map, Value, json};

/// A JSON object from `(name, value)` pairs, in order.
fn object<const N: usize>(fields: [(&str, Value); N]) -> Map<String, Value> {
    fields.into_iter().map(|(name, value)| (name.to_string(), value)).collect()
}

/// `{ "ok": true }` with `fields` added.
pub(crate) fn ok_with<const N: usize>(fields: [(&str, Value); N]) -> String {
    let mut out = object([("ok", Value::Bool(true))]);
    out.extend(object(fields));
    Value::Object(out).to_string()
}

/// `{ "ok": true }`.
pub(crate) fn ok() -> String {
    ok_with([])
}

/// `{ ok: false, code, index?, detail }` (§14).
pub(crate) fn failure(failure: &PhysicsFailure) -> String {
    let mut out = object([("ok", Value::Bool(false)), ("code", json!(failure.code.code()))]);
    if let Some(index) = failure.index {
        out.insert("index".to_string(), json!(index));
    }
    out.insert("detail".to_string(), json!(failure.detail));
    Value::Object(out).to_string()
}

/// A unit result as text.
pub(crate) fn unit(result: Result<(), PhysicsFailure>) -> String {
    match result {
        Ok(()) => ok(),
        Err(refused) => failure(&refused),
    }
}

/// An `"each"` batch's outcomes (§7.1): `{ ok: true, results: [{ ok } | { ok: false, code }] }`.
pub(crate) fn outcomes(outcomes: &[CommandOutcome]) -> String {
    let results = outcomes.iter().map(|outcome| match outcome {
        Ok(()) => json!({ "ok": true }),
        Err(code) => json!({ "ok": false, "code": code.code() }),
    });
    ok_with([("results", Value::Array(results.collect()))])
}

fn pose(pose: &Pose) -> Value {
    json!({ "p": pose.p, "q": pose.q })
}

/// One body's state (§9.1); `kind` only when the body has one.
pub(crate) fn body_state(state: &BodyState) -> Value {
    let mut out = object([("key", json!(state.key))]);
    if let Some(kind) = &state.kind {
        out.insert("kind".to_string(), json!(kind));
    }
    out.extend(object([
        ("type", json!(state.body_type.name())),
        ("pose", pose(&state.pose)),
        ("linvel", json!(state.linvel)),
        ("angvel", json!(state.angvel)),
        ("sleeping", json!(state.sleeping)),
    ]));
    Value::Object(out)
}

/// A body's replicated fields (§9.2).
pub(crate) fn net_state(state: &NetBodyState) -> Value {
    json!({ "p": state.p, "q": state.q, "v": state.v, "w": state.w, "sleeping": state.sleeping })
}

/// Adds each kind tag that is set, under its name.
fn put_kinds(out: &mut Map<String, Value>, tags: [(&str, &Option<String>); 2]) {
    for (name, kind) in tags {
        if let Some(kind) = kind {
            out.insert(name.to_string(), json!(kind));
        }
    }
}

/// One event in its §8.1 form.
fn event(event: &PhysicsEvent) -> Value {
    let mut out = Map::new();
    match event {
        PhysicsEvent::ContactBegin { a, b, ca, cb, ka, kb, impulse, point, normal } => {
            out.extend(object([("kind", json!("contactBegin")), ("a", json!(a)), ("b", json!(b)), ("ca", json!(ca)), ("cb", json!(cb))]));
            put_kinds(&mut out, [("ka", ka), ("kb", kb)]);
            out.extend(object([("impulse", json!(impulse)), ("point", json!(point)), ("normal", json!(normal))]));
        }
        PhysicsEvent::ContactEnd { a, b, ca, cb, ka, kb } => {
            out.extend(object([("kind", json!("contactEnd")), ("a", json!(a)), ("b", json!(b)), ("ca", json!(ca)), ("cb", json!(cb))]));
            put_kinds(&mut out, [("ka", ka), ("kb", kb)]);
        }
        PhysicsEvent::TriggerEnter { sensor, sc, other, oc, ks, ko } => {
            out.extend(trigger("triggerEnter", [sensor, sc, other, oc]));
            put_kinds(&mut out, [("ks", ks), ("ko", ko)]);
        }
        PhysicsEvent::TriggerExit { sensor, sc, other, oc, ks, ko } => {
            out.extend(trigger("triggerExit", [sensor, sc, other, oc]));
            put_kinds(&mut out, [("ks", ks), ("ko", ko)]);
        }
    }
    Value::Object(out)
}

fn trigger(kind: &str, [sensor, sc, other, oc]: [&String; 4]) -> Map<String, Value> {
    object([("kind", json!(kind)), ("sensor", json!(sensor)), ("sc", json!(sc)), ("other", json!(other)), ("oc", json!(oc))])
}

/// A step's result (§8) as `{ ok: true, tick, events, overflowed, escaped, memoryExceeded }`.
pub(crate) fn step(result: &StepResult) -> String {
    ok_with([
        ("tick", json!(result.tick)),
        ("events", Value::Array(result.events.iter().map(event).collect())),
        ("overflowed", json!(result.overflowed)),
        ("escaped", json!(result.escaped)),
        ("memoryExceeded", json!(result.memory_exceeded)),
    ])
}

fn hit(hit: &Hit) -> Value {
    json!({ "body": hit.body, "collider": hit.collider, "dist": hit.dist, "point": hit.point, "normal": hit.normal })
}

/// A query's answer (§13): `{ ok: true, hit }` or `{ ok: true, keys }`.
pub(crate) fn answer(answer: &QueryAnswer) -> String {
    match answer {
        QueryAnswer::Hit(found) => ok_with([("hit", found.as_ref().map_or(Value::Null, hit))]),
        QueryAnswer::Keys(keys) => ok_with([("keys", json!(keys))]),
    }
}

/// The world's counters (§11).
pub(crate) fn stats(stats: &Stats) -> String {
    json!({
        "tick": stats.tick,
        "bodies": stats.bodies,
        "awake": stats.awake,
        "colliders": stats.colliders,
        "joints": stats.joints,
        "contactPairs": stats.contact_pairs,
        "queriesThisStep": stats.queries_this_step,
        "stepMs": stats.step_ms,
        "memoryBytes": stats.memory_bytes,
    })
    .to_string()
}

fn limits(limits: &Limits) -> Value {
    json!({
        "bodies": limits.bodies,
        "collidersPerBody": limits.colliders_per_body,
        "hullVertices": limits.hull_vertices,
        "triangles": limits.triangles,
        "joints": limits.joints,
        "ccdBodies": limits.ccd_bodies,
        "queriesPerStep": limits.queries_per_step,
        "eventsPerStep": limits.events_per_step,
        "heightfieldSamples": limits.heightfield_samples,
        "staticPieces": limits.static_pieces,
        "memoryBytes": limits.memory_bytes,
        "worldExtent": f64::from(limits.world_extent),
        "maxSpeed": f64::from(limits.max_speed),
        "maxAngularSpeed": f64::from(limits.max_angular_speed),
    })
}

/// The resolved description (§4), every default filled.
pub(crate) fn desc(desc: &ResolvedWorldDesc) -> String {
    json!({
        "contract": genex_physics::CONTRACT_VERSION,
        "dt": f64::from(desc.dt),
        "substeps": desc.substeps,
        "gravity": desc.gravity.map(f64::from),
        "upAxis": desc.up_axis.name(),
        "lengthUnit": f64::from(desc.length_unit),
        "limits": limits(&desc.limits),
        "solver": { "iterations": desc.solver_iterations },
    })
    .to_string()
}
