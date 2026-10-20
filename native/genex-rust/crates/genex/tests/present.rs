//! A GLB's images through the asset cache (game systems C-14): the Studio's import step writes each
//! image a GLB's materials sample out as family files beside it (`<stem>.<family>.ktx2`, C-13) and
//! names them in `asset.extras.genex_textures`. The presenter uploads an image from its sidecar in
//! the renderer's family and decodes the embedded image only when the GLB names none, the game
//! ships none in that family or the renderer refuses it (`texture-family-refused`); an image the
//! game ships no sidecar of in any family is named `texture-uncompressed`. A malformed
//! block, a stem that would leave the model's folder among them, loads the embedded images with a
//! log line and never refuses the model. The family is chosen from a frame's models' sidecars too.
//!
//! The runtime tangent fallback (C-9) is named on the model it ran for: `tangents-runtime`.
//!
//! The GPU row is `#[ignore]`d and its name contains `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex \
//!     --test present -- --ignored metal

use std::cell::RefCell;

use genex::present::{AssetCache, AssetIssue, AssetIssueCode, ModelSource, TextureFact, TextureOrigin, Uploads, texture_facts};
use genex::{Frame, Transform};
use genex_render::device_loss::CompressedSource;
use genex_render::mesh::MeshData;
use genex_render::scene::MeshId;
use genex_render::texture::{CompressedTexture, TextureData, TextureFamily, TextureId, TextureKind};
use genex_render::{RenderCode, RenderError};

const CRATE: &str = "props/crate.glb";
/// Where a KTX2 file's `vkFormat` sits (a little-endian u32).
const KTX2_FORMAT_AT: usize = 12;
/// `VK_FORMAT_BC7_UNORM_BLOCK`: the linear BC7 a `data` or `normal` sidecar is.
const BC7_UNORM: u32 = 145;

/// A 2x2 opaque white PNG (stored deflate).
const WHITE_PNG: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00,
    0x00, 0x02, 0x08, 0x06, 0x00, 0x00, 0x00, 0x72, 0xb6, 0x0d, 0x24, 0x00, 0x00, 0x00, 0x1d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x01, 0x01,
    0x12, 0x00, 0xed, 0xff, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0x8f, 0x82, 0x0f, 0xf1, 0x6d, 0x9e, 0x54, 0xf2, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
];

/// The repository's asset-import fixtures.
fn import_fixture(name: &str) -> Vec<u8> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../tests/fixtures/asset-import").join(name);
    std::fs::read(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

/// A BC7 family file the import step wrote (sRGB, a `color` sidecar).
fn bc_color() -> Vec<u8> {
    import_fixture("basis-uastc-64.bc.ktx2")
}

/// The same file stored linear (a `data` or `normal` sidecar).
fn bc_linear() -> Vec<u8> {
    let mut bytes = bc_color();
    bytes[KTX2_FORMAT_AT..KTX2_FORMAT_AT + 4].copy_from_slice(&BC7_UNORM.to_le_bytes());
    bytes
}

/// A unit quad whose material samples image 0 as its base colour, image 1 as its normal map and
/// image 2 as its metallic-roughness map (each an embedded copy of [`WHITE_PNG`]), its
/// `asset.extras` set to `extras` (none when null).
fn crate_glb(extras: serde_json::Value) -> Vec<u8> {
    crate_glb_sampling(extras, [0, 1, 2])
}

/// [`crate_glb`] whose base colour, normal and metallic-roughness slots sample `sources`.
fn crate_glb_sampling(extras: serde_json::Value, sources: [u32; 3]) -> Vec<u8> {
    let positions: [f32; 12] = [-1.0, -1.0, 0.0, 1.0, -1.0, 0.0, 1.0, 1.0, 0.0, -1.0, 1.0, 0.0];
    let normals: [f32; 12] = [0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0];
    let tangents: [f32; 16] = [1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0];
    let uvs: [f32; 8] = [0.0, 1.0, 1.0, 1.0, 1.0, 0.0, 0.0, 0.0];
    let indices: [u16; 6] = [0, 1, 2, 0, 2, 3];
    let mut bin: Vec<u8> = positions.iter().chain(&normals).chain(&tangents).chain(&uvs).flat_map(|f| f.to_le_bytes()).collect();
    bin.extend(indices.iter().flat_map(|i| i.to_le_bytes()));
    while !bin.len().is_multiple_of(4) {
        bin.push(0);
    }
    let mut views = vec![
        serde_json::json!({ "buffer": 0, "byteOffset": 0, "byteLength": 48 }),
        serde_json::json!({ "buffer": 0, "byteOffset": 48, "byteLength": 48 }),
        serde_json::json!({ "buffer": 0, "byteOffset": 96, "byteLength": 64 }),
        serde_json::json!({ "buffer": 0, "byteOffset": 160, "byteLength": 32 }),
        serde_json::json!({ "buffer": 0, "byteOffset": 192, "byteLength": 12 }),
    ];
    let mut images = Vec::new();
    for _ in 0..3 {
        while !bin.len().is_multiple_of(4) {
            bin.push(0);
        }
        views.push(serde_json::json!({ "buffer": 0, "byteOffset": bin.len(), "byteLength": WHITE_PNG.len() }));
        images.push(serde_json::json!({ "bufferView": views.len() - 1, "mimeType": "image/png" }));
        bin.extend(WHITE_PNG);
    }
    while !bin.len().is_multiple_of(4) {
        bin.push(0);
    }
    let mut asset = serde_json::json!({ "version": "2.0" });
    if !extras.is_null() {
        asset["extras"] = extras;
    }
    let gltf = serde_json::json!({
        "asset": asset,
        "buffers": [{ "byteLength": bin.len() }],
        "bufferViews": views,
        "accessors": [
            { "bufferView": 0, "componentType": 5126, "count": 4, "type": "VEC3", "min": [-1.0, -1.0, 0.0], "max": [1.0, 1.0, 0.0] },
            { "bufferView": 1, "componentType": 5126, "count": 4, "type": "VEC3" },
            { "bufferView": 2, "componentType": 5126, "count": 4, "type": "VEC4" },
            { "bufferView": 3, "componentType": 5126, "count": 4, "type": "VEC2" },
            { "bufferView": 4, "componentType": 5123, "count": 6, "type": "SCALAR" },
        ],
        "images": images,
        "textures": sources.map(|source| serde_json::json!({ "source": source })),
        "materials": [{
            "pbrMetallicRoughness": { "baseColorTexture": { "index": 0 }, "metallicRoughnessTexture": { "index": 2 } },
            "normalTexture": { "index": 1 },
        }],
        "meshes": [{ "primitives": [{ "attributes": { "POSITION": 0, "NORMAL": 1, "TANGENT": 2, "TEXCOORD_0": 3 }, "indices": 4, "material": 0 }] }],
        "nodes": [{ "mesh": 0 }],
        "scenes": [{ "nodes": [0] }],
        "scene": 0,
    });
    glb(&gltf, &bin)
}

/// `json` and `bin` as a GLB.
fn glb(json: &serde_json::Value, bin: &[u8]) -> Vec<u8> {
    let mut json = json.to_string().into_bytes();
    while !json.len().is_multiple_of(4) {
        json.push(b' ');
    }
    let mut out = Vec::new();
    out.extend(b"glTF");
    out.extend(2u32.to_le_bytes());
    out.extend(((12 + 8 + json.len() + 8 + bin.len()) as u32).to_le_bytes());
    out.extend((json.len() as u32).to_le_bytes());
    out.extend(b"JSON");
    out.extend(&json);
    out.extend((bin.len() as u32).to_le_bytes());
    out.extend(b"BIN\0");
    out.extend(bin);
    out
}

/// What C-13 writes for [`crate_glb`]: one row per image, in its slot's usage.
fn imported_block() -> serde_json::Value {
    serde_json::json!({ "genex_textures": { "v": 1, "images": [
        { "image": 0, "kind": "color", "stem": "crate.t0" },
        { "image": 1, "kind": "normal", "stem": "crate.t1" },
        { "image": 2, "kind": "data", "stem": "crate.t2" },
    ] } })
}

/// The imported crate and its BC7 sidecars.
fn imported_files() -> Files {
    Files::new(vec![
        (CRATE, crate_glb(imported_block())),
        ("props/crate.t0.bc.ktx2", bc_color()),
        ("props/crate.t1.bc.ktx2", bc_linear()),
        ("props/crate.t2.bc.ktx2", bc_linear()),
    ])
}

/// A game's files by path, and every path read.
struct Files {
    files: Vec<(&'static str, Vec<u8>)>,
    read: RefCell<Vec<String>>,
}

impl Files {
    fn new(files: Vec<(&'static str, Vec<u8>)>) -> Files {
        Files { files, read: RefCell::new(Vec::new()) }
    }
}

impl ModelSource for Files {
    fn model_bytes(&self, path: &str) -> Option<Vec<u8>> {
        self.read.borrow_mut().push(path.to_owned());
        self.files.iter().find(|(known, _)| *known == path).map(|(_, bytes)| bytes.clone())
    }

    fn has_asset(&self, path: &str) -> bool {
        self.read.borrow_mut().push(path.to_owned());
        self.files.iter().any(|(known, _)| *known == path)
    }
}

/// A renderer stand-in offering `families`, which refuses a compressed file whose colour space is
/// not its slot's (the real arrays' rule) and records every upload.
struct Recording {
    families: Vec<TextureFamily>,
    family: TextureFamily,
    refuse_compressed: bool,
    /// The side of the smallest class the family is stored in.
    min_side: u32,
    calls: Vec<String>,
}

impl Recording {
    fn offering(families: &[TextureFamily]) -> Recording {
        Recording { families: families.to_vec(), family: TextureFamily::Rgba8, refuse_compressed: false, min_side: 0, calls: Vec::new() }
    }
}

impl Uploads for Recording {
    fn add_mesh(&mut self, _mesh: MeshData) -> Result<MeshId, RenderError> {
        Ok(MeshId::from_raw(10))
    }

    fn add_texture(&mut self, data: &TextureData, kind: TextureKind) -> Result<TextureId, RenderError> {
        self.calls.push(format!("image {kind:?} {}x{}", data.width(), data.height()));
        Ok(TextureId::new(kind, 0))
    }

    fn compressed_families(&self) -> Vec<TextureFamily> {
        self.families.clone()
    }

    fn texture_family(&self) -> TextureFamily {
        self.family
    }

    fn compressed_min_side(&self) -> u32 {
        self.min_side
    }

    fn set_texture_family(&mut self, family: TextureFamily) -> Result<(), RenderError> {
        self.calls.push(format!("family {}", family.wire()));
        self.family = family;
        Ok(())
    }

    fn add_compressed_texture(&mut self, texture: &CompressedTexture, kind: TextureKind, _source: Option<CompressedSource>) -> Result<TextureId, RenderError> {
        if self.refuse_compressed {
            return Err(RenderError::refused(RenderCode::TextureTooLarge, "every size class it fits is full"));
        }
        let colour_slot = matches!(kind, TextureKind::Color | TextureKind::Cutout);
        if texture.is_srgb() != colour_slot {
            return Err(RenderError::refused(RenderCode::TextureInvalid, format!("an sRGB={} file for a {kind:?} slot", texture.is_srgb())));
        }
        self.calls.push(format!("{} {kind:?}", texture.family().wire()));
        Ok(TextureId::new(kind, 1))
    }
}

/// A frame drawing `path` with the materials its GLB names.
fn drawing(path: &str) -> Frame {
    let mut frame = Frame::default();
    frame.model(&genex::Assets::default().model(path), Transform::IDENTITY);
    frame
}

/// What loading `frame` from `files` into `uploads` did: the uploads, the log, the facts and issues.
struct Loaded {
    calls: Vec<String>,
    log: Vec<String>,
    textures: Vec<TextureFact>,
    issues: Vec<AssetIssue>,
}

fn load(frame: &Frame, files: &Files, mut uploads: Recording) -> Loaded {
    let mut cache = AssetCache::default();
    let mut log = Vec::new();
    cache.load(frame, files, &mut uploads, &mut |line| log.push(line.to_owned())).expect("no device loss");
    let (textures, issues) = texture_facts(frame, &cache);
    assert!(cache.model(CRATE).is_some(), "the model is never refused for its images: {log:?}");
    Loaded { calls: uploads.calls, log, textures, issues }
}

/// A `texture-uncompressed` issue for each of `paths`.
fn uncompressed(paths: &[&str]) -> Vec<AssetIssue> {
    paths.iter().map(|path| AssetIssue { path: (*path).to_owned(), code: AssetIssueCode::TextureUncompressed }).collect()
}

fn fact(path: &str, kind: TextureKind, origin: TextureOrigin) -> TextureFact {
    TextureFact { path: path.to_owned(), kind, origin }
}

/// The facts of the crate's three images, each from `origin`.
fn crate_facts(origin: TextureOrigin) -> [TextureFact; 3] {
    [
        fact("props/crate.glb#0", TextureKind::Color, origin),
        fact("props/crate.glb#1", TextureKind::Normal, origin),
        fact("props/crate.glb#2", TextureKind::Data, origin),
    ]
}

#[test]
fn the_import_step_s_sidecars_upload_bc_for_every_image_on_a_bc_device() {
    let loaded = load(&drawing(CRATE), &imported_files(), Recording::offering(&[TextureFamily::Bc7]));
    assert_eq!(loaded.calls, ["family bc", "bc Color", "bc Normal", "bc Data"], "no image is decoded to RGBA8: {:?}", loaded.log);
    assert_eq!(loaded.textures, crate_facts(TextureOrigin::Family(TextureFamily::Bc7)));
    assert!(loaded.issues.is_empty(), "{:?}", loaded.issues);
}

#[test]
fn a_glb_without_the_block_or_a_device_without_the_family_decodes_the_embedded_images() {
    let rgba8 = ["image Color 2x2", "image Normal 2x2", "image Data 2x2"];
    let plain = Files::new(vec![(CRATE, crate_glb(serde_json::Value::Null))]);
    let loaded = load(&drawing(CRATE), &plain, Recording::offering(&[TextureFamily::Bc7]));
    assert_eq!(loaded.calls, rgba8);
    assert_eq!(loaded.textures, crate_facts(TextureOrigin::Source));
    // Not imported: each image is drawn uncompressed, which the import step fixes.
    assert_eq!(loaded.issues, uncompressed(&["props/crate.glb#0", "props/crate.glb#1", "props/crate.glb#2"]));
    // A device that samples no family the game ships: the import did its part, nothing to fix.
    let loaded = load(&drawing(CRATE), &imported_files(), Recording::offering(&[TextureFamily::Astc4x4]));
    assert_eq!(loaded.calls, rgba8);
    assert_eq!(loaded.textures, crate_facts(TextureOrigin::Source));
    assert!(loaded.issues.is_empty(), "{:?}", loaded.issues);
}

#[test]
fn a_sidecar_the_renderer_refuses_loads_its_embedded_image_and_is_named_family_refused() {
    let mut files = imported_files();
    // The normal map's sidecar is stored sRGB: the arrays refuse it for a Normal slot.
    files.files[2].1 = bc_color();
    let loaded = load(&drawing(CRATE), &files, Recording::offering(&[TextureFamily::Bc7]));
    assert_eq!(loaded.calls, ["family bc", "bc Color", "image Normal 2x2", "bc Data"]);
    assert_eq!(loaded.textures[1], fact("props/crate.glb#1", TextureKind::Normal, TextureOrigin::Source));
    let named: Vec<(&str, &str)> = loaded.issues.iter().map(|issue| (issue.path.as_str(), issue.code.wire())).collect();
    assert_eq!(named, [("props/crate.glb#1", "texture-family-refused")]);
    assert!(loaded.log.iter().any(|line| line.contains("crate.t1.bc.ktx2") && line.contains("refused")), "{:?}", loaded.log);
    // Every size class full: each sidecar refused, each image decoded and named.
    let full = Recording { refuse_compressed: true, ..Recording::offering(&[TextureFamily::Bc7]) };
    let loaded = load(&drawing(CRATE), &imported_files(), full);
    assert_eq!(loaded.issues.len(), 3, "{:?}", loaded.issues);
    assert!(loaded.issues.iter().all(|issue| issue.code == AssetIssueCode::TextureFamilyRefused));
}

#[test]
fn a_sidecar_under_the_family_s_smallest_class_loads_its_image_with_no_issue() {
    // The renderer holds class 0 (256) as RGBA8: a 64-texel sidecar is never stored compressed.
    let small = Recording { min_side: 512, ..Recording::offering(&[TextureFamily::Bc7]) };
    let loaded = load(&drawing(CRATE), &imported_files(), small);
    assert_eq!(loaded.calls, ["family bc", "image Color 2x2", "image Normal 2x2", "image Data 2x2"]);
    assert_eq!(loaded.textures, crate_facts(TextureOrigin::Source));
    assert!(loaded.issues.is_empty(), "held as images by design, nothing to fix: {:?}", loaded.issues);
    assert!(loaded.log.is_empty(), "{:?}", loaded.log);
}

#[test]
fn a_malformed_block_loads_the_embedded_images_with_a_log_line_and_reads_no_sidecar() {
    let long = "s".repeat(201);
    let row = |image: serde_json::Value, kind: &str, stem: &str| serde_json::json!({ "image": image, "kind": kind, "stem": stem });
    let malformed: Vec<(&str, serde_json::Value)> = vec![
        ("version 2", serde_json::json!({ "v": 2, "images": [row(0.into(), "color", "crate.t0")] })),
        ("no images", serde_json::json!({ "v": 1 })),
        ("image out of range", serde_json::json!({ "v": 1, "images": [row(3.into(), "color", "crate.t0")] })),
        ("negative image", serde_json::json!({ "v": 1, "images": [row((-1).into(), "color", "crate.t0")] })),
        ("unknown kind", serde_json::json!({ "v": 1, "images": [row(0.into(), "albedo", "crate.t0")] })),
        ("twice", serde_json::json!({ "v": 1, "images": [row(0.into(), "color", "crate.t0"), row(0.into(), "color", "crate.t9")] })),
        ("parent folder", serde_json::json!({ "v": 1, "images": [row(0.into(), "color", "../crate.t0")] })),
        ("absolute", serde_json::json!({ "v": 1, "images": [row(0.into(), "color", "/etc/crate.t0")] })),
        ("sub folder", serde_json::json!({ "v": 1, "images": [row(0.into(), "color", "sub/crate.t0")] })),
        ("backslash", serde_json::json!({ "v": 1, "images": [row(0.into(), "color", "..\\crate.t0")] })),
        ("dot file", serde_json::json!({ "v": 1, "images": [row(0.into(), "color", ".crate.t0")] })),
        ("nul", serde_json::json!({ "v": 1, "images": [row(0.into(), "color", "crate\u{0}.t0")] })),
        ("empty", serde_json::json!({ "v": 1, "images": [row(0.into(), "color", "")] })),
        ("too long", serde_json::json!({ "v": 1, "images": [row(0.into(), "color", &long)] })),
    ];
    for (case, block) in malformed {
        let files = Files::new(vec![
            (CRATE, crate_glb(serde_json::json!({ "genex_textures": block }))),
            ("props/crate.t0.bc.ktx2", bc_color()),
            ("crate.t0.bc.ktx2", bc_color()),
            ("etc/crate.t0.bc.ktx2", bc_color()),
            ("props/sub/crate.t0.bc.ktx2", bc_color()),
        ]);
        let loaded = load(&drawing(CRATE), &files, Recording::offering(&[TextureFamily::Bc7]));
        assert_eq!(loaded.calls, ["image Color 2x2", "image Normal 2x2", "image Data 2x2"], "{case}");
        assert_eq!(loaded.textures, crate_facts(TextureOrigin::Source), "{case}");
        assert_eq!(loaded.issues, uncompressed(&["props/crate.glb#0", "props/crate.glb#1", "props/crate.glb#2"]), "{case}");
        assert!(loaded.log.iter().any(|line| line.contains("genex_textures ignored")), "{case}: {:?}", loaded.log);
        let read = files.read.into_inner();
        assert!(read.iter().all(|path| path == CRATE), "{case}: only the model is read: {read:?}");
    }
}

#[test]
fn an_image_sampled_in_two_usages_takes_each_usage_s_own_sidecar() {
    let block = serde_json::json!({ "genex_textures": { "v": 1, "images": [
        { "image": 0, "kind": "color", "stem": "crate.t0.color" },
        { "image": 0, "kind": "data", "stem": "crate.t0.data" },
    ] } });
    // Every slot samples image 0: as colour, as a normal map and as data.
    let json = crate_glb_sampling(block, [0, 0, 0]);
    let files = Files::new(vec![(CRATE, json), ("props/crate.t0.color.bc.ktx2", bc_color()), ("props/crate.t0.data.bc.ktx2", bc_linear())]);
    let loaded = load(&drawing(CRATE), &files, Recording::offering(&[TextureFamily::Bc7]));
    // The normal usage has no row: its slot decodes the embedded image, and that usage is named.
    assert_eq!(loaded.calls, ["family bc", "bc Color", "image Normal 2x2", "bc Data"], "{:?}", loaded.log);
    assert_eq!(loaded.textures, [fact("props/crate.glb#0", TextureKind::Color, TextureOrigin::Family(TextureFamily::Bc7))]);
    assert_eq!(loaded.issues, uncompressed(&["props/crate.glb#0"]));
}

#[test]
fn a_model_whose_tangents_were_generated_at_load_is_named_tangents_runtime_once() {
    const MIRRORED: &str = "spheres/mirrored.glb";
    const IMPORTED: &str = "spheres/imported.glb";
    let files = Files::new(vec![(MIRRORED, import_fixture("tangents-mirrored.glb")), (IMPORTED, import_fixture("tangents-mirrored.imported.glb"))]);
    let mut frame = drawing(MIRRORED);
    let assets = genex::Assets::default();
    frame.model(&assets.model(IMPORTED), Transform::IDENTITY);
    frame.model(&assets.model(MIRRORED), Transform::from_xyz(2.0, 0.0, 0.0));
    let mut cache = AssetCache::default();
    cache.load(&frame, &files, &mut Recording::offering(&[]), &mut |_| {}).expect("no device loss");
    let (_, issues) = texture_facts(&frame, &cache);
    // Neither sphere ships its normal map as a sidecar (`#0`, texture-uncompressed); only the
    // unimported one generated its tangents.
    let tangents: Vec<&AssetIssue> = issues.iter().filter(|issue| issue.code == AssetIssueCode::TangentsRuntime).collect();
    assert_eq!(tangents, [&AssetIssue { path: MIRRORED.to_owned(), code: AssetIssueCode::TangentsRuntime }]);
    assert_eq!(issues.last(), tangents.last().copied(), "after the texture issues");
    assert!(cache.model(MIRRORED).is_some_and(|loaded| loaded.runtime_tangents));
    assert!(cache.model(IMPORTED).is_some_and(|loaded| !loaded.runtime_tangents));
}

#[test]
fn the_new_issue_code_has_its_wire_spelling() {
    let wire: Vec<&str> = AssetIssueCode::ALL.iter().map(|code| code.wire()).collect();
    assert_eq!(wire, ["texture-uncompressed", "texture-family-refused", "tangents-runtime"]);
}

// Through the presenter (a GPU): the C-13 step's sidecars upload BC and draw as the embedded images
// do, within BC's error, and the runtime's tangents (C-9) shade a mirrored, bumpy normal map as the
// import step's do.

mod presenter {
    use std::f32::consts::{FRAC_PI_2, PI};
    use std::path::{Path, PathBuf};

    use genex::present::Presenter;
    use genex::prelude::*;
    use genex::{FIXED_STEP_MS, Model, Runtime, View};

    use super::{glb, import_fixture};

    const WORLD: [u32; 2] = [256, 160];
    /// The side of the test's normal map.
    const SIDE: u32 = 64;
    /// The mean per-channel difference a BC7 sidecar may make against its source image, and the
    /// share of pixels allowed past [`BC_EDGE_STEP`] (BC7 blocks soften hard colour edges).
    const BC_MEAN_MAX: f64 = 2.0;
    const BC_EDGE_STEP: u8 = 16;
    const BC_EDGE_SHARE_MAX: f64 = 0.02;
    /// The same for two sets of tangents that agree to 1e-4 (C-9): rounding, on a few pixels.
    const TANGENT_MEAN_MAX: f64 = 0.05;
    const TANGENT_STEP: u8 = 1;
    const TANGENT_SHARE_MAX: f64 = 0.001;

    #[derive(Default)]
    struct World {
        model: Model,
    }

    /// A stored-deflate PNG of `rgba` (`width` x `height`).
    fn png(width: u32, height: u32, rgba: &[u8]) -> Vec<u8> {
        let crc = |bytes: &[u8]| {
            let mut crc = 0xffff_ffffu32;
            for byte in bytes {
                crc ^= u32::from(*byte);
                for _ in 0..8 {
                    crc = if crc & 1 == 1 { 0xedb8_8320 ^ (crc >> 1) } else { crc >> 1 };
                }
            }
            !crc
        };
        let chunk = |out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]| {
            out.extend((data.len() as u32).to_be_bytes());
            let mut body = kind.to_vec();
            body.extend(data);
            out.extend(&body);
            out.extend(crc(&body).to_be_bytes());
        };
        let mut raw = Vec::new();
        for row in rgba.chunks_exact(width as usize * 4) {
            raw.push(0);
            raw.extend(row);
        }
        let (mut a, mut b) = (1u32, 0u32);
        for byte in &raw {
            a = (a + u32::from(*byte)) % 65_521;
            b = (b + a) % 65_521;
        }
        let mut zlib = vec![0x78, 0x01];
        for (at, block) in raw.chunks(65_535).enumerate() {
            let last = (at + 1) * 65_535 >= raw.len();
            zlib.push(u8::from(last));
            zlib.extend((block.len() as u16).to_le_bytes());
            zlib.extend((!(block.len() as u16)).to_le_bytes());
            zlib.extend(block);
        }
        zlib.extend(((b << 16) | a).to_be_bytes());
        let mut out = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        let mut header = Vec::new();
        header.extend(width.to_be_bytes());
        header.extend(height.to_be_bytes());
        header.extend([8, 6, 0, 0, 0]);
        chunk(&mut out, b"IHDR", &header);
        chunk(&mut out, b"IDAT", &zlib);
        chunk(&mut out, b"IEND", &[]);
        out
    }

    /// A GLB's JSON and binary chunks.
    fn split(bytes: &[u8]) -> (serde_json::Value, Vec<u8>) {
        let json_len = u32::from_le_bytes(bytes[12..16].try_into().expect("length")) as usize;
        let json = serde_json::from_slice(&bytes[20..20 + json_len]).expect("json");
        let bin_at = 20 + json_len;
        let bin_len = u32::from_le_bytes(bytes[bin_at..bin_at + 4].try_into().expect("length")) as usize;
        (json, bytes[bin_at + 8..bin_at + 8 + bin_len].to_vec())
    }

    /// `bytes` with image `image` replaced by `png` (appended to the binary chunk) and `extras` set.
    fn with_image(bytes: &[u8], image: usize, png: &[u8], extras: Option<serde_json::Value>) -> Vec<u8> {
        let (mut json, mut bin) = split(bytes);
        while !bin.len().is_multiple_of(4) {
            bin.push(0);
        }
        let views = json["bufferViews"].as_array_mut().expect("views");
        views.push(serde_json::json!({ "buffer": 0, "byteOffset": bin.len(), "byteLength": png.len() }));
        let view = views.len() - 1;
        bin.extend(png);
        while !bin.len().is_multiple_of(4) {
            bin.push(0);
        }
        json["images"][image] = serde_json::json!({ "bufferView": view, "mimeType": "image/png" });
        json["buffers"][0]["byteLength"] = serde_json::json!(bin.len());
        if let Some(extras) = extras {
            json["asset"]["extras"] = extras;
        }
        glb(&json, &bin)
    }

    /// A folder of its own under the system's temporary folder holding `files`.
    fn folder(label: &str, files: &[(&str, Vec<u8>)]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("genex-present-{label}-{}", std::process::id()));
        for (name, bytes) in files {
            let path = dir.join(name);
            std::fs::create_dir_all(path.parent().expect("a folder")).expect("folder");
            std::fs::write(&path, bytes).expect("written");
        }
        dir
    }

    fn presenter(root: &Path) -> Option<Presenter> {
        let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
        match Presenter::open_with_root(WORLD, &[], Some(root.to_owned())) {
            Ok(presenter) => Some(presenter),
            Err(error) if require => panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}"),
            Err(_) => None,
        }
    }

    /// A game drawing `file` at the origin turned by `turn` about y, seen from +z under a sun from
    /// the upper right.
    fn runtime(file: &'static str, turn: f32) -> Runtime<World> {
        let mut game = Game::new(World::default()).title("Sidecars").world_size(WORLD[0], WORLD[1]);
        game.camera(|_| Camera::look_at(vec3(0.0, 0.0, 3.0), Vec3::ZERO));
        game.on_reset(move |sim, _, _, gfx| sim.world.model = gfx.assets().model(file));
        game.on_draw(move |sim, frame, _| {
            frame.sun(vec3(0.6, 0.5, 1.0), Color::WHITE, 3.0);
            frame.model(&sim.world.model, Transform::IDENTITY.with_rotation(Quat::from_rotation_y(turn)));
        });
        let mut runtime = Runtime::new(game).expect("valid registrations");
        runtime.seed(1);
        runtime.start();
        runtime.step(FIXED_STEP_MS);
        runtime
    }

    /// The settled capture of `runtime` as BGRA, and its `__render` value.
    fn capture(presenter: &mut Presenter, runtime: &mut Runtime<World>, name: &str) -> (Vec<u8>, serde_json::Value) {
        presenter.set_capturing(true);
        for _ in 0..4 {
            presenter.draw_view(runtime, View::Game).expect("game view").expect("drawn");
        }
        assert_eq!(presenter.failure(), None);
        let bgra = presenter.resilient.capture().expect("capture").bgra().to_vec();
        if let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") {
            let rgba: Vec<u8> = bgra.as_chunks::<4>().0.iter().flat_map(|p| [p[2], p[1], p[0], p[3]]).collect();
            let _ = std::fs::create_dir_all(&dir);
            std::fs::write(Path::new(&dir).join(format!("{name}.png")), png(WORLD[0], WORLD[1], &rgba)).expect("evidence");
        }
        let render = runtime.state()["__render"].clone();
        (bgra, render)
    }

    /// The share of pixels of two BGRA captures differing by more than `step` in a channel.
    fn share_past(a: &[u8], b: &[u8], step: u8) -> f64 {
        let past = a.as_chunks::<4>().0.iter().zip(b.as_chunks::<4>().0).filter(|(p, q)| (0..3).any(|c| p[c].abs_diff(q[c]) > step)).count();
        past as f64 / (a.len() / 4) as f64
    }

    /// The mean and largest per-channel difference of two BGRA captures (alpha ignored).
    fn difference(a: &[u8], b: &[u8]) -> (f64, u8) {
        let channels = a.as_chunks::<4>().0.iter().zip(b.as_chunks::<4>().0).flat_map(|(p, q)| (0..3).map(move |c| p[c].abs_diff(q[c])));
        let (sum, largest, count) = channels.fold((0u64, 0u8, 0u64), |(sum, largest, count), d| (sum + u64::from(d), largest.max(d), count + 1));
        (sum as f64 / count as f64, largest)
    }

    /// The held texture bytes and the array bytes of the presenter's renderer.
    fn texture_bytes(presenter: &Presenter) -> (u64, u64) {
        let renderer = presenter.resilient.renderer().renderer();
        (renderer.texture_held_bytes(), renderer.texture_bytes())
    }

    /// The C-13 step's output (`GENEX_C13_CRATE`): `imported/props/crate.glb` with its sidecars
    /// (`crate.t<image>.<family>.ktx2`, 512 x 512 base colour, normal and ORM maps, from the pinned
    /// Basis encoder) and `plain/props/crate.glb`, the same GLB before the step. Not committed: the
    /// importer writes it with `glb-textures.ts` (`addGlbTextures`).
    #[test]
    #[ignore = "needs a GPU and GENEX_C13_CRATE: run with --ignored metal"]
    fn metal_the_c13_crate_uploads_bc_for_every_image_and_draws_as_its_images_within_bc_error() {
        let Some(crate_dir) = std::env::var_os("GENEX_C13_CRATE").map(PathBuf::from) else {
            eprintln!("skipped: GENEX_C13_CRATE names no folder");
            return;
        };
        let Some(mut bc_presenter) = presenter(&crate_dir.join("imported")) else { return };
        let (bc, bc_render) = capture(&mut bc_presenter, &mut runtime("props/crate.glb", 0.0), "c14-crate-bc");
        let bc_bytes = texture_bytes(&bc_presenter);
        let mut source_presenter = presenter(&crate_dir.join("plain")).expect("a second presenter");
        let (source, source_render) = capture(&mut source_presenter, &mut runtime("props/crate.glb", 0.0), "c14-crate-source");
        let source_bytes = texture_bytes(&source_presenter);
        eprintln!("c14 crate: bc {bc_render}");
        eprintln!("c14 crate: source {source_render}");
        for image in 0..3 {
            let key = format!("props/crate.glb#{image}");
            assert_eq!(bc_render["textures"][&key]["family"], "bc", "{key}: {bc_render}");
            assert_eq!(source_render["textures"][&key]["family"], "source", "{key}: {source_render}");
        }
        assert_eq!(bc_render.get("assetIssues"), None, "{bc_render}");
        assert_eq!(source_render["assetIssues"].as_array().map(Vec::len), Some(3), "each image uncompressed: {source_render}");
        let (held, arrays) = (source_bytes.0 as f64 / bc_bytes.0 as f64, source_bytes.1 as f64 / bc_bytes.1 as f64);
        let (mean, largest) = difference(&bc, &source);
        let edges = share_past(&bc, &source, BC_EDGE_STEP);
        eprintln!(
            "c14 crate: held {} -> {} bytes ({held:.2}x), arrays {} -> {} bytes ({arrays:.2}x); BC against images: mean {mean:.3}, largest {largest}, {:.2}% of pixels past {BC_EDGE_STEP}",
            source_bytes.0,
            bc_bytes.0,
            source_bytes.1,
            bc_bytes.1,
            edges * 100.0
        );
        assert!(held >= 3.5, "the images take {held:.2}x fewer bytes from their sidecars (at least 3.5x)");
        assert!(mean > 0.0, "the two draws took different texels");
        assert!(mean <= BC_MEAN_MAX && edges <= BC_EDGE_SHARE_MAX, "mean {mean:.3}, {:.2}% past {BC_EDGE_STEP}", edges * 100.0);
    }

    /// A tangent-space normal map whose bumps run along u (stripes of tilted normals), so the
    /// tangent's direction and sign show in the shading.
    fn bumpy_normal_map() -> Vec<u8> {
        let mut rgba = Vec::with_capacity((SIDE * SIDE * 4) as usize);
        for _y in 0..SIDE {
            for x in 0..SIDE {
                let tilt: f32 = if (x / 8) % 2 == 0 { 0.6 } else { -0.6 };
                let z = (1.0 - tilt * tilt).sqrt();
                let byte = |v: f32| ((v * 0.5 + 0.5) * 255.0).round() as u8;
                rgba.extend([byte(tilt), byte(0.0), byte(z), 255]);
            }
        }
        png(SIDE, SIDE, &rgba)
    }

    #[test]
    #[ignore = "needs a GPU: run with --ignored metal"]
    fn metal_runtime_tangents_shade_a_mirrored_bumpy_normal_map_as_the_import_step_s_do() {
        let bumps = bumpy_normal_map();
        let unimported = with_image(&import_fixture("tangents-mirrored.glb"), 0, &bumps, None);
        let imported = with_image(&import_fixture("tangents-mirrored.imported.glb"), 0, &bumps, None);
        let root = folder("tangents", &[("unimported.glb", unimported), ("imported.glb", imported)]);
        let Some(mut presenter) = presenter(&root) else { return };
        let mut problems = Vec::new();
        // Four turns, so both mirror seams and the islands between them face the camera.
        for (label, turn) in [("turn-0", 0.0), ("turn-90", FRAC_PI_2), ("turn-180", PI), ("turn-270", 3.0 * FRAC_PI_2)] {
            let (runtime_shaded, render) = capture(&mut presenter, &mut runtime("unimported.glb", turn), &format!("c9-{label}-runtime"));
            let (import_shaded, _) = capture(&mut presenter, &mut runtime("imported.glb", turn), &format!("c9-{label}-imported"));
            let (mean, largest) = difference(&runtime_shaded, &import_shaded);
            let past = share_past(&runtime_shaded, &import_shaded, TANGENT_STEP);
            eprintln!("c9 {label}: runtime tangents against the import step's: mean {mean:.4}, largest {largest}, {:.3}% of pixels past {TANGENT_STEP}; issues {}", past * 100.0, render["assetIssues"]);
            if mean > TANGENT_MEAN_MAX || past > TANGENT_SHARE_MAX {
                problems.push(format!("{label}: mean {mean:.4}, largest {largest}, {:.3}% past {TANGENT_STEP}", past * 100.0));
            }
            let tangents_runtime = serde_json::json!({ "path": "unimported.glb", "code": "tangents-runtime" });
            if !render["assetIssues"].as_array().is_some_and(|issues| issues.contains(&tangents_runtime)) {
                problems.push(format!("{label}: no tangents-runtime issue: {render}"));
            }
        }
        let _ = std::fs::remove_dir_all(&root);
        assert!(problems.is_empty(), "{problems:#?}");
    }
}
