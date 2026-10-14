// genex WGSL extension API v2: the prelude of `gfx.post_pass` at `[[wgsl]] api = 2`. The renderer
// prepends shaders/common.wgsl and this file to the game's source. The game writes
// `@fragment fn fs_post(in: GxPostInV2) -> @location(0) vec4<f32>` and may bind its own group 2:
// one `var<uniform>` at @binding(0) (at most EXTENSION_UNIFORM_MAX_BYTES), up to four
// `texture_2d<f32>` and two samplers from asset handles. Group 1 and group 3 are reserved.
//
// Stage `hdr` (`gfx.post_pass(path, stage)`) runs after TAA's place and before bloom and the
// tonemap: `gx_scene` is the linear HDR scene at render size, pre-exposed (`gx_pre_exposure()`),
// and the output replaces it in the same space (alpha ignored; add colour in scene units through
// `gx_expose`). Stage `ldr` runs where v1 post passes run, on the display-ready frame.
//
// `gx_depth`, `gx_normals` (octahedral, rg16float), `gx_motion` (NDC motion, current minus
// previous with TAA's jitter removed, rg16float: last frame's uv is `uv - gx_motion * vec2(0.5,
// -0.5)`), `gx_ao` and the environment are produced only when some consumer asks for them
// (a declared input); until then they hold 1x1 neutral values: far depth, zero normals and
// motion, no occlusion, no environment light. Read depth through `gx_linear_depth`, which knows
// the depth convention (`depth_reversed`) and the projection. Names starting `gx_` and the
// renderer's structs in common.wgsl are reserved.

// x, y: the size of gx_scene in pixels; output_size: the world target's; texel: one gx_scene
// pixel in uv; time: simulated seconds; pass_index: the pass's index in the frame; stage_hdr: 1
// at stage hdr.
struct GxPostV2 {
    render_size: vec2<f32>,
    output_size: vec2<f32>,
    texel: vec2<f32>,
    jitter: vec2<f32>,
    time: f32,
    pass_index: u32,
    frame_index: u32,
    depth_reversed: u32,
    pre_exposure: f32,
    stage_hdr: u32,
    reserved0: u32,
    reserved1: u32,
}

struct GxPostInV2 {
    @builtin(position) position: vec4<f32>,
    // (0, 0) the top-left corner, (1, 1) the bottom-right.
    @location(0) uv: vec2<f32>,
}

// Group 0: the renderer's (abi.rs POST_V2_BINDINGS).
@group(0) @binding(0) var gx_scene: texture_2d<f32>;
@group(0) @binding(1) var gx_sampler: sampler;
@group(0) @binding(2) var<uniform> gx_post: GxPostV2;
@group(0) @binding(3) var<uniform> gx_frame: GxFrameV2;
@group(0) @binding(4) var gx_depth: texture_depth_2d;
@group(0) @binding(5) var gx_normals: texture_2d<f32>;
@group(0) @binding(6) var gx_motion: texture_2d<f32>;
@group(0) @binding(7) var gx_ao: texture_2d<f32>;
@group(0) @binding(8) var gx_env_specular: texture_cube<f32>;
@group(0) @binding(9) var<uniform> gx_env_sh: GxEnvSh;
@group(0) @binding(10) var gx_point_sampler: sampler;

@vertex
fn gx_vs_post_v2(@builtin(vertex_index) index: u32) -> GxPostInV2 {
    let uv = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
    var out: GxPostInV2;
    out.position = vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
    out.uv = uv;
    return out;
}

// The uv of a fragment's `position` in gx_scene.
fn gx_scene_uv(position: vec4<f32>) -> vec2<f32> {
    return position.xy / gx_post.render_size;
}

// The view distance at `uv` (scene depth, read without filtering).
fn gx_linear_depth(uv: vec2<f32>) -> f32 {
    let size = vec2<i32>(textureDimensions(gx_depth));
    let pixel = clamp(vec2<i32>(uv * vec2<f32>(size)), vec2<i32>(0), size - vec2<i32>(1));
    return gx_view_distance(gx_frame.proj, textureLoad(gx_depth, pixel, 0));
}

// The largest radiance the HDR scene stores (lighting/output.wgsl's GX_SCENE_RADIANCE_MAX).
const GX_POST_RADIANCE_MAX: f32 = 64512.0;

// The exposure gx_scene is written with: at stage hdr the frame's (auto exposure's GPU value when
// the renderer binds gx_frame), 1 at stage ldr.
fn gx_pre_exposure() -> f32 {
    if gx_post.stage_hdr == 1u && gx_frame.pre_exposure > 0.0 {
        return gx_frame.pre_exposure;
    }
    return gx_post.pre_exposure;
}

// Scene-unit radiance as gx_scene holds it: times the pre-exposure (1 at stage ldr), never
// negative and held under the half-float limit, so a blinding pass never stores inf.
fn gx_expose(color: vec3<f32>) -> vec3<f32> {
    return min(max(color, vec3<f32>(0.0)) * gx_pre_exposure(), vec3<f32>(GX_POST_RADIANCE_MAX));
}
