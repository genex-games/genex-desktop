// Forward metallic-roughness shading. Opaque instances come from the instance table through this
// view's region of the visible list (the vertex's slot finds its batch), so the CPU-culled direct
// draw and the GPU-culled multi-draw run the same shader on the same rows. Transparent draws name
// their row directly and blend (`fs_blend`). The fragment is built from the lighting chunks
// (`shaders/lighting/`: surface, ambient, sun, local lights, fog, output), concatenated ahead of
// this file; opaque fragments write alpha 1 (captures are opaque). The position is
// `gx_clip_position` and `@invariant` (shaders/clip_position.wgsl), as every depth writer's is, so
// the depth/normal prepass and an `Equal`-depth main pass agree bit for bit.

@group(0) @binding(0) var<uniform> frame: FrameUniforms;
@group(0) @binding(1) var<storage, read> instances: array<Instance>;
@group(0) @binding(2) var<storage, read> materials: array<Material>;
@group(0) @binding(3) var<storage, read> visible: array<u32>;
@group(0) @binding(4) var<storage, read> slot_base: array<u32>;
@group(0) @binding(5) var<storage, read> lights: array<Light>;
@group(0) @binding(6) var shadow_map: texture_depth_2d_array;
@group(0) @binding(7) var shadow_sampler: sampler_comparison;
@group(0) @binding(8) var color_textures: texture_2d_array<f32>;
@group(0) @binding(9) var data_textures: texture_2d_array<f32>;
@group(0) @binding(10) var texture_sampler: sampler;
// The binned local lights (RQ6.2; layout::FRAME_LIGHT_BINDINGS): each light's extension row, the
// per-tile light masks and the light-bin header with the z-bins.
@group(0) @binding(20) var<storage, read> light_ext: array<vec4<f32>>;
@group(0) @binding(21) var<storage, read> light_tiles: array<u32>;
@group(0) @binding(22) var<storage, read> light_zbins: array<u32>;
// Each material row's extension (RQ6.3: its emission), `FRAME_LIGHT_BINDINGS`' `material_ext`.
@group(0) @binding(23) var<storage, read> material_ext: array<GxMaterialExt>;
// The material texture arrays of the larger size classes (RQ6.4; layout::FRAME_MATERIAL_CLASS_BINDINGS),
// colour then data per class; a class that holds no texture is a 1 x 1 placeholder.
@group(0) @binding(24) var color_textures_512: texture_2d_array<f32>;
@group(0) @binding(25) var data_textures_512: texture_2d_array<f32>;
@group(0) @binding(26) var color_textures_1024: texture_2d_array<f32>;
@group(0) @binding(27) var data_textures_1024: texture_2d_array<f32>;
@group(0) @binding(28) var color_textures_2048: texture_2d_array<f32>;
@group(0) @binding(29) var data_textures_2048: texture_2d_array<f32>;
@group(1) @binding(0) var<uniform> pass_view: PassView;

struct VsIn {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) uv: vec2<f32>,
    @location(3) tangent: vec4<f32>,
    @location(4) slot: u32,
}

struct VsOut {
    @builtin(position) @invariant clip: vec4<f32>,
    @location(0) world_pos: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) uv: vec2<f32>,
    @location(3) tangent: vec4<f32>,
    @location(4) @interpolate(flat) material: u32,
}

@vertex
fn vs_main(in: VsIn, @builtin(instance_index) instance: u32) -> VsOut {
    var start = 0u;
    if pass_view.direct == 0u {
        start = slot_base[in.slot];
    }
    let row = instances[visible[visible_row(pass_view.view, pass_view.direct, pass_view.base, start, instance, frame.counts.w)]];
    let world = row.model * vec4<f32>(in.position, 1.0);
    var out: VsOut;
    out.clip = gx_clip_position(frame.view_proj, world, frame.jitter.xy);
    out.world_pos = world.xyz;
    out.normal = (row.normal * vec4<f32>(in.normal, 0.0)).xyz;
    out.uv = in.uv;
    out.tangent = vec4<f32>((row.model * vec4<f32>(in.tangent.xyz, 0.0)).xyz, in.tangent.w);
    out.material = row.material;
    return out;
}

// Whether this pipeline draws the HDR scene (pbr.wgsl's direct specular asks): its constant.
fn gx_scene_shades_hdr() -> bool {
    return GX_SCENE_HDR;
}

// Linear rgb and alpha of a fragment: ambient, then the sun, then the local lights, then the
// material's emission (RQ6.3), through the air (aerial perspective) and the fog.
// Metal compiles with fast math, so the chunks keep the evaluation order of the shader before the
// split (the view vector and the sun direction made here, the sun term added here): the legacy
// frames stay byte-identical.
fn surface(in: VsOut) -> vec4<f32> {
    gx_sun_shadow_context(in.clip.xy, frame.shadow_counts.z, frame.shadow_soft.y);
    gx_sun_shadow_end_fade(frame.shadow_soft.z);
    var s = gx_surface(in.world_pos, in.normal, in.uv, in.tangent, in.material);
    s.v = normalize(frame.camera_pos.xyz - in.world_pos);
    let sun = normalize(frame.sun_dir.xyz);
    var color = gx_ambient(s);
    color += gx_sun(s, sun);
    color = gx_local_lights(color, s);
    color += gx_emission(material_ext[in.material], in.uv);
    color = gx_forward_fog(color, s.world_pos);
    return vec4<f32>(color, s.alpha);
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    return vec4<f32>(gx_encode_ldr(surface(in).rgb), 1.0);
}

@fragment
fn fs_blend(in: VsOut) -> @location(0) vec4<f32> {
    let lit = surface(in);
    return vec4<f32>(gx_encode_ldr(lit.rgb), lit.a);
}

// The texel of material texture `reference` (`layout::texture_ref`: size class and layer) at `uv`
// with explicit gradients, from the colour (`color`) or data arrays of its class: one fetch, none
// for a missing texture (whose value the caller replaces).
fn gx_class_texel(color: bool, reference: u32, uv: vec2<f32>, uv_dx: vec2<f32>, uv_dy: vec2<f32>) -> vec4<f32> {
    if reference == NO_TEXTURE {
        return vec4<f32>(0.0);
    }
    let size_class = reference >> GX_TEXTURE_CLASS_SHIFT;
    let at = i32(reference & GX_TEXTURE_LAYER_MASK);
    if color {
        switch size_class {
            case 0u: {
                return textureSampleGrad(color_textures, texture_sampler, uv, at, uv_dx, uv_dy);
            }
            case 1u: {
                return textureSampleGrad(color_textures_512, texture_sampler, uv, at, uv_dx, uv_dy);
            }
            case 2u: {
                return textureSampleGrad(color_textures_1024, texture_sampler, uv, at, uv_dx, uv_dy);
            }
            default: {
                return textureSampleGrad(color_textures_2048, texture_sampler, uv, at, uv_dx, uv_dy);
            }
        }
    }
    switch size_class {
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
