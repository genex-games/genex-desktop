//! Streamed colliders: a cell's static colliders, built off the sim thread, inserted into the
//! physics world when the cell enters the sim set and removed when it leaves (STR-10).
//!
//! Rapier's arenas hand freed slots back last-freed-first, so the order colliders go in and come
//! out is part of the simulation's initial conditions (Rapier's determinism notes: bodies and
//! colliders must be added and removed in the same order on every run). The commit slot (the
//! facade's `StreamCommit` hook) calls [`StreamColliders::enter`] for entering cells ascending and
//! [`StreamColliders::leave`] for leaving cells descending. Inside a cell, colliders go in in build
//! order and come out in reverse, so a cell that leaves and enters again takes the same slots back
//! and every run gets the same `ColliderHandle`s whatever order the builds finished in.
//!
//! A commit is a fixed amount of work: one insert per collider of each entering cell (the facade
//! caps a cell's colliders), never split by time. Ideas from Jolt's `AddBodiesPrepare` and
//! `AddBodiesFinalize` (MIT; no code): a cell's colliders are prepared on a worker and inserted
//! together.

use std::collections::BTreeMap;

use genex_core::cell::CellId;
use genex_core::digest::{fnv1a64, fnv1a64_from};
use rapier3d::prelude::{Collider, ColliderHandle, PhysicsWorld};

/// A cell's static colliders in build order: what a cell builder makes on a worker for the commit
/// to insert. Positions are in world space (the colliders have no parent body).
#[derive(Clone, Debug, Default)]
pub struct CellColliders {
    colliders: Vec<Collider>,
}

impl CellColliders {
    /// No colliders yet.
    pub fn new() -> CellColliders {
        CellColliders::default()
    }

    /// Adds `collider` after the ones already added (builder style).
    pub fn with(mut self, collider: impl Into<Collider>) -> CellColliders {
        self.push(collider);
        self
    }

    /// Adds `collider` after the ones already added.
    pub fn push(&mut self, collider: impl Into<Collider>) {
        self.colliders.push(collider.into());
    }

    /// How many colliders the cell holds.
    pub fn len(&self) -> usize {
        self.colliders.len()
    }

    /// Whether the cell holds no collider.
    pub fn is_empty(&self) -> bool {
        self.colliders.is_empty()
    }

    /// The colliders, in build order.
    pub fn iter(&self) -> impl ExactSizeIterator<Item = &Collider> + '_ {
        self.colliders.iter()
    }
}

/// The streamed colliders in one physics world, by cell: which handles each active cell's
/// colliders hold. It lives with the world it fills (a reseed starts both fresh), and only the
/// commit slot changes it.
#[derive(Clone, Debug, Default)]
pub struct StreamColliders {
    cells: BTreeMap<CellId, Vec<ColliderHandle>>,
}

impl StreamColliders {
    /// `cell` enters: inserts `colliders` (copies, in the order given) into `world` as standalone
    /// colliders and returns their handles in that order. A cell that is already in leaves first,
    /// so the ledger never holds two sets for one cell.
    pub fn enter<'a>(&mut self, world: &mut PhysicsWorld, cell: CellId, colliders: impl IntoIterator<Item = &'a Collider>) -> &[ColliderHandle] {
        self.leave(world, cell);
        let handles: Vec<ColliderHandle> = colliders.into_iter().map(|collider| world.insert_collider(collider.clone(), None)).collect();
        self.cells.entry(cell).or_insert(handles)
    }

    /// `cell` leaves: removes its colliders from `world` in reverse build order and returns how
    /// many were removed (a handle the game already removed is skipped; a cell that is not in
    /// removes nothing).
    pub fn leave(&mut self, world: &mut PhysicsWorld, cell: CellId) -> usize {
        let Some(handles) = self.cells.remove(&cell) else { return 0 };
        handles.iter().rev().filter(|handle| world.remove_collider(**handle).is_some()).count()
    }

    /// [`StreamColliders::leave`] in build order instead of its reverse: the wrong order, so a
    /// determinism row can prove it fails. Never call it from a game.
    #[doc(hidden)]
    pub fn leave_in_build_order(&mut self, world: &mut PhysicsWorld, cell: CellId) -> usize {
        let Some(handles) = self.cells.remove(&cell) else { return 0 };
        handles.iter().filter(|handle| world.remove_collider(**handle).is_some()).count()
    }

    /// Every cell leaves, descending: the world keeps only the colliders the game added itself.
    pub fn clear(&mut self, world: &mut PhysicsWorld) {
        let cells: Vec<CellId> = self.cells.keys().rev().copied().collect();
        for cell in cells {
            self.leave(world, cell);
        }
    }

    /// The handles `cell`'s colliders hold, in build order (empty when the cell is not in).
    pub fn handles(&self, cell: CellId) -> &[ColliderHandle] {
        self.cells.get(&cell).map_or(&[], Vec::as_slice)
    }

    /// The cells whose colliders are in, ascending.
    pub fn cells(&self) -> impl Iterator<Item = CellId> + '_ {
        self.cells.keys().copied()
    }

    /// How many streamed colliders are in.
    pub fn len(&self) -> usize {
        self.cells.values().map(Vec::len).sum()
    }

    /// Whether no streamed collider is in.
    pub fn is_empty(&self) -> bool {
        self.cells.values().all(Vec::is_empty)
    }

    /// FNV-1a 64 of the streamed colliders: cells ascending, each cell's handles (index and
    /// generation) in build order with its collider's world bounds as IEEE bits. Equal digests on
    /// two runs mean equal slots and equal shapes in them.
    pub fn digest(&self, world: &PhysicsWorld) -> u64 {
        let mut hash = fnv1a64(&(self.cells.len() as u64).to_le_bytes());
        for (cell, handles) in &self.cells {
            hash = fnv1a64_from(&cell.x.to_le_bytes(), hash);
            hash = fnv1a64_from(&cell.z.to_le_bytes(), hash);
            hash = fnv1a64_from(&(handles.len() as u64).to_le_bytes(), hash);
            for handle in handles {
                hash = digest_collider(hash, *handle, world);
            }
        }
        hash
    }
}

/// One streamed collider's slot and bounds folded into `hash` (a slot the game emptied hashes as
/// its handle alone).
fn digest_collider(hash: u64, handle: ColliderHandle, world: &PhysicsWorld) -> u64 {
    let (index, generation) = handle.into_raw_parts();
    let hash = fnv1a64_from(&generation.to_le_bytes(), fnv1a64_from(&index.to_le_bytes(), hash));
    let Some(collider) = world.colliders.get(handle) else { return hash };
    let bounds = collider.compute_aabb();
    let corners = [bounds.mins.x, bounds.mins.y, bounds.mins.z, bounds.maxs.x, bounds.maxs.y, bounds.maxs.z];
    corners.iter().fold(hash, |hash, value| fnv1a64_from(&value.to_bits().to_le_bytes(), hash))
}
