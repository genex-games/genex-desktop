//! Writes `tests/fixtures/interp/*.json`: scripted streams fed to the vendored genex-multiplayer
//! interpolator (the oracle), with every sample it returned. `tests/interp.rs` replays the same
//! operations on genex-net's sim-time port and holds it to these within 1e-6.
//!
//! Ignored: run it only to refresh the fixtures after the vendored crate's pin moves:
//!   cargo test -p genex-net --test interp_oracle_dump -- --ignored
//!
//! Time is in ticks; both sides turn a tick into `tick * 1000 / 60` ms. Stamps start at tick 1
//! (upstream treats a 0 stamp as unstamped; the port does not).

use std::path::Path;

use genex_multiplayer::interp::Interpolator;
use serde_json::{Map, Value, json};

const FORMAT: &str = "genex-net-interp-oracle";
const VERSION: u64 = 1;

fn ms(tick: u64) -> f64 {
    tick as f64 * 1000.0 / 60.0
}

/// A deterministic jitter source (a 64-bit LCG), so the fixtures regenerate byte for byte.
struct Lcg(u64);

impl Lcg {
    fn next(&mut self, below: u64) -> u64 {
        self.0 = self.0.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
        (self.0 >> 33) % below
    }
}

/// One scenario: the operations in order, with each sample's oracle answer filled in.
struct Scenario {
    name: &'static str,
    ops: Vec<Value>,
}

impl Scenario {
    fn new(name: &'static str) -> Scenario {
        Scenario { name, ops: Vec::new() }
    }

    fn push(&mut self, stream: &str, sender: &str, sent: u64, arrival: u64, state: Value) {
        self.ops.push(json!({"op": "push", "stream": stream, "sender": sender, "sent": sent, "arrival": arrival, "state": state}));
    }

    fn sample(&mut self, stream: &str, tick: u64) {
        self.ops.push(json!({"op": "sample", "stream": stream, "tick": tick}));
    }

    fn op(&mut self, op: &str, stream: &str) {
        self.ops.push(json!({"op": op, "stream": stream}));
    }

    /// Run the oracle over the operations, recording each sample's answer, delay and offset.
    fn record(mut self) -> Scenario {
        let mut oracle = Interpolator::new();
        for op in &mut self.ops {
            let stream = op["stream"].as_str().unwrap_or_default().to_owned();
            match op["op"].as_str().unwrap_or_default() {
                "push" => {
                    let state = op["state"].as_object().cloned().unwrap_or_default();
                    let sender = op["sender"].as_str().unwrap_or_default();
                    oracle.push(&stream, sender, ms(op["sent"].as_u64().unwrap_or(0)), state, ms(op["arrival"].as_u64().unwrap_or(0)));
                }
                "sample" => {
                    let got = oracle.sample(&stream, ms(op["tick"].as_u64().unwrap_or(0)));
                    op["expect"] = got.map_or(Value::Null, Value::Object);
                    op["delay"] = oracle.delay(&stream).map_or(Value::Null, Value::from);
                }
                "posed" => oracle.set_posed(&stream, true),
                "reset_epoch" => oracle.reset_epoch(&stream),
                "soft_handoff" => oracle.soft_handoff(&stream),
                "hold" => {
                    let state = op["state"].as_object().cloned().unwrap_or_default();
                    oracle.hold(&stream, state, ms(op["tick"].as_u64().unwrap_or(0)));
                }
                "remove_stream" => oracle.remove_stream(&stream),
                "remove_sender" => oracle.remove_sender(op["sender"].as_str().unwrap_or_default()),
                other => panic!("unknown op {other}"),
            }
            if let Some(sender) = op.get("sender").and_then(Value::as_str).map(str::to_owned) {
                op["offset"] = oracle.sender_offset(&sender).map_or(Value::Null, Value::from);
            }
        }
        self
    }

    fn write(&self, dir: &Path) {
        let lines: Vec<String> = self.ops.iter().map(Value::to_string).collect();
        let header = json!({"format": FORMAT, "version": VERSION, "scenario": self.name, "oracle": "genex-multiplayer src/interp.rs (vendored)"});
        let text = format!("{{\"header\":{header},\"ops\":[\n{}\n]}}\n", lines.join(",\n"));
        std::fs::write(dir.join(format!("{}.json", self.name)), text).expect("write a fixture");
    }
}

fn state(pairs: &[(&str, Value)]) -> Value {
    Value::Object(pairs.iter().map(|(k, v)| ((*k).to_owned(), v.clone())).collect::<Map<_, _>>())
}

/// 15 Hz publishes, fixed 3-tick latency, a discrete field changing every 40 ticks.
fn steady_15hz() -> Scenario {
    let mut s = Scenario::new("steady_15hz");
    for tick in 1..=200u64 {
        if tick % 4 == 1 {
            s.push("p", "p", tick, tick + 3, state(&[("x", json!(tick as f64 * 0.125)), ("y", json!((tick % 50) as f64)), ("mode", json!(format!("m{}", tick / 40)))]));
        }
        s.sample("p", tick);
    }
    s
}

/// 30 Hz publishes with 0..6 ticks of jitter on a 2-tick base (arrivals never reorder).
fn jitter_30hz() -> Scenario {
    let mut s = Scenario::new("jitter_30hz");
    let mut lcg = Lcg(7);
    let mut last_arrival = 0;
    let mut pending: Vec<(u64, u64, Value)> = Vec::new();
    for sent in (1..=200u64).step_by(2) {
        let arrival = (sent + 2 + lcg.next(7)).max(last_arrival);
        last_arrival = arrival;
        pending.push((sent, arrival, state(&[("x", json!(sent as f64 * 0.5)), ("z", json!(-(sent as f64) * 0.25))])));
    }
    for tick in 1..=215u64 {
        for (sent, arrival, value) in pending.iter().filter(|(_, a, _)| *a == tick) {
            s.push("p", "p", *sent, *arrival, value.clone());
        }
        s.sample("p", tick);
    }
    s
}

/// 15 Hz with every fifth publish lost, then a 150-tick outage (longer than the gap cap).
fn loss_and_outage() -> Scenario {
    let mut s = Scenario::new("loss_and_outage");
    let mut n = 0;
    for tick in 1..=320u64 {
        let outage = (120..270).contains(&tick);
        if tick % 4 == 1 && !outage {
            n += 1;
            if n % 5 != 0 {
                s.push("p", "p", tick, tick + 4, state(&[("x", json!(tick as f64)), ("hp", json!(100 - (tick / 10) as i64))]));
            }
        }
        if tick % 2 == 0 || outage {
            s.sample("p", tick);
        }
    }
    s
}

/// A quaternion turning about y (slerp), a near-identical pair (lerp path) and a sign flip.
fn quaternion() -> Scenario {
    let mut s = Scenario::new("quaternion");
    for (i, tick) in (1..=160u64).step_by(4).enumerate() {
        let angle = i as f64 * 0.2;
        let (sin, cos) = (angle / 2.0).sin_cos();
        let q = if i == 20 { json!([0.0, -sin, 0.0, -cos]) } else { json!([0.0, sin, 0.0, cos]) };
        s.push("o", "a", tick, tick + 2, state(&[("px", json!(i as f64)), ("q", q)]));
        s.sample("o", tick + 1);
        s.sample("o", tick + 3);
    }
    for (i, tick) in (170..=200u64).step_by(4).enumerate() {
        let tiny = 0.001 * i as f64;
        s.push("o", "a", tick, tick + 2, state(&[("px", json!(40.0)), ("q", json!([0.0, tiny, 0.0, 1.0]))]));
        s.sample("o", tick + 2);
    }
    s
}

/// A posed player (§10.1): yaw crossing ±π, velocities, a discrete animation name.
fn posed() -> Scenario {
    let mut s = Scenario::new("posed");
    s.op("posed", "p");
    for (i, tick) in (1..=180u64).step_by(4).enumerate() {
        let yaw = 2.8 + i as f64 * 0.05;
        let wrapped = if yaw > std::f64::consts::PI { yaw - 2.0 * std::f64::consts::PI } else { yaw };
        let x = i as f64 * 0.75;
        let pose = json!({"x": x, "y": 0.0, "z": -x, "yaw": wrapped, "vx": 11.25, "vy": 0.0, "vz": -11.25, "anim": if i % 10 < 5 { "walk" } else { "run" }});
        s.push("p", "p", tick, tick + 3, pose);
        s.sample("p", tick + 1);
        s.sample("p", tick + 2);
    }
    for tick in [190, 200, 215, 240] {
        s.sample("p", tick);
    }
    s
}

/// An object handed from owner A to owner B on another clock offset, held, reset and removed.
fn handoff() -> Scenario {
    let mut s = Scenario::new("handoff");
    for tick in (1..=60u64).step_by(4) {
        s.push("obj:ball", "A", tick, tick + 2, state(&[("x", json!(tick as f64)), ("mode", json!("a"))]));
        s.sample("obj:ball", tick + 1);
    }
    s.op("soft_handoff", "obj:ball");
    s.sample("obj:ball", 64);
    for tick in (66..=120u64).step_by(4) {
        s.push("obj:ball", "B", tick, tick + 9, state(&[("x", json!(500.0 - tick as f64)), ("mode", json!("b"))]));
        s.sample("obj:ball", tick + 9);
        s.sample("obj:ball", tick + 11);
    }
    s.ops.push(json!({"op": "hold", "stream": "obj:ball", "tick": 132, "state": {"x": 7.5, "mode": "held"}}));
    s.op("soft_handoff", "obj:ball");
    s.push("obj:ball", "A", 134, 136, state(&[("x", json!(-3.0)), ("mode", json!("a2"))]));
    for tick in 136..=150 {
        s.sample("obj:ball", tick);
    }
    s.op("reset_epoch", "obj:ball");
    s.push("obj:ball", "A", 152, 154, state(&[("x", json!(999.0))]));
    s.sample("obj:ball", 154);
    s.sample("obj:ball", 160);
    s.op("remove_stream", "obj:ball");
    s.ops.push(json!({"op": "remove_sender", "stream": "", "sender": "B"}));
    s.sample("obj:ball", 161);
    s
}

/// One sender driving five streams and another driving two, interleaved; a foreign-clock head.
fn many_streams() -> Scenario {
    let mut s = Scenario::new("many_streams");
    let mut lcg = Lcg(99);
    s.push("f", "f", 900_000, 1, state(&[("x", json!(1.0))]));
    for tick in 1..=150u64 {
        if tick % 3 == 0 {
            let stream = format!("h{}", tick % 5);
            s.push(&stream, "host", tick, tick + 1 + lcg.next(3), state(&[("x", json!(tick as f64 * 0.25))]));
        }
        if tick % 6 == 0 {
            let stream = format!("b{}", tick % 2);
            s.push(&stream, "b", tick, tick + 5, state(&[("x", json!(-(tick as f64))), ("on", json!(tick % 12 == 0))]));
        }
        if tick == 4 || tick == 8 {
            s.push("f", "f", tick, tick, state(&[("x", json!(tick as f64))]));
        }
        if tick % 5 == 0 {
            for stream in ["h0", "h1", "h2", "h3", "h4", "b0", "b1", "f"] {
                s.sample(stream, tick + 2);
            }
        }
    }
    s
}

#[test]
#[ignore = "refreshes tests/fixtures/interp from the vendored oracle"]
fn dump_interp_oracle_fixtures() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/interp");
    std::fs::create_dir_all(&dir).expect("the fixture folder");
    for scenario in [steady_15hz(), jitter_30hz(), loss_and_outage(), quaternion(), posed(), handoff(), many_streams()] {
        scenario.record().write(&dir);
    }
}
