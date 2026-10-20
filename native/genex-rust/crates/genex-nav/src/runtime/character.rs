//! Characters: bodies agents avoid that the archipelago does not move (the player, a vehicle).
//! The facade calls them `NavBody`, so the name never meets ANIM's `Character`.
//!
//! Ported from landmass 0.9.3 `src/character.rs` (MIT OR Apache-2.0, used under Apache 2.0).
//! Changed: the id is a [`crate::arena`] key instead of a slotmap key.

use glam::Vec3;

use super::coords::CoordinateSystem;

crate::arena_key! {
    /// The id of a [`Character`].
    pub struct CharacterId;
}

/// A non-agent character: agents avoid it; it takes no share of the avoidance.
pub struct Character<CS: CoordinateSystem> {
    /// Where it stands.
    pub position: CS::Coordinate,
    /// How it moves.
    pub velocity: CS::Coordinate,
    /// Its radius.
    pub radius: f32,
}

impl<CS: CoordinateSystem> Default for Character<CS> {
    fn default() -> Self {
        Self { position: CS::from_landmass(&Vec3::ZERO), velocity: CS::from_landmass(&Vec3::ZERO), radius: 0.0 }
    }
}

impl<CS: CoordinateSystem<Coordinate: core::fmt::Debug>> core::fmt::Debug for Character<CS> {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("Character").field("position", &self.position).field("velocity", &self.velocity).field("radius", &self.radius).finish()
    }
}
