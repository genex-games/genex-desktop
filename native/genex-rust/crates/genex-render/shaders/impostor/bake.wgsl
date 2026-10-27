// Impostor bake (game systems LOD-13; after kansei's `bake_impostor`, MIT): one frame of an
// object's parts, drawn orthographically from the frame's direction into three render targets
// through the forward pass's own material evaluation (`gx_surface` and `gx_mask_alpha`, the
// chunks concatenated ahead of this file), as surface attributes rather than lit colour:
// - location 0: linear base colour and alpha;
// - location 1: the object-space shading normal (normal-mapped) and the perceptual roughness;
// - location 2: occlusion, metallic, the diffuse transmission share and the material class.
// The pack compute (pack.wgsl) folds `GX_IMPOSTOR_SUPERSAMPLE` x that many render texels into
// each atlas texel. The object sits at its bake origin: positions and normals are object space.

struct GxImpostorBake {
    view_proj: mat4x4<f32>,
}

@group(0) @binding(0) var<uniform> bake: GxImpostorBake;
@group(0) @binding(1) var<storage, read> materials: array<Material>;
@group(0) @binding(2) var<storage, read> material_ext: array<GxMaterialExt>;
@group(0) @binding(3) var color_textures: texture_2d_array<f32>;
@group(0) @binding(4) var data_textures: texture_2d_array<f32>;
@group(0) @binding(5) var color_textures_512: texture_2d_array<f32>;
@group(0) @binding(6) var data_textures_512: texture_2d_array<f32>;
@group(0) @binding(7) var color_textures_1024: texture_2d_array<f32>;
@group(0) @binding(8) var data_textures_1024: texture_2d_array<f32>;
@group(0) @binding(9) var color_textures_2048: texture_2d_array<f32>;
@group(0) @binding(10) var data_textures_2048: texture_2d_array<f32>;
@group(0) @binding(11) var texture_sampler: sampler;

// The surface chunk asks whether it shades the HDR scene (its specular filter): the bake writes
// no lit colour, so never.
override GX_SCENE_HDR: bool = false;
// The material class's flag bits (`GxMaterialExt::params.z`) the class channel keeps.
const GX_IMPOSTOR_CLASS_MASK: u32 = 0xffu;

// The surface chunk's texture mip bias: the pipeline's constant alone (the bake has no frame).
fn gx_texture_lod_bias() -> f32 {
    return GX_TEXTURE_LOD_BIAS;
}

// The texel of material texture `reference` from its size class's colour or data array, with
// explicit gradients (the forward pass's `gx_class_texel`, over the bake's own bindings).
fn gx_class_texel(color: bool, reference: u32, uv: vec2<f32>, uv_dx: vec2<f32>, uv_dy: vec2<f32>) -> vec4<f32> {
    if reference == NO_TEXTURE {
        return vec4<f32>(0.0);
    }
    if color {
        return gx_color_class_texel(reference, uv, uv_dx, uv_dy);
    }
    let at = i32(reference & GX_TEXTURE_LAYER_MASK);
    switch reference >> GX_TEXTURE_CLASS_SHIFT {
        case 0u: {
            return textureSampleGrad(data_textures, texture_sampler, uv, at, uv_dx, uv_dy);
        }
        case 1u: {
            return textureSampleGrad(data_textures_512, texture_sampler, uv, at, uv_dx, uv_dy);
        }
        case 2u: {
            return textureSampleGrad(data_textures_1024, texture_sampler, uv, at, uv_dx, uv_dy);
        }
        default: {
            return textureSampleGrad(data_textures_2048, texture_sampler, uv, at, uv_dx, uv_dy);
        }
    }
}

struct GxBakeIn {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) uv: vec2<f32>,
    @location(3) tangent: vec4<f32>,
    // The part's material row (one instance per part).
    @location(4) material: u32,
}

struct GxBakeVaryings {
    @builtin(position) clip: vec4<f32>,
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) uv: vec2<f32>,
    @location(3) tangent: vec4<f32>,
    @location(4) @interpolate(flat) material: u32,
}

struct GxBakeTargets {
    @location(0) albedo: vec4<f32>,
    @location(1) normal_roughness: vec4<f32>,
    @location(2) surface: vec4<f32>,
}

@vertex
fn vs_impostor_bake(in: GxBakeIn) -> GxBakeVaryings {
    var out: GxBakeVaryings;
    out.clip = bake.view_proj * vec4<f32>(in.position, 1.0);
    out.position = in.position;
    out.normal = in.normal;
    out.uv = in.uv;
    out.tangent = in.tangent;
    out.material = in.material;
    return out;
}

// A part's surface at a fragment: a back face (cards, leaves) is shaded with its tangent frame
// turned to the viewer, as the forward pass shades a double-sided material; an alpha-tested
// material's cutout is cut away (a plain test: the pack's supersampling averages the edge).
@fragment
fn fs_impostor_bake(in: GxBakeVaryings, @builtin(front_facing) front: bool) -> GxBakeTargets {
    let alpha = gx_mask_alpha(in.material, in.uv);
    let facing = select(-1.0, 1.0, front);
    let tangent = vec4<f32>(in.tangent.xyz * facing, in.tangent.w * facing);
    let ext = material_ext[in.material];
    let mapped = gx_surface_uv(ext.uv, ext.tiling, in.uv, tangent, in.position, in.normal * facing);
    let s = gx_surface(in.position, in.normal * facing, mapped.uv, mapped.tangent, in.material);
    let cutoff = ext.params.w;
    if cutoff > 0.0 && alpha < cutoff {
        discard;
    }
    let occlusion = mix(1.0, gx_material_ao, ext.emissive.w);
    let material_class = f32(u32(max(ext.params.z, 0.0)) & GX_IMPOSTOR_CLASS_MASK) / 255.0;
    var out: GxBakeTargets;
    out.albedo = vec4<f32>(s.albedo, s.alpha);
    out.normal_roughness = vec4<f32>(s.n, s.roughness);
    out.surface = vec4<f32>(occlusion, s.metallic, clamp(ext.transmission.y, 0.0, 1.0), material_class);
    return out;
}
