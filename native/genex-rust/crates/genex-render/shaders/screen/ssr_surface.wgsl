// The screen-space reflections' surface pass (renderer pass 2 B.9's frame hook, graph node 10b):
// the opaque batches drawn again over the prepass depth (`Equal`, no depth writes) with the forward
// vertex shader, writing the shading normal and perceptual roughness the forward pass will shade
// each pixel with (normal map, specular AA, the decals' wet patches) as A.6's `rgba8unorm` texel
// (normal_roughness.wgsl). The prepass itself writes the geometry's vertex normals: a puddle decal
// at roughness 0.04 over rough asphalt is a mirror only here. Concatenated after forward.wgsl and
// normal_roughness.wgsl in the forward module (`shaders::FORWARD`); `ssr_draw.rs` records it.

@fragment
fn fs_ssr_surface(in: VsOut, @builtin(front_facing) front: bool) -> @location(0) vec4<f32> {
    // The decals' texture gradients and the fragment's pixel, as `surface` takes them.
    let world_dx = dpdx(in.world_pos);
    let world_dy = dpdy(in.world_pos);
    gx_sun_shadow_context(in.clip.xy, frame.shadow_counts.z, frame.shadow_soft.y);
    let facing = select(-1.0, 1.0, front);
    let tangent = vec4<f32>(in.tangent.xyz * facing, in.tangent.w * facing);
    var s = gx_surface(in.world_pos, in.normal * facing, in.uv, tangent, in.material);
    if GX_PROBES {
        s = gx_decals(s, world_dx, world_dy);
    }
    return gx_pack_normal_roughness(s.n, s.roughness);
}
