// Terrain shading (renderer pass 2 A.7): the world pass's, the prepass's and the motion
// prepass's entry points, concatenated after the forward module's sources (`terrain::TERRAIN`), so
// the terrain reads the forward frame group (group 0), the pass view (group 1) and its own group
// (group 2) and shades through the same lighting chunks as every built-in surface: the sun with
// its cascades and contact shadows, the sky and the reflection probes with ambient occlusion, the
// local lights, the aerial perspective and the fog.
//
// The surface is made per pixel, never per vertex, so it does not change with the level of
// detail: the normal from the baked normal table (bilinear), the layers from the four control
// texels around the pixel (after Terrain3D's index map, ideas only: base, overlay and blend per texel, spread by
// the bilinear weights), each layer sampled from the renderer's material arrays with explicit
// gradients and blended by weight and height (Mishkinis 2013), hex-tiled on desktop high and
// ultra (`GX_TERRAIN_DETILE`, hextile.wgsl).
//
// The prepass and the motion prepass take no screen derivative (GA1). Far away a 2x2 pixel quad
// spans several sub-pixel triangles, and a derivative across it came out differently from one run
// to the next on Apple GPUs: the pyramid level the prepass picked moved, its far-ground normals by
// 1-4 half-float steps, and a settled capture changed by a level on tens of pixels. Their pixel's
// steps across the ground come from the camera instead (`gx_terrain_steps`), on the plane of the
// vertices' mean normal. The world pass's shading keeps its screen derivatives: worked out from
// the camera there they cost medium's 1440p frame 0.05-0.1 ms past the terrain's 0.8 ms budget.

// Whether the layers are hex-tiled (`TerrainQuality::detile`): three taps per texture.
override GX_TERRAIN_DETILE: bool = false;

// The most layers one pixel blends: the four control texels around it name at most eight.
const GX_TERRAIN_TAPS: u32 = 8u;
// A layer weighing less than this at a pixel is not sampled.
const GX_TERRAIN_MIN_WEIGHT: f32 = 0.002;
// The least upward part of a pixel's plane (a height field's normals point up).
const GX_TERRAIN_PLANE_UP_MIN: f32 = 1e-3;
// A plane seen this close to edge on draws its pixel as covering the whole pyramid.
const GX_TERRAIN_EDGE_ON: f32 = 1e-30;
// A pixel's step edge on, metres.
const GX_TERRAIN_STEP_MAX: f32 = 1e15;

struct GxTerrainOut {
    @builtin(position) @invariant clip: vec4<f32>,
    @location(0) world_pos: vec3<f32>,
    // The ground's mean normal around the vertex (`gx_terrain_plane`).
    @location(1) plane: vec3<f32>,
}

@vertex
fn vs_terrain(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> GxTerrainOut {
    let row = gx_terrain_rows[instance];
    let world = gx_terrain_vertex(row, vertex, frame.camera_pos.xyz);
    var out: GxTerrainOut;
    out.clip = gx_clip_position(frame.view_proj, vec4<f32>(world, 1.0), frame.jitter.xy);
    out.world_pos = world;
    out.plane = gx_terrain_plane(row, world);
    return out;
}

// The fractional sample position of world point `world`.
fn gx_terrain_texel_of(world: vec3<f32>) -> vec2<f32> {
    return (world.xz - gx_terrain.origin.xy) * gx_terrain.origin.w;
}

// The vector of word `word` of the normal pyramid (`terrain::unpack_normal`).
fn gx_terrain_normal_word(word: u32) -> vec3<f32> {
    let bits = vec3<u32>(word << 22u, word << 12u, word << 2u);
    return vec3<f32>(bitcast<vec3<i32>>(bits) >> vec3<u32>(22u)) / 511.0;
}

// Texel (`x`, `z`) of normal pyramid level `level`, of `size` texels, clamped onto it.
fn gx_terrain_normal_texel(level: u32, size: vec2<u32>, x: u32, z: u32) -> vec3<f32> {
    let first = gx_terrain.normal_levels[level / 4u][level % 4u];
    return gx_terrain_normal_word(gx_terrain_maps[first + min(z, size.y - 1u) * size.x + min(x, size.x - 1u)]);
}

// Level `level`'s mean normal at fractional sample position `p`, bilinear between its texels
// (texel j of level k averages samples j 2^k .. (j + 1) 2^k - 1).
fn gx_terrain_normal_level(level: u32, p: vec2<f32>) -> vec3<f32> {
    let scale = f32(1u << level);
    let size = (gx_terrain.size.xy + vec2<u32>((1u << level) - 1u)) >> vec2<u32>(level);
    let t = clamp((p + 0.5) / scale - 0.5, vec2<f32>(0.0), vec2<f32>(size - vec2<u32>(1u)));
    let base = floor(t);
    let f = t - base;
    let i = vec2<u32>(base);
    let near = mix(gx_terrain_normal_texel(level, size, i.x, i.y), gx_terrain_normal_texel(level, size, i.x + 1u, i.y), f.x);
    let far = mix(gx_terrain_normal_texel(level, size, i.x, i.y + 1u), gx_terrain_normal_texel(level, size, i.x + 1u, i.y + 1u), f.x);
    return mix(near, far, f.y);
}

// The ground's mean normal over a pixel at fractional sample position `p` covering `footprint`
// samples (trilinear over the pyramid): unnormalized, its length how much the normals under the
// pixel agree (1: they all do).
fn gx_terrain_normal(p: vec2<f32>, footprint: f32) -> vec3<f32> {
    let top = f32(max(gx_terrain.size.w, 1u) - 1u);
    let lod = clamp(log2(max(footprint, 1.0)), 0.0, top);
    let level = u32(floor(lod));
    let next = min(level + 1u, u32(top));
    return mix(gx_terrain_normal_level(level, p), gx_terrain_normal_level(next, p), lod - f32(level));
}

// The ground's mean normal around a vertex of `row` at world point `world` (unnormalized): the
// pyramid at the node's level, whose texels average the samples between its vertices. Its
// interpolated value is the plane a pixel's steps are measured on.
fn gx_terrain_plane(row: GxTerrainRow, world: vec3<f32>) -> vec3<f32> {
    let level = min(row.lod, max(gx_terrain.size.w, 1u) - 1u);
    return gx_terrain_normal_level(level, gx_terrain_texel_of(world));
}

// A pixel's step at world point `world` across the screen (column 0) and down it (column 1), in
// world x and z, on the plane through `world` facing `plane` (`gx_terrain_plane`, interpolated):
// what a screen derivative of the world position measures on a flat triangle, worked out from the
// projection (`frame.view_proj`, perspective or orthographic) and the render pixel's size in NDC
// (`gx_terrain.pixel`), so it depends on this pixel alone. Edge on (the horizon) it is huge.
fn gx_terrain_steps(world: vec3<f32>, plane: vec3<f32>) -> mat2x2<f32> {
    let m = frame.view_proj;
    let clip = m * vec4<f32>(world, 1.0);
    let n = normalize(plane);
    // The plane's rise per metre along world x and along world z (a height field faces up).
    let up = max(n.y, GX_TERRAIN_PLANE_UP_MIN);
    let along_x = vec3<f32>(1.0, -n.x / up, 0.0);
    let along_z = vec3<f32>(0.0, -n.z / up, 1.0);
    // NDC x and y move by (row * w - clip * row 3) / w^2 along a world direction (rows 0, 1, 3).
    let r0 = vec3<f32>(m[0][0], m[1][0], m[2][0]);
    let r1 = vec3<f32>(m[0][1], m[1][1], m[2][1]);
    let r3 = vec3<f32>(m[0][3], m[1][3], m[2][3]);
    let w2 = clip.w * clip.w;
    let a = (vec2<f32>(dot(r0, along_x), dot(r1, along_x)) * clip.w - clip.xy * dot(r3, along_x)) / w2;
    let b = (vec2<f32>(dot(r0, along_z), dot(r1, along_z)) * clip.w - clip.xy * dot(r3, along_z)) / w2;
    let det = a.x * b.y - b.x * a.y;
    if abs(det) < GX_TERRAIN_EDGE_ON {
        return mat2x2<f32>(vec2<f32>(GX_TERRAIN_STEP_MAX, 0.0), vec2<f32>(0.0, GX_TERRAIN_STEP_MAX));
    }
    // The inverse of (a b), one pixel along NDC x, then one along NDC y.
    let across = vec2<f32>(b.y, -a.y) * (gx_terrain.pixel.x / det);
    let down = vec2<f32>(-b.x, a.x) * (gx_terrain.pixel.y / det);
    return mat2x2<f32>(across, down);
}

// How many samples a pixel at fractional sample position `p` covers by its screen derivatives
// (the forward pass's shading; call it in uniform control flow).
fn gx_terrain_screen_footprint(p: vec2<f32>) -> f32 {
    let dx = dpdx(p);
    let dy = dpdy(p);
    return max(length(dx), length(dy));
}

// How many samples a pixel's `steps` (`gx_terrain_steps`) cover: its longer side.
fn gx_terrain_footprint(steps: mat2x2<f32>) -> f32 {
    return max(length(steps[0]), length(steps[1])) * gx_terrain.origin.w;
}

// One layer's texel at a pixel.
struct GxTerrainTexel {
    albedo: vec3<f32>,
    height: f32,
    // Tangent-space normal xy (u along +x, v along +z).
    normal: vec2<f32>,
    roughness: f32,
    occlusion: f32,
}

// Layer `index` at world `xz` with the footprint `dx`, `dy` (world xz per pixel).
fn gx_terrain_layer(index: u32, xz: vec2<f32>, dx: vec2<f32>, dy: vec2<f32>) -> GxTerrainTexel {
    let layer = gx_terrain.layers[index];
    let scale = layer.tint_scale.w;
    let uv = xz * scale;
    let uv_dx = dx * scale;
    let uv_dy = dy * scale;
    let has_color = layer.textures.x != NO_TEXTURE;
    let has_data = layer.textures.y != NO_TEXTURE;
    var color = vec4<f32>(1.0, 1.0, 1.0, 0.5);
    var data = vec4<f32>(0.5, 0.5, 1.0, 1.0);
    if GX_TERRAIN_DETILE {
        let tiles = gx_hex_tiles(uv);
        var c0 = color;
        var c1 = color;
        var c2 = color;
        if has_color {
            c0 = gx_class_texel(true, layer.textures.x, tiles.uv0, gx_hex_turn(uv_dx, tiles.rot0), gx_hex_turn(uv_dy, tiles.rot0));
            c1 = gx_class_texel(true, layer.textures.x, tiles.uv1, gx_hex_turn(uv_dx, tiles.rot1), gx_hex_turn(uv_dy, tiles.rot1));
            c2 = gx_class_texel(true, layer.textures.x, tiles.uv2, gx_hex_turn(uv_dx, tiles.rot2), gx_hex_turn(uv_dy, tiles.rot2));
        }
        let w = gx_hex_blend(tiles, c0.rgb, c1.rgb, c2.rgb);
        color = c0 * w.x + c1 * w.y + c2 * w.z;
        if has_data {
            let d0 = gx_class_texel(false, layer.textures.y, tiles.uv0, gx_hex_turn(uv_dx, tiles.rot0), gx_hex_turn(uv_dy, tiles.rot0));
            let d1 = gx_class_texel(false, layer.textures.y, tiles.uv1, gx_hex_turn(uv_dx, tiles.rot1), gx_hex_turn(uv_dy, tiles.rot1));
            let d2 = gx_class_texel(false, layer.textures.y, tiles.uv2, gx_hex_turn(uv_dx, tiles.rot2), gx_hex_turn(uv_dy, tiles.rot2));
            let n0 = gx_hex_unturn(d0.rg * 2.0 - 1.0, tiles.rot0);
            let n1 = gx_hex_unturn(d1.rg * 2.0 - 1.0, tiles.rot1);
            let n2 = gx_hex_unturn(d2.rg * 2.0 - 1.0, tiles.rot2);
            let n = n0 * w.x + n1 * w.y + n2 * w.z;
            data = vec4<f32>(n * 0.5 + 0.5, d0.ba * w.x + d1.ba * w.y + d2.ba * w.z);
        }
    } else {
        if has_color {
            color = gx_class_texel(true, layer.textures.x, uv, uv_dx, uv_dy);
        }
        if has_data {
            data = gx_class_texel(false, layer.textures.y, uv, uv_dx, uv_dy);
        }
    }
    var out: GxTerrainTexel;
    out.albedo = color.rgb * layer.tint_scale.rgb;
    out.height = color.a;
    out.normal = (data.rg * 2.0 - 1.0) * layer.params.y;
    out.roughness = select(layer.params.x, data.b * layer.params.x, has_data);
    out.occlusion = data.a;
    return out;
}

// A value in 0..1 per integer lattice point (an integer hash: the same bits on every GPU).
fn gx_terrain_hash(p: vec2<i32>) -> f32 {
    var h = (bitcast<u32>(p.x) * 0x27d4eb2du) ^ (bitcast<u32>(p.y) * 0x165667b1u);
    h = (h ^ (h >> 15u)) * 0x85ebca6bu;
    h = h ^ (h >> 13u);
    return f32(h & 0xffffffu) / 16777215.0;
}

// Smooth value noise in 0..1 (the macro variation).
fn gx_terrain_noise(p: vec2<f32>) -> f32 {
    let i = vec2<i32>(floor(p));
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    let a = gx_terrain_hash(i);
    let b = gx_terrain_hash(i + vec2<i32>(1, 0));
    let c = gx_terrain_hash(i + vec2<i32>(0, 1));
    let d = gx_terrain_hash(i + vec2<i32>(1, 1));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// The distinct layers one pixel blends and their weights, gathered by `gx_terrain_gather`.
var<private> gx_terrain_ids: array<u32, 8>;
var<private> gx_terrain_weights: array<f32, 8>;
var<private> gx_terrain_taps: u32;

// Add `weight` of layer `id` to the pixel's layers (a new layer when it has room).
fn gx_terrain_gather(id: u32, weight: f32) {
    for (var t = 0u; t < gx_terrain_taps; t++) {
        if gx_terrain_ids[t] == id {
            gx_terrain_weights[t] += weight;
            return;
        }
    }
    if gx_terrain_taps < GX_TERRAIN_TAPS {
        gx_terrain_ids[gx_terrain_taps] = id;
        gx_terrain_weights[gx_terrain_taps] = weight;
        gx_terrain_taps += 1u;
    }
}

// The gathered layers at world `xz` (footprint `dx`, `dy`) blended by weight and height: each
// layer's height plus its weight against the highest's, within the blend depth. Sums before the
// division by `total`.
struct GxTerrainBlend {
    albedo: vec3<f32>,
    normal: vec2<f32>,
    roughness: f32,
    occlusion: f32,
    total: f32,
}

// Add `b` of `texel` to `blend`.
fn gx_terrain_add(blend: ptr<function, GxTerrainBlend>, texel: GxTerrainTexel, b: f32) {
    (*blend).albedo += texel.albedo * b;
    (*blend).normal += texel.normal * b;
    (*blend).roughness += texel.roughness * b;
    (*blend).occlusion += texel.occlusion * b;
    (*blend).total += b;
}

// The height blend of the gathered layers (`gx_terrain_gather`). Hex-tiled (three taps a
// texture) the texels are held between the two passes; plain, the second pass samples each layer
// again from the warm cache: held there, the eight texels spilled out of registers and the
// terrain cost 0.82-0.87 ms over the mesh ground at medium 1440p against 0.71-0.75 sampled twice
// (GA1, same picture: the same samples summed in the same order).
fn gx_terrain_blend(xz: vec2<f32>, dx: vec2<f32>, dy: vec2<f32>) -> GxTerrainBlend {
    let taps = gx_terrain_taps;
    var blend = GxTerrainBlend(vec3<f32>(0.0), vec2<f32>(0.0), 0.0, 0.0, 0.0);
    var top = -1e9;
    if GX_TERRAIN_DETILE {
        var texels: array<GxTerrainTexel, 8>;
        for (var t = 0u; t < taps; t++) {
            if gx_terrain_weights[t] > GX_TERRAIN_MIN_WEIGHT {
                texels[t] = gx_terrain_layer(gx_terrain_ids[t], xz, dx, dy);
                top = max(top, texels[t].height + gx_terrain_weights[t]);
            }
        }
        for (var t = 0u; t < taps; t++) {
            if gx_terrain_weights[t] > GX_TERRAIN_MIN_WEIGHT {
                gx_terrain_add(&blend, texels[t], max(texels[t].height + gx_terrain_weights[t] - (top - gx_terrain.blend.x), 0.0));
            }
        }
        return blend;
    }
    var heights: array<f32, 8>;
    for (var t = 0u; t < taps; t++) {
        if gx_terrain_weights[t] > GX_TERRAIN_MIN_WEIGHT {
            heights[t] = gx_terrain_layer(gx_terrain_ids[t], xz, dx, dy).height;
            top = max(top, heights[t] + gx_terrain_weights[t]);
        }
    }
    for (var t = 0u; t < taps; t++) {
        if gx_terrain_weights[t] > GX_TERRAIN_MIN_WEIGHT {
            let texel = gx_terrain_layer(gx_terrain_ids[t], xz, dx, dy);
            gx_terrain_add(&blend, texel, max(heights[t] + gx_terrain_weights[t] - (top - gx_terrain.blend.x), 0.0));
        }
    }
    return blend;
}

// The terrain's surface at world point `world`, its view direction still unset (the caller's,
// as `gx_surface`'s); sets `gx_material_ao` to the blended occlusion. Call it in uniform control
// flow: its derivatives are taken here.
fn gx_terrain_surface(world: vec3<f32>) -> Surface {
    let p = gx_terrain_texel_of(world);
    let mean = gx_terrain_normal(p, gx_terrain_screen_footprint(p));
    // The normals under the pixel disagree by as much as their mean falls short of unit length.
    let agreement = length(mean);
    let geometric = mean / max(agreement, 1e-4);
    let lod_scale = exp2(gx_texture_lod_bias());
    let dx = dpdx(world.xz) * lod_scale;
    let dy = dpdy(world.xz) * lod_scale;
    let n_dx = dpdx(geometric);
    let n_dy = dpdy(geometric);
    // The four control texels around the pixel, their bilinear weights spread over each one's
    // base and overlay, gathered per distinct layer.
    let last = vec2<f32>(gx_terrain.size.xy - vec2<u32>(1u));
    let q = clamp(p, vec2<f32>(0.0), last);
    let cell = floor(q);
    let f = q - cell;
    let i = vec2<u32>(cell);
    gx_terrain_taps = 0u;
    var wet = 0.0;
    let layers = max(gx_terrain.counts.x, 1u);
    for (var c = 0u; c < 4u; c++) {
        let corner = vec2<u32>(c & 1u, c >> 1u);
        let at = i + corner;
        let word = gx_terrain_maps[gx_terrain.size.z + gx_terrain_index(at.x, at.y)];
        let along = select(1.0 - f, f, corner == vec2<u32>(1u));
        let w = along.x * along.y;
        let overlay = f32((word >> 10u) & 0xffu) / 255.0;
        wet += w * f32((word >> 18u) & 0xffu) / 255.0;
        gx_terrain_gather(min(word & 31u, layers - 1u), w * (1.0 - overlay));
        gx_terrain_gather(min((word >> 5u) & 31u, layers - 1u), w * overlay);
    }
    // Each layer that weighs anything, then the height blend: a layer's height plus its weight
    // against the highest's, within the blend depth.
    let blended = gx_terrain_blend(world.xz, dx, dy);
    let inv = 1.0 / max(blended.total, 1e-5);
    var albedo = blended.albedo * inv;
    let normal_ts = blended.normal * inv;
    var roughness = blended.roughness * inv;
    let occlusion = blended.occlusion * inv;
    // A broad brightness variation over every layer (no two tiles the same), then the wetness:
    // darker and glossier.
    albedo *= 1.0 + gx_terrain.look.x * (2.0 * gx_terrain_noise(world.xz * gx_terrain.look.y) - 1.0);
    albedo *= 1.0 - gx_terrain.look.z * wet;
    roughness = mix(roughness, gx_terrain.look.w, wet);
    gx_material_ao = occlusion;
    // The world-aligned layers' tangent frame: u along +x, v along +z (GL-style normal maps point
    // their green away from v as WebGPU samples it).
    let tangent = normalize(vec3<f32>(1.0, 0.0, 0.0) - geometric * geometric.x);
    let bitangent = -normalize(cross(tangent, geometric));
    let z = sqrt(max(1.0 - dot(normal_ts, normal_ts), 0.0));
    let n = normalize(tangent * normal_ts.x + bitangent * normal_ts.y + geometric * z);
    // The shading normal's own change across the pixel (its layers' normal maps included), in
    // uniform control flow: the ground widens its highlight by it on every HDR preset, so a far
    // slope facing a low sun does not sparkle without TAA to average it.
    let s_dx = dpdx(n);
    let s_dy = dpdy(n);
    var rough = gx_toksvig_roughness(clamp(roughness, GX_ROUGHNESS_FLOOR, 1.0), agreement);
    if GX_SCENE_HDR {
        rough = gx_filtered_roughness(rough, s_dx, s_dy);
    }
    if GX_SPECULAR_AA && GX_SCENE_HDR {
        rough = gx_filtered_roughness(rough, n_dx, n_dy);
    }
    return Surface(world, geometric, n, vec3<f32>(0.0), albedo, 1.0, 0.0, rough);
}

// The terrain's lit colour: ambient, the sun, the local lights, then the air and the fog, as the
// forward pass's `surface` lights a built-in surface.
@fragment
fn fs_terrain(in: GxTerrainOut) -> @location(0) vec4<f32> {
    gx_sun_shadow_context(in.clip.xy, frame.shadow_counts.z, frame.shadow_soft.y);
    gx_sun_shadow_end_fade(frame.shadow_soft.z);
    var s = gx_terrain_surface(in.world_pos);
    s.v = normalize(frame.camera_pos.xyz - in.world_pos);
    var sun = normalize(frame.sun_dir.xyz);
    if GX_SCENE_HDR {
        sun = gx_sun_area_direction(sun, frame.sun_dir.w, s.n, s.v);
    }
    var color = gx_ambient(s);
    color += gx_sun(s, sun);
    color = gx_local_lights(color, s);
    color = gx_forward_fog(color, s.world_pos);
    return vec4<f32>(gx_encode_ldr(color), 1.0);
}

// The prepass: the terrain's depth and its per-pixel normal.
@fragment
fn fs_terrain_prepass(in: GxTerrainOut) -> @location(0) vec2<f32> {
    let p = gx_terrain_texel_of(in.world_pos);
    let footprint = gx_terrain_footprint(gx_terrain_steps(in.world_pos, in.plane));
    return gx_oct_encode(normalize(gx_terrain_normal(p, footprint)));
}

// --- The motion prepass (RQ5.6): group 3 is the motion node's group (`motion::MotionNode`); the
// terrain is still, so its motion is the camera's alone and it always has history.

// Mirrors `motion::GpuMotionFrame` (prepass.wgsl's `MotionFrame`).
struct GxTerrainMotionFrame {
    prev_view_proj: mat4x4<f32>,
    jitter: vec4<f32>,
    reproject: mat4x4<f32>,
}

@group(3) @binding(0) var<uniform> gx_terrain_motion: GxTerrainMotionFrame;

struct GxTerrainMotionOut {
    @builtin(position) @invariant clip: vec4<f32>,
    @location(0) world_pos: vec3<f32>,
    @location(1) current: vec4<f32>,
    @location(2) previous: vec4<f32>,
    @location(3) plane: vec3<f32>,
}

struct GxTerrainMotionTargets {
    @location(0) normal: vec2<f32>,
    @location(1) motion: vec2<f32>,
    @location(2) reactive: f32,
}

@vertex
fn vs_terrain_motion(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> GxTerrainMotionOut {
    let row = gx_terrain_rows[instance];
    let world = vec4<f32>(gx_terrain_vertex(row, vertex, frame.camera_pos.xyz), 1.0);
    var out: GxTerrainMotionOut;
    out.plane = gx_terrain_plane(row, world.xyz);
    out.clip = gx_clip_position(frame.view_proj, world, gx_terrain_motion.jitter.xy);
    out.world_pos = world.xyz;
    out.current = frame.view_proj * world;
    out.previous = gx_terrain_motion.prev_view_proj * world;
    return out;
}

@fragment
fn fs_terrain_motion(in: GxTerrainMotionOut) -> GxTerrainMotionTargets {
    var out: GxTerrainMotionTargets;
    let p = gx_terrain_texel_of(in.world_pos);
    let footprint = gx_terrain_footprint(gx_terrain_steps(in.world_pos, in.plane));
    out.normal = gx_oct_encode(normalize(gx_terrain_normal(p, footprint)));
    out.reactive = 0.0;
    out.motion = vec2<f32>(0.0);
    // A point behind last frame's camera has no reprojection: no motion, and no history.
    if in.previous.w <= 1e-6 || in.current.w <= 1e-6 {
        out.reactive = 1.0;
        return out;
    }
    out.motion = in.current.xy / in.current.w - in.previous.xy / in.previous.w;
    return out;
}
