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

use std::fmt;

use crate::game::Game;
use crate::gfx::AssetTable;
use crate::present::Presenter;
use crate::runtime::{Runtime, View};
use genex_core::input::{FrameSample as CoreSample, Vec2};
use genex_platform_desktop::{
    FrameControl, FrameSample, ShellError, ShellFrame, ShellGame, ShellMode, ShellOptions, ShellSurface, run_with,
};
use genex_render::capture::{Capture, check_capture_size};
use genex_render::{Gpu, RenderCode, RenderError};
use serde_json::Value;

/// The exit code when the shell could not run (no window, no event loop) or the GPU did not open.
const EXIT_SHELL_FAILED: i32 = 1;
/// The swapchain format a window is configured with when the surface offers it (the renderer's
/// present blits into whatever format it is given).
const PREFERRED_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Bgra8Unorm;
/// Bytes per pixel of [`PREFERRED_FORMAT`].
const BYTES_PER_PIXEL: u32 = 4;

/// A configured window surface.
struct Window {
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
}

/// The runtime behind the desktop shell.
pub(crate) struct DesktopGame<W> {
    runtime: Runtime<W>,
    presenter: Presenter,
    window: Option<Window>,
    /// Frames drawn (headless and windowed alike).
    drawn: u64,
    /// Frames presented on a window.
    presented: u64,
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
    /// The game on an opened presenter, live play running from its first frame.
    pub(crate) fn new(mut runtime: Runtime<W>, mut presenter: Presenter) -> DesktopGame<W> {
        for (_, error) in crate::gpu::host::install(&mut runtime, &mut presenter.passes, presenter.resilient.gpu()) {
            eprintln!("genex: {error}");
        }
        runtime.start();
        DesktopGame { runtime, presenter, window: None, drawn: 0, presented: 0 }
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
        surface.configure(&gpu.device, &config);
        self.window = Some(Window { surface, config });
    }

    /// Letterbox the world target onto the window; a lost or outdated surface is configured again.
    fn present(&mut self) {
        let Some(window) = self.window.as_mut() else { return };
        let texture = match window.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(texture) | wgpu::CurrentSurfaceTexture::Suboptimal(texture) => texture,
            wgpu::CurrentSurfaceTexture::Outdated | wgpu::CurrentSurfaceTexture::Lost => {
                window.surface.configure(&self.presenter.gpu().device, &window.config);
                return;
            }
            _ => return,
        };
        let view = texture.texture.create_view(&wgpu::TextureViewDescriptor::default());
        let (format, size) = (window.config.format, [window.config.width, window.config.height]);
        self.present_into(&view, format, size);
        self.presenter.gpu().queue.present(texture);
        self.presented += 1;
    }

    /// Letterbox the world target into `target`, `size` pixels of `format`: a window's frame and
    /// [`desktop_shot`]'s offscreen window alike.
    fn present_into(&mut self, target: &wgpu::TextureView, format: wgpu::TextureFormat, size: [u32; 2]) {
        self.presenter.resilient.present(target, format, (size[0], size[1]));
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

    /// After a device loss: a new device (the window's surface is made again on it at the next
    /// `resumed`), every mesh and pass rebuilt.
    fn recover(&mut self) {
        match self.presenter.recover_for(&mut self.runtime) {
            Ok(true) => self.window = None,
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
        let Some(instance) = self.presenter.gpu().instance() else { return };
        match instance.create_surface(surface.clone()) {
            Ok(created) => self.configure(created, surface.size()),
            Err(error) => eprintln!("genex: no surface for the window: {error}"),
        }
    }

    fn surface_resized(&mut self, size: [u32; 2], _scale: f64) {
        let device = self.presenter.gpu().device.clone();
        let Some(window) = self.window.as_mut() else { return };
        window.config.width = size[0].max(1);
        window.config.height = size[1].max(1);
        window.surface.configure(&device, &window.config);
    }

    fn surface_lost(&mut self) {
        self.window = None;
    }

    fn frame(&mut self, frame: ShellFrame) -> FrameControl {
        if self.presenter.resilient.is_lost() {
            self.recover();
        }
        self.runtime.sample_input(&core_sample(&frame.sample));
        let ticks = self.runtime.advance_live(frame.frame_ms);
        // The first frame draws even before a tick: the window never shows an empty target.
        if ticks > 0 || self.drawn == 0 {
            match self.presenter.draw_view(&mut self.runtime, View::Game) {
                Some(Ok(_)) => self.drawn += 1,
                Some(Err(error)) => eprintln!("genex: render failed: {error}"),
                None => {}
            }
            for refusal in self.presenter.take_pass_refusals() {
                eprintln!("genex: {refusal}");
            }
        }
        if frame.present {
            self.present();
        }
        FrameControl::Continue
    }
}

/// Open the presenter for `runtime`, or the refusal that stops the run.
pub(crate) fn open<W: Default + 'static>(runtime: Runtime<W>, assets: AssetTable) -> Result<DesktopGame<W>, RenderError> {
    let presenter = Presenter::open(runtime.world_size(), assets)?;
    Ok(DesktopGame::new(runtime, presenter))
}

/// Run the game in this process's mode until its window closes; exits the process with an error
/// code when the GPU or the window could not be opened.
pub(crate) fn run<W: Default + 'static>(runtime: Runtime<W>, assets: AssetTable) {
    let game = open(runtime, assets).unwrap_or_else(|error| {
        eprintln!("genex: {error}");
        std::process::exit(EXIT_SHELL_FAILED);
    });
    let options = ShellOptions { max_frames: None, studio: false };
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
    let presenter = Presenter::open_with_root(runtime.world_size(), assets, None).map_err(DesktopShotError::Gpu)?;
    let options = ShellOptions { max_frames: Some(frames.max(1)), studio: false };
    let shell = run_with(DesktopGame::new(runtime, presenter), ShellMode::Headless, options);
    let (mut game, exit) = shell.map_err(DesktopShotError::Shell)?;
    let capture = game.present_offscreen(window).map_err(DesktopShotError::Readback)?;
    let bgra = capture.bgra().to_vec();
    Ok(DesktopShot { state: game.runtime.state(), window, bgra, frames: exit.frames, drawn: game.drawn })
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

    #[test]
    #[ignore = "needs the host GPU: run with --ignored metal"]
    fn metal_a_headless_desktop_run_ticks_live_and_draws_each_frame() {
        let mut game = Game::new(World::default()).world_size(96, 64);
        game.on_update(|sim, _| sim.world.ticks += 1);
        game.on_draw(|_, frame, _| {
            frame.cube(Transform::IDENTITY, Color::RED);
        });
        let runtime = Runtime::new(game).expect("installs");
        let game = match open(runtime, &[]) {
            Ok(game) => game,
            Err(error) if std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1") => panic!("no GPU: {error}"),
            Err(error) => {
                eprintln!("skipped: no WebGPU-core adapter ({error})");
                return;
            }
        };
        let options = ShellOptions { max_frames: Some(12), studio: false };
        let (game, exit) = run_with(game, ShellMode::Headless, options).expect("the shell ran");
        assert_eq!(exit.frames, 12);
        assert!(game.runtime.sim().world.ticks > 0, "live play ticked");
        assert!(game.drawn > 1, "the frames drew");
        assert_eq!(game.presented, 0, "a headless run presents nothing");
    }
}
