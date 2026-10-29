// Layered materials (AAA materials lane, review WP-7 and WP-15; `layers.rs`): parallax occlusion
// mapping of the base layer (`gx_parallax_uv`, before the surface's fetches), then the detail maps,
// the second height-blended layer and the cover laid over the built-in surface
// (`gx_layered_surface`), and the extra lobes' state for `shade` (`gx_lobes_begin`). Each part runs
// only under its flag in the material's extension row and the pipeline's `GX_MATERIAL_LAYERS` tier
// (declared in surface.wgsl): 0 the cover without its noise, 1 everything but parallax, 2
// everything. A material without layers takes none of these branches. Every texture is fetched
// with the caller's gradients (`gx_class_texel`), so the branches may diverge.
// Concatenated after the surface chunk in every module that includes forward.wgsl.

// Extension-row flags (`layers::MATERIAL_EXT_FLAG_*`).
const GX_EXT_COVER: u32 = 8u;
const GX_EXT_DETAIL: u32 = 16u;
const GX_EXT_LAYER: u32 = 32u;
const GX_EXT_PARALLAX: u32 = 64u;
const GX_EXT_LOBES: u32 = 128u;
// A layer row's texture: `class * 65536 + layer` (`layers::LAYER_TEXTURE_CLASS_STEP`).
const GX_LAYER_CLASS_STEP: u32 = 65536u;
// A detail albedo's mid-grey (sRGB 128) in linear light, inverted: it multiplies the base colour
// by 1 (Unity's linear "colour space double", 2^2.2).
const GX_DETAIL_GREY: f32 = 4.5947938;
// How wide a noisy cover's patch edge is in amount units (`gx_cover`): wider is softer.
const GX_COVER_EDGE: f32 = 0.12;
// A parallax search's least view cosine (a grazing view would push the shift without bound).
const GX_PARALLAX_GRAZE: f32 = 0.2;

// The extension row's flag bits.
fn gx_layer_flags(ext: GxMaterialExt) -> u32 {
    return u32(max(ext.params.z, 0.0));
}

// A layer row's texture as a `gx_class_texel` reference (NO_TEXTURE for -1).
fn gx_layer_texture(value: f32) -> u32 {
    if value < 0.0 {
        return NO_TEXTURE;
    }
    let packed = u32(value + 0.5);
    return ((packed / GX_LAYER_CLASS_STEP) << GX_TEXTURE_CLASS_SHIFT) | (packed % GX_LAYER_CLASS_STEP);
}

// The tangent frame of a fragment: tangent, bitangent (where v grows), geometric normal.
struct GxLayerFrame {
    t: vec3<f32>,
    b: vec3<f32>,
    g: vec3<f32>,
}

// The frame of geometric normal `normal` and mesh tangent `tangent` (Gram-Schmidt); a tangent
// along the normal (or none) takes any axis across it.
fn gx_layer_frame(normal: vec3<f32>, tangent: vec4<f32>) -> GxLayerFrame {
    let g = normalize(normal);
    var t = tangent.xyz - g * dot(g, tangent.xyz);
    if dot(t, t) < 1e-8 {
        t = cross(g, select(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(1.0, 0.0, 0.0), abs(g.y) > 0.9));
    }
    t = normalize(t);
    let handedness = select(1.0, tangent.w, tangent.w != 0.0);
    return GxLayerFrame(t, cross(g, t) * handedness, g);
}

// The base layer's UVs shifted by parallax occlusion mapping (tier 2): a steep search along the
// view ray through the height map (red, white the surface), fewer steps face on, then one secant
// step between the last two. `view` is the unit direction to the viewer; `uv_dx`, `uv_dy` the
// unshifted UVs' gradients (taken in uniform control flow by the caller).
fn gx_parallax_uv(ext: GxMaterialExt, uv: vec2<f32>, uv_dx: vec2<f32>, uv_dy: vec2<f32>, frame_ts: GxLayerFrame, view: vec3<f32>) -> vec2<f32> {
    if GX_MATERIAL_LAYERS < 2u || (gx_layer_flags(ext) & GX_EXT_PARALLAX) == 0u {
        return uv;
    }
    let height = gx_layer_texture(ext.parallax.x);
    let v_ts = vec3<f32>(dot(view, frame_ts.t), dot(view, frame_ts.b), dot(view, frame_ts.g));
    if v_ts.z <= 0.0 || height == NO_TEXTURE {
        return uv;
    }
    let shift = -v_ts.xy / max(v_ts.z, GX_PARALLAX_GRAZE) * ext.parallax.y;
    // No finer steps than the pixels the shift crosses: a far or sub-pixel parallax is cheap.
    let pixels = length(shift) / max(max(length(uv_dx), length(uv_dy)), 1e-6);
    if pixels < 1.0 {
        return uv;
    }
    let most = max(ext.parallax.z, 4.0);
    let by_angle = mix(most, max(most * 0.25, 4.0), v_ts.z);
    let count = u32(clamp(min(by_angle, ceil(pixels)), 4.0, most));
    let step = 1.0 / f32(count);
    var depth = 0.0;
    var previous = 1.0 - gx_class_texel(false, height, uv, uv_dx, uv_dy).r;
    if previous <= 0.0 {
        return uv;
    }
    for (var i = 0u; i < count; i++) {
        depth += step;
        let below = 1.0 - gx_class_texel(false, height, uv + shift * depth, uv_dx, uv_dy).r;
        if below <= depth {
            // The ray crossed the height field between the previous step and this one.
            let before = previous - (depth - step);
            let after = below - depth;
            let at = depth - step + step * clamp(before / max(before - after, 1e-5), 0.0, 1.0);
            return uv + shift * at;
        }
        previous = below;
    }
    return uv + shift;
}

// Two octaves of the surface chunk's value noise at `world_pos` in patches of `metres`.
fn gx_layer_noise(world_pos: vec3<f32>, metres: f32) -> f32 {
    let p = world_pos / max(metres, 0.02);
    return 0.65 * gx_value_noise(p) + 0.35 * gx_value_noise(p * 2.37 + vec3<f32>(17.0, 5.0, 11.0));
}

// `s` with the detail maps over it (tier 1): an albedo overlay around mid-grey and a normal map
// added to the shading normal, both faded out by `distance` (metres from the camera).
fn gx_detail(s: Surface, ext: GxMaterialExt, uv: vec2<f32>, uv_dx: vec2<f32>, uv_dy: vec2<f32>, f: GxLayerFrame, distance: f32) -> Surface {
    var out = s;
    let tiles = ext.detail.z;
    var fade = 1.0;
    if ext.detail_look.y > 0.0 {
        fade = clamp(1.0 - distance / ext.detail_look.y, 0.0, 1.0);
    }
    // Past its fade the detail changes nothing: no fetch.
    if fade <= 0.0 {
        return out;
    }
    let albedo = gx_layer_texture(ext.detail.x);
    if albedo != NO_TEXTURE {
        let texel = gx_class_texel(true, albedo, uv * tiles, uv_dx * tiles, uv_dy * tiles).rgb;
        out.albedo *= mix(vec3<f32>(1.0), texel * GX_DETAIL_GREY, ext.detail.w * fade);
    }
    let normal = gx_layer_texture(ext.detail.y);
    if normal != NO_TEXTURE {
        let texel = gx_class_texel(false, normal, uv * tiles, uv_dx * tiles, uv_dy * tiles);
        let tilt = (texel.xy * 2.0 - 1.0) * ext.detail_look.x * fade;
        out.n = normalize(out.n + f.t * tilt.x + f.b * tilt.y);
    }
    return out;
}

// The second layer's mask at a fragment: a world noise, the up-facing share, or a vertex colour
// channel.
fn gx_layer_mask(ext: GxMaterialExt, world_pos: vec3<f32>, g: vec3<f32>, vertex_color: vec4<f32>) -> f32 {
    let code = u32(max(ext.layer_shape.x, 0.0));
    if code == 0u {
        return smoothstep(0.3, 0.7, gx_layer_noise(world_pos, ext.layer_shape.z));
    }
    if code == 1u {
        return smoothstep(0.3, 0.9, g.y);
    }
    return vertex_color[min(code - 2u, 3u)];
}

// `s` with the second layer blended in by its mask through both layers' heights (tier 1): where
// the mask is half way, the higher layer shows, within the blend depth; 0 is the base whole, 1
// the layer whole.
fn gx_second_layer(s: Surface, ext: GxMaterialExt, uv: vec2<f32>, uv_dx: vec2<f32>, uv_dy: vec2<f32>, f: GxLayerFrame, vertex_color: vec4<f32>) -> Surface {
    // Where the mask is 0 the blend is exactly the base, whatever the heights: no fetch at all.
    let mask = gx_layer_mask(ext, s.world_pos, f.g, vertex_color);
    if mask <= 0.0 {
        return s;
    }
    var out = s;
    let tiles = ext.layer_shape.w;
    let luv = uv * tiles;
    let ldx = uv_dx * tiles;
    let ldy = uv_dy * tiles;
    var albedo = ext.layer_tint.rgb;
    let base = gx_layer_texture(ext.layer.x);
    if base != NO_TEXTURE {
        albedo *= gx_class_texel(true, base, luv, ldx, ldy).rgb;
    }
    var orm = vec3<f32>(1.0, 1.0, 0.0);
    let orm_ref = gx_layer_texture(ext.layer.z);
    if orm_ref != NO_TEXTURE {
        orm = gx_class_texel(false, orm_ref, luv, ldx, ldy).rgb;
    }
    var n = f.g;
    let normal = gx_layer_texture(ext.layer.y);
    if normal != NO_TEXTURE {
        let texel = gx_class_texel(false, normal, luv, ldx, ldy);
        let tn = vec3<f32>(texel.xy * 2.0 - 1.0, texel.z * 2.0 - 1.0);
        n = normalize(f.t * tn.x + f.b * tn.y + f.g * tn.z);
    }
    var height = 0.5;
    let height_ref = gx_layer_texture(ext.layer.w);
    if height_ref != NO_TEXTURE {
        height = gx_class_texel(false, height_ref, luv, ldx, ldy).r;
    }
    // At mask 1 the blend is exactly the layer: the base's height is not read.
    var base_height = 0.5;
    let base_height_ref = gx_layer_texture(ext.parallax.x);
    if base_height_ref != NO_TEXTURE && mask < 1.0 {
        base_height = gx_class_texel(false, base_height_ref, uv, uv_dx, uv_dy).r;
    }
    // A height blend that is exactly the base at mask 0 and the layer at mask 1, whatever the
    // heights (Mishkinis' depth as the width of the line between them).
    let depth = max(ext.layer_shape.y, 0.01);
    let x = (height - base_height) + (2.0 * mask - 1.0) * (1.0 + depth);
    let w = clamp(x / depth * 0.5 + 0.5, 0.0, 1.0);
    out.albedo = mix(out.albedo, albedo, w);
    out.roughness = mix(out.roughness, clamp(ext.layer_tint.a * orm.g, GX_ROUGHNESS_FLOOR, 1.0), w);
    out.metallic = mix(out.metallic, orm.b, w);
    out.n = normalize(mix(out.n, n, w));
    gx_material_ao = mix(gx_material_ao, orm.r, w);
    return out;
}

// `s` with its cover where it faces up (every tier; its noise from tier 1): the slope band from the
// cover's steepest slope to the softness above it, times the covered share its amount asks for
// (in patches by its noise, or evenly without). Where it lies its colour replaces
// the base colour by its opacity, it darkens what stays, and its roughness and flattened normal
// replace the surface's.
fn gx_cover(s: Surface, ext: GxMaterialExt, g: vec3<f32>) -> Surface {
    var out = s;
    let up = normalize(g + s.n).y;
    let slope = clamp((up - ext.cover_shape.x) / max(ext.cover_shape.y, 1e-3), 0.0, 1.0);
    // The amount is the covered share: a noise of strength k breaks it into patches (a point is
    // covered where its noise, pulled toward 0.5 by 1 - k, is below the amount), and with no noise
    // (or on the cheapest tier) the amount fades the cover evenly. 0 lies nowhere, 1 everywhere.
    var k = 0.0;
    var noise = 0.5;
    if GX_MATERIAL_LAYERS >= 1u && ext.cover_look.x > 0.0 {
        k = ext.cover_look.x;
        noise = mix(0.5, gx_layer_noise(s.world_pos, ext.cover_look.y), k);
    }
    let width = mix(GX_COVER_EDGE * 0.5, 0.5, (1.0 - k) * (1.0 - k));
    let m = slope * smoothstep(noise - width, noise + width, ext.cover.a);
    let opacity = ext.cover_look.w * m;
    out.albedo = mix(out.albedo * (1.0 - ext.cover_look.z * m), ext.cover.rgb, opacity);
    out.roughness = mix(out.roughness, clamp(ext.cover_shape.z, GX_ROUGHNESS_FLOOR, 1.0), m);
    out.metallic *= 1.0 - opacity;
    out.n = normalize(mix(out.n, g, ext.cover_shape.w * m));
    gx_material_ao = mix(gx_material_ao, 1.0, opacity * ext.cover_shape.w);
    return out;
}

// The built-in surface `s` of a fragment with its material's layers over it: the detail maps and
// the second layer (tier 1), then the cover (every tier). `uv` is the base layer's (parallax
// shifted), `uv_dx`, `uv_dy` its gradients, `distance` the fragment's from the camera.
fn gx_layered_surface(s: Surface, ext: GxMaterialExt, uv: vec2<f32>, uv_dx: vec2<f32>, uv_dy: vec2<f32>, f: GxLayerFrame, distance: f32, vertex_color: vec4<f32>) -> Surface {
    let flags = gx_layer_flags(ext);
    var out = s;
    if GX_MATERIAL_LAYERS >= 1u && (flags & GX_EXT_DETAIL) != 0u {
        out = gx_detail(out, ext, uv, uv_dx, uv_dy, f, distance);
    }
    if GX_MATERIAL_LAYERS >= 1u && (flags & GX_EXT_LAYER) != 0u {
        out = gx_second_layer(out, ext, uv, uv_dx, uv_dy, f, vertex_color);
    }
    if (flags & GX_EXT_COVER) != 0u {
        out = gx_cover(out, ext, f.g);
    }
    return out;
}

// Sets the extra lobes `shade` and the ambient chunk read for this fragment (tier 1; zero
// otherwise): the clearcoat over the geometric normal, the sheen, and the anisotropy along the
// tangent turned by its rotation.
fn gx_lobes_begin(ext: GxMaterialExt, f: GxLayerFrame) {
    if GX_MATERIAL_LAYERS < 1u || (gx_layer_flags(ext) & GX_EXT_LOBES) == 0u {
        return;
    }
    gx_lobe_params = vec4<f32>(ext.lobes.x, ext.lobes.y, ext.lobes.z, 1.0);
    gx_lobe_sheen = ext.sheen;
    gx_lobe_tangent = cos(ext.lobes.w) * f.t + sin(ext.lobes.w) * f.b;
    gx_lobe_coat_normal = f.g;
}

// The share of the background a transmissive material lets through at a fragment
// (`KHR_materials_transmission`, thin-walled): its transmission less what the surface reflects
// (Schlick at 0.04). 0 for an opaque material.
fn gx_transmitted(ext: GxMaterialExt, n_dot_v: f32) -> f32 {
    let t = clamp(ext.transmission.w, 0.0, 1.0);
    return t * (1.0 - (0.04 + 0.96 * pow(1.0 - clamp(n_dot_v, 0.0, 1.0), 5.0)));
}
