//! A game a person runs on a desktop (an export, or a dev build started outside the studio):
//! genex-platform-desktop's shell drives the runtime, one binary for both modes (Q1). Windowed,
//! the shell's winit window gets a wgpu surface from the presenter's own instance and each frame's
//! world target is letterboxed onto it; headless (`--headless` or `GENEX_HEADLESS=1`), the same
//! frames run and draw with nothing presented. Real input comes from the shell's sample (keys,
//! mouse, Mouse1 as one touch, gamepads on an export); a studio run never gets here, it reads only
//! the host's `input` op ([`crate::install`] serves the studio first).
//!
//! Host glue, not simulation: the shell's wall-clock frame time paces live play through the
//! runtime's fixed-tick clock, so the simulation itself never reads the clock.
//!
//! [`desktop_shot`] (hidden, for tests) runs the same shell frames headless and letterboxes the
//! world into an offscreen window through the window's own present, so the picture a person's
//! window shows is checked without opening one.
//!
//! Loading (renderer pass 2, owner decision D11): once the window's surface is made, the first
//! frame's pipelines are warmed off the frame thread ([`Presenter::warm_boot`]) and, until they
//! are compiled, each frame paints the game's loading screen ([`genex_hud::LoadingScreen`] in its
//! `[render.loading]` look: the title, a turning spinner, the pipelines n of m) instead of waiting
//! on them with a black or frozen window; the game neither ticks nor draws meanwhile, so nothing
//! of it runs unseen. A headless run has no window and boots as before.

use std::fmt;

use crate::game::Game;
use crate::gfx::AssetTable;
use genex_hud::{LoadingLook, LoadingScreen};
use genex_render::compile::{CompileTally, compile_tally};
use crate::present::Presenter;
use crate::runtime::{Runtime, View};
use genex_core::input::{FrameSample as CoreSample, Vec2};
use crate::desktop_bench::{Bench, BenchPlan};
use genex_platform_desktop::{
    FrameControl, FrameSample, Fullscreen, ShellError, ShellFrame, ShellGame, ShellMode, ShellOptions, ShellSurface, fullscreen_from_process, run_with,
};
use genex_render::capture::{Capture, check_capture_size};
use genex_render::{Gpu, RenderCode, RenderError};
use serde_json::Value;

/// The game contract's version crash records name (the studio's contract v2).
const CRASH_CONTRACT_VERSION: u32 = 2;

/// The exit code when the shell could not run (no window, no event loop) or the GPU did not open.
const EXIT_SHELL_FAILED: i32 = 1;
/// The swapchain format a window is configured with when the surface offers it (the renderer's
/// present blits into whatever format it is given).
const PREFERRED_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Bgra8Unorm;
/// Bytes per pixel of [`PREFERRED_FORMAT`].
const BYTES_PER_PIXEL: u32 = 4;

/// A window's swapchain as the shell uses it: `wgpu::Surface`, or a test's recording stand-in.
trait WindowSurface {
    /// Configure the swapchain with `config`.
    fn configure(&self, device: &wgpu::Device, config: &wgpu::SurfaceConfiguration);
    /// The next frame's texture, or why there is none.
    fn current_texture(&self) -> wgpu::CurrentSurfaceTexture;
}

impl WindowSurface for wgpu::Surface<'static> {
    fn configure(&self, device: &wgpu::Device, config: &wgpu::SurfaceConfiguration) {
        wgpu::Surface::configure(self, device, config);
    }

    fn current_texture(&self) -> wgpu::CurrentSurfaceTexture {
        self.get_current_texture()
    }
}

/// A configured window surface.
struct Window {
    surface: Box<dyn WindowSurface>,
    /// The configuration the swapchain holds now.
    config: wgpu::SurfaceConfiguration,
    /// The configuration it waits for while a warm-up thread may submit
    /// ([`Presenter::warm_in_flight`]): applied at the first frame after it.
    pending: Option<wgpu::SurfaceConfiguration>,
    /// Whether the swapchain was configured at all (an unconfigured one gives no texture).
    configured: bool,
}

/// The runtime behind the desktop shell.
pub(crate) struct DesktopGame<W> {
    runtime: Runtime<W>,
    presenter: Presenter,
    window: Option<Window>,
    /// The shell's window while it is live (from `surface_created` to `surface_lost`).
    shell_surface: Option<ShellSurface>,
    /// Surfaces asked of the GPU instance for the shell's window.
    surface_requests: u64,
    /// Frames drawn (headless and windowed alike).
    drawn: u64,
    /// Frames presented on a window.
    presented: u64,
    /// The loading screen while the boot's warm-up compiles (a window only).
    loading: Option<Loading>,
    /// The audio device a windowed run opens on its first frame (AU-8); never a headless one.
    audio: crate::audio::Device,
    /// A dev build's measured run (`GENEX_BENCH`, [`crate::desktop_bench`]).
    bench: Option<Bench>,
}

/// The loading screen a window shows, its look, and the compile pool's counts when the boot began.
struct Loading {
    screen: LoadingScreen,
    look: LoadingLook,
    base: CompileTally,
}

/// genex-core's frame sample for the shell's (touches stay the shell's: Mouse1 is the one touch).
fn core_sample(sample: &FrameSample) -> CoreSample {
    let vec2 = |[x, y]: [f32; 2]| Vec2 { x, y };
    CoreSample {
        held: sample.held.clone(),
        pressed: sample.pressed.clone(),
        released: sample.released.clone(),
        look: vec2(sample.look),
        wheel: vec2(sample.wheel),
        pointer: vec2(sample.pointer),
        pointer_lock: sample.pointer_lock,
        pads: sample.pads,
        text: sample.text.as_bytes().to_vec(),
    }
}

impl<W: Default + 'static> DesktopGame<W> {
    /// The game on an opened presenter, live play running from its first frame. A settings change
    /// (the in-game settings panel) warms its renderer off the frame thread, as Studio's does: the
    /// window keeps drawing the old settings until the new ones are compiled (review F7).
    pub(crate) fn new(mut runtime: Runtime<W>, mut presenter: Presenter) -> DesktopGame<W> {
        for (_, error) in crate::gpu::host::install(&mut runtime, &mut presenter.passes, presenter.resilient.gpu()) {
            eprintln!("genex: {error}");
        }
        presenter.set_off_thread_changes(true);
        runtime.start();
        DesktopGame { runtime, presenter, window: None, shell_surface: None, surface_requests: 0, drawn: 0, presented: 0, loading: None, audio: crate::audio::Device::default(), bench: None }
    }

    fn configure(&mut self, surface: wgpu::Surface<'static>, size: [u32; 2]) {
        let gpu = self.presenter.gpu();
        let capabilities = surface.get_capabilities(gpu.adapter());
        let format = capabilities.formats.iter().copied().find(|format| *format == PREFERRED_FORMAT);
        let Some(format) = format.or_else(|| capabilities.formats.first().copied()) else {
            eprintln!("genex: the window's surface offers no format");
            return;
        };
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            width: size[0].max(1),
            height: size[1].max(1),
            present_mode: wgpu::PresentMode::Fifo,
            desired_maximum_frame_latency: 2,
            alpha_mode: capabilities.alpha_modes.first().copied().unwrap_or(wgpu::CompositeAlphaMode::Auto),
            view_formats: Vec::new(),
            color_space: wgpu::SurfaceColorSpace::default(),
        };
        self.window = Some(Window { surface: Box::new(surface), config: config.clone(), pending: None, configured: false });
        self.configure_window(config);
    }

    /// Configure the window's swapchain with `config` now, or once no warm-up thread may submit
    /// ([`Presenter::warm_in_flight`]; then at the first frame after it, with the last `config`
    /// given). The presenter learns the window's size when the swapchain takes it.
    fn configure_window(&mut self, config: wgpu::SurfaceConfiguration) {
        let warming = self.presenter.warm_in_flight();
        let Some(window) = self.window.as_mut() else { return };
        if warming {
            window.pending = Some(config);
            return;
        }
        window.surface.configure(&self.presenter.gpu().device, &config);
        window.config = config;
        window.pending = None;
        window.configured = true;
        self.presenter.set_window_size((window.config.width, window.config.height));
    }

    /// The window's next texture, after a configuration that waited for a warm-up (the swapchain
    /// keeps its last one meanwhile); None (the frame is skipped) when there is none, a lost or
    /// outdated swapchain being configured again.
    fn window_texture(&mut self) -> Option<wgpu::SurfaceTexture> {
        if let Some(pending) = self.window.as_mut().and_then(|window| window.pending.take()) {
            self.configure_window(pending);
        }
        let window = self.window.as_ref().filter(|window| window.configured)?;
        match window.surface.current_texture() {
            wgpu::CurrentSurfaceTexture::Success(texture) | wgpu::CurrentSurfaceTexture::Suboptimal(texture) => Some(texture),
            wgpu::CurrentSurfaceTexture::Outdated | wgpu::CurrentSurfaceTexture::Lost => {
                let config = window.pending.clone().unwrap_or_else(|| window.config.clone());
                self.configure_window(config);
                None
            }
            _ => None,
        }
    }

    /// Letterbox the world target onto the window; a lost or outdated surface is configured again.
    fn present(&mut self) {
        let Some(texture) = self.window_texture() else { return };
        let Some(window) = self.window.as_ref() else { return };
        let view = texture.texture.create_view(&wgpu::TextureViewDescriptor::default());
        let (format, size) = (window.config.format, [window.config.width, window.config.height]);
        self.present_into(&view, format, size);
        self.presenter.gpu().queue.present(texture);
        self.presented += 1;
    }

    /// Letterbox the world target into `target`, `size` pixels of `format`: a window's frame and
    /// [`desktop_shot`]'s offscreen window alike.
    fn present_into(&mut self, target: &wgpu::TextureView, format: wgpu::TextureFormat, size: [u32; 2]) {
        self.presenter.present(target, format, (size[0], size[1]));
    }

    /// Present into an offscreen window of `size` in the window's format and read it back.
    fn present_offscreen(&mut self, size: [u32; 2]) -> Result<Capture, RenderError> {
        check_capture_size(size[0], size[1])?;
        let texture = self.presenter.gpu().device.create_texture(&wgpu::TextureDescriptor {
            label: Some("desktop shot"),
            size: wgpu::Extent3d { width: size[0], height: size[1], depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: PREFERRED_FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        self.present_into(&view, PREFERRED_FORMAT, size);
        read_texture(self.presenter.gpu(), &texture, size)
    }

    /// Before the first frame of a window: warm its pipelines off the frame thread and show the
    /// loading screen until they are compiled (nothing when the game drew already, or nothing
    /// needed warming).
    fn begin_loading(&mut self) {
        if self.drawn > 0 || self.loading.is_some() {
            return;
        }
        let base = compile_tally();
        self.presenter.warm_boot(&mut self.runtime);
        if self.presenter.boot_warming() {
            let look = crate::loading::look_from_build(self.runtime.title());
            self.loading = Some(Loading { screen: LoadingScreen::new(), look, base });
        }
    }

    /// Paint the loading screen into `target`, `size` pixels of `format`, advanced by `frame_ms`.
    fn paint_loading(&mut self, target: &wgpu::TextureView, format: wgpu::TextureFormat, size: [u32; 2], frame_ms: f64) {
        let Some(loading) = self.loading.as_mut() else { return };
        loading.screen.advance((frame_ms / 1000.0) as f32);
        let progress = crate::loading::preparing(compile_tally().since(loading.base), self.presenter.impostor_tally());
        let gpu = self.presenter.gpu();
        let ratio = self.shell_surface.as_ref().map_or(1.0, ShellSurface::scale);
        let pixels_per_point = genex_hud::pixels_per_point(ratio);
        loading.screen.paint(&gpu.device, &gpu.queue, target, format, size, pixels_per_point, &loading.look, &progress);
    }

    /// One frame of the loading screen on the window.
    fn present_loading(&mut self, frame_ms: f64) {
        let Some(texture) = self.window_texture() else { return };
        let Some(window) = self.window.as_ref() else { return };
        let view = texture.texture.create_view(&wgpu::TextureViewDescriptor::default());
        let (format, size) = (window.config.format, [window.config.width, window.config.height]);
        self.paint_loading(&view, format, size, frame_ms);
        self.presenter.gpu().queue.present(texture);
        self.presented += 1;
    }

    /// Tests only: the loading screen painted into an offscreen window of `size` and read back.
    #[cfg(test)]
    fn loading_offscreen(&mut self, size: [u32; 2]) -> Result<Capture, RenderError> {
        check_capture_size(size[0], size[1])?;
        let texture = self.presenter.gpu().device.create_texture(&wgpu::TextureDescriptor {
            label: Some("loading shot"),
            size: wgpu::Extent3d { width: size[0], height: size[1], depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: PREFERRED_FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        self.paint_loading(&view, PREFERRED_FORMAT, size, 0.0);
        read_texture(self.presenter.gpu(), &texture, size)
    }

    /// Close the profiler's frame with the GPU time the settings last measured (timestamp
    /// queries; none without them), as a studio run's frames do.
    fn close_profile_frame(&mut self, interval_ms: f64) {
        let timestamps = self.presenter.gpu().device.features().contains(wgpu::Features::TIMESTAMP_QUERY);
        let source = if timestamps { genex_profile::GpuTimeSource::Timestamps } else { genex_profile::GpuTimeSource::None };
        let gpu_ms = self.runtime.render().borrow().status().gpu_ms;
        let profiling = self.runtime.profiling();
        profiling.set_gpu_source(source);
        let index = profiling.frame_index();
        profiling.new_frame(interval_ms, gpu_ms.map(|ms| (index, f64::from(ms))));
    }

    /// Set a measured run's scene up once the loading screen is done: its seed, its demo, live
    /// play, its render settings and output, then its clock.
    fn begin_bench(&mut self) {
        let Some(bench) = self.bench.as_mut().filter(|bench| !bench.begun()) else { return };
        let plan = bench.plan.clone();
        if let Some(seed) = plan.seed {
            self.runtime.seed(seed);
        }
        if let Some(demo) = plan.demo.as_deref()
            && self.runtime.demo(demo).is_err()
        {
            eprintln!("genex: the bench's demo {demo} is not one of the game's");
        }
        self.runtime.start();
        let features: Vec<(&str, bool)> = plan.features.iter().map(|(name, on)| (name.as_str(), *on)).collect();
        let class = plan.device_class.as_deref().map(Some);
        match crate::render::RenderChange::from_spellings(None, class, &features, plan.scale_lock.map(Some)) {
            Ok(change) => {
                self.runtime.render().borrow_mut().apply(&change);
            }
            Err(refusal) => eprintln!("genex: the bench's render settings were refused: {}", refusal.wire()),
        }
        self.presenter.set_output_capped(!plan.native_output);
        bench.begin();
    }

    /// Note a measured run's frame (a profile report every window); at its end write its record
    /// and close the window.
    fn bench_frame(&mut self, shell_ms: f64, work_ms: f64, ticks: u32, drew: bool) -> FrameControl {
        let Some(bench) = self.bench.as_mut() else { return FrameControl::Continue };
        if let Some(window) = self.window.as_ref() {
            bench.surface = [window.config.width, window.config.height];
        }
        bench.scale_factor = self.shell_surface.as_ref().map_or(1.0, ShellSurface::scale);
        let over = bench.frame(shell_ms, work_ms, ticks, drew);
        if bench.report_due() || over {
            let class = self.runtime.render().borrow().status().device_class.wire();
            bench.keep_report(self.runtime.profiling().report_json(Bench::report_frames(), destination(), &class));
        }
        if !over {
            return FrameControl::Continue;
        }
        let status = self.runtime.render().borrow().status();
        let renderer = self.presenter.resilient.renderer().renderer();
        let features: serde_json::Map<String, serde_json::Value> = status.features.iter().map(|(feature, on)| (feature.wire().to_owned(), (*on).into())).collect();
        let render = serde_json::json!({
            "deviceClass": status.device_class.wire(),
            "preset": status.preset.wire(),
            "scale": status.scale,
            "output": self.presenter.last_output().map(|(w, h)| [w, h]),
            "renderSize": [renderer.render_size().0, renderer.render_size().1],
            "gpuMs": status.gpu_ms,
            "cpuMs": status.cpu_ms,
            "features": features,
            "degraded": status.degraded.iter().map(|d| format!("{}:{}", d.reason.wire(), d.subject.clone().unwrap_or_default())).collect::<Vec<_>>(),
            "characters": status.characters.to_json(),
        });
        bench.write(render);
        FrameControl::Exit
    }

    /// A windowed frame opens the audio device once (a person sees and hears the run); a headless
    /// one never does. Each frame then reports the device to `volatile.audio.device`.
    fn follow_audio(&mut self, frame: &ShellFrame) {
        // A measured run is silent unless its plan asks for sound.
        let silent = self.bench.as_ref().is_some_and(|bench| !bench.plan.audio);
        if !self.audio.tried() && !silent && crate::audio::may_open_device(frame.headless, false) {
            self.audio.open_for(&mut self.runtime);
        } else if self.audio.is_open() {
            self.runtime.note_audio_device(true, self.audio.fault());
        }
    }

    /// After a device loss: a new device, every mesh and pass rebuilt, and the window's surface
    /// made again on it from the kept window (review F3: a desktop's winit sends `resumed` once, at
    /// start-up, so a surface left for the next one never came back and the window froze).
    fn recover(&mut self) {
        match self.presenter.recover_for(&mut self.runtime) {
            Ok(true) => {
                self.window = None;
                if let Some(kept) = self.shell_surface.take() {
                    self.surface_created(&kept);
                }
            }
            Ok(false) => {}
            Err(error) => eprintln!("genex: the GPU device is not back yet: {error}"),
        }
    }
}

impl<W: Default + 'static> ShellGame for DesktopGame<W> {
    fn title(&self) -> String {
        self.runtime.title().to_owned()
    }

    fn world_size(&self) -> [u32; 2] {
        self.runtime.world_size()
    }

    fn surface_created(&mut self, surface: &ShellSurface) {
        self.shell_surface = Some(surface.clone());
        self.surface_requests += 1;
        let Some(instance) = self.presenter.gpu().instance() else { return };
        match instance.create_surface(surface.clone()) {
            Ok(created) => self.configure(created, surface.size()),
            Err(error) => eprintln!("genex: no surface for the window: {error}"),
        }
        if self.window.is_some() {
            self.begin_loading();
        }
    }

    fn surface_resized(&mut self, size: [u32; 2], _scale: f64) {
        let Some(window) = self.window.as_ref() else { return };
        let mut config = window.pending.clone().unwrap_or_else(|| window.config.clone());
        config.width = size[0].max(1);
        config.height = size[1].max(1);
        self.configure_window(config);
    }

    fn surface_lost(&mut self) {
        self.window = None;
        self.shell_surface = None;
    }

    fn closing(&mut self) {
        // The window is closing: the autosave ring's oldest slot is written now (UIS-12); a refusal
        // is the slot's volatile issue, and the process ends either way.
        if let Some(Err(error)) = self.runtime.suspend_save() {
            eprintln!("genex: the suspend autosave was not written: {error}");
        }
    }

    fn os_locale(&mut self, tag: Option<&str>) {
        self.runtime.set_os_locale(tag);
    }

    #[allow(clippy::disallowed_types, clippy::disallowed_methods, reason = "host glue: a measured run times the frame's work by the wall clock; the simulation never sees it")]
    fn frame(&mut self, frame: ShellFrame) -> FrameControl {
        if self.presenter.resilient.is_lost() {
            self.recover();
        }
        if self.loading.is_some() {
            // Until the warm-up compiled the first frame's pipelines the window shows the loading
            // screen: the game neither ticks nor draws, so nothing of it runs unseen.
            if self.presenter.boot_warming() {
                if frame.present {
                    self.present_loading(frame.frame_ms);
                }
                return FrameControl::Continue;
            }
            self.loading = None;
        }
        self.follow_audio(&frame);
        self.begin_bench();
        let began = std::time::Instant::now();
        // One profiler frame per shell frame (PROF-5): the ticks, the draw and the present.
        let scope = crate::profile::engine_scope(crate::profile::EngineScope::Frame);
        self.runtime.sample_input(&core_sample(&frame.sample));
        let ticks = self.runtime.advance_live(frame.frame_ms);
        // The first frame draws even before a tick: the window never shows an empty target.
        let draws = ticks > 0 || self.drawn == 0;
        if draws {
            let _draw = crate::profile::engine_scope(crate::profile::EngineScope::Draw);
            let camera = self.bench.as_ref().and_then(|bench| bench.plan.camera.clone());
            let view = camera.as_deref().map_or(View::Game, View::Named);
            match self.presenter.draw_view(&mut self.runtime, view) {
                Some(Ok(_)) => self.drawn += 1,
                Some(Err(error)) => eprintln!("genex: render failed: {error}"),
                None => {}
            }
            for refusal in self.presenter.take_pass_refusals() {
                eprintln!("genex: {refusal}");
            }
        }
        if frame.present {
            let _present = crate::profile::engine_scope(crate::profile::EngineScope::Present);
            self.present();
        }
        drop(scope);
        self.close_profile_frame(frame.frame_ms);
        let work_ms = began.elapsed().as_secs_f64() * 1000.0;
        self.bench_frame(frame.frame_ms, work_ms, ticks, draws)
    }
}

/// The destination a desktop run's crash records name.
fn destination() -> &'static str {
    if cfg!(target_os = "macos") {
        "mac"
    } else if cfg!(windows) {
        "windows"
    } else {
        "linux"
    }
}

/// Open the presenter for `runtime`, or the refusal that stops the run.
pub(crate) fn open<W: Default + 'static>(runtime: Runtime<W>, assets: AssetTable) -> Result<DesktopGame<W>, RenderError> {
    let presenter = Presenter::open(runtime.world_size(), assets)?;
    Ok(DesktopGame::new(runtime, presenter))
}

/// Run the game in this process's mode until its window closes; exits the process with an error
/// code when the GPU or the window could not be opened.
pub(crate) fn run<W: Default + 'static>(mut runtime: Runtime<W>, assets: AssetTable) {
    // A crash is written under the save root's `genex-crash/` (a person's export, or a dev build
    // run outside the studio); a dev build profiles with scopes on, an export with them off.
    let dev = cfg!(feature = "studio");
    crate::crash::set_identity(destination(), dev, &format!("genex-rust/{}/desktop", destination()), u64::from(CRASH_CONTRACT_VERSION));
    crate::crash::install_file_sink(runtime.saves());
    runtime.profiling().start(dev);
    let mut game = open(runtime, assets).unwrap_or_else(|error| {
        eprintln!("genex: {error}");
        std::process::exit(EXIT_SHELL_FAILED);
    });
    // Only a dev build takes a measured run's plan; an export never reads it.
    game.bench = if dev { BenchPlan::from_process().map(Bench::new) } else { None };
    let asked = game.bench.as_ref().map_or(Fullscreen::Off, |bench| bench.plan.fullscreen);
    let fullscreen = if asked == Fullscreen::Off { fullscreen_from_process() } else { asked };
    let options = ShellOptions { max_frames: None, studio: false, fullscreen };
    if let Err(error) = run_with(game, ShellMode::from_process(), options) {
        eprintln!("genex: {error}");
        std::process::exit(EXIT_SHELL_FAILED);
    }
}

/// A `PREFERRED_FORMAT` texture of `size` read back, rows top to bottom.
fn read_texture(gpu: &Gpu, texture: &wgpu::Texture, [width, height]: [u32; 2]) -> Result<Capture, RenderError> {
    let failed = |detail: String| RenderError::refused(RenderCode::CaptureFailed, detail);
    let padded = (width * BYTES_PER_PIXEL).div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT) * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
    let staging = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("desktop shot readback"),
        size: u64::from(padded) * u64::from(height),
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("desktop shot") });
    encoder.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo { texture, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
        wgpu::TexelCopyBufferInfo {
            buffer: &staging,
            layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(padded), rows_per_image: Some(height) },
        },
        wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
    );
    gpu.queue.submit([encoder.finish()]);
    let slice = staging.slice(..);
    let (sender, receiver) = std::sync::mpsc::channel();
    slice.map_async(wgpu::MapMode::Read, move |result| {
        // The receiver waits below; a send can only fail once it is gone.
        let _ = sender.send(result);
    });
    gpu.device.poll(wgpu::PollType::wait_indefinitely()).map_err(|error| failed(error.to_string()))?;
    let mapped = receiver.recv().map_err(|error| failed(error.to_string()))?;
    mapped.map_err(|error| failed(error.to_string()))?;
    let data = slice.get_mapped_range().map_err(|error| failed(error.to_string()))?.to_vec();
    staging.unmap();
    Capture::from_padded_rows(width, height, padded, &data)
}

/// What [`desktop_shot`] saw: the game's `state()` after the frames and the offscreen window.
#[doc(hidden)]
#[derive(Debug)]
pub struct DesktopShot {
    /// `state()` after the last frame (`__render` is that frame's tally).
    pub state: Value,
    /// The offscreen window's size, in pixels.
    pub window: [u32; 2],
    /// The size the last frame was rendered at: the window's letterbox in its own pixels, capped
    /// by the class (renderer pass 2, P2-0.9 step B), not the world size.
    pub output: [u32; 2],
    /// The window's pixels, BGRA, rows top to bottom, the world letterboxed with black bars.
    pub bgra: Vec<u8>,
    /// Frames the shell ran.
    pub frames: u64,
    /// Frames that drew.
    pub drawn: u64,
}

/// Why [`desktop_shot`] has no picture.
#[doc(hidden)]
#[derive(Debug)]
pub enum DesktopShotError {
    /// The GPU did not open (no WebGPU-core adapter, a declared feature missing).
    Gpu(RenderError),
    /// The shell refused the run.
    Shell(ShellError),
    /// The offscreen window could not be presented or read back.
    Readback(RenderError),
}

impl fmt::Display for DesktopShotError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DesktopShotError::Gpu(error) | DesktopShotError::Readback(error) => write!(f, "{error}"),
            DesktopShotError::Shell(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for DesktopShotError {}

/// Tests only: run `game` through the desktop shell's own frames, headless, for `frames` frames
/// (at least one), then letterbox its world into an offscreen `window` exactly as the shell
/// presents onto a real window, and read that back. Models come from `assets` only (no folder is
/// read), so a shot is the same wherever the test binary runs. Panics like [`crate::install`] on
/// inconsistent registrations.
#[doc(hidden)]
pub fn desktop_shot<W: Default + 'static>(
    game: Game<W>,
    assets: AssetTable,
    frames: u64,
    window: [u32; 2],
) -> Result<DesktopShot, DesktopShotError> {
    let runtime = Runtime::new(game).unwrap_or_else(|error| panic!("genex::desktop_shot: {error}"));
    let mut presenter = Presenter::open_with_root(runtime.world_size(), assets, None).map_err(DesktopShotError::Gpu)?;
    // As a window's surface is configured before its first frame.
    presenter.set_window_size((window[0], window[1]));
    let options = ShellOptions { max_frames: Some(frames.max(1)), studio: false, fullscreen: Fullscreen::Off };
    let shell = run_with(DesktopGame::new(runtime, presenter), ShellMode::Headless, options);
    let (mut game, exit) = shell.map_err(DesktopShotError::Shell)?;
    let capture = game.present_offscreen(window).map_err(DesktopShotError::Readback)?;
    let bgra = capture.bgra().to_vec();
    let (width, height) = game.presenter.resilient.renderer().renderer().size();
    Ok(DesktopShot { state: game.runtime.state(), window, output: [width, height], bgra, frames: exit.frames, drawn: game.drawn })
}

/// GPU rows: the shell's headless mode on the host GPU (Metal on the Mac). Run with
/// `cargo test -p genex -- --ignored metal` (`GENEX_REQUIRE_METAL=1` makes a missing adapter a
/// failure). The windowed half needs a display and a person: a manual gate row.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::prelude::*;

    #[derive(Default)]
    struct World {
        ticks: u32,
    }

    fn cube_game() -> Game<World> {
        let mut game = Game::new(World::default()).world_size(96, 64);
        game.on_update(|sim, _| sim.world.ticks += 1);
        game.on_draw(|_, frame, _| {
            frame.cube(Transform::IDENTITY, Color::RED);
        });
        game
    }

    /// The desktop game on the host GPU, or None (skipped) without an adapter.
    fn desktop_game() -> Option<DesktopGame<World>> {
        let runtime = Runtime::new(cube_game()).expect("installs");
        match open(runtime, &[]) {
            Ok(game) => Some(game),
            Err(error) if std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1") => panic!("no GPU: {error}"),
            Err(error) => {
                eprintln!("skipped: no WebGPU-core adapter ({error})");
                None
            }
        }
    }

    /// One shell frame of a sixtieth of a second, as the windowed loop hands it.
    fn shell_frame(present: bool) -> ShellFrame {
        ShellFrame { sample: FrameSample::default(), frame_ms: 1000.0 / 60.0, present, headless: false }
    }

    /// Review F3: after a device loss the window's surface is made again on the new device (winit
    /// sends `resumed` once at start-up on a desktop, so waiting for the next one froze the window).
    #[test]
    #[ignore = "needs the host GPU: run with --ignored metal"]
    fn metal_a_recovered_device_makes_the_window_s_surface_again() {
        let Some(mut game) = desktop_game() else { return };
        game.surface_created(&ShellSurface::detached([96, 64], 1.0));
        assert_eq!(game.surface_requests, 1);
        game.frame(shell_frame(true));
        game.presenter.resilient.force_device_loss();
        game.frame(shell_frame(true));
        assert!(!game.presenter.resilient.is_lost(), "the device was re-created");
        assert_eq!(game.surface_requests, 2, "the window's surface is asked of the new device");
        game.surface_lost();
        game.presenter.resilient.force_device_loss();
        game.frame(shell_frame(false));
        assert_eq!(game.surface_requests, 2, "no window, no surface after a later loss");
    }

    /// Review F7: a settings change in a shipped desktop game (the in-game settings panel) warms
    /// its renderer off the frame thread, so the window keeps drawing the old settings meanwhile.
    #[test]
    #[ignore = "needs the host GPU: run with --ignored metal"]
    #[allow(clippy::disallowed_types, clippy::disallowed_methods, reason = "the row times a frame and a watchdog lets the held pool go")]
    fn metal_a_preset_change_never_holds_the_desktop_frame_for_its_compiles() {
        use crate::render::{ClassOverride, QualityPreset};
        /// When the watchdog lets the held compile pool go; a frame that waited takes this long.
        const HOLD_RELEASE: std::time::Duration = std::time::Duration::from_secs(3);
        let Some(mut game) = desktop_game() else { return };
        for _ in 0..3 {
            game.frame(shell_frame(false));
        }
        let person = ClassOverride { preset: Some(QualityPreset::Low), ..ClassOverride::default() };
        game.runtime.render().borrow_mut().set_person(person);
        let hold = genex_render::compile::hold();
        let watchdog = std::thread::spawn(move || {
            std::thread::sleep(HOLD_RELEASE);
            drop(hold);
        });
        let from = std::time::Instant::now();
        game.frame(shell_frame(false));
        let took = from.elapsed();
        watchdog.join().expect("the watchdog lets the pool go");
        assert!(took < HOLD_RELEASE / 2, "the frame after a preset change took {took:?} (held for its compiles)");
    }

    /// Owner decision D11: a window's first frames show the game's loading screen (its background,
    /// lit, never black) while the boot's warm-up compiles, without waiting for the compiles and
    /// without running the game unseen; once they are done the game's own frames draw.
    #[test]
    #[ignore = "needs the host GPU: run with --ignored metal"]
    #[allow(clippy::disallowed_types, clippy::disallowed_methods, reason = "the row times a frame and a watchdog lets the held pool go")]
    fn metal_a_window_shows_the_loading_screen_while_the_boot_compiles() {
        /// When the watchdog lets the held compile pool go; a frame that waited takes this long.
        const HOLD_RELEASE: std::time::Duration = std::time::Duration::from_secs(3);
        let Some(mut game) = desktop_game() else { return };
        let hold = genex_render::compile::hold();
        let watchdog = std::thread::spawn(move || {
            std::thread::sleep(HOLD_RELEASE);
            drop(hold);
        });
        game.begin_loading();
        assert!(game.loading.is_some(), "the boot's warm-up is compiling");
        let from = std::time::Instant::now();
        game.frame(shell_frame(true));
        assert!(from.elapsed() < HOLD_RELEASE / 2, "the frame never waited for the compiles: {:?}", from.elapsed());
        assert_eq!(game.drawn, 0, "the game drew nothing yet");
        assert_eq!(game.runtime.sim().world.ticks, 0, "and ran nothing unseen");
        let shot = game.loading_offscreen([96, 64]).expect("the loading screen reads back");
        let background = LoadingLook::new("").background;
        let corner = &shot.bgra()[..4];
        assert_eq!([corner[2], corner[1], corner[0]], background, "the window is the loading screen's colour, never black");
        watchdog.join().expect("the watchdog lets the pool go");
        while game.presenter.boot_warming() {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        game.frame(shell_frame(true));
        assert!(game.loading.is_none(), "the loading screen left");
        assert_eq!(game.drawn, 1, "the game's first frame drew");
    }

    /// A window surface that records each configure's size and has no texture to give: outdated
    /// until it is first configured (as a resized swapchain is), then timing out.
    #[derive(Clone, Default)]
    struct RecordingSurface {
        configured: std::rc::Rc<std::cell::RefCell<Vec<(u32, u32)>>>,
    }

    impl WindowSurface for RecordingSurface {
        fn configure(&self, _device: &wgpu::Device, config: &wgpu::SurfaceConfiguration) {
            self.configured.borrow_mut().push((config.width, config.height));
        }

        fn current_texture(&self) -> wgpu::CurrentSurfaceTexture {
            if self.configured.borrow().is_empty() { wgpu::CurrentSurfaceTexture::Outdated } else { wgpu::CurrentSurfaceTexture::Timeout }
        }
    }

    impl RecordingSurface {
        fn configured(&self) -> Vec<(u32, u32)> {
            self.configured.borrow().clone()
        }
    }

    /// Lane UP (HZ's one-off crash, again on a fullscreen switch during the boot's warm-up): wgpu's
    /// `Surface::configure` waits for the queue to go idle and refuses, as an uncaptured validation
    /// error ("Failed to wait for GPU to come idle before reconfiguring the Surface"), when another
    /// thread submits meanwhile. The warm-up thread renders and submits, so a window resized (or
    /// outdated) while it runs is configured only after it is done, at the size it was last given.
    #[test]
    #[ignore = "needs the host GPU: run with --ignored metal"]
    fn metal_a_window_resized_while_a_warm_up_renders_is_configured_after_it() {
        let Some(mut game) = desktop_game() else { return };
        let hold = genex_render::compile::hold();
        game.begin_loading();
        assert!(game.presenter.boot_warming(), "the boot's warm-up runs on its thread");
        let surface = RecordingSurface::default();
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format: PREFERRED_FORMAT,
            width: 96,
            height: 64,
            present_mode: wgpu::PresentMode::Fifo,
            desired_maximum_frame_latency: 2,
            alpha_mode: wgpu::CompositeAlphaMode::Auto,
            view_formats: Vec::new(),
            color_space: wgpu::SurfaceColorSpace::default(),
        };
        game.window = Some(Window { surface: Box::new(surface.clone()), config, pending: None, configured: true });
        game.surface_resized([200, 100], 2.0);
        game.surface_resized([240, 120], 2.0);
        game.frame(shell_frame(true));
        assert_eq!(surface.configured(), Vec::new(), "no configure while the warm-up may submit");
        drop(hold);
        while game.presenter.boot_warming() {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        game.frame(shell_frame(true));
        assert_eq!(surface.configured(), vec![(240, 120)], "configured once the warm-up is done, at the last size");
    }

    #[test]
    #[ignore = "needs the host GPU: run with --ignored metal"]
    fn metal_a_headless_desktop_run_ticks_live_and_draws_each_frame() {
        let Some(game) = desktop_game() else { return };
        let options = ShellOptions { max_frames: Some(12), studio: false, fullscreen: Fullscreen::Off };
        let (game, exit) = run_with(game, ShellMode::Headless, options).expect("the shell ran");
        assert_eq!(exit.frames, 12);
        assert!(game.runtime.sim().world.ticks > 0, "live play ticked");
        assert!(game.drawn > 1, "the frames drew");
        assert_eq!(game.presented, 0, "a headless run presents nothing");
    }
}
