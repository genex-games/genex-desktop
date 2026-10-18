// Lake water (renderer pass 2, B.3): its own pipeline over a flat water rectangle, drawn after the
// opaque scene with the screen inputs (A.6). Included after common.wgsl and the SSR helper
// (screen/ssr_march.wgsl). Every term has a CPU twin in `water.rs` of the same name.
//
// The colour model follows the ideas of bevy-aqua-fft (MIT OR Apache-2.0) and bevy_water (MIT OR
// Apache-2.0): the scene behind the surface is attenuated by Beer-Lambert absorption over the
// path the view ray travels under water, the water's own in-scattered light fills what was
// absorbed, and a Schlick Fresnel (F0 0.02) mixes in the reflection. The shore foam follows the
// idea of GodotOceanWaves (MIT): foam where the water is shallower than a width, broken up by a
// value noise. No source text is copied; evanw/webgl-water (no licence) is not used.
//
// Inputs (group 1, the water's own layout; none spends the forward stage's sampled textures):
// - the opaque copy (node 14a): what the refracted ray sees; without it (phones, MSAA presets)
//   the pass blends over the scene instead (premultiplied alpha), unrefracted;
// - the scene depth (the prepass's, the water not in it): the bed's distance, so the path length,
//   the shore foam and the refraction's guard against sampling something in front of the water;
// - the environment cube array's sky layer (node 11): the reflection on every class;
// - the previous frame's colour pyramid (after node 17): the screen-space reflection where the
//   SSR helper's march hits, on presets with the history pyramid (desktop and web high and ultra).
//
// TAA: `fs_water_motion` writes the surface's own motion (and, through the pipeline's depth
// state, its depth) into the motion prepass's targets after the colour pass, so TAA reprojects
// water pixels by the water's motion, not the bed's, and gives them no reactive coverage.

struct Water {
    // The projection the scene depth was drawn with (gx_view_distance), and last frame's
    // unjittered view_proj (the motion key).
    proj: mat4x4<f32>,
    prev_view_proj: mat4x4<f32>,
    // The water rectangle: xyz its centre (y the water level), w unused; its half extents (x, z).
    centre: vec4<f32>,
    half_extent: vec4<f32>,
    // rgb: absorption per metre (Beer-Lambert); w: the refraction's largest uv offset.
    absorption: vec4<f32>,
    // rgb: the in-scattered colour (an albedo of the water body); w: the shore foam's width, m.
    scatter: vec4<f32>,
    // x: perceptual roughness of the reflection; y: ripple strength (normal tilt); z: time, s;
    // w: the environment cube's mip count.
    surface: vec4<f32>,
    // xy: the render size; zw: its reciprocal.
    viewport: vec4<f32>,
    // x: 1 when the opaque copy is bound (refraction; else blended); y: 1 when the screen
    // reflections march (the history pyramid is bound); z: 1 when depth is reversed; w: unused.
    flags: vec4<u32>,
}

@group(0) @binding(0) var<uniform> frame: FrameUniforms;
@group(1) @binding(0) var<uniform> water: Water;
@group(1) @binding(1) var water_opaque: texture_2d<f32>;
@group(1) @binding(2) var water_depth: texture_depth_2d;
@group(1) @binding(3) var water_env: texture_cube_array<f32>;
@group(1) @binding(4) var water_history: texture_2d<f32>;
@group(1) @binding(5) var water_sampler: sampler;

// Schlick's Fresnel reflectance of water seen from air at normal incidence (IOR 1.33).
const GX_WATER_F0: f32 = 0.02;
// The path length standing for "no bed within reach" (sky or far behind): fully absorbed.
const GX_WATER_DEEP_M: f32 = 1e4;
// The path over which the refraction's offset grows to its full size, m (none at the shoreline).
const GX_WATER_REFRACT_RAMP_M: f32 = 2.0;
// The screen reflections' march: samples, bisection steps and the depth thickness, m.
const GX_WATER_SSR_STEPS: u32 = 24u;
const GX_WATER_SSR_BISECTIONS: u32 = 4u;
const GX_WATER_SSR_THICKNESS_M: f32 = 0.6;
// The sun glint's specular power and the most it may add, as a multiple of the sun's radiance
// (a cap, so a ripple facing the sun exactly never becomes a single-pixel firefly).
const GX_WATER_GLINT_POWER: f32 = 900.0;
const GX_WATER_GLINT_MAX: f32 = 4.0;
// The foam's albedo and its noise's cell size, m.
const GX_WATER_FOAM_ALBEDO: f32 = 0.75;
const GX_WATER_FOAM_CELL_M: f32 = 0.35;

struct WaterOut {
    @builtin(position) @invariant clip: vec4<f32>,
    @location(0) world: vec3<f32>,
    @location(1) current: vec4<f32>,
    @location(2) previous: vec4<f32>,
}

@vertex
fn vs_water(@builtin(vertex_index) vertex: u32) -> WaterOut {
    // Two triangles over the rectangle: corners (-1,-1) (1,-1) (1,1), (-1,-1) (1,1) (-1,1).
    var corners = array<vec2<f32>, 6>(vec2(-1.0, -1.0), vec2(1.0, -1.0), vec2(1.0, 1.0), vec2(-1.0, -1.0), vec2(1.0, 1.0), vec2(-1.0, 1.0));
    let corner = corners[vertex % 6u];
    let world = vec3<f32>(water.centre.x + corner.x * water.half_extent.x, water.centre.y, water.centre.z + corner.y * water.half_extent.y);
    var out: WaterOut;
    out.clip = gx_clip_position(frame.view_proj, vec4<f32>(world, 1.0), frame.jitter.xy);
    out.world = world;
    out.current = frame.view_proj * vec4<f32>(world, 1.0);
    out.previous = water.prev_view_proj * vec4<f32>(world, 1.0);
    return out;
}

// The surface normal: four directional ripples (their slopes summed), tilted by `strength`.
fn gx_water_normal(xz: vec2<f32>, t: f32, strength: f32) -> vec3<f32> {
    let dirs = array<vec2<f32>, 4>(vec2(0.8, 0.6), vec2(-0.6, 0.8), vec2(0.96, -0.28), vec2(-0.28, -0.96));
    let freqs = vec4<f32>(1.7, 2.9, 4.3, 6.1);
    let speeds = vec4<f32>(0.9, 1.3, 1.7, 2.3);
    var slope = vec2<f32>(0.0);
    for (var i = 0u; i < 4u; i += 1u) {
        let phase = dot(dirs[i], xz) * freqs[i] + t * speeds[i];
        slope += dirs[i] * cos(phase) / f32(i + 1u);
    }
    return normalize(vec3<f32>(-slope.x * strength, 1.0, -slope.y * strength));
}

// Schlick's Fresnel of water at `cos_theta` (the view and the normal).
fn gx_water_fresnel(cos_theta: f32) -> f32 {
    let m = 1.0 - saturate(cos_theta);
    let m2 = m * m;
    return GX_WATER_F0 + (1.0 - GX_WATER_F0) * m2 * m2 * m;
}

// Beer-Lambert transmittance over `path` metres of water.
fn gx_water_transmittance(absorption: vec3<f32>, path: f32) -> vec3<f32> {
    return exp(-absorption * path);
}

// The shore foam's cover at `depth_below` metres of water under the surface, `width` its width
// and `noise` (0..1) its breakup.
fn gx_water_shore_foam(depth_below: f32, width: f32, noise: f32) -> f32 {
    if width <= 0.0 {
        return 0.0;
    }
    let shallow = 1.0 - smoothstep(0.0, width, depth_below);
    return saturate(shallow * (0.55 + 0.9 * noise) - 0.25);
}

fn gx_water_hash(p: vec2<f32>) -> f32 {
    return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453);
}

// A smooth value noise in 0..1.
fn gx_water_noise(p: vec2<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    let a = gx_water_hash(i);
    let b = gx_water_hash(i + vec2(1.0, 0.0));
    let c = gx_water_hash(i + vec2(0.0, 1.0));
    let d = gx_water_hash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// The scene depth's view distance at `pixel` (the sky: GX_WATER_DEEP_M away).
fn gx_water_bed_distance(pixel: vec2<i32>) -> f32 {
    let size = vec2<i32>(textureDimensions(water_depth));
    let raw = textureLoad(water_depth, clamp(pixel, vec2<i32>(0), size - vec2<i32>(1)), 0);
    let sky = select(raw >= 1.0, raw <= 0.0, water.flags.z == 1u);
    if sky {
        return GX_WATER_DEEP_M;
    }
    return gx_view_distance(water.proj, raw);
}

// The pre-exposure the scene is written with (1 on the legacy scene).
fn gx_water_exposure() -> f32 {
    return select(frame.cascade_splits.z, 1.0, frame.cascade_splits.z <= 0.0);
}

// The reflected radiance along `r` (pre-exposed): the screen's where the march hits, the sky
// layer of the environment elsewhere and at the screen's edge.
fn gx_water_reflection(world: vec3<f32>, r: vec3<f32>, exposure: f32) -> vec3<f32> {
    let lod = water.surface.x * max(water.surface.w - 1.0, 0.0);
    let sky = textureSampleLevel(water_env, water_sampler, r, 0, lod).rgb * exposure;
    if water.flags.y != 1u {
        return sky;
    }
    var march = gx_ssr_march_world(frame.view_proj, water.proj, water.flags.z, world, r);
    march.linear_steps = GX_WATER_SSR_STEPS;
    march.bisection_steps = GX_WATER_SSR_BISECTIONS;
    march.thickness = GX_WATER_SSR_THICKNESS_M;
    let hit = gx_ssr_march_run(water_depth, march);
    if hit.hit == 0u {
        return sky;
    }
    let screen = textureSampleLevel(water_history, water_sampler, hit.uv, 0.0).rgb;
    return mix(sky, screen, gx_ssr_edge_fade(hit.uv));
}

@fragment
fn fs_water(in: WaterOut) -> @location(0) vec4<f32> {
    let exposure = gx_water_exposure();
    let to_eye = frame.camera_pos.xyz - in.world;
    let v = normalize(to_eye);
    let n = gx_water_normal(in.world.xz, water.surface.z, water.surface.y);
    let pixel = vec2<i32>(in.clip.xy);
    let uv = in.clip.xy * water.viewport.zw;
    // The view ray's metres under water per metre of view distance past the surface.
    let along = 1.0 / max(dot(-v, frame.camera_forward.xyz), 1e-3);
    let surface = dot(-to_eye, frame.camera_forward.xyz);

    // Refraction: the scene behind, offset by the ripples, unless the offset lands on something in
    // front of the water (then the straight-through pixel).
    let straight = max(gx_water_bed_distance(pixel) - surface, 0.0) * along;
    var path = straight;
    var behind = vec3<f32>(0.0);
    let refracting = water.flags.x == 1u;
    if refracting {
        let offset = n.xz * water.absorption.w * saturate(straight / GX_WATER_REFRACT_RAMP_M);
        let moved = uv + offset;
        let moved_pixel = vec2<i32>(moved * water.viewport.xy);
        let moved_path = (gx_water_bed_distance(moved_pixel) - surface) * along;
        let keep = moved_path > 0.0;
        path = select(straight, moved_path, keep);
        behind = textureSampleLevel(water_opaque, water_sampler, select(uv, moved, keep), 0.0).rgb;
    }
    let transmittance = gx_water_transmittance(water.absorption.rgb, path);
    let opacity = 1.0 - dot(transmittance, vec3<f32>(1.0 / 3.0));

    // The light the water body scatters back: the sky's ambient and the sun over the water.
    let sun = frame.sun_color.rgb * max(frame.sun_dir.y, 0.0);
    let lit = (frame.ambient.rgb + sun) * exposure;
    let inscatter = water.scatter.rgb * lit * (vec3<f32>(1.0) - transmittance);

    let fresnel = gx_water_fresnel(dot(n, v));
    var r = reflect(-v, n);
    r.y = abs(r.y);
    let reflection = gx_water_reflection(in.world, r, exposure);
    let glint = frame.sun_color.rgb * exposure * min(pow(max(dot(r, frame.sun_dir.xyz), 0.0), GX_WATER_GLINT_POWER) * fresnel * GX_WATER_GLINT_POWER * 0.02, GX_WATER_GLINT_MAX);

    let below = path * abs(v.y);
    let foam = gx_water_shore_foam(below, water.scatter.w, gx_water_noise(in.world.xz / GX_WATER_FOAM_CELL_M + vec2<f32>(water.surface.z * 0.15, 0.0)));
    let foam_light = lit * GX_WATER_FOAM_ALBEDO;

    // Refracting: an opaque surface over the copy. Blending: premultiplied over the scene, which
    // passes the transmitted share through.
    let body = select(inscatter, behind * transmittance + inscatter, refracting);
    let alpha = select(opacity, 1.0, refracting);
    let surface_colour = body * (1.0 - fresnel) + reflection * fresnel + glint;
    let surface_alpha = alpha * (1.0 - fresnel) + fresnel;
    return vec4<f32>(mix(surface_colour, foam_light, foam), mix(surface_alpha, 1.0, foam));
}

struct WaterMotion {
    @location(1) motion: vec2<f32>,
    @location(2) reactive: f32,
}

// The water's motion key: its own NDC motion (current minus previous, unjittered) and no reactive
// coverage, written over the bed's after the colour pass (the depth state writes its depth).
@fragment
fn fs_water_motion(in: WaterOut) -> WaterMotion {
    var out: WaterMotion;
    out.reactive = 0.0;
    if in.previous.w <= 1e-6 || in.current.w <= 1e-6 {
        out.motion = vec2<f32>(0.0);
        out.reactive = 1.0;
        return out;
    }
    out.motion = in.current.xy / in.current.w - in.previous.xy / in.previous.w;
    return out;
}
