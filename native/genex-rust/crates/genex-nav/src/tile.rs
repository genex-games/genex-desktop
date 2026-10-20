//! `NavTile`: one baked tile of the grid anchored at world (0, 0): its cell, the digests of the
//! config and the input window it was baked from, its polygons and detail triangles in world
//! space, and its bytes.
//!
//! The bytes are a little-endian layout written here (the crate takes no serializer dependency),
//! ending in the FNV-1a 64 digest of everything before it:
//!
//! ```text
//! "GXNT" | u16 version | u16 0 | i32 cell x | i32 cell z | u64 config digest | u64 input digest
//! u32 vertices, then x, y, z as f32 each
//! u32 polygons, then per polygon: u8 corner count (3..=6), u8 area, the corners as u16 indices
//! u32 detail parts, then per part: u32 base vertex, vertex count, base triangle, triangle count
//! u32 detail vertices, then x, y, z as f32 each
//! u32 detail triangles, then three u8 part-local indices each
//! u64 digest
//! ```
//!
//! [`NavTile::from_bytes`] checks the length, magic, version and digest before it reads a count,
//! and checks every count against its cap and against the bytes left before it allocates, so a
//! hostile count never reserves more than the bytes could hold. Everything it returns is
//! consistent: indices inside their tables, finite vertices, areas Recast can store, one detail
//! part per polygon.
//!
//! [`NavTile::navigation_mesh`] turns a tile into the runtime's island mesh: the polygons with
//! their areas as type indices, and the detail triangles as its height mesh. It does what
//! landmass_rerecast's `raw_conversion.rs` (MIT OR Apache-2.0) does for landmass, written here
//! from the two formats (no code taken): a tile's vertices are already in metres and Recast's
//! winding is already the runtime's once `GenexCoords` maps genex's (x, z) to its (x, -z), so the
//! tables carry over as they are.

use genex_core::cell::CellId;
use genex_core::digest::fnv1a64;
use glam::Vec3;

use crate::error::NavError;
use crate::runtime::coords::GenexCoords;
use crate::runtime::nav_mesh::{HeightNavigationMesh, HeightPolygon, NavigationMesh};

/// The tile format version [`NavTile::to_bytes`] writes and [`NavTile::from_bytes`] reads.
pub const NAV_TILE_VERSION: u16 = 1;
/// Vertices one tile may hold (polygons index them with `u16`).
pub const NAV_TILE_VERTICES_MAX: usize = 65_535;
/// Polygons one tile may hold.
pub const NAV_TILE_POLYGONS_MAX: usize = 32_768;
/// Corners one polygon may have (the bake's `max_vertices_per_polygon`).
pub const NAV_TILE_POLYGON_VERTICES_MAX: usize = 6;
/// Detail vertices one tile may hold.
pub const NAV_TILE_DETAIL_VERTICES_MAX: usize = 1 << 20;
/// Detail triangles one tile may hold.
pub const NAV_TILE_DETAIL_TRIANGLES_MAX: usize = 1 << 20;
/// The largest area a tile stores ([`crate::NavArea::raw`]; Recast keeps six bits per polygon).
pub const NAV_TILE_AREA_MAX: u8 = 63;
/// The four bytes every tile starts with.
const MAGIC: [u8; 4] = *b"GXNT";
/// Magic, version, padding, cell, config digest, input digest.
const HEADER_BYTES: usize = 4 + 2 + 2 + 4 + 4 + 8 + 8;
/// The trailing digest.
const DIGEST_BYTES: usize = 8;
/// One vertex: three `f32`.
const VERTEX_BYTES: usize = 12;
/// The smallest polygon record: corner count, area and three `u16` indices.
const POLYGON_MIN_BYTES: usize = 2 + 3 * 2;
/// One detail part: four `u32`.
const DETAIL_PART_BYTES: usize = 16;
/// One detail triangle: three `u8`.
const DETAIL_TRIANGLE_BYTES: usize = 3;
/// The five table counts.
const COUNT_BYTES: usize = 5 * 4;

/// The detail triangles of one polygon: a run of [`TileMesh::detail_vertices`] and a run of
/// [`TileMesh::detail_triangles`] whose indices count from `base_vertex`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DetailPart {
    /// The first detail vertex this polygon's triangles use.
    pub base_vertex: u32,
    /// How many detail vertices from `base_vertex` they may use.
    pub vertex_count: u32,
    /// The first of this polygon's detail triangles.
    pub base_triangle: u32,
    /// How many detail triangles the polygon has.
    pub triangle_count: u32,
}

/// A tile's geometry in world space.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TileMesh {
    /// Polygon corners, in metres.
    pub vertices: Vec<Vec3>,
    /// Convex polygons as indices into [`TileMesh::vertices`] in Recast's winding, 3 to
    /// [`NAV_TILE_POLYGON_VERTICES_MAX`] corners each.
    pub polygons: Vec<Vec<u16>>,
    /// The area of each polygon ([`crate::NavArea::raw`]).
    pub areas: Vec<u8>,
    /// The detail triangles of each polygon (one part per polygon).
    pub detail_parts: Vec<DetailPart>,
    /// Detail vertices, in metres.
    pub detail_vertices: Vec<Vec3>,
    /// Detail triangles: part-local vertex indices.
    pub detail_triangles: Vec<[u8; 3]>,
}

impl TileMesh {
    /// The bytes the geometry takes in memory (vertex, index, area and detail tables).
    pub fn memory_bytes(&self) -> usize {
        let indices: usize = self.polygons.iter().map(Vec::len).sum();
        self.vertices.len() * VERTEX_BYTES
            + indices * 2
            + self.areas.len()
            + self.detail_parts.len() * DETAIL_PART_BYTES
            + self.detail_vertices.len() * VERTEX_BYTES
            + self.detail_triangles.len() * DETAIL_TRIANGLE_BYTES
    }

    /// Every rule [`NavTile::from_bytes`] checks, for a mesh however it was made.
    fn check(&self) -> Result<(), NavError> {
        let within_caps = self.vertices.len() <= NAV_TILE_VERTICES_MAX && self.polygons.len() <= NAV_TILE_POLYGONS_MAX;
        if !within_caps {
            return Err(NavError::tile_invalid(format!("{} vertices and {} polygons, over the caps", self.vertices.len(), self.polygons.len())));
        }
        if let Some(bad) = self.vertices.iter().chain(&self.detail_vertices).position(|v| !v.is_finite()) {
            return Err(NavError::tile_invalid(format!("vertex {bad} is not finite")));
        }
        let counts_match = self.areas.len() == self.polygons.len() && self.detail_parts.len() == self.polygons.len();
        if !counts_match {
            return Err(NavError::tile_invalid("one area and one detail part per polygon"));
        }
        for (index, polygon) in self.polygons.iter().enumerate() {
            let size_usable = (3..=NAV_TILE_POLYGON_VERTICES_MAX).contains(&polygon.len());
            let indices_usable = polygon.iter().all(|&i| usize::from(i) < self.vertices.len());
            if !(size_usable && indices_usable) {
                return Err(NavError::tile_invalid(format!("polygon {index}: 3 to 6 corners inside the vertex table")));
            }
            if self.areas[index] > NAV_TILE_AREA_MAX {
                return Err(NavError::tile_invalid(format!("polygon {index} has area {}", self.areas[index])));
            }
        }
        self.check_detail()
    }

    fn check_detail(&self) -> Result<(), NavError> {
        let within_caps = self.detail_vertices.len() <= NAV_TILE_DETAIL_VERTICES_MAX && self.detail_triangles.len() <= NAV_TILE_DETAIL_TRIANGLES_MAX;
        if !within_caps {
            return Err(NavError::tile_invalid("detail tables over the caps"));
        }
        for (index, part) in self.detail_parts.iter().enumerate() {
            let vertex_end = u64::from(part.base_vertex) + u64::from(part.vertex_count);
            let triangle_end = u64::from(part.base_triangle) + u64::from(part.triangle_count);
            let inside = vertex_end <= self.detail_vertices.len() as u64 && triangle_end <= self.detail_triangles.len() as u64;
            if !inside {
                return Err(NavError::tile_invalid(format!("detail part {index} reaches past its tables")));
            }
            let start = part.base_triangle as usize;
            let local = &self.detail_triangles[start..start + part.triangle_count as usize];
            if local.iter().flatten().any(|&i| u32::from(i) >= part.vertex_count) {
                return Err(NavError::tile_invalid(format!("detail part {index} names a vertex outside its run")));
            }
        }
        Ok(())
    }
}

/// One baked tile. Equal tiles have equal bytes and digests.
#[derive(Clone, Debug, PartialEq)]
pub struct NavTile {
    cell: CellId,
    config_digest: u64,
    input_digest: u64,
    mesh: TileMesh,
    digest: u64,
}

impl NavTile {
    /// A tile of `mesh` at `cell`, baked with the config and input window whose digests are
    /// given. Refused `nav-tile-invalid` for a mesh [`NavTile::from_bytes`] would refuse.
    pub fn new(cell: CellId, config_digest: u64, input_digest: u64, mesh: TileMesh) -> Result<NavTile, NavError> {
        mesh.check()?;
        let mut tile = NavTile { cell, config_digest, input_digest, mesh, digest: 0 };
        tile.digest = fnv1a64(&tile.body_bytes());
        Ok(tile)
    }

    /// The tile's cell in the grid anchored at world (0, 0).
    pub fn cell(&self) -> CellId {
        self.cell
    }

    /// The FNV-1a 64 digest of the tile's bytes (the last eight bytes of [`NavTile::to_bytes`]).
    pub fn digest(&self) -> u64 {
        self.digest
    }

    /// The digest of the config the tile was baked with.
    pub fn config_digest(&self) -> u64 {
        self.config_digest
    }

    /// The digest of the input window the tile was baked from.
    pub fn input_digest(&self) -> u64 {
        self.input_digest
    }

    /// The tile's geometry.
    pub fn mesh(&self) -> &TileMesh {
        &self.mesh
    }

    /// The polygons the tile holds.
    pub fn polygon_count(&self) -> usize {
        self.mesh.polygons.len()
    }

    /// The bytes the tile's geometry takes in memory ([`TileMesh::memory_bytes`]).
    pub fn memory_bytes(&self) -> usize {
        self.mesh.memory_bytes()
    }

    /// The tile as bytes, digest last.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut bytes = self.body_bytes();
        bytes.extend_from_slice(&self.digest.to_le_bytes());
        bytes
    }

    fn body_bytes(&self) -> Vec<u8> {
        let mesh = &self.mesh;
        let mut out = Vec::with_capacity(HEADER_BYTES + COUNT_BYTES + mesh.memory_bytes() + mesh.polygons.len() * 2 + DIGEST_BYTES);
        out.extend_from_slice(&MAGIC);
        out.extend_from_slice(&NAV_TILE_VERSION.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&self.cell.x.to_le_bytes());
        out.extend_from_slice(&self.cell.z.to_le_bytes());
        out.extend_from_slice(&self.config_digest.to_le_bytes());
        out.extend_from_slice(&self.input_digest.to_le_bytes());
        put_vertices(&mut out, &mesh.vertices);
        put_count(&mut out, mesh.polygons.len());
        for (polygon, area) in mesh.polygons.iter().zip(&mesh.areas) {
            // `check` holds every polygon to 3..=6 corners, so the count fits a byte.
            out.push(polygon.len() as u8);
            out.push(*area);
            for index in polygon {
                out.extend_from_slice(&index.to_le_bytes());
            }
        }
        put_count(&mut out, mesh.detail_parts.len());
        for part in &mesh.detail_parts {
            for value in [part.base_vertex, part.vertex_count, part.base_triangle, part.triangle_count] {
                out.extend_from_slice(&value.to_le_bytes());
            }
        }
        put_vertices(&mut out, &mesh.detail_vertices);
        put_count(&mut out, mesh.detail_triangles.len());
        for triangle in &mesh.detail_triangles {
            out.extend_from_slice(triangle);
        }
        out
    }

    /// Reads a tile [`NavTile::to_bytes`] wrote. Refused `nav-tile-invalid`, with nothing
    /// allocated past what the bytes can hold: bytes too short, another magic or version, a
    /// digest that does not match, a count over its cap or past the bytes left, trailing bytes,
    /// or a mesh that breaks a tile rule (an index past its table, a non-finite vertex, an area
    /// over 63, a polygon of fewer than 3 or more than 6 corners).
    pub fn from_bytes(bytes: &[u8]) -> Result<NavTile, NavError> {
        if bytes.len() < HEADER_BYTES + DIGEST_BYTES {
            return Err(NavError::tile_invalid(format!("{} bytes is shorter than a tile header", bytes.len())));
        }
        let (body, tail) = bytes.split_at(bytes.len() - DIGEST_BYTES);
        let mut reader = Reader { bytes: body, at: 0 };
        if reader.take(MAGIC.len())? != MAGIC {
            return Err(NavError::tile_invalid("not a nav tile (magic)"));
        }
        let version = reader.u16()?;
        if version != NAV_TILE_VERSION {
            return Err(NavError::tile_invalid(format!("tile format version {version}, this build reads {NAV_TILE_VERSION}")));
        }
        let digest = u64::from_le_bytes(tail.try_into().expect("eight bytes"));
        if fnv1a64(body) != digest {
            return Err(NavError::tile_invalid("the tile's digest does not match its bytes"));
        }
        reader.u16()?;
        let cell = CellId::new(reader.i32()?, reader.i32()?);
        let (config_digest, input_digest) = (reader.u64()?, reader.u64()?);
        let mesh = read_mesh(&mut reader)?;
        if reader.at != body.len() {
            return Err(NavError::tile_invalid(format!("{} bytes after the tile", body.len() - reader.at)));
        }
        mesh.check()?;
        Ok(NavTile { cell, config_digest, input_digest, mesh, digest })
    }

    /// The tile as the runtime's island mesh: the polygons with each polygon's area as its type
    /// index, and the detail triangles as the height mesh (both already in the runtime's winding
    /// under `GenexCoords`).
    pub fn navigation_mesh(&self) -> NavigationMesh<GenexCoords> {
        let mesh = &self.mesh;
        let polygons = mesh.polygons.iter().map(|polygon| polygon.iter().map(|&i| usize::from(i)).collect()).collect();
        let polygon_type_indices = mesh.areas.iter().map(|&area| usize::from(area)).collect();
        let height_polygons = mesh
            .detail_parts
            .iter()
            .map(|part| HeightPolygon {
                base_vertex_index: part.base_vertex,
                vertex_count: part.vertex_count,
                base_triangle_index: part.base_triangle,
                triangle_count: part.triangle_count,
            })
            .collect();
        let height_mesh = HeightNavigationMesh { polygons: height_polygons, vertices: mesh.detail_vertices.clone(), triangles: mesh.detail_triangles.clone() };
        NavigationMesh { vertices: mesh.vertices.clone(), polygons, polygon_type_indices, height_mesh: Some(height_mesh) }
    }
}

fn put_count(out: &mut Vec<u8>, count: usize) {
    // Every table is held under a cap below `u32::MAX` by `TileMesh::check`.
    out.extend_from_slice(&(count as u32).to_le_bytes());
}

fn put_vertices(out: &mut Vec<u8>, vertices: &[Vec3]) {
    put_count(out, vertices.len());
    for vertex in vertices {
        for c in vertex.to_array() {
            out.extend_from_slice(&c.to_le_bytes());
        }
    }
}

fn read_mesh(reader: &mut Reader<'_>) -> Result<TileMesh, NavError> {
    let vertices = reader.vertices(NAV_TILE_VERTICES_MAX)?;
    let polygon_count = reader.count(NAV_TILE_POLYGONS_MAX, POLYGON_MIN_BYTES)?;
    let (mut polygons, mut areas) = (Vec::with_capacity(polygon_count), Vec::with_capacity(polygon_count));
    for index in 0..polygon_count {
        let corners = usize::from(reader.u8()?);
        if !(3..=NAV_TILE_POLYGON_VERTICES_MAX).contains(&corners) {
            return Err(NavError::tile_invalid(format!("polygon {index} has {corners} corners")));
        }
        areas.push(reader.u8()?);
        let polygon = (0..corners).map(|_| reader.u16()).collect::<Result<Vec<u16>, NavError>>()?;
        polygons.push(polygon);
    }
    let part_count = reader.count(NAV_TILE_POLYGONS_MAX, DETAIL_PART_BYTES)?;
    let mut detail_parts = Vec::with_capacity(part_count);
    for _ in 0..part_count {
        let (base_vertex, vertex_count, base_triangle, triangle_count) = (reader.u32()?, reader.u32()?, reader.u32()?, reader.u32()?);
        detail_parts.push(DetailPart { base_vertex, vertex_count, base_triangle, triangle_count });
    }
    let detail_vertices = reader.vertices(NAV_TILE_DETAIL_VERTICES_MAX)?;
    let triangle_count = reader.count(NAV_TILE_DETAIL_TRIANGLES_MAX, DETAIL_TRIANGLE_BYTES)?;
    let mut detail_triangles = Vec::with_capacity(triangle_count);
    for _ in 0..triangle_count {
        let t = reader.take(DETAIL_TRIANGLE_BYTES)?;
        detail_triangles.push([t[0], t[1], t[2]]);
    }
    Ok(TileMesh { vertices, polygons, areas, detail_parts, detail_vertices, detail_triangles })
}

/// Reads little-endian values off a byte slice; every read past the end is `nav-tile-invalid`.
struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl Reader<'_> {
    fn take(&mut self, count: usize) -> Result<&[u8], NavError> {
        let end = self.at.checked_add(count).filter(|&end| end <= self.bytes.len());
        let Some(end) = end else {
            return Err(NavError::tile_invalid(format!("the tile ends early: {count} bytes wanted at byte {}", self.at)));
        };
        let slice = &self.bytes[self.at..end];
        self.at = end;
        Ok(slice)
    }

    fn array<const N: usize>(&mut self) -> Result<[u8; N], NavError> {
        Ok(self.take(N)?.try_into().expect("take returned N bytes"))
    }

    fn u8(&mut self) -> Result<u8, NavError> {
        Ok(self.take(1)?[0])
    }

    fn u16(&mut self) -> Result<u16, NavError> {
        self.array().map(u16::from_le_bytes)
    }

    fn u32(&mut self) -> Result<u32, NavError> {
        self.array().map(u32::from_le_bytes)
    }

    fn i32(&mut self) -> Result<i32, NavError> {
        self.array().map(i32::from_le_bytes)
    }

    fn u64(&mut self) -> Result<u64, NavError> {
        self.array().map(u64::from_le_bytes)
    }

    fn f32(&mut self) -> Result<f32, NavError> {
        self.array().map(f32::from_le_bytes)
    }

    /// A count of records at least `record_bytes` long each: refused over `cap` or past the
    /// bytes left, before anything is allocated for them.
    fn count(&mut self, cap: usize, record_bytes: usize) -> Result<usize, NavError> {
        let count = self.u32()? as usize;
        let left = self.bytes.len() - self.at;
        let fits = count <= cap && count.saturating_mul(record_bytes) <= left;
        if !fits {
            return Err(NavError::tile_invalid(format!("a count of {count} (cap {cap}, {left} bytes left)")));
        }
        Ok(count)
    }

    fn vertices(&mut self, cap: usize) -> Result<Vec<Vec3>, NavError> {
        let count = self.count(cap, VERTEX_BYTES)?;
        let mut vertices = Vec::with_capacity(count);
        for _ in 0..count {
            vertices.push(Vec3::new(self.f32()?, self.f32()?, self.f32()?));
        }
        Ok(vertices)
    }
}
