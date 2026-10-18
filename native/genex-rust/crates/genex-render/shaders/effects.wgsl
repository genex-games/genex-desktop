// Shared declarations of the RQ4 screen effects (RQ4.0): the fog parameters the lighting chunks
// read through `gx_fog()`, and the octahedral normal encoding of the prepass's `rg16float` normals
// target (the same encoding `gx_normals` holds for Level-2 v2 post passes and Level-3 passes).
//
// The accessors the lighting chunks call are declared by each prelude that concatenates them:
// `gx_fog() -> GxFog`, `gx_ambient_occlusion(world_pos) -> vec4<f32>` (xyz: the bent normal, zero
// when none; w: visibility, 1 unoccluded) and `gx_contact_shadow(world_pos) -> f32` (1 unshadowed).
// Each also declares `override GX_AO_GI: bool`: when true, the AO accessor's xyz is the
// screen-space GI's light (renderer pass 2 B.4) and the term carries no bent normal.
// The forward pass's are shaders/forward_effects.wgsl, the Level-2 v2 material prelude's are in
// part2/material_v2.wgsl. A producer that is off or has not landed reads as its neutral value.

// Height and distance fog (mirrors `fog::GpuFog`; GxFrameV2's fog_color and fog_params).
struct GxFog {
    // rgb: the in-scatter tint (under the flat-colour environment the in-scatter itself: the
    // fog's colour times the flat backdrop's);
    // a: extinction per world unit at the base height (0: no fog).
    color: vec4<f32>,
    // x: height falloff per world unit; y: base height; z: start distance; w: largest opacity.
    params: vec4<f32>,
}

// `v` folded onto the lower octahedron's square.
fn gx_oct_wrap(v: vec2<f32>) -> vec2<f32> {
    return (vec2<f32>(1.0) - abs(v.yx)) * select(vec2<f32>(-1.0), vec2<f32>(1.0), v >= vec2<f32>(0.0));
}

// A unit normal as two numbers in -1..1 (octahedral encoding; a zero normal encodes as +z).
fn gx_oct_encode(n: vec3<f32>) -> vec2<f32> {
    let p = n.xy / max(abs(n.x) + abs(n.y) + abs(n.z), 1e-8);
    return select(gx_oct_wrap(p), p, n.z >= 0.0);
}

// The unit normal `gx_oct_encode` encoded as `e`.
fn gx_oct_decode(e: vec2<f32>) -> vec3<f32> {
    var n = vec3<f32>(e, 1.0 - abs(e.x) - abs(e.y));
    let t = max(-n.z, 0.0);
    n.x += select(t, -t, n.x >= 0.0);
    n.y += select(t, -t, n.y >= 0.0);
    return normalize(n);
}
