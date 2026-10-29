//! Froxel volumetric fog and sun shafts (renderer pass 2 A.5, `genex_render::froxel`). Real-GPU
//! rows (`#[ignore]`d, every name contains `metal`) hold the plan's acceptance on the renderer: the
//! sun's shadow carves shafts out of the fog, the fogged horizon keeps the analytic fog's colour,
//! a settled capture is the same bytes twice, a still camera does not shimmer, and the volume stays
//! within its budget:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked --test froxel -- --ignored metal
//!
//! `GENEX_FROXEL_EVIDENCE_DIR` receives each compared frame as a `.ppm`; `GENEX_PERF_OUT` the cost
//! row as JSON.

use genex_render::Gpu;
use genex_render::device_class::DeviceClass;
use genex_render::presets::preset_quality;
use genex_render::scene::{CameraDesc, Material, MeshId, Scene, scaled};
use genex_render::settings::{Environment, Fog, Look, Quality, QualityPreset};

fn gpu() -> Option<Gpu> {
    let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
    match Gpu::headless() {
        Ok(gpu) => {
            if require {
                assert_eq!(gpu.receipt().backend, "metal", "GENEX_REQUIRE_METAL=1 but the adapter is not Metal");
            }
            Some(gpu)
        }
        Err(error) if require => panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}"),
        Err(error) => {
            eprintln!("skipped: no WebGPU-core adapter ({error})");
            None
        }
    }
}

fn desktop(preset: QualityPreset) -> Quality {
    preset_quality(preset, DeviceClass::from_wire("desktop-high").expect("class"))
}

/// Uniform white fog, 3% of the light a metre (about 78% opacity over the 50 m to the backdrop).
fn foggy_look() -> Look {
    Look::default().with_fog(Fog::default().with_density(0.03).with_height(0.0, 0.0).with_range(0.0, 1.0))
}

fn renderer(gpu: &Gpu, (width, height): (u32, u32), quality: &Quality) -> genex_render::Renderer {
    let mut renderer = genex_render::Renderer::with_options(gpu, width, height, genex_render::RenderOptions { msaa: false }).expect("renderer");
    renderer.set_scene_format(genex_render::settings::SceneFormat::Rgba16Float);
    renderer.set_quality(quality);
    renderer.set_look(foggy_look());
    renderer.set_environment(&Environment::sky());
    renderer
}

/// The linear HDR scene after `frames` frames at frame indices 0.. (a settled capture's
/// re-renders: the environment baked whole, the histories started at index 0).
fn settled(renderer: &mut genex_render::Renderer, gpu: &Gpu, scene: &Scene, frames: u64) -> Vec<[f32; 4]> {
    renderer.set_environment_settle(true);
    for index in 0..frames {
        renderer.set_frame_index(index);
        renderer.render(gpu, scene, genex_render::CullPath::Gpu).expect("frame");
    }
    renderer.set_environment_settle(false);
    renderer.read_scene(gpu).expect("the HDR scene reads back")
}

/// Write `texels` (linear rgb) as a Reinhard-tonemapped `.ppm` named `name` under
/// `GENEX_FROXEL_EVIDENCE_DIR`, when it is set.
fn write_evidence(name: &str, (width, height): (u32, u32), texels: &[[f32; 4]]) {
    let Ok(folder) = std::env::var("GENEX_FROXEL_EVIDENCE_DIR") else { return };
    let encode = |value: f32| {
        let mapped = value.max(0.0) * 2.0 / (1.0 + value.max(0.0) * 2.0);
        (libm::powf(mapped, 1.0 / 2.2) * 255.0).round() as u8
    };
    let mut bytes = format!("P6\n{width} {height}\n255\n").into_bytes();
    bytes.extend(texels.iter().flat_map(|texel| [texel[0], texel[1], texel[2]].map(encode)));
    std::fs::create_dir_all(&folder).expect("evidence folder");
    std::fs::write(std::path::Path::new(&folder).join(format!("{name}.ppm")), bytes).expect("evidence written");
}

fn luminance(rgb: [f32; 3]) -> f32 {
    0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
}

/// The mean linear rgb of the pixels where the world points `points` land in a `size` frame seen
/// by `camera` (points off screen are skipped).
fn mean_at(texels: &[[f32; 4]], (width, height): (u32, u32), camera: &CameraDesc, points: &[[f32; 3]]) -> [f32; 3] {
    let view_proj = camera.view_proj(width as f32 / height as f32);
    let mut sum = [0.0_f64; 3];
    let mut count = 0.0;
    for point in points {
        let clip = view_proj * glam::Vec3::from(*point).extend(1.0);
        if clip.w <= 0.0 {
            continue;
        }
        let ndc = clip.truncate() / clip.w;
        let (x, y) = (((ndc.x + 1.0) * 0.5 * width as f32) as i64, ((1.0 - ndc.y) * 0.5 * height as f32) as i64);
        if !(0..i64::from(width)).contains(&x) || !(0..i64::from(height)).contains(&y) {
            continue;
        }
        let texel = texels[(y as u32 * width + x as u32) as usize];
        for (total, value) in sum.iter_mut().zip(texel) {
            *total += f64::from(value);
        }
        count += 1.0;
    }
    assert!(count > 0.0, "no point of the region is on screen");
    sum.map(|value| (value / count) as f32)
}

// ---------------------------------------------------------------------------------------------
// The shaft scene: the camera looks towards a low sun across fogged air at a low backdrop wall the
// sun does not light (it shines from behind it). A roof slab 10 m up over the left half of the
// view (x < 0) shadows the air beneath it, which the left of the backdrop is seen through. The
// analytic fog cannot know the slab is there; the froxel fog takes the sun's forward lobe out of the
// shadowed air only. The sun is straight ahead, so the analytic fog is the same left and right.

/// Towards the sun: behind the backdrop (-z), 25 degrees up.
const SHAFT_SUN: [f32; 3] = [0.0, 0.42, -0.91];
const BACKDROP_Z: f32 = -60.0;

fn shaft_camera() -> CameraDesc {
    CameraDesc::look_at([0.0, 2.0, 10.0], [0.0, 2.0, BACKDROP_Z])
}

fn shaft_scene() -> Scene {
    let mut scene = Scene::new(shaft_camera(), [0, 0, 0, 255]);
    scene.lighting.sun_dir = SHAFT_SUN;
    scene.lighting.sun_intensity = 3.0;
    scene.lighting.ambient_intensity = 0.0;
    // Ground, the backdrop wall (3 m high, its shadow 6 m long) facing the camera, and the roof slab
    // 10 m up over x < 0 (its shadow at eye height reaches 17 m further towards the camera).
    scene.draw(MeshId::CUBE, scaled([0.0, -0.05, -20.0], [200.0, 0.1, 120.0]), Material::color([150, 150, 150, 255]).with_pbr(0.0, 0.9));
    scene.draw(MeshId::CUBE, scaled([0.0, 1.5, BACKDROP_Z - 0.5], [200.0, 3.0, 1.0]), Material::color([120, 120, 120, 255]).with_pbr(0.0, 0.9));
    scene.draw(MeshId::CUBE, scaled([-50.0, 10.0, -40.0], [100.0, 0.5, 160.0]), Material::color([90, 90, 90, 255]).with_pbr(0.0, 0.9));
    scene
}

/// Points on the backdrop at eye height: `x` from `from` to `to`.
fn backdrop_band(from: f32, to: f32) -> Vec<[f32; 3]> {
    (0..16).flat_map(|i| (0..4).map(move |j| (i, j))).map(|(i, j)| [from + (to - from) * (i as f32 + 0.5) / 16.0, 1.2 + j as f32 * 0.4, BACKDROP_Z]).collect()
}

/// The backdrop's luminance seen through the air the slab shadows (left) and through sunlit air
/// (right, the mirror image).
fn shaft_sides(texels: &[[f32; 4]], size: (u32, u32)) -> [f32; 2] {
    let camera = shaft_camera();
    let left = mean_at(texels, size, &camera, &backdrop_band(-35.0, -20.0));
    let right = mean_at(texels, size, &camera, &backdrop_band(20.0, 35.0));
    [luminance(left), luminance(right)]
}

/// Plan A.5: sun shafts. Against the analytic fog (medium's) the backdrop seen through the slab's
/// shadow loses at least this share of its light (the sun's lobe in that air), and the backdrop
/// seen through sunlit air keeps its light within [`LIT_TOLERANCE`].
const SHADOWED_DROP_MIN: f32 = 0.15;
const LIT_TOLERANCE: f32 = 0.05;

#[test]
#[ignore = "real GPU: run with --ignored metal"]
fn metal_the_sun_s_shadow_carves_shafts_out_of_the_fog() {
    let Some(gpu) = gpu() else { return };
    let size = (480, 270);
    let mut sides = Vec::new();
    for preset in [QualityPreset::Medium, QualityPreset::High, QualityPreset::Ultra] {
        let mut renderer = renderer(&gpu, size, &desktop(preset));
        let texels = settled(&mut renderer, &gpu, &shaft_scene(), 8);
        write_evidence(&format!("shafts-{}", preset.wire()), size, &texels);
        let [left, right] = shaft_sides(&texels, size);
        eprintln!("{}: backdrop through the slab's shadow {left:.4}, through sunlit air {right:.4}", preset.wire());
        sides.push([left, right]);
    }
    let analytic = sides[0];
    let mut row = format!("{{\"row\":\"froxel-shafts\",\"adapter\":\"{}\",\"analytic\":[{:.4},{:.4}]", gpu.receipt().adapter, analytic[0], analytic[1]);
    for (preset, [left, right]) in [("high", sides[1]), ("ultra", sides[2])] {
        let (shadowed, lit) = (left / analytic[0], right / analytic[1]);
        row.push_str(&format!(",\"{preset}\":{{\"shadowedRatio\":{shadowed:.4},\"litRatio\":{lit:.4}}}"));
        eprintln!("{preset}: shadowed air {shadowed:.3} of the analytic fog's light, sunlit air {lit:.3}");
        assert!(shadowed <= 1.0 - SHADOWED_DROP_MIN, "{preset}: the shadowed air keeps {shadowed:.3} of the analytic fog's light (at most {})", 1.0 - SHADOWED_DROP_MIN);
        assert!((lit - 1.0).abs() <= LIT_TOLERANCE, "{preset}: the sunlit air is {lit:.3} of the analytic fog's light");
    }
    println!("{row}}}");
}

// ---------------------------------------------------------------------------------------------
// The horizon: a far wall deep in the fog, no shadow on the air in front of it.

/// Plan A.5: the fogged horizon matches the sky within 3%: the froxel fog's far colour is the
/// analytic fog's (which the sky background repeats, `tests/fog.rs`), so the volume does not move
/// the horizon.
const HORIZON_TOLERANCE: f32 = 0.03;

fn horizon_camera() -> CameraDesc {
    CameraDesc::look_at([0.0, 2.0, 0.0], [0.0, 2.0, -100.0])
}

fn horizon_scene() -> Scene {
    let mut scene = Scene::new(horizon_camera(), [0, 0, 0, 255]);
    scene.lighting.sun_dir = [0.3, 0.45, -0.84];
    scene.lighting.sun_intensity = 3.0;
    scene.lighting.ambient_intensity = 0.0;
    scene.lighting.shadows = false;
    // A wall 400 m away (about 6e-6 of it shows through the fog).
    scene.draw(MeshId::CUBE, scaled([0.0, 20.0, -400.0], [800.0, 40.0, 1.0]), Material::color([200, 60, 60, 255]).with_pbr(0.0, 0.9));
    scene
}

#[test]
#[ignore = "real GPU: run with --ignored metal"]
fn metal_the_froxel_fog_s_horizon_is_the_analytic_fog_s() {
    let Some(gpu) = gpu() else { return };
    let size = (320, 180);
    let band: Vec<[f32; 3]> = (0..24).map(|i| [-120.0 + i as f32 * 10.0, 2.0, -399.0]).collect();
    let mut seen = Vec::new();
    for preset in [QualityPreset::Medium, QualityPreset::High] {
        let mut renderer = renderer(&gpu, size, &desktop(preset));
        let texels = settled(&mut renderer, &gpu, &horizon_scene(), 8);
        write_evidence(&format!("horizon-{}", preset.wire()), size, &texels);
        seen.push(mean_at(&texels, size, &horizon_camera(), &band));
    }
    let [analytic, froxel] = [seen[0], seen[1]];
    eprintln!("horizon: analytic fog {analytic:?}, froxel fog {froxel:?}");
    for c in 0..3 {
        let error = (froxel[c] - analytic[c]).abs() / analytic[c].max(1e-6);
        assert!(error <= HORIZON_TOLERANCE, "channel {c}: froxel {} vs analytic {} ({:.1}% off)", froxel[c], analytic[c], error * 100.0);
    }
}

// ---------------------------------------------------------------------------------------------
// Determinism and stillness

/// A settled capture of the shaft scene after `live` Live frames on the same renderer, and the
/// differing texels against `reference`.
fn settled_after_live(gpu: &Gpu, renderer: &mut genex_render::Renderer, live: std::ops::Range<u64>) -> Vec<[f32; 4]> {
    for index in live {
        renderer.set_frame_index(index);
        renderer.render(gpu, &shaft_scene(), genex_render::CullPath::Gpu).expect("frame");
    }
    captured(gpu, renderer)
}

/// A settled capture as the capture path draws it: on the capture's own history set, Live's AO
/// history put aside and taken back (`Renderer::begin_capture_history`).
fn captured(gpu: &Gpu, renderer: &mut genex_render::Renderer) -> Vec<[f32; 4]> {
    renderer.begin_capture_history();
    renderer.set_history_set(genex_render::settle::HistorySet::Capture);
    let texels = settled(renderer, gpu, &shaft_scene(), 8);
    renderer.set_history_set(genex_render::settle::HistorySet::Live);
    renderer.end_capture_history();
    texels
}

fn differing(a: &[[f32; 4]], b: &[[f32; 4]]) -> usize {
    a.iter().zip(b).filter(|(x, y)| x.map(f32::to_bits) != y.map(f32::to_bits)).count()
}

#[test]
#[ignore = "real GPU: run with --ignored metal"]
fn metal_a_settled_froxel_capture_is_the_same_bytes_twice() {
    // Plan A.5: settle K frames are deterministic. Two renderers' settled captures are the same
    // bytes. A settled capture after Live frames on the same renderer is reported against the same
    // without the froxel fog: the renderer's other histories already move it (RED found here, not
    // A.5's: 692 texels at high and 986 at ultra differ with the froxel fog off); the volume's own
    // history starts over (`metal_the_volume_s_history_starts_over_on_a_settled_capture`).
    let Some(gpu) = gpu() else { return };
    let size = (256, 144);
    let mut problems = Vec::new();
    let mut rows = Vec::new();
    for preset in [QualityPreset::High, QualityPreset::Ultra] {
        for froxels in [false, true] {
            let mut quality = desktop(preset);
            if !froxels {
                quality.environment.froxel_fog = None;
            }
            let mut renderer = renderer(&gpu, size, &quality);
            let first = captured(&gpu, &mut renderer);
            let second = settled_after_live(&gpu, &mut renderer, 100..112);
            let fresh = captured(&gpu, &mut self::renderer(&gpu, size, &quality));
            let (again, other) = (differing(&first, &second), differing(&first, &fresh));
            eprintln!("{} froxels {froxels}: {again} texels differ after Live frames, {other} on a fresh renderer", preset.wire());
            rows.push(format!("{{\"preset\":\"{}\",\"froxels\":{froxels},\"afterLive\":{again},\"freshRenderer\":{other}}}", preset.wire()));
            if other > 0 {
                problems.push(format!("{} froxels {froxels}: {other} texels differ on a fresh renderer", preset.wire()));
            }
        }
    }
    println!("{{\"row\":\"froxel-settle-determinism\",\"adapter\":\"{}\",\"runs\":[{}]}}", gpu.receipt().adapter, rows.join(","));
    assert!(problems.is_empty(), "{problems:?}");
}

/// Plan A.5: froxel temporal noise is resolved, so the still camera's flicker is unchanged: the
/// share of pixels of the presented frame whose luma moves by more than [`FLICKER_LEVELS`] between
/// consecutive still Live frames is at most [`STILL_FLICKER_EXTRA_MAX`] above the analytic fog's
/// (the sun-mask rows' measure, `tests/sun_mask.rs`).
const STILL_FLICKER_EXTRA_MAX: f64 = 0.0005;
const FLICKER_LEVELS: f32 = 3.0;
/// Frames before the measured ones (TAA's and the volume's histories fill), and the measured ones.
const WARM_FRAMES: u64 = 24;
const STILL_FRAMES: u64 = 32;

fn lumas(capture: &genex_render::capture::Capture) -> Vec<f32> {
    capture.bgra().chunks(4).map(|p| 0.0722 * f32::from(p[0]) + 0.7152 * f32::from(p[1]) + 0.2126 * f32::from(p[2])).collect()
}

/// The mean share of pixels whose luma moved by more than [`FLICKER_LEVELS`] from the frame before,
/// over [`STILL_FRAMES`] still Live frames of the shaft scene under `quality`.
fn still_flicker(gpu: &Gpu, quality: &Quality, size: (u32, u32)) -> f64 {
    let mut renderer = renderer(gpu, size, quality);
    let scene = shaft_scene();
    let mut last: Option<Vec<f32>> = None;
    let mut shares = Vec::new();
    for index in 0..WARM_FRAMES + STILL_FRAMES {
        renderer.set_frame_index(index);
        renderer.render(gpu, &scene, genex_render::CullPath::Gpu).expect("frame");
        if index < WARM_FRAMES {
            continue;
        }
        let luma = lumas(&renderer.capture(gpu).expect("capture"));
        if let Some(previous) = &last {
            let moved = previous.iter().zip(&luma).filter(|(a, b)| (*a - *b).abs() > FLICKER_LEVELS).count();
            shares.push(moved as f64 / luma.len() as f64);
        }
        last = Some(luma);
    }
    shares.iter().sum::<f64>() / shares.len() as f64
}

#[test]
#[ignore = "real GPU: run with --ignored metal"]
fn metal_a_still_camera_does_not_shimmer_in_the_froxel_fog() {
    let Some(gpu) = gpu() else { return };
    let size = (320, 180);
    let mut rows = Vec::new();
    for preset in [QualityPreset::High, QualityPreset::Ultra] {
        let mut analytic = desktop(preset);
        analytic.environment.froxel_fog = None;
        let base = still_flicker(&gpu, &analytic, size);
        let flicker = still_flicker(&gpu, &desktop(preset), size);
        eprintln!("{}: still flicker {:.4}% of pixels a frame (analytic fog {:.4}%)", preset.wire(), flicker * 100.0, base * 100.0);
        rows.push(format!("\"{}\":{{\"froxel\":{flicker:.6},\"analytic\":{base:.6}}}", preset.wire()));
        assert!(flicker <= base + STILL_FLICKER_EXTRA_MAX, "{}: {:.4}% of pixels move a frame (analytic {:.4}%)", preset.wire(), flicker * 100.0, base * 100.0);
    }
    println!("{{\"row\":\"froxel-still-flicker\",\"adapter\":\"{}\",{}}}", gpu.receipt().adapter, rows.join(","));
}

// ---------------------------------------------------------------------------------------------
// The module on its own: synthetic inputs, the result read back against the CPU twin.

/// Read back a `rgba16float` 3D texture of `size`.
fn read_volume(gpu: &Gpu, texture: &wgpu::Texture, (width, height, depth): (u32, u32, u32)) -> Vec<[f32; 4]> {
    let tight = width * 8;
    let padded = tight.div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT) * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
    let staging = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("froxel readback"),
        size: u64::from(padded) * u64::from(height) * u64::from(depth),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("froxel readback") });
    encoder.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo { texture, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
        wgpu::TexelCopyBufferInfo { buffer: &staging, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(padded), rows_per_image: Some(height) } },
        wgpu::Extent3d { width, height, depth_or_array_layers: depth },
    );
    gpu.queue.submit([encoder.finish()]);
    staging.slice(..).map_async(wgpu::MapMode::Read, |result| result.expect("mapped"));
    let _ = gpu.device.poll(wgpu::PollType::wait_indefinitely());
    let data = staging.slice(..).get_mapped_range().expect("mapped range").to_vec();
    let mut texels = Vec::new();
    for row in 0..height * depth {
        let start = (row * padded) as usize;
        for texel in data[start..start + tight as usize].chunks(8) {
            texels.push([0, 2, 4, 6].map(|at| genex_render::post::tonemap::f16_to_f32(u16::from_le_bytes([texel[at], texel[at + 1]]))));
        }
    }
    texels
}

/// Synthetic inputs: a frame uniform without shadows, empty light tables, a 1-texel shadow array, a
/// black sky cube array and a neutral (one-texel) aerial volume.
struct Synthetic {
    frame: wgpu::Buffer,
    shadow: wgpu::TextureView,
    comparison: wgpu::Sampler,
    filtering: wgpu::Sampler,
    table: wgpu::Buffer,
    probes: wgpu::TextureView,
    aerial: wgpu::TextureView,
}

fn texture_view(gpu: &Gpu, label: &str, size: wgpu::Extent3d, (dimension, view): (wgpu::TextureDimension, wgpu::TextureViewDimension), format: wgpu::TextureFormat) -> wgpu::TextureView {
    let texture = gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size,
        mip_level_count: 1,
        sample_count: 1,
        dimension,
        format,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    texture.create_view(&wgpu::TextureViewDescriptor { dimension: Some(view), ..Default::default() })
}

fn synthetic(gpu: &Gpu, frame: &genex_render::layout::GpuFrame) -> Synthetic {
    use wgpu::util::DeviceExt;
    let device = &gpu.device;
    let one = |layers| wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: layers };
    Synthetic {
        frame: device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("froxel frame"), contents: bytemuck::bytes_of(frame), usage: wgpu::BufferUsages::UNIFORM }),
        shadow: texture_view(gpu, "froxel shadow", one(1), (wgpu::TextureDimension::D2, wgpu::TextureViewDimension::D2Array), wgpu::TextureFormat::Depth32Float),
        comparison: device.create_sampler(&wgpu::SamplerDescriptor { compare: Some(wgpu::CompareFunction::LessEqual), ..Default::default() }),
        filtering: device.create_sampler(&wgpu::SamplerDescriptor { mag_filter: wgpu::FilterMode::Linear, min_filter: wgpu::FilterMode::Linear, ..Default::default() }),
        table: device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("froxel table"), contents: &[0u8; 4096], usage: wgpu::BufferUsages::STORAGE }),
        probes: texture_view(gpu, "froxel sky", one(6), (wgpu::TextureDimension::D2, wgpu::TextureViewDimension::CubeArray), wgpu::TextureFormat::Rgba16Float),
        aerial: texture_view(gpu, "froxel aerial", one(1), (wgpu::TextureDimension::D3, wgpu::TextureViewDimension::D3), wgpu::TextureFormat::Rgba16Float),
    }
}

const MODULE_GRID: genex_render::froxel::FroxelGrid = genex_render::froxel::FroxelGrid { width: 16, height: 9, slices: 64 };
const MODULE_FOG: genex_render::fog::GpuFog = genex_render::fog::GpuFog { color: [0.8, 0.9, 1.0, 0.02], params: [0.0, 0.0, 0.0, 1.0] };

/// The camera at `eye` looking along -z: its view-projection (standard depth) and frame uniform.
fn module_camera(eye: [f32; 3]) -> ([f32; 16], genex_render::layout::GpuFrame) {
    let at = glam::Vec3::from(eye);
    let view = glam::camera::rh::view::look_at_mat4(at, at + glam::Vec3::new(0.0, 0.0, -10.0), glam::Vec3::Y);
    let view_proj = (glam::camera::rh::proj::directx::perspective(1.0, 16.0 / 9.0, 0.1, 1000.0) * view).to_cols_array();
    (view_proj, genex_render::layout::GpuFrame { view_proj, camera_pos: [eye[0], eye[1], eye[2], 1.0], camera_forward: [0.0, 0.0, -1.0, 0.0], ..Default::default() })
}

/// One frame of the module on synthetic inputs: the camera at `eye`, frame `index` of history set
/// `set`, the fog lit by the flat colour (`environment_lights` false) or the black sky and no sun.
fn module_frame(gpu: &Gpu, froxels: &mut genex_render::froxel::FroxelFog, eye: [f32; 3], (index, set): (u64, u32)) {
    use genex_render::froxel::{FroxelFrame, FroxelInputs};
    let (view_proj, frame) = module_camera(eye);
    let inputs = synthetic(gpu, &frame);
    let froxel_frame = FroxelFrame {
        view_proj,
        camera: eye,
        render_size: (160, 90),
        frame_index: index,
        history_set: set,
        reset: index == 0,
        depth_reversed: false,
        environment_lights: false,
        binned: false,
        fog: MODULE_FOG,
        rooms: (0, 0),
    };
    let froxel_inputs = FroxelInputs {
        frame_uniforms: &inputs.frame,
        shadow_array: &inputs.shadow,
        shadow_sampler: &inputs.comparison,
        lights: &inputs.table,
        light_ext: &inputs.table,
        light_bins: &inputs.table,
        env_probes: &inputs.probes,
        env_sampler: &inputs.filtering,
        aerial: &inputs.aerial,
        rooms: &inputs.table,
        room_cells: &inputs.aerial,
    };
    let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("froxel") });
    let passes = froxels.encode(&gpu.device, &gpu.queue, &mut encoder, &froxel_inputs, &froxel_frame);
    assert_eq!(passes.compute, 1, "one compute pass, two dispatches");
    gpu.queue.submit([encoder.finish()]);
}

fn module_volume(gpu: &Gpu, froxels: &genex_render::froxel::FroxelFog) -> Vec<[f32; 4]> {
    let grid = MODULE_GRID;
    read_volume(gpu, froxels.texture(), (u32::from(grid.width), u32::from(grid.height), 2 * u32::from(grid.slices)))
}

#[test]
#[ignore = "real GPU: run with --ignored metal"]
fn metal_a_volume_under_the_flat_colour_scans_to_the_analytic_fog() {
    let Some(gpu) = gpu() else { return };
    let mut froxels = genex_render::froxel::FroxelFog::new(&gpu.device, MODULE_GRID).expect("froxel fog");
    module_frame(&gpu, &mut froxels, [0.0, 2.0, 0.0], (0, 0));
    let volume = module_volume(&gpu, &froxels);
    let (w, h, s) = (u32::from(MODULE_GRID.width), u32::from(MODULE_GRID.height), u32::from(MODULE_GRID.slices));
    let texel = |x: u32, y: u32, z: u32| volume[((z * h + y) * w + x) as usize];
    for (x, y) in [(8, 4), (0, 0), (15, 8)] {
        for k in [0, 10, 31, 50, 63] {
            let distance = genex_render::froxel::slice_bounds(k, s).1;
            let opacity = 1.0 - libm::expf(-MODULE_FOG.color[3] * distance);
            let (front, back) = (texel(x, y, k), texel(x, y, s + k));
            for c in 0..3 {
                let want = MODULE_FOG.color[c] * opacity;
                assert!((front[c] - want).abs() <= 2e-3 + 2e-3 * want, "({x}, {y}) slice {k} at {distance:.1} m channel {c}: in-scatter {} vs {want}", front[c]);
                assert!((back[c] - (1.0 - opacity)).abs() <= 2e-3, "({x}, {y}) slice {k} channel {c}: transmittance {} vs {}", back[c], 1.0 - opacity);
            }
            assert_eq!(front[3], 1.0, "the volume holds the height fog");
        }
    }
}

#[test]
#[ignore = "real GPU: run with --ignored metal"]
fn metal_the_volume_s_history_starts_over_on_a_settled_capture() {
    // A settled capture's frames 0..8 on the capture's history set give the same bytes whether or
    // not Live frames (a moving camera, frames 100..112) ran on the same volume before.
    let Some(gpu) = gpu() else { return };
    let capture = |froxels: &mut genex_render::froxel::FroxelFog| {
        for index in 0..8 {
            module_frame(&gpu, froxels, [0.0, 2.0, 0.0], (index, 1));
        }
        module_volume(&gpu, froxels)
    };
    let mut fresh = genex_render::froxel::FroxelFog::new(&gpu.device, MODULE_GRID).expect("froxel fog");
    let reference = capture(&mut fresh);
    let mut used = genex_render::froxel::FroxelFog::new(&gpu.device, MODULE_GRID).expect("froxel fog");
    for index in 100..112 {
        module_frame(&gpu, &mut used, [index as f32 * 0.1, 2.0, -(index as f32) * 0.2], (index, 0));
    }
    let after = capture(&mut used);
    assert!(differing(&reference, &after) == 0, "{} texels differ", differing(&reference, &after));
}

// ---------------------------------------------------------------------------------------------
// Cost

/// Plan A.5's budgets: the froxel fog adds at most this much GPU frame time, ms (high's grid,
/// ultra's 160 x 90 x 64), at 1440p (owner decision D7's desktop output).
const HIGH_BUDGET_MS: f32 = 0.8;
const ULTRA_BUDGET_MS: f32 = 1.2;
/// Interleaved timing rounds (the first warms up and is dropped) and frames a round.
const PERF_ROUNDS: u32 = 9;
const PERF_FRAMES: u64 = 40;

fn median(values: &mut [f32]) -> f32 {
    values.sort_by(f32::total_cmp);
    values[values.len() / 2]
}

/// The median GPU frame time of `frames` Live frames of the shaft scene, starting at frame `first`.
fn timed_median(gpu: &Gpu, renderer: &mut genex_render::Renderer, first: u64, frames: u64) -> Option<f32> {
    let scene = shaft_scene();
    let mut times = Vec::new();
    for frame in first..first + frames + 8 {
        times.extend(renderer.arm_frame_timer(&gpu.queue)?);
        renderer.set_frame_index(frame);
        renderer.render(gpu, &scene, genex_render::CullPath::Gpu).expect("frame");
        renderer.finish_frame_timer();
        let _ = gpu.device.poll(wgpu::PollType::wait_indefinitely());
    }
    let mut kept: Vec<f32> = times.into_iter().skip(8).take(frames as usize).collect();
    Some(median(&mut kept))
}

#[test]
#[ignore = "real GPU: run with --ignored metal"]
fn metal_the_froxel_fog_stays_within_its_budget_at_1440p() {
    let Some(gpu) = gpu() else { return };
    let size = (2560, 1440);
    let mut row = format!("{{\"row\":\"froxel-cost-1440p\",\"adapter\":\"{}\"", gpu.receipt().adapter);
    let mut problems = Vec::new();
    for (preset, budget) in [(QualityPreset::High, HIGH_BUDGET_MS), (QualityPreset::Ultra, ULTRA_BUDGET_MS)] {
        let mut off = desktop(preset);
        off.environment.froxel_fog = None;
        let mut renderers = [renderer(&gpu, size, &off), renderer(&gpu, size, &desktop(preset))];
        let mut deltas = Vec::new();
        for round in 0..PERF_ROUNDS {
            let mut medians = [0.0_f32; 2];
            for (renderer, held) in renderers.iter_mut().zip(&mut medians) {
                let Some(time) = timed_median(&gpu, renderer, 1000 + u64::from(round) * 100, PERF_FRAMES) else {
                    eprintln!("skipped: no timestamp queries");
                    return;
                };
                *held = time;
            }
            if round > 0 {
                deltas.push(medians[1] - medians[0]);
            }
        }
        let added = median(&mut deltas.clone());
        deltas.sort_by(f32::total_cmp);
        eprintln!("{}: the froxel fog adds {added:.3} ms (rounds {deltas:?})", preset.wire());
        row.push_str(&format!(",\"{}\":{{\"addedMedianMs\":{added:.4},\"budgetMs\":{budget}}}", preset.wire()));
        if added > budget {
            problems.push(format!("{}: {added:.3} ms over {budget} ms", preset.wire()));
        }
    }
    row.push('}');
    println!("{row}");
    if let Ok(path) = std::env::var("GENEX_PERF_OUT") {
        std::fs::write(path, format!("{row}\n")).expect("perf row");
    }
    assert!(problems.is_empty(), "{problems:?}");
}

/// The froxel pass's own GPU time on `grid`, ms (the median of `runs` timestamped passes): lit by
/// the sky with the sun's shadow tapped in every froxel and the history read, as on `high`.
fn pass_time(gpu: &Gpu, grid: genex_render::froxel::FroxelGrid, runs: u64) -> f64 {
    use genex_render::froxel::{FroxelFog, FroxelFrame, FroxelInputs};
    let (view_proj, mut frame) = module_camera([0.0, 2.0, 0.0]);
    frame.cascade_splits = [0.0, 0.0, 0.0, 1.0];
    frame.cascade_ends = [80.0, 0.0, 0.0, 0.0];
    frame.cascade_matrices[0] = glam::camera::rh::proj::directx::orthographic(-50.0, 50.0, -50.0, 50.0, -100.0, 100.0).to_cols_array();
    frame.sun_dir = [0.0, 0.42, -0.91, 0.0];
    frame.sun_color = [3.0, 3.0, 3.0, 0.0];
    frame.ambient = [0.0, 0.0, 0.0, 1.0];
    let inputs = synthetic(gpu, &frame);
    let mut froxels = FroxelFog::new(&gpu.device, grid).expect("froxel fog");
    let queries = gpu.device.create_query_set(&wgpu::QuerySetDescriptor { label: Some("froxel timing"), ty: wgpu::QueryType::Timestamp, count: 2 });
    let resolve = gpu.device.create_buffer(&wgpu::BufferDescriptor { label: Some("froxel timing"), size: 16, usage: wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC, mapped_at_creation: false });
    let read = gpu.device.create_buffer(&wgpu::BufferDescriptor { label: Some("froxel timing read"), size: 16, usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
    let period = f64::from(gpu.queue.get_timestamp_period());
    let mut times = Vec::new();
    for index in 0..=runs {
        let froxel_frame = FroxelFrame {
            view_proj,
            camera: [0.0, 2.0, 0.0],
            render_size: (2560, 1440),
            frame_index: index,
            history_set: 0,
            reset: index == 0,
            depth_reversed: false,
            environment_lights: true,
            binned: false,
            fog: MODULE_FOG,
            rooms: (0, 0),
        };
        let froxel_inputs = FroxelInputs {
            frame_uniforms: &inputs.frame,
            shadow_array: &inputs.shadow,
            shadow_sampler: &inputs.comparison,
            lights: &inputs.table,
            light_ext: &inputs.table,
            light_bins: &inputs.table,
            env_probes: &inputs.probes,
            env_sampler: &inputs.filtering,
            aerial: &inputs.aerial,
            rooms: &inputs.table,
            room_cells: &inputs.aerial,
        };
        let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("froxel timing") });
        let stamps = wgpu::ComputePassTimestampWrites { query_set: &queries, beginning_of_pass_write_index: Some(0), end_of_pass_write_index: Some(1) };
        froxels.encode_timed(&gpu.device, &gpu.queue, &mut encoder, (&froxel_inputs, &froxel_frame), Some(stamps));
        encoder.resolve_query_set(&queries, 0..2, &resolve, 0);
        encoder.copy_buffer_to_buffer(&resolve, 0, &read, 0, 16);
        gpu.queue.submit([encoder.finish()]);
        read.slice(..).map_async(wgpu::MapMode::Read, |result| result.expect("mapped"));
        gpu.device.poll(wgpu::PollType::wait_indefinitely()).expect("poll");
        let stamps: Vec<u64> = read.slice(..).get_mapped_range().expect("mapped range").as_chunks::<8>().0.iter().map(|b| u64::from_le_bytes(*b)).collect();
        read.unmap();
        if index > 0 {
            times.push(stamps[1].saturating_sub(stamps[0]) as f64 * period / 1.0e6);
        }
    }
    times.sort_by(f64::total_cmp);
    times[times.len() / 2]
}

#[test]
#[ignore = "real GPU: run with --ignored metal"]
fn metal_the_froxel_pass_itself_stays_within_its_budget() {
    // Plan A.5: at most 0.8 ms at high and 1.2 ms at ultra (160 x 90 x 64): the pass's own
    // timestamps, independent of the frame (the 1440p frame row above holds the whole frame).
    let Some(gpu) = gpu() else { return };
    if !gpu.device.features().contains(wgpu::Features::TIMESTAMP_QUERY) {
        eprintln!("skipped: no timestamp queries");
        return;
    }
    let (high, ultra) = (pass_time(&gpu, genex_render::froxel::HIGH_GRID, 60), pass_time(&gpu, genex_render::froxel::ULTRA_GRID, 60));
    println!("{{\"row\":\"froxel-pass\",\"adapter\":\"{}\",\"highMedianMs\":{high:.4},\"ultraMedianMs\":{ultra:.4}}}", gpu.receipt().adapter);
    assert!(high <= f64::from(HIGH_BUDGET_MS), "high's pass {high:.3} ms");
    assert!(ultra <= f64::from(ULTRA_BUDGET_MS), "ultra's pass {ultra:.3} ms");
}
