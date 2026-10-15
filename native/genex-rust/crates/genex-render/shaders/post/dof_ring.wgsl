// The ring tier's gather and median (A.9): a port of Filament v1.77.3's materials/dof/dof.mat and
// dofMedian.mat (Apache-2.0, Copyright (C) 2021 The Android Open Source Project), after "Life of a
// Bokeh" (Abadie, SIGGRAPH 2018) for the background field and Jimenez's two-layer accumulation
// ("Next Generation Post Processing in Call of Duty: Advanced Warfare", SIGGRAPH 2014) for the
// foreground field. A circular diaphragm, mipmapped taps and spatial (never frame-keyed) noise.

// The half-resolution colour (rgb) with its CoC (a) and three mips.
@group(0) @binding(3) var dof_colour: texture_2d<f32>;
// The dilated min/max CoC tiles.
@group(0) @binding(5) var dof_ring_tiles: texture_2d<f32>;
// Nearest texels and mips (the buckets), and linear texels with nearest mips (fast tiles).
@group(0) @binding(6) var dof_nearest: sampler;
@group(0) @binding(7) var dof_linear: sampler;
// The gather's output (rgb premultiplied, a its coverage): the median's input.
@group(0) @binding(8) var dof_gathered: texture_2d<f32>;

// A sample's weight: inversely proportional to its CoC's area, normalised to the largest radius;
// a pixel at `mip` covers 2^(mip + 1) half-resolution texels.
fn dof_sample_weight(coc: f32, mip: f32) -> f32 {
    let pixel_radius_squared = 2.0 * exp2(mip);
    return (DOF_MAX_COC_RADIUS * DOF_MAX_COC_RADIUS) / max(coc * coc, pixel_radius_squared);
}

// How much a sample of CoC `abs_coc` reaches a ring at `border`.
fn dof_intersection(border: f32, abs_coc: f32, mip: f32) -> f32 {
    return saturate((abs_coc - border) * exp2(-mip) + 0.5);
}

// The rings a kernel of `size` half-resolution pixels needs.
fn dof_needed_rings(size: f32) -> f32 {
    return ceil(size + 0.5);
}

// The mip the taps of `rings` rings over a kernel of `size` half-resolution pixels read: the
// ring spacing's, rounded (the median closes the small gaps it leaves).
fn dof_mip_level(rings: f32, size: f32) -> f32 {
    let spacing = size / (rings - 0.5);
    return max(0.0, floor(log2(max(spacing, 1e-6)) + 0.5));
}

// The taps on a (2 rings - 1)^2 grid.
fn dof_sample_count(rings: f32) -> f32 {
    let side = rings * 2.0 - 1.0;
    return side * side;
}

// Interleaved gradient noise (Jimenez 2014) at pixel `p`: spatial only.
fn dof_ign(p: vec2<f32>) -> f32 {
    return fract(52.9829189 * fract(dot(p, vec2<f32>(0.06711056, 0.00583715))));
}

// A ring's accumulation (Filament's Bucket).
struct DofBucket {
    c: vec4<f32>,
    cw: f32,
    o: f32,
    coc: f32,
}

// A ring of the kernel (Filament's initRing): its first offset, the taps on it, the rotation from
// one tap to the next and the ring's distance from the (noise-moved) centre.
struct DofRing {
    p: vec2<f32>,
    count: f32,
    rotation: mat2x2<f32>,
    radius: f32,
}

fn dof_ring(i: f32, rings: f32, size: f32, noise: vec2<f32>) -> DofRing {
    let radius = (size / (rings - 0.5)) * i;
    let count = 8.0 * i;
    let inc = 2.0 * DOF_PI / count;
    let t = vec2<f32>(cos(inc), sin(inc));
    let first = (i % 2.0) * 0.5 * inc;
    let p = radius * vec2<f32>(cos(first), sin(first));
    return DofRing(p, count, mat2x2<f32>(t.x, t.y, -t.y, t.x), length(p + noise));
}

// Merge ring `curr` into the rings inside it, occluding them by its average CoC and its opacity
// ("Life of a Bokeh", slide 32).
fn dof_merge_rings(curr: DofBucket, prev: DofBucket, count: f32) -> DofBucket {
    if curr.cw < DOF_WEIGHT_MIN {
        return prev;
    }
    let curr_coc = curr.coc / curr.cw;
    let prev_coc = prev.coc / max(prev.cw, DOF_WEIGHT_MIN);
    let occluded = saturate(prev_coc - curr_coc);
    let opacity = 1.0 - curr.o / count;
    let previous_weight = select(0.0, 1.0 - opacity * occluded, prev.cw > DOF_WEIGHT_MIN);
    return DofBucket(prev.c * previous_weight + curr.c, prev.cw * previous_weight + curr.cw, prev.o, prev.coc * previous_weight + curr.coc);
}

// The current ring and the rings inside it, accumulated together.
struct DofBuckets {
    curr: DofBucket,
    prev: DofBucket,
}

// One background tap at `pos` (Filament's accumulateBackground and accumulate): a sample whose CoC
// is larger than the ring belongs to the rings inside it.
fn dof_accumulate_background(buckets: DofBuckets, pos: vec2<f32>, radius: f32, border: f32, mip: f32, first: bool) -> DofBuckets {
    let tap = textureSampleLevel(dof_colour, dof_nearest, pos, mip);
    let coc = abs(tap.a);
    let in_layer = select(0.0, 1.0, tap.a > 0.0);
    let w = in_layer * dof_intersection(radius, coc, mip) * dof_sample_weight(coc, mip);
    let in_previous = saturate(coc - border + 0.5);
    let colour = vec4<f32>(tap.rgb, 1.0);
    var out = buckets;
    if first {
        out.prev = DofBucket(out.prev.c + w * colour, out.prev.cw + w, out.prev.o + in_previous, out.prev.coc + w * coc);
        return out;
    }
    let curr_weight = w * (1.0 - in_previous);
    let prev_weight = w * in_previous;
    out.curr = DofBucket(out.curr.c + curr_weight * colour, out.curr.cw + curr_weight, out.curr.o + in_previous, out.curr.coc + curr_weight * coc);
    out.prev = DofBucket(out.prev.c + prev_weight * colour, out.prev.cw + prev_weight, out.prev.o, out.prev.coc + prev_weight * coc);
    return out;
}

const DOF_EMPTY_BUCKET: DofBucket = DofBucket(vec4<f32>(0.0), 0.0, 0.0, 0.0);

// The ring `index` from the outside of the background kernel (Filament's accumulateRing).
fn dof_background_ring(prev: DofBucket, index: f32, rings: f32, size: f32, noise: vec2<f32>, centre: vec2<f32>, mip: f32, first: bool) -> DofBucket {
    let i = (rings - 1.0) - index;
    let ring = dof_ring(i, rings, size, noise);
    let border = (size / (rings - 0.5)) * (i + 0.5);
    var buckets = DofBuckets(DOF_EMPTY_BUCKET, prev);
    var p = ring.p;
    for (var j = 0.0; j < ring.count; j += 2.0) {
        let offset = p * dof.scale.xy;
        buckets = dof_accumulate_background(buckets, centre + offset, ring.radius, border, mip, first);
        buckets = dof_accumulate_background(buckets, centre - offset, ring.radius, border, mip, first);
        p = ring.rotation * p;
    }
    if first {
        return buckets.prev;
    }
    return dof_merge_rings(buckets.curr, buckets.prev, ring.count);
}

// The background field's colour (premultiplied) and opacity (Filament's backgroundTile).
fn dof_background(uv: vec2<f32>, tiles: vec2<f32>, random_radius: f32, random_disk: vec2<f32>) -> vec4<f32> {
    let rings = min(dof.rings.y, dof_needed_rings(tiles.y * dof.scale.z));
    let size = abs(textureSampleLevel(dof_colour, dof_nearest, uv, 0.0).a);
    let mip = dof_mip_level(rings, size * dof.scale.z);
    let noise_radius = size * random_radius / (rings - 0.5);
    let noise = random_disk * noise_radius;
    let centre = uv + noise * dof.scale.xy;
    var prev = dof_background_ring(DOF_EMPTY_BUCKET, 0.0, rings, size, noise, centre, mip, true);
    for (var i = 1.0; i < rings - 1.0; i += 1.0) {
        prev = dof_background_ring(prev, i, rings, size, noise, centre, mip, false);
    }
    // The centre tap, its own ring.
    let border = (size / (rings - 0.5)) * 0.5;
    let centred = dof_accumulate_background(DofBuckets(DOF_EMPTY_BUCKET, prev), centre, noise_radius, border, mip, false);
    prev = dof_merge_rings(centred.curr, centred.prev, 1.0);
    let kernel_area = dof_sample_weight(size * ((rings + 0.5) / rings), mip);
    let opacity = saturate(prev.cw / kernel_area) * smoothstep(DOF_MAX_IN_FOCUS_COC, 2.0, size);
    return vec4<f32>(prev.c.rgb * (opacity / max(prev.cw, DOF_WEIGHT_MIN)), opacity);
}

// The foreground field's two layers: the front one (CoC near the tile's largest) and the one
// behind it.
struct DofLayers {
    front: vec4<f32>,
    front_weight: f32,
    back: vec4<f32>,
    back_weight: f32,
}

// Which layer a foreground CoC belongs to (0 front, 1 back; Filament's computeLayer).
fn dof_layer(coc: f32, tiles: vec2<f32>) -> f32 {
    return saturate((coc - tiles.x - 2.0) * 0.5);
}

// A foreground tap pair's weight into the layers: the smaller CoC of opposite taps guesses the
// colour the geometry hides (Filament's accumulateForegroundMirror).
fn dof_accumulate_foreground(layers: DofLayers, tiles: vec2<f32>, colour: vec3<f32>, coc: f32, border: f32, mip: f32, taps: f32) -> DofLayers {
    let in_layer = select(0.0, 1.0, coc < 0.0) * saturate(abs(coc) - (DOF_MAX_IN_FOCUS_COC - 1.0));
    let w = dof_intersection(border, abs(coc), mip) * dof_sample_weight(coc, mip) * in_layer;
    let back_weight = w * dof_layer(coc, tiles);
    let front_weight = w - back_weight;
    let c = vec4<f32>(colour, taps);
    return DofLayers(layers.front + front_weight * c, layers.front_weight + front_weight * taps, layers.back + back_weight * c, layers.back_weight + back_weight * taps);
}

// The foreground field's colour (premultiplied) and opacity (Filament's foregroundTile).
fn dof_foreground(uv: vec2<f32>, tiles: vec2<f32>, random_radius: f32, random_disk: vec2<f32>) -> vec4<f32> {
    let size = -tiles.x;
    let rings = min(dof.rings.x, dof_needed_rings(size * dof.scale.z));
    let mip = dof_mip_level(rings, size * dof.scale.z);
    let noise = random_disk * (size * random_radius / (rings - 0.5));
    let centre = uv + noise * dof.scale.xy;
    let tap = textureSampleLevel(dof_colour, dof_nearest, centre, mip);
    var layers = dof_accumulate_foreground(DofLayers(vec4<f32>(0.0), 0.0, vec4<f32>(0.0), 0.0), tiles, tap.rgb, tap.a, 0.0, mip, 1.0);
    for (var i = 1.0; i < rings; i += 1.0) {
        let ring = dof_ring(i, rings, size, noise);
        var p = ring.p;
        for (var j = 0.0; j < ring.count; j += 2.0) {
            let offset = p * dof.scale.xy;
            let s0 = textureSampleLevel(dof_colour, dof_nearest, centre + offset, mip);
            let s1 = textureSampleLevel(dof_colour, dof_nearest, centre - offset, mip);
            layers = dof_accumulate_foreground(layers, tiles, s0.rgb + s1.rgb, min(s0.a, s1.a), ring.radius, mip, 2.0);
            p = ring.rotation * p;
        }
    }
    let kernel = dof_sample_weight(size * ((rings + 0.5) / rings), mip) * dof_sample_count(rings);
    let front_opacity = saturate(layers.front_weight / kernel);
    let back_opacity = saturate(layers.back_weight / kernel);
    let front = layers.front.rgb / max(layers.front_weight, DOF_WEIGHT_MIN) * front_opacity;
    let back = layers.back.rgb / max(layers.back_weight, DOF_WEIGHT_MIN) * back_opacity;
    // Premultiplied by its opacity already.
    return vec4<f32>(front + back * (1.0 - front_opacity), 1.0 - (1.0 - front_opacity) * (1.0 - back_opacity));
}

// A tile whose CoC is about constant: one plain gather on the linear taps (Filament's fastTile).
fn dof_fast(uv: vec2<f32>, tiles: vec2<f32>, random_radius: f32, random_disk: vec2<f32>) -> vec4<f32> {
    let size = (abs(tiles.x) + abs(tiles.y)) * 0.5;
    let rings = min(dof.rings.z, dof_needed_rings(size * dof.scale.z));
    let mip = dof_mip_level(rings, size * dof.scale.z);
    let noise = random_disk * (size * random_radius / (rings - 0.5));
    let centre = uv + noise * dof.scale.xy;
    var colour = textureSampleLevel(dof_colour, dof_linear, centre, mip).rgb;
    for (var i = 1.0; i < rings; i += 1.0) {
        let ring = dof_ring(i, rings, size, noise);
        var p = ring.p;
        var sum = vec3<f32>(0.0);
        for (var j = 0.0; j < ring.count; j += 2.0) {
            let offset = p * dof.scale.xy;
            sum += textureSampleLevel(dof_colour, dof_linear, centre + offset, mip).rgb + textureSampleLevel(dof_colour, dof_linear, centre - offset, mip).rgb;
            p = ring.rotation * p;
        }
        colour += sum;
    }
    let alpha = dof_coc_to_alpha(size);
    return vec4<f32>(min(colour / dof_sample_count(rings), vec3<f32>(DOF_COLOUR_MAX)) * alpha, alpha);
}

// The ring gather at half resolution: premultiplied colour and coverage.
@fragment
fn fs_dof_ring(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
    let tiles = textureLoad(dof_ring_tiles, vec2<i32>(frag.xy) / DOF_TILE_HALF_TEXELS, 0).rg;
    if dof_trivial_tile(tiles) {
        return vec4<f32>(0.0);
    }
    let uv = frag.xy * dof.size.zw;
    let angle = dof_ign(frag.xy) * 2.0 * DOF_PI;
    let random_radius = 0.5 * sqrt(dof_ign(frag.xy * vec2<f32>(5099.0, 3499.0)));
    let random_disk = vec2<f32>(cos(angle), sin(angle));
    if dof_fast_tile(tiles) {
        return dof_fast(uv, tiles, random_radius, random_disk);
    }
    var foreground = vec4<f32>(0.0);
    var background = vec4<f32>(0.0);
    if tiles.x < 0.0 {
        foreground = dof_foreground(uv, tiles, random_radius, random_disk);
    }
    if tiles.y > 0.0 {
        background = dof_background(uv, tiles, random_radius, random_disk);
    }
    // Hole filling for an in-focus pixel under a partly covering foreground ("Life of a Bokeh",
    // slide 80).
    if foreground.a > 0.0 && foreground.a < 1.0 && background.a == 0.0 {
        let corrected = max(foreground.a, dof_coc_to_alpha(textureSampleLevel(dof_colour, dof_nearest, uv, 0.0).a));
        foreground = vec4<f32>(foreground.rgb * (corrected / foreground.a), corrected);
    }
    let colour = min(foreground.rgb + (1.0 - foreground.a) * background.rgb, vec3<f32>(DOF_COLOUR_MAX));
    return vec4<f32>(colour, foreground.a + (1.0 - foreground.a) * background.a);
}

// The 3x3 median of the gather, channel by channel ("A Fast, Small-Radius GPU Median Filter",
// McGuire 2008; Filament's dofMedian): the gather's sparse taps leave isolated texels it removes.
@fragment
fn fs_dof_median(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
    let ij = vec2<i32>(frag.xy);
    let tiles = textureLoad(dof_ring_tiles, ij / DOF_TILE_HALF_TEXELS, 0).rg;
    if dof_trivial_tile(tiles) {
        return vec4<f32>(0.0);
    }
    let last = dof_last(textureDimensions(dof_gathered));
    var v0 = textureLoad(dof_gathered, clamp(ij + vec2<i32>(-1, -1), vec2<i32>(0), last), 0);
    var v1 = textureLoad(dof_gathered, clamp(ij + vec2<i32>(0, -1), vec2<i32>(0), last), 0);
    var v2 = textureLoad(dof_gathered, clamp(ij + vec2<i32>(1, -1), vec2<i32>(0), last), 0);
    var v3 = textureLoad(dof_gathered, clamp(ij + vec2<i32>(-1, 0), vec2<i32>(0), last), 0);
    var v4 = textureLoad(dof_gathered, clamp(ij + vec2<i32>(0, 0), vec2<i32>(0), last), 0);
    // A texel the gather left uncovered is in focus: the median would round a sharp prop's convex
    // corner into the blur around it (five of its nine neighbours are background there).
    if v4.a == 0.0 {
        return v4;
    }
    var v5 = textureLoad(dof_gathered, clamp(ij + vec2<i32>(1, 0), vec2<i32>(0), last), 0);
    var v6 = textureLoad(dof_gathered, clamp(ij + vec2<i32>(-1, 1), vec2<i32>(0), last), 0);
    var v7 = textureLoad(dof_gathered, clamp(ij + vec2<i32>(0, 1), vec2<i32>(0), last), 0);
    var v8 = textureLoad(dof_gathered, clamp(ij + vec2<i32>(1, 1), vec2<i32>(0), last), 0);
    // minLeftMaxRight over (v0..v5), (v1, v2, v3, v4, v6), (v2, v3, v4, v7) and (v3, v4, v8): each
    // round pushes the smallest and largest out, and v4 is left the median (each step sorts a
    // pair channel by channel; written out: naga's SPIR-V writer cannot pass a pointer to an
    // array element).
    var low: vec4<f32>;
    low = min(v0, v3);
    v3 = max(v0, v3);
    v0 = low;
    low = min(v1, v4);
    v4 = max(v1, v4);
    v1 = low;
    low = min(v2, v5);
    v5 = max(v2, v5);
    v2 = low;
    low = min(v0, v1);
    v1 = max(v0, v1);
    v0 = low;
    low = min(v0, v2);
    v2 = max(v0, v2);
    v0 = low;
    low = min(v4, v5);
    v5 = max(v4, v5);
    v4 = low;
    low = min(v3, v5);
    v5 = max(v3, v5);
    v3 = low;
    low = min(v1, v2);
    v2 = max(v1, v2);
    v1 = low;
    low = min(v3, v4);
    v4 = max(v3, v4);
    v3 = low;
    low = min(v1, v3);
    v3 = max(v1, v3);
    v1 = low;
    low = min(v1, v6);
    v6 = max(v1, v6);
    v1 = low;
    low = min(v4, v6);
    v6 = max(v4, v6);
    v4 = low;
    low = min(v2, v6);
    v6 = max(v2, v6);
    v2 = low;
    low = min(v2, v3);
    v3 = max(v2, v3);
    v2 = low;
    low = min(v4, v7);
    v7 = max(v4, v7);
    v4 = low;
    low = min(v2, v4);
    v4 = max(v2, v4);
    v2 = low;
    low = min(v3, v7);
    v7 = max(v3, v7);
    v3 = low;
    low = min(v4, v8);
    v8 = max(v4, v8);
    v4 = low;
    low = min(v3, v8);
    v8 = max(v3, v8);
    v3 = low;
    low = min(v3, v4);
    v4 = max(v3, v4);
    v3 = low;
    return v4;
}
