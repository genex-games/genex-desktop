//! Operations on a whole [`MeshData`] (AAA review WP-8): [`MeshData::subdivide`] (Loop smoothing)
//! and [`MeshData::tessellate`] (finer, same shape), [`MeshData::displace`] and
//! [`MeshData::displace_noise`] (move the surface along its normals: a rock from a box, a dented
//! panel, a broken plaster edge), [`MeshData::weighted_normals`] (the large faces of a bevelled
//! piece shade flat and only its bevels turn), [`MeshData::auto_uv`] (box-projected UVs at a real
//! texel density) and [`MeshData::append`] (one mesh from several built parts).
//!
//! The operations treat vertices at the same position as one point of the surface (welded), so a
//! mesh made of faces with their own vertices (a cuboid's, a rounded cuboid's) smooths and moves
//! without opening a crack, while its UVs keep their seams. A mesh that `check()` refuses is left
//! as it is (`gfx.mesh` names why). Everything is IEEE arithmetic in insertion order: the same
//! mesh and arguments give the same bytes on every destination.

use genex_core::map::FastMap;

use crate::frame::Transform;
use crate::math::{self, Vec3};
use crate::mesh::{MESH_TRIANGLES_MAX, MeshData, box_uv};
use crate::mesh_shapes::tile_metres;
use crate::noise::fbm3;

/// The most levels one [`MeshData::subdivide`] or [`MeshData::tessellate`] call applies (each
/// multiplies the triangles by four).
pub const SUBDIVIDE_LEVELS_MAX: u32 = 5;
/// The octaves of [`MeshData::displace_noise`]'s noise.
const DISPLACE_OCTAVES: u32 = 4;
/// After a displacement, faces meeting at less than this many degrees shade smooth.
const DISPLACE_SMOOTH_DEGREES: f32 = 60.0;

/// Which welded point each vertex is (vertices at bit-equal positions share one, -0 as +0), and
/// how many points there are; numbered in the order they first appear.
fn weld(positions: &[Vec3]) -> (Vec<u32>, usize) {
    let mut points: FastMap<[u32; 3], u32> = FastMap::with_capacity_and_hasher(positions.len(), Default::default());
    let mut of = Vec::with_capacity(positions.len());
    for p in positions {
        let key = (*p + Vec3::ZERO).to_array().map(f32::to_bits);
        let next = points.len() as u32;
        of.push(*points.entry(key).or_insert(next));
    }
    let count = points.len();
    (of, count)
}

/// A mesh's edges between welded points, in the order they first appear: each's two points (the
/// key), the triangles on it and the sum of the points opposite it.
struct Edges {
    map: FastMap<(u32, u32), (u32, Vec3)>,
}

impl Edges {
    fn of(indices: &[u32], point_of: &[u32], points: &[Vec3]) -> Edges {
        let mut map: FastMap<(u32, u32), (u32, Vec3)> = FastMap::default();
        for triangle in indices.as_chunks::<3>().0 {
            let [a, b, c] = triangle.map(|i| point_of[i as usize]);
            for (from, to, across) in [(a, b, c), (b, c, a), (c, a, b)] {
                let edge = map.entry((from.min(to), from.max(to))).or_insert((0, Vec3::ZERO));
                edge.0 += 1;
                edge.1 += points[across as usize];
            }
        }
        Edges { map }
    }

    /// The edge between two points, as its index in order.
    fn at(&self, a: u32, b: u32) -> usize {
        self.map.get_index_of(&(a.min(b), a.max(b))).unwrap_or_default()
    }
}

/// Where Loop's rule moves each welded point: an inner point towards its neighbours, a point on
/// an open border along the border only.
fn loop_points(points: &[Vec3], edges: &Edges) -> Vec<Vec3> {
    let mut ring = vec![Vec3::ZERO; points.len()];
    let mut valence = vec![0u32; points.len()];
    let mut border = vec![Vec3::ZERO; points.len()];
    let mut border_count = vec![0u32; points.len()];
    for ((a, b), (faces, _)) in &edges.map {
        let (a, b) = (*a as usize, *b as usize);
        ring[a] += points[b];
        ring[b] += points[a];
        valence[a] += 1;
        valence[b] += 1;
        if *faces == 1 {
            border[a] += points[b];
            border[b] += points[a];
            border_count[a] += 1;
            border_count[b] += 1;
        }
    }
    (0..points.len())
        .map(|p| match (border_count[p], valence[p]) {
            (2, _) => points[p] * 0.75 + border[p] * 0.125,
            (0, n) if n >= 3 => {
                let beta = if n == 3 { 3.0 / 16.0 } else { 3.0 / (8.0 * n as f32) };
                points[p] * (1.0 - n as f32 * beta) + ring[p] * beta
            }
            _ => points[p],
        })
        .collect()
}

/// Where Loop's rule puts each edge's new point.
fn loop_edge_points(points: &[Vec3], edges: &Edges) -> Vec<Vec3> {
    edges
        .map
        .iter()
        .map(|((a, b), (faces, opposite))| {
            let ends = points[*a as usize] + points[*b as usize];
            if *faces == 2 { ends * 0.375 + *opposite * 0.125 } else { ends * 0.5 }
        })
        .collect()
}

impl MeshData {
    /// Normals and UVs filled as `gfx.mesh` fills them, so an operation can carry them.
    fn filled(&mut self) {
        if self.normals.is_empty() {
            self.normals = self.filled_normals();
        }
        if self.uvs.is_empty() {
            self.uvs = self.positions.iter().zip(&self.normals).map(|(p, n)| box_uv(*p, *n)).collect();
        }
    }

    /// Whether an operation may run: the mesh builds (else it is left for `gfx.mesh` to refuse).
    fn ready(&mut self) -> bool {
        if self.check().is_err() {
            return false;
        }
        self.filled();
        true
    }

    /// Smooth the mesh `levels` times (Loop subdivision, up to [`SUBDIVIDE_LEVELS_MAX`]; each
    /// level makes four triangles of one), then give it smooth normals: a box rounds towards a
    /// pebble, a coarse cage towards a soft organic shape. Open borders stay borders (they smooth
    /// along themselves only). UVs are carried linearly. A level that would pass
    /// [`MESH_TRIANGLES_MAX`] is not applied.
    ///
    /// ```
    /// use genex::prelude::*;
    /// use genex::MeshData;
    ///
    /// // A boulder: a box smoothed twice, then roughened.
    /// let mut rock = MeshData::new();
    /// rock.cuboid(vec3(-0.5, 0.0, -0.4), vec3(0.5, 0.7, 0.4), 1.0).subdivide(2).displace_noise(0.08, 0.5, 7);
    /// assert_eq!(rock.triangle_count(), 12 * 16);
    /// ```
    pub fn subdivide(&mut self, levels: u32) -> &mut MeshData {
        if !self.ready() {
            return self;
        }
        for _ in 0..levels.min(SUBDIVIDE_LEVELS_MAX) {
            if self.triangle_count() * 4 > MESH_TRIANGLES_MAX {
                break;
            }
            self.split_once(true);
        }
        self.weighted_normals(180.0)
    }

    /// Split every triangle into four `levels` times (up to [`SUBDIVIDE_LEVELS_MAX`]) without
    /// changing the shape: vertices for [`MeshData::displace`] to move. Normals and UVs are
    /// carried. A level that would pass [`MESH_TRIANGLES_MAX`] is not applied.
    pub fn tessellate(&mut self, levels: u32) -> &mut MeshData {
        if !self.ready() {
            return self;
        }
        for _ in 0..levels.min(SUBDIVIDE_LEVELS_MAX) {
            if self.triangle_count() * 4 > MESH_TRIANGLES_MAX {
                break;
            }
            self.split_once(false);
        }
        self
    }

    /// One level: a new vertex on each edge of each triangle (shared by the triangles on that
    /// edge through the same two vertices), four triangles for each, the points moved by Loop's
    /// rule when `smooth`.
    fn split_once(&mut self, smooth: bool) {
        let (point_of, count) = weld(&self.positions);
        let mut points = vec![Vec3::ZERO; count];
        for (vertex, point) in point_of.iter().enumerate() {
            points[*point as usize] = self.positions[vertex];
        }
        let edges = Edges::of(&self.indices, &point_of, &points);
        let (moved, edge_points) = if smooth { (loop_points(&points, &edges), loop_edge_points(&points, &edges)) } else { (points.clone(), Vec::new()) };
        for (vertex, point) in point_of.iter().enumerate() {
            self.positions[vertex] = moved[*point as usize];
        }
        let mut middles: FastMap<(u32, u32), u32> = FastMap::default();
        let old_indices = std::mem::take(&mut self.indices);
        for triangle in old_indices.as_chunks::<3>().0 {
            let [a, b, c] = *triangle;
            let mut middle = |x: u32, y: u32| {
                let key = (x.min(y), x.max(y));
                if let Some(index) = middles.get(&key) {
                    return *index;
                }
                let (from, to) = (key.0 as usize, key.1 as usize);
                let position = if smooth {
                    edge_points[edges.at(point_of[from], point_of[to])]
                } else {
                    (points[point_of[from] as usize] + points[point_of[to] as usize]) * 0.5
                };
                let normal = (self.normals[from] + self.normals[to]).normalize_or(self.normals[from]);
                let index = self.vertex(position, normal, (self.uvs[from] + self.uvs[to]) * 0.5);
                middles.insert(key, index);
                index
            };
            let (ab, bc, ca) = (middle(a, b), middle(b, c), middle(c, a));
            self.indices.extend([a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca]);
        }
    }

    /// Move every vertex along the surface's smooth normal by `amount(position)` metres (positive
    /// out; not finite reads as 0), vertices at one position by one amount so no crack opens,
    /// then shade it again (faces meeting under 60 degrees smooth). Give it vertices to move
    /// first ([`MeshData::tessellate`] or [`MeshData::subdivide`]).
    ///
    /// ```
    /// use genex::prelude::*;
    /// use genex::MeshData;
    ///
    /// // A 2 x 2 m floor panel with a 3 cm dent 0.4 m across.
    /// let mut panel = MeshData::new();
    /// panel.quad([vec3(-1.0, 0.0, 1.0), vec3(1.0, 0.0, 1.0), vec3(1.0, 0.0, -1.0), vec3(-1.0, 0.0, -1.0)], 1.0).tessellate(4);
    /// panel.displace(|p| -0.03 * (1.0 - p.length() / 0.4).max(0.0));
    /// assert!(panel.check().is_ok());
    /// ```
    pub fn displace(&mut self, amount: impl Fn(Vec3) -> f32) -> &mut MeshData {
        if !self.ready() {
            return self;
        }
        let (point_of, count) = weld(&self.positions);
        let smooth = self.point_normals(&point_of, count);
        let mut offsets: Vec<Option<Vec3>> = vec![None; count];
        for vertex in 0..self.positions.len() {
            let point = point_of[vertex] as usize;
            let offset = *offsets[point].get_or_insert_with(|| {
                let metres = amount(self.positions[vertex]);
                smooth[point] * if metres.is_finite() { metres } else { 0.0 }
            });
            self.positions[vertex] += offset;
        }
        self.weighted_normals(DISPLACE_SMOOTH_DEGREES)
    }

    /// [`MeshData::displace`] by seeded fractal noise: up to `amplitude` metres in and out,
    /// its bumps about `wavelength` metres apart (finer octaves on top). The same seed gives the
    /// same surface everywhere.
    pub fn displace_noise(&mut self, amplitude: f32, wavelength: f32, seed: u32) -> &mut MeshData {
        let scale = if wavelength.is_finite() && wavelength > 0.0 { 1.0 / wavelength } else { 1.0 };
        self.displace(|p| amplitude * fbm3(p * scale, seed, DISPLACE_OCTAVES))
    }

    /// Each welded point's area-weighted normal over every triangle round it.
    fn point_normals(&self, point_of: &[u32], count: usize) -> Vec<Vec3> {
        let mut sums = vec![Vec3::ZERO; count];
        for triangle in self.indices.as_chunks::<3>().0 {
            let [a, b, c] = triangle.map(|i| i as usize);
            let face = (self.positions[b] - self.positions[a]).cross(self.positions[c] - self.positions[a]);
            for vertex in [a, b, c] {
                sums[point_of[vertex] as usize] += face;
            }
        }
        sums.into_iter().map(|sum| sum.normalize_or(Vec3::Y)).collect()
    }

    /// Recompute the normals weighted by face area (the hard-surface "weighted normals" step):
    /// a vertex takes every triangle at its position whose face turns less than `smooth_degrees`
    /// from its own, each counted by its area, so on a bevelled piece the large faces shade flat
    /// and only the narrow bevels between them turn. 180 smooths everything; 0 is flat shading.
    ///
    /// ```
    /// use genex::prelude::*;
    /// use genex::{MeshData, Profile};
    ///
    /// // A chamfered beam whose broad faces shade dead flat right up to the chamfers.
    /// let mut beam = MeshData::new();
    /// beam.extrude(&Profile::rect(0.3, 0.4).bevel(0.02, 1), 4.0, 0.0, 1.0).weighted_normals(50.0);
    /// assert!(beam.check().is_ok());
    /// ```
    pub fn weighted_normals(&mut self, smooth_degrees: f32) -> &mut MeshData {
        if !self.ready() {
            return self;
        }
        let limit = math::cos(math::to_radians(if smooth_degrees.is_finite() { smooth_degrees.clamp(0.0, 180.0) } else { 0.0 }));
        let (point_of, count) = weld(&self.positions);
        let faces: Vec<Vec3> = self
            .indices
            .as_chunks::<3>()
            .0
            .iter()
            .map(|triangle| {
                let [a, b, c] = triangle.map(|i| self.positions[i as usize]);
                (b - a).cross(c - a)
            })
            .collect();
        let mut own = vec![Vec3::ZERO; self.positions.len()];
        let mut round: Vec<Vec<usize>> = vec![Vec::new(); count];
        for (face, triangle) in self.indices.as_chunks::<3>().0.iter().enumerate() {
            for vertex in triangle.map(|i| i as usize) {
                own[vertex] += faces[face];
                let point = &mut round[point_of[vertex] as usize];
                if point.last() != Some(&face) {
                    point.push(face);
                }
            }
        }
        for vertex in 0..self.positions.len() {
            let mine = own[vertex].normalize_or(self.normals[vertex]);
            let sum: Vec3 = round[point_of[vertex] as usize].iter().map(|face| faces[*face]).filter(|face| face.normalize_or_zero().dot(mine) >= limit - 1.0e-6).sum();
            self.normals[vertex] = sum.normalize_or(mine);
        }
        self
    }

    /// Give every triangle box-projected UVs in tiles of `metres` (the axis its face points along
    /// most, as `Material::with_world_uv` projects the world), splitting the vertices that sit
    /// between faces projected along different axes: a texture at its real size on any shape,
    /// a 1 m scan at `metres` 1. 0, negative or not finite reads as 1 m.
    pub fn auto_uv(&mut self, metres: f32) -> &mut MeshData {
        if !self.ready() {
            return self;
        }
        let tile = tile_metres(metres);
        let mut copies: FastMap<(u32, u8), u32> = FastMap::default();
        let old = std::mem::take(self);
        let axes = [Vec3::X, Vec3::NEG_X, Vec3::Y, Vec3::NEG_Y, Vec3::Z, Vec3::NEG_Z];
        for triangle in old.indices.as_chunks::<3>().0 {
            let [a, b, c] = triangle.map(|i| old.positions[i as usize]);
            let side = facing_side((b - a).cross(c - a));
            for vertex in *triangle {
                let index = *copies.entry((vertex, side)).or_insert_with(|| {
                    let p = old.positions[vertex as usize];
                    self.vertex(p, old.normals[vertex as usize], box_uv(p, axes[side as usize]) / tile)
                });
                self.indices.push(index);
            }
        }
        self
    }

    /// Add `other` moved by `transform` (normals turned with it, a mirroring scale rewinding its
    /// triangles), each filled as `gfx.mesh` fills it first: one mesh, one draw, from parts built
    /// apart. A part that `check()` refuses is not added.
    ///
    /// ```
    /// use genex::prelude::*;
    /// use genex::MeshData;
    ///
    /// // Four rounded legs under a rounded top: one stool.
    /// let mut leg = MeshData::new();
    /// leg.rounded_cuboid(vec3(-0.02, 0.0, -0.02), vec3(0.02, 0.45, 0.02), 0.008, 4, 1.0);
    /// let mut stool = MeshData::new();
    /// stool.rounded_cuboid(vec3(-0.2, 0.45, -0.2), vec3(0.2, 0.49, 0.2), 0.012, 4, 1.0);
    /// for (x, z) in [(-0.16, -0.16), (0.16, -0.16), (0.16, 0.16), (-0.16, 0.16)] {
    ///     stool.append(&leg, Transform::from_xyz(x, 0.0, z));
    /// }
    /// assert_eq!(stool.triangle_count(), 5 * leg.triangle_count());
    /// ```
    pub fn append(&mut self, other: &MeshData, transform: Transform) -> &mut MeshData {
        let mut part = other.clone();
        if !part.ready() {
            return self;
        }
        if !self.positions.is_empty() {
            self.filled();
        }
        let matrix = transform.matrix();
        let inverse_scale = Vec3::ONE / transform.scale;
        let mirrored = transform.scale.x * transform.scale.y * transform.scale.z < 0.0;
        let first = self.positions.len() as u32;
        for at in 0..part.positions.len() {
            let normal = (transform.rotation * (part.normals[at] * inverse_scale)).normalize_or(Vec3::Y);
            self.vertex(matrix.transform_point3(part.positions[at]), normal, part.uvs[at]);
        }
        for triangle in part.indices.as_chunks::<3>().0 {
            let [a, b, c] = triangle.map(|i| i + first);
            if mirrored {
                self.triangle(a, c, b);
            } else {
                self.triangle(a, b, c);
            }
        }
        self
    }
}

/// Which of the six axis directions (+x, -x, +y, -y, +z, -z) `normal` points along most.
fn facing_side(normal: Vec3) -> u8 {
    let a = normal.abs();
    let (axis, value) = if a.x >= a.y && a.x >= a.z {
        (0, normal.x)
    } else if a.y >= a.z {
        (2, normal.y)
    } else {
        (4, normal.z)
    };
    axis + u8::from(value < 0.0)
}
