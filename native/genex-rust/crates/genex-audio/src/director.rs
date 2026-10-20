//! The logical Director: commands in, logical voices and [`MixerOp`]s out. It decides which voices
//! exist, stealing, virtualization, ducking, music slots, spatial gains and events, on integer
//! ticks, basic float operations and libm, so its logical state is bit-equal on every destination
//! and device class.
//!
//! A step runs in a fixed order: the commands in call order, then the listener and its reverb
//! zone, the occlusion rays, every voice's spatial parameters, the ducks and bus layers, the
//! physical pool (which voices are real), and last the clocks (voice and music positions, ends).
//! The pool only picks which logical voices render: the logical state is the same at every pool
//! size, and [`Director::logical_hash`] leaves the slots and the virtualize/realize events out.

use crate::AudioError;
use crate::events::{AudioCounts, AudioEvent, EventLog};
use crate::occlusion::{OCCLUDED_CUTOFF_FLOOR_HZ, OCCLUSION_TWEEN_S, Occluder, OcclusionScheduler};
use crate::ops::{
    AudioCommand, AudioSetup, Listener, LogicalVoice, MixerOp, MusicId, MusicOpts, MusicTrack, PhysicalSlot, PlayOpts,
    ReverbZone, SoundId, Spatial, Voice, ZoneId, ZoneShape,
};
use crate::spatial::{
    CUTOFF_OPEN_HZ, DOPPLER_RATE_MAX, DOPPLER_RATE_MIN, attenuation_db, distance_cutoff_hz, doppler_rate, gain_to_db, pan,
};
use crate::vocab::{
    Attenuation, AudioErrorCode, AudioEventCode, Bus, LOGICAL_VOICES_MAX, PoolClass, REVERB_ZONES_MAX,
};
use crate::voices::{SoundInfo, instance_victim, rank_for_pool, steal_victim};
use crate::zones::{SEND_OFF_DB, active_zone, send_db};
use genex_core::json::Value;
use glam::Vec3;

/// Ticks per second of the simulated clock.
const TICK_HZ: f32 = 60.0;
/// One tick, in seconds: the tween every per-tick parameter change rides on.
const TICK_S: f32 = 1.0 / TICK_HZ;
/// The fade a stolen voice gets.
const STEAL_FADE_S: f32 = 0.005;
/// The fade a voice that loses its track gets.
const VIRTUALIZE_FADE_S: f32 = 0.01;
/// The fade-in a voice that gets a track back starts with.
const REALIZE_FADE_S: f32 = 0.01;
/// Seconds the shared reverb takes to move to a new zone's preset.
const REVERB_FADE_S: f32 = 0.5;
/// The longest fade a command can ask for, in ticks (an hour).
const FADE_TICKS_MAX: f32 = 216_000.0;
/// The save section's layout version.
const SNAPSHOT_VERSION: f64 = 1.0;
/// Distinct zone names a Director remembers for restoring sections (each at most
/// [`ZONE_NAME_BYTES_MAX`]); a section naming more restores them unnamed.
const ZONE_NAMES_MAX: usize = 64;
/// The longest zone name a restored section may introduce.
const ZONE_NAME_BYTES_MAX: usize = 64;
/// The ears when neither the game's camera nor an override places them.
const DEFAULT_EARS: Listener = Listener { position: Vec3::ZERO, forward: Vec3::NEG_Z, up: Vec3::Y };

/// What a step reads from the world besides the commands.
#[derive(Default)]
pub struct StepInput<'a> {
    /// The game's own camera as ears (an override from `ctx.audio.listener` wins).
    pub camera: Option<Listener>,
    /// The physics occluder, when the game has physics and occlusion is on.
    pub occluder: Option<&'a mut dyn Occluder>,
}

/// A value moving linearly from `from` to `to` over `ticks` ticks.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Ramp {
    from: f32,
    to: f32,
    ticks: u32,
    done: u32,
}

impl Ramp {
    /// A ramp resting at `value`.
    const fn at(value: f32) -> Ramp {
        Ramp { from: value, to: value, ticks: 0, done: 0 }
    }

    /// From where this ramp is now to `to` over `fade_s`.
    fn toward(self, to: f32, fade_s: f32) -> Ramp {
        Ramp { from: self.value(), to, ticks: fade_ticks(fade_s), done: 0 }
    }

    fn value(&self) -> f32 {
        if self.done >= self.ticks {
            return self.to;
        }
        self.from + (self.to - self.from) * (self.done as f32 / self.ticks as f32)
    }

    fn advance(&mut self) {
        if self.done < self.ticks {
            self.done += 1;
        }
    }

    fn settled(&self) -> bool {
        self.done >= self.ticks
    }
}

/// Whole ticks in `fade_s` (negative is 0, capped at an hour).
fn fade_ticks(fade_s: f32) -> u32 {
    (fade_s * TICK_HZ).round().clamp(0.0, FADE_TICKS_MAX) as u32
}

/// What a slot was last sent, so a step sends only what changed.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Sent {
    gain_db: f32,
    pan: f32,
    pitch: f32,
    cutoff_hz: f32,
    send_db: f32,
}

/// One logical voice and what the Director keeps beside it.
#[derive(Clone, Copy, Debug, PartialEq)]
struct VoiceState {
    logical: LogicalVoice,
    /// The game's own gain, in dB.
    volume: Ramp,
    /// The game's own playback rate.
    rate: Ramp,
    /// The game's pan for a voice with no position.
    base_pan: f32,
    fade_in_s: f32,
    /// Where it was last tick, for Doppler (a teleport sets it to the new position).
    prev_at: Option<Vec3>,
    /// The Doppler factor in its pitch.
    doppler: f32,
    /// The occluder's last answer, 0..=1.
    transmission: f32,
    /// The transmission heard, tweened toward `transmission`.
    clarity: f32,
    /// Played this tick.
    fresh: bool,
    /// Render side: what its slot was last sent (never hashed or saved).
    sent: Option<Sent>,
}

/// One of the two music tracks.
#[derive(Clone, Copy, Debug, PartialEq)]
struct MusicSlot {
    music: MusicId,
    opts: MusicOpts,
    position_frames: f64,
    frames: u64,
    rate_hz: u32,
    volume: Ramp,
    stopping: bool,
}

impl MusicSlot {
    /// Where a loop wraps and restarts, in frames; `None` when the region is empty.
    fn loop_region(&self) -> Option<(f64, f64)> {
        let rate = f64::from(self.rate_hz);
        let end = self.opts.loop_end_s.map_or(self.frames as f64, |s| f64::from(s) * rate).min(self.frames as f64);
        let start = f64::from(self.opts.loop_start_s).max(0.0) * rate;
        (end > start).then_some((start, end))
    }
}

/// The logical audio state of a game, reset on seed.
pub struct Director {
    class: PoolClass,
    setup: AudioSetup,
    tick: u64,
    next_voice: u32,
    next_zone: u32,
    voices: Vec<VoiceState>,
    view: Vec<LogicalVoice>,
    sounds: Vec<(SoundId, SoundInfo)>,
    musics: Vec<(MusicId, SoundInfo)>,
    ops: Vec<MixerOp>,
    events: EventLog,
    /// FNV-1a over this tick's events that are not about the pool.
    event_hash: u64,
    bus: [Ramp; Bus::ALL.len()],
    /// Render side: the bus gains last sent.
    sent_bus: [f32; Bus::ALL.len()],
    master_db: f32,
    ducks: Vec<f32>,
    music: [Option<MusicSlot>; 2],
    current_music: Option<MusicTrack>,
    listener_override: Option<Listener>,
    ears: Listener,
    prev_ears: Option<Vec3>,
    ears_jumped: bool,
    zones: Vec<(ZoneId, ReverbZone)>,
    zone_names: Vec<&'static str>,
    active_zone: Option<ZoneId>,
    occlusion: OcclusionScheduler,
    /// Render side: a restore happened, so the next step re-sends the mixer's state.
    resync: bool,
}

impl Director {
    /// A Director rendering through `class`'s physical pool, with the game's `setup`.
    pub fn new(class: PoolClass, setup: AudioSetup) -> Director {
        let zone_names = setup.zones.iter().map(|zone| zone.name).collect();
        let mut director = Director {
            class,
            setup,
            tick: 0,
            next_voice: 1,
            next_zone: 1,
            voices: Vec::new(),
            view: Vec::new(),
            sounds: Vec::new(),
            musics: Vec::new(),
            ops: Vec::new(),
            events: EventLog::default(),
            event_hash: FNV_OFFSET,
            bus: [Ramp::at(0.0); Bus::ALL.len()],
            sent_bus: [0.0; Bus::ALL.len()],
            master_db: 0.0,
            ducks: Vec::new(),
            music: [None, None],
            current_music: None,
            listener_override: None,
            ears: DEFAULT_EARS,
            prev_ears: None,
            ears_jumped: false,
            zones: Vec::new(),
            zone_names,
            active_zone: None,
            occlusion: OcclusionScheduler::default(),
            resync: false,
        };
        director.reset();
        director
    }

    /// The pool class.
    pub fn class(&self) -> PoolClass {
        self.class
    }

    /// The game's setup.
    pub fn setup(&self) -> &AudioSetup {
        &self.setup
    }

    /// Tell the Director a sound's length (kept across seeds).
    pub fn register_sound(&mut self, sound: SoundId, info: SoundInfo) {
        self.sounds.retain(|(id, _)| *id != sound);
        self.sounds.push((sound, info));
    }

    /// Tell the Director a music file's length and rate (kept across seeds).
    pub fn register_music(&mut self, music: MusicId, info: SoundInfo) {
        self.musics.retain(|(id, _)| *id != music);
        self.musics.push((music, info));
    }

    /// Back to a fresh seed: no voices or music, ids from 1, sim layers at 0 dB, the setup's zones.
    pub fn reset(&mut self) {
        self.tick = 0;
        self.next_voice = 1;
        self.voices.clear();
        self.view.clear();
        self.ops.clear();
        self.events = EventLog::default();
        self.event_hash = FNV_OFFSET;
        self.bus = [Ramp::at(0.0); Bus::ALL.len()];
        self.sent_bus = [0.0; Bus::ALL.len()];
        self.master_db = 0.0;
        self.ducks = vec![0.0; self.setup.ducks.len()];
        self.music = [None, None];
        self.current_music = None;
        self.listener_override = None;
        self.ears = DEFAULT_EARS;
        self.prev_ears = None;
        self.ears_jumped = false;
        self.zones = self.setup.zones.iter().take(REVERB_ZONES_MAX).zip(1..).map(|(zone, id)| (ZoneId::from_id(id), *zone)).collect();
        self.next_zone = u32::try_from(self.zones.len()).unwrap_or(0) + 1;
        self.active_zone = None;
        self.occlusion.reset();
        self.resync = false;
    }

    /// The id the next play takes (from 1 after every seed); the command queue asks for it when
    /// a hook plays.
    pub fn issue_voice(&mut self) -> Voice {
        let voice = Voice::from_id(self.next_voice);
        self.next_voice = self.next_voice.saturating_add(1);
        voice
    }

    /// The id the next added zone takes (after the setup's zones).
    pub fn issue_zone(&mut self) -> ZoneId {
        let zone = ZoneId::from_id(self.next_zone);
        self.next_zone = self.next_zone.saturating_add(1);
        zone
    }

    /// Apply this tick's `commands` in order and advance one tick; answers the ops to render.
    pub fn step(&mut self, commands: &[AudioCommand], input: StepInput<'_>) -> &[MixerOp] {
        self.events.begin_tick();
        self.event_hash = FNV_OFFSET;
        self.ops.clear();
        if std::mem::take(&mut self.resync) {
            self.resend_state();
        }
        for command in commands {
            self.apply(command);
        }
        self.resolve_ears(input.camera);
        self.update_zone();
        if let Some(occluder) = input.occluder.filter(|_| self.setup.occlusion) {
            self.cast_occlusion(occluder);
        }
        self.update_voices();
        self.update_buses();
        self.assign_slots();
        self.advance_voices();
        self.advance_music();
        self.tick += 1;
        self.view = self.voices.iter().map(|state| state.logical).collect();
        &self.ops
    }

    /// The logical voices, sorted by id.
    pub fn voices(&self) -> &[LogicalVoice] {
        &self.view
    }

    /// This tick's events and the totals.
    pub fn events(&self) -> &EventLog {
        &self.events
    }

    /// Whether `voice` is still playing (logical).
    pub fn playing(&self, voice: Voice) -> bool {
        self.voices.iter().any(|v| v.logical.voice == voice)
    }

    /// Seconds into `voice`, or `None` once it ended.
    pub fn position_s(&self, voice: Voice) -> Option<f64> {
        self.voices.iter().find(|v| v.logical.voice == voice).map(|v| v.logical.position_s())
    }

    /// Ticks since the seed.
    pub fn tick(&self) -> u64 {
        self.tick
    }

    /// The track the current music plays on (a track fading out is not current).
    pub fn music_track(&self) -> Option<MusicTrack> {
        self.current_music
    }

    /// The music on `track`, playing or fading out.
    pub fn music_id(&self, track: MusicTrack) -> Option<MusicId> {
        self.music[track.index()].map(|slot| slot.music)
    }

    /// A music track's logical gain in dB, or `None` when nothing plays on it.
    pub fn music_volume_db(&self, track: MusicTrack) -> Option<f32> {
        self.music[track.index()].map(|slot| slot.volume.value())
    }

    /// Seconds into the music on `track`, or `None` when nothing plays on it.
    pub fn music_position_s(&self, track: MusicTrack) -> Option<f64> {
        self.music[track.index()].map(|slot| slot.position_frames / f64::from(slot.rate_hz.max(1)))
    }

    /// A bus's sim layer with its ducks, in dB.
    pub fn bus_db(&self, bus: Bus) -> f32 {
        self.bus_gain(bus)
    }

    /// The main track's sim layer, in dB.
    pub fn master_db(&self) -> f32 {
        self.master_db
    }

    /// The ears this tick, and whether they are the game's camera (no override).
    pub fn listener(&self) -> (Listener, bool) {
        (self.ears, self.listener_override.is_none())
    }

    /// The reverb zones, in registration order.
    pub fn zones(&self) -> &[(ZoneId, ReverbZone)] {
        &self.zones
    }

    /// The zone holding the listener.
    pub fn zone(&self) -> Option<&(ZoneId, ReverbZone)> {
        self.active_zone.and_then(|id| self.zones.iter().find(|(zone, _)| *zone == id))
    }

    fn apply(&mut self, command: &AudioCommand) {
        match *command {
            AudioCommand::Play { voice, sound, opts } => self.play(voice, sound, &opts),
            AudioCommand::Stop { voice, fade_s } => self.stop(voice, fade_s),
            AudioCommand::StopBus { bus, fade_s } => self.stop_bus(bus, fade_s),
            AudioCommand::SetPosition { voice, position } => self.move_voice(voice, position, false),
            AudioCommand::Teleport { voice, position } => self.move_voice(voice, position, true),
            AudioCommand::SetVolume { voice, db, fade_s } => self.set_volume(voice, db, fade_s),
            AudioCommand::SetPitch { voice, rate, fade_s } => self.set_pitch(voice, rate, fade_s),
            AudioCommand::BusVolume { bus, db, fade_s } => self.set_bus(bus, db, fade_s),
            AudioCommand::MasterVolume { db, fade_s } => self.set_master(db, fade_s),
            AudioCommand::Music { music, opts } => self.start_music(music, &opts),
            AudioCommand::StopMusic { fade_s } => self.stop_music(fade_s),
            AudioCommand::Listener(listener) => self.set_listener(listener),
            AudioCommand::AddZone { zone, def } => self.add_zone(zone, &def),
            AudioCommand::RemoveZone(zone) => self.zones.retain(|(id, _)| *id != zone),
        }
    }

    fn emit(&mut self, event: AudioEvent) {
        let pool_event = matches!(event.code, AudioEventCode::Virtualized | AudioEventCode::Realized);
        if !pool_event {
            self.event_hash = hash_event(self.event_hash, &event);
        }
        self.events.push(event);
    }

    fn refuse(&mut self, voice: Voice, sound: Option<SoundId>, reason: AudioErrorCode) {
        self.emit(AudioEvent::at(self.tick, AudioEventCode::Refused).of(voice, sound).because(reason));
    }

    fn index_of(&self, voice: Voice) -> Option<usize> {
        self.voices.binary_search_by(|state| state.logical.voice.cmp(&voice)).ok()
    }

    fn logical_views(&self) -> Vec<LogicalVoice> {
        self.voices.iter().map(|state| state.logical).collect()
    }

    fn play(&mut self, voice: Voice, sound: SoundId, opts: &PlayOpts) {
        let voice = if voice == Voice::NONE { self.issue_voice() } else { voice };
        if !play_is_finite(opts) || self.index_of(voice).is_some() {
            return self.refuse(voice, Some(sound), AudioErrorCode::InvalidValue);
        }
        self.next_voice = self.next_voice.max(voice.id().saturating_add(1));
        let Some(info) = self.sounds.iter().find(|(id, _)| *id == sound).map(|(_, info)| *info) else {
            return self.refuse(voice, Some(sound), AudioErrorCode::SoundMissing);
        };
        if let Err(reason) = self.make_room(voice, sound, opts) {
            return self.refuse(voice, Some(sound), reason);
        }
        let state = new_voice(self.tick, voice, sound, info, opts);
        let at = self.voices.partition_point(|other| other.logical.voice < voice);
        self.voices.insert(at, state);
        self.emit(AudioEvent::at(self.tick, AudioEventCode::Played).of(voice, Some(sound)));
    }

    /// Steal what a play of `sound` needs: the oldest instance at its cap, then a voice at the
    /// logical cap.
    fn make_room(&mut self, thief: Voice, sound: SoundId, opts: &PlayOpts) -> Result<(), AudioErrorCode> {
        let views = self.logical_views();
        let instances = views.iter().filter(|v| v.sound == sound).count();
        if opts.max_instances > 0 && instances >= usize::from(opts.max_instances) {
            let eligible: Vec<LogicalVoice> = views.iter().filter(|v| v.sound == sound && v.priority <= opts.priority).copied().collect();
            let victim = instance_victim(&eligible, sound, 1).ok_or(AudioErrorCode::InstanceLimit)?;
            self.steal(victim, thief);
        }
        if self.voices.len() >= LOGICAL_VOICES_MAX {
            let victim = steal_victim(&self.logical_views(), opts.priority).ok_or(AudioErrorCode::SoundLimit)?;
            self.steal(victim, thief);
        }
        Ok(())
    }

    fn steal(&mut self, victim: Voice, thief: Voice) {
        let Some(state) = self.remove_voice(victim, STEAL_FADE_S) else { return };
        let event = AudioEvent::at(self.tick, AudioEventCode::Stolen).of(victim, Some(state.logical.sound)).by(thief);
        self.emit(event);
    }

    /// Take `voice` out, stopping its track over `fade_s`.
    fn remove_voice(&mut self, voice: Voice, fade_s: f32) -> Option<VoiceState> {
        let state = self.voices.remove(self.index_of(voice)?);
        if let Some(slot) = state.logical.slot {
            self.ops.push(MixerOp::Stop { slot, fade_s });
        }
        Some(state)
    }

    fn stop(&mut self, voice: Voice, fade_s: f32) {
        if !fade_s.is_finite() {
            return self.refuse(voice, None, AudioErrorCode::InvalidValue);
        }
        if let Some(state) = self.remove_voice(voice, fade_s.max(0.0)) {
            self.emit(AudioEvent::at(self.tick, AudioEventCode::Stopped).of(voice, Some(state.logical.sound)));
        }
    }

    fn stop_bus(&mut self, bus: Bus, fade_s: f32) {
        if !fade_s.is_finite() {
            return self.refuse(Voice::NONE, None, AudioErrorCode::InvalidValue);
        }
        let on_bus: Vec<Voice> = self.voices.iter().filter(|v| v.logical.bus == bus).map(|v| v.logical.voice).collect();
        for voice in on_bus {
            self.stop(voice, fade_s);
        }
    }

    fn move_voice(&mut self, voice: Voice, position: Vec3, teleport: bool) {
        if !position.is_finite() {
            return self.refuse(voice, None, AudioErrorCode::InvalidValue);
        }
        let Some(index) = self.index_of(voice) else { return };
        let state = &mut self.voices[index];
        state.logical.at = Some(position);
        if teleport || state.prev_at.is_none() {
            state.prev_at = Some(position);
        }
    }

    fn set_volume(&mut self, voice: Voice, db: f32, fade_s: f32) {
        if !(db.is_finite() && fade_s.is_finite()) {
            return self.refuse(voice, None, AudioErrorCode::InvalidValue);
        }
        if let Some(index) = self.index_of(voice) {
            let state = &mut self.voices[index];
            state.volume = state.volume.toward(db, fade_s);
        }
    }

    fn set_pitch(&mut self, voice: Voice, rate: f32, fade_s: f32) {
        let valid = rate.is_finite() && rate > 0.0 && fade_s.is_finite();
        if !valid {
            return self.refuse(voice, None, AudioErrorCode::InvalidValue);
        }
        if let Some(index) = self.index_of(voice) {
            let state = &mut self.voices[index];
            state.rate = state.rate.toward(rate.clamp(DOPPLER_RATE_MIN, DOPPLER_RATE_MAX), fade_s);
        }
    }

    fn set_bus(&mut self, bus: Bus, db: f32, fade_s: f32) {
        if !(db.is_finite() && fade_s.is_finite()) {
            return self.refuse(Voice::NONE, None, AudioErrorCode::InvalidValue);
        }
        let ramp = &mut self.bus[bus.index()];
        *ramp = ramp.toward(db, fade_s);
    }

    fn set_master(&mut self, db: f32, fade_s: f32) {
        if !(db.is_finite() && fade_s.is_finite()) {
            return self.refuse(Voice::NONE, None, AudioErrorCode::InvalidValue);
        }
        self.master_db = db;
        self.ops.push(MixerOp::MasterVolume { db, fade_s: fade_s.max(0.0) });
    }

    fn set_listener(&mut self, listener: Option<Listener>) {
        if listener.is_some_and(|ears| !listener_is_finite(&ears)) {
            return self.refuse(Voice::NONE, None, AudioErrorCode::InvalidValue);
        }
        self.listener_override = listener;
        self.ears_jumped = true;
    }

    fn add_zone(&mut self, zone: ZoneId, def: &ReverbZone) {
        let valid = zone_is_finite(def) && zone != ZoneId::from_id(0) && self.zones.iter().all(|(id, _)| *id != zone);
        if !valid {
            return self.refuse(Voice::NONE, None, AudioErrorCode::InvalidValue);
        }
        if self.zones.len() >= REVERB_ZONES_MAX {
            return self.refuse(Voice::NONE, None, AudioErrorCode::ZoneLimit);
        }
        self.next_zone = self.next_zone.max(zone.id().saturating_add(1));
        self.remember_zone_name(def.name);
        self.zones.push((zone, *def));
    }

    fn remember_zone_name(&mut self, name: &'static str) {
        let known = self.zone_names.contains(&name);
        if !known && self.zone_names.len() < ZONE_NAMES_MAX {
            self.zone_names.push(name);
        }
    }

    fn start_music(&mut self, music: MusicId, opts: &MusicOpts) {
        let refused = AudioEvent::at(self.tick, AudioEventCode::Refused).music(music);
        if !music_is_finite(opts) {
            return self.emit(refused.because(AudioErrorCode::InvalidValue));
        }
        let Some(info) = self.musics.iter().find(|(id, _)| *id == music).map(|(_, info)| *info) else {
            return self.emit(refused.because(AudioErrorCode::SoundMissing));
        };
        let fade_s = opts.fade_s.max(0.0);
        let track = self.current_music.map_or(MusicTrack::A, MusicTrack::other);
        if let Some(playing) = self.current_music {
            self.fade_out_music(playing, fade_s);
        }
        let volume = if fade_ticks(fade_s) == 0 { Ramp::at(opts.volume_db) } else { Ramp::at(SEND_OFF_DB).toward(opts.volume_db, fade_s) };
        let position_frames = f64::from(opts.start_s.max(0.0)) * f64::from(info.rate_hz);
        let slot = MusicSlot { music, opts: *opts, position_frames, frames: info.frames, rate_hz: info.rate_hz, volume, stopping: false };
        self.music[track.index()] = Some(slot);
        self.current_music = Some(track);
        self.ops.push(MixerOp::MusicStart { track, music, opts: *opts });
        self.emit(AudioEvent::at(self.tick, AudioEventCode::MusicStarted).music(music));
    }

    fn fade_out_music(&mut self, track: MusicTrack, fade_s: f32) {
        let Some(slot) = self.music[track.index()].as_mut() else { return };
        slot.stopping = true;
        slot.volume = slot.volume.toward(SEND_OFF_DB, fade_s);
        let gone = slot.volume.settled();
        self.ops.push(MixerOp::MusicStop { track, fade_s });
        if gone {
            self.music[track.index()] = None;
        }
    }

    fn stop_music(&mut self, fade_s: f32) {
        if !fade_s.is_finite() {
            return self.refuse(Voice::NONE, None, AudioErrorCode::InvalidValue);
        }
        if let Some(track) = self.current_music.take() {
            self.fade_out_music(track, fade_s.max(0.0));
        }
    }

    /// The ears this tick: the override, else the game's camera, else the origin.
    fn resolve_ears(&mut self, camera: Option<Listener>) {
        let camera = camera.filter(listener_is_finite);
        self.ears = self.listener_override.or(camera).unwrap_or(DEFAULT_EARS);
    }

    fn ears_velocity(&self) -> Vec3 {
        match self.prev_ears {
            Some(prev) if !self.ears_jumped => (self.ears.position - prev) * TICK_HZ,
            _ => Vec3::ZERO,
        }
    }

    fn update_zone(&mut self) {
        let index = active_zone(&self.zones, self.ears.position);
        let id = index.map(|i| self.zones[i].0);
        if id == self.active_zone {
            return;
        }
        self.active_zone = id;
        if let Some(i) = index {
            self.ops.push(MixerOp::Reverb { preset: self.zones[i].1.preset, fade_s: REVERB_FADE_S });
        }
    }

    fn cast_occlusion(&mut self, occluder: &mut dyn Occluder) {
        let audible: Vec<Voice> = self.voices.iter().filter(|v| occludable(&v.logical)).map(|v| v.logical.voice).collect();
        for voice in self.occlusion.pick(&audible) {
            let Some(index) = self.index_of(voice) else { continue };
            let Some(at) = self.voices[index].logical.at else { continue };
            let answer = occluder.transmission(self.ears.position, at);
            self.voices[index].transmission = if answer.is_nan() { 1.0 } else { answer.clamp(0.0, 1.0) };
        }
    }

    fn update_voices(&mut self) {
        let ears = self.ears;
        let ears_velocity = self.ears_velocity();
        let zone = self.zone().map(|(_, zone)| *zone);
        let occlusion_on = self.setup.occlusion;
        for state in &mut self.voices {
            update_voice(state, &ears, ears_velocity, zone.as_ref(), occlusion_on);
        }
        self.prev_ears = Some(ears.position);
        self.ears_jumped = false;
    }

    fn trigger_active(&self, bus: Bus) -> bool {
        let music_plays = bus == Bus::Music && self.current_music.is_some();
        music_plays || self.voices.iter().any(|v| v.logical.bus == bus)
    }

    fn bus_gain(&self, bus: Bus) -> f32 {
        let ducked: f32 = self.setup.ducks.iter().zip(&self.ducks).filter(|(duck, _)| duck.target == bus).map(|(_, db)| *db).sum();
        self.bus[bus.index()].value() + ducked
    }

    fn update_buses(&mut self) {
        let active: Vec<bool> = self.setup.ducks.iter().map(|duck| self.trigger_active(duck.trigger)).collect();
        for ((level, duck), active) in self.ducks.iter_mut().zip(&self.setup.ducks).zip(active) {
            let seconds = if active { duck.attack_s } else { duck.release_s };
            *level = duck_step(*level, duck.depth_db, seconds, active);
        }
        for bus in Bus::ALL {
            self.bus[bus.index()].advance();
            let db = self.bus_gain(bus);
            if db.to_bits() != self.sent_bus[bus.index()].to_bits() {
                self.sent_bus[bus.index()] = db;
                self.ops.push(MixerOp::BusVolume { bus, db, fade_s: TICK_S });
            }
        }
    }

    /// Give the top of the pool order a track each, stopping the voices that fall out of it.
    fn assign_slots(&mut self) {
        let physical = self.class.physical_voices();
        let order = rank_for_pool(&self.logical_views());
        let mut real = vec![false; self.voices.len()];
        for &index in order.iter().take(physical) {
            real[index] = true;
        }
        for index in (0..self.voices.len()).filter(|&index| !real[index]) {
            self.make_virtual(index);
        }
        let mut taken = vec![false; physical];
        for slot in self.voices.iter().filter_map(|v| v.logical.slot) {
            if let Some(used) = taken.get_mut(usize::from(slot.0)) {
                *used = true;
            }
        }
        for &index in order.iter().take(physical) {
            if self.voices[index].logical.slot.is_some() {
                self.send_changes(index);
                continue;
            }
            let Some(free) = taken.iter().position(|used| !used) else { continue };
            taken[free] = true;
            self.make_real(index, PhysicalSlot(u16::try_from(free).unwrap_or(u16::MAX)));
        }
        for state in &mut self.voices {
            state.fresh = false;
        }
    }

    fn make_virtual(&mut self, index: usize) {
        let state = &mut self.voices[index];
        state.sent = None;
        let logical = state.logical;
        let lost = state.logical.slot.take();
        if let Some(slot) = lost {
            self.ops.push(MixerOp::Stop { slot, fade_s: VIRTUALIZE_FADE_S });
        }
        if lost.is_some() || state.fresh {
            self.emit(AudioEvent::at(self.tick, AudioEventCode::Virtualized).of(logical.voice, Some(logical.sound)));
        }
    }

    fn make_real(&mut self, index: usize, slot: PhysicalSlot) {
        let state = &mut self.voices[index];
        state.logical.slot = Some(slot);
        let v = state.logical;
        let fade_in_s = if state.fresh { state.fade_in_s } else { REALIZE_FADE_S };
        state.sent = Some(Sent { gain_db: v.gain_db, pan: v.pan, pitch: v.pitch, cutoff_hz: v.cutoff_hz, send_db: v.send_db });
        let fresh = state.fresh;
        self.ops.push(MixerOp::Start {
            slot,
            bus: v.bus,
            sound: v.sound,
            start_frame: v.position_frames,
            looped: v.looped,
            gain_db: v.gain_db,
            pan: v.pan,
            pitch: v.pitch,
            cutoff_hz: v.cutoff_hz,
            send_db: v.send_db,
            fade_in_s,
        });
        if !fresh {
            self.emit(AudioEvent::at(self.tick, AudioEventCode::Realized).of(v.voice, Some(v.sound)));
        }
    }

    /// Send a real voice's parameters that changed since its slot last heard them.
    fn send_changes(&mut self, index: usize) {
        let state = &mut self.voices[index];
        let (Some(slot), Some(sent)) = (state.logical.slot, state.sent) else { return };
        let v = state.logical;
        let now = Sent { gain_db: v.gain_db, pan: v.pan, pitch: v.pitch, cutoff_hz: v.cutoff_hz, send_db: v.send_db };
        state.sent = Some(now);
        let changed = |a: f32, b: f32| a.to_bits() != b.to_bits();
        if changed(now.gain_db, sent.gain_db) {
            self.ops.push(MixerOp::Gain { slot, db: now.gain_db, fade_s: TICK_S });
        }
        if changed(now.pan, sent.pan) {
            self.ops.push(MixerOp::Pan { slot, pan: now.pan, fade_s: TICK_S });
        }
        if changed(now.pitch, sent.pitch) {
            self.ops.push(MixerOp::Pitch { slot, rate: now.pitch, fade_s: TICK_S });
        }
        if changed(now.cutoff_hz, sent.cutoff_hz) {
            self.ops.push(MixerOp::Cutoff { slot, hz: now.cutoff_hz, fade_s: TICK_S });
        }
        if changed(now.send_db, sent.send_db) {
            self.ops.push(MixerOp::Send { slot, db: now.send_db, fade_s: TICK_S });
        }
    }

    /// Move every voice's clock one tick; one-shots past their last frame end.
    fn advance_voices(&mut self) {
        let mut ended = Vec::new();
        for state in &mut self.voices {
            let v = &mut state.logical;
            v.position_frames += f64::from(v.pitch) * f64::from(v.rate_hz) / f64::from(TICK_HZ);
            let frames = v.frames as f64;
            if v.position_frames < frames {
                continue;
            }
            if v.looped && v.frames > 0 {
                v.position_frames %= frames;
            } else {
                ended.push((v.voice, v.sound));
            }
        }
        for (voice, sound) in ended {
            if let Some(index) = self.index_of(voice) {
                self.voices.remove(index);
            }
            self.emit(AudioEvent::at(self.tick, AudioEventCode::Ended).of(voice, Some(sound)));
        }
    }

    /// Move both music clocks one tick: loops wrap, a track that does not loop ends, and a track
    /// whose fade-out finished goes.
    fn advance_music(&mut self) {
        for track in [MusicTrack::A, MusicTrack::B] {
            let Some(slot) = self.music[track.index()].as_mut() else { continue };
            slot.volume.advance();
            slot.position_frames += f64::from(slot.rate_hz) / f64::from(TICK_HZ);
            if slot.stopping && slot.volume.settled() {
                self.music[track.index()] = None;
                continue;
            }
            let region = slot.loop_region().filter(|_| slot.opts.looped);
            if let Some((start, end)) = region {
                if slot.position_frames >= end {
                    slot.position_frames = start + (slot.position_frames - end) % (end - start);
                }
                continue;
            }
            if slot.position_frames < slot.frames as f64 {
                continue;
            }
            let music = slot.music;
            self.music[track.index()] = None;
            if self.current_music == Some(track) {
                self.current_music = None;
            }
            self.emit(AudioEvent::at(self.tick, AudioEventCode::MusicEnded).music(music));
        }
    }

    /// The logical-state hash (FNV-1a over the bits of everything that decides what is heard):
    /// equal in two processes, on every destination and at every pool size. It leaves out the
    /// physical slots, what the slots were sent, the virtualize and realize events and their count.
    pub fn logical_hash(&self) -> u64 {
        let mut h = Fnv::default();
        h.u64(self.tick);
        h.u32(self.next_voice);
        h.u32(self.next_zone);
        h.f32(self.master_db);
        for ramp in &self.bus {
            h.ramp(ramp);
        }
        for db in &self.ducks {
            h.f32(*db);
        }
        for slot in &self.music {
            h.music(slot.as_ref());
        }
        h.u32(self.current_music.map_or(0, |track| track.index() as u32 + 1));
        h.listener(self.listener_override.as_ref());
        h.listener(Some(&self.ears));
        h.vec3_opt(self.prev_ears);
        for (id, zone) in &self.zones {
            h.u32(id.id());
            h.zone(zone);
        }
        h.u32(self.active_zone.map_or(0, ZoneId::id));
        h.u32(self.occlusion.cursor());
        let counts = self.events.counts();
        for count in [counts.played, counts.stolen, counts.refused] {
            h.u64(count);
        }
        h.u64(self.event_hash);
        for state in &self.voices {
            h.voice(state);
        }
        h.finish()
    }

    /// The save section `audio`: the music slots, looped voices, sim bus layers, ducks, zones and
    /// listener. One-shots are dropped.
    pub fn snapshot(&self) -> Value {
        let mut section = Value::object();
        section.set("version", Value::Number(SNAPSHOT_VERSION));
        section.set("tick", num_u64(self.tick));
        section.set("nextVoice", Value::Number(f64::from(self.next_voice)));
        section.set("nextZone", Value::Number(f64::from(self.next_zone)));
        section.set("master", num(self.master_db));
        section.set("bus", Value::Array(self.bus.iter().map(ramp_value).collect()));
        section.set("ducks", Value::Array(self.ducks.iter().map(|db| num(*db)).collect()));
        section.set("music", Value::Array(self.music.iter().map(|slot| slot.as_ref().map_or(Value::Null, music_value)).collect()));
        section.set("current", self.current_music.map_or(Value::Null, |track| Value::Number(track.index() as f64)));
        section.set("listener", self.listener_override.as_ref().map_or(Value::Null, listener_value));
        section.set("prevEars", self.prev_ears.map_or(Value::Null, vec3_value));
        section.set("zones", Value::Array(self.zones.iter().map(|(id, zone)| zone_value(*id, zone)).collect()));
        section.set("activeZone", self.active_zone.map_or(Value::Null, |id| Value::Number(f64::from(id.id()))));
        section.set("occlusionCursor", Value::Number(f64::from(self.occlusion.cursor())));
        section.set("counts", counts_value(self.events.counts()));
        let looped = self.voices.iter().filter(|state| state.logical.looped);
        section.set("voices", Value::Array(looped.map(voice_value).collect()));
        section
    }

    /// Restore a [`Director::snapshot`]; refuses (`invalid-value`) a section it cannot read and
    /// then changes nothing. It expects a fresh mixer (`Mixer::reset`): restored voices have no
    /// track until the next step, whose first ops re-send the master layer, the reverb, the bus
    /// layers and the music at its position.
    pub fn restore(&mut self, section: &Value) -> Result<(), AudioError> {
        let restored = self.read_section(section).map_err(|detail| AudioError::new(AudioErrorCode::InvalidValue, detail))?;
        self.apply_restored(restored);
        Ok(())
    }

    fn read_section(&mut self, section: &Value) -> Result<Restored, String> {
        if number(section, "version")? != SNAPSHOT_VERSION {
            return Err("audio section version".to_owned());
        }
        let bus_items = array(section, "bus")?;
        let ducks: Vec<f32> = array(section, "ducks")?.iter().map(as_f32).collect::<Result<_, _>>()?;
        if bus_items.len() != Bus::ALL.len() || ducks.len() != self.setup.ducks.len() {
            return Err("audio section buses or ducks".to_owned());
        }
        let mut bus = [Ramp::at(0.0); Bus::ALL.len()];
        for (ramp, item) in bus.iter_mut().zip(bus_items) {
            *ramp = read_ramp(item)?;
        }
        let music_items = array(section, "music")?;
        if music_items.len() != 2 {
            return Err("audio section music".to_owned());
        }
        let music = [read_music(&music_items[0], &self.musics)?, read_music(&music_items[1], &self.musics)?];
        let current_music = match field(section, "current")? {
            Value::Null => None,
            value => Some(if as_u32(value)? == 0 { MusicTrack::A } else { MusicTrack::B }),
        };
        let mut zones = Vec::new();
        for item in array(section, "zones")?.iter().take(REVERB_ZONES_MAX) {
            zones.push(self.read_zone(item)?);
        }
        let mut voices = Vec::new();
        for item in array(section, "voices")?.iter().take(LOGICAL_VOICES_MAX) {
            voices.push(read_voice(item, &self.sounds)?);
        }
        voices.sort_by_key(|state: &VoiceState| state.logical.voice);
        voices.dedup_by_key(|state| state.logical.voice);
        Ok(Restored {
            tick: as_u64(field(section, "tick")?)?,
            next_voice: as_u32(field(section, "nextVoice")?)?,
            next_zone: as_u32(field(section, "nextZone")?)?,
            master_db: as_f32(field(section, "master")?)?,
            bus,
            ducks,
            music,
            current_music,
            listener_override: optional(field(section, "listener")?, read_listener)?,
            prev_ears: optional(field(section, "prevEars")?, read_vec3)?,
            zones,
            active_zone: optional(field(section, "activeZone")?, as_u32)?.map(ZoneId::from_id),
            occlusion_cursor: as_u32(field(section, "occlusionCursor")?)?,
            counts: read_counts(field(section, "counts")?)?,
            voices,
        })
    }

    fn read_zone(&mut self, item: &Value) -> Result<(ZoneId, ReverbZone), String> {
        let name_bytes = field(item, "name")?.as_bytes();
        let name = self.zone_name(name_bytes);
        let (id, zone) = read_zone_fields(item, name)?;
        if !zone_is_finite(&zone) {
            return Err("audio zone values".to_owned());
        }
        Ok((id, zone))
    }

    /// A `'static` name for a restored zone: one the Director already knows, else (within
    /// [`ZONE_NAMES_MAX`] distinct names of at most [`ZONE_NAME_BYTES_MAX`] bytes) the name kept
    /// for the rest of the process, else unnamed.
    fn zone_name(&mut self, bytes: &[u8]) -> &'static str {
        if let Some(known) = self.zone_names.iter().find(|name| name.as_bytes() == bytes) {
            return known;
        }
        let keepable = bytes.len() <= ZONE_NAME_BYTES_MAX && self.zone_names.len() < ZONE_NAMES_MAX;
        let Some(text) = std::str::from_utf8(bytes).ok().filter(|_| keepable) else { return "" };
        // Bounded by ZONE_NAMES_MAX names of ZONE_NAME_BYTES_MAX bytes for the whole process:
        // a zone's name is `&'static str` in the game's API.
        let name: &'static str = Box::leak(text.to_owned().into_boxed_str());
        self.zone_names.push(name);
        name
    }

    fn apply_restored(&mut self, restored: Restored) {
        self.tick = restored.tick;
        self.next_voice = restored.next_voice.max(1);
        self.next_zone = restored.next_zone.max(1);
        self.master_db = restored.master_db;
        self.bus = restored.bus;
        self.ducks = restored.ducks;
        self.music = restored.music;
        self.current_music = restored.current_music.filter(|track| self.music[track.index()].is_some());
        self.listener_override = restored.listener_override;
        self.prev_ears = restored.prev_ears;
        self.ears_jumped = false;
        self.zones = restored.zones;
        self.active_zone = restored.active_zone;
        self.occlusion = OcclusionScheduler::resume(restored.occlusion_cursor);
        self.events = EventLog::resume(restored.counts);
        self.event_hash = FNV_OFFSET;
        self.voices = restored.voices;
        self.view = self.logical_views();
        self.ops.clear();
        // NaN equals nothing, so the next step sends every bus.
        self.sent_bus = [f32::NAN; Bus::ALL.len()];
        self.resync = true;
    }

    /// After a restore, the next step's first ops re-send what a fresh mixer lacks: the master
    /// layer, the zone's reverb, and each music track at its logical position and fade. Voices
    /// need nothing: the pool starts them at their logical offsets.
    fn resend_state(&mut self) {
        self.ops.push(MixerOp::MasterVolume { db: self.master_db, fade_s: 0.0 });
        if let Some((_, zone)) = self.zone() {
            self.ops.push(MixerOp::Reverb { preset: zone.preset, fade_s: 0.0 });
        }
        for track in [MusicTrack::A, MusicTrack::B] {
            let Some(slot) = self.music[track.index()] else { continue };
            let position_s = (slot.position_frames / f64::from(slot.rate_hz.max(1))) as f32;
            let opts = MusicOpts { fade_s: 0.0, volume_db: slot.volume.value(), start_s: position_s, ..slot.opts };
            self.ops.push(MixerOp::MusicStart { track, music: slot.music, opts });
            let remaining_s = slot.volume.ticks.saturating_sub(slot.volume.done) as f32 * TICK_S;
            if slot.stopping {
                self.ops.push(MixerOp::MusicStop { track, fade_s: remaining_s });
            } else if remaining_s > 0.0 {
                self.ops.push(MixerOp::MusicVolume { track, db: slot.volume.to, fade_s: remaining_s });
            }
        }
    }
}

/// A save section read whole before any of it is applied.
struct Restored {
    tick: u64,
    next_voice: u32,
    next_zone: u32,
    master_db: f32,
    bus: [Ramp; Bus::ALL.len()],
    ducks: Vec<f32>,
    music: [Option<MusicSlot>; 2],
    current_music: Option<MusicTrack>,
    listener_override: Option<Listener>,
    prev_ears: Option<Vec3>,
    zones: Vec<(ZoneId, ReverbZone)>,
    active_zone: Option<ZoneId>,
    occlusion_cursor: u32,
    counts: AudioCounts,
    voices: Vec<VoiceState>,
}

fn new_voice(tick: u64, voice: Voice, sound: SoundId, info: SoundInfo, opts: &PlayOpts) -> VoiceState {
    let pitch = opts.pitch.clamp(DOPPLER_RATE_MIN, DOPPLER_RATE_MAX);
    let logical = LogicalVoice {
        voice,
        sound,
        bus: opts.bus,
        priority: opts.priority,
        started_tick: tick,
        position_frames: f64::from(opts.start_s.max(0.0)) * f64::from(info.rate_hz),
        frames: info.frames,
        rate_hz: info.rate_hz,
        looped: opts.looped,
        gain_db: opts.volume_db,
        pan: opts.pan.clamp(-1.0, 1.0),
        pitch,
        cutoff_hz: CUTOFF_OPEN_HZ,
        send_db: SEND_OFF_DB,
        occluded: false,
        at: opts.at,
        spatial: opts.spatial,
        slot: None,
        never_virtual: opts.never_virtual,
    };
    VoiceState {
        logical,
        volume: Ramp::at(opts.volume_db),
        rate: Ramp::at(pitch),
        base_pan: opts.pan.clamp(-1.0, 1.0),
        fade_in_s: opts.fade_in_s.max(0.0),
        prev_at: opts.at,
        doppler: 1.0,
        transmission: 1.0,
        clarity: 1.0,
        fresh: true,
        sent: None,
    }
}

/// Whether the voice is cast for occlusion (it also needs the game's setup to turn it on).
fn occludable(voice: &LogicalVoice) -> bool {
    voice.at.is_some() && voice.spatial.occlusion
}

/// One voice's gain, pan, pitch, cut-off and send for this tick. A voice with no position (UI,
/// beds) is heard as played: its own gain and pan, open, with no reverb send.
fn update_voice(state: &mut VoiceState, ears: &Listener, ears_velocity: Vec3, zone: Option<&ReverbZone>, occlusion_on: bool) {
    state.volume.advance();
    state.rate.advance();
    let volume = state.volume.value();
    let v = &mut state.logical;
    let Some(at) = v.at else {
        v.gain_db = volume;
        v.pan = state.base_pan;
        v.cutoff_hz = CUTOFF_OPEN_HZ;
        v.send_db = SEND_OFF_DB;
        v.pitch = state.rate.value().clamp(DOPPLER_RATE_MIN, DOPPLER_RATE_MAX);
        return;
    };
    let spatial = v.spatial;
    let distance = (at - ears.position).length();
    let dry_db = attenuation_db(&spatial, distance);
    let emitter_velocity = (at - state.prev_at.unwrap_or(at)) * TICK_HZ;
    let toward_ears = (ears.position - at).normalize_or_zero();
    state.doppler = doppler_rate(emitter_velocity, ears_velocity, toward_ears, spatial.doppler);
    state.prev_at = Some(at);
    let occluded = occlusion_on && spatial.occlusion;
    let target = if occluded { state.transmission } else { 1.0 };
    let step = 1.0 / (OCCLUSION_TWEEN_S * TICK_HZ);
    state.clarity += (target - state.clarity).clamp(-step, step);
    let occlusion_db = if state.clarity < 1.0 { gain_to_db(state.clarity) } else { 0.0 };
    let occluded_cutoff = OCCLUDED_CUTOFF_FLOOR_HZ * libm::powf(CUTOFF_OPEN_HZ / OCCLUDED_CUTOFF_FLOOR_HZ, state.clarity);
    v.gain_db = volume + dry_db + occlusion_db;
    v.pan = pan(ears, at, spatial.panning);
    v.cutoff_hz = distance_cutoff_hz(&spatial, distance).min(occluded_cutoff);
    v.send_db = zone.map_or(SEND_OFF_DB, |zone| send_db(zone, dry_db));
    v.occluded = target < 1.0;
    v.pitch = (state.rate.value() * state.doppler).clamp(DOPPLER_RATE_MIN, DOPPLER_RATE_MAX);
}

/// A duck's level after one more tick toward `depth_db` (active) or 0 (released), at a rate that
/// covers the depth in `seconds`.
fn duck_step(level: f32, depth_db: f32, seconds: f32, active: bool) -> f32 {
    let depth = if depth_db.is_finite() { depth_db.min(0.0) } else { 0.0 };
    let target = if active { depth } else { 0.0 };
    let ticks = fade_ticks(if seconds.is_finite() { seconds } else { 0.0 });
    if ticks == 0 || depth == 0.0 {
        return target;
    }
    let step = -depth / ticks as f32;
    level + (target - level).clamp(-step, step)
}

fn spatial_is_finite(spatial: &Spatial) -> bool {
    [spatial.ref_distance, spatial.max_distance, spatial.rolloff, spatial.panning, spatial.doppler].iter().all(|v| v.is_finite())
}

fn play_is_finite(opts: &PlayOpts) -> bool {
    let scalars = [opts.volume_db, opts.pitch, opts.pan, opts.start_s, opts.fade_in_s].iter().all(|v| v.is_finite());
    scalars && opts.pitch > 0.0 && opts.at.is_none_or(Vec3::is_finite) && spatial_is_finite(&opts.spatial)
}

fn music_is_finite(opts: &MusicOpts) -> bool {
    let scalars = [opts.fade_s, opts.volume_db, opts.start_s, opts.loop_start_s].iter().all(|v| v.is_finite());
    scalars && opts.loop_end_s.is_none_or(f32::is_finite)
}

fn listener_is_finite(listener: &Listener) -> bool {
    listener.position.is_finite() && listener.forward.is_finite() && listener.up.is_finite()
}

fn zone_is_finite(zone: &ReverbZone) -> bool {
    let shape = match zone.shape {
        ZoneShape::Box { min, max } => min.is_finite() && max.is_finite(),
        ZoneShape::Sphere { center, radius } => center.is_finite() && radius.is_finite(),
    };
    shape && [zone.send_db, zone.uniformity, zone.preset.room, zone.preset.damping].iter().all(|v| v.is_finite())
}

// ---- the logical hash ----

const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0100_0000_01b3;

/// FNV-1a, fed little-endian bytes.
struct Fnv(u64);

impl Default for Fnv {
    fn default() -> Fnv {
        Fnv(FNV_OFFSET)
    }
}

impl Fnv {
    fn bytes(&mut self, bytes: &[u8]) {
        for byte in bytes {
            self.0 = (self.0 ^ u64::from(*byte)).wrapping_mul(FNV_PRIME);
        }
    }

    fn u32(&mut self, value: u32) {
        self.bytes(&value.to_le_bytes());
    }

    fn u64(&mut self, value: u64) {
        self.bytes(&value.to_le_bytes());
    }

    fn f32(&mut self, value: f32) {
        self.u32(value.to_bits());
    }

    fn f64(&mut self, value: f64) {
        self.u64(value.to_bits());
    }

    fn flag(&mut self, value: bool) {
        self.bytes(&[u8::from(value)]);
    }

    fn vec3(&mut self, value: Vec3) {
        for axis in value.to_array() {
            self.f32(axis);
        }
    }

    fn vec3_opt(&mut self, value: Option<Vec3>) {
        self.flag(value.is_some());
        if let Some(value) = value {
            self.vec3(value);
        }
    }

    fn ramp(&mut self, ramp: &Ramp) {
        self.f32(ramp.from);
        self.f32(ramp.to);
        self.u32(ramp.ticks);
        self.u32(ramp.done);
    }

    fn listener(&mut self, listener: Option<&Listener>) {
        self.flag(listener.is_some());
        if let Some(listener) = listener {
            self.vec3(listener.position);
            self.vec3(listener.forward);
            self.vec3(listener.up);
        }
    }

    fn music(&mut self, slot: Option<&MusicSlot>) {
        self.flag(slot.is_some());
        let Some(slot) = slot else { return };
        self.u32(slot.music.0);
        self.f64(slot.position_frames);
        self.u64(slot.frames);
        self.u32(slot.rate_hz);
        self.ramp(&slot.volume);
        self.flag(slot.stopping);
        let opts = slot.opts;
        for value in [opts.fade_s, opts.volume_db, opts.start_s, opts.loop_start_s, opts.loop_end_s.unwrap_or(-1.0)] {
            self.f32(value);
        }
        self.flag(opts.looped);
    }

    fn zone(&mut self, zone: &ReverbZone) {
        self.bytes(zone.name.as_bytes());
        match zone.shape {
            ZoneShape::Box { min, max } => {
                self.u32(0);
                self.vec3(min);
                self.vec3(max);
            }
            ZoneShape::Sphere { center, radius } => {
                self.u32(1);
                self.vec3(center);
                self.f32(radius);
            }
        }
        for value in [zone.preset.room, zone.preset.damping, zone.send_db, zone.uniformity] {
            self.f32(value);
        }
    }

    fn spatial(&mut self, spatial: &Spatial) {
        self.bytes(spatial.attenuation.as_str().as_bytes());
        for value in [spatial.ref_distance, spatial.max_distance, spatial.rolloff, spatial.panning, spatial.doppler] {
            self.f32(value);
        }
        self.flag(spatial.lowpass_by_distance);
        self.flag(spatial.occlusion);
    }

    fn voice(&mut self, state: &VoiceState) {
        let v = &state.logical;
        self.u32(v.voice.id());
        self.u32(v.sound.0);
        self.u32(v.bus.index() as u32);
        self.u32(u32::from(v.priority));
        self.u64(v.started_tick);
        self.f64(v.position_frames);
        self.u64(v.frames);
        self.u32(v.rate_hz);
        self.flag(v.looped);
        for value in [v.gain_db, v.pan, v.pitch, v.cutoff_hz, v.send_db] {
            self.f32(value);
        }
        self.flag(v.occluded);
        self.vec3_opt(v.at);
        self.spatial(&v.spatial);
        self.flag(v.never_virtual);
        self.ramp(&state.volume);
        self.ramp(&state.rate);
        for value in [state.base_pan, state.fade_in_s, state.doppler, state.transmission, state.clarity] {
            self.f32(value);
        }
        self.vec3_opt(state.prev_at);
    }

    fn finish(&self) -> u64 {
        self.0
    }
}

fn hash_event(seed: u64, event: &AudioEvent) -> u64 {
    let mut h = Fnv(seed);
    h.u64(event.tick);
    h.bytes(event.code.as_str().as_bytes());
    h.u32(event.voice.id());
    h.u32(event.sound.map_or(u32::MAX, |sound| sound.0));
    h.u32(event.by.id());
    h.u32(event.music.map_or(u32::MAX, |music| music.0));
    h.bytes(event.reason.map_or("", AudioErrorCode::as_str).as_bytes());
    h.finish()
}

// ---- the save section ----

fn num(value: f32) -> Value {
    Value::Number(f64::from(value))
}

fn num_u64(value: u64) -> Value {
    Value::Number(value as f64)
}

fn vec3_value(value: Vec3) -> Value {
    Value::Array(value.to_array().into_iter().map(num).collect())
}

fn ramp_value(ramp: &Ramp) -> Value {
    Value::Array(vec![num(ramp.from), num(ramp.to), Value::Number(f64::from(ramp.ticks)), Value::Number(f64::from(ramp.done))])
}

fn listener_value(listener: &Listener) -> Value {
    let mut value = Value::object();
    value.set("position", vec3_value(listener.position));
    value.set("forward", vec3_value(listener.forward));
    value.set("up", vec3_value(listener.up));
    value
}

fn music_value(slot: &MusicSlot) -> Value {
    let mut value = Value::object();
    value.set("music", Value::Number(f64::from(slot.music.0)));
    value.set("position", Value::Number(slot.position_frames));
    value.set("volume", ramp_value(&slot.volume));
    value.set("stopping", Value::Bool(slot.stopping));
    let opts = slot.opts;
    value.set("fade", num(opts.fade_s));
    value.set("volumeDb", num(opts.volume_db));
    value.set("start", num(opts.start_s));
    value.set("looped", Value::Bool(opts.looped));
    value.set("loopStart", num(opts.loop_start_s));
    value.set("loopEnd", opts.loop_end_s.map_or(Value::Null, num));
    value
}

fn zone_value(id: ZoneId, zone: &ReverbZone) -> Value {
    let mut value = Value::object();
    value.set("id", Value::Number(f64::from(id.id())));
    value.set("name", Value::String(zone.name.as_bytes().to_vec()));
    match zone.shape {
        ZoneShape::Box { min, max } => {
            value.set("min", vec3_value(min));
            value.set("max", vec3_value(max));
        }
        ZoneShape::Sphere { center, radius } => {
            value.set("center", vec3_value(center));
            value.set("radius", num(radius));
        }
    }
    value.set("room", num(zone.preset.room));
    value.set("damping", num(zone.preset.damping));
    value.set("sendDb", num(zone.send_db));
    value.set("uniformity", num(zone.uniformity));
    value
}

fn counts_value(counts: AudioCounts) -> Value {
    let mut value = Value::object();
    value.set("played", num_u64(counts.played));
    value.set("stolen", num_u64(counts.stolen));
    value.set("refused", num_u64(counts.refused));
    value.set("virtualized", num_u64(counts.virtualized));
    value
}

fn spatial_value(spatial: &Spatial) -> Value {
    let mut value = Value::object();
    value.set("attenuation", Value::String(spatial.attenuation.as_str().as_bytes().to_vec()));
    value.set("ref", num(spatial.ref_distance));
    value.set("max", num(spatial.max_distance));
    value.set("rolloff", num(spatial.rolloff));
    value.set("panning", num(spatial.panning));
    value.set("lowpass", Value::Bool(spatial.lowpass_by_distance));
    value.set("doppler", num(spatial.doppler));
    value.set("occlusion", Value::Bool(spatial.occlusion));
    value
}

fn voice_value(state: &VoiceState) -> Value {
    let v = &state.logical;
    let mut value = Value::object();
    value.set("id", Value::Number(f64::from(v.voice.id())));
    value.set("sound", Value::Number(f64::from(v.sound.0)));
    value.set("bus", Value::String(v.bus.as_str().as_bytes().to_vec()));
    value.set("priority", Value::Number(f64::from(v.priority)));
    value.set("started", num_u64(v.started_tick));
    value.set("position", Value::Number(v.position_frames));
    value.set("gainDb", num(v.gain_db));
    value.set("pan", num(v.pan));
    value.set("pitch", num(v.pitch));
    value.set("cutoffHz", num(v.cutoff_hz));
    value.set("sendDb", num(v.send_db));
    value.set("occluded", Value::Bool(v.occluded));
    value.set("at", v.at.map_or(Value::Null, vec3_value));
    value.set("spatial", spatial_value(&v.spatial));
    value.set("neverVirtual", Value::Bool(v.never_virtual));
    value.set("volume", ramp_value(&state.volume));
    value.set("rate", ramp_value(&state.rate));
    value.set("basePan", num(state.base_pan));
    value.set("fadeIn", num(state.fade_in_s));
    value.set("prevAt", state.prev_at.map_or(Value::Null, vec3_value));
    value.set("doppler", num(state.doppler));
    value.set("transmission", num(state.transmission));
    value.set("clarity", num(state.clarity));
    value
}

fn field<'a>(value: &'a Value, key: &str) -> Result<&'a Value, String> {
    value.get(key).ok_or_else(|| format!("audio section: no {key}"))
}

fn number(value: &Value, key: &str) -> Result<f64, String> {
    match field(value, key)? {
        Value::Number(number) => Ok(*number),
        _ => Err(format!("audio section: {key} is not a number")),
    }
}

fn array<'a>(value: &'a Value, key: &str) -> Result<&'a [Value], String> {
    match field(value, key)? {
        Value::Array(items) => Ok(items),
        _ => Err(format!("audio section: {key} is not an array")),
    }
}

fn flag(value: &Value, key: &str) -> Result<bool, String> {
    match field(value, key)? {
        Value::Bool(flag) => Ok(*flag),
        _ => Err(format!("audio section: {key} is not a flag")),
    }
}

/// A finite f32 written by the snapshot (exact in an f64).
fn as_f32(value: &Value) -> Result<f32, String> {
    match value {
        Value::Number(number) if number.is_finite() && f64::from(*number as f32) == *number => Ok(*number as f32),
        _ => Err("audio section: not an f32".to_owned()),
    }
}

fn as_u64(value: &Value) -> Result<u64, String> {
    match value {
        Value::Number(number) if *number >= 0.0 && number.fract() == 0.0 && *number <= 9_007_199_254_740_992.0 => Ok(*number as u64),
        _ => Err("audio section: not a whole number".to_owned()),
    }
}

fn as_u32(value: &Value) -> Result<u32, String> {
    u32::try_from(as_u64(value)?).map_err(|_| "audio section: out of range".to_owned())
}

fn f32_field(value: &Value, key: &str) -> Result<f32, String> {
    as_f32(field(value, key)?)
}

fn optional<T>(value: &Value, read: impl Fn(&Value) -> Result<T, String>) -> Result<Option<T>, String> {
    match value {
        Value::Null => Ok(None),
        value => read(value).map(Some),
    }
}

fn read_vec3(value: &Value) -> Result<Vec3, String> {
    match value {
        Value::Array(items) if items.len() == 3 => Ok(Vec3::new(as_f32(&items[0])?, as_f32(&items[1])?, as_f32(&items[2])?)),
        _ => Err("audio section: not a position".to_owned()),
    }
}

fn read_ramp(value: &Value) -> Result<Ramp, String> {
    match value {
        Value::Array(items) if items.len() == 4 => {
            let ramp = Ramp { from: as_f32(&items[0])?, to: as_f32(&items[1])?, ticks: as_u32(&items[2])?, done: as_u32(&items[3])? };
            Ok(Ramp { done: ramp.done.min(ramp.ticks), ..ramp })
        }
        _ => Err("audio section: not a ramp".to_owned()),
    }
}

fn read_listener(value: &Value) -> Result<Listener, String> {
    Ok(Listener {
        position: read_vec3(field(value, "position")?)?,
        forward: read_vec3(field(value, "forward")?)?,
        up: read_vec3(field(value, "up")?)?,
    })
}

fn read_music(value: &Value, known: &[(MusicId, SoundInfo)]) -> Result<Option<MusicSlot>, String> {
    if value.is_null() {
        return Ok(None);
    }
    let music = MusicId(as_u32(field(value, "music")?)?);
    let info = known.iter().find(|(id, _)| *id == music).map(|(_, info)| *info).ok_or("audio section: unknown music")?;
    let opts = MusicOpts {
        fade_s: f32_field(value, "fade")?,
        volume_db: f32_field(value, "volumeDb")?,
        start_s: f32_field(value, "start")?,
        looped: flag(value, "looped")?,
        loop_start_s: f32_field(value, "loopStart")?,
        loop_end_s: optional(field(value, "loopEnd")?, as_f32)?,
    };
    let position_frames = number(value, "position")?;
    if !position_frames.is_finite() || position_frames < 0.0 {
        return Err("audio section: music position".to_owned());
    }
    let volume = read_ramp(field(value, "volume")?)?;
    let stopping = flag(value, "stopping")?;
    Ok(Some(MusicSlot { music, opts, position_frames, frames: info.frames, rate_hz: info.rate_hz, volume, stopping }))
}

fn read_zone_fields(value: &Value, name: &'static str) -> Result<(ZoneId, ReverbZone), String> {
    let id = ZoneId::from_id(as_u32(field(value, "id")?)?);
    let shape = match value.get("radius") {
        Some(radius) => ZoneShape::Sphere { center: read_vec3(field(value, "center")?)?, radius: as_f32(radius)? },
        None => ZoneShape::Box { min: read_vec3(field(value, "min")?)?, max: read_vec3(field(value, "max")?)? },
    };
    let preset = crate::ops::ReverbPreset { room: f32_field(value, "room")?, damping: f32_field(value, "damping")? };
    let zone = ReverbZone { name, shape, preset, send_db: f32_field(value, "sendDb")?, uniformity: f32_field(value, "uniformity")? };
    Ok((id, zone))
}

fn read_counts(value: &Value) -> Result<AudioCounts, String> {
    Ok(AudioCounts {
        played: as_u64(field(value, "played")?)?,
        stolen: as_u64(field(value, "stolen")?)?,
        refused: as_u64(field(value, "refused")?)?,
        virtualized: as_u64(field(value, "virtualized")?)?,
    })
}

fn read_spatial(value: &Value) -> Result<Spatial, String> {
    let attenuation = Attenuation::from_wire(field(value, "attenuation")?.as_str()).ok_or("audio section: attenuation")?;
    let spatial = Spatial {
        attenuation,
        ref_distance: f32_field(value, "ref")?,
        max_distance: f32_field(value, "max")?,
        rolloff: f32_field(value, "rolloff")?,
        panning: f32_field(value, "panning")?,
        lowpass_by_distance: flag(value, "lowpass")?,
        doppler: f32_field(value, "doppler")?,
        occlusion: flag(value, "occlusion")?,
    };
    Ok(spatial)
}

fn read_voice(value: &Value, sounds: &[(SoundId, SoundInfo)]) -> Result<VoiceState, String> {
    let voice = Voice::from_id(as_u32(field(value, "id")?)?);
    let sound = SoundId(as_u32(field(value, "sound")?)?);
    let info = sounds.iter().find(|(id, _)| *id == sound).map(|(_, info)| *info).ok_or("audio section: unknown sound")?;
    let bus = Bus::from_wire(field(value, "bus")?.as_str()).ok_or("audio section: bus")?;
    let priority = u8::try_from(as_u32(field(value, "priority")?)?).map_err(|_| "audio section: priority")?;
    let position_frames = number(value, "position")?;
    let usable = voice != Voice::NONE && position_frames.is_finite() && position_frames >= 0.0;
    if !usable {
        return Err("audio section: voice".to_owned());
    }
    let logical = LogicalVoice {
        voice,
        sound,
        bus,
        priority,
        started_tick: as_u64(field(value, "started")?)?,
        position_frames,
        frames: info.frames,
        rate_hz: info.rate_hz,
        looped: true,
        gain_db: f32_field(value, "gainDb")?,
        pan: f32_field(value, "pan")?,
        pitch: f32_field(value, "pitch")?,
        cutoff_hz: f32_field(value, "cutoffHz")?,
        send_db: f32_field(value, "sendDb")?,
        occluded: flag(value, "occluded")?,
        at: optional(field(value, "at")?, read_vec3)?,
        spatial: read_spatial(field(value, "spatial")?)?,
        slot: None,
        never_virtual: flag(value, "neverVirtual")?,
    };
    Ok(VoiceState {
        logical,
        volume: read_ramp(field(value, "volume")?)?,
        rate: read_ramp(field(value, "rate")?)?,
        base_pan: f32_field(value, "basePan")?,
        fade_in_s: f32_field(value, "fadeIn")?,
        prev_at: optional(field(value, "prevAt")?, read_vec3)?,
        doppler: f32_field(value, "doppler")?,
        transmission: f32_field(value, "transmission")?,
        clarity: f32_field(value, "clarity")?,
        fresh: false,
        sent: None,
    })
}
