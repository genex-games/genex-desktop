//! Height and distance fog matched to the sky (plan §2.2 "Fog"; RQ4). RQ4.0 landed the contract:
//! the GPU row ([`GpuFog`], `GxFog` in shaders/effects.wgsl and GxFrameV2's `fog_color` and
//! `fog_params`), how a look and a quality make it ([`gpu_fog`]). RQ4.3 is the model itself:
//!
//! - the lighting chunk (`shaders/lighting/fog.wgsl`, one text for the forward pass and the
//!   Level-2 v2 prelude's `gx_apply_fog`) integrates the fog's density along the camera's ray in
//!   closed form ([`optical_depth_along`]) and blends the surface into the fog's in-scatter by
//!   [`opacity_of`]; this module's functions are its CPU twin and tests/fog.rs holds the two to
//!   each other and the closed form to a numeric integral;
//! - the in-scatter comes from the sky model: the flat colour environment's is the fog's colour
//!   ([`inscatter_flat`]); under a sky or an HDR map it is the environment's radiance towards the
//!   horizon in the ray's azimuth (the prefiltered cube at [`ENV_ROUGHNESS`], [`inscatter_env`]) plus the sun's forward lobe
//!   through an analytic sun transmittance, tinted by the fog's colour. The sky background
//!   (`sky_draw.wgsl`) fogs itself with the sky-view LUT's horizon colour, so the fog at the horizon
//!   is the sky's colour;
//! - on medium and above [`AerialPerspective`] writes Hillaire's camera-space volume (32³
//!   `rgba16float`, graph node 11): the sky's in-scatter and transmittance between the camera and
//!   a point `AERIAL_RANGE × w²` away along each pixel's ray, which the chunk applies
//!   (`gx_apply_aerial`) before the height fog;
//! - particles fog through the same model (`particles_draw.wgsl`'s `*_fogged` entries).
//!
//! The lighting chunks read the fog through `gx_fog()`: the Level-2 v2 prelude from GxFrameV2 (its
//! fog lanes, `extension::FrameFacts::fog`), the forward pass from the row the renderer binds in
//! its frame group (`frame_fog`, `layout::FRAME_EFFECT_BOUND`; shaders/forward_effects.wgsl, which
//! also samples the aerial-perspective volume node 11 writes). Particles read the same row. Fog
//! needs no depth target and is on in every preset; a density of 0 (the default look) draws no fog
//! at all, so the legacy picture is unchanged.

use crate::compile::Compiled;
use bytemuck::{Pod, Zeroable};
use wgpu::{
    BindGroupLayout, BindGroupLayoutEntry, BindingType, Buffer, CommandEncoder, ComputePipeline, Device, Sampler, ShaderStages, Texture, TextureFormat,
    TextureUsages, TextureView,
};

use crate::error::RenderError;
use crate::graph::PassCounters;
use crate::settings::{Fog, Quality};

/// Whether the fog chunk applies fog (the `fog` switch changes the picture): the renderer binds
/// the fog row in the forward frame group, the sky and HDR-map backgrounds fog themselves through
/// their `GxFrameV2` lanes and Level-2 v2 sources read GxFrameV2's fog lanes (RQ4.6).
pub const LANDED: bool = true;
/// Optical depth below which a ray counts as clear (`GX_FOG_CLEAR_DEPTH`).
const CLEAR_DEPTH: f32 = 1e-7;
/// `height_falloff × vertical extent` below which the height integral is taken as a series around
/// constant density (`GX_FOG_FLAT_EXPONENT`).
const FLAT_EXPONENT: f32 = 1e-2;
/// The exponent a density is evaluated at is held to this (`GX_FOG_EXPONENT_LIMIT`).
const EXPONENT_LIMIT: f32 = 60.0;
/// The slope (rise over run) above the horizon the in-scatter is read at, whatever the ray's own
/// (`GX_FOG_HORIZON_SLOPE`).
pub const HORIZON_SLOPE: f32 = 0.02;
/// The roughness the environment's prefiltered cube is read at (`GX_FOG_ENV_ROUGHNESS`, at the
/// cube's perceptual level `ibl::roughness_lod`).
pub const ENV_ROUGHNESS: f32 = 0.05;
/// The sun lobe's Henyey-Greenstein asymmetry (`GX_FOG_SUN_G`).
const SUN_G: f32 = 0.6;
/// The sun lobe's share of the sun's radiance (`GX_FOG_SUN_SHARE`).
const SUN_SHARE: f32 = 0.5;
/// The band, in the sine of elevation, over which the sun sets (`GX_FOG_SET_BAND`).
const SET_BAND: f32 = 0.04;
/// How far the sky background's fog reaches along its ray, world units (`SKY_FOG_REACH` in
/// `sky_draw.wgsl`): the sky is at a finite, very large distance so uniform fog still blends it.
pub const SKY_REACH: f32 = 50_000.0;

/// Slices, rows and columns of the aerial-perspective volume.
pub const AERIAL_SIDE: u32 = 32;
/// The farthest slice's distance along its ray, world units (`GX_FOG_AERIAL_RANGE`,
/// `AERIAL_RANGE` in `aerial_perspective.wgsl`).
pub const AERIAL_RANGE: f32 = 32_000.0;
/// The volume's format: `rgba16float`, write-only storage in compute (core).
pub const AERIAL_FORMAT: TextureFormat = TextureFormat::Rgba16Float;
/// Marching steps inside each slice (`AERIAL_SLICE_STEPS`).
pub const AERIAL_SLICE_STEPS: u32 = 4;

/// The fog's GPU row (`GxFog`; the same values as GxFrameV2's `fog_color` and `fog_params`).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct GpuFog {
    /// rgb: the in-scatter tint (under the flat-colour environment the in-scatter itself: the
    /// fog's colour times the flat backdrop's, [`gpu_fog_over`]);
    /// a: extinction per world unit at the base height (0: no fog).
    pub color: [f32; 4],
    /// x: height falloff per world unit; y: base height; z: start distance; w: largest opacity.
    pub params: [f32; 4],
}

/// The GPU row of `fog` under `quality`: no fog (density 0) when the quality's `fog` switch is off.
pub fn gpu_fog(fog: &Fog, quality: &Quality) -> GpuFog {
    let density = if quality.fog && fog.is_on() { fog.density } else { 0.0 };
    GpuFog {
        color: [fog.color[0], fog.color[1], fog.color[2], density],
        params: [fog.height_falloff, fog.base_height, fog.start, fog.max_opacity],
    }
}

/// What the fog scatters in front of: the environment (a sky or an HDR map, whose horizon
/// radiance the shader reads) or the flat backdrop of the frame's clear colour (sRGB), the legacy
/// LDR scene's too.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FogBackdrop {
    /// A sky or a map lights the frame: the shader tints its horizon radiance.
    Environment,
    /// The flat clear colour (sRGB) is the backdrop.
    Flat([u8; 4]),
}

/// [`gpu_fog`] in front of `backdrop`: under the flat backdrop the row's colour is the fog's colour
/// times the backdrop's linear colour, so the fog's colour tints what is drawn behind the scene
/// under every environment (pass-1 gate, RX.R5: the default white fog drew grey or white against a
/// coloured flat backdrop); under an environment it is the fog's colour, which the shader
/// multiplies by the horizon's radiance.
pub fn gpu_fog_over(fog: &Fog, quality: &Quality, backdrop: FogBackdrop) -> GpuFog {
    let mut row = gpu_fog(fog, quality);
    if let FogBackdrop::Flat(clear) = backdrop {
        for (channel, srgb) in row.color.iter_mut().zip(clear) {
            *channel *= crate::texture::srgb_to_linear(srgb);
        }
    }
    row
}

/// Whether the aerial-perspective volume feeds the fog: the quality has it on (medium and above)
/// and the look allows it.
pub fn aerial_perspective(fog: &Fog, quality: &Quality) -> bool {
    quality.environment.aerial_perspective && fog.aerial_perspective
}

/// `exp(x)` with `x` held to the chunk's exponent limit (`gx_fog_exp`).
fn held_exp(x: f32) -> f32 {
    libm::expf(x.clamp(-EXPONENT_LIMIT, EXPONENT_LIMIT))
}

/// The fog's optical depth along the ray from `origin` along unit `dir` for `reach` world units
/// (`gx_fog_optical_depth`): `density × ∫ exp(-falloff × (y(t) - base))` over the part of the ray
/// past `start`, in closed form (a series around constant density where the exponent is small).
pub fn optical_depth_along(fog: &GpuFog, origin: [f32; 3], dir: [f32; 3], reach: f32) -> f32 {
    let [falloff, base, start, _] = fog.params;
    let density = fog.color[3];
    if density <= 0.0 || reach <= start {
        return 0.0;
    }
    let span = reach - start;
    let rise = falloff * dir[1];
    let exponent = rise * span;
    let start_exponent = falloff * (origin[1] + dir[1] * start - base);
    if exponent.abs() < FLAT_EXPONENT {
        return density * held_exp(-start_exponent) * span * (1.0 - exponent * (0.5 - exponent / 6.0));
    }
    density * (held_exp(-start_exponent) - held_exp(-start_exponent - exponent)) / rise
}

/// The fog's optical depth between `camera` and `surface` (world positions, y up).
pub fn optical_depth(fog: &GpuFog, camera: [f32; 3], surface: [f32; 3]) -> f32 {
    let delta = [surface[0] - camera[0], surface[1] - camera[1], surface[2] - camera[2]];
    let reach = libm::sqrtf(delta[0] * delta[0] + delta[1] * delta[1] + delta[2] * delta[2]);
    if reach <= 0.0 {
        return 0.0;
    }
    optical_depth_along(fog, camera, delta.map(|d| d / reach), reach)
}

/// How much of the surface a ray of optical depth `depth` hides, `0..=max_opacity`
/// (`gx_fog_opacity`).
pub fn opacity_of(fog: &GpuFog, depth: f32) -> f32 {
    if depth < CLEAR_DEPTH {
        return 0.0;
    }
    (1.0 - libm::expf(-depth)).min(fog.params[3])
}

/// How much of the surface the fog hides between `camera` and `surface`, `0..=max_opacity`.
pub fn opacity(fog: &GpuFog, camera: [f32; 3], surface: [f32; 3]) -> f32 {
    opacity_of(fog, optical_depth(fog, camera, surface))
}

/// `color` seen through the fog: `color × (1 - opacity) + inscatter × opacity`.
pub fn blend(color: [f32; 3], inscatter: [f32; 3], opacity: f32) -> [f32; 3] {
    [0, 1, 2].map(|c| color[c] * (1.0 - opacity) + inscatter[c] * opacity)
}

/// The in-scatter under the flat-colour environment: the fog's colour (`gx_fog_inscatter`).
pub fn inscatter_flat(fog: &GpuFog) -> [f32; 3] {
    [fog.color[0], fog.color[1], fog.color[2]]
}

/// The direction the environment's in-scatter is read in for a ray along unit `dir`: its azimuth at
/// [`HORIZON_SLOPE`] above the horizon (a vertical ray reads towards +z; `gx_fog_horizon`).
pub fn horizon_direction(dir: [f32; 3]) -> [f32; 3] {
    let around = libm::sqrtf(dir[0] * dir[0] + dir[2] * dir[2]);
    let azimuth = if around > 1e-6 { [dir[0] / around, dir[2] / around] } else { [0.0, 1.0] };
    let flat = [azimuth[0], HORIZON_SLOPE, azimuth[1]];
    let length = libm::sqrtf(flat[0] * flat[0] + flat[1] * flat[1] + flat[2] * flat[2]);
    flat.map(|c| c / length)
}

/// The sun lobe's Henyey-Greenstein phase at `cos_theta` between the ray and the sun
/// (`gx_fog_phase`).
pub fn sun_phase(cos_theta: f32) -> f32 {
    let g2 = SUN_G * SUN_G;
    let denominator = (1.0 + g2 - 2.0 * SUN_G * cos_theta).max(1e-4);
    (1.0 - g2) / (4.0 * core::f32::consts::PI * denominator * libm::sqrtf(denominator))
}

/// How much of the sun's lobe stays as the sun sets: 1 above the horizon, 0 a [`SET_BAND`] under
/// it (`gx_fog_sun_up`). The sun's colour itself is the frame's, already as it reaches the ground.
pub fn sun_up(sun_y: f32) -> f32 {
    let setting = ((sun_y + SET_BAND) / SET_BAND).clamp(0.0, 1.0);
    setting * setting * (3.0 - 2.0 * setting)
}

/// The in-scatter under a sky or an HDR map (`gx_fog_inscatter` with `frame.ambient.w` 1): the
/// environment's radiance towards the horizon in `dir`'s azimuth (`sky`: the prefiltered cube read
/// at [`horizon_direction`] and [`ENV_ROUGHNESS`]) plus the sun's forward lobe, both tinted by the
/// fog's colour. `sun_dir` is unit and `sun_color` the sun's radiance as it reaches the ground (the
/// frame's: under the sky already through the atmosphere, under a map its analytic sun), so the
/// lobe never reddens it again (pass-1 gate: a second analytic air mass turned a low sun's fog orange).
pub fn inscatter_env(fog: &GpuFog, sky: [f32; 3], dir: [f32; 3], sun_dir: [f32; 3], sun_color: [f32; 3]) -> [f32; 3] {
    let cos_theta = dir[0] * sun_dir[0] + dir[1] * sun_dir[1] + dir[2] * sun_dir[2];
    let share = SUN_SHARE * sun_phase(cos_theta) * sun_up(sun_dir[1]);
    [0, 1, 2].map(|c| fog.color[c] * (sky[c] + sun_color[c] * share))
}

/// The fog's colour in the aerial-perspective volume's texel `(rgb in-scatter, a transmittance)`:
/// `color × a + rgb` (`gx_apply_aerial`).
pub fn apply_aerial(color: [f32; 3], aerial: [f32; 4]) -> [f32; 3] {
    [0, 1, 2].map(|c| color[c] * aerial[3] + aerial[c])
}

/// The distance along its ray of the volume's slice coordinate `w` (`0..=1`): the square of `w`
/// over [`AERIAL_RANGE`], dense near the camera.
pub fn aerial_slice_distance(w: f32) -> f32 {
    let w = w.clamp(0.0, 1.0);
    AERIAL_RANGE * w * w
}

/// The volume's slice coordinate of the point `distance` along its ray (`gx_aerial_uvw`'s z).
pub fn aerial_slice_coordinate(distance: f32) -> f32 {
    libm::sqrtf((distance / AERIAL_RANGE).clamp(0.0, 1.0))
}

/// The volume coordinate of `world` seen from `camera` through `view_proj` (column-major, wgpu's
/// clip space): `(u, v, w)` with `(u, v)` the screen position (v down) and `w` the slice coordinate
/// of its distance (`gx_aerial_froxel`).
pub fn aerial_froxel(view_proj: &[f32; 16], camera: [f32; 3], world: [f32; 3]) -> [f32; 3] {
    let clip = |row: usize| view_proj[row] * world[0] + view_proj[4 + row] * world[1] + view_proj[8 + row] * world[2] + view_proj[12 + row];
    let w = clip(3).abs().max(1e-6);
    let u = (clip(0) / w * 0.5 + 0.5).clamp(0.0, 1.0);
    let v = (0.5 - clip(1) / w * 0.5).clamp(0.0, 1.0);
    let delta = [world[0] - camera[0], world[1] - camera[1], world[2] - camera[2]];
    let distance = libm::sqrtf(delta[0] * delta[0] + delta[1] * delta[1] + delta[2] * delta[2]);
    [u, v, aerial_slice_coordinate(distance)]
}

/// What [`AerialPerspective::encode`] reads from the sky: its atmosphere row and frame uniform and
/// its transmittance and multiple-scattering LUTs.
#[derive(Clone, Copy, Debug)]
pub struct AerialInputs<'a> {
    /// The `SkyAtmosphere` uniform (`layout::GpuSkyAtmosphere`).
    pub atmosphere: &'a Buffer,
    /// The `GxFrameV2` uniform of the frame (camera, inverse view-projection, depth convention).
    pub frame: &'a Buffer,
    /// The transmittance LUT (`sky::SkyLut::Transmittance`).
    pub transmittance: &'a TextureView,
    /// The multiple-scattering LUT (`sky::SkyLut::Multiscatter`).
    pub multiscatter: &'a TextureView,
    /// A linear clamping sampler for both.
    pub sampler: &'a Sampler,
}

/// The aerial-perspective volume and the compute pass that writes it (graph node 11, medium and
/// above): a workgroup per pixel column, a thread per slice, combined by a prefix scan.
#[derive(Debug)]
pub struct AerialPerspective {
    texture: Texture,
    view: TextureView,
    layout: BindGroupLayout,
    pipeline: Compiled<ComputePipeline>,
}

fn aerial_layout_entries() -> [BindGroupLayoutEntry; 6] {
    let compute = ShaderStages::COMPUTE;
    let uniform = |binding| BindGroupLayoutEntry {
        binding,
        visibility: compute,
        ty: BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None },
        count: None,
    };
    let lut = |binding| BindGroupLayoutEntry {
        binding,
        visibility: compute,
        ty: BindingType::Texture {
            sample_type: wgpu::TextureSampleType::Float { filterable: true },
            view_dimension: wgpu::TextureViewDimension::D2,
            multisampled: false,
        },
        count: None,
    };
    [
        uniform(0),
        uniform(1),
        lut(2),
        lut(3),
        BindGroupLayoutEntry { binding: 4, visibility: compute, ty: BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None },
        BindGroupLayoutEntry {
            binding: 5,
            visibility: compute,
            ty: BindingType::StorageTexture { access: wgpu::StorageTextureAccess::WriteOnly, format: AERIAL_FORMAT, view_dimension: wgpu::TextureViewDimension::D3 },
            count: None,
        },
    ]
}

impl AerialPerspective {
    /// The volume and its pipeline on `device`.
    pub fn new(device: &Device) -> Result<AerialPerspective, RenderError> {
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("aerial perspective"),
            size: wgpu::Extent3d { width: AERIAL_SIDE, height: AERIAL_SIDE, depth_or_array_layers: AERIAL_SIDE },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D3,
            format: AERIAL_FORMAT,
            usage: TextureUsages::STORAGE_BINDING | TextureUsages::TEXTURE_BINDING | TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor { dimension: Some(wgpu::TextureViewDimension::D3), ..Default::default() });
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("aerial perspective"), entries: &aerial_layout_entries() });
        let module = crate::shaders::module(device, "aerial perspective", crate::shaders::AERIAL_PERSPECTIVE)?;
        let pipeline_layout = crate::tables::pipeline_layout(device, "aerial perspective", &[&layout]);
        let pipeline = crate::compile::compute_pipeline(device, &wgpu::ComputePipelineDescriptor {
            label: Some("aerial perspective"),
            layout: Some(&pipeline_layout),
            module: &module,
            entry_point: Some("cs_aerial_perspective"),
            compilation_options: Default::default(),
            cache: None,
        });
        Ok(AerialPerspective { texture, view, layout, pipeline })
    }

    /// The volume as a sampled 3D view (rgb in-scatter, a transmittance).
    pub fn view(&self) -> &TextureView {
        &self.view
    }

    /// The volume's texture (diagnostics and tests copy from it).
    pub fn texture(&self) -> &Texture {
        &self.texture
    }

    /// Record the volume's compute pass for `inputs` into `encoder` (timestamped by
    /// `timestamp_writes`): one pass, every slice.
    pub fn encode(
        &self,
        device: &Device,
        encoder: &mut CommandEncoder,
        inputs: &AerialInputs<'_>,
        timestamp_writes: Option<wgpu::ComputePassTimestampWrites<'_>>,
    ) -> PassCounters {
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("aerial perspective"),
            layout: &self.layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: inputs.atmosphere.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: inputs.frame.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(inputs.transmittance) },
                wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::TextureView(inputs.multiscatter) },
                wgpu::BindGroupEntry { binding: 4, resource: wgpu::BindingResource::Sampler(inputs.sampler) },
                wgpu::BindGroupEntry { binding: 5, resource: wgpu::BindingResource::TextureView(&self.view) },
            ],
        });
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("aerial perspective"), timestamp_writes });
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &group, &[]);
        // One workgroup of 32 threads (one per slice) per pixel column.
        pass.dispatch_workgroups(AERIAL_SIDE, AERIAL_SIDE, 1);
        PassCounters { compute: 1, ..PassCounters::default() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::{Look, RenderFeature};

    fn foggy() -> Quality {
        let mut quality = Quality::off();
        quality.set_feature(RenderFeature::Fog, true);
        quality
    }

    #[test]
    fn the_default_look_draws_no_fog_on_any_quality() {
        let look = Look::default();
        assert!(!look.fog.is_on());
        assert_eq!(gpu_fog(&look.fog, &foggy()).color[3], 0.0);
        assert_eq!(opacity(&gpu_fog(&look.fog, &foggy()), [0.0; 3], [0.0, 0.0, -1000.0]), 0.0);
    }

    #[test]
    fn the_quality_switch_turns_a_look_s_fog_off() {
        let fog = Fog::default().with_density(0.05);
        assert_eq!(gpu_fog(&fog, &foggy()).color[3], 0.05);
        assert_eq!(gpu_fog(&fog, &Quality::off()).color[3], 0.0, "fog off in the quality");
    }

    #[test]
    fn uniform_fog_is_beer_lambert_over_the_distance_past_its_start() {
        let fog = gpu_fog(&Fog::default().with_density(0.1).with_height(0.0, 0.0).with_range(10.0, 1.0), &foggy());
        let depth = optical_depth(&fog, [0.0, 0.0, 0.0], [0.0, 0.0, -30.0]);
        assert!((depth - 2.0).abs() < 1e-5, "0.1 × (30 - 10): {depth}");
        assert_eq!(opacity(&fog, [0.0; 3], [0.0, 0.0, -5.0]), 0.0, "nearer than the start");
        assert!((opacity(&fog, [0.0; 3], [0.0, 0.0, -30.0]) - (1.0 - libm::expf(-2.0))).abs() < 1e-5);
    }

    #[test]
    fn height_fog_thins_upwards_and_the_opacity_is_capped() {
        let fog = gpu_fog(&Fog::default().with_density(0.2).with_height(0.5, 0.0).with_range(0.0, 0.6), &foggy());
        let low = optical_depth(&fog, [0.0, 0.0, 0.0], [100.0, 0.0, 0.0]);
        let high = optical_depth(&fog, [0.0, 10.0, 0.0], [100.0, 10.0, 0.0]);
        assert!(high < low * 0.01, "{high} vs {low}");
        // A sloped ray agrees with a fine numeric integral.
        let (camera, surface) = ([0.0, 0.0, 0.0], [40.0, 6.0, 0.0]);
        let steps = 20_000;
        let length = libm::sqrtf(40.0 * 40.0 + 36.0);
        let numeric: f32 = (0..steps).map(|i| 0.2 * libm::expf(-0.5 * 6.0 * (i as f32 + 0.5) / steps as f32) * length / steps as f32).sum();
        assert!((optical_depth(&fog, camera, surface) - numeric).abs() < 1e-3 * numeric, "{numeric}");
        assert_eq!(opacity(&fog, [0.0; 3], [1e4, 0.0, 0.0]), 0.6, "never past the largest opacity");
    }

    #[test]
    fn aerial_perspective_needs_both_the_quality_and_the_look() {
        let mut quality = foggy();
        let fog = Fog::default();
        assert!(!aerial_perspective(&fog, &quality));
        quality.environment.aerial_perspective = true;
        assert!(aerial_perspective(&fog, &quality));
        assert!(!aerial_perspective(&fog.with_aerial_perspective(false), &quality));
    }
}
