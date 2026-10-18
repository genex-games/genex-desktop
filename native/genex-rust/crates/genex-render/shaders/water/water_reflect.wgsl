// The lake's reflection (renderer pass 2 B.9 follow-up on B.3; `water::reflect`): included after
// the SSR helper (screen/ssr_march.wgsl) and water.wgsl, whose bindings it reads. Every term has
// a CPU twin in `water/reflect.rs` of the same name.
//
// - The screen (`water.flags.y`, desktop and web high and ultra): the helper's march finds the
//   reflected surface in this frame's depth; the colour pyramid is last frame's, so the hit is
//   reprojected into last frame's screen and re-exposed (B.9's trace does both), read at the mip
//   the roughness cone spans (the surface's roughness with its sub-pixel ripples folded in,
//   `gx_water_surface`), and faded at either screen's edge.
// - The environment (where the march misses, and on phones always): the reflection probes over
//   the water, weighed and box-projected as the forward pass's `gx_env_light` does, the sky layer
//   filling what they leave.

// One reflection probe's row (`probes::GpuProbeRow`, the forward pass's `GxProbeRow`).
struct GxWaterProbe {
    // xyz: the box's least corner; w: the fade distance past its faces.
    min_blend: vec4<f32>,
    // xyz: the box's greatest corner; w: its cube array layer (1..; 0 weighs nothing).
    max_layer: vec4<f32>,
    // xyz: the capture point; w: the radiance multiplier.
    capture_intensity: vec4<f32>,
}

// `water::reflect::GpuWaterReflect`.
struct WaterReflect {
    // This frame's unjittered NDC to last frame's clip space (the colour pyramid's).
    reprojection: mat4x4<f32>,
    // x: this frame's exposure over the pyramid's; yzw: unused.
    screen: vec4<f32>,
    // x: the probe rows held; yzw: unused.
    counts: vec4<u32>,
    probes: array<GxWaterProbe, 4>,
}

@group(1) @binding(6) var<uniform> water_reflect: WaterReflect;

// `water::reflect::MAX_WATER_PROBES`.
const GX_WATER_PROBES_MAX: u32 = 4u;

// A probe's weight at `p` (`probes::influence`; the forward pass's `gx_probe_influence`).
fn gx_water_probe_influence(row: GxWaterProbe, p: vec3<f32>) -> f32 {
    let blend = row.min_blend.w;
    let inside = min(p - (row.min_blend.xyz - vec3<f32>(blend)), (row.max_layer.xyz + vec3<f32>(blend)) - p);
    if any(inside < vec3<f32>(0.0)) {
        return 0.0;
    }
    if blend <= 0.0 {
        return 1.0;
    }
    let ramp = smoothstep(vec3<f32>(0.0), vec3<f32>(1.0), inside / blend);
    return ramp.x * ramp.y * ramp.z;
}

// The box-projected lookup for a reflection leaving `at` along `dir` (`probes::parallax_direction`;
// the forward pass's `gx_probe_parallax`, after Bevy v0.20, MIT OR Apache-2.0).
fn gx_water_probe_parallax(row: GxWaterProbe, at: vec3<f32>, dir: vec3<f32>) -> vec3<f32> {
    let lo = row.min_blend.xyz - vec3<f32>(row.min_blend.w);
    let hi = row.max_layer.xyz + vec3<f32>(row.min_blend.w);
    let p = clamp(at, lo, hi);
    let parallel = abs(dir) < vec3<f32>(1e-6);
    let plane = select(lo, hi, dir > vec3<f32>(0.0));
    let exits = select((plane - p) / dir, vec3<f32>(3.4e38), parallel);
    let distance = min(exits.x, min(exits.y, exits.z));
    let corrected = p + dir * distance - row.capture_intensity.xyz;
    if distance >= 3.0e38 || dot(corrected, corrected) < 1e-12 {
        return dir;
    }
    return corrected;
}

// The environment's reflection along `r` at level `lod` leaving water point `world`
// (`water::reflect::environment`): the probes over the water, their weights shared when they pass
// 1, the sky layer filling what they leave.
fn gx_water_environment(world: vec3<f32>, r: vec3<f32>, lod: f32) -> vec3<f32> {
    let sky = textureSampleLevel(water_env, water_sampler, r, 0, lod).rgb;
    var radiance = vec3<f32>(0.0);
    var total = 0.0;
    let count = min(water_reflect.counts.x, GX_WATER_PROBES_MAX);
    for (var i = 0u; i < count; i += 1u) {
        let row = water_reflect.probes[i];
        let layer = i32(row.max_layer.w);
        let weight = select(0.0, gx_water_probe_influence(row, world), layer >= 1);
        if weight > 0.0 {
            // Eased in with the weight, as the forward pass does: no band where a fade ends.
            let lookup = mix(r, normalize(gx_water_probe_parallax(row, world, r)), weight);
            radiance += textureSampleLevel(water_env, water_sampler, lookup, layer, lod).rgb * (weight * row.capture_intensity.w);
            total += weight;
        }
    }
    return radiance / max(total, 1.0) + sky * max(1.0 - total, 0.0);
}

// Last frame's screen uv (y down) of this frame's screen point `uv` at device depth `raw`
// (`water::reflect::reproject`).
fn gx_water_reproject(uv: vec2<f32>, raw: f32) -> vec2<f32> {
    let clip = water_reflect.reprojection * vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, raw, 1.0);
    let ndc = clip.xy / clip.w;
    return vec2<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
}

// The colour pyramid's mip for a cone of `roughness` over a ray `ray_len` long on screen
// (`water::reflect::screen_mip`; B.9's `ssr_mip`, Godot 4.7.2's sphere fit, MIT).
fn gx_water_screen_mip(roughness: f32, ray_len: f32) -> f32 {
    if roughness <= 0.001 {
        return 0.0;
    }
    let cone = min(roughness, 0.999) * 1.5707964;
    let a = 2.0 * tan(cone) * ray_len;
    let h = ray_len;
    let radius = (a * (sqrt(a * a + 4.0 * h * h) - a)) / max(4.0 * h, 1e-8);
    let size = vec2<f32>(textureDimensions(water_history));
    let last = f32(textureNumLevels(water_history) - 1u);
    let mip = clamp(log2(radius * max(size.x, size.y) / 16.0 + 1.0), 0.0, last);
    return mip * pow(saturate(1.25 - ray_len), 0.2);
}

// The reflected radiance along `r` leaving `world` at perceptual `roughness` (the surface's, its
// sub-pixel ripples included; pre-exposed by `exposure`): the screen's where the march hits, faded
// to the environment towards either screen's edge; the environment elsewhere.
fn gx_water_reflection(world: vec3<f32>, r: vec3<f32>, roughness: f32, exposure: f32) -> vec3<f32> {
    let lod = roughness * max(water.surface.w - 1.0, 0.0);
    let environment = gx_water_environment(world, r, lod) * exposure;
    if water.flags.y != 1u {
        return environment;
    }
    var march = gx_ssr_march_world(frame.view_proj, water.proj, water.flags.z, world, r);
    march.linear_steps = GX_WATER_SSR_STEPS;
    march.bisection_steps = GX_WATER_SSR_BISECTIONS;
    march.thickness = GX_WATER_SSR_THICKNESS_M;
    let hit = gx_ssr_march_run(water_depth, march);
    if hit.hit == 0u {
        return environment;
    }
    let size = vec2<i32>(textureDimensions(water_depth));
    let raw = textureLoad(water_depth, clamp(vec2<i32>(hit.uv * vec2<f32>(size)), vec2<i32>(0), size - vec2<i32>(1)), 0);
    let previous = gx_water_reproject(hit.uv, raw);
    let start = frame.view_proj * vec4<f32>(world, 1.0);
    let start_uv = vec2<f32>(start.x / start.w * 0.5 + 0.5, 0.5 - start.y / start.w * 0.5);
    let mip = gx_water_screen_mip(roughness, length(hit.uv - start_uv));
    let screen = textureSampleLevel(water_history, water_sampler, previous, mip).rgb * water_reflect.screen.x;
    let fade = min(gx_ssr_edge_fade(hit.uv), gx_ssr_edge_fade(previous));
    return mix(environment, screen, fade);
}
