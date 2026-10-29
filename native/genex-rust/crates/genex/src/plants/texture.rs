//! The plants' textures, painted on the CPU from the seed: tileable bark (albedo, a tangent-space
//! normal map from a height field, ORM with cavity occlusion) and a 2 × 2 atlas of alpha cards
//! (twigs, leaves, needles, fronds or blades, each cell a variant), with a normal map from each
//! card's painted relief. Every value is a function of the texel and the seed (integer hashes,
//! libm), so a plant paints the same texels on every destination.

use super::species::{BarkKind, LeafKind};
use super::{Rng, Season};

/// The texels of one RGBA8 image, rows top first.
pub(crate) struct Image {
    pub(crate) size: u32,
    pub(crate) rgba: Vec<u8>,
}

/// A bark set: albedo (sRGB), normal map, ORM (occlusion, roughness, metal 0).
pub(crate) struct BarkMaps {
    pub(crate) albedo: Image,
    pub(crate) normal: Image,
    pub(crate) orm: Image,
}

/// A foliage atlas: albedo with alpha (sRGB) and its normal map.
pub(crate) struct CardMaps {
    pub(crate) albedo: Image,
    pub(crate) normal: Image,
}

// --- Hashes and tileable noise -------------------------------------------------------------

fn hash(x: i32, y: i32, seed: u32) -> u32 {
    let mut h = (x as u32).wrapping_mul(0x8da6_b343) ^ (y as u32).wrapping_mul(0xd816_3841) ^ seed.wrapping_mul(0xcb1a_b31f);
    h ^= h >> 15;
    h = h.wrapping_mul(0x2c1b_3c6d);
    h ^= h >> 12;
    h = h.wrapping_mul(0x297a_2d39);
    h ^ (h >> 15)
}

fn unit(h: u32) -> f32 {
    (h >> 8) as f32 / (1u32 << 24) as f32
}

fn smooth(t: f32) -> f32 {
    t * t * (3.0 - 2.0 * t)
}

fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

fn mix3(a: [f32; 3], b: [f32; 3], t: f32) -> [f32; 3] {
    [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]
}

fn scale3(a: [f32; 3], k: f32) -> [f32; 3] {
    [a[0] * k, a[1] * k, a[2] * k]
}

/// Value noise at (`u`, `v`) in the unit square, `cells` lattice cells a side, wrapping.
fn value(u: f32, v: f32, cells: [u32; 2], seed: u32) -> f32 {
    let (x, y) = (u * cells[0] as f32, v * cells[1] as f32);
    let (xi, yi) = (libm::floorf(x), libm::floorf(y));
    let (fx, fy) = (smooth(x - xi), smooth(y - yi));
    let (xi, yi) = (xi as i32, yi as i32);
    let at = |i: i32, j: i32| unit(hash(i.rem_euclid(cells[0] as i32), j.rem_euclid(cells[1] as i32), seed));
    lerp(lerp(at(xi, yi), at(xi + 1, yi), fx), lerp(at(xi, yi + 1), at(xi + 1, yi + 1), fx), fy)
}

/// Fractal value noise, 0..1: `octaves` octaves from `cells`, each twice as fine and half as loud.
fn fbm(u: f32, v: f32, cells: [u32; 2], octaves: u32, seed: u32) -> f32 {
    let (mut sum, mut amp, mut norm) = (0.0, 1.0, 0.0);
    for octave in 0..octaves {
        let scale = 1u32 << octave;
        sum += amp * value(u, v, [cells[0] * scale, cells[1] * scale], seed.wrapping_add(octave * 977));
        norm += amp;
        amp *= 0.5;
    }
    sum / norm
}

/// Ridged noise, 0..1: 1 on the ridges, 0 in the furrows.
fn ridged(u: f32, v: f32, cells: [u32; 2], octaves: u32, seed: u32) -> f32 {
    1.0 - (2.0 * fbm(u, v, cells, octaves, seed) - 1.0).abs()
}

/// Tileable Worley noise: the nearest and second-nearest feature distances (in cells) and the
/// nearest cell's hash.
fn worley(u: f32, v: f32, cells: [u32; 2], seed: u32) -> (f32, f32, u32) {
    let (x, y) = (u * cells[0] as f32, v * cells[1] as f32);
    let (xi, yi) = (libm::floorf(x) as i32, libm::floorf(y) as i32);
    let (mut f1, mut f2, mut id) = (f32::MAX, f32::MAX, 0);
    for dy in -1..=1 {
        for dx in -1..=1 {
            let (cx, cy) = (xi + dx, yi + dy);
            let h = hash(cx.rem_euclid(cells[0] as i32), cy.rem_euclid(cells[1] as i32), seed);
            let px = cx as f32 + 0.15 + 0.7 * unit(h);
            let py = cy as f32 + 0.15 + 0.7 * unit(h.rotate_left(13));
            let d = libm::sqrtf((px - x) * (px - x) + (py - y) * (py - y));
            if d < f1 {
                f2 = f1;
                f1 = d;
                id = h;
            } else if d < f2 {
                f2 = d;
            }
        }
    }
    (f1, f2, id)
}

// --- Bark ------------------------------------------------------------------------------------

/// One bark texel: linear albedo, height 0..1, roughness.
struct BarkTexel {
    albedo: [f32; 3],
    height: f32,
    roughness: f32,
}

/// Birch: chalk-white paper with horizontal lenticels, dark horizontal patches and peeling curls.
fn birch(u: f32, v: f32, seed: u32) -> BarkTexel {
    let paper = mix3([0.80, 0.79, 0.75], [0.66, 0.63, 0.56], fbm(u, v, [6, 3], 4, seed));
    let mut albedo = mix3(paper, [0.86, 0.85, 0.82], 0.5 * fbm(u, v, [32, 64], 2, seed + 5));
    let mut height = 0.5 + 0.1 * fbm(u, v, [16, 32], 3, seed + 9);
    let mut roughness = 0.55;
    // Lenticels: short dark horizontal dashes, several a band.
    const BANDS: i32 = 56;
    let band = libm::floorf(v * BANDS as f32) as i32;
    let local = v * BANDS as f32 - band as f32;
    for k in 0..3 {
        let h = hash(band.rem_euclid(BANDS), k, seed + 17);
        if unit(h) < 0.25 {
            continue;
        }
        let centre = unit(h.rotate_left(7));
        let half = 0.012 + 0.05 * unit(h.rotate_left(14));
        let across = 0.5 + 0.35 * (unit(h.rotate_left(21)) - 0.5);
        let du = (u - centre + 1.5).rem_euclid(1.0) - 0.5;
        let along = (du / half).abs();
        let thickness = 0.12 * (1.0 - along * along).max(0.0);
        if along < 1.0 && (local - across).abs() < thickness {
            albedo = mix3(albedo, [0.13, 0.11, 0.10], 0.85);
            height -= 0.35;
            roughness = 0.8;
        }
    }
    // Dark patches, wider than they are tall, and the rough scar under them.
    let patch = fbm(u, v, [4, 14], 4, seed + 31);
    if patch > 0.64 {
        let t = smooth(((patch - 0.64) / 0.08).min(1.0));
        let scar = fbm(u, v, [40, 80], 2, seed + 37);
        albedo = mix3(albedo, scale3([0.07, 0.065, 0.06], 0.7 + 0.6 * scar), t);
        height += t * (0.15 + 0.2 * scar);
        roughness = lerp(roughness, 0.9, t);
    }
    // Peeling curls: thin warm strips catching the light at their edge.
    let curl = fbm(u, v, [3, 30], 3, seed + 43);
    if curl > 0.7 {
        let t = smooth(((curl - 0.7) / 0.06).min(1.0));
        albedo = mix3(albedo, [0.72, 0.58, 0.48], 0.5 * t);
        height += 0.12 * t;
    }
    BarkTexel { albedo, height: height.clamp(0.0, 1.0), roughness }
}

/// Deep vertical furrows (oak, willow): ridged noise stretched along the stem, broken by cracks.
fn furrowed(u: f32, v: f32, seed: u32, deep: bool) -> BarkTexel {
    let warp = 0.06 * (fbm(u, v, [4, 4], 3, seed + 3) - 0.5);
    let cells = if deep { [9, 3] } else { [12, 2] };
    let ridge = ridged(u + warp, v, cells, 4, seed);
    let crack = worley(u, v, [6, 3], seed + 11);
    let broken = smooth(((crack.1 - crack.0) * 3.0).min(1.0));
    let height = (libm::powf(ridge, 1.6) * (0.55 + 0.45 * broken)).clamp(0.0, 1.0);
    let (furrow, top) = if deep { ([0.05, 0.045, 0.04], [0.25, 0.235, 0.21]) } else { ([0.05, 0.04, 0.032], [0.26, 0.225, 0.19]) };
    let grain = fbm(u, v, [48, 96], 2, seed + 19);
    let mut albedo = mix3(furrow, top, smooth(height));
    albedo = scale3(albedo, 0.85 + 0.3 * grain);
    // Lichen in the furrows' shelter.
    let lichen = fbm(u, v, [5, 5], 3, seed + 23);
    if lichen > 0.66 && height > 0.4 {
        albedo = mix3(albedo, [0.30, 0.34, 0.22], 0.5 * smooth(((lichen - 0.66) / 0.1).min(1.0)));
    }
    BarkTexel { albedo, height, roughness: lerp(0.95, 0.8, height) }
}

/// Plates: Worley cells split by dark furrows (maple's shallow plates, pine's orange plates).
fn plated(u: f32, v: f32, seed: u32, cells: [u32; 2], plate: [[f32; 3]; 2], furrow: [f32; 3], depth: f32) -> BarkTexel {
    let warp = 0.04 * (fbm(u, v, [6, 6], 2, seed + 7) - 0.5);
    let (f1, f2, id) = worley(u + warp, v, cells, seed);
    let edge = smooth(((f2 - f1) * 4.0).min(1.0));
    let flake = fbm(u, v, [64, 64], 2, seed + 13);
    let tone = unit(id);
    let height = (edge * (0.7 + 0.3 * flake) * depth + (1.0 - depth) * 0.5).clamp(0.0, 1.0);
    let albedo = mix3(furrow, scale3(mix3(plate[0], plate[1], tone), 0.85 + 0.3 * flake), edge);
    BarkTexel { albedo, height, roughness: lerp(0.95, 0.82, edge) }
}

/// Small lifted scales (spruce): fine Worley cells, each lit at its lower edge.
fn scaly(u: f32, v: f32, seed: u32) -> BarkTexel {
    let (f1, f2, id) = worley(u, v, [22, 34], seed);
    let edge = smooth(((f2 - f1) * 3.0).min(1.0));
    let tone = unit(id);
    let albedo = scale3(mix3([0.30, 0.24, 0.19], [0.42, 0.36, 0.30], tone), 0.6 + 0.4 * edge);
    let height = (0.25 + 0.6 * edge * (0.7 + 0.3 * fbm(u, v, [80, 80], 1, seed + 3))).clamp(0.0, 1.0);
    BarkTexel { albedo, height, roughness: 0.88 }
}

/// A palm's ringed, fibrous stem.
fn fibrous(u: f32, v: f32, seed: u32) -> BarkTexel {
    let ring = 0.5 + 0.5 * libm::cosf(v * std::f32::consts::TAU * 18.0 + 0.6 * fbm(u, v, [6, 6], 2, seed));
    let fibre = 0.5 + 0.25 * libm::sinf((u + v) * std::f32::consts::TAU * 40.0) + 0.25 * libm::sinf((u - v) * std::f32::consts::TAU * 40.0);
    let height = (0.6 * libm::powf(ring, 3.0) + 0.3 * fibre + 0.1 * fbm(u, v, [32, 32], 2, seed + 5)).clamp(0.0, 1.0);
    let albedo = scale3(mix3([0.22, 0.18, 0.14], [0.47, 0.40, 0.31], height), 0.85 + 0.3 * fbm(u, v, [8, 16], 3, seed + 9));
    BarkTexel { albedo, height, roughness: 0.9 }
}

/// Smooth young bark (shrubs): fine noise and small lenticels.
fn smooth_bark(u: f32, v: f32, seed: u32) -> BarkTexel {
    let base = mix3([0.26, 0.22, 0.19], [0.38, 0.33, 0.28], fbm(u, v, [8, 8], 4, seed));
    let (f1, _, _) = worley(u, v, [30, 60], seed + 3);
    let pore = f1 < 0.12;
    let albedo = if pore { scale3(base, 0.55) } else { base };
    BarkTexel { albedo, height: if pore { 0.35 } else { 0.5 + 0.1 * fbm(u, v, [40, 40], 2, seed + 7) }, roughness: 0.75 }
}

fn bark_texel(kind: BarkKind, u: f32, v: f32, seed: u32) -> BarkTexel {
    match kind {
        BarkKind::Birch => birch(u, v, seed),
        BarkKind::Furrowed => furrowed(u, v, seed, false),
        BarkKind::Interlaced => furrowed(u, v, seed, true),
        BarkKind::Shallow => plated(u, v, seed, [7, 4], [[0.40, 0.38, 0.35], [0.47, 0.45, 0.41]], [0.16, 0.15, 0.13], 0.6),
        BarkKind::Plates => plated(u, v, seed, [6, 5], [[0.52, 0.31, 0.17], [0.42, 0.29, 0.20]], [0.08, 0.06, 0.05], 1.0),
        BarkKind::Scaly => scaly(u, v, seed),
        BarkKind::Fibrous => fibrous(u, v, seed),
        BarkKind::Smooth => smooth_bark(u, v, seed),
    }
}

/// A dead plant's bark: greyed, bleached and rougher, with a crack network.
fn weathered(texel: BarkTexel, u: f32, v: f32, seed: u32) -> BarkTexel {
    let grey = (texel.albedo[0] + texel.albedo[1] + texel.albedo[2]) / 3.0;
    let albedo = mix3(texel.albedo, [grey * 0.9 + 0.08, grey * 0.9 + 0.08, grey * 0.88 + 0.07], 0.65);
    let (f1, f2, _) = worley(u, v, [14, 30], seed + 101);
    let crack = (f2 - f1) < 0.06;
    let height = if crack { texel.height * 0.3 } else { texel.height };
    BarkTexel { albedo: if crack { scale3(albedo, 0.4) } else { albedo }, height, roughness: (texel.roughness + 0.08).min(1.0) }
}

/// The bark set of `kind` at `size` texels a side (tiling both ways).
pub(crate) fn bark(kind: BarkKind, season: Season, size: u32, seed: u32) -> BarkMaps {
    let n = size as usize;
    let mut texels = Vec::with_capacity(n * n);
    for y in 0..n {
        for x in 0..n {
            let (u, v) = ((x as f32 + 0.5) / size as f32, (y as f32 + 0.5) / size as f32);
            let texel = bark_texel(kind, u, v, seed);
            texels.push(if season == Season::Dead { weathered(texel, u, v, seed) } else { texel });
        }
    }
    let heights: Vec<f32> = texels.iter().map(|t| t.height).collect();
    let strength = match kind {
        BarkKind::Furrowed | BarkKind::Interlaced | BarkKind::Plates => 6.0,
        BarkKind::Birch | BarkKind::Smooth => 2.5,
        _ => 4.5,
    } * size as f32 / 512.0;
    let normal = normal_map(&heights, size, strength, true);
    let blurred = box_blur(&heights, size, (size / 128).max(2) as usize);
    let mut albedo = Vec::with_capacity(n * n * 4);
    let mut orm = Vec::with_capacity(n * n * 4);
    for (at, texel) in texels.iter().enumerate() {
        let cavity = (1.0 - 2.2 * (blurred[at] - texel.height)).clamp(0.35, 1.0);
        albedo.extend(srgb(scale3(texel.albedo, 0.75 + 0.25 * cavity)));
        albedo.push(255);
        orm.extend([byte(cavity), byte(texel.roughness), 0, 255]);
    }
    BarkMaps { albedo: Image { size, rgba: albedo }, normal: Image { size, rgba: normal }, orm: Image { size, rgba: orm } }
}

// --- Normal maps, blur, colour ---------------------------------------------------------------

fn byte(value: f32) -> u8 {
    (value.clamp(0.0, 1.0) * 255.0 + 0.5) as u8
}

/// Linear to sRGB bytes.
fn srgb(c: [f32; 3]) -> [u8; 3] {
    let encode = |x: f32| {
        let x = x.clamp(0.0, 1.0);
        if x <= 0.003_130_8 { x * 12.92 } else { 1.055 * libm::powf(x, 1.0 / 2.4) - 0.055 }
    };
    [byte(encode(c[0])), byte(encode(c[1])), byte(encode(c[2]))]
}

/// A tangent-space normal map (glTF: +x right, +y up the image) of `heights`, `strength` texels of
/// slope per unit height, wrapping or clamped at the edges.
fn normal_map(heights: &[f32], size: u32, strength: f32, wrap: bool) -> Vec<u8> {
    let n = size as i32;
    let at = |x: i32, y: i32| {
        let (x, y) = if wrap { (x.rem_euclid(n), y.rem_euclid(n)) } else { (x.clamp(0, n - 1), y.clamp(0, n - 1)) };
        heights[(y * n + x) as usize]
    };
    let mut out = Vec::with_capacity(heights.len() * 4);
    for y in 0..n {
        for x in 0..n {
            let dx = (at(x + 1, y) - at(x - 1, y)) * 0.5 * strength;
            let down = (at(x, y + 1) - at(x, y - 1)) * 0.5 * strength;
            let (nx, ny, nz) = (-dx, down, 1.0);
            let length = libm::sqrtf(nx * nx + ny * ny + nz * nz);
            out.extend([byte(nx / length * 0.5 + 0.5), byte(ny / length * 0.5 + 0.5), byte(nz / length * 0.5 + 0.5), 255]);
        }
    }
    out
}

/// A separable box blur of `values` (wrapping), `radius` texels.
fn box_blur(values: &[f32], size: u32, radius: usize) -> Vec<f32> {
    let n = size as usize;
    let width = (2 * radius + 1) as f32;
    let pass = |source: &[f32], horizontal: bool| {
        let mut out = vec![0.0; source.len()];
        for line in 0..n {
            let get = |i: usize| if horizontal { source[line * n + i % n] } else { source[(i % n) * n + line] };
            let mut sum: f32 = (0..=2 * radius).map(|k| get(k + n - radius)).sum();
            for i in 0..n {
                let to = if horizontal { line * n + i } else { i * n + line };
                out[to] = sum / width;
                sum += get(i + radius + 1 + n) - get(i + n - radius);
            }
        }
        out
    };
    pass(&pass(values, true), false)
}

// --- Cards -----------------------------------------------------------------------------------

/// A canvas one atlas cell paints into: linear colour, coverage and relief.
struct Canvas {
    size: usize,
    color: Vec<[f32; 3]>,
    alpha: Vec<f32>,
    height: Vec<f32>,
}

impl Canvas {
    fn new(size: usize) -> Canvas {
        Canvas { size, color: vec![[0.0; 3]; size * size], alpha: vec![0.0; size * size], height: vec![0.0; size * size] }
    }

    /// Lay `coverage` of `color` at relief `height` over texel (x, y).
    fn lay(&mut self, x: usize, y: usize, coverage: f32, color: [f32; 3], height: f32) {
        if coverage <= 0.0 {
            return;
        }
        let at = y * self.size + x;
        self.color[at] = mix3(self.color[at], color, coverage);
        self.height[at] = lerp(self.height[at], height, coverage);
        self.alpha[at] = self.alpha[at].max(coverage);
    }

    /// A tapered stroke from `a` to `b` (cell units, y down), radius `ra` to `rb` (cell units),
    /// shaded as a round stem.
    fn stroke(&mut self, a: [f32; 2], b: [f32; 2], radii: [f32; 2], color: [f32; 3]) {
        let s = self.size as f32;
        let (a, b) = ([a[0] * s, a[1] * s], [b[0] * s, b[1] * s]);
        let (ra, rb) = ((radii[0] * s).max(0.35), (radii[1] * s).max(0.35));
        let reach = ra.max(rb) + 1.5;
        let (x0, x1) = ((a[0].min(b[0]) - reach).max(0.0) as usize, ((a[0].max(b[0]) + reach) as usize).min(self.size - 1));
        let (y0, y1) = ((a[1].min(b[1]) - reach).max(0.0) as usize, ((a[1].max(b[1]) + reach) as usize).min(self.size - 1));
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let length2 = (dx * dx + dy * dy).max(1e-6);
        for y in y0..=y1 {
            for x in x0..=x1 {
                let (px, py) = (x as f32 + 0.5 - a[0], y as f32 + 0.5 - a[1]);
                let t = ((px * dx + py * dy) / length2).clamp(0.0, 1.0);
                let (ex, ey) = (px - dx * t, py - dy * t);
                let distance = libm::sqrtf(ex * ex + ey * ey);
                let radius = lerp(ra, rb, t);
                let coverage = (radius - distance + 0.5).clamp(0.0, 1.0) * (radius * 2.0).min(1.0);
                let r = (distance / radius).min(1.0);
                let round = libm::sqrtf((1.0 - r * r).max(0.0));
                self.lay(x, y, coverage, scale3(color, 0.7 + 0.3 * round), 0.3 + 0.4 * round);
            }
        }
    }

    /// A leaf from `base` along `angle` (radians, 0 up the cell), `length` and `width` (cell
    /// units), its half-width along it `profile(s)` (0..1).
    fn leaf(&mut self, base: [f32; 2], angle: f32, size: [f32; 2], color: [f32; 3], profile: &dyn Fn(f32) -> f32) {
        let s = self.size as f32;
        let (length, width) = (size[0] * s, size[1] * s);
        let (along, across) = ([libm::sinf(angle), -libm::cosf(angle)], [libm::cosf(angle), libm::sinf(angle)]);
        let base = [base[0] * s, base[1] * s];
        let reach = length + width;
        let (x0, x1) = ((base[0] - reach).max(0.0) as usize, ((base[0] + reach) as usize).min(self.size - 1));
        let (y0, y1) = ((base[1] - reach).max(0.0) as usize, ((base[1] + reach) as usize).min(self.size - 1));
        for y in y0..=y1 {
            for x in x0..=x1 {
                let (px, py) = (x as f32 + 0.5 - base[0], y as f32 + 0.5 - base[1]);
                let t = (px * along[0] + py * along[1]) / length;
                if !(-0.02..=1.02).contains(&t) {
                    continue;
                }
                let w = px * across[0] + py * across[1];
                let half = 0.5 * width * profile(t.clamp(0.0, 1.0));
                let edge = half - w.abs();
                let coverage = (edge + 0.5).clamp(0.0, 1.0) * ((t * length + 0.5).clamp(0.0, 1.0)) * (((1.0 - t) * length + 0.5).clamp(0.0, 1.0));
                if coverage <= 0.0 {
                    continue;
                }
                let r = (w.abs() / half.max(0.5)).min(1.0);
                let dome = libm::sqrtf(1.0 - r * r);
                let midrib = (1.0 - (w.abs() / 1.2).min(1.0)) * 0.25;
                let vein = 0.06 * (0.5 + 0.5 * libm::cosf((t * 14.0 - r * 3.0) * std::f32::consts::PI));
                let shade = 0.82 + 0.18 * dome + midrib * 0.5 - vein;
                self.lay(x, y, coverage, scale3(color, shade), 0.35 + 0.45 * dome - midrib + vein);
            }
        }
    }
}

/// A colour `variation` away from `color` by `rng`.
fn varied(rng: &mut Rng, color: [f32; 3], variation: f32) -> [f32; 3] {
    let k = 1.0 + variation * rng.signed();
    let warm = 1.0 + 0.5 * variation * rng.signed();
    [color[0] * k * warm, color[1] * k, color[2] * k / warm]
}

/// The leaf colour of `kind` in `season` (linear).
fn leaf_color(kind: LeafKind, season: Season, rng: &mut Rng) -> [f32; 3] {
    let summer = match kind {
        LeafKind::Birch => [0.11, 0.20, 0.035],
        LeafKind::Oak => [0.07, 0.14, 0.03],
        LeafKind::Maple => [0.09, 0.18, 0.03],
        LeafKind::Willow => [0.12, 0.18, 0.05],
        LeafKind::Shrub => [0.06, 0.13, 0.03],
        LeafKind::Spruce => [0.035, 0.075, 0.04],
        LeafKind::Pine => [0.07, 0.12, 0.035],
        LeafKind::Palm => [0.10, 0.17, 0.04],
        LeafKind::Grass => [0.10, 0.19, 0.04],
    };
    match season {
        Season::Leafy => varied(rng, summer, 0.15),
        Season::Autumn => {
            let autumn = match kind {
                LeafKind::Maple => [[0.55, 0.06, 0.02], [0.70, 0.22, 0.02]][rng.below(2)],
                LeafKind::Oak => [0.30, 0.13, 0.03],
                LeafKind::Spruce | LeafKind::Pine => summer,
                LeafKind::Grass => [0.38, 0.30, 0.12],
                _ => [0.62, 0.42, 0.04],
            };
            varied(rng, autumn, 0.2)
        }
        Season::Winter => match kind {
            LeafKind::Spruce | LeafKind::Pine | LeafKind::Palm => varied(rng, scale3(summer, 0.8), 0.1),
            _ => varied(rng, [0.52, 0.44, 0.28], 0.18),
        },
        Season::Dead => varied(rng, [0.33, 0.20, 0.09], 0.2),
    }
}

/// Whether `kind` in `season` keeps its leaves (conifers and palms keep them through winter).
pub(crate) fn keeps_leaves(kind: LeafKind, season: Season) -> bool {
    match season {
        Season::Leafy | Season::Autumn => true,
        Season::Winter => matches!(kind, LeafKind::Spruce | LeafKind::Pine | LeafKind::Palm | LeafKind::Grass),
        Season::Dead => kind == LeafKind::Grass,
    }
}

/// The half-width profile of a leaf of `kind` along it (0 at its base and tip).
fn profile(kind: LeafKind) -> impl Fn(f32) -> f32 {
    move |s: f32| {
        let pi = std::f32::consts::PI;
        match kind {
            // Deltoid with fine teeth.
            LeafKind::Birch => libm::powf(libm::sinf(pi * libm::powf(s, 0.65)), 0.9) * (1.0 - 0.08 * libm::fabsf(libm::sinf(s * 46.0))),
            // Rounded lobes.
            LeafKind::Oak => libm::sinf(pi * libm::powf(s, 0.85)) * (0.6 + 0.4 * libm::fabsf(libm::cosf(s * pi * 4.5))),
            // A pointed lobe (a maple leaf is five of them).
            LeafKind::Maple => libm::sinf(pi * libm::powf(s, 0.55)) * (1.0 - 0.45 * s) * (1.0 - 0.1 * libm::fabsf(libm::sinf(s * 30.0))),
            LeafKind::Willow | LeafKind::Palm | LeafKind::Grass => libm::powf(libm::sinf(pi * s), 1.1),
            _ => libm::powf(libm::sinf(pi * s), 0.8),
        }
    }
}

/// One twig with leaves: a curved stem from the cell's foot, side shoots, leaves along both.
fn paint_leafy_twig(canvas: &mut Canvas, kind: LeafKind, season: Season, rng: &mut Rng, twig: [f32; 3]) {
    let leaf_len = match kind {
        LeafKind::Birch => 0.13,
        LeafKind::Oak => 0.2,
        LeafKind::Maple => 0.17,
        LeafKind::Willow => 0.26,
        _ => 0.11,
    };
    let leaf_width = match kind {
        LeafKind::Willow => 0.045,
        LeafKind::Oak => 0.11,
        LeafKind::Maple => 0.06,
        _ => 0.09,
    };
    let shape = profile(kind);
    let mut stems = vec![([0.5, 0.99], [0.5 + 0.12 * rng.signed(), 0.12], 0.012)];
    for _ in 0..4 {
        let t = 0.2 + 0.55 * rng.unit();
        let from = [lerp(stems[0].0[0], stems[0].1[0], t), lerp(stems[0].0[1], stems[0].1[1], t)];
        let side = if rng.unit() < 0.5 { -1.0 } else { 1.0 };
        stems.push((from, [from[0] + side * (0.25 + 0.15 * rng.unit()), from[1] - 0.25 - 0.2 * rng.unit()], 0.006));
    }
    for (a, b, radius) in &stems {
        canvas.stroke(*a, *b, [*radius, radius * 0.4], twig);
    }
    for (a, b, _) in &stems {
        let count = 7 + rng.below(4);
        let dir = libm::atan2f(b[0] - a[0], a[1] - b[1]);
        for i in 0..count {
            let t = 0.2 + 0.8 * (i as f32 + rng.unit() * 0.5) / count as f32;
            let at = [lerp(a[0], b[0], t), lerp(a[1], b[1], t)];
            let side = if i % 2 == 0 { 1.0 } else { -1.0 };
            let angle = dir + side * (0.5 + 0.5 * rng.unit());
            let length = leaf_len * (0.75 + 0.5 * rng.unit());
            let color = leaf_color(kind, season, rng);
            let petiole = [at[0] + libm::sinf(angle) * length * 0.15, at[1] - libm::cosf(angle) * length * 0.15];
            canvas.stroke(at, petiole, [0.003, 0.002], twig);
            if kind == LeafKind::Maple {
                for (lobe, reach) in [(-1.2, 0.55), (-0.6, 0.85), (0.0, 1.0), (0.6, 0.85), (1.2, 0.55)] {
                    canvas.leaf(petiole, angle + lobe, [length * reach, leaf_width * reach], color, &shape);
                }
            } else {
                canvas.leaf(petiole, angle, [length, leaf_width * (0.8 + 0.4 * rng.unit())], color, &shape);
            }
        }
    }
    // A terminal leaf at the main stem's tip.
    let color = leaf_color(kind, season, rng);
    let (a, b, _) = stems[0];
    canvas.leaf(b, libm::atan2f(b[0] - a[0], a[1] - b[1]), [leaf_len, leaf_width], color, &shape);
}

/// The deepest shoot of a bare twig, and the thinnest stroke (cell units) one keeps: about a
/// texel at a 1024 atlas, so the fine twigs survive the first mips instead of leaving only their
/// buds as specks.
const BARE_TWIG_DEPTH: u32 = 4;
const BARE_TWIG_RADIUS_MIN: f32 = 0.0018;

/// A bare twig: long, sparse shoots thinning to a texel, a little warmer towards their tips, with
/// small buds (and a few of a birch's catkins), so a bare crown reads as a fine purple-grey haze
/// rather than as clumps.
fn paint_bare_twig(canvas: &mut Canvas, kind: LeafKind, season: Season, rng: &mut Rng, twig: [f32; 3]) {
    struct Shoot {
        from: [f32; 2],
        angle: f32,
        length: f32,
        radius: f32,
        depth: u32,
    }
    let dead = season == Season::Dead;
    let mut shoots = vec![Shoot { from: [0.5, 0.99], angle: 0.15 * rng.signed(), length: 0.5, radius: 0.007, depth: 0 }];
    while let Some(shoot) = shoots.pop() {
        let bend = 0.25 * rng.signed();
        let mid = [shoot.from[0] + libm::sinf(shoot.angle) * shoot.length * 0.5, shoot.from[1] - libm::cosf(shoot.angle) * shoot.length * 0.5];
        let angle = shoot.angle + bend;
        // A dead twig snaps short now and then.
        let broken = dead && rng.unit() < 0.2;
        let reach = if broken { 0.15 } else { 0.5 };
        let tip = [mid[0] + libm::sinf(angle) * shoot.length * reach, mid[1] - libm::cosf(angle) * shoot.length * reach];
        let young = shoot.depth as f32 / BARE_TWIG_DEPTH as f32;
        let tone = [twig[0] * (1.0 + 0.2 * young), twig[1] * (1.0 + 0.1 * young), twig[2] * (1.0 + 0.15 * young)];
        let radius = shoot.radius.max(BARE_TWIG_RADIUS_MIN);
        canvas.stroke(shoot.from, mid, [radius, (radius * 0.8).max(BARE_TWIG_RADIUS_MIN)], tone);
        canvas.stroke(mid, tip, [(radius * 0.8).max(BARE_TWIG_RADIUS_MIN), (radius * 0.45).max(BARE_TWIG_RADIUS_MIN)], tone);
        if broken {
            continue;
        }
        if shoot.depth >= BARE_TWIG_DEPTH {
            // A small bud; a birch hangs a catkin from a few tips.
            if rng.unit() < 0.3 {
                canvas.stroke(tip, [tip[0] + libm::sinf(angle) * 0.004, tip[1] - libm::cosf(angle) * 0.004], [BARE_TWIG_RADIUS_MIN, BARE_TWIG_RADIUS_MIN], scale3(tone, 1.15));
            }
            if kind == LeafKind::Birch && !dead && rng.unit() < 0.08 {
                canvas.stroke(tip, [tip[0] + 0.01 * rng.signed(), tip[1] + 0.035], [0.003, 0.0025], [0.22, 0.14, 0.08]);
            }
            continue;
        }
        let children = match shoot.depth {
            0 => 6,
            _ => 2,
        };
        for c in 0..children {
            let t = 0.3 + 0.7 * (c as f32 + 0.5 * rng.unit()) / children as f32;
            let at = [lerp(shoot.from[0], tip[0], t), lerp(shoot.from[1], tip[1], t)];
            let side = if (c + shoot.depth as usize).is_multiple_of(2) { 1.0 } else { -1.0 };
            shoots.push(Shoot { from: at, angle: angle + side * (0.35 + 0.45 * rng.unit()), length: shoot.length * (0.7 + 0.15 * rng.unit()), radius: shoot.radius * 0.7, depth: shoot.depth + 1 });
        }
        shoots.push(Shoot { from: tip, angle, length: shoot.length * 0.65, radius: shoot.radius * 0.7, depth: shoot.depth + 2 });
    }
    // A few dry leaves cling on to a dead twig.
    if dead {
        let shape = profile(LeafKind::Shrub);
        for _ in 0..3 {
            let at = [0.3 + 0.4 * rng.unit(), 0.2 + 0.6 * rng.unit()];
            canvas.leaf(at, rng.signed() * 2.5, [0.07, 0.035], leaf_color(kind, Season::Dead, rng), &shape);
        }
    }
}

/// A conifer spray: a stem with needles on both sides, side shoots with their own.
fn paint_needles(canvas: &mut Canvas, kind: LeafKind, season: Season, rng: &mut Rng, twig: [f32; 3]) {
    let (needle, spacing) = if kind == LeafKind::Pine { (0.12, 0.007) } else { (0.06, 0.004) };
    let bare = season == Season::Dead;
    let mut stems = vec![([0.5, 0.99], [0.5 + 0.05 * rng.signed(), 0.06], 0.01)];
    for i in 0..7 {
        let t = 0.12 + 0.11 * i as f32;
        let from = [lerp(stems[0].0[0], stems[0].1[0], t), lerp(stems[0].0[1], stems[0].1[1], t)];
        let side = if i % 2 == 0 { -1.0 } else { 1.0 };
        stems.push((from, [from[0] + side * (0.34 - 0.035 * i as f32), from[1] - 0.16], 0.005));
    }
    for (a, b, radius) in &stems {
        canvas.stroke(*a, *b, [*radius, radius * 0.5], twig);
        let length = libm::sqrtf((b[0] - a[0]) * (b[0] - a[0]) + (b[1] - a[1]) * (b[1] - a[1]));
        let dir = libm::atan2f(b[0] - a[0], a[1] - b[1]);
        let count = (length / spacing) as usize;
        for i in 0..count {
            let t = (i as f32 + 0.5) / count as f32;
            let at = [lerp(a[0], b[0], t), lerp(a[1], b[1], t)];
            for side in [-1.0, 1.0] {
                if bare && rng.unit() < 0.85 {
                    continue;
                }
                let angle = dir + side * (0.7 + 0.25 * rng.unit());
                let reach = needle * (0.7 + 0.4 * rng.unit()) * (1.0 - 0.3 * t);
                let tip = [at[0] + libm::sinf(angle) * reach, at[1] - libm::cosf(angle) * reach];
                let color = leaf_color(kind, if bare { Season::Dead } else { season }, rng);
                canvas.stroke(at, tip, [0.0036, 0.0016], color);
            }
        }
    }
}

/// A palm frond's piece: a midrib with long leaflets either side.
fn paint_frond(canvas: &mut Canvas, season: Season, rng: &mut Rng) {
    let rib = if season == Season::Dead { [0.28, 0.20, 0.10] } else { [0.18, 0.20, 0.08] };
    canvas.stroke([0.5, 1.0], [0.5, 0.0], [0.01, 0.006], rib);
    let shape = profile(LeafKind::Palm);
    let count = 22;
    for i in 0..count {
        let t = (i as f32 + 0.5) / count as f32;
        let at = [0.5, 1.0 - t];
        for side in [-1.0f32, 1.0] {
            let angle = side * (1.0 + 0.2 * rng.signed());
            let color = leaf_color(LeafKind::Palm, season, rng);
            canvas.leaf(at, angle, [0.46 * (1.0 - 0.4 * t), 0.035], color, &shape);
        }
    }
}

/// Grass blades fanning from the cell's foot.
fn paint_blades(canvas: &mut Canvas, season: Season, rng: &mut Rng) {
    let count = 9 + rng.below(5);
    for _ in 0..count {
        let foot = [0.5 + 0.18 * rng.signed(), 1.0];
        let lean = 0.35 * rng.signed();
        let height = 0.6 + 0.38 * rng.unit();
        let color = leaf_color(LeafKind::Grass, season, rng);
        let segments = 6;
        let mut from = foot;
        for s in 0..segments {
            let t = (s + 1) as f32 / segments as f32;
            let to = [foot[0] + lean * t * t * height, foot[1] - height * t];
            let width = 0.016 * (1.0 - t * 0.85);
            canvas.stroke(from, to, [width, width * 0.8], scale3(color, 0.75 + 0.35 * t));
            from = to;
        }
    }
}

/// The 2 × 2 foliage atlas of `kind` in `season` at `size` texels a side.
pub(crate) fn cards(kind: LeafKind, season: Season, twig: [f32; 3], size: u32, seed: u32) -> CardMaps {
    let cell = (size / 2) as usize;
    let n = size as usize;
    let mut heights = vec![0.0f32; n * n];
    let mut colors = vec![[0.0f32; 3]; n * n];
    let mut alphas = vec![0.0f32; n * n];
    for index in 0..4 {
        let mut rng = Rng::new(seed ^ (0x9e37_79b9u32.wrapping_mul(index as u32 + 1)));
        let mut canvas = Canvas::new(cell);
        match kind {
            LeafKind::Spruce | LeafKind::Pine => paint_needles(&mut canvas, kind, season, &mut rng, twig),
            LeafKind::Palm => paint_frond(&mut canvas, season, &mut rng),
            LeafKind::Grass => paint_blades(&mut canvas, season, &mut rng),
            _ if keeps_leaves(kind, season) => paint_leafy_twig(&mut canvas, kind, season, &mut rng, twig),
            _ => paint_bare_twig(&mut canvas, kind, season, &mut rng, twig),
        }
        bleed(&mut canvas);
        let (ox, oy) = ((index % 2) * cell, (index / 2) * cell);
        for y in 0..cell {
            for x in 0..cell {
                let (from, to) = (y * cell + x, (oy + y) * n + ox + x);
                heights[to] = canvas.height[from];
                colors[to] = canvas.color[from];
                alphas[to] = canvas.alpha[from];
            }
        }
    }
    let normal = normal_map(&heights, size, 3.0 * size as f32 / 1024.0, false);
    let mut albedo = Vec::with_capacity(n * n * 4);
    for at in 0..n * n {
        albedo.extend(srgb(colors[at]));
        albedo.push(byte(alphas[at]));
    }
    CardMaps { albedo: Image { size, rgba: albedo }, normal: Image { size, rgba: normal } }
}

/// Spread the painted colour into the transparent texels around it (a few rings), so filtering and
/// mips never pull a dark fringe into a card's edge.
fn bleed(canvas: &mut Canvas) {
    let n = canvas.size;
    let mut filled: Vec<bool> = canvas.alpha.iter().map(|a| *a > 0.0).collect();
    for _ in 0..8 {
        let mut next = filled.clone();
        for y in 0..n {
            for x in 0..n {
                if filled[y * n + x] {
                    continue;
                }
                let (mut sum, mut count) = ([0.0f32; 3], 0.0);
                for (dx, dy) in [(-1i32, 0i32), (1, 0), (0, -1), (0, 1)] {
                    let (nx, ny) = (x as i32 + dx, y as i32 + dy);
                    if nx < 0 || ny < 0 || nx >= n as i32 || ny >= n as i32 {
                        continue;
                    }
                    let at = ny as usize * n + nx as usize;
                    if filled[at] {
                        let c = canvas.color[at];
                        sum = [sum[0] + c[0], sum[1] + c[1], sum[2] + c[2]];
                        count += 1.0;
                    }
                }
                if count > 0.0 {
                    canvas.color[y * n + x] = scale3(sum, 1.0 / count);
                    next[y * n + x] = true;
                }
            }
        }
        filled = next;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bark_tiles_without_a_seam() {
        for kind in [BarkKind::Birch, BarkKind::Furrowed, BarkKind::Plates, BarkKind::Scaly] {
            let maps = bark(kind, Season::Leafy, 64, 7);
            let row = |y: usize| &maps.albedo.rgba[y * 64 * 4..(y + 1) * 64 * 4];
            let step = |a: usize, b: usize| row(a).iter().zip(row(b)).map(|(x, y)| (i32::from(*x) - i32::from(*y)).abs()).sum::<i32>() as f32;
            let inside = (0..63).map(|y| step(y, y + 1)).sum::<f32>() / 63.0;
            let wrap = step(63, 0);
            assert!(wrap < 2.5 * inside, "{kind:?}: the wrap from the last row to the first steps by {wrap} against {inside} inside");
        }
    }

    #[test]
    fn a_birch_reads_white_and_an_oak_dark() {
        let mean = |kind: BarkKind| {
            let maps = bark(kind, Season::Leafy, 64, 3);
            maps.albedo.rgba.chunks(4).map(|t| f32::from(t[0]) + f32::from(t[1]) + f32::from(t[2])).sum::<f32>() / (3.0 * 64.0 * 64.0)
        };
        let (birch, oak) = (mean(BarkKind::Birch), mean(BarkKind::Furrowed));
        assert!(birch > 170.0, "birch bark is white: mean {birch}");
        assert!(oak < 110.0, "oak bark is dark: mean {oak}");
    }

    #[test]
    fn cards_cover_part_of_each_cell_and_bleed_their_colour() {
        let maps = cards(LeafKind::Birch, Season::Leafy, [0.1, 0.06, 0.05], 128, 11);
        let alpha: Vec<u8> = maps.albedo.rgba.chunks(4).map(|t| t[3]).collect();
        let covered = alpha.iter().filter(|a| **a > 127).count() as f32 / alpha.len() as f32;
        assert!((0.08..0.8).contains(&covered), "a leafy twig covers {covered} of its atlas");
        let winter = cards(LeafKind::Birch, Season::Winter, [0.1, 0.06, 0.05], 128, 11);
        let bare = winter.albedo.rgba.chunks(4).filter(|t| t[3] > 127).count() as f32 / alpha.len() as f32;
        assert!(bare < covered && bare > 0.005, "a bare twig is thinner ({bare}) than a leafy one ({covered})");
        let clear_black = maps.albedo.rgba.chunks(4).filter(|t| t[3] == 0 && t[0] == 0 && t[1] == 0 && t[2] == 0).count();
        assert!(clear_black < alpha.len() / 2, "transparent texels near a leaf carry its colour");
    }
}
