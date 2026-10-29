//! Render settings end to end (RQ0.7): the precedence of the layers (class default < the game's
//! `[render]` < the person's saved choice < the `renderSettings` verb), class emulation, typed
//! refusals, the per-device save, the settings panel (which never moves the state checksum) and
//! the pinned capture profile.
//!
//! The CPU rows run everywhere. The GPU rows are `#[ignore]`d and every name contains `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex --offline \
//!     --locked --test render_settings -- --ignored metal

use genex::prelude::*;
use genex::render::{
    ClassOverride, DeviceClass, DeviceFacts, FormFactor, PerformanceTier, PresetChoice, QualityPreset, RenderChange, RenderConfig,
    RenderControl, RenderFeature, RenderRefusal, SettingsSource, ShadowConfig, ShadowFilter, ShadowFormat, TargetOs, preset_quality,
};
use genex::{FIXED_STEP_MS, Runtime};
use genex_core::saves::Saves;
use genex_render::device_class::APPLE_VENDOR_ID;

const WORLD: (u32, u32) = (960, 540);
/// Frames over the target that take dynamic resolution to its lowest step and past it.
const DEMOTING_FRAMES: u64 = 2_000;

fn class(wire: &str) -> DeviceClass {
    DeviceClass::from_wire(wire).expect("a known class")
}

/// An Apple-silicon Mac: desktop-high before calibration.
fn mac() -> DeviceFacts {
    DeviceFacts::new(TargetOs::MacOs, wgpu::Backend::Metal, wgpu::DeviceType::IntegratedGpu).with_vendor(APPLE_VENDOR_ID, 0)
}

fn control(config: RenderConfig) -> RenderControl {
    let mut control = RenderControl::new(config, WORLD);
    control.probe(mac(), None);
    control
}

fn preset(change: QualityPreset) -> RenderChange {
    RenderChange { preset: Some(Some(PresetChoice::Preset(change))), ..RenderChange::default() }
}

fn person_preset(preset: QualityPreset) -> ClassOverride {
    ClassOverride { preset: Some(preset), ..ClassOverride::default() }
}

fn on(control: &RenderControl, feature: RenderFeature) -> bool {
    control.answer().features.iter().find(|(known, _)| *known == feature).is_some_and(|(_, on)| *on)
}

// ---------------------------------------------------------------------------------------------
// Precedence (CPU)

#[test]
fn each_layer_overrides_the_one_before_it_class_default_then_toml_then_saved_choice_then_verb() {
    let detected = control(RenderConfig::new());
    assert_eq!(detected.detected_class(), class("desktop-high"));
    assert_eq!(detected.answer().preset, QualityPreset::High, "the class default");
    assert_eq!(detected.answer().requested, PresetChoice::Auto);

    let mut layered = control(RenderConfig::new().preset(QualityPreset::Medium));
    assert_eq!(layered.answer().preset, QualityPreset::Medium, "genex.toml [render] preset beats the class default");
    assert_eq!(layered.answer().requested, PresetChoice::Preset(QualityPreset::Medium));

    let table = ClassOverride { preset: Some(QualityPreset::Low), ..ClassOverride::default() };
    let mut tabled = control(RenderConfig::new().preset(QualityPreset::Medium).class(class("desktop-high"), table));
    assert_eq!(tabled.answer().preset, QualityPreset::Low, "the class's own table beats [render] preset");

    layered.set_person(person_preset(QualityPreset::Ultra));
    assert_eq!(layered.answer().preset, QualityPreset::Ultra, "the person's saved choice beats genex.toml");
    tabled.set_person(person_preset(QualityPreset::Ultra));
    assert_eq!(tabled.answer().preset, QualityPreset::Ultra);

    assert_eq!(layered.apply(&preset(QualityPreset::Low)).preset, QualityPreset::Low, "the verb beats the saved choice");
    let auto = RenderChange { preset: Some(Some(PresetChoice::Auto)), ..RenderChange::default() };
    assert_eq!(layered.apply(&auto).preset, QualityPreset::High, "the verb's auto is the class's own preset");
}

#[test]
fn feature_switches_and_the_render_scale_follow_the_same_order() {
    let table = ClassOverride { render_scale: Some(0.8), switches: vec![(RenderFeature::Shadows, false)], ..ClassOverride::default() };
    let mut control = control(RenderConfig::new().class(class("desktop-high"), table));
    assert!(!on(&control, RenderFeature::Shadows), "genex.toml switches shadows off");
    assert_eq!(control.live_frame().quality.render_scale, 0.8, "genex.toml's nominal scale");

    let person = ClassOverride { render_scale: Some(0.75), switches: vec![(RenderFeature::Shadows, true)], ..ClassOverride::default() };
    control.set_person(person);
    assert!(on(&control, RenderFeature::Shadows), "the person's switch beats genex.toml");
    assert_eq!(control.live_frame().quality.render_scale, 0.75);
    // Flipped by lane UQ (was 0.75): on a native desktop the render scale is a share of the
    // calibrated Quality mode's 0.6875, so the nominal step is 0.52: the floor step beside it.
    assert_eq!(control.upscale_scale(), 0.6875);
    assert_eq!(control.live_frame().scale, genex_render::settings::RENDER_SCALE_MIN, "dynamic resolution starts at the nominal step");

    let off = RenderChange { features: vec![(RenderFeature::Shadows, false)], ..RenderChange::default() };
    assert!(!control.apply(&off).features.contains(&(RenderFeature::Shadows, true)), "the verb's switch beats the person's");
    let lock = RenderChange { render_scale_lock: Some(Some(0.5)), ..RenderChange::default() };
    let answer = control.apply(&lock);
    assert_eq!((answer.render_scale_lock, answer.scale), (Some(0.5), 0.5), "the verb's lock holds the scale");
}

#[test]
fn renderer_settings_set_low_then_get_answers_low_and_volatile_render_names_low() {
    let game = Game::new(Spin::default()).world_size(WORLD.0, WORLD.1);
    let runtime = Runtime::new(game).expect("installs");
    let handle = runtime.render();
    handle.borrow_mut().probe(mac(), None);
    let set = handle.borrow_mut().apply(&preset(QualityPreset::Low));
    assert_eq!(set.preset, QualityPreset::Low);
    assert_eq!(handle.borrow().answer().preset, QualityPreset::Low, "a get after the set");
    assert_eq!(handle.borrow().status().preset, QualityPreset::Low, "volatile.render.preset");
}

#[test]
fn emulating_mobile_mid_on_a_mac_selects_the_mobile_mid_defaults() {
    let mut control = control(RenderConfig::new());
    let emulate = RenderChange { device_class: Some(Some(class("mobile-mid"))), ..RenderChange::default() };
    let answer = control.apply(&emulate);
    assert_eq!(answer.device_class, class("mobile-mid"));
    assert_eq!(answer.detected_class, class("desktop-high"), "the probe's class is still reported");
    assert_eq!(answer.preset, QualityPreset::Low, "mobile-mid's default preset");
    let mobile = DeviceClass::new(FormFactor::Mobile, PerformanceTier::Mid);
    assert_eq!(control.live_frame().quality, preset_quality(QualityPreset::Low, mobile), "the class's capped low preset");
    assert!(answer.scale < 0.7, "mobile-mid's nominal scale, not the Mac's ({})", answer.scale);
    let profile = control.live_profile();
    assert_eq!((profile.target_fps, profile.sustained_fps), (60, Some(30)));
    let back = RenderChange { device_class: Some(None), ..RenderChange::default() };
    assert_eq!(control.apply(&back).device_class, class("desktop-high"), "null gives the probed class back");
}

// RQ6 review: the material arrays were fixed by whichever frame drew the first texture (Live at
// the person's preset, an emulated class, or the capture profile), so a capture's textures
// depended on what came before it, and the budget reserved arrays for the quality in force rather
// than the ones allocated. They are the session's now: the detected class and the game's layer.
#[test]
fn the_session_texture_arrays_hold_whatever_the_person_the_verb_or_a_capture_asks() {
    let mut control = control(RenderConfig::new());
    let session = control.texture_arrays();
    assert_eq!(session.0, class("desktop-high"), "the detected class");
    // WP-9: a native desktop's own preset widens to the 4096 class with its share of the budget.
    let high = class("desktop-high");
    let budget = genex_render::presets::class_budget_bytes(high, &mac());
    let native = genex_render::texture::native_textures(preset_quality(QualityPreset::High, high).textures, high, TargetOs::MacOs, budget, None);
    assert_eq!(session.1, native, "the class's own preset, at the native desktop's class and budget share");
    assert_eq!(control.live_frame().quality.textures, session.1, "Live reports the arrays it draws from");
    control.set_person(person_preset(QualityPreset::Low));
    assert_eq!(control.texture_arrays(), session, "the person's preset keeps them");
    assert_eq!(control.live_frame().quality.textures, session.1, "and Live still reports (and the budget counts) the arrays held");
    control.apply(&RenderChange { device_class: Some(Some(class("mobile-mid"))), ..preset(QualityPreset::Ultra) });
    assert_eq!(control.texture_arrays(), session, "an emulated class keeps them");
    let toml = RenderConfig::from_toml("[render.class.desktop-high]\ntexture-quality = false\n").expect("a fragment");
    let mut off = RenderControl::new(toml, WORLD);
    off.probe(mac(), None);
    assert_eq!(off.texture_arrays().1, genex_render::settings::TextureQuality::OFF, "the game's genex.toml can turn texture quality off");
}

/// Pass-1 gate: ultra on the web reported `{reason: budget, subject: null}` and silently turned AO
/// off. Each rung the memory budget stepped down is named.
#[test]
fn a_budget_degrade_names_each_rung_it_stepped_down() {
    use genex::render::DegradeReason;
    let mut control = control(RenderConfig::new());
    control.apply(&RenderChange { device_class: Some(Some(class("mobile-low"))), ..preset(QualityPreset::Ultra) });
    let budget: Vec<_> = control.status().degraded.into_iter().filter(|degrade| degrade.reason == DegradeReason::Budget).collect();
    assert!(!budget.is_empty(), "ultra on the weakest phone class is over its memory budget");
    let rungs: Vec<&str> = genex_render::budget::DegradeRung::ALL.iter().map(|rung| rung.wire()).collect();
    for degrade in &budget {
        let subject = degrade.subject.as_deref().expect("a budget degrade names what it dropped");
        assert!(rungs.contains(&subject), "{subject} is a rung of the degrade ladder");
    }
    let mut subjects: Vec<_> = budget.iter().filter_map(|degrade| degrade.subject.clone()).collect();
    let named = subjects.len();
    subjects.dedup();
    assert_eq!(subjects.len(), named, "each rung once, in the ladder's order");
}

#[test]
fn an_unknown_preset_class_or_feature_is_refused_typed() {
    let refused = |preset: Option<&str>, device: Option<Option<&str>>, features: &[(&str, bool)]| {
        RenderChange::from_spellings(preset.map(Some), device, features, None).expect_err("refused")
    };
    assert_eq!(refused(Some("epic"), None, &[]), RenderRefusal::UnknownPreset);
    assert_eq!(refused(Some("epic"), None, &[]).wire(), "unknown-preset");
    assert_eq!(refused(None, Some(Some("desktop-mega")), &[]), RenderRefusal::UnknownDeviceClass);
    assert_eq!(refused(None, None, &[("raytracing", true)]), RenderRefusal::UnknownFeature);
    let auto = RenderChange::from_spellings(Some(Some("auto")), Some(None), &[("bloom", false)], Some(Some(0.75))).expect("known");
    assert_eq!(auto.preset, Some(Some(PresetChoice::Auto)));
    let clear = RenderChange::from_spellings(Some(None), None, &[], None).expect("a clear");
    assert_eq!(clear.preset, Some(None));
    assert_eq!(auto.device_class, Some(None));
    assert_eq!(auto.render_scale_lock, Some(Some(0.75)));
}

// ---------------------------------------------------------------------------------------------
// The look: tonemapper and exposure (CPU)

#[test]
fn tonemap_and_exposure_round_trip_through_render_settings_and_the_toml_look() {
    use genex::render::{Exposure, ExposureMode, Metering, Tonemap};
    let exposure = Exposure::auto().compensation(0.5).range(-4.0, 6.0).adaptation(2.0, 1.5).metering(Metering::Center);
    let mut game = Game::new(Spin::default()).world_size(WORLD.0, WORLD.1);
    game.render_settings(RenderConfig::new().tonemap(Tonemap::Agx).exposure(exposure));
    let runtime = Runtime::new(game).expect("installs");
    let handle = runtime.render();
    handle.borrow_mut().probe(mac(), None);
    let look = handle.borrow().look();
    assert_eq!(look.tonemapper, Tonemap::Agx);
    assert_eq!(look.exposure, ExposureMode::Auto);
    assert_eq!(Exposure::of(&look), exposure, "every exposure key comes back as it was set");
    assert_eq!(handle.borrow().live_frame().look, look, "Live frames draw with the game's look");
    assert_eq!(handle.borrow().capture_frame().0.look, look, "and so do captures, on every preset");

    let toml = "[render.look]\ntonemapper = \"agx\"\nexposure = \"auto\"\nmetering = \"center\"\nev_compensation = 0.5\n\
                ev_min = -4\nev_max = 6\nadaptation_speed_up = 2\nadaptation_speed_down = 1.5\n";
    let from_toml = RenderConfig::from_toml(toml).expect("a [render.look] fragment");
    assert_eq!(from_toml.look, look, "genex.toml's [render.look] is the same look as the facade's");

    let manual = Exposure::manual(-1.5);
    let config = RenderConfig::new().tonemap(Tonemap::Aces).exposure(manual);
    assert_eq!(Exposure::of(&config.look), manual);
    assert!((config.look.manual_exposure() - std::f32::consts::FRAC_1_SQRT_2 / 2.0).abs() < 1e-6, "manual EV is relative: EV -1.5 is 2^-1.5");
    let wild = Exposure::manual(40.0).range(30.0, -30.0).adaptation(0.0, f32::NAN);
    let tamed = Exposure::of(&RenderConfig::new().exposure(wild).look);
    assert_eq!(tamed.ev_compensation, 10.0, "compensation stays within genex.toml's ±10 EV");
    assert!((-16.0..=16.0).contains(&tamed.ev_min) && tamed.ev_min <= tamed.ev_max, "{tamed:?}");
    assert!(tamed.adaptation_up > 0.0 && tamed.adaptation_down > 0.0 && tamed.adaptation_down.is_finite(), "{tamed:?}");
}

#[test]
fn a_look_takes_a_temperature_and_an_exposure_curve_that_an_exposure_keeps() {
    use genex::render::{Exposure, Look, Metering};
    let config = RenderConfig::new().exposure(Exposure::auto().metering(Metering::Ground)).temperature(0.4, -0.1).exposure_curve(&[(0.0, 0.0), (-4.0, -2.0)]);
    let look = config.look;
    assert_eq!((look.temperature, look.tint, look.metering), (0.4, -0.1, Metering::Ground));
    assert_eq!((look.compensation_curve.at(-2.0), look.compensation_curve.at(5.0)), (-1.0, 0.0), "linear between the points, flat beyond");
    assert_ne!(look.white_balance_matrix(), Look::default().white_balance_matrix(), "the temperature reaches the tonemap's matrix");
    let wild = RenderConfig::new().temperature(9.0, f32::NAN).exposure_curve(&[(f32::NAN, 1.0)]).look;
    assert_eq!((wild.temperature, wild.tint), (1.0, 0.0), "held to -1..=1; not a number is 0");
    assert!(wild.compensation_curve.is_empty(), "a point that is not a number is left out");
    let later = RenderConfig::new().exposure_curve(&[(-4.0, -2.0)]).temperature(-0.5, 0.0).exposure(Exposure::auto().compensation(0.5)).look;
    assert_eq!((later.compensation_curve.points().len(), later.temperature), (1, -0.5), "an exposure set afterwards keeps both");
    let from_toml = RenderConfig::from_toml("[render.look]\nexposure = \"auto\"\nmetering = \"ground\"\n").expect("a [render.look] fragment");
    assert_eq!(from_toml.look.metering, Metering::Ground, "genex.toml spells the sky-aware metering `ground`");
}

#[test]
fn a_look_takes_a_grading_held_to_its_ranges_and_a_cube_lut() {
    use genex::render::{Grading, GradingLut, GradingSection, Look};
    let cube = "LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n";
    let lut = GradingLut::parse_cube(cube).expect("a .cube").intern().expect("interned");
    let warm = Grading { shadows: GradingSection { gain: 1.1, ..GradingSection::NEUTRAL }, ..Grading::NEUTRAL };
    let look = RenderConfig::new().grading(warm.with_contrast(1.2).with_lut(lut, 0.5)).look;
    assert_eq!((look.grading.contrast, look.grading.shadows.gain, look.grading.lut_intensity), (1.2, 1.1, 0.5));
    assert!(look.grading.lut.is_some_and(|held| std::ptr::eq(held, lut)), "the look holds the interned LUT");
    let wild = RenderConfig::new().grading(Grading { contrast: f32::NAN, saturation: 9.0, ..Grading::NEUTRAL }).look.grading;
    assert_eq!((wild.contrast, wild.saturation), (1.0, 2.0), "held to 0..=2; not a number is neutral");
    assert_eq!(RenderConfig::new().look.grading, Look::default().grading, "the default config grades nothing");
}

#[test]
fn a_look_takes_depth_of_field_and_motion_blur_off_by_default() {
    use genex::render::{CaptureLens, DepthOfField, Look, MotionBlur};
    let look = RenderConfig::new().depth_of_field(DepthOfField::focused(3.0, 2.0)).motion_blur(MotionBlur::shutter(0.5)).look;
    assert_eq!(look.depth_of_field, DepthOfField::focused(3.0, 2.0));
    assert_eq!(look.motion_blur, MotionBlur::shutter(0.5));
    let defaults = RenderConfig::new().look;
    assert!(!defaults.depth_of_field.enabled && !defaults.motion_blur.enabled, "both are off by default (D10 for motion blur)");
    assert_eq!((defaults.depth_of_field, defaults.motion_blur), (Look::default().depth_of_field, Look::default().motion_blur));
    assert_eq!(CaptureLens::default(), CaptureLens { depth_of_field: false, motion_blur: false }, "a capture asks for neither");
}

#[test]
fn the_facade_default_is_hdr_with_the_legacy_preserving_look() {
    use genex::render::{ExposureMode, Look, Tonemap};
    let control = control(RenderConfig::new());
    let live = control.live_frame();
    assert!(live.quality.hdr, "every preset asks for the HDR scene");
    assert!(live.scene_format.is_hdr(), "Live frames draw on the class's HDR scene format");
    let (capture, _) = control.capture_frame();
    assert!(capture.quality.hdr && capture.scene_format.is_hdr(), "captures draw on the HDR scene too");
    assert_eq!(live.look, Look::default());
    assert_eq!((live.look.tonemapper, live.look.exposure), (Tonemap::KhronosNeutral, ExposureMode::Manual));
    assert_eq!(live.look.manual_exposure(), 1.0, "a fixed exposure of 1: in-range colours keep their look");
}

#[test]
fn a_frame_kept_on_the_ldr_scene_names_its_typed_reason_in_degraded() {
    use genex::render::{DegradeReason, LdrReason};
    let mut control = control(RenderConfig::new());
    let ldr = |control: &RenderControl| -> Vec<DegradeReason> {
        control.status().degraded.into_iter().map(|degrade| degrade.reason).filter(|reason| *reason != DegradeReason::NotLanded).collect()
    };
    assert_eq!(ldr(&control), Vec::<DegradeReason>::new(), "nothing keeps a fresh frame on the LDR scene");
    control.note_ldr_reason(Some(LdrReason::CustomPassV1InWorld));
    assert_eq!(ldr(&control), vec![DegradeReason::CustomPassV1InWorld]);
    assert_eq!(DegradeReason::CustomPassV1InWorld.wire(), "custom-pass-v1-in-world");
    control.note_ldr_reason(Some(LdrReason::MaterialV1InHdr));
    assert_eq!(ldr(&control), vec![DegradeReason::MaterialV1InHdr]);
    assert_eq!(DegradeReason::MaterialV1InHdr.wire(), "material-v1-in-hdr");
    control.note_ldr_reason(None);
    assert_eq!(ldr(&control), Vec::<DegradeReason>::new(), "an all-v2 frame draws HDR again");
}

/// The fragments the build lane compiles in for the shared fixture's documented table
/// (`tests/fixtures/genex-toml-render.json`, `fragments`), and the whole file they came from.
fn lane_fragments() -> (String, serde_json::Value) {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../tests/fixtures/genex-toml-render.json");
    let rows: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).expect("the shared fixture")).expect("JSON");
    let whole = format!("{}{}{}", rows["game"].as_str().expect("game"), rows["accepted"][0]["text"].as_str().expect("text"), rows["fragments"]["wgslRows"].as_str().expect("rows"));
    (whole, rows["fragments"].clone())
}

#[test]
fn the_lane_s_render_fragment_is_the_game_s_render_table_on_every_destination() {
    let (whole, fragments) = lane_fragments();
    let compiled = RenderConfig::from_toml(fragments["render"].as_str().expect("render")).expect("the fragment reads");
    assert_eq!(compiled, RenderConfig::from_toml(&whole).expect("the whole file reads"), "the fragment means what genex.toml says");
    let mut control = control(compiled);
    control.apply(&RenderChange { device_class: Some(Some(class("mobile-mid"))), ..RenderChange::default() });
    assert_eq!(control.live_frame().quality.render_scale, 0.67, "[render.class.mobile-mid] render_scale reaches the frame");
    assert_eq!(control.answer().preset, QualityPreset::Low);
    assert_eq!(control.live_profile().target_fps, 30);
    let rows = |text: &str| genex::manifest::parse(text).expect("parses").wgsl;
    let game = "[game]\ntitle = \"wgsl\"\n";
    let wgsl = fragments["wgsl"].as_str().expect("wgsl");
    assert_eq!(rows(&format!("{game}{wgsl}")), rows(&whole), "the [[wgsl]] fragment declares the same rows");
}

#[test]
fn a_null_preset_and_feature_table_give_the_game_s_own_settings_back_after_a_judge_s_changes() {
    let mut control = control(RenderConfig::new().preset(QualityPreset::Medium));
    let judged = RenderChange { features: vec![(RenderFeature::Shadows, false)], ..preset(QualityPreset::Low) };
    assert_eq!(control.apply(&judged).preset, QualityPreset::Low);
    assert_eq!(control.capture_frame().1.source, SettingsSource::Verb);
    let restore = RenderChange { preset: Some(None), device_class: Some(None), reset_features: true, ..RenderChange::default() };
    let answer = control.apply(&restore);
    assert_eq!(answer.requested, PresetChoice::Preset(QualityPreset::Medium), "the game's [render] preset is asked again");
    assert_eq!(answer.preset, QualityPreset::Medium);
    assert!(on(&control, RenderFeature::Shadows), "the verb's switches are given back");
    assert_eq!(control.capture_frame().1.source, SettingsSource::Toml, "captures come from genex.toml again");
    let auto = RenderChange { preset: Some(Some(PresetChoice::Auto)), ..RenderChange::default() };
    assert_eq!(control.apply(&auto).preset, QualityPreset::High, "auto, by contrast, is the class's preset over the game's");
}

// ---------------------------------------------------------------------------------------------
// Captures: the pinned profile (CPU)

#[test]
fn a_capture_ignores_the_saved_choice_the_calibration_hint_and_dynamic_resolution() {
    let mut control = control(RenderConfig::new());
    let (pinned, provenance) = control.capture_frame();
    assert_eq!(provenance.device_class, class("desktop-high"));
    assert_eq!(provenance.source, SettingsSource::ReferenceClass);
    assert_eq!((provenance.scale, provenance.settle_frames, provenance.history_reset), (1.0, 1, true));

    control.set_person(ClassOverride { preset: Some(QualityPreset::Low), render_scale: Some(0.5), ..ClassOverride::default() });
    control.probe(mac(), Some(genex::render::ScoreLevel::new(10)));
    assert_ne!(control.live_frame(), pinned, "Live follows the person and the calibration hint");
    assert_eq!(control.capture_frame().0, pinned, "the capture does not");

    let mut toml = RenderControl::new(RenderConfig::new().preset(QualityPreset::Medium), WORLD);
    toml.probe(mac(), None);
    assert_eq!(toml.capture_frame().1.source, SettingsSource::Toml);
    assert_eq!(toml.capture_frame().1.preset, QualityPreset::Medium);
    let emulate = RenderChange { device_class: Some(Some(class("mobile-mid"))), ..RenderChange::default() };
    toml.apply(&emulate);
    let (phone, provenance) = toml.capture_frame();
    assert_eq!((provenance.device_class, provenance.source), (class("mobile-mid"), SettingsSource::Verb), "captured as a phone");
    assert!(phone.scale < 0.7);
}

#[test]
fn the_reference_class_is_the_hosts_and_never_the_probes() {
    let mut control = RenderControl::new(RenderConfig::new(), WORLD);
    let phone = DeviceFacts::new(TargetOs::Web, wgpu::Backend::BrowserWebGpu, wgpu::DeviceType::Other);
    control.probe(phone, None);
    assert_eq!(control.live_class().form, FormFactor::Mobile, "a page without hints is a phone in Live");
    assert_eq!(control.capture_class(), genex::render::REFERENCE_CLASS, "captures stay comparable with native ones");
    control.set_reference_class(Some(class("desktop-mid")));
    assert_eq!(control.capture_frame().1.device_class, class("desktop-mid"));
}

#[test]
fn a_capture_resolves_the_same_on_a_mac_and_in_any_browser_whatever_the_probe() {
    let web = |memory_gb: u32| {
        let hints = genex::render::web_hints_from_json(&serde_json::json!({ "maxTouchPoints": 0, "deviceMemoryGb": memory_gb }))
            .expect("hints");
        DeviceFacts::new(TargetOs::Web, wgpu::Backend::BrowserWebGpu, wgpu::DeviceType::Other).with_web(hints)
    };
    let mut native = control(RenderConfig::new());
    let mut small = RenderControl::new(RenderConfig::new(), WORLD);
    small.probe(web(2), None);
    let mut fast = RenderControl::new(RenderConfig::new(), WORLD);
    let mut rg11b10 = mac();
    rg11b10.features |= wgpu::Features::RG11B10UFLOAT_RENDERABLE;
    fast.probe(rg11b10, None);
    assert_eq!(small.capture_frame(), native.capture_frame(), "a 2 GB browser captures what the Mac captures");
    assert_eq!(fast.capture_frame(), native.capture_frame(), "an optional scene format does not move a capture");
    let ultra = RenderChange { device_class: Some(Some(class("desktop-ultra"))), ..RenderChange::default() };
    native.apply(&ultra);
    small.apply(&ultra);
    assert_eq!(small.capture_frame(), native.capture_frame(), "an emulated desktop-ultra is ultra in a browser too");
    assert_eq!(small.capture_frame().1.preset, QualityPreset::Ultra);
    assert_eq!(small.live_profile().preset, QualityPreset::High, "Live in the browser keeps the web's default cap");
}

#[test]
fn a_switch_reads_on_only_when_drawn_and_what_is_not_drawn_yet_is_degraded_not_landed() {
    use genex::render::DegradeReason;
    let high = control(RenderConfig::new());
    assert_eq!(high.answer().preset, QualityPreset::High);
    // RQ5.6 flipped (were "not drawn in this build" and listed not-landed): TAA and the FSR1
    // upscaler are drawn, so high reports them on and nothing is left not-landed.
    let drawn = [
        RenderFeature::Shadows,
        RenderFeature::Hdr,
        RenderFeature::Tonemap,
        RenderFeature::Exposure,
        RenderFeature::Bloom,
        RenderFeature::Ao,
        RenderFeature::ContactShadows,
        RenderFeature::Fog,
        RenderFeature::Taa,
        RenderFeature::Upscaler,
    ];
    for feature in drawn {
        assert!(on(&high, feature), "the {} switch is drawn", feature.wire());
        assert!(high.status().features.contains(&(feature, true)), "volatile.render reports {} on", feature.wire());
    }
    let not_landed: Vec<String> = high
        .status()
        .degraded
        .into_iter()
        .filter(|degrade| degrade.reason == DegradeReason::NotLanded)
        .filter_map(|degrade| degrade.subject)
        .collect();
    assert!(not_landed.is_empty(), "every switch high asks for is drawn: {not_landed:?}");
    assert_eq!(DegradeReason::NotLanded.wire(), "not-landed");

    let mut legacy = control(RenderConfig::new());
    let every_off: Vec<(RenderFeature, bool)> = RenderFeature::ALL.iter().map(|feature| (*feature, false)).collect();
    legacy.apply(&RenderChange { features: every_off, ..RenderChange::default() });
    let status = legacy.status();
    for feature in [RenderFeature::Hdr, RenderFeature::Tonemap, RenderFeature::Exposure] {
        assert!(!status.features.contains(&(feature, true)), "a legacy-equivalent frame never reports {} on", feature.wire());
    }
    let legacy_missing: Vec<_> = status.degraded.iter().filter(|degrade| degrade.reason == DegradeReason::NotLanded).collect();
    // RQ2.4 landed specular AA (the HDR scene's surface chunk): a legacy frame misses nothing.
    assert!(legacy_missing.is_empty(), "{legacy_missing:?}");
}

#[test]
fn dynamic_resolution_runs_the_class_table_and_never_rises_past_the_budget() {
    use genex_render::budget::{BudgetInput, ledger};
    use genex_render::presets::{class_defaults, reference_resolution};
    let bucket = |scale: f32| (scale / genex_render::drs::SCALE_QUANTUM).round() * genex_render::drs::SCALE_QUANTUM;
    for class in DeviceClass::ALL {
        let output = reference_resolution(class);
        let mut control = RenderControl::new(RenderConfig::new(), output);
        control.probe(mac(), None);
        control.apply(&RenderChange { device_class: Some(Some(class)), ..RenderChange::default() });
        let steps = control.scale_steps().to_vec();
        // Lane UQ: each step is the table's times the upscaling mode's share (1 on phones).
        let held = |scale: f32| bucket((scale * control.upscale_scale()).max(genex_render::settings::RENDER_SCALE_MIN));
        let table: Vec<f32> = class_defaults(class).drs_steps.iter().map(|scale| held(*scale)).collect();
        assert!(steps.iter().all(|step| table.contains(step)), "{}: {steps:?} come from its table {table:?}", class.wire());
        assert_eq!(steps[0], table[0], "{}: the table's lowest step is the floor", class.wire());
        let quality = control.live_frame().quality;
        let profile = control.live_profile();
        let nominal = held(quality.render_scale);
        for step in steps.iter().filter(|step| **step > nominal) {
            let input = BudgetInput::new(output, *step, profile.scene_format, false);
            let bytes = ledger(&quality, &input).total();
            assert!(bytes <= profile.budget_bytes, "{} at step {step}: {bytes} B over its {} B budget", class.wire(), profile.budget_bytes);
        }
    }
}

// RQ5 review: the shipping controller never counted FSR1's passes, so a drop from scale 1 promised
// the whole frame's pixel ratio while EASU and RCAS started at the output size, and the phone
// classes' steps assumed the upscale they pay every frame scales away.
#[test]
fn dynamic_resolution_counts_the_upscale_its_class_pays_below_scale_one() {
    use genex_render::post::fsr::class_cost_ms;
    let mut control = control(RenderConfig::new());
    let desktop = class_cost_ms(class("desktop-high"), WORLD);
    assert!(desktop > 0.0);
    assert_eq!(control.upscale_ms(), desktop, "high upscales with FSR1 below scale 1");
    emulate(&mut control, "mobile-high", QualityPreset::Medium);
    let phone = class_cost_ms(class("mobile-high"), WORLD);
    assert_eq!(control.upscale_ms(), phone, "the phone's own model");
    assert!(phone > desktop * 2.0, "a phone pays more for the same output: {phone} vs {desktop}");
    emulate(&mut control, "desktop-high", QualityPreset::Low);
    assert_eq!(control.upscale_ms(), 0.0, "a desktop low's bilinear stretch is fused into the tonemap");
    // Owner decision 2026-10-12 (b): phones upscale with EASU + RCAS at low too.
    emulate(&mut control, "mobile-mid", QualityPreset::Low);
    assert_eq!(control.upscale_ms(), class_cost_ms(class("mobile-mid"), WORLD), "a phone's low pays its EASU + RCAS");
}

#[test]
fn thermal_load_holds_mobile_mid_at_its_sustained_rate_until_a_cool_spell() {
    use std::time::Duration;
    let mut control = control(RenderConfig::new());
    control.apply(&RenderChange { device_class: Some(Some(class("mobile-mid"))), ..RenderChange::default() });
    assert_eq!(control.frame_interval(), Duration::from_secs(1) / 60);
    control.set_thermal(true, Duration::from_secs(1));
    assert_eq!(control.frame_interval(), Duration::from_secs(1) / 30, "mobile-mid's sustained 30 fps");
    control.set_thermal(false, Duration::from_secs(2));
    assert_eq!(control.frame_interval(), Duration::from_secs(1) / 30, "not after one cool reading");
    control.set_thermal(false, Duration::from_secs(13));
    assert_eq!(control.frame_interval(), Duration::from_secs(1) / 60, "its own rate after the cool spell");
}

// ---------------------------------------------------------------------------------------------
// Shadows (CPU): the game's cascade request, the class caps, the person's layer

type ShadowRow = (u8, u32, ShadowFilter, ShadowFormat, u8);

/// The conformance suite's `render-presets` temporal case (`game-conformance-render.ts`
/// `checkSwitchesDrawn`) on a real fork build (look measure 2026-10-18: "mobile-high (temporal): ao
/// was switched on, but the drawn frame has it off and degraded does not name it"): each phone
/// class on its own preset with TAA, AO and exposure switched on, after the presenter rebuilt the
/// world pass for what Live asks, reports every switch drawn or names it in `degraded`.
#[test]
fn a_phone_with_the_temporal_switches_on_draws_each_or_names_it_in_degraded() {
    let temporal = [RenderFeature::Taa, RenderFeature::Ao, RenderFeature::Exposure];
    for wire in ["mobile-high", "mobile-mid", "mobile-low"] {
        let mut phone = control(RenderConfig::new());
        let change = RenderChange {
            device_class: Some(Some(class(wire))),
            preset: Some(Some(PresetChoice::Auto)),
            features: temporal.iter().map(|feature| (*feature, true)).collect(),
            ..RenderChange::default()
        };
        phone.apply(&change);
        phone.note_world_samples(genex_render::renderer::landed_samples(phone.live_asked().quality.anti_aliasing));
        let status = phone.status();
        for feature in temporal {
            let drawn = status.features.contains(&(feature, true));
            let named = status.degraded.iter().any(|degrade| degrade.subject.as_deref() == Some(feature.wire()));
            assert!(drawn || named, "{wire} (temporal): {} switched on is neither drawn nor degraded: {status:?}", feature.wire());
        }
    }
}

/// GF round 2 (rust-eject's real fork, `render-presets`): right after the verb switched a phone
/// to TAA, `volatile.render` still carried the last Live frame's findings (nothing deferred), so
/// the check's wait for the change to land returned at once, its captures ran while Live still
/// held the old MSAA pass, and the read after them found AO off. Until a Live frame has drawn a
/// change (or held the last settings while it warms) the change is named deferred.
#[test]
fn a_change_no_live_frame_has_drawn_yet_is_named_deferred() {
    let deferred = |control: &RenderControl| control.status().degraded.iter().any(|degrade| degrade.reason == genex::render::DegradeReason::PipelineChangeDeferred);
    let mut phone = control(RenderConfig::new());
    phone.apply(&RenderChange { device_class: Some(Some(class("mobile-low"))), ..RenderChange::default() });
    phone.note_world_samples(genex_render::renderer::landed_samples(phone.live_asked().quality.anti_aliasing));
    phone.note_frame_findings(Vec::new(), false);
    assert!(!deferred(&phone), "the premise: Live drew mobile-low");
    let change = RenderChange {
        device_class: Some(Some(class("mobile-high"))),
        features: [RenderFeature::Taa, RenderFeature::Ao].map(|feature| (feature, true)).into(),
        ..RenderChange::default()
    };
    phone.apply(&change);
    assert!(deferred(&phone), "no Live frame has drawn the change: {:?}", phone.status());
    phone.note_world_samples(genex_render::renderer::landed_samples(phone.live_asked().quality.anti_aliasing));
    phone.note_frame_findings(Vec::new(), false);
    assert!(!deferred(&phone), "a Live frame drew it");
}

/// GF round 2 (rust-eject's real fork, `render-presets`, red in round 1, round 2 and pass 2):
/// "mobile-high (temporal): ao was switched on, but the drawn frame has it off and degraded does
/// not name it". The CPU row above draws no frame; a real run does, and when its frames are over
/// the class's target dynamic resolution steps the scale down and then demotes the preset, which
/// takes AO off. A switch the demotion turns off is named in `degraded` (`budget`, the switch as
/// its subject), as the budget fit's own rungs are.
#[test]
fn a_switch_dynamic_resolution_demotes_off_is_named_in_degraded() {
    let temporal = [RenderFeature::Taa, RenderFeature::Ao, RenderFeature::Exposure];
    for wire in ["mobile-high", "mobile-mid", "mobile-low"] {
        let mut phone = control(RenderConfig::new());
        let change = RenderChange {
            device_class: Some(Some(class(wire))),
            preset: Some(Some(PresetChoice::Auto)),
            features: temporal.iter().map(|feature| (*feature, true)).collect(),
            ..RenderChange::default()
        };
        phone.apply(&change);
        phone.note_world_samples(genex_render::renderer::landed_samples(phone.live_asked().quality.anti_aliasing));
        let target = phone.gpu_target_ms();
        for frame in 0..DEMOTING_FRAMES {
            phone.observe(Some(1.0), Some(&[target * 3.0]), 16.0, std::time::Duration::from_millis(16 * frame));
        }
        let status = phone.status();
        for feature in temporal {
            let drawn = status.features.contains(&(feature, true));
            let named = status.degraded.iter().any(|degrade| degrade.subject.as_deref() == Some(feature.wire()));
            assert!(drawn || named, "{wire} (temporal, demoted): {} switched on is neither drawn nor degraded: {status:?}", feature.wire());
        }
    }
}


fn shadow_row(control: &RenderControl) -> ShadowRow {
    let shadows = control.live_frame().quality.shadows;
    (shadows.cascades, shadows.map_size, shadows.filter, shadows.format, shadows.far_cadence)
}

fn emulate(control: &mut RenderControl, wire: &str, preset: QualityPreset) {
    let change = RenderChange { device_class: Some(Some(class(wire))), preset: Some(Some(PresetChoice::Preset(preset))), ..RenderChange::default() };
    control.apply(&change);
}

#[test]
fn a_game_asks_for_four_cascades_at_high_and_only_high_on_a_desktop_gets_them() {
    let config = RenderConfig::new().shadows_at(QualityPreset::High, ShadowConfig::new().cascades(4));
    let mut desktop = control(config);
    assert_eq!(shadow_row(&desktop), (4, 2048, ShadowFilter::PcssLite, ShadowFormat::Depth32, 1), "desktop-high is at high: 4 cascades");
    let (capture, _) = desktop.capture_frame();
    assert_eq!(capture.quality.shadows.cascades, 4, "a capture resolves the same game choice");
    desktop.apply(&preset(QualityPreset::Medium));
    assert_eq!(shadow_row(&desktop).0, 2, "medium keeps its two cascades");
    desktop.apply(&preset(QualityPreset::Low));
    // Pass-1 gate findings 01 and 02 flip low's cascades (named in the log): two (was one).
    assert_eq!(shadow_row(&desktop).0, 2, "low keeps its two");
}

#[test]
fn the_same_request_on_a_phone_is_held_to_the_mobile_caps() {
    let mut phone = control(RenderConfig::new().shadows_at(QualityPreset::High, ShadowConfig::new().cascades(4).map_size(4096).filter(ShadowFilter::Pcss)));
    emulate(&mut phone, "mobile-high", QualityPreset::High);
    assert_eq!(shadow_row(&phone), (2, 1536, ShadowFilter::Pcf5x5, ShadowFormat::Depth16, 2), "2 x 1536 Depth16, no PCSS, far cascade every 2nd frame");
    emulate(&mut phone, "mobile-low", QualityPreset::High);
    // Pass-1 gate finding 02 flips the weakest phone's cap (named in the log): two 512 px cascades (was one of 768).
    assert_eq!(shadow_row(&phone), (2, 512, ShadowFilter::Pcf5x5, ShadowFormat::Depth16, 2), "the weakest phone: two 512 px cascades");
    let (capture, _) = phone.capture_frame();
    assert_eq!(capture.quality.shadows.cascades, 2, "a capture as that phone draws what the phone draws");
}

#[test]
fn the_person_and_the_class_table_refine_the_games_shadow_request() {
    let table = ClassOverride { shadows: ShadowConfig::new().filter(ShadowFilter::Pcf5x5), ..ClassOverride::default() };
    let config = RenderConfig::new().shadows_at(QualityPreset::High, ShadowConfig::new().cascades(3)).class(class("desktop-high"), table);
    let mut control = control(config);
    assert_eq!(shadow_row(&control), (3, 2048, ShadowFilter::Pcf5x5, ShadowFormat::Depth32, 1), "the game's cascades, the table's filter");
    control.set_person(ClassOverride { shadows: ShadowConfig::new().cascades(2), ..ClassOverride::default() });
    assert_eq!(shadow_row(&control).0, 2, "the person's key is the last word");
    control.set_person(ClassOverride { switches: vec![(RenderFeature::Shadows, false)], ..ClassOverride::default() });
    assert!(!on(&control, RenderFeature::Shadows), "the shadows switch is separate from the shadow choices");
}

#[test]
fn genex_toml_and_the_facade_set_the_shadow_distance_and_blend_band_on_every_preset_within_the_caps() {
    // RQ3 review: no preset, facade call or genex.toml key reached the cascade blend band or the
    // shadow distance.
    let reach = |control: &RenderControl| {
        let shadows = control.live_frame().quality.shadows;
        (shadows.distance, shadows.blend_percent)
    };
    let mut plain = control(RenderConfig::new());
    assert_eq!(reach(&plain), (80, 10), "desktop-high's high: 80 units, a 10 % band");
    plain.apply(&preset(QualityPreset::Low));
    assert_eq!(reach(&plain), (50, 0), "low: 50 units, a hard switch between its two cascades");
    let toml = RenderConfig::from_toml("[game]\ntitle = \"Pond\"\n\n[render.shadows]\ndistance = 150\nblend_band = 0.2\n").expect("[render.shadows]");
    let mut game = control(toml);
    assert_eq!(reach(&game), (150, 20), "genex.toml's [render.shadows] at high");
    game.apply(&preset(QualityPreset::Medium));
    assert_eq!(reach(&game), (150, 20), "and at every other preset");
    // Release R-13 flipped (was 40; named in the PR): a high-tier phone reaches desktop high's 80
    // units at most, the mid and low phones 40.
    emulate(&mut game, "mobile-high", QualityPreset::Medium);
    assert_eq!(reach(&game).0, 80, "a high-tier phone reaches 80 units at most");
    emulate(&mut game, "mobile-mid", QualityPreset::Medium);
    assert_eq!(reach(&game).0, 40, "a mid-tier phone reaches 40 units at most");
    let code = RenderConfig::new().shadows_at(QualityPreset::High, ShadowConfig::new().distance(5).blend_band(0.9));
    assert_eq!(reach(&control(code)), (10, 50), "a request is held to 10..=400 units and half a cascade");
}

// ---------------------------------------------------------------------------------------------
// Persistence (CPU)

fn scratch(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("genex-render-settings-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("scratch");
    dir
}

fn saves(dir: &std::path::Path) -> Saves {
    Saves::at(Ok(format!("{}/", dir.display())))
}

#[test]
fn the_persons_choice_is_saved_per_device_and_read_back_at_the_next_boot() {
    let dir = scratch("persist");
    let mut first = control(RenderConfig::new());
    assert_eq!(first.load_saved(&saves(&dir)), None, "a cold boot has nothing saved");
    first.set_person(ClassOverride { preset: Some(QualityPreset::Medium), render_scale: Some(0.75), ..ClassOverride::default() });
    first.remember_calibration(genex::render::ScoreLevel::new(25));
    assert!(first.save(&saves(&dir)), "written");
    assert!(!first.save(&saves(&dir)), "nothing new to write");

    let mut next = control(RenderConfig::new());
    assert_eq!(next.load_saved(&saves(&dir)).map(|level| level.get()), Some(25), "the calibration hint is cached");
    assert_eq!(next.answer().preset, QualityPreset::Medium, "the saved choice is back");

    let other = DeviceFacts::new(TargetOs::MacOs, wgpu::Backend::Metal, wgpu::DeviceType::DiscreteGpu).with_vendor(0x1002, 0x7340);
    let mut elsewhere = RenderControl::new(RenderConfig::new(), WORLD);
    elsewhere.probe(other, None);
    assert_eq!(elsewhere.load_saved(&saves(&dir)), None, "another adapter has its own entry");
    assert_eq!(elsewhere.person(), &ClassOverride::default());
}

/// Game systems LOD-06: the person's "Detail distance" (a LOD threshold) is saved per device and
/// read back, and a reset is saved too: the next boot has no threshold of the person's.
#[test]
fn the_persons_detail_distance_is_saved_and_a_reset_clears_it_at_the_next_boot() {
    let dir = scratch("detail");
    let mut first = control(RenderConfig::new());
    first.load_saved(&saves(&dir));
    first.set_person(ClassOverride { lod: genex::render::LodConfig::new().threshold_px(0.75), ..ClassOverride::default() });
    assert!(first.save(&saves(&dir)), "written");
    let mut next = control(RenderConfig::new());
    next.load_saved(&saves(&dir));
    assert_eq!(next.person().lod.threshold_px, Some(0.75), "the saved threshold is back");
    next.set_person(ClassOverride::default());
    assert!(next.save(&saves(&dir)), "the reset is written");
    let mut after = control(RenderConfig::new());
    after.load_saved(&saves(&dir));
    assert_eq!(after.person(), &ClassOverride::default(), "nothing of the person's is left");
}

// ---------------------------------------------------------------------------------------------
// The settings panel never moves the checksum (CPU)

#[derive(Default)]
struct Spin {
    angle: u32,
    rolls: Vec<u32>,
}

fn spin_game() -> Game<Spin> {
    let mut game = Game::new(Spin::default()).world_size(WORLD.0, WORLD.1);
    game.on_update(|sim, ctx| {
        sim.world.angle = sim.world.angle.wrapping_add(ctx.rng.below(360));
        if ctx.tick % 60 == 0 {
            sim.world.rolls.push(sim.world.angle);
        }
    });
    game.on_ui(|_, ui, _| {
        genex::render::settings_panel(ui);
    });
    game.probe("spin", |sim| json!({ "angle": sim.world.angle, "rolls": sim.world.rolls }));
    game
}

/// 600 seeded ticks; at tick 300, `change` acts on the runtime over six ticks plus `OPEN_TICKS` (two panel clicks,
/// or the same input aimed at nothing).
fn replay(change: impl Fn(&mut Runtime<Spin>)) -> (String, Runtime<Spin>) {
    let mut runtime = Runtime::new(spin_game()).expect("installs");
    runtime.render().borrow_mut().probe(mac(), None);
    runtime.seed(7);
    runtime.step(FIXED_STEP_MS * 300.0);
    change(&mut runtime);
    runtime.step(FIXED_STEP_MS * (294.0 - OPEN_TICKS));
    assert_eq!(runtime.tick(), 600);
    (runtime.checksum(), runtime)
}

/// Ticks a collapsing panel section takes to open (egui animates it over a sixth of a second).
const OPEN_TICKS: f64 = 12.0;

/// Hover at `at` for a tick, then click there and run two ticks (egui's press and release).
fn click_at(runtime: &mut Runtime<Spin>, at: [f32; 2]) {
    runtime.inject(Input::pointer(at[0], at[1]));
    runtime.step(FIXED_STEP_MS);
    runtime.inject(Input::click_at(at[0], at[1]));
    runtime.step(FIXED_STEP_MS * 2.0);
}

/// Where the panel widget labelled `label` is, as a fraction of the world.
fn widget_at(runtime: &Runtime<Spin>, label: &str) -> [f32; 2] {
    let widget = runtime.hud_widgets().into_iter().find(|widget| widget.label == label).expect("the panel draws the widget");
    widget.center_fraction([WORLD.0, WORLD.1])
}

#[test]
fn a_settings_panel_change_between_two_seeded_600_tick_replays_leaves_the_checksum_identical() {
    // The same input as the changed replay, aimed at nothing.
    let (untouched, untouched_runtime) = replay(|runtime| {
        click_at(runtime, [0.99, 0.99]);
        runtime.step(FIXED_STEP_MS * OPEN_TICKS);
        click_at(runtime, [0.99, 0.98]);
    });
    let (changed, changed_runtime) = replay(|runtime| {
        let before = runtime.render().borrow().answer();
        let header = widget_at(runtime, "Features");
        click_at(runtime, header);
        // The section opens over a few ticks; its last switch is clipped until it has.
        runtime.step(FIXED_STEP_MS * OPEN_TICKS);
        let at = widget_at(runtime, "Shadows");
        click_at(runtime, at);
        let after = runtime.render().borrow().answer();
        assert_ne!(before.features, after.features, "the panel switched shadows");
        runtime.render().borrow_mut().apply(&preset(QualityPreset::Low));
    });
    assert_eq!(changed, untouched, "settings are display state: the checksum never sees them");
    assert_eq!(changed_runtime.state()["spin"], untouched_runtime.state()["spin"]);
    let person = changed_runtime.render().borrow().person().clone();
    assert_eq!(person.switches, vec![(RenderFeature::Shadows, false)], "the panel wrote the person's layer");
    assert_eq!(untouched_runtime.render().borrow().person(), &ClassOverride::default());
}

// ---------------------------------------------------------------------------------------------
// GPU rows (Metal): the presenter draws through the settings

mod metal {
    use super::*;
    use genex::gpu::{GpuError, GpuPass, GpuPassCtx, PassSetup, PassStage};
    use genex::present::Presenter;
    use genex::View;
    use genex_render::drs::{CALM_FRACTION, MAX_SCALE_STEPS, RISE_AFTER_FRAMES, RISE_BACKOFF_MAX_FRAMES};

    fn required() -> bool {
        std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|value| value == "1")
    }

    /// The GPU, one row at a time (pass-1 gate): the dynamic-resolution row calibrates its load from
    /// measured GPU time, and sibling rows drawing on the same GPU in parallel threads made that
    /// calibration 33-89 ms instead of ~23 ms, so its controller chased a load that was not its own.
    static GPU_ROWS: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn gpu_rows() -> std::sync::MutexGuard<'static, ()> {
        GPU_ROWS.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn presenter(size: [u32; 2]) -> Option<Presenter> {
        match Presenter::open(size, &[]) {
            Ok(presenter) => Some(presenter),
            Err(error) if required() => panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}"),
            Err(error) => {
                eprintln!("skipped: no WebGPU-core adapter ({error})");
                None
            }
        }
    }

    #[derive(Default)]
    struct Scene;

    fn scene_game() -> Game<Scene> {
        let mut game = Game::new(Scene).world_size(160, 90).background(Color::rgb(30, 40, 60));
        game.camera(|_| Camera::look_at(vec3(3.0, 3.0, 6.0), Vec3::ZERO));
        game.on_draw(|_, frame, _| {
            frame.cube(Transform::from_xyz(0.0, 0.5, 0.0), Color::RED);
            frame.cube(Transform::from_xyz(0.0, -0.5, 0.0).with_scale(vec3(6.0, 0.2, 6.0)), Color::rgb(90, 160, 90));
        });
        game
    }

    /// Owner decision 2026-10-12 (2), end to end: a Live frame on this Mac probes the adapter's
    /// GPU-visible memory (Metal's recommended working set), and the desktop budget it gives holds
    /// AO at `high` with every preset offered on a Retina full-screen world (3024 x 1964) once the
    /// Mac's GPU sees 16 GiB or more (an eighth of it reaches the 2 GiB ceiling).
    #[test]
    #[ignore = "needs the host GPU: run with --ignored metal"]
    fn metal_a_live_frame_takes_the_macs_gpu_memory_into_its_budget_at_retina_full_screen() {
        use genex_render::presets::{DESKTOP_BUDGET_MEMORY_CAP_BYTES, DESKTOP_BUDGET_MEMORY_DIVISOR, class_defaults};
        const RETINA: [u32; 2] = [3024, 1964];
        let _gpu = gpu_rows();
        let Some(mut presenter) = presenter(RETINA) else { return };
        if presenter.gpu().device_facts().os != TargetOs::MacOs {
            eprintln!("skipped: not a Mac");
            return;
        }
        let mut game = scene_game();
        game = game.world_size(RETINA[0], RETINA[1]);
        let mut runtime = Runtime::new(game).expect("installs");
        presenter.draw_view(&mut runtime, View::Game).expect("a view").expect("a Live frame");
        let handle = runtime.render();
        let mut control = handle.borrow_mut();
        let memory = control.facts().gpu_visible_memory_bytes.expect("the probe read Metal's working set");
        let class = control.detected_class();
        let expected = class_defaults(class).budget_bytes.max((memory / DESKTOP_BUDGET_MEMORY_DIVISOR).min(DESKTOP_BUDGET_MEMORY_CAP_BYTES));
        let budget = control.live_profile().budget_bytes;
        println!("gpu-visible memory {} MiB, class {}, budget {} MiB", memory >> 20, class.wire(), budget >> 20);
        assert_eq!(budget, expected);
        if memory / DESKTOP_BUDGET_MEMORY_DIVISOR < DESKTOP_BUDGET_MEMORY_CAP_BYTES {
            eprintln!("this Mac's GPU sees under 16 GiB: the Retina rows are the CPU rows' small-memory case");
            return;
        }
        control.set_person(person_preset(QualityPreset::High));
        assert!(on(&control, RenderFeature::Ao), "high keeps AO at the Retina full-screen size");
        control.set_person(ClassOverride::default());
        let offered = control.panel_offered();
        println!("offered {offered:?}");
        assert_eq!(offered, QualityPreset::ALL.to_vec());
    }

    /// A cold boot (fresh runtime and device, nothing saved) and one capture's digest. The game
    /// switches AO and TAA off on the reference class, so a capture is one re-render like a Live
    /// frame (high's temporal GTAO and TAA would settle it over a whole jitter cycle; RQ5.6 added
    /// TAA to the switches, named in the log).
    fn cold_capture(person: Option<ClassOverride>) -> Option<(u64, u64)> {
        let mut presenter = presenter([160, 90])?;
        let mut game = scene_game();
        let no_ao = ClassOverride { switches: vec![(RenderFeature::Ao, false), (RenderFeature::Taa, false)], ..ClassOverride::default() };
        // Native, so Live renders the capture's pixels (lane UQ: a desktop upscales by default).
        game.render_settings(RenderConfig::new().class(genex::render::REFERENCE_CLASS, no_ao).upscale(genex::render::UpscaleMode::Native));
        let mut runtime = Runtime::new(game).expect("installs");
        if let Some(person) = person {
            presenter.draw_view(&mut runtime, View::Game)?.expect("a first Live frame");
            runtime.render().borrow_mut().set_person(person);
        }
        presenter.draw_view(&mut runtime, View::Game)?.expect("Live");
        let live = presenter.resilient.capture().expect("Live readback").digest();
        presenter.set_capturing(true);
        presenter.draw_view(&mut runtime, View::Game)?.expect("capture");
        presenter.set_capturing(false);
        let capture = presenter.resilient.capture().expect("capture readback").digest();
        Some((capture, live))
    }

    #[test]
    #[ignore = "needs the host GPU: run with --ignored metal"]
    fn metal_two_cold_boots_give_one_capture_digest_and_a_saved_choice_changes_live_but_not_the_capture() {
        let _gpu = gpu_rows();
        let (Some((first, first_live)), Some((second, _))) = (cold_capture(None), cold_capture(None)) else { return };
        assert_eq!(first, second, "two cold boots capture one picture");
        assert_eq!(first, first_live, "on the reference class Live and the capture agree");
        let low = ClassOverride { preset: Some(QualityPreset::Low), render_scale: Some(0.5), ..ClassOverride::default() };
        let Some((pinned, live)) = cold_capture(Some(low)) else { return };
        assert_ne!(live, first, "the person's choice changes Live");
        assert_eq!(pinned, first, "but not the capture");
    }

    /// GF round 2 (rust-eject's real fork, `render-presets`, red since pass 2): "mobile-high
    /// (temporal): ao was switched on, but the drawn frame has it off and degraded does not name
    /// it". Live drew TAA with AO on one sample; the check's captures drew the pinned profile on
    /// MSAA and noted their four samples as Live's world pass, so `volatile.render` (read after the
    /// captures) reported Live as MSAA, which on a phone drops AO. A capture's samples are its own:
    /// Live's status after one is what Live draws. Here Live draws the person's medium (MSAA) and
    /// the reference capture TAA on one sample.
    #[test]
    #[ignore = "needs the host GPU: run with --ignored metal"]
    fn metal_a_capture_on_other_samples_leaves_live_status_as_live_draws_it() {
        let _gpu = gpu_rows();
        let Some(mut presenter) = presenter([160, 90]) else { return };
        let mut runtime = Runtime::new(scene_game()).expect("installs");
        runtime.boot_render(presenter.gpu().device_facts().clone(), None);
        runtime.render().borrow_mut().set_person(person_preset(QualityPreset::Medium));
        presenter.draw_view(&mut runtime, View::Game).expect("a view").expect("a Live frame at medium");
        assert_eq!(drawn_aa(&presenter), (false, 4), "the premise: Live draws medium's MSAA");
        let live = runtime.render().borrow().status();
        presenter.set_capturing(true);
        presenter.draw_view(&mut runtime, View::Game).expect("a view").expect("a capture");
        presenter.set_capturing(false);
        assert_eq!(drawn_aa(&presenter), (true, 1), "the premise: the reference capture resolves TAA on one sample");
        let after = runtime.render().borrow().status();
        assert_eq!(after.features, live.features, "Live's status after a capture on other samples");
    }

    /// Whether `presenter`'s last frame resolved TAA, and its world pass's samples.
    fn drawn_aa(presenter: &Presenter) -> (bool, u32) {
        let renderer = presenter.resilient.renderer().renderer();
        (renderer.last_scene().is_some_and(|scene| scene.taa), renderer.sample_count())
    }

    /// A reference-class capture's digest, its K and what it drew, after a first Live frame at the
    /// person's `live` preset (or as the first frame).
    fn capture_after(live: Option<QualityPreset>) -> Option<(u64, u32, (bool, u32))> {
        let mut presenter = presenter([160, 90])?;
        let mut runtime = Runtime::new(scene_game()).expect("installs");
        if let Some(preset) = live {
            // Booted on this adapter first (the shell's probe), so the person's choice is the
            // first frame's, as a saved one would be.
            runtime.boot_render(presenter.gpu().device_facts().clone(), None);
            runtime.render().borrow_mut().set_person(person_preset(preset));
            presenter.draw_view(&mut runtime, View::Game)?.expect("a first Live frame at the person's preset");
            assert_eq!(drawn_aa(&presenter), (false, 4), "Live draws medium's MSAA");
        }
        presenter.set_capturing(true);
        presenter.draw_view(&mut runtime, View::Game)?.expect("capture");
        presenter.set_capturing(false);
        let drawn = drawn_aa(&presenter);
        let settle = presenter.capture_render().expect("provenance").settle_frames;
        Some((presenter.resilient.capture().expect("readback").digest(), settle, drawn))
    }

    // RQ5 review (blocker): the presenter fixed the world pass's samples from the first frame, so
    // Live's medium (MSAA) drawn first made every later reference-class capture draw MSAA while its
    // provenance still said TAA with K = 8. A capture now draws its pinned profile's samples.
    #[test]
    #[ignore = "needs the host GPU: run with --ignored metal"]
    fn metal_a_reference_capture_is_one_picture_whether_live_drew_medium_first_or_nothing() {
        let _gpu = gpu_rows();
        let (Some(first), Some(after_medium)) = (capture_after(None), capture_after(Some(QualityPreset::Medium))) else { return };
        let (digest, settle, drawn) = first;
        assert_eq!(drawn, (true, 1), "the reference class's capture resolves TAA on one sample");
        assert_eq!(settle, 8, "and settles one jitter cycle");
        assert_eq!(after_medium, (digest, settle, drawn), "Live's medium MSAA before it moves neither the picture nor its provenance");
    }

    // RQ5 review: after a TAA boot, a medium preset (MSAA) drew one sample with no anti-aliasing at
    // all for the rest of the session, and the verb's emulated phone class captured that frame
    // instead of the phone's MSAA. An explicit change rebuilds the world pass.
    #[test]
    #[ignore = "needs the host GPU: run with --ignored metal"]
    fn metal_an_explicit_change_after_a_taa_boot_draws_the_presets_own_anti_aliasing() {
        let _gpu = gpu_rows();
        let Some(mut presenter) = presenter([160, 90]) else { return };
        let mut runtime = Runtime::new(scene_game()).expect("installs");
        presenter.draw_view(&mut runtime, View::Game).expect("a view").expect("Live at high");
        assert_eq!(drawn_aa(&presenter), (true, 1), "high resolves TAA on one sample");
        runtime.render().borrow_mut().set_person(person_preset(QualityPreset::Medium));
        presenter.draw_view(&mut runtime, View::Game).expect("a view").expect("Live at medium");
        assert_eq!(drawn_aa(&presenter), (false, 4), "medium draws MSAA 4x, never one aliased sample");
        let reported = on(&runtime.render().borrow(), RenderFeature::Taa);
        assert!(!reported, "volatile.render reports what is drawn");
        runtime.render().borrow_mut().set_person(ClassOverride::default());
        presenter.draw_view(&mut runtime, View::Game).expect("a view").expect("Live at high again");
        assert_eq!(drawn_aa(&presenter), (true, 1), "and back to TAA");
        let phone = RenderChange { device_class: Some(Some(class("mobile-mid"))), ..RenderChange::default() };
        runtime.render().borrow_mut().apply(&phone);
        presenter.set_capturing(true);
        presenter.draw_view(&mut runtime, View::Game).expect("a view").expect("a capture as mobile-mid");
        presenter.set_capturing(false);
        assert_eq!(drawn_aa(&presenter), (false, 4), "the emulated phone's capture draws the phone's MSAA");
    }

    // RQ5 review: every TAA boot built the renderer twice (MSAA by default, then one sample at the
    // first frame). The presenter boots with the samples its adapter's class default draws.
    #[test]
    #[ignore = "needs the host GPU: run with --ignored metal"]
    fn metal_a_boot_on_the_class_default_builds_its_renderer_once() {
        let _gpu = gpu_rows();
        for capture_first in [false, true] {
            let Some(mut presenter) = presenter([160, 90]) else { return };
            let mut runtime = Runtime::new(scene_game()).expect("installs");
            presenter.set_capturing(capture_first);
            presenter.draw_view(&mut runtime, View::Game).expect("a view").expect("a first frame");
            assert_eq!(presenter.resilient.renderer_builds(), 1, "capture first: {capture_first}");
        }
    }

    /// A capture's digest after dynamic resolution held Live at its lowest step (`dropped`) or at
    /// the nominal one, with the capture's render size and the nominal step's.
    fn capture_after_live_at_a_step(dropped: bool) -> Option<(u64, (u32, u32), f32)> {
        let mut presenter = presenter([320, 180])?;
        let mut runtime = Runtime::new(scene_game().world_size(320, 180)).expect("installs");
        presenter.draw_view(&mut runtime, View::Game)?.expect("a first Live frame");
        // The capture's own pinned nominal step (lane UQ: Live's is its upscaling mode's).
        let nominal = runtime.render().borrow().capture_frame().1.scale;
        let live_nominal = runtime.render().borrow().live_frame().scale;
        if dropped {
            let target = runtime.render().borrow().gpu_target_ms();
            for frame in 0..60u64 {
                let now = std::time::Duration::from_millis(16 * frame);
                runtime.render().borrow_mut().observe(Some(1.0), Some(&[target * 3.0]), 16.0, now);
            }
            assert!(runtime.render().borrow().live_frame().scale < live_nominal, "dynamic resolution dropped Live's step");
        }
        for _ in 0..3 {
            presenter.draw_view(&mut runtime, View::Game)?.expect("Live at the step");
        }
        presenter.set_capturing(true);
        presenter.draw_view(&mut runtime, View::Game)?.expect("capture");
        presenter.set_capturing(false);
        let size = presenter.resilient.renderer().renderer().render_size();
        Some((presenter.resilient.capture().expect("readback").digest(), size, nominal))
    }

    // RQ5 review: genex-render's row set the capture's scale itself, so it never tested that the
    // capture path draws at the nominal step whatever step Live holds. The presenter owns that.
    #[test]
    #[ignore = "needs the host GPU: run with --ignored metal"]
    fn metal_a_capture_draws_the_nominal_step_whatever_step_dynamic_resolution_holds_live_at() {
        let _gpu = gpu_rows();
        let (Some(at_nominal), Some(after_drop)) = (capture_after_live_at_a_step(false), capture_after_live_at_a_step(true)) else { return };
        let (_, size, nominal) = at_nominal;
        assert_eq!(size, genex_render::presets::step_size((320, 180), nominal), "the capture draws at the nominal step");
        assert_eq!(after_drop, at_nominal, "Live's dropped step reaches neither the capture's size nor its picture");
    }

    /// The material arrays a presenter's renderer holds after its first frame (a capture when
    /// `capture_first`, else Live as an emulated phone at `low`) and a 1024 texture.
    fn arrays_after_a_first_frame(capture_first: bool) -> Option<Option<(DeviceClass, genex_render::settings::TextureQuality)>> {
        let mut presenter = presenter([160, 90])?;
        let mut runtime = Runtime::new(scene_game()).expect("installs");
        if capture_first {
            presenter.set_capturing(true);
        } else {
            let phone = RenderChange { device_class: Some(Some(class("mobile-mid"))), ..preset(QualityPreset::Low) };
            runtime.render().borrow_mut().apply(&phone);
        }
        presenter.draw_view(&mut runtime, View::Game)?.expect("a first frame");
        let fine = genex_render::texture::TextureData::rgba8(1024, 1024, vec![200; 1024 * 1024 * 4]).expect("a texture");
        presenter.resilient.add_texture(&fine, genex_render::texture::TextureKind::Color).expect("added");
        Some(presenter.resilient.renderer().renderer().texture_arrays())
    }

    // RQ6 review: a capture's texture size classes depended on which frame uploaded the first
    // texture; the session's arrays are set before any frame draws.
    #[test]
    #[ignore = "needs the host GPU: run with --ignored metal"]
    fn metal_the_texture_arrays_are_the_sessions_whichever_frame_comes_first() {
        let _gpu = gpu_rows();
        let (Some(captured), Some(emulated)) = (arrays_after_a_first_frame(true), arrays_after_a_first_frame(false)) else { return };
        assert!(captured.is_some(), "the arrays are fixed");
        assert_eq!(captured, emulated, "a capture first or an emulated phone at low first: the same arrays");
    }

    #[test]
    #[ignore = "needs the host GPU: run with --ignored metal"]
    fn metal_volatile_render_reports_gpu_ms_on_metal_after_live_frames() {
        let _gpu = gpu_rows();
        let Some(mut presenter) = presenter([160, 90]) else { return };
        let mut runtime = Runtime::new(scene_game()).expect("installs");
        for _ in 0..12 {
            presenter.draw_view(&mut runtime, View::Game).expect("a view").expect("drawn");
            let _ = presenter.gpu().device.poll(wgpu::PollType::wait_indefinitely());
        }
        let status = runtime.render().borrow().status();
        assert_eq!(status.device_class.form, FormFactor::Desktop);
        assert!(status.cpu_ms.is_some(), "CPU time is always measured");
        let offers = presenter.gpu().device.features().contains(wgpu::Features::TIMESTAMP_QUERY);
        assert_eq!(status.gpu_ms.is_some(), offers, "GPU ms from timestamps where offered ({status:?})");
        if required() {
            assert!(offers, "Metal on Apple silicon offers timestamp queries");
        }
    }

    /// The phone shell draws through this presenter with its destination's facts: a Live frame on
    /// an iPhone and on an Android phone takes the class's preset at its nominal scale.
    #[test]
    #[ignore = "needs the host GPU: run with --ignored metal"]
    fn metal_a_phone_shell_frame_draws_at_its_class_preset_and_nominal_scale() {
        let _gpu = gpu_rows();
        let bucket = |scale: f32| (scale / genex_render::drs::SCALE_QUANTUM).round() * genex_render::drs::SCALE_QUANTUM;
        let iphone = DeviceFacts::new(TargetOs::Ios, wgpu::Backend::Metal, wgpu::DeviceType::IntegratedGpu).with_vendor(APPLE_VENDOR_ID, 0);
        let android = DeviceFacts::new(TargetOs::Android, wgpu::Backend::Vulkan, wgpu::DeviceType::IntegratedGpu)
            .with_vendor(genex_render::device_class::QUALCOMM_VENDOR_ID, 0);
        for (facts, wanted) in [(iphone, "mobile-high"), (android, "mobile-mid")] {
            let Some(mut presenter) = presenter([320, 180]) else { return };
            presenter.set_device_facts(facts);
            let mut runtime = Runtime::new(scene_game().world_size(320, 180)).expect("installs");
            presenter.draw_view(&mut runtime, View::Game).expect("a view").expect("drawn");
            let status = runtime.render().borrow().status();
            let defaults = genex_render::presets::class_defaults(class(wanted));
            assert_eq!(status.device_class, class(wanted), "the phone's class");
            assert_eq!(status.preset, defaults.preset, "{wanted}'s default preset");
            assert_eq!(status.scale, bucket(defaults.nominal_scale), "{wanted}'s nominal scale");
            let size = presenter.resilient.renderer().renderer().render_size();
            assert_eq!(size, genex_render::presets::step_size((320, 180), status.scale), "the frame was drawn at that scale");
        }
    }

    /// Evidence (only with `GENEX_RENDER_EVIDENCE_DIR`): Live with the settings panel, the pinned
    /// capture, the same view captured as an emulated phone, and Live with the person's shadows off,
    /// each as top-down BGRA (`<name>.bgra`, with its size in `<name>.json`).
    #[test]
    #[ignore = "needs the host GPU: run with --ignored metal"]
    fn metal_evidence_panel_and_pinned_and_emulated_captures() {
        let _gpu = gpu_rows();
        let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") else { return };
        let Some(mut presenter) = presenter([640, 360]) else { return };
        let mut game = scene_game().world_size(640, 360);
        game.on_ui(|_, ui, _| {
            genex::render::settings_panel(ui);
        });
        let mut runtime = Runtime::new(game).expect("installs");
        runtime.start();
        runtime.step(FIXED_STEP_MS);
        let keep = |presenter: &mut Presenter, runtime: &mut Runtime<Scene>, name: &str, capturing: bool| {
            presenter.set_capturing(capturing);
            presenter.draw_view(runtime, View::Game).expect("a view").expect("drawn");
            presenter.set_capturing(false);
            let shot = presenter.resilient.capture().expect("readback");
            std::fs::create_dir_all(&dir).expect("evidence dir");
            std::fs::write(format!("{dir}/{name}.bgra"), shot.bgra()).expect("bgra");
            let meta = json!({ "width": shot.width(), "height": shot.height(), "digest": format!("{:016x}", shot.digest()), "render": format!("{:?}", runtime.render().borrow().status()) });
            std::fs::write(format!("{dir}/{name}.json"), meta.to_string()).expect("json");
        };
        keep(&mut presenter, &mut runtime, "native-live-panel", false);
        keep(&mut presenter, &mut runtime, "native-capture-pinned", true);
        let phone = RenderChange { device_class: Some(Some(class("mobile-mid"))), ..RenderChange::default() };
        runtime.render().borrow_mut().apply(&phone);
        // The HUD is built by the tick's UI hooks: step once so the panel names the emulated class.
        runtime.step(FIXED_STEP_MS);
        keep(&mut presenter, &mut runtime, "native-capture-as-mobile-mid", true);
        runtime.render().borrow_mut().apply(&RenderChange { device_class: Some(None), ..RenderChange::default() });
        let person = ClassOverride { switches: vec![(RenderFeature::Shadows, false)], ..ClassOverride::default() };
        runtime.render().borrow_mut().set_person(person);
        runtime.step(FIXED_STEP_MS);
        keep(&mut presenter, &mut runtime, "native-live-person-shadows-off", false);
    }

    /// A full-screen in-world draw whose fragment cost is `iterations` dependent steps per pixel:
    /// the test-only synthetic GPU load, proportional to the render size.
    struct Heavy {
        iterations: std::rc::Rc<std::cell::Cell<u32>>,
        pipeline: Option<genex::gpu::RenderPipeline>,
        group: Option<genex::gpu::BindGroup>,
        uniforms: Option<genex::gpu::Buffer>,
    }

    const HEAVY_WGSL: &str = r#"
struct Load { iterations: u32, pad0: u32, pad1: u32, pad2: u32 }
@group(0) @binding(0) var<uniform> load: Load;

@vertex
fn vs(@builtin(vertex_index) vertex: u32) -> @builtin(position) vec4<f32> {
    let x = f32((vertex << 1u) & 2u) * 2.0 - 1.0;
    let y = f32(vertex & 2u) * 2.0 - 1.0;
    return vec4<f32>(x, y, 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    var a = position.xy * 0.001;
    for (var i = 0u; i < load.iterations; i = i + 1u) {
        a = fract(a * 1.7 + vec2<f32>(0.3, 0.7));
    }
    return vec4<f32>(a * 0.0001, 0.0, 0.0);
}
"#;

    impl GpuPass<Scene> for Heavy {
        fn rebuild(&mut self, setup: &mut PassSetup<'_>) -> Result<(), GpuError> {
            use genex::gpu::*;
            let module = setup.create_shader("heavy", HEAVY_WGSL)?;
            let uniforms = setup.create_buffer_init("heavy", &[0u8; 16], BufferUsages::UNIFORM | BufferUsages::COPY_DST)?;
            let layout = setup.create_bind_group_layout(&BindGroupLayoutDescriptor {
                label: Some("heavy"),
                entries: &[BindGroupLayoutEntry {
                    binding: 0,
                    visibility: ShaderStages::FRAGMENT,
                    ty: BindingType::Buffer { ty: BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None },
                    count: None,
                }],
            });
            let group = setup.create_bind_group(&BindGroupDescriptor {
                label: Some("heavy"),
                layout: &layout,
                entries: &[BindGroupEntry { binding: 0, resource: uniforms.as_entire_binding() }],
            });
            let pipeline_layout =
                setup.create_pipeline_layout(&PipelineLayoutDescriptor { label: Some("heavy"), bind_group_layouts: &[Some(&layout)], immediate_size: 0 });
            let add = BlendComponent { src_factor: BlendFactor::One, dst_factor: BlendFactor::One, operation: BlendOperation::Add };
            let targets = [Some(ColorTargetState { format: setup.world_format(), blend: Some(BlendState { color: add, alpha: add }), write_mask: ColorWrites::ALL })];
            let mut depth = setup.world_depth(false);
            depth.depth_compare = Some(CompareFunction::Always);
            let pipeline = setup.create_render_pipeline(&RenderPipelineDescriptor {
                label: Some("heavy"),
                layout: Some(&pipeline_layout),
                vertex: VertexState { module: &module, entry_point: Some("vs"), compilation_options: Default::default(), buffers: &[] },
                primitive: PrimitiveState::default(),
                depth_stencil: Some(depth),
                multisample: setup.world_multisample(),
                fragment: Some(FragmentState { module: &module, entry_point: Some("fs"), compilation_options: Default::default(), targets: &targets }),
                multiview_mask: None,
                cache: None,
            });
            (self.pipeline, self.group, self.uniforms) = (Some(pipeline), Some(group), Some(uniforms));
            Ok(())
        }

        fn run(&mut self, ctx: &mut GpuPassCtx<'_, '_, Scene>) {
            let (Some(pipeline), Some(group), Some(uniforms)) = (&self.pipeline, &self.group, &self.uniforms) else { return };
            let mut bytes = [0u8; 16];
            bytes[..4].copy_from_slice(&self.iterations.get().to_le_bytes());
            if ctx.write_buffer(uniforms, 0, &bytes).is_err() {
                return;
            }
            let Some(draws) = ctx.draws() else { return };
            draws.set_pipeline(pipeline).set_bind_group(0, group, &[]).draw(0..3, 0..1);
        }
    }

    /// Draw one Live frame and wait for it (one frame in flight, as a paced display).
    fn live_frame(presenter: &mut Presenter, runtime: &mut Runtime<Scene>) {
        presenter.draw_view(runtime, View::Game).expect("a view").expect("drawn");
        let _ = presenter.gpu().device.poll(wgpu::PollType::wait_indefinitely());
    }

    /// The GPU times of `frames` Live frames, lowest first, after five that settle the change
    /// before them.
    fn measured_samples(presenter: &mut Presenter, runtime: &mut Runtime<Scene>, frames: u32) -> Vec<f32> {
        let mut samples = Vec::new();
        for frame in 0..frames + 5 {
            live_frame(presenter, runtime);
            if frame >= 5 {
                samples.extend(runtime.render().borrow().last_gpu_ms());
            }
        }
        assert!(!samples.is_empty(), "timestamps on Metal");
        samples.sort_by(f32::total_cmp);
        samples
    }

    /// The median GPU time of `frames` Live frames, after five that settle the change before them.
    fn measured_ms(presenter: &mut Presenter, runtime: &mut Runtime<Scene>, frames: u32) -> f32 {
        let samples = measured_samples(presenter, runtime, frames);
        samples[samples.len() / 2]
    }

    #[test]
    #[ignore = "needs the host GPU: run with --ignored metal"]
    fn metal_dynamic_resolution_holds_the_gpu_target_under_a_synthetic_load_within_sixty_frames() {
        let _gpu = gpu_rows();
        let Some(mut presenter) = presenter([1920, 1080]) else { return };
        if !presenter.gpu().device.features().contains(wgpu::Features::TIMESTAMP_QUERY) {
            assert!(!required(), "Metal offers timestamp queries");
            return;
        }
        let iterations = std::rc::Rc::new(std::cell::Cell::new(64));
        let mut game = Game::new(Scene).world_size(1920, 1080);
        game.camera(|_| Camera::look_at(vec3(3.0, 3.0, 6.0), Vec3::ZERO));
        game.on_draw(|_, frame, _| {
            frame.cube(Transform::from_xyz(0.0, 0.0, 0.0), Color::RED);
        });
        let heavy = Heavy { iterations: std::rc::Rc::clone(&iterations), pipeline: None, group: None, uniforms: None };
        game.gpu_pass("heavy", PassStage::AfterOpaque, heavy);
        let mut runtime = Runtime::new(game).expect("installs");
        assert!(presenter.install_for(&mut runtime).is_empty(), "the load pass is admitted");
        let handle = runtime.render();
        // Calibrate the load at full scale (held), so the frame costs 1.6x the GPU target.
        let hold = RenderChange { render_scale_lock: Some(Some(1.0)), ..RenderChange::default() };
        handle.borrow_mut().apply(&hold);
        let target = handle.borrow().gpu_target_ms();
        let light = measured_ms(&mut presenter, &mut runtime, 15);
        iterations.set(1024);
        let heavier = measured_ms(&mut presenter, &mut runtime, 15);
        let per_iteration = ((heavier - light) / 960.0).max(1.0e-6);
        let wanted = 64.0 + (1.6 * target - light) / per_iteration;
        iterations.set(wanted.clamp(64.0, 1.0e6) as u32);
        let loaded = measured_ms(&mut presenter, &mut runtime, 15);
        eprintln!("target {target:.2} ms; load {loaded:.2} ms at scale 1 ({} iterations)", iterations.get());
        assert!(loaded > target * 1.2, "the synthetic load is over the target at full scale ({loaded:.2} ms)");
        // Release the scale: dynamic resolution has 60 frames to bring the frame under target.
        let release = RenderChange { render_scale_lock: Some(None), ..RenderChange::default() };
        handle.borrow_mut().apply(&release);
        for _ in 0..60 {
            live_frame(&mut presenter, &mut runtime);
        }
        let scale = handle.borrow().status().scale;
        assert!(scale < 1.0, "the scale dropped on the GPU's own timestamps (scale {scale})");
        // What the drop saves, measured interleaved with scale 1 so both sides share the machine's
        // load (pass-1 gate: an absolute bound read 15.90 against 15.59 ms at load 38, at the scale
        // floor). That the step holds the target is the decision's, proven on injected frame times
        // (`render::tests::dynamic_resolution_holds_the_gpu_target_under_a_synthetic_load_within_sixty_frames`).
        let (mut stepped, mut full) = (Vec::new(), Vec::new());
        for _ in 0..3 {
            for (lock, samples) in [(scale, &mut stepped), (1.0, &mut full)] {
                handle.borrow_mut().apply(&RenderChange { render_scale_lock: Some(Some(lock)), ..RenderChange::default() });
                samples.push(measured_ms(&mut presenter, &mut runtime, 10));
            }
        }
        let median = |samples: &mut Vec<f32>| {
            samples.sort_by(f32::total_cmp);
            samples[samples.len() / 2]
        };
        let (at_step, at_full) = (median(&mut stepped), median(&mut full));
        let ratio = at_step / at_full;
        eprintln!("after 60 frames: scale {scale}; GPU p50 {at_step:.2} ms there, {at_full:.2} ms at scale 1 (ratio {ratio:.2}; target {target:.2} ms)");
        assert!(ratio <= DRS_SAVING_RATIO_MAX, "the step draws in {ratio:.2} of scale 1's GPU time (pixels {:.2})", scale * scale);
    }

    /// A drop to the scale floor (0.656: 0.43 of the pixels) must save at least this share of the
    /// loaded frame, measured interleaved: the load is pixel-proportional, the output-size passes
    /// and another program's GPU work are not.
    const DRS_SAVING_RATIO_MAX: f32 = 0.85;

    /// Each read of an injected clock advances it by `step`: a Live frame reads it once at its
    /// start and once at its end, so every frame's CPU time is `step`.
    fn stepping_clock(step: std::time::Duration) -> genex_render::timing::Clock {
        let reads = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
        std::sync::Arc::new(move || step * reads.fetch_add(1, std::sync::atomic::Ordering::Relaxed))
    }

    /// The frames the row's scale may take to climb back from the floor: five steps of 30 calm
    /// frames each, with room for a rise undone by another program's GPU work.
    const RISE_FRAMES_MAX: u32 = 1200;

    /// What `frames` Live frames gave the controller: the landed GPU times over `over_ms`, and
    /// the calm runs it could rise on (each [`RISE_AFTER_FRAMES`] frames in a row under
    /// [`CALM_FRACTION`] of `target_ms`), with `stop` ending the frames early.
    struct Landed {
        frames: u32,
        over: u32,
        calm_runs: u32,
    }

    fn landed_frames(presenter: &mut Presenter, runtime: &mut Runtime<Scene>, frames: u32, (target_ms, over_ms): (f32, f32), stop: &dyn Fn() -> bool) -> Landed {
        let mut landed = Landed { frames: 0, over: 0, calm_runs: 0 };
        let mut calm = 0;
        while landed.frames < frames && !stop() {
            live_frame(presenter, runtime);
            landed.frames += 1;
            let Some(ms) = runtime.render().borrow().last_gpu_ms() else { continue };
            landed.over += u32::from(ms > over_ms);
            calm = if ms < target_ms * CALM_FRACTION { calm + 1 } else { 0 };
            if calm == RISE_AFTER_FRAMES {
                landed.calm_runs += 1;
                calm = 0;
            }
        }
        landed
    }

    /// G0 round 2: these rows read the GPU's own timestamps, and another program's GPU work
    /// lands in them too (Apple's timestamps span the queue's wall time). At host load 32 to 146
    /// the rise after the load was gone never came (the light frames never stayed calm for
    /// [`RISE_AFTER_FRAMES`]) and frames inside the class's time crossed it. A row whose frames
    /// did not give the controller its premise fails naming the busy host, not dynamic
    /// resolution: the gate reads that as not measured.
    fn busy_host(what: &str, landed: &Landed) -> String {
        format!("premise not met, the host's GPU is busy: {what} ({} of {} frames over, {} calm runs)", landed.over, landed.frames, landed.calm_runs)
    }

    /// The wall clock, as the native presenter's own (`present::default_clock`).
    #[allow(clippy::disallowed_types, reason = "the row's rise phase times frames as Live does")]
    fn wall_clock() -> genex_render::timing::Clock {
        let start = std::time::Instant::now();
        std::sync::Arc::new(move || start.elapsed())
    }

    /// Pass-1 gate live finding 3: under the verb's `frameBudgetMs` the lakeside's scale stayed 1.0
    /// at medium, high and ultra and moved only at low, because their frames' CPU time was over the
    /// budget's GPU target and every such frame read as CPU-bound. Each preset here encodes its
    /// frames in an injected CPU time over the target, while its GPU time is twice the budget:
    /// the scale steps down within 60 frames, and back to the nominal once the load is gone.
    #[test]
    #[ignore = "needs the host GPU: run with --ignored metal"]
    fn metal_under_the_verb_s_budget_the_scale_steps_down_and_back_up_at_medium_high_and_ultra() {
        let _gpu = gpu_rows();
        for preset_choice in [QualityPreset::Medium, QualityPreset::High, QualityPreset::Ultra] {
            let Some(mut presenter) = presenter([1920, 1080]) else { return };
            if !presenter.gpu().device.features().contains(wgpu::Features::TIMESTAMP_QUERY) {
                assert!(!required(), "Metal offers timestamp queries");
                return;
            }
            let iterations = std::rc::Rc::new(std::cell::Cell::new(64));
            let mut game = Game::new(Scene).world_size(1920, 1080);
            game.camera(|_| Camera::look_at(vec3(3.0, 3.0, 6.0), Vec3::ZERO));
            game.on_draw(|_, frame, _| {
                frame.cube(Transform::from_xyz(0.0, 0.0, 0.0), Color::RED);
            });
            let heavy = Heavy { iterations: std::rc::Rc::clone(&iterations), pipeline: None, group: None, uniforms: None };
            game.gpu_pass("heavy", PassStage::AfterOpaque, heavy);
            let mut runtime = Runtime::new(game).expect("installs");
            assert!(presenter.install_for(&mut runtime).is_empty(), "the load pass is admitted");
            let handle = runtime.render();
            let mut held = preset(preset_choice);
            held.render_scale_lock = Some(Some(1.0));
            handle.borrow_mut().apply(&held);
            // The budget: every light frame calm under it, its slowest too (ultra's cadenced
            // shadow and sky work lifts one frame in five or six by about 0.7 ms on the M4 Max),
            // and the loaded frame twice it.
            let samples = measured_samples(&mut presenter, &mut runtime, 30);
            let light = samples[samples.len() / 2];
            let slowest = samples[samples.len() - 1];
            let budget = (light * 2.5).max(slowest * 2.0).max(genex::render::FRAME_BUDGET_MS_MIN);
            iterations.set(1024);
            let heavier = measured_ms(&mut presenter, &mut runtime, 15);
            let per_iteration = ((heavier - light) / 960.0).max(1.0e-6);
            iterations.set((64.0 + (2.0 * budget - light) / per_iteration).clamp(64.0, 1.0e6) as u32);
            let loaded = measured_ms(&mut presenter, &mut runtime, 15);
            let target = budget * 0.85;
            // Every frame's CPU time is over the GPU target (the live lakeside's), under its GPU span.
            let cpu = std::time::Duration::from_secs_f32(target * 1.05 / 1000.0);
            presenter.set_clock(stepping_clock(cpu));
            let release = RenderChange { render_scale_lock: Some(None), frame_budget_ms: Some(Some(budget)), ..RenderChange::default() };
            handle.borrow_mut().apply(&release);
            let nominal = handle.borrow().status().scale;
            for _ in 0..60 {
                live_frame(&mut presenter, &mut runtime);
            }
            let stepped = handle.borrow().status().scale;
            eprintln!("{preset_choice:?}: light {light:.2} ms (slowest {slowest:.2}), loaded {loaded:.2} ms at scale 1, budget {budget:.2} ms; after 60 frames scale {stepped}");
            assert!(stepped < nominal, "{preset_choice:?}: GPU frames over the budget step the scale down (scale {stepped})");
            // Rising on the wall clock: a frame whose CPU thread another program preempted reads
            // its span as the CPU's, as in Live, and does not undo a rise.
            presenter.set_clock(wall_clock());
            iterations.set(64);
            let gpu_target = handle.borrow().gpu_target_ms();
            let below_nominal = || handle.borrow().status().scale < nominal;
            let landed = landed_frames(&mut presenter, &mut runtime, RISE_FRAMES_MAX, (gpu_target, gpu_target), &|| !below_nominal());
            let back = handle.borrow().status().scale;
            eprintln!("{preset_choice:?}: the load gone, scale {back} after {} frames ({} calm runs)", landed.frames, landed.calm_runs);
            // Each step up waits for one calm run, or up to RISE_BACKOFF_MAX_FRAMES after a rise
            // was undone: fewer runs than that for every step a class has was not the
            // controller's premise.
            let runs_needed = (MAX_SCALE_STEPS as u32 - 1) * (RISE_BACKOFF_MAX_FRAMES / RISE_AFTER_FRAMES);
            assert!(back == nominal || landed.calm_runs >= runs_needed, "{preset_choice:?}: {}", busy_host("the light frames never stayed calm", &landed));
            assert_eq!(back, nominal, "{preset_choice:?}: frames under the budget give the nominal scale back");
        }
    }

    /// Pass-1 gate round 3: on an M4 Max no Live frame came near the class's frame time, so Live
    /// never showed dynamic resolution react. The verb's frame budget (this session only) is what
    /// the controller then holds: frames inside the class's time step the scale down under a
    /// budget below them, and a null budget gives the class's time and the full scale back.
    #[test]
    #[ignore = "needs the host GPU: run with --ignored metal"]
    fn metal_a_frame_budget_from_the_verb_steps_the_scale_of_frames_inside_the_class_s_time() {
        let _gpu = gpu_rows();
        let Some(mut presenter) = presenter([1920, 1080]) else { return };
        if !presenter.gpu().device.features().contains(wgpu::Features::TIMESTAMP_QUERY) {
            assert!(!required(), "Metal offers timestamp queries");
            return;
        }
        let iterations = std::rc::Rc::new(std::cell::Cell::new(64));
        let mut game = Game::new(Scene).world_size(1920, 1080);
        game.camera(|_| Camera::look_at(vec3(3.0, 3.0, 6.0), Vec3::ZERO));
        game.on_draw(|_, frame, _| {
            frame.cube(Transform::from_xyz(0.0, 0.0, 0.0), Color::RED);
        });
        let heavy = Heavy { iterations: std::rc::Rc::clone(&iterations), pipeline: None, group: None, uniforms: None };
        game.gpu_pass("heavy", PassStage::AfterOpaque, heavy);
        // The row's premise is Live at scale 1: the game asks for Native (lane UQ: a desktop
        // upscales by default).
        game.render_settings(RenderConfig::new().upscale(genex::render::UpscaleMode::Native));
        let mut runtime = Runtime::new(game).expect("installs");
        assert!(presenter.install_for(&mut runtime).is_empty(), "the load pass is admitted");
        let handle = runtime.render();
        let class_target = handle.borrow().gpu_target_ms();
        // Calibrate a load of about 40% of the class's target at full scale (held while measuring).
        // G0 leftovers: under another process's 4K captures the first calibration read the shared
        // GPU's queue as load (light frames near the class's time), so the row failed its premise
        // and never reached dynamic resolution. It calibrates up to CALIBRATIONS times; a host
        // whose GPU never gave the premise fails naming the busy host, not dynamic resolution.
        const CALIBRATIONS: usize = 4;
        handle.borrow_mut().apply(&RenderChange { render_scale_lock: Some(Some(1.0)), ..RenderChange::default() });
        let mut tries = Vec::new();
        let (loaded, budget) = loop {
            iterations.set(64);
            let light = measured_ms(&mut presenter, &mut runtime, 15);
            iterations.set(1024);
            let heavier = measured_ms(&mut presenter, &mut runtime, 15);
            let per_iteration = ((heavier - light) / 960.0).max(1.0e-6);
            iterations.set((64.0 + (0.4 * class_target - light) / per_iteration).clamp(64.0, 1.0e6) as u32);
            let loaded = measured_ms(&mut presenter, &mut runtime, 15);
            let budget = (loaded / 2.0).max(genex::render::FRAME_BUDGET_MS_MIN);
            eprintln!("class target {class_target:.2} ms; light {light:.2} ms; load {loaded:.2} ms at scale 1; budget {budget:.2} ms");
            tries.push(format!("light {light:.2}, load {loaded:.2}"));
            if loaded < class_target * 0.8 && loaded > budget * 1.5 {
                break (loaded, budget);
            }
            assert!(
                tries.len() < CALIBRATIONS,
                "the premise (a load inside the class's {class_target:.2} ms, over the budget) never held in {CALIBRATIONS} calibrations ({tries:?} ms): the host's GPU is busy, not dynamic resolution"
            );
        };
        eprintln!("calibrated in {} tries: load {loaded:.2} ms, budget {budget:.2} ms", tries.len());
        // The class's own target keeps the full scale under this load.
        handle.borrow_mut().apply(&RenderChange { render_scale_lock: Some(None), ..RenderChange::default() });
        let inside = landed_frames(&mut presenter, &mut runtime, 60, (class_target, class_target), &|| false);
        let kept = handle.borrow().status().scale;
        assert!(kept == 1.0 || inside.over == 0, "{}", busy_host("frames of the class's time crossed it", &inside));
        assert_eq!(kept, 1.0, "frames inside the class's time keep scale 1");
        let held = handle.borrow_mut().apply(&RenderChange { frame_budget_ms: Some(Some(budget)), ..RenderChange::default() });
        assert_eq!(held.frame_budget_ms, Some(budget));
        for _ in 0..60 {
            live_frame(&mut presenter, &mut runtime);
        }
        let stepped = handle.borrow().status().scale;
        eprintln!("under a {budget:.2} ms budget after 60 frames: scale {stepped}");
        assert!(stepped < 1.0, "the verb's budget steps the scale down");
        handle.borrow_mut().apply(&RenderChange { frame_budget_ms: Some(None), ..RenderChange::default() });
        assert_eq!(handle.borrow().gpu_target_ms(), class_target, "null gives the class's target back");
        let released = landed_frames(&mut presenter, &mut runtime, 60, (class_target, class_target), &|| false);
        let full = handle.borrow().status().scale;
        assert!(full == 1.0 || released.over == 0, "{}", busy_host("frames of the class's time crossed it", &released));
        assert_eq!(full, 1.0, "and the full scale");
    }
}

// ---------------------------------------------------------------------------------------------
// Look hot reload (WP-9 iteration speed): `renderSettings {set: {look: {..}}}` overlays
// `[render.look]` keys on the running game's look, no rebuild; `look: null` gives it back.

#[test]
fn a_verb_look_overlays_its_keys_on_the_game_s_look_until_cleared() {
    let game = RenderConfig::from_toml("[render.look]\ntonemapper = \"agx\"\nev_compensation = 0.5\nbloom_intensity = 0.02\n").expect("a look");
    let mut control = control(game.clone());
    let base = control.look();
    let overlay = RenderChange::look_from_json(r#"{"ev_compensation": 1.5, "exposure": "auto"}"#).expect("known look keys");
    control.apply(&RenderChange { look: Some(Some(overlay)), ..RenderChange::default() });
    let live = control.live_frame().look;
    assert_eq!(live.ev_compensation, 1.5, "the verb's key wins");
    assert_eq!(live.exposure, genex::render::ExposureMode::Auto);
    assert_eq!((live.tonemapper, live.bloom_intensity), (base.tonemapper, base.bloom_intensity), "keys it leaves out stay the game's");
    assert_eq!(control.capture_frame().0.look, live, "captures draw the overlaid look too");
    control.apply(&RenderChange { look: Some(None), ..RenderChange::default() });
    assert_eq!(control.live_frame().look, base, "look: null gives the game's look back");
}

#[test]
fn a_verb_look_with_an_unknown_key_or_a_bad_value_is_refused_invalid_look() {
    for json in [r#"{"exposure_bias": 1}"#, r#"{"tonemapper": 3}"#, r#"[1, 2]"#, "not json"] {
        assert_eq!(RenderChange::look_from_json(json), Err(RenderRefusal::InvalidLook), "{json}");
    }
    assert_eq!(RenderRefusal::InvalidLook.wire(), "invalid-look");
    assert!(RenderChange::look_from_json("{}").is_ok(), "an empty overlay changes nothing");
}
