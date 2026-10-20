//! Occlusion: an [`Occluder`] the facade implements over physics colliders, and the round-robin
//! scheduler that casts at most [`OCCLUSION_RAYS_PER_TICK`] rays a tick. Bodies are AU-3's.

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
    /// The id after the last voice cast.
    cursor: u32,
}

impl OcclusionScheduler {
    /// The voices (sorted by id) to cast for this tick, at most [`OCCLUSION_RAYS_PER_TICK`].
    pub fn pick(&mut self, audible: &[Voice]) -> Vec<Voice> {
        let _ = (self.cursor, audible, OCCLUSION_RAYS_PER_TICK);
        Vec::new()
    }

    /// Back to the first voice (a seed).
    pub fn reset(&mut self) {
        self.cursor = 0;
    }
}
