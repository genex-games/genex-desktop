// Lighting chunk: output. What a forward fragment writes into the scene colour:
// - the legacy LDR world target is Bgra8Unorm, so the lit colour is clamped and sRGB-encoded here
//   (`linear_to_srgb` is pbr.wgsl's): the `off` path, and any frame degraded to LDR;
// - the HDR scene (RQ1.1) takes linear radiance times the pre-exposure, unclamped above 1 (the
//   tonemap maps it to display) but held under the half-float limit, so even a blinding light never
//   writes inf into an `rgba16float` (or `rg11b10ufloat`) target.
// Which one is the pipeline's `GX_SCENE_HDR` constant (renderer.rs builds one pipeline set per
// scene), so the legacy scene's fragments never branch on the frame. The HDR scene's pre-exposure
// is the frame uniforms' `cascade_splits.z` (auto exposure copies the GPU's exposure there,
// renderer.rs `FRAME_PRE_EXPOSURE_OFFSET`). A Level-2 v2 material leaves the constant at its
// default: it reaches this only on the legacy scene (`gx_expose` exposes the HDR one itself).

// The largest radiance the HDR scene stores: under half float's 65504 and rg11b10's 65024.
const GX_SCENE_RADIANCE_MAX: f32 = 64512.0;

// Whether the pipeline draws the HDR scene (a pipeline-overridable constant).
override GX_SCENE_HDR: bool = false;
// Whether the HDR scene is `rg11b10ufloat` (a pipeline-overridable constant): its writes take a
// half-ULP dither against banding (`gx_scene_dither`); false (the default) writes as before.
override GX_SCENE_RG11B10: bool = false;

// rg11b10ufloat's relative mantissa step: 6 bits red and green, 5 blue.
const GX_RG11B10_STEP: vec3<f32> = vec3<f32>(0.015625, 0.015625, 0.03125);

// An rg11b10 scene write dithered by up to half a mantissa step either way (P2-0.10, C5; the idea
// is Gjøl's "Banding in Games", Playdead 2016): blue's 5-bit mantissa is about two 8-bit levels
// per step in a sky or fog gradient, more than the final half-level dither hides. The noise is
// interleaved gradient noise at the fragment's pixel, which the sun chunk holds
// (`gx_sun_shadow_context`, called by every fragment entry that shades); static, since the classes
// that store rg11b10 draw no TAA to average a moving pattern. Off (`GX_SCENE_RG11B10` false) the
// value is returned as it is, so `rgba16float` pipelines are byte-identical.
fn gx_scene_dither(c: vec3<f32>) -> vec3<f32> {
    if !GX_SCENE_RG11B10 {
        return c;
    }
    let p = gx_sun_context.pixel;
    let noise = fract(52.9829189 * fract(dot(p, vec2<f32>(0.06711056, 0.00583715)))) - 0.5;
    return min(c + c * noise * GX_RG11B10_STEP, vec3<f32>(GX_SCENE_RADIANCE_MAX));
}

// Lit linear colour as the frame's scene colour stores it.
fn gx_encode_ldr(color: vec3<f32>) -> vec3<f32> {
    if GX_SCENE_HDR {
        return gx_scene_dither(min(max(color, vec3<f32>(0.0)) * frame.cascade_splits.z, vec3<f32>(GX_SCENE_RADIANCE_MAX)));
    }
    return linear_to_srgb(clamp(color, vec3<f32>(0.0), vec3<f32>(1.0)));
}
