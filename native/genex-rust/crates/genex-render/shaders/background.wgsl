// The HDR scene's background under auto exposure (RQ1 review): the clear colour drawn as a
// full-screen triangle first in the world pass, exposed on the GPU with the frame's pre-exposure
// lane (`cascade_splits.z`, where auto exposure copies its adapted value), so the background is
// exposed as the geometry is. Vertices arrive in clip space with the clear colour as linear light;
// depth is neither tested nor written.

@group(0) @binding(0) var<uniform> frame: FrameUniforms;

// The largest radiance the HDR scene stores (lighting/output.wgsl's GX_SCENE_RADIANCE_MAX).
const GX_BACKGROUND_RADIANCE_MAX: f32 = 64512.0;

struct BackgroundOut {
    @builtin(position) clip: vec4<f32>,
    @location(0) color: vec4<f32>,
}

@vertex
fn vs_background(@location(0) position: vec3<f32>, @location(1) color: vec4<f32>) -> BackgroundOut {
    var out: BackgroundOut;
    out.clip = vec4<f32>(position.xy, 0.5, 1.0);
    out.color = color;
    return out;
}

@fragment
fn fs_background(in: BackgroundOut) -> @location(0) vec4<f32> {
    return vec4<f32>(min(in.color.rgb * frame.cascade_splits.z, vec3<f32>(GX_BACKGROUND_RADIANCE_MAX)), 1.0);
}
