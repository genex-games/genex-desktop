//! Lane UQ: upscaling modes as players know them (Native, Quality, Balanced, Performance), each a
//! render scale of the window, and the default the calibration picks per device class and window
//! size: always an upscaling mode on a native desktop, never Native; phones and browsers keep the
//! class's own scale until a mode is chosen. Pure CPU tables.

use genex_render::device_class::{DeviceClass, FormFactor, PerformanceTier, TargetOs};
use genex_render::presets::{class_defaults, native_output_cap_px, reference_resolution, render_pixel_budget};
use genex_render::settings::RENDER_SCALE_MIN;
use genex_render::upscale::{CALIBRATED_MODES, UpscaleMode, calibrated_mode, calibrated_pixel_budget, calibrated_window_scale, output_scale};

fn class(wire: &str) -> DeviceClass {
    DeviceClass::from_wire(wire).unwrap_or_else(|| panic!("{wire} is a class"))
}

const MAC_PANEL: (u32, u32) = (3456, 2169);
const P1080: (u32, u32) = (1920, 1080);
const P1440: (u32, u32) = (2560, 1440);
const P4K: (u32, u32) = (3840, 2160);
const P5K: (u32, u32) = (5120, 2880);

fn pixels(size: (u32, u32)) -> u64 {
    u64::from(size.0) * u64::from(size.1)
}

#[test]
fn each_mode_is_its_share_of_the_window_a_side_on_the_scale_grid() {
    let scales: Vec<(UpscaleMode, f32)> = UpscaleMode::ALL.iter().map(|mode| (*mode, mode.scale())).collect();
    assert_eq!(
        scales,
        [(UpscaleMode::Native, 1.0), (UpscaleMode::Quality, 0.65625), (UpscaleMode::Balanced, 0.59375), (UpscaleMode::Performance, 0.5)],
        "67%, 58% and 50% a side, on the renderer's 1/32 grid"
    );
    for mode in UpscaleMode::ALL {
        assert_eq!(UpscaleMode::from_wire(mode.wire()), Some(mode));
        assert!(mode.scale() >= RENDER_SCALE_MIN, "{mode:?} stays above the floor TAA upscales from");
    }
    assert_eq!(UpscaleMode::ALL.map(UpscaleMode::wire), ["native", "quality", "balanced", "performance"]);
    assert_eq!(UpscaleMode::from_wire("ultra-performance"), None, "Ultra Performance is not offered (the upscale does not hold at a third)");
    assert_eq!(CALIBRATED_MODES, [UpscaleMode::Quality, UpscaleMode::Balanced, UpscaleMode::Performance]);
}

#[test]
fn the_calibration_picks_quality_balanced_or_performance_per_class_and_window_and_never_native() {
    let ultra = class("desktop-ultra");
    let high = class("desktop-high");
    let mid = class("desktop-mid");
    let low = class("desktop-low");
    let rows = [
        (ultra, P1080, UpscaleMode::Quality),
        (ultra, P1440, UpscaleMode::Quality),
        (ultra, MAC_PANEL, UpscaleMode::Quality),
        (ultra, P4K, UpscaleMode::Quality),
        (ultra, P5K, UpscaleMode::Performance),
        (high, MAC_PANEL, UpscaleMode::Quality),
        (high, P4K, UpscaleMode::Quality),
        (mid, P1080, UpscaleMode::Quality),
        (mid, P1440, UpscaleMode::Quality),
        (mid, MAC_PANEL, UpscaleMode::Performance),
        (mid, P4K, UpscaleMode::Performance),
        (low, P1080, UpscaleMode::Quality),
        (low, P1440, UpscaleMode::Balanced),
        (low, P4K, UpscaleMode::Performance),
    ];
    for (class, window, mode) in rows {
        for os in [TargetOs::MacOs, TargetOs::Windows, TargetOs::Linux] {
            assert_eq!(calibrated_mode(class, os, window), Some(mode), "{} at {window:?} on {os:?}", class.wire());
        }
    }
    // Even a tiny window on the strongest class upscales: Native is the person's or the game's call.
    for window in [(640, 360), (1280, 720), P1080] {
        for class in DeviceClass::ALL.into_iter().filter(|class| class.form == FormFactor::Desktop) {
            assert_ne!(calibrated_mode(class, TargetOs::MacOs, window), Some(UpscaleMode::Native), "{} at {window:?}", class.wire());
        }
    }
}

#[test]
fn the_calibrated_mode_renders_within_the_class_s_pixel_budget_where_one_fits() {
    for class in DeviceClass::ALL.into_iter().filter(|class| class.form == FormFactor::Desktop) {
        let budget = calibrated_pixel_budget(class);
        let nominal = class_defaults(class).nominal_scale;
        let expected = (render_pixel_budget(class) as f64 * f64::from(nominal) * f64::from(nominal)) as u64;
        assert_eq!(budget, expected, "{}: the reference pixels at the class's nominal scale", class.wire());
        for window in [P1080, P1440, MAC_PANEL, P4K, P5K, (6016, 3384)] {
            let mode = calibrated_mode(class, TargetOs::Windows, window).expect("a native desktop upscales");
            let scale = calibrated_window_scale(class, window);
            assert!(scale <= mode.scale(), "{} {window:?}: never above the mode's share", class.wire());
            let rendered = (f64::from(window.0) * f64::from(scale)) * (f64::from(window.1) * f64::from(scale));
            assert!(rendered <= budget as f64 * 1.0001, "{} {window:?}: {rendered} px over the {budget} px budget", class.wire());
        }
    }
    // Past the Performance mode's budget (a 6K panel) the default holds the budget, as lane UP did.
    let six_k = (6016, 3384);
    assert!(calibrated_window_scale(class("desktop-ultra"), six_k) < UpscaleMode::Performance.scale());
}

#[test]
fn phones_and_browsers_keep_their_class_scale_until_a_mode_is_chosen() {
    for class in DeviceClass::ALL {
        for os in [TargetOs::Ios, TargetOs::Android, TargetOs::Web] {
            assert_eq!(calibrated_mode(class, os, MAC_PANEL), None, "{} on {os:?}", class.wire());
        }
    }
    for class in DeviceClass::ALL.into_iter().filter(|class| class.form == FormFactor::Mobile) {
        assert_eq!(calibrated_mode(class, TargetOs::MacOs, P1080), None, "a phone class keeps its own scale on any destination");
    }
}

#[test]
fn a_mode_is_a_share_of_the_window_turned_into_a_share_of_the_output_it_draws() {
    // Where the output is the window (a TAA-upscaling desktop), the mode's share is the output's.
    for mode in UpscaleMode::ALL {
        assert_eq!(output_scale(mode.scale(), MAC_PANEL, MAC_PANEL), mode.scale(), "{mode:?}");
    }
    // Where the output is capped below the window (MSAA presets at the class's reference pixels, a
    // phone at its reference), the same share of the window is a larger share of the output, never
    // above 1: native at the cap.
    let capped = reference_resolution(class("desktop-mid"));
    assert_eq!(output_scale(UpscaleMode::Performance.scale(), capped, MAC_PANEL), 0.875, "0.5 of 3456 is 0.9 of 1920, on the grid below it");
    assert_eq!(output_scale(UpscaleMode::Quality.scale(), capped, MAC_PANEL), 1.0);
    assert_eq!(output_scale(UpscaleMode::Native.scale(), capped, MAC_PANEL), 1.0);
    assert_eq!(output_scale(0.3, (1000, 500), (1000, 500)), RENDER_SCALE_MIN, "never below the floor");
    // A 6K panel's output is capped at four times the budget: the budget's share of the panel is
    // the floor's share of that output.
    let ultra = class("desktop-ultra");
    let side = ((native_output_cap_px(ultra) as f64 / pixels((6016, 3384)) as f64).sqrt() * 6016.0) as u32;
    let output = (side, side * 3384 / 6016);
    let scale = output_scale(calibrated_window_scale(ultra, (6016, 3384)), output, (6016, 3384));
    assert!((RENDER_SCALE_MIN..=0.53125).contains(&scale), "{scale}");
}

#[test]
fn the_desktop_tiers_are_upscaled_on_every_native_destination_and_only_there() {
    let desktop = |tier| DeviceClass::new(FormFactor::Desktop, tier);
    for tier in PerformanceTier::ALL {
        assert!(calibrated_mode(desktop(tier), TargetOs::Linux, P1080).is_some());
        assert!(calibrated_mode(desktop(tier), TargetOs::Web, P1080).is_none(), "a desktop browser keeps its own scale");
    }
}
