// The prepass's normal and roughness for screen-space reflections (renderer pass 2 A.6): one
// `rgba8unorm` texel per pixel, written on SSR presets beside the octahedral vertex normals. rgb
// holds the normal-mapped world normal as two 12-bit octahedral coordinates (Cigolle et al. 2014,
// "A Survey of Efficient Representations for Independent Unit Vectors": oct24, rounded, within 0.06
// degrees), a the perceptual roughness. Read with `textureLoad` only: the packed bits do not filter. Include
// after effects.wgsl (`gx_oct_encode`, `gx_oct_decode`). The CPU twin is
// `screen_inputs::pack_normal_roughness`. The readers' half (the code range and the unpacking) is
// normal_roughness_unpack.wgsl, which a reader includes alone (B.9's passes).

// The texel holding unit normal `n` (world space) and perceptual roughness `roughness` (0..1).
fn gx_pack_normal_roughness(n: vec3<f32>, roughness: f32) -> vec4<f32> {
    let e = gx_oct_encode(n) * 0.5 + vec2<f32>(0.5);
    let q = vec2<u32>(round(saturate(e) * GX_NR_CODE_MAX));
    let r = q.x >> 4u;
    let g = ((q.x & 15u) << 4u) | (q.y >> 8u);
    let b = q.y & 255u;
    return vec4<f32>(vec3<f32>(f32(r), f32(g), f32(b)) / 255.0, saturate(roughness));
}
