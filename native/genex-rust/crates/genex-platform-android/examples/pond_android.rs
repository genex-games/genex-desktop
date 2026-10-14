//! The pond APK's `libmain.so` (M0a.16 spike; `scripts/spike/rust-wgpu/android-apk.sh` packages
//! it for both activity candidates): the pond on the Android shell, with its 600-tick self-test
//! written to the app's internal data folder on first launch.
// `android_main` is the symbol android-activity's glue calls; exporting it needs `no_mangle`.
#![cfg_attr(target_os = "android", allow(unsafe_code))]

/// The activity's main loop (android-activity calls it on its own thread).
#[cfg(target_os = "android")]
#[unsafe(no_mangle)]
fn android_main(app: genex_platform_android::winit::platform::android::activity::AndroidApp) {
    let outcome =
        genex_platform_android::run(app, pond_game::NAME, pond_game::game(), pond_game::DEFAULT_DEMO, pond_game::ASSETS);
    log::info!("pond: {outcome:?}");
}
