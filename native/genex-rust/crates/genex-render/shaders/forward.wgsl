// Forward metallic-roughness shading. Opaque instances come from the instance table through this
// view's region of the visible list (the vertex's slot finds its batch), so the CPU-culled direct
// draw and the GPU-culled multi-draw run the same shader on the same rows. Transparent draws name
// their row directly and blend (`fs_blend`). The fragment is built from the lighting chunks
// (`shaders/lighting/`: surface, ambient, sun, local lights, fog, output), concatenated ahead of
// this file; opaque fragments write alpha 1 (captures are opaque). The position is
// `gx_clip_position` and `@invariant` (shaders/clip_position.wgsl), as every depth writer's is, so
// the depth/normal prepass and an `Equal`-depth main pass agree bit for bit.

// Whether the pipeline's instances may fade between LODs (a pipeline-overridable constant): the
// faded entries (`vs_main_fade`, `fs_main_fade`, `fs_mask_depth_fade`; game systems LOD-04) keep
// a fade-batch survivor's pixels by the instance fade table (`gx_lod_fade_keeps`); false (the
// default) draws every row whole.
override GX_LOD_FADE: bool = false;
// The faded colour pipeline's samples per pixel: its `sample_mask` covers each sample by one level
// (1: the whole pixel by one level, whatever the target's samples).
override GX_LOD_FADE_SAMPLES: u32 = 1u;
// Whether the faded entries turn their dither each frame (TAA averages the two levels).
override GX_LOD_FADE_TEMPORAL: bool = false;
// Whether the faded vertex entries grow each copy about its origin by its slot's far-field grow
// (game systems LOD-18; the instance fade table's y); false (the default) draws every copy at
// its own size.
override GX_LOD_GROW: bool = false;

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
// The instance fade table (layout::FRAME_INSTANCE_FADE_BINDING; game systems LOD-03, LOD-04):
// (fade, grow) per visible-list slot, written by the cull for fade-batch survivors. Only the
// faded fragment entries read it, so the frame layout shows it to the fragment stage alone (the
// faded vertices read the grow at `lod_grows`, LOD-18).
@group(0) @binding(31) var<storage, read> instance_fade: array<vec2<f32>>;
@group(1) @binding(0) var<uniform> pass_view: PassView;
// The instance fade table again, for the faded vertex entries' far-field grow (game systems
// LOD-18; renderer::PASS_FADE_GROWS_BINDING): only the faded pipelines' group 1 holds it, so no
// other pipeline's vertex stage counts it.
@group(1) @binding(2) var<storage, read> lod_grows: array<vec2<f32>>;

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

// `VsOut` with the vertex's visible-list slot (its index into the instance fade table): the
// faded entries' varyings (game systems LOD-04). Location for location `VsOut`'s, then the slot.
struct VsFadeOut {
    @builtin(position) @invariant clip: vec4<f32>,
    @location(0) world_pos: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) uv: vec2<f32>,
    @location(3) tangent: vec4<f32>,
    @location(4) @interpolate(flat) material: u32,
    @location(5) @interpolate(flat) fade_at: u32,
}

// A faded colour fragment: the shading and the samples of the pixel its level keeps.
struct FadeTarget {
    @location(0) color: vec4<f32>,
    @builtin(sample_mask) coverage: u32,
}

// The visible-list slot of batch vertex `in` (`instance`) through the pass view.
fn gx_forward_visible_at(in: VsIn, instance: u32) -> u32 {
    var start = 0u;
    if pass_view.direct == 0u {
        start = slot_base[in.slot + pass_view.slot_offset];
    }
    return visible_row(pass_view.view, pass_view.direct, pass_view.base, start, instance, frame.counts.w);
}

// The far-field grow of the copy at visible-list slot `at` (game systems LOD-18): its slot's
// grow under `GX_LOD_GROW`, else 1 (an exact product).
fn gx_forward_grow(at: u32) -> f32 {
    if GX_LOD_GROW {
        return lod_grows[at].y;
    }
    return 1.0;
}

// `vs_main` of a faded batch (game systems LOD-04): its outputs (the same expressions), with the
// slot the fragment reads its fade at, the copy grown about its origin (LOD-18).
@vertex
fn vs_main_fade(in: VsIn, @builtin(instance_index) instance: u32) -> VsFadeOut {
    let at = gx_forward_visible_at(in, instance);
    let row = instances[visible[at]];
    let world = row.model * vec4<f32>(in.position * gx_forward_grow(at), 1.0);
    var out: VsFadeOut;
    out.clip = gx_clip_position(frame.view_proj, world, frame.jitter.xy);
    out.world_pos = world.xyz;
    out.normal = (row.normal * vec4<f32>(in.normal, 0.0)).xyz;
    out.uv = in.uv;
    out.tangent = vec4<f32>((row.model * vec4<f32>(in.tangent.xyz, 0.0)).xyz, in.tangent.w);
    out.material = row.material;
    out.fade_at = at;
    return out;
}

// A faded fragment's `VsOut` (the shading's input).
fn gx_unfade(in: VsFadeOut) -> VsOut {
    return VsOut(in.clip, in.world_pos, in.normal, in.uv, in.tangent, in.material);
}

// The dither threshold of a faded fragment at `pixel`: turned by the frame on temporal paths.
fn gx_forward_fade_threshold(pixel: vec2<f32>) -> f32 {
    return gx_lod_fade_threshold(pixel, select(0u, frame.shadow_counts.z, GX_LOD_FADE_TEMPORAL));
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

// A first-person view model's fill (Bodycam light fix): a soft light from above the camera and
// to its right, behind the lens, at a level relative to the frame's exposure (scene units over the
// pre-exposure, `cascade_splits.z`), so the arms and the rifle at the lens keep their form against
// a bright sky with the sun in front, as a game's camera light would. Through the surface's own
// BRDF, so steel catches a highlight and a dark glove stays darker than a pale one: a white
// surface facing it reads at `GX_VIEW_MODEL_FILL` of middle grey's scene value twice over (the
// irradiance is pi times it, as the BRDF divides the diffuse term by pi).
const GX_VIEW_MODEL_FILL: f32 = 0.6;
const GX_VIEW_MODEL_FILL_DIRECTION: vec3<f32> = vec3<f32>(0.35, 0.55, 0.76);

fn gx_view_model_fill(s: Surface) -> vec3<f32> {
    let forward = normalize(frame.camera_forward.xyz);
    // Any up that is not the forward axis: looking straight up or down keeps a basis.
    let up_hint = select(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(0.0, 0.0, 1.0), abs(forward.y) > 0.99);
    let right = normalize(cross(forward, up_hint));
    let up = cross(right, forward);
    let d = GX_VIEW_MODEL_FILL_DIRECTION;
    let l = normalize(right * d.x + up * d.y - forward * d.z);
    let level = GX_VIEW_MODEL_FILL * PI / max(frame.cascade_splits.z, 1e-6);
    return shade(s.n, s.v, l, vec3<f32>(level), s.albedo, s.metallic, s.roughness);
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
    let ext = material_ext[in.material];
    gx_view_model = (u32(max(ext.params.z, 0.0)) & GX_MATERIAL_VIEW_MODEL) != 0u;
    let mapped = gx_surface_uv(ext.uv, ext.tiling, in.uv, tangent, in.world_pos, in.normal * facing);
    // The layered parts' gradients and frame (AAA materials, shaders/lighting/layers.wgsl), taken
    // here in uniform control flow; parallax moves the base layer's UVs before any fetch.
    let lod_scale = exp2(gx_texture_lod_bias());
    let uv_dx = dpdx(mapped.uv) * lod_scale;
    let uv_dy = dpdy(mapped.uv) * lod_scale;
    let layer_frame = gx_layer_frame(in.normal * facing, mapped.tangent);
    let to_camera = frame.camera_pos.xyz - in.world_pos;
    let base_uv = gx_parallax_uv(ext, mapped.uv, uv_dx, uv_dy, layer_frame, normalize(to_camera));
    var s = gx_surface(in.world_pos, in.normal * facing, base_uv, mapped.tangent, in.material);
    s.v = normalize(frame.camera_pos.xyz - in.world_pos);
    // The occlusion map eased from 1 by its strength (P2-0.12 LG-09).
    gx_material_ao = mix(1.0, gx_material_ao, ext.emissive.w);
    // The detail maps, the second layer and the cover, then the extra lobes' state for `shade`
    // (AAA materials); a material without layers keeps its surface as built.
    s = gx_layered_surface(s, ext, base_uv, uv_dx, uv_dy, layer_frame, length(to_camera), vec4<f32>(0.0));
    gx_lobes_begin(ext, layer_frame);
    // A transmissive material (`KHR_materials_transmission`, thin-walled) shows the background
    // through by the share it lets pass: its diffuse dims by its transmission.
    let transmitted = gx_transmitted(ext, dot(s.n, s.v));
    if transmitted > 0.0 {
        s.albedo *= 1.0 - ext.transmission.w * (1.0 - s.metallic);
    }
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
    if gx_view_model {
        color += gx_view_model_fill(s);
    }
    color += gx_emission(ext, mapped.uv);
    color = gx_forward_fog(color, s.world_pos);
    if transmitted > 0.0 {
        // Blended over the frame by `alpha (1 - transmitted)`: the lit colour lands whole and the
        // background shows through by the transmitted share.
        let kept = max(1.0 - transmitted, 0.02);
        return vec4<f32>(color / kept, s.alpha * kept);
    }
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

// A faded batch's shading (game systems LOD-04): `fs_main`, covering the samples its level keeps
// (`sample_mask`: under MSAA both levels share the pixel in proportion, no stipple; at one sample
// the pixel is its level's or the other's). It shades over its own depth step's or the prepass's
// depth with `Equal` too, where both levels of a crossfade may pass the test (coincident
// surfaces), so it applies the same cut as the depth step did: `GX_LOD_FADE_SAMPLES` 1 keeps or
// drops the whole pixel (an alpha-tested batch, whose depth step cut whole pixels). It never
// discards, and writes no coverage the pipeline's alpha-to-coverage would own (its pipelines
// have none).
@fragment
fn fs_main_fade(in: VsFadeOut, @builtin(front_facing) front: bool) -> FadeTarget {
    var out: FadeTarget;
    out.color = vec4<f32>(gx_encode_ldr(surface(gx_unfade(in), front).rgb), 1.0);
    out.coverage = 0xffffffffu;
    if GX_LOD_FADE {
        let fade = instance_fade[in.fade_at].x;
        let threshold = gx_forward_fade_threshold(in.clip.xy);
        out.coverage = select(gx_lod_fade_coverage(fade, threshold, GX_LOD_FADE_SAMPLES), select(0u, 0xffffffffu, gx_lod_fade_keeps(fade, threshold)), GX_LOD_FADE_SAMPLES <= 1u);
    }
    return out;
}

// A faded alpha-tested batch's depth step (game systems LOD-04): `fs_mask_depth` with the pixels
// the other level keeps cut away. Its pipeline keeps alpha-to-coverage under MSAA, which owns
// the samples' coverage, so the fade discards whole pixels and never writes `sample_mask`.
@fragment
fn fs_mask_depth_fade(in: VsFadeOut) -> @location(0) vec4<f32> {
    let kept = gx_alpha_mask(in.material, in.uv, in.world_pos, frame.shadow_counts.z);
    let faded = GX_LOD_FADE && !gx_lod_fade_keeps(instance_fade[in.fade_at].x, gx_forward_fade_threshold(in.clip.xy));
    if faded || (GX_ALPHA_MODE != GX_ALPHA_TO_COVERAGE && kept <= 0.0) {
        discard;
    }
    return vec4<f32>(0.0, 0.0, 0.0, kept);
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
