//! Streamed meshes, coarse first (game systems STR-19): a model whose asset index entry lists
//! levels of detail loads its coarsest level first, read by range, and draws it until the whole
//! model (level 0 and its chain) is resident.
//!
//! The package step writes each GLB's streaming facts into `assets/genex-asset-index.json` (C-29):
//! the head (GLB header, JSON chunk, BIN chunk header), the vertex data every level reads and each
//! level's triangle-list ranges, coarsest first. The view set reads only the index to plan the
//! coarse read: the head, the vertices and the coarsest level's ranges. [`coarse_stand_in`] then
//! makes a GLB of those bytes alone: the same vertices, each primitive drawing its coarsest
//! `genex_lods` level as its own triangles, with no chain and no images (their bytes were not
//! read), so the stand-in draws exactly the geometry the whole model's coarsest level draws.
//!
//! The stand-in is the whole model's residency parent with `forbid_holes` on: it stays until the
//! whole model arrives, and a cell never draws neither. HLOD proxies (`CellBuild::far`) wait for
//! HLOD v2 (the LOD-22 seam).

use std::ops::Range;

use serde_json::Value;

/// The asset index's file under `assets/` (C-15).
pub(crate) const ASSET_INDEX_FILE: &str = "genex-asset-index.json";
/// The asset index version this build reads.
const ASSET_INDEX_VERSION: u64 = 1;
/// The largest index the view set reads, in bytes.
const ASSET_INDEX_MAX_BYTES: usize = 32 * 1024 * 1024;
/// The most byte ranges one coarse read may take.
pub(crate) const COARSE_RANGES_MAX: usize = 64;
/// The GLB header, a chunk header, and the chunk types.
const GLB_HEADER_BYTES: usize = 12;
const CHUNK_HEADER_BYTES: usize = 8;
const CHUNK_JSON: u32 = 0x4E4F_534A;
const CHUNK_BIN: u32 = 0x004E_4942;
const GLB_MAGIC: &[u8; 4] = b"glTF";
/// glTF's unsigned 32-bit integer component type and its width.
const COMPONENT_U32: u64 = 5125;
const U32_BYTES: u64 = 4;
/// The `genex_lods` extras key and its members (`genex_render::mesh_lod`'s wire spellings).
const LODS_KEY: &str = "genex_lods";
const LODS_INDICES: &str = "indices";
const LODS_LEVELS: &str = "levels";
const LEVEL_FIRST: &str = "first";
const LEVEL_COUNT: &str = "count";

/// What the index says of one model's coarse read: the ranges to read and the bytes it holds.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CoarsePlan {
    /// The head, the vertex data and the coarsest level's triangle lists, in file order.
    pub ranges: Vec<Range<u64>>,
    /// Their bytes together (the stand-in's estimate).
    pub bytes: u64,
    /// The whole file's bytes (the whole model's estimate).
    pub file_bytes: u64,
}

/// The coarse plans of every model the index lists with levels past level 0, by path. A missing,
/// unreadable or foreign index plans nothing: every model then loads whole.
pub(crate) fn coarse_plans(index: &[u8]) -> Vec<(String, CoarsePlan)> {
    if index.len() > ASSET_INDEX_MAX_BYTES {
        return Vec::new();
    }
    let Ok(index) = serde_json::from_slice::<Value>(index) else { return Vec::new() };
    if index.get("version").and_then(Value::as_u64) != Some(ASSET_INDEX_VERSION) {
        return Vec::new();
    }
    let Some(assets) = index.get("assets").and_then(Value::as_array) else { return Vec::new() };
    assets.iter().filter_map(|asset| Some((asset.get("path")?.as_str()?.to_owned(), coarse_plan(asset)?))).collect()
}

/// One index entry's coarse plan, or None when it lists no level past 0 or a range is malformed.
fn coarse_plan(asset: &Value) -> Option<CoarsePlan> {
    let mesh = asset.get("mesh")?;
    let levels = mesh.get("levels")?.as_array()?;
    let coarsest = levels.first()?;
    if levels.len() < 2 || coarsest.get("level")?.as_u64()? == 0 {
        return None;
    }
    let file_bytes = asset.get("files")?.as_array()?.iter().find(|file| file.get("path") == asset.get("path"))?.get("bytes")?.as_u64()?;
    let mut ranges = vec![byte_range(mesh.get("head")?)?];
    for range in mesh.get("vertices")?.as_array()?.iter().chain(coarsest.get("ranges")?.as_array()?) {
        ranges.push(byte_range(range)?);
    }
    let inside = ranges.iter().all(|range| range.end <= file_bytes);
    if !inside || ranges.len() > COARSE_RANGES_MAX {
        return None;
    }
    ranges.sort_by_key(|range| range.start);
    let bytes = ranges.iter().map(|range| range.end - range.start).sum();
    Some(CoarsePlan { ranges, bytes, file_bytes })
}

/// An index `{offset, bytes}` as a range, or None when it is not two whole numbers or overflows.
fn byte_range(value: &Value) -> Option<Range<u64>> {
    let offset = value.get("offset")?.as_u64()?;
    let end = offset.checked_add(value.get("bytes")?.as_u64()?)?;
    Some(offset..end)
}

/// Why a coarse stand-in was not made (the model then waits for its whole read).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StandInRefused(pub String);

/// A GLB of the coarse read `pieces` (file ranges and their bytes) of a `file_bytes`-byte GLB:
/// its vertices, every primitive drawing its coarsest `genex_lods` level as its own triangles (u32
/// indices into the same view), no chain, no images. Refused when the head is not a GLB with a
/// binary chunk, a piece lies outside the file, or a primitive has no `genex_lods` levels.
pub(crate) fn coarse_stand_in(pieces: &[(Range<u64>, &[u8])], file_bytes: u64) -> Result<Vec<u8>, StandInRefused> {
    let mut file = vec![0u8; usize::try_from(file_bytes).map_err(|_| refused("the file is too large"))?];
    for (range, bytes) in pieces {
        let start = usize::try_from(range.start).map_err(|_| refused("a range is too large"))?;
        let target = start.checked_add(bytes.len()).and_then(|end| file.get_mut(start..end)).ok_or_else(|| refused("a range lies past the file"))?;
        target.copy_from_slice(bytes);
    }
    let (mut json, bin) = split_glb(&file)?;
    rewrite_coarse(&mut json)?;
    let text = serde_json::to_vec(&json).map_err(refused)?;
    Ok(glb(&text, bin))
}

fn refused(detail: impl std::fmt::Display) -> StandInRefused {
    StandInRefused(detail.to_string())
}

fn word(bytes: &[u8], at: usize) -> Option<u32> {
    bytes.get(at..at + 4).map(|word| u32::from_le_bytes([word[0], word[1], word[2], word[3]]))
}

/// The JSON and the BIN chunk body of a whole GLB.
fn split_glb(file: &[u8]) -> Result<(Value, &[u8]), StandInRefused> {
    let magic_ok = file.get(..4) == Some(GLB_MAGIC.as_slice());
    let json_len = word(file, GLB_HEADER_BYTES).ok_or_else(|| refused("no JSON chunk"))? as usize;
    if !magic_ok || word(file, GLB_HEADER_BYTES + 4) != Some(CHUNK_JSON) {
        return Err(refused("not a GLB"));
    }
    let json_start = GLB_HEADER_BYTES + CHUNK_HEADER_BYTES;
    let json_end = json_start.checked_add(json_len).ok_or_else(|| refused("the JSON chunk overflows"))?;
    let bin_len = word(file, json_end).ok_or_else(|| refused("no BIN chunk"))? as usize;
    if word(file, json_end + 4) != Some(CHUNK_BIN) {
        return Err(refused("no BIN chunk"));
    }
    let bin_start = json_end + CHUNK_HEADER_BYTES;
    let bin = bin_start.checked_add(bin_len).and_then(|end| file.get(bin_start..end)).ok_or_else(|| refused("the BIN chunk lies past the file"))?;
    let json = file.get(json_start..json_end).and_then(|text| serde_json::from_slice(text).ok()).ok_or_else(|| refused("the JSON chunk does not parse"))?;
    Ok((json, bin))
}

/// Point every primitive's indices at its coarsest `genex_lods` level and drop what the coarse read
/// did not bring: the chains, images, textures and samplers (materials keep their factors).
fn rewrite_coarse(json: &mut Value) -> Result<(), StandInRefused> {
    let mut added: Vec<Value> = Vec::new();
    let first_new = json.get("accessors").and_then(Value::as_array).map_or(0, Vec::len);
    let meshes = json.get_mut("meshes").and_then(Value::as_array_mut).ok_or_else(|| refused("no meshes"))?;
    for primitive in meshes.iter_mut().filter_map(|mesh| mesh.get_mut("primitives")?.as_array_mut()).flatten() {
        let lods = primitive.get("extras").and_then(|extras| extras.get(LODS_KEY)).ok_or_else(|| refused("a primitive has no levels"))?;
        let view = lods.get(LODS_INDICES).and_then(Value::as_u64).ok_or_else(|| refused("a chain names no view"))?;
        let level = lods.get(LODS_LEVELS).and_then(Value::as_array).and_then(|levels| levels.last()).ok_or_else(|| refused("a chain has no level"))?;
        let first = level.get(LEVEL_FIRST).and_then(Value::as_u64).ok_or_else(|| refused("a level has no first"))?;
        let count = level.get(LEVEL_COUNT).and_then(Value::as_u64).ok_or_else(|| refused("a level has no count"))?;
        let offset = first.checked_mul(U32_BYTES).ok_or_else(|| refused("a level's first overflows"))?;
        added.push(serde_json::json!({ "bufferView": view, "byteOffset": offset, "componentType": COMPONENT_U32, "count": count, "type": "SCALAR" }));
        primitive["indices"] = Value::from(first_new + added.len() - 1);
        if let Some(extras) = primitive.get_mut("extras").and_then(Value::as_object_mut) {
            extras.remove(LODS_KEY);
        }
    }
    if added.is_empty() {
        return Err(refused("no primitive"));
    }
    let accessors = json.as_object_mut().ok_or_else(|| refused("the JSON is not an object"))?.entry("accessors").or_insert_with(|| Value::Array(Vec::new()));
    accessors.as_array_mut().ok_or_else(|| refused("accessors is not a list"))?.extend(added);
    strip_images(json);
    Ok(())
}

/// Drop images, textures and samplers, and every material's texture slots.
fn strip_images(json: &mut Value) {
    let Some(root) = json.as_object_mut() else { return };
    for key in ["images", "textures", "samplers"] {
        root.remove(key);
    }
    let Some(materials) = root.get_mut("materials").and_then(Value::as_array_mut) else { return };
    for material in materials.iter_mut().filter_map(Value::as_object_mut) {
        for slot in ["normalTexture", "occlusionTexture", "emissiveTexture"] {
            material.remove(slot);
        }
        if let Some(pbr) = material.get_mut("pbrMetallicRoughness").and_then(Value::as_object_mut) {
            pbr.remove("baseColorTexture");
            pbr.remove("metallicRoughnessTexture");
        }
        material.remove("extensions");
        if let Some(extras) = material.get_mut("extras").and_then(Value::as_object_mut) {
            extras.clear();
        }
    }
    if let Some(extras) = root.get_mut("asset").and_then(|asset| asset.get_mut("extras")).and_then(Value::as_object_mut) {
        extras.remove("genex_textures");
    }
}

/// `json` and `bin` as a GLB (each chunk padded to four bytes).
fn glb(json: &[u8], bin: &[u8]) -> Vec<u8> {
    let mut json = json.to_vec();
    while !json.len().is_multiple_of(4) {
        json.push(b' ');
    }
    let mut bin = bin.to_vec();
    while !bin.len().is_multiple_of(4) {
        bin.push(0);
    }
    let total = GLB_HEADER_BYTES + CHUNK_HEADER_BYTES + json.len() + CHUNK_HEADER_BYTES + bin.len();
    let mut out = Vec::with_capacity(total);
    out.extend(GLB_MAGIC);
    out.extend(2u32.to_le_bytes());
    out.extend((total as u32).to_le_bytes());
    out.extend((json.len() as u32).to_le_bytes());
    out.extend(CHUNK_JSON.to_le_bytes());
    out.extend(&json);
    out.extend((bin.len() as u32).to_le_bytes());
    out.extend(CHUNK_BIN.to_le_bytes());
    out.extend(&bin);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An index entry for a 100-byte file with a head, two vertex views and two levels.
    fn entry(levels: Value) -> Value {
        serde_json::json!({
            "path": "m.glb",
            "files": [{ "path": "m.glb", "bytes": 100 }],
            "mesh": { "head": { "offset": 0, "bytes": 20 }, "vertices": [{ "offset": 20, "bytes": 30 }], "levels": levels },
        })
    }

    fn index(assets: Value) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({ "version": 1, "assets": assets })).expect("json")
    }

    #[test]
    fn the_coarse_plan_reads_the_head_the_vertices_and_the_coarsest_level() {
        let levels = serde_json::json!([
            { "level": 1, "ranges": [{ "offset": 90, "bytes": 6 }] },
            { "level": 0, "ranges": [{ "offset": 50, "bytes": 40 }] },
        ]);
        let plans = coarse_plans(&index(serde_json::json!([entry(levels)])));
        assert_eq!(plans, [("m.glb".to_owned(), CoarsePlan { ranges: vec![0..20, 20..50, 90..96], bytes: 56, file_bytes: 100 })]);
    }

    #[test]
    fn hostile_or_foreign_indexes_plan_nothing() {
        let level0_only = serde_json::json!([{ "level": 0, "ranges": [{ "offset": 50, "bytes": 40 }] }]);
        let past_end = serde_json::json!([
            { "level": 1, "ranges": [{ "offset": 99, "bytes": 6 }] },
            { "level": 0, "ranges": [{ "offset": 50, "bytes": 40 }] },
        ]);
        let overflow = serde_json::json!([
            { "level": 1, "ranges": [{ "offset": u64::MAX, "bytes": 6 }] },
            { "level": 0, "ranges": [{ "offset": 50, "bytes": 40 }] },
        ]);
        let negative = serde_json::json!([
            { "level": 1, "ranges": [{ "offset": -4, "bytes": 6 }] },
            { "level": 0, "ranges": [{ "offset": 50, "bytes": 40 }] },
        ]);
        for levels in [level0_only, past_end, overflow, negative] {
            assert!(coarse_plans(&index(serde_json::json!([entry(levels.clone())]))).is_empty(), "{levels}");
        }
        assert!(coarse_plans(b"{ not json").is_empty());
        assert!(coarse_plans(br#"{"version": 2, "assets": []}"#).is_empty(), "another version");
        assert!(coarse_plans(&vec![b' '; ASSET_INDEX_MAX_BYTES + 1]).is_empty(), "over the cap");
    }

    #[test]
    fn a_stand_in_of_a_piece_past_the_file_or_a_non_glb_is_refused() {
        assert!(coarse_stand_in(&[(90..110, &[0u8; 20][..])], 100).is_err());
        assert!(coarse_stand_in(&[(0..20, &[7u8; 20][..])], 100).is_err());
    }
}
