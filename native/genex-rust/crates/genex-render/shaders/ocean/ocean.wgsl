// Ocean tier (renderer pass 2, B.10): the open-sea surface drawn from the FFT's maps
// (ocean_fft.wgsl) by its own pipeline after the opaque scene. Included after common.wgsl and
// clip_position.wgsl. Every term with a CPU twin has it in `ocean.rs` under the same name.
//
// - Geometry: a camera-centred grid of `grid.x` quads a side whose spacing grows with the square of
//   the distance (dense near the eye, reaching `origin.w` metres), displaced by the displacement
//   map (choppy x and z, height); the displacement fades out where the grid is too coarse for it.
// - Normal: the slope map at the pixel, faded towards flat (and the roughness raised) where a pixel
//   covers more than a texel of the patch, so the far sea neither aliases nor sparkles.
// - Colour: Schlick's Fresnel (F0 0.02) between the environment's sky layer and the water body's
//   in-scattered light, a capped sun glint, light through the crests facing away from the sun,
//   foam where the waves fold (the Jacobian below a threshold) and along the coast (the scene depth
//   under the surface shallower than the foam width), and Beer-Lambert absorption over the path to
//   the bed, so a beach shows through the shallows. The pass blends premultiplied over the scene.
//
// Inputs (group 1, its own layout; none spends the forward stage's sampled textures):
// displacement and slope maps, the scene depth without the ocean, the environment cube array.
//
// TAA: `fs_ocean_motion` writes the displaced surface's motion under the camera (and, through the
// pipeline's depth state, its depth) into the motion prepass's targets after the colour pass.

struct OceanDraw {
    // The projection the scene depth was drawn with (gx_view_distance), and last frame's
    // unjittered view_proj (the motion key).
    proj: mat4x4<f32>,
    prev_view_proj: mat4x4<f32>,
    // xz: the grid's centre (the eye, snapped to the patch's texel); y: the sea level; w: the
    // grid's reach, m.
    origin: vec4<f32>,
    // x: the patch size, m; y: the displacement's fade start, m; z: the shore foam's width, m;
    // w: the environment cube's mip count.
    tile: vec4<f32>,
    // rgb: absorption per metre; w: the Jacobian under which the waves foam.
    absorption: vec4<f32>,
    // rgb: the water body's in-scattered albedo; w: the light through the crests' strength.
    scatter: vec4<f32>,
    // x: the reflection's roughness; y: the glint's cap (a multiple of the sun); z: the time, s;
    // w: unused.
    surface: vec4<f32>,
    // x: 1 when depth is reversed; y: quads a side; z: 1 when the scene depth is bound (coast);
    // w: unused.
    flags: vec4<u32>,
}

@group(0) @binding(0) var<uniform> frame: FrameUniforms;
@group(1) @binding(0) var<uniform> ocean: OceanDraw;
@group(1) @binding(1) var ocean_displacement: texture_2d<f32>;
@group(1) @binding(2) var ocean_slope: texture_2d<f32>;
@group(1) @binding(3) var ocean_depth: texture_depth_2d;
@group(1) @binding(4) var ocean_env: texture_cube_array<f32>;
@group(1) @binding(5) var ocean_sampler: sampler;

// Schlick's reflectance of water at normal incidence (IOR 1.33).
const GX_OCEAN_F0: f32 = 0.02;
// The patch's texel count a side (the FFT size).
const GX_OCEAN_TEXELS: f32 = 256.0;
// The path length standing for "no bed within reach": fully absorbed.
const GX_OCEAN_DEEP_M: f32 = 1e4;
// The glint's specular power.
const GX_OCEAN_GLINT_POWER: f32 = 700.0;
// The foam's albedo and how fast it covers past the Jacobian's threshold.
const GX_OCEAN_FOAM_ALBEDO: f32 = 0.8;
const GX_OCEAN_FOAM_RAMP: f32 = 2.5;
// Texels a pixel covers where the slopes start and finish fading to flat.
const GX_OCEAN_DETAIL_START: f32 = 0.75;
const GX_OCEAN_DETAIL_END: f32 = 3.0;
// The roughness a fully faded (sub-pixel) sea reflects with, on top of the surface's.
const GX_OCEAN_FAR_ROUGHNESS: f32 = 0.18;
// The shore foam's noise cell, m.
const GX_OCEAN_FOAM_CELL_M: f32 = 0.6;
// Near the eye the slope map is sampled a second time, this many times smaller and turned, for
// ripples finer than the patch's texel (visual only: the heights gameplay reads are the patch's).
const GX_OCEAN_RIPPLE_SCALE: f32 = 7.31;
const GX_OCEAN_RIPPLE_SLOPE: f32 = 0.35;

struct OceanOut {
    @builtin(position) @invariant clip: vec4<f32>,
    @location(0) world: vec3<f32>,
    // The undisplaced point's patch uv (the maps' coordinates).
    @location(1) uv: vec2<f32>,
    // The displaced point through this frame's and last frame's unjittered view_proj.
    @location(2) current: vec4<f32>,
    @location(3) previous: vec4<f32>,
}

// The grid point of quad corner `vertex`: x and z in -1..1 (corners (0,0) (1,0) (1,1), (0,0)
// (1,1) (0,1) of each quad).
fn gx_ocean_grid_point(vertex: u32, quads: u32) -> vec2<f32> {
    var corners = array<vec2<u32>, 6>(vec2(0u, 0u), vec2(1u, 0u), vec2(1u, 1u), vec2(0u, 0u), vec2(1u, 1u), vec2(0u, 1u));
    let quad = vertex / 6u;
    let cell = vec2<u32>(quad % quads, quad / quads) + corners[vertex % 6u];
    return vec2<f32>(cell) / f32(quads) * 2.0 - 1.0;
}

// Metres from the centre of grid point `g` (-1..1): the square of the distance, so the spacing
// grows away from the eye.
fn gx_ocean_grid_offset(g: vec2<f32>, reach: f32) -> vec2<f32> {
    return sign(g) * g * g * reach;
}

// How much of the displacement a vertex `distance` metres away keeps: all of it near the eye, none
// where the grid's cells are too coarse to follow the patch's waves.
fn gx_ocean_displacement_fade(distance: f32, start: f32) -> f32 {
    return 1.0 - smoothstep(start, start * 3.0, distance);
}

@vertex
fn vs_ocean(@builtin(vertex_index) vertex: u32) -> OceanOut {
    let g = gx_ocean_grid_point(vertex, ocean.flags.y);
    let xz = ocean.origin.xz + gx_ocean_grid_offset(g, ocean.origin.w);
    let uv = xz / ocean.tile.x;
    let fade = gx_ocean_displacement_fade(length(xz - frame.camera_pos.xz), ocean.tile.y);
    let d = textureSampleLevel(ocean_displacement, ocean_sampler, uv, 0.0).xyz * fade;
    let world = vec3<f32>(xz.x + d.x, ocean.origin.y + d.y, xz.y + d.z);
    var out: OceanOut;
    out.clip = gx_clip_position(frame.view_proj, vec4<f32>(world, 1.0), frame.jitter.xy);
    out.world = world;
    out.uv = uv;
    out.current = frame.view_proj * vec4<f32>(world, 1.0);
    out.previous = ocean.prev_view_proj * vec4<f32>(world, 1.0);
    return out;
}

// Schlick's Fresnel of water at `cos_theta` (the view and the normal).
fn gx_ocean_fresnel(cos_theta: f32) -> f32 {
    let m = 1.0 - saturate(cos_theta);
    let m2 = m * m;
    return GX_OCEAN_F0 + (1.0 - GX_OCEAN_F0) * m2 * m2 * m;
}

// How much of the slope map's detail a pixel covering `texels` texels of the patch keeps.
fn gx_ocean_detail(texels: f32) -> f32 {
    return 1.0 - smoothstep(GX_OCEAN_DETAIL_START, GX_OCEAN_DETAIL_END, texels);
}

// The foam where the waves fold: none above the threshold Jacobian, all of it GX_OCEAN_FOAM_RAMP
// below it.
fn gx_ocean_fold_foam(jacobian: f32, threshold: f32) -> f32 {
    return saturate((threshold - jacobian) * GX_OCEAN_FOAM_RAMP);
}

// The coast's foam at `depth_below` metres of water under the surface (`width` its width,
// `noise` 0..1 its breakup).
fn gx_ocean_shore_foam(depth_below: f32, width: f32, noise: f32) -> f32 {
    if width <= 0.0 {
        return 0.0;
    }
    let shallow = 1.0 - smoothstep(0.0, width, depth_below);
    return saturate(shallow * (0.55 + 0.9 * noise) - 0.25);
}

fn gx_ocean_hash(p: vec2<f32>) -> f32 {
    return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453);
}

// A smooth value noise in 0..1.
fn gx_ocean_noise(p: vec2<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    let a = gx_ocean_hash(i);
    let b = gx_ocean_hash(i + vec2(1.0, 0.0));
    let c = gx_ocean_hash(i + vec2(0.0, 1.0));
    let d = gx_ocean_hash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// The scene depth's view distance at `pixel` (none bound or the sky: GX_OCEAN_DEEP_M away).
fn gx_ocean_bed_distance(pixel: vec2<i32>) -> f32 {
    if ocean.flags.z != 1u {
        return GX_OCEAN_DEEP_M;
    }
    let size = vec2<i32>(textureDimensions(ocean_depth));
    let raw = textureLoad(ocean_depth, clamp(pixel, vec2<i32>(0), size - vec2<i32>(1)), 0);
    let sky = select(raw >= 1.0, raw <= 0.0, ocean.flags.x == 1u);
    if sky {
        return GX_OCEAN_DEEP_M;
    }
    return gx_view_distance(ocean.proj, raw);
}

// The pre-exposure the scene is written with (1 on the legacy scene).
fn gx_ocean_exposure() -> f32 {
    return select(frame.cascade_splits.z, 1.0, frame.cascade_splits.z <= 0.0);
}

@fragment
fn fs_ocean(in: OceanOut) -> @location(0) vec4<f32> {
    let exposure = gx_ocean_exposure();
    let displacement = textureSample(ocean_displacement, ocean_sampler, in.uv);
    let slope_texel = textureSample(ocean_slope, ocean_sampler, in.uv);
    let footprint = max(length(dpdx(in.uv)), length(dpdy(in.uv))) * GX_OCEAN_TEXELS;
    let detail = gx_ocean_detail(footprint);
    let ripple_uv = mat2x2<f32>(0.8, 0.6, -0.6, 0.8) * in.uv * GX_OCEAN_RIPPLE_SCALE;
    let ripple_texel = textureSample(ocean_slope, ocean_sampler, ripple_uv).xy;
    let ripple = mat2x2<f32>(0.8, -0.6, 0.6, 0.8) * ripple_texel * GX_OCEAN_RIPPLE_SLOPE * gx_ocean_detail(footprint * GX_OCEAN_RIPPLE_SCALE);
    let slope = slope_texel.xy * detail + ripple;
    let n = normalize(vec3<f32>(-slope.x, 1.0, -slope.y));
    let to_eye = frame.camera_pos.xyz - in.world;
    let v = normalize(to_eye);
    let l = frame.sun_dir.xyz;
    let sun = frame.sun_color.rgb * max(l.y, 0.0) * exposure;
    let ambient = frame.ambient.rgb * exposure;

    // Reflection: the sky layer along the mirrored view, never below the horizon.
    let roughness = saturate(ocean.surface.x + (1.0 - detail) * GX_OCEAN_FAR_ROUGHNESS);
    var r = reflect(-v, n);
    r.y = abs(r.y);
    let lod = roughness * max(ocean.tile.w - 1.0, 0.0);
    let reflection = textureSampleLevel(ocean_env, ocean_sampler, r, 0, lod).rgb * exposure;
    let fresnel = gx_ocean_fresnel(dot(n, v));
    let glint_power = GX_OCEAN_GLINT_POWER * (1.0 - roughness) + 8.0;
    let glint = sun * min(pow(max(dot(r, l), 0.0), glint_power) * fresnel * glint_power * 0.02, ocean.surface.y);

    // The body: in-scattered sky and sun, plus the sun through the crests that face away from it.
    let crest = saturate(displacement.y / max(ocean.tile.x * 0.01, 1e-3));
    let behind_sun = pow(saturate(dot(-v, vec3<f32>(l.x, 0.0, l.z)) * 0.5 + 0.5), 4.0);
    let lit = ambient + sun * saturate(dot(n, l) * 0.5 + 0.5);
    let body_light = ocean.scatter.rgb * (lit + sun * ocean.scatter.w * crest * behind_sun);

    // Absorption over the path to the bed (a coast shows through the shallows).
    let pixel = vec2<i32>(in.clip.xy);
    let along = 1.0 / max(dot(-v, frame.camera_forward.xyz), 1e-3);
    let surface_distance = dot(-to_eye, frame.camera_forward.xyz);
    let path = max(gx_ocean_bed_distance(pixel) - surface_distance, 0.0) * along;
    let transmittance = exp(-ocean.absorption.rgb * path);
    let opacity = 1.0 - dot(transmittance, vec3<f32>(1.0 / 3.0));
    let body = body_light * (vec3<f32>(1.0) - transmittance);

    // Foam: folds and the coast.
    let below = path * abs(v.y);
    let noise = gx_ocean_noise(in.world.xz / GX_OCEAN_FOAM_CELL_M + vec2<f32>(ocean.surface.z * 0.2, 0.0));
    let fold = gx_ocean_fold_foam(displacement.w, ocean.absorption.w) * mix(0.6, 1.0, noise);
    let foam = max(fold, gx_ocean_shore_foam(below, ocean.tile.z, noise));
    // Foam scatters: the sun wraps around it.
    let foam_light = (ambient + sun * saturate(dot(n, l) * 0.5 + 0.5)) * GX_OCEAN_FOAM_ALBEDO;

    // Premultiplied over the scene: the transmitted share of what is behind passes through.
    let colour = body * (1.0 - fresnel) + reflection * fresnel + glint;
    let alpha = opacity * (1.0 - fresnel) + fresnel;
    return vec4<f32>(mix(colour, foam_light, foam), mix(alpha, 1.0, foam));
}

struct OceanMotion {
    @location(1) motion: vec2<f32>,
    @location(2) reactive: f32,
}

// The sea's motion key: the displaced surface's own NDC motion under the camera (current minus
// previous, unjittered) and no reactive coverage, written over the bed's and the sky's after the
// colour pass (the depth state writes its depth), so TAA reprojects a sea pixel by the sea.
@fragment
fn fs_ocean_motion(in: OceanOut) -> OceanMotion {
    var out: OceanMotion;
    out.reactive = 0.0;
    if in.previous.w <= 1e-6 || in.current.w <= 1e-6 {
        out.motion = vec2<f32>(0.0);
        out.reactive = 1.0;
        return out;
    }
    out.motion = in.current.xy / in.current.w - in.previous.xy / in.previous.w;
    return out;
}
