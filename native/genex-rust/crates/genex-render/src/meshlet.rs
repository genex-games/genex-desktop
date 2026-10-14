//! Meshlets (R2): a mesh split into clusters of at most [`MESHLET_MAX_VERTICES`] vertices and
//! [`MESHLET_MAX_TRIANGLES`] triangles, each with a bounding sphere and a normal cone, so the
//! cull can drop the parts of a big mesh that are off screen, facing away or occluded.
//!
//! R2.0 lands the contract every R2 work package builds on:
//! - the limits, the packed triangle (three meshlet-local bytes in a `u32`, low byte first) and
//!   the compacted index encoding (`slot << MESHLET_LOCAL_BITS | local`, [`drawn_index`]);
//! - [`MeshletSet`], one mesh's meshlets as the clusterizer (R2.1) or the `genex_meshlets` GLB
//!   extras (R2.3) give them, and [`validate`], the typed check both go through: a set that fails
//!   it is dropped with its [`MeshletFault`] and the mesh is clustered at runtime (or drawn whole);
//! - [`MeshletLibrary`], the library's meshlet buffers: every mesh's sets appended with their
//!   vertex ids rebased to the library's vertex range ([`MeshletLibrary::append`]);
//! - the `genex_meshlets` extras schema ([`MESHLETS_EXTRAS_KEY`], [`MeshletExtrasKey`],
//!   [`MESHLET_SCHEMA_VERSION`]), documented in genex-render/README.md.
//!
//!
//! R2.1 adds [`build`], the runtime clusterizer the library runs at add time for every mesh at or
//! above the game's `min_triangles` that brought no valid set of its own: greedy and
//! adjacency-driven (no crate), deterministic (the same bytes on every run and target: integer
//! bookkeeping, a fixed float order, IEEE `sqrt` only), with a conservative bounding sphere and
//! normal cone per meshlet. [`MeshletLibrary::append_within`] refuses (typed) a set that would take
//! a meshlet buffer past the storage binding.

use crate::error::{RenderCode, RenderError};
use crate::layout::GpuMeshlet;

/// Whether add_mesh clusters meshes at or above the game's `min_triangles` (R2.1).
pub const LANDED: bool = true;

/// Most vertices in one meshlet (the meshlet-local index fits [`MESHLET_LOCAL_BITS`] bits).
pub const MESHLET_MAX_VERTICES: u32 = 64;
/// Most triangles in one meshlet (meshoptimizer's recommended 124: the packed triangles of a full
/// meshlet stay within 512 bytes).
pub const MESHLET_MAX_TRIANGLES: u32 = 124;
/// Bits of a compacted index that name the meshlet-local vertex.
pub const MESHLET_LOCAL_BITS: u32 = 6;
/// Bytes of one meshlet record ([`GpuMeshlet`], also the extras' record).
pub const MESHLET_RECORD_BYTES: u32 = size_of::<GpuMeshlet>() as u32;
/// The key of the meshlet object in a glTF primitive's `extras` (never an extension, never in
/// `extensionsRequired`: a reader that does not know it draws the primitive as it is).
pub const MESHLETS_EXTRAS_KEY: &str = "genex_meshlets";
/// The `genex_meshlets` schema version this build reads; any other is ignored with a typed fault.
pub const MESHLET_SCHEMA_VERSION: u32 = 1;

// A meshlet-local index fills the compacted index's local bits exactly and fits a packed byte.
const _: () = assert!(1 << MESHLET_LOCAL_BITS == MESHLET_MAX_VERTICES && MESHLET_MAX_VERTICES <= 256);

/// The members of the `genex_meshlets` extras object (wire spellings).
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum MeshletExtrasKey {
    /// The schema version ([`MESHLET_SCHEMA_VERSION`]).
    Version,
    /// The vertex limit the set was built with (at most [`MESHLET_MAX_VERTICES`]).
    MaxVertices,
    /// The triangle limit the set was built with (at most [`MESHLET_MAX_TRIANGLES`]).
    MaxTriangles,
    /// The bufferView of the meshlet records ([`MESHLET_RECORD_BYTES`] each, little-endian).
    Meshlets,
    /// The bufferView of the meshlet vertices: one little-endian `u32` primitive vertex index each.
    Vertices,
    /// The bufferView of the packed triangles: one little-endian `u32` each ([`pack_triangle`]).
    Triangles,
}

impl MeshletExtrasKey {
    /// Every key, in the schema's order.
    pub const ALL: [MeshletExtrasKey; 6] = [
        MeshletExtrasKey::Version,
        MeshletExtrasKey::MaxVertices,
        MeshletExtrasKey::MaxTriangles,
        MeshletExtrasKey::Meshlets,
        MeshletExtrasKey::Vertices,
        MeshletExtrasKey::Triangles,
    ];

    /// The wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            MeshletExtrasKey::Version => "version",
            MeshletExtrasKey::MaxVertices => "max_vertices",
            MeshletExtrasKey::MaxTriangles => "max_triangles",
            MeshletExtrasKey::Meshlets => "meshlets",
            MeshletExtrasKey::Vertices => "vertices",
            MeshletExtrasKey::Triangles => "triangles",
        }
    }
}

/// A triangle's three meshlet-local vertex indices packed into one `u32` (low byte first).
pub const fn pack_triangle(local: [u8; 3]) -> u32 {
    (local[0] as u32) | ((local[1] as u32) << 8) | ((local[2] as u32) << 16)
}

/// The meshlet-local vertex indices of a packed triangle.
pub const fn unpack_triangle(packed: u32) -> [u8; 3] {
    [(packed & 0xff) as u8, ((packed >> 8) & 0xff) as u8, ((packed >> 16) & 0xff) as u8]
}

/// The compacted index buffer's value for meshlet-local vertex `local` of drawn slot `slot`.
pub const fn drawn_index(slot: u32, local: u32) -> u32 {
    (slot << MESHLET_LOCAL_BITS) | local
}

/// The drawn slot and meshlet-local vertex a compacted index names.
pub const fn decode_drawn_index(index: u32) -> (u32, u32) {
    (index >> MESHLET_LOCAL_BITS, index & ((1 << MESHLET_LOCAL_BITS) - 1))
}

/// Whether a meshlet faces wholly away from a viewer at `eye` (object space), by its cone: the
/// CPU reference of `gx_meshlet_backfacing` (conservative: never true for a visible triangle).
pub fn backfacing(meshlet: &GpuMeshlet, eye: [f32; 3]) -> bool {
    let [cx, cy, cz, radius] = meshlet.bounds;
    let [ax, ay, az, cutoff] = meshlet.cone;
    let to = [cx - eye[0], cy - eye[1], cz - eye[2]];
    let length = (to[0] * to[0] + to[1] * to[1] + to[2] * to[2]).sqrt();
    to[0] * ax + to[1] * ay + to[2] * az >= cutoff * length + radius
}

/// One mesh's meshlets: offsets index this set's own `vertices` and `triangles`, and `vertices`
/// holds the mesh's own vertex indices (a GLB primitive's, or an immediate mesh's).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct MeshletSet {
    /// The meshlet records.
    pub meshlets: Vec<GpuMeshlet>,
    /// Mesh vertex index of each meshlet vertex.
    pub vertices: Vec<u32>,
    /// Packed meshlet-local triangles ([`pack_triangle`]).
    pub triangles: Vec<u32>,
}

/// Why a [`MeshletSet`] is refused (typed; the mesh falls back to runtime clustering or to the
/// instance path, never panics).
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum MeshletFault {
    /// The extras name a schema version this build does not read.
    UnknownVersion,
    /// A meshlet has no vertices or triangles, or more than the limits.
    OverLimit,
    /// A meshlet's vertex or triangle range runs past its buffer.
    RangeOutOfBounds,
    /// Two meshlets' ranges overlap or leave a gap (ranges tile each buffer in order).
    RangesNotTiled,
    /// A meshlet vertex names no vertex of the mesh.
    VertexOutOfMesh,
    /// A triangle names a meshlet-local vertex past the meshlet's count, or its fourth byte is set.
    LocalIndexOutOfMeshlet,
    /// The meshlets' triangles are not the mesh's triangles, each exactly once.
    TrianglesDiffer,
}

impl MeshletFault {
    /// Every fault, in wire order.
    pub const ALL: [MeshletFault; 7] = [
        MeshletFault::UnknownVersion,
        MeshletFault::OverLimit,
        MeshletFault::RangeOutOfBounds,
        MeshletFault::RangesNotTiled,
        MeshletFault::VertexOutOfMesh,
        MeshletFault::LocalIndexOutOfMeshlet,
        MeshletFault::TrianglesDiffer,
    ];

    /// The wire spelling (the typed warning a fallback reports).
    pub const fn wire(self) -> &'static str {
        match self {
            MeshletFault::UnknownVersion => "meshlets-unknown-version",
            MeshletFault::OverLimit => "meshlets-over-limit",
            MeshletFault::RangeOutOfBounds => "meshlets-range-out-of-bounds",
            MeshletFault::RangesNotTiled => "meshlets-ranges-not-tiled",
            MeshletFault::VertexOutOfMesh => "meshlets-vertex-out-of-mesh",
            MeshletFault::LocalIndexOutOfMeshlet => "meshlets-local-index-out-of-meshlet",
            MeshletFault::TrianglesDiffer => "meshlets-triangles-differ",
        }
    }
}

/// A triangle with its winding kept, rotated so its smallest index comes first.
fn canonical(triangle: [u32; 3]) -> [u32; 3] {
    let [a, b, c] = triangle;
    if a <= b && a <= c {
        [a, b, c]
    } else if b <= c {
        [b, c, a]
    } else {
        [c, a, b]
    }
}

/// Check one meshlet's counts and that its ranges continue where the previous one ended.
fn check_ranges(meshlet: &GpuMeshlet, next: (u32, u32), set: &MeshletSet) -> Result<(), MeshletFault> {
    let counts_fit = (1..=MESHLET_MAX_VERTICES).contains(&meshlet.vertex_count) && (1..=MESHLET_MAX_TRIANGLES).contains(&meshlet.triangle_count);
    if !counts_fit {
        return Err(MeshletFault::OverLimit);
    }
    let vertex_end = u64::from(meshlet.vertex_offset) + u64::from(meshlet.vertex_count);
    let triangle_end = u64::from(meshlet.triangle_offset) + u64::from(meshlet.triangle_count);
    if vertex_end > set.vertices.len() as u64 || triangle_end > set.triangles.len() as u64 {
        return Err(MeshletFault::RangeOutOfBounds);
    }
    if (meshlet.vertex_offset, meshlet.triangle_offset) != next {
        return Err(MeshletFault::RangesNotTiled);
    }
    Ok(())
}

/// The mesh-vertex triangles of one meshlet, checked against the mesh and the meshlet.
fn meshlet_triangles(meshlet: &GpuMeshlet, set: &MeshletSet, mesh_vertices: u32) -> Result<Vec<[u32; 3]>, MeshletFault> {
    let first = meshlet.vertex_offset as usize;
    let local_vertices = &set.vertices[first..first + meshlet.vertex_count as usize];
    if local_vertices.iter().any(|vertex| *vertex >= mesh_vertices) {
        return Err(MeshletFault::VertexOutOfMesh);
    }
    let first = meshlet.triangle_offset as usize;
    let mut triangles = Vec::with_capacity(meshlet.triangle_count as usize);
    for packed in &set.triangles[first..first + meshlet.triangle_count as usize] {
        let local = unpack_triangle(*packed);
        let in_meshlet = local.iter().all(|index| u32::from(*index) < meshlet.vertex_count);
        if packed >> 24 != 0 || !in_meshlet {
            return Err(MeshletFault::LocalIndexOutOfMeshlet);
        }
        triangles.push(canonical(local.map(|index| local_vertices[usize::from(index)])));
    }
    Ok(triangles)
}

/// Check `set` against the mesh it claims to cover: `indices` (a triangle list) over
/// `mesh_vertices` vertices. Limits, in-bounds ranges that tile both buffers in order, vertex and
/// local indices in range, and every mesh triangle (winding kept) in exactly one meshlet.
pub fn validate(set: &MeshletSet, indices: &[u32], mesh_vertices: u32) -> Result<(), MeshletFault> {
    let mut next = (0u32, 0u32);
    let mut covered: Vec<[u32; 3]> = Vec::with_capacity(indices.len() / 3);
    for meshlet in &set.meshlets {
        check_ranges(meshlet, next, set)?;
        covered.extend(meshlet_triangles(meshlet, set, mesh_vertices)?);
        next = (meshlet.vertex_offset + meshlet.vertex_count, meshlet.triangle_offset + meshlet.triangle_count);
    }
    if next != (set.vertices.len() as u32, set.triangles.len() as u32) {
        return Err(MeshletFault::RangesNotTiled);
    }
    let mut mesh: Vec<[u32; 3]> = indices.as_chunks::<3>().0.iter().map(|triangle| canonical(*triangle)).collect();
    mesh.sort_unstable();
    covered.sort_unstable();
    if mesh != covered {
        return Err(MeshletFault::TrianglesDiffer);
    }
    Ok(())
}

/// One mesh's meshlets in the library: its range of the meshlet table.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct MeshletRange {
    /// The first meshlet-table row.
    pub first_meshlet: u32,
    /// Meshlets.
    pub meshlet_count: u32,
}

/// The library's meshlet buffers: the meshlet table, the meshlet vertex buffer (library vertex
/// ids, rebased) and the packed triangles, every mesh's set appended in add order. Uploaded as
/// read-only storage (`tables::meshlet_draw_layout_entries` and the cull's group).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct MeshletLibrary {
    /// Every meshlet, offsets into this library's buffers.
    pub meshlets: Vec<GpuMeshlet>,
    /// The library vertex id of every meshlet vertex.
    pub vertices: Vec<u32>,
    /// Every packed triangle.
    pub triangles: Vec<u32>,
}

impl MeshletLibrary {
    /// Append a validated `set` of a mesh whose first vertex is library vertex `base_vertex`:
    /// offsets move to this library's buffers and vertex ids to the library's vertex range.
    pub fn append(&mut self, set: &MeshletSet, base_vertex: u32) -> MeshletRange {
        let range = MeshletRange { first_meshlet: self.meshlets.len() as u32, meshlet_count: set.meshlets.len() as u32 };
        let (vertex_base, triangle_base) = (self.vertices.len() as u32, self.triangles.len() as u32);
        self.meshlets.extend(set.meshlets.iter().map(|meshlet| GpuMeshlet {
            vertex_offset: meshlet.vertex_offset + vertex_base,
            triangle_offset: meshlet.triangle_offset + triangle_base,
            ..*meshlet
        }));
        self.vertices.extend(set.vertices.iter().map(|vertex| vertex + base_vertex));
        self.triangles.extend_from_slice(&set.triangles);
        range
    }

    /// Bytes of the three buffers.
    pub fn bytes(&self) -> u64 {
        self.meshlets.len() as u64 * u64::from(MESHLET_RECORD_BYTES) + (self.vertices.len() as u64 + self.triangles.len() as u64) * 4
    }

    /// Bytes of the largest of the three buffers (each is bound whole as one storage binding).
    pub fn bytes_of_largest_buffer(&self) -> u64 {
        self.buffer_bytes(0, 0, 0)
    }

    /// The largest buffer's bytes with `meshlets`, `vertices` and `triangles` more rows.
    fn buffer_bytes(&self, meshlets: usize, vertices: usize, triangles: usize) -> u64 {
        let table = (self.meshlets.len() + meshlets) as u64 * u64::from(MESHLET_RECORD_BYTES);
        let words = ((self.vertices.len() + vertices).max(self.triangles.len() + triangles)) as u64 * 4;
        table.max(words)
    }

    /// [`MeshletLibrary::append`], refused `buffer-too-large` (nothing written) when a buffer would
    /// pass `max_binding_bytes` (the storage binding the cull and the draw bind it with:
    /// [`crate::BUFFER_MAX_BYTES`], WebGPU core's 128 MiB) or a row count would pass `u32`. The
    /// mesh then draws whole.
    pub fn append_within(&mut self, set: &MeshletSet, base_vertex: u32, max_binding_bytes: u64) -> Result<MeshletRange, RenderError> {
        let bytes = self.buffer_bytes(set.meshlets.len(), set.vertices.len(), set.triangles.len());
        let rows = self.meshlets.len() + set.meshlets.len();
        if bytes > max_binding_bytes || u32::try_from(rows).is_err() {
            return Err(RenderError::refused(RenderCode::BufferTooLarge, format!("meshlet buffers of {bytes} bytes, past the {max_binding_bytes}-byte storage binding")));
        }
        Ok(self.append(set, base_vertex))
    }
}

// --- The clusterizer (R2.1) -----------------------------------------------------------------------

/// A mesh-local vertex not in the meshlet being built.
const NOT_LOCAL: u8 = u8::MAX;
/// Most triangles around one vertex listed as candidates when it joins a meshlet: a hub shared by
/// thousands of triangles adds a bounded few, and its other triangles stay reachable through
/// their other corners.
const CANDIDATES_PER_VERTEX: usize = 32;
/// Dot-product slack taken off the cone's widest normal, so f32 rounding in the face normals never
/// leaves a triangle outside its cone (about a quarter degree on a flat patch).
const CONE_DOT_SLACK: f32 = 1e-5;
/// A cone whose widest normal is this far from its axis (dot at or below) culls nothing: stored as
/// cutoff 1.
const CONE_MIN_DOT: f32 = 0.0;
/// Relative slack added to a meshlet's radius (of the radius plus the centre's magnitude), so f32
/// rounding never leaves a vertex outside its sphere.
const RADIUS_SLACK: f32 = 4.0 * f32::EPSILON;

/// The triangles around each vertex: `triangles[offsets[v]..offsets[v + 1]]` lists vertex `v`'s
/// triangles (one entry per corner), `live[v]` counts those not yet clustered, and the clustered
/// entries before `first[v]` are skipped for good. Nothing is ever searched or moved, so a vertex
/// shared by many triangles (a fan's hub) costs no more than its list once.
struct Adjacency {
    offsets: Vec<u32>,
    live: Vec<u32>,
    first: Vec<u32>,
    triangles: Vec<u32>,
}

impl Adjacency {
    fn new(indices: &[u32], vertex_count: usize) -> Adjacency {
        let mut live = vec![0u32; vertex_count];
        for index in indices {
            live[*index as usize] += 1;
        }
        let mut offsets = Vec::with_capacity(vertex_count + 1);
        let mut total = 0u32;
        for count in &live {
            offsets.push(total);
            total += count;
        }
        offsets.push(total);
        let mut fill = offsets[..vertex_count].to_vec();
        let mut triangles = vec![0u32; indices.len()];
        for (corner, index) in indices.iter().enumerate() {
            let at = &mut fill[*index as usize];
            triangles[*at as usize] = (corner / 3) as u32;
            *at += 1;
        }
        let first = offsets[..vertex_count].to_vec();
        Adjacency { offsets, live, first, triangles }
    }
}

/// The greedy builder's state: the mesh, its adjacency, and the meshlet being grown.
struct Builder<'a> {
    indices: &'a [u32],
    positions: &'a [[f32; 3]],
    adjacency: Adjacency,
    clustered: Vec<bool>,
    /// The meshlet-local index of each mesh vertex in the meshlet being built, or [`NOT_LOCAL`].
    local: Vec<u8>,
    vertices: Vec<u32>,
    /// The sum of the meshlet's vertex positions (its centre times its vertex count).
    centre: [f32; 3],
    triangles: Vec<[u8; 3]>,
    /// The unclustered triangles touching the meshlet being built (each once): the only ones it
    /// can grow by, so a step scores its edge, not every triangle around every vertex.
    candidates: Vec<u32>,
    /// The meshlet (counted from 1) whose candidates list each triangle, so it is listed once.
    listed: Vec<u32>,
    /// The meshlet being built, counted from 1.
    meshlet: u32,
    /// Each triangle's centroid.
    centroids: Vec<[f32; 3]>,
    set: MeshletSet,
    /// The next triangle the in-order seed scan looks at.
    cursor: usize,
}

impl Builder<'_> {
    fn corners(&self, triangle: u32) -> [u32; 3] {
        let at = triangle as usize * 3;
        [self.indices[at], self.indices[at + 1], self.indices[at + 2]]
    }

    /// Vertices `triangle` would add to the meshlet (a repeated corner counts once).
    fn new_vertices(&self, triangle: u32) -> u32 {
        let [a, b, c] = self.corners(triangle);
        let new = |v: u32| u32::from(self.local[v as usize] == NOT_LOCAL);
        new(a) + if b == a { 0 } else { new(b) } + if c == a || c == b { 0 } else { new(c) }
    }

    /// The best triangle next to the meshlet that fits it: fewest new vertices (a triangle that
    /// takes a vertex's last unclustered triangle counts as adding none, so no vertex is left with
    /// an orphan), then nearest the meshlet's centre (a round meshlet holds the most triangles for
    /// its vertices and has the tightest sphere), then the lowest triangle id. A triangle adding no
    /// vertex is taken at once.
    fn best_neighbor(&mut self) -> Option<u32> {
        let clustered = &self.clustered;
        self.candidates.retain(|triangle| !clustered[*triangle as usize]);
        let room = MESHLET_MAX_VERTICES - self.vertices.len() as u32;
        let count = self.vertices.len() as f32;
        let centre = self.centre.map(|c| c / count);
        let mut best: Option<(u32, f32, u32)> = None;
        for triangle in &self.candidates {
            let new = self.new_vertices(*triangle);
            if new > room {
                continue;
            }
            if new == 0 {
                return Some(*triangle);
            }
            let closes = self.corners(*triangle).iter().any(|v| self.adjacency.live[*v as usize] == 1);
            let rank = if closes { 0 } else { new };
            let offset = sub(self.centroids[*triangle as usize], centre);
            let key = (rank, dot(offset, offset), *triangle);
            // A total order (a NaN distance sorts last), so the choice is the same everywhere.
            let better = best.is_none_or(|(r, d, t)| key.0.cmp(&r).then(key.1.total_cmp(&d)).then(key.2.cmp(&t)).is_lt());
            if better {
                best = Some(key);
            }
        }
        best.map(|(_, _, triangle)| triangle)
    }

    /// The first triangle of a new meshlet: next to the meshlet just finished when one is left
    /// there (at its vertex with the fewest unclustered triangles, so the clustered region grows
    /// as one front and leaves no islands), else the first unclustered triangle in index order.
    fn seed(&mut self, previous: &[u32]) -> Option<u32> {
        let corner = previous.iter().filter(|v| self.adjacency.live[**v as usize] > 0).min_by_key(|v| self.adjacency.live[**v as usize]);
        if let Some(vertex) = corner.copied() {
            let at = self.skip_clustered(vertex);
            return Some(self.adjacency.triangles[at]);
        }
        while self.cursor < self.clustered.len() && self.clustered[self.cursor] {
            self.cursor += 1;
        }
        (self.cursor < self.clustered.len()).then_some(self.cursor as u32)
    }

    /// Move `vertex`'s skip mark past its clustered triangles at the front of its list; the
    /// absolute position of its first triangle left (its list's end when none is).
    fn skip_clustered(&mut self, vertex: u32) -> usize {
        let end = self.adjacency.offsets[vertex as usize + 1] as usize;
        let mut at = self.adjacency.first[vertex as usize] as usize;
        while at < end && self.clustered[self.adjacency.triangles[at] as usize] {
            at += 1;
        }
        self.adjacency.first[vertex as usize] = at as u32;
        at
    }

    /// List the first [`CANDIDATES_PER_VERTEX`] unclustered triangles around a vertex that just
    /// joined the meshlet as candidates (each once per meshlet).
    fn list_candidates(&mut self, vertex: u32) {
        let at = self.skip_clustered(vertex);
        let end = self.adjacency.offsets[vertex as usize + 1] as usize;
        let mut seen = 0;
        for triangle in &self.adjacency.triangles[at..end] {
            if seen == CANDIDATES_PER_VERTEX {
                break;
            }
            if self.clustered[*triangle as usize] {
                continue;
            }
            seen += 1;
            if self.listed[*triangle as usize] != self.meshlet {
                self.listed[*triangle as usize] = self.meshlet;
                self.candidates.push(*triangle);
            }
        }
    }

    fn add(&mut self, triangle: u32) {
        self.clustered[triangle as usize] = true;
        let corners = self.corners(triangle);
        let mut local = [0u8; 3];
        for vertex in corners {
            self.adjacency.live[vertex as usize] -= 1;
        }
        for (slot, vertex) in corners.iter().enumerate() {
            if self.local[*vertex as usize] == NOT_LOCAL {
                self.local[*vertex as usize] = self.vertices.len() as u8;
                self.vertices.push(*vertex);
                let p = self.positions[*vertex as usize];
                self.centre = [self.centre[0] + p[0], self.centre[1] + p[1], self.centre[2] + p[2]];
                self.list_candidates(*vertex);
            }
            local[slot] = self.local[*vertex as usize];
        }
        self.triangles.push(local);
    }

    /// Close the meshlet being built: its record, vertices and triangles go to the set. Returns its
    /// vertices (for the next seed).
    fn finish(&mut self) -> Vec<u32> {
        let vertices = std::mem::take(&mut self.vertices);
        let triangles = std::mem::take(&mut self.triangles);
        self.centre = [0.0; 3];
        self.candidates.clear();
        self.meshlet += 1;
        for vertex in &vertices {
            self.local[*vertex as usize] = NOT_LOCAL;
        }
        if triangles.is_empty() {
            return vertices;
        }
        let points: Vec<[f32; 3]> = vertices.iter().map(|v| self.positions[*v as usize]).collect();
        let faces: Vec<[[f32; 3]; 3]> = triangles.iter().map(|t| t.map(|local| points[usize::from(local)])).collect();
        self.set.meshlets.push(GpuMeshlet {
            bounds: bounding_sphere(&points),
            cone: normal_cone(&faces),
            vertex_offset: self.set.vertices.len() as u32,
            triangle_offset: self.set.triangles.len() as u32,
            vertex_count: vertices.len() as u32,
            triangle_count: triangles.len() as u32,
        });
        self.set.vertices.extend_from_slice(&vertices);
        self.set.triangles.extend(triangles.iter().map(|t| pack_triangle(*t)));
        vertices
    }

    fn run(mut self) -> MeshletSet {
        let mut previous: Vec<u32> = Vec::new();
        while let Some(seed) = self.seed(&previous) {
            self.add(seed);
            while self.triangles.len() < MESHLET_MAX_TRIANGLES as usize {
                let Some(next) = self.best_neighbor() else { break };
                self.add(next);
            }
            previous = self.finish();
        }
        self.set
    }
}

/// Cluster a triangle list (`indices`, three per triangle, over `positions`) into meshlets of at
/// most [`MESHLET_MAX_VERTICES`] vertices and [`MESHLET_MAX_TRIANGLES`] triangles, every triangle
/// in exactly one with its winding kept ([`validate`] passes), each with a bounding sphere and a
/// normal cone (cutoff 1 where no cone helps). Greedy: a meshlet grows from a seed by the adjacent
/// triangle adding the fewest vertices; the next seeds where the last one stopped. Deterministic:
/// the same input gives the same bytes on every run and target. Refused typed, never panicking:
/// `TrianglesDiffer` when `indices` is not whole triangles, `VertexOutOfMesh` for an index past
/// `positions`.
pub fn build(indices: &[u32], positions: &[[f32; 3]]) -> Result<MeshletSet, MeshletFault> {
    if !indices.len().is_multiple_of(3) {
        return Err(MeshletFault::TrianglesDiffer);
    }
    if indices.iter().any(|index| *index as usize >= positions.len()) {
        return Err(MeshletFault::VertexOutOfMesh);
    }
    let triangle_count = indices.len() / 3;
    let builder = Builder {
        indices,
        positions,
        adjacency: Adjacency::new(indices, positions.len()),
        clustered: vec![false; triangle_count],
        local: vec![NOT_LOCAL; positions.len()],
        vertices: Vec::with_capacity(MESHLET_MAX_VERTICES as usize),
        centre: [0.0; 3],
        triangles: Vec::with_capacity(MESHLET_MAX_TRIANGLES as usize),
        candidates: Vec::new(),
        listed: vec![0; triangle_count],
        meshlet: 1,
        centroids: indices.as_chunks::<3>().0.iter().map(|t| centroid(t.map(|v| positions[v as usize]))).collect(),
        set: MeshletSet {
            meshlets: Vec::with_capacity(triangle_count / 64 + 1),
            vertices: Vec::with_capacity(triangle_count),
            triangles: Vec::with_capacity(triangle_count),
        },
        cursor: 0,
    };
    Ok(builder.run())
}

fn centroid([a, b, c]: [[f32; 3]; 3]) -> [f32; 3] {
    [(a[0] + b[0] + c[0]) / 3.0, (a[1] + b[1] + c[1]) / 3.0, (a[2] + b[2] + c[2]) / 3.0]
}

fn sub(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn dot(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// `v` scaled to unit length, or `None` when it has none (zero, tiny or not finite).
fn unit(v: [f32; 3]) -> Option<[f32; 3]> {
    let length = dot(v, v).sqrt();
    (length.is_finite() && length > f32::MIN_POSITIVE).then(|| v.map(|c| c / length))
}

/// A sphere around `points` (Ritter's: the farthest pair of axis extremes, grown over every point),
/// its radius then the farthest point's distance plus rounding slack. Not finite points give a
/// sphere that culls nothing (an infinite radius).
fn bounding_sphere(points: &[[f32; 3]]) -> [f32; 4] {
    if points.iter().flatten().any(|c| !c.is_finite()) {
        return [0.0, 0.0, 0.0, f32::INFINITY];
    }
    let (mut low, mut high) = ([0usize; 3], [0usize; 3]);
    for (at, point) in points.iter().enumerate() {
        for axis in 0..3 {
            if point[axis] < points[low[axis]][axis] {
                low[axis] = at;
            }
            if point[axis] > points[high[axis]][axis] {
                high[axis] = at;
            }
        }
    }
    let spread = |axis: usize| {
        let d = sub(points[high[axis]], points[low[axis]]);
        dot(d, d)
    };
    let axis = (0..3).fold(0, |best, axis| if spread(axis) > spread(best) { axis } else { best });
    let (a, b) = (points[low[axis]], points[high[axis]]);
    let mut center = [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5, (a[2] + b[2]) * 0.5];
    let mut radius = spread(axis).sqrt() * 0.5;
    for point in points {
        let d = sub(*point, center);
        let distance = dot(d, d).sqrt();
        if distance > radius {
            let shift = 0.5 * (1.0 - radius / distance);
            center = [center[0] + d[0] * shift, center[1] + d[1] * shift, center[2] + d[2] * shift];
            radius = 0.5 * (radius + distance);
        }
    }
    let farthest = points.iter().map(|p| dot(sub(*p, center), sub(*p, center)).sqrt()).fold(0.0f32, f32::max);
    let magnitude = center.iter().fold(0.0f32, |m, c| m.max(c.abs()));
    [center[0], center[1], center[2], farthest + (farthest + magnitude) * RADIUS_SLACK]
}

/// The normal cone of `faces` (meshoptimizer's convention, [`GpuMeshlet::cone`]): the axis is the
/// mean face normal; the cutoff is the sine of the widest normal's angle from it (minus rounding
/// slack), or 1 (no cone) when a normal is 90 degrees or more off the axis or no face has a normal.
fn normal_cone(faces: &[[[f32; 3]; 3]]) -> [f32; 4] {
    const NO_CONE: [f32; 4] = [0.0, 0.0, 1.0, 1.0];
    let normals: Vec<[f32; 3]> = faces
        .iter()
        .filter_map(|[p0, p1, p2]| {
            let (e1, e2) = (sub(*p1, *p0), sub(*p2, *p0));
            unit([e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]])
        })
        .collect();
    let sum = normals.iter().fold([0.0f32; 3], |s, n| [s[0] + n[0], s[1] + n[1], s[2] + n[2]]);
    let Some(axis) = unit(sum) else { return NO_CONE };
    let widest = normals.iter().fold(1.0f32, |m, n| m.min(dot(*n, axis))).min(1.0) - CONE_DOT_SLACK;
    if widest <= CONE_MIN_DOT {
        return [axis[0], axis[1], axis[2], 1.0];
    }
    [axis[0], axis[1], axis[2], (1.0 - widest * widest).sqrt()]
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A quad (two triangles over four vertices) as one meshlet.
    fn quad() -> (MeshletSet, Vec<u32>) {
        let meshlet = GpuMeshlet { bounds: [0.5, 0.5, 0.0, 0.75], cone: [0.0, 0.0, 1.0, 1.0], vertex_offset: 0, triangle_offset: 0, vertex_count: 4, triangle_count: 2 };
        let set = MeshletSet { meshlets: vec![meshlet], vertices: vec![0, 1, 2, 3], triangles: vec![pack_triangle([0, 1, 2]), pack_triangle([0, 2, 3])] };
        (set, vec![0, 1, 2, 2, 3, 0])
    }

    #[test]
    fn the_limits_and_encodings_fit_their_bits() {
        assert_eq!(MESHLET_RECORD_BYTES, 48);
        assert_eq!(unpack_triangle(pack_triangle([63, 7, 0])), [63, 7, 0]);
        assert_eq!(pack_triangle([1, 2, 3]), 0x0003_0201);
        let index = drawn_index(1_000_000, 63);
        assert_eq!(decode_drawn_index(index), (1_000_000, 63));
        assert_eq!(decode_drawn_index(drawn_index(u32::MAX >> MESHLET_LOCAL_BITS, 0)).0, u32::MAX >> MESHLET_LOCAL_BITS);
    }

    #[test]
    fn a_set_covering_its_mesh_once_validates_with_the_winding_rotated() {
        let (set, indices) = quad();
        assert_eq!(validate(&set, &indices, 4), Ok(()));
    }

    #[test]
    fn hostile_sets_are_refused_with_their_fault() {
        let (good, indices) = quad();
        let mut past_range = good.clone();
        past_range.meshlets[0].triangle_count = 3;
        assert_eq!(validate(&past_range, &indices, 4), Err(MeshletFault::RangeOutOfBounds));
        let mut too_many = good.clone();
        too_many.meshlets[0].triangle_count = 200;
        assert_eq!(validate(&too_many, &indices, 4), Err(MeshletFault::OverLimit));
        let mut overlapping = good.clone();
        overlapping.meshlets.push(GpuMeshlet { vertex_offset: 2, triangle_offset: 1, vertex_count: 2, triangle_count: 1, ..good.meshlets[0] });
        assert_eq!(validate(&overlapping, &indices, 4), Err(MeshletFault::RangesNotTiled));
        let mut outside = good.clone();
        outside.vertices[3] = 9;
        assert_eq!(validate(&outside, &indices, 4), Err(MeshletFault::VertexOutOfMesh));
        let mut local = good.clone();
        local.triangles[1] = pack_triangle([0, 2, 4]);
        assert_eq!(validate(&local, &indices, 4), Err(MeshletFault::LocalIndexOutOfMeshlet));
        let mut flipped = good.clone();
        flipped.triangles[1] = pack_triangle([0, 3, 2]);
        assert_eq!(validate(&flipped, &indices, 4), Err(MeshletFault::TrianglesDiffer), "the winding is kept");
        let mut twice = good;
        twice.triangles[1] = pack_triangle([1, 2, 0]);
        assert_eq!(validate(&twice, &indices, 4), Err(MeshletFault::TrianglesDiffer), "a triangle twice, another never");
    }

    #[test]
    fn appending_rebases_offsets_and_vertex_ids_to_the_library() {
        let (set, _) = quad();
        let mut library = MeshletLibrary::default();
        assert_eq!(library.append(&set, 0), MeshletRange { first_meshlet: 0, meshlet_count: 1 });
        assert_eq!(library.append(&set, 100), MeshletRange { first_meshlet: 1, meshlet_count: 1 });
        assert_eq!((library.meshlets[1].vertex_offset, library.meshlets[1].triangle_offset), (4, 2));
        assert_eq!(library.vertices[4..], [100, 101, 102, 103]);
        assert_eq!(library.bytes(), 2 * 48 + (8 + 4) * 4);
    }

    #[test]
    fn the_cone_test_culls_only_a_meshlet_facing_wholly_away() {
        // A small flat patch facing +z with a tight cone (cutoff: sin of a 5 degree half angle).
        let patch = GpuMeshlet { bounds: [0.0, 0.0, 0.0, 0.1], cone: [0.0, 0.0, 1.0, 0.087], ..GpuMeshlet::default() };
        assert!(!backfacing(&patch, [0.0, 0.0, 5.0]), "seen from the front");
        assert!(backfacing(&patch, [0.0, 0.0, -5.0]), "seen from behind");
        let no_cone = GpuMeshlet { cone: [0.0, 0.0, 1.0, 1.0], ..patch };
        assert!(!backfacing(&no_cone, [0.0, 0.0, -5.0]), "cutoff 1 is never back-facing");
    }
}
