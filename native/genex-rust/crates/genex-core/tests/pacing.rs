//! The live clock fed whole display refreshes ([`RefreshPacer`], review F2): the tick-count trace a
//! 60, 120 or 144 Hz display runs, with frame times jittered as a busy thread stamps them, has no
//! 0/2 alternation, and no time is lost. The rows are the web shell's pacing rows
//! (`rust-shell-boot.test.ts`), held by the native port.

use genex_core::clock::{FIXED_STEP_MS, FrameClock, REFRESH_SAMPLES, RefreshPacer};

/// Frames per trace (ten seconds at 72 Hz, five at 144).
const FRAMES: usize = 720;
/// Where the sim's tick falls between two refreshes depends on when the game started: every
/// eighth of one is tried.
const PHASES: usize = 8;

/// A deterministic jitter in ±`spread` ms (the web row's 32-bit LCG).
fn jitter(count: usize, spread: f64) -> Vec<f64> {
    let mut state: u32 = 12345;
    (0..count)
        .map(|_| {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (f64::from(state) / 4_294_967_296.0 - 0.5) * 2.0 * spread
        })
        .collect()
}

/// Frame stamps of a `hz` display started `phase` eighths of a refresh in, jittered by ±`spread`.
fn stamps(hz: f64, spread: f64, phase: usize) -> Vec<f64> {
    let refresh = 1000.0 / hz;
    let start = 1000.0 + phase as f64 * refresh / PHASES as f64;
    jitter(FRAMES, spread).iter().enumerate().map(|(i, wobble)| start + (i + 1) as f64 * refresh + wobble).collect()
}

/// The (fed ms, ticks) of every frame: the clock starts at a whole tick, as `start()` leaves it.
fn trace(times: &[f64], mut feed: impl FnMut(f64) -> f64) -> Vec<(f64, u32)> {
    let mut clock = FrameClock::default();
    let mut last = None;
    times
        .iter()
        .map(|&now| {
            let frame_ms = last.map_or(0.0, |at| now - at);
            last = Some(now);
            let fed = feed(frame_ms);
            (fed, clock.advance(fed))
        })
        .collect()
}

/// The sorted distinct gaps, in frames, between frames that ran a tick, from frame `from` on.
fn tick_gaps(paced: &[(f64, u32)], from: usize) -> Vec<usize> {
    let ticked: Vec<usize> = paced.iter().enumerate().filter(|(i, (_, ticks))| *i >= from && *ticks > 0).map(|(i, _)| i).collect();
    let mut gaps: Vec<usize> = ticked.windows(2).map(|pair| pair[1] - pair[0]).collect();
    gaps.sort_unstable();
    gaps.dedup();
    gaps
}

/// Frames from `from` on that ran other than `expected` ticks.
fn off_beat(paced: &[(f64, u32)], from: usize, expected: &[u32]) -> usize {
    paced.iter().skip(from).filter(|(_, ticks)| !expected.contains(ticks)).count()
}

struct Row {
    hz: f64,
    spread: f64,
    gaps: &'static [usize],
}

const ROWS: [Row; 3] =
    [Row { hz: 120.0, spread: 2.0, gaps: &[2] }, Row { hz: 60.0, spread: 2.0, gaps: &[1] }, Row { hz: 144.0, spread: 1.5, gaps: &[2, 3] }];

#[test]
fn measured_refreshes_tick_every_whole_refresh_count_with_no_time_lost() {
    for row in ROWS {
        for phase in 0..PHASES {
            let times = stamps(row.hz, row.spread, phase);
            let mut pacer = RefreshPacer::new();
            let paced = trace(&times, |ms| pacer.frame_ms(ms));
            let label = format!("{} Hz ±{} ms, phase {phase}/{PHASES}", row.hz, row.spread);
            // The web row's warm-up: the refresh is measured over REFRESH_SAMPLES frames.
            let warm_up = 2 * REFRESH_SAMPLES;
            assert_eq!(tick_gaps(&paced, warm_up), row.gaps, "{label}: frames between ticks");
            assert_eq!(off_beat(&paced, warm_up, &[0, 1]), 0, "{label}: no frame ran 2 ticks");
            let fed: f64 = paced.iter().skip(1).map(|(ms, _)| ms).sum();
            let elapsed = times[times.len() - 1] - times[0];
            assert!((fed - elapsed).abs() <= 1000.0 / row.hz, "{label}: fed {fed:.2} ms of {elapsed:.2}");
        }
    }
}

#[test]
fn a_known_refresh_paces_from_the_first_frame() {
    for row in ROWS {
        for phase in 0..PHASES {
            let times = stamps(row.hz, row.spread, phase);
            let mut pacer = RefreshPacer::with_known_refresh_ms(1000.0 / row.hz);
            let paced = trace(&times, |ms| pacer.frame_ms(ms));
            let label = format!("{} Hz ±{} ms known, phase {phase}/{PHASES}", row.hz, row.spread);
            assert_eq!(tick_gaps(&paced, 1), row.gaps, "{label}: frames between ticks");
            assert_eq!(off_beat(&paced, 1, &[0, 1]), 0, "{label}: no frame ran 2 ticks");
        }
    }
}

/// The reported bug (review F2): a 60 Hz phone whose clock starts on a tick's boundary, fed the
/// raw frame times, alternates 0 and 2 ticks; paced, it runs exactly one tick per frame.
#[test]
fn a_sixty_hertz_display_runs_one_tick_per_frame_where_raw_times_alternate_zero_and_two() {
    for spread in [0.5, 1.0, 2.0] {
        let times = stamps(60.0, spread, 0);
        let raw = trace(&times, |ms| ms);
        let mut pacer = RefreshPacer::with_known_refresh_ms(1000.0 / 60.0);
        let paced = trace(&times, |ms| pacer.frame_ms(ms));
        let raw_off = off_beat(&raw, 1, &[1]);
        eprintln!("60 Hz ±{spread} ms: raw times ran {raw_off} of {FRAMES} frames off one tick");
        assert!(raw_off > 0, "±{spread} ms raw: no frame ran 0 or 2 ticks (the bug this row characterises is gone from the model)");
        assert_eq!(off_beat(&paced, 1, &[1]), 0, "±{spread} ms paced: every frame runs one tick");
    }
}

#[test]
fn a_platform_report_is_snapped_to_the_listed_rate_and_a_hostile_one_ignored() {
    let mut pacer = RefreshPacer::new();
    pacer.set_known_refresh_ms(Some(1000.0 / 59.94));
    assert_eq!(pacer.refresh_ms(), Some(FIXED_STEP_MS), "a 59.94 Hz panel paces as 60 Hz: one tick per refresh");
    pacer.set_known_refresh_ms(Some(1000.0 / 110.0));
    assert_eq!(pacer.refresh_ms(), Some(1000.0 / 110.0), "an unlisted rate is kept as reported");
    for hostile in [f64::NAN, f64::INFINITY, -16.0, 0.0, 1.0, 250.0] {
        let mut pacer = RefreshPacer::new();
        pacer.set_known_refresh_ms(Some(hostile));
        assert_eq!(pacer.refresh_ms(), None, "{hostile} is no report");
        assert_eq!(pacer.frame_ms(10.0), 10.0, "{hostile}: the frame's own time is fed");
    }
}

#[test]
fn hostile_frame_times_feed_nothing_and_a_stall_is_capped() {
    let mut pacer = RefreshPacer::with_known_refresh_ms(1000.0 / 60.0);
    for hostile in [f64::NAN, -5.0, 0.0, f64::NEG_INFINITY] {
        assert_eq!(pacer.frame_ms(hostile), 0.0, "{hostile}");
    }
    let fed = pacer.frame_ms(f64::INFINITY);
    assert!(fed <= 250.0 + 1000.0 / 60.0, "a stall feeds at most the clock's own cap: {fed}");
    // A reset drops the time owed; the refresh stays known.
    pacer.frame_ms(5.0);
    pacer.reset();
    assert_eq!(pacer.refresh_ms(), Some(FIXED_STEP_MS));
    assert_eq!(pacer.frame_ms(1000.0 / 60.0), FIXED_STEP_MS);
}

#[test]
fn a_stall_is_not_a_refresh_sample() {
    let mut pacer = RefreshPacer::new();
    for _ in 0..REFRESH_SAMPLES {
        pacer.frame_ms(1000.0 / 120.0);
    }
    assert_eq!(pacer.refresh_ms(), Some(1000.0 / 120.0));
    for _ in 0..REFRESH_SAMPLES {
        pacer.frame_ms(180.0);
    }
    assert_eq!(pacer.refresh_ms(), Some(1000.0 / 120.0), "stalls of 180 ms leave the refresh as it was");
}
