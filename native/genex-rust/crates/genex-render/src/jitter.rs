//! TAA's sub-pixel jitter (plan §2.7; RQ5.0 contract, RQ5.2 wires it): Halton(2, 3) keyed to the
//! renderer frame index (frames drawn since the history's last reset, a settled capture's settle
//! index), so Live and captures walk the same positions from index 0 after every reset, and a
//! device drawing every second or third sim tick still visits every position of the cycle.
//!
//! The sequence is pure integer arithmetic and one correctly rounded division per axis, so every
//! destination computes the same bits. The offset is applied through `gx_clip_position` (the
//! camera's depth writers only; never shadows or cull planes) and removed again from motion
//! vectors. [`crate::settings::FrameConfig::jitter`] carries it, zero unless TAA is drawn.

use crate::settings::JitterCycle;

/// No offset: frames without TAA (`GX_NO_JITTER` in `shaders/clip_position.wgsl`).
pub const NO_JITTER: [f32; 2] = [0.0, 0.0];
/// The Halton bases of the x and y offsets.
pub const HALTON_BASES: [u32; 2] = [2, 3];

/// The radical inverse of `index` in `base` (the Halton sequence's `index`-th value), in `[0, 1)`.
/// Index 0 is 0, so the sequence a jitter reads starts at index 1.
pub fn halton(index: u32, base: u32) -> f32 {
    let base = base.max(2);
    let (mut numerator, mut denominator, mut rest) = (0u64, 1u64, u64::from(index));
    while rest > 0 {
        numerator = numerator * u64::from(base) + rest % u64::from(base);
        denominator *= u64::from(base);
        rest /= u64::from(base);
    }
    (numerator as f64 / denominator as f64) as f32
}

/// The position of frame `frame_index` in `cycle`: `frame_index` modulo the cycle's length.
pub fn position(frame_index: u64, cycle: JitterCycle) -> u32 {
    (frame_index % u64::from(cycle.frames())) as u32
}

/// TAA's offset of frame `frame_index`, in render pixels within `(-0.5, 0.5)`: Halton(2, 3) at
/// the frame's [`position`] + 1, centred on the pixel (x right, y down).
pub fn offset_px(frame_index: u64, cycle: JitterCycle) -> [f32; 2] {
    let at = position(frame_index, cycle) + 1;
    HALTON_BASES.map(|base| halton(at, base) - 0.5)
}

/// `offset` (render pixels, y down) as the NDC offset `gx_clip_position` adds (y up) on a
/// `render`-sized target.
pub fn offset_ndc(offset: [f32; 2], render: (u32, u32)) -> [f32; 2] {
    let (w, h) = (render.0.max(1) as f32, render.1.max(1) as f32);
    [2.0 * offset[0] / w, -2.0 * offset[1] / h]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_halton_sequence_is_the_radical_inverse() {
        let base2: Vec<f32> = (0..5).map(|i| halton(i, 2)).collect();
        assert_eq!(base2, [0.0, 0.5, 0.25, 0.75, 0.125]);
        let base3: Vec<f32> = (1..4).map(|i| halton(i, 3)).collect();
        assert_eq!(base3, [1.0 / 3.0, 2.0 / 3.0, 1.0 / 9.0]);
        assert!((0..10_000).all(|i| (0.0..1.0).contains(&halton(i, 3))));
    }

    #[test]
    fn each_cycle_repeats_from_index_zero_and_stays_inside_the_pixel() {
        for cycle in JitterCycle::ALL {
            let n = u64::from(cycle.frames());
            let first: Vec<[f32; 2]> = (0..n).map(|i| offset_px(i, cycle)).collect();
            let second: Vec<[f32; 2]> = (n..2 * n).map(|i| offset_px(i, cycle)).collect();
            assert_eq!(first, second, "cycle {n} repeats");
            assert_eq!(first[0], [0.0, 1.0 / 3.0 - 0.5], "a reset starts at Halton index 1");
            for offset in &first {
                assert!(offset.iter().all(|axis| (-0.5..0.5).contains(axis)), "{offset:?}");
            }
            let mut distinct = first.clone();
            distinct.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            distinct.dedup();
            assert_eq!(distinct.len() as u64, n, "every position of the cycle is its own");
        }
        // The cycle's mean is near the pixel centre: no net shift of the resolved image.
        let mean: f32 = (0..16).map(|i| offset_px(i, JitterCycle::Sixteen)[0]).sum::<f32>() / 16.0;
        assert!(mean.abs() < 0.04, "{mean}");
    }

    #[test]
    fn the_ndc_offset_is_two_pixels_per_render_side_with_y_up() {
        assert_eq!(offset_ndc([0.5, 0.25], (100, 50)), [0.01, -0.01]);
        assert_eq!(offset_ndc(NO_JITTER, (1, 1)), [0.0, -0.0]);
        assert_eq!(offset_ndc([0.5, 0.5], (0, 0)), [1.0, -1.0], "a zero size reads as one pixel");
    }
}
