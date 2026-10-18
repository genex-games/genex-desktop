//! Lake water (renderer pass 2 B.3): a flat water rectangle the renderer draws over the opaque
//! scene with its own pipeline. Where the bed under it (the scene's depth) is deep the water hides
//! it by Beer-Lambert absorption; on desktop and web `high` and `ultra` it refracts the scene
//! behind it and reflects the screen; elsewhere it blends over the scene and reflects the probes
//! and the sky. Shore foam covers the shallows. Declared with [`crate::Frame::water`].

use glam::{Vec2, Vec3};
use genex_render::water::{WaterBody, WaterMaterial};

/// The most a water's refraction may offset what it shows, a fraction of the screen.
pub const WATER_REFRACTION_MAX: f32 = 0.1;
/// The most a water's ripples may tilt its normal.
pub const WATER_RIPPLE_MAX: f32 = 1.0;
/// The widest shore foam, metres of water under the surface.
pub const WATER_FOAM_MAX: f32 = 5.0;
/// The strongest absorption per metre.
pub const WATER_ABSORPTION_MAX: f32 = 100.0;

/// A water rectangle at a level: its centre (y the water level) and half its size along x and z,
/// metres. Make it larger than the lake: the ground above the water level hides it, so the
/// shoreline is where the terrain meets the level, and the foam follows it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Water {
    /// The rectangle's centre; its y is the water level.
    pub centre: Vec3,
    /// Half its size along x and z.
    pub half_extent: Vec2,
    material: WaterMaterial,
}

impl Water {
    /// Whether the renderer draws a frame's water at `quality`: the HDR scene under TAA (desktop and
    /// web `high` and `ultra`). Elsewhere (an MSAA preset: `low`, `medium`, the phones' defaults) it
    /// draws none yet, so a game that wants its lake on every preset draws its own there, in a
    /// level-3 pass that returns early where this is true.
    pub fn drawn_at(quality: &genex_render::settings::Quality) -> bool {
        genex_render::water::drawn_at(quality)
    }

    /// A clear temperate lake over the rectangle: red gone within a few metres, blue-green under
    /// the surface, a little foam on the shore.
    pub fn lake(centre: Vec3, half_extent: Vec2) -> Water {
        Water { centre, half_extent, material: WaterMaterial::LAKE }
    }

    /// How fast it absorbs light per metre of water, linear rgb (fresh water loses red first).
    pub fn with_absorption(self, per_metre: [f32; 3]) -> Water {
        let absorption = per_metre.map(|a| held(a, WATER_ABSORPTION_MAX));
        Water { material: WaterMaterial { absorption, ..self.material }, ..self }
    }

    /// The colour the water body scatters back, a linear albedo (its green-blue body colour).
    pub fn with_scatter(self, albedo: [f32; 3]) -> Water {
        let scatter = albedo.map(|s| held(s, 1.0));
        Water { material: WaterMaterial { scatter, ..self.material }, ..self }
    }

    /// How wide the shore foam reaches, metres of water under the surface (0: none).
    pub fn with_foam(self, width: f32) -> Water {
        Water { material: WaterMaterial { foam_width: held(width, WATER_FOAM_MAX), ..self.material }, ..self }
    }

    /// How far the ripples tilt the surface (0: a mirror) and the reflection's perceptual
    /// roughness (0..1).
    pub fn with_ripple(self, strength: f32, roughness: f32) -> Water {
        let material = WaterMaterial { ripple: held(strength, WATER_RIPPLE_MAX), roughness: held(roughness, 1.0), ..self.material };
        Water { material, ..self }
    }

    /// The refraction's largest offset, a fraction of the screen (0: straight through).
    pub fn with_refraction(self, offset: f32) -> Water {
        Water { material: WaterMaterial { refraction: held(offset, WATER_REFRACTION_MAX), ..self.material }, ..self }
    }

    /// The renderer's water body, or None for a rectangle that cannot be drawn (a centre that is
    /// not finite, a half extent that is not a positive finite size).
    pub(crate) fn body(&self) -> Option<WaterBody> {
        let sized = self.half_extent.is_finite() && self.half_extent.min_element() > 0.0;
        if !(self.centre.is_finite() && sized) {
            return None;
        }
        Some(WaterBody { centre: self.centre.to_array(), half_extent: self.half_extent.to_array(), material: self.material })
    }
}

/// `value` held to 0..=`max` (not finite: 0).
fn held(value: f32, max: f32) -> f32 {
    if value.is_finite() { value.clamp(0.0, max) } else { 0.0 }
}
