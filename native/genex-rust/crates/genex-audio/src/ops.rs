//! The two command streams: what a game asks for ([`AudioCommand`], queued by `ctx.audio` in call
//! order) and what the mixer renders ([`MixerOp`], emitted by the Director). The sim decides, the
//! mixer renders, the device drains: everything here is plain data, so a logical step is a pure
//! function of commands and ticks, bit-equal on every destination.

use crate::vocab::{Attenuation, Bus};
use glam::Vec3;

/// A decoded sound the mixer holds; registered once and kept across seeds.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct SoundId(pub u32);

/// Streamed music the mixer holds; registered once and kept across seeds.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct MusicId(pub u32);

/// One playing (or finished) sound. Ids count up from 1 after every seed; 0 is never issued.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Voice(u32);

impl Voice {
    /// No voice: what a refused or disabled play answers.
    pub const NONE: Voice = Voice(0);

    /// The voice with this id (the command queue issues them; 0 is [`Voice::NONE`]).
    pub const fn from_id(id: u32) -> Voice {
        Voice(id)
    }

    /// The voice's id.
    pub const fn id(self) -> u32 {
        self.0
    }
}

/// A reverb zone's id, for removal.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ZoneId(u32);

impl ZoneId {
    /// The zone with this id (the command queue issues them).
    pub const fn from_id(id: u32) -> ZoneId {
        ZoneId(id)
    }

    /// The zone's id.
    pub const fn id(self) -> u32 {
        self.0
    }
}

/// A physical voice track's index, below the class's pool size.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct PhysicalSlot(pub u16);

/// One of the two music tracks a crossfade alternates between.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum MusicTrack {
    /// The first track.
    A,
    /// The second track.
    B,
}

impl MusicTrack {
    /// The track a crossfade moves to.
    pub const fn other(self) -> MusicTrack {
        match self {
            MusicTrack::A => MusicTrack::B,
            MusicTrack::B => MusicTrack::A,
        }
    }

    /// The track's index (A is 0).
    pub const fn index(self) -> usize {
        self as usize
    }
}

/// How a voice falls off in space. Defaults: Inverse, ref 1 m, max 50 m, rolloff 1, panning 1,
/// low-pass by distance on, Doppler off (0), occlusion on (it applies only when the game's
/// `AudioSetup` turns occlusion on).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Spatial {
    /// The distance model.
    pub attenuation: Attenuation,
    /// Full volume up to this distance, in metres.
    pub ref_distance: f32,
    /// The distance past which gain stops falling.
    pub max_distance: f32,
    /// How fast gain falls past `ref_distance`.
    pub rolloff: f32,
    /// How far the pan follows the azimuth, 0..=1.
    pub panning: f32,
    /// Darken far voices with a low-pass.
    pub lowpass_by_distance: bool,
    /// Doppler strength (0 is off, 1 is physical).
    pub doppler: f32,
    /// Whether this voice is occluded by colliders.
    pub occlusion: bool,
}

impl Default for Spatial {
    fn default() -> Spatial {
        Spatial {
            attenuation: Attenuation::Inverse,
            ref_distance: 1.0,
            max_distance: 50.0,
            rolloff: 1.0,
            panning: 1.0,
            lowpass_by_distance: true,
            doppler: 0.0,
            occlusion: true,
        }
    }
}

/// The priority a play uses unless it names another.
pub const PRIORITY_DEFAULT: u8 = 128;
/// The priority of UI sounds: they keep their voice.
pub const PRIORITY_UI: u8 = u8::MAX;

/// One play call's options. Defaults: Sfx, 0 dB, pitch 1, pan 0, priority 128, one-shot, no
/// position, at most [`crate::MAX_INSTANCES_DEFAULT`] instances of the sound.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PlayOpts {
    /// The bus it plays on.
    pub bus: Bus,
    /// Its gain in dB.
    pub volume_db: f32,
    /// Its playback rate (1 is the recorded pitch).
    pub pitch: f32,
    /// Stereo pan for a non-spatial voice, -1..=1.
    pub pan: f32,
    /// Higher keeps its voice when the pool is full (0..=255).
    pub priority: u8,
    /// Loop until stopped.
    pub looped: bool,
    /// Start this many seconds in.
    pub start_s: f32,
    /// Fade in over this many seconds.
    pub fade_in_s: f32,
    /// A world position makes the voice spatial.
    pub at: Option<Vec3>,
    /// How a spatial voice falls off.
    pub spatial: Spatial,
    /// At most this many voices of this sound (0: no cap); the oldest is stolen.
    pub max_instances: u8,
    /// Never virtualized (UI sounds).
    pub never_virtual: bool,
}

impl Default for PlayOpts {
    fn default() -> PlayOpts {
        PlayOpts {
            bus: Bus::Sfx,
            volume_db: 0.0,
            pitch: 1.0,
            pan: 0.0,
            priority: PRIORITY_DEFAULT,
            looped: false,
            start_s: 0.0,
            fade_in_s: 0.0,
            at: None,
            spatial: Spatial::default(),
            max_instances: crate::vocab::MAX_INSTANCES_DEFAULT,
            never_virtual: false,
        }
    }
}

impl PlayOpts {
    /// These options on `bus`.
    pub fn on(self, bus: Bus) -> PlayOpts {
        PlayOpts { bus, ..self }
    }

    /// These options at `db`.
    pub fn volume_db(self, db: f32) -> PlayOpts {
        PlayOpts { volume_db: db, ..self }
    }

    /// These options at playback rate `rate`.
    pub fn pitch(self, rate: f32) -> PlayOpts {
        PlayOpts { pitch: rate, ..self }
    }

    /// These options panned to `pan` (-1..=1).
    pub fn pan(self, pan: f32) -> PlayOpts {
        PlayOpts { pan, ..self }
    }

    /// These options at `priority`.
    pub fn priority(self, priority: u8) -> PlayOpts {
        PlayOpts { priority, ..self }
    }

    /// These options, looping.
    pub fn looped(self) -> PlayOpts {
        PlayOpts { looped: true, ..self }
    }

    /// These options at a world position (spatial).
    pub fn at(self, position: Vec3) -> PlayOpts {
        PlayOpts { at: Some(position), ..self }
    }

    /// These options with `spatial` falloff.
    pub fn spatial(self, spatial: Spatial) -> PlayOpts {
        PlayOpts { spatial, ..self }
    }

    /// These options with at most `n` instances of the sound (0: no cap).
    pub fn max_instances(self, n: u8) -> PlayOpts {
        PlayOpts { max_instances: n, ..self }
    }

    /// UI sounds: the Ui bus, priority 255, never virtual.
    pub fn ui() -> PlayOpts {
        PlayOpts { bus: Bus::Ui, priority: PRIORITY_UI, never_virtual: true, ..PlayOpts::default() }
    }
}

/// Music playback: crossfade from what is playing over `fade_s`; loop points in seconds.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MusicOpts {
    /// The crossfade from what is playing, in seconds.
    pub fade_s: f32,
    /// Its gain in dB.
    pub volume_db: f32,
    /// Start this many seconds in.
    pub start_s: f32,
    /// Loop until stopped.
    pub looped: bool,
    /// Where a loop starts again, in seconds.
    pub loop_start_s: f32,
    /// Where a loop wraps, in seconds; `None` is the end of the file.
    pub loop_end_s: Option<f32>,
}

impl Default for MusicOpts {
    fn default() -> MusicOpts {
        MusicOpts { fade_s: 1.0, volume_db: 0.0, start_s: 0.0, looped: true, loop_start_s: 0.0, loop_end_s: None }
    }
}

/// Where the ears are. Default: the game's own camera each tick.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Listener {
    /// The ears' position.
    pub position: Vec3,
    /// Where the ears face.
    pub forward: Vec3,
    /// The ears' up.
    pub up: Vec3,
}

/// Lower `target` while anything plays on `trigger` (dialogue ducks music).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Duck {
    /// The bus whose activity ducks.
    pub trigger: Bus,
    /// The bus that is lowered.
    pub target: Bus,
    /// How far it is lowered, in dB (negative).
    pub depth_db: f32,
    /// Seconds to reach the depth.
    pub attack_s: f32,
    /// Seconds to come back once the trigger is quiet.
    pub release_s: f32,
}

/// A reverb zone's shape in world space.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ZoneShape {
    /// An axis-aligned box.
    Box {
        /// The low corner.
        min: Vec3,
        /// The high corner.
        max: Vec3,
    },
    /// A sphere.
    Sphere {
        /// Its centre.
        center: Vec3,
        /// Its radius.
        radius: f32,
    },
}

/// The shared reverb's character inside a zone (kira's reverb feedback and damping, 0..=1).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ReverbPreset {
    /// How much the room reverberates (kira feedback).
    pub room: f32,
    /// How fast high frequencies die away.
    pub damping: f32,
}

impl ReverbPreset {
    /// A small room.
    pub const ROOM: ReverbPreset = ReverbPreset { room: 0.6, damping: 0.5 };
    /// A large hall.
    pub const HALL: ReverbPreset = ReverbPreset { room: 0.85, damping: 0.3 };
    /// A long, dark cave.
    pub const CAVE: ReverbPreset = ReverbPreset { room: 0.92, damping: 0.6 };
    /// Open air: a short, bright tail.
    pub const OUTDOORS: ReverbPreset = ReverbPreset { room: 0.3, damping: 0.8 };
}

/// A reverb zone (Godot Area reverb: amount and uniformity).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ReverbZone {
    /// The zone's name in `state()`.
    pub name: &'static str,
    /// Where it is.
    pub shape: ZoneShape,
    /// The reverb inside it.
    pub preset: ReverbPreset,
    /// The send level of a voice at the listener, in dB.
    pub send_db: f32,
    /// 1 keeps a far voice's full wet signal (a cave); 0 lets it fall with the dry signal.
    pub uniformity: f32,
}

/// The game's audio setup, registered once (`game.audio`); the defaults need no call.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct AudioSetup {
    /// Falloff for spatial plays that do not name their own.
    pub spatial: Spatial,
    /// Ducking rules.
    pub ducks: Vec<Duck>,
    /// Reverb zones present from the first tick (at most [`crate::REVERB_ZONES_MAX`]).
    pub zones: Vec<ReverbZone>,
    /// Cast occlusion rays (needs physics).
    pub occlusion: bool,
}

/// What a game asked for in one hook (`ctx.audio`), applied after the hooks in call order.
#[derive(Clone, Debug, PartialEq)]
pub enum AudioCommand {
    /// Play `sound` as `voice` (the queue issued the id).
    Play {
        /// The voice the call answered.
        voice: Voice,
        /// What to play.
        sound: SoundId,
        /// How.
        opts: PlayOpts,
    },
    /// Stop a voice.
    Stop {
        /// The voice.
        voice: Voice,
        /// Fade-out, in seconds.
        fade_s: f32,
    },
    /// Stop every voice on a bus.
    StopBus {
        /// The bus.
        bus: Bus,
        /// Fade-out, in seconds.
        fade_s: f32,
    },
    /// Move a spatial voice.
    SetPosition {
        /// The voice.
        voice: Voice,
        /// Where it is now.
        position: Vec3,
    },
    /// Move a spatial voice without a Doppler sweep (respawn, portal).
    Teleport {
        /// The voice.
        voice: Voice,
        /// Where it is now.
        position: Vec3,
    },
    /// Change a voice's gain.
    SetVolume {
        /// The voice.
        voice: Voice,
        /// Its new gain.
        db: f32,
        /// Seconds to get there.
        fade_s: f32,
    },
    /// Change a voice's playback rate.
    SetPitch {
        /// The voice.
        voice: Voice,
        /// Its new rate.
        rate: f32,
        /// Seconds to get there.
        fade_s: f32,
    },
    /// The sim layer of a bus.
    BusVolume {
        /// The bus.
        bus: Bus,
        /// Its new sim-layer gain.
        db: f32,
        /// Seconds to get there.
        fade_s: f32,
    },
    /// The sim layer of the main track.
    MasterVolume {
        /// The new gain.
        db: f32,
        /// Seconds to get there.
        fade_s: f32,
    },
    /// Play music, crossfading from what plays.
    Music {
        /// What to play.
        music: MusicId,
        /// How.
        opts: MusicOpts,
    },
    /// Fade the music out.
    StopMusic {
        /// Fade-out, in seconds.
        fade_s: f32,
    },
    /// Use these ears instead of the camera's; `None` goes back to the camera.
    Listener(Option<Listener>),
    /// Add a reverb zone.
    AddZone {
        /// The id the call answered.
        zone: ZoneId,
        /// The zone.
        def: ReverbZone,
    },
    /// Remove a reverb zone.
    RemoveZone(ZoneId),
}

/// One logical voice: what the Director keeps per voice and `state().volatile.audio.voices`
/// shows. A voice with no slot is virtual: silent, its time still advancing.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LogicalVoice {
    /// Its id.
    pub voice: Voice,
    /// What it plays.
    pub sound: SoundId,
    /// The bus it plays on.
    pub bus: Bus,
    /// Its priority.
    pub priority: u8,
    /// The tick it started on.
    pub started_tick: u64,
    /// Source frames played so far (advanced by `pitch · rate / 60` per tick).
    pub position_frames: f64,
    /// Source frames in the sound.
    pub frames: u64,
    /// The sound's own rate, in Hz.
    pub rate_hz: u32,
    /// Whether it loops.
    pub looped: bool,
    /// Its gain after spatial falloff, occlusion and the game's volume, in dB.
    pub gain_db: f32,
    /// Its pan, -1..=1.
    pub pan: f32,
    /// Its game pitch times Doppler.
    pub pitch: f32,
    /// Its low-pass cut-off, in Hz.
    pub cutoff_hz: f32,
    /// Its reverb send, in dB.
    pub send_db: f32,
    /// Whether occlusion lowered it.
    pub occluded: bool,
    /// Where it is, for a spatial voice.
    pub at: Option<Vec3>,
    /// How it falls off.
    pub spatial: Spatial,
    /// The physical track that renders it; `None` while virtual.
    pub slot: Option<PhysicalSlot>,
    /// Never virtualized (UI sounds).
    pub never_virtual: bool,
}

impl LogicalVoice {
    /// Whether it is silent and keeping time (no physical track).
    pub fn is_virtual(&self) -> bool {
        self.slot.is_none()
    }

    /// Seconds into the sound.
    pub fn position_s(&self) -> f64 {
        self.position_frames / f64::from(self.rate_hz.max(1))
    }
}

/// What the mixer renders: one change to its tracks, emitted by the Director, applied in order.
/// Every float was computed on the logical side, so the stream is bit-equal on all destinations.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum MixerOp {
    /// Start `sound` on physical `slot` (a play or a voice made real).
    Start {
        /// The physical track.
        slot: PhysicalSlot,
        /// The bus the track plays into.
        bus: Bus,
        /// What it plays.
        sound: SoundId,
        /// Source frame to start at (a realized voice's logical offset).
        start_frame: f64,
        /// Whether it loops.
        looped: bool,
        /// Its gain in dB.
        gain_db: f32,
        /// Its pan, -1..=1.
        pan: f32,
        /// Its playback rate.
        pitch: f32,
        /// Its low-pass cut-off, in Hz.
        cutoff_hz: f32,
        /// Its reverb send, in dB.
        send_db: f32,
        /// Fade-in, in seconds.
        fade_in_s: f32,
    },
    /// Stop what plays on `slot`.
    Stop {
        /// The physical track.
        slot: PhysicalSlot,
        /// Fade-out, in seconds.
        fade_s: f32,
    },
    /// A slot's gain.
    Gain {
        /// The physical track.
        slot: PhysicalSlot,
        /// The gain in dB.
        db: f32,
        /// Seconds to get there.
        fade_s: f32,
    },
    /// A slot's pan.
    Pan {
        /// The physical track.
        slot: PhysicalSlot,
        /// The pan, -1..=1.
        pan: f32,
        /// Seconds to get there.
        fade_s: f32,
    },
    /// A slot's playback rate.
    Pitch {
        /// The physical track.
        slot: PhysicalSlot,
        /// The rate.
        rate: f32,
        /// Seconds to get there.
        fade_s: f32,
    },
    /// A slot's low-pass cut-off.
    Cutoff {
        /// The physical track.
        slot: PhysicalSlot,
        /// The cut-off in Hz.
        hz: f32,
        /// Seconds to get there.
        fade_s: f32,
    },
    /// A slot's reverb send.
    Send {
        /// The physical track.
        slot: PhysicalSlot,
        /// The send level in dB.
        db: f32,
        /// Seconds to get there.
        fade_s: f32,
    },
    /// A bus's sim layer.
    BusVolume {
        /// The bus.
        bus: Bus,
        /// The gain in dB.
        db: f32,
        /// Seconds to get there.
        fade_s: f32,
    },
    /// The main track's sim layer.
    MasterVolume {
        /// The gain in dB.
        db: f32,
        /// Seconds to get there.
        fade_s: f32,
    },
    /// The shared reverb's character.
    Reverb {
        /// The preset.
        preset: ReverbPreset,
        /// Seconds to get there.
        fade_s: f32,
    },
    /// Start music on one of the two music tracks.
    MusicStart {
        /// The track.
        track: MusicTrack,
        /// What to play.
        music: MusicId,
        /// How (its `fade_s` is the fade-in).
        opts: MusicOpts,
    },
    /// A music track's gain.
    MusicVolume {
        /// The track.
        track: MusicTrack,
        /// The gain in dB.
        db: f32,
        /// Seconds to get there.
        fade_s: f32,
    },
    /// Stop a music track.
    MusicStop {
        /// The track.
        track: MusicTrack,
        /// Fade-out, in seconds.
        fade_s: f32,
    },
}
