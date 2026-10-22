//! Which line segments are visible from the origin, nearest first, from dodgy_2d's
//! `visibility_set.rs` (MIT OR Apache-2.0). Changed: [`VisibilitySet::get_visible_line_ids`]
//! returns sorted ids rather than a `HashSet`, and the angles come from glam (libm), not the
//! platform's `atan2` and `sin`, and each added cone rebuilds the cone list in a spare buffer the
//! set keeps (GE, NAV-18's update budget). GE fix r2 (NAV-18): an overlap whose cone is never kept
//! is compared by its rays or distances alone, so its related angle (an `atan2`) and its points are
//! computed only where a cone of it is pushed; every kept cone has the same bits as before.

use std::{f32::consts::PI, mem::swap};

use glam::Vec2;

use crate::runtime::dodgy::common::time_to_intersect_lines;

/// Line segments seen from the origin, as angular cones; a segment behind nearer ones is hidden.
pub struct VisibilitySet {
    cones: Vec<Cone>,
    /// The previous cone list's buffer, kept for the next rebuild (always empty between calls).
    spare: Vec<Cone>,
    next_id: u32,
}

impl VisibilitySet {
    /// An empty set: everything is visible.
    pub fn new() -> VisibilitySet {
        VisibilitySet { cones: Vec::new(), spare: Vec::new(), next_id: 0 }
    }

    /// Empty again (everything visible, ids from 0), keeping the buffers' memory.
    pub fn clear(&mut self) {
        self.cones.clear();
        self.spare.clear();
        self.next_id = 0;
    }

    /// Whether any part of the segment would be visible past the lines already added.
    pub fn is_line_visible(&self, start_point: Vec2, end_point: Vec2) -> bool {
        if self.cones.is_empty() {
            return true;
        }

        /// Whether the angles `left..right` overlap a gap between the cones (compared by angle
        /// alone).
        fn visible_through_a_gap(set: &VisibilitySet, left: f32, right: f32) -> bool {
            for i in -1..set.cones.len() as isize {
                let gap_left = if i == -1 { 0.0 } else { set.cones[i as usize].right_ray.angle };
                let gap_right = if i == set.cones.len() as isize - 1 { 2.0 * PI } else { set.cones[(i + 1) as usize].left_ray.angle };
                if gap_left == gap_right {
                    continue;
                }
                // `Cone::overlaps_cone` of the gap and the line's cone.
                if left < gap_right && gap_left < right {
                    return true;
                }
            }
            false
        }

        fn is_cone_visible(set: &VisibilitySet, check_cone: Cone) -> bool {
            visible_through_a_gap(set, check_cone.left_ray.angle, check_cone.right_ray.angle) || visible_past_the_cones(set, check_cone)
        }

        /// Whether part of `check_cone` lies nearer than the cones it overlaps.
        fn visible_past_the_cones(set: &VisibilitySet, check_cone: Cone) -> bool {
            for blocking_cone in set.cones.iter() {
                // Only the overlaps' end distances are compared: no rays, no related angles.
                let Some((check_left, check_right)) =
                    check_cone.overlapping_distances(*blocking_cone)
                else {
                    continue;
                };

                let (blocking_left, blocking_right) = blocking_cone
                    .overlapping_distances(check_cone)
                    .expect("Cones definitely overlap.");

                if check_left < blocking_left || check_right < blocking_right {
                    return true;
                }
            }

            false
        }

        // A line seen through a gap needs no related angle (an `atan2`): the gaps are compared by
        // angle alone, and the cone is made, as `create_from_line` makes it, only past them.
        let (mut left_ray, mut right_ray) = (ConeRay::from_point(start_point), ConeRay::from_point(end_point));
        if left_ray.angle > right_ray.angle {
            swap(&mut left_ray, &mut right_ray);
        }
        if right_ray.angle - left_ray.angle < PI {
            if visible_through_a_gap(self, left_ray.angle, right_ray.angle) {
                return true;
            }
            let related_angle = Cone::derive_related_angle(start_point, end_point);
            return visible_past_the_cones(self, Cone { left_ray, right_ray, line_id: 0, related_angle });
        }
        match Cone::create_from_line(start_point, end_point, 0) {
            LineToCone::One(cone) => is_cone_visible(self, cone),
            LineToCone::Two(cone_1, cone_2) => {
                is_cone_visible(self, cone_1) || is_cone_visible(self, cone_2)
            }
        }
    }

    /// Adds a segment; its id when any part of it is visible, `None` when it is hidden.
    pub fn add_line(
        &mut self,
        start_point: Vec2,
        end_point: Vec2,
    ) -> Option<u32> {
        fn add_cone(set: &mut VisibilitySet, new_cone: Cone) -> bool {
            let mut visible = false;

            let mut old_cones = std::mem::take(&mut set.spare);
            swap(&mut set.cones, &mut old_cones);

            for i in -1..old_cones.len() as isize {
                let free_cone = Cone {
                    left_ray: ConeRay {
                        angle: if i == -1 {
                            0.0
                        } else {
                            old_cones[i as usize].right_ray.angle
                        },
                        distance: 0.0,
                        point: Vec2::ZERO,
                    },
                    right_ray: ConeRay {
                        angle: if i == old_cones.len() as isize - 1 {
                            2.0 * PI
                        } else {
                            old_cones[(i + 1) as usize].left_ray.angle
                        },
                        distance: 0.0,
                        point: Vec2::ZERO,
                    },
                    line_id: 0,
                    related_angle: 0.0,
                };

                if free_cone.left_ray.angle == free_cone.right_ray.angle {
                    continue;
                }

                if let Some(overlap_cone) = new_cone.overlapping_cone(free_cone) {
                    set.cones.push(overlap_cone);
                    visible = true;
                }
            }

            for &blocking_cone in &old_cones {
                // The overlaps' rays; a cone of them (its related angle) is made only where one is
                // kept.
                let Some(new_overlap) = new_cone.overlapping_rays(blocking_cone) else {
                    set.cones.push(blocking_cone);
                    continue;
                };

                let blocking_overlap_cone = blocking_cone
                    .overlapping_rays(new_cone)
                    .expect("Cones definitely overlap.");

                let left_in_front = new_overlap.0.distance
                    < blocking_overlap_cone.0.distance;
                let right_in_front = new_overlap.1.distance
                    < blocking_overlap_cone.1.distance;
                if !left_in_front && !right_in_front {
                    set.cones.push(blocking_cone);
                    continue;
                }
                let new_overlap_cone = OverlapRays {
                    left_ray: new_overlap.0,
                    right_ray: new_overlap.1,
                    line_id: new_cone.line_id,
                };
                let blocking_overlap_cone = OverlapRays {
                    left_ray: blocking_overlap_cone.0,
                    right_ray: blocking_overlap_cone.1,
                    line_id: blocking_cone.line_id,
                };

                if blocking_cone.left_ray.angle < blocking_overlap_cone.left_ray.angle {
                    set.cones.push(Cone {
                        left_ray: blocking_cone.left_ray,
                        right_ray: blocking_overlap_cone.left_ray,
                        line_id: blocking_cone.line_id,
                        related_angle: blocking_cone.related_angle,
                    });
                }
                if blocking_overlap_cone.right_ray.angle < blocking_cone.right_ray.angle
                {
                    set.cones.push(Cone::create_from_rays(
                        blocking_overlap_cone.right_ray,
                        blocking_cone.right_ray,
                        blocking_cone.line_id,
                    ));
                }

                let intersect_times = match time_to_intersect_lines(
                    new_overlap_cone.left_ray.point,
                    new_overlap_cone.right_ray.point,
                    blocking_overlap_cone.left_ray.point,
                    blocking_overlap_cone.right_ray.point,
                ) {
                    None => {
                        set.cones.push(new_overlap_cone.cone());
                        visible = true;
                        continue;
                    }
                    Some(intersect_times) => intersect_times,
                };

                if intersect_times.x <= 0.0
                    || 1.0 <= intersect_times.x
                    || intersect_times.y <= 0.0
                    || 1.0 <= intersect_times.y
                {
                    set.cones.push(new_overlap_cone.cone());
                    visible = true;
                    continue;
                }

                let split_point = new_overlap_cone.left_ray.point
                    + (new_overlap_cone.right_ray.point
                        - new_overlap_cone.left_ray.point)
                        * intersect_times.x;
                let split_ray = ConeRay::from_point(split_point);

                visible = true;

                if left_in_front {
                    set.cones.push(Cone::create_from_rays(
                        new_overlap_cone.left_ray,
                        split_ray,
                        new_overlap_cone.line_id,
                    ));
                    set.cones.push(Cone::create_from_rays(
                        split_ray,
                        blocking_overlap_cone.right_ray,
                        blocking_overlap_cone.line_id,
                    ));
                } else {
                    set.cones.push(Cone::create_from_rays(
                        blocking_overlap_cone.left_ray,
                        split_ray,
                        blocking_overlap_cone.line_id,
                    ));
                    set.cones.push(Cone::create_from_rays(
                        split_ray,
                        new_overlap_cone.right_ray,
                        new_overlap_cone.line_id,
                    ));
                }
            }

            set.cones.sort_by(|a, b| a.left_ray.angle.total_cmp(&b.left_ray.angle));
            old_cones.clear();
            set.spare = old_cones;

            visible
        }

        if start_point == end_point {
            return None;
        }

        let visible =
            match Cone::create_from_line(start_point, end_point, self.next_id) {
                LineToCone::One(cone) => add_cone(self, cone),
                LineToCone::Two(cone_1, cone_2) => {
                    // Use | to perform an OR without short circuiting.
                    add_cone(self, cone_1) | add_cone(self, cone_2)
                }
            };

        if !visible {
            None
        } else {
            let id = self.next_id;
            self.next_id += 1;
            Some(id)
        }
    }

    /// The ids of the lines still visible, ascending.
    pub fn get_visible_line_ids(&self) -> Vec<u32> {
        let mut ids: Vec<u32> = self.cones.iter().map(|cone| cone.line_id).collect();
        ids.sort_unstable();
        ids.dedup();
        ids
    }
}

impl Default for VisibilitySet {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Copy)]
struct Cone {
    left_ray: ConeRay,
    right_ray: ConeRay,
    line_id: u32,
    related_angle: f32,
}

enum LineToCone {
    One(Cone),
    Two(Cone, Cone),
}

impl Cone {
    fn create_from_line(
        start_point: Vec2,
        end_point: Vec2,
        line_id: u32,
    ) -> LineToCone {
        let mut partial_cone = Cone::create_from_rays(
            ConeRay::from_point(start_point),
            ConeRay::from_point(end_point),
            line_id,
        );

        if partial_cone.left_ray.angle > partial_cone.right_ray.angle {
            swap(&mut partial_cone.left_ray, &mut partial_cone.right_ray);
        }

        if partial_cone.right_ray.angle - partial_cone.left_ray.angle < PI {
            return LineToCone::One(partial_cone);
        }

        let zero_distance = partial_cone.distance_at_angle(0.0);
        let split_ray = ConeRay {
            angle: 0.0,
            distance: zero_distance,
            point: zero_distance * Vec2::X,
        };

        let split_max_ray = ConeRay {
            angle: 2.0 * PI,
            distance: split_ray.distance,
            point: split_ray.point,
        };

        LineToCone::Two(
            Cone::create_from_rays(split_ray, partial_cone.left_ray, line_id),
            Cone::create_from_rays(partial_cone.right_ray, split_max_ray, line_id),
        )
    }

    fn create_from_rays(
        left_ray: ConeRay,
        right_ray: ConeRay,
        line_id: u32,
    ) -> Cone {
        Cone {
            related_angle: Cone::derive_related_angle(
                left_ray.point,
                right_ray.point,
            ),
            left_ray,
            right_ray,
            line_id,
        }
    }

    fn derive_related_angle(left_point: Vec2, right_point: Vec2) -> f32 {
        Vec2::angle_to(left_point - right_point, left_point)
    }

    fn distance_at_angle(&self, angle: f32) -> f32 {
        let relative_angle = {
            let mut relative_angle = angle - self.left_ray.angle;
            if relative_angle < 0.0 {
                relative_angle += 2.0 * PI;
            }
            relative_angle
        };

        self.left_ray.distance * sin(self.related_angle) / sin(relative_angle + self.related_angle)
    }

    fn ray_at_angle(&self, angle: f32) -> ConeRay {
        let distance = self.distance_at_angle(angle);
        ConeRay { angle, distance, point: distance * Vec2::from_angle(angle) }
    }

    fn overlaps_cone(&self, other: Cone) -> bool {
        other.left_ray.angle < self.right_ray.angle
            && self.left_ray.angle < other.right_ray.angle
    }

    /// The part of `self` inside `other`'s angles as a cone (`None` when they do not overlap).
    fn overlapping_cone(&self, other: Cone) -> Option<Cone> {
        let (left_ray, right_ray) = self.overlapping_rays(other)?;
        Some(Cone::create_from_rays(left_ray, right_ray, self.line_id))
    }

    /// [`Cone::overlapping_cone`]'s rays alone, without the cone's related angle.
    fn overlapping_rays(&self, other: Cone) -> Option<(ConeRay, ConeRay)> {
        if !self.overlaps_cone(other) {
            return None;
        }

        let left_ray = if self.left_ray.angle < other.left_ray.angle {
            // `self` contains `other.left_ray`.
            self.ray_at_angle(other.left_ray.angle)
        } else {
            // `self` does not contain `other.left_ray`.
            self.left_ray
        };

        let right_ray = if other.right_ray.angle < self.right_ray.angle {
            // `self` contains `other.right_ray`.
            self.ray_at_angle(other.right_ray.angle)
        } else {
            // `self` does not contain `other.right_ray`.
            self.right_ray
        };

        Some((left_ray, right_ray))
    }

    /// [`Cone::overlapping_rays`]'s distances alone, the same bits.
    fn overlapping_distances(&self, other: Cone) -> Option<(f32, f32)> {
        if !self.overlaps_cone(other) {
            return None;
        }
        let left = if self.left_ray.angle < other.left_ray.angle { self.distance_at_angle(other.left_ray.angle) } else { self.left_ray.distance };
        let right = if other.right_ray.angle < self.right_ray.angle { self.distance_at_angle(other.right_ray.angle) } else { self.right_ray.distance };
        Some((left, right))
    }
}

/// An overlap's rays and the line they belong to (a cone without its related angle).
#[derive(Clone, Copy)]
struct OverlapRays {
    left_ray: ConeRay,
    right_ray: ConeRay,
    line_id: u32,
}

impl OverlapRays {
    /// The cone of these rays, as `Cone::overlapping_cone` makes it.
    fn cone(self) -> Cone {
        Cone::create_from_rays(self.left_ray, self.right_ray, self.line_id)
    }
}

#[derive(Clone, Copy)]
struct ConeRay {
    angle: f32,
    distance: f32,
    point: Vec2,
}

impl ConeRay {
    fn from_point(point: Vec2) -> ConeRay {
        let angle = point.to_angle();
        ConeRay {
            angle: if angle >= 0.0 { angle } else { 2.0 * PI + angle },
            distance: point.length(),
            point,
        }
    }
}

/// `sin(angle)` through glam's libm math, the same bits on every destination.
fn sin(angle: f32) -> f32 {
    Vec2::from_angle(angle).y
}

#[cfg(test)]
#[path = "visibility_set_test.rs"]
mod test;
