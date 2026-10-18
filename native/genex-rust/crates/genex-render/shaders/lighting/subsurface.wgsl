// Lighting chunk: subsurface scattering and diffuse transmission (renderer pass 2 B.1, prior-art
// B4a; src/subsurface.rs). The sun's light a translucent surface lets through, added after the
// sun's direct light for a material whose extension row carries the subsurface flag
// (`layout::MATERIAL_EXT_FLAG_SUBSURFACE`; the caller's draw-uniform branch, so every other
// material shades exactly as before):
//
// - scattering after Filament v1.77.3 `surface_shading_model_subsurface.fs` (Apache-2.0): a wrapped
//   back-scatter lobe mixed toward a forward-scatter lobe about the view-to-light axis, times
//   1 - thickness, in the scatter colour, over pi;
// - diffuse transmission after Bevy v0.20 `pbr_functions.wesl` (MIT OR Apache-2.0): a Lambert lobe
//   about the back of the surface, in the base colour times the transmission share.
//
// Both are lit by the sun's light that crosses the material (`gx_sun_through`), not by the front
// face's shadow test, which a back-lit face always fails and Filament leaves out (its "TODO: apply
// occlusion to the transmitted light"). Reads the forward bindings `frame`, `shadow_map` and
// `point_sampler` and the sun chunk's cascade helpers, so it compiles against FrameUniforms and
// GxFrameV2 alike, as the sun chunk does.

// `layout::MATERIAL_EXT_FLAG_SUBSURFACE`.
const GX_MATERIAL_EXT_FLAG_SUBSURFACE: u32 = 2u;
// Shadow-map texels a receiver may lie behind its own stored depth and still count as crossing no
// material, times 1 + the light's slope over the surface: a 2x2 gather's neighbours on a surface
// tilted to the light differ by about a texel's world size times the slope.
const GX_SUBSURFACE_SLOPE_TEXELS: f32 = 1.0;
// The steepest slope (tangent of the light's angle to the normal) the tolerance follows.
const GX_SUBSURFACE_MAX_SLOPE: f32 = 8.0;

// Whether the material's extension row `ext` lets light through.
fn gx_subsurface_on(ext: GxMaterialExt) -> bool {
    return (u32(ext.params.z) & GX_MATERIAL_EXT_FLAG_SUBSURFACE) != 0u;
}

// The share of the sun's light that reaches `world_pos` through whatever lies between it and the
// sun, scattering over `depth` world units: exp(-distance / depth), the distance being how far
// along the light the receiver lies behind the casters stored around it (one point-sampled gather
// of the cascade it falls in, the four texels' distances weighed bilinearly so the share has no
// texel steps).
// The receiver's own stored depth counts as no material within a tolerance that grows with the
// light's slope over the surface (`n_dot_l`, the geometric normal's): a texel of a surface the
// light grazes spans more depth than one it meets head-on. 1 without shadows or beyond the last
// cascade, as `sun_shadow` is.
fn gx_sun_through(world_pos: vec3<f32>, n_dot_l: f32, depth: f32) -> f32 {
    if frame.cascade_splits.w < 0.5 {
        return 1.0;
    }
    let cascade = gx_sun_cascade(dot(world_pos - frame.camera_pos.xyz, frame.camera_forward.xyz));
    if cascade >= GX_MAX_CASCADES {
        return 1.0;
    }
    let clip = frame.cascade_view_proj[cascade] * vec4<f32>(world_pos, 1.0);
    let ndc = clip.xyz / clip.w;
    if abs(ndc.x) > 1.0 || abs(ndc.y) > 1.0 {
        return 1.0;
    }
    let size = vec2<f32>(textureDimensions(shadow_map));
    let p = vec2<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5) * size - 0.5;
    let base = floor(p);
    let f = p - base;
    // A gather returns (base + (0, 1), base + (1, 1), base + (1, 0), base); `.wzxy` orders them
    // (0, 0), (1, 0), (0, 1), (1, 1).
    let stored = textureGather(shadow_map, point_sampler, (base + 1.0) / size, i32(cascade)).wzxy;
    let weights = vec4<f32>((1.0 - f.x) * (1.0 - f.y), f.x * (1.0 - f.y), (1.0 - f.x) * f.y, f.x * f.y);
    let scale = gx_sun_scale(cascade);
    let texel_world = 1.0 / (scale.x * size.x);
    let cosine = max(abs(n_dot_l), 0.05);
    let slope = min(sqrt(1.0 - cosine * cosine) / cosine, GX_SUBSURFACE_MAX_SLOPE);
    let tolerance = gx_sun_cascade_bias(cascade) / scale.y + GX_SUBSURFACE_SLOPE_TEXELS * texel_world * (1.0 + slope);
    let behind = (vec4<f32>(clamp(ndc.z, 0.0, 1.0)) - stored) / scale.y;
    let crossed = max(behind - vec4<f32>(tolerance), vec4<f32>(0.0));
    // One exp of the bilinearly weighed distance (not four weighed exps): the share's edge stays as
    // smooth and costs a quarter of the transcendentals.
    return exp(-dot(crossed, weights) / max(depth, 1e-4));
}

// The extension row of the surface being shaded, when it lets light through: set by the fragment
// entry (`gx_subsurface_begin`) before it shades, read by the local lights' walk. A module that
// never sets it (terrain, grass, a Level-2 v2 material) adds no subsurface light.
var<private> gx_subsurface_row: GxMaterialExt;
var<private> gx_subsurface_active: bool = false;

// Hand the chunk the shaded surface's extension row; call it in the fragment entry before shading.
fn gx_subsurface_begin(ext: GxMaterialExt) {
    gx_subsurface_row = ext;
    gx_subsurface_active = gx_subsurface_on(ext);
}

// The light surface `s` of extension row `ext` lets through, per unit radiance, from the unit
// direction `l` (toward the light): Filament's scatter in `ext.subsurface.rgb` (a wrapped back
// scatter mixed toward a forward scatter about the view-to-light axis, an `exp2` for `pow`; N.L
// does not apply to the light carried through) and Bevy's back Lambert lobe in the base colour.
fn gx_subsurface_lobes(s: Surface, ext: GxMaterialExt, l: vec3<f32>) -> vec3<f32> {
    let thickness = ext.subsurface.a;
    let power = ext.transmission.x;
    let n_dot_l = dot(s.n, l);
    let forward = exp2(clamp(dot(s.v, -l), 0.0, 1.0) * power - power);
    let back = clamp(n_dot_l * thickness + (1.0 - thickness), 0.0, 1.0) * 0.5;
    let scatter = ext.subsurface.rgb * (mix(back, 1.0, forward) * (1.0 - thickness) / PI);
    let diffuse = s.albedo * ((1.0 - s.metallic) * ext.transmission.y * max(-n_dot_l, 0.0) / PI);
    return scatter + diffuse;
}

// The sun's light that surface `s` of extension row `ext` lets through from the unit direction
// `sun` (toward the sun), through `gx_sun_through`. The caller adds it after `gx_sun`.
fn gx_subsurface_sun(s: Surface, ext: GxMaterialExt, sun: vec3<f32>) -> vec3<f32> {
    let through = gx_sun_through(s.world_pos, dot(s.geometric, sun), ext.transmission.z);
    return gx_subsurface_lobes(s, ext, sun) * frame.sun_color.rgb * through;
}

// A local light's `radiance` (its colour, falloff and cone applied) let through the surface being
// shaded from the unit direction `l`, when the fragment entry handed over a translucent row; 0
// otherwise. Unshadowed here: a spot's shadow map multiplies it with the light's reflected light.
fn gx_subsurface_local(s: Surface, l: vec3<f32>, radiance: vec3<f32>) -> vec3<f32> {
    if !gx_subsurface_active {
        return vec3<f32>(0.0);
    }
    return gx_subsurface_lobes(s, gx_subsurface_row, l) * radiance;
}
