//! The runtime tangent fallback (game systems C-9): a normal-mapped primitive that reaches the
//! runtime without `TANGENT` (a hand-made or generated GLB that skipped the Studio's import step)
//! gets MikkTSpace tangents from `bevy_mikktspace`, the same space the import step writes with
//! meshoptimizer's `generateTangents(Compatible)` (C-8), so a baked normal map shades the same with
//! or without the import. MikkTSpace answers per corner; a vertex whose corners disagree (a mirrored
//! uv seam, where the sign flips) becomes one vertex per distinct tangent, as the import step splits
//! it. Before C-9 the runtime summed uv gradients per vertex, which seams at every mirror.
//!
//! The fixtures are the import step's own (`tests/fixtures/asset-import/README.md`):
//! `tangents-mirrored.glb` (no TANGENT) and `tangents-mirrored.imported.glb` (what the import step
//! wrote from it). Corners are matched by their triangle's three positions, so the import step's
//! weld and vertex reorder do not matter.

use std::collections::BTreeMap;

use genex_render::mesh::{GlbModel, MeshData};

/// The largest per-component difference between a runtime corner tangent and the import step's,
/// from the characterization row below (the measured maximum, rounded up to a power of ten).
const IMPORT_TOLERANCE: f32 = 1e-4;

/// The repository's asset-import fixtures.
fn import_fixture(name: &str) -> Vec<u8> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../tests/fixtures/asset-import").join(name);
    std::fs::read(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

/// A position as a hashable key (bit for bit).
type PositionKey = [u32; 3];

fn position_key(position: [f32; 3]) -> PositionKey {
    position.map(f32::to_bits)
}

/// Every corner's tangent keyed by its triangle (its three positions, sorted) and its own position.
fn corner_tangents(mesh: &MeshData) -> BTreeMap<([PositionKey; 3], PositionKey), [f32; 4]> {
    let mut corners = BTreeMap::new();
    for triangle in mesh.indices.as_chunks::<3>().0 {
        let vertices = triangle.map(|i| mesh.vertices[i as usize]);
        let mut key = vertices.map(|v| position_key(v.position));
        key.sort_unstable();
        for vertex in vertices {
            corners.insert((key, position_key(vertex.position)), vertex.tangent);
        }
    }
    corners
}

/// How a runtime mesh's corner tangents compare with the import step's on the same triangles.
#[derive(Debug, Default)]
struct Comparison {
    corners: usize,
    degenerate: usize,
    unmatched: usize,
    sign_flips: usize,
    largest: f32,
}

/// Whether a triangle (its three positions) has no area: two corners at one point (a pole's fan).
fn is_degenerate(triangle: [PositionKey; 3]) -> bool {
    triangle[0] == triangle[1] || triangle[1] == triangle[2] || triangle[0] == triangle[2]
}

fn compare(runtime: &MeshData, imported: &MeshData) -> Comparison {
    let runtime = corner_tangents(runtime);
    let mut comparison = Comparison::default();
    for (key, expected) in corner_tangents(imported) {
        if is_degenerate(key.0) {
            // A zero-area triangle rasterizes no fragment, so its corners' tangents never shade:
            // MikkTSpace borrows a neighbour's there, meshoptimizer writes +x.
            comparison.degenerate += 1;
            continue;
        }
        comparison.corners += 1;
        let Some(actual) = runtime.get(&key) else {
            comparison.unmatched += 1;
            continue;
        };
        if actual[3] != expected[3] {
            comparison.sign_flips += 1;
        }
        let largest = (0..3).map(|axis| (actual[axis] - expected[axis]).abs()).fold(0.0_f32, f32::max);
        comparison.largest = comparison.largest.max(largest);
    }
    comparison
}

#[test]
fn runtime_tangents_of_the_unimported_mirrored_sphere_match_the_import_step_s() {
    let runtime = MeshData::from_glb(&import_fixture("tangents-mirrored.glb")).expect("the unimported sphere loads");
    let imported = MeshData::from_glb(&import_fixture("tangents-mirrored.imported.glb")).expect("the imported sphere loads");
    let comparison = compare(&runtime, &imported);
    eprintln!("tangents-mirrored: runtime vs import step: {comparison:?}");
    assert!(comparison.corners > 0);
    assert_eq!(comparison.unmatched, 0, "every imported corner has a runtime corner on the same triangle: {comparison:?}");
    assert_eq!(comparison.sign_flips, 0, "the bitangent sign agrees at every corner, the mirror seams included: {comparison:?}");
    assert!(comparison.largest <= IMPORT_TOLERANCE, "the largest component difference is within {IMPORT_TOLERANCE}: {comparison:?}");
}

#[test]
fn the_runtime_fallback_is_named_on_the_part_it_ran_for_and_only_there() {
    let unimported = GlbModel::from_glb(&import_fixture("tangents-mirrored.glb")).expect("loads");
    assert!(unimported.parts().iter().all(|part| part.runtime_tangents), "the import step was skipped");
    let imported = GlbModel::from_glb(&import_fixture("tangents-mirrored.imported.glb")).expect("loads");
    assert!(imported.parts().iter().all(|part| !part.runtime_tangents), "the import step wrote TANGENT");
    // A primitive with no normal map is not what the import step generates tangents for.
    let plain = GlbModel::from_glb(&import_fixture("lods-sphere.glb")).expect("loads");
    assert!(plain.parts().iter().all(|part| !part.runtime_tangents));
}

#[test]
fn a_mirrored_seam_splits_vertices_and_the_split_is_the_same_every_load() {
    let bytes = import_fixture("tangents-mirrored.glb");
    let first = MeshData::from_glb(&bytes).expect("loads");
    let again = MeshData::from_glb(&bytes).expect("loads");
    assert_eq!(first, again, "bit for bit");
    let positions = position_count(&bytes);
    assert!(first.vertices.len() > positions, "the seams split off copies: {} vertices from {positions} positions", first.vertices.len());
    // Every corner's sign is continuous inside a uv island: both signs occur on the mirrored sphere.
    assert!(first.vertices.iter().any(|v| v.tangent[3] > 0.0) && first.vertices.iter().any(|v| v.tangent[3] < 0.0));
    for vertex in &first.vertices {
        let [x, y, z, _] = vertex.tangent;
        let length = (x * x + y * y + z * z).sqrt();
        assert!((length - 1.0).abs() < 1e-4, "unit tangent: {vertex:?}");
    }
}

#[test]
fn a_primitive_without_a_normal_map_keeps_one_vertex_per_position_and_its_import_extras() {
    let bytes = import_fixture("lods-sphere.glb");
    let model = GlbModel::from_glb(&bytes).expect("loads");
    let vertices: usize = model.parts().iter().map(|part| part.mesh.vertices.len()).sum();
    assert_eq!(vertices, position_count(&bytes), "no seam is split where no normal map samples the tangents");
    assert!(model.parts().iter().all(|part| part.lods.is_some() && part.lod_warnings.is_empty()), "its genex_lods still validate");
}

/// The POSITION count of every primitive of a GLB (each accessor counted once per primitive).
fn position_count(glb: &[u8]) -> usize {
    let json_len = u32::from_le_bytes(glb[12..16].try_into().expect("length")) as usize;
    let json: serde_json::Value = serde_json::from_slice(&glb[20..20 + json_len]).expect("json");
    let accessors = json["accessors"].as_array().expect("accessors");
    json["meshes"]
        .as_array()
        .expect("meshes")
        .iter()
        .flat_map(|mesh| mesh["primitives"].as_array().expect("primitives"))
        .map(|primitive| accessors[primitive["attributes"]["POSITION"].as_u64().expect("POSITION") as usize]["count"].as_u64().expect("count") as usize)
        .sum()
}
