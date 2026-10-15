// The frame bind group's environment with reflection probes (renderer pass 2 A.3;
// `layout::FRAME_ENV_BINDINGS`, `probes::FRAME_PROBE_BINDINGS`): the same names and types the
// Level-2 v2 material map gives `env_sh`, `brdf_lut` and `env_sampler`; binding 11 is the probe
// cube array (layer 0 the sky's prefiltered cube, layers 1.. the probes', every one at the sky's
// roughness levels) and binding 22 the probes' rows in binned order. Until the environment bake
// lands they hold the neutral inputs: a black cube, zero SH and the split-sum identity. Binding 32
// is the irradiance volumes' atlas (renderer pass 2 A.4, `irradiance::FRAME_IRRADIANCE_BINDINGS`;
// a 1-texel black volume while none is baked): the volumes' rows share the probes' table and bins.

@group(0) @binding(11) var env_probes: texture_cube_array<f32>;
@group(0) @binding(12) var<uniform> env_sh: GxEnvSh;
@group(0) @binding(13) var brdf_lut: texture_2d<f32>;
@group(0) @binding(14) var env_sampler: sampler;
@group(0) @binding(22) var<storage, read> env_probe_rows: array<GxProbeRow>;
@group(0) @binding(32) var env_irradiance: texture_3d<f32>;

// One probe's or irradiance volume's row (`probes::GpuProbeRow`; a volume's is
// `irradiance::volume_row`).
struct GxProbeRow {
    // xyz: the box's least corner; w: the fade distance past its faces.
    min_blend: vec4<f32>,
    // xyz: the box's greatest corner; w: a probe's cube array layer (0: not captured, no weight),
    // or for a volume -(1 + its block's x in the atlas) (0 while it is not baked).
    max_layer: vec4<f32>,
    // A probe's: xyz the capture point, w the radiance multiplier. A volume's: x its cells along
    // x, y and z (6 bits each from bit 0) and its leak control (bit 18), y how far it has faded in
    // (0..1), z the normal offset of its lookup (world units), w the irradiance multiplier.
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

// The probes and irradiance volumes binned around a surface at `world_pos`: the first sorted
// index of the probe kind (row 0 of `env_probe_rows`), the lowest and highest sorted index of the
// fragment's z-bin (lowest > highest: none), and the fragment's tile mask's first word.
struct GxProbeBins {
    first: u32,
    lowest: u32,
    highest: u32,
    base: u32,
}

fn gx_probe_bins(world_pos: vec3<f32>) -> GxProbeBins {
    let none = GxProbeBins(0u, 1u, 0u, 0u);
    let first = gx_light_bin_word(9u);
    let end = gx_light_bin_word(10u);
    if end <= first {
        return none;
    }
    let grid = vec4<u32>(gx_light_bin_word(0u), gx_light_bin_word(1u), gx_light_bin_word(2u), gx_light_bin_word(3u));
    // The probes' own z-bin mapping (the header's `kind_depth.zw`) and their z-bins, the third
    // kind's after the lights' and the decals'.
    let depth = vec4<u32>(GX_LIGHT_ZBINS, 0u, gx_light_bin_word(14u), gx_light_bin_word(15u));
    let view_depth = dot(world_pos - frame.camera_pos.xyz, frame.camera_forward.xyz);
    let zbin = gx_light_bin_word(GX_LIGHT_BIN_HEADER_WORDS + GX_PROBE_KIND * GX_LIGHT_ZBINS + gx_light_zbin(view_depth, depth));
    let base = gx_light_tile(gx_sun_context.pixel, grid) * grid.z;
    return GxProbeBins(first, zbin & 0xffffu, zbin >> GX_ZBIN_INDEX_BITS, base);
}

// The environment's light on a surface at `world_pos` (renderer pass 2 A.3 and A.4): the
// reflection along `dir` at level `lod` and the diffuse light (irradiance over pi) for unit normal
// `n`, from one walk of the probes and irradiance volumes binned at its tile and z-bin.
// - Reflection (`probes::blend`): each reflection probe weighed by its box fade and looked up
//   along its box projection, their weights shared when they pass 1, the sky filling what they
//   leave.
// - Diffuse (`irradiance::blend`): each irradiance volume weighed by its box fade and how far it
//   has faded in (`gx_volume_irradiance`), their weights shared when they pass 1, the sky's SH9
//   filling what they leave.
// No probe or volume binned, or a capture (GX_PROBES off): the sky and its SH9 alone.
struct GxEnvLight {
    reflection: vec3<f32>,
    diffuse: vec3<f32>,
}

fn gx_env_light(world_pos: vec3<f32>, dir: vec3<f32>, lod: f32, n: vec3<f32>) -> GxEnvLight {
    let sky = gx_env_sky(dir, lod);
    let sky_diffuse = gx_env_irradiance(n);
    if !GX_PROBES {
        return GxEnvLight(sky, sky_diffuse);
    }
    let bins = gx_probe_bins(world_pos);
    let lowest = bins.lowest;
    let highest = bins.highest;
    if lowest > highest {
        return GxEnvLight(sky, sky_diffuse);
    }
    var radiance = vec3<f32>(0.0);
    var total = 0.0;
    var diffuse = vec3<f32>(0.0);
    var volumes = 0.0;
    for (var word = lowest / 32u; word <= highest / 32u; word++) {
        var bits = gx_light_tile_word(bins.base + word) & gx_light_word_bits(word, lowest, highest);
        while bits != 0u {
            let i = word * 32u + firstTrailingBit(bits);
            bits &= bits - 1u;
            let row = env_probe_rows[i - bins.first];
            // A probe's layer is 1.., a volume's negative; 0 (not captured or baked yet) weighs
            // nothing.
            let layer = i32(row.max_layer.w);
            if layer >= 1 {
                let weight = gx_probe_influence(row, world_pos);
                if weight > 0.0 {
                    // The box projection eased in with the weight: where the weight leaves 0 (the
                    // influence's face, where the projection turns fastest) the probe is read
                    // along the reflection itself, so a fade across open space shows no band.
                    let lookup = mix(dir, normalize(gx_probe_parallax(row, world_pos, dir)), weight);
                    let sample = textureSampleLevel(env_probes, env_sampler, lookup, layer, lod).rgb;
                    radiance += sample * (weight * row.capture_intensity.w);
                    total += weight;
                }
            } else if row.max_layer.w < 0.0 {
                let weight = gx_probe_influence(row, world_pos) * row.capture_intensity.y;
                if weight > 0.0 {
                    diffuse += gx_volume_irradiance(row, world_pos, n) * (weight * row.capture_intensity.w);
                    volumes += weight;
                }
            }
        }
    }
    // Shared when the weights pass 1, the sky filling what they leave (exactly the sky with none).
    let reflection = radiance / max(total, 1.0) + sky * max(1.0 - total, 0.0);
    let light = diffuse / max(volumes, 1.0) + sky_diffuse * max(1.0 - volumes, 0.0);
    return GxEnvLight(reflection, light);
}

// --- Irradiance volumes (renderer pass 2 A.4, `irradiance`) ---

// The share of a volume's smallest cell side a shaded point may lie past a cell's reach toward it
// and still be lit by the cell (`irradiance::REACH_TOLERANCE`).
const GX_VOLUME_REACH_TOLERANCE: f32 = 0.15;
// The least share a cell the point is hidden from keeps (`irradiance::HIDDEN_WEIGHT`): the
// weights stay continuous, and a point every cell is hidden from still blends them.
const GX_VOLUME_HIDDEN_WEIGHT: f32 = 1e-4;
// A cell's reaches as its texels' alphas hold them (`irradiance::pack_reaches`): two codes of
// GX_REACH_BITS bits (the + direction's high), each a reach in steps of `reach_max / GX_REACH_MASK`,
// where `reach_max` is GX_REACH_DIAGONALS cell diagonals (`irradiance::REACH_DIAGONALS`).
const GX_REACH_BITS: u32 = 5u;
const GX_REACH_MASK: u32 = 31u;
const GX_REACH_DIAGONALS: f32 = 2.0;

// A volume row's cells along x, y and z (`irradiance::row_cells`).
fn gx_volume_cells(row: GxProbeRow) -> vec3<i32> {
    let packed = u32(row.capture_intensity.x);
    return vec3<i32>(i32(packed & 63u), i32((packed >> 6u) & 63u), i32((packed >> 12u) & 63u));
}

// Texel `face` (0..6: +x, -x, +y, -y, +z, -z) of cell `cell`'s ambient cube in the atlas, for a
// volume whose block starts at x `origin` and has `cells` cells (`irradiance::atlas_texel`).
fn gx_volume_texel(origin: i32, cells: vec3<i32>, cell: vec3<i32>, face: u32) -> vec4<f32> {
    let negative = i32(face & 1u);
    let axis = i32(face >> 1u);
    let at = vec3<i32>(origin + cell.x, cell.y + negative * cells.y, cell.z + axis * cells.z);
    return textureLoad(env_irradiance, at, 0);
}

// Whether cell `cell` sees a point `offset` from its centre along axis `axis` (0..1): its reach on
// that side of the axis (both are coded in the alpha of either of the axis's texels,
// `irradiance::pack_reaches`) against the offset, softened over `tolerance`. A wall across the
// axis between them stops the cell's reach short of the point.
fn gx_volume_sees(origin: i32, cells: vec3<i32>, cell: vec3<i32>, axis: u32, offset: f32, reach_step: f32, tolerance: f32) -> f32 {
    let packed = u32(gx_volume_texel(origin, cells, cell, 2u * axis).a);
    let code = select(packed >> GX_REACH_BITS, packed & GX_REACH_MASK, offset < 0.0);
    return clamp((f32(code) * reach_step + tolerance - abs(offset)) / tolerance, 0.0, 1.0);
}

// The trilinear position along axis `axis` of a point between cells `base` and `base + 1` at
// `t`, moved toward the cell that sees it (`irradiance::visible_share`): each side weighs its
// share by whether its cell (the one nearest the point across the other axes, `near`) sees the
// point, so a wall across the axis leaves the point reading its own side's cells only.
fn gx_volume_visible_share(origin: i32, cells: vec3<i32>, near: vec3<i32>, axis: u32, t: f32, offset: f32, spacing: f32, step: vec2<f32>) -> f32 {
    if cells[axis] < 2 {
        return t;
    }
    var upper = near;
    upper[axis] = near[axis] + 1;
    let lower_sees = gx_volume_sees(origin, cells, near, axis, offset, step.x, step.y);
    let upper_sees = gx_volume_sees(origin, cells, upper, axis, offset - spacing, step.x, step.y);
    let low = (1.0 - t) * max(lower_sees, GX_VOLUME_HIDDEN_WEIGHT);
    let high = t * max(upper_sees, GX_VOLUME_HIDDEN_WEIGHT);
    return high / max(low + high, 1e-12);
}

// A volume's irradiance (over pi) at `p` for unit normal `n` (`irradiance::grid_irradiance`): the
// point is offset along its normal (the row's z) and placed among the cell centres, and the three
// ambient-cube faces toward the normal are read with the sampler's trilinear filter, weighted by
// the normal's squared components (Bevy v0.20 `irradiance_volume.wgsl`, MIT OR Apache-2.0: each
// face's texels kept inside its sub-block). With leak control (desktop and web) the position is
// first moved along each axis toward the side whose cell sees the point (six reach loads,
// `gx_volume_visible_share`): a cell behind a wall lends the point no light. Without (phones) the
// filter blends the eight cells as they are.
fn gx_volume_irradiance(row: GxProbeRow, p: vec3<f32>, n: vec3<f32>) -> vec3<f32> {
    let cells = gx_volume_cells(row);
    let leak_control = ((u32(row.capture_intensity.x) >> 18u) & 1u) == 1u;
    let origin = i32(-row.max_layer.w) - 1;
    let lo = row.min_blend.xyz;
    let spacing = (row.max_layer.xyz - lo) / vec3<f32>(cells);
    let at = p + n * row.capture_intensity.z;
    var grid = clamp((at - lo) / spacing - 0.5, vec3<f32>(0.0), vec3<f32>(cells - 1));
    if leak_control {
        let base = min(vec3<i32>(floor(grid)), max(cells - 2, vec3<i32>(0)));
        let t = grid - vec3<f32>(base);
        let near = base + vec3<i32>(t > vec3<f32>(0.5));
        // How far the point is from the base cells' centres along each axis.
        let offset = at - (lo + (vec3<f32>(base) + 0.5) * spacing);
        let step = vec2<f32>(GX_REACH_DIAGONALS * length(spacing) / f32(GX_REACH_MASK), GX_VOLUME_REACH_TOLERANCE * min(spacing.x, min(spacing.y, spacing.z)));
        let moved = vec3<f32>(
            gx_volume_visible_share(origin, cells, vec3<i32>(base.x, near.y, near.z), 0u, t.x, offset.x, spacing.x, step),
            gx_volume_visible_share(origin, cells, vec3<i32>(near.x, base.y, near.z), 1u, t.y, offset.y, spacing.y, step),
            gx_volume_visible_share(origin, cells, vec3<i32>(near.x, near.y, base.z), 2u, t.z, offset.z, spacing.z, step),
        );
        grid = vec3<f32>(base) + moved;
    }
    let size = vec3<f32>(textureDimensions(env_irradiance));
    let texel = vec3<f32>(f32(origin), 0.0, 0.0) + grid + 0.5;
    let half = f32(cells.y);
    let third = f32(cells.z);
    let nn = n * n;
    let x = textureSampleLevel(env_irradiance, env_sampler, (texel + vec3<f32>(0.0, select(0.0, half, n.x < 0.0), 0.0)) / size, 0.0).rgb;
    let y = textureSampleLevel(env_irradiance, env_sampler, (texel + vec3<f32>(0.0, select(0.0, half, n.y < 0.0), third)) / size, 0.0).rgb;
    let z = textureSampleLevel(env_irradiance, env_sampler, (texel + vec3<f32>(0.0, select(0.0, half, n.z < 0.0), 2.0 * third)) / size, 0.0).rgb;
    return x * nn.x + y * nn.y + z * nn.z;
}
