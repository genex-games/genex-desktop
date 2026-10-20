//! `RecastError`: why a Recast stage refused, one typed value over every stage's own error.
//!
//! New in the port: upstream depends on `anyhow` for this; each stage still returns its own typed
//! error, and `?` lifts it into a `RecastError`.

use core::fmt;

use super::{
    BuildRegionsError, CompactHeightfieldError, DetailNavmeshError, HeightfieldBuilderError, PolygonNavmeshError,
    RasterizationError,
};

/// A Recast stage that refused, with that stage's error.
#[derive(Debug)]
pub enum RecastError {
    /// The heightfield's grid is too large ([`super::HeightfieldBuilder::build`]).
    Heightfield(HeightfieldBuilderError),
    /// A triangle did not rasterize ([`super::Heightfield::rasterize_triangles`]).
    Rasterization(RasterizationError),
    /// The compact heightfield has too many layers ([`super::Heightfield::into_compact`]).
    CompactHeightfield(CompactHeightfieldError),
    /// Region ids ran out ([`super::CompactHeightfield::build_regions`]).
    Regions(BuildRegionsError),
    /// The polygon mesh did not build ([`super::ContourSet::into_polygon_mesh`]).
    PolygonMesh(PolygonNavmeshError),
    /// The detail mesh did not build ([`super::DetailNavmesh::new`]).
    DetailMesh(DetailNavmeshError),
}

impl fmt::Display for RecastError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RecastError::Heightfield(error) => write!(f, "heightfield: {error}"),
            RecastError::Rasterization(error) => write!(f, "rasterization: {error}"),
            RecastError::CompactHeightfield(error) => write!(f, "compact heightfield: {error}"),
            RecastError::Regions(error) => write!(f, "regions: {error}"),
            RecastError::PolygonMesh(error) => write!(f, "polygon mesh: {error}"),
            RecastError::DetailMesh(error) => write!(f, "detail mesh: {error}"),
        }
    }
}

impl core::error::Error for RecastError {}

macro_rules! from_stage {
    ($($variant:ident($error:ty)),* $(,)?) => {
        $(impl From<$error> for RecastError {
            fn from(error: $error) -> Self {
                RecastError::$variant(error)
            }
        })*
    };
}

from_stage!(
    Heightfield(HeightfieldBuilderError),
    Rasterization(RasterizationError),
    CompactHeightfield(CompactHeightfieldError),
    Regions(BuildRegionsError),
    PolygonMesh(PolygonNavmeshError),
    DetailMesh(DetailNavmeshError),
);
