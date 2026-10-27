//! Hulls (§6.2, §1.5): the core computes the hull of 4..`limits.hullVertices` points. Near-degenerate
//! clouds (nearly coplanar, duplicated, nearly collinear, far from their origin) are each either
//! a hull or a typed refusal, through spawn and through every query that takes a shape, and never
//! fail the world.

mod common;

use common::body;
use genex_physics::{BodyType, PhysicsError, Pose, QueryFilter, Shape, UpAxis, Vec3, World, WorldDesc};

/// A world whose query quota lets every cloud's two queries run between steps.
fn world(up: UpAxis) -> World {
    let gravity = if up == UpAxis::Z { [0.0, 0.0, -9.81] } else { [0.0, -9.81, 0.0] };
    let mut desc = WorldDesc::new(1.0 / 60.0, 1.0, gravity, up, 1.0);
    desc.limits.queries_per_step = Some(256.0);
    World::create(&desc).expect("world")
}

/// A small deterministic generator (a 64-bit LCG), so every run tries the same clouds.
struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (self.0 >> 11) as f64 / (1u64 << 53) as f64
    }

    /// A value in -1..1.
    fn signed(&mut self) -> f64 {
        2.0 * self.next() - 1.0
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() * n as f64) as usize % n
    }
}

/// The kinds of near-degenerate cloud the sweep draws.
const KINDS: usize = 6;

fn cloud(rng: &mut Lcg, kind: usize) -> Vec<Vec3> {
    let n = 4 + rng.below(61);
    let scale = [1e-3, 1.0, 50.0, 9.0e4][rng.below(4)];
    let off = [0.0, 1.0, 1e3, 9.0e4 - scale][rng.below(4)];
    let eps = [0.0, 1e-9, 1e-7, 1e-6, 1e-5][rng.below(5)];
    let mut points = Vec::with_capacity(n);
    for i in 0..n {
        let (a, b, c) = (rng.signed(), rng.signed(), rng.signed());
        let p = match kind {
            // In the plane z = 0, lifted by at most eps.
            0 => [a, b, eps * c],
            // On a line, pushed off it by at most eps.
            1 => [a, a + eps * b, a + eps * c],
            // A few points repeated, each copy moved by at most eps.
            2 => {
                let base = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]][i % 4];
                [base[0] + eps * a, base[1] + eps * b, base[2] + eps * c]
            }
            // A box's corners with points on its faces, each off its face by at most eps.
            3 => {
                let face = [a.signum(), b, c];
                [face[0] + eps * rng.signed(), face[1], face[2]]
            }
            // A flat triangle fan: two planes meeting at a tiny angle.
            4 => [a, b, eps * a.abs()],
            // A sphere's surface, every point nearly on it.
            _ => {
                let length = (a * a + b * b + c * c).sqrt().max(1e-3);
                [a / length, b / length, c / length + eps * rng.signed()]
            }
        };
        points.push(p.map(|v| off + scale * v));
    }
    points
}

fn hostile_clouds() -> Vec<(&'static str, Vec<Vec3>)> {
    let corner = |s: f64| [[0.0, 0.0, 0.0], [s, 0.0, 0.0], [0.0, s, 0.0], [s, s, 0.0]];
    let mut lifted = corner(1.0).to_vec();
    lifted.push([0.5, 0.5, 1e-7]);
    vec![
        ("four duplicates", vec![[1.0, 2.0, 3.0]; 4]),
        ("a square lifted by 1e-7", lifted),
        ("a line", (0..8).map(|i| [i as f64, 2.0 * i as f64, 0.5 * i as f64]).collect()),
        ("a tetrahedron 1e-30 thick", vec![[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.3, 0.3, 1e-30]]),
        ("a tetrahedron far from its origin", vec![[9e4, 9e4, 9e4], [9e4 + 1e-2, 9e4, 9e4], [9e4, 9e4 + 1e-2, 9e4], [9e4, 9e4, 9e4 + 1e-2]]),
        ("64 copies of a tetrahedron", (0..64).map(|i| [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]][i % 4]).collect()),
    ]
}

/// Spawns a dynamic hull of `points`, then sweeps and overlaps with it; every outcome is a value.
fn try_cloud(w: &mut World, key: &str, points: &[Vec3]) -> Vec<Result<(), PhysicsError>> {
    let shape = Shape::Hull { points: points.to_vec() };
    let filter = QueryFilter::default();
    let spawned = w.spawn(&body(key, BodyType::Dynamic, [0.0, 0.0, 0.0], shape.clone())).map_err(|f| f.code);
    let cast = w.shape_cast(&shape, Pose::at([0.0, 0.0, 5.0]), [0.0, 0.0, -1.0], 10.0, &filter).map(drop).map_err(|f| f.code);
    let overlap = w.overlap(&shape, Pose::at([0.0, 0.0, 0.0]), &filter).map(drop).map_err(|f| f.code);
    vec![spawned, cast, overlap]
}

fn allowed(outcome: &Result<(), PhysicsError>) -> bool {
    matches!(outcome, Ok(()) | Err(PhysicsError::BadShape))
}

#[test]
fn near_degenerate_hulls_are_hulls_or_bad_shape_and_never_fail_the_world() {
    for (name, points) in hostile_clouds() {
        let mut w = world(UpAxis::Z);
        for outcome in try_cloud(&mut w, "h", &points) {
            assert!(allowed(&outcome), "{name}: {outcome:?}");
        }
        w.check().unwrap_or_else(|f| panic!("{name}: {f:?}"));
        w.step().unwrap_or_else(|f| panic!("{name}: stepping: {f:?}"));
    }
}

#[test]
fn a_sweep_of_near_degenerate_clouds_never_fails_the_world() {
    let mut rng = Lcg(0x6765_6e65_7870_6879);
    for round in 0..40 {
        let mut w = world(UpAxis::Y);
        for i in 0..60 {
            let kind = (round * 60 + i) % KINDS;
            let points = cloud(&mut rng, kind);
            let outcomes = try_cloud(&mut w, &format!("h{i}"), &points);
            assert!(outcomes.iter().all(allowed), "round {round}, cloud {i} (kind {kind}): {outcomes:?}");
            if w.check().is_err() {
                panic!("round {round}, cloud {i} (kind {kind}) failed the world: {points:?}");
            }
        }
        w.step().unwrap_or_else(|f| panic!("round {round}: stepping: {f:?}"));
    }
}
