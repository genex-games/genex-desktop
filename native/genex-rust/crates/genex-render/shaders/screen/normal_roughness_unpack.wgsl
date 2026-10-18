// The readers' half of the prepass's normal and roughness packing (renderer pass 2 A.6; split off
// for B.9's passes, which read the texel and never write it): the 12-bit code range and the
// unpacking of normal_roughness.wgsl's texel. Include after effects.wgsl (`gx_oct_decode`).

// The largest 12-bit code.
const GX_NR_CODE_MAX: f32 = 4095.0;

// The unit normal a texel holds.
fn gx_unpack_normal(texel: vec4<f32>) -> vec3<f32> {
    let c = vec3<u32>(round(saturate(texel.rgb) * 255.0));
    let q = vec2<u32>((c.x << 4u) | (c.y >> 4u), ((c.y & 15u) << 8u) | c.z);
    return gx_oct_decode(vec2<f32>(q) / GX_NR_CODE_MAX * 2.0 - vec2<f32>(1.0));
}

// The perceptual roughness a texel holds.
fn gx_unpack_roughness(texel: vec4<f32>) -> f32 {
    return texel.a;
}
