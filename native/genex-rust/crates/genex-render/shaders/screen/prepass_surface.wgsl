// The prepass's surface twin (lane FR; graph node 7 on a frame that traces screen-space
// reflections): the opaque plain batches the motion prepass draws (`vs_prepass_motion`,
// `fs_prepass_motion` in prepass.wgsl), expression for expression, with the forward vertex
// shader's varyings carried as well, so the same fragment also writes A.6's normal and roughness
// (`gx_ssr_surface_texel`, ssr_surface.wgsl) at location 3. Before lane FR a pass of its own drew
// the batches again over the prepass depth (`Equal`) for that texel alone. Concatenated after the
// forward module's sources and prepass_motion.wgsl (`shaders::PREPASS_SURFACE`).

struct PrepassSurfaceOut {
    @builtin(position) @invariant clip: vec4<f32>,
    @location(0) world_pos: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) uv: vec2<f32>,
    @location(3) tangent: vec4<f32>,
    @location(4) @interpolate(flat) material: u32,
    // The unjittered clip positions of this frame and the last (`MotionOut`'s).
    @location(5) current: vec4<f32>,
    @location(6) previous: vec4<f32>,
    @location(7) @interpolate(flat) reactive: u32,
}

struct PrepassSurfaceTargets {
    @location(0) normal: vec2<f32>,
    @location(1) motion: vec2<f32>,
    @location(2) reactive: f32,
    @location(3) surface: vec4<f32>,
}

@vertex
fn vs_prepass_surface(in: VsIn, @builtin(instance_index) instance: u32, @builtin(vertex_index) vertex: u32) -> PrepassSurfaceOut {
    var start = 0u;
    if pass_view.direct == 0u {
        start = slot_base[in.slot + pass_view.slot_offset];
    }
    let index = visible[visible_row(pass_view.view, pass_view.direct, pass_view.base, start, instance, frame.counts.w)];
    let row = instances[index];
    let prev = prev_models[index];
    let world = row.model * vec4<f32>(in.position, 1.0);
    // A still row skips the second transform (uniform across the instance's vertices).
    var prev_world = world;
    if (prev.flags.x & GX_MOTION_STILL) == 0u {
        prev_world = prev.model * vec4<f32>(gx_motion_prev_local(in.position, prev.flags, vertex), 1.0);
    }
    var out: PrepassSurfaceOut;
    out.clip = gx_clip_position(frame.view_proj, world, motion_frame.jitter.xy);
    out.world_pos = world.xyz;
    out.normal = (row.normal * vec4<f32>(in.normal, 0.0)).xyz;
    out.uv = in.uv;
    out.tangent = vec4<f32>((row.model * vec4<f32>(in.tangent.xyz, 0.0)).xyz, in.tangent.w);
    out.material = row.material;
    out.current = frame.view_proj * world;
    out.previous = motion_frame.prev_view_proj * prev_world;
    out.reactive = prev.flags.x & GX_MOTION_NO_HISTORY;
    return out;
}

@fragment
fn fs_prepass_surface(in: PrepassSurfaceOut, @builtin(front_facing) front: bool) -> PrepassSurfaceTargets {
    // The surface first: its decal gradients need uniform control flow.
    let surface = gx_ssr_surface_texel(VsOut(in.clip, in.world_pos, in.normal, in.uv, in.tangent, in.material), front);
    let motion = gx_motion_targets(in.normal * select(-1.0, 1.0, front), in.current, in.previous, in.reactive);
    return PrepassSurfaceTargets(motion.normal, motion.motion, motion.reactive, surface);
}
