//! Android shell (the activity is chosen in M0a.12): lifecycle, touch, safe area, audio focus, the refusal screen drawn without wgpu.
//!
//! The phone shell itself is genex-platform-ios's [`mobile`] module, re-exported here, so both
//! phones run one copy of the lifecycle rule, touches, safe-area presentation, audio gate, records
//! and self-test. This crate adds Android's own parts, for both activity candidates M0a.12 chooses
//! between: `native-activity` (android.app.NativeActivity plus the JNI bridge for what
//! NativeActivity does not hand over) and `game-activity` (GameActivity from the games-activity
//! 4.4.0 AAR, android-activity 0.6.1).
//!
//! - `run` (Android only): the entry `android_main` calls (a game's `libmain.so`, packaged by the
//!   lane's `src/substrate/android-package.ts`; the spike's `examples/pond_android.rs` by
//!   `scripts/spike/rust-wgpu/android-apk.sh`), with records under the app's `internal_data_path`.
//! - the safe area: the content rectangle inside the window, widened by the display cutout.
//! - the audio focus (`AudioManager.requestAudioFocus`), held while the app is resumed; a focus
//!   change while resumed is not heard yet (it needs a Java listener class: TODO(M5-F1)).
//! - [`gamepad`]: `KEYCODE_BUTTON_*` keys, each controller in its own slot, and the d-pad as
//!   arrows (and the `AXIS_*` table) mapped onto the standard order.
//! - [`thermal`]: the PowerManager's thermal status, which paces frames when the phone is hot.
//! - the refusal screen for a GPU below WebGPU core, blitted into the `ANativeWindow` on the CPU
//!   (`refusal_blit`, Android only).
//! - the soft keyboard: winit's `set_ime_allowed` shows the soft input; its keys reach the shell.
//!   NativeActivity has no `InputConnection` bridge, so composed, autocorrected and swipe text
//!   does not reach the game (TODO(M5-F1)).
//!
//! The lane builds it for `aarch64-linux-android` (API 29, 16 KB pages;
//! `src/main/rust-build-mobile.ts`). Nothing here starts an emulator or touches a device: that is
//! the person's step (containment stage 1).
// The JNI bridge wraps raw JavaVM and activity pointers from ndk-context (Android only).
#![cfg_attr(target_os = "android", allow(unsafe_code))]

#[cfg(all(feature = "native-activity", feature = "game-activity", target_os = "android"))]
compile_error!("choose one activity: `native-activity` (default) or `game-activity` with --no-default-features");

pub mod gamepad;
#[cfg(target_os = "android")]
pub mod jni_bridge;
#[cfg(target_os = "android")]
pub mod refusal_blit;
pub mod thermal;

pub use genex_platform_ios::mobile::{self, audio, lifecycle, present, records, safe_area, selftest, shell, touch};
pub use genex_platform_ios::{
    AudioChange, AudioGate, AudioPlatform, Lifecycle, LifecycleCode, LifecycleError, PadChange, Phase, PhoneAxis, PhoneButton,
    PlatformHooks, Presentation, Records, SafeArea, ShellConfig, ShellOutcome, Thermal, TouchEvent, TouchTracker,
};

/// Pinned re-export, for the platform glue (`winit::platform::android::activity::AndroidApp`).
pub use winit;

/// Which activity this build packages, as the lifecycle log and the APK name spell it.
pub const ACTIVITY: &str = if cfg!(feature = "game-activity") { "game-activity" } else { "native-activity" };

/// The platform suffix in record names (`pond-600-seed1-cast.android.json`).
pub const PLATFORM: &str = "android";

/// Android's platform hooks: gamepad buttons from key events, the thermal status, and on a device
/// the refusal screen blitted without wgpu. Pads are not polled (they arrive as events).
pub const ANDROID_HOOKS: PlatformHooks = PlatformHooks {
    pads: |_| {},
    pad_key: gamepad::pad_key,
    thermal: thermal::read,
    #[cfg(target_os = "android")]
    refusal_screen: Some(refusal_blit::draw),
    #[cfg(not(target_os = "android"))]
    refusal_screen: None,
};

#[cfg(target_os = "android")]
mod entry {
    use super::*;
    use genex::{Game, Runtime};
    use genex_platform_web::AssetTable;
    use winit::event_loop::EventLoop;
    use winit::platform::android::activity::AndroidApp;
    use winit::platform::android::{EventLoopBuilderExtAndroid, WindowExtAndroid};
    use winit::window::Window;

    /// The safe area: the content rectangle inside the window, widened by the display cutout the
    /// NativeActivity bridge reads (GameActivity already insets its content view).
    fn window_safe_area(window: &Window) -> SafeArea {
        let size = window.inner_size();
        let rect = window.content_rect();
        let content = SafeArea::from_inner(
            (size.width, size.height),
            (rect.left, rect.top),
            (u32::try_from(rect.right - rect.left).unwrap_or(0), u32::try_from(rect.bottom - rect.top).unwrap_or(0)),
        );
        #[cfg(feature = "native-activity")]
        let content = crate::jni_bridge::cutout_insets().map_or(content, |cutout| content.max(cutout));
        content
    }

    /// The audio focus, asked for on `resumed` and abandoned on `suspended`.
    const AUDIO_FOCUS: AudioPlatform = AudioPlatform {
        acquire: || crate::jni_bridge::request_audio_focus().unwrap_or(false),
        release: || {
            let _ = crate::jni_bridge::abandon_audio_focus();
        },
        // Focus changes while resumed need a Java listener (jni_bridge, TODO(M5-F1)).
        poll: || None,
    };

    /// Run `game` as the activity's main loop: logger, runtime, then the winit loop with the
    /// self-test of `demo` and records under the app's internal data folder.
    pub fn run<W: Default + 'static>(app: AndroidApp, name: &'static str, game: Game<W>, demo: &str, assets: AssetTable) -> ShellOutcome {
        android_logger::init_once(android_logger::Config::default().with_max_level(log::LevelFilter::Info).with_tag("genex"));
        let records = app.internal_data_path().map(|dir| Records::new(&dir, PLATFORM));
        if let Some(records) = &records {
            records.log_lifecycle(&genex::json!({ "event": "launched", "activity": ACTIVITY }));
        }
        let mut runtime = match Runtime::new(game) {
            Ok(runtime) => runtime,
            Err(error) => {
                log::error!("{error}");
                return ShellOutcome::Failed("install-failed", error.to_string());
            }
        };
        // Saves live in the activity's own internal data folder; without one the game has none.
        if let Some(data) = app.internal_data_path().as_deref().and_then(std::path::Path::to_str) {
            runtime.use_android_data(data);
        }
        let event_loop = match EventLoop::builder().with_android_app(app).build() {
            Ok(event_loop) => event_loop,
            Err(error) => return ShellOutcome::Failed("event-loop-failed", error.to_string()),
        };
        let config = ShellConfig {
            game: name,
            plan: selftest::device_plan(name, demo),
            assets,
            records,
            safe_area: window_safe_area,
            audio: AUDIO_FOCUS,
            hooks: ANDROID_HOOKS,
        };
        shell::run_on(event_loop, Box::new(runtime), config)
    }
}

#[cfg(target_os = "android")]
pub use entry::run;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_build_is_the_native_activity_candidate() {
        assert_eq!(ACTIVITY, if cfg!(feature = "game-activity") { "game-activity" } else { "native-activity" });
    }

    #[test]
    fn records_are_named_for_android() {
        let root = std::env::temp_dir().join(format!("genex-android-records-{}", std::process::id()));
        let records = Records::new(&root, PLATFORM);
        assert_eq!(records.self_test_path("pond", 600, 1, "cast"), root.join("genex-self-test/pond-600-seed1-cast.android.json"));
    }
}
