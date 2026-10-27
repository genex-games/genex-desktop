//! The device probe (plan §2.4): device classes from fact fixtures, the web hint fallbacks, the
//! calibration hint (quantized, hysteresis, at most one tier) and its cache key. No row reads an
//! adapter name. The Metal row runs the calibration kernels on the real GPU:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked -- --ignored metal

use genex_render::device_class::{
    APPLE_VENDOR_ID, CALIBRATION_GPU_BUDGET_MS, CALIBRATION_WGSL, CalibrationKey, DeviceClass, DeviceFacts, FormFactor,
    PerformanceTier, QUALCOMM_VENDOR_ID, ScoreLevel, TargetOs, WebHints, calibrate_blocking, classify, classify_calibrated,
    tier_floor_score,
};
use genex_render::floor::AdapterFacts;
use genex_render::{Gpu, RenderError};
use wgpu::{AdapterInfo, Backend, DeviceType, DownlevelCapabilities, Features, Limits};

fn class(wire: &str) -> DeviceClass {
    DeviceClass::from_wire(wire).unwrap_or_else(|| panic!("{wire} is a class"))
}

fn mac_integrated() -> DeviceFacts {
    DeviceFacts::new(TargetOs::MacOs, Backend::Metal, DeviceType::IntegratedGpu).with_vendor(APPLE_VENDOR_ID, 0)
}

fn android_vulkan() -> DeviceFacts {
    DeviceFacts::new(TargetOs::Android, Backend::Vulkan, DeviceType::IntegratedGpu).with_vendor(QUALCOMM_VENDOR_ID, 0x0636)
}

fn web(hints: Option<WebHints>) -> DeviceFacts {
    let facts = DeviceFacts::new(TargetOs::Web, Backend::BrowserWebGpu, DeviceType::Other);
    match hints {
        Some(hints) => facts.with_web(hints),
        None => facts,
    }
}

/// A score inside `tier` of `form` (between its floor and the next tier's).
fn score_in(form: FormFactor, tier: PerformanceTier) -> f32 {
    tier_floor_score(form, tier) * 1.2
}

#[test]
fn every_destination_starts_in_its_form_factor_default() {
    let rows = [
        (mac_integrated(), "desktop-high"),
        (DeviceFacts::new(TargetOs::Windows, Backend::Dx12, DeviceType::DiscreteGpu), "desktop-mid"),
        (DeviceFacts::new(TargetOs::Linux, Backend::Vulkan, DeviceType::DiscreteGpu), "desktop-mid"),
        (DeviceFacts::new(TargetOs::Linux, Backend::Vulkan, DeviceType::Cpu), "desktop-low"),
        (DeviceFacts::new(TargetOs::Ios, Backend::Metal, DeviceType::IntegratedGpu).with_vendor(APPLE_VENDOR_ID, 0), "mobile-high"),
        (android_vulkan(), "mobile-mid"),
    ];
    for (facts, expected) in rows {
        assert_eq!(classify(&facts), class(expected), "{:?} on {:?}", facts.device_type, facts.os);
        assert_eq!(classify_calibrated(&facts, None), class(expected), "no calibration keeps the default");
    }
}

#[test]
fn an_integrated_apple_gpu_with_a_high_score_is_desktop_high_and_ultra_only_on_an_ultra_score() {
    let facts = mac_integrated();
    let high = ScoreLevel::quantize(score_in(FormFactor::Desktop, PerformanceTier::High), None);
    assert_eq!(classify_calibrated(&facts, Some(high)), class("desktop-high"), "the score decides, not the device type");
    let ultra = ScoreLevel::quantize(score_in(FormFactor::Desktop, PerformanceTier::Ultra), None);
    assert_eq!(classify_calibrated(&facts, Some(ultra)), class("desktop-ultra"));
    let mid = ScoreLevel::quantize(score_in(FormFactor::Desktop, PerformanceTier::Mid), None);
    assert_eq!(classify_calibrated(&facts, Some(mid)), class("desktop-mid"));
}

#[test]
fn an_android_vulkan_phone_with_a_low_score_is_mobile_low() {
    let low = ScoreLevel::quantize(score_in(FormFactor::Mobile, PerformanceTier::Low), None);
    assert_eq!(classify_calibrated(&android_vulkan(), Some(low)), class("mobile-low"));
    let high = ScoreLevel::quantize(score_in(FormFactor::Mobile, PerformanceTier::High), None);
    assert_eq!(classify_calibrated(&android_vulkan(), Some(high)), class("mobile-high"), "a flagship Android is promoted");
}

#[test]
fn a_phone_never_becomes_mobile_ultra() {
    let ios = DeviceFacts::new(TargetOs::Ios, Backend::Metal, DeviceType::IntegratedGpu).with_vendor(APPLE_VENDOR_ID, 0);
    let top = ScoreLevel::quantize(score_in(FormFactor::Desktop, PerformanceTier::Ultra) * 64.0, None);
    assert_eq!(classify_calibrated(&ios, Some(top)), class("mobile-high"));
}

#[test]
fn calibration_never_moves_a_class_more_than_one_tier() {
    let defaults = [
        mac_integrated(),
        DeviceFacts::new(TargetOs::Windows, Backend::Dx12, DeviceType::DiscreteGpu),
        DeviceFacts::new(TargetOs::Linux, Backend::Vulkan, DeviceType::Cpu),
        DeviceFacts::new(TargetOs::Ios, Backend::Metal, DeviceType::IntegratedGpu),
        android_vulkan(),
        web(None),
        web(Some(WebHints { short_side_css_px: 1080, ..WebHints::default() })),
    ];
    let index = |tier: PerformanceTier| PerformanceTier::ALL.iter().position(|t| *t == tier).unwrap_or(0) as i32;
    for facts in defaults {
        let start = classify(&facts);
        for level in 0..=ScoreLevel::MAX {
            let moved = classify_calibrated(&facts, Some(ScoreLevel::new(level)));
            assert_eq!(moved.form, start.form, "calibration never changes the form factor");
            assert!((index(moved.tier) - index(start.tier)).abs() <= 1, "{} -> {} at level {level}", start.wire(), moved.wire());
            assert!(DeviceClass::ALL.contains(&moved), "{} is a named class", moved.wire());
        }
    }
}

#[test]
fn a_score_is_quantized_with_hysteresis() {
    let floor = tier_floor_score(FormFactor::Desktop, PerformanceTier::High);
    let just_under = ScoreLevel::quantize(floor * 0.98, None);
    let just_over = ScoreLevel::quantize(floor * 1.02, None);
    assert_ne!(just_under, just_over, "the tier boundary is a level boundary");
    assert_eq!(ScoreLevel::quantize(floor * 1.02, Some(just_under)), just_under, "a 4% wobble keeps the cached level");
    assert_eq!(ScoreLevel::quantize(floor * 0.98, Some(just_over)), just_over);
    let far = ScoreLevel::quantize(floor * 1.6, Some(just_under));
    assert!(far > just_under, "a real change moves the level");
    assert_eq!(ScoreLevel::quantize(floor * 1.6, None), far);
    assert_eq!(ScoreLevel::quantize(0.0, None), ScoreLevel::new(0), "no throughput is the lowest level");
    assert_eq!(ScoreLevel::quantize(f32::NAN, None), ScoreLevel::new(0));
    assert_eq!(ScoreLevel::quantize(f32::INFINITY, None), ScoreLevel::new(ScoreLevel::MAX));
}

#[test]
fn safari_shaped_hints_give_mobile_mid() {
    // iPhone Safari: no userAgentData, no deviceMemory, 5 touch points, a coarse pointer.
    let iphone = WebHints { max_touch_points: 5, coarse_pointer: true, short_side_css_px: 393, ..WebHints::default() };
    assert_eq!(classify(&web(Some(iphone))), class("mobile-mid"));
    // iPadOS Safari reports a desktop user agent; touch and a coarse pointer still say mobile.
    let ipad = WebHints { max_touch_points: 5, coarse_pointer: true, short_side_css_px: 1024, ..WebHints::default() };
    assert_eq!(classify(&web(Some(ipad))), class("mobile-mid"));
}

#[test]
fn desktop_firefox_shaped_hints_give_desktop_mid() {
    let firefox = WebHints { max_touch_points: 0, coarse_pointer: false, short_side_css_px: 1080, ..WebHints::default() };
    assert_eq!(classify(&web(Some(firefox))), class("desktop-mid"));
    let touch_laptop = WebHints {
        max_touch_points: 10,
        coarse_pointer: false,
        short_side_css_px: 1080,
        device_memory_gb: Some(16.0),
        hardware_concurrency: Some(16),
        ua_mobile: Some(false),
    };
    assert_eq!(classify(&web(Some(touch_laptop))), class("desktop-high"), "touch with a fine pointer is a laptop");
}

#[test]
fn a_macbook_air_browser_is_a_desktop_and_a_roomy_one_starts_high() {
    // Bodycam B1: Studio's Live page on an 8 GB M1 MacBook Air (1440x900 screen, no touch) read as
    // a phone (short side <= 900) and drew every judged frame at mobile-mid's `low`.
    let air = WebHints {
        max_touch_points: 0,
        coarse_pointer: false,
        short_side_css_px: 900,
        device_memory_gb: Some(8.0),
        hardware_concurrency: Some(8),
        ua_mobile: Some(false),
    };
    assert_eq!(classify(&web(Some(air))), class("desktop-high"));
    let small_laptop = WebHints { short_side_css_px: 768, device_memory_gb: Some(4.0), hardware_concurrency: Some(4), ..air };
    assert_eq!(classify(&web(Some(small_laptop))), class("desktop-mid"), "a small screen without touch is still a laptop");
    let hidden = WebHints { device_memory_gb: None, ..air };
    assert_eq!(classify(&web(Some(hidden))), class("desktop-mid"), "a hidden deviceMemory reads as 4 GB");
    let few_cores = WebHints { hardware_concurrency: Some(4), ..air };
    assert_eq!(classify(&web(Some(few_cores))), class("desktop-mid"));
}

#[test]
fn a_small_screen_or_a_mobile_user_agent_is_mobile_and_unknown_hints_are_mobile_mid() {
    let small_touch = WebHints { max_touch_points: 1, short_side_css_px: 480, ..WebHints::default() };
    assert_eq!(classify(&web(Some(small_touch))).form, FormFactor::Mobile, "a touch screen with a short side <= 600 CSS px");
    let boundary = WebHints { max_touch_points: 1, short_side_css_px: 600, ..WebHints::default() };
    assert_eq!(classify(&web(Some(boundary))).form, FormFactor::Mobile);
    let small_touch_laptop = WebHints { max_touch_points: 10, short_side_css_px: 853, ..WebHints::default() };
    assert_eq!(classify(&web(Some(small_touch_laptop))).form, FormFactor::Desktop, "a touch laptop at 150% is not a phone");
    let small_no_touch = WebHints { short_side_css_px: 480, ..WebHints::default() };
    assert_eq!(classify(&web(Some(small_no_touch))).form, FormFactor::Desktop, "without touch a small screen is a desktop's");
    let chrome_android = WebHints { short_side_css_px: 1200, ua_mobile: Some(true), ..WebHints::default() };
    assert_eq!(classify(&web(Some(chrome_android))).form, FormFactor::Mobile);
    assert_eq!(classify(&web(None)), class("mobile-mid"), "unknown hints: DRS or the person may promote");
}

#[test]
fn a_missing_device_memory_reads_as_four_gigabytes() {
    assert_eq!(WebHints::default().device_memory_gb(), 4.0);
    assert_eq!(WebHints { device_memory_gb: Some(8.0), ..WebHints::default() }.device_memory_gb(), 8.0);
    assert_eq!(WebHints { device_memory_gb: Some(0.0), ..WebHints::default() }.device_memory_gb(), 4.0, "a nonsense hint is missing");
}

#[test]
fn the_probe_reads_no_adapter_name() {
    let facts_for = |name: &str| {
        let mut info = AdapterInfo::new(DeviceType::DiscreteGpu, Backend::Vulkan);
        info.name = name.to_owned();
        info.driver = format!("{name} driver");
        info.vendor = 0x10de;
        info.device = 0x2684;
        let adapter = AdapterFacts {
            name: name.to_owned(),
            backend: Backend::Vulkan,
            limits: Limits::defaults(),
            downlevel: DownlevelCapabilities::default(),
            features: Features::TIMESTAMP_QUERY,
        };
        DeviceFacts::probe(&info, &adapter).with_os(TargetOs::Linux)
    };
    let one = facts_for("NVIDIA GeForce RTX 4090");
    let other = facts_for("Apple M4 Max (mobile, low power)");
    assert_eq!(one, other, "two adapters differing only in names are the same facts");
    assert_eq!(classify(&one), classify(&other));
    assert_eq!(CalibrationKey::of(&one), CalibrationKey::of(&other));
    assert_eq!((one.vendor, one.device), (0x10de, 0x2684));
}

#[test]
fn calibration_is_skipped_without_timestamp_queries() {
    let without = DeviceFacts::new(TargetOs::Web, Backend::BrowserWebGpu, DeviceType::Other);
    assert!(!without.can_calibrate(), "Safari exposes no timestamp-query: static facts only");
    let with = DeviceFacts { features: Features::TIMESTAMP_QUERY, ..without };
    assert!(with.can_calibrate());
}

#[test]
fn the_calibration_cache_key_names_the_adapter_by_numbers() {
    let mac = mac_integrated();
    let key = CalibrationKey::of(&mac);
    assert_eq!(key, CalibrationKey::of(&mac.clone()));
    assert_ne!(key, CalibrationKey::of(&android_vulkan()));
    assert_ne!(key, CalibrationKey::of(&mac.clone().with_vendor(APPLE_VENDOR_ID, 7)), "the device id is part of the key");
    assert_eq!(key.wire(), "macos-metal-integrated-106b-0");
    let wire = CalibrationKey::of(&android_vulkan()).wire();
    assert!(wire.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'), "{wire}");
}

#[test]
fn the_calibration_kernels_validate_against_webgpu_core() {
    let module = naga::front::wgsl::parse_str(CALIBRATION_WGSL).expect("calibration WGSL parses");
    let mut validator = naga::valid::Validator::new(naga::valid::ValidationFlags::all(), naga::valid::Capabilities::empty());
    validator.validate(&module).expect("calibration WGSL validates with no capability beyond core");
    let entries: Vec<&str> = module.entry_points.iter().map(|entry| entry.name.as_str()).collect();
    assert_eq!(entries.len(), 3, "an ALU compute kernel and a fill vertex/fragment pair: {entries:?}");
}

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
fn metal_calibration_finishes_within_its_gpu_budget_and_classifies_the_mac() -> Result<(), RenderError> {
    let Some(gpu) = gpu() else { return Ok(()) };
    let facts = gpu.device_facts().clone();
    assert!(facts.can_calibrate(), "the Mac offers timestamp-query");
    let Some(calibration) = calibrate_blocking(&gpu)? else { panic!("timestamps were offered but calibration was skipped") };
    let level = ScoreLevel::quantize(calibration.score(), None);
    let class = classify_calibrated(&facts, Some(level));
    println!(
        "calibration: alu {:.0} GFLOP/s, fill {:.1} Gpix/s, score {:.0}, level {}, gpu {:.2} ms in {} rounds, class {} (key {})",
        calibration.alu_gflops,
        calibration.fill_gpix,
        calibration.score(),
        level.get(),
        calibration.gpu_ms,
        calibration.rounds,
        class.wire(),
        CalibrationKey::of(&facts).wire()
    );
    assert!(calibration.gpu_ms <= CALIBRATION_GPU_BUDGET_MS, "{:.2} ms of GPU time", calibration.gpu_ms);
    assert!(calibration.alu_gflops > 0.0 && calibration.fill_gpix > 0.0);
    if std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1") {
        assert!(
            class == DeviceClass::new(FormFactor::Desktop, PerformanceTier::High)
                || class == DeviceClass::new(FormFactor::Desktop, PerformanceTier::Ultra),
            "the M4 Max is desktop-high or desktop-ultra, not {}",
            class.wire()
        );
    }
    Ok(())
}

/// Owner decision 2026-10-12 (2): the adapter probe reads Metal's recommended working set, and the
/// Mac's desktop budget is max(class default, min(an eighth of it, 2 GiB)).
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_probe_reads_the_macs_gpu_visible_memory_and_its_budget_grows_with_it() {
    use genex_render::presets::{DESKTOP_BUDGET_MEMORY_CAP_BYTES, DESKTOP_BUDGET_MEMORY_DIVISOR, class_budget_bytes, class_defaults};
    let Some(gpu) = gpu() else { return };
    let facts = gpu.device_facts().clone();
    if facts.os != TargetOs::MacOs {
        eprintln!("skipped: not a Mac");
        return;
    }
    let bytes = facts.gpu_visible_memory_bytes.expect("Metal reports recommendedMaxWorkingSetSize");
    assert!(bytes >= 1 << 30, "a Mac's GPU sees at least 1 GiB: {bytes}");
    let class = classify(&facts);
    let budget = class_budget_bytes(class, &facts);
    let expected = class_defaults(class).budget_bytes.max((bytes / DESKTOP_BUDGET_MEMORY_DIVISOR).min(DESKTOP_BUDGET_MEMORY_CAP_BYTES));
    println!("gpu-visible memory {bytes} B ({:.1} GiB), class {}, budget {} MiB", bytes as f64 / f64::from(1u32 << 30), class.wire(), budget >> 20);
    assert_eq!(budget, expected);
}
