//! The replay golden (IN-3): a scripted 60 s genex-core toy session (keys, pads, touches, text) is
//! journaled tick by tick, encoded, decoded, and fed straight into `Hooks::tick` on a fresh world:
//! every tick's input and every 60th tick's checksum come back equal, a flipped pad-axis bit shows
//! in the checksum, and the encoding stays within 2 KB per second.

use genex_core::clock::FIXED_STEP_MS;
use genex_core::digest::fnv1a64;
use genex_core::input::{Injection, PadAxis, PadButton, PadState, TickInput, TouchAction, TouchPhase, TouchStep, Vec2};
use genex_core::json::Value;
use genex_core::rng::{DEFAULT_SEQUENCE, Pcg32};
use genex_core::session::{CONTRACT_VERSION, Hooks, Session, checksum};
use genex_input::journal::InputJournal;
use genex_input::track::{InputTrack, TrackAnchor, TrackHeader};

/// 60 s at 60 Hz.
const SESSION_TICKS: u64 = 3600;
/// Checksums are compared every this many ticks.
const CHECK_EVERY: u64 = 60;
/// The encoding budget per second of play.
const BYTES_PER_SECOND_MAX: usize = 2048;
const SEED: u32 = 7;
/// A pad-axis value whose bits appear nowhere else in the track (the bit-flip row finds it).
const MARKED_AXIS: f32 = 0.618_034;

/// genex-core's golden toy (tests/goldens/toy.rs) plus readings of the pad axes, the pad family,
/// the pointer and the fingers, so every part of a row reaches the checksum.
#[derive(Clone, Debug, Default)]
struct Toy {
    x: f64,
    wheel: f64,
    jumps: i32,
    walked: i32,
    rolls: i32,
    drift: f64,
    text_bytes: i32,
    pad_presses: i32,
    axis_sum: f64,
    pointer_sum: f64,
    touch_sum: f64,
    touch_began: i32,
    touch_ended: i32,
    last_tick: i64,
}

impl Toy {
    fn probes(&self) -> Value {
        let mut probes = Value::object();
        probes.set("x", Value::from(self.x));
        probes.set("wheel", Value::from(self.wheel));
        probes.set("jumps", Value::from(self.jumps));
        probes.set("walked", Value::from(self.walked));
        probes.set("rolls", Value::from(self.rolls));
        probes.set("drift", Value::from(self.drift));
        probes.set("textBytes", Value::from(self.text_bytes));
        probes.set("padPresses", Value::from(self.pad_presses));
        probes.set("axisSum", Value::from(self.axis_sum));
        probes.set("pointerSum", Value::from(self.pointer_sum));
        probes.set("touchSum", Value::from(self.touch_sum));
        probes.set("touchBegan", Value::from(self.touch_began));
        probes.set("touchEnded", Value::from(self.touch_ended));
        probes.set("lastTick", Value::from(self.last_tick as f64));
        probes
    }
}

impl Hooks for Toy {
    fn reset(&mut self, _seed: u32) {
        *self = Toy { last_tick: -1, ..Toy::default() };
    }

    fn tick(&mut self, input: &TickInput, tick: u64, rng: &mut Pcg32) {
        self.x += f64::from(input.look.x);
        self.wheel += f64::from(input.wheel.y);
        if input.keys.pressed("Space") {
            self.jumps += 1;
        }
        if input.keys.down("w") {
            self.walked += 1;
        }
        self.rolls += rng.range_i32(1, 6);
        self.drift += f64::from(rng.range_f32(-0.5, 0.5));
        self.text_bytes += input.text.len() as i32;
        if input.pads.pressed(0, PadButton::A) {
            self.pad_presses += 1;
        }
        self.axis_sum += f64::from(input.pads.axis(0, PadAxis::LEFT_X)) + f64::from(input.pads.axis(0, PadAxis::LEFT_Y));
        self.axis_sum += f64::from(input.pads.value(0, PadButton::RIGHT_TRIGGER));
        self.pointer_sum += f64::from(input.pointer.x) + f64::from(input.pointer.y);
        for point in &input.touches {
            self.touch_sum += f64::from(point.x) - f64::from(point.y);
            match point.phase {
                TouchPhase::Began => self.touch_began += 1,
                TouchPhase::Ended | TouchPhase::Tapped => self.touch_ended += 1,
                TouchPhase::Held => {}
            }
        }
        self.last_tick = tick as i64;
    }
}

fn keys(names: &[&str]) -> Vec<String> {
    names.iter().map(|name| (*name).to_owned()).collect()
}

/// The scripted session's injection before tick `tick`: walking, jumps, a stick sweep with a
/// trigger, mouse look and wheel, typed text, pointer moves and two-finger touches.
fn script(tick: u64, pad: &mut PadState) -> Injection {
    let mut injection = Injection::default();
    match tick % 240 {
        0 => injection.down = keys(&["w"]),
        120 => injection.up = keys(&["w"]),
        _ => {}
    }
    if tick % 45 == 10 {
        injection.tap = keys(&["Space"]);
    }
    if tick % 300 == 150 {
        injection.down = keys(&["ShiftLeft", "KeyE"]);
    }
    if tick % 300 == 170 {
        injection.up = keys(&["ShiftLeft", "KeyE"]);
    }
    script_pad(tick, pad, &mut injection);
    if tick % 97 == 3 {
        injection.look = Vec2 { x: 3.25, y: -1.5 };
        injection.wheel = Vec2 { x: 0.0, y: 1.0 };
    }
    if tick % 600 == 400 {
        injection.text = "héllo 🎮".as_bytes().to_vec();
    }
    if tick % 200 == 50 {
        injection.pointer = Some(Vec2 { x: (tick % 1000) as f32 / 1000.0, y: 0.25 });
    }
    script_touches(tick, &mut injection);
    injection
}

fn script_pad(tick: u64, pad: &mut PadState, injection: &mut Injection) {
    if tick == 30 {
        *pad = PadState { connected: true, ..PadState::default() };
        injection.pads.push((0, *pad));
    }
    if tick < 30 {
        return;
    }
    let phase = tick % 600;
    if phase < 300 {
        // A 5 s stick sweep, a new value every tick.
        let t = phase as f32 / 300.0;
        pad.axes[0] = t * 2.0 - 1.0;
        pad.axes[1] = 1.0 - t;
        injection.pads.push((0, *pad));
    } else if phase == 300 {
        pad.axes = [MARKED_AXIS, 0.0, 0.0, 0.0];
        pad.buttons[0] = 1.0;
        injection.pads.push((0, *pad));
    } else if phase == 320 {
        pad.buttons[0] = 0.0;
        pad.buttons[7] = 0.8;
        injection.pads.push((0, *pad));
    } else if phase == 360 {
        pad.buttons[7] = 0.0;
        injection.pads.push((0, *pad));
    }
}

fn script_touches(tick: u64, injection: &mut Injection) {
    let phase = tick % 360;
    let finger = |id: u32, step: TouchStep, x: f32| TouchAction { id, step, x, y: 300.0 - x / 2.0 };
    match phase {
        100 => injection.touches = vec![finger(1, TouchStep::Start, 120.0), finger(2, TouchStep::Start, 500.0)],
        101..=160 if phase.is_multiple_of(4) => injection.touches = vec![finger(1, TouchStep::Move, 120.0 + phase as f32)],
        161 => injection.touches = vec![finger(1, TouchStep::End, 281.0), finger(2, TouchStep::End, 500.0)],
        200 => injection.touches = vec![finger(9, TouchStep::Start, 64.0), finger(9, TouchStep::End, 64.0)],
        _ => {}
    }
}

fn header() -> TrackHeader {
    TrackHeader { seed: SEED, contract: CONTRACT_VERSION, world: [960, 540], bindings_digest: 0, bindings: Vec::new() }
}

/// A recorded session: the journal, every tick's input and the checksum at every 60th tick.
struct Recording {
    journal: InputJournal,
    inputs: Vec<TickInput>,
    checksums: Vec<(u64, String)>,
}

fn record() -> Recording {
    let mut toy = Toy::default();
    let mut session = Session::new(FIXED_STEP_MS);
    session.seed(SEED, &mut toy);
    let mut journal = InputJournal::new(header());
    let mut pad = PadState::default();
    let (mut inputs, mut checksums) = (Vec::new(), Vec::new());
    for tick in 0..SESSION_TICKS {
        session.inject(&script(tick, &mut pad));
        session.step(FIXED_STEP_MS, &mut toy);
        journal.record(tick, session.last());
        inputs.push(session.last().clone());
        if (tick + 1) % CHECK_EVERY == 0 {
            checksums.push((tick + 1, checksum(SEED, tick + 1, &toy.probes())));
        }
    }
    Recording { journal, inputs, checksums }
}

/// Replay a track straight into `Hooks::tick` on a fresh world; the checksum every 60th tick.
fn replay(track: &InputTrack) -> (Vec<TickInput>, Vec<(u64, String)>) {
    let mut toy = Toy::default();
    toy.reset(track.header().seed);
    let mut rng = Pcg32::new(u64::from(track.header().seed), DEFAULT_SEQUENCE);
    let (mut inputs, mut checksums) = (Vec::new(), Vec::new());
    for (tick, input) in track.inputs() {
        toy.tick(&input, tick, &mut rng);
        if (tick + 1) % CHECK_EVERY == 0 {
            checksums.push((tick + 1, checksum(track.header().seed, tick + 1, &toy.probes())));
        }
        inputs.push(input);
    }
    (inputs, checksums)
}

#[test]
fn a_journaled_session_replays_every_input_and_checksum() {
    let recording = record();
    let view = recording.journal.view();
    assert!(view.complete, "60 s of play fits the journal whole");
    assert_eq!(view.ticks, SESSION_TICKS);
    let bytes = recording.journal.track().encode();
    let track = InputTrack::decode(&bytes).expect("the journal's own track decodes");
    assert_eq!(track.anchor(), TrackAnchor::Seed);
    assert!(track.complete());
    assert_eq!((track.start_tick(), track.ticks()), (0, SESSION_TICKS));
    assert_eq!(track.encode(), bytes, "decode and encode round-trip byte for byte");
    let (inputs, checksums) = replay(&track);
    assert_eq!(inputs.len(), recording.inputs.len());
    for (tick, (replayed, recorded)) in inputs.iter().zip(&recording.inputs).enumerate() {
        assert_eq!(replayed, recorded, "tick {tick} replays the input the run read");
    }
    assert_eq!(checksums.len(), (SESSION_TICKS / CHECK_EVERY) as usize);
    assert_eq!(checksums, recording.checksums, "every 60th tick's checksum is equal");
}

#[test]
fn a_flipped_pad_axis_bit_changes_the_replayed_checksum() {
    let recording = record();
    let mut bytes = recording.journal.track().encode();
    let marked = MARKED_AXIS.to_bits().to_le_bytes();
    let at = bytes.windows(4).position(|window| window == marked).expect("the marked axis value is in the track");
    bytes[at] ^= 1;
    let track = InputTrack::decode(&bytes).expect("a flipped value bit is still a well-formed track");
    let (_, checksums) = replay(&track);
    assert_ne!(checksums, recording.checksums, "the axis is carried bit for bit, so one bit shows");
    let first_differs = checksums.iter().zip(&recording.checksums).position(|(a, b)| a != b);
    assert!(first_differs.is_some());
}

#[test]
fn sixty_seconds_of_keyboard_pad_and_touch_encode_within_2_kb_per_second() {
    let bytes = record().journal.track().encode();
    let seconds = (SESSION_TICKS / 60) as usize;
    let per_second = bytes.len() / seconds;
    println!("track bytes {} over {seconds} s: {per_second} B/s", bytes.len());
    assert!(bytes.len() <= BYTES_PER_SECOND_MAX * seconds, "{} bytes over {seconds} s", bytes.len());
}

/// The encoding's digest, pinned: the same constant holds on every destination (host and wasm32),
/// since the format has no `usize`, no padding and no float formatting.
#[test]
fn the_session_encodes_to_the_pinned_bytes() {
    let bytes = record().journal.track().encode();
    let digest = fnv1a64(&bytes);
    println!("track digest {digest:016x}, {} bytes", bytes.len());
    assert_eq!(format!("{digest:016x}"), PINNED_DIGEST);
}

/// FNV-1a 64 of the scripted session's track bytes.
const PINNED_DIGEST: &str = "93ce3358f568fe7d";
