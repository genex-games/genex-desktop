//! Settled captures drain the view set (game systems STR-25): before a capture is drawn, the view
//! set updates from the captured camera until every model and group it wants is resident or
//! refused, so a capture's digest never depends on IO timing. Live frames never drain.
//!
//! - A drain is passes of `StreamView::update` with no tick and no draw. It is settled when no cell
//!   is building, no read is in flight or waiting to be finished, and nothing the view draws is
//!   loading (a load the content pool has no room for is as settled as it will get).
//! - A drain is capped at [`STREAM_DRAIN_MAX_MS`] (6 s, under the host's 10 s call timeout): past
//!   it the capture is drawn with what is resident, and `state().volatile.__stream.view` reads
//!   `timeout: "stream-drain-timeout"` until the next drain settles.
//! - Natively the capture verb drains on its own thread between passes ([`drain_blocking`], a
//!   1 ms pause each, the time injectable); the web shell awaits the page between passes
//!   ([`Drain`]), so its fetches land and the page keeps answering.

use std::time::Duration;

/// The longest a settled capture's drain lasts, in milliseconds, before the capture is drawn with
/// what is resident (`stream-drain-timeout`).
pub const STREAM_DRAIN_MAX_MS: f64 = 6000.0;
/// How long a native drain pauses between passes.
pub const STREAM_DRAIN_POLL: Duration = Duration::from_millis(1);

/// How a drain ended: its passes, its milliseconds and whether it ran out of time.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct DrainReport {
    /// View-set updates the drain ran (0 for a game without streaming).
    pub passes: u32,
    /// Milliseconds it took, by its clock.
    pub ms: f64,
    /// Whether it stopped at its cap with something still loading.
    pub timed_out: bool,
}

/// What a drain does after a pass.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DrainStep {
    /// Everything wanted is resident or refused: draw the capture.
    Settled,
    /// Something still loads: pause, then run another pass.
    Again,
    /// The cap passed: draw the capture with what is resident.
    TimedOut,
}

/// One drain, a pass at a time (the web awaits the page between passes; [`drain_blocking`] sleeps).
#[derive(Clone, Copy, Debug)]
pub struct Drain {
    started_ms: f64,
    max_ms: f64,
    passes: u32,
    last_ms: f64,
    timed_out: bool,
}

impl Drain {
    /// A drain started at `now_ms` that may last `max_ms` ([`STREAM_DRAIN_MAX_MS`] in a shell).
    pub fn start(now_ms: f64, max_ms: f64) -> Drain {
        Drain { started_ms: now_ms, max_ms, passes: 0, last_ms: now_ms, timed_out: false }
    }

    /// A pass ran at `now_ms` and left the view set `settled` or not: what to do next.
    pub fn after_pass(&mut self, settled: bool, now_ms: f64) -> DrainStep {
        self.passes = self.passes.saturating_add(1);
        self.last_ms = now_ms;
        if settled {
            return DrainStep::Settled;
        }
        if now_ms - self.started_ms >= self.max_ms {
            self.timed_out = true;
            return DrainStep::TimedOut;
        }
        DrainStep::Again
    }

    /// How it ended (or stands).
    pub fn report(&self) -> DrainReport {
        DrainReport { passes: self.passes, ms: (self.last_ms - self.started_ms).max(0.0), timed_out: self.timed_out }
    }
}

/// The clock a native drain is timed with, and its pause between passes.
pub trait DrainClock {
    /// Milliseconds on this clock.
    fn now_ms(&mut self) -> f64;
    /// Wait before the next pass (the wall clock sleeps [`STREAM_DRAIN_POLL`]; a test clock moves).
    fn pause(&mut self);
}

/// The process's monotonic clock (host glue: the simulation never sees it).
#[cfg(not(target_arch = "wasm32"))]
#[derive(Debug)]
pub struct WallDrainClock {
    #[allow(clippy::disallowed_types, reason = "host glue: a capture's drain is timed on the wall clock; the simulation never sees it")]
    start: std::time::Instant,
}

#[cfg(not(target_arch = "wasm32"))]
impl Default for WallDrainClock {
    #[allow(clippy::disallowed_types, reason = "host glue: a capture's drain is timed on the wall clock; the simulation never sees it")]
    fn default() -> WallDrainClock {
        WallDrainClock { start: std::time::Instant::now() }
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl DrainClock for WallDrainClock {
    fn now_ms(&mut self) -> f64 {
        self.start.elapsed().as_secs_f64() * 1000.0
    }

    fn pause(&mut self) {
        std::thread::sleep(STREAM_DRAIN_POLL);
    }
}

/// Drain by running `pass` (one view-set update, answering whether it settled) until it settles or
/// `max_ms` pass on `clock`, pausing between passes. A pass's error (a lost device) ends the drain.
pub fn drain_blocking<E>(clock: &mut dyn DrainClock, max_ms: f64, mut pass: impl FnMut() -> Result<bool, E>) -> Result<DrainReport, E> {
    let mut drain = Drain::start(clock.now_ms(), max_ms);
    loop {
        let settled = pass()?;
        match drain.after_pass(settled, clock.now_ms()) {
            DrainStep::Settled | DrainStep::TimedOut => return Ok(drain.report()),
            DrainStep::Again => clock.pause(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A clock that moves `step_ms` each pause.
    struct Steps {
        now: f64,
        step_ms: f64,
        pauses: u32,
    }

    impl DrainClock for Steps {
        fn now_ms(&mut self) -> f64 {
            self.now
        }

        fn pause(&mut self) {
            self.now += self.step_ms;
            self.pauses += 1;
        }
    }

    #[test]
    fn a_drain_stops_when_settled_or_at_its_cap_and_never_before_one_pass() {
        let mut clock = Steps { now: 100.0, step_ms: 250.0, pauses: 0 };
        let mut left = 3;
        let report = drain_blocking::<()>(&mut clock, STREAM_DRAIN_MAX_MS, || {
            left -= 1;
            Ok(left == 0)
        })
        .expect("drained");
        assert_eq!(report, DrainReport { passes: 3, ms: 500.0, timed_out: false });
        let mut clock = Steps { now: 0.0, step_ms: 250.0, pauses: 0 };
        let report = drain_blocking::<()>(&mut clock, STREAM_DRAIN_MAX_MS, || Ok(false)).expect("drained");
        assert!(report.timed_out && report.ms >= STREAM_DRAIN_MAX_MS && report.ms < STREAM_DRAIN_MAX_MS + 250.0, "{report:?}");
        assert_eq!(report.passes, clock.pauses + 1);
        let mut clock = Steps { now: 0.0, step_ms: 1.0, pauses: 0 };
        assert_eq!(drain_blocking(&mut clock, STREAM_DRAIN_MAX_MS, || Err("device-lost")), Err("device-lost"));
    }
}
