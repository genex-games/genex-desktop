// Bloom's upsample (graph node 19, RQ4.2): a 3x3 tent over the smaller mip, its radius scaled by
// the look's spread, added onto the mip above (the pipeline's additive blend over `Load`), from
// the smallest mip back up to the chain's top. Mip 0 ends holding the sum of every mip's blur; the
// tonemap divides it by the mip count (`GxTonemapParams::shape.w`) and composites
// `mix(scene, bloom, intensity)`, so the bloom image keeps the scene's mean radiance.

// Mirrors `post::bloom::GpuBloomParams`.
struct BloomParams {
    // xy: the source mip's size in texels; zw: 1 / it.
    source: vec4<f32>,
    // x: intensity; y: threshold (0: none); z: the spread (radius multiplier); w: the threshold's
    // soft knee as a fraction of it (`post::bloom::THRESHOLD_KNEE`).
    shape: vec4<f32>,
    // x: the mip written; y: mips in the chain; z: 1 on the first downsample (Karis, threshold); w: reserved.
    mip: vec4<u32>,
}

@group(0) @binding(0) var gx_bloom_source: texture_2d<f32>;
@group(0) @binding(1) var gx_bloom_sampler: sampler;
@group(0) @binding(2) var<uniform> gx_bloom: BloomParams;

struct BloomOut {
    @builtin(position) clip: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

@vertex
fn vs_bloom(@builtin(vertex_index) index: u32) -> BloomOut {
    let uv = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
    var out: BloomOut;
    out.clip = vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
    out.uv = uv;
    return out;
}

@fragment
fn fs_bloom_up(in: BloomOut) -> @location(0) vec4<f32> {
    let radius = gx_bloom.source.zw * gx_bloom.shape.z;
    var sum = vec3<f32>(0.0);
    for (var y = -1; y <= 1; y++) {
        for (var x = -1; x <= 1; x++) {
            let weight = f32((2 - abs(x)) * (2 - abs(y))) / 16.0;
            let at = in.uv + vec2<f32>(f32(x), f32(y)) * radius;
            sum += textureSampleLevel(gx_bloom_source, gx_bloom_sampler, at, 0.0).rgb * weight;
        }
    }
    return vec4<f32>(sum, 1.0);
}
