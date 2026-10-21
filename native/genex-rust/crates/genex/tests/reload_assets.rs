//! Swapping a changed asset into a running dev game (game systems C-18, the `reloadAssets` verb):
//! [`AssetCache::invalidate`] forgets what was loaded from the named paths (a texture also when
//! one of its family files changed, a model also when a family file beside it changed, an
//! environment map) and hands back the dropped models, so their meshes leave the renderer; the next
//! load reads them again. [`Presenter::reload_assets`] checks each file's digest against the bytes
//! the game's source serves now first (a mismatch or a missing file is refused and leaves the
//! cache as it was), and its pending count is 0 once a frame loaded what it dropped.
//!
//! The GPU rows are `#[ignore]`d and their names contain `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex \
//!     --test reload_assets -- --ignored metal

use std::cell::RefCell;

use genex::present::{AssetCache, ModelSource, Uploads};
use genex::glam::Vec3;
use genex::render::Environment;
use genex::{Color, Frame, Material, Transform};
use genex_render::mesh::MeshData;
use genex_render::scene::MeshId;
use genex_render::texture::{TextureData, TextureId, TextureKind};
use genex_render::{RenderCode, RenderError};

const BARK: &str = "textures/bark.png";
const MOSS: &str = "textures/moss.png";

/// A stored-deflate PNG of `width` x `height` pixels of one `rgba`.
fn png(width: u32, height: u32, rgba: [u8; 4]) -> Vec<u8> {
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
    let row: Vec<u8> = std::iter::once(0).chain(rgba.repeat(width as usize)).collect();
    let raw = row.repeat(height as usize);
    let (mut a, mut b) = (1u32, 0u32);
    for byte in &raw {
        a = (a + u32::from(*byte)) % 65_521;
        b = (b + a) % 65_521;
    }
    let mut zlib = vec![0x78, 0x01, 1];
    zlib.extend((raw.len() as u16).to_le_bytes());
    zlib.extend((!(raw.len() as u16)).to_le_bytes());
    zlib.extend(&raw);
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

/// A game's files by path, changeable between loads, and every path read.
#[derive(Default)]
struct Files {
    files: RefCell<Vec<(String, Vec<u8>)>>,
    read: RefCell<Vec<String>>,
}

impl Files {
    fn with(files: &[(&str, Vec<u8>)]) -> Files {
        let files = files.iter().map(|(path, bytes)| ((*path).to_owned(), bytes.clone())).collect();
        Files { files: RefCell::new(files), read: RefCell::new(Vec::new()) }
    }

    fn write(&self, path: &str, bytes: Vec<u8>) {
        let mut files = self.files.borrow_mut();
        match files.iter_mut().find(|(known, _)| known == path) {
            Some(entry) => entry.1 = bytes,
            None => files.push((path.to_owned(), bytes)),
        }
    }

    fn reads_of(&self, path: &str) -> usize {
        self.read.borrow().iter().filter(|read| *read == path).count()
    }
}

impl ModelSource for Files {
    fn model_bytes(&self, path: &str) -> Option<Vec<u8>> {
        self.read.borrow_mut().push(path.to_owned());
        self.files.borrow().iter().find(|(known, _)| known == path).map(|(_, bytes)| bytes.clone())
    }

    fn has_asset(&self, path: &str) -> bool {
        self.files.borrow().iter().any(|(known, _)| known == path)
    }
}

/// A renderer stand-in that numbers every upload and records every removal.
#[derive(Default)]
struct Recording {
    textures: u32,
    meshes: u32,
    uploads: Vec<String>,
    removed: Vec<MeshId>,
}

impl Uploads for Recording {
    fn add_mesh(&mut self, _mesh: MeshData) -> Result<MeshId, RenderError> {
        self.meshes += 1;
        Ok(MeshId::from_raw(self.meshes))
    }

    fn add_texture(&mut self, data: &TextureData, kind: TextureKind) -> Result<TextureId, RenderError> {
        self.textures += 1;
        self.uploads.push(format!("{kind:?} {}x{}", data.width(), data.height()));
        Ok(TextureId::new(kind, self.textures))
    }

    fn remove_mesh(&mut self, id: MeshId) -> Result<(), RenderError> {
        self.removed.push(id);
        Ok(())
    }
}

/// A frame drawing a cube with `base` as its base colour and a sphere with `MOSS`.
fn drawing(base: &str) -> Frame {
    let mut frame = Frame::default();
    frame.cube_with(Transform::IDENTITY, &Material::color(Color::WHITE).with_base_texture(base));
    frame.sphere_with(Vec3::ZERO, 1.0, &Material::color(Color::WHITE).with_base_texture(MOSS));
    frame
}

fn load(cache: &mut AssetCache, frame: &Frame, files: &Files, uploads: &mut Recording) {
    cache.load(frame, files, uploads, &mut |line| panic!("no refusal expected: {line}")).expect("no device loss");
}

#[test]
fn today_a_changed_texture_is_never_read_again() {
    // Characterization of the cache's rule (each path is tried once): what `reloadAssets` changes.
    let files = Files::with(&[(BARK, png(2, 2, [255, 0, 0, 255])), (MOSS, png(2, 2, [0, 255, 0, 255]))]);
    let (mut cache, mut uploads) = (AssetCache::default(), Recording::default());
    load(&mut cache, &drawing(BARK), &files, &mut uploads);
    files.write(BARK, png(4, 4, [0, 0, 255, 255]));
    load(&mut cache, &drawing(BARK), &files, &mut uploads);
    assert_eq!(files.reads_of(BARK), 1, "the cache never retries a path it tried");
}

#[test]
fn an_invalidated_texture_is_read_again_and_its_new_bytes_uploaded_while_the_others_stay() {
    let files = Files::with(&[(BARK, png(2, 2, [255, 0, 0, 255])), (MOSS, png(2, 2, [0, 255, 0, 255]))]);
    let (mut cache, mut uploads) = (AssetCache::default(), Recording::default());
    load(&mut cache, &drawing(BARK), &files, &mut uploads);
    let before = cache.texture(BARK, TextureKind::Color).expect("loaded");
    files.write(BARK, png(4, 4, [0, 0, 255, 255]));
    let dropped = cache.invalidate(&[BARK]);
    assert!(dropped.models.is_empty(), "no model was loaded from it");
    assert_eq!(cache.texture(BARK, TextureKind::Color), None, "forgotten until the next load");
    load(&mut cache, &drawing(BARK), &files, &mut uploads);
    let after = cache.texture(BARK, TextureKind::Color).expect("loaded again");
    assert_ne!(after, before, "a new upload");
    assert_eq!(uploads.uploads.last().map(String::as_str), Some("Color 4x4"), "the new bytes: {:?}", uploads.uploads);
    assert_eq!(files.reads_of(BARK), 2);
    assert_eq!(files.reads_of(MOSS), 1, "an untouched texture is not read again");
}

#[test]
fn a_changed_family_file_invalidates_its_texture() {
    let files = Files::with(&[(BARK, png(2, 2, [255, 0, 0, 255])), (MOSS, png(2, 2, [0, 255, 0, 255]))]);
    let (mut cache, mut uploads) = (AssetCache::default(), Recording::default());
    load(&mut cache, &drawing(BARK), &files, &mut uploads);
    cache.invalidate(&["textures/bark.bc.ktx2"]);
    assert_eq!(cache.texture(BARK, TextureKind::Color), None, "its family file changed");
    assert!(cache.texture(MOSS, TextureKind::Color).is_some());
}

#[test]
fn an_invalidated_model_hands_back_its_meshes_and_loads_again() {
    let glb = include_bytes!("../../../../../tests/fixtures/asset-import/tangents-mirrored.imported.glb").to_vec();
    let files = Files::with(&[("props/rock.glb", glb.clone()), (MOSS, png(2, 2, [0, 255, 0, 255]))]);
    let mut frame = Frame::default();
    frame.model(&genex::Assets::default().model("props/rock.glb"), Transform::IDENTITY);
    let (mut cache, mut uploads) = (AssetCache::default(), Recording::default());
    load(&mut cache, &frame, &files, &mut uploads);
    let meshes: Vec<MeshId> = cache.model("props/rock.glb").expect("loaded").parts.iter().map(|part| part.mesh).collect();
    let dropped = cache.invalidate(&["props/rock.glb"]);
    let handed: Vec<MeshId> = dropped.models.iter().flat_map(|model| model.parts.iter().map(|part| part.mesh)).collect();
    assert_eq!(handed, meshes, "the dropped model's meshes, for the renderer to free");
    assert!(!cache.tried("props/rock.glb"));
    load(&mut cache, &frame, &files, &mut uploads);
    assert!(cache.model("props/rock.glb").is_some(), "loaded again");
    // A family file beside a model may be one of its image sidecars: the model is read again.
    let dropped = cache.invalidate(&["props/rock.t0.bc.ktx2"]);
    assert_eq!(dropped.models.len(), 1);
    // A path the cache never loaded changes nothing.
    let dropped = cache.invalidate(&["props/other.glb", "textures/never.png"]);
    assert!(dropped.models.is_empty() && !dropped.environment);
    assert!(!cache.tried("props/rock.glb"), "still dropped from the sidecar change");
}

#[test]
fn an_invalidated_environment_map_is_named_so_the_presenter_uploads_it_again() {
    let mut frame = Frame::default();
    frame.environment(Environment::hdri("env/sky.hdr"));
    let files = Files::default();
    let (mut cache, mut uploads) = (AssetCache::default(), Recording::default());
    // The map is missing: refused (logged), which still records it as tried.
    cache.load(&frame, &files, &mut uploads, &mut |_| {}).expect("no device loss");
    assert!(cache.invalidate(&["env/sky.hdr"]).environment, "it was tried, so it is dropped");
    assert!(!cache.invalidate(&["env/sky.hdr"]).environment, "already dropped");
}

#[test]
fn a_refused_texture_is_also_tried_again_after_a_reload_names_it() {
    // A file that was not there yet (the studio's first import) is refused once; after the
    // reload it loads.
    let files = Files::with(&[(MOSS, png(2, 2, [0, 255, 0, 255]))]);
    let (mut cache, mut uploads) = (AssetCache::default(), Recording::default());
    cache.load(&drawing(BARK), &files, &mut uploads, &mut |_| {}).expect("no device loss");
    assert_eq!(cache.texture(BARK, TextureKind::Color), None);
    files.write(BARK, png(2, 2, [255, 0, 0, 255]));
    cache.invalidate(&[BARK]);
    load(&mut cache, &drawing(BARK), &files, &mut uploads);
    assert!(cache.texture(BARK, TextureKind::Color).is_some());
}

/// A lost device stops the load; what was dropped stays dropped and is read on the next load.
#[test]
fn a_device_lost_during_the_reload_leaves_the_path_to_be_tried_again() {
    struct Lost;
    impl Uploads for Lost {
        fn add_mesh(&mut self, _mesh: MeshData) -> Result<MeshId, RenderError> {
            Err(RenderError::refused(RenderCode::DeviceLost, "lost"))
        }
        fn add_texture(&mut self, _data: &TextureData, _kind: TextureKind) -> Result<TextureId, RenderError> {
            Err(RenderError::refused(RenderCode::DeviceLost, "lost"))
        }
    }
    let files = Files::with(&[(BARK, png(2, 2, [255, 0, 0, 255])), (MOSS, png(2, 2, [0, 255, 0, 255]))]);
    let (mut cache, mut uploads) = (AssetCache::default(), Recording::default());
    load(&mut cache, &drawing(BARK), &files, &mut uploads);
    cache.invalidate(&[BARK]);
    let lost = cache.load(&drawing(BARK), &files, &mut Lost, &mut |_| {});
    assert_eq!(lost.map_err(|error| error.code()), Err(RenderCode::DeviceLost));
    assert_eq!(cache.texture(BARK, TextureKind::Color), None);
    load(&mut cache, &drawing(BARK), &files, &mut uploads);
    assert!(cache.texture(BARK, TextureKind::Color).is_some());
}

mod presenter {
    use std::path::{Path, PathBuf};

    use genex::present::{Presenter, ReloadMiss};
    use genex::prelude::*;
    use genex::{FIXED_STEP_MS, Runtime, View};
    use genex_core::digest::fnv1a64;

    use super::{BARK, png};

    const WORLD: [u32; 2] = [96, 64];

    #[derive(Default)]
    struct World;

    /// A folder of its own under the system's temporary folder holding `files`.
    fn folder(label: &str, files: &[(&str, Vec<u8>)]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("genex-reload-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        for (name, bytes) in files {
            write(&dir, name, bytes);
        }
        dir
    }

    fn write(dir: &Path, name: &str, bytes: &[u8]) {
        let path = dir.join(name);
        std::fs::create_dir_all(path.parent().expect("a folder")).expect("folder");
        std::fs::write(&path, bytes).expect("written");
    }

    fn presenter(root: &Path) -> Option<Presenter> {
        let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
        match Presenter::open_with_root(WORLD, &[], Some(root.to_owned())) {
            Ok(presenter) => Some(presenter),
            Err(error) if require => panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}"),
            Err(_) => None,
        }
    }

    /// A game drawing a cube textured with [`BARK`] that fills the view.
    fn runtime() -> Runtime<World> {
        let mut game = Game::new(World).title("Reload").world_size(WORLD[0], WORLD[1]);
        game.camera(|_| Camera::look_at(vec3(0.0, 0.0, 1.6), Vec3::ZERO));
        game.on_draw(|_, frame, _| {
            frame.sun(vec3(0.2, 0.3, 1.0), Color::WHITE, 3.0);
            frame.cube_with(Transform::IDENTITY, &Material::color(Color::WHITE).with_base_texture(BARK));
        });
        let mut runtime = Runtime::new(game).expect("valid registrations");
        runtime.seed(1);
        runtime.start();
        runtime.step(FIXED_STEP_MS);
        runtime
    }

    /// One settled capture of `runtime`, as BGRA (written as a PNG under
    /// `GENEX_RENDER_EVIDENCE_DIR` when set).
    fn capture(presenter: &mut Presenter, runtime: &mut Runtime<World>, name: &str) -> Vec<u8> {
        presenter.set_capturing(true);
        presenter.draw_view(runtime, View::Game).expect("game view").expect("drawn");
        presenter.set_capturing(false);
        let bgra = presenter.resilient.capture().expect("capture").bgra().to_vec();
        if let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") {
            let rgba: Vec<u8> = bgra.as_chunks::<4>().0.iter().flat_map(|p| [p[2], p[1], p[0], p[3]]).collect();
            let _ = std::fs::create_dir_all(&dir);
            std::fs::write(Path::new(&dir).join(format!("{name}.rgba")), &rgba).expect("evidence");
        }
        bgra
    }

    /// The centre pixel of a BGRA capture, as RGB.
    fn centre(bgra: &[u8]) -> [u8; 3] {
        let at = ((WORLD[1] / 2 * WORLD[0] + WORLD[0] / 2) * 4) as usize;
        [bgra[at + 2], bgra[at + 1], bgra[at]]
    }

    #[test]
    #[ignore = "needs a GPU: run with --ignored metal"]
    fn metal_replacing_bark_and_reloading_changes_the_next_capture_to_the_new_bytes_only() {
        let red = png(8, 8, [220, 30, 30, 255]);
        let blue = png(8, 8, [30, 30, 220, 255]);
        let root = folder("bark", &[(BARK, red.clone())]);
        let Some(mut presenter) = presenter(&root) else { return };
        let mut game = runtime();
        let before = capture(&mut presenter, &mut game, "c18-before-red");
        let [r, _, b] = centre(&before);
        assert!(r > b, "red bark first: {:?}", centre(&before));
        write(&root, BARK, &blue);
        // Today's rule, without the verb: the next capture still shows the old bytes.
        let unchanged = capture(&mut presenter, &mut game, "c18-without-reload");
        assert_eq!(unchanged, before, "the cache never retries");
        // A stale digest is refused and changes nothing.
        let stale = presenter.reload_assets(&[(BARK, fnv1a64(&red))]);
        assert_eq!(stale, [Err(ReloadMiss::DigestMismatch)]);
        assert_eq!(presenter.reload_pending(), 0);
        let missing = presenter.reload_assets(&[("textures/none.png", 1)]);
        assert_eq!(missing, [Err(ReloadMiss::Missing)]);
        let swapped = presenter.reload_assets(&[(BARK, fnv1a64(&blue))]);
        assert_eq!(swapped, [Ok(())]);
        assert_eq!(presenter.reload_pending(), 1, "dropped, not loaded yet");
        let after = capture(&mut presenter, &mut game, "c18-after-blue");
        assert_eq!(presenter.reload_pending(), 0, "the capture's frame loaded it");
        let [r, _, b] = centre(&after);
        assert!(b > r, "the new bytes: {:?}", centre(&after));
        // Not a mix: the capture equals a fresh presenter's on the new bytes.
        let fresh_root = folder("bark-fresh", &[(BARK, blue)]);
        let mut fresh = presenter_of(&fresh_root);
        let fresh_shot = capture(&mut fresh, &mut runtime(), "c18-fresh-blue");
        assert_eq!(after, fresh_shot, "the reloaded capture is the fresh one");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&fresh_root);
    }

    fn presenter_of(root: &Path) -> Presenter {
        presenter(root).expect("a second presenter")
    }
}
