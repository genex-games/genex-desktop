//! The runtime's asset loaders: the safe-path rule with a hostile table (links out of the asset
//! folder included), the magenta missing-texture checker, every image format the `image` build
//! reads, glTF from GLB and from `.gltf` with its buffers resolved under the same rule, a
//! compressed glTF answered `needs-import`, and the per-destination texture table held equal to
//! the import step's (`tests/fixtures/asset-import/texture-table.json`).

use genex_assets::model::load_model;
use genex_assets::texture::{
    MISSING_TEXTURE_CHECK_PX, MISSING_TEXTURE_PX, TextureCompression, TextureTarget, compression_for, decode_image,
    destination_textures, load_texture, missing_texture,
};
use genex_assets::{AssetErrorCode, AssetRoot};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

const MAGENTA: [u8; 4] = [255, 0, 255, 255];
const BLACK: [u8; 4] = [0, 0, 0, 255];

fn fixtures(folder: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../tests/fixtures").join(folder)
}

/// A fresh folder under the system temp folder, removed when the guard drops.
struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Scratch {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let n = NEXT.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("genex-assets-test-{}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("scratch folder");
        Scratch(dir)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// `<scratch>/assets` holding the shared samples, and `<scratch>/outside` beside it.
fn game() -> (Scratch, AssetRoot) {
    let scratch = Scratch::new();
    let assets = scratch.0.join("assets");
    fs::create_dir_all(assets.join("sub")).unwrap();
    fs::create_dir_all(scratch.0.join("outside")).unwrap();
    for name in ["animated.glb", "animated.gltf", "animated.bin", "compressed.glb", "broken.glb", "texture.hdr"] {
        fs::copy(fixtures("asset-previews").join(name), assets.join(name)).unwrap();
    }
    fs::write(scratch.0.join("outside/secret.bin"), [7u8; 16]).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        symlink(scratch.0.join("outside/secret.bin"), assets.join("escape.bin")).unwrap();
        symlink(scratch.0.join("outside"), assets.join("out-link")).unwrap();
        symlink(assets.join("texture.hdr"), assets.join("inside-link.hdr")).unwrap();
    }
    let root = AssetRoot::open(&assets).expect("the asset folder opens");
    (scratch, root)
}

#[test]
fn the_safe_path_rule_refuses_every_hostile_name_and_reads_nothing() {
    let (_scratch, root) = game();
    let rows: &[(&str, AssetErrorCode)] = &[
        ("", AssetErrorCode::UnsafePath),
        ("/etc/passwd", AssetErrorCode::UnsafePath),
        ("../outside/secret.bin", AssetErrorCode::UnsafePath),
        ("sub/../../outside/secret.bin", AssetErrorCode::UnsafePath),
        ("a\\b.png", AssetErrorCode::UnsafePath),
        ("con.png", AssetErrorCode::UnsafePath),
        ("x.png.", AssetErrorCode::UnsafePath),
        ("none.png", AssetErrorCode::Missing),
        ("sub", AssetErrorCode::NotAFile),
    ];
    for (rel, code) in rows {
        let error = root.read(rel).expect_err(rel);
        assert_eq!(error.code(), *code, "{rel}: {error}");
    }
    assert!(root.read("texture.hdr").is_ok());
}

#[cfg(unix)]
#[test]
fn a_link_out_of_the_asset_folder_or_at_the_name_itself_is_refused() {
    let (_scratch, root) = game();
    for rel in ["escape.bin", "out-link/secret.bin", "inside-link.hdr"] {
        let error = root.read(rel).expect_err(rel);
        assert_eq!(error.code(), AssetErrorCode::EscapesAssets, "{rel}: {error}");
    }
}

#[test]
fn the_missing_texture_is_the_raylib_runtimes_magenta_checker() {
    let checker = missing_texture();
    assert_eq!((checker.width, checker.height), (MISSING_TEXTURE_PX, MISSING_TEXTURE_PX));
    assert_eq!(checker.rgba.len(), (MISSING_TEXTURE_PX * MISSING_TEXTURE_PX * 4) as usize);
    let pixel = |x: u32, y: u32| {
        let at = ((y * checker.width + x) * 4) as usize;
        [checker.rgba[at], checker.rgba[at + 1], checker.rgba[at + 2], checker.rgba[at + 3]]
    };
    let step = MISSING_TEXTURE_CHECK_PX;
    assert_eq!(pixel(0, 0), MAGENTA);
    assert_eq!(pixel(step, 0), BLACK);
    assert_eq!(pixel(0, step), BLACK);
    assert_eq!(pixel(step, step), MAGENTA);
    assert_eq!(pixel(MISSING_TEXTURE_PX - 1, MISSING_TEXTURE_PX - 1), MAGENTA);
}

#[test]
fn a_texture_that_cannot_load_is_the_checker_with_its_reason() {
    let (_scratch, root) = game();
    for (rel, code) in [
        ("none.png", AssetErrorCode::Missing),
        ("../x.png", AssetErrorCode::UnsafePath),
        ("broken.glb", AssetErrorCode::Malformed),
    ] {
        let (texture, error) = load_texture(&root, rel);
        assert_eq!(texture, missing_texture(), "{rel}");
        assert_eq!(error.map(|e| e.code()), Some(code), "{rel}");
    }
    let (texture, error) = load_texture(&root, "texture.hdr");
    assert!(error.is_none(), "{error:?}");
    assert!(texture.width > 0 && texture.rgba.len() == (texture.width * texture.height * 4) as usize);
}

#[test]
fn every_image_format_the_runtime_keeps_decodes() {
    for name in ["animated.gif", "texture.exr", "texture.hdr", "sample.dds", "sample.qoi"] {
        let bytes = fs::read(fixtures("asset-previews").join(name)).unwrap();
        let texture = decode_image(&bytes).unwrap_or_else(|error| panic!("{name}: {error}"));
        assert!(texture.width > 0 && texture.height > 0, "{name}");
        assert_eq!(texture.rgba.len(), (texture.width * texture.height * 4) as usize, "{name}");
    }
    let error = decode_image(b"not a picture").expect_err("garbage");
    assert_eq!(error.code(), AssetErrorCode::Malformed);
}

#[test]
fn an_uncompressed_dds_reads_its_channels_by_their_masks() {
    // sample.dds: one 32-bit pixel, bytes e6 39 46 ff, red in the low byte by its masks: the
    // colour sample.qoi holds too.
    let bytes = fs::read(fixtures("asset-previews").join("sample.dds")).unwrap();
    let texture = decode_image(&bytes).expect("an uncompressed DDS");
    assert_eq!((texture.width, texture.height), (1, 1));
    assert_eq!(texture.rgba, [0xe6, 0x39, 0x46, 0xff]);
    let truncated = decode_image(&bytes[..130]).expect_err("truncated");
    assert_eq!(truncated.code(), AssetErrorCode::Malformed);
}

#[test]
fn a_glb_and_a_gltf_with_its_buffer_load_the_same_mesh() {
    let (_scratch, root) = game();
    let glb = load_model(&root, "animated.glb").expect("GLB");
    let gltf = load_model(&root, "animated.gltf").expect(".gltf with animated.bin beside it");
    assert!(!glb.meshes.is_empty());
    let triangles = |model: &genex_assets::model::Model| -> usize {
        model.meshes.iter().flat_map(|m| &m.primitives).map(|p| p.indices.len() / 3).sum()
    };
    assert_eq!(triangles(&glb), triangles(&gltf));
    assert!(triangles(&glb) > 0);
    let primitive = &glb.meshes[0].primitives[0];
    assert_eq!(primitive.normals.len(), primitive.positions.len());
    assert!(primitive.indices.iter().all(|&i| (i as usize) < primitive.positions.len()));
}

#[test]
fn a_compressed_or_damaged_gltf_is_refused_typed() {
    let (_scratch, root) = game();
    let compressed = load_model(&root, "compressed.glb").expect_err("Draco");
    assert_eq!(compressed.code(), AssetErrorCode::NeedsImport, "{compressed}");
    let broken = load_model(&root, "broken.glb").expect_err("broken");
    assert_eq!(broken.code(), AssetErrorCode::Malformed, "{broken}");
    let obj = load_model(&root, "texture.hdr").expect_err("not a model");
    assert_eq!(obj.code(), AssetErrorCode::Unsupported, "{obj}");
}

#[test]
fn a_gltf_buffer_outside_the_asset_folder_is_refused() {
    let (scratch, root) = game();
    let assets = scratch.0.join("assets");
    let hostile = fs::read_to_string(assets.join("animated.gltf")).unwrap().replace("animated.bin", "../outside/secret.bin");
    fs::write(assets.join("hostile.gltf"), hostile).unwrap();
    let error = load_model(&root, "hostile.gltf").expect_err("escaping buffer");
    assert_eq!(error.code(), AssetErrorCode::UnsafePath, "{error}");
}

#[test]
fn a_data_uri_buffer_loads_without_the_file_system() {
    let (scratch, root) = game();
    let assets = scratch.0.join("assets");
    let bin = fs::read(assets.join("animated.bin")).unwrap();
    let uri = format!("data:application/octet-stream;base64,{}", base64(&bin));
    let inline = fs::read_to_string(assets.join("animated.gltf")).unwrap().replace("animated.bin", &uri);
    fs::write(assets.join("inline.gltf"), inline).unwrap();
    let model = load_model(&root, "inline.gltf").expect("a data URI buffer");
    assert!(!model.meshes.is_empty());
}

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(TABLE[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[test]
fn the_texture_table_is_the_import_steps() {
    let text = fs::read(fixtures("asset-import").join("texture-table.json")).unwrap();
    let shared = genex_core::json::parse(&text).expect("the shared table");
    let destinations = shared.get("destinations").expect("destinations");
    for target in TextureTarget::ALL {
        let name = target.as_str();
        let row: Vec<&str> = destinations.get(name).unwrap_or_else(|| panic!("{name}")).items().iter().map(|v| v.as_str()).collect();
        let ours: Vec<&str> = destination_textures(target).iter().map(|c| c.as_str()).collect();
        assert_eq!(ours, row, "{}", target.as_str());
    }
    for family in TextureCompression::ALL {
        let name = family.as_str();
        let feature = shared.get("features").and_then(|f| f.get(name)).unwrap_or_else(|| panic!("{name}"));
        assert_eq!(family.feature().unwrap_or(""), if feature.is_null() { "" } else { feature.as_str() });
        let format = shared.get("basisFormats").and_then(|f| f.get(name)).unwrap_or_else(|| panic!("{name}"));
        assert_eq!(f64::from(family.basis_format()), format.as_f64());
    }
}

#[test]
fn a_device_loads_the_best_family_it_has() {
    assert_eq!(compression_for(TextureTarget::Macos, &["texture-compression-bc"]), TextureCompression::Bc);
    assert_eq!(compression_for(TextureTarget::Ios, &["texture-compression-astc"]), TextureCompression::Astc);
    assert_eq!(compression_for(TextureTarget::Android, &["texture-compression-etc2"]), TextureCompression::Etc2);
    assert_eq!(compression_for(TextureTarget::Android, &[]), TextureCompression::Rgba8);
    assert_eq!(compression_for(TextureTarget::Web, &["texture-compression-astc"]), TextureCompression::Astc);
}
