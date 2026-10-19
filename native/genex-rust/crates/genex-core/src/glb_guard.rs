//! The GLB guard: checks a glTF file's bytes before the `gltf` crate parses them.
//!
//! `gltf` 1.4.1 (the newest release, 2024-05-10) panics on damaged input: a primitive naming an
//! accessor that does not exist panics inside its validation (gltf-rs #478), and its reader's
//! arithmetic overflows, underflows or asserts on a count of 0, a huge count or offset and a
//! stride shorter than the element. Its GLB header read underflows on a length under 12, and a
//! renderer walking a node cycle overflows the stack. A panic aborts on wasm, and a stack overflow
//! aborts everywhere, so every runtime read of a GLB (genex-render's loaders, the facade's
//! `Assets::triangles`, genex-anim's rig import) runs [`check_glb`] first.
//!
//! The guard reads the container and the JSON chunk only (with serde_json, which never panics),
//! plus each primitive's index data. It checks:
//! - the container: magic, version 2, a header length the file holds, a JSON chunk first and at
//!   most a BIN chunk after it, each inside the file;
//! - references: every index the readers follow (buffers, buffer views, accessors, materials,
//!   meshes, nodes, skins, cameras, scenes, images, animation samplers) names an entry that exists;
//! - ranges: a buffer stored in the GLB fits the BIN chunk, a view fits its buffer, an accessor's
//!   elements (and its sparse indices and values) fit their view, counts are at least 1 and a
//!   primitive's attributes all have POSITION's count, all in checked 64-bit arithmetic;
//! - layouts: a component type and element type glTF defines, a stride glTF allows and no shorter
//!   than the element, and for each attribute, index and animation accessor a layout the `gltf`
//!   reader has an arm for (`KHR_mesh_quantization` widens POSITION, NORMAL and TANGENT: the
//!   renderer refuses those layouts itself before reading);
//! - indices: each index a primitive stores plainly in the GLB is below its vertex count;
//! - the node tree: each node has at most one parent, no cycle, at most [`GLB_MAX_NODE_DEPTH`]
//!   levels.
//!
//! Nothing it refuses is allocated: its own work is the JSON parse (bounded by the file) and a
//! parent table per node. A `.gltf` text document is checked as JSON with no BIN chunk; a buffer
//! with a `uri` bounds its views by its declared length, and the caller that resolves the URI
//! checks the data is that long.

use serde_json::{Map, Value};

/// The deepest node chain a file may have: a renderer walks the tree recursively, and a deeper
/// chain could overflow a wasm or worker stack.
pub const GLB_MAX_NODE_DEPTH: usize = 1024;
/// How many times the file's own size an accessor with no buffer view (zeros, or a sparse
/// accessor over zeros) may expand to when read.
pub const GLB_VIEWLESS_EXPANSION: u64 = 64;

/// GLB header: magic, version, total length.
const GLB_HEADER_BYTES: usize = 12;
/// A chunk header: length, type.
const CHUNK_HEADER_BYTES: usize = 8;
/// The only GLB version glTF 2.0 writes.
const GLB_VERSION: u32 = 2;
/// The smallest and largest byte stride glTF allows.
const STRIDE_RANGE: std::ops::RangeInclusive<u64> = 4..=252;
/// The glTF component types.
const I8: u64 = 5120;
const U8: u64 = 5121;
const I16: u64 = 5122;
const U16: u64 = 5123;
const U32: u64 = 5125;
const F32: u64 = 5126;
/// The extension that lets POSITION, NORMAL and TANGENT be integers.
const MESH_QUANTIZATION: &str = "KHR_mesh_quantization";

/// Why the guard refused a file.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum GlbFault {
    /// The GLB header or chunks are not a container the file holds.
    Container,
    /// The JSON chunk is not a JSON object of the glTF shape.
    Json,
    /// An index names an entry that does not exist.
    Reference,
    /// A length, offset or count runs past what holds it, or a count is 0 or disagrees.
    Range,
    /// A component type, element type or stride glTF or its reader does not allow there.
    Layout,
    /// A primitive's index is not below its vertex count.
    Index,
    /// A node has two parents, is its own ancestor, or the tree is too deep.
    Tree,
}

impl GlbFault {
    /// Every fault, in declaration order.
    pub const ALL: [GlbFault; 7] = [GlbFault::Container, GlbFault::Json, GlbFault::Reference, GlbFault::Range, GlbFault::Layout, GlbFault::Index, GlbFault::Tree];

    /// The wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            GlbFault::Container => "glb-container",
            GlbFault::Json => "glb-json",
            GlbFault::Reference => "glb-reference",
            GlbFault::Range => "glb-range",
            GlbFault::Layout => "glb-layout",
            GlbFault::Index => "glb-index",
            GlbFault::Tree => "glb-tree",
        }
    }
}

/// A file the guard refused: the fault and a detail for a log line.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GlbRefusal {
    fault: GlbFault,
    detail: String,
}

impl GlbRefusal {
    fn new(fault: GlbFault, detail: impl Into<String>) -> GlbRefusal {
        GlbRefusal { fault, detail: detail.into() }
    }

    /// Why.
    pub fn fault(&self) -> GlbFault {
        self.fault
    }

    /// What, for a log line.
    pub fn detail(&self) -> &str {
        &self.detail
    }
}

impl std::fmt::Display for GlbRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.fault.wire(), self.detail)
    }
}

impl std::error::Error for GlbRefusal {}

type Checked<T> = Result<T, GlbRefusal>;

fn refuse<T>(fault: GlbFault, detail: impl Into<String>) -> Checked<T> {
    Err(GlbRefusal::new(fault, detail))
}

/// Checks a GLB (or `.gltf` text) before the `gltf` crate parses it; see the module docs.
pub fn check_glb(bytes: &[u8]) -> Result<(), GlbRefusal> {
    let (json, bin) = split(bytes)?;
    let root: Value = serde_json::from_slice(json).map_err(|error| GlbRefusal::new(GlbFault::Json, format!("the JSON chunk does not parse: {error}")))?;
    let Value::Object(root) = root else { return refuse(GlbFault::Json, "the JSON chunk is not an object") };
    let doc = Doc::read(&root, bin, bytes.len() as u64)?;
    doc.check_meshes()?;
    doc.check_nodes()?;
    doc.check_skins()?;
    doc.check_animations()?;
    doc.check_images()
}

fn u32_at(bytes: &[u8], at: usize) -> Option<usize> {
    let word: [u8; 4] = bytes.get(at..at.checked_add(4)?)?.try_into().ok()?;
    Some(u32::from_le_bytes(word) as usize)
}

/// The JSON chunk and the BIN chunk, as `gltf`'s GLB reader splits them (it reads to the end of
/// the file, past a shorter header length). Text that is not a GLB is all JSON with no BIN.
fn split(bytes: &[u8]) -> Checked<(&[u8], Option<&[u8]>)> {
    if !bytes.starts_with(b"glTF") {
        return Ok((bytes, None));
    }
    let container = |what: &str| refuse(GlbFault::Container, format!("not a GLB container: {what}"));
    if u32_at(bytes, 4) != Some(GLB_VERSION as usize) {
        return container("not version 2");
    }
    let declared = u32_at(bytes, 8).unwrap_or(0);
    if !(GLB_HEADER_BYTES..=bytes.len()).contains(&declared) {
        return container("the header length is not inside the file");
    }
    let data = &bytes[GLB_HEADER_BYTES..];
    let Some((json, rest)) = chunk(data, b"JSON") else { return container("the first chunk is not a JSON chunk inside the file") };
    if rest.is_empty() {
        return Ok((json, None));
    }
    match chunk(rest, b"BIN\0") {
        Some((bin, _)) => Ok((json, Some(bin))),
        None => container("the chunk after JSON is not a BIN chunk inside the file"),
    }
}

/// The chunk of type `kind` at the start of `data` and what follows it, when it fits.
fn chunk<'a>(data: &'a [u8], kind: &[u8; 4]) -> Option<(&'a [u8], &'a [u8])> {
    let length = u32_at(data, 0)?;
    if data.get(4..CHUNK_HEADER_BYTES)? != kind {
        return None;
    }
    let body = data.get(CHUNK_HEADER_BYTES..)?;
    (length <= body.len()).then(|| body.split_at(length))
}

/// An accessor's element types and their component counts.
fn components(kind: &str) -> Option<u64> {
    Some(match kind {
        "SCALAR" => 1,
        "VEC2" => 2,
        "VEC3" => 3,
        "VEC4" | "MAT2" => 4,
        "MAT3" => 9,
        "MAT4" => 16,
        _ => return None,
    })
}

fn component_bytes(component: u64) -> Option<u64> {
    match component {
        I8 | U8 => Some(1),
        I16 | U16 => Some(2),
        U32 | F32 => Some(4),
        _ => None,
    }
}

/// One element's bytes, with the column padding glTF gives 1- and 2-byte matrices.
fn element_bytes(component: u64, kind: &str) -> Option<u64> {
    let size = component_bytes(component)?;
    let padded_column = |rows: u64| (rows * size).next_multiple_of(4);
    Some(match (kind, size) {
        ("MAT2", 1) => 2 * padded_column(2),
        ("MAT3", 1 | 2) => 3 * padded_column(3),
        _ => components(kind)? * size,
    })
}

/// A buffer view as the readers slice it.
#[derive(Clone, Copy)]
struct View {
    buffer: usize,
    offset: u64,
    length: u64,
    stride: Option<u64>,
}

/// An accessor's facts the later checks need.
#[derive(Clone)]
struct Accessor {
    component: u64,
    kind: String,
    count: u64,
    view: Option<usize>,
    offset: u64,
    plain: bool,
}

impl Accessor {
    fn is(&self, components: &[u64], kinds: &[&str]) -> bool {
        components.contains(&self.component) && kinds.contains(&self.kind.as_str())
    }
}

/// The document's tables after the buffer, view and accessor checks.
struct Doc<'a> {
    root: &'a Map<String, Value>,
    bin: Option<&'a [u8]>,
    embedded: Vec<bool>,
    views: Vec<View>,
    accessors: Vec<Accessor>,
    quantized: bool,
}

/// The objects of the top-level array `key` (none when absent).
fn list<'a>(root: &'a Map<String, Value>, key: &str) -> Checked<Vec<&'a Map<String, Value>>> {
    match root.get(key) {
        None => Ok(Vec::new()),
        Some(Value::Array(items)) => items.iter().enumerate().map(|(n, item)| object(item, &format!("{key}[{n}]"))).collect(),
        Some(_) => refuse(GlbFault::Json, format!("{key} is not an array")),
    }
}

fn object<'a>(value: &'a Value, what: &str) -> Checked<&'a Map<String, Value>> {
    value.as_object().ok_or_else(|| GlbRefusal::new(GlbFault::Json, format!("{what} is not an object")))
}

/// The unsigned integer `key` of `object`, `None` when absent.
fn uint(object: &Map<String, Value>, key: &str, what: &str) -> Checked<Option<u64>> {
    match object.get(key) {
        None => Ok(None),
        Some(value) => value.as_u64().map(Some).ok_or_else(|| GlbRefusal::new(GlbFault::Json, format!("{what}.{key} is not an unsigned integer"))),
    }
}

/// The index `key` of `object`, checked against a table of `length` entries.
fn index(object: &Map<String, Value>, key: &str, length: usize, what: &str) -> Checked<Option<usize>> {
    let Some(value) = uint(object, key, what)? else { return Ok(None) };
    reference(value, length, &format!("{what}.{key}")).map(Some)
}

fn reference(value: u64, length: usize, what: &str) -> Checked<usize> {
    match usize::try_from(value) {
        Ok(at) if at < length => Ok(at),
        _ => refuse(GlbFault::Reference, format!("{what} names {value} of {length}")),
    }
}

/// `offset + stride * (count - 1) + element`, the last byte a reader touches, or `None` on overflow.
fn span(offset: u64, stride: u64, count: u64, element: u64) -> Option<u64> {
    stride.checked_mul(count.checked_sub(1)?)?.checked_add(element)?.checked_add(offset)
}

impl<'a> Doc<'a> {
    fn read(root: &'a Map<String, Value>, bin: Option<&'a [u8]>, file: u64) -> Checked<Doc<'a>> {
        let quantized = root.get("extensionsUsed").and_then(Value::as_array).is_some_and(|used| used.iter().any(|name| name == MESH_QUANTIZATION));
        let mut doc = Doc { root, bin, embedded: Vec::new(), views: Vec::new(), accessors: Vec::new(), quantized };
        let lengths = doc.read_buffers()?;
        doc.read_views(&lengths)?;
        doc.read_accessors(file)?;
        Ok(doc)
    }

    /// Each buffer's declared length; one stored in the GLB must fit the BIN chunk.
    fn read_buffers(&mut self) -> Checked<Vec<u64>> {
        let bin = self.bin.map_or(0, <[u8]>::len) as u64;
        let mut lengths = Vec::new();
        for (n, buffer) in list(self.root, "buffers")?.into_iter().enumerate() {
            let what = format!("buffers[{n}]");
            let length = uint(buffer, "byteLength", &what)?.ok_or_else(|| GlbRefusal::new(GlbFault::Json, format!("{what} has no byteLength")))?;
            let embedded = !buffer.contains_key("uri");
            if embedded && length > bin {
                return refuse(GlbFault::Range, format!("{what} declares {length} bytes, the BIN chunk holds {bin}"));
            }
            self.embedded.push(embedded);
            lengths.push(length);
        }
        Ok(lengths)
    }

    fn read_views(&mut self, lengths: &[u64]) -> Checked<()> {
        for (n, view) in list(self.root, "bufferViews")?.into_iter().enumerate() {
            let what = format!("bufferViews[{n}]");
            let buffer = index(view, "buffer", lengths.len(), &what)?.ok_or_else(|| GlbRefusal::new(GlbFault::Json, format!("{what} has no buffer")))?;
            let offset = uint(view, "byteOffset", &what)?.unwrap_or(0);
            let length = uint(view, "byteLength", &what)?.ok_or_else(|| GlbRefusal::new(GlbFault::Json, format!("{what} has no byteLength")))?;
            if offset.checked_add(length).is_none_or(|end| end > lengths[buffer]) {
                return refuse(GlbFault::Range, format!("{what} ({offset} + {length}) runs past buffer {buffer}'s {} bytes", lengths[buffer]));
            }
            let stride = uint(view, "byteStride", &what)?;
            if stride.is_some_and(|stride| !STRIDE_RANGE.contains(&stride) || !stride.is_multiple_of(4)) {
                return refuse(GlbFault::Layout, format!("{what}.byteStride {stride:?} is not a multiple of 4 from 4 to 252"));
            }
            self.views.push(View { buffer, offset, length, stride });
        }
        Ok(())
    }

    fn read_accessors(&mut self, file: u64) -> Checked<()> {
        for (n, accessor) in list(self.root, "accessors")?.into_iter().enumerate() {
            let what = format!("accessors[{n}]");
            let read = self.read_accessor(accessor, &what, file)?;
            self.accessors.push(read);
        }
        Ok(())
    }

    fn read_accessor(&self, accessor: &Map<String, Value>, what: &str, file: u64) -> Checked<Accessor> {
        let component = uint(accessor, "componentType", what)?.unwrap_or(0);
        let kind = accessor.get("type").and_then(Value::as_str).unwrap_or_default().to_owned();
        let Some(element) = element_bytes(component, &kind) else {
            return refuse(GlbFault::Layout, format!("{what} is componentType {component} {kind:?}: not a layout glTF defines"));
        };
        let count = uint(accessor, "count", what)?.unwrap_or(0);
        if count == 0 {
            return refuse(GlbFault::Range, format!("{what} has a count of 0"));
        }
        let view = index(accessor, "bufferView", self.views.len(), what)?;
        let offset = uint(accessor, "byteOffset", what)?.unwrap_or(0);
        match view {
            Some(at) => self.check_elements(at, offset, count, element, what)?,
            None if count.checked_mul(element).is_none_or(|bytes| bytes > file.saturating_mul(GLB_VIEWLESS_EXPANSION)) => {
                return refuse(GlbFault::Range, format!("{what} has no buffer view and expands {count} elements of {element} bytes"));
            }
            None => {}
        }
        let sparse = match accessor.get("sparse") {
            Some(sparse) => {
                self.check_sparse(object(sparse, &format!("{what}.sparse"))?, count, element, what)?;
                true
            }
            None => false,
        };
        Ok(Accessor { component, kind, count, view, offset, plain: view.is_some() && !sparse })
    }

    /// `count` elements of `element` bytes from `offset` in view `at`, at its stride, fit the view.
    fn check_elements(&self, at: usize, offset: u64, count: u64, element: u64, what: &str) -> Checked<()> {
        let view = self.views[at];
        let stride = view.stride.unwrap_or(element);
        if stride < element {
            return refuse(GlbFault::Layout, format!("{what}: a {stride}-byte stride is shorter than its {element}-byte element"));
        }
        if span(offset, stride, count, element).is_none_or(|end| end > view.length) {
            return refuse(GlbFault::Range, format!("{what}: {count} elements of {element} bytes every {stride} from {offset} run past its {}-byte view", view.length));
        }
        Ok(())
    }

    fn check_sparse(&self, sparse: &Map<String, Value>, count: u64, element: u64, what: &str) -> Checked<()> {
        let what = format!("{what}.sparse");
        let entries = uint(sparse, "count", &what)?.unwrap_or(0);
        if entries == 0 || entries > count {
            return refuse(GlbFault::Range, format!("{what} has {entries} entries for {count} elements"));
        }
        let indices = object(sparse.get("indices").unwrap_or(&Value::Null), &format!("{what}.indices"))?;
        let values = object(sparse.get("values").unwrap_or(&Value::Null), &format!("{what}.values"))?;
        let component = uint(indices, "componentType", &what)?.unwrap_or(0);
        if ![U8, U16, U32].contains(&component) {
            return refuse(GlbFault::Layout, format!("{what}.indices are componentType {component}"));
        }
        for (part, size) in [(indices, component_bytes(component).unwrap_or(4)), (values, element)] {
            let at = index(part, "bufferView", self.views.len(), &what)?.ok_or_else(|| GlbRefusal::new(GlbFault::Json, format!("{what} has a part with no bufferView")))?;
            let offset = uint(part, "byteOffset", &what)?.unwrap_or(0);
            self.check_elements(at, offset, entries, size, &what)?;
        }
        Ok(())
    }

    fn accessor(&self, value: &Value, what: &str) -> Checked<&Accessor> {
        let raw = value.as_u64().ok_or_else(|| GlbRefusal::new(GlbFault::Json, format!("{what} is not an accessor index")))?;
        reference(raw, self.accessors.len(), what).map(|at| &self.accessors[at])
    }

    fn check_meshes(&self) -> Checked<()> {
        let materials = list(self.root, "materials")?.len();
        for (m, mesh) in list(self.root, "meshes")?.into_iter().enumerate() {
            let primitives = mesh.get("primitives").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
            for (p, primitive) in primitives.iter().enumerate() {
                let what = format!("meshes[{m}].primitives[{p}]");
                let primitive = object(primitive, &what)?;
                index(primitive, "material", materials, &what)?;
                self.check_primitive(primitive, &what)?;
            }
        }
        Ok(())
    }

    fn check_primitive(&self, primitive: &Map<String, Value>, what: &str) -> Checked<()> {
        let attributes = object(primitive.get("attributes").unwrap_or(&Value::Null), &format!("{what}.attributes"))?;
        let vertices = match attributes.get("POSITION") {
            Some(position) => Some(self.accessor(position, &format!("{what}.attributes.POSITION"))?.count),
            None => None,
        };
        for (semantic, value) in attributes {
            let where_ = format!("{what}.attributes.{semantic}");
            let accessor = self.accessor(value, &where_)?;
            self.check_attribute(semantic, accessor, &where_)?;
            if vertices.is_some_and(|vertices| vertices != accessor.count) {
                return refuse(GlbFault::Range, format!("{where_} has {} elements, POSITION has {vertices:?}", accessor.count));
            }
        }
        self.check_targets(primitive, vertices, what)?;
        match (primitive.get("indices"), vertices) {
            (Some(indices), Some(vertices)) => self.check_indices(self.accessor(indices, &format!("{what}.indices"))?, vertices, what),
            (Some(indices), None) => self.accessor(indices, &format!("{what}.indices")).map(drop),
            (None, _) => Ok(()),
        }
    }

    /// The layouts the `gltf` reader has an arm for, per attribute.
    fn check_attribute(&self, semantic: &str, accessor: &Accessor, what: &str) -> Checked<()> {
        let quantized_ok = |kinds: &[&str]| self.quantized && accessor.is(&[I8, U8, I16, U16, F32], kinds);
        let fits = match semantic.split_once('_').map_or(semantic, |(name, _)| name) {
            "POSITION" | "NORMAL" => accessor.is(&[F32], &["VEC3"]) || quantized_ok(&["VEC3"]),
            "TANGENT" => accessor.is(&[F32], &["VEC4"]) || quantized_ok(&["VEC4"]),
            "TEXCOORD" => accessor.is(&[U8, U16, F32], &["VEC2"]),
            "COLOR" => accessor.is(&[U8, U16, F32], &["VEC3", "VEC4"]),
            "JOINTS" => accessor.is(&[U8, U16], &["VEC4"]),
            "WEIGHTS" => accessor.is(&[U8, U16, F32], &["VEC4"]),
            _ => true,
        };
        if fits {
            return Ok(());
        }
        refuse(GlbFault::Layout, format!("{what} is componentType {} {}: not a layout the reader reads", accessor.component, accessor.kind))
    }

    fn check_targets(&self, primitive: &Map<String, Value>, vertices: Option<u64>, what: &str) -> Checked<()> {
        let targets = primitive.get("targets").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
        for (t, target) in targets.iter().enumerate() {
            let where_ = format!("{what}.targets[{t}]");
            for (semantic, value) in object(target, &where_)? {
                let accessor = self.accessor(value, &format!("{where_}.{semantic}"))?;
                let float_vec3 = accessor.is(&[F32], &["VEC3"]) || self.quantized;
                if !float_vec3 {
                    return refuse(GlbFault::Layout, format!("{where_}.{semantic} is not float VEC3"));
                }
                if vertices.is_some_and(|vertices| vertices != accessor.count) {
                    return refuse(GlbFault::Range, format!("{where_}.{semantic} has {} elements, POSITION has {vertices:?}", accessor.count));
                }
            }
        }
        Ok(())
    }

    /// Indices are unsigned scalars; those stored plainly in an embedded buffer are each below `vertices`.
    fn check_indices(&self, indices: &Accessor, vertices: u64, what: &str) -> Checked<()> {
        if !indices.is(&[U8, U16, U32], &["SCALAR"]) {
            return refuse(GlbFault::Layout, format!("{what}.indices are componentType {} {}: not unsigned scalars", indices.component, indices.kind));
        }
        // Sparse indices and indices with no view (`KHR_draco_mesh_compression` keeps them in its
        // own buffer) are not scanned here: the reader yields nothing or zeros for the latter, and
        // the loaders check each index they read against the vertex count.
        let Some(at) = indices.view.filter(|_| indices.plain) else { return Ok(()) };
        let view = self.views[at];
        let Some(bin) = self.bin.filter(|_| self.embedded[view.buffer]) else { return Ok(()) };
        let size = component_bytes(indices.component).unwrap_or(4) as usize;
        let stride = view.stride.map_or(size, |stride| stride as usize);
        let start = (view.offset + indices.offset) as usize;
        let end = span(0, stride as u64, indices.count, size as u64).map(|bytes| start + bytes as usize);
        let Some(data) = end.and_then(|end| bin.get(start..end)) else {
            return refuse(GlbFault::Range, format!("{what}.indices run past the BIN chunk"));
        };
        // One pass for the largest index (a loop the compiler vectorizes); the slow walk for the
        // first offender runs only on a refusal.
        let largest = match (size, stride == size) {
            (2, true) => u64::from(data.as_chunks::<2>().0.iter().map(|word| u16::from_le_bytes(*word)).fold(0, u16::max)),
            (4, true) => u64::from(data.as_chunks::<4>().0.iter().map(|word| u32::from_le_bytes(*word)).fold(0, u32::max)),
            _ => data.chunks(stride).map(|element| index_value(&element[..size])).max().unwrap_or(0),
        };
        if largest < vertices {
            return Ok(());
        }
        let first = data.chunks(stride).position(|element| index_value(&element[..size]) >= vertices).unwrap_or(0);
        refuse(GlbFault::Index, format!("{what}.indices[{first}] is past its {vertices} vertices"))
    }

    /// Node references in range, one parent each, no cycle, at most [`GLB_MAX_NODE_DEPTH`] deep.
    fn check_nodes(&self) -> Checked<()> {
        let nodes = list(self.root, "nodes")?;
        let tables = [("mesh", list(self.root, "meshes")?.len()), ("skin", list(self.root, "skins")?.len()), ("camera", list(self.root, "cameras")?.len())];
        let mut parents: Vec<Option<usize>> = vec![None; nodes.len()];
        for (n, node) in nodes.iter().enumerate() {
            let what = format!("nodes[{n}]");
            for (key, length) in tables {
                index(node, key, length, &what)?;
            }
            for child in node.get("children").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default() {
                let raw = child.as_u64().ok_or_else(|| GlbRefusal::new(GlbFault::Json, format!("{what}.children holds a non-index")))?;
                let child = reference(raw, nodes.len(), &format!("{what}.children"))?;
                if parents[child].is_some() || child == n {
                    return refuse(GlbFault::Tree, format!("node {child} has two parents"));
                }
                parents[child] = Some(n);
            }
        }
        check_depths(&parents)?;
        let scenes = list(self.root, "scenes")?;
        for (s, scene) in scenes.iter().enumerate() {
            for node in scene.get("nodes").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default() {
                reference(node.as_u64().unwrap_or(u64::MAX), nodes.len(), &format!("scenes[{s}].nodes"))?;
            }
        }
        index(self.root, "scene", scenes.len(), "the document").map(drop)
    }

    fn check_skins(&self) -> Checked<()> {
        let nodes = list(self.root, "nodes")?.len();
        for (s, skin) in list(self.root, "skins")?.into_iter().enumerate() {
            let what = format!("skins[{s}]");
            let joints = skin.get("joints").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
            for joint in joints {
                reference(joint.as_u64().unwrap_or(u64::MAX), nodes, &format!("{what}.joints"))?;
            }
            index(skin, "skeleton", nodes, &what)?;
            let Some(matrices) = skin.get("inverseBindMatrices") else { continue };
            let matrices = self.accessor(matrices, &format!("{what}.inverseBindMatrices"))?;
            if !matrices.is(&[F32], &["MAT4"]) || matrices.count < joints.len() as u64 {
                return refuse(GlbFault::Layout, format!("{what}.inverseBindMatrices are not a float MAT4 per joint"));
            }
        }
        Ok(())
    }

    fn check_animations(&self) -> Checked<()> {
        let nodes = list(self.root, "nodes")?.len();
        for (a, animation) in list(self.root, "animations")?.into_iter().enumerate() {
            let what = format!("animations[{a}]");
            let samplers = animation.get("samplers").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
            let mut outputs = Vec::with_capacity(samplers.len());
            for (s, sampler) in samplers.iter().enumerate() {
                let where_ = format!("{what}.samplers[{s}]");
                let sampler = object(sampler, &where_)?;
                let input = self.accessor(sampler.get("input").unwrap_or(&Value::Null), &format!("{where_}.input"))?;
                if !input.is(&[F32], &["SCALAR"]) {
                    return refuse(GlbFault::Layout, format!("{where_}.input is not float SCALAR"));
                }
                outputs.push(self.accessor(sampler.get("output").unwrap_or(&Value::Null), &format!("{where_}.output"))?);
            }
            let channels = animation.get("channels").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
            for (c, channel) in channels.iter().enumerate() {
                let where_ = format!("{what}.channels[{c}]");
                let channel = object(channel, &where_)?;
                let sampler = index(channel, "sampler", samplers.len(), &where_)?.ok_or_else(|| GlbRefusal::new(GlbFault::Json, format!("{where_} has no sampler")))?;
                let target = object(channel.get("target").unwrap_or(&Value::Null), &format!("{where_}.target"))?;
                index(target, "node", nodes, &format!("{where_}.target"))?;
                check_output(target.get("path").and_then(Value::as_str).unwrap_or_default(), outputs[sampler], &where_)?;
            }
        }
        Ok(())
    }

    fn check_images(&self) -> Checked<()> {
        let images = list(self.root, "images")?;
        for (n, image) in images.iter().enumerate() {
            index(image, "bufferView", self.views.len(), &format!("images[{n}]"))?;
        }
        for (n, texture) in list(self.root, "textures")?.into_iter().enumerate() {
            index(texture, "source", images.len(), &format!("textures[{n}]"))?;
        }
        Ok(())
    }
}

/// A little-endian unsigned index of 1, 2 or 4 bytes.
fn index_value(bytes: &[u8]) -> u64 {
    match *bytes {
        [byte] => u64::from(byte),
        [low, high] => u64::from(u16::from_le_bytes([low, high])),
        [a, b, c, d] => u64::from(u32::from_le_bytes([a, b, c, d])),
        _ => u64::MAX,
    }
}

/// The output layouts the `gltf` reader has an arm for, per animated property.
fn check_output(path: &str, output: &Accessor, what: &str) -> Checked<()> {
    let integers_or_float = [I8, U8, I16, U16, F32];
    let fits = match path {
        "translation" | "scale" => output.is(&[F32], &["VEC3"]),
        "rotation" => output.is(&integers_or_float, &["VEC4"]),
        "weights" => output.is(&integers_or_float, &["SCALAR"]),
        _ => true,
    };
    if fits {
        return Ok(());
    }
    refuse(GlbFault::Layout, format!("{what} animates {path} with componentType {} {}", output.component, output.kind))
}

/// No node is its own ancestor and no chain is deeper than [`GLB_MAX_NODE_DEPTH`]: each node's
/// depth is found by walking up to a root or a node already measured.
fn check_depths(parents: &[Option<usize>]) -> Checked<()> {
    let mut depths: Vec<Option<usize>> = vec![None; parents.len()];
    let mut path = Vec::new();
    for start in 0..parents.len() {
        let mut at = start;
        let base = loop {
            if let Some(depth) = depths[at] {
                break depth;
            }
            if path.len() > parents.len() {
                return refuse(GlbFault::Tree, format!("node {start} is its own ancestor"));
            }
            path.push(at);
            match parents[at] {
                Some(parent) => at = parent,
                None => break 0,
            }
        };
        for (step, node) in path.drain(..).rev().enumerate() {
            let depth = base + step + 1;
            if depth > GLB_MAX_NODE_DEPTH {
                return refuse(GlbFault::Tree, format!("node {node} is {depth} levels deep, past {GLB_MAX_NODE_DEPTH}"));
            }
            depths[node] = Some(depth);
        }
    }
    Ok(())
}
