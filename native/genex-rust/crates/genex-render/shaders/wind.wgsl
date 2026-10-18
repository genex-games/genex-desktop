// The shared wind (renderer pass 2, B.7; A.8's A4.3 builds on it): one gust and one flutter field
// over the world, a function of the point's root and simulated seconds only. Vertex animation
// evaluates it at this frame's time and at last frame's (`PassFrame::prev_tick`, `GxDrawV2`'s
// `prev_time`), so the sway carries its own motion vectors and TAA reprojects it instead of
// trailing it. `wind.rs` holds its CPU twin, held to it by tests/custom_pass_motion.rs.

// The wind's direction over the ground (unit, y 0).
const GX_WIND_DIR: vec3<f32> = vec3<f32>(0.55238038, 0.0, 0.83359218);

// The wind at a plant rooted at `root`, `t` simulated seconds in.
struct GxWind {
    // The slow gust, 0.0..1.0 (0.5 on average): how far the wind leans a stem.
    gust: f32,
    // The fast flutter, -1.0..1.0: a stem's quick shiver.
    flutter: f32,
}

fn gx_wind(root: vec3<f32>, t: f32) -> GxWind {
    var wind: GxWind;
    wind.gust = 0.5 + 0.3 * sin(t * 1.6 + root.x * 0.21 + root.z * 0.13) + 0.2 * sin(t * 0.55 + root.x * 0.045 - root.z * 0.03);
    wind.flutter = sin(t * 4.0 + root.x * 1.7 + root.z * 1.3);
    return wind;
}
