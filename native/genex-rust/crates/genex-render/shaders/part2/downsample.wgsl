// A HiDPI world target (world size × min(dpr, 2)) read back at the logical world size: each
// logical pixel is the area-weighted mean of the physical texels its footprint covers (at most
// three per axis for a scale of two or less). Flat colours come back exactly.

struct DownsampleParams {
    // x, y: physical texels per logical pixel; z, w: the physical size.
    scale: vec4<f32>,
}

@group(0) @binding(0) var downsample_source: texture_2d<f32>;
@group(0) @binding(1) var<uniform> downsample: DownsampleParams;

@vertex
fn vs_downsample(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
    let uv = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
    return vec4<f32>(uv * 2.0 - 1.0, 0.0, 1.0);
}

fn coverage(texel: f32, start: f32, end: f32) -> f32 {
    return max(min(texel + 1.0, end) - max(texel, start), 0.0);
}

@fragment
fn fs_downsample(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    let logical = floor(position.xy);
    let start = logical * downsample.scale.xy;
    let end = start + downsample.scale.xy;
    let limit = vec2<i32>(downsample.scale.zw) - 1;
    var sum = vec4<f32>(0.0);
    var weight = 0.0;
    for (var j = 0; j < 3; j++) {
        let ty = floor(start.y) + f32(j);
        let wy = coverage(ty, start.y, end.y);
        for (var i = 0; i < 3; i++) {
            let tx = floor(start.x) + f32(i);
            let w = coverage(tx, start.x, end.x) * wy;
            if w > 0.0 {
                let texel = clamp(vec2<i32>(i32(tx), i32(ty)), vec2<i32>(0), limit);
                sum += textureLoad(downsample_source, texel, 0) * w;
                weight += w;
            }
        }
    }
    return vec4<f32>((sum / max(weight, 1e-6)).rgb, 1.0);
}
