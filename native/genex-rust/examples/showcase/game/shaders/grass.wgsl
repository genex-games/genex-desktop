// Grass: tens of thousands of instanced blades (a seven-vertex strip each) that bend in the wind,
// lit by the renderer's sun like the terrain under them and glowing gold where the low sun shines
// through them. Blades fade out with distance and into the look's fog.

struct Wind {
    // x: simulated seconds; y: how much wider each blade is drawn (fewer blades on weaker devices).
    params: vec4<f32>,
}

struct BladeIn {
    // xyz: root; w: yaw.
    @location(0) root_yaw: vec4<f32>,
    // x: height, y: width, z: sunlight (0 in shadow), w: tint (flowers above 0.965).
    @location(1) shape: vec4<f32>,
}

struct GrassOut {
    @builtin(position) clip: vec4<f32>,
    @location(0) world: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) along: f32,
    @location(3) @interpolate(flat) sun_tint: vec2<f32>,
}

@group(0) @binding(0) var<uniform> gx_frame: GxFrameV2;
// The sun's shadow cascades (the v2 tables'), so the deer, the cabin and the trees shadow the
// blades as they shadow the terrain under them (pass-1 gate: the deer seemed to float).
@group(0) @binding(9) var gx_shadow_map: texture_depth_2d_array;
@group(0) @binding(10) var gx_shadow_sampler: sampler_comparison;
@group(1) @binding(0) var<uniform> wind: Wind;

const LEVELS: f32 = 3.0;
const FADE_START: f32 = 34.0;
const FADE_END: f32 = 50.0;
const FLOWER_TINT: f32 = 0.965;
// The blades' width against the layout's: slim, as a meadow's are.
const BLADE_WIDTH: f32 = 0.45;

@vertex
fn vs_grass(@builtin(vertex_index) i: u32, blade: BladeIn) -> GrassOut {
    let level = f32(min(i / 2u, 3u)) / LEVELS;
    var side = f32(i % 2u) * 2.0 - 1.0;
    if i == 6u {
        side = 0.0;
    }
    let root = blade.root_yaw.xyz;
    let yaw = blade.root_yaw.w;
    let distance_to_eye = distance(root, gx_frame.camera_pos.xyz);
    let fade = 1.0 - smoothstep(FADE_START, FADE_END, distance_to_eye);
    let height = blade.shape.x * fade;
    // Far blades get wider so they do not shimmer into single pixels.
    let width = blade.shape.y * BLADE_WIDTH * wind.params.y * (1.0 - level * 0.85) * (1.0 + smoothstep(8.0, 40.0, distance_to_eye) * 1.6);
    let facing = vec3<f32>(cos(yaw), 0.0, sin(yaw));
    let across = vec3<f32>(-sin(yaw), 0.0, cos(yaw));
    let t = wind.params.x;
    let gust = 0.5 + 0.3 * sin(t * 1.6 + root.x * 0.21 + root.z * 0.13) + 0.2 * sin(t * 0.55 + root.x * 0.045 - root.z * 0.03);
    let wind_dir = normalize(vec3<f32>(0.55, 0.0, 0.83));
    let curve = level * level * height;
    let flutter = 0.06 * sin(t * 4.0 + root.x * 1.7 + root.z * 1.3) * curve;
    let position = root + across * width * side * 0.5 + vec3<f32>(0.0, height * level * (1.0 - 0.15 * gust * level), 0.0)
        + wind_dir * (0.38 * gust * curve + flutter) + facing * 0.18 * curve;
    var out: GrassOut;
    out.clip = gx_frame.view_proj * vec4<f32>(position, 1.0);
    out.world = position;
    out.normal = normalize(facing + across * side * 0.35 + vec3<f32>(0.0, 0.45, 0.0));
    out.along = level;
    out.sun_tint = blade.shape.zw;
    return out;
}

// The sun's visibility at `world` from the cascade its view depth falls in (one bilinear
// comparison, lifted along +y by the cascade's normal offset as the renderer lifts a lookup off a
// surface); 1 beyond the last cascade or on a frame without sun shadows.
fn sun_visibility(world: vec3<f32>) -> f32 {
    if gx_frame.cascade_splits.w < 0.5 {
        return 1.0;
    }
    let depth = dot(world - gx_frame.camera_pos.xyz, gx_frame.camera_forward.xyz);
    let count = min(gx_frame.counts.y, 4u);
    for (var c = 0u; c < count; c++) {
        if depth > gx_frame.cascade_ends[c] {
            continue;
        }
        let clip = gx_frame.cascade_view_proj[c] * vec4<f32>(world + vec3<f32>(0.0, gx_frame.cascade_offsets[c], 0.0), 1.0);
        let ndc = clip.xyz / clip.w;
        if abs(ndc.x) > 1.0 || abs(ndc.y) > 1.0 || ndc.z > 1.0 {
            return 1.0;
        }
        let uv = vec2<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
        return textureSampleCompareLevel(gx_shadow_map, gx_shadow_sampler, uv, i32(c), ndc.z - gx_frame.shadow_params.x);
    }
    return 1.0;
}

@fragment
fn fs_grass(in: GrassOut, @builtin(front_facing) front: bool) -> @location(0) vec4<f32> {
    var n = normalize(in.normal);
    if !front {
        n = vec3<f32>(-n.x, n.y, -n.z);
    }
    let sun = min(in.sun_tint.x, sun_visibility(in.world));
    let tint = in.sun_tint.y;
    let root_color = vec3<f32>(0.012, 0.03, 0.008);
    let green = mix(vec3<f32>(0.045, 0.12, 0.022), vec3<f32>(0.11, 0.17, 0.035), tint);
    let dry = vec3<f32>(0.30, 0.22, 0.07);
    let tip = mix(green, dry, smoothstep(0.6, 0.95, tint));
    var albedo = mix(root_color, tip, pow(in.along, 0.8));
    if tint > FLOWER_TINT && in.along > 0.78 {
        let pick = fract(tint * 173.0);
        albedo = select(select(vec3<f32>(0.85, 0.80, 0.72), vec3<f32>(0.85, 0.62, 0.08), pick > 0.4), vec3<f32>(0.42, 0.24, 0.62), pick > 0.75);
    }
    let l = normalize(gx_frame.sun_dir.xyz);
    let lit = max(dot(n, l), 0.0) * 0.65 + 0.35 * max(l.y, 0.0);
    let v = normalize(gx_frame.camera_pos.xyz - in.world);
    let through = pow(max(dot(-v, normalize(GLOW_DIR)), 0.0), 3.0) * in.along;
    var color = albedo * (gx_frame.sun_color.rgb / PI * lit * mix(0.15, 1.0, sun) + gx_frame.ambient.rgb * (0.5 + 0.5 * in.along));
    color += vec3<f32>(0.9, 0.55, 0.16) * through * (0.15 + 0.85 * sun) * (0.12 + luma(tip) * 1.2);
    return vec4<f32>(scene_rgb(look_fog(color, in.world)), 1.0);
}
