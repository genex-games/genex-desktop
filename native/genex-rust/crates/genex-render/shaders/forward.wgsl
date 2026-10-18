// Forward metallic-roughness shading. Opaque instances come from the instance table through this
// view's region of the visible list (the vertex's slot finds its batch), so the CPU-culled direct
// draw and the GPU-culled multi-draw run the same shader on the same rows. Transparent draws name
// their row directly and blend (`fs_blend`). The fragment is built from the lighting chunks
// (`shaders/lighting/`: surface, ambient, sun, local lights, fog, output), concatenated ahead of
// this file; opaque fragments write alpha 1 (captures are opaque). The position is
// `gx_clip_position` and `@invariant` (shaders/clip_position.wgsl), as every depth writer's is, so
// the depth/normal prepass and an `Equal`-depth main pass agree bit for bit.

// Whether the pipeline's instances may fade between LODs (a pipeline-overridable constant): their
// fragments are dithered away by the instance fade table (layout::FRAME_INSTANCE_FADE_BINDING)
// once the crossfade lands; false (the default) draws every row whole.
override GX_LOD_FADE: bool = false;

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
// The binned local lights (RQ6.2; layout::FRAME_LIGHT_BINDINGS): each light's extension row, and
// one bin table (pass 2 A.0, LG-16): the header and every clusterable kind's z-bins, then the
// per-tile masks at GX_LIGHT_TILES_OFFSET_WORDS. Binding 22 is free.
@group(0) @binding(20) var<storage, read> light_ext: array<vec4<f32>>;
@group(0) @binding(21) var<storage, read> light_bins: array<u32>;

// Word `i` of the bin header and z-bins, and word `i` of the tile masks: the light walk's reads
// (shaders/lighting/local_lights.wgsl), over the one table here and the v2 map's two slices there.
fn gx_light_bin_word(i: u32) -> u32 {
    return light_bins[i];
}

fn gx_light_tile_word(i: u32) -> u32 {
    return light_bins[GX_LIGHT_TILES_OFFSET_WORDS + i];
}
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
        start = slot_base[in.slot + pass_view.slot_offset];
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

// Linear rgb and alpha of a fragment: ambient, then the sun (and the sun's light through a
// translucent material, B.1), then the local lights, then the
// material's emission (RQ6.3), through the air (aerial perspective) and the fog.
// Metal compiles with fast math, so the chunks keep the evaluation order of the shader before the
// split (the view vector and the sun direction made here, the sun term added here): the legacy
// frames stay byte-identical.
//
// A back face (only a double-sided material's pipeline draws one; P2-0.12) is shaded with its
// whole tangent frame turned to the viewer (`front` false), as three.js and Filament shade it.
// The HDR scene's sun is a disc for its specular highlight (P2-0.12 LG-04, `gx_sun_area_direction`);
// the legacy scene keeps the point sun its goldens were drawn with.
fn surface(in: VsOut, front: bool) -> vec4<f32> {
    // The decals' texture gradients (renderer pass 2 A.10), taken here in uniform control flow.
    let world_dx = dpdx(in.world_pos);
    let world_dy = dpdy(in.world_pos);
    gx_sun_shadow_context(in.clip.xy, frame.shadow_counts.z, frame.shadow_soft.y);
    gx_sun_shadow_end_fade(frame.shadow_soft.z);
    let facing = select(-1.0, 1.0, front);
    let tangent = vec4<f32>(in.tangent.xyz * facing, in.tangent.w * facing);
    var s = gx_surface(in.world_pos, in.normal * facing, in.uv, tangent, in.material);
    s.v = normalize(frame.camera_pos.xyz - in.world_pos);
    let ext = material_ext[in.material];
    // The occlusion map eased from 1 by its strength (P2-0.12 LG-09).
    gx_material_ao = mix(1.0, gx_material_ao, ext.emissive.w);
    // An alpha-tested surface that survived its test is opaque (P2-0.12): its alpha is the
    // cutout's, not a blend's, so it takes the opaque surfaces' AO and contact shadows.
    if ext.params.w > 0.0 {
        s.alpha = 1.0;
    }
    // The decals binned at this fragment, before any light (renderer pass 2 A.10); a probe's or
    // a volume's capture (GX_PROBES off) draws none: the frame's bins are the camera's tiles.
    if GX_PROBES {
        s = gx_decals(s, world_dx, world_dy);
    }
    // The screen's reflection at this pixel (renderer pass 2 B.9), laid over the probes' by the
    // ambient chunk.
    gx_screen_reflection = gx_screen_reflection_at();
    var sun = normalize(frame.sun_dir.xyz);
    if GX_SCENE_HDR {
        sun = gx_sun_area_direction(sun, frame.sun_dir.w, s.n, s.v);
    }
    // A translucent material's light through it (renderer pass 2 B.1): the sun's here, the local
    // lights' in their walk; a draw-uniform branch, so every other material shades as before.
    gx_subsurface_begin(ext);
    var color = gx_ambient(s);
    color += gx_sun(s, sun);
    if gx_subsurface_active {
        color += gx_subsurface_sun(s, ext, sun);
    }
    color = gx_local_lights(color, s);
    color += gx_emission(ext, in.uv);
    color = gx_forward_fog(color, s.world_pos);
    return vec4<f32>(color, s.alpha);
}

@fragment
fn fs_main(in: VsOut, @builtin(front_facing) front: bool) -> @location(0) vec4<f32> {
    return vec4<f32>(gx_encode_ldr(surface(in, front).rgb), 1.0);
}

@fragment
fn fs_blend(in: VsOut, @builtin(front_facing) front: bool) -> @location(0) vec4<f32> {
    let lit = surface(in, front);
    return vec4<f32>(gx_encode_ldr(lit.rgb), lit.a);
}

// The world pass's depth step of an alpha-tested batch (P2-0.12): its depth with the cutout cut
// away, before the `Equal` shading of the same batch (`fs_main` over the depth this wrote), so no
// shading fragment discards and the tile GPU's hidden-surface removal keeps working for the rest.
// The colour target is bound with no write: under alpha-to-coverage its alpha becomes coverage.
@fragment
fn fs_mask_depth(in: VsOut) -> @location(0) vec4<f32> {
    let kept = gx_alpha_mask(in.material, in.uv, in.world_pos, frame.shadow_counts.z);
    if GX_ALPHA_MODE != GX_ALPHA_TO_COVERAGE && kept <= 0.0 {
        discard;
    }
    return vec4<f32>(0.0, 0.0, 0.0, kept);
}

// Whether the forward pass binds the size class of material texture `reference` (the decal chunk
// asks): it binds every class.
fn gx_decal_texture_bound(reference: u32) -> bool {
    return true;
}

// The texel of decal texture `reference` (size class and layer) at `uv` and mip `lod`, from the
// colour (`color`) or data arrays of its class (the decal chunk samples at an explicit level: one
// level a decal for its maps, cheaper than a gradient fetch a map).
fn gx_decal_class_texel(color: bool, reference: u32, uv: vec2<f32>, lod: f32) -> vec4<f32> {
    let at = i32(reference & GX_TEXTURE_LAYER_MASK);
    let size_class = reference >> GX_TEXTURE_CLASS_SHIFT;
    if color {
        switch size_class {
            case 0u: {
                return textureSampleLevel(color_textures, texture_sampler, uv, at, lod);
            }
            case 1u: {
                return textureSampleLevel(color_textures_512, texture_sampler, uv, at, lod);
            }
            case 2u: {
                return textureSampleLevel(color_textures_1024, texture_sampler, uv, at, lod);
            }
            default: {
                return textureSampleLevel(color_textures_2048, texture_sampler, uv, at, lod);
            }
        }
    }
    switch size_class {
        case 0u: {
            return textureSampleLevel(data_textures, texture_sampler, uv, at, lod);
        }
        case 1u: {
            return textureSampleLevel(data_textures_512, texture_sampler, uv, at, lod);
        }
        case 2u: {
            return textureSampleLevel(data_textures_1024, texture_sampler, uv, at, lod);
        }
        default: {
            return textureSampleLevel(data_textures_2048, texture_sampler, uv, at, lod);
        }
    }
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
        return gx_color_class_texel(reference, uv, uv_dx, uv_dy);
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
