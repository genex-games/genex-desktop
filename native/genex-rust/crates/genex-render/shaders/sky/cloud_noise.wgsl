// The cloud noise (renderer pass 2 B.5, `clouds.rs`), made once on the GPU: tileable Perlin and
// Worley noise after sebh's TileableVolumeNoise (MIT, Sebastien Hillaire): Worley cells wrapped at
// the period, Perlin lattice gradients wrapped at it, and the Perlin-Worley mix
// remap(perlin, 0, 1, worley fbm, 1) the Nubis-style shape takes.
//
// - `cs_cloud_shape` (128^3): r Perlin-Worley, g b a Worley fbm at 4, 8 and 16 cells;
// - `cs_cloud_detail` (32^3): r g b Worley fbm at 2, 4 and 8 cells (erodes the edges);
// - `cs_cloud_weather` (256^2): r the coverage field, g the layer's height variation.

@group(0) @binding(0) var volume_out: texture_storage_3d<rgba8unorm, write>;
@group(0) @binding(1) var field_out: texture_storage_2d<rgba8unorm, write>;

// Three well-mixed words from three (Jarzynski and Olano 2020's pcg3d).
fn noise_pcg3d(seed: vec3<u32>) -> vec3<u32> {
    var v = seed * 1664525u + 1013904223u;
    v.x += v.y * v.z;
    v.y += v.z * v.x;
    v.z += v.x * v.y;
    v = v ^ (v >> vec3<u32>(16u));
    v.x += v.y * v.z;
    v.y += v.z * v.x;
    v.z += v.x * v.y;
    return v;
}

// Three uniform values in 0..1 for integer cell `cell` (wrapped into the period first) and `salt`.
fn noise_hash(cell: vec3<i32>, period: i32, salt: u32) -> vec3<f32> {
    let wrapped = vec3<u32>(((cell % period) + period) % period);
    return vec3<f32>(noise_pcg3d(wrapped + vec3<u32>(salt * 7919u, salt * 104729u, salt * 1299709u)) >> vec3<u32>(8u)) * (1.0 / 16777216.0);
}

// Worley noise at `p` (0..1 per period) with `cells` cells a period: 1 at a feature point, falling
// to 0 a cell away (sebh's 1 - worley).
fn noise_worley(p: vec3<f32>, cells: i32, salt: u32) -> f32 {
    let grid = p * f32(cells);
    let base = vec3<i32>(floor(grid));
    var nearest = 1e9;
    for (var z = -1; z <= 1; z++) {
        for (var y = -1; y <= 1; y++) {
            for (var x = -1; x <= 1; x++) {
                let cell = base + vec3<i32>(x, y, z);
                let feature = vec3<f32>(cell) + noise_hash(cell, cells, salt);
                let apart = feature - grid;
                nearest = min(nearest, dot(apart, apart));
            }
        }
    }
    return 1.0 - clamp(sqrt(nearest), 0.0, 1.0);
}

// Three octaves of Worley noise from `cells` cells (0.625, 0.25 and 0.125: sebh's weights).
fn noise_worley_fbm(p: vec3<f32>, cells: i32, salt: u32) -> f32 {
    return noise_worley(p, cells, salt) * 0.625 + noise_worley(p, cells * 2, salt + 1u) * 0.25 + noise_worley(p, cells * 4, salt + 2u) * 0.125;
}

// A lattice corner's gradient: one of the twelve cube edge directions.
fn noise_gradient(cell: vec3<i32>, period: i32, salt: u32) -> vec3<f32> {
    let h = u32(noise_hash(cell, period, salt).x * 12.0) % 12u;
    let a = select(-1.0, 1.0, (h & 1u) == 0u);
    let b = select(-1.0, 1.0, (h & 2u) == 0u);
    if h < 4u {
        return vec3<f32>(a, b, 0.0);
    }
    if h < 8u {
        return vec3<f32>(a, 0.0, b);
    }
    return vec3<f32>(0.0, a, b);
}

// Perlin noise at `p` (0..1 per period) on a lattice of `cells` a period, about -1..1.
fn noise_perlin(p: vec3<f32>, cells: i32, salt: u32) -> f32 {
    let grid = p * f32(cells);
    let base = vec3<i32>(floor(grid));
    let f = grid - floor(grid);
    let s = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    var corners: array<f32, 8>;
    for (var i = 0u; i < 8u; i++) {
        let offset = vec3<i32>(i32(i & 1u), i32((i >> 1u) & 1u), i32((i >> 2u) & 1u));
        corners[i] = dot(noise_gradient(base + offset, cells, salt), f - vec3<f32>(offset));
    }
    let x0 = mix(corners[0], corners[1], s.x);
    let x1 = mix(corners[2], corners[3], s.x);
    let x2 = mix(corners[4], corners[5], s.x);
    let x3 = mix(corners[6], corners[7], s.x);
    return mix(mix(x0, x1, s.y), mix(x2, x3, s.y), s.z);
}

// `octaves` of Perlin noise from `cells` a period, halving each, in 0..1.
fn noise_perlin_fbm(p: vec3<f32>, cells: i32, octaves: u32, salt: u32) -> f32 {
    var sum = 0.0;
    var weight = 0.5;
    var total = 0.0;
    var lattice = cells;
    for (var octave = 0u; octave < octaves; octave++) {
        sum += noise_perlin(p, lattice, salt + octave) * weight;
        total += weight;
        weight *= 0.5;
        lattice *= 2;
    }
    return clamp(sum / total * 0.5 + 0.5, 0.0, 1.0);
}

fn noise_remap(value: f32, low: f32, high: f32, to_low: f32, to_high: f32) -> f32 {
    return to_low + (value - low) / max(high - low, 1e-5) * (to_high - to_low);
}

@compute @workgroup_size(4, 4, 4)
fn cs_cloud_shape(@builtin(global_invocation_id) id: vec3<u32>) {
    let side = textureDimensions(volume_out).x;
    if any(id >= vec3<u32>(side)) {
        return;
    }
    let p = (vec3<f32>(id) + 0.5) / f32(side);
    let worley4 = noise_worley_fbm(p, 4, 1u);
    let worley8 = noise_worley_fbm(p, 8, 4u);
    let worley16 = noise_worley_fbm(p, 16, 7u);
    let perlin = noise_perlin_fbm(p, 4, 7u, 10u);
    let perlin_worley = clamp(noise_remap(perlin, 0.0, 1.0, worley4, 1.0), 0.0, 1.0);
    textureStore(volume_out, id, vec4<f32>(perlin_worley, worley4, worley8, worley16));
}

@compute @workgroup_size(4, 4, 4)
fn cs_cloud_detail(@builtin(global_invocation_id) id: vec3<u32>) {
    let side = textureDimensions(volume_out).x;
    if any(id >= vec3<u32>(side)) {
        return;
    }
    let p = (vec3<f32>(id) + 0.5) / f32(side);
    textureStore(volume_out, id, vec4<f32>(noise_worley_fbm(p, 2, 20u), noise_worley_fbm(p, 4, 23u), noise_worley_fbm(p, 8, 26u), 1.0));
}

@compute @workgroup_size(8, 8, 1)
fn cs_cloud_weather(@builtin(global_invocation_id) id: vec3<u32>) {
    let side = textureDimensions(field_out).x;
    if any(id.xy >= vec2<u32>(side)) {
        return;
    }
    let p = vec3<f32>((vec2<f32>(id.xy) + 0.5) / f32(side), 0.5);
    // Coverage: Perlin fbm shaped by Worley cells (clumps with clear lanes between them), spread so
    // a coverage of 0.5 leaves about half the sky clear.
    let perlin = noise_perlin_fbm(p, 4, 5u, 30u);
    let cells = noise_worley_fbm(p, 6, 40u);
    let coverage = clamp(noise_remap(perlin * 0.6 + cells * 0.4, 0.3, 0.75, 0.0, 1.0), 0.0, 1.0);
    let height = noise_perlin_fbm(p, 3, 3u, 50u);
    textureStore(field_out, vec2<i32>(id.xy), vec4<f32>(coverage, height, 0.0, 1.0));
}
