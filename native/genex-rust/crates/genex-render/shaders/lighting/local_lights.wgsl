// Lighting chunk: local lights. Reads the forward bindings `frame` (`counts.x` lights) and
// `lights`; the binned walk also reads the binned tables and the sun chunk's fragment context
// (`gx_sun_context.pixel`, the render-target pixel), and a shadowed spot (RQ6.5) `shadow_map`,
// `shadow_sampler` and the sun chunk's `gx_sun_cascades`.
//
// Two paths (RQ6.2):
// - legacy (the `off` preset and the `clustered` switch off, `lights::legacy_lights`): every light
//   of the light table in table order, with the range falloff of before RQ6,
//   saturate(1 - d / r)^2 / max(d^2, 0.01) (`lights::legacy_falloff`), a spot's through its cone.
// - binned (RQ6.2's forward seam): points and spots of the depth-sorted local-light table with the
//   windowed inverse-square falloff (`gx_light_window`) and the smooth cone (`gx_spot_cone`),
//   walking the fragment's tile mask intersected with its z-bin's index range in light-index order
//   (`gx_light_tile`, `gx_light_zbin`, `gx_light_word_bits`; `cluster::lights_at` is the
//   CPU mirror of the walk). The helpers below take values, not bindings, so the chunk compiles in
//   the forward pass and in the Level-2 v2 prelude alike.

// The shortest distance the windowed falloff divides by (`lights::LIGHT_MIN_DISTANCE`).
const GX_LIGHT_MIN_DISTANCE: f32 = 0.01;
// The narrowest cone transition (`lights::SPOT_MIN_TRANSITION`): inner = outer is a hard edge.
const GX_SPOT_MIN_TRANSITION: f32 = 1e-4;

// The windowed inverse-square falloff (Frostbite, Lagarde and de Rousiers 2014; UE4, Karis 2013):
// saturate(1 - (d / r)^4)^2 / max(d^2, 0.01^2). Exactly 0 from the range on, so binning a light by
// its range never culls light it casts (`lights::windowed_falloff`).
fn gx_light_window(distance: f32, range: f32) -> f32 {
    let ratio = distance / range;
    let ratio2 = ratio * ratio;
    let window = saturate(1.0 - ratio2 * ratio2);
    return window * window / max(distance * distance, GX_LIGHT_MIN_DISTANCE * GX_LIGHT_MIN_DISTANCE);
}

// A light's cone towards a surface in unit direction `to_light` from it: 1 for a point; for a spot
// saturate((cos theta - cos outer) / max(cos inner - cos outer, 1e-4))^2, 1 inside the inner
// half-angle and 0 past the outer one (`lights::spot_cone`).
fn gx_spot_cone(ext: LightExt, to_light: vec3<f32>) -> f32 {
    if ext.params.y != f32(GX_LIGHT_SPOT) {
        return 1.0;
    }
    let cos_angle = dot(-to_light, ext.spot.xyz);
    let t = saturate((cos_angle - ext.spot.w) / max(ext.params.x - ext.spot.w, GX_SPOT_MIN_TRANSITION));
    return t * t;
}

// Tiles across the spot shadow atlas layer (`spot_shadow::SPOT_ATLAS_TILES`).
const GX_SPOT_ATLAS_TILES: u32 = 2u;
// How far a spot shadow's receiver is pulled along its normal, in the spot map's texels at the
// receiver's distance (against acne on surfaces the spot grazes).
const GX_SPOT_NORMAL_OFFSET_TEXELS: f32 = 1.5;

// How much of shadow slot `slot`'s spot reaches `s` (RQ6.5): a 3x3 PCF of bilinear comparison taps
// in the slot's tile of the spot atlas, the shared shadow array's layer after the drawn cascades.
// The slot's light view-projection follows the light rows in `light_ext`; one texel's world size
// at the receiver comes from the matrix (row 0's length is the projection's 1 / tan(half fov)).
// Outside the map (behind the spot, past its range) the spot is not shadowed: its cone and window
// end there.
fn gx_spot_shadow(s: Surface, light: Light, slot: u32) -> f32 {
    let base = GX_LIGHT_EXT_VEC4S * frame.counts.x + GX_SPOT_MATRIX_VEC4S * slot;
    let m = mat4x4<f32>(light_ext[base], light_ext[base + 1u], light_ext[base + 2u], light_ext[base + 3u]);
    let side = f32(textureDimensions(shadow_map).x);
    let tile = floor(side / f32(GX_SPOT_ATLAS_TILES));
    let focal = length(vec3<f32>(m[0].x, m[1].x, m[2].x));
    let texel = 2.0 * distance(light.position_range.xyz, s.world_pos) / max(focal * tile, 1e-6);
    let clip = m * vec4<f32>(s.world_pos + s.geometric * (texel * GX_SPOT_NORMAL_OFFSET_TEXELS), 1.0);
    if clip.w <= 0.0 {
        return 1.0;
    }
    let ndc = clip.xyz / clip.w;
    if abs(ndc.x) > 1.0 || abs(ndc.y) > 1.0 || ndc.z > 1.0 {
        return 1.0;
    }
    let corner = vec2<f32>(f32(slot % GX_SPOT_ATLAS_TILES), f32(slot / GX_SPOT_ATLAS_TILES)) * tile;
    let at = corner + vec2<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5) * tile;
    // Every bilinear tap stays inside the tile: a neighbour's map is never read.
    let low = corner + vec2<f32>(1.0);
    let high = corner + vec2<f32>(tile - 1.0);
    let layer = i32(gx_sun_cascades());
    var lit = 0.0;
    for (var y = -1; y <= 1; y++) {
        for (var x = -1; x <= 1; x++) {
            let tap = clamp(at + vec2<f32>(f32(x), f32(y)), low, high) / side;
            lit += textureSampleCompareLevel(shadow_map, shadow_sampler, tap, layer, ndc.z);
        }
    }
    return lit / 9.0;
}

// The light of one local light (its table row and extension row) on `s` on the binned path,
// unshadowed.
fn gx_local_light(s: Surface, light: Light, ext: LightExt) -> vec3<f32> {
    let to_light = light.position_range.xyz - s.world_pos;
    let distance = max(length(to_light), 0.0001);
    let l = to_light / distance;
    let attenuation = gx_light_window(distance, light.position_range.w) * gx_spot_cone(ext, l);
    if attenuation <= 0.0 {
        return vec3<f32>(0.0);
    }
    return shade(s.n, s.v, l, light.color.rgb * attenuation, s.albedo, s.metallic, s.roughness);
}

// The tile of the binning grid (`LightBinParams::grid`) render-target pixel `pixel` falls in.
fn gx_light_tile(pixel: vec2<f32>, grid: vec4<u32>) -> u32 {
    let last = max(grid.xy, vec2<u32>(1u)) - vec2<u32>(1u);
    let tile = min(vec2<u32>(max(pixel, vec2<f32>(0.0)) / f32(max(grid.w, 1u))), last);
    return tile.y * grid.x + tile.x;
}

// The z-bin view depth `view_depth` falls in (`LightBinParams::depth`; `cluster::zbin_of`),
// clamped to the first and last bins: a fragment nearer or farther than every light lands in a bin
// whose lights reach it with a window of 0.
fn gx_light_zbin(view_depth: f32, depth: vec4<u32>) -> u32 {
    let slot = (view_depth - bitcast<f32>(depth.z)) * bitcast<f32>(depth.w);
    return min(u32(max(slot, 0.0)), max(depth.x, 1u) - 1u);
}

// The bits of mask word `word` (sorted lights 32 word .. 32 word + 31) inside the z-bin's index
// range `lowest..=highest`; the walk visits words lowest / 32 ..= highest / 32 only.
fn gx_light_word_bits(word: u32, lowest: u32, highest: u32) -> u32 {
    let first = word * 32u;
    var bits = 0xffffffffu;
    if lowest > first {
        bits &= 0xffffffffu << (lowest - first);
    }
    if highest < first + 31u {
        bits &= 0xffffffffu >> (first + 31u - highest);
    }
    return bits;
}

// `color` plus the binned local lights on `s`: the lights of the fragment's tile mask intersected
// with its z-bin's index range, in light-index order (`cluster::lights_at`). The tile comes from
// the sun chunk's fragment context (the pixel), the z-bin from the view depth.
fn gx_binned_local_lights(color: vec3<f32>, s: Surface) -> vec3<f32> {
    let grid = vec4<u32>(light_zbins[0], light_zbins[1], light_zbins[2], light_zbins[3]);
    let depth = vec4<u32>(light_zbins[4], light_zbins[5], light_zbins[6], light_zbins[7]);
    let view_depth = dot(s.world_pos - frame.camera_pos.xyz, frame.camera_forward.xyz);
    let zbin = light_zbins[GX_LIGHT_BIN_HEADER_WORDS + gx_light_zbin(view_depth, depth)];
    let lowest = zbin & 0xffffu;
    let highest = zbin >> GX_ZBIN_INDEX_BITS;
    var lit = color;
    if lowest > highest {
        return lit;
    }
    let base = gx_light_tile(gx_sun_context.pixel, grid) * grid.z;
    for (var word = lowest / 32u; word <= highest / 32u; word++) {
        var bits = light_tiles[base + word] & gx_light_word_bits(word, lowest, highest);
        while bits != 0u {
            let i = word * 32u + firstTrailingBit(bits);
            bits &= bits - 1u;
            let ext = LightExt(light_ext[i * GX_LIGHT_EXT_VEC4S], light_ext[i * GX_LIGHT_EXT_VEC4S + 1u]);
            var light = gx_local_light(s, lights[i], ext);
            // A spot holding a shadow slot, where it reaches: through its map (the BRDF is linear
            // in the light's radiance).
            if ext.params.z >= 0.0 && any(light > vec3<f32>(0.0)) {
                light *= gx_spot_shadow(s, lights[i], u32(ext.params.z));
            }
            lit += light;
        }
    }
    return lit;
}

// Whether the frame's lights may come binned (the bin header's word 5 then says whether they do):
// the forward pass compiles the binned path out where the quality's clustered switch is off
// (RX.R1); every other module keeps the runtime choice.
override GX_BINNED_LIGHTS: bool = true;

// `color` plus every local light's light on `s`: the binned walk when the frame binned its lights
// (the bin header's light count), else the legacy loop (the `clustered` switch off, the `off`
// quality): every light of the light table in table order, with the range falloff of before RQ6,
// a spot's through its smooth cone (`light_ext`'s row for row extension; never shadowed).
fn gx_local_lights(color: vec3<f32>, s: Surface) -> vec3<f32> {
    if GX_BINNED_LIGHTS && light_zbins[5] != 0u {
        return gx_binned_local_lights(color, s);
    }
    var lit = color;
    for (var i = 0u; i < frame.counts.x; i++) {
        let light = lights[i];
        let to_light = light.position_range.xyz - s.world_pos;
        let distance = max(length(to_light), 0.0001);
        let falloff = clamp(1.0 - distance / light.position_range.w, 0.0, 1.0);
        var radiance = light.color.rgb * falloff * falloff / max(distance * distance, 0.01);
        // Only a table holding a spot reads the extension rows (the legacy frame's bin header
        // word 4, `cluster::LEGACY_SPOTS_WORD`; uniform), so a frame of point lights loops exactly
        // as before RQ6.
        if light_zbins[4] != 0u {
            let ext = LightExt(light_ext[i * GX_LIGHT_EXT_VEC4S], light_ext[i * GX_LIGHT_EXT_VEC4S + 1u]);
            if ext.params.y == f32(GX_LIGHT_SPOT) {
                radiance *= gx_spot_cone(ext, to_light / distance);
            }
        }
        lit += shade(s.n, s.v, to_light / distance, radiance, s.albedo, s.metallic, s.roughness);
    }
    return lit;
}
