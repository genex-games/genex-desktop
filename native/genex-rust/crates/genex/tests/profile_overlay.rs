//! The player profile overlay on the facade (G6 PROFILE, PROF-8): the presenter paints it over a
//! window present only, after the HUD and outside the tick, so it is never in a capture or in
//! `state().hud.items`, and showing it changes neither the checksum nor the next tick's HUD. Every
//! row is new behaviour (there was no overlay before PROF-8). genex-hud's own rows (its separate
//! egui context, the chord, the summary view) are in `crates/genex-hud/tests/profile_overlay.rs`.
//!
//! GPU rows: run with `--ignored metal`; `GENEX_REQUIRE_METAL=1` makes a missing adapter a failure.
//! With `GENEX_PROFILE_EVIDENCE_DIR` set to an absolute folder the window rows write their windows
//! there as raw BGRA (`profile-overlay-<shown|hidden>-<w>x<h>.bgra`).

use genex::prelude::*;
use genex::present::Presenter;
use genex::{FIXED_STEP_MS, Runtime, View};
use genex_render::capture::Capture;

const WORLD: [u32; 2] = [480, 270];
const WINDOW: [u32; 2] = [1280, 720];
const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Bgra8Unorm;
const BYTES_PER_PIXEL: u32 = 4;
const FRAME_MS: f64 = 1000.0 / 60.0;
const REQUIRE_METAL_ENV: &str = "GENEX_REQUIRE_METAL";
const EVIDENCE_ENV: &str = "GENEX_PROFILE_EVIDENCE_DIR";

#[derive(Default)]
struct World {
    ticks: u32,
}

/// A cube under a HUD label and a button.
fn game() -> Game<World> {
    let mut game = Game::new(World::default()).world_size(WORLD[0], WORLD[1]).background(Color::rgb(30, 40, 60));
    game.camera(|_| Camera::look_at(vec3(0.0, 2.0, 5.0), Vec3::ZERO));
    game.on_update(|sim, _| sim.world.ticks += 1);
    game.on_draw(|_, frame, _| {
        frame.cube(Transform::IDENTITY, Color::RED);
    });
    game.on_ui(|sim, ui, _| {
        ui.label(format!("Ticks {}", sim.world.ticks));
        let _ = ui.button("Play");
    });
    game
}

/// A runtime whose profiler runs (as a studio run's does), so the overlay has numbers.
fn runtime() -> Runtime<World> {
    let mut rt = Runtime::new(game()).expect("installs");
    rt.profiling().start(true);
    rt
}

fn presenter() -> Option<Presenter> {
    match Presenter::open(WORLD, &[]) {
        Ok(presenter) => Some(presenter),
        Err(error) if std::env::var(REQUIRE_METAL_ENV).is_ok_and(|v| v == "1") => panic!("{REQUIRE_METAL_ENV}=1 but no GPU: {error}"),
        Err(error) => {
            eprintln!("skipped: no WebGPU-core adapter ({error})");
            None
        }
    }
}

/// One Live frame: a tick, the frame drawn, the profiler's frame closed, the window presented into
/// an offscreen texture and read back.
fn live_frame(rt: &mut Runtime<World>, presenter: &mut Presenter) -> Capture {
    rt.step(FIXED_STEP_MS);
    presenter.draw_view(rt, View::Game).expect("a view").expect("a frame");
    rt.profiling().new_frame(FRAME_MS, None);
    present_offscreen(presenter)
}

fn present_offscreen(presenter: &mut Presenter) -> Capture {
    let texture = presenter.gpu().device.create_texture(&wgpu::TextureDescriptor {
        label: Some("profile overlay window"),
        size: wgpu::Extent3d { width: WINDOW[0], height: WINDOW[1], depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: FORMAT,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
    presenter.present(&view, FORMAT, (WINDOW[0], WINDOW[1]));
    read_back(presenter, &texture)
}

fn read_back(presenter: &Presenter, texture: &wgpu::Texture) -> Capture {
    let gpu = presenter.gpu();
    let padded = (WINDOW[0] * BYTES_PER_PIXEL).div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT) * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
    let staging = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("profile overlay readback"),
        size: u64::from(padded) * u64::from(WINDOW[1]),
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("profile overlay readback") });
    encoder.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo { texture, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
        wgpu::TexelCopyBufferInfo {
            buffer: &staging,
            layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(padded), rows_per_image: Some(WINDOW[1]) },
        },
        wgpu::Extent3d { width: WINDOW[0], height: WINDOW[1], depth_or_array_layers: 1 },
    );
    gpu.queue.submit([encoder.finish()]);
    let slice = staging.slice(..);
    let (sender, receiver) = std::sync::mpsc::channel();
    slice.map_async(wgpu::MapMode::Read, move |result| {
        let _ = sender.send(result);
    });
    gpu.device.poll(wgpu::PollType::wait_indefinitely()).expect("the readback finishes");
    receiver.recv().expect("mapped").expect("mapped");
    let data = slice.get_mapped_range().expect("the mapped range").to_vec();
    staging.unmap();
    Capture::from_padded_rows(WINDOW[0], WINDOW[1], padded, &data).expect("a capture")
}

/// A capture of the game view at the world size (the Studio `capture` path).
fn capture(rt: &mut Runtime<World>, presenter: &mut Presenter) -> Vec<u8> {
    presenter.set_capturing(true);
    presenter.draw_view(rt, View::Game).expect("a view").expect("a capture");
    let bgra = presenter.resilient.capture().expect("capture").bgra().to_vec();
    presenter.set_capturing(false);
    bgra
}

/// How many pixels of the window's top-right quarter differ between two windows.
fn corner_changes(a: &Capture, b: &Capture) -> usize {
    let (a, b) = (a.bgra(), b.bgra());
    let mut changed = 0;
    for y in 0..WINDOW[1] / 2 {
        for x in WINDOW[0] / 2..WINDOW[0] {
            let i = ((y * WINDOW[0] + x) * BYTES_PER_PIXEL) as usize;
            if a[i..i + 3] != b[i..i + 3] {
                changed += 1;
            }
        }
    }
    changed
}

/// A window pixel inside the panel below its last line, and one left of the panel (1280x720:
/// the panel spans x 963..1269, y 11..181 at 4/3 pixels a point).
const PANEL_PROBE: [u32; 2] = [1240, 168];
const LEFT_PROBE: [u32; 2] = [900, 168];

/// A window pixel as [r, g, b].
fn rgb(window: &Capture, [x, y]: [u32; 2]) -> [u8; 3] {
    let i = ((y * WINDOW[0] + x) * BYTES_PER_PIXEL) as usize;
    let bgra = window.bgra();
    [bgra[i + 2], bgra[i + 1], bgra[i]]
}

fn keep(name: &str, window: &Capture) {
    let Some(dir) = std::env::var_os(EVIDENCE_ENV) else { return };
    let file = std::path::Path::new(&dir).join(format!("{name}-{}x{}.bgra", WINDOW[0], WINDOW[1]));
    std::fs::write(&file, window.bgra()).expect("write the evidence");
    eprintln!("evidence: {}", file.display());
}

#[test]
#[ignore = "Metal row: run with --ignored metal"]
fn metal_the_overlay_is_painted_over_a_window_present_but_never_in_a_capture_or_hud_items() {
    let Some(mut presenter) = presenter() else { return };
    let mut rt = runtime();
    for _ in 0..3 {
        live_frame(&mut rt, &mut presenter);
    }
    let items_before = rt.state()["hud"]["items"].clone();
    let hidden_capture = capture(&mut rt, &mut presenter);
    let hidden_window = live_frame(&mut rt, &mut presenter);
    keep("profile-overlay-hidden", &hidden_window);
    presenter.profile_overlay.set_shown(true);
    let shown_window = live_frame(&mut rt, &mut presenter);
    keep("profile-overlay-shown", &shown_window);
    eprintln!("top-right pixels that changed: {}", corner_changes(&hidden_window, &shown_window));
    // Inside the panel, below its last line: the panel's dark fill over the blue background.
    let (hidden, shown) = (rgb(&hidden_window, PANEL_PROBE), rgb(&shown_window, PANEL_PROBE));
    eprintln!("panel probe: hidden {hidden:?}, shown {shown:?}");
    assert!(hidden[2] > 40, "the window's background is there without the overlay: {hidden:?}");
    assert!(shown.iter().all(|channel| *channel < 30), "the panel's fill is painted over it: {shown:?}");
    // Left of the panel nothing changes but the frame's own noise.
    let (left_hidden, left_shown) = (rgb(&hidden_window, LEFT_PROBE), rgb(&shown_window, LEFT_PROBE));
    let near = left_hidden.iter().zip(left_shown).all(|(a, b)| a.abs_diff(b) <= 3);
    assert!(near, "outside the panel the window is the same: {left_hidden:?} vs {left_shown:?}");
    // The same tick captured with the overlay shown is the same picture.
    let mut twin = runtime();
    let mut twin_presenter = presenter_for_twin();
    for _ in 0..3 {
        live_frame(&mut twin, &mut twin_presenter);
    }
    twin_presenter.profile_overlay.set_shown(true);
    let shown_capture = capture(&mut twin, &mut twin_presenter);
    assert!(hidden_capture == shown_capture, "a capture never carries the overlay");
    assert_eq!(twin.state()["hud"]["items"], items_before, "the overlay's words are never HUD items");
}

/// A second presenter for the twin run (the first is already open, so the GPU is there).
fn presenter_for_twin() -> Presenter {
    presenter().expect("the GPU the first presenter opened")
}

#[test]
#[ignore = "Metal row: run with --ignored metal"]
fn metal_showing_the_overlay_changes_neither_the_checksum_nor_the_next_ticks_hud() {
    let Some(mut shown_presenter) = presenter() else { return };
    let mut still_presenter = presenter_for_twin();
    let (mut shown, mut still) = (runtime(), runtime());
    shown_presenter.profile_overlay.set_shown(true);
    for frame in 0..8 {
        if frame == 4 {
            shown_presenter.profile_overlay.set_shown(false);
        }
        live_frame(&mut shown, &mut shown_presenter);
        live_frame(&mut still, &mut still_presenter);
        assert_eq!(shown.checksum(), still.checksum(), "frame {frame}");
        assert_eq!(shown.state()["hud"], still.state()["hud"], "frame {frame}: the next tick's HUD");
    }
}
