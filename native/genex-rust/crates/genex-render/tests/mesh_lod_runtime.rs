//! Runtime LOD chains (game systems LOD-21): a model without the import step's `genex_lods` gets
//! a chain at load with the importer's parameters: as many levels as the importer gives it, each
//! valid for the renderer, a pure function of the input, refused whole for input it cannot read,
//! and never for a model past the load budget.
//!
//!   node scripts/toolchains/rust-env.ts -- cargo test -p genex-render --offline --locked \
//!     --test mesh_lod_runtime
//!
//! The load-time numbers are an ignored advisory row, run in release:
//!
//!   node scripts/toolchains/rust-env.ts -- cargo test -p genex-render --offline --locked \
//!     --release --test mesh_lod_runtime -- --ignored advisory --nocapture

use genex_render::mesh::{GlbModel, LOD_MAX_LEVELS, LOD_MIN_TRIANGLES, LodChain, MeshData, Vertex};
use genex_render::mesh_lod_runtime::{RUNTIME_LOD_MAX_RELATIVE_ERROR, RUNTIME_LOD_MAX_TRIANGLES, RUNTIME_LOD_MIN_REDUCTION, RuntimeLodOutcome, add_runtime_chains, mesh_extent, simplify, vertex_deviation};
use genex_render::scene::ModelPart;
use serde_json::Value;

/// The repository's asset-import fixtures.
fn import_fixture(name: &str) -> Vec<u8> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../tests/fixtures/asset-import").join(name);
    std::fs::read(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

/// A GLB's JSON and binary chunks.
fn split(glb: &[u8]) -> (Value, Vec<u8>) {
    let json_len = u32::from_le_bytes(glb[12..16].try_into().expect("length")) as usize;
    let json: Value = serde_json::from_slice(&glb[20..20 + json_len]).expect("json");
    let bin_at = 20 + json_len;
    let bin_len = u32::from_le_bytes(glb[bin_at..bin_at + 4].try_into().expect("length")) as usize;
    (json, glb[bin_at + 8..bin_at + 8 + bin_len].to_vec())
}

/// `json` and `bin` as a GLB.
fn join(json: &Value, mut bin: Vec<u8>) -> Vec<u8> {
    while !bin.len().is_multiple_of(4) {
        bin.push(0);
    }
    let mut text = serde_json::to_vec(json).expect("json");
    while !text.len().is_multiple_of(4) {
        text.push(b' ');
    }
    let mut out = Vec::new();
    out.extend(b"glTF");
    out.extend(2u32.to_le_bytes());
    out.extend(((12 + 8 + text.len() + 8 + bin.len()) as u32).to_le_bytes());
    out.extend((text.len() as u32).to_le_bytes());
    out.extend(b"JSON");
    out.extend(&text);
    out.extend((bin.len() as u32).to_le_bytes());
    out.extend(b"BIN\0");
    out.extend(&bin);
    out
}

/// The import step's sphere golden with every primitive's `genex_lods` taken out: the same GLB as
/// it was before the import step simplified it.
fn unimported_sphere() -> Vec<u8> {
    let (mut json, bin) = split(&import_fixture("lods-sphere.glb"));
    for primitive in json["meshes"][0]["primitives"].as_array_mut().expect("primitives") {
        if let Some(extras) = primitive["extras"].as_object_mut() {
            extras.remove("genex_lods");
        }
    }
    join(&json, bin)
}

fn parts_of(glb: &[u8]) -> Vec<ModelPart> {
    GlbModel::parts_from_glb(glb).expect("the GLB loads")
}

fn vertex(position: [f32; 3]) -> Vertex {
    Vertex { position, normal: [0.0, 0.0, 1.0], uv: [0.0, 0.0], tangent: [1.0, 0.0, 0.0, 1.0] }
}

/// An `n` x `n` grid of quads over the unit square moved by `offset`, at height `bump` of the
/// moved point (so two grids side by side meet exactly), welded.
fn grid(n: u32, bump: impl Fn(f32, f32) -> f32, offset: [f32; 2]) -> MeshData {
    let mut mesh = MeshData::default();
    for row in 0..=n {
        for column in 0..=n {
            let (x, y) = (column as f32 / n as f32, row as f32 / n as f32);
            mesh.vertices.push(vertex([x + offset[0], y + offset[1], bump(x + offset[0], y + offset[1])]));
        }
    }
    let at = |row: u32, column: u32| row * (n + 1) + column;
    for row in 0..n {
        for column in 0..n {
            let (a, b, c, d) = (at(row, column), at(row, column + 1), at(row + 1, column + 1), at(row + 1, column));
            mesh.indices.extend([a, b, c, a, c, d]);
        }
    }
    mesh
}

fn hills(x: f32, y: f32) -> f32 {
    0.05 * libm::sinf(x * 9.0) * libm::cosf(y * 7.0)
}

fn positions(mesh: &MeshData) -> Vec<[f32; 3]> {
    mesh.vertices.iter().map(|vertex| vertex.position).collect()
}

/// The chain's level counts and error bits: what a digest of it holds.
fn shape(chain: &LodChain) -> Vec<(Vec<u32>, u32)> {
    chain.levels.iter().map(|level| (level.indices.clone(), level.error.to_bits())).collect()
}

/// FNV-1a over a model's chains: indices and error bits, level by level.
fn digest(parts: &[ModelPart]) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    let mut eat = |word: u32| {
        for byte in word.to_le_bytes() {
            hash = (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3);
        }
    };
    for part in parts {
        for (indices, error) in part.lods.as_ref().map(shape).unwrap_or_default() {
            eat(indices.len() as u32);
            indices.into_iter().for_each(&mut eat);
            eat(error);
        }
    }
    hash
}

/// The importer's chain length for the golden (its primitives' level count).
fn importer_levels() -> usize {
    let (json, _) = split(&import_fixture("lods-sphere.glb"));
    let primitives = json["meshes"][0]["primitives"].as_array().expect("primitives");
    primitives.iter().map(|p| p["extras"]["genex_lods"]["levels"].as_array().expect("levels").len()).min().expect("a primitive")
}

/// The test's own UV sphere as the importer's conformance test builds it (`sphereGlb` in
/// `tests/conformance/rust-assets-lods.test.ts`): `rings` x `segments` quads, one primitive of
/// positions only, wound to face out, its seam and poles not welded. The trigonometry is f64
/// libm rounded to f32, as JavaScript's `Math` and `Float32Array` give it.
fn sphere_glb(rings: u32, segments: u32) -> Vec<u8> {
    let mut bin: Vec<u8> = Vec::new();
    let (mut min, mut max) = ([f32::MAX; 3], [f32::MIN; 3]);
    for r in 0..=rings {
        for s in 0..=segments {
            let theta = f64::from(r) / f64::from(rings) * std::f64::consts::PI;
            let phi = f64::from(s) / f64::from(segments) * std::f64::consts::PI * 2.0;
            let p = [libm::sin(theta) * libm::cos(phi), libm::cos(theta), libm::sin(theta) * libm::sin(phi)].map(|v| v as f32);
            for axis in 0..3 {
                min[axis] = min[axis].min(p[axis]);
                max[axis] = max[axis].max(p[axis]);
            }
            p.iter().for_each(|v| bin.extend(v.to_le_bytes()));
        }
    }
    let position_bytes = bin.len();
    let mut count = 0usize;
    for r in 0..rings {
        for s in 0..segments {
            let a = r * (segments + 1) + s;
            let b = a + segments + 1;
            for index in [a, a + 1, b, a + 1, b + 1, b] {
                bin.extend(index.to_le_bytes());
                count += 1;
            }
        }
    }
    let vertices = (rings + 1) * (segments + 1);
    let json = serde_json::json!({
        "asset": {"version": "2.0"},
        "buffers": [{"byteLength": bin.len()}],
        "bufferViews": [{"buffer": 0, "byteLength": position_bytes}, {"buffer": 0, "byteOffset": position_bytes, "byteLength": count * 4}],
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": vertices, "type": "VEC3", "min": min, "max": max},
            {"bufferView": 1, "componentType": 5125, "count": count, "type": "SCALAR"}
        ],
        "meshes": [{"name": "sphere", "primitives": [{"attributes": {"POSITION": 0}, "indices": 1}]}],
        "nodes": [{"mesh": 0}], "scenes": [{"nodes": [0]}], "scene": 0
    });
    join(&json, bin)
}

/// The importer's levels for [`sphere_glb`] (`addLodExtras` in `src/substrate/asset-import/lods.ts`
/// on the same GLB, npm meshoptimizer 1.3.0, 2026-10-22): the level count and each level's index
/// count. Re-record with the lane's scratch script when the importer's parameters change.
const IMPORTER_SPHERE_LEVELS: [(u32, u32, &[usize]); 2] = [(16, 32, &[1533, 768, 393]), (32, 64, &[6141, 3072, 1536, 768])];

/// Red first (LOD-21): a sphere GLB that arrives without `genex_lods` gets at runtime as many
/// levels as the importer gives the same GLB, each within a quarter of the importer's index count
/// (the port leaves out `ErrorClamped` and `Prune`, which let the importer's coarsest level go further),
/// and the drawn mesh keeps its own triangles.
#[test]
fn an_unimported_sphere_glb_gets_the_same_level_count_as_the_importer() {
    for (rings, segments, importer) in IMPORTER_SPHERE_LEVELS {
        let mut parts = parts_of(&sphere_glb(rings, segments));
        assert!(parts.iter().all(|part| part.lods.is_none()), "an unimported GLB has no chain");
        let before: Vec<MeshData> = parts.iter().map(|part| part.mesh.clone()).collect();
        let outcome = add_runtime_chains(&mut parts);
        assert_eq!(outcome, RuntimeLodOutcome::Built { levels: importer.len() as u32 }, "{rings} x {segments}");
        let [part] = parts.as_slice() else { panic!("one part") };
        assert_eq!(part.mesh, before[0], "the mesh itself is untouched");
        let counts: Vec<usize> = part.lods.as_ref().expect("chain").levels.iter().map(|level| level.indices.len()).collect();
        println!("{rings} x {segments}: runtime {counts:?}, importer {importer:?}");
        for (runtime, imported) in counts.iter().zip(importer) {
            assert!(runtime.abs_diff(*imported) * 4 <= *imported, "{rings} x {segments}: runtime {counts:?}, importer {importer:?}");
        }
    }
}

/// The import step's two-primitive golden without its levels: the runtime works on the merged
/// part (one per material), where the importer measured each primitive and took the longer
/// chain, so it may stop a level earlier; the chain is still valid and never longer.
#[test]
fn the_unimported_two_primitive_golden_gets_a_chain_no_longer_than_the_importers() {
    let mut parts = parts_of(&unimported_sphere());
    let RuntimeLodOutcome::Built { levels } = add_runtime_chains(&mut parts) else { panic!("a chain") };
    println!("two-primitive golden: runtime {levels} levels, importer {}", importer_levels());
    assert!(levels >= 1 && levels as usize <= importer_levels());
}

/// Red first (LOD-21): building twice gives the same chain bit for bit, and the pinned digest
/// holds it to the bits every destination builds (no hashing, no threads, no transcendental).
#[test]
fn runtime_chain_is_deterministic_across_runs() {
    let build = || {
        let mut parts = parts_of(&unimported_sphere());
        add_runtime_chains(&mut parts);
        parts
    };
    let (first, second) = (build(), build());
    assert_eq!(first, second);
    let mut sphere = vec![ModelPart::whole(MeshData::sphere())];
    assert!(matches!(add_runtime_chains(&mut sphere), RuntimeLodOutcome::Built { .. }));
    let mut uv = parts_of(&sphere_glb(32, 64));
    add_runtime_chains(&mut uv);
    let digests = [digest(&first), digest(&sphere), digest(&uv)];
    println!("runtime chain digests: golden {:#018x}, immediate sphere {:#018x}, 32 x 64 sphere {:#018x}", digests[0], digests[1], digests[2]);
    assert_eq!(digests, PINNED_DIGESTS, "a changed chain is a named flip");
}

/// The digests [`runtime_chain_is_deterministic_across_runs`] pins: the stripped golden sphere's
/// chain, the immediate sphere's and the 32 x 64 UV sphere's.
const PINNED_DIGESTS: [u64; 3] = [0x8575_1a1a_dbcf_a050, 0xd9fe_0f71_68b3_d8b5, 0xb53a_248a_6ad4_d9f2];

/// Red first (LOD-21): a model past [`RUNTIME_LOD_MAX_TRIANGLES`] is not simplified at load (it
/// would stall the frame); one at the import threshold is, and one under it is not.
#[test]
fn load_time_budget_per_model() {
    let side = ((RUNTIME_LOD_MAX_TRIANGLES / 2) as f32).sqrt() as u32 + 1;
    let mut over = vec![ModelPart::whole(grid(side, hills, [0.0, 0.0]))];
    assert!(over[0].mesh.indices.len() / 3 > RUNTIME_LOD_MAX_TRIANGLES as usize);
    let before = over.clone();
    assert_eq!(add_runtime_chains(&mut over), RuntimeLodOutcome::OverBudget);
    assert_eq!(over, before, "no side effect");
    let at_threshold = ((LOD_MIN_TRIANGLES / 2) as f32).sqrt().ceil() as u32;
    let mut small = vec![ModelPart::whole(grid(at_threshold, hills, [0.0, 0.0]))];
    assert!(small[0].mesh.indices.len() / 3 >= LOD_MIN_TRIANGLES as usize);
    assert!(matches!(add_runtime_chains(&mut small), RuntimeLodOutcome::Built { .. }));
    let mut under = vec![ModelPart::whole(grid(at_threshold - 1, hills, [0.0, 0.0]))];
    assert_eq!(add_runtime_chains(&mut under), RuntimeLodOutcome::BelowThreshold);
    assert!(under[0].lods.is_none());
}

/// Every built chain is one the renderer takes: whole triangles over the part's vertices, each
/// level no finer than the one before and markedly coarser on the largest part, errors growing,
/// and each error at least how far the mesh's vertices lie from the level.
#[test]
fn every_level_is_a_valid_coarser_chain_with_an_error_at_least_its_deviation() {
    let models = [("golden sphere", parts_of(&unimported_sphere())), ("immediate sphere", vec![ModelPart::whole(MeshData::sphere())]), ("hills", vec![ModelPart::whole(grid(48, hills, [0.0, 0.0]))])];
    for (name, mut parts) in models {
        let outcome = add_runtime_chains(&mut parts);
        let RuntimeLodOutcome::Built { levels } = outcome else { panic!("{name}: {outcome:?}") };
        assert!((1..=LOD_MAX_LEVELS).contains(&levels), "{name}: {levels}");
        for part in &parts {
            let chain = part.lods.as_ref().expect("a chain");
            let points = positions(&part.mesh);
            let mut previous = (part.mesh.indices.len(), 0.0f32);
            for (at, level) in chain.levels.iter().enumerate() {
                assert!(!level.indices.is_empty() && level.indices.len().is_multiple_of(3), "{name} level {at}: whole triangles");
                assert!(level.indices.iter().all(|&i| (i as usize) < points.len()), "{name} level {at}: over its vertices");
                assert!(level.indices.len() <= previous.0 && level.error >= previous.1, "{name} level {at}: coarser, error growing");
                let deviation = vertex_deviation(&points, &part.mesh.indices, &level.indices);
                assert!(level.error >= deviation, "{name} level {at}: error {} under deviation {deviation}", level.error);
                assert!(level.error.is_finite() && level.error <= mesh_extent(&points), "{name} level {at}: error {}", level.error);
                previous = (level.indices.len(), level.error);
            }
        }
        let largest = parts.iter().max_by_key(|part| part.mesh.indices.len()).expect("a part");
        let counts: Vec<usize> = std::iter::once(largest.mesh.indices.len()).chain(largest.lods.as_ref().expect("chain").levels.iter().map(|l| l.indices.len())).collect();
        assert!(counts.windows(2).all(|w| w[1] as f32 <= w[0] as f32 * RUNTIME_LOD_MIN_REDUCTION), "{name}: markedly coarser each level: {counts:?}");
    }
}

/// Two parts (two materials) that meet along an edge keep every vertex of that edge in every
/// level, so they never open a crack.
#[test]
fn parts_that_meet_keep_their_shared_vertices_in_every_level() {
    let mut parts = vec![ModelPart::whole(grid(24, hills, [0.0, 0.0])), ModelPart::whole(grid(24, hills, [1.0, 0.0]))];
    assert!(matches!(add_runtime_chains(&mut parts), RuntimeLodOutcome::Built { .. }));
    let on_seam = |position: [f32; 3]| position[0] == 1.0;
    let seam_count = parts[0].mesh.vertices.iter().filter(|v| on_seam(v.position)).count();
    assert_eq!(seam_count, 25);
    for (at, part) in parts.iter().enumerate() {
        for (level_at, level) in part.lods.as_ref().expect("chain").levels.iter().enumerate() {
            let mut kept: Vec<u32> = level.indices.iter().copied().filter(|&i| on_seam(part.mesh.vertices[i as usize].position)).collect();
            kept.sort_unstable();
            kept.dedup();
            assert_eq!(kept.len(), seam_count, "part {at} level {level_at}: every shared vertex stays");
        }
    }
}

/// Hostile parts (an index past the vertices, a position that is not finite, a partial triangle,
/// a part with no triangles, a flat cloud of one point) build no chain, never panic, and leave
/// the parts as they were; a model that already has a chain is left alone.
#[test]
fn hostile_parts_build_no_chain_and_leave_the_model_unchanged() {
    type Damage = fn(&mut MeshData);
    let rows: [(&str, RuntimeLodOutcome, Damage); 6] = [
        ("an index past the vertices", RuntimeLodOutcome::NotCoarser, |m| m.indices[4] = 1_000_000),
        ("a NaN position", RuntimeLodOutcome::NotCoarser, |m| m.vertices[7].position[1] = f32::NAN),
        ("an infinite position", RuntimeLodOutcome::NotCoarser, |m| m.vertices[3].position[0] = f32::INFINITY),
        ("a partial triangle", RuntimeLodOutcome::NotCoarser, |m| {
            m.indices.push(0);
        }),
        ("one point", RuntimeLodOutcome::NotCoarser, |m| m.vertices.iter_mut().for_each(|v| v.position = [0.5, 0.5, 0.5])),
        ("no triangles", RuntimeLodOutcome::BelowThreshold, |m| m.indices.clear()),
    ];
    for (name, expected, damage) in rows {
        let mut mesh = grid(24, hills, [0.0, 0.0]);
        damage(&mut mesh);
        let mut parts = vec![ModelPart::whole(mesh)];
        let before = parts.clone();
        assert_eq!(add_runtime_chains(&mut parts), expected, "{name}");
        assert_eq!(format!("{parts:?}"), format!("{before:?}"), "{name}: no side effect (NaN-safe)");
    }
    let mut empty_beside = vec![ModelPart::whole(grid(24, hills, [0.0, 0.0])), ModelPart::whole(MeshData::default())];
    let before = empty_beside.clone();
    assert_eq!(add_runtime_chains(&mut empty_beside), RuntimeLodOutcome::NotCoarser, "a part with no triangles beside one with many");
    assert_eq!(empty_beside, before);
    let mut imported = parts_of(&import_fixture("lods-sphere.glb"));
    let before = imported.clone();
    assert_eq!(add_runtime_chains(&mut imported), RuntimeLodOutcome::Imported);
    assert_eq!(imported, before, "the importer's chain stays");
    assert!(add_runtime_chains(&mut []) == RuntimeLodOutcome::BelowThreshold);
}

/// The simplifier on its own: a closed sphere reaches its target (within the 1/32 a level may
/// stop short), its relative error within the limit; a target above the input comes back
/// unchanged with error 0, and so does a mesh with every vertex locked.
#[test]
fn the_simplifier_reaches_its_target_within_its_error_limit() {
    let sphere = MeshData::sphere();
    let points = positions(&sphere);
    let none = vec![false; points.len()];
    let target = sphere.indices.len() / 4 / 3 * 3;
    let (indices, error) = simplify(&points, &sphere.indices, &none, target, RUNTIME_LOD_MAX_RELATIVE_ERROR);
    assert!(indices.len() <= target + target / 32, "{} indices for a target of {target}", indices.len());
    assert!(error > 0.0 && error <= RUNTIME_LOD_MAX_RELATIVE_ERROR, "{error}");
    let (same, zero) = simplify(&points, &sphere.indices, &none, sphere.indices.len(), RUNTIME_LOD_MAX_RELATIVE_ERROR);
    assert_eq!((same, zero), (sphere.indices.clone(), 0.0));
    let (tight, tight_error) = simplify(&points, &sphere.indices, &none, 0, 1e-4);
    assert!(tight.len() > target && tight_error <= 1e-4, "the error limit stops it first: {} indices, {tight_error}", tight.len());
    let all = vec![true; points.len()];
    let (locked, locked_error) = simplify(&points, &sphere.indices, &all, target, RUNTIME_LOD_MAX_RELATIVE_ERROR);
    assert_eq!((locked, locked_error), (sphere.indices.clone(), 0.0), "every vertex locked: nothing moves");
}

/// The phone memory row: a chain costs at most a quarter more than the mesh itself (index bytes,
/// and the vertices each level's own mesh keeps, as the library stores it; the levels' triangles
/// halve, but locked poles and seams keep their vertices in every level), recorded per model.
#[test]
fn a_chain_costs_at_most_a_quarter_more_than_the_mesh_itself() {
    let models = [("golden sphere", parts_of(&unimported_sphere())), ("immediate sphere", vec![ModelPart::whole(MeshData::sphere())]), ("hills 96", vec![ModelPart::whole(grid(96, hills, [0.0, 0.0]))]), ("32 x 64 sphere", parts_of(&sphere_glb(32, 64)))];
    let vertex_bytes = std::mem::size_of::<Vertex>();
    for (name, mut parts) in models {
        add_runtime_chains(&mut parts);
        let (mut mesh_bytes, mut chain_bytes) = (0usize, 0usize);
        for part in &parts {
            mesh_bytes += part.mesh.indices.len() * 4 + part.mesh.vertices.len() * vertex_bytes;
            for level in &part.lods.as_ref().expect("chain").levels {
                let mut used = level.indices.clone();
                used.sort_unstable();
                used.dedup();
                chain_bytes += level.indices.len() * 4 + used.len() * vertex_bytes;
            }
        }
        println!("memory row {name}: mesh {mesh_bytes} B, chain {chain_bytes} B ({:.2}x)", chain_bytes as f32 / mesh_bytes as f32);
        assert!(chain_bytes * 4 <= mesh_bytes * 5, "{name}: chain {chain_bytes} B over 1.25x the mesh's {mesh_bytes} B");
    }
}

/// Advisory (release): the time a chain takes to build at load, per model size. Not a pass/fail
/// row: the machine's load decides it; the numbers go into the lane's record.
#[test]
#[ignore = "advisory load-time numbers; run in release with --nocapture"]
#[allow(clippy::disallowed_types, reason = "an advisory load-time row reads the wall clock; no chain depends on it")]
fn advisory_runtime_chain_load_time() {
    for side in [32u32, 100, 160, 223] {
        let mut parts = vec![ModelPart::whole(grid(side, hills, [0.0, 0.0]))];
        let triangles = parts[0].mesh.indices.len() / 3;
        let started = std::time::Instant::now();
        let outcome = add_runtime_chains(&mut parts);
        println!("load-time row: {triangles} triangles, {outcome:?}, {:.1} ms", started.elapsed().as_secs_f64() * 1000.0);
    }
    let big = grid(316, hills, [0.0, 0.0]);
    let (points, none) = (positions(&big), vec![false; big.vertices.len()]);
    let started = std::time::Instant::now();
    let (half, _) = simplify(&points, &big.indices, &none, big.indices.len() / 6 * 3, RUNTIME_LOD_MAX_RELATIVE_ERROR);
    println!("load-time row: one simplify of {} triangles to half, {:.1} ms", big.indices.len() / 3, started.elapsed().as_secs_f64() * 1000.0);
    let started = std::time::Instant::now();
    vertex_deviation(&points, &big.indices, &half);
    println!("load-time row: one deviation of that level, {:.1} ms", started.elapsed().as_secs_f64() * 1000.0);
    let mut sphere = parts_of(&unimported_sphere());
    let started = std::time::Instant::now();
    add_runtime_chains(&mut sphere);
    println!("load-time row: golden sphere, {:.2} ms", started.elapsed().as_secs_f64() * 1000.0);
}
