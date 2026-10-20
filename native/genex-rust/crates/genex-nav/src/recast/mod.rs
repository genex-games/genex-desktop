//! Recast generation, ported from rerecast at v0.5.0 (MIT OR Apache-2.0, used under MIT) file for
//! file: heightfield, rasterization, filters, compact heightfield, erosion, area volumes, the
//! watershed distance field and regions, contours, polygon and detail meshes. rerecast is itself
//! a port of Recast (recastnavigation, Zlib); this module is an altered version of both, marked
//! as such here and in each file's header.
//!
//! Changed from upstream (each file's header names its own changes; `N/PORTS.md` has the list):
//! - R1: glam 0.33 (the workspace's scalar-math + libm glam) in place of glam 0.32;
//! - R2: `slotmap` → [`crate::arena`] for span keys (the same last-freed-first slot reuse, so the
//!   same keys in the same order); the unused `CompactSpanKey` is dropped;
//! - R3: `thiserror` derives → hand-written `Display`/`Error` (same messages), and one typed
//!   [`RecastError`] over every stage's error in place of upstream's `anyhow` dependency;
//! - R4: `ops.rs` keeps only the operations the stages call; `cos` always goes through libm
//!   (upstream only with its `libm` feature), so a bake has the same bits on every destination;
//! - R5: `tracing`, `serde` and `bevy_reflect` are dropped (their attributes and log lines only);
//! - R6: `no_std` + `alloc` → std (this crate is std; the code allocates the same way).

mod compact_cell;
mod compact_heightfield;
mod compact_span;
mod config;
mod contours;
mod detail_mesh;
mod erosion;
mod error;
mod heightfield;
mod mark_convex_poly_area;
pub(crate) mod math;
pub(crate) mod ops;
mod poly_mesh;
mod pre_filter;
mod rasterize;
mod region;
mod span;
mod trimesh;
mod watershed_build_regions;
mod watershed_distance_field;

pub use compact_cell::CompactCell;
pub use compact_heightfield::{CompactHeightfield, CompactHeightfieldError};
pub use compact_span::CompactSpan;
pub use config::{Config, ConfigBuilder};
pub use contours::{BuildContoursFlags, Contour, ContourSet, RegionVertexId};
pub use detail_mesh::{DetailNavmesh, DetailNavmeshError, SubMesh};
pub use error::RecastError;
pub use heightfield::{Heightfield, HeightfieldBuilder, HeightfieldBuilderError, SpanInsertionError};
pub use mark_convex_poly_area::ConvexVolume;
pub use math::{Aabb2d, Aabb3d};
pub use poly_mesh::{PolygonNavmesh, PolygonNavmeshError};
pub use rasterize::{PolygonDivisionError, RasterizationError};
pub use region::RegionId;
pub use span::{AreaType, Span, SpanKey, Spans};
pub use trimesh::TriMesh;
pub use watershed_build_regions::BuildRegionsError;
