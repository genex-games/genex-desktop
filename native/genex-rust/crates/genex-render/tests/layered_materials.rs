//! AAA materials lane (review WP-7, WP-15): layered materials (cover, detail maps, a second
//! height-blended layer, parallax occlusion mapping) and the extra lobes (clearcoat, sheen,
//! anisotropy, transmission).
//!
//! The CPU rows run everywhere. The GPU rows are `#[ignore]`d and every name contains `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked --test layered_materials -- --ignored metal
//!
//! `GENEX_RENDER_EVIDENCE_DIR` receives each compared frame (raw BGRA, the size in the name).

use std::path::PathBuf;

use genex_render::capture::Capture;
use genex_render::device_class::{DeviceClass, FormFactor, PerformanceTier};
use genex_render::layers::{
    Cover, Detail, LAYER_NO_TEXTURE, LAYER_ROWS_NONE, LayerMask, LayerTier, Lobes, MATERIAL_EXT_FLAG_COVER, MATERIAL_EXT_FLAG_DETAIL,
    MATERIAL_EXT_FLAG_LAYER, MATERIAL_EXT_FLAG_LOBES, MATERIAL_EXT_FLAG_PARALLAX, MaterialLayer, MaterialLayers, PARALLAX_DEPTH_MAX,
    PARALLAX_STEPS_MAX, PARALLAX_STEPS_MIN, Parallax,
};
use genex_render::layout::MATERIAL_EXT_NONE;
use genex_render::presets::preset_quality;
use genex_render::scene::{CameraDesc, Material, MeshId, Scene, scaled};
use genex_render::settings::{AntiAliasing, Quality, QualityPreset, SceneFormat, TextureClass};
use genex_render::texture::{TextureData, TextureId, TextureKind};
use genex_render::{CullPath, Gpu, RenderOptions, Renderer};
use glam::{Mat4, Vec3};

const SIZE: (u32, u32) = (192, 144);
const CLEAR: [u8; 4] = [10, 12, 18, 255];

// ---------------------------------------------------------------------------------------------
// CPU rows

fn flags(material: Material) -> u32 {
    material.to_gpu_ext().params[2] as u32
}

#[test]
fn a_material_without_layers_keeps_the_plain_extension_row() {
    let plain = Material::color([200, 180, 160, 255]);
    assert_eq!(plain.to_gpu_ext(), MATERIAL_EXT_NONE);
    let none = plain.with_layers(MaterialLayers::default());
    assert_eq!(none.to_gpu_ext(), MATERIAL_EXT_NONE);
    assert_eq!(MaterialLayers::default().rows(), (LAYER_ROWS_NONE, 0));
}

#[test]
fn snow_cover_writes_its_slope_as_a_cosine_and_sets_its_flag() {
    let layers = MaterialLayers { cover: Some(Cover::SNOW), ..MaterialLayers::default() };
    let row = Material::color([90; 4]).with_layers(layers).to_gpu_ext();
    assert_eq!(row.params[2] as u32 & MATERIAL_EXT_FLAG_COVER, MATERIAL_EXT_FLAG_COVER);
    assert_eq!(row.cover, [0.80, 0.83, 0.88, 1.0]);
    assert!((row.cover_shape[0] - libm::cosf(55f32.to_radians())).abs() < 1e-6, "slope cosine {}", row.cover_shape[0]);
    let edge = (libm::cosf(43f32.to_radians()) - libm::cosf(55f32.to_radians())).max(0.02);
    assert!((row.cover_shape[1] - edge).abs() < 1e-6, "edge {} vs {edge}", row.cover_shape[1]);
    assert_eq!([row.cover_shape[2], row.cover_shape[3]], [0.62, 0.85]);
    assert_eq!(row.cover_look, [0.3, 0.6, 0.0, 1.0]);
}

#[test]
fn a_cover_of_no_amount_or_a_hostile_one_changes_nothing() {
    for amount in [0.0, -1.0, f32::NAN, f32::NEG_INFINITY] {
        let layers = MaterialLayers { cover: Some(Cover::SNOW.shaped(amount, 55.0, 0.3)), ..MaterialLayers::default() };
        assert_eq!(Material::color([90; 4]).with_layers(layers).to_gpu_ext(), MATERIAL_EXT_NONE, "amount {amount}");
    }
}

#[test]
fn hostile_cover_values_are_held_in_range() {
    let hostile = Cover {
        color: [f32::NAN, 4.0, -2.0],
        amount: f32::INFINITY,
        slope: 900.0,
        softness: f32::NAN,
        noise: -3.0,
        noise_metres: 0.0,
        roughness: f32::NAN,
        flatten: 7.0,
        opacity: f32::NAN,
        darken: -1.0,
    };
    let row = Material::color([90; 4]).with_layers(MaterialLayers { cover: Some(hostile), ..MaterialLayers::default() }).to_gpu_ext();
    // An infinite amount reads as no cover (not finite), so a finite large one instead.
    assert_eq!(row, MATERIAL_EXT_NONE);
    let row = Material::color([90; 4]).with_layers(MaterialLayers { cover: Some(Cover { amount: 9.0, ..hostile }), ..MaterialLayers::default() }).to_gpu_ext();
    for value in row.cover.iter().chain(&row.cover_shape).chain(&row.cover_look) {
        assert!(value.is_finite(), "{row:?}");
    }
    assert_eq!(row.cover, [0.0, 1.0, 0.0, 1.0]);
    assert_eq!(row.cover_shape[0], -1.0, "180 degrees covers every face");
    assert!(row.cover_shape[1] >= 0.02);
    assert_eq!([row.cover_shape[2], row.cover_shape[3]], [1.0, 1.0]);
    assert_eq!(row.cover_look[0], 0.0);
    assert!(row.cover_look[1] >= 0.02);
    assert_eq!([row.cover_look[2], row.cover_look[3]], [0.0, 1.0]);
}

/// A texture id of `kind` at `layer` of size class `class` (`TextureId` is plain data).
fn texture_id(kind: TextureKind, class: u32, layer: u32) -> TextureId {
    let classes = [TextureClass::S256, TextureClass::S512, TextureClass::S1024, TextureClass::S2048];
    TextureId::in_class(kind, classes[class as usize], layer)
}

#[test]
fn layer_rows_name_textures_by_class_and_layer_and_skip_wrong_kinds() {
    let albedo = texture_id(TextureKind::Color, 2, 7);
    let normal = texture_id(TextureKind::Normal, 1, 3);
    let detail = Detail { albedo: Some(albedo), normal: Some(normal), tiles: 8.0, albedo_strength: 0.5, normal_strength: 0.75, fade_metres: 12.0 };
    let row = Material::color([90; 4]).with_layers(MaterialLayers { detail: Some(detail), ..MaterialLayers::default() }).to_gpu_ext();
    assert_eq!(row.detail, [2.0 * 65_536.0 + 7.0, 65_536.0 + 3.0, 8.0, 0.5]);
    assert_eq!(row.detail_look, [0.75, 12.0, 0.0, 0.0]);
    assert_eq!(row.params[2] as u32 & MATERIAL_EXT_FLAG_DETAIL, MATERIAL_EXT_FLAG_DETAIL);
    // A colour texture in the normal slot and a data texture in the albedo slot: neither is read.
    let swapped = Detail { albedo: Some(normal), normal: Some(albedo), ..detail };
    let row = Material::color([90; 4]).with_layers(MaterialLayers { detail: Some(swapped), ..MaterialLayers::default() }).to_gpu_ext();
    assert_eq!(row, MATERIAL_EXT_NONE);
}

#[test]
fn a_second_layer_writes_its_mask_and_maps() {
    let layer = MaterialLayer {
        base: Some(texture_id(TextureKind::Color, 0, 1)),
        normal: None,
        orm: Some(texture_id(TextureKind::Data, 0, 2)),
        height: Some(texture_id(TextureKind::Data, 0, 3)),
        tint: [0.5, 0.6, 0.7],
        roughness: 0.8,
        tiles: 2.0,
        mask: LayerMask::Noise,
        mask_metres: 3.0,
        blend_depth: 0.3,
    };
    let row = Material::color([90; 4]).with_layers(MaterialLayers { layer: Some(layer), ..MaterialLayers::default() }).to_gpu_ext();
    assert_eq!(row.layer, [1.0, LAYER_NO_TEXTURE, 2.0, 3.0]);
    assert_eq!(row.layer_shape, [0.0, 0.3, 3.0, 2.0]);
    assert_eq!(row.layer_tint, [0.5, 0.6, 0.7, 0.8]);
    assert_eq!(flags(Material::color([90; 4]).with_layers(MaterialLayers { layer: Some(layer), ..MaterialLayers::default() })) & MATERIAL_EXT_FLAG_LAYER, MATERIAL_EXT_FLAG_LAYER);
    for (mask, code) in [(LayerMask::Noise, 0.0), (LayerMask::Up, 1.0)] {
        let row = Material::color([90; 4]).with_layers(MaterialLayers { layer: Some(MaterialLayer { mask, ..layer }), ..MaterialLayers::default() }).to_gpu_ext();
        assert_eq!(row.layer_shape[0], code, "{mask:?}");
    }
}

#[test]
fn parallax_holds_its_depth_and_steps_and_needs_a_height_map() {
    let height = texture_id(TextureKind::Data, 1, 4);
    let at = |depth: f32, steps: u32| {
        let layers = MaterialLayers { parallax: Some(Parallax { height, depth, steps }), ..MaterialLayers::default() };
        Material::color([90; 4]).with_layers(layers).to_gpu_ext()
    };
    assert_eq!(at(0.04, 24).parallax, [65_536.0 + 4.0, 0.04, 24.0, 0.0]);
    assert_eq!(at(9.0, 1000).parallax, [65_536.0 + 4.0, PARALLAX_DEPTH_MAX, PARALLAX_STEPS_MAX as f32, 0.0]);
    assert_eq!(at(0.04, 0).parallax[2], PARALLAX_STEPS_MIN as f32);
    assert_eq!(at(0.0, 24), MATERIAL_EXT_NONE, "no depth, no parallax");
    assert_eq!(at(f32::NAN, 24), MATERIAL_EXT_NONE);
    let colour = Parallax { height: texture_id(TextureKind::Color, 0, 1), depth: 0.04, steps: 24 };
    let row = Material::color([90; 4]).with_layers(MaterialLayers { parallax: Some(colour), ..MaterialLayers::default() }).to_gpu_ext();
    assert_eq!(row.params[2] as u32 & MATERIAL_EXT_FLAG_PARALLAX, 0, "a colour texture is no height map");
}

#[test]
fn lobes_write_their_rows_and_transmission_blends_the_material() {
    let lobes = Lobes {
        clearcoat: 1.0,
        clearcoat_roughness: 0.1,
        sheen_color: [0.4, 0.2, 0.3],
        sheen_roughness: 0.5,
        anisotropy: 2.0,
        anisotropy_rotation: 1.0,
        transmission: 0.0,
    };
    let material = Material::color([90, 90, 90, 255]).with_layers(MaterialLayers { lobes, ..MaterialLayers::default() });
    let row = material.to_gpu_ext();
    assert_eq!(row.lobes, [1.0, 0.1, 1.0, 1.0]);
    assert_eq!(row.sheen, [0.4, 0.2, 0.3, 0.5]);
    assert_eq!(row.params[2] as u32 & MATERIAL_EXT_FLAG_LOBES, MATERIAL_EXT_FLAG_LOBES);
    assert!(!material.is_transparent());
    let glass = Material::color([255; 4]).with_layers(MaterialLayers { lobes: Lobes { transmission: 0.9, ..Lobes::default() }, ..MaterialLayers::default() });
    assert!(glass.is_transparent(), "transmission draws blended");
    assert_eq!(glass.to_gpu_ext().transmission[3], 0.9);
    assert_eq!(glass.to_gpu_ext().params[2] as u32 & MATERIAL_EXT_FLAG_LOBES, 0, "transmission alone is no lobe");
    let hostile = Material::color([255; 4]).with_layers(MaterialLayers { lobes: Lobes { transmission: f32::NAN, ..Lobes::default() }, ..MaterialLayers::default() });
    assert!(!hostile.is_transparent());
}

#[test]
fn presets_scale_the_layered_parts_by_class() {
    let desktop = DeviceClass::new(FormFactor::Desktop, PerformanceTier::High);
    let expected = [
        (QualityPreset::Low, LayerTier::Cover),
        (QualityPreset::Medium, LayerTier::Layers),
        (QualityPreset::High, LayerTier::Parallax),
        (QualityPreset::Ultra, LayerTier::Parallax),
    ];
    for (preset, tier) in expected {
        assert_eq!(preset_quality(preset, desktop).material_layers, tier, "desktop {preset:?}");
    }
    for tier in [PerformanceTier::Ultra, PerformanceTier::High, PerformanceTier::Mid] {
        let phone = DeviceClass::new(FormFactor::Mobile, tier);
        assert_eq!(preset_quality(QualityPreset::Ultra, phone).material_layers, LayerTier::Layers, "phone {tier:?}: no parallax");
    }
    let low_phone = DeviceClass::new(FormFactor::Mobile, PerformanceTier::Low);
    assert_eq!(preset_quality(QualityPreset::High, low_phone).material_layers, LayerTier::Cover);
    assert_eq!(Quality::off().material_layers, LayerTier::Cover, "the legacy renderer draws the cover alone");
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

/// The HDR scene with one sample, no anti-aliasing and every layered part on: its radiance reads
/// back as drawn.
fn hdr_plain(tier: LayerTier) -> Quality {
    let mut quality = Quality::off();
    quality.hdr = true;
    quality.tonemap = true;
    quality.anti_aliasing = AntiAliasing::Off;
    quality.material_layers = tier;
    quality
}

fn renderer(gpu: &Gpu, quality: &Quality, class: DeviceClass) -> Renderer {
    let mut renderer = Renderer::with_options(gpu, SIZE.0, SIZE.1, RenderOptions { msaa: false }).expect("renderer");
    renderer.set_scene_format(SceneFormat::Rgba16Float);
    renderer.set_device_class(class);
    renderer.set_quality(quality);
    renderer
}

fn desktop() -> DeviceClass {
    DeviceClass::new(FormFactor::Desktop, PerformanceTier::High)
}

/// One frame of `scene`: its HDR radiance and its capture.
fn shoot(gpu: &Gpu, renderer: &mut Renderer, scene: &Scene) -> (Vec<[f32; 4]>, Capture) {
    renderer.render(gpu, scene, CullPath::Gpu).expect("frame");
    (renderer.read_scene(gpu).expect("scene"), renderer.capture(gpu).expect("capture"))
}

fn write_evidence(name: &str, capture: &Capture) {
    if let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") {
        let dir = PathBuf::from(dir);
        let _ = std::fs::create_dir_all(&dir);
        let file = dir.join(format!("layered-{name}-{}x{}.bgra", capture.width(), capture.height()));
        std::fs::write(file, capture.bgra()).expect("evidence");
    }
}

/// The pixel `world` projects to through `camera` (x right, y down).
fn pixel(camera: &CameraDesc, world: Vec3) -> (f32, f32) {
    let clip = camera.view_proj(SIZE.0 as f32 / SIZE.1 as f32) * world.extend(1.0);
    ((clip.x / clip.w * 0.5 + 0.5) * SIZE.0 as f32, (0.5 - clip.y / clip.w * 0.5) * SIZE.1 as f32)
}

fn luminance(t: &[f32; 4]) -> f32 {
    0.2126 * t[0] + 0.7152 * t[1] + 0.0722 * t[2]
}

/// The mean radiance (rgb) of the pixels within `radius` of `at`.
fn mean_near(radiance: &[[f32; 4]], at: (f32, f32), radius: f32) -> [f32; 3] {
    let w = SIZE.0 as usize;
    let mut sum = [0.0f32; 3];
    let mut count = 0.0;
    for (i, texel) in radiance.iter().enumerate() {
        let (x, y) = ((i % w) as f32 + 0.5, (i / w) as f32 + 0.5);
        if libm::hypotf(x - at.0, y - at.1) <= radius {
            for c in 0..3 {
                sum[c] += texel[c];
            }
            count += 1.0;
        }
    }
    assert!(count > 0.0, "no pixel near {at:?}");
    sum.map(|s| s / count)
}

fn luma3(c: [f32; 3]) -> f32 {
    0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}

/// A camera looking down at a unit cube's top and +X and +Z faces.
fn cube_camera() -> CameraDesc {
    CameraDesc::look_at([2.0, 1.7, 2.0], [0.0, 0.0, 0.0])
}

fn cube_scene(material: Material) -> Scene {
    let mut scene = Scene::new(cube_camera(), CLEAR);
    scene.lighting.shadows = false;
    scene.lighting.sun_dir = [0.3, 1.0, 0.6];
    scene.draw(MeshId::CUBE, scaled([0.0; 3], [1.0; 3]), material);
    scene
}

/// The mean radiance of the cube's top face and its +X face.
fn top_and_side(radiance: &[[f32; 4]]) -> ([f32; 3], [f32; 3]) {
    let camera = cube_camera();
    let top = mean_near(radiance, pixel(&camera, Vec3::new(0.0, 0.5, 0.0)), 4.0);
    let side = mean_near(radiance, pixel(&camera, Vec3::new(0.5, -0.1, 0.0)), 4.0);
    (top, side)
}

fn dark_stone() -> Material {
    Material::color([70, 66, 62, 255]).with_pbr(0.0, 0.8)
}

fn with(material: Material, layers: MaterialLayers) -> Material {
    material.with_layers(layers)
}

#[test]
#[ignore = "needs a Metal adapter"]
fn metal_snow_cover_whitens_the_top_of_a_box_and_leaves_its_sides_bare() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = renderer(&gpu, &hdr_plain(LayerTier::Layers), desktop());
    let (bare, bare_shot) = shoot(&gpu, &mut renderer, &cube_scene(dark_stone()));
    let snow = MaterialLayers { cover: Some(Cover::SNOW.shaped(1.0, 45.0, 0.0)), ..MaterialLayers::default() };
    let (snowed, snowed_shot) = shoot(&gpu, &mut renderer, &cube_scene(with(dark_stone(), snow)));
    write_evidence("snow-bare", &bare_shot);
    write_evidence("snow-cover", &snowed_shot);
    let ((bare_top, bare_side), (snow_top, snow_side)) = (top_and_side(&bare), top_and_side(&snowed));
    println!("top {:.3} -> {:.3}, side {:.3} -> {:.3}", luma3(bare_top), luma3(snow_top), luma3(bare_side), luma3(snow_side));
    assert!(luma3(snow_top) > 4.0 * luma3(bare_top), "the snowed top is far brighter than bare stone");
    assert!(snow_top[2] >= snow_top[0], "snow is a cool white, not the stone's warm grey");
    assert!((luma3(snow_side) - luma3(bare_side)).abs() <= 0.02 * luma3(bare_side) + 1e-4, "a wall steeper than the slope stays bare");
}

#[test]
#[ignore = "needs a Metal adapter"]
fn metal_a_partial_cover_lies_in_patches_and_more_amount_covers_more() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = renderer(&gpu, &hdr_plain(LayerTier::Layers), desktop());
    let camera = CameraDesc::look_at([0.0, 6.0, 0.01], [0.0, 0.0, 0.0]);
    let covered_share = |renderer: &mut Renderer, amount: f32| {
        let mut scene = Scene::new(camera, CLEAR);
        scene.lighting.shadows = false;
        scene.lighting.sun_dir = [0.2, 1.0, 0.3];
        let snow = MaterialLayers { cover: Some(Cover::SNOW.shaped(amount, 45.0, 0.6)), ..MaterialLayers::default() };
        scene.draw(MeshId::CUBE, scaled([0.0, -0.05, 0.0], [8.0, 0.1, 8.0]), with(dark_stone(), snow));
        let (radiance, shot) = shoot(&gpu, renderer, &scene);
        write_evidence(&format!("snow-amount-{amount}"), &shot);
        let lumas: Vec<f32> = radiance.iter().map(luminance).collect();
        let bright = lumas.iter().filter(|l| **l > 0.5 * lumas.iter().copied().fold(0.0, f32::max)).count();
        bright as f32 / lumas.len() as f32
    };
    let (light, heavy) = (covered_share(&mut renderer, 0.55), covered_share(&mut renderer, 0.95));
    println!("covered share: amount 0.55 {:.2}, amount 0.95 {:.2}", light, heavy);
    assert!(light > 0.1 && light < 0.85, "a partial cover lies in patches ({light:.2})");
    assert!(heavy > light + 0.1, "more amount covers more ({heavy:.2} vs {light:.2})");
}

#[test]
#[ignore = "needs a Metal adapter"]
fn metal_wet_cover_darkens_the_diffuse_and_sharpens_the_reflection() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = renderer(&gpu, &hdr_plain(LayerTier::Layers), desktop());
    let wet = MaterialLayers { cover: Some(Cover::WET.shaped(1.0, 180.0, 0.0)), ..MaterialLayers::default() };
    let (dry, _) = shoot(&gpu, &mut renderer, &cube_scene(dark_stone()));
    let (soaked, shot) = shoot(&gpu, &mut renderer, &cube_scene(with(dark_stone(), wet)));
    write_evidence("wet", &shot);
    let ((_, dry_side), (_, wet_side)) = (top_and_side(&dry), top_and_side(&soaked));
    println!("side: dry {:.4}, wet {:.4}", luma3(dry_side), luma3(wet_side));
    assert!(luma3(wet_side) < 0.8 * luma3(dry_side), "wet stone's diffuse is darker");
}

#[test]
#[ignore = "needs a Metal adapter"]
fn metal_the_cheapest_tier_draws_the_cover_without_its_noise() {
    let Some(gpu) = gpu() else { return };
    let snow = MaterialLayers { cover: Some(Cover::SNOW.shaped(1.0, 45.0, 0.9)), ..MaterialLayers::default() };
    let shot_at = |tier: LayerTier| {
        let mut renderer = renderer(&gpu, &hdr_plain(tier), desktop());
        shoot(&gpu, &mut renderer, &cube_scene(with(dark_stone(), snow))).0
    };
    let (cheap, full) = (shot_at(LayerTier::Cover), shot_at(LayerTier::Layers));
    let (cheap_top, _) = top_and_side(&cheap);
    let (full_top, _) = top_and_side(&full);
    println!("snowed top: cover tier {:.3}, layers tier {:.3}", luma3(cheap_top), luma3(full_top));
    assert!(luma3(cheap_top) > luma3(full_top), "without its noise the cover lies whole (no holes)");
}

/// A `side`-square RGBA8 texture of `f(x, y)`.
fn texture(side: u32, f: impl Fn(u32, u32) -> [u8; 4]) -> TextureData {
    let rgba = (0..side).flat_map(|y| (0..side).map(move |x| (x, y))).flat_map(|(x, y)| f(x, y)).collect();
    TextureData::rgba8(side, side, rgba).expect("texture")
}

#[test]
#[ignore = "needs a Metal adapter"]
fn metal_a_mid_grey_detail_albedo_leaves_the_colour_and_a_checker_one_varies_it() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = renderer(&gpu, &hdr_plain(LayerTier::Layers), desktop());
    let grey = renderer.add_texture(&gpu, &texture(16, |_, _| [128, 128, 128, 255]), TextureKind::Color).expect("grey");
    let checker = renderer.add_texture(&gpu, &texture(16, |x, y| if (x / 4 + y / 4) % 2 == 0 { [40; 4] } else { [230; 4] }), TextureKind::Color).expect("checker");
    let detail = |albedo| MaterialLayers {
        detail: Some(Detail { albedo: Some(albedo), normal: None, tiles: 1.0, albedo_strength: 1.0, normal_strength: 0.0, fade_metres: 0.0 }),
        ..MaterialLayers::default()
    };
    let (plain, _) = shoot(&gpu, &mut renderer, &cube_scene(dark_stone()));
    let (greyed, _) = shoot(&gpu, &mut renderer, &cube_scene(with(dark_stone(), detail(grey))));
    let (checked, shot) = shoot(&gpu, &mut renderer, &cube_scene(with(dark_stone(), detail(checker))));
    write_evidence("detail-checker", &shot);
    let (plain_top, _) = top_and_side(&plain);
    let (grey_top, _) = top_and_side(&greyed);
    println!("top: plain {:.4}, mid-grey detail {:.4}", luma3(plain_top), luma3(grey_top));
    assert!((luma3(grey_top) - luma3(plain_top)).abs() <= 0.03 * luma3(plain_top), "mid-grey multiplies by 1");
    let spread = |radiance: &[[f32; 4]]| {
        let camera = cube_camera();
        let (cx, cy) = pixel(&camera, Vec3::new(0.0, 0.5, 0.0));
        let near: Vec<f32> = (0..9).flat_map(|j| (0..9).map(move |i| (i, j))).map(|(i, j)| {
            let at = ((cx as i32 - 4 + i) as usize, (cy as i32 - 4 + j) as usize);
            luminance(&radiance[at.1 * SIZE.0 as usize + at.0])
        }).collect();
        near.iter().copied().fold(0.0, f32::max) - near.iter().copied().fold(f32::MAX, f32::min)
    };
    assert!(spread(&checked) > 3.0 * spread(&plain) + 1e-3, "a checker detail varies the top ({} vs {})", spread(&checked), spread(&plain));
}

#[test]
#[ignore = "needs a Metal adapter"]
fn metal_a_second_layer_masked_by_up_paints_the_top_and_not_the_side() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = renderer(&gpu, &hdr_plain(LayerTier::Layers), desktop());
    let moss = MaterialLayer {
        base: None,
        normal: None,
        orm: None,
        height: None,
        tint: [0.05, 0.4, 0.05],
        roughness: 0.9,
        tiles: 1.0,
        mask: LayerMask::Up,
        mask_metres: 1.0,
        blend_depth: 0.2,
    };
    let (layered, shot) = shoot(&gpu, &mut renderer, &cube_scene(with(dark_stone(), MaterialLayers { layer: Some(moss), ..MaterialLayers::default() })));
    write_evidence("layer-up", &shot);
    let (top, side) = top_and_side(&layered);
    println!("top {top:?}, side {side:?}");
    assert!(top[1] > 2.0 * top[0], "the top takes the green layer");
    assert!(side[0] > 0.8 * side[1], "the side keeps the stone's grey");
}

/// A height map of raised squares: white tiles in black grooves.
fn tiles_height() -> TextureData {
    texture(64, |x, y| if x % 16 < 3 || y % 16 < 3 { [0, 0, 0, 255] } else { [255; 4] })
}

#[test]
#[ignore = "needs a Metal adapter"]
fn metal_parallax_shifts_a_grazing_view_and_phones_skip_it() {
    let Some(gpu) = gpu() else { return };
    let draw = |class: DeviceClass, tier: LayerTier, parallax: bool| {
        let mut renderer = renderer(&gpu, &hdr_plain(tier), class);
        let height = renderer.add_texture(&gpu, &tiles_height(), TextureKind::Data).expect("height");
        let albedo = renderer.add_texture(&gpu, &tiles_height(), TextureKind::Color).expect("albedo");
        let camera = CameraDesc::look_at([0.0, 0.9, 3.0], [0.0, 0.0, -1.0]);
        let mut scene = Scene::new(camera, CLEAR);
        scene.lighting.shadows = false;
        scene.lighting.sun_dir = [0.2, 1.0, 0.4];
        let layers = MaterialLayers { parallax: parallax.then_some(Parallax { height, depth: 0.08, steps: 32 }), ..MaterialLayers::default() };
        let floor = Material::color([255; 4]).with_pbr(0.0, 0.9).with_base_texture(albedo).with_layers(layers);
        let model = Mat4::from_scale(Vec3::new(6.0, 0.02, 6.0)).to_cols_array();
        scene.draw(MeshId::CUBE, model, floor);
        shoot(&gpu, &mut renderer, &scene)
    };
    let (flat, flat_shot) = draw(desktop(), LayerTier::Parallax, false);
    let (deep, deep_shot) = draw(desktop(), LayerTier::Parallax, true);
    write_evidence("parallax-off", &flat_shot);
    write_evidence("parallax-on", &deep_shot);
    let moved = flat.iter().zip(&deep).filter(|(a, b)| (luminance(a) - luminance(b)).abs() > 0.02).count();
    println!("parallax moves {moved} of {} pixels", flat.len());
    assert!(moved > flat.len() / 50, "parallax moves the grooves at a grazing view");
    let phone = DeviceClass::new(FormFactor::Mobile, PerformanceTier::High);
    let (phone_flat, _) = draw(phone, LayerTier::Layers, false);
    let (phone_deep, _) = draw(phone, LayerTier::Layers, true);
    assert_eq!(phone_flat, phone_deep, "below the parallax tier the height map moves nothing");
}

fn sphere_scene(material: Material, sun: [f32; 3]) -> Scene {
    let camera = CameraDesc::look_at([0.0, 0.0, 3.0], [0.0, 0.0, 0.0]);
    let mut scene = Scene::new(camera, CLEAR);
    scene.lighting.shadows = false;
    scene.lighting.sun_dir = sun;
    scene.lighting.ambient_intensity = 0.0;
    scene.draw(MeshId::SPHERE, scaled([0.0; 3], [2.0; 3]), material);
    scene
}

fn peak_and_area(radiance: &[[f32; 4]]) -> (f32, usize, (usize, usize)) {
    let lumas: Vec<f32> = radiance.iter().map(luminance).collect();
    let peak = lumas.iter().copied().fold(0.0, f32::max);
    let hot: Vec<usize> = (0..lumas.len()).filter(|i| lumas[*i] >= 0.5 * peak).collect();
    let w = SIZE.0 as usize;
    let span_x = hot.iter().map(|i| i % w).max().unwrap_or(0) - hot.iter().map(|i| i % w).min().unwrap_or(0);
    let span_y = hot.iter().map(|i| i / w).max().unwrap_or(0) - hot.iter().map(|i| i / w).min().unwrap_or(0);
    (peak, hot.len(), (span_x, span_y))
}

#[test]
#[ignore = "needs a Metal adapter"]
fn metal_a_clearcoat_puts_a_sharp_highlight_on_a_rough_base() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = renderer(&gpu, &hdr_plain(LayerTier::Layers), desktop());
    let paint = Material::color([120, 20, 20, 255]).with_pbr(0.0, 0.85);
    let coat = MaterialLayers { lobes: Lobes { clearcoat: 1.0, clearcoat_roughness: 0.05, ..Lobes::default() }, ..MaterialLayers::default() };
    let sun = [0.0, 0.0, 1.0];
    let (matte, _) = shoot(&gpu, &mut renderer, &sphere_scene(paint, sun));
    let (coated, shot) = shoot(&gpu, &mut renderer, &sphere_scene(paint.with_layers(coat), sun));
    write_evidence("clearcoat", &shot);
    let (matte_peak, _, _) = peak_and_area(&matte);
    let (coat_peak, _, _) = peak_and_area(&coated);
    println!("peak: matte {matte_peak:.3}, clearcoat {coat_peak:.3}");
    assert!(coat_peak > 4.0 * matte_peak, "the coat's mirror reflects the sun");
}

#[test]
#[ignore = "needs a Metal adapter"]
fn metal_anisotropy_stretches_the_highlight_along_its_direction() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = renderer(&gpu, &hdr_plain(LayerTier::Layers), desktop());
    let steel = Material::color([200, 200, 205, 255]).with_pbr(1.0, 0.35);
    let brushed = MaterialLayers { lobes: Lobes { anisotropy: 0.9, ..Lobes::default() }, ..MaterialLayers::default() };
    let sun = [0.0, 0.0, 1.0];
    let (plain, _) = shoot(&gpu, &mut renderer, &sphere_scene(steel, sun));
    let (stretched, shot) = shoot(&gpu, &mut renderer, &sphere_scene(steel.with_layers(brushed), sun));
    write_evidence("anisotropy", &shot);
    let (_, _, (px, py)) = peak_and_area(&plain);
    let (_, _, (sx, sy)) = peak_and_area(&stretched);
    println!("highlight span: plain {px}x{py}, anisotropic {sx}x{sy}");
    let ratio = |x: usize, y: usize| x.max(y) as f32 / x.min(y).max(1) as f32;
    assert!(ratio(sx, sy) > 1.5 * ratio(px, py), "the anisotropic highlight is elongated");
}

#[test]
#[ignore = "needs a Metal adapter"]
fn metal_sheen_brightens_the_rim_of_cloth() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = renderer(&gpu, &hdr_plain(LayerTier::Layers), desktop());
    let cloth = Material::color([40, 20, 60, 255]).with_pbr(0.0, 0.9);
    let velvet = MaterialLayers { lobes: Lobes { sheen_color: [0.9, 0.7, 1.0], sheen_roughness: 0.4, ..Lobes::default() }, ..MaterialLayers::default() };
    let (plain, _) = shoot(&gpu, &mut renderer, &sphere_scene(cloth, [0.0, 1.0, 0.2]));
    let (sheened, shot) = shoot(&gpu, &mut renderer, &sphere_scene(cloth.with_layers(velvet), [0.0, 1.0, 0.2]));
    write_evidence("sheen", &shot);
    let camera = CameraDesc::look_at([0.0, 0.0, 3.0], [0.0, 0.0, 0.0]);
    let rim = pixel(&camera, Vec3::new(0.0, 0.97, 0.15));
    let (plain_rim, sheen_rim) = (luma3(mean_near(&plain, rim, 2.0)), luma3(mean_near(&sheened, rim, 2.0)));
    println!("rim: plain {plain_rim:.4}, sheen {sheen_rim:.4}");
    assert!(sheen_rim > 1.3 * plain_rim, "sheen lights the grazing rim");
}

#[test]
#[ignore = "needs a Metal adapter"]
fn metal_a_transmissive_pane_shows_what_lies_behind_it() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = renderer(&gpu, &hdr_plain(LayerTier::Layers), desktop());
    let camera = CameraDesc::look_at([0.0, 0.0, 3.0], [0.0, 0.0, 0.0]);
    let scene_with = |pane: Option<Material>| {
        let mut scene = Scene::new(camera, CLEAR);
        scene.lighting.shadows = false;
        scene.lighting.sun_dir = [0.3, 0.6, 1.0];
        scene.draw(MeshId::CUBE, scaled([0.0, 0.0, -1.0], [3.0, 3.0, 0.1]), red_wall());
        if let Some(pane) = pane {
            scene.draw(MeshId::CUBE, scaled([0.0, 0.0, 0.5], [1.5, 1.5, 0.02]), pane);
        }
        scene
    };
    let glass = |transmission: f32| {
        Material::color([255; 4]).with_pbr(0.0, 0.05).with_layers(MaterialLayers { lobes: Lobes { transmission, ..Lobes::default() }, ..MaterialLayers::default() })
    };
    let (open, _) = shoot(&gpu, &mut renderer, &scene_with(None));
    let (clear, shot) = shoot(&gpu, &mut renderer, &scene_with(Some(glass(1.0))));
    let (frosted, _) = shoot(&gpu, &mut renderer, &scene_with(Some(glass(0.0))));
    write_evidence("transmission", &shot);
    let centre = (SIZE.0 as f32 * 0.5, SIZE.1 as f32 * 0.5);
    let red = |radiance: &[[f32; 4]]| mean_near(radiance, centre, 4.0)[0];
    println!("red behind: open {:.3}, clear glass {:.3}, opaque white {:.3}", red(&open), red(&clear), red(&frosted));
    assert!(red(&clear) > 0.85 * red(&open), "clear glass lets the wall's red through");
    let blue = |radiance: &[[f32; 4]]| mean_near(radiance, centre, 4.0)[2];
    assert!(blue(&clear) < blue(&frosted), "an opaque white pane hides it");
}

/// A wall glowing red, the same under any light.
fn red_wall() -> Material {
    Material::color([0, 0, 0, 255]).with_pbr(0.0, 1.0).with_emissive([255, 0, 0], 1.0)
}

/// The most every layered part at once (cover with noise, detail albedo and normal, a second
/// textured layer with heights, parallax and a clearcoat) may add to a screen of floor at
/// 2560x1440 on desktop `high`, over the same floor with its plain maps.
const LAYERED_FULL_MS_MAX: f32 = 1.5;
/// The most the cover alone may add (every preset draws it).
const COVER_MS_MAX: f32 = 0.25;

#[test]
#[ignore = "needs a Metal adapter"]
fn metal_layered_materials_cost_within_their_budget_at_1440p_high() {
    let Some(gpu) = gpu() else { return };
    if !gpu.device.features().contains(wgpu::Features::TIMESTAMP_QUERY) {
        eprintln!("skipped: no timestamp queries");
        return;
    }
    let size = (2560, 1440);
    let class = desktop();
    let quality = preset_quality(QualityPreset::High, class);
    let make = || {
        let mut renderer = Renderer::with_options(&gpu, size.0, size.1, RenderOptions { msaa: false }).expect("renderer");
        renderer.set_scene_format(SceneFormat::Rgba16Float);
        renderer.set_device_class(class);
        renderer.set_quality(&quality);
        renderer
    };
    let checker = |side: u32| texture(side, |x, y| if (x / 32 + y / 32) % 2 == 0 { [90, 90, 90, 255] } else { [180, 180, 180, 255] });
    let flat_normal = |side: u32| texture(side, |_, _| [128, 128, 255, 255]);
    let floor_with = |renderer: &mut Renderer, layered: u8| {
        let albedo = renderer.add_texture(&gpu, &checker(1024), TextureKind::Color).expect("albedo");
        let normal = renderer.add_texture(&gpu, &flat_normal(1024), TextureKind::Normal).expect("normal");
        let orm = renderer.add_texture(&gpu, &checker(1024), TextureKind::Data).expect("orm");
        let height = renderer.add_texture(&gpu, &tiles_height(), TextureKind::Data).expect("height");
        let base = Material::color([255; 4]).with_pbr(1.0, 1.0).with_base_texture(albedo).with_normal_map(normal, 1.0).with_metal_rough_texture(orm);
        let cover = Some(Cover::SNOW.shaped(0.6, 45.0, 0.4));
        let layers = match layered {
            0 => MaterialLayers::default(),
            1 => MaterialLayers { cover, ..MaterialLayers::default() },
            _ => MaterialLayers {
                cover,
                detail: Some(Detail { albedo: Some(albedo), normal: Some(normal), tiles: 8.0, albedo_strength: 0.5, normal_strength: 1.0, fade_metres: 20.0 }),
                layer: Some(MaterialLayer {
                    base: Some(albedo),
                    normal: Some(normal),
                    orm: Some(orm),
                    height: Some(height),
                    tint: [0.4, 0.6, 0.3],
                    roughness: 1.0,
                    tiles: 2.0,
                    mask: LayerMask::Noise,
                    mask_metres: 2.0,
                    blend_depth: 0.2,
                }),
                parallax: Some(Parallax { height, depth: 0.04, steps: 32 }),
                lobes: Lobes { clearcoat: 1.0, clearcoat_roughness: 0.1, ..Lobes::default() },
            },
        };
        let camera = CameraDesc::look_at([0.0, 1.7, 4.0], [0.0, 0.0, -6.0]);
        let mut scene = Scene::new(camera, CLEAR);
        scene.lighting.sun_dir = [0.3, 0.8, 0.4];
        let model = Mat4::from_scale(Vec3::new(60.0, 0.02, 60.0)).to_cols_array();
        scene.draw(MeshId::CUBE, model, base.with_uv(genex_render::scene::UvMapping::World { tiles_per_metre: [0.5, 0.5] }).with_layers(layers));
        scene
    };
    let median = |values: &mut Vec<f32>| {
        values.sort_by(f32::total_cmp);
        values[values.len() / 2]
    };
    let mut renderers = [make(), make(), make()];
    let scenes: Vec<Scene> = renderers.iter_mut().enumerate().map(|(k, renderer)| floor_with(renderer, k as u8)).collect();
    let mut deltas = [Vec::new(), Vec::new()];
    for round in 0..6 {
        let mut times = [Vec::new(), Vec::new(), Vec::new()];
        for frame in 0..40u64 {
            for (k, renderer) in renderers.iter_mut().enumerate() {
                renderer.set_frame_index(frame);
                let Some(landed) = renderer.arm_frame_timer(&gpu.queue) else {
                    eprintln!("skipped: no frame timer");
                    return;
                };
                times[k].extend(landed);
                renderer.render(&gpu, &scenes[k], CullPath::Gpu).expect("frame");
                renderer.finish_frame_timer();
                let _ = gpu.device.poll(wgpu::PollType::wait_indefinitely());
            }
        }
        let [mut plain, mut cover, mut full] = times.map(|mut landed| {
            landed.drain(..8.min(landed.len()));
            landed
        });
        if round > 0 && !plain.is_empty() {
            let base = median(&mut plain);
            deltas[0].push(median(&mut cover) - base);
            deltas[1].push(median(&mut full) - base);
        }
    }
    let [mut cover, mut full] = deltas;
    let (cover_ms, full_ms) = (median(&mut cover), median(&mut full));
    let row = format!("a screen of floor at 2560x1440 high: cover {cover_ms:.3} ms (budget {COVER_MS_MAX}), every layered part {full_ms:.3} ms (budget {LAYERED_FULL_MS_MAX}) over its plain maps");
    eprintln!("{row}");
    assert!(cover_ms <= COVER_MS_MAX && full_ms <= LAYERED_FULL_MS_MAX, "{row}");
}
