// Shadow casters: depth only, into one cascade's layer. Instances come through the cascade's
// region of the visible list, which the cull pass filled against the cascade's light frustum.
//
// Pancaking: casters nearer the sun than the cascade's near plane land on it (shadow_caster.wgsl:
// unclipped depth where the device has it, else the vertex clamp and `fs_shadow_caster`).

@group(0) @binding(0) var<uniform> frame: FrameUniforms;
@group(0) @binding(1) var<storage, read> instances: array<Instance>;
@group(0) @binding(2) var<storage, read> visible: array<u32>;
@group(0) @binding(3) var<storage, read> slot_base: array<u32>;
@group(1) @binding(0) var<uniform> pass_view: PassView;

@vertex
fn vs_shadow(@location(0) position: vec3<f32>, @location(4) slot: u32, @builtin(instance_index) instance: u32) -> ShadowCasterOut {
    let row = instances[visible[visible_row(pass_view.view, 0u, 0u, slot_base[slot], instance, frame.counts.w)]];
    return gx_shadow_caster(frame.cascade_view_proj[pass_view.view - 1u] * (row.model * vec4<f32>(position, 1.0)));
}
