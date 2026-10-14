//! glTF 2.0 models through `gltf` 1.4.1: a GLB, or a `.gltf` whose external buffers are read
//! through the same [`AssetRoot`] (relative to the `.gltf`, under the asset-path rule) or decoded
//! from a `data:` URI. Images are named, never read here: the renderer loads each through
//! [`crate::texture::load_texture`], so a missing one is the checker. A file that requires Draco
//! or meshopt is the studio import step's to write back plain (`needs-import`).

use crate::error::{AssetError, AssetErrorCode};
use crate::root::AssetRoot;
use gltf::Gltf;

/// The extensions the import step decodes before a game sees the file.
const IMPORTED_EXTENSIONS: [&str; 3] = ["KHR_draco_mesh_compression", "EXT_meshopt_compression", "KHR_meshopt_compression"];
/// Model formats the import step converts to GLB.
const IMPORTED_FORMATS: [&str; 3] = ["obj", "stl", "ply"];
const DATA_URI: &str = "data:";
const BASE64_MARK: &str = ";base64,";

/// One triangle list.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ModelPrimitive {
    /// Vertex positions.
    pub positions: Vec<[f32; 3]>,
    /// One per position, or none (the renderer then computes flat normals).
    pub normals: Vec<[f32; 3]>,
    /// First texture coordinates, one per position, or none.
    pub uvs: Vec<[f32; 2]>,
    /// Triangle indices, each below `positions.len()`.
    pub indices: Vec<u32>,
    /// The material's index in the document.
    pub material: Option<usize>,
}

/// One named mesh.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ModelMesh {
    /// The mesh's name, or "".
    pub name: String,
    /// Its triangle lists; points and lines are left out.
    pub primitives: Vec<ModelPrimitive>,
}

/// A loaded glTF.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Model {
    /// Every mesh, in document order.
    pub meshes: Vec<ModelMesh>,
    /// Each image's asset path (relative URIs resolved against the model's folder), for
    /// `load_texture`; an image held in a buffer or a data URI is `None` here.
    pub images: Vec<Option<String>>,
}

fn malformed(detail: impl Into<String>) -> AssetError {
    AssetError::new(AssetErrorCode::Malformed, detail)
}

fn extension_of(rel: &str) -> String {
    rel.rsplit_once('.').map(|(_, ext)| ext.to_ascii_lowercase()).unwrap_or_default()
}

/// The model at `rel` (a `.glb` or `.gltf` under the asset folder).
pub fn load_model(root: &AssetRoot, rel: &str) -> Result<Model, AssetError> {
    let ext = extension_of(rel);
    if IMPORTED_FORMATS.contains(&ext.as_str()) {
        return Err(AssetError::new(AssetErrorCode::NeedsImport, format!(".{ext} is converted to GLB at import")));
    }
    if ext != "glb" && ext != "gltf" {
        return Err(AssetError::new(AssetErrorCode::Unsupported, format!(".{ext} is not a model the runtime loads")));
    }
    let bytes = root.read(rel)?;
    let unchecked = Gltf::from_slice_without_validation(&bytes).map_err(|e| malformed(e.to_string()))?;
    if let Some(name) = unchecked.document.extensions_required().find(|name| IMPORTED_EXTENSIONS.contains(name)) {
        return Err(AssetError::new(AssetErrorCode::NeedsImport, format!("{rel} requires {name}")));
    }
    let gltf = Gltf::from_slice(&bytes).map_err(|e| malformed(e.to_string()))?;
    let folder = rel.rsplit_once('/').map(|(dir, _)| dir).unwrap_or("");
    let buffers = buffer_data(root, folder, &gltf)?;
    let meshes = gltf.document.meshes().map(|mesh| read_mesh(&mesh, &buffers)).collect::<Result<Vec<_>, _>>()?;
    let images = gltf.document.images().map(|image| image_path(folder, image.source())).collect();
    Ok(Model { meshes, images })
}

/// Every buffer's bytes: the GLB's binary chunk, a file beside the model, or a data URI.
fn buffer_data(root: &AssetRoot, folder: &str, gltf: &Gltf) -> Result<Vec<Vec<u8>>, AssetError> {
    gltf.document
        .buffers()
        .map(|buffer| {
            let data = match buffer.source() {
                gltf::buffer::Source::Bin => gltf.blob.clone().ok_or_else(|| malformed("no binary chunk"))?,
                gltf::buffer::Source::Uri(uri) if uri.starts_with(DATA_URI) => data_uri(uri)?,
                gltf::buffer::Source::Uri(uri) => root.read(&relative(folder, &percent_decode(uri)?))?,
            };
            if data.len() < buffer.length() {
                return Err(malformed(format!("buffer {} is shorter than it says", buffer.index())));
            }
            Ok(data)
        })
        .collect()
}

fn image_path(folder: &str, source: gltf::image::Source<'_>) -> Option<String> {
    match source {
        gltf::image::Source::Uri { uri, .. } if !uri.starts_with(DATA_URI) => {
            percent_decode(uri).ok().map(|uri| relative(folder, &uri))
        }
        _ => None,
    }
}

/// `uri` beside the model: joined to its folder, still to pass the asset-path rule when read.
fn relative(folder: &str, uri: &str) -> String {
    if folder.is_empty() { uri.to_owned() } else { format!("{folder}/{uri}") }
}

fn read_mesh(mesh: &gltf::Mesh<'_>, buffers: &[Vec<u8>]) -> Result<ModelMesh, AssetError> {
    let primitives = mesh
        .primitives()
        .filter(|primitive| primitive.mode() == gltf::mesh::Mode::Triangles)
        .map(|primitive| read_primitive(&primitive, buffers))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ModelMesh { name: mesh.name().unwrap_or("").to_owned(), primitives })
}

fn read_primitive(primitive: &gltf::Primitive<'_>, buffers: &[Vec<u8>]) -> Result<ModelPrimitive, AssetError> {
    let reader = primitive.reader(|buffer| buffers.get(buffer.index()).map(Vec::as_slice));
    let positions: Vec<[f32; 3]> = reader.read_positions().ok_or_else(|| malformed("a primitive without positions"))?.collect();
    let normals: Vec<[f32; 3]> = reader.read_normals().map(Iterator::collect).unwrap_or_default();
    let uvs: Vec<[f32; 2]> = reader.read_tex_coords(0).map(|uvs| uvs.into_f32().collect()).unwrap_or_default();
    let count = u32::try_from(positions.len()).map_err(|_| malformed("too many vertices"))?;
    let indices: Vec<u32> = match reader.read_indices() {
        Some(indices) => indices.into_u32().collect(),
        None => (0..count).collect(),
    };
    let complete = |len: usize| len == 0 || len == positions.len();
    if !complete(normals.len()) || !complete(uvs.len()) || !indices.len().is_multiple_of(3) {
        return Err(malformed("a primitive's attributes disagree"));
    }
    if indices.iter().any(|&index| index >= count) {
        return Err(malformed("an index past the last vertex"));
    }
    Ok(ModelPrimitive { positions, normals, uvs, indices, material: primitive.material().index() })
}

/// A URI's `%XX` escapes decoded; an escape that is not two hex digits, or bytes that are not
/// UTF-8, refuse.
fn percent_decode(uri: &str) -> Result<String, AssetError> {
    let bytes = uri.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%' {
            let hex = bytes.get(at + 1..at + 3).and_then(|pair| std::str::from_utf8(pair).ok());
            let byte = hex.and_then(|pair| u8::from_str_radix(pair, 16).ok()).ok_or_else(|| malformed("a bad URI escape"))?;
            out.push(byte);
            at += 3;
        } else {
            out.push(bytes[at]);
            at += 1;
        }
    }
    String::from_utf8(out).map_err(|_| malformed("a URI that is not UTF-8"))
}

/// The bytes of a base64 `data:` URI.
fn data_uri(uri: &str) -> Result<Vec<u8>, AssetError> {
    let (_, payload) = uri.split_once(BASE64_MARK).ok_or_else(|| malformed("a data URI that is not base64"))?;
    base64_decode(payload).ok_or_else(|| malformed("bad base64 in a data URI"))
}

fn base64_value(byte: u8) -> Option<u32> {
    let value = match byte {
        b'A'..=b'Z' => byte - b'A',
        b'a'..=b'z' => byte - b'a' + 26,
        b'0'..=b'9' => byte - b'0' + 52,
        b'+' | b'-' => 62,
        b'/' | b'_' => 63,
        _ => return None,
    };
    Some(u32::from(value))
}

/// Standard or URL-safe base64, padded or not.
fn base64_decode(text: &str) -> Option<Vec<u8>> {
    let digits = text.trim_end_matches('=').as_bytes();
    let mut out = Vec::with_capacity(digits.len() * 3 / 4);
    for chunk in digits.chunks(4) {
        if chunk.len() == 1 {
            return None;
        }
        let mut n = 0u32;
        for (i, &byte) in chunk.iter().enumerate() {
            n |= base64_value(byte)? << (18 - 6 * i);
        }
        let bytes = n.to_be_bytes();
        out.extend_from_slice(&bytes[1..chunk.len()]);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_reads_padded_unpadded_and_url_safe_text() {
        assert_eq!(base64_decode("aGVsbG8=").as_deref(), Some(&b"hello"[..]));
        assert_eq!(base64_decode("aGVsbG8").as_deref(), Some(&b"hello"[..]));
        assert_eq!(base64_decode("-_8=").as_deref(), Some(&[0xfb, 0xff][..]));
        assert_eq!(base64_decode("a"), None);
        assert_eq!(base64_decode("a$=="), None);
    }

    #[test]
    fn percent_escapes_decode_and_bad_ones_refuse() {
        assert_eq!(percent_decode("my%20mesh.bin").as_deref(), Ok("my mesh.bin"));
        assert!(percent_decode("bad%2").is_err());
        assert!(percent_decode("%ff").is_err());
        assert_eq!(percent_decode("..%2Fx.bin").map(|uri| relative("models", &uri)).as_deref(), Ok("models/../x.bin"));
    }
}
