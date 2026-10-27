//! Renderer pass 2, P2-0.12 material basics: glTF `MASK` alpha testing in the prepass, the casters
//! and the world pass (alpha-to-coverage under MSAA, hashed alpha under TAA), alpha-coverage
//! preserving mips, double-sided materials (S11, A4.0); anisotropic filtering of the material
//! textures per preset (LG-02); the sun as a disc for specular and the roughness floor (LG-04);
//! glTF occlusion maps (LG-09); specular anti-aliasing from the geometric normal (C8); UV scale and
//! world-aligned box projection (Bodycam B2b).
//!
//! The CPU rows run everywhere. The GPU rows are `#[ignore]`d and every name contains `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked --test materials -- --ignored metal
//!
//! Goldens live in `tests/fixtures/render-goldens/materials/` (raw sRGB BGRA, top row first);
//! `GENEX_RENDER_GOLDEN_UPDATE=1` rewrites them instead. `GENEX_RENDER_EVIDENCE_DIR` receives each
//! compared frame (raw BGRA, the size in the name).

use std::path::PathBuf;

use genex_render::capture::Capture;
use genex_render::device_class::{DeviceClass, FormFactor, PerformanceTier};
use genex_render::layout::NO_TEXTURE;
use genex_render::mesh::{GlbModel, MeshData, Vertex};
use genex_render::presets::preset_quality;
use genex_render::pbr::{UV_SCALE_MAX, UV_SCALE_MIN};
use genex_render::scene::{CameraDesc, DrawVariant, FramePlan, Material, MeshId, MeshLibrary, Scene, UvMapping, scaled};
use genex_render::settings::{AntiAliasing, Quality, QualityPreset, SceneFormat};
use genex_render::texture::{CUTOUT_COVERAGE_ALPHA, TextureData, TextureId, TextureKind, alpha_coverage, cutout_mip_chain, mip_chain};
use genex_render::{CullPath, Gpu, RenderOptions, Renderer};
use glam::{Mat4, Vec3};
use serde_json::{Value, json};

const WIDTH: u32 = 160;
const HEIGHT: u32 = 120;
/// The background's sRGB clear colour.
const CLEAR: [u8; 4] = [10, 12, 18, 255];
/// A pixel this many luma levels above the background is drawn.
const DRAWN_LEVELS: f32 = 24.0;

// ---------------------------------------------------------------------------------------------
// Helpers

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

fn desktop() -> DeviceClass {
    DeviceClass::new(FormFactor::Desktop, PerformanceTier::High)
}

/// The legacy renderer (LDR, MSAA 4x).
fn legacy() -> Quality {
    Quality::off()
}

/// The HDR scene under MSAA 4x (medium's anti-aliasing), nothing else that keeps history.
fn hdr_msaa() -> Quality {
    let mut quality = Quality::off();
    quality.hdr = true;
    quality.tonemap = true;
    quality
}

/// The HDR scene with one sample and no anti-aliasing: its radiance reads back as drawn.
fn hdr_plain() -> Quality {
    let mut quality = hdr_msaa();
    quality.anti_aliasing = AntiAliasing::Off;
    quality
}

/// The HDR scene under TAA with its prepass (high's anti-aliasing), nothing else with history.
fn hdr_taa() -> Quality {
    let mut quality = hdr_msaa();
    quality.prepass = true;
    quality.anti_aliasing = AntiAliasing::Taa;
    quality
}

fn renderer_sized(gpu: &Gpu, quality: &Quality, size: (u32, u32), class: DeviceClass) -> Renderer {
    let options = RenderOptions { msaa: quality.anti_aliasing == AntiAliasing::Msaa4 };
    let mut renderer = Renderer::with_options(gpu, size.0, size.1, options).expect("renderer");
    renderer.set_scene_format(SceneFormat::Rgba16Float);
    renderer.set_device_class(class);
    renderer.set_quality(quality);
    renderer
}

fn renderer(gpu: &Gpu, quality: &Quality) -> Renderer {
    renderer_sized(gpu, quality, (WIDTH, HEIGHT), desktop())
}

/// Frames `0..frames` of `scene`, the last one read back.
fn draw(gpu: &Gpu, renderer: &mut Renderer, scene: &Scene, frames: u64) -> Capture {
    for index in 0..frames {
        renderer.set_frame_index(index);
        renderer.render(gpu, scene, CullPath::Gpu).expect("frame");
    }
    renderer.capture(gpu).expect("capture")
}

/// Frames a TAA row settles over before it reads.
const SETTLE_FRAMES: u64 = 24;

fn frames_for(quality: &Quality) -> u64 {
    if quality.anti_aliasing.temporal() { SETTLE_FRAMES } else { 1 }
}

fn write_evidence(name: &str, capture: &Capture) {
    if let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") {
        let dir = PathBuf::from(dir);
        let _ = std::fs::create_dir_all(&dir);
        let file = dir.join(format!("materials-{name}-{}x{}.bgra", capture.width(), capture.height()));
        std::fs::write(file, capture.bgra()).expect("evidence");
    }
}

fn golden_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../../tests/fixtures/render-goldens/materials").join(format!("{name}.bgra"))
}

/// `capture` against its golden (each channel within `tolerance` levels), or the golden rewritten
/// under `GENEX_RENDER_GOLDEN_UPDATE=1`.
fn check_golden(name: &str, capture: &Capture, tolerance: u8) {
    let path = golden_path(name);
    if std::env::var("GENEX_RENDER_GOLDEN_UPDATE").is_ok_and(|v| v == "1") {
        std::fs::create_dir_all(path.parent().expect("golden folder")).expect("golden folder");
        std::fs::write(&path, capture.bgra()).expect("golden");
        return;
    }
    let golden = std::fs::read(&path).unwrap_or_else(|error| panic!("{}: {error} (record it with GENEX_RENDER_GOLDEN_UPDATE=1)", path.display()));
    assert_eq!(golden.len(), capture.bgra().len(), "{name}: golden size");
    let off = golden.iter().zip(capture.bgra()).filter(|(a, b)| a.abs_diff(**b) > tolerance).count();
    assert_eq!(off, 0, "{name}: {off} channels differ from the golden by more than {tolerance} levels");
}

/// Rec. 709 luma of every pixel, in levels.
fn lumas(capture: &Capture) -> Vec<f32> {
    capture.bgra().as_chunks::<4>().0.iter().map(|p| 0.0722 * f32::from(p[0]) + 0.7152 * f32::from(p[1]) + 0.2126 * f32::from(p[2])).collect()
}

/// The background's luma in `capture`: its top-left pixel (the clear colour, as the frame's path
/// encodes it).
fn background_luma(capture: &Capture) -> f32 {
    lumas(capture)[0]
}

/// The pixel `world` projects to through `camera` on an image of `size` (x right, y down).
fn pixel(camera: &CameraDesc, size: (u32, u32), world: Vec3) -> (f32, f32) {
    let clip = camera.view_proj(size.0 as f32 / size.1 as f32) * world.extend(1.0);
    ((clip.x / clip.w * 0.5 + 0.5) * size.0 as f32, (0.5 - clip.y / clip.w * 0.5) * size.1 as f32)
}

/// The mean luma of the pixels within `radius` of `at`.
fn mean_luma_near(capture: &Capture, at: (f32, f32), radius: f32) -> f32 {
    let luma = lumas(capture);
    let w = capture.width() as usize;
    let mut sum = 0.0;
    let mut count = 0.0;
    for (i, value) in luma.iter().enumerate() {
        let (x, y) = ((i % w) as f32 + 0.5, (i / w) as f32 + 0.5);
        if libm::hypotf(x - at.0, y - at.1) <= radius {
            sum += value;
            count += 1.0;
        }
    }
    assert!(count > 0.0, "no pixel near {at:?}");
    sum / count
}

/// A unit quad in the XY plane facing +Z (two counter-clockwise triangles), uv (0, 0) at its top
/// left, tangent along +u; `repeat` tiles its uv.
fn card_mesh(repeat: f32) -> MeshData {
    let corners = [([-0.5, -0.5], [0.0, 1.0]), ([0.5, -0.5], [1.0, 1.0]), ([0.5, 0.5], [1.0, 0.0]), ([-0.5, 0.5], [0.0, 0.0])];
    let vertices = corners
        .iter()
        .map(|([x, y], [u, v])| Vertex { position: [*x, *y, 0.0], normal: [0.0, 0.0, 1.0], uv: [u * repeat, v * repeat], tangent: [1.0, 0.0, 0.0, -1.0] })
        .collect();
    MeshData { vertices, indices: vec![0, 1, 2, 0, 2, 3] }
}

/// `card_mesh` laid flat, facing +Y (the ground), `size` across, its uv tiled `repeat` times.
fn ground_model(size: [f32; 2], y: f32) -> [f32; 16] {
    (Mat4::from_translation(Vec3::new(0.0, y, 0.0)) * Mat4::from_rotation_x(-std::f32::consts::FRAC_PI_2) * Mat4::from_scale(Vec3::new(size[0], size[1], 1.0)))
        .to_cols_array()
}

/// A `side`-square RGBA8 texture of `f(x, y)`.
fn texture(side: u32, f: impl Fn(u32, u32) -> [u8; 4]) -> TextureData {
    let rgba = (0..side).flat_map(|y| (0..side).map(move |x| (x, y))).flat_map(|(x, y)| f(x, y)).collect();
    TextureData::rgba8(side, side, rgba).expect("texture")
}

/// A leaf card: white, opaque inside a disc of `radius` (of the side) around the centre, alpha 0
/// outside (`hole` swaps the two).
fn disc_texture(radius: f32, hole: bool) -> TextureData {
    texture(64, |x, y| {
        let (u, v) = ((x as f32 + 0.5) / 64.0 - 0.5, (y as f32 + 0.5) / 64.0 - 0.5);
        let inside = libm::hypotf(u, v) < radius;
        [255, 255, 255, if inside != hole { 255 } else { 0 }]
    })
}

fn white_card() -> Material {
    Material::color([235, 235, 235, 255]).with_pbr(0.0, 0.8)
}

// ---------------------------------------------------------------------------------------------
// CPU rows

#[test]
fn presets_filter_material_textures_anisotropically_by_preset_and_class() {
    let class = |form, tier| DeviceClass::new(form, tier);
    let desktop = class(FormFactor::Desktop, PerformanceTier::High);
    let rows = [
        (QualityPreset::Ultra, desktop, 16),
        (QualityPreset::High, desktop, 16),
        (QualityPreset::Medium, desktop, 8),
        (QualityPreset::Low, desktop, 4),
        (QualityPreset::High, class(FormFactor::Mobile, PerformanceTier::High), 4),
        (QualityPreset::Medium, class(FormFactor::Mobile, PerformanceTier::Mid), 4),
        (QualityPreset::Low, class(FormFactor::Mobile, PerformanceTier::Low), 2),
        (QualityPreset::Medium, class(FormFactor::Mobile, PerformanceTier::Low), 2),
    ];
    for (preset, class, anisotropy) in rows {
        assert_eq!(preset_quality(preset, class).anisotropy, anisotropy, "{preset:?} on {class:?}");
    }
    assert_eq!(Quality::off().anisotropy, 1, "the legacy renderer samples trilinear");
    let (mut a, mut b) = (preset_quality(QualityPreset::High, desktop), preset_quality(QualityPreset::High, desktop));
    a.anisotropy = 16;
    b.anisotropy = 2;
    assert!(a.resource_change_only(&b), "anisotropy is a resource knob: no pipeline changes with it");
}

/// A PNG of `side`-square RGBA8 pixels: stored (uncompressed) deflate.
fn png(side: u32, rgba: &[u8]) -> Vec<u8> {
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
    let mut raw = Vec::new();
    for row in rgba.chunks((side * 4) as usize) {
        raw.push(0);
        raw.extend(row);
    }
    let mut zlib = vec![0x78, 0x01];
    let blocks: Vec<&[u8]> = raw.chunks(65_535).collect();
    for (i, block) in blocks.iter().enumerate() {
        zlib.push(u8::from(i + 1 == blocks.len()));
        let len = block.len() as u16;
        zlib.extend(len.to_le_bytes());
        zlib.extend((!len).to_le_bytes());
        zlib.extend(*block);
    }
    let (mut a, mut b) = (1u32, 0u32);
    for &byte in &raw {
        a = (a + u32::from(byte)) % 65_521;
        b = (b + a) % 65_521;
    }
    zlib.extend(((b << 16) | a).to_be_bytes());
    let mut ihdr = Vec::new();
    ihdr.extend(side.to_be_bytes());
    ihdr.extend(side.to_be_bytes());
    ihdr.extend([8, 6, 0, 0, 0]);
    let mut out = b"\x89PNG\r\n\x1a\n".to_vec();
    chunk(&mut out, b"IHDR", &ihdr);
    chunk(&mut out, b"IDAT", &zlib);
    chunk(&mut out, b"IEND", &[]);
    out
}

/// A GLB of one quad drawn once per material of `materials` (a primitive each), with `images`
/// embedded as PNG buffer views and one texture each.
fn material_glb(materials: Value, images: &[Vec<u8>]) -> Vec<u8> {
    let positions: [f32; 12] = [-0.5, -0.5, 0.0, 0.5, -0.5, 0.0, 0.5, 0.5, 0.0, -0.5, 0.5, 0.0];
    let uvs: [f32; 8] = [0.0, 1.0, 1.0, 1.0, 1.0, 0.0, 0.0, 0.0];
    let indices: [u16; 6] = [0, 1, 2, 0, 2, 3];
    let mut bin = Vec::new();
    bin.extend(positions.iter().flat_map(|f| f.to_le_bytes()));
    bin.extend(uvs.iter().flat_map(|f| f.to_le_bytes()));
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
    let primitives: Vec<Value> = (0..count).map(|m| json!({ "attributes": { "POSITION": 0, "TEXCOORD_0": 1 }, "indices": 2, "material": m })).collect();
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
    });
    if !images.is_empty() {
        gltf["images"] = Value::Array((0..images.len()).map(|i| json!({ "bufferView": 3 + i, "mimeType": "image/png" })).collect());
        gltf["textures"] = Value::Array((0..images.len()).map(|i| json!({ "source": i })).collect());
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
fn a_glb_mask_material_keeps_its_alpha_and_cutoff_and_reads_double_sided() {
    let leaf = png(4, &[255; 64]);
    let materials = json!([
        { "pbrMetallicRoughness": { "baseColorFactor": [0.2, 0.8, 0.2, 0.8], "baseColorTexture": { "index": 0 } }, "alphaMode": "MASK", "alphaCutoff": 0.3, "doubleSided": true },
        { "pbrMetallicRoughness": { "baseColorFactor": [1.0, 1.0, 1.0, 0.6] }, "alphaMode": "MASK" },
        { "pbrMetallicRoughness": { "baseColorFactor": [1.0, 1.0, 1.0, 0.6] } },
        { "pbrMetallicRoughness": { "baseColorFactor": [1.0, 1.0, 1.0, 0.6] }, "alphaMode": "BLEND", "doubleSided": true }
    ]);
    let model = GlbModel::from_glb(&material_glb(materials, &[leaf])).expect("a valid GLB");
    let parts: Vec<_> = model.parts().iter().map(|part| part.material.expect("every part names a material")).collect();
    let [leaf, masked, opaque, blended] = parts[..] else { panic!("four parts: {}", parts.len()) };
    assert_eq!((leaf.base_color[3], leaf.alpha_cutoff, leaf.double_sided), (0.8, Some(0.3), true), "MASK keeps its alpha factor and cutoff");
    assert_eq!((masked.base_color[3], masked.alpha_cutoff, masked.double_sided), (0.6, Some(0.5), false), "glTF's default cutoff is 0.5");
    assert_eq!((opaque.base_color[3], opaque.alpha_cutoff), (1.0, None), "OPAQUE ignores alpha");
    assert_eq!((blended.base_color[3], blended.alpha_cutoff, blended.double_sided), (0.6, None, true), "BLEND blends");
    assert!(
        leaf.textures().any(|(image, kind)| image == 0 && kind == TextureKind::Cutout),
        "a masked base colour map uploads with coverage-preserving mips"
    );

    let base = TextureId::new(TextureKind::Cutout, 2);
    let drawn = leaf.map_textures(|_, kind| (kind == TextureKind::Cutout).then_some(base)).to_material([255; 4]);
    assert_eq!((drawn.alpha_cutoff, drawn.double_sided, drawn.base_texture), (Some(0.3), true, Some(base)));
    assert_eq!(drawn.base_color[3], 204, "the alpha factor is kept for the test");
    assert!(!drawn.is_transparent(), "a masked material is never blended, whatever its alpha");
    assert_eq!(drawn.draw_variant(), DrawVariant { masked: true, double_sided: true });
    let row = drawn.to_gpu();
    assert_eq!(row.textures[0], base.reference(), "the cutout map is the base colour map");
    assert_eq!(drawn.to_gpu_ext().params[3], 0.3, "the cutoff rides in the extension row");
    assert_eq!(opaque.map_textures(|_, _| None::<TextureId>).to_material([255; 4]).draw_variant(), DrawVariant::PLAIN);
}

#[test]
fn a_glb_occlusion_map_is_read_and_an_orm_texture_reuses_the_metal_rough_fetch() {
    let orm = png(4, &[200; 64]);
    let occlusion = png(4, &[90; 64]);
    let materials = json!([
        {
            "pbrMetallicRoughness": { "metallicRoughnessTexture": { "index": 0 } },
            "occlusionTexture": { "index": 0, "strength": 0.75 }
        },
        {
            "pbrMetallicRoughness": { "metallicRoughnessTexture": { "index": 0 } },
            "occlusionTexture": { "index": 1 }
        },
        { "pbrMetallicRoughness": {}, "occlusionTexture": { "index": 1, "texCoord": 1 } }
    ]);
    let model = GlbModel::from_glb(&material_glb(materials, &[orm, occlusion])).expect("a valid GLB");
    let parts: Vec<_> = model.parts().iter().map(|part| part.material.expect("material")).collect();
    let [packed, separate, other_uv] = parts[..] else { panic!("three parts") };
    assert_eq!((packed.occlusion_texture, packed.metal_rough_texture, packed.occlusion_strength), (Some(0), Some(0), 0.75), "ORM: one image");
    assert_eq!((separate.occlusion_texture, separate.occlusion_strength), (Some(1), 1.0), "a separate occlusion map, strength 1 by default");
    assert_eq!(other_uv.occlusion_texture, None, "a map on another uv set is ignored");

    let ids = |image: u32, kind: TextureKind| Some(TextureId::new(kind, image + 5));
    let packed = packed.map_textures(ids).to_material([255; 4]);
    let row = packed.to_gpu();
    assert_ne!(row.textures[3], NO_TEXTURE);
    assert_eq!(row.textures[3], row.textures[2], "an ORM texture's occlusion is its metal-rough texel's red: one fetch");
    assert_eq!(packed.to_gpu_ext().emissive[3], 0.75, "the strength rides in the extension row");
    let separate = separate.map_textures(ids).to_material([255; 4]);
    assert_eq!(separate.to_gpu().textures[3], TextureId::new(TextureKind::Data, 6).reference());
    assert_eq!(Material::color([255; 4]).to_gpu().textures[3], NO_TEXTURE, "no occlusion map: none");
}

#[test]
fn masked_and_double_sided_draws_take_their_own_batches_after_the_plain_ones() {
    let library = MeshLibrary::new();
    let camera = CameraDesc::look_at([0.0, 2.0, 6.0], [0.0, 0.0, 0.0]);
    let mut plain = Scene::new(camera, CLEAR);
    for x in 0..3 {
        plain.draw(MeshId::CUBE, scaled([x as f32, 0.0, 0.0], [0.5; 3]), white_card());
    }
    plain.draw(MeshId::SPHERE, scaled([0.0, 1.0, 0.0], [0.5; 3]), white_card());
    let before = FramePlan::build(&plain, &library, 1.5).expect("plan");
    assert!(before.variants.is_empty(), "a scene of plain draws plans no variant");
    assert_eq!((before.plain_batches as usize, before.slot_base.len()), (before.batches.len(), before.slot_count as usize));

    let mut scene = plain.clone();
    let leaf = white_card().with_alpha_cutoff(0.5).with_double_sided(true);
    scene.draw(MeshId::CUBE, scaled([0.0, 0.0, 2.0], [0.5; 3]), leaf);
    scene.draw(MeshId::SPHERE, scaled([1.0, 0.0, 2.0], [0.5; 3]), white_card().with_double_sided(true));
    scene.draw(MeshId::CUBE, scaled([2.0, 0.0, 2.0], [0.5; 3]), leaf);
    let plan = FramePlan::build(&scene, &library, 1.5).expect("plan");
    assert_eq!(&plan.batches[..before.batches.len()], &before.batches[..], "the plain batches are as before");
    assert_eq!(plan.plain_batches, before.plain_batches);
    let runs: Vec<(DrawVariant, u32)> = plan.variants.iter().map(|run| (run.variant, run.batches.len() as u32)).collect();
    assert_eq!(
        runs,
        [(DrawVariant { masked: false, double_sided: true }, 1), (DrawVariant { masked: true, double_sided: true }, 1)],
        "one run per variant drawn, in variant order, one batch per mesh"
    );
    let leaves = &plan.batches[plan.variants[1].batches.start as usize];
    assert_eq!(leaves.instance_count, 2, "both leaf cubes share one batch");
    let slots = plan.slot_count as usize;
    assert_eq!(plan.slot_base.len(), slots * 4, "one slot region per variant");
    assert_eq!(plan.slot_base[3 * slots + MeshId::CUBE.raw() as usize], leaves.first_instance, "the masked double-sided region names its batch");
    assert_eq!(plan.slot_base[..slots], before.slot_base[..], "the plain region is as before");
    assert_eq!(plan.opaque_instances, before.opaque_instances + 3, "variant rows are opaque rows");
}

/// Thin blades on a transparent field: 3 of every 16 columns opaque, the blades' tips fading.
fn blades() -> TextureData {
    texture(256, |x, y| {
        let blade = x % 16 < 3;
        let tip = (255.0 * (1.0 - (y as f32 / 255.0) * 0.4)) as u8;
        [60, 160, 40, if blade { tip } else { 0 }]
    })
}

#[test]
fn cutout_mips_keep_the_coverage_of_their_top_level() {
    let source = blades();
    let target = alpha_coverage(&mip_chain(&source, TextureKind::Color, 256)[0], CUTOUT_COVERAGE_ALPHA);
    assert!((target - 3.0 / 16.0).abs() < 0.01, "the blades cover 3/16: {target}");
    let plain = mip_chain(&source, TextureKind::Color, 256);
    let plain_coverage: Vec<f32> = plain.iter().map(|level| alpha_coverage(level, CUTOUT_COVERAGE_ALPHA)).collect();
    assert!(plain_coverage[3] < target * 0.5, "box mips lose the blades: {plain_coverage:?}");
    let kept = cutout_mip_chain(&source, 256);
    assert_eq!(kept.len(), plain.len());
    for (level, mip) in kept.iter().enumerate().take_while(|(_, mip)| mip.width() >= 8) {
        let coverage = alpha_coverage(mip, CUTOUT_COVERAGE_ALPHA);
        // The blades run the texture's height: a level's coverage moves in steps of one row.
        let step = 1.0 / mip.height() as f32;
        assert!((coverage - target).abs() <= 0.03_f32.max(step * 0.5 + 1e-6), "level {level}: coverage {coverage} against {target}");
        let colour = |level: &TextureData| level.rgba().as_chunks::<4>().0.iter().map(|t| [t[0], t[1], t[2]]).collect::<Vec<_>>();
        assert_eq!(colour(mip), colour(&plain[level]), "colour is filtered as before");
    }
}

// ---------------------------------------------------------------------------------------------
// GPU rows: S11 / A4.0

/// A leaf card facing the camera: `leaf` (a cutout disc) on `material`'s card, two units wide.
fn leaf_scene(card: MeshId, material: Material) -> (Scene, CameraDesc) {
    let camera = CameraDesc::look_at([0.0, 0.0, 4.0], [0.0, 0.0, 0.0]);
    let mut scene = Scene::new(camera, CLEAR);
    scene.lighting.sun_dir = [0.2, 0.4, 1.0];
    scene.lighting.shadows = false;
    scene.draw(card, scaled([0.0, 0.0, 0.0], [2.0, 2.0, 1.0]), material);
    (scene, camera)
}

/// Pixels drawn outside the cutout disc's footprint (with a two-pixel margin) and pixels left
/// undrawn inside it.
fn quad_and_hole_pixels(capture: &Capture, camera: &CameraDesc, radius_world: f32) -> (usize, usize) {
    let size = (capture.width(), capture.height());
    let centre = pixel(camera, size, Vec3::ZERO);
    let edge = pixel(camera, size, Vec3::new(radius_world, 0.0, 0.0));
    let radius = (edge.0 - centre.0).abs();
    let background = background_luma(capture);
    let w = size.0 as usize;
    let mut quad = 0;
    let mut hole = 0;
    for (i, luma) in lumas(capture).iter().enumerate() {
        let (x, y) = ((i % w) as f32 + 0.5, (i / w) as f32 + 0.5);
        let distance = libm::hypotf(x - centre.0, y - centre.1);
        let drawn = *luma > background + DRAWN_LEVELS;
        if distance > radius + 2.0 && drawn {
            quad += 1;
        }
        if distance < radius - 2.0 && !drawn {
            hole += 1;
        }
    }
    (quad, hole)
}

#[test]
#[ignore = "needs a Metal adapter"]
fn metal_a_masked_leaf_card_draws_no_quad_around_its_cutout() {
    let Some(gpu) = gpu() else { return };
    let rows: [(&str, Quality, bool); 3] = [("legacy", legacy(), true), ("hdr-msaa", hdr_msaa(), true), ("hdr-taa", hdr_taa(), false)];
    for (name, quality, golden) in rows {
        let mut renderer = renderer(&gpu, &quality);
        let card = renderer.add_mesh(&gpu, card_mesh(1.0)).expect("card");
        let leaf = renderer.add_texture(&gpu, &disc_texture(0.35, false), TextureKind::Cutout).expect("leaf");
        let material = white_card().with_base_texture(leaf).with_alpha_cutoff(0.5);
        let (scene, camera) = leaf_scene(card, material);
        let capture = draw(&gpu, &mut renderer, &scene, frames_for(&quality));
        write_evidence(&format!("mask-{name}"), &capture);
        let (quad, hole) = quad_and_hole_pixels(&capture, &camera, 0.7);
        println!("{name}: {quad} quad pixels outside the cutout, {hole} undrawn inside");
        assert_eq!(quad, 0, "{name}: the masked card drew {quad} pixels of its quad outside the cutout");
        assert_eq!(hole, 0, "{name}: the cutout itself is drawn whole");
        if golden {
            check_golden(&format!("mask-{name}"), &capture, 2);
        }
    }
}

#[test]
#[ignore = "needs a Metal adapter"]
fn metal_a_masked_leaf_card_casts_a_cutout_shadow() {
    let Some(gpu) = gpu() else { return };
    for (name, quality) in [("legacy", legacy()), ("hdr-msaa", hdr_msaa()), ("hdr-taa", hdr_taa())] {
        let mut renderer = renderer(&gpu, &quality);
        let card = renderer.add_mesh(&gpu, card_mesh(1.0)).expect("card");
        let leaf = renderer.add_texture(&gpu, &disc_texture(0.25, true), TextureKind::Cutout).expect("leaf with a hole");
        let camera = CameraDesc::look_at([0.0, 4.0, 4.0], [0.0, 0.0, 0.0]);
        let mut scene = Scene::new(camera, CLEAR);
        // The sun from +x+y: the card at (1, 1, 0) shadows the ground around the origin.
        scene.lighting.sun_dir = [1.0, 1.0, 0.0];
        scene.lighting.shadows = true;
        scene.draw(card, ground_model([8.0, 8.0], 0.0), white_card());
        let leaf_model = (Mat4::from_translation(Vec3::new(1.0, 1.0, 0.0)) * Mat4::from_rotation_x(-std::f32::consts::FRAC_PI_2)).to_cols_array();
        scene.draw(card, leaf_model, white_card().with_base_texture(leaf).with_alpha_cutoff(0.5).with_double_sided(true));
        let capture = draw(&gpu, &mut renderer, &scene, frames_for(&quality));
        write_evidence(&format!("mask-shadow-{name}"), &capture);
        let size = (capture.width(), capture.height());
        let hole = mean_luma_near(&capture, pixel(&camera, size, Vec3::ZERO), 2.0);
        let shade = mean_luma_near(&capture, pixel(&camera, size, Vec3::new(0.0, 0.0, 0.4)), 2.0);
        let lit = mean_luma_near(&capture, pixel(&camera, size, Vec3::new(0.0, 0.0, 1.6)), 2.0);
        println!("{name}: ground lit {lit:.1}, under the hole {hole:.1}, under the leaf {shade:.1}");
        assert!(shade < lit * 0.75, "{name}: the leaf shadows the ground ({shade:.1} against {lit:.1})");
        assert!(hole > lit * 0.9, "{name}: light passes the leaf's hole ({hole:.1} against {lit:.1})");
    }
}

#[test]
#[ignore = "needs a Metal adapter"]
fn metal_a_double_sided_card_is_drawn_and_lit_from_behind() {
    let Some(gpu) = gpu() else { return };
    for (name, quality) in [("legacy", legacy()), ("hdr-taa", hdr_taa())] {
        let mut renderer = renderer(&gpu, &quality);
        let card = renderer.add_mesh(&gpu, card_mesh(1.0)).expect("card");
        let camera = CameraDesc::look_at([0.0, 0.0, 4.0], [0.0, 0.0, 0.0]);
        let shot = |model: [f32; 16], material: Material, renderer: &mut Renderer| {
            let mut scene = Scene::new(camera, CLEAR);
            scene.lighting.sun_dir = [0.0, 0.3, 1.0];
            scene.lighting.shadows = false;
            scene.draw(card, model, material);
            draw(&gpu, renderer, &scene, frames_for(&quality))
        };
        let facing = scaled([0.0; 3], [2.0, 2.0, 1.0]);
        let turned = (Mat4::from_rotation_y(std::f32::consts::PI) * Mat4::from_scale(Vec3::new(2.0, 2.0, 1.0))).to_cols_array();
        let front = shot(facing, white_card(), &mut renderer);
        let culled = shot(turned, white_card(), &mut renderer);
        let back = shot(turned, white_card().with_double_sided(true), &mut renderer);
        write_evidence(&format!("double-sided-{name}"), &back);
        let size = (front.width(), front.height());
        let centre = pixel(&camera, size, Vec3::ZERO);
        let background = background_luma(&culled);
        let (front, culled, back) = (mean_luma_near(&front, centre, 6.0), mean_luma_near(&culled, centre, 6.0), mean_luma_near(&back, centre, 6.0));
        println!("{name}: front {front:.1}, single-sided back {culled:.1}, double-sided back {back:.1}, background {background:.1}");
        assert!((culled - background).abs() < 2.0, "{name}: a single-sided card's back is culled");
        assert!((back - front).abs() <= front * 0.03, "{name}: a double-sided card's back is lit like its front ({back:.1} against {front:.1})");
    }
}

#[test]
#[ignore = "needs a Metal adapter"]
fn metal_the_prepass_depth_holds_the_cutout() {
    let Some(gpu) = gpu() else { return };
    let quality = hdr_taa();
    let mut renderer = renderer(&gpu, &quality);
    renderer.set_depth_readback(true);
    let card = renderer.add_mesh(&gpu, card_mesh(1.0)).expect("card");
    let leaf = renderer.add_texture(&gpu, &disc_texture(0.25, true), TextureKind::Cutout).expect("leaf with a hole");
    let (scene, camera) = leaf_scene(card, white_card().with_base_texture(leaf).with_alpha_cutoff(0.5));
    renderer.render(&gpu, &scene, CullPath::Gpu).expect("frame");
    assert!(renderer.last_prepass().is_some(), "the prepass ran");
    let depth = renderer.read_prepass_depth(&gpu).expect("prepass depth");
    let at = |world: Vec3| {
        let (x, y) = pixel(&camera, (WIDTH, HEIGHT), world);
        depth[(y as u32 * WIDTH + x as u32) as usize]
    };
    let (hole, body) = (at(Vec3::ZERO), at(Vec3::new(0.8, 0.0, 0.0)));
    println!("prepass depth: hole {hole}, card {body}");
    assert_eq!(hole, 0.0, "the hole keeps the cleared (reverse-Z far) depth");
    assert!(body > 0.0, "the card's body writes its depth");
}

// ---------------------------------------------------------------------------------------------
// GPU rows: LG-02 anisotropy

/// Stripes along v (each 4 texels of a 16-texel period white), so lines run away from the viewer
/// across the ground.
fn stripes() -> TextureData {
    texture(256, |x, _| if x % 16 < 8 { [240, 240, 240, 255] } else { [30, 30, 30, 255] })
}

/// The mean absolute luma step between horizontal neighbours over rows `rows`: how much stripe
/// detail is left there.
fn detail(capture: &Capture, rows: std::ops::Range<u32>) -> f32 {
    let luma = lumas(capture);
    let w = capture.width() as usize;
    let mut sum = 0.0;
    let mut count = 0.0;
    for y in rows {
        let row = &luma[y as usize * w..(y as usize + 1) * w];
        for pair in row[w / 4..3 * w / 4].windows(2) {
            sum += (pair[0] - pair[1]).abs();
            count += 1.0;
        }
    }
    sum / count
}

#[test]
#[ignore = "needs a Metal adapter"]
fn metal_the_textured_ground_at_80_degrees_keeps_its_stripes() {
    let Some(gpu) = gpu() else { return };
    let size = (320, 180);
    let mut quality = hdr_msaa();
    quality.anisotropy = preset_quality(QualityPreset::High, desktop()).anisotropy;
    let mut trilinear = hdr_msaa();
    trilinear.anisotropy = 1;
    let shot = |quality: &Quality| {
        let mut renderer = renderer_sized(&gpu, quality, size, desktop());
        let ground = renderer.add_mesh(&gpu, card_mesh(40.0)).expect("ground");
        let lines = renderer.add_texture(&gpu, &stripes(), TextureKind::Color).expect("stripes");
        // 10 degrees under the horizon: the ground is seen at 80 degrees from its normal.
        let pitch = 10f32.to_radians();
        let camera = CameraDesc::look_at([0.0, 1.0, 0.0], [0.0, 1.0 - 10.0 * libm::tanf(pitch), -10.0]);
        let mut scene = Scene::new(camera, CLEAR);
        scene.lighting.shadows = false;
        scene.lighting.sun_dir = [0.0, 1.0, 0.2];
        scene.draw(ground, ground_model([60.0, 60.0], 0.0), Material::color([255; 4]).with_base_texture(lines).with_pbr(0.0, 1.0));
        draw(&gpu, &mut renderer, &scene, 1)
    };
    let sharp = shot(&quality);
    let blurred = shot(&trilinear);
    write_evidence("anisotropy-ground", &sharp);
    write_evidence("anisotropy-ground-trilinear", &blurred);
    // The far band, about 10-25 units away: the footprint there is 6-15 texels deep per pixel.
    let rows = 86..100;
    let (sharp_detail, blurred_detail) = (detail(&sharp, rows.clone()), detail(&blurred, rows));
    println!("stripe detail in the far band: anisotropic {sharp_detail:.2}, trilinear {blurred_detail:.2} levels");
    assert!(sharp_detail > blurred_detail * 2.0, "the high preset's anisotropy keeps the far stripes ({sharp_detail:.2} against {blurred_detail:.2})");
    check_golden("anisotropy-ground", &sharp, 2);
}

/// Anisotropy is a resource knob (LG-02): a running renderer that changes it draws the next frame
/// with the new sampler, as a renderer made with it does.
#[test]
#[ignore = "needs a Metal adapter"]
fn metal_a_quality_change_of_anisotropy_reaches_the_next_frame() {
    let Some(gpu) = gpu() else { return };
    let size = (320, 180);
    let (mut trilinear, mut sharp) = (hdr_msaa(), hdr_msaa());
    trilinear.anisotropy = 1;
    sharp.anisotropy = 16;
    let ground_scene = |renderer: &mut Renderer| {
        let ground = renderer.add_mesh(&gpu, card_mesh(40.0)).expect("ground");
        let lines = renderer.add_texture(&gpu, &stripes(), TextureKind::Color).expect("stripes");
        let pitch = 10f32.to_radians();
        let camera = CameraDesc::look_at([0.0, 1.0, 0.0], [0.0, 1.0 - 10.0 * libm::tanf(pitch), -10.0]);
        let mut scene = Scene::new(camera, CLEAR);
        scene.lighting.shadows = false;
        scene.lighting.sun_dir = [0.0, 1.0, 0.2];
        scene.draw(ground, ground_model([60.0, 60.0], 0.0), Material::color([255; 4]).with_base_texture(lines).with_pbr(0.0, 1.0));
        scene
    };
    let mut switched = renderer_sized(&gpu, &trilinear, size, desktop());
    let scene = ground_scene(&mut switched);
    let before = draw(&gpu, &mut switched, &scene, 1);
    switched.set_quality(&sharp);
    let after = draw(&gpu, &mut switched, &scene, 1);
    let mut fresh = renderer_sized(&gpu, &sharp, size, desktop());
    let fresh_scene = ground_scene(&mut fresh);
    let reference = draw(&gpu, &mut fresh, &fresh_scene, 1);
    assert!(before.bgra() != after.bgra(), "the switch changes the far stripes");
    assert!(after.bgra() == reference.bgra(), "the switched renderer draws as one made with 16x anisotropy");
}

// ---------------------------------------------------------------------------------------------
// GPU rows: LG-09 occlusion

/// An ORM texture: occlusion (red) `left` on the left half and 255 on the right, roughness 1,
/// metallic 0.
fn orm(left: u8) -> TextureData {
    texture(64, |x, _| [if x < 32 { left } else { 255 }, 255, 0, 255])
}

#[test]
#[ignore = "needs a Metal adapter"]
fn metal_an_occlusion_map_darkens_the_ambient_light_and_never_the_sun() {
    let Some(gpu) = gpu() else { return };
    for (name, quality) in [("legacy", legacy()), ("hdr", hdr_msaa())] {
        for separate in [false, true] {
            let mut renderer = renderer(&gpu, &quality);
            let card = renderer.add_mesh(&gpu, card_mesh(1.0)).expect("card");
            let packed = renderer.add_texture(&gpu, &orm(51), TextureKind::Data).expect("orm");
            let occlusion = renderer.add_texture(&gpu, &orm(51), TextureKind::Data).expect("occlusion");
            let mr = renderer.add_texture(&gpu, &orm(255), TextureKind::Data).expect("metal-rough");
            let material = if separate {
                white_card().with_metal_rough_texture(mr).with_occlusion_texture(occlusion, 1.0)
            } else {
                white_card().with_metal_rough_texture(packed).with_occlusion_texture(packed, 1.0)
            };
            let camera = CameraDesc::look_at([0.0, 0.0, 4.0], [0.0, 0.0, 0.0]);
            let shot = |ambient: f32, sun: f32, renderer: &mut Renderer| {
                let mut scene = Scene::new(camera, CLEAR);
                scene.lighting.shadows = false;
                scene.lighting.sun_dir = [0.0, 0.0, 1.0];
                scene.lighting.ambient_intensity = ambient;
                scene.lighting.sun_intensity = sun;
                scene.draw(card, scaled([0.0; 3], [2.0, 2.0, 1.0]), material);
                draw(&gpu, renderer, &scene, 1)
            };
            let size = (WIDTH, HEIGHT);
            let (left, right) = (pixel(&camera, size, Vec3::new(-0.5, 0.0, 0.0)), pixel(&camera, size, Vec3::new(0.5, 0.0, 0.0)));
            let ambient = shot(0.6, 0.0, &mut renderer);
            let sun = shot(0.0, 1.0, &mut renderer);
            write_evidence(&format!("occlusion-{name}-{}", if separate { "separate" } else { "orm" }), &ambient);
            let ratio = |capture: &Capture| (mean_luma_near(capture, left, 4.0) - background_luma(capture)) / (mean_luma_near(capture, right, 4.0) - background_luma(capture));
            let (ambient_ratio, sun_ratio) = (ratio(&ambient), ratio(&sun));
            println!("{name} {}: occluded / open luma under ambient {ambient_ratio:.3}, under the sun {sun_ratio:.3}", if separate { "separate" } else { "orm" });
            assert!(ambient_ratio < 0.85, "{name}: the occlusion map darkens the ambient light ({ambient_ratio:.3})");
            assert!((sun_ratio - 1.0).abs() < 0.02, "{name}: the sun is never occluded by the map ({sun_ratio:.3})");
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Bodycam B2b: UV scale and world-aligned box projection

#[test]
fn uv_mapping_rows_hold_hostile_scales_and_the_identity_is_the_legacy_row() {
    assert_eq!(UvMapping::default().row(), [0.0; 4], "the mesh's UVs as authored keep the legacy extension row");
    assert_eq!(UvMapping::Mesh { scale: [1.0, 1.0] }.row(), [0.0; 4]);
    assert_eq!(UvMapping::Mesh { scale: [4.0, 3.0] }.row(), [4.0, 3.0, 0.0, 0.0]);
    assert_eq!(UvMapping::World { tiles_per_metre: [0.5, 0.5] }.row(), [0.5, 0.5, 1.0, 0.0]);
    let hostile = [f32::NAN, f32::INFINITY, f32::NEG_INFINITY, 0.0, -2.0];
    for value in hostile {
        assert_eq!(UvMapping::Mesh { scale: [value, 2.0] }.row(), [1.0, 2.0, 0.0, 0.0], "{value} reads as 1");
        assert_eq!(UvMapping::World { tiles_per_metre: [value, value] }.row(), [1.0, 1.0, 1.0, 0.0], "{value} reads as 1");
    }
    assert_eq!(UvMapping::Mesh { scale: [1.0e-9, 1.0e9] }.row(), [UV_SCALE_MIN, UV_SCALE_MAX, 0.0, 0.0]);
    let plain = Material::color([200; 4]);
    assert_eq!(plain.to_gpu_ext(), genex_render::layout::MATERIAL_EXT_NONE, "a plain material's extension row is unchanged");
    assert_eq!(plain.with_uv(UvMapping::World { tiles_per_metre: [2.0, 2.0] }).to_gpu_ext().uv, [2.0, 2.0, 1.0, 0.0]);
}

#[test]
fn materials_that_differ_only_in_their_uv_mapping_take_their_own_rows() {
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 0.0, 4.0], [0.0; 3]), CLEAR);
    let plain = white_card();
    scene.draw(MeshId::CUBE, scaled([0.0; 3], [1.0; 3]), plain);
    scene.draw(MeshId::CUBE, scaled([2.0, 0.0, 0.0], [1.0; 3]), plain.with_uv(UvMapping::Mesh { scale: [4.0, 1.0] }));
    scene.draw(MeshId::CUBE, scaled([4.0, 0.0, 0.0], [1.0; 3]), plain.with_uv(UvMapping::World { tiles_per_metre: [4.0, 1.0] }));
    scene.draw(MeshId::CUBE, scaled([6.0, 0.0, 0.0], [1.0; 3]), plain.with_uv(UvMapping::Mesh { scale: [1.0, 1.0] }));
    let plan = FramePlan::build(&scene, &MeshLibrary::new(), 1.5).expect("plan");
    assert_eq!(plan.materials.len(), 3, "an identity scale shares the plain row; a scale and a projection each take one");
}

/// Two periods of light and dark across one tile: a stripe edge every half tile.
fn halves() -> TextureData {
    texture(64, |x, _| if x < 32 { [240, 240, 240, 255] } else { [30, 30, 30, 255] })
}

/// How many times the luma along the row through `y` crosses the middle of its range between
/// `from` and `to` (pixels, exclusive of two pixels at each end): the stripe edges seen.
fn crossings(capture: &Capture, y: f32, from: f32, to: f32) -> usize {
    let luma = lumas(capture);
    let w = capture.width() as usize;
    let row = y as usize * w;
    let span: Vec<f32> = ((from as usize + 2)..(to as usize - 2)).map(|x| luma[row + x]).collect();
    let (low, high) = span.iter().fold((f32::MAX, f32::MIN), |(low, high), v| (low.min(*v), high.max(*v)));
    let middle = (low + high) / 2.0;
    span.windows(2).filter(|pair| (pair[0] < middle) != (pair[1] < middle)).count()
}

#[test]
#[ignore = "needs a Metal adapter"]
fn metal_a_world_projected_wall_tiles_at_one_density_whatever_its_width() {
    let Some(gpu) = gpu() else { return };
    let size = (320, 180);
    let camera = CameraDesc::look_at([0.0, 0.0, 10.0], [0.0, 0.0, 0.0]);
    // Walls 1 m and 4 m wide, 1 m tall and 0.2 m deep: their front faces at z = 0.1.
    let walls = [(-3.0, 1.0), (2.0, 4.0)];
    let shot = |uv: UvMapping| {
        let mut renderer = renderer_sized(&gpu, &hdr_msaa(), size, desktop());
        let stripes = renderer.add_texture(&gpu, &halves(), TextureKind::Color).expect("stripes");
        let mut scene = Scene::new(camera, CLEAR);
        scene.lighting.shadows = false;
        scene.lighting.sun_dir = [0.0, 0.2, 1.0];
        let material = Material::color([255; 4]).with_base_texture(stripes).with_pbr(0.0, 1.0).with_uv(uv);
        for (x, width) in walls {
            scene.draw(MeshId::CUBE, scaled([x, 0.0, 0.0], [width, 1.0, 0.2]), material);
        }
        draw(&gpu, &mut renderer, &scene, 1)
    };
    let edges = |capture: &Capture| {
        walls.map(|(x, width)| {
            let left = pixel(&camera, size, Vec3::new(x - width / 2.0, 0.0, 0.1));
            let right = pixel(&camera, size, Vec3::new(x + width / 2.0, 0.0, 0.1));
            crossings(capture, left.1, left.0, right.0)
        })
    };
    let mesh = shot(UvMapping::default());
    let world = shot(UvMapping::World { tiles_per_metre: [1.0, 1.0] });
    write_evidence("uv-mesh-walls", &mesh);
    write_evidence("uv-world-walls", &world);
    let (mesh_edges, world_edges) = (edges(&mesh), edges(&world));
    println!("stripe edges on the 1 m and 4 m walls: mesh UVs {mesh_edges:?}, world projection {world_edges:?}");
    assert!(mesh_edges[1] <= 2, "the mesh's UVs stretch one tile over the 4 m wall ({mesh_edges:?})");
    assert!(world_edges[1] >= 6, "the world projection tiles the 4 m wall once a metre ({world_edges:?})");
    assert!(world_edges[0] <= 2, "and the 1 m wall once ({world_edges:?})");
    let scaled_mesh = shot(UvMapping::Mesh { scale: [4.0, 1.0] });
    let scaled_edges = edges(&scaled_mesh);
    assert!(scaled_edges[0] >= 6 && scaled_edges[1] >= 6, "a mesh scale repeats the texture on every wall ({scaled_edges:?})");
}

// ---------------------------------------------------------------------------------------------
// GPU rows: C8 specular AA, LG-04 the sun's disc

/// A bumpy tangent-space normal map: ridges every 4 texels along u.
fn ridges() -> TextureData {
    texture(64, |x, _| {
        let tilt = libm::sinf(std::f32::consts::TAU * x as f32 / 4.0) * 0.45;
        let n = Vec3::new(tilt, 0.0, 1.0).normalize();
        let byte = |c: f32| ((c * 0.5 + 0.5) * 255.0).round() as u8;
        [byte(n.x), byte(n.y), byte(n.z), 255]
    })
}

#[test]
#[ignore = "needs a Metal adapter"]
fn metal_specular_aa_leaves_a_flat_normal_mapped_card_to_its_mips() {
    let Some(gpu) = gpu() else { return };
    let shot = |specular_aa: bool| {
        let mut quality = hdr_msaa();
        quality.specular_aa = specular_aa;
        let mut renderer = renderer(&gpu, &quality);
        let card = renderer.add_mesh(&gpu, card_mesh(1.0)).expect("card");
        let normals = renderer.add_texture(&gpu, &ridges(), TextureKind::Normal).expect("normal map");
        let camera = CameraDesc::look_at([0.0, 0.0, 2.2], [0.0, 0.0, 0.0]);
        let mut scene = Scene::new(camera, CLEAR);
        scene.lighting.shadows = false;
        scene.lighting.sun_dir = [0.0, 0.0, 1.0];
        scene.draw(card, scaled([0.0; 3], [2.0, 2.0, 1.0]), Material::color([200, 200, 200, 255]).with_pbr(0.0, 0.25).with_normal_map(normals, 1.0));
        draw(&gpu, &mut renderer, &scene, 1)
    };
    let (filtered, unfiltered) = (shot(true), shot(false));
    write_evidence("specular-aa-flat-on", &filtered);
    write_evidence("specular-aa-flat-off", &unfiltered);
    let differing = filtered.bgra().iter().zip(unfiltered.bgra()).filter(|(a, b)| a.abs_diff(**b) > 1).count();
    println!("{differing} channels differ between specular AA on and off on a flat card");
    assert_eq!(differing, 0, "a flat card's geometric normal never turns: specular AA leaves its normal-map detail to Toksvig");
}

/// The share of pixels whose luma moves by more than 2 levels between consecutive frames of a still
/// camera, over `frames` frames after the settle.
fn still_flicker(gpu: &Gpu, renderer: &mut Renderer, scene: &Scene, frames: u64) -> f32 {
    let mut last: Option<Vec<f32>> = None;
    let (mut moved, mut total) = (0usize, 0usize);
    for index in 0..SETTLE_FRAMES + frames {
        renderer.set_frame_index(index);
        renderer.render(gpu, scene, CullPath::Gpu).expect("frame");
        if index < SETTLE_FRAMES {
            continue;
        }
        let luma = lumas(&renderer.capture(gpu).expect("capture"));
        if let Some(previous) = &last {
            moved += luma.iter().zip(previous).filter(|(a, b)| (**a - **b).abs() > 2.0).count();
            total += luma.len();
        }
        last = Some(luma);
    }
    moved as f32 / total as f32
}

#[test]
#[ignore = "needs a Metal adapter"]
fn metal_a_still_normal_mapped_floor_under_a_grazing_sun_does_not_flicker() {
    let Some(gpu) = gpu() else { return };
    let mut quality = hdr_taa();
    quality.specular_aa = true;
    let mut renderer = renderer_sized(&gpu, &quality, (256, 144), desktop());
    let floor = renderer.add_mesh(&gpu, card_mesh(24.0)).expect("floor");
    let normals = renderer.add_texture(&gpu, &ridges(), TextureKind::Normal).expect("normal map");
    let camera = CameraDesc::look_at([0.0, 1.2, 4.0], [0.0, 0.0, -4.0]);
    let mut scene = Scene::new(camera, CLEAR);
    scene.lighting.shadows = false;
    // A low sun ahead of the camera: its glint runs down the floor towards the viewer.
    scene.lighting.sun_dir = [0.0, 0.18, -1.0];
    scene.draw(floor, ground_model([24.0, 24.0], 0.0), Material::color([180, 180, 180, 255]).with_pbr(0.0, 0.2).with_normal_map(normals, 1.0));
    let share = still_flicker(&gpu, &mut renderer, &scene, 16);
    write_evidence("still-floor", &renderer.capture(&gpu).expect("capture"));
    println!("still-camera flicker on the normal-mapped floor: {:.4}% of pixels", share * 100.0);
    assert!(share <= 0.002, "a still camera's normal-mapped floor flickers on {:.3}% of its pixels", share * 100.0);
}

#[test]
#[ignore = "needs a Metal adapter"]
fn metal_the_sun_glint_on_a_polished_floor_is_as_wide_as_the_sun_disc() {
    let Some(gpu) = gpu() else { return };
    let size = (240, 240);
    let quality = hdr_plain();
    let mut renderer = renderer_sized(&gpu, &quality, size, desktop());
    let floor = renderer.add_mesh(&gpu, card_mesh(1.0)).expect("floor");
    let fov = 4.0f32;
    let mut camera = CameraDesc::look_at([0.0, 2.0, 4.0], [0.0, 0.0, 0.0]);
    camera.fovy_degrees = fov;
    let mut scene = Scene::new(camera, CLEAR);
    scene.lighting.shadows = false;
    scene.lighting.ambient_intensity = 0.0;
    // The sun mirrored into the camera at the image's centre.
    scene.lighting.sun_dir = [0.0, 2.0, -4.0];
    scene.draw(floor, ground_model([4.0, 4.0], 0.0), Material::color([255; 4]).with_pbr(1.0, 0.0));
    renderer.render(&gpu, &scene, CullPath::Gpu).expect("frame");
    let radiance = renderer.read_scene(&gpu).expect("the HDR scene reads back");
    let luminance: Vec<f32> = radiance.iter().map(|t| 0.2126 * t[0] + 0.7152 * t[1] + 0.0722 * t[2]).collect();
    let peak = luminance.iter().copied().fold(0.0, f32::max);
    // The glint's widest chord at half its peak: its diameter across the image.
    let width = luminance.chunks_exact(size.0 as usize).map(|row| row.iter().filter(|l| **l >= peak * 0.5).count()).max().unwrap_or(0) as f32;
    let radius = genex_render::settings::DEFAULT_SUN_ANGULAR_RADIUS_DEG.to_radians();
    let px_per_radian = size.1 as f32 / (2.0 * libm::tanf(fov.to_radians() * 0.5));
    let disc = 2.0 * radius * px_per_radian;
    println!("sun glint: half-maximum width {width} px, the sun's disc {disc:.1} px, peak {peak:.1}");
    assert!(width >= disc * 0.85, "the glint ({width} px) is narrower than the sun's disc ({disc:.1} px): the sun shades as a point");
    assert!(width <= disc * 1.6, "the glint ({width} px) stays about the disc's size ({disc:.1} px)");
}

/// The unit check of the roughness floor's split by class lives in `src/renderer.rs`
/// (`phones_shade_with_a_coarser_roughness_floor_than_desktops`); this row checks a highlight
/// drawn on a phone is no sharper than the floor allows.
#[test]
#[ignore = "needs a Metal adapter"]
fn metal_a_phone_s_polished_highlight_is_wider_than_a_desktop_s() {
    let Some(gpu) = gpu() else { return };
    let size = (160, 160);
    let width_on = |class: DeviceClass| {
        let mut renderer = renderer_sized(&gpu, &hdr_plain(), size, class);
        let floor = renderer.add_mesh(&gpu, card_mesh(1.0)).expect("floor");
        let mut camera = CameraDesc::look_at([0.0, 2.0, 4.0], [0.0, 0.0, 0.0]);
        camera.fovy_degrees = 6.0;
        let mut scene = Scene::new(camera, CLEAR);
        scene.lighting.shadows = false;
        scene.lighting.ambient_intensity = 0.0;
        scene.lighting.sun_dir = [0.0, 2.0, -4.0];
        scene.draw(floor, ground_model([4.0, 4.0], 0.0), Material::color([255; 4]).with_pbr(1.0, 0.0));
        renderer.render(&gpu, &scene, CullPath::Gpu).expect("frame");
        let radiance = renderer.read_scene(&gpu).expect("scene");
        let luminance: Vec<f32> = radiance.iter().map(|t| 0.2126 * t[0] + 0.7152 * t[1] + 0.0722 * t[2]).collect();
        let peak = luminance.iter().copied().fold(0.0, f32::max);
        luminance.iter().filter(|l| **l >= peak * 0.5).count()
    };
    let desktop = width_on(desktop());
    let phone = width_on(DeviceClass::new(FormFactor::Mobile, PerformanceTier::High));
    println!("half-maximum area: desktop {desktop} px, phone {phone} px");
    assert!(phone > desktop, "a phone's floor (0.089) widens the highlight past a desktop's (0.045)");
}
