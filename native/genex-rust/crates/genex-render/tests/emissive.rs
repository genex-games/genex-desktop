//! RQ6.3: emissive materials. A material's emissive colour times its strength (and its emissive
//! map) is radiance in the scene units the lit colour is in, written into the material-extension
//! row parallel to its material row, added after lighting and pre-exposed with it, so bloom spreads
//! it. A GLB's `emissiveFactor`, `emissiveTexture` and `KHR_materials_emissive_strength` import as
//! its parts' emission.
//!
//! The CPU rows run everywhere. The GPU rows are `#[ignore]`d and every name contains `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked --test emissive -- --ignored metal
//!
//! The golden lives in `tests/fixtures/render-goldens/emissive/strength.bgra` (raw BGRA, top row
//! first, 128x72): the strength-10 sphere's scene through the bloom chain and the AgX tonemap.
//! `GENEX_RENDER_GOLDEN_UPDATE=1` rewrites it instead; `GENEX_RENDER_EVIDENCE_DIR` also writes each
//! compared frame there.

use std::path::{Path, PathBuf};

use genex_render::capture::Capture;
use genex_render::layout::{MATERIAL_EXT_FLAG_EMISSIVE, MATERIAL_EXT_NO_TEXTURE, MATERIAL_EXT_NONE};
use genex_render::mesh::GlbModel;
use genex_render::post::bloom::BloomSettings;
use genex_render::post::tonemap::bloom_image;
use genex_render::scene::{CameraDesc, FramePlan, Material, MeshId, MeshLibrary, Scene, scaled};
use genex_render::settings::{Look, Quality, SceneFormat, Tonemapper};
use genex_render::texture::{TextureData, TextureId, TextureKind, srgb_to_linear};
use genex_render::{CullPath, Gpu, RenderOptions, Renderer};
use serde_json::{Value, json};

const WIDTH: u32 = 128;
const HEIGHT: u32 = 72;
/// A golden pixel may differ by this much per channel (another Apple GPU family rounds differently).
const GOLDEN_CHANNEL_TOLERANCE: u8 = 2;
/// Pixels allowed beyond the channel tolerance, of 9216.
const GOLDEN_OUTLIER_PIXELS: usize = 46;
/// The emissive sphere's colour and strength.
const EMBER: [u8; 3] = [255, 160, 64];
const STRENGTH: f32 = 10.0;

// ---------------------------------------------------------------------------------------------
// CPU rows: the extension row

#[test]
fn an_emissive_material_writes_colour_times_strength_into_its_extension_row() {
    let material = Material::color([40, 40, 40, 255]).with_emissive(EMBER, STRENGTH);
    let ext = material.to_gpu_ext();
    let expected = EMBER.map(|c| srgb_to_linear(c) * STRENGTH);
    assert_eq!(ext.emissive, [expected[0], expected[1], expected[2], 0.0]);
    assert_eq!(ext.params, [MATERIAL_EXT_NO_TEXTURE, 0.0, MATERIAL_EXT_FLAG_EMISSIVE as f32, 0.0], "no map, size class 0, emissive");
    assert!(material.is_emissive());
    // The material row itself is unchanged by emission (GpuMaterial keeps its frozen 48 bytes).
    assert_eq!(material.to_gpu(), Material::color([40, 40, 40, 255]).to_gpu());

    // An emissive map of the colour array names its layer; one of the data array is ignored.
    let mapped = material.with_emissive_texture(TextureId::new(TextureKind::Color, 3)).to_gpu_ext();
    assert_eq!(mapped.params[0], 3.0);
    assert_eq!(mapped.emissive, ext.emissive, "the map multiplies the radiance in the shader");
    let wrong_kind = material.with_emissive_texture(TextureId::new(TextureKind::Data, 3)).to_gpu_ext();
    assert_eq!(wrong_kind, ext, "a data texture is not an emissive map");
}

#[test]
fn a_material_that_emits_nothing_has_the_none_row_whatever_its_inputs() {
    let plain = Material::color([200, 60, 50, 255]);
    let dark = [
        plain,
        plain.with_emissive(EMBER, 0.0),
        plain.with_emissive([0, 0, 0], STRENGTH),
        plain.with_emissive(EMBER, -4.0),
        plain.with_emissive(EMBER, f32::NAN),
        plain.with_emissive(EMBER, f32::INFINITY),
        plain.with_emissive([0, 0, 0], STRENGTH).with_emissive_texture(TextureId::new(TextureKind::Color, 1)),
    ];
    for (i, material) in dark.iter().enumerate() {
        assert!(!material.is_emissive(), "row {i} emits nothing");
        assert_eq!(material.to_gpu_ext(), MATERIAL_EXT_NONE, "row {i}");
        assert!(material.emissive_radiance().iter().all(|c| *c == 0.0 && c.is_sign_positive()), "row {i}: +0, never NaN or -0");
    }
    // A hostile colour factor (as a GLB may state it) emits only its finite, positive channels.
    let hostile = Material { emissive: [f32::NAN, -1.0, 0.5], emissive_strength: 2.0, ..plain };
    assert_eq!(hostile.emissive_radiance(), [0.0, 0.0, 1.0]);
}

#[test]
fn materials_that_emit_alike_share_a_row_and_emission_tells_rows_apart() {
    let library = MeshLibrary::new();
    let plan = |materials: &[Material]| {
        let mut scene = Scene::new(CameraDesc::look_at([0.0, 0.0, 4.0], [0.0, 0.0, 0.0]), [0, 0, 0, 255]);
        for (i, material) in materials.iter().enumerate() {
            scene.draw(MeshId::CUBE, scaled([i as f32, 0.0, 0.0], [0.5; 3]), *material);
        }
        FramePlan::build(&scene, &library, 1.0).expect("plan")
    };
    let plain = Material::color([200, 60, 50, 255]);
    let rows = |materials: &[Material]| plan(materials).materials.len();
    assert_eq!(rows(&[plain, plain.with_emissive(EMBER, 0.0)]), 1, "strength 0 is the plain material's row");
    assert_eq!(rows(&[plain, plain.with_emissive(EMBER, STRENGTH)]), 2, "emission is its own row");
    assert_eq!(rows(&[plain.with_emissive(EMBER, STRENGTH), plain.with_emissive(EMBER, STRENGTH)]), 1, "equal emission shares one");
    assert_eq!(rows(&[plain.with_emissive(EMBER, STRENGTH), plain.with_emissive(EMBER, STRENGTH * 2.0)]), 2, "strength tells them apart");
}

// ---------------------------------------------------------------------------------------------
// CPU rows: GLB import

/// A 2 × 2 PNG of one colour, stored (uncompressed) deflate.
fn png(rgba: [u8; 4]) -> Vec<u8> {
    fn crc32(bytes: &[u8]) -> u32 {
        let mut crc = !0u32;
        for &byte in bytes {
            crc ^= u32::from(byte);
            for _ in 0..8 {
                crc = if crc & 1 == 1 { (crc >> 1) ^ 0xEDB8_8320 } else { crc >> 1 };
            }
        }
        !crc
    }
    fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
        out.extend((data.len() as u32).to_be_bytes());
        let mut body = kind.to_vec();
        body.extend(data);
        out.extend(&body);
        out.extend(crc32(&body).to_be_bytes());
    }
    let (width, height) = (2u32, 2u32);
    // Each row: filter type 0, then its pixels.
    let row: Vec<u8> = std::iter::once(0).chain(std::iter::repeat_n(rgba, width as usize).flatten()).collect();
    let raw = row.repeat(height as usize);
    let mut zlib = vec![0x78, 0x01, 1];
    let len = raw.len() as u16;
    zlib.extend(len.to_le_bytes());
    zlib.extend((!len).to_le_bytes());
    zlib.extend(&raw);
    let (mut a, mut b) = (1u32, 0u32);
    for &byte in &raw {
        a = (a + u32::from(byte)) % 65_521;
        b = (b + a) % 65_521;
    }
    zlib.extend(((b << 16) | a).to_be_bytes());
    let mut ihdr = Vec::new();
    ihdr.extend(width.to_be_bytes());
    ihdr.extend(height.to_be_bytes());
    ihdr.extend([8, 6, 0, 0, 0]);
    let mut out = b"\x89PNG\r\n\x1a\n".to_vec();
    chunk(&mut out, b"IHDR", &ihdr);
    chunk(&mut out, b"IDAT", &zlib);
    chunk(&mut out, b"IEND", &[]);
    out
}

/// A GLB of one quad per entry of `materials` (primitive `i` names material `i`) with `images`
/// embedded as PNG buffer views, one texture each.
fn material_glb(materials: Value, images: &[Vec<u8>]) -> Vec<u8> {
    let positions: [f32; 12] = [-0.5, -0.5, 0.0, 0.5, -0.5, 0.0, 0.5, 0.5, 0.0, -0.5, 0.5, 0.0];
    let uvs: [f32; 8] = [0.0, 1.0, 1.0, 1.0, 1.0, 0.0, 0.0, 0.0];
    let indices: [u16; 6] = [0, 1, 2, 0, 2, 3];
    let mut bin: Vec<u8> = positions.iter().chain(&uvs).flat_map(|f| f.to_le_bytes()).collect();
    bin.extend(indices.iter().flat_map(|i| i.to_le_bytes()));
    let mut views = vec![
        json!({ "buffer": 0, "byteOffset": 0, "byteLength": 48 }),
        json!({ "buffer": 0, "byteOffset": 48, "byteLength": 32 }),
        json!({ "buffer": 0, "byteOffset": 80, "byteLength": 12 }),
    ];
    for image in images {
        while !bin.len().is_multiple_of(4) {
            bin.push(0);
        }
        views.push(json!({ "buffer": 0, "byteOffset": bin.len(), "byteLength": image.len() }));
        bin.extend(image);
    }
    while !bin.len().is_multiple_of(4) {
        bin.push(0);
    }
    let count = materials.as_array().map_or(0, Vec::len);
    let primitives: Vec<Value> = (0..count).map(|i| json!({ "attributes": { "POSITION": 0, "TEXCOORD_0": 1 }, "indices": 2, "material": i })).collect();
    let mut gltf = json!({
        "asset": { "version": "2.0" },
        "buffers": [{ "byteLength": bin.len() }],
        "bufferViews": views,
        "accessors": [
            { "bufferView": 0, "componentType": 5126, "count": 4, "type": "VEC3", "min": [-0.5, -0.5, 0.0], "max": [0.5, 0.5, 0.0] },
            { "bufferView": 1, "componentType": 5126, "count": 4, "type": "VEC2" },
            { "bufferView": 2, "componentType": 5123, "count": 6, "type": "SCALAR" },
        ],
        "meshes": [{ "primitives": primitives }],
        "nodes": [{ "mesh": 0 }],
        "scenes": [{ "nodes": [0] }],
        "scene": 0,
        "materials": materials,
        "extensionsUsed": ["KHR_materials_emissive_strength"],
    });
    if !images.is_empty() {
        gltf["images"] = (0..images.len()).map(|i| json!({ "bufferView": 3 + i, "mimeType": "image/png" })).collect();
        gltf["textures"] = (0..images.len()).map(|i| json!({ "source": i })).collect();
    }
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
}

#[test]
fn a_glb_imports_its_emissive_factor_texture_and_strength() {
    let materials = json!([
        // 0: factor, map and KHR_materials_emissive_strength.
        { "emissiveFactor": [1.0, 0.5, 0.25], "emissiveTexture": { "index": 0 },
          "extensions": { "KHR_materials_emissive_strength": { "emissiveStrength": 8.0 } } },
        // 1: factor only (strength 1 without the extension).
        { "emissiveFactor": [0.2, 0.4, 0.6] },
        // 2: a map without a factor emits nothing (the factor defaults to black).
        { "emissiveTexture": { "index": 0 } },
        // 3: strength 0 emits nothing.
        { "emissiveFactor": [1.0, 1.0, 1.0], "extensions": { "KHR_materials_emissive_strength": { "emissiveStrength": 0.0 } } },
        // 4: a map on another uv set is ignored; the factor still emits.
        { "emissiveFactor": [1.0, 1.0, 1.0], "emissiveTexture": { "index": 0, "texCoord": 1 } },
    ]);
    let model = GlbModel::from_glb(&material_glb(materials, &[png([255, 128, 0, 255])])).expect("a valid GLB");
    let parts = model.parts();
    assert_eq!(parts.len(), 5);
    let emission = parts[0].emission.expect("material 0 emits");
    assert_eq!((emission.factor, emission.strength, emission.texture), ([1.0, 0.5, 0.25], 8.0, Some(0)));
    let factor_only = parts[1].emission.expect("material 1 emits");
    assert_eq!((factor_only.factor, factor_only.strength, factor_only.texture), ([0.2, 0.4, 0.6], 1.0, None));
    assert!(parts[2].emission.is_none(), "a black factor emits nothing, map or not");
    assert!(parts[3].emission.is_none(), "strength 0 emits nothing");
    let other_uv = parts[4].emission.expect("material 4 emits");
    assert_eq!(other_uv.texture, None, "TEXCOORD_1 is ignored");
    // The emissive map is decoded with the materials' images.
    let image = model.image(0).expect("image 0 is used").as_ref().expect("the PNG decodes");
    assert_eq!(image.rgba()[..4], [255, 128, 0, 255]);

    // Uploaded, it becomes the renderer material's emission: factor × strength × the map's layer.
    let layer = TextureId::new(TextureKind::Color, 5);
    let uploaded = emission.map_textures(|image, kind| (image == 0 && kind == TextureKind::Color).then_some(layer));
    let material = uploaded.apply(Material::color([255; 4]));
    assert_eq!(material.emissive_radiance(), [8.0, 4.0, 2.0]);
    assert_eq!(material.to_gpu_ext().params[0], 5.0);
}

#[test]
fn hostile_emissive_inputs_in_a_glb_import_finite_and_never_negative() {
    // JSON cannot carry NaN; out-of-range values are the hostile inputs a file can state.
    let materials = json!([
        { "emissiveFactor": [4.0, -1.0, 0.5], "extensions": { "KHR_materials_emissive_strength": { "emissiveStrength": -3.0 } } },
        { "emissiveFactor": [4.0, -1.0, 0.5], "extensions": { "KHR_materials_emissive_strength": { "emissiveStrength": 1.0e30 } } },
        { "emissiveFactor": [0.5, 0.5, 0.5], "emissiveTexture": { "index": 7 } },
    ]);
    let model = GlbModel::from_glb(&material_glb(materials.clone(), &[png([255; 4])]));
    // A texture index naming no texture is the glTF loader's refusal, as for any other slot.
    assert!(model.is_err(), "texture 7 does not exist");
    let materials = json!([materials[0], materials[1]]);
    let model = GlbModel::from_glb(&material_glb(materials, &[])).expect("a valid GLB");
    assert!(model.parts()[0].emission.is_none(), "a negative strength emits nothing");
    let clamped = model.parts()[1].emission.expect("emits");
    assert_eq!(clamped.factor, [1.0, 0.0, 0.5], "factors held to 0..=1");
    let radiance = clamped.map_textures(|_, _| None::<TextureId>).apply(Material::color([255; 4])).emissive_radiance();
    assert!(radiance.iter().all(|c| c.is_finite() && *c >= 0.0), "{radiance:?}");
}

// ---------------------------------------------------------------------------------------------
// GPU rows

fn gpu() -> Option<Gpu> {
    let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
    match Gpu::headless() {
        Ok(gpu) => {
            if require {
                assert_eq!(gpu.receipt().backend, "metal", "GENEX_REQUIRE_METAL=1 but the adapter is not Metal");
            }
            Some(gpu)
        }
        Err(error) if require => panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}"),
        Err(error) => {
            eprintln!("skipped: no WebGPU-core adapter ({error})");
            None
        }
    }
}

fn goldens_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../tests/fixtures/render-goldens/emissive")
}

fn write_evidence(name: &str, capture: &Capture) {
    if let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") {
        let dir = PathBuf::from(dir);
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join(format!("{name}.bgra")), capture.bgra()).expect("evidence");
    }
}

/// Compare `capture` with the golden `name`, or rewrite it under `GENEX_RENDER_GOLDEN_UPDATE=1`.
fn check_golden(name: &str, capture: &Capture) {
    assert_eq!((capture.width(), capture.height()), (WIDTH, HEIGHT));
    write_evidence(name, capture);
    let path = goldens_dir().join(format!("{name}.bgra"));
    if std::env::var("GENEX_RENDER_GOLDEN_UPDATE").is_ok_and(|v| v == "1") {
        std::fs::create_dir_all(goldens_dir()).expect("goldens folder");
        std::fs::write(&path, capture.bgra()).expect("golden written");
        return;
    }
    let golden = std::fs::read(&path).unwrap_or_else(|error| panic!("golden {path:?} missing ({error}); render it with GENEX_RENDER_GOLDEN_UPDATE=1"));
    assert_eq!(golden.len(), capture.bgra().len());
    let (mut outliers, mut worst) = (0, 0u8);
    for (a, b) in golden.chunks(4).zip(capture.bgra().chunks(4)) {
        let diff = a.iter().zip(b).map(|(p, q)| p.abs_diff(*q)).max().unwrap_or(0);
        worst = worst.max(diff);
        outliers += usize::from(diff > GOLDEN_CHANNEL_TOLERANCE);
    }
    assert!(outliers <= GOLDEN_OUTLIER_PIXELS, "{name}: {outliers} pixels differ from the golden by more than {GOLDEN_CHANNEL_TOLERANCE} (worst {worst})");
}

/// A single-sampled renderer: on the `rgba16float` HDR scene at EV 0 (pre-exposure 1, so the
/// scene reads back the radiance) when `hdr`, else the legacy LDR path.
fn renderer(gpu: &Gpu, hdr: bool) -> Renderer {
    let mut renderer = Renderer::with_options(gpu, WIDTH, HEIGHT, RenderOptions { msaa: false }).expect("renderer");
    if hdr {
        let mut quality = Quality::off();
        quality.hdr = true;
        quality.tonemap = true;
        renderer.set_quality(&quality);
        renderer.set_scene_format(SceneFormat::Rgba16Float);
        let mut look = Look::default();
        look.tonemapper = Tonemapper::Agx;
        look.ev_compensation = 0.0;
        renderer.set_look(look);
    }
    renderer
}

/// One sphere in the middle of a dark scene (no sun, no ambient, black background).
fn dark_scene(material: Material) -> Scene {
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 0.0, 4.0], [0.0, 0.0, 0.0]), [0, 0, 0, 255]);
    scene.lighting.sun_intensity = 0.0;
    scene.lighting.ambient_intensity = 0.0;
    scene.draw(MeshId::SPHERE, scaled([0.0, 0.0, 0.0], [0.5; 3]), material);
    scene
}

/// The sphere's dielectric base: grey, so only emission (or a light) shows it in the dark.
fn base() -> Material {
    Material::color([90, 90, 90, 255])
}

fn draw(gpu: &Gpu, renderer: &mut Renderer, scene: &Scene) -> Capture {
    renderer.render(gpu, scene, CullPath::Gpu).expect("frame");
    renderer.capture(gpu).expect("capture")
}

fn scene_radiance(gpu: &Gpu, scene: &Scene) -> Vec<[f32; 4]> {
    let mut renderer = renderer(gpu, true);
    renderer.render(gpu, scene, CullPath::Gpu).expect("frame");
    assert!(renderer.last_scene().is_some_and(|path| path.hdr), "drawn on the HDR scene");
    renderer.read_scene(gpu).expect("the HDR scene reads back")
}

fn bloom() -> BloomSettings {
    let mut quality = Quality::off().bloom;
    quality.enabled = true;
    quality.mips = 6;
    quality.half_res = true;
    BloomSettings::new(&Look::default().with_bloom(0.2, 0.0, 1.0), &quality).expect("bloom on")
}

fn summed(capture: &Capture, mask: &[bool]) -> u64 {
    capture.bgra().chunks(4).zip(mask).filter(|(_, m)| **m).map(|(p, _)| p[..3].iter().map(|c| u64::from(*c)).sum::<u64>()).sum()
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_an_emissive_sphere_in_the_dark_shines_its_radiance_and_blooms_past_its_silhouette() {
    let Some(gpu) = gpu() else { return };
    let glowing = scene_radiance(&gpu, &dark_scene(base().with_emissive(EMBER, STRENGTH)));
    let unlit = scene_radiance(&gpu, &dark_scene(base().with_emissive(EMBER, 0.0)));
    let silhouette: Vec<bool> = glowing.iter().map(|t| t[0] > 0.0).collect();
    let covered = silhouette.iter().filter(|s| **s).count();
    assert!(covered > 300, "the sphere covers the middle of the frame ({covered} pixels emit)");
    // The centre texel reads the emitted radiance exactly as the extension row states it (EV 0).
    let centre = glowing[(HEIGHT / 2 * WIDTH + WIDTH / 2) as usize];
    let expected = EMBER.map(|c| srgb_to_linear(c) * STRENGTH);
    for (got, want) in centre[..3].iter().zip(expected) {
        assert!((got - want).abs() <= want * 2e-3, "centre {centre:?}, emitted {expected:?}");
    }
    assert!(unlit.iter().all(|t| t[..3] == [0.0; 3]), "strength 0 in the dark is black");
    // Through the bloom chain the radiance spreads past the silhouette: the dark ring around the
    // sphere brightens where the strength-0 sphere's stays black.
    let ring: Vec<bool> = silhouette.iter().enumerate().map(|(i, s)| !s && near(&silhouette, i, 6)).collect();
    let shine = bloom_image(&gpu, Tonemapper::Agx, (WIDTH, HEIGHT), &glowing, Some(bloom()), false).expect("bloom");
    let dark = bloom_image(&gpu, Tonemapper::Agx, (WIDTH, HEIGHT), &unlit, Some(bloom()), false).expect("bloom");
    let (lit_ring, dark_ring) = (summed(&shine, &ring), summed(&dark, &ring));
    assert_eq!(dark_ring, 0, "nothing blooms around a dark sphere");
    let ring_pixels = ring.iter().filter(|r| **r).count() as u64;
    assert!(lit_ring > ring_pixels * 3 * 8, "the ring around the emissive sphere brightens ({lit_ring} over {ring_pixels} pixels)");
    check_golden("strength", &shine);
}

/// Whether any pixel within `r` (Chebyshev) of pixel `i` is set in `mask`.
fn near(mask: &[bool], i: usize, r: i64) -> bool {
    let (w, h) = (i64::from(WIDTH), i64::from(HEIGHT));
    let (x, y) = (i as i64 % w, i as i64 / w);
    (-r..=r).flat_map(|dy| (-r..=r).map(move |dx| (x + dx, y + dy))).any(|(x, y)| (0..w).contains(&x) && (0..h).contains(&y) && mask[(y * w + x) as usize])
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_a_strength_0_sphere_equals_the_non_emissive_one_byte_for_byte() {
    let Some(gpu) = gpu() else { return };
    // Lit, so the sphere shows: the sun and the ambient term as the defaults give them.
    let lit = |material: Material| {
        let mut scene = dark_scene(material);
        scene.lighting = Scene::new(CameraDesc::look_at([0.0, 0.0, 4.0], [0.0; 3]), [0, 0, 0, 255]).lighting;
        scene
    };
    for hdr in [false, true] {
        let plain = draw(&gpu, &mut renderer(&gpu, hdr), &lit(base()));
        let zero = draw(&gpu, &mut renderer(&gpu, hdr), &lit(base().with_emissive(EMBER, 0.0)));
        assert_eq!(plain.bgra(), zero.bgra(), "hdr {hdr}: strength 0 draws the non-emissive picture");
        let glowing = draw(&gpu, &mut renderer(&gpu, hdr), &lit(base().with_emissive(EMBER, STRENGTH)));
        assert_ne!(plain.bgra(), glowing.bgra(), "hdr {hdr}: emission changes the picture");
    }
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_an_emissive_map_masks_the_emission() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = renderer(&gpu, true);
    // Vertical stripes, white and black, an eighth of the u range each (two texels of an 8 × 8
    // map, so each keeps a plateau after the layer's upscale): the visible hemisphere (half the u
    // range) shows white bands and black ones.
    let stripes: Vec<u8> = (0..64).flat_map(|i| if i % 4 < 2 { [255; 4] } else { [0, 0, 0, 255] }).collect();
    let texture = renderer.add_texture(&gpu, &TextureData::rgba8(8, 8, stripes).expect("texture"), TextureKind::Color).expect("uploaded");
    let scene = dark_scene(base().with_emissive(EMBER, STRENGTH).with_emissive_texture(texture));
    renderer.render(&gpu, &scene, CullPath::Gpu).expect("frame");
    let texels = renderer.read_scene(&gpu).expect("the HDR scene reads back");
    let unmasked = scene_radiance(&gpu, &dark_scene(base().with_emissive(EMBER, STRENGTH)));
    let full = srgb_to_linear(EMBER[0]) * STRENGTH;
    let sphere: Vec<usize> = (0..unmasked.len()).filter(|i| unmasked[*i][0] > 0.0).collect();
    let bright = sphere.iter().filter(|i| texels[**i][0] > full * 0.9).count();
    let dark = sphere.iter().filter(|i| texels[**i][0] < full * 0.1).count();
    let whole = sphere.len();
    assert!(bright > whole / 10 && dark > whole / 10, "the map masks part of the sphere ({bright} bright, {dark} dark of {whole})");
    let brightest = texels.iter().map(|t| t[0]).fold(0.0f32, f32::max);
    assert!((brightest - full).abs() <= full * 0.02, "inside a white band the full radiance is emitted ({brightest} of {full})");
}
