//! The audio vocabularies, in their exact wire spellings, and the caps every destination shares.
//! The facade re-exports them as `genex::audio::*`; `state().volatile.audio`, the refusals and
//! the profile spans carry these spellings, so a variant is never renamed.

use serde::{Deserialize, Serialize};

/// A vocabulary: a `#[non_exhaustive]` enum, its `ALL` table in order, `as_str` in the wire
/// spelling and `from_wire` that answers `None` for any other text.
macro_rules! wire_vocabulary {
    (
        $(#[$meta:meta])*
        pub enum $name:ident { $( $(#[$variant_meta:meta])* $variant:ident => $wire:literal ),+ $(,)? }
    ) => {
        $(#[$meta])*
        #[non_exhaustive]
        pub enum $name { $( $(#[$variant_meta])* $variant ),+ }

        impl $name {
            /// Every value, in declaration order.
            pub const ALL: [$name; [$($wire),+].len()] = [$($name::$variant),+];

            /// The wire spelling.
            pub const fn as_str(self) -> &'static str {
                match self { $($name::$variant => $wire),+ }
            }

            /// The value with this wire spelling; `None` for any other text.
            pub fn from_wire(wire: &str) -> Option<$name> {
                $name::ALL.into_iter().find(|value| value.as_str() == wire)
            }
        }
    };
}

pub(crate) use wire_vocabulary;

wire_vocabulary! {
    /// A mixer bus a voice plays on.
    #[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord)]
    pub enum Bus {
        /// Music tracks A and B play here.
        Music => "music",
        /// Sound effects: the bus a play uses unless it names another.
        #[default]
        Sfx => "sfx",
        /// Menu and HUD sounds.
        Ui => "ui",
        /// Dialogue and barks.
        Voice => "voice",
        /// Beds and loops of the world.
        Ambience => "ambience",
    }
}

impl Bus {
    /// The bus's index in [`Bus::ALL`] (mixer order).
    pub const fn index(self) -> usize {
        self as usize
    }
}

wire_vocabulary! {
    /// How gain falls with distance (the Web Audio PannerNode distance models).
    #[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
    pub enum Attenuation {
        /// `ref / (ref + rolloff · (d − ref))`.
        #[default]
        Inverse => "inverse",
        /// `1 − rolloff · (d − ref) / (max − ref)`.
        Linear => "linear",
        /// `(d / ref)^−rolloff`.
        Exponential => "exponential",
        /// No distance attenuation.
        Off => "off",
    }
}

wire_vocabulary! {
    /// What happened to a voice on a tick (`state().volatile.audio.events`).
    #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
    pub enum AudioEventCode {
        /// A play was accepted.
        Played => "played",
        /// A one-shot reached its last frame.
        Ended => "ended",
        /// The game stopped it.
        Stopped => "stopped",
        /// A newer play took its voice.
        Stolen => "stolen",
        /// It lost its physical track and keeps time silently.
        Virtualized => "virtualized",
        /// It got a physical track back.
        Realized => "realized",
        /// A play was refused (the event carries no voice).
        Refused => "refused",
        /// A music track started.
        MusicStarted => "music-started",
        /// A music track that does not loop ended.
        MusicEnded => "music-ended",
    }
}

wire_vocabulary! {
    /// Why audio refused: a mixer, decode, play or asset refusal.
    #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
    pub enum AudioErrorCode {
        /// kira's backend could not start.
        MixerFailed => "mixer-failed",
        /// Every voice is playing and outranks the new one.
        SoundLimit => "sound-limit",
        /// A format the runtime never plays: raylib's QOA and its XM and MOD trackers, video, or an
        /// extension it does not know.
        UnsupportedFormat => "unsupported-format",
        /// Opus or AAC: the studio's import step converts it to Ogg before the game sees it.
        NeedsImport => "needs-import",
        /// The bytes are not the format the name says, or are damaged.
        Malformed => "malformed",
        /// Larger than the runtime decodes into memory.
        TooLarge => "too-large",
        /// Every instance of a sound capped by `max_instances` outranks the new play.
        InstanceLimit => "instance-limit",
        /// More reverb zones than [`REVERB_ZONES_MAX`].
        ZoneLimit => "zone-limit",
        /// The sound was missing or refused at reset; it plays silence.
        SoundMissing => "sound-missing",
        /// Decoded sounds would pass [`SOUNDS_DECODED_MAX_BYTES`].
        MemoryLimit => "memory-limit",
        /// A non-finite position, volume or pitch: the command was dropped.
        InvalidValue => "invalid-value",
    }
}

wire_vocabulary! {
    /// Which physical voice pool a destination renders with. It never changes logical state, only
    /// which voices are virtual.
    #[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
    pub enum PoolClass {
        /// macOS, Windows and Linux.
        #[default]
        Desktop => "desktop",
        /// The browser build.
        Web => "web",
        /// iOS and Android.
        Phone => "phone",
    }
}

impl PoolClass {
    /// Voices this class renders at once; the rest of the logical voices are virtual.
    pub const fn physical_voices(self) -> usize {
        match self {
            PoolClass::Desktop => PHYSICAL_VOICES_DESKTOP,
            PoolClass::Web => PHYSICAL_VOICES_WEB,
            PoolClass::Phone => PHYSICAL_VOICES_PHONE,
        }
    }
}

wire_vocabulary! {
    /// The profile spans audio reports (the profiler owns the timer and the report).
    #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
    pub enum AudioSpan {
        /// The mixer's render of one tick.
        Mix => "audio.mix",
        /// The Director's logical step of one tick.
        Decide => "audio.decide",
    }
}

/// Logical voices alive at once on every destination.
pub const LOGICAL_VOICES_MAX: usize = 64;
/// Physical voice tracks on desktop.
pub const PHYSICAL_VOICES_DESKTOP: usize = 48;
/// Physical voice tracks on the web.
pub const PHYSICAL_VOICES_WEB: usize = 32;
/// Physical voice tracks on phones.
pub const PHYSICAL_VOICES_PHONE: usize = 24;
/// A sound's `max_instances` when a play leaves it at its default.
pub const MAX_INSTANCES_DEFAULT: u8 = 4;
/// Reverb zones registered at once.
pub const REVERB_ZONES_MAX: usize = 16;
/// Occlusion rays cast per tick, round-robin over audible spatial voices.
pub const OCCLUSION_RAYS_PER_TICK: usize = 8;
/// Decoded sound effects held at once (f32 stereo, about two minutes).
pub const SOUNDS_DECODED_MAX_BYTES: usize = 48 * 1024 * 1024;
/// Events kept per tick in `state()`; the counts keep the rest.
pub const AUDIO_EVENTS_MAX: usize = 64;

/// The person's volumes: the settings menu's Audio tab, outside the sim (`genex-settings.json`
/// "audio"). Linear, 0..=1; a missing key keeps its default of 1.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AudioSettings {
    /// Applies to the main track, after every bus.
    pub master: f32,
    /// The music bus.
    pub music: f32,
    /// The sfx bus.
    pub sfx: f32,
    /// The ui bus.
    pub ui: f32,
    /// The voice bus.
    pub voice: f32,
    /// The ambience bus.
    pub ambience: f32,
}

impl Default for AudioSettings {
    fn default() -> AudioSettings {
        AudioSettings { master: 1.0, music: 1.0, sfx: 1.0, ui: 1.0, voice: 1.0, ambience: 1.0 }
    }
}

impl AudioSettings {
    /// One bus's person volume.
    pub fn bus(&self, bus: Bus) -> f32 {
        match bus {
            Bus::Music => self.music,
            Bus::Sfx => self.sfx,
            Bus::Ui => self.ui,
            Bus::Voice => self.voice,
            Bus::Ambience => self.ambience,
        }
    }

    /// This setting with `bus` at `volume`, clamped to 0..=1; NaN keeps the old value.
    pub fn with_bus(self, bus: Bus, volume: f32) -> AudioSettings {
        let volume = if volume.is_nan() { self.bus(bus) } else { volume.clamp(0.0, 1.0) };
        let mut settings = self;
        let slot = match bus {
            Bus::Music => &mut settings.music,
            Bus::Sfx => &mut settings.sfx,
            Bus::Ui => &mut settings.ui,
            Bus::Voice => &mut settings.voice,
            Bus::Ambience => &mut settings.ambience,
        };
        *slot = volume;
        settings
    }
}
