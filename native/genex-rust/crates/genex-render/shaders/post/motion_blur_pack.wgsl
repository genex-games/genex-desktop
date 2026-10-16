// Motion blur's view distance and packed speed (after a depth chunk): the reconstruction reads one
// r32uint texel per sample instead of the motion and the depth (KinoMotion packs its velocity and
// depth into one 10/10/10/2 texel). A sample needs its velocity's length only, so the word holds
// that (GA1 wave 4: no unpack and square root per sample; the pixel's own velocity is read from
// the motion once).

// The largest view distance kept (the sky's is infinite).
const MB_DISTANCE_MAX: f32 = 1.0e20;
// The packed distance: log2 of metres from this, over this many stops, in 12 bits (0.5% steps;
// a distance past the range, the sky's included, takes the last step).
const MB_LOG_DISTANCE_MIN: f32 = -8.0;
const MB_LOG_DISTANCE_RANGE: f32 = 30.0;
const MB_LOG_DISTANCE_STEPS: f32 = 4095.0;
// The packed speed: 20 bits over the largest radius (zero is a step: a still pixel unpacks to
// exactly no motion).
const MB_SPEED_STEPS: f32 = 1048575.0;
const MB_SPEED_MASK: u32 = 1048575u;

// The view distance at render pixel `p` (`MotionBlurParams::depth`).
fn mb_distance(p: vec2<i32>) -> f32 {
    let z = mb_depth_at(p);
    let numerator = abs(mb.depth.x + mb.depth.y * z);
    let denominator = abs(mb.depth.z + mb.depth.w * z);
    return min(numerator / max(denominator, max(numerator / MB_DISTANCE_MAX, 1.0e-30)), MB_DISTANCE_MAX);
}

// The speed of velocity `v` (no longer than the largest radius) and view distance `d` in one word.
fn mb_pack(v: vec2<f32>, d: f32) -> u32 {
    let s = clamp(round(length(v) * mb.velocity.w * MB_SPEED_STEPS), 0.0, MB_SPEED_STEPS);
    let l = clamp(round((log2(max(d, 1.0e-30)) - MB_LOG_DISTANCE_MIN) / MB_LOG_DISTANCE_RANGE * MB_LOG_DISTANCE_STEPS), 0.0, MB_LOG_DISTANCE_STEPS);
    return u32(s) | (u32(l) << 20u);
}

// A packed word's speed, render pixels.
fn mb_unpack_speed(packed: u32) -> f32 {
    return f32(packed & MB_SPEED_MASK) * (mb.velocity.z / MB_SPEED_STEPS);
}

// A packed word's view distance, log2 of metres.
fn mb_unpack_log_distance(packed: u32) -> f32 {
    return f32(packed >> 20u) / MB_LOG_DISTANCE_STEPS * MB_LOG_DISTANCE_RANGE + MB_LOG_DISTANCE_MIN;
}
