//! The physical sky (plan §2.2 nodes 11 and 13; RQ2): Hillaire's model ("A Scalable and
//! Production Ready Sky and Atmosphere Rendering Technique", 2020) on every preset, with Earth's
//! atmosphere. Three LUTs in compute (`shaders/sky/`, `rgba16float` write-only storage, sampled
//! afterwards):
//! - transmittance to the top of the atmosphere by height and zenith angle ([`TRANSMITTANCE_LUT`]);
//! - multiple scattering by height and sun zenith angle ([`MULTISCATTER_LUT`]²);
//! - the sky-view LUT: the sky's radiance around the camera by latitude and azimuth from the sun
//!   at the preset's size, the lit ground included below the horizon, the sun disk excluded.
//!
//! The first two depend on the atmosphere alone and are refreshed when it changes; the sky-view
//! LUT follows the sun and the camera on the preset's frame-indexed cadence ([`lut_due`]: every
//! frame on high, every 8th on low), and all three are refreshed whenever a settled capture asks.
//! A LUT is a pure function of its inputs, so a refresh whose inputs are unchanged is skipped.
//!
//! The background is drawn inside the world pass at the far plane (node 13, `sky_draw.wgsl`): the
//! sky-view LUT plus the sun disk with its limb darkening, times the frame's pre-exposure (the
//! GPU's adapted exposure under auto exposure, copied over it each frame). Only the background
//! shows the disk: [`SkyState::encode_cube`] (the sky into the environment cube, on the IBL bake's
//! schedule) reads the LUT alone, because the analytic sun lights the scene directly, with
//! shadows. Fog (RQ4.3) hooks into the background's shader. Under an HDR map node 13 draws the
//! map instead (`ibl/backdrop.wgsl`); either backdrop follows the `sky` switch.
//!
//! The scene's sun is the light outside the atmosphere under the sky: the LUTs and the disk take
//! it as given and the surfaces get it through the atmosphere ([`sun_transmittance`], the
//! transmittance LUT's integral on the CPU), so a low sun reddens the ground as it reddens the
//! sky. When IBL lights a sky with its backdrop switched off, the LUTs are still computed for the
//! bake.

use crate::compile::Compiled;
use bytemuck::bytes_of;
use wgpu::{
    BindGroup, BindGroupLayout, BindGroupLayoutEntry, BindingType, Buffer, BufferUsages, CommandEncoder, ComputePipeline, Device,
    Queue, RenderPass, RenderPipeline, Sampler, ShaderModule, ShaderStages, Texture, TextureFormat, TextureUsages, TextureView,
};

use crate::abi::GxFrameV2;
use crate::error::RenderError;
use crate::graph::{EnvironmentFrame, FrameEncoder, PassCounters};
use crate::layout::GpuSkyAtmosphere;
use crate::settings::{Environment, EnvironmentQuality, HdriEnvironment, SkyParams};
use crate::target_pool::TargetDesc;

/// Whether the sky encodes work in this build (its LUTs in node 11, its background in node 13,
/// and the `sky` switch).
pub const LANDED: bool = true;
/// The transmittance LUT's size (view height × zenith angle).
pub const TRANSMITTANCE_LUT: (u32, u32) = (256, 64);
/// The multiple-scattering LUT's side.
pub const MULTISCATTER_LUT: u32 = 32;
/// Every sky LUT's format.
pub const LUT_FORMAT: TextureFormat = TextureFormat::Rgba16Float;
/// The environment cube's format [`SkyState::encode_cube`] writes (`ibl::ENV_CUBE_FORMAT`).
pub const CUBE_FORMAT: TextureFormat = TextureFormat::Rgba16Float;

/// Earth's radius, in km.
pub const EARTH_RADIUS_KM: f32 = 6360.0;
/// The atmosphere's top, as a radius in km.
pub const ATMOSPHERE_TOP_KM: f32 = 6460.0;
/// Rayleigh scattering at sea level, per km (rgb).
const RAYLEIGH_SCATTERING: [f32; 3] = [5.802e-3, 13.558e-3, 33.1e-3];
/// Rayleigh density falloff: 1 / 8 km.
const RAYLEIGH_FALLOFF: f32 = 1.0 / 8.0;
/// Mie scattering and extinction at sea level, per km.
const MIE_SCATTERING: f32 = 3.996e-3;
const MIE_EXTINCTION: f32 = 4.440e-3;
/// The Mie phase function's asymmetry.
const MIE_G: f32 = 0.8;
/// Mie density falloff: 1 / 1.2 km.
const MIE_FALLOFF: f32 = 1.0 / 1.2;
/// Ozone absorption at the layer's peak, per km (rgb), and the layer's centre and width in km.
const OZONE_ABSORPTION: [f32; 3] = [0.650e-3, 1.881e-3, 0.085e-3];
const OZONE_CENTRE_KM: f32 = 25.0;
const OZONE_WIDTH_KM: f32 = 30.0;
/// The multiple-scattering contribution's factor (1: physical).
const MULTISCATTER_FACTOR: f32 = 1.0;
/// The thinnest atmosphere and the smallest planet a medium may describe, in km (the LUTs'
/// parameterisation needs a shell), and the largest planet.
const MEDIUM_THICKNESS_MIN_KM: f32 = 1.0;
const MEDIUM_RADIUS_MIN_KM: f32 = 10.0;
const MEDIUM_RADIUS_MAX_KM: f32 = 100_000.0;
/// The largest scattering or absorption coefficient a medium may take, per km.
const MEDIUM_COEFFICIENT_MAX: f32 = 10.0;
/// The largest Mie asymmetry (Cornette-Shanks is singular at 1).
const MEDIUM_ASYMMETRY_MAX: f32 = 0.99;

/// The air of the physical sky (renderer pass 2 B.2, after Bevy 0.20's `ScatteringMedium`, MIT OR
/// Apache-2.0, as values in Hillaire's three terms instead of baked density and scattering LUTs):
/// the planet, a Rayleigh-like term with its own colour, a Mie-like term (haze or dust) with a
/// forward lobe, and an absorbing layer (ozone, or coloured dust), all per kilometre at the
/// ground with exponential or tent profiles. [`SkyMedium::EARTH`] is the default; [`SkyMedium::mars`]
/// is a thin dusty sky. The LUT kernels read every value from the atmosphere row, so a medium is
/// data, not code.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SkyMedium {
    /// The planet's radius, in km.
    pub planet_radius_km: f32,
    /// The atmosphere's thickness above the ground, in km.
    pub atmosphere_height_km: f32,
    /// The Rayleigh-like term's scattering at the ground, per km (rgb).
    pub rayleigh_scattering: [f32; 3],
    /// Its scale height (density `exp(-h / H)`), in km.
    pub rayleigh_scale_height_km: f32,
    /// The Mie-like term's scattering at the ground, per km.
    pub mie_scattering: f32,
    /// Its extinction at the ground (scattering plus absorption), per km.
    pub mie_extinction: f32,
    /// Its phase function's asymmetry `g` (Cornette-Shanks), `0..1`.
    pub mie_asymmetry: f32,
    /// Its scale height, in km.
    pub mie_scale_height_km: f32,
    /// The absorbing layer's absorption at its peak, per km (rgb).
    pub absorption: [f32; 3],
    /// The height of the layer's peak, in km.
    pub absorption_centre_km: f32,
    /// The layer's width (a tent falling to 0 half of it either side of the peak), in km.
    pub absorption_width_km: f32,
}

impl SkyMedium {
    /// Earth's atmosphere (Hillaire 2020's constants): the default.
    pub const EARTH: SkyMedium = SkyMedium {
        planet_radius_km: EARTH_RADIUS_KM,
        atmosphere_height_km: ATMOSPHERE_TOP_KM - EARTH_RADIUS_KM,
        rayleigh_scattering: RAYLEIGH_SCATTERING,
        rayleigh_scale_height_km: 8.0,
        mie_scattering: MIE_SCATTERING,
        mie_extinction: MIE_EXTINCTION,
        mie_asymmetry: MIE_G,
        mie_scale_height_km: 1.2,
        absorption: OZONE_ABSORPTION,
        absorption_centre_km: OZONE_CENTRE_KM,
        absorption_width_km: OZONE_WIDTH_KM,
    };

    /// Earth's atmosphere.
    pub fn earth() -> SkyMedium {
        SkyMedium::EARTH
    }

    /// A Mars-like sky: a thin CO2 atmosphere (Rayleigh about a hundredth of Earth's) over a smaller
    /// planet, lit mostly by grey forward-scattering dust in a deep layer whose blue-absorbing tent
    /// turns the noon sky butterscotch and leaves a cooler glow around a low sun. Values chosen to
    /// look the part from published descriptions, not fitted to measurements.
    pub fn mars() -> SkyMedium {
        SkyMedium {
            planet_radius_km: 3389.5,
            atmosphere_height_km: 80.0,
            rayleigh_scattering: [0.0198e-3, 0.0136e-3, 0.0057e-3],
            rayleigh_scale_height_km: 11.1,
            mie_scattering: 0.030,
            mie_extinction: 0.033,
            mie_asymmetry: 0.65,
            mie_scale_height_km: 11.0,
            absorption: [0.0015, 0.0055, 0.0125],
            absorption_centre_km: 0.0,
            absorption_width_km: 40.0,
        }
    }

    /// The medium with every value held to what the LUTs can take: finite, coefficients
    /// `0..=10` per km, Mie extinction at least its scattering, `g` in `0..=0.99`, scale heights and
    /// the atmosphere at least 1 km thick, the planet 10 to 100,000 km in radius. Anything not a
    /// number takes Earth's value.
    pub fn validated(self) -> SkyMedium {
        let earth = SkyMedium::EARTH;
        let clamp = |value: f32, fallback: f32, low: f32, high: f32| if value.is_finite() { value.clamp(low, high) } else { fallback };
        let coefficient = |value: f32, fallback: f32| clamp(value, fallback, 0.0, MEDIUM_COEFFICIENT_MAX);
        let mie_scattering = coefficient(self.mie_scattering, earth.mie_scattering);
        SkyMedium {
            planet_radius_km: clamp(self.planet_radius_km, earth.planet_radius_km, MEDIUM_RADIUS_MIN_KM, MEDIUM_RADIUS_MAX_KM),
            atmosphere_height_km: clamp(self.atmosphere_height_km, earth.atmosphere_height_km, MEDIUM_THICKNESS_MIN_KM, MEDIUM_RADIUS_MAX_KM),
            rayleigh_scattering: [0, 1, 2].map(|c| coefficient(self.rayleigh_scattering[c], earth.rayleigh_scattering[c])),
            rayleigh_scale_height_km: clamp(self.rayleigh_scale_height_km, earth.rayleigh_scale_height_km, MEDIUM_THICKNESS_MIN_KM, MEDIUM_RADIUS_MAX_KM),
            mie_scattering,
            mie_extinction: coefficient(self.mie_extinction, earth.mie_extinction).max(mie_scattering),
            mie_asymmetry: clamp(self.mie_asymmetry, earth.mie_asymmetry, 0.0, MEDIUM_ASYMMETRY_MAX),
            mie_scale_height_km: clamp(self.mie_scale_height_km, earth.mie_scale_height_km, MEDIUM_THICKNESS_MIN_KM, MEDIUM_RADIUS_MAX_KM),
            absorption: [0, 1, 2].map(|c| coefficient(self.absorption[c], earth.absorption[c])),
            absorption_centre_km: clamp(self.absorption_centre_km, earth.absorption_centre_km, 0.0, MEDIUM_RADIUS_MAX_KM),
            absorption_width_km: clamp(self.absorption_width_km, earth.absorption_width_km, MEDIUM_THICKNESS_MIN_KM, MEDIUM_RADIUS_MAX_KM),
        }
    }

    /// The medium on a planet `radius_km` in radius under an atmosphere `height_km` thick.
    pub fn with_planet(mut self, radius_km: f32, height_km: f32) -> SkyMedium {
        (self.planet_radius_km, self.atmosphere_height_km) = (radius_km, height_km);
        self.validated()
    }

    /// The medium with a Rayleigh-like term of `scattering` per km (rgb) at the ground, thinning
    /// over `scale_height_km`.
    pub fn with_rayleigh(mut self, scattering: [f32; 3], scale_height_km: f32) -> SkyMedium {
        (self.rayleigh_scattering, self.rayleigh_scale_height_km) = (scattering, scale_height_km);
        self.validated()
    }

    /// The medium with a Mie-like term (haze, dust) of `scattering` and `extinction` per km at the
    /// ground, phase asymmetry `asymmetry`, thinning over `scale_height_km`.
    pub fn with_mie(mut self, scattering: f32, extinction: f32, asymmetry: f32, scale_height_km: f32) -> SkyMedium {
        (self.mie_scattering, self.mie_extinction, self.mie_asymmetry, self.mie_scale_height_km) = (scattering, extinction, asymmetry, scale_height_km);
        self.validated()
    }

    /// The medium with an absorbing layer of `absorption` per km (rgb) at its peak `centre_km` up,
    /// `width_km` wide.
    pub fn with_absorption(mut self, absorption: [f32; 3], centre_km: f32, width_km: f32) -> SkyMedium {
        (self.absorption, self.absorption_centre_km, self.absorption_width_km) = (absorption, centre_km, width_km);
        self.validated()
    }

    /// The atmosphere's top, as a radius in km.
    pub fn top_km(&self) -> f32 {
        self.planet_radius_km + self.atmosphere_height_km
    }

    /// Rayleigh's density falloff (1 / scale height), Earth's bit for bit.
    fn rayleigh_falloff(&self) -> f32 {
        if *self == SkyMedium::EARTH { RAYLEIGH_FALLOFF } else { 1.0 / self.rayleigh_scale_height_km }
    }

    /// Mie's density falloff (1 / scale height), Earth's bit for bit.
    fn mie_falloff(&self) -> f32 {
        if *self == SkyMedium::EARTH { MIE_FALLOFF } else { 1.0 / self.mie_scale_height_km }
    }
}

impl Default for SkyMedium {
    fn default() -> Self {
        SkyMedium::EARTH
    }
}
/// Scene units (metres) per kilometre: the camera's height enters the atmosphere in km.
const SCENE_UNITS_PER_KM: f32 = 1000.0;

/// Texels per side of a transmittance, sky-view or cube workgroup (`@workgroup_size(8, 8, 1)`).
const WORKGROUP_SIDE: u32 = 8;
/// Faces of a cube.
const CUBE_FACES: u32 = 6;
/// The scene depth format the background's pipeline draws against (the world pass's).
const DEPTH_FORMAT: TextureFormat = crate::renderer::DEPTH_FORMAT;

/// Pool labels of the sky's targets.
const TRANSMITTANCE_LABEL: &str = "sky transmittance";
const MULTISCATTER_LABEL: &str = "sky multiscatter";
const SKY_VIEW_LABEL: &str = "sky view";
/// The moonlit sky-view LUT's label (B.2: made the first night a moon gives light, outside the
/// pool, the sky-view LUT's size).
const MOON_VIEW_LABEL: &str = "sky moon view";

/// Whether the sky LUTs refresh at `frame_index` on a `cadence` (every that many frames; frame 0
/// of a history always does, so a reset or a capture starts from fresh LUTs).
pub const fn lut_due(frame_index: u64, cadence: u8) -> bool {
    let every = if cadence == 0 { 1 } else { cadence as u64 };
    frame_index.is_multiple_of(every)
}

/// The camera's height above the ground in km, from its world height in scene units (metres);
/// below the ground (or not a number) reads as the ground.
pub fn camera_height_km(camera_y: f32) -> f32 {
    (camera_y / SCENE_UNITS_PER_KM).max(0.0)
}

/// Midpoint samples along the path to the top of the atmosphere (`SKY_TRANSMITTANCE_STEPS` in
/// `transmittance.wgsl`).
const TRANSMITTANCE_STEPS: u32 = 40;

/// Extinction per km at `height` km above the ground in `medium` (`sky_extinction`).
fn extinction(medium: &SkyMedium, height: f32) -> [f32; 3] {
    let rayleigh = libm::expf(-height * medium.rayleigh_falloff());
    let mie = medium.mie_extinction * libm::expf(-height * medium.mie_falloff());
    let layer = (1.0 - (height - medium.absorption_centre_km).abs() / (0.5 * medium.absorption_width_km)).max(0.0);
    [0, 1, 2].map(|c| medium.rayleigh_scattering[c] * rayleigh + mie + medium.absorption[c] * layer)
}

/// The sun's light that reaches a camera `camera_height_km` above the ground, as a fraction per
/// channel of the light outside the atmosphere, for a sun towards unit `sun_dir` with a disk
/// `angular_radius` radians wide: Earth's atmosphere's transmittance along the path to its top (the
/// transmittance LUT's integral, here exactly on the CPU), times the part of the disk above the
/// planet's horizon (so a setting sun fades instead of switching off). What the renderer
/// multiplies the scene's sun by under the sky ([`sun_transmittance_in`] for another medium).
pub fn sun_transmittance(camera_height_km: f32, sun_dir: [f32; 3], angular_radius: f32) -> [f32; 3] {
    sun_transmittance_in(&SkyMedium::EARTH, camera_height_km, sun_dir, angular_radius)
}

/// [`sun_transmittance`] through `medium` (renderer pass 2 B.2): also the moon's light on its way
/// down ([`crate::night_sky::ground_light`]).
pub fn sun_transmittance_in(medium: &SkyMedium, camera_height_km: f32, sun_dir: [f32; 3], angular_radius: f32) -> [f32; 3] {
    let length = libm::sqrtf(sun_dir.iter().map(|c| c * c).sum());
    if !length.is_finite() || length <= 0.0 {
        return [1.0; 3];
    }
    let mu = (sun_dir[1] / length).clamp(-1.0, 1.0);
    let (bottom, top) = (medium.planet_radius_km, medium.top_km());
    let height = camera_height_km.clamp(0.0, top - bottom);
    let r = bottom + height;
    // The disk above the horizon: the horizon's elevation is -acos(R / r) below the camera.
    let horizon = -libm::acosf((bottom / r).min(1.0));
    let elevation = libm::asinf(mu);
    let radius = angular_radius.max(1e-4);
    let visible = ((elevation - horizon + radius) / (2.0 * radius)).clamp(0.0, 1.0);
    if visible <= 0.0 {
        return [0.0; 3];
    }
    // Along the ray to the top of the atmosphere: for a disk partly below the horizon, the light
    // that reaches the camera grazes it.
    let ray_mu = mu.max(libm::sinf(horizon));
    let discriminant = (top - r) * (top + r) + r * r * ray_mu * ray_mu;
    let distance = (-r * ray_mu + libm::sqrtf(discriminant.max(0.0))).max(0.0);
    let step = distance / TRANSMITTANCE_STEPS as f32;
    let mut depth = [0.0_f32; 3];
    for i in 0..TRANSMITTANCE_STEPS {
        let t = (i as f32 + 0.5) * step;
        let radius = libm::sqrtf(r * r + t * t + 2.0 * r * ray_mu * t);
        let sigma = extinction(medium, (radius - bottom).max(0.0));
        for c in 0..3 {
            depth[c] += sigma[c] * step;
        }
    }
    let smooth = visible * visible * (3.0 - 2.0 * visible);
    depth.map(|d| libm::expf(-d) * smooth)
}

/// One of the sky's LUTs.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SkyLut {
    /// Transmittance to the top of the atmosphere ([`TRANSMITTANCE_LUT`]).
    Transmittance,
    /// Multiple scattering ([`MULTISCATTER_LUT`]²).
    Multiscatter,
    /// The sky's radiance around the camera (the preset's size).
    SkyView,
}

/// What the sky's draw needs to know about one frame beyond the atmosphere.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct SkyFrame {
    /// Unit direction towards the sun.
    pub sun_dir: [f32; 3],
    /// The sun's illuminance (linear rgb, scene units).
    pub sun_illuminance: [f32; 3],
    /// The camera's height above the ground, in km.
    pub camera_height_km: f32,
    /// The frame index the LUT cadence keys to.
    pub frame_index: u64,
}

/// One refresh of the sky's LUTs ([`SkyState::encode_luts`]).
#[non_exhaustive]
#[derive(Clone, Debug)]
pub struct LutRefresh<'a> {
    /// The game's sky.
    pub sky: &'a SkyParams,
    /// The quality's sky knobs (the sky-view size and cadence).
    pub quality: &'a EnvironmentQuality,
    /// The sun, the camera and the frame index.
    pub frame: SkyFrame,
    /// Refresh whatever moved even off the cadence (a settled capture).
    pub force: bool,
    /// Timestamps around the LUTs' compute pass (cost rows).
    pub timestamp_writes: Option<wgpu::ComputePassTimestampWrites<'a>>,
}

impl<'a> LutRefresh<'a> {
    /// A refresh on the cadence, untimed.
    pub fn new(sky: &'a SkyParams, quality: &'a EnvironmentQuality, frame: SkyFrame) -> LutRefresh<'a> {
        LutRefresh { sky, quality, frame, force: false, timestamp_writes: None }
    }

    /// The refresh, off the cadence when `force`.
    pub fn forced(mut self, force: bool) -> LutRefresh<'a> {
        self.force = force;
        self
    }

    /// The refresh, its pass timestamped by `writes`.
    pub fn timed(mut self, writes: wgpu::ComputePassTimestampWrites<'a>) -> LutRefresh<'a> {
        self.timestamp_writes = Some(writes);
        self
    }
}

/// The atmosphere of `sky` (its medium, [`SkyMedium::validated`]) for one frame, at the LUT sizes
/// of `quality`.
pub fn atmosphere(sky: &SkyParams, quality: &EnvironmentQuality, frame: &SkyFrame) -> GpuSkyAtmosphere {
    let medium = sky.medium.validated();
    let [sx, sy, sz] = frame.sun_dir;
    let [ir, ig, ib] = frame.sun_illuminance;
    let [ar, ag, ab] = sky.ground_albedo;
    let [rr, rg, rb] = medium.rayleigh_scattering;
    let [or, og, ob] = medium.absorption;
    let aerial = if quality.aerial_perspective { 32 } else { 0 };
    GpuSkyAtmosphere {
        sun_dir: [sx, sy, sz, sky.sun_angular_radius],
        sun_illuminance: [ir, ig, ib, sky.intensity],
        ground_albedo: [ar, ag, ab, frame.camera_height_km.max(0.0)],
        radii: [medium.planet_radius_km, medium.top_km(), medium.absorption_centre_km, medium.absorption_width_km],
        rayleigh: [rr, rg, rb, medium.rayleigh_falloff()],
        mie: [medium.mie_scattering, medium.mie_extinction, medium.mie_asymmetry, medium.mie_falloff()],
        ozone: [or, og, ob, MULTISCATTER_FACTOR],
        luts: [TRANSMITTANCE_LUT.0, TRANSMITTANCE_LUT.1, quality.sky_lut.0, quality.sky_lut.1],
        // The frame index's low 32 bits: its residue modulo every power-of-two cadence is kept.
        params: [MULTISCATTER_LUT, aerial, (frame.frame_index & u64::from(u32::MAX)) as u32, 0],
    }
}

/// The sky-view kernel's atmosphere row for the moonlit sky (B.2): `atmosphere` with the moon of
/// `sky` as its light, the moon's light outside the atmosphere
/// ([`crate::night_sky::moon_light`]) for `frame`'s sun.
fn moon_atmosphere(atmosphere: &GpuSkyAtmosphere, sky: &SkyParams, frame: &SkyFrame) -> GpuSkyAtmosphere {
    let Some(moon) = sky.moon.as_ref() else { return *atmosphere };
    let [x, y, z] = moon.direction;
    let [r, g, b] = crate::night_sky::moon_light(moon, frame.sun_dir, frame.sun_illuminance);
    GpuSkyAtmosphere { sun_dir: [x, y, z, moon.angular_radius], sun_illuminance: [r, g, b, atmosphere.sun_illuminance[3]], ..*atmosphere }
}

/// What the sky-view LUT is a function of: everything but the frame index.
fn view_key(atmosphere: &GpuSkyAtmosphere) -> GpuSkyAtmosphere {
    let mut key = *atmosphere;
    key.params[2] = 0;
    key
}

/// What the transmittance and multiple-scattering LUTs are a function of: the atmosphere and the
/// ground, not the sun, the camera or the sky-view size.
fn static_key(atmosphere: &GpuSkyAtmosphere) -> GpuSkyAtmosphere {
    let mut key = view_key(atmosphere);
    key.sun_dir = [0.0; 4];
    key.sun_illuminance = [0.0; 4];
    key.ground_albedo[3] = 0.0;
    key.luts[2] = 0;
    key.luts[3] = 0;
    key.params[1] = 0;
    key
}

/// Whether `held` (what a LUT was last computed from) is `key`, bit for bit.
fn same_key(held: Option<&GpuSkyAtmosphere>, key: &GpuSkyAtmosphere) -> bool {
    held.is_some_and(|held| bytes_of(held) == bytes_of(key))
}

/// The pooled targets the sky writes under `quality` (empty with both the sky and IBL off: IBL
/// bakes a sky from them even with its backdrop off): its three LUTs, write-only storage in
/// compute, sampled afterwards. The aerial-perspective volume is RQ4's.
pub fn target_descs(quality: &EnvironmentQuality) -> Vec<TargetDesc> {
    let (view_w, view_h) = quality.sky_lut;
    if !(quality.sky || quality.ibl) || view_w == 0 || view_h == 0 {
        return Vec::new();
    }
    let lut = |label, size| TargetDesc {
        label,
        format: LUT_FORMAT,
        usage: TextureUsages::STORAGE_BINDING | TextureUsages::TEXTURE_BINDING,
        samples: 1,
        size,
        mips: 1,
        srgb_view: false,
    };
    vec![
        lut(TRANSMITTANCE_LABEL, TRANSMITTANCE_LUT),
        lut(MULTISCATTER_LABEL, (MULTISCATTER_LUT, MULTISCATTER_LUT)),
        lut(SKY_VIEW_LABEL, (view_w, view_h)),
    ]
}

/// The background pipeline's key: the world pass's scene format, samples and depth convention.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct DrawKey {
    format: TextureFormat,
    samples: u32,
    depth_reversed: bool,
}

/// One LUT texture and its view.
#[derive(Debug)]
struct Lut {
    texture: Texture,
    view: TextureView,
}

impl Lut {
    /// A LUT from its pool descriptor; copyable out for diagnostics ([`SkyState::read_lut`]).
    fn new(device: &Device, desc: &TargetDesc) -> Lut {
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some(desc.label),
            size: wgpu::Extent3d { width: desc.size.0, height: desc.size.1, depth_or_array_layers: 1 },
            mip_level_count: desc.mips,
            sample_count: desc.samples,
            dimension: wgpu::TextureDimension::D2,
            format: desc.format,
            usage: desc.usage | TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        Lut { texture, view }
    }

    fn size(&self) -> (u32, u32) {
        (self.texture.width(), self.texture.height())
    }
}

/// A compute pipeline with its bind group and the texels one workgroup covers per side.
#[derive(Debug)]
struct LutPass {
    pipeline: Compiled<ComputePipeline>,
    group: BindGroup,
    texels_per_group: u32,
}

impl LutPass {
    fn dispatch(&self, pass: &mut wgpu::ComputePass<'_>, (width, height): (u32, u32)) {
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &self.group, &[]);
        pass.dispatch_workgroups(width.div_ceil(self.texels_per_group), height.div_ceil(self.texels_per_group), 1);
    }
}

fn uniform_entry(binding: u32, visibility: ShaderStages) -> BindGroupLayoutEntry {
    BindGroupLayoutEntry {
        binding,
        visibility,
        ty: BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None },
        count: None,
    }
}

fn texture_entry(binding: u32, visibility: ShaderStages) -> BindGroupLayoutEntry {
    BindGroupLayoutEntry {
        binding,
        visibility,
        ty: BindingType::Texture {
            sample_type: wgpu::TextureSampleType::Float { filterable: true },
            view_dimension: wgpu::TextureViewDimension::D2,
            multisampled: false,
        },
        count: None,
    }
}

fn sampler_entry(binding: u32, visibility: ShaderStages) -> BindGroupLayoutEntry {
    BindGroupLayoutEntry { binding, visibility, ty: BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None }
}

fn storage_entry(binding: u32, view_dimension: wgpu::TextureViewDimension) -> BindGroupLayoutEntry {
    BindGroupLayoutEntry {
        binding,
        visibility: ShaderStages::COMPUTE,
        ty: BindingType::StorageTexture { access: wgpu::StorageTextureAccess::WriteOnly, format: LUT_FORMAT, view_dimension },
        count: None,
    }
}

fn layout(device: &Device, label: &str, entries: &[BindGroupLayoutEntry]) -> BindGroupLayout {
    device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some(label), entries })
}

fn compute_pipeline(device: &Device, label: &str, module: &ShaderModule, entry_point: &str, layout: &BindGroupLayout) -> Compiled<ComputePipeline> {
    let pipeline_layout = crate::tables::pipeline_layout(device, label, &[layout]);
    crate::compile::compute_pipeline(device, &wgpu::ComputePipelineDescriptor {
        label: Some(label),
        layout: Some(&pipeline_layout),
        module,
        entry_point: Some(entry_point),
        // A8.6: the aerial and multiscatter scans write their workgroup arrays first; the other
        // sky kernels have none.
        compilation_options: crate::compile::written_first(),
        cache: None,
    })
}

/// `lut`'s view as a binding.
fn view(lut: &Lut) -> wgpu::BindingResource<'_> {
    wgpu::BindingResource::TextureView(&lut.view)
}

fn bind_group(device: &Device, label: &str, layout: &BindGroupLayout, resources: &[(u32, wgpu::BindingResource<'_>)]) -> BindGroup {
    let entries: Vec<wgpu::BindGroupEntry<'_>> =
        resources.iter().map(|(binding, resource)| wgpu::BindGroupEntry { binding: *binding, resource: resource.clone() }).collect();
    device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some(label), layout, entries: &entries })
}

/// The sky's GPU resources at one sky-view size: the LUTs, their passes, the cube pass and the
/// background's bind group (its pipeline is made per world pass format).
#[derive(Debug)]
struct SkyGpu {
    view_size: (u32, u32),
    atmosphere: Buffer,
    frame: Buffer,
    transmittance: Lut,
    multiscatter: Lut,
    sky_view: Lut,
    transmittance_pass: LutPass,
    multiscatter_pass: LutPass,
    sky_view_pass: LutPass,
    sky_view_layout: BindGroupLayout,
    cube_layout: BindGroupLayout,
    cube_pipeline: Compiled<ComputePipeline>,
    sampler: Sampler,
    draw_module: ShaderModule,
    draw_layout: BindGroupLayout,
    draw_group: BindGroup,
    draw: Option<(DrawKey, Compiled<RenderPipeline>)>,
    /// What the transmittance and multiple-scattering LUTs hold ([`static_key`]).
    static_key: Option<GpuSkyAtmosphere>,
    /// What the sky-view LUT holds ([`view_key`]).
    view_key: Option<GpuSkyAtmosphere>,
    /// The night's uniform (B.2, [`crate::night_sky::GpuNightSky`]) and what it last held.
    night: Buffer,
    night_key: Option<crate::night_sky::GpuNightSky>,
    /// The moonlit sky (B.2): the sky-view kernel's atmosphere row with the moon as its light, and
    /// its LUT and pass, made the first night a moon gives light.
    moon_atmosphere: Buffer,
    moon: Option<(Lut, BindGroup)>,
    /// The cloud panorama (B.5, [`crate::clouds`]), made the first frame a layer is marched; the
    /// clear panorama the composites bind without one; the sampler they read either with.
    clouds: Option<crate::clouds::CloudPanorama>,
    clear_clouds: (Texture, TextureView),
    cloud_sampler: Sampler,
}

/// The background's bind group: `[frame, atmosphere, night]` uniforms, the sky-view LUT, the
/// transmittance LUT, the moonlit LUT, the sampler, and the cloud panorama with its sampler (B.5).
fn draw_bind_group(
    device: &Device,
    layout: &BindGroupLayout,
    uniforms: [&Buffer; 3],
    (sky_view, transmittance, moon): (&Lut, &Lut, &Lut),
    sampler: &Sampler,
    (clouds, cloud_sampler): (&TextureView, &Sampler),
) -> BindGroup {
    let [frame, atmosphere, night] = uniforms;
    bind_group(
        device,
        "sky draw",
        layout,
        &[
            (0, frame.as_entire_binding()),
            (1, atmosphere.as_entire_binding()),
            (2, view(sky_view)),
            (3, view(transmittance)),
            (4, wgpu::BindingResource::Sampler(sampler)),
            (5, night.as_entire_binding()),
            (6, view(moon)),
            (7, wgpu::BindingResource::TextureView(clouds)),
            (8, wgpu::BindingResource::Sampler(cloud_sampler)),
        ],
    )
}

impl SkyGpu {
    fn new(device: &Device, queue: &Queue, quality: &EnvironmentQuality) -> Result<SkyGpu, RenderError> {
        let view_size = quality.sky_lut;
        let descs = target_descs(quality);
        let [transmittance, multiscatter, sky_view] = [&descs[0], &descs[1], &descs[2]].map(|desc| Lut::new(device, desc));
        let uniform = |label, size| {
            device.create_buffer(&wgpu::BufferDescriptor { label: Some(label), size, usage: BufferUsages::UNIFORM | BufferUsages::COPY_DST, mapped_at_creation: false })
        };
        let atmosphere = uniform("sky atmosphere", size_of::<GpuSkyAtmosphere>() as u64);
        let frame = uniform("sky frame", size_of::<GxFrameV2>() as u64);
        let night = uniform("sky night", size_of::<crate::night_sky::GpuNightSky>() as u64);
        let moon_atmosphere = uniform("sky moon atmosphere", size_of::<GpuSkyAtmosphere>() as u64);
        // Clamped: the sky-view LUT spans half the azimuth (the sky is symmetric about the sun).
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("sky luts"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        let compute = ShaderStages::COMPUTE;
        let d2 = wgpu::TextureViewDimension::D2;
        let atmosphere_res = || atmosphere.as_entire_binding();

        let transmittance_layout = layout(device, "sky transmittance", &[uniform_entry(0, compute), storage_entry(1, d2)]);
        let transmittance_module = crate::shaders::module(device, "sky transmittance", crate::shaders::SKY_TRANSMITTANCE)?;
        let transmittance_pass = LutPass {
            pipeline: compute_pipeline(device, "sky transmittance", &transmittance_module, "cs_transmittance", &transmittance_layout),
            group: bind_group(device, "sky transmittance", &transmittance_layout, &[(0, atmosphere_res()), (1, view(&transmittance))]),
            texels_per_group: WORKGROUP_SIDE,
        };

        let multiscatter_layout =
            layout(device, "sky multiscatter", &[uniform_entry(0, compute), texture_entry(1, compute), sampler_entry(2, compute), storage_entry(3, d2)]);
        let multiscatter_module = crate::shaders::module(device, "sky multiscatter", crate::shaders::SKY_MULTISCATTER)?;
        let multiscatter_pass = LutPass {
            pipeline: compute_pipeline(device, "sky multiscatter", &multiscatter_module, "cs_multiscatter", &multiscatter_layout),
            group: bind_group(
                device,
                "sky multiscatter",
                &multiscatter_layout,
                &[(0, atmosphere_res()), (1, view(&transmittance)), (2, wgpu::BindingResource::Sampler(&sampler)), (3, view(&multiscatter))],
            ),
            // One texel per workgroup: its 64 threads gather one direction each.
            texels_per_group: 1,
        };

        let sky_view_layout = layout(
            device,
            "sky view",
            &[uniform_entry(0, compute), texture_entry(1, compute), texture_entry(2, compute), sampler_entry(3, compute), storage_entry(4, d2)],
        );
        let sky_view_module = crate::shaders::module(device, "sky view", crate::shaders::SKY_VIEW)?;
        let sky_view_pass = LutPass {
            pipeline: compute_pipeline(device, "sky view", &sky_view_module, "cs_sky_view", &sky_view_layout),
            group: bind_group(
                device,
                "sky view",
                &sky_view_layout,
                &[
                    (0, atmosphere_res()),
                    (1, view(&transmittance)),
                    (2, view(&multiscatter)),
                    (3, wgpu::BindingResource::Sampler(&sampler)),
                    (4, view(&sky_view)),
                ],
            ),
            texels_per_group: WORKGROUP_SIDE,
        };
        let cube_layout = layout(
            device,
            "sky cube",
            &[
                uniform_entry(0, compute),
                texture_entry(1, compute),
                sampler_entry(3, compute),
                texture_entry(5, compute),
                storage_entry(6, wgpu::TextureViewDimension::D2Array),
                uniform_entry(7, compute),
                texture_entry(8, compute),
                texture_entry(9, compute),
                sampler_entry(10, compute),
            ],
        );
        let cube_pipeline = compute_pipeline(device, "sky cube", &sky_view_module, "cs_sky_cube", &cube_layout);

        let fragment = ShaderStages::FRAGMENT;
        let draw_layout = layout(
            device,
            "sky draw",
            &[
                uniform_entry(0, ShaderStages::VERTEX_FRAGMENT),
                uniform_entry(1, fragment),
                texture_entry(2, fragment),
                texture_entry(3, fragment),
                sampler_entry(4, fragment),
                uniform_entry(5, fragment),
                texture_entry(6, fragment),
                texture_entry(7, fragment),
                sampler_entry(8, fragment),
            ],
        );
        let clear_clouds = crate::clouds::clear_panorama(device, queue);
        let cloud_sampler = crate::clouds::panorama_sampler(device);
        // No moon yet: the sky-view LUT stands in for the moonlit one (never sampled).
        let draw_group = draw_bind_group(
            device,
            &draw_layout,
            [&frame, &atmosphere, &night],
            (&sky_view, &transmittance, &sky_view),
            &sampler,
            (&clear_clouds.1, &cloud_sampler),
        );
        let draw_module = crate::shaders::module(device, "sky draw", crate::shaders::SKY_DRAW)?;
        Ok(SkyGpu {
            view_size,
            atmosphere,
            frame,
            transmittance,
            multiscatter,
            sky_view,
            transmittance_pass,
            multiscatter_pass,
            sky_view_pass,
            sky_view_layout,
            cube_layout,
            cube_pipeline,
            sampler,
            draw_module,
            draw_layout,
            draw_group,
            draw: None,
            static_key: None,
            view_key: None,
            night,
            night_key: None,
            moon_atmosphere,
            moon: None,
            clouds: None,
            clear_clouds,
            cloud_sampler,
        })
    }

    /// The cloud panorama the composites read (the clear one without a layer).
    fn clouds_view(&self) -> &TextureView {
        self.clouds.as_ref().map_or(&self.clear_clouds.1, crate::clouds::CloudPanorama::view)
    }

    /// The moonlit sky's LUT (its view, or the sky-view LUT's before a moon gave light).
    fn moon_view(&self) -> &Lut {
        self.moon.as_ref().map_or(&self.sky_view, |(lut, _)| lut)
    }

    /// The background's bind group over the current LUTs.
    fn rebind_draw(&mut self, device: &Device) {
        let moon = self.moon_view();
        self.draw_group = draw_bind_group(
            device,
            &self.draw_layout,
            [&self.frame, &self.atmosphere, &self.night],
            (&self.sky_view, &self.transmittance, moon),
            &self.sampler,
            (self.clouds_view(), &self.cloud_sampler),
        );
    }

    /// The moonlit sky's LUT and pass at the sky-view size (made again on a resize), the
    /// background rebound to it.
    fn ensure_moon(&mut self, device: &Device) {
        if self.moon.as_ref().is_some_and(|(lut, _)| lut.size() == self.view_size) {
            return;
        }
        let desc = TargetDesc {
            label: MOON_VIEW_LABEL,
            format: LUT_FORMAT,
            usage: TextureUsages::STORAGE_BINDING | TextureUsages::TEXTURE_BINDING,
            samples: 1,
            size: self.view_size,
            mips: 1,
            srgb_view: false,
        };
        let lut = Lut::new(device, &desc);
        let group = bind_group(
            device,
            "sky moon view",
            &self.sky_view_layout,
            &[
                (0, self.moon_atmosphere.as_entire_binding()),
                (1, view(&self.transmittance)),
                (2, view(&self.multiscatter)),
                (3, wgpu::BindingResource::Sampler(&self.sampler)),
                (4, view(&lut)),
            ],
        );
        self.moon = Some((lut, group));
        self.rebind_draw(device);
    }

    /// The sky-view LUT at `quality`'s size (a dynamic-resolution step changed it): only that LUT
    /// and the two bind groups that read or write it are made again; the modules, pipelines and
    /// the static LUTs stay (a demotion compiles nothing).
    fn resize_view(&mut self, device: &Device, quality: &EnvironmentQuality) {
        let descs = target_descs(quality);
        let Some(desc) = descs.iter().find(|desc| desc.label == SKY_VIEW_LABEL) else { return };
        self.sky_view = Lut::new(device, desc);
        self.view_size = quality.sky_lut;
        self.view_key = None;
        self.sky_view_pass.group = bind_group(
            device,
            "sky view",
            &self.sky_view_layout,
            &[
                (0, self.atmosphere.as_entire_binding()),
                (1, view(&self.transmittance)),
                (2, view(&self.multiscatter)),
                (3, wgpu::BindingResource::Sampler(&self.sampler)),
                (4, view(&self.sky_view)),
            ],
        );
        // The moonlit LUT is made again at the new size the next night.
        self.moon = None;
        self.night_key = None;
        self.rebind_draw(device);
    }

    /// The background pipeline for `key`, made when the world pass's format first changes to it.
    fn ensure_draw(&mut self, device: &Device, key: DrawKey) {
        if self.draw.as_ref().is_some_and(|(held, _)| *held == key) {
            return;
        }
        let pipeline = far_plane_pipeline(device, "sky draw", &self.draw_layout, &self.draw_module, ("vs_sky", "fs_sky"), key);
        self.draw = Some((key, pipeline));
    }

    fn lut(&self, lut: SkyLut) -> &Lut {
        match lut {
            SkyLut::Transmittance => &self.transmittance,
            SkyLut::Multiscatter => &self.multiscatter,
            SkyLut::SkyView => &self.sky_view,
        }
    }
}

/// The sky's GPU state: its LUTs and background pipelines (made when first needed), and the HDR
/// map's backdrop.
#[derive(Debug, Default)]
pub struct SkyState {
    environment: Environment,
    gpu: Option<SkyGpu>,
    /// The HDR map's backdrop (made on the first frame that draws one).
    backdrop: Option<Backdrop>,
    /// Bumped whenever the sky-view LUT is recomputed: the IBL bake rebakes from a new sky.
    generation: u64,
    /// Whether node 13 draws this frame (node 11 prepared its pipeline and frame uniform).
    prepared: bool,
    /// Times the sky's shaders and pipelines were made (diagnostics: a resize makes none).
    builds: u64,
    /// The aerial-perspective volume (RQ4.3), made on the first frame that asks for it.
    aerial: Option<crate::fog::AerialPerspective>,
    /// Whether node 11 wrote the volume this frame (the forward pass binds it only then).
    aerial_ready: bool,
    /// The froxel fog (renderer pass 2 A.5, [`crate::froxel`]), made on the first frame that asks
    /// for it (again when the grid changes).
    froxels: Option<crate::froxel::FroxelFog>,
    /// Whether node 11 wrote the froxel fog this frame: it is then bound in the aerial volume's
    /// place.
    froxels_ready: bool,
    /// Texels the cloud panorama's last frame marched (B.5; 0: none).
    clouds_texels: u64,
}

/// What the backdrop of an HDR map needs from the frame: the uploaded map's view and the
/// version it was uploaded as (`ibl::EnvironmentMaps::map_view`).
#[derive(Clone, Debug)]
pub struct BackdropMap {
    /// The map's view (its full mip chain).
    pub view: TextureView,
    /// Its upload's version (a new map rebinds).
    pub version: u64,
}

/// The HDR map's backdrop (`ibl/backdrop.wgsl`): its module, layout, uniforms, the bind group of
/// the map it was made for and a pipeline per world pass format.
#[derive(Debug)]
struct Backdrop {
    module: ShaderModule,
    layout: BindGroupLayout,
    frame: Buffer,
    params: Buffer,
    sampler: Sampler,
    group: Option<(u64, BindGroup)>,
    draw: Option<(DrawKey, Compiled<RenderPipeline>)>,
}

/// Bytes of the backdrop's parameters (`BackdropParams`: one vec4).
const BACKDROP_PARAMS_BYTES: u64 = 16;

impl Backdrop {
    fn new(device: &Device) -> Result<Backdrop, RenderError> {
        let fragment = ShaderStages::FRAGMENT;
        let layout = layout(
            device,
            "ibl backdrop",
            &[uniform_entry(0, ShaderStages::VERTEX_FRAGMENT), uniform_entry(1, fragment), texture_entry(2, fragment), sampler_entry(3, fragment)],
        );
        let uniform = |label, size| {
            device.create_buffer(&wgpu::BufferDescriptor { label: Some(label), size, usage: BufferUsages::UNIFORM | BufferUsages::COPY_DST, mapped_at_creation: false })
        };
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("ibl backdrop"),
            address_mode_u: wgpu::AddressMode::Repeat,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::MipmapFilterMode::Linear,
            ..Default::default()
        });
        Ok(Backdrop {
            module: crate::shaders::module(device, "ibl backdrop", crate::shaders::IBL_BACKDROP)?,
            frame: uniform("ibl backdrop frame", size_of::<GxFrameV2>() as u64),
            params: uniform("ibl backdrop params", BACKDROP_PARAMS_BYTES),
            layout,
            sampler,
            group: None,
            draw: None,
        })
    }

    /// The bind group of `map` (made again for a new upload) and the pipeline for `key`.
    fn prepare(&mut self, device: &Device, map: &BackdropMap, key: DrawKey) {
        if self.group.as_ref().is_none_or(|(version, _)| *version != map.version) {
            let group = bind_group(
                device,
                "ibl backdrop",
                &self.layout,
                &[
                    (0, self.frame.as_entire_binding()),
                    (1, self.params.as_entire_binding()),
                    (2, wgpu::BindingResource::TextureView(&map.view)),
                    (3, wgpu::BindingResource::Sampler(&self.sampler)),
                ],
            );
            self.group = Some((map.version, group));
        }
        if self.draw.as_ref().is_none_or(|(held, _)| *held != key) {
            let pipeline = far_plane_pipeline(device, "ibl backdrop", &self.layout, &self.module, ("vs_backdrop", "fs_backdrop"), key);
            self.draw = Some((key, pipeline));
        }
    }
}

/// A background pipeline drawn at the far plane (the sky's or the backdrop's): a full-screen
/// triangle passing the depth test only where nothing was drawn, writing no depth.
fn far_plane_pipeline(device: &Device, label: &str, layout: &BindGroupLayout, module: &ShaderModule, entries: (&str, &str), key: DrawKey) -> Compiled<RenderPipeline> {
    let pipeline_layout = crate::tables::pipeline_layout(device, label, &[layout]);
    // Only where nothing was drawn: the cleared far plane passes, any geometry fails.
    let depth_compare = if key.depth_reversed { wgpu::CompareFunction::GreaterEqual } else { wgpu::CompareFunction::LessEqual };
    crate::compile::render_pipeline(device, &wgpu::RenderPipelineDescriptor {
        label: Some(label),
        layout: Some(&pipeline_layout),
        vertex: wgpu::VertexState { module, entry_point: Some(entries.0), compilation_options: Default::default(), buffers: &[] },
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: Some(wgpu::DepthStencilState {
            format: DEPTH_FORMAT,
            depth_write_enabled: Some(false),
            depth_compare: Some(depth_compare),
            stencil: wgpu::StencilState::default(),
            bias: wgpu::DepthBiasState::default(),
        }),
        multisample: wgpu::MultisampleState { count: key.samples, ..Default::default() },
        fragment: Some(wgpu::FragmentState {
            module,
            entry_point: Some(entries.1),
            compilation_options: Default::default(),
            targets: &[Some(wgpu::ColorTargetState { format: key.format, blend: None, write_mask: wgpu::ColorWrites::ALL })],
        }),
        multiview_mask: None,
        cache: None,
    })
}

impl SkyState {
    /// A sky with nothing made yet.
    pub fn new() -> SkyState {
        SkyState::default()
    }

    /// Draw `environment` from the next frame on.
    pub fn set_environment(&mut self, environment: &Environment) {
        if self.environment != *environment {
            self.environment = environment.clone();
        }
    }

    /// Whether node 13 draws a background for the environment: the physical sky, or an HDR map's
    /// backdrop, once landed (the quality's `sky` switch decides per frame, [`SkyState::encode`]).
    pub fn draws_background(&self) -> bool {
        LANDED && matches!(self.environment, Environment::Sky(_) | Environment::Hdri(_))
    }

    /// Times the sky's shaders and pipelines were made (a sky-view resize makes none).
    pub fn builds(&self) -> u64 {
        self.builds
    }

    /// How many times the sky-view LUT has been recomputed: a new value means a new sky.
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// Graph node 11's sky part: the LUTs when [`lut_due`] (all of them when `ctx.settle`), and
    /// the background's pipeline and frame uniform for `ctx`'s world pass. The LUTs run whenever
    /// the sky lights or draws (IBL bakes from them with the backdrop switched off); the
    /// background only with the `sky` switch on. Under an HDR map, the map's backdrop (`map`, the
    /// uploaded map) is prepared instead.
    pub fn encode(&mut self, frame: &mut FrameEncoder, ctx: &EnvironmentFrame<'_>, map: Option<&BackdropMap>) -> PassCounters {
        self.prepared = false;
        if !LANDED {
            return PassCounters::default();
        }
        if let Environment::Hdri(hdri) = ctx.environment {
            if let Some(map) = map.filter(|_| ctx.quality.sky) {
                let queue = frame.queue().clone();
                self.prepared = self.prepare_backdrop(ctx, &queue, hdri, map);
            }
            return PassCounters::default();
        }
        let Environment::Sky(sky) = ctx.environment else { return PassCounters::default() };
        if !(ctx.quality.sky || ctx.quality.ibl) {
            return PassCounters::default();
        }
        let sky_frame = SkyFrame {
            sun_dir: ctx.sun_dir,
            sun_illuminance: ctx.sun_color,
            camera_height_km: camera_height_km(ctx.camera_pos[1]),
            frame_index: ctx.frame_index,
        };
        let queue = frame.queue().clone();
        let refresh = LutRefresh::new(sky, ctx.quality, sky_frame).forced(ctx.settle);
        let mut passes = self.encode_luts(ctx.device, &queue, frame.encoder(), refresh);
        // B.5: the cloud panorama, after the LUTs it reads.
        passes.compute += self.encode_clouds(ctx.device, &queue, frame.encoder(), LutRefresh::new(sky, ctx.quality, sky_frame).forced(ctx.settle)).compute;
        self.prepared = ctx.quality.sky && self.prepare_draw(ctx.device, &queue, sky, ctx);
        if ctx.aerial {
            passes.compute += self.encode_aerial(frame, &queue, sky, ctx);
        }
        passes
    }

    /// Start a frame: the aerial-perspective volume and the froxel fog count only once node 11
    /// writes them again.
    pub fn begin_frame(&mut self) {
        self.aerial_ready = false;
        self.froxels_ready = false;
    }

    /// The air volume the forward pass binds in its aerial slot this frame: the froxel fog where
    /// node 11 drew it (the aerial volume folded in), else the aerial-perspective volume where it
    /// wrote that (None: neither ran).
    pub fn aerial_view(&self) -> Option<&TextureView> {
        let froxels = self.froxels.as_ref().filter(|_| self.froxels_ready).map(crate::froxel::FroxelFog::view);
        froxels.or_else(|| self.sky_aerial_view())
    }

    /// The aerial-perspective volume node 11 wrote this frame, without the froxel fog (None: it did
    /// not run): what the froxel fog folds in.
    pub fn sky_aerial_view(&self) -> Option<&TextureView> {
        self.aerial.as_ref().filter(|_| self.aerial_ready).map(crate::fog::AerialPerspective::view)
    }

    /// Node 11's froxel fog of `grid` for `frame` (renderer pass 2 A.5), after the aerial volume
    /// (`inputs.aerial`, which it folds in): bound in the aerial slot from now on this frame. The
    /// compute passes it opened (none when its shaders are refused, logged once).
    pub fn encode_froxels(
        &mut self,
        device: &wgpu::Device,
        queue: &Queue,
        encoder: &mut CommandEncoder,
        (grid, inputs, frame): (crate::froxel::FroxelGrid, &crate::froxel::FroxelInputs<'_>, &crate::froxel::FroxelFrame),
    ) -> PassCounters {
        if self.froxels.as_ref().is_none_or(|froxels| froxels.grid() != grid) {
            match crate::froxel::FroxelFog::new(device, grid) {
                Ok(froxels) => self.froxels = Some(froxels),
                Err(error) => {
                    log::warn!("froxel fog is off: {error}");
                    self.froxels = None;
                    return PassCounters::default();
                }
            }
        }
        let Some(froxels) = self.froxels.as_mut() else { return PassCounters::default() };
        let passes = froxels.encode(device, queue, encoder, inputs, frame);
        self.froxels_ready = true;
        passes
    }

    /// Bytes the froxel fog holds (0 before a frame drew it).
    pub fn froxel_bytes(&self) -> u64 {
        self.froxels.as_ref().map_or(0, crate::froxel::FroxelFog::bytes)
    }

    /// Release the froxel fog (a quality without it).
    pub fn release_froxels(&mut self) {
        self.froxels = None;
        self.froxels_ready = false;
    }

    /// Node 11's aerial-perspective volume for `ctx` (medium and above, where the fog's look allows
    /// it): the sky's in-scatter and transmittance along each pixel's ray, from this frame's
    /// camera through the LUTs. The compute passes it opened (0: none, or the LUTs were never made).
    fn encode_aerial(&mut self, frame: &mut FrameEncoder, queue: &Queue, sky: &SkyParams, ctx: &EnvironmentFrame<'_>) -> u32 {
        if self.aerial.is_none() {
            match crate::fog::AerialPerspective::new(ctx.device) {
                Ok(aerial) => self.aerial = Some(aerial),
                Err(error) => {
                    log::warn!("aerial perspective is off: {error}");
                    return 0;
                }
            }
        }
        let Some(gpu) = self.gpu.as_ref().filter(|gpu| gpu.view_key.is_some()) else { return 0 };
        // The background's frame row: the camera the volume's rays leave from.
        queue.write_buffer(&gpu.frame, 0, bytes_of(&draw_frame(sky.sun_angular_radius, ctx)));
        let inputs = crate::fog::AerialInputs {
            atmosphere: &gpu.atmosphere,
            frame: &gpu.frame,
            transmittance: &gpu.transmittance.view,
            multiscatter: &gpu.multiscatter.view,
            sampler: &gpu.sampler,
        };
        let aerial = self.aerial.as_ref().expect("made above");
        let passes = aerial.encode(ctx.device, frame.encoder(), &inputs, None);
        self.aerial_ready = true;
        passes.compute
    }

    /// The HDR map's backdrop for `ctx`'s world pass: its pipeline, its bind group for `map`, the
    /// frame uniform and the map's turn and intensity. False (logged) when its shader is refused.
    fn prepare_backdrop(&mut self, ctx: &EnvironmentFrame<'_>, queue: &Queue, hdri: &HdriEnvironment, map: &BackdropMap) -> bool {
        if self.backdrop.is_none() {
            match Backdrop::new(ctx.device) {
                Ok(backdrop) => self.backdrop = Some(backdrop),
                Err(error) => {
                    log::warn!("the HDR map's backdrop is off: {error}");
                    return false;
                }
            }
        }
        let backdrop = self.backdrop.as_mut().expect("made above");
        backdrop.prepare(ctx.device, map, DrawKey { format: ctx.scene_format, samples: ctx.samples.max(1), depth_reversed: ctx.depth_reversed });
        queue.write_buffer(&backdrop.frame, 0, bytes_of(&draw_frame(0.0, ctx)));
        let params = [libm::cosf(hdri.rotation), libm::sinf(hdri.rotation), hdri.intensity, 0.0];
        queue.write_buffer(&backdrop.params, 0, bytemuck::cast_slice(&params));
        true
    }

    /// Refresh the LUTs for `refresh` (made on first use): the transmittance and
    /// multiple-scattering LUTs when the atmosphere changed, the sky-view LUT when its inputs
    /// changed and it is due ([`lut_due`], or `refresh.force`). One compute pass when anything is
    /// refreshed (timestamped with `refresh.timestamp_writes`).
    pub fn encode_luts(&mut self, device: &Device, queue: &Queue, encoder: &mut CommandEncoder, refresh: LutRefresh<'_>) -> PassCounters {
        let Some(gpu) = self.gpu_for(device, queue, refresh.quality) else { return PassCounters::default() };
        let atmosphere = atmosphere(refresh.sky, refresh.quality, &refresh.frame);
        let night = crate::night_sky::gpu_night(refresh.sky, refresh.frame.sun_dir);
        let (statics, view) = (static_key(&atmosphere), view_key(&atmosphere));
        let static_stale = !same_key(gpu.static_key.as_ref(), &statics);
        let view_stale = !same_key(gpu.view_key.as_ref(), &view) || gpu.night_key != Some(night);
        let due = refresh.force || gpu.view_key.is_none() || lut_due(refresh.frame.frame_index, refresh.quality.sky_cadence);
        if !static_stale && !(view_stale && due) {
            return PassCounters::default();
        }
        // The moonlit sky (B.2): only on a night a moon gives light.
        let moonlit = night.moon[2] > 0.0;
        if moonlit {
            gpu.ensure_moon(device);
            queue.write_buffer(&gpu.moon_atmosphere, 0, bytes_of(&moon_atmosphere(&atmosphere, refresh.sky, &refresh.frame)));
        }
        queue.write_buffer(&gpu.atmosphere, 0, bytes_of(&atmosphere));
        queue.write_buffer(&gpu.night, 0, bytes_of(&night));
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("sky luts"), timestamp_writes: refresh.timestamp_writes });
        // Each dispatch is its own usage scope: a LUT written by one is sampled by the next.
        if static_stale {
            gpu.transmittance_pass.dispatch(&mut pass, gpu.transmittance.size());
            gpu.multiscatter_pass.dispatch(&mut pass, gpu.multiscatter.size());
        }
        gpu.sky_view_pass.dispatch(&mut pass, gpu.sky_view.size());
        if let Some((lut, group)) = gpu.moon.as_ref().filter(|_| moonlit) {
            let (width, height) = lut.size();
            pass.set_pipeline(&gpu.sky_view_pass.pipeline);
            pass.set_bind_group(0, group, &[]);
            pass.dispatch_workgroups(width.div_ceil(WORKGROUP_SIDE), height.div_ceil(WORKGROUP_SIDE), 1);
        }
        drop(pass);
        gpu.static_key = Some(statics);
        gpu.view_key = Some(view);
        gpu.night_key = Some(night);
        self.generation += 1;
        PassCounters { compute: 1, ..PassCounters::default() }
    }

    /// The cloud panorama for `refresh` (renderer pass 2 B.5, [`crate::clouds`]): where the sky has a
    /// layer and the quality a panorama, after [`SkyState::encode_luts`] (it reads their LUTs), the
    /// whole panorama, an amortised slice of it, or nothing when nothing moved. One compute pass when
    /// anything is marched (timestamped with `refresh.timestamp_writes`). A whole march, or the last
    /// slice of a pass, is a new sky ([`SkyState::generation`]). Without a layer the panorama is
    /// released.
    pub fn encode_clouds(&mut self, device: &Device, queue: &Queue, encoder: &mut CommandEncoder, refresh: LutRefresh<'_>) -> PassCounters {
        self.clouds_texels = 0;
        let wanted = refresh.sky.clouds.zip(refresh.quality.clouds).filter(|_| crate::clouds::LANDED);
        let Some(gpu) = self.gpu.as_mut().filter(|gpu| gpu.view_key.is_some()) else { return PassCounters::default() };
        let Some((clouds, grid)) = wanted else {
            if gpu.clouds.take().is_some() {
                gpu.rebind_draw(device);
            }
            return PassCounters::default();
        };
        if gpu.clouds.as_ref().is_none_or(|panorama| panorama.grid() != grid) {
            match crate::clouds::CloudPanorama::new(device, grid) {
                Ok(panorama) => gpu.clouds = Some(panorama),
                Err(error) => {
                    log::warn!("the cloud panorama is off: {error}");
                    gpu.clouds = None;
                    gpu.rebind_draw(device);
                    return PassCounters::default();
                }
            }
            gpu.rebind_draw(device);
        }
        let inputs = crate::clouds::CloudInputs { atmosphere: &gpu.atmosphere, transmittance: &gpu.transmittance.view, sky_view: &gpu.sky_view.view, sampler: &gpu.sampler };
        let frame = crate::clouds::CloudFrame { clouds: clouds.validated(), atmosphere: atmosphere(refresh.sky, refresh.quality, &refresh.frame), force: refresh.force };
        let panorama = gpu.clouds.as_mut().expect("made above");
        let Some(whole) = panorama.encode(device, queue, encoder, (&inputs, &frame), refresh.timestamp_writes) else { return PassCounters::default() };
        self.clouds_texels = panorama.texels_written();
        if whole {
            self.generation += 1;
        }
        PassCounters { compute: 1, ..PassCounters::default() }
    }

    /// Texels the last [`SkyState::encode_clouds`] marched (0: none).
    pub fn clouds_texels_written(&self) -> u64 {
        self.clouds_texels
    }

    /// Bytes the cloud panorama and its noise hold (0 without one).
    pub fn clouds_bytes(&self) -> u64 {
        self.gpu.as_ref().and_then(|gpu| gpu.clouds.as_ref()).map_or(0, crate::clouds::CloudPanorama::bytes)
    }

    /// Read the cloud panorama back as linear rgba, rows top first (the zenith's first; diagnostics
    /// and tests; native only, after the queue's work so far).
    #[cfg(not(target_arch = "wasm32"))]
    pub fn read_clouds(&self, gpu: &crate::gpu::Gpu) -> Result<Vec<[f32; 4]>, RenderError> {
        let Some(panorama) = self.gpu.as_ref().and_then(|sky| sky.clouds.as_ref()) else { return Err(crate::readback::capture_failed("the sky has no cloud panorama")) };
        let bytes = read_rgba16f(gpu, panorama.texture())?;
        let half = |pair: &[u8; 2]| crate::post::tonemap::f16_to_f32(u16::from_le_bytes(*pair));
        Ok(bytes.as_chunks::<8>().0.iter().map(|texel| [0, 2, 4, 6].map(|at| half(&[texel[at], texel[at + 1]]))).collect())
    }

    /// The sky's resources at `quality`'s sky-view size (the sky-view LUT made again when the size
    /// changes, nothing else). None
    /// with the sky-view size zero, or when its shaders were refused (logged: the background then
    /// stays the clear colour).
    fn gpu_for(&mut self, device: &Device, queue: &Queue, quality: &EnvironmentQuality) -> Option<&mut SkyGpu> {
        let (width, height) = quality.sky_lut;
        if width == 0 || height == 0 {
            return None;
        }
        if let Some(gpu) = self.gpu.as_mut().filter(|gpu| gpu.view_size != quality.sky_lut) {
            gpu.resize_view(device, quality);
        }
        if self.gpu.is_none() {
            self.builds += 1;
            self.gpu = match SkyGpu::new(device, queue, quality) {
                Ok(gpu) => Some(gpu),
                Err(error) => {
                    log::warn!("the physical sky is off: {error}");
                    None
                }
            };
        }
        self.gpu.as_mut()
    }

    /// The background's pipeline for `ctx`'s world pass and its frame uniform (the camera, the
    /// current sun and its disk, the pre-exposure). False when the LUTs were never computed.
    fn prepare_draw(&mut self, device: &Device, queue: &Queue, sky: &SkyParams, ctx: &EnvironmentFrame<'_>) -> bool {
        let Some(gpu) = self.gpu.as_mut().filter(|gpu| gpu.view_key.is_some()) else { return false };
        gpu.ensure_draw(device, DrawKey { format: ctx.scene_format, samples: ctx.samples.max(1), depth_reversed: ctx.depth_reversed });
        queue.write_buffer(&gpu.frame, 0, bytes_of(&draw_frame(sky.sun_angular_radius, ctx)));
        true
    }

    /// The frame uniform this frame's background reads (a `GxFrameV2`: the sky's or the HDR map
    /// backdrop's), once node 11 prepared one. Under auto exposure the renderer copies the GPU's
    /// exposure over its pre-exposure lane after node 11 (`ExposureHistory::copy_into_frame_v2`),
    /// so the background is exposed as the geometry is.
    pub fn frame_uniform(&self) -> Option<&Buffer> {
        if !self.prepared {
            return None;
        }
        match self.environment {
            Environment::Hdri(_) => self.backdrop.as_ref().map(|backdrop| &backdrop.frame),
            _ => self.gpu.as_ref().map(|gpu| &gpu.frame),
        }
    }

    /// Graph node 13: the background at the far plane inside the world pass (nothing unless node
    /// 11 prepared it this frame): the sky, or the HDR map's backdrop.
    pub fn draw_background(&self, pass: &mut RenderPass<'_>) {
        if !self.prepared {
            return;
        }
        let (pipeline, group) = match self.environment {
            Environment::Hdri(_) => {
                let Some(backdrop) = &self.backdrop else { return };
                let (Some((_, pipeline)), Some((_, group))) = (&backdrop.draw, &backdrop.group) else { return };
                (pipeline, group)
            }
            _ => {
                let Some(gpu) = &self.gpu else { return };
                let Some((_, pipeline)) = &gpu.draw else { return };
                (pipeline, &gpu.draw_group)
            }
        };
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, group, &[]);
        pass.draw(0..3, 0..1);
    }

    /// The sky into an environment cube's mip 0 (the IBL bake's source, on its schedule): `cube`
    /// is a [`CUBE_FORMAT`] `D2Array` view of the six faces (storage binding), faces in WebGPU's
    /// order (+X, -X, +Y, -Y, +Z, -Z), texel centres at `(i + 0.5) / side`. The sky-view LUT
    /// alone: no sun disk (the analytic sun lights the scene directly). False, and nothing
    /// recorded, before the LUTs were first computed.
    pub fn encode_cube(&self, device: &Device, encoder: &mut CommandEncoder, cube: &TextureView, side: u32) -> bool {
        if !self.has_luts() {
            return false;
        }
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("sky cube"), timestamp_writes: None });
        self.dispatch_cube(device, &mut pass, cube, side)
    }

    /// Whether the LUTs were computed at least once ([`SkyState::encode_cube`] and
    /// [`SkyState::dispatch_cube`] record nothing before).
    pub fn has_luts(&self) -> bool {
        self.gpu.as_ref().is_some_and(|gpu| gpu.view_key.is_some())
    }

    /// [`SkyState::encode_cube`] recorded into `pass` (the IBL bake's own pass: its next dispatch may
    /// read the faces). False, and nothing recorded, before the LUTs were first computed.
    pub fn dispatch_cube(&self, device: &Device, pass: &mut wgpu::ComputePass<'_>, cube: &TextureView, side: u32) -> bool {
        let Some(gpu) = self.gpu.as_ref().filter(|gpu| gpu.view_key.is_some()) else { return false };
        let group = bind_group(
            device,
            "sky cube",
            &gpu.cube_layout,
            &[
                (0, gpu.atmosphere.as_entire_binding()),
                (1, view(&gpu.transmittance)),
                (3, wgpu::BindingResource::Sampler(&gpu.sampler)),
                (5, wgpu::BindingResource::TextureView(&gpu.sky_view.view)),
                (6, wgpu::BindingResource::TextureView(cube)),
                (7, gpu.night.as_entire_binding()),
                (8, wgpu::BindingResource::TextureView(&gpu.moon_view().view)),
                (9, wgpu::BindingResource::TextureView(gpu.clouds_view())),
                (10, wgpu::BindingResource::Sampler(&gpu.cloud_sampler)),
            ],
        );
        pass.set_pipeline(&gpu.cube_pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups(side.div_ceil(WORKGROUP_SIDE), side.div_ceil(WORKGROUP_SIDE), CUBE_FACES);
        true
    }

    /// The size of `lut` once made.
    pub fn lut_size(&self, lut: SkyLut) -> Option<(u32, u32)> {
        self.gpu.as_ref().map(|gpu| gpu.lut(lut).size())
    }

    /// Read `lut` back as linear rgba, rows top first (diagnostics and tests; native only, after
    /// the queue's work so far).
    #[cfg(not(target_arch = "wasm32"))]
    pub fn read_lut(&self, gpu: &crate::gpu::Gpu, lut: SkyLut) -> Result<Vec<[f32; 4]>, RenderError> {
        let Some(sky) = &self.gpu else { return Err(crate::readback::capture_failed("the sky has no LUTs yet")) };
        let bytes = read_rgba16f(gpu, &sky.lut(lut).texture)?;
        let half = |pair: &[u8; 2]| crate::post::tonemap::f16_to_f32(u16::from_le_bytes(*pair));
        Ok(bytes.as_chunks::<8>().0.iter().map(|texel| [0, 2, 4, 6].map(|at| half(&[texel[at], texel[at + 1]]))).collect())
    }
}

/// The background's frame uniform for `ctx`: the inverse view-projection the fragment
/// reconstructs its view direction from, the camera, the current sun with the disk's angular
/// radius `sun_angular_radius`, the pre-exposure and the frame's fog.
fn draw_frame(sun_angular_radius: f32, ctx: &EnvironmentFrame<'_>) -> GxFrameV2 {
    let view_proj = glam::Mat4::from_cols_array(&ctx.view_proj);
    let [cx, cy, cz] = ctx.camera_pos;
    let [sx, sy, sz] = ctx.sun_dir;
    let [r, g, b] = ctx.sun_color;
    let pre_exposure = ctx.pre_exposure.max(f32::MIN_POSITIVE);
    GxFrameV2 {
        view_proj: ctx.view_proj,
        inv_view_proj: view_proj.inverse().to_cols_array(),
        camera_pos: [cx, cy, cz, 1.0],
        sun_dir: [sx, sy, sz, sun_angular_radius],
        sun_color: [r, g, b, 0.0],
        pre_exposure,
        inv_pre_exposure: 1.0 / pre_exposure,
        frame_index: (ctx.frame_index & u64::from(u32::MAX)) as u32,
        depth_reversed: u32::from(ctx.depth_reversed),
        fog_color: ctx.fog.color,
        fog_params: ctx.fog.params,
        ..GxFrameV2::default()
    }
}

/// Every texel of the 2D `rgba16float` `texture`, tightly packed, rows top first.
#[cfg(not(target_arch = "wasm32"))]
fn read_rgba16f(gpu: &crate::gpu::Gpu, texture: &Texture) -> Result<Vec<u8>, RenderError> {
    const TEXEL_BYTES: u32 = 8;
    let (width, height) = (texture.width(), texture.height());
    let tight = width * TEXEL_BYTES;
    let padded = tight.div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT) * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
    let bytes = u64::from(padded) * u64::from(height);
    let staging = crate::tables::buffer(&gpu.device, "sky readback", bytes, BufferUsages::MAP_READ | BufferUsages::COPY_DST)?;
    let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("sky readback") });
    encoder.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo { texture, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
        wgpu::TexelCopyBufferInfo {
            buffer: &staging,
            layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(padded), rows_per_image: Some(height) },
        },
        wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
    );
    gpu.queue.submit([encoder.finish()]);
    let data = crate::readback::map_read_blocking(gpu, &staging, bytes)?;
    Ok(data.chunks(padded as usize).flat_map(|row| row[..tight as usize].to_vec()).collect())
}

/// Untimed draws before a background cost row's timed ones (pipelines made, the GPU's clocks up).
#[cfg(not(target_arch = "wasm32"))]
const BACKGROUND_WARMUP: usize = 8;
/// The sun's illuminance a background cost row draws with (the default sun).
#[cfg(not(target_arch = "wasm32"))]
const BACKGROUND_SUN: f32 = 2.5;

/// GPU milliseconds of the sky's background (node 13) drawn `frames` times at `size` for `sky` with
/// the sun towards `sun_dir` (renderer pass 2 B.2's cost row: the night's stars and moon are drawn
/// per pixel), each draw its own timestamped render pass over a cleared reverse-Z depth, after
/// [`BACKGROUND_WARMUP`] untimed ones; sorted. None without timestamp queries.
#[cfg(not(target_arch = "wasm32"))]
pub fn background_gpu_ms(gpu: &crate::gpu::Gpu, sky: &SkyParams, quality: &EnvironmentQuality, sun_dir: [f32; 3], size: (u32, u32), frames: usize) -> Result<Option<Vec<f64>>, RenderError> {
    let times = background_gpu_ms_interleaved(gpu, &[(*sky, sun_dir)], quality, size, frames)?;
    Ok(times.and_then(|mut times| times.pop()))
}

/// [`background_gpu_ms`] for each of `skies` (a sky and its sun), their draws interleaved frame by
/// frame (renderer pass 2 B.5: a shared GPU's load then weighs on every sky alike, so their
/// differences are the skies' own). Each sky's times sorted, in `skies`' order. None without
/// timestamp queries.
#[cfg(not(target_arch = "wasm32"))]
pub fn background_gpu_ms_interleaved(
    gpu: &crate::gpu::Gpu,
    skies: &[(SkyParams, [f32; 3])],
    quality: &EnvironmentQuality,
    size: (u32, u32),
    frames: usize,
) -> Result<Option<Vec<Vec<f64>>>, RenderError> {
    if !gpu.device.features().contains(wgpu::Features::TIMESTAMP_QUERY) || skies.is_empty() {
        return Ok(None);
    }
    let (device, queue) = (&gpu.device, &gpu.queue);
    let frame = |sun_dir| SkyFrame { sun_dir, sun_illuminance: [BACKGROUND_SUN; 3], camera_height_km: camera_height_km(1.5), frame_index: 0 };
    let mut states: Vec<SkyState> = skies
        .iter()
        .map(|(sky, sun_dir)| {
            let frame = frame(*sun_dir);
            let mut state = SkyState::new();
            state.set_environment(&Environment::Sky(*sky));
            let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("sky background cost") });
            state.encode_luts(device, queue, &mut encoder, LutRefresh::new(sky, quality, frame).forced(true));
            // B.5: a sky with clouds draws over its panorama.
            state.encode_clouds(device, queue, &mut encoder, LutRefresh::new(sky, quality, frame).forced(true));
            queue.submit([encoder.finish()]);
            state
        })
        .collect();
    let target = |label, format, usage| {
        device.create_texture(&wgpu::TextureDescriptor {
            label: Some(label),
            size: wgpu::Extent3d { width: size.0, height: size.1, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage,
            view_formats: &[],
        })
    };
    let colour = target("sky background cost", TextureFormat::Rgba16Float, TextureUsages::RENDER_ATTACHMENT).create_view(&wgpu::TextureViewDescriptor::default());
    let depth = target("sky background cost depth", DEPTH_FORMAT, TextureUsages::RENDER_ATTACHMENT).create_view(&wgpu::TextureViewDescriptor::default());
    let eye = glam::Vec3::new(0.0, 1.5, 0.0);
    let projection = glam::camera::rh::proj::directx::perspective_infinite_reverse(60f32.to_radians(), size.0 as f32 / size.1 as f32, 0.1);
    let view_proj = projection * glam::camera::rh::view::look_at_mat4(eye, glam::Vec3::new(0.0, 4.0, -8.0), glam::Vec3::Y);
    for (state, (sky, sun_dir)) in states.iter_mut().zip(skies) {
        let environment = Environment::Sky(*sky);
        let ctx = EnvironmentFrame {
            device,
            environment: &environment,
            quality,
            frame_index: 0,
            settle: false,
            sun_dir: *sun_dir,
            sun_color: [BACKGROUND_SUN; 3],
            camera_pos: eye.to_array(),
            view_proj: view_proj.to_cols_array(),
            pre_exposure: 1.0,
            scene_format: TextureFormat::Rgba16Float,
            samples: 1,
            depth_reversed: true,
            fog: crate::fog::GpuFog::default(),
            aerial: false,
        };
        state.prepared = state.prepare_draw(device, queue, sky, &ctx);
        if !state.prepared {
            return Ok(None);
        }
    }
    let total = BACKGROUND_WARMUP + frames;
    let stamps = 2 * (total * states.len()) as u32;
    let bytes = u64::from(stamps) * 8;
    let queries = device.create_query_set(&wgpu::QuerySetDescriptor { label: Some("sky background cost"), ty: wgpu::QueryType::Timestamp, count: stamps });
    let resolve = crate::tables::buffer(device, "sky background cost", bytes, BufferUsages::QUERY_RESOLVE | BufferUsages::COPY_SRC)?;
    let read = crate::tables::buffer(device, "sky background cost read", bytes, BufferUsages::MAP_READ | BufferUsages::COPY_DST)?;
    for run in 0..(total * states.len()) as u32 {
        let state = &states[run as usize % states.len()];
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("sky background cost") });
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("sky background cost"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &colour,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store },
            })],
            depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                view: &depth,
                depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(0.0), store: wgpu::StoreOp::Discard }),
                stencil_ops: None,
            }),
            timestamp_writes: Some(wgpu::RenderPassTimestampWrites { query_set: &queries, beginning_of_pass_write_index: Some(2 * run), end_of_pass_write_index: Some(2 * run + 1) }),
            occlusion_query_set: None,
            multiview_mask: None,
        });
        state.draw_background(&mut pass);
        drop(pass);
        queue.submit([encoder.finish()]);
    }
    device.poll(wgpu::PollType::wait_indefinitely()).map_err(|error| crate::readback::capture_failed(error.to_string()))?;
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("sky background cost resolve") });
    encoder.resolve_query_set(&queries, 0..stamps, &resolve, 0);
    encoder.copy_buffer_to_buffer(&resolve, 0, &read, 0, bytes);
    queue.submit([encoder.finish()]);
    let data = crate::readback::map_read_blocking(gpu, &read, bytes)?;
    let period = f64::from(queue.get_timestamp_period());
    let ticks: Vec<u64> = data.as_chunks::<8>().0.iter().map(|b| u64::from_le_bytes(*b)).collect();
    let pairs = ticks.as_chunks::<2>().0;
    let times = (0..states.len())
        .map(|k| {
            let mut times: Vec<f64> = pairs.iter().skip(k).step_by(states.len()).skip(BACKGROUND_WARMUP).map(|[begin, end]| end.saturating_sub(*begin) as f64 * period / 1.0e6).collect();
            times.sort_by(f64::total_cmp);
            times
        })
        .collect();
    Ok(Some(times))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::Quality;

    #[test]
    fn the_luts_refresh_on_their_frame_indexed_cadence() {
        assert!(lut_due(0, 8) && lut_due(8, 8) && !lut_due(7, 8));
        assert!((0..5).all(|frame| lut_due(frame, 1)) && lut_due(3, 0), "cadence 0 or 1: every frame");
    }

    #[test]
    fn earths_atmosphere_fills_the_struct_at_the_quality_s_lut_sizes() {
        let mut quality = Quality::off().environment;
        assert!(target_descs(&quality).is_empty(), "sky off: nothing drawn");
        quality.sky = true;
        quality.sky_lut = (64, 36);
        let frame = SkyFrame { sun_dir: [0.0, 1.0, 0.0], sun_illuminance: [2.5; 3], camera_height_km: 0.001, frame_index: 9 };
        let gpu = atmosphere(&SkyParams::default(), &quality, &frame);
        assert_eq!(gpu.luts, [256, 64, 64, 36]);
        assert_eq!(gpu.params, [MULTISCATTER_LUT, 0, 9, 0]);
        assert_eq!(gpu.radii[..2], [EARTH_RADIUS_KM, ATMOSPHERE_TOP_KM]);
        assert_eq!(gpu.sun_dir[3], SkyParams::default().sun_angular_radius);
        let sizes: Vec<(u32, u32)> = target_descs(&quality).iter().map(|desc| desc.size).collect();
        assert_eq!(sizes, [TRANSMITTANCE_LUT, (MULTISCATTER_LUT, MULTISCATTER_LUT), (64, 36)]);
    }

    #[test]
    fn the_sun_and_camera_move_only_the_sky_view_key_and_the_frame_index_moves_none() {
        let mut quality = Quality::off().environment;
        quality.sky = true;
        quality.sky_lut = (96, 54);
        let noon = SkyFrame { sun_dir: [0.0, 1.0, 0.0], sun_illuminance: [2.5; 3], camera_height_km: 0.0, frame_index: 0 };
        let base = atmosphere(&SkyParams::default(), &quality, &noon);
        let later = atmosphere(&SkyParams::default(), &quality, &SkyFrame { frame_index: 5, ..noon });
        assert!(same_key(Some(&view_key(&base)), &view_key(&later)), "the frame index alone recomputes nothing");
        let dusk = atmosphere(&SkyParams::default(), &quality, &SkyFrame { sun_dir: [0.0, 0.05, -1.0], camera_height_km: 0.2, ..noon });
        assert!(!same_key(Some(&view_key(&base)), &view_key(&dusk)), "the sun moves the sky view");
        assert!(same_key(Some(&static_key(&base)), &static_key(&dusk)), "transmittance and multiple scattering stay");
        let red_ground = atmosphere(&SkyParams::default().with_ground_albedo([0.8, 0.1, 0.1]), &quality, &noon);
        assert!(!same_key(Some(&static_key(&base)), &static_key(&red_ground)), "the ground lights the multiple scattering");
        assert!(!same_key(None, &static_key(&base)), "nothing computed yet");
    }

    #[test]
    fn the_camera_height_is_kilometres_above_the_ground() {
        assert_eq!(camera_height_km(1500.0), 1.5);
        assert_eq!(camera_height_km(-3.0), 0.0);
        assert_eq!(camera_height_km(f32::NAN), 0.0);
    }
}
