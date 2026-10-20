//! The device side: an [`AudioOutput`] drains a [`SinkQueue`] on the destination's audio device
//! (the cpal [`crate::DeviceOutput`] on all six destinations), with a prefill and a capacity per
//! pool class and typed faults. A [`NullOutput`] drains it the same way with no device, for tests
//! and headless checks: `AudioOutput::open` is never called under `cargo test`.

use crate::device::{DeviceHealth, DeviceOutput, Resampler};
use crate::sink::SinkQueue;
use crate::vocab::{PoolClass, wire_vocabulary};

wire_vocabulary! {
    /// Why the device side failed; reported in `volatile.audio.device.fault`, never a panic.
    #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
    pub enum DeviceFault {
        /// There is no output device, or it takes no stream the runtime can feed.
        NoDevice => "no-device",
        /// The device went away while playing.
        DeviceLost => "device-lost",
        /// A device callback found the queue empty.
        Underrun => "underrun",
    }
}

/// Ticks queued before a desktop device starts draining.
pub const PREFILL_TICKS_DESKTOP: usize = 3;
/// Ticks queued before a web or phone device starts draining (100 ms).
pub const PREFILL_TICKS_WEB_PHONE: usize = 6;
/// Ticks a desktop queue holds before it drops its oldest samples (200 ms).
pub const CAPACITY_TICKS_DESKTOP: usize = 12;
/// Ticks a web or phone queue holds before it drops its oldest samples (400 ms).
pub const CAPACITY_TICKS_WEB_PHONE: usize = 24;

/// Ticks a class queues before its device starts draining.
pub const fn prefill_ticks(class: PoolClass) -> usize {
    match class {
        PoolClass::Desktop => PREFILL_TICKS_DESKTOP,
        PoolClass::Web | PoolClass::Phone => PREFILL_TICKS_WEB_PHONE,
    }
}

/// Ticks a class's queue holds before it drops its oldest samples.
pub const fn capacity_ticks(class: PoolClass) -> usize {
    match class {
        PoolClass::Desktop => CAPACITY_TICKS_DESKTOP,
        PoolClass::Web | PoolClass::Phone => CAPACITY_TICKS_WEB_PHONE,
    }
}

/// The fault a cpal stream error is, or `None` when the stream goes on (a reroute to the new
/// default device, a refused real-time priority).
pub fn stream_fault(kind: cpal::ErrorKind) -> Option<DeviceFault> {
    match kind {
        cpal::ErrorKind::Xrun => Some(DeviceFault::Underrun),
        cpal::ErrorKind::DeviceChanged | cpal::ErrorKind::RealtimeDenied => None,
        _ => Some(DeviceFault::DeviceLost),
    }
}

/// An open audio output; dropping it stops the sound.
pub struct AudioOutput {
    device: DeviceOutput,
    queue: SinkQueue,
}

impl AudioOutput {
    /// Open the destination's default output and play `queue` on it once `class`'s prefill is
    /// queued. Opened only for a run a person sees; never called by tests.
    pub fn open(queue: SinkQueue, class: PoolClass) -> Result<AudioOutput, DeviceFault> {
        queue.arm(class);
        let device = DeviceOutput::open(queue.clone()).map_err(|_| DeviceFault::NoDevice)?;
        Ok(AudioOutput { device, queue })
    }

    /// The device's sample rate, in Hz.
    pub fn rate(&self) -> u32 {
        self.device.rate()
    }

    /// The last fault the device reported, if any.
    pub fn fault(&self) -> Option<DeviceFault> {
        self.device.health().fault()
    }

    /// What the device reported.
    pub fn health(&self) -> &DeviceHealth {
        self.device.health()
    }

    /// The queue it drains.
    pub fn queue(&self) -> &SinkQueue {
        &self.queue
    }
}

/// An output with no device: [`NullOutput::pull`] is one device callback, drained and resampled
/// exactly as [`AudioOutput`]'s callback is.
#[derive(Debug)]
pub struct NullOutput {
    queue: SinkQueue,
    resampler: Resampler,
    channels: usize,
}

impl NullOutput {
    /// A `channels`-channel device at `rate` Hz draining `queue` once `class`'s prefill is queued.
    pub fn open(queue: SinkQueue, class: PoolClass, rate: u32, channels: usize) -> NullOutput {
        queue.arm(class);
        NullOutput { queue, resampler: Resampler::new(rate), channels }
    }

    /// One device callback filling `out` (interleaved).
    pub fn pull(&mut self, out: &mut [f32]) {
        self.resampler.fill(&self.queue, out, self.channels);
    }
}
