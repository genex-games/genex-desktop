//! Mesh data on the CPU: the immediate primitives (unit cube, unit sphere) and GLB models with an
//! embedded buffer. A vertex carries position, normal, uv and a tangent (xyz, w the bitangent's
//! handedness) for normal maps; skinned GLBs are read by [`crate::skin`]. A GLB's materials and
//! embedded textures, one mesh per material, are [`GlbModel`] (`glb_material.rs`).

use bytemuck::{Pod, Zeroable};
use glam::{Mat3, Mat4, Vec3};

use crate::error::{RenderCode, RenderError};
use crate::layout::GpuMeshlet;
use crate::meshlet::{
    MESHLET_MAX_TRIANGLES, MESHLET_MAX_VERTICES, MESHLET_RECORD_BYTES, MESHLET_SCHEMA_VERSION, MESHLETS_EXTRAS_KEY, MeshletExtrasKey, MeshletFault, MeshletLibrary,
    MeshletSet, validate,
};

// The GLB material loader lives beside the mesh loader it shares the primitive walk with.
#[path = "glb_material.rs"]
mod glb_material;
pub use glb_material::{
    GLB_TEXTURE_STEM_MAX_CHARS, GLB_TEXTURES_EXTRAS_KEY, GLB_TEXTURES_SCHEMA_VERSION, GLTF_DEFAULT_ALPHA_CUTOFF, GlbEmission, GlbMaterial, GlbModel, GlbPart, GlbSidecar,
    GlbSidecars, GlbTextureImageKey, GlbTextureUsage, GlbTexturesKey, decode_image,
};
// The material extensions (A6.1) live beside the material loader that reads them.
#[path = "glb_material_ext.rs"]
mod glb_material_ext;
pub use glb_material_ext::{DEFAULT_IOR, GlbAnisotropy, GlbClearcoat, GlbDiffuseTransmission, GlbMaterialExt, GlbSheen, GlbSpecular, GlbTexture, GlbVolume};
// Import-time LODs (A6.9) are read beside the meshlet extras they sit next to.
#[path = "mesh_lod.rs"]
mod mesh_lod;
pub use mesh_lod::{
    LOD_MAX_LEVELS, LOD_MIN_TRIANGLES, LOD_NOMINAL_HEIGHT, LOD_SCHEMA_VERSION, LOD_SELECT_WGSL, LOD_THRESHOLD_PX, LODS_EXTRAS_KEY, LodChain, LodExtrasKey,
    LodFault, LodLevel, LodLevelKey, LodWarning, batch_lod, lod_keeps, select_lod,
};
// The LOD fade band (game systems LOD-01).
pub use mesh_lod::{LOD_FADE_TAG, LodBand, fade_batch_lod, lod_band, lod_band_keep, lod_row_keep, lod_row_keep_far};
// The impostor as a chain level (game systems LOD-15).
pub use mesh_lod::{LOD_IMPOSTOR_MESH_LEVELS, LOD_IMPOSTOR_TAG, LOD_PLANNED_TAG, caster_level, impostor_batch_lod, impostor_level_error, lod_row_keep_view};
// A chain's shadow casters' level (lane FR).
pub use mesh_lod::{LOD_CASTERS_TAG, LOD_MAX_CASTER_LEVELS, camera_skips, casters_lod};
// Skinned primitives' levels (game systems AN-25).
pub(crate) use mesh_lod::{LodMerge, read_lod_extras};

/// One vertex as the vertex buffer holds it (`MeshVertex` in the skinning shader).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct Vertex {
    /// Model-space position.
    pub position: [f32; 3],
    /// Unit normal.
    pub normal: [f32; 3],
    /// Texture coordinate (TEXCOORD_0), v down.
    pub uv: [f32; 2],
    /// Unit tangent (xyz) along +u, and the bitangent's sign (w, ±1).
    pub tangent: [f32; 4],
}

/// An indexed triangle list.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct MeshData {
    /// Vertices.
    pub vertices: Vec<Vertex>,
    /// Three indices per triangle, counter-clockwise when seen from the front.
    pub indices: Vec<u32>,
}

/// Rings and segments of the immediate sphere.
const SPHERE_RINGS: u32 = 16;
const SPHERE_SEGMENTS: u32 = 32;
/// Triangles of [`MeshData::cube`]: two per face.
pub const CUBE_TRIANGLES: u32 = 12;
/// Triangles of [`MeshData::sphere`]: two per ring segment.
pub const SPHERE_TRIANGLES: u32 = SPHERE_RINGS * SPHERE_SEGMENTS * 2;

pub(crate) fn invalid(detail: impl Into<String>) -> RenderError {
    RenderError::refused(RenderCode::MeshInvalid, detail)
}

/// A unit vector orthogonal to `n` (for a vertex with no usable uv derivative).
fn any_tangent(n: Vec3) -> Vec3 {
    let helper = if n.x.abs() < 0.9 { Vec3::X } else { Vec3::Y };
    (helper - n * n.dot(helper)).normalize_or(Vec3::X)
}

/// A primitive the `genex_meshlets` extras were refused for (R2.3): the mesh is then clustered at
/// runtime instead. `fault.wire()` is the typed warning.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MeshletWarning {
    /// The primitive's place in the load: the order [`MeshData::from_glb`] visits them.
    pub primitive: usize,
    /// Why the extras were refused.
    pub fault: MeshletFault,
}

/// The meshlets a GLB brought with it (R2.3).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct GlbMeshlets {
    /// Every primitive's valid `genex_meshlets`, merged for [`MeshData::from_glb`]'s mesh (offsets
    /// and vertex ids index that mesh); `None` when any primitive has none or one was refused.
    pub set: Option<MeshletSet>,
    /// The extras refused, one per primitive.
    pub warnings: Vec<MeshletWarning>,
}

impl MeshData {
    /// A unit cube centred on the origin (side 1), four vertices per face with face normals and a
    /// full 0..1 uv square per face.
    pub fn cube() -> MeshData {
        // (normal, the face's two in-plane axes u and v with u × v = normal)
        let faces: [([f32; 3], [f32; 3], [f32; 3]); 6] = [
            ([1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]),
            ([-1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, 1.0, 0.0]),
            ([0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [1.0, 0.0, 0.0]),
            ([0.0, -1.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]),
            ([0.0, 0.0, 1.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]),
            ([0.0, 0.0, -1.0], [0.0, 1.0, 0.0], [1.0, 0.0, 0.0]),
        ];
        let mut mesh = MeshData::default();
        for (normal, u, v) in faces {
            let base = mesh.vertices.len() as u32;
            for (su, sv) in [(-0.5, -0.5), (0.5, -0.5), (0.5, 0.5), (-0.5, 0.5)] {
                let position = [0, 1, 2].map(|i| normal[i] * 0.5 + u[i] * su + v[i] * sv);
                // uv.x grows along +u and uv.y (image rows, downwards) along -v, so the tangent is
                // u and the bitangent -v = -(normal × u): handedness -1.
                let uv = [su + 0.5, 0.5 - sv];
                mesh.vertices.push(Vertex { position, normal, uv, tangent: [u[0], u[1], u[2], -1.0] });
            }
            mesh.indices.extend([base, base + 1, base + 2, base, base + 2, base + 3]);
        }
        mesh
    }

    /// A unit-radius UV sphere centred on the origin. Its trigonometry is libm's, so every target
    /// builds the same bits (std's `sin`/`cos` made the M0a web/native capture digests differ).
    pub fn sphere() -> MeshData {
        let mut mesh = MeshData::default();
        for ring in 0..=SPHERE_RINGS {
            let theta = std::f32::consts::PI * ring as f32 / SPHERE_RINGS as f32;
            let (sin_theta, cos_theta) = (libm::sinf(theta), libm::cosf(theta));
            for segment in 0..=SPHERE_SEGMENTS {
                let phi = std::f32::consts::TAU * segment as f32 / SPHERE_SEGMENTS as f32;
                let (sin_phi, cos_phi) = (libm::sinf(phi), libm::cosf(phi));
                let n = Vec3::new(sin_theta * cos_phi, cos_theta, -sin_theta * sin_phi).normalize();
                // d(position)/d(phi), the direction u grows; at the poles it falls back to any.
                let along = Vec3::new(-sin_phi, 0.0, -cos_phi);
                let tangent = (along - n * n.dot(along)).try_normalize().unwrap_or_else(|| any_tangent(n));
                let uv = [segment as f32 / SPHERE_SEGMENTS as f32, ring as f32 / SPHERE_RINGS as f32];
                mesh.vertices.push(Vertex { position: n.to_array(), normal: n.to_array(), uv, tangent: tangent.extend(1.0).to_array() });
            }
        }
        let row = SPHERE_SEGMENTS + 1;
        for ring in 0..SPHERE_RINGS {
            for segment in 0..SPHERE_SEGMENTS {
                let a = ring * row + segment;
                let b = a + row;
                mesh.indices.extend([a, b, a + 1, a + 1, b, b + 1]);
            }
        }
        mesh
    }

    /// The triangles of every mesh a GLB's default scene places (node transforms applied), or of
    /// every mesh when it has no scene. Only the embedded `BIN` buffer is read: an external or
    /// data-URI buffer, a non-triangle primitive or an empty result is refused `mesh-invalid`.
    /// A skinned mesh loads here as its bind pose (rigid); [`crate::skin::SkinnedMeshData`] keeps its skin.
    pub fn from_glb(bytes: &[u8]) -> Result<MeshData, RenderError> {
        let gltf = open_glb(bytes)?;
        let blob = gltf.blob.as_deref();
        let mut mesh = MeshData::default();
        for_each_primitive(&gltf, &mut |primitive, world| mesh.append_primitive(primitive, world, blob))?;
        if mesh.indices.is_empty() {
            return Err(invalid("the GLB has no triangles"));
        }
        Ok(mesh)
    }

    /// [`MeshData::from_glb`] and the meshlets the GLB's primitives carry in `extras.genex_meshlets`
    /// (the importer's, R2.3), validated against the mesh. A GLB without them, or with any refused,
    /// has `set: None` and the caller clusters at runtime; a refusal is also a [`MeshletWarning`].
    pub fn from_glb_with_meshlets(bytes: &[u8]) -> Result<(MeshData, GlbMeshlets), RenderError> {
        let gltf = open_glb(bytes)?;
        let blob = gltf.blob.as_deref();
        let mut mesh = MeshData::default();
        let mut merge = MeshletMerge::default();
        for_each_primitive(&gltf, &mut |primitive, world| mesh.append_with_meshlets(&gltf, primitive, world, blob, &mut merge).map(drop))?;
        if mesh.indices.is_empty() {
            return Err(invalid("the GLB has no triangles"));
        }
        Ok((mesh, merge.finish()))
    }

    /// [`MeshData::append_primitive`] that also hands the primitive's `genex_meshlets` to `merge`
    /// (a [`crate::glb_material::GlbModel`] part merges its own primitives' sets). True when the
    /// primitive's tangents were generated here (C-9: a normal-mapped primitive without TANGENT).
    pub(crate) fn append_with_meshlets(
        &mut self,
        gltf: &gltf::Gltf,
        primitive: &gltf::Primitive<'_>,
        world: Mat4,
        blob: Option<&[u8]>,
        merge: &mut MeshletMerge,
    ) -> Result<bool, RenderError> {
        let appended = self.append_placed(primitive, world, blob)?;
        merge.visit(read_meshlet_extras(gltf, primitive, blob, &appended), world, appended.base);
        Ok(appended.runtime_tangents)
    }

    /// Append one primitive's triangles placed by `world` (normals and tangents transformed).
    pub(crate) fn append_primitive(&mut self, primitive: &gltf::Primitive<'_>, world: Mat4, blob: Option<&[u8]>) -> Result<(), RenderError> {
        self.append_placed(primitive, world, blob).map(drop)
    }

    /// [`MeshData::append_primitive`], answering where the primitive landed.
    fn append_placed(&mut self, primitive: &gltf::Primitive<'_>, world: Mat4, blob: Option<&[u8]>) -> Result<AppendedPrimitive, RenderError> {
        let normal_matrix = Mat3::from_mat4(world).inverse().transpose();
        let linear = Mat3::from_mat4(world);
        let PrimitiveVertices { vertices, indices, runtime_tangents } = read_primitive_split(primitive, blob)?;
        let base = u32::try_from(self.vertices.len()).map_err(|_| invalid("too many vertices"))?;
        let vertex_count = vertices.len() as u32;
        for v in vertices {
            let n = (normal_matrix * Vec3::from(v.normal)).normalize_or(Vec3::Y);
            let t = (linear * Vec3::from([v.tangent[0], v.tangent[1], v.tangent[2]])).normalize_or(any_tangent(n));
            self.vertices.push(Vertex {
                position: world.transform_point3(Vec3::from(v.position)).to_array(),
                normal: n.to_array(),
                uv: v.uv,
                tangent: t.extend(v.tangent[3]).to_array(),
            });
        }
        self.indices.extend(indices.iter().map(|i| base + i));
        Ok(AppendedPrimitive { base, vertex_count, indices, runtime_tangents })
    }

    /// The bounding sphere: the centre of the box around the vertices and the farthest vertex.
    pub fn bounds(&self) -> ([f32; 3], f32) {
        let Some(first) = self.vertices.first() else { return ([0.0; 3], 0.0) };
        let (mut min, mut max) = (Vec3::from(first.position), Vec3::from(first.position));
        for v in &self.vertices {
            min = min.min(Vec3::from(v.position));
            max = max.max(Vec3::from(v.position));
        }
        let center = (min + max) * 0.5;
        let radius = self.vertices.iter().map(|v| Vec3::from(v.position).distance(center)).fold(0.0_f32, f32::max);
        (center.to_array(), radius)
    }
}

/// One primitive as [`MeshData::append_primitive`] placed it: where its vertices start in the mesh
/// and its own (primitive-local) triangle list, which its `genex_meshlets` are checked against.
struct AppendedPrimitive {
    base: u32,
    vertex_count: u32,
    indices: Vec<u32>,
    /// Its tangents were generated here ([`PrimitiveVertices::runtime_tangents`]).
    runtime_tangents: bool,
}

/// What one primitive's `extras.genex_meshlets` gave.
enum PrimitiveMeshlets {
    /// No such member: the importer did not cluster this primitive.
    Absent,
    /// A set that passed [`validate`], in the primitive's own space and vertex ids.
    Valid(MeshletSet),
    /// A set refused; the mesh is clustered at runtime.
    Refused(MeshletFault),
}

/// A meshlet record's numbers are usable: finite, a radius of at least 0, a cone cutoff in -1..=1.
fn record_is_sane(meshlet: &GpuMeshlet) -> bool {
    let finite = meshlet.bounds.iter().chain(&meshlet.cone).all(|value| value.is_finite());
    finite && meshlet.bounds[3] >= 0.0 && (-1.0..=1.0).contains(&meshlet.cone[3])
}

/// The bytes of buffer view `extras[key]` inside the embedded buffer.
fn extras_view<'a>(gltf: &'a gltf::Gltf, blob: Option<&'a [u8]>, extras: &gltf::json::Value, key: MeshletExtrasKey) -> Result<&'a [u8], MeshletFault> {
    let at = extras.get(key.wire()).and_then(gltf::json::Value::as_u64).ok_or(MeshletFault::RangeOutOfBounds)?;
    let view = usize::try_from(at).ok().and_then(|at| gltf.views().nth(at)).ok_or(MeshletFault::RangeOutOfBounds)?;
    let range = view.offset()..view.offset().saturating_add(view.length());
    blob.and_then(|blob| blob.get(range)).ok_or(MeshletFault::RangeOutOfBounds)
}

/// One limit of the extras (`max_vertices`, `max_triangles`): present and from 1 to the build's.
fn within_limit(extras: &gltf::json::Value, key: MeshletExtrasKey, most: u32) -> Result<(), MeshletFault> {
    match extras.get(key.wire()).and_then(gltf::json::Value::as_u64) {
        Some(limit) if (1..=u64::from(most)).contains(&limit) => Ok(()),
        _ => Err(MeshletFault::OverLimit),
    }
}

/// The set an extras object names: its version and limits, its three views read as little-endian
/// words and records, every number checked, then the set against the primitive's triangles.
fn decode_meshlet_extras(gltf: &gltf::Gltf, blob: Option<&[u8]>, extras: &gltf::json::Value, appended: &AppendedPrimitive) -> Result<MeshletSet, MeshletFault> {
    if !extras.is_object() {
        return Err(MeshletFault::RangeOutOfBounds);
    }
    if extras.get(MeshletExtrasKey::Version.wire()).and_then(gltf::json::Value::as_u64) != Some(u64::from(MESHLET_SCHEMA_VERSION)) {
        return Err(MeshletFault::UnknownVersion);
    }
    within_limit(extras, MeshletExtrasKey::MaxVertices, MESHLET_MAX_VERTICES)?;
    within_limit(extras, MeshletExtrasKey::MaxTriangles, MESHLET_MAX_TRIANGLES)?;
    let records = extras_view(gltf, blob, extras, MeshletExtrasKey::Meshlets)?;
    let vertices = extras_view(gltf, blob, extras, MeshletExtrasKey::Vertices)?;
    let triangles = extras_view(gltf, blob, extras, MeshletExtrasKey::Triangles)?;
    let whole = records.len().is_multiple_of(MESHLET_RECORD_BYTES as usize) && vertices.len().is_multiple_of(4) && triangles.len().is_multiple_of(4);
    if !whole {
        return Err(MeshletFault::RangeOutOfBounds);
    }
    let words = |bytes: &[u8]| bytes.as_chunks::<4>().0.iter().map(|word| u32::from_le_bytes(*word)).collect::<Vec<u32>>();
    // Records are plain little-endian f32 and u32 fields, the layout every destination (all
    // little-endian) shares; they are read unaligned because a view's offset is only 4-aligned.
    let meshlets: Vec<GpuMeshlet> = records.as_chunks::<{ size_of::<GpuMeshlet>() }>().0.iter().map(|record| bytemuck::pod_read_unaligned(record)).collect();
    if !meshlets.iter().all(record_is_sane) {
        return Err(MeshletFault::RangeOutOfBounds);
    }
    let set = MeshletSet { meshlets, vertices: words(vertices), triangles: words(triangles) };
    validate(&set, &appended.indices, appended.vertex_count)?;
    Ok(set)
}

/// Read and validate a primitive's `genex_meshlets` against its triangles. Extras that are not an
/// object, or have no such member, are not ours ([`PrimitiveMeshlets::Absent`]); a member that is
/// there but wrong is refused with its [`MeshletFault`] (a view that is missing, out of the buffer,
/// not whole records or words, or a record with a non-finite number is `RangeOutOfBounds`).
fn read_meshlet_extras(gltf: &gltf::Gltf, primitive: &gltf::Primitive<'_>, blob: Option<&[u8]>, appended: &AppendedPrimitive) -> PrimitiveMeshlets {
    let Some(raw) = primitive.extras() else { return PrimitiveMeshlets::Absent };
    let Ok(value) = gltf::json::deserialize::from_str::<gltf::json::Value>(raw.get()) else { return PrimitiveMeshlets::Absent };
    let Some(extras) = value.get(MESHLETS_EXTRAS_KEY) else { return PrimitiveMeshlets::Absent };
    match decode_meshlet_extras(gltf, blob, extras, appended) {
        Ok(set) => PrimitiveMeshlets::Valid(set),
        Err(fault) => PrimitiveMeshlets::Refused(fault),
    }
}

/// The relation of a node's matrix to a rotation and one uniform scale, which a normal cone needs.
struct Placement {
    /// The matrix's scale when it is a rotation, a translation and one uniform positive scale.
    similarity: Option<f32>,
    /// A radius factor that holds any matrix: the Frobenius norm of its linear part.
    bound: f32,
}

impl Placement {
    fn of(world: Mat4) -> Placement {
        let linear = Mat3::from_mat4(world);
        let lengths = [linear.x_axis.length(), linear.y_axis.length(), linear.z_axis.length()];
        let (most, least) = (lengths.into_iter().fold(0.0_f32, f32::max), lengths.into_iter().fold(f32::INFINITY, f32::min));
        let uniform = most > 0.0 && most - least <= 1e-4 * most;
        Placement {
            similarity: (uniform && linear.determinant() > 0.0).then_some(most),
            bound: lengths.iter().map(|length| length * length).sum::<f32>().sqrt(),
        }
    }
}

/// `set` (a primitive's, in its own space) placed by `world`: bounds spheres move and grow with the
/// matrix; a cone survives only a rotation and uniform scale and is dropped (cutoff 1) otherwise.
fn place_meshlets(set: &mut MeshletSet, world: Mat4) {
    let placement = Placement::of(world);
    let linear = Mat3::from_mat4(world);
    for meshlet in &mut set.meshlets {
        let centre = world.transform_point3(Vec3::new(meshlet.bounds[0], meshlet.bounds[1], meshlet.bounds[2]));
        let radius = meshlet.bounds[3] * placement.similarity.unwrap_or(placement.bound);
        meshlet.bounds = [centre.x, centre.y, centre.z, radius];
        let axis = Vec3::new(meshlet.cone[0], meshlet.cone[1], meshlet.cone[2]);
        meshlet.cone = match placement.similarity.and_then(|_| (linear * axis).try_normalize()) {
            Some(rotated) => [rotated.x, rotated.y, rotated.z, meshlet.cone[3]],
            None if placement.similarity.is_some() => meshlet.cone,
            None => [0.0, 0.0, 1.0, 1.0],
        };
    }
}

/// The primitives' meshlets gathered into the one mesh [`MeshData::from_glb`] builds.
#[derive(Default)]
pub(crate) struct MeshletMerge {
    library: MeshletLibrary,
    /// Every primitive visited so far had a valid set.
    complete: bool,
    started: bool,
    visited: usize,
    warnings: Vec<MeshletWarning>,
}

impl MeshletMerge {
    fn visit(&mut self, found: PrimitiveMeshlets, world: Mat4, base: u32) {
        if !self.started {
            (self.started, self.complete) = (true, true);
        }
        match found {
            PrimitiveMeshlets::Absent => self.complete = false,
            PrimitiveMeshlets::Refused(fault) => {
                self.complete = false;
                log::warn!("glb meshlets: primitive {} refused ({}); the mesh is clustered at runtime", self.visited, fault.wire());
                self.warnings.push(MeshletWarning { primitive: self.visited, fault });
            }
            PrimitiveMeshlets::Valid(mut set) => {
                place_meshlets(&mut set, world);
                self.library.append(&set, base);
            }
        }
        self.visited += 1;
    }

    /// The merged set when every primitive had one, with the warnings of those refused.
    pub(crate) fn finish(self) -> GlbMeshlets {
        let usable = self.complete && !self.library.meshlets.is_empty();
        let set = usable.then_some(MeshletSet { meshlets: self.library.meshlets, vertices: self.library.vertices, triangles: self.library.triangles });
        GlbMeshlets { set, warnings: self.warnings }
    }
}

/// A parsed GLB whose buffers are all the embedded `BIN` chunk. The GLB guard runs first: `gltf`
/// 1.4.1 panics on damaged input (gltf-rs #478) and wasm aborts on a panic (game systems SF-1b).
pub(crate) fn open_glb(bytes: &[u8]) -> Result<gltf::Gltf, RenderError> {
    genex_core::glb_guard::check_glb(bytes).map_err(|refusal| invalid(format!("not a valid GLB: {refusal}")))?;
    let gltf = gltf::Gltf::from_slice(bytes).map_err(|error| invalid(format!("not a valid GLB: {error}")))?;
    if let Some(uri) = gltf.buffers().find_map(|b| match b.source() {
        gltf::buffer::Source::Uri(uri) => Some(uri.to_owned()),
        gltf::buffer::Source::Bin => None,
    }) {
        return Err(invalid(format!("buffer {uri:?} is not embedded")));
    }
    Ok(gltf)
}

/// Visit every primitive of every mesh a GLB's default scene places (or its first scene), with
/// the node's world transform, in node order; with no scene, every mesh's untransformed.
pub(crate) fn for_each_primitive(
    gltf: &gltf::Gltf,
    visit: &mut impl FnMut(&gltf::Primitive<'_>, Mat4) -> Result<(), RenderError>,
) -> Result<(), RenderError> {
    match gltf.default_scene().or_else(|| gltf.scenes().next()) {
        Some(scene) => scene.nodes().try_for_each(|node| visit_node(&node, Mat4::IDENTITY, visit)),
        None => gltf.meshes().flat_map(|mesh| mesh.primitives().collect::<Vec<_>>()).try_for_each(|p| visit(&p, Mat4::IDENTITY)),
    }
}

fn visit_node(
    node: &gltf::Node<'_>,
    parent: Mat4,
    visit: &mut impl FnMut(&gltf::Primitive<'_>, Mat4) -> Result<(), RenderError>,
) -> Result<(), RenderError> {
    let world = parent * Mat4::from_cols_array_2d(&node.transform().matrix());
    if let Some(gltf_mesh) = node.mesh() {
        gltf_mesh.primitives().try_for_each(|primitive| visit(&primitive, world))?;
    }
    node.children().try_for_each(|child| visit_node(&child, world, visit))
}

/// One accessor layout the `gltf` reader decodes: component type, element type, `normalized`.
type AccessorLayout = (gltf::accessor::DataType, gltf::accessor::Dimensions, bool);

/// The layouts core glTF 2.0 gives each attribute this loader and the skin loader read: anything
/// else (a `KHR_mesh_quantization` attribute, which the import step dequantizes, or a damaged
/// file) would be misread or panic inside the reader (gltf-rs #478), so it is refused first.
fn allowed_layouts(semantic: &gltf::Semantic) -> &'static [AccessorLayout] {
    use gltf::Semantic;
    use gltf::accessor::{DataType::*, Dimensions::*};
    const VEC3: &[AccessorLayout] = &[(F32, Vec3, false)];
    const TANGENT: &[AccessorLayout] = &[(F32, Vec4, false)];
    const UV: &[AccessorLayout] = &[(F32, Vec2, false), (U8, Vec2, true), (U16, Vec2, true)];
    const JOINTS: &[AccessorLayout] = &[(U8, Vec4, false), (U16, Vec4, false)];
    const WEIGHTS: &[AccessorLayout] = &[(F32, Vec4, false), (U8, Vec4, true), (U16, Vec4, true)];
    match semantic {
        Semantic::Positions | Semantic::Normals => VEC3,
        Semantic::Tangents => TANGENT,
        Semantic::TexCoords(_) => UV,
        Semantic::Joints(_) => JOINTS,
        Semantic::Weights(_) => WEIGHTS,
        _ => &[],
    }
}

/// Refused `mesh-invalid` unless `primitive`'s `semantic` attribute, when present, has a layout
/// [`allowed_layouts`] lists.
pub(crate) fn check_attribute_layout(primitive: &gltf::Primitive<'_>, semantic: &gltf::Semantic) -> Result<(), RenderError> {
    let Some(accessor) = primitive.get(semantic) else { return Ok(()) };
    let layout = (accessor.data_type(), accessor.dimensions(), accessor.normalized());
    if allowed_layouts(semantic).contains(&layout) {
        return Ok(());
    }
    Err(invalid(format!(
        "{} is {:?} {:?}{}: not a layout glTF gives it (a quantized mesh is dequantized at import)",
        semantic.to_string(),
        layout.0,
        layout.1,
        if layout.2 { " normalized" } else { "" }
    )))
}

/// The indices' layout: one unsigned integer each.
fn check_index_layout(primitive: &gltf::Primitive<'_>) -> Result<(), RenderError> {
    use gltf::accessor::DataType;
    let Some(accessor) = primitive.indices() else { return Ok(()) };
    let unsigned = matches!(accessor.data_type(), DataType::U8 | DataType::U16 | DataType::U32);
    if unsigned && accessor.dimensions() == gltf::accessor::Dimensions::Scalar && !accessor.normalized() {
        return Ok(());
    }
    Err(invalid(format!("indices are {:?} {:?}: not a layout glTF gives them", accessor.data_type(), accessor.dimensions())))
}

/// One triangle primitive's attributes in its own space and its indices from 0, before any
/// tangent is generated: POSITION required, NORMAL from the faces when absent, TEXCOORD_0 zero when
/// absent, TANGENT as stored (None when absent). Each is read only after its layout is one glTF
/// gives it ([`check_attribute_layout`]).
struct PrimitiveAttributes {
    positions: Vec<[f32; 3]>,
    normals: Vec<[f32; 3]>,
    uvs: Vec<[f32; 2]>,
    tangents: Option<Vec<[f32; 4]>>,
    indices: Vec<u32>,
}

impl PrimitiveAttributes {
    fn read(primitive: &gltf::Primitive<'_>, blob: Option<&[u8]>) -> Result<PrimitiveAttributes, RenderError> {
        if primitive.mode() != gltf::mesh::Mode::Triangles {
            return Err(invalid(format!("primitive mode {:?} is not triangles", primitive.mode())));
        }
        for semantic in [gltf::Semantic::Positions, gltf::Semantic::Normals, gltf::Semantic::TexCoords(0), gltf::Semantic::Tangents] {
            check_attribute_layout(primitive, &semantic)?;
        }
        check_index_layout(primitive)?;
        let reader = primitive.reader(|_| blob);
        let positions: Vec<[f32; 3]> = reader.read_positions().ok_or_else(|| invalid("a primitive has no readable POSITION"))?.collect();
        let count = positions.len() as u32;
        let indices: Vec<u32> = match reader.read_indices() {
            Some(indices) => indices.into_u32().collect(),
            None => (0..count).collect(),
        };
        if !indices.len().is_multiple_of(3) || indices.iter().any(|&i| i >= count) {
            return Err(invalid("indices are not whole triangles inside the vertex range"));
        }
        let normals: Vec<[f32; 3]> = match reader.read_normals() {
            Some(normals) => normals.collect(),
            None => face_normals(&positions, &indices),
        };
        let uvs: Vec<[f32; 2]> = match reader.read_tex_coords(0) {
            Some(uvs) => uvs.into_f32().collect(),
            None => vec![[0.0, 0.0]; positions.len()],
        };
        if normals.len() != positions.len() || uvs.len() != positions.len() {
            return Err(invalid("NORMAL or TEXCOORD_0 and POSITION counts differ"));
        }
        let tangents: Option<Vec<[f32; 4]>> = reader.read_tangents().map(Iterator::collect);
        if tangents.as_ref().is_some_and(|tangents| tangents.len() != positions.len()) {
            return Err(invalid("TANGENT and POSITION counts differ"));
        }
        Ok(PrimitiveAttributes { positions, normals, uvs, tangents, indices })
    }

    /// The vertices with `tangents`, one per vertex in order; vertex `count + i` copies vertex `copies[i]`.
    fn vertices(&self, tangents: &[[f32; 4]], copies: &[u32]) -> Vec<Vertex> {
        let sources = (0..self.positions.len() as u32).chain(copies.iter().copied());
        sources
            .zip(tangents)
            .map(|(source, tangent)| {
                let i = source as usize;
                Vertex { position: self.positions[i], normal: self.normals[i], uv: self.uvs[i], tangent: *tangent }
            })
            .collect()
    }
}

/// One primitive as [`read_primitive_split`] reads it.
pub(crate) struct PrimitiveVertices {
    /// Its vertices: the primitive's own, then the copies a mirrored seam split off (each a copy of
    /// the vertex [`split_by_tangent`] names).
    pub(crate) vertices: Vec<Vertex>,
    /// Three per triangle, from 0.
    pub(crate) indices: Vec<u32>,
    /// The primitive is normal-mapped and had no TANGENT, so MikkTSpace ran here (C-9): what the
    /// Studio's import step writes was not there (`tangents-runtime`).
    pub(crate) runtime_tangents: bool,
}

/// Whether the primitive's material samples a normal map on TEXCOORD_0, the uv set a vertex
/// carries (the import step's rule for writing TANGENT, C-8).
fn is_normal_mapped(primitive: &gltf::Primitive<'_>) -> bool {
    primitive.material().normal_texture().is_some_and(|normal| normal.tex_coord() == 0)
}

/// One triangle primitive's vertices in its own space and its indices from 0 ([`PrimitiveAttributes`]).
/// A normal-mapped primitive without TANGENT gets MikkTSpace tangents ([`mikk_corner_tangents`]),
/// and a vertex whose corners disagree becomes one vertex per distinct tangent, as the import step
/// splits it; any other primitive without TANGENT keeps one vertex per POSITION, each with its first
/// corner's tangent, so extras indexing its vertices (meshlets, LODs) stay valid.
pub(crate) fn read_primitive_split(primitive: &gltf::Primitive<'_>, blob: Option<&[u8]>) -> Result<PrimitiveVertices, RenderError> {
    let attributes = PrimitiveAttributes::read(primitive, blob)?;
    if let Some(tangents) = &attributes.tangents {
        let vertices = attributes.vertices(tangents, &[]);
        return Ok(PrimitiveVertices { vertices, indices: attributes.indices, runtime_tangents: false });
    }
    let corners = mikk_corner_tangents(&attributes);
    let split = split_by_tangent(&attributes.indices, &corners, attributes.positions.len());
    if is_normal_mapped(primitive) {
        let vertices = attributes.vertices(&split.tangents, &split.copies);
        return Ok(PrimitiveVertices { vertices, indices: split.indices, runtime_tangents: true });
    }
    let vertices = attributes.vertices(&split.tangents[..attributes.positions.len()], &[]);
    Ok(PrimitiveVertices { vertices, indices: attributes.indices, runtime_tangents: false })
}

/// One triangle primitive's vertices, one per POSITION, and its indices from 0: a primitive without
/// TANGENT gives each vertex its first corner's MikkTSpace tangent (a mirrored seam is not split:
/// the skinned loader keeps JOINTS and WEIGHTS one per POSITION).
pub(crate) fn read_primitive(primitive: &gltf::Primitive<'_>, blob: Option<&[u8]>) -> Result<(Vec<Vertex>, Vec<u32>), RenderError> {
    let attributes = PrimitiveAttributes::read(primitive, blob)?;
    let vertices = match &attributes.tangents {
        Some(tangents) => attributes.vertices(tangents, &[]),
        None => {
            let corners = mikk_corner_tangents(&attributes);
            let split = split_by_tangent(&attributes.indices, &corners, attributes.positions.len());
            attributes.vertices(&split.tangents[..attributes.positions.len()], &[])
        }
    };
    Ok((vertices, attributes.indices))
}

/// Area-weighted vertex normals from the triangles, for a primitive without NORMAL.
fn face_normals(positions: &[[f32; 3]], indices: &[u32]) -> Vec<[f32; 3]> {
    let mut sums = vec![Vec3::ZERO; positions.len()];
    for tri in indices.as_chunks::<3>().0 {
        let [a, b, c] = tri.map(|i| Vec3::from(positions[i as usize]));
        let n = (b - a).cross(c - a);
        for &i in tri {
            sums[i as usize] += n;
        }
    }
    sums.into_iter().map(|n| n.normalize_or(Vec3::Y).to_array()).collect()
}

/// MikkTSpace's sqrt and acos from libm (the f64 acos the reference implementation uses), so the
/// fallback builds the same bits on every target (`clippy.toml`).
struct LibmOps;

impl bevy_mikktspace::Ops for LibmOps {
    fn sqrt(x: f32) -> f32 {
        libm::sqrtf(x)
    }

    fn acos(x: f32) -> f32 {
        libm::acos(f64::from(x)) as f32
    }
}

/// A primitive's triangles as MikkTSpace reads them, and the tangent it answers for each corner.
struct MikkGeometry<'a> {
    attributes: &'a PrimitiveAttributes,
    corners: Vec<[f32; 4]>,
}

impl MikkGeometry<'_> {
    fn vertex(&self, face: usize, vert: usize) -> usize {
        self.attributes.indices[face * 3 + vert] as usize
    }
}

impl bevy_mikktspace::Geometry<LibmOps> for MikkGeometry<'_> {
    fn num_faces(&self) -> usize {
        self.attributes.indices.len() / 3
    }

    fn num_vertices_of_face(&self, _face: usize) -> usize {
        3
    }

    fn position(&self, face: usize, vert: usize) -> [f32; 3] {
        self.attributes.positions[self.vertex(face, vert)]
    }

    fn normal(&self, face: usize, vert: usize) -> [f32; 3] {
        self.attributes.normals[self.vertex(face, vert)]
    }

    fn tex_coord(&self, face: usize, vert: usize) -> [f32; 2] {
        self.attributes.uvs[self.vertex(face, vert)]
    }

    fn set_tangent(&mut self, tangent_space: Option<bevy_mikktspace::TangentSpace>, face: usize, vert: usize) {
        // A degenerate corner MikkTSpace answers nothing for gets any tangent orthogonal to its normal.
        let tangent = match tangent_space {
            Some(space) => space.tangent_encoded(),
            None => any_tangent(Vec3::from(self.normal(face, vert)).normalize_or(Vec3::Y)).extend(1.0).to_array(),
        };
        self.corners[face * 3 + vert] = tangent;
    }
}

/// The MikkTSpace tangent of every corner (xyz unit, w the bitangent's sign), three per triangle:
/// the space the Studio's import step writes with meshoptimizer's `generateTangents(Compatible)`
/// (C-8), so a baked normal map shades the same with or without the import (C-9).
fn mikk_corner_tangents(attributes: &PrimitiveAttributes) -> Vec<[f32; 4]> {
    let mut geometry = MikkGeometry { attributes, corners: vec![[1.0, 0.0, 0.0, 1.0]; attributes.indices.len()] };
    // Its error type has no variant: generation cannot fail.
    if let Err(error) = bevy_mikktspace::generate_tangents(&mut geometry) {
        log::warn!("mikktspace: {error}");
    }
    geometry.corners
}

/// A primitive's vertices split by corner tangent ([`split_by_tangent`]).
struct TangentSplit {
    /// One tangent per vertex: the primitive's own, then the copies.
    tangents: Vec<[f32; 4]>,
    /// The corners' vertices.
    indices: Vec<u32>,
    /// For each copy, the vertex it copies.
    copies: Vec<u32>,
}

/// One vertex per distinct (vertex, tangent): a vertex keeps its index for its first corner's
/// tangent, and each other tangent its corners have becomes a copy after the vertices, in corner
/// order. Tangents compare bit for bit. The import step's rule (`tangents.ts`, `splitByTangent`).
/// A vertex no corner uses keeps +x, right-handed.
fn split_by_tangent(indices: &[u32], corners: &[[f32; 4]], vertex_count: usize) -> TangentSplit {
    let bits = |tangent: &[f32; 4]| tangent.map(f32::to_bits);
    let mut tangents: Vec<[f32; 4]> = vec![[1.0, 0.0, 0.0, 1.0]; vertex_count];
    let mut kept: Vec<Option<[u32; 4]>> = vec![None; vertex_count];
    // The copies made so far, by (source vertex, tangent bits), in creation order.
    let mut made: std::collections::BTreeMap<(u32, [u32; 4]), u32> = std::collections::BTreeMap::new();
    let mut copies = Vec::new();
    let mut split = Vec::with_capacity(indices.len());
    for (&vertex, tangent) in indices.iter().zip(corners) {
        let key = bits(tangent);
        let slot = &mut kept[vertex as usize];
        match slot {
            None => {
                *slot = Some(key);
                tangents[vertex as usize] = *tangent;
                split.push(vertex);
            }
            Some(first) if *first == key => split.push(vertex),
            Some(_) => {
                let next = (vertex_count + copies.len()) as u32;
                let copy = *made.entry((vertex, key)).or_insert(next);
                if copy == next {
                    copies.push(vertex);
                    tangents.push(*tangent);
                }
                split.push(copy);
            }
        }
    }
    TangentSplit { tangents, indices: split, copies }
}
