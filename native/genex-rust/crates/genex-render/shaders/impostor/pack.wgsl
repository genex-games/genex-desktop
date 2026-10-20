// Impostor pack (game systems LOD-13; a port of kansei's `impostor_pack.wgsl`, MIT): one frame's
// render (bake.wgsl's three targets and depth, `supersample` times the frame's size) folded into
// that frame of the species' layer of the three atlases, mip 0. Per atlas texel: the coverage (the
// share of its render texels the parts drew) and, over those, the averages:
// - atlas A: linear base colour, coverage;
// - atlas B: the object-space normal octahedrally encoded (xy), the depth from the frame's near
//   side of the bake sphere (0) to its far side (1), the perceptual roughness;
// - atlas C: occlusion, metallic, diffuse transmission, the material class.
// An empty texel takes the values of the nearest covered render texel within GX_PACK_DILATE atlas
// texels, so filtering and parallax near the silhouette read the object, not the background.
// Every write is a `rgba8unorm` storage texture (WebGPU core).

struct GxImpostorPack {
    // The frame's view axes, object space (`dir` points at the viewer).
    right: vec3<f32>,
    radius: f32,
    up: vec3<f32>,
    // Atlas texels per frame side.
    frame_px: u32,
    dir: vec3<f32>,
    // Render texels per atlas texel side.
    supersample: u32,
    // The frame's column and row.
    frame: vec2<u32>,
    pad: vec2<u32>,
}

@group(0) @binding(0) var albedo_target: texture_2d<f32>;
@group(0) @binding(1) var normal_target: texture_2d<f32>;
@group(0) @binding(2) var surface_target: texture_2d<f32>;
@group(0) @binding(3) var depth_target: texture_depth_2d;
@group(0) @binding(4) var atlas_a: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(5) var atlas_b: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(6) var atlas_c: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(7) var<uniform> pack: GxImpostorPack;

const GX_PACK_DILATE: i32 = 4;
// The least squared length a target normal counts as written.
const GX_PACK_NORMAL_MIN: f32 = 1.0e-4;

fn gx_pack_render_size() -> i32 {
    return i32(pack.frame_px * pack.supersample);
}

fn gx_pack_covered(p: vec2<i32>) -> bool {
    let n = gx_pack_render_size();
    if any(p < vec2<i32>(0)) || any(p >= vec2<i32>(n)) {
        return false;
    }
    return textureLoad(depth_target, p, 0) < 1.0;
}

// View-space position of render texel p (x right, y up, z towards the viewer; depth over [0, 2r]).
fn gx_pack_view_pos(p: vec2<i32>) -> vec3<f32> {
    let n = f32(gx_pack_render_size());
    let ndc = (vec2<f32>(p) + 0.5) / n * 2.0 - 1.0;
    let depth = textureLoad(depth_target, p, 0);
    return vec3<f32>(ndc.x * pack.radius, -ndc.y * pack.radius, -depth * 2.0 * pack.radius);
}

fn gx_pack_to_object(v: vec3<f32>) -> vec3<f32> {
    return pack.right * v.x + pack.up * v.y + pack.dir * v.z;
}

// The object-space normal at covered render texel p: the material's, or the depth's slope.
fn gx_pack_normal(p: vec2<i32>) -> vec3<f32> {
    let written = textureLoad(normal_target, p, 0).xyz;
    if dot(written, written) > GX_PACK_NORMAL_MIN {
        return normalize(written);
    }
    let c = gx_pack_view_pos(p);
    let step = 2.0 * pack.radius / f32(gx_pack_render_size());
    var dx = vec3<f32>(step, 0.0, 0.0);
    var dy = vec3<f32>(0.0, -step, 0.0);
    if gx_pack_covered(p + vec2<i32>(1, 0)) {
        dx = gx_pack_view_pos(p + vec2<i32>(1, 0)) - c;
    } else if gx_pack_covered(p - vec2<i32>(1, 0)) {
        dx = c - gx_pack_view_pos(p - vec2<i32>(1, 0));
    }
    if gx_pack_covered(p + vec2<i32>(0, 1)) {
        dy = gx_pack_view_pos(p + vec2<i32>(0, 1)) - c;
    } else if gx_pack_covered(p - vec2<i32>(0, 1)) {
        dy = c - gx_pack_view_pos(p - vec2<i32>(0, 1));
    }
    var n = normalize(cross(dy, dx));
    if n.z < 0.0 {
        n = -n;
    }
    return gx_pack_to_object(n);
}

// The octahedral encoding of unit vector n into [0, 1] squared (the whole sphere).
fn gx_impostor_oct_encode(n: vec3<f32>) -> vec2<f32> {
    let v = n / (abs(n.x) + abs(n.y) + abs(n.z));
    var e = v.xz;
    if v.y < 0.0 {
        let s = select(vec2<f32>(-1.0), vec2<f32>(1.0), v.xz >= vec2<f32>(0.0));
        e = (vec2<f32>(1.0) - abs(v.zx)) * s;
    }
    return e * 0.5 + 0.5;
}

struct GxPackTexel {
    albedo: vec3<f32>,
    normal: vec3<f32>,
    depth: f32,
    roughness: f32,
    surface: vec4<f32>,
}

fn gx_pack_texel(p: vec2<i32>) -> GxPackTexel {
    let albedo = textureLoad(albedo_target, p, 0).rgb;
    let roughness = textureLoad(normal_target, p, 0).a;
    return GxPackTexel(albedo, gx_pack_normal(p), textureLoad(depth_target, p, 0), roughness, textureLoad(surface_target, p, 0));
}

@compute @workgroup_size(8, 8, 1)
fn cs_impostor_pack(@builtin(global_invocation_id) gid: vec3<u32>) {
    if any(gid.xy >= vec2<u32>(pack.frame_px)) {
        return;
    }
    let ss = i32(pack.supersample);
    let base = vec2<i32>(gid.xy) * ss;
    var sum = GxPackTexel(vec3<f32>(0.0), vec3<f32>(0.0), 0.0, 0.0, vec4<f32>(0.0));
    var count = 0;
    for (var y = 0; y < ss; y++) {
        for (var x = 0; x < ss; x++) {
            let p = base + vec2<i32>(x, y);
            if gx_pack_covered(p) {
                let t = gx_pack_texel(p);
                sum = GxPackTexel(sum.albedo + t.albedo, sum.normal + t.normal, sum.depth + t.depth, sum.roughness + t.roughness, sum.surface + t.surface);
                count++;
            }
        }
    }
    let coverage = f32(count) / f32(ss * ss);
    var texel = GxPackTexel(vec3<f32>(0.0), pack.dir, 0.5, 1.0, vec4<f32>(1.0, 0.0, 0.0, 0.0));
    if count > 0 {
        let k = 1.0 / f32(count);
        texel = GxPackTexel(sum.albedo * k, normalize(sum.normal + vec3<f32>(0.0, 1.0e-6, 0.0)), sum.depth * k, sum.roughness * k, sum.surface * k);
    } else {
        // The nearest covered render texel, or the frame facing the viewer at the centre plane.
        var best = 1.0e9;
        let centre = base + vec2<i32>(ss / 2);
        let reach = GX_PACK_DILATE * ss;
        for (var y = -reach; y <= reach; y++) {
            for (var x = -reach; x <= reach; x++) {
                let p = centre + vec2<i32>(x, y);
                let d2 = f32(x * x + y * y);
                if d2 < best && gx_pack_covered(p) {
                    best = d2;
                    texel = gx_pack_texel(p);
                }
            }
        }
    }
    let at = vec2<i32>(pack.frame * pack.frame_px + gid.xy);
    textureStore(atlas_a, at, vec4<f32>(texel.albedo, coverage));
    textureStore(atlas_b, at, vec4<f32>(gx_impostor_oct_encode(texel.normal), texel.depth, texel.roughness));
    textureStore(atlas_c, at, texel.surface);
}
