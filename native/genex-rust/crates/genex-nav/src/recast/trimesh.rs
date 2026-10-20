// Ported from rerecast v0.5.0 `crates/rerecast/src/trimesh.rs` (MIT OR Apache-2.0, used under MIT;
// by Jan Hohenheim and contributors), itself a port of Recast (Zlib); an altered version of both. Changed: R4: `cos` is libm's through `ops`.
// The R-numbered changes are listed in `mod.rs` and `N/PORTS.md`.

//! Contains traits and methods for converting [`Collider`]s into trimeshes, expressed as [`TrimeshedCollider`]s.

use super::ops::*;
use super::{
    math::{Aabb3d, TriangleIndices as _},
    span::AreaType,
};
use std::vec::Vec;
use glam::{UVec3, Vec3A};

/// A mesh used as input for [`Heightfield`](super::Heightfield) rasterization.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct TriMesh {
    /// The vertices composing the collider.
    /// Follows the convention of a triangle list.
    pub vertices: Vec<Vec3A>,

    /// The indices composing the collider.
    /// Follows the convention of a triangle list.
    pub indices: Vec<UVec3>,

    /// The area types of the trimesh. Each index corresponds 1:1 to the [`TriMesh::indices`].
    pub area_types: Vec<AreaType>,
}

impl TriMesh {
    /// Extends the trimesh with the vertices and indices of another trimesh.
    /// The indices of `other` will be offset by the number of vertices in `self`.
    pub fn extend(&mut self, other: TriMesh) {
        if self.vertices.len() > u32::MAX as usize {
            panic!("Cannot extend a trimesh with more than 2^32 vertices");
        }
        let next_vertex_index = self.vertices.len() as u32;
        self.vertices.extend(other.vertices);
        self.indices
            .extend(other.indices.iter().map(|i| i + next_vertex_index));
        self.area_types.extend(other.area_types);
    }

    /// Computes the AABB of the trimesh.
    /// Returns `None` if the trimesh is empty.
    pub fn compute_aabb(&self) -> Option<Aabb3d> {
        Aabb3d::from_verts(&self.vertices)
    }

    /// Marks the triangles as walkable or not based on the threshold angle.
    ///
    /// The triangles are marked as walkable if the normal angle is greater than the threshold angle.
    ///
    /// # Arguments
    ///
    /// * `threshold_rad` - The threshold angle in radians.
    ///
    pub fn mark_walkable_triangles(&mut self, threshold_rad: f32) {
        let threshold_cos = cos(threshold_rad);
        for (i, indices) in self.indices.iter().enumerate() {
            let normal = indices.normal(&self.vertices);

            if normal.y > threshold_cos {
                self.area_types[i] = AreaType::DEFAULT_WALKABLE;
            }
        }
    }
}
