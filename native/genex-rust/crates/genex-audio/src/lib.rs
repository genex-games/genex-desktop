//! kira mixer with a device-less backend for headless and boxed runs; symphonia decoding.
//!
//! The mixer always runs on the simulated clock: every tick renders exactly [`FRAMES_PER_TICK`]
//! stereo frames at [`MIXER_RATE_HZ`] through kira's own renderer, and the meter behind
//! `audioLevel` reads those frames. An audio device, when there is one, only plays what the mixer
//! already rendered (through a [`SinkQueue`], drained on desktop by [`DeviceOutput`]), so
//! `audioLevel` is the same with or without a device, in a headless run, a boxed run or a window.
//! Files decode with [`decode_sound`] (WAV, Ogg Vorbis, MP3, FLAC). The iOS audio session and
//! Android audio focus are their shells' (M5).

mod decode;
#[cfg(not(any(target_arch = "wasm32", target_os = "ios", target_os = "android")))]
mod device;
mod meter;
mod mixer;
mod sink;

pub use decode::{MAX_SOUND_BYTES, decode_sound};
#[cfg(not(any(target_arch = "wasm32", target_os = "ios", target_os = "android")))]
pub use device::{DeviceOutput, Resampler};
pub use meter::{AUDIO_WINDOW_FRAMES, AudioLevel, AudioMeter};
pub use mixer::{AudioError, AudioErrorCode, FRAMES_PER_TICK, MIXER_RATE_HZ, Mixer, Sound};
pub use sink::SinkQueue;

/// Pinned re-export, so the runtime never names kira's version itself.
pub use kira;
