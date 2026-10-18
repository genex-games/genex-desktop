//! The window present (renderer pass 2, P2-0.9 step A; findings F1/RC-03): the world target is
//! letterboxed into a window through FSR1 EASU + RCAS when the window is larger than the world,
//! through a Catmull-Rom filter when it is smaller, and texel for texel only when the sizes match.
//! A nearest-texel stretch at a non-integer ratio gave every window and phone uneven pixel columns
//! and turned a one-texel shadow change into a 2-3 px block.
//!
//! Real-GPU rows, `#[ignore]`d so a machine without a GPU skips them; every name contains `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 bash scripts/spike/rust-wgpu/rust-env.sh cargo test -p genex-render \
//!     --offline --locked --test present -- --ignored metal

use genex_render::capture::Capture;
use genex_render::device_loss::Resilient;
use genex_render::immediate::{ImmediateFrame, Rect2d};
use genex_render::letterbox::{Viewport, letterbox};
use genex_render::overlay::OverlayPainter;
use genex_render::post::fsr::{estimated_cost_ms, gpu_ms};
use genex_render::scene::{CameraDesc, Material, MeshId, PointLight, Scene, scaled, translation};
use genex_render::renderer::Renderer;
use genex_render::{CullPath, Gpu, RenderOptions, WORLD_FORMAT};

/// The world a larger window shows: 2.5 window pixels per world pixel on the 800x450 window, a
/// ratio no nearest stretch can draw evenly.
const SMALL_WORLD: (u32, u32) = (320, 180);
const LARGE_WINDOW: (u32, u32) = (800, 450);
/// The world a smaller window shows, at half its size.
const LARGE_WORLD: (u32, u32) = (640, 360);
const SMALL_WINDOW: (u32, u32) = (320, 180);
/// The most of a view's columns (and rows) that may repeat their neighbour exactly: a nearest
/// stretch at 2.5x repeats three in five.
const DUPLICATE_SHARE_MAX: f64 = 0.01;
/// How much closer to the area average than a nearest pick a smaller window must be.
const DOWNSCALE_ERROR_RATIO_MAX: f64 = 0.75;
/// The most an sRGB window's bytes may differ from a UNORM window's (the decode round trip).
const SRGB_DIFFERENCE_MAX: u8 = 1;
const REQUIRE_METAL_ENV: &str = "GENEX_REQUIRE_METAL";
const BYTES_PER_PIXEL: u32 = 4;

fn gpu() -> Option<Gpu> {
    let require = std::env::var(REQUIRE_METAL_ENV).is_ok_and(|v| v == "1");
    match Gpu::headless() {
        Ok(gpu) => {
            if require {
                assert_eq!(gpu.receipt().backend, "metal", "{REQUIRE_METAL_ENV}=1 but the adapter is not Metal");
            }
            Some(gpu)
        }
        Err(error) if require => panic!("{REQUIRE_METAL_ENV}=1 and no WebGPU-core adapter: {error}"),
        Err(error) => {
            eprintln!("skipped: no WebGPU-core adapter ({error})");
            None
        }
    }
}

/// Lit cubes and spheres in rows on a floor: hard silhouettes, highlights and thin gaps, so a
/// filter's choices show at every edge.
fn detailed_scene() -> Scene {
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 4.0, 10.0], [0.0, 0.5, 0.0]), [18, 20, 28, 255]);
    scene.lighting.points.push(PointLight { position: [2.0, 4.0, 3.0], range: 14.0, color: [255, 220, 170], intensity: 4.0 });
    let colors = [[230, 41, 55, 255], [0, 228, 48, 255], [0, 121, 241, 255], [253, 249, 0, 255], [255, 255, 255, 255]];
    for row in 0..4 {
        for (i, color) in colors.iter().enumerate() {
            let x = i as f32 * 1.6 - 3.2 + row as f32 * 0.3;
            let z = -(row as f32) * 1.8;
            let mesh = if (row + i) % 2 == 0 { MeshId::CUBE } else { MeshId::SPHERE };
            scene.draw(mesh, translation(x, 0.0, z), Material::color(*color).with_pbr(0.2 * (row % 3) as f32, 0.35));
        }
    }
    scene.draw(MeshId::CUBE, scaled([0.0, -0.75, -2.5], [14.0, 0.2, 12.0]), Material::color([90, 90, 100, 255]));
    scene
}

/// A resilient renderer (the one every shell presents through) that drew the detailed scene at
/// `world` size.
fn drawn(gpu: Gpu, world: (u32, u32)) -> Resilient {
    let mut resilient = Resilient::new(gpu, world.0, world.1, RenderOptions::default(), Gpu::headless).expect("resilient renderer");
    resilient.render(&ImmediateFrame::from_scene(detailed_scene()), CullPath::Gpu, None).expect("frame");
    resilient
}

/// An offscreen window of `size` in `format` that can be read back.
fn window_texture(gpu: &Gpu, size: (u32, u32), format: wgpu::TextureFormat) -> wgpu::Texture {
    gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("present test window"),
        size: wgpu::Extent3d { width: size.0, height: size.1, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    })
}

/// A four-byte texture of `size` read back, rows top to bottom.
fn read(gpu: &Gpu, texture: &wgpu::Texture, size: (u32, u32)) -> Capture {
    let (width, height) = size;
    let padded = (width * BYTES_PER_PIXEL).div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT) * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
    let staging = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("present test readback"),
        size: u64::from(padded) * u64::from(height),
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("present test readback") });
    encoder.copy_texture_to_buffer(
        texture.as_image_copy(),
        wgpu::TexelCopyBufferInfo { buffer: &staging, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(padded), rows_per_image: Some(height) } },
        wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
    );
    gpu.queue.submit([encoder.finish()]);
    let slice = staging.slice(..);
    slice.map_async(wgpu::MapMode::Read, |result| result.expect("mapped"));
    gpu.device.poll(wgpu::PollType::wait_indefinitely()).expect("poll");
    let data = slice.get_mapped_range().expect("mapped range").to_vec();
    Capture::from_padded_rows(width, height, padded, &data).expect("capture")
}

/// Present `resilient`'s world into an offscreen `window` of `format` and read it back.
fn present(resilient: &mut Resilient, window: (u32, u32), format: wgpu::TextureFormat) -> Capture {
    let texture = window_texture(resilient.gpu(), window, format);
    let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
    resilient.present(&view, format, window);
    read(resilient.gpu(), &texture, window)
}

fn px(capture: &Capture, x: u32, y: u32) -> [u8; 4] {
    let i = ((y * capture.width() + x) * BYTES_PER_PIXEL) as usize;
    capture.bgra()[i..i + 4].try_into().expect("pixel")
}

/// The share of the view's columns that repeat the column to their right exactly, and the same
/// for its rows, among the lines that are not one flat colour (a flat sky row repeats under any
/// filter): a nearest stretch repeats whole columns and rows; a filter almost never does.
fn duplicate_shares(window: &Capture, view: Viewport) -> (f64, f64) {
    let column = |x: u32| (view.y..view.y + view.height).map(move |y| px(window, x, y));
    let row = |y: u32| (view.x..view.x + view.width).map(move |x| px(window, x, y));
    let share = |lines: u32, line: &dyn Fn(u32) -> Vec<[u8; 4]>| {
        let (mut detailed, mut repeated) = (0_u32, 0_u32);
        for i in 0..lines - 1 {
            let this = line(i);
            if this.iter().all(|p| *p == this[0]) {
                continue;
            }
            detailed += 1;
            repeated += u32::from(this == line(i + 1));
        }
        f64::from(repeated) / f64::from(detailed.max(1))
    };
    let columns = share(view.width, &|i| column(view.x + i).collect());
    let rows = share(view.height, &|i| row(view.y + i).collect());
    (columns, rows)
}

/// Luma of a BGRA pixel, 0..255.
fn luma(p: [u8; 4]) -> f64 {
    0.0722 * f64::from(p[0]) + 0.7152 * f64::from(p[1]) + 0.2126 * f64::from(p[2])
}

/// A `world` capture stretched bilinearly to `view`'s size on the CPU (texel centres at i + 0.5).
fn bilinear(world: &Capture, view: Viewport) -> Vec<f64> {
    let (ww, wh) = (world.width(), world.height());
    let sample = |x: i64, y: i64| luma(px(world, x.clamp(0, i64::from(ww) - 1) as u32, y.clamp(0, i64::from(wh) - 1) as u32));
    let mut out = Vec::with_capacity((view.width * view.height) as usize);
    for y in 0..view.height {
        for x in 0..view.width {
            let u = (f64::from(x) + 0.5) * f64::from(ww) / f64::from(view.width) - 0.5;
            let v = (f64::from(y) + 0.5) * f64::from(wh) / f64::from(view.height) - 0.5;
            let (x0, y0) = (u.floor() as i64, v.floor() as i64);
            let (fx, fy) = (u - u.floor(), v - v.floor());
            let top = sample(x0, y0) * (1.0 - fx) + sample(x0 + 1, y0) * fx;
            let bottom = sample(x0, y0 + 1) * (1.0 - fx) + sample(x0 + 1, y0 + 1) * fx;
            out.push(top * (1.0 - fy) + bottom * fy);
        }
    }
    out
}

/// The mean absolute Laplacian of a `width`-wide luma image's interior: how much fine detail it
/// keeps (a blur lowers it).
fn sharpness(luma: &[f64], width: u32, height: u32) -> f64 {
    let at = |x: u32, y: u32| luma[(y * width + x) as usize];
    let mut sum = 0.0;
    for y in 1..height - 1 {
        for x in 1..width - 1 {
            sum += (4.0 * at(x, y) - at(x - 1, y) - at(x + 1, y) - at(x, y - 1) - at(x, y + 1)).abs();
        }
    }
    sum / f64::from((width - 2) * (height - 2))
}

/// The view's luma, rows top to bottom.
fn view_luma(window: &Capture, view: Viewport) -> Vec<f64> {
    (view.y..view.y + view.height).flat_map(|y| (view.x..view.x + view.width).map(move |x| luma(px(window, x, y)))).collect()
}

/// Whether every window pixel outside `view` is opaque black.
fn bars_are_black(window: &Capture, view: Viewport) -> bool {
    let inside = |x: u32, y: u32| x >= view.x && x < view.x + view.width && y >= view.y && y < view.y + view.height;
    (0..window.height()).all(|y| (0..window.width()).all(|x| inside(x, y) || px(window, x, y) == [0, 0, 0, 255]))
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_larger_window_shows_the_world_upscaled_and_sharp_not_nearest_blocky() {
    let Some(gpu) = gpu() else { return };
    let mut resilient = drawn(gpu, SMALL_WORLD);
    let world = resilient.capture().expect("world");
    let window = present(&mut resilient, LARGE_WINDOW, WORLD_FORMAT);
    let view = letterbox(LARGE_WINDOW, SMALL_WORLD);
    let (columns, rows) = duplicate_shares(&window, view);
    let presented = sharpness(&view_luma(&window, view), view.width, view.height);
    let reference = sharpness(&bilinear(&world, view), view.width, view.height);
    eprintln!("2.5x: repeated columns {:.3}, rows {:.3}; sharpness {presented:.3} (bilinear {reference:.3})", columns, rows);
    assert!(columns <= DUPLICATE_SHARE_MAX && rows <= DUPLICATE_SHARE_MAX, "nearest-blocky: {columns:.3} of columns and {rows:.3} of rows repeat");
    assert!(presented >= reference, "softer than a bilinear stretch: {presented:.3} < {reference:.3}");
    assert!(bars_are_black(&window, view), "nothing outside the letterbox");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_letterboxed_larger_window_keeps_black_bars_and_the_upscale() {
    let Some(gpu) = gpu() else { return };
    let mut resilient = drawn(gpu, SMALL_WORLD);
    // Wider than 16:9: bars left and right, the world at 2.5x between them.
    let window_size = (LARGE_WINDOW.0 + 101, LARGE_WINDOW.1);
    let window = present(&mut resilient, window_size, WORLD_FORMAT);
    let view = letterbox(window_size, SMALL_WORLD);
    assert!(view.x > 0, "the window has side bars: {view:?}");
    assert!(bars_are_black(&window, view), "the bars stay black");
    let (columns, rows) = duplicate_shares(&window, view);
    assert!(columns <= DUPLICATE_SHARE_MAX && rows <= DUPLICATE_SHARE_MAX, "nearest-blocky: {columns:.3} / {rows:.3}");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_smaller_window_shows_the_world_filtered_not_decimated() {
    let Some(gpu) = gpu() else { return };
    let mut resilient = drawn(gpu, LARGE_WORLD);
    let world = resilient.capture().expect("world");
    let window = present(&mut resilient, SMALL_WINDOW, WORLD_FORMAT);
    let view = letterbox(SMALL_WINDOW, LARGE_WORLD);
    let (sx, sy) = (LARGE_WORLD.0 / view.width, LARGE_WORLD.1 / view.height);
    let mut presented = 0.0;
    let mut nearest = 0.0;
    for y in 0..view.height {
        for x in 0..view.width {
            // The area average of the world texels under the window pixel, and the one texel a
            // nearest pick takes (the centre's: floor((x + 0.5) * scale)).
            let mut area = 0.0;
            for dy in 0..sy {
                for dx in 0..sx {
                    area += luma(px(&world, x * sx + dx, y * sy + dy));
                }
            }
            area /= f64::from(sx * sy);
            let picked = luma(px(&world, (x * 2 + 1) * sx / 2, (y * 2 + 1) * sy / 2));
            presented += (luma(px(&window, view.x + x, view.y + y)) - area).powi(2);
            nearest += (picked - area).powi(2);
        }
    }
    let ratio = (presented / nearest).sqrt();
    eprintln!("0.5x: error against the area average {:.3} of a nearest pick's", ratio);
    assert!(ratio <= DOWNSCALE_ERROR_RATIO_MAX, "decimated: {ratio:.3} of the nearest pick's error");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_window_the_worlds_size_shows_it_texel_for_texel() {
    let Some(gpu) = gpu() else { return };
    let mut resilient = drawn(gpu, SMALL_WORLD);
    let world = resilient.capture().expect("world");
    // Taller than 16:9: bars above and below, the world at 1x between them.
    let window_size = (SMALL_WORLD.0, SMALL_WORLD.1 + 60);
    let window = present(&mut resilient, window_size, WORLD_FORMAT);
    let view = letterbox(window_size, SMALL_WORLD);
    assert_eq!((view.width, view.height), SMALL_WORLD);
    for y in 0..view.height {
        for x in 0..view.width {
            assert_eq!(px(&window, view.x + x, view.y + y), px(&world, x, y), "texel ({x}, {y})");
        }
    }
    assert!(bars_are_black(&window, view));
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_every_present_of_one_world_is_the_same_picture() {
    let Some(gpu) = gpu() else { return };
    let mut resilient = drawn(gpu, SMALL_WORLD);
    for window in [LARGE_WINDOW, (SMALL_WORLD.0 / 2, SMALL_WORLD.1 / 2)] {
        let first = present(&mut resilient, window, WORLD_FORMAT);
        let second = present(&mut resilient, window, WORLD_FORMAT);
        assert_eq!(first.digest(), second.digest(), "{window:?}");
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_an_srgb_window_shows_the_same_picture_as_a_unorm_one() {
    let Some(gpu) = gpu() else { return };
    let mut resilient = drawn(gpu, SMALL_WORLD);
    for window in [LARGE_WINDOW, SMALL_WORLD, (SMALL_WORLD.0 / 2, SMALL_WORLD.1 / 2)] {
        let unorm = present(&mut resilient, window, WORLD_FORMAT);
        let srgb = present(&mut resilient, window, wgpu::TextureFormat::Bgra8UnormSrgb);
        let worst = unorm.bgra().iter().zip(srgb.bgra()).map(|(a, b)| a.abs_diff(*b)).max().unwrap_or(0);
        assert!(worst <= SRGB_DIFFERENCE_MAX, "{window:?}: an sRGB window differs by {worst}");
    }
}

/// A HUD stand-in: a scissored full-screen draw that fills a rectangle of its target white, pixel
/// exact, so where it lands in the window shows which pixels it was painted at.
const WHITE_WGSL: &str = "
@vertex
fn vs(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
    let uv = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
    return vec4<f32>(uv * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn fs() -> @location(0) vec4<f32> {
    return vec4<f32>(1.0);
}
";

struct WhiteRect {
    /// Left, top, width, height in the target's pixels.
    rect: [u32; 4],
    /// The target sizes it was handed.
    sizes: Vec<[u32; 2]>,
}

impl OverlayPainter for WhiteRect {
    fn paint(&mut self, gpu: &Gpu, encoder: &mut wgpu::CommandEncoder, target: &wgpu::TextureView, size: [u32; 2]) -> u32 {
        self.sizes.push(size);
        let module = gpu.device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("white rect"), source: wgpu::ShaderSource::Wgsl(WHITE_WGSL.into()) });
        let pipeline = gpu.device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("white rect"),
            layout: None,
            vertex: wgpu::VertexState { module: &module, entry_point: Some("vs"), compilation_options: Default::default(), buffers: &[] },
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState {
                module: &module,
                entry_point: Some("fs"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState { format: WORLD_FORMAT, blend: None, write_mask: wgpu::ColorWrites::ALL })],
            }),
            multiview_mask: None,
            cache: None,
        });
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("white rect"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: target,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store },
            })],
            ..Default::default()
        });
        let [x, y, width, height] = self.rect;
        pass.set_pipeline(&pipeline);
        pass.set_scissor_rect(x, y, width, height);
        pass.draw(0..3, 0..1);
        1
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_overlay_is_painted_after_the_upscale_at_window_pixels() {
    let Some(gpu) = gpu() else { return };
    let mut resilient = drawn(gpu, SMALL_WORLD);
    let window_size = (LARGE_WINDOW.0 + 101, LARGE_WINDOW.1);
    let view = letterbox(window_size, SMALL_WORLD);
    let texture = window_texture(resilient.gpu(), window_size, WORLD_FORMAT);
    let target = texture.create_view(&wgpu::TextureViewDescriptor::default());
    // Seven by five window pixels in the dark sky at the top left: not a whole number of world
    // texels at 2.5x, so only a paint after the upscale lands on exactly these pixels.
    let [left, top, width, height] = [11, 5, 7, 5];
    let mut hud = WhiteRect { rect: [left, top, width, height], sizes: Vec::new() };
    let drawn = resilient.present_with(&target, WORLD_FORMAT, window_size, Some(&mut hud));
    let window = read(resilient.gpu(), &texture, window_size);
    assert_eq!(drawn, 1, "the overlay's draws are answered");
    assert_eq!(hud.sizes, vec![[view.width, view.height]], "the overlay paints at the letterbox's window pixels, once");
    let white = [255, 255, 255, 255];
    for y in top..top + height {
        for x in left..left + width {
            assert_eq!(px(&window, view.x + x, view.y + y), white, "({x}, {y}) inside the overlay");
        }
        assert_ne!(px(&window, view.x + left - 1, view.y + y), white, "left of the overlay, row {y}");
        assert_ne!(px(&window, view.x + left + width, view.y + y), white, "right of the overlay, row {y}");
    }
    assert!(bars_are_black(&window, view), "the overlay stays inside the letterbox");
}

/// The window present's upscale (EASU + RCAS, the same passes as the frame graph's FSR1 node) from
/// the template's and the Lakeside's worlds to 1080p, 1440p and 4K windows on the budget line
/// scaled by the window's pixels ([`estimated_cost_ms`]: 0.3 ms at 1080p). The best of three runs'
/// p95, as the frame graph's own row takes it.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_window_upscale_holds_the_fsr1_budget_at_1080p_1440p_and_4k() {
    let Some(gpu) = gpu() else { return };
    let cases = [((960, 540), (1920, 1080)), ((1280, 720), (2560, 1440)), ((960, 540), (2560, 1440)), ((1280, 720), (3840, 2160)), ((960, 540), (3840, 2160))];
    for (world, window) in cases {
        let mut best: Option<Vec<f32>> = None;
        for _ in 0..3 {
            let Some(mut run) = gpu_ms(&gpu, world, window, 60).expect("timed") else {
                eprintln!("skipped: the device has no TIMESTAMP_QUERY");
                return;
            };
            run.sort_by(f32::total_cmp);
            let tail = |costs: &[f32]| costs[((costs.len() - 1) as f32 * 0.95).round() as usize];
            if best.as_ref().is_none_or(|kept| tail(&run) < tail(kept)) {
                best = Some(run);
            }
        }
        let costs = best.expect("three runs");
        let p = |q: f32| costs[((costs.len() - 1) as f32 * q).round() as usize];
        let (p50, p95, budget) = (p(0.5), p(0.95), estimated_cost_ms(window));
        eprintln!("window upscale {}x{} -> {}x{}: p50 {p50:.3} ms, p95 {p95:.3} ms (budget {budget:.3} ms)", world.0, world.1, window.0, window.1);
        assert!(p95 <= budget, "{world:?} -> {window:?}: p95 {p95} ms over {budget} ms");
    }
}

/// Step B (P2-0.9): `Renderer::present` and `present_to_texture` (test helpers, `FrameRenderer::
/// present_repeat`) go through the window present too. On the port head they kept the nearest
/// blit, so a 320x180 world in an 800x450 window repeated three columns and rows in five.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_renderer_s_own_present_is_filtered_too() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = Renderer::new(&gpu, SMALL_WORLD.0, SMALL_WORLD.1).expect("renderer");
    renderer.render(&gpu, &detailed_scene(), CullPath::Gpu).expect("frame");
    let window = renderer.present_to_texture(&gpu, LARGE_WINDOW).expect("present");
    let view = letterbox(LARGE_WINDOW, SMALL_WORLD);
    let (columns, rows) = duplicate_shares(&window, view);
    eprintln!("Renderer::present at 2.5x: repeated columns {columns:.3}, rows {rows:.3}");
    assert!(columns <= DUPLICATE_SHARE_MAX && rows <= DUPLICATE_SHARE_MAX, "nearest-blocky: {columns:.3} / {rows:.3}");
}

/// Step B (P2-0.9; findings F1/RC-03): a renderer drawn at twice its world (Live at the window's
/// pixels, a capture asked at twice the size) keeps the immediate 2D layer in the world's own
/// pixels: a rectangle at world (40, 20) sized 80x40 covers (80, 40) to (240, 120).
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_an_output_twice_the_world_keeps_the_2d_layer_in_world_pixels() {
    let Some(gpu) = gpu() else { return };
    let mut resilient = Resilient::new(gpu, SMALL_WORLD.0, SMALL_WORLD.1, RenderOptions::default(), Gpu::headless).expect("resilient renderer");
    let output = (SMALL_WORLD.0 * 2, SMALL_WORLD.1 * 2);
    resilient.renderer_mut().renderer_mut().set_output_size(output).expect("output size");
    let mut frame = ImmediateFrame::from_scene(detailed_scene());
    frame.rect(Rect2d::new(40.0, 20.0, 80.0, 40.0), [255, 255, 255, 255]);
    resilient.render(&frame, CullPath::Gpu, None).expect("frame");
    let renderer = resilient.renderer().renderer();
    assert_eq!(renderer.logical_size(), SMALL_WORLD, "the world stays the logical size");
    assert_eq!(renderer.size(), output);
    let shot = resilient.capture().expect("capture");
    assert_eq!((shot.width(), shot.height()), output, "drawn at the output size");
    const WHITE: [u8; 4] = [255, 255, 255, 255];
    for (x, y) in [(81, 41), (238, 41), (81, 118), (238, 118), (160, 80)] {
        assert_eq!(px(&shot, x, y), WHITE, "inside the rectangle at ({x}, {y})");
    }
    for (x, y) in [(78, 80), (242, 80), (160, 38), (160, 122), (41, 21)] {
        assert_ne!(px(&shot, x, y), WHITE, "outside the rectangle at ({x}, {y})");
    }
}

/// An output size set after a frame applies from the next one: until then a capture and a present
/// read the world target at the size it was drawn at, and the next frame draws the new size.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_an_output_size_applies_from_the_next_frame() {
    let Some(gpu) = gpu() else { return };
    let mut resilient = drawn(gpu, SMALL_WORLD);
    let before = resilient.capture().expect("world");
    resilient.renderer_mut().renderer_mut().set_output_size(LARGE_WINDOW).expect("output size");
    let still = resilient.capture().expect("the drawn frame");
    assert_eq!(still.digest(), before.digest(), "the frame already drawn, at its own size");
    let window = present(&mut resilient, SMALL_WORLD, WORLD_FORMAT);
    assert_eq!(window.digest(), before.digest(), "presented texel for texel at the drawn size");
    resilient.render(&ImmediateFrame::from_scene(detailed_scene()), CullPath::Gpu, None).expect("frame");
    let next = resilient.capture().expect("next frame");
    assert_eq!((next.width(), next.height()), LARGE_WINDOW, "the next frame at the new size");
}
