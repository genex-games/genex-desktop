//! Replay from source (renderer pass 2, review F6): the presenter's renderer replays every upload
//! after a device loss and onto a rebuilt renderer (a sample-count change, a capture's profile),
//! and kept a decoded CPU copy of each model and texture for it, so on phones and the web a game's
//! assets were resident twice for the whole session. A model or texture from the game's compiled
//! table (bytes the program holds for its whole life) now keeps only how to decode it again; files
//! read from disk or fetched keep their copy, since they may change.
//!
//! The GPU rows are `#[ignore]`d and named `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex \
//!     --offline --locked --test replay_sources -- --include-ignored

use std::cell::RefCell;
use std::sync::OnceLock;

use genex::prelude::*;
use genex::present::{AssetCache, ModelSource, Presenter, Uploads};
use genex::{FIXED_STEP_MS, Frame, Runtime, Transform, View};
use genex_render::RenderError;
use genex_render::device_loss::{ModelParts, PartsSource, TextureSource};
use genex_render::mesh::MeshData;
use genex_render::scene::MeshId;
use genex_render::texture::{TextureData, TextureId, TextureKind};

const WORLD: [u32; 2] = [96, 64];
const MODEL: &str = "quad.glb";
const TEXTURE: &str = "textures/check.png";

/// A 2x2 RGBA PNG: red, green, blue and white texels.
fn check_png() -> &'static [u8] {
    static PNG: OnceLock<Vec<u8>> = OnceLock::new();
    PNG.get_or_init(|| {
        let mut out = Vec::new();
        let mut encoder = png_encoder(&mut out);
        encoder.extend([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
        encoder.finish();
        out
    })
}

/// A minimal PNG writer for one 2x2 RGBA image (stored deflate blocks, no compression).
struct PngEncoder<'a> {
    out: &'a mut Vec<u8>,
    pixels: Vec<u8>,
}

fn png_encoder(out: &mut Vec<u8>) -> PngEncoder<'_> {
    PngEncoder { out, pixels: Vec::new() }
}

impl PngEncoder<'_> {
    fn extend(&mut self, rgba: [u8; 16]) {
        self.pixels.extend(rgba);
    }

    fn finish(self) {
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
        for row in self.pixels.chunks(8) {
            raw.push(0);
            raw.extend(row);
        }
        let (mut a, mut b) = (1u32, 0u32);
        for byte in &raw {
            a = (a + u32::from(*byte)) % 65_521;
            b = (b + a) % 65_521;
        }
        let mut zlib = vec![0x78, 0x01, 0x01];
        zlib.extend((raw.len() as u16).to_le_bytes());
        zlib.extend((!(raw.len() as u16)).to_le_bytes());
        zlib.extend(&raw);
        zlib.extend(((b << 16) | a).to_be_bytes());
        self.out.extend([0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]);
        let mut header = Vec::new();
        header.extend(2u32.to_be_bytes());
        header.extend(2u32.to_be_bytes());
        header.extend([8, 6, 0, 0, 0]);
        chunk(self.out, b"IHDR", &header);
        chunk(self.out, b"IDAT", &zlib);
        chunk(self.out, b"IEND", &[]);
    }
}

/// A unit quad with uvs whose material samples an embedded copy of [`check_png`].
fn quad_glb() -> &'static [u8] {
    static GLB: OnceLock<Vec<u8>> = OnceLock::new();
    GLB.get_or_init(|| {
        let positions: [f32; 12] = [-1.0, -1.0, 0.0, 1.0, -1.0, 0.0, 1.0, 1.0, 0.0, -1.0, 1.0, 0.0];
        let normals: [f32; 12] = [0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0];
        let uvs: [f32; 8] = [0.0, 1.0, 1.0, 1.0, 1.0, 0.0, 0.0, 0.0];
        let indices: [u16; 6] = [0, 1, 2, 0, 2, 3];
        let mut bin: Vec<u8> = positions.iter().chain(&normals).chain(&uvs).flat_map(|f| f.to_le_bytes()).collect();
        bin.extend(indices.iter().flat_map(|i| i.to_le_bytes()));
        let image_at = bin.len();
        bin.extend(check_png());
        while !bin.len().is_multiple_of(4) {
            bin.push(0);
        }
        let gltf = serde_json::json!({
            "asset": { "version": "2.0" },
            "buffers": [{ "byteLength": bin.len() }],
            "bufferViews": [
                { "buffer": 0, "byteOffset": 0, "byteLength": 48 },
                { "buffer": 0, "byteOffset": 48, "byteLength": 48 },
                { "buffer": 0, "byteOffset": 96, "byteLength": 32 },
                { "buffer": 0, "byteOffset": 128, "byteLength": 12 },
                { "buffer": 0, "byteOffset": image_at, "byteLength": check_png().len() },
            ],
            "accessors": [
                { "bufferView": 0, "componentType": 5126, "count": 4, "type": "VEC3", "min": [-1.0, -1.0, 0.0], "max": [1.0, 1.0, 0.0] },
                { "bufferView": 1, "componentType": 5126, "count": 4, "type": "VEC3" },
                { "bufferView": 2, "componentType": 5126, "count": 4, "type": "VEC2" },
                { "bufferView": 3, "componentType": 5123, "count": 6, "type": "SCALAR" },
            ],
            "images": [{ "bufferView": 4, "mimeType": "image/png" }],
            "textures": [{ "source": 0 }],
            "materials": [{ "pbrMetallicRoughness": { "baseColorTexture": { "index": 0 } } }],
            "meshes": [{ "primitives": [{ "attributes": { "POSITION": 0, "NORMAL": 1, "TEXCOORD_0": 2 }, "indices": 3, "material": 0 }] }],
            "nodes": [{ "mesh": 0 }],
            "scenes": [{ "nodes": [0] }],
            "scene": 0,
        });
        let mut json = serde_json::to_vec(&gltf).expect("json");
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
        out.extend(&bin);
        out
    })
}

/// The game's compiled table: the quad and a texture file.
fn compiled() -> genex::AssetTable {
    static TABLE: OnceLock<Vec<(&'static str, &'static [u8])>> = OnceLock::new();
    TABLE.get_or_init(|| vec![(MODEL, quad_glb()), (TEXTURE, check_png())]).as_slice()
}

/// The frame the rows load: the quad (its embedded image) and a cube textured by the file.
fn frame() -> Frame {
    let assets = genex::Assets::default();
    let mut frame = Frame::default();
    frame.model(&assets.model(MODEL), Transform::IDENTITY);
    frame.cube_with(Transform::from_xyz(2.0, 0.0, 0.0), &Material::color(Color::WHITE).with_base_texture(TEXTURE));
    frame
}

/// What reached the uploads: per upload, whether it came with a source, and each source's answer
/// equal to the data uploaded.
#[derive(Default)]
struct Recording {
    sourced: RefCell<Vec<(&'static str, bool)>>,
    next: u32,
}

impl Uploads for Recording {
    fn add_mesh(&mut self, _mesh: MeshData) -> Result<MeshId, RenderError> {
        self.next += 1;
        Ok(MeshId::from_raw(10 + self.next))
    }

    fn add_model_parts(&mut self, parts: ModelParts) -> Result<Vec<MeshId>, RenderError> {
        self.sourced.borrow_mut().push(("meshes", false));
        parts.into_iter().map(|part| self.add_mesh(part.mesh)).collect()
    }

    fn add_texture(&mut self, _data: &TextureData, kind: TextureKind) -> Result<TextureId, RenderError> {
        self.sourced.borrow_mut().push(("texture", false));
        Ok(TextureId::new(kind, 0))
    }

    fn add_meshes_from(&mut self, parts: ModelParts, source: PartsSource) -> Result<Vec<MeshId>, RenderError> {
        let again = source().expect("the source decodes again");
        assert!(again == parts, "the source decodes the parts uploaded");
        self.sourced.borrow_mut().push(("meshes", true));
        parts.into_iter().map(|part| self.add_mesh(part.mesh)).collect()
    }

    fn add_texture_from(&mut self, data: &TextureData, kind: TextureKind, source: TextureSource) -> Result<TextureId, RenderError> {
        assert!(source().expect("the source decodes again") == *data, "the source decodes the texture uploaded");
        self.sourced.borrow_mut().push(("texture", true));
        Ok(TextureId::new(kind, 0))
    }
}

/// The same bytes, from a source that holds them for less than the program's life (a file read
/// from disk, a fetched file).
struct Files;

impl ModelSource for Files {
    fn model_bytes(&self, path: &str) -> Option<Vec<u8>> {
        compiled().iter().find(|(known, _)| *known == path).map(|(_, bytes)| bytes.to_vec())
    }
}

fn load(source: &dyn ModelSource) -> Vec<(&'static str, bool)> {
    let mut uploads = Recording::default();
    let mut cache = AssetCache::default();
    cache.load(&frame(), source, &mut uploads, &mut |line| panic!("nothing is refused: {line}")).expect("no device loss");
    assert!(cache.model(MODEL).is_some() && cache.texture(TEXTURE, TextureKind::Color).is_some());
    uploads.sourced.into_inner()
}

#[test]
fn compiled_assets_upload_with_a_source_that_decodes_them_again_and_files_upload_their_data() {
    assert_eq!(load(&compiled()), [("meshes", true), ("texture", true), ("texture", true)], "the quad, its image and the file: all from source");
    assert_eq!(load(&Files), [("meshes", false), ("texture", false), ("texture", false)], "bytes that may change keep their upload");
}

// ---------------------------------------------------------------------------------------------
// Through the presenter (a GPU)

#[derive(Default)]
struct World;

fn runtime() -> Runtime<World> {
    let mut game = Game::new(World).title("Replay").world_size(WORLD[0], WORLD[1]);
    game.camera(|_| Camera::look_at(vec3(1.0, 0.5, 5.0), vec3(1.0, 0.0, 0.0)));
    game.on_draw(|_, frame, _| {
        let assets = genex::Assets::default();
        frame.sun(vec3(0.3, 0.6, 0.6), Color::WHITE, 3.0).model(&assets.model(MODEL), Transform::IDENTITY);
        frame.cube_with(Transform::from_xyz(2.0, 0.0, 0.0), &Material::color(Color::WHITE).with_base_texture(TEXTURE));
    });
    let mut runtime = Runtime::new(game).expect("valid registrations");
    runtime.seed(3);
    runtime.start();
    runtime.step(10.0 * FIXED_STEP_MS);
    runtime
}

fn capture(presenter: &mut Presenter, runtime: &mut Runtime<World>) -> u64 {
    presenter.set_capturing(true);
    presenter.draw_view(runtime, View::Game).expect("game view").expect("drawn");
    presenter.resilient.capture().expect("capture").digest()
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_compiled_assets_keep_no_cpu_copy_and_a_device_loss_replays_them_from_source() {
    let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
    let mut presenter = match Presenter::open_with_root(WORLD, compiled(), None) {
        Ok(presenter) => presenter,
        Err(error) if require => panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}"),
        Err(_) => return,
    };
    let mut game = runtime();
    let before = capture(&mut presenter, &mut game);
    assert_eq!(presenter.failure(), None);
    let kept = presenter.resilient.kept_bytes();
    assert_eq!(kept, 0, "the compiled model, its image and the texture file keep no decoded copy ({kept} bytes)");
    presenter.resilient.force_device_loss();
    assert!(presenter.recover_for(&mut game).expect("recovers"), "a new device");
    assert_eq!(capture(&mut presenter, &mut game), before, "replayed from source: the same picture");
    assert_eq!(presenter.failure(), None);
}
