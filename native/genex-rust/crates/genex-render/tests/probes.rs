//! Reflection probes (renderer pass 2 A.3, `genex_render::probes`). CPU rows hold the presets,
//! the binning and the forward shader with probes to WebGPU core's limits; real-GPU rows
//! (`#[ignore]`d, every name contains `metal`) hold a capture's filter, its publish and the sky's
//! layer to their CPU expectations, standing in for the renderer's face draws with cleared faces:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked --test probes -- --ignored metal

use genex_render::Gpu;
use genex_render::device_class::{DeviceClass, FormFactor, PerformanceTier};
use genex_render::graph::FrameEncoder;
use genex_render::hdri::HdriImage;
use genex_render::ibl::{BakeAction, BakeRequest, EnvironmentMaps, SPECULAR_MIPS, equirect_direction};
use genex_render::lights::{Lighting, binned_frame};
use genex_render::presets::preset_quality;
use genex_render::probes::{CAPTURE_STEPS, CaptureStep, ProbePrep, ReflectionProbe};
use genex_render::scene::CameraDesc;
use genex_render::settings::{Environment, EnvironmentQuality, HdriEnvironment, HdriSun, Quality, QualityPreset};
use naga::valid::{Capabilities, ModuleInfo, ValidationFlags, Validator};

// --- CPU rows ---

#[test]
fn the_presets_give_probes_their_counts_and_sides() {
    let class = |form, tier| DeviceClass::ALL.into_iter().find(|class| class.form == form && class.tier == tier).expect("class");
    let desktop = class(FormFactor::Desktop, PerformanceTier::Ultra);
    let counts: Vec<u8> = QualityPreset::ALL.into_iter().map(|preset| preset_quality(preset, desktop).environment.reflection_probes).collect();
    assert_eq!(counts, [4, 8, 16, 16], "low, medium, high, ultra on a desktop");
    assert_eq!(preset_quality(QualityPreset::Ultra, desktop).environment.probe_side_max, genex_render::presets::PROBE_SIDE_MAX_PX);
    for (tier, most) in [(PerformanceTier::Low, 2), (PerformanceTier::Mid, 4), (PerformanceTier::High, 8)] {
        let phone = preset_quality(QualityPreset::Ultra, class(FormFactor::Mobile, tier));
        assert_eq!(phone.environment.reflection_probes, most, "mobile-{tier:?}");
        assert_eq!(phone.environment.probe_side_max, genex_render::presets::MOBILE_PROBE_SIDE_MAX_PX);
    }
    assert_eq!(Quality::off().environment.reflection_probes, 0, "the off quality shades none");
    // The probe cube follows the sky's side, capped (ultra's 512 px HDRI cube: 256 px probes).
    let ultra = preset_quality(QualityPreset::Ultra, desktop).environment;
    assert_eq!((genex_render::probes::probe_side(512, &ultra), genex_render::probes::probe_side(128, &ultra)), (256, 128));
}

#[test]
fn the_lights_bin_their_probes_after_the_lights() {
    let camera = CameraDesc::look_at([0.0, 1.6, 0.0], [0.0, 1.6, 10.0]);
    let mut lighting = Lighting::default();
    let without = binned_frame(&lighting, &preset_quality(QualityPreset::High, DeviceClass::ALL[0]).lights, &camera, (640, 360));
    lighting.reflection_probes =
        vec![ReflectionProbe::new([-6.0, 0.0, 7.8], [6.0, 3.6, 15.8]), ReflectionProbe::new([f32::NAN, 0.0, 0.0], [1.0; 3]), ReflectionProbe::new([-2.0, 0.0, 1.0], [2.0, 3.0, 4.0])];
    let quality = preset_quality(QualityPreset::High, DeviceClass::ALL[0]).lights;
    let with = binned_frame(&lighting, &quality, &camera, (640, 360));
    assert_eq!(with.reflection_probes.len(), 2, "the probe that is not a number is dropped");
    assert_eq!(with.bins.probes, [1, 0], "nearest first: the small box at z 1..4, then the room");
    assert_eq!(with.bins.params.ranges[2] - with.bins.params.ranges[1], 2, "two probes after the lights and decals");
    assert_eq!((with.lights, with.ext), (without.lights, without.ext), "the light tables are the same");
    assert_eq!(without.bins.params.ranges[2], without.bins.params.ranges[0], "no probe: nothing past the lights");
}

#[test]
fn the_budget_registers_the_probes_the_renderer_holds() {
    use genex_render::budget::{BudgetInput, BudgetKind, BudgetLedger, REFLECTION_PROBES_LABEL, ledger};
    use genex_render::settings::SceneFormat;
    let quality = preset_quality(QualityPreset::High, DeviceClass::ALL[0]);
    let input = BudgetInput::new((1920, 1080), 1.0, SceneFormat::Rgba16Float, false);
    let bytes = |input: &BudgetInput| ledger(&quality, input).entries().iter().filter(|entry| entry.label == REFLECTION_PROBES_LABEL).map(|entry| (entry.kind, entry.bytes)).collect::<Vec<_>>();
    assert!(bytes(&input).is_empty(), "no probe held: no entry");
    let held_bytes = genex_render::probes::probe_bytes(256, 16);
    let mut held = BudgetLedger::new();
    held.register(BudgetKind::Ibl, REFLECTION_PROBES_LABEL, held_bytes);
    assert_eq!(bytes(&input.with_buffers(&held)), [(BudgetKind::Ibl, held_bytes)], "the renderer's held probes reach the ledger");
    assert!(held_bytes > 17 * genex_render::probes::cube_bytes(256), "16 probe cubes and the sky's layer: {held_bytes}");
}

fn parse(name: &str, source: &str) -> naga::Module {
    naga::front::wgsl::parse_str(source).unwrap_or_else(|error| panic!("{name}: {}", error.emit_to_string(source)))
}

/// WebGPU core's shader capabilities as naga names them: cube arrays are core (compatibility mode
/// lacks them; the renderer targets core), as `extension.rs`'s `CORE_CAPABILITIES` holds.
const WEBGPU_CORE: Capabilities = Capabilities::CUBE_ARRAY_TEXTURES;

fn validated(name: &str, module: &naga::Module) -> ModuleInfo {
    Validator::new(ValidationFlags::all(), WEBGPU_CORE).validate(module).unwrap_or_else(|error| panic!("{name} needs more than WebGPU core: {error:?}"))
}

/// The forward shader: its environment bindings hold the reflection probes (shaders/forward_env.wgsl).
fn forward_with_probes() -> String {
    genex_render::shaders::FORWARD.to_owned()
}

/// Storage buffers and sampled textures the fragment entry `entry` reads.
fn fragment_counts(module: &naga::Module, info: &ModuleInfo, entry: &str) -> (u32, u32) {
    let index = module.entry_points.iter().position(|point| point.name == entry).expect("entry point");
    let used = |handle: naga::Handle<naga::GlobalVariable>| !info.get_entry_point(index)[handle].is_empty();
    let mut counts = (0, 0);
    for (_, global) in module.global_variables.iter().filter(|(handle, global)| global.binding.is_some() && used(*handle)) {
        if matches!(global.space, naga::AddressSpace::Storage { .. }) {
            counts.0 += 1;
        }
        if matches!(module.types[global.ty].inner, naga::TypeInner::Image { .. }) {
            counts.1 += 1;
        }
    }
    counts
}

#[test]
fn the_forward_shader_with_probes_stays_within_the_forward_stage_budget() {
    let source = forward_with_probes();
    let module = parse("forward with probes", &source);
    let info = validated("forward with probes", &module);
    let probes = module.global_variables.iter().find(|(_, global)| global.name.as_deref() == Some("env_probes")).expect("env_probes").1;
    assert_eq!(probes.binding.as_ref().map(|binding| (binding.group, binding.binding)), Some((0, 11)), "the sky cube's binding");
    assert!(matches!(module.types[probes.ty].inner, naga::TypeInner::Image { dim: naga::ImageDimension::Cube, arrayed: true, .. }), "a cube array");
    let rows = module.global_variables.iter().find(|(_, global)| global.name.as_deref() == Some("env_probe_rows")).expect("env_probe_rows").1;
    assert_eq!(rows.binding.as_ref().map(|binding| binding.binding), Some(22));
    let (storage, textures) = fragment_counts(&module, &info, "fs_main");
    assert_eq!(storage, 6, "one storage buffer more than A.0's five (the rows): {storage} of 8");
    assert_eq!(textures, genex_render::abi::FORWARD_FRAGMENT_TEXTURES_MAX, "no sampled texture more: the array takes the cube's slot");
    assert!(textures <= genex_render::abi::FORWARD_FRAGMENT_TEXTURES_MAX);
    // The capture's pipelines compile the probes out.
    let constants: naga::back::PipelineConstants = [("GX_PROBES".to_owned(), 0.0)].into_iter().collect();
    naga::back::pipeline_constants::process_overrides(&module, &info, None, &constants).expect("GX_PROBES overrides");
}

#[test]
fn the_probe_passes_validate_against_webgpu_core() {
    let module = parse("probe passes", genex_render::probes::PROBE_PASSES);
    validated("probe passes", &module);
    for entry in [genex_render::probes::SKY_FILL_ENTRY, genex_render::probes::COPY_ENTRY] {
        assert!(module.entry_points.iter().any(|point| point.name == entry), "{entry}");
    }
    let entries: Vec<(u32, &str)> = genex_render::probes::FRAME_PROBE_BINDINGS.to_vec();
    assert_eq!(entries, [(11, "env_probes"), (22, "env_probe_rows")]);
    for (binding, name) in genex_render::probes::FRAME_PROBE_BINDINGS {
        let entry = genex_render::probes::frame_env_entry(binding, name).expect("an entry");
        assert_eq!((entry.binding, entry.visibility), (binding, wgpu::ShaderStages::FRAGMENT));
    }
    assert!(genex_render::probes::frame_env_entry(12, "env_sh").is_none());
}

// --- GPU rows ---

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

/// f32 to IEEE half (normal range), round to nearest even.
fn f16_bits(value: f32) -> u16 {
    let bits = value.to_bits();
    let sign = ((bits >> 16) & 0x8000) as u16;
    let exponent = ((bits >> 23) & 0xff) as i32 - 127 + 15;
    let mantissa = bits & 0x7f_ffff;
    if exponent <= 0 {
        return sign;
    }
    let mut half = u32::from(sign) | ((exponent as u32) << 10) | (mantissa >> 13);
    let rest = mantissa & 0x1fff;
    if rest > 0x1000 || (rest == 0x1000 && half & 1 == 1) {
        half += 1;
    }
    half as u16
}

fn f16_value(half: u16) -> f32 {
    let sign = u32::from(half & 0x8000) << 16;
    let exponent = u32::from((half >> 10) & 0x1f);
    if exponent == 0 {
        return f32::from_bits(sign);
    }
    let mantissa = u32::from(half & 0x3ff);
    f32::from_bits(sign | ((exponent + 127 - 15) << 23) | (mantissa << 13))
}

/// A smooth sky map: brighter overhead, bluish.
fn sky_map() -> HdriImage {
    let (width, height) = (128, 64);
    let texels = (0..height)
        .flat_map(|y| (0..width).map(move |x| (x, y)))
        .map(|(x, y)| {
            let d = equirect_direction((x as f32 + 0.5) / width as f32, (y as f32 + 0.5) / height as f32);
            let [r, g, b] = [0.4 + 0.2 * d[1], 0.6 + 0.3 * d[1], 0.9 + 0.4 * d[1]];
            [f16_bits(r), f16_bits(g), f16_bits(b), f16_bits(1.0)]
        })
        .collect();
    HdriImage { width, height, texels }
}

fn probe_quality(cube_size: u32, probes: u8, side_max: u32) -> EnvironmentQuality {
    let mut quality = Quality::off().environment;
    quality.ibl = true;
    quality.cube_size = cube_size;
    quality.reflection_probes = probes;
    quality.probe_side_max = side_max;
    quality
}

fn hdri(rotation: f32) -> Environment {
    Environment::Hdri(HdriEnvironment::new("env/probe-test.hdr").with_rotation_degrees(rotation).with_sun(HdriSun::Off))
}

/// One frame of graph node 11 for the test: the bake, then the probes' schedule, every capture
/// step encoded, the face draws standing in as clears (`face_color` per face; a face whose colour
/// is None keeps its depth at the clear value, so the sky fills it). Returns the bake's action and
/// the capture steps.
fn frame(gpu: &Gpu, maps: &mut EnvironmentMaps, (environment, quality): (&Environment, &EnvironmentQuality), (frame_index, settle): (u64, bool), probes: &[ReflectionProbe], face_color: &dyn Fn(u32) -> Option<[f32; 4]>) -> (BakeAction, Vec<(usize, CaptureStep)>) {
    let mut encoder = FrameEncoder::new(&gpu.device, &gpu.queue, "probe test frame");
    let request = BakeRequest { environment, quality, frame_index, settle, sun_dir: [0.0, 1.0, 0.0], sun_color: [1.0; 3] };
    maps.bake(&mut encoder, &request, None);
    let action = maps.last_work().action;
    let order: Vec<u32> = (0..probes.len() as u32).collect();
    let prep = ProbePrep { declared: probes, order: &order, quality, sky: None, frame_index, settle, sun_dir: [0.0, 1.0, 0.0], depth_reversed: true };
    let (work, _) = maps.prepare_probes(&mut encoder, &prep);
    for (slot, step) in &work {
        if let Some(face) = maps.probe_face(*slot, *step, &prep) {
            let color = face_color(face.face);
            let [r, g, b, a] = color.unwrap_or([0.0; 4]).map(f64::from);
            let depth = if color.is_some() { 0.5 } else { face.depth_clear };
            let pass = encoder.encoder().begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("probe test face"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &face.color,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color { r, g, b, a }), store: wgpu::StoreOp::Store },
                })],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: &face.depth,
                    depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(depth), store: wgpu::StoreOp::Store }),
                    stencil_ops: None,
                }),
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            drop(pass);
        }
        maps.encode_probe_step(&mut encoder, *slot, *step);
    }
    encoder.submit();
    let _ = gpu.device.poll(wgpu::PollType::wait_indefinitely());
    (action, work)
}

/// Mip `mip` of array layer `layer` of `texture`, as rgba f32 texels row by row.
fn read_layer(gpu: &Gpu, texture: &wgpu::Texture, mip: u32, layer: u32) -> Vec<[f32; 4]> {
    let side = (texture.width() >> mip).max(1);
    let row = side * 8;
    let padded = row.div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT) * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
    let staging = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("probe readback"),
        size: u64::from(padded * side),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("probe readback") });
    encoder.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo { texture, mip_level: mip, origin: wgpu::Origin3d { x: 0, y: 0, z: layer }, aspect: wgpu::TextureAspect::All },
        wgpu::TexelCopyBufferInfo { buffer: &staging, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(padded), rows_per_image: Some(side) } },
        wgpu::Extent3d { width: side, height: side, depth_or_array_layers: 1 },
    );
    gpu.queue.submit([encoder.finish()]);
    staging.slice(..).map_async(wgpu::MapMode::Read, |result| result.expect("mapped"));
    let _ = gpu.device.poll(wgpu::PollType::wait_indefinitely());
    let data = staging.slice(..).get_mapped_range().expect("mapped range").to_vec();
    staging.unmap();
    (0..side as usize)
        .flat_map(|y| {
            let start = y * padded as usize;
            data[start..start + row as usize].as_chunks::<8>().0.iter().map(|texel| [0, 1, 2, 3].map(|c| f16_value(u16::from_le_bytes([texel[2 * c], texel[2 * c + 1]])))).collect::<Vec<_>>()
        })
        .collect()
}

/// The room's faces: five drawn (each its own colour), the sixth (-Z) open to the sky.
fn room_face(face: u32) -> Option<[f32; 4]> {
    (face < 5).then_some([0.25 + 0.1 * face as f32, 0.5, 1.0 - 0.15 * face as f32, 1.0])
}

const PROBE: [f32; 3] = [0.0; 3];

fn probe() -> ReflectionProbe {
    ReflectionProbe::new([-2.0, -2.0, -2.0], [2.0, 2.0, 2.0]).with_capture(PROBE)
}

#[test]
#[ignore = "real GPU: run with --ignored metal"]
fn metal_a_probe_capture_is_filtered_and_published_into_its_layer_with_the_sky_in_layer_0() {
    let Some(gpu) = gpu() else { return };
    for (cube, side_max) in [(64, 0), (128, 64)] {
        let mut maps = EnvironmentMaps::new(&gpu.device, &gpu.queue);
        maps.set_map(&gpu.device, &gpu.queue, &sky_map()).expect("map");
        let environment = hdri(0.0);
        maps.set_environment(&environment);
        let quality = probe_quality(cube, 4, side_max);
        let probes = [probe()];
        let (action, work) = frame(&gpu, &mut maps, (&environment, &quality), (0, true), &probes, &room_face);
        assert_eq!(action, BakeAction::Full);
        assert_eq!(work.len(), CAPTURE_STEPS as usize, "{cube}: one whole capture");
        let array = maps.probes().array().expect("an array");
        let side = array.width();
        assert_eq!(side, if side_max == 0 { cube } else { side_max });
        assert_eq!(array.depth_or_array_layers(), 6 * 5, "the sky and four probe layers");
        assert_eq!(maps.probes().schedule().layer_of(&probes, 0), 1);
        // Layer 0: the sky's bound cube, every mip (exact at one ratio, the 2x2 mean at two).
        let specular = maps.specular_texture().expect("baked");
        for mip in 0..SPECULAR_MIPS {
            for face in 0..6 {
                let layer0 = read_layer(&gpu, array, mip, face);
                let sky = read_layer(&gpu, specular, mip, face);
                let sky_side = (cube >> mip).max(1) as usize;
                let ratio = sky_side / (side >> mip).max(1) as usize;
                for (index, texel) in layer0.iter().enumerate() {
                    let (x, y) = (index % (sky_side / ratio), index / (sky_side / ratio));
                    let mut mean = [0.0_f32; 4];
                    for j in 0..ratio {
                        for i in 0..ratio {
                            let source = sky[(y * ratio + j) * sky_side + x * ratio + i];
                            for c in 0..4 {
                                mean[c] += source[c] / (ratio * ratio) as f32;
                            }
                        }
                    }
                    for c in 0..3 {
                        assert!((texel[c] - mean[c]).abs() <= 2e-3 * mean[c].abs().max(1.0), "{cube} mip {mip} face {face} texel {index}: {texel:?} vs {mean:?}");
                    }
                }
            }
        }
        // Layer 1, mip 0: each drawn face exactly its colour, the open face the sky's radiance.
        for face in 0..6 {
            let texels = read_layer(&gpu, array, 0, 6 + face);
            match room_face(face) {
                Some(color) => {
                    let want = color.map(|c| f16_value(f16_bits(c)));
                    assert!(texels.iter().all(|texel| texel[..3] == want[..3]), "{cube} face {face}: {:?} vs {want:?}", texels[0]);
                }
                None => {
                    let sky = read_layer(&gpu, array, 0, face);
                    for (texel, sky) in texels.iter().zip(&sky) {
                        for c in 0..3 {
                            assert!((texel[c] - sky[c]).abs() <= 0.02 * sky[c].max(0.1), "{cube} open face: {texel:?} vs the sky's {sky:?}");
                        }
                    }
                }
            }
        }
        // The rough mips blend the faces: the centre of +X at mip 1 is still mostly +X's colour,
        // the last mip a mix of every face.
        let centre = |texels: &[[f32; 4]], side: u32| texels[((side / 2) * side + side / 2) as usize];
        let mip1 = centre(&read_layer(&gpu, array, 1, 6), side >> 1);
        let own = room_face(0).expect("drawn");
        for c in 0..3 {
            assert!((mip1[c] - own[c]).abs() < 0.08 * own[c].max(0.2), "mip 1 +X centre {mip1:?} vs {own:?}");
        }
        let last = centre(&read_layer(&gpu, array, SPECULAR_MIPS - 1, 6), (side >> (SPECULAR_MIPS - 1)).max(1));
        assert!(last[0] > own[0] + 0.02 && last[2] < own[2], "the roughest mip mixes the faces: {last:?}");
    }
}

#[test]
#[ignore = "real GPU: run with --ignored metal"]
fn metal_a_refresh_keeps_the_last_capture_bound_until_it_publishes() {
    let Some(gpu) = gpu() else { return };
    let mut maps = EnvironmentMaps::new(&gpu.device, &gpu.queue);
    maps.set_map(&gpu.device, &gpu.queue, &sky_map()).expect("map");
    let environment = hdri(0.0);
    maps.set_environment(&environment);
    let quality = probe_quality(64, 4, 0);
    let probes = [probe()];
    frame(&gpu, &mut maps, (&environment, &quality), (0, false), &probes, &room_face);
    let first = read_layer(&gpu, maps.probes().array().expect("array"), 0, 6);
    // A new environment: the sky rebakes over its time-sliced cycle, then every probe refreshes
    // one step a frame, drawing new colours.
    let turned = hdri(90.0);
    maps.set_environment(&turned);
    let brighter = |face: u32| room_face(face).map(|[r, g, b, a]| [r * 2.0, g * 2.0, b * 2.0, a]);
    let mut published = None;
    for frame_index in 1..80 {
        let (_, work) = frame(&gpu, &mut maps, (&turned, &quality), (frame_index, false), &probes, &brighter);
        let now = read_layer(&gpu, maps.probes().array().expect("array"), 0, 6);
        let publishing = work.iter().any(|(_, step)| *step == CaptureStep::Publish);
        if publishing {
            published = Some(frame_index);
            assert!(now.iter().all(|texel| texel[0] > first[0][0] * 1.9), "the refresh lands whole: {:?}", now[0]);
            break;
        }
        assert_eq!(now, first, "frame {frame_index}: the last capture stays bound while the refresh runs ({work:?})");
    }
    assert!(published.is_some(), "the refresh published");
}

// --- Renderer rows: the capture node and the forward probe walk (with `probes::LANDED`) ---

/// Whether the renderer captures and shades probes in this build (the integration lands it).
fn probes_landed() -> bool {
    if !genex_render::probes::LANDED {
        eprintln!("skipped: probes::LANDED is false, so the renderer captures no probe in this build");
    }
    genex_render::probes::LANDED
}

/// The HDR scene with desktop `high`'s environment (16 probes), binned lights and sun shadows,
/// every other effect off.
fn room_quality() -> Quality {
    let class = DeviceClass::from_wire("desktop-high").expect("class");
    let high = preset_quality(QualityPreset::High, class);
    let mut quality = Quality::off();
    quality.hdr = true;
    quality.tonemap = true;
    quality.exposure = true;
    quality.environment = high.environment;
    quality.lights = high.lights;
    quality.shadows = high.shadows;
    quality
}

fn room_renderer(gpu: &Gpu, width: u32, height: u32) -> genex_render::Renderer {
    let mut renderer = genex_render::Renderer::with_options(gpu, width, height, genex_render::RenderOptions { msaa: false }).expect("renderer");
    renderer.set_scene_format(genex_render::settings::SceneFormat::Rgba16Float);
    renderer.set_quality(&room_quality());
    renderer.set_environment(&Environment::sky());
    renderer
}

/// The closed room: its box (x and z within 4 of the centre, 3 high).
const ROOM_MIN: [f32; 3] = [-4.0, 0.0, -4.0];
const ROOM_MAX: [f32; 3] = [4.0, 3.0, 4.0];

/// A closed room under the sky: a polished metal floor, a red back wall (-z), white walls and
/// ceiling, lit by a lamp under the ceiling; the sun outside. The camera looks down at the floor,
/// whose mirror image is the back wall. With `probe`, the room is a reflection probe.
fn room_scene(probe: bool) -> genex_render::scene::Scene {
    use genex_render::scene::{Material, MeshId, Scene, scaled};
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 1.6, 3.0], [0.0, 0.5, -3.0]), [0, 0, 0, 255]);
    scene.lighting.sun_dir = [0.3, 0.8, 0.5];
    scene.lighting.sun_intensity = 3.0;
    scene.lighting.ambient_intensity = 0.0;
    scene.lighting.points.push(genex_render::lights::PointLight { position: [0.0, 2.6, 0.0], range: 9.0, color: [255, 240, 220], intensity: 6.0 });
    let white = Material::color([210, 210, 210, 255]).with_pbr(0.0, 0.8);
    scene.draw(MeshId::CUBE, scaled([0.0, -0.05, 0.0], [8.0, 0.1, 8.0]), Material::color([235, 235, 235, 255]).with_pbr(1.0, 0.08));
    scene.draw(MeshId::CUBE, scaled([0.0, 3.05, 0.0], [8.2, 0.1, 8.2]), white);
    scene.draw(MeshId::CUBE, scaled([0.0, 1.5, -4.05], [8.2, 3.2, 0.1]), Material::color([200, 40, 40, 255]).with_pbr(0.0, 0.7));
    scene.draw(MeshId::CUBE, scaled([0.0, 1.5, 4.05], [8.2, 3.2, 0.1]), white);
    scene.draw(MeshId::CUBE, scaled([-4.05, 1.5, 0.0], [0.1, 3.2, 8.2]), white);
    scene.draw(MeshId::CUBE, scaled([4.05, 1.5, 0.0], [0.1, 3.2, 8.2]), white);
    if probe {
        scene.lighting.reflection_probes.push(ReflectionProbe::new(ROOM_MIN, ROOM_MAX).with_capture([0.0, 1.5, 0.0]).with_blend(0.3));
    }
    scene
}

/// The linear HDR scene after `frames` frames of `scene`.
fn radiance_after(renderer: &mut genex_render::Renderer, gpu: &Gpu, scene: &genex_render::scene::Scene, frames: u32) -> Vec<[f32; 4]> {
    for _ in 0..frames {
        renderer.render(gpu, scene, genex_render::CullPath::Gpu).expect("frame");
    }
    renderer.read_scene(gpu).expect("the HDR scene reads back")
}

/// Write `texels` (linear rgb, `width × height`) as a Reinhard-tonemapped `.ppm` named `name` under
/// `GENEX_PROBE_EVIDENCE_DIR`, when it is set.
fn write_evidence(name: &str, (width, height): (u32, u32), texels: &[[f32; 4]]) {
    let Ok(folder) = std::env::var("GENEX_PROBE_EVIDENCE_DIR") else { return };
    let encode = |value: f32| {
        let mapped = value.max(0.0) * 4.0 / (1.0 + value.max(0.0) * 4.0);
        (libm::powf(mapped, 1.0 / 2.2) * 255.0).round() as u8
    };
    let mut bytes = format!("P6\n{width} {height}\n255\n").into_bytes();
    bytes.extend(texels.iter().flat_map(|texel| [texel[0], texel[1], texel[2]].map(encode)));
    std::fs::create_dir_all(&folder).expect("evidence folder");
    std::fs::write(std::path::Path::new(&folder).join(format!("{name}.ppm")), bytes).expect("evidence written");
}

/// Write a displayed frame (BGRA8, rows top first) as a `.ppm` named `name` under
/// `GENEX_PROBE_EVIDENCE_DIR`, when it is set.
fn write_bgra_evidence(name: &str, (width, height): (u32, u32), bgra: &[u8]) {
    let Ok(folder) = std::env::var("GENEX_PROBE_EVIDENCE_DIR") else { return };
    let mut bytes = format!("P6\n{width} {height}\n255\n").into_bytes();
    bytes.extend(bgra.chunks(4).flat_map(|texel| [texel[2], texel[1], texel[0]]));
    std::fs::create_dir_all(&folder).expect("evidence folder");
    std::fs::write(std::path::Path::new(&folder).join(format!("{name}.ppm")), bytes).expect("evidence written");
}

/// The mean rgb of the pixels of a `width`-wide frame in rows `rows` (fractions of the height
/// `height`) and columns `columns` (fractions of the width).
fn region_mean(texels: &[[f32; 4]], (width, height): (u32, u32), rows: (f32, f32), columns: (f32, f32)) -> [f32; 3] {
    let (y0, y1) = ((rows.0 * height as f32) as u32, (rows.1 * height as f32) as u32);
    let (x0, x1) = ((columns.0 * width as f32) as u32, (columns.1 * width as f32) as u32);
    let mut sum = [0.0_f64; 3];
    let mut count = 0.0;
    for y in y0..y1 {
        for x in x0..x1 {
            let texel = texels[(y * width + x) as usize];
            for c in 0..3 {
                sum[c] += f64::from(texel[c]);
            }
            count += 1.0;
        }
    }
    sum.map(|value| (value / count) as f32)
}

/// The share of red in `rgb`.
fn red_share(rgb: [f32; 3]) -> f32 {
    rgb[0] / (rgb[0] + rgb[1] + rgb[2]).max(1e-6)
}

/// Where the floor mirrors the back wall in the room frame, and where the wall is seen directly.
const FLOOR_ROWS: (f32, f32) = (0.78, 0.97);
const WALL_ROWS: (f32, f32) = (0.12, 0.3);
const MIDDLE: (f32, f32) = (0.3, 0.7);

#[test]
#[ignore = "real GPU: run with --ignored metal"]
fn metal_a_room_s_polished_floor_reflects_the_room_not_the_sky() {
    // Plan A.3's acceptance: an interior floor reflects its own room, not the sky. Without a
    // probe the polished floor mirrors the sky's cube (bright, blue) through a closed room; with
    // the room's probe it mirrors the red back wall the camera also sees directly.
    let Some(gpu) = gpu() else { return };
    if !probes_landed() {
        return;
    }
    let size = (320, 180);
    let mut results = Vec::new();
    for probe in [false, true] {
        let mut renderer = room_renderer(&gpu, size.0, size.1);
        let texels = radiance_after(&mut renderer, &gpu, &room_scene(probe), 3);
        write_evidence(&format!("room-probe-{probe}"), size, &texels);
        let floor = region_mean(&texels, size, FLOOR_ROWS, MIDDLE);
        let wall = region_mean(&texels, size, WALL_ROWS, MIDDLE);
        eprintln!("probe {probe}: floor {floor:?} (red share {:.3}), back wall {wall:?} (red share {:.3})", red_share(floor), red_share(wall));
        results.push((floor, wall));
    }
    let [(sky_floor, wall), (room_floor, _)] = [results[0], results[1]];
    assert!(red_share(wall) > 0.5, "the back wall is red: {wall:?}");
    assert!(red_share(sky_floor) < 0.34, "without a probe the floor mirrors the blue sky: {sky_floor:?}");
    assert!(red_share(room_floor) > 0.45, "with the room's probe the floor mirrors the red wall: {room_floor:?}");
    let luminance = |rgb: [f32; 3]| 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    assert!(luminance(room_floor) < luminance(sky_floor), "the closed room is darker than the sky it no longer mirrors");
}

/// A corridor 16 long under two probes split at x = 0 (each fading over a metre), or one.
fn corridor_scene(split: bool) -> genex_render::scene::Scene {
    use genex_render::scene::{Material, MeshId, Scene, scaled};
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 1.6, 3.5], [0.0, 0.3, -2.0]), [0, 0, 0, 255]);
    scene.lighting.sun_dir = [0.3, 0.8, 0.5];
    scene.lighting.sun_intensity = 3.0;
    scene.lighting.ambient_intensity = 0.0;
    for x in [-5.0_f32, 0.0, 5.0] {
        // Bright enough that the displayed floor sits mid-scale: an 8-bit level is under 1% of it.
        scene.lighting.points.push(genex_render::lights::PointLight { position: [x, 2.6, 0.0], range: 7.0, color: [255, 240, 220], intensity: 30.0 });
    }
    let white = Material::color([210, 210, 210, 255]).with_pbr(0.0, 0.8);
    scene.draw(MeshId::CUBE, scaled([0.0, -0.05, 0.0], [16.0, 0.1, 8.0]), Material::color([235, 235, 235, 255]).with_pbr(1.0, 0.15));
    scene.draw(MeshId::CUBE, scaled([0.0, 3.05, 0.0], [16.2, 0.1, 8.2]), white);
    scene.draw(MeshId::CUBE, scaled([0.0, 1.5, -4.05], [16.2, 3.2, 0.1]), Material::color([60, 90, 200, 255]).with_pbr(0.0, 0.7));
    scene.draw(MeshId::CUBE, scaled([0.0, 1.5, 4.05], [16.2, 3.2, 0.1]), white);
    scene.draw(MeshId::CUBE, scaled([-8.05, 1.5, 0.0], [0.1, 3.2, 8.2]), white);
    scene.draw(MeshId::CUBE, scaled([8.05, 1.5, 0.0], [0.1, 3.2, 8.2]), white);
    let probes = if split {
        vec![
            ReflectionProbe::new([-8.0, 0.0, -4.0], [0.5, 3.0, 4.0]).with_capture([-4.0, 1.5, 0.0]).with_blend(1.0),
            ReflectionProbe::new([-0.5, 0.0, -4.0], [8.0, 3.0, 4.0]).with_capture([4.0, 1.5, 0.0]).with_blend(1.0),
        ]
    } else {
        vec![ReflectionProbe::new([-8.0, 0.0, -4.0], [8.0, 3.0, 4.0]).with_capture([0.0, 1.5, 0.0]).with_blend(1.0)]
    };
    scene.lighting.reflection_probes = probes;
    scene
}

/// The largest step between two neighbouring floor pixels of a row of the displayed frame (BGRA8,
/// its Rec. 709 luma), relative to the row's mean, over the floor rows: a seam shows as a step no
/// neighbouring pair elsewhere takes.
fn largest_floor_step(bgra: &[u8], (width, height): (u32, u32)) -> f32 {
    let luma = |x: u32, y: u32| {
        let at = ((y * width + x) * 4) as usize;
        0.0722 * f32::from(bgra[at]) + 0.7152 * f32::from(bgra[at + 1]) + 0.2126 * f32::from(bgra[at + 2])
    };
    let mut worst = 0.0_f32;
    for y in (FLOOR_ROWS.0 * height as f32) as u32..(FLOOR_ROWS.1 * height as f32) as u32 {
        let row: Vec<f32> = (0..width).map(|x| luma(x, y)).collect();
        let mean = row.iter().sum::<f32>() / row.len() as f32;
        for pair in row.windows(2).skip(4).take(row.len() - 9) {
            worst = worst.max((pair[1] - pair[0]).abs() / mean.max(1e-6));
        }
    }
    worst
}

/// The most a seam between two probes may step the displayed floor beyond the single probe's own
/// largest step (plan A.3: no seam above 3%).
const SEAM_STEP: f32 = 0.03;

#[test]
#[ignore = "real GPU: run with --ignored metal"]
fn metal_the_blend_across_a_probe_boundary_shows_no_seam() {
    let Some(gpu) = gpu() else { return };
    if !probes_landed() {
        return;
    }
    let size = (320, 180);
    let mut steps = Vec::new();
    for split in [false, true] {
        let mut renderer = room_renderer(&gpu, size.0, size.1);
        let texels = radiance_after(&mut renderer, &gpu, &corridor_scene(split), 3);
        write_evidence(&format!("corridor-split-{split}"), size, &texels);
        let shown = renderer.capture(&gpu).expect("capture");
        let step = largest_floor_step(shown.bgra(), size);
        write_bgra_evidence(&format!("corridor-split-{split}-shown"), size, shown.bgra());
        eprintln!("split {split}: the displayed floor's largest neighbouring step is {:.3}% of its row", 100.0 * step);
        steps.push(step);
    }
    assert!(steps[1] <= steps[0] + SEAM_STEP, "two probes step the floor by {:.2}% (one: {:.2}%)", 100.0 * steps[1], 100.0 * steps[0]);
}

/// The reflection probes' shading budget at 1080p (plan A.3): added GPU frame time, ms.
const PROBE_SHADING_BUDGET_MS: f32 = 0.3;
/// Interleaved timing rounds of the shading row (the first warms up and is dropped).
const PERF_ROUNDS: u32 = 12;
/// A time-sliced capture step's budget (plan A.3): added GPU frame time, ms.
const PROBE_CAPTURE_STEP_BUDGET_MS: f32 = 0.3;

fn median(values: &mut [f32]) -> f32 {
    values.sort_by(f32::total_cmp);
    values[values.len() / 2]
}

/// GPU frame times of `frames` frames of `scene` (the sun at `sun(frame)`), each frame's landed
/// times keyed by the frame they belong to (the timer answers a frame's time a few frames later).
fn timed_frames(gpu: &Gpu, renderer: &mut genex_render::Renderer, scene: &mut genex_render::scene::Scene, frames: u64, sun: &dyn Fn(u64) -> [f32; 3]) -> Option<Vec<f32>> {
    let mut times = Vec::new();
    for frame in 0..frames + 8 {
        times.extend(renderer.arm_frame_timer(&gpu.queue)?);
        scene.lighting.sun_dir = sun(frame);
        renderer.set_frame_index(frame);
        renderer.render(gpu, scene, genex_render::CullPath::Gpu).expect("frame");
        renderer.finish_frame_timer();
        let _ = gpu.device.poll(wgpu::PollType::wait_indefinitely());
    }
    times.truncate(frames as usize);
    Some(times)
}

#[test]
#[ignore = "real GPU: run with --ignored metal"]
fn metal_probe_shading_and_a_capture_step_stay_within_their_budgets_at_1080p() {
    // Plan A.3: shading at most +0.3 ms (one probe over the room, against none; interleaved
    // rounds, the median of the rounds' paired differences), a time-sliced capture step at most
    // 0.3 ms over a frame without one (the sun turns once, the sky rebakes, the probe's capture
    // refreshes a step a frame for its 14 frames).
    let Some(gpu) = gpu() else { return };
    if !probes_landed() {
        return;
    }
    let (width, height) = (1920, 1080);
    let still = |_: u64| [0.3, 0.8, 0.5];
    let mut renderers = [room_renderer(&gpu, width, height), room_renderer(&gpu, width, height)];
    let mut scenes = [room_scene(false), room_scene(true)];
    let mut deltas = Vec::new();
    for round in 0..PERF_ROUNDS {
        let mut medians = [0.0_f32; 2];
        for k in 0..2 {
            let Some(mut times) = timed_frames(&gpu, &mut renderers[k], &mut scenes[k], 80, &still) else {
                eprintln!("skipped: no timestamp queries");
                return;
            };
            medians[k] = median(&mut times[8..]);
        }
        if round > 0 {
            deltas.push(medians[1] - medians[0]);
        }
    }
    let shading = median(&mut deltas);
    // Capture steps: the sun turns at frame 10 of each cycle of 40 (a continuous rebake on high),
    // so frames 11..25 refresh the probe a step each; frames 30..40 are idle.
    let mut renderer = room_renderer(&gpu, width, height);
    let mut scene = room_scene(true);
    let mut step_extra = Vec::new();
    for cycle in 0..8u64 {
        let turned = |frame: u64| if frame >= 10 { [0.3 + 0.02 * (cycle + 1) as f32, 0.8, 0.5] } else { [0.3 + 0.02 * cycle as f32, 0.8, 0.5] };
        let Some(times) = timed_frames(&gpu, &mut renderer, &mut scene, 40, &turned) else { return };
        let mut idle: Vec<f32> = times[30..40].to_vec();
        let idle = median(&mut idle);
        step_extra.extend(times[12..25].iter().map(|time| time - idle));
    }
    let steps = median(&mut step_extra.clone());
    step_extra.sort_by(f32::total_cmp);
    let row = format!(
        "{{\"row\":\"probes-1080p\",\"adapter\":\"{}\",\"shadingAddedMedianMs\":{shading:.4},\"captureStepAddedMedianMs\":{steps:.4},\"captureStepAddedP90Ms\":{:.4}}}",
        gpu.receipt().adapter,
        step_extra[step_extra.len() * 9 / 10]
    );
    println!("{row}");
    if let Ok(path) = std::env::var("GENEX_PERF_OUT") {
        std::fs::write(path, format!("{row}\n")).expect("perf row");
    }
    assert!(shading <= PROBE_SHADING_BUDGET_MS, "probe shading adds {shading:.3} ms");
    assert!(steps <= PROBE_CAPTURE_STEP_BUDGET_MS, "a capture step adds {steps:.3} ms");
}
