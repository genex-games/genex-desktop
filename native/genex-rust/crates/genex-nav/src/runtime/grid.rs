//! A uniform hash grid over 2D points with deterministic answers, in place of landmass's k-d tree
//! (P3). Buckets are kept in a `Map` (insertion order) and each bucket in insertion order, and a
//! nearest-point query breaks distance ties by insertion order, so the same points and queries
//! give the same answers on every run and destination.

use genex_core::map::Map;
use glam::Vec2;

/// One stored point: its insertion number, where it is and its value.
type Entry<T> = (u32, Vec2, T);

/// Points with values, bucketed by a square cell.
#[derive(Clone, Debug)]
pub struct PointGrid<T> {
    cell: f32,
    buckets: Map<(i32, i32), Vec<Entry<T>>>,
    count: u32,
}

impl<T> PointGrid<T> {
    /// An empty grid with square cells `cell` wide (clamped to a small positive size).
    pub fn new(cell: f32) -> Self {
        let cell = if cell.is_finite() && cell > 1e-6 { cell } else { 1e-6 };
        Self { cell, buckets: Map::default(), count: 0 }
    }

    fn cell_of(&self, point: Vec2) -> (i32, i32) {
        // `as` saturates for huge or non-finite values, which only makes far points share an edge cell.
        ((point.x / self.cell).floor() as i32, (point.y / self.cell).floor() as i32)
    }

    /// Adds `point` with `value`.
    pub fn insert(&mut self, point: Vec2, value: T) {
        let order = self.count;
        self.count = self.count.wrapping_add(1);
        let cell = self.cell_of(point);
        self.buckets.entry(cell).or_default().push((order, point, value));
    }

    /// The value of the point nearest to `point` whose squared distance is below
    /// `max_distance_squared`; ties go to the earlier inserted point.
    pub fn nearest_within(&self, point: Vec2, max_distance_squared: f32) -> Option<&T> {
        if max_distance_squared.is_nan() || max_distance_squared <= 0.0 {
            return None;
        }
        let reach = max_distance_squared.sqrt();
        let (low, high) = (self.cell_of(point - Vec2::splat(reach)), self.cell_of(point + Vec2::splat(reach)));
        let mut best: Option<(f32, u32, &T)> = None;
        for x in low.0..=high.0 {
            for y in low.1..=high.1 {
                let Some(bucket) = self.buckets.get(&(x, y)) else {
                    continue;
                };
                for (order, candidate, value) in bucket {
                    let distance = candidate.distance_squared(point);
                    if distance >= max_distance_squared {
                        continue;
                    }
                    let better = match best {
                        None => true,
                        Some((d, o, _)) => distance < d || (distance == d && *order < o),
                    };
                    if better {
                        best = Some((distance, *order, value));
                    }
                }
            }
        }
        best.map(|(_, _, value)| value)
    }
}

#[cfg(test)]
mod tests {
    use super::PointGrid;
    use glam::Vec2;

    #[test]
    fn finds_the_nearest_point_within_reach_and_breaks_ties_by_insertion() {
        let mut grid = PointGrid::new(0.1);
        grid.insert(Vec2::new(-1.0, 0.0), 'a');
        grid.insert(Vec2::new(2.0, 0.0), 'b');
        grid.insert(Vec2::new(0.5, 0.5), 'c');
        grid.insert(Vec2::new(0.5, -0.5), 'd');
        assert_eq!(grid.nearest_within(Vec2::new(-0.95, 0.0), 0.01), Some(&'a'));
        assert_eq!(grid.nearest_within(Vec2::new(0.5, 0.0), 0.3), Some(&'c'), "c and d tie: c came first");
        assert_eq!(grid.nearest_within(Vec2::new(0.5, 0.0), 0.2), None, "nothing within reach");
        assert_eq!(grid.nearest_within(Vec2::new(-1.0, 0.0), 0.0), None, "zero reach finds nothing");
    }
}
