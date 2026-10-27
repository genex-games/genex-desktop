// The screen-space reflections' surface texel (renderer pass 2 B.9's frame hook): the shading
// normal and perceptual roughness the forward pass will shade a fragment with (normal map, specular
// AA, the decals' wet patches) as A.6's `rgba8unorm` texel (normal_roughness.wgsl). The prepass
// itself writes the geometry's vertex normals: a puddle decal at roughness 0.04 over rough asphalt
// is a mirror only here. Concatenated after forward.wgsl and normal_roughness.wgsl in the forward
// module (`shaders::FORWARD`); the prepass's surface twin (prepass_surface.wgsl, lane FR) writes it
// beside the prepass's own targets.

fn gx_ssr_surface_texel(in: VsOut, front: bool) -> vec4<f32> {
    // The decals' texture gradients and the fragment's pixel, as `surface` takes them.
    let world_dx = dpdx(in.world_pos);
    let world_dy = dpdy(in.world_pos);
    gx_sun_shadow_context(in.clip.xy, frame.shadow_counts.z, frame.shadow_soft.y);
    let facing = select(-1.0, 1.0, front);
    let tangent = vec4<f32>(in.tangent.xyz * facing, in.tangent.w * facing);
    let mapped = gx_surface_uv(material_ext[in.material].uv, in.uv, tangent, in.world_pos, in.normal * facing);
    var s = gx_surface(in.world_pos, in.normal * facing, mapped.uv, mapped.tangent, in.material);
    if GX_PROBES {
        s = gx_decals(s, world_dx, world_dy);
    }
    return gx_pack_normal_roughness(s.n, s.roughness);
}
