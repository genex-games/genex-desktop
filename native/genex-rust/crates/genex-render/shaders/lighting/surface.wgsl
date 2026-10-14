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

// The mip bias material textures sample with (RQ5.2): `TaaQuality::texture_lod_bias` of the
// render scale while TAA runs (negative: the jitter recovers the detail a sharper mip would alias,
// and a scene rendered below output size samples the mip the output would), 0 otherwise. A
// pipeline-overridable constant the renderer sets on the TAA pipeline set (TAA is a pipeline knob);
// a pipeline that does not set it samples exactly as `textureSample`.
override GX_TEXTURE_LOD_BIAS: f32 = 0.0;

// Whether material textures live in size classes (RQ6.4, texture quality on: the renderer sets it
// on the forward pipelines whenever its arrays' quality is on, from boot, so the first large
// texture compiles nothing). On, each texture is one gradient fetch from its class's arrays; off,
// a fragment samples the class-0 arrays exactly as before size classes.
override GX_TEXTURE_CLASSES: bool = false;

// Whether normal-map mips keep their averaged length in alpha (RQ6.4, Toksvig): the surface then
// widens roughness by the detail a coarse mip averaged away.
override GX_TOKSVIG: bool = false;

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

// The surface of material row `material_index` at a fragment, its view direction still unset.
fn gx_surface(world_pos: vec3<f32>, normal: vec3<f32>, uv: vec2<f32>, tangent: vec4<f32>, material_index: u32) -> Surface {
    let material = materials[material_index];
    var base_sample: vec4<f32>;
    var normal_sample: vec4<f32>;
    var mr_sample: vec4<f32>;
    if GX_TEXTURE_CLASSES {
        // One fetch per texture, from its own class's arrays (class 0 included): explicit
        // gradients (taken here, in uniform control flow) carry the bias, so the class branch may
        // diverge; a missing texture fetches nothing.
        let lod_scale = exp2(GX_TEXTURE_LOD_BIAS);
        let uv_dx = dpdx(uv) * lod_scale;
        let uv_dy = dpdy(uv) * lod_scale;
        base_sample = gx_class_texel(true, material.textures.x, uv, uv_dx, uv_dy);
        normal_sample = gx_class_texel(false, material.textures.y, uv, uv_dx, uv_dy);
        mr_sample = gx_class_texel(false, material.textures.z, uv, uv_dx, uv_dy);
    } else {
        // Sampled before any data-dependent branch (implicit derivatives need uniform control
        // flow); a missing texture samples layer 0 and is replaced by its neutral value.
        base_sample = textureSampleBias(color_textures, texture_sampler, uv, layer(material.textures.x), GX_TEXTURE_LOD_BIAS);
        normal_sample = textureSampleBias(data_textures, texture_sampler, uv, layer(material.textures.y), GX_TEXTURE_LOD_BIAS);
        mr_sample = textureSampleBias(data_textures, texture_sampler, uv, layer(material.textures.z), GX_TEXTURE_LOD_BIAS);
    }
    let base = material.base_color * select(base_sample, vec4<f32>(1.0), material.textures.x == NO_TEXTURE);
    let mr = select(mr_sample.rgb, vec3<f32>(1.0), material.textures.z == NO_TEXTURE);
    var albedo = base.rgb;
    if material.params.z > 0.5 {
        albedo = checker(world_pos);
    }
    let metallic = clamp(material.params.x * mr.b, 0.0, 1.0);
    var roughness = clamp(material.params.y * mr.g, 0.04, 1.0);
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
    // pipeline filters specular aliasing on the HDR scene.
    let n_dx = dpdx(n);
    let n_dy = dpdy(n);
    if GX_SPECULAR_AA && GX_SCENE_HDR {
        roughness = gx_filtered_roughness(roughness, n_dx, n_dy);
    }
    return Surface(world_pos, geometric, n, vec3<f32>(0.0), albedo, base.a, metallic, roughness);
}

// The radiance a fragment of a material emits (RQ6.3): its extension row's emissive radiance
// (linear rgb in scene units, strength folded in) times its emissive map, a layer of the sRGB
// colour arrays (`params.x` its layer, -1: none; `params.y` its size class). Added after lighting and before fog, so the output chunk
// pre-exposes it with the lit colour: auto exposure meters it and bloom spreads it. Call it in
// uniform control flow: the map's derivatives are taken here, and a material without a map (a
// draw-uniform branch) samples nothing.
fn gx_emission(ext: GxMaterialExt, uv: vec2<f32>) -> vec3<f32> {
    let lod_scale = exp2(GX_TEXTURE_LOD_BIAS);
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
