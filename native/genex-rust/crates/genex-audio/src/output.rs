//! The device side: an [`AudioOutput`] that drains a [`SinkQueue`] on the destination's audio
//! device, with a prefill per pool class and typed faults. Bodies are AU-5's: today only desktop
//! opens a device (through [`crate::DeviceOutput`]); every other target answers `no-device`.

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

/// Ticks a class queues before its device starts draining.
pub const fn prefill_ticks(class: PoolClass) -> usize {
    match class {
        PoolClass::Desktop => PREFILL_TICKS_DESKTOP,
        PoolClass::Web | PoolClass::Phone => PREFILL_TICKS_WEB_PHONE,
    }
}

/// An open audio output; dropping it stops the sound.
pub struct AudioOutput {
    #[cfg(not(any(target_arch = "wasm32", target_os = "ios", target_os = "android")))]
    _device: crate::DeviceOutput,
}

impl AudioOutput {
    /// Open the destination's default output and play `queue` on it. Never called by tests.
    pub fn open(queue: SinkQueue, class: PoolClass) -> Result<AudioOutput, DeviceFault> {
        let _ = class;
        #[cfg(not(any(target_arch = "wasm32", target_os = "ios", target_os = "android")))]
        {
            crate::DeviceOutput::open(queue).map(|device| AudioOutput { _device: device }).map_err(|_| DeviceFault::NoDevice)
        }
        #[cfg(any(target_arch = "wasm32", target_os = "ios", target_os = "android"))]
        {
            let _ = queue;
            Err(DeviceFault::NoDevice)
        }
    }
}
