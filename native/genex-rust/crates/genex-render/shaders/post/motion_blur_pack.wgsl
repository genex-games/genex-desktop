// Motion blur's view distance and packed velocity (after a depth chunk): the reconstruction reads
// one r32uint texel per sample instead of the motion and the depth (KinoMotion packs its velocity
// and depth into one 10/10/10/2 texel).

// The largest view distance kept (the sky's is infinite).
const MB_DISTANCE_MAX: f32 = 1.0e20;
// The packed distance: log2 of metres from this, over this many stops, in 12 bits (0.5% steps;
// a distance past the range, the sky's included, takes the last step).
const MB_LOG_DISTANCE_MIN: f32 = -8.0;
const MB_LOG_DISTANCE_RANGE: f32 = 30.0;
const MB_LOG_DISTANCE_STEPS: f32 = 4095.0;
// The packed velocity: each axis in 10 bits, 511 steps each way of the largest radius (zero is a
// step: a still pixel unpacks to exactly no motion).
const MB_VELOCITY_STEPS: f32 = 511.0;

// The view distance at render pixel `p` (`MotionBlurParams::depth`).
fn mb_distance(p: vec2<i32>) -> f32 {
    let z = mb_depth_at(p);
    let numerator = abs(mb.depth.x + mb.depth.y * z);
    let denominator = abs(mb.depth.z + mb.depth.w * z);
    return min(numerator / max(denominator, max(numerator / MB_DISTANCE_MAX, 1.0e-30)), MB_DISTANCE_MAX);
}

// Velocity `v` (no longer than the largest radius) and view distance `d` in one word.
fn mb_pack(v: vec2<f32>, d: f32) -> u32 {
    let q = clamp(round(v * mb.velocity.w * MB_VELOCITY_STEPS) + MB_VELOCITY_STEPS, vec2<f32>(0.0), vec2<f32>(2.0 * MB_VELOCITY_STEPS));
    let l = clamp(round((log2(max(d, 1.0e-30)) - MB_LOG_DISTANCE_MIN) / MB_LOG_DISTANCE_RANGE * MB_LOG_DISTANCE_STEPS), 0.0, MB_LOG_DISTANCE_STEPS);
    return u32(q.x) | (u32(q.y) << 10u) | (u32(l) << 20u);
}

// A packed word's velocity, render pixels.
fn mb_unpack_velocity(packed: u32) -> vec2<f32> {
    let q = vec2<f32>(f32(packed & 1023u), f32((packed >> 10u) & 1023u));
    return (q - MB_VELOCITY_STEPS) / MB_VELOCITY_STEPS * mb.velocity.z;
}

// A packed word's view distance, log2 of metres.
fn mb_unpack_log_distance(packed: u32) -> f32 {
    return f32(packed >> 20u) / MB_LOG_DISTANCE_STEPS * MB_LOG_DISTANCE_RANGE + MB_LOG_DISTANCE_MIN;
}
