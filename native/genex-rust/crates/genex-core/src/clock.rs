//! The simulation clock, ported from the C++ template's `clock.h`: fixed 1/60 s ticks, a frame
//! clamped to 250 ms so a stall never turns into a burst of catch-up ticks, and the tick count of
//! a scripted `step(ms)`. Frame times only pace live play; nothing in a simulation reads a wall
//! clock. [`RefreshPacer`] turns a shell's measured frame times into whole display refreshes
//! before they reach the clock, so jitter never decides whether a frame runs 0 or 2 ticks.

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
/// The display refresh rates [`RefreshPacer`] recognises, in Hz (the web shell's list).
pub const DISPLAY_RATES_HZ: [f64; 13] = [30.0, 48.0, 50.0, 60.0, 72.0, 75.0, 90.0, 100.0, 120.0, 144.0, 165.0, 180.0, 240.0];
/// A measured refresh within this share of a listed rate's interval is that rate (the nearest one).
const DISPLAY_RATE_TOLERANCE: f64 = 0.08;
/// The rate in use is kept while the measured refresh stays within this share of it.
const DISPLAY_RATE_KEEP: f64 = 0.15;
/// The refresh is the median of this many recent frame intervals.
pub const REFRESH_SAMPLES: usize = 31;
/// Only intervals shorter than this are refresh samples (a stall is not a refresh).
const REFRESH_SAMPLE_MAX_MS: f64 = 100.0;
/// A platform's own refresh interval is taken only inside this range, in milliseconds (a 500 Hz
/// panel to a 10 Hz one); anything else is no report.
const KNOWN_REFRESH_MS: std::ops::RangeInclusive<f64> = 2.0..=100.0;
/// How fast the frames' phase against the refreshes is followed (a share per frame).
const PHASE_FOLLOW: f64 = 1.0 / 32.0;

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

/// What one displayed frame feeds the live clock: whole display refreshes, never the frame's own
/// measured time (the web shell's `pacedFrameMs`, shared by every native shell).
///
/// A shell measures its frames with the jitter of its thread (±0.5-2 ms), and [`FrameClock`] turns
/// frame times into fixed 1000/60 ms ticks: when the tick rate matches the refresh (a 60 Hz phone)
/// or divides it (120 Hz), the carry sits on a tick's boundary and the jitter decides each frame
/// whether it runs 0 ticks (the old picture again) or 2 (a double step). The time not fed yet is
/// carried (`owed`), so none is lost, and it is rounded to refreshes around its own running mean
/// (`phase`), so the jitter stays clear of a half refresh.
///
/// The refresh is the platform's own report when it gives one ([`RefreshPacer::set_known_refresh_ms`]:
/// a display link's duration, a monitor's rate, a fixed loop's period), else the median of recent
/// frame intervals; either is snapped to the nearest listed rate ([`DISPLAY_RATES_HZ`]) within
/// 8%. Until a refresh is known, the frame's own time is fed.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RefreshPacer {
    samples: [f64; REFRESH_SAMPLES],
    count: usize,
    next: usize,
    known: Option<f64>,
    refresh: Option<f64>,
    owed: f64,
    phase: f64,
}

impl Default for RefreshPacer {
    fn default() -> Self {
        RefreshPacer { samples: [0.0; REFRESH_SAMPLES], count: 0, next: 0, known: None, refresh: None, owed: 0.0, phase: 0.0 }
    }
}

impl RefreshPacer {
    /// A pacer that measures the refresh from frame intervals.
    pub fn new() -> Self {
        RefreshPacer::default()
    }

    /// A pacer for a display (or a loop) that refreshes every `refresh_ms`.
    pub fn with_known_refresh_ms(refresh_ms: f64) -> Self {
        let mut pacer = RefreshPacer::default();
        pacer.set_known_refresh_ms(Some(refresh_ms));
        pacer
    }

    /// The platform's own refresh interval (None: measure it from the frames). A report outside
    /// 2..=100 ms, NaN or infinite is no report.
    pub fn set_known_refresh_ms(&mut self, refresh_ms: Option<f64>) {
        self.known = refresh_ms.filter(|ms| KNOWN_REFRESH_MS.contains(ms)).map(snap_refresh);
        if self.known.is_some() {
            self.refresh = self.known;
        }
    }

    /// The refresh interval in use, in milliseconds; None while it is not known yet.
    pub fn refresh_ms(&self) -> Option<f64> {
        self.refresh
    }

    /// The milliseconds a displayed frame `frame_ms` after the last one feeds the clock: a whole
    /// number of refreshes once the refresh is known (0 for a frame that came early), the frame's
    /// own time before. NaN and negative frames feed nothing and are not carried.
    pub fn frame_ms(&mut self, frame_ms: f64) -> f64 {
        if frame_ms.is_nan() || frame_ms <= 0.0 {
            return 0.0;
        }
        let ms = frame_ms.min(MAX_FRAME_MS);
        if ms < REFRESH_SAMPLE_MAX_MS {
            self.samples[self.next] = ms;
            self.next = (self.next + 1) % REFRESH_SAMPLES;
            self.count = (self.count + 1).min(REFRESH_SAMPLES);
        }
        self.refresh = self.known.or_else(|| self.measured_refresh());
        let Some(refresh) = self.refresh else {
            let fed = self.owed + ms;
            self.owed = 0.0;
            self.phase = 0.0;
            return fed;
        };
        self.owed += ms;
        let fed = ((self.owed - self.phase) / refresh).round().max(0.0) * refresh;
        self.owed -= fed;
        self.phase += (self.owed - self.phase) * PHASE_FOLLOW;
        fed
    }

    /// Forget the time owed and the phase (a start, a resume after the display was away); the
    /// refresh stays known.
    pub fn reset(&mut self) {
        self.owed = 0.0;
        self.phase = 0.0;
    }

    /// The refresh from the samples: the one in use while their median stays within 15% of it,
    /// else the nearest listed rate within 8%, else None.
    fn measured_refresh(&self) -> Option<f64> {
        if self.count < REFRESH_SAMPLES {
            return self.refresh;
        }
        let mut sorted = self.samples;
        sorted.sort_by(f64::total_cmp);
        let median = sorted[REFRESH_SAMPLES / 2];
        if let Some(current) = self.refresh
            && off(median, current) <= DISPLAY_RATE_KEEP
        {
            return Some(current);
        }
        listed_refresh(median)
    }
}

/// How far `measured` is from `interval`, as a share of `interval`.
fn off(measured: f64, interval: f64) -> f64 {
    (measured - interval).abs() / interval
}

/// The listed rate's interval nearest `measured` within [`DISPLAY_RATE_TOLERANCE`], if any.
fn listed_refresh(measured: f64) -> Option<f64> {
    DISPLAY_RATES_HZ
        .iter()
        .map(|hz| 1000.0 / hz)
        .filter(|interval| off(measured, *interval) <= DISPLAY_RATE_TOLERANCE)
        .min_by(|a, b| off(measured, *a).total_cmp(&off(measured, *b)))
}

/// A platform's report snapped to the nearest listed rate (a 59.94 Hz panel paces as 60 Hz), or
/// kept as reported when no listed rate is near.
fn snap_refresh(refresh_ms: f64) -> f64 {
    listed_refresh(refresh_ms).unwrap_or(refresh_ms)
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
