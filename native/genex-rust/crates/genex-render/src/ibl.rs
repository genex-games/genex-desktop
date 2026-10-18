//! Image-based lighting baked on the GPU (plan §2.2 node 11; RQ2). An [`Environment`] other than
//! the flat colour is baked into what the frame binds (`layout::FRAME_ENV_BINDINGS`, and the same
//! names in the Level-2 v2 material map):
//! - a prefiltered specular cube (`rgba16float`, [`SPECULAR_MIPS`] roughness levels spaced
//!   perceptually, [`mip_roughness`]): the map or the sky straight into mip 0 at full size
//!   (`shaders/ibl/equirect.wgsl`), then a GGX prefilter per mip by filtered importance sampling
//!   (`prefilter.wgsl`) from a radiance cube at half the specular side ([`radiance_side`], box
//!   mips; phones cap it at 64 px) that the same equirect pass writes, so the sharpest lobes read
//!   a source as fine as their own mip (SI-01);
//! - the diffuse irradiance as SH9 (`GxEnvSh`, `sh9.wgsl`, one 64-thread workgroup over the
//!   radiance cube's [`SH9_SOURCE_SIDE`]² mip; the physical sky's straight from its sky-view LUT
//!   on every frame the LUT changes, [`SKY_SH_SOURCE_SIDE`]), deringed where it would go negative
//!   ([`sh9_dering`]), in the convention [`sh9_eval`] holds on the CPU;
//! - the split-sum BRDF LUT ([`BRDF_LUT_SIZE`]² `rg16float`), written once by a fragment pass with
//!   the height-correlated Smith GGX the shading uses ([`brdf_lut_reference`] is its CPU twin).
//!
//! The source ([`SourceKind`]) is an equirectangular HDRI ([`EnvironmentMaps::set_map`], its own
//! mips built on the GPU, turned and scaled as the environment says) or the physical sky without
//! its sun disk, which [`SkyState::encode_cube`] writes into every face's mip 0 at once on the
//! first source step (RQ2.2; the analytic sun lights the scene directly). The first bake is whole
//! and synchronous (a cold bake). A later change (a new environment, a new cube size from dynamic
//! resolution, a sun past the quality's threshold) is rebaked into a second set of cubes on a fixed
//! schedule of [`SLICE_STEPS`] steps, one face × mip group per step ([`SliceStep`]), one step every
//! [`EnvironmentQuality::rebake_cadence`] frames (frame-indexed). The frame keeps binding the last
//! complete bake until the rebake's last step, then binds the new one whole: no frame ever samples
//! a cube mixing two environments. A rebake whose environment, source or size changes before it
//! completes starts over (the cubes it was writing were never bound); a sun that keeps moving
//! finishes its cycle first. A settled capture bakes whole whenever anything differs from the last
//! complete bake, so it equals a capture after a cold bake; the bake it binds is the one Live
//! frames bind afterwards (the environment bake is capture-shared state, see `settle.rs`).
//! Nothing changed: no work at all. Compute writes follow plan §2.3's format rules
//! (`layout::COMPUTE_STORAGE_FORMATS`).
//!
//! [`LANDED`] stays false until the shading that reads the bake lands (RQ2.4): until then node 11
//! runs only its sky part, [`EnvironmentMaps::encode`] records nothing and the frame binds the
//! neutral inputs, so the picture is the flat ambient one. [`EnvironmentMaps::bake`] runs the bake
//! itself (the tests' entry point, and the node's once landed).

use crate::compile::Compiled;
use std::ops::Range;

use wgpu::{
    BindGroup, BindGroupLayout, BindGroupLayoutEntry, BindingResource, Buffer, BufferUsages, CommandEncoder, ComputePass, ComputePipeline, Device, Queue,
    RenderPipeline, Sampler, ShaderStages, Texture, TextureFormat, TextureUsages, TextureView, TextureViewDimension,
};

use crate::abi::{GxEnvSh, MATERIAL_V2_BINDINGS, NeutralInputs, V2Binding};
use crate::error::{RenderCode, RenderError};
use crate::graph::{EnvironmentFrame, FrameEncoder, PassCounters};
use crate::hdri::{AnalyticSun, HdriImage, PreparedMap};
use crate::layout::GpuIblBake;
use crate::settings::{Environment, EnvironmentQuality, HdriEnvironment, HdriSun};
use crate::sky::SkyState;
use crate::target_pool::TargetDesc;

/// Whether the graph schedules the bake (node 11's IBL part and the `ibl` switch). It turns true
/// with the shading that reads the bake (`lighting/ambient.wgsl`, RQ2.4); the bake itself
/// ([`EnvironmentMaps::bake`]) works either way.
pub const LANDED: bool = true;
/// The split-sum BRDF LUT's side.
pub const BRDF_LUT_SIZE: u32 = 128;
/// The BRDF LUT's format: written by a fragment pass (core has no `rg16float` storage).
pub const BRDF_LUT_FORMAT: TextureFormat = TextureFormat::Rg16Float;
/// Hammersley points the BRDF LUT integrates each texel over (`BRDF_LUT_SAMPLES` in
/// `brdf_lut.wgsl`).
pub const BRDF_LUT_SAMPLES: u32 = 2048;
/// The specular and radiance cubes' format (write-only storage in compute).
pub const ENV_CUBE_FORMAT: TextureFormat = TextureFormat::Rgba16Float;
/// Roughness levels of the specular cube (one mip each, spaced perceptually: [`mip_roughness`]).
/// Six (RQ2 review; five linear before): a read between two levels mixes lobes close to its own.
pub const SPECULAR_MIPS: u32 = 6;
/// The largest specular cube side (an HDR map on ultra).
pub const CUBE_SIZE_MAX: u32 = 512;
/// The smallest specular cube side (its last roughness mip is then one texel).
pub const CUBE_SIZE_MIN: u32 = 1 << (SPECULAR_MIPS - 1);
/// The side of the radiance mip SH9 projects (six faces of this many texels squared).
pub const SH9_SOURCE_SIDE: u32 = 16;
/// The side of the cube the physical sky's SH9 is projected from (SI-02): the sky-view LUT read
/// into six faces of this many texels squared on every frame the LUT changes, so the diffuse light
/// follows a moving sun continuously instead of stepping once per rebake (the radiance cube's
/// [`SH9_SOURCE_SIDE`]: the one 64-thread projection over 32 px faces took 0.3 ms).
pub const SKY_SH_SOURCE_SIDE: u32 = SH9_SOURCE_SIDE;
/// The bands of the SH9 window's cutoff (Sloan's deringing): from this, the strongest window
/// tried (it keeps any non-negative environment's irradiance non-negative)...
pub const SH9_WINDOW_MIN: f32 = 3.0;
/// ... to this, the weakest (Filament's `4 · bands + 1`).
pub const SH9_WINDOW_MAX: f32 = 13.0;
/// Bisection steps of the window's cutoff (fixed: two bakes are byte-identical).
pub const SH9_WINDOW_STEPS: u32 = 16;
/// Texel centres per face side of the directions the SH9's minimum is taken over (six faces).
pub const SH9_MIN_GRID: u32 = 8;
/// Threads of the SH9 projection's one workgroup (plan §2.3: at most 64).
pub const SH9_THREADS: u32 = 64;
/// The cosine lobe's `A_l / pi` per band (0, 1, 2): what the SH9 bake multiplies each band's
/// radiance projection by, so [`sh9_eval`] is the radiance a white Lambertian surface reflects.
pub const SH9_LOBE: [f32; 3] = [1.0, 2.0 / 3.0, 0.25];
/// How far the sun turns before the sky is rebaked into the environment, in degrees, when the
/// quality says nothing ([`EnvironmentQuality::sun_rebake_tenths`] 0).
pub const SUN_REBAKE_DEGREES: f32 = 0.5;
/// How much the sun's radiance changes (relative, per channel) before the sky is rebaked.
pub const SUN_REBAKE_RADIANCE: f32 = 0.02;
/// Steps of a time-sliced rebake: six source faces, six prefiltered faces, then SH9.
pub const SLICE_STEPS: u32 = 13;
/// How far the sun turns before a quality that rebakes continuously
/// ([`EnvironmentQuality::continuous_sky`], SI-02 step 2) rebakes the sky whole, in degrees: a
/// moving sun's cube follows it every frame instead of stepping once per time-sliced cycle.
pub const CONTINUOUS_SUN_DEGREES: f32 = 0.02;
/// GGX samples per texel of a continuous rebake's prefilter (renderer pass 2 A.3, SI-02 step 2):
/// filtered importance sampling reads a mip of the source whose texels cover each sample's solid
/// angle, so the physical sky (smooth, its sun disk analytic) prefilters within the half-float's
/// precision from 32 samples, a quarter of a 256 px cube's [`prefilter_samples`], and a whole bake
/// fits a frame's share. A cold bake and a settled capture keep the full count.
pub const CONTINUOUS_PREFILTER_SAMPLES: u32 = 32;

/// Pool labels of the environment's targets.
const SPECULAR_LABEL: &str = "env specular";
const RADIANCE_LABEL: &str = "env radiance";
const BRDF_LUT_LABEL: &str = "brdf lut";
const SKY_SH_LABEL: &str = "env sky sh source";
/// Usages of the cubes: written as storage, sampled as cubes, read back by captures and tests.
const CUBE_USAGE: TextureUsages = TextureUsages::STORAGE_BINDING.union(TextureUsages::TEXTURE_BINDING).union(TextureUsages::COPY_SRC);
/// Usages of the BRDF LUT: a fragment pass's attachment, sampled, read back by tests.
const LUT_USAGE: TextureUsages = TextureUsages::RENDER_ATTACHMENT.union(TextureUsages::TEXTURE_BINDING).union(TextureUsages::COPY_SRC);
/// Usages of an uploaded equirect map: written, its mips built as storage, sampled.
const MAP_USAGE: TextureUsages = TextureUsages::COPY_DST.union(TextureUsages::STORAGE_BINDING).union(TextureUsages::TEXTURE_BINDING);
/// Workgroup side of the bake's 2D compute passes.
const WORKGROUP_SIDE: u32 = 8;
/// Faces of a cube.
const FACES: u32 = 6;
/// Bytes of the SH9 block.
const SH_BYTES: u64 = size_of::<GxEnvSh>() as u64;
/// Stride of the bake's uniform slots: WebGPU core's `min_uniform_buffer_offset_alignment`.
const SLOT_BYTES: u64 = 256;
/// Uniform slots: the source pass, the downsample, SH9, the prefilter per roughness mip (1..),
/// and the uploaded map's mip chain.
const SLOT_SOURCE: u64 = 0;
const SLOT_DOWNSAMPLE: u64 = 1;
const SLOT_SH9: u64 = 2;
const SLOT_PREFILTER: u64 = 3;
const SLOT_MAP: u64 = SLOT_PREFILTER + SPECULAR_MIPS as u64;
const SLOTS: u64 = SLOT_MAP + 1;

/// Samples per texel of the GGX prefilter for a cube of `cube_size` (a fixed count per size, so
/// two bakes are byte-identical): filtered importance sampling needs few.
pub const fn prefilter_samples(cube_size: u32) -> u32 {
    match cube_size {
        0..=64 => 32,
        65..=128 => 64,
        _ => 128,
    }
}

/// The GGX perceptual roughness specular mip `mip` holds: the inverse of the lookup's
/// `lod = last · r · (2 − r)` ([`roughness_lod`], Filament's mapping), so the low roughnesses a
/// mirror-like surface shows get most of the levels (0, 0.106, 0.225, 0.368, 0.553, 1 over six
/// mips) and a roughness between two levels blends two lobes close to its own.
pub fn mip_roughness(mip: u32) -> f32 {
    let last = (SPECULAR_MIPS - 1) as f32;
    let level = mip.min(SPECULAR_MIPS - 1) as f32 / last;
    1.0 - libm::sqrtf(1.0 - level)
}

/// The specular cube's level of detail for perceptual `roughness` (`gx_env_lod` in the lighting
/// chunks): `last · r · (2 − r)` over the cube's [`SPECULAR_MIPS`] levels.
pub fn roughness_lod(roughness: f32) -> f32 {
    let r = roughness.clamp(0.0, 1.0);
    (SPECULAR_MIPS - 1) as f32 * r * (2.0 - r)
}

/// The mips of a texture whose larger side is `side`, down to 1 texel.
pub(crate) fn full_mips(side: u32) -> u32 {
    u32::BITS - side.max(1).leading_zeros()
}

/// `size` rounded down to a power of two within [`CUBE_SIZE_MIN`]..=[`CUBE_SIZE_MAX`].
fn power_side(size: u32) -> u32 {
    let side = size.clamp(CUBE_SIZE_MIN, CUBE_SIZE_MAX);
    1 << (u32::BITS - 1 - side.leading_zeros())
}

/// The specular cube's side under `quality` for the sky: its cube size rounded down to a power of
/// two within [`CUBE_SIZE_MIN`]..=[`CUBE_SIZE_MAX`], or None with IBL off.
pub fn cube_side(quality: &EnvironmentQuality) -> Option<u32> {
    if !quality.ibl || quality.cube_size == 0 {
        return None;
    }
    Some(power_side(quality.cube_size))
}

/// The specular cube's side under `quality` for `environment`: an HDR map's
/// [`EnvironmentQuality::hdri_cube_size`] (its cube size when 0), else [`cube_side`].
pub fn cube_side_for(quality: &EnvironmentQuality, environment: &Environment) -> Option<u32> {
    let side = cube_side(quality)?;
    match environment {
        Environment::Hdri(_) if quality.hdri_cube_size > 0 => Some(power_side(quality.hdri_cube_size)),
        _ => Some(side),
    }
}

/// The largest specular cube `quality` bakes, whatever the environment.
fn largest_side(quality: &EnvironmentQuality) -> Option<u32> {
    let sky = cube_side(quality)?;
    let map = if quality.hdri_cube_size > 0 { power_side(quality.hdri_cube_size) } else { sky };
    Some(sky.max(map))
}

/// The radiance cube's side for a specular cube of `side`: half of it, uncapped (SI-01). The
/// prefilter's sharpest mip (1, half the specular side) then reads a source as fine as itself:
/// filtered importance sampling's level for its median sample is -0.2 at 128 (64 samples), +0.3
/// at 256 and +1.3 at 512 (128 samples), where a 32 px cap asked for -1.7 at 256 and read a lobe
/// blurred 3 to 6 times its own width. `side_max` (`EnvironmentQuality::radiance_side_max`, 0:
/// none) caps it: phones keep a quarter of their largest cube for their memory budget.
pub const fn radiance_side(side: u32, side_max: u32) -> u32 {
    let half = side / 2;
    if side_max == 0 || half <= side_max { half } else { side_max }
}

/// The radiance mip SH9 projects: the first whose side is at most [`SH9_SOURCE_SIDE`].
fn sh9_mip(radiance: u32) -> u32 {
    full_mips(radiance) - full_mips(SH9_SOURCE_SIDE.min(radiance))
}

/// The pooled targets the bake writes under `quality` (empty with IBL off): the specular cube and
/// the radiance cube it is prefiltered from (each six layers, write-only storage in compute,
/// sampled as a cube) and the BRDF LUT (a fragment pass's attachment). Each passes the pool's core
/// check (`target_pool::validate`); the bake allocates the cubes itself, as six-layer textures.
pub fn target_descs(quality: &EnvironmentQuality) -> Vec<TargetDesc> {
    let Some(side) = largest_side(quality) else {
        return Vec::new();
    };
    let cube = |label, side, mips| TargetDesc { label, format: ENV_CUBE_FORMAT, usage: CUBE_USAGE, samples: 1, size: (side, side), mips, srgb_view: false };
    let radiance = radiance_side(side, quality.radiance_side_max);
    vec![
        cube(SPECULAR_LABEL, side, SPECULAR_MIPS),
        cube(RADIANCE_LABEL, radiance, full_mips(radiance)),
        TargetDesc {
            label: BRDF_LUT_LABEL,
            format: BRDF_LUT_FORMAT,
            usage: LUT_USAGE,
            samples: 1,
            size: (BRDF_LUT_SIZE, BRDF_LUT_SIZE),
            mips: 1,
            srgb_view: false,
        },
    ]
}

/// The bytes the bake holds under `quality` at most, by part, at its largest cube (None with IBL
/// off): the specular cubes, the radiance cube with the SH9 blocks and the sky's SH9 source (the
/// diffuse irradiance), and the BRDF LUT. Two sets of specular cubes and SH9 ([`BAKE_SETS`]: the
/// bound bake and the rebake behind it) over one shared radiance cube, six faces each, every mip.
/// The budget registers exactly these (`budget::ledger`).
pub fn bake_parts(quality: &EnvironmentQuality) -> Option<(u64, u64, u64)> {
    let descs = target_descs(quality);
    let [specular, radiance, lut] = descs.as_slice() else {
        return None;
    };
    let faces = u64::from(FACES);
    // One radiance cube for both sets (`EnvironmentMaps::ensure_back` shares it), an SH9 block each.
    let irradiance = faces * radiance.bytes() + BAKE_SETS * SH_BYTES + SKY_SH_SOURCE_BYTES;
    Some((BAKE_SETS * faces * specular.bytes(), irradiance, lut.bytes()))
}

/// Bytes of the sky's SH9 source cube ([`SKY_SH_SOURCE_SIDE`], six faces, one mip): one, shared
/// by both sets.
const SKY_SH_SOURCE_BYTES: u64 = FACES as u64 * SKY_SH_SOURCE_SIDE as u64 * SKY_SH_SOURCE_SIDE as u64 * 8;

/// The bytes the bake holds under `quality` at most (0 with IBL off): the sum of [`bake_parts`].
pub fn bake_bytes(quality: &EnvironmentQuality) -> u64 {
    bake_parts(quality).map_or(0, |(specular, irradiance, lut)| specular + irradiance + lut)
}

/// Sets of cubes and SH9 the bake holds: the bound one and the one a rebake writes.
pub const BAKE_SETS: u64 = 2;

// --- CPU twins of the shaders' geometry and integrals ---

/// The world direction through texel coordinate `(u, v)` (0..1, v down) of cube face `face`, in
/// WebGPU's cube convention (+X, -X, +Y, -Y, +Z, -Z): `ibl_cube_direction` in the bake shaders.
pub fn cube_direction(face: u32, u: f32, v: f32) -> [f32; 3] {
    let (s, t) = (u * 2.0 - 1.0, v * 2.0 - 1.0);
    let d = match face {
        0 => [1.0, -t, -s],
        1 => [-1.0, -t, s],
        2 => [s, 1.0, t],
        3 => [s, -1.0, -t],
        4 => [s, -t, 1.0],
        _ => [-s, -t, -1.0],
    };
    let length = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
    d.map(|c| c / length)
}

/// The equirect coordinate of unit direction `d` (`ibl_equirect_uv`): u = 0.5 + atan2(z, x) / 2pi
/// (wrapping), v = acos(y) / pi, so the map's top row is straight up (+Y).
pub fn equirect_uv(d: [f32; 3]) -> [f32; 2] {
    let u = 0.5 + libm::atan2f(d[2], d[0]) / (2.0 * core::f32::consts::PI);
    let v = libm::acosf(d[1].clamp(-1.0, 1.0)) / core::f32::consts::PI;
    [u, v]
}

/// The unit direction at equirect coordinate `(u, v)` (the inverse of [`equirect_uv`]).
pub fn equirect_direction(u: f32, v: f32) -> [f32; 3] {
    let phi = (u - 0.5) * 2.0 * core::f32::consts::PI;
    let theta = v * core::f32::consts::PI;
    let sin_theta = libm::sinf(theta);
    [sin_theta * libm::cosf(phi), libm::cosf(theta), sin_theta * libm::sinf(phi)]
}

/// The map direction a map turned `rotation` radians about up shows in world direction `world`
/// (what the bake samples): what lies in map direction m is seen in world direction R(rotation) m.
pub fn map_direction(world: [f32; 3], rotation: f32) -> [f32; 3] {
    let (s, c) = (libm::sinf(rotation), libm::cosf(rotation));
    [c * world[0] - s * world[2], world[1], s * world[0] + c * world[2]]
}

/// Point `i` of the `n`-point Hammersley set (`n` a power of two; `ibl_hammersley`), each
/// coordinate centred in its stratum, so the set's mean is the unit square's centre: an estimate
/// over it carries no half-stratum bias.
pub fn hammersley(i: u32, n: u32) -> [f64; 2] {
    let half = 0.5 / f64::from(n);
    [f64::from(i) / f64::from(n) + half, f64::from(i.reverse_bits()) * 2.328_306_436_538_696_3e-10 + half]
}

/// A GGX-distributed half vector in tangent space (z along the normal) for the point `xi` and
/// GGX `alpha` (`ibl_ggx_half_vector`).
pub fn ggx_half_vector(xi: [f64; 2], alpha: f64) -> [f64; 3] {
    let a2 = alpha * alpha;
    let phi = 2.0 * core::f64::consts::PI * xi[0];
    let cos_theta = ((1.0 - xi[1]) / (1.0 + (a2 - 1.0) * xi[1])).sqrt();
    let sin_theta = (1.0 - cos_theta * cos_theta).max(0.0).sqrt();
    [sin_theta * libm::cos(phi), sin_theta * libm::sin(phi), cos_theta]
}

/// The height-correlated Smith GGX visibility `G / (4 N.L N.V)` (Heitz 2014; Filament's
/// `V_SmithGGXCorrelated`), the term RQ2.4's shading and the LUT use.
pub fn smith_ggx_correlated(n_dot_v: f64, n_dot_l: f64, alpha: f64) -> f64 {
    let a2 = alpha * alpha;
    let lambda_v = n_dot_l * (n_dot_v * n_dot_v * (1.0 - a2) + a2).sqrt();
    let lambda_l = n_dot_v * (n_dot_l * n_dot_l * (1.0 - a2) + a2).sqrt();
    0.5 / (lambda_v + lambda_l)
}

/// A GGX half vector distributed as the normals visible from `v` (Heitz 2018, "Sampling the GGX
/// Distribution of Visible Normals"; isotropic `alpha`, z along the normal) for the point `xi`
/// (`ibl_ggx_visible_normal`).
pub fn ggx_visible_normal(xi: [f64; 2], v: [f64; 3], alpha: f64) -> [f64; 3] {
    let normalize = |d: [f64; 3]| {
        let length = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
        d.map(|c| c / length)
    };
    let vh = normalize([alpha * v[0], alpha * v[1], v[2]]);
    let lensq = vh[0] * vh[0] + vh[1] * vh[1];
    let t1 = if lensq > 0.0 { [-vh[1] / lensq.sqrt(), vh[0] / lensq.sqrt(), 0.0] } else { [1.0, 0.0, 0.0] };
    let t2 = [vh[1] * t1[2] - vh[2] * t1[1], vh[2] * t1[0] - vh[0] * t1[2], vh[0] * t1[1] - vh[1] * t1[0]];
    let r = xi[0].sqrt();
    let phi = 2.0 * core::f64::consts::PI * xi[1];
    let p1 = r * libm::cos(phi);
    let s = 0.5 * (1.0 + vh[2]);
    let p2 = (1.0 - s) * (1.0 - p1 * p1).max(0.0).sqrt() + s * r * libm::sin(phi);
    let p3 = (1.0 - p1 * p1 - p2 * p2).max(0.0).sqrt();
    let nh = [0, 1, 2].map(|k| p1 * t1[k] + p2 * t2[k] + p3 * vh[k]);
    normalize([alpha * nh[0], alpha * nh[1], nh[2].max(0.0)])
}

/// The split-sum BRDF integral at `n_dot_v` and perceptual `roughness` (alpha = roughness²), in
/// f64 over the first `samples` Hammersley points: the scale and bias of F0 such that the
/// specular integral of a white environment is `F0 * scale + bias`. Visible-normal sampling makes
/// each sample's weight `F * G2 / G1(v)`, so [`BRDF_LUT_SAMPLES`] points converge to well under
/// half an `rg16float` step. The LUT's texel `(x, y)` holds it at
/// `((x + 0.5) / size, (y + 0.5) / size)` with [`BRDF_LUT_SAMPLES`].
pub fn brdf_lut_reference(n_dot_v: f64, roughness: f64, samples: u32) -> [f64; 2] {
    let alpha = roughness * roughness;
    let a2 = alpha * alpha;
    let v = [(1.0 - n_dot_v * n_dot_v).max(0.0).sqrt(), 0.0, n_dot_v];
    // G2 / G1(v) = Vis * 4 N.L N.V / G1(v), with G1(v) = 2 N.V / (N.V + sqrt(a2 + (1 - a2) N.V^2)).
    let over_g1 = 2.0 * (n_dot_v + (a2 + (1.0 - a2) * n_dot_v * n_dot_v).sqrt());
    let (mut scale, mut bias) = (0.0, 0.0);
    for i in 0..samples {
        let h = ggx_visible_normal(hammersley(i, samples), v, alpha);
        let v_dot_h = v[0] * h[0] + v[1] * h[1] + v[2] * h[2];
        let n_dot_l = 2.0 * v_dot_h * h[2] - v[2];
        if n_dot_l > 0.0 && v_dot_h > 0.0 {
            let weight = smith_ggx_correlated(n_dot_v, n_dot_l, alpha) * n_dot_l * over_g1;
            let f = 1.0 - v_dot_h;
            let fresnel = f * f * f * f * f;
            scale += (1.0 - fresnel) * weight;
            bias += fresnel * weight;
        }
    }
    [scale / f64::from(samples), bias / f64::from(samples)]
}

/// The real SH basis at unit direction `d` (band order L00; L1-1, L10, L11; L2-2, L2-1, L20,
/// L21, L22), as `lighting/ambient.wgsl` evaluates it.
pub fn sh9_basis(d: [f32; 3]) -> [f32; 9] {
    let [x, y, z] = d;
    [
        0.282_095,
        0.488_603 * y,
        0.488_603 * z,
        0.488_603 * x,
        1.092_548 * x * y,
        1.092_548 * y * z,
        0.315_392 * (3.0 * z * z - 1.0),
        1.092_548 * x * z,
        0.546_274 * (x * x - y * y),
    ]
}

/// The CPU twin of `gx_env_irradiance`: the radiance a white Lambertian surface facing `n`
/// reflects under `sh` (never negative).
pub fn sh9_eval(sh: &GxEnvSh, n: [f32; 3]) -> [f32; 3] {
    let basis = sh9_basis(n);
    let mut sum = [0.0_f32; 3];
    for (coefficient, weight) in sh.coefficients.iter().zip(basis) {
        for (channel, value) in sum.iter_mut().zip(coefficient) {
            *channel += value * weight;
        }
    }
    sum.map(|value| value.max(0.0))
}

/// The value of the SH9 `sh` at unit `n`, channel `channel`, with bands 1 and 2 scaled by
/// `window` (`ibl_sh9_windowed` in `sh9.wgsl`), not clamped.
pub fn sh9_windowed(sh: &GxEnvSh, n: [f32; 3], channel: usize, window: [f32; 2]) -> f32 {
    let basis = sh9_basis(n);
    let band = |index: usize| match sh9_band(index) {
        0 => 1.0,
        1 => window[0],
        _ => window[1],
    };
    (0..9).map(|index| sh.coefficients[index][channel] * basis[index] * band(index)).sum()
}

/// Sloan's sinc⁴ window of band `band` for a cutoff of `cutoff` bands (Filament's
/// `CubemapSH::sincWindow`, Apache-2.0; `ibl_sh9_window`): 1 for band 0, falling to 0 at the
/// cutoff.
pub fn sh9_window(band: u32, cutoff: f32) -> f32 {
    if band == 0 {
        return 1.0;
    }
    if band as f32 >= cutoff {
        return 0.0;
    }
    let x = core::f32::consts::PI * band as f32 / cutoff;
    let sinc = libm::sinf(x) / x;
    sinc * sinc * sinc * sinc
}

/// The unit directions the SH9's minimum is taken over (`sh9.wgsl`'s): the centres of an
/// [`SH9_MIN_GRID`]² grid on each cube face, in point order (face, row, column).
pub fn sh9_min_directions() -> Vec<[f32; 3]> {
    let grid = SH9_MIN_GRID;
    (0..FACES * grid * grid)
        .map(|point| {
            let (face, x, y) = (point / (grid * grid), point % grid, (point / grid) % grid);
            cube_direction(face, (x as f32 + 0.5) / grid as f32, (y as f32 + 0.5) / grid as f32)
        })
        .collect()
}

/// The least value over [`sh9_min_directions`] and every channel of `sh` windowed by `window`.
fn sh9_min(sh: &GxEnvSh, directions: &[[f32; 3]], window: [f32; 2]) -> f32 {
    directions.iter().flat_map(|n| (0..3).map(move |channel| sh9_windowed(sh, *n, channel, window))).fold(f32::INFINITY, f32::min)
}

/// The band-1 and band-2 factors that dering `sh` (SI-05; Sloan, "Deringing Spherical
/// Harmonics", 2017; the auto-windowing of Filament's `CubemapSH::windowSH`, Apache-2.0): none
/// (`[1, 1]`) when the SH is non-negative over [`sh9_min_directions`] already, so a smooth
/// environment's SH is exactly the projection; else the weakest sinc⁴ window between
/// [`SH9_WINDOW_MIN`] and [`SH9_WINDOW_MAX`] bands that makes it non-negative there, found by
/// [`SH9_WINDOW_STEPS`] bisection steps. An HDRI with a bright compact source left in the map
/// (`HdriSun::Off`, a rejected sun, windows) otherwise rings to a black side. The CPU twin of the
/// last step of `cs_sh9`.
pub fn sh9_dering_window(sh: &GxEnvSh) -> [f32; 2] {
    let directions = sh9_min_directions();
    if sh9_min(sh, &directions, [1.0, 1.0]) >= 0.0 {
        return [1.0, 1.0];
    }
    let (mut low, mut high) = (SH9_WINDOW_MIN, SH9_WINDOW_MAX);
    for _ in 0..SH9_WINDOW_STEPS {
        let middle = 0.5 * (low + high);
        if sh9_min(sh, &directions, [sh9_window(1, middle), sh9_window(2, middle)]) < 0.0 {
            high = middle;
        } else {
            low = middle;
        }
    }
    [sh9_window(1, low), sh9_window(2, low)]
}

/// `sh` deringed ([`sh9_dering_window`]): what the bake stores.
pub fn sh9_dering(sh: &GxEnvSh) -> GxEnvSh {
    let window = sh9_dering_window(sh);
    let mut out = *sh;
    for (index, coefficient) in out.coefficients.iter_mut().enumerate() {
        let factor = match sh9_band(index) {
            0 => 1.0,
            1 => window[0],
            _ => window[1],
        };
        for value in coefficient.iter_mut().take(3) {
            *value *= factor;
        }
    }
    out
}

/// The SH9 band of coefficient `index`.
pub const fn sh9_band(index: usize) -> usize {
    match index {
        0 => 0,
        1..=3 => 1,
        _ => 2,
    }
}

/// The solid angle of texel `(x, y)` of a cube face `side` texels wide (`sh9.wgsl`'s weight): the
/// faces' texels sum to 4 pi exactly.
pub fn texel_solid_angle(side: u32, x: u32, y: u32) -> f64 {
    let area = |x: f64, y: f64| libm::atan2(x * y, (x * x + y * y + 1.0).sqrt());
    let step = 2.0 / f64::from(side);
    let (x0, y0) = (f64::from(x) * step - 1.0, f64::from(y) * step - 1.0);
    let (x1, y1) = (x0 + step, y0 + step);
    (area(x0, y0) - area(x0, y1) - area(x1, y0) + area(x1, y1)).abs()
}

// --- The time-sliced schedule ---

/// Where a bake's radiance comes from (the source steps cost differently).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SourceKind {
    /// An equirect map ([`EnvironmentMaps::set_map`]), sampled per face.
    Map,
    /// The physical sky: [`SkyState::encode_cube`] writes every face's mip 0 on the first source
    /// step; the later source steps only build their face's radiance mips.
    Sky,
}

impl SourceKind {
    /// Every kind.
    pub const ALL: [SourceKind; 2] = [SourceKind::Map, SourceKind::Sky];
}

/// One step of a rebake (plan P14): [`SLICE_STEPS`] of them in a fixed order, one per frame, so
/// a rebake's per-frame cost is bounded by the largest ([`slice_budget`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SliceStep {
    /// The source into one face: specular mip 0 and the radiance cube's mip chain.
    Source {
        /// The face (0..6).
        face: u32,
    },
    /// The GGX prefilter of one face's roughness mips (1..[`SPECULAR_MIPS`]).
    Prefilter {
        /// The face (0..6).
        face: u32,
    },
    /// The SH9 projection.
    Sh9,
}

impl SliceStep {
    /// Step `index` of the schedule (0..[`SLICE_STEPS`]; later indices are SH9): every source face
    /// first, so each prefilter reads a whole new radiance cube.
    pub const fn at(index: u32) -> SliceStep {
        match index {
            0..FACES => SliceStep::Source { face: index },
            FACES..12 => SliceStep::Prefilter { face: index - FACES },
            _ => SliceStep::Sh9,
        }
    }

    /// Texel samples the step reads for a specular cube of `side` from a `kind` source (the bake's
    /// work model), over the uncapped radiance cube: a capped one (phones) reads at most this.
    pub fn work(self, side: u32, kind: SourceKind) -> u64 {
        self.work_with(side, kind, prefilter_samples(side))
    }

    /// [`SliceStep::work`] with the prefilter reading `samples` per texel (a continuous rebake's
    /// [`CONTINUOUS_PREFILTER_SAMPLES`]).
    pub fn work_with(self, side: u32, kind: SourceKind, samples: u32) -> u64 {
        let texels = |side: u32| u64::from(side) * u64::from(side);
        match self {
            SliceStep::Source { face } => {
                let radiance = radiance_side(side, 0);
                let chain: u64 = (1..full_mips(radiance)).map(|mip| 4 * texels((radiance >> mip).max(1))).sum();
                let mip0 = texels(side) + texels(radiance);
                match kind {
                    SourceKind::Map => mip0 + chain,
                    SourceKind::Sky if face == 0 => u64::from(FACES) * mip0 + chain,
                    SourceKind::Sky => chain,
                }
            }
            SliceStep::Prefilter { .. } => (1..SPECULAR_MIPS).map(|mip| texels((side >> mip).max(1)) * u64::from(samples)).sum(),
            SliceStep::Sh9 => match kind {
                SourceKind::Map => u64::from(FACES) * texels(SH9_SOURCE_SIDE.min(radiance_side(side, 0))),
                SourceKind::Sky => sky_sh_work(),
            },
        }
    }
}

/// Texel samples of the sky's SH9 from its sky-view LUT: the LUT into [`SKY_SH_SOURCE_SIDE`]
/// faces, then their projection (a time-sliced step's, or a frame's whose LUT changed).
pub const fn sky_sh_work() -> u64 {
    2 * FACES as u64 * SKY_SH_SOURCE_SIDE as u64 * SKY_SH_SOURCE_SIDE as u64
}

/// The most texel samples one time-sliced frame reads for a specular cube of `side`, whatever the
/// source: its largest step, plus the sky's SH9 refresh when its LUT changed that frame.
pub fn slice_budget(side: u32) -> u64 {
    let steps = (0..SLICE_STEPS).flat_map(|index| SourceKind::ALL.map(|kind| SliceStep::at(index).work(side, kind)));
    steps.max().unwrap_or(0) + sky_sh_work()
}

/// Texel samples of a whole bake of a specular cube of `side` from a `kind` source (every step).
pub fn full_bake_work(side: u32, kind: SourceKind) -> u64 {
    (0..SLICE_STEPS).map(|index| SliceStep::at(index).work(side, kind)).sum()
}

/// Texel samples of a continuous rebake of a specular cube of `side` from a `kind` source: every
/// step, the prefilter at [`CONTINUOUS_PREFILTER_SAMPLES`] (at most the full count).
pub fn continuous_bake_work(side: u32, kind: SourceKind) -> u64 {
    let samples = CONTINUOUS_PREFILTER_SAMPLES.min(prefilter_samples(side));
    (0..SLICE_STEPS).map(|index| SliceStep::at(index).work_with(side, kind, samples)).sum()
}

/// Whether a sun at `dir` with radiance `color` has moved from the baked `baked_dir` and
/// `baked_color` enough to rebake the sky ([`SUN_REBAKE_DEGREES`], [`SUN_REBAKE_RADIANCE`]).
pub fn sun_moved(baked_dir: [f32; 3], baked_color: [f32; 3], dir: [f32; 3], color: [f32; 3]) -> bool {
    sun_moved_by(baked_dir, baked_color, dir, color, SUN_REBAKE_DEGREES)
}

/// [`sun_moved`] with the turn threshold `degrees` (a quality's [`Rebake::degrees`]).
pub fn sun_moved_by(baked_dir: [f32; 3], baked_color: [f32; 3], dir: [f32; 3], color: [f32; 3], degrees: f32) -> bool {
    // In f64 over the unit directions: at SI-02's continuous threshold (hundredths of a degree)
    // an f32 cosine is within a unit in the last place of 1, so the same sun read as turned.
    let unit = |d: [f32; 3]| {
        let d = d.map(f64::from);
        let length = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt().max(f64::MIN_POSITIVE);
        d.map(|c| c / length)
    };
    let (a, b) = (unit(baked_dir), unit(dir));
    let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    let turned = dot < libm::cos(f64::from(degrees).to_radians());
    let changed = baked_color.iter().zip(color).any(|(was, now)| (now - was).abs() > SUN_REBAKE_RADIANCE * was.abs().max(now.abs()));
    turned || changed
}

/// How a quality paces rebakes: one time-sliced step every `cadence` frames (frame-indexed), and
/// the sun's turn in `degrees` that rebakes the sky.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rebake {
    /// Frames between two steps (0 and 1: every frame).
    pub cadence: u8,
    /// The sun's turn that rebakes the sky, in degrees.
    pub degrees: f32,
    /// Whether a change rebakes whole on the frame it happens (SI-02 step 2,
    /// [`CONTINUOUS_SUN_DEGREES`]) instead of over a time-sliced cycle.
    pub continuous: bool,
}

impl Rebake {
    /// Every frame, at [`SUN_REBAKE_DEGREES`], time-sliced.
    pub const EVERY_FRAME: Rebake = Rebake { cadence: 1, degrees: SUN_REBAKE_DEGREES, continuous: false };

    /// The pacing `quality` asks for ([`EnvironmentQuality::rebake_cadence`],
    /// [`EnvironmentQuality::sun_rebake_tenths`]; 0 tenths is [`SUN_REBAKE_DEGREES`];
    /// [`EnvironmentQuality::continuous_sky`]).
    pub fn of(quality: &EnvironmentQuality) -> Rebake {
        let degrees = if quality.sun_rebake_tenths == 0 { SUN_REBAKE_DEGREES } else { f32::from(quality.sun_rebake_tenths) / 10.0 };
        Rebake { cadence: quality.rebake_cadence, degrees, continuous: quality.continuous_sky }
    }

    /// Whether a step runs at `frame_index`.
    pub const fn due(self, frame_index: u64) -> bool {
        crate::sky::lut_due(frame_index, self.cadence)
    }
}

/// What a bake is of: the environment, the version of its source map, the cube size, and (for
/// the sky only) the sun.
#[derive(Clone, Debug, PartialEq)]
struct BakeKey {
    environment: Environment,
    source: u64,
    side: u32,
    /// The sun's direction and radiance, for the sky (an HDRI is a fixed map: None).
    sun: Option<([f32; 3], [f32; 3])>,
}

impl BakeKey {
    /// Whether `self` and `other` bake the same environment from the same source at the same size
    /// (the sun aside).
    fn same_scene(&self, other: &BakeKey) -> bool {
        self.environment == other.environment && self.source == other.source && self.side == other.side
    }

    /// Whether a bake of `self` needs redoing for `now`: anything but the sun differs, or the sun
    /// moved past `degrees` (or its radiance threshold). A settled capture compares exactly instead.
    fn stale_for(&self, now: &BakeKey, degrees: f32) -> bool {
        let moved = match (self.sun, now.sun) {
            (Some((baked_dir, baked_color)), Some((dir, color))) => sun_moved_by(baked_dir, baked_color, dir, color, degrees),
            (baked, now) => baked.is_some() != now.is_some(),
        };
        !self.same_scene(now) || moved
    }
}

/// What the bake does on one frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BakeAction {
    /// Nothing: the bake is current, or a rebake waits for its cadence.
    Idle,
    /// Every step at once (a cold bake or a settled capture).
    Full,
    /// One step of a time-sliced rebake.
    Slice(SliceStep),
}

/// The rebake schedule: the last complete bake and the time-sliced rebake in progress.
#[derive(Clone, Debug, Default)]
struct Schedule {
    baked: Option<BakeKey>,
    cycle: Option<(BakeKey, u32)>,
    /// Whether the bound bake is a continuous rebake's (SI-02 step 2: fewer prefilter samples):
    /// once the sun rests, a time-sliced refresh at the full count replaces it, so a resting Live
    /// frame binds what a settled capture bakes.
    coarse: bool,
}

impl Schedule {
    /// The action for frame `frame_index` wanting `now` (`settle`: a settled capture), paced by
    /// `rebake`, and the key it bakes. A rebake whose environment, source or size changes starts
    /// over (nothing it wrote was bound); a sun moving every frame finishes the cycle in progress
    /// first, so it still lands a full refresh every [`SLICE_STEPS`] steps.
    fn next(&mut self, now: &BakeKey, settle: bool, frame_index: u64, rebake: Rebake) -> (BakeAction, BakeKey) {
        let exact = self.baked.as_ref() == Some(now) && self.cycle.is_none() && !self.coarse;
        if self.baked.is_none() || (settle && !exact) {
            self.baked = Some(now.clone());
            self.cycle = None;
            self.coarse = false;
            return (BakeAction::Full, now.clone());
        }
        let continuous_stale = self.baked.as_ref().is_some_and(|baked| baked.stale_for(now, CONTINUOUS_SUN_DEGREES));
        if rebake.continuous && continuous_stale {
            // SI-02 step 2: whole, at the continuous sample count, bound on this frame (a resting
            // sun's full-count refresh in progress gives way).
            self.baked = Some(now.clone());
            self.cycle = None;
            self.coarse = true;
            return (BakeAction::Full, now.clone());
        }
        if self.coarse && self.cycle.is_none() {
            // The sun rests: refresh the coarse bake at the full count, time-sliced.
            self.cycle = Some((now.clone(), 0));
            self.coarse = false;
        }
        if self.cycle.as_ref().is_some_and(|(key, _)| !key.same_scene(now)) {
            self.cycle = None;
        }
        if self.cycle.is_none() && self.baked.as_ref().is_some_and(|baked| baked.stale_for(now, rebake.degrees)) {
            self.cycle = Some((now.clone(), 0));
        }
        let Some((key, step)) = self.cycle.take() else {
            return (BakeAction::Idle, now.clone());
        };
        if !rebake.due(frame_index) {
            self.cycle = Some((key.clone(), step));
            return (BakeAction::Idle, key);
        }
        if step + 1 == SLICE_STEPS {
            self.baked = Some(key.clone());
        } else {
            self.cycle = Some((key.clone(), step + 1));
        }
        (BakeAction::Slice(SliceStep::at(step)), key)
    }
}

/// What one frame of the bake did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BakeWork {
    /// The action.
    pub action: BakeAction,
    /// Texel samples it read ([`SliceStep::work`]).
    pub texel_samples: u64,
    /// GGX samples per texel its prefilter read (0: no prefilter ran).
    pub prefilter_samples: u32,
}

impl Default for BakeWork {
    fn default() -> Self {
        BakeWork { action: BakeAction::Idle, texel_samples: 0, prefilter_samples: 0 }
    }
}

/// What one frame asks of the bake (graph node 11's view of [`EnvironmentFrame`]).
#[derive(Clone, Copy, Debug)]
pub struct BakeRequest<'a> {
    /// The game's environment.
    pub environment: &'a Environment,
    /// The quality's IBL knobs.
    pub quality: &'a EnvironmentQuality,
    /// The frame index the schedule is keyed to.
    pub frame_index: u64,
    /// Whether this is a settled capture's frame (bake whole if anything differs).
    pub settle: bool,
    /// Unit direction towards the sun (the sky's rebake threshold).
    pub sun_dir: [f32; 3],
    /// The sun's radiance (the sky's rebake threshold).
    pub sun_color: [f32; 3],
}

impl<'a> BakeRequest<'a> {
    /// The request graph node 11 makes for `ctx`.
    pub fn of(ctx: &EnvironmentFrame<'a>) -> BakeRequest<'a> {
        BakeRequest {
            environment: ctx.environment,
            quality: ctx.quality,
            frame_index: ctx.frame_index,
            settle: ctx.settle,
            sun_dir: ctx.sun_dir,
            sun_color: ctx.sun_color,
        }
    }
}

// --- GPU state ---

/// The bake's pipelines, layouts, samplers and uniform slots (made on first use).
struct BakePipelines {
    equirect_layout: BindGroupLayout,
    downsample_layout: BindGroupLayout,
    prefilter_layout: BindGroupLayout,
    sh9_layout: BindGroupLayout,
    equirect: Compiled<ComputePipeline>,
    downsample: Compiled<ComputePipeline>,
    prefilter: Compiled<ComputePipeline>,
    sh9: Compiled<ComputePipeline>,
    lut: Compiled<RenderPipeline>,
    uniforms: Buffer,
    equirect_sampler: Sampler,
    cube_sampler: Sampler,
    /// The sky's SH9 source ([`SKY_SH_SOURCE_SIDE`]², six faces as array layers): the sky-view
    /// LUT written by the sky's cube pass as storage, then read by `cs_sh9`. Shared by both sets.
    sky_sh_faces: TextureView,
}

pub(crate) fn texture_entry(binding: u32, filterable: bool, view_dimension: TextureViewDimension) -> BindGroupLayoutEntry {
    BindGroupLayoutEntry {
        binding,
        visibility: ShaderStages::COMPUTE,
        ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable }, view_dimension, multisampled: false },
        count: None,
    }
}

pub(crate) fn storage_faces_entry(binding: u32) -> BindGroupLayoutEntry {
    BindGroupLayoutEntry {
        binding,
        visibility: ShaderStages::COMPUTE,
        ty: wgpu::BindingType::StorageTexture {
            access: wgpu::StorageTextureAccess::WriteOnly,
            format: ENV_CUBE_FORMAT,
            view_dimension: TextureViewDimension::D2Array,
        },
        count: None,
    }
}

pub(crate) fn sampler_entry(binding: u32) -> BindGroupLayoutEntry {
    BindGroupLayoutEntry { binding, visibility: ShaderStages::COMPUTE, ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None }
}

pub(crate) fn layout(device: &Device, label: &str, entries: &[BindGroupLayoutEntry]) -> BindGroupLayout {
    device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some(label), entries })
}

pub(crate) fn compute(device: &Device, label: &str, source: &str, entry_point: &str, layout: &BindGroupLayout) -> Result<Compiled<ComputePipeline>, RenderError> {
    compute_with(device, (label, source, entry_point), layout, true)
}

/// [`compute`], zero-initializing its workgroup memory only when `zero_init` (WebGPU's default;
/// a kernel that writes every workgroup variable before reading it may skip it).
pub(crate) fn compute_with(device: &Device, (label, source, entry_point): (&str, &str, &str), layout: &BindGroupLayout, zero_init: bool) -> Result<Compiled<ComputePipeline>, RenderError> {
    let module = crate::shaders::module(device, label, source)?;
    let pipeline_layout = crate::tables::pipeline_layout(device, label, &[layout]);
    Ok(crate::compile::compute_pipeline(device, &wgpu::ComputePipelineDescriptor {
        label: Some(label),
        layout: Some(&pipeline_layout),
        module: &module,
        entry_point: Some(entry_point),
        compilation_options: wgpu::PipelineCompilationOptions { zero_initialize_workgroup_memory: zero_init, ..Default::default() },
        cache: None,
    }))
}

fn lut_pipeline(device: &Device) -> Result<Compiled<RenderPipeline>, RenderError> {
    let module = crate::shaders::module(device, "brdf lut", crate::shaders::IBL_BRDF_LUT)?;
    let pipeline_layout = crate::tables::pipeline_layout(device, "brdf lut", &[]);
    Ok(crate::compile::render_pipeline(device, &wgpu::RenderPipelineDescriptor {
        label: Some("brdf lut"),
        layout: Some(&pipeline_layout),
        vertex: wgpu::VertexState { module: &module, entry_point: Some("vs_brdf_lut"), compilation_options: Default::default(), buffers: &[] },
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: None,
        multisample: wgpu::MultisampleState::default(),
        fragment: Some(wgpu::FragmentState {
            module: &module,
            entry_point: Some("fs_brdf_lut"),
            compilation_options: Default::default(),
            targets: &[Some(wgpu::ColorTargetState { format: BRDF_LUT_FORMAT, blend: None, write_mask: wgpu::ColorWrites::ALL })],
        }),
        multiview_mask: None,
        cache: None,
    }))
}

pub(crate) fn sampler(device: &Device, label: &str, wrap_u: wgpu::AddressMode) -> Sampler {
    device.create_sampler(&wgpu::SamplerDescriptor {
        label: Some(label),
        address_mode_u: wrap_u,
        mag_filter: wgpu::FilterMode::Linear,
        min_filter: wgpu::FilterMode::Linear,
        mipmap_filter: wgpu::MipmapFilterMode::Linear,
        ..Default::default()
    })
}

impl BakePipelines {
    fn new(device: &Device) -> Result<BakePipelines, RenderError> {
        use crate::tables::{compute_storage, compute_uniform};
        use TextureViewDimension::{Cube, D2, D2Array};
        let equirect_layout =
            layout(device, "ibl equirect", &[compute_uniform(0), texture_entry(1, true, D2), sampler_entry(2), storage_faces_entry(3)]);
        let downsample_layout = layout(device, "ibl downsample", &[compute_uniform(0), storage_faces_entry(3), texture_entry(4, false, D2Array)]);
        let prefilter_layout =
            layout(device, "ibl prefilter", &[compute_uniform(0), texture_entry(1, true, Cube), sampler_entry(2), storage_faces_entry(3)]);
        let sh9_layout = layout(device, "ibl sh9", &[compute_uniform(0), texture_entry(1, false, D2Array), compute_storage(3, false)]);
        let shaders = crate::shaders::IBL_EQUIRECT;
        Ok(BakePipelines {
            equirect: compute(device, "ibl equirect", shaders, "cs_equirect", &equirect_layout)?,
            downsample: compute(device, "ibl downsample", shaders, "cs_downsample", &downsample_layout)?,
            prefilter: compute(device, "ibl prefilter", crate::shaders::IBL_PREFILTER, "cs_prefilter", &prefilter_layout)?,
            // Every workgroup variable of `cs_sh9` is written before it is read (each lane's partial
            // sums and minimum before a barrier, the ringing flag by lane 0 before its uniform
            // load): zero-initializing its 9 KB took about 0.18 ms of the kernel's 0.23 on an M4 Max,
            // which the sky's SH9 refresh pays on every frame its LUT changes (SI-02).
            sh9: compute_with(device, ("ibl sh9", crate::shaders::IBL_SH9, "cs_sh9"), &sh9_layout, false)?,
            lut: lut_pipeline(device)?,
            uniforms: crate::tables::buffer(device, "ibl bake", SLOTS * SLOT_BYTES, BufferUsages::UNIFORM | BufferUsages::COPY_DST)?,
            equirect_sampler: sampler(device, "ibl equirect", wgpu::AddressMode::Repeat),
            cube_sampler: sampler(device, "ibl cube", wgpu::AddressMode::ClampToEdge),
            sky_sh_faces: sky_sh_source(device),
            equirect_layout,
            downsample_layout,
            prefilter_layout,
            sh9_layout,
        })
    }

    fn slot(&self, slot: u64) -> BindingResource<'_> {
        BindingResource::Buffer(wgpu::BufferBinding { buffer: &self.uniforms, offset: slot * SLOT_BYTES, size: wgpu::BufferSize::new(size_of::<GpuIblBake>() as u64) })
    }

    fn write(&self, queue: &Queue, slot: u64, bake: &GpuIblBake) {
        queue.write_buffer(&self.uniforms, slot * SLOT_BYTES, bytemuck::bytes_of(bake));
    }

    fn group(&self, device: &Device, label: &str, layout: &BindGroupLayout, entries: &[(u32, BindingResource<'_>)]) -> BindGroup {
        let entries: Vec<wgpu::BindGroupEntry<'_>> = entries.iter().map(|(binding, resource)| wgpu::BindGroupEntry { binding: *binding, resource: resource.clone() }).collect();
        device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some(label), layout, entries: &entries })
    }

    /// Box mips `1..` of every layer of `texture` (its `layers` array layers), each level from the
    /// one above it, the layers from `faces.start` on.
    fn downsample(&self, device: &Device, pass: &mut ComputePass<'_>, texture: &Texture, slot: u64, faces: &Range<u32>, layers: u32) {
        let size = texture.size();
        pass.set_pipeline(&self.downsample);
        for mip in 1..texture.mip_level_count() {
            let read = array_view(texture, mip - 1, layers);
            let write = array_view(texture, mip, layers);
            let group = self.group(device, "ibl downsample", &self.downsample_layout, &[
                (0, self.slot(slot)),
                (3, BindingResource::TextureView(&write)),
                (4, BindingResource::TextureView(&read)),
            ]);
            pass.set_bind_group(0, &group, &[]);
            let (w, h) = ((size.width >> mip).max(1), (size.height >> mip).max(1));
            pass.dispatch_workgroups(w.div_ceil(WORKGROUP_SIDE), h.div_ceil(WORKGROUP_SIDE), faces.len() as u32);
        }
    }
}

/// A view of mip `mip` of `texture`'s `layers` layers as a 2D array (a storage or `textureLoad`
/// view).
pub(crate) fn array_view(texture: &Texture, mip: u32, layers: u32) -> TextureView {
    texture.create_view(&wgpu::TextureViewDescriptor {
        dimension: Some(TextureViewDimension::D2Array),
        base_mip_level: mip,
        mip_level_count: Some(1),
        array_layer_count: Some(layers),
        ..Default::default()
    })
}

/// The sky's SH9 source: six [`SKY_SH_SOURCE_SIDE`]² faces, one mip, as a `D2Array` view (the
/// sky's cube pass writes it as storage, `cs_sh9` loads it).
fn sky_sh_source(device: &Device) -> TextureView {
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some(SKY_SH_LABEL),
        size: wgpu::Extent3d { width: SKY_SH_SOURCE_SIDE, height: SKY_SH_SOURCE_SIDE, depth_or_array_layers: FACES },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: ENV_CUBE_FORMAT,
        usage: TextureUsages::STORAGE_BINDING | TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    });
    array_view(&texture, 0, FACES)
}

fn cube_texture(device: &Device, label: &str, side: u32, mips: u32) -> (Texture, TextureView) {
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d { width: side, height: side, depth_or_array_layers: FACES },
        mip_level_count: mips,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: ENV_CUBE_FORMAT,
        usage: CUBE_USAGE,
        view_formats: &[],
    });
    let cube = texture.create_view(&wgpu::TextureViewDescriptor { dimension: Some(TextureViewDimension::Cube), array_layer_count: Some(FACES), ..Default::default() });
    (texture, cube)
}

/// One set of baked cubes and SH9 block at one specular size, with the views and bind groups
/// every bake step records made once (a step then only records dispatches).
struct CubeMaps {
    side: u32,
    specular: Texture,
    specular_cube: TextureView,
    /// The same six layers as a one-cube array: the forward pass's binding 11 while no reflection
    /// probe is held (renderer pass 2 A.3, `probes::ProbeMaps::cube_array`).
    specular_cube_array: TextureView,
    radiance: Texture,
    sh: Buffer,
    /// The six faces of each specular mip, as a storage array.
    specular_mips: Vec<TextureView>,
    /// The six faces of each radiance mip, as an array.
    radiance_mips: Vec<TextureView>,
    /// The radiance chain's box filter into each mip from 1 (index `mip - 1`).
    downsample_groups: Vec<BindGroup>,
    /// The GGX prefilter into each specular mip from 1 (index `mip - 1`).
    prefilter_groups: Vec<BindGroup>,
    sh9_group: BindGroup,
    /// SH9 from the sky's source faces into this set's block (a sky's bake and LUT refreshes).
    sky_sh9_group: BindGroup,
    /// The equirect source into both cubes' mip 0, for the map version it was made for.
    equirect_groups: Option<(u64, [BindGroup; 2])>,
}

impl CubeMaps {
    /// A set at `side` that writes and reads the shared `radiance` cube ([`radiance_side`] of
    /// `side`, six layers, its full chain).
    fn new(device: &Device, side: u32, pipelines: &BakePipelines, radiance: &Texture) -> Result<CubeMaps, RenderError> {
        let (specular, specular_cube) = cube_texture(device, SPECULAR_LABEL, side, SPECULAR_MIPS);
        let specular_cube_array =
            specular.create_view(&wgpu::TextureViewDescriptor { dimension: Some(TextureViewDimension::CubeArray), array_layer_count: Some(FACES), ..Default::default() });
        let radiance_size = radiance.width();
        let radiance = radiance.clone();
        let radiance_cube = radiance.create_view(&wgpu::TextureViewDescriptor { dimension: Some(TextureViewDimension::Cube), array_layer_count: Some(FACES), ..Default::default() });
        let usage = BufferUsages::STORAGE | BufferUsages::UNIFORM | BufferUsages::COPY_SRC;
        let sh = crate::tables::buffer(device, "env sh9", SH_BYTES, usage)?;
        let specular_mips: Vec<TextureView> = (0..SPECULAR_MIPS).map(|mip| array_view(&specular, mip, FACES)).collect();
        let radiance_mips: Vec<TextureView> = (0..radiance.mip_level_count()).map(|mip| array_view(&radiance, mip, FACES)).collect();
        let downsample_groups = (1..radiance_mips.len())
            .map(|mip| {
                pipelines.group(device, "ibl downsample", &pipelines.downsample_layout, &[
                    (0, pipelines.slot(SLOT_DOWNSAMPLE)),
                    (3, BindingResource::TextureView(&radiance_mips[mip])),
                    (4, BindingResource::TextureView(&radiance_mips[mip - 1])),
                ])
            })
            .collect();
        let prefilter_groups = (1..SPECULAR_MIPS as usize)
            .map(|mip| {
                pipelines.group(device, "ibl prefilter", &pipelines.prefilter_layout, &[
                    (0, pipelines.slot(SLOT_PREFILTER + mip as u64)),
                    (1, BindingResource::TextureView(&radiance_cube)),
                    (2, BindingResource::Sampler(&pipelines.cube_sampler)),
                    (3, BindingResource::TextureView(&specular_mips[mip])),
                ])
            })
            .collect();
        let sh9_source = &radiance_mips[sh9_mip(radiance_size) as usize];
        let sh9_group = pipelines.group(device, "ibl sh9", &pipelines.sh9_layout, &[
            (0, pipelines.slot(SLOT_SH9)),
            (1, BindingResource::TextureView(sh9_source)),
            (3, sh.as_entire_binding()),
        ]);
        let sky_sh9_group = pipelines.group(device, "ibl sky sh9", &pipelines.sh9_layout, &[
            (0, pipelines.slot(SLOT_SH9)),
            (1, BindingResource::TextureView(&pipelines.sky_sh_faces)),
            (3, sh.as_entire_binding()),
        ]);
        Ok(CubeMaps {
            side,
            specular,
            specular_cube,
            specular_cube_array,
            radiance,
            sh,
            specular_mips,
            radiance_mips,
            downsample_groups,
            prefilter_groups,
            sh9_group,
            sky_sh9_group,
            equirect_groups: None,
        })
    }

    /// The equirect source's bind groups into both cubes' mip 0 for `map` (made once per map
    /// version).
    fn equirect_groups(&mut self, device: &Device, pipelines: &BakePipelines, map: &TextureView, version: u64) -> &[BindGroup; 2] {
        if self.equirect_groups.as_ref().is_none_or(|(held, _)| *held != version) {
            let group = |faces: &TextureView| {
                pipelines.group(device, "ibl equirect", &pipelines.equirect_layout, &[
                    (0, pipelines.slot(SLOT_SOURCE)),
                    (1, BindingResource::TextureView(map)),
                    (2, BindingResource::Sampler(&pipelines.equirect_sampler)),
                    (3, BindingResource::TextureView(faces)),
                ])
            };
            self.equirect_groups = Some((version, [group(&self.specular_mips[0]), group(&self.radiance_mips[0])]));
        }
        &self.equirect_groups.as_ref().expect("made above").1
    }
}

/// What a bake reads its radiance from.
enum Source<'a> {
    /// An uploaded equirect map: its view; cos, sin of the rotation, the radiance multiplier and
    /// the clamp (0: none); its upload's version.
    Map { view: TextureView, params: [f32; 4], version: u64 },
    /// The physical sky (its LUTs computed by graph node 11's sky part).
    Sky(&'a SkyState),
}

impl Source<'_> {
    fn kind(&self) -> SourceKind {
        match self {
            Source::Map { .. } => SourceKind::Map,
            Source::Sky(_) => SourceKind::Sky,
        }
    }

    /// The sky's LUT generation (None for a map).
    fn sky_generation(&self) -> Option<u64> {
        match self {
            Source::Map { .. } => None,
            Source::Sky(sky) => Some(sky.generation()),
        }
    }

    /// What identifies the source in a bake's key (the sky's content is keyed by its parameters
    /// and the sun instead).
    fn version(&self) -> u64 {
        match self {
            Source::Map { version, .. } => *version,
            Source::Sky(_) => 0,
        }
    }
}

/// An uploaded HDRI with its mip chain.
struct UploadedMap {
    view: TextureView,
    /// The sun the map holds (found on the full-size map), for [`HdriSun::Analytic`].
    sun: Option<AnalyticSun>,
    /// The bytes it holds on the GPU, its mips included.
    bytes: u64,
    version: u64,
}

/// The direction (unit, towards the sun) and colour (linear rgb: the irradiance on a surface
/// facing it) of `sun`, a sun of the map `hdri` names, in the world: turned with the map and
/// times its intensity. The bake samples world direction w from the map's direction
/// [`map_direction`]`(w, rotation)`, in [`equirect_uv`]'s frame; the sun was found in
/// [`crate::hdri::direction_to_uv`]'s, so it is carried across by its texel coordinate.
pub fn world_sun(sun: &AnalyticSun, hdri: &HdriEnvironment) -> ([f32; 3], [f32; 3]) {
    let [u, v] = crate::hdri::direction_to_uv(sun.direction);
    let m = equirect_direction(u, v);
    let (s, c) = (libm::sinf(hdri.rotation), libm::cosf(hdri.rotation));
    let direction = [c * m[0] + s * m[2], m[1], -s * m[0] + c * m[2]];
    (direction, sun.irradiance.map(|e| e * hdri.intensity))
}

/// What the frame binds for the environment (graph node 11's output): the bake's cube, SH and
/// LUT, or the neutral inputs until the bake has run, plus the environment sampler.
pub struct EnvironmentMaps {
    neutral: NeutralInputs,
    sampler: Sampler,
    environment: Environment,
    /// Bumped whenever a bound resource is replaced: the frame bind group is rebuilt on a change.
    generation: u64,
    pipelines: Option<BakePipelines>,
    /// The last complete bake: what the frame binds.
    maps: Option<CubeMaps>,
    /// The set a rebake writes, bound in place of `maps` once complete.
    back: Option<CubeMaps>,
    lut: Option<(Texture, TextureView)>,
    map: Option<UploadedMap>,
    versions: u64,
    schedule: Schedule,
    work: BakeWork,
    /// The sky's LUT generation ([`SkyState::generation`]) the bound SH9 was projected from (SI-02).
    sky_sh_generation: Option<u64>,
    /// The radiance cube both sets share at the current size ([`EnvironmentMaps::ensure_back`]).
    radiance: Option<Texture>,
    /// The reflection probes (renderer pass 2 A.3): their cube array, whose layer 0 is the bound
    /// specular cube, and their rows.
    probes: crate::probes::ProbeMaps,
    /// Bumped whenever the bound specular cube is replaced (a bake landed, or released): what the
    /// probes' captures are lit by and their layer 0 holds.
    cube_generation: u64,
    /// The irradiance volumes (renderer pass 2 A.4): their atlas and the rows the probes' table
    /// carries for them.
    irradiance: crate::irradiance::IrradianceMaps,
}

/// The v2 material map's row of the environment input `name` (one of `FRAME_ENV_BINDINGS`).
fn env_row(name: &str) -> Option<&'static V2Binding> {
    MATERIAL_V2_BINDINGS.iter().find(|row| row.name == name)
}

impl EnvironmentMaps {
    /// The maps of the flat-colour environment on `device`: the neutral inputs and the sampler.
    pub fn new(device: &Device, queue: &Queue) -> EnvironmentMaps {
        EnvironmentMaps {
            neutral: NeutralInputs::new(device, queue),
            sampler: sampler(device, "environment", wgpu::AddressMode::ClampToEdge),
            environment: Environment::Color,
            generation: 0,
            pipelines: None,
            maps: None,
            back: None,
            lut: None,
            map: None,
            versions: 0,
            schedule: Schedule::default(),
            work: BakeWork::default(),
            sky_sh_generation: None,
            radiance: None,
            probes: crate::probes::ProbeMaps::new(device, queue),
            cube_generation: 0,
            irradiance: crate::irradiance::IrradianceMaps::new(device, queue),
        }
    }

    /// The environment the maps hold (or will once baked).
    pub fn environment(&self) -> &Environment {
        &self.environment
    }

    /// Light the scene by `environment` from the next bake on (nothing to do when unchanged). An
    /// uploaded map is released when the environment is no longer an HDR map (it is uploaded
    /// again when one returns).
    pub fn set_environment(&mut self, environment: &Environment) {
        if self.environment.lights_scene() != environment.lights_scene() {
            // The frame group binds the bake or the neutral inputs by whether the environment
            // lights the scene ([`EnvironmentMaps::binding`]): rebuild it.
            self.generation += 1;
        }
        if self.environment != *environment {
            self.environment = environment.clone();
        }
        if !matches!(environment, Environment::Hdri(_)) {
            self.map = None;
        }
    }

    fn next_version(&mut self) -> u64 {
        self.versions += 1;
        self.versions
    }

    fn pipelines(&mut self, device: &Device) -> Result<&BakePipelines, RenderError> {
        if self.pipelines.is_none() {
            self.pipelines = Some(BakePipelines::new(device)?);
        }
        Ok(self.pipelines.as_ref().expect("made above"))
    }

    /// Bake from the decoded HDR map `map` (an [`Environment::Hdri`]'s file) as it is: its sun found
    /// on it ([`crate::hdri::prepare_map`] with no width cap), then [`EnvironmentMaps::set_prepared_map`].
    pub fn set_map(&mut self, device: &Device, queue: &Queue, map: &HdriImage) -> Result<(), RenderError> {
        let sun = crate::hdri::analytic_sun(map);
        self.upload(device, queue, map, sun)
    }

    /// Bake from `prepared` (a decoded map at most its device's width, with the sun found on the
    /// full map): uploaded with its box mip chain built on the GPU. With [`HdriSun::Analytic`],
    /// texels above the map's analytic sun are clamped out of the bake and the sun lights the scene
    /// as `frame.sun` ([`EnvironmentMaps::analytic_sun`]).
    pub fn set_prepared_map(&mut self, device: &Device, queue: &Queue, prepared: &PreparedMap) -> Result<(), RenderError> {
        self.upload(device, queue, &prepared.image, prepared.sun)
    }

    fn upload(&mut self, device: &Device, queue: &Queue, map: &HdriImage, sun: Option<AnalyticSun>) -> Result<(), RenderError> {
        crate::hdri::fits_caps(map.width, map.height).map_err(|refusal| RenderError::refused(RenderCode::TextureTooLarge, refusal.to_string()))?;
        if map.texels.len() as u64 != u64::from(map.width) * u64::from(map.height) {
            return Err(RenderError::refused(RenderCode::TextureInvalid, format!("{}x{} map with {} texels", map.width, map.height, map.texels.len())));
        }
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("environment map"),
            size: wgpu::Extent3d { width: map.width, height: map.height, depth_or_array_layers: 1 },
            mip_level_count: full_mips(map.width.max(map.height)),
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: ENV_CUBE_FORMAT,
            usage: MAP_USAGE,
            view_formats: &[],
        });
        queue.write_texture(
            wgpu::TexelCopyTextureInfo { texture: &texture, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            bytemuck::cast_slice(&map.texels),
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(map.width * 8), rows_per_image: Some(map.height) },
            texture.size(),
        );
        let pipelines = self.pipelines(device)?;
        pipelines.write(queue, SLOT_MAP, &GpuIblBake::default());
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("environment map mips") });
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("environment map mips"), timestamp_writes: None });
            pipelines.downsample(device, &mut pass, &texture, SLOT_MAP, &(0..1), 1);
        }
        queue.submit([encoder.finish()]);
        let view = texture.create_view(&wgpu::TextureViewDescriptor { dimension: Some(TextureViewDimension::D2), ..Default::default() });
        let version = self.next_version();
        let bytes = map_bytes(map.width, map.height);
        self.map = Some(UploadedMap { view, sun, bytes, version });
        Ok(())
    }

    /// Whether an HDR map is uploaded (released when the environment stops being one).
    pub fn holds_map(&self) -> bool {
        self.map.is_some()
    }

    /// The bytes the uploaded HDR map holds on the GPU (0 without one).
    pub fn map_bytes(&self) -> u64 {
        self.map.as_ref().map_or(0, |map| map.bytes)
    }

    /// The uploaded map's view and the version it was uploaded as (the HDRI backdrop, graph node
    /// 13).
    pub fn map_view(&self) -> Option<(&TextureView, u64)> {
        self.map.as_ref().map(|map| (&map.view, map.version))
    }

    /// The sun `hdri` lights the scene with in the world ([`world_sun`]): its uploaded map's
    /// analytic sun under [`HdriSun::Analytic`]; None under [`HdriSun::Off`], before the map is
    /// uploaded, or for a map without a sun (the frame's own sun stays).
    pub fn analytic_sun(&self, hdri: &HdriEnvironment) -> Option<([f32; 3], [f32; 3])> {
        if hdri.sun != HdriSun::Analytic {
            return None;
        }
        self.map.as_ref()?.sun.as_ref().map(|sun| world_sun(sun, hdri))
    }

    /// Which resources the frame bind group holds: a new value means rebuild it (the bake's, the
    /// reflection probes' and the irradiance volumes'; each only grows).
    pub fn generation(&self) -> u64 {
        self.generation + self.probes.generation() + self.irradiance.generation()
    }

    /// Whether the environment replaces the frame's flat ambient term: an environment that lights
    /// the scene, once the bake and its shading have landed. The renderer then marks
    /// `FrameUniforms::ambient.w` 1 for the shading.
    pub fn replaces_ambient(&self) -> bool {
        LANDED && self.environment.lights_scene()
    }

    /// Whether a bake is bound (the cubes, SH9 and LUT replace the neutral inputs).
    pub fn baked(&self) -> bool {
        self.maps.is_some() && self.lut.is_some() && self.schedule.baked.is_some()
    }

    /// The filtering sampler the environment is read with (`env_sampler`).
    pub fn sampler(&self) -> &Sampler {
        &self.sampler
    }

    /// The resource bound under `name` (one of `layout::FRAME_ENV_BINDINGS`): the bake's once it
    /// has run and while the environment lights the scene, else the neutral input of the v2 row of
    /// that name (so the flat colour reads the identity BRDF LUT even after a sky or a map was
    /// baked: direct specular's energy compensation reads it); the environment sampler for
    /// `env_sampler`. None for a name that is not an environment binding.
    pub fn binding(&self, name: &str) -> Option<BindingResource<'_>> {
        if name == "env_sampler" {
            return Some(BindingResource::Sampler(&self.sampler));
        }
        if let Some(resource) = self.probe_binding(name) {
            return Some(resource);
        }
        let row = env_row(name)?;
        let lit = self.environment.lights_scene() && self.baked();
        if let (true, Some(maps), Some((_, lut))) = (lit, &self.maps, &self.lut) {
            match name {
                "env_specular" => return Some(BindingResource::TextureView(&maps.specular_cube)),
                "env_sh" => return Some(maps.sh.as_entire_binding()),
                "brdf_lut" => return Some(BindingResource::TextureView(lut)),
                _ => {}
            }
        }
        Some(self.neutral.resource(row, false))
    }

    /// The forward pass's reflection-probe bindings (renderer pass 2 A.3, `probes::FRAME_PROBE_BINDINGS`):
    /// `env_probes`, the probe cube array (the bound specular cube as a one-cube array while no
    /// probe is held, the neutral black array while nothing is baked or the environment does not
    /// light the scene), and `env_probe_rows`, the rows in binned order (the irradiance volumes'
    /// after the probes'); and the irradiance volumes' atlas `env_irradiance` (A.4, a black
    /// 1-texel volume while none is held). None for any other name.
    fn probe_binding(&self, name: &str) -> Option<BindingResource<'_>> {
        match name {
            crate::probes::ENV_PROBES => {
                let lit = self.environment.lights_scene() && self.baked();
                let sky = self.maps.as_ref().filter(|_| lit).map(|maps| &maps.specular_cube_array);
                Some(BindingResource::TextureView(self.probes.cube_array(sky)))
            }
            crate::probes::ENV_PROBE_ROWS => Some(self.probes.rows().as_entire_binding()),
            crate::irradiance::ENV_IRRADIANCE => Some(BindingResource::TextureView(self.irradiance.view())),
            _ => None,
        }
    }

    /// The reflection probes' state (renderer pass 2 A.3).
    pub fn probes(&self) -> &crate::probes::ProbeMaps {
        &self.probes
    }

    /// Graph node 11's probe part, after the bake (`probes::ProbeMaps::prepare` over the bound
    /// specular cube): the capture work due this frame and the compute passes it opened. Nothing
    /// while the environment does not light the scene or nothing is baked (the probes are
    /// released).
    pub fn prepare_probes(&mut self, frame: &mut FrameEncoder, prep: &crate::probes::ProbePrep<'_>) -> (crate::probes::CaptureWork, u32) {
        let lit = self.environment.lights_scene() && self.baked();
        let sky = self.maps.as_ref().filter(|_| lit).map(|maps| (&maps.specular, self.cube_generation));
        let device = frame.device().clone();
        let queue = frame.queue().clone();
        let volume_rows = self.irradiance.rows().to_vec();
        let prep = crate::probes::ProbePrep { sky, volume_rows: &volume_rows, ..*prep };
        match self.probes.prepare(&device, &queue, frame.encoder(), &prep) {
            Ok(work) => work,
            Err(error) => {
                log::error!("reflection probes skipped: {error}");
                self.probes.release();
                (crate::probes::CaptureWork::new(), 0)
            }
        }
    }

    /// What the renderer's probe capture draws keep between frames.
    pub fn probe_store(&mut self) -> &mut crate::probes::CaptureStore {
        self.probes.store()
    }

    /// The irradiance volumes' state (renderer pass 2 A.4).
    pub fn irradiance(&self) -> &crate::irradiance::IrradianceMaps {
        &self.irradiance
    }

    /// What the renderer's irradiance bake draws keep between frames.
    pub fn irradiance_store(&mut self) -> &mut crate::probes::CaptureStore {
        self.irradiance.store()
    }

    /// The irradiance bake's shadow map now holds volume `slot`'s casters for the sun toward `sun`
    /// (`irradiance::IrradianceMaps::hold_shadow`).
    pub fn irradiance_hold_shadow(&mut self, slot: usize, sun: [f32; 3]) {
        self.irradiance.hold_shadow(slot, sun);
    }

    /// Graph node 11's irradiance part, after the bake and before the probes' (their table carries
    /// the volumes' rows): `irradiance::IrradianceMaps::prepare` lit by the bound specular cube's
    /// generation. Nothing while the environment does not light the scene or nothing is baked (the
    /// volumes are released).
    pub fn prepare_irradiance(&mut self, device: &Device, prep: &crate::irradiance::GridPrep<'_>) -> crate::irradiance::GridWork {
        let lit = self.environment.lights_scene() && self.baked();
        let lit_by = self.maps.as_ref().filter(|_| lit).map(|_| self.cube_generation);
        let prep = crate::irradiance::GridPrep { lit_by, ..*prep };
        match self.irradiance.prepare(device, &prep) {
            Ok(work) => work,
            Err(error) => {
                log::error!("irradiance volumes skipped: {error}");
                self.irradiance.release();
                crate::irradiance::GridWork::new()
            }
        }
    }

    /// Encode an irradiance batch's reduce and publish over the bound specular cube
    /// (`irradiance::IrradianceMaps::encode_batch`): the compute passes it opened.
    pub fn encode_irradiance_batch(&mut self, frame: &mut FrameEncoder, batch: &crate::irradiance::GridBatch, depth_reversed: bool) -> u32 {
        let Some(maps) = self.maps.as_ref() else { return 0 };
        let device = frame.device().clone();
        let queue = frame.queue().clone();
        let sky = (maps.specular_cube.clone(), self.cube_generation);
        self.irradiance.encode_batch(&device, &queue, frame.encoder(), batch, (&sky.0, sky.1), depth_reversed)
    }

    /// The face a probe capture step draws (`probes::ProbeMaps::face`).
    pub fn probe_face(&self, slot: usize, step: crate::probes::CaptureStep, prep: &crate::probes::ProbePrep<'_>) -> Option<crate::probes::FaceCapture> {
        self.probes.face(slot, step, prep)
    }

    /// Encode a probe capture step's own passes (`probes::ProbeMaps::encode_step`) over the bound
    /// specular cube: the compute passes it opened.
    pub fn encode_probe_step(&mut self, frame: &mut FrameEncoder, slot: usize, step: crate::probes::CaptureStep) -> u32 {
        let Some(maps) = self.maps.as_ref() else { return 0 };
        let device = frame.device().clone();
        let sky = (maps.specular_cube.clone(), self.cube_generation);
        self.probes.encode_step(&device, frame.encoder(), slot, step, (&sky.0, sky.1))
    }

    /// The bound specular cube (six layers, [`SPECULAR_MIPS`] mips), once baked.
    pub fn specular_texture(&self) -> Option<&Texture> {
        self.maps.as_ref().map(|maps| &maps.specular)
    }

    /// The bound radiance cube the prefilter and SH9 read, once baked.
    pub fn radiance_texture(&self) -> Option<&Texture> {
        self.maps.as_ref().map(|maps| &maps.radiance)
    }

    /// The bound SH9 block (`GxEnvSh`), once baked.
    pub fn sh_buffer(&self) -> Option<&Buffer> {
        self.maps.as_ref().map(|maps| &maps.sh)
    }

    /// The BRDF LUT, once written.
    pub fn brdf_lut_texture(&self) -> Option<&Texture> {
        self.lut.as_ref().map(|(texture, _)| texture)
    }

    /// The side of the bound specular cube, once baked.
    pub fn bound_side(&self) -> Option<u32> {
        self.maps.as_ref().map(|maps| maps.side)
    }

    /// What the last [`EnvironmentMaps::bake`] did.
    pub fn last_work(&self) -> BakeWork {
        self.work
    }

    /// Graph node 11's IBL part, after its sky part: [`EnvironmentMaps::bake`] for `ctx` from
    /// `sky`, once [`LANDED`]; nothing before (the shading would not read it).
    pub fn encode(&mut self, frame: &mut FrameEncoder, ctx: &EnvironmentFrame<'_>, sky: &SkyState) -> PassCounters {
        if !LANDED {
            return PassCounters::default();
        }
        self.bake(frame, &BakeRequest::of(ctx), Some(sky))
    }

    /// The bake `request` is due: nothing when current, the whole bake when cold or settling, else
    /// the time-sliced step that is due (into the set behind the bound one, bound when its last
    /// step lands). An HDRI is read from its uploaded map, the sky from `sky` (its LUTs computed
    /// this frame or before; until then nothing is baked). Releases the cubes when IBL is off or
    /// the environment is the flat colour. Returns the passes it opened (the caller counts them on
    /// `frame`).
    pub fn bake(&mut self, frame: &mut FrameEncoder, request: &BakeRequest<'_>, sky: Option<&SkyState>) -> PassCounters {
        self.bake_timed(frame, request, sky, None)
    }

    /// [`EnvironmentMaps::bake`] with the bake's compute pass timestamped by `writes` (the cost
    /// rows; a sky's own cube passes are not in it). Nothing is written when nothing is due.
    pub fn bake_timed(&mut self, frame: &mut FrameEncoder, request: &BakeRequest<'_>, sky: Option<&SkyState>, writes: Option<wgpu::ComputePassTimestampWrites<'_>>) -> PassCounters {
        self.work = BakeWork::default();
        let side = cube_side_for(request.quality, request.environment).filter(|_| request.environment.lights_scene());
        let Some(side) = side else {
            self.release();
            return PassCounters::default();
        };
        let Some(source) = self.source_for(request.environment, sky) else {
            return PassCounters::default();
        };
        match self.bake_with(frame, request, side, &source, writes) {
            Ok(counters) => counters,
            Err(error) => {
                log::error!("environment bake skipped: {error}");
                PassCounters::default()
            }
        }
    }

    fn release(&mut self) {
        if self.maps.take().is_some() {
            self.generation += 1;
            self.cube_generation += 1;
        }
        self.probes.release();
        self.irradiance.release();
        self.back = None;
        self.radiance = None;
        self.schedule = Schedule::default();
        self.sky_sh_generation = None;
    }

    /// The source of `environment`: its uploaded map, or `sky`.
    fn source_for<'a>(&self, environment: &Environment, sky: Option<&'a SkyState>) -> Option<Source<'a>> {
        match environment {
            Environment::Hdri(hdri) => self.map.as_ref().map(|map| {
                let clamp = match (&map.sun, hdri.sun) {
                    (Some(sun), HdriSun::Analytic) => sun.clamp,
                    _ => 0.0,
                };
                let params = [libm::cosf(hdri.rotation), libm::sinf(hdri.rotation), hdri.intensity, clamp];
                Source::Map { view: map.view.clone(), params, version: map.version }
            }),
            Environment::Sky(_) => sky.map(Source::Sky),
            _ => None,
        }
    }

    fn bake_with(
        &mut self,
        frame: &mut FrameEncoder,
        request: &BakeRequest<'_>,
        side: u32,
        source: &Source,
        writes: Option<wgpu::ComputePassTimestampWrites<'_>>,
    ) -> Result<PassCounters, RenderError> {
        let device = frame.device().clone();
        self.pipelines(&device)?;
        let mut counters = PassCounters::default();
        if self.lut.is_none() {
            self.lut = Some(self.encode_lut(&device, frame.encoder()));
            counters.render += 1;
        }
        // The sun only moves the sky's bake: an HDRI is a fixed map.
        let sky = matches!(request.environment, Environment::Sky(_));
        let key = BakeKey {
            environment: request.environment.clone(),
            source: source.version(),
            side,
            sun: sky.then_some((request.sun_dir, request.sun_color)),
        };
        let before = self.schedule.clone();
        let (action, baking) = self.schedule.next(&key, request.settle, request.frame_index, Rebake::of(request.quality));
        // A whole bake that is neither cold nor a settle's is a continuous rebake (SI-02 step 2).
        let continuous = action == BakeAction::Full && !request.settle && before.baked.is_some();
        let samples = if continuous { CONTINUOUS_PREFILTER_SAMPLES.min(prefilter_samples(side)) } else { prefilter_samples(side) };
        let steps: Vec<SliceStep> = match action {
            BakeAction::Idle => Vec::new(),
            BakeAction::Full => (0..SLICE_STEPS).map(SliceStep::at).collect(),
            BakeAction::Slice(step) => vec![step],
        };
        if steps.is_empty() {
            let (passes, texel_samples) = self.refresh_sky_sh(&device, frame, (request, source), writes);
            counters.compute += passes;
            self.work = BakeWork { action, texel_samples, prefilter_samples: 0 };
            return Ok(counters);
        }
        self.ensure_back(&device, baking.side, request.quality.radiance_side_max)?;
        let Some(passes) = self.encode_steps(&device, frame, &steps, source, (request.frame_index, writes, samples)) else {
            // The sky has no LUTs yet: nothing was recorded, and the step stays due.
            self.schedule = before;
            return Ok(counters);
        };
        counters.compute += passes;
        if self.schedule.cycle.is_none() {
            // The last step landed: the rebake's set is bound whole, the old one is written next.
            std::mem::swap(&mut self.maps, &mut self.back);
            self.generation += 1;
            self.cube_generation += 1;
        }
        let kind = source.kind();
        let mut texel_samples = steps.iter().map(|step| step.work_with(side, kind, samples)).sum();
        let prefiltered = steps.iter().any(|step| matches!(step, SliceStep::Prefilter { .. }));
        if steps.contains(&SliceStep::Sh9) {
            // The SH9 step projected the sky's current LUT into the set it bound.
            self.sky_sh_generation = source.sky_generation();
        } else {
            let (passes, work) = self.refresh_sky_sh(&device, frame, (request, source), None);
            counters.compute += passes;
            texel_samples += work;
        }
        self.work = BakeWork { action, texel_samples, prefilter_samples: if prefiltered { samples } else { 0 } };
        Ok(counters)
    }

    /// SI-02: the bound SH9 projected again from the sky's sky-view LUT when the LUT changed since
    /// it was (the sky alone, and only while the bound bake is of the same sky): the diffuse light
    /// follows a moving sun on every LUT refresh instead of stepping once per rebake, while the
    /// specular cube keeps its time-sliced cycle. One compute pass (timestamped with `writes`): the
    /// LUT into the source faces, then the projection. The passes it opened and the texel samples it
    /// read.
    fn refresh_sky_sh(
        &mut self,
        device: &Device,
        frame: &mut FrameEncoder,
        (request, source): (&BakeRequest<'_>, &Source<'_>),
        writes: Option<wgpu::ComputePassTimestampWrites<'_>>,
    ) -> (u32, u64) {
        let Source::Sky(sky) = source else { return (0, 0) };
        let same_sky = self.schedule.baked.as_ref().is_some_and(|baked| baked.environment == *request.environment);
        let due = same_sky && self.sky_sh_generation != Some(sky.generation()) && sky.has_luts();
        if !due {
            return (0, 0);
        }
        let (Some(pipelines), Some(maps)) = (self.pipelines.as_ref(), self.maps.as_ref()) else { return (0, 0) };
        let mut pass = frame.encoder().begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("environment sky sh9"), timestamp_writes: writes });
        sky.dispatch_cube(device, &mut pass, &pipelines.sky_sh_faces, SKY_SH_SOURCE_SIDE);
        pass.set_pipeline(&pipelines.sh9);
        pass.set_bind_group(0, &maps.sky_sh9_group, &[]);
        pass.dispatch_workgroups(1, 1, 1);
        drop(pass);
        self.sky_sh_generation = Some(sky.generation());
        (1, sky_sh_work())
    }

    /// The set a rebake writes, at `side` (made, or remade at a new size or over another radiance
    /// cube, before its first step). Both sets share one radiance cube per size: the frame binds a
    /// set's specular cube and SH9 only, and a complete bake never reads its radiance again, so
    /// the rebake behind it may overwrite it (one radiance cube instead of one per set).
    fn ensure_back(&mut self, device: &Device, side: u32, radiance_max: u32) -> Result<(), RenderError> {
        let radiance_size = radiance_side(side, radiance_max);
        if self.radiance.as_ref().is_none_or(|radiance| radiance.width() != radiance_size) {
            self.radiance = Some(cube_texture(device, RADIANCE_LABEL, radiance_size, full_mips(radiance_size)).0);
        }
        let radiance = self.radiance.as_ref().expect("made above");
        if self.back.as_ref().is_none_or(|back| back.side != side || back.radiance != *radiance) {
            let pipelines = self.pipelines.as_ref().expect("made by bake_with");
            self.back = Some(CubeMaps::new(device, side, pipelines, radiance)?);
        }
        Ok(())
    }

    fn encode_lut(&self, device: &Device, encoder: &mut CommandEncoder) -> (Texture, TextureView) {
        let pipelines = self.pipelines.as_ref().expect("made by bake_with");
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some(BRDF_LUT_LABEL),
            size: wgpu::Extent3d { width: BRDF_LUT_SIZE, height: BRDF_LUT_SIZE, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: BRDF_LUT_FORMAT,
            usage: LUT_USAGE,
            view_formats: &[],
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some(BRDF_LUT_LABEL),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &view,
                depth_slice: None,
                resolve_target: None,
                // The triangle covers every texel: nothing to load.
                ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store },
            })],
            ..Default::default()
        });
        pass.set_pipeline(&pipelines.lut);
        pass.draw(0..3, 0..1);
        drop(pass);
        (texture, view)
    }

    /// Encode `steps` (in schedule order) into the rebake's set: the sky's faces first when they
    /// are due (its own passes), then one compute pass. A whole bake batches the six faces of each
    /// step kind into one dispatch; the texels it writes are the slices' exactly. The passes
    /// opened, or None (and nothing recorded) when the sky has no LUTs yet.
    fn encode_steps(
        &mut self,
        device: &Device,
        frame: &mut FrameEncoder,
        steps: &[SliceStep],
        source: &Source<'_>,
        (frame_index, writes, samples): (u64, Option<wgpu::ComputePassTimestampWrites<'_>>, u32),
    ) -> Option<u32> {
        let pipelines = self.pipelines.as_ref().expect("made by bake_with");
        let maps = self.back.as_mut().expect("made by ensure_back");
        let faces_of = |kind: fn(&SliceStep) -> Option<u32>| {
            let faces: Vec<u32> = steps.iter().filter_map(kind).collect();
            faces.first().map(|first| *first..first + faces.len() as u32)
        };
        let source_faces = faces_of(|step| if let SliceStep::Source { face } = step { Some(*face) } else { None });
        let prefilter_faces = faces_of(|step| if let SliceStep::Prefilter { face } = step { Some(*face) } else { None });
        let sh9 = steps.contains(&SliceStep::Sh9);
        let sky_sh9 = sh9 && matches!(source, Source::Sky(_));
        let mut passes = 1;
        if let (Some(faces), Source::Sky(sky)) = (&source_faces, source)
            && faces.start == 0
        {
            for (faces_view, side) in [(&maps.specular_mips[0], maps.specular.width()), (&maps.radiance_mips[0], maps.radiance.width())] {
                if !sky.encode_cube(device, frame.encoder(), faces_view, side) {
                    return None;
                }
                passes += 1;
            }
        }
        if sky_sh9 && matches!(source, Source::Sky(sky) if !sky.has_luts()) {
            return None;
        }
        let queue = frame.queue().clone();
        let schedule = [(frame_index & u64::from(u32::MAX)) as u32, 0, 0, 0];
        if let (Some(_), Source::Map { view, version, .. }) = (&source_faces, source) {
            maps.equirect_groups(device, pipelines, view, *version);
        }
        let maps = &*maps;
        let mut pass = frame.encoder().begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("environment bake"), timestamp_writes: writes });
        if let Some(faces) = source_faces {
            encode_source(&queue, pipelines, maps, &mut pass, source, &faces, schedule);
        }
        if let Some(faces) = prefilter_faces {
            encode_prefilter(&queue, pipelines, maps, &mut pass, (&faces, samples), schedule);
        }
        if sh9 {
            if let Source::Sky(sky) = source {
                // SI-02: the sky's SH9 straight from its sky-view LUT, as on every frame it changes.
                sky.dispatch_cube(device, &mut pass, &pipelines.sky_sh_faces, SKY_SH_SOURCE_SIDE);
            }
            let group = if sky_sh9 { &maps.sky_sh9_group } else { &maps.sh9_group };
            encode_sh9(&queue, pipelines, maps, group, &mut pass, schedule);
        }
        Some(passes)
    }
}

/// The bytes an uploaded `width × height` equirect map holds with its full mip chain.
pub fn map_bytes(width: u32, height: u32) -> u64 {
    let mut total = 0;
    let (mut w, mut h) = (u64::from(width), u64::from(height));
    for _ in 0..full_mips(width.max(height)) {
        total += w * h * 8;
        (w, h) = ((w / 2).max(1), (h / 2).max(1));
    }
    total
}

/// The source into `faces`: a map into specular mip 0 at full size and the radiance cube's mip 0
/// (the sky wrote both already), then the radiance cube's box chain for those faces.
fn encode_source(queue: &Queue, pipelines: &BakePipelines, maps: &CubeMaps, pass: &mut ComputePass<'_>, source: &Source<'_>, faces: &Range<u32>, schedule: [u32; 4]) {
    pipelines.write(queue, SLOT_DOWNSAMPLE, &GpuIblBake { dest: [faces.start, 0, 0, 0], schedule, ..GpuIblBake::default() });
    if let (Source::Map { params, .. }, Some((_, groups))) = (source, &maps.equirect_groups) {
        let bake = GpuIblBake { source: *params, dest: [faces.start, 0, SPECULAR_MIPS, 0], prefilter: [0.0; 4], schedule };
        pipelines.write(queue, SLOT_SOURCE, &bake);
        pass.set_pipeline(&pipelines.equirect);
        for (group, side) in groups.iter().zip([maps.specular.width(), maps.radiance.width()]) {
            pass.set_bind_group(0, group, &[]);
            pass.dispatch_workgroups(side.div_ceil(WORKGROUP_SIDE), side.div_ceil(WORKGROUP_SIDE), faces.len() as u32);
        }
    }
    pass.set_pipeline(&pipelines.downsample);
    for (index, group) in maps.downsample_groups.iter().enumerate() {
        let side = (maps.radiance.width() >> (index + 1)).max(1);
        pass.set_bind_group(0, group, &[]);
        pass.dispatch_workgroups(side.div_ceil(WORKGROUP_SIDE), side.div_ceil(WORKGROUP_SIDE), faces.len() as u32);
    }
}

/// The GGX prefilter of `faces` at every roughness mip from 1.
fn encode_prefilter(queue: &Queue, pipelines: &BakePipelines, maps: &CubeMaps, pass: &mut ComputePass<'_>, (faces, samples): (&Range<u32>, u32), schedule: [u32; 4]) {
    let radiance = maps.radiance.width();
    pass.set_pipeline(&pipelines.prefilter);
    for (mip, group) in (1..SPECULAR_MIPS).zip(&maps.prefilter_groups) {
        let slot = SLOT_PREFILTER + u64::from(mip);
        let side = (maps.side >> mip).max(1);
        let prefilter = [mip_roughness(mip), radiance as f32, maps.radiance.mip_level_count() as f32, 0.0];
        let bake = GpuIblBake { source: [1.0, 0.0, 1.0, 0.0], dest: [faces.start, mip, SPECULAR_MIPS, samples], prefilter, schedule: [schedule[0], side, 0, 0] };
        pipelines.write(queue, slot, &bake);
        pass.set_bind_group(0, group, &[]);
        pass.dispatch_workgroups(side.div_ceil(WORKGROUP_SIDE), side.div_ceil(WORKGROUP_SIDE), faces.len() as u32);
    }
}

/// The SH9 projection through `group`: the radiance cube's [`SH9_SOURCE_SIDE`] mip, or the sky's
/// source faces.
fn encode_sh9(queue: &Queue, pipelines: &BakePipelines, maps: &CubeMaps, group: &BindGroup, pass: &mut ComputePass<'_>, schedule: [u32; 4]) {
    let mip = sh9_mip(maps.radiance.width());
    pipelines.write(queue, SLOT_SH9, &GpuIblBake { dest: [0, mip, 0, 0], schedule, ..GpuIblBake::default() });
    pass.set_pipeline(&pipelines.sh9);
    pass.set_bind_group(0, group, &[]);
    pass.dispatch_workgroups(1, 1, 1);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_constant_environment_projected_with_the_lobe_evaluates_to_its_radiance() {
        // A constant radiance L projects onto L00 only: L * 4 pi * Y00, times A_0 / pi = 1.
        let radiance = [0.5_f32, 1.0, 2.0];
        let l00 = 4.0 * core::f32::consts::PI * 0.282_095 * SH9_LOBE[0];
        let mut sh = GxEnvSh::default();
        sh.coefficients[0] = [radiance[0] * l00, radiance[1] * l00, radiance[2] * l00, 0.0];
        for n in [[0.0, 1.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, -1.0], [0.577_350_3, 0.577_350_3, 0.577_350_3]] {
            let e = sh9_eval(&sh, n);
            for (got, want) in e.iter().zip(radiance) {
                assert!((got - want).abs() < 1e-3 * want, "{n:?}: {e:?}");
            }
        }
        assert_eq!(sh9_eval(&GxEnvSh::default(), [0.0, 1.0, 0.0]), [0.0; 3], "the neutral SH lights nothing");
        assert_eq!((0..9).map(sh9_band).collect::<Vec<_>>(), [0, 1, 1, 1, 2, 2, 2, 2, 2]);
    }

    /// The SH9 of a single bright direction `d` (radiance `peak` over solid angle `area`), with the
    /// cosine lobe: what the bake projects for a compact source alone.
    fn delta_sh(d: [f32; 3], peak: f32, area: f32) -> GxEnvSh {
        let mut sh = GxEnvSh::default();
        for (index, value) in sh9_basis(d).iter().enumerate() {
            let c = peak * area * value * SH9_LOBE[sh9_band(index)];
            sh.coefficients[index] = [c, c, c, 0.0];
        }
        sh
    }

    #[test]
    fn deringing_keeps_a_compact_source_s_irradiance_non_negative_and_leaves_a_smooth_one_alone() {
        // SI-05: the SH9 of a compact source rings below zero on its far side.
        let directions = sh9_min_directions();
        let dense: Vec<[f32; 3]> = (0..64).flat_map(|row| (0..128).map(move |column| equirect_direction((column as f32 + 0.5) / 128.0, (row as f32 + 0.5) / 64.0))).collect();
        let least = |sh: &GxEnvSh, over: &[[f32; 3]]| over.iter().map(|n| sh9_windowed(sh, *n, 0, [1.0, 1.0])).fold(f32::INFINITY, f32::min);
        let source = delta_sh([0.3, 0.8, -0.52], 1000.0, 1e-3);
        assert!(least(&source, &dense) < -0.1 * source.coefficients[0][0] * 0.282_095, "a compact source rings: {}", least(&source, &dense));
        let window = sh9_dering_window(&source);
        assert!(window[0] < 1.0 && window[1] < window[0], "both bands damped, band 2 more: {window:?}");
        let deringed = sh9_dering(&source);
        assert_eq!(deringed.coefficients[0], source.coefficients[0], "the mean irradiance is kept");
        assert!(least(&deringed, &directions) >= 0.0, "non-negative over the bake's directions");
        let constant = deringed.coefficients[0][0] * 0.282_095;
        assert!(least(&deringed, &dense) >= -1e-3 * constant, "and nearly so everywhere: {}", least(&deringed, &dense));
        // A smooth sky (brighter overhead, never negative) is stored exactly as projected.
        let mut sky = GxEnvSh::default();
        sky.coefficients[0] = [1.0, 1.2, 1.5, 0.0];
        sky.coefficients[1] = [0.3, 0.35, 0.4, 0.0];
        sky.coefficients[6] = [-0.05, -0.05, -0.06, 0.0];
        assert_eq!(sh9_dering_window(&sky), [1.0, 1.0]);
        assert_eq!(sh9_dering(&sky).coefficients, sky.coefficients);
        assert_eq!((sh9_window(0, 3.0), sh9_window(3, 3.0)), (1.0, 0.0));
    }

    #[test]
    fn the_targets_follow_the_quality_and_the_fixed_counts() {
        assert!(target_descs(&crate::settings::Quality::off().environment).is_empty(), "IBL off: nothing baked");
        assert_eq!(bake_bytes(&crate::settings::Quality::off().environment), 0);
        let mut quality = crate::settings::Quality::off().environment;
        quality.ibl = true;
        quality.cube_size = 64;
        let descs = target_descs(&quality);
        let labels: Vec<&str> = descs.iter().map(|desc| desc.label).collect();
        assert_eq!(labels, [SPECULAR_LABEL, RADIANCE_LABEL, BRDF_LUT_LABEL]);
        assert_eq!((descs[0].mips, descs[1].size, descs[1].mips), (SPECULAR_MIPS, (32, 32), 6));
        assert_eq!(CUBE_SIZE_MIN, 32, "six levels down to one texel");
        assert_eq!(descs[2].size, (BRDF_LUT_SIZE, BRDF_LUT_SIZE));
        assert_eq!((prefilter_samples(64), prefilter_samples(128), prefilter_samples(512)), (32, 64, 128));
        // Perceptual levels (RQ2 review; were linear, 0.25 apart): the lookup's lod inverts them.
        assert_eq!((mip_roughness(0), mip_roughness(SPECULAR_MIPS - 1), mip_roughness(SPECULAR_MIPS)), (0.0, 1.0, 1.0));
        let last = (SPECULAR_MIPS - 1) as f32;
        assert!((mip_roughness(2) - (1.0 - libm::sqrtf(1.0 - 2.0 / last))).abs() < 1e-6, "{}", mip_roughness(2));
        for mip in 0..SPECULAR_MIPS {
            assert!((roughness_lod(mip_roughness(mip)) - mip as f32).abs() < 1e-5, "mip {mip}");
        }
        assert!(mip_roughness(1) < 0.15, "most levels go to low roughness: {}", mip_roughness(1));
        quality.cube_size = 4096;
        assert_eq!(target_descs(&quality)[0].size, (CUBE_SIZE_MAX, CUBE_SIZE_MAX), "capped");
        // SI-01 flips this (named in the log): the radiance cube is half the specular side,
        // uncapped (was 32 px at every size).
        assert_eq!(target_descs(&quality)[1].size, (CUBE_SIZE_MAX / 2, CUBE_SIZE_MAX / 2));
        quality.cube_size = 200;
        assert_eq!(cube_side(&quality), Some(128), "a power of two");
        quality.cube_size = 3;
        assert_eq!(cube_side(&quality), Some(CUBE_SIZE_MIN), "never below one texel at the last roughness");
        assert_eq!((sh9_mip(32), sh9_mip(16), sh9_mip(8)), (1, 0, 0));
    }

    #[test]
    fn the_cube_faces_and_the_equirect_mapping_agree() {
        // Face centres point along their axes.
        assert_eq!(cube_direction(0, 0.5, 0.5), [1.0, 0.0, 0.0]);
        assert_eq!(cube_direction(3, 0.5, 0.5), [0.0, -1.0, 0.0]);
        assert_eq!(cube_direction(5, 0.5, 0.5), [0.0, 0.0, -1.0]);
        // Corners shared by faces agree (seams are continuous).
        let corner = |face, u, v| cube_direction(face, u, v).map(|c| (c * 1e5).round());
        assert_eq!(corner(0, 0.0, 0.0), corner(4, 1.0, 0.0), "+X's top left is +Z's top right");
        assert_eq!(corner(2, 0.0, 0.0), corner(5, 1.0, 0.0), "+Y's top left is -Z's top right");
        for d in [[0.0, 1.0, 0.0], [0.6, 0.0, 0.8], [-0.36, 0.48, -0.8], [0.0, -0.6, 0.8]] {
            let [u, v] = equirect_uv(d);
            let back = equirect_direction(u, v);
            for (a, b) in d.iter().zip(back) {
                assert!((a - b).abs() < 1e-5, "{d:?} -> ({u}, {v}) -> {back:?}");
            }
        }
        assert_eq!(equirect_uv([0.0, 1.0, 0.0])[1], 0.0, "the top row is up");
        let turned = map_direction([1.0, 0.0, 0.0], core::f32::consts::FRAC_PI_2);
        assert!((turned[2] - 1.0).abs() < 1e-6 && turned[0].abs() < 1e-6, "turned a quarter, +X shows the map's +Z: {turned:?}");
    }

    #[test]
    fn the_texel_solid_angles_cover_the_sphere() {
        for side in [1, 4, 16] {
            let total: f64 = (0..side).flat_map(|y| (0..side).map(move |x| texel_solid_angle(side, x, y))).sum::<f64>() * 6.0;
            assert!((total - 4.0 * core::f64::consts::PI).abs() < 1e-9, "{side}: {total}");
        }
    }

    #[test]
    fn the_brdf_reference_holds_the_split_sum_identities() {
        // Smooth and facing: all of F0, nothing of the bias but Schlick's sliver.
        let [scale, bias] = brdf_lut_reference(1.0, 0.0, BRDF_LUT_SAMPLES);
        assert!((scale + bias - 1.0).abs() < 1e-9 && bias.abs() < 1e-9, "{scale} {bias}");
        // A white furnace never gains energy (beyond the estimator's noise), and the single-scatter
        // loss grows with roughness.
        let mut previous = f64::INFINITY;
        for roughness in [0.1, 0.4, 0.7, 1.0] {
            let [scale, bias] = brdf_lut_reference(0.5, roughness, BRDF_LUT_SAMPLES);
            assert!(scale + bias <= 1.0 + 1e-4 && scale + bias < previous + 1e-9, "{roughness}: {}", scale + bias);
            previous = scale + bias;
        }
        // BRDF_LUT_SAMPLES points converge: within 5e-4 of 32x as many over the LUT's whole range
        // (grazing angles are the worst), so with an rg16float's rounding the LUT is within 1e-3 of
        // the integral.
        let mut worst = 0.0_f64;
        for n_dot_v in [0.004, 0.05, 0.1, 0.3, 0.5, 0.7, 0.9, 0.996] {
            for roughness in [0.004, 0.05, 0.1, 0.3, 0.5, 0.7, 0.9, 0.996] {
                let coarse = brdf_lut_reference(n_dot_v, roughness, BRDF_LUT_SAMPLES);
                let fine = brdf_lut_reference(n_dot_v, roughness, 32 * BRDF_LUT_SAMPLES);
                worst = worst.max((coarse[0] - fine[0]).abs()).max((coarse[1] - fine[1]).abs());
            }
        }
        assert!(worst < 5e-4, "worst {worst:e}");
    }

    fn key(environment: Environment, sun_dir: [f32; 3]) -> BakeKey {
        BakeKey { environment, source: 1, side: 64, sun: Some((sun_dir, [1.0; 3])) }
    }

    fn sun(degrees: f32) -> [f32; 3] {
        let r = degrees.to_radians();
        [libm::cosf(r), libm::sinf(r), 0.0]
    }

    #[test]
    fn the_schedule_bakes_cold_then_slices_then_idles() {
        let mut schedule = Schedule::default();
        let every = Rebake::EVERY_FRAME;
        let sky = Environment::sky();
        assert_eq!(schedule.next(&key(sky.clone(), sun(30.0)), false, 0, every).0, BakeAction::Full, "a cold bake is whole");
        assert_eq!(schedule.next(&key(sky.clone(), sun(30.0)), false, 1, every).0, BakeAction::Idle, "unchanged: no work");
        assert_eq!(schedule.next(&key(sky.clone(), sun(30.3)), false, 2, every).0, BakeAction::Idle, "below the sun threshold");
        let mut steps = Vec::new();
        for frame in 0..SLICE_STEPS {
            steps.push(schedule.next(&key(sky.clone(), sun(31.0)), false, 3 + u64::from(frame), every).0);
        }
        let expected: Vec<BakeAction> = (0..SLICE_STEPS).map(|index| BakeAction::Slice(SliceStep::at(index))).collect();
        assert_eq!(steps, expected, "the fixed order, one step a frame");
        assert_eq!(schedule.baked.as_ref().and_then(|baked| baked.sun).map(|(dir, _)| dir), Some(sun(31.0)));
        assert_eq!(schedule.next(&key(sky.clone(), sun(31.0)), false, 20, every).0, BakeAction::Idle);
        // A settled capture bakes whole whenever anything differs, even below the threshold.
        assert_eq!(schedule.next(&key(sky.clone(), sun(31.1)), true, 0, every).0, BakeAction::Full);
        assert_eq!(schedule.next(&key(sky.clone(), sun(31.1)), true, 0, every).0, BakeAction::Idle, "and is current after");
        // A sun moving mid-cycle finishes the cycle first.
        let _ = schedule.next(&key(sky.clone(), sun(40.0)), false, 30, every);
        assert_eq!(schedule.next(&key(sky.clone(), sun(41.0)), false, 31, every).0, BakeAction::Slice(SliceStep::at(1)), "the sun's cycle goes on");
        // A new environment mid-cycle starts over: nothing the old cycle wrote was bound.
        let other = BakeKey { sun: None, ..key(Environment::hdri("env/a.hdr"), [0.0; 3]) };
        assert_eq!(schedule.next(&other, false, 32, every).0, BakeAction::Slice(SliceStep::at(0)), "the new environment's cycle at once");
        for frame in 1..SLICE_STEPS {
            assert_eq!(schedule.next(&other, false, 32 + u64::from(frame), every).0, BakeAction::Slice(SliceStep::at(frame)));
        }
        assert_eq!(schedule.next(&other, false, 50, every).0, BakeAction::Idle, "an HDRI's bake has no sun to move");
        // A new size (dynamic resolution) is a rebake too, never a whole bake outside a settle.
        let smaller = BakeKey { side: 32, ..other.clone() };
        assert_eq!(schedule.next(&smaller, false, 51, every).0, BakeAction::Slice(SliceStep::at(0)));
    }

    #[test]
    fn a_rebake_follows_the_quality_s_cadence_and_sun_threshold() {
        let mut schedule = Schedule::default();
        let low = Rebake { cadence: 8, degrees: 2.0, continuous: false };
        let sky = Environment::sky();
        assert_eq!(schedule.next(&key(sky.clone(), sun(30.0)), false, 0, low).0, BakeAction::Full);
        assert_eq!(schedule.next(&key(sky.clone(), sun(31.5)), false, 1, low).0, BakeAction::Idle, "1.5 degrees is under low's threshold");
        let mut slices = 0;
        for frame in 2..=(8 * u64::from(SLICE_STEPS) + 8) {
            let action = schedule.next(&key(sky.clone(), sun(33.0)), false, frame, low).0;
            assert!(action == BakeAction::Idle || frame % 8 == 0, "frame {frame}: {action:?} off the cadence");
            slices += u32::from(matches!(action, BakeAction::Slice(_)));
        }
        assert_eq!(slices, SLICE_STEPS, "one step every 8th frame until the refresh lands");
        let quality = crate::presets::preset_quality(crate::settings::QualityPreset::Low, crate::device_class::DeviceClass::ALL[0]).environment;
        assert_eq!(Rebake::of(&quality), Rebake { cadence: quality.sky_cadence, degrees: 2.0, continuous: false });
    }

    #[test]
    fn a_slice_never_costs_more_than_the_budget_and_the_budget_is_a_fraction_of_a_bake() {
        for side in [64, 128, 256, 512] {
            let budget = slice_budget(side);
            for kind in SourceKind::ALL {
                assert!((0..SLICE_STEPS).all(|index| SliceStep::at(index).work(side, kind) <= budget));
                assert!(budget * 4 < full_bake_work(side, kind), "{side} {kind:?}: a slice is {budget} of {}", full_bake_work(side, kind));
            }
        }
        assert!(sun_moved(sun(0.0), [1.0; 3], sun(SUN_REBAKE_DEGREES + 0.01), [1.0; 3]));
        assert!(!sun_moved(sun(0.0), [1.0; 3], sun(SUN_REBAKE_DEGREES - 0.01), [1.0; 3]));
        assert!(sun_moved(sun(0.0), [1.0; 3], sun(0.0), [1.1, 1.0, 1.0]), "a brighter sun rebakes too");
    }
}
