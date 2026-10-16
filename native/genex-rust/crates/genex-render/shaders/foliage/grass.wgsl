// Grass shading (renderer pass 2 A.8): the world pass's, the prepass's and the motion prepass's
// entry points, concatenated after the forward module's sources (`foliage::gpu::GRASS`), so a blade
// reads the forward frame group (group 0), the pass view (group 1) and the grass group (group 2) and
// shades through the same lighting chunks as every built-in surface: the sun with its cascades,
// mask and contact shadows, the sky and the probes with AO, the local lights, the air and the fog.
//
// Both faces draw (no culling); the face seen turns its normal to the viewer, keeping it up. The
// light through a blade is a second Lambert lobe about its back (diffuse transmission, after
// Bevy 0.20's `pbr_functions.wesl`, the idea only) under the same sun visibility as its front:
// a blade is thin, so what shadows one face shadows the other.

struct GxGrassOut {
    @builtin(position) @invariant clip: vec4<f32>,
    @location(0) world_pos: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) along: f32,
    @location(3) @interpolate(flat) layer_kind: vec2<u32>,
    @location(4) @interpolate(flat) tint_width: vec2<f32>,
}

@vertex
fn vs_grass(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> GxGrassOut {
    let blade = gx_grass_blade(instance);
    let point = gx_grass_point(blade, vertex, gx_grass.time.x, frame.camera_pos.xyz);
    var out: GxGrassOut;
    out.clip = gx_clip_position(frame.view_proj, vec4<f32>(point.position, 1.0), frame.jitter.xy);
    out.world_pos = point.position;
    out.normal = point.normal;
    out.along = point.along;
    out.layer_kind = vec2<u32>(blade.layer, blade.kind);
    out.tint_width = vec2<f32>(blade.tint, point.tip_width);
    return out;
}

// A flower's colour fades in from this on-screen width of its tip (pixels) to whole at the second
// (renderer pass 2 B.7's rule): a far flower is far under a pixel, and a bright point the jitter
// hits in some frames only pops for one.
const GX_GRASS_FLOWER_SHOWN_PX: vec2<f32> = vec2<f32>(0.5, 1.5);
// The share of the blade's top a flower covers.
const GX_GRASS_FLOWER_FROM: f32 = 0.8;
// The blade's own occlusion at its foot (the meadow's floor sees little sky).
const GX_GRASS_FOOT_OCCLUSION: f32 = 0.45;
const GX_GRASS_ROUGHNESS: f32 = 0.55;
// The light through a blade leans forwards: looking into the sun it is up to this many times the
// Lambert lobe's (a thin leaf scatters mostly onwards), side-on this share of it.
const GX_GRASS_FORWARD_SCATTER: vec2<f32> = vec2<f32>(0.6, 2.2);
const GX_GRASS_FORWARD_POWER: f32 = 4.0;

// The normal turned to the viewer at `world_pos`: the face seen from behind mirrors it about the
// vertical (the blade's up-turn kept). Decided by the normal, not the winding, so either face of a
// strip shades as the face the viewer sees.
fn gx_grass_facing(normal: vec3<f32>, world_pos: vec3<f32>) -> vec3<f32> {
    let n = normalize(normal);
    let to_eye = frame.camera_pos.xyz - world_pos;
    if dot(n.xz, to_eye.xz) >= 0.0 {
        return n;
    }
    return vec3<f32>(-n.x, n.y, -n.z);
}

// The blade's albedo at a fragment (`footprint`: the fragment's size on the blade, metres).
fn gx_grass_albedo(layer: GxGrassLayer, kind: u32, along: f32, tint: f32, tip_width: f32, footprint: f32) -> vec3<f32> {
    var tip = layer.tip.rgb;
    if kind == GX_GRASS_DRY {
        tip = mix(layer.tip.rgb, layer.dry.rgb, 0.4 + 0.6 * tint);
    }
    var albedo = mix(layer.root.rgb, tip, pow(along, 0.8)) * (0.82 + 0.36 * tint);
    if kind == GX_GRASS_FLOWER && along > GX_GRASS_FLOWER_FROM {
        let shown = smoothstep(GX_GRASS_FLOWER_SHOWN_PX.x, GX_GRASS_FLOWER_SHOWN_PX.y, tip_width / max(footprint, 1e-6));
        albedo = mix(albedo, layer.flower.rgb, shown);
    }
    return albedo;
}

@fragment
fn fs_grass(in: GxGrassOut) -> @location(0) vec4<f32> {
    gx_sun_shadow_context(in.clip.xy, frame.shadow_counts.z, frame.shadow_soft.y);
    gx_sun_shadow_end_fade(frame.shadow_soft.z);
    // The fragment's footprint on the blade: its clip w times one render pixel at w = 1. Never a
    // screen derivative: across a quad of sub-pixel blades that came out differently from one run
    // to the next (GA1 wave 4), and a settled capture with it.
    let m = frame.view_proj;
    let w = dot(vec4<f32>(m[0][3], m[1][3], m[2][3], m[3][3]), vec4<f32>(in.world_pos, 1.0));
    let footprint = w * gx_grass.time.w;
    let layer = gx_grass.layers[in.layer_kind.x];
    let n = gx_grass_facing(in.normal, in.world_pos);
    let albedo = gx_grass_albedo(layer, in.layer_kind.y, in.along, in.tint_width.x, in.tint_width.y, footprint);
    // A blade is thin: its shadow lookups lift off the face the sun lights (the receivers'
    // normal offset), whichever face the viewer sees, so a back-lit blade does not read its own
    // caster as a blocker.
    let to_sun = normalize(frame.sun_dir.xyz);
    let lit_face = select(-n, n, dot(n, to_sun) >= 0.0);
    var s = Surface(in.world_pos, lit_face, n, vec3<f32>(0.0), albedo, 1.0, 0.0, GX_GRASS_ROUGHNESS);
    s.v = normalize(frame.camera_pos.xyz - in.world_pos);
    gx_material_ao = mix(GX_GRASS_FOOT_OCCLUSION, 1.0, in.along);
    var sun = to_sun;
    if GX_SCENE_HDR {
        sun = gx_sun_area_direction(sun, frame.sun_dir.w, s.n, s.v);
    }
    var color = gx_ambient(s);
    let visibility = gx_sun_visibility(s) * gx_contact_shadow(s.world_pos);
    color += shade(s.n, s.v, sun, frame.sun_color.rgb, s.albedo, s.metallic, s.roughness) * visibility;
    // The light through the blade from behind it, leaning onwards, more where the blade is thin.
    let onwards = pow(max(dot(-s.v, sun), 0.0), GX_GRASS_FORWARD_POWER);
    let lobe = mix(GX_GRASS_FORWARD_SCATTER.x, GX_GRASS_FORWARD_SCATTER.y, onwards);
    let through = max(dot(-s.n, sun), 0.0) * layer.shape.w * lobe * sqrt(in.along);
    color += albedo * frame.sun_color.rgb * (through / PI) * visibility;
    color = gx_local_lights(color, s);
    color = gx_forward_fog(color, s.world_pos);
    return vec4<f32>(gx_encode_ldr(color), 1.0);
}

// The prepass: the blade's depth and its normal turned to the viewer.
@fragment
fn fs_grass_prepass(in: GxGrassOut) -> @location(0) vec2<f32> {
    return gx_oct_encode(gx_grass_facing(in.normal, in.world_pos));
}

// --- The motion prepass (RQ5.6): group 3 is the motion node's group (`motion::MotionNode`). A
// blade moves by the camera and by its sway between last frame's time and this frame's.

// Mirrors `motion::GpuMotionFrame` (prepass.wgsl's `MotionFrame`).
struct GxGrassMotionFrame {
    prev_view_proj: mat4x4<f32>,
    jitter: vec4<f32>,
    reproject: mat4x4<f32>,
}

@group(3) @binding(0) var<uniform> gx_grass_motion: GxGrassMotionFrame;

struct GxGrassMotionOut {
    @builtin(position) @invariant clip: vec4<f32>,
    @location(0) normal: vec3<f32>,
    @location(1) current: vec4<f32>,
    @location(2) previous: vec4<f32>,
    @location(3) world_pos: vec3<f32>,
}

struct GxGrassMotionTargets {
    @location(0) normal: vec2<f32>,
    @location(1) motion: vec2<f32>,
    @location(2) reactive: f32,
}

@vertex
fn vs_grass_motion(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> GxGrassMotionOut {
    let blade = gx_grass_blade(instance);
    let camera = frame.camera_pos.xyz;
    let now = gx_grass_point(blade, vertex, gx_grass.time.x, camera);
    let before = gx_grass_point(blade, vertex, gx_grass.time.y, camera);
    var out: GxGrassMotionOut;
    out.clip = gx_clip_position(frame.view_proj, vec4<f32>(now.position, 1.0), gx_grass_motion.jitter.xy);
    out.normal = now.normal;
    out.world_pos = now.position;
    out.current = frame.view_proj * vec4<f32>(now.position, 1.0);
    out.previous = gx_grass_motion.prev_view_proj * vec4<f32>(before.position, 1.0);
    return out;
}

@fragment
fn fs_grass_motion(in: GxGrassMotionOut) -> GxGrassMotionTargets {
    var out: GxGrassMotionTargets;
    out.normal = gx_oct_encode(gx_grass_facing(in.normal, in.world_pos));
    out.reactive = 0.0;
    out.motion = vec2<f32>(0.0);
    // A point behind last frame's camera has no reprojection: no motion, and no history.
    if in.previous.w <= 1e-6 || in.current.w <= 1e-6 {
        out.reactive = 1.0;
        return out;
    }
    out.motion = in.current.xy / in.current.w - in.previous.xy / in.previous.w;
    return out;
}
