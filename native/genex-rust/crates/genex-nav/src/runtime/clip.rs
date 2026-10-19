//! Boundary edges minus portal strips: the part of a node's open boundary that no boundary link
//! covers, in place of landmass's `geo` boolean ops (P2).
//!
//! landmass 0.9.3 (`src/nav_data.rs`, `update_modified_node`) builds one rectangle per boundary
//! link (the portal widened by the edge-link distance to each side), unions them with
//! `geo::BooleanOps::union` and keeps the boundary line strings outside the union
//! (`clip(.., invert = true)`). Only the segments of the result are used, so this does the same
//! per segment: each segment's parameter intervals inside any strip (a Cyrus–Beck clip against
//! the convex rectangle) are merged, and the complement is what remains. Same results up to
//! floating-point rounding (genex's own code; `geo` is MIT OR Apache-2.0 and none of it is copied).

use glam::Vec2;

/// A portal widened by `half_width` to each side: a rectangle around the portal segment.
pub(crate) fn portal_strip(portal: (Vec2, Vec2), half_width: f32) -> [Vec2; 4] {
    let forward = (portal.1 - portal.0).normalize_or_zero().perp() * half_width;
    [portal.0 + forward, portal.0 - forward, portal.1 - forward, portal.1 + forward]
}

/// The parameter interval of `segment` inside the convex quad `strip`, if any.
fn inside_interval(segment: (Vec2, Vec2), strip: &[Vec2; 4]) -> Option<(f32, f32)> {
    // Twice the signed area: positive for a counter-clockwise quad.
    let area: f32 = (0..4).map(|i| strip[i].perp_dot(strip[(i + 1) % 4])).sum();
    if area == 0.0 {
        return None;
    }
    let orientation = area.signum();
    let direction = segment.1 - segment.0;
    let (mut t_min, mut t_max) = (0.0_f32, 1.0_f32);
    for i in 0..4 {
        let (a, b) = (strip[i], strip[(i + 1) % 4]);
        // Inside is to the left of each edge of a counter-clockwise quad.
        let inward = (b - a).perp() * orientation;
        let start = inward.dot(segment.0 - a);
        let rate = inward.dot(direction);
        if rate == 0.0 {
            if start < 0.0 {
                return None;
            }
            continue;
        }
        let t = -start / rate;
        if rate > 0.0 {
            t_min = t_min.max(t);
        } else {
            t_max = t_max.min(t);
        }
    }
    (t_min < t_max).then_some((t_min, t_max))
}

/// The pieces of `segment` outside every strip, in order from `segment.0`.
pub(crate) fn subtract_strips(segment: (Vec2, Vec2), strips: &[[Vec2; 4]]) -> Vec<(Vec2, Vec2)> {
    let mut covered: Vec<(f32, f32)> = strips.iter().filter_map(|strip| inside_interval(segment, strip)).collect();
    covered.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.total_cmp(&b.1)));
    let at = |t: f32| if t <= 0.0 { segment.0 } else if t >= 1.0 { segment.1 } else { segment.0.lerp(segment.1, t) };
    let mut pieces = Vec::new();
    let mut cursor = 0.0_f32;
    for (start, end) in covered {
        if start > cursor {
            pieces.push((at(cursor), at(start)));
        }
        cursor = cursor.max(end);
    }
    if cursor < 1.0 {
        pieces.push((at(cursor), at(1.0)));
    }
    pieces
}

#[cfg(test)]
mod tests {
    use super::{portal_strip, subtract_strips};
    use glam::Vec2;

    fn near(a: Vec2, b: Vec2) -> bool {
        a.distance(b) < 1e-6
    }

    #[test]
    fn an_uncovered_segment_stays_whole() {
        let segment = (Vec2::new(0.0, 0.0), Vec2::new(4.0, 0.0));
        assert_eq!(subtract_strips(segment, &[]), vec![segment]);
        let far = portal_strip((Vec2::new(0.0, 5.0), Vec2::new(4.0, 5.0)), 0.01);
        assert_eq!(subtract_strips(segment, &[far]), vec![segment]);
    }

    #[test]
    fn portals_on_the_segment_cut_it_into_the_uncovered_pieces() {
        let segment = (Vec2::new(0.0, 0.0), Vec2::new(4.0, 0.0));
        // Two overlapping portals (one written right to left) and one apart.
        let strips = [
            portal_strip((Vec2::new(1.0, 0.0), Vec2::new(2.0, 0.0)), 0.01),
            portal_strip((Vec2::new(2.5, 0.0), Vec2::new(1.5, 0.0)), 0.01),
            portal_strip((Vec2::new(3.0, 0.0), Vec2::new(3.5, 0.0)), 0.01),
        ];
        let pieces = subtract_strips(segment, &strips);
        let expected = [(0.0, 1.0), (2.5, 3.0), (3.5, 4.0)];
        assert_eq!(pieces.len(), expected.len(), "{pieces:?}");
        for (piece, (a, b)) in pieces.iter().zip(expected) {
            assert!(near(piece.0, Vec2::new(a, 0.0)) && near(piece.1, Vec2::new(b, 0.0)), "{pieces:?}");
        }
    }

    #[test]
    fn a_fully_covered_segment_vanishes() {
        let segment = (Vec2::new(1.0, 1.0), Vec2::new(1.0, 3.0));
        let strips = [portal_strip((Vec2::new(1.0, 3.5), Vec2::new(1.0, 0.5)), 0.01)];
        assert!(subtract_strips(segment, &strips).is_empty());
    }

    #[test]
    fn a_crossing_strip_cuts_its_width_out() {
        let segment = (Vec2::new(0.0, 0.0), Vec2::new(2.0, 0.0));
        let strips = [portal_strip((Vec2::new(1.0, -1.0), Vec2::new(1.0, 1.0)), 0.25)];
        let pieces = subtract_strips(segment, &strips);
        assert_eq!(pieces.len(), 2);
        assert!(near(pieces[0].1, Vec2::new(0.75, 0.0)) && near(pieces[1].0, Vec2::new(1.25, 0.0)), "{pieces:?}");
    }
}
