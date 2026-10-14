//! The device-less mixer: kira's renderer driven by the simulated clock through a backend that
//! owns it, instead of an audio thread pulling from it.

use crate::meter::{AudioLevel, AudioMeter};
use kira::backend::{Backend, Renderer};
use kira::sound::static_sound::{StaticSoundData, StaticSoundHandle, StaticSoundSettings};
use kira::{AudioManager, AudioManagerSettings, Frame};
use std::fmt;
use std::sync::Arc;

/// The rate the mixer runs at: the studio recipe's `nativeAudioRateHz`, so a Rust game's centroid
/// is measured at the same rate a raylib game's is.
pub const MIXER_RATE_HZ: u32 = 48_000;
/// Frames one 60 Hz tick renders.
pub const FRAMES_PER_TICK: usize = (MIXER_RATE_HZ / 60) as usize;
const STEREO: usize = 2;
/// kira updates clocks and modulators every this many frames (its default).
const INTERNAL_BUFFER_FRAMES: usize = 128;

/// Why the mixer refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum AudioErrorCode {
    /// kira's backend could not start.
    MixerFailed,
    /// Every sound slot is playing.
    SoundLimit,
    /// A format the runtime never plays: raylib's QOA and its XM and MOD trackers, video, or an
    /// extension it does not know.
    UnsupportedFormat,
    /// Opus or AAC: the studio's import step converts it to Ogg before the game sees it.
    NeedsImport,
    /// The bytes are not the format the name says, or are damaged.
    Malformed,
    /// Larger than the runtime decodes into memory.
    TooLarge,
}

impl AudioErrorCode {
    /// The typed code's wire spelling.
    pub const fn as_str(self) -> &'static str {
        match self {
            AudioErrorCode::MixerFailed => "mixer-failed",
            AudioErrorCode::SoundLimit => "sound-limit",
            AudioErrorCode::UnsupportedFormat => "unsupported-format",
            AudioErrorCode::NeedsImport => "needs-import",
            AudioErrorCode::Malformed => "malformed",
            AudioErrorCode::TooLarge => "too-large",
        }
    }
}

/// A refused audio call.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AudioError {
    code: AudioErrorCode,
    detail: String,
}

impl AudioError {
    pub(crate) fn new(code: AudioErrorCode, detail: impl Into<String>) -> AudioError {
        AudioError { code, detail: detail.into() }
    }

    /// The typed code.
    pub fn code(&self) -> AudioErrorCode {
        self.code
    }
}

impl fmt::Display for AudioError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.detail)
    }
}

impl std::error::Error for AudioError {}

/// A kira backend with no device: it keeps the renderer and renders when the runtime asks.
pub(crate) struct DevicelessBackend {
    renderer: Option<Renderer>,
}

impl Backend for DevicelessBackend {
    type Settings = ();
    type Error = AudioError;

    fn setup(_settings: (), _internal_buffer_size: usize) -> Result<(DevicelessBackend, u32), AudioError> {
        Ok((DevicelessBackend { renderer: None }, MIXER_RATE_HZ))
    }

    fn start(&mut self, renderer: Renderer) -> Result<(), AudioError> {
        self.renderer = Some(renderer);
        Ok(())
    }
}

impl DevicelessBackend {
    /// Apply the commands sent since the last block, then render `out` (interleaved stereo).
    fn render(&mut self, out: &mut [f32]) {
        match self.renderer.as_mut() {
            Some(renderer) => {
                renderer.on_start_processing();
                renderer.process(out, STEREO as u16);
            }
            None => out.fill(0.0),
        }
    }
}

/// Audio a game plays: decoded frames at their own rate.
#[derive(Clone, Debug)]
pub struct Sound {
    data: StaticSoundData,
}

impl Sound {
    /// A sound from stereo frames (`[left, right]`) at `sample_rate` Hz.
    pub fn from_frames(sample_rate: u32, frames: &[[f32; 2]]) -> Sound {
        let frames: Arc<[Frame]> = frames.iter().map(|[left, right]| Frame { left: *left, right: *right }).collect();
        Sound { data: StaticSoundData { sample_rate, frames, settings: StaticSoundSettings::default(), slice: None } }
    }

    /// A sound kira decoded.
    pub(crate) fn from_data(data: StaticSoundData) -> Sound {
        Sound { data }
    }

    /// Frames in the sound.
    pub fn frames(&self) -> usize {
        self.data.frames.len()
    }

    /// The sound's own sample rate, in Hz.
    pub fn sample_rate(&self) -> u32 {
        self.data.sample_rate
    }
}

/// The game's mixer, stepped once per simulation tick.
pub struct Mixer {
    manager: AudioManager<DevicelessBackend>,
    meter: AudioMeter,
    block: Vec<f32>,
    muted: bool,
}

impl Mixer {
    /// A mixer with no audio device: what headless and boxed runs use, and what feeds a device.
    pub fn deviceless() -> Result<Mixer, AudioError> {
        let settings = AudioManagerSettings::<DevicelessBackend> {
            internal_buffer_size: INTERNAL_BUFFER_FRAMES,
            ..AudioManagerSettings::default()
        };
        let manager = AudioManager::new(settings)?;
        Ok(Mixer { manager, meter: AudioMeter::default(), block: vec![0.0; FRAMES_PER_TICK * STEREO], muted: false })
    }

    /// Start playing `sound` on the next tick.
    pub fn play(&mut self, sound: &Sound) -> Result<StaticSoundHandle, AudioError> {
        let played = self.manager.play(sound.data.clone());
        played.map_err(|error| AudioError::new(AudioErrorCode::SoundLimit, error.to_string()))
    }

    /// Render one tick ([`FRAMES_PER_TICK`] frames), feed the meter, and answer the block a device
    /// would play: interleaved stereo, silent while muted.
    pub fn tick(&mut self) -> &[f32] {
        self.manager.backend_mut().render(&mut self.block);
        self.meter.feed(&self.block);
        if self.muted {
            self.block.fill(0.0);
        }
        &self.block
    }

    /// `audioLevel`: the level of the last 2048 frames mixed, before the mute.
    pub fn level(&self) -> AudioLevel {
        self.meter.level(f64::from(MIXER_RATE_HZ))
    }

    /// The `audio({muted})` verb: silence the device output; the meter still reads the mix, as the
    /// C++ runtime's mixed-processor tap does.
    pub fn set_muted(&mut self, muted: bool) {
        self.muted = muted;
    }

    /// Whether the device output is muted.
    pub fn muted(&self) -> bool {
        self.muted
    }
}
