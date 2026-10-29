//! Which look features a frame draws (`state().__render.look.features`, `LookFeature` in
//! `src/shared/render-look.ts`): each one on where the quality draws it and the look and the frame
//! ask for it. The harness compares rounds by these, so a round that turns volumetric fog off to
//! get a check through is told so instead of passing (plan 2, Track B: quality presets own
//! features, checks never remove them).

use crate::post::motion_blur::MotionBlurTier;
use crate::settings::{ExposureMode, Look, Quality, RenderFeature};

/// A look feature, by its wire spelling in `__render.look.features`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum LookFeature {
    /// The fog as a lit volume: the sun's shadows carve shafts in it, local lights glow in it.
    VolumetricFog,
    /// Any fog (the volume or the plain height fog).
    Fog,
    /// The sun's shadows.
    Shadows,
    /// A spot light's shadow map.
    SpotShadows,
    /// A point light's cube of shadow maps.
    PointShadows,
    /// Screen-space contact shadows.
    ContactShadows,
    /// Ambient occlusion.
    Ao,
    /// Screen-space global illumination (AO's bitmask with the bounce).
    Ssgi,
    /// Screen-space reflections.
    Ssr,
    /// Bloom.
    Bloom,
    /// Temporal anti-aliasing.
    Taa,
    /// Image-based lighting from the environment.
    Ibl,
    /// Local exposure.
    LocalExposure,
    /// Auto exposure.
    AutoExposure,
    /// Depth of field.
    DepthOfField,
    /// Motion blur.
    MotionBlur,
}

impl LookFeature {
    /// Every look feature, in the contract's order.
    pub const ALL: [LookFeature; 16] = [
        LookFeature::VolumetricFog,
        LookFeature::Fog,
        LookFeature::Shadows,
        LookFeature::SpotShadows,
        LookFeature::PointShadows,
        LookFeature::ContactShadows,
        LookFeature::Ao,
        LookFeature::Ssgi,
        LookFeature::Ssr,
        LookFeature::Bloom,
        LookFeature::Taa,
        LookFeature::Ibl,
        LookFeature::LocalExposure,
        LookFeature::AutoExposure,
        LookFeature::DepthOfField,
        LookFeature::MotionBlur,
    ];

    /// The wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            LookFeature::VolumetricFog => "volumetricFog",
            LookFeature::Fog => "fog",
            LookFeature::Shadows => "shadows",
            LookFeature::SpotShadows => "spotShadows",
            LookFeature::PointShadows => "pointShadows",
            LookFeature::ContactShadows => "contactShadows",
            LookFeature::Ao => "ao",
            LookFeature::Ssgi => "ssgi",
            LookFeature::Ssr => "ssr",
            LookFeature::Bloom => "bloom",
            LookFeature::Taa => "taa",
            LookFeature::Ibl => "ibl",
            LookFeature::LocalExposure => "localExposure",
            LookFeature::AutoExposure => "autoExposure",
            LookFeature::DepthOfField => "depthOfField",
            LookFeature::MotionBlur => "motionBlur",
        }
    }
}

/// What the frame's own content asks for, beside its quality and look.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FrameAsks {
    /// The scene is HDR (the post chain runs).
    pub hdr: bool,
    /// A sun casts shadows.
    pub sun: bool,
    /// A spot light asks for a shadow.
    pub shadowed_spot: bool,
    /// A point light asks for a shadow.
    pub shadowed_point: bool,
    /// The environment (a sky or a map) lights the scene.
    pub environment_lights: bool,
}

/// Each look feature and whether a frame of `quality` and `look` with `asks` draws it.
pub fn drawn(quality: &Quality, look: &Look, asks: FrameAsks) -> [(LookFeature, bool); 16] {
    LookFeature::ALL.map(|feature| (feature, draws(feature, quality, look, asks)))
}

fn draws(feature: LookFeature, quality: &Quality, look: &Look, asks: FrameAsks) -> bool {
    let ao = quality.feature(RenderFeature::Ao) && look.ao_intensity > 0.0;
    let sun_shadows = quality.shadows.enabled && asks.sun;
    let post = asks.hdr;
    match feature {
        LookFeature::VolumetricFog => crate::froxel::runs(&look.fog, quality).is_some(),
        LookFeature::Fog => quality.fog && look.fog.is_on(),
        LookFeature::Shadows => sun_shadows,
        LookFeature::SpotShadows => quality.lights.shadowed_spots > 0 && asks.shadowed_spot,
        LookFeature::PointShadows => quality.lights.shadowed_points > 0 && asks.shadowed_point,
        LookFeature::ContactShadows => crate::post::contact_shadow::runs(quality, sun_shadows),
        LookFeature::Ao => ao,
        LookFeature::Ssgi => ao && quality.ao_method.gi(),
        LookFeature::Ssr => crate::ssr::frame_ssr(quality, post),
        LookFeature::Bloom => post && quality.bloom.enabled && look.bloom_intensity > 0.0,
        LookFeature::Taa => quality.feature(RenderFeature::Taa),
        LookFeature::Ibl => quality.environment.ibl && asks.environment_lights,
        LookFeature::LocalExposure => post && quality.local_exposure && look.local_exposure.is_on(),
        LookFeature::AutoExposure => post && quality.exposure && look.exposure == ExposureMode::Auto,
        LookFeature::DepthOfField => post && look.depth_of_field.enabled,
        LookFeature::MotionBlur => post && look.motion_blur.enabled && quality.motion_blur != MotionBlurTier::Off,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::device_class::{DeviceClass, FormFactor, PerformanceTier};
    use crate::presets::preset_quality;
    use crate::settings::{Fog, QualityPreset};

    fn preset(preset: QualityPreset) -> Quality {
        preset_quality(preset, DeviceClass::new(FormFactor::Desktop, PerformanceTier::High))
    }

    const ASKS: FrameAsks = FrameAsks { hdr: true, sun: true, shadowed_spot: true, shadowed_point: true, environment_lights: true };

    fn on(quality: &Quality, look: &Look, asks: FrameAsks) -> Vec<&'static str> {
        drawn(quality, look, asks).into_iter().filter(|(_, on)| *on).map(|(feature, _)| feature.wire()).collect()
    }

    #[test]
    fn every_feature_has_its_own_wire_spelling() {
        let mut wires: Vec<_> = LookFeature::ALL.iter().map(|feature| feature.wire()).collect();
        wires.sort_unstable();
        wires.dedup();
        assert_eq!(wires.len(), LookFeature::ALL.len());
    }

    #[test]
    fn a_foggy_ultra_frame_draws_the_volume_and_turning_it_off_shows() {
        let quality = preset(QualityPreset::Ultra);
        let foggy = Look::default().with_fog(Fog::default().with_density(0.05));
        let drawn = on(&quality, &foggy, ASKS);
        for feature in ["volumetricFog", "fog", "shadows", "ao", "ssgi", "taa", "ibl", "autoExposure"] {
            assert!(drawn.contains(&feature), "{feature} missing from {drawn:?}");
        }
        let flat = on(&quality, &foggy.with_fog(Fog::default().with_density(0.05).with_volumetric(false)), ASKS);
        assert!(flat.contains(&"fog") && !flat.contains(&"volumetricFog"), "{flat:?}");
        let clear = on(&quality, &Look::default(), ASKS);
        assert!(!clear.contains(&"fog") && !clear.contains(&"volumetricFog"), "{clear:?}");
    }

    #[test]
    fn a_feature_the_preset_does_not_draw_or_the_frame_does_not_ask_for_stays_off() {
        let foggy = Look::default().with_fog(Fog::default().with_density(0.05));
        let low = on(&preset(QualityPreset::Low), &foggy, ASKS);
        assert!(low.contains(&"fog") && !low.contains(&"volumetricFog") && !low.contains(&"ssgi"), "{low:?}");
        let unlit = on(&preset(QualityPreset::Ultra), &foggy, FrameAsks { hdr: true, ..FrameAsks::default() });
        for feature in ["shadows", "spotShadows", "pointShadows", "contactShadows", "ibl"] {
            assert!(!unlit.contains(&feature), "{feature} drawn with nothing asking: {unlit:?}");
        }
    }
}
