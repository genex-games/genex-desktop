// Pancaking a shadow caster (RQ3 review). A cascade's light depth is tight around its receivers
// and its near cull plane is open, so casters nearer the sun than the near plane reach the
// caster pipelines and must land on the near plane, where they still shadow everything behind
// them. A triangle that crosses the near plane must keep its true depth at every pixel past it:
// clamping its vertices would slide the whole triangle's depth behind the receivers.
//
// With `GX_UNCLIPPED_DEPTH` (the optional WebGPU feature `depth-clip-control`, requested when the
// adapter offers it, `shadow::caster_pipeline`) the pipeline draws with unclipped depth: the
// rasterizer clamps each fragment's depth into the map, exactly, with the hardware depth bias and
// early depth testing. Without it the vertex clamps z onto the near plane, so the rasterizer does
// not clip the triangle, and `fs_shadow_caster` writes the true interpolated depth (orthographic:
// w is 1, so it is exact) clamped onto the near plane, with the casters' depth bias applied in the
// shader, since a fragment that writes its own depth gets no hardware bias.

// The pipeline draws with unclipped depth (`depth-clip-control`).
override GX_UNCLIPPED_DEPTH: bool = false;
// The map's unit of constant depth bias for `fs_shadow_caster` (`r`): 2^-16 for depth16unorm, 0
// for depth32float, whose unit follows the depth's exponent.
override GX_SHADOW_DEPTH_UNIT: f32 = 0.0;
// The casters' depth bias (shadow.rs `CASTER_CONSTANT_BIAS`, `CASTER_SLOPE_BIAS`), applied by
// `fs_shadow_caster` as the hardware applies it: constant units plus slope times the steepest
// depth change per pixel.
override GX_SHADOW_BIAS_CONSTANT: f32 = 2.0;
override GX_SHADOW_BIAS_SLOPE: f32 = 2.0;
// Whether the casters may fade between LODs, dithered as the forward pass dithers them (the forward
// pass's `GX_LOD_FADE`); false (the default) casts every row whole.
override GX_LOD_FADE: bool = false;

struct ShadowCasterOut {
    @builtin(position) clip: vec4<f32>,
    // The caster's light-space depth before any clamp.
    @location(0) light_z: f32,
}

// The caster's clip position for the cascade (`clip`), clamped onto the near plane unless the
// pipeline draws with unclipped depth, with its true depth beside it.
fn gx_shadow_caster(clip: vec4<f32>) -> ShadowCasterOut {
    var out: ShadowCasterOut;
    out.clip = clip;
    out.light_z = clip.z;
    if !GX_UNCLIPPED_DEPTH {
        out.clip.z = max(clip.z, 0.0);
    }
    return out;
}

// The caster's true depth, clamped onto the near plane and biased (pipelines without unclipped
// depth only).
@fragment
fn fs_shadow_caster(in: ShadowCasterOut) -> @builtin(frag_depth) f32 {
    return gx_shadow_caster_depth(in.light_z);
}

// The depth `fs_shadow_caster` writes for a caster at light-space depth `light_z`: clamped onto
// the near plane, with the casters' constant and slope bias. Call it in uniform control flow.
fn gx_shadow_caster_depth(light_z: f32) -> f32 {
    let z = max(light_z, 0.0);
    let slope = max(abs(dpdx(light_z)), abs(dpdy(light_z)));
    var unit = GX_SHADOW_DEPTH_UNIT;
    if unit <= 0.0 {
        unit = exp2(floor(log2(max(z, 1.0e-30))) - 23.0);
    }
    return clamp(z + GX_SHADOW_BIAS_CONSTANT * unit + GX_SHADOW_BIAS_SLOPE * slope, 0.0, 1.0);
}
