// The screen reflections in the forward pass's specular (renderer pass 2 B.9; the reader of
// binding 30, `screen_reflections`). The resolve stores the reflected radiance already weighted by
// its confidence (rgb) and the confidence (a), so the probe or sky radiance the surface would
// reflect fades out exactly as the screen's fades in: where the two agree the sum is the same
// radiance at every confidence, so the hand-over from screen to probes has no seam. The CPU twin is
// `ssr::apply`. No bindings of its own: included ahead of the ambient chunk, which lays
// `gx_screen_reflection` over the environment's prefiltered radiance.

// The screen reflection texel of the fragment being shaded: a forward fragment loads it from
// binding 30 before its ambient light (`gx_screen_reflection_at`, forward_effects.wgsl, on
// pipelines whose `GX_SSR` is on); zero (no confidence: the environment alone) everywhere else,
// a Level-2 material, a transparent or a probe capture.
var<private> gx_screen_reflection: vec4<f32> = vec4<f32>(0.0);

// The prefiltered radiance `env` (probe, sky cube) with screen reflection texel `screen` laid over.
fn gx_ssr_apply(env: vec3<f32>, screen: vec4<f32>) -> vec3<f32> {
    let confidence = saturate(screen.a);
    return env * (1.0 - confidence) + max(screen.rgb, vec3<f32>(0.0));
}
