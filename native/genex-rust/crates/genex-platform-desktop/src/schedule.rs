//! When the windowed loop runs a frame and what the frame feeds the game (review F2).
//!
//! The loop used to sleep on a CPU deadline until the next 60 Hz tick (RQ0.12's "no frame between
//! ticks"). That deadline lands at a random phase against the display, and the two clocks drift
//! (59.94 Hz panels, crystal skew), so near a refresh boundary the OS's wake-up jitter decided
//! which refresh showed a frame: on a 120 Hz panel new pictures came 1, 2 or 3 refreshes apart.
//! Now the display paces the loop, as a phone's or a page's does: a redraw is asked for every
//! refresh, the surface's Fifo present blocks the next acquire until the display takes a frame, a
//! frame without a tick re-presents the last world target (the game draws only frames that ticked,
//! RQ0.12), and each frame feeds the game whole refreshes through genex-core's [`RefreshPacer`]
//! (the monitor's reported rate, else the measured one). A redraw sooner than half a refresh after
//! the last (a surface that does not block, such as an occluded window's) runs nothing, so the
//! loop never spins faster than twice the refresh rate.

use genex_core::clock::RefreshPacer;

/// A redraw sooner than this share of a refresh after the last frame runs nothing.
const MIN_REDRAW_SHARE: f64 = 0.5;
/// The refresh assumed for that floor while none is known: the fastest listed display (240 Hz).
const UNKNOWN_REFRESH_MS: f64 = 1000.0 / 240.0;

/// The windowed loop's frame schedule: the last frame's time and the pacer.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct FrameSchedule {
    pacer: RefreshPacer,
    last_ms: Option<f64>,
    forced: bool,
}

impl FrameSchedule {
    /// The display's refresh interval, when the monitor reports one (None: measure it).
    pub(crate) fn set_refresh_ms(&mut self, refresh_ms: Option<f64>) {
        self.pacer.set_known_refresh_ms(refresh_ms);
    }

    /// The next redraw runs a frame whatever the time (a resize, a new window).
    pub(crate) fn force(&mut self) {
        self.forced = true;
    }

    /// A redraw at `now_ms`: the milliseconds the frame feeds the game (whole refreshes once the
    /// refresh is known; 0 for a refresh between ticks, which re-presents), or None when it came
    /// sooner than half a refresh after the last frame.
    pub(crate) fn redraw(&mut self, now_ms: f64) -> Option<f64> {
        let forced = std::mem::take(&mut self.forced);
        let Some(last) = self.last_ms else {
            self.last_ms = Some(now_ms);
            return Some(0.0);
        };
        if !forced && now_ms - last < self.floor_ms() {
            return None;
        }
        self.last_ms = Some(now_ms);
        Some(self.pacer.frame_ms(now_ms - last))
    }

    /// Milliseconds to wait at `now_ms` before the next redraw is asked for (0: ask now; the
    /// present then waits for the display).
    pub(crate) fn wait_ms(&self, now_ms: f64) -> f64 {
        match self.last_ms {
            Some(last) if !self.forced => (last + self.floor_ms() - now_ms).max(0.0),
            _ => 0.0,
        }
    }

    /// The shortest time between two frames.
    fn floor_ms(&self) -> f64 {
        self.pacer.refresh_ms().unwrap_or(UNKNOWN_REFRESH_MS) * MIN_REDRAW_SHARE
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use genex_core::clock::FrameClock;

    /// Simulated seconds per trace.
    const SECONDS: f64 = 10.0;
    /// Frames the display queues before acquiring the next drawable blocks (`desired_maximum_frame_latency`).
    const QUEUED: usize = 2;
    /// CPU and GPU time of a frame that draws the world, and of one that re-presents it.
    const DRAW_CPU_MS: f64 = 2.0;
    const DRAW_GPU_MS: f64 = 3.0;
    const REPEAT_CPU_MS: f64 = 0.2;
    const REPEAT_GPU_MS: f64 = 0.3;

    /// A deterministic share in 0..1 (a 32-bit LCG).
    struct Lcg(u32);

    impl Lcg {
        fn share(&mut self) -> f64 {
            self.0 = self.0.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            f64::from(self.0) / 4_294_967_296.0
        }
    }

    /// The windowed loop against a simulated Fifo display of `hz` (whose clock runs `skew` off the
    /// CPU's, as 59.94 Hz panels and drifting crystals do): the loop waits as the schedule says
    /// (woken 0.05-1 ms late), runs the frame the schedule hands it (drawing when it ticked,
    /// re-presenting otherwise) and presents it; a present shows at the first refresh after its GPU
    /// work, one per refresh, and acquiring a drawable blocks while `QUEUED` frames wait. Answers
    /// the refreshes between successive new pictures on screen.
    fn picture_gaps(hz: f64, skew: f64) -> Vec<u32> {
        let refresh = 1000.0 / hz * (1.0 + skew);
        let mut schedule = FrameSchedule::default();
        schedule.set_refresh_ms(Some(1000.0 / hz));
        let mut clock = FrameClock::default();
        let mut lcg = Lcg(12345);
        let (mut now, mut ticks) = (0.0_f64, 0_u32);
        let mut shown: Vec<(u64, u32)> = Vec::new();
        let mut pending: Vec<u64> = Vec::new();
        let mut last_shown: Option<u64> = None;
        while now < SECONDS * 1000.0 {
            let Some(fed) = schedule.redraw(now) else {
                now += schedule.wait_ms(now).max(0.1) + 0.05 + 0.95 * lcg.share();
                continue;
            };
            let ran = clock.advance(fed);
            ticks += ran;
            let drew = ran > 0 || shown.is_empty();
            now += if drew { DRAW_CPU_MS } else { REPEAT_CPU_MS };
            // Acquire: wait for the oldest queued frame to reach the screen while the queue is full.
            pending.retain(|vsync| *vsync as f64 * refresh > now);
            if pending.len() >= QUEUED {
                now = now.max(pending[0] as f64 * refresh);
                pending.remove(0);
            }
            let submitted = now + if drew { DRAW_GPU_MS } else { REPEAT_GPU_MS };
            let earliest = (submitted / refresh).ceil() as u64;
            let vsync = last_shown.map_or(earliest, |last| earliest.max(last + 1));
            last_shown = Some(vsync);
            pending.push(vsync);
            shown.push((vsync, ticks));
            now += schedule.wait_ms(now) + 0.05 + 0.95 * lcg.share();
        }
        // The refreshes between pictures that show a new tick, after a second of settling.
        let settle = (hz as u64).max(1);
        let firsts: Vec<u64> = shown.windows(2).filter(|pair| pair[1].1 != pair[0].1).map(|pair| pair[1].0).filter(|vsync| *vsync > settle).collect();
        firsts.windows(2).map(|pair| (pair[1] - pair[0]) as u32).collect()
    }

    /// Gaps outside `expected`, and the distinct gaps seen.
    fn judder(gaps: &[u32], expected: &[u32]) -> (usize, Vec<u32>) {
        let mut seen = gaps.to_vec();
        seen.sort_unstable();
        seen.dedup();
        (gaps.iter().filter(|gap| !expected.contains(gap)).count(), seen)
    }

    /// The reported judder: the loop slept on a CPU deadline at a random phase against the
    /// display, so on a 120 or 144 Hz panel (or a 60 Hz one whose clock drifts) pictures showed 1,
    /// 2 and 3 refreshes apart; woken by the display and fed whole refreshes, the gaps are the
    /// display's own (one refresh at 60 Hz, two at 120, two or three at 144).
    #[test]
    fn new_pictures_land_on_whole_refreshes_at_60_120_and_144_hz() {
        let rows: [(f64, f64, &[u32]); 5] =
            [(60.0, 0.001, &[1]), (60.0, -0.0007, &[1]), (120.0, 0.001, &[2]), (120.0, -0.0004, &[2]), (144.0, 0.0005, &[2, 3])];
        let mut failures = Vec::new();
        for (hz, skew, expected) in rows {
            let gaps = picture_gaps(hz, skew);
            let (off, seen) = judder(&gaps, expected);
            eprintln!("{hz} Hz skew {skew}: {off} of {} picture gaps off {expected:?} (seen {seen:?})", gaps.len());
            if off > 0 {
                failures.push(format!("{hz} Hz skew {skew}: {off} of {} off, seen {seen:?}", gaps.len()));
            }
        }
        assert!(failures.is_empty(), "{failures:?}");
    }

    /// Frames and ticks over one second of redraws every `every_ms`, on a display of `hz`.
    fn one_second(hz: f64, every_ms: f64) -> (u32, u32) {
        let mut schedule = FrameSchedule::default();
        schedule.set_refresh_ms(Some(1000.0 / hz));
        let mut clock = FrameClock::default();
        let (mut frames, mut ticks, mut now) = (0, 0, 0.0);
        while now < 1000.0 {
            if let Some(fed) = schedule.redraw(now) {
                frames += 1;
                ticks += clock.advance(fed);
            }
            now += every_ms;
        }
        (frames, ticks)
    }

    #[test]
    fn the_sim_runs_at_60_hz_on_any_display_and_a_slow_one_runs_two_ticks_a_frame() {
        for hz in [60.0, 120.0, 144.0, 240.0] {
            let (frames, ticks) = one_second(hz, 1000.0 / hz);
            assert!((59..=60).contains(&ticks), "{hz} Hz runs the sim at 60 Hz ({ticks} ticks, {frames} frames)");
        }
        let (frames, ticks) = one_second(30.0, 1000.0 / 30.0);
        assert_eq!((frames, ticks), (30, 58), "30 Hz: two ticks a frame after the first");
    }

    #[test]
    fn a_surface_that_never_blocks_runs_at_most_twice_the_refresh_rate() {
        let (frames, ticks) = one_second(60.0, 0.1);
        assert!(frames <= 121, "{frames} frames in a second of redraws every 0.1 ms");
        assert!((59..=60).contains(&ticks), "{ticks} ticks");
    }

    #[test]
    fn a_forced_redraw_runs_at_once_and_the_wait_ends_half_a_refresh_on() {
        let mut schedule = FrameSchedule::default();
        schedule.set_refresh_ms(Some(1000.0 / 60.0));
        assert_eq!(schedule.wait_ms(100.0), 0.0, "the first frame is asked for at once");
        assert_eq!(schedule.redraw(100.0), Some(0.0));
        assert_eq!(schedule.redraw(101.0), None, "1 ms after a frame");
        assert!((schedule.wait_ms(101.0) - (1000.0 / 120.0 - 1.0)).abs() < 1e-9);
        schedule.force();
        assert_eq!(schedule.wait_ms(101.0), 0.0);
        assert_eq!(schedule.redraw(101.0), Some(0.0), "a resize draws at once");
        assert!(schedule.wait_ms(101.0) > 0.0, "and the floor holds again");
    }
}
