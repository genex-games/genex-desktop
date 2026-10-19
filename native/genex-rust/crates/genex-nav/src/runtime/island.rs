//! Islands: one navigation mesh each, placed in the world by a transform. Tiles of a bake are
//! islands; stitching joins touching ones.
//!
//! Ported from landmass 0.9.3 `src/island.rs` (MIT OR Apache-2.0, used under Apache 2.0).
//! Changed: the id is a [`crate::arena`] key instead of a slotmap key.

use std::sync::Arc;

use super::coords::CoordinateSystem;
use super::nav_mesh::ValidNavigationMesh;
use super::util::{BoundingBox, Transform};

crate::arena_key! {
    /// The id of an island.
    pub struct IslandId;
}

/// An island of an archipelago: a navigation mesh and where it sits.
pub struct Island<CS: CoordinateSystem> {
    /// From the island's frame to the archipelago's.
    pub(crate) transform: Transform<CS>,
    /// The island's navigation mesh.
    pub(crate) nav_mesh: Arc<ValidNavigationMesh<CS>>,
    /// The bounds of `nav_mesh` after `transform`.
    pub(crate) transformed_bounds: BoundingBox,
    /// Whether the island changed since the last update.
    pub(crate) dirty: bool,
}

impl<CS: CoordinateSystem> Island<CS> {
    /// A new island.
    pub fn new(transform: Transform<CS>, nav_mesh: Arc<ValidNavigationMesh<CS>>) -> Self {
        Self { transformed_bounds: nav_mesh.get_bounds().transform(&transform), transform, nav_mesh, dirty: true }
    }

    /// The island's transform.
    pub fn get_transform(&self) -> &Transform<CS> {
        &self.transform
    }

    /// Moves the island (it is re-stitched at the next update).
    pub fn set_transform(&mut self, transform: Transform<CS>) {
        self.transform = transform;
        self.dirty = true;
        self.transformed_bounds = self.nav_mesh.get_bounds().transform(&self.transform);
    }

    /// The island's navigation mesh.
    pub fn get_nav_mesh(&self) -> Arc<ValidNavigationMesh<CS>> {
        Arc::clone(&self.nav_mesh)
    }

    /// Replaces the island's navigation mesh (it is re-stitched at the next update).
    pub fn set_nav_mesh(&mut self, nav_mesh: Arc<ValidNavigationMesh<CS>>) {
        self.nav_mesh = nav_mesh;
        self.dirty = true;
        self.transformed_bounds = self.nav_mesh.get_bounds().transform(&self.transform);
    }
}
