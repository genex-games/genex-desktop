// Clouds: a layer of soft evening cumulus and long streaks high over the lake, drawn over the
// renderer's physical sky (which has none) and behind everything else: one full-screen triangle a
// hair in front of the far plane, so the depth test keeps it to the sky's pixels. Each pixel's
// view ray meets the layer's altitude; the clouds' shapes are drifting noise, lit by the low sun
// through the air (gold on the side towards it, a bright rim where it shines through them) and by
// the sky's own light (the environment's SH9 irradiance) from above.

struct Clouds {
    // x: simulated seconds.
    params: vec4<f32>,
}

struct CloudOut {
    @builtin(position) clip: vec4<f32>,
    @location(0) ndc: vec2<f32>,
}

@group(0) @binding(0) var<uniform> gx_frame: GxFrameV2;
@group(1) @binding(0) var<uniform> clouds: Clouds;

// The layer's altitude (metres), how far its texture repeats, the wind's drift (metres per second)
// and the share of the sky it covers.
const CLOUD_ALTITUDE: f32 = 1600.0;
const CLOUD_SCALE: f32 = 0.00042;
const CLOUD_WIND: vec2<f32> = vec2<f32>(5.0, 1.5);
const CLOUD_COVER: f32 = 0.5;
// The triangle's depth: a hair in front of the far plane under either depth convention.
const CLOUD_DEPTH_REVERSED: f32 = 1e-7;
const CLOUD_DEPTH_STANDARD: f32 = 0.999999;
// The sun's light on the layer is the frame's sun (already reddened by the air it crossed: the
// renderer passes it through the sky's transmittance), the forward scattering towards the sun and
// the clouds' own brightness under it.
const CLOUD_FORWARD_G: f32 = 0.55;
const CLOUD_SUN_SHARE: f32 = 0.42;
const CLOUD_SKY_SHARE: f32 = 0.9;

@vertex
fn vs_clouds(@builtin(vertex_index) i: u32) -> CloudOut {
    let uv = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
    let ndc = uv * 2.0 - 1.0;
    let depth = select(CLOUD_DEPTH_STANDARD, CLOUD_DEPTH_REVERSED, gx_frame.depth_reversed == 1u);
    var out: CloudOut;
    out.clip = vec4<f32>(ndc, depth, 1.0);
    out.ndc = ndc;
    return out;
}

// Where an octave's cells shrink to this share of a pixel's footprint it starts to fade to its
// mean, and it is gone at twice that: finer noise than a pixel only aliases under TAA's jitter
// (renderer pass 2, B.7: the far clouds near the horizon popped on a pan).
const OCTAVE_FADE_START: f32 = 0.25;

// `fbm2` with each octave faded to its mean where it is finer than `footprint` (noise units a pixel
// spans); exactly `fbm2` where every octave is coarser than the pixel.
fn fbm2_filtered(p: vec2<f32>, footprint: f32) -> f32 {
    var sum = 0.0;
    var amplitude = 0.5;
    var q = p;
    var cell = footprint;
    for (var i = 0; i < 5; i++) {
        let keep = 1.0 - smoothstep(OCTAVE_FADE_START, OCTAVE_FADE_START * 2.0, cell);
        sum += amplitude * mix(0.5, noise2(q), keep);
        q = q * 2.03 + vec2<f32>(17.1, 9.7);
        cell *= 2.03;
        amplitude *= 0.5;
    }
    return sum / 0.96875;
}

// Rounded noise for billowing tops: the fbm folded so its puffs are bright in the middle.
fn cloud_shape(p: vec2<f32>, footprint: f32) -> f32 {
    let base = fbm2_filtered(p, footprint);
    let detail = fbm2_filtered(p * 3.7 + vec2<f32>(base * 1.3, -base), footprint * 3.7);
    return base * 0.75 + detail * 0.25;
}

// The world direction through clip-space point `ndc`, from the camera's view and projection
// (jitter and either depth convention leave a ray's direction as it is).
fn view_ray(ndc: vec2<f32>) -> vec3<f32> {
    let proj = gx_frame.proj;
    let in_view = vec3<f32>((ndc.x + proj[2][0]) / proj[0][0], (ndc.y + proj[2][1]) / proj[1][1], -1.0);
    let view = gx_frame.view;
    let to_world = transpose(mat3x3<f32>(view[0].xyz, view[1].xyz, view[2].xyz));
    return normalize(to_world * in_view);
}

@fragment
fn fs_clouds(in: CloudOut) -> @location(0) vec4<f32> {
    let dir = view_ray(in.ndc);
    let t = clouds.params.x;
    let reach = CLOUD_ALTITUDE / max(dir.y, 0.004);
    let at = (gx_frame.camera_pos.xz + dir.xz * reach + CLOUD_WIND * t) * CLOUD_SCALE;
    // How much of the layer's noise one pixel spans (taken before any invocation leaves).
    let footprint = max(length(dpdx(at)), length(dpdy(at)));
    if dir.y <= 0.004 {
        discard;
    }
    // Cumulus where the noise rises over the cover, long streaks stretched along the wind.
    let puffs = smoothstep(1.0 - CLOUD_COVER, 1.0 - CLOUD_COVER + 0.22, cloud_shape(at, footprint));
    let streaks = smoothstep(0.58, 0.8, fbm2_filtered(at * vec2<f32>(0.35, 2.4) + vec2<f32>(7.0, 3.0), footprint * 2.4)) * 0.55;
    let density = max(puffs, streaks);
    // Thin towards the horizon (the layer's far edge is hundreds of kilometres off) and fade in
    // just above it, where the haze takes over.
    let horizon = smoothstep(0.012, 0.12, dir.y);
    let alpha = clamp(density * horizon, 0.0, 1.0) * 0.92;
    if alpha <= 0.002 {
        discard;
    }
    let sun = normalize(gx_frame.sun_dir.xyz);
    let sunlight = gx_frame.sun_color.rgb * smoothstep(-0.05, 0.0, sun.y);
    let g2 = CLOUD_FORWARD_G * CLOUD_FORWARD_G;
    let denominator = max(1.0 + g2 - 2.0 * CLOUD_FORWARD_G * dot(dir, sun), 1e-4);
    let forward = (1.0 - g2) / (4.0 * PI * denominator * sqrt(denominator));
    // Thick middles are darker underneath; thin edges glow where the sun shines through them.
    let thickness = smoothstep(0.2, 1.0, density);
    let lit = sunlight * CLOUD_SUN_SHARE * (mix(1.1, 0.55, thickness) + forward * mix(5.0, 1.2, thickness));
    var sky_light = gx_frame.ambient.rgb;
    if environment_lights() {
        sky_light = sh9_irradiance(gx_env_sh, vec3<f32>(0.0, 1.0, 0.0));
    }
    let color = lit + sky_light * CLOUD_SKY_SHARE * mix(1.0, 0.7, thickness);
    return vec4<f32>(scene_rgb(color) * alpha, alpha);
}
