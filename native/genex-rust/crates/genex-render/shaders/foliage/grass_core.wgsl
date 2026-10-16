// The grass's draws (renderer pass 2 A.8): the draw group (group 2 of every grass pipeline) and
// the blade every grass entry point shares, the world pass's, the prepass's, the motion
// prepass's and the casters' alike, so their positions agree bit for bit.
//
// A drawn blade is one instance: `gx_grass_order` names its record in `gx_grass_regions` (the
// generation's output), the vertex index names its point on a strip of `time.z` segments and a
// tip. The blade is a quadratic Bezier (after jadedbay/bevy_procedural_grass's blade, the
// idea only) from its root up and over towards its own lean plus the shared wind's lean
// (`gx_wind` at the time asked: this frame's for the picture, last frame's for its motion), its
// length kept as it bends; its normal is rounded across its width and, far away, eased towards
// the sky so a distant meadow shades as one surface (after 2Retr0/GodotGrass, the idea only). Far blades are
// widened by as much as the field thinned there, so the cover holds.

@group(2) @binding(0) var<uniform> gx_grass: GxGrass;
@group(2) @binding(1) var<storage, read> gx_grass_regions: array<vec4<u32>>;
@group(2) @binding(2) var<storage, read> gx_grass_order: array<u32>;

// The blade's width at its tip against its root.
const GX_GRASS_TIP_TAPER: f32 = 0.12;
// How far the gust leans a blade and the flutter shivers it (shares of its height).
const GX_GRASS_GUST_LEAN: f32 = 0.42;
const GX_GRASS_FLUTTER: f32 = 0.07;
// A blade's own lean (shares of its height), from its random.
const GX_GRASS_LEAN: vec2<f32> = vec2<f32>(0.12, 0.38);
// How much a blade's width rounds its normal.
const GX_GRASS_ROUND: f32 = 0.45;
// How far towards the sky a blade's normal eases near the camera and at the radius: a blade
// standing up faces the horizon, but the meadow it belongs to faces the sky (Ghost of Tsushima
// lights its blades partly with the ground's normal, ideas only).
const GX_GRASS_NEAR_UP: f32 = 0.3;
const GX_GRASS_FAR_UP: f32 = 0.75;
// Far blades are drawn wider (up to 1 + this, from the first distance to the second, metres), so a
// blade never thins under a pixel and shimmers (the showcase meadow's rule before A.8).
const GX_GRASS_FAR_WIDEN: f32 = 1.4;
const GX_GRASS_WIDEN_FROM: vec2<f32> = vec2<f32>(6.0, 35.0);

// A point of a blade.
struct GxGrassPoint {
    position: vec3<f32>,
    normal: vec3<f32>,
    // 0 at the root, 1 at the tip.
    along: f32,
    // The blade's width at its tip (metres; a flower's width).
    tip_width: f32,
}

// Instance `instance`'s blade.
fn gx_grass_blade(instance: u32) -> GxGrassBlade {
    return gx_grass_unpack(gx_grass_regions[gx_grass_order[instance]]);
}

// Vertex `vertex` of `blade` swaying at `t` simulated seconds, seen from `camera`.
fn gx_grass_point(blade: GxGrassBlade, vertex: u32, t: f32, camera: vec3<f32>) -> GxGrassPoint {
    let segments = max(u32(gx_grass.time.z), 1u);
    var level = 1.0;
    var side = 0.0;
    if vertex < 2u * segments {
        level = f32(vertex / 2u) / f32(segments);
        side = f32(vertex % 2u) * 2.0 - 1.0;
    }
    let layer = gx_grass.layers[blade.layer];
    let facing = vec3<f32>(cos(blade.yaw), 0.0, sin(blade.yaw));
    let across = vec3<f32>(-sin(blade.yaw), 0.0, cos(blade.yaw));
    let distance_to_eye = distance(blade.root, camera);
    let radius = gx_grass.camera.w;
    // Widened by as much as the field thinned (`foliage::distance_share`), so the cover holds.
    let share = max(gx_grass_distance_share(min(distance_to_eye, radius * GX_GRASS_FAR_SHARE), radius), GX_GRASS_FAR_DENSITY);
    let widen = 1.0 + GX_GRASS_FAR_WIDEN * smoothstep(GX_GRASS_WIDEN_FROM.x, GX_GRASS_WIDEN_FROM.y, distance_to_eye);
    let root_width = mix(layer.width.x, layer.width.y, blade.tint) * blade.grown * widen / sqrt(share);
    let h = blade.height;
    let air = gx_wind(blade.root, t);
    let lean = facing * mix(GX_GRASS_LEAN.x, GX_GRASS_LEAN.y, blade.tint) + GX_WIND_DIR * (GX_GRASS_GUST_LEAN * air.gust + GX_GRASS_FLUTTER * air.flutter);
    // The tip over the lean, the blade's length kept.
    let reach = min(length(lean), 0.9);
    let over = select(vec3<f32>(0.0), lean * (reach / max(length(lean), 1e-6)), reach > 0.0);
    let tip = blade.root + vec3<f32>(over.x * h, h * sqrt(1.0 - reach * reach), over.z * h);
    let control = blade.root + vec3<f32>(0.0, h * 0.62, 0.0);
    let s = level;
    let curve = blade.root * ((1.0 - s) * (1.0 - s)) + control * (2.0 * (1.0 - s) * s) + tip * (s * s);
    let tangent = (control - blade.root) * (2.0 * (1.0 - s)) + (tip - control) * (2.0 * s);
    let width = root_width * (1.0 - level * (1.0 - GX_GRASS_TIP_TAPER));
    var out: GxGrassPoint;
    out.position = curve + across * (width * side * 0.5);
    let flat_normal = normalize(cross(tangent, across) + vec3<f32>(0.0, 1e-4, 0.0));
    let rounded = normalize(flat_normal + across * (side * GX_GRASS_ROUND));
    let up = mix(GX_GRASS_NEAR_UP, GX_GRASS_FAR_UP, smoothstep(radius * GX_GRASS_NEAR_SHARE, radius, distance_to_eye));
    out.normal = normalize(mix(rounded, vec3<f32>(0.0, 1.0, 0.0), up));
    out.along = level;
    out.tip_width = root_width * GX_GRASS_TIP_TAPER;
    return out;
}
