//! The M0a.9 determinism and parity gate (plan "The game API agents write", determinism).
//!
//! - Bit-level determinism within a target: a named demo replayed from one seed gives the same
//!   postcard snapshot bytes at every checkpoint (`two_runs_of_one_seed_are_bit_identical`); a
//!   world whose update order comes from a per-process random hasher is caught by that same
//!   check (`a_hash_ordered_world_fails_the_two_run_check`).
//! - Cross-target parity: the demo's named fields after 600 ticks stay within 1e-3 of the values
//!   recorded on the aarch64 Mac (`the_orbit_demo_matches_the_recorded_fields`); the same test
//!   runs on every target the gate builds it for.
//! - The record comparator `scripts/spike/rust-wgpu/parity.sh` uses for the pond's self-test and
//!   parity records: every named numeric leaf within 1e-3; integers, strings and shapes exact;
//!   `checksum` and `digest` leaves reported as bit fields, never toleranced. Its hostile-input
//!   table is `the_comparator_refuses_every_hostile_record`; parity.sh drives
//!   `records_named_in_the_environment_agree` with two record files.

use genex_core::digest::{fnv1a64, hex64};
use genex_core::rng::Pcg32;
use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Number, Value, json};
use std::ffi::OsStr;
use std::fmt;

/// Every named numeric field of two targets' records agrees within this (plan: 1e-3).
const PARITY_TOLERANCE: f64 = 1.0e-3;
/// The named demo's length after its seed.
const DEMO_TICKS: u32 = 600;
/// Ticks between two postcard snapshots.
const SNAPSHOT_EVERY_TICKS: u32 = 200;
/// The fixed tick.
const STEP_SECONDS: f32 = 1.0 / 60.0;
/// Bodies in the orbit demo.
const BODIES: usize = 16;
/// Ticks between two random kicks.
const KICK_EVERY_TICKS: u32 = 30;
const SPRING: f32 = 1.8;
const SWIRL: f32 = 0.9;
const DRAG_PER_SECOND: f32 = 0.35;
const FLOOR_Y: f32 = -2.0;
const RESTITUTION: f32 = 0.6;
const GRAVITY: f32 = 9.81;
/// How much of a body's x each update adds to the shared wind, and how fast the wind decays.
const WIND_GAIN: f32 = 1.0e-3;
const WIND_DECAY: f32 = 0.99;
/// Attempts of the hostile hash-ordered row (a coincidental match is then negligible).
const HASHED_ATTEMPTS: usize = 3;
/// Leaves whose value is a digest of bits: compared exactly and reported, never toleranced.
const BIT_FIELDS: [&str; 2] = ["checksum", "digest"];

/// Env of the record comparison parity.sh asks for.
const ENV_GOLDEN: &str = "GENEX_PARITY_GOLDEN";
const ENV_CANDIDATE: &str = "GENEX_PARITY_CANDIDATE";
const ENV_REPORT: &str = "GENEX_PARITY_REPORT";
/// Set to print the orbit demo's fields (how the recorded values below were taken).
const ENV_PRINT: &str = "GENEX_PARITY_PRINT";

// ---- the orbit demo -------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct Body {
    position: [f32; 3],
    velocity: [f32; 3],
    phase: f32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct World {
    tick: u32,
    /// A value every body's update feeds in turn: float addition is not associative, so the
    /// world depends on the update order.
    wind: f32,
    bodies: Vec<Body>,
}

/// The order bodies are updated in each tick.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Order {
    /// Index order, the same in every process.
    Indexed,
    /// The iteration order of a std `HashMap` with its per-process random hasher.
    Hashed,
}

/// One postcard snapshot of the world.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Snapshot {
    tick: u32,
    bytes: Vec<u8>,
}

impl Snapshot {
    fn digest(&self) -> String {
        hex64(fnv1a64(&self.bytes))
    }
}

/// A demo run: the snapshots at every checkpoint and the final world.
#[derive(Clone, Debug, PartialEq)]
struct Trace {
    snapshots: Vec<Snapshot>,
    world: World,
}

fn spawn(rng: &mut Pcg32) -> World {
    let bodies = (0..BODIES)
        .map(|_| Body {
            position: [rng.range_f32(-4.0, 4.0), rng.range_f32(0.0, 6.0), rng.range_f32(-4.0, 4.0)],
            velocity: [rng.range_f32(-1.0, 1.0), 0.0, rng.range_f32(-1.0, 1.0)],
            phase: rng.range_f32(0.0, core::f32::consts::TAU),
        })
        .collect();
    World { tick: 0, wind: 0.0, bodies }
}

/// One body's tick: a soft central spring, a phase-driven swirl, gravity, drag and a floor, every
/// transcendental through libm.
fn update_body(body: &mut Body, wind: f32, kick: Option<[f32; 3]>) {
    let [x, _, z] = body.position;
    let (sin, cos) = libm::sincosf(body.phase);
    let radius = libm::sqrtf(x * x + z * z).max(1.0e-3);
    let pull = -SPRING * libm::atanf(radius) / radius;
    let accel = [x * pull + SWIRL * cos + wind, -GRAVITY + libm::powf(sin * sin, 1.5), z * pull - SWIRL * sin];
    let drag = libm::expf(-DRAG_PER_SECOND * STEP_SECONDS);
    for (v, a) in body.velocity.iter_mut().zip(accel) {
        *v = (*v + a * STEP_SECONDS) * drag;
    }
    if let Some(kick) = kick {
        body.velocity.iter_mut().zip(kick).for_each(|(v, k)| *v += k);
    }
    body.position.iter_mut().zip(body.velocity).for_each(|(p, v)| *p += v * STEP_SECONDS);
    if body.position[1] < FLOOR_Y {
        body.position[1] = FLOOR_Y;
        body.velocity[1] = -body.velocity[1] * RESTITUTION;
    }
    let advance = STEP_SECONDS * (1.0 + libm::tanhf(body.velocity[1]));
    body.phase = libm::fmodf(body.phase + advance, core::f32::consts::TAU);
}

/// The body indices in `order`.
#[allow(clippy::disallowed_types, reason = "the hostile row needs a per-process random iteration order")]
fn update_order(order: Order) -> Vec<usize> {
    match order {
        Order::Indexed => (0..BODIES).collect(),
        Order::Hashed => {
            let map: std::collections::HashMap<usize, ()> = (0..BODIES).map(|i| (i, ())).collect();
            map.into_keys().collect()
        }
    }
}

fn tick(world: &mut World, rng: &mut Pcg32, order: Order) {
    world.tick += 1;
    let kicking = world.tick.is_multiple_of(KICK_EVERY_TICKS);
    for index in update_order(order) {
        let kick = kicking.then(|| [rng.range_f32(-2.0, 2.0), rng.range_f32(0.0, 4.0), rng.range_f32(-2.0, 2.0)]);
        let wind = world.wind;
        let body = &mut world.bodies[index];
        update_body(body, wind, kick);
        world.wind = (world.wind + body.position[0] * WIND_GAIN) * WIND_DECAY;
    }
}

fn snapshot(world: &World) -> Snapshot {
    Snapshot { tick: world.tick, bytes: postcard::to_allocvec(world).expect("a world always serializes") }
}

/// Seed, then run `ticks` ticks of the orbit demo, snapshotting every [`SNAPSHOT_EVERY_TICKS`].
fn run_demo(seed: u32, ticks: u32, order: Order) -> Trace {
    let mut rng = Pcg32::seeded(u64::from(seed));
    let mut world = spawn(&mut rng);
    let mut snapshots = vec![snapshot(&world)];
    for _ in 0..ticks {
        tick(&mut world, &mut rng, order);
        if world.tick.is_multiple_of(SNAPSHOT_EVERY_TICKS) {
            snapshots.push(snapshot(&world));
        }
    }
    Trace { snapshots, world }
}

/// Where two runs of one seed stopped being the same run.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Divergence {
    tick: u32,
    first: String,
    second: String,
}

/// Run the demo twice from `seed` and require identical snapshot bytes at every checkpoint.
fn two_run_check(seed: u32, ticks: u32, order: Order) -> Result<Trace, Divergence> {
    let first = run_demo(seed, ticks, order);
    let second = run_demo(seed, ticks, order);
    for (a, b) in first.snapshots.iter().zip(&second.snapshots) {
        if a != b {
            return Err(Divergence { tick: a.tick, first: a.digest(), second: b.digest() });
        }
    }
    Ok(first)
}

/// The world's named fields as a JSON record (the shape the comparator reads).
fn named_fields(world: &World) -> Value {
    let bodies: Vec<Value> =
        world.bodies.iter().map(|b| json!({ "position": b.position, "velocity": b.velocity, "phase": b.phase })).collect();
    json!({ "tick": world.tick, "wind": world.wind, "bodies": bodies })
}

// ---- the record comparator ------------------------------------------------------------------

/// One way a candidate record fails parity with the golden one.
#[derive(Clone, Debug, PartialEq)]
enum Mismatch {
    /// A field of the golden record the candidate lacks.
    Missing(String),
    /// A field the golden record lacks.
    Extra(String),
    /// The two values are of different JSON kinds.
    Kind(String),
    /// A number beyond the tolerance; an integer, string, boolean or bit field not equal.
    Differs { field: String, golden: Value, candidate: Value },
}

impl fmt::Display for Mismatch {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Mismatch::Missing(field) => write!(f, "missing {field}"),
            Mismatch::Extra(field) => write!(f, "extra {field}"),
            Mismatch::Kind(field) => write!(f, "kind differs at {field}"),
            Mismatch::Differs { field, golden, candidate } => write!(f, "{field}: golden {golden}, candidate {candidate}"),
        }
    }
}

/// What a comparison found.
#[derive(Clone, Debug, Default, PartialEq)]
struct Report {
    /// Leaves compared (bit fields included).
    compared: usize,
    /// The largest difference of any toleranced number.
    max_difference: f64,
    mismatches: Vec<Mismatch>,
    /// Every bit field and whether the two records hold the same bits there.
    bit_fields: Vec<(String, bool)>,
}

impl Report {
    fn bit_identical(&self) -> bool {
        self.bit_fields.iter().all(|(_, same)| *same)
    }

    fn to_json(&self) -> Value {
        let bits: JsonMap<String, Value> = self.bit_fields.iter().map(|(field, same)| (field.clone(), json!(same))).collect();
        json!({
            "compared": self.compared,
            "tolerance": PARITY_TOLERANCE,
            "maxDifference": self.max_difference,
            "mismatches": self.mismatches.iter().map(ToString::to_string).collect::<Vec<_>>(),
            "bitFields": bits,
            "bitIdentical": self.bit_identical(),
        })
    }

    fn differs(&mut self, path: &str, golden: Value, candidate: Value) {
        self.mismatches.push(Mismatch::Differs { field: path.to_owned(), golden, candidate });
    }
}

fn child(path: &str, key: &str) -> String {
    if path.is_empty() { key.to_owned() } else { format!("{path}.{key}") }
}

/// A leaf named `checksum` or `digest` (an object key, not an array index).
fn is_bit_field(path: &str) -> bool {
    let leaf = path.rsplit('.').next().unwrap_or(path);
    BIT_FIELDS.contains(&leaf)
}

fn is_integer(number: &Number) -> bool {
    number.is_i64() || number.is_u64()
}

fn compare_numbers(path: &str, golden: &Number, candidate: &Number, report: &mut Report) {
    report.compared += 1;
    if is_integer(golden) && is_integer(candidate) {
        if golden != candidate {
            report.differs(path, json!(golden), json!(candidate));
        }
        return;
    }
    let (a, b) = (golden.as_f64().unwrap_or(f64::NAN), candidate.as_f64().unwrap_or(f64::NAN));
    let difference = (a - b).abs();
    if difference.is_finite() {
        report.max_difference = report.max_difference.max(difference);
    }
    let within = difference <= PARITY_TOLERANCE;
    if !within {
        report.differs(path, json!(golden), json!(candidate));
    }
}

fn compare_objects(path: &str, golden: &JsonMap<String, Value>, candidate: &JsonMap<String, Value>, report: &mut Report) {
    for (key, value) in golden {
        match candidate.get(key) {
            Some(other) => compare_at(&child(path, key), value, other, report),
            None => report.mismatches.push(Mismatch::Missing(child(path, key))),
        }
    }
    for key in candidate.keys().filter(|key| !golden.contains_key(*key)) {
        report.mismatches.push(Mismatch::Extra(child(path, key)));
    }
}

fn compare_arrays(path: &str, golden: &[Value], candidate: &[Value], report: &mut Report) {
    for (i, value) in golden.iter().enumerate() {
        let at = format!("{path}[{i}]");
        match candidate.get(i) {
            Some(other) => compare_at(&at, value, other, report),
            None => report.mismatches.push(Mismatch::Missing(at)),
        }
    }
    for i in golden.len()..candidate.len() {
        report.mismatches.push(Mismatch::Extra(format!("{path}[{i}]")));
    }
}

fn compare_at(path: &str, golden: &Value, candidate: &Value, report: &mut Report) {
    let leaf = !golden.is_object() && !golden.is_array();
    if leaf && is_bit_field(path) {
        report.compared += 1;
        report.bit_fields.push((path.to_owned(), golden == candidate));
        return;
    }
    match (golden, candidate) {
        (Value::Object(a), Value::Object(b)) => compare_objects(path, a, b, report),
        (Value::Array(a), Value::Array(b)) => compare_arrays(path, a, b, report),
        (Value::Number(a), Value::Number(b)) => compare_numbers(path, a, b, report),
        (Value::String(_), Value::String(_)) | (Value::Bool(_), Value::Bool(_)) | (Value::Null, Value::Null) => {
            report.compared += 1;
            if golden != candidate {
                report.differs(path, golden.clone(), candidate.clone());
            }
        }
        _ => report.mismatches.push(Mismatch::Kind(path.to_owned())),
    }
}

/// Compare a candidate record with the golden one, field by named field.
fn compare(golden: &Value, candidate: &Value) -> Report {
    let mut report = Report::default();
    compare_at("", golden, candidate, &mut report);
    report
}

// ---- tests ----------------------------------------------------------------------------------

#[test]
fn two_runs_of_one_seed_are_bit_identical() {
    let trace = two_run_check(1, DEMO_TICKS, Order::Indexed).unwrap_or_else(|d| panic!("the demo diverged: {d:?}"));
    let ticks: Vec<u32> = trace.snapshots.iter().map(|s| s.tick).collect();
    assert_eq!(ticks, [0, 200, 400, 600]);
    let last = trace.snapshots.last().expect("a final snapshot");
    let decoded: World = postcard::from_bytes(&last.bytes).expect("the snapshot decodes");
    assert_eq!(decoded, trace.world, "a postcard snapshot holds the whole world");
    assert_eq!(postcard::to_allocvec(&decoded).expect("serializes"), last.bytes, "and re-encodes to the same bytes");
}

#[test]
fn seeds_give_different_runs() {
    let one = run_demo(1, DEMO_TICKS, Order::Indexed);
    let two = run_demo(2, DEMO_TICKS, Order::Indexed);
    assert_ne!(one.snapshots[0], two.snapshots[0]);
    assert_ne!(one.world, two.world);
}

#[test]
fn a_hash_ordered_world_fails_the_two_run_check() {
    // Each run builds its own std HashMap, whose RandomState orders 16 keys differently with
    // overwhelming probability; three attempts make a coincidental match negligible.
    let caught = (0..HASHED_ATTEMPTS).any(|_| two_run_check(1, DEMO_TICKS, Order::Hashed).is_err());
    assert!(caught, "the two-run check must refuse a world updated in a per-process random order");
}

/// The orbit demo's fields after 600 ticks from seed 1, recorded on aarch64-apple-darwin (Rust
/// 1.99.0, libm 0.2.16) with `GENEX_PARITY_PRINT=1`. Every target must land within
/// [`PARITY_TOLERANCE`] of them.
fn recorded_fields() -> Value {
    serde_json::from_str(RECORDED_FIELDS).expect("the recorded fields are JSON")
}

const RECORDED_FIELDS: &str = r#"
{"tick": 600, "wind": -0.13978716731071472, "bodies": [
    {"position": [-0.47179877758026123, -1.937610149383545, -1.6309866905212402], "velocity": [-2.478701591491699, 3.7433910369873047, -1.302834391593933], "phase": 4.100176811218262},
    {"position": [-1.2634433507919312, -1.0698012113571167, -1.9033738374710083], "velocity": [-3.1264500617980957, -0.08783125877380371, -1.138504981994629], "phase": 4.408264636993408},
    {"position": [-2.7048580646514893, -1.5490442514419556, -6.142575263977051], "velocity": [1.0003776550292969, -0.7336000204086304, -1.731354832649231], "phase": 3.703289747238159},
    {"position": [-8.387238502502441, -1.883529782295227, -0.2964654862880707], "velocity": [1.701613426208496, 4.626287460327148, 0.5276905298233032], "phase": 2.935394287109375},
    {"position": [-1.7279531955718994, -1.899606704711914, -2.068967819213867], "velocity": [3.206308603286743, 1.2837470769882202, -0.15089820325374603], "phase": 0.7290733456611633},
    {"position": [-3.0034725666046143, -1.9426404237747192, 0.03757574409246445], "velocity": [2.832127332687378, 3.4415760040283203, -2.436436653137207], "phase": 0.4107019901275635},
    {"position": [-1.0107667446136475, -1.3400934934616089, -2.059438467025757], "velocity": [2.9644477367401123, 0.9208996295928955, -0.21447616815567017], "phase": 4.412959575653076},
    {"position": [0.24287234246730804, -1.0504884719848633, -2.2451088428497314], "velocity": [-0.48343828320503235, 2.7377285957336426, -6.084214210510254], "phase": 4.859159469604492},
    {"position": [-1.4186358451843262, -1.985229730606079, -2.8414759635925293], "velocity": [0.37286198139190674, 0.8862136006355286, -1.4346420764923096], "phase": 2.87237548828125},
    {"position": [-0.7620523571968079, -1.9382004737854004, -2.4432835578918457], "velocity": [0.04983079433441162, 3.707974672317505, -0.09957146644592285], "phase": 5.29630708694458},
    {"position": [-0.20605112612247467, -1.7589012384414673, 0.18120914697647095], "velocity": [-0.6111264228820801, 2.8632125854492188, 1.651632308959961], "phase": 4.393837928771973},
    {"position": [-1.6581381559371948, -1.4114221334457397, 1.4095581769943237], "velocity": [0.2467653751373291, 2.017402172088623, -0.8274639248847961], "phase": 4.147866249084473},
    {"position": [-4.058091640472412, -1.9320679903030396, 0.2693530023097992], "velocity": [-0.04081296920776367, -0.40890979766845703, -0.3520594537258148], "phase": 4.492220878601074},
    {"position": [-0.552656352519989, -2.0, 3.3051681518554688], "velocity": [2.177769899368286, 0.03546097129583359, -4.918306350708008], "phase": 1.4774960279464722},
    {"position": [3.4726736545562744, -1.9275792837142944, -3.476405382156372], "velocity": [-3.2276644706726074, 1.5769093036651611, -0.8612540364265442], "phase": 2.6337952613830566},
    {"position": [0.5016428828239441, -1.8389394283294678, -1.3008456230163574], "velocity": [-2.4361467361450195, 3.1317362785339355, 2.0579733848571777], "phase": 0.21856024861335754}
]}
"#;

#[test]
fn the_orbit_demo_matches_the_recorded_fields() {
    let world = run_demo(1, DEMO_TICKS, Order::Indexed).world;
    let fields = named_fields(&world);
    if std::env::var_os(ENV_PRINT).is_some() {
        println!("{fields}");
    }
    let report = compare(&recorded_fields(), &fields);
    assert!(report.mismatches.is_empty(), "{}", report.to_json());
    assert!(report.compared > BODIES * 7, "every body's fields were compared: {}", report.compared);
}

fn record(mean_y: f64, checksum: &str) -> Value {
    json!({
        "format": "genex-self-test/1",
        "seed": 1,
        "frame": 720,
        "checksum": checksum,
        "probes": { "floaters": { "count": 6, "meanY": mean_y }, "fishing": { "phase": "idle", "score": 1 } },
        "captures": [{ "tick": 120, "digest": "d8aaa0b4e8e25aec" }],
    })
}

/// What the comparator must say about one candidate.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Verdict {
    Agrees,
    AgreesWithBitsDiffering,
    Refused,
}

fn verdict(report: &Report) -> Verdict {
    if !report.mismatches.is_empty() {
        return Verdict::Refused;
    }
    if report.bit_identical() { Verdict::Agrees } else { Verdict::AgreesWithBitsDiffering }
}

/// `value` with the member at JSON pointer `pointer` replaced, added or (with `None`) removed.
fn with(mut value: Value, pointer: &str, replacement: Option<Value>) -> Value {
    let (parent, key) = pointer.rsplit_once('/').expect("a pointer with a parent");
    let parent = value.pointer_mut(parent).expect("the parent exists");
    match (parent, replacement) {
        (Value::Object(map), Some(new)) => {
            map.insert(key.to_owned(), new);
        }
        (Value::Object(map), None) => {
            map.remove(key);
        }
        (Value::Array(items), Some(new)) => {
            let index: usize = key.parse().expect("an index");
            if index < items.len() { items[index] = new } else { items.push(new) }
        }
        (Value::Array(items), None) => {
            items.remove(key.parse::<usize>().expect("an index"));
        }
        _ => panic!("{pointer} is not inside an object or array"),
    }
    value
}

#[test]
fn the_comparator_refuses_every_hostile_record() {
    let golden = record(0.034_123_469, "e6e9b4d596408395");
    let edit = |pointer: &str, replacement: Option<Value>| with(golden.clone(), pointer, replacement);
    let rows: Vec<(&str, Value, Verdict)> = vec![
        ("identical", golden.clone(), Verdict::Agrees),
        ("within tolerance", record(0.034_123_469 + 5.0e-4, "e6e9b4d596408395"), Verdict::Agrees),
        ("beyond tolerance", record(0.034_123_469 + 2.0e-3, "e6e9b4d596408395"), Verdict::Refused),
        ("one ulp off, other checksum", record(0.034_123_470, "0000000000000000"), Verdict::AgreesWithBitsDiffering),
        ("capture digest differs", edit("/captures/0/digest", Some(json!("ffff"))), Verdict::AgreesWithBitsDiffering),
        ("checksum as a number", edit("/checksum", Some(json!(1))), Verdict::AgreesWithBitsDiffering),
        ("integer off by one", edit("/frame", Some(json!(721))), Verdict::Refused),
        ("integer as a near fraction", edit("/frame", Some(json!(720.0004))), Verdict::Agrees),
        ("string differs", edit("/probes/fishing/phase", Some(json!("cast"))), Verdict::Refused),
        ("format differs", edit("/format", Some(json!("genex-self-test/2"))), Verdict::Refused),
        ("field missing", edit("/probes/floaters/meanY", None), Verdict::Refused),
        ("field added", edit("/probes/floaters/maxY", Some(json!(1.0))), Verdict::Refused),
        ("number as a string", edit("/probes/floaters/meanY", Some(json!("0.0341"))), Verdict::Refused),
        ("number as null", edit("/probes/floaters/meanY", Some(Value::Null)), Verdict::Refused),
        ("huge number", edit("/probes/floaters/meanY", Some(json!(1.0e300))), Verdict::Refused),
        ("object as an array", edit("/probes/fishing", Some(json!([]))), Verdict::Refused),
        ("capture dropped", edit("/captures/0", None), Verdict::Refused),
        ("capture added", edit("/captures/1", Some(json!({ "tick": 1, "digest": "00" }))), Verdict::Refused),
        ("empty record", json!({}), Verdict::Refused),
        ("not an object", json!([golden.clone()]), Verdict::Refused),
    ];
    for (name, candidate, want) in rows {
        let report = compare(&golden, &candidate);
        assert_eq!(verdict(&report), want, "{name}: {}", report.to_json());
    }
}

#[test]
fn the_comparator_names_the_field_that_differs() {
    let report = compare(&record(0.5, "a"), &record(0.6, "a"));
    let field = Mismatch::Differs { field: "probes.floaters.meanY".to_owned(), golden: json!(0.5), candidate: json!(0.6) };
    assert_eq!(report.mismatches, [field]);
    assert!((report.max_difference - 0.1).abs() < 1.0e-9);
    assert_eq!(report.bit_fields, [("checksum".to_owned(), true), ("captures[0].digest".to_owned(), true)]);
}

fn read_record(path: &OsStr) -> Value {
    let shown = path.to_string_lossy();
    let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{shown}: {e}"));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{shown}: {e}"))
}

/// parity.sh's entry: compare `GENEX_PARITY_CANDIDATE` with `GENEX_PARITY_GOLDEN` and write the
/// report to `GENEX_PARITY_REPORT`. Ignored in a plain `cargo test` (it would compare nothing);
/// parity.sh runs it with `--ignored`, and a run that names only one record fails.
#[test]
#[ignore = "parity.sh's entry: needs GENEX_PARITY_GOLDEN and GENEX_PARITY_CANDIDATE"]
fn records_named_in_the_environment_agree() {
    let (golden, candidate) = (std::env::var_os(ENV_GOLDEN), std::env::var_os(ENV_CANDIDATE));
    let (Some(golden), Some(candidate)) = (golden, candidate) else {
        panic!("{ENV_GOLDEN} and {ENV_CANDIDATE} must both name a record");
    };
    let report = compare(&read_record(&golden), &read_record(&candidate));
    let mut summary = report.to_json();
    summary["golden"] = json!(golden.to_string_lossy());
    summary["candidate"] = json!(candidate.to_string_lossy());
    if let Some(out) = std::env::var_os(ENV_REPORT) {
        std::fs::write(&out, format!("{summary}\n")).unwrap_or_else(|e| panic!("{}: {e}", out.to_string_lossy()));
    }
    assert!(report.mismatches.is_empty(), "named fields differ beyond {PARITY_TOLERANCE}: {summary}");
}
