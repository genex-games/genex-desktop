//! The runtime clusterizer (R2.1, `genex_render::meshlet::build`) and the mesh library's meshlets.
//!
//! Every row checks a property the meshlet cull and draw rely on, over meshes of different shapes
//! (a flat grid, a closed torus, the immediate sphere with its seams, a flat-shaded mesh whose
//! triangles share no vertex, degenerate and repeated-vertex triangles, a non-manifold soup):
//! - every mesh triangle is in exactly one meshlet, winding kept (`meshlet::validate`);
//! - no meshlet has more than 64 vertices or 124 triangles;
//! - two runs give identical bytes;
//! - every triangle's face normal lies inside its meshlet's cone, every vertex inside its sphere,
//!   and the cone test never calls a meshlet back-facing while one of its triangles faces the eye;
//! - the library clusters a mesh at or above the game's `min_triangles` and nothing smaller, never
//!   a skinned mesh, keeps a valid imported set and refuses (typed) a set past the storage binding.
//!
//! The cost row (`#[ignore]`d: it means something only in a release build) clusters a
//! 1M-triangle grid and records the time and the fill:
//!
//!   node scripts/toolchains/rust-env.ts -- cargo test -p genex-render --offline --locked \
//!     --release --test meshlet -- --ignored --nocapture
//!
//! With `GENEX_PERF_OUT` set it writes its JSON there.

use genex_render::layout::GpuMeshlet;
use genex_render::mesh::{MeshData, Vertex};
use genex_render::meshlet::{self, MESHLET_MAX_TRIANGLES, MESHLET_MAX_VERTICES, MeshletLibrary, MeshletSet, unpack_triangle, validate};
use genex_render::scene::{MeshId, MeshLibrary, MeshletState};
use genex_render::settings::Meshlets;
use genex_render::{BUFFER_MAX_BYTES, RenderCode};

/// The acceptance's CPU budget for a 1M-triangle mesh in a release build.
const MILLION_BUDGET_MS: f64 = 300.0;
/// Edge of the grid whose two triangles per cell make a little over a million triangles.
const MILLION_GRID: u32 = 708;
/// Triangles of the one-vertex fan of the cost row.
const HUB_TRIANGLES: u32 = 200_000;
/// Tolerance of the containment and cone rows (f32 rounding of positions and normals).
const EPSILON: f32 = 1e-5;

// --- meshes ---------------------------------------------------------------------------------------

fn vertex(position: [f32; 3]) -> Vertex {
    Vertex { position, normal: [0.0, 1.0, 0.0], uv: [0.0, 0.0], tangent: [1.0, 0.0, 0.0, 1.0] }
}

/// An `n` by `n` cell grid in the xz plane (normals +y), row by row: `2 n²` triangles.
fn grid(n: u32) -> MeshData {
    let mut mesh = MeshData::default();
    for z in 0..=n {
        for x in 0..=n {
            mesh.vertices.push(vertex([x as f32, 0.0, z as f32]));
        }
    }
    let row = n + 1;
    for z in 0..n {
        for x in 0..n {
            let (a, b, c, d) = (z * row + x, z * row + x + 1, (z + 1) * row + x, (z + 1) * row + x + 1);
            mesh.indices.extend([a, c, b, b, c, d]);
        }
    }
    mesh
}

/// A closed torus (major radius 2, minor 0.6) of `rings` by `sides` quads, shared vertices.
fn torus(rings: u32, sides: u32) -> MeshData {
    let mut mesh = MeshData::default();
    for ring in 0..rings {
        let u = std::f32::consts::TAU * ring as f32 / rings as f32;
        for side in 0..sides {
            let v = std::f32::consts::TAU * side as f32 / sides as f32;
            let r = 2.0 + 0.6 * libm::cosf(v);
            mesh.vertices.push(vertex([r * libm::cosf(u), 0.6 * libm::sinf(v), r * libm::sinf(u)]));
        }
    }
    for ring in 0..rings {
        for side in 0..sides {
            let at = |ring: u32, side: u32| (ring % rings) * sides + side % sides;
            let (a, b, c, d) = (at(ring, side), at(ring + 1, side), at(ring, side + 1), at(ring + 1, side + 1));
            mesh.indices.extend([a, c, b, b, c, d]);
        }
    }
    mesh
}

/// A grid whose every triangle has its own three vertices (flat shading, nothing shared).
fn flat_shaded(n: u32) -> MeshData {
    let source = grid(n);
    let mut mesh = MeshData::default();
    for index in &source.indices {
        mesh.indices.push(mesh.vertices.len() as u32);
        mesh.vertices.push(source.vertices[*index as usize]);
    }
    mesh
}

/// A disc of `n` triangles around one centre vertex (a fan: one vertex of valence `n`).
fn fan(n: u32) -> MeshData {
    let mut mesh = MeshData::default();
    mesh.vertices.push(vertex([0.0; 3]));
    for i in 0..n {
        let angle = std::f32::consts::TAU * i as f32 / n as f32;
        mesh.vertices.push(vertex([libm::cosf(angle), 0.0, libm::sinf(angle)]));
        mesh.indices.extend([0, 1 + (i + 1) % n, 1 + i]);
    }
    mesh
}

/// A deterministic generator (an LCG; the test owns its sequence).
struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> u32 {
        self.0 = self.0.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
        (self.0 >> 33) as u32
    }

    fn unit(&mut self) -> f32 {
        self.next() as f32 / (1u64 << 31) as f32
    }
}

/// Triangles over 300 random points with random corners: non-manifold, with degenerate
/// (repeated-index) and zero-area triangles among them.
fn soup() -> MeshData {
    let mut rng = Lcg(7);
    let mut mesh = MeshData::default();
    for _ in 0..300 {
        mesh.vertices.push(vertex([rng.unit() * 10.0, rng.unit() * 10.0, rng.unit() * 10.0]));
    }
    for _ in 0..3000 {
        mesh.indices.extend([rng.next() % 300, rng.next() % 300, rng.next() % 300]);
    }
    // Repeated corners and a collinear triangle.
    mesh.indices.extend([5, 5, 6, 7, 7, 7]);
    mesh.vertices.extend([vertex([0.0; 3]), vertex([1.0, 0.0, 0.0]), vertex([2.0, 0.0, 0.0])]);
    mesh.indices.extend([300, 301, 302]);
    mesh
}

fn shapes() -> Vec<(&'static str, MeshData)> {
    vec![
        ("grid", grid(40)),
        ("torus", torus(48, 24)),
        ("sphere", MeshData::sphere()),
        ("cube", MeshData::cube()),
        ("flat-shaded", flat_shaded(12)),
        ("fan", fan(3000)),
        ("soup", soup()),
    ]
}

fn positions(mesh: &MeshData) -> Vec<[f32; 3]> {
    mesh.vertices.iter().map(|v| v.position).collect()
}

fn build(mesh: &MeshData) -> MeshletSet {
    meshlet::build(&mesh.indices, &positions(mesh)).expect("a well-formed triangle list clusters")
}

// --- vector helpers -------------------------------------------------------------------------------

fn sub(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn dot(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn length(a: [f32; 3]) -> f32 {
    dot(a, a).sqrt()
}

fn face_normal(p: [[f32; 3]; 3]) -> Option<[f32; 3]> {
    let (e1, e2) = (sub(p[1], p[0]), sub(p[2], p[0]));
    let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    let len = length(n);
    (len > 1e-12 && len.is_finite()).then(|| n.map(|c| c / len))
}

/// Each meshlet with the positions of its triangles' corners.
fn meshlet_triangles<'a>(set: &'a MeshletSet, positions: &'a [[f32; 3]]) -> impl Iterator<Item = (&'a GpuMeshlet, Vec<[[f32; 3]; 3]>)> + 'a {
    set.meshlets.iter().map(move |m| {
        let vertices = &set.vertices[m.vertex_offset as usize..(m.vertex_offset + m.vertex_count) as usize];
        let triangles = set.triangles[m.triangle_offset as usize..(m.triangle_offset + m.triangle_count) as usize]
            .iter()
            .map(|packed| unpack_triangle(*packed).map(|local| positions[vertices[usize::from(local)] as usize]))
            .collect();
        (m, triangles)
    })
}

fn set_bytes(set: &MeshletSet) -> Vec<u8> {
    let mut bytes = bytemuck::cast_slice::<GpuMeshlet, u8>(&set.meshlets).to_vec();
    bytes.extend_from_slice(bytemuck::cast_slice(&set.vertices));
    bytes.extend_from_slice(bytemuck::cast_slice(&set.triangles));
    bytes
}

// --- the clusterizer ------------------------------------------------------------------------------

#[test]
fn every_triangle_is_in_exactly_one_meshlet_with_its_winding() {
    for (name, mesh) in shapes() {
        let set = build(&mesh);
        assert_eq!(validate(&set, &mesh.indices, mesh.vertices.len() as u32), Ok(()), "{name}");
        assert_eq!(set.triangles.len() * 3, mesh.indices.len(), "{name}");
    }
}

#[test]
fn no_meshlet_exceeds_64_vertices_or_124_triangles_and_none_is_empty() {
    for (name, mesh) in shapes() {
        for m in &build(&mesh).meshlets {
            assert!((1..=MESHLET_MAX_VERTICES).contains(&m.vertex_count), "{name}: {} vertices", m.vertex_count);
            assert!((1..=MESHLET_MAX_TRIANGLES).contains(&m.triangle_count), "{name}: {} triangles", m.triangle_count);
        }
    }
}

#[test]
fn a_meshlet_lists_each_of_its_vertices_once() {
    for (name, mesh) in shapes() {
        let set = build(&mesh);
        for m in &set.meshlets {
            let mut vertices = set.vertices[m.vertex_offset as usize..(m.vertex_offset + m.vertex_count) as usize].to_vec();
            vertices.sort_unstable();
            vertices.dedup();
            assert_eq!(vertices.len() as u32, m.vertex_count, "{name}");
        }
    }
}

#[test]
fn two_runs_give_identical_bytes() {
    for (name, mesh) in shapes() {
        assert_eq!(set_bytes(&build(&mesh)), set_bytes(&build(&mesh)), "{name}");
    }
}

#[test]
fn every_vertex_lies_inside_its_meshlets_sphere() {
    for (name, mesh) in shapes() {
        let points = positions(&mesh);
        let set = build(&mesh);
        for (m, triangles) in meshlet_triangles(&set, &points) {
            let [cx, cy, cz, radius] = m.bounds;
            for corner in triangles.iter().flatten() {
                let distance = length(sub(*corner, [cx, cy, cz]));
                assert!(distance <= radius * (1.0 + EPSILON) + EPSILON, "{name}: a vertex {distance} from the centre, radius {radius}");
            }
        }
    }
}

#[test]
fn every_triangles_normal_lies_inside_its_meshlets_cone() {
    for (name, mesh) in shapes() {
        let points = positions(&mesh);
        let set = build(&mesh);
        for (m, triangles) in meshlet_triangles(&set, &points) {
            let [ax, ay, az, cutoff] = m.cone;
            assert!((length([ax, ay, az]) - 1.0).abs() < EPSILON, "{name}: the axis is a unit vector");
            assert!((0.0..=1.0).contains(&cutoff), "{name}: cutoff {cutoff}");
            if cutoff >= 1.0 {
                continue; // no cone: never back-facing
            }
            let cos_half_angle = (1.0 - cutoff * cutoff).sqrt();
            for normal in triangles.iter().filter_map(|t| face_normal(*t)) {
                let d = dot(normal, [ax, ay, az]);
                assert!(d >= cos_half_angle - EPSILON, "{name}: a normal at cos {d} outside a cone of cos {cos_half_angle}");
            }
        }
    }
}

#[test]
fn the_cone_test_never_culls_a_meshlet_with_a_front_facing_triangle() {
    let mut rng = Lcg(11);
    let mut culled = 0;
    for (name, mesh) in shapes() {
        let points = positions(&mesh);
        let set = build(&mesh);
        for (m, triangles) in meshlet_triangles(&set, &points) {
            for _ in 0..24 {
                let [cx, cy, cz, radius] = m.bounds;
                let reach = (radius * 6.0).max(1.0);
                let eye = [cx + (rng.unit() - 0.5) * reach, cy + (rng.unit() - 0.5) * reach, cz + (rng.unit() - 0.5) * reach];
                if !meshlet::backfacing(m, eye) {
                    continue;
                }
                culled += 1;
                for triangle in &triangles {
                    let Some(normal) = face_normal(*triangle) else { continue };
                    for corner in triangle {
                        let facing = dot(sub(*corner, eye), normal);
                        assert!(facing >= -EPSILON * length(sub(*corner, eye)).max(1.0), "{name}: culled while a triangle faces the eye ({facing})");
                    }
                }
            }
        }
    }
    assert!(culled > 100, "the cone test culls something ({culled} meshlet views)");
}

#[test]
fn a_flat_patch_gets_a_tight_cone_and_a_closed_mesh_meshlets_cull_from_behind() {
    let mesh = grid(40);
    let set = build(&mesh);
    for m in &set.meshlets {
        assert!(m.cone[3] < 0.01, "a flat grid's meshlets have a near-zero cutoff ({})", m.cone[3]);
        assert!(meshlet::backfacing(m, [m.bounds[0], -50.0, m.bounds[2]]), "a grid meshlet seen from below is back-facing");
        assert!(!meshlet::backfacing(m, [m.bounds[0], 50.0, m.bounds[2]]), "and from above it is not");
    }
}

#[test]
fn malformed_triangle_lists_are_refused_typed_never_panicking() {
    use genex_render::meshlet::MeshletFault;
    let mesh = grid(4);
    let points = positions(&mesh);
    let mut past = mesh.indices.clone();
    past[7] = 10_000;
    assert_eq!(meshlet::build(&past, &points), Err(MeshletFault::VertexOutOfMesh));
    let ragged = &mesh.indices[..mesh.indices.len() - 1];
    assert_eq!(meshlet::build(ragged, &points), Err(MeshletFault::TrianglesDiffer));
    assert_eq!(meshlet::build(&[], &points), Ok(MeshletSet::default()), "no triangles, no meshlets");
    let nan = vec![[f32::NAN; 3]; points.len()];
    let set = meshlet::build(&mesh.indices, &nan).expect("NaN positions still cluster");
    assert_eq!(validate(&set, &mesh.indices, nan.len() as u32), Ok(()));
    assert!(set.meshlets.iter().all(|m| m.cone[3] == 1.0), "no usable normal, no cone");
}

/// Average (triangles / 124, vertices / 64, the fuller of the two) over a set's meshlets.
fn fill(set: &MeshletSet) -> (f64, f64, f64) {
    let count = set.meshlets.len() as f64;
    let mut sums = (0.0, 0.0, 0.0);
    for m in &set.meshlets {
        let (t, v) = (f64::from(m.triangle_count) / f64::from(MESHLET_MAX_TRIANGLES), f64::from(m.vertex_count) / f64::from(MESHLET_MAX_VERTICES));
        sums = (sums.0 + t, sums.1 + v, sums.2 + t.max(v));
    }
    (sums.0 / count, sums.1 / count, sums.2 / count)
}

#[test]
fn meshlets_fill_the_limit_that_binds() {
    // 64 vertices bind before 124 triangles on a manifold mesh (Euler: a disc of V vertices with B
    // on its edge holds 2V - B - 2 triangles, about 96 for a hexagon of 61), so the fill measured
    // is the fuller of the two limits; the triangle fill is held to what that bound allows.
    for (name, mesh) in [("grid", grid(120)), ("torus", torus(96, 48))] {
        let (triangles, vertices, binding) = fill(&build(&mesh));
        assert!(binding >= 0.85, "{name}: average binding fill {binding:.3} (triangles {triangles:.3}, vertices {vertices:.3})");
        assert!(triangles >= 0.70, "{name}: average triangle fill {triangles:.3}");
    }
}

#[test]
#[ignore = "a release-build cost row: clustering a 1M-triangle mesh within the budget"]
fn clustering_a_million_triangles_fits_the_budget() {
    let mesh = grid(MILLION_GRID);
    let points = positions(&mesh);
    let mut samples_ms = Vec::new();
    let mut set = MeshletSet::default();
    for _ in 0..5 {
        #[allow(clippy::disallowed_types, reason = "a cost row measures the wall clock on purpose")]
        let start = std::time::Instant::now();
        set = meshlet::build(&mesh.indices, &points).expect("cluster");
        samples_ms.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    samples_ms.sort_by(f64::total_cmp);
    let median = samples_ms[samples_ms.len() / 2];
    assert_eq!(validate(&set, &mesh.indices, points.len() as u32), Ok(()));
    // A hostile shape: one vertex of valence 200k (a fan's hub) costs no more than the grid.
    let hub = fan(HUB_TRIANGLES);
    #[allow(clippy::disallowed_types, reason = "a cost row measures the wall clock on purpose")]
    let start = std::time::Instant::now();
    let hub_set = meshlet::build(&hub.indices, &positions(&hub)).expect("cluster the fan");
    let hub_ms = start.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(validate(&hub_set, &hub.indices, hub.vertices.len() as u32), Ok(()));
    let (triangles, vertices, binding) = fill(&set);
    let row = serde_json::json!({
        "row": "meshlet-cluster-1m",
        "triangles": mesh.indices.len() / 3,
        "meshlets": set.meshlets.len(),
        "median_ms": median,
        "samples_ms": samples_ms,
        "budget_ms": MILLION_BUDGET_MS,
        "fill_triangles": triangles,
        "fill_vertices": vertices,
        "fill_binding": binding,
        "fan_triangles": HUB_TRIANGLES,
        "fan_ms": hub_ms,
        "release": !cfg!(debug_assertions),
    });
    println!("{row}");
    if let Ok(path) = std::env::var("GENEX_PERF_OUT") {
        std::fs::write(path, serde_json::to_string_pretty(&row).expect("json")).expect("perf out");
    }
    if !cfg!(debug_assertions) {
        assert!(median <= MILLION_BUDGET_MS, "clustering 1M triangles took {median:.1} ms");
        assert!(hub_ms <= MILLION_BUDGET_MS, "clustering a {HUB_TRIANGLES}-triangle fan took {hub_ms:.1} ms");
    }
}

// --- the mesh library -----------------------------------------------------------------------------

#[test]
fn the_library_clusters_meshes_at_or_above_min_triangles_and_nothing_smaller() {
    let mut library = MeshLibrary::new();
    assert_eq!(library.meshlet_state(MeshId::CUBE), Some(MeshletState::Whole), "the immediate cube draws whole");
    assert_eq!(library.meshlet_state(MeshId::SPHERE), Some(MeshletState::Whole), "the immediate sphere is under 2048 triangles");
    let small = library.add(grid(31)).expect("small"); // 1922 triangles
    let big = library.add(grid(32)).expect("big"); // 2048 triangles
    assert_eq!(library.meshlet_state(small), Some(MeshletState::Whole));
    let Some(MeshletState::Clustered(range)) = library.meshlet_state(big) else { panic!("a 2048-triangle mesh is clustered") };
    assert_eq!(range.first_meshlet, 0);
    assert_eq!(range.meshlet_count as usize, library.meshlets().meshlets.len());

    // The library's rows hold the mesh's triangles with vertex ids rebased to the library.
    let entry = *library.entry(big).expect("entry");
    let indices: Vec<u32> = library.indices()[entry.first_index as usize..(entry.first_index + entry.index_count) as usize].iter().map(|i| i + entry.base_vertex as u32).collect();
    let rows = library.meshlets();
    let as_set = MeshletSet { meshlets: rows.meshlets.clone(), vertices: rows.vertices.clone(), triangles: rows.triangles.clone() };
    assert_eq!(validate(&as_set, &indices, library.vertices().len() as u32), Ok(()));
}

#[test]
fn the_games_meshlet_setting_reclusters_the_library() {
    let mut library = MeshLibrary::new();
    let mesh = library.add(grid(32)).expect("mesh");
    library.set_meshlets(Meshlets::DEFAULT.with_enabled(false));
    assert_eq!(library.meshlet_state(mesh), Some(MeshletState::Whole), "a game that opts out clusters nothing");
    assert!(library.meshlets().meshlets.is_empty());
    library.set_meshlets(Meshlets::DEFAULT.with_min_triangles(MESHLET_MAX_TRIANGLES));
    assert!(matches!(library.meshlet_state(MeshId::SPHERE), Some(MeshletState::Clustered(_))), "the floor clusters the sphere");
    assert!(matches!(library.meshlet_state(mesh), Some(MeshletState::Clustered(_))));
    assert_eq!(library.meshlet_state(MeshId::CUBE), Some(MeshletState::Whole), "12 triangles stay whole");
    let mut again = MeshLibrary::with_meshlets(Meshlets::DEFAULT.with_min_triangles(MESHLET_MAX_TRIANGLES));
    again.add(grid(32)).expect("mesh");
    assert_eq!(again.meshlets(), library.meshlets(), "clustering at add equals reclustering after");
}

/// R2 review: only a change of what clusters re-clusters; occlusion moves no cluster (a game that
/// flips occlusion per scene pays no CPU re-cluster).
#[test]
fn only_what_clusters_decides_a_recluster_and_occlusion_never_does() {
    let on = Meshlets::DEFAULT;
    assert!(on.same_clusters(&on.with_occlusion(false)), "occlusion moves no cluster");
    assert!(!on.same_clusters(&on.with_enabled(false)), "opting out un-clusters");
    assert!(!on.same_clusters(&on.with_min_triangles(4096)), "another threshold clusters other meshes");
    let off = on.with_enabled(false);
    assert!(off.same_clusters(&off.with_min_triangles(4096)), "off clusters nothing whatever the threshold");
    let mut library = MeshLibrary::new();
    let mesh = library.add(grid(32)).expect("mesh");
    let clustered = library.clone();
    library.set_meshlets(on.with_occlusion(false));
    assert_eq!(library.meshlet_setting(), on.with_occlusion(false), "the setting is kept");
    assert_eq!(library.meshlets(), clustered.meshlets(), "the clusters are the same");
    assert_eq!(library.meshlet_state(mesh), clustered.meshlet_state(mesh));
}

#[test]
fn a_valid_imported_set_is_kept_and_an_invalid_one_falls_back_to_the_clusterizer() {
    let mesh = grid(32);
    let runtime = build(&mesh);
    // One meshlet per triangle: valid, and unlike anything the clusterizer builds.
    let mut imported = MeshletSet::default();
    for (t, triangle) in mesh.indices.as_chunks::<3>().0.iter().enumerate() {
        let t = t as u32;
        imported.meshlets.push(GpuMeshlet { bounds: [0.0, 0.0, 0.0, 1e9], cone: [0.0, 0.0, 1.0, 1.0], vertex_offset: t * 3, triangle_offset: t, vertex_count: 3, triangle_count: 1 });
        imported.vertices.extend_from_slice(triangle);
        imported.triangles.push(meshlet::pack_triangle([0, 1, 2]));
    }
    assert_eq!(validate(&imported, &mesh.indices, mesh.vertices.len() as u32), Ok(()));

    let mut library = MeshLibrary::new();
    let kept = library.add_with_meshlets(mesh.clone(), Some(imported.clone())).expect("kept");
    let Some(MeshletState::Clustered(range)) = library.meshlet_state(kept) else { panic!("clustered") };
    assert_eq!(range.meshlet_count as usize, imported.meshlets.len(), "the imported set is used as it is");

    let mut hostile = imported;
    hostile.triangles[0] = meshlet::pack_triangle([0, 1, 9]);
    let mut library = MeshLibrary::new();
    let fallback = library.add_with_meshlets(mesh, Some(hostile)).expect("fallback");
    let Some(MeshletState::Clustered(range)) = library.meshlet_state(fallback) else { panic!("clustered at runtime") };
    assert_eq!(range.meshlet_count as usize, runtime.meshlets.len(), "the runtime clusterizer takes over");
}

#[test]
fn a_skinned_mesh_is_never_clustered() {
    use genex_render::layout::GpuSkinVertex;
    use genex_render::skin::{Skeleton, SkeletonNode, SkinnedMeshData, Trs};
    let mesh = grid(32);
    let skin = vec![GpuSkinVertex { joints: [0; 4], weights: [1.0, 0.0, 0.0, 0.0] }; mesh.vertices.len()];
    let identity = [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0];
    let skeleton = Skeleton { nodes: vec![SkeletonNode { parent: None, rest: Trs::IDENTITY }], joints: vec![0], inverse_bind: vec![identity], mesh_node: None };
    let mut library = MeshLibrary::new();
    let skinned = library.add_skinned(&SkinnedMeshData { mesh, skin, skeleton, animations: Vec::new() }).expect("skinned");
    assert_eq!(library.meshlet_state(skinned.mesh()), Some(MeshletState::Whole), "skinning moves vertices the cone and sphere were built from");
}

#[test]
fn meshlets_past_the_storage_binding_are_refused_typed_and_the_library_is_unchanged() {
    let set = build(&grid(32));
    let mut rows = MeshletLibrary::default();
    let one = rows.append_within(&set, 0, BUFFER_MAX_BYTES).expect("fits the binding");
    assert_eq!(one.first_meshlet, 0);
    let before = rows.clone();
    let cap = rows.bytes_of_largest_buffer() + 1;
    let refused = rows.append_within(&set, 100, cap).expect_err("past the binding");
    assert_eq!(refused.code(), RenderCode::BufferTooLarge);
    assert_eq!(rows, before, "a refused append writes nothing");
}
