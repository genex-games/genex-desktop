//! What one display frame feeds the game's live clock (review F2). A phone ticks at its refresh
//! rate (60 Hz, or 60 voted on a ProMotion or 90/120 Hz panel), so the live clock's carry sits on a
//! tick's boundary, and the redraw's own `Instant` (taken after the platform's work, ±0.5-2 ms)
//! decided each frame whether it ran 0 ticks (the old picture again) or 2 (a double step). The
//! frame times go through genex-core's [`RefreshPacer`] instead: whole refreshes of the platform's
//! own refresh interval (iOS's display link, Android's display) or, until one is reported, of the
//! measured one. Dynamic resolution keeps reading the measured interval.

use genex_core::clock::RefreshPacer;
use std::time::Instant;

/// One display frame's times.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DisplayFrame {
    /// Wall time since the last display frame, in milliseconds (dynamic resolution reads it).
    pub display_ms: f64,
    /// What the frame feeds the live clock: whole refreshes, in milliseconds.
    pub fed_ms: f64,
}

/// Display frames' times: the last frame's instant and the pacer.
#[derive(Clone, Copy, Debug, Default)]
pub struct FrameTimes {
    last: Option<Instant>,
    pacer: RefreshPacer,
}

impl FrameTimes {
    /// The display frame at `now`.
    pub fn frame(&mut self, now: Instant) -> DisplayFrame {
        let display_ms = self.last.map_or(0.0, |last| now.duration_since(last).as_secs_f64() * 1000.0);
        self.last = Some(now);
        DisplayFrame { display_ms, fed_ms: self.pacer.frame_ms(display_ms) }
    }

    /// The platform's own refresh interval, when it reports one (None: measure it).
    pub fn set_refresh_ms(&mut self, refresh_ms: Option<f64>) {
        self.pacer.set_known_refresh_ms(refresh_ms);
    }

    /// The refresh interval the frames are paced on, once known.
    pub fn refresh_ms(&self) -> Option<f64> {
        self.pacer.refresh_ms()
    }

    /// The display was away (a resume): the next frame starts the count again, with nothing owed.
    pub fn reset(&mut self) {
        self.last = None;
        self.pacer.reset();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use genex_core::clock::{FrameClock, REFRESH_SAMPLES};
    use std::time::Duration;

    /// Display frames per trace.
    const FRAMES: usize = 600;

    /// Wake stamps of a `hz` display, each jittered by ±`spread` ms (a 32-bit LCG): the shell reads
    /// `Instant::now()` at its redraw, after the platform's own work.
    fn stamps(hz: f64, spread: f64) -> Vec<Instant> {
        let start = Instant::now();
        let mut state: u32 = 12345;
        (0..FRAMES)
            .map(|i| {
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                let wobble = (f64::from(state) / 4_294_967_296.0 - 0.5) * 2.0 * spread;
                start + Duration::from_secs_f64(((i + 1) as f64 * 1000.0 / hz + spread + wobble) / 1000.0)
            })
            .collect()
    }

    /// The ticks each frame ran, the live clock started on a tick's boundary as `start()` leaves it.
    fn ticks(times: &mut FrameTimes, stamps: &[Instant]) -> Vec<u32> {
        let mut clock = FrameClock::default();
        stamps.iter().map(|now| clock.advance(times.frame(*now).fed_ms)).collect()
    }

    fn off_beat(ticks: &[u32], from: usize, expected: &[u32]) -> usize {
        ticks.iter().skip(from).filter(|ran| !expected.contains(ran)).count()
    }

    /// The reported judder: a 60 Hz phone ticks at the refresh rate, so raw redraw times alternate
    /// 0 and 2 ticks; with the display's refresh (reported, or measured) every frame runs one.
    #[test]
    fn a_sixty_hertz_phone_runs_one_tick_per_display_frame() {
        let stamps = stamps(60.0, 1.0);
        let mut reported = FrameTimes::default();
        reported.set_refresh_ms(Some(1000.0 / 60.0));
        let reported_off = off_beat(&ticks(&mut reported, &stamps), 1, &[1]);
        let mut measured = FrameTimes::default();
        let measured_off = off_beat(&ticks(&mut measured, &stamps), 2 * REFRESH_SAMPLES, &[1]);
        eprintln!("60 Hz ±1 ms: {reported_off} (reported refresh) and {measured_off} (measured) of {FRAMES} frames off one tick");
        assert_eq!((reported_off, measured_off), (0, 0), "frames off one tick");
    }

    #[test]
    fn a_120_hertz_phone_ticks_every_second_frame() {
        let stamps = stamps(120.0, 1.0);
        let mut times = FrameTimes::default();
        times.set_refresh_ms(Some(1000.0 / 120.0));
        let ran = ticks(&mut times, &stamps);
        assert_eq!(off_beat(&ran, 1, &[0, 1]), 0, "no frame runs 2 ticks");
        let ticked: Vec<usize> = ran.iter().enumerate().skip(1).filter(|(_, ran)| **ran > 0).map(|(i, _)| i).collect();
        assert!(ticked.windows(2).all(|pair| pair[1] - pair[0] == 2), "a tick every second refresh");
    }

    #[test]
    fn dynamic_resolution_keeps_the_display_interval_and_a_resume_starts_again() {
        let start = Instant::now();
        let mut times = FrameTimes::default();
        times.set_refresh_ms(Some(1000.0 / 60.0));
        assert_eq!(times.frame(start).display_ms, 0.0);
        let frame = times.frame(start + Duration::from_micros(17_400));
        assert!((frame.display_ms - 17.4).abs() < 1e-9, "the measured interval: {}", frame.display_ms);
        times.reset();
        assert_eq!(times.frame(start + Duration::from_secs(5)).fed_ms, 0.0, "the first frame after a resume feeds nothing");
    }
}
