//! The logical voice table: issuing, finding and stealing voices, and ranking them for the
//! physical pool. Pure and libm-only, so every destination makes the same choice. Bodies are
//! AU-2's; until then nothing is stolen and every voice ranks equal.

use crate::ops::{LogicalVoice, SoundId, Voice};

/// What the Director knows about a registered sound without its samples.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SoundInfo {
    /// Source frames in the sound.
    pub frames: u64,
    /// The sound's own rate, in Hz.
    pub rate_hz: u32,
}

/// The voice a new play takes at the logical cap: lowest priority, then oldest start tick, then
/// highest id; `None` when every voice outranks a play of `priority` (`sound-limit`).
pub fn steal_victim(voices: &[LogicalVoice], priority: u8) -> Option<Voice> {
    let _ = (voices, priority);
    None
}

/// The oldest instance of `sound` once `max_instances` of it play; `None` under the cap.
pub fn instance_victim(voices: &[LogicalVoice], sound: SoundId, max_instances: u8) -> Option<Voice> {
    let _ = (voices, sound, max_instances);
    None
}

/// Indices of `voices` in physical-pool order: priority (descending), audible gain (descending),
/// start tick, then id. The first `physical` of them get tracks.
pub fn rank_for_pool(voices: &[LogicalVoice]) -> Vec<usize> {
    (0..voices.len()).collect()
}
