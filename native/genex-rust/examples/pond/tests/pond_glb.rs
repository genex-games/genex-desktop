//! `assets/pond.glb` (the stone rim) and `assets/water.glb` (the water disc inside it) are generated
//! by this file and committed: the row checks the committed bytes still equal the generator's and
//! that the renderer's GLB loader takes them.
//! Regenerate with `GENEX_UPDATE_ASSETS=1 rust-env.sh cargo test -p pond --test pond_glb`.

use genex::json;
use genex::math::{TAU, sin_cos};
use genex_render::mesh::MeshData;
use std::path::PathBuf;

const SEGMENTS: u32 = 48;
const INNER_RADIUS: f32 = 6.2;
/// The water disc reaches just under the rim's inner wall.
const WATER_RADIUS: f32 = 6.3;
const OUTER_RADIUS: f32 = 7.4;
const TOP: f32 = 0.35;
const BOTTOM: f32 = -0.4;
const GLB_MAGIC: u32 = 0x4654_6c67;
const CHUNK_JSON: u32 = 0x4e4f_534a;
const CHUNK_BIN: u32 = 0x004e_4942;
const ARRAY_BUFFER: u32 = 34962;
const ELEMENT_ARRAY_BUFFER: u32 = 34963;
const FLOAT: u32 = 5126;
const UNSIGNED_INT: u32 = 5125;

fn asset_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("assets").join(name)
}

/// Six vertices per ring step (top inner and outer, outer wall top and bottom, inner wall top and
/// bottom), with the seam duplicated, and counter-clockwise front faces.
fn rim() -> (Vec<[f32; 3]>, Vec<[f32; 3]>, Vec<u32>) {
    let (mut positions, mut normals, mut indices) = (Vec::new(), Vec::new(), Vec::new());
    for i in 0..=SEGMENTS {
        let (sin, cos) = sin_cos(TAU * i as f32 / SEGMENTS as f32);
        let at = |r: f32, y: f32| [cos * r, y, sin * r];
        let out = [cos, 0.0, sin];
        let inward = [-cos, 0.0, -sin];
        let ring = [
            (at(INNER_RADIUS, TOP), [0.0, 1.0, 0.0]),
            (at(OUTER_RADIUS, TOP), [0.0, 1.0, 0.0]),
            (at(OUTER_RADIUS, TOP), out),
            (at(OUTER_RADIUS, BOTTOM), out),
            (at(INNER_RADIUS, TOP), inward),
            (at(INNER_RADIUS, BOTTOM), inward),
        ];
        for (position, normal) in ring {
            positions.push(position);
            normals.push(normal);
        }
    }
    for i in 0..SEGMENTS {
        let (a, b) = (6 * i, 6 * (i + 1));
        // Top: inner, outer; outer wall: top, bottom; inner wall: top, bottom.
        indices.extend([a, b + 1, a + 1, a, b, b + 1]);
        indices.extend([a + 3, a + 2, b + 2, a + 3, b + 2, b + 3]);
        indices.extend([a + 5, b + 4, a + 4, a + 5, b + 5, b + 4]);
    }
    (positions, normals, indices)
}

/// A flat disc at y = 0 facing up: a centre vertex and one ring.
fn disc() -> (Vec<[f32; 3]>, Vec<[f32; 3]>, Vec<u32>) {
    let mut positions = vec![[0.0, 0.0, 0.0]];
    for i in 0..=SEGMENTS {
        let (sin, cos) = sin_cos(TAU * i as f32 / SEGMENTS as f32);
        positions.push([cos * WATER_RADIUS, 0.0, sin * WATER_RADIUS]);
    }
    let normals = vec![[0.0, 1.0, 0.0]; positions.len()];
    let indices = (1..=SEGMENTS).flat_map(|i| [0, i + 1, i]).collect();
    (positions, normals, indices)
}

fn bounds(positions: &[[f32; 3]]) -> ([f32; 3], [f32; 3]) {
    let mut min = [f32::MAX; 3];
    let mut max = [f32::MIN; 3];
    for p in positions {
        for axis in 0..3 {
            min[axis] = min[axis].min(p[axis]);
            max[axis] = max[axis].max(p[axis]);
        }
    }
    (min, max)
}

fn pad(bytes: &mut Vec<u8>, with: u8) {
    while !bytes.len().is_multiple_of(4) {
        bytes.push(with);
    }
}

fn glb(name: &str, (positions, normals, indices): (Vec<[f32; 3]>, Vec<[f32; 3]>, Vec<u32>)) -> Vec<u8> {
    let mut bin: Vec<u8> = Vec::new();
    for v in positions.iter().chain(&normals) {
        for c in v {
            bin.extend(c.to_le_bytes());
        }
    }
    for i in &indices {
        bin.extend(i.to_le_bytes());
    }
    let vertex_bytes = positions.len() * 12;
    let (min, max) = bounds(&positions);
    let document = json!({
        "asset": { "version": "2.0", "generator": "pond tests/pond_glb.rs" },
        "scene": 0,
        "scenes": [{ "nodes": [0] }],
        "nodes": [{ "mesh": 0, "name": name }],
        "meshes": [{ "name": name, "primitives": [{ "attributes": { "POSITION": 0, "NORMAL": 1 }, "indices": 2 }] }],
        "buffers": [{ "byteLength": bin.len() }],
        "bufferViews": [
            { "buffer": 0, "byteOffset": 0, "byteLength": vertex_bytes, "target": ARRAY_BUFFER },
            { "buffer": 0, "byteOffset": vertex_bytes, "byteLength": vertex_bytes, "target": ARRAY_BUFFER },
            { "buffer": 0, "byteOffset": 2 * vertex_bytes, "byteLength": indices.len() * 4, "target": ELEMENT_ARRAY_BUFFER },
        ],
        "accessors": [
            { "bufferView": 0, "componentType": FLOAT, "count": positions.len(), "type": "VEC3", "min": min, "max": max },
            { "bufferView": 1, "componentType": FLOAT, "count": normals.len(), "type": "VEC3" },
            { "bufferView": 2, "componentType": UNSIGNED_INT, "count": indices.len(), "type": "SCALAR" },
        ],
    });
    let mut json_chunk = document.to_string().into_bytes();
    pad(&mut json_chunk, b' ');
    pad(&mut bin, 0);
    let total = 12 + 8 + json_chunk.len() + 8 + bin.len();
    let mut out = Vec::with_capacity(total);
    for word in [GLB_MAGIC, 2, total as u32, json_chunk.len() as u32, CHUNK_JSON] {
        out.extend(word.to_le_bytes());
    }
    out.extend(json_chunk);
    for word in [bin.len() as u32, CHUNK_BIN] {
        out.extend(word.to_le_bytes());
    }
    out.extend(bin);
    out
}

fn check(file: &str, generated: &[u8]) -> MeshData {
    if std::env::var("GENEX_UPDATE_ASSETS").as_deref() == Ok("1") {
        std::fs::write(asset_path(file), generated).expect("write the asset");
    }
    let committed = std::fs::read(asset_path(file)).expect("the asset is committed");
    assert!(committed == generated, "assets/{file} differs from the generator: regenerate it (see the file header)");
    assert!(pond_game::ASSETS.contains(&(file, committed.as_slice())), "the game compiles in the committed {file}");
    MeshData::from_glb(&committed).expect("the renderer loads it")
}

#[test]
fn the_committed_models_are_the_generators_and_load() {
    let rim = check("pond.glb", &glb("rim", rim()));
    assert_eq!(rim.indices.len(), (SEGMENTS * 18) as usize);
    assert!(rim.bounds().1 > OUTER_RADIUS, "the bounds hold the whole rim");
    let water = check("water.glb", &glb("water", disc()));
    assert_eq!(water.indices.len(), (SEGMENTS * 3) as usize);
    assert!(water.vertices.iter().all(|v| v.normal == [0.0, 1.0, 0.0]));
}
