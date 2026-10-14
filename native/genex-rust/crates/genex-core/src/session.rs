//! The runtime's state machine, ported from the C++ template's `session.h`: seed, start, pause,
//! step and live frames over the fixed clock, the input merge and the rng, with the game reached
//! only through [`Hooks`]; `state()`'s snapshot and checksum; and the two meters the native verbs
//! read (the mixed audio's level, the frame timings).

use std::sync::{Mutex, PoisonError, TryLockError};

use crate::clock::{FIXED_STEP_MS, FrameClock, step_ticks};
use crate::digest::{fnv1a64, hex64};
use crate::input::{FrameSample, Injection, InputMerger, TickInput};
use crate::json::Value;
use crate::rng::{DEFAULT_SEQUENCE, Pcg32};

/// The seed a game starts on before anyone calls `seed()`.
pub const DEFAULT_SEED: u32 = 1;
/// The contract version `ready` and `state()` report.
pub const CONTRACT_VERSION: u32 = 1;
/// The probe key a game uses for values that differ between runs (timings); comparisons skip it.
pub const VOLATILE_KEY: &str = "volatile";

/// What `step(ms)` did.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct StepResult {
    /// Ticks this step ran.
    pub ticks: u32,
    /// The tick count after the step (`state().frame`).
    pub frame: u64,
    /// Simulated time after the step, in milliseconds.
    pub simulated_ms: f64,
}

/// How the session reaches the game.
pub trait Hooks {
    /// Rebuild the world from a seed.
    fn reset(&mut self, seed: u32);
    /// Run one fixed tick with its merged input; `rng` is the session's stream.
    fn tick(&mut self, input: &TickInput, tick: u64, rng: &mut Pcg32);
}

/// One game's simulation state.
#[derive(Clone, Debug)]
pub struct Session {
    step_ms: f64,
    clock: FrameClock,
    input: InputMerger,
    rng: Pcg32,
    last: TickInput,
    seed: u32,
    tick: u64,
    running: bool,
    render_pending: bool,
}

impl Default for Session {
    fn default() -> Self {
        Session::new(FIXED_STEP_MS)
    }
}

impl Session {
    /// A paused session of `step_ms` ticks on the default seed (the game is not reset until
    /// `seed()`).
    pub fn new(step_ms: f64) -> Session {
        Session {
            step_ms,
            clock: FrameClock::new(step_ms),
            input: InputMerger::default(),
            rng: Pcg32::default(),
            last: TickInput::default(),
            seed: DEFAULT_SEED,
            tick: 0,
            running: false,
            render_pending: false,
        }
    }

    /// Reset the world on `value`, pause, clear every held and pending input, and ask for one
    /// render.
    pub fn seed(&mut self, value: u32, hooks: &mut impl Hooks) -> u32 {
        self.seed = value;
        self.rng.reseed(u64::from(value), DEFAULT_SEQUENCE);
        self.tick = 0;
        self.clock.reset();
        self.input.clear();
        self.last = TickInput::default();
        self.running = false;
        hooks.reset(value);
        self.render_pending = true;
        value
    }

    /// Resume live play; answers `running`.
    pub fn start(&mut self) -> bool {
        self.running = true;
        self.clock.reset();
        self.running
    }

    /// Freeze live play; answers `running` (false).
    pub fn pause(&mut self) -> bool {
        self.running = false;
        self.running
    }

    /// Whether live play runs.
    pub fn running(&self) -> bool {
        self.running
    }

    fn run_tick(&mut self, hooks: &mut impl Hooks) {
        self.last = self.input.next_tick();
        hooks.tick(&self.last, self.tick, &mut self.rng);
        self.tick += 1;
    }

    /// Run max(1, round(ms / step)) ticks, whether or not the game is running, and ask for one
    /// render.
    pub fn step(&mut self, ms: f64, hooks: &mut impl Hooks) -> StepResult {
        let ticks = step_ticks(ms, self.step_ms);
        for _ in 0..ticks {
            self.run_tick(hooks);
        }
        self.render_pending = true;
        StepResult { ticks, frame: self.tick, simulated_ms: self.simulated_ms() }
    }

    /// Live play: the ticks one rendered frame of `frame_ms` is worth (none while paused).
    pub fn frame(&mut self, frame_ms: f64, hooks: &mut impl Hooks) -> u32 {
        if !self.running {
            return 0;
        }
        let ticks = self.clock.advance(frame_ms);
        for _ in 0..ticks {
            self.run_tick(hooks);
        }
        self.render_pending = true;
        ticks
    }

    /// Apply injected input; answers the keys now held.
    pub fn inject(&mut self, injection: &Injection) -> Vec<String> {
        self.input.inject(injection);
        self.input.held()
    }

    /// Real input for the frame about to run.
    pub fn sample(&mut self, sample: &FrameSample) {
        self.input.sample(sample);
    }

    /// Whether a render is due (after seed, step or a live frame); true once per request.
    pub fn take_render(&mut self) -> bool {
        std::mem::take(&mut self.render_pending)
    }

    /// Ask for a render (a camera change, a capture).
    pub fn request_render(&mut self) {
        self.render_pending = true;
    }

    /// Ticks run since the seed.
    pub fn tick(&self) -> u64 {
        self.tick
    }

    /// Simulated time since the seed, in milliseconds.
    pub fn simulated_ms(&self) -> f64 {
        self.tick as f64 * self.step_ms
    }

    /// The seed the world was last reset on.
    pub fn seed_value(&self) -> u32 {
        self.seed
    }

    /// One tick, in milliseconds.
    pub fn step_ms(&self) -> f64 {
        self.step_ms
    }

    /// The session's stream.
    pub fn rng(&mut self) -> &mut Pcg32 {
        &mut self.rng
    }

    /// Real and injected held keys, canonical and sorted.
    pub fn held(&self) -> Vec<String> {
        self.input.held()
    }

    /// The input the last tick ran with.
    pub fn last(&self) -> &TickInput {
        &self.last
    }
}

/// The parts of `state()` only the platform side knows.
#[derive(Clone, Debug, PartialEq)]
pub struct StateExtras {
    /// The live frame rate.
    pub fps: f64,
    /// The active camera's name.
    pub camera: String,
    /// The game's own probe leaves; a probe never replaces a runtime key.
    pub probes: Value,
    /// `{items, crosshair, flash}`; null reports an empty HUD.
    pub hud: Value,
    /// `{drawCalls, triangles}` from the runtime's own counter; null reports none.
    pub render: Value,
    /// Files the game reported loading; null reports none.
    pub assets: Value,
    /// The game's error, or "" for none.
    pub error: String,
    /// The player's report, or null.
    pub player: Value,
}

impl Default for StateExtras {
    fn default() -> Self {
        StateExtras {
            fps: 0.0,
            camera: "default".to_owned(),
            probes: Value::Null,
            hud: Value::Null,
            render: Value::Null,
            assets: Value::Null,
            error: String::new(),
            player: Value::Null,
        }
    }
}

fn empty_hud() -> Value {
    let mut hud = Value::object();
    hud.set("items", Value::array());
    hud.set("crosshair", Value::Bool(false));
    hud.set("flash", Value::from(0));
    hud
}

fn no_draws() -> Value {
    let mut render = Value::object();
    render.set("drawCalls", Value::from(0));
    render.set("triangles", Value::from(0));
    render
}

/// FNV-1a 64 (hex) of the simulation's leaves: the seed, the tick and the probes except
/// `volatile`, dumped as `{"seed","frame","probes"}`.
pub fn checksum(seed: u32, tick: u64, probes: &Value) -> String {
    let mut leaves = Value::object();
    leaves.set("seed", Value::from(seed));
    leaves.set("frame", Value::from(tick));
    let mut kept = Value::object();
    for (key, value) in probes.members() {
        if key != VOLATILE_KEY.as_bytes() {
            kept.set(key.clone(), value.clone());
        }
    }
    leaves.set("probes", kept);
    hex64(fnv1a64(&leaves.dump()))
}

/// What `state()` reads of a simulation: a [`Session`]'s, or a runtime's that keeps its own
/// (the genex facade, whose hooks need a mutable world beside the clock).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SessionView<'a> {
    /// The seed the world was last reset on.
    pub seed: u32,
    /// Ticks run since the seed.
    pub tick: u64,
    /// Simulated time since the seed, in milliseconds.
    pub simulated_ms: f64,
    /// Whether live play runs.
    pub running: bool,
    /// Held keys, canonical and sorted.
    pub held: &'a [String],
    /// Whether the last tick ran with the pointer locked.
    pub pointer_lock: bool,
}

/// `state()`: the web contract's StudioState (`version, seed, frame, simulatedMs, running, fps,
/// held, pointerLock, hud, camera, error, player`) plus `contractVersion`, `volatile{fps}`,
/// `__render`, `assets`, `checksum` and the game's probes.
pub fn snapshot(session: &Session, extras: &StateExtras) -> Value {
    let held = session.held();
    let view = SessionView {
        seed: session.seed_value(),
        tick: session.tick(),
        simulated_ms: session.simulated_ms(),
        running: session.running(),
        held: &held,
        pointer_lock: session.last().pointer_lock,
    };
    snapshot_view(&view, extras)
}

/// [`snapshot`] over a [`SessionView`]: the same keys in the same order, the same checksum.
pub fn snapshot_view(session: &SessionView<'_>, extras: &StateExtras) -> Value {
    let mut state = Value::object();
    state.set("version", Value::from(CONTRACT_VERSION));
    state.set("contractVersion", Value::from(CONTRACT_VERSION));
    state.set("seed", Value::from(session.seed));
    state.set("frame", Value::from(session.tick));
    state.set("simulatedMs", Value::from(session.simulated_ms));
    state.set("running", Value::from(session.running));
    state.set("fps", Value::from(extras.fps));
    let mut held = Value::array();
    for key in session.held {
        held.push(Value::from(key.as_str()));
    }
    state.set("held", held);
    state.set("pointerLock", Value::from(session.pointer_lock));
    state.set("hud", if extras.hud.is_null() { empty_hud() } else { extras.hud.clone() });
    state.set("camera", Value::from(extras.camera.as_str()));
    state.set("error", if extras.error.is_empty() { Value::Null } else { Value::from(extras.error.as_str()) });
    state.set("player", extras.player.clone());
    let mut volatile_values = Value::object();
    volatile_values.set("fps", Value::from(extras.fps));
    state.set(VOLATILE_KEY, volatile_values);
    state.set("__render", if extras.render.is_null() { no_draws() } else { extras.render.clone() });
    state.set("assets", if extras.assets.is_null() { Value::array() } else { extras.assets.clone() });
    state.set("checksum", Value::from(checksum(session.seed, session.tick, &extras.probes)));
    for (key, value) in extras.probes.members() {
        if state.get_bytes(key).is_none() {
            state.set(key.clone(), value.clone());
        }
    }
    state
}

/// Stereo frames the audio level is measured over (a power of two: the centroid's FFT size).
pub const AUDIO_WINDOW_FRAMES: usize = 2048;

/// What `audioLevel` answers.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct AudioLevel {
    /// Root mean square of every sample in the window: 0 for silence, 1 for a full-scale square
    /// wave.
    pub rms: f64,
    /// Spectral centroid of the window's mono mix, in Hz; 0 for silence.
    pub centroid: f64,
}

#[derive(Clone, Debug)]
struct Ring {
    samples: Vec<f32>,
    next: usize,
    filled: usize,
}

/// The last [`AUDIO_WINDOW_FRAMES`] frames the mixer played. `feed` runs on the audio thread and
/// never waits: a block that arrives while `level` reads is dropped, which a level reading cannot
/// tell.
#[derive(Debug)]
pub struct AudioMeter {
    ring: Mutex<Ring>,
}

impl Default for AudioMeter {
    fn default() -> Self {
        AudioMeter { ring: Mutex::new(Ring { samples: vec![0.0; AUDIO_WINDOW_FRAMES * 2], next: 0, filled: 0 }) }
    }
}

/// A complex number with the C++ library's arithmetic (separate products, never fused).
#[derive(Clone, Copy, Debug, Default)]
struct Complex {
    re: f64,
    im: f64,
}

impl Complex {
    fn times(self, other: Complex) -> Complex {
        let (ac, bd) = (self.re * other.re, self.im * other.im);
        let (ad, bc) = (self.re * other.im, self.im * other.re);
        Complex { re: ac - bd, im: ad + bc }
    }

    fn plus(self, other: Complex) -> Complex {
        Complex { re: self.re + other.re, im: self.im + other.im }
    }

    fn minus(self, other: Complex) -> Complex {
        Complex { re: self.re - other.re, im: self.im - other.im }
    }
}

/// A mixed sample as the device plays it: clipped to full scale, and anything not finite (a
/// broken effect's output) as silence, so the level is always a finite number.
fn finite_sample(sample: f32) -> f64 {
    if sample.is_finite() { f64::from(sample).clamp(-1.0, 1.0) } else { 0.0 }
}

/// In-place radix-2 FFT; `values.len()` is a power of two.
#[allow(
    clippy::disallowed_methods,
    reason = "std::polar's platform cos/sin, as the C++ meter reads them: the audio level is a volatile reading, never in the checksum or a golden compared across targets"
)]
fn fft(values: &mut [Complex]) {
    let n = values.len();
    let mut j = 0;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j ^= bit;
        if i < j {
            values.swap(i, j);
        }
    }
    let mut length = 2;
    while length <= n {
        // The platform's cos and sin, as std::polar reads them: the level is a volatile reading.
        let theta = -2.0 * std::f64::consts::PI / length as f64;
        let step = Complex { re: theta.cos(), im: theta.sin() };
        for start in (0..n).step_by(length) {
            let mut turn = Complex { re: 1.0, im: 0.0 };
            for k in 0..length / 2 {
                let even = values[start + k];
                let odd = values[start + k + length / 2].times(turn);
                values[start + k] = even.plus(odd);
                values[start + k + length / 2] = even.minus(odd);
                turn = turn.times(step);
            }
        }
        length <<= 1;
    }
}

/// The magnitude-weighted mean frequency of `mono` (Hann-windowed, zero-padded to the window).
#[allow(
    clippy::disallowed_methods,
    reason = "the C++ meter's platform cos and hypot: the audio level is a volatile reading, never in the checksum or a golden compared across targets"
)]
fn centroid_of(mono: &[f64], sample_rate_hz: f64) -> f64 {
    let mut bins = vec![Complex::default(); AUDIO_WINDOW_FRAMES];
    let count = mono.len() as f64;
    for (i, (bin, sample)) in bins.iter_mut().zip(mono).enumerate() {
        let angle = 2.0 * std::f64::consts::PI * i as f64 / count;
        let hann = 0.5 - 0.5 * angle.cos();
        *bin = Complex { re: sample * hann, im: 0.0 };
    }
    fft(&mut bins);
    let mut weighted = 0.0;
    let mut total = 0.0;
    for (k, bin) in bins.iter().enumerate().take(AUDIO_WINDOW_FRAMES / 2 + 1).skip(1) {
        let magnitude = bin.re.hypot(bin.im);
        weighted += magnitude * k as f64 * sample_rate_hz / AUDIO_WINDOW_FRAMES as f64;
        total += magnitude;
    }
    if total > 0.0 { weighted / total } else { 0.0 }
}

impl AudioMeter {
    /// Take interleaved stereo float frames (`samples.len() / 2` of them).
    pub fn feed(&self, samples: &[f32]) {
        let mut ring = match self.ring.try_lock() {
            Ok(ring) => ring,
            Err(TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
            Err(TryLockError::WouldBlock) => return,
        };
        let (frames, _) = samples.as_chunks::<2>();
        for &[left, right] in frames {
            let at = ring.next * 2;
            ring.samples[at] = left;
            ring.samples[at + 1] = right;
            ring.next = (ring.next + 1) % AUDIO_WINDOW_FRAMES;
        }
        ring.filled = AUDIO_WINDOW_FRAMES.min(ring.filled + frames.len());
    }

    /// The window's level, the centroid in Hz for a mixer running at `sample_rate_hz`.
    pub fn level(&self, sample_rate_hz: f64) -> AudioLevel {
        let mut mono = Vec::new();
        let mut squares = 0.0;
        {
            let ring = self.ring.lock().unwrap_or_else(PoisonError::into_inner);
            let first = (ring.next + AUDIO_WINDOW_FRAMES - ring.filled) % AUDIO_WINDOW_FRAMES;
            for i in 0..ring.filled {
                let frame = (first + i) % AUDIO_WINDOW_FRAMES;
                let left = finite_sample(ring.samples[frame * 2]);
                let right = finite_sample(ring.samples[frame * 2 + 1]);
                let (left_square, right_square) = (left * left, right * right);
                squares += left_square + right_square;
                mono.push((left + right) / 2.0);
            }
        }
        if mono.is_empty() {
            return AudioLevel::default();
        }
        AudioLevel { rms: (squares / (mono.len() * 2) as f64).sqrt(), centroid: centroid_of(&mono, sample_rate_hz) }
    }
}

/// Frames the timing means are taken over (two seconds at 60 Hz).
pub const TIMING_WINDOW_FRAMES: usize = 120;

/// What `timing` answers: means over the last [`TIMING_WINDOW_FRAMES`], and every frame counted.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Timings {
    /// Mean interval between frames, in milliseconds.
    pub frame_ms: f64,
    /// Mean time a frame's ticks took.
    pub update_ms: f64,
    /// Mean time a frame's drawing took.
    pub draw_ms: f64,
    /// Every frame recorded, averaged or not.
    pub frames: u64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct TimingSample {
    frame_ms: f64,
    update_ms: f64,
    draw_ms: f64,
}

/// Where each rendered frame's time went, on the game's own clock.
#[derive(Clone, Debug, PartialEq)]
pub struct FrameTiming {
    samples: [TimingSample; TIMING_WINDOW_FRAMES],
    next: usize,
    filled: usize,
    frames: u64,
}

impl Default for FrameTiming {
    fn default() -> Self {
        FrameTiming { samples: [TimingSample::default(); TIMING_WINDOW_FRAMES], next: 0, filled: 0, frames: 0 }
    }
}

impl FrameTiming {
    /// One frame: the interval since the last one, the time its ticks took and its drawing took.
    /// A frame with no interval yet (the first) passes NaN: counted, not averaged.
    pub fn record(&mut self, frame_ms: f64, update_ms: f64, draw_ms: f64) {
        self.frames += 1;
        if !(frame_ms.is_finite() && update_ms.is_finite() && draw_ms.is_finite()) {
            return;
        }
        self.samples[self.next] = TimingSample { frame_ms, update_ms, draw_ms };
        self.next = (self.next + 1) % TIMING_WINDOW_FRAMES;
        self.filled = TIMING_WINDOW_FRAMES.min(self.filled + 1);
    }

    /// The means over the window, summed slot by slot as the C++ does.
    pub fn timings(&self) -> Timings {
        let mut out = Timings { frames: self.frames, ..Timings::default() };
        if self.filled == 0 {
            return out;
        }
        for sample in &self.samples[..self.filled] {
            out.frame_ms += sample.frame_ms;
            out.update_ms += sample.update_ms;
            out.draw_ms += sample.draw_ms;
        }
        let count = self.filled as f64;
        out.frame_ms /= count;
        out.update_ms /= count;
        out.draw_ms /= count;
        out
    }
}
