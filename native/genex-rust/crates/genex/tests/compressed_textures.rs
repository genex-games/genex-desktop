//! Compressed textures through the asset cache (renderer pass 2, A6.4): when a game ships a
//! texture's file in a family the device samples (`<stem>.<family>.ktx2`, written by the Studio's
//! import step beside the image), the renderer's larger textures are stored in that family and the
//! file loads instead of the image; a texture without one, a file the renderer refuses and a game
//! without any keep loading their images. The family is chosen once, at the first frame naming a
//! texture, before anything is uploaded.

use std::cell::RefCell;

use genex::present::{AssetCache, ModelSource, Uploads};
use genex::prelude::*;
use genex::{Frame, Transform};
use genex_render::device_loss::CompressedSource;
use genex_render::mesh::MeshData;
use genex_render::scene::MeshId;
use genex_render::texture::{CompressedTexture, TextureData, TextureFamily, TextureId, TextureKind};
use genex_render::{RenderCode, RenderError};

const ROCK: &str = "textures/rock.png";
const ROCK_BC: &str = "textures/rock.bc.ktx2";
const ROCK_ASTC: &str = "textures/rock.astc.ktx2";
const MOSS: &str = "textures/moss.png";

/// A file the Studio's import step wrote (BC7 family, `tests/conformance/rust-assets-ktx2.test.ts`).
fn bc_file() -> Vec<u8> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../tests/fixtures/asset-import/basis-uastc-64.bc.ktx2");
    std::fs::read(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

/// A 1x1 RGBA PNG (stored deflate block, no compression).
fn png() -> Vec<u8> {
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
    let raw = [0u8, 200, 180, 160, 255];
    let (mut a, mut b) = (1u32, 0u32);
    for byte in &raw {
        a = (a + u32::from(*byte)) % 65_521;
        b = (b + a) % 65_521;
    }
    let mut zlib = vec![0x78, 0x01, 0x01];
    zlib.extend((raw.len() as u16).to_le_bytes());
    zlib.extend((!(raw.len() as u16)).to_le_bytes());
    zlib.extend(raw);
    zlib.extend(((b << 16) | a).to_be_bytes());
    let mut out = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    let mut header = Vec::new();
    header.extend(1u32.to_be_bytes());
    header.extend(1u32.to_be_bytes());
    header.extend([8, 6, 0, 0, 0]);
    chunk(&mut out, b"IHDR", &header);
    chunk(&mut out, b"IDAT", &zlib);
    chunk(&mut out, b"IEND", &[]);
    out
}

/// A game's files by path.
struct Files(Vec<(&'static str, Vec<u8>)>);

impl ModelSource for Files {
    fn model_bytes(&self, path: &str) -> Option<Vec<u8>> {
        self.0.iter().find(|(known, _)| *known == path).map(|(_, bytes)| bytes.clone())
    }
}

/// What reached the renderer: the family set, each upload (an image or a compressed file) and
/// every path read.
struct Recording {
    families: Vec<TextureFamily>,
    family: TextureFamily,
    refuse_compressed: bool,
    calls: RefCell<Vec<String>>,
}

impl Recording {
    fn offering(families: &[TextureFamily]) -> Recording {
        Recording { families: families.to_vec(), family: TextureFamily::Rgba8, refuse_compressed: false, calls: RefCell::new(Vec::new()) }
    }
}

impl Uploads for Recording {
    fn add_mesh(&mut self, _mesh: MeshData) -> Result<MeshId, RenderError> {
        Ok(MeshId::from_raw(10))
    }

    fn add_texture(&mut self, data: &TextureData, kind: TextureKind) -> Result<TextureId, RenderError> {
        self.calls.borrow_mut().push(format!("image {}x{}", data.width(), data.height()));
        Ok(TextureId::new(kind, 0))
    }

    fn compressed_families(&self) -> Vec<TextureFamily> {
        self.families.clone()
    }

    fn texture_family(&self) -> TextureFamily {
        self.family
    }

    fn set_texture_family(&mut self, family: TextureFamily) -> Result<(), RenderError> {
        self.calls.borrow_mut().push(format!("family {}", family.wire()));
        self.family = family;
        Ok(())
    }

    fn add_compressed_texture(&mut self, texture: &CompressedTexture, kind: TextureKind, source: Option<CompressedSource>) -> Result<TextureId, RenderError> {
        if self.refuse_compressed {
            return Err(RenderError::refused(RenderCode::TextureInvalid, "under the family's smallest class"));
        }
        assert!(source.is_none(), "a file read from disk keeps its upload");
        self.calls.borrow_mut().push(format!("{} {}", texture.family().wire(), texture.side()));
        Ok(TextureId::new(kind, 1))
    }
}

/// A frame drawing a cube textured by `ROCK` and one by `MOSS`.
fn frame() -> Frame {
    let mut frame = Frame::default();
    frame.cube_with(Transform::IDENTITY, &Material::color(Color::WHITE).with_base_texture(ROCK));
    frame.cube_with(Transform::from_xyz(2.0, 0.0, 0.0), &Material::color(Color::WHITE).with_base_texture(MOSS));
    frame
}

/// Load `frame` twice (a second frame changes nothing) and answer the uploads and the log.
fn load(files: Files, mut uploads: Recording) -> (Vec<String>, Vec<String>, AssetCache) {
    let mut cache = AssetCache::default();
    let mut log = Vec::new();
    for _ in 0..2 {
        cache.load(&frame(), &files, &mut uploads, &mut |line| log.push(line.to_owned())).expect("no device loss");
    }
    (uploads.calls.into_inner(), log, cache)
}

#[test]
fn a_shipped_family_file_loads_instead_of_its_image_and_other_textures_load_their_images() {
    let files = Files(vec![(ROCK, png()), (ROCK_BC, bc_file()), (MOSS, png())]);
    let (calls, log, cache) = load(files, Recording::offering(&[TextureFamily::Bc7, TextureFamily::Astc4x4]));
    assert_eq!(calls, ["family bc", "bc 64", "image 1x1"], "{log:?}");
    assert!(log.is_empty(), "{log:?}");
    assert_eq!(cache.texture(ROCK, TextureKind::Color).map(|id| id.layer()), Some(1), "the compressed upload");
    assert!(cache.texture(MOSS, TextureKind::Color).is_some());
}

#[test]
fn the_family_is_the_devices_best_one_the_game_ships_and_none_without_files() {
    // The device prefers ASTC (a phone) and the game ships both: ASTC is read... but this ASTC
    // file is not a KTX2, so the image loads, logged.
    let files = Files(vec![(ROCK, png()), (ROCK_BC, bc_file()), (ROCK_ASTC, b"not a ktx2".to_vec()), (MOSS, png())]);
    let (calls, log, _) = load(files, Recording::offering(&[TextureFamily::Astc4x4, TextureFamily::Bc7]));
    assert_eq!(calls, ["family astc", "image 1x1", "image 1x1"]);
    assert!(log.len() == 1 && log[0].contains(ROCK_ASTC), "{log:?}");
    // A device without a family the game ships, and a game without files: RGBA8, nothing set.
    let (calls, _, _) = load(Files(vec![(ROCK, png()), (ROCK_BC, bc_file()), (MOSS, png())]), Recording::offering(&[TextureFamily::Etc2Rgba8]));
    assert_eq!(calls, ["image 1x1", "image 1x1"]);
    let (calls, _, _) = load(Files(vec![(ROCK, png()), (MOSS, png())]), Recording::offering(&[TextureFamily::Bc7]));
    assert_eq!(calls, ["image 1x1", "image 1x1"]);
}

#[test]
fn a_file_the_renderer_refuses_falls_back_to_its_image() {
    let files = Files(vec![(ROCK, png()), (ROCK_BC, bc_file()), (MOSS, png())]);
    let mut uploads = Recording::offering(&[TextureFamily::Bc7]);
    uploads.refuse_compressed = true;
    let (calls, log, cache) = load(files, uploads);
    assert_eq!(calls, ["family bc", "image 1x1", "image 1x1"]);
    assert!(log.len() == 1 && log[0].contains("under the family's smallest class"), "{log:?}");
    assert!(cache.texture(ROCK, TextureKind::Color).is_some(), "the image stands in");
}

#[test]
fn an_unsafe_texture_path_never_has_its_family_file_read() {
    struct Watched(RefCell<Vec<String>>);
    impl ModelSource for Watched {
        fn model_bytes(&self, path: &str) -> Option<Vec<u8>> {
            self.0.borrow_mut().push(path.to_owned());
            None
        }
    }
    for hostile in ["../escape.png", "/abs/rock.png", "textures\\rock.png", "./rock.png"] {
        let mut frame = Frame::default();
        frame.cube_with(Transform::IDENTITY, &Material::color(Color::WHITE).with_base_texture(hostile));
        let source = Watched(RefCell::new(Vec::new()));
        let mut uploads = Recording::offering(&[TextureFamily::Bc7]);
        AssetCache::default().load(&frame, &source, &mut uploads, &mut |_| {}).expect("no device loss");
        assert!(source.0.borrow().is_empty(), "{hostile}: read {:?}", source.0.borrow());
        assert!(uploads.calls.borrow().is_empty(), "{hostile}: nothing uploaded");
    }
}

// ---------------------------------------------------------------------------------------------
// Lakeside's fetched maps through the presenter (a GPU)

/// Lakeside's PBR materials (`fetched/<name>-{albedo,normal,orm}.jpg`, the showcase's `draw.rs`).
const LAKESIDE_MATERIALS: [&str; 7] = ["bark", "logs", "pine-bark", "planks", "rock", "roof", "stone"];
const LAKE_WORLD: [u32; 2] = [640, 360];

#[derive(Default)]
struct Lake;

/// A row of cubes, one per Lakeside material, at the high preset.
fn lake_runtime() -> genex::Runtime<Lake> {
    use genex::render::{QualityPreset, RenderConfig};
    use genex::{FIXED_STEP_MS, Runtime};
    let mut game = Game::new(Lake).title("Lakeside maps").world_size(LAKE_WORLD[0], LAKE_WORLD[1]);
    game.render_settings(RenderConfig::new().preset(QualityPreset::High));
    game.camera(|_| Camera::look_at(vec3(0.0, 1.5, 7.0), vec3(0.0, 0.0, 0.0)));
    game.on_draw(|_, frame, _| {
        frame.sun(vec3(0.4, 0.8, 0.5), Color::WHITE, 3.0);
        for (at, name) in LAKESIDE_MATERIALS.iter().enumerate() {
            let material = Material::color(Color::WHITE)
                .with_base_texture(&format!("fetched/{name}-albedo.jpg"))
                .with_normal_texture(&format!("fetched/{name}-normal.jpg"), 1.0)
                .with_metal_rough_texture(&format!("fetched/{name}-orm.jpg"));
            frame.cube_with(Transform::from_xyz(at as f32 * 1.4 - 4.2, 0.0, 0.0), &material);
        }
    });
    let mut runtime = Runtime::new(game).expect("valid registrations");
    runtime.seed(5);
    runtime.start();
    runtime.step(5.0 * FIXED_STEP_MS);
    runtime
}

/// `source`'s images (and, with `families`, their family files) copied into a fresh game folder.
fn lake_folder(source: &std::path::Path, families: bool, label: &str) -> std::path::PathBuf {
    let root = std::env::temp_dir().join(format!("genex-lakeside-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("fetched")).expect("game folder");
    for entry in std::fs::read_dir(source.join("fetched")).expect("the maps") {
        let name = entry.expect("entry").file_name().into_string().expect("utf-8");
        if name.ends_with(".jpg") || (families && name.ends_with(".ktx2")) {
            std::fs::copy(source.join("fetched").join(&name), root.join("fetched").join(&name)).expect("copied");
        }
    }
    root
}

#[test]
#[ignore = "needs a GPU and GENEX_LAKESIDE_TEXTURES: run with --ignored metal"]
fn metal_lakesides_maps_load_compressed_at_a_quarter_of_their_bytes() {
    use genex::View;
    use genex::present::Presenter;
    // A folder holding `fetched/<name>-{albedo,normal,orm}.jpg` and their `.bc.ktx2` files (the
    // import step's encoder and transcoder over the fetched cache; not committed).
    let Some(source) = std::env::var_os("GENEX_LAKESIDE_TEXTURES").map(std::path::PathBuf::from) else {
        eprintln!("skipped: GENEX_LAKESIDE_TEXTURES names no folder");
        return;
    };
    let mut rows = Vec::new();
    for (label, families) in [("images", false), ("compressed", true)] {
        let root = lake_folder(&source, families, label);
        let mut presenter = Presenter::open_with_root(LAKE_WORLD, &[], Some(root.clone())).expect("a presenter");
        let mut runtime = lake_runtime();
        presenter.set_capturing(true);
        presenter.draw_view(&mut runtime, View::Game).expect("game view").expect("drawn");
        assert_eq!(presenter.failure(), None);
        let capture = presenter.resilient.capture().expect("capture");
        let renderer = presenter.resilient.renderer().renderer();
        let row = (label, renderer.texture_family(), renderer.texture_held_bytes(), renderer.texture_bytes());
        eprintln!("{label}: family {:?}, held {} bytes, arrays {} bytes", row.1, row.2, row.3);
        if let Some(dir) = std::env::var_os("GENEX_RENDER_EVIDENCE_DIR") {
            let dir = std::path::PathBuf::from(dir);
            std::fs::create_dir_all(&dir).expect("evidence folder");
            std::fs::write(dir.join(format!("lakeside-maps-{label}-{}x{}.bgra", capture.width(), capture.height())), capture.bgra()).expect("written");
        }
        rows.push(row);
        let _ = std::fs::remove_dir_all(&root);
    }
    let (images, compressed) = (&rows[0], &rows[1]);
    assert_eq!(images.1, TextureFamily::Rgba8, "no family file: images");
    assert_ne!(compressed.1, TextureFamily::Rgba8, "the device's best family the game ships");
    let ratio = images.2 as f64 / compressed.2 as f64;
    eprintln!("Lakeside's maps: {ratio:.2}x fewer bytes held; arrays {:.2}x", images.3 as f64 / compressed.3 as f64);
    assert!(ratio >= 3.5, "the maps take {ratio:.2}x fewer bytes compressed (at least 3.5x)");
}
