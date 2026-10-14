// TAA's reactive coverage (graph node 15a; RQ5.2): the transparent draws redrawn as coverage into
// an r8unorm mask at render size (1: take the current sample), depth-tested against the scene's
// depth without writing it and max-blended, so the no-history flags RQ5.1's prepass writes into
// the same mask stay set. Jittered exactly as the scene was, so the mask lines up with the pixels
// it marks. Its own small pass, so the world pass keeps one colour target and Level-3 in-world
// pipelines are unchanged. The forward pass's frame group binds here unchanged (a subset of it);
// particles take the entry points of `post::taa::REACTIVE_PARTICLES`.

@group(0) @binding(0) var<uniform> frame: FrameUniforms;
@group(0) @binding(1) var<storage, read> instances: array<Instance>;
@group(0) @binding(3) var<storage, read> visible: array<u32>;
@group(0) @binding(4) var<storage, read> slot_base: array<u32>;
@group(1) @binding(0) var<uniform> pass_view: PassView;

// Mirrors `post::taa::GpuReactiveJitter`.
struct ReactiveJitter {
    // xy: this frame's jitter in NDC (y up); z: the coverage of a transparent mesh; w: reserved.
    ndc: vec4<f32>,
}

@group(2) @binding(0) var<uniform> gx_reactive_jitter: ReactiveJitter;

struct ReactiveIn {
    @location(0) position: vec3<f32>,
    @location(4) slot: u32,
}

struct ReactiveOut {
    @builtin(position) clip: vec4<f32>,
}

@vertex
fn vs_reactive(in: ReactiveIn, @builtin(instance_index) instance: u32) -> ReactiveOut {
    var start = 0u;
    if pass_view.direct == 0u {
        start = slot_base[in.slot];
    }
    let row = instances[visible[visible_row(pass_view.view, pass_view.direct, pass_view.base, start, instance, frame.counts.w)]];
    return ReactiveOut(gx_clip_position(frame.view_proj, row.model * vec4<f32>(in.position, 1.0), gx_reactive_jitter.ndc.xy));
}

@fragment
fn fs_reactive(in: ReactiveOut) -> @location(0) vec4<f32> {
    return vec4<f32>(gx_reactive_jitter.ndc.z, 0.0, 0.0, 1.0);
}
