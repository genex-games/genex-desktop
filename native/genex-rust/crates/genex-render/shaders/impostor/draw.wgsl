// Impostor draw (game systems LOD-14; a port of kansei's `impostor.wgsl`, MIT): the camera-facing
// quad of a baked species and its three-frame blend, concatenated after the forward module's
// sources (`impostor::draw::IMPOSTOR_DRAW`), so an impostor shades through the same lighting
// chunks as every built-in surface: the sun with its cascades, mask and contact shadows, the sky
// and the probes with AO and the screen reflections, the local lights, the air and the fog.
//
// Group 0 is the forward frame group without the material texture arrays (an impostor reads its
// material from its atlases, `renderer::impostor_frame_layout_entries`), group 1 the pass view,
// group 2 the impostor group: the species rows (uniform), the instances (vertex storage) and the
// three atlas arrays with their sampler. The quad's own depth is a plane through the bounds'
// centre facing the camera (flat: early depth testing keeps working on tile GPUs); the `_depth`
// entries write the reconstructed surface's depth (`frag_depth`, desktop high and ultra only).

// `impostor::GpuImpostor`: one baked species.
struct GxImpostor {
    center: vec3<f32>,
    radius: f32,
    extent: vec3<f32>,
    frames: u32,
    hemi: u32,
    frame_px: u32,
    layer: u32,
    mip_levels: u32,
}

// `impostor::draw::GpuImpostorInstance`: one placed impostor.
struct GxImpostorInstance {
    model: mat4x4<f32>,
    inverse: mat4x4<f32>,
    // The species' row in `gx_impostor_species`.
    species: u32,
    // The LOD fade (1 whole; kansei's signed convention, `gx_lod_fade_keeps`).
    fade: f32,
    pad: vec2<u32>,
}

// The species rows a draw can address (`impostor::draw::IMPOSTOR_SPECIES_MAX`).
const GX_IMPOSTOR_SPECIES_MAX: u32 = 16u;

@group(2) @binding(0) var<uniform> gx_impostor_species: array<GxImpostor, GX_IMPOSTOR_SPECIES_MAX>;
@group(2) @binding(1) var<storage, read> gx_impostor_instances: array<GxImpostorInstance>;
// Atlas A: linear base colour, coverage. B: the object normal (octahedral), depth, roughness.
// C: occlusion, metallic, transmission, class.
@group(2) @binding(2) var gx_impostor_atlas_a: texture_2d_array<f32>;
@group(2) @binding(3) var gx_impostor_atlas_b: texture_2d_array<f32>;
@group(2) @binding(4) var gx_impostor_atlas_c: texture_2d_array<f32>;
@group(2) @binding(5) var gx_impostor_sampler: sampler;

// Whether a frame takes one parallax step to its stored depth (off on the phone sizes).
override GX_IMPOSTOR_PARALLAX: bool = true;
// The parallax steps a frame takes towards its stored depth.
const GX_IMPOSTOR_PARALLAX_STEPS: u32 = 3u;
// The blended coverage an impostor keeps a pixel at. Each frame's mips keep its coverage at the
// bake's cutoff (`impostor::bake::IMPOSTOR_COVERAGE_CUTOFF`, 0.5); the three frames' blend
// averages three silhouettes reprojected from up to a grid step away, and a face edge-on to the
// view but hidden in two of them would fall below 0.5 there. The lower cut keeps the mesh's
// silhouette (tests/impostor_draw.rs: IoU 0.955 at worst, against 0.946 at 0.5).
const GX_IMPOSTOR_CUTOFF: f32 = 0.35;

fn gx_impostor_signs(v: vec2<f32>) -> vec2<f32> {
    return select(vec2<f32>(-1.0), vec2<f32>(1.0), v >= vec2<f32>(0.0));
}

// `impostor::encode`: the grid position ([-1, 1] squared) of an object-space direction.
fn gx_impostor_encode(dir: vec3<f32>, hemi: bool) -> vec2<f32> {
    let v = dir / (abs(dir.x) + abs(dir.y) + abs(dir.z));
    if hemi {
        let h = v.xz / max(abs(v.x) + abs(v.z), select(1e-12, 1.0, v.y > 0.0));
        return vec2<f32>(h.x + h.y, h.x - h.y);
    }
    if v.y >= 0.0 {
        return v.xz;
    }
    return (1.0 - abs(v.zx)) * gx_impostor_signs(v.xz);
}

// `impostor::decode`: the unit direction at a grid position.
fn gx_impostor_decode(g: vec2<f32>, hemi: bool) -> vec3<f32> {
    if hemi {
        let x = (g.x + g.y) * 0.5;
        let z = (g.x - g.y) * 0.5;
        return normalize(vec3<f32>(x, 1.0 - abs(x) - abs(z), z));
    }
    let y = 1.0 - abs(g.x) - abs(g.y);
    if y < 0.0 {
        let xz = (1.0 - abs(g.yx)) * gx_impostor_signs(g);
        return normalize(vec3<f32>(xz.x, y, xz.y));
    }
    return normalize(vec3<f32>(g.x, y, g.y));
}

// The object normal pack.wgsl's `gx_impostor_oct_encode` stored as `e` ([0, 1] squared).
fn gx_impostor_normal_decode(e: vec2<f32>) -> vec3<f32> {
    let g = e * 2.0 - 1.0;
    var n = vec3<f32>(g.x, 1.0 - abs(g.x) - abs(g.y), g.y);
    if n.y < 0.0 {
        let xz = (1.0 - abs(g.yx)) * gx_impostor_signs(g);
        n = vec3<f32>(xz.x, n.y, xz.y);
    }
    return normalize(n);
}

// `impostor::frame_axes`: a frame's right and up from its direction (towards the viewer).
fn gx_impostor_basis(dir: vec3<f32>) -> mat2x3<f32> {
    let up = select(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(0.0, 0.0, 1.0), abs(dir.y) > 0.999);
    let right = normalize(cross(up, dir));
    return mat2x3<f32>(right, cross(dir, right));
}

fn gx_impostor_frame_dir(imp: GxImpostor, frame: vec2<f32>) -> vec3<f32> {
    return gx_impostor_decode((frame + 0.5) / f32(imp.frames) * 2.0 - 1.0, imp.hemi != 0u);
}

// Quad corner `corner` (each coordinate -1 or 1), object space, for an eye at `eye` (object
// space): a quad through the bounds' centre facing the eye, just covering the bounds seen from
// there (the box's outline while the eye is outside it, else the sphere's).
fn gx_impostor_corner(imp: GxImpostor, corner: vec2<f32>, eye: vec3<f32>) -> vec3<f32> {
    let to_eye = eye - imp.center;
    let dist = length(to_eye);
    let v = to_eye / max(dist, 1e-6);
    let b = gx_impostor_basis(v);
    let r2 = imp.radius * imp.radius;
    let half = imp.radius * dist / sqrt(max(dist * dist - r2, 0.01 * r2));
    var lo = vec2<f32>(-half);
    var hi = vec2<f32>(half);
    if dot(abs(v), imp.extent) < dist * 0.99 {
        var box_lo = vec2<f32>(1e30);
        var box_hi = vec2<f32>(-1e30);
        for (var k = 0u; k < 8u; k++) {
            let o = (vec3<f32>(f32(k & 1u), f32((k >> 1u) & 1u), f32((k >> 2u) & 1u)) * 2.0 - 1.0) * imp.extent;
            let p = vec2<f32>(dot(o, b[0]), dot(o, b[1])) * (dist / (dist - dot(o, v)));
            box_lo = min(box_lo, p);
            box_hi = max(box_hi, p);
        }
        lo = max(lo, box_lo);
        hi = min(hi, box_hi);
    }
    let q = mix(lo, hi, corner * 0.5 + 0.5);
    return imp.center + b[0] * q.x + b[1] * q.y;
}

fn gx_impostor_frame_uv(imp: GxImpostor, b: mat2x3<f32>, p: vec3<f32>) -> vec2<f32> {
    let q = p - imp.center;
    return vec2<f32>(dot(q, b[0]), -dot(q, b[1])) / (2.0 * imp.radius) + 0.5;
}

// The atlas uv of frame-local `uv` in `frame`, kept half a texel of mip `lod` inside the frame.
fn gx_impostor_atlas_uv(imp: GxImpostor, frame: vec2<f32>, uv: vec2<f32>, lod: f32) -> vec2<f32> {
    let n = f32(imp.frames);
    let texels = max(f32(imp.frame_px) / exp2(floor(lod)), 1.0);
    let inset = 0.5 / texels;
    return (frame + clamp(uv, vec2<f32>(inset), vec2<f32>(1.0 - inset))) / n;
}

// What an impostor is at a pixel, object space.
struct GxImpostorSample {
    albedo: vec3<f32>,
    alpha: f32,
    normal: vec3<f32>,
    position: vec3<f32>,
    // Occlusion, metallic, transmission, class (atlas C).
    surface: vec4<f32>,
    roughness: f32,
}

// One frame along the view ray from `eye` in direction `ray` (object space): where the ray meets
// the frame's plane, then one parallax step to the depth stored there.
fn gx_impostor_frame(imp: GxImpostor, frame: vec2<f32>, eye: vec3<f32>, ray: vec3<f32>, lod: f32) -> GxImpostorSample {
    let layer = i32(imp.layer);
    let d = gx_impostor_frame_dir(imp, frame);
    let b = gx_impostor_basis(d);
    let rate = min(dot(ray, d), -1e-4);
    let eye_height = dot(eye - imp.center, d);
    var uv = gx_impostor_frame_uv(imp, b, eye + ray * (eye_height / -rate));
    if GX_IMPOSTOR_PARALLAX {
        // A few fixed-point steps along the ray to the stored depth (kansei takes one): each
        // reads the depth where the last one landed, so a steep view onto a near edge settles
        // on its surface instead of the plane's.
        for (var step = 0u; step < GX_IMPOSTOR_PARALLAX_STEPS; step++) {
            let h = textureSampleLevel(gx_impostor_atlas_b, gx_impostor_sampler, gx_impostor_atlas_uv(imp, frame, uv, lod), layer, lod).z;
            let height = imp.radius * (1.0 - 2.0 * h);
            uv = gx_impostor_frame_uv(imp, b, eye + ray * ((eye_height - height) / -rate));
        }
    }
    let at = gx_impostor_atlas_uv(imp, frame, uv, lod);
    let a = textureSampleLevel(gx_impostor_atlas_a, gx_impostor_sampler, at, layer, lod);
    let nd = textureSampleLevel(gx_impostor_atlas_b, gx_impostor_sampler, at, layer, lod);
    var s: GxImpostorSample;
    s.albedo = a.rgb;
    s.alpha = select(0.0, a.a, all(uv >= vec2<f32>(0.0)) && all(uv <= vec2<f32>(1.0)));
    s.normal = gx_impostor_normal_decode(nd.xy);
    s.roughness = nd.w;
    s.surface = textureSampleLevel(gx_impostor_atlas_c, gx_impostor_sampler, at, layer, lod);
    let q = (uv - 0.5) * 2.0 * imp.radius;
    s.position = imp.center + b[0] * q.x - b[1] * q.y + d * (imp.radius * (1.0 - 2.0 * nd.z));
    return s;
}

// The impostor seen along the ray from `eye` through quad point `local` (both object space): the
// three frames nearest the direction to the eye, blended by their barycentric weights in the
// grid, at mip `lod`.
fn gx_impostor_sample(imp: GxImpostor, local: vec3<f32>, eye: vec3<f32>, lod: f32) -> GxImpostorSample {
    let n = f32(imp.frames);
    let level = clamp(lod, 0.0, f32(imp.mip_levels - 1u));
    let ray = normalize(local - eye);
    let g = gx_impostor_encode(normalize(eye - imp.center), imp.hemi != 0u);
    let f = clamp((g * 0.5 + 0.5) * n - 0.5, vec2<f32>(0.0), vec2<f32>(n - 1.0));
    let f0 = floor(f);
    let t = f - f0;
    var frames = array<vec2<f32>, 3>(f0, f0 + vec2<f32>(1.0, 0.0), f0 + vec2<f32>(0.0, 1.0));
    var weights = vec3<f32>(1.0 - t.x - t.y, t.x, t.y);
    if t.x + t.y > 1.0 {
        frames[0] = f0 + vec2<f32>(1.0);
        weights = vec3<f32>(t.x + t.y - 1.0, 1.0 - t.y, 1.0 - t.x);
    }
    // The surface blends by sharpened weights: the nearest frame leads more of each cell (less
    // of the three reprojections' ghosting), still continuous across cells (each weight reaches
    // 0 at the cell's far edges, as kansei's). The coverage keeps the plain weights, so the
    // silhouette is the three frames' average.
    let coverage = weights;
    weights = weights * weights;
    weights /= weights.x + weights.y + weights.z;
    var out: GxImpostorSample;
    var normal = vec3<f32>(0.0);
    for (var k = 0; k < 3; k++) {
        let s = gx_impostor_frame(imp, min(frames[k], vec2<f32>(n - 1.0)), eye, ray, level);
        let w = weights[k];
        out.albedo += s.albedo * w;
        out.alpha += s.alpha * coverage[k];
        out.position += s.position * w;
        out.surface += s.surface * w;
        out.roughness += s.roughness * w;
        normal += s.normal * w;
    }
    out.normal = normalize(normal + vec3<f32>(0.0, 1e-6, 0.0));
    return out;
}

struct GxImpostorOut {
    @builtin(position) @invariant clip: vec4<f32>,
    // The quad point and the eye, object space.
    @location(0) local: vec3<f32>,
    @location(1) @interpolate(flat) eye: vec3<f32>,
    // The model's rows (object to world).
    @location(2) @interpolate(flat) row0: vec4<f32>,
    @location(3) @interpolate(flat) row1: vec4<f32>,
    @location(4) @interpolate(flat) row2: vec4<f32>,
    // The inverse's columns (world normals: the inverse's transpose times the object normal).
    @location(5) @interpolate(flat) inverse0: vec3<f32>,
    @location(6) @interpolate(flat) inverse1: vec3<f32>,
    @location(7) @interpolate(flat) inverse2: vec3<f32>,
    // x: the species row; y: the fade's bits.
    @location(8) @interpolate(flat) species_fade: vec2<u32>,
    // The motion prepass's last-frame projection rows x, y and w (the motion node's group is
    // vertex-only; zero elsewhere).
    @location(9) @interpolate(flat) previous_x: vec4<f32>,
    @location(10) @interpolate(flat) previous_y: vec4<f32>,
    @location(11) @interpolate(flat) previous_w: vec4<f32>,
}

// The quad's corner `vertex` (a four-vertex strip) of instance `instance`, jittered by `jitter`.
fn gx_impostor_vertex(vertex: u32, instance: u32, jitter: vec2<f32>) -> GxImpostorOut {
    let row = gx_impostor_instances[instance];
    let imp = gx_impostor_species[min(row.species, GX_IMPOSTOR_SPECIES_MAX - 1u)];
    let eye = (row.inverse * vec4<f32>(frame.camera_pos.xyz, 1.0)).xyz;
    let corner = vec2<f32>(f32(vertex & 1u), f32(vertex >> 1u)) * 2.0 - 1.0;
    let local = gx_impostor_corner(imp, corner, eye);
    let m = transpose(row.model);
    var out: GxImpostorOut;
    out.clip = gx_clip_position(frame.view_proj, row.model * vec4<f32>(local, 1.0), jitter);
    out.local = local;
    out.eye = eye;
    out.row0 = m[0];
    out.row1 = m[1];
    out.row2 = m[2];
    out.inverse0 = row.inverse[0].xyz;
    out.inverse1 = row.inverse[1].xyz;
    out.inverse2 = row.inverse[2].xyz;
    out.species_fade = vec2<u32>(row.species, bitcast<u32>(row.fade));
    return out;
}

@vertex
fn vs_impostor(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> GxImpostorOut {
    return gx_impostor_vertex(vertex, instance, frame.jitter.xy);
}

fn gx_impostor_world(in: GxImpostorOut, p: vec3<f32>) -> vec3<f32> {
    let h = vec4<f32>(p, 1.0);
    return vec3<f32>(dot(in.row0, h), dot(in.row1, h), dot(in.row2, h));
}

fn gx_impostor_world_normal(in: GxImpostorOut, n: vec3<f32>) -> vec3<f32> {
    return normalize(vec3<f32>(dot(in.inverse0, n), dot(in.inverse1, n), dot(in.inverse2, n)));
}

// The impostor at this fragment (call from uniform control flow: the mip takes derivatives): the
// object-space size of a pixel against that of a frame texel.
fn gx_impostor_at(in: GxImpostorOut) -> GxImpostorSample {
    let imp = gx_impostor_species[min(in.species_fade.x, GX_IMPOSTOR_SPECIES_MAX - 1u)];
    let texel = 2.0 * imp.radius / f32(imp.frame_px);
    let footprint = max(length(dpdx(in.local)), length(dpdy(in.local)));
    let lod = log2(max(footprint / texel, 1e-6));
    return gx_impostor_sample(imp, in.local, in.eye, lod);
}

// Whether this fragment is cut: below the coverage, or a pixel the other level of a crossfade
// keeps (the meshes' whole-pixel dither, `gx_forward_fade_threshold`).
fn gx_impostor_cut(in: GxImpostorOut, alpha: f32) -> bool {
    let fade = bitcast<f32>(in.species_fade.y);
    let faded = fade < 1.0 && !gx_lod_fade_keeps(fade, gx_forward_fade_threshold(in.clip.xy));
    return faded || alpha < GX_IMPOSTOR_CUTOFF;
}

// The reconstructed surface's device depth (the `_depth` entries).
fn gx_impostor_depth(world: vec3<f32>) -> f32 {
    let clip = frame.view_proj * vec4<f32>(world, 1.0);
    return clip.z / clip.w;
}

// The impostor lit like a built-in opaque surface at `world`.
fn gx_impostor_shade(in: GxImpostorOut, s: GxImpostorSample, world: vec3<f32>) -> vec3<f32> {
    gx_sun_shadow_context(in.clip.xy, frame.shadow_counts.z, frame.shadow_soft.y);
    gx_sun_shadow_end_fade(frame.shadow_soft.z);
    let n = gx_impostor_world_normal(in, s.normal);
    var surface = Surface(world, n, n, vec3<f32>(0.0), s.albedo, 1.0, s.surface.y, s.roughness);
    surface.v = normalize(frame.camera_pos.xyz - world);
    gx_material_ao = s.surface.x;
    gx_screen_reflection = gx_screen_reflection_at();
    var sun = normalize(frame.sun_dir.xyz);
    if GX_SCENE_HDR {
        sun = gx_sun_area_direction(sun, frame.sun_dir.w, surface.n, surface.v);
    }
    var color = gx_ambient(surface);
    color += gx_sun(surface, sun);
    color = gx_local_lights(color, surface);
    return gx_forward_fog(color, world);
}

@fragment
fn fs_impostor(in: GxImpostorOut) -> @location(0) vec4<f32> {
    let s = gx_impostor_at(in);
    if gx_impostor_cut(in, s.alpha) {
        discard;
    }
    return vec4<f32>(gx_encode_ldr(gx_impostor_shade(in, s, gx_impostor_world(in, s.position))), 1.0);
}

struct GxImpostorDepthTarget {
    @location(0) color: vec4<f32>,
    @builtin(frag_depth) depth: f32,
}

@fragment
fn fs_impostor_depth(in: GxImpostorOut) -> GxImpostorDepthTarget {
    let s = gx_impostor_at(in);
    if gx_impostor_cut(in, s.alpha) {
        discard;
    }
    let world = gx_impostor_world(in, s.position);
    var out: GxImpostorDepthTarget;
    out.color = vec4<f32>(gx_encode_ldr(gx_impostor_shade(in, s, world)), 1.0);
    out.depth = gx_impostor_depth(world);
    return out;
}

// The prepass: the impostor's depth and its world normal.
@fragment
fn fs_impostor_prepass(in: GxImpostorOut) -> @location(0) vec2<f32> {
    let s = gx_impostor_at(in);
    if gx_impostor_cut(in, s.alpha) {
        discard;
    }
    return gx_oct_encode(gx_impostor_world_normal(in, s.normal));
}

struct GxImpostorPrepassDepthTarget {
    @location(0) normal: vec2<f32>,
    @builtin(frag_depth) depth: f32,
}

@fragment
fn fs_impostor_prepass_depth(in: GxImpostorOut) -> GxImpostorPrepassDepthTarget {
    let s = gx_impostor_at(in);
    if gx_impostor_cut(in, s.alpha) {
        discard;
    }
    var out: GxImpostorPrepassDepthTarget;
    out.normal = gx_oct_encode(gx_impostor_world_normal(in, s.normal));
    out.depth = gx_impostor_depth(gx_impostor_world(in, s.position));
    return out;
}

// --- The motion prepass (RQ5.6): group 3 is the motion node's group (`motion::MotionNode`). An
// impostor stands still: its reconstructed surface point moves by the camera alone, so a panning
// camera reprojects the surface, not the quad turning to face it.

// Mirrors `motion::GpuMotionFrame` (prepass.wgsl's `MotionFrame`).
struct GxImpostorMotionFrame {
    prev_view_proj: mat4x4<f32>,
    jitter: vec4<f32>,
    reproject: mat4x4<f32>,
}

@group(3) @binding(0) var<uniform> gx_impostor_motion: GxImpostorMotionFrame;

struct GxImpostorMotionTargets {
    @location(0) normal: vec2<f32>,
    @location(1) motion: vec2<f32>,
    @location(2) reactive: f32,
}

@vertex
fn vs_impostor_motion(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> GxImpostorOut {
    var out = gx_impostor_vertex(vertex, instance, gx_impostor_motion.jitter.xy);
    let previous = transpose(gx_impostor_motion.prev_view_proj);
    out.previous_x = previous[0];
    out.previous_y = previous[1];
    out.previous_w = previous[3];
    return out;
}

fn gx_impostor_motion_targets(in: GxImpostorOut, s: GxImpostorSample, world: vec3<f32>) -> GxImpostorMotionTargets {
    var out: GxImpostorMotionTargets;
    out.normal = gx_oct_encode(gx_impostor_world_normal(in, s.normal));
    out.reactive = 0.0;
    out.motion = vec2<f32>(0.0);
    let current = frame.view_proj * vec4<f32>(world, 1.0);
    let h = vec4<f32>(world, 1.0);
    let previous = vec4<f32>(dot(in.previous_x, h), dot(in.previous_y, h), 0.0, dot(in.previous_w, h));
    // A point behind last frame's camera has no reprojection: no motion, and no history.
    if previous.w <= 1e-6 || current.w <= 1e-6 {
        out.reactive = 1.0;
        return out;
    }
    out.motion = current.xy / current.w - previous.xy / previous.w;
    return out;
}

@fragment
fn fs_impostor_motion(in: GxImpostorOut) -> GxImpostorMotionTargets {
    let s = gx_impostor_at(in);
    if gx_impostor_cut(in, s.alpha) {
        discard;
    }
    return gx_impostor_motion_targets(in, s, gx_impostor_world(in, s.position));
}

struct GxImpostorMotionDepthTargets {
    @location(0) normal: vec2<f32>,
    @location(1) motion: vec2<f32>,
    @location(2) reactive: f32,
    @builtin(frag_depth) depth: f32,
}

@fragment
fn fs_impostor_motion_depth(in: GxImpostorOut) -> GxImpostorMotionDepthTargets {
    let s = gx_impostor_at(in);
    if gx_impostor_cut(in, s.alpha) {
        discard;
    }
    let world = gx_impostor_world(in, s.position);
    let targets = gx_impostor_motion_targets(in, s, world);
    var out: GxImpostorMotionDepthTargets;
    out.normal = targets.normal;
    out.motion = targets.motion;
    out.reactive = targets.reactive;
    out.depth = gx_impostor_depth(world);
    return out;
}
