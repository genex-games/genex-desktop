//! Runtime LOD chains (game systems LOD-21): a model that reaches the runtime without the import
//! step's `genex_lods` levels gets the same kind of chain at load, built here with the importer's
//! parameters (`src/substrate/asset-import/lods.ts`): each level aims at half the previous one's
//! triangles, the coarsest relative error is [`RUNTIME_LOD_MAX_RELATIVE_ERROR`], the chain's length
//! is its largest part's (levels stop when one is no longer markedly coarser), and a part that
//! cannot be simplified that far repeats its last level. Unlike the importer, one simplification
//! is carried from level to level ([`simplify_levels`]; its quadrics keep measuring from the
//! original surface), so a whole chain costs about one run, and a model past
//! [`RUNTIME_LOD_MAX_TRIANGLES`] is left whole: the import step is its only source of levels. Vertices where two parts meet are locked,
//! so parts stay joined. Each level's error is object-space: the largest of the simplifier's error
//! times the mesh's extent, how far the part's vertices lie from the level ([`vertex_deviation`],
//! the importer's `lod-deviation.ts`) and the level before's error.
//!
//! The simplifier ([`simplify`]) is our port of meshoptimizer's edge-collapse simplifier (MIT,
//! Arseny Kapoulkine): quadric error on positions, vertices classified as manifold, border, seam
//! or locked, collapses ranked by error and applied in passes without moving a vertex twice, and
//! no collapse that flips a triangle. It leaves out meshoptimizer's attribute quadrics, its
//! complex-vertex class, `Prune`, `ErrorClamped` and `PreserveFolds` (the importer's call uses the
//! last three since LOD-09), so a runtime chain is close to the importer's but not bit-equal; the
//! importer stays the source of chains for delivered games.
//!
//! Single-threaded, no hashing and no clock: the output is a pure function of the input, the same
//! bits on every destination (only IEEE `sqrt` is used, never a platform transcendental).

use std::collections::BTreeMap;

use crate::mesh::{LOD_MAX_LEVELS, LOD_MIN_TRIANGLES, LodChain, LodLevel};
use crate::scene::ModelPart;

/// Each level aims at this share of the previous level's triangles (the importer's `LOD_RATIO`).
pub const RUNTIME_LOD_RATIO_SHIFT: u32 = 1;
/// A level must keep at most this share of the previous one's triangles to count as coarser.
pub const RUNTIME_LOD_MIN_REDUCTION: f32 = 0.85;
/// The coarsest error a level may have, relative to the mesh's extent.
pub const RUNTIME_LOD_MAX_RELATIVE_ERROR: f32 = 0.1;
/// The most triangles a model may have for its chain to be built at load: past it the load would
/// stall a frame for too long (LOD-21 measured a 99k-triangle model's chain at about 150 ms
/// natively and 175 ms as wasm32 in Node 24, in release on a busy machine), so the model draws
/// whole and the import step is its only source.
pub const RUNTIME_LOD_MAX_TRIANGLES: u32 = 100_000;

/// No vertex (an empty slot of `loop` or `loopback`).
const NONE: u32 = u32::MAX;
/// Indices a triangle.
const TRIANGLE: usize = 3;
/// How much a border edge's quadric weighs: borders keep their shape (meshoptimizer's 10).
const BORDER_EDGE_WEIGHT: f32 = 10.0;
/// How much a seam edge's quadric weighs (meshoptimizer's 1).
const SEAM_EDGE_WEIGHT: f32 = 1.0;
/// A pass accepts collapses up to this factor over the error of its last expected collapse
/// (meshoptimizer's 1.5: many collapses are locked by their neighbours').
const PASS_ERROR_SLACK: f32 = 1.5;
/// A pass stops early on the slack only once it has this share of its goal: each collapse locks
/// about six others (meshoptimizer's 1/6).
const PASS_MIN_SHARE_DIVISOR: usize = 6;
/// A level stops once it is within this fraction of its target (1/32): the last passes before an
/// exact target collapse a handful of edges each, for a few triangles.
const LEVEL_TARGET_SLACK_DIVISOR: usize = 32;
/// Grid cells per axis at most for [`vertex_deviation`] (the importer's bound: 128³ offsets).
const GRID_MAX_CELLS_PER_AXIS: usize = 128;

/// What [`add_runtime_chains`] did with a model.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RuntimeLodOutcome {
    /// Every part got a chain of this many levels.
    Built {
        /// The levels past the mesh itself.
        levels: u32,
    },
    /// A part already carries a chain (imported or authored): nothing was built.
    Imported,
    /// Fewer triangles than [`LOD_MIN_TRIANGLES`]: the importer would not simplify it either.
    BelowThreshold,
    /// More triangles than [`RUNTIME_LOD_MAX_TRIANGLES`]: building would stall the load.
    OverBudget,
    /// The geometry cannot be read (an index past its vertices, a position that is not finite,
    /// a part with no triangles) or no level is markedly coarser.
    NotCoarser,
}

impl RuntimeLodOutcome {
    /// The wire spelling, for a load's log line.
    pub const fn wire(self) -> &'static str {
        match self {
            RuntimeLodOutcome::Built { .. } => "built",
            RuntimeLodOutcome::Imported => "imported",
            RuntimeLodOutcome::BelowThreshold => "below-threshold",
            RuntimeLodOutcome::OverBudget => "over-budget",
            RuntimeLodOutcome::NotCoarser => "not-coarser",
        }
    }
}

/// Give every part of a model without levels its runtime chain, all or nothing: the parts are left
/// unchanged unless every one gets a valid chain.
pub fn add_runtime_chains(parts: &mut [ModelPart]) -> RuntimeLodOutcome {
    if parts.iter().any(|part| part.lods.is_some()) {
        return RuntimeLodOutcome::Imported;
    }
    let triangles: usize = parts.iter().map(|part| part.mesh.indices.len() / TRIANGLE).sum();
    if triangles < LOD_MIN_TRIANGLES as usize {
        return RuntimeLodOutcome::BelowThreshold;
    }
    if triangles > RUNTIME_LOD_MAX_TRIANGLES as usize {
        return RuntimeLodOutcome::OverBudget;
    }
    let inputs: Vec<PartInput> = parts.iter().map(PartInput::of).collect();
    if inputs.iter().any(|input| !input.readable()) {
        return RuntimeLodOutcome::NotCoarser;
    }
    let locks = shared_vertex_locks(&inputs);
    let candidates: Vec<Vec<(Vec<u32>, f32)>> = inputs.iter().zip(&locks).map(|(input, lock)| candidate_levels(input, lock)).collect();
    let count = chain_length(&inputs, &candidates);
    if count == 0 {
        return RuntimeLodOutcome::NotCoarser;
    }
    let chains: Vec<LodChain> = inputs.iter().zip(candidates).map(|(input, levels)| part_chain(input, levels, count)).collect();
    if !chains.iter().zip(&inputs).all(|(chain, input)| chain_is_valid(chain, input.positions.len())) {
        return RuntimeLodOutcome::NotCoarser;
    }
    for (part, chain) in parts.iter_mut().zip(chains) {
        part.lods = Some(chain);
    }
    RuntimeLodOutcome::Built { levels: count as u32 }
}

/// One part as the chain builder reads it.
struct PartInput {
    positions: Vec<[f32; 3]>,
    indices: Vec<u32>,
}

impl PartInput {
    fn of(part: &ModelPart) -> PartInput {
        PartInput { positions: part.mesh.vertices.iter().map(|vertex| vertex.position).collect(), indices: part.mesh.indices.clone() }
    }

    /// Whole triangles over its own vertices, every position finite, at least one triangle.
    fn readable(&self) -> bool {
        let whole = !self.indices.is_empty() && self.indices.len().is_multiple_of(TRIANGLE);
        let in_mesh = self.indices.iter().all(|index| (*index as usize) < self.positions.len());
        let finite = self.positions.iter().flatten().all(|value| value.is_finite());
        whole && in_mesh && finite
    }
}

/// A position's key: its three floats' bits, -0 read as 0.
fn position_key(position: [f32; 3]) -> [u32; 3] {
    position.map(|value| (value + 0.0).to_bits())
}

/// The vertices a part's triangles use, each once, in first-use order.
fn used_vertices(input: &PartInput) -> Vec<u32> {
    let mut seen = vec![false; input.positions.len()];
    let mut used = Vec::new();
    for &vertex in &input.indices {
        if !std::mem::replace(&mut seen[vertex as usize], true) {
            used.push(vertex);
        }
    }
    used
}

/// Per part, `true` on each vertex its triangles use whose position another part's triangles also
/// use: where parts meet (the importer's `sharedVertexLocks`).
fn shared_vertex_locks(inputs: &[PartInput]) -> Vec<Vec<bool>> {
    let used: Vec<Vec<u32>> = inputs.iter().map(used_vertices).collect();
    let mut owners: BTreeMap<[u32; 3], Option<usize>> = BTreeMap::new();
    for (part, vertices) in used.iter().enumerate() {
        for &vertex in vertices {
            let key = position_key(inputs[part].positions[vertex as usize]);
            let owner = owners.entry(key).or_insert(Some(part));
            if *owner != Some(part) {
                *owner = None;
            }
        }
    }
    inputs
        .iter()
        .zip(&used)
        .map(|(input, vertices)| {
            let mut lock = vec![false; input.positions.len()];
            for &vertex in vertices {
                if owners.get(&position_key(input.positions[vertex as usize])) == Some(&None) {
                    lock[vertex as usize] = true;
                }
            }
            lock
        })
        .collect()
}

/// The index count level `level` (1-based) aims at: `ratio^level` of the original's, whole
/// triangles.
fn level_target(original: usize, level: u32) -> usize {
    original / (TRIANGLE << (RUNTIME_LOD_RATIO_SHIFT * level)) * TRIANGLE
}

/// A part's candidate levels: one simplification carried towards each of the
/// [`LOD_MAX_LEVELS`] targets, each level with its relative error.
fn candidate_levels(input: &PartInput, lock: &[bool]) -> Vec<(Vec<u32>, f32)> {
    let targets: Vec<usize> = (1..=LOD_MAX_LEVELS).map(|level| level_target(input.indices.len(), level)).collect();
    simplify_levels(&input.positions, &input.indices, lock, &targets, RUNTIME_LOD_MAX_RELATIVE_ERROR)
}

/// How many levels the largest part's candidates give before they stop getting coarser.
fn chain_length(inputs: &[PartInput], candidates: &[Vec<(Vec<u32>, f32)>]) -> usize {
    let Some(largest) = (0..inputs.len()).reduce(|most, each| if inputs[each].indices.len() > inputs[most].indices.len() { each } else { most }) else {
        return 0;
    };
    let mut previous = inputs[largest].indices.len();
    let mut length = 0;
    for (level, (indices, _)) in candidates[largest].iter().enumerate() {
        if indices.is_empty() || indices.len() as f32 > previous as f32 * RUNTIME_LOD_MIN_REDUCTION {
            break;
        }
        length = level + 1;
        previous = indices.len();
    }
    length
}

/// A part's first `count` candidate levels, each with its object-space error; a level that is
/// empty or finer than the one before repeats the one before.
fn part_chain(input: &PartInput, candidates: Vec<(Vec<u32>, f32)>, count: usize) -> LodChain {
    let scale = mesh_extent(&input.positions);
    let mut levels: Vec<LodLevel> = Vec::with_capacity(count);
    let mut last = LodLevel { indices: input.indices.clone(), error: 0.0 };
    for (indices, error) in candidates.into_iter().take(count) {
        let usable = !indices.is_empty() && indices.len() <= last.indices.len();
        if usable && indices != last.indices {
            let deviation = vertex_deviation(&input.positions, &input.indices, &indices);
            let error = (error * scale).max(deviation).max(last.error);
            last = LodLevel { indices, error };
        }
        levels.push(last.clone());
    }
    LodChain { levels, casters: 0 }
}

/// A chain the renderer takes (the importer's `validateLodSet`): at most [`LOD_MAX_LEVELS`]
/// levels of whole triangles, each no finer than the one before, errors finite, never negative
/// and never smaller than the one before, every index a vertex.
fn chain_is_valid(chain: &LodChain, vertex_count: usize) -> bool {
    let mut previous: Option<&LodLevel> = None;
    for level in &chain.levels {
        let whole = !level.indices.is_empty() && level.indices.len().is_multiple_of(TRIANGLE);
        let error_ok = level.error.is_finite() && level.error >= previous.map_or(0.0, |before| before.error);
        let coarser = previous.is_none_or(|before| level.indices.len() <= before.indices.len());
        let in_mesh = level.indices.iter().all(|index| (*index as usize) < vertex_count);
        if !(whole && error_ok && coarser && in_mesh) {
            return false;
        }
        previous = Some(level);
    }
    chain.levels.len() <= LOD_MAX_LEVELS as usize
}

// -------------------------------------------------------------------------------------------------
// The simplifier: our port of meshoptimizer's `meshopt_simplify` (MIT).

/// A vertex's place in the topology, which decides where it may collapse.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    /// Inside a closed surface, no attribute seam: collapses anywhere.
    Manifold,
    /// On one open border: collapses only along it.
    Border,
    /// On an attribute seam (two vertices at one position): collapses only along the seam.
    Seam,
    /// Anything else, or locked by the caller: never moves.
    Locked,
}

impl Kind {
    const fn at(self) -> usize {
        match self {
            Kind::Manifold => 0,
            Kind::Border => 1,
            Kind::Seam => 2,
            Kind::Locked => 3,
        }
    }

    const fn on_loop(self) -> bool {
        matches!(self, Kind::Border | Kind::Seam)
    }
}

/// Whether a vertex of the row's kind may collapse onto one of the column's (meshoptimizer's
/// `kCanCollapse` without its complex class).
const CAN_COLLAPSE: [[bool; 4]; 4] = [[true, true, true, true], [false, true, false, true], [false, false, true, true], [false, false, false, false]];

/// Whether an edge between the two kinds is guaranteed an opposite half-edge, so it is seen twice
/// (meshoptimizer's `kHasOpposite` without its complex class).
const HAS_OPPOSITE: [[bool; 4]; 4] = [[true, true, true, true], [true, false, true, false], [true, true, true, true], [true, false, true, false]];

/// A plane-distance quadric (meshoptimizer's `Quadric`): symmetric 3x3, a vector, a constant
/// and the total weight.
#[derive(Clone, Copy, Debug, Default)]
struct Quadric {
    a00: f32,
    a11: f32,
    a22: f32,
    a10: f32,
    a20: f32,
    a21: f32,
    b0: f32,
    b1: f32,
    b2: f32,
    c: f32,
    w: f32,
}

impl Quadric {
    /// The quadric of the plane `n·p + d = 0` with weight `w`.
    fn plane(n: [f32; 3], d: f32, w: f32) -> Quadric {
        let aw = n[0] * w;
        let bw = n[1] * w;
        let cw = n[2] * w;
        Quadric { a00: n[0] * aw, a11: n[1] * bw, a22: n[2] * cw, a10: n[1] * aw, a20: n[2] * aw, a21: n[2] * bw, b0: d * aw, b1: d * bw, b2: d * cw, c: d * d * w, w }
    }

    /// The quadric of a triangle's plane, weighted by the square root of its area (meshoptimizer:
    /// the error then scales linearly, which keeps silhouettes).
    fn triangle(p0: [f32; 3], p1: [f32; 3], p2: [f32; 3], weight: f32) -> Quadric {
        let (normal, area) = normalized(cross(sub(p1, p0), sub(p2, p0)));
        Quadric::plane(normal, -dot(normal, p0), area.sqrt() * weight)
    }

    /// The quadric of the plane through edge `p0 p1` perpendicular to its triangle (with `p2`),
    /// weighted by the edge's length: it holds a border or seam in place.
    fn edge(p0: [f32; 3], p1: [f32; 3], p2: [f32; 3], weight: f32) -> Quadric {
        let (along, length) = normalized(sub(p1, p0));
        let p20 = sub(p2, p0);
        let projected = dot(p20, along);
        let (perpendicular, _) = normalized(sub(p20, scaled(along, projected)));
        Quadric::plane(perpendicular, -dot(perpendicular, p0), length * weight)
    }

    fn add(&mut self, other: &Quadric) {
        self.a00 += other.a00;
        self.a11 += other.a11;
        self.a22 += other.a22;
        self.a10 += other.a10;
        self.a20 += other.a20;
        self.a21 += other.a21;
        self.b0 += other.b0;
        self.b1 += other.b1;
        self.b2 += other.b2;
        self.c += other.c;
        self.w += other.w;
    }

    /// The weighted squared distance of `v` from the quadric's planes.
    fn error(&self, v: [f32; 3]) -> f32 {
        let rx = (self.b0 + self.a10 * v[1]) * 2.0 + self.a00 * v[0];
        let ry = (self.b1 + self.a21 * v[2]) * 2.0 + self.a11 * v[1];
        let rz = (self.b2 + self.a20 * v[0]) * 2.0 + self.a22 * v[2];
        let r = self.c + rx * v[0] + ry * v[1] + rz * v[2];
        let s = if self.w == 0.0 { 0.0 } else { 1.0 / self.w };
        r.abs() * s
    }
}

fn sub(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn dot(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn cross(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

fn scaled(a: [f32; 3], s: f32) -> [f32; 3] {
    [a[0] * s, a[1] * s, a[2] * s]
}

/// `v` at unit length and its length (a zero vector stays zero).
fn normalized(v: [f32; 3]) -> ([f32; 3], f32) {
    let length = dot(v, v).sqrt();
    if length > 0.0 { (scaled(v, 1.0 / length), length) } else { (v, length) }
}

/// The largest side of the box around `positions` (meshoptimizer's `simplifyScale`).
pub fn mesh_extent(positions: &[[f32; 3]]) -> f32 {
    let Some(first) = positions.first() else { return 0.0 };
    let (min, max) = positions.iter().fold((*first, *first), |(min, max), p| (min_of(min, *p), max_of(max, *p)));
    (max[0] - min[0]).max(max[1] - min[1]).max(max[2] - min[2])
}

fn min_of(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0].min(b[0]), a[1].min(b[1]), a[2].min(b[2])]
}

fn max_of(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0].max(b[0]), a[1].max(b[1]), a[2].max(b[2])]
}

/// `positions` moved into the unit cube (the box's corner at 0, its largest side 1).
fn rescaled(positions: &[[f32; 3]]) -> Vec<[f32; 3]> {
    let Some(first) = positions.first() else { return Vec::new() };
    let min = positions.iter().fold(*first, |min, p| min_of(min, *p));
    let extent = mesh_extent(positions);
    let scale = if extent == 0.0 { 0.0 } else { 1.0 / extent };
    positions.iter().map(|p| scaled(sub(*p, min), scale)).collect()
}

/// Per vertex, the first vertex at its exact position (`remap`), and the next vertex at it in a
/// ring (`wedge`, itself when alone). Sorted by position, never hashed.
fn position_remap(positions: &[[f32; 3]]) -> (Vec<u32>, Vec<u32>) {
    let mut order: Vec<u32> = (0..positions.len() as u32).collect();
    order.sort_by_key(|&vertex| (position_key(positions[vertex as usize]), vertex));
    let mut remap: Vec<u32> = (0..positions.len() as u32).collect();
    let mut wedge = remap.clone();
    let mut start = 0;
    while start < order.len() {
        let key = position_key(positions[order[start] as usize]);
        let end = start + order[start..].iter().take_while(|&&vertex| position_key(positions[vertex as usize]) == key).count();
        let run = &order[start..end];
        for (at, &vertex) in run.iter().enumerate() {
            remap[vertex as usize] = run[0];
            wedge[vertex as usize] = run[(at + 1) % run.len()];
        }
        start = end;
    }
    (remap, wedge)
}

/// Every vertex's outgoing half-edges: for a triangle (a, b, c), `a` gets `next` b and `prev` c.
struct Adjacency {
    offsets: Vec<u32>,
    next: Vec<u32>,
    prev: Vec<u32>,
}

impl Adjacency {
    /// Over `indices`' vertices, or over their positions when `remap` is given (the welded mesh).
    fn build(indices: &[u32], vertex_count: usize, remap: Option<&[u32]>) -> Adjacency {
        let id = |vertex: u32| remap.map_or(vertex, |remap| remap[vertex as usize]);
        let mut offsets = vec![0u32; vertex_count + 1];
        for &vertex in indices {
            offsets[id(vertex) as usize + 1] += 1;
        }
        for at in 0..vertex_count {
            offsets[at + 1] += offsets[at];
        }
        let mut fill = offsets.clone();
        let mut next = vec![0u32; indices.len()];
        let mut prev = vec![0u32; indices.len()];
        for triangle in indices.as_chunks::<TRIANGLE>().0 {
            let [a, b, c] = triangle.map(id);
            for (from, to, back) in [(a, b, c), (b, c, a), (c, a, b)] {
                let slot = fill[from as usize] as usize;
                next[slot] = to;
                prev[slot] = back;
                fill[from as usize] += 1;
            }
        }
        Adjacency { offsets, next, prev }
    }

    fn edges(&self, vertex: u32) -> std::ops::Range<usize> {
        self.offsets[vertex as usize] as usize..self.offsets[vertex as usize + 1] as usize
    }

    fn has_edge(&self, from: u32, to: u32) -> bool {
        self.edges(from).any(|slot| self.next[slot] == to)
    }
}

/// The topology the simplifier keeps: each vertex's kind and, for borders and seams, the next and
/// previous vertex along its open edge loop.
struct Topology {
    kind: Vec<Kind>,
    next_on_loop: Vec<u32>,
    prev_on_loop: Vec<u32>,
}

/// Classify every vertex (meshoptimizer's `classifyVertices`).
fn classify(adjacency: &Adjacency, remap: &[u32], wedge: &[u32], lock: &[bool]) -> Topology {
    let vertex_count = remap.len();
    let mut open_in = vec![NONE; vertex_count];
    let mut open_out = vec![NONE; vertex_count];
    for vertex in 0..vertex_count as u32 {
        for slot in adjacency.edges(vertex) {
            let target = adjacency.next[slot];
            if adjacency.has_edge(target, vertex) {
                continue;
            }
            // A second open edge marks the vertex with itself: it is on more than one loop.
            open_in[target as usize] = if open_in[target as usize] == NONE { vertex } else { target };
            open_out[vertex as usize] = if open_out[vertex as usize] == NONE { target } else { vertex };
        }
    }
    let single = |vertex: usize, open: u32| open != NONE && open != vertex as u32;
    let mut kind = vec![Kind::Locked; vertex_count];
    for vertex in 0..vertex_count {
        if remap[vertex] != vertex as u32 {
            continue;
        }
        let other = wedge[vertex] as usize;
        kind[vertex] = if other == vertex {
            match (open_in[vertex], open_out[vertex]) {
                (NONE, NONE) => Kind::Manifold,
                (into, out) if single(vertex, into) && single(vertex, out) => Kind::Border,
                _ => Kind::Locked,
            }
        } else if wedge[other] as usize == vertex {
            let ends = [(vertex, open_in[vertex]), (vertex, open_out[vertex]), (other, open_in[other]), (other, open_out[other])];
            let one_each = ends.iter().all(|&(at, open)| single(at, open));
            let joined = one_each && remap[open_in[vertex] as usize] == remap[open_out[other] as usize] && remap[open_out[vertex] as usize] == remap[open_in[other] as usize];
            let distinct = joined && remap[open_in[vertex] as usize] != remap[open_out[vertex] as usize];
            if distinct { Kind::Seam } else { Kind::Locked }
        } else {
            Kind::Locked
        };
    }
    // A lock on any vertex at a position locks every vertex there.
    for vertex in 0..vertex_count {
        if lock.get(vertex).copied().unwrap_or(false) {
            kind[remap[vertex] as usize] = Kind::Locked;
        }
    }
    for vertex in 0..vertex_count {
        kind[vertex] = kind[remap[vertex] as usize];
    }
    let on_loop = |vertex: usize| kind[vertex].on_loop();
    let next_on_loop = (0..vertex_count).map(|vertex| if on_loop(vertex) { open_out[vertex] } else { NONE }).collect();
    let prev_on_loop = (0..vertex_count).map(|vertex| if on_loop(vertex) { open_in[vertex] } else { NONE }).collect();
    Topology { kind, next_on_loop, prev_on_loop }
}

/// Every position's quadric: its triangles' planes, plus planes holding its border and seam edges.
fn fill_quadrics(indices: &[u32], positions: &[[f32; 3]], remap: &[u32], topology: &Topology) -> Vec<Quadric> {
    let mut quadrics = vec![Quadric::default(); positions.len()];
    for triangle in indices.as_chunks::<TRIANGLE>().0 {
        let [a, b, c] = triangle.map(|vertex| vertex as usize);
        let quadric = Quadric::triangle(positions[a], positions[b], positions[c], 1.0);
        for vertex in [a, b, c] {
            quadrics[remap[vertex] as usize].add(&quadric);
        }
        for (i0, i1, i2) in [(a, b, c), (b, c, a), (c, a, b)] {
            let (k0, k1) = (topology.kind[i0], topology.kind[i1]);
            if !k0.on_loop() && !k1.on_loop() {
                continue;
            }
            let off_loop = (k0.on_loop() && topology.next_on_loop[i0] != i1 as u32) || (k1.on_loop() && topology.prev_on_loop[i1] != i0 as u32);
            let seen_twice = HAS_OPPOSITE[k0.at()][k1.at()] && remap[i1] > remap[i0];
            if off_loop || seen_twice {
                continue;
            }
            let weight = if k0 == Kind::Border || k1 == Kind::Border { BORDER_EDGE_WEIGHT } else { SEAM_EDGE_WEIGHT };
            let quadric = Quadric::edge(positions[i0], positions[i1], positions[i2], weight);
            quadrics[remap[i0] as usize].add(&quadric);
            quadrics[remap[i1] as usize].add(&quadric);
        }
    }
    quadrics
}

/// One candidate collapse: `from` onto `to` with its error; `both` while either way is allowed.
#[derive(Clone, Copy, Debug)]
struct Collapse {
    from: u32,
    to: u32,
    both: bool,
    error: f32,
}

/// Every edge of `indices` that may collapse one way or the other (meshoptimizer's
/// `pickEdgeCollapses`).
fn pick_collapses(indices: &[u32], remap: &[u32], topology: &Topology) -> Vec<Collapse> {
    let mut collapses = Vec::new();
    for &[a, b, c] in indices.as_chunks::<TRIANGLE>().0 {
        for (i0, i1) in [(a, b), (b, c), (c, a)] {
            let (k0, k1) = (topology.kind[i0 as usize], topology.kind[i1 as usize]);
            let forward = CAN_COLLAPSE[k0.at()][k1.at()];
            let backward = CAN_COLLAPSE[k1.at()][k0.at()];
            let same_position = remap[i0 as usize] == remap[i1 as usize];
            let seen_twice = HAS_OPPOSITE[k0.at()][k1.at()] && remap[i1 as usize] > remap[i0 as usize];
            // Two loop vertices without an open edge between them sit on two different loops.
            let across_loops = (k0.on_loop() && k1 != Kind::Manifold && topology.next_on_loop[i0 as usize] != i1) || (k1.on_loop() && k0 != Kind::Manifold && topology.prev_on_loop[i1 as usize] != i0);
            if same_position || !(forward || backward) || seen_twice || across_loops {
                continue;
            }
            let (from, to) = if forward { (i0, i1) } else { (i1, i0) };
            collapses.push(Collapse { from, to, both: forward && backward, error: 0.0 });
        }
    }
    collapses
}

/// Each collapse's error, turned the cheaper way when either way is allowed.
fn rank_collapses(collapses: &mut [Collapse], positions: &[[f32; 3]], quadrics: &[Quadric], remap: &[u32]) {
    for collapse in collapses {
        let (i0, i1) = (collapse.from, collapse.to);
        let forward = quadrics[remap[i0 as usize] as usize].error(positions[i1 as usize]);
        let backward = if collapse.both { quadrics[remap[i1 as usize] as usize].error(positions[i0 as usize]) } else { forward };
        if backward < forward {
            (collapse.from, collapse.to, collapse.error) = (i1, i0, backward);
        } else {
            collapse.error = forward;
        }
    }
}

/// Collapse order: cheapest first, ties by position in the list (a NaN error sorts last).
fn collapse_order(collapses: &[Collapse]) -> Vec<u32> {
    let key = |collapse: &Collapse| if collapse.error.is_finite() { collapse.error.to_bits() } else { u32::MAX };
    let mut order: Vec<u32> = (0..collapses.len() as u32).collect();
    order.sort_unstable_by_key(|&at| (key(&collapses[at as usize]), at));
    order
}

/// Whether moving welded vertex `r0` onto `r1` turns any of its remaining triangles over.
fn flips(adjacency: &Adjacency, positions: &[[f32; 3]], collapse_remap: &[u32], r0: u32, r1: u32) -> bool {
    let (v0, v1) = (positions[r0 as usize], positions[r1 as usize]);
    adjacency.edges(r0).any(|slot| {
        let a = collapse_remap[adjacency.next[slot] as usize];
        let b = collapse_remap[adjacency.prev[slot] as usize];
        if a == r1 || b == r1 || a == b {
            return false;
        }
        let (pa, pb) = (positions[a as usize], positions[b as usize]);
        let edge = sub(pb, pa);
        dot(cross(edge, sub(v0, pa)), cross(edge, sub(v1, pa))) <= 0.0
    })
}

/// What one pass reads: the mesh's fixed facts.
struct Pass<'a> {
    positions: &'a [[f32; 3]],
    remap: &'a [u32],
    wedge: &'a [u32],
    topology: &'a Topology,
    adjacency: &'a Adjacency,
}

/// Apply the cheapest collapses of one pass, never moving a vertex twice or towards a moved one,
/// until `goal` triangles are gone or the errors pass `error_limit` (meshoptimizer's
/// `performEdgeCollapses`). Answers the collapses made and the largest error accepted.
fn perform_collapses(pass: &Pass, collapses: &[Collapse], goal: usize, error_limit: f32, collapse_remap: &mut [u32]) -> (usize, f32) {
    let order = collapse_order(collapses);
    let expected = goal / 2;
    let error_goal = order.get(expected).map_or(f32::MAX, |&at| collapses[at as usize].error * PASS_ERROR_SLACK);
    let mut moved = vec![false; pass.positions.len()];
    let (mut done, mut removed, mut worst) = (0usize, 0usize, 0.0f32);
    for &at in &order {
        let collapse = collapses[at as usize];
        let past_slack = collapse.error > error_goal && removed > goal / PASS_MIN_SHARE_DIVISOR;
        if !collapse.error.is_finite() || collapse.error > error_limit || removed >= goal || past_slack {
            break;
        }
        let (i0, i1) = (collapse.from as usize, collapse.to as usize);
        let (r0, r1) = (pass.remap[i0], pass.remap[i1]);
        if moved[r0 as usize] || moved[r1 as usize] || flips(pass.adjacency, pass.positions, collapse_remap, r0, r1) {
            continue;
        }
        let kind = pass.topology.kind[i0];
        if kind == Kind::Seam {
            // The seam's other vertex moves along with it, onto the other vertex at the target.
            let s0 = pass.wedge[i0] as usize;
            let s1 = if pass.topology.next_on_loop[i0] == i1 as u32 { pass.topology.prev_on_loop[s0] } else { pass.topology.next_on_loop[s0] };
            if s1 == NONE || pass.remap[s1 as usize] != r1 {
                continue;
            }
            collapse_remap[i0] = i1 as u32;
            collapse_remap[s0] = s1;
        } else {
            collapse_remap[i0] = i1 as u32;
        }
        moved[r0 as usize] = true;
        moved[r1 as usize] = true;
        // A border edge removes one triangle, any other edge two or more.
        removed += if kind == Kind::Border { 1 } else { 2 };
        done += 1;
        worst = worst.max(collapse.error);
    }
    (done, worst)
}

/// After a pass: each moved position's quadric joins its target's.
fn merge_quadrics(quadrics: &mut [Quadric], collapse_remap: &[u32], remap: &[u32]) {
    for vertex in 0..collapse_remap.len() {
        let target = collapse_remap[vertex] as usize;
        if target != vertex && remap[vertex] as usize == vertex {
            let moved = quadrics[vertex];
            quadrics[remap[target] as usize].add(&moved);
        }
    }
}

/// After a pass: loop links that named a moved vertex name where it went.
fn remap_loop(links: &mut [u32], collapse_remap: &[u32]) {
    for vertex in 0..links.len() {
        let link = links[vertex];
        if link == NONE {
            continue;
        }
        let target = collapse_remap[link as usize];
        // The seam edge collapsed against the loop's direction: skip over the moved vertex.
        links[vertex] = if target as usize == vertex { links[link as usize] } else { target };
    }
}

/// After a pass: every triangle over the moved vertices, the collapsed ones dropped.
fn remap_indices(indices: &mut Vec<u32>, collapse_remap: &[u32]) {
    let mut kept = 0;
    for at in (0..indices.len()).step_by(TRIANGLE) {
        let [a, b, c] = [collapse_remap[indices[at] as usize], collapse_remap[indices[at + 1] as usize], collapse_remap[indices[at + 2] as usize]];
        if a != b && a != c && b != c {
            indices[kept..kept + TRIANGLE].copy_from_slice(&[a, b, c]);
            kept += TRIANGLE;
        }
    }
    indices.truncate(kept);
}

/// A simplification in progress: the mesh's fixed facts and the triangles collapsed so far.
struct Simplifier {
    remap: Vec<u32>,
    wedge: Vec<u32>,
    topology: Topology,
    /// The positions moved into the unit cube.
    unit: Vec<[f32; 3]>,
    quadrics: Vec<Quadric>,
    result: Vec<u32>,
    collapse_remap: Vec<u32>,
    /// The largest collapse error accepted so far (squared, relative).
    reached: f32,
}

impl Simplifier {
    /// None for input it cannot read: an index past the vertices, a position that is not finite,
    /// a partial triangle.
    fn new(positions: &[[f32; 3]], indices: &[u32], lock: &[bool]) -> Option<Simplifier> {
        let vertex_count = positions.len();
        let readable = indices.len().is_multiple_of(TRIANGLE) && indices.iter().all(|index| (*index as usize) < vertex_count) && positions.iter().flatten().all(|value| value.is_finite());
        if !readable {
            return None;
        }
        let (remap, wedge) = position_remap(positions);
        let topology = classify(&Adjacency::build(indices, vertex_count, None), &remap, &wedge, lock);
        let unit = rescaled(positions);
        let quadrics = fill_quadrics(indices, &unit, &remap, &topology);
        let collapse_remap = (0..vertex_count as u32).collect();
        Some(Simplifier { remap, wedge, topology, unit, quadrics, result: indices.to_vec(), collapse_remap, reached: 0.0 })
    }

    /// Collapse in passes until at most `target` indices (within [`LEVEL_TARGET_SLACK_DIVISOR`]
    /// of it) are left, no collapse passes `error_limit` (squared, relative), or none is possible.
    fn run_to(&mut self, target: usize, error_limit: f32) {
        let stop = target + target / LEVEL_TARGET_SLACK_DIVISOR;
        while self.result.len() > stop {
            let adjacency = Adjacency::build(&self.result, self.unit.len(), Some(&self.remap));
            let mut collapses = pick_collapses(&self.result, &self.remap, &self.topology);
            if collapses.is_empty() {
                break;
            }
            rank_collapses(&mut collapses, &self.unit, &self.quadrics, &self.remap);
            for (vertex, slot) in self.collapse_remap.iter_mut().enumerate() {
                *slot = vertex as u32;
            }
            let pass = Pass { positions: &self.unit, remap: &self.remap, wedge: &self.wedge, topology: &self.topology, adjacency: &adjacency };
            let goal = (self.result.len() - target) / TRIANGLE;
            let (done, worst) = perform_collapses(&pass, &collapses, goal, error_limit, &mut self.collapse_remap);
            if done == 0 {
                break;
            }
            self.reached = self.reached.max(worst);
            merge_quadrics(&mut self.quadrics, &self.collapse_remap, &self.remap);
            remap_loop(&mut self.topology.next_on_loop, &self.collapse_remap);
            remap_loop(&mut self.topology.prev_on_loop, &self.collapse_remap);
            remap_indices(&mut self.result, &self.collapse_remap);
        }
    }

    /// The error reached, relative to the mesh's extent.
    fn error(&self) -> f32 {
        self.reached.sqrt()
    }
}

/// `indices` (a triangle list over `positions`) simplified towards `target_index_count` indices
/// without passing `target_error` (relative to the mesh's extent); `lock` keeps vertices in place.
/// Answers the triangles and the error reached, relative to the extent ([`mesh_extent`]). Input it
/// cannot read (an index past the vertices, a position that is not finite, a partial triangle)
/// comes back unchanged with error 0.
pub fn simplify(positions: &[[f32; 3]], indices: &[u32], lock: &[bool], target_index_count: usize, target_error: f32) -> (Vec<u32>, f32) {
    simplify_levels(positions, indices, lock, &[target_index_count], target_error).pop().unwrap_or_else(|| (indices.to_vec(), 0.0))
}

/// [`simplify`] towards each of `targets` in turn (coarser and coarser), one simplification
/// carried on from level to level: the quadrics keep measuring from the original surface, so each
/// level is what simplifying the original that far gives, at the cost of one run. Each level
/// answers its triangles and the error reached so far.
pub fn simplify_levels(positions: &[[f32; 3]], indices: &[u32], lock: &[bool], targets: &[usize], target_error: f32) -> Vec<(Vec<u32>, f32)> {
    let Some(mut simplifier) = Simplifier::new(positions, indices, lock) else {
        return targets.iter().map(|_| (indices.to_vec(), 0.0)).collect();
    };
    let error_limit = target_error * target_error;
    targets
        .iter()
        .map(|&target| {
            if target < simplifier.result.len() {
                simplifier.run_to(target, error_limit);
            }
            (simplifier.result.clone(), simplifier.error())
        })
        .collect()
}

// -------------------------------------------------------------------------------------------------
// How far a level strays (the importer's `lod-deviation.ts`, ported).

/// The level's triangles binned in a uniform grid over the original's bounds.
struct TriangleGrid {
    min: [f64; 3],
    cell: [f64; 3],
    dims: [usize; 3],
    /// Cell `c` holds `triangles[start[c]..start[c + 1]]` (first-corner offsets into the level).
    start: Vec<u32>,
    triangles: Vec<u32>,
}

impl TriangleGrid {
    fn build(positions: &[[f32; 3]], original: &[u32], level: &[u32]) -> TriangleGrid {
        let mut min = [f64::INFINITY; 3];
        let mut max = [f64::NEG_INFINITY; 3];
        for &vertex in original {
            for axis in 0..3 {
                let value = f64::from(positions[vertex as usize][axis]);
                min[axis] = min[axis].min(value);
                max[axis] = max[axis].max(value);
            }
        }
        // Surfaces are two-dimensional: about one triangle per cell of the box's largest face.
        let side = ((level.len() / TRIANGLE) as f64).sqrt().ceil().clamp(1.0, GRID_MAX_CELLS_PER_AXIS as f64);
        let extent = |axis: usize| (max[axis] - min[axis]).max(f64::EPSILON);
        let largest = extent(0).max(extent(1)).max(extent(2));
        let dims = [0, 1, 2].map(|axis| ((side * extent(axis) / largest).ceil() as usize).max(1));
        let cell = [0, 1, 2].map(|axis| extent(axis) / dims[axis] as f64);
        let mut grid = TriangleGrid { min, cell, dims, start: Vec::new(), triangles: Vec::new() };
        let cells = dims[0] * dims[1] * dims[2];
        let mut start = vec![0u32; cells + 1];
        for first in (0..level.len()).step_by(TRIANGLE) {
            grid.each_cell(grid.triangle_cells(positions, level, first), |at| start[at + 1] += 1);
        }
        for at in 0..cells {
            start[at + 1] += start[at];
        }
        let mut fill = start.clone();
        let mut triangles = vec![0u32; start[cells] as usize];
        for first in (0..level.len()).step_by(TRIANGLE) {
            grid.each_cell(grid.triangle_cells(positions, level, first), |at| {
                triangles[fill[at] as usize] = first as u32;
                fill[at] += 1;
            });
        }
        grid.start = start;
        grid.triangles = triangles;
        grid
    }

    /// The cell coordinate of `value` on `axis`, clamped into the grid.
    fn cell_of(&self, axis: usize, value: f64) -> usize {
        let at = ((value - self.min[axis]) / self.cell[axis]).floor();
        at.clamp(0.0, (self.dims[axis] - 1) as f64) as usize
    }

    /// The cell box (low xyz, high xyz) a triangle's bounding box covers.
    fn triangle_cells(&self, positions: &[[f32; 3]], level: &[u32], first: usize) -> [usize; 6] {
        let mut range = [0usize; 6];
        for axis in 0..3 {
            let corner = |k: usize| f64::from(positions[level[first + k] as usize][axis]);
            let (a, b, c) = (corner(0), corner(1), corner(2));
            range[axis] = self.cell_of(axis, a.min(b).min(c));
            range[axis + 3] = self.cell_of(axis, a.max(b).max(c));
        }
        range
    }

    /// Call `visit` with the flat index of every cell in `range`.
    fn each_cell(&self, range: [usize; 6], mut visit: impl FnMut(usize)) {
        for z in range[2]..=range[5] {
            for y in range[1]..=range[4] {
                for x in range[0]..=range[3] {
                    visit((z * self.dims[1] + y) * self.dims[0] + x);
                }
            }
        }
    }
}

/// Squared distance from `p` to triangle `abc` (Ericson, Real-Time Collision Detection 5.1.5).
fn point_triangle_squared(p: [f64; 3], a: [f64; 3], b: [f64; 3], c: [f64; 3]) -> f64 {
    let sub = |u: [f64; 3], v: [f64; 3]| [u[0] - v[0], u[1] - v[1], u[2] - v[2]];
    let dot = |u: [f64; 3], v: [f64; 3]| u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
    let (ab, ac, ap) = (sub(b, a), sub(c, a), sub(p, a));
    let (d1, d2) = (dot(ab, ap), dot(ac, ap));
    let (abab, abac, acac) = (dot(ab, ab), dot(ab, ac), dot(ac, ac));
    let (v, w) = closest_weights([d1, d2, d1 - abab, d2 - abac, d1 - abac, d2 - acac]);
    let d = [ap[0] - v * ab[0] - w * ac[0], ap[1] - v * ab[1] - w * ac[1], ap[2] - v * ab[2] - w * ac[2]];
    dot(d, d)
}

/// The closest point's weights on ab and ac from Ericson's six dot products.
fn closest_weights([d1, d2, d3, d4, d5, d6]: [f64; 6]) -> (f64, f64) {
    if d1 <= 0.0 && d2 <= 0.0 {
        return (0.0, 0.0);
    }
    if d3 >= 0.0 && d4 <= d3 {
        return (1.0, 0.0);
    }
    let vc = d1 * d4 - d3 * d2;
    if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
        return (d1 / (d1 - d3), 0.0);
    }
    if d6 >= 0.0 && d5 <= d6 {
        return (0.0, 1.0);
    }
    let vb = d5 * d2 - d1 * d6;
    if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
        return (0.0, d2 / (d2 - d6));
    }
    let va = d3 * d6 - d5 * d4;
    let on_bc = va <= 0.0 && d4 - d3 >= 0.0 && d5 - d6 >= 0.0;
    if on_bc {
        let w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        return (1.0 - w, w);
    }
    let sum = va + vb + vc;
    // A degenerate (zero-area) triangle falls back to its first corner.
    if sum > 0.0 { (vb / sum, vc / sum) } else { (0.0, 0.0) }
}

/// One vertex's nearest-triangle search over the grid.
struct Search<'a> {
    grid: &'a TriangleGrid,
    positions: &'a [[f32; 3]],
    level: &'a [u32],
    /// Per triangle, the last vertex that measured it.
    seen: Vec<u32>,
}

impl Search<'_> {
    fn point(&self, vertex: u32) -> [f64; 3] {
        self.positions[vertex as usize].map(f64::from)
    }

    /// The nearest squared distance from `p` to a triangle of `cell` it has not measured yet.
    fn cell_nearest(&mut self, p: u32, cell: usize) -> f64 {
        let mut nearest = f64::INFINITY;
        for at in self.grid.start[cell] as usize..self.grid.start[cell + 1] as usize {
            let first = self.grid.triangles[at] as usize;
            let triangle = first / TRIANGLE;
            if std::mem::replace(&mut self.seen[triangle], p) == p {
                continue;
            }
            let corner = |k: usize| self.positions[self.level[first + k] as usize].map(f64::from);
            nearest = nearest.min(point_triangle_squared(self.point(p), corner(0), corner(1), corner(2)));
        }
        nearest
    }

    /// The nearest squared distance from `p` to a triangle in the cells of shell `ring` around `home`.
    fn shell_nearest(&mut self, p: u32, home: [usize; 3], ring: usize) -> f64 {
        let dims = self.grid.dims;
        let low = [0, 1, 2].map(|axis| home[axis].saturating_sub(ring));
        let high = [0, 1, 2].map(|axis| (home[axis] + ring).min(dims[axis] - 1));
        let mut nearest = f64::INFINITY;
        for z in low[2]..=high[2] {
            for y in low[1]..=high[1] {
                let row = (z * dims[1] + y) * dims[0];
                // On the shell's z and y faces the whole row lies on it; elsewhere only its two x ends.
                let on_face = z.abs_diff(home[2]) == ring || y.abs_diff(home[1]) == ring;
                if on_face {
                    for x in low[0]..=high[0] {
                        nearest = nearest.min(self.cell_nearest(p, row + x));
                    }
                    continue;
                }
                let ends = [home[0].checked_sub(ring), Some(home[0] + ring)];
                for x in ends.into_iter().flatten().filter(|x| (low[0]..=high[0]).contains(x)) {
                    nearest = nearest.min(self.cell_nearest(p, row + x));
                }
            }
        }
        nearest
    }

    /// The distance from `p` to the nearest triangle of the level.
    fn nearest(&mut self, p: u32) -> f64 {
        let point = self.point(p);
        let home = [0, 1, 2].map(|axis| self.grid.cell_of(axis, point[axis]));
        let step = self.grid.cell[0].min(self.grid.cell[1]).min(self.grid.cell[2]);
        let reach = self.grid.dims[0].max(self.grid.dims[1]).max(self.grid.dims[2]);
        let mut best = f64::INFINITY;
        for ring in 0..=reach {
            best = best.min(self.shell_nearest(p, home, ring));
            // Every cell past this shell is at least `ring` whole cells from any point of the home cell.
            let bound = ring as f64 * step;
            if best <= bound * bound {
                break;
            }
        }
        best.sqrt()
    }
}

/// The largest distance from a vertex `original` uses to the surface of `level` (both triangle
/// lists over `positions`); 0 for an empty original, infinity for an empty level.
pub fn vertex_deviation(positions: &[[f32; 3]], original: &[u32], level: &[u32]) -> f32 {
    if original.is_empty() {
        return 0.0;
    }
    if level.is_empty() {
        return f32::INFINITY;
    }
    let mut done = vec![false; positions.len()];
    // A vertex the level keeps lies on it.
    for &vertex in level {
        done[vertex as usize] = true;
    }
    let grid = TriangleGrid::build(positions, original, level);
    let mut search = Search { grid: &grid, positions, level, seen: vec![NONE; level.len() / TRIANGLE] };
    let mut worst = 0.0f64;
    for &vertex in original {
        if std::mem::replace(&mut done[vertex as usize], true) {
            continue;
        }
        worst = worst.max(search.nearest(vertex));
    }
    worst as f32
}
