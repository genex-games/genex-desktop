//! Characters on the facade: genex-anim's controller, re-exported (the runtime does not own it; a
//! world holds its characters and drives them in `on_update`, before the runtime's physics step).
//!
//! `Character::spawn` / `drive` / `ground_ray` / `remove` need the `physics` feature;
//! `Character::on_ground` / `drive_on` walk a height function (such as `terrain.height`) in any
//! build. [`CharacterNav::nav_config`] gives the navigation bake that matches the controller, and
//! a character's transform converts into a [`Transform`] for `frame.character`.

use genex_anim::math::Trs;

use crate::Transform;
use crate::nav::NavConfig;

pub use genex_anim::character::{
    CHARACTER_SKIN, Character, CharacterError, CharacterErrorCode, CharacterMotion, CharacterParams, CharacterStep, GroundHit, NavFit, TERMINAL_FALL_SPEED,
};
/// A tick of root motion (character space, +Z forward), as `CharacterMotion::Root` takes it.
pub use genex_anim::root_motion::RootMotion;

/// The navigation bake a character's controller can walk: `character.nav_config()`.
pub trait CharacterNav {
    /// A walker of the character's radius and height whose climb and slope are the controller's
    /// step height and max slope, so every path the bake finds is one the character can walk.
    fn nav_config(&self) -> NavConfig;
}

impl CharacterNav for Character {
    fn nav_config(&self) -> NavConfig {
        let fit = self.nav_fit();
        NavConfig::walker(fit.radius, fit.height).with_climb(fit.climb).with_slope(fit.slope_degrees)
    }
}

impl From<Trs> for Transform {
    /// A character's (or a joint's) transform, for drawing.
    fn from(trs: Trs) -> Transform {
        Transform { translation: trs.translation, rotation: trs.rotation, scale: trs.scale }
    }
}
