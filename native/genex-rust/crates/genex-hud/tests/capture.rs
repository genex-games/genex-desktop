//! The HUD is painted into captures, and a capture does not depend on the shell's mode: one game
//! with a fixed seed, run through `genex_platform_desktop::run` headless and then windowed, gives
//! the same capture digest (Q1: one binary, two modes, one frame path).
//!
//! A plain `main` (`harness = false`): winit's EventLoop must be created on the main thread, which
//! libtest's worker threads are not. Needs a GPU adapter: without one the test skips, unless
//! `GENEX_REQUIRE_METAL=1`. The windowed half needs a display: opt in with
//! `GENEX_SHELL_WINDOWED_SMOKE=1`.

use genex_hud::{Color, Hud, HudInput, HudPainter};
use genex_platform_desktop::{FrameControl, ShellFrame, ShellGame, ShellMode, run};
use std::future::Future;
use std::pin::pin;
use std::sync::mpsc;
use std::task::{Context, Poll, Waker};

const WORLD: [u32; 2] = [320, 180];
const FRAMES: u64 = 8;
const SEED: u32 = 7;
const BYTES_PER_PIXEL: u32 = 4;
/// The world under the HUD: a flat colour, so every other pixel is the HUD's.
const CLEAR: wgpu::Color = wgpu::Color { r: 0.1, g: 0.2, b: 0.3, a: 1.0 };
const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Bgra8Unorm;
const REQUIRE_GPU_ENV: &str = "GENEX_REQUIRE_METAL";
const WINDOWED_ENV: &str = "GENEX_SHELL_WINDOWED_SMOKE";

/// wgpu's native futures resolve without a runtime; poll until they do.
fn block_on<F: Future>(future: F) -> F::Output {
    let mut future = pin!(future);
    let mut context = Context::from_waker(Waker::noop());
    loop {
        if let Poll::Ready(value) = future.as_mut().poll(&mut context) {
            return value;
        }
        std::thread::yield_now();
    }
}

fn open_gpu() -> Option<(wgpu::Device, wgpu::Queue)> {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: wgpu::Backends::PRIMARY,
        ..wgpu::InstanceDescriptor::new_without_display_handle()
    });
    let adapter = block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default())).ok()?;
    block_on(adapter.request_device(&wgpu::DeviceDescriptor::default())).ok()
}

#[derive(Debug)]
struct Shop {
    coins: u32,
    bait: u32,
}

/// A game that ignores real input: its clicks come from a script, as a Studio run's come from the
/// host's `input` op, so both modes see the same ticks.
struct CaptureGame {
    device: wgpu::Device,
    queue: wgpu::Queue,
    target: wgpu::Texture,
    painter: HudPainter,
    hud: Hud,
    shop: Shop,
    tick: u64,
    hud_draws: usize,
    capture: Option<Vec<u8>>,
}

impl CaptureGame {
    fn new(device: wgpu::Device, queue: wgpu::Queue) -> CaptureGame {
        let target = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("world"),
            size: wgpu::Extent3d { width: WORLD[0], height: WORLD[1], depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let painter = HudPainter::new(&device, FORMAT);
        CaptureGame {
            device,
            queue,
            target,
            painter,
            hud: Hud::new(),
            shop: Shop { coins: 10 + SEED, bait: 0 },
            tick: 0,
            hud_draws: 0,
            capture: None,
        }
    }

    /// Odd ticks click "Buy bait" where the last tick drew it.
    fn scripted_input(&self) -> HudInput {
        let button = self.hud.widgets().iter().find(|w| w.label == "Buy bait");
        match button {
            Some(button) if self.tick % 2 == 1 => HudInput {
                pointer: button.center_fraction(WORLD),
                primary_pressed: true,
                primary_released: true,
                ..HudInput::default()
            },
            _ => HudInput::default(),
        }
    }

    /// Clear the world target, paint the HUD over it at one device pixel per world pixel (a
    /// capture's scale) and read it back.
    fn capture_world(&mut self) -> Vec<u8> {
        let view = self.target.create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
        encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("world"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Clear(CLEAR), store: wgpu::StoreOp::Store },
            })],
            ..wgpu::RenderPassDescriptor::default()
        });
        let mut paint = self.hud.paint(1.0);
        self.hud_draws = self.painter.draw(&self.device, &self.queue, &mut encoder, &view, WORLD, &mut paint);
        let row = WORLD[0] * BYTES_PER_PIXEL;
        let size = u64::from(row * WORLD[1]);
        let staging = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("readback"),
            size,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        encoder.copy_texture_to_buffer(
            self.target.as_image_copy(),
            wgpu::TexelCopyBufferInfo {
                buffer: &staging,
                layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(row), rows_per_image: Some(WORLD[1]) },
            },
            wgpu::Extent3d { width: WORLD[0], height: WORLD[1], depth_or_array_layers: 1 },
        );
        self.queue.submit([encoder.finish()]);
        let slice = staging.slice(..);
        let (sender, receiver) = mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |result| sender.send(result).expect("receiver"));
        self.device.poll(wgpu::PollType::wait_indefinitely()).expect("poll");
        receiver.recv().expect("mapped").expect("map");
        let bytes = slice.get_mapped_range().expect("range").to_vec();
        staging.unmap();
        bytes
    }
}

impl ShellGame for CaptureGame {
    fn title(&self) -> String {
        "genex-hud capture".to_owned()
    }

    fn world_size(&self) -> [u32; 2] {
        WORLD
    }

    fn frame(&mut self, _frame: ShellFrame) -> FrameControl {
        let input = self.scripted_input();
        let shop = &mut self.shop;
        let seconds = self.tick as f64 / 60.0;
        self.hud.run(WORLD, seconds, &input, |ui| {
            ui.label(format!("Coins: {}", shop.coins));
            if ui.button("Buy bait").clicked() && shop.coins > 0 {
                shop.coins -= 1;
                shop.bait += 1;
            }
        });
        self.hud.text(&format!("bait {}", self.shop.bait), 8, 150, 16, Color::YELLOW);
        self.hud.bar("line", 0.5, 200, 150, 100, 10, Color::GREEN);
        self.hud.end_frame(WORLD);
        self.tick += 1;
        if self.tick == FRAMES {
            self.capture = Some(self.capture_world());
        }
        FrameControl::Continue
    }
}

struct Run {
    digest: String,
    frames: u64,
    shop: String,
    hud_draws: usize,
    hud_pixels: usize,
}

fn digest(bytes: &[u8]) -> String {
    let hash = bytes.iter().fold(0xcbf2_9ce4_8422_2325_u64, |h, b| (h ^ u64::from(*b)).wrapping_mul(0x100_0000_01b3));
    format!("{hash:016x}")
}

fn capture_in(mode: ShellMode, device: wgpu::Device, queue: wgpu::Queue) -> Run {
    let (game, exit) = run(CaptureGame::new(device, queue), mode, Some(FRAMES)).expect("the shell ran");
    let bytes = game.capture.expect("the last frame captured");
    let clear = [(CLEAR.b * 255.0).round() as u8, (CLEAR.g * 255.0).round() as u8, (CLEAR.r * 255.0).round() as u8];
    let hud_pixels = bytes.as_chunks::<4>().0.iter().filter(|px| px[..3] != clear).count();
    Run { digest: digest(&bytes), frames: exit.frames, shop: format!("{:?}", game.shop), hud_draws: game.hud_draws, hud_pixels }
}

fn main() {
    let require_gpu = std::env::var(REQUIRE_GPU_ENV).is_ok_and(|v| v == "1");
    let Some((device, queue)) = open_gpu() else {
        assert!(!require_gpu, "{REQUIRE_GPU_ENV}=1 but no GPU adapter");
        eprintln!("capture: skipped, no GPU adapter (set {REQUIRE_GPU_ENV}=1 to fail instead)");
        return;
    };
    let headless = capture_in(ShellMode::Headless, device.clone(), queue.clone());
    assert_eq!(headless.frames, FRAMES);
    assert_eq!(headless.shop, "Shop { coins: 13, bait: 4 }", "four scripted purchases landed");
    assert!(headless.hud_draws > 0, "the HUD drew into the capture");
    assert!(headless.hud_pixels > 200, "the HUD's pixels are in the capture: {}", headless.hud_pixels);
    let again = capture_in(ShellMode::Headless, device.clone(), queue.clone());
    assert_eq!(again.digest, headless.digest, "a fresh HUD and painter repeat the capture");
    println!("capture headless digest={} hud_pixels={} draws={}", headless.digest, headless.hud_pixels, headless.hud_draws);
    if std::env::var_os(WINDOWED_ENV).is_none() {
        eprintln!("capture: windowed half skipped (set {WINDOWED_ENV}=1 on a machine with a display)");
        return;
    }
    let windowed = capture_in(ShellMode::Windowed, device, queue);
    assert_eq!(windowed.frames, FRAMES);
    assert_eq!(windowed.shop, headless.shop);
    assert_eq!(windowed.digest, headless.digest, "headless and windowed captures are identical");
    println!("capture windowed digest={} (identical)", windowed.digest);
}
