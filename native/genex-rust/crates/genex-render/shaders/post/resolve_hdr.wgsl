// The luminance-weighted MSAA resolve of the HDR scene on desktop (non-tile) classes (graph node
// 16, RQ1.1), as its own pass: each sample weighted by 1 / (1 + luma), the mean mapped back by the
// inverse, so bright edges stay antialiased instead of whitening a mostly dark pixel (a hardware
// resolve averages linear radiance, and one blinding sample dominates). It runs when something reads
// the resolved scene before the tonemap (auto exposure's histogram, `post-hdr` passes, the sharpened
// upscale); otherwise the tonemap fuses the same resolve (tonemap.wgsl `gx_tm_resolve`, kept equal).
// Tile classes keep the in-pass hardware resolve.

@group(0) @binding(0) var gx_msaa_scene: texture_multisampled_2d<f32>;

@vertex
fn vs_resolve_hdr(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
    let uv = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
    return vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
}

fn gx_resolve_luma(c: vec3<f32>) -> f32 {
    return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
}

@fragment
fn fs_resolve_hdr(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    let pixel = vec2<i32>(position.xy);
    let samples = textureNumSamples(gx_msaa_scene);
    var sum = vec3<f32>(0.0);
    var alpha = 0.0;
    for (var i = 0u; i < samples; i++) {
        let texel = textureLoad(gx_msaa_scene, pixel, i32(i));
        // Held under the half-float limit: an inf sample would make the weighted mean NaN.
        let c = min(max(texel.rgb, vec3<f32>(0.0)), vec3<f32>(64512.0));
        sum += c / (1.0 + gx_resolve_luma(c));
        alpha += texel.a;
    }
    let n = f32(max(samples, 1u));
    let mean = sum / n;
    return vec4<f32>(mean / max(1.0 - gx_resolve_luma(mean), 1e-4), alpha / n);
}
