// Vertex-animation-texture crowds (game systems AN-24). A crowd's frames live in two rgba16f
// textures, one texel per vertex per frame, frame-major and wrapped into rows of `dims.x` texels
// (src/vat.rs `VatImage`): positions relative to the bake's origin, and unit normals. A crowd
// instance draws by reading its vertex at two frames and blending them; nothing is skinned and
// nothing is written per instance. `textureLoad` reads exact texels on every backend.

struct VatParams {
    // The bake's origin (xyz) that every stored position is relative to, and its rate in frames
    // per second (w).
    origin: vec4<f32>,
    // Row width in texels, vertices per frame, frames, unused.
    dims: vec4<u32>,
}

@group(0) @binding(0) var vat_positions: texture_2d<f32>;
@group(0) @binding(1) var vat_normals: texture_2d<f32>;
@group(0) @binding(2) var<uniform> vat: VatParams;

// The texel holding `vertex` of `frame`.
fn vat_texel(frame: u32, vertex: u32) -> vec2<i32> {
    let index = frame * vat.dims.y + vertex;
    return vec2<i32>(i32(index % vat.dims.x), i32(index / vat.dims.x));
}

// The model-space position of `vertex`, `blend` of the way from `frame0` to `frame1`.
fn vat_position(frame0: u32, frame1: u32, blend: f32, vertex: u32) -> vec3<f32> {
    let a = textureLoad(vat_positions, vat_texel(frame0, vertex), 0).xyz;
    let b = textureLoad(vat_positions, vat_texel(frame1, vertex), 0).xyz;
    return mix(a, b, blend) + vat.origin.xyz;
}

// The unit normal of `vertex` between the same two frames.
fn vat_normal(frame0: u32, frame1: u32, blend: f32, vertex: u32) -> vec3<f32> {
    let a = textureLoad(vat_normals, vat_texel(frame0, vertex), 0).xyz;
    let b = textureLoad(vat_normals, vat_texel(frame1, vertex), 0).xyz;
    let n = mix(a, b, blend);
    let length_squared = dot(n, n);
    if length_squared > 0.0 {
        return n * inverseSqrt(length_squared);
    }
    return vec3<f32>(0.0, 1.0, 0.0);
}

// The decode check: every vertex between two frames, written out (position xyz, 1, normal xyz,
// 0), so a check can hold the texture path to the compute-skinned vertices.
struct VatDecode {
    frame0: u32,
    frame1: u32,
    blend: f32,
    pad: u32,
}

@group(1) @binding(0) var<uniform> decode: VatDecode;
@group(1) @binding(1) var<storage, read_write> decoded: array<vec4<f32>>;

const VAT_DECODE_WORKGROUP: u32 = 64u;

@compute @workgroup_size(64)
fn cs_vat_decode(@builtin(global_invocation_id) id: vec3<u32>) {
    let vertex = id.x;
    if vertex >= vat.dims.y {
        return;
    }
    decoded[vertex * 2u] = vec4<f32>(vat_position(decode.frame0, decode.frame1, decode.blend, vertex), 1.0);
    decoded[vertex * 2u + 1u] = vec4<f32>(vat_normal(decode.frame0, decode.frame1, decode.blend, vertex), 0.0);
}

// The crowd draw: one instance per agent, its vertex read from the textures at the two frames its
// clip and the time give. Group 1 bindings 2 and 3, apart from the decode check's.
struct VatCrowdView {
    view_proj: mat4x4<f32>,
    // The direction light travels (xyz) and the crowd's clock in seconds (w).
    sun: vec4<f32>,
}

struct VatInstance {
    model: mat4x4<f32>,
    // The clip's first frame and frame count, its length and the agent's time offset (f32 bits).
    clip: vec4<u32>,
}

@group(1) @binding(2) var<uniform> crowd: VatCrowdView;
@group(1) @binding(3) var<storage, read> instances: array<VatInstance>;

struct VatPick {
    frame0: u32,
    frame1: u32,
    blend: f32,
}

// Where `time` falls in a looping clip's frames: genex-anim's `VatBake::sample_at`.
fn vat_pick(first: u32, frames: u32, duration: f32, time: f32) -> VatPick {
    let fps = vat.origin.w;
    var local = 0.0;
    if duration > 0.0 {
        local = time - floor(time / duration) * duration;
        if local >= duration {
            local = 0.0;
        }
    }
    let last = max(frames, 1u) - 1u;
    let k = min(u32(max(local * fps, 0.0)), last);
    let next = min(k + 1u, last);
    let t0 = min(f32(k) / fps, duration);
    let t1 = min(f32(next) / fps, duration);
    var blend = 0.0;
    if t1 > t0 {
        blend = clamp((local - t0) / (t1 - t0), 0.0, 1.0);
    }
    return VatPick(first + k, first + next, blend);
}

struct VatCrowdOut {
    @builtin(position) clip: vec4<f32>,
    @location(0) normal: vec3<f32>,
}

@vertex
fn vs_vat_crowd(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> VatCrowdOut {
    let row = instances[instance];
    let pick = vat_pick(row.clip.x, row.clip.y, bitcast<f32>(row.clip.z), crowd.sun.w + bitcast<f32>(row.clip.w));
    let position = vat_position(pick.frame0, pick.frame1, pick.blend, vertex);
    let normal = vat_normal(pick.frame0, pick.frame1, pick.blend, vertex);
    var out: VatCrowdOut;
    out.clip = crowd.view_proj * (row.model * vec4<f32>(position, 1.0));
    out.normal = (row.model * vec4<f32>(normal, 0.0)).xyz;
    return out;
}

// A plain lit surface: the crowd draw's own look until the world pass draws VAT instances.
@fragment
fn fs_vat_crowd(in: VatCrowdOut) -> @location(0) vec4<f32> {
    let lit = max(dot(normalize(in.normal), -crowd.sun.xyz), 0.0);
    return vec4<f32>(vec3<f32>(0.78, 0.66, 0.52) * (0.25 + 0.75 * lit), 1.0);
}
