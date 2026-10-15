//! The environment bake on the GPU (RQ2.1, `genex_render::ibl`). CPU rows hold the memory to the
//! budget; real-GPU rows (`#[ignore]`d, every name contains `metal`) hold each pass to its CPU
//! twin and the time-sliced schedule to its budget:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked -- --ignored metal
//!
//! Every environment is a synthetic equirect map written here (no asset is read). With
//! `GENEX_IBL_CAPTURE_DIR` set, the bake rows also write the baked faces and the LUT there as
//! tonemapped `.ppm` evidence; with `GENEX_PERF_OUT`, the perf row writes its JSON line there.

use genex_render::Gpu;
use genex_render::abi::GxEnvSh;
use genex_render::budget::{BudgetInput, BudgetKind, ledger};
use genex_render::device_class::DeviceClass;
use genex_render::graph::FrameEncoder;
use genex_render::hdri::HdriImage;
use genex_render::ibl::{
    BRDF_LUT_SAMPLES, BRDF_LUT_SIZE, BakeAction, BakeRequest, CONTINUOUS_PREFILTER_SAMPLES, EnvironmentMaps, SLICE_STEPS, SPECULAR_MIPS, SliceStep, SourceKind,
    bake_bytes, brdf_lut_reference, continuous_bake_work, cube_direction, equirect_direction, ggx_half_vector, hammersley, map_direction, roughness_lod,
    sh9_eval, slice_budget,
};
use genex_render::presets::preset_quality;
use genex_render::settings::{Environment, EnvironmentQuality, HdriEnvironment, HdriSun, Quality, QualityPreset, SceneFormat, SkyParams};
use genex_render::sky::{LutRefresh, SkyFrame, SkyState};

/// What an `rgba16float` texel can be off by around 1 (half a unit in the last place, and some).
const HALF_ULP_AT_ONE: f32 = 1.0 / 1024.0;

// --- CPU rows ---

#[test]
fn the_bake_holds_no_more_memory_than_the_budget_registers() {
    let input = BudgetInput::new((1920, 1080), 1.0, SceneFormat::Rgba16Float, false);
    for class in DeviceClass::ALL {
        for preset in QualityPreset::ALL {
            let quality = preset_quality(preset, class);
            let registered: u64 = ledger(&quality, &input)
                .entries()
                .iter()
                .filter(|entry| entry.kind == BudgetKind::Ibl && ["specular", "irradiance", "brdf-lut"].contains(&entry.label.as_str()))
                .map(|entry| entry.bytes)
                .sum();
            let held = if quality.hdr { bake_bytes(&quality.environment) } else { 0 };
            // Exactly (RQ2 review; was `held <= registered` over a model of a 256 px LUT and a
            // 32 px irradiance cube): both sets of cubes and SH9, the 128 px LUT.
            assert_eq!(held, registered, "{preset:?} on {}: the bake holds {held} bytes, the budget registers {registered}", class.wire());
        }
    }
}

// --- GPU helpers ---

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

/// f32 to IEEE half, round to nearest even (normal range; tiny values flush to zero).
fn f16_bits(value: f32) -> u16 {
    let bits = value.to_bits();
    let sign = ((bits >> 16) & 0x8000) as u16;
    let exponent = ((bits >> 23) & 0xff) as i32 - 127 + 15;
    let mantissa = bits & 0x7f_ffff;
    if exponent <= 0 {
        return sign;
    }
    if exponent >= 31 {
        return sign | 0x7c00;
    }
    let mut half = u32::from(sign) | ((exponent as u32) << 10) | (mantissa >> 13);
    let rest = mantissa & 0x1fff;
    if rest > 0x1000 || (rest == 0x1000 && half & 1 == 1) {
        half += 1;
    }
    half as u16
}

/// IEEE half (normal or zero) to f32.
fn f16_value(half: u16) -> f32 {
    let sign = u32::from(half & 0x8000) << 16;
    let exponent = u32::from((half >> 10) & 0x1f);
    if exponent == 0 {
        return f32::from_bits(sign);
    }
    let mantissa = u32::from(half & 0x3ff);
    f32::from_bits(sign | ((exponent + 127 - 15) << 23) | (mantissa << 13))
}

/// A `width × height` equirect map of `radiance` evaluated at each texel centre's direction.
fn synthetic_map(width: u32, height: u32, radiance: impl Fn([f32; 3]) -> [f32; 3]) -> HdriImage {
    let texels = (0..height)
        .flat_map(|y| (0..width).map(move |x| (x, y)))
        .map(|(x, y)| {
            let d = equirect_direction((x as f32 + 0.5) / width as f32, (y as f32 + 0.5) / height as f32);
            let [r, g, b] = radiance(d);
            [f16_bits(r), f16_bits(g), f16_bits(b), f16_bits(1.0)]
        })
        .collect();
    HdriImage { width, height, texels }
}

/// A smooth environment: linear in the direction, everywhere positive.
fn smooth(d: [f32; 3]) -> [f32; 3] {
    [0.5 + 0.3 * d[0], 0.6 + 0.3 * d[1], 0.7 + 0.25 * d[2]]
}

fn ibl_quality(cube_size: u32) -> EnvironmentQuality {
    let mut quality = Quality::off().environment;
    quality.ibl = true;
    quality.cube_size = cube_size;
    quality
}

fn hdri(rotation_degrees: f32) -> Environment {
    Environment::Hdri(HdriEnvironment::new("env/synthetic.hdr").with_rotation_degrees(rotation_degrees).with_sun(HdriSun::Off))
}

/// One frame of graph node 11: the bake `environment` is due, submitted and finished.
fn frame(gpu: &Gpu, maps: &mut EnvironmentMaps, environment: &Environment, quality: &EnvironmentQuality, frame_index: u64, settle: bool, sun_dir: [f32; 3]) -> BakeAction {
    let mut encoder = FrameEncoder::new(&gpu.device, &gpu.queue, "ibl test frame");
    let request = BakeRequest { environment, quality, frame_index, settle, sun_dir, sun_color: [1.0; 3] };
    maps.bake(&mut encoder, &request, None);
    encoder.submit();
    let _ = gpu.device.poll(wgpu::PollType::wait_indefinitely());
    maps.last_work().action
}

/// Maps holding `map`, cold-baked for `environment` at `cube_size`.
fn baked(gpu: &Gpu, map: &HdriImage, environment: &Environment, cube_size: u32) -> EnvironmentMaps {
    let mut maps = EnvironmentMaps::new(&gpu.device, &gpu.queue);
    maps.set_map(&gpu.device, &gpu.queue, map).expect("map uploaded");
    maps.set_environment(environment);
    assert_eq!(frame(gpu, &mut maps, environment, &ibl_quality(cube_size), 0, false, [0.0, 1.0, 0.0]), BakeAction::Full, "a cold bake is whole");
    assert!(maps.baked());
    maps
}

/// The bytes of `buffer` (`bytes` long), mapped after the queue is idle.
fn read_buffer(gpu: &Gpu, buffer: &wgpu::Buffer, bytes: u64) -> Vec<u8> {
    let staging = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("ibl readback"),
        size: bytes,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("ibl readback") });
    encoder.copy_buffer_to_buffer(buffer, 0, &staging, 0, bytes);
    gpu.queue.submit([encoder.finish()]);
    staging.slice(..).map_async(wgpu::MapMode::Read, |result| result.expect("mapped"));
    let _ = gpu.device.poll(wgpu::PollType::wait_indefinitely());
    let data = staging.slice(..).get_mapped_range().expect("mapped range").to_vec();
    staging.unmap();
    data
}

/// The texels of mip `mip`, layer `layer` of `texture` as raw half-float channels (`channels`
/// per texel), row by row.
fn read_layer(gpu: &Gpu, texture: &wgpu::Texture, mip: u32, layer: u32, channels: u32) -> Vec<u16> {
    let (width, height) = ((texture.width() >> mip).max(1), (texture.height() >> mip).max(1));
    let row = width * channels * 2;
    let padded = row.div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT) * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
    let staging = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("ibl texture readback"),
        size: u64::from(padded * height),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("ibl texture readback") });
    encoder.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo { texture, mip_level: mip, origin: wgpu::Origin3d { x: 0, y: 0, z: layer }, aspect: wgpu::TextureAspect::All },
        wgpu::TexelCopyBufferInfo { buffer: &staging, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(padded), rows_per_image: Some(height) } },
        wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
    );
    gpu.queue.submit([encoder.finish()]);
    staging.slice(..).map_async(wgpu::MapMode::Read, |result| result.expect("mapped"));
    let _ = gpu.device.poll(wgpu::PollType::wait_indefinitely());
    let data = staging.slice(..).get_mapped_range().expect("mapped range").to_vec();
    staging.unmap();
    (0..height as usize)
        .flat_map(|y| {
            let start = y * padded as usize;
            data[start..start + row as usize].as_chunks::<2>().0.iter().map(|pair| u16::from_le_bytes(*pair)).collect::<Vec<u16>>()
        })
        .collect()
}

fn read_sh(gpu: &Gpu, maps: &EnvironmentMaps) -> GxEnvSh {
    let bytes = read_buffer(gpu, maps.sh_buffer().expect("baked"), size_of::<GxEnvSh>() as u64);
    *bytemuck::from_bytes::<GxEnvSh>(&bytes)
}

/// Every byte the bake binds: each specular mip's faces, the SH9 block, the LUT.
fn bake_bytes_of(gpu: &Gpu, maps: &EnvironmentMaps) -> Vec<u16> {
    let specular = maps.specular_texture().expect("baked");
    let mut all = Vec::new();
    for mip in 0..SPECULAR_MIPS {
        for face in 0..6 {
            all.extend(read_layer(gpu, specular, mip, face, 4));
        }
    }
    let sh = read_sh(gpu, maps);
    all.extend(bytemuck::cast_slice::<f32, u16>(sh.coefficients.as_flattened()));
    all.extend(read_layer(gpu, maps.brdf_lut_texture().expect("written"), 0, 0, 2));
    all
}

/// Write `pixels` (linear rgb, `width × height`) as a Reinhard-tonemapped sRGB-ish `.ppm` under
/// `GENEX_IBL_CAPTURE_DIR`, when it is set.
fn write_evidence(name: &str, width: u32, height: u32, pixels: &[[f32; 3]]) {
    let Ok(folder) = std::env::var("GENEX_IBL_CAPTURE_DIR") else {
        return;
    };
    let encode = |value: f32| {
        let mapped = value.max(0.0) / (1.0 + value.max(0.0));
        (libm::powf(mapped, 1.0 / 2.2) * 255.0).round() as u8
    };
    let mut bytes = format!("P6\n{width} {height}\n255\n").into_bytes();
    bytes.extend(pixels.iter().flat_map(|pixel| pixel.map(encode)));
    std::fs::create_dir_all(&folder).expect("capture folder");
    std::fs::write(std::path::Path::new(&folder).join(format!("{name}.ppm")), bytes).expect("capture written");
}

/// The specular cube's mips as one strip per mip (faces side by side, +X -X +Y -Y +Z -Z), linear.
fn specular_strip(gpu: &Gpu, maps: &EnvironmentMaps) -> (u32, u32, Vec<[f32; 3]>) {
    let specular = maps.specular_texture().expect("baked");
    let side = specular.width();
    let (width, height) = (side * 6, side * 2);
    let mut pixels = vec![[0.0_f32; 3]; (width * height) as usize];
    let mut top = 0;
    for mip in 0..SPECULAR_MIPS {
        let mip_side = side >> mip;
        for face in 0..6 {
            let texels = read_layer(gpu, specular, mip, face, 4);
            for y in 0..mip_side {
                for x in 0..mip_side {
                    let at = ((y * mip_side + x) * 4) as usize;
                    let pixel = [f16_value(texels[at]), f16_value(texels[at + 1]), f16_value(texels[at + 2])];
                    pixels[((top + y) * width + face * mip_side + x) as usize] = pixel;
                }
            }
        }
        top += mip_side;
    }
    (width, height, pixels)
}

// --- GPU rows ---

#[test]
#[ignore = "needs a WebGPU-core adapter; run with --ignored metal"]
fn metal_the_brdf_lut_matches_the_cpu_split_sum_at_64_points() {
    let Some(gpu) = gpu() else { return };
    let maps = baked(&gpu, &synthetic_map(64, 32, smooth), &hdri(0.0), 64);
    let lut = read_layer(&gpu, maps.brdf_lut_texture().expect("written"), 0, 0, 2);
    let mut worst = 0.0_f64;
    // An 8 x 8 grid of texels, the corners included.
    let points = [0, 18, 36, 54, 73, 91, 109, 127];
    for y in points {
        for x in points {
            let at = ((y * BRDF_LUT_SIZE + x) * 2) as usize;
            let got = [f64::from(f16_value(lut[at])), f64::from(f16_value(lut[at + 1]))];
            let centre = |i: u32| (f64::from(i) + 0.5) / f64::from(BRDF_LUT_SIZE);
            // The converged integral (32x the LUT's points), not the LUT's own estimator.
            let want = brdf_lut_reference(centre(x), centre(y), 32 * BRDF_LUT_SAMPLES);
            for (g, w) in got.iter().zip(want) {
                worst = worst.max((g - w).abs());
                assert!((g - w).abs() <= 1e-3, "texel ({x}, {y}): GPU {got:?}, CPU {want:?}");
            }
        }
    }
    eprintln!("brdf lut: worst difference from the f64 reference {worst:.2e}");
    let pixels: Vec<[f32; 3]> = lut.as_chunks::<2>().0.iter().map(|pair| [f16_value(pair[0]), f16_value(pair[1]), 0.0]).collect();
    write_evidence("RQ2.1-brdf-lut", BRDF_LUT_SIZE, BRDF_LUT_SIZE, &pixels);
}

#[test]
#[ignore = "needs a WebGPU-core adapter; run with --ignored metal"]
fn metal_sh9_of_a_constant_environment_equals_the_analytic_coefficients() {
    let Some(gpu) = gpu() else { return };
    let radiance = [0.5_f32, 1.0, 2.0];
    let maps = baked(&gpu, &synthetic_map(128, 64, |_| radiance), &hdri(0.0), 64);
    let sh = read_sh(&gpu, &maps);
    // A constant L projects onto L00 only: L * 4 pi * Y00 (times the lobe's 1).
    let l00 = 4.0 * core::f32::consts::PI * 0.282_095;
    for (index, coefficient) in sh.coefficients.iter().enumerate() {
        for channel in 0..3 {
            let want = if index == 0 { radiance[channel] * l00 } else { 0.0 };
            assert!((coefficient[channel] - want).abs() <= 1e-3, "coefficient {index} channel {channel}: {} vs {want}", coefficient[channel]);
        }
    }
    for n in [[0.0, 1.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, -1.0], [0.577_350_3, -0.577_350_3, 0.577_350_3]] {
        let e = sh9_eval(&sh, n);
        for (got, want) in e.iter().zip(radiance) {
            assert!((got - want).abs() <= 1e-3 * want, "irradiance at {n:?}: {e:?}");
        }
    }
}

#[test]
#[ignore = "needs a WebGPU-core adapter; run with --ignored metal"]
fn metal_a_constant_environment_prefilters_to_itself_at_every_roughness() {
    // The prefilter is a normalized average: a uniform environment stays uniform at every mip.
    let Some(gpu) = gpu() else { return };
    let radiance = [0.25_f32, 0.5, 1.5];
    let maps = baked(&gpu, &synthetic_map(128, 64, |_| radiance), &hdri(0.0), 64);
    let specular = maps.specular_texture().expect("baked");
    for mip in 0..SPECULAR_MIPS {
        for face in 0..6 {
            let texels = read_layer(&gpu, specular, mip, face, 4);
            for texel in texels.as_chunks::<4>().0 {
                for (half, want) in texel.iter().zip(radiance) {
                    let got = f16_value(*half);
                    assert!((got - want).abs() <= want * 2.0 * HALF_ULP_AT_ONE, "mip {mip} face {face}: {got} vs {want}");
                }
            }
        }
    }
}

#[test]
#[ignore = "needs a WebGPU-core adapter; run with --ignored metal"]
fn metal_specular_mip0_of_a_smooth_environment_equals_the_turned_source() {
    let Some(gpu) = gpu() else { return };
    let rotation = 30.0_f32;
    let maps = baked(&gpu, &synthetic_map(512, 256, smooth), &hdri(rotation), 64);
    let specular = maps.specular_texture().expect("baked");
    let side = specular.width();
    let mut worst = 0.0_f32;
    for face in 0..6 {
        let texels = read_layer(&gpu, specular, 0, face, 4);
        for y in 0..side {
            for x in 0..side {
                let world = cube_direction(face, (x as f32 + 0.5) / side as f32, (y as f32 + 0.5) / side as f32);
                let want = smooth(map_direction(world, rotation.to_radians()));
                let at = ((y * side + x) * 4) as usize;
                for (channel, wanted) in want.iter().enumerate() {
                    let got = f16_value(texels[at + channel]);
                    worst = worst.max((got - wanted).abs());
                    assert!((got - wanted).abs() <= 1.0 / 255.0, "face {face} texel ({x}, {y}) channel {channel}: {got} vs {wanted}");
                }
            }
        }
    }
    eprintln!("specular mip 0: worst difference from the source {worst:.2e}");
    let (width, height, pixels) = specular_strip(&gpu, &maps);
    write_evidence("RQ2.1-specular-smooth-rot30", width, height, &pixels);
}

#[test]
#[ignore = "needs a WebGPU-core adapter; run with --ignored metal"]
fn metal_the_baked_cube_samples_in_the_directions_the_cpu_names() {
    // A sampled cube (as the shading reads it, `texture_cube` + `textureSampleLevel`) agrees with
    // `cube_direction`: WebGPU's face order and orientation are the bake's.
    let Some(gpu) = gpu() else { return };
    let maps = baked(&gpu, &synthetic_map(512, 256, smooth), &hdri(0.0), 64);
    let directions: Vec<[f32; 4]> = [[1.0, 0.2, 0.1], [-1.0, -0.3, 0.2], [0.1, 1.0, -0.4], [0.3, -1.0, 0.2], [-0.2, 0.1, 1.0], [0.4, -0.2, -1.0], [0.6, 0.6, 0.5]]
        .iter()
        .map(|d: &[f32; 3]| {
            let length = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
            [d[0] / length, d[1] / length, d[2] / length, 0.0]
        })
        .collect();
    let sampled = sample_cube(&gpu, &maps, &directions);
    for (d, got) in directions.iter().zip(sampled) {
        let want = smooth([d[0], d[1], d[2]]);
        for channel in 0..3 {
            assert!((got[channel] - want[channel]).abs() <= 2.0 / 255.0, "direction {d:?}: sampled {got:?}, source {want:?}");
        }
    }
}

const SAMPLE_CUBE_WGSL: &str = r"
@group(0) @binding(0) var env: texture_cube<f32>;
@group(0) @binding(1) var env_sampler: sampler;
@group(0) @binding(2) var<storage, read_write> rows: array<vec4<f32>>;

@compute @workgroup_size(1)
fn cs_sample(@builtin(global_invocation_id) id: vec3<u32>) {
    // w: the level of detail (0: the mirror mip).
    rows[id.x] = textureSampleLevel(env, env_sampler, rows[id.x].xyz, rows[id.x].w);
}
";

/// The bound specular cube sampled at `directions` (xyz, at level w) by a compute pass.
fn sample_cube(gpu: &Gpu, maps: &EnvironmentMaps, directions: &[[f32; 4]]) -> Vec<[f32; 4]> {
    use wgpu::util::DeviceExt;
    let device = &gpu.device;
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("sample cube"), source: wgpu::ShaderSource::Wgsl(SAMPLE_CUBE_WGSL.into()) });
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("sample cube"),
        layout: None,
        module: &module,
        entry_point: Some("cs_sample"),
        compilation_options: Default::default(),
        cache: None,
    });
    let rows = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("sample rows"),
        contents: bytemuck::cast_slice(directions),
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
    });
    let cube = maps.specular_texture().expect("baked").create_view(&wgpu::TextureViewDescriptor {
        dimension: Some(wgpu::TextureViewDimension::Cube),
        array_layer_count: Some(6),
        ..Default::default()
    });
    let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
        mag_filter: wgpu::FilterMode::Linear,
        min_filter: wgpu::FilterMode::Linear,
        mipmap_filter: wgpu::MipmapFilterMode::Linear,
        ..Default::default()
    });
    let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("sample cube"),
        layout: &pipeline.get_bind_group_layout(0),
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&cube) },
            wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&sampler) },
            wgpu::BindGroupEntry { binding: 2, resource: rows.as_entire_binding() },
        ],
    });
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("sample cube") });
    {
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("sample cube"), timestamp_writes: None });
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups(directions.len() as u32, 1, 1);
    }
    gpu.queue.submit([encoder.finish()]);
    let bytes = read_buffer(gpu, &rows, (directions.len() * 16) as u64);
    bytemuck::cast_slice::<u8, [f32; 4]>(&bytes).to_vec()
}

#[test]
#[ignore = "needs a WebGPU-core adapter; run with --ignored metal"]
fn metal_the_prefilter_makes_no_fireflies() {
    // A small, very bright spot on a dim sky: every prefiltered texel stays under the source's max.
    let Some(gpu) = gpu() else { return };
    let peak = 1000.0_f32;
    let spot = |d: [f32; 3]| if d[0] * 0.6 + d[1] * 0.8 > 0.9995 { [peak; 3] } else { [0.1, 0.12, 0.15] };
    let map = synthetic_map(1024, 512, spot);
    let source_max = map.texels.iter().flat_map(|texel| texel[..3].iter().map(|half| f16_value(*half))).fold(0.0_f32, f32::max);
    assert_eq!(source_max, peak, "the spot is in the map");
    let maps = baked(&gpu, &map, &hdri(0.0), 128);
    let specular = maps.specular_texture().expect("baked");
    let mut brightest = 0.0_f32;
    for mip in 0..SPECULAR_MIPS {
        for face in 0..6 {
            let texels = read_layer(&gpu, specular, mip, face, 4);
            for texel in texels.as_chunks::<4>().0 {
                let top = texel[..3].iter().map(|half| f16_value(*half)).fold(0.0_f32, f32::max);
                assert!(top.is_finite() && top <= source_max * (1.0 + HALF_ULP_AT_ONE), "mip {mip} face {face}: {top} above the source's {source_max}");
                brightest = brightest.max(top);
            }
        }
    }
    assert!(brightest > 1.0, "the spot reaches the cube: {brightest}");
    let (width, height, pixels) = specular_strip(&gpu, &maps);
    write_evidence("RQ2.1-specular-spot-mips", width, height, &pixels);
}

#[test]
#[ignore = "needs a WebGPU-core adapter; run with --ignored metal"]
fn metal_two_bakes_are_byte_identical() {
    let Some(gpu) = gpu() else { return };
    let map = synthetic_map(256, 128, |d| [0.2 + d[0].max(0.0) * 4.0, 0.3 + d[1].abs(), 0.4 + d[2] * d[2] * 2.0]);
    let first = baked(&gpu, &map, &hdri(15.0), 128);
    let second = baked(&gpu, &map, &hdri(15.0), 128);
    assert_eq!(bake_bytes_of(&gpu, &first), bake_bytes_of(&gpu, &second));
}

#[test]
#[ignore = "needs a WebGPU-core adapter; run with --ignored metal"]
fn metal_a_time_sliced_rebake_and_a_settled_capture_equal_a_cold_bake() {
    let Some(gpu) = gpu() else { return };
    let map = synthetic_map(256, 128, |d| [0.2 + d[0].max(0.0) * 4.0, 0.3 + d[1].abs(), 0.4 + d[2] * d[2] * 2.0]);
    let quality = ibl_quality(64);
    let cold = bake_bytes_of(&gpu, &baked(&gpu, &map, &hdri(0.0), 64));

    // Baked turned a quarter, then turned back: the rebake lands in SLICE_STEPS frames, one step each.
    let mut sliced = baked(&gpu, &map, &hdri(90.0), 64);
    for index in 0..SLICE_STEPS {
        let action = frame(&gpu, &mut sliced, &hdri(0.0), &quality, 1 + u64::from(index), false, [0.0, 1.0, 0.0]);
        assert!(matches!(action, BakeAction::Slice(_)), "frame {index}: {action:?}");
    }
    assert_eq!(frame(&gpu, &mut sliced, &hdri(0.0), &quality, 99, false, [0.0, 1.0, 0.0]), BakeAction::Idle);
    assert_eq!(bake_bytes_of(&gpu, &sliced), cold, "a finished time-sliced rebake is the cold bake");

    // A settled capture mid-rebake bakes whole and equals the cold bake.
    let mut settled = baked(&gpu, &map, &hdri(90.0), 64);
    for index in 0..4 {
        frame(&gpu, &mut settled, &hdri(0.0), &quality, 1 + index, false, [0.0, 1.0, 0.0]);
    }
    assert_eq!(frame(&gpu, &mut settled, &hdri(0.0), &quality, 0, true, [0.0, 1.0, 0.0]), BakeAction::Full);
    assert_eq!(bake_bytes_of(&gpu, &settled), cold, "a settled capture equals a capture after a cold bake");
    assert_eq!(frame(&gpu, &mut settled, &hdri(0.0), &quality, 0, true, [0.0, 1.0, 0.0]), BakeAction::Idle, "and the next settle frame has nothing to do");
}

#[test]
#[ignore = "needs a WebGPU-core adapter; run with --ignored metal"]
fn metal_an_unchanged_environment_costs_nothing_and_ibl_off_binds_the_neutral_inputs() {
    let Some(gpu) = gpu() else { return };
    let mut maps = baked(&gpu, &synthetic_map(64, 32, smooth), &hdri(0.0), 64);
    let quality = ibl_quality(64);
    for index in 1..6 {
        let mut encoder = FrameEncoder::new(&gpu.device, &gpu.queue, "ibl idle");
        let request = BakeRequest { environment: &hdri(0.0), quality: &quality, frame_index: index, settle: false, sun_dir: [0.3, 0.9, 0.1], sun_color: [index as f32; 3] };
        let passes = maps.bake(&mut encoder, &request, None);
        assert_eq!((passes.compute, passes.render), (0, 0), "frame {index}: an HDRI ignores the sun");
        assert_eq!(maps.last_work().texel_samples, 0);
    }
    let generation = maps.generation();
    let off = Quality::off().environment;
    assert_eq!(frame(&gpu, &mut maps, &hdri(0.0), &off, 7, false, [0.0, 1.0, 0.0]), BakeAction::Idle);
    assert!(!maps.baked() && maps.specular_texture().is_none(), "IBL off releases the cubes");
    assert!(maps.generation() > generation, "and the frame rebinds the neutral inputs");
    assert_eq!(frame(&gpu, &mut maps, &Environment::Color, &quality, 8, false, [0.0, 1.0, 0.0]), BakeAction::Idle, "the flat colour bakes nothing");
    assert!(!maps.baked());
}

/// One frame of graph node 11 for the physical sky: its LUTs for the sun at `sun_dir`, then the
/// bake from them.
fn sky_frame(gpu: &Gpu, sky: &mut SkyState, maps: &mut EnvironmentMaps, quality: &EnvironmentQuality, tick: u64, sun_dir: [f32; 3]) -> BakeAction {
    let Environment::Sky(params) = Environment::sky() else { unreachable!("the default sky") };
    let mut encoder = FrameEncoder::new(&gpu.device, &gpu.queue, "ibl sky frame");
    let sun = SkyFrame { sun_dir, sun_illuminance: [1.0; 3], camera_height_km: 0.002, frame_index: tick };
    sky.encode_luts(&gpu.device, &gpu.queue, encoder.encoder(), LutRefresh::new(&params, quality, sun));
    let request = BakeRequest { environment: &Environment::sky(), quality, frame_index: tick, settle: false, sun_dir, sun_color: [1.0; 3] };
    maps.bake(&mut encoder, &request, Some(sky));
    encoder.submit();
    let _ = gpu.device.poll(wgpu::PollType::wait_indefinitely());
    maps.last_work().action
}

#[test]
#[ignore = "needs a WebGPU-core adapter; run with --ignored metal"]
fn metal_a_sun_turning_a_tenth_of_a_degree_a_tick_keeps_the_sky_bake_within_its_slice_budget() {
    let Some(gpu) = gpu() else { return };
    let side = 128;
    let mut quality = preset_quality(QualityPreset::High, DeviceClass::ALL[0]).environment;
    quality.ibl = true;
    quality.cube_size = side;
    // Renderer pass 2 A.3 (SI-02 step 2) flips high to a continuous rebake: this row holds the
    // time-sliced cycle every other quality (and phones) keeps.
    quality.continuous_sky = false;
    let mut maps = EnvironmentMaps::new(&gpu.device, &gpu.queue);
    let mut sky = SkyState::new();
    sky.set_environment(&Environment::sky());
    maps.set_environment(&Environment::sky());
    let sun = |tick: u64| {
        let angle = (20.0 + 0.1 * tick as f32).to_radians();
        [libm::cosf(angle), libm::sinf(angle), 0.0]
    };
    assert_eq!(sky_frame(&gpu, &mut sky, &mut maps, &quality, 0, sun(0)), BakeAction::Full, "the cold bake, from the sky's first LUTs");
    let sh = read_sh(&gpu, &maps);
    assert!(sh.coefficients[0][2] > sh.coefficients[0][0], "a clear sky lights bluer than red: {:?}", sh.coefficients[0]);
    let (width, height, pixels) = specular_strip(&gpu, &maps);
    write_evidence("RQ2.1-specular-sky-sun20", width, height, &pixels);
    let (mut slices, mut idle, mut completed) = (0, 0, 0);
    for tick in 1..=200 {
        let action = sky_frame(&gpu, &mut sky, &mut maps, &quality, tick, sun(tick));
        let work = maps.last_work();
        assert!(work.texel_samples <= slice_budget(side), "tick {tick}: {action:?} read {} samples", work.texel_samples);
        match action {
            BakeAction::Slice(step) => {
                slices += 1;
                completed += u32::from(step == SliceStep::Sh9);
            }
            BakeAction::Idle => idle += 1,
            BakeAction::Full => panic!("tick {tick}: a whole bake outside a settle"),
        }
    }
    assert!(completed >= 10, "a moving sun keeps refreshing: {completed} full refreshes in 200 ticks");
    eprintln!("200 ticks at 0.1 deg: {slices} slice frames, {idle} idle frames, {completed} refreshes; budget {} samples a frame", slice_budget(side));
}

/// The 60 fps frame interval, ms: the bake's budgets are shares of it on every adapter.
const FRAME_INTERVAL_MS: f64 = 1000.0 / 60.0;
/// A whole bake (a cold bake, a settled capture) may take this share of one frame on the GPU.
const FULL_BAKE_SHARE: f64 = 0.3;
/// One time-sliced step may take this share of every frame it runs in (p95).
const SLICE_SHARE: f64 = 0.03;

/// Records the GPU timestamps of bake frames into one query set, each frame its own submission
/// submitted back to back (as frames are: a GPU left idle between tiny submissions drops its
/// clocks, and the pass after the idle pays the wake-up), read once at the end.
struct BakeTimer {
    queries: wgpu::QuerySet,
    frames: u32,
    used: u32,
}

impl BakeTimer {
    fn new(gpu: &Gpu, frames: u32) -> BakeTimer {
        let queries = gpu.device.create_query_set(&wgpu::QuerySetDescriptor { label: Some("ibl timing"), ty: wgpu::QueryType::Timestamp, count: 2 * frames });
        BakeTimer { queries, frames, used: 0 }
    }

    /// One bake frame of `maps` for `request`, timed when anything was due.
    fn frame(&mut self, gpu: &Gpu, maps: &mut EnvironmentMaps, request: &BakeRequest<'_>) {
        assert!(self.used < self.frames, "the timer's query set is full");
        let mut encoder = FrameEncoder::new(&gpu.device, &gpu.queue, "ibl timed frame");
        let first = 2 * self.used;
        let writes = wgpu::ComputePassTimestampWrites { query_set: &self.queries, beginning_of_pass_write_index: Some(first), end_of_pass_write_index: Some(first + 1) };
        maps.bake_timed(&mut encoder, request, None, Some(writes));
        if maps.last_work().action != BakeAction::Idle {
            self.used += 1;
        }
        encoder.submit();
    }

    /// GPU milliseconds of every timed frame, in order.
    fn read(&self, gpu: &Gpu) -> Vec<f64> {
        let bytes = u64::from(2 * self.used) * 8;
        if bytes == 0 {
            return Vec::new();
        }
        let resolve = gpu.device.create_buffer(&wgpu::BufferDescriptor { label: Some("ibl timing"), size: bytes, usage: wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC, mapped_at_creation: false });
        let read = gpu.device.create_buffer(&wgpu::BufferDescriptor { label: Some("ibl timing read"), size: bytes, usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
        // Metal's counter sample buffers are not hazard-tracked: resolve after the frames finished.
        let _ = gpu.device.poll(wgpu::PollType::wait_indefinitely());
        let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("ibl timing resolve") });
        encoder.resolve_query_set(&self.queries, 0..2 * self.used, &resolve, 0);
        encoder.copy_buffer_to_buffer(&resolve, 0, &read, 0, bytes);
        gpu.queue.submit([encoder.finish()]);
        read.slice(..).map_async(wgpu::MapMode::Read, |result| result.expect("mapped"));
        let _ = gpu.device.poll(wgpu::PollType::wait_indefinitely());
        let stamps: Vec<u64> = read.slice(..).get_mapped_range().expect("mapped range").as_chunks::<8>().0.iter().map(|b| u64::from_le_bytes(*b)).collect();
        let period = f64::from(gpu.queue.get_timestamp_period());
        stamps.as_chunks::<2>().0.iter().map(|[begin, end]| end.saturating_sub(*begin) as f64 * period / 1e6).collect()
    }
}

#[test]
#[ignore = "needs a WebGPU-core adapter; run with --ignored metal"]
fn metal_bake_of_a_1k_hdri_is_recorded() {
    // Performance review 4: the gate held only on M4 adapters and timed submit-to-idle wall time.
    // The bake's own pass is timed on the GPU now, and held on every adapter with timestamps to a
    // share of a 60 fps frame: a whole bake within FULL_BAKE_SHARE, each time-sliced step's p95
    // within SLICE_SHARE.
    let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
    let gpu = match Gpu::headless_with(wgpu::Features::TIMESTAMP_QUERY) {
        Ok(gpu) => gpu,
        Err(error) => {
            assert!(!require, "GENEX_REQUIRE_METAL=1 and no adapter with timestamps: {error}");
            eprintln!("skipped: no adapter with timestamp queries ({error})");
            return;
        }
    };
    let map = synthetic_map(1024, 512, |d| [0.2 + d[0].max(0.0) * 8.0, 0.3 + d[1].abs() * 2.0, 0.4 + d[2] * d[2] * 3.0]);
    let mut fields = vec![format!("\"row\":\"ibl-bake-1k-hdri\",\"adapter\":\"{}\",\"timing\":\"gpu timestamps, back-to-back frames\"", gpu.receipt().adapter)];
    let mut failures = Vec::new();
    let p = |sorted: &[f64], q: f64| sorted[((sorted.len() - 1) as f64 * q).round() as usize];
    for side in [64_u32, 128, 256, 512] {
        let quality = ibl_quality(side);
        let mut maps = baked(&gpu, &map, &hdri(0.0), side);
        // Whole bakes: settled frames alternating the rotation, after two untimed (warm-up).
        let mut timer = BakeTimer::new(&gpu, 9);
        for run in 0..11u64 {
            let environment = hdri(if run % 2 == 0 { 10.0 } else { 0.0 });
            let bake = BakeRequest { environment: &environment, quality: &quality, frame_index: run, settle: true, sun_dir: [0.0, 1.0, 0.0], sun_color: [1.0; 3] };
            if run < 2 {
                frame(&gpu, &mut maps, &environment, &quality, run, true, [0.0, 1.0, 0.0]);
                continue;
            }
            timer.frame(&gpu, &mut maps, &bake);
        }
        let mut full = timer.read(&gpu);
        full.sort_by(f64::total_cmp);
        // Time-sliced rebakes: three cycles, one step a frame.
        let mut timer = BakeTimer::new(&gpu, 3 * SLICE_STEPS);
        for cycle in 0..3u64 {
            let environment = hdri(20.0 + 10.0 * cycle as f32);
            for index in 0..u64::from(SLICE_STEPS) {
                let bake = BakeRequest { environment: &environment, quality: &quality, frame_index: 100 + 20 * cycle + index, settle: false, sun_dir: [0.0, 1.0, 0.0], sun_color: [1.0; 3] };
                timer.frame(&gpu, &mut maps, &bake);
            }
        }
        let mut slices = timer.read(&gpu);
        slices.sort_by(f64::total_cmp);
        assert_eq!(slices.len(), 3 * SLICE_STEPS as usize, "every step was timed");
        let (full_p50, slice_p95) = (p(&full, 0.5), p(&slices, 0.95));
        fields.push(format!(
            "\"cube{side}\":{{\"fullBakeP50Ms\":{full_p50:.4},\"fullBakeMaxMs\":{:.4},\"sliceP50Ms\":{:.4},\"sliceP95Ms\":{slice_p95:.4},\"sliceMaxMs\":{:.4},\"bytes\":{}}}",
            full[full.len() - 1],
            p(&slices, 0.5),
            slices[slices.len() - 1],
            bake_bytes(&quality)
        ));
        if full_p50 > FULL_BAKE_SHARE * FRAME_INTERVAL_MS {
            failures.push(format!("cube {side}: a whole bake takes {full_p50:.3} ms"));
        }
        if slice_p95 > SLICE_SHARE * FRAME_INTERVAL_MS {
            failures.push(format!("cube {side}: a slice's p95 is {slice_p95:.3} ms"));
        }
    }
    let row = format!("{{{}}}", fields.join(","));
    println!("{row}");
    if let Ok(path) = std::env::var("GENEX_PERF_OUT") {
        std::fs::write(path, format!("{row}\n")).expect("perf row");
    }
    assert!(failures.is_empty(), "over the frame-share budgets: {failures:?}");
}

// --- RQ2 review rows ---

/// The bytes the frame binds from `maps` (every specular mip's faces and the SH9 block).
fn bound_bytes(gpu: &Gpu, maps: &EnvironmentMaps) -> Vec<u16> {
    bake_bytes_of(gpu, maps)
}

#[test]
#[ignore = "needs a WebGPU-core adapter; run with --ignored metal"]
fn metal_a_rebake_never_binds_a_cube_mixing_two_environments() {
    // Visual review 1: a rebake wrote the bound cube one face per frame, so reflections showed a
    // patchwork of old and new faces for 12 frames. The frame now binds the last complete bake
    // until the rebake's last step, then the new one whole.
    let Some(gpu) = gpu() else { return };
    let map = synthetic_map(256, 128, |d| [0.2 + d[0].max(0.0) * 4.0, 0.3 + d[1].abs(), 0.4 + d[2] * d[2] * 2.0]);
    let quality = ibl_quality(64);
    let before = bound_bytes(&gpu, &baked(&gpu, &map, &hdri(0.0), 64));
    let after = bound_bytes(&gpu, &baked(&gpu, &map, &hdri(90.0), 64));
    assert_ne!(before, after, "the two environments differ");
    let mut maps = baked(&gpu, &map, &hdri(0.0), 64);
    let generation = maps.generation();
    for index in 0..SLICE_STEPS {
        let action = frame(&gpu, &mut maps, &hdri(90.0), &quality, 1 + u64::from(index), false, [0.0, 1.0, 0.0]);
        assert!(matches!(action, BakeAction::Slice(_)), "frame {index}: {action:?}");
        let bound = bound_bytes(&gpu, &maps);
        if index + 1 < SLICE_STEPS {
            assert!(bound == before, "frame {index}: the frame still binds the whole old bake");
            assert_eq!(maps.generation(), generation, "frame {index}: nothing rebinds mid-rebake");
        } else {
            assert!(bound == after, "the last step binds the whole new bake, equal to a cold bake of it");
            assert!(maps.generation() > generation, "and the frame rebinds");
        }
    }
}

#[test]
#[ignore = "needs a WebGPU-core adapter; run with --ignored metal"]
fn metal_a_smaller_cube_from_dynamic_resolution_is_rebaked_in_slices_behind_the_bound_one() {
    // Performance review 2: a demotion halving the cube reset the schedule and baked whole in the
    // demoted frame. It is now a time-sliced rebake into the new size; the old cube stays bound.
    let Some(gpu) = gpu() else { return };
    let map = synthetic_map(256, 128, smooth);
    let mut maps = baked(&gpu, &map, &hdri(0.0), 128);
    let demoted = ibl_quality(64);
    for index in 0..SLICE_STEPS {
        let action = frame(&gpu, &mut maps, &hdri(0.0), &demoted, 1 + u64::from(index), false, [0.0, 1.0, 0.0]);
        assert_eq!(action, BakeAction::Slice(SliceStep::at(index)), "frame {index}: never a whole bake outside a settle");
        let side = if index + 1 < SLICE_STEPS { 128 } else { 64 };
        assert_eq!(maps.bound_side(), Some(side), "frame {index}");
        assert!(maps.last_work().texel_samples <= slice_budget(128), "frame {index}: within a slice's budget");
    }
    let cold = bound_bytes(&gpu, &baked(&gpu, &map, &hdri(0.0), 64));
    assert!(bound_bytes(&gpu, &maps) == cold, "the sliced rebake at the new size equals a cold bake of it");
}

#[test]
#[ignore = "needs a WebGPU-core adapter; run with --ignored metal"]
fn metal_the_map_s_analytic_sun_is_where_the_bake_puts_the_map_s_brightest_texel() {
    // Visual/contract review: the map's sun drives `frame.sun` (`EnvironmentMaps::analytic_sun`).
    // Its world direction must be where the bake shows the sun, at any rotation.
    let Some(gpu) = gpu() else { return };
    let towards = |d: [f32; 3]| {
        let length = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
        d.map(|c| c / length)
    };
    let sun_in_map = towards([0.3, 0.6, -0.74]);
    let disk = libm::cosf(1.5_f32.to_radians());
    let map = synthetic_map(1024, 512, |d| {
        let on = d[0] * sun_in_map[0] + d[1] * sun_in_map[1] + d[2] * sun_in_map[2] > disk;
        if on { [3000.0, 2800.0, 2500.0] } else { [0.1, 0.15, 0.25] }
    });
    for rotation in [0.0_f32, 90.0, 215.0] {
        let analytic = Environment::Hdri(HdriEnvironment::new("env/sun.hdr").with_rotation_degrees(rotation));
        let off = Environment::Hdri(HdriEnvironment::new("env/sun.hdr").with_rotation_degrees(rotation).with_sun(HdriSun::Off));
        let maps = baked(&gpu, &map, &off, 128);
        let Environment::Hdri(hdri_env) = &analytic else { unreachable!() };
        let (sun_dir, sun_color) = maps.analytic_sun(hdri_env).expect("the map has a sun");
        assert!(sun_color[0] > sun_color[2] && sun_color[2] > 1.0, "{rotation}: the sun's irradiance, warm: {sun_color:?}");
        let Environment::Hdri(off_env) = &off else { unreachable!() };
        assert_eq!(maps.analytic_sun(off_env), None, "HdriSun::Off keeps the frame's own sun");
        // The brightest texel of the baked mirror mip (the sun kept in the map under Off).
        let specular = maps.specular_texture().expect("baked");
        let side = specular.width();
        let (mut best, mut at) = (0.0_f32, [0.0; 3]);
        for face in 0..6 {
            let texels = read_layer(&gpu, specular, 0, face, 4);
            for y in 0..side {
                for x in 0..side {
                    let red = f16_value(texels[((y * side + x) * 4) as usize]);
                    if red > best {
                        best = red;
                        at = cube_direction(face, (x as f32 + 0.5) / side as f32, (y as f32 + 0.5) / side as f32);
                    }
                }
            }
        }
        let angle = libm::acosf((at[0] * sun_dir[0] + at[1] * sun_dir[1] + at[2] * sun_dir[2]).clamp(-1.0, 1.0)).to_degrees();
        assert!(angle < 2.0, "rotation {rotation}: the sun lights from {sun_dir:?}, the bake shows it at {at:?} ({angle:.2} degrees apart)");
    }
}

/// The GGX-prefiltered radiance of `radiance` towards `r` at perceptual `roughness` with the
/// split-sum assumption (n = v = r), integrated on the CPU over `samples` Hammersley points:
/// the reference the baked cube is read against.
fn ggx_prefiltered(radiance: &dyn Fn([f32; 3]) -> [f32; 3], r: [f64; 3], roughness: f64, samples: u32) -> [f64; 3] {
    let alpha = roughness * roughness;
    let up = if r[2].abs() < 0.999 { [0.0, 0.0, 1.0] } else { [1.0, 0.0, 0.0] };
    let cross = |a: [f64; 3], b: [f64; 3]| [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    let normalize = |d: [f64; 3]| {
        let length = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
        d.map(|c| c / length)
    };
    let tx = normalize(cross(up, r));
    let ty = cross(r, tx);
    let (mut sum, mut weight) = ([0.0_f64; 3], 0.0_f64);
    for i in 0..samples {
        let h = ggx_half_vector(hammersley(i, samples), alpha.max(1e-6));
        let h = [0, 1, 2].map(|k| tx[k] * h[0] + ty[k] * h[1] + r[k] * h[2]);
        let v_dot_h = r[0] * h[0] + r[1] * h[1] + r[2] * h[2];
        let l = [0, 1, 2].map(|k| 2.0 * v_dot_h * h[k] - r[k]);
        let n_dot_l = r[0] * l[0] + r[1] * l[1] + r[2] * l[2];
        if n_dot_l > 0.0 {
            let value = radiance([l[0] as f32, l[1] as f32, l[2] as f32]);
            for (channel, total) in sum.iter_mut().enumerate() {
                *total += f64::from(value[channel]) * n_dot_l;
            }
            weight += n_dot_l;
        }
    }
    sum.map(|total| total / weight)
}

#[test]
#[ignore = "needs a WebGPU-core adapter; run with --ignored metal"]
fn metal_a_roughness_between_two_levels_reads_close_to_its_own_ggx_lobe() {
    // Visual review 7 on the GPU: the baked cube read as the shading reads it (`roughness_lod`,
    // trilinear) at roughnesses between its levels, against the exact GGX lobe on the CPU. The
    // level model row above shows the levels' share of the error; this one bounds the bake's.
    let Some(gpu) = gpu() else { return };
    let (radiance, directions) = spot_environment();
    let maps = baked(&gpu, &synthetic_map(1024, 512, radiance), &hdri(0.0), 256);
    let (mut total, mut count) = (0.0_f64, 0.0_f64);
    for roughness in [0.0625_f32, 0.125, 0.1875, 0.375, 0.625, 0.875] {
        let reads: Vec<[f32; 4]> = directions.iter().map(|d| [d[0] as f32, d[1] as f32, d[2] as f32, roughness_lod(roughness)]).collect();
        for (d, got) in directions.iter().zip(sample_cube(&gpu, &maps, &reads)) {
            let reference = ggx_prefiltered(&radiance, *d, f64::from(roughness), LOBE_SAMPLES);
            let error = lobe_error([0, 1, 2].map(|c| f64::from(got[c])), reference);
            eprintln!("r {roughness} dir {d:?}: baked {:?} reference {reference:?} error {error:.3}", &got[..3]);
            total += error;
            count += 1.0;
        }
    }
    let mean = total / count;
    eprintln!("mean relative error of the baked read: {mean:.3}");
    assert!(mean < READ_LOBE_ERROR, "the mean relative error against the exact lobe is {mean:.3}");
}

/// Hammersley points of the CPU prefilter reference.
const LOBE_SAMPLES: u32 = 1 << 14;

/// The largest mean relative error of a roughness read between two levels against its exact GGX
/// lobe (at and around a hard-edged bright spot, the hardest case for a few levels).
const READ_LOBE_ERROR: f64 = 0.15;

/// A hard-edged bright spot (12 degrees in radius) on a dim sky, and directions 6 to 18 degrees
/// from its centre: the hardest case for a prefiltered cube's few roughness levels.
fn spot_environment() -> (impl Fn([f32; 3]) -> [f32; 3] + Copy, Vec<[f64; 3]>) {
    let spot = {
        let d = [0.6_f32, 0.48, -0.64];
        let length = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
        d.map(|c| c / length)
    };
    let edge = libm::cosf(12.0_f32.to_radians());
    let radiance = move |d: [f32; 3]| {
        let on = d[0] * spot[0] + d[1] * spot[1] + d[2] * spot[2] > edge;
        if on { [6.0, 5.0, 4.0] } else { [0.2, 0.25, 0.3] }
    };
    // A unit direction at right angles to the spot's centre (the spot crossed with +y).
    let across = {
        let d = [-spot[2], 0.0, spot[0]];
        let length = (d[0] * d[0] + d[2] * d[2]).sqrt();
        d.map(|c| c / length)
    };
    let directions = [6.0_f32, 10.0, 12.0, 14.0, 18.0]
        .iter()
        .map(|degrees| {
            let (s, c) = (libm::sinf(degrees.to_radians()), libm::cosf(degrees.to_radians()));
            [0, 1, 2].map(|k| f64::from(spot[k] * c + across[k] * s))
        })
        .collect();
    (radiance, directions)
}

/// The mean relative error, over channels, of `got` against `reference` (dim values count as 0.2).
fn lobe_error(got: [f64; 3], reference: [f64; 3]) -> f64 {
    (0..3).map(|c| (got[c] - reference[c]).abs() / reference[c].max(0.2)).sum::<f64>() / 3.0
}

#[test]
fn the_perceptual_levels_read_closer_to_the_exact_lobe_than_linear_levels() {
    // Visual review 7, on the CPU: a read between two levels mixes their lobes as the trilinear
    // read does. With the levels this build bakes (`mip_roughness`, read at `roughness_lod`) that
    // mix is much closer to the exact lobe than the same count of linear levels read at
    // `roughness × last`, which made roughness 0.125 half a mirror.
    let (radiance, directions) = spot_environment();
    let last = (SPECULAR_MIPS - 1) as f64;
    let model = |level: &dyn Fn(f64) -> f64, lod: &dyn Fn(f64) -> f64| {
        let (mut total, mut count) = (0.0, 0.0);
        for r in [0.0625_f64, 0.125, 0.1875, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875] {
            for d in &directions {
                let reference = ggx_prefiltered(&radiance, *d, r, MODEL_SAMPLES);
                let at = lod(r);
                let (below, t) = (at.floor(), at - at.floor());
                let low = ggx_prefiltered(&radiance, *d, level(below), MODEL_SAMPLES);
                let high = ggx_prefiltered(&radiance, *d, level((below + 1.0).min(last)), MODEL_SAMPLES);
                total += lobe_error([0, 1, 2].map(|c| low[c] * (1.0 - t) + high[c] * t), reference);
                count += 1.0;
            }
        }
        total / count
    };
    let shipped = model(&|k| f64::from(genex_render::ibl::mip_roughness(k as u32)), &|r| f64::from(roughness_lod(r as f32)));
    let linear = model(&|k| k / last, &|r| r * last);
    eprintln!("mean relative error of a read between levels: shipped {shipped:.3}, linear {linear:.3}");
    assert!(shipped < 0.6 * linear, "the shipped levels ({shipped:.3}) read far closer to the exact lobe than linear ones ({linear:.3})");
}

/// Hammersley points of the CPU level model.
const MODEL_SAMPLES: u32 = 4096;

// --- Pass 2 P2-0.11: IBL and sky correctness ---

/// A unit vector along `d`.
fn unit(d: [f32; 3]) -> [f32; 3] {
    let length = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
    d.map(|c| c / length)
}

/// The centre of the small spot (a sun-sized source kept in the map).
fn small_spot_centre() -> [f32; 3] {
    unit([0.6, 0.48, -0.64])
}

/// A bright disc of `radius_degrees` around [`small_spot_centre`] on a dim sky.
fn small_spot(radius_degrees: f32, peak: [f32; 3]) -> impl Fn([f32; 3]) -> [f32; 3] + Copy {
    let centre = small_spot_centre();
    let edge = libm::cosf(radius_degrees.to_radians());
    move |d: [f32; 3]| {
        let on = d[0] * centre[0] + d[1] * centre[1] + d[2] * centre[2] > edge;
        if on { peak } else { [0.2, 0.25, 0.3] }
    }
}

/// The unit direction `degrees` from the spot's centre, turned towards the horizontal.
fn off_spot(degrees: f32) -> [f64; 3] {
    let centre = small_spot_centre();
    let across = unit([-centre[2], 0.0, centre[0]]);
    let (s, c) = (libm::sinf(degrees.to_radians()), libm::cosf(degrees.to_radians()));
    [0, 1, 2].map(|k| f64::from(centre[k] * c + across[k] * s))
}

/// The spot's radiance a read must reach for the edge rows (well above the dim sky).
const SMALL_SPOT_PEAK: [f32; 3] = [40.0, 36.0, 30.0];
/// The angles across the 1-degree spot's edge the read rows sample, degrees from its centre.
const SPOT_EDGE_DEGREES: [f32; 9] = [0.0, 0.5, 0.8, 1.0, 1.2, 1.5, 2.0, 3.0, 5.0];
/// The largest mean relative error of the prefilter's first roughness level (read exactly at its
/// level) against its exact GGX lobe across a 1-degree spot's edge (SI-01).
const LEVEL_ONE_SPOT_ERROR: f64 = 0.1;
/// The largest mean relative error of a read at roughness 0.0625 or 0.125 against its exact lobe
/// across the same edge (SI-01; the level interpolation's own error included).
const LOW_ROUGHNESS_SPOT_ERROR: f64 = 0.35;
/// How much wider than the exact lobe's the baked 10-90% edge of the spot may be at roughness
/// 0.0625, as a ratio (the polished sphere's sharp sun-edge reflection).
const SPOT_EDGE_WIDTH_RATIO: f64 = 2.0;

/// The angle (degrees from the spot's centre, over `profile`'s `step` spacing) where `profile`
/// falls through `share` of the way from its outer value to its centre value.
fn crossing(profile: &[f64], step: f64, share: f64) -> f64 {
    let (centre, outer) = (profile[0], profile[profile.len() - 1]);
    let level = outer + share * (centre - outer);
    for (index, pair) in profile.windows(2).enumerate() {
        if pair[0] >= level && pair[1] < level {
            let t = (pair[0] - level) / (pair[0] - pair[1]);
            return (index as f64 + t) * step;
        }
    }
    (profile.len() - 1) as f64 * step
}

#[test]
#[ignore = "needs a WebGPU-core adapter; run with --ignored metal"]
fn metal_a_one_degree_spot_prefilters_close_to_its_ggx_lobe_at_low_roughness() {
    // SI-01: every glossy level was prefiltered from a 32 px radiance cube (2.8-degree texels), so
    // the sharpest lobes read a source blurred 3 to 6 times their own width. A 1-degree source (a
    // sun-sized spot left in the map, the high preset's 256 px cube) read at roughness 0.0625 and
    // 0.125 and at the first level exactly, against the exact GGX lobe.
    let Some(gpu) = gpu() else { return };
    let radiance = small_spot(1.0, SMALL_SPOT_PEAK);
    let maps = baked(&gpu, &synthetic_map(2048, 1024, radiance), &hdri(0.0), 256);
    let directions: Vec<[f64; 3]> = SPOT_EDGE_DEGREES.iter().map(|degrees| off_spot(*degrees)).collect();
    let mean_error = |roughness: f32, lod: f32| {
        let reads: Vec<[f32; 4]> = directions.iter().map(|d| [d[0] as f32, d[1] as f32, d[2] as f32, lod]).collect();
        let mut total = 0.0;
        for (d, got) in directions.iter().zip(sample_cube(&gpu, &maps, &reads)) {
            let reference = ggx_prefiltered(&radiance, *d, f64::from(roughness), LOBE_SAMPLES);
            let error = lobe_error([0, 1, 2].map(|c| f64::from(got[c])), reference);
            eprintln!("r {roughness} lod {lod:.3} dir {d:?}: baked {:?} reference {reference:?} error {error:.3}", &got[..3]);
            total += error;
        }
        total / directions.len() as f64
    };
    let level_one = mean_error(genex_render::ibl::mip_roughness(1), 1.0);
    let reads = [0.0625_f32, 0.125].map(|roughness| mean_error(roughness, roughness_lod(roughness)));
    eprintln!("1-degree spot: level 1 mean error {level_one:.3}; roughness 0.0625 {:.3}, 0.125 {:.3}", reads[0], reads[1]);

    // The edge's sharpness at roughness 0.0625: the 10-90% width of the baked read against the
    // exact lobe's, along a line from the centre out.
    let step = 0.05_f64;
    let line: Vec<[f64; 3]> = (0..=80).map(|i| off_spot((f64::from(i) * step) as f32)).collect();
    let lod = roughness_lod(0.0625);
    let reads_line: Vec<[f32; 4]> = line.iter().map(|d| [d[0] as f32, d[1] as f32, d[2] as f32, lod]).collect();
    let baked_profile: Vec<f64> = sample_cube(&gpu, &maps, &reads_line).iter().map(|texel| f64::from(texel[1])).collect();
    let exact_profile: Vec<f64> = line.iter().map(|d| ggx_prefiltered(&radiance, *d, 0.0625, LOBE_SAMPLES)[1]).collect();
    let width = |profile: &[f64]| crossing(profile, step, 0.1) - crossing(profile, step, 0.9);
    let (baked_width, exact_width) = (width(&baked_profile), width(&exact_profile));
    eprintln!("roughness 0.0625 edge 10-90%: baked {baked_width:.3} deg, exact {exact_width:.3} deg");
    let pixels: Vec<[f32; 3]> = baked_profile.iter().zip(&exact_profile).flat_map(|(b, e)| [[*b as f32; 3], [*e as f32; 3]]).collect();
    write_evidence("P2-0.11-spot-edge-0.0625-baked-vs-exact", 2, (pixels.len() / 2) as u32, &pixels);
    assert!(level_one < LEVEL_ONE_SPOT_ERROR, "the first level's mean error against its exact lobe is {level_one:.3}");
    for (roughness, error) in [0.0625, 0.125].iter().zip(reads) {
        assert!(error < LOW_ROUGHNESS_SPOT_ERROR, "roughness {roughness}: mean error {error:.3}");
    }
    assert!(baked_width < SPOT_EDGE_WIDTH_RATIO * exact_width, "the baked edge is {baked_width:.3} degrees wide, the exact lobe's {exact_width:.3}");
}

/// `sh` at unit `n`, channel `channel`, unclamped (what the shading's clamp hides).
fn sh_value(sh: &GxEnvSh, n: [f32; 3], channel: usize) -> f32 {
    let basis = genex_render::ibl::sh9_basis(n);
    (0..9).map(|index| sh.coefficients[index][channel] * basis[index]).sum()
}

/// The least value of `sh` over a dense latitude-longitude grid and every channel.
fn sh_minimum(sh: &GxEnvSh) -> f32 {
    let mut least = f32::INFINITY;
    for row in 0..90 {
        for column in 0..180 {
            let n = equirect_direction((column as f32 + 0.5) / 180.0, (row as f32 + 0.5) / 90.0);
            for channel in 0..3 {
                least = least.min(sh_value(sh, n, channel));
            }
        }
    }
    least
}

/// How far under zero the SH may dip between the bake's sample directions, as a share of its
/// constant term.
const SH_RING_SLACK: f32 = 1e-3;

#[test]
#[ignore = "needs a WebGPU-core adapter; run with --ignored metal"]
fn metal_a_bright_source_left_in_the_map_never_rings_the_irradiance_negative() {
    // SI-05: a compact source kept in the map (`HdriSun::Off`) rang the SH9 negative on the far
    // side, where the shading's clamp then showed black. Deringing keeps the reconstruction
    // non-negative everywhere and leaves the constant term (the mean irradiance) alone.
    let Some(gpu) = gpu() else { return };
    let map = synthetic_map(1024, 512, small_spot(3.0, [2000.0, 1900.0, 1700.0]));
    let maps = baked(&gpu, &map, &hdri(0.0), 64);
    let sh = read_sh(&gpu, &maps);
    let least = sh_minimum(&sh);
    let constant = sh.coefficients[0][0] * 0.282_095;
    eprintln!("sun-only map: SH constant {constant:.4}, least value {least:.4} ({:.1}% of it)", 100.0 * least / constant);
    assert!(least >= -SH_RING_SLACK * constant, "the irradiance rings to {least} under a constant term of {constant}");
    let towards = sh_value(&sh, small_spot_centre(), 0);
    let away = sh_value(&sh, small_spot_centre().map(|c| -c), 0);
    assert!(towards > 4.0 * away.max(1e-6), "still lit from the source: {towards} towards, {away} away");

    // The bake's deringing is the CPU twin's on the projection it made (the radiance cube's 16 px
    // mip, read back and projected here).
    let radiance = maps.radiance_texture().expect("baked");
    let mip = radiance.mip_level_count() - 1 - genex_render::ibl::SH9_SOURCE_SIDE.trailing_zeros();
    let side = radiance.width() >> mip;
    assert_eq!(side, genex_render::ibl::SH9_SOURCE_SIDE);
    let mut projected = GxEnvSh::default();
    for face in 0..6 {
        let texels = read_layer(&gpu, radiance, mip, face, 4);
        for y in 0..side {
            for x in 0..side {
                let d = cube_direction(face, (x as f32 + 0.5) / side as f32, (y as f32 + 0.5) / side as f32);
                let weight = genex_render::ibl::texel_solid_angle(side, x, y) as f32;
                let at = ((y * side + x) * 4) as usize;
                let basis = genex_render::ibl::sh9_basis(d);
                for (index, coefficient) in projected.coefficients.iter_mut().enumerate() {
                    let lobe = genex_render::ibl::SH9_LOBE[genex_render::ibl::sh9_band(index)];
                    for channel in 0..3 {
                        coefficient[channel] += f16_value(texels[at + channel]) * weight * basis[index] * lobe;
                    }
                }
            }
        }
    }
    let twin = genex_render::ibl::sh9_dering(&projected);
    for (index, (got, want)) in sh.coefficients.iter().zip(twin.coefficients).enumerate() {
        for channel in 0..3 {
            let slack = 2e-3 * twin.coefficients[0][channel].abs();
            assert!((got[channel] - want[channel]).abs() <= slack, "coefficient {index} channel {channel}: GPU {} CPU twin {}", got[channel], want[channel]);
        }
    }
}

/// The SH9 constant term's luminance (the sky's mean irradiance).
fn sh_level(sh: &GxEnvSh) -> f32 {
    let c = sh.coefficients[0];
    0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}

/// How far the bound SH9's level may be from the sky's own at that frame while the sun sets
/// (SI-02): no ambient steps in a day-night game.
const SUN_SWEEP_LAG: f32 = 0.01;

/// The sun's direction `elevation` degrees up, towards +x.
fn sun_up(elevation: f32) -> [f32; 3] {
    let e = elevation.to_radians();
    [libm::cosf(e), libm::sinf(e), 0.0]
}

/// The bound SH9 of a sky baked whole for `sun_dir` from LUTs refreshed this frame (a settled
/// capture's): the sky's own ambient at that sun.
fn settled_sky_sh(gpu: &Gpu, (sky, maps): (&mut SkyState, &mut EnvironmentMaps), quality: &EnvironmentQuality, tick: u64, sun_dir: [f32; 3]) -> GxEnvSh {
    let Environment::Sky(params) = Environment::sky() else { unreachable!("the default sky") };
    let mut encoder = FrameEncoder::new(&gpu.device, &gpu.queue, "ibl settled sky frame");
    let sun = SkyFrame { sun_dir, sun_illuminance: [1.0; 3], camera_height_km: 0.002, frame_index: tick };
    sky.encode_luts(&gpu.device, &gpu.queue, encoder.encoder(), LutRefresh::new(&params, quality, sun).forced(true));
    let request = BakeRequest { environment: &Environment::sky(), quality, frame_index: tick, settle: true, sun_dir, sun_color: [1.0; 3] };
    maps.bake(&mut encoder, &request, Some(sky));
    encoder.submit();
    let _ = gpu.device.poll(wgpu::PollType::wait_indefinitely());
    read_sh(gpu, maps)
}

/// While the sun goes from `from` to `to` degrees by `per_tick` degrees a frame under `preset`'s
/// sky knobs: the largest relative distance of the bound SH9's level from the sky's own at that
/// frame ([`settled_sky_sh`]), where, and the largest frame-to-frame change.
fn sun_sweep(gpu: &Gpu, preset: QualityPreset, (from, to, per_tick): (f32, f32, f32)) -> (f32, f32, f32) {
    let mut quality = preset_quality(preset, DeviceClass::ALL[0]).environment;
    quality.ibl = true;
    quality.cube_size = 64;
    let new_sky = || {
        let (mut sky, mut maps) = (SkyState::new(), EnvironmentMaps::new(&gpu.device, &gpu.queue));
        sky.set_environment(&Environment::sky());
        maps.set_environment(&Environment::sky());
        (sky, maps)
    };
    let (mut sky, mut maps) = new_sky();
    let (mut settled_sky, mut settled_maps) = new_sky();
    assert_eq!(sky_frame(gpu, &mut sky, &mut maps, &quality, 0, sun_up(from)), BakeAction::Full);
    let mut previous = sh_level(&read_sh(gpu, &maps));
    let (mut worst, mut worst_at, mut worst_step) = (0.0_f32, from, 0.0_f32);
    let ticks = ((from - to) / per_tick).round() as u64;
    for tick in 1..=ticks {
        let elevation = from - per_tick * tick as f32;
        sky_frame(gpu, &mut sky, &mut maps, &quality, tick, sun_up(elevation));
        let level = sh_level(&read_sh(gpu, &maps));
        let own = sh_level(&settled_sky_sh(gpu, (&mut settled_sky, &mut settled_maps), &quality, tick, sun_up(elevation)));
        let lag = (level - own).abs() / own.max(1e-6);
        if lag > worst {
            (worst, worst_at) = (lag, elevation);
        }
        worst_step = worst_step.max((level - previous).abs() / previous.max(1e-6));
        previous = level;
    }
    (worst, worst_at, worst_step)
}

#[test]
#[ignore = "needs a WebGPU-core adapter; run with --ignored metal"]
fn metal_a_setting_sun_steps_the_sky_s_ambient_less_than_a_percent_a_frame() {
    // SI-02: the sky's SH9 changed only when a whole time-sliced rebake landed, after the sun had
    // turned past the preset's threshold (0.5 degrees on high, 1 on medium) plus the 13-step cycle,
    // so shadowed ground (lit by the sky alone) stepped in brightness at sunset. It is projected
    // from the sky-view LUT on every frame the LUT changes now, so the ambient is the sky's own at
    // every frame, within the LUT's cadence (every frame on high, every 4th on medium at a
    // 10-minute day's 0.01 degrees a frame).
    let Some(gpu) = gpu() else { return };
    let mut failures = Vec::new();
    for (preset, sweep) in [(QualityPreset::High, (12.0, 0.0, 0.05)), (QualityPreset::Medium, (8.0, 2.0, 0.01))] {
        let (worst, at, step) = sun_sweep(&gpu, preset, sweep);
        eprintln!(
            "{preset:?}: sun {}..{} deg at {} deg a frame: the ambient is at most {:.3}% from the sky's own (at {at:.2} deg); largest frame-to-frame change {:.3}%",
            sweep.0,
            sweep.1,
            sweep.2,
            100.0 * worst,
            100.0 * step
        );
        if worst >= SUN_SWEEP_LAG {
            failures.push(format!("{preset:?}: {:.2}% at {at:.2} degrees", 100.0 * worst));
        }
    }
    assert!(failures.is_empty(), "the ambient steps: {failures:?}");
}

/// The bound specular cube's mean radiance over mip `mip` of every face.
fn cube_mean(gpu: &Gpu, maps: &EnvironmentMaps, mip: u32) -> [f32; 3] {
    let specular = maps.specular_texture().expect("baked");
    let mut sum = [0.0_f64; 3];
    let mut count = 0.0_f64;
    for face in 0..6 {
        for texel in read_layer(gpu, specular, mip, face, 4).chunks(4) {
            for c in 0..3 {
                sum[c] += f64::from(f16_value(texel[c]));
            }
            count += 1.0;
        }
    }
    sum.map(|value| (value / count) as f32)
}

/// The most a continuous rebake's cube may change from one frame to the next while the sun sets
/// 0.05 degrees a frame (a 6-minute day): SI-15's sun-sweep row.
const CONTINUOUS_CUBE_STEP: f32 = 0.01;

#[test]
#[ignore = "needs a WebGPU-core adapter; run with --ignored metal"]
fn metal_a_setting_sun_moves_the_sky_cube_a_little_every_frame_on_high() {
    // Renderer pass 2 A.3, SI-02 step 2 with SI-15's sun-sweep row: the time-sliced rebake (every
    // phone, `low` and `medium`) leaves the bound cube unchanged until the sun has turned past the
    // threshold and the 13-step cycle lands, then steps by all of it; desktop `high` and `ultra`
    // rebake the cube whole on every frame the sun turned, at the continuous sample count, so a
    // glossy surface's sky reflection follows a setting sun without steps.
    let Some(gpu) = gpu() else { return };
    let mut steps = Vec::new();
    for continuous in [false, true] {
        let mut quality = preset_quality(QualityPreset::High, DeviceClass::ALL[0]).environment;
        quality.ibl = true;
        quality.cube_size = 64;
        quality.continuous_sky = continuous;
        let mut maps = EnvironmentMaps::new(&gpu.device, &gpu.queue);
        let mut sky = SkyState::new();
        sky.set_environment(&Environment::sky());
        maps.set_environment(&Environment::sky());
        assert_eq!(sky_frame(&gpu, &mut sky, &mut maps, &quality, 0, sun_up(12.0)), BakeAction::Full);
        let mut previous = cube_mean(&gpu, &maps, 0);
        let mut worst = 0.0_f32;
        for tick in 1..=120u64 {
            let action = sky_frame(&gpu, &mut sky, &mut maps, &quality, tick, sun_up(12.0 - 0.05 * tick as f32));
            if continuous {
                assert_eq!(action, BakeAction::Full, "tick {tick}: the sun turned, the cube follows whole");
                let work = maps.last_work();
                assert_eq!(work.prefilter_samples, CONTINUOUS_PREFILTER_SAMPLES.min(genex_render::ibl::prefilter_samples(64)));
                assert!(work.texel_samples <= continuous_bake_work(64, SourceKind::Sky) + genex_render::ibl::sky_sh_work(), "tick {tick}: {work:?}");
            }
            let mean = cube_mean(&gpu, &maps, 0);
            let step = (0..3).map(|c| (mean[c] - previous[c]).abs() / previous[c].max(1e-6)).fold(0.0_f32, f32::max);
            worst = worst.max(step);
            previous = mean;
        }
        eprintln!("continuous {continuous}: the cube's mean changes at most {:.3}% a frame", 100.0 * worst);
        steps.push(worst);
    }
    let [sliced, continuous] = [steps[0], steps[1]];
    assert!(continuous <= CONTINUOUS_CUBE_STEP, "a continuous rebake steps {:.3}% a frame", 100.0 * continuous);
    assert!(continuous * 3.0 <= sliced, "the time-sliced cycle steps more ({:.3}%) than the continuous rebake ({:.3}%)", 100.0 * sliced, 100.0 * continuous);
}

#[test]
#[ignore = "needs a WebGPU-core adapter; run with --ignored metal"]
fn metal_a_continuous_rebake_fits_a_share_of_the_frame() {
    // SI-02 step 2's cost: a whole rebake at the continuous sample count, timed on the GPU, on
    // every frame of a turning map (the sky's own costs the same passes from its LUT).
    let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
    let gpu = match Gpu::headless_with(wgpu::Features::TIMESTAMP_QUERY) {
        Ok(gpu) => gpu,
        Err(error) => {
            assert!(!require, "GENEX_REQUIRE_METAL=1 and no adapter with timestamps: {error}");
            eprintln!("skipped: no adapter with timestamp queries ({error})");
            return;
        }
    };
    let map = synthetic_map(1024, 512, smooth);
    let mut fields = vec![format!("\"row\":\"ibl-continuous-rebake\",\"adapter\":\"{}\"", gpu.receipt().adapter)];
    let mut failures = Vec::new();
    for side in [128_u32, 256] {
        let mut quality = ibl_quality(side);
        quality.continuous_sky = true;
        let mut maps = baked(&gpu, &map, &hdri(0.0), side);
        let mut timer = BakeTimer::new(&gpu, 20);
        for run in 0..22u64 {
            let environment = hdri(run as f32);
            let bake = BakeRequest { environment: &environment, quality: &quality, frame_index: run + 1, settle: false, sun_dir: [0.0, 1.0, 0.0], sun_color: [1.0; 3] };
            if run < 2 {
                frame(&gpu, &mut maps, &environment, &quality, run + 1, false, [0.0, 1.0, 0.0]);
                continue;
            }
            timer.frame(&gpu, &mut maps, &bake);
            assert_eq!(maps.last_work().action, BakeAction::Full, "run {run}: whole");
        }
        let mut times = timer.read(&gpu);
        times.sort_by(f64::total_cmp);
        let p50 = times[times.len() / 2];
        fields.push(format!("\"cube{side}\":{{\"p50Ms\":{p50:.4},\"maxMs\":{:.4}}}", times[times.len() - 1]));
        if p50 > CONTINUOUS_BAKE_MS {
            failures.push(format!("cube {side}: {p50:.3} ms"));
        }
    }
    let row = format!("{{{}}}", fields.join(","));
    println!("{row}");
    if let Ok(path) = std::env::var("GENEX_PERF_OUT") {
        std::fs::write(path, format!("{row}\n")).expect("perf row");
    }
    assert!(failures.is_empty(), "a continuous rebake over {CONTINUOUS_BAKE_MS} ms: {failures:?}");
}

/// Every specular mip's faces of the bound bake.
fn specular_bytes(gpu: &Gpu, maps: &EnvironmentMaps) -> Vec<u16> {
    let specular = maps.specular_texture().expect("baked");
    (0..SPECULAR_MIPS).flat_map(|mip| (0..6).map(move |face| (mip, face))).flat_map(|(mip, face)| read_layer(gpu, specular, mip, face, 4)).collect()
}

#[test]
#[ignore = "needs a WebGPU-core adapter; run with --ignored metal"]
fn metal_a_resting_environment_refreshes_a_continuous_bake_at_the_full_count() {
    // SI-02 step 2: a continuous rebake prefilters at CONTINUOUS_PREFILTER_SAMPLES; once nothing
    // changes, a time-sliced refresh at the full count binds what a cold bake (a settled capture)
    // binds, byte for byte.
    let Some(gpu) = gpu() else { return };
    let side = 256;
    let mut quality = ibl_quality(side);
    quality.continuous_sky = true;
    let map = synthetic_map(256, 128, smooth);
    let mut maps = baked(&gpu, &map, &hdri(0.0), side);
    for (frame_index, degrees) in [(1, 1.0), (2, 2.0)] {
        assert_eq!(frame(&gpu, &mut maps, &hdri(degrees), &quality, frame_index, false, [0.0, 1.0, 0.0]), BakeAction::Full, "turned: whole");
        assert_eq!(maps.last_work().prefilter_samples, CONTINUOUS_PREFILTER_SAMPLES);
    }
    let cold = baked(&gpu, &map, &hdri(2.0), side);
    let reference = specular_bytes(&gpu, &cold);
    assert_ne!(specular_bytes(&gpu, &maps), reference, "the continuous bake is the coarse one");
    for frame_index in 3..3 + u64::from(SLICE_STEPS) {
        let action = frame(&gpu, &mut maps, &hdri(2.0), &quality, frame_index, false, [0.0, 1.0, 0.0]);
        assert!(matches!(action, BakeAction::Slice(_)), "frame {frame_index}: {action:?}");
    }
    assert_eq!(specular_bytes(&gpu, &maps), reference, "the resting refresh binds the cold bake");
    assert_eq!(frame(&gpu, &mut maps, &hdri(2.0), &quality, 40, false, [0.0, 1.0, 0.0]), BakeAction::Idle);
}

/// A continuous rebake's GPU time at most, ms: a time-sliced step's share of a 60 fps frame
/// (`SLICE_SHARE`), since it replaces the slices on the qualities that run it.
const CONTINUOUS_BAKE_MS: f64 = SLICE_SHARE * FRAME_INTERVAL_MS;

/// Run compute entry `entry` of `source` (pipeline constants `constants`) one workgroup per row
/// over `rows` (`stride` vec4s each, at binding `rows_binding`), with `bindings` of group 0
/// besides: the rows as the probe left them.
fn run_probe(gpu: &Gpu, (source, entry, constants): (&str, &str, &[(&str, f64)]), rows_binding: u32, bindings: &[(u32, wgpu::BindingResource<'_>)], (rows, stride): (&[[f32; 4]], usize)) -> Vec<[f32; 4]> {
    use wgpu::util::DeviceExt;
    let device = &gpu.device;
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("ibl probe"), source: wgpu::ShaderSource::Wgsl(source.into()) });
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("ibl probe"),
        layout: None,
        module: &module,
        entry_point: Some(entry),
        compilation_options: wgpu::PipelineCompilationOptions { constants, ..Default::default() },
        cache: None,
    });
    let storage = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("ibl probe rows"),
        contents: bytemuck::cast_slice(rows),
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
    });
    let mut entries: Vec<wgpu::BindGroupEntry<'_>> = bindings.iter().map(|(binding, resource)| wgpu::BindGroupEntry { binding: *binding, resource: resource.clone() }).collect();
    entries.push(wgpu::BindGroupEntry { binding: rows_binding, resource: storage.as_entire_binding() });
    let group = device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("ibl probe"), layout: &pipeline.get_bind_group_layout(0), entries: &entries });
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("ibl probe") });
    {
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("ibl probe"), timestamp_writes: None });
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups((rows.len() / stride) as u32, 1, 1);
    }
    gpu.queue.submit([encoder.finish()]);
    let bytes = read_buffer(gpu, &storage, (rows.len() * 16) as u64);
    bytemuck::cast_slice::<u8, [f32; 4]>(&bytes).to_vec()
}

/// The forward shader with the AO term read from the probe row (`probe_ao`) and two probes:
/// `cs_environment` (the environment's light on a surface, rows: normal, view, albedo and
/// metallic with roughness in w, the AO texel) and `cs_direct` (the direct light a surface
/// reflects, integrated over every light direction of its hemisphere; rows: normal, view,
/// albedo and metallic with roughness in w, out).
fn shading_probe_source() -> String {
    let base = genex_render::shaders::FORWARD;
    let patched = base.replacen("fn gx_ambient_occlusion(world_pos: vec3<f32>) -> vec4<f32> {", "fn gx_ambient_occlusion_unprobed(world_pos: vec3<f32>) -> vec4<f32> {", 1);
    assert_ne!(patched, base, "forward_effects.wgsl no longer answers the AO term here: the probe stands in for it");
    // Renderer pass 2 A.3 and A.4: a compute probe has no light bins, so the reflection is the
    // sky's layer of the probe array and the diffuse light the sky's SH9 (the forward pass walks
    // the probes and irradiance volumes binned at the pixel).
    let walk = "fn gx_env_light(world_pos: vec3<f32>, dir: vec3<f32>, lod: f32, n: vec3<f32>) -> GxEnvLight {";
    let patched = patched.replacen(walk, "fn gx_env_light_binned(world_pos: vec3<f32>, dir: vec3<f32>, lod: f32, n: vec3<f32>) -> GxEnvLight {", 1);
    format!(
        "{patched}\n{}",
        r"
@group(0) @binding(20) var<storage, read_write> probe_rows: array<vec4<f32>>;
var<private> probe_ao: vec4<f32>;

fn gx_env_light(world_pos: vec3<f32>, dir: vec3<f32>, lod: f32, n: vec3<f32>) -> GxEnvLight {
    return GxEnvLight(gx_env_sky(dir, lod), gx_env_irradiance(n));
}

fn gx_ambient_occlusion(world_pos: vec3<f32>) -> vec4<f32> {
    return probe_ao;
}

fn probe_surface(at: u32) -> Surface {
    let n = normalize(probe_rows[at].xyz);
    let material = probe_rows[at + 2u];
    return Surface(vec3<f32>(0.0), n, n, normalize(probe_rows[at + 1u].xyz), material.rgb, 1.0, material.w, probe_rows[at + 1u].w);
}

@compute @workgroup_size(1)
fn cs_environment(@builtin(workgroup_id) id: vec3<u32>) {
    let at = id.x * 4u;
    probe_ao = probe_rows[at + 3u];
    probe_rows[at + 3u] = vec4<f32>(gx_environment_light(probe_surface(at)), 1.0);
}

const PROBE_THETA_STEPS: u32 = 512u;
const PROBE_PHI_STEPS: u32 = 256u;

@compute @workgroup_size(1)
fn cs_direct(@builtin(workgroup_id) id: vec3<u32>) {
    let at = id.x * 4u;
    // The LUT and sampler are bound whether or not the shading reads them.
    _ = textureSampleLevel(brdf_lut, env_sampler, vec2<f32>(0.5), 0.0);
    let s = probe_surface(at);
    var up = vec3<f32>(1.0, 0.0, 0.0);
    if abs(s.n.z) < 0.999 {
        up = vec3<f32>(0.0, 0.0, 1.0);
    }
    let tangent = normalize(cross(up, s.n));
    let bitangent = cross(s.n, tangent);
    let d_theta = 0.5 * PI / f32(PROBE_THETA_STEPS);
    let d_phi = 2.0 * PI / f32(PROBE_PHI_STEPS);
    var total = vec3<f32>(0.0);
    for (var i = 0u; i < PROBE_THETA_STEPS; i++) {
        let theta = (f32(i) + 0.5) * d_theta;
        for (var j = 0u; j < PROBE_PHI_STEPS; j++) {
            let phi = (f32(j) + 0.5) * d_phi;
            let l = (tangent * cos(phi) + bitangent * sin(phi)) * sin(theta) + s.n * cos(theta);
            total += shade(s.n, s.v, l, vec3<f32>(1.0), s.albedo, s.metallic, s.roughness) * sin(theta) * d_theta * d_phi;
        }
    }
    probe_rows[at + 3u] = vec4<f32>(total, 1.0);
}
"
    )
}

/// The probe rows of a surface facing `n`, seen from `v`, of `albedo`, `metallic` and
/// `roughness`, with the AO texel `ao` (bent normal xyz, visibility w).
fn probe_row(n: [f32; 3], v: [f32; 3], (albedo, metallic, roughness): ([f32; 3], f32, f32), ao: [f32; 4]) -> [[f32; 4]; 4] {
    [[n[0], n[1], n[2], 0.0], [v[0], v[1], v[2], roughness], [albedo[0], albedo[1], albedo[2], metallic], ao]
}

/// A black cube (no specular light) and a linear clamped sampler, the probes' environment.
fn black_cube_and_sampler(gpu: &Gpu) -> (wgpu::TextureView, wgpu::Sampler) {
    let texture = gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("probe black cube"),
        size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 6 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba16Float,
        usage: wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    });
    // The forward text binds the probe cube array at 11 (renderer pass 2 A.3): one black cube.
    let view = texture.create_view(&wgpu::TextureViewDescriptor { dimension: Some(wgpu::TextureViewDimension::CubeArray), array_layer_count: Some(6), ..Default::default() });
    let sampler = gpu.device.create_sampler(&wgpu::SamplerDescriptor {
        mag_filter: wgpu::FilterMode::Linear,
        min_filter: wgpu::FilterMode::Linear,
        mipmap_filter: wgpu::MipmapFilterMode::Linear,
        ..Default::default()
    });
    (view, sampler)
}

/// The HDR scene's pipeline constant the probes compile with.
const HDR_SCENE: &[(&str, f64)] = &[("GX_SCENE_HDR", 1.0)];

#[test]
#[ignore = "needs a WebGPU-core adapter; run with --ignored metal"]
fn metal_the_diffuse_environment_light_follows_the_bent_normal_where_ao_trusts_it() {
    // SI-06: the diffuse irradiance was looked up along the shading normal although GTAO's bent
    // normal says where the open sky is: a wall at the foot of an overhang took its light straight
    // through the overhang. A sky bright overhead, a wall facing +x whose bent normal leans up.
    let Some(gpu) = gpu() else { return };
    let mut sh = GxEnvSh::default();
    sh.coefficients[0] = [1.0, 1.1, 1.3, 0.0];
    sh.coefficients[1] = [0.8, 0.9, 1.1, 0.0];
    let sh_buffer = {
        use wgpu::util::DeviceExt;
        gpu.device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("probe sh"), contents: bytemuck::bytes_of(&sh), usage: wgpu::BufferUsages::UNIFORM })
    };
    let lut_maps = baked(&gpu, &synthetic_map(64, 32, smooth), &hdri(0.0), 64);
    let lut = lut_maps.brdf_lut_texture().expect("written").create_view(&wgpu::TextureViewDescriptor::default());
    let (cube, sampler) = black_cube_and_sampler(&gpu);
    let n = [1.0, 0.0, 0.0];
    let bent = unit([1.0, 1.0, 0.0]);
    let material = ([0.8, 0.8, 0.8], 0.0, 1.0);
    let cases: [(f32, [f32; 4]); 4] = [
        (0.0, [0.0, 0.0, 0.0, 0.5]),
        (1.0, [bent[0], bent[1], bent[2], 0.5]),
        (smoothstep(0.0, 0.15, 0.05), [bent[0], bent[1], bent[2], 0.95]),
        (0.0, [bent[0], bent[1], bent[2], 1.0]),
    ];
    let rows: Vec<[f32; 4]> = cases.iter().flat_map(|(_, ao)| probe_row(n, n, material, *ao)).collect();
    let source = shading_probe_source();
    let out = run_probe(
        &gpu,
        (&source, "cs_environment", HDR_SCENE),
        20,
        &[
            (11, wgpu::BindingResource::TextureView(&cube)),
            (12, sh_buffer.as_entire_binding()),
            (13, wgpu::BindingResource::TextureView(&lut)),
            (14, wgpu::BindingResource::Sampler(&sampler)),
        ],
        (&rows, 4),
    );
    let light: Vec<[f32; 4]> = out.chunks(4).map(|row| row[3]).collect();
    for (index, (trusted, ao)) in cases.iter().enumerate() {
        // The same visibility without a bent normal: only the lookup direction differs.
        let reference_rows: Vec<[f32; 4]> = probe_row(n, n, material, [0.0, 0.0, 0.0, ao[3]]).to_vec();
        let reference = run_probe(
            &gpu,
            (&source, "cs_environment", HDR_SCENE),
            20,
            &[
                (11, wgpu::BindingResource::TextureView(&cube)),
                (12, sh_buffer.as_entire_binding()),
                (13, wgpu::BindingResource::TextureView(&lut)),
                (14, wgpu::BindingResource::Sampler(&sampler)),
            ],
            (&reference_rows, 4),
        )[3];
        let along = {
            let mixed = [0, 1, 2].map(|k| n[k] * (1.0 - trusted) + ao[k] * trusted);
            if *trusted > 0.0 { unit(mixed) } else { n }
        };
        let want = sh9_eval(&sh, along);
        let base = sh9_eval(&sh, n);
        for channel in 0..3 {
            let ratio = light[index][channel] / reference[channel];
            let expected = want[channel] / base[channel];
            eprintln!("case {index} channel {channel}: light {} vs no bent normal {} (ratio {ratio:.4}, expected {expected:.4})", light[index][channel], reference[channel]);
            assert!((ratio - expected).abs() <= 2e-3 * expected, "case {index} channel {channel}: ratio {ratio} expected {expected}");
        }
    }
}

/// `smoothstep` as WGSL defines it.
fn smoothstep(edge0: f32, edge1: f32, x: f32) -> f32 {
    let t = ((x - edge0) / (edge1 - edge0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// How far a white metal's direct light, integrated over its hemisphere, may be from 1 (the
/// white furnace of direct light: multiple-scattering energy compensation, SI-07).
const DIRECT_FURNACE_TOLERANCE: f32 = 0.03;

#[test]
#[ignore = "needs a WebGPU-core adapter; run with --ignored metal"]
fn metal_a_white_rough_metal_reflects_all_of_a_furnace_of_direct_lights() {
    // SI-07, S8, LG-03: direct specular had no multiple-scattering compensation, while the
    // environment's split sum does, so a rough metal lost up to a third of the sun's light and
    // looked darker under the sun than under the sky. A white metal lit from every direction of
    // its hemisphere by unit lights (shade() integrated over them) reflects 1 at every roughness
    // and view, as the environment's furnace does, and its sunlit brightness rises by
    // 1 + f0 (1 / E - 1).
    let Some(gpu) = gpu() else { return };
    let lut_maps = baked(&gpu, &synthetic_map(64, 32, smooth), &hdri(0.0), 64);
    let lut = lut_maps.brdf_lut_texture().expect("written").create_view(&wgpu::TextureViewDescriptor::default());
    let (_, sampler) = black_cube_and_sampler(&gpu);
    let n = [0.0, 0.0, 1.0];
    let cases: Vec<(f32, f32)> = [0.3_f32, 0.6, 1.0].iter().flat_map(|r| [1.0_f32, 0.6, 0.3].map(move |n_dot_v| (*r, n_dot_v))).collect();
    let rows: Vec<[f32; 4]> = cases
        .iter()
        .flat_map(|(roughness, n_dot_v)| {
            let v = [(1.0 - n_dot_v * n_dot_v).max(0.0).sqrt(), 0.0, *n_dot_v];
            probe_row(n, v, ([1.0; 3], 1.0, *roughness), [0.0; 4])
        })
        .collect();
    let source = shading_probe_source();
    let out = run_probe(
        &gpu,
        (&source, "cs_direct", HDR_SCENE),
        20,
        &[(13, wgpu::BindingResource::TextureView(&lut)), (14, wgpu::BindingResource::Sampler(&sampler))],
        (&rows, 4),
    );
    let mut failures = Vec::new();
    for ((roughness, n_dot_v), row) in cases.iter().zip(out.chunks(4)) {
        let reflected = row[3][1];
        let [scale, bias] = brdf_lut_reference(f64::from(*n_dot_v), f64::from(*roughness), BRDF_LUT_SAMPLES);
        eprintln!("roughness {roughness} N.V {n_dot_v}: a white metal reflects {reflected:.4} of a furnace of direct lights (single scatter E {:.4})", scale + bias);
        if (reflected - 1.0).abs() > DIRECT_FURNACE_TOLERANCE {
            failures.push(format!("roughness {roughness} N.V {n_dot_v}: {reflected:.4}"));
        }
    }
    assert!(failures.is_empty(), "a white metal under direct light: {failures:?}");
}

/// The sky's SH9 refresh (SI-02: the LUT into its 16 px source faces, then the projection and its
/// deringing) may take this much GPU time a frame (p95): half the sky's 0.3 ms at high, whose LUTs
/// take the other half (`tests/sky.rs`'s cost row: the sky view's p95 about 0.035 ms).
const SKY_SH_REFRESH_BUDGET_MS: f64 = 0.15;

#[test]
#[ignore = "needs a WebGPU-core adapter; run with --ignored metal"]
fn metal_the_sky_s_sh9_refresh_costs_a_small_share_of_the_sky_s_budget() {
    // SI-02 cost row: on a frame whose sky-view LUT changed (a moving sun) and no rebake step is
    // due, the bake's only work is the SH9 refresh, one timestamped pass; frames submitted back to
    // back.
    let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
    let gpu = match Gpu::headless_with(wgpu::Features::TIMESTAMP_QUERY) {
        Ok(gpu) => gpu,
        Err(error) => {
            assert!(!require, "GENEX_REQUIRE_METAL=1 and no adapter with timestamps: {error}");
            eprintln!("skipped: no adapter with timestamp queries ({error})");
            return;
        }
    };
    let mut quality = preset_quality(QualityPreset::High, DeviceClass::ALL[0]).environment;
    quality.ibl = true;
    quality.cube_size = 256;
    // No rebake while the sun moves a little: only the refresh is due.
    quality.sun_rebake_tenths = 1800;
    // Renderer pass 2 A.3 (SI-02 step 2): high rebakes continuously, which includes the SH9 each
    // frame; this row times the SH9-only refresh the time-sliced qualities run.
    quality.continuous_sky = false;
    let Environment::Sky(params) = Environment::sky() else { unreachable!("the default sky") };
    let (mut sky, mut maps) = (SkyState::new(), EnvironmentMaps::new(&gpu.device, &gpu.queue));
    sky.set_environment(&Environment::sky());
    maps.set_environment(&Environment::sky());
    assert_eq!(sky_frame(&gpu, &mut sky, &mut maps, &quality, 0, sun_up(20.0)), BakeAction::Full);
    // The best p95 of three runs, as the bloom and AO cost rows take theirs: the refresh is one
    // workgroup, so an idle GPU's clock state moves a run (G0 perf-platform: 0.2333 and 0.2340 ms
    // in two of four runs, under 0.15 in the others).
    let p95s: Vec<f64> = (0..SH_REFRESH_RUNS).map(|run| sh_refresh_p95(&gpu, &mut sky, &mut maps, &quality, &params, run)).collect();
    let best = p95s.iter().copied().fold(f64::INFINITY, f64::min);
    eprintln!("sky SH9 refresh at high: p95 per run {p95s:?} ms, best {best:.4} ms");
    assert!(best <= SKY_SH_REFRESH_BUDGET_MS, "the sky's SH9 refresh p95 is {best:.4} ms at best of {SH_REFRESH_RUNS} runs");
}

/// Runs of the SH9 refresh's cost row (it keeps the best p95).
const SH_REFRESH_RUNS: u32 = 3;

/// One run of the SH9 refresh's cost row (`run` moves the sun on from the last run's): its p95, ms.
fn sh_refresh_p95(gpu: &Gpu, sky: &mut SkyState, maps: &mut EnvironmentMaps, quality: &EnvironmentQuality, params: &SkyParams, run: u32) -> f64 {
    const FRAMES: u32 = 64;
    let queries = gpu.device.create_query_set(&wgpu::QuerySetDescriptor { label: Some("sky sh timing"), ty: wgpu::QueryType::Timestamp, count: 2 * FRAMES });
    let mut refreshed = 0;
    for frame in 0..FRAMES {
        let tick = 1 + u64::from(run * FRAMES + frame);
        let sun_dir = sun_up(20.0 - 0.01 * tick as f32);
        let mut encoder = FrameEncoder::new(&gpu.device, &gpu.queue, "sky sh timed frame");
        let sun = SkyFrame { sun_dir, sun_illuminance: [1.0; 3], camera_height_km: 0.002, frame_index: tick };
        sky.encode_luts(&gpu.device, &gpu.queue, encoder.encoder(), LutRefresh::new(params, quality, sun));
        let writes = wgpu::ComputePassTimestampWrites { query_set: &queries, beginning_of_pass_write_index: Some(2 * frame), end_of_pass_write_index: Some(2 * frame + 1) };
        let request = BakeRequest { environment: &Environment::sky(), quality, frame_index: tick, settle: false, sun_dir, sun_color: [1.0; 3] };
        let passes = maps.bake_timed(&mut encoder, &request, Some(&*sky), Some(writes));
        assert_eq!((maps.last_work().action, passes.compute), (BakeAction::Idle, 1), "frame {frame}: the refresh alone, one pass");
        refreshed += u32::from(maps.last_work().texel_samples > 0);
        encoder.submit();
    }
    assert_eq!(refreshed, FRAMES, "every frame's LUT changed and refreshed the SH9 alone");
    let bytes = u64::from(2 * FRAMES) * 8;
    let resolve = gpu.device.create_buffer(&wgpu::BufferDescriptor { label: Some("sky sh timing"), size: bytes, usage: wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC, mapped_at_creation: false });
    let read = gpu.device.create_buffer(&wgpu::BufferDescriptor { label: Some("sky sh timing read"), size: bytes, usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
    let _ = gpu.device.poll(wgpu::PollType::wait_indefinitely());
    let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("sky sh timing resolve") });
    encoder.resolve_query_set(&queries, 0..2 * FRAMES, &resolve, 0);
    encoder.copy_buffer_to_buffer(&resolve, 0, &read, 0, bytes);
    gpu.queue.submit([encoder.finish()]);
    read.slice(..).map_async(wgpu::MapMode::Read, |result| result.expect("mapped"));
    let _ = gpu.device.poll(wgpu::PollType::wait_indefinitely());
    let stamps: Vec<u64> = read.slice(..).get_mapped_range().expect("mapped range").as_chunks::<8>().0.iter().map(|b| u64::from_le_bytes(*b)).collect();
    let period = f64::from(gpu.queue.get_timestamp_period());
    let mut ms: Vec<f64> = stamps.as_chunks::<2>().0.iter().map(|[begin, end]| end.saturating_sub(*begin) as f64 * period / 1e6).collect();
    ms.sort_by(f64::total_cmp);
    let p = |q: f64| ms[((ms.len() - 1) as f64 * q).round() as usize];
    eprintln!("sky SH9 refresh at high, run {run}: p50 {:.4} ms, p95 {:.4} ms, max {:.4} ms over {FRAMES} frames", p(0.5), p(0.95), ms[ms.len() - 1]);
    p(0.95)
}
