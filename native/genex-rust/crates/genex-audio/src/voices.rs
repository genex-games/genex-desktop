//! The logical voice table's choices: which voice a play steals and how voices rank for the
//! physical pool. Pure, with total orders over integers and `f32::total_cmp`, so every
//! destination makes the same choice.

use crate::ops::{LogicalVoice, SoundId, Voice};
use std::cmp::Ordering;

/// What the Director knows about a registered sound without its samples.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SoundInfo {
    /// Source frames in the sound.
    pub frames: u64,
    /// The sound's own rate, in Hz.
    pub rate_hz: u32,
}

/// The voice a new play takes at the logical cap: lowest priority, then oldest start tick, then
/// highest id; `None` when every voice outranks a play of `priority` (`sound-limit`). A voice of
/// equal priority does not outrank the play.
pub fn steal_victim(voices: &[LogicalVoice], priority: u8) -> Option<Voice> {
    voices
        .iter()
        .filter(|voice| voice.priority <= priority)
        .min_by(|a, b| {
            a.priority.cmp(&b.priority).then(a.started_tick.cmp(&b.started_tick)).then(b.voice.cmp(&a.voice))
        })
        .map(|voice| voice.voice)
}

/// The oldest instance of `sound` (start tick, then lowest id) once `max_instances` of it play;
/// `None` under the cap, or when `max_instances` is 0 (no cap).
pub fn instance_victim(voices: &[LogicalVoice], sound: SoundId, max_instances: u8) -> Option<Voice> {
    if max_instances == 0 {
        return None;
    }
    let instances = || voices.iter().filter(|voice| voice.sound == sound);
    if instances().count() < usize::from(max_instances) {
        return None;
    }
    instances().min_by_key(|voice| (voice.started_tick, voice.voice)).map(|voice| voice.voice)
}

/// The pool order of two voices: never-virtual first, then priority (descending), audible gain
/// (descending), start tick, then id.
fn pool_order(a: &LogicalVoice, b: &LogicalVoice) -> Ordering {
    b.never_virtual
        .cmp(&a.never_virtual)
        .then(b.priority.cmp(&a.priority))
        .then(b.gain_db.total_cmp(&a.gain_db))
        .then(a.started_tick.cmp(&b.started_tick))
        .then(a.voice.cmp(&b.voice))
}

/// Indices of `voices` in physical-pool order: never-virtual (UI) voices first, then priority
/// (descending), audible gain (descending), start tick, then id. The first `physical` of them get
/// tracks.
pub fn rank_for_pool(voices: &[LogicalVoice]) -> Vec<usize> {
    let mut order: Vec<usize> = (0..voices.len()).collect();
    order.sort_by(|&a, &b| pool_order(&voices[a], &voices[b]));
    order
}
