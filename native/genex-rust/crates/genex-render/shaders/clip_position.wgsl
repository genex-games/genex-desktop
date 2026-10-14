// The clip position of every depth-writing vertex shader (plan §2.3, RQ4.0): the forward pass
// (skinned draws included: they read the skinned vertex buffer through the same entry point), the
// depth/normal prepass, the Level-2 v2 geometry prelude and, with R2, meshlet vertex pulling. Each
// declares its `@builtin(position)` output `@invariant` and computes it only through this function,
// so the prepass and an `Equal`-depth main pass write bit-identical depth on every compiler (FXC's
// `precise`, Metal's preserved invariance, SPIR-V's Invariant decoration).
//
// `view_proj` is the unjittered projection × view (reversed on the HDR path). `jitter` is TAA's
// sub-pixel offset in NDC, keyed to the frame index (RQ5); it is added as `jitter * w`, so it
// survives the perspective divide as a constant screen offset, and it is applied here identically
// for every depth writer: the forward pass, the prepass and the meshlet draws pass the frame's
// `FrameUniforms::jitter.xy` (the motion prepass its motion row's, the same value). Without TAA it
// is zero (GX_NO_JITTER where a source has no frame lane) and the position is `view_proj * world`.

const GX_NO_JITTER: vec2<f32> = vec2<f32>(0.0, 0.0);

fn gx_clip_position(view_proj: mat4x4<f32>, world: vec4<f32>, jitter: vec2<f32>) -> vec4<f32> {
    let clip = view_proj * world;
    return vec4<f32>(clip.xy + jitter * clip.w, clip.zw);
}
