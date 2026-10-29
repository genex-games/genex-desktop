//! Set dressing (AAA review WP-8, a light take on UE's PCG): rule-based placement that turns an
//! empty level into a dressed one, deterministic from one seed.
//!
//! A [`Dressing`] runs named [`Layer`]s in order. A layer tries `density` candidates on a
//! [`Surface`] (per square metre), in a volume (per cubic metre) or along a [`Spline`] (per metre),
//! and its rules keep some: slope and height bands, a seeded clustering mask, [`Zone`]s to avoid or
//! stay near, the distance from earlier layers' placements and from its own (spacing), and a cap.
//! Each kept candidate is a [`Placed`]: a transform (aligned to the surface, scaled, turned and
//! tilted at random within the layer's ranges), the surface normal, a tint and a variant. Feed a
//! layer to instance groups ([`Dressed::groups`], one per variant and tint, so a model's levels,
//! impostor and far field work as on any group) or to decals ([`Placed::decal`]: grime, puddles,
//! posters).
//!
//! Determinism: a layer's stream is seeded from the dressing's seed and the layer's name, and
//! every candidate draws the same numbers whether it is kept or not, so the same inputs place the
//! same things bit for bit on every destination, adding or removing another layer leaves a layer
//! that does not refer to it unchanged, and a rule change never reshuffles the rest. Numbers out of
//! range are clamped (a density that is not finite or not positive places nothing).

use std::sync::Arc;

use genex_core::map::FastMap;

use crate::decal::{DEFAULT_GROUND_DEPTH, DEFAULT_WALL_DEPTH};
use crate::frame::{Color, Material, Transform};
use crate::gfx::{Model, ModelTriangles};
use crate::group::{InstanceGroup, InstanceGroupError};
use crate::math::{self, Quat, Vec2, Vec3};
use crate::mesh::MeshData;
use crate::noise::fbm3;
use crate::{Decal, Pcg32};

/// The most candidates one layer tries (its density times its area, length or volume is held
/// to this).
pub const DRESSING_CANDIDATES_MAX: usize = 1 << 20;
/// How many tints one layer's groups are split into ([`Dressed::groups`]).
pub const DRESSING_TINT_BUCKETS: usize = 4;
/// The most variants a layer picks between.
pub const DRESSING_VARIANTS_MAX: u32 = 64;
/// The samples a [`Spline`] takes between two of its points.
pub const SPLINE_SAMPLES_PER_SPAN: usize = 16;
/// The octaves of a layer's clustering noise.
const CLUSTER_OCTAVES: u32 = 3;
/// A surface normal steeper than this (its y) takes a ground decal's depth.
const GROUND_FACING: f32 = 0.7;
/// The PCG sequence every layer's stream runs on.
const LAYER_SEQUENCE: u64 = 0x5EED_D2E5;

/// Triangles to place on, in world space (degenerate and non-finite ones dropped).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Surface {
    triangles: Arc<Vec<[Vec3; 3]>>,
    /// The running sum of the triangles' areas.
    running: Arc<Vec<f32>>,
}

impl Surface {
    /// `triangles` as a surface.
    pub fn from_triangle_list(triangles: impl IntoIterator<Item = [Vec3; 3]>) -> Surface {
        let mut kept = Vec::new();
        let mut running = Vec::new();
        let mut total = 0.0;
        for [a, b, c] in triangles {
            let area = (b - a).cross(c - a).length() / 2.0;
            if area.is_finite() && area > 1.0e-9 {
                kept.push([a, b, c]);
                total += area;
                running.push(total);
            }
        }
        Surface { triangles: Arc::new(kept), running: Arc::new(running) }
    }

    /// A built mesh's triangles moved by `transform` (where the game draws it).
    pub fn from_mesh(mesh: &MeshData, transform: Transform) -> Surface {
        Surface::from_indexed(&mesh.positions, &mesh.indices, transform)
    }

    /// A model's triangles (`gfx.assets().triangles(&model)`) moved by `transform`.
    pub fn from_triangles(triangles: &ModelTriangles, transform: Transform) -> Surface {
        Surface::from_indexed(&triangles.positions, &triangles.indices, transform)
    }

    fn from_indexed(positions: &[Vec3], indices: &[u32], transform: Transform) -> Surface {
        let matrix = transform.matrix();
        let at = |i: u32| positions.get(i as usize).map_or(Vec3::NAN, |p| matrix.transform_point3(*p));
        Surface::from_triangle_list(indices.as_chunks::<3>().0.iter().map(|[a, b, c]| [at(*a), at(*b), at(*c)]))
    }

    /// The level floor from `min` to `max` (x and z) at height `y`, facing up.
    pub fn floor(min: Vec2, max: Vec2, y: f32) -> Surface {
        let (a, b) = (min.min(max), min.max(max));
        let p = |x: f32, z: f32| Vec3::new(x, y, z);
        Surface::from_triangle_list([[p(a.x, b.y), p(b.x, b.y), p(b.x, a.y)], [p(a.x, b.y), p(b.x, a.y), p(a.x, a.y)]])
    }

    /// An upright wall face from `from` to `to` (its bottom edge, at their heights) up `height`
    /// metres, facing whichever side `facing` points to.
    pub fn wall(from: Vec3, to: Vec3, height: f32, facing: Vec3) -> Surface {
        let up = Vec3::Y * height;
        let (a, b, c, d) = (from, to, to + up, from + up);
        let normal = (b - a).cross(d - a);
        let quad = if normal.dot(facing) >= 0.0 { [[a, b, c], [a, c, d]] } else { [[b, a, d], [b, d, c]] };
        Surface::from_triangle_list(quad)
    }

    /// This surface and `other` as one.
    pub fn and(&self, other: &Surface) -> Surface {
        Surface::from_triangle_list(self.triangles.iter().chain(other.triangles.iter()).copied())
    }

    /// Its area in square metres.
    pub fn area(&self) -> f32 {
        self.running.last().copied().unwrap_or(0.0)
    }

    /// A point on the surface from three unit draws, with the face's normal.
    fn sample(&self, pick: f32, s: f32, t: f32) -> (Vec3, Vec3) {
        let wanted = pick * self.area();
        let at = self.running.partition_point(|sum| *sum <= wanted).min(self.triangles.len() - 1);
        let [a, b, c] = self.triangles[at];
        let (s, t) = if s + t > 1.0 { (1.0 - s, 1.0 - t) } else { (s, t) };
        (a + (b - a) * s + (c - a) * t, (b - a).cross(c - a).normalize_or(Vec3::Y))
    }
}

/// A smooth path through points (uniform Catmull-Rom; [`Spline::polyline`] keeps straight
/// segments): a street, a kerb, a fence line, a river bank. Distances are along it, in metres.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Spline {
    samples: Vec<Vec3>,
    distances: Vec<f32>,
}

impl Spline {
    /// A smooth curve through `points` ([`SPLINE_SAMPLES_PER_SPAN`] samples between two).
    pub fn new(points: &[Vec3]) -> Spline {
        let count = points.len();
        if count < 3 {
            return Spline::polyline(points);
        }
        let at = |i: isize| points[i.clamp(0, count as isize - 1) as usize];
        let mut samples = Vec::with_capacity((count - 1) * SPLINE_SAMPLES_PER_SPAN + 1);
        for span in 0..count as isize - 1 {
            let (p0, p1, p2, p3) = (at(span - 1), at(span), at(span + 1), at(span + 2));
            for step in 0..SPLINE_SAMPLES_PER_SPAN {
                let t = step as f32 / SPLINE_SAMPLES_PER_SPAN as f32;
                let (t2, t3) = (t * t, t * t * t);
                samples.push((p1 * 2.0 + (p2 - p0) * t + (p0 * 2.0 - p1 * 5.0 + p2 * 4.0 - p3) * t2 + (p1 * 3.0 - p0 - p2 * 3.0 + p3) * t3) * 0.5);
            }
        }
        samples.push(points[count - 1]);
        Spline::polyline(&samples)
    }

    /// Straight segments through `points`.
    pub fn polyline(points: &[Vec3]) -> Spline {
        let mut samples: Vec<Vec3> = Vec::with_capacity(points.len());
        let mut distances = Vec::with_capacity(points.len());
        for point in points.iter().filter(|p| p.is_finite()) {
            if let Some(last) = samples.last() {
                if last.distance(*point) <= 1.0e-6 {
                    continue;
                }
                distances.push(distances[distances.len() - 1] + last.distance(*point));
            } else {
                distances.push(0.0);
            }
            samples.push(*point);
        }
        Spline { samples, distances }
    }

    /// Its length in metres.
    pub fn length(&self) -> f32 {
        self.distances.last().copied().unwrap_or(0.0)
    }

    /// The point `distance` metres along it (held to its ends) and its unit direction there.
    pub fn at(&self, distance: f32) -> (Vec3, Vec3) {
        match self.samples.len() {
            0 => (Vec3::ZERO, Vec3::X),
            1 => (self.samples[0], Vec3::X),
            count => {
                let d = if distance.is_finite() { distance.clamp(0.0, self.length()) } else { 0.0 };
                let after = self.distances.partition_point(|at| *at <= d).clamp(1, count - 1);
                let (a, b) = (self.samples[after - 1], self.samples[after]);
                let span = self.distances[after] - self.distances[after - 1];
                let t = if span > 0.0 { (d - self.distances[after - 1]) / span } else { 0.0 };
                (a + (b - a) * t, (b - a).normalize_or(Vec3::X))
            }
        }
    }

    /// The sampled points, for [`MeshData::sweep`] or [`MeshData::tube`].
    pub fn points(&self) -> &[Vec3] {
        &self.samples
    }

    /// The distance from `p` to the nearest point of the path.
    pub fn distance_to(&self, p: Vec3) -> f32 {
        match self.samples.len() {
            0 => f32::INFINITY,
            1 => p.distance(self.samples[0]),
            _ => self.samples.windows(2).map(|ab| distance_to_segment(p, ab[0], ab[1])).fold(f32::INFINITY, f32::min),
        }
    }
}

fn distance_to_segment(p: Vec3, a: Vec3, b: Vec3) -> f32 {
    let ab = b - a;
    let t = if ab.length_squared() > 0.0 { ((p - a).dot(ab) / ab.length_squared()).clamp(0.0, 1.0) } else { 0.0 };
    p.distance(a + ab * t)
}

/// A region a layer keeps away from ([`Layer::avoid`]) or close to ([`Layer::near`]).
#[derive(Clone, Debug, PartialEq)]
pub enum Zone {
    /// A ball.
    Sphere {
        /// Its centre.
        center: Vec3,
        /// Its radius.
        radius: f32,
    },
    /// An axis-aligned box.
    Cuboid {
        /// Its smallest corner.
        min: Vec3,
        /// Its largest corner.
        max: Vec3,
    },
    /// Everything within `radius` of a path (a road to keep clear, a kerb to gather litter).
    Along {
        /// The path.
        spline: Spline,
        /// How far either side of it.
        radius: f32,
    },
}

impl Zone {
    /// A ball round `center`.
    pub fn sphere(center: Vec3, radius: f32) -> Zone {
        Zone::Sphere { center, radius }
    }

    /// The box from `min` to `max`.
    pub fn cuboid(min: Vec3, max: Vec3) -> Zone {
        Zone::Cuboid { min: min.min(max), max: min.max(max) }
    }

    /// Within `radius` of `spline`.
    pub fn along(spline: &Spline, radius: f32) -> Zone {
        Zone::Along { spline: spline.clone(), radius }
    }

    /// How far `p` is outside the zone (0 inside).
    pub fn distance(&self, p: Vec3) -> f32 {
        match self {
            Zone::Sphere { center, radius } => (p.distance(*center) - radius).max(0.0),
            Zone::Cuboid { min, max } => (p - p.clamp(*min, *max)).length(),
            Zone::Along { spline, radius } => (spline.distance_to(p) - radius).max(0.0),
        }
    }
}

/// Where a layer's candidates come from.
#[derive(Clone, Debug, PartialEq)]
enum Source {
    Surface(Surface),
    Volume { min: Vec3, max: Vec3 },
    Along { spline: Spline, offset: [f32; 2] },
}

/// One rule of a [`Dressing`]: where candidates come from, how many, which are kept and how each
/// is placed. Start with [`Layer::on`], [`Layer::inside`] or [`Layer::along`], then chain rules.
#[derive(Clone, Debug, PartialEq)]
pub struct Layer {
    source: Source,
    density: f32,
    cap: usize,
    slope: [f32; 2],
    height: [f32; 2],
    spacing: f32,
    cluster: Option<(f32, f32)>,
    avoid: Vec<(Zone, f32)>,
    near: Vec<(Zone, f32)>,
    avoid_layers: Vec<(String, f32)>,
    near_layers: Vec<(String, f32)>,
    align: f32,
    scale: [f32; 2],
    yaw: [f32; 2],
    tilt: f32,
    sink: [f32; 2],
    tint: [f32; 2],
    variants: u32,
}

impl Layer {
    fn from_source(source: Source) -> Layer {
        Layer {
            source,
            density: 1.0,
            cap: usize::MAX,
            slope: [0.0, 180.0],
            height: [f32::NEG_INFINITY, f32::INFINITY],
            spacing: 0.0,
            cluster: None,
            avoid: Vec::new(),
            near: Vec::new(),
            avoid_layers: Vec::new(),
            near_layers: Vec::new(),
            align: 0.0,
            scale: [1.0, 1.0],
            yaw: [0.0, 360.0],
            tilt: 0.0,
            sink: [0.0, 0.0],
            tint: [1.0, 1.0],
            variants: 1,
        }
    }

    /// Candidates on `surface`, `density` a square metre (default 1), each with its face's normal.
    pub fn on(surface: &Surface) -> Layer {
        Layer::from_source(Source::Surface(surface.clone()))
    }

    /// Candidates in the box from `min` to `max`, `density` a cubic metre, normal up.
    pub fn inside(min: Vec3, max: Vec3) -> Layer {
        Layer::from_source(Source::Volume { min: min.min(max), max: min.max(max) })
    }

    /// Candidates beside `spline`, `density` a metre of each side (of it, when both distances are
    /// 0), from `nearest` to `farthest` metres to either side, normal up, turned to follow it (yaw
    /// 0 is local +x along it).
    pub fn along(spline: &Spline, nearest: f32, farthest: f32) -> Layer {
        Layer::from_source(Source::Along { spline: spline.clone(), offset: [nearest.min(farthest), nearest.max(farthest)] })
    }

    /// Candidates tried per square metre, cubic metre or metre (the rules then thin them).
    pub fn density(mut self, per: f32) -> Layer {
        self.density = per;
        self
    }

    /// Keep at most `most`.
    pub fn cap(mut self, most: usize) -> Layer {
        self.cap = most;
        self
    }

    /// Only where the surface's normal is `least` to `most` degrees from straight up (0..30 a
    /// floor, 80..100 a wall, 150..180 a ceiling).
    pub fn slope(mut self, least: f32, most: f32) -> Layer {
        self.slope = [least.min(most), least.max(most)];
        self
    }

    /// Only from `lowest` to `highest` metres up (world y): a skirting band, poster height.
    pub fn height(mut self, lowest: f32, highest: f32) -> Layer {
        self.height = [lowest.min(highest), lowest.max(highest)];
        self
    }

    /// No two of this layer closer than `metres`.
    pub fn spacing(mut self, metres: f32) -> Layer {
        self.spacing = metres;
        self
    }

    /// In patches about `metres` across covering about `coverage` (0..1) of the ground, from
    /// seeded noise: puddles, leaf drifts, rubble heaps instead of an even sprinkle.
    pub fn clustered(mut self, metres: f32, coverage: f32) -> Layer {
        self.cluster = Some((metres, coverage));
        self
    }

    /// Not inside `zone` nor within `margin` metres of it.
    pub fn avoid(mut self, zone: Zone, margin: f32) -> Layer {
        self.avoid.push((zone, margin));
        self
    }

    /// Only within `metres` of `zone`, thicker the closer (none at `metres`): litter along wall
    /// bases, weeds along a kerb.
    pub fn near(mut self, zone: Zone, metres: f32) -> Layer {
        self.near.push((zone, metres));
        self
    }

    /// Not within `margin` metres of an earlier layer's placement.
    pub fn avoid_layer(mut self, name: &str, margin: f32) -> Layer {
        self.avoid_layers.push((name.to_owned(), margin));
        self
    }

    /// Only within `metres` of an earlier layer's placement, thicker the closer: papers round
    /// desks, glass round a broken window, leaves under trees.
    pub fn near_layer(mut self, name: &str, metres: f32) -> Layer {
        self.near_layers.push((name.to_owned(), metres));
        self
    }

    /// Lean `share` (0..1) of the way from upright to the surface's normal (1: flat on a slope,
    /// out of a wall).
    pub fn align(mut self, share: f32) -> Layer {
        self.align = share;
        self
    }

    /// A uniform scale from `smallest` to `largest`.
    pub fn scale(mut self, smallest: f32, largest: f32) -> Layer {
        self.scale = [smallest.min(largest), smallest.max(largest)];
        self
    }

    /// A turn about the (aligned) up axis from `least` to `most` degrees (default 0..360).
    pub fn yaw(mut self, least: f32, most: f32) -> Layer {
        self.yaw = [least.min(most), least.max(most)];
        self
    }

    /// A lean of up to `degrees` in a random direction (fallen, settled things).
    pub fn tilt(mut self, degrees: f32) -> Layer {
        self.tilt = degrees;
        self
    }

    /// Moved along the normal from `least` to `most` metres (negative sinks into the ground).
    pub fn sink(mut self, least: f32, most: f32) -> Layer {
        self.sink = [least.min(most), least.max(most)];
        self
    }

    /// A brightness tint from `least` to `most` (1 the material's colour).
    pub fn tint(mut self, least: f32, most: f32) -> Layer {
        self.tint = [least.min(most), least.max(most)];
        self
    }

    /// Pick one of `count` variants for each (1 to [`DRESSING_VARIANTS_MAX`]).
    pub fn variants(mut self, count: u32) -> Layer {
        self.variants = count;
        self
    }

    /// How many candidates the layer tries.
    fn candidates(&self) -> usize {
        let amount = match &self.source {
            Source::Surface(surface) => surface.area(),
            Source::Volume { min, max } => (*max - *min).max(Vec3::ZERO).element_product(),
            Source::Along { spline, offset } => spline.length() * if offset[1] > 0.0 { 2.0 } else { 1.0 },
        };
        let wanted = self.density * amount;
        if !(wanted.is_finite() && wanted > 0.0) {
            return 0;
        }
        (math::round(wanted) as usize).min(DRESSING_CANDIDATES_MAX)
    }

    /// A candidate's position, normal and the direction yaw 0 faces, from its three draws.
    fn candidate(&self, [d0, d1, d2]: [f32; 3]) -> Option<(Vec3, Vec3, Option<Vec3>)> {
        match &self.source {
            Source::Surface(surface) if surface.area() > 0.0 => {
                let (p, n) = surface.sample(d0, d1, d2);
                Some((p, n, None))
            }
            Source::Surface(_) => None,
            Source::Volume { min, max } => Some((*min + (*max - *min) * Vec3::new(d0, d1, d2), Vec3::Y, None)),
            Source::Along { spline, offset } => {
                let (p, direction) = spline.at(d0 * spline.length());
                let side = (direction.cross(Vec3::Y)).normalize_or(Vec3::Z) * if d2 < 0.5 { -1.0 } else { 1.0 };
                Some((p + side * (offset[0] + (offset[1] - offset[0]) * d1), Vec3::Y, Some(direction)))
            }
        }
    }
}

/// One placement a layer kept.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Placed {
    /// Where to draw it: aligned, tilted, turned, scaled and sunk.
    pub transform: Transform,
    /// The surface's normal where it stands (up in a volume and along a spline).
    pub normal: Vec3,
    /// Its turn about the normal, in radians.
    pub yaw: f32,
    /// Its brightness tint.
    pub tint: f32,
    /// Its variant, below the layer's count.
    pub variant: u32,
}

impl Placed {
    /// A decal `width` by `height` metres (times the placement's scale) laid on the surface it
    /// stands on: facing out along the normal, turned by its yaw; a floor's box reaching
    /// [`DEFAULT_GROUND_DEPTH`], a wall's [`DEFAULT_WALL_DEPTH`]. Give it textures as any decal.
    pub fn decal(&self, width: f32, height: f32) -> Decal {
        let scale = self.transform.scale.x;
        let decal = Decal::on_wall(self.transform.translation, self.normal, width * scale, height * scale).rotated(self.yaw);
        decal.with_depth(if self.normal.y.abs() >= GROUND_FACING { DEFAULT_GROUND_DEPTH } else { DEFAULT_WALL_DEPTH })
    }
}

/// What a [`Dressing`] placed: each layer's placements by name.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Dressed {
    layers: Vec<(String, Vec<Placed>, [f32; 2])>,
}

impl Dressed {
    /// The layer's placements (none for a name the dressing has no layer of).
    pub fn get(&self, name: &str) -> &[Placed] {
        self.layers.iter().find(|layer| layer.0 == name).map_or(&[], |layer| &layer.1)
    }

    /// The layer's transforms, for `InstanceGroup::models` or `frame.model`.
    pub fn transforms(&self, name: &str) -> Vec<Transform> {
        self.get(name).iter().map(|placed| placed.transform).collect()
    }

    /// Every layer's name and placement count, in order.
    pub fn counts(&self) -> Vec<(&str, usize)> {
        self.layers.iter().map(|layer| (layer.0.as_str(), layer.1.len())).collect()
    }

    /// The layer as instance groups: one for each variant (placement `variant` draws
    /// `models[variant % models.len()]`) and, with a `material`, each of
    /// [`DRESSING_TINT_BUCKETS`] tints of it (its base colour times the bucket's tint); without
    /// one, the GLB's own materials. A model's levels, impostor and far field work as on any
    /// group. No models or no placements: no groups.
    pub fn groups(&self, name: &str, models: &[Model], material: Option<&Material>) -> Result<Vec<InstanceGroup>, InstanceGroupError> {
        let Some((_, placed, tint)) = self.layers.iter().find(|layer| layer.0 == name) else { return Ok(Vec::new()) };
        if models.is_empty() {
            return Ok(Vec::new());
        }
        let buckets = if material.is_some() { DRESSING_TINT_BUCKETS } else { 1 };
        let mut sorted: Vec<Vec<Transform>> = vec![Vec::new(); models.len() * buckets];
        for p in placed {
            let span = tint[1] - tint[0];
            let share = if span > 0.0 { (p.tint - tint[0]) / span } else { 0.0 };
            let bucket = ((share * buckets as f32) as usize).min(buckets - 1);
            sorted[(p.variant as usize % models.len()) * buckets + bucket].push(p.transform);
        }
        let mut groups = Vec::new();
        for (at, transforms) in sorted.into_iter().enumerate() {
            if transforms.is_empty() {
                continue;
            }
            let model = &models[at / buckets];
            let group = match material {
                Some(material) => {
                    let centre = tint[0] + (tint[1] - tint[0]) * ((at % buckets) as f32 + 0.5) / buckets as f32;
                    InstanceGroup::models_with(model, transforms, &tinted(material, centre))?
                }
                None => InstanceGroup::models(model, transforms)?,
            };
            groups.push(group);
        }
        Ok(groups)
    }
}

/// `material` with its base colour's channels times `tint`.
fn tinted(material: &Material, tint: f32) -> Material {
    let c = material.base_color;
    let channel = |v: u8| math::round(f32::from(v) * tint).clamp(0.0, 255.0) as u8;
    let mut out = material.clone();
    out.base_color = Color::rgba(channel(c.r), channel(c.g), channel(c.b), c.a);
    out
}

/// Placed points bucketed in cubes of one size, for "is any within r" queries.
struct Grid {
    cell: f32,
    cells: FastMap<[i32; 3], Vec<Vec3>>,
}

impl Grid {
    fn new(cell: f32) -> Grid {
        Grid { cell: if cell.is_finite() && cell > 0.0 { cell } else { 1.0 }, cells: FastMap::default() }
    }

    fn key(&self, p: Vec3) -> [i32; 3] {
        (p / self.cell).to_array().map(|v| math::floor(v) as i32)
    }

    fn add(&mut self, p: Vec3) {
        let key = self.key(p);
        self.cells.entry(key).or_default().push(p);
    }

    /// The nearest point within `radius` of `p`, as its distance.
    fn nearest(&self, p: Vec3, radius: f32) -> Option<f32> {
        let reach = math::ceil(radius / self.cell).max(1.0) as i32;
        let [x, y, z] = self.key(p);
        let mut best: Option<f32> = None;
        for dx in -reach..=reach {
            for dy in -reach..=reach {
                for dz in -reach..=reach {
                    let Some(points) = self.cells.get(&[x + dx, y + dy, z + dz]) else { continue };
                    for q in points {
                        let d = p.distance(*q);
                        if d <= radius && best.is_none_or(|b| d < b) {
                            best = Some(d);
                        }
                    }
                }
            }
        }
        best
    }
}

/// An ordered set of named [`Layer`]s placed from one seed.
///
/// ```
/// use genex::prelude::*;
/// use genex::{Dressing, Layer, Surface, Zone};
///
/// // A 6 x 4 m room: rubble heaped against the walls, papers round the rubble, a clear doorway.
/// let floor = Surface::floor(vec2(-3.0, -2.0), vec2(3.0, 2.0), 0.0);
/// let middle = Zone::cuboid(vec3(-2.4, -1.0, -1.4), vec3(2.4, 1.0, 1.4));
/// let mut dressing = Dressing::new(7);
/// dressing
///     .layer("rubble", Layer::on(&floor).density(3.0).avoid(middle, 0.0).spacing(0.25).scale(0.5, 1.4).tilt(20.0).variants(3))
///     .layer("papers", Layer::on(&floor).density(6.0).near_layer("rubble", 0.8).avoid(Zone::sphere(vec3(3.0, 0.0, 0.0), 0.7), 0.0));
/// let dressed = dressing.run();
/// assert!(!dressed.get("rubble").is_empty());
/// assert_eq!(dressed, dressing.run(), "the same seed places the same things");
/// ```
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Dressing {
    seed: u32,
    layers: Vec<(String, Layer)>,
}

impl Dressing {
    /// An empty dressing placed from `seed`.
    pub fn new(seed: u32) -> Dressing {
        Dressing { seed, layers: Vec::new() }
    }

    /// Add `layer` as `name` (a later one of the same name replaces it in place). A layer may
    /// refer only to layers added before it.
    pub fn layer(&mut self, name: &str, layer: Layer) -> &mut Dressing {
        match self.layers.iter_mut().find(|(existing, _)| existing == name) {
            Some(slot) => slot.1 = layer,
            None => self.layers.push((name.to_owned(), layer)),
        }
        self
    }

    /// Place every layer, in order.
    pub fn run(&self) -> Dressed {
        let mut dressed = Dressed::default();
        for (name, layer) in &self.layers {
            let placed = self.place(name, layer, &dressed);
            dressed.layers.push((name.clone(), placed, layer.tint));
        }
        dressed
    }

    /// The layer's stream: the dressing's seed and the layer's name.
    fn stream(&self, name: &str) -> Pcg32 {
        let named = genex_core::digest::fnv1a64(name.as_bytes());
        Pcg32::new(u64::from(self.seed) ^ named.rotate_left(17), LAYER_SEQUENCE)
    }

    fn place(&self, name: &str, layer: &Layer, earlier: &Dressed) -> Vec<Placed> {
        let mut rng = self.stream(name);
        let others: Vec<(Grid, f32, bool)> = layer
            .avoid_layers
            .iter()
            .map(|(other, margin)| (other, *margin, false))
            .chain(layer.near_layers.iter().map(|(other, metres)| (other, *metres, true)))
            .map(|(other, metres, near)| {
                let mut grid = Grid::new(metres);
                for placed in earlier.get(other) {
                    grid.add(placed.transform.translation);
                }
                (grid, metres, near)
            })
            .collect();
        let mut own = Grid::new(layer.spacing);
        let mut out = Vec::new();
        let rules = Rules::of(layer, self.seed ^ genex_core::digest::fnv1a64(name.as_bytes()) as u32);
        for _ in 0..layer.candidates() {
            // Every candidate draws its eleven numbers, kept or not.
            let draws: [f32; 11] = std::array::from_fn(|_| rng.unit());
            if out.len() >= layer.cap {
                continue;
            }
            let Some((position, normal, along)) = layer.candidate([draws[0], draws[1], draws[2]]) else { continue };
            if !rules.keeps(position, normal, draws[10], &others) {
                continue;
            }
            if layer.spacing > 0.0 && own.nearest(position, layer.spacing).is_some() {
                continue;
            }
            own.add(position);
            out.push(placement(layer, position, normal, along, &draws));
        }
        out
    }
}

/// A layer's keep rules, checked in order.
struct Rules<'a> {
    layer: &'a Layer,
    slope: [f32; 2],
    seed: u32,
}

impl<'a> Rules<'a> {
    fn of(layer: &'a Layer, seed: u32) -> Rules<'a> {
        // The slope band as cosines of the normal against up (larger angle, smaller cosine).
        let slope = [math::cos(math::to_radians(layer.slope[1])), math::cos(math::to_radians(layer.slope[0]))];
        Rules { layer, slope, seed }
    }

    /// Whether a candidate at `p` facing `n` is kept; `keep` is its draw for falloffs.
    fn keeps(&self, p: Vec3, n: Vec3, keep: f32, others: &[(Grid, f32, bool)]) -> bool {
        let layer = self.layer;
        let up = n.y;
        if up < self.slope[0] - 1.0e-6 || up > self.slope[1] + 1.0e-6 {
            return false;
        }
        if p.y < layer.height[0] || p.y > layer.height[1] {
            return false;
        }
        if let Some((metres, coverage)) = layer.cluster {
            let scale = if metres.is_finite() && metres > 0.0 { 1.0 / metres } else { 1.0 };
            let field = fbm3(p * scale, self.seed, CLUSTER_OCTAVES) * 0.5 + 0.5;
            if field > coverage.clamp(0.0, 1.0) {
                return false;
            }
        }
        if layer.avoid.iter().any(|(zone, margin)| zone.distance(p) <= *margin) {
            return false;
        }
        let mut chance = 1.0f32;
        for (zone, metres) in &layer.near {
            let d = zone.distance(p);
            if d > *metres {
                return false;
            }
            chance *= if *metres > 0.0 { 1.0 - d / metres } else { 1.0 };
        }
        for (grid, metres, near) in others {
            let nearest = grid.nearest(p, *metres);
            match (near, nearest) {
                (false, Some(_)) | (true, None) => return false,
                (true, Some(d)) => chance *= if *metres > 0.0 { 1.0 - d / metres } else { 1.0 },
                (false, None) => {}
            }
        }
        keep < chance
    }
}

/// The placement of a kept candidate from its draws.
fn placement(layer: &Layer, position: Vec3, normal: Vec3, along: Option<Vec3>, draws: &[f32; 11]) -> Placed {
    let lerp = |range: [f32; 2], t: f32| range[0] + (range[1] - range[0]) * t;
    let up = Vec3::Y.lerp(normal, layer.align.clamp(0.0, 1.0)).normalize_or(Vec3::Y);
    let heading = along.map_or(0.0, |d| math::atan2(-d.z, d.x));
    let yaw = math::to_radians(lerp(layer.yaw, draws[3]));
    let tilt_axis = Vec3::new(math::cos(draws[8] * math::TAU), 0.0, math::sin(draws[8] * math::TAU));
    let tilt = Quat::from_axis_angle(tilt_axis, math::to_radians(layer.tilt.clamp(0.0, 90.0)) * draws[7]);
    let rotation = Quat::from_rotation_arc(Vec3::Y, up) * tilt * Quat::from_rotation_y(heading + yaw);
    let scale = lerp(layer.scale, draws[4]);
    let variants = layer.variants.clamp(1, DRESSING_VARIANTS_MAX);
    Placed {
        transform: Transform { translation: position + normal * lerp(layer.sink, draws[9]), rotation, scale: Vec3::splat(scale) },
        normal,
        yaw,
        tint: lerp(layer.tint, draws[5]),
        variant: ((draws[6] * variants as f32) as u32).min(variants - 1),
    }
}
