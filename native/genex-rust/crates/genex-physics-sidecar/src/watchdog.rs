//! The in-process watchdog: a thread that ends the process when one frame runs past its deadline,
//! the defence in depth behind the host's own watchdog (which SIGKILLs the process from outside).
//!
//! The main thread marks a frame's start with [`Watchdog::begin`] and its end with
//! [`Watchdog::end`]: two atomic stores, no lock and no system call on the tick's path. The
//! watchdog thread sleeps a deadline at a time while no frame runs, and while one runs it sleeps
//! until that frame's start plus its deadline, so it fires within a sleep's precision of the
//! deadline. Before firing it checks the same frame is still running.

use std::sync::Arc;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

/// The watchdog thread's stack: it calls nothing deep.
const STACK_BYTES: usize = 64 * 1024;
/// "No frame running".
const IDLE: u64 = 0;

/// Nanoseconds since this process's first look at the clock, plus one so a start is never [`IDLE`].
fn now_ns() -> u64 {
    static BASE: OnceLock<Instant> = OnceLock::new();
    let base = BASE.get_or_init(Instant::now);
    u64::try_from(base.elapsed().as_nanos()).unwrap_or(u64::MAX - 1) + 1
}

/// What the main thread and the watchdog thread share.
struct Shared {
    /// When the running frame started ([`now_ns`]), or [`IDLE`].
    started: AtomicU64,
    /// The running frame's deadline, in nanoseconds.
    limit: AtomicU64,
    /// How long to sleep while idle.
    idle: Duration,
}

/// The main thread's handle on the watchdog.
pub struct Watchdog {
    shared: Arc<Shared>,
}

impl Watchdog {
    /// Starts the watchdog thread; it calls `expire` (which should end the process) when a frame
    /// runs past its deadline. `idle` is how often it looks while no frame runs: the usual deadline.
    pub fn start(idle: Duration, expire: impl Fn() + Send + 'static) -> std::io::Result<Self> {
        let shared = Arc::new(Shared { started: AtomicU64::new(IDLE), limit: AtomicU64::new(0), idle });
        let watched = Arc::clone(&shared);
        std::thread::Builder::new()
            .name("genex-physics-watchdog".into())
            .stack_size(STACK_BYTES)
            .spawn(move || watch(&watched, &expire))?;
        Ok(Self { shared })
    }

    /// A frame starts, with `deadline` to finish in.
    pub fn begin(&self, deadline: Duration) {
        let limit = u64::try_from(deadline.as_nanos()).unwrap_or(u64::MAX);
        self.shared.limit.store(limit, Ordering::Release);
        self.shared.started.store(now_ns(), Ordering::Release);
    }

    /// The frame finished.
    pub fn end(&self) {
        self.shared.started.store(IDLE, Ordering::Release);
    }
}

/// The watchdog thread's loop; returns only after `expire` returned (in tests).
fn watch(shared: &Shared, expire: &impl Fn()) {
    loop {
        let started = shared.started.load(Ordering::Acquire);
        if started == IDLE {
            std::thread::sleep(shared.idle);
            continue;
        }
        let limit = shared.limit.load(Ordering::Acquire);
        if shared.started.load(Ordering::Acquire) != started {
            continue;
        }
        let due = started.saturating_add(limit);
        let now = now_ns();
        if now < due {
            std::thread::sleep(Duration::from_nanos(due - now));
            continue;
        }
        if shared.started.load(Ordering::Acquire) == started {
            expire();
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    const DEADLINE: Duration = Duration::from_millis(30);

    fn watched() -> (Watchdog, Arc<AtomicBool>) {
        let fired = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&fired);
        let dog = Watchdog::start(DEADLINE, move || flag.store(true, Ordering::SeqCst)).expect("thread");
        (dog, fired)
    }

    #[test]
    fn frames_inside_their_deadline_never_fire_it() {
        let (dog, fired) = watched();
        for _ in 0..20 {
            dog.begin(DEADLINE);
            std::thread::sleep(DEADLINE / 6);
            dog.end();
            std::thread::sleep(DEADLINE / 6);
        }
        std::thread::sleep(DEADLINE * 2);
        assert!(!fired.load(Ordering::SeqCst));
    }

    #[test]
    fn a_frame_past_its_deadline_fires_it_close_to_the_deadline() {
        let (dog, fired) = watched();
        let start = Instant::now();
        dog.begin(DEADLINE);
        while !fired.load(Ordering::SeqCst) && start.elapsed() < DEADLINE * 20 {
            std::thread::sleep(Duration::from_millis(1));
        }
        let took = start.elapsed();
        assert!(fired.load(Ordering::SeqCst), "it fired");
        assert!(took >= DEADLINE && took < DEADLINE * 4, "it fired after {took:?}");
    }

    #[test]
    fn a_long_frame_s_deadline_is_its_own() {
        let (dog, fired) = watched();
        dog.begin(DEADLINE * 5);
        std::thread::sleep(DEADLINE * 2);
        dog.end();
        dog.begin(DEADLINE);
        dog.end();
        std::thread::sleep(DEADLINE * 2);
        assert!(!fired.load(Ordering::SeqCst), "neither frame ran past its own deadline");
    }
}
