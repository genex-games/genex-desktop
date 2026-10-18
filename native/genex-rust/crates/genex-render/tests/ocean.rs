//! B.10 ocean tier: the CPU twin (its Stockham FFT against a direct transform, its determinism,
//! the spectrum's shape and height, gameplay heights on the displaced surface), the tier's
//! classes, the shaders' validation and limits, and on the GPU the simulated maps against the
//! twin, a coast shot and the cost of the simulation and the surface together.
//!
//! The CPU rows run everywhere. The GPU rows are `#[ignore]`d and every name contains `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --release --offline --locked --test ocean -- --include-ignored --test-threads=1
//!
//! `GENEX_PERF_OUT` receives the cost rows as JSON lines; `GENEX_OCEAN_OUT` the coast shot (PPM).

use genex_render::Gpu;
use genex_render::device_class::{DeviceClass, FormFactor, PerformanceTier};
use genex_render::layout::GpuFrame;
use genex_render::ocean::{
    FFT_INVOCATIONS, FFT_STORAGE_BUFFERS, FFT_STORAGE_TEXTURES, FFT_WORKGROUP_BYTES, GRID, GpuOceanDraw, GpuOceanParams, OCEAN, OCEAN_FFT, OCEAN_MS_MAX, OceanDrawFrame, OceanField, OceanFormats,
    OceanInput, OceanLook, OceanNode, OceanSpectrum, OceanTwin, REPEAT_S, SAMPLED_TEXTURES, STORAGE_BUFFERS, enabled, gaussian_pair, grid_origin, inverse_fft, period_fraction, wave_vector,
};
use genex_render::settings::QualityPreset;
use glam::{Mat4, Vec3};

// ---------------------------------------------------------------------------------------------
// The twin's transform

/// The inverse DFT of `data` (positive exponent, unnormalised), two complex channels per element,
/// in f64.
fn direct_inverse(data: &[[f32; 4]]) -> Vec<[f64; 4]> {
    let n = data.len();
    (0..n)
        .map(|x| {
            let mut sum = [0.0f64; 4];
            for (k, v) in data.iter().enumerate() {
                let angle = std::f64::consts::TAU * (k * x % n) as f64 / n as f64;
                let (s, c) = angle.sin_cos();
                for pair in 0..2 {
                    let (re, im) = (f64::from(v[2 * pair]), f64::from(v[2 * pair + 1]));
                    sum[2 * pair] += re * c - im * s;
                    sum[2 * pair + 1] += re * s + im * c;
                }
            }
            sum
        })
        .collect()
}

#[test]
fn the_stockham_passes_equal_a_direct_inverse_transform() {
    for n in [2usize, 8, 64, 256] {
        let data: Vec<[f32; 4]> = (0..n as u32).map(|i| {
            let (a, b) = gaussian_pair(7, i);
            let (c, d) = gaussian_pair(11, i);
            [a, b, c, d]
        }).collect();
        let want = direct_inverse(&data);
        let mut got = data.clone();
        inverse_fft(&mut got);
        let scale = (n as f64).sqrt();
        let worst = got.iter().zip(&want).flat_map(|(g, w)| (0..4).map(move |c| (f64::from(g[c]) - w[c]).abs())).fold(0.0, f64::max);
        assert!(worst < 1e-4 * scale * 4.0, "n = {n}: worst error {worst:e}");
    }
}

// ---------------------------------------------------------------------------------------------
// The spectrum and the twin

#[test]
fn the_twin_is_the_same_bits_every_time_and_loops_with_its_period() {
    let a = OceanTwin::new(OceanSpectrum::COAST);
    let b = OceanTwin::new(OceanSpectrum::COAST);
    let bits = |field: &OceanField| field.displacement.iter().chain(&field.slope).flat_map(|t| t.map(f32::to_bits)).collect::<Vec<u32>>();
    assert_eq!(bits(&a.field(12.5)), bits(&b.field(12.5)), "two twins of one sea state agree bit for bit");
    assert_eq!(a.surface(12.5), b.surface(12.5));
    assert_eq!(bits(&a.field(12.5)), bits(&a.field(12.5 + f64::from(REPEAT_S))), "the sea loops every period");
    assert_ne!(bits(&a.field(12.5)), bits(&a.field(13.0)), "the sea moves");
    let other = OceanTwin::new(OceanSpectrum { seed: 1, ..OceanSpectrum::COAST });
    assert_ne!(bits(&a.field(12.5)), bits(&other.field(12.5)), "another seed is another sea");
    assert_eq!(period_fraction(-1.0), period_fraction(f64::from(REPEAT_S) - 1.0), "times before zero wrap too");
}

fn mean_square_height(field: &OceanField) -> f32 {
    field.displacement.iter().map(|t| t[1] * t[1]).sum::<f32>() / field.displacement.len() as f32
}

#[test]
fn the_sea_has_the_significant_height_asked_for_and_no_mean_offset() {
    for height in [0.5f32, 1.2, 3.0] {
        let twin = OceanTwin::new(OceanSpectrum { significant_height_m: height, ..OceanSpectrum::COAST });
        let mut squares = 0.0;
        let mut mean = 0.0;
        let times = [0.0, 7.0, 31.0, 77.0];
        for t in times {
            let field = twin.field(t);
            squares += mean_square_height(&field);
            mean += field.displacement.iter().map(|t| t[1]).sum::<f32>() / field.displacement.len() as f32;
        }
        let measured = 4.0 * (squares / times.len() as f32).sqrt();
        assert!((measured / height - 1.0).abs() < 0.2, "asked {height} m, measured {measured:.3} m");
        assert!((mean / times.len() as f32).abs() < 1e-3 * height, "the sea level stays put");
    }
}

#[test]
fn the_waves_run_with_the_wind() {
    let spectrum = OceanSpectrum::COAST;
    let k = 0.15;
    let along = spectrum.phillips([spectrum.wind_dir[0] * k, spectrum.wind_dir[1] * k]);
    let against = spectrum.phillips([-spectrum.wind_dir[0] * k, -spectrum.wind_dir[1] * k]);
    let across = spectrum.phillips([spectrum.wind_dir[1] * k, -spectrum.wind_dir[0] * k]);
    assert!(along > 0.0 && against < along * 0.1, "waves against the wind are damped: {against:e} vs {along:e}");
    assert!(across < along * 1e-6, "no energy across the wind");
    assert_eq!(spectrum.phillips([0.0, 0.0]), 0.0, "no mean offset");
    let calm = OceanSpectrum { wind_speed: 4.0, ..spectrum };
    let longest = |s: &OceanSpectrum| {
        (1..60).map(|i| i as f32 * 0.01).max_by(|a, b| s.phillips([0.0, -*a]).total_cmp(&s.phillips([0.0, -*b]))).expect("a peak")
    };
    assert!(longest(&calm) > longest(&spectrum), "a stronger wind builds longer waves");
    assert_eq!(wave_vector(256.0, GRID / 2, GRID / 2), [0.0, 0.0]);
}

#[test]
fn a_boat_floats_on_the_displaced_surface_the_picture_shows() {
    let twin = OceanTwin::new(OceanSpectrum::COAST);
    let surface = twin.surface(42.0);
    let field = twin.field(42.0);
    let texel = OceanSpectrum::COAST.patch_m / GRID as f32;
    let mut worst = 0.0f32;
    let mut moved = 0.0f32;
    for (index, d) in field.displacement.iter().enumerate().step_by(97) {
        let (row, column) = (index as u32 / GRID, index as u32 % GRID);
        // The texel centre's point, displaced as the vertex shader displaces it.
        let x = (column as f32 + 0.5) * texel;
        let z = (row as f32 + 0.5) * texel;
        let spot = (x + d[0], z + d[2]);
        moved = moved.max(d[0].abs().max(d[2].abs()));
        worst = worst.max((surface.height_at(spot.0, spot.1) - d[1]).abs());
        assert_eq!(surface.displacement_at(x, z), [d[0], d[1], d[2]], "a texel centre reads its own texel");
    }
    eprintln!("gameplay height: worst {worst:.4} m over displacements up to {moved:.3} m");
    assert!(moved > 0.1, "the coast sea is choppy");
    assert!(worst < 0.05, "the height under a displaced point is its own: worst {worst:.4} m");
}

/// What one gameplay surface (one tick's waves) may cost on the CPU, ms: a quarter of a 60 Hz tick.
const TWIN_SURFACE_MS_MAX: f64 = 4.0;

/// B.10: a game can evaluate the twin's surface once per simulation tick (median of the samples,
/// release build).
#[test]
fn a_tick_of_gameplay_waves_costs_at_most_a_quarter_of_a_tick() {
    const SAMPLES: usize = 9;
    let twin = OceanTwin::new(OceanSpectrum::COAST);
    let mut times = Vec::new();
    for i in 0..SAMPLES {
        #[allow(clippy::disallowed_types, reason = "a cost row measures the wall clock on purpose")]
        let start = std::time::Instant::now();
        let surface = twin.surface(i as f64 / 60.0);
        times.push(start.elapsed().as_secs_f64() * 1e3);
        assert!(surface.height_at(1.0, 2.0).is_finite());
    }
    times.sort_by(f64::total_cmp);
    let median = times[SAMPLES / 2];
    eprintln!("gameplay surface: median {median:.3} ms (min {:.3}, max {:.3})", times[0], times[SAMPLES - 1]);
    if cfg!(debug_assertions) {
        return;
    }
    assert!(median <= TWIN_SURFACE_MS_MAX, "one tick's surface costs {median:.3} ms on the CPU");
}

// ---------------------------------------------------------------------------------------------
// Classes

#[test]
fn the_ocean_is_on_for_desktop_high_and_ultra_only() {
    for tier in [PerformanceTier::Low, PerformanceTier::Mid, PerformanceTier::High, PerformanceTier::Ultra] {
        let desktop = DeviceClass::new(FormFactor::Desktop, tier);
        let phone = DeviceClass::new(FormFactor::Mobile, tier);
        for preset in [QualityPreset::Low, QualityPreset::Medium, QualityPreset::High, QualityPreset::Ultra] {
            let high_and_up = matches!(preset, QualityPreset::High | QualityPreset::Ultra);
            assert_eq!(enabled(preset, desktop), high_and_up, "{preset:?} on a {tier:?} desktop");
            assert!(!enabled(preset, phone), "{preset:?} on a {tier:?} phone: unverified, off");
        }
    }
}

// ---------------------------------------------------------------------------------------------
// The shaders

fn validated(source: &str) -> (naga::Module, naga::valid::ModuleInfo) {
    let module = naga::front::wgsl::parse_str(source).unwrap_or_else(|error| panic!("{}", error.emit_to_string(source)));
    let info = naga::valid::Validator::new(naga::valid::ValidationFlags::all(), naga::valid::Capabilities::CUBE_ARRAY_TEXTURES).validate(&module).expect("valid on WebGPU core");
    (module, info)
}

#[test]
fn both_shaders_validate_against_webgpu_core_and_emit_msl_hlsl_and_spirv() {
    use naga::back::{hlsl, msl, spv};
    for source in [OCEAN_FFT, OCEAN] {
        assert!(source.len() <= genex_render::WGSL_MAX_BYTES);
        let (module, info) = validated(source);
        let mut hlsl_source = String::new();
        let options = hlsl::Options { shader_model: hlsl::ShaderModel::V5_1, ..Default::default() };
        hlsl::Writer::new(&mut hlsl_source, &options, &hlsl::PipelineOptions::default()).write(&module, &info, None).expect("HLSL SM 5.1");
        let options = msl::Options { lang_version: (2, 4), ..Default::default() };
        msl::write_string(&module, &info, &options, &msl::PipelineOptions::default()).expect("MSL");
        let options = spv::Options { lang_version: (1, 3), ..Default::default() };
        spv::write_vec(&module, &info, &options, None).expect("SPIR-V");
    }
}

#[test]
fn the_simulation_fits_core_compute_limits_and_the_surface_its_own_layout() {
    let (fft, _) = validated(OCEAN_FFT);
    let mut layouter = naga::proc::Layouter::default();
    layouter.update(fft.to_ctx()).expect("layout");
    let (mut workgroup, mut storage_buffers, mut storage_textures) = (0, 0, 0);
    for (_, var) in fft.global_variables.iter() {
        match (&fft.types[var.ty].inner, var.space) {
            (_, naga::AddressSpace::WorkGroup) => workgroup += layouter[var.ty].size,
            (naga::TypeInner::Image { class: naga::ImageClass::Storage { .. }, .. }, _) => storage_textures += 1,
            (_, naga::AddressSpace::Storage { .. }) => storage_buffers += 1,
            _ => {}
        }
    }
    assert_eq!(workgroup, FFT_WORKGROUP_BYTES);
    assert!(workgroup <= 16 * 1024, "plan section 2: at most 16 KB of workgroup memory");
    assert_eq!((storage_buffers, storage_textures), (FFT_STORAGE_BUFFERS, FFT_STORAGE_TEXTURES));
    assert!(storage_textures <= 4 && storage_buffers <= 8);
    for entry in &fft.entry_points {
        let invocations: u32 = entry.workgroup_size.iter().product();
        assert!(invocations <= 256, "{}: {invocations} invocations", entry.name);
        if entry.name.starts_with("cs_ocean_fft") {
            assert_eq!(invocations, FFT_INVOCATIONS, "{}: one invocation per element of a 256-point row", entry.name);
        }
    }
    let params = fft.types.iter().find(|(_, ty)| ty.name.as_deref() == Some("OceanParams")).expect("struct OceanParams");
    assert_eq!(layouter[params.0].size as usize, size_of::<GpuOceanParams>());

    let (surface, _) = validated(OCEAN);
    let mut layouter = naga::proc::Layouter::default();
    layouter.update(surface.to_ctx()).expect("layout");
    let (mut sampled, mut storage) = (0, 0);
    for (_, var) in surface.global_variables.iter() {
        match surface.types[var.ty].inner {
            naga::TypeInner::Image { .. } => sampled += 1,
            _ if matches!(var.space, naga::AddressSpace::Storage { .. }) => storage += 1,
            _ => {}
        }
        if let Some(binding) = &var.binding {
            assert!(binding.group <= 1, "group 0 the frame, group 1 the ocean's own: {binding:?}");
        }
    }
    assert_eq!((sampled, storage), (SAMPLED_TEXTURES, STORAGE_BUFFERS));
    assert!(sampled <= 16 && storage <= 8, "plan section 2 (D1)");
    let draw = surface.types.iter().find(|(_, ty)| ty.name.as_deref() == Some("OceanDraw")).expect("struct OceanDraw");
    assert_eq!(layouter[draw.0].size as usize, size_of::<GpuOceanDraw>());
}

#[test]
fn the_grid_follows_the_eye_in_whole_texels() {
    let texel = 256.0 / GRID as f32;
    let [x, z] = grid_origin(256.0, 10.1, -4.6);
    assert_eq!([x, z], [10.0, -5.0]);
    assert_eq!(grid_origin(256.0, 10.1 + texel * 0.2, -4.6), [x, z], "less than a texel of eye motion leaves the grid where it is");
}

// ---------------------------------------------------------------------------------------------
// GPU rows

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

const COLOUR: wgpu::TextureFormat = wgpu::TextureFormat::Rgba16Float;
const DEPTH: wgpu::TextureFormat = wgpu::TextureFormat::Depth32Float;

fn read_texture(gpu: &Gpu, texture: &wgpu::Texture, texel_bytes: u32) -> Vec<u8> {
    let (w, h) = (texture.width(), texture.height());
    let row = (w * texel_bytes).div_ceil(256) * 256;
    let staging = gpu.device.create_buffer(&wgpu::BufferDescriptor { label: None, size: u64::from(row * h), usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false });
    let mut encoder = gpu.device.create_command_encoder(&Default::default());
    encoder.copy_texture_to_buffer(
        texture.as_image_copy(),
        wgpu::TexelCopyBufferInfo { buffer: &staging, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(row), rows_per_image: Some(h) } },
        wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
    );
    gpu.queue.submit([encoder.finish()]);
    let slice = staging.slice(..);
    slice.map_async(wgpu::MapMode::Read, |result| result.expect("map"));
    gpu.device.poll(wgpu::PollType::wait_indefinitely()).expect("poll");
    let data = slice.get_mapped_range().expect("mapped");
    (0..h).flat_map(|y| data[(y * row) as usize..(y * row + w * texel_bytes) as usize].to_vec()).collect()
}

fn half_texels(bytes: &[u8]) -> Vec<[f32; 4]> {
    bytes.as_chunks::<8>().0.iter().map(|t| core::array::from_fn(|c| genex_render::post::tonemap::f16_to_f32(u16::from_le_bytes([t[2 * c], t[2 * c + 1]])))).collect()
}

fn formats() -> OceanFormats {
    OceanFormats { colour: COLOUR, depth: DEPTH, depth_reversed: true }
}

fn worst_relative(gpu: &[[f32; 4]], cpu: &[[f32; 4]], channels: usize) -> (f32, f32) {
    let largest = cpu.iter().flat_map(|t| t[..channels].iter().map(|c| c.abs())).fold(0.0f32, f32::max);
    let worst = gpu.iter().zip(cpu).flat_map(|(g, c)| (0..channels).map(move |i| (g[i] - c[i]).abs())).fold(0.0f32, f32::max);
    (worst / largest.max(1e-6), largest)
}

/// B.10: the GPU's maps at a time are the CPU twin's (the simulation is the twin's arithmetic on
/// another processor: cos and sin rounding and f16 storage apart).
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_simulated_maps_equal_the_cpu_twin() {
    let Some(gpu) = gpu() else { return };
    let twin = OceanTwin::new(OceanSpectrum::COAST);
    let node = OceanNode::new(&gpu.device, &gpu.queue, &twin, formats()).expect("the ocean node");
    for time in [0.0, 3.7, 151.25] {
        let mut encoder = gpu.device.create_command_encoder(&Default::default());
        node.simulate(&gpu.queue, &mut encoder, time, None);
        gpu.queue.submit([encoder.finish()]);
        let displacement = half_texels(&read_texture(&gpu, node.displacement(), 8));
        let slope = half_texels(&read_texture(&gpu, node.slope(), 8));
        let field = twin.field(time);
        let (d_worst, d_largest) = worst_relative(&displacement, &field.displacement, 3);
        let (s_worst, s_largest) = worst_relative(&slope, &field.slope, 2);
        let j_worst = displacement.iter().zip(&field.displacement).map(|(g, c)| (g[3] - c[3]).abs()).fold(0.0f32, f32::max);
        eprintln!("t {time}: displacement worst {d_worst:.5} of {d_largest:.3} m, slope worst {s_worst:.5} of {s_largest:.3}, Jacobian worst {j_worst:.5}");
        assert!(d_worst < 0.01 && s_worst < 0.01 && j_worst < 0.01, "t {time}: the GPU's maps follow the twin");
    }
}

struct Shot {
    eye: Vec3,
    view_proj: Mat4,
    proj: Mat4,
    forward: Vec3,
}

const SHOT_SIZE: (u32, u32) = (1280, 720);
const SUN: [f32; 3] = [3.2, 2.9, 2.5];
const AMBIENT: [f32; 3] = [0.50, 0.60, 0.75];
const SKY_UP: [f32; 3] = [0.25, 0.42, 0.75];
const SKY_HORIZON: [f32; 3] = [0.62, 0.72, 0.85];
const SAND: [f32; 3] = [0.62, 0.52, 0.38];
/// A darker sand: what the sea passes of the bed is the change it makes to the picture.
const DARK_SAND: [f32; 3] = [0.31, 0.26, 0.19];
/// The beach's bed: height `BEACH_TOP - BEACH_SLOPE * z` (the waterline at z = 15 m).
const BEACH_TOP: f32 = 1.2;
const BEACH_SLOPE: f32 = 0.08;

fn shot(size: (u32, u32)) -> Shot {
    panned_shot(size, 0.0)
}

/// The coast shot turned `yaw` degrees about the vertical through the eye.
fn panned_shot(size: (u32, u32), yaw: f32) -> Shot {
    let eye = Vec3::new(0.0, 3.0, 6.0);
    let target = eye + glam::Quat::from_rotation_y(yaw.to_radians()) * (Vec3::new(22.0, -2.0, 60.0) - eye);
    let proj = glam::camera::rh::proj::directx::perspective_infinite_reverse(55f32.to_radians(), size.0 as f32 / size.1 as f32, 0.1);
    let view = glam::camera::rh::view::look_at_mat4(eye, target, Vec3::Y);
    Shot { eye, view_proj: proj * view, proj, forward: (target - eye).normalize() }
}

fn sun_dir() -> Vec3 {
    Vec3::new(0.35, 0.32, 1.0).normalize()
}

fn frame_row(shot: &Shot) -> GpuFrame {
    let mut frame = GpuFrame { view_proj: shot.view_proj.to_cols_array(), ..GpuFrame::default() };
    frame.camera_pos = [shot.eye.x, shot.eye.y, shot.eye.z, 1.0];
    frame.camera_forward = [shot.forward.x, shot.forward.y, shot.forward.z, 0.0];
    let sun = sun_dir();
    frame.sun_dir = [sun.x, sun.y, sun.z, 0.0];
    frame.sun_color = [SUN[0], SUN[1], SUN[2], 1.0];
    frame.ambient = [AMBIENT[0], AMBIENT[1], AMBIENT[2], 1.0];
    frame.cascade_splits = [0.0, 0.0, 1.0, 0.0];
    frame
}

fn texture(gpu: &Gpu, size: (u32, u32), format: wgpu::TextureFormat, usage: wgpu::TextureUsages) -> wgpu::Texture {
    gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: None,
        size: wgpu::Extent3d { width: size.0, height: size.1, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage,
        view_formats: &[],
    })
}

fn f16_bytes(c: [f32; 3]) -> [u8; 8] {
    let h = |v: f32| genex_render::post::tonemap::f32_to_f16(v).to_le_bytes();
    let [r, g, b, a] = [h(c[0]), h(c[1]), h(c[2]), h(1.0)];
    [r[0], r[1], g[0], g[1], b[0], b[1], a[0], a[1]]
}

/// The environment: a one-texel cube array, the zenith's sky above, the horizon's at the sides.
fn sky_cube(gpu: &Gpu) -> wgpu::TextureView {
    let texture = gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("sky"),
        size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 6 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: COLOUR,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    // Faces +x, -x, +y, -y, +z, -z.
    let texels: Vec<u8> = (0..6).flat_map(|face| f16_bytes(if face == 2 { SKY_UP } else { SKY_HORIZON })).collect();
    gpu.queue.write_texture(
        texture.as_image_copy(),
        &texels,
        wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(8), rows_per_image: Some(1) },
        wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 6 },
    );
    texture.create_view(&wgpu::TextureViewDescriptor { dimension: Some(wgpu::TextureViewDimension::CubeArray), ..Default::default() })
}

/// The beach and the sky drawn into `colour` and `depth` (reverse-Z): a lit sand slope under the
/// sea, and a gradient sky behind.
fn draw_beach(gpu: &Gpu, shot: &Shot, colour: &wgpu::TextureView, depth: &wgpu::TextureView, sand: [f32; 3]) {
    use wgpu::util::DeviceExt;
    let sun = sun_dir();
    let source = format!(
        "struct Row {{ view_proj: mat4x4<f32>, inv_view_proj: mat4x4<f32>, eye: vec4<f32> }}\n\
         @group(0) @binding(0) var<uniform> row: Row;\n\
         struct Out {{ @builtin(position) clip: vec4<f32>, @location(0) world: vec3<f32> }}\n\
         @vertex fn vs_beach(@builtin(vertex_index) i: u32) -> Out {{\n\
           var c = array<vec2<f32>, 6>(vec2(-1.0, -1.0), vec2(1.0, -1.0), vec2(1.0, 1.0), vec2(-1.0, -1.0), vec2(1.0, 1.0), vec2(-1.0, 1.0));\n\
           let xz = c[i] * vec2(400.0, 400.0) + vec2(0.0, 390.0);\n\
           let world = vec3(xz.x, {BEACH_TOP:?} - {BEACH_SLOPE:?} * xz.y, xz.y);\n\
           var out: Out; out.clip = row.view_proj * vec4(world, 1.0); out.world = world; return out;\n\
         }}\n\
         @fragment fn fs_beach(in: Out) -> @location(0) vec4<f32> {{\n\
           let n = normalize(vec3(0.0, 1.0, {BEACH_SLOPE:?}));\n\
           let ripple = 0.95 + 0.05 * sin(in.world.x * 7.1 + sin(in.world.z * 3.7)) * sin(in.world.z * 5.3);\n\
           let light = vec3({:?}, {:?}, {:?}) + vec3({:?}, {:?}, {:?}) * max(dot(n, vec3({:?}, {:?}, {:?})), 0.0);\n\
           return vec4(vec3({:?}, {:?}, {:?}) * light * ripple, 1.0);\n\
         }}\n\
         @vertex fn vs_sky(@builtin(vertex_index) i: u32) -> Out {{\n\
           var c = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));\n\
           var out: Out; out.clip = vec4(c[i], 0.0, 1.0);\n\
           let far = row.inv_view_proj * vec4(c[i], 0.5, 1.0); out.world = far.xyz / far.w - row.eye.xyz; return out;\n\
         }}\n\
         @fragment fn fs_sky(in: Out) -> @location(0) vec4<f32> {{\n\
           let d = normalize(in.world);\n\
           return vec4(mix(vec3({:?}, {:?}, {:?}), vec3({:?}, {:?}, {:?}), pow(1.0 - max(d.y, 0.0), 4.0)), 1.0);\n\
         }}\n",
        AMBIENT[0], AMBIENT[1], AMBIENT[2], SUN[0], SUN[1], SUN[2], sun.x, sun.y, sun.z, sand[0], sand[1], sand[2], SKY_UP[0], SKY_UP[1], SKY_UP[2], SKY_HORIZON[0], SKY_HORIZON[1], SKY_HORIZON[2]
    );
    let module = gpu.device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("beach"), source: wgpu::ShaderSource::Wgsl(source.into()) });
    let mut row: Vec<f32> = shot.view_proj.to_cols_array().to_vec();
    row.extend(shot.view_proj.inverse().to_cols_array());
    row.extend([shot.eye.x, shot.eye.y, shot.eye.z, 1.0]);
    let uniform = gpu.device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: None, contents: bytemuck::cast_slice(&row), usage: wgpu::BufferUsages::UNIFORM });
    let pipeline = |vs: &str, fs: &str, depth_write: bool| {
        gpu.device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some(vs),
            layout: None,
            vertex: wgpu::VertexState { module: &module, entry_point: Some(vs), compilation_options: Default::default(), buffers: &[] },
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: Some(wgpu::DepthStencilState {
                format: DEPTH,
                depth_write_enabled: Some(depth_write),
                depth_compare: Some(if depth_write { wgpu::CompareFunction::Greater } else { wgpu::CompareFunction::Always }),
                stencil: Default::default(),
                bias: Default::default(),
            }),
            multisample: Default::default(),
            fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some(fs), compilation_options: Default::default(), targets: &[Some(COLOUR.into())] }),
            multiview_mask: None,
            cache: None,
        })
    };
    let sky = pipeline("vs_sky", "fs_sky", false);
    let beach = pipeline("vs_beach", "fs_beach", true);
    let group = |p: &wgpu::RenderPipeline| {
        gpu.device.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &p.get_bind_group_layout(0), entries: &[wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() }] })
    };
    let (sky_group, beach_group) = (group(&sky), group(&beach));
    let mut encoder = gpu.device.create_command_encoder(&Default::default());
    {
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("beach"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: colour, depth_slice: None, resolve_target: None, ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store } })],
            depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment { view: depth, depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(0.0), store: wgpu::StoreOp::Store }), stencil_ops: None }),
            ..Default::default()
        });
        pass.set_pipeline(&sky);
        pass.set_bind_group(0, &sky_group, &[]);
        pass.draw(0..3, 0..1);
        pass.set_pipeline(&beach);
        pass.set_bind_group(0, &beach_group, &[]);
        pass.draw(0..6, 0..1);
    }
    gpu.queue.submit([encoder.finish()]);
}

/// A coast: the beach and sky drawn, the ocean simulated and drawn over them.
struct Coast {
    node: OceanNode,
    colour: wgpu::Texture,
    colour_view: wgpu::TextureView,
    world_depth_texture: wgpu::Texture,
    world_depth: wgpu::TextureView,
    _frame: wgpu::Buffer,
}

fn coast(gpu: &Gpu, size: (u32, u32), time: f64, look: OceanLook, sand: [f32; 3]) -> Coast {
    let shot = shot(size);
    coast_through(gpu, &shot, shot.view_proj, size, time, look, sand)
}

/// The coast through `shot`, last frame's unjittered view-projection `previous`.
fn coast_through(gpu: &Gpu, shot: &Shot, previous: Mat4, size: (u32, u32), time: f64, look: OceanLook, sand: [f32; 3]) -> Coast {
    use wgpu::util::DeviceExt;
    let usage = wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_SRC;
    let colour = texture(gpu, size, COLOUR, usage);
    let colour_view = colour.create_view(&Default::default());
    let world_depth_texture = texture(gpu, size, DEPTH, usage);
    let world_depth = world_depth_texture.create_view(&Default::default());
    let sampled_depth = texture(gpu, size, DEPTH, usage).create_view(&Default::default());
    draw_beach(gpu, shot, &colour_view, &world_depth, sand);
    let scratch = texture(gpu, size, COLOUR, usage).create_view(&Default::default());
    draw_beach(gpu, shot, &scratch, &sampled_depth, sand);
    let twin = OceanTwin::new(OceanSpectrum::COAST);
    let mut node = OceanNode::new(&gpu.device, &gpu.queue, &twin, formats()).expect("the ocean node");
    let frame = gpu.device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("frame"), contents: bytemuck::bytes_of(&frame_row(shot)), usage: wgpu::BufferUsages::UNIFORM });
    let env = sky_cube(gpu);
    let row = GpuOceanDraw::new(&OceanDrawFrame {
        spectrum: OceanSpectrum::COAST,
        look,
        sea_level: 0.0,
        eye: shot.eye.to_array(),
        reach_m: 3000.0,
        proj: shot.proj,
        prev_view_proj: previous,
        time: time as f32,
        env_mips: 1,
        depth_reversed: true,
        coast: true,
    });
    node.prepare(&gpu.device, &gpu.queue, &row, &OceanInput { frame: &frame, depth: Some(&sampled_depth), env: &env });
    let mut encoder = gpu.device.create_command_encoder(&Default::default());
    node.simulate(&gpu.queue, &mut encoder, time, None);
    gpu.queue.submit([encoder.finish()]);
    Coast { node, colour, colour_view, world_depth_texture, world_depth, _frame: frame }
}

fn surface_pass<'a>(encoder: &'a mut wgpu::CommandEncoder, coast: &'a Coast, stamps: Option<wgpu::RenderPassTimestampWrites<'a>>) -> wgpu::RenderPass<'a> {
    encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some("ocean"),
        color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: &coast.colour_view, depth_slice: None, resolve_target: None, ops: wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store } })],
        depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment { view: &coast.world_depth, depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store }), stencil_ops: None }),
        timestamp_writes: stamps,
        ..Default::default()
    })
}

fn draw_coast(gpu: &Gpu, coast: &Coast) -> Vec<[f32; 4]> {
    let mut encoder = gpu.device.create_command_encoder(&Default::default());
    {
        let mut pass = surface_pass(&mut encoder, coast, None);
        coast.node.draw(&mut pass);
    }
    gpu.queue.submit([encoder.finish()]);
    half_texels(&read_texture(gpu, &coast.colour, 8))
}

/// `rgba` as a binary PPM named `name` in `GENEX_OCEAN_OUT`, when it is set (Reinhard, sRGB).
fn write_ppm(name: &str, rgba: &[[f32; 4]], size: (u32, u32)) {
    let Ok(dir) = std::env::var("GENEX_OCEAN_OUT") else { return };
    let mut bytes = format!("P6\n{} {}\n255\n", size.0, size.1).into_bytes();
    for texel in rgba {
        bytes.extend(texel[..3].iter().map(|c| {
            let mapped = c / (1.0 + c);
            let srgb = if mapped <= 0.003_130_8 { mapped * 12.92 } else { 1.055 * libm::powf(mapped, 1.0 / 2.4) - 0.055 };
            (srgb.clamp(0.0, 1.0) * 255.0).round() as u8
        }));
    }
    std::fs::write(std::path::Path::new(&dir).join(format!("{name}.ppm")), bytes).expect("write the picture");
}

fn luma(c: [f32; 4]) -> f32 {
    0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}

/// The pixel where the view ray through (x, y) meets the sea level, and its distance (None above
/// the horizon).
fn sea_hit(shot: &Shot, size: (u32, u32), x: u32, y: u32) -> Option<Vec3> {
    let ndc = glam::Vec4::new((x as f32 + 0.5) / size.0 as f32 * 2.0 - 1.0, 1.0 - (y as f32 + 0.5) / size.1 as f32 * 2.0, 0.5, 1.0);
    let far = shot.view_proj.inverse() * ndc;
    let dir = (far.truncate() / far.w - shot.eye).normalize();
    if dir.y >= -1e-3 {
        return None;
    }
    Some(shot.eye + dir * (-shot.eye.y / dir.y))
}

/// B.10's coast shot: open sea to the horizon with fold foam and the sun's glint, a surf line where
/// it meets the beach, and the sand showing through the shallows.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_coast_shot_has_surf_shallows_folds_and_a_glint() {
    let Some(gpu) = gpu() else { return };
    let size = SHOT_SIZE;
    let shot = shot(size);
    let before = {
        let bright = coast(&gpu, size, 20.0, OceanLook::SEA, SAND);
        let dark = coast(&gpu, size, 20.0, OceanLook::SEA, DARK_SAND);
        [half_texels(&read_texture(&gpu, &bright.colour, 8)), half_texels(&read_texture(&gpu, &dark.colour, 8))]
    };
    let coast_now = coast(&gpu, size, 20.0, OceanLook::SEA, SAND);
    let picture = draw_coast(&gpu, &coast_now);
    write_ppm("ocean-coast", &picture, size);
    let no_foam = OceanLook { fold_foam: 0.0, shore_foam_m: 0.0, ..OceanLook::SEA };
    let plain = draw_coast(&gpu, &coast(&gpu, size, 20.0, no_foam, SAND));
    let plain_dark = draw_coast(&gpu, &coast(&gpu, size, 20.0, no_foam, DARK_SAND));
    assert!(picture.iter().all(|t| t.iter().all(|c| c.is_finite())), "no NaN or infinity");
    // Bands by where the view ray meets the sea: the shallows (bed 0.1-0.4 m under), deeper water
    // (bed 2-4 m under), the open sea (past 120 m). The share of the bed a pixel passes is how
    // much of the two sands' difference survives under the sea.
    let (mut shallow_shift, mut shallow_count, mut open_luma, mut open_count, mut foamed) = (0.0f32, 0u32, 0.0f32, 0u32, 0u32);
    let (mut deep_shift, mut deep_count) = (0.0f32, 0u32);
    let mut sea_pixels = 0u32;
    for y in 0..size.1 {
        for x in 0..size.0 {
            let Some(hit) = sea_hit(&shot, size, x, y) else { continue };
            let i = (y * size.0 + x) as usize;
            let bed_depth = BEACH_SLOPE * hit.z - BEACH_TOP;
            sea_pixels += 1;
            if (0..3).map(|c| (picture[i][c] - plain[i][c]).abs()).sum::<f32>() > 0.05 {
                foamed += 1;
            }
            let sands = (0..3).map(|c| (before[0][i][c] - before[1][i][c]).abs()).sum::<f32>();
            let shift = (0..3).map(|c| (plain[i][c] - plain_dark[i][c]).abs()).sum::<f32>() / sands.max(1e-3);
            if (0.1..0.4).contains(&bed_depth) {
                shallow_shift += shift;
                shallow_count += 1;
            }
            if (2.0..4.0).contains(&bed_depth) {
                deep_shift += shift;
                deep_count += 1;
            }
            if hit.z > 120.0 {
                open_luma += luma(plain[i]);
                open_count += 1;
            }
        }
    }
    let shallow_mean = shallow_shift / shallow_count.max(1) as f32;
    let deep_mean = deep_shift / deep_count.max(1) as f32;
    let sand = luma(before[0][(size.1 as usize - 4) * size.0 as usize + size.0 as usize / 2]);
    eprintln!("coast: {sea_pixels} sea pixels, {foamed} foamed, shallows pass {shallow_mean:.4} of the bed over {shallow_count}, deeper water {deep_mean:.4} over {deep_count}, open sea luma {:.4}, sand luma {sand:.4}", open_luma / open_count.max(1) as f32);
    assert!(shallow_count > 1000 && deep_count > 1000 && open_count > 1000, "the shot holds shallows, deeper water and open sea");
    assert!(shallow_mean > 0.1 && shallow_mean > 3.0 * deep_mean, "the sand shows through the shallows: they pass {shallow_mean:.3} of it, deeper water {deep_mean:.3}");
    assert!(foamed > sea_pixels / 400, "surf and folds foam: {foamed} of {sea_pixels}");
    assert!(foamed < sea_pixels / 3, "foam stays the exception: {foamed} of {sea_pixels}");
    let glint = picture.iter().map(|t| luma(*t)).fold(0.0f32, f32::max);
    assert!(glint > 2.0, "the sun glints on the sea (brightest luma {glint:.2})");
}

/// 8-bit display luma (Reinhard, sRGB) of a linear texel, as the evidence pictures show it.
fn display_level(c: [f32; 4]) -> f32 {
    let mapped = luma(c) / (1.0 + luma(c));
    let srgb = if mapped <= 0.003_130_8 { mapped * 12.92 } else { 1.055 * libm::powf(mapped, 1.0 / 2.4) - 0.055 };
    srgb.clamp(0.0, 1.0) * 255.0
}

/// The share of far-sea pixels (the view ray meets the sea past `FAR_SEA_M`) whose display level
/// moves by more than `POP_LEVELS` between two pictures.
fn far_sea_pops(shot: &Shot, size: (u32, u32), a: &[[f32; 4]], b: &[[f32; 4]]) -> (f32, u32) {
    const FAR_SEA_M: f32 = 250.0;
    const POP_LEVELS: f32 = 16.0;
    let (mut far, mut popped) = (0u32, 0u32);
    for y in 0..size.1 {
        for x in 0..size.0 {
            let Some(hit) = sea_hit(shot, size, x, y) else { continue };
            if (hit - shot.eye).length() < FAR_SEA_M {
                continue;
            }
            let i = (y * size.0 + x) as usize;
            far += 1;
            popped += u32::from((display_level(a[i]) - display_level(b[i])).abs() > POP_LEVELS);
        }
    }
    (popped as f32 / far.max(1) as f32, far)
}

/// B.10 (the owner's "nothing blinks"): the far sea, whose waves are finer than its pixels, does
/// not sparkle: between consecutive 60 Hz frames, on a still camera and on a 2 px a frame pan,
/// at most `FAR_SEA_POPS_MAX` of its pixels jump by more than 16 display levels.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_far_sea_does_not_sparkle_from_frame_to_frame() {
    const FAR_SEA_POPS_MAX: f32 = 0.005;
    // Two pixels of the 1280-wide shot's horizontal field of view (about 88 degrees).
    const PAN_DEGREES: f32 = 0.138;
    let Some(gpu) = gpu() else { return };
    let size = SHOT_SIZE;
    let still = shot(size);
    let frame = |shot: &Shot, time: f64| draw_coast(&gpu, &coast_through(&gpu, shot, shot.view_proj, size, time, OceanLook::SEA, SAND));
    let first = frame(&still, 20.0);
    let (still_pops, far) = far_sea_pops(&still, size, &first, &frame(&still, 20.0 + 1.0 / 60.0));
    let panned = panned_shot(size, PAN_DEGREES);
    let (pan_pops, _) = far_sea_pops(&still, size, &first, &frame(&panned, 20.0 + 1.0 / 60.0));
    eprintln!("far sea: {far} pixels; one frame later {:.3}% jump past 16 levels on a still camera, {:.3}% on a 2 px pan", still_pops * 100.0, pan_pops * 100.0);
    assert!(far > 10_000, "the shot holds far sea");
    assert!(still_pops <= FAR_SEA_POPS_MAX && pan_pops <= FAR_SEA_POPS_MAX, "the far sea sparkles");
}

/// B.10 (T-01 step 3, as the lake): after the colour pass the sea writes its own motion and depth
/// over the bed's and the sky's, so TAA reprojects a sea pixel by the displaced surface under the
/// camera; no reactive coverage.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_sea_writes_its_own_motion_for_taa() {
    let Some(gpu) = gpu() else { return };
    let size = (640, 360);
    let now = shot(size);
    let previous = panned_shot(size, 0.6).view_proj * Mat4::from_translation(Vec3::new(0.2, -0.05, 0.3));
    let coast = coast_through(&gpu, &now, previous, size, 20.0, OceanLook::SEA, SAND);
    let [normals, motion_format, reactive] = genex_render::motion::TARGET_FORMATS;
    let usage = wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC;
    let targets = [texture(&gpu, size, normals, usage), texture(&gpu, size, motion_format, usage), texture(&gpu, size, reactive, usage)];
    let views: Vec<wgpu::TextureView> = targets.iter().map(|t| t.create_view(&Default::default())).collect();
    let mut encoder = gpu.device.create_command_encoder(&Default::default());
    {
        // The motion prepass's targets hold the beach's and the sky's key before the sea writes its own.
        let sentinel = wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color { r: 9.0, g: 9.0, b: 9.0, a: 9.0 }), store: wgpu::StoreOp::Store };
        let attachments: Vec<Option<wgpu::RenderPassColorAttachment>> = views.iter().map(|view| Some(wgpu::RenderPassColorAttachment { view, depth_slice: None, resolve_target: None, ops: sentinel })).collect();
        encoder.begin_render_pass(&wgpu::RenderPassDescriptor { label: Some("beach key"), color_attachments: &attachments, ..Default::default() });
    }
    coast.node.encode_motion(&mut encoder, [&views[0], &views[1], &views[2]], &coast.world_depth);
    gpu.queue.submit([encoder.finish()]);
    assert_eq!(motion_format, wgpu::TextureFormat::Rg16Float);
    let motion = read_texture(&gpu, &targets[1], 4);
    let reactive_texels = read_texture(&gpu, &targets[2], 1);
    let depth = read_texture(&gpu, &coast.world_depth_texture, 4);
    let inverse = now.view_proj.inverse();
    let (mut compared, mut worst, mut reactive_marked) = (0u32, 0.0f32, 0u32);
    for y in 0..size.1 {
        for x in 0..size.0 {
            let i = (y * size.0 + x) as usize;
            let got = [0, 2].map(|o| genex_render::post::tonemap::f16_to_f32(u16::from_le_bytes([motion[i * 4 + o], motion[i * 4 + o + 1]])));
            if got[0] >= 8.0 {
                continue;
            }
            let z = f32::from_le_bytes(depth[i * 4..i * 4 + 4].try_into().expect("4 bytes"));
            let ndc = glam::Vec2::new((x as f32 + 0.5) / size.0 as f32 * 2.0 - 1.0, 1.0 - (y as f32 + 0.5) / size.1 as f32 * 2.0);
            let world = inverse * glam::Vec4::new(ndc.x, ndc.y, z, 1.0);
            let before = previous * (world / world.w);
            let want = ndc - before.truncate().truncate() / before.w;
            worst = worst.max((got[0] - want.x).abs().max((got[1] - want.y).abs()) / want.length().max(1e-2));
            reactive_marked += u32::from(reactive_texels[i] != 0);
            compared += 1;
        }
    }
    eprintln!("motion: {compared} sea pixels, worst relative error {worst:.4}, {reactive_marked} marked reactive");
    assert!(compared > size.0 * size.1 / 4, "the sea writes its key over a good part of the shot");
    assert_eq!(reactive_marked, 0, "the sea keeps its history");
    assert!(worst < 0.02, "the key is the displaced surface's motion: worst relative error {worst:.4}");
}

fn median(mut times: Vec<f32>) -> f32 {
    times.sort_by(f32::total_cmp);
    times[times.len() / 2]
}

fn stamp_ms(gpu: &Gpu, set: &wgpu::QuerySet, count: u32) -> Vec<f32> {
    let bytes = u64::from(count) * 8;
    let resolve = gpu.device.create_buffer(&wgpu::BufferDescriptor { label: None, size: bytes, usage: wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC, mapped_at_creation: false });
    let staging = gpu.device.create_buffer(&wgpu::BufferDescriptor { label: None, size: bytes, usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false });
    let mut encoder = gpu.device.create_command_encoder(&Default::default());
    encoder.resolve_query_set(set, 0..count, &resolve, 0);
    encoder.copy_buffer_to_buffer(&resolve, 0, &staging, 0, bytes);
    gpu.queue.submit([encoder.finish()]);
    let slice = staging.slice(..);
    slice.map_async(wgpu::MapMode::Read, |result| result.expect("map"));
    gpu.device.poll(wgpu::PollType::wait_indefinitely()).expect("poll");
    let data = slice.get_mapped_range().expect("mapped");
    let ticks: Vec<u64> = (0..count as usize).map(|i| u64::from_le_bytes(data[i * 8..i * 8 + 8].try_into().expect("8 bytes"))).collect();
    let period = gpu.queue.get_timestamp_period();
    ticks.chunks(2).map(|pair| genex_render::timing::span_ms(pair[0], pair[1], period).unwrap_or(f32::NAN)).collect()
}

/// B.10: the simulation plus the surface over the coast shot cost at most `OCEAN_MS_MAX` at
/// desktop high's 1440p render and at 1080p (median of the samples; a 4K render reported).
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_ocean_costs_at_most_two_milliseconds_at_1440p() {
    const SAMPLES: usize = 21;
    const WARM_UP: usize = 5;
    let Some(gpu) = gpu() else { return };
    if !gpu.device.features().contains(wgpu::Features::TIMESTAMP_QUERY) {
        eprintln!("skipped: no timestamps");
        return;
    }
    let mut verdict = Vec::new();
    for size in [(1920, 1080), (2560, 1440), (3840, 2160)] {
        let coast = coast(&gpu, size, 20.0, OceanLook::SEA, SAND);
        let query = |label| gpu.device.create_query_set(&wgpu::QuerySetDescriptor { label: Some(label), ty: wgpu::QueryType::Timestamp, count: 2 });
        let (sim_set, surface_set) = (query("ocean simulation cost"), query("ocean surface cost"));
        let (mut simulation, mut surface, mut total) = (Vec::new(), Vec::new(), Vec::new());
        for run in 0..WARM_UP + SAMPLES {
            let mut encoder = gpu.device.create_command_encoder(&Default::default());
            coast.node.simulate(&gpu.queue, &mut encoder, 20.0 + run as f64 / 60.0, Some(wgpu::ComputePassTimestampWrites { query_set: &sim_set, beginning_of_pass_write_index: Some(0), end_of_pass_write_index: Some(1) }));
            {
                let mut pass = surface_pass(&mut encoder, &coast, Some(wgpu::RenderPassTimestampWrites { query_set: &surface_set, beginning_of_pass_write_index: Some(0), end_of_pass_write_index: Some(1) }));
                coast.node.draw(&mut pass);
            }
            gpu.queue.submit([encoder.finish()]);
            let spans = [stamp_ms(&gpu, &sim_set, 2)[0], stamp_ms(&gpu, &surface_set, 2)[0]];
            if run >= WARM_UP {
                simulation.push(spans[0]);
                surface.push(spans[1]);
                total.push(spans[0] + spans[1]);
            }
        }
        let (sim_ms, surface_ms, total_ms) = (median(simulation), median(surface), median(total));
        let row = format!("{{\"row\":\"ocean-{}p\",\"size\":[{},{}],\"simulation_ms\":{sim_ms:.4},\"surface_ms\":{surface_ms:.4},\"median_ms\":{total_ms:.4},\"budget_ms\":{OCEAN_MS_MAX}}}", size.1, size.0, size.1);
        println!("{row}");
        if let Ok(path) = std::env::var("GENEX_PERF_OUT") {
            use std::io::Write;
            let mut file = std::fs::OpenOptions::new().create(true).append(true).open(path).expect("perf out");
            writeln!(file, "{row}").expect("perf row");
        }
        verdict.push((size, total_ms));
    }
    // Desktop high renders at most 1440p; 4K (ultra) is reported, not judged (owner decision D15).
    for (size, total_ms) in verdict.into_iter().filter(|(size, _)| size.1 <= 1440) {
        assert!(total_ms <= OCEAN_MS_MAX, "the ocean costs {total_ms:.3} ms at {size:?} against {OCEAN_MS_MAX}");
    }
}
