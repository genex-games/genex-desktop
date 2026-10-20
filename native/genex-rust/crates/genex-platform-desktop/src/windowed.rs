//! The windowed loop: winit 0.30's `EventLoop` and `ApplicationHandler`, translated into
//! [`ShellEvent`]s for [`ShellCore`]. The window is created in `resumed` and dropped in
//! `suspended`; input is sampled per redraw through the letterbox, gamepads are polled per redraw
//! when the run's policy allows them, and the game's pointer-lock wish is applied before each
//! frame.
//!
//! Frames are paced by the display ([`FrameSchedule`], review F2): a redraw is asked for every
//! refresh and the surface's Fifo present waits for the display, each frame feeds the game whole
//! refreshes of the monitor's rate, and the game draws the world only on frames that ticked
//! (RQ0.12): a 120 or 144 Hz display re-presents the last picture between ticks. The first frame,
//! a resize and a resume draw at once.

use crate::core::{FrameControl, ShellCore, ShellEvent, ShellGame};
use crate::gamepad::{GamepadPolicy, Gamepads};
use crate::headless::{ShellClock, ShellExit, SystemClock};
use crate::letterbox::Letterbox;
use crate::mode::windows_forbidden_here;
use crate::sample::InputSampler;
use crate::schedule::FrameSchedule;
use crate::surface::ShellSurface;
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
    /// When frames run and what they feed the game.
    schedule: FrameSchedule,
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
                self.schedule.set_refresh_ms(monitor_refresh_ms(&window));
                self.schedule.force();
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
        if self.window.is_none() {
            return;
        }
        // A redraw sooner than half a refresh after the last frame (a surface that does not wait
        // for the display) runs nothing; the time carries to the next frame.
        let Some(frame_ms) = self.schedule.redraw(self.clock.now_ms()) else { return };
        self.apply_pointer_lock();
        let Some(window) = self.window.as_ref() else { return };
        let size = window.inner_size();
        let letterbox = Letterbox::fit([size.width as f32, size.height as f32], self.core.game().world_size());
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
        self.schedule.force();
        let Some(window) = self.window.as_ref() else { return };
        // A window moved to another monitor reports a resize or a new scale; its rate may differ.
        self.schedule.set_refresh_ms(monitor_refresh_ms(window));
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
            WindowEvent::Moved(_) => {
                if let Some(window) = self.window.as_ref() {
                    self.schedule.set_refresh_ms(monitor_refresh_ms(window));
                }
            }
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
                    if event.state.is_pressed() {
                        self.sampler.learn_label(code, &event.logical_key);
                    }
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
        let wait_ms = self.schedule.wait_ms(self.clock.now_ms());
        if wait_ms > 0.0 {
            event_loop.set_control_flow(ControlFlow::WaitUntil(Instant::now() + Duration::from_secs_f64(wait_ms / 1000.0)));
            return;
        }
        event_loop.set_control_flow(ControlFlow::Poll);
        window.request_redraw();
    }
}

/// The refresh interval of the monitor `window` is on, in milliseconds, when winit reports one.
fn monitor_refresh_ms(window: &Window) -> Option<f64> {
    let millihertz = window.current_monitor()?.refresh_rate_millihertz()?;
    (millihertz > 0).then(|| 1_000_000.0 / f64::from(millihertz))
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
    // The first frame draws at once; from then on the display paces the redraws.
    event_loop.set_control_flow(ControlFlow::Poll);
    let mut app = WindowedApp {
        core: ShellCore::new(game),
        window: None,
        sampler: InputSampler::default(),
        gamepads: Gamepads::open(options.gamepads),
        pointer_locked: false,
        clock: SystemClock::new(),
        schedule: FrameSchedule::default(),
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
