//! What happened to voices on a tick: the bounded event list `state().volatile.audio.events`
//! shows and the running counts that keep what the list drops.

use crate::ops::{MusicId, SoundId, Voice};
use crate::vocab::{AUDIO_EVENTS_MAX, AudioErrorCode, AudioEventCode};

/// One thing that happened to a voice.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AudioEvent {
    /// The tick it happened on.
    pub tick: u64,
    /// What happened.
    pub code: AudioEventCode,
    /// The voice (a refused play's is the id its call answered; [`Voice::NONE`] for a music
    /// event or a refused command that names no voice).
    pub voice: Voice,
    /// The sound involved, when there is one.
    pub sound: Option<SoundId>,
    /// The voice that caused it (a steal's thief), or [`Voice::NONE`].
    pub by: Voice,
    /// The music involved, for a music event.
    pub music: Option<MusicId>,
    /// Why a play or command was refused.
    pub reason: Option<AudioErrorCode>,
}

impl AudioEvent {
    /// An event with no voice, sound, music or reason yet.
    pub(crate) fn at(tick: u64, code: AudioEventCode) -> AudioEvent {
        AudioEvent { tick, code, voice: Voice::NONE, sound: None, by: Voice::NONE, music: None, reason: None }
    }

    /// This event about `voice` playing `sound`.
    pub(crate) fn of(self, voice: Voice, sound: Option<SoundId>) -> AudioEvent {
        AudioEvent { voice, sound, ..self }
    }

    /// This event caused by `by`.
    pub(crate) fn by(self, by: Voice) -> AudioEvent {
        AudioEvent { by, ..self }
    }

    /// This event about `music`.
    pub(crate) fn music(self, music: MusicId) -> AudioEvent {
        AudioEvent { music: Some(music), ..self }
    }

    /// This refusal, for `reason`.
    pub(crate) fn because(self, reason: AudioErrorCode) -> AudioEvent {
        AudioEvent { reason: Some(reason), ..self }
    }
}

/// Running totals since the last seed.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct AudioCounts {
    /// Plays accepted.
    pub played: u64,
    /// Voices stolen.
    pub stolen: u64,
    /// Plays refused.
    pub refused: u64,
    /// Voices made virtual.
    pub virtualized: u64,
}

/// This tick's events (at most [`AUDIO_EVENTS_MAX`]) and the totals.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct EventLog {
    events: Vec<AudioEvent>,
    counts: AudioCounts,
}

impl EventLog {
    /// Record `event`: always counted, listed while this tick has room.
    pub fn push(&mut self, event: AudioEvent) {
        match event.code {
            AudioEventCode::Played => self.counts.played += 1,
            AudioEventCode::Stolen => self.counts.stolen += 1,
            AudioEventCode::Refused => self.counts.refused += 1,
            AudioEventCode::Virtualized => self.counts.virtualized += 1,
            _ => {}
        }
        if self.events.len() < AUDIO_EVENTS_MAX {
            self.events.push(event);
        }
    }

    /// Start a new tick's list; the counts go on.
    pub fn begin_tick(&mut self) {
        self.events.clear();
    }

    /// This tick's events, in the order they happened.
    pub fn events(&self) -> &[AudioEvent] {
        &self.events
    }

    /// The totals since the last seed.
    pub fn counts(&self) -> AudioCounts {
        self.counts
    }

    /// A log that goes on from `counts` with no events (a restored save section).
    pub(crate) fn resume(counts: AudioCounts) -> EventLog {
        EventLog { events: Vec::new(), counts }
    }
}
