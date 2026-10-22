//! The mixer's track graph inside one kira manager: five bus tracks under main, a reverb send
//! track, the two music tracks under the music bus and a pool of physical voice tracks. A voice
//! track lives under the bus its voice plays on, with a low-pass and a send to the reverb; it is
//! made when a slot first plays on that bus and kept while the slot stays there, so the pool never
//! renders more than the class's physical voices. Rebuilding the graph (a seed) drops every tail.

use crate::lowpass::{LowPassBuilder, LowPassHandle};
use crate::mixer::{AudioError, DevicelessBackend, Sound};
use crate::music::{Music, MusicPlayback};
use crate::ops::{MusicOpts, MusicTrack, PhysicalSlot, ReverbPreset};
use crate::vocab::{AudioErrorCode, Bus, PoolClass};
use kira::effect::reverb::{ReverbBuilder, ReverbHandle};
use kira::sound::PlaybackPosition;
use kira::sound::static_sound::{StaticSoundData, StaticSoundHandle};
use kira::track::{SendTrackBuilder, SendTrackHandle, TrackBuilder, TrackHandle};
use kira::{AudioManager, AudioManagerSettings, Capacities, Decibels, Mix, Tween};
use std::time::Duration;

/// kira updates clocks and modulators every this many frames (its default).
const INTERNAL_BUFFER_FRAMES: usize = 128;
/// The quietest gain a track is set to: kira renders exact silence at or below it.
pub(crate) const SILENCE_DB: f32 = -60.0;
/// The loudest gain a track is set to.
const LOUDEST_DB: f32 = 24.0;
/// The low-pass range a voice track accepts, in Hz.
const CUTOFF_MIN_HZ: f32 = 20.0;
const CUTOFF_MAX_HZ: f32 = 20_000.0;
/// Playback rates a voice accepts (Doppler's clamp).
const PITCH_MIN: f32 = 0.125;
const PITCH_MAX: f32 = 8.0;
/// The longest tween accepted, in seconds; longer ones are clamped.
const TWEEN_MAX_S: f32 = 600.0;
/// A stolen or replaced voice fades out over this long, in seconds.
pub(crate) const STEAL_FADE_S: f32 = 0.005;
/// Sounds a voice track holds: the new voice and the fade-outs of those it replaced this tick.
const VOICE_TRACK_SOUNDS: usize = 4;
/// Legacy plays (`Mixer::play`) a bus track holds at once.
const BUS_TRACK_SOUNDS: usize = 64;
/// The reverb starts as a small room until a zone sets it.
const REVERB_START: ReverbPreset = ReverbPreset::ROOM;

/// A tween over `fade_s` seconds; zero, negative and non-finite fades are a jump.
pub(crate) fn tween(fade_s: f32) -> Tween {
    let seconds = if fade_s.is_finite() { fade_s.clamp(0.0, TWEEN_MAX_S) } else { 0.0 };
    Tween { duration: Duration::from_secs_f32(seconds), ..Tween::default() }
}

/// A gain kira can tween without NaN: −∞ and anything under the floor become the floor.
pub(crate) fn clamp_db(db: f32) -> f32 {
    if db.is_nan() { SILENCE_DB } else { db.clamp(SILENCE_DB, LOUDEST_DB) }
}

/// A person volume (linear, 0..=1) in dB; 0 is the silence floor, 1 is exactly 0 dB.
pub(crate) fn person_db(volume: f32) -> f32 {
    if volume.is_nan() || volume <= 0.0 {
        return SILENCE_DB;
    }
    clamp_db(20.0 * libm::log10f(volume.min(1.0)))
}

/// Whether every value is finite (an op with NaN or ∞ is dropped whole).
pub(crate) fn all_finite(values: &[f32]) -> bool {
    values.iter().all(|value| value.is_finite())
}

/// One physical voice track and what plays on it.
struct VoiceTrack {
    bus: Bus,
    track: TrackHandle,
    filter: LowPassHandle,
    sound: Option<StaticSoundHandle>,
}

/// What a slot starts playing.
pub(crate) struct VoiceStart<'a> {
    pub(crate) bus: Bus,
    pub(crate) sound: &'a Sound,
    pub(crate) start_frame: f64,
    pub(crate) looped: bool,
    pub(crate) gain_db: f32,
    pub(crate) pan: f32,
    pub(crate) pitch: f32,
    pub(crate) cutoff_hz: f32,
    pub(crate) send_db: f32,
    pub(crate) fade_in_s: f32,
}

/// The kira manager and every track in it.
pub(crate) struct BusGraph {
    manager: AudioManager<DevicelessBackend>,
    buses: Vec<TrackHandle>,
    reverb: SendTrackHandle,
    reverb_fx: ReverbHandle,
    music: [TrackHandle; 2],
    music_playing: [Option<MusicPlayback>; 2],
    slots: Vec<Option<VoiceTrack>>,
}

impl BusGraph {
    /// A fresh graph with `class`'s pool of physical slots, every bus and main at 0 dB.
    pub(crate) fn new(class: PoolClass) -> Result<BusGraph, AudioError> {
        let physical = class.physical_voices();
        // Each bus can hold every slot plus the tracks of slots that just moved away and fade out.
        let per_bus_tracks = physical * 2 + MusicTrack::B.index() + 1;
        let settings = AudioManagerSettings::<DevicelessBackend> {
            capacities: Capacities { sub_track_capacity: Bus::ALL.len(), send_track_capacity: 1, ..Capacities::default() },
            internal_buffer_size: INTERNAL_BUFFER_FRAMES,
            ..AudioManagerSettings::default()
        };
        let mut manager = AudioManager::new(settings)?;
        let mut reverb_builder = SendTrackBuilder::new();
        let reverb_fx = reverb_builder.add_effect(
            ReverbBuilder::new()
                .feedback(f64::from(REVERB_START.room))
                .damping(f64::from(REVERB_START.damping))
                .mix(Mix::WET),
        );
        let reverb = manager.add_send_track(reverb_builder).map_err(refused)?;
        let mut buses = Vec::with_capacity(Bus::ALL.len());
        for _ in Bus::ALL {
            let builder = TrackBuilder::new().sub_track_capacity(per_bus_tracks).sound_capacity(BUS_TRACK_SOUNDS);
            buses.push(manager.add_sub_track(builder).map_err(refused)?);
        }
        let music_bus = &mut buses[Bus::Music.index()];
        let music = [music_bus.add_sub_track(TrackBuilder::new()).map_err(refused)?, music_bus.add_sub_track(TrackBuilder::new()).map_err(refused)?];
        let slots = (0..physical).map(|_| None).collect();
        Ok(BusGraph { manager, buses, reverb, reverb_fx, music, music_playing: [None, None], slots })
    }

    /// Render `out` (interleaved stereo) after applying what changed since the last block.
    pub(crate) fn render(&mut self, out: &mut [f32]) {
        self.manager.backend_mut().render(out);
    }

    /// Physical slots in the pool.
    pub(crate) fn physical(&self) -> usize {
        self.slots.len()
    }

    /// Slots with a voice playing.
    pub(crate) fn active_slots(&self) -> usize {
        self.slots.iter().flatten().filter(|voice| voice.sound.as_ref().is_some_and(is_playing)).count()
    }

    /// A legacy play straight onto a bus track.
    pub(crate) fn play_on_bus(&mut self, bus: Bus, data: StaticSoundData) -> Result<StaticSoundHandle, AudioError> {
        self.buses[bus.index()].play(data).map_err(refused)
    }

    /// Start `start` on `slot`, fading out what played there; false when the slot is outside the
    /// pool or kira has no room.
    pub(crate) fn start(&mut self, slot: PhysicalSlot, start: &VoiceStart<'_>) -> bool {
        let Some(index) = self.slot_index(slot) else { return false };
        let reverb = self.reverb.id();
        let voice = match self.voice_track(index, start.bus, start.send_db) {
            Ok(voice) => voice,
            Err(_) => return false,
        };
        if let Some(mut old) = voice.sound.take() {
            old.stop(tween(STEAL_FADE_S));
        }
        voice.filter.set_cutoff(f64::from(start.cutoff_hz.clamp(CUTOFF_MIN_HZ, CUTOFF_MAX_HZ)), tween(0.0));
        let _ = voice.track.set_send(reverb, clamp_db(start.send_db), tween(0.0));
        let data = voice_data(start);
        match voice.track.play(data) {
            Ok(handle) => {
                voice.sound = Some(handle);
                true
            }
            Err(_) => false,
        }
    }

    /// The voice track for `index` on `bus`, made (or moved) when the slot is on another bus.
    fn voice_track(&mut self, index: usize, bus: Bus, send_db: f32) -> Result<&mut VoiceTrack, AudioError> {
        let moved = self.slots[index].as_ref().is_none_or(|voice| voice.bus != bus);
        if moved {
            if let Some(mut old) = self.slots[index].take()
                && let Some(mut sound) = old.sound.take()
            {
                sound.stop(tween(STEAL_FADE_S));
            }
            let mut builder = TrackBuilder::new()
                .sound_capacity(VOICE_TRACK_SOUNDS)
                .persist_until_sounds_finish(true)
                .with_send(self.reverb.id(), clamp_db(send_db));
            let filter = builder.add_effect(LowPassBuilder::new(f64::from(CUTOFF_MAX_HZ)));
            let track = self.buses[bus.index()].add_sub_track(builder).map_err(refused)?;
            self.slots[index] = Some(VoiceTrack { bus, track, filter, sound: None });
        }
        self.slots[index].as_mut().ok_or_else(|| AudioError::new(AudioErrorCode::MixerFailed, "no voice track"))
    }

    /// Stop what plays on `slot`.
    pub(crate) fn stop(&mut self, slot: PhysicalSlot, fade_s: f32) -> bool {
        self.with_sound(slot, |sound| sound.stop(tween(fade_s)))
    }

    /// A slot's gain.
    pub(crate) fn set_gain(&mut self, slot: PhysicalSlot, db: f32, fade_s: f32) -> bool {
        self.with_sound(slot, |sound| sound.set_volume(clamp_db(db), tween(fade_s)))
    }

    /// A slot's pan.
    pub(crate) fn set_pan(&mut self, slot: PhysicalSlot, pan: f32, fade_s: f32) -> bool {
        self.with_sound(slot, |sound| sound.set_panning(pan.clamp(-1.0, 1.0), tween(fade_s)))
    }

    /// A slot's playback rate.
    pub(crate) fn set_pitch(&mut self, slot: PhysicalSlot, rate: f32, fade_s: f32) -> bool {
        self.with_sound(slot, |sound| sound.set_playback_rate(f64::from(rate.clamp(PITCH_MIN, PITCH_MAX)), tween(fade_s)))
    }

    /// A slot's low-pass cut-off.
    pub(crate) fn set_cutoff(&mut self, slot: PhysicalSlot, hz: f32, fade_s: f32) -> bool {
        let Some(voice) = self.slot_index(slot).and_then(|index| self.slots[index].as_mut()) else { return false };
        voice.filter.set_cutoff(f64::from(hz.clamp(CUTOFF_MIN_HZ, CUTOFF_MAX_HZ)), tween(fade_s));
        true
    }

    /// A slot's reverb send.
    pub(crate) fn set_send(&mut self, slot: PhysicalSlot, db: f32, fade_s: f32) -> bool {
        let reverb = self.reverb.id();
        let Some(voice) = self.slot_index(slot).and_then(|index| self.slots[index].as_mut()) else { return false };
        voice.track.set_send(reverb, clamp_db(db), tween(fade_s)).is_ok()
    }

    /// A bus track's volume (sim layer plus person layer, in dB).
    pub(crate) fn set_bus_volume(&mut self, bus: Bus, db: f32, fade_s: f32) {
        self.buses[bus.index()].set_volume(clamp_db(db), tween(fade_s));
    }

    /// The main track's volume (sim layer plus person master, in dB).
    pub(crate) fn set_master_volume(&mut self, db: f32, fade_s: f32) {
        self.manager.main_track().set_volume(clamp_db(db), tween(fade_s));
    }

    /// The shared reverb's character.
    pub(crate) fn set_reverb(&mut self, preset: ReverbPreset, fade_s: f32) {
        self.reverb_fx.set_feedback(f64::from(preset.room.clamp(0.0, 1.0)), tween(fade_s));
        self.reverb_fx.set_damping(f64::from(preset.damping.clamp(0.0, 1.0)), tween(fade_s));
    }

    /// Start `music` on `track`, replacing what played there.
    pub(crate) fn music_start(&mut self, track: MusicTrack, music: &Music, opts: &MusicOpts) -> bool {
        let index = track.index();
        if let Some(mut old) = self.music_playing[index].take() {
            old.stop(STEAL_FADE_S);
        }
        self.music[index].set_volume(Decibels::IDENTITY, tween(0.0));
        match music.play_on(&mut self.music[index], opts) {
            Ok(playback) => {
                self.music_playing[index] = Some(playback);
                true
            }
            Err(_) => false,
        }
    }

    /// A music track's volume.
    pub(crate) fn music_volume(&mut self, track: MusicTrack, db: f32, fade_s: f32) {
        self.music[track.index()].set_volume(clamp_db(db), tween(fade_s));
    }

    /// Stop a music track.
    pub(crate) fn music_stop(&mut self, track: MusicTrack, fade_s: f32) {
        if let Some(playback) = self.music_playing[track.index()].as_mut() {
            playback.stop(fade_s);
        }
    }

    /// Whether a music track still plays.
    pub(crate) fn music_playing(&self, track: MusicTrack) -> bool {
        self.music_playing[track.index()].as_ref().is_some_and(MusicPlayback::is_playing)
    }

    fn slot_index(&self, slot: PhysicalSlot) -> Option<usize> {
        let index = usize::from(slot.0);
        (index < self.slots.len()).then_some(index)
    }

    fn with_sound(&mut self, slot: PhysicalSlot, change: impl FnOnce(&mut StaticSoundHandle)) -> bool {
        let Some(voice) = self.slot_index(slot).and_then(|index| self.slots[index].as_mut()) else { return false };
        match voice.sound.as_mut() {
            Some(sound) => {
                change(sound);
                true
            }
            None => false,
        }
    }
}

fn is_playing(sound: &StaticSoundHandle) -> bool {
    sound.state() != kira::sound::PlaybackState::Stopped
}

fn refused(error: impl std::fmt::Display) -> AudioError {
    AudioError::new(AudioErrorCode::MixerFailed, error.to_string())
}

/// The sound data a slot plays: its logical offset, loop, gain, pan, rate and fade-in.
fn voice_data(start: &VoiceStart<'_>) -> StaticSoundData {
    let rate = f64::from(start.sound.sample_rate().max(1));
    let offset = if start.start_frame.is_finite() { start.start_frame.max(0.0) / rate } else { 0.0 };
    let mut data = start
        .sound
        .data()
        .clone()
        .start_position(PlaybackPosition::Seconds(offset))
        .volume(clamp_db(start.gain_db))
        .panning(start.pan.clamp(-1.0, 1.0))
        .playback_rate(f64::from(start.pitch.clamp(PITCH_MIN, PITCH_MAX)));
    if start.looped {
        data = data.loop_region(0.0..);
    }
    if start.fade_in_s > 0.0 {
        data = data.fade_in_tween(Some(tween(start.fade_in_s)));
    }
    data
}
