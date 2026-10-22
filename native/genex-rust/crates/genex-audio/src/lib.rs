//! kira mixer with a device-less backend for headless and boxed runs; symphonia decoding.
//!
//! The rule is: the sim decides, the mixer renders, the device drains.
//! - **Decide.** The [`Director`] turns a game's [`AudioCommand`]s into logical voices (stealing,
//!   virtualization, ducking, spatial gains, music slots, events) on integer ticks and libm, so
//!   its state is bit-equal on every destination and device class, and emits [`MixerOp`]s.
//! - **Render.** The [`Mixer`] always runs on the simulated clock: every tick renders exactly
//!   [`FRAMES_PER_TICK`] stereo frames at [`MIXER_RATE_HZ`] through kira's own renderer, over five
//!   bus tracks, a reverb send, two music tracks and a pool of physical voice tracks sized by the
//!   [`PoolClass`]. The meter behind `audioLevel` reads those frames.
//! - **Drain.** An audio device, when there is one, only plays what the mixer already rendered
//!   (through a [`SinkQueue`], drained by an [`AudioOutput`]), so `audioLevel` is the same with or
//!   without a device, in a headless run, a boxed run or a window.
//!
//! Files decode with [`decode_sound`] (WAV, Ogg Vorbis, MP3, FLAC); music stays compressed and
//! decodes while it plays ([`Music::stream`]). The iOS audio session and Android audio focus are
//! their shells'.

#[cfg(feature = "mixer")]
mod decode;
#[cfg(feature = "mixer")]
mod device;
mod director;
mod events;
#[cfg(feature = "mixer")]
mod graph;
#[cfg(feature = "mixer")]
mod lowpass;
mod meter;
#[cfg(feature = "mixer")]
mod mixer;
#[cfg(feature = "mixer")]
mod music;
mod occlusion;
mod ops;
mod output;
mod sink;
mod spatial;
mod vocab;
mod voices;
mod zones;

#[cfg(feature = "mixer")]
pub use decode::{MAX_CLAIMED_SECONDS, MAX_DECODED_FRAMES, MAX_SOUND_BYTES, decode_sound};
#[cfg(feature = "mixer")]
pub use device::{DeviceHealth, DeviceOutput, Resampler};
pub use director::{Director, StepInput};
pub use events::{AudioCounts, AudioEvent, EventLog};
pub use meter::{AUDIO_WINDOW_FRAMES, AudioLevel, AudioMeter};
#[cfg(feature = "mixer")]
pub use mixer::{Mixer, Sound};
#[cfg(feature = "mixer")]
pub use music::{MUSIC_RING_FRAMES, MUSIC_WORKING_BYTES, Music};
pub use occlusion::{OCCLUDED_CUTOFF_FLOOR_HZ, OCCLUDER_TRANSMISSION, OCCLUSION_TWEEN_S, Occluder, OcclusionScheduler};
pub use ops::{
    AudioCommand, AudioSetup, Duck, Listener, LogicalVoice, MixerOp, MusicId, MusicOpts, MusicTrack, PRIORITY_DEFAULT, PRIORITY_UI,
    PhysicalSlot, PlayOpts, ReverbPreset, ReverbZone, SoundId, Spatial, Voice, ZoneId, ZoneShape,
};
pub use output::{CAPACITY_TICKS_DESKTOP, CAPACITY_TICKS_WEB_PHONE, DeviceFault, PREFILL_TICKS_DESKTOP, PREFILL_TICKS_WEB_PHONE, capacity_ticks, prefill_ticks};
#[cfg(feature = "mixer")]
pub use output::{AudioOutput, NullOutput, stream_fault};
pub use sink::SinkQueue;
pub use spatial::{
    CUTOFF_FAR_HZ, CUTOFF_OPEN_HZ, DOPPLER_RATE_MAX, DOPPLER_RATE_MIN, SPEED_OF_SOUND_M_S, attenuation_db, distance_cutoff_hz,
    doppler_rate, pan, pan_gains,
};
pub use vocab::{
    AUDIO_EVENTS_MAX, Attenuation, AudioError, AudioErrorCode, AudioEventCode, AudioSettings, AudioSpan, Bus, LOGICAL_VOICES_MAX,
    MAX_INSTANCES_DEFAULT, OCCLUSION_RAYS_PER_TICK, PHYSICAL_VOICES_DESKTOP, PHYSICAL_VOICES_PHONE, PHYSICAL_VOICES_WEB, PoolClass,
    REVERB_ZONES_MAX, SOUNDS_DECODED_MAX_BYTES, FRAMES_PER_TICK, MIXER_RATE_HZ,
};
pub use voices::{SoundInfo, instance_victim, rank_for_pool, steal_victim};
pub use zones::{SEND_OFF_DB, active_zone, send_db};

/// Pinned re-export, so the runtime never names kira's version itself.
#[cfg(feature = "mixer")]
pub use kira;
