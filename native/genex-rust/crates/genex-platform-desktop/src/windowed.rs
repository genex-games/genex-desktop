//! The windowed loop: winit 0.30's `EventLoop` and `ApplicationHandler`, translated into
//! [`ShellEvent`]s for [`ShellCore`]. The window is created in `resumed` and dropped in
//! `suspended`; input is sampled per redraw through the letterbox, gamepads are polled per redraw
//! when the run's policy allows them, and the game's pointer-lock wish is applied before each
//! frame.
//!
//! Frames are paced at the sim rate (RQ0.12): the loop asks for a redraw only once the frame time
//! it would hand the game is worth a 60 Hz tick ([`TickWake`], a mirror of the runtime's
//! [`FrameClock`] fed the same frame times) and sleeps until then (`ControlFlow::WaitUntil`), so a
//! 120 or 144 Hz display neither runs the game's frame nor presents between ticks; the window
//! keeps its last picture. The first frame, a resize and a resume draw at once.

use crate::core::{FrameControl, ShellCore, ShellEvent, ShellGame};
use crate::gamepad::{GamepadPolicy, Gamepads};
use crate::headless::{ShellClock, ShellExit, SystemClock};
use crate::letterbox::Letterbox;
use crate::mode::windows_forbidden_here;
use crate::sample::InputSampler;
use crate::surface::ShellSurface;
use genex_core::clock::FrameClock;
use std::fmt;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use winit::application::ApplicationHandler;
use winit::dpi::LogicalSize;
use winit::event::{DeviceEvent, DeviceId, Ime, WindowEvent};
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop};
use winit::keyboard::PhysicalKey;
use winit::window::{CursorGrabMode, Window, WindowId};

/// What a refusal says beside its code.
struct Message {
    window_refused: &'static str,
}

const MESSAGE: Message = Message {
    window_refused: "GENEX_NO_WINDOW=1 forbids this process a window (a cargo test or bench run): \
                     run it headless (--headless or GENEX_HEADLESS=1)",
};

/// Set once this process created a winit EventLoop; a headless run never does.
static EVENT_LOOP_CREATED: AtomicBool = AtomicBool::new(false);

/// Whether this process ever created a winit EventLoop.
pub fn event_loop_created() -> bool {
    EVENT_LOOP_CREATED.load(Ordering::SeqCst)
}

/// Why the windowed shell could not run.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum ShellErrorCode {
    /// winit could not create or run its event loop (no window server, not the main thread).
    EventLoopFailed,
    /// The window could not be created.
    WindowFailed,
    /// This process may not open a window (`GENEX_NO_WINDOW=1`: a test or bench run).
    WindowRefused,
}

impl ShellErrorCode {
    /// The typed code's wire spelling.
    pub const fn as_str(self) -> &'static str {
        match self {
            ShellErrorCode::EventLoopFailed => "event-loop-failed",
            ShellErrorCode::WindowFailed => "window-failed",
            ShellErrorCode::WindowRefused => "window-refused",
        }
    }
}

/// A shell failure: the typed code and what winit said.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShellError {
    code: ShellErrorCode,
    detail: String,
}

impl ShellError {
    fn new(code: ShellErrorCode, detail: impl fmt::Display) -> ShellError {
        ShellError { code, detail: detail.to_string() }
    }

    /// The typed code.
    pub fn code(&self) -> ShellErrorCode {
        self.code
    }
}

impl fmt::Display for ShellError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.detail)
    }
}

impl std::error::Error for ShellError {}

/// Bounds for a windowed run.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct WindowedOptions {
    /// Close after this many frames (spikes and smoke tests); `None` runs until closed.
    pub max_frames: Option<u64>,
    /// Whether real gamepads are read (off by default; [`GamepadPolicy::for_run`] decides).
    pub gamepads: GamepadPolicy,
}

struct WindowedApp<G> {
    core: ShellCore<G>,
    window: Option<Arc<Window>>,
    sampler: InputSampler,
    gamepads: Gamepads,
    pointer_locked: bool,
    clock: SystemClock,
    last_ms: Option<f64>,
    /// When the next frame carries a tick.
    wake: TickWake,
    /// The next redraw runs a frame whether or not a tick is due (a resize, a new window).
    forced: bool,
    frames: u64,
    options: WindowedOptions,
    error: Option<ShellError>,
}

impl<G: ShellGame> WindowedApp<G> {
    fn open_window(&mut self, event_loop: &ActiveEventLoop) {
        let [width, height] = self.core.game().world_size();
        let attributes = Window::default_attributes()
            .with_title(self.core.game().title())
            .with_inner_size(LogicalSize::new(width, height));
        match event_loop.create_window(attributes) {
            Ok(window) => {
                let window = Arc::new(window);
                self.core.handle(ShellEvent::Resumed(ShellSurface::new(Arc::clone(&window))));
                window.request_redraw();
                self.window = Some(window);
            }
            Err(error) => {
                self.error = Some(ShellError::new(ShellErrorCode::WindowFailed, error));
                event_loop.exit();
            }
        }
    }

    /// Lock or free the pointer as the game asks; the sample reports what the window granted.
    fn apply_pointer_lock(&mut self) {
        let Some(window) = self.window.as_ref() else { return };
        let wanted = self.core.game().pointer_lock();
        if wanted != self.pointer_locked {
            self.pointer_locked = wanted && lock_pointer(window);
            if !wanted {
                free_pointer(window);
            }
        }
        self.sampler.set_pointer_lock(self.pointer_locked);
    }

    fn redraw(&mut self, event_loop: &ActiveEventLoop) {
        // winit delivers redraws already queued after `exit`; a bounded run stops at its count.
        if event_loop.exiting() {
            return;
        }
        let now = self.clock.now_ms();
        let frame_ms = self.last_ms.map_or(0.0, |last| now - last);
        let forced = std::mem::take(&mut self.forced) || self.last_ms.is_none();
        // A refresh between two ticks (the system's own redraw on a fast display): the window
        // keeps its last picture and the time carries to the next frame.
        if !forced && !self.wake.due(frame_ms) {
            return;
        }
        self.apply_pointer_lock();
        let Some(window) = self.window.as_ref() else { return };
        let size = window.inner_size();
        let letterbox = Letterbox::fit([size.width as f32, size.height as f32], self.core.game().world_size());
        self.wake.ran(frame_ms);
        self.last_ms = Some(now);
        self.frames += 1;
        let mut sample = self.sampler.take(letterbox);
        sample.pads = self.gamepads.poll();
        let control = self.core.handle(ShellEvent::Redraw { sample, frame_ms });
        let done = self.options.max_frames.is_some_and(|max| self.frames >= max);
        if control == FrameControl::Exit || done {
            event_loop.exit();
        }
    }

    fn resized(&mut self) {
        self.forced = true;
        let Some(window) = self.window.as_ref() else { return };
        let size = window.inner_size();
        let event = ShellEvent::Resized { size: [size.width, size.height], scale: window.scale_factor() };
        self.core.handle(event);
    }
}

impl<G: ShellGame> ApplicationHandler for WindowedApp<G> {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.window.is_none() {
            self.open_window(event_loop);
        }
    }

    fn suspended(&mut self, _event_loop: &ActiveEventLoop) {
        self.core.handle(ShellEvent::Suspended);
        self.window = None;
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, _window: WindowId, event: WindowEvent) {
        match event {
            WindowEvent::CloseRequested => {
                if self.core.handle(ShellEvent::CloseRequested) == FrameControl::Exit {
                    event_loop.exit();
                }
            }
            WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. } => self.resized(),
            WindowEvent::Focused(focused) => {
                if !focused {
                    self.sampler.focus_lost();
                    // The OS drops a grab with focus; ask again on the next frame.
                    self.pointer_locked = false;
                }
                self.core.handle(ShellEvent::Focus(focused));
            }
            WindowEvent::KeyboardInput { event, .. } => {
                if let PhysicalKey::Code(code) = event.physical_key {
                    self.sampler.key(code, event.state);
                }
                if let (true, Some(text)) = (event.state.is_pressed(), event.text.as_deref()) {
                    self.sampler.text(text);
                }
            }
            WindowEvent::Ime(Ime::Commit(text)) => self.sampler.text(&text),
            WindowEvent::MouseInput { state, button, .. } => self.sampler.mouse_button(button, state),
            WindowEvent::CursorMoved { position, .. } => self.sampler.cursor_moved([position.x as f32, position.y as f32]),
            WindowEvent::MouseWheel { delta, .. } => self.sampler.wheel(delta),
            WindowEvent::RedrawRequested => self.redraw(event_loop),
            _ => {}
        }
    }

    fn device_event(&mut self, _event_loop: &ActiveEventLoop, _device: DeviceId, event: DeviceEvent) {
        if let DeviceEvent::MouseMotion { delta } = event {
            self.sampler.mouse_motion([delta.0 as f32, delta.1 as f32]);
        }
    }

    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        if event_loop.exiting() {
            return;
        }
        let Some(window) = self.window.as_ref() else { return };
        let wait_ms = match self.last_ms {
            Some(last) if !self.forced => self.wake.until_due_ms(self.clock.now_ms() - last),
            _ => 0.0,
        };
        if wait_ms > 0.0 {
            event_loop.set_control_flow(ControlFlow::WaitUntil(Instant::now() + Duration::from_secs_f64(wait_ms / 1000.0)));
            return;
        }
        event_loop.set_control_flow(ControlFlow::Poll);
        window.request_redraw();
    }
}

/// When the next frame is worth drawing (module docs): a mirror of the runtime's live
/// [`FrameClock`], fed the same frame times the shell hands the game, so a frame is asked for only
/// once it carries a tick. A mirror that drifts (the runtime reset its clock on a seed) costs at
/// most one repeat frame, which the game re-presents.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct TickWake {
    clock: FrameClock,
}

impl TickWake {
    /// Whether a frame `frame_ms` after the last one runs at least one tick.
    fn due(&self, frame_ms: f64) -> bool {
        let mut probe = self.clock;
        probe.advance(frame_ms) > 0
    }

    /// The frame of `frame_ms` was handed to the game.
    fn ran(&mut self, frame_ms: f64) {
        self.clock.advance(frame_ms);
    }

    /// Milliseconds still to wait, `elapsed_ms` after the last frame, until the next one carries a
    /// tick (0 once it does).
    fn until_due_ms(&self, elapsed_ms: f64) -> f64 {
        if self.due(elapsed_ms) {
            return 0.0;
        }
        (self.clock.step_ms() - self.clock.carry() - elapsed_ms).max(0.0)
    }
}

/// Lock the pointer: macOS offers only `Locked`, Windows only `Confined`, X11 and Wayland either.
fn lock_pointer(window: &Window) -> bool {
    let grabbed = window
        .set_cursor_grab(CursorGrabMode::Locked)
        .or_else(|_| window.set_cursor_grab(CursorGrabMode::Confined));
    if grabbed.is_ok() {
        window.set_cursor_visible(false);
    }
    grabbed.is_ok()
}

fn free_pointer(window: &Window) {
    // Freeing an ungrabbed pointer is harmless; nothing to report.
    let _ = window.set_cursor_grab(CursorGrabMode::None);
    window.set_cursor_visible(true);
}

/// Run `game` in a window until it exits, the window closes or `options.max_frames` frames ran.
/// Creates winit's EventLoop, so it must run on the main thread (macOS requires it). Refused
/// `window-refused`, before any EventLoop exists, when the process is marked `GENEX_NO_WINDOW=1`.
pub fn run_windowed<G: ShellGame>(game: G, options: WindowedOptions) -> Result<(G, ShellExit), ShellError> {
    if windows_forbidden_here() {
        return Err(ShellError::new(ShellErrorCode::WindowRefused, MESSAGE.window_refused));
    }
    EVENT_LOOP_CREATED.store(true, Ordering::SeqCst);
    let event_loop = EventLoop::new().map_err(|error| ShellError::new(ShellErrorCode::EventLoopFailed, error))?;
    // The first frame draws at once; from then on `about_to_wait` sleeps until the next tick.
    event_loop.set_control_flow(ControlFlow::Poll);
    let mut app = WindowedApp {
        core: ShellCore::new(game),
        window: None,
        sampler: InputSampler::default(),
        gamepads: Gamepads::open(options.gamepads),
        pointer_locked: false,
        clock: SystemClock::new(),
        last_ms: None,
        wake: TickWake::default(),
        forced: true,
        frames: 0,
        options,
        error: None,
    };
    let ran = event_loop.run_app(&mut app);
    ran.map_err(|error| ShellError::new(ShellErrorCode::EventLoopFailed, error))?;
    if let Some(error) = app.error {
        return Err(error);
    }
    let exit = ShellExit { frames: app.frames };
    // The window goes before the game, so the game's surface outlives no window.
    app.window = None;
    Ok((app.core.into_game(), exit))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Frames a display of `hz` hands the game in one second, and the ticks they are worth: each
    /// refresh asks the wake whether it is due, as `redraw` does.
    fn one_second(hz: f64) -> (u32, u32) {
        let (mut wake, mut runtime) = (TickWake::default(), FrameClock::default());
        let (mut frames, mut ticks, mut last) = (0, 0, 0.0);
        for refresh in 1..=(hz as u32) {
            let now = f64::from(refresh) * 1000.0 / hz;
            if !wake.due(now - last) {
                continue;
            }
            wake.ran(now - last);
            ticks += runtime.advance(now - last);
            frames += 1;
            last = now;
        }
        (frames, ticks)
    }

    #[test]
    fn a_fast_display_runs_one_frame_per_tick() {
        for hz in [60.0, 120.0, 144.0, 240.0] {
            let (frames, ticks) = one_second(hz);
            assert!((59..=60).contains(&ticks), "{hz} Hz runs the sim at 60 Hz ({ticks})");
            assert_eq!(frames, ticks, "{hz} Hz: every frame handed to the game carries exactly one tick");
        }
    }

    #[test]
    fn a_slow_display_draws_every_refresh() {
        let (frames, ticks) = one_second(30.0);
        assert_eq!(frames, 30);
        assert_eq!(ticks, 60, "two ticks a frame");
    }

    #[test]
    fn the_wait_ends_when_the_next_tick_is_due() {
        let mut wake = TickWake::default();
        wake.ran(1000.0 / 60.0 + 4.0);
        let wait = wake.until_due_ms(2.0);
        assert!((wait - (1000.0 / 60.0 - 6.0)).abs() < 1e-9, "{wait}");
        assert!(wake.due(2.0 + wait));
        assert_eq!(wake.until_due_ms(20.0), 0.0);
    }
}
