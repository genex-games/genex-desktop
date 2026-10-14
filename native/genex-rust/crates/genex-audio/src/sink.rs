//! The hand-off from the simulated-clock mixer to an audio device's callback thread. The device
//! never pulls from kira directly: it plays blocks the mixer already rendered, so what a device
//! does (underruns, latency, no device at all) can never change `audioLevel` or the simulation.
//! The cpal output stream on desktop ([`crate::DeviceOutput`]) drains it from its callback; the
//! iOS and Android sinks are their shells' (M5).

use std::collections::VecDeque;
use std::sync::{Arc, Mutex, PoisonError};

/// A bounded queue of interleaved samples shared with a device callback.
#[derive(Clone, Debug)]
pub struct SinkQueue {
    samples: Arc<Mutex<VecDeque<f32>>>,
    capacity: usize,
}

impl SinkQueue {
    /// A queue holding at most `capacity` samples.
    pub fn with_capacity(capacity: usize) -> SinkQueue {
        SinkQueue { samples: Arc::new(Mutex::new(VecDeque::with_capacity(capacity))), capacity }
    }

    /// Queue a rendered block; past the capacity the oldest samples go, so a stalled device
    /// catches up with the game instead of lagging behind it.
    pub fn push(&self, block: &[f32]) {
        let mut samples = self.samples.lock().unwrap_or_else(PoisonError::into_inner);
        samples.extend(block);
        let excess = samples.len().saturating_sub(self.capacity);
        samples.drain(..excess);
    }

    /// Fill a device buffer from the queue; whatever the queue cannot fill is silence.
    pub fn drain_into(&self, out: &mut [f32]) {
        let mut samples = self.samples.lock().unwrap_or_else(PoisonError::into_inner);
        for slot in out.iter_mut() {
            *slot = samples.pop_front().unwrap_or(0.0);
        }
    }

    /// Samples waiting.
    pub fn len(&self) -> usize {
        self.samples.lock().unwrap_or_else(PoisonError::into_inner).len()
    }

    /// Whether nothing is waiting.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}
