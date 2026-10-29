//! Seeded value noise for shapes and placement (AAA review WP-8): [`noise3`] is smooth noise in
//! -1..1 with features one unit apart, [`fbm3`] sums octaves of it. Integer hashing and IEEE
//! arithmetic only, so a seed gives the same field on every destination: a displaced rock or a
//! clustered scatter is the same on the web as on a desktop.

use crate::math::{self, Vec3};

/// How much each finer octave of [`fbm3`] weighs against the one before.
const FBM_GAIN: f32 = 0.5;
/// How much finer each octave of [`fbm3`] is than the one before.
const FBM_LACUNARITY: f32 = 2.03;
/// The most octaves [`fbm3`] sums.
pub const NOISE_OCTAVES_MAX: u32 = 8;
/// 2^-24: a 24-bit hash as a unit float.
const UNIT: f32 = 1.0 / 16_777_216.0;

/// A well-mixed 32-bit hash of a lattice point and a seed.
fn hash(x: i32, y: i32, z: i32, seed: u32) -> u32 {
    let mut h = seed ^ 0x9E37_79B9;
    for value in [x, y, z] {
        h = (h ^ value as u32).wrapping_mul(0x85EB_CA6B);
        h ^= h >> 13;
        h = h.wrapping_mul(0xC2B2_AE35);
        h ^= h >> 16;
    }
    h
}

/// The lattice value at a point, -1..1.
fn lattice(x: i32, y: i32, z: i32, seed: u32) -> f32 {
    (hash(x, y, z, seed) >> 8) as f32 * UNIT * 2.0 - 1.0
}

/// The quintic fade (6t^5 - 15t^4 + 10t^3): smooth to the second derivative at the lattice.
fn fade(t: f32) -> f32 {
    t * t * t * (t * (t * 6.0 - 15.0) + 10.0)
}

/// Smooth value noise at `p`, -1..1, its features about one unit apart; `seed` picks the field.
pub fn noise3(p: Vec3, seed: u32) -> f32 {
    let floor = Vec3::new(math::floor(p.x), math::floor(p.y), math::floor(p.z));
    let (x, y, z) = (floor.x as i32, floor.y as i32, floor.z as i32);
    let f = p - floor;
    let (u, v, w) = (fade(f.x), fade(f.y), fade(f.z));
    let mix = |a: f32, b: f32, t: f32| a + (b - a) * t;
    let row = |dy: i32, dz: i32| mix(lattice(x, y + dy, z + dz, seed), lattice(x + 1, y + dy, z + dz, seed), u);
    let near = mix(row(0, 0), row(1, 0), v);
    let far = mix(row(0, 1), row(1, 1), v);
    let value = mix(near, far, w);
    if value.is_finite() { value } else { 0.0 }
}

/// `octaves` (1 to [`NOISE_OCTAVES_MAX`]) of [`noise3`], each finer and fainter, scaled back to
/// about -1..1: a natural, many-sized roughness.
pub fn fbm3(p: Vec3, seed: u32, octaves: u32) -> f32 {
    let mut sum = 0.0;
    let mut weight = 1.0;
    let mut total = 0.0;
    let mut at = p;
    for octave in 0..octaves.clamp(1, NOISE_OCTAVES_MAX) {
        sum += noise3(at, seed.wrapping_add(octave.wrapping_mul(0x632B_E5AB))) * weight;
        total += weight;
        weight *= FBM_GAIN;
        at *= FBM_LACUNARITY;
    }
    sum / total
}
