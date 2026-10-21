//! The winit + wgpu loop both phone shells run. winit 0.30's `ApplicationHandler` drives it:
//!
//! - `resumed`: the window is created once; a wgpu surface is created for it (the
//!   [`Lifecycle`] refuses one outside `resumed`); the first time, the adapter for that surface is
//!   admitted against WebGPU core before any device exists ([`admit`]): below core, the typed
//!   `gpu-unsupported` record is written and the designed refusal screen is drawn without wgpu
//!   ([`PlatformHooks::refusal_screen`]: Android blits it, iOS lays it over the view; the
//!   `refusal-screen` event logs whether it shows, its code and its colours; when it cannot be drawn
//!   the loop exits), never a panic; otherwise the
//!   self-test runs once and live play starts. The device is opened with exactly the native-enhanced
//!   features the game declares; one the adapter lacks is refused `native-feature-missing` with a
//!   screen of its own. A device request that fails after the check is no verdict on the phone: the
//!   run fails with its typed code and no refusal screen. The platform's audio is asked for
//!   ([`AudioPlatform`]).
//! - `suspended`: the surface is dropped (the GPU and the game stay), the audio given back, and the
//!   soft keyboard counted as hidden (it comes back on resume while a text field has focus).
//! - the game is presented inside the safe area ([`Presentation`], [`SafePresenter`]), which is
//!   logged on every resize; a rotation is a resize (one world size in both orientations, Q5),
//!   logged with how much of the safe area the world fills ([`orientation`]); every finger reaches
//!   `ctx.touches` with its id ([`TouchTracker`]) through that same presentation.
//! - every drawn frame first takes in the platform's news: audio interruptions and focus
//!   ([`AudioGate`]), gamepads in the standard order ([`PhonePads`], one slot per key-event device),
//!   arrow keys (an Android d-pad's among them) as held keys, the soft keyboard's typing one batch
//!   per tick ([`ImeBridge`], [`TypingFeed`]); the thermal state paces the frames ([`Pacer`]) and,
//!   when serious or critical, holds the device class's sustained frame rate.
//! - the world is drawn by genex's one presenter (`genex::present::Presenter`), as native and web
//!   runs draw it: the device's facts are probed into a phone class, its preset and memory budget,
//!   dynamic resolution holds its frame time on the frame timer, the game's custom passes run
//!   inside the frame and its egui HUD is painted over the world target before it is presented.
//! - frames are paced at the sim rate (RQ0.12, [`FrameGate`]): the world is rendered only on a
//!   frame that ran a tick (or the first after a new surface, a resize or a rotation), and a repeat
//!   frame re-presents the last world target, so a 90 or 120 Hz panel never runs the renderer twice
//!   per tick; the display is asked for [`MOBILE_PREFERRED_HZ`] ([`preferred_rate`]: a display-link
//!   frame-rate range on iOS, `ANativeWindow_setFrameRate` on Android 11+), logged as a
//!   `frame-rate` event, and the frames rendered and repeated are logged on `suspended`.
//! - the first frame presented on each surface is logged (`frame-presented`, [`frame_presented_event`]):
//!   an admitted adapter is not a drawn frame, so a CI smoke waits for this one before it captures.
//!
//! The loop is plain winit + wgpu, so it builds and is linted on the host as well; `run` in
//! genex-platform-ios and genex-platform-android are the entries. Saves live under the platform's
//! root: the iOS app container's (from `HOME`), Android's activity data folder
//! (`Runtime::use_android_data`).
//!
//! [`orientation`]: crate::mobile::orientation

use crate::mobile::admit::{Admission, ShellAdapter, admit};
use crate::mobile::audio::{AudioGate, AudioPlatform, follow_gate};
use crate::mobile::frame_time::FrameTimes;
use crate::mobile::gamepad::{PadChange, PhoneButton, PhonePads, controller_id};
use crate::mobile::keyboard::{KeyNews, TypingFeed, key_news};
use crate::mobile::lifecycle::{Lifecycle, Phase};
use crate::mobile::orientation::{RotationWatch, world_fill};
use crate::mobile::present::{Presentation, SafePresenter};
use crate::mobile::records::Records;
use crate::mobile::recovery::{LossStep, Recovery};
use crate::mobile::refusal::{self, RefusalImage, RefusalLines, lines_for};
use crate::mobile::safe_area::SafeArea;
use crate::mobile::selftest::{self, run_and_record};
use crate::mobile::thermal::{Pacer, Thermal, ThermalWatch};
use crate::mobile::touch::{TouchEvent, TouchTracker};
use genex::present::Presenter;
use genex::{Input, json};
use genex_hud::{ImeBridge, KeyboardCall, LoadingLook, LoadingScreen, TextAction};
use genex_platform_web::selftest::SelfTestPlan;
use genex_platform_web::{AssetTable, GameHandle, MeshCache};
use genex_render::compile::{CompileTally, compile_tally};
use genex_render::gpu::core_instance;
use genex_render::pacing::{FrameAction, FrameGate, MOBILE_PREFERRED_HZ};
use genex_render::{Gpu, RenderCode, RenderError, UnsupportedReason};
use std::sync::Arc;
use std::time::{Duration, Instant};
use winit::application::ApplicationHandler;
use winit::event::{DeviceId, ElementState, Ime, KeyEvent, TouchPhase, WindowEvent};
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop};
use winit::keyboard::NativeKeyCode;
use winit::window::{Window, WindowId};

/// Frames presented in flight at most.
const MAX_FRAME_LATENCY: u32 = 2;
/// How often the platform's refresh report is read again (a vote or a power mode may change it).
const REFRESH_READ_EVERY: Duration = Duration::from_secs(1);

/// What only a platform knows, as plain functions so the shell stays one type on every phone.
#[derive(Clone, Copy, Debug)]
pub struct PlatformHooks {
    /// The platform's gamepads: append what changed since the last call (polled every frame).
    pub pads: fn(&mut Vec<(u64, PadChange)>),
    /// The gamepad button a key event the platform could not name is (Android's
    /// `KEYCODE_BUTTON_*`), if any.
    pub pad_key: fn(&NativeKeyCode) -> Option<PhoneButton>,
    /// The platform's thermal state, when it can say.
    pub thermal: fn() -> Option<Thermal>,
    /// The display's refresh interval in milliseconds, when the platform reports one (iOS's display
    /// link, Android's display); read at most once a second. None: the frames' own intervals are
    /// measured ([`FrameTimes`]).
    pub refresh_ms: fn() -> Option<f64>,
    /// Draw the refusal screen into the window without wgpu; answers whether it is showing (the
    /// loop then stays up to keep it on screen). `None`: the loop exits after the record.
    pub refusal_screen: Option<fn(&Window, &RefusalImage) -> bool>,
}

impl PlatformHooks {
    /// No platform news (host builds and tests).
    pub const NONE: PlatformHooks =
        PlatformHooks { pads: |_| {}, pad_key: |_| None, thermal: || None, refresh_ms: || None, refusal_screen: None };
}

/// What the shell runs.
pub struct ShellConfig {
    /// The game's name (window title and record names).
    pub game: &'static str,
    /// The self-test run once on the first GPU open.
    pub plan: SelfTestPlan,
    /// The game's compiled-in assets.
    pub assets: AssetTable,
    /// Where records go (`None`: nowhere to write, the self-test is skipped).
    pub records: Option<Records>,
    /// The platform's safe area for a window.
    pub safe_area: fn(&Window) -> SafeArea,
    /// The platform's audio session or focus.
    pub audio: AudioPlatform,
    /// The platform's gamepads, thermal state and refusal screen.
    pub hooks: PlatformHooks,
}

/// How a shell run ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ShellOutcome {
    /// The loop ended normally.
    Ran,
    /// The GPU is below WebGPU core or lacks a declared native-enhanced feature: the typed record
    /// was written (when there is a folder) and the refusal screen shown (code and detail).
    Refused(&'static str, String),
    /// The window or surface could not be created (typed code and detail).
    Failed(&'static str, String),
}

/// A live surface and its configuration.
struct Live {
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
}

/// The open GPU and genex's presenter on it: the renderer, the game's passes, the HUD painter and
/// the render settings Live frames draw with.
struct Device {
    presenter: Presenter,
}

impl Device {
    fn gpu(&self) -> &Gpu {
        self.presenter.gpu()
    }
}

/// A new device after a loss (review F4): the shell's own instance's high-performance adapter,
/// admitted against WebGPU core and the game's declared features as the first one was (any
/// surface the instance makes can present from it). A refusal leaves the device lost; the shell
/// tries again ([`Recovery`]).
fn reopen(instance: &wgpu::Instance) -> Result<Gpu, RenderError> {
    let declared = genex::gpu::declared_native_features()?;
    let options = wgpu::RequestAdapterOptions { power_preference: wgpu::PowerPreference::HighPerformance, ..Default::default() };
    let adapter = pollster::block_on(instance.request_adapter(&options))
        .map_err(|error| RenderError::refused(RenderCode::DeviceLost, format!("no adapter after the loss: {error}")))?;
    match admit(&ShellAdapter(adapter), declared) {
        Admission::Play(gpu) => Ok(gpu),
        Admission::RefusalScreen(error) | Admission::Failed(error) => Err(error),
    }
}

fn log_refusal(line: &str) {
    log::warn!("{line}");
}

/// Whether the platform's thermal state asks the class to hold its sustained frame rate.
fn thermal_load(state: Thermal) -> bool {
    matches!(state, Thermal::Serious | Thermal::Critical)
}

struct App {
    config: ShellConfig,
    game: Box<dyn GameHandle>,
    instance: wgpu::Instance,
    lifecycle: Lifecycle,
    touches: TouchTracker,
    audio: AudioGate,
    /// The audio device, opened the first time the gate lets the game be heard (AU-8).
    sound: genex::audio::Device,
    pads: PhonePads,
    pad_changes: Vec<(u64, PadChange)>,
    ime: ImeBridge,
    typing: TypingFeed,
    rotation: RotationWatch,
    thermal: ThermalWatch,
    pacer: Pacer,
    clock: Instant,
    /// The refusal screen showing (the refusal's code and the screen's lines): nothing else is drawn.
    refused: Option<(RenderCode, RefusalLines)>,
    presentation: Option<Presentation>,
    presenter: SafePresenter,
    meshes: MeshCache,
    window: Option<Arc<Window>>,
    device: Option<Device>,
    live: Option<Live>,
    /// What each display frame feeds the live clock: whole refreshes (review F2).
    frame_times: FrameTimes,
    /// When the platform's refresh report was last read.
    refresh_read: Option<Instant>,
    /// Which display frames render the world and which re-present it (RQ0.12).
    gate: FrameGate,
    /// The display's preferred-rate request, kept while it applies.
    rate_vote: Option<preferred_rate::Vote>,
    /// Whether the current surface has presented a rendered world yet (logged once per surface).
    presented: bool,
    /// When a lost device is re-created (review F4).
    recovery: Recovery,
    /// The loading screen while the boot's warm-up compiles the first frame's pipelines (D11).
    loading: Option<Loading>,
    outcome: ShellOutcome,
}

/// The loading screen a phone shows, its look, and the compile pool's counts when the boot began.
struct Loading {
    screen: LoadingScreen,
    look: LoadingLook,
    base: CompileTally,
}

/// A surface format the world target can be blitted to without a second gamma curve.
fn pick_format(formats: &[wgpu::TextureFormat]) -> Option<wgpu::TextureFormat> {
    let linear = [wgpu::TextureFormat::Bgra8Unorm, wgpu::TextureFormat::Rgba8Unorm];
    linear.into_iter().find(|f| formats.contains(f)).or_else(|| formats.first().copied())
}

/// The adapter for `surface`, admitted against WebGPU core and the game's declared native-enhanced
/// features before any device is created.
fn open_gpu(instance: &wgpu::Instance, surface: &wgpu::Surface<'static>) -> Admission<Gpu> {
    let declared = match genex::gpu::declared_native_features() {
        Ok(declared) => declared,
        Err(error) => return Admission::of_error(error),
    };
    let options = wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        compatible_surface: Some(surface),
        ..Default::default()
    };
    match pollster::block_on(instance.request_adapter(&options)) {
        Ok(adapter) => admit(&ShellAdapter(adapter), declared),
        Err(error) => {
            Admission::RefusalScreen(RenderError::GpuUnsupported { reason: UnsupportedReason::NoAdapter, detail: error.to_string() })
        }
    }
}

/// The lifecycle log's record of the refusal screen: whether it is showing, the typed code its last
/// line names (the refusal record's), the window it fills, and the sRGB colours it is drawn in, so
/// a capture can be checked to be this screen and not merely something other than black.
pub fn refusal_screen_event(code: RenderCode, shown: bool, window: (u32, u32)) -> serde_json::Value {
    let rgb = |[red, green, blue, _]: [u8; 4]| [red, green, blue];
    json!({
        "event": "refusal-screen",
        "shown": shown,
        "code": code.wire(),
        "window": [window.0, window.1],
        "background": rgb(refusal::BACKGROUND),
        "ink": rgb(refusal::INK),
        "codeInk": rgb(refusal::CODE_INK),
    })
}

/// The lifecycle log's record of the first frame presented on a surface: the world frames rendered
/// so far and the window it went to. An admitted adapter is not a drawn frame (in a CI run the
/// emulator's capture came before any frame), so a smoke captures after this one.
pub fn frame_presented_event(rendered: u64, window: (u32, u32)) -> serde_json::Value {
    json!({ "event": "frame-presented", "rendered": rendered, "window": [window.0, window.1] })
}

/// genex's presenter on an admitted GPU, its models from the game's compiled `assets`; after a
/// loss it opens a new device from `instance` ([`reopen`]).
fn device_on(gpu: Gpu, world: [u32; 2], assets: AssetTable, instance: &wgpu::Instance) -> Result<Device, RenderError> {
    let declared = genex::gpu::declared_native_features()?;
    let instance = instance.clone();
    let open = move || reopen(&instance);
    let presenter = Presenter::with_gpu(gpu, world, declared, Box::new(open), Box::new(assets), log_refusal)?;
    Ok(Device { presenter })
}

impl App {
    fn log(&self, event: serde_json::Value) {
        log::info!("{event}");
        if let Some(records) = &self.config.records {
            records.log_lifecycle(&event);
        }
    }

    fn fail(&mut self, event_loop: &ActiveEventLoop, code: &'static str, detail: String) {
        self.log(json!({ "event": "failed", "code": code, "detail": detail }));
        self.outcome = ShellOutcome::Failed(code, detail);
        event_loop.exit();
    }

    fn window(&mut self, event_loop: &ActiveEventLoop) -> Option<Arc<Window>> {
        if let Some(window) = &self.window {
            return Some(Arc::clone(window));
        }
        let attributes = Window::default_attributes().with_title(self.config.game);
        match event_loop.create_window(attributes) {
            Ok(window) => {
                let window = Arc::new(window);
                self.window = Some(Arc::clone(&window));
                Some(window)
            }
            Err(error) => {
                self.fail(event_loop, "window-failed", error.to_string());
                None
            }
        }
    }

    /// The GPU is below core or lacks a declared feature: write the typed record, show the refusal
    /// screen for its code (drawn without wgpu) or stop, never a panic. Any other error fails the
    /// run with its own code and no screen.
    fn refuse_gpu(&mut self, event_loop: &ActiveEventLoop, error: &RenderError) {
        let code = error.code().wire();
        let Some(lines) = lines_for(error.code()) else { return self.fail(event_loop, code, error.to_string()) };
        let path = self.config.records.as_ref().map(|records| records.write_gpu_unsupported(self.config.game, error));
        let written = match path {
            Some(Ok(path)) => path.display().to_string(),
            Some(Err(write)) => format!("not written: {write}"),
            None => "no records folder".to_owned(),
        };
        self.log(json!({ "event": "gpu-unsupported", "code": code, "detail": error.to_string(), "record": written }));
        self.outcome = ShellOutcome::Refused(code, error.to_string());
        self.refused = Some((error.code(), lines));
        if !self.show_refusal() {
            return event_loop.exit();
        }
        // The screen is still: nothing needs a frame until the platform resizes or resumes it.
        event_loop.set_control_flow(ControlFlow::Wait);
    }

    /// Draw the refusal screen into the window and log it ([`refusal_screen_event`], also when the
    /// platform has no way to draw it); answers whether it is showing.
    fn show_refusal(&mut self) -> bool {
        let (Some(window), Some((code, lines))) = (self.window.clone(), self.refused) else { return false };
        let size = window.inner_size();
        let shown = self.config.hooks.refusal_screen.is_some_and(|draw| {
            refusal::render(size.width, size.height, &lines).is_some_and(|image| draw(&window, &image))
        });
        self.log(refusal_screen_event(code, shown, (size.width, size.height)));
        shown
    }

    fn configure(&self, surface: &wgpu::Surface<'static>, window: &Window) -> Option<wgpu::SurfaceConfiguration> {
        let device = self.device.as_ref()?;
        let size = window.inner_size();
        if size.width == 0 || size.height == 0 {
            return None;
        }
        let adapter = device.gpu().adapter();
        let mut config = surface.get_default_config(adapter, size.width, size.height)?;
        let capabilities = surface.get_capabilities(adapter);
        config.format = pick_format(&capabilities.formats)?;
        // The safe-area copy lands in the surface texture (present.rs).
        if capabilities.usages.contains(wgpu::TextureUsages::COPY_DST) {
            config.usage |= wgpu::TextureUsages::COPY_DST;
        }
        config.present_mode = wgpu::PresentMode::Fifo;
        config.desired_maximum_frame_latency = MAX_FRAME_LATENCY;
        surface.configure(&device.gpu().device, &config);
        Some(config)
    }

    /// Install the game's custom passes, run the self-test once, then reseed and start live play.
    fn first_gpu_open(&mut self) {
        let Some(device) = self.device.as_mut() else { return };
        for (name, error) in self.game.install_passes(&mut device.presenter) {
            log::warn!("custom pass {name} refused: {error}");
        }
        if let Some(records) = &self.config.records {
            // The self-test's capture stays the plain scene `pond --self-test` renders (its digests compare).
            let (gpu, renderer) = device.presenter.resilient.parts_mut();
            let renderer = renderer.renderer_mut();
            let (meshes, assets) = (&mut self.meshes, self.config.assets);
            let outcome = run_and_record(self.game.as_mut(), &self.config.plan, records, |game| {
                selftest::gpu_capture(game, gpu, renderer, meshes, assets).map_err(|error| error.to_string())
            });
            let event = match outcome {
                Ok(path) => json!({ "event": "self-test", "record": path.display().to_string() }),
                Err(failure) => json!({ "event": "self-test-failed", "code": failure.code(), "detail": failure.to_string() }),
            };
            self.log(event);
        }
        let receipt = self.device.as_ref().map(|device| device.gpu().receipt().to_json()).unwrap_or_default();
        self.log(json!({ "event": "gpu", "receipt": receipt }));
        self.game.seed(self.config.plan.seed);
        self.game.start();
        self.gate.reset_history();
        self.begin_loading();
    }

    /// Warm the first frame's pipelines off the frame thread and show the loading screen until
    /// they are compiled, instead of a frozen first frame (renderer pass 2, owner decision D11).
    fn begin_loading(&mut self) {
        let Some(device) = self.device.as_mut() else { return };
        let base = compile_tally();
        device.presenter.set_off_thread_changes(true);
        self.game.warm_boot(&mut device.presenter);
        if device.presenter.boot_warming() {
            let look = genex::loading::look_from_build(&self.game.title());
            self.loading = Some(Loading { screen: LoadingScreen::new(), look, base });
            self.log(json!({ "event": "loading" }));
        }
    }

    /// Whether the loading screen is still up: painted and presented this frame when it is.
    fn loading_frame(&mut self, frame_ms: f64) -> bool {
        let warming = self.device.as_ref().is_some_and(|device| device.presenter.boot_warming());
        if !warming {
            if self.loading.take().is_some() {
                self.log(json!({ "event": "loaded" }));
            }
            return false;
        }
        let (Some(device), Some(live), Some(loading)) = (self.device.as_mut(), self.live.as_ref(), self.loading.as_mut()) else {
            return self.loading.is_some();
        };
        let texture = match live.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(texture) | wgpu::CurrentSurfaceTexture::Suboptimal(texture) => texture,
            _ => return true,
        };
        loading.screen.advance((frame_ms / 1000.0) as f32);
        let progress = genex::loading::compiling(compile_tally().since(loading.base));
        let view = texture.texture.create_view(&wgpu::TextureViewDescriptor::default());
        let size = [live.config.width, live.config.height];
        let ratio = self.window.as_ref().map_or(1.0, |window| window.scale_factor());
        let gpu = device.gpu();
        loading.screen.paint(&gpu.device, &gpu.queue, &view, live.config.format, size, genex_hud::pixels_per_point(ratio), &loading.look, &progress);
        gpu.queue.present(texture);
        true
    }

    /// Ask the display for [`MOBILE_PREFERRED_HZ`] (once per surface on Android, once per run on
    /// iOS) and log whether the platform took the request.
    fn request_preferred_rate(&mut self, window: &Window) {
        if cfg!(target_os = "ios") && self.rate_vote.is_some() {
            return;
        }
        self.rate_vote = preferred_rate::request(window, MOBILE_PREFERRED_HZ);
        self.log(json!({ "event": "frame-rate", "preferredHz": MOBILE_PREFERRED_HZ, "requested": self.rate_vote.is_some() }));
    }

    fn create_surface(&mut self, event_loop: &ActiveEventLoop, window: &Arc<Window>) {
        if let Err(refused) = self.lifecycle.surface_created() {
            self.log(json!({ "event": "surface-refused", "code": refused.code.wire() }));
            return;
        }
        let surface = match self.instance.create_surface(Arc::clone(window)) {
            Ok(surface) => surface,
            Err(error) => return self.fail(event_loop, "surface-failed", error.to_string()),
        };
        if self.device.is_none() {
            let opened = match open_gpu(&self.instance, &surface) {
                Admission::Play(gpu) => device_on(gpu, self.game.world_size(), self.config.assets, &self.instance),
                Admission::RefusalScreen(error) | Admission::Failed(error) => Err(error),
            };
            match opened {
                Ok(device) => {
                    self.device = Some(device);
                    self.first_gpu_open();
                }
                Err(error) => {
                    // The refused surface goes before the screen is drawn into the same window.
                    drop(surface);
                    self.lifecycle.surface_lost();
                    return self.refuse_gpu(event_loop, &error);
                }
            }
        }
        let config = self.configure(&surface, window);
        self.log(json!({ "event": "surface-created", "configured": config.is_some() }));
        self.live = config.map(|config| Live { surface, config });
        self.presented = false;
        if self.live.is_some() {
            self.request_preferred_rate(window);
        }
        // The new surface shows nothing yet: the next frame renders even without a tick.
        self.gate.mark_stale();
        self.present_in_safe_area(window);
        window.request_redraw();
    }

    /// Where the game is presented from now on: inside the safe area, or the whole window when the
    /// surface cannot take the safe-area copy (logged, and touches map the same way).
    fn present_in_safe_area(&mut self, window: &Window) {
        let size = window.inner_size();
        // A rotation is a resize: the same world, re-presented in the new safe area (Q5).
        if let Some(orientation) = self.rotation.observe((size.width, size.height)) {
            self.log(json!({ "event": "rotated", "orientation": orientation.wire(), "rotations": self.rotation.rotations() }));
        }
        let area = (self.config.safe_area)(window);
        let copyable = self.live.as_ref().is_some_and(|live| live.config.usage.contains(wgpu::TextureUsages::COPY_DST));
        let insets = if copyable { area } else { SafeArea::default() };
        let [width, height] = self.game.world_size();
        let presentation = Presentation::new((size.width, size.height), insets, (width, height));
        let view = presentation.viewport();
        self.presentation = Some(presentation);
        self.log(json!({
            "event": "safe-area",
            "window": [size.width, size.height],
            "insets": { "top": area.top, "left": area.left, "bottom": area.bottom, "right": area.right },
            "presentedInside": copyable || area.is_empty(),
            "viewport": [view.x, view.y, view.width, view.height],
            "orientation": self.rotation.current().map(|orientation| orientation.wire()),
            "worldFill": world_fill(&presentation),
        }));
    }

    fn resized(&mut self) {
        self.gate.mark_stale();
        let Some(window) = self.window.clone() else { return };
        if self.refused.is_some() {
            self.show_refusal();
            return;
        }
        if let Some(live) = self.live.take() {
            let config = self.configure(&live.surface, &window);
            self.live = config.map(|config| Live { surface: live.surface, config });
        }
        self.present_in_safe_area(&window);
    }

    fn touch(&mut self, id: u64, phase: TouchPhase, location: (f32, f32)) {
        let Some(presentation) = self.presentation else { return };
        let event = match phase {
            TouchPhase::Started => TouchEvent::Started,
            TouchPhase::Moved => TouchEvent::Moved,
            TouchPhase::Ended => TouchEvent::Ended,
            TouchPhase::Cancelled => TouchEvent::Cancelled,
        };
        if event == TouchEvent::Started {
            self.reopen_keyboard();
        }
        if let Some(input) = self.touches.handle(id, event, location, &presentation) {
            self.game.inject(input);
        }
    }

    /// A finger came down: with a text field focused, ask for the keyboard again (the person may
    /// have put it away with a key the shell never hears of).
    fn reopen_keyboard(&mut self) {
        let Some(call) = self.ime.touched(self.game.keyboard_wanted()) else { return };
        if let Some(window) = &self.window {
            window.set_ime_allowed(call == KeyboardCall::Show);
        }
    }

    /// A surface lost while resumed comes back from the same window.
    fn recreate_lost_surface(&mut self, event_loop: &ActiveEventLoop) {
        let lost_while_resumed = self.live.is_none() && self.lifecycle.phase() == Phase::Resumed;
        let Some(window) = self.window.clone().filter(|_| lost_while_resumed) else { return };
        self.create_surface(event_loop, &window);
    }

    /// Whether this redraw is drawn: the thermal state, read at most once a second, paces frames
    /// and tells the render settings whether to hold the class's sustained rate.
    fn paced(&mut self) -> bool {
        let elapsed = self.clock.elapsed();
        let now_ms = elapsed.as_secs_f64() * 1000.0;
        if self.thermal.poll(now_ms, self.config.hooks.thermal).is_some() {
            self.log(self.thermal.event());
        }
        let settings = self.device.as_ref().and_then(|device| device.presenter.render_settings().cloned());
        if let Some(settings) = settings {
            settings.borrow_mut().set_thermal(thermal_load(self.thermal.state()), elapsed);
        }
        self.pacer.should_draw(now_ms, self.thermal.state())
    }

    /// Take in what the platform reported since the last drawn frame: audio news and gamepads,
    /// injected for the next tick (the soft keyboard's typing goes through [`TypingFeed`]).
    fn take_platform_news(&mut self) {
        while let Some(change) = (self.config.audio.poll)() {
            if self.audio.changed(change, self.config.audio.acquire) {
                self.log(self.audio.event());
            }
        }
        // The output follows the gate; an open device's faults reach `volatile.audio.device`.
        follow_gate(&self.audio, self.game.as_mut(), &mut self.sound);
        (self.config.hooks.pads)(&mut self.pad_changes);
        for (pad, change) in self.pad_changes.drain(..) {
            self.pads.apply(pad, change);
        }
        if let Some(input) = self.pads.take_input() {
            self.game.inject(input);
        }
        self.sync_keyboard();
    }

    /// Raise or lower the soft keyboard as the HUD wants it (a text field has focus).
    fn sync_keyboard(&mut self) {
        let wanted = self.game.keyboard_wanted();
        let Some(call) = self.ime.sync(wanted) else { return };
        if let Some(window) = &self.window {
            window.set_ime_allowed(call == KeyboardCall::Show);
        }
        self.log(json!({ "event": "keyboard", "shown": call == KeyboardCall::Show }));
    }

    /// A key event from `device`: a gamepad button the platform delivers as a key (in that
    /// device's own slot), an arrow held or released, or the keyboard typing.
    fn key(&mut self, device: DeviceId, event: &KeyEvent) {
        let pressed = event.state == ElementState::Pressed;
        let news = key_news(&event.physical_key, &event.logical_key, event.text.as_deref(), pressed, self.config.hooks.pad_key);
        match news {
            Some(KeyNews::Pad(button, down)) => {
                self.pads.apply(controller_id(&device), PadChange::Button(button, f32::from(u8::from(down))));
            }
            Some(KeyNews::Arrow(arrow, true)) => {
                self.game.inject(Input::key_down(arrow));
            }
            Some(KeyNews::Arrow(arrow, false)) => {
                self.game.inject(Input::key_up(arrow));
            }
            Some(KeyNews::Typed(action)) => self.ime.push(action),
            None => {}
        }
    }

    fn redraw(&mut self) {
        if self.refused.is_some() || !self.paced() {
            return;
        }
        self.take_platform_news();
        let now = Instant::now();
        self.read_refresh(now);
        let frame = self.frame_times.frame(now);
        // Until the warm-up compiled the first frame's pipelines the phone shows the loading
        // screen: the game neither ticks nor draws, so nothing of it runs unseen.
        if self.loading.is_some() && self.loading_frame(frame.display_ms) {
            return;
        }
        // Dynamic resolution reads display intervals, drawn or not (tickless frames are re-presented).
        if let Some(device) = self.device.as_mut() {
            device.presenter.note_display_frame(frame.display_ms);
        }
        let ticks = self.typing.live_frame(&mut self.ime, self.game.as_mut(), frame.fed_ms);
        if !self.device_usable() {
            return;
        }
        let presentable = self.device.is_some() && self.live.is_some() && self.presentation.is_some();
        if !presentable {
            return;
        }
        // A frame without a tick shows the last world target again: no graph, one blit.
        if self.gate.frame(ticks) == FrameAction::Render && !self.render_world() {
            return;
        }
        self.present();
    }

    /// Whether the device can draw this frame. A lost one is re-created ([`Recovery`]: at once,
    /// then once a second): the game keeps its state, every upload is replayed, and the surface is
    /// made again on the new device from the next redraw; until then nothing is drawn or presented.
    fn device_usable(&mut self) -> bool {
        let Some(lost) = self.device.as_ref().map(|device| device.presenter.resilient.is_lost()) else { return true };
        let now_ms = self.clock.elapsed().as_secs_f64() * 1000.0;
        match self.recovery.step(lost, now_ms) {
            LossStep::Healthy => return true,
            LossStep::Wait => return false,
            LossStep::Recover => {}
        }
        if self.recovery.tries() == 1 {
            self.log(json!({ "event": "device-lost" }));
        }
        let Some(device) = self.device.as_mut() else { return true };
        match self.game.recover(&mut device.presenter) {
            Ok(true) => {
                self.log(json!({ "event": "device-recovered", "tries": self.recovery.tries() }));
                self.recovery.recovered();
                // The surface, its configuration and the safe-area copy were made on the lost device.
                self.live = None;
                self.presenter = SafePresenter::default();
                self.gate.mark_stale();
                if let Some(window) = &self.window {
                    window.request_redraw();
                }
            }
            Ok(false) => {}
            Err(error) => {
                self.log(json!({ "event": "device-recover-failed", "code": error.code().wire(), "tries": self.recovery.tries() }));
            }
        }
        false
    }

    /// Read the platform's refresh report again when a second has passed (or none was read yet).
    fn read_refresh(&mut self, now: Instant) {
        if self.refresh_read.is_some_and(|at| now.duration_since(at) < REFRESH_READ_EVERY) {
            return;
        }
        self.refresh_read = Some(now);
        self.frame_times.set_refresh_ms((self.config.hooks.refresh_ms)());
    }

    /// Render the game's view into the world target through the presenter (a Live frame: the
    /// class's preset at dynamic resolution's scale, timed, the custom passes and the HUD drawn);
    /// answers whether it was drawn.
    fn render_world(&mut self) -> bool {
        let Some(device) = self.device.as_mut() else { return false };
        match self.game.draw(&mut device.presenter, None) {
            Some(Ok(_)) => true,
            Some(Err(error)) => {
                log::warn!("frame not rendered: {error}");
                false
            }
            None => false,
        }
    }

    /// Present the world target (the frame just rendered, or the last one again) inside the safe
    /// area.
    fn present(&mut self) {
        let (Some(device), Some(live), Some(presentation)) = (self.device.as_mut(), self.live.as_ref(), self.presentation)
        else {
            return;
        };
        let texture = match live.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(texture) | wgpu::CurrentSurfaceTexture::Suboptimal(texture) => texture,
            wgpu::CurrentSurfaceTexture::Outdated | wgpu::CurrentSurfaceTexture::Lost => {
                self.lifecycle.surface_lost();
                self.log(json!({ "event": "surface-lost" }));
                self.live = None;
                return;
            }
            other => {
                log::debug!("no surface texture this frame: {other:?}");
                return;
            }
        };
        self.presenter.present(&mut device.presenter, &texture.texture, live.config.format, &presentation);
        device.gpu().queue.present(texture);
        let rendered = self.gate.tally().rendered;
        if !self.presented && rendered > 0 {
            self.presented = true;
            let window = (live.config.width, live.config.height);
            self.log(frame_presented_event(rendered, window));
        }
    }
}

impl ApplicationHandler for App {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        self.lifecycle.resumed();
        self.log(json!({ "event": "resumed", "resumes": self.lifecycle.resumes() }));
        self.audio.resumed((self.config.audio.acquire)());
        self.log(self.audio.event());
        follow_gate(&self.audio, self.game.as_mut(), &mut self.sound);
        self.frame_times.reset();
        self.refresh_read = None;
        self.pacer.reset();
        if self.refused.is_some() {
            // The refusal screen again, into the window the platform handed back.
            self.show_refusal();
            return;
        }
        if let Some(window) = self.window(event_loop) {
            self.create_surface(event_loop, &window);
        }
    }

    fn suspended(&mut self, _event_loop: &ActiveEventLoop) {
        let dropped = self.lifecycle.suspended();
        self.live = None;
        self.log(json!({ "event": "suspended", "surfaceDropped": dropped }));
        let tally = self.gate.tally();
        self.log(json!({ "event": "frames", "rendered": tally.rendered, "repeated": tally.repeated }));
        (self.config.audio.release)();
        self.audio.suspended();
        self.log(self.audio.event());
        follow_gate(&self.audio, self.game.as_mut(), &mut self.sound);
        // The system hides the keyboard with the app; it comes back on resume while a field has focus.
        self.ime.hidden_by_platform();
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, _window: WindowId, event: WindowEvent) {
        match event {
            WindowEvent::CloseRequested => event_loop.exit(),
            WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. } => self.resized(),
            WindowEvent::Touch(touch) => {
                self.touch(touch.id, touch.phase, (touch.location.x as f32, touch.location.y as f32));
            }
            WindowEvent::KeyboardInput { device_id, event, .. } => self.key(device_id, &event),
            WindowEvent::Ime(Ime::Commit(text)) => self.ime.push(TextAction::Insert(text)),
            WindowEvent::RedrawRequested => {
                self.recreate_lost_surface(event_loop);
                self.redraw();
            }
            _ => {}
        }
    }

    fn about_to_wait(&mut self, _event_loop: &ActiveEventLoop) {
        if let (Some(window), Some(_)) = (&self.window, &self.live) {
            window.request_redraw();
        }
    }
}

/// Run `game` with `config` on `event_loop` until it ends. On iOS `run_app` never returns
/// (UIKit owns the process); on Android it returns when the activity is destroyed or the loop
/// exits (`android_main` then returns and the activity finishes); elsewhere the outcome comes back.
pub fn run_on(event_loop: EventLoop<()>, game: Box<dyn GameHandle>, config: ShellConfig) -> ShellOutcome {
    event_loop.set_control_flow(ControlFlow::Poll);
    let mut app = App {
        config,
        game,
        instance: core_instance(),
        lifecycle: Lifecycle::default(),
        touches: TouchTracker::default(),
        audio: AudioGate::default(),
        sound: genex::audio::Device::default(),
        pads: PhonePads::default(),
        pad_changes: Vec::new(),
        ime: ImeBridge::default(),
        typing: TypingFeed::default(),
        rotation: RotationWatch::default(),
        thermal: ThermalWatch::default(),
        pacer: Pacer::default(),
        clock: Instant::now(),
        refused: None,
        presentation: None,
        presenter: SafePresenter::default(),
        meshes: MeshCache::default(),
        window: None,
        device: None,
        live: None,
        frame_times: FrameTimes::default(),
        refresh_read: None,
        gate: FrameGate::default(),
        rate_vote: None,
        presented: false,
        recovery: Recovery::default(),
        loading: None,
        outcome: ShellOutcome::Ran,
    };
    if let Err(error) = event_loop.run_app(&mut app) {
        return ShellOutcome::Failed("event-loop-failed", error.to_string());
    }
    // The surface goes before the window it was made from.
    app.live = None;
    app.outcome
}

/// The display's refresh interval iOS's voting display link last reported, in milliseconds; None
/// before it ticked and on every other platform (the iOS hooks' `refresh_ms`).
pub fn display_link_refresh_ms() -> Option<f64> {
    preferred_rate::refresh_ms()
}

/// Asking the display for a preferred refresh rate (RQ0.12): [`request`] answers a [`Vote`] to keep
/// while it applies, or None where the platform cannot take it (Android 10, a host build).
mod preferred_rate {
    #[cfg(target_os = "android")]
    pub use android::{Vote, request};
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    pub use host::{Vote, request};
    #[cfg(target_os = "ios")]
    pub use ios::{Vote, refresh_ms, request};

    /// iOS: a display link votes for the rate with its frame-rate range (iOS 15+; the lane's floor
    /// is 16), so ProMotion panels refresh at the rate the game ticks; its callback records the
    /// display's refresh interval (`targetTimestamp - timestamp`) for the frame pacer (review F2).
    #[cfg(target_os = "ios")]
    mod ios {
        use objc2::rc::Retained;
        use objc2::runtime::NSObject;
        use objc2::{AnyThread, define_class, msg_send, sel};
        use objc2_foundation::{NSRunLoop, NSRunLoopCommonModes};
        use objc2_quartz_core::{CADisplayLink, CAFrameRateRange};
        use std::sync::atomic::{AtomicU64, Ordering};
        use winit::window::Window;

        /// The last refresh interval the link reported, in milliseconds as f64 bits (0: none yet).
        static REFRESH_MS_BITS: AtomicU64 = AtomicU64::new(0);

        define_class!(
            // SAFETY: NSObject has no subclassing requirements; the class has no ivars and no Drop.
            #[unsafe(super(NSObject))]
            #[name = "GenexFrameRateVote"]
            struct Voter;

            impl Voter {
                /// The display link's callback: the refresh interval it is about to show.
                #[unsafe(method(tick:))]
                fn tick(&self, link: &CADisplayLink) {
                    let interval_ms = (link.targetTimestamp() - link.timestamp()) * 1000.0;
                    if interval_ms.is_finite() && interval_ms > 0.0 {
                        REFRESH_MS_BITS.store(interval_ms.to_bits(), Ordering::Relaxed);
                    }
                }
            }
        );

        /// The display's refresh interval the voting link last reported, in milliseconds.
        pub fn refresh_ms() -> Option<f64> {
            let bits = REFRESH_MS_BITS.load(Ordering::Relaxed);
            (bits != 0).then(|| f64::from_bits(bits))
        }

        /// The voting display link, invalidated (taken off the run loop) when dropped.
        pub struct Vote(Retained<CADisplayLink>);

        impl Drop for Vote {
            fn drop(&mut self) {
                self.0.invalidate();
            }
        }

        /// Vote for `hz` on the main run loop (the shell's event loop runs on the main thread).
        pub fn request(_window: &Window, hz: f32) -> Option<Vote> {
            // SAFETY: `init` on a freshly allocated NSObject subclass with no ivars.
            let voter: Retained<Voter> = unsafe { msg_send![Voter::alloc(), init] };
            // SAFETY: `voter` implements `tick:`, which takes the link; the link retains its target.
            let link = unsafe { CADisplayLink::displayLinkWithTarget_selector(&voter, sel!(tick:)) };
            link.setPreferredFrameRateRange(CAFrameRateRange { minimum: hz, maximum: hz, preferred: hz });
            // SAFETY: called from the event loop on the main thread, whose run loop the link joins;
            // the common-modes constant is a framework static that lives for the process.
            unsafe { link.addToRunLoop_forMode(&NSRunLoop::mainRunLoop(), NSRunLoopCommonModes) };
            Some(Vote(link))
        }
    }

    /// Android: `ANativeWindow_setFrameRate` (API 30), looked up at run time because the lane
    /// builds for API 29, where it does not exist and the request is skipped.
    #[cfg(target_os = "android")]
    #[allow(unsafe_code, reason = "the NDK call is reached through dlsym on the window's raw ANativeWindow")]
    mod android {
        use std::ffi::{CStr, c_char, c_int, c_void};
        use winit::raw_window_handle::{HasWindowHandle, RawWindowHandle};
        use winit::window::Window;

        /// bionic's `RTLD_NOW`.
        const RTLD_NOW: c_int = 2;
        /// `ANATIVEWINDOW_FRAME_RATE_COMPATIBILITY_DEFAULT`: a game's rate, not a video's.
        const COMPATIBILITY_DEFAULT: i8 = 0;
        const LIBANDROID: &CStr = c"libandroid.so";
        const SET_FRAME_RATE: &CStr = c"ANativeWindow_setFrameRate";

        #[link(name = "dl")]
        unsafe extern "C" {
            fn dlopen(filename: *const c_char, flags: c_int) -> *mut c_void;
            fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
        }

        /// `int32_t ANativeWindow_setFrameRate(ANativeWindow*, float, int8_t)`.
        type SetFrameRate = unsafe extern "C" fn(*mut c_void, f32, i8) -> i32;

        /// The request applies to the window until its surface goes; nothing to undo.
        pub struct Vote;

        /// Ask `window`'s `ANativeWindow` for `hz`; None below Android 11 or when it refused.
        pub fn request(window: &Window, hz: f32) -> Option<Vote> {
            let handle = window.window_handle().ok()?;
            let RawWindowHandle::AndroidNdk(handle) = handle.as_raw() else { return None };
            // SAFETY: plain libdl calls with NUL-terminated names; libandroid is already loaded
            // (winit links it), so dlopen only takes another reference to it.
            let library = unsafe { dlopen(LIBANDROID.as_ptr(), RTLD_NOW) };
            if library.is_null() {
                return None;
            }
            // SAFETY: as above; a null answer means this Android has no such call.
            let symbol = unsafe { dlsym(library, SET_FRAME_RATE.as_ptr()) };
            if symbol.is_null() {
                return None;
            }
            // SAFETY: the symbol is libandroid's ANativeWindow_setFrameRate, whose C signature
            // `SetFrameRate` spells.
            let set_frame_rate = unsafe { std::mem::transmute::<*mut c_void, SetFrameRate>(symbol) };
            // SAFETY: winit's handle names the window's live ANativeWindow while the window exists;
            // the shell calls this from the event loop while the surface is live.
            let status = unsafe { set_frame_rate(handle.a_native_window.as_ptr(), hz, COMPATIBILITY_DEFAULT) };
            (status == 0).then_some(Vote)
        }
    }

    /// No display link outside iOS: the frames' intervals are measured (Android reads its display
    /// through the JNI bridge).
    #[cfg(not(target_os = "ios"))]
    pub fn refresh_ms() -> Option<f64> {
        None
    }

    /// A host build (tests, lint): no display to ask.
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    mod host {
        use winit::window::Window;

        /// Never made on a host.
        pub struct Vote;

        /// No request on a host.
        pub fn request(_window: &Window, _hz: f32) -> Option<Vote> {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_refusal_screen_event_names_the_record_s_code_and_the_colours_a_capture_must_show() {
        let rgb = |[red, green, blue, _]: [u8; 4]| json!([red, green, blue]);
        for code in [RenderCode::GpuUnsupported, RenderCode::NativeFeatureMissing] {
            let event = refusal_screen_event(code, true, (1179, 2556));
            assert_eq!(event["event"], "refusal-screen");
            assert_eq!(event["shown"], true);
            assert_eq!(event["code"], code.wire(), "the code the screen's last line names");
            assert_eq!(event["window"], json!([1179, 2556]));
            assert_eq!(event["background"], rgb(refusal::BACKGROUND));
            assert_eq!(event["ink"], rgb(refusal::INK));
            assert_eq!(event["codeInk"], rgb(refusal::CODE_INK));
        }
        assert_eq!(refusal_screen_event(RenderCode::GpuUnsupported, false, (0, 0))["shown"], false);
    }

    #[test]
    fn the_first_frame_presented_is_logged_with_the_frames_rendered_and_its_window() {
        let event = frame_presented_event(1, (640, 320));
        assert_eq!(event["event"], "frame-presented", "the wire name the CI smoke reads (MobileLifecycleEvent.FramePresented)");
        assert_eq!(event["rendered"], 1);
        assert_eq!(event["window"], json!([640, 320]));
    }

    /// Review F4: a phone whose GPU reset (Vulkan's VK_ERROR_DEVICE_LOST on Adreno or Mali) gets a
    /// new device with every mesh replayed, keeping the game where it was, instead of ticking on
    /// and presenting undefined surface content until it is killed.
    #[test]
    #[ignore = "needs the host GPU: run with --ignored metal"]
    fn metal_a_phone_presenter_recovers_a_lost_device() {
        use genex::prelude::*;
        let declared = genex::gpu::declared_native_features().expect("declared features");
        let gpu = match Gpu::headless_with(declared) {
            Ok(gpu) => gpu,
            Err(error) if std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1") => panic!("no GPU: {error}"),
            Err(error) => {
                eprintln!("skipped: no WebGPU-core adapter ({error})");
                return;
            }
        };
        let mut game = Game::new(()).world_size(96, 64);
        game.on_draw(|_, frame, _| {
            frame.cube(Transform::IDENTITY, Color::RED);
        });
        let mut runtime: Box<dyn GameHandle> = Box::new(genex::Runtime::new(game).expect("installs"));
        let mut device = device_on(gpu, runtime.world_size(), &[], &core_instance()).expect("a presenter");
        runtime.start();
        runtime.advance_live(1000.0 / 60.0);
        assert!(matches!(runtime.draw(&mut device.presenter, None), Some(Ok(_))), "the first frame draws");
        let tick = runtime.tick();
        device.presenter.resilient.force_device_loss();
        assert!(matches!(runtime.draw(&mut device.presenter, None), Some(Err(_))), "a lost device draws nothing");
        assert_eq!(runtime.recover(&mut device.presenter).map_err(|error| error.to_string()), Ok(true), "a new device");
        assert!(matches!(runtime.draw(&mut device.presenter, None), Some(Ok(_))), "the frame after draws again");
        assert_eq!(runtime.tick(), tick, "the game is where it was");
    }

    #[test]
    fn a_linear_surface_format_is_preferred() {
        use wgpu::TextureFormat::{Bgra8Unorm, Bgra8UnormSrgb, Rgba8Unorm, Rgba16Float};
        assert_eq!(pick_format(&[Bgra8UnormSrgb, Bgra8Unorm]), Some(Bgra8Unorm));
        assert_eq!(pick_format(&[Rgba16Float, Rgba8Unorm]), Some(Rgba8Unorm));
        assert_eq!(pick_format(&[Rgba16Float]), Some(Rgba16Float));
        assert_eq!(pick_format(&[]), None);
    }
}
