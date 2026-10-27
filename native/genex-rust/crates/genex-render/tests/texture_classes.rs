//! Texture quality (RQ6.4): material textures stored in size-class arrays (256/512/1024/2048)
//! instead of every texture resampled to 256, the class picked by source size and capped per
//! preset and device class; pre-sized arrays with layer caps that are budget-ledger entries (the
//! degrade step drops the largest class first); Toksvig normal-map mips.
//!
//! The CPU rows run everywhere. The GPU rows are `#[ignore]`d and every name contains `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked -- --ignored metal

use genex_render::budget::{BudgetInput, BudgetKind, DegradeMode, DegradeRung, MaterialClass, fit, ledger};
use genex_render::device_class::{DeviceClass, FormFactor};
use genex_render::layout::{NO_TEXTURE, TEXTURE_SIZE_CLASSES, texture_ref_parts};
use genex_render::presets::{class_defaults, preset_quality, reference_resolution, scene_format};
use genex_render::settings::{Quality, QualityPreset, TextureClass, TextureQuality};
use genex_render::texture::{
    ClassArrays, MAX_TEXTURE_LAYERS, SOURCE_TEXTURE_MAX_SIDE, TEXTURE_LAYER_PX, TextureData, TextureId, TextureKind, capped_source,
    class_for_source, class_layer_caps, fitted_textures, material_arrays, mip_chain, normal_mip_chain, preset_textures, toksvig_roughness,
};
use genex_render::scene::{CameraDesc, Material, MeshId, Scene, scaled};
use genex_render::{CullPath, Gpu, RenderCode, RenderOptions, Renderer};

const MIB: u64 = 1024 * 1024;
/// A Toksvig normal keeps unit length within this (8-bit encoding).
const UNIT_TOLERANCE: f32 = 0.02;

fn class(wire: &str) -> DeviceClass {
    DeviceClass::from_wire(wire).unwrap_or_else(|| panic!("{wire} is a class"))
}

fn image(width: u32, height: u32, f: impl Fn(u32, u32) -> [u8; 4]) -> TextureData {
    let mut rgba = Vec::with_capacity((width * height * 4) as usize);
    for y in 0..height {
        for x in 0..width {
            rgba.extend(f(x, y));
        }
    }
    TextureData::rgba8(width, height, rgba).expect("texture")
}

fn checker(size: u32, cell: u32) -> TextureData {
    image(size, size, |x, y| if (x / cell + y / cell).is_multiple_of(2) { [235, 235, 235, 255] } else { [20, 20, 20, 255] })
}

fn encode(c: f32) -> u8 {
    ((c * 0.5 + 0.5) * 255.0).round() as u8
}

/// A tangent-space normal map whose normal flips between two tilts every texel: the highest
/// frequency a map holds, which a box mip averages towards the flat normal with a shorter length.
fn ridged_normals(size: u32) -> TextureData {
    let tilt = 0.6_f32;
    let z = (1.0 - tilt * tilt).sqrt();
    image(size, size, |x, _| {
        let nx = if x.is_multiple_of(2) { tilt } else { -tilt };
        [encode(nx), encode(0.0), encode(z), 255]
    })
}

/// A tangent-space normal map of round bumps on a grid (the part 1 golden's).
fn bumps(size: u32, cells: u32) -> TextureData {
    let cell = size / cells;
    image(size, size, |x, y| {
        let (u, v) = ((x % cell) as f32 / cell as f32 - 0.5, (y % cell) as f32 / cell as f32 - 0.5);
        let (nx, ny) = (u * 1.6, v * 1.6);
        let nz = (1.0 - (nx * nx + ny * ny).min(0.95)).sqrt();
        [encode(nx), encode(ny), encode(nz), 255]
    })
}

/// Raw RGBA evidence (`<name>-<w>x<h>.rgba`) when `GENEX_RENDER_EVIDENCE_DIR` is set.
fn write_evidence(name: &str, texture: &TextureData) {
    if let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") {
        std::fs::create_dir_all(&dir).expect("evidence folder");
        let path = std::path::Path::new(&dir).join(format!("{name}-{}x{}.rgba", texture.width(), texture.height()));
        std::fs::write(path, texture.rgba()).expect("evidence written");
    }
}

fn decode(texel: &[u8]) -> [f32; 3] {
    [0, 1, 2].map(|c| f32::from(texel[c]) / 255.0 * 2.0 - 1.0)
}

fn length(v: [f32; 3]) -> f32 {
    (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt()
}

/// The default preset's quality of `class` with its texture quality.
fn class_quality(class: DeviceClass) -> (Quality, TextureQuality) {
    let preset = class_defaults(class).preset;
    (preset_quality(preset, class), preset_textures(preset, class))
}

fn reference_input(quality: &Quality, class: DeviceClass) -> BudgetInput {
    let tile = class.form == FormFactor::Mobile;
    BudgetInput::new(reference_resolution(class), quality.render_scale, scene_format(class, true), tile)
}

// ---------------------------------------------------------------------------------------------
// Class choice

#[test]
fn a_2048_source_keeps_2048_on_desktop_high_and_512_on_mobile_mid() {
    let desktop = preset_textures(class_defaults(class("desktop-high")).preset, class("desktop-high"));
    let mobile = preset_textures(class_defaults(class("mobile-mid")).preset, class("mobile-mid"));
    assert_eq!(class_for_source(2048, 2048, desktop.max_class), TextureClass::S2048);
    assert_eq!(class_for_source(2048, 2048, mobile.max_class), TextureClass::S512);
    assert!(desktop.toksvig && mobile.toksvig, "texture quality is on with every preset");
}

#[test]
fn a_source_takes_the_smallest_class_that_holds_its_longer_side() {
    let rows = [
        ((1, 1), TextureClass::S256),
        ((256, 256), TextureClass::S256),
        ((257, 16), TextureClass::S512),
        ((300, 900), TextureClass::S1024),
        ((1024, 1024), TextureClass::S1024),
        ((1025, 64), TextureClass::S2048),
        ((4096, 4096), TextureClass::S2048),
    ];
    for ((width, height), expected) in rows {
        assert_eq!(class_for_source(width, height, TextureClass::S2048), expected, "{width}x{height}");
    }
    assert_eq!(class_for_source(4096, 4096, TextureClass::S256), TextureClass::S256, "the cap wins");
}

#[test]
fn the_low_preset_clamps_to_512_on_mobile_and_no_phone_keeps_2048() {
    for class in DeviceClass::ALL {
        for preset in QualityPreset::ALL {
            let textures = preset_textures(preset, class);
            let at = format!("{} {}", class.wire(), preset.wire());
            if class.form == FormFactor::Mobile {
                assert!(textures.max_class <= TextureClass::S1024, "{at}: a phone never holds 2048 layers");
                if preset == QualityPreset::Low {
                    assert_eq!(textures.max_class, TextureClass::S512, "{at}");
                }
            }
            assert!(textures.max_class >= TextureClass::S512, "{at}: texture quality is on with every preset");
        }
    }
    assert_eq!(preset_textures(QualityPreset::High, class("desktop-high")).max_class, TextureClass::S2048);
    assert_eq!(preset_textures(QualityPreset::Ultra, class("desktop-ultra")).max_class, TextureClass::S2048);
}

#[test]
fn texture_ids_carry_their_class_in_the_material_reference() {
    let legacy = TextureId::new(TextureKind::Color, 5);
    assert_eq!(legacy.class(), TextureClass::S256, "a bare layer is class 0");
    assert_eq!(legacy.reference(), 5, "class 0 references keep today's bytes");
    let big = TextureId::in_class(TextureKind::Data, TextureClass::S1024, 3);
    assert_eq!((big.kind(), big.class(), big.layer()), (TextureKind::Data, TextureClass::S1024, 3));
    assert_eq!(texture_ref_parts(big.reference()), Some((2, 3)));
    assert_ne!(big.reference(), NO_TEXTURE);
}

// ---------------------------------------------------------------------------------------------
// Mips: today's method off, Toksvig on

#[test]
fn a_256_source_mips_exactly_as_today_in_class_256() {
    let source = checker(256, 16);
    let textures = preset_textures(QualityPreset::Ultra, class("desktop-ultra"));
    let chosen = class_for_source(source.width(), source.height(), textures.max_class);
    assert_eq!(chosen, TextureClass::S256);
    assert_eq!(chosen.side(), TEXTURE_LAYER_PX);
    assert_eq!(normal_mip_chain(&source, chosen.side(), false), mip_chain(&source, TextureKind::Data, TEXTURE_LAYER_PX), "off: today's mips");
}

#[test]
fn a_2048_source_in_its_class_keeps_every_level_0_texel() {
    let source = checker(2048, 3);
    let chain = mip_chain(&source, TextureKind::Color, TextureClass::S2048.side());
    assert_eq!(chain[0], source, "no resample at level 0 when the class holds the source");
    assert_eq!(chain.len(), 12, "2048 down to 1");
    let today = mip_chain(&source, TextureKind::Color, TEXTURE_LAYER_PX);
    write_evidence("checker3-class2048-level0", &chain[0]);
    write_evidence("checker3-class256-level0", &today[0]);
}

#[test]
fn toksvig_mips_of_a_high_frequency_normal_map_keep_unit_normals_and_raise_roughness() {
    let source = ridged_normals(64);
    let plain = normal_mip_chain(&source, 64, false);
    let filtered = normal_mip_chain(&source, 64, true);
    assert_eq!(filtered.len(), plain.len());
    let rgb = |level: &TextureData| -> Vec<[u8; 3]> { level.rgba().as_chunks::<4>().0.iter().map(|t| [t[0], t[1], t[2]]).collect() };
    assert_eq!(rgb(&filtered[0]), rgb(&plain[0]), "level 0 normals are the source's");
    let coarse = &filtered[1];
    for texel in coarse.rgba().as_chunks::<4>().0 {
        assert!((length(decode(texel)) - 1.0).abs() <= UNIT_TOLERANCE, "renormalized: {texel:?}");
    }
    let plain_length = length(decode(&plain[1].rgba()[..4]));
    assert!(plain_length < 0.9, "today's mip averages the ridges into a short normal ({plain_length})");
    let kept = f32::from(coarse.rgba()[3]) / 255.0;
    assert!((kept - 0.8).abs() < 0.02, "alpha keeps the averaged length the renormalization removed ({kept})");
    assert_eq!(filtered[0].rgba()[3], 255, "level 0 lost nothing");
    let smooth = 0.2;
    let raised = toksvig_roughness(smooth, kept);
    assert!(raised > smooth + 0.2, "the lost length folds into roughness: {smooth} → {raised}");
    assert_eq!(toksvig_roughness(smooth, 1.0), smooth, "a full-length normal leaves roughness alone");
    assert!(toksvig_roughness(0.9, 0.05) <= 1.0);
    let last = filtered.last().expect("a 1x1 level");
    assert!((length(decode(last.rgba())) - 1.0).abs() <= UNIT_TOLERANCE);
}

#[test]
fn toksvig_roughness_of_a_bumpy_map_grows_with_each_coarser_mip_and_never_drops() {
    let smooth = 0.2_f32;
    let source = bumps(256, 8);
    let plain = normal_mip_chain(&source, 256, false);
    let filtered = normal_mip_chain(&source, 256, true);
    let roughness_map = |level: &TextureData| -> Vec<f32> {
        level.rgba().as_chunks::<4>().0.iter().map(|texel| toksvig_roughness(smooth, f32::from(texel[3]) / 255.0)).collect()
    };
    let mean = |values: &[f32]| values.iter().map(|r| f64::from(*r)).sum::<f64>() / values.len() as f64;
    let means: Vec<f64> = filtered.iter().map(|level| mean(&roughness_map(level))).collect();
    assert!(roughness_map(&filtered[0]).iter().all(|r| *r == smooth), "level 0 lost nothing");
    // Down to one texel per bump (level 5 of 32-texel bumps) every level loses more; past it the
    // texels average whole bumps alike.
    assert!(means.windows(2).take(5).all(|pair| pair[1] > pair[0]), "coarser mips read rougher: {means:?}");
    assert!(means.windows(2).all(|pair| pair[1] >= pair[0]), "{means:?}");
    assert!(filtered.iter().all(|level| roughness_map(level).iter().all(|r| *r >= smooth)), "roughness never drops");
    let level = 3;
    let side = filtered[level].width();
    let grey: Vec<u8> = roughness_map(&filtered[level]).iter().flat_map(|r| [(r * 255.0).round() as u8; 3].into_iter().chain([255])).collect();
    write_evidence("bumps-plain-mip3", &plain[level]);
    write_evidence("bumps-toksvig-mip3", &filtered[level]);
    write_evidence("bumps-toksvig-roughness-mip3", &TextureData::rgba8(side, side, grey).expect("roughness map"));
}

#[test]
fn toksvig_keeps_the_detail_a_smaller_size_class_drops_from_level_0_on() {
    // A 2048 bump map (bumps 8 texels wide) placed in the 512 class: level 0 already averages
    // 4 x 4 source texels, so the detail it loses shows as roughness there and in every mip.
    let smooth = 0.2_f32;
    let source = bumps(2048, 256);
    let filtered = normal_mip_chain(&source, 512, true);
    let alphas: Vec<u8> = filtered[0].rgba().as_chunks::<4>().0.iter().map(|texel| texel[3]).collect();
    assert!(alphas.iter().any(|alpha| *alpha < 250), "level 0 keeps the averaged length the class dropped");
    let mean = |level: &TextureData| -> f64 {
        let texels = level.rgba().as_chunks::<4>().0;
        texels.iter().map(|texel| f64::from(toksvig_roughness(smooth, f32::from(texel[3]) / 255.0))).sum::<f64>() / texels.len() as f64
    };
    assert!(mean(&filtered[0]) > f64::from(smooth) + 0.01, "level 0 reads rougher than the base: {}", mean(&filtered[0]));
    assert!(filtered.windows(2).all(|pair| mean(&pair[1]) >= mean(&pair[0]) - 1e-6), "coarser levels never read smoother");
    for texel in filtered[0].rgba().as_chunks::<4>().0 {
        assert!((length(decode(texel)) - 1.0).abs() <= UNIT_TOLERANCE, "level 0 is renormalized: {texel:?}");
    }
    // A source of the class's own size keeps its texels at level 0 (alpha 255).
    let own = bumps(512, 64);
    assert!(normal_mip_chain(&own, 512, true)[0].rgba().as_chunks::<4>().0.iter().all(|texel| texel[3] == 255));
}

#[test]
fn toksvig_leaves_a_flat_normal_map_unchanged_but_for_its_alpha() {
    let flat = image(32, 32, |_, _| [128, 128, 255, 255]);
    let plain = normal_mip_chain(&flat, 32, false);
    let filtered = normal_mip_chain(&flat, 32, true);
    for (a, b) in plain.iter().zip(&filtered) {
        assert_eq!(a, b, "a flat map loses no length at any level");
    }
}

// ---------------------------------------------------------------------------------------------
// Layer caps and the budget ledger

#[test]
fn class_layer_caps_are_zero_above_the_max_class_and_off_is_todays_single_class() {
    for device in DeviceClass::ALL {
        for preset in QualityPreset::ALL {
            let textures = preset_textures(preset, device);
            let caps = class_layer_caps(device, textures);
            for texture_class in TextureClass::ALL {
                let at = format!("{} {} {texture_class:?}", device.wire(), preset.wire());
                let cap = caps[texture_class.index() as usize];
                if texture_class > textures.max_class {
                    assert_eq!(cap, 0, "{at}: above the preset's largest class");
                }
                assert!(cap <= MAX_TEXTURE_LAYERS, "{at}");
            }
            assert!(caps[0] > 0 && caps[1] > 0, "{} {}: 256 and 512 are held everywhere", device.wire(), preset.wire());
            assert!(caps.windows(2).all(|pair| pair[0] >= pair[1]), "{caps:?}: larger classes hold fewer layers");
        }
        assert_eq!(class_layer_caps(device, TextureQuality::OFF), [MAX_TEXTURE_LAYERS, 0, 0, 0], "{}", device.wire());
    }
}

#[test]
fn every_class_default_with_its_texture_arrays_stays_within_its_budget() {
    let mut over = Vec::new();
    for device in DeviceClass::ALL {
        let (quality, textures) = class_quality(device);
        let arrays = material_arrays(device, textures);
        let caps = class_layer_caps(device, textures);
        let held: Vec<MaterialClass> = TextureClass::ALL
            .into_iter()
            .filter(|texture_class| caps[texture_class.index() as usize] > 0)
            .map(|texture_class| MaterialClass { size_px: texture_class.side(), layers: 2 * caps[texture_class.index() as usize] })
            .collect();
        assert_eq!(arrays, held, "{}: one entry per held class, its colour and data arrays together", device.wire());
        let at = reference_input(&quality, device).with_materials(arrays.clone());
        let entries = ledger(&quality, &at);
        let material_bytes: u64 = entries.entries().iter().filter(|entry| entry.kind == BudgetKind::MaterialArrays).map(|entry| entry.bytes).sum();
        assert_eq!(material_bytes, arrays.iter().map(MaterialClass::bytes).sum::<u64>());
        let budget = class_defaults(device).budget_bytes;
        println!("{}: {} MB of {} MB ({} MB textures)", device.wire(), entries.total() / MIB, budget / MIB, material_bytes / MIB);
        if entries.total() > budget {
            over.push((device.wire(), entries.total(), budget));
        }
    }
    assert!(over.is_empty(), "over budget: {over:?}");
}

#[test]
fn mobile_mid_ledger_with_the_texture_arrays_stays_within_96_mb() {
    let mobile_mid = class("mobile-mid");
    let (quality, textures) = class_quality(mobile_mid);
    let at = reference_input(&quality, mobile_mid).with_materials(material_arrays(mobile_mid, textures));
    assert!(ledger(&quality, &at).total() <= 96 * MIB);
    assert_eq!(class_defaults(mobile_mid).budget_bytes, 96 * MIB);
}

#[test]
fn the_degrade_step_drops_the_largest_size_class_first() {
    let desktop_high = class("desktop-high");
    let (quality, textures) = class_quality(desktop_high);
    let reserved = material_arrays(desktop_high, textures);
    assert_eq!(reserved.iter().map(|array| array.size_px).max(), Some(2048));
    let at = reference_input(&quality, desktop_high).with_materials(reserved.clone());
    // A budget nothing meets: every resource rung runs, the material rung from the largest class.
    let fitted = fit(&quality, &at, MIB, DegradeMode::Runtime);
    let material_steps: Vec<_> = fitted.steps.iter().filter(|step| step.rung == DegradeRung::MaterialSize).collect();
    assert_eq!(material_steps.first().map(|step| step.from), Some(2048), "{:?}", fitted.steps);
    assert_eq!(fitted_textures(textures, &reserved, &fitted.materials).max_class, TextureClass::S256, "class 0 is never dropped");
    // One material step: only the 2048 class halves, 1024 is the largest class left.
    let one_step: Vec<MaterialClass> =
        reserved.iter().map(|array| if array.size_px == 2048 { MaterialClass { size_px: 1024, ..*array } } else { *array }).collect();
    let after = fitted_textures(textures, &reserved, &one_step);
    assert_eq!(after.max_class, TextureClass::S1024);
    assert_eq!(after.toksvig, textures.toksvig);
    assert_eq!(material_arrays(desktop_high, after).len(), reserved.len() - 1, "the dropped class reserves nothing");
    assert_eq!(fitted_textures(textures, &reserved, &reserved), textures, "nothing dropped, nothing changed");
}

#[test]
fn the_size_classes_are_the_layout_contract() {
    assert_eq!(TextureClass::ALL.map(TextureClass::side), TEXTURE_SIZE_CLASSES);
}

// ---------------------------------------------------------------------------------------------
// GPU: pre-sized arrays

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

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_class_arrays_place_by_source_size_presized_to_their_caps() {
    let Some(gpu) = gpu() else { return };
    let desktop_high = class("desktop-high");
    let textures = preset_textures(QualityPreset::High, desktop_high);
    let mut arrays = ClassArrays::new(&gpu.device, desktop_high, textures);
    assert_eq!(arrays.allocated_bytes(), 0, "nothing allocated before the first texture of a class");
    let small = arrays.add(&gpu.device, &gpu.queue, &checker(128, 8), TextureKind::Color).expect("small");
    let big = arrays.add(&gpu.device, &gpu.queue, &checker(2048, 64), TextureKind::Color).expect("big");
    let normal = arrays.add_normal_map(&gpu.device, &gpu.queue, &ridged_normals(512)).expect("normal map");
    assert_eq!((small.class(), small.layer()), (TextureClass::S256, 0));
    assert_eq!((big.class(), big.layer()), (TextureClass::S2048, 0));
    // RQ6.7 flipped: a normal map is named a Normal texture of the data arrays (was Data).
    assert_eq!((normal.kind(), normal.kind().array(), normal.class()), (TextureKind::Normal, TextureKind::Data, TextureClass::S512));
    let caps = class_layer_caps(desktop_high, textures);
    assert_eq!(arrays.extent(TextureClass::S2048, TextureKind::Color), (2048, caps[3]), "pre-sized to its cap on first use");
    assert_eq!(arrays.extent(TextureClass::S2048, TextureKind::Data), (1, 1), "an unused array stays a 1 x 1 placeholder");
    let reserved: u64 = material_arrays(desktop_high, textures).iter().map(MaterialClass::bytes).sum();
    assert!(arrays.allocated_bytes() <= reserved, "allocation stays within the ledger's reservation");
    gpu.device.poll(wgpu::PollType::wait_indefinitely()).expect("uploads finish");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_full_class_falls_back_to_a_smaller_one_and_refuses_only_when_all_are_full() {
    let Some(gpu) = gpu() else { return };
    let mobile_mid = class("mobile-mid");
    let textures = preset_textures(QualityPreset::Low, mobile_mid);
    let caps = class_layer_caps(mobile_mid, textures);
    let mut arrays = ClassArrays::new(&gpu.device, mobile_mid, textures);
    let source = checker(600, 20);
    let mut placed = Vec::new();
    for _ in 0..caps[1] + caps[0] {
        placed.push(arrays.add(&gpu.device, &gpu.queue, &source, TextureKind::Color).expect("room left"));
    }
    assert!(placed[..caps[1] as usize].iter().all(|id| id.class() == TextureClass::S512), "capped at 512 on mobile-mid");
    assert!(placed[caps[1] as usize..].iter().all(|id| id.class() == TextureClass::S256), "a full class steps down, never grows");
    let refused = arrays.add(&gpu.device, &gpu.queue, &source, TextureKind::Color).expect_err("every class full");
    assert_eq!(refused.code(), RenderCode::TextureTooLarge);
    assert_eq!(arrays.extent(TextureClass::S512, TextureKind::Color), (512, caps[1]));
    gpu.device.poll(wgpu::PollType::wait_indefinitely()).expect("uploads finish");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_texture_quality_off_keeps_todays_single_growing_class() {
    let Some(gpu) = gpu() else { return };
    let mut arrays = ClassArrays::new(&gpu.device, class("desktop-ultra"), TextureQuality::OFF);
    let id = arrays.add(&gpu.device, &gpu.queue, &checker(2048, 64), TextureKind::Color).expect("added");
    assert_eq!((id.class(), id.layer(), id.reference()), (TextureClass::S256, 0, 0), "resampled to 256 as today");
    assert_eq!(arrays.extent(TextureClass::S256, TextureKind::Color), (TEXTURE_LAYER_PX, 1), "grows as today");
    arrays.add(&gpu.device, &gpu.queue, &checker(64, 8), TextureKind::Color).expect("second");
    assert_eq!(arrays.extent(TextureClass::S256, TextureKind::Color), (TEXTURE_LAYER_PX, 2));
    gpu.device.poll(wgpu::PollType::wait_indefinitely()).expect("uploads finish");
}

// ---------------------------------------------------------------------------------------------
// The renderer's arrays (RQ6.7 wiring)

const VIEW: (u32, u32) = (128, 72);

/// A legacy-scene renderer (no MSAA) whose quality asks for `textures` on desktop-high.
fn textured_renderer(gpu: &Gpu, textures: TextureQuality) -> Renderer {
    let mut renderer = Renderer::with_options(gpu, VIEW.0, VIEW.1, RenderOptions { msaa: false }).expect("renderer");
    let mut quality = Quality::off();
    quality.textures = textures;
    renderer.set_quality(&quality);
    renderer.set_device_class(class("desktop-high"));
    renderer
}

/// A wall filling the view close up, `material` on it: its face spans the texture once over 20
/// world units, so the camera 1 unit away sees about 60 texels of a 1024 source across 128 pixels.
fn wall(material: Material) -> Scene {
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 0.0, 11.0], [0.0, 0.0, 0.0]), [0, 0, 0, 255]);
    scene.draw(MeshId::CUBE, scaled([0.0, 0.0, 0.0], [20.0, 20.0, 20.0]), material);
    scene
}

/// Raw BGRA evidence of a capture (`<name>-128x72.bgra`) when `GENEX_RENDER_EVIDENCE_DIR` is set.
fn write_capture(name: &str, bgra: &[u8]) {
    if let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") {
        std::fs::create_dir_all(&dir).expect("evidence folder");
        std::fs::write(std::path::Path::new(&dir).join(format!("{name}-{}x{}.bgra", VIEW.0, VIEW.1)), bgra).expect("evidence written");
    }
}

/// The standard deviation of the captured luma (0-255).
fn luma_spread(bgra: &[u8]) -> f32 {
    let luma: Vec<f32> = bgra.as_chunks::<4>().0.iter().map(|p| 0.0722 * f32::from(p[0]) + 0.7152 * f32::from(p[1]) + 0.2126 * f32::from(p[2])).collect();
    let mean = luma.iter().sum::<f32>() / luma.len() as f32;
    (luma.iter().map(|l| (l - mean) * (l - mean)).sum::<f32>() / luma.len() as f32).sqrt()
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_renderer_at_a_preset_keeps_a_1024_source_in_its_class_and_draws_its_detail() {
    let Some(gpu) = gpu() else { return };
    // 2-texel cells: resampled to 256 every texel averages two black and two white cells (grey).
    let fine = checker(1024, 2);
    let picture = |textures: TextureQuality| {
        let mut renderer = textured_renderer(&gpu, textures);
        let id = renderer.add_texture(&gpu, &fine, TextureKind::Color).expect("texture");
        renderer.render(&gpu, &wall(Material::color([255, 255, 255, 255]).with_base_texture(id)), CullPath::Gpu).expect("frame");
        (id, renderer.texture_quality(), renderer.capture(&gpu).expect("capture").bgra().to_vec())
    };
    let (legacy_id, legacy_quality, legacy) = picture(TextureQuality::OFF);
    let high = preset_textures(QualityPreset::High, class("desktop-high"));
    let (id, quality, detailed) = picture(high);
    assert_eq!((legacy_id.class(), legacy_quality), (TextureClass::S256, TextureQuality::OFF), "texture quality off: today's 256 class");
    assert_eq!((id.class(), quality), (TextureClass::S1024, high), "the renderer's arrays follow the quality: a 1024 source keeps 1024");
    write_capture("texture-class-off-256", &legacy);
    write_capture("texture-class-high-1024", &detailed);
    let (flat, sharp) = (luma_spread(&legacy), luma_spread(&detailed));
    assert!(flat < 8.0, "resampled to 256 the checker is grey (luma spread {flat})");
    assert!(sharp > 4.0 * flat.max(4.0), "the 1024 class draws the checker's cells (luma spread {sharp} vs {flat})");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_first_texture_fixes_the_arrays_and_a_later_quality_keeps_them() {
    let Some(gpu) = gpu() else { return };
    let high = preset_textures(QualityPreset::High, class("desktop-high"));
    let mut renderer = textured_renderer(&gpu, high);
    assert_eq!(renderer.texture_arrays(), None, "nothing fixed before the first texture");
    let first = renderer.add_texture(&gpu, &checker(1024, 2), TextureKind::Color).expect("first");
    renderer.set_quality(&Quality::off());
    let second = renderer.add_texture(&gpu, &checker(1024, 2), TextureKind::Color).expect("second");
    assert_eq!((first.class(), second.class()), (TextureClass::S1024, TextureClass::S1024), "the arrays keep the first texture's quality");
    assert_eq!(renderer.texture_arrays(), Some((class("desktop-high"), high)));
    // A frame at the legacy quality still samples the class arrays the textures live in.
    let scene = wall(Material::color([255, 255, 255, 255]).with_base_texture(second));
    renderer.render(&gpu, &scene, CullPath::Gpu).expect("frame");
    let spread = luma_spread(renderer.capture(&gpu).expect("capture").bgra());
    assert!(spread > 16.0, "the legacy scene draws the 1024 texture's cells too (luma spread {spread})");
}

// RQ6 review: the class path keyed on the first texture past class 0, so a model's first large
// texture rebuilt every scene pipeline mid-game (a compile on the frame thread, a hitch on phones
// and in browsers). The key now comes from the texture quality, known from boot.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_first_large_texture_after_a_frame_compiles_no_scene_pipeline() {
    let Some(gpu) = gpu() else { return };
    let high = preset_textures(QualityPreset::High, class("desktop-high"));
    let mut renderer = textured_renderer(&gpu, high);
    renderer.render(&gpu, &wall(Material::color([255, 255, 255, 255])), CullPath::Gpu).expect("a frame without textures");
    let built = renderer.scene_pipeline_builds();
    assert!(built > 0, "the first frame makes the scene's pipelines");
    let id = renderer.add_texture(&gpu, &checker(1024, 2), TextureKind::Color).expect("a 1024 texture");
    assert_eq!(id.class(), TextureClass::S1024);
    renderer.render(&gpu, &wall(Material::color([255, 255, 255, 255]).with_base_texture(id)), CullPath::Gpu).expect("a textured frame");
    assert_eq!(renderer.scene_pipeline_builds(), built, "a texture past class 0 compiles nothing");
    let spread = luma_spread(renderer.capture(&gpu).expect("capture").bgra());
    assert!(spread > 16.0, "and draws its detail (luma spread {spread})");
}

// RQ6 review: immediate quads sampled class 0 only, so a sprite whose source texture quality put
// in a larger class drew as a flat tinted rectangle.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_512_sprite_at_texture_quality_draws_its_texels() {
    use genex_render::FrameRenderer;
    use genex_render::immediate::{ImmediateFrame, Rect2d};
    let Some(gpu) = gpu() else { return };
    let high = preset_textures(QualityPreset::High, class("desktop-high"));
    let mut renderer = FrameRenderer::new(&gpu, VIEW.0, VIEW.1, RenderOptions { msaa: false }).expect("renderer");
    let mut quality = Quality::off();
    quality.textures = high;
    renderer.renderer_mut().set_quality(&quality);
    renderer.renderer_mut().set_device_class(class("desktop-high"));
    // 32-texel cells of a 512 source: drawn 128 px wide, each cell is 8 px.
    let sprite = renderer.add_texture(&gpu, &checker(512, 32), TextureKind::Color).expect("a 512 sprite");
    assert_eq!(sprite.class(), TextureClass::S512, "texture quality keeps the 512 source in its class");
    let mut frame = ImmediateFrame::new(CameraDesc::look_at([0.0, 0.0, 5.0], [0.0, 0.0, 0.0]), [0, 0, 0, 255]);
    frame.sprite(sprite, Rect2d::new(0.0, 0.0, VIEW.0 as f32, VIEW.0 as f32), [255, 255, 255, 255]);
    renderer.render(&gpu, &frame, CullPath::Gpu, None).expect("frame");
    let capture = renderer.capture(&gpu).expect("capture");
    write_capture("sprite-512-class", capture.bgra());
    let spread = luma_spread(capture.bgra());
    assert!(spread > 60.0, "the sprite draws its black and white cells, not a flat tint (luma spread {spread})");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_toksvig_mips_change_a_minified_bumpy_normal_map_and_leave_a_flat_one() {
    let Some(gpu) = gpu() else { return };
    let high = preset_textures(QualityPreset::High, class("desktop-high"));
    let draw = |source: &TextureData, kind: TextureKind| {
        let mut renderer = textured_renderer(&gpu, high);
        let normal = renderer.add_texture(&gpu, source, kind).expect("normal map");
        let material = Material::color([200, 200, 200, 255]).with_pbr(0.0, 0.2).with_normal_map(normal, 1.0);
        // Far away: the map is minified to its coarse mips, where Toksvig widens roughness.
        let mut scene = Scene::new(CameraDesc::look_at([0.0, 2.0, 40.0], [0.0, 0.0, 0.0]), [0, 0, 0, 255]);
        scene.draw(MeshId::SPHERE, scaled([0.0, 0.0, 0.0], [6.0, 6.0, 6.0]), material);
        renderer.render(&gpu, &scene, CullPath::Gpu).expect("frame");
        renderer.capture(&gpu).expect("capture").bgra().to_vec()
    };
    let bumpy = bumps(256, 64);
    let (toksvig, plain) = (draw(&bumpy, TextureKind::Normal), draw(&bumpy, TextureKind::Data));
    write_capture("toksvig-normal-kind", &toksvig);
    write_capture("toksvig-data-kind", &plain);
    assert_ne!(toksvig, plain, "Toksvig mips fold the averaged bumps into roughness");
    let flat = image(256, 256, |_, _| [128, 128, 255, 255]);
    assert_eq!(draw(&flat, TextureKind::Normal), draw(&flat, TextureKind::Data), "a flat map loses no length: the same picture");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_device_loss_replays_textures_into_the_classes_they_had() {
    let Some(gpu) = gpu() else { return };
    let mut resilient = genex_render::device_loss::Resilient::new(gpu, VIEW.0, VIEW.1, RenderOptions { msaa: false }, Gpu::headless).expect("resilient");
    let high = preset_textures(QualityPreset::High, class("desktop-high"));
    let mut quality = Quality::off();
    quality.textures = high;
    let renderer = resilient.renderer_mut().renderer_mut();
    renderer.set_quality(&quality);
    renderer.set_device_class(class("desktop-high"));
    let big = resilient.add_texture(&checker(1024, 2), TextureKind::Color).expect("texture");
    assert_eq!(big.class(), TextureClass::S1024);
    resilient.force_device_loss();
    assert!(resilient.recover().expect("recovered"));
    // The new renderer's quality is the legacy one until the presenter sets it again: the replay
    // still lands the texture where its id says.
    let replayed = resilient.renderer().renderer();
    assert_eq!(replayed.texture_arrays(), Some((class("desktop-high"), high)), "the lost device's arrays");
    assert_eq!(replayed.texture_quality(), high);
    let added = resilient.add_texture(&checker(1024, 2), TextureKind::Color).expect("after recovery");
    assert_eq!((added.class(), added.layer()), (TextureClass::S1024, 1), "the replayed texture kept layer 0 of class 1024");
}

#[test]
fn a_source_past_the_largest_class_is_kept_at_its_side_and_a_smaller_one_untouched() {
    // Bodycam B1: a 4K map was decoded and kept whole for device-loss replay (64 MiB each) though
    // no size class stores more than 2048 texels a side.
    assert_eq!(SOURCE_TEXTURE_MAX_SIDE, TextureClass::S2048.side());
    let wide = TextureData::rgba8(4096, 1024, vec![200; 4096 * 1024 * 4]).expect("image");
    let capped = capped_source(&wide, TextureKind::Color);
    assert_eq!((capped.width(), capped.height()), (2048, 512), "the aspect is kept");
    assert!(capped.rgba().iter().all(|byte| *byte == 200), "a flat image stays flat");
    let small = TextureData::rgba8(2048, 2048, vec![7; 2048 * 2048 * 4]).expect("image");
    assert!(matches!(capped_source(&small, TextureKind::Data), std::borrow::Cow::Borrowed(_)), "a source within the cap is not copied");
    let pattern: Vec<u8> = (0..4096 * 4096 * 4).map(|at: usize| (at * 37 % 251) as u8).collect();
    let square = TextureData::rgba8(4096, 4096, pattern).expect("image");
    let from_capped = mip_chain(&capped_source(&square, TextureKind::Color), TextureKind::Color, 2048);
    assert_eq!(from_capped, mip_chain(&square, TextureKind::Color, 2048), "the 2048 class stores the same texels from the capped source");
}
