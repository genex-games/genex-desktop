// Bloom's upsample (graph node 19, RQ4.2; renderer pass 2, P6): a 3x3 tent one texel wide over
// the smaller mip, blended into the mip above by the pass's blend constant
// (`(1 - f) mip + f tent`, `post::bloom::blend_factors`), from the smallest mip back up to the
// chain's top. Mip 0 ends holding every mip's blur weighed by the look's spread
// (`post::bloom::mip_weights`, weights that sum to 1), so the bloom image keeps the scene's mean
// radiance and the tonemap composites `mix(scene, bloom, intensity)`. The tent never widens: a
// spread that spaced its taps further apart drew a lattice of copies around a small light.

// Mirrors `post::bloom::GpuBloomParams`.
struct BloomParams {
    // xy: the source's size in texels; zw: the filter's tap spacing in uv (one source texel here).
    source: vec4<f32>,
    // x: intensity; y: threshold (0: none); z: reserved; w: the threshold's soft knee as a
    // fraction of it (`post::bloom::THRESHOLD_KNEE`).
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
    let radius = gx_bloom.source.zw;
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
