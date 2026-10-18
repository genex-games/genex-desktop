// Hi-Z screen-space reflections, the trace (renderer pass 2 B.9; graph node 10b on desktop and web
// `high` and `ultra`). A port of Godot 4.7.2 `screen_space_reflection.glsl` (MIT, © Godot Engine
// contributors and Juan Linietsky, Ariel Manzur): Hi-Z tracing with parametric t (hacksoflife,
// 2020), the geometric-normal bias (habr 744336) and FidelityFX SSSR's hit validation, at half the
// render size. Changes from the source, each kept in the CPU twin (`ssr::twin`):
// - push constants are a uniform (`SsrParams`); WebGPU core has none;
// - the r8 mip-level image is gone: the roughness cone picks a mip of the previous frame's colour
//   pyramid (A.6, half size) directly, so there is no `r8` storage (not core) and no filter pass;
// - either depth convention: `ssr_z` maps device depth to Godot's reverse-Z (1 nearest, 0 far),
//   and the Hi-Z holds the nearest depth of each region (`hiz::HizReduce` opposite the cull's);
// - wgpu's screen (uv y down, NDC y up), world-space packed normals (A.6 `gx_unpack_normal`);
// - the half-size normal is that of the nearest of the four full-size pixels a texel covers;
// - out-of-range neighbour loads clamp to the edge; a far-plane depth linearises to `-SSR_FAR`;
// - the distance fade-out is a smoothstep from `tune.y` of the screen (no edge at its end);
// - a hit off screen or on the sky returns no validity before its view position is formed.
// Output: rgb the reflected colour times its validity, tone mapped by 1 / (1 + luma) for the
// resolve's filter; a the validity (0 none, 1 sure). Include after effects.wgsl,
// normal_roughness.wgsl and ssr_params.wgsl.

@group(0) @binding(0) var<uniform> ssr: SsrParams;
@group(0) @binding(1) var ssr_hiz: texture_2d<f32>;
@group(0) @binding(2) var ssr_depth: texture_depth_2d;
@group(0) @binding(3) var ssr_normal_roughness: texture_2d<f32>;
@group(0) @binding(4) var ssr_history: texture_2d<f32>;
@group(0) @binding(5) var ssr_sampler: sampler;
@group(0) @binding(6) var ssr_out: texture_storage_2d<rgba16float, write>;

const SSR_PI: f32 = 3.14159265359;
const SSR_FAR: f32 = 1e30;
const SSR_LUMA: vec3<f32> = vec3<f32>(0.2126, 0.7152, 0.0722);

// Device depth to Godot's convention (1 nearest, 0 far); its own inverse.
fn ssr_z(depth: f32) -> f32 {
    return select(1.0 - depth, depth, ssr.knobs.z == 1u);
}

fn ssr_trace_size() -> vec2<f32> {
    return vec2<f32>(ssr.size.xy);
}

fn ssr_cell_count(level: i32) -> vec2<f32> {
    let size = vec2<i32>(ssr.size.xy);
    return vec2<f32>(max(vec2<i32>(1), size >> vec2<u32>(u32(level))));
}

// A Hi-Z texel of `level` in Godot's convention, its coordinate clamped to the level.
fn ssr_hiz_z(cell: vec2<i32>, level: i32) -> f32 {
    let last = vec2<i32>(ssr_cell_count(level)) - vec2<i32>(1);
    return ssr_z(textureLoad(ssr_hiz, clamp(cell, vec2<i32>(0), last), level).x);
}

// View-space position of screen point (uv, z in Godot's convention).
fn ssr_view_pos(screen: vec3<f32>) -> vec3<f32> {
    let ndc = vec4<f32>(screen.x * 2.0 - 1.0, 1.0 - screen.y * 2.0, ssr_z(screen.z), 1.0);
    let pos = ssr.inv_proj * ndc;
    return pos.xyz / pos.w;
}

// View-space z (negative ahead) of a depth in Godot's convention.
fn ssr_linearize(z: f32) -> f32 {
    if z <= 0.0 {
        return -SSR_FAR;
    }
    let pos = ssr.inv_proj * vec4<f32>(0.0, 0.0, ssr_z(z), 1.0);
    return pos.z / pos.w;
}

// Screen point (uv, z in Godot's convention) of view-space position `pos`.
fn ssr_screen_pos(pos: vec3<f32>) -> vec3<f32> {
    let clip = ssr.proj * vec4<f32>(pos, 1.0);
    let ndc = clip.xyz / clip.w;
    return vec3<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5, ssr_z(ndc.z));
}

// The surface's geometric normal from the Hi-Z's finest level: the better-continued side of each
// axis (habr 744336), as in the source.
fn ssr_geometric_normal(pixel: vec2<i32>, z_c: f32, view_c: vec3<f32>) -> vec3<f32> {
    let h = vec4<f32>(ssr_hiz_z(pixel + vec2<i32>(-1, 0), 0), ssr_hiz_z(pixel + vec2<i32>(-2, 0), 0), ssr_hiz_z(pixel + vec2<i32>(1, 0), 0), ssr_hiz_z(pixel + vec2<i32>(2, 0), 0));
    let v = vec4<f32>(ssr_hiz_z(pixel + vec2<i32>(0, -1), 0), ssr_hiz_z(pixel + vec2<i32>(0, -2), 0), ssr_hiz_z(pixel + vec2<i32>(0, 1), 0), ssr_hiz_z(pixel + vec2<i32>(0, 2), 0));
    let he = abs((2.0 * h.xz - h.yw) - vec2<f32>(z_c));
    let ve = abs((2.0 * v.xz - v.yw) - vec2<f32>(z_c));
    let h_sign = select(1.0, -1.0, he.x < he.y);
    let v_sign = select(1.0, -1.0, ve.x < ve.y);
    let h_z = select(h.z, h.x, h_sign < 0.0);
    let v_z = select(v.z, v.x, v_sign < 0.0);
    let size = ssr_trace_size();
    let p = vec2<f32>(pixel) + vec2<f32>(0.5);
    let view_h = ssr_view_pos(vec3<f32>((p + vec2<f32>(h_sign, 0.0)) / size, h_z));
    let view_v = ssr_view_pos(vec3<f32>((p + vec2<f32>(0.0, v_sign)) / size, v_z));
    // Toward the camera under wgpu's screen (x right, y down) as in the source.
    return cross(v_sign * (view_v - view_c), h_sign * (view_h - view_c));
}

// The world normal and perceptual roughness of the nearest of the four render pixels trace
// texel `pixel` covers.
fn ssr_surface(pixel: vec2<i32>) -> vec4<f32> {
    let last = vec2<i32>(ssr.size.zw) - vec2<i32>(1);
    var best = clamp(pixel * 2, vec2<i32>(0), last);
    var best_z = ssr_z(textureLoad(ssr_depth, best, 0));
    for (var i = 1; i < 4; i++) {
        let at = clamp(pixel * 2 + vec2<i32>(i & 1, i >> 1u), vec2<i32>(0), last);
        let z = ssr_z(textureLoad(ssr_depth, at, 0));
        if z > best_z {
            best = at;
            best_z = z;
        }
    }
    let texel = textureLoad(ssr_normal_roughness, best, 0);
    return vec4<f32>(gx_unpack_normal(texel), gx_unpack_roughness(texel));
}

// The view-space world normal `n`.
fn ssr_view_normal(n: vec3<f32>) -> vec3<f32> {
    return normalize((ssr.view * vec4<f32>(n, 0.0)).xyz);
}

// The parametric distance from `origin` along `dir` to the next cell edge of a `cells` grid.
fn ssr_edge_t(origin: vec2<f32>, dir: vec2<f32>, cell: vec2<f32>, step: vec2<f32>, cells: vec2<f32>) -> f32 {
    let next = cell + clamp(step, vec2<f32>(0.0), vec2<f32>(1.0));
    let pos = next / cells + step * 0.000001;
    let t = (pos - origin) / dir;
    return min(t.x, t.y);
}

struct SsrRay {
    // The traced point's parametric distance.
    t: f32,
    // The screen exit.
    t_max: f32,
    // The ray's origin (uv, Godot z) and its step per unit t (|z| = 1).
    origin: vec3<f32>,
    dir: vec3<f32>,
    // The reflected direction in view space.
    reflected: vec3<f32>,
}

// The Hi-Z walk: down a level on a hit, up a level past an empty cell.
fn ssr_walk(ray_in: SsrRay) -> f32 {
    let facing_camera = ray_in.dir.z >= 0.0;
    let step = select(vec2<f32>(1.0), vec2<f32>(-1.0), ray_in.dir.xy < vec2<f32>(0.0));
    let mips = i32(ssr.knobs.y);
    var t = ray_in.t;
    var level = 0;
    var left = i32(ssr.knobs.x);
    while level >= 0 && left > 0 && t < ray_in.t_max {
        let at = ray_in.origin + ray_in.dir * t;
        let cells = ssr_cell_count(level);
        let cell = floor(at.xy * cells);
        let cell_z = ssr_hiz_z(vec2<i32>(cell), level);
        let depth_t = (cell_z - ray_in.origin.z) * ray_in.dir.z;
        let edge_t = ssr_edge_t(ray_in.origin.xy, ray_in.dir.xy, cell, step, cells);
        var hit = select(depth_t <= edge_t, t <= depth_t, facing_camera);
        var offset = select(1, -1, hit);
        if level == 0 && (ssr_linearize(cell_z) - ssr_linearize(at.z)) > ssr.tune.x {
            hit = false;
            offset = 0;
        }
        if hit {
            if !facing_camera {
                t = max(t, depth_t);
            }
        } else {
            t = edge_t;
        }
        level = min(level + offset, mips - 1);
        left -= 1;
    }
    return t;
}

// The validity of the hit at `t`: on screen, on a surface, within the depth tolerance, facing the
// ray, faded at the screen's margin and over the ray's length.
fn ssr_validity(ray: SsrRay, t: f32, reprojected: vec2<f32>) -> f32 {
    let size = ssr_trace_size();
    let at = ray.origin + ray.dir * t;
    let hit_pixel = vec2<i32>(at.xy * size);
    let hit_z = ssr_hiz_z(hit_pixel, 0);
    // Off screen or on the sky: nothing (the source multiplies on, where the sky's infinite view
    // position makes a NaN).
    if t >= ray.t_max || hit_z == 0.0 {
        return 0.0;
    }
    var validity = 1.0;
    if all(abs(ray.dir.xy * t) < vec2<f32>(2.0) / size) {
        let hit_normal = ssr_view_normal(ssr_surface(hit_pixel).xyz);
        if dot(ray.reflected, hit_normal) >= 0.0 {
            validity = 0.0;
        }
    }
    let delta = length(ssr_view_pos(at) - ssr_view_pos(vec3<f32>(at.xy, hit_z)));
    let confidence = 1.0 - smoothstep(0.0, ssr.tune.x, delta);
    validity *= saturate(confidence * confidence);
    // A uniform margin, fading towards the inner margin of the reprojected point.
    let reprojected_pixel = reprojected * size;
    let margin = vec2<f32>((size.x + size.y) * 0.05);
    let toward = select(size - reprojected_pixel, reprojected_pixel, reprojected_pixel < size * 0.5);
    let margin_blend = smoothstep(0.0, margin.x * margin.y, toward.x * toward.y);
    let ray_len = length(ray.dir.xy * t);
    let fade_in = select(pow(saturate(ray_len), ssr.tune.z), 1.0, ssr.tune.z == 0.0);
    // Full strength to `tune.y` of the screen, then a smoothstep to nothing at a full-screen ray:
    // the source's pow(1 - len, k) under k < 1 meets zero at an infinite slope, a visible edge.
    let fade_out = 1.0 - smoothstep(ssr.tune.y, 1.0, ray_len);
    // Precision must not fade a sure hit: strong specular light would leak through.
    let fade = select(fade_in * fade_out, 1.0, fade_in * fade_out > 0.999);
    return validity * fade * margin_blend;
}

// The half angle of the cone that holds a GGX lobe of perceptual `roughness`: the lobe's Phong
// power (2 / alpha^2 - 2) and Uludag's cone for it (GPU Pro 5, 2014: acos(0.244^(1 / (power + 1)))).
// The source's roughness * pi / 2 is several times wider, which its mip then took a sixteenth of.
fn ssr_cone_angle(roughness: f32) -> f32 {
    let alpha = max(roughness * roughness, 1e-3);
    let power = 2.0 / (alpha * alpha) - 2.0;
    return acos(pow(0.244, 1.0 / (power + 1.0)));
}

// The colour pyramid's mip for the lobe of `roughness` on a ray from screen point `origin` to `at`
// (uv, Godot z): the lobe's spread at the hit (its distance from the surface times the cone's
// tangent) projected at the hit's depth, in trace texels (a mip-k texel spans 2^k of them); faded
// near the ray's end. The source's cone over the ray's screen length shrank a ray that runs away
// from the camera, a floor's, to a fraction of its spread.
fn ssr_mip(roughness: f32, origin: vec3<f32>, at: vec3<f32>, ray_len: f32) -> f32 {
    if roughness <= 0.001 {
        return 0.0;
    }
    let to = ssr_view_pos(at);
    let spread = length(to - ssr_view_pos(origin)) * tan(ssr_cone_angle(roughness));
    let clip_w = (ssr.proj * vec4<f32>(to, 1.0)).w;
    let radius = spread * ssr.proj[0][0] * 0.5 * ssr_trace_size().x / max(clip_w, 1e-6);
    let mip = clamp(log2(radius + 1.0), 0.0, ssr.extra.x);
    return mip * pow(saturate(1.25 - ray_len), 0.2);
}

// How much of a screen reflection a surface of perceptual `roughness` keeps: all of it up to
// `extra.z`, then a smoothstep to nothing at the cutoff (`tune.w`), where the probes take over
// alone. A cut at the cutoff drew a seam where a scan's roughness crosses it, and a rough floor
// mirrored the room at full strength.
fn ssr_roughness_fade(roughness: f32) -> f32 {
    return 1.0 - smoothstep(ssr.extra.z, ssr.tune.w, roughness);
}

// Mip `level` (1 and up) of the colour pyramid at `uv` through a cubic B-spline, in four bilinear
// taps (Sigg and Hadwiger 2005, GPU Gems 2 ch. 20; clamp-to-edge through the sampler): a rough
// reflection of a small bright light spreads round, where bilinear taps of a coarse mip spread it
// as a square. The CPU twin is `ssr::twin::sample_pyramid`.
fn ssr_history_bspline(uv: vec2<f32>, level: f32) -> vec3<f32> {
    let size = vec2<f32>(textureDimensions(ssr_history, i32(level)));
    let p = uv * size - vec2<f32>(0.5);
    let base = floor(p);
    let f = p - base;
    let f2 = f * f;
    let f3 = f2 * f;
    let one = vec2<f32>(1.0) - f;
    let w0 = one * one * one / 6.0;
    let w1 = (vec2<f32>(4.0) - 6.0 * f2 + 3.0 * f3) / 6.0;
    let w2 = (vec2<f32>(1.0) + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0;
    let w3 = f3 / 6.0;
    let g0 = w0 + w1;
    let g1 = w2 + w3;
    // Each tap between two texel centres, where bilinear filtering weighs them as the spline does.
    let t0 = (base - vec2<f32>(0.5) + w1 / g0) / size;
    let t1 = (base + vec2<f32>(1.5) + w3 / g1) / size;
    let top = g0.x * ssr_history_tap(vec2<f32>(t0.x, t0.y), level) + g1.x * ssr_history_tap(vec2<f32>(t1.x, t0.y), level);
    let bottom = g0.x * ssr_history_tap(vec2<f32>(t0.x, t1.y), level) + g1.x * ssr_history_tap(vec2<f32>(t1.x, t1.y), level);
    return g0.y * top + g1.y * bottom;
}

// One bilinear tap of mip `level` at `uv`.
fn ssr_history_tap(uv: vec2<f32>, level: f32) -> vec3<f32> {
    return textureSampleLevel(ssr_history, ssr_sampler, uv, level).rgb;
}

// The colour pyramid at `uv` and fractional `mip`: two levels blended, mip 0 bilinear (a mirror
// keeps its sharpness), every coarser one a cubic B-spline (`ssr_history_bspline`).
fn ssr_history_at(uv: vec2<f32>, mip: f32) -> vec3<f32> {
    let last = ssr.extra.x;
    let lower = min(floor(max(mip, 0.0)), last);
    let upper = min(lower + 1.0, last);
    let f = mip - lower;
    let a = ssr_history_level(uv, lower);
    if f <= 0.0 || upper == lower {
        return a;
    }
    return mix(a, ssr_history_level(uv, upper), f);
}

fn ssr_history_level(uv: vec2<f32>, level: f32) -> vec3<f32> {
    if level < 0.5 {
        return textureSampleLevel(ssr_history, ssr_sampler, uv, 0.0).rgb;
    }
    return ssr_history_bspline(uv, level);
}

// Last frame's uv of screen point `at`.
fn ssr_reproject(at: vec3<f32>) -> vec2<f32> {
    let clip = ssr.reprojection * vec4<f32>(at.x * 2.0 - 1.0, 1.0 - at.y * 2.0, ssr_z(at.z), 1.0);
    let ndc = clip.xy / clip.w;
    return vec2<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
}

// The ray leaving trace texel `pixel`, or a zero `t_max` when nothing is traced.
fn ssr_ray(pixel: vec2<i32>, surface: vec4<f32>) -> SsrRay {
    var ray = SsrRay(0.0, 0.0, vec3<f32>(0.0), vec3<f32>(0.0, 0.0, 1.0), vec3<f32>(0.0, 0.0, 1.0));
    let size = ssr_trace_size();
    var screen = vec3<f32>((vec2<f32>(pixel) + vec2<f32>(0.5)) / size, ssr_hiz_z(pixel, 0));
    var pos = ssr_view_pos(screen);
    let normal = ssr_view_normal(surface.xyz);
    let geom_normal = normalize(ssr_geometric_normal(pixel, screen.z, pos));
    // A small bias towards the geometric normal against self intersections.
    pos += geom_normal * (1.0 - pow(saturate(dot(normal, geom_normal)), 8.0));
    screen = ssr_screen_pos(pos);
    let view_dir = select(normalize(pos), vec3<f32>(0.0, 0.0, -1.0), ssr.knobs.w == 1u);
    var ray_dir = normalize(reflect(view_dir, normal));
    // A ray into its own surface bounces off the geometric normal.
    if dot(ray_dir, geom_normal) < 0.0 {
        ray_dir = normalize(reflect(ray_dir, geom_normal));
    }
    var end = pos + ray_dir;
    // Clip to the near plane with a small bias so the end stays finite.
    if end.z > 0.0 {
        end -= ray_dir / ray_dir.z * (end.z + 0.00001);
    }
    let screen_end = ssr_screen_pos(end);
    let dir = (screen_end - screen) / abs(screen_end.z - screen.z);
    let t0 = (vec2<f32>(0.0) - screen.xy) / dir.xy;
    let t1 = (vec2<f32>(1.0) - screen.xy) / dir.xy;
    let t2 = max(t0, t1);
    ray.t_max = min(t2.x, t2.y);
    ray.origin = screen;
    ray.dir = dir;
    ray.reflected = ray_dir;
    // Start at the next cell's edge against an immediate self intersection.
    let step = select(vec2<f32>(1.0), vec2<f32>(-1.0), dir.xy < vec2<f32>(0.0));
    ray.t = ssr_edge_t(screen.xy, dir.xy, floor(screen.xy * size), step, size);
    return ray;
}

@compute @workgroup_size(8, 8, 1)
fn cs_ssr_trace(@builtin(global_invocation_id) id: vec3<u32>) {
    if any(id.xy >= ssr.size.xy) {
        return;
    }
    let pixel = vec2<i32>(id.xy);
    var color = vec4<f32>(0.0);
    let z = ssr_hiz_z(pixel, 0);
    let surface = ssr_surface(pixel);
    // Rough surfaces are not traced (the probes reflect them), and neither is the sky.
    if z != 0.0 && surface.w < ssr.tune.w {
        let ray = ssr_ray(pixel, surface);
        let t = ssr_walk(ray);
        let at = ray.origin + ray.dir * t;
        let reprojected = ssr_reproject(at);
        let validity = ssr_validity(ray, t, reprojected) * ssr_roughness_fade(surface.w);
        if validity > 0.0 {
            let mip = ssr_mip(surface.w, ray.origin, at, length(ray.dir.xy * t));
            let radiance = ssr_history_at(reprojected, mip) * ssr.extra.y;
            color = vec4<f32>(radiance, 1.0) * validity;
            // Tone mapped for the resolve's filter across samples of very different luminance.
            color = vec4<f32>(color.rgb / (1.0 + dot(color.rgb, SSR_LUMA)), color.a);
        }
    }
    textureStore(ssr_out, pixel, color);
}
