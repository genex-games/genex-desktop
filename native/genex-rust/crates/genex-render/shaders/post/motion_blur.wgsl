// Motion blur's blurs (A.9 / A7.3), after a depth chunk and motion_blur_pack.wgsl:
// - the reconstruction tier: a port of keijiro/KinoMotion's Reconstruction.cginc (MIT; McGuire,
//   Hennessy, Bukowski and Osman 2012). Samples along the neighbourhood's longest velocity and the
//   pixel's own, split into foreground and background by depth: a sample counts as far as its
//   own (foreground) or the background's (background) velocity reaches the pixel.
// - the direct tier: after Bevy 0.20.0's motion_blur.wesl (MIT OR Apache-2.0). Samples along the
//   pixel's own velocity; a nearer sample counts only where its own motion could have reached the
//   pixel. Genex compares the sample's exposure with the pixel's (Bevy, the sample's whole frame
//   of motion).
// Both read whole texels at sample offsets fixed relative to the pixel, with no per-pixel noise on
// them (KinoMotion and Bevy jitter each pixel's samples by a noise): a fixed filter moves with the
// content, so a steady pan draws a steady blur, and a sample's colour is the texel whose depth
// and velocity decided its weight (a filtered read pulled a rejected neighbour's colour in: a still
// prop's red bled 3 px over its panning background).

// The tiles' neighbourhood maximum velocity.
@group(0) @binding(3) var mb_neighbour: texture_2d<f32>;
// The HDR scene at render size.
@group(0) @binding(4) var mb_scene: texture_2d<f32>;
// The packed velocity and distance at render size (the block reduction writes it).
@group(0) @binding(7) var mb_packed: texture_2d<u32>;
// The shortest velocity a sample's weight divides by (render pixels).
const MB_VELOCITY_EPSILON: f32 = 1.0e-4;
// A sample nearer than the pixel by this many stops of view distance is wholly in front of it
// per stop (KinoMotion: 1 / 20 of the pixel's distance; 20 ln 2 per stop is the same slope near
// equal distances, and compares the packed log distances without an exp2 a sample).
const MB_DEPTH_SOFTNESS_PER_STOP: f32 = 13.862944;

// The render pixel holding `position` (render pixels, pixel centres at +0.5).
fn mb_pixel(position: vec2<f32>) -> vec2<i32> {
    return clamp(vec2<i32>(floor(position)), vec2<i32>(0), mb_last());
}


// Whether sample `count` is in the second half of each `interval` (KinoMotion's Interval).
fn mb_interval(count: u32, interval: u32) -> bool {
    return count % interval >= interval / 2u;
}

// The neighbourhood's longest velocity at `frag`, the tile looked up a quarter tile off in a
// noisy direction so tile edges do not show (KinoMotion's JitterTile).
fn mb_neighbour_max(frag: vec2<f32>) -> vec2<f32> {
    let angle = mb_noise(frag + vec2<f32>(2.0, 0.0)) * 2.0 * MB_PI;
    let jitter = vec2<f32>(cos(angle), sin(angle)) * mb.size.z * 0.25;
    let last = vec2<i32>(textureDimensions(mb_neighbour)) - vec2<i32>(1);
    let tile = clamp(vec2<i32>(floor((frag + jitter) / mb.size.z)), vec2<i32>(0), last);
    return textureLoad(mb_neighbour, tile, 0).xy;
}

@fragment
fn fs_mb_reconstruct(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
    let p = vec2<i32>(frag.xy);
    let c_p = textureLoad(mb_scene, p, 0);
    let v_max = mb_neighbour_max(frag.xy);
    let l_v_max = length(v_max);
    // Nothing near moves far enough to blur: the scene, bit for bit.
    if l_v_max < mb.samples.z {
        return c_p;
    }
    let packed_p = textureLoad(mb_packed, p, 0).x;
    let v_p = mb_unpack_velocity(packed_p);
    let log_d_p = mb_unpack_log_distance(packed_p);
    let l_v_p = max(length(v_p), 0.5);
    // The pixel's own velocity as the second direction, unless it is short beside the longest
    // (rescaled to the longest's length).
    let v_alt = select(v_max, v_p * (l_v_max / l_v_p), l_v_p * 2.0 > l_v_max);
    // A pair of samples a pixel apart along the longest velocity, up to the tier's count (KinoMotion
    // spaces them two pixels apart and hides the gaps with its noise).
    let pairs = floor(min(mb.samples.x, l_v_max));
    let dt = 1.0 / pairs;
    var t = 1.0 - dt * 0.5;
    // The background's velocity: the longest seen behind the pixel so far.
    var l_v_bg = max(l_v_p, 1.0);
    var acc = vec4<f32>(0.0);
    let samples = u32(pairs) * 2u;
    for (var count = 0u; count < samples; count++) {
        // Directions alternate every two samples; each pair samples both sides.
        let v_s = select(v_max, v_alt, mb_interval(count, 4u));
        let t_s = select(t, -t, mb_interval(count, 2u));
        let q = mb_pixel(frag.xy + v_s * t_s);
        // The distance to the texel read (KinoMotion, to the sample's position): a still
        // background's texel a pixel away does not reach this one (a 0.5 px position rounded onto
        // the neighbour softened a still wall wherever a moving tile was near).
        let l_t = distance(frag.xy, vec2<f32>(q) + vec2<f32>(0.5));
        let c = textureLoad(mb_scene, q, 0).rgb;
        let packed = textureLoad(mb_packed, q, 0).x;
        let v = mb_unpack_velocity(packed);
        let log_d = mb_unpack_log_distance(packed);
        // 1 where the sample is in front of the pixel, 0 behind.
        let fg = saturate((log_d_p - log_d) * MB_DEPTH_SOFTNESS_PER_STOP);
        let l_v = mix(l_v_bg, length(v), fg);
        // Reaches the pixel, spread over its velocity, by a triangular window.
        // (A still foreground sample has no velocity: KinoMotion divides by its zero, which turned a
        // still prop's panning surroundings black.)
        let w = saturate(l_v - l_t) / max(l_v, MB_VELOCITY_EPSILON) * (1.2 - t);
        acc += vec4<f32>(c, 1.0) * w;
        l_v_bg = max(l_v_bg, l_v);
        if mb_interval(count, 2u) {
            t -= dt;
        }
    }
    acc += vec4<f32>(c_p.rgb, 1.0) * (1.2 / (l_v_bg * pairs * 2.0));
    return vec4<f32>(acc.rgb / acc.a, c_p.a);
}

@fragment
fn fs_mb_direct(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
    let p = vec2<i32>(frag.xy);
    let c_p = textureLoad(mb_scene, p, 0);
    let v_p = mb_velocity(p);
    // Moving under a pixel each way: the scene, bit for bit (and antialiasing is kept).
    if dot(v_p, v_p) < mb.samples.w * mb.samples.w {
        return c_p;
    }
    let d_p = mb_distance(p);
    // A sample a pixel apart each way, up to the tier's count.
    let n = i32(clamp(ceil(length(v_p)), 1.0, mb.samples.y));
    var acc = vec3<f32>(0.0);
    var total = 0.0;
    for (var i = -n; i < n; i++) {
        // Strata centres: n each way, none on the pixel itself.
        let step = v_p * ((f32(i) + 0.5) / f32(n));
        let position = frag.xy + step;
        if any(position < vec2<f32>(0.0)) || any(position > mb.size.xy) {
            continue;
        }
        let q = mb_pixel(position);
        var weight = 1.0;
        // A sample in front of the pixel counts only where its own motion, along this one, could
        // have carried it over the pixel.
        if mb_distance(q) < d_p {
            let v = mb_velocity(q);
            let reach = length(step);
            let similarity = select(0.0, abs(dot(step, v)) / (reach * length(v)), reach * length(v) > 0.0);
            if length(v) * similarity < reach {
                weight = 0.0;
            }
        }
        acc += textureLoad(mb_scene, q, 0).rgb * weight;
        total += weight;
    }
    if total <= 0.0 {
        return c_p;
    }
    return vec4<f32>(acc / total, c_p.a);
}
