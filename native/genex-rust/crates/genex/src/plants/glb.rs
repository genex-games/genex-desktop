//! A plant level as a GLB: one node, one mesh, one primitive a part (bark, then foliage) with its
//! material, the maps embedded as PNG images. The full level carries the maps; a coarser level
//! carries the same two materials untextured (a level draws with the full level's materials, part
//! for part), so its file stays small. Foliage is glTF `MASK`, double-sided and
//! `KHR_materials_diffuse_transmission`, so the file keeps its leaves' look in any glTF viewer and
//! through Studio's import step.

use serde_json::{Value, json};

use super::geometry::Part;
use super::png::encode_rgba;
use super::texture::Image;
use crate::mesh::{container, floats, tangents};

/// The foliage's alpha cutoff.
const CUTOFF: f32 = 0.5;
/// How much light a leaf lets through (`diffuseTransmissionFactor`).
const LEAF_TRANSMISSION: f32 = 0.55;
/// The roughness of a leaf's surface and of untextured bark.
const LEAF_ROUGHNESS: f32 = 0.6;
const BARK_ROUGHNESS: f32 = 0.9;

/// The maps a full level embeds, in image order.
pub(crate) struct Maps<'a> {
    pub(crate) bark: Option<[&'a Image; 3]>,
    pub(crate) cards: [&'a Image; 2],
}

/// What a part is drawn as.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Surface {
    Bark,
    Foliage,
}

/// The GLB of `parts` (each with its surface), embedding `maps` when given.
pub(crate) fn write(parts: &[(&Part, Surface)], maps: Option<&Maps<'_>>) -> Vec<u8> {
    let mut bin: Vec<u8> = Vec::new();
    let mut views: Vec<Value> = Vec::new();
    let mut accessors: Vec<Value> = Vec::new();
    let mut view = |bin: &mut Vec<u8>, bytes: &[u8], target: Option<u32>| {
        while !bin.len().is_multiple_of(4) {
            bin.push(0);
        }
        let mut entry = json!({ "buffer": 0, "byteOffset": bin.len(), "byteLength": bytes.len() });
        if let Some(target) = target {
            entry["target"] = json!(target);
        }
        views.push(entry);
        bin.extend_from_slice(bytes);
        views.len() - 1
    };
    let mut primitives = Vec::new();
    for (part, surface) in parts {
        let tangent = tangents(&part.positions, &part.normals, &part.uvs, &part.indices);
        let (min, max) = part.positions.iter().fold(([f32::INFINITY; 3], [f32::NEG_INFINITY; 3]), |(lo, hi), p| {
            (
                [lo[0].min(p.x), lo[1].min(p.y), lo[2].min(p.z)],
                [hi[0].max(p.x), hi[1].max(p.y), hi[2].max(p.z)],
            )
        });
        let count = part.positions.len();
        let at = accessors.len();
        let chunks: [(Vec<u8>, &str); 4] = [
            (floats(part.positions.iter().flat_map(|p| p.to_array())), "VEC3"),
            (floats(part.normals.iter().flat_map(|n| n.to_array())), "VEC3"),
            (floats(part.uvs.iter().flat_map(|uv| uv.to_array())), "VEC2"),
            (floats(tangent.iter().flatten().copied()), "VEC4"),
        ];
        for (bytes, kind) in &chunks {
            let index = view(&mut bin, bytes, Some(34962));
            accessors.push(json!({ "bufferView": index, "componentType": 5126, "count": count, "type": kind }));
        }
        accessors[at]["min"] = json!(min);
        accessors[at]["max"] = json!(max);
        let indices: Vec<u8> = part.indices.iter().flat_map(|i| i.to_le_bytes()).collect();
        let index = view(&mut bin, &indices, Some(34963));
        accessors.push(json!({ "bufferView": index, "componentType": 5125, "count": part.indices.len(), "type": "SCALAR" }));
        let material = if *surface == Surface::Bark { 0 } else { 1 };
        primitives.push(json!({
            "attributes": { "POSITION": at, "NORMAL": at + 1, "TEXCOORD_0": at + 2, "TANGENT": at + 3 },
            "indices": at + 4,
            "material": material,
            "mode": 4,
        }));
    }
    let mut images = Vec::new();
    if let Some(maps) = maps {
        let embedded: Vec<&Image> = maps.bark.iter().flatten().copied().chain(maps.cards).collect();
        for image in embedded {
            let png = encode_rgba(&image.rgba, image.size, image.size);
            let index = view(&mut bin, &png, None);
            images.push(json!({ "bufferView": index, "mimeType": "image/png" }));
        }
    }
    let textured = maps.is_some();
    let bark_textured = maps.is_some_and(|maps| maps.bark.is_some());
    let first_card = if bark_textured { 3 } else { 0 };
    let bark = if bark_textured {
        json!({
            "name": "bark",
            "pbrMetallicRoughness": { "baseColorTexture": { "index": 0 }, "metallicRoughnessTexture": { "index": 2 }, "metallicFactor": 1.0, "roughnessFactor": 1.0 },
            "normalTexture": { "index": 1, "scale": 1.0 },
            "occlusionTexture": { "index": 2, "strength": 1.0 },
        })
    } else {
        json!({ "name": "bark", "pbrMetallicRoughness": { "baseColorFactor": [0.4, 0.36, 0.32, 1.0], "metallicFactor": 0.0, "roughnessFactor": BARK_ROUGHNESS } })
    };
    let mut foliage = json!({
        "name": "foliage",
        "pbrMetallicRoughness": { "metallicFactor": 0.0, "roughnessFactor": LEAF_ROUGHNESS },
        "alphaMode": "MASK",
        "alphaCutoff": CUTOFF,
        "doubleSided": true,
        "extensions": { "KHR_materials_diffuse_transmission": { "diffuseTransmissionFactor": LEAF_TRANSMISSION } },
    });
    if textured {
        foliage["pbrMetallicRoughness"]["baseColorTexture"] = json!({ "index": first_card });
        foliage["normalTexture"] = json!({ "index": first_card + 1, "scale": 1.0 });
    }
    let mut gltf = json!({
        "asset": { "version": "2.0", "generator": "genex gfx.plant" },
        "extensionsUsed": ["KHR_materials_diffuse_transmission"],
        "buffers": [{ "byteLength": 0 }],
        "bufferViews": views,
        "accessors": accessors,
        "materials": [bark, foliage],
        "meshes": [{ "primitives": primitives }],
        "nodes": [{ "mesh": 0 }],
        "scenes": [{ "nodes": [0] }],
        "scene": 0,
    });
    if textured {
        let count = images.len();
        gltf["images"] = json!(images);
        gltf["samplers"] = json!([{ "magFilter": 9729, "minFilter": 9987, "wrapS": 10497, "wrapT": 10497 }]);
        gltf["textures"] = json!((0..count).map(|source| json!({ "sampler": 0, "source": source })).collect::<Vec<_>>());
    }
    while !bin.len().is_multiple_of(4) {
        bin.push(0);
    }
    gltf["buffers"][0]["byteLength"] = json!(bin.len());
    container(&gltf, bin)
}
