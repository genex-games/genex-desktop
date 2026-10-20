//! Occlusion: an [`Occluder`] the facade implements over physics colliders, and the round-robin
//! scheduler that casts at most [`OCCLUSION_RAYS_PER_TICK`] rays a tick.

use crate::ops::Voice;
use crate::vocab::OCCLUSION_RAYS_PER_TICK;
use glam::Vec3;

/// What one occluding collider lets through (about -9 dB).
pub const OCCLUDER_TRANSMISSION: f32 = 0.35;
/// The lowest cut-off occlusion pulls a voice to, in Hz.
pub const OCCLUDED_CUTOFF_FLOOR_HZ: f32 = 1_200.0;
/// Seconds an occlusion change is tweened over.
pub const OCCLUSION_TWEEN_S: f32 = 0.1;

/// How much sound passes between two points: 1 is open air, 0 is a solid wall.
pub trait Occluder {
    /// The transmission from `from` to `to`, 0..=1.
    fn transmission(&mut self, from: Vec3, to: Vec3) -> f32;
}

/// Picks which voices get a ray this tick, in id order, wrapping round.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct OcclusionScheduler {
    /// The id after the last voice cast; 0 starts from the lowest id.
    cursor: u32,
}

impl OcclusionScheduler {
    /// The voices (sorted by id) to cast for this tick, at most [`OCCLUSION_RAYS_PER_TICK`].
    ///
    /// Under the cap every voice is cast every tick. Over it, a tick casts from the first id past
    /// the last one cast, up to the cap or the highest id, and the tick after the highest id
    /// starts again from the lowest, so `n` voices are all refreshed within `ceil(n / cap)`
    /// ticks, in id order.
    pub fn pick(&mut self, audible: &[Voice]) -> Vec<Voice> {
        let Some(last) = audible.last() else { return Vec::new() };
        if audible.len() <= OCCLUSION_RAYS_PER_TICK {
            self.cursor = last.id().wrapping_add(1);
            return audible.to_vec();
        }
        let start = audible.iter().position(|voice| voice.id() >= self.cursor).unwrap_or(0);
        let picked: Vec<Voice> = audible[start..].iter().take(OCCLUSION_RAYS_PER_TICK).copied().collect();
        let reached_end = start + picked.len() == audible.len();
        self.cursor = match picked.last() {
            Some(voice) if !reached_end => voice.id().wrapping_add(1),
            _ => 0,
        };
        picked
    }

    /// Back to the first voice (a seed).
    pub fn reset(&mut self) {
        self.cursor = 0;
    }

    /// The id after the last voice cast (the save section keeps it).
    pub(crate) fn cursor(&self) -> u32 {
        self.cursor
    }

    /// A scheduler resuming after `cursor` (a restored save section).
    pub(crate) fn resume(cursor: u32) -> OcclusionScheduler {
        OcclusionScheduler { cursor }
    }
}
