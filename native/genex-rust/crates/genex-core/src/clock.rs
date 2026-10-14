//! The simulation clock, ported from the C++ template's `clock.h`: fixed 1/60 s ticks, a frame
//! clamped to 250 ms so a stall never turns into a burst of catch-up ticks, and the tick count of
//! a scripted `step(ms)`. Frame times only pace live play; nothing in a simulation reads a wall
//! clock.

/// One simulation tick, in milliseconds.
pub const FIXED_STEP_MS: f64 = 1000.0 / 60.0;
/// The most wall time one rendered frame may feed the simulation.
pub const MAX_FRAME_MS: f64 = 250.0;
/// The most ticks one `step(ms)` runs: ten minutes of simulation.
pub const MAX_STEP_TICKS: u32 = 36_000;
/// Frame intervals [`FpsMeter::fps`] averages over.
pub const FPS_WINDOW: usize = 60;
/// Slack for a sum of float steps that lands a hair under a whole tick (250 / (1000/60) is 14.999…).
const TICK_EPSILON_MS: f64 = 1e-6;

/// The ticks `step(ms)` runs: max(1, round(ms / step_ms)), capped at [`MAX_STEP_TICKS`]; 1 when
/// the step is not a positive number.
pub fn step_ticks(ms: f64, step_ms: f64) -> u32 {
    if step_ms.is_nan() || step_ms <= 0.0 {
        return 1;
    }
    let ticks = (ms / step_ms).round();
    if ticks.is_nan() || ticks < 1.0 {
        return 1;
    }
    if ticks > f64::from(MAX_STEP_TICKS) {
        return MAX_STEP_TICKS;
    }
    // In 1..=MAX_STEP_TICKS here, so the conversion is exact.
    ticks as u32
}

/// Turns rendered frames' wall time into whole ticks, carrying the remainder.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FrameClock {
    step_ms: f64,
    carry: f64,
}

impl Default for FrameClock {
    fn default() -> Self {
        FrameClock::new(FIXED_STEP_MS)
    }
}

impl FrameClock {
    /// A clock of `step_ms` ticks.
    pub fn new(step_ms: f64) -> Self {
        FrameClock { step_ms, carry: 0.0 }
    }

    /// The ticks this frame is worth. NaN and negative frames are worth nothing; a frame counts
    /// at most [`MAX_FRAME_MS`].
    pub fn advance(&mut self, frame_ms: f64) -> u32 {
        if frame_ms.is_nan() || frame_ms <= 0.0 {
            return 0;
        }
        self.carry += if frame_ms < MAX_FRAME_MS { frame_ms } else { MAX_FRAME_MS };
        let mut ticks = 0;
        while self.carry + TICK_EPSILON_MS >= self.step_ms {
            self.carry -= self.step_ms;
            ticks += 1;
        }
        if self.carry < 0.0 {
            self.carry = 0.0;
        }
        ticks
    }

    /// Forget the carried remainder (seed and start do).
    pub fn reset(&mut self) {
        self.carry = 0.0;
    }

    /// Time carried towards the next tick, in milliseconds.
    pub fn carry(&self) -> f64 {
        self.carry
    }

    /// One tick, in milliseconds.
    pub fn step_ms(&self) -> f64 {
        self.step_ms
    }
}

/// The live frame rate, from the loop's own frame times: frames drawn for a verb (a step, a
/// capture) are not live frames and never reach it. A volatile figure, never compared.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FpsMeter {
    intervals: [f64; FPS_WINDOW],
    count: usize,
    next: usize,
    started: bool,
    last: f64,
}

impl Default for FpsMeter {
    fn default() -> Self {
        FpsMeter { intervals: [0.0; FPS_WINDOW], count: 0, next: 0, started: false, last: 0.0 }
    }
}

impl FpsMeter {
    /// One live frame at `now_ms`; a clock that stands still, runs backwards or is NaN adds no
    /// interval.
    pub fn frame(&mut self, now_ms: f64) {
        if now_ms.is_nan() {
            return;
        }
        if self.started && now_ms > self.last {
            self.intervals[self.next] = now_ms - self.last;
            self.next = (self.next + 1) % FPS_WINDOW;
            self.count = (self.count + 1).min(FPS_WINDOW);
        }
        self.started = true;
        self.last = now_ms;
    }

    /// Frames per second over the last [`FPS_WINDOW`] intervals; 0 before the first interval.
    pub fn fps(&self) -> f64 {
        // Summed oldest slot first, in slot order, as the C++ does.
        let total: f64 = self.intervals[..self.count].iter().fold(0.0, |sum, interval| sum + interval);
        if total > 0.0 { self.count as f64 * 1000.0 / total } else { 0.0 }
    }

    /// Forget every frame.
    pub fn reset(&mut self) {
        *self = FpsMeter::default();
    }
}
