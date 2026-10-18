//! The ocean tier (renderer pass 2, B.10; prior-art B3): an open sea from a periodic wave patch
//! evolved by FFT on the GPU, with a deterministic CPU twin that gameplay reads.
//!
//! - **Spectrum** ([`OceanSpectrum`]): a directional Phillips spectrum for a wind speed and
//!   direction over a square patch, scaled to a significant wave height, its Gaussian draws hashed
//!   from a seed ([`OceanSpectrum::initial`]): the same table on every machine. It is uploaded once.
//! - **Simulation** ([`OceanNode::simulate`], `shaders/ocean/ocean_fft.wgsl`): every frame the
//!   spectrum is turned to the frame's time (deep-water dispersion rounded to a repeat period, so
//!   the sea loops every [`REPEAT_S`] seconds), then brought to space by a 256-point radix-2
//!   Stockham FFT, one row or column per 256-invocation workgroup (WebGPU core's limit, 8 KB of
//!   workgroup memory), into a displacement map (choppy x and z, height, the Jacobian) and a slope
//!   map. Graph node 11's compute slot (the sky LUTs' and environment's) runs it.
//! - **Surface** ([`OceanNode::draw`], `shaders/ocean/ocean.wgsl`): a camera-centred grid displaced
//!   by the maps, shaded with the sky's reflection (Fresnel F0 0.02), a capped glint, light through
//!   the crests, fold and coast foam and absorption over the path to the bed, blended over the
//!   scene. Its own layout: four sampled textures, none of the forward stage's sixteen (plan
//!   section 2, D1).
//! - **TAA's key** ([`OceanNode::encode_motion`], `fs_ocean_motion`): after the colour pass the
//!   displaced surface writes its own motion under the camera and its depth into the motion
//!   prepass's targets (reactive 0), as the lake does (T-01 step 3).
//! - **CPU twin** ([`OceanTwin`]): the same spectrum, the same dispersion and the same Stockham
//!   passes in f32 with libm, so a boat floats on the waves the picture shows
//!   ([`OceanSurface::height_at`]) and two runs read the same bits.
//!
//! The method is Tessendorf's ("Simulating Ocean Water"); the Stockham FFT over workgroup memory
//! follows the idea of bevy-aqua-fft (MIT OR Apache-2.0). No source text is copied. The tier is on
//! for desktop `high` and `ultra` ([`enabled`]); phones are unverified and off. Its budget is
//! [`OCEAN_MS_MAX`] for the simulation and the surface together.

use bytemuck::{Pod, Zeroable};
use wgpu::{BindGroup, BindGroupLayout, Buffer, ComputePipeline, Device, Queue, RenderPass, RenderPipeline, Sampler, Texture, TextureFormat, TextureView};

use crate::compile::Compiled;
use crate::device_class::{DeviceClass, FormFactor};
use crate::error::RenderError;
use crate::settings::QualityPreset;

/// The simulation's kernels: the spectrum, the row and column transforms and the resolve.
pub const OCEAN_FFT: &str = crate::shaders::minify::shipped_wgsl!(include_str!("../shaders/ocean/ocean_fft.wgsl"));
/// The surface's shader: the common structs, the clip position, then the ocean.
pub const OCEAN: &str = crate::shaders::minify::shipped_wgsl!(concat!(include_str!("../shaders/common.wgsl"), include_str!("../shaders/clip_position.wgsl"), include_str!("../shaders/ocean/ocean.wgsl")));

/// The FFT's size: texels a side of the patch's maps (`GX_OCEAN_N`).
pub const GRID: u32 = 256;
/// log2 of [`GRID`]: the Stockham passes per transform.
pub const LOG2_GRID: u32 = 8;
/// Invocations per transform workgroup (one per element of a row or column).
pub const FFT_INVOCATIONS: u32 = 256;
/// Workgroup memory the transform uses, bytes (two ping-pong rows of two complex pairs).
pub const FFT_WORKGROUP_BYTES: u32 = 2 * GRID * 16;
/// The resolve and spectrum kernels' workgroup side.
pub const TILE: u32 = 16;
/// The spectrum's complex pairs per texel (each packs two real fields twice).
pub const PAIRS: u32 = 2;
/// Gravity, m/s² (`GX_OCEAN_GRAVITY`).
pub const GRAVITY: f32 = 9.81;
/// The sea loops every this many seconds: every wave's angular frequency is a multiple of
/// 2π / `REPEAT_S`.
pub const REPEAT_S: f32 = 200.0;
/// The maps' format (a core storage format, filterable).
pub const MAP_FORMAT: TextureFormat = TextureFormat::Rgba16Float;
/// Quads a side of the surface's grid.
pub const SURFACE_QUADS: u32 = 256;
/// The surface's vertex count.
pub const SURFACE_VERTICES: u32 = SURFACE_QUADS * SURFACE_QUADS * 6;
/// The vertex entry point.
pub const VERTEX_ENTRY: &str = "vs_ocean";
/// The fragment entry point.
pub const FRAGMENT_ENTRY: &str = "fs_ocean";
/// The motion key's fragment entry point (the motion prepass's targets).
pub const MOTION_FRAGMENT_ENTRY: &str = "fs_ocean_motion";
/// The simulation's and the surface's budget together, ms, at desktop high (plan B.10).
pub const OCEAN_MS_MAX: f32 = 2.0;
/// The sampled textures the surface's group binds (displacement, slope, depth, environment).
pub const SAMPLED_TEXTURES: u32 = 4;
/// The storage buffers the surface binds.
pub const STORAGE_BUFFERS: u32 = 0;
/// The storage buffers the simulation binds (the initial spectrum, the working spectrum).
pub const FFT_STORAGE_BUFFERS: u32 = 2;
/// The storage textures the simulation writes (displacement, slope).
pub const FFT_STORAGE_TEXTURES: u32 = 2;
/// The smallest Jacobian denominator a slope is divided by (`GX_OCEAN_SLOPE_FLOOR`).
pub const SLOPE_FLOOR: f32 = 0.1;
/// Fixed-point steps [`OceanSurface::height_at`] takes to find the grid point displaced over a spot.
pub const HEIGHT_ITERATIONS: u32 = 4;

const TAU: f32 = core::f32::consts::TAU;

/// Whether the ocean tier is on for `preset` on `class`: desktop `high` and `ultra` (plan B.10;
/// phones unverified, so off).
pub fn enabled(preset: QualityPreset, class: DeviceClass) -> bool {
    class.form == FormFactor::Desktop && matches!(preset, QualityPreset::High | QualityPreset::Ultra)
}

/// A sea state: the patch, the wind and the waves' height and shape.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct OceanSpectrum {
    /// The patch's side, m (it tiles; the maps hold [`GRID`] texels over it).
    pub patch_m: f32,
    /// The wind's speed, m/s (the longest waves grow with its square).
    pub wind_speed: f32,
    /// The wind's direction in xz (normalised on use).
    pub wind_dir: [f32; 2],
    /// The significant wave height (four standard deviations of the height), m.
    pub significant_height_m: f32,
    /// How far crests pinch (Tessendorf's lambda; 0 rolling sines).
    pub choppiness: f32,
    /// What share of a wave travelling against the wind is kept (0 none, 1 all).
    pub against_wind: f32,
    /// Waves shorter than this are damped, m.
    pub small_wave_m: f32,
    /// The draws' seed.
    pub seed: u32,
}

impl OceanSpectrum {
    /// A moderate coastal sea: a 9 m/s onshore breeze over a 256 m patch, 1.2 m significant height.
    pub const COAST: OceanSpectrum = OceanSpectrum { patch_m: 256.0, wind_speed: 9.0, wind_dir: [0.0, -1.0], significant_height_m: 1.2, choppiness: 1.1, against_wind: 0.07, small_wave_m: 0.25, seed: 0x6765_6e78 };

    fn wind(&self) -> [f32; 2] {
        let [x, z] = self.wind_dir;
        let length = (x * x + z * z).sqrt();
        if length <= 1e-6 { [1.0, 0.0] } else { [x / length, z / length] }
    }

    /// The directional Phillips spectrum's shape at wave vector `k` (unscaled).
    pub fn phillips(&self, k: [f32; 2]) -> f32 {
        let length = (k[0] * k[0] + k[1] * k[1]).sqrt();
        if length < 1e-6 {
            return 0.0;
        }
        let longest = self.wind_speed * self.wind_speed / GRAVITY;
        let wind = self.wind();
        let along = (k[0] * wind[0] + k[1] * wind[1]) / length;
        let k2 = length * length;
        let shape = libm::expf(-1.0 / (k2 * longest * longest)) / (k2 * k2) * along * along * libm::expf(-k2 * self.small_wave_m * self.small_wave_m);
        if along < 0.0 { shape * self.against_wind } else { shape }
    }

    /// The initial spectrum, one row per texel (row z, column x): h0(k) in xy and conj(h0(-k)) in
    /// zw, scaled so the sea's mean square height is (significant height / 4)².
    pub fn initial(&self) -> Vec<[f32; 4]> {
        let n = GRID as usize;
        let mut h0 = vec![[0.0f32; 2]; n * n];
        let mut energy = 0.0f64;
        for row in 0..n {
            for column in 0..n {
                let k = wave_vector(self.patch_m, column as u32, row as u32);
                let amplitude = (self.phillips(k) * 0.5).sqrt();
                let index = row * n + column;
                let (a, b) = gaussian_pair(self.seed, index as u32);
                h0[index] = [a * amplitude, b * amplitude];
                energy += f64::from(h0[index][0] * h0[index][0] + h0[index][1] * h0[index][1]);
            }
        }
        // A wave's mean square over time is |h0(k)|² + |h0(-k)|²: twice the table's energy.
        let wanted = f64::from(self.significant_height_m / 4.0).powi(2);
        let scale = if energy > 0.0 { (wanted / (2.0 * energy)).sqrt() as f32 } else { 0.0 };
        (0..n * n)
            .map(|index| {
                let (row, column) = (index / n, index % n);
                let mirror = ((n - row) % n) * n + (n - column) % n;
                let [a, b] = h0[index];
                let [c, d] = h0[mirror];
                [a * scale, b * scale, c * scale, -d * scale]
            })
            .collect()
    }
}

/// The wave vector of spectrum texel (`column`, `row`) over a `patch_m` patch, rad/m (centred:
/// index N/2 is k = 0; `gx_ocean_wave_vector`).
pub fn wave_vector(patch_m: f32, column: u32, row: u32) -> [f32; 2] {
    let half = (GRID / 2) as f32;
    [(column as f32 - half) * (TAU / patch_m), (row as f32 - half) * (TAU / patch_m)]
}

fn pcg(value: u32) -> u32 {
    let state = value.wrapping_mul(747_796_405).wrapping_add(2_891_336_453);
    let word = ((state >> ((state >> 28) + 4)) ^ state).wrapping_mul(277_803_737);
    (word >> 22) ^ word
}

fn unit_interval(hash: u32) -> f32 {
    ((hash >> 8) as f32 + 0.5) / 16_777_216.0
}

/// Two independent standard normal draws for texel `index` under `seed` (Box-Muller over a PCG
/// hash): the same numbers on every machine.
pub fn gaussian_pair(seed: u32, index: u32) -> (f32, f32) {
    let first = pcg(seed ^ pcg(index.wrapping_mul(2)));
    let second = pcg(first ^ pcg(index.wrapping_mul(2).wrapping_add(1)));
    let radius = (-2.0 * libm::logf(unit_interval(first))).sqrt();
    let angle = TAU * unit_interval(second);
    (radius * libm::cosf(angle), radius * libm::sinf(angle))
}

/// The ocean's clock: `time` seconds as a fraction of the repeat period (0..1), in f64 first so a
/// long session keeps the same precision (`tile.z` of the simulation's row).
pub fn period_fraction(time: f64) -> f32 {
    let period = f64::from(REPEAT_S);
    (time.rem_euclid(period) / period) as f32
}

/// The phase a wave of number `k` has turned through at `fraction` of the repeat period
/// (`gx_ocean_phase`).
pub fn phase(k: f32, fraction: f32) -> f32 {
    let step = TAU / REPEAT_S;
    let steps = ((GRAVITY * k).sqrt() / step).floor();
    let turned = steps * fraction;
    TAU * (turned - turned.floor())
}

type Complex = [f32; 2];

fn mul(a: Complex, b: Complex) -> Complex {
    [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]]
}

fn times_i(a: Complex) -> Complex {
    [-a[1], a[0]]
}

fn add(a: Complex, b: Complex) -> Complex {
    [a[0] + b[0], a[1] + b[1]]
}

fn scale(s: f32, a: Complex) -> Complex {
    [s * a[0], s * a[1]]
}

/// The two spectrum pairs of texel (`column`, `row`) at `fraction` of the repeat period from its
/// initial row `h0` (`cs_ocean_spectrum`): pair 0 (height + i x-displacement, z-displacement +
/// i x-slope), pair 1 (z-slope + i dDx/dx, dDz/dz + i dDx/dz).
pub fn spectrum_texel(patch_m: f32, column: u32, row: u32, h0: [f32; 4], fraction: f32) -> [[f32; 4]; 2] {
    let kv = wave_vector(patch_m, column, row);
    let k = (kv[0] * kv[0] + kv[1] * kv[1]).sqrt();
    let angle = phase(k, fraction);
    let turn = [libm::cosf(angle), libm::sinf(angle)];
    let h = add(mul([h0[0], h0[1]], turn), mul([h0[2], h0[3]], [turn[0], -turn[1]]));
    let unit = if k > 1e-6 { [kv[0] / k, kv[1] / k] } else { [0.0, 0.0] };
    let ih = times_i(h);
    let dx = scale(unit[0], ih);
    let dz = scale(unit[1], ih);
    let sx = scale(kv[0], ih);
    let sz = scale(kv[1], ih);
    let dxx = scale(-(kv[0] * unit[0]), h);
    let dzz = scale(-(kv[1] * unit[1]), h);
    let dxz = scale(-(kv[0] * unit[1]), h);
    let pack = |a: Complex, b: Complex, c: Complex, d: Complex| {
        let first = add(a, times_i(b));
        let second = add(c, times_i(d));
        [first[0], first[1], second[0], second[1]]
    };
    [pack(h, dx, dz, sx), pack(sz, dxx, dzz, dxz)]
}

/// The twiddle factors of every inverse Stockham pass over `n` points (`gx_ocean_stockham`'s `w`):
/// for sub-transform size `ns` (1, 2, 4, ..), entry `ns - 1 + k` is exp(i 2π k / 2ns), computed
/// with the GPU's formula once instead of per lane.
fn twiddles(n: u32) -> Vec<Complex> {
    let mut table = Vec::with_capacity(n.saturating_sub(1) as usize);
    let mut ns = 1;
    while ns < n {
        for k in 0..ns {
            let angle = TAU * k as f32 / (2 * ns) as f32;
            table.push([libm::cosf(angle), libm::sinf(angle)]);
        }
        ns *= 2;
    }
    table
}

/// One inverse radix-2 Stockham pass (sub-transform size `ns`) from `source` into `target`, every
/// output `lane` as the GPU's lane computes it: target[lane] = source[j] ± w source[j + n/2].
fn stockham_pass(source: &[[f32; 4]], target: &mut [[f32; 4]], ns: u32, table: &[Complex]) {
    let n = source.len() as u32;
    for (lane, out) in (0..n).zip(target.iter_mut()) {
        let j = ((lane / (2 * ns)) * ns + lane % ns) as usize;
        let (input, partner) = (source[j], source[j + n as usize / 2]);
        let w = table[(ns - 1 + lane % ns) as usize];
        let b0 = mul([partner[0], partner[1]], w);
        let b1 = mul([partner[2], partner[3]], w);
        let b = [b0[0], b0[1], b1[0], b1[1]];
        let upper = (lane / ns) % 2 == 1;
        *out = core::array::from_fn(|c| if upper { input[c] - b[c] } else { input[c] + b[c] });
    }
}

/// The inverse transform of `row` in place through `scratch` (its length) with `table`
/// ([`twiddles`] of its length).
fn inverse_fft_with(row: &mut [[f32; 4]], scratch: &mut [[f32; 4]], table: &[Complex]) {
    let n = row.len() as u32;
    let mut ns = 1;
    let mut in_row = true;
    while ns < n {
        if in_row {
            stockham_pass(row, scratch, ns, table);
        } else {
            stockham_pass(scratch, row, ns, table);
        }
        in_row = !in_row;
        ns *= 2;
    }
    if !in_row {
        row.copy_from_slice(scratch);
    }
}

/// The inverse transform (positive exponent, unnormalised) of `row` in place, two complex
/// channels per element, by the GPU's Stockham passes (`gx_ocean_transform`). `row.len()` is a
/// power of two.
pub fn inverse_fft(row: &mut [[f32; 4]]) {
    let table = twiddles(row.len() as u32);
    let mut scratch = vec![[0.0f32; 4]; row.len()];
    inverse_fft_with(row, &mut scratch, &table);
}

/// One frame of the patch's maps, as the GPU writes them: per texel (row z, column x) the
/// displacement (x, height, z, Jacobian) and the slope (x, z, 0, 0).
#[derive(Clone, Debug, PartialEq)]
pub struct OceanField {
    /// rgba of the displacement map.
    pub displacement: Vec<[f32; 4]>,
    /// rgba of the slope map.
    pub slope: Vec<[f32; 4]>,
}

/// The ocean's CPU twin: the initial spectrum once, then any time's field or surface.
#[derive(Clone, Debug)]
pub struct OceanTwin {
    spectrum: OceanSpectrum,
    h0: Vec<[f32; 4]>,
}

/// Where the sea's surface is at one time: the height and the choppy displacement per texel.
#[derive(Clone, Debug, PartialEq)]
pub struct OceanSurface {
    patch_m: f32,
    /// Per texel (row z, column x): x displacement, height, z displacement.
    displacement: Vec<[f32; 3]>,
}

fn transform_2d(pairs: &mut [[f32; 4]]) {
    let n = GRID as usize;
    let table = twiddles(GRID);
    let mut scratch = vec![[0.0f32; 4]; n];
    for row in pairs.chunks_mut(n) {
        inverse_fft_with(row, &mut scratch, &table);
    }
    let mut column = vec![[0.0f32; 4]; n];
    for x in 0..n {
        for (z, texel) in column.iter_mut().enumerate() {
            *texel = pairs[z * n + x];
        }
        inverse_fft_with(&mut column, &mut scratch, &table);
        for (z, texel) in column.iter().enumerate() {
            pairs[z * n + x] = *texel;
        }
    }
}

fn texel_sign(index: usize) -> f32 {
    let n = GRID as usize;
    if (index / n + index % n) % 2 == 1 { -1.0 } else { 1.0 }
}

impl OceanTwin {
    /// The twin of `spectrum` (its initial table drawn once).
    pub fn new(spectrum: OceanSpectrum) -> OceanTwin {
        OceanTwin { spectrum, h0: spectrum.initial() }
    }

    /// The sea state it simulates.
    pub fn spectrum(&self) -> &OceanSpectrum {
        &self.spectrum
    }

    /// The initial spectrum table the GPU is given.
    pub fn initial(&self) -> &[[f32; 4]] {
        &self.h0
    }

    fn pair(&self, which: usize, fraction: f32) -> Vec<[f32; 4]> {
        let n = GRID;
        let mut pairs: Vec<[f32; 4]> = (0..n * n).map(|index| spectrum_texel(self.spectrum.patch_m, index % n, index / n, self.h0[index as usize], fraction)[which]).collect();
        transform_2d(&mut pairs);
        for (index, texel) in pairs.iter_mut().enumerate() {
            let sign = texel_sign(index);
            *texel = texel.map(|c| c * sign);
        }
        pairs
    }

    /// The maps the GPU writes at `time` seconds (`cs_ocean_resolve`).
    pub fn field(&self, time: f64) -> OceanField {
        let fraction = period_fraction(time);
        let p0 = self.pair(0, fraction);
        let p1 = self.pair(1, fraction);
        let lambda = self.spectrum.choppiness;
        let (displacement, slope) = p0
            .iter()
            .zip(&p1)
            .map(|(a, b)| {
                let jxx = 1.0 + lambda * b[1];
                let jzz = 1.0 + lambda * b[2];
                let jxz = lambda * b[3];
                let jacobian = jxx * jzz - jxz * jxz;
                ([lambda * a[1], a[0], lambda * a[2], jacobian], [a[3] / jxx.max(SLOPE_FLOOR), b[0] / jzz.max(SLOPE_FLOOR), 0.0, 0.0])
            })
            .unzip();
        OceanField { displacement, slope }
    }

    /// The surface at `time` seconds for gameplay: one transform of pair 0 (height and the two
    /// displacements), half the field's work.
    pub fn surface(&self, time: f64) -> OceanSurface {
        let lambda = self.spectrum.choppiness;
        let displacement = self.pair(0, period_fraction(time)).iter().map(|a| [lambda * a[1], a[0], lambda * a[2]]).collect();
        OceanSurface { patch_m: self.spectrum.patch_m, displacement }
    }
}

impl OceanSurface {
    /// The displacement (x, height, z) of the undisplaced point (`x`, `z`), bilinear between
    /// texels, the patch tiling (the GPU's repeat sampler at texel centres).
    pub fn displacement_at(&self, x: f32, z: f32) -> [f32; 3] {
        let n = GRID as i64;
        let u = x / self.patch_m * GRID as f32 - 0.5;
        let v = z / self.patch_m * GRID as f32 - 0.5;
        let (u0, v0) = (u.floor(), v.floor());
        let (fu, fv) = (u - u0, v - v0);
        let texel = |du: i64, dv: i64| {
            let column = (u0 as i64 + du).rem_euclid(n);
            let row = (v0 as i64 + dv).rem_euclid(n);
            self.displacement[(row * n + column) as usize]
        };
        let lerp = |a: [f32; 3], b: [f32; 3], t: f32| -> [f32; 3] { core::array::from_fn(|c| a[c] + (b[c] - a[c]) * t) };
        lerp(lerp(texel(0, 0), texel(1, 0), fu), lerp(texel(0, 1), texel(1, 1), fu), fv)
    }

    /// The sea's height over world spot (`x`, `z`), m above the sea level: the grid point whose
    /// choppy displacement lands on the spot is found by [`HEIGHT_ITERATIONS`] fixed-point steps.
    pub fn height_at(&self, x: f32, z: f32) -> f32 {
        let (mut px, mut pz) = (x, z);
        for _ in 0..HEIGHT_ITERATIONS {
            let d = self.displacement_at(px, pz);
            px = x - d[0];
            pz = z - d[2];
        }
        self.displacement_at(px, pz)[1]
    }
}

/// The simulation's uniform row (`OceanParams` in shaders/ocean/ocean_fft.wgsl).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct GpuOceanParams {
    /// x: the patch, m; y: choppiness; z: the time's fraction of the repeat period; w: 2π / period.
    pub tile: [f32; 4],
    /// x: [`GRID`]; y: [`LOG2_GRID`]; zw: 0.
    pub grid: [u32; 4],
}

impl GpuOceanParams {
    /// The row for `spectrum` at `time` seconds.
    pub fn new(spectrum: &OceanSpectrum, time: f64) -> GpuOceanParams {
        GpuOceanParams { tile: [spectrum.patch_m, spectrum.choppiness, period_fraction(time), TAU / REPEAT_S], grid: [GRID, LOG2_GRID, 0, 0] }
    }
}

/// How the sea looks: its colour, foam and reflection.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct OceanLook {
    /// Beer-Lambert absorption per metre, linear rgb.
    pub absorption: [f32; 3],
    /// The water body's in-scattered albedo, linear rgb.
    pub scatter: [f32; 3],
    /// The light through the crests facing away from the sun (0 none).
    pub crest_light: f32,
    /// The Jacobian under which folding waves foam (1 foams every compression; 0 none).
    pub fold_foam: f32,
    /// How wide the coast's foam reaches, metres of water under the surface.
    pub shore_foam_m: f32,
    /// The reflection's roughness.
    pub roughness: f32,
    /// The glint's cap, a multiple of the sun's radiance.
    pub glint_max: f32,
}

impl OceanLook {
    /// A temperate sea: blue-green body, white folds, a surf line.
    pub const SEA: OceanLook = OceanLook { absorption: [0.46, 0.16, 0.12], scatter: [0.016, 0.085, 0.10], crest_light: 2.5, fold_foam: 0.8, shore_foam_m: 0.25, roughness: 0.06, glint_max: 4.0 };
}

/// The surface's uniform row (`OceanDraw` in shaders/ocean/ocean.wgsl).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct GpuOceanDraw {
    /// The projection the scene depth was drawn with, column-major.
    pub proj: [f32; 16],
    /// Last frame's unjittered view-projection, column-major (this frame's after a reset).
    pub prev_view_proj: [f32; 16],
    /// xz: the grid's centre; y: the sea level; w: the grid's reach, m.
    pub origin: [f32; 4],
    /// x: the patch, m; y: the displacement's fade start, m; z: the shore foam's width, m; w: the
    /// environment cube's mip count.
    pub tile: [f32; 4],
    /// rgb: absorption; w: the fold foam's Jacobian.
    pub absorption: [f32; 4],
    /// rgb: scatter albedo; w: the crests' light.
    pub scatter: [f32; 4],
    /// x: roughness; y: the glint's cap; z: time, s; w: 0.
    pub surface: [f32; 4],
    /// x: depth reversed; y: quads a side; z: the scene depth bound; w: 0.
    pub flags: [u32; 4],
}

/// What one frame's surface row is made of.
#[derive(Clone, Copy, Debug)]
pub struct OceanDrawFrame {
    /// The sea state (its patch).
    pub spectrum: OceanSpectrum,
    /// How it looks.
    pub look: OceanLook,
    /// The sea level, m.
    pub sea_level: f32,
    /// The eye's position (the grid follows it).
    pub eye: [f32; 3],
    /// How far the grid reaches from the eye, m.
    pub reach_m: f32,
    /// The camera's projection (unjittered).
    pub proj: glam::Mat4,
    /// Last frame's unjittered view-projection (this frame's after a history reset).
    pub prev_view_proj: glam::Mat4,
    /// The ocean's clock, s.
    pub time: f32,
    /// The environment cube's mip count.
    pub env_mips: u32,
    /// Whether depth is reversed.
    pub depth_reversed: bool,
    /// Whether the scene depth is bound (absorption to the bed, the coast's foam).
    pub coast: bool,
}

/// The grid's centre for an eye at (`x`, `z`): snapped to the patch's texel so a moving eye never
/// slides the grid's vertices over the waves by less than a texel.
pub fn grid_origin(patch_m: f32, x: f32, z: f32) -> [f32; 2] {
    let texel = patch_m / GRID as f32;
    [(x / texel).round() * texel, (z / texel).round() * texel]
}

impl GpuOceanDraw {
    /// The row for `frame`.
    pub fn new(frame: &OceanDrawFrame) -> GpuOceanDraw {
        let look = &frame.look;
        let patch = frame.spectrum.patch_m;
        let [x, z] = grid_origin(patch, frame.eye[0], frame.eye[2]);
        GpuOceanDraw {
            proj: frame.proj.to_cols_array(),
            prev_view_proj: frame.prev_view_proj.to_cols_array(),
            origin: [x, frame.sea_level, z, frame.reach_m],
            tile: [patch, patch * 0.75, look.shore_foam_m, frame.env_mips as f32],
            absorption: [look.absorption[0], look.absorption[1], look.absorption[2], look.fold_foam],
            scatter: [look.scatter[0], look.scatter[1], look.scatter[2], look.crest_light],
            surface: [look.roughness, look.glint_max, frame.time, 0.0],
            flags: [u32::from(frame.depth_reversed), SURFACE_QUADS, u32::from(frame.coast), 0],
        }
    }
}

/// The targets the surface draws into.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OceanFormats {
    /// The scene colour's format.
    pub colour: TextureFormat,
    /// The depth attachment's format.
    pub depth: TextureFormat,
    /// Whether depth is reversed.
    pub depth_reversed: bool,
}

/// What the surface's group binds besides the maps.
pub struct OceanInput<'a> {
    /// The renderer's frame uniforms.
    pub frame: &'a Buffer,
    /// The scene depth without the ocean (the coast), when the frame has one.
    pub depth: Option<&'a TextureView>,
    /// The environment cube array (layer 0 the sky).
    pub env: &'a TextureView,
}

struct Kernels {
    spectrum: Compiled<ComputePipeline>,
    rows: Compiled<ComputePipeline>,
    columns: Compiled<ComputePipeline>,
    resolve: Compiled<ComputePipeline>,
}

/// The ocean node: the simulation's buffers, maps and kernels, and the surface's pipeline.
pub struct OceanNode {
    spectrum: OceanSpectrum,
    params: Buffer,
    kernels: Kernels,
    sim_group: BindGroup,
    displacement: Texture,
    slope: Texture,
    draw_layout: BindGroupLayout,
    frame_layout: BindGroupLayout,
    surface: Compiled<RenderPipeline>,
    motion: Compiled<RenderPipeline>,
    draw_uniform: Buffer,
    sampler: Sampler,
    neutral_depth: TextureView,
    groups: Option<(BindGroup, BindGroup)>,
}

fn storage_entry(binding: u32, read_only: bool) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::COMPUTE,
        ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Storage { read_only }, has_dynamic_offset: false, min_binding_size: None },
        count: None,
    }
}

fn map_entry(binding: u32) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::COMPUTE,
        ty: wgpu::BindingType::StorageTexture { access: wgpu::StorageTextureAccess::WriteOnly, format: MAP_FORMAT, view_dimension: wgpu::TextureViewDimension::D2 },
        count: None,
    }
}

fn uniform_entry(binding: u32, visibility: wgpu::ShaderStages) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry { binding, visibility, ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None }, count: None }
}

fn sampled_entry(binding: u32, visibility: wgpu::ShaderStages, sample_type: wgpu::TextureSampleType, dimension: wgpu::TextureViewDimension) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry { binding, visibility, ty: wgpu::BindingType::Texture { sample_type, view_dimension: dimension, multisampled: false }, count: None }
}

fn map_texture(device: &Device, label: &str) -> Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d { width: GRID, height: GRID, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: MAP_FORMAT,
        usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    })
}

fn kernel(device: &Device, layout: &wgpu::PipelineLayout, module: &wgpu::ShaderModule, entry: &str) -> Compiled<ComputePipeline> {
    crate::compile::compute_pipeline(
        device,
        &wgpu::ComputePipelineDescriptor { label: Some(entry), layout: Some(layout), module, entry_point: Some(entry), compilation_options: crate::compile::written_first(), cache: None },
    )
}

fn surface_pipeline(device: &Device, layout: &wgpu::PipelineLayout, module: &wgpu::ShaderModule, formats: OceanFormats) -> Compiled<RenderPipeline> {
    let blend = wgpu::BlendState {
        color: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha, operation: wgpu::BlendOperation::Add },
        alpha: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha, operation: wgpu::BlendOperation::Add },
    };
    let compare = if formats.depth_reversed { wgpu::CompareFunction::Greater } else { wgpu::CompareFunction::Less };
    crate::compile::render_pipeline(
        device,
        &wgpu::RenderPipelineDescriptor {
            label: Some("ocean"),
            layout: Some(layout),
            vertex: wgpu::VertexState { module, entry_point: Some(VERTEX_ENTRY), compilation_options: Default::default(), buffers: &[] },
            primitive: wgpu::PrimitiveState { cull_mode: None, ..Default::default() },
            depth_stencil: Some(wgpu::DepthStencilState { format: formats.depth, depth_write_enabled: Some(true), depth_compare: Some(compare), stencil: Default::default(), bias: Default::default() }),
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState {
                module,
                entry_point: Some(FRAGMENT_ENTRY),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState { format: formats.colour, blend: Some(blend), write_mask: wgpu::ColorWrites::ALL })],
            }),
            multiview_mask: None,
            cache: None,
        },
    )
}

fn motion_pipeline(device: &Device, layout: &wgpu::PipelineLayout, module: &wgpu::ShaderModule, formats: OceanFormats) -> Compiled<RenderPipeline> {
    let [normals, motion, reactive] = crate::motion::TARGET_FORMATS;
    let compare = if formats.depth_reversed { wgpu::CompareFunction::Greater } else { wgpu::CompareFunction::Less };
    crate::compile::render_pipeline(
        device,
        &wgpu::RenderPipelineDescriptor {
            label: Some("ocean motion"),
            layout: Some(layout),
            vertex: wgpu::VertexState { module, entry_point: Some(VERTEX_ENTRY), compilation_options: Default::default(), buffers: &[] },
            primitive: wgpu::PrimitiveState { cull_mode: None, ..Default::default() },
            depth_stencil: Some(wgpu::DepthStencilState { format: formats.depth, depth_write_enabled: Some(true), depth_compare: Some(compare), stencil: Default::default(), bias: Default::default() }),
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState {
                module,
                entry_point: Some(MOTION_FRAGMENT_ENTRY),
                compilation_options: Default::default(),
                targets: &[
                    Some(wgpu::ColorTargetState { format: normals, blend: None, write_mask: wgpu::ColorWrites::empty() }),
                    Some(wgpu::ColorTargetState { format: motion, blend: None, write_mask: wgpu::ColorWrites::ALL }),
                    Some(wgpu::ColorTargetState { format: reactive, blend: None, write_mask: wgpu::ColorWrites::ALL }),
                ],
            }),
            multiview_mask: None,
            cache: None,
        },
    )
}

fn sim_layout(device: &Device) -> BindGroupLayout {
    device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("ocean simulation"),
        entries: &[uniform_entry(0, wgpu::ShaderStages::COMPUTE), storage_entry(1, true), storage_entry(2, false), map_entry(3), map_entry(4)],
    })
}

fn draw_layout(device: &Device) -> BindGroupLayout {
    let both = wgpu::ShaderStages::VERTEX_FRAGMENT;
    let float = wgpu::TextureSampleType::Float { filterable: true };
    let d2 = wgpu::TextureViewDimension::D2;
    device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("ocean surface"),
        entries: &[
            uniform_entry(0, both),
            sampled_entry(1, both, float, d2),
            sampled_entry(2, wgpu::ShaderStages::FRAGMENT, float, d2),
            sampled_entry(3, wgpu::ShaderStages::FRAGMENT, wgpu::TextureSampleType::Depth, d2),
            sampled_entry(4, wgpu::ShaderStages::FRAGMENT, float, wgpu::TextureViewDimension::CubeArray),
            wgpu::BindGroupLayoutEntry { binding: 5, visibility: both, ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None },
        ],
    })
}

fn neutral_depth(device: &Device) -> TextureView {
    device
        .create_texture(&wgpu::TextureDescriptor {
            label: Some("ocean neutral depth"),
            size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: TextureFormat::Depth32Float,
            usage: wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        })
        .create_view(&wgpu::TextureViewDescriptor::default())
}

impl OceanNode {
    /// The node for `twin`'s sea state drawn into `formats` (its initial spectrum uploaded once;
    /// the kernels and the surface compile on the compile pool).
    pub fn new(device: &Device, queue: &Queue, twin: &OceanTwin, formats: OceanFormats) -> Result<OceanNode, RenderError> {
        let fft = crate::shaders::module(device, "ocean-fft", OCEAN_FFT)?;
        let sim = sim_layout(device);
        let sim_pipeline = crate::tables::pipeline_layout(device, "ocean simulation", &[&sim]);
        let kernels = Kernels {
            spectrum: kernel(device, &sim_pipeline, &fft, "cs_ocean_spectrum"),
            rows: kernel(device, &sim_pipeline, &fft, "cs_ocean_fft_rows"),
            columns: kernel(device, &sim_pipeline, &fft, "cs_ocean_fft_columns"),
            resolve: kernel(device, &sim_pipeline, &fft, "cs_ocean_resolve"),
        };
        let texels = u64::from(GRID * GRID);
        let params = crate::tables::buffer(device, "ocean params", size_of::<GpuOceanParams>() as u64, wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST)?;
        let h0 = crate::tables::buffer(device, "ocean h0", texels * 16, wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST)?;
        queue.write_buffer(&h0, 0, bytemuck::cast_slice(twin.initial()));
        let working = crate::tables::buffer(device, "ocean spectrum", texels * 16 * u64::from(PAIRS), wgpu::BufferUsages::STORAGE)?;
        let displacement = map_texture(device, "ocean displacement");
        let slope = map_texture(device, "ocean slope");
        let displacement_view = displacement.create_view(&Default::default());
        let slope_view = slope.create_view(&Default::default());
        let sim_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("ocean simulation"),
            layout: &sim,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: params.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: h0.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: working.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::TextureView(&displacement_view) },
                wgpu::BindGroupEntry { binding: 4, resource: wgpu::BindingResource::TextureView(&slope_view) },
            ],
        });
        let module = crate::shaders::module(device, "ocean", OCEAN)?;
        let draw = draw_layout(device);
        let frame_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("ocean frame"), entries: &[uniform_entry(0, wgpu::ShaderStages::VERTEX_FRAGMENT)] });
        let draw_pipeline = crate::tables::pipeline_layout(device, "ocean surface", &[&frame_layout, &draw]);
        let surface = surface_pipeline(device, &draw_pipeline, &module, formats);
        let motion = motion_pipeline(device, &draw_pipeline, &module, formats);
        let draw_uniform = crate::tables::buffer(device, "ocean draw row", size_of::<GpuOceanDraw>() as u64, wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST)?;
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("ocean sampler"),
            address_mode_u: wgpu::AddressMode::Repeat,
            address_mode_v: wgpu::AddressMode::Repeat,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::MipmapFilterMode::Linear,
            ..Default::default()
        });
        Ok(OceanNode {
            spectrum: *twin.spectrum(),
            params,
            kernels,
            sim_group,
            displacement,
            slope,
            draw_layout: draw,
            frame_layout,
            surface,
            motion,
            draw_uniform,
            sampler,
            neutral_depth: neutral_depth(device),
            groups: None,
        })
    }

    /// The displacement map (x, height, z, Jacobian), [`GRID`] a side.
    pub fn displacement(&self) -> &Texture {
        &self.displacement
    }

    /// The slope map (x, z), [`GRID`] a side.
    pub fn slope(&self) -> &Texture {
        &self.slope
    }

    /// Record the simulation at `time` seconds into `encoder` as one compute pass (graph node 11's
    /// slot): the spectrum, the row and column transforms of both pairs, the resolve into the maps.
    pub fn simulate(&self, queue: &Queue, encoder: &mut wgpu::CommandEncoder, time: f64, stamps: Option<wgpu::ComputePassTimestampWrites<'_>>) {
        queue.write_buffer(&self.params, 0, bytemuck::bytes_of(&GpuOceanParams::new(&self.spectrum, time)));
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("ocean simulation"), timestamp_writes: stamps });
        pass.set_bind_group(0, &self.sim_group, &[]);
        let tiles = GRID.div_ceil(TILE);
        pass.set_pipeline(&self.kernels.spectrum);
        pass.dispatch_workgroups(tiles, tiles, 1);
        pass.set_pipeline(&self.kernels.rows);
        pass.dispatch_workgroups(GRID, PAIRS, 1);
        pass.set_pipeline(&self.kernels.columns);
        pass.dispatch_workgroups(GRID, PAIRS, 1);
        pass.set_pipeline(&self.kernels.resolve);
        pass.dispatch_workgroups(tiles, tiles, 1);
    }

    /// Write `row` and bind `input` for this frame's surface.
    pub fn prepare(&mut self, device: &Device, queue: &Queue, row: &GpuOceanDraw, input: &OceanInput<'_>) {
        queue.write_buffer(&self.draw_uniform, 0, bytemuck::bytes_of(row));
        let frame = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("ocean frame"),
            layout: &self.frame_layout,
            entries: &[wgpu::BindGroupEntry { binding: 0, resource: input.frame.as_entire_binding() }],
        });
        let displacement = self.displacement.create_view(&Default::default());
        let slope = self.slope.create_view(&Default::default());
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("ocean surface"),
            layout: &self.draw_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: self.draw_uniform.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&displacement) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(&slope) },
                wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::TextureView(input.depth.unwrap_or(&self.neutral_depth)) },
                wgpu::BindGroupEntry { binding: 4, resource: wgpu::BindingResource::TextureView(input.env) },
                wgpu::BindGroupEntry { binding: 5, resource: wgpu::BindingResource::Sampler(&self.sampler) },
            ],
        });
        self.groups = Some((frame, group));
    }

    /// Draw the surface into a pass over the scene colour and the world depth (after the opaque
    /// scene, with the other transparent draws of node 15).
    pub fn draw(&self, pass: &mut RenderPass<'_>) {
        self.draw_with(pass, &self.surface);
    }

    /// Record the motion key as its own pass: the motion prepass's `targets` (normals, motion,
    /// reactive: [`crate::motion::TARGET_FORMATS`]) and the prepass `depth`, all loaded and kept, so
    /// the sea's motion and depth replace the bed's and the sky's under it before TAA's resolve
    /// (graph node 17) reads them.
    pub fn encode_motion(&self, encoder: &mut wgpu::CommandEncoder, targets: [&TextureView; 3], depth: &TextureView) {
        let keep = wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store };
        let attachments = targets.map(|view| Some(wgpu::RenderPassColorAttachment { view, depth_slice: None, resolve_target: None, ops: keep }));
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("ocean motion"),
            color_attachments: &attachments,
            depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment { view: depth, depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store }), stencil_ops: None }),
            ..Default::default()
        });
        self.draw_with(&mut pass, &self.motion);
    }

    fn draw_with(&self, pass: &mut RenderPass<'_>, pipeline: &Compiled<RenderPipeline>) {
        let Some((frame, group)) = &self.groups else { return };
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, frame, &[]);
        pass.set_bind_group(1, group, &[]);
        pass.draw(0..SURFACE_VERTICES, 0..1);
    }
}
