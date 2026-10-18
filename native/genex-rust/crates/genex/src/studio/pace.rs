//! When the Studio loop runs a live frame and what it feeds the clock (review F2).
//!
//! The loop wakes for the studio's requests as well as for its frames, and the OS wakes it a little
//! late every time. Live frames therefore run on absolute deadlines (`next += frame`), never a
//! relative `frame - elapsed` wait (whose oversleep accumulated into a 2-tick frame every 20-40
//! frames), a wake before the deadline serves the studio only, and each frame feeds the clock whole
//! frames through genex-core's [`RefreshPacer`], with the loop's own period as the known refresh:
//! a frame woken 0.05-1 ms late still runs exactly one tick.

use std::time::{Duration, Instant};

use genex_core::clock::RefreshPacer;

/// A live frame the loop is due to run.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct DueFrame {
    /// Wall time since the last live frame, in milliseconds (the frame timings' interval).
    pub(crate) interval_ms: f64,
    /// What the frame feeds the live clock: whole frames of the loop's period, in milliseconds.
    pub(crate) fed_ms: f64,
}

/// The loop's pace: the next frame's deadline and the pacer its frames go through.
#[derive(Debug)]
pub(crate) struct StudioPace {
    frame: Duration,
    next: Option<Instant>,
    last: Option<Instant>,
    pacer: RefreshPacer,
}

impl StudioPace {
    /// A pace of one live frame every `frame`.
    pub(crate) fn new(frame: Duration) -> StudioPace {
        let pacer = RefreshPacer::with_known_refresh_ms(frame.as_secs_f64() * 1000.0);
        StudioPace { frame, next: None, last: None, pacer }
    }

    /// The live frame at `now`, or None while its deadline is ahead (a studio request woke the
    /// loop). The next deadline is a frame after this one's; a loop that fell more than a frame
    /// behind (a stall) is due a frame after `now` instead, so it never runs a burst of frames.
    pub(crate) fn due(&mut self, now: Instant) -> Option<DueFrame> {
        if self.next.is_some_and(|next| now < next) {
            return None;
        }
        let interval_ms = self.last.map_or(0.0, |at| (now - at).as_secs_f64() * 1000.0);
        self.last = Some(now);
        let next = self.next.unwrap_or(now) + self.frame;
        self.next = Some(if next <= now { now + self.frame } else { next });
        Some(DueFrame { interval_ms, fed_ms: self.pacer.frame_ms(interval_ms) })
    }

    /// How long the loop waits at `now` for the next live frame (a studio request wakes it early).
    pub(crate) fn wait(&self, now: Instant) -> Duration {
        self.next.map_or(Duration::ZERO, |next| next.saturating_duration_since(now))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use genex_core::clock::FrameClock;

    /// One live frame at 60 Hz, as the loop runs it.
    const FRAME: Duration = Duration::from_micros(16_667);
    /// Live frames the trace runs.
    const FRAMES: usize = 600;

    /// A deterministic share in 0..1 (a 32-bit LCG).
    struct Lcg(u32);

    impl Lcg {
        fn share(&mut self) -> f64 {
            self.0 = self.0.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            f64::from(self.0) / 4_294_967_296.0
        }
    }

    fn ms(ms: f64) -> Duration {
        Duration::from_secs_f64(ms / 1000.0)
    }

    /// The loop of `studio::run` against a simulated clock: each wake serves the studio (0.2 ms),
    /// runs a due live frame (3 ms of drawing when it ticked), then waits; the OS wakes it 0.05-1 ms
    /// late, and every `request_every`-th wait a studio request wakes it early. Answers the ticks of
    /// every live frame run and the wall time the trace took.
    fn trace(request_every: usize) -> (Vec<u32>, Duration) {
        let start = Instant::now();
        let mut now = start;
        let mut pace = StudioPace::new(FRAME);
        let mut clock = FrameClock::default();
        let mut lcg = Lcg(12345);
        let mut ticks = Vec::new();
        let mut waits = 0;
        while ticks.len() < FRAMES {
            now += ms(0.2);
            if let Some(frame) = pace.due(now) {
                let ran = clock.advance(frame.fed_ms);
                ticks.push(ran);
                if ran > 0 {
                    now += ms(3.0);
                }
            }
            waits += 1;
            let wait = pace.wait(now);
            let early = request_every > 0 && waits % request_every == 0;
            now += if early { wait.mul_f64(lcg.share()) } else { wait + ms(0.05 + 0.95 * lcg.share()) };
        }
        (ticks, now - start)
    }

    #[test]
    fn every_live_frame_runs_one_tick_although_the_os_wakes_the_loop_late() {
        let traces: Vec<(usize, Vec<u32>, Duration)> = [0, 7]
            .map(|every| {
                let (ticks, took) = trace(every);
                (every, ticks, took)
            })
            .into();
        let offs: Vec<usize> = traces.iter().map(|(_, ticks, _)| ticks.iter().skip(1).filter(|ran| **ran != 1).count()).collect();
        for ((request_every, ticks, took), off) in traces.iter().zip(&offs) {
            eprintln!("requests every {request_every} waits: {off} of {FRAMES} live frames ran 0 or 2+ ticks");
            // No time is lost: the ticks run cover the wall time within a frame.
            let ran: u32 = ticks.iter().sum();
            let expected = took.as_secs_f64() / FRAME.as_secs_f64();
            assert!((f64::from(ran) - expected).abs() <= 2.0, "{ran} ticks in {expected:.1} frames of wall time");
        }
        assert_eq!(offs, [0, 0], "live frames off one tick (no requests, a request every 7 waits)");
    }

    #[test]
    fn a_loop_that_fell_behind_catches_up_without_a_burst() {
        let start = Instant::now();
        let mut pace = StudioPace::new(FRAME);
        assert!(pace.due(start).is_some());
        // A 200 ms stall (a cold compile): one frame feeds it, the next deadline is a frame on.
        let stalled = start + ms(200.0);
        let frame = pace.due(stalled).expect("a late frame is due");
        assert!(frame.fed_ms >= 183.0, "the stall is fed: {}", frame.fed_ms);
        assert_eq!(pace.wait(stalled), FRAME, "the next frame is a whole frame after the late one");
    }
}
