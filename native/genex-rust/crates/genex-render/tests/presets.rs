//! Presets per device class and destination, the memory budget ledger and its degrade ladder, and
//! the numeric work model (plan §2.4, §2.5). Pure CPU tables: no GPU.
//!
//! The byte totals below are the ledger's fixed model at the reference resolutions (the class
//! references carry the dpr cap, logical × min(dpr, 2)). They were computed independently of the
//! Rust ledger from the same formulas; a change to a total is a change to the model and is named
//! in the renderer log. The bloom chain is `rgba16float` on every class (storage-capable in core).

use genex_render::budget::{
    BudgetInput, BudgetKind, DegradeMode, DegradeRung, DegradeStep, MaterialClass, WorkModel, fit, ledger, upscale_work, work_model,
};
use genex_render::device_class::{DeviceClass, DeviceFacts, FormFactor, PerformanceTier, TargetOs, WebHints};
use genex_render::presets::{
    ANDROID_REFERENCE, ClassOverride, DESKTOP_REFERENCE, IPHONE_REFERENCE, LAPTOP_REFERENCE, MOBILE_MAX_RADIANCE_PX, MOBILE_RCAS_SHARPNESS, OFF_RENDER_PASSES, RenderOverrides,
    SHADOW_MAP_MAX_PX, SHADOW_MAP_MIN_PX, ShadowOverride, WEB_REFERENCE, class_budget_bytes, class_defaults, default_preset, drs_step_sizes, hdri_map_width, preset_quality, profile, reference_resolution,
    on_ldr_scene, render_pass_budget, resolve, scene_format, with_world_samples, work_limits,
};
use genex_render::graph::{feature_landed, not_landed};
use genex_render::settings::{
    AntiAliasing, AoResolution, DEFAULT_RCAS_SHARPNESS, KnobKind, PresetChoice, Quality, QualityKnob, QualityPreset, RenderFeature, RenderSettings,
    SceneFormat, ShadowFilter, ShadowFormat, Upscaler,
};
use wgpu::{Backend, DeviceType, Features};

const MIB: u64 = 1024 * 1024;

fn class(wire: &str) -> DeviceClass {
    DeviceClass::from_wire(wire).unwrap_or_else(|| panic!("{wire} is a class"))
}

fn mobile_classes() -> impl Iterator<Item = DeviceClass> {
    DeviceClass::ALL.into_iter().filter(|class| class.form == FormFactor::Mobile)
}

/// The budget input of `quality` on `class` at `output`, at the quality's nominal scale.
fn input(quality: &Quality, class: DeviceClass, output: (u32, u32), transient: bool) -> BudgetInput {
    BudgetInput::new(output, quality.render_scale, scene_format(class, true), transient)
}

fn total(quality: &Quality, input: &BudgetInput) -> u64 {
    ledger(quality, input).total()
}

#[test]
fn every_class_defaults_to_its_preset_frame_rate_and_scale() {
    let rows = [
        ("desktop-ultra", QualityPreset::Ultra, 60, None, 1.0),
        ("desktop-high", QualityPreset::High, 60, None, 1.0),
        ("desktop-mid", QualityPreset::Medium, 60, None, 1.0),
        ("desktop-low", QualityPreset::Low, 60, None, 0.85),
        ("mobile-high", QualityPreset::Medium, 60, None, 0.75),
        ("mobile-mid", QualityPreset::Low, 60, Some(30), 0.67),
        ("mobile-low", QualityPreset::Low, 30, None, 0.6),
    ];
    for (wire, preset, fps, sustained, scale) in rows {
        let defaults = class_defaults(class(wire));
        assert_eq!(defaults.preset, preset, "{wire}");
        assert_eq!((defaults.target_fps, defaults.sustained_fps), (fps, sustained), "{wire}");
        assert_eq!(defaults.nominal_scale, scale, "{wire}");
        assert_eq!(default_preset(class(wire), TargetOs::MacOs), preset, "{wire} natively");
        assert_eq!(preset_quality(preset, class(wire)).render_scale, scale, "{wire}: a preset renders at the class's nominal scale");
    }
}

#[test]
fn every_class_has_at_most_six_scale_steps_spanning_its_range_through_the_nominal_scale() {
    for class in DeviceClass::ALL {
        let defaults = class_defaults(class);
        let steps = defaults.drs_steps;
        assert!((2..=6).contains(&steps.len()), "{}: {} steps", class.wire(), steps.len());
        assert!(steps.windows(2).all(|pair| pair[0] < pair[1]), "{}: lowest first", class.wire());
        assert_eq!((steps[0], steps[steps.len() - 1]), defaults.drs_range, "{}", class.wire());
        assert!(steps.contains(&defaults.nominal_scale), "{}: the nominal scale is a step", class.wire());
        let sizes = drs_step_sizes(class, reference_resolution(class));
        assert_eq!(sizes.len(), steps.len());
        assert!(sizes.windows(2).all(|pair| pair[0].0 < pair[1].0 && pair[0].1 < pair[1].1), "{}: each step its own size", class.wire());
    }
    assert_eq!(drs_step_sizes(class("desktop-high"), (2560, 1440)).last(), Some(&(2560, 1440)));
    assert_eq!(drs_step_sizes(class("mobile-mid"), (1179, 2556))[2], (789, 1712), "0.67 of an iPhone 15 panel");
}

#[test]
fn the_reference_resolutions_carry_the_dpr_cap() {
    assert_eq!(DESKTOP_REFERENCE, (2560, 1440));
    assert_eq!(LAPTOP_REFERENCE, (1920, 1080));
    assert_eq!(IPHONE_REFERENCE, (786, 1704), "393x852 logical at dpr min(3, 2)");
    assert_eq!(ANDROID_REFERENCE, (824, 1830), "412x915 logical at dpr min(2.6, 2)");
    assert_eq!(WEB_REFERENCE, (1920, 1080));
    assert_eq!(reference_resolution(class("desktop-ultra")), DESKTOP_REFERENCE);
    assert_eq!(reference_resolution(class("desktop-low")), LAPTOP_REFERENCE);
    assert_eq!(reference_resolution(class("mobile-high")), IPHONE_REFERENCE);
    assert_eq!(reference_resolution(class("mobile-mid")), ANDROID_REFERENCE);
}

#[test]
fn the_preset_table_rows() {
    let desktop = class("desktop-high");
    let low = preset_quality(QualityPreset::Low, desktop);
    let medium = preset_quality(QualityPreset::Medium, desktop);
    let high = preset_quality(QualityPreset::High, desktop);
    let ultra = preset_quality(QualityPreset::Ultra, desktop);
    let aa: Vec<AntiAliasing> = [low, medium, high, ultra].iter().map(|q| q.anti_aliasing).collect();
    assert_eq!(aa, [AntiAliasing::Msaa4, AntiAliasing::Msaa4, AntiAliasing::Taa, AntiAliasing::TaaSharpen]);
    let shadows: Vec<(u8, u32, ShadowFilter)> =
        [low, medium, high, ultra].iter().map(|q| (q.shadows.cascades, q.shadows.map_size, q.shadows.filter)).collect();
    // Pass-1 gate findings 01 and 02 flip low's row (named in the log): two 1024 px cascades (was one).
    assert_eq!(
        shadows,
        [(2, 1024, ShadowFilter::Pcf3x3), (2, 1536, ShadowFilter::Pcf3x3), (3, 2048, ShadowFilter::PcssLite), (4, 4096, ShadowFilter::Pcss)]
    );
    // RQ3 review: each preset reaches its own distance with its split, blend band and end fade.
    let reach: Vec<(u16, u8, u8, u8)> = [low, medium, high, ultra]
        .iter()
        .map(|q| (q.shadows.distance, q.shadows.split_percent, q.shadows.blend_percent, q.shadows.fade_percent))
        .collect();
    // Pass-1 gate findings 01 and 02 flip low's split (named in the log): medium's 60 for its two cascades (was 50).
    assert_eq!(reach, [(50, 60, 0, 15), (50, 60, 10, 10), (80, 75, 10, 10), (80, 75, 10, 10)]);
    let off = Quality::off().shadows;
    assert_eq!((off.distance, off.split_percent, off.blend_percent, off.fade_percent), (40, 50, 0, 0), "the legacy renderer's");
    assert_eq!(low.shadows.format, ShadowFormat::Depth16);
    let cubes: Vec<(u32, u32)> = [low, medium, high, ultra].iter().map(|q| (q.environment.cube_size, q.environment.hdri_cube_size)).collect();
    assert_eq!(cubes, [(64, 64), (128, 128), (256, 256), (256, 512)], "ultra bakes an HDR map at 512 (plan §2.4)");
    let pacing: Vec<(u8, u16)> = [low, medium, high, ultra].iter().map(|q| (q.environment.rebake_cadence, q.environment.sun_rebake_tenths)).collect();
    assert_eq!(pacing, [(8, 20), (4, 10), (1, 5), (1, 5)], "a rebake's step cadence and the sun's turn (tenths of a degree) per preset");
    // P2-0.13 flipped (was 0, 5, 6 and 7 mips; named in the log): every preset's chain is the same
    // output-sized one, so the halo is as wide on each (renderer pass 2, P5); low's is off.
    let bloom: Vec<(bool, u16)> = [low, medium, high, ultra].iter().map(|q| (q.bloom.enabled, q.bloom.resolution)).collect();
    assert_eq!(bloom, [(false, 540), (true, 540), (true, 540), (true, 540)]);
    let ao: Vec<(AoResolution, u8, bool)> = [low, medium, high, ultra].iter().map(|q| (q.ao.resolution, q.ao.slices, q.ao.temporal)).collect();
    assert_eq!(ao, [(AoResolution::Off, 0, false), (AoResolution::Half, 1, false), (AoResolution::Half, 2, true), (AoResolution::Full, 3, true)]);
    let lights: Vec<(u32, u32, u8)> = [low, medium, high, ultra].iter().map(|q| (q.lights.cap, q.lights.tile_px, q.lights.shadowed_spots)).collect();
    assert_eq!(lights, [(64, 32, 0), (256, 32, 0), (1024, 16, 2), (1024, 16, 4)]);
    assert_eq!([low, medium, high, ultra].map(|q| q.exposure_input_divisor), [16, 8, 4, 4]);
    assert_eq!([low, medium, high, ultra].map(|q| q.contact_shadows), [false, false, true, true]);
    // R2 review: meshlets and Hi-Z occlusion measured slower on typical scenes, so no preset
    // defaults them on (presets::GEOMETRY_PATH_DEFAULT); the prepass stays on from medium.
    assert_eq!([low, medium, high, ultra].map(|q| (q.meshlets, q.occlusion)), [(false, false); 4], "meshlets and occlusion default off");
    assert_eq!([low, medium, high, ultra].map(|q| q.prepass), [false, true, true, true], "the prepass from medium");
    for quality in [low, medium, high, ultra] {
        assert!(quality.hdr && quality.tonemap && quality.exposure && quality.specular_aa, "every preset is HDR");
        assert!(quality.environment.sky && quality.environment.ibl, "the sky on every preset");
    }
    assert_eq!(preset_quality(QualityPreset::Ultra, class("desktop-ultra")).shadows.map_size, 4096, "4096 on desktop ultra");
}

#[test]
fn mobile_caps_never_yield_pcss_or_full_resolution_ao() {
    for class in mobile_classes() {
        for preset in QualityPreset::ALL {
            let quality = preset_quality(preset, class);
            let at = format!("{} {}", class.wire(), preset.wire());
            assert!(!matches!(quality.shadows.filter, ShadowFilter::Pcss | ShadowFilter::PcssLite), "{at}: no PCSS");
            assert_ne!(quality.ao.resolution, AoResolution::Full, "{at}: no full-resolution AO");
            assert!(quality.shadows.cascades <= 2 && quality.shadows.map_size <= 1536, "{at}: at most 2 x 1536");
            assert_eq!(quality.shadows.format, ShadowFormat::Depth16, "{at}");
            // P2-0.13 flipped (was at most 5 mips): one chain resolution on every phone preset.
            assert_eq!(quality.bloom.resolution, genex_render::presets::MOBILE_BLOOM_RESOLUTION, "{at}: the phones' bloom chain");
            assert!(!quality.meshlets, "{at}: meshlets off by default");
            let taa_allowed = class.tier == PerformanceTier::High && preset >= QualityPreset::High;
            assert_eq!(quality.anti_aliasing.temporal(), taa_allowed, "{at}: TAA only on mobile-high at high");
            if quality.anti_aliasing == AntiAliasing::Msaa4 {
                assert_eq!(quality.ao.resolution, AoResolution::Off, "{at}: tile + MSAA keeps AO off");
                assert!(!quality.occlusion && !quality.prepass, "{at}: no Hi-Z occlusion or Equal prepass with tile MSAA");
            }
        }
    }
    let low = preset_quality(QualityPreset::Low, class("mobile-low"));
    // Pass-1 gate finding 02 flips the weakest phone's cascades (named in the log): two of 512 px (was one of 768).
    assert_eq!((low.shadows.cascades, low.shadows.map_size, low.bloom.enabled), (2, 512, false), "mobile-low: 2 x 512, no bloom");
    assert_eq!(preset_quality(QualityPreset::Medium, class("mobile-high")).shadows.far_cadence, 2, "far cascade every 2nd frame");
}

/// Owner decision 2026-10-12 (b): a phone draws below scale 1 at every class default (0.6-0.75),
/// and a bilinear upscale there stair-steps thin edges, so every phone class upscales with EASU +
/// RCAS at every preset. Desktops keep the table's bilinear low (desktop-low's 0.85).
#[test]
fn every_phone_class_upscales_with_easu_and_rcas_at_every_preset() {
    for class in mobile_classes() {
        assert!(class_defaults(class).nominal_scale < 1.0, "{}: a phone draws below scale 1", class.wire());
        for preset in QualityPreset::ALL {
            let quality = preset_quality(preset, class);
            assert_eq!(quality.upscaler, Upscaler::Fsr1, "{} {}", class.wire(), preset.wire());
        }
    }
    assert_eq!(preset_quality(QualityPreset::Low, class("desktop-low")).upscaler, Upscaler::Bilinear, "desktops keep low's bilinear");
    assert_eq!(preset_quality(QualityPreset::Medium, class("desktop-mid")).upscaler, Upscaler::Fsr1);
}

/// GA leftovers (far dock specks): a phone's EASU + RCAS sharpens no harder than
/// `MOBILE_RCAS_SHARPNESS` stops at any preset; desktops keep their table's sharpness.
#[test]
fn every_phone_class_sharpens_its_upscale_no_harder_than_the_phone_softness() {
    for class in mobile_classes() {
        for preset in QualityPreset::ALL {
            let sharpness = preset_quality(preset, class).rcas.sharpness;
            assert!(sharpness >= MOBILE_RCAS_SHARPNESS, "{} {}: RCAS {sharpness} stops is sharper than {MOBILE_RCAS_SHARPNESS}", class.wire(), preset.wire());
        }
    }
    let desktop = class("desktop-high");
    assert_eq!(preset_quality(QualityPreset::Medium, desktop).rcas.sharpness, DEFAULT_RCAS_SHARPNESS, "desktops keep RCAS's default");
}

/// RQ4 review: the tile cap keys on the samples the world pass draws, not the AA asked for: until
/// TAA lands a TAA preset draws MSAA 4x, so on a phone its prepass, AO and contact shadows stay
/// off whenever the world pass is multisampled.
#[test]
fn on_every_mobile_class_a_multisampled_world_pass_draws_no_prepass_ao_or_contact_shadows() {
    for class in mobile_classes() {
        for preset in QualityPreset::ALL {
            let quality = preset_quality(preset, class);
            let at = format!("{} {}", class.wire(), preset.wire());
            if genex_render::renderer::landed_samples(quality.anti_aliasing) > 1 {
                assert_eq!(quality.ao.resolution, AoResolution::Off, "{at}: no AO over tile MSAA");
                assert!(!quality.prepass, "{at}: no prepass over tile MSAA");
                assert!(!quality.contact_shadows, "{at}: no contact shadows over tile MSAA");
            }
        }
    }
}

/// One shadow row: cascades, map side, filter, depth format, far-cascade cadence.
type ShadowRow = (u8, u32, ShadowFilter, ShadowFormat, u8);

/// The plan's shadow table (section 2.4) per class family and preset, with the caps: mobile and
/// the low tier draw Depth16 cascades and redraw far cascades every 2nd frame; mobile has no PCSS,
/// at most 2 cascades of 1536 px; mobile-low's are 512 px. `low` draws two cascades, 768 px on a
/// phone (pass-1 gate findings 01 and 02; it drew one of 1024, mobile-low one of 768, named in
/// the log). Desktop `low` filters 3x3 (RQ3 review),
/// phones' `low` keeps one hardware tap.
fn expected_shadows(class: DeviceClass, preset: QualityPreset) -> ShadowRow {
    use ShadowFilter::{Hardware2x2, Pcf3x3, Pcss, PcssLite};
    use ShadowFormat::{Depth16, Depth32};
    let low_tier = class.tier == PerformanceTier::Low;
    match (class.form, preset) {
        (FormFactor::Mobile, QualityPreset::Low) if low_tier => (2, 512, Hardware2x2, Depth16, 2),
        (FormFactor::Mobile, _) if low_tier => (2, 512, Pcf3x3, Depth16, 2),
        (FormFactor::Mobile, QualityPreset::Low) => (2, 768, Hardware2x2, Depth16, 2),
        (_, QualityPreset::Low) if low_tier => (2, 1024, Pcf3x3, Depth16, 2),
        (_, QualityPreset::Low) => (2, 1024, Pcf3x3, Depth16, 1),
        (FormFactor::Mobile, _) => (2, 1536, Pcf3x3, Depth16, 2),
        (_, QualityPreset::Medium) if low_tier => (2, 1536, Pcf3x3, Depth16, 2),
        (_, QualityPreset::High) if low_tier => (3, 2048, PcssLite, Depth16, 2),
        (_, QualityPreset::Medium) => (2, 1536, Pcf3x3, Depth32, 1),
        (_, QualityPreset::High) => (3, 2048, PcssLite, Depth32, 1),
        _ if low_tier => (4, 4096, Pcss, Depth16, 2),
        _ => (4, 4096, Pcss, Depth32, 1),
    }
}

#[test]
fn every_class_and_preset_has_the_planned_shadow_row() {
    for class in DeviceClass::ALL {
        for preset in QualityPreset::ALL {
            let shadows = preset_quality(preset, class).shadows;
            let row = (shadows.cascades, shadows.map_size, shadows.filter, shadows.format, shadows.far_cadence);
            assert_eq!(row, expected_shadows(class, preset), "{} {}", class.wire(), preset.wire());
            assert!(shadows.enabled, "{} {}: sun shadows on in every preset", class.wire(), preset.wire());
        }
    }
}

#[test]
fn each_class_default_preset_fits_its_budget_at_the_reference_resolution_without_losing_a_cascade() {
    for class in DeviceClass::ALL {
        let defaults = class_defaults(class);
        let quality = preset_quality(defaults.preset, class);
        let transient = class.form == FormFactor::Mobile;
        let at = input(&quality, class, reference_resolution(class), transient);
        let fitted = fit(&quality, &at, defaults.budget_bytes, DegradeMode::Boot);
        let name = format!("{} {}", class.wire(), defaults.preset.wire());
        assert!(fitted.fits, "{name}: {} bytes over {}", fitted.total_bytes, defaults.budget_bytes);
        assert!(fitted.steps.iter().all(|step| step.rung != DegradeRung::Cascades), "{name} keeps its cascades: {:?}", fitted.steps);
        assert_eq!(fitted.quality.shadows.cascades, quality.shadows.cascades, "{name}");
    }
}

#[test]
fn every_preset_on_every_class_fits_its_budget_after_the_ladder_and_cascades_go_last() {
    for class in DeviceClass::ALL {
        for preset in QualityPreset::ALL {
            let quality = preset_quality(preset, class);
            let transient = class.form == FormFactor::Mobile;
            let at = input(&quality, class, reference_resolution(class), transient);
            let fitted = fit(&quality, &at, class_defaults(class).budget_bytes, DegradeMode::Boot);
            let name = format!("{} {}", class.wire(), preset.wire());
            assert!(fitted.fits, "{name}: {} bytes over {}", fitted.total_bytes, class_defaults(class).budget_bytes);
            let rungs: Vec<DegradeRung> = fitted.steps.iter().map(|step| step.rung).collect();
            let order: Vec<usize> = rungs.iter().filter_map(|rung| DegradeRung::ALL.iter().position(|known| known == rung)).collect();
            assert!(order.is_sorted(), "{name}: rungs step down in the documented order: {rungs:?}");
            if let Some(first_cascade) = rungs.iter().position(|rung| *rung == DegradeRung::Cascades) {
                assert!(fitted.quality.shadows.map_size <= 768 || rungs[..first_cascade].contains(&DegradeRung::ShadowSize), "{name}");
            }
        }
    }
}

#[test]
fn the_most_a_game_may_ask_for_still_fits_every_class_at_its_reference_resolution() {
    let greedy = ShadowOverride::new().cascades(4).map_size(4096).filter(ShadowFilter::Pcss);
    for class in DeviceClass::ALL {
        let facts = mac();
        for preset in QualityPreset::ALL {
            let game = RenderOverrides { preset: Some(preset), shadows: vec![(preset, greedy)], ..RenderOverrides::default() };
            let quality = profile(&facts, class, &game, None).quality;
            let transient = class.form == FormFactor::Mobile;
            let at = input(&quality, class, reference_resolution(class), transient);
            let fitted = fit(&quality, &at, class_defaults(class).budget_bytes, DegradeMode::Boot);
            let name = format!("{} {} asking 4 x 4096 PCSS", class.wire(), preset.wire());
            assert!(fitted.fits, "{name}: {} bytes over {}", fitted.total_bytes, class_defaults(class).budget_bytes);
            assert!(fitted.quality.shadows.cascades >= 1 && fitted.quality.shadows.cascades <= quality.shadows.cascades, "{name}: the ladder only takes cascades away");
        }
    }
}

#[test]
fn the_showcases_four_cascades_at_high_fit_a_desktop_class_without_losing_one() {
    let game = RenderOverrides { shadows: vec![(QualityPreset::High, ShadowOverride::new().cascades(4))], ..RenderOverrides::default() };
    for wire in ["desktop-high", "desktop-ultra"] {
        let class = class(wire);
        let defaults = class_defaults(class);
        let quality = profile(&mac(), class, &RenderOverrides { preset: Some(QualityPreset::High), ..game.clone() }, None).quality;
        assert_eq!(quality.shadows.cascades, 4, "{wire}: four cascades at high");
        let fitted = fit(&quality, &input(&quality, class, reference_resolution(class), false), defaults.budget_bytes, DegradeMode::Boot);
        assert!(fitted.fits, "{wire}: {} bytes over {}", fitted.total_bytes, defaults.budget_bytes);
        assert_eq!(fitted.quality.shadows.cascades, 4, "{wire}: the ladder keeps all four: {:?}", fitted.steps);
    }
}

fn shadows_of(facts: &DeviceFacts, class: DeviceClass, game: &RenderOverrides, person: Option<&ClassOverride>) -> ShadowRow {
    let shadows = profile(facts, class, game, person).quality.shadows;
    (shadows.cascades, shadows.map_size, shadows.filter, shadows.format, shadows.far_cadence)
}

fn mac() -> DeviceFacts {
    DeviceFacts::new(TargetOs::MacOs, Backend::Metal, DeviceType::IntegratedGpu)
}

// RQ6 review: phones had no cap on local lights or shadowed spots, so a person picking High or
// Ultra on a phone got 1024 lights in 16 px tiles and 2-4 spot shadow passes every frame.
#[test]
fn phones_cap_local_lights_and_shadowed_spots_whatever_the_preset_or_the_switches_ask() {
    let ios = DeviceFacts::new(TargetOs::Ios, Backend::Metal, DeviceType::IntegratedGpu);
    let asks_everything = ClassOverride { switches: vec![(RenderFeature::SpotShadows, true), (RenderFeature::Clustered, true)], ..ClassOverride::default() };
    for class in mobile_classes() {
        let spots = if class.tier >= PerformanceTier::High { 1 } else { 0 };
        for preset in QualityPreset::ALL {
            let person = ClassOverride { preset: Some(preset), ..asks_everything.clone() };
            for lights in [preset_quality(preset, class).lights, profile(&ios, class, &RenderOverrides::default(), Some(&person)).quality.lights] {
                let at = format!("{} {}", class.wire(), preset.wire());
                assert!(lights.cap <= 256, "{at}: {} lights", lights.cap);
                assert!(lights.tile_px >= 32, "{at}: {} px tiles", lights.tile_px);
                assert!(lights.shadowed_spots <= spots, "{at}: {} shadowed spots", lights.shadowed_spots);
            }
        }
    }
    let desktop = preset_quality(QualityPreset::Ultra, class("desktop-ultra")).lights;
    assert_eq!((desktop.cap, desktop.tile_px, desktop.shadowed_spots), (1024, 16, 4), "desktops keep the preset's");
}

// RX review: the clustered switch off fell back to the per-pixel loop over up to 256 lights, several
// times low's cost on a many-light scene (stress-plaza 7.8 ms against 1.0 ms at 720p), so a person who
// unticked it got a slower picture rather than a cheaper one.
#[test]
fn the_clustered_switch_off_shades_only_the_few_nearest_lights_on_every_class_and_preset() {
    let mac = DeviceFacts::new(TargetOs::MacOs, Backend::Metal, DeviceType::DiscreteGpu);
    let ios = DeviceFacts::new(TargetOs::Ios, Backend::Metal, DeviceType::IntegratedGpu);
    let unclustered = ClassOverride { switches: vec![(RenderFeature::Clustered, false)], ..ClassOverride::default() };
    for class in DeviceClass::ALL {
        let facts = if class.form == FormFactor::Mobile { &ios } else { &mac };
        let most = if class.form == FormFactor::Mobile { 4 } else { 8 };
        for preset in QualityPreset::ALL {
            let person = ClassOverride { preset: Some(preset), ..unclustered.clone() };
            let lights = profile(facts, class, &RenderOverrides::default(), Some(&person)).quality.lights;
            let at = format!("{} {}", class.wire(), preset.wire());
            assert!(!lights.clustered, "{at}: the switch is off");
            assert!(lights.cap <= most, "{at}: the per-pixel loop shades {} lights", lights.cap);
            let on = ClassOverride { preset: Some(preset), ..ClassOverride::default() };
            let binned = profile(facts, class, &RenderOverrides::default(), Some(&on)).quality.lights;
            assert!(binned.cap > most, "{at}: the binned path keeps the preset's {} lights", binned.cap);
        }
    }
    assert_eq!(Quality::off().lights.cap, 256, "the legacy renderer (`off`) keeps its loop over 256 lights");
}

#[test]
fn the_texture_quality_and_spot_shadow_switches_turn_their_features_off_and_back_on() {
    let high = preset_quality(QualityPreset::High, class("desktop-high"));
    let mut quality = high;
    quality.set_feature(RenderFeature::TextureQuality, false);
    quality.set_feature(RenderFeature::SpotShadows, false);
    assert!(!quality.feature(RenderFeature::TextureQuality) && !quality.feature(RenderFeature::SpotShadows));
    assert_eq!((quality.textures, quality.lights.shadowed_spots), (genex_render::settings::TextureQuality::OFF, 0));
    quality.set_feature(RenderFeature::TextureQuality, true);
    quality.set_feature(RenderFeature::SpotShadows, true);
    assert!(quality.feature(RenderFeature::TextureQuality) && quality.feature(RenderFeature::SpotShadows));
    let mut kept = high;
    kept.set_feature(RenderFeature::TextureQuality, true);
    kept.set_feature(RenderFeature::SpotShadows, true);
    assert_eq!((kept.textures, kept.lights.shadowed_spots), (high.textures, high.lights.shadowed_spots), "on keeps the preset's");
    for feature in [RenderFeature::TextureQuality, RenderFeature::SpotShadows] {
        assert_eq!(RenderFeature::from_wire(feature.wire()), Some(feature));
    }
    assert_eq!((RenderFeature::TextureQuality.wire(), RenderFeature::SpotShadows.wire()), ("texture-quality", "spot-shadows"));
}

#[test]
fn a_game_asks_for_more_cascades_at_one_preset_and_nothing_else_moves() {
    let game = RenderOverrides { shadows: vec![(QualityPreset::High, ShadowOverride::new().cascades(4))], ..RenderOverrides::default() };
    let high = class("desktop-high");
    assert_eq!(shadows_of(&mac(), high, &game, None), (4, 2048, ShadowFilter::PcssLite, ShadowFormat::Depth32, 1), "high: 4 cascades, rest of the row");
    let at = |preset| RenderOverrides { preset: Some(preset), ..game.clone() };
    assert_eq!(shadows_of(&mac(), high, &at(QualityPreset::Medium), None), expected_shadows(high, QualityPreset::Medium), "medium untouched");
    assert_eq!(shadows_of(&mac(), high, &at(QualityPreset::Ultra), None), expected_shadows(high, QualityPreset::Ultra), "ultra untouched");
    assert_eq!(shadows_of(&mac(), high, &at(QualityPreset::Low), None), expected_shadows(high, QualityPreset::Low), "low untouched");
}

#[test]
fn shadow_choices_layer_game_then_class_table_then_person_key_by_key() {
    let mid = class("desktop-mid");
    let game = RenderOverrides {
        shadows: vec![(QualityPreset::Medium, ShadowOverride::new().cascades(3).map_size(2048))],
        classes: vec![(mid, ClassOverride { shadows: ShadowOverride::new().filter(ShadowFilter::Pcf5x5), ..ClassOverride::default() })],
        ..RenderOverrides::default()
    };
    assert_eq!(shadows_of(&mac(), mid, &game, None), (3, 2048, ShadowFilter::Pcf5x5, ShadowFormat::Depth32, 1), "game keys, then the table's filter");
    let person = ClassOverride { shadows: ShadowOverride::new().cascades(1), ..ClassOverride::default() };
    assert_eq!(shadows_of(&mac(), mid, &game, Some(&person)), (1, 2048, ShadowFilter::Pcf5x5, ShadowFormat::Depth32, 1), "the person's cascades win");
    let other = shadows_of(&mac(), class("desktop-high"), &game, None);
    assert_eq!(other, expected_shadows(class("desktop-high"), QualityPreset::High), "another class without the table keeps its row");
}

#[test]
fn shadow_choices_are_held_to_their_range_and_never_switch_shadows_back_on() {
    let high = class("desktop-high");
    let wild = |shadow: ShadowOverride| ClassOverride { shadows: shadow, ..ClassOverride::default() };
    let many = shadows_of(&mac(), high, &RenderOverrides::default(), Some(&wild(ShadowOverride::new().cascades(9).map_size(1_000_000))));
    assert_eq!((many.0, many.1), (4, SHADOW_MAP_MAX_PX), "at most 4 cascades, at most {SHADOW_MAP_MAX_PX} px");
    let none = shadows_of(&mac(), high, &RenderOverrides::default(), Some(&wild(ShadowOverride::new().cascades(0).map_size(1))));
    assert_eq!((none.0, none.1), (1, SHADOW_MAP_MIN_PX), "at least 1 cascade, at least {SHADOW_MAP_MIN_PX} px");
    let off = ClassOverride { switches: vec![(RenderFeature::Shadows, false)], shadows: ShadowOverride::new().cascades(4), ..ClassOverride::default() };
    let quality = profile(&mac(), high, &RenderOverrides::default(), Some(&off)).quality;
    assert!(!quality.shadows.enabled, "a cascade count does not undo the shadows switch");
}

#[test]
fn shadow_choices_cannot_pass_the_mobile_or_low_tier_caps() {
    let greedy = ShadowOverride::new().cascades(4).map_size(4096).filter(ShadowFilter::Pcss);
    let game = RenderOverrides { preset: Some(QualityPreset::Ultra), shadows: vec![(QualityPreset::Ultra, greedy)], ..RenderOverrides::default() };
    for phone in ["mobile-high", "mobile-mid"] {
        let row = shadows_of(&mac(), class(phone), &game, None);
        assert_eq!(row, (2, 1536, ShadowFilter::Pcf3x3, ShadowFormat::Depth16, 2), "{phone}: 2 x 1536, no PCSS, Depth16, far cadence 2");
    }
    let low = shadows_of(&mac(), class("mobile-low"), &game, None);
    // Pass-1 gate finding 02 flips the weakest phone's cap (named in the log): two 512 px cascades (was one of 768).
    assert_eq!(low, (2, 512, ShadowFilter::Pcf3x3, ShadowFormat::Depth16, 2), "mobile-low: two 512 px cascades, far cadence 2");
    let laptop = shadows_of(&mac(), class("desktop-low"), &game, None);
    assert_eq!((laptop.3, laptop.4), (ShadowFormat::Depth16, 2), "an old laptop keeps Depth16 and the far cadence at any request");
    assert_eq!(laptop.0, 4, "a laptop may ask for cascades; the budget ladder trims them last");
    let two_on_a_phone = ShadowOverride::new().cascades(2);
    let phone_game = RenderOverrides { preset: Some(QualityPreset::Low), shadows: vec![(QualityPreset::Low, two_on_a_phone)], ..RenderOverrides::default() };
    assert_eq!(shadows_of(&mac(), class("mobile-mid"), &phone_game, None).4, 2, "a second cascade on a phone brings the cadence with it");
}

#[test]
fn the_web_never_defaults_to_ultra() {
    for class in DeviceClass::ALL {
        assert!(default_preset(class, TargetOs::Web) <= QualityPreset::High, "{} on the web", class.wire());
    }
    assert_eq!(default_preset(class("desktop-ultra"), TargetOs::MacOs), QualityPreset::Ultra);
    assert_eq!(default_preset(class("desktop-ultra"), TargetOs::Web), QualityPreset::High);
}

#[test]
fn the_scene_format_is_per_class_never_per_preset() {
    let rg11b10 = DeviceFacts { features: Features::RG11B10UFLOAT_RENDERABLE, ..DeviceFacts::new(TargetOs::Ios, Backend::Metal, DeviceType::IntegratedGpu) };
    let plain = DeviceFacts::new(TargetOs::Ios, Backend::Metal, DeviceType::IntegratedGpu);
    for class in DeviceClass::ALL {
        let cheap = class.form == FormFactor::Mobile || class.tier == PerformanceTier::Low;
        let formats: Vec<SceneFormat> = QualityPreset::ALL
            .into_iter()
            .map(|preset| {
                let game = RenderOverrides { preset: Some(preset), ..RenderOverrides::default() };
                profile(&rg11b10, class, &game, None).scene_format
            })
            .collect();
        let expected = if cheap { SceneFormat::Rg11b10Ufloat } else { SceneFormat::Rgba16Float };
        assert!(formats.iter().all(|format| *format == expected), "{}: {formats:?}", class.wire());
        assert_eq!(profile(&plain, class, &RenderOverrides::default(), None).scene_format, SceneFormat::Rgba16Float, "no RG11B10 renderable");
    }
}

#[test]
fn genex_toml_overrides_merge_over_the_class_and_the_person_over_both() {
    let facts = DeviceFacts::new(TargetOs::Android, Backend::Vulkan, DeviceType::IntegratedGpu);
    let mobile_mid = class("mobile-mid");
    assert_eq!(profile(&facts, mobile_mid, &RenderOverrides::default(), None).preset, QualityPreset::Low);
    let table = ClassOverride {
        preset: Some(QualityPreset::Medium),
        render_scale: Some(0.6),
        fps: Some(30),
        switches: vec![(RenderFeature::Bloom, false), (RenderFeature::Fog, false)],
        ..ClassOverride::default()
    };
    let game = RenderOverrides { preset: Some(QualityPreset::High), classes: vec![(mobile_mid, table)], ..RenderOverrides::default() };
    let merged = profile(&facts, mobile_mid, &game, None);
    assert_eq!(merged.preset, QualityPreset::Medium, "the class table beats [render] preset");
    assert_eq!(merged.quality.render_scale, 0.6);
    assert_eq!(merged.target_fps, 30);
    assert!(!merged.quality.bloom.enabled && !merged.quality.fog, "switches land on top of the preset");
    assert_eq!(merged.quality.shadows.map_size, 1536, "mobile caps still shape the preset");
    let other = profile(&facts, class("mobile-high"), &game, None);
    assert_eq!(other.preset, QualityPreset::High, "[render] preset applies where no class table does");
    let person = ClassOverride { preset: Some(QualityPreset::Low), switches: vec![(RenderFeature::Bloom, true)], ..ClassOverride::default() };
    let theirs = profile(&facts, mobile_mid, &game, Some(&person));
    assert_eq!(theirs.preset, QualityPreset::Low, "the person's preset wins");
    assert!(theirs.quality.bloom.enabled, "and their switch");
    assert_eq!(theirs.quality.render_scale, 0.6, "a key the person left alone keeps the game's value");
    let wild = ClassOverride { render_scale: Some(0.1), ..ClassOverride::default() };
    assert_eq!(profile(&facts, mobile_mid, &RenderOverrides::default(), Some(&wild)).quality.render_scale, 0.5, "never below 0.5");
}

#[test]
fn resolve_takes_the_class_preset_for_auto_and_keeps_off() {
    let mobile = class("mobile-high");
    let auto = resolve(&RenderSettings::auto(), mobile);
    assert_eq!(auto.quality, preset_quality(QualityPreset::Medium, mobile));
    assert_eq!(auto.preset, PresetChoice::Auto);
    assert_eq!(resolve(&RenderSettings::off(), mobile), RenderSettings::off(), "off stays the legacy renderer");
}

#[test]
fn the_class_budget_on_the_web_is_capped_by_device_memory() {
    let native = DeviceFacts::new(TargetOs::MacOs, Backend::Metal, DeviceType::IntegratedGpu);
    assert_eq!(class_budget_bytes(class("desktop-ultra"), &native), 1024 * MIB);
    assert_eq!(class_budget_bytes(class("mobile-mid"), &native), 96 * MIB);
    let web = |hints: Option<WebHints>| {
        let facts = DeviceFacts::new(TargetOs::Web, Backend::BrowserWebGpu, DeviceType::Other);
        match hints {
            Some(hints) => facts.with_web(hints),
            None => facts,
        }
    };
    let eight = WebHints { device_memory_gb: Some(8.0), ..WebHints::default() };
    assert_eq!(class_budget_bytes(class("desktop-ultra"), &web(Some(eight))), 256 * MIB, "the web caps at 256 MB");
    assert_eq!(class_budget_bytes(class("desktop-ultra"), &web(Some(WebHints::default()))), 128 * MIB, "a missing deviceMemory reads as 4");
    assert_eq!(class_budget_bytes(class("desktop-ultra"), &web(None)), 128 * MIB);
    let two = WebHints { device_memory_gb: Some(2.0), ..WebHints::default() };
    assert_eq!(class_budget_bytes(class("mobile-mid"), &web(Some(two))), 64 * MIB);
    assert_eq!(class_budget_bytes(class("mobile-low"), &web(Some(eight))), 48 * MIB, "never above the class");
}

/// Owner decision 2026-10-12 (2): on a native desktop the budget is max(class default, min(GPU-visible
/// memory / 8, 2 GiB)); unknown memory keeps the class default; phones and the web keep theirs.
#[test]
fn a_native_desktop_budget_scales_with_the_gpu_visible_memory_the_platform_reports() {
    const GIB: u64 = 1024 * MIB;
    let mac = |bytes: Option<u64>| {
        DeviceFacts::new(TargetOs::MacOs, Backend::Metal, DeviceType::IntegratedGpu).with_gpu_visible_memory(bytes)
    };
    let pc = |os: TargetOs, backend: Backend, device_type: DeviceType, bytes: Option<u64>| {
        DeviceFacts::new(os, backend, device_type).with_gpu_visible_memory(bytes)
    };
    // A 36 GB M-series Mac: Metal recommends about 27 GB, an eighth is past the 2 GiB ceiling.
    let large_mac = mac(Some(27 * GIB));
    // An 8 GB MacBook Air: Metal recommends two thirds of it, an eighth of that is about 683 MiB.
    let small_mac = mac(Some(8 * GIB / 3 * 2));
    let rows = [
        ("36 GB Mac", "desktop-high", large_mac.clone(), 2 * GIB),
        ("36 GB Mac", "desktop-ultra", large_mac.clone(), 2 * GIB),
        ("36 GB Mac", "desktop-low", large_mac, 2 * GIB),
        ("8 GB MacBook Air", "desktop-high", small_mac.clone(), 8 * GIB / 3 * 2 / 8),
        ("8 GB MacBook Air", "desktop-ultra", small_mac, 1024 * MIB),
        ("unknown Mac", "desktop-high", mac(None), 512 * MIB),
        ("8 GB discrete PC", "desktop-mid", pc(TargetOs::Windows, Backend::Dx12, DeviceType::DiscreteGpu, Some(8 * GIB)), GIB),
        ("8 GB discrete Linux box", "desktop-mid", pc(TargetOs::Linux, Backend::Vulkan, DeviceType::DiscreteGpu, Some(8 * GIB)), GIB),
        ("2 GB discrete PC", "desktop-ultra", pc(TargetOs::Windows, Backend::Dx12, DeviceType::DiscreteGpu, Some(2 * GIB)), 1024 * MIB),
        ("128 MB integrated PC", "desktop-mid", pc(TargetOs::Windows, Backend::Dx12, DeviceType::IntegratedGpu, Some(128 * MIB)), 256 * MIB),
        ("unknown PC", "desktop-mid", pc(TargetOs::Windows, Backend::Vulkan, DeviceType::DiscreteGpu, None), 256 * MIB),
        // Phones and the web keep their budgets: memory pressure kills a phone's app, and the web
        // reads deviceMemory.
        ("iPhone", "mobile-high", pc(TargetOs::Ios, Backend::Metal, DeviceType::IntegratedGpu, Some(6 * GIB)), 160 * MIB),
        ("Android", "mobile-mid", pc(TargetOs::Android, Backend::Vulkan, DeviceType::IntegratedGpu, Some(12 * GIB)), 96 * MIB),
        ("browser", "desktop-ultra", pc(TargetOs::Web, Backend::BrowserWebGpu, DeviceType::Other, Some(27 * GIB)), 128 * MIB),
    ];
    for (device, wire, facts, bytes) in rows {
        assert_eq!(class_budget_bytes(class(wire), &facts), bytes, "{device} as {wire}");
    }
}

#[test]
fn on_the_web_every_class_default_fits_and_halves_its_shadow_maps_before_giving_up_anti_aliasing() {
    // RQ3 review: on a browser that hides deviceMemory (128 MB) desktop-high's own `high` fitted
    // only by dropping TAA while its 3 x 2048 maps stayed 32-bit; the shadow format rung now halves
    // the maps first (that 128 MB budget still takes the TAA history after it).
    let web = |memory: Option<f32>| {
        let facts = DeviceFacts::new(TargetOs::Web, Backend::BrowserWebGpu, DeviceType::Other);
        match memory {
            Some(gb) => facts.with_web(WebHints { device_memory_gb: Some(gb), ..WebHints::default() }),
            None => facts,
        }
    };
    for memory in [None, Some(2.0), Some(4.0), Some(8.0)] {
        let facts = web(memory);
        for class in DeviceClass::ALL {
            let preset = default_preset(class, TargetOs::Web);
            let quality = preset_quality(preset, class);
            let at = input(&quality, class, WEB_REFERENCE, class.form == FormFactor::Mobile);
            let budget = class_budget_bytes(class, &facts);
            let fitted = fit(&quality, &at, budget, DegradeMode::Boot);
            let name = format!("{} {} on the web, deviceMemory {memory:?}", class.wire(), preset.wire());
            assert!(fitted.fits, "{name}: {} bytes over {budget} after {:?}", fitted.total_bytes, fitted.steps);
            let gave_up_aa = fitted.steps.iter().any(|step| matches!(step.rung, DegradeRung::TaaHistory | DegradeRung::Msaa));
            let kept_32_bit = fitted.quality.shadows.format == ShadowFormat::Depth32;
            assert!(!(gave_up_aa && kept_32_bit), "{name}: gave up anti-aliasing but kept 32-bit shadow maps ({:?})", fitted.steps);
        }
    }
}

#[test]
fn the_ledger_gives_fixed_byte_totals_at_the_reference_resolutions() {
    let off = Quality::off();
    let legacy = BudgetInput::new((1920, 1080), 1.0, SceneFormat::Ldr, false);
    assert_eq!(total(&off, &legacy), 83_038_208, "off: MSAA colour + world target + MSAA depth + 2 x 1024 Depth32");
    let transient = BudgetInput::new((1920, 1080), 1.0, SceneFormat::Ldr, true);
    assert_eq!(total(&off, &transient), 16_683_008, "transient MSAA attachments count 0 bytes");

    let rows = [
        // High and ultra ask for TAA, drawn as MSAA 4x until TAA lands: the ledger counts the MSAA
        // colour and depth the renderer allocates (RQ1 review), not a TAA history.
        // RQ2 review flips every total (named in the log): the IBL rows are the bake's own
        // allocations (`ibl::bake_parts`: two sets of cubes with six roughness levels and SH9, a
        // 128 px BRDF LUT; ultra's HDR map cube is 512 px). The RQ4 review flips the AO rows (named
        // in the log): the ledger counts AO's and the contact shadows' pool targets as allocated
        // (the R32F view-depth chains, the bent term, the render-size upsamples, the mask). The R2
        // review flips the four desktop medium-and-up rows (named in the log): occlusion defaults
        // off, so no Hi-Z pyramid (an r32float chain) is held: -4_915_052 bytes at 1440p and
        // -2_764_220 at 1080p (they were 375_366_384, 176_841_428, 674_914_640, 240_843_592).
        // RQ6.7 flips the rows with shadowed spots (named in the log): the spots are tiles of one
        // atlas layer at the cascades' side, as the renderer allocates it, not 1024 px per spot:
        // desktop-high +8_388_608 (was 370_451_332 / 238_079_372), desktop-ultra +50_331_648 (was
        // 669_999_588), mobile-mid high +524_288 (was 56_571_324 / 99_795_900).
        // RQ6 review flips them again (named in the log): the spot atlas is reserved only for a game
        // that uses shadowed spots (`BudgetInput::with_spot_atlas`; these inputs do not), so
        // desktop-high -16_777_216 (was 378_839_940 / 246_467_980) and desktop-ultra -67_108_864
        // (was 720_331_236); phones cap their lights (`presets::cap_lights`: at most 256 in 32 px
        // tiles, no shadowed spot on mobile-mid), so mobile-mid high -5_360_192 (was 57_095_612 /
        // 100_320_188).
        // RQ5.6 flips (named in the log): TAA draws one sample, so high and ultra count the 1x
        // `rgba16float` scene, TAA's history pair, the motion and the `r8unorm` reactive mask
        // instead of the MSAA colour and depth (desktop-high 1440p was 362_062_724, 1080p
        // 229_690_764; desktop-ultra was 653_222_372); FSR1's tonemapped `rgb10a2unorm`
        // intermediate at render size is counted where FSR1 or TAA's sharpen runs (mobile-high
        // medium was 27_923_420, mobile-mid high 51_735_420 / 94_959_996).
        // Owner decision 2026-10-12 (b) flips the phone low rows (named in the log): phones upscale
        // with EASU + RCAS, so they hold FSR1's render-size intermediate and EASU's output-size
        // image (`fsr::bytes`): mobile-mid low +8_738_688 at 824x1830 (was 11_720_692) and
        // +15_018_336 at 1080x2400 (was 18_004_108), mobile-low low +8_201_328 (was 10_264_692).
        // Pass-1 gate findings 01 and 02 flip the low rows (named in the log): low draws two
        // Depth16 cascades, desktop-low +2_097_152 for a second 1024 px map (was 65_216_956),
        // mobile-mid two 768 px maps for one 1024 px map +262_144 (was 20_459_380 / 33_022_444),
        // mobile-low two 512 px maps for one 768 px map -131_072 (was 18_466_020).
        // Pass-1 fix gate (visual RED 01) flips desktop-mid medium (named in the log): one slice's
        // raw AO term carries its weight beside its visibility (`ao::RAW_WEIGHTED_FORMAT`,
        // `rg8unorm`), +518_400 bytes at 960 x 540 (was 174_077_208). Phone mediums draw no AO.
        // Pass 2 P2-0.6 (P3/S2) flips the temporal-AO rows (named in the log): AO's history and the
        // term it ping-pongs with are `rgba16float`, 4 more bytes a texel each at the AO size:
        // desktop-high +7_372_800 at 1440p (was 262_529_924) and +4_147_200 at 1080p (was
        // 173_703_564), desktop-ultra +29_491_200 (was 568_435_172).
        // Pass 2 P2-0.11 (SI-01, SI-02) flips every row (named in the log): the radiance cube the
        // prefilter reads is half the specular side, uncapped (was 32 px), one cube shared by both
        // sets (was one per set), plus the sky's 16 px SH9 source: high and the phones' high
        // (256 px cubes) +929_808 (desktop-high was 269_902_724 at 1440p and 177_850_764 at 1080p,
        // mobile-mid high 57_138_492 and 100_363_068), medium (128) +143_376 (desktop-mid was
        // 174_595_608, mobile-high medium 30_934_388), low (64) -53_232 (desktop-low was
        // 67_314_108, mobile-mid low 20_721_524 and 33_284_588, mobile-low 18_334_948), ultra
        // (a 512 px map cube) +4_075_536 (was 597_926_372). The phones' radiance cube is capped at
        // 64 px (`MOBILE_MAX_RADIANCE_PX`), so mobile-mid's high rows take +143_376, not +929_808,
        // and the row without transient MSAA keeps its 96 MiB budget.
        // Pass 2 P2-0.13 (P5) flips the bloom rows (named in the log): the chain is sized from the
        // output, `min(output height / 2, 540)` rows (360 on phones) with seven mips down to 8 rows,
        // never the render size, and a scene more than twice the top's height is first filtered into
        // a pre-level at twice the top's size: desktop-high and desktop-ultra at 1440p +12_289_120 /
        // +12_287_360 (a 960 x 540 chain and its 1920 x 1080 pre-level for a 1280 x 720 chain; was
        // 270_832_532 / 602_001_908), desktop-mid medium +4_800 (seven mips for five; was
        // 174_738_984), desktop-high at 1080p +960 (seven for six; was 178_780_572), mobile-high
        // medium +549_544 (was 31_077_764) and mobile-mid high -1_043_696 (was 57_281_868 and
        // 100_506_444; a 166 x 360 chain and its 332 x 720 pre-level). The low rows draw no bloom.
        // Pass 2 B.7 flips the high and ultra rows (named in the log): the sun-shadow screen mask's
        // raw, two state and mask targets, 28 bytes a render pixel: +103_219_200 at 1440p (was
        // 283_121_652 and 614_289_268) and +58_060_800 at 1080p (was 178_781_532).
        // Pass 2 A.5 flips the rows with the aerial volume and the high and ultra rows (named in the
        // log): the aerial volume holds its transmittance per channel behind its in-scatter (SI-04,
        // 32 x 32 x 64, +262_144 on every medium, high and ultra row), and the froxel fog's four
        // volumes (high 112 x 63 x 64: +14_450_688; ultra 160 x 90 x 64: +29_491_200). Was
        // 386_340_852, 174_743_784, 717_508_468, 236_842_332, 31_627_308, 56_238_172 and
        // 99_462_748.
        ("desktop-high", QualityPreset::High, (2560, 1440), false, 401_053_684),
        ("desktop-mid", QualityPreset::Medium, (1920, 1080), false, 175_005_928),
        ("desktop-ultra", QualityPreset::Ultra, (2560, 1440), false, 747_261_812),
        ("desktop-low", QualityPreset::Low, (1920, 1080), false, 67_260_876),
        ("desktop-high", QualityPreset::High, (1920, 1080), false, 251_555_164),
        ("mobile-high", QualityPreset::Medium, (786, 1704), true, 31_889_452),
        ("mobile-mid", QualityPreset::Low, (824, 1830), true, 20_668_292),
        ("mobile-mid", QualityPreset::Low, (1080, 2400), true, 33_231_356),
        ("mobile-mid", QualityPreset::High, (1179, 2556), true, 56_500_316),
        ("mobile-mid", QualityPreset::High, (1179, 2556), false, 99_724_892),
        ("mobile-low", QualityPreset::Low, (824, 1830), true, 18_281_716),
    ];
    for (wire, preset, output, transient, bytes) in rows {
        let quality = preset_quality(preset, class(wire));
        let at = input(&quality, class(wire), output, transient);
        assert_eq!(total(&quality, &at), bytes, "{wire} {} at {output:?} transient {transient}", preset.wire());
        assert!(total(&quality, &at) <= class_defaults(class(wire)).budget_bytes, "{wire} fits its class budget");
    }
}

#[test]
fn every_class_default_fits_its_budget_with_its_widest_hdr_map_reserved() {
    for class in DeviceClass::ALL {
        let quality = preset_quality(class_defaults(class).preset, class);
        let tile = class.form == FormFactor::Mobile;
        let bare = input(&quality, class, reference_resolution(class), tile);
        let width = hdri_map_width(class);
        let reserved = ledger(&quality, &bare.clone().with_environment_map(width));
        let map = reserved.entries().iter().find(|entry| entry.label == "environment-map").expect("the map is reserved");
        assert_eq!(map.bytes, genex_render::ibl::map_bytes(width, width / 2), "{}", class.wire());
        assert_eq!(reserved.total(), total(&quality, &bare) + map.bytes);
        assert!(reserved.total() <= class_defaults(class).budget_bytes, "{}: {} of {}", class.wire(), reserved.total(), class_defaults(class).budget_bytes);
    }
    assert_eq!(hdri_map_width(class("mobile-low")), 1024, "a phone keeps a 1k map (5.6 MB with mips), never the 85 MB cap");
    assert_eq!(hdri_map_width(class("desktop-ultra")), genex_render::hdri::HDRI_MAX_WIDTH);
}

#[test]
fn material_arrays_and_level_3_passes_are_ledger_entries() {
    let quality = preset_quality(QualityPreset::Low, class("mobile-mid"));
    let bare = input(&quality, class("mobile-mid"), ANDROID_REFERENCE, true);
    let loaded = bare.clone().with_material(MaterialClass { size_px: 256, layers: 64 }).with_pass("lake", 3 * MIB);
    let entries = ledger(&quality, &loaded);
    let materials = entries.entries().iter().find(|entry| entry.kind == BudgetKind::MaterialArrays).expect("a material entry");
    assert_eq!(materials.bytes, 22_369_536, "256 px x 64 layers rgba8 with a full mip chain");
    let pass = entries.entries().iter().find(|entry| entry.kind == BudgetKind::Pass).expect("a pass entry");
    assert_eq!((pass.label.as_str(), pass.bytes), ("lake", 3 * MIB));
    assert_eq!(entries.total(), total(&quality, &bare) + 22_369_536 + 3 * MIB);
}

#[test]
fn two_material_arrays_of_one_shape_are_two_ledger_entries() {
    // RQ6.7: a class halved onto the next one's shape (or two equal reservations) counted once
    // before, because ledger entries of one kind and label replace each other.
    let quality = preset_quality(QualityPreset::Low, class("mobile-mid"));
    let bare = input(&quality, class("mobile-mid"), ANDROID_REFERENCE, true);
    let array = MaterialClass { size_px: 256, layers: 16 };
    let twice = ledger(&quality, &bare.clone().with_material(array).with_material(array));
    assert_eq!(twice.entries().iter().filter(|entry| entry.kind == BudgetKind::MaterialArrays).count(), 2);
    assert_eq!(twice.total(), total(&quality, &bare) + 2 * array.bytes());
}

#[test]
fn mobile_mid_high_on_an_iphone_panel_degrades_in_the_documented_order_to_fit_96_mb() {
    let mobile_mid = class("mobile-mid");
    let quality = preset_quality(QualityPreset::High, mobile_mid);
    let at = input(&quality, mobile_mid, (1179, 2556), true)
        .with_material(MaterialClass { size_px: 256, layers: 64 })
        .with_material(MaterialClass { size_px: 512, layers: 16 })
        .with_pass("lake", 24 * MIB);
    // RQ6.7 flipped (was 126_476_284 and 94_748_604 fitted): two shadowed spots are one atlas
    // layer at the cascades' 1536 px side, which the shadow-size rung halves with the cascades.
    // RQ6 review flipped (was 127_000_572 and 91_733_948 fitted): mobile-mid draws no shadowed
    // spot and bins at most 256 lights in 32 px tiles (`presets::cap_lights`); same steps.
    // RQ5.6 flipped (was 121_640_380 and 89_912_700 fitted): FSR1's intermediate at render size
    // (789 x 1712 rgb10a2unorm, 5_403_072 bytes); same steps.
    // P2-0.11 flipped (was 127_043_452 and 95_315_772 fitted; named in the log): the shared
    // radiance cube, capped at 64 px on phones, and the sky's SH9 source; same steps.
    // P2-0.13 flipped (was 127_186_828; named in the log): the bloom chain is sized from the
    // output (a 166 x 360 top on this portrait panel, seven mips for five, and its 332 x 720
    // pre-level), and its rung halves that resolution (was bloom mips 5 -> 4).
    // Pass 2 A.5 flipped (was 126_143_132 and 92_316_700 fitted; named in the log): +262_144, the
    // aerial volume's transmittance half (SI-04); same steps.
    assert_eq!(total(&quality, &at), 126_405_276, "over the 96 MB class budget");
    let fitted = fit(&quality, &at, class_defaults(mobile_mid).budget_bytes, DegradeMode::Boot);
    let step = |rung, from, to| DegradeStep { rung, from, to };
    assert_eq!(
        fitted.steps,
        vec![
            step(DegradeRung::BloomResolution, 360, 180),
            step(DegradeRung::ShadowSize, 1536, 768),
            step(DegradeRung::IblSize, 256, 128),
            step(DegradeRung::IblSize, 128, 64),
            step(DegradeRung::MaterialSize, 512, 256),
        ],
        "transient MSAA saves nothing to drop, AO is already off: bloom, shadows, IBL, materials"
    );
    assert!(fitted.fits);
    assert_eq!(fitted.total_bytes, 92_578_844, "P2-0.13 flipped (was 95_262_540): the output-sized chain, then its rung");
    assert_eq!(fitted.materials, vec![MaterialClass { size_px: 256, layers: 64 }, MaterialClass { size_px: 256, layers: 16 }]);
    assert_eq!(fitted.quality.anti_aliasing, AntiAliasing::Msaa4, "tile MSAA kept");
    assert_eq!(fitted.quality.shadows.cascades, 2, "cascades come last and were not needed");
}

/// P2-0.11 (SI-01) integration: mobile-mid at high (not its class default) without transient MSAA
/// held 99.7% of its 96 MiB budget; the half-side radiance cube passed it by 629_580 bytes and its
/// boot ladder gave up MSAA. A phone caps its radiance cube ([`MOBILE_MAX_RADIANCE_PX`]), so it
/// fits with no step.
#[test]
fn mobile_mid_high_without_transient_msaa_fits_96_mib_without_a_step() {
    let mobile_mid = class("mobile-mid");
    let quality = preset_quality(QualityPreset::High, mobile_mid);
    let at = input(&quality, mobile_mid, (1179, 2556), false);
    let budget = class_defaults(mobile_mid).budget_bytes;
    assert!(total(&quality, &at) <= budget, "{} over {budget}", total(&quality, &at));
    let fitted = fit(&quality, &at, budget, DegradeMode::Boot);
    assert!(fitted.fits);
    assert_eq!(fitted.steps, vec![], "no step");
}

/// Each phone class's radiance cube (the prefilter's source) is at most
/// [`MOBILE_MAX_RADIANCE_PX`] at every preset; a desktop's is half its specular side.
#[test]
fn a_phones_radiance_cube_is_capped_and_a_desktops_is_half_its_specular_side() {
    for class in DeviceClass::ALL {
        for preset in QualityPreset::ALL {
            let quality = preset_quality(preset, class);
            let descs = genex_render::ibl::target_descs(&quality.environment);
            let [specular, radiance, _] = descs.as_slice() else { continue };
            let half = specular.size.0 / 2;
            let expected = if class.form == FormFactor::Mobile { half.min(MOBILE_MAX_RADIANCE_PX) } else { half };
            assert_eq!(radiance.size.0, expected, "{} {}", class.wire(), preset.wire());
        }
    }
}

#[test]
fn mobile_high_at_its_reference_fits_160_mb_without_the_msaa_step() {
    let mobile_high = class("mobile-high");
    for preset in QualityPreset::ALL {
        let quality = preset_quality(preset, mobile_high);
        let at = input(&quality, mobile_high, IPHONE_REFERENCE, true);
        let fitted = fit(&quality, &at, 160 * MIB, DegradeMode::Boot);
        assert!(fitted.fits, "{}", preset.wire());
        assert!(fitted.steps.iter().all(|step| step.rung != DegradeRung::Msaa), "{}: {:?}", preset.wire(), fitted.steps);
        assert!(fitted.steps.is_empty(), "{}: nothing to degrade", preset.wire());
    }
}

#[test]
fn boot_degrades_drop_msaa_first_when_it_saves_memory() {
    let desktop_low = class("desktop-low");
    let quality = preset_quality(QualityPreset::Medium, desktop_low);
    let at = input(&quality, desktop_low, DESKTOP_REFERENCE, false);
    // RQ3.3 flips these two totals (named in the log): the low tier draws Depth16 cascades, so the
    // 2 x 1536 px maps cost 9_437_184 bytes less than the Depth32 totals 183_415_820 / 98_186_252.
    // RQ2 review: + 934_656 bytes, the bake's own IBL rows (two sets, six levels). RQ4 review:
    // + 2_216_052 bytes, medium's AO as the pool allocates it (view-depth chain, render-size term).
    // R2 review: - 3_550_792 bytes, no Hi-Z pyramid now that occlusion defaults off (it was
    // 177_129_344, and 91_899_776 after the MSAA rung).
    // RQ5.6 flipped (was 173_578_552 and 88_348_984 after the MSAA rung): + 10_653_696 bytes,
    // FSR1's intermediate at render size (2176 x 1224 rgb10a2unorm at scale 0.85).
    // Pass-1 fix gate (visual RED 01) flipped (was 184_232_248): + 665_856 bytes, medium's raw AO
    // term in `rg8unorm` with its weight (1088 x 612); after the MSAA rung too (was 99_002_680).
    // P2-0.11 flipped (was 184_898_104 and 99_668_536; named in the log): + 143_376 bytes, the
    // shared 64 px radiance cube of medium's 128 px specular cube and the sky's SH9 source.
    // P2-0.13 flipped (was 185_041_480; named in the log): +15_022_112 bytes, the bloom chain sized
    // from the 1440p output (960 x 540, seven mips) and its 1920 x 1080 pre-level for the render
    // size's (1088 x 612, five).
    // Pass 2 A.5 flipped (was 200_063_592 and 114_834_024; named in the log): +262_144, the aerial
    // volume's transmittance half (SI-04).
    assert_eq!(total(&quality, &at), 200_325_736);
    let fitted = fit(&quality, &at, 128 * MIB, DegradeMode::Boot);
    assert_eq!(fitted.steps, vec![DegradeStep { rung: DegradeRung::Msaa, from: 4, to: 1 }]);
    assert_eq!((fitted.total_bytes, fitted.quality.anti_aliasing), (115_096_168, AntiAliasing::Off));
}

#[test]
fn the_ladder_order_is_fixed_and_a_runtime_degrade_skips_the_pipeline_rungs() {
    assert_eq!(
        DegradeRung::ALL,
        [
            DegradeRung::ShadowFormat,
            DegradeRung::Msaa,
            DegradeRung::SunMask,
            DegradeRung::FroxelFog,
            DegradeRung::Ao,
            DegradeRung::BloomResolution,
            DegradeRung::SpotShadows,
            DegradeRung::ShadowSize,
            DegradeRung::IblSize,
            DegradeRung::TaaHistory,
            DegradeRung::MaterialSize,
            DegradeRung::Cascades,
        ]
    );
    let pipeline: Vec<DegradeRung> = DegradeRung::ALL.into_iter().filter(|rung| rung.kind() == KnobKind::Pipeline).collect();
    assert_eq!(pipeline, [DegradeRung::ShadowFormat, DegradeRung::Msaa, DegradeRung::TaaHistory]);
    let desktop_mid = class("desktop-mid");
    let ultra = preset_quality(QualityPreset::Ultra, desktop_mid);
    let at = input(&ultra, desktop_mid, DESKTOP_REFERENCE, false);
    let step = |rung, from, to| DegradeStep { rung, from, to };
    let boot = fit(&ultra, &at, 256 * MIB, DegradeMode::Boot);
    // RQ3 review: 16-bit shadow maps halve the 4 x 4096 maps before any anti-aliasing is given up.
    // RQ4 review: the contact shadows' mask and its render-size upsample (about 4.6 MB at 1440p,
    // no rung of their own) take the frame past 256 MiB after AO is off, so the ladder goes on
    // to bloom's mips and halves the shadow maps (it was 267_233_104 bytes after the AO rungs).
    // R2 review: occlusion defaults off, so no Hi-Z pyramid (4_915_052 bytes at 1440p) is held and
    // the frame fits after the AO rungs (named in the log: it took the bloom and shadow-size rungs
    // to 171_140_208 bytes). RQ6.7 flipped (named in the log): ultra's four shadowed spots are one
    // atlas layer at the cascades' 4096 px side (64 MiB at Depth32, 32 MiB at Depth16), so the
    // ladder again takes bloom's mips and halves the shadow maps (it ended after the AO rungs at
    // 266_926_052 bytes). RQ6 review flipped back (named in the log): a game that never asks for a
    // shadowed spot reserves no spot atlas, so the frame fits after the AO rungs again (it took the
    // bloom and shadow-size rungs to 166_225_156; the R2 review's 266_926_052 counted 4 x 1024 px
    // of spot maps). RQ5 review flipped (named in the log): the TAA history rung comes after the
    // resource rungs, so ultra keeps TAA and the ladder takes bloom's mips and one shadow-size
    // step instead (it was [shadow-format, taa-history, ao, ao] at 258_537_444 bytes, no AA).
    // Pass 2 B.7 flipped (named in the log): ultra's sun-shadow screen mask (28 bytes a pixel,
    // 103_219_200 at 1440p) is given up first among the resource rungs, then the same steps to the
    // same total (it was [shadow-format, ao, ao, bloom-resolution, shadow-size]). Pass 2 A.5
    // flipped (named in the log): ultra's froxel fog (29_491_200 bytes) is given up right after the
    // mask, then the same steps (it was [shadow-format, sun-mask, ao, ao, bloom-resolution,
    // shadow-size]).
    assert_eq!(
        boot.steps,
        vec![
            step(DegradeRung::ShadowFormat, 32, 16),
            step(DegradeRung::SunMask, 1, 0),
            step(DegradeRung::FroxelFog, 64, 0),
            step(DegradeRung::Ao, 2, 1),
            step(DegradeRung::Ao, 1, 0),
            step(DegradeRung::BloomResolution, 540, 270),
            step(DegradeRung::ShadowSize, 4096, 2048),
        ]
    );
    // P2-0.11 flipped (was 249_996_548; named in the log): + 4_075_536 bytes, the shared 256 px
    // radiance cube of the 512 px map cube and the sky's SH9 source; same steps.
    // P2-0.13 flipped (was 254_072_084 after three bloom-mips steps; named in the log): the chain is
    // sized from the 1440p output with its pre-level, and its rung halves the resolution once (540
    // -> 270 rows).
    // Pass 2 A.5 flipped (was 249_808_244; named in the log): +262_144, the aerial volume's
    // transmittance half (SI-04); the froxel fog's volumes are given up.
    assert_eq!(boot.total_bytes, 250_070_388, "ultra's 512 px HDR map cube, two sets (RQ2 review)");
    assert!(boot.quality.anti_aliasing.temporal(), "ultra keeps TAA");
    // At runtime the shadow format and TAA rungs are closed: the resource rungs step after the
    // boot ladder's. RQ5.6 flipped (named in the log): TAA draws one sample, not MSAA 4x, so the
    // frame fits once the shadow maps are halved twice (it stepped every resource rung down to
    // one cascade and stayed over budget at 270_566_532 bytes).
    let runtime = fit(&ultra, &at, 256 * MIB, DegradeMode::Runtime);
    // Pass 2 B.7 flipped (named in the log): the sun-mask rung is a resource rung, so the runtime
    // ladder takes it too (it compared steps[..2] with the boot's [1..3]).
    // Pass 2 A.5 flipped (named in the log): the froxel-fog rung is a resource rung too (it compared
    // steps[..3] with the boot's [1..4]).
    assert_eq!(runtime.steps[..4], boot.steps[1..5], "the boot ladder without its pipeline rungs, then further");
    assert_eq!(
        runtime.steps[4..],
        [
            step(DegradeRung::BloomResolution, 540, 270),
            step(DegradeRung::ShadowSize, 4096, 2048),
            step(DegradeRung::ShadowSize, 2048, 1024),
        ]
    );
    // R2 review: 292_258_800 before, less the Hi-Z pyramid. RQ6.7 flipped (was 287_343_748): the
    // spot atlas layer at the cascades' side, halved with them down to 768 px. RQ6 review flipped
    // (was 272_925_828): no spot atlas for a game without shadowed spots. RQ5.6 flipped (was
    // 270_566_532, over budget): one TAA sample, so the frame fits.
    // P2-0.11 flipped (was 233_219_332; named in the log): + 4_075_536 bytes, as the boot total.
    // P2-0.13 flipped (was 237_294_868 after three bloom-mips steps; named in the log): one bloom
    // resolution step on the output-sized chain.
    // Pass 2 A.5 flipped (was 233_031_028; named in the log): +262_144, as the boot total.
    assert_eq!((runtime.total_bytes, runtime.fits), (233_293_172, true));
    // A game that uses shadowed spots reserves the atlas, and its own rung gives the spots up
    // before the sun's cascades are halved for their memory.
    let spotted = at.clone().with_spot_atlas(true);
    let spots = ledger(&ultra, &spotted).entries().iter().find(|entry| entry.label == "spots").map(|entry| entry.bytes);
    assert_eq!(spots, Some(4096 * 4096 * 4), "one Depth32 atlas layer at the cascades' side");
    let with_spots = fit(&ultra, &spotted, 256 * MIB, DegradeMode::Boot);
    let rungs: Vec<DegradeRung> = with_spots.steps.iter().map(|step| step.rung).collect();
    let spot_rung = rungs.iter().position(|rung| *rung == DegradeRung::SpotShadows).expect("the spot rung is taken");
    assert!(rungs[..spot_rung].iter().all(|rung| *rung != DegradeRung::ShadowSize), "spots go before the cascades shrink: {rungs:?}");
    assert_eq!(with_spots.quality.lights.shadowed_spots, 0);
    assert!(with_spots.fits);
}

#[test]
fn a_runtime_degrade_never_changes_a_pipeline_knob() {
    for class in DeviceClass::ALL {
        for preset in QualityPreset::ALL {
            for transient in [false, true] {
                let quality = preset_quality(preset, class);
                let at = input(&quality, class, DESKTOP_REFERENCE, transient)
                    .with_material(MaterialClass { size_px: 256, layers: 64 })
                    .with_pass("custom", 8 * MIB);
                let fitted = fit(&quality, &at, MIB, DegradeMode::Runtime);
                let at_ = format!("{} {} transient {transient}", class.wire(), preset.wire());
                assert_eq!(fitted.quality.pipeline_key(), quality.pipeline_key(), "{at_}");
                assert!(fitted.steps.iter().all(|step| step.rung.kind() == KnobKind::Resource), "{at_}");
                assert!(!fitted.fits, "{at_}: 1 MB never fits, the frame still runs (degraded, never refused)");
                assert_eq!(fitted.total_bytes, ledger(&fitted.quality, &at.clone().with_materials(fitted.materials.clone())).total());
            }
        }
    }
}

/// The work the owner spends on top of the plan's ceilings for `class` at `preset`: owner decision
/// 2026-10-12 (b) turns EASU + RCAS on below scale 1 on every phone class, so the phone presets
/// whose table row upscales bilinearly (low) spend the upscale's share ([`upscale_work`]) on top of
/// the plan's work ceilings and render-pass budget. Every other class and preset holds them whole,
/// its upscale included (mobile-high's medium upscaled with FSR1 before the decision).
fn owner_upscale(quality: &Quality, at: &BudgetInput, class: DeviceClass, preset: QualityPreset) -> WorkModel {
    if class.form == FormFactor::Mobile && preset == QualityPreset::Low { upscale_work(quality, at) } else { WorkModel::default() }
}

#[test]
fn every_class_default_holds_its_work_model_ceilings_at_nominal_scale() {
    for class in DeviceClass::ALL {
        let quality = preset_quality(class_defaults(class).preset, class);
        let tile = class.form == FormFactor::Mobile;
        let at = input(&quality, class, reference_resolution(class), tile);
        let work = work_model(&quality, &at, tile);
        let upscale = owner_upscale(&quality, &at, class, quality_preset(class));
        let limits = work_limits(class);
        let row = format!("{} at {:?}: {work:?} (owner's upscale {upscale:?}) vs {limits:?}", class.wire(), reference_resolution(class));
        println!("work model {row}");
        assert!(work.offchip_bytes - upscale.offchip_bytes <= limits.offchip_bytes, "{row}");
        assert!(work.fullscreen_passes - upscale.fullscreen_passes <= limits.fullscreen_passes, "{row}");
        assert!(work.taps_per_pixel - upscale.taps_per_pixel <= limits.taps_per_pixel, "{row}");
        let passes = work.render_passes - upscale.render_passes;
        assert!(passes <= render_pass_budget(PresetChoice::Preset(quality_preset(class))), "{row}");
    }
    assert!(work_limits(class("mobile-mid")).offchip_bytes <= 25 * 1_000_000, "mobile-mid: <= 25 MB per frame");
}

/// Owner decision 2026-10-12 (b): EASU + RCAS on a phone below scale 1 is two full-screen passes
/// (EASU, RCAS) with their 17 taps over the bilinear upscale fused into the tonemap, and their
/// off-chip traffic: the render-size intermediate written and read, the output-size EASU image
/// written and read. At scale 1, or with the bilinear upscaler, it adds nothing.
#[test]
fn the_phone_upscale_share_is_easu_and_rcas_over_the_fused_bilinear_upscale() {
    let mid = class("mobile-mid");
    let quality = preset_quality(QualityPreset::Low, mid);
    let output = reference_resolution(mid);
    let at = input(&quality, mid, output, true);
    let (rw, rh) = at.render_size();
    let share = upscale_work(&quality, &at);
    let texels = |w: u32, h: u32| u64::from(w) * u64::from(h);
    assert_eq!(share.offchip_bytes, 2 * 4 * texels(rw, rh) + 2 * 4 * texels(output.0, output.1));
    assert_eq!((share.fullscreen_passes, share.render_passes, share.taps_per_pixel), (2, 2, 17.0));
    let mut bilinear = quality;
    bilinear.upscaler = Upscaler::Bilinear;
    assert_eq!(upscale_work(&bilinear, &at), WorkModel::default(), "the bilinear upscale is fused into the tonemap");
    assert_eq!(work_model(&quality, &at, true).offchip_bytes - work_model(&bilinear, &at, true).offchip_bytes, share.offchip_bytes);
    let mut at_one = quality;
    at_one.render_scale = 1.0;
    assert_eq!(upscale_work(&at_one, &input(&at_one, mid, output, true)), WorkModel::default(), "no EASU at scale 1");
}

fn quality_preset(class: DeviceClass) -> QualityPreset {
    class_defaults(class).preset
}

#[test]
fn the_render_pass_count_of_off_is_todays_and_low_adds_one_full_screen_pass() {
    let legacy = BudgetInput::new((1920, 1080), 1.0, SceneFormat::Ldr, false);
    assert_eq!(work_model(&Quality::off(), &legacy, false).render_passes, OFF_RENDER_PASSES);
    assert_eq!(render_pass_budget(PresetChoice::Off), OFF_RENDER_PASSES);
    // Pass-1 gate findings 01 and 02 flip low's budget (named in the log; was OFF + 1): low draws
    // off's two cascades (it drew one) plus the exposure compute and its one full-screen pass.
    assert_eq!(render_pass_budget(PresetChoice::Preset(QualityPreset::Low)), OFF_RENDER_PASSES + 2);
    for class in DeviceClass::ALL {
        for preset in QualityPreset::ALL {
            let quality = preset_quality(preset, class);
            let at = input(&quality, class, reference_resolution(class), class.form == FormFactor::Mobile);
            let upscale = owner_upscale(&quality, &at, class, preset).render_passes;
            let passes = work_model(&quality, &at, class.form == FormFactor::Mobile).render_passes - upscale;
            assert!(passes <= render_pass_budget(PresetChoice::Preset(preset)), "{} {}: {passes} passes", class.wire(), preset.wire());
        }
    }
}

#[test]
fn turning_features_off_never_costs_more() {
    let desktop = class("desktop-high");
    let quality = preset_quality(QualityPreset::Ultra, desktop);
    let at = input(&quality, desktop, DESKTOP_REFERENCE, false);
    let full = total(&quality, &at);
    // TAA's switch is not an on/off cost: turning it off returns to MSAA 4x (settings.rs).
    for feature in RenderFeature::ALL.into_iter().filter(|feature| *feature != RenderFeature::Taa) {
        let mut less = quality;
        less.set_feature(feature, false);
        assert!(total(&less, &at) <= full, "{} off", feature.wire());
        assert!(work_model(&less, &at, false).offchip_bytes <= work_model(&quality, &at, false).offchip_bytes, "{} off", feature.wire());
    }
}

/// Whether `knob` differs between `a` and `b`.
fn knob_differs(knob: QualityKnob, a: &Quality, b: &Quality) -> bool {
    match knob {
        QualityKnob::Hdr => a.hdr != b.hdr,
        QualityKnob::Tonemap => a.tonemap != b.tonemap,
        QualityKnob::Exposure => a.exposure != b.exposure,
        QualityKnob::ExposureInput => a.exposure_input_divisor != b.exposure_input_divisor,
        QualityKnob::AntiAliasing => a.anti_aliasing != b.anti_aliasing,
        QualityKnob::RenderScale => a.render_scale != b.render_scale,
        QualityKnob::Upscaler => a.upscaler != b.upscaler,
        QualityKnob::Shadows => a.shadows.enabled != b.shadows.enabled,
        QualityKnob::ShadowCascades => a.shadows.cascades != b.shadows.cascades,
        QualityKnob::ShadowMapSize => a.shadows.map_size != b.shadows.map_size,
        QualityKnob::ShadowFilter => a.shadows.filter != b.shadows.filter,
        QualityKnob::ShadowFormat => a.shadows.format != b.shadows.format,
        QualityKnob::ShadowCadence => a.shadows.far_cadence != b.shadows.far_cadence,
        QualityKnob::ShadowDistance => a.shadows.distance != b.shadows.distance,
        QualityKnob::ShadowSplit => a.shadows.split_percent != b.shadows.split_percent,
        QualityKnob::ShadowBlend => a.shadows.blend_percent != b.shadows.blend_percent,
        QualityKnob::ShadowFade => a.shadows.fade_percent != b.shadows.fade_percent,
        QualityKnob::ContactShadows => a.contact_shadows != b.contact_shadows,
        QualityKnob::Bloom => a.bloom.enabled != b.bloom.enabled,
        QualityKnob::BloomResolution => a.bloom.resolution != b.bloom.resolution,
        QualityKnob::AoResolution => a.ao.resolution != b.ao.resolution,
        QualityKnob::AoSlices => a.ao.slices != b.ao.slices,
        QualityKnob::AoSteps => a.ao.steps != b.ao.steps,
        QualityKnob::AoTemporal => a.ao.temporal != b.ao.temporal,
        QualityKnob::Fog => a.fog != b.fog,
        QualityKnob::Ibl => a.environment.ibl != b.environment.ibl,
        QualityKnob::IblCubeSize => a.environment.cube_size != b.environment.cube_size,
        QualityKnob::IblHdriCubeSize => a.environment.hdri_cube_size != b.environment.hdri_cube_size,
        QualityKnob::IblRebakeCadence => a.environment.rebake_cadence != b.environment.rebake_cadence,
        QualityKnob::IblSunRebake => a.environment.sun_rebake_tenths != b.environment.sun_rebake_tenths,
        QualityKnob::Sky => a.environment.sky != b.environment.sky,
        QualityKnob::SkyLut => a.environment.sky_lut != b.environment.sky_lut,
        QualityKnob::SkyCadence => a.environment.sky_cadence != b.environment.sky_cadence,
        QualityKnob::AerialPerspective => a.environment.aerial_perspective != b.environment.aerial_perspective,
        QualityKnob::LightCap => a.lights.cap != b.lights.cap,
        QualityKnob::Clustered => a.lights.clustered != b.lights.clustered,
        QualityKnob::LightTile => a.lights.tile_px != b.lights.tile_px,
        QualityKnob::ShadowedSpots => a.lights.shadowed_spots != b.lights.shadowed_spots,
        QualityKnob::Prepass => a.prepass != b.prepass,
        QualityKnob::Meshlets => a.meshlets != b.meshlets,
        QualityKnob::Occlusion => a.occlusion != b.occlusion,
        QualityKnob::SpecularAa => a.specular_aa != b.specular_aa,
        _ => panic!("{knob:?} needs a row here"),
    }
}

/// The `degraded` subjects that account for `knob` when it is not drawn: the knob's own subject
/// and the feature switch it belongs to. Empty for the knobs this build draws.
fn accounted_by(knob: QualityKnob) -> &'static [&'static str] {
    match knob {
        // RQ1 draws the HDR scene, the tonemap and auto exposure (its input downsample included).
        QualityKnob::RenderScale | QualityKnob::Shadows | QualityKnob::Hdr | QualityKnob::Tonemap => &[],
        QualityKnob::Exposure | QualityKnob::ExposureInput => &[],
        // RQ5.6 flipped (were `&["taa"]` and `&["upscaler"]`): TAA resolves the one-sample scene
        // and FSR1's EASU and RCAS upscale and sharpen it.
        QualityKnob::AntiAliasing | QualityKnob::Upscaler => &[],
        // RQ3 draws every shadow knob: 1-4 cascades, the map size, the filter, Depth16 and the far
        // cascades' cadence.
        QualityKnob::ShadowCascades | QualityKnob::ShadowMapSize | QualityKnob::ShadowFilter => &[],
        QualityKnob::ShadowFormat | QualityKnob::ShadowCadence => &[],
        // The RQ3 review draws each preset's shadow distance, split, cascade blend band and end fade.
        QualityKnob::ShadowDistance | QualityKnob::ShadowSplit | QualityKnob::ShadowBlend | QualityKnob::ShadowFade => &[],
        // RQ4.6 draws contact shadows, bloom (its chain's resolution), AO (resolution,
        // slices, steps, history) and fog.
        QualityKnob::ContactShadows => &[],
        QualityKnob::Bloom | QualityKnob::BloomResolution => &[],
        QualityKnob::AoResolution | QualityKnob::AoSlices | QualityKnob::AoSteps | QualityKnob::AoTemporal => &[],
        QualityKnob::Fog => &[],
        // RQ2 draws IBL (the cube sizes size the bake, the cadence and the sun's threshold pace its
        // rebakes) and the sky (its LUT size and cadence).
        QualityKnob::Ibl | QualityKnob::IblCubeSize | QualityKnob::IblHdriCubeSize => &[],
        QualityKnob::IblRebakeCadence | QualityKnob::IblSunRebake => &[],
        QualityKnob::Sky | QualityKnob::SkyLut | QualityKnob::SkyCadence => &[],
        // Aerial perspective is the fog's: the sky's volume, applied by the forward pass (RQ4.6).
        QualityKnob::AerialPerspective => &[],
        // RQ6.7 flipped (was `&["clustered"]`): graph node 4 bins the lights on the GPU, the forward
        // pass shades the bins and the shadowed spots draw.
        QualityKnob::LightCap | QualityKnob::Clustered | QualityKnob::LightTile | QualityKnob::ShadowedSpots => &[],
        // The prepass is recorded since RQ4.1 (it runs only for a landed consumer).
        QualityKnob::Prepass => &[],
        // R2.4 draws meshlets with two-pass Hi-Z occlusion.
        QualityKnob::Meshlets | QualityKnob::Occlusion => &[],
        // RQ2.4 draws geometric specular AA on the HDR scene (the surface chunk's constant).
        QualityKnob::SpecularAa => &[],
        _ => panic!("{knob:?} needs a row here"),
    }
}

#[test]
fn every_knob_a_preset_sets_on_any_class_is_drawn_or_reported_not_landed() {
    let legacy = Quality::off();
    assert_eq!(not_landed(&legacy), Vec::<&str>::new(), "the legacy renderer draws exactly what it asks");
    for class in DeviceClass::ALL {
        for preset in QualityPreset::ALL {
            let asked = preset_quality(preset, class);
            let reported = not_landed(&asked);
            for knob in QualityKnob::ALL.into_iter().filter(|knob| knob_differs(*knob, &asked, &legacy)) {
                let subjects = accounted_by(knob);
                let drawn = subjects.is_empty();
                // A sub-knob of a feature that is off draws nothing either way (AO slices with AO off).
                let owner_off = subjects.iter().all(|subject| RenderFeature::from_wire(subject).is_some_and(|f| !asked.feature(f)));
                assert!(
                    drawn || owner_off || subjects.iter().any(|subject| reported.contains(subject)),
                    "{preset:?} on {}: {knob:?} differs from what is drawn but is not reported (reported {reported:?})",
                    class.wire()
                );
            }
        }
    }
}

#[test]
fn a_preset_reports_only_unlanded_feature_switches_never_a_shadow_knob() {
    // RQ3 draws the shadow row of every preset as asked, so `degraded` names feature switches only.
    for class in DeviceClass::ALL {
        for preset in QualityPreset::ALL {
            let reported = not_landed(&preset_quality(preset, class));
            for subject in &reported {
                assert!(RenderFeature::from_wire(subject).is_some(), "{} {}: {subject} is not a feature switch", class.wire(), preset.wire());
            }
        }
    }
}

#[test]
fn the_hdr_tonemap_exposure_and_shadow_switches_have_landed_and_a_switched_off_feature_is_never_reported() {
    let landed: Vec<RenderFeature> = RenderFeature::ALL.into_iter().filter(|feature| feature_landed(*feature)).collect();
    // RQ2 lands image-based lighting and the physical sky; RQ4.1 the prepass; RQ4.6 contact
    // shadows, bloom, AO and fog; R2.4 meshlets and two-pass occlusion; RQ6.7 (flipped) binned
    // local lights.
    assert_eq!(
        landed,
        vec![
            RenderFeature::Hdr,
            RenderFeature::Tonemap,
            RenderFeature::Exposure,
            RenderFeature::Ibl,
            RenderFeature::Sky,
            RenderFeature::Shadows,
            RenderFeature::ContactShadows,
            RenderFeature::Bloom,
            RenderFeature::Ao,
            RenderFeature::Fog,
            RenderFeature::Taa,
            RenderFeature::Upscaler,
            RenderFeature::Clustered,
            RenderFeature::Meshlets,
            RenderFeature::Occlusion,
            RenderFeature::Prepass,
            RenderFeature::TextureQuality,
            RenderFeature::SpotShadows
        ]
    );
    let mut quality = preset_quality(QualityPreset::Ultra, class("desktop-ultra"));
    for feature in RenderFeature::ALL {
        quality.set_feature(feature, false);
    }
    let reported = not_landed(&quality);
    for feature in RenderFeature::ALL {
        assert!(!reported.contains(&feature.wire()), "{} is off, so nothing is missing", feature.wire());
    }
}

/// The meshlet rows after the R2 review (plan §2.4): the instance path on every class and preset.
/// The measurement (perf `meshlet-paths-*.json`, `R2.6-occlusion-stress.jsonl`) shows meshlets
/// and occlusion slower on typical scenes, and no immediate-mode GPU has shown a gain.
#[test]
fn meshlets_and_occlusion_default_off_on_every_class_and_preset() {
    const { assert!(!genex_render::presets::GEOMETRY_PATH_DEFAULT) };
    for class in DeviceClass::ALL {
        for preset in QualityPreset::ALL {
            let quality = preset_quality(preset, class);
            let at = format!("{} {}", class.wire(), preset.wire());
            assert_eq!((quality.meshlets, quality.occlusion), (false, false), "{at}");
        }
    }
}

#[test]
fn occlusion_culls_meshlet_candidates_so_no_resolved_profile_has_it_without_meshlets() {
    let facts = mac();
    let people = [
        ClassOverride { switches: vec![(RenderFeature::Occlusion, true)], ..ClassOverride::default() },
        ClassOverride { switches: vec![(RenderFeature::Occlusion, true), (RenderFeature::Meshlets, false)], ..ClassOverride::default() },
        ClassOverride { switches: vec![(RenderFeature::Meshlets, false)], ..ClassOverride::default() },
    ];
    for class in DeviceClass::ALL {
        for preset in QualityPreset::ALL {
            let game = RenderOverrides { preset: Some(preset), ..RenderOverrides::default() };
            let at = format!("{} {}", class.wire(), preset.wire());
            for person in std::iter::once(None).chain(people.iter().map(Some)) {
                let quality = profile(&facts, class, &game, person).quality;
                assert!(!quality.occlusion || quality.meshlets, "{at}: occlusion runs only where meshlets do ({person:?})");
            }
        }
    }
}

/// Occlusion's Hi-Z holds the single-sample prepass's depth, so it never runs over a
/// multisampled world pass: until TAA lands (every preset then draws MSAA 4x) the switch resolves
/// off with meshlets on, and the settings never claim it runs.
#[test]
fn a_person_can_turn_meshlets_on_for_a_tile_class_and_occlusion_needs_a_one_sample_world_pass() {
    let facts = DeviceFacts::new(TargetOs::Android, Backend::Vulkan, DeviceType::IntegratedGpu);
    let mobile_high = class("mobile-high");
    let game = RenderOverrides { preset: Some(QualityPreset::High), ..RenderOverrides::default() };
    let default = profile(&facts, mobile_high, &game, None).quality;
    assert!(!default.meshlets && !default.occlusion, "the tile class starts on the instance path");
    let meshlets = ClassOverride { switches: vec![(RenderFeature::Meshlets, true)], ..ClassOverride::default() };
    let on = profile(&facts, mobile_high, &game, Some(&meshlets)).quality;
    assert!(on.meshlets && !on.occlusion, "meshlets on alone: occlusion is its own switch");
    let both = ClassOverride { switches: vec![(RenderFeature::Meshlets, true), (RenderFeature::Occlusion, true)], ..ClassOverride::default() };
    let asked = profile(&facts, mobile_high, &game, Some(&both)).quality;
    assert!(asked.meshlets, "the person has the last word on meshlets");
    let one_sample = genex_render::renderer::landed_samples(asked.anti_aliasing) == 1;
    assert_eq!(asked.occlusion, one_sample, "occlusion runs only over a one-sample world pass");
    assert!(!one_sample || genex_render::post::taa::LANDED, "every preset draws MSAA 4x until TAA lands");
}

/// R2 review: every adapter kind starts on the instance path at every preset (a tile GPU, an
/// immediate-mode GPU, one that does not say, and a desktop browser on an Apple GPU, whose
/// `transient_saves_memory` the web never reports), and a game's class table opts meshlets in on
/// any of them.
#[test]
fn every_adapter_starts_on_the_instance_path_and_a_class_table_opts_meshlets_in() {
    let tile = DeviceFacts { transient_saves_memory: Some(true), ..mac() };
    let immediate = DeviceFacts { transient_saves_memory: Some(false), ..DeviceFacts::new(TargetOs::Windows, Backend::Vulkan, DeviceType::DiscreteGpu) };
    let unknown = mac();
    let apple_browser = DeviceFacts { transient_saves_memory: Some(true), ..DeviceFacts::new(TargetOs::Web, Backend::BrowserWebGpu, DeviceType::Other) };
    let opt_in = ClassOverride { switches: vec![(RenderFeature::Meshlets, true)], ..ClassOverride::default() };
    for facts in [tile, immediate, unknown, apple_browser] {
        for class in DeviceClass::ALL {
            for preset in QualityPreset::ALL {
                let at = format!("{:?} {} {}", facts.os, class.wire(), preset.wire());
                let game = RenderOverrides { preset: Some(preset), ..RenderOverrides::default() };
                let quality = profile(&facts, class, &game, None).quality;
                assert_eq!((quality.meshlets, quality.occlusion), (false, false), "{at}: the instance path");
                let opted = RenderOverrides { classes: vec![(class, opt_in.clone())], ..game };
                assert!(profile(&facts, class, &opted, None).quality.meshlets, "{at}: a class table opts meshlets in");
            }
        }
    }
}

#[test]
fn a_person_still_has_the_last_word_on_a_tile_gpu_and_its_other_defaults_do_not_move() {
    let tile = DeviceFacts { transient_saves_memory: Some(true), ..mac() };
    let high = class("desktop-high");
    let game = RenderOverrides { preset: Some(QualityPreset::High), ..RenderOverrides::default() };
    let both = ClassOverride { switches: vec![(RenderFeature::Meshlets, true), (RenderFeature::Occlusion, true)], ..ClassOverride::default() };
    let asked = profile(&tile, high, &game, Some(&both)).quality;
    assert!(asked.meshlets, "the person has the last word on a tile GPU");
    // Only the geometry switches differ from the class row (occlusion only over one sample).
    let mut widened = profile(&tile, high, &game, None).quality;
    widened.meshlets = true;
    widened.occlusion = genex_render::renderer::landed_samples(widened.anti_aliasing) == 1;
    assert_eq!(asked, widened, "the switches move nothing but meshlets and occlusion");
    assert_eq!(profile(&tile, high, &game, None).quality, profile(&mac(), high, &game, None).quality, "a tile GPU's defaults are any adapter's");
}


// RQ5 review: a TAA ask over a world pass built with MSAA (a phone that booted on medium and was
// switched to high, before the presenter rebuilt it) drew MSAA 4x plus the prepass, GTAO and
// contact shadows: the second geometry pass the mobile caps exist to forbid. And an MSAA ask over
// a one-sample pass drew no anti-aliasing at all.
#[test]
fn an_ask_the_world_pass_was_not_built_for_degrades_to_the_anti_aliasing_it_can_draw() {
    let phone = DeviceClass::new(FormFactor::Mobile, PerformanceTier::High);
    let high = preset_quality(QualityPreset::High, phone);
    assert!(high.anti_aliasing.temporal() && high.prepass, "mobile-high's high resolves TAA with its prepass");
    let drawn = with_world_samples(&high, 4, phone);
    assert_eq!(drawn.anti_aliasing, AntiAliasing::Msaa4);
    assert!(!drawn.prepass && !drawn.contact_shadows && drawn.ao.resolution == AoResolution::Off, "{drawn:?}");
    let desktop = DeviceClass::new(FormFactor::Desktop, PerformanceTier::High);
    let desk = with_world_samples(&preset_quality(QualityPreset::High, desktop), 4, desktop);
    assert_eq!(desk.anti_aliasing, AntiAliasing::Msaa4);
    assert!(desk.prepass, "a desktop keeps its prepass consumers over MSAA");
    let one = with_world_samples(&preset_quality(QualityPreset::Medium, phone), 1, phone);
    assert!(one.anti_aliasing.temporal() && one.prepass, "MSAA asked over one sample resolves TAA, never nothing");
    assert_eq!(with_world_samples(&high, 1, phone), high, "a matching ask is unchanged");
}

// Pass-1 gate: a v1 in-world pass keeps high's frame on the LDR scene, where TAA never draws; the
// frame then had no anti-aliasing at all. On the LDR scene a temporal ask draws MSAA 4x.
#[test]
fn a_temporal_ask_on_the_ldr_scene_draws_msaa_and_any_other_ask_is_unchanged() {
    for wire in ["desktop-high", "desktop-mid", "mobile-high"] {
        let class = class(wire);
        for preset in [QualityPreset::Low, QualityPreset::Medium, QualityPreset::High, QualityPreset::Ultra] {
            let asked = preset_quality(preset, class);
            let drawn = on_ldr_scene(&asked, class);
            if asked.anti_aliasing.temporal() {
                assert_eq!(drawn, with_world_samples(&asked, 4, class), "{wire} {preset:?}: the taa-off variant");
                assert_eq!(drawn.anti_aliasing, AntiAliasing::Msaa4, "{wire} {preset:?}");
            } else {
                assert_eq!(drawn, asked, "{wire} {preset:?}: unchanged");
            }
        }
    }
}

// RQ5 review: in a browser that hides deviceMemory (Safari, Firefox: 128 MB) desktop-high's own
// high at 1080p stepped the TAA history rung right after the shadow format, and on a GPU without
// transient attachments that rung's fallback is no anti-aliasing at all. The resource rungs (AO,
// bloom mips, shadow and IBL size) now come first, and the picture keeps TAA.
#[test]
fn desktop_high_in_a_browser_hiding_device_memory_keeps_taa_at_the_web_reference() {
    let desktop = class("desktop-high");
    let facts = DeviceFacts::new(TargetOs::Web, Backend::BrowserWebGpu, DeviceType::Other);
    let quality = preset_quality(default_preset(desktop, TargetOs::Web), desktop);
    let budget = class_budget_bytes(desktop, &facts);
    assert_eq!(budget, 128 * MIB);
    let fitted = fit(&quality, &input(&quality, desktop, WEB_REFERENCE, false), budget, DegradeMode::Boot);
    assert!(fitted.fits, "{:?}", fitted.steps);
    assert!(fitted.quality.anti_aliasing.temporal(), "TAA kept: {:?}", fitted.steps);
    assert!(fitted.steps.iter().all(|step| step.rung != DegradeRung::TaaHistory), "{:?}", fitted.steps);
}

// RQ5 review: the facade re-exported TAA's knobs, but no typed setting reached them. A class
// override's `taa` sets them while TAA runs.
#[test]
fn a_class_override_sets_taas_knobs_on_its_class() {
    use genex_render::settings::{JitterCycle, TaaQuality};
    let desktop = class("desktop-high");
    let facts = DeviceFacts::new(TargetOs::MacOs, Backend::Metal, DeviceType::IntegratedGpu);
    let sixteen = TaaQuality::DEFAULT.with_jitter_cycle(JitterCycle::Sixteen).with_alpha_min(0.05);
    let table = ClassOverride { taa: Some(sixteen), ..ClassOverride::default() };
    let game = RenderOverrides { classes: vec![(desktop, table)], ..RenderOverrides::default() };
    let tuned = profile(&facts, desktop, &game, None);
    assert_eq!(tuned.quality.taa, sixteen);
    assert_eq!(profile(&facts, desktop, &RenderOverrides::default(), None).quality.taa.jitter_cycle, JitterCycle::Eight, "high's own cycle");
    let other = profile(&facts, class("desktop-mid"), &game, None);
    assert_eq!(other.quality.taa, TaaQuality::DEFAULT, "only that class");
}

/// Renderer pass 2, P2-0.9 step B (F1/RC-03): a Live frame's window present holds a staged image
/// at the letterbox's size (the HUD is painted over it) and, when the class's cap keeps the
/// output below the letterbox, EASU's image too; the ledger counts both. A capture (no window)
/// counts neither.
#[test]
fn the_ledger_counts_the_window_present_s_images_at_the_letterbox_size() {
    let ultra = class("desktop-ultra");
    let quality = preset_quality(QualityPreset::Ultra, ultra);
    let base = input(&quality, ultra, DESKTOP_REFERENCE, false);
    let capture = total(&quality, &base);
    let native = total(&quality, &base.clone().with_window(Some(DESKTOP_REFERENCE)));
    assert_eq!(native - capture, 2560 * 1440 * 4, "the staged image at the output's own size");
    let upscaled = total(&quality, &base.with_window(Some((3840, 2160))));
    assert_eq!(upscaled - capture, 3840 * 2160 * 4 * 2, "the staged image and EASU's at 4K");
}

/// The 4K/1440p plan's ledger rows (acceptance of P2-0.9): ultra drawn at 3840x2160 (a 4K
/// capture) fits the Mac's 2 GiB budget without a degrade step, and so does Live on a 4K window
/// (the output capped at the class's 2560x1440 reference, the window present's images at 4K);
/// high at 1440p fits 1 GiB.
#[test]
fn ultra_at_4k_fits_two_gib_and_high_at_1440p_fits_one() {
    const GIB: u64 = 1024 * MIB;
    let ultra = class("desktop-ultra");
    let quality = preset_quality(QualityPreset::Ultra, ultra);
    let at_4k = input(&quality, ultra, (3840, 2160), false).with_environment_map(hdri_map_width(ultra));
    let live_4k = input(&quality, ultra, DESKTOP_REFERENCE, false).with_environment_map(hdri_map_width(ultra)).with_window(Some((3840, 2160)));
    for (row, at) in [("4K capture", &at_4k), ("Live on a 4K window", &live_4k)] {
        let bytes = total(&quality, at);
        eprintln!("ROW ultra {row}: {} MiB of {} MiB", bytes / MIB, 2 * GIB / MIB);
        assert!(bytes <= 2 * GIB, "ultra {row}: {bytes} over 2 GiB");
        let fitted = fit(&quality, at, 2 * GIB, DegradeMode::Boot);
        assert!(fitted.steps.is_empty(), "ultra {row} steps down: {:?}", fitted.steps);
    }
    let high = class("desktop-high");
    let quality = preset_quality(QualityPreset::High, high);
    let at_1440p = input(&quality, high, (2560, 1440), false).with_environment_map(hdri_map_width(high)).with_window(Some((2560, 1440)));
    let bytes = total(&quality, &at_1440p);
    eprintln!("ROW high 1440p: {} MiB of {} MiB", bytes / MIB, GIB / MIB);
    assert!(bytes <= GIB, "high 1440p: {bytes} over 1 GiB");
}
