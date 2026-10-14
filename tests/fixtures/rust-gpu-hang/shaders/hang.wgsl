// The looping shader: every pixel of the finished frame spins `spin.count` times (the game writes
// u32::MAX), so one frame keeps the GPU busy far past any step or capture deadline. The loop is
// bounded, so no compiler may treat it as undefined and drop it; it is only too long to finish.

struct Spin {
    count: u32,
    pad0: u32,
    pad1: u32,
    pad2: u32,
}

@group(0) @binding(0) var<uniform> spin: Spin;

@vertex
fn vs_hang(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
    let uv = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
    return vec4<f32>(uv * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn fs_hang(@builtin(position) at: vec4<f32>) -> @location(0) vec4<f32> {
    var acc = fract(at.x * 0.013 + at.y * 0.007);
    var i = 0u;
    loop {
        if i >= spin.count {
            break;
        }
        acc = fract(acc * 1.0001 + 0.37);
        i = i + 1u;
    }
    return vec4<f32>(acc, acc, acc, 1.0);
}
