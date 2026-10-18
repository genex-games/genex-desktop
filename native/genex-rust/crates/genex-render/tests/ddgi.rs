//! DDGI with software rays (renderer pass 2 B.11): the D8 go/no-go measurement. The plan admits
//! DDGI only if a software-ray update costs at most 2.0 ms on an integrated GPU; R4 (ray query) is
//! out of scope, so every ray here walks a BVH in a compute shader (`ddgi_trace.wgsl`).
//!
//! CPU rows hold the BVH (every triangle once, every box bounds its subtree). Real-GPU rows
//! (`#[ignore]`d, every name contains `metal`) hold the trace against a brute-force CPU twin and
//! measure the update on a Lakeside proxy (the CDLOD-free heightfield, the showcase's own LOD2 tree
//! and rock GLBs, a 32x4x32 probe grid as A.4's largest volume):
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked --release --test ddgi -- --ignored metal --nocapture
//!
//! The cost row writes its JSON lines to `GENEX_PERF_OUT` when that is set. Decision (D8,
//! 2026-10-18): no-go; the row holds it (see its doc comment).

use bytemuck::Zeroable;
use genex_render::Gpu;
use std::path::{Path, PathBuf};

/// The D8 budget: a DDGI update on an integrated GPU (plan section 5, B.11).
const DDGI_BUDGET_MS: f64 = 2.0;
/// This Mac's GPU (M4 Max, 40 cores, 546 GB/s) against the base Apple silicon GPU the device
/// classifier also starts on desktop high (M1, 8 cores at 1.28 GHz, 68 GB/s): about 6.2x the ALU
/// rate and 8.0x the memory bandwidth. Incoherent BVH walks are memory bound, so 8.0 is the likely
/// factor; the decision uses the kinder 6.2 so that a no-go does not rest on the estimate.
const INTEGRATED_ALU_FACTOR: f64 = 6.2;
const INTEGRATED_BANDWIDTH_FACTOR: f64 = 8.0;
/// The cheapest update still called DDGI: a quarter of a 4096-probe volume a frame (each probe every
/// 4th frame) at 64 rays a probe with hysteresis 0.97 (Majercik et al. 2019 use 100-288).
const FLOOR_CONFIG: Config = Config { probes: 1024, rays: 64 };
const CONFIGS: [Config; 4] = [Config { probes: 512, rays: 64 }, FLOOR_CONFIG, Config { probes: 1024, rays: 128 }, Config { probes: 4096, rays: 128 }];
/// Probe grid: A.4's largest volume (32 x 4 x 32 = 4096 cells).
const GRID: [u32; 3] = [32, 4, 32];
const GRID_SPACING: f32 = 4.0;
/// Lakeside's terrain half extent (showcase `TERRAIN_HALF`) and the proxy's heightfield cells a side.
const TERRAIN_HALF: f32 = 96.0;
const TERRAIN_CELLS: u32 = 128;
const TREES: u32 = 400;
const ROCKS: u32 = 40;
const SAH_BINS: usize = 16;
const LEAF_MAX: usize = 4;
/// The GPU traversal stack (`STACK` in the shader).
const GPU_STACK: usize = 64;
const WARM_FRAMES: u32 = 4;
const TIMED_FRAMES: u32 = 24;
const ATTEMPTS: usize = 3;

#[derive(Clone, Copy)]
struct Config {
    probes: u32,
    rays: u32,
}

impl Config {
    fn rays_a_frame(self) -> u32 {
        self.probes * self.rays
    }
}

// ---------------------------------------------------------------------------------------------
// Scene

#[derive(Clone, Copy)]
struct Tri {
    v: [[f32; 3]; 3],
    albedo: u32,
}

fn sub(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn cross(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

fn dot(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn rgba8(c: [f32; 4]) -> u32 {
    let byte = |v: f32| (v.clamp(0.0, 1.0) * 255.0).round() as u32;
    byte(c[0]) | (byte(c[1]) << 8) | (byte(c[2]) << 16) | (byte(c[3]) << 24)
}

/// Lakeside-like rolling ground (metres).
fn height(x: f32, z: f32) -> f32 {
    3.0 * libm::sinf(x * 0.045) * libm::cosf(z * 0.038) + 1.2 * libm::sinf(x * 0.13 + z * 0.09) + 0.4 * libm::cosf(z * 0.31 - x * 0.07)
}

fn terrain() -> Vec<Tri> {
    let n = TERRAIN_CELLS;
    let step = 2.0 * TERRAIN_HALF / n as f32;
    let at = |i: u32, j: u32| {
        let (x, z) = (-TERRAIN_HALF + i as f32 * step, -TERRAIN_HALF + j as f32 * step);
        [x, height(x, z), z]
    };
    let ground = rgba8([0.28, 0.33, 0.16, 1.0]);
    let mut tris = Vec::with_capacity((n * n * 2) as usize);
    for j in 0..n {
        for i in 0..n {
            let (a, b, c, d) = (at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1));
            tris.push(Tri { v: [a, c, b], albedo: ground });
            tris.push(Tri { v: [a, d, c], albedo: ground });
        }
    }
    tris
}

/// A GLB's triangles in its scene's space, each with its material's base colour.
fn glb(path: &Path) -> Vec<Tri> {
    let (doc, buffers, _) = gltf::import(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let mut tris = Vec::new();
    let scene = doc.default_scene().or_else(|| doc.scenes().next()).expect("a scene");
    let mut stack: Vec<(gltf::Node, glam::Mat4)> = scene.nodes().map(|n| (n, glam::Mat4::IDENTITY)).collect();
    while let Some((node, parent)) = stack.pop() {
        let world = parent * glam::Mat4::from_cols_array_2d(&node.transform().matrix());
        if let Some(mesh) = node.mesh() {
            for primitive in mesh.primitives() {
                let reader = primitive.reader(|b| Some(&buffers[b.index()]));
                let Some(positions) = reader.read_positions() else { continue };
                let positions: Vec<[f32; 3]> = positions.map(|p| world.transform_point3(glam::Vec3::from(p)).to_array()).collect();
                let indices: Vec<u32> = match reader.read_indices() {
                    Some(indices) => indices.into_u32().collect(),
                    None => (0..positions.len() as u32).collect(),
                };
                let albedo = rgba8(primitive.material().pbr_metallic_roughness().base_color_factor());
                for t in indices.as_chunks::<3>().0 {
                    tris.push(Tri { v: t.map(|i| positions[i as usize]), albedo });
                }
            }
        }
        stack.extend(node.children().map(|c| (c, world)));
    }
    tris
}

fn assets() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/showcase/game/assets")
}

/// A small deterministic generator (the scene is the same every run).
struct Lcg(u64);

impl Lcg {
    fn unit(&mut self) -> f32 {
        self.0 = self.0.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
        ((self.0 >> 40) as f32) / (1u64 << 24) as f32
    }

    fn range(&mut self, lo: f32, hi: f32) -> f32 {
        lo + (hi - lo) * self.unit()
    }
}

fn place(mesh: &[Tri], at: [f32; 3], scale: f32, yaw: f32, out: &mut Vec<Tri>) {
    let m = glam::Mat4::from_scale_rotation_translation(glam::Vec3::splat(scale), glam::Quat::from_rotation_y(yaw), glam::Vec3::from(at));
    out.extend(mesh.iter().map(|t| Tri { v: t.v.map(|p| m.transform_point3(glam::Vec3::from(p)).to_array()), albedo: t.albedo }));
}

/// How a tree's crown reaches the rays.
#[derive(Clone, Copy, Debug)]
enum Crowns {
    /// The showcase's own leaf cards (traced opaque: no alpha test, so a floor).
    Cards,
    /// An ellipsoid of `CROWN_SEGMENTS` x `CROWN_RINGS` quads in the crown's box: the kind of
    /// simplified proxy a DDGI scene traces instead of leaves.
    Proxy,
}

const CROWN_SEGMENTS: u32 = 12;
const CROWN_RINGS: u32 = 6;

fn crown_proxy(foliage: &[Tri]) -> Vec<Tri> {
    let mut b = Aabb::EMPTY;
    foliage.iter().for_each(|t| t.v.iter().for_each(|p| b.grow(*p)));
    let centre = [0, 1, 2].map(|k| 0.5 * (b.lo[k] + b.hi[k]));
    let radius = [0, 1, 2].map(|k| 0.45 * (b.hi[k] - b.lo[k]));
    let albedo = foliage.first().map_or(0xff30_6030, |t| t.albedo);
    let at = |ring: u32, seg: u32| {
        let theta = std::f32::consts::PI * ring as f32 / CROWN_RINGS as f32;
        let phi = std::f32::consts::TAU * seg as f32 / CROWN_SEGMENTS as f32;
        let (st, ct, sp, cp) = (libm::sinf(theta), libm::cosf(theta), libm::sinf(phi), libm::cosf(phi));
        [centre[0] + radius[0] * st * cp, centre[1] + radius[1] * ct, centre[2] + radius[2] * st * sp]
    };
    let mut tris = Vec::new();
    for ring in 0..CROWN_RINGS {
        for seg in 0..CROWN_SEGMENTS {
            let (a, b2, c, d) = (at(ring, seg), at(ring, seg + 1), at(ring + 1, seg + 1), at(ring + 1, seg));
            tris.push(Tri { v: [a, b2, c], albedo });
            tris.push(Tri { v: [a, c, d], albedo });
        }
    }
    tris
}

/// The Lakeside proxy: heightfield, `TREES` trees of the showcase's own LOD (`lod`) with `crowns`,
/// and rocks. None when the showcase's fetched assets are missing.
fn lakeside(lod: u32, crowns: Crowns) -> Option<Vec<Tri>> {
    let dir = assets();
    let species = ["broadleaf-0", "broadleaf-1", "broadleaf-2", "pine-0", "pine-1"];
    let mut kinds = Vec::new();
    for s in species {
        let mut tree = Vec::new();
        for part in ["foliage", "wood"] {
            let path = dir.join(format!("tree-{s}-lod{lod}-{part}.glb"));
            if !path.exists() {
                eprintln!("skipped: {} not fetched (node scripts/showcase-assets.ts fetch)", path.display());
                return None;
            }
            let part_tris = glb(&path);
            match (part, crowns) {
                ("foliage", Crowns::Proxy) => tree.extend(crown_proxy(&part_tris)),
                _ => tree.extend(part_tris),
            }
        }
        kinds.push(tree);
    }
    let rocks: Vec<Vec<Tri>> = (0..3).map(|i| glb(&dir.join(format!("rock-{i}.glb")))).collect();
    let mut tris = terrain();
    let mut rng = Lcg(0x5eed);
    let reach = TERRAIN_HALF - 6.0;
    for i in 0..TREES {
        let (x, z) = (rng.range(-reach, reach), rng.range(-reach, reach));
        place(&kinds[i as usize % kinds.len()], [x, height(x, z) - 0.1, z], rng.range(0.75, 1.3), rng.range(0.0, std::f32::consts::TAU), &mut tris);
    }
    for i in 0..ROCKS {
        let (x, z) = (rng.range(-reach, reach), rng.range(-reach, reach));
        place(&rocks[i as usize % rocks.len()], [x, height(x, z), z], rng.range(0.8, 2.5), rng.range(0.0, std::f32::consts::TAU), &mut tris);
    }
    Some(tris)
}

/// The probe centres of `GRID`, each `1 + 2 * layer` metres above the ground under it.
fn probe_grid() -> Vec<[f32; 4]> {
    let half = [GRID[0] as f32 * GRID_SPACING * 0.5, 0.0, GRID[2] as f32 * GRID_SPACING * 0.5];
    let mut probes = Vec::new();
    for z in 0..GRID[2] {
        for y in 0..GRID[1] {
            for x in 0..GRID[0] {
                let (px, pz) = (-half[0] + (x as f32 + 0.5) * GRID_SPACING, -half[2] + (z as f32 + 0.5) * GRID_SPACING);
                probes.push([px, height(px, pz) + 1.0 + 2.0 * y as f32, pz, 0.0]);
            }
        }
    }
    probes
}

// ---------------------------------------------------------------------------------------------
// BVH (binned SAH, binary, both child boxes in the parent)

#[derive(Clone, Copy, Debug)]
struct Aabb {
    lo: [f32; 3],
    hi: [f32; 3],
}

impl Aabb {
    const EMPTY: Aabb = Aabb { lo: [f32::MAX; 3], hi: [f32::MIN; 3] };

    fn grow(&mut self, p: [f32; 3]) {
        self.lo = std::array::from_fn(|k| self.lo[k].min(p[k]));
        self.hi = std::array::from_fn(|k| self.hi[k].max(p[k]));
    }

    fn join(&mut self, o: &Aabb) {
        self.grow(o.lo);
        self.grow(o.hi);
    }

    fn area(&self) -> f32 {
        let e = sub(self.hi, self.lo);
        if e[0] < 0.0 {
            return 0.0;
        }
        2.0 * (e[0] * e[1] + e[1] * e[2] + e[2] * e[0])
    }

    fn of(t: &Tri) -> Aabb {
        let mut b = Aabb::EMPTY;
        t.v.iter().for_each(|p| b.grow(*p));
        b
    }
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct GpuChild {
    lo: [f32; 3],
    first: u32,
    hi: [f32; 3],
    n: u32,
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct GpuNode {
    a: GpuChild,
    b: GpuChild,
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct GpuTri {
    v0: [f32; 4],
    e1: [f32; 4],
    e2: [f32; 4],
}

struct Bvh {
    nodes: Vec<GpuNode>,
    /// The triangles in leaf order.
    tris: Vec<Tri>,
    depth: usize,
}

/// The SAH bin of centre coordinate `c` along `axis` of the centres' box.
fn bin_of(centres: &Aabb, axis: usize, c: f32) -> usize {
    let extent = centres.hi[axis] - centres.lo[axis];
    (((c - centres.lo[axis]) / extent * SAH_BINS as f32) as usize).min(SAH_BINS - 1)
}

struct Builder<'a> {
    tris: &'a [Tri],
    boxes: Vec<Aabb>,
    centres: Vec<[f32; 3]>,
    order: Vec<u32>,
    nodes: Vec<GpuNode>,
    depth: usize,
}

impl Builder<'_> {
    fn bounds(&self, range: std::ops::Range<usize>) -> (Aabb, Aabb) {
        let (mut all, mut centres) = (Aabb::EMPTY, Aabb::EMPTY);
        for &i in &self.order[range] {
            all.join(&self.boxes[i as usize]);
            centres.grow(self.centres[i as usize]);
        }
        (all, centres)
    }

    /// The SAH's best split of `range`: (axis, last bin on the left, cost), None when the centres
    /// coincide.
    fn split(&self, range: std::ops::Range<usize>, centres: &Aabb) -> Option<(usize, usize, f32)> {
        let mut best: Option<(usize, usize, f32)> = None;
        for axis in 0..3 {
            if centres.hi[axis] - centres.lo[axis] <= 0.0 {
                continue;
            }
            let mut bins = [(Aabb::EMPTY, 0usize); SAH_BINS];
            for &i in &self.order[range.clone()] {
                let bin = &mut bins[bin_of(centres, axis, self.centres[i as usize][axis])];
                bin.0.join(&self.boxes[i as usize]);
                bin.1 += 1;
            }
            let mut right = [(0.0f32, 0usize); SAH_BINS];
            let (mut acc, mut count) = (Aabb::EMPTY, 0);
            for b in (1..SAH_BINS).rev() {
                acc.join(&bins[b].0);
                count += bins[b].1;
                right[b] = (acc.area(), count);
            }
            let (mut acc, mut count) = (Aabb::EMPTY, 0);
            for b in 0..SAH_BINS - 1 {
                acc.join(&bins[b].0);
                count += bins[b].1;
                let (r_area, r_count) = right[b + 1];
                if count == 0 || r_count == 0 {
                    continue;
                }
                let cost = acc.area() * count as f32 + r_area * r_count as f32;
                if best.is_none_or(|(_, _, c)| cost < c) {
                    best = Some((axis, b, cost));
                }
            }
        }
        best
    }

    /// Builds `range` as a child: a leaf, or a node whose index it returns.
    fn child(&mut self, range: std::ops::Range<usize>, depth: usize) -> GpuChild {
        self.depth = self.depth.max(depth);
        let (all, centres) = self.bounds(range.clone());
        let count = range.len();
        let leaf = GpuChild { lo: all.lo, first: range.start as u32, hi: all.hi, n: count as u32 };
        if count <= LEAF_MAX {
            return leaf;
        }
        let split = self.split(range.clone(), &centres);
        if split.is_none_or(|(_, _, cost)| cost >= all.area() * count as f32) && count <= LEAF_MAX * 2 {
            return leaf;
        }
        let mut left = count / 2;
        if let Some((axis, last, _)) = split {
            let slice = &mut self.order[range.clone()];
            let mut at = 0;
            for i in 0..slice.len() {
                if bin_of(&centres, axis, self.centres[slice[i] as usize][axis]) <= last {
                    slice.swap(i, at);
                    at += 1;
                }
            }
            // Both sides hold a centre by the binning; halve by count if rounding said otherwise.
            if at > 0 && at < count {
                left = at;
            }
        }
        let mid = range.start + left;
        let index = self.nodes.len();
        self.nodes.push(GpuNode::zeroed());
        let a = self.child(range.start..mid, depth + 1);
        let b = self.child(mid..range.end, depth + 1);
        self.nodes[index] = GpuNode { a, b };
        GpuChild { lo: all.lo, first: index as u32, hi: all.hi, n: 0 }
    }
}

fn build_bvh(tris: &[Tri]) -> Bvh {
    let boxes: Vec<Aabb> = tris.iter().map(Aabb::of).collect();
    let centres = boxes.iter().map(|b| [0, 1, 2].map(|k| 0.5 * (b.lo[k] + b.hi[k]))).collect();
    let mut builder = Builder { tris, boxes, centres, order: (0..tris.len() as u32).collect(), nodes: Vec::new(), depth: 0 };
    let root = builder.child(0..tris.len(), 0);
    if root.n > 0 {
        // A scene of one leaf: a root node with an empty second child.
        let empty = GpuChild { lo: [f32::MAX; 3], first: 0, hi: [f32::MIN; 3], n: 1 };
        builder.nodes.push(GpuNode { a: root, b: empty });
    }
    let ordered = builder.order.iter().map(|&i| builder.tris[i as usize]).collect();
    Bvh { nodes: builder.nodes, tris: ordered, depth: builder.depth }
}

fn gpu_tris(tris: &[Tri]) -> Vec<GpuTri> {
    tris.iter()
        .map(|t| {
            let (e1, e2) = (sub(t.v[1], t.v[0]), sub(t.v[2], t.v[0]));
            GpuTri { v0: [t.v[0][0], t.v[0][1], t.v[0][2], f32::from_bits(t.albedo)], e1: [e1[0], e1[1], e1[2], 0.0], e2: [e2[0], e2[1], e2[2], 0.0] }
        })
        .collect()
}

/// Moller-Trumbore, as the shader's `tri_t`.
fn tri_t(t: &Tri, o: [f32; 3], d: [f32; 3]) -> Option<f32> {
    let (e1, e2) = (sub(t.v[1], t.v[0]), sub(t.v[2], t.v[0]));
    let p = cross(d, e2);
    let det = dot(e1, p);
    if det.abs() < 1.0e-12 {
        return None;
    }
    let inv = 1.0 / det;
    let s = sub(o, t.v[0]);
    let u = dot(s, p) * inv;
    let q = cross(s, e1);
    let v = dot(d, q) * inv;
    let dist = dot(e2, q) * inv;
    (u >= 0.0 && v >= 0.0 && u + v <= 1.0 && dist > 1.0e-4).then_some(dist)
}

/// The nearest hit over every triangle (the twin the BVH walk must agree with).
fn brute_force(tris: &[Tri], o: [f32; 3], d: [f32; 3]) -> Option<f32> {
    tris.iter().filter_map(|t| tri_t(t, o, d)).min_by(f32::total_cmp)
}

/// The shader's `fibonacci` turned by `rot` (rows).
fn ray_dir(i: u32, count: u32, rot: &[[f32; 4]; 3]) -> [f32; 3] {
    let z = 1.0 - (2.0 * i as f32 + 1.0) / count as f32;
    let r = (1.0 - z * z).max(0.0).sqrt();
    let phi = i as f32 * 2.399_963_2;
    let f = [r * libm::cosf(phi), r * libm::sinf(phi), z];
    let d = [0, 1, 2].map(|k| dot([rot[k][0], rot[k][1], rot[k][2]], f));
    let len = dot(d, d).sqrt();
    d.map(|c| c / len)
}

/// A rotation that differs every frame (DDGI turns its ray set each update).
fn rotation(frame: u32) -> [[f32; 4]; 3] {
    let q = glam::Quat::from_euler(glam::EulerRot::YXZ, frame as f32 * 2.399_963, frame as f32 * 1.1, frame as f32 * 0.7).normalize();
    let m = glam::Mat3::from_quat(q).transpose();
    [m.x_axis, m.y_axis, m.z_axis].map(|r| [r.x, r.y, r.z, 0.0])
}

// ---------------------------------------------------------------------------------------------
// CPU rows

fn checker_room() -> Vec<Tri> {
    // A floor, two walls and a box: enough structure for a several-level tree.
    let mut tris = Vec::new();
    let quad = |a: [f32; 3], b: [f32; 3], c: [f32; 3], d: [f32; 3], out: &mut Vec<Tri>| {
        out.push(Tri { v: [a, b, c], albedo: 0xff80_8080 });
        out.push(Tri { v: [a, c, d], albedo: 0xff80_8080 });
    };
    for i in 0..16 {
        for j in 0..16 {
            let (x, z) = (i as f32 - 8.0, j as f32 - 8.0);
            quad([x, 0.0, z], [x, 0.0, z + 1.0], [x + 1.0, 0.0, z + 1.0], [x + 1.0, 0.0, z], &mut tris);
        }
    }
    quad([-8.0, 0.0, -8.0], [8.0, 0.0, -8.0], [8.0, 4.0, -8.0], [-8.0, 4.0, -8.0], &mut tris);
    quad([-8.0, 0.0, -8.0], [-8.0, 4.0, -8.0], [-8.0, 4.0, 8.0], [-8.0, 0.0, 8.0], &mut tris);
    for k in 0..6 {
        let y = 0.25 * k as f32;
        quad([1.0, y, 1.0], [2.0, y, 1.0], [2.0, y + 1.0, 2.0], [1.0, y + 1.0, 2.0], &mut tris);
    }
    tris
}

#[test]
fn the_bvh_holds_every_triangle_once_and_each_box_bounds_its_subtree() {
    let tris = checker_room();
    let bvh = build_bvh(&tris);
    assert_eq!(bvh.tris.len(), tris.len());
    let mut seen = vec![0u32; tris.len()];
    let mut stack = vec![0usize];
    while let Some(index) = stack.pop() {
        let node = bvh.nodes[index];
        for child in [node.a, node.b] {
            if child.lo[0] > child.hi[0] {
                continue;
            }
            if child.n > 0 {
                for i in child.first..child.first + child.n {
                    seen[i as usize] += 1;
                    let b = Aabb::of(&bvh.tris[i as usize]);
                    assert!((0..3).all(|k| b.lo[k] >= child.lo[k] && b.hi[k] <= child.hi[k]), "leaf box holds its triangles");
                }
            } else {
                let inner = bvh.nodes[child.first as usize];
                for grand in [inner.a, inner.b].into_iter().filter(|g| g.lo[0] <= g.hi[0]) {
                    assert!((0..3).all(|k| grand.lo[k] >= child.lo[k] && grand.hi[k] <= child.hi[k]), "node box holds its children");
                }
                stack.push(child.first as usize);
            }
        }
    }
    assert!(seen.iter().all(|&s| s == 1), "every triangle is in exactly one leaf");
    assert!(bvh.depth < GPU_STACK, "depth {} fits the shader's stack", bvh.depth);
}

#[test]
fn the_trace_shader_validates_within_webgpu_core() {
    for stack in [Stack::Private, Stack::Workgroup] {
        let module = naga::front::wgsl::parse_str(&trace_source(stack)).unwrap_or_else(|e| panic!("{stack:?}: {e}"));
        naga::valid::Validator::new(naga::valid::ValidationFlags::all(), naga::valid::Capabilities::empty()).validate(&module).unwrap_or_else(|e| panic!("{stack:?}: {e:?}"));
    }
}

// ---------------------------------------------------------------------------------------------
// GPU

fn gpu_with(features: wgpu::Features) -> Option<Gpu> {
    let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
    match Gpu::headless_with(features) {
        Ok(gpu) => {
            if require {
                assert_eq!(gpu.receipt().backend, "metal", "GENEX_REQUIRE_METAL=1 but the adapter is not Metal");
            }
            Some(gpu)
        }
        Err(error) if require => panic!("GENEX_REQUIRE_METAL=1 and no adapter with {features:?}: {error}"),
        Err(error) => {
            eprintln!("skipped: no adapter with {features:?} ({error})");
            None
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    rot: [[f32; 4]; 3],
    sun_dir: [f32; 4],
    sun: [f32; 4],
    sky: [f32; 4],
    grid_min: [f32; 4],
    grid_size: [f32; 4],
    rays_per_probe: u32,
    probe_count: u32,
    probe_first: u32,
    hysteresis: f32,
}

struct Tracer {
    trace: wgpu::ComputePipeline,
    blend: wgpu::ComputePipeline,
    group: wgpu::BindGroup,
    params: wgpu::Buffer,
    rays: wgpu::Buffer,
}

fn buffer(gpu: &Gpu, label: &str, usage: wgpu::BufferUsages, bytes: &[u8]) -> wgpu::Buffer {
    use wgpu::util::DeviceExt;
    gpu.device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some(label), contents: bytes, usage })
}

/// Where the traversal stack lives.
#[derive(Clone, Copy, Debug)]
enum Stack {
    Private,
    Workgroup,
}

/// The trace shader with its stack in `stack`.
fn trace_source(stack: Stack) -> String {
    let source = include_str!("ddgi_trace.wgsl");
    match stack {
        Stack::Private => source.to_owned(),
        Stack::Workgroup => {
            let declared = "    var stack: array<u32, STACK>;\n";
            assert!(source.contains(declared), "the private stack's declaration");
            source.replace(declared, "").replace("stack[", "stacks[lane][") + "\nvar<workgroup> stacks: array<array<u32, STACK>, 64>;\n"
        }
    }
}

fn tracer(gpu: &Gpu, bvh: &Bvh, probes: &[[f32; 4]], max_rays: u32, stack: Stack) -> Tracer {
    use wgpu::BufferUsages as U;
    let device = &gpu.device;
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("ddgi trace"), source: wgpu::ShaderSource::Wgsl(trace_source(stack).into()) });
    let pipeline = |entry: &str| {
        device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor { label: Some(entry), layout: None, module: &module, entry_point: Some(entry), compilation_options: Default::default(), cache: None })
    };
    let (trace, blend) = (pipeline("cs_trace"), pipeline("cs_blend"));
    let params = device.create_buffer(&wgpu::BufferDescriptor { label: Some("ddgi params"), size: size_of::<Params>() as u64, usage: U::UNIFORM | U::COPY_DST, mapped_at_creation: false });
    let nodes = buffer(gpu, "ddgi nodes", U::STORAGE, bytemuck::cast_slice(&bvh.nodes));
    let tris = buffer(gpu, "ddgi tris", U::STORAGE, bytemuck::cast_slice(&gpu_tris(&bvh.tris)));
    let probe_buffer = buffer(gpu, "ddgi probes", U::STORAGE, bytemuck::cast_slice(probes));
    let rays = device.create_buffer(&wgpu::BufferDescriptor { label: Some("ddgi rays"), size: u64::from(max_rays) * 16, usage: U::STORAGE | U::COPY_SRC, mapped_at_creation: false });
    // A.4's atlas shape for the grid: X x 2Y x 3Z texels, rgba16float.
    let atlas_size = wgpu::Extent3d { width: GRID[0], height: 2 * GRID[1], depth_or_array_layers: 3 * GRID[2] };
    let atlas = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("ddgi atlas"),
        size: atlas_size,
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D3,
        format: wgpu::TextureFormat::Rgba16Float,
        usage: wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    });
    let sampler = device.create_sampler(&wgpu::SamplerDescriptor { mag_filter: wgpu::FilterMode::Linear, min_filter: wgpu::FilterMode::Linear, ..Default::default() });
    let view = atlas.create_view(&Default::default());
    let layout = trace.get_bind_group_layout(0);
    let entries = [
        wgpu::BindGroupEntry { binding: 0, resource: params.as_entire_binding() },
        wgpu::BindGroupEntry { binding: 1, resource: nodes.as_entire_binding() },
        wgpu::BindGroupEntry { binding: 2, resource: tris.as_entire_binding() },
        wgpu::BindGroupEntry { binding: 3, resource: probe_buffer.as_entire_binding() },
        wgpu::BindGroupEntry { binding: 4, resource: rays.as_entire_binding() },
        wgpu::BindGroupEntry { binding: 5, resource: wgpu::BindingResource::TextureView(&view) },
        wgpu::BindGroupEntry { binding: 6, resource: wgpu::BindingResource::Sampler(&sampler) },
    ];
    let group = device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("ddgi"), layout: &layout, entries: &entries });
    Tracer { trace, blend, group, params, rays }
}

fn params_for(config: Config, frame: u32, probes_total: u32) -> Params {
    let sun_dir = glam::Vec3::new(0.794, 0.35, 0.596).normalize();
    let first = (frame * config.probes) % probes_total;
    let half = [GRID[0] as f32 * GRID_SPACING * 0.5, GRID[2] as f32 * GRID_SPACING * 0.5];
    Params {
        rot: rotation(frame),
        sun_dir: [sun_dir.x, sun_dir.y, sun_dir.z, 0.0],
        sun: [3.0, 2.8, 2.5, 0.0],
        sky: [0.4, 0.55, 0.8, 0.0],
        grid_min: [-half[0], -6.0, -half[1], 0.0],
        grid_size: [2.0 * half[0], 20.0, 2.0 * half[1], 0.0],
        rays_per_probe: config.rays,
        probe_count: config.probes.min(probes_total - first),
        probe_first: first,
        hysteresis: 0.97,
    }
}

fn dispatch(encoder: &mut wgpu::CommandEncoder, tracer: &Tracer, blend_group: &wgpu::BindGroup, config: Config, stamps: Option<(&wgpu::QuerySet, u32)>) {
    let writes = |at: u32| stamps.map(|(set, base)| wgpu::ComputePassTimestampWrites { query_set: set, beginning_of_pass_write_index: Some(base + at), end_of_pass_write_index: Some(base + at + 1) });
    {
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("ddgi trace"), timestamp_writes: writes(0) });
        pass.set_pipeline(&tracer.trace);
        pass.set_bind_group(0, &tracer.group, &[]);
        pass.dispatch_workgroups(config.rays_a_frame().div_ceil(64), 1, 1);
    }
    let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("ddgi blend"), timestamp_writes: writes(2) });
    pass.set_pipeline(&tracer.blend);
    pass.set_bind_group(0, blend_group, &[]);
    pass.dispatch_workgroups((config.probes * 6).div_ceil(64), 1, 1);
}

/// The blend pipeline's own group over the tracer's resources (its auto layout drops what it does
/// not read).
fn blend_group(gpu: &Gpu, tracer: &Tracer, probes: usize) -> wgpu::BindGroup {
    let cubes = gpu.device.create_buffer(&wgpu::BufferDescriptor { label: Some("ddgi cubes"), size: probes as u64 * 6 * 16, usage: wgpu::BufferUsages::STORAGE, mapped_at_creation: false });
    let entries = [
        wgpu::BindGroupEntry { binding: 0, resource: tracer.params.as_entire_binding() },
        wgpu::BindGroupEntry { binding: 4, resource: tracer.rays.as_entire_binding() },
        wgpu::BindGroupEntry { binding: 7, resource: cubes.as_entire_binding() },
    ];
    gpu.device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("ddgi blend"), layout: &tracer.blend.get_bind_group_layout(0), entries: &entries })
}

fn read_buffer(gpu: &Gpu, source: &wgpu::Buffer, bytes: u64) -> Vec<u8> {
    let staging = gpu.device.create_buffer(&wgpu::BufferDescriptor { label: Some("ddgi read"), size: bytes, usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false });
    let mut encoder = gpu.device.create_command_encoder(&Default::default());
    encoder.copy_buffer_to_buffer(source, 0, &staging, 0, bytes);
    gpu.queue.submit([encoder.finish()]);
    staging.slice(..).map_async(wgpu::MapMode::Read, |r| r.expect("mapped"));
    gpu.device.poll(wgpu::PollType::wait_indefinitely()).expect("poll");
    let data = staging.slice(..).get_mapped_range().expect("range").to_vec();
    staging.unmap();
    data
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_software_trace_finds_the_closest_hit_as_brute_force_does() {
    let Some(gpu) = gpu_with(wgpu::Features::empty()) else { return };
    let mut tris = checker_room();
    // A few hundred scattered triangles so the tree is several levels deep.
    let mut rng = Lcg(7);
    for _ in 0..400 {
        let c = [rng.range(-7.0, 7.0), rng.range(0.2, 3.5), rng.range(-7.0, 7.0)];
        let mut r = || [rng.range(-0.4, 0.4), rng.range(-0.4, 0.4), rng.range(-0.4, 0.4)];
        let (a, b, d) = (r(), r(), r());
        tris.push(Tri { v: [[c[0] + a[0], c[1] + a[1], c[2] + a[2]], [c[0] + b[0], c[1] + b[1], c[2] + b[2]], [c[0] + d[0], c[1] + d[1], c[2] + d[2]]], albedo: 0xff40_8040 });
    }
    let bvh = build_bvh(&tris);
    let probes: Vec<[f32; 4]> = (0..8).map(|i| [i as f32 - 3.5, 1.5, 0.5 * i as f32 - 2.0, 0.0]).collect();
    let config = Config { probes: probes.len() as u32, rays: 128 };
    for stack in [Stack::Private, Stack::Workgroup] {
        let tracer = tracer(&gpu, &bvh, &probes, config.rays_a_frame(), stack);
    let blend = blend_group(&gpu, &tracer, probes.len());
    let params = Params { probe_first: 0, probe_count: config.probes, ..params_for(config, 3, config.probes) };
    gpu.queue.write_buffer(&tracer.params, 0, bytemuck::bytes_of(&params));
    let mut encoder = gpu.device.create_command_encoder(&Default::default());
    dispatch(&mut encoder, &tracer, &blend, config, None);
    gpu.queue.submit([encoder.finish()]);
    let out: Vec<[f32; 4]> = bytemuck::cast_slice(&read_buffer(&gpu, &tracer.rays, u64::from(config.rays_a_frame()) * 16)).to_vec();
    let (mut agree, mut hits) = (0, 0);
    for (i, ray) in out.iter().enumerate() {
        let (probe, r) = (i / config.rays as usize, i as u32 % config.rays);
        let o = [probes[probe][0], probes[probe][1], probes[probe][2]];
        let want = brute_force(&tris, o, ray_dir(r, config.rays, &params.rot));
        let got = (ray[3] < 1.0e29).then_some(if ray[3] < 0.0 { -ray[3] / 0.2 } else { ray[3] });
        hits += usize::from(want.is_some());
        let same = match (want, got) {
            (None, None) => true,
            (Some(w), Some(g)) => (w - g).abs() <= 1.0e-3 * w.max(1.0),
            _ => false,
        };
        agree += usize::from(same);
    }
    eprintln!("{stack:?}: {agree} of {} rays agree with brute force ({hits} hit)", out.len());
    assert!(hits > out.len() / 2, "the room is hit by most rays");
    assert!(agree as f64 >= 0.995 * out.len() as f64, "{stack:?}: {agree} of {} agree", out.len());
    }
}

/// GPU ms of trace and blend for `config` (median over the timed frames).
fn time_update(gpu: &Gpu, tracer: &Tracer, blend: &wgpu::BindGroup, config: Config, probes_total: u32) -> (f64, f64) {
    let frames = WARM_FRAMES + TIMED_FRAMES;
    let queries = gpu.device.create_query_set(&wgpu::QuerySetDescriptor { label: Some("ddgi timing"), ty: wgpu::QueryType::Timestamp, count: 4 });
    let resolve = gpu.device.create_buffer(&wgpu::BufferDescriptor { label: Some("ddgi timing"), size: 32, usage: wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC, mapped_at_creation: false });
    let period = f64::from(gpu.queue.get_timestamp_period());
    let (mut trace, mut blend_ms) = (Vec::new(), Vec::new());
    for frame in 0..frames {
        gpu.queue.write_buffer(&tracer.params, 0, bytemuck::bytes_of(&params_for(config, frame, probes_total)));
        let mut encoder = gpu.device.create_command_encoder(&Default::default());
        dispatch(&mut encoder, tracer, blend, config, Some((&queries, 0)));
        encoder.resolve_query_set(&queries, 0..4, &resolve, 0);
        gpu.queue.submit([encoder.finish()]);
        let stamps: Vec<u64> = read_buffer(gpu, &resolve, 32).as_chunks::<8>().0.iter().map(|b| u64::from_le_bytes(*b)).collect();
        if frame >= WARM_FRAMES {
            trace.push(stamps[1].saturating_sub(stamps[0]) as f64 * period / 1.0e6);
            blend_ms.push(stamps[3].saturating_sub(stamps[2]) as f64 * period / 1.0e6);
        }
    }
    let median = |v: &mut Vec<f64>| {
        v.sort_by(f64::total_cmp);
        v[v.len() / 2]
    };
    (median(&mut trace), median(&mut blend_ms))
}

/// D8 (plan B.11): the update's cost on this Mac and on an integrated GPU, per configuration.
/// The row was written first as the go condition (`estimate <= 2.0 ms` at the floor) and failed:
/// the cheapest floor update (crown proxies, the faster stack) estimated 10.9 ms on an M1-class
/// GPU and took 1.77 ms on this M4 Max, so DDGI is a no-go (2026-10-18) and the row now holds the
/// decision: it turns red when software rays get cheap enough to revisit D8.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_ddgi_software_rays_cost_over_two_ms_on_an_integrated_gpu_so_d8_stays_no_go() {
    let Some(gpu) = gpu_with(wgpu::Features::TIMESTAMP_QUERY) else { return };
    let probes = probe_grid();
    let mut rows = Vec::new();
    let mut floor_estimate: Option<f64> = None;
    for crowns in [Crowns::Proxy, Crowns::Cards] {
        let Some(tris) = lakeside(2, crowns) else { return };
        let bvh = build_bvh(&tris);
        assert!(bvh.depth < GPU_STACK, "{crowns:?} depth {}", bvh.depth);
        let max_rays = CONFIGS.iter().map(|c| c.rays_a_frame()).max().expect("configs");
        for stack in [Stack::Private, Stack::Workgroup] {
            let tracer = tracer(&gpu, &bvh, &probes, max_rays, stack);
            let blend = blend_group(&gpu, &tracer, probes.len());
            for config in CONFIGS {
                let best = (0..ATTEMPTS).map(|_| time_update(&gpu, &tracer, &blend, config, probes.len() as u32)).min_by(|a, b| (a.0 + a.1).total_cmp(&(b.0 + b.1))).expect("attempts");
                let total = best.0 + best.1;
                let mrays = f64::from(config.rays_a_frame()) / (best.0 * 1.0e3);
                let row = format!(
                    "{{\"row\":\"ddgi-software-rays\",\"scene\":\"lakeside-lod2-{crowns:?}\",\"stack\":\"{stack:?}\",\"triangles\":{},\"nodes\":{},\"depth\":{},\"probes\":{},\"rays\":{},\"rays_a_frame\":{},\"trace_ms\":{:.3},\"blend_ms\":{:.3},\"mac_ms\":{total:.3},\"primary_mrays_s\":{mrays:.0},\"integrated_ms\":[{:.2},{:.2}]}}",
                    bvh.tris.len(),
                    bvh.nodes.len(),
                    bvh.depth,
                    config.probes,
                    config.rays,
                    config.rays_a_frame(),
                    best.0,
                    best.1,
                    total * INTEGRATED_ALU_FACTOR,
                    total * INTEGRATED_BANDWIDTH_FACTOR,
                );
                eprintln!("{row}");
                rows.push(row);
                if config.probes == FLOOR_CONFIG.probes && config.rays == FLOOR_CONFIG.rays {
                    let estimate = total * INTEGRATED_ALU_FACTOR;
                    floor_estimate = Some(floor_estimate.map_or(estimate, |held| held.min(estimate)));
                }
            }
        }
    }
    if let Ok(path) = std::env::var("GENEX_PERF_OUT") {
        std::fs::write(path, rows.join("\n") + "\n").expect("perf rows");
    }
    let Some(estimate) = floor_estimate else { return };
    assert!(
        estimate > DDGI_BUDGET_MS,
        "the cheapest floor update ({} probes x {} rays: crown proxies, the faster stack) now costs {estimate:.2} ms on an integrated GPU, within {DDGI_BUDGET_MS} ms: revisit D8 (DDGI)",
        FLOOR_CONFIG.probes,
        FLOOR_CONFIG.rays
    );
}
