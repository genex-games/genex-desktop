//! What happened to voices on a tick: the bounded event list `state().volatile.audio.events`
//! shows and the running counts that keep what the list drops. Bodies are AU-2's.

use crate::ops::{SoundId, Voice};
use crate::vocab::{AUDIO_EVENTS_MAX, AudioEventCode};

/// One thing that happened to a voice.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AudioEvent {
    /// The tick it happened on.
    pub tick: u64,
    /// What happened.
    pub code: AudioEventCode,
    /// The voice ([`Voice::NONE`] for a refused play).
    pub voice: Voice,
    /// The sound involved, when there is one.
    pub sound: Option<SoundId>,
    /// The voice that caused it (a steal's thief), or [`Voice::NONE`].
    pub by: Voice,
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
}
