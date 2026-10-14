// Immediate lines: direct draws of a per-frame line list, unlit. On the legacy scene colours arrive
// sRGB-encoded and are written as they are (the target is Bgra8Unorm); on the HDR scene they arrive
// linear and are exposed here.

@group(0) @binding(0) var<uniform> frame: FrameUniforms;

struct LineOut {
    @builtin(position) clip: vec4<f32>,
    @location(0) color: vec4<f32>,
}

@vertex
fn vs_line(@location(0) position: vec3<f32>, @location(1) color: vec4<f32>) -> LineOut {
    var out: LineOut;
    out.clip = frame.view_proj * vec4<f32>(position, 1.0);
    out.color = color;
    return out;
}

// Whether the pipeline draws the HDR scene (a pipeline-overridable constant: the legacy scene's
// lines never branch on the frame).
override GX_SCENE_HDR: bool = false;

@fragment
fn fs_line(in: LineOut) -> @location(0) vec4<f32> {
    // On the HDR path the colour arrives as linear light and is written exposed, with the exposure
    // the frame holds in `cascade_splits.z` (auto exposure's GPU value included).
    if GX_SCENE_HDR {
        return vec4<f32>(in.color.rgb * frame.cascade_splits.z, 1.0);
    }
    return vec4<f32>(in.color.rgb, 1.0);
}
