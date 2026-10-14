//! winit desktop shell: lifecycle, input sampling, gamepads, saves root; headless mode without an EventLoop.
//!
//! Q1 (plan "Open questions"): one binary serves both modes. [`ShellMode::select`] reads
//! `--headless` or `GENEX_HEADLESS=1` at run time; [`run_headless`] drives the game from a plain
//! loop and never touches winit (so it runs off the main thread, in a box with no window server),
//! while [`run_windowed`] owns the winit 0.30 `EventLoop`. With `GENEX_NO_WINDOW=1`
//! ([`NO_WINDOW_ENV`], set by rust-env for `cargo test` and `cargo bench`) a windowed run is
//! refused `window-refused` before any `EventLoop` exists. Both hand the game the same
//! [`ShellFrame`], so the runtime behind [`ShellGame`] has one code path.
//!
//! winit stays behind this shim: the runtime sees [`ShellEvent`]s, [`FrameSample`]s in the
//! protocol's key names and a [`ShellSurface`] it can give wgpu, never winit's own types, and a
//! surface exists only between `resumed` and `suspended` ([`ShellCore`]).
//!
//! Input past the keyboard: Mouse1 emulates one touch ([`MOUSE_TOUCH_ID`], [`SampledTouch`]) so
//! touch controls work with a mouse; gamepads come from gilrs mapped onto the standard order
//! ([`standard_button`], [`standard_axis`]) on exports only, because a Studio run reads pads only
//! from the host's `input` op ([`GamepadPolicy::for_run`]); a game may ask for pointer lock
//! ([`ShellGame::pointer_lock`]).
//!
//! The facade implements [`ShellGame`] for its runtime (genex's `desktop` module): run by a person,
//! `genex::install` calls [`run_with`] and genex-render presents on the [`ShellSurface`]. A studio
//! run is served headless on fd 3 by the facade itself; TODO(M2.4): a windowed studio run (the
//! shell with `studio` set, `front` and `visible` on its window). The facade converts
//! [`FrameSample`] into genex-core's sample (its merger is the golden-checked one); the saves root
//! is genex-core's.

mod core;
mod gamepad;
mod headless;
mod letterbox;
mod mode;
mod sample;
mod surface;
mod touch;
mod windowed;

pub use crate::core::{FrameControl, ShellCore, ShellEvent, ShellFrame, ShellGame};
pub use gamepad::{GamepadPolicy, Gamepads, PadEvent, PadSlots, standard_axis, standard_button};
pub use headless::{HEADLESS_FRAME_MS, HeadlessOptions, ShellClock, ShellExit, SystemClock, run_headless};
pub use letterbox::Letterbox;
pub use mode::{HEADLESS_ENV, HEADLESS_FLAG, NO_WINDOW_ENV, ShellMode, windows_forbidden, windows_forbidden_here};
pub use sample::{FrameSample, InputSampler, MAX_TEXT_CHARS, WHEEL_PIXELS_PER_NOTCH, key_name};
pub use surface::ShellSurface;
pub use touch::{MAX_TOUCH_STEPS, MOUSE_TOUCH_ID, SampledTouch, TouchPhase};
pub use windowed::{ShellError, ShellErrorCode, WindowedOptions, event_loop_created, run_windowed};

/// Pinned re-exports, for the shell's own event types in tests and the platform glue.
pub use gilrs;
pub use winit;

/// How a run is bounded and where its input comes from.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ShellOptions {
    /// Stop after this many frames (spikes and tests); `None` runs until the game exits.
    pub max_frames: Option<u64>,
    /// The run belongs to Studio: real gamepads stay off, pads come only from the host.
    pub studio: bool,
}

/// Run `game` in `mode` until it exits (or its window closes): the one entry point both modes
/// share. `max_frames` bounds a spike or test run. Outside Studio: an export reads real gamepads.
pub fn run<G: ShellGame + 'static>(game: G, mode: ShellMode, max_frames: Option<u64>) -> Result<(G, ShellExit), ShellError> {
    run_with(game, mode, ShellOptions { max_frames, studio: false })
}

/// [`run`] with every option.
pub fn run_with<G: ShellGame + 'static>(game: G, mode: ShellMode, options: ShellOptions) -> Result<(G, ShellExit), ShellError> {
    match mode {
        ShellMode::Headless => {
            let mut game = game;
            let exit = run_headless(&mut game, &mut SystemClock::new(), HeadlessOptions { max_frames: options.max_frames });
            Ok((game, exit))
        }
        ShellMode::Windowed => {
            let gamepads = GamepadPolicy::for_run(mode, options.studio);
            run_windowed(game, WindowedOptions { max_frames: options.max_frames, gamepads })
        }
    }
}
