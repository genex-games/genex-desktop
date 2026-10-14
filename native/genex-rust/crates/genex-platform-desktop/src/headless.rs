//! The headless loop: no window, no winit, no real input. Each frame waits for the host's next
//! request (at most a sixtieth of a second), then runs with an empty sample, as the C++ headless
//! build does. It never creates an EventLoop, so it runs off the main thread and in a box with no
//! window server.

use crate::core::{FrameControl, ShellFrame, ShellGame};
use crate::sample::FrameSample;
use std::time::{Duration, Instant};

/// The longest a headless frame waits for the host, in milliseconds.
pub const HEADLESS_FRAME_MS: f64 = 1000.0 / 60.0;

/// The wall clock a loop reads; tests drive a fake one.
pub trait ShellClock {
    /// Milliseconds since some fixed start.
    fn now_ms(&mut self) -> f64;
    /// Wait about `max_ms` milliseconds.
    fn idle(&mut self, max_ms: f64);
}

/// The process's monotonic clock.
#[derive(Clone, Copy, Debug)]
pub struct SystemClock {
    start: Instant,
}

impl SystemClock {
    /// A clock starting now.
    pub fn new() -> SystemClock {
        SystemClock { start: Instant::now() }
    }
}

impl Default for SystemClock {
    fn default() -> SystemClock {
        SystemClock::new()
    }
}

impl ShellClock for SystemClock {
    fn now_ms(&mut self) -> f64 {
        self.start.elapsed().as_secs_f64() * 1000.0
    }

    fn idle(&mut self, max_ms: f64) {
        if max_ms.is_finite() && max_ms > 0.0 {
            std::thread::sleep(Duration::from_secs_f64(max_ms / 1000.0));
        }
    }
}

/// Bounds for a headless run.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct HeadlessOptions {
    /// Stop after this many frames (spikes and tests); `None` runs until the game exits.
    pub max_frames: Option<u64>,
}

/// How a loop ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ShellExit {
    /// Frames run.
    pub frames: u64,
}

/// Run `game` headless until it exits or `options.max_frames` frames ran.
pub fn run_headless<G: ShellGame>(game: &mut G, clock: &mut impl ShellClock, options: HeadlessOptions) -> ShellExit {
    let mut frames = 0;
    let mut last = clock.now_ms();
    while options.max_frames.is_none_or(|max| frames < max) {
        if !game.wait_for_host(HEADLESS_FRAME_MS) {
            clock.idle(HEADLESS_FRAME_MS);
        }
        let now = clock.now_ms();
        let frame = ShellFrame { sample: FrameSample::default(), frame_ms: now - last, present: false, headless: true };
        last = now;
        frames += 1;
        if game.frame(frame) == FrameControl::Exit {
            break;
        }
    }
    ShellExit { frames }
}
