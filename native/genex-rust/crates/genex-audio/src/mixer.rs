//! The device-less mixer: kira's renderer driven by the simulated clock through a backend that
//! owns it, instead of an audio thread pulling from it. It renders [`MixerOp`]s onto the bus
//! graph ([`crate::graph`]): each bus's track volume is its sim layer (from the ops, reset on
//! seed) plus its person layer ([`AudioSettings`], outside the sim), and `audioLevel` reads the
//! mix after both layers and before the mute.

use crate::graph::{BusGraph, VoiceStart, all_finite, person_db};
use crate::meter::{AudioLevel, AudioMeter};
use crate::music::Music;
use crate::ops::{MixerOp, MusicId, MusicTrack, SoundId};
/// Kept here too, so the decode and device modules name them where they always did.
pub(crate) use crate::vocab::{AudioError, AudioErrorCode, FRAMES_PER_TICK, MIXER_RATE_HZ};
use crate::vocab::{AudioSettings, Bus, PoolClass};
use kira::Frame;
use kira::backend::{Backend, Renderer};
use kira::sound::static_sound::{StaticSoundData, StaticSoundHandle, StaticSoundSettings};
use std::sync::Arc;

const STEREO: usize = 2;

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
    pub(crate) fn render(&mut self, out: &mut [f32]) {
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

    /// The decoded data.
    pub(crate) fn data(&self) -> &StaticSoundData {
        &self.data
    }

    /// Frames in the sound.
    pub fn frames(&self) -> usize {
        self.data.frames.len()
    }

    /// The sound's own sample rate, in Hz.
    pub fn sample_rate(&self) -> u32 {
        self.data.sample_rate
    }

    /// Length in seconds at pitch 1.
    pub fn seconds(&self) -> f64 {
        self.frames() as f64 / f64::from(self.sample_rate().max(1))
    }
}

/// The sim layers: what the ops set, back to 0 dB on every reset.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct SimLayers {
    bus_db: [f32; Bus::ALL.len()],
    master_db: f32,
}

/// The game's mixer, stepped once per simulation tick.
pub struct Mixer {
    class: PoolClass,
    graph: BusGraph,
    sounds: Vec<Sound>,
    music: Vec<Music>,
    sim: SimLayers,
    person: AudioSettings,
    meter: AudioMeter,
    block: Vec<f32>,
    muted: bool,
    dropped_ops: u64,
}

impl Mixer {
    /// A desktop-class mixer with no audio device: what headless and boxed runs use, and what
    /// feeds a device.
    pub fn deviceless() -> Result<Mixer, AudioError> {
        Mixer::new(PoolClass::Desktop)
    }

    /// A mixer rendering through `class`'s physical voice pool.
    pub fn new(class: PoolClass) -> Result<Mixer, AudioError> {
        let graph = BusGraph::new(class)?;
        Ok(Mixer {
            class,
            graph,
            sounds: Vec::new(),
            music: Vec::new(),
            sim: SimLayers::default(),
            person: AudioSettings::default(),
            meter: AudioMeter::default(),
            block: vec![0.0; FRAMES_PER_TICK * STEREO],
            muted: false,
            dropped_ops: 0,
        })
    }

    /// The pool class.
    pub fn class(&self) -> PoolClass {
        self.class
    }

    /// Physical voice tracks in the pool.
    pub fn physical_voices(&self) -> usize {
        self.graph.physical()
    }

    /// Physical slots with a voice playing.
    pub fn active_voices(&self) -> usize {
        self.graph.active_slots()
    }

    /// Hold `sound` for [`MixerOp::Start`]; kept across resets.
    pub fn add_sound(&mut self, sound: Sound) -> SoundId {
        self.sounds.push(sound);
        SoundId(u32::try_from(self.sounds.len() - 1).unwrap_or(u32::MAX))
    }

    /// Hold `music` for [`MixerOp::MusicStart`]; kept across resets.
    pub fn add_music(&mut self, music: Music) -> MusicId {
        self.music.push(music);
        MusicId(u32::try_from(self.music.len() - 1).unwrap_or(u32::MAX))
    }

    /// Start playing `sound` on the sfx bus on the next tick, outside the voice pool (what a game
    /// with no Director, and the existing verbs, use).
    pub fn play(&mut self, sound: &Sound) -> Result<StaticSoundHandle, AudioError> {
        self.graph.play_on_bus(Bus::Sfx, sound.data.clone())
    }

    /// Render the ops in order. An op naming a slot outside the pool, an unknown sound, or a
    /// non-finite value is dropped whole and counted ([`Mixer::dropped_ops`]); nothing panics.
    pub fn apply(&mut self, ops: &[MixerOp]) {
        for op in ops {
            if !self.apply_one(op) {
                self.dropped_ops += 1;
            }
        }
    }

    /// Ops dropped since the mixer was made.
    pub fn dropped_ops(&self) -> u64 {
        self.dropped_ops
    }

    fn apply_one(&mut self, op: &MixerOp) -> bool {
        match *op {
            MixerOp::Start { slot, bus, sound, start_frame, looped, gain_db, pan, pitch, cutoff_hz, send_db, fade_in_s } => {
                let finite = all_finite(&[pan, pitch, cutoff_hz, fade_in_s]) && start_frame.is_finite();
                let levels = !gain_db.is_nan() && !send_db.is_nan();
                let Some(sound) = self.sounds.get(sound.0 as usize).filter(|_| finite && levels) else { return false };
                let start = VoiceStart { bus, sound, start_frame, looped, gain_db, pan, pitch, cutoff_hz, send_db, fade_in_s };
                self.graph.start(slot, &start)
            }
            MixerOp::Stop { slot, fade_s } => self.graph.stop(slot, fade_s),
            MixerOp::Gain { slot, db, fade_s } => !db.is_nan() && self.graph.set_gain(slot, db, fade_s),
            MixerOp::Pan { slot, pan, fade_s } => pan.is_finite() && self.graph.set_pan(slot, pan, fade_s),
            MixerOp::Pitch { slot, rate, fade_s } => rate.is_finite() && self.graph.set_pitch(slot, rate, fade_s),
            MixerOp::Cutoff { slot, hz, fade_s } => hz.is_finite() && self.graph.set_cutoff(slot, hz, fade_s),
            MixerOp::Send { slot, db, fade_s } => !db.is_nan() && self.graph.set_send(slot, db, fade_s),
            MixerOp::BusVolume { bus, db, fade_s } => self.set_bus_sim(bus, db, fade_s),
            MixerOp::MasterVolume { db, fade_s } => self.set_master_sim(db, fade_s),
            MixerOp::Reverb { preset, fade_s } => {
                let finite = all_finite(&[preset.room, preset.damping]);
                if finite {
                    self.graph.set_reverb(preset, fade_s);
                }
                finite
            }
            MixerOp::MusicStart { track, music, opts } => {
                let finite = all_finite(&[opts.volume_db, opts.start_s, opts.loop_start_s]);
                let Some(music) = self.music.get(music.0 as usize).filter(|_| finite) else { return false };
                self.graph.music_start(track, music, &opts)
            }
            MixerOp::MusicVolume { track, db, fade_s } => {
                let known = !db.is_nan();
                if known {
                    self.graph.music_volume(track, db, fade_s);
                }
                known
            }
            MixerOp::MusicStop { track, fade_s } => {
                self.graph.music_stop(track, fade_s);
                true
            }
        }
    }

    fn set_bus_sim(&mut self, bus: Bus, db: f32, fade_s: f32) -> bool {
        if db.is_nan() {
            return false;
        }
        self.sim.bus_db[bus.index()] = db;
        self.graph.set_bus_volume(bus, bus_track_db(&self.sim, &self.person, bus), fade_s);
        true
    }

    fn set_master_sim(&mut self, db: f32, fade_s: f32) -> bool {
        if db.is_nan() {
            return false;
        }
        self.sim.master_db = db;
        self.graph.set_master_volume(master_track_db(&self.sim, &self.person), fade_s);
        true
    }

    /// Whether a music track still plays.
    pub fn music_playing(&self, track: MusicTrack) -> bool {
        self.graph.music_playing(track)
    }

    /// The person's volumes (the settings menu), outside the sim: kept across resets.
    pub fn set_settings(&mut self, settings: AudioSettings) {
        self.person = settings;
        self.push_layers();
    }

    /// Send every bus and the main track their layered gain, as a jump (kira still ramps it
    /// across the next block, the same way after a reset as on a fresh mixer).
    fn push_layers(&mut self) {
        for bus in Bus::ALL {
            self.graph.set_bus_volume(bus, bus_track_db(&self.sim, &self.person, bus), 0.0);
        }
        self.graph.set_master_volume(master_track_db(&self.sim, &self.person), 0.0);
    }

    /// The person's volumes.
    pub fn settings(&self) -> AudioSettings {
        self.person
    }

    /// Back to a fresh mixer for a seed: the graph is rebuilt (every voice, music track, reverb
    /// and filter tail goes), the sim layers return to 0 dB and the meter forgets. Sounds, music,
    /// the person's volumes and the mute stay, so this equals a fresh mixer with them, bit for bit.
    pub fn reset(&mut self) -> Result<(), AudioError> {
        self.sim = SimLayers::default();
        // Built at 0 dB and then sent the person layer, exactly as a fresh mixer that is handed
        // the person's settings, so the first block ramps the same way in both.
        self.graph = BusGraph::new(self.class)?;
        self.push_layers();
        self.meter = AudioMeter::default();
        self.block.fill(0.0);
        Ok(())
    }

    /// Render one tick ([`FRAMES_PER_TICK`] frames), feed the meter, and answer the block a device
    /// would play: interleaved stereo, silent while muted.
    pub fn tick(&mut self) -> &[f32] {
        self.graph.render(&mut self.block);
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

/// A bus track's gain: its sim layer plus its person layer.
fn bus_track_db(sim: &SimLayers, person: &AudioSettings, bus: Bus) -> f32 {
    sim.bus_db[bus.index()] + person_db(person.bus(bus))
}

/// The main track's gain: the sim master plus the person's master.
fn master_track_db(sim: &SimLayers, person: &AudioSettings) -> f32 {
    sim.master_db + person_db(person.master)
}
