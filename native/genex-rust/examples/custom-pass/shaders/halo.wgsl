// The halo: a flat ring around the bouncing cube, drawn inside the world pass after the opaque
// work, depth-tested through the frame's camera. `GxFrame` comes from genex's tables prelude.

struct Halo {
    // xyz: the ring's centre; w: its radius.
    center: vec4<f32>,
    color: vec4<f32>,
}

struct VsOut {
    @builtin(position) clip: vec4<f32>,
    @location(0) color: vec4<f32>,
}

@group(0) @binding(0) var<uniform> gx_frame: GxFrame;
@group(1) @binding(0) var<uniform> halo: Halo;

const SEGMENTS: u32 = 32u;
const TAU: f32 = 6.2831853;

@vertex
fn vs_halo(@builtin(vertex_index) i: u32) -> VsOut {
    // Six corners a segment: two triangles between the inner and the outer edge.
    var outer = array<f32, 6>(0.0, 1.0, 1.0, 0.0, 1.0, 0.0);
    var next = array<f32, 6>(0.0, 0.0, 1.0, 0.0, 1.0, 1.0);
    let segment = i / 6u;
    let corner = i % 6u;
    let angle = (f32(segment) + next[corner]) * TAU / f32(SEGMENTS);
    let radius = halo.center.w * (0.75 + 0.5 * outer[corner]);
    let position = halo.center.xyz + vec3<f32>(cos(angle) * radius, 0.0, sin(angle) * radius);
    var out: VsOut;
    out.clip = gx_frame.view_proj * vec4<f32>(position, 1.0);
    out.color = halo.color;
    return out;
}

@fragment
fn fs_halo(in: VsOut) -> @location(0) vec4<f32> {
    return in.color;
}
