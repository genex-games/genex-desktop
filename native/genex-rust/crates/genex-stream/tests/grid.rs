//! The cell grid and its wanted sets (STR-8). An anchor walking along a cell border does not flap
//! with hysteresis 1; entered cells come ascending and left cells descending; an anchor past the
//! world extent refuses `stream-out-of-world`; and over long seeded random walks the sim set and
//! its diff equal a brute-force evaluation of the rule. Pure: no GPU, no IO, no wall clock.

use std::collections::BTreeSet;

use genex_core::rng::Pcg32;
use genex_stream::grid::{
    CellDiff, Grid, STREAM_ANCHORS_MAX, STREAM_CELL_SIZE_MAX, STREAM_CELL_SIZE_MIN, STREAM_RING_MAX,
    STREAM_SIM_RADIUS_MAX, STREAM_VIEW_CELLS_MAX, STREAM_WORLD_EXTENT_MAX, SimCells, SimRadii, diff, prefetch_ring,
    view_cells, wanted_sim,
};
use genex_stream::{CellId, StreamErrorCode};
use glam::Vec2;

fn grid(cell_size: f32) -> Grid {
    Grid::new(cell_size).expect("a valid cell size")
}

fn radii(radius: u32, hysteresis: u32, prefetch: u32) -> SimRadii {
    SimRadii { radius, hysteresis, prefetch }
}

/// The anchor cells of world points on `grid`.
fn cells_of(grid: &Grid, points: &[Vec2]) -> Vec<CellId> {
    points.iter().map(|p| grid.cell_of(*p).expect("inside the world")).collect()
}

/// How many cells entered or left over a walk, after its first step.
fn churn_after_first(grid: &Grid, radii: SimRadii, walk: &[Vec2]) -> usize {
    let mut sim = SimCells::new(*grid, radii).expect("valid radii");
    let mut churn = 0;
    for (step, point) in walk.iter().enumerate() {
        let moved = sim.update(&cells_of(grid, &[*point])).expect("a valid anchor");
        if step > 0 {
            churn += moved.entered.len() + moved.left.len();
        }
    }
    churn
}

#[test]
fn an_anchor_walking_a_cell_border_does_not_flap_with_hysteresis_1() {
    let grid = grid(64.0);
    // Back and forth across the border x = 64, a few centimetres either side, 200 times.
    let walk: Vec<Vec2> = (0..200).map(|i| Vec2::new(if i % 2 == 0 { 63.95 } else { 64.05 }, 10.0)).collect();
    // The first crossing adds the column ahead; after that nothing enters or leaves.
    let mut sim = SimCells::new(grid, radii(1, 1, 1)).expect("valid radii");
    sim.update(&cells_of(&grid, &walk[..1])).expect("first step");
    let crossing = sim.update(&cells_of(&grid, &walk[1..2])).expect("first crossing");
    assert_eq!(crossing.entered, vec![CellId::new(2, -1), CellId::new(2, 0), CellId::new(2, 1)]);
    assert!(crossing.left.is_empty(), "nothing leaves inside the hysteresis ring: {:?}", crossing.left);
    assert_eq!(churn_after_first(&grid, radii(1, 1, 1), &walk), 3, "only the first crossing changes the set");
    // Without hysteresis the same walk flaps every step, a column of three in and one out (the row
    // can fail).
    assert_eq!(churn_after_first(&grid, radii(1, 0, 1), &walk), 199 * 6);
}

#[test]
fn entered_cells_are_ascending_and_left_cells_descending() {
    let grid = grid(32.0);
    let mut sim = SimCells::new(grid, radii(2, 1, 1)).expect("valid radii");
    let first = sim.update(&[CellId::new(0, 0), CellId::new(10, -3)]).expect("first anchors");
    assert_eq!(first.entered.len(), 2 * 25, "two 5x5 squares");
    assert!(first.left.is_empty());
    let moved = sim.update(&[CellId::new(4, 4), CellId::new(10, -3)]).expect("moved");
    assert!(!moved.entered.is_empty() && !moved.left.is_empty());
    assert!(moved.entered.windows(2).all(|w| w[0] < w[1]), "entered ascending: {:?}", moved.entered);
    assert!(moved.left.windows(2).all(|w| w[0] > w[1]), "left descending: {:?}", moved.left);
    // CellId orders by x, then z: the canonical order.
    assert!(CellId::new(-1, 5) < CellId::new(0, -5));
    assert!(CellId::new(0, -5) < CellId::new(0, 4));
    // The diff of two sets is the same canonical shape.
    let a: BTreeSet<CellId> = [CellId::new(0, 0), CellId::new(1, 0), CellId::new(0, 1)].into();
    let b: BTreeSet<CellId> = [CellId::new(1, 0), CellId::new(2, 2), CellId::new(-3, 7)].into();
    assert_eq!(
        diff(&a, &b),
        CellDiff { entered: vec![CellId::new(-3, 7), CellId::new(2, 2)], left: vec![CellId::new(0, 1), CellId::new(0, 0)] }
    );
}

#[test]
fn an_anchor_at_9000_m_refuses_stream_out_of_world() {
    let grid = grid(64.0);
    for point in [Vec2::new(9000.0, 0.0), Vec2::new(0.0, 9000.0), Vec2::new(-9000.0, 0.0), Vec2::new(8192.0, 0.0), Vec2::new(0.0, -8192.5)] {
        let refusal = grid.cell_of(point).expect_err("outside the world");
        assert_eq!(refusal.code, StreamErrorCode::OutOfWorld, "{point}");
        assert_eq!(refusal.code.wire(), "stream-out-of-world");
    }
    // The world is [-extent, extent) on both axes.
    assert_eq!(grid.cell_of(Vec2::new(-STREAM_WORLD_EXTENT_MAX, 0.0)).unwrap(), CellId::new(-128, 0));
    assert_eq!(grid.cell_of(Vec2::new(8191.99, -0.01)).unwrap(), CellId::new(127, -1));
    assert_eq!(grid.world_cells(), (CellId::new(-128, -128), CellId::new(127, 127)));
    // A non-finite anchor is not a place.
    assert_eq!(grid.cell_of(Vec2::new(f32::NAN, 0.0)).unwrap_err().code, StreamErrorCode::Invalid);
    assert_eq!(grid.cell_of(Vec2::new(0.0, f32::INFINITY)).unwrap_err().code, StreamErrorCode::Invalid);
    // An anchor cell outside the world is refused and the sim set stays as it was.
    let mut sim = SimCells::new(grid, radii(1, 1, 1)).expect("valid radii");
    sim.update(&[CellId::new(0, 0)]).expect("inside");
    let before = sim.active().clone();
    let refusal = sim.update(&[CellId::new(0, 0), CellId::new(128, 0)]).expect_err("outside");
    assert_eq!(refusal.code, StreamErrorCode::OutOfWorld);
    assert_eq!(sim.active(), &before, "a refused update changes nothing");
}

#[test]
fn the_ring_is_clipped_at_the_world_edge() {
    let grid = grid(64.0);
    let edge = grid.cell_of(Vec2::new(8190.0, -8190.0)).unwrap();
    assert_eq!(edge, CellId::new(127, -128));
    let set = wanted_sim(&grid, &[edge], radii(2, 1, 1), &BTreeSet::new()).expect("inside");
    assert_eq!(set.len(), 9, "a 5x5 square cut to its 3x3 corner inside the world");
    let (lo, hi) = grid.world_cells();
    assert!(set.iter().all(|c| (lo.x..=hi.x).contains(&c.x) && (lo.z..=hi.z).contains(&c.z)));
}

#[test]
fn invalid_sizes_radii_and_anchor_counts_are_refused() {
    for size in [STREAM_CELL_SIZE_MIN - 0.5, STREAM_CELL_SIZE_MAX * 2.0, 0.0, -64.0, f32::NAN, f32::INFINITY] {
        assert_eq!(Grid::new(size).unwrap_err().code, StreamErrorCode::Invalid, "cell size {size}");
    }
    assert!(Grid::new(STREAM_CELL_SIZE_MIN).is_ok() && Grid::new(STREAM_CELL_SIZE_MAX).is_ok());
    let grid = grid(64.0);
    for bad in [radii(STREAM_SIM_RADIUS_MAX + 1, 1, 1), radii(1, STREAM_RING_MAX + 1, 1), radii(1, 1, STREAM_RING_MAX + 1)] {
        assert_eq!(SimCells::new(grid, bad).unwrap_err().code, StreamErrorCode::Invalid, "{bad:?}");
        assert_eq!(wanted_sim(&grid, &[], bad, &BTreeSet::new()).unwrap_err().code, StreamErrorCode::Invalid);
    }
    let anchors = vec![CellId::new(0, 0); STREAM_ANCHORS_MAX + 1];
    let refusal = wanted_sim(&grid, &anchors, radii(1, 1, 1), &BTreeSet::new()).unwrap_err();
    assert_eq!(refusal.code, StreamErrorCode::TooManyAnchors);
    assert_eq!(refusal.code.wire(), "stream-too-many-anchors");
    assert!(wanted_sim(&grid, &anchors[..STREAM_ANCHORS_MAX], radii(1, 1, 1), &BTreeSet::new()).is_ok());
    // No anchors: nothing is wanted, and everything active leaves.
    let mut sim = SimCells::new(grid, radii(1, 1, 1)).unwrap();
    sim.update(&[CellId::new(3, 3)]).unwrap();
    let gone = sim.update(&[]).unwrap();
    assert_eq!(gone.left.len(), 9);
    assert!(sim.active().is_empty());
    // View radii.
    let far = 64.0 * (STREAM_VIEW_CELLS_MAX as f32 + 1.0);
    for (radius, detail) in [(-1.0, 0.0), (f32::NAN, 0.0), (100.0, 200.0), (100.0, f32::NAN), (far, 0.0)] {
        assert_eq!(view_cells(&grid, Vec2::ZERO, radius, detail).unwrap_err().code, StreamErrorCode::Invalid, "{radius} {detail}");
    }
    assert_eq!(view_cells(&grid, Vec2::new(f32::NAN, 0.0), 100.0, 10.0).unwrap_err().code, StreamErrorCode::Invalid);
    let wires: Vec<&str> = StreamErrorCode::ALL.iter().map(|c| c.wire()).collect();
    assert_eq!(wires, ["stream-invalid", "stream-too-many-anchors", "stream-out-of-world", "stream-not-registered", "stream-hold-timeout", "stream-snapshot-invalid", "stream-drain-timeout", "stream-unknown-group"]);
}

/// Chebyshev distance in cells from `cell` to the nearest anchor.
fn nearest(anchors: &[CellId], cell: CellId) -> i64 {
    anchors
        .iter()
        .map(|a| (i64::from(a.x) - i64::from(cell.x)).abs().max((i64::from(a.z) - i64::from(cell.z)).abs()))
        .min()
        .unwrap_or(i64::MAX)
}

/// The rule, evaluated cell by cell over the whole box around the anchors: a cell is active when
/// it is within `radius` of an anchor, or was active and is within `radius + hysteresis`.
fn brute_sim(grid: &Grid, anchors: &[CellId], radii: SimRadii, previous: &BTreeSet<CellId>) -> BTreeSet<CellId> {
    let (lo, hi) = grid.world_cells();
    let reach = i64::from(radii.radius + radii.hysteresis);
    let mut out = BTreeSet::new();
    for anchor in anchors {
        for x in i64::from(anchor.x) - reach..=i64::from(anchor.x) + reach {
            for z in i64::from(anchor.z) - reach..=i64::from(anchor.z) + reach {
                if x < i64::from(lo.x) || x > i64::from(hi.x) || z < i64::from(lo.z) || z > i64::from(hi.z) {
                    continue;
                }
                let cell = CellId::new(x as i32, z as i32);
                let d = nearest(anchors, cell);
                if d <= i64::from(radii.radius) || (previous.contains(&cell) && d <= reach) {
                    out.insert(cell);
                }
            }
        }
    }
    out
}

/// One seeded random walk of `steps` steps: anchors drift a cell or two, sometimes jump, sometimes
/// appear or vanish; every step's set and diff are held to the brute-force rule.
fn walk(seed: u64, cell_size: f32, radii: SimRadii, steps: u32) -> (u64, usize) {
    let grid = grid(cell_size);
    let (lo, hi) = grid.world_cells();
    let mut rng = Pcg32::seeded(seed);
    let mut anchors: Vec<CellId> = vec![CellId::new(0, 0)];
    let mut sim = SimCells::new(grid, radii).unwrap();
    let mut previous = BTreeSet::new();
    let mut churn = 0usize;
    let mut digest = 0u64;
    for _ in 0..steps {
        for anchor in &mut anchors {
            let roll = rng.below(100);
            let (dx, dz) = if roll < 3 { (rng.range_i32(-40, 40), rng.range_i32(-40, 40)) } else { (rng.range_i32(-1, 1), rng.range_i32(-1, 1)) };
            *anchor = CellId::new((anchor.x + dx).clamp(lo.x, hi.x), (anchor.z + dz).clamp(lo.z, hi.z));
        }
        let roll = rng.below(100);
        if roll < 2 && anchors.len() < 3 {
            anchors.push(CellId::new(rng.range_i32(lo.x, hi.x), rng.range_i32(lo.z, hi.z)));
        } else if roll < 4 && anchors.len() > 1 {
            anchors.remove(rng.below(anchors.len() as u32) as usize);
        }
        let expected = brute_sim(&grid, &anchors, radii, &previous);
        assert_eq!(wanted_sim(&grid, &anchors, radii, &previous).unwrap(), expected);
        let moved = sim.update(&anchors).unwrap();
        let entered: Vec<CellId> = expected.difference(&previous).copied().collect();
        let mut left: Vec<CellId> = previous.difference(&expected).copied().collect();
        left.reverse();
        assert_eq!(moved, CellDiff { entered, left });
        assert_eq!(sim.active(), &expected);
        // The prefetch ring: within radius + prefetch, in the world, not active, ascending.
        let ring_radii = SimRadii { radius: radii.radius + radii.prefetch, hysteresis: 0, prefetch: 0 };
        let ring: Vec<CellId> = brute_sim(&grid, &anchors, ring_radii, &BTreeSet::new()).difference(&expected).copied().collect();
        assert_eq!(prefetch_ring(&grid, &anchors, radii, &expected).unwrap(), ring);
        churn += moved.entered.len() + moved.left.len();
        for cell in &expected {
            digest = digest.rotate_left(5) ^ ((cell.x as u32 as u64) << 32 | cell.z as u32 as u64);
        }
        previous = expected;
    }
    (digest, churn)
}

#[test]
fn ten_thousand_random_walk_steps_equal_the_brute_force_rule() {
    // 10,000 steps at the default radii, then shorter walks at the corners of the caps.
    let (digest, churn) = walk(7, 64.0, radii(1, 1, 1), 10_000);
    assert!(churn > 1_000, "the walk moved: {churn}");
    assert_eq!(walk(7, 64.0, radii(1, 1, 1), 10_000).0, digest, "the same walk twice");
    walk(11, STREAM_CELL_SIZE_MIN, radii(2, 0, 2), 1_000);
    walk(12, STREAM_CELL_SIZE_MAX, radii(STREAM_SIM_RADIUS_MAX, STREAM_RING_MAX, STREAM_RING_MAX), 500);
    walk(13, 100.0, radii(0, 2, 0), 1_000);
}

#[test]
fn view_cells_split_at_the_detail_radius() {
    let grid = grid(64.0);
    let mut rng = Pcg32::seeded(5);
    for _ in 0..200 {
        let camera = Vec2::new(rng.range_f32(-8300.0, 8300.0), rng.range_f32(-8300.0, 8300.0));
        let radius = rng.range_f32(0.0, 600.0);
        let detail = rng.range_f32(0.0, radius);
        let view = view_cells(&grid, camera, radius, detail).expect("a valid view");
        // Brute force: every world cell whose nearest point is within the radius.
        let (lo, hi) = grid.world_cells();
        let reach = (radius / 64.0) as i32 + 2;
        let centre = CellId::new((camera.x / 64.0).floor() as i32, (camera.y / 64.0).floor() as i32);
        let (mut near, mut far) = (Vec::new(), Vec::new());
        for x in (centre.x - reach).max(lo.x)..=(centre.x + reach).min(hi.x) {
            for z in (centre.z - reach).max(lo.z)..=(centre.z + reach).min(hi.z) {
                let cell = CellId::new(x, z);
                let (min, max) = grid.bounds(cell);
                let gap = Vec2::new((min.x - camera.x).max(camera.x - max.x).max(0.0), (min.y - camera.y).max(camera.y - max.y).max(0.0));
                let d2 = gap.length_squared();
                if d2 <= detail * detail {
                    near.push(cell);
                } else if d2 <= radius * radius {
                    far.push(cell);
                }
            }
        }
        assert_eq!(view.detail, near, "camera {camera} radius {radius} detail {detail}");
        assert_eq!(view.far, far, "camera {camera} radius {radius} detail {detail}");
    }
    // A camera at the origin with a 100 m radius and a 40 m detail radius.
    let view = view_cells(&grid, Vec2::new(1.0, 1.0), 100.0, 40.0).unwrap();
    assert_eq!(view.detail.len(), 4);
    assert!(view.far.len() > 4 && view.far.iter().all(|c| !view.detail.contains(c)));
    assert_eq!(grid.bounds(CellId::new(-1, 2)), (Vec2::new(-64.0, 128.0), Vec2::new(0.0, 192.0)));
}
