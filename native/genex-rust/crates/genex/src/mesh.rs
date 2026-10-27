//! Meshes a game builds at reset (Bodycam B2c): `gfx.mesh(&data)` turns vertices and triangles into
//! a [`Model`] that draws, casts, takes levels of detail, an impostor and a material
//! (`frame.model_with`) like a GLB from `assets/`, so a recessed window, a door frame, a trim or a
//! broken wall edge needs no offline file.
//!
//! The mesh is written once into a plain GLB (float positions, normals, UVs and tangents, u32
//! indices, one white dielectric material) that the handle carries: the presenter reads it before
//! the game's asset source, so every loader (level-of-detail chains at load, impostors, the sim's
//! `gfx.assets().triangles(&model)` for colliders and navmeshes) takes it as it takes a file. The
//! bytes are a pure function of the data (insertion order, IEEE arithmetic, no transcendental), so
//! the same data makes the same model on every destination, web included, and a re-seed that builds
//! it again hits every cache. Its path is [`MESH_PATH_PREFIX`] and the bytes' FNV-1a 64.
//!
//! Missing attributes are filled: normals from the triangles (area-weighted where vertices are
//! shared), UVs by projecting along the axis each normal faces most (one tile a metre, the
//! `Material::with_world_uv` rule), tangents from the UVs. A refusal is a [`MeshError`] with a typed
//! [`MeshErrorCode`]; nothing is made.

use std::sync::Arc;

use serde_json::{Value, json};

use crate::gfx::Model;
use crate::math::{Vec2, Vec3};

/// The most vertices a mesh may have.
pub const MESH_VERTICES_MAX: usize = 1 << 18;
/// The most triangles a mesh may have.
pub const MESH_TRIANGLES_MAX: usize = 1 << 18;
/// The folder a built mesh's path names: it is no file under `assets/`, so leave the name alone.
pub const MESH_PATH_PREFIX: &str = "genex-mesh/";
/// The roughness of a built mesh's own material (the facade's `Material::default`).
const MESH_ROUGHNESS: f32 = 0.55;
/// A UV area under this is no direction for a tangent.
const UV_AREA_EPSILON: f32 = 1.0e-12;

/// Why a mesh was refused (nothing was made).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MeshErrorCode {
    /// No position or no triangle.
    Empty,
    /// An index count that is not a multiple of three.
    NotTriangles,
    /// An index past the last vertex.
    IndexOutOfRange,
    /// Normals or UVs given, but not one per position.
    AttributeMismatch,
    /// A position, normal or UV that is not finite.
    NotFinite,
    /// More than [`MESH_VERTICES_MAX`] vertices or [`MESH_TRIANGLES_MAX`] triangles.
    TooLarge,
}

impl MeshErrorCode {
    /// Every code.
    pub const ALL: [MeshErrorCode; 6] = [
        MeshErrorCode::Empty,
        MeshErrorCode::NotTriangles,
        MeshErrorCode::IndexOutOfRange,
        MeshErrorCode::AttributeMismatch,
        MeshErrorCode::NotFinite,
        MeshErrorCode::TooLarge,
    ];

    /// The code's wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            MeshErrorCode::Empty => "mesh-empty",
            MeshErrorCode::NotTriangles => "mesh-not-triangles",
            MeshErrorCode::IndexOutOfRange => "mesh-index-out-of-range",
            MeshErrorCode::AttributeMismatch => "mesh-attribute-mismatch",
            MeshErrorCode::NotFinite => "mesh-not-finite",
            MeshErrorCode::TooLarge => "mesh-too-large",
        }
    }
}

/// A refused mesh.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MeshError {
    /// What was refused.
    pub code: MeshErrorCode,
    /// The numbers involved.
    pub detail: String,
}

impl std::fmt::Display for MeshError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code.wire(), self.detail)
    }
}

impl std::error::Error for MeshError {}

fn refused(code: MeshErrorCode, detail: String) -> MeshError {
    MeshError { code, detail }
}

/// A mesh to build (`gfx.mesh(&data)`): positions in metres, counter-clockwise triangles seen from
/// their front. `normals` and `uvs` are either one per position or empty (then filled, module
/// docs). Push vertices and triangles yourself, or use the builders: [`MeshData::quad`] and
/// [`MeshData::cuboid`] give each face its own vertices and UVs in metres, so a texture keeps one
/// size on every face.
///
/// ```
/// use genex::prelude::*;
/// use genex::MeshData;
///
/// // A window frame: four bars around a 1.2 x 1.4 m opening, 0.1 m thick, 0.2 m deep.
/// let mut frame = MeshData::new();
/// frame
///     .cuboid(vec3(-0.7, 0.0, -0.1), vec3(-0.6, 1.6, 0.1), 1.0)
///     .cuboid(vec3(0.6, 0.0, -0.1), vec3(0.7, 1.6, 0.1), 1.0)
///     .cuboid(vec3(-0.6, 0.0, -0.1), vec3(0.6, 0.1, 0.1), 1.0)
///     .cuboid(vec3(-0.6, 1.5, -0.1), vec3(0.6, 1.6, 0.1), 1.0);
/// assert_eq!(frame.triangle_count(), 48);
/// assert!(frame.check().is_ok());
/// ```
#[derive(Clone, Debug, Default, PartialEq)]
pub struct MeshData {
    /// Vertex positions.
    pub positions: Vec<Vec3>,
    /// One unit normal per position, or empty.
    pub normals: Vec<Vec3>,
    /// One UV per position (v down the image), or empty.
    pub uvs: Vec<Vec2>,
    /// Three indices a triangle, counter-clockwise from the front.
    pub indices: Vec<u32>,
}

impl MeshData {
    /// An empty mesh.
    pub fn new() -> MeshData {
        MeshData::default()
    }

    /// Add a vertex with its normal and UV; returns its index.
    pub fn vertex(&mut self, position: Vec3, normal: Vec3, uv: Vec2) -> u32 {
        self.positions.push(position);
        self.normals.push(normal);
        self.uvs.push(uv);
        (self.positions.len() - 1) as u32
    }

    /// Add the triangle `a`, `b`, `c` (counter-clockwise from its front).
    pub fn triangle(&mut self, a: u32, b: u32, c: u32) -> &mut MeshData {
        self.indices.extend([a, b, c]);
        self
    }

    /// Add a flat quad of four vertices of its own, `corners` counter-clockwise from its front:
    /// bottom left, bottom right, top right, top left as you face it. Its UVs are in tiles of
    /// `metres` (u to the right along the top edge, v down from it), so neighbouring quads of
    /// another size keep one texel size; 0, negative or not finite reads as 1 m.
    pub fn quad(&mut self, corners: [Vec3; 4], metres: f32) -> &mut MeshData {
        let tile = if metres.is_finite() && metres > 0.0 { metres } else { 1.0 };
        let [bottom_left, bottom_right, top_right, top_left] = corners;
        let normal = (bottom_right - bottom_left).cross(top_left - bottom_left).normalize_or(Vec3::Y);
        let across = (top_right - top_left).normalize_or(Vec3::X);
        let down = (bottom_left - top_left).normalize_or(Vec3::NEG_Y);
        let uv = |p: Vec3| Vec2::new((p - top_left).dot(across) / tile, (p - top_left).dot(down) / tile);
        let first = self.vertex(bottom_left, normal, uv(bottom_left));
        for corner in [bottom_right, top_right, top_left] {
            self.vertex(corner, normal, uv(corner));
        }
        self.triangle(first, first + 1, first + 2).triangle(first, first + 2, first + 3)
    }

    /// Add the axis-aligned box from `min` to `max`: six outward quads ([`MeshData::quad`]), each
    /// with UVs in tiles of `metres` (walls upright, the top seen from above with -z up).
    pub fn cuboid(&mut self, min: Vec3, max: Vec3, metres: f32) -> &mut MeshData {
        let (a, b) = (min.min(max), min.max(max));
        let p = |x: f32, y: f32, z: f32| Vec3::new(x, y, z);
        let faces = [
            [p(a.x, a.y, b.z), p(b.x, a.y, b.z), p(b.x, b.y, b.z), p(a.x, b.y, b.z)],
            [p(b.x, a.y, a.z), p(a.x, a.y, a.z), p(a.x, b.y, a.z), p(b.x, b.y, a.z)],
            [p(b.x, a.y, b.z), p(b.x, a.y, a.z), p(b.x, b.y, a.z), p(b.x, b.y, b.z)],
            [p(a.x, a.y, a.z), p(a.x, a.y, b.z), p(a.x, b.y, b.z), p(a.x, b.y, a.z)],
            [p(a.x, b.y, b.z), p(b.x, b.y, b.z), p(b.x, b.y, a.z), p(a.x, b.y, a.z)],
            [p(a.x, a.y, a.z), p(b.x, a.y, a.z), p(b.x, a.y, b.z), p(a.x, a.y, b.z)],
        ];
        for corners in faces {
            self.quad(corners, metres);
        }
        self
    }

    /// Its triangles (whole ones).
    pub fn triangle_count(&self) -> usize {
        self.indices.len() / 3
    }

    /// Whether `gfx.mesh` would build it, and if not, why ([`MeshErrorCode`]).
    pub fn check(&self) -> Result<(), MeshError> {
        let (vertices, indices) = (self.positions.len(), self.indices.len());
        if vertices == 0 || indices == 0 {
            return Err(refused(MeshErrorCode::Empty, format!("{vertices} positions, {indices} indices")));
        }
        if !indices.is_multiple_of(3) {
            return Err(refused(MeshErrorCode::NotTriangles, format!("{indices} indices")));
        }
        if vertices > MESH_VERTICES_MAX || indices / 3 > MESH_TRIANGLES_MAX {
            let detail = format!("{vertices} vertices (at most {MESH_VERTICES_MAX}), {} triangles (at most {MESH_TRIANGLES_MAX})", indices / 3);
            return Err(refused(MeshErrorCode::TooLarge, detail));
        }
        if let Some(index) = self.indices.iter().find(|index| **index as usize >= vertices) {
            return Err(refused(MeshErrorCode::IndexOutOfRange, format!("index {index} of {vertices} vertices")));
        }
        self.check_attributes()
    }

    fn check_attributes(&self) -> Result<(), MeshError> {
        let vertices = self.positions.len();
        for (name, count) in [("normals", self.normals.len()), ("uvs", self.uvs.len())] {
            if count != 0 && count != vertices {
                return Err(refused(MeshErrorCode::AttributeMismatch, format!("{count} {name} for {vertices} positions")));
            }
        }
        let finite3 = |v: &Vec3| v.is_finite();
        if let Some(at) = self.positions.iter().position(|p| !finite3(p)) {
            return Err(refused(MeshErrorCode::NotFinite, format!("position {at}")));
        }
        if let Some(at) = self.normals.iter().position(|n| !finite3(n)) {
            return Err(refused(MeshErrorCode::NotFinite, format!("normal {at}")));
        }
        if let Some(at) = self.uvs.iter().position(|uv| !uv.is_finite()) {
            return Err(refused(MeshErrorCode::NotFinite, format!("uv {at}")));
        }
        Ok(())
    }

    /// The GLB `gfx.mesh` builds (module docs), or why it is refused.
    pub fn to_glb(&self) -> Result<Vec<u8>, MeshError> {
        self.check()?;
        let normals = self.filled_normals();
        let uvs = if self.uvs.is_empty() { normals.iter().zip(&self.positions).map(|(n, p)| box_uv(*p, *n)).collect() } else { self.uvs.clone() };
        let tangents = tangents(&self.positions, &normals, &uvs, &self.indices);
        Ok(glb(&self.positions, &normals, &uvs, &tangents, &self.indices))
    }

    /// The given normals made unit (a zero one faces up), or with none, each vertex's triangles'
    /// normals summed by area.
    fn filled_normals(&self) -> Vec<Vec3> {
        if !self.normals.is_empty() {
            return self.normals.iter().map(|n| n.normalize_or(Vec3::Y)).collect();
        }
        let mut sums = vec![Vec3::ZERO; self.positions.len()];
        for triangle in self.indices.as_chunks::<3>().0 {
            let [a, b, c] = triangle.map(|i| i as usize);
            let face = (self.positions[b] - self.positions[a]).cross(self.positions[c] - self.positions[a]);
            for vertex in [a, b, c] {
                sums[vertex] += face;
            }
        }
        sums.into_iter().map(|sum| sum.normalize_or(Vec3::Y)).collect()
    }
}

/// The world-aligned box projection of `p` along the axis `normal` faces most, one tile a metre:
/// the renderer's `gx_surface_uv` rule (u to the viewer's right, v down a wall).
fn box_uv(p: Vec3, normal: Vec3) -> Vec2 {
    let a = normal.abs();
    let sign = |value: f32| if value >= 0.0 { 1.0 } else { -1.0 };
    if a.x >= a.y && a.x >= a.z {
        return Vec2::new(-sign(normal.x) * p.z, -p.y);
    }
    if a.z >= a.y {
        return Vec2::new(sign(normal.z) * p.x, -p.y);
    }
    Vec2::new(p.x, sign(normal.y) * p.z)
}

/// Per-vertex tangents from the UVs (each triangle's dP/du and dP/dv summed per vertex), made
/// perpendicular to the normal, with the handedness that points the bitangent where v grows (the
/// renderer's meshes': `w` -1 for an upright texture). A vertex with no UV direction takes any
/// perpendicular.
fn tangents(positions: &[Vec3], normals: &[Vec3], uvs: &[Vec2], indices: &[u32]) -> Vec<[f32; 4]> {
    let mut along_u = vec![Vec3::ZERO; positions.len()];
    let mut along_v = vec![Vec3::ZERO; positions.len()];
    for triangle in indices.as_chunks::<3>().0 {
        let [a, b, c] = triangle.map(|i| i as usize);
        let (e1, e2) = (positions[b] - positions[a], positions[c] - positions[a]);
        let (d1, d2) = (uvs[b] - uvs[a], uvs[c] - uvs[a]);
        let area = d1.x * d2.y - d2.x * d1.y;
        if area.abs() < UV_AREA_EPSILON {
            continue;
        }
        let du = (e1 * d2.y - e2 * d1.y) / area;
        let dv = (e2 * d1.x - e1 * d2.x) / area;
        for vertex in [a, b, c] {
            along_u[vertex] += du;
            along_v[vertex] += dv;
        }
    }
    normals
        .iter()
        .zip(along_u.iter().zip(&along_v))
        .map(|(n, (u, v))| {
            let fallback = n.any_orthonormal_vector();
            let t = (*u - *n * n.dot(*u)).normalize_or(fallback);
            let w = if n.cross(t).dot(*v) < 0.0 { -1.0 } else { 1.0 };
            [t.x, t.y, t.z, w]
        })
        .collect()
}

/// The little-endian bytes of `values`.
fn floats(values: impl IntoIterator<Item = f32>) -> Vec<u8> {
    values.into_iter().flat_map(f32::to_le_bytes).collect()
}

/// A plain GLB of one primitive: POSITION (with its bounds), NORMAL, TEXCOORD_0, TANGENT and u32
/// indices in one buffer, a white dielectric material, one node.
fn glb(positions: &[Vec3], normals: &[Vec3], uvs: &[Vec2], tangents: &[[f32; 4]], indices: &[u32]) -> Vec<u8> {
    let chunks = [
        floats(positions.iter().flat_map(|p| p.to_array())),
        floats(normals.iter().flat_map(|n| n.to_array())),
        floats(uvs.iter().flat_map(|uv| uv.to_array())),
        floats(tangents.iter().flatten().copied()),
        indices.iter().flat_map(|i| i.to_le_bytes()).collect(),
    ];
    let mut bin = Vec::new();
    let mut views = Vec::new();
    for (at, chunk) in chunks.iter().enumerate() {
        let target = if at == chunks.len() - 1 { 34963 } else { 34962 };
        views.push(json!({ "buffer": 0, "byteOffset": bin.len(), "byteLength": chunk.len(), "target": target }));
        bin.extend(chunk);
    }
    let (min, max) = positions.iter().fold((Vec3::splat(f32::INFINITY), Vec3::splat(f32::NEG_INFINITY)), |(lo, hi), p| (lo.min(*p), hi.max(*p)));
    let count = positions.len();
    let accessor = |view: usize, kind: &str| json!({ "bufferView": view, "componentType": 5126, "count": count, "type": kind });
    let mut position = accessor(0, "VEC3");
    position["min"] = json!(min.to_array());
    position["max"] = json!(max.to_array());
    let accessors = vec![
        position,
        accessor(1, "VEC3"),
        accessor(2, "VEC2"),
        accessor(3, "VEC4"),
        json!({ "bufferView": 4, "componentType": 5125, "count": indices.len(), "type": "SCALAR" }),
    ];
    let attributes = json!({ "POSITION": 0, "NORMAL": 1, "TEXCOORD_0": 2, "TANGENT": 3 });
    let gltf = json!({
        "asset": { "version": "2.0", "generator": "genex gfx.mesh" },
        "buffers": [{ "byteLength": bin.len() }],
        "bufferViews": views,
        "accessors": accessors,
        "materials": [{ "pbrMetallicRoughness": { "baseColorFactor": [1.0, 1.0, 1.0, 1.0], "metallicFactor": 0.0, "roughnessFactor": MESH_ROUGHNESS } }],
        "meshes": [{ "primitives": [{ "attributes": attributes, "indices": 4, "material": 0, "mode": 4 }] }],
        "nodes": [{ "mesh": 0 }],
        "scenes": [{ "nodes": [0] }],
        "scene": 0,
    });
    container(&gltf, bin)
}

/// `gltf` and `bin` in a GLB container, each chunk padded to four bytes.
fn container(gltf: &Value, mut bin: Vec<u8>) -> Vec<u8> {
    let mut json = gltf.to_string().into_bytes();
    while !json.len().is_multiple_of(4) {
        json.push(b' ');
    }
    while !bin.len().is_multiple_of(4) {
        bin.push(0);
    }
    let total = 12 + 8 + json.len() + 8 + bin.len();
    let mut out = Vec::with_capacity(total);
    out.extend(b"glTF");
    out.extend(2u32.to_le_bytes());
    out.extend((total as u32).to_le_bytes());
    out.extend((json.len() as u32).to_le_bytes());
    out.extend(b"JSON");
    out.extend(&json);
    out.extend((bin.len() as u32).to_le_bytes());
    out.extend(b"BIN\0");
    out.extend(&bin);
    out
}

/// A built mesh's GLB as a model handle carries it: compared and hashed by its digest (its path
/// names the same digest), so a handle stays cheap to compare.
#[derive(Clone)]
pub(crate) struct InlineMesh {
    digest: u64,
    bytes: Arc<[u8]>,
}

impl InlineMesh {
    /// The GLB's bytes.
    pub(crate) fn bytes(&self) -> &[u8] {
        &self.bytes
    }
}

impl std::fmt::Debug for InlineMesh {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "InlineMesh({:016x}, {} bytes)", self.digest, self.bytes.len())
    }
}

impl PartialEq for InlineMesh {
    fn eq(&self, other: &InlineMesh) -> bool {
        self.digest == other.digest && self.bytes.len() == other.bytes.len()
    }
}

impl Eq for InlineMesh {}

impl std::hash::Hash for InlineMesh {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
        self.digest.hash(state);
    }
}

/// The model `data` builds (`gfx.mesh`), or why it is refused.
pub(crate) fn build(data: &MeshData) -> Result<Model, MeshError> {
    let bytes = data.to_glb()?;
    let digest = genex_core::digest::fnv1a64(&bytes);
    let path = format!("{MESH_PATH_PREFIX}{digest:016x}.glb");
    Ok(Model::inline(&path, InlineMesh { digest, bytes: Arc::from(bytes) }))
}

/// Whether `path` names a built mesh (a key the presenter looks up in the frame first).
pub(crate) fn is_mesh_path(path: &str) -> bool {
    path.starts_with(MESH_PATH_PREFIX)
}
