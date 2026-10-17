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
@group(1) @binding(0) var<uniform> pass_view: PassView;

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
