//! GLB files written with std and serde_json only, for the GLB guard's rows: a valid triangle and
//! the hostile shapes the guard refuses. genex-render's and the facade's guard rows include this
//! file by `#[path]`, so none of them needs a dev-dependency on another crate.

#![allow(dead_code)]

use serde_json::{Value, json};

/// A glTF document and the bytes of its BIN chunk.
pub struct Glb {
    /// The JSON chunk.
    pub json: Value,
    /// The BIN chunk before padding.
    pub bin: Vec<u8>,
}

/// The little-endian bytes of `values`.
fn floats(values: &[f32]) -> Vec<u8> {
    values.iter().flat_map(|value| value.to_le_bytes()).collect()
}

/// One triangle: POSITION (3 float VEC3, view 0) and u16 indices (view 1), one mesh, one node,
/// one scene. Every hostile row edits this document.
pub fn triangle() -> Glb {
    let mut bin = floats(&[0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0]);
    bin.extend([0u16, 1, 2].iter().flat_map(|index| index.to_le_bytes()));
    bin.extend([0, 0]);
    let json = json!({
        "asset": {"version": "2.0"},
        "buffers": [{"byteLength": 44}],
        "bufferViews": [
            {"buffer": 0, "byteOffset": 0, "byteLength": 36},
            {"buffer": 0, "byteOffset": 36, "byteLength": 6}
        ],
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": 3, "type": "VEC3", "min": [0.0, 0.0, 0.0], "max": [1.0, 1.0, 0.0]},
            {"bufferView": 1, "componentType": 5123, "count": 3, "type": "SCALAR"}
        ],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0}, "indices": 1}]}],
        "nodes": [{"mesh": 0}],
        "scenes": [{"nodes": [0]}],
        "scene": 0
    });
    Glb { json, bin }
}

impl Glb {
    /// The GLB container: header, the JSON chunk padded with spaces, the BIN chunk padded with
    /// zeros, every length consistent.
    pub fn bytes(&self) -> Vec<u8> {
        container(serde_json::to_vec(&self.json).expect("JSON writes"), &self.bin)
    }

    /// Set the value at a JSON pointer (`/accessors/0/count`); a missing last member is added.
    pub fn set(mut self, pointer: &str, value: Value) -> Glb {
        if let Some(slot) = self.json.pointer_mut(pointer) {
            *slot = value;
            return self;
        }
        let (parent, key) = pointer.rsplit_once('/').expect("a member pointer");
        let parent = self.json.pointer_mut(parent).and_then(Value::as_object_mut).unwrap_or_else(|| panic!("{pointer}'s parent is an object"));
        parent.insert(key.to_owned(), value);
        self
    }

    /// Remove the member at a JSON pointer.
    pub fn remove(mut self, pointer: &str) -> Glb {
        let (parent, key) = pointer.rsplit_once('/').expect("a member pointer");
        self.json.pointer_mut(parent).and_then(Value::as_object_mut).expect("an object parent").remove(key);
        self
    }
}

/// A GLB container around `json` and `bin`, padded and sized as the spec writes it.
pub fn container(mut json: Vec<u8>, bin: &[u8]) -> Vec<u8> {
    while !json.len().is_multiple_of(4) {
        json.push(b' ');
    }
    let mut padded = bin.to_vec();
    while !padded.len().is_multiple_of(4) {
        padded.push(0);
    }
    let bin_chunk = if padded.is_empty() { 0 } else { 8 + padded.len() };
    let total = 12 + 8 + json.len() + bin_chunk;
    let mut out = Vec::with_capacity(total);
    out.extend(b"glTF");
    out.extend(2u32.to_le_bytes());
    out.extend((total as u32).to_le_bytes());
    out.extend((json.len() as u32).to_le_bytes());
    out.extend(b"JSON");
    out.extend(json);
    if !padded.is_empty() {
        out.extend((padded.len() as u32).to_le_bytes());
        out.extend(b"BIN\0");
        out.extend(padded);
    }
    out
}

/// The JSON and BIN chunks of a GLB this module (or any spec writer) wrote; `None` when the
/// container is not one.
pub fn split(bytes: &[u8]) -> Option<(Value, Vec<u8>)> {
    let word = |at: usize| bytes.get(at..at + 4).map(|w| u32::from_le_bytes(w.try_into().unwrap()) as usize);
    let json_length = word(12)?;
    let json = serde_json::from_slice(bytes.get(20..20 + json_length)?).ok()?;
    let at = 20 + json_length;
    let bin = match word(at) {
        Some(length) => bytes.get(at + 8..at + 8 + length)?.to_vec(),
        None => Vec::new(),
    };
    Some((json, bin))
}

/// The hostile table: a name and the GLB bytes. Each is refused by the guard with no panic.
pub fn hostile() -> Vec<(&'static str, Vec<u8>)> {
    let valid = triangle().bytes();
    let mut truncated_bin = valid.clone();
    truncated_bin.truncate(valid.len() - 8);
    let mut header_four = valid.clone();
    header_four[8..12].copy_from_slice(&4u32.to_le_bytes());
    let mut cycle = triangle().set("/nodes", json!([{"mesh": 0, "children": [1]}, {"children": [0]}]));
    cycle.json["scenes"][0]["nodes"] = json!([0]);
    vec![
        ("the #478 shape: POSITION names accessor 99", triangle().set("/meshes/0/primitives/0/attributes/POSITION", json!(99)).bytes()),
        ("a truncated BIN chunk", truncated_bin),
        ("a buffer longer than the BIN chunk", triangle().set("/buffers/0/byteLength", json!(4096)).bytes()),
        ("a buffer view past the buffer", triangle().set("/bufferViews/0/byteLength", json!(400)).bytes()),
        ("a buffer view offset that overflows", triangle().set("/bufferViews/0/byteOffset", json!(u64::MAX)).bytes()),
        ("a 2^31 count", triangle().set("/accessors/0/count", json!(1u64 << 31)).bytes()),
        ("a 2^62 count (overflows the reader's end)", triangle().set("/accessors/0/count", json!(1u64 << 62)).bytes()),
        ("a count of 0", triangle().set("/accessors/0/count", json!(0)).bytes()),
        ("a stride shorter than the element", triangle().set("/bufferViews/0/byteStride", json!(4)).bytes()),
        ("an index past the vertices", {
            let mut glb = triangle();
            glb.bin[40..42].copy_from_slice(&7u16.to_le_bytes());
            glb.bytes()
        }),
        ("float indices", {
            let glb = triangle().set("/accessors/1/componentType", json!(5126)).set("/accessors/1/count", json!(2));
            glb.set("/bufferViews/1/byteLength", json!(8)).bytes()
        }),
        ("a header length of 4", header_four),
        ("a node that is its own ancestor", cycle.bytes()),
        ("a node listed twice as a child", triangle().set("/nodes", json!([{"children": [1, 1]}, {"mesh": 0}])).bytes()),
        ("an accessor naming buffer view 9", triangle().set("/accessors/0/bufferView", json!(9)).bytes()),
        ("a buffer view naming buffer 3", triangle().set("/bufferViews/0/buffer", json!(3)).bytes()),
        ("a skin whose joint is node 50", triangle().bytes_with("skins", json!([{"joints": [50]}]))),
        ("an animation sampler naming accessor 40", {
            let animation = json!([{"samplers": [{"input": 40, "output": 0}], "channels": [{"sampler": 0, "target": {"node": 0, "path": "translation"}}]}]);
            triangle().bytes_with("animations", animation)
        }),
        ("not a GLB and not JSON", b"PK\x03\x04 an archive, not a model".to_vec()),
        ("empty", Vec::new()),
    ]
}

impl Glb {
    /// [`Glb::bytes`] with one more top-level member.
    pub fn bytes_with(mut self, key: &str, value: Value) -> Vec<u8> {
        self.json.as_object_mut().expect("an object document").insert(key.to_owned(), value);
        self.bytes()
    }
}
