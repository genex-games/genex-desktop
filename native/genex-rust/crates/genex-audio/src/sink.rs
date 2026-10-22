//! The hand-off from the simulated-clock mixer to an audio device's callback thread. The device
//! never pulls from kira directly: it plays blocks the mixer already rendered, so what a device
//! does (underruns, latency, no device at all) can never change `audioLevel` or the simulation.
//! An [`crate::AudioOutput`] drains it from the device callback on every destination, and a
//! [`crate::NullOutput`] the same way with no device.
//!
//! The queue is a jitter buffer: a device takes nothing until the prefill is queued (per pool
//! class, [`crate::prefill_ticks`]), a callback the queue cannot fill counts one underrun and
//! re-arms the prefill, and past the capacity the oldest samples go.

use crate::output::{capacity_ticks, prefill_ticks};
use crate::vocab::{FRAMES_PER_TICK, MIXER_RATE_HZ, PoolClass};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex, PoisonError};

const STEREO: usize = 2;
const MS_PER_SECOND: f64 = 1000.0;

/// How a device callback's drain went.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Drain {
    /// The callback got every sample it asked for.
    Filled,
    /// The queue ran out inside the callback: the rest is silence and the prefill is re-armed.
    Starved,
    /// The prefill is not queued yet: silence, and nothing was taken.
    Priming,
}

#[derive(Debug)]
struct Shared {
    samples: VecDeque<f32>,
    prefill: usize,
    primed: bool,
    underruns: u64,
    dropped: u64,
}

/// A bounded queue of interleaved stereo samples shared with a device callback.
#[derive(Clone, Debug)]
pub struct SinkQueue {
    shared: Arc<Mutex<Shared>>,
    capacity: usize,
}

impl SinkQueue {
    /// A queue holding at most `capacity` samples, with no prefill.
    pub fn with_capacity(capacity: usize) -> SinkQueue {
        SinkQueue::new(capacity, 0)
    }

    /// The queue a `class` device drains: [`capacity_ticks`] of samples, drained once
    /// [`prefill_ticks`] are queued.
    pub fn for_class(class: PoolClass) -> SinkQueue {
        SinkQueue::new(ticks_to_samples(capacity_ticks(class)), ticks_to_samples(prefill_ticks(class)))
    }

    fn new(capacity: usize, prefill: usize) -> SinkQueue {
        let shared = Shared { samples: VecDeque::with_capacity(capacity), prefill: prefill.min(capacity), primed: false, underruns: 0, dropped: 0 };
        SinkQueue { shared: Arc::new(Mutex::new(shared)), capacity }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Shared> {
        self.shared.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Hold back the device until `class`'s prefill is queued (again, if it was playing).
    #[cfg(feature = "mixer")]
    pub(crate) fn arm(&self, class: PoolClass) {
        let mut shared = self.lock();
        shared.prefill = ticks_to_samples(prefill_ticks(class)).min(self.capacity);
        shared.primed = false;
    }

    /// Queue a rendered block; past the capacity the oldest samples go, so a stalled device
    /// catches up with the game instead of lagging behind it.
    pub fn push(&self, block: &[f32]) {
        let mut shared = self.lock();
        shared.samples.extend(block);
        let excess = shared.samples.len().saturating_sub(self.capacity);
        shared.samples.drain(..excess);
        shared.dropped += excess as u64;
    }

    /// Fill a device buffer from the queue; whatever the queue cannot fill is silence.
    pub fn drain_into(&self, out: &mut [f32]) {
        let _ = self.drain(out);
    }

    /// One device callback's drain: nothing leaves before the prefill, and a callback the queue
    /// cannot fill counts one underrun, however short it fell.
    pub(crate) fn drain(&self, out: &mut [f32]) -> Drain {
        let mut shared = self.lock();
        if !shared.primed {
            if shared.samples.len() < shared.prefill || out.is_empty() {
                out.fill(0.0);
                return Drain::Priming;
            }
            shared.primed = true;
        }
        let available = shared.samples.len().min(out.len());
        for (slot, sample) in out.iter_mut().zip(shared.samples.drain(..available)) {
            *slot = sample;
        }
        out[available..].fill(0.0);
        if available == out.len() {
            return Drain::Filled;
        }
        shared.underruns += 1;
        shared.primed = false;
        Drain::Starved
    }

    /// Samples waiting.
    pub fn len(&self) -> usize {
        self.lock().samples.len()
    }

    /// Whether nothing is waiting.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// The most samples it holds.
    pub fn capacity(&self) -> usize {
        self.capacity
    }

    /// What is waiting, in milliseconds of the mixer's output.
    pub fn queued_ms(&self) -> f64 {
        self.len() as f64 / STEREO as f64 / f64::from(MIXER_RATE_HZ) * MS_PER_SECOND
    }

    /// Device callbacks the queue could not fill.
    pub fn underruns(&self) -> u64 {
        self.lock().underruns
    }

    /// Samples dropped because the queue was full.
    pub fn dropped(&self) -> u64 {
        self.lock().dropped
    }
}

fn ticks_to_samples(ticks: usize) -> usize {
    ticks * FRAMES_PER_TICK * STEREO
}
