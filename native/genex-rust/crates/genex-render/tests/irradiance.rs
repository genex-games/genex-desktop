//! Irradiance volumes (renderer pass 2 A.4, `genex_render::irradiance`). CPU rows hold the presets,
//! the binning, the forward shader with the atlas to WebGPU core's limits (D1: 15 sampled textures
//! of 16) and the bake's reduce; real-GPU rows (`#[ignore]`d, every name contains `metal`) hold the
//! plan's acceptance on the renderer: a white floor beside a sunlit red wall takes its colour, a
//! closed room keeps the light outside a 20 cm wall out, the bake's slice and the shading stay in
//! their budgets, and a settled capture's bake does not depend on what Live baked before:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked --test irradiance -- --ignored metal

use genex_render::Gpu;
use genex_render::device_class::{DeviceClass, FormFactor, PerformanceTier};
use genex_render::irradiance::{AmbientCube, IrradianceVolume, ambient_cube, grid_seen, held_volumes, volume_row};
use genex_render::lights::{Lighting, binned_frame};
use genex_render::presets::preset_quality;
use genex_render::probes::ReflectionProbe;
use genex_render::scene::CameraDesc;
use genex_render::settings::{Environment, Quality, QualityPreset};
use naga::valid::{Capabilities, ModuleInfo, ValidationFlags, Validator};

// --- CPU rows ---

fn class(form: FormFactor, tier: PerformanceTier) -> DeviceClass {
    DeviceClass::ALL.into_iter().find(|class| class.form == form && class.tier == tier).expect("class")
}

#[test]
fn the_presets_bake_volumes_from_medium_up_and_phones_read_them_in_three_fetches() {
    let desktop = class(FormFactor::Desktop, PerformanceTier::Ultra);
    let counts: Vec<u8> = QualityPreset::ALL.into_iter().map(|preset| preset_quality(preset, desktop).environment.irradiance_volumes).collect();
    assert_eq!(counts, [0, 4, 8, 8], "low, medium, high, ultra on a desktop");
    assert!(preset_quality(QualityPreset::Medium, desktop).environment.irradiance_leak_control, "desktop medium and up hide cells behind walls");
    for (tier, most) in [(PerformanceTier::Low, 0), (PerformanceTier::Mid, 2), (PerformanceTier::High, 4)] {
        let phone = preset_quality(QualityPreset::Ultra, class(FormFactor::Mobile, tier)).environment;
        assert_eq!(phone.irradiance_volumes, most, "mobile-{tier:?}");
        assert!(!phone.irradiance_leak_control, "mobile-{tier:?}: three trilinear fetches");
    }
    assert_eq!(Quality::off().environment.irradiance_volumes, 0, "the off quality bakes none");
}

/// Owner decision D16 (2026-10-18): a feature that cannot fit a phone's eighth of the frame is off
/// at the phone's own preset and stays a person's or game's choice at `high` and `ultra`. The
/// volumes' time-sliced bake measured +1.9 ms on the mobile-high proxy (4.1 ms against 2.083), so
/// no phone bakes them at its default preset; `high` on mobile-mid and mobile-high still does.
#[test]
fn phones_bake_no_volumes_at_their_default_preset_and_still_do_at_high() {
    for tier in [PerformanceTier::Low, PerformanceTier::Mid, PerformanceTier::High] {
        let phone = class(FormFactor::Mobile, tier);
        let preset = genex_render::presets::class_defaults(phone).preset;
        assert_eq!(preset_quality(preset, phone).environment.irradiance_volumes, 0, "mobile-{tier:?} at its default {preset:?}");
        assert_eq!(preset_quality(QualityPreset::Medium, phone).environment.irradiance_volumes, 0, "mobile-{tier:?} at medium");
    }
    let high = |tier| preset_quality(QualityPreset::High, class(FormFactor::Mobile, tier)).environment.irradiance_volumes;
    assert_eq!([high(PerformanceTier::Low), high(PerformanceTier::Mid), high(PerformanceTier::High)], [0, 2, 4], "a phone's high preset keeps its cap");
}

/// A 4 x 2 x 4 volume of 1 m cells filling a room whose walls stand on the box's faces: each cell's
/// reaches stop at the walls (`open`: nothing around, every reach the most a cell records).
fn room_cells(volume: &IrradianceVolume, open: bool) -> impl Fn([u32; 3]) -> AmbientCube {
    let reach_max = volume.reach_max();
    let size = [4.0_f32, 2.0, 4.0];
    move |cell: [u32; 3]| {
        let reaches: [f32; 6] = std::array::from_fn(|face| {
            let (axis, centre) = (face / 2, cell[face / 2] as f32 + 0.5);
            let wall = if face % 2 == 0 { size[axis] - centre } else { centre };
            if open { reach_max } else { wall }
        });
        ambient_cube([[0.1; 3]; 6], reaches, reach_max)
    }
}

/// GA round 2: the Lakeside cabin's sunless front wall read 67 levels at medium against 90 without
/// the room's volume, because a point on a wall's outside face inside the volume's fade band read
/// the room's cells behind the wall at the volume's full weight. With leak control the volume
/// weighs a point by how far its cells see it ([`grid_seen`]): none past the wall, all of it inside
/// the room and past an open box's face.
#[test]
fn a_room_s_volume_lends_nothing_past_its_wall_and_everything_inside() {
    let volume = IrradianceVolume::new([0.0, 0.0, 0.0], [4.0, 2.0, 4.0]).with_cells([4, 2, 4]).with_blend(0.3);
    let row = volume_row(&volume, Some(0), 1.0, true);
    let (walled, open) = (room_cells(&volume, false), room_cells(&volume, true));
    let outside = ([4.2, 1.0, 2.0], [1.0, 0.0, 0.0]);
    assert!(grid_seen(&row, &walled, outside.0, outside.1) < 0.01, "the wall's outside face: {}", grid_seen(&row, &walled, outside.0, outside.1));
    assert!(grid_seen(&row, &open, outside.0, outside.1) > 0.99, "an open box's fade band keeps the volume");
    for (p, n) in [([3.95, 1.0, 2.0], [-1.0, 0.0, 0.0]), ([2.0, 0.02, 2.0], [0.0, 1.0, 0.0]), ([1.3, 1.1, 2.7], [0.0, 0.0, 1.0])] {
        assert!(grid_seen(&row, &walled, p, n) > 0.99, "inside the room at {p:?}: {}", grid_seen(&row, &walled, p, n));
    }
    let phone = volume_row(&volume, Some(0), 1.0, false);
    assert_eq!(grid_seen(&phone, &walled, outside.0, outside.1), 1.0, "phones read the cells as they are");
}

#[test]
fn the_lights_bin_volumes_after_the_reflection_probes() {
    let camera = CameraDesc::look_at([0.0, 1.6, 0.0], [0.0, 1.6, 10.0]);
    let quality = preset_quality(QualityPreset::High, DeviceClass::ALL[0]).lights;
    let mut lighting = Lighting::default();
    let without = binned_frame(&lighting, &quality, &camera, (640, 360));
    lighting.reflection_probes = vec![ReflectionProbe::new([-6.0, 0.0, 7.8], [6.0, 3.6, 15.8])];
    lighting.irradiance_volumes =
        vec![IrradianceVolume::new([-2.0, 0.0, 1.0], [2.0, 3.0, 4.0]), IrradianceVolume::new([f32::NAN, 0.0, 0.0], [1.0; 3]), IrradianceVolume::new([-6.0, 0.0, 20.0], [6.0, 3.6, 30.0])];
    let with = binned_frame(&lighting, &quality, &camera, (640, 360));
    assert_eq!((with.reflection_probes.len(), with.irradiance_volumes.len()), (1, 2), "the volume that is not a number is dropped");
    assert_eq!(with.bins.probes, [1, 0, 2], "nearest first: the small volume, the room's probe, the far volume");
    assert_eq!(with.bins.params.ranges[2] - with.bins.params.ranges[1], 3, "a probe and two volumes after the lights and decals");
    assert_eq!((with.lights, with.ext), (without.lights, without.ext), "the light tables are the same");
    assert_eq!(held_volumes(&lighting.irradiance_volumes), with.irradiance_volumes);
}

#[test]
fn the_budget_registers_the_volumes_the_renderer_holds() {
    use genex_render::budget::{BudgetInput, BudgetKind, BudgetLedger, IRRADIANCE_VOLUMES_LABEL, ledger};
    use genex_render::settings::SceneFormat;
    let quality = preset_quality(QualityPreset::High, DeviceClass::ALL[0]);
    let input = BudgetInput::new((1920, 1080), 1.0, SceneFormat::Rgba16Float, false);
    let bytes = |input: &BudgetInput| ledger(&quality, input).entries().iter().filter(|entry| entry.label == IRRADIANCE_VOLUMES_LABEL).map(|entry| (entry.kind, entry.bytes)).collect::<Vec<_>>();
    assert!(bytes(&input).is_empty(), "no volume held: no entry");
    let held_bytes = genex_render::irradiance::volume_bytes(&[IrradianceVolume::new([0.0; 3], [8.0, 3.0, 8.0])]);
    let mut held = BudgetLedger::new();
    held.register(BudgetKind::Ibl, IRRADIANCE_VOLUMES_LABEL, held_bytes);
    assert_eq!(bytes(&input.with_buffers(&held)), [(BudgetKind::Ibl, held_bytes)], "the renderer's held volumes reach the ledger");
}

fn parse(name: &str, source: &str) -> naga::Module {
    naga::front::wgsl::parse_str(source).unwrap_or_else(|error| panic!("{name}: {}", error.emit_to_string(source)))
}

/// WebGPU core's shader capabilities as naga names them (cube arrays are core).
const WEBGPU_CORE: Capabilities = Capabilities::CUBE_ARRAY_TEXTURES;

fn validated(name: &str, module: &naga::Module) -> ModuleInfo {
    Validator::new(ValidationFlags::all(), WEBGPU_CORE).validate(module).unwrap_or_else(|error| panic!("{name} needs more than WebGPU core: {error:?}"))
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
fn the_forward_shader_reads_the_atlas_within_the_forward_stage_budget() {
    let source = genex_render::shaders::FORWARD;
    let module = parse("forward", source);
    let info = validated("forward", &module);
    let atlas = module.global_variables.iter().find(|(_, global)| global.name.as_deref() == Some("env_irradiance")).expect("env_irradiance").1;
    assert_eq!(atlas.binding.as_ref().map(|binding| (binding.group, binding.binding)), Some((0, 32)));
    assert!(matches!(module.types[atlas.ty].inner, naga::TypeInner::Image { dim: naga::ImageDimension::D3, arrayed: false, .. }), "a 3D texture");
    assert_eq!(genex_render::irradiance::FRAME_IRRADIANCE_BINDINGS, [(32, "env_irradiance")]);
    let (storage, textures) = fragment_counts(&module, &info, "fs_main");
    assert_eq!(storage, 6, "the volumes' rows share the probes' table: {storage} of 8");
    // The look pass's screen reflections (B.9, binding 30) are the 16th, after the atlas.
    assert_eq!(textures, 16, "the atlas is one of the forward stage's 16 sampled textures");
    assert!(textures <= genex_render::abi::FORWARD_FRAGMENT_TEXTURES_MAX && genex_render::abi::FORWARD_FRAGMENT_TEXTURES_MAX <= 16);
    // A capture compiles the volumes out with the probes.
    let constants: naga::back::PipelineConstants = [("GX_PROBES".to_owned(), 0.0)].into_iter().collect();
    naga::back::pipeline_constants::process_overrides(&module, &info, None, &constants).expect("GX_PROBES overrides");
    // The v2 prelude answers the same accessor with the sky's cube and SH9.
    let v2 = parse("v2", &format!("{}\n@fragment fn fs_material(in: GxMaterialInV2) -> @location(0) vec4<f32> {{ return in.tint; }}", genex_render::shaders::MATERIAL_V2_PRELUDE));
    assert!(v2.functions.iter().any(|(_, function)| function.name.as_deref() == Some("gx_env_light")));
    assert!(!v2.global_variables.iter().any(|(_, global)| global.name.as_deref() == Some("env_irradiance")), "v2 materials bind no atlas");
}

#[test]
fn the_reduce_validates_against_webgpu_core_and_the_layout_entry_is_a_3d_texture() {
    let module = parse("irradiance passes", genex_render::irradiance::IRRADIANCE_PASSES);
    validated("irradiance passes", &module);
    let entry = module.entry_points.iter().find(|point| point.name == genex_render::irradiance::REDUCE_ENTRY).expect("reduce entry");
    assert_eq!(entry.workgroup_size, [64, 1, 1]);
    let workgroup: u32 = module
        .global_variables
        .iter()
        .filter(|(_, global)| global.space == naga::AddressSpace::WorkGroup)
        .map(|(_, global)| module.types[global.ty].inner.size(module.to_ctx()))
        .sum();
    assert!(workgroup <= 16 * 1024, "{workgroup} bytes of workgroup memory");
    let entry = genex_render::probes::frame_env_entry(32, "env_irradiance").expect("an entry");
    assert!(matches!(entry.ty, wgpu::BindingType::Texture { view_dimension: wgpu::TextureViewDimension::D3, sample_type: wgpu::TextureSampleType::Float { filterable: true }, .. }));
    assert_eq!(entry.visibility, wgpu::ShaderStages::FRAGMENT);
}

// --- GPU rows: the renderer with the bake (graph node 11) and the forward lookup ---

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

/// A flat grey sky map (the reduce's uncovered texels read it).
fn grey_sky() -> genex_render::hdri::HdriImage {
    let (width, height) = (64, 32);
    let texel = [f16_bits(0.5), f16_bits(0.5), f16_bits(0.5), f16_bits(1.0)];
    genex_render::hdri::HdriImage { width, height, texels: vec![texel; (width * height) as usize] }
}

/// Every texel of the 3D `texture` (rgba16float), x fastest, then y, then z.
fn read_volume(gpu: &Gpu, texture: &wgpu::Texture) -> Vec<[f32; 4]> {
    let (width, height, depth) = (texture.width(), texture.height(), texture.depth_or_array_layers());
    let row = width * 8;
    let padded = row.div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT) * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
    let staging = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("irradiance readback"),
        size: u64::from(padded * height * depth),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("irradiance readback") });
    encoder.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo { texture, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
        wgpu::TexelCopyBufferInfo { buffer: &staging, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(padded), rows_per_image: Some(height) } },
        texture.size(),
    );
    gpu.queue.submit([encoder.finish()]);
    staging.slice(..).map_async(wgpu::MapMode::Read, |result| result.expect("mapped"));
    let _ = gpu.device.poll(wgpu::PollType::wait_indefinitely());
    let data = staging.slice(..).get_mapped_range().expect("mapped range").to_vec();
    staging.unmap();
    (0..(height * depth) as usize)
        .flat_map(|line| {
            let start = line * padded as usize;
            data[start..start + row as usize].as_chunks::<8>().0.iter().map(|texel| [0, 1, 2, 3].map(|c| f16_value(u16::from_le_bytes([texel[2 * c], texel[2 * c + 1]])))).collect::<Vec<_>>()
        })
        .collect()
}

/// The colour and axis distance a test cell's face `face` is cleared to (the -y face is open to
/// the sky: no distance).
fn test_face(face: u32) -> ([f32; 3], Option<f32>) {
    let colours = [[1.0, 0.2, 0.1], [0.1, 0.9, 0.2], [0.3, 0.3, 1.2], [0.8, 0.8, 0.1], [0.05, 0.6, 0.7]];
    match face {
        3 => ([0.5; 3], None),
        _ => (colours[face.min(4) as usize], Some(0.4 + 0.3 * face as f32)),
    }
}

#[test]
#[ignore = "real GPU: run with --ignored metal"]
fn metal_the_reduce_bakes_a_cell_as_its_cpu_twin_and_publishes_it_whole() {
    use genex_render::graph::FrameEncoder;
    use genex_render::ibl::{BakeRequest, EnvironmentMaps};
    use genex_render::irradiance::{CAPTURE_SIDE, GridPrep, ambient_cube_of, atlas_texel, capture_depth_terms};
    use genex_render::settings::{HdriEnvironment, HdriSun};
    let Some(gpu) = gpu() else { return };
    let mut maps = EnvironmentMaps::new(&gpu.device, &gpu.queue);
    maps.set_map(&gpu.device, &gpu.queue, &grey_sky()).expect("map");
    let environment = Environment::Hdri(HdriEnvironment::new("env/irradiance-test.hdr").with_sun(HdriSun::Off));
    maps.set_environment(&environment);
    let mut quality = Quality::off().environment;
    quality.ibl = true;
    quality.cube_size = 64;
    quality.irradiance_volumes = 2;
    quality.irradiance_leak_control = true;
    // Two volumes: the second, one cell, is the one checked; the first moves its block along x.
    let volumes = [IrradianceVolume::new([10.0, 0.0, 0.0], [12.0, 1.0, 1.0]).with_cells([2, 1, 1]), IrradianceVolume::new([0.0; 3], [2.0, 2.0, 2.0]).with_cells([1, 1, 1])];
    let mut encoder = FrameEncoder::new(&gpu.device, &gpu.queue, "irradiance test frame");
    let request = BakeRequest { environment: &environment, quality: &quality, frame_index: 0, settle: true, sun_dir: [0.0, 1.0, 0.0], sun_color: [1.0; 3] };
    maps.bake(&mut encoder, &request, None);
    let reversed = true;
    let work = maps.prepare_irradiance(&gpu.device, &GridPrep { declared: &volumes, quality: &quality, lit_by: None, frame_index: 0, settle: true });
    assert_eq!(work.iter().map(|batch| (batch.slot, batch.cells.len(), batch.publish)).collect::<Vec<_>>(), [(0, 2, true), (1, 1, true)]);
    for batch in &work {
        let volume = volumes[batch.slot];
        let (z_scale, z_offset) = capture_depth_terms(&volume.capture_probe([0; 3]), reversed);
        for (index, cell) in batch.cells.iter().enumerate() {
            for face in 0..6 {
                let views = maps.irradiance().cell_face(batch.slot, index, *cell, face).expect("a face");
                let (colour, distance) = test_face(face);
                let depth = distance.map_or(0.0, |d| z_offset / d - z_scale);
                let [r, g, b] = colour.map(f64::from);
                let pass = encoder.encoder().begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("irradiance test face"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: &views.color,
                        depth_slice: None,
                        resolve_target: None,
                        ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color { r, g, b, a: 1.0 }), store: wgpu::StoreOp::Store },
                    })],
                    depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                        view: &views.depth,
                        depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(depth), store: wgpu::StoreOp::Store }),
                        stencil_ops: None,
                    }),
                    timestamp_writes: None,
                    occlusion_query_set: None,
                    multiview_mask: None,
                });
                drop(pass);
            }
        }
        maps.encode_irradiance_batch(&mut encoder, batch, reversed);
        encoder.submit();
    }
    let _ = gpu.device.poll(wgpu::PollType::wait_indefinitely());
    let layout = maps.irradiance().layout().clone();
    assert_eq!(layout.origins, [0, 2]);
    let atlas = read_volume(&gpu, maps.irradiance().atlas().expect("an atlas"));
    let [width, height, _] = layout.extent;
    let volume = volumes[1];
    // What the cell sees: each face's colour at its plane's distance, the -y face the grey sky.
    let sees = |dir: [f32; 3]| {
        let axis = (0..3).max_by(|a, b| dir[*a].abs().total_cmp(&dir[*b].abs())).unwrap_or(0);
        let face = 2 * axis as u32 + u32::from(dir[axis] < 0.0);
        let (colour, distance) = test_face(face);
        (colour, distance.map(|d| d / dir[axis].abs()))
    };
    let want = ambient_cube_of(&sees, CAPTURE_SIDE, volume.reach_max());
    for (face, expected) in want.iter().enumerate() {
        let [x, y, z] = atlas_texel(layout.origins[1], volume.cells, [0, 0, 0], face);
        let got = atlas[(x + y * width + z * width * height) as usize];
        for (c, (gpu_value, cpu_value)) in got.iter().zip(expected).take(3).enumerate() {
            let tolerance = 0.01 * cpu_value.abs().max(0.05);
            assert!((gpu_value - cpu_value).abs() <= tolerance, "face {face} channel {c}: GPU {got:?} vs CPU {expected:?}");
        }
        // The packed reaches: each code within one step of the CPU's (log2 and rounding differ).
        let codes = |packed: f32| [packed as u32 >> genex_render::irradiance::REACH_BITS, packed as u32 & genex_render::irradiance::REACH_CODE_MAX];
        for (gpu_code, cpu_code) in codes(got[3]).into_iter().zip(codes(expected[3])) {
            assert!(gpu_code.abs_diff(cpu_code) <= 1, "face {face}: reach codes GPU {:?} vs CPU {:?}", codes(got[3]), codes(expected[3]));
        }
    }
    let rows = maps.irradiance().rows();
    assert_eq!(rows.len(), 2);
    assert_eq!(genex_render::irradiance::row_origin(&rows[1]), Some(2), "published at its block");
}

/// Whether the renderer bakes and shades volumes in this build.
fn volumes_landed() -> bool {
    if !genex_render::irradiance::LANDED {
        eprintln!("skipped: irradiance::LANDED is false, so the renderer bakes no volume in this build");
    }
    genex_render::irradiance::LANDED
}

/// The HDR scene with desktop `high`'s environment (8 volumes, leak control; `leak_control`
/// overrides it), binned lights and sun shadows, every other effect off.
fn grid_quality(leak_control: bool) -> Quality {
    let class = DeviceClass::from_wire("desktop-high").expect("class");
    let high = preset_quality(QualityPreset::High, class);
    let mut quality = Quality::off();
    quality.hdr = true;
    quality.tonemap = true;
    quality.exposure = true;
    quality.environment = high.environment;
    quality.environment.irradiance_leak_control = leak_control;
    quality.lights = high.lights;
    quality.shadows = high.shadows;
    quality
}

fn grid_renderer(gpu: &Gpu, (width, height): (u32, u32), leak_control: bool) -> genex_render::Renderer {
    let mut renderer = genex_render::Renderer::with_options(gpu, width, height, genex_render::RenderOptions { msaa: false }).expect("renderer");
    renderer.set_scene_format(genex_render::settings::SceneFormat::Rgba16Float);
    renderer.set_quality(&grid_quality(leak_control));
    renderer.set_environment(&Environment::sky());
    renderer
}

/// The linear HDR scene of a settled frame of `scene`: the environment and the volumes baked whole
/// on its first re-render, `frames` re-renders in all.
fn settled(renderer: &mut genex_render::Renderer, gpu: &Gpu, scene: &genex_render::scene::Scene, frames: u32) -> Vec<[f32; 4]> {
    renderer.set_environment_settle(true);
    for _ in 0..frames {
        renderer.render(gpu, scene, genex_render::CullPath::Gpu).expect("frame");
    }
    renderer.set_environment_settle(false);
    renderer.read_scene(gpu).expect("the HDR scene reads back")
}

/// Write `texels` (linear rgb) as a Reinhard-tonemapped `.ppm` named `name` under
/// `GENEX_IRRADIANCE_EVIDENCE_DIR`, when it is set.
fn write_evidence(name: &str, (width, height): (u32, u32), texels: &[[f32; 4]]) {
    let Ok(folder) = std::env::var("GENEX_IRRADIANCE_EVIDENCE_DIR") else { return };
    let encode = |value: f32| {
        let mapped = value.max(0.0) * 4.0 / (1.0 + value.max(0.0) * 4.0);
        (libm::powf(mapped, 1.0 / 2.2) * 255.0).round() as u8
    };
    let mut bytes = format!("P6\n{width} {height}\n255\n").into_bytes();
    bytes.extend(texels.iter().flat_map(|texel| [texel[0], texel[1], texel[2]].map(encode)));
    std::fs::create_dir_all(&folder).expect("evidence folder");
    std::fs::write(std::path::Path::new(&folder).join(format!("{name}.ppm")), bytes).expect("evidence written");
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

/// A grid of points over the floor rectangle `x` by `z` at height `y`.
fn floor_points(x: (f32, f32), z: (f32, f32), y: f32) -> Vec<[f32; 3]> {
    let steps = 12;
    (0..steps).flat_map(|i| (0..steps).map(move |j| (i, j))).map(|(i, j)| [x.0 + (x.1 - x.0) * (i as f32 + 0.5) / steps as f32, y, z.0 + (z.1 - z.0) * (j as f32 + 0.5) / steps as f32]).collect()
}

/// Chroma of linear `rgb`: its spread over its largest channel (0 for a grey).
fn chroma(rgb: [f32; 3]) -> f32 {
    let (max, min) = (rgb.iter().copied().fold(f32::MIN, f32::max), rgb.iter().copied().fold(f32::MAX, f32::min));
    (max - min) / max.max(1e-6)
}

fn red_share(rgb: [f32; 3]) -> f32 {
    rgb[0] / (rgb[0] + rgb[1] + rgb[2]).max(1e-6)
}

fn luminance(rgb: [f32; 3]) -> f32 {
    0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
}

/// A white floor beside a sunlit red wall (its face at x = 0, facing +x), under the sky; with
/// `volume`, the space in front of the wall is an irradiance volume.
fn red_wall_scene(volume: bool) -> genex_render::scene::Scene {
    use genex_render::scene::{Material, MeshId, Scene, scaled};
    let mut scene = Scene::new(red_wall_camera(), [0, 0, 0, 255]);
    scene.lighting.sun_dir = [0.7, 0.6, 0.25];
    scene.lighting.sun_intensity = 3.0;
    scene.lighting.ambient_intensity = 0.0;
    scene.draw(MeshId::CUBE, scaled([2.0, -0.05, 0.0], [12.0, 0.1, 12.0]), Material::color([225, 225, 225, 255]).with_pbr(0.0, 0.9));
    scene.draw(MeshId::CUBE, scaled([-0.1, 1.5, 0.0], [0.2, 3.0, 6.0]), Material::color([210, 25, 25, 255]).with_pbr(0.0, 0.8));
    if volume {
        scene.lighting.irradiance_volumes.push(IrradianceVolume::new([0.0, 0.0, -3.0], [4.0, 3.0, 3.0]).with_blend(0.5));
    }
    scene
}

fn red_wall_camera() -> CameraDesc {
    CameraDesc::look_at([4.0, 2.4, 3.6], [0.6, 0.0, 0.0])
}

/// The floor patch beside the wall the bleed row measures.
fn beside_the_wall() -> Vec<[f32; 3]> {
    floor_points((0.15, 0.7), (-0.8, 0.8), 0.0)
}

/// Plan A.4's acceptance: the white floor beside the red wall takes at least twice the chroma it
/// has under the sky's SH9 alone.
const BLEED_RATIO_MIN: f32 = 2.0;

#[test]
#[ignore = "real GPU: run with --ignored metal"]
fn metal_a_white_floor_beside_a_sunlit_red_wall_takes_its_colour() {
    let Some(gpu) = gpu() else { return };
    if !volumes_landed() {
        return;
    }
    let size = (480, 270);
    let mut results = Vec::new();
    for volume in [false, true] {
        let mut renderer = grid_renderer(&gpu, size, true);
        let texels = settled(&mut renderer, &gpu, &red_wall_scene(volume), 3);
        write_evidence(&format!("red-wall-volume-{volume}"), size, &texels);
        let floor = mean_at(&texels, size, &red_wall_camera(), &beside_the_wall());
        eprintln!("volume {volume}: floor beside the wall {floor:?}, chroma {:.4}, red share {:.4}", chroma(floor), red_share(floor));
        results.push(floor);
    }
    let [sky, grid] = [results[0], results[1]];
    let ratio = chroma(grid) / chroma(sky).max(1e-6);
    let row = format!("{{\"row\":\"irradiance-red-wall-bleed\",\"adapter\":\"{}\",\"skyChroma\":{:.5},\"gridChroma\":{:.5},\"ratio\":{ratio:.3}}}", gpu.receipt().adapter, chroma(sky), chroma(grid));
    println!("{row}");
    assert!(red_share(grid) > red_share(sky), "the floor turns toward the wall's red: {sky:?} -> {grid:?}");
    assert!(ratio >= BLEED_RATIO_MIN, "the floor's chroma beside the wall is {ratio:.2}x the SH9's (at least {BLEED_RATIO_MIN}x)");
}

/// A closed room (20 cm walls, a ceiling, lit inside by a lamp) beside a sunlit white yard; the
/// camera inside looks at the east wall's inner face and the floor along it. With `across`, the
/// volume spans the room and the yard across the east wall (x 0..0.2); without, the same cells
/// cover the room alone (the reference: no cell outside can lend the room light).
fn room_beside_a_yard(across: bool) -> genex_render::scene::Scene {
    use genex_render::scene::{Material, MeshId, Scene, scaled};
    let mut scene = Scene::new(room_camera(), [0, 0, 0, 255]);
    scene.lighting.sun_dir = [0.6, 0.7, 0.3];
    scene.lighting.sun_intensity = 4.0;
    scene.lighting.ambient_intensity = 0.0;
    scene.lighting.points.push(genex_render::lights::PointLight { position: [-1.5, 2.0, 0.0], range: 6.0, color: [255, 240, 220], intensity: 4.0 });
    let white = Material::color([200, 200, 200, 255]).with_pbr(0.0, 0.85);
    // The room: x -3.2..0.2, z -2.2..2.2, 2.5 high inside, walls and ceiling 0.2 thick.
    scene.draw(MeshId::CUBE, scaled([-1.5, -0.05, 0.0], [3.4, 0.1, 4.4]), white);
    scene.draw(MeshId::CUBE, scaled([-1.5, 2.6, 0.0], [3.4, 0.2, 4.4]), white);
    scene.draw(MeshId::CUBE, scaled([0.1, 1.25, 0.0], [0.2, 2.5, 4.4]), white);
    scene.draw(MeshId::CUBE, scaled([-3.1, 1.25, 0.0], [0.2, 2.5, 4.4]), white);
    scene.draw(MeshId::CUBE, scaled([-1.5, 1.25, -2.1], [3.4, 2.5, 0.2]), white);
    scene.draw(MeshId::CUBE, scaled([-1.5, 1.25, 2.1], [3.4, 2.5, 0.2]), white);
    // The yard east of the room, in the sun.
    scene.draw(MeshId::CUBE, scaled([3.6, -0.05, 0.0], [6.8, 0.1, 8.0]), Material::color([240, 240, 240, 255]).with_pbr(0.0, 0.9));
    // One-metre cells either way: the room's cells (centres at x -2.5, -1.5, -0.5) are the same.
    let volume = if across {
        IrradianceVolume::new([-3.0, 0.0, -2.0], [3.0, 2.5, 2.0]).with_cells([6, 3, 4])
    } else {
        IrradianceVolume::new([-3.0, 0.0, -2.0], [0.0, 2.5, 2.0]).with_cells([3, 3, 4])
    };
    scene.lighting.irradiance_volumes.push(volume.with_blend(0.3));
    scene
}

fn room_camera() -> CameraDesc {
    CameraDesc::look_at([-2.6, 1.4, 0.0], [0.0, 0.5, 0.0])
}

/// Where the leak row looks: the east wall's inner face and the floor along it.
fn along_the_wall() -> (Vec<[f32; 3]>, Vec<[f32; 3]>) {
    let wall: Vec<[f32; 3]> = (0..12).flat_map(|i| (0..12).map(move |j| (i, j))).map(|(i, j)| [-0.001, 0.15 + 1.6 * (i as f32 + 0.5) / 12.0, -1.0 + 2.0 * (j as f32 + 0.5) / 12.0]).collect();
    (wall, floor_points((-0.6, -0.05), (-1.0, 1.0), 0.0))
}

/// Plan A.4's leak row: a volume reaching across the room's 20 cm east wall into the sunlit yard
/// may light the wall's inner face and the floor along it by at most this share more than the
/// same cells covering the room alone.
const LEAK_MAX: f32 = 0.01;

#[test]
#[ignore = "real GPU: run with --ignored metal"]
fn metal_no_light_leaks_through_a_20_cm_wall() {
    // Red first: without leak control (the sampler's trilinear fetches, as phones read a volume)
    // the cells in the sunny yard light the room's side of the wall.
    let Some(gpu) = gpu() else { return };
    if !volumes_landed() {
        return;
    }
    let size = (480, 270);
    let camera = room_camera();
    let (wall_points, floor_points) = along_the_wall();
    let mut rows = Vec::new();
    for leak_control in [false, true] {
        let mut shown = Vec::new();
        for across in [false, true] {
            let mut renderer = grid_renderer(&gpu, size, leak_control);
            let texels = settled(&mut renderer, &gpu, &room_beside_a_yard(across), 3);
            write_evidence(&format!("room-leak-control-{leak_control}-across-{across}"), size, &texels);
            shown.push((luminance(mean_at(&texels, size, &camera, &wall_points)), luminance(mean_at(&texels, size, &camera, &floor_points))));
        }
        let (wall, floor) = ((shown[1].0 - shown[0].0) / shown[0].0.max(1e-6), (shown[1].1 - shown[0].1) / shown[0].1.max(1e-6));
        eprintln!("leak control {leak_control}: reaching into the yard moves the room's wall by {:+.3}% and its floor by {:+.3}% (room only, across: {shown:?})", 100.0 * wall, 100.0 * floor);
        rows.push((wall, floor));
    }
    let [(leaky_wall, leaky_floor), (wall, floor)] = [rows[0], rows[1]];
    let row = format!("{{\"row\":\"irradiance-20cm-wall-leak\",\"adapter\":\"{}\",\"trilinearWall\":{leaky_wall:.5},\"trilinearFloor\":{leaky_floor:.5},\"wall\":{wall:.5},\"floor\":{floor:.5}}}", gpu.receipt().adapter);
    println!("{row}");
    assert!(wall.abs() <= LEAK_MAX && floor.abs() <= LEAK_MAX, "the yard's light leaks through the wall: wall {:+.3}%, floor {:+.3}% (at most {}%)", 100.0 * wall, 100.0 * floor, 100.0 * LEAK_MAX);
}

#[test]
#[ignore = "real GPU: run with --ignored metal"]
fn metal_a_settled_capture_bakes_the_same_after_live_frames() {
    // A settled capture bakes whatever differs whole, so it is the same picture after Live frames
    // that baked the volume a slice at a time (and moved the sun midway) as on a fresh renderer.
    let Some(gpu) = gpu() else { return };
    if !volumes_landed() {
        return;
    }
    let size = (320, 180);
    let scene = red_wall_scene(true);
    let mut fresh = grid_renderer(&gpu, size, true);
    let cold = settled(&mut fresh, &gpu, &scene, 3);
    let mut live = grid_renderer(&gpu, size, true);
    let mut turning = scene.clone();
    for frame in 0..40u64 {
        turning.lighting.sun_dir = if frame < 20 { [0.5, 0.7, 0.25] } else { scene.lighting.sun_dir };
        live.set_frame_index(frame);
        live.render(&gpu, &turning, genex_render::CullPath::Gpu).expect("frame");
    }
    let after = settled(&mut live, &gpu, &scene, 3);
    let largest = cold.iter().zip(&after).flat_map(|(a, b)| (0..3).map(move |c| (a[c] - b[c]).abs())).fold(0.0_f32, f32::max);
    assert!(largest == 0.0, "a settled capture after Live frames differs by up to {largest}");
}

#[test]
#[ignore = "real GPU: run with --ignored metal"]
fn metal_the_renderer_s_ledger_holds_the_volumes_it_bakes() {
    use genex_render::budget::{BudgetKind, IRRADIANCE_VOLUMES_LABEL};
    let Some(gpu) = gpu() else { return };
    if !volumes_landed() {
        return;
    }
    let mut renderer = grid_renderer(&gpu, (320, 180), true);
    let held = |renderer: &genex_render::Renderer| renderer.buffer_ledger().entries().iter().filter(|entry| entry.label == IRRADIANCE_VOLUMES_LABEL).map(|entry| (entry.kind, entry.bytes)).collect::<Vec<_>>();
    settled(&mut renderer, &gpu, &red_wall_scene(false), 1);
    assert!(held(&renderer).is_empty(), "no volume: no entry");
    settled(&mut renderer, &gpu, &red_wall_scene(true), 1);
    let volume = red_wall_scene(true).lighting.irradiance_volumes[0];
    let bytes = genex_render::irradiance::volume_bytes(&[volume.held().expect("held")]);
    let entries = held(&renderer);
    assert_eq!(entries.len(), 1, "{entries:?}");
    // The atlas, the staging block and the bake's targets, and the capture's per-face rows.
    assert!(entries[0].0 == BudgetKind::Ibl && entries[0].1 >= bytes, "{entries:?} vs {bytes}");
    settled(&mut renderer, &gpu, &red_wall_scene(false), 1);
    assert!(held(&renderer).is_empty(), "released with the volume");
}

/// The volumes' shading budget at 1080p (plan A.4): added GPU frame time, ms.
const SHADING_BUDGET_MS: f32 = 0.2;
/// A time-sliced bake's budget (plan A.4): added GPU frame time per frame, ms.
const BAKE_BUDGET_MS: f32 = 0.5;
/// Interleaved timing rounds of the shading row (the first warms up and is dropped).
const PERF_ROUNDS: u32 = 12;

fn median(values: &mut [f32]) -> f32 {
    values.sort_by(f32::total_cmp);
    values[values.len() / 2]
}

/// GPU frame times of `frames` frames of `scene`, starting at frame index `first`.
fn timed_frames(gpu: &Gpu, renderer: &mut genex_render::Renderer, scene: &genex_render::scene::Scene, first: u64, frames: u64) -> Option<Vec<f32>> {
    let mut times = Vec::new();
    for frame in first..first + frames + 8 {
        times.extend(renderer.arm_frame_timer(&gpu.queue)?);
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
fn metal_volume_shading_and_the_bake_slice_stay_within_their_budgets_at_1080p() {
    // Plan A.4: sampling at most +0.2 ms (the volume over the red-wall scene, leak control on,
    // against none; interleaved rounds, the median of the rounds' paired differences), the bake
    // at most 0.5 ms a frame (a cold volume baked a slice a frame against the same scene once it
    // is baked).
    let Some(gpu) = gpu() else { return };
    if !volumes_landed() {
        return;
    }
    let size = (1920, 1080);
    // None, the volume read in three trilinear fetches (phones), the volume with leak control.
    let scenes = [red_wall_scene(false), red_wall_scene(true), red_wall_scene(true)];
    let mut renderers = [grid_renderer(&gpu, size, true), grid_renderer(&gpu, size, false), grid_renderer(&gpu, size, true)];
    for (renderer, scene) in renderers.iter_mut().zip(&scenes) {
        settled(renderer, &gpu, scene, 3);
    }
    let mut deltas = Vec::new();
    let mut trilinear = Vec::new();
    for round in 0..PERF_ROUNDS {
        let mut medians = [0.0_f32; 3];
        for ((renderer, scene), held) in renderers.iter_mut().zip(&scenes).zip(&mut medians) {
            let Some(mut times) = timed_frames(&gpu, renderer, scene, 1000 + u64::from(round) * 100, 60) else {
                eprintln!("skipped: no timestamp queries");
                return;
            };
            *held = median(&mut times[8..]);
        }
        if round > 0 {
            deltas.push(medians[2] - medians[0]);
            trilinear.push(medians[1] - medians[0]);
        }
    }
    let trilinear = median(&mut trilinear);
    let shading = median(&mut deltas);
    // The bake: a fresh renderer's first frames bake the volume a slice each (96 cells, 2 a frame);
    // the same renderer's frames after it is baked are the idle reference.
    let mut bake_extra = Vec::new();
    for _ in 0..4 {
        let mut renderer = grid_renderer(&gpu, size, true);
        let Some(times) = timed_frames(&gpu, &mut renderer, &scenes[1], 0, 140) else { return };
        let mut idle: Vec<f32> = times[100..140].to_vec();
        let idle = median(&mut idle);
        bake_extra.extend(times[8..40].iter().map(|time| time - idle));
    }
    let bake = median(&mut bake_extra.clone());
    bake_extra.sort_by(f32::total_cmp);
    let row = format!(
        "{{\"row\":\"irradiance-1080p\",\"adapter\":\"{}\",\"shadingAddedMedianMs\":{shading:.4},\"trilinearShadingAddedMedianMs\":{trilinear:.4},\"bakeSliceAddedMedianMs\":{bake:.4},\"bakeSliceAddedP90Ms\":{:.4}}}",
        gpu.receipt().adapter,
        bake_extra[bake_extra.len() * 9 / 10]
    );
    println!("{row}");
    if let Ok(path) = std::env::var("GENEX_PERF_OUT") {
        std::fs::write(path, format!("{row}\n")).expect("perf row");
    }
    assert!(shading <= SHADING_BUDGET_MS, "volume shading adds {shading:.3} ms");
    assert!(bake <= BAKE_BUDGET_MS, "a bake slice adds {bake:.3} ms");
}
