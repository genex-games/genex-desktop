// DDGI software-ray cost probe (renderer pass 2 B.11, the D8 go/no-go measurement; tests/ddgi.rs).
//
// The work a DDGI update does each frame with software rays (no ray query, R4 is out of scope):
// every updated probe casts `rays_per_probe` rays on a spherical Fibonacci set turned by a per-frame
// rotation (Majercik et al., JCGT 2019), each ray walks a BVH2 to its closest triangle, a hit is
// shaded with the sun through a second, any-hit shadow ray plus the last update's irradiance at the
// hit (the multi-bounce read: three filtered fetches of an ambient-cube atlas, as A.4's lookup), and a
// miss takes the sky. `cs_blend` then folds a probe's rays into its six ambient-cube texels with
// hysteresis, as A.4's atlas holds them. Albedo is one colour a triangle (a real update would also
// fetch the material's texture), so the cost measured here is a floor.
//
// The BVH is a binary tree whose inner nodes hold both children's boxes (one 64-byte fetch decides
// both); a child with `n > 0` is a leaf of `n` triangles from `first`, otherwise `first` is a node.

struct Child {
    lo: vec3<f32>,
    first: u32,
    hi: vec3<f32>,
    n: u32,
}

struct Node {
    a: Child,
    b: Child,
}

// v0.w carries the triangle's albedo as rgba8 bits.
struct Tri {
    v0: vec4<f32>,
    e1: vec4<f32>,
    e2: vec4<f32>,
}

struct Params {
    rot0: vec4<f32>,
    rot1: vec4<f32>,
    rot2: vec4<f32>,
    // xyz towards the sun; w the rays a probe casts (as f32).
    sun_dir: vec4<f32>,
    sun: vec4<f32>,
    sky: vec4<f32>,
    // The atlas box: xyz min, w unused; xyz size.
    grid_min: vec4<f32>,
    grid_size: vec4<f32>,
    rays_per_probe: u32,
    probe_count: u32,
    probe_first: u32,
    hysteresis: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> nodes: array<Node>;
@group(0) @binding(2) var<storage, read> tris: array<Tri>;
@group(0) @binding(3) var<storage, read> probes: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> ray_out: array<vec4<f32>>;
@group(0) @binding(5) var atlas: texture_3d<f32>;
@group(0) @binding(6) var atlas_sampler: sampler;
@group(0) @binding(7) var<storage, read_write> cube_out: array<vec4<f32>>;

const STACK: u32 = 64u;
const NO_HIT: u32 = 0xffffffffu;
const FAR: f32 = 1.0e30;
const GOLDEN: f32 = 2.39996323;

struct Hit {
    t: f32,
    tri: u32,
}

fn slab(c: Child, o: vec3<f32>, inv: vec3<f32>, t_max: f32) -> f32 {
    let t0 = (c.lo - o) * inv;
    let t1 = (c.hi - o) * inv;
    let near = max(max(min(t0.x, t1.x), min(t0.y, t1.y)), max(min(t0.z, t1.z), 0.0));
    let far = min(min(max(t0.x, t1.x), max(t0.y, t1.y)), min(max(t0.z, t1.z), t_max));
    return select(FAR, near, near <= far);
}

// Moller-Trumbore; returns the distance or FAR.
fn tri_t(tri: Tri, o: vec3<f32>, d: vec3<f32>) -> f32 {
    let p = cross(d, tri.e2.xyz);
    let det = dot(tri.e1.xyz, p);
    if abs(det) < 1.0e-12 {
        return FAR;
    }
    let inv = 1.0 / det;
    let s = o - tri.v0.xyz;
    let u = dot(s, p) * inv;
    let q = cross(s, tri.e1.xyz);
    let v = dot(d, q) * inv;
    let t = dot(tri.e2.xyz, q) * inv;
    let inside = u >= 0.0 && v >= 0.0 && u + v <= 1.0 && t > 1.0e-4;
    return select(FAR, t, inside);
}

fn leaf(c: Child, o: vec3<f32>, d: vec3<f32>, best: ptr<function, Hit>) {
    for (var i = c.first; i < c.first + c.n; i++) {
        let t = tri_t(tris[i], o, d);
        if t < (*best).t {
            *best = Hit(t, i);
        }
    }
}

// The closest hit within `t_max`, or (as soon as anything is hit) any hit when `any` is set. The
// stack is private; tests/ddgi.rs also builds a variant that keeps it in workgroup memory, one
// 64-entry column a lane (16 KiB, WebGPU core's limit), indexed by `lane`.
fn trace(o: vec3<f32>, d: vec3<f32>, t_max: f32, any: bool, lane: u32) -> Hit {
    let inv = 1.0 / select(d, vec3(1.0e-20), abs(d) < vec3(1.0e-20));
    var best = Hit(t_max, NO_HIT);
    var stack: array<u32, STACK>;
    var sp = 0u;
    var node = 0u;
    loop {
        let n = nodes[node];
        let ta = slab(n.a, o, inv, best.t);
        let tb = slab(n.b, o, inv, best.t);
        var go_a = false;
        var go_b = false;
        if ta < best.t {
            if n.a.n > 0u {
                leaf(n.a, o, d, &best);
                if any && best.tri != NO_HIT {
                    return best;
                }
            } else {
                go_a = true;
            }
        }
        if tb < best.t {
            if n.b.n > 0u {
                leaf(n.b, o, d, &best);
                if any && best.tri != NO_HIT {
                    return best;
                }
            } else {
                go_b = true;
            }
        }
        if go_a && go_b {
            let a_first = ta <= tb;
            stack[min(sp, STACK - 1u)] = select(n.a.first, n.b.first, a_first);
            sp = min(sp + 1u, STACK);
            node = select(n.b.first, n.a.first, a_first);
            continue;
        }
        if go_a {
            node = n.a.first;
            continue;
        }
        if go_b {
            node = n.b.first;
            continue;
        }
        if sp == 0u {
            break;
        }
        sp -= 1u;
        node = stack[sp];
    }
    return best;
}

fn fibonacci(i: u32, count: u32) -> vec3<f32> {
    let z = 1.0 - (2.0 * f32(i) + 1.0) / f32(count);
    let r = sqrt(max(0.0, 1.0 - z * z));
    let phi = f32(i) * GOLDEN;
    return vec3(r * cos(phi), r * sin(phi), z);
}

fn ray_dir(i: u32) -> vec3<f32> {
    let f = fibonacci(i, params.rays_per_probe);
    return normalize(vec3(dot(params.rot0.xyz, f), dot(params.rot1.xyz, f), dot(params.rot2.xyz, f)));
}

fn albedo(bits: f32) -> vec3<f32> {
    return unpack4x8unorm(bitcast<u32>(bits)).rgb;
}

// The last update's irradiance at `p` facing `n`: three filtered fetches of the ambient-cube atlas
// (X x 2Y x 3Z, the faces toward the normal), as A.4's `gx_volume_irradiance` reads it.
fn last_irradiance(p: vec3<f32>, n: vec3<f32>) -> vec3<f32> {
    let uvw = clamp((p - params.grid_min.xyz) / params.grid_size.xyz, vec3(0.0), vec3(1.0));
    let side = vec3<f32>(n < vec3(0.0));
    let x = textureSampleLevel(atlas, atlas_sampler, vec3(uvw.x, (uvw.y + side.x) * 0.5, uvw.z / 3.0), 0.0).rgb;
    let y = textureSampleLevel(atlas, atlas_sampler, vec3(uvw.x, (uvw.y + side.y) * 0.5, (uvw.z + 1.0) / 3.0), 0.0).rgb;
    let z = textureSampleLevel(atlas, atlas_sampler, vec3(uvw.x, (uvw.y + side.z) * 0.5, (uvw.z + 2.0) / 3.0), 0.0).rgb;
    let w = n * n;
    return x * w.x + y * w.y + z * w.z;
}

@compute @workgroup_size(64)
fn cs_trace(@builtin(global_invocation_id) id: vec3<u32>, @builtin(local_invocation_index) lane: u32) {
    let total = params.probe_count * params.rays_per_probe;
    if id.x >= total {
        return;
    }
    let probe = params.probe_first + id.x / params.rays_per_probe;
    let o = probes[probe].xyz;
    let d = ray_dir(id.x % params.rays_per_probe);
    let hit = trace(o, d, FAR, false, lane);
    if hit.tri == NO_HIT {
        ray_out[id.x] = vec4(params.sky.rgb, FAR);
        return;
    }
    let tri = tris[hit.tri];
    var n = normalize(cross(tri.e1.xyz, tri.e2.xyz));
    let back = dot(n, d) > 0.0;
    n = select(n, -n, back);
    let p = o + d * hit.t;
    let ndl = dot(n, params.sun_dir.xyz);
    var direct = vec3(0.0);
    if ndl > 0.0 {
        let blocked = trace(p + n * 2.0e-3, params.sun_dir.xyz, FAR, true, lane);
        direct = select(params.sun.rgb * ndl, vec3(0.0), blocked.tri != NO_HIT);
    }
    let radiance = albedo(tri.v0.w) * (direct + last_irradiance(p, n));
    // DDGI keeps back-face hits as negative distances (the probe sits inside geometry).
    ray_out[id.x] = vec4(radiance, select(hit.t, -0.2 * hit.t, back));
}

// One invocation per probe face: the cosine-weighted mean of the probe's rays toward that axis
// direction, folded into the face with hysteresis.
@compute @workgroup_size(64)
fn cs_blend(@builtin(global_invocation_id) id: vec3<u32>) {
    if id.x >= params.probe_count * 6u {
        return;
    }
    let probe = id.x / 6u;
    let face = id.x % 6u;
    var axis = vec3(0.0);
    axis[face / 2u] = select(1.0, -1.0, (face & 1u) == 1u);
    var sum = vec4(0.0);
    for (var r = 0u; r < params.rays_per_probe; r++) {
        let ray = ray_out[probe * params.rays_per_probe + r];
        let w = max(dot(ray_dir(r), axis), 0.0);
        sum += vec4(ray.rgb * w, w);
    }
    let fresh = sum.rgb / max(sum.w, 1.0e-4);
    let slot = (params.probe_first + probe) * 6u + face;
    cube_out[slot] = vec4(mix(fresh, cube_out[slot].rgb, params.hysteresis), 1.0);
}
