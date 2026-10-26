//! Sounds, music and spatial audio (`genex::audio`, AU-7): `gfx.sound(path)` and `gfx.music(path)`
//! at reset, `ctx.audio` from the update and UI hooks, and `game.audio(AudioSetup)` for ducking,
//! reverb zones and occlusion, over genex-audio.
//!
//! The rule is genex-audio's: the sim decides, the mixer renders, the device drains.
//! - **Decide.** `ctx.audio` queues commands in call order; after the physics step the runtime
//!   hands them to genex-audio's `Director` with the game's own camera as the ears (never an
//!   observer or debug camera) and, with physics, a Rapier occluder. The Director's state (voices,
//!   gains, pans, events, music position) is a pure function of seed, input and ticks, bit-equal on
//!   every destination and pool class. `ctx.audio.playing` reads it, so a game reads back only
//!   logical facts.
//! - **Render.** The mixer renders exactly one tick of samples per tick (kira's renderer on the
//!   sim thread); `audioLevel` reads them. Rendered samples are per target, display only.
//! - **Drain.** A shell that opens a device (a window, Studio Live, the web page, a phone) takes
//!   [`crate::Runtime::audio_output`]'s queue; nothing else ever opens one.
//!
//! Audio never enters the checksum. `state().volatile.audio` shows it once the game asked for a
//! sound or registered `game.audio`; a game that does neither runs no audio work at all.
//!
//! A game with `[audio] enabled = false` is built without the facade's `audio` feature (AU-11):
//! no kira, cpal or symphonia. This module keeps its whole surface, so the game's code compiles
//! unchanged, but every sound and piece of music is missing (`audio-disabled`), `ctx.audio` plays
//! nothing ([`Voice::NONE`], `playing` false), no device opens, and `state().volatile.audio` is
//! `{ enabled: false, issues }` once the game asked for a sound.

use std::cell::RefCell;
use std::sync::Arc;

use genex_audio as ga;
use genex_audio::{AudioCommand, Director, MixerOp, MusicId, SoundId, SoundInfo, StepInput};
use genex_core::json::Value as CoreValue;
use genex_core::paths::is_safe_asset_path;

use crate::camera::Camera;
use crate::gfx::{AssetErrorCode, Assets};
use crate::map::Map;
use crate::math::Vec3;

pub use genex_audio::{
    AUDIO_EVENTS_MAX, Attenuation, AudioErrorCode, AudioEventCode, AudioLevel, AudioSettings, AudioSetup, AudioSpan, Bus,
    DeviceFault, Duck, LOGICAL_VOICES_MAX, Listener, MAX_INSTANCES_DEFAULT, MusicOpts, OCCLUSION_RAYS_PER_TICK,
    PHYSICAL_VOICES_DESKTOP, PHYSICAL_VOICES_PHONE, PHYSICAL_VOICES_WEB, PRIORITY_DEFAULT, PRIORITY_UI, PlayOpts, PoolClass,
    REVERB_ZONES_MAX, ReverbPreset, ReverbZone, SOUNDS_DECODED_MAX_BYTES, SinkQueue, Spatial, Voice, ZoneId, ZoneShape,
};

use engine::Mixer;

/// The `state().volatile` key audio reports under.
pub const VOLATILE_AUDIO_KEY: &str = "audio";
/// Whether this build links the mixer, the decoders and the device output (the `audio` feature).
const AUDIO_BUILT: bool = cfg!(feature = "audio");

/// The mixer, the decoders and the device output: genex-audio's own in a build with the `audio`
/// feature.
#[cfg(feature = "audio")]
mod engine {
    pub(super) use genex_audio::{AudioOutput, Mixer, Music, Sound, decode_sound};
}

/// Stand-ins for a game built with `[audio] enabled = false` (AU-11): every decode is refused
/// `audio-disabled`, so no sound, music, mixer or output is ever made; the types are empty and
/// their methods unreachable.
#[cfg(not(feature = "audio"))]
mod engine {
    use genex_audio::{AudioError, AudioErrorCode, AudioLevel, AudioSettings, DeviceFault, MixerOp, PoolClass, SinkQueue};
    use std::sync::Arc;

    /// The refusal every decode and mixer answers.
    fn disabled() -> AudioError {
        AudioError::new(AudioErrorCode::Disabled, "the game is built with [audio] enabled = false")
    }

    /// Refused: this build has no decoders.
    pub(super) fn decode_sound(_bytes: &[u8], _ext: &str) -> Result<Sound, AudioError> {
        Err(disabled())
    }

    /// A decoded sound: never made in this build.
    #[derive(Clone, Debug)]
    pub(super) enum Sound {}

    impl Sound {
        pub(super) fn frames(&self) -> usize {
            match *self {}
        }

        pub(super) fn seconds(&self) -> f64 {
            match *self {}
        }

        pub(super) fn sample_rate(&self) -> u32 {
            match *self {}
        }
    }

    /// Music: never made in this build.
    #[derive(Clone, Debug)]
    pub(super) enum Music {}

    impl Music {
        /// Refused: this build has no decoders.
        pub(super) fn stream(_bytes: Arc<[u8]>, _ext: &str) -> Result<Music, AudioError> {
            Err(disabled())
        }

        pub(super) fn from_sound(sound: Sound) -> Music {
            match sound {}
        }

        pub(super) fn seconds(&self) -> f64 {
            match *self {}
        }

        pub(super) fn sample_rate(&self) -> u32 {
            match *self {}
        }
    }

    /// The mixer: never made in this build.
    pub(super) enum Mixer {}

    impl Mixer {
        /// Refused: this build has no mixer.
        pub(super) fn new(_class: PoolClass) -> Result<Mixer, AudioError> {
            Err(disabled())
        }

        pub(super) fn reset(&mut self) -> Result<(), AudioError> {
            match *self {}
        }

        pub(super) fn set_settings(&mut self, _settings: AudioSettings) {
            match *self {}
        }

        pub(super) fn set_muted(&mut self, _muted: bool) {
            match *self {}
        }

        pub(super) fn add_sound(&mut self, _sound: Sound) {
            match *self {}
        }

        pub(super) fn add_music(&mut self, _music: Music) {
            match *self {}
        }

        pub(super) fn apply(&mut self, _ops: &[MixerOp]) {
            match *self {}
        }

        pub(super) fn tick(&mut self) -> &[f32] {
            match *self {}
        }

        pub(super) fn level(&self) -> AudioLevel {
            match *self {}
        }
    }

    /// A device output: never opened in this build.
    pub(super) enum AudioOutput {}

    impl AudioOutput {
        /// Refused: this build opens no device.
        pub(super) fn open(_queue: SinkQueue, _class: PoolClass) -> Result<AudioOutput, DeviceFault> {
            Err(DeviceFault::NoDevice)
        }

        pub(super) fn fault(&self) -> Option<DeviceFault> {
            match *self {}
        }
    }
}

/// Every audio call the reference's audio page teaches, in its order (the vocabulary fixture's
/// `audio.calls`, AU-9).
pub const AUDIO_CALLS: [&str; 26] = [
    "gfx.sound",
    "gfx.music",
    "game.audio",
    "ctx.audio.play",
    "ctx.audio.play_with",
    "ctx.audio.play_at",
    "ctx.audio.stop",
    "ctx.audio.stop_bus",
    "ctx.audio.set_position",
    "ctx.audio.teleport",
    "ctx.audio.set_volume",
    "ctx.audio.set_pitch",
    "ctx.audio.playing",
    "ctx.audio.position_s",
    "ctx.audio.bus_volume",
    "ctx.audio.master_volume",
    "ctx.audio.music",
    "ctx.audio.stop_music",
    "ctx.audio.listener",
    "ctx.audio.add_zone",
    "ctx.audio.remove_zone",
    "PlayOpts::ui",
    ".max_instances",
    "sound.refusal",
    "sound.is_missing",
    "sound.seconds",
];

/// The id a missing sound plays: never registered, so a play is refused `sound-missing`.
const MISSING_SOUND: SoundId = SoundId(u32::MAX);
/// The id missing music plays: never registered, so the Director refuses it.
const MISSING_MUSIC: MusicId = MusicId(u32::MAX);
/// Bytes one decoded stereo f32 frame holds.
const STEREO_FRAME_BYTES: usize = 8;
/// The quietest a person's volume reads in `volatile.audio.buses` (the mixer's silence floor).
const PERSON_SILENCE_DB: f32 = -60.0;

/// Why a sound or music handle is missing: an asset refusal (`unsafe-path`, `not-at-reset`,
/// `not-preloaded`, `missing`, `too-large`) or an audio one (`unsupported-format`, `needs-import`,
/// `malformed`, `too-large`, `memory-limit`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SoundRefusal {
    /// The asset read refused.
    Asset(AssetErrorCode),
    /// The decoder or the decoded-bytes cap refused.
    Audio(AudioErrorCode),
}

impl SoundRefusal {
    /// The refusal's wire spelling.
    pub const fn as_str(self) -> &'static str {
        match self {
            SoundRefusal::Asset(code) => code.wire(),
            SoundRefusal::Audio(code) => code.as_str(),
        }
    }
}

/// A short sound decoded at reset (`gfx.sound(path)`): cheap to clone. A missing or refused file
/// is a missing sound: a play of it is refused `sound-missing` (silence, an event, no panic), and
/// `state().volatile.audio.issues` names why.
#[derive(Clone, Debug, PartialEq)]
pub struct Sound {
    path: Option<Arc<str>>,
    id: SoundId,
    seconds: f32,
    refusal: Option<SoundRefusal>,
}

impl Sound {
    /// The path under `assets/` it was asked for (None for an unsafe path).
    pub fn path(&self) -> Option<&str> {
        self.path.as_deref()
    }

    /// Whether it plays silence.
    pub fn is_missing(&self) -> bool {
        self.refusal.is_some()
    }

    /// Why it is missing.
    pub fn refusal(&self) -> Option<SoundRefusal> {
        self.refusal
    }

    /// Length in seconds at pitch 1 (0 for a missing sound).
    pub fn seconds(&self) -> f32 {
        self.seconds
    }
}

/// Streamed music (`gfx.music(path)`): Ogg Vorbis stays compressed and decodes while it plays;
/// another format `gfx.sound` reads is held decoded.
#[derive(Clone, Debug, PartialEq)]
pub struct Music {
    path: Option<Arc<str>>,
    id: MusicId,
    seconds: f32,
    refusal: Option<SoundRefusal>,
}

impl Music {
    /// The path under `assets/` it was asked for (None for an unsafe path).
    pub fn path(&self) -> Option<&str> {
        self.path.as_deref()
    }

    /// Whether it plays silence.
    pub fn is_missing(&self) -> bool {
        self.refusal.is_some()
    }

    /// Why it is missing.
    pub fn refusal(&self) -> Option<SoundRefusal> {
        self.refusal
    }

    /// Length in seconds (for streamed music, what its container claims).
    pub fn seconds(&self) -> f32 {
        self.seconds
    }
}

impl<W> crate::Game<W> {
    /// The game's audio setup: default spatial falloff, ducking rules, reverb zones present from
    /// the first tick and whether colliders occlude (needs physics). Registered once; a second
    /// call is the install refusal `duplicate-audio`, more than [`REVERB_ZONES_MAX`] zones is
    /// `audio-zone-limit`. A game that only plays sounds needs no call.
    pub fn audio(&mut self, setup: AudioSetup) -> &mut Self {
        self.g6.audio.setups.push(setup);
        self
    }
}

/// `game.audio`: the setups registered (install refuses more than one).
#[derive(Debug, Default)]
pub(crate) struct Setup {
    setups: Vec<AudioSetup>,
}

impl Setup {
    /// The registered setup, if any.
    pub(crate) fn setup(&self) -> Option<&AudioSetup> {
        self.setups.first()
    }

    /// How many setups were registered.
    pub(crate) fn count(&self) -> usize {
        self.setups.len()
    }
}

/// One file the bank decoded, or why it refused it; kept across seeds.
#[derive(Clone, Copy, Debug)]
enum Entry {
    Ready { id: u32, seconds: f32 },
    Refused(SoundRefusal),
}

/// What `gfx.sound` and `gfx.music` decoded: kept across seeds (a re-seed neither reads nor
/// decodes again), handed to the runtime's mixer and Director after each reset.
#[derive(Debug, Default)]
pub(crate) struct Bank {
    inner: RefCell<BankInner>,
}

#[derive(Debug, Default)]
struct BankInner {
    sounds: Map<String, Entry>,
    musics: Map<String, Entry>,
    /// Decoded sounds in id order (the mixer's and the Director's ids).
    decoded: Vec<(Arc<str>, engine::Sound)>,
    /// Music in id order.
    music: Vec<(Arc<str>, engine::Music)>,
    decoded_bytes: usize,
    /// Refusals in first-request order (`volatile.audio.issues`).
    issues: Vec<(Arc<str>, SoundRefusal)>,
}

/// The extension of `path`, lower-cased ("" with none).
fn extension(path: &str) -> String {
    path.rsplit_once('.').map(|(_, ext)| ext.to_ascii_lowercase()).unwrap_or_default()
}

/// The path a handle keeps: None for an unsafe one, so a hostile path is never echoed back.
fn kept_path(path: &str) -> Option<Arc<str>> {
    is_safe_asset_path(path).then(|| Arc::from(path))
}

impl Bank {
    /// Whether the game asked for any sound or music (audio then runs every tick).
    pub(crate) fn used(&self) -> bool {
        let inner = self.inner.borrow();
        !inner.sounds.is_empty() || !inner.musics.is_empty() || !inner.issues.is_empty()
    }

    /// `gfx.sound(path)`: read as `gfx.assets().bytes` reads (in `on_reset`, boot and sim groups,
    /// a safe path), decoded once and cached across seeds; a refusal is a missing sound. An asset
    /// refusal is checked on every call (it says when or how the read was asked, not what the
    /// file is); a decode refusal is cached with the file.
    pub(crate) fn sound(&self, assets: &Assets, path: &str) -> Sound {
        let missing = |refusal| Sound { path: kept_path(path), id: MISSING_SOUND, seconds: 0.0, refusal: Some(refusal) };
        let ready = |id, seconds| Sound { path: Some(Arc::from(path)), id: SoundId(id), seconds, refusal: None };
        let bytes = match assets.bytes(path) {
            Ok(bytes) => bytes,
            Err(error) => {
                let refusal = SoundRefusal::Asset(error.code());
                self.note_issue(path, refusal);
                return missing(refusal);
            }
        };
        let known = self.inner.borrow().sounds.get(path).copied();
        if let Some(entry) = known {
            return match entry {
                Entry::Ready { id, seconds } => ready(id, seconds),
                Entry::Refused(refusal) => missing(refusal),
            };
        }
        let decoded = engine::decode_sound(&bytes, &extension(path)).map_err(|error| SoundRefusal::Audio(error.code()));
        let mut inner = self.inner.borrow_mut();
        let admitted = decoded.and_then(|sound| {
            let total = inner.decoded_bytes.saturating_add(sound.frames().saturating_mul(STEREO_FRAME_BYTES));
            if total > SOUNDS_DECODED_MAX_BYTES {
                return Err(SoundRefusal::Audio(AudioErrorCode::MemoryLimit));
            }
            inner.decoded_bytes = total;
            Ok(sound)
        });
        let entry = match admitted {
            Ok(sound) => {
                let id = u32::try_from(inner.decoded.len()).unwrap_or(u32::MAX - 1);
                let seconds = sound.seconds() as f32;
                inner.decoded.push((Arc::from(path), sound));
                Entry::Ready { id, seconds }
            }
            Err(refusal) => Entry::Refused(refusal),
        };
        inner.sounds.insert(path.to_owned(), entry);
        drop(inner);
        match entry {
            Entry::Ready { id, seconds } => ready(id, seconds),
            Entry::Refused(refusal) => {
                self.note_issue(path, refusal);
                missing(refusal)
            }
        }
    }

    /// `gfx.music(path)`: Ogg streams, anything else `gfx.sound` reads is held decoded.
    pub(crate) fn music(&self, assets: &Assets, path: &str) -> Music {
        let missing = |refusal| Music { path: kept_path(path), id: MISSING_MUSIC, seconds: 0.0, refusal: Some(refusal) };
        let ready = |id, seconds| Music { path: Some(Arc::from(path)), id: MusicId(id), seconds, refusal: None };
        let bytes = match assets.bytes(path) {
            Ok(bytes) => bytes,
            Err(error) => {
                let refusal = SoundRefusal::Asset(error.code());
                self.note_issue(path, refusal);
                return missing(refusal);
            }
        };
        let known = self.inner.borrow().musics.get(path).copied();
        if let Some(entry) = known {
            return match entry {
                Entry::Ready { id, seconds } => ready(id, seconds),
                Entry::Refused(refusal) => missing(refusal),
            };
        }
        let ext = extension(path);
        let opened = if ext == "ogg" { engine::Music::stream(bytes.shared(), &ext) } else { engine::decode_sound(&bytes, &ext).map(engine::Music::from_sound) };
        let mut inner = self.inner.borrow_mut();
        let entry = match opened {
            Ok(music) => {
                let id = u32::try_from(inner.music.len()).unwrap_or(u32::MAX - 1);
                let seconds = music.seconds() as f32;
                inner.music.push((Arc::from(path), music));
                Entry::Ready { id, seconds }
            }
            Err(error) => Entry::Refused(SoundRefusal::Audio(error.code())),
        };
        inner.musics.insert(path.to_owned(), entry);
        drop(inner);
        match entry {
            Entry::Ready { id, seconds } => ready(id, seconds),
            Entry::Refused(refusal) => {
                self.note_issue(path, refusal);
                missing(refusal)
            }
        }
    }

    /// Remember a refusal for `volatile.audio.issues`, once per path and code (an unsafe path is
    /// listed by its code only).
    fn note_issue(&self, path: &str, refusal: SoundRefusal) {
        let shown: Arc<str> = kept_path(path).unwrap_or_else(|| Arc::from(""));
        let mut inner = self.inner.borrow_mut();
        if !inner.issues.iter().any(|(known, code)| *known == shown && *code == refusal) {
            inner.issues.push((shown, refusal));
        }
    }
}

/// The ears a camera gives: its position, facing its target.
fn ears_of(camera: &Camera) -> Listener {
    let forward = (camera.target - camera.position).normalize_or(Vec3::NEG_Z);
    let up = camera.up.normalize_or(Vec3::Y);
    Listener { position: camera.position, forward, up }
}

/// Colliders that count toward one occlusion ray.
#[cfg(feature = "physics-raw")]
const OCCLUDING_HITS_MAX: usize = 3;
/// A ray shorter than this is open air, in metres.
#[cfg(feature = "physics-raw")]
const OCCLUSION_RAY_MIN_M: f32 = 1e-3;

/// The occluder over the game's Rapier colliders: each non-sensor collider the ray crosses (at
/// most three) lets [`ga::OCCLUDER_TRANSMISSION`] through. Physics colliders only, never render
/// LODs or impostors.
#[cfg(feature = "physics-raw")]
struct RapierOccluder<'a>(&'a crate::PhysicsWorld);

#[cfg(feature = "physics-raw")]
impl ga::Occluder for RapierOccluder<'_> {
    fn transmission(&mut self, from: Vec3, to: Vec3) -> f32 {
        use rapier3d::prelude::{QueryFilter, Ray};
        let delta = to - from;
        let length = delta.length();
        if length.is_nan() || length <= OCCLUSION_RAY_MIN_M {
            return 1.0;
        }
        let ray = Ray::new(from, delta / length);
        let hits = self.0.intersect_ray(ray, length, true, QueryFilter::default().exclude_sensors()).take(OCCLUDING_HITS_MAX).count();
        // Repeated basic multiplication (no powi): the same bits on every destination.
        (0..hits).fold(1.0, |transmission, _| transmission * ga::OCCLUDER_TRANSMISSION)
    }
}

/// What the tick's hooks write and read through `ctx.audio`.
#[derive(Default)]
struct Queue {
    /// The logical state; None until the game asked for a sound or registered `game.audio`.
    director: Option<Director>,
    commands: Vec<AudioCommand>,
}

/// What a shell reported about its device (display only).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct DeviceReport {
    open: bool,
    fault: Option<DeviceFault>,
}

/// The runtime's audio: the command queue, the Director, the mixer and the device queue.
#[derive(Default)]
pub(crate) struct State {
    queue: RefCell<Queue>,
    mixer: Option<Mixer>,
    mixer_refusal: Option<AudioErrorCode>,
    class: Option<PoolClass>,
    /// Sounds and music already handed to the mixer and the Director.
    synced: (usize, usize),
    names: (Vec<Arc<str>>, Vec<Arc<str>>),
    issues: Vec<(Arc<str>, SoundRefusal)>,
    sink: Option<SinkQueue>,
    muted: bool,
    settings: AudioSettings,
    device: DeviceReport,
}

impl std::fmt::Debug for State {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("audio::State").field("active", &self.active()).field("muted", &self.muted).finish_non_exhaustive()
    }
}

/// The pool class of the destination this build runs on.
const fn native_class() -> PoolClass {
    if cfg!(target_arch = "wasm32") {
        PoolClass::Web
    } else if cfg!(any(target_os = "ios", target_os = "android")) {
        PoolClass::Phone
    } else {
        PoolClass::Desktop
    }
}

impl State {
    /// Kept for the G6 tick order (`g6_tick_end`); the step itself runs from the runtime just
    /// before it, which holds the camera hook and the physics world it reads ([`State::step`]).
    pub(crate) fn apply(&mut self, _setup: &Setup) {}

    /// A new seed: the Director goes back to tick 0 (voice ids from 1, the setup's zones) and the
    /// mixer is rebuilt, so `seed(2); seed(1)` renders the same bits as a fresh `seed(1)`.
    pub(crate) fn reset(&mut self, _setup: &Setup) {
        let queue = self.queue.get_mut();
        queue.commands.clear();
        if let Some(director) = queue.director.as_mut() {
            director.reset();
        }
        if let Some(mixer) = self.mixer.as_mut()
            && let Err(error) = mixer.reset()
        {
            self.mixer_refusal = Some(error.code());
            self.mixer = None;
        }
    }

    /// The pool class audio renders with.
    pub(crate) fn class(&self) -> PoolClass {
        self.class.unwrap_or(native_class())
    }

    /// Render with `class`'s physical pool from now on (a shell or test, before the next seed;
    /// the sounds are handed over again at that seed's sync).
    pub(crate) fn set_class(&mut self, class: PoolClass) {
        self.class = Some(class);
        self.queue.get_mut().director = None;
        self.mixer = None;
        self.synced = (0, 0);
        self.names = (Vec::new(), Vec::new());
    }

    fn active(&self) -> bool {
        self.queue.borrow().director.is_some()
    }

    /// Make the Director and the mixer (once the game uses audio).
    fn activate(&mut self, setup: &Setup) {
        let class = self.class();
        let audio_setup = setup.setup().cloned().unwrap_or_default();
        self.queue.get_mut().director = Some(Director::new(class, audio_setup));
        match Mixer::new(class) {
            Ok(mut mixer) => {
                mixer.set_settings(self.settings);
                mixer.set_muted(self.muted);
                self.mixer = Some(mixer);
            }
            Err(error) => self.mixer_refusal = Some(error.code()),
        }
    }

    /// After the reset hooks: start audio once the game uses it, and hand the sounds and music
    /// the reset decoded to the mixer and the Director (ids in bank order on both).
    /// A build without the `audio` feature never starts: it only keeps the bank's refusals.
    #[cfg_attr(not(feature = "audio"), expect(unreachable_code, reason = "a build without audio decodes no sound to hand over"))]
    pub(crate) fn sync(&mut self, setup: &Setup, bank: &Bank) {
        let wanted = setup.setup().is_some() || bank.used();
        if AUDIO_BUILT && wanted && !self.active() {
            self.activate(setup);
        }
        let inner = bank.inner.borrow();
        self.issues.clone_from(&inner.issues);
        let queue = self.queue.get_mut();
        let Some(director) = queue.director.as_mut() else { return };
        for (index, (path, sound)) in inner.decoded.iter().enumerate().skip(self.synced.0) {
            let id = SoundId(u32::try_from(index).unwrap_or(u32::MAX - 1));
            director.register_sound(id, SoundInfo { frames: sound.frames() as u64, rate_hz: sound.sample_rate() });
            if let Some(mixer) = self.mixer.as_mut() {
                mixer.add_sound(sound.clone());
            }
            self.names.0.push(Arc::clone(path));
        }
        for (index, (path, music)) in inner.music.iter().enumerate().skip(self.synced.1) {
            let id = MusicId(u32::try_from(index).unwrap_or(u32::MAX - 1));
            let rate = music.sample_rate();
            let frames = libm::round(music.seconds() * f64::from(rate)) as u64;
            director.register_music(id, SoundInfo { frames, rate_hz: rate });
            if let Some(mixer) = self.mixer.as_mut() {
                mixer.add_music(music.clone());
            }
            self.names.1.push(Arc::clone(path));
        }
        self.synced = (inner.decoded.len(), inner.music.len());
    }

    /// After the physics step: apply the tick's commands with the game's camera as the ears and
    /// the colliders as occluders, then render the tick and queue it for a device, if one drains.
    /// Without audio in use the queue is only emptied.
    pub(crate) fn step<W>(&mut self, camera: impl FnOnce() -> Option<Camera>, sim: &crate::Sim<W>) {
        let queue = self.queue.get_mut();
        let commands = std::mem::take(&mut queue.commands);
        let Some(director) = queue.director.as_mut() else { return };
        let camera = camera();
        #[cfg(feature = "physics-raw")]
        let mut rapier = RapierOccluder(&sim.physics);
        #[cfg(feature = "physics-raw")]
        let occluder: Option<&mut dyn ga::Occluder> = Some(&mut rapier);
        #[cfg(not(feature = "physics-raw"))]
        let occluder: Option<&mut dyn ga::Occluder> = {
            let _ = sim;
            None
        };
        let input = StepInput { camera: camera.as_ref().map(ears_of), occluder };
        let ops: Vec<MixerOp> = director.step(&commands, input).to_vec();
        let Some(mixer) = self.mixer.as_mut() else { return };
        mixer.apply(&ops);
        let block = mixer.tick();
        if let Some(sink) = &self.sink {
            sink.push(block);
        }
    }

    /// What the tick's hooks play through.
    pub(crate) fn ctx(&self) -> CtxAudio<'_> {
        CtxAudio { queue: &self.queue }
    }

    /// The queue a shell's device drains (made on first ask, sized for the pool class).
    pub(crate) fn output(&mut self) -> SinkQueue {
        let class = self.class();
        self.sink.get_or_insert_with(|| SinkQueue::for_class(class)).clone()
    }

    /// `audio({muted})` and a phone's audio gate: silence the device; the meter goes on.
    pub(crate) fn set_muted(&mut self, muted: bool) {
        self.muted = muted;
        if let Some(mixer) = self.mixer.as_mut() {
            mixer.set_muted(muted);
        }
    }

    /// Whether the device output is muted.
    pub(crate) fn muted(&self) -> bool {
        self.muted
    }

    /// `audioLevel`: the last 2048 frames mixed, before the mute (silence without audio).
    pub(crate) fn level(&self) -> AudioLevel {
        self.mixer.as_ref().map(Mixer::level).unwrap_or_default()
    }

    /// The person's volumes, outside the sim.
    pub(crate) fn set_settings(&mut self, settings: AudioSettings) {
        self.settings = settings;
        if let Some(mixer) = self.mixer.as_mut() {
            mixer.set_settings(settings);
        }
    }

    /// The person's volumes.
    pub(crate) fn settings(&self) -> AudioSettings {
        self.settings
    }

    /// What a shell's device reported.
    pub(crate) fn note_device(&mut self, open: bool, fault: Option<DeviceFault>) {
        self.device = DeviceReport { open, fault };
    }

    /// The logical-state hash of genex-audio's Director (0 without audio): equal on every
    /// destination and pool class for the same seed, input and ticks.
    pub(crate) fn logical_hash(&self) -> u64 {
        self.queue.borrow().director.as_ref().map_or(0, Director::logical_hash)
    }

    /// `state().volatile.audio`, once audio is in use; in a build without audio, once the game
    /// asked for a sound.
    pub(crate) fn volatile_value(&self) -> Option<CoreValue> {
        let queue = self.queue.borrow();
        let Some(director) = queue.director.as_ref() else { return self.disabled_value() };
        let mut audio = CoreValue::object();
        audio.set("pool", self.pool_value(director));
        audio.set("voices", CoreValue::Array(director.voices().iter().map(|voice| self.voice_value(voice)).collect()));
        audio.set("buses", buses_value(director, &self.settings));
        audio.set("music", self.music_value(director));
        audio.set("listener", listener_value(director));
        audio.set("zone", director.zone().map_or(CoreValue::Null, |(_, zone)| CoreValue::from(zone.name)));
        audio.set("events", CoreValue::Array(director.events().events().iter().map(|event| self.event_value(event)).collect()));
        audio.set("counts", counts_value(director.events().counts()));
        audio.set("person", person_value(&self.settings));
        audio.set("device", self.device_value());
        audio.set("issues", CoreValue::Array(self.issues.iter().map(|(path, refusal)| issue_value(path, *refusal)).collect()));
        Some(audio)
    }

    /// `{ enabled: false, issues }` in a build without the `audio` feature, once there are issues.
    fn disabled_value(&self) -> Option<CoreValue> {
        if AUDIO_BUILT || self.issues.is_empty() {
            return None;
        }
        let mut audio = CoreValue::object();
        audio.set("enabled", CoreValue::from(false));
        audio.set("issues", CoreValue::Array(self.issues.iter().map(|(path, refusal)| issue_value(path, *refusal)).collect()));
        Some(audio)
    }

    fn pool_value(&self, director: &Director) -> CoreValue {
        let voices = director.voices();
        let virtual_count = voices.iter().filter(|voice| voice.is_virtual()).count();
        let mut pool = CoreValue::object();
        pool.set("logical", CoreValue::from(LOGICAL_VOICES_MAX as u64));
        pool.set("physical", CoreValue::from(self.class().physical_voices() as u64));
        pool.set("class", CoreValue::from(self.class().as_str()));
        pool.set("active", CoreValue::from(voices.len() as u64));
        pool.set("virtual", CoreValue::from(virtual_count as u64));
        pool
    }

    fn name_of(names: &[Arc<str>], index: Option<u32>) -> CoreValue {
        index.and_then(|index| names.get(index as usize)).map_or(CoreValue::Null, |name| CoreValue::from(&**name))
    }

    fn voice_value(&self, voice: &ga::LogicalVoice) -> CoreValue {
        let mut value = CoreValue::object();
        value.set("id", CoreValue::from(voice.voice.id()));
        value.set("sound", State::name_of(&self.names.0, Some(voice.sound.0)));
        value.set("bus", CoreValue::from(voice.bus.as_str()));
        value.set("gainDb", CoreValue::from(voice.gain_db));
        value.set("pan", CoreValue::from(voice.pan));
        value.set("cutoffHz", CoreValue::from(voice.cutoff_hz));
        value.set("occluded", CoreValue::from(voice.occluded));
        value.set("virtual", CoreValue::from(voice.is_virtual()));
        value.set("positionS", CoreValue::from(voice.position_s()));
        value
    }

    fn music_value(&self, director: &Director) -> CoreValue {
        let Some(track) = director.music_track() else { return CoreValue::Null };
        let name = |track| State::name_of(&self.names.1, director.music_id(track).map(|id| id.0));
        let mut music = CoreValue::object();
        music.set("path", name(track));
        music.set("positionS", CoreValue::from(director.music_position_s(track).unwrap_or(0.0)));
        music.set("fadingFrom", name(track.other()));
        music
    }

    fn event_value(&self, event: &ga::AudioEvent) -> CoreValue {
        let mut value = CoreValue::object();
        value.set("tick", CoreValue::from(event.tick));
        value.set("code", CoreValue::from(event.code.as_str()));
        value.set("voice", CoreValue::from(event.voice.id()));
        value.set("sound", State::name_of(&self.names.0, event.sound.map(|id| id.0)));
        if event.by != Voice::NONE {
            value.set("by", CoreValue::from(event.by.id()));
        }
        if let Some(music) = event.music {
            value.set("music", State::name_of(&self.names.1, Some(music.0)));
        }
        if let Some(reason) = event.reason {
            value.set("reason", CoreValue::from(reason.as_str()));
        }
        value
    }

    fn device_value(&self) -> CoreValue {
        let mut device = CoreValue::object();
        device.set("open", CoreValue::from(self.device.open));
        device.set("muted", CoreValue::from(self.muted));
        device.set("queuedMs", CoreValue::from(self.sink.as_ref().map_or(0.0, SinkQueue::queued_ms)));
        device.set("underruns", CoreValue::from(self.sink.as_ref().map_or(0, SinkQueue::underruns)));
        device.set("fault", self.device.fault.map_or(CoreValue::Null, |fault| CoreValue::from(fault.as_str())));
        if let Some(refusal) = self.mixer_refusal {
            device.set("mixer", CoreValue::from(refusal.as_str()));
        }
        device
    }
}

fn buses_value(director: &Director, settings: &AudioSettings) -> CoreValue {
    let mut buses = CoreValue::object();
    for bus in Bus::ALL {
        let mut layers = CoreValue::object();
        layers.set("simDb", CoreValue::from(director.bus_db(bus)));
        layers.set("personDb", CoreValue::from(person_db(settings.bus(bus))));
        buses.set(bus.as_str(), layers);
    }
    buses
}

/// A person's linear volume in dB, as the mixer applies it (0 is its silence floor, 1 is 0 dB).
fn person_db(volume: f32) -> f32 {
    if volume.is_nan() || volume <= 0.0 {
        return PERSON_SILENCE_DB;
    }
    (20.0 * libm::log10f(volume.min(1.0))).max(PERSON_SILENCE_DB)
}

fn listener_value(director: &Director) -> CoreValue {
    let (ears, from_camera) = director.listener();
    let mut listener = CoreValue::object();
    listener.set("from", CoreValue::from(if from_camera { "camera" } else { "game" }));
    let position = ears.position;
    listener.set("position", CoreValue::Array(vec![position.x.into(), position.y.into(), position.z.into()]));
    listener
}

fn counts_value(counts: ga::AudioCounts) -> CoreValue {
    let mut value = CoreValue::object();
    value.set("played", CoreValue::from(counts.played));
    value.set("stolen", CoreValue::from(counts.stolen));
    value.set("refused", CoreValue::from(counts.refused));
    value.set("virtualized", CoreValue::from(counts.virtualized));
    value
}

fn person_value(settings: &AudioSettings) -> CoreValue {
    let mut value = CoreValue::object();
    value.set("master", CoreValue::from(settings.master));
    for bus in Bus::ALL {
        value.set(bus.as_str(), CoreValue::from(settings.bus(bus)));
    }
    value
}

fn issue_value(path: &str, refusal: SoundRefusal) -> CoreValue {
    let mut value = CoreValue::object();
    value.set("path", if path.is_empty() { CoreValue::Null } else { CoreValue::from(path) });
    value.set("code", CoreValue::from(refusal.as_str()));
    value
}

/// Whether this process may open an audio device: never under `GENEX_NO_WINDOW=1` (the marker
/// rust-env sets for `cargo test` and `cargo bench`), so no test reaches a real device.
fn devices_forbidden_here() -> bool {
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    {
        genex_platform_desktop::windows_forbidden_here()
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        false
    }
}

/// Whether a desktop shell frame may open the audio device: only a windowed run a person sees,
/// never a headless one, and never in a process marked `GENEX_NO_WINDOW=1`.
#[doc(hidden)]
pub const fn may_open_device(headless: bool, forbidden: bool) -> bool {
    !headless && !forbidden
}

/// A shell's audio device (AU-8): opened at most once, and only for a run a person sees (the
/// desktop window, Studio Live while embedded, the web page after its first gesture, a phone once
/// its audio is granted); dropping it stops the sound. Never opened under `GENEX_NO_WINDOW=1`.
#[doc(hidden)]
#[derive(Default)]
pub struct Device {
    output: Option<engine::AudioOutput>,
    tried: bool,
    refused: Option<DeviceFault>,
}

impl std::fmt::Debug for Device {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("audio::Device").field("open", &self.is_open()).field("fault", &self.fault()).finish()
    }
}

impl Device {
    /// Open the destination's default output on the runtime's queue the first time it is asked
    /// (`queue` is called only then); later calls change nothing. Answers whether it is open.
    pub fn open_once(&mut self, queue: impl FnOnce() -> (SinkQueue, PoolClass)) -> bool {
        self.open_once_where(devices_forbidden_here(), queue)
    }

    /// [`Device::open_once`] with the process's marker given: `forbidden` opens nothing (and
    /// never calls `queue`), as a process marked `GENEX_NO_WINDOW=1` does, and neither does a
    /// build without the `audio` feature.
    pub fn open_once_where(&mut self, forbidden: bool, queue: impl FnOnce() -> (SinkQueue, PoolClass)) -> bool {
        if self.tried {
            return self.is_open();
        }
        self.tried = true;
        if forbidden || !AUDIO_BUILT {
            return false;
        }
        let (queue, class) = queue();
        match engine::AudioOutput::open(queue, class) {
            Ok(output) => self.output = Some(output),
            Err(fault) => self.refused = Some(fault),
        }
        self.is_open()
    }

    /// Whether the open was asked for already.
    pub fn tried(&self) -> bool {
        self.tried
    }

    /// Whether a device plays.
    pub fn is_open(&self) -> bool {
        self.output.is_some()
    }

    /// The open's refusal, else the last fault the device reported.
    pub fn fault(&self) -> Option<DeviceFault> {
        self.refused.or_else(|| self.output.as_ref().and_then(engine::AudioOutput::fault))
    }

    /// Open on `runtime`'s queue (once) and report the device to its `volatile.audio.device`.
    pub fn open_for<W>(&mut self, runtime: &mut crate::Runtime<W>) {
        let open = self.open_once(|| (runtime.audio_output(), runtime.audio_pool()));
        runtime.note_audio_device(open, self.fault());
    }
}

/// What an update or UI hook plays through (`ctx.audio`): commands apply after the hooks and
/// the physics step, in call order. Reads (`playing`, `position_s`) answer the logical state as
/// of the end of the last tick, the same on every destination and device class. A game that
/// asked for no sound and registered no `game.audio` has nothing to play: every call is a no-op.
#[derive(Clone, Copy)]
pub struct CtxAudio<'a> {
    queue: &'a RefCell<Queue>,
}

impl std::fmt::Debug for CtxAudio<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CtxAudio").finish_non_exhaustive()
    }
}

impl CtxAudio<'_> {
    fn push(&self, command: AudioCommand) {
        let mut queue = self.queue.borrow_mut();
        if queue.director.is_some() {
            queue.commands.push(command);
        }
    }

    /// Play `sound` once on the sfx bus.
    pub fn play(&self, sound: &Sound) -> Voice {
        self.play_with(sound, PlayOpts::default())
    }

    /// Play `sound` with `opts`; answers its voice ([`Voice::NONE`] when the game uses no audio).
    /// A missing sound still takes an id; its play is refused `sound-missing`.
    pub fn play_with(&self, sound: &Sound, opts: PlayOpts) -> Voice {
        let mut queue = self.queue.borrow_mut();
        let Some(director) = queue.director.as_mut() else { return Voice::NONE };
        let voice = director.issue_voice();
        queue.commands.push(AudioCommand::Play { voice, sound: sound.id, opts });
        voice
    }

    /// Play `sound` once at a world position (spatial).
    pub fn play_at(&self, sound: &Sound, position: Vec3) -> Voice {
        self.play_with(sound, PlayOpts::default().at(position))
    }

    /// Stop `voice` over `fade_s` seconds.
    pub fn stop(&self, voice: Voice, fade_s: f32) {
        self.push(AudioCommand::Stop { voice, fade_s });
    }

    /// Stop every voice on `bus` over `fade_s` seconds.
    pub fn stop_bus(&self, bus: Bus, fade_s: f32) {
        self.push(AudioCommand::StopBus { bus, fade_s });
    }

    /// Move a spatial voice.
    pub fn set_position(&self, voice: Voice, position: Vec3) {
        self.push(AudioCommand::SetPosition { voice, position });
    }

    /// Move without a Doppler sweep (respawn, portal).
    pub fn teleport(&self, voice: Voice, position: Vec3) {
        self.push(AudioCommand::Teleport { voice, position });
    }

    /// A voice's gain in dB, over `fade_s` seconds.
    pub fn set_volume(&self, voice: Voice, db: f32, fade_s: f32) {
        self.push(AudioCommand::SetVolume { voice, db, fade_s });
    }

    /// A voice's playback rate, over `fade_s` seconds.
    pub fn set_pitch(&self, voice: Voice, rate: f32, fade_s: f32) {
        self.push(AudioCommand::SetPitch { voice, rate, fade_s });
    }

    /// Whether `voice` is still playing (logical: the same on every destination and device class).
    pub fn playing(&self, voice: Voice) -> bool {
        self.queue.borrow().director.as_ref().is_some_and(|director| director.playing(voice))
    }

    /// Seconds into `voice`, or None once it ended.
    pub fn position_s(&self, voice: Voice) -> Option<f32> {
        self.queue.borrow().director.as_ref().and_then(|director| director.position_s(voice)).map(|seconds| seconds as f32)
    }

    /// A bus's sim layer in dB, over `fade_s` seconds (reset on seed; the person's volume is apart).
    pub fn bus_volume(&self, bus: Bus, db: f32, fade_s: f32) {
        self.push(AudioCommand::BusVolume { bus, db, fade_s });
    }

    /// The main track's sim layer in dB, over `fade_s` seconds.
    pub fn master_volume(&self, db: f32, fade_s: f32) {
        self.push(AudioCommand::MasterVolume { db, fade_s });
    }

    /// Play `music`, crossfading from what plays.
    pub fn music(&self, music: &Music, opts: MusicOpts) {
        self.push(AudioCommand::Music { music: music.id, opts });
    }

    /// Fade the music out over `fade_s` seconds.
    pub fn stop_music(&self, fade_s: f32) {
        self.push(AudioCommand::StopMusic { fade_s });
    }

    /// Use these ears from now on instead of the camera's; None goes back to the camera.
    pub fn listener(&self, listener: Option<Listener>) {
        self.push(AudioCommand::Listener(listener));
    }

    /// Add a reverb zone; answers its id (a zone past [`REVERB_ZONES_MAX`] is refused `zone-limit`).
    pub fn add_zone(&self, zone: ReverbZone) -> ZoneId {
        let mut queue = self.queue.borrow_mut();
        let Some(director) = queue.director.as_mut() else { return ZoneId::default() };
        let id = director.issue_zone();
        queue.commands.push(AudioCommand::AddZone { zone: id, def: zone });
        id
    }

    /// Remove a reverb zone.
    pub fn remove_zone(&self, zone: ZoneId) {
        self.push(AudioCommand::RemoveZone(zone));
    }
}

/// The waveform of the asset-import fixture `tone.wav` (FFmpeg's 440 Hz sine, mono, 48 kHz, 0.5 s,
/// peak 4095) as a 16-bit PCM WAV, synthesized for unit tests: a forked engine crate's sources may
/// not include a file outside the crate (the eject stage refuses `include-escape`).
#[cfg(test)]
#[cfg_attr(not(feature = "audio"), allow(dead_code, reason = "the rows that decode it need the audio feature"))]
pub(crate) fn test_tone_wav() -> &'static [u8] {
    const RATE: u32 = 48_000;
    const FRAMES: u32 = RATE / 2;
    const PEAK: f64 = 4095.0;
    let data_bytes = FRAMES * 2;
    let mut bytes = Vec::with_capacity(44 + data_bytes as usize);
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(36 + data_bytes).to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&RATE.to_le_bytes());
    bytes.extend_from_slice(&(RATE * 2).to_le_bytes());
    bytes.extend_from_slice(&2u16.to_le_bytes());
    bytes.extend_from_slice(&16u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&data_bytes.to_le_bytes());
    for frame in 0..FRAMES {
        let phase = 2.0 * std::f64::consts::PI * 440.0 * f64::from(frame) / f64::from(RATE);
        let sample = (phase.sin() * PEAK).round() as i16;
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    Box::leak(bytes.into_boxed_slice())
}
