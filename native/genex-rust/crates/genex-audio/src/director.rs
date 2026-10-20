//! The logical Director: commands in, logical voices and [`MixerOp`]s out. It decides which voices
//! exist, stealing, virtualization, ducking, music slots and events, on integer ticks and libm, so
//! its output is bit-equal on every destination and device class. Bodies are AU-2's; this stub
//! takes commands and decides nothing.

use crate::AudioError;
use crate::events::EventLog;
use crate::occlusion::Occluder;
use crate::ops::{AudioCommand, AudioSetup, Listener, LogicalVoice, MixerOp, SoundId, Voice};
use crate::vocab::PoolClass;
use crate::voices::SoundInfo;
use genex_core::json::Value;

/// What a step reads from the world besides the commands.
#[derive(Default)]
pub struct StepInput<'a> {
    /// The game's own camera as ears (an override from `ctx.audio.listener` wins).
    pub camera: Option<Listener>,
    /// The physics occluder, when the game has physics and occlusion is on.
    pub occluder: Option<&'a mut dyn Occluder>,
}

/// The logical audio state of a game, reset on seed.
pub struct Director {
    class: PoolClass,
    setup: AudioSetup,
    tick: u64,
    voices: Vec<LogicalVoice>,
    sounds: Vec<(SoundId, SoundInfo)>,
    ops: Vec<MixerOp>,
    events: EventLog,
}

impl Director {
    /// A Director rendering through `class`'s physical pool, with the game's `setup`.
    pub fn new(class: PoolClass, setup: AudioSetup) -> Director {
        Director { class, setup, tick: 0, voices: Vec::new(), sounds: Vec::new(), ops: Vec::new(), events: EventLog::default() }
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

    /// Back to a fresh seed: no voices, ids from 1, sim layers at 0 dB.
    pub fn reset(&mut self) {
        self.tick = 0;
        self.voices.clear();
        self.ops.clear();
        self.events = EventLog::default();
    }

    /// Apply this tick's `commands` in order and advance one tick; answers the ops to render.
    pub fn step(&mut self, commands: &[AudioCommand], input: StepInput<'_>) -> &[MixerOp] {
        let _ = (commands, input);
        self.events.begin_tick();
        self.ops.clear();
        self.tick += 1;
        &self.ops
    }

    /// The logical voices, sorted by id.
    pub fn voices(&self) -> &[LogicalVoice] {
        &self.voices
    }

    /// This tick's events and the totals.
    pub fn events(&self) -> &EventLog {
        &self.events
    }

    /// Whether `voice` is still playing (logical).
    pub fn playing(&self, voice: Voice) -> bool {
        self.voices.iter().any(|v| v.voice == voice)
    }

    /// Seconds into `voice`, or `None` once it ended.
    pub fn position_s(&self, voice: Voice) -> Option<f64> {
        self.voices.iter().find(|v| v.voice == voice).map(LogicalVoice::position_s)
    }

    /// The save section `audio`: music slot, looped voices, sim bus layers and zones.
    pub fn snapshot(&self) -> Value {
        Value::Null
    }

    /// Restore a [`Director::snapshot`]; refuses (`invalid-value`) a section it cannot read.
    pub fn restore(&mut self, section: &Value) -> Result<(), AudioError> {
        let _ = section;
        Ok(())
    }
}
