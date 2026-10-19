//! iOS shell: lifecycle, touch, safe area, audio session.
//!
//! The phone shell itself is [`mobile`], which genex-platform-android re-exports; this crate adds
//! iOS's own parts:
//!
//! - [`run`]: the `.app` entry (`examples/pond_ios.rs`; packaged by
//!   `scripts/spike/rust-wgpu/ios-app.sh` until M5.1), with records under the app's Documents.
//! - [`window_safe_area`]: notch, Dynamic Island and home-indicator insets from winit's inner
//!   rectangle.
//! - [`audio_session`]: the ambient `AVAudioSession` (follows the silent switch, mixes with other
//!   apps), active while the app is resumed, and its interruptions.
//! - [`game_controller`]: `GCController` extended gamepads, mapped onto the standard order.
//! - [`thermal_state`]: `NSProcessInfo`'s thermal state, which paces frames when the phone is hot.
//! - [`refusal_layer`]: the designed refusal screen for a GPU below WebGPU core (the Simulator's
//!   Metal), laid over the window's view as a CoreGraphics image, drawn without wgpu.
//! - the soft keyboard is winit's own `UIKeyInput` view (`set_ime_allowed`), read by the shell.
//!
//! The lane builds it for `aarch64-apple-ios` and `aarch64-apple-ios-sim` with
//! `IPHONEOS_DEPLOYMENT_TARGET=16.0` (`src/main/rust-build-mobile.ts`). Nothing here launches a
//! Simulator or a device: that is the person's step (containment stage 1).
// The audio session, GCController, the thermal state and the refusal screen's layer are reached
// through the Objective-C runtime and CoreGraphics, on iOS only.
#![cfg_attr(target_os = "ios", allow(unsafe_code))]

pub mod audio_session;
pub mod game_controller;
pub mod mobile;
pub mod refusal_layer;
pub mod thermal_state;

pub use mobile::admit::{Admission, ShellAdapter, admit};
pub use mobile::audio::{AudioChange, AudioGate, AudioPlatform, Focus};
pub use mobile::gamepad::{AxisTarget, PadChange, PhoneAxis, PhoneButton, PhonePads};
pub use mobile::lifecycle::{Lifecycle, LifecycleCode, LifecycleError, Phase};
pub use mobile::orientation::{Orientation, RotationWatch, world_fill};
pub use mobile::present::{Presentation, SafePresenter};
pub use mobile::records::Records;
pub use mobile::refusal::{PixelLayout, RefusalImage};
pub use mobile::safe_area::SafeArea;
pub use mobile::shell::{PlatformHooks, ShellConfig, ShellOutcome};
pub use mobile::thermal::{Pacer, Thermal, ThermalWatch};
pub use mobile::touch::{TouchEvent, TouchTracker};

use genex::{Game, Runtime};
use genex_platform_web::AssetTable;
use std::path::PathBuf;
use winit::event_loop::EventLoop;
use winit::window::Window;

/// Pinned re-export, for the platform glue.
pub use winit;

/// The platform suffix in record names (`pond-600-seed1-cast.ios.json`).
pub const PLATFORM: &str = "ios";

/// iOS's platform hooks: GCController pads, the thermal state, the display link's refresh interval
/// and the refusal screen laid over the
/// window's view without wgpu ([`refusal_layer`]). Gamepad buttons never arrive as key events. iOS 16
/// devices are WebGPU-class, so on a phone the check is expected to pass (it still runs); the
/// Simulator's Metal is below core, so a Simulator run shows the refusal screen.
pub const IOS_HOOKS: PlatformHooks = PlatformHooks {
    pads: game_controller::poll,
    pad_key: |_| None,
    thermal: thermal_state::read,
    refresh_ms: mobile::shell::display_link_refresh_ms,
    refusal_screen: Some(refusal_layer::draw),
};

/// The app's Documents folder: `$HOME/Documents` (iOS sets HOME to the app's data container).
pub fn documents_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    let home = PathBuf::from(home);
    home.is_absolute().then(|| home.join("Documents"))
}

/// The safe area winit reports on iOS: the window's inner rectangle inside its outer one.
pub fn window_safe_area(window: &Window) -> SafeArea {
    let outer = window.outer_size();
    let inner = window.inner_size();
    let origin = window.inner_position().map(|p| (p.x, p.y)).unwrap_or((0, 0));
    SafeArea::from_inner((outer.width, outer.height), origin, (inner.width, inner.height))
}

/// A one-line stderr logger (Xcode's console shows stderr), installed once.
struct StderrLogger;

impl log::Log for StderrLogger {
    fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
        metadata.level() <= log::Level::Info
    }

    fn log(&self, record: &log::Record<'_>) {
        if self.enabled(record.metadata()) {
            eprintln!("genex-ios {} {}", record.level(), record.args());
        }
    }

    fn flush(&self) {}
}

static LOGGER: StderrLogger = StderrLogger;

/// Run `game` as the app: install the logger, build the runtime, then the winit loop with the
/// self-test of `demo` and records under Documents. Answers how it ended (on iOS it never
/// returns: UIKit owns the process).
pub fn run<W: Default + 'static>(name: &'static str, game: Game<W>, demo: &str, assets: AssetTable) -> ShellOutcome {
    if log::set_logger(&LOGGER).is_ok() {
        log::set_max_level(log::LevelFilter::Info);
    }
    let records = documents_dir().map(|dir| Records::new(&dir, PLATFORM));
    // The sim reads the compiled table from its first reset on, as the presenter draws from it.
    let runtime = match Runtime::with_assets(game, Box::new(assets)) {
        Ok(runtime) => runtime,
        Err(error) => {
            log::error!("{error}");
            return ShellOutcome::Failed("install-failed", error.to_string());
        }
    };
    let event_loop = match EventLoop::new() {
        Ok(event_loop) => event_loop,
        Err(error) => return ShellOutcome::Failed("event-loop-failed", error.to_string()),
    };
    let config = ShellConfig {
        game: name,
        plan: mobile::selftest::device_plan(name, demo),
        assets,
        records,
        safe_area: window_safe_area,
        audio: audio_session::PLATFORM_AUDIO,
        hooks: IOS_HOOKS,
    };
    mobile::shell::run_on(event_loop, Box::new(runtime), config)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_refused_gpu_shows_the_designed_refusal_screen_on_ios_instead_of_exiting_to_a_black_window() {
        // Below WebGPU core (the Simulator's Metal), `None` made the shell exit after the record and
        // left the window black (seen in a rust-mobile CI run).
        assert!(IOS_HOOKS.refusal_screen.is_some(), "iOS draws the refusal screen, as Android does");
    }

    #[test]
    fn the_documents_folder_is_home_documents() {
        if let Some(dir) = documents_dir() {
            assert!(dir.ends_with("Documents"));
            assert!(dir.is_absolute());
        }
    }
}
