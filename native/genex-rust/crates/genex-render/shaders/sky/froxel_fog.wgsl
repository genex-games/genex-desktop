// Froxel volumetric fog (graph node 11, renderer pass 2 A.5): the height fog as a lit volume, so the
// sun's shadows carve shafts out of it and local lights glow in it. Ported from Godot Engine 4.7.2's
// `volumetric_fog_process.glsl` (MIT, Godot Engine contributors; THIRD-PARTY-NOTICES.md): its
// `MODE_DENSITY` (each froxel's density and light, temporally reprojected against the last frame's
// with a Halton jitter) and `MODE_FOG` (a front-to-back scan along each column, energy conserving),
// after Wronski 2014 and Hillaire 2015. Our deviations:
// - the slices are the air volumes' (lighting/fog.wgsl `gx_air_slice`: even steps to GX_AIR_NEAR,
//   logarithmic to GX_FOG_AERIAL_RANGE), so the result binds in the aerial volume's slot and the
//   forward pass, the Level-2 v2 prelude and the particles read it through the same lookup;
// - a slice's extinction is the height fog's closed-form optical depth across the slice along the
//   froxel's ray (the fog chunk's `gx_fog_optical_depth`), not the density at one point, so a lit,
//   unshadowed volume is exactly the analytic fog (and the sky background's) at every distance;
// - the light is the fog chunk's in-scatter (the environment's horizon radiance plus the sun's
//   forward lobe, both tinted by the fog's colour, `gx_fog_inscatter`) with the lobe shadowed by the
//   sun's cascades, plus the binned local lights through the same lobe (our tile masks and z-bins,
//   not Godot's cluster); no fog volumes. Inside a room a game declares (an irradiance volume,
//   AAA push P3) the horizon's radiance gives way to what the volume's cells see there (the mean of
//   their ambient cube, `froxel_room_light`), as the forward pass's diffuse light does: the sky does
//   not glow in a corridor through its walls, only the sun's shafts and the lamps do;
// - the opacity holds the fog's `max_opacity` (each slice adds `(T_before - T_after) × light`);
// - the integration folds the aerial perspective in behind the fog: the texel the forward pass reads
//   is `fog(aerial(colour))`, in the split layout (fog.rs `AIR_HALVES`: in-scatter in front with
//   alpha 1, "this volume holds the height fog", and the transmittance per channel behind).
// Everything stays in WebGPU core: rgba16float write-only 3D storage, the history read through a
// filtering sampler, the shadow taps through `textureSampleCompareLevel`.

@group(0) @binding(0) var<uniform> frame: FrameUniforms;
@group(0) @binding(1) var<uniform> froxel: FroxelParams;
@group(0) @binding(2) var shadow_map: texture_depth_2d_array;
@group(0) @binding(3) var shadow_sampler: sampler_comparison;
@group(0) @binding(4) var<storage, read> lights: array<Light>;
@group(0) @binding(5) var<storage, read> light_ext: array<vec4<f32>>;
@group(0) @binding(6) var<storage, read> light_bins: array<u32>;
@group(0) @binding(7) var env_probes: texture_cube_array<f32>;
@group(0) @binding(8) var env_sampler: sampler;
@group(0) @binding(9) var froxel_history: texture_3d<f32>;
@group(0) @binding(10) var froxel_inject: texture_storage_3d<rgba16float, write>;
// The scan's own: this frame's injected volume, the aerial perspective and the result.
@group(0) @binding(11) var froxel_injected: texture_3d<f32>;
@group(0) @binding(12) var froxel_aerial: texture_3d<f32>;
@group(0) @binding(13) var froxel_air_out: texture_storage_3d<rgba16float, write>;
// The inject's irradiance volumes (`probes::ENV_PROBE_ROWS`, `irradiance::ENV_IRRADIANCE`): the
// probes' and volumes' rows and the volumes' atlas.
@group(0) @binding(14) var<storage, read> froxel_rooms: array<FroxelRoom>;
@group(0) @binding(15) var froxel_room_cells: texture_3d<f32>;

// A probe's or volume's row (`probes::GpuProbeRow`, forward_env.wgsl's `GxProbeRow`).
struct FroxelRoom {
    min_blend: vec4<f32>,
    max_layer: vec4<f32>,
    capture_intensity: vec4<f32>,
}

// froxel.rs `GpuFroxelParams`.
struct FroxelParams {
    // The camera's inverse view-projection (unjittered; depth as the frame draws it).
    inv_view_proj: mat4x4<f32>,
    // Last frame's view-projection (the history's camera).
    prev_view_proj: mat4x4<f32>,
    // xyz: the camera; w: the history's weight (0: no history, a reset).
    camera: vec4<f32>,
    // xyz: last frame's camera; w: the NDC depth of the near plane (1 under reverse-Z, else 0).
    prev_camera: vec4<f32>,
    // x, y, z: froxels across, down and slices; w: 1 when the frame's lights are binned.
    grid: vec4<u32>,
    // xyz: this frame's jitter inside a froxel (0..1; the centre, 0.5, without history); w: 0.
    jitter: vec4<f32>,
    // x, y: the render size in pixels; z: 1 when the environment lights the scene (the sky or a
    // map), else 0 (the flat colour: the fog's colour is its in-scatter); w: 0.
    screen: vec4<f32>,
    // The fog row (fog.rs `GpuFog`): the look's under the quality, density > 0.
    fog_color: vec4<f32>,
    fog_params: vec4<f32>,
}

// The lighting chunk's accessors (lighting/fog.wgsl is concatenated ahead of this file): the fog row,
// the environment's sky through layer 0 of the probes' cube array (forward_env.wgsl's), its level
// for a roughness (ambient.wgsl's) and whether the environment lights the scene.
override GX_ENVIRONMENT_LIGHT: bool = true;

fn gx_fog() -> GxFog {
    return GxFog(froxel.fog_color, froxel.fog_params);
}

fn gx_env_sky(dir: vec3<f32>, lod: f32) -> vec3<f32> {
    return textureSampleLevel(env_probes, env_sampler, dir, 0, lod).rgb;
}

fn gx_env_lod(roughness: f32) -> f32 {
    let last_mip = f32(textureNumLevels(env_probes) - 1u);
    let r = clamp(roughness, 0.0, 1.0);
    return last_mip * r * (2.0 - r);
}

// Extinction below which a froxel holds no fog.
const FROXEL_CLEAR: f32 = 1e-7;
// The largest value a half-float texel holds.
const FROXEL_HALF_MAX: f32 = 65504.0;
// Most cascades (layout.rs `MAX_CASCADES`).
const FROXEL_MAX_CASCADES: u32 = 4u;
// The light-bin header words (cluster.rs; lighting/local_lights.wgsl's walk): the grid at 0..4,
// the depth mapping at 4..8, word 5 the lights binned.
const FROXEL_BINNED_WORD: u32 = 5u;
// The shortest distance the windowed falloff divides by (`lights::LIGHT_MIN_DISTANCE`) and the
// narrowest spot cone transition (`lights::SPOT_MIN_TRANSITION`).
const FROXEL_LIGHT_MIN_DISTANCE: f32 = 0.01;
const FROXEL_SPOT_MIN_TRANSITION: f32 = 1e-4;

// The distance along its ray of slice coordinate `w` (`gx_air_slice` inverted; fog.rs
// `aerial_slice_distance`).
fn froxel_distance(w: f32) -> f32 {
    if w >= 1.0 {
        return GX_FOG_AERIAL_RANGE;
    }
    let span = log2(1.0 + GX_FOG_AERIAL_RANGE / GX_AIR_NEAR);
    return GX_AIR_NEAR * (exp2(max(w, 0.0) * span) - 1.0);
}

// Slice `k`'s stretch of its ray (froxel.rs `slice_bounds`): from the previous slice's centre (the
// camera for the first) to its own, so the scan's texel `k` holds the air up to slice `k`'s centre,
// where the forward pass's lookup reads it.
fn froxel_slice_bounds(k: u32) -> vec2<f32> {
    let slices = f32(froxel.grid.z);
    let end = froxel_distance((f32(k) + 0.5) / slices);
    if k == 0u {
        return vec2<f32>(0.0, end);
    }
    return vec2<f32>(froxel_distance((f32(k) - 0.5) / slices), end);
}

// The unit direction of the ray through screen `uv` (0..1, v down) from the camera.
fn froxel_ray(uv: vec2<f32>) -> vec3<f32> {
    let point = froxel.inv_view_proj * vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, froxel.prev_camera.w, 1.0);
    return normalize(point.xyz / point.w - froxel.camera.xyz);
}

// The sun's visibility at `p` through its cascades: one bilinear comparison tap in the cascade its
// view depth falls in (Godot's single read; the history and the scan's trilinear lookup smooth it),
// faded to 1 over the last cascade's end fade and 1 past the last cascade or without shadows.
fn froxel_sun_visibility(p: vec3<f32>) -> f32 {
    if frame.cascade_splits.w < 0.5 {
        return 1.0;
    }
    let depth = dot(p - frame.camera_pos.xyz, frame.camera_forward.xyz);
    let ends = frame.cascade_ends;
    var cascade = FROXEL_MAX_CASCADES;
    for (var c = 0u; c < FROXEL_MAX_CASCADES; c++) {
        if ends[c] > 0.0 && depth <= ends[c] {
            cascade = c;
            break;
        }
    }
    if cascade >= FROXEL_MAX_CASCADES {
        return 1.0;
    }
    let clip = frame.cascade_view_proj[cascade] * vec4<f32>(p, 1.0);
    let ndc = clip.xyz / clip.w;
    if abs(ndc.x) > 1.0 || abs(ndc.y) > 1.0 {
        return 1.0;
    }
    let uv = vec2<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
    let reference = clamp(ndc.z, 0.0, 1.0) - frame.cascade_bias[cascade];
    let lit = textureSampleCompareLevel(shadow_map, shadow_sampler, uv, i32(cascade), reference);
    // The last drawn cascade fades its shadows out before the shadow distance (`shadow_soft.z`).
    let last = cascade + 1u >= FROXEL_MAX_CASCADES || ends[cascade + 1u] <= 0.0;
    let fade = frame.shadow_soft.z;
    if !last || fade <= 0.0 {
        return lit;
    }
    let start = select(0.0, ends[max(cascade, 1u) - 1u], cascade > 0u);
    let fade_from = ends[cascade] - fade * (ends[cascade] - start);
    return mix(lit, 1.0, clamp((depth - fade_from) / max(ends[cascade] - fade_from, 1e-6), 0.0, 1.0));
}

// The binned local lights' light scattered towards the camera at `p` on the ray along `dir`, per
// unit of the lobe's share: each light's windowed inverse-square falloff and smooth cone
// (`lights::windowed_falloff`, `lights::spot_cone`) through the sun lobe's phase at the angle
// between the ray and the light. The froxel's tile mask intersected with its z-bin's index range,
// as the forward pass walks it (`cluster::lights_at`); unshadowed.
fn froxel_local_lights(p: vec3<f32>, dir: vec3<f32>, pixel: vec2<f32>) -> vec3<f32> {
    if froxel.grid.w == 0u || light_bins[FROXEL_BINNED_WORD] == 0u {
        return vec3<f32>(0.0);
    }
    let grid = vec4<u32>(light_bins[0], light_bins[1], light_bins[2], light_bins[3]);
    let bin_depth = vec4<u32>(light_bins[4], light_bins[5], light_bins[6], light_bins[7]);
    let last_tile = max(grid.xy, vec2<u32>(1u)) - vec2<u32>(1u);
    let tile_xy = min(vec2<u32>(max(pixel, vec2<f32>(0.0)) / f32(max(grid.w, 1u))), last_tile);
    let tile = tile_xy.y * grid.x + tile_xy.x;
    let view_depth = dot(p - frame.camera_pos.xyz, frame.camera_forward.xyz);
    let slot = (view_depth - bitcast<f32>(bin_depth.z)) * bitcast<f32>(bin_depth.w);
    let zbin = light_bins[GX_LIGHT_BIN_HEADER_WORDS + min(u32(max(slot, 0.0)), max(bin_depth.x, 1u) - 1u)];
    let lowest = zbin & 0xffffu;
    let highest = zbin >> GX_ZBIN_INDEX_BITS;
    var light = vec3<f32>(0.0);
    if lowest > highest {
        return light;
    }
    let base = GX_LIGHT_TILES_OFFSET_WORDS + tile * grid.z;
    for (var word = lowest / 32u; word <= highest / 32u; word++) {
        let first = word * 32u;
        var bits = light_bins[base + word];
        if lowest > first {
            bits &= 0xffffffffu << (lowest - first);
        }
        if highest < first + 31u {
            bits &= 0xffffffffu >> (first + 31u - highest);
        }
        while bits != 0u {
            let i = first + firstTrailingBit(bits);
            bits &= bits - 1u;
            let row = lights[i];
            let to_light = row.position_range.xyz - p;
            let distance = max(length(to_light), 0.0001);
            let l = to_light / distance;
            let ratio = distance / row.position_range.w;
            let window = saturate(1.0 - ratio * ratio * ratio * ratio);
            var attenuation = window * window / max(distance * distance, FROXEL_LIGHT_MIN_DISTANCE * FROXEL_LIGHT_MIN_DISTANCE);
            let ext_spot = light_ext[i * GX_LIGHT_EXT_VEC4S];
            let ext_params = light_ext[i * GX_LIGHT_EXT_VEC4S + 1u];
            if ext_params.y == f32(GX_LIGHT_SPOT) {
                let t = saturate((dot(-l, ext_spot.xyz) - ext_spot.w) / max(ext_params.x - ext_spot.w, FROXEL_SPOT_MIN_TRANSITION));
                attenuation *= t * t;
            }
            light += row.color.rgb * (attenuation * gx_fog_phase(dot(dir, l)));
        }
    }
    return light;
}

// How much of a room's light point `p` takes: 1 inside its box, easing to 0 over its fade past it
// (forward_env.wgsl's `gx_probe_influence`).
fn froxel_room_influence(room: FroxelRoom, p: vec3<f32>) -> f32 {
    let blend = room.min_blend.w;
    let inside = min(p - (room.min_blend.xyz - vec3<f32>(blend)), (room.max_layer.xyz + vec3<f32>(blend)) - p);
    if any(inside < vec3<f32>(0.0)) {
        return 0.0;
    }
    if blend <= 0.0 {
        return 1.0;
    }
    let ramp = smoothstep(vec3<f32>(0.0), vec3<f32>(1.0), inside / blend);
    return ramp.x * ramp.y * ramp.z;
}

// The mean of a volume's ambient cube at `p` (the radiance its cells see there, all round), read
// with the sampler's trilinear filter: forward_env.wgsl's `gx_volume_irradiance` without its leak
// control, over all six faces.
fn froxel_room_mean(room: FroxelRoom, p: vec3<f32>) -> vec3<f32> {
    let packed = u32(room.capture_intensity.x);
    let cells = vec3<i32>(i32(packed & 63u), i32((packed >> 6u) & 63u), i32((packed >> 12u) & 63u));
    let origin = i32(-room.max_layer.w) - 1;
    let lo = room.min_blend.xyz;
    let spacing = (room.max_layer.xyz - lo) / vec3<f32>(cells);
    let grid = clamp((p - lo) / spacing - 0.5, vec3<f32>(0.0), vec3<f32>(cells - 1));
    let size = vec3<f32>(textureDimensions(froxel_room_cells));
    let texel = vec3<f32>(f32(origin), 0.0, 0.0) + grid + 0.5;
    var sum = vec3<f32>(0.0);
    for (var face = 0u; face < 6u; face++) {
        let offset = vec3<f32>(0.0, f32(face & 1u) * f32(cells.y), f32(face >> 1u) * f32(cells.z));
        sum += textureSampleLevel(froxel_room_cells, env_sampler, (texel + offset) / size, 0.0).rgb;
    }
    return sum / 6.0;
}

// The environment's light at `p` with the rooms around it: each baked volume's mean weighed by its
// influence, how far it has faded in and its multiplier, the horizon's `sky` filling what they
// leave (exactly the sky outside every room), as forward_env.wgsl's `gx_env_light` shares them.
fn froxel_room_light(p: vec3<f32>, sky: vec3<f32>) -> vec3<f32> {
    var light = vec3<f32>(0.0);
    var weight = 0.0;
    for (var i = 0u; i < arrayLength(&froxel_rooms); i++) {
        let room = froxel_rooms[i];
        // A volume's layer is negative once baked; a probe's is positive, an empty row's 0.
        if room.max_layer.w >= 0.0 {
            continue;
        }
        let influence = froxel_room_influence(room, p) * room.capture_intensity.y;
        if influence > 0.0 {
            light += froxel_room_mean(room, p) * (influence * room.capture_intensity.w);
            weight += influence;
        }
    }
    return light / max(weight, 1.0) + sky * max(1.0 - weight, 0.0);
}

// One froxel's fog: rgb the light it scatters towards the camera per unit length (extinction times
// the in-scatter radiance, Godot's `scattering × total_light`), a its extinction per unit length.
fn froxel_density(fog: GxFog, uv: vec2<f32>, k: u32, jitter_z: f32) -> vec4<f32> {
    let dir = froxel_ray(uv);
    let bounds = froxel_slice_bounds(k);
    let origin = froxel.camera.xyz;
    let depth = gx_fog_optical_depth(fog, origin, dir, bounds.y) - gx_fog_optical_depth(fog, origin, dir, bounds.x);
    let extinction = max(depth, 0.0) / max(bounds.y - bounds.x, 1e-6);
    if extinction < FROXEL_CLEAR {
        return vec4<f32>(0.0);
    }
    let p = origin + dir * mix(bounds.x, bounds.y, jitter_z);
    var light = fog.color.rgb;
    if froxel.screen.z > 0.5 {
        let horizon = gx_fog_horizon(dir);
        let sky = froxel_room_light(p, gx_fog_sky_light(gx_env_sky(horizon, gx_env_lod(GX_FOG_ENV_ROUGHNESS)), horizon, dir));
        let locals = froxel_local_lights(p, dir, uv * froxel.screen.xy) * GX_FOG_LOCAL_SHARE;
        light = fog.color.rgb * (sky + gx_fog_sun_lobe(dir) * froxel_sun_visibility(p) + locals);
    }
    return vec4<f32>(light * extinction, extinction);
}

// Where world point `p` falls in last frame's volume (screen uv, v down, and slice coordinate);
// outside 0..1 when last frame did not see it.
fn froxel_reprojected(p: vec3<f32>) -> vec3<f32> {
    let clip = froxel.prev_view_proj * vec4<f32>(p, 1.0);
    if clip.w <= 0.0 {
        return vec3<f32>(-1.0);
    }
    let ndc = clip.xy / clip.w;
    return vec3<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5, gx_air_slice(length(p - froxel.prev_camera.xyz)));
}

// MODE_DENSITY: each froxel's density and light, blended with last frame's at the same world point.
// The history jitters the sample inside the froxel (Godot jitters only cells that reproject; a
// reset frame samples the centres, so a settled capture's first frame is the same every time).
@compute @workgroup_size(4, 4, 4)
fn cs_froxel_inject(@builtin(global_invocation_id) id: vec3<u32>) {
    let grid = froxel.grid.xyz;
    if any(id >= grid) {
        return;
    }
    let fog = gx_fog();
    let size = vec2<f32>(grid.xy);
    let centre_uv = (vec2<f32>(id.xy) + 0.5) / size;
    var density = froxel_density(fog, centre_uv + (froxel.jitter.xy - 0.5) / size, id.z, froxel.jitter.z);
    let weight = froxel.camera.w;
    if weight > 0.0 {
        let bounds = froxel_slice_bounds(id.z);
        let centre = froxel.camera.xyz + froxel_ray(centre_uv) * mix(bounds.x, bounds.y, 0.5);
        let back = froxel_reprojected(centre);
        if all(back > vec3<f32>(0.0)) && all(back < vec3<f32>(1.0)) {
            let history = textureSampleLevel(froxel_history, env_sampler, back, 0.0);
            let valid = all(history == history) && all(abs(history) < vec4<f32>(FROXEL_HALF_MAX));
            if valid {
                density = mix(density, history, weight);
            }
        }
    }
    let invalid = any(density != density);
    density = select(clamp(density, vec4<f32>(0.0), vec4<f32>(FROXEL_HALF_MAX)), vec4<f32>(0.0), invalid);
    textureStore(froxel_inject, vec3<i32>(id), density);
}

// MODE_FOG: the scan along each column, front to back. Slice `k` adds `(T_before - T_after) ×
// light` (Godot's `(S - S T) / σ` times the transmittance so far), its transmittance held to the
// fog's `max_opacity`; the aerial volume is folded in behind the fog at the slice's centre, so the
// texel is `fog(aerial(colour))` as the analytic path applies them.
@compute @workgroup_size(8, 8, 1)
fn cs_froxel_integrate(@builtin(global_invocation_id) id: vec3<u32>) {
    let grid = froxel.grid.xyz;
    if any(id.xy >= grid.xy) {
        return;
    }
    let slices = grid.z;
    let floor_transmittance = 1.0 - clamp(froxel.fog_params.w, 0.0, 1.0);
    let uv = (vec2<f32>(id.xy) + 0.5) / vec2<f32>(grid.xy);
    var transmittance = 1.0;
    var inscatter = vec3<f32>(0.0);
    for (var k = 0u; k < slices; k++) {
        let texel = textureLoad(froxel_injected, vec3<u32>(id.xy, k), 0);
        let bounds = froxel_slice_bounds(k);
        let after = max(transmittance * exp(-texel.a * (bounds.y - bounds.x)), floor_transmittance);
        if texel.a > FROXEL_CLEAR {
            inscatter += (transmittance - min(after, transmittance)) * (texel.rgb / texel.a);
        }
        transmittance = min(after, transmittance);
        let air = gx_air_sample(froxel_aerial, env_sampler, vec3<f32>(uv, (f32(k) + 0.5) / f32(slices)));
        let front = vec4<f32>(air.inscatter * transmittance + inscatter, 1.0);
        let back = vec4<f32>(air.transmittance * transmittance, transmittance);
        textureStore(froxel_air_out, vec3<u32>(id.xy, k), clamp(front, vec4<f32>(0.0), vec4<f32>(FROXEL_HALF_MAX)));
        textureStore(froxel_air_out, vec3<u32>(id.xy, k + slices), back);
    }
}
