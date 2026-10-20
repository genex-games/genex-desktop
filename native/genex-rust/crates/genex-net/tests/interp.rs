//! The sim-time interpolator port (MP-2b, new behaviour): it equals the vendored genex-multiplayer
//! interpolator within 1e-6 on every recorded stream (`tests/fixtures/interp/`, written by the
//! ignored `interp_oracle_dump.rs`), keeps upstream's constants, starts at the game's delay, takes
//! tick 0 as a real stamp, and replays to one pinned digest (the cross-target row).

use std::path::{Path, PathBuf};

use genex_net::interp::{Interpolator, params, tick_ms};
use serde_json::{Value, json};

const TOLERANCE: f64 = 1e-6;
/// FNV-1a over every replayed sample's keys and number bits, on every destination.
const REPLAY_DIGEST: u64 = 0xee66_6449_d822_802d;

fn fixtures() -> Vec<PathBuf> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/interp");
    let mut files: Vec<PathBuf> = std::fs::read_dir(&dir).expect("the fixture folder").map(|e| e.expect("an entry").path()).filter(|p| p.extension().is_some_and(|x| x == "json")).collect();
    files.sort();
    files
}

thread_local! {
    /// The largest difference from the oracle seen on this thread (reported by the parity row).
    static WORST: std::cell::Cell<f64> = const { std::cell::Cell::new(0.0) };
}

fn close_enough(got: &Value, want: &Value, at: &str) -> Result<(), String> {
    match (got, want) {
        (Value::Number(g), Value::Number(w)) => {
            let (g, w) = (g.as_f64().unwrap_or(f64::NAN), w.as_f64().unwrap_or(f64::NAN));
            WORST.with(|worst| worst.set(worst.get().max((g - w).abs())));
            if (g - w).abs() <= TOLERANCE {
                return Ok(());
            }
            Err(format!("{at}: {g} vs oracle {w}"))
        }
        (Value::Array(g), Value::Array(w)) if g.len() == w.len() => g.iter().zip(w).enumerate().try_for_each(|(i, (g, w))| close_enough(g, w, &format!("{at}[{i}]"))),
        (Value::Object(g), Value::Object(w)) => {
            let keys_equal = g.keys().eq(w.keys());
            if !keys_equal {
                return Err(format!("{at}: keys {:?} vs oracle {:?}", g.keys().collect::<Vec<_>>(), w.keys().collect::<Vec<_>>()));
            }
            g.iter().zip(w).try_for_each(|((k, g), (_, w))| close_enough(g, w, &format!("{at}.{k}")))
        }
        _ if got == want => Ok(()),
        _ => Err(format!("{at}: {got} vs oracle {want}")),
    }
}

struct Fnv(u64);

impl Fnv {
    fn bytes(&mut self, bytes: &[u8]) {
        for b in bytes {
            self.0 ^= u64::from(*b);
            self.0 = self.0.wrapping_mul(0x0100_0000_01b3);
        }
    }

    fn value(&mut self, value: &Value) {
        match value {
            Value::Number(n) => self.bytes(&n.as_f64().unwrap_or(f64::NAN).to_bits().to_le_bytes()),
            Value::Array(items) => items.iter().for_each(|item| self.value(item)),
            Value::Object(members) => members.iter().for_each(|(k, v)| {
                self.bytes(k.as_bytes());
                self.value(v);
            }),
            other => self.bytes(other.to_string().as_bytes()),
        }
    }
}

/// Replay one fixture on the port; every mismatch, and the samples compared.
fn replay(path: &Path, digest: &mut Fnv) -> (Vec<String>, usize) {
    let text = std::fs::read_to_string(path).expect("a fixture");
    let fixture: Value = serde_json::from_str(&text).expect("fixture JSON");
    let mut port = Interpolator::new();
    let mut problems = Vec::new();
    let mut compared = 0;
    for (index, op) in fixture["ops"].as_array().expect("ops").iter().enumerate() {
        let stream = op["stream"].as_str().unwrap_or_default();
        let tick = |key: &str| op[key].as_u64().expect("a tick");
        let at = format!("{}#{index}", path.file_stem().and_then(|s| s.to_str()).unwrap_or("?"));
        match op["op"].as_str().expect("an op") {
            "push" => port.push(stream, op["sender"].as_str().expect("a sender"), tick("sent"), op["state"].as_object().cloned().expect("a state"), tick("arrival")),
            "sample" => {
                let got = port.sample(stream, tick("tick")).map_or(Value::Null, Value::Object);
                digest.value(&got);
                compared += usize::from(!got.is_null());
                if let Err(problem) = close_enough(&got, &op["expect"], &at) {
                    problems.push(problem);
                }
                let delay = port.delay(stream).map_or(Value::Null, Value::from);
                if let Err(problem) = close_enough(&delay, &op["delay"], &format!("{at} delay")) {
                    problems.push(problem);
                }
            }
            "posed" => port.set_posed(stream, true),
            "reset_epoch" => port.reset_epoch(stream),
            "soft_handoff" => port.soft_handoff(stream),
            "hold" => port.hold(stream, op["state"].as_object().cloned().expect("a state"), tick("tick")),
            "remove_stream" => port.remove_stream(stream),
            "remove_sender" => port.remove_sender(op["sender"].as_str().expect("a sender")),
            other => panic!("{at}: unknown op {other}"),
        }
        if let Some(sender) = op.get("sender").and_then(Value::as_str) {
            let offset = port.sender_offset(sender).map_or(Value::Null, Value::from);
            if let Err(problem) = close_enough(&offset, &op["offset"], &format!("{at} offset")) {
                problems.push(problem);
            }
        }
    }
    (problems, compared)
}

#[test]
fn the_port_equals_the_vendored_interpolator_on_every_fixture_stream() {
    let files = fixtures();
    assert!(files.len() >= 7, "the oracle fixtures are present ({} files)", files.len());
    let mut digest = Fnv(0xcbf2_9ce4_8422_2325);
    for file in &files {
        let (problems, compared) = replay(file, &mut digest);
        assert!(compared >= 20, "{} compares {compared} samples", file.display());
        assert!(problems.is_empty(), "{} differs from the oracle:\n{}", file.display(), problems.iter().take(10).cloned().collect::<Vec<_>>().join("\n"));
    }
    eprintln!("largest difference from the oracle: {:e}", WORST.with(std::cell::Cell::get));
}

#[test]
fn the_replay_digest_is_the_same_on_every_destination() {
    let mut digest = Fnv(0xcbf2_9ce4_8422_2325);
    for file in fixtures() {
        replay(&file, &mut digest);
    }
    assert_eq!(digest.0, REPLAY_DIGEST, "replay digest {:#018x}", digest.0);
}

#[test]
fn the_constants_are_upstreams() {
    use genex_multiplayer::protocol::interpolation as up;
    let floats = [
        (params::RATIO, up::RATIO),
        (params::JITTER_SAFETY, up::JITTER_SAFETY),
        (params::MIN_MS, up::MIN_MS),
        (params::MAX_MS, up::MAX_MS),
        (params::DEFAULT_MS, up::DEFAULT_MS),
        (params::EASE, up::EASE),
        (params::CLOCK_WINDOW_MS, up::CLOCK_WINDOW_MS),
        (params::MIN_GAP_MS, up::MIN_GAP_MS),
        (params::MAX_GAP_MS, up::MAX_GAP_MS),
        (params::HISTORY_MS, up::HISTORY_MS),
        (params::MAX_EXTRAP_MS, up::MAX_EXTRAP_MS),
        (params::ROT_EXTRAP_MS, up::ROT_EXTRAP_MS),
        (params::SMOOTH_TAU_POS_MS, up::SMOOTH_TAU_POS_MS),
        (params::SMOOTH_TAU_ROT_MS, up::SMOOTH_TAU_ROT_MS),
        (params::POISON_GUARD_MS, up::POISON_GUARD_MS),
        (params::MAX_HOST_TICK_DT_MS, up::MAX_HOST_TICK_DT_MS),
    ];
    for (i, (ours, theirs)) in floats.iter().enumerate() {
        assert_eq!(ours.to_bits(), theirs.to_bits(), "constant {i}");
    }
    let counts = [
        (params::CLOCK_WINDOW, up::CLOCK_WINDOW),
        (params::CLOCK_WINDOW_MAX, up::CLOCK_WINDOW_MAX),
        (params::INTERVAL_WINDOW, up::INTERVAL_WINDOW),
        (params::JITTER_MIN_SAMPLES, up::JITTER_MIN_SAMPLES),
    ];
    assert!(counts.iter().all(|(ours, theirs)| ours == theirs), "{counts:?}");
}

#[test]
fn the_default_delay_is_six_ticks_which_is_upstreams_100_ms() {
    assert_eq!(tick_ms(6), params::DEFAULT_MS);
    let mut port = Interpolator::new();
    port.push("p", "p", 1, json!({"x": 1.0}).as_object().cloned().expect("an object"), 1);
    assert_eq!(port.delay("p"), Some(params::DEFAULT_MS));
    let mut slow = Interpolator::with_delay_ticks(12);
    slow.push("p", "p", 1, json!({"x": 1.0}).as_object().cloned().expect("an object"), 1);
    assert_eq!(slow.delay("p"), Some(tick_ms(12)));
}

#[test]
fn tick_zero_is_a_real_stamp_and_a_non_finite_stamp_is_refused() {
    let mut port = Interpolator::new();
    port.push("p", "p", 0, json!({"x": 2.0}).as_object().cloned().expect("an object"), 0);
    assert_eq!(port.sample("p", 0), json!({"x": 2.0}).as_object().cloned(), "the first tick is a stamp in sim time");
    port.push_ms("q", "q", f64::NAN, json!({"x": 1.0}).as_object().cloned().expect("an object"), 10.0);
    assert!(port.sample("q", 1).is_none());
    assert!(port.sender_offset("q").is_none());
}
