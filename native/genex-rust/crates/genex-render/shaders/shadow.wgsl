// Shadow casters: depth only, into one cascade's layer. Instances come through the cascade's
// region of the visible list, which the cull pass filled against the cascade's light frustum.
//
// Pancaking: casters nearer the sun than the cascade's near plane land on it (shadow_caster.wgsl:
// unclipped depth where the device has it, else the vertex clamp and `fs_shadow_caster`).

@group(0) @binding(0) var<uniform> frame: FrameUniforms;
@group(0) @binding(1) var<storage, read> instances: array<Instance>;
@group(0) @binding(2) var<storage, read> visible: array<u32>;
@group(0) @binding(3) var<storage, read> slot_base: array<u32>;
// An alpha-tested caster's material inputs (P2-0.12, the alpha-mask chunk; layout::SHADOW_MASK_BINDINGS).
@group(0) @binding(4) var<storage, read> materials: array<Material>;
@group(0) @binding(5) var<storage, read> material_ext: array<GxMaterialExt>;
@group(0) @binding(6) var color_textures: texture_2d_array<f32>;
@group(0) @binding(7) var color_textures_512: texture_2d_array<f32>;
@group(0) @binding(8) var color_textures_1024: texture_2d_array<f32>;
@group(0) @binding(9) var color_textures_2048: texture_2d_array<f32>;
@group(0) @binding(10) var texture_sampler: sampler;
// The instance fade table (game systems LOD-04; renderer::SHADOW_INSTANCE_FADE), read by the
// faded casters' fragments: the frame layout's binding 31, at the casters' group's binding 11.
@group(0) @binding(11) var<storage, read> instance_fade: array<vec2<f32>>;
@group(1) @binding(0) var<uniform> pass_view: PassView;
// The instance fade table again, for the faded vertex entries' far-field grow (game systems
// LOD-18; renderer::PASS_FADE_GROWS_BINDING): only the faded pipelines' group 1 holds it, so no
// other pipeline's vertex stage counts it.
@group(1) @binding(2) var<storage, read> lod_grows: array<vec2<f32>>;

@vertex
fn vs_shadow(@location(0) position: vec3<f32>, @location(4) slot: u32, @builtin(instance_index) instance: u32) -> ShadowCasterOut {
    let row = instances[visible[visible_row(pass_view.view, 0u, 0u, slot_base[slot + pass_view.slot_offset], instance, frame.counts.w)]];
    return gx_shadow_caster(frame.cascade_view_proj[pass_view.view - 1u] * (row.model * vec4<f32>(position, 1.0)));
}

// --- Alpha-tested casters (P2-0.12): the cutout casts its own shape. The plain alpha test at the
// material's cutoff (`GX_ALPHA_TEST`): a hashed or coverage edge would shimmer in the filtered map.

struct ShadowMaskOut {
    @builtin(position) clip: vec4<f32>,
    @location(0) light_z: f32,
    @location(1) uv: vec2<f32>,
    @location(2) world: vec3<f32>,
    @location(3) @interpolate(flat) material: u32,
}

@vertex
fn vs_shadow_mask(@location(0) position: vec3<f32>, @location(2) uv: vec2<f32>, @location(4) slot: u32, @builtin(instance_index) instance: u32) -> ShadowMaskOut {
    let row = instances[visible[visible_row(pass_view.view, 0u, 0u, slot_base[slot + pass_view.slot_offset], instance, frame.counts.w)]];
    let world = row.model * vec4<f32>(position, 1.0);
    let caster = gx_shadow_caster(frame.cascade_view_proj[pass_view.view - 1u] * world);
    var out: ShadowMaskOut;
    out.clip = caster.clip;
    out.light_z = caster.light_z;
    out.uv = uv;
    out.world = world.xyz;
    out.material = row.material;
    return out;
}

// The cutout cut away; the rasterizer's depth (unclipped depth: the hardware bias applies).
@fragment
fn fs_shadow_mask(in: ShadowMaskOut) {
    // The casters' plain test reads no frame key (the frame row is the vertex stage's alone).
    if gx_alpha_mask(in.material, in.uv, in.world, 0u) <= 0.0 {
        discard;
    }
}

// The cutout cut away; the true depth clamped onto the near plane and biased as
// `fs_shadow_caster` writes it (devices without unclipped depth).
@fragment
fn fs_shadow_mask_depth(in: ShadowMaskOut) -> @builtin(frag_depth) f32 {
    let depth = gx_shadow_caster_depth(in.light_z);
    if gx_alpha_mask(in.material, in.uv, in.world, 0u) <= 0.0 {
        discard;
    }
    return depth;
}

// --- The LOD crossfade's faded casters (game systems LOD-04) ---------------------------------
// The casters' entries with the vertex's visible-list slot carried to the fragment, which cuts
// away the texels the other level of the crossfade casts. The threshold is not turned by the
// frame (the frame row is the vertex stage's alone, and a filtered map would shimmer).

// The visible-list slot of a caster vertex (slot `slot`, `instance`) through the cascade's view.
fn gx_shadow_visible_at(slot: u32, instance: u32) -> u32 {
    return visible_row(pass_view.view, 0u, 0u, slot_base[slot + pass_view.slot_offset], instance, frame.counts.w);
}

// The far-field grow of the caster at slot `at` (LOD-18): its slot's under `GX_LOD_GROW`, else 1.
fn gx_shadow_grow(at: u32) -> f32 {
    if GX_LOD_GROW {
        return lod_grows[at].y;
    }
    return 1.0;
}

// Whether a faded caster's texel at `pixel` whose vertex read slot `at` is its level's.
fn gx_shadow_fade_keeps(at: u32, pixel: vec2<f32>) -> bool {
    return !GX_LOD_FADE || gx_lod_fade_keeps(instance_fade[at].x, gx_lod_fade_threshold(pixel, 0u));
}

struct ShadowFadeOut {
    @builtin(position) clip: vec4<f32>,
    @location(0) light_z: f32,
    @location(1) @interpolate(flat) fade_at: u32,
}

@vertex
fn vs_shadow_fade(@location(0) position: vec3<f32>, @location(4) slot: u32, @builtin(instance_index) instance: u32) -> ShadowFadeOut {
    let at = gx_shadow_visible_at(slot, instance);
    let row = instances[visible[at]];
    let caster = gx_shadow_caster(frame.cascade_view_proj[pass_view.view - 1u] * (row.model * vec4<f32>(position * gx_shadow_grow(at), 1.0)));
    return ShadowFadeOut(caster.clip, caster.light_z, at);
}

// The other level's texels cut away; the rasterizer's depth (unclipped depth).
@fragment
fn fs_shadow_fade(in: ShadowFadeOut) {
    if !gx_shadow_fade_keeps(in.fade_at, in.clip.xy) {
        discard;
    }
}

// The other level's texels cut away; the true depth clamped onto the near plane and biased
// (`fs_shadow_caster`; devices without unclipped depth).
@fragment
fn fs_shadow_caster_fade(in: ShadowFadeOut) -> @builtin(frag_depth) f32 {
    let depth = gx_shadow_caster_depth(in.light_z);
    if !gx_shadow_fade_keeps(in.fade_at, in.clip.xy) {
        discard;
    }
    return depth;
}

struct ShadowMaskFadeOut {
    @builtin(position) clip: vec4<f32>,
    @location(0) light_z: f32,
    @location(1) uv: vec2<f32>,
    @location(2) world: vec3<f32>,
    @location(3) @interpolate(flat) material: u32,
    @location(4) @interpolate(flat) fade_at: u32,
}

@vertex
fn vs_shadow_mask_fade(@location(0) position: vec3<f32>, @location(2) uv: vec2<f32>, @location(4) slot: u32, @builtin(instance_index) instance: u32) -> ShadowMaskFadeOut {
    let at = gx_shadow_visible_at(slot, instance);
    let row = instances[visible[at]];
    let world = row.model * vec4<f32>(position * gx_shadow_grow(at), 1.0);
    let caster = gx_shadow_caster(frame.cascade_view_proj[pass_view.view - 1u] * world);
    return ShadowMaskFadeOut(caster.clip, caster.light_z, uv, world.xyz, row.material, at);
}

@fragment
fn fs_shadow_mask_fade(in: ShadowMaskFadeOut) {
    let kept = gx_alpha_mask(in.material, in.uv, in.world, 0u);
    if kept <= 0.0 || !gx_shadow_fade_keeps(in.fade_at, in.clip.xy) {
        discard;
    }
}

@fragment
fn fs_shadow_mask_depth_fade(in: ShadowMaskFadeOut) -> @builtin(frag_depth) f32 {
    let depth = gx_shadow_caster_depth(in.light_z);
    let kept = gx_alpha_mask(in.material, in.uv, in.world, 0u);
    if kept <= 0.0 || !gx_shadow_fade_keeps(in.fade_at, in.clip.xy) {
        discard;
    }
    return depth;
}
