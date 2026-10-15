// The frame bind group's environment with reflection probes (renderer pass 2 A.3;
// `layout::FRAME_ENV_BINDINGS`, `probes::FRAME_PROBE_BINDINGS`): the same names and types the
// Level-2 v2 material map gives `env_sh`, `brdf_lut` and `env_sampler`; binding 11 is the probe
// cube array (layer 0 the sky's prefiltered cube, layers 1.. the probes', every one at the sky's
// roughness levels) and binding 22 the probes' rows in binned order. Until the environment bake
// lands they hold the neutral inputs: a black cube, zero SH and the split-sum identity.

@group(0) @binding(11) var env_probes: texture_cube_array<f32>;
@group(0) @binding(12) var<uniform> env_sh: GxEnvSh;
@group(0) @binding(13) var brdf_lut: texture_2d<f32>;
@group(0) @binding(14) var env_sampler: sampler;
@group(0) @binding(22) var<storage, read> env_probe_rows: array<GxProbeRow>;

// One probe's row (`probes::GpuProbeRow`).
struct GxProbeRow {
    // xyz: the box's least corner; w: the fade distance past its faces.
    min_blend: vec4<f32>,
    // xyz: the box's greatest corner; w: the cube array layer (0: not captured, no weight).
    max_layer: vec4<f32>,
    // xyz: the capture point; w: the radiance multiplier.
    capture_intensity: vec4<f32>,
}

// Whether the pipeline reads the reflection probes: a probe's own capture compiles them out (it
// is lit by the sky alone, and the frame's bins are the camera's screen tiles).
override GX_PROBES: bool = true;

// The clusterable kind the probes are in the bin table (`cluster::ClusterKind::Probe`).
const GX_PROBE_KIND: u32 = 2u;

// The environment's cubes as the shared lighting chunks read them (the v2 prelude's
// material_v2.wgsl answers the same three over its own cube).
fn gx_env_levels() -> u32 {
    return textureNumLevels(env_probes);
}

// The sky's prefiltered radiance along `dir` at level `lod`: layer 0.
fn gx_env_sky(dir: vec3<f32>, lod: f32) -> vec3<f32> {
    return textureSampleLevel(env_probes, env_sampler, dir, 0, lod).rgb;
}

// A probe's weight at `p` (`probes::influence`): 1 inside the box (the room's faces included),
// falling smoothly to 0 over the fade distance past it (a smoothstep per axis, multiplied over the
// axes); 0 farther out.
fn gx_probe_influence(row: GxProbeRow, p: vec3<f32>) -> f32 {
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

// The direction to look a probe's cube up in for a reflection leaving `p` along `dir`
// (`probes::parallax_direction`; Bevy v0.20 `light_probe/environment_map.wesl`
// `compute_cubemap_sample_dir`, MIT OR Apache-2.0): where the ray leaves the probe's influence
// (its box grown by the fade distance, so the projection's fastest turns fall where the probe
// weighs nothing), seen from the capture point. FLOAT_MAX stands in for an axis the ray never
// leaves (WGSL has no infinity; 3.4e38, as contact_shadow.wgsl: Chromium's Tint refuses the
// literal 3.40282347e38 as not representable in f32).
fn gx_probe_parallax(row: GxProbeRow, at: vec3<f32>, dir: vec3<f32>) -> vec3<f32> {
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

// The reflection a surface at `world_pos` sees along `dir` at level `lod` (`probes::blend`): the
// probes of its tile and z-bin, each weighed by its box fade and looked up along its box
// projection, their weights shared when they pass 1, and the sky filling what they leave. No
// probe binned, or a probe's own capture: the sky alone.
fn gx_env_reflection(world_pos: vec3<f32>, dir: vec3<f32>, lod: f32) -> vec3<f32> {
    let sky = gx_env_sky(dir, lod);
    if !GX_PROBES {
        return sky;
    }
    let first = gx_light_bin_word(9u);
    let end = gx_light_bin_word(10u);
    if end <= first {
        return sky;
    }
    let grid = vec4<u32>(gx_light_bin_word(0u), gx_light_bin_word(1u), gx_light_bin_word(2u), gx_light_bin_word(3u));
    // The probes' own z-bin mapping (the header's `kind_depth.zw`) and their z-bins, the third
    // kind's after the lights' and the decals'.
    let depth = vec4<u32>(GX_LIGHT_ZBINS, 0u, gx_light_bin_word(14u), gx_light_bin_word(15u));
    let view_depth = dot(world_pos - frame.camera_pos.xyz, frame.camera_forward.xyz);
    let zbin = gx_light_bin_word(GX_LIGHT_BIN_HEADER_WORDS + GX_PROBE_KIND * GX_LIGHT_ZBINS + gx_light_zbin(view_depth, depth));
    let lowest = zbin & 0xffffu;
    let highest = zbin >> GX_ZBIN_INDEX_BITS;
    if lowest > highest {
        return sky;
    }
    var radiance = vec3<f32>(0.0);
    var total = 0.0;
    let base = gx_light_tile(gx_sun_context.pixel, grid) * grid.z;
    for (var word = lowest / 32u; word <= highest / 32u; word++) {
        var bits = gx_light_tile_word(base + word) & gx_light_word_bits(word, lowest, highest);
        while bits != 0u {
            let i = word * 32u + firstTrailingBit(bits);
            bits &= bits - 1u;
            let row = env_probe_rows[i - first];
            let layer = i32(row.max_layer.w);
            if layer < 1 {
                continue;
            }
            let weight = gx_probe_influence(row, world_pos);
            if weight > 0.0 {
                // The box projection eased in with the weight: where the weight leaves 0 (the
                // influence's face, where the projection turns fastest) the probe is read along
                // the reflection itself, so a fade across open space shows no band.
                let lookup = mix(dir, normalize(gx_probe_parallax(row, world_pos, dir)), weight);
                let sample = textureSampleLevel(env_probes, env_sampler, lookup, layer, lod).rgb;
                radiance += sample * (weight * row.capture_intensity.w);
                total += weight;
            }
        }
    }
    if total > 1.0 {
        return radiance / total;
    }
    return radiance + sky * (1.0 - total);
}
