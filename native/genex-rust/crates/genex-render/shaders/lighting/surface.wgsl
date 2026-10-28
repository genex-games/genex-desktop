// Lighting chunk: the surface. A fragment's material inputs (base colour, metallic-roughness and
// normal-map layers of the texture arrays, the missing-asset checker), the shading normal and the
// emitted radiance (`gx_emission`, RQ6.3). Reads the forward bindings `frame`, `materials`,
// `color_textures`, `data_textures` and `texture_sampler`, and calls `gx_class_texel` for a
// texture of a larger size class (RQ6.4: the forward pass samples its class arrays, a Level-2 v2
// material binds class 0 only); the material-extension row is the caller's to pass (its binding
// differs between the forward pass and v2 materials). Concatenated ahead of every forward-shaded
// source (`shaders.rs`).

const MAGENTA: vec3<f32> = vec3<f32>(1.0, 0.0, 1.0);
const CHECKS_PER_UNIT: f32 = 4.0;
// Geometric specular antialiasing (Kaplanyan 2016, Tokuyoshi 2019; Filament's defaults): the
// screen-space variance of the shading normal, scaled by this, widens alpha squared by at most
// GX_SPECULAR_AA_THRESHOLD.
const GX_SPECULAR_AA_VARIANCE: f32 = 0.15;
const GX_SPECULAR_AA_THRESHOLD: f32 = 0.2;

// Whether the pipeline filters specular aliasing (`Quality::specular_aa`; a pipeline-overridable
// constant the renderer sets on the HDR scene's pipelines). Off by default: the legacy scene and
// a pipeline that does not set it shade the material's own roughness.
override GX_SPECULAR_AA: bool = false;

// The mip bias material textures sample with, `gx_texture_lod_bias()`: in the forward pass the
// frame's lane (`FrameUniforms::texture_lod.x`, renderer pass 2 P2-0.8b T-06,
// `settings::frame_texture_lod_bias`: TAA's `log2(scale)` - 0.5, where the jitter recovers the
// detail a sharper mip would alias, FSR1's upscale's `log2(scale)` without TAA, else 0, at the
// frame's own scale, so a dynamic-resolution step moves it without a pipeline) plus this
// pipeline-overridable constant, which the renderer's pipelines leave at 0; the v2 prelude reads
// the constant alone. At 0 a texture samples exactly as `textureSample`.
override GX_TEXTURE_LOD_BIAS: f32 = 0.0;

// Whether material textures live in size classes (RQ6.4, texture quality on: the renderer sets it
// on the forward pipelines whenever its arrays' quality is on, from boot, so the first large
// texture compiles nothing). On, each texture is one gradient fetch from its class's arrays; off,
// a fragment samples the class-0 arrays exactly as before size classes.
override GX_TEXTURE_CLASSES: bool = false;

// Whether normal-map mips keep their averaged length in alpha (RQ6.4, Toksvig): the surface then
// widens roughness by the detail a coarse mip averaged away.
override GX_TOKSVIG: bool = false;

// The least perceptual roughness a forward surface shades with (a pipeline-overridable constant):
// 0.04 by default, as before the floor was a knob; a class's pipelines may raise it (the sun as a
// disc on desktop, a coarser floor on phones' half-precision paths).
override GX_ROUGHNESS_FLOOR: f32 = 0.04;

// Which layered-material parts the pipeline draws (AAA materials, `layers::LayerTier`,
// shaders/lighting/layers.wgsl): 0 the cover alone without its noise (the default, the low
// presets and the legacy scene), 1 with its noise, the detail maps, the second layer and the
// lobes, 2 parallax occlusion mapping too (desktop high and ultra).
override GX_MATERIAL_LAYERS: u32 = 0u;

// The occlusion map's ambient occlusion at the fragment `gx_surface` last built (P2-0.12 LG-09;
// its strength applied by the caller, which reads the material's extension row): 1 without a map,
// and for every Level-2 v2 surface (which builds no built-in surface). The ambient chunk takes the
// smaller of it and the screen-space AO for the diffuse and specular occlusion of indirect light;
// direct light never reads it.
var<private> gx_material_ao: f32 = 1.0;

// What the lighting chunks shade.
struct Surface {
    world_pos: vec3<f32>,
    // The interpolated vertex normal (shadow receiver offsets).
    geometric: vec3<f32>,
    // The shading normal (normal-mapped when the material has a normal map).
    n: vec3<f32>,
    // Unit direction to the viewer: the caller's to set (the camera for forward shading), after
    // `gx_surface`.
    v: vec3<f32>,
    albedo: vec3<f32>,
    alpha: f32,
    metallic: f32,
    roughness: f32,
}

fn checker(world_pos: vec3<f32>) -> vec3<f32> {
    let cell = vec3<i32>(floor(world_pos * CHECKS_PER_UNIT));
    if ((cell.x + cell.y + cell.z) & 1) == 0 {
        return MAGENTA;
    }
    return vec3<f32>(0.0);
}

// The perceptual roughness that keeps a highlight from aliasing where the shading normal changes
// by `du` and `dv` between neighbouring pixels: alpha squared widened by the normal's
// screen-space variance (capped), so a curved or normal-mapped surface's highlight cannot be
// thinner than a pixel. Equals `roughness` where the normal is constant.
fn gx_filtered_roughness(roughness: f32, du: vec3<f32>, dv: vec3<f32>) -> f32 {
    let variance = GX_SPECULAR_AA_VARIANCE * (dot(du, du) + dot(dv, dv));
    let kernel = min(2.0 * variance, GX_SPECULAR_AA_THRESHOLD);
    let alpha = roughness * roughness;
    return sqrt(sqrt(clamp(alpha * alpha + kernel, 0.0, 1.0)));
}

fn layer(index: u32) -> i32 {
    return i32(select(index & GX_TEXTURE_LAYER_MASK, 0u, index == NO_TEXTURE));
}

// The perceptual roughness a normal-mapped texel shades with when its mip kept `normal_length` of
// the averaged unit normals (Toksvig; the vMF fit of Neubelt and Pettineo 2013, the CPU's
// `texture::toksvig_roughness`): alpha squared widened by 1 / kappa, capped at 1.
fn gx_toksvig_roughness(roughness: f32, normal_length: f32) -> f32 {
    if normal_length >= 1.0 {
        return roughness;
    }
    let l = max(normal_length, 1.0 / 255.0);
    let kappa = (3.0 * l - l * l * l) / (1.0 - l * l);
    let alpha = roughness * roughness;
    return sqrt(sqrt(min(alpha * alpha + 1.0 / kappa, 1.0)));
}

// A fragment's texture coordinates and tangent frame under its material's UV mapping (Bodycam
// B2b, the extension row's `uv` and `tiling`, `pbr::uv_rows`).
struct GxSurfaceUv {
    uv: vec2<f32>,
    tangent: vec4<f32>,
}

// `tiling` flag bits (`pbr::UV_FLAG_WORLD`, `pbr::UV_FLAG_STOCHASTIC`).
const GX_UV_WORLD: u32 = 1u;
const GX_UV_STOCHASTIC: u32 = 2u;
// Stochastic tiling (Quilez's technique 3): the variation noise's frequency per tile, and how many
// offsets one noise period walks through.
const GX_STOCHASTIC_NOISE_PER_TILE: f32 = 0.25;
const GX_STOCHASTIC_STEPS: f32 = 8.0;

// The extension row's `tiling` of the fragment `gx_surface_uv` last mapped, read by `gx_surface`
// (stochastic tiling, macro variation); zero for every Level-2 v2 surface.
var<private> gx_surface_tiling: vec4<f32> = vec4<f32>(0.0);

// The extension row's flag of a first-person view model (`layout::MATERIAL_EXT_FLAG_VIEW_MODEL`).
const GX_MATERIAL_VIEW_MODEL: u32 = 4u;
// Whether the fragment being shaded is a view model's (Bodycam light fix): set by the forward
// pass from its material's row before any light; screen-space AO and contact shadows, made for
// the world, leave it alone (forward_effects.wgsl), and it takes the camera's fill
// (`gx_view_model_fill`). False for every other surface.
var<private> gx_view_model: bool = false;

// The world position projected along the axis `normal` faces most, `scale` tiles per metre: u runs
// to the viewer's right and v down a wall, and the tangent is the projection's own u axis with the
// meshes' handedness (-1: the bitangent is where v grows).
fn gx_world_uv(scale: vec2<f32>, world_pos: vec3<f32>, normal: vec3<f32>) -> GxSurfaceUv {
    let a = abs(normal);
    if a.x >= a.y && a.x >= a.z {
        let s = select(-1.0, 1.0, normal.x >= 0.0);
        return GxSurfaceUv(vec2<f32>(-s * world_pos.z, -world_pos.y) * scale, vec4<f32>(0.0, 0.0, -s, -1.0));
    }
    if a.z >= a.y {
        let s = select(-1.0, 1.0, normal.z >= 0.0);
        return GxSurfaceUv(vec2<f32>(s * world_pos.x, -world_pos.y) * scale, vec4<f32>(s, 0.0, 0.0, -1.0));
    }
    let s = select(-1.0, 1.0, normal.y >= 0.0);
    return GxSurfaceUv(vec2<f32>(world_pos.x, s * world_pos.z) * scale, vec4<f32>(1.0, 0.0, 0.0, -1.0));
}

// The mesh's own `uv` and `tangent` times the row's scale (a zero scale reads as 1, so a zeroed
// row is the mesh's UVs bit for bit), or with the world bit the world projection
// (`gx_world_uv`: a box of any size tiles its texture at one texel density; a moving draw's
// texture slides over it); then turned by `tiling.y` (the tangent with it, so a normal map stays
// right) and moved by the row's offset. Keeps `tiling` for `gx_surface`.
fn gx_surface_uv(row: vec4<f32>, tiling: vec4<f32>, uv: vec2<f32>, tangent: vec4<f32>, world_pos: vec3<f32>, normal: vec3<f32>) -> GxSurfaceUv {
    gx_surface_tiling = tiling;
    let flags = u32(max(tiling.x, 0.0));
    let scale = select(row.xy, vec2<f32>(1.0), row.xy == vec2<f32>(0.0));
    var mapped = GxSurfaceUv(uv * scale, tangent);
    if (flags & GX_UV_WORLD) != 0u {
        mapped = gx_world_uv(scale, world_pos, normal);
    }
    if tiling.y != 0.0 {
        let c = cos(tiling.y);
        let s = sin(tiling.y);
        let b = cross(normalize(normal), mapped.tangent.xyz) * mapped.tangent.w;
        let turned = vec2<f32>(c * mapped.uv.x - s * mapped.uv.y, s * mapped.uv.x + c * mapped.uv.y);
        mapped = GxSurfaceUv(turned, vec4<f32>(c * mapped.tangent.xyz - s * b, mapped.tangent.w));
    }
    mapped.uv += row.zw;
    return mapped;
}

// PCG's output hash of `x` (integer arithmetic, so every GPU computes the same bits).
fn gx_hash_u32(x: u32) -> u32 {
    let state = x * 747796405u + 2891336453u;
    let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
    return (word >> 22u) ^ word;
}

// A lattice point's value in [0, 1).
fn gx_hash01(p: vec3<i32>) -> f32 {
    let h = gx_hash_u32(bitcast<u32>(p.x) ^ gx_hash_u32(bitcast<u32>(p.y) ^ gx_hash_u32(bitcast<u32>(p.z))));
    return f32(h >> 8u) / 16777216.0;
}

// Smooth value noise in [0, 1) over the integer lattice (z 0 for a 2D noise).
fn gx_value_noise(p: vec3<f32>) -> f32 {
    let i = vec3<i32>(floor(p));
    let f = fract(p);
    let w = f * f * (3.0 - 2.0 * f);
    let x00 = mix(gx_hash01(i), gx_hash01(i + vec3<i32>(1, 0, 0)), w.x);
    let x10 = mix(gx_hash01(i + vec3<i32>(0, 1, 0)), gx_hash01(i + vec3<i32>(1, 1, 0)), w.x);
    let x01 = mix(gx_hash01(i + vec3<i32>(0, 0, 1)), gx_hash01(i + vec3<i32>(1, 0, 1)), w.x);
    let x11 = mix(gx_hash01(i + vec3<i32>(0, 1, 1)), gx_hash01(i + vec3<i32>(1, 1, 1)), w.x);
    return mix(mix(x00, x10, w.y), mix(x01, x11, w.y), w.z);
}

// Stochastic tiling's offset for variation step `index`: a fraction of a tile on each axis.
fn gx_tile_offset(index: f32) -> vec2<f32> {
    let h = gx_hash_u32(u32(max(index, 0.0)) + 1u);
    return vec2<f32>(f32(h & 0xffffu), f32(h >> 16u)) / 65536.0;
}

// The base colour's large-scale variation at `world_pos` (Bodycam B2b): two octaves of value noise
// with patches of `metres`, scaling the albedo by 1 +- `strength`.
fn gx_macro_variation(world_pos: vec3<f32>, strength: f32, metres: f32) -> f32 {
    let p = world_pos / max(metres, 0.1);
    let n = 0.65 * gx_value_noise(p) + 0.35 * gx_value_noise(p * 2.37 + vec3<f32>(17.0, 5.0, 11.0));
    return 1.0 + strength * (2.0 * n - 1.0);
}

// The surface of material row `material_index` at a fragment, its view direction still unset.
fn gx_surface(world_pos: vec3<f32>, normal: vec3<f32>, uv: vec2<f32>, tangent: vec4<f32>, material_index: u32) -> Surface {
    let material = materials[material_index];
    var base_sample: vec4<f32>;
    var normal_sample: vec4<f32>;
    var mr_sample: vec4<f32>;
    let lod_bias = gx_texture_lod_bias();
    let stochastic = (u32(max(gx_surface_tiling.x, 0.0)) & GX_UV_STOCHASTIC) != 0u;
    var uv_a = uv;
    if GX_TEXTURE_CLASSES {
        // One fetch per texture, from its own class's arrays (class 0 included): explicit
        // gradients (taken here, in uniform control flow) carry the bias, so the class branch may
        // diverge; a missing texture fetches nothing.
        let lod_scale = exp2(lod_bias);
        let uv_dx = dpdx(uv) * lod_scale;
        let uv_dy = dpdy(uv) * lod_scale;
        // Stochastic tiling (Bodycam B2b, Quilez's technique 3): two copies at offsets a value
        // noise walks through, blended where it steps, both with the unshifted UVs' gradients so
        // no mip seam shows where the offset changes.
        var uv_b = uv;
        var blend_at = 0.0;
        if stochastic {
            let k = gx_value_noise(vec3<f32>(uv * GX_STOCHASTIC_NOISE_PER_TILE, 0.0)) * GX_STOCHASTIC_STEPS;
            let index = floor(k);
            blend_at = k - index;
            uv_a = uv + gx_tile_offset(index);
            uv_b = uv + gx_tile_offset(index + 1.0);
        }
        base_sample = gx_class_texel(true, material.textures.x, uv_a, uv_dx, uv_dy);
        normal_sample = gx_class_texel(false, material.textures.y, uv_a, uv_dx, uv_dy);
        mr_sample = gx_class_texel(false, material.textures.z, uv_a, uv_dx, uv_dy);
        if stochastic {
            let base_b = gx_class_texel(true, material.textures.x, uv_b, uv_dx, uv_dy);
            let blend = smoothstep(0.2, 0.8, blend_at - 0.1 * dot(base_sample.rgb - base_b.rgb, vec3<f32>(1.0)));
            base_sample = mix(base_sample, base_b, blend);
            normal_sample = mix(normal_sample, gx_class_texel(false, material.textures.y, uv_b, uv_dx, uv_dy), blend);
            mr_sample = mix(mr_sample, gx_class_texel(false, material.textures.z, uv_b, uv_dx, uv_dy), blend);
        }
    } else {
        // Sampled before any data-dependent branch (implicit derivatives need uniform control
        // flow); a missing texture samples layer 0 and is replaced by its neutral value.
        base_sample = textureSampleBias(color_textures, texture_sampler, uv, layer(material.textures.x), lod_bias);
        normal_sample = textureSampleBias(data_textures, texture_sampler, uv, layer(material.textures.y), lod_bias);
        mr_sample = textureSampleBias(data_textures, texture_sampler, uv, layer(material.textures.z), lod_bias);
    }
    let base = material.base_color * select(base_sample, vec4<f32>(1.0), material.textures.x == NO_TEXTURE);
    let mr = select(mr_sample.rgb, vec3<f32>(1.0), material.textures.z == NO_TEXTURE);
    gx_material_ao = gx_surface_ao(material, mr_sample.r, uv_a);
    var albedo = base.rgb;
    if gx_surface_tiling.z > 0.0 {
        albedo *= gx_macro_variation(world_pos, gx_surface_tiling.z, gx_surface_tiling.w);
    }
    if material.params.z > 0.5 {
        albedo = checker(world_pos);
    }
    let metallic = clamp(material.params.x * mr.b, 0.0, 1.0);
    var roughness = clamp(material.params.y * mr.g, GX_ROUGHNESS_FLOOR, 1.0);
    let geometric = normalize(normal);
    var n = geometric;
    if material.textures.y != NO_TEXTURE {
        let t = normalize(tangent.xyz - geometric * dot(geometric, tangent.xyz));
        let b = cross(geometric, t) * tangent.w;
        let tangent_normal = vec3<f32>((normal_sample.xy * 2.0 - 1.0) * material.params.w, normal_sample.z * 2.0 - 1.0);
        n = normalize(t * tangent_normal.x + b * tangent_normal.y + geometric * tangent_normal.z);
        if GX_TOKSVIG {
            roughness = gx_toksvig_roughness(roughness, normal_sample.a);
        }
    }
    // Derivatives in uniform control flow (after the branches above rejoin), used only when the
    // pipeline filters specular aliasing on the HDR scene. They are the geometric normal's (P2-0.12
    // C8, Filament's `normalFiltering` over the geometric normal): how the surface itself curves
    // across the pixel. The normal map's detail is Toksvig's in its mips; its 2x2-quad derivatives
    // would count it twice and step the roughness per quad.
    let n_dx = dpdx(geometric);
    let n_dy = dpdy(geometric);
    if GX_SPECULAR_AA && GX_SCENE_HDR {
        roughness = gx_filtered_roughness(roughness, n_dx, n_dy);
    }
    return Surface(world_pos, geometric, n, vec3<f32>(0.0), albedo, base.a, metallic, roughness);
}

// The occlusion map's value for `material` at `uv` (P2-0.12 LG-09): 1 without a map; an ORM
// texture's red from the metallic-roughness texel already fetched (`mr_red`); else one more
// gradient fetch of its own map, only for such a material.
fn gx_surface_ao(material: Material, mr_red: f32, uv: vec2<f32>) -> f32 {
    let lod_scale = exp2(gx_texture_lod_bias());
    let uv_dx = dpdx(uv) * lod_scale;
    let uv_dy = dpdy(uv) * lod_scale;
    let reference = material.textures.w;
    if reference == NO_TEXTURE {
        return 1.0;
    }
    if reference == material.textures.z {
        return mr_red;
    }
    return gx_class_texel(false, reference, uv, uv_dx, uv_dy).r;
}

// The radiance a fragment of a material emits (RQ6.3): its extension row's emissive radiance
// (linear rgb in scene units, strength folded in) times its emissive map, a layer of the sRGB
// colour arrays (`params.x` its layer, -1: none; `params.y` its size class). Added after lighting and before fog, so the output chunk
// pre-exposes it with the lit colour: auto exposure meters it and bloom spreads it. Call it in
// uniform control flow: the map's derivatives are taken here, and a material without a map (a
// draw-uniform branch) samples nothing.
fn gx_emission(ext: GxMaterialExt, uv: vec2<f32>) -> vec3<f32> {
    let lod_scale = exp2(gx_texture_lod_bias());
    let uv_dx = dpdx(uv) * lod_scale;
    let uv_dy = dpdy(uv) * lod_scale;
    var map = vec3<f32>(1.0);
    if ext.params.x >= 0.0 {
        if GX_TEXTURE_CLASSES {
            let reference = (u32(max(ext.params.y, 0.0)) << GX_TEXTURE_CLASS_SHIFT) | u32(ext.params.x);
            map = gx_class_texel(true, reference, uv, uv_dx, uv_dy).rgb;
        } else {
            map = textureSampleGrad(color_textures, texture_sampler, uv, i32(ext.params.x), uv_dx, uv_dy).rgb;
        }
    }
    return ext.emissive.rgb * map;
}
