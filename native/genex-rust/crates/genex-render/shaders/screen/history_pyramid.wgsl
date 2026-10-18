// The previous frame's colour pyramid (renderer pass 2 A.6): TAA's resolved output halved mip by
// mip, so a rough reflection or refraction (B.3 water, B.9 SSR) reads a blurred scene with one
// filtered tap at the mip its cone spans. One compute pass, one dispatch a mip (each its own usage
// scope, so a mip is whole before the next reads it), as the Hi-Z build: a render pass a mip cost
// about 0.03 ms each on an M4 Max, most of the chain's time. Each texel takes five bilinear taps of the
// mip above (mip 0: TAA's output at render size, or at output size under TAA upscaling): one at its
// centre (the 2 x 2 block under it) weighted a half and four a source texel away diagonally (the
// 4 x 4 around it) weighted an eighth each, so a mip is a smooth tent of its source with no 2 x 2 block pattern. The CPU twin is
// `screen_inputs::pyramid_reference`.

@group(0) @binding(0) var gx_pyramid_source: texture_2d<f32>;
@group(0) @binding(1) var gx_pyramid_sampler: sampler;
@group(0) @binding(2) var gx_pyramid_dest: texture_storage_2d<rgba16float, write>;

// The centre tap's weight; each diagonal tap takes a quarter of the rest.
const GX_PYRAMID_CENTRE: f32 = 0.5;

@compute @workgroup_size(8, 8)
fn cs_pyramid(@builtin(global_invocation_id) id: vec3<u32>) {
    let dest = textureDimensions(gx_pyramid_dest);
    if any(id.xy >= dest) {
        return;
    }
    let source = vec2<f32>(textureDimensions(gx_pyramid_source));
    let size = vec2<f32>(dest);
    // Under TAA upscaling (B.8) mip 0's source is TAA's output at output size while the pyramid
    // keeps the render size's: more than twice the destination's texels (plus one for an odd
    // size). It is read by the destination's own uv, the taps half a destination texel out, so
    // the whole picture lands in the pyramid (a render-size uv read only its top-left corner).
    let upscaled = source > size * 2.0 + vec2<f32>(1.0);
    let centre_uv = vec2<f32>(id.xy) + vec2<f32>(0.5);
    // The destination texel's centre as a share of the source, which has twice its texels.
    let uv = select(centre_uv * 2.0 / source, centre_uv / size, upscaled);
    let texel = select(1.0 / source, 0.5 / size, upscaled);
    let centre = textureSampleLevel(gx_pyramid_source, gx_pyramid_sampler, uv, 0.0);
    // The diagonal taps in the order (-1, -1), (1, -1), (-1, 1), (1, 1).
    var corners = vec4<f32>(0.0);
    for (var i = 0u; i < 4u; i += 1u) {
        let offset = vec2<f32>(f32(i & 1u), f32(i >> 1u)) * 2.0 - vec2<f32>(1.0);
        corners += textureSampleLevel(gx_pyramid_source, gx_pyramid_sampler, uv + offset * texel, 0.0);
    }
    textureStore(gx_pyramid_dest, id.xy, centre * GX_PYRAMID_CENTRE + corners * ((1.0 - GX_PYRAMID_CENTRE) * 0.25));
}
