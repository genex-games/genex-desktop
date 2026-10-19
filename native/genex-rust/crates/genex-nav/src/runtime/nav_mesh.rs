//! Navigation meshes: convex polygons with type indices and an optional height mesh, validated
//! into a mesh with connectivity, boundary edges, regions and bounds, plus point and edge
//! sampling.
//!
//! Ported from landmass 0.9.3 `src/nav_mesh.rs` (MIT OR Apache-2.0, used under Apache 2.0).
//! Changed:
//! - P1: the edge connectivity table is a `Map` (insertion order), so `boundary_edges` comes out
//!   in polygon-then-edge order on every run (upstream's order is "undefined": a `HashMap`'s);
//!   the region renumbering is a `Map`; upstream's unused type-index set is dropped.
//! - P4: `disjoint::DisjointSet` is [`super::disjoint::DisjointSet`].
//! - The errors implement `Display` by hand (no `thiserror` in this crate); same messages.
//! - `sample_point_on_node` returns the polygon's first-triangle projection instead of panicking
//!   when floating-point error leaves the point just outside every triangle.

use core::cmp::Ordering;
use core::marker::PhantomData;
use core::ops::Range;

use genex_core::map::Map;
use glam::{Vec3, Vec3Swizzles};

use super::coords::{CoordinateSystem, CorePointSampleDistance};
use super::disjoint::DisjointSet;
use super::geometry::clip_edge_to_triangle;
use super::util::{BoundingBox, BoundingBoxHierarchy, FloatOrd, RaySegment};

/// A navigation mesh, as a bake or a caller hands it over.
pub struct NavigationMesh<CS: CoordinateSystem> {
    /// The vertices that make up the polygons.
    pub vertices: Vec<CS::Coordinate>,
    /// The polygons: indices into `vertices`, convex, counter-clockwise (right-hand rule), not
    /// self-intersecting.
    pub polygons: Vec<Vec<usize>>,
    /// The type index of each polygon (as long as `polygons`).
    pub polygon_type_indices: Vec<usize>,
    /// An optional finer mesh for the true surface height; see [`HeightNavigationMesh`].
    pub height_mesh: Option<HeightNavigationMesh<CS>>,
}

/// A finer triangle mesh that "refines" the height of a point, so an agent on the real ground is
/// found on the right (coarse) polygon. Paths still use the coarse polygons.
pub struct HeightNavigationMesh<CS: CoordinateSystem> {
    /// One height polygon per [`NavigationMesh::polygons`] entry.
    pub polygons: Vec<HeightPolygon>,
    /// The pool of vertices the triangles use.
    pub vertices: Vec<CS::Coordinate>,
    /// The triangles, counter-clockwise, indices relative to [`HeightPolygon::base_vertex_index`].
    pub triangles: Vec<[u8; 3]>,
}

/// The height-mesh triangles of one polygon.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HeightPolygon {
    /// The first vertex in [`HeightNavigationMesh::vertices`] these triangles use.
    pub base_vertex_index: u32,
    /// How many vertices from `base_vertex_index` on the triangles may use.
    pub vertex_count: u32,
    /// The first triangle in [`HeightNavigationMesh::triangles`].
    pub base_triangle_index: u32,
    /// How many triangles from `base_triangle_index` on make up this polygon.
    pub triangle_count: u32,
}

impl<CS: CoordinateSystem> Clone for NavigationMesh<CS> {
    fn clone(&self) -> Self {
        Self {
            vertices: self.vertices.clone(),
            polygons: self.polygons.clone(),
            polygon_type_indices: self.polygon_type_indices.clone(),
            height_mesh: self.height_mesh.clone(),
        }
    }
}

impl<CS: CoordinateSystem> Clone for HeightNavigationMesh<CS> {
    fn clone(&self) -> Self {
        Self { polygons: self.polygons.clone(), vertices: self.vertices.clone(), triangles: self.triangles.clone() }
    }
}

impl HeightPolygon {
    /// The range of this polygon's triangles.
    pub(crate) fn triangle_range(&self) -> Range<usize> {
        (self.base_triangle_index as usize)..(self.base_triangle_index as usize + self.triangle_count as usize)
    }

    /// A triangle's local vertex index as an index into the vertex pool.
    pub(crate) fn vertex(&self, local: u8) -> usize {
        self.base_vertex_index as usize + local as usize
    }
}

/// Why a navigation mesh failed validation.
#[derive(Debug, Copy, Clone, PartialEq, Eq)]
pub enum ValidationError {
    /// The number of polygons and the number of type indices.
    TypeIndicesHaveWrongLength(usize, usize),
    /// The index of a concave or clockwise polygon.
    ConcavePolygon(usize),
    /// The index of a polygon with fewer than 3 vertices.
    NotEnoughVerticesInPolygon(usize),
    /// The index of a polygon naming a vertex out of bounds.
    InvalidVertexIndexInPolygon(usize),
    /// The index of a polygon with a zero-length edge.
    DegenerateEdgeInPolygon(usize),
    /// The two vertices of an edge more than two polygons share.
    DoublyConnectedEdge(usize, usize),
    /// The height mesh is invalid.
    HeightMeshError(ValidateHeightMeshError),
}

impl core::fmt::Display for ValidationError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::TypeIndicesHaveWrongLength(polygons, indices) => write!(
                f,
                "The polygon type indices do not have the same length as the polygons. There are {polygons} polygons, but {indices} type indices."
            ),
            Self::ConcavePolygon(i) => write!(f, "The polygon at index {i} is concave or has edges in clockwise order."),
            Self::NotEnoughVerticesInPolygon(i) => write!(f, "The polygon at index {i} does not have at least 3 vertices."),
            Self::InvalidVertexIndexInPolygon(i) => write!(f, "The polygon at index {i} references an out-of-bounds vertex."),
            Self::DegenerateEdgeInPolygon(i) => {
                write!(f, "The polygon at index {i} contains a degenerate edge (an edge with zero length).")
            }
            Self::DoublyConnectedEdge(a, b) => {
                write!(f, "The edge made from vertices {a} and {b} is used by more than two polygons.")
            }
            Self::HeightMeshError(error) => write!(f, "{error}"),
        }
    }
}

impl core::error::Error for ValidationError {}

impl From<ValidateHeightMeshError> for ValidationError {
    fn from(error: ValidateHeightMeshError) -> Self {
        Self::HeightMeshError(error)
    }
}

/// Why a height mesh failed validation.
#[derive(Debug, Copy, Clone, PartialEq, Eq)]
pub enum ValidateHeightMeshError {
    /// The number of polygons in the regular mesh and in the height mesh.
    IncorrectNumberOfPolygons(usize, usize),
    /// The index of a height polygon whose triangle range is out of bounds.
    InvalidPolygonIndices(usize),
    /// A triangle naming a vertex out of range.
    InvalidIndexInTriangle {
        /// The triangle's index.
        triangle: u32,
        /// The vertex index it names.
        vertex: usize,
    },
    /// The index of a polygon with a clockwise triangle.
    ClockwiseTriangle(usize),
}

impl core::fmt::Display for ValidateHeightMeshError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::IncorrectNumberOfPolygons(regular, height) => write!(
                f,
                "The height mesh contains a different number of polygons ({height}) than the regular mesh, which has {regular}"
            ),
            Self::InvalidPolygonIndices(i) => write!(f, "The polygon at index {i} in the height mesh contains out of range indices"),
            Self::InvalidIndexInTriangle { triangle, vertex } => write!(
                f,
                "The triangle at index {triangle} in the height mesh contains an out of range vertex index {vertex}"
            ),
            Self::ClockwiseTriangle(i) => {
                write!(f, "The triangle at index {i} in the height mesh is clockwise instead of counter-clockwise")
            }
        }
    }
}

impl core::error::Error for ValidateHeightMeshError {}

/// How an edge is shared while validating.
enum ConnectivityState {
    Boundary { polygon: usize, edge: usize },
    Connected { polygon_1: usize, edge_1: usize, polygon_2: usize, edge_2: usize },
}

/// Whether the corner at `center` (between `left` and `right`, counter-clockwise) is convex.
fn is_convex_corner(left: Vec3, center: Vec3, right: Vec3) -> bool {
    let left_edge = left.xy() - center.xy();
    let right_edge = right.xy() - center.xy();
    match right_edge.perp_dot(left_edge).partial_cmp(&0.0) {
        Some(Ordering::Greater) => true,
        // Parallel and pointing opposite ways: a straight corner.
        Some(Ordering::Equal) => right_edge.dot(left_edge) < 0.0,
        _ => false,
    }
}

impl<CS: CoordinateSystem> NavigationMesh<CS> {
    /// Checks the mesh's invariants and derives connectivity, boundary edges, regions and bounds.
    ///
    /// # Errors
    ///
    /// The first [`ValidationError`] found.
    pub fn validate(mut self) -> Result<ValidNavigationMesh<CS>, ValidationError> {
        if self.polygons.len() != self.polygon_type_indices.len() {
            return Err(ValidationError::TypeIndicesHaveWrongLength(self.polygons.len(), self.polygon_type_indices.len()));
        }

        let height_mesh = match self.height_mesh {
            None => None,
            Some(height_mesh) => Some(height_mesh.validate(self.polygons.len())?),
        };

        let vertices = self.vertices.iter().map(CS::to_landmass).collect::<Vec<_>>();

        // The height mesh gives tighter bounds when there is one.
        let mesh_bounds = height_mesh
            .as_ref()
            .map_or(&vertices, |height_mesh| &height_mesh.vertices)
            .iter()
            .fold(BoundingBox::Empty, |acc, &vertex| acc.expand_to_point(vertex));

        let mut region_sets = DisjointSet::with_len(self.polygons.len());
        let mut connectivity_set: Map<(usize, usize), ConnectivityState> = Map::default();

        for (polygon_index, polygon) in self.polygons.iter_mut().enumerate() {
            if polygon.len() < 3 {
                return Err(ValidationError::NotEnoughVerticesInPolygon(polygon_index));
            }
            if CS::FLIP_POLYGONS {
                polygon.reverse();
            }
            if polygon.iter().any(|&vertex_index| vertex_index >= vertices.len()) {
                return Err(ValidationError::InvalidVertexIndexInPolygon(polygon_index));
            }

            for i in 0..polygon.len() {
                let left_vertex = polygon[if i == 0 { polygon.len() - 1 } else { i - 1 }];
                let center_vertex = polygon[i];
                let right_vertex = polygon[if i == polygon.len() - 1 { 0 } else { i + 1 }];

                let edge = if center_vertex < right_vertex {
                    (center_vertex, right_vertex)
                } else {
                    (right_vertex, center_vertex)
                };
                if edge.0 == edge.1 {
                    return Err(ValidationError::DegenerateEdgeInPolygon(polygon_index));
                }

                match connectivity_set.get_mut(&edge) {
                    None => {
                        connectivity_set.insert(edge, ConnectivityState::Boundary { polygon: polygon_index, edge: i });
                    }
                    Some(state) => match *state {
                        ConnectivityState::Boundary { polygon: polygon_1, edge: edge_1 } => {
                            *state = ConnectivityState::Connected {
                                polygon_1,
                                edge_1,
                                polygon_2: polygon_index,
                                edge_2: i,
                            };
                            region_sets.join(polygon_1, polygon_index);
                        }
                        ConnectivityState::Connected { .. } => {
                            return Err(ValidationError::DoublyConnectedEdge(edge.0, edge.1));
                        }
                    },
                }

                if !is_convex_corner(vertices[left_vertex], vertices[center_vertex], vertices[right_vertex]) {
                    return Err(ValidationError::ConcavePolygon(polygon_index));
                }
            }
        }

        let mut region_to_normalized_region: Map<usize, usize> = Map::default();
        let mut polygons = Vec::with_capacity(self.polygons.len());
        for (polygon_index, polygon_vertices) in self.polygons.drain(..).enumerate() {
            // Bounds from the height mesh when there is one, so sampling never misses its triangles.
            let bounds = if let Some(height_mesh) = height_mesh.as_ref() {
                let polygon = &height_mesh.polygons[polygon_index];
                (polygon.base_vertex_index..(polygon.base_vertex_index + polygon.vertex_count))
                    .fold(BoundingBox::Empty, |bounds, vertex| bounds.expand_to_point(height_mesh.vertices[vertex as usize]))
            } else {
                polygon_vertices.iter().fold(BoundingBox::Empty, |bounds, vertex| bounds.expand_to_point(vertices[*vertex]))
            };
            let root = region_sets.root_of(polygon_index);
            let next_region = region_to_normalized_region.len();
            let region = *region_to_normalized_region.entry(root).or_insert(next_region);
            let type_index = self.polygon_type_indices[polygon_index];
            polygons.push(ValidPolygon {
                bounds,
                // The coarse polygon's centre: a rough position is all it is used for.
                center: polygon_vertices.iter().map(|i| vertices[*i]).sum::<Vec3>() / polygon_vertices.len() as f32,
                connectivity: vec![None; polygon_vertices.len()],
                vertices: polygon_vertices,
                region,
                type_index,
            });
        }

        let mut boundary_edges = Vec::new();
        for connectivity_state in connectivity_set.values() {
            match *connectivity_state {
                ConnectivityState::Boundary { polygon, edge } => {
                    boundary_edges.push(MeshEdgeRef { edge_index: edge, polygon_index: polygon });
                }
                ConnectivityState::Connected { polygon_1, edge_1, polygon_2, edge_2 } => {
                    polygons[polygon_1].connectivity[edge_1] =
                        Some(Connectivity { polygon_index: polygon_2, reverse_edge: edge_2 });
                    polygons[polygon_2].connectivity[edge_2] =
                        Some(Connectivity { polygon_index: polygon_1, reverse_edge: edge_1 });
                }
            }
        }

        Ok(ValidNavigationMesh { mesh_bounds, polygons, vertices, boundary_edges, height_mesh, marker: PhantomData })
    }
}

impl<CS: CoordinateSystem> HeightNavigationMesh<CS> {
    fn validate(mut self, expected_polygons: usize) -> Result<ValidHeightNavigationMesh, ValidateHeightMeshError> {
        if self.polygons.len() != expected_polygons {
            return Err(ValidateHeightMeshError::IncorrectNumberOfPolygons(expected_polygons, self.polygons.len()));
        }

        let vertices: Vec<Vec3> = self.vertices.iter().map(CS::to_landmass).collect();
        if CS::FLIP_POLYGONS {
            for tri in &mut self.triangles {
                tri.swap(1, 2);
            }
        }

        for (polygon_index, polygon) in self.polygons.iter().enumerate() {
            let last_triangle = polygon.base_triangle_index + polygon.triangle_count;
            if last_triangle as usize > self.triangles.len() {
                return Err(ValidateHeightMeshError::InvalidPolygonIndices(polygon_index));
            }
            for triangle_index in polygon.base_triangle_index..last_triangle {
                let check_index = |index: u8| {
                    let real_index = polygon.vertex(index);
                    if real_index >= vertices.len() || index as usize >= polygon.vertex_count as usize {
                        Err(ValidateHeightMeshError::InvalidIndexInTriangle { triangle: triangle_index, vertex: real_index })
                    } else {
                        Ok(real_index)
                    }
                };
                let [a, b, c] = self.triangles[triangle_index as usize];
                let (a, b, c) = (vertices[check_index(a)?].xy(), vertices[check_index(b)?].xy(), vertices[check_index(c)?].xy());
                if (b - a).perp_dot(c - a) < 0.0 {
                    return Err(ValidateHeightMeshError::ClockwiseTriangle(polygon_index));
                }
            }
        }

        Ok(ValidHeightNavigationMesh { polygons: self.polygons, vertices, triangles: self.triangles })
    }
}

/// A validated navigation mesh with its derived data, in the standard frame.
pub struct ValidNavigationMesh<CS: CoordinateSystem> {
    /// A tight box around the mesh's vertices.
    pub(crate) mesh_bounds: BoundingBox,
    /// The vertices of the polygons.
    pub(crate) vertices: Vec<Vec3>,
    /// The polygons.
    pub(crate) polygons: Vec<ValidPolygon>,
    /// The boundary edges, each counter-clockwise along the boundary, in polygon-then-edge order
    /// of first appearance.
    pub(crate) boundary_edges: Vec<MeshEdgeRef>,
    /// The height mesh, when there is one.
    pub(crate) height_mesh: Option<ValidHeightNavigationMesh>,
    pub(crate) marker: PhantomData<CS>,
}

/// A validated height mesh in the standard frame.
#[derive(Clone, Debug)]
pub(crate) struct ValidHeightNavigationMesh {
    pub(crate) polygons: Vec<HeightPolygon>,
    pub(crate) vertices: Vec<Vec3>,
    pub(crate) triangles: Vec<[u8; 3]>,
}

impl<CS: CoordinateSystem> Clone for ValidNavigationMesh<CS> {
    fn clone(&self) -> Self {
        Self {
            mesh_bounds: self.mesh_bounds,
            vertices: self.vertices.clone(),
            polygons: self.polygons.clone(),
            boundary_edges: self.boundary_edges.clone(),
            height_mesh: self.height_mesh.clone(),
            marker: self.marker,
        }
    }
}

impl<CS: CoordinateSystem> core::fmt::Debug for ValidNavigationMesh<CS> {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("ValidNavigationMesh")
            .field("mesh_bounds", &self.mesh_bounds)
            .field("vertices", &self.vertices)
            .field("polygons", &self.polygons)
            .field("boundary_edges", &self.boundary_edges)
            .field("height_mesh", &self.height_mesh)
            .finish()
    }
}

/// A convex polygon of a [`ValidNavigationMesh`].
#[derive(PartialEq, Debug, Clone)]
pub(crate) struct ValidPolygon {
    /// Indices into the mesh's vertices.
    pub(crate) vertices: Vec<usize>,
    /// Per edge, the polygon across it (`None` on the mesh boundary).
    pub(crate) connectivity: Vec<Option<Connectivity>>,
    /// The connected region this polygon belongs to (numbered in first-polygon order).
    pub(crate) region: usize,
    /// The polygon's type index.
    pub(crate) type_index: usize,
    /// The polygon's bounds (the height mesh's when there is one).
    pub(crate) bounds: BoundingBox,
    /// The polygon's centre.
    pub(crate) center: Vec3,
}

/// The polygon across an edge.
#[derive(PartialEq, Debug, Clone)]
pub(crate) struct Connectivity {
    /// The polygon this edge leads to.
    pub(crate) polygon_index: usize,
    /// The edge of that polygon that leads back.
    pub(crate) reverse_edge: usize,
}

/// An edge of a polygon of a mesh.
#[derive(PartialEq, Eq, Debug, Clone, Copy, Hash, Default, PartialOrd, Ord)]
pub struct MeshEdgeRef {
    /// The polygon.
    pub polygon_index: usize,
    /// The edge within the polygon.
    pub edge_index: usize,
}

/// The point of `triangle` under or over `point`, or the nearest point on the edge `point` is
/// outside of.
fn project_to_triangle(triangle: (Vec3, Vec3, Vec3), point: Vec3) -> Vec3 {
    let deltas = (triangle.1 - triangle.0, triangle.2 - triangle.1, triangle.0 - triangle.2);
    let corners = [triangle.0, triangle.1, triangle.2];
    for (delta, corner) in [deltas.0, deltas.1, deltas.2].into_iter().zip(corners) {
        let flat = delta.xy();
        if flat.perp_dot(point.xy() - corner.xy()) < 0.0 {
            let s = flat.dot(point.xy() - corner.xy()) / flat.length_squared();
            return delta * s.clamp(0.0, 1.0) + corner;
        }
    }
    let normal = -deltas.0.cross(deltas.2).normalize();
    let height = normal.dot(point - triangle.0) / normal.z;
    Vec3::new(point.x, point.y, point.z - height)
}

/// The point of `triangle` under or over `point`, when `point` is inside it horizontally (up to
/// floating-point error).
fn project_into_triangle(triangle: (Vec3, Vec3, Vec3), point: Vec3) -> Option<Vec3> {
    // The point is known to project onto the node, so a tiny miss is rounding.
    const EPSILON: f32 = -1e-5;
    let deltas = (triangle.1 - triangle.0, triangle.2 - triangle.1, triangle.0 - triangle.2);
    let corners = [triangle.0, triangle.1, triangle.2];
    for (delta, corner) in [deltas.0, deltas.1, deltas.2].into_iter().zip(corners) {
        if delta.xy().perp_dot(point.xy() - corner.xy()) < EPSILON {
            return None;
        }
    }
    let normal = -deltas.0.cross(deltas.2).normalize();
    let height = normal.dot(point - triangle.0) / normal.z;
    Some(Vec3::new(point.x, point.y, point.z - height))
}

impl<CS: CoordinateSystem> ValidNavigationMesh<CS> {
    /// The mesh's bounds.
    pub(crate) fn get_bounds(&self) -> BoundingBox {
        self.mesh_bounds
    }

    /// The number of polygons.
    pub fn polygon_count(&self) -> usize {
        self.polygons.len()
    }

    /// The boundary edges, in polygon-then-edge order of first appearance.
    pub fn boundary_edges(&self) -> &[MeshEdgeRef] {
        &self.boundary_edges
    }

    /// The region of `polygon`.
    pub fn polygon_region(&self, polygon: usize) -> Option<usize> {
        self.polygons.get(polygon).map(|p| p.region)
    }

    /// The points of an edge, left to right.
    pub(crate) fn get_edge_points(&self, edge_ref: MeshEdgeRef) -> (Vec3, Vec3) {
        let (left, right) = self.polygons[edge_ref.polygon_index].get_edge_indices(edge_ref.edge_index);
        (self.vertices[left], self.vertices[right])
    }

    /// The triangles of `polygon` (the height mesh's when there is one).
    fn polygon_triangles(&self, polygon_index: usize) -> Vec<(Vec3, Vec3, Vec3)> {
        if let Some(height_mesh) = self.height_mesh.as_ref() {
            let height_polygon = &height_mesh.polygons[polygon_index];
            return height_polygon
                .triangle_range()
                .map(|i| {
                    let [a, b, c] = height_mesh.triangles[i];
                    (
                        height_mesh.vertices[height_polygon.vertex(a)],
                        height_mesh.vertices[height_polygon.vertex(b)],
                        height_mesh.vertices[height_polygon.vertex(c)],
                    )
                })
                .collect();
        }
        let polygon = &self.polygons[polygon_index];
        (2..polygon.vertices.len())
            .map(|i| {
                (
                    self.vertices[polygon.vertices[0]],
                    self.vertices[polygon.vertices[i - 1]],
                    self.vertices[polygon.vertices[i]],
                )
            })
            .collect()
    }

    /// The node nearest to `point` within the sample distance, and the point on it. Ties keep the
    /// first polygon and triangle in order.
    pub(crate) fn sample_point(
        &self,
        point: Vec3,
        point_sample_distance: &CorePointSampleDistance,
    ) -> Option<(Vec3, usize)> {
        let h = point_sample_distance.horizontal_distance;
        let sample_box = BoundingBox::new_box(
            point + Vec3::new(-h, -h, -point_sample_distance.distance_below),
            point + Vec3::new(h, h, point_sample_distance.distance_above),
        );
        let vertical_range = -point_sample_distance.distance_below..=point_sample_distance.distance_above;

        let mut best_node: Option<(usize, Vec3, f32)> = None;
        for (polygon_index, polygon) in self.polygons.iter().enumerate() {
            if !sample_box.intersects_bounds(&polygon.bounds) {
                continue;
            }
            for triangle in self.polygon_triangles(polygon_index) {
                let projected_point = project_to_triangle(triangle, point);
                let horizontal = point.xy().distance(projected_point.xy());
                let vertical = projected_point.z - point.z;
                if horizontal > h || !vertical_range.contains(&vertical) {
                    continue;
                }
                let distance = horizontal * point_sample_distance.vertical_preference_ratio + vertical.abs();
                if best_node.is_none_or(|(_, _, best)| distance < best) {
                    best_node = Some((polygon_index, projected_point, distance));
                }
            }
        }
        best_node.map(|(polygon_index, projected_point, _)| (projected_point, polygon_index))
    }

    /// The point on `node` under or over `point`, which is known to project onto it (the path
    /// code samples corners this way).
    pub fn sample_point_on_node(&self, point: Vec3, node: usize) -> Vec3 {
        let triangles = self.polygon_triangles(node);
        triangles
            .iter()
            .find_map(|&triangle| project_into_triangle(triangle, point))
            .or_else(|| triangles.first().map(|&triangle| project_to_triangle(triangle, point)))
            .unwrap_or(point)
    }

    /// `edge` clipped to this mesh's nodes within `max_vertical_distance`; `node_bbh` must be this
    /// mesh's node hierarchy.
    pub(crate) fn sample_edge(
        &self,
        edge: (Vec3, Vec3),
        node_bbh: &BoundingBoxHierarchy<usize>,
        max_vertical_distance: f32,
    ) -> Vec<SampledEdge> {
        let mut edges = vec![];
        for &node in node_bbh.query_ray_segment(RaySegment::new(edge.0, edge.1)) {
            clip_edge_to_triangles(self.polygon_triangles(node).into_iter(), node, edge, max_vertical_distance, &mut edges);
        }
        edges
    }
}

/// A part of an edge that lies on one node.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct SampledEdge {
    /// The node.
    pub(crate) node: usize,
    /// The interval of the original edge on this node, ascending, within [0, 1].
    pub(crate) interval: (f32, f32),
}

/// Clips `edge` to `triangles` within a vertical distance and appends the merged intervals.
fn clip_edge_to_triangles(
    triangles: impl Iterator<Item = (Vec3, Vec3, Vec3)>,
    node: usize,
    edge: (Vec3, Vec3),
    max_vertical_distance: f32,
    edges: &mut Vec<SampledEdge>,
) {
    let mut intervals: Vec<(f32, f32)> =
        triangles.filter_map(|triangle| clip_edge_to_triangle(triangle, edge, max_vertical_distance)).collect();
    intervals.sort_by_key(|(s, _)| FloatOrd(*s));
    let mut intervals = intervals.into_iter();
    let Some(mut current_interval) = intervals.next() else {
        return;
    };
    for interval in intervals {
        // Close (or overlapping, from rounding) intervals merge; the gap is in edge "time" units.
        if interval.0 - current_interval.1 <= 1e-5 {
            current_interval = (current_interval.0, interval.1);
        } else {
            edges.push(SampledEdge { interval: current_interval, node });
            current_interval = interval;
        }
    }
    edges.push(SampledEdge { interval: current_interval, node });
}

/// A hierarchy over the nodes of `nav_mesh`, each box grown by `expand_by`.
pub(crate) fn nav_mesh_node_bbh<CS: CoordinateSystem>(
    nav_mesh: &ValidNavigationMesh<CS>,
    expand_by: Vec3,
) -> BoundingBoxHierarchy<usize> {
    let mut polygon_bounds = nav_mesh
        .polygons
        .iter()
        .enumerate()
        .map(|(index, polygon)| (polygon.bounds.expand_by_size(expand_by), Some(index)))
        .collect::<Vec<_>>();
    BoundingBoxHierarchy::new(&mut polygon_bounds)
}

impl ValidPolygon {
    /// The vertex indices of `edge`, left to right.
    pub(crate) fn get_edge_indices(&self, edge: usize) -> (usize, usize) {
        (self.vertices[if edge == self.vertices.len() - 1 { 0 } else { edge + 1 }], self.vertices[edge])
    }
}

#[cfg(test)]
#[path = "nav_mesh_test.rs"]
mod test;
