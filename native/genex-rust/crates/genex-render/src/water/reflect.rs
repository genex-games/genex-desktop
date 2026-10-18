//! The lake's reflection (renderer pass 2 B.9 follow-up on B.3's water): where the water's
//! Fresnel share comes from, `shaders/water/water_reflect.wgsl` (`gx_water_reflection`).
//!
//! - **The screen** (desktop and web `high` and `ultra`, [`super::ReflectionSource::ScreenThenEnvironment`]):
//!   the SSR helper's march over the scene depth finds the reflected surface in *this* frame's
//!   screen, but the colour pyramid it reads is *last* frame's (TAA's output). The hit is
//!   reprojected into last frame's screen ([`GpuWaterReflect::reprojection`], [`reproject`]) and
//!   its radiance re-exposed by this frame's exposure over the pyramid's ([`WaterReflectFrame::radiance_scale`]),
//!   as B.9's trace does, so a pan does not drag the reflection across the lake and an exposure
//!   ramp does not pump it. The pyramid's mip is the roughness cone's at the ray's screen length
//!   ([`screen_mip`], B.9's `ssr_mip`), so a rough or rippled surface reads a filtered tap rather
//!   than one sparkling texel.
//! - **The environment** (everywhere the march misses, and always on phones: no SSR there): the
//!   reflection probes over the water, box-projected and blended as the forward pass blends them
//!   (`probes::blend`, `probes::parallax_direction`), the sky's layer filling what they leave
//!   ([`environment`] is the twin). Before this the lake reflected the sky layer alone, so a
//!   boathouse or a shore under a probe vanished from the water on every phone.
//!
//! - **The ripples' footprint** ([`ripple_weight`], [`ripple_roughness`]; `gx_water_surface`): a
//!   ripple finer than the pixel's footprint on the water can hold (half its wavelength, the
//!   Nyquist limit) is faded out of the normal and its slopes' variance added to the roughness
//!   (the idea of LEAN and Toksvig mapping), and the spread of the normal the pixel does hold is
//!   added too ([`specular_aa`]: the kernel of Tokuyoshi and Kaplanyan 2019 at the paper's values;
//!   no source copied), so a lake reflects a stable cone as wide as what its pixel's ripples turn the
//!   ray across, instead of whichever wall texel each jittered sample's ripple tilts it to: the
//!   sparkle TAA saw on rippled water (`tests/water_reflect.rs`, a brick wall's reflection over
//!   the eight jitter offsets).
//!
//! The probes reach the water as up to [`MAX_WATER_PROBES`] rows of a uniform ([`probes_for`]
//! picks the active ones whose influence covers the water rectangle), not the forward stage's
//! binned table: the water's group keeps its four sampled textures and no storage buffer (plan
//! section 2, D1).

use glam::{Mat4, Vec2, Vec3};

use super::WaterBody;
use crate::probes::GpuProbeRow;

/// The most reflection probes one water body blends.
pub const MAX_WATER_PROBES: usize = 4;

/// The water's reflection row (`WaterReflect` in shaders/water/water_reflect.wgsl, group 1
/// binding 6).
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, bytemuck::Pod, bytemuck::Zeroable)]
pub struct GpuWaterReflect {
    /// This frame's unjittered NDC to last frame's clip space (the colour pyramid's), column-major.
    pub reprojection: [f32; 16],
    /// x: the radiance scale (this frame's exposure over the pyramid's); yzw: 0.
    pub screen: [f32; 4],
    /// x: the probe rows held; yzw: 0.
    pub counts: [u32; 4],
    /// The probes over the water (`probes::GpuProbeRow`), the first `counts.x` of them.
    pub probes: [GpuProbeRow; MAX_WATER_PROBES],
}

impl GpuWaterReflect {
    /// A still camera at one exposure, no probes: the sky alone off screen.
    pub const NONE: GpuWaterReflect = GpuWaterReflect {
        reprojection: [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0],
        screen: [1.0, 0.0, 0.0, 0.0],
        counts: [0; 4],
        probes: [GpuProbeRow { min_blend: [0.0; 4], max_layer: [0.0; 4], capture_intensity: [0.0; 4] }; MAX_WATER_PROBES],
    };

    /// The row for `frame`.
    pub fn new(frame: &WaterReflectFrame<'_>) -> GpuWaterReflect {
        let picked = probes_for(frame.body, frame.probes);
        let mut probes = GpuWaterReflect::NONE.probes;
        for (slot, row) in probes.iter_mut().zip(&picked) {
            *slot = *row;
        }
        let reprojection = frame.prev_view_proj * frame.view_proj.inverse();
        let scale = if frame.radiance_scale.is_finite() && frame.radiance_scale > 0.0 { frame.radiance_scale } else { 1.0 };
        GpuWaterReflect { reprojection: reprojection.to_cols_array(), screen: [scale, 0.0, 0.0, 0.0], counts: [picked.len() as u32, 0, 0, 0], probes }
    }
}

impl Default for GpuWaterReflect {
    fn default() -> Self {
        GpuWaterReflect::NONE
    }
}

/// What one frame's reflection row is made of.
#[derive(Clone, Copy, Debug)]
pub struct WaterReflectFrame<'a> {
    /// The body reflecting.
    pub body: &'a WaterBody,
    /// This frame's unjittered view-projection.
    pub view_proj: Mat4,
    /// Last frame's unjittered view-projection, the colour pyramid's (this frame's after a reset).
    pub prev_view_proj: Mat4,
    /// This frame's exposure over the one the colour pyramid was written at (1 when equal).
    pub radiance_scale: f32,
    /// The frame's reflection probe rows (`probes::ProbeSchedule::rows`, any order).
    pub probes: &'a [GpuProbeRow],
}

/// The area over which `row`'s influence (its box grown by the fade distance) covers the water
/// rectangle of `body` at its level, m² (0: it does not reach the water).
pub fn coverage(body: &WaterBody, row: &GpuProbeRow) -> f32 {
    let blend = row.min_blend[3].max(0.0);
    let level = body.centre[1];
    if level < row.min_blend[1] - blend || level > row.max_layer[1] + blend {
        return 0.0;
    }
    let overlap = |axis: usize, centre: f32, half: f32| {
        let lo = (row.min_blend[axis] - blend).max(centre - half);
        let hi = (row.max_layer[axis] + blend).min(centre + half);
        (hi - lo).max(0.0)
    };
    overlap(0, body.centre[0], body.half_extent[0]) * overlap(2, body.centre[2], body.half_extent[1])
}

/// The probes the water blends: the active rows whose influence covers it, the
/// [`MAX_WATER_PROBES`] covering most (ties: the earlier row), in their given order.
pub fn probes_for(body: &WaterBody, rows: &[GpuProbeRow]) -> Vec<GpuProbeRow> {
    let mut covering: Vec<(usize, f32)> = rows.iter().enumerate().filter(|(_, row)| row.active()).map(|(i, row)| (i, coverage(body, row))).filter(|(_, area)| *area > 0.0).collect();
    covering.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
    covering.truncate(MAX_WATER_PROBES);
    covering.sort_by_key(|(i, _)| *i);
    covering.into_iter().map(|(i, _)| rows[i]).collect()
}

/// The CPU twin of `gx_water_environment`: the reflection along unit `dir` leaving water point
/// `p`, from `rows` (each read through `probe(layer, lookup)`) weighed and box-projected as the
/// forward pass does (`probes::blend`'s weights, the projection eased in with the weight), and
/// `sky(dir)` filling what they leave.
pub fn environment(rows: &[GpuProbeRow], p: [f32; 3], dir: [f32; 3], sky: impl Fn(Vec3) -> Vec3, probe: impl Fn(u32, Vec3) -> Vec3) -> Vec3 {
    let d = Vec3::from(dir);
    let (mut radiance, mut total) = (Vec3::ZERO, 0.0);
    for row in rows.iter().filter(|row| row.active()) {
        let weight = crate::probes::influence(row, p);
        if weight <= 0.0 {
            continue;
        }
        let lookup = d.lerp(Vec3::from(crate::probes::parallax_direction(row, p, dir)).normalize(), weight);
        radiance += probe(row.max_layer[3] as u32, lookup) * (weight * row.capture_intensity[3]);
        total += weight;
    }
    radiance / total.max(1.0) + sky(d) * (1.0 - total).max(0.0)
}

/// The CPU twin of `gx_water_reproject`: last frame's screen uv (y down) of this frame's screen
/// point `uv` at device depth `depth`.
pub fn reproject(reprojection: Mat4, uv: Vec2, depth: f32) -> Vec2 {
    let clip = reprojection * glam::Vec4::new(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, depth, 1.0);
    let ndc = clip.truncate().truncate() / clip.w;
    Vec2::new(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5)
}

/// The CPU twin of `gx_water_screen_mip`: the colour pyramid's mip a reflection of perceptual
/// `roughness` reads over a ray `ray_len` long on screen (uv units), the pyramid `size` texels at
/// mip 0 with `last` its last mip (B.9's `ssr_mip`, Godot 4.7.2's sphere fit, MIT).
pub fn screen_mip(roughness: f32, ray_len: f32, size: (u32, u32), last: f32) -> f32 {
    if roughness <= 0.001 {
        return 0.0;
    }
    let cone = roughness.min(0.999) * std::f32::consts::FRAC_PI_2;
    let a = 2.0 * libm::tanf(cone) * ray_len;
    let h = ray_len;
    let radius = (a * ((a * a + 4.0 * h * h).sqrt() - a)) / (4.0 * h).max(1e-8);
    let mip = libm::log2f(radius * size.0.max(size.1) as f32 / 16.0 + 1.0).clamp(0.0, last.max(0.0));
    mip * libm::powf((1.25 - ray_len).clamp(0.0, 1.0), 0.2)
}

/// The ripples' spatial frequencies, rad/m (`GX_WATER_RIPPLE_FREQS`); octave `i`'s slope
/// amplitude is `1 / (i + 1)` of the ripple strength.
pub const RIPPLE_FREQUENCIES: [f32; 4] = [1.7, 2.9, 4.3, 6.1];
/// The footprint, as shares of a ripple's wavelength, over which it fades out
/// (`GX_WATER_RIPPLE_FADE`): whole below the first, gone at the second (Nyquist).
pub const RIPPLE_FADE: (f32, f32) = (0.25, 0.5);

/// How much of a ripple of `frequency` (rad/m) a pixel whose footprint on the water is
/// `footprint` metres keeps (1: all of it; 0: finer than the pixel can hold).
pub fn ripple_weight(frequency: f32, footprint: f32) -> f32 {
    let x = ((footprint * frequency / std::f32::consts::TAU - RIPPLE_FADE.0) / (RIPPLE_FADE.1 - RIPPLE_FADE.0)).clamp(0.0, 1.0);
    1.0 - x * x * (3.0 - 2.0 * x)
}

/// The screen variance of the pixel's filter specular anti-aliasing assumes (`GX_WATER_SAA_VARIANCE`;
/// Tokuyoshi and Kaplanyan, "Improved Geometric Specular Antialiasing", 2019).
pub const SPECULAR_AA_VARIANCE: f32 = 0.25;
/// The most the normal's spread over a pixel adds to the GGX alpha squared (`GX_WATER_SAA_MAX`;
/// the paper's threshold).
pub const SPECULAR_AA_MAX: f32 = 0.18;

/// The CPU twin of `gx_water_surface`'s specular anti-aliasing: perceptual `roughness` with the
/// spread of the normal over the pixel (its screen derivatives `dn_dx`, `dn_dy`) added to its GGX
/// alpha squared.
pub fn specular_aa(roughness: f32, dn_dx: Vec3, dn_dy: Vec3) -> f32 {
    let kernel = (2.0 * SPECULAR_AA_VARIANCE * (dn_dx.length_squared() + dn_dy.length_squared())).min(SPECULAR_AA_MAX);
    let alpha = roughness * roughness;
    (alpha * alpha + kernel).min(1.0).sqrt().sqrt()
}

/// The CPU twin of `gx_water_surface`'s roughness before [`specular_aa`]: perceptual `roughness`
/// with the slope variance of the ripples (strength `ripple`) a `footprint`-metre pixel cannot hold
/// added to its GGX alpha squared.
pub fn ripple_roughness(roughness: f32, ripple: f32, footprint: f32) -> f32 {
    let lost: f32 = RIPPLE_FREQUENCIES
        .iter()
        .enumerate()
        .map(|(i, frequency)| {
            let weight = ripple_weight(*frequency, footprint);
            let amplitude = 1.0 / (i + 1) as f32;
            (1.0 - weight * weight) * amplitude * amplitude
        })
        .sum();
    let alpha = roughness * roughness;
    (alpha * alpha + lost * ripple * ripple * 0.5).min(1.0).sqrt().sqrt()
}

/// The sun glint's largest specular power (`GX_WATER_GLINT_POWER`): a still, smooth lake's.
pub const GLINT_POWER_MAX: f32 = 900.0;

/// The CPU twin of `gx_water_glint_power`: the sun glint's Blinn-Phong power for perceptual
/// `roughness` (`2 / alpha^2 - 2` with alpha its square), at most [`GLINT_POWER_MAX`], so the
/// ripples a pixel cannot hold widen the glint into a glitter path rather than flashing it.
pub fn glint_power(roughness: f32) -> f32 {
    let alpha = roughness * roughness;
    (2.0 / (alpha * alpha).max(1e-6) - 2.0).min(GLINT_POWER_MAX)
}
