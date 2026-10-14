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

// Lit linear colour as the frame's scene colour stores it.
fn gx_encode_ldr(color: vec3<f32>) -> vec3<f32> {
    if GX_SCENE_HDR {
        return min(max(color, vec3<f32>(0.0)) * frame.cascade_splits.z, vec3<f32>(GX_SCENE_RADIANCE_MAX));
    }
    return linear_to_srgb(clamp(color, vec3<f32>(0.0), vec3<f32>(1.0)));
}
