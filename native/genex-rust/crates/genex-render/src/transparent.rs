//! Transparency: draws with a base-colour alpha below 255 are blended over the opaque frame after
//! it, farthest first. They stay CPU-sorted direct draws (plan "Renderer scope"): they are culled
//! against the camera on the CPU, sorted by distance from the eye with ties in draw order, and
//! drawn one instance each with depth testing but no depth writes. They cast no shadows.

/// The order to draw transparent instances in: indices into `centers`, farthest from `eye` first,
/// equal distances in their given order.
pub fn back_to_front(eye: [f32; 3], centers: &[[f32; 3]]) -> Vec<u32> {
    let distance = |c: &[f32; 3]| {
        let d = [c[0] - eye[0], c[1] - eye[1], c[2] - eye[2]];
        d[0] * d[0] + d[1] * d[1] + d[2] * d[2]
    };
    let mut order: Vec<u32> = (0..centers.len() as u32).collect();
    // A stable sort: ties keep draw order, so a frame never depends on the sort's internals.
    order.sort_by(|&a, &b| distance(&centers[b as usize]).total_cmp(&distance(&centers[a as usize])));
    order
}
