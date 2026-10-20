//! STR-10: streamed colliders. A cell's static colliders go into the physics world when the cell
//! enters the sim set and come out when it leaves, in the canonical order (cells ascending on
//! enter and descending on leave, build order inside a cell and its reverse on removal), so an
//! anchor walk gives the same `ColliderHandle`s and the same Rapier state on every run, whatever
//! order the cell builds finished in. The commit the facade's hook makes is replayed here with the
//! crate's own grid, without the facade.
//!
//! Every row is new behaviour (section 0 of the game systems plan): the module was a stub.

#![cfg(feature = "physics")]

use std::collections::BTreeMap;

use genex_core::cell::CellId;
use genex_core::digest::{fnv1a64, fnv1a64_from};
use genex_core::rng::Pcg32;
use genex_stream::grid::{Grid, SimCells, SimRadii};
use genex_stream::physics::{CellColliders, StreamColliders};
use rapier3d::prelude::{ColliderBuilder, ColliderHandle, PhysicsWorld, RigidBodyBuilder, RigidBodyHandle, Vector};

const CELL: f32 = 32.0;
/// Cells the anchor walks out before it walks back.
const WALK_CELLS: i32 = 20;
/// Ticks the anchor stays in each cell.
const TICKS_PER_CELL: u32 = 3;
/// The digest of the 20-cell walk out and back, seed 7: the same on every destination (the web's
/// wasm32 run included), since the commit order and Rapier's enhanced determinism fix it.
const WALK_DIGEST: u64 = 0xd741_6db2_d13a_11d8;

/// What one tick of a walk heard: the handles of the cells that entered (in commit order) and the
/// streamed colliders' digest after the physics step.
type Heard = (Vec<(CellId, Vec<(u32, u32)>)>, u64);

/// How a test removes a leaving cell's colliders.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Removal {
    /// Reverse build order: the commit's rule.
    Canonical,
    /// Build order: the deliberately wrong order, so the walk rows can fail.
    Inverted,
}

/// A cell's colliders as its builder makes them from the seed and the cell alone: a ground slab
/// and a few seeded boxes and balls on it.
fn build(seed: u32, cell: CellId) -> CellColliders {
    let mut rng = Pcg32::seeded(fnv1a64_from(&cell.z.to_le_bytes(), fnv1a64_from(&cell.x.to_le_bytes(), fnv1a64(&seed.to_le_bytes()))));
    let (x0, z0) = (cell.x as f32 * CELL, cell.z as f32 * CELL);
    let half = CELL * 0.5;
    let mut colliders = CellColliders::new().with(ColliderBuilder::cuboid(half, 0.5, half).translation(Vector::new(x0 + half, -0.5, z0 + half)));
    let count = 2 + rng.below(5);
    for i in 0..count {
        let at = Vector::new(x0 + rng.range_f32(1.0, CELL - 1.0), rng.range_f32(0.2, 2.0), z0 + rng.range_f32(1.0, CELL - 1.0));
        let collider = if i % 2 == 0 {
            ColliderBuilder::cuboid(0.5, rng.range_f32(0.2, 1.5), 0.5)
        } else {
            ColliderBuilder::ball(rng.range_f32(0.2, 0.8))
        };
        colliders.push(collider.translation(at).friction(0.7));
    }
    colliders
}

/// Seeded positions of `cells`, so a test can finish builds in a scrambled order.
fn shuffled(cells: &[CellId], shuffle: Option<u64>) -> Vec<CellId> {
    let mut order = cells.to_vec();
    if let Some(seed) = shuffle {
        let mut rng = Pcg32::seeded(seed);
        for i in (1..order.len()).rev() {
            order.swap(i, rng.below(i as u32 + 1) as usize);
        }
    }
    order
}

fn raw(handles: &[ColliderHandle]) -> Vec<(u32, u32)> {
    handles.iter().map(|handle| handle.into_raw_parts()).collect()
}

/// A streamed world: the physics world, the ledger and one dynamic ball that rolls over the cells.
struct Walk {
    world: PhysicsWorld,
    colliders: StreamColliders,
    cells: SimCells,
    ball: RigidBodyHandle,
    seed: u32,
    removal: Removal,
}

impl Walk {
    fn new(seed: u32, removal: Removal) -> Walk {
        let grid = Grid::new(CELL).expect("grid");
        let cells = SimCells::new(grid, SimRadii { radius: 1, hysteresis: 1, prefetch: 1 }).expect("cells");
        let mut world = PhysicsWorld::default();
        let ball = world.insert_body(RigidBodyBuilder::dynamic().translation(Vector::new(10.0, 3.0, 10.0)).linvel(Vector::new(4.0, 0.0, 0.0)));
        world.insert_collider(ColliderBuilder::ball(0.5), Some(ball));
        Walk { world, colliders: StreamColliders::default(), cells, ball, seed, removal }
    }

    /// One tick: the commit for `anchor` (builds finished in the order `shuffle` scrambles), then
    /// a physics step.
    fn tick(&mut self, anchor: CellId, shuffle: Option<u64>) -> Heard {
        let moved = self.cells.update(&[anchor]).expect("anchor inside the world");
        // Builds finish in any order: what the commit reads is keyed by cell.
        let finished = shuffled(&moved.entered, shuffle);
        let built: BTreeMap<CellId, CellColliders> = finished.into_iter().map(|cell| (cell, build(self.seed, cell))).collect();
        for cell in &moved.left {
            match self.removal {
                Removal::Canonical => self.colliders.leave(&mut self.world, *cell),
                Removal::Inverted => self.colliders.leave_in_build_order(&mut self.world, *cell),
            };
        }
        let mut entered = Vec::new();
        for cell in &moved.entered {
            let handles = self.colliders.enter(&mut self.world, *cell, built[cell].iter());
            entered.push((*cell, raw(handles)));
        }
        self.world.step();
        (entered, self.colliders.digest(&self.world))
    }

    /// The ball's position bits, so the rows see the colliders took part in the step.
    fn ball_bits(&self) -> [u32; 3] {
        let at = self.world.bodies[self.ball].translation();
        [at.x.to_bits(), at.y.to_bits(), at.z.to_bits()]
    }
}

/// The anchor's cells over a walk 20 cells out along x and back, `TICKS_PER_CELL` ticks in each.
fn walk_path() -> Vec<CellId> {
    let out = 0..=WALK_CELLS;
    let back = (0..WALK_CELLS).rev();
    out.chain(back).flat_map(|x| std::iter::repeat_n(CellId::new(x, 0), TICKS_PER_CELL as usize)).collect()
}

fn run_walk(seed: u32, removal: Removal, shuffle: Option<u64>) -> (Vec<Heard>, [u32; 3], Walk) {
    let mut walk = Walk::new(seed, removal);
    let heard = walk_path().into_iter().enumerate().map(|(tick, anchor)| walk.tick(anchor, shuffle.map(|s| s + tick as u64))).collect();
    let ball = walk.ball_bits();
    (heard, ball, walk)
}

/// The digest of a whole walk: every tick's handles and collider digest.
fn walk_digest(heard: &[Heard]) -> u64 {
    heard.iter().fold(fnv1a64(b"walk"), |hash, (entered, digest)| {
        let hash = entered.iter().fold(hash, |hash, (cell, handles)| {
            let hash = fnv1a64_from(&cell.x.to_le_bytes(), fnv1a64_from(&cell.z.to_le_bytes(), hash));
            handles.iter().fold(hash, |hash, (index, generation)| fnv1a64_from(&generation.to_le_bytes(), fnv1a64_from(&index.to_le_bytes(), hash)))
        });
        fnv1a64_from(&digest.to_le_bytes(), hash)
    })
}

#[test]
fn an_anchor_walk_across_20_cells_and_back_gives_equal_handles_and_state_with_shuffled_completion() {
    // New behaviour.
    let (plain, plain_ball, plain_walk) = run_walk(7, Removal::Canonical, None);
    let (scrambled, scrambled_ball, _) = run_walk(7, Removal::Canonical, Some(0x5eed));
    let (again, _, _) = run_walk(7, Removal::Canonical, Some(0xbad_5eed));
    assert_eq!(plain.len(), (2 * WALK_CELLS as usize + 1) * TICKS_PER_CELL as usize);
    for (tick, ((a, b), c)) in plain.iter().zip(&scrambled).zip(&again).enumerate() {
        assert_eq!(a, b, "tick {tick}: in order vs scrambled completion");
        assert_eq!(a, c, "tick {tick}: two scrambles");
    }
    assert_eq!(plain_ball, scrambled_ball, "the ball rolled over the same colliders");

    // The walk moved the sim set: cells entered and left, and freed slots were reused.
    let entered: usize = plain.iter().map(|(entered, _)| entered.len()).sum();
    assert!(entered > 2 * WALK_CELLS as usize * 3, "{entered} cell entries");
    let reused = plain.iter().flat_map(|(entered, _)| entered.iter().flat_map(|(_, handles)| handles.iter())).any(|(_, generation)| *generation > 0);
    assert!(reused, "Rapier reused freed slots");

    // Back at the start, the active cells hold exactly their colliders.
    let active: Vec<CellId> = plain_walk.cells.active().iter().copied().collect();
    assert_eq!(plain_walk.colliders.cells().collect::<Vec<_>>(), active);
    let expected: usize = active.iter().map(|cell| build(7, *cell).len()).sum();
    assert_eq!(plain_walk.colliders.len(), expected);
    assert_eq!(plain_walk.world.colliders.len(), expected + 1, "the streamed colliders and the ball's");
}

#[test]
fn a_cell_that_leaves_and_enters_again_gets_its_slots_back() {
    // New behaviour: reverse removal frees the slots so build order takes them again.
    let mut world = PhysicsWorld::default();
    let mut colliders = StreamColliders::default();
    let cell = CellId::new(3, -2);
    let first = raw(colliders.enter(&mut world, cell, build(1, cell).iter()));
    assert_eq!(colliders.leave(&mut world, cell), first.len());
    assert!(colliders.handles(cell).is_empty());
    assert_eq!(world.colliders.len(), 0);
    let second = raw(colliders.enter(&mut world, cell, build(1, cell).iter()));
    let indices = |handles: &[(u32, u32)]| handles.iter().map(|(index, _)| *index).collect::<Vec<_>>();
    assert_eq!(indices(&first), indices(&second), "the same slots, in build order");
    // Rapier's arena keeps one generation for the whole arena, moved on by every removal.
    assert!(second.iter().zip(&first).all(|(b, a)| b.1 > a.1), "the reused slots carry a newer generation");
}

#[test]
fn an_inverted_removal_order_changes_the_handles_and_the_digest() {
    // New behaviour: proves the walk rows can fail.
    let (canonical, _, _) = run_walk(7, Removal::Canonical, None);
    let (inverted, _, _) = run_walk(7, Removal::Inverted, None);
    let first_left = canonical.iter().zip(&inverted).position(|(a, b)| a != b);
    assert!(first_left.is_some(), "removing in build order hands later cells other slots");
    assert_ne!(walk_digest(&canonical), walk_digest(&inverted));
}

#[test]
fn seed_2_then_seed_1_rebuilds_the_same_colliders() {
    // New behaviour: a reseed is a fresh world and an empty ledger.
    let (fresh, fresh_ball, _) = run_walk(1, Removal::Canonical, None);
    let (other, _, mut walk) = run_walk(2, Removal::Canonical, Some(9));
    assert_ne!(walk_digest(&fresh), walk_digest(&other), "the seed reaches the builders");
    // Reseed the same walk: clear the ledger with the world it filled, then walk seed 1.
    walk.colliders.clear(&mut walk.world);
    assert_eq!(walk.world.colliders.len(), 1, "only the ball's collider is left");
    let (again, again_ball, _) = run_walk(1, Removal::Canonical, Some(3));
    assert_eq!(walk_digest(&fresh), walk_digest(&again));
    assert_eq!(fresh_ball, again_ball);
}

#[test]
fn the_walk_digest_is_pinned_for_every_destination() {
    // New behaviour: the web's wasm32 run compares against the same number.
    let (heard, _, _) = run_walk(7, Removal::Canonical, None);
    let digest = walk_digest(&heard);
    assert_eq!(digest, WALK_DIGEST, "walk digest {digest:#018x}");
}

#[test]
fn a_game_removed_collider_is_skipped_on_leave() {
    // New behaviour: a handle the game already removed is not removed twice.
    let mut world = PhysicsWorld::default();
    let mut colliders = StreamColliders::default();
    let cell = CellId::new(0, 0);
    let handles = colliders.enter(&mut world, cell, build(4, cell).iter()).to_vec();
    world.remove_collider(handles[0]);
    assert_eq!(colliders.leave(&mut world, cell), handles.len() - 1);
    assert_eq!(world.colliders.len(), 0);
    assert_eq!(colliders.leave(&mut world, cell), 0, "a cell that is not in leaves nothing");
}

#[test]
fn entering_a_cell_twice_replaces_its_colliders() {
    // New behaviour: the ledger never holds two sets for one cell.
    let mut world = PhysicsWorld::default();
    let mut colliders = StreamColliders::default();
    let cell = CellId::new(-1, 5);
    colliders.enter(&mut world, cell, build(4, cell).iter());
    let count = build(4, cell).len();
    colliders.enter(&mut world, cell, build(4, cell).iter());
    assert_eq!(colliders.len(), count);
    assert_eq!(world.colliders.len(), count);
}

// Native only: the web has no wall clock to time with.
#[cfg(not(target_arch = "wasm32"))]
#[allow(clippy::disallowed_types, reason = "the burst row times the commit on the wall clock; nothing simulated reads it")]
#[test]
fn a_300_insert_burst_is_measured() {
    // New behaviour (advisory in the lane, gated at GC): one commit that inserts 300 colliders.
    const BURST: usize = 300;
    const BURST_CELLS: i32 = 5;
    const RUNS: usize = 25;
    let cells: Vec<CellId> = (0..BURST_CELLS).map(|x| CellId::new(x, 0)).collect();
    let boxes = |cell: &CellId| {
        let at = |i: usize| Vector::new(cell.x as f32 * CELL + i as f32, 0.0, 0.0);
        let per_cell = BURST / BURST_CELLS as usize;
        (0..per_cell).fold(CellColliders::new(), |colliders, i| colliders.with(ColliderBuilder::cuboid(0.5, 0.5, 0.5).translation(at(i))))
    };
    let per_cell: Vec<CellColliders> = cells.iter().map(boxes).collect();
    let mut commits = Vec::new();
    let mut steps = Vec::new();
    for _ in 0..RUNS {
        let mut world = PhysicsWorld::default();
        let mut colliders = StreamColliders::default();
        let start = std::time::Instant::now();
        for (cell, built) in cells.iter().zip(&per_cell) {
            colliders.enter(&mut world, *cell, built.iter());
        }
        commits.push(start.elapsed().as_secs_f64() * 1e6);
        let start = std::time::Instant::now();
        world.step();
        steps.push(start.elapsed().as_secs_f64() * 1e6);
        assert_eq!(colliders.len(), BURST);
        for cell in cells.iter().rev() {
            colliders.leave(&mut world, *cell);
        }
        assert_eq!(world.colliders.len(), 0);
    }
    commits.sort_by(f64::total_cmp);
    steps.sort_by(f64::total_cmp);
    println!(
        "burst {BURST} inserts: commit median {:.1} us, max {:.1} us; first step median {:.1} us, max {:.1} us",
        commits[RUNS / 2],
        commits[RUNS - 1],
        steps[RUNS / 2],
        steps[RUNS - 1]
    );
}
