// The lakeside's terrain (extension ladder level 2, material API v2): four layers, grass, soil
// (the path and the yard), sand (the beach and the lake bed) and rock (steep slopes), blended per
// pixel by the splat map the layout writes (`assets/terrain-splat.png`) and by each layer's height,
// so soil fills the hollows between grass and pebbles poke through sand, then shaded by the
// renderer's own lighting (`gx_shade_pbr`: the sun through its shadows and contact shadows, the
// lanterns and windows, the sky's light with ambient occlusion, the aerial perspective and fog).
//
// The layers come from the fetched CC0 textures (`assets/fetched/terrain-*.png`, two 2 x 2 atlases:
// colour and height; normal, roughness and occlusion). Without them (no asset cache, a fresh
// clone, CI) the renderer binds a white texel there and every layer is drawn procedurally from
// noise instead: the fallback the scene always has.

struct Terrain {
    // x: the terrain's half extent in metres; y: the water level; z: the far fade of the layers'
    // detail (metres); w: unused.
    extent: vec4<f32>,
    // Each layer's tile in metres: grass, soil, sand, rock.
    tiles: vec4<f32>,
}

@group(2) @binding(0) var<uniform> terrain: Terrain;
@group(2) @binding(1) var splat_map: texture_2d<f32>;
@group(2) @binding(2) var albedo_atlas: texture_2d<f32>;
@group(2) @binding(3) var detail_atlas: texture_2d<f32>;
@group(2) @binding(5) var linear_repeat: sampler;

const TERRAIN_LAYERS: u32 = 4u;
// How deep the height blend reaches: layers whose height plus weight fall this far below the
// highest are hidden under it.
const TERRAIN_BLEND_DEPTH: f32 = 0.18;
// The finest texel an atlas tile is read at (in tile units) and the coarsest footprint kept, so
// a tile's neighbours in the atlas never bleed into it (about mip 6 of a 1024 tile).
const TERRAIN_ATLAS_TEXEL: f32 = 1.0 / 1024.0;
const TERRAIN_ATLAS_MAX_FOOTPRINT: f32 = 1.0 / 24.0;

struct TerrainLayer {
    albedo: vec3<f32>,
    height: f32,
    normal: vec2<f32>,
    roughness: f32,
    occlusion: f32,
}

fn terrain_hash(p: vec2<f32>) -> f32 {
    var p3 = fract(vec3<f32>(p.x, p.y, p.x) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

fn terrain_noise(p: vec2<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    let a = terrain_hash(i);
    let b = terrain_hash(i + vec2<f32>(1.0, 0.0));
    let c = terrain_hash(i + vec2<f32>(0.0, 1.0));
    let d = terrain_hash(i + vec2<f32>(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn terrain_fbm(p: vec2<f32>) -> f32 {
    var sum = 0.0;
    var amplitude = 0.5;
    var q = p;
    for (var i = 0; i < 4; i++) {
        sum += amplitude * terrain_noise(q);
        q = q * 2.07 + vec2<f32>(13.1, 7.7);
        amplitude *= 0.5;
    }
    return sum / 0.9375;
}

// The tile `uv` lands on in an atlas quadrant `index`, kept off the quadrant's edges by the
// sample's own footprint.
fn terrain_atlas_uv(uv: vec2<f32>, index: u32, footprint: f32) -> vec2<f32> {
    let margin = clamp(footprint, TERRAIN_ATLAS_TEXEL, TERRAIN_ATLAS_MAX_FOOTPRINT);
    let inside = clamp(fract(uv), vec2<f32>(margin), vec2<f32>(1.0 - margin));
    return (vec2<f32>(f32(index % 2u), f32(index / 2u)) + inside) * 0.5;
}

// One layer from the fetched atlases at world `xz`: its tile read twice (the second turned and
// shifted) and mixed by `mix_by`, a broad noise, so the tile never repeats visibly.
fn terrain_fetched(index: u32, xz: vec2<f32>, dx: vec2<f32>, dy: vec2<f32>, tile: f32, mix_by: f32) -> TerrainLayer {
    let turned = mat2x2<f32>(0.8, -0.6, 0.6, 0.8);
    let scale_b = 1.0 / (tile * 1.37);
    let uv_a = xz / tile;
    let uv_b = turned * (xz * scale_b) + vec2<f32>(0.37, 0.71);
    let ax = dx / tile;
    let ay = dy / tile;
    let bx = turned * dx * scale_b;
    let by = turned * dy * scale_b;
    let wide = max(max(length(ax), length(ay)), 1e-6);
    let reach = min(wide, TERRAIN_ATLAS_MAX_FOOTPRINT);
    // Half: an atlas tile is half the atlas; shrunk where the footprint is held under the cap.
    let k = 0.5 * reach / wide;
    let a_uv = terrain_atlas_uv(uv_a, index, reach);
    let b_uv = terrain_atlas_uv(uv_b, index, reach);
    let c = mix(textureSampleGrad(albedo_atlas, linear_repeat, a_uv, ax * k, ay * k), textureSampleGrad(albedo_atlas, linear_repeat, b_uv, bx * k, by * k), mix_by);
    let d = mix(textureSampleGrad(detail_atlas, linear_repeat, a_uv, ax * k, ay * k), textureSampleGrad(detail_atlas, linear_repeat, b_uv, bx * k, by * k), mix_by);
    return TerrainLayer(c.rgb, c.a, d.rg * 2.0 - 1.0, d.b, d.a);
}

// One layer drawn from noise (the fallback without the fetched textures).
fn terrain_procedural(index: u32, xz: vec2<f32>, dry: f32) -> TerrainLayer {
    let broad = terrain_fbm(xz * 0.35 + vec2<f32>(f32(index) * 11.0, 3.0));
    let fine = terrain_fbm(xz * 3.1 + vec2<f32>(f32(index) * 5.0, 1.0));
    let grain = terrain_noise(xz * 14.0);
    var albedo: vec3<f32>;
    var roughness: f32;
    switch index {
        case 0u: {
            let lush = mix(vec3<f32>(0.055, 0.105, 0.025), vec3<f32>(0.12, 0.16, 0.04), broad);
            let golden = mix(vec3<f32>(0.20, 0.15, 0.06), vec3<f32>(0.30, 0.23, 0.09), fine);
            albedo = mix(lush, golden, dry) * (0.8 + 0.4 * grain);
            roughness = 0.92;
        }
        case 1u: {
            albedo = mix(vec3<f32>(0.13, 0.085, 0.05), vec3<f32>(0.22, 0.15, 0.09), broad) * (0.85 + 0.3 * fine);
            roughness = 0.95;
        }
        case 2u: {
            albedo = mix(vec3<f32>(0.36, 0.29, 0.19), vec3<f32>(0.48, 0.40, 0.28), broad) * (0.9 + 0.2 * grain);
            roughness = 0.88;
        }
        default: {
            albedo = mix(vec3<f32>(0.18, 0.17, 0.155), vec3<f32>(0.34, 0.32, 0.29), fine) * (0.85 + 0.3 * broad);
            roughness = 0.78;
        }
    }
    let e = 0.05;
    let slope = vec2<f32>(terrain_fbm((xz + vec2<f32>(e, 0.0)) * 3.1) - terrain_fbm((xz - vec2<f32>(e, 0.0)) * 3.1), terrain_fbm((xz + vec2<f32>(0.0, e)) * 3.1) - terrain_fbm((xz - vec2<f32>(0.0, e)) * 3.1)) / (2.0 * e);
    return TerrainLayer(albedo, fine * 0.8 + grain * 0.2, -slope * 0.08, roughness, 0.85 + 0.15 * fine);
}

fn terrain_layer(index: u32, textured: bool, xz: vec2<f32>, dx: vec2<f32>, dy: vec2<f32>, dry: f32, mix_by: f32) -> TerrainLayer {
    if textured {
        var fetched = terrain_fetched(index, xz, dx, dy, terrain.tiles[index], mix_by);
        if index == 0u {
            // The scanned forest floor carries more litter than a meadow: greened, darker in broad
            // patches, and golden where the meadow dries.
            let lush = fetched.albedo * vec3<f32>(0.68, 1.0, 0.5) * mix(0.75, 1.12, terrain_fbm(xz * 0.11));
            let golden = fetched.albedo * vec3<f32>(1.3, 1.08, 0.58);
            fetched.albedo = mix(lush, golden, dry * 0.8);
        }
        return fetched;
    }
    return terrain_procedural(index, xz, dry);
}

@fragment
fn fs_material(in: GxMaterialInV2) -> @location(0) vec4<f32> {
    let world = in.world_position;
    let xz = world.xz;
    let dx = dpdx(xz);
    let dy = dpdy(xz);
    let geometric = normalize(in.normal);
    let n_dx = dpdx(geometric);
    let n_dy = dpdy(geometric);
    let half_extent = terrain.extent.x;
    let splat = textureSampleLevel(splat_map, linear_repeat, (xz + vec2<f32>(half_extent)) / (2.0 * half_extent), 0.0);
    let textured = textureDimensions(albedo_atlas).x > 1u;
    let soil = splat.r;
    let sand = splat.g;
    let rock = splat.b;
    let dry = splat.a;
    let weights = vec4<f32>(max(1.0 - soil - sand - rock, 0.0), soil, sand, rock);
    let mix_by = smoothstep(0.3, 0.7, terrain_fbm(xz * 0.06 + vec2<f32>(1.9, 4.2)));
    var layers: array<TerrainLayer, 4>;
    var top = -1e9;
    for (var i = 0u; i < TERRAIN_LAYERS; i++) {
        if weights[i] > 0.001 {
            layers[i] = terrain_layer(i, textured, xz, dx, dy, dry, mix_by);
            top = max(top, layers[i].height + weights[i]);
        }
    }
    var albedo = vec3<f32>(0.0);
    var normal_ts = vec2<f32>(0.0);
    var roughness = 0.0;
    var occlusion = 0.0;
    var total = 0.0;
    for (var i = 0u; i < TERRAIN_LAYERS; i++) {
        let b = select(0.0, max(layers[i].height + weights[i] - (top - TERRAIN_BLEND_DEPTH), 0.0), weights[i] > 0.001);
        albedo += layers[i].albedo * b;
        normal_ts += layers[i].normal * b;
        roughness += layers[i].roughness * b;
        occlusion += layers[i].occlusion * b;
        total += b;
    }
    let inv = 1.0 / max(total, 1e-4);
    albedo *= inv;
    normal_ts *= inv;
    roughness *= inv;
    occlusion *= inv;
    // Distant ground keeps its colour and loses its bumps (they would only shimmer).
    let distance = length(world - frame.camera_pos.xyz);
    normal_ts *= 1.0 - smoothstep(terrain.extent.z * 0.4, terrain.extent.z, distance);
    // Wet ground along the water: darker and glossier, the lake bed darker still.
    let water = terrain.extent.y;
    let wet = 1.0 - smoothstep(water + 0.02, water + 0.35, world.y);
    albedo *= mix(1.0, 0.55, wet);
    roughness = mix(roughness, 0.32, wet * (1.0 - smoothstep(water - 0.05, water - 0.4, world.y)));
    // The lake bed darkens with depth under the water (silt, and less light reaching it).
    albedo *= mix(1.0, 0.38, 1.0 - smoothstep(water - 1.4, water - 0.1, world.y));
    albedo *= mix(1.0, occlusion, 0.7);
    // The tangent frame of the world-aligned layers: u along +x, v along +z (GL-style normal maps
    // point their green away from v as WebGPU samples it).
    let tangent = normalize(vec3<f32>(1.0, 0.0, 0.0) - geometric * geometric.x);
    let bitangent = normalize(cross(tangent, geometric)) * -1.0;
    let z = sqrt(max(1.0 - dot(normal_ts, normal_ts), 0.0));
    let shading = normalize(tangent * normal_ts.x + bitangent * normal_ts.y + geometric * z);
    var surface = gx_filter_specular_v2(gx_surface_v2(world, geometric, albedo, 0.0, roughness), n_dx, n_dy);
    surface.n = shading;
    return vec4<f32>(gx_shade_pbr(surface), 1.0);
}
