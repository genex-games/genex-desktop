// Lighting chunk: decals (renderer pass 2 A.10, `decals`; after Godot 4.7.2's clustered decal loop,
// `scene_forward_clustered.glsl`, MIT). Applied to the surface before the ambient chunk: the
// fragment walks the decals binned at its tile and z-bin (the second clusterable kind of the one
// bin table, LG-16), projects its position into each decal's box and blends the decal's base
// colour, normal, roughness, metallic and occlusion into the surface. Reads `light_ext` (the decal
// rows follow every light's extension rows and every shadowed spot's matrix slot,
// `decals::rows_base`), the bin table through `gx_light_bin_word` and `gx_light_tile_word`, the sun
// chunk's fragment context (`gx_sun_context.pixel`) and the material arrays through
// `gx_class_texel`; each prelude answers `gx_decal_texture_bound` for the size classes it binds.
//
// Overlapping decals blend in an order-independent way: each channel is the weighted mean of the
// decals' values, covering 1 - prod(1 - alpha) of the surface's own. The binned order follows the
// camera (view depth), so an "over" blend in that order would swap overlapping decals as it moves.

// Whether the pipeline projects decals (a pipeline-overridable constant): every forward and v2
// pipeline does; a frame without decals walks nothing (its decal range is empty).
override GX_DECALS: bool = true;

// The clusterable kind decals are in the bin table (`cluster::ClusterKind::Decal`).
const GX_DECAL_KIND: u32 = 1u;
// `vec4<f32>`s one decal's row takes (`decals::DECAL_ROW_VEC4S`).
const GX_DECAL_ROW_VEC4S: u32 = 7u;
// The shadowed spots' matrix slots the decal rows follow, filled or not
// (`layout::MAX_SHADOWED_SPOTS`).
const GX_DECAL_SPOT_SLOTS: u32 = 4u;
// The side of the material arrays' size class 0 (`layout::TEXTURE_SIZE_CLASSES`): class k's is this
// times 2^k.
const GX_DECAL_CLASS_SIDE_0: u32 = 256u;

// The first `vec4<f32>` of the decal rows in `light_ext` for a frame binning `lights` lights.
fn gx_decal_rows_base(lights: u32) -> u32 {
    return GX_LIGHT_EXT_VEC4S * lights + GX_SPOT_MATRIX_VEC4S * GX_DECAL_SPOT_SLOTS;
}

// The texel of decal texture `reference` (a material texture reference) at `uv`, or `fallback`
// without a texture: at the mip whose texels the pixel's footprint (`uv_dx`, `uv_dy`: the uv's
// screen-space gradients) covers one to one along its longer axis.
fn gx_decal_texel(color: bool, reference: u32, uv: vec2<f32>, uv_dx: vec2<f32>, uv_dy: vec2<f32>, fallback: vec4<f32>) -> vec4<f32> {
    if reference == NO_TEXTURE {
        return fallback;
    }
    let side = f32(GX_DECAL_CLASS_SIDE_0 << (reference >> GX_TEXTURE_CLASS_SHIFT));
    let footprint = max(dot(uv_dx, uv_dx), dot(uv_dy, uv_dy)) * side * side;
    return gx_decal_class_texel(color, reference, uv, 0.5 * log2(max(footprint, 1e-12)));
}

// How much of a decal reaches a surface turned `facing` (the cosine to the decal's face) at
// `local.y` in its box: the angle fade (Godot's normal fade; `fade.y`, `fade.z` the cosines of its
// full and none angles) times the fade towards the box's top and bottom faces (Godot's upper and
// lower fades; `fade.x` the share of the half-height).
fn gx_decal_fade(facing: f32, local_y: f32, fade: vec4<f32>) -> f32 {
    let turned = saturate((facing - fade.z) / max(fade.y - fade.z, 1e-4));
    let edge = 0.5 - abs(local_y);
    let depth = select(1.0, saturate(edge / max(0.5 * fade.x, 1e-6)), fade.x > 0.0);
    return turned * depth;
}

// `s` with the decals binned at its fragment blended in (the chunk's entry): `dp_dx` and `dp_dy`
// are the screen-space gradients of its world position (`dpdx`/`dpdy` taken in uniform control
// flow; the v2 prelude's isotropic footprint). A fragment no decal reaches is `s` exactly.
fn gx_decals(surface: Surface, dp_dx: vec3<f32>, dp_dy: vec3<f32>) -> Surface {
    var s = surface;
    if !GX_DECALS {
        return s;
    }
    // The decals' index range in the bin header (`LightBinParams::ranges`: the lights' end, then
    // the decals').
    let first = gx_light_bin_word(8u);
    let end = gx_light_bin_word(9u);
    if end <= first {
        return s;
    }
    let grid = vec4<u32>(gx_light_bin_word(0u), gx_light_bin_word(1u), gx_light_bin_word(2u), gx_light_bin_word(3u));
    // The decals' own z-bin mapping (the header's `kind_depth.xy`) and z-bins, after the lights'.
    let depth = vec4<u32>(GX_LIGHT_ZBINS, 0u, gx_light_bin_word(12u), gx_light_bin_word(13u));
    let view_depth = dot(s.world_pos - frame.camera_pos.xyz, frame.camera_forward.xyz);
    let zbin = gx_light_bin_word(GX_LIGHT_BIN_HEADER_WORDS + GX_DECAL_KIND * GX_LIGHT_ZBINS + gx_light_zbin(view_depth, depth));
    let lowest = zbin & 0xffffu;
    let highest = zbin >> GX_ZBIN_INDEX_BITS;
    if lowest > highest {
        return s;
    }
    let base = gx_light_tile(gx_sun_context.pixel, grid) * grid.z;
    let rows = gx_decal_rows_base(first);
    let lod_scale = exp2(gx_texture_lod_bias());
    let grad_dx = dp_dx * lod_scale;
    let grad_dy = dp_dy * lod_scale;
    // Each channel's weighted sum, its weight and the share of the surface's own value the decals
    // leave (the product of 1 - alpha).
    var albedo = vec3<f32>(0.0);
    var albedo_weight = 0.0;
    var albedo_keep = 1.0;
    var normal = vec3<f32>(0.0);
    var normal_keep = 1.0;
    var roughness = vec2<f32>(0.0);
    var roughness_keep = 1.0;
    var metallic = vec2<f32>(0.0);
    var metallic_keep = 1.0;
    var occlusion = 1.0;
    for (var word = lowest / 32u; word <= highest / 32u; word++) {
        var bits = gx_light_tile_word(base + word) & gx_light_word_bits(word, lowest, highest);
        while bits != 0u {
            let i = word * 32u + firstTrailingBit(bits);
            bits &= bits - 1u;
            let at = rows + (i - first) * GX_DECAL_ROW_VEC4S;
            let r0 = light_ext[at];
            let r1 = light_ext[at + 1u];
            let r2 = light_ext[at + 2u];
            let p = vec4<f32>(s.world_pos, 1.0);
            let local = vec3<f32>(dot(r0, p), dot(r1, p), dot(r2, p));
            if any(abs(local) > vec3<f32>(0.5)) {
                continue;
            }
            let color = light_ext[at + 4u];
            let fade = light_ext[at + 6u];
            // The decal's face is its local +y.
            let up = normalize(r1.xyz);
            var alpha = color.a * gx_decal_fade(dot(s.geometric, up), local.y, fade);
            if alpha <= 0.0 {
                continue;
            }
            let maps = light_ext[at + 3u];
            let textures = bitcast<vec4<u32>>(maps);
            // A map in a size class this pipeline does not bind (a v2 material binds class 0
            // only): the decal's shape is unknown there, so it is left out whole.
            if !(gx_decal_texture_bound(textures.x) && gx_decal_texture_bound(textures.y) && gx_decal_texture_bound(textures.z)) {
                continue;
            }
            let uv = local.xz + vec2<f32>(0.5);
            let uv_dx = vec2<f32>(dot(r0.xyz, grad_dx), dot(r2.xyz, grad_dx));
            let uv_dy = vec2<f32>(dot(r0.xyz, grad_dy), dot(r2.xyz, grad_dy));
            let texel = gx_decal_texel(true, textures.x, uv, uv_dx, uv_dy, vec4<f32>(1.0));
            alpha *= texel.a;
            if alpha <= 0.0 {
                continue;
            }
            let look = light_ext[at + 5u];
            let albedo_alpha = alpha * look.x;
            albedo += texel.rgb * color.rgb * albedo_alpha;
            albedo_weight += albedo_alpha;
            albedo_keep *= 1.0 - albedo_alpha;
            // The surface's normal eased towards its geometric normal by the decal's flatten
            // (`maps.w`: a puddle's film over a bumpy road), then tilted by the decal's normal map
            // along the decal's own axes (u its local x, the image's up its -z): a flat texel
            // leaves it as it is.
            let mapped = textures.y != NO_TEXTURE && look.y > 0.0;
            if mapped || maps.w > 0.0 {
                let flat = normalize(mix(s.n, s.geometric, maps.w));
                var turned = flat;
                if mapped {
                    let n = gx_decal_texel(false, textures.y, uv, uv_dx, uv_dy, vec4<f32>(0.5, 0.5, 1.0, 1.0));
                    let tangent = vec3<f32>((n.xy * 2.0 - 1.0) * look.y, n.z * 2.0 - 1.0);
                    let t = normalize(r0.xyz);
                    let tilt = t * tangent.x + cross(up, t) * tangent.y;
                    turned = normalize(flat * max(tangent.z, 1e-3) + tilt - flat * dot(tilt, flat));
                }
                normal += turned * alpha;
                normal_keep *= 1.0 - alpha;
            }
            let orm = gx_decal_texel(false, textures.z, uv, uv_dx, uv_dy, vec4<f32>(1.0)).rgb;
            if look.z >= 0.0 {
                roughness += vec2<f32>(look.z * orm.g, 1.0) * alpha;
                roughness_keep *= 1.0 - alpha;
            }
            if look.w >= 0.0 {
                metallic += vec2<f32>(look.w * orm.b, 1.0) * alpha;
                metallic_keep *= 1.0 - alpha;
            }
            occlusion *= mix(1.0, orm.r, alpha * fade.w);
        }
    }
    if albedo_weight > 0.0 {
        s.albedo = mix(s.albedo, albedo / albedo_weight, 1.0 - albedo_keep);
    }
    if normal_keep < 1.0 {
        s.n = normalize(mix(s.n, normalize(normal), 1.0 - normal_keep));
    }
    if roughness.y > 0.0 {
        s.roughness = clamp(mix(s.roughness, roughness.x / roughness.y, 1.0 - roughness_keep), GX_ROUGHNESS_FLOOR, 1.0);
    }
    if metallic.y > 0.0 {
        s.metallic = clamp(mix(s.metallic, metallic.x / metallic.y, 1.0 - metallic_keep), 0.0, 1.0);
    }
    gx_material_ao *= occlusion;
    return s;
}
