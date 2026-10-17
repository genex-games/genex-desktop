//! Grass on the terrain (renderer pass 2 A.8, `genex_render::foliage`). CPU rows hold the
//! generation's CPU twin to the guarantees the draws rely on: a blade is a pure function of its
//! global cell (the field never swims), a moving camera grows and sinks blades instead of popping
//! them, the meadow follows the control map's grassy layers at their density, and each preset's
//! quality. Shader rows validate the grass modules against WebGPU core and hold their bindings.
//! Real-GPU rows (`#[ignore]`d, every name contains `metal`) draw grass through the renderer:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --release --offline --locked --test grass -- --ignored metal
//!
//! With `GENEX_RENDER_EVIDENCE_DIR` the look rows write their captures there; with
//! `GENEX_PERF_OUT` (a file) the cost row writes its JSON lines there.

use genex_render::foliage::gpu::{GRASS, GRASS_GEN, GRASS_SHADOW, GpuGrass, gen_layout_entries, layout_entries};
use genex_render::foliage::{Blade, GRASS_FADE_BAND, GRASS_HEIGHT_MAX, GrassField, GrassLayer, GrassQuality, plan};
use genex_render::terrain::{ControlTexel, Heightfield, TerrainDesc, TerrainLayer};
use genex_render::{RenderCode, RenderError};

/// The meadow every row grows: lush grass, dry grass and bare rock.
fn lush() -> GrassLayer {
    GrassLayer { flower_share: 0.03, ..GrassLayer::meadow(36.0, 0.5) }
}

fn dry() -> GrassLayer {
    GrassLayer { dry_share: 0.7, tip: [0.2, 0.17, 0.06], ..GrassLayer::meadow(20.0, 0.7) }
}

/// Gentle hills (`samples` a side `spacing` apart): lush grass west of x = 10, dry grass from there
/// to x = 25 blended over two metres, bare rock east of x = 25 (layers 0, 1, 2).
fn meadow_desc(samples: u32, spacing: f32, layers: [TerrainLayer; 3]) -> TerrainDesc {
    let half = (samples - 1) as f32 * spacing * 0.5;
    let heights = Heightfield::from_fn((samples, samples), [-half, -half], spacing, |x, z| 2.0 * libm::sinf(x * 0.05) * libm::cosf(z * 0.07) + 0.6 * libm::sinf(x * 0.21 + z * 0.17))
        .expect("heights");
    let mut control = Vec::with_capacity((samples * samples) as usize);
    for j in 0..samples {
        for i in 0..samples {
            let x = -half + i as f32 * spacing;
            let _ = j;
            let texel = if x > 25.0 {
                ControlTexel::layer(2)
            } else {
                let dry = ((x - 9.0) / 2.0).clamp(0.0, 1.0);
                ControlTexel::blend(0, 1, (dry * 255.0) as u8)
            };
            control.push(texel);
        }
    }
    TerrainDesc { heights, control, layers: layers.to_vec(), look: genex_render::terrain::TerrainLook::default() }
}

fn flat_layers() -> [TerrainLayer; 3] {
    [
        TerrainLayer::flat([0.10, 0.16, 0.05]).with_grass(lush()),
        TerrainLayer::flat([0.25, 0.21, 0.10]).with_grass(dry()),
        TerrainLayer::flat([0.40, 0.39, 0.37]),
    ]
}

/// Planes that keep everything (no frustum).
const OPEN: [[f32; 4]; 6] = [[0.0, 0.0, 0.0, 1.0]; 6];

fn refused_code(result: Result<(), RenderError>) -> RenderCode {
    result.expect_err("refused").code()
}

// --- The generation's CPU twin ---

#[test]
fn a_blade_is_a_pure_function_of_its_cell_wherever_the_camera_is() {
    let desc = meadow_desc(129, 0.5, flat_layers());
    let field = GrassField::new(&desc);
    let quality = GrassQuality::HIGH;
    let grid = genex_render::foliage::grid(genex_render::foliage::densest(&desc), &quality, [0.0, 2.0, 0.0]);
    let (mut same, mut kept) = (0, 0);
    for z in -40..40 {
        for x in -40..40 {
            let a = field.blade(&grid, &quality, [0.0, 2.0, 0.0], (x, z));
            let b = field.blade(&grid, &quality, [1.3, 2.0, -0.7], (x, z));
            if let (Some(a), Some(b)) = (a, b) {
                kept += 1;
                let shape = |blade: Blade| (blade.root.map(f32::to_bits), blade.yaw, blade.layer, blade.kind);
                same += usize::from(shape(a) == shape(b));
            }
        }
    }
    assert!(kept > 1000, "the near meadow keeps its blades: {kept}");
    assert_eq!(same, kept, "root, yaw, layer and kind do not depend on the camera");
}

#[test]
fn a_dolly_grows_and_sinks_blades_without_a_pop() {
    let desc = meadow_desc(257, 0.5, flat_layers());
    let field = GrassField::new(&desc);
    let quality = GrassQuality::MEDIUM;
    let densest = genex_render::foliage::densest(&desc);
    let mut last: std::collections::BTreeMap<(i32, i32), Blade> = std::collections::BTreeMap::new();
    let (mut appeared, mut vanished, mut worst) = (0, 0, 0u32);
    for k in 0..40 {
        let camera = [-30.0 + k as f32 * 0.12, 3.0, -4.0];
        let grid = genex_render::foliage::grid(densest, &quality, camera);
        let mut now = std::collections::BTreeMap::new();
        // A band of cells along the path, within the radius of every camera on it.
        for z in -80..60 {
            for x in -320..100 {
                if let Some(blade) = field.blade(&grid, &quality, camera, (x, z)) {
                    now.insert((x, z), blade);
                }
            }
        }
        if k > 0 {
            for (cell, blade) in &now {
                match last.get(cell) {
                    None => {
                        appeared += 1;
                        worst = worst.max(blade.grown);
                    }
                    Some(before) => worst = worst.max(blade.grown.abs_diff(before.grown)),
                }
            }
            for (cell, blade) in &last {
                if !now.contains_key(cell) {
                    vanished += 1;
                    worst = worst.max(blade.grown);
                }
            }
        }
        last = now;
    }
    assert!(appeared > 50 && vanished > 50, "the dolly moves the meadow's edge: {appeared} in, {vanished} out");
    // A blade grows in over GRASS_FADE_BAND of its cell's probability: between two frames 12 cm
    // apart the falloff moves by about half a percent, so a blade changes by a few 63ths at most,
    // near the camera and at the radius's end alike, never whole.
    assert!(worst <= 4, "a blade grew or sank by {worst}/63 of its height in one frame");
}

#[test]
fn the_meadow_follows_the_control_map_at_its_layers_density() {
    let desc = meadow_desc(257, 0.5, flat_layers());
    let field = GrassField::new(&desc);
    let quality = GrassQuality::HIGH;
    // A reach of 80 m (the widest that keeps one cell a blade at this density): every counted cell
    // is within the full-density share of it.
    let camera = [12.0, 2.0, 0.0];
    let generated = plan(&field, &GrassQuality { radius: 80.0, ..quality }, camera, &OPEN);
    let count = |x0: f32, x1: f32| generated.blades.iter().filter(|(_, _, blade)| (x0..x1).contains(&blade.root[0]) && blade.root[2].abs() < 10.0).count();
    let area = 4.0 * 20.0;
    let lush_density = count(2.0, 6.0) as f32 / area;
    let dry_density = count(14.0, 18.0) as f32 / area;
    assert!((lush_density / lush().density - 1.0).abs() < 0.12, "lush: {lush_density} blades per m2");
    assert!((dry_density / dry().density - 1.0).abs() < 0.15, "dry: {dry_density} blades per m2");
    assert_eq!(count(26.0, 40.0), 0, "the bare rock grows nothing");
    let layers = |x0: f32, x1: f32| generated.blades.iter().filter(|(_, _, blade)| (x0..x1).contains(&blade.root[0])).map(|(_, _, blade)| blade.layer).collect::<std::collections::BTreeSet<_>>();
    assert_eq!(layers(2.0, 6.0), [0].into(), "the lush meadow's blades are lush");
    assert_eq!(layers(14.0, 18.0), [1].into(), "the dry meadow's are dry");
    assert_eq!(layers(9.2, 10.8), [0, 1].into(), "where they blend, both grow");
    // Every root stands on the ground, sunk under it.
    for (_, _, blade) in generated.blades.iter().step_by(97) {
        let ground = desc.heights.height(blade.root[0], blade.root[2]);
        assert!((ground - genex_render::foliage::GRASS_ROOT_SINK - blade.root[1]).abs() < 1e-4);
        assert!(blade.height as f32 / 4095.0 * GRASS_HEIGHT_MAX <= dry().height[1] + 1e-3);
    }
}

#[test]
fn the_field_thins_with_distance_and_ends_at_the_radius() {
    let desc = meadow_desc(257, 0.5, flat_layers());
    let field = GrassField::new(&desc);
    let quality = GrassQuality::HIGH;
    let camera = [-30.0, 2.5, 0.0];
    let generated = plan(&field, &quality, camera, &OPEN);
    let ring = |r0: f32, r1: f32| {
        let n = generated.blades.iter().filter(|(_, _, b)| {
            let (dx, dz) = (b.root[0] - camera[0], b.root[2] - camera[2]);
            let d = (dx * dx + dz * dz).sqrt();
            (r0..r1).contains(&d) && b.root[0] < 8.0
        });
        n.count() as f32
    };
    let near = ring(2.0, 6.0) / (std::f32::consts::PI * (36.0 - 4.0));
    let far = ring(30.0, 34.0) / (std::f32::consts::PI * (34.0 * 34.0 - 30.0 * 30.0));
    assert!(far < near * 0.6 && far > 0.0, "thinner far away: {near} near, {far} far (per m2, before the lush field's edge)");
    let reach = generated
        .blades
        .iter()
        .map(|(_, _, b)| {
            let (dx, dz) = (b.root[0] - camera[0], b.root[2] - camera[2]);
            (dx * dx + dz * dz).sqrt()
        })
        .fold(0.0, f32::max);
    assert!(reach <= quality.radius + 2.5, "no blade past the radius: {reach}");
}

#[test]
fn each_preset_draws_its_grass() {
    use genex_render::device_class::{DeviceClass, FormFactor, PerformanceTier};
    use genex_render::presets::preset_quality;
    use genex_render::settings::{Quality, QualityPreset};
    let desktop = DeviceClass::new(FormFactor::Desktop, PerformanceTier::High);
    let grass = |preset, class| preset_quality(preset, class).grass;
    assert!(!Quality::off().grass.drawn(), "the legacy renderer draws none");
    assert!(!grass(QualityPreset::Low, desktop).drawn(), "low draws none");
    assert_eq!(grass(QualityPreset::Medium, desktop), GrassQuality::MEDIUM);
    assert_eq!(grass(QualityPreset::High, desktop), GrassQuality::HIGH);
    assert_eq!(grass(QualityPreset::Ultra, desktop), GrassQuality::ULTRA);
    const { assert!(GrassQuality::HIGH.casts && !GrassQuality::MEDIUM.casts) };
    let phone = |tier| DeviceClass::new(FormFactor::Mobile, tier);
    assert_eq!(grass(QualityPreset::High, phone(PerformanceTier::High)), GrassQuality::MOBILE, "the high phone at high: capped");
    assert!(!grass(QualityPreset::Medium, phone(PerformanceTier::High)).drawn(), "phones at medium draw none");
    assert!(!grass(QualityPreset::Ultra, phone(PerformanceTier::Low)).drawn(), "the low phone draws none");
    const { assert!(GrassQuality::MOBILE.density <= 0.35 && GrassQuality::MOBILE.radius < GrassQuality::MEDIUM.radius && !GrassQuality::MOBILE.casts) };
    // A resource knob: the grass never changes a pipeline.
    let high = preset_quality(QualityPreset::High, desktop);
    let mut thinner = high;
    thinner.grass = GrassQuality::MEDIUM;
    assert!(high.resource_change_only(&thinner));
}

#[test]
fn grass_a_terrain_cannot_grow_is_refused_mesh_invalid() {
    let base = || meadow_desc(9, 1.0, flat_layers());
    let with = |grass: GrassLayer| {
        let mut desc = base();
        desc.layers[0] = desc.layers[0].with_grass(grass);
        desc.check()
    };
    let cases: [(&str, GrassLayer); 6] = [
        ("a density that is not a number", GrassLayer { density: f32::NAN, ..lush() }),
        ("a negative density", GrassLayer { density: -1.0, ..lush() }),
        ("a blade taller than the cap", GrassLayer { height: [0.2, GRASS_HEIGHT_MAX + 0.1], ..lush() }),
        ("an upside-down height range", GrassLayer { height: [0.6, 0.2], ..lush() }),
        ("an infinite width", GrassLayer { width: [0.01, f32::INFINITY], ..lush() }),
        ("a share past one", GrassLayer { flower_share: 1.5, ..lush() }),
    ];
    for (case, grass) in cases {
        assert_eq!(refused_code(with(grass)), RenderCode::MeshInvalid, "{case}");
    }
    assert!(with(lush()).is_ok());
    const { assert!(GRASS_FADE_BAND > 0.0 && GRASS_FADE_BAND < 0.5) };
}

// --- Scatter (A4.9) ---

use genex_render::foliage::scatter::{ScatterRule, scatter};

#[test]
fn a_scatter_is_the_same_whichever_area_is_asked_for() {
    let desc = meadow_desc(257, 0.5, flat_layers());
    let rule = ScatterRule { scale: [0.7, 1.3], seed: 7, ..ScatterRule::new(0.5, 0b011) };
    let whole = scatter(&desc, &rule, [-40.0, -40.0], [40.0, 40.0]);
    let west = scatter(&desc, &rule, [-40.0, -40.0], [0.0, 40.0]);
    let east = scatter(&desc, &rule, [0.0, -40.0], [40.0, 40.0]);
    assert!(whole.len() > 500, "{} instances", whole.len());
    let key = |p: &genex_render::foliage::scatter::Scattered| p.cell;
    let mut halves: Vec<[i32; 2]> = west.iter().chain(&east).map(key).collect();
    let mut all: Vec<[i32; 2]> = whole.iter().map(key).collect();
    halves.sort_unstable();
    all.sort_unstable();
    assert_eq!(halves, all, "two halves are the whole, edge included");
    assert_eq!(scatter(&desc, &rule, [-40.0, -40.0], [40.0, 40.0]), whole, "deterministic");
    let other = scatter(&desc, &ScatterRule { seed: 8, ..rule }, [-40.0, -40.0], [40.0, 40.0]);
    assert_ne!(other.iter().map(key).collect::<Vec<_>>(), whole.iter().map(key).collect::<Vec<_>>(), "another seed, other places");
    for placed in whole.iter().step_by(37) {
        assert!((placed.position[1] - desc.heights.height(placed.position[0], placed.position[2])).abs() < 1e-5, "on the ground");
        assert!((0.7..=1.3).contains(&placed.scale));
    }
}

#[test]
fn a_scatter_keeps_to_its_layers_its_slope_and_its_cap() {
    let desc = meadow_desc(257, 0.5, flat_layers());
    let area = ([-60.0, -30.0], [60.0, 30.0]);
    // On the rock alone (x > 25), at its density.
    let rock = scatter(&desc, &ScatterRule::new(1.0, 0b100), area.0, area.1);
    assert!(rock.iter().all(|p| p.position[0] > 24.0), "the rock layer only");
    let rock_area = (60.0 - 25.0) * 60.0;
    assert!((rock.len() as f32 / rock_area - 1.0).abs() < 0.1, "{} instances on {rock_area} m2", rock.len());
    // Flat ground only: the gentle hills' steeper sides stay bare.
    let any = scatter(&desc, &ScatterRule::new(1.0, 0b111), area.0, area.1);
    let flat = scatter(&desc, &ScatterRule { flatness: 0.99, ..ScatterRule::new(1.0, 0b111) }, area.0, area.1);
    assert!(flat.len() < any.len() && !flat.is_empty(), "{} of {}", flat.len(), any.len());
    // Capped: the kept ones spread over the whole area (both halves keep about half).
    let capped = scatter(&desc, &ScatterRule { cap: any.len() / 4, ..ScatterRule::new(1.0, 0b111) }, area.0, area.1);
    assert_eq!(capped.len(), any.len() / 4);
    let west = capped.iter().filter(|p| p.position[0] < 0.0).count() as f32 / capped.len() as f32;
    assert!((west - 0.5).abs() < 0.06, "a cap thins evenly: {west} in the west half");
    // Leaning with the ground, the model's up axis is the instance's.
    let leaning = scatter(&desc, &ScatterRule { follow_ground: 1.0, ..ScatterRule::new(0.2, 0b111) }, area.0, area.1);
    let tilted = leaning.iter().find(|p| p.up[1] < 0.995).expect("some ground slopes");
    let m = tilted.model();
    let up = [m[4], m[5], m[6]].map(|v| v / tilted.scale);
    assert!((0..3).all(|i| (up[i] - tilted.up[i]).abs() < 1e-4), "{up:?} {:?}", tilted.up);
    // Hostile rules place nothing.
    for bad in [ScatterRule::new(f32::NAN, 1), ScatterRule::new(-1.0, 1), ScatterRule::new(1e6, 1), ScatterRule { scale: [2.0, 1.0], ..ScatterRule::new(1.0, 1) }] {
        assert!(scatter(&desc, &bad, area.0, area.1).is_empty(), "{bad:?}");
    }
    assert!(scatter(&desc, &ScatterRule::new(1.0, 1), [10.0, 0.0], [-10.0, 5.0]).is_empty(), "an empty area");
}

// --- Shaders ---

use naga::back::{hlsl, msl, spv};
use naga::valid::{Capabilities, ModuleInfo, ValidationFlags, Validator};

fn parse(name: &str, source: &str) -> naga::Module {
    naga::front::wgsl::parse_str(source).unwrap_or_else(|error| panic!("{name}: {}", error.emit_to_string(source)))
}

fn validated(name: &str, module: &naga::Module) -> ModuleInfo {
    Validator::new(ValidationFlags::all(), Capabilities::CUBE_ARRAY_TEXTURES)
        .validate(module)
        .unwrap_or_else(|error| panic!("{name} needs more than WebGPU core: {error:?}"))
}

fn emit(name: &str, module: &naga::Module, info: &ModuleInfo, variant: &[(&str, f64)]) {
    let constants: naga::back::PipelineConstants = variant.iter().map(|(key, value)| ((*key).to_owned(), *value)).collect();
    let (module, info) = naga::back::pipeline_constants::process_overrides(module, info, None, &constants).unwrap_or_else(|error| panic!("{name} {variant:?}: {error:?}"));
    let mut hlsl_source = String::new();
    let options = hlsl::Options { shader_model: hlsl::ShaderModel::V5_1, ..Default::default() };
    hlsl::Writer::new(&mut hlsl_source, &options, &hlsl::PipelineOptions::default()).write(&module, &info, None).unwrap_or_else(|error| panic!("{name} {variant:?}: HLSL: {error:?}"));
    let options = msl::Options { lang_version: (2, 4), ..Default::default() };
    msl::write_string(&module, &info, &options, &msl::PipelineOptions::default()).unwrap_or_else(|error| panic!("{name} {variant:?}: MSL: {error:?}"));
    let options = spv::Options { lang_version: (1, 3), ..Default::default() };
    spv::write_vec(&module, &info, &options, None).unwrap_or_else(|error| panic!("{name} {variant:?}: SPIR-V: {error:?}"));
}

#[test]
fn the_grass_modules_validate_against_core_and_emit_every_variant() {
    let grass = parse("grass", GRASS);
    let info = validated("grass", &grass);
    let variants: [&[(&str, f64)]; 4] = [
        &[],
        &[("GX_SCENE_HDR", 1.0), ("GX_SHADOW_FILTER", 4.0), ("GX_SHADOW_TEMPORAL", 1.0)],
        &[("GX_SCENE_HDR", 1.0), ("GX_ROUGHNESS_FLOOR", 0.089), ("GX_SCENE_RG11B10", 1.0)],
        &[("GX_SHADOW_FILTER", 2.0)],
    ];
    for variant in variants {
        emit("grass", &grass, &info, variant);
    }
    let shadow = parse("grass-shadow", GRASS_SHADOW);
    let shadow_info = validated("grass-shadow", &shadow);
    for variant in [&[][..], &[("GX_UNCLIPPED_DEPTH", 1.0)][..], &[("GX_SHADOW_DEPTH_UNIT", 1.0 / 65536.0)][..]] {
        emit("grass-shadow", &shadow, &shadow_info, variant);
    }
    let generation = parse("grass-gen", GRASS_GEN);
    let gen_info = validated("grass-gen", &generation);
    emit("grass-gen", &generation, &gen_info, &[]);
    for entry in ["vs_grass", "vs_grass_motion"] {
        let point = grass.entry_points.iter().find(|point| point.name == entry).unwrap_or_else(|| panic!("{entry}"));
        let result = point.function.result.as_ref().expect("an output");
        let naga::TypeInner::Struct { members, .. } = &grass.types[result.ty].inner else { panic!("{entry} returns a struct") };
        let invariant = members.iter().any(|member| matches!(member.binding, Some(naga::Binding::BuiltIn(naga::BuiltIn::Position { invariant: true }))));
        assert!(invariant, "{entry}: @builtin(position) @invariant");
    }
    for source in [GRASS, GRASS_SHADOW, GRASS_GEN] {
        assert!(source.len() < genex_render::WGSL_MAX_BYTES);
    }
}

#[test]
fn the_grass_row_is_the_size_naga_lays_out() {
    for (name, source) in [("grass", GRASS), ("grass-gen", GRASS_GEN)] {
        let module = parse(name, source);
        let mut layouter = naga::proc::Layouter::default();
        layouter.update(module.to_ctx()).expect("layout");
        let (handle, _) = module.types.iter().find(|(_, ty)| ty.name.as_deref() == Some("GxGrass")).expect("GxGrass");
        assert_eq!(layouter[handle].size as usize, size_of::<GpuGrass>(), "{name}");
    }
}

/// The bound globals of `module` that `stage`'s entry points use: (sampled textures, storage
/// buffers, uniform buffers).
fn stage_counts(module: &naga::Module, info: &ModuleInfo, stage: naga::ShaderStage) -> (u32, u32, u32) {
    let entries: Vec<usize> = module.entry_points.iter().enumerate().filter(|(_, entry)| entry.stage == stage).map(|(index, _)| index).collect();
    let mut counts = (0, 0, 0);
    for (handle, global) in module.global_variables.iter().filter(|(_, global)| global.binding.is_some()) {
        if !entries.iter().any(|index| !info.get_entry_point(*index)[handle].is_empty()) {
            continue;
        }
        match (&module.types[global.ty].inner, global.space) {
            (naga::TypeInner::Image { class: naga::ImageClass::Storage { .. }, .. }, _) => {}
            (naga::TypeInner::Image { .. }, _) => counts.0 += 1,
            (_, naga::AddressSpace::Storage { .. }) => counts.1 += 1,
            (_, naga::AddressSpace::Uniform) => counts.2 += 1,
            _ => {}
        }
    }
    counts
}

#[test]
fn the_grass_adds_no_binding_to_the_forward_fragment_stage() {
    let core = wgpu::Limits::defaults();
    let module = parse("grass", GRASS);
    let info = validated("grass", &module);
    let forward = parse("forward", genex_render::shaders::FORWARD);
    let forward_info = validated("forward", &forward);
    let (textures, storage, uniforms) = stage_counts(&module, &info, naga::ShaderStage::Fragment);
    let (forward_textures, forward_storage, _) = stage_counts(&forward, &forward_info, naga::ShaderStage::Fragment);
    assert!(textures <= forward_textures, "the blades sample the forward frame group's textures only: {textures}");
    assert!(storage <= forward_storage, "no fragment storage buffer of its own: {storage} against {forward_storage}");
    assert!(uniforms <= core.max_uniform_buffers_per_shader_stage);
    let (_, vertex_storage, _) = stage_counts(&module, &info, naga::ShaderStage::Vertex);
    assert!(vertex_storage <= core.max_storage_buffers_per_shader_stage, "vertex: {vertex_storage}");
    // The pipeline layout counted the WebGPU way (every binding a stage can see).
    let frame = genex_render::renderer::frame_layout_entries();
    let grass = layout_entries();
    let count = |stage: wgpu::ShaderStages, storage: bool| {
        frame
            .iter()
            .chain(grass.iter())
            .filter(|entry| entry.visibility.contains(stage))
            .filter(|entry| match entry.ty {
                wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Storage { .. }, .. } => storage,
                wgpu::BindingType::Texture { .. } => !storage,
                _ => false,
            })
            .count() as u32
    };
    let forward_fragment = frame.iter().filter(|entry| entry.visibility.contains(wgpu::ShaderStages::FRAGMENT)).count();
    let grass_fragment = frame.iter().chain(grass.iter()).filter(|entry| entry.visibility.contains(wgpu::ShaderStages::FRAGMENT)).count();
    assert_eq!(grass_fragment, forward_fragment + 1, "the fragment stage sees the grass row alone of the grass group");
    assert!(count(wgpu::ShaderStages::FRAGMENT, true) <= core.max_storage_buffers_per_shader_stage);
    assert!(count(wgpu::ShaderStages::FRAGMENT, false) <= core.max_sampled_textures_per_shader_stage);
    assert!(count(wgpu::ShaderStages::VERTEX, true) + 2 <= core.max_storage_buffers_per_shader_stage, "the motion group's tables fit too");
    // The generation: its own five, the terrain's two.
    let compute_storage = gen_layout_entries().iter().filter(|entry| matches!(entry.ty, wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Storage { .. }, .. })).count()
        + genex_render::terrain::gpu::layout_entries().iter().filter(|entry| entry.visibility.contains(wgpu::ShaderStages::COMPUTE) && matches!(entry.ty, wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Storage { .. }, .. })).count();
    assert!(compute_storage as u32 <= core.max_storage_buffers_per_shader_stage, "compute: {compute_storage}");
}

// --- Real-GPU rows ---

use genex_render::device_class::{DeviceClass, FormFactor, PerformanceTier};
use genex_render::presets::preset_quality;
use genex_render::scene::{CameraDesc, Scene};
use genex_render::settings::{AntiAliasing, AoResolution, Environment, Quality, QualityPreset, SceneFormat, SkyParams};
use genex_render::{CullPath, Gpu, RenderOptions, Renderer};
use glam::Vec3;

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

fn evidence_dir() -> Option<std::path::PathBuf> {
    let dir = std::path::PathBuf::from(std::env::var_os("GENEX_RENDER_EVIDENCE_DIR")?);
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

fn write_capture(name: &str, capture: &genex_render::capture::Capture) {
    if let Some(dir) = evidence_dir() {
        let path = dir.join(format!("{name}-{}x{}.bgra", capture.width(), capture.height()));
        std::fs::write(&path, capture.bgra()).expect("evidence written");
    }
}

fn desktop_high() -> DeviceClass {
    DeviceClass::new(FormFactor::Desktop, PerformanceTier::High)
}

/// The low sun behind the meadow (about 14 degrees up, ahead of the walker's view).
const SUN: [f32; 3] = [0.2, 0.25, 0.95];

/// A renderer at `size` drawing `quality` under the physical sky, single-sampled when `depth` (its
/// depth and prepass kept for readback).
fn renderer(gpu: &Gpu, size: (u32, u32), quality: &Quality, depth: bool) -> Renderer {
    let msaa = !depth && quality.anti_aliasing == AntiAliasing::Msaa4;
    let mut renderer = Renderer::with_options(gpu, size.0, size.1, RenderOptions { msaa }).expect("renderer");
    renderer.set_scene_format(SceneFormat::Rgba16Float);
    renderer.set_device_class(desktop_high());
    renderer.set_quality(quality);
    renderer.set_environment(&Environment::Sky(SkyParams::default()));
    renderer.set_depth_readback(depth);
    renderer
}

/// `preset` on desktop-high without the features that keep their own noise or meter the picture
/// (AO, bloom, auto exposure), so a frame's change is the camera's and the grass's.
fn steady(preset: QualityPreset) -> Quality {
    let mut quality = preset_quality(preset, desktop_high());
    quality.ao.resolution = AoResolution::Off;
    quality.bloom.enabled = false;
    quality.exposure = false;
    quality
}

fn scene(camera: CameraDesc) -> Scene {
    let mut scene = Scene::new(camera, [255, 0, 255, 255]);
    scene.lighting.sun_dir = Vec3::from(SUN).normalize().to_array();
    scene.lighting.shadow_distance = 60.0;
    scene
}

fn camera(eye: Vec3, yaw: f32, pitch: f32, fovy: f32) -> CameraDesc {
    let ahead = Vec3::new(libm::sinf(yaw) * libm::cosf(pitch), -libm::sinf(pitch), libm::cosf(yaw) * libm::cosf(pitch));
    let mut camera = CameraDesc::look_at(eye.to_array(), (eye + ahead).to_array());
    camera.fovy_degrees = fovy;
    camera
}

/// A walker in the lush meadow at x = -6 looking along +z with the field to the east in view.
fn walker(desc: &TerrainDesc, eye_height: f32) -> CameraDesc {
    let (x, z) = (-6.0, -20.0);
    camera(Vec3::new(x, desc.heights.height(x, z) + eye_height, z), 0.35, 8f32.to_radians(), 55.0)
}

/// `scene` drawn `frames` times on one pose at `seconds` (TAA's history settles), then captured.
fn settled(gpu: &Gpu, renderer: &mut Renderer, scene: &Scene, frames: u64, seconds: f32) -> genex_render::capture::Capture {
    for k in 0..frames {
        renderer.set_frame_index(k);
        renderer.set_foliage_seconds(seconds);
        renderer.render(gpu, scene, CullPath::Gpu).expect("frame");
    }
    renderer.capture(gpu).expect("capture")
}

fn lumas(capture: &genex_render::capture::Capture) -> Vec<f32> {
    capture.bgra().chunks(4).map(|p| 0.0722 * f32::from(p[0]) + 0.7152 * f32::from(p[1]) + 0.2126 * f32::from(p[2])).collect()
}

/// The meadow without grass on any layer.
fn bare(desc: &TerrainDesc) -> TerrainDesc {
    let mut bare = desc.clone();
    for layer in &mut bare.layers {
        layer.grass = None;
    }
    bare
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_meadow_draws_blades_where_its_layers_grow_grass() {
    let Some(gpu) = gpu() else { return };
    let size = (480, 270);
    let desc = meadow_desc(257, 0.5, flat_layers());
    let mut rows = Vec::new();
    for preset in [QualityPreset::Low, QualityPreset::Medium, QualityPreset::High, QualityPreset::Ultra] {
        let quality = steady(preset);
        // Single-sampled with depth kept: a pixel is the blades' where its depth is nearer than the
        // bare ground's.
        let mut with = renderer(&gpu, size, &quality, true);
        with.set_terrain(&gpu, Some((&desc, 1))).expect("terrain");
        let mut without = renderer(&gpu, size, &quality, true);
        without.set_terrain(&gpu, Some((&bare(&desc), 2))).expect("bare terrain");
        let view = scene(walker(&desc, 1.6));
        let grass = settled(&gpu, &mut with, &view, 12, 2.0);
        let _ = settled(&gpu, &mut without, &view, 12, 2.0);
        write_capture(&format!("meadow-{}", preset.wire()), &grass);
        let (near, ground) = (with.read_depth(&gpu).expect("depth"), without.read_depth(&gpu).expect("depth"));
        // The lower half of the frame is meadow; reverse-Z on the HDR scene (nearer is larger).
        let half = near.len() / 2;
        let covered = near[half..].iter().zip(&ground[half..]).filter(|(a, b)| (**a - **b).abs() > 1e-7).count();
        let share = covered as f64 / (near.len() - half) as f64;
        rows.push(format!("{}: blades cover {:.1}% of the meadow's half of the frame, stats {:?}", preset.wire(), share * 100.0, with.grass_stats()));
        if quality.grass.drawn() {
            assert!(share > 0.15, "{}: the meadow covers the ground with blades ({:.1}%)", preset.wire(), share * 100.0);
            assert!(with.grass_stats().is_some(), "{}: drawn", preset.wire());
        } else {
            assert_eq!(covered, 0, "{}: draws no grass", preset.wire());
            assert!(with.grass_stats().is_none());
        }
    }
    eprintln!("{}", rows.join("\n"));
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_gpu_generates_the_cpu_twins_blades() {
    let Some(gpu) = gpu() else { return };
    let desc = meadow_desc(257, 0.5, flat_layers());
    for preset in [QualityPreset::Medium, QualityPreset::High, QualityPreset::Ultra] {
        let quality = steady(preset);
        let mut renderer = renderer(&gpu, (320, 180), &quality, false);
        renderer.set_terrain(&gpu, Some((&desc, 1))).expect("terrain");
        let view = scene(walker(&desc, 1.6));
        renderer.set_frame_index(0);
        renderer.render(&gpu, &view, CullPath::Gpu).expect("frame");
        let drawn = renderer.read_grass(&gpu).expect("read back").expect("grass drawn");
        let aspect = 320.0 / 180.0;
        let view_proj = view.camera.view_proj_reversed(aspect);
        let planes = genex_render::cull::frustum_planes_for(view_proj, true);
        let field = GrassField::new(&desc);
        let expected = plan(&field, &quality.grass, view.camera.eye, &planes);
        let key = |record: &[u32; 4]| (record[0], record[2]);
        let cpu: std::collections::BTreeMap<(u32, u32), [u32; 4]> = expected.blades.iter().map(|(_, _, blade)| (key(&blade.pack()), blade.pack())).collect();
        let matched = drawn.iter().filter(|record| cpu.get(&key(record)).is_some_and(|twin| {
            let height = |r: &[u32; 4]| (r[3] >> 20) as i64;
            twin[3] & 0xfffff == record[3] & 0xfffff && (height(twin) - height(record)).abs() <= 2 && (f32::from_bits(twin[1]) - f32::from_bits(record[1])).abs() < 1e-3
        }));
        let matched = matched.count();
        eprintln!("{}: GPU {} blades, CPU twin {}, matched {matched}", preset.wire(), drawn.len(), cpu.len());
        assert!(drawn.len() > 5000, "{}: a meadow's worth", preset.wire());
        let tolerance = cpu.len() / 500 + 2;
        assert!(drawn.len().abs_diff(cpu.len()) <= tolerance, "{}: GPU {} against CPU {}", preset.wire(), drawn.len(), cpu.len());
        assert!(matched + tolerance >= drawn.len(), "{}: {matched} of {} blades are the twin's", preset.wire(), drawn.len());
        // In draw order: tiles in row order, each tile's blades in cell order (no atomics).
        let order: Vec<(u32, u32)> = drawn.iter().map(key).collect();
        let twin_order: Vec<(u32, u32)> = expected.blades.iter().map(|(_, _, blade)| key(&blade.pack())).collect();
        let same_order = order.iter().zip(&twin_order).take_while(|(a, b)| a == b).count();
        assert!(same_order > drawn.len() / 20 || same_order == drawn.len(), "{}: the order is the twin's ({same_order} leading blades agree)", preset.wire());
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_still_meadow_draws_the_same_picture_twice() {
    let Some(gpu) = gpu() else { return };
    let desc = meadow_desc(257, 0.5, flat_layers());
    let quality = steady(QualityPreset::High);
    let view = scene(walker(&desc, 1.6));
    let picture = || {
        let mut renderer = renderer(&gpu, (320, 180), &quality, false);
        renderer.set_terrain(&gpu, Some((&desc, 1))).expect("terrain");
        settled(&gpu, &mut renderer, &view, 16, 3.25).bgra().to_vec()
    };
    let (a, b) = (picture(), picture());
    let differ = a.chunks(4).zip(b.chunks(4)).filter(|(x, y)| x != y).count();
    assert_eq!(differ, 0, "two renderers draw the same meadow");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_sway_writes_its_own_motion() {
    let Some(gpu) = gpu() else { return };
    let desc = meadow_desc(257, 0.5, flat_layers());
    let quality = steady(QualityPreset::High);
    let mut renderer = renderer(&gpu, (320, 180), &quality, true);
    renderer.set_terrain(&gpu, Some((&desc, 1))).expect("terrain");
    let view = scene(walker(&desc, 1.0));
    let mut motion_at = |seconds: [f32; 2]| {
        renderer.set_frame_index(0);
        renderer.set_foliage_seconds(seconds[0]);
        renderer.render(&gpu, &view, CullPath::Gpu).expect("first frame");
        renderer.set_frame_index(1);
        renderer.set_foliage_seconds(seconds[1]);
        renderer.render(&gpu, &view, CullPath::Gpu).expect("second frame");
        let motion = renderer.read_motion(&gpu).expect("motion");
        motion.iter().filter(|m| m[0].abs() + m[1].abs() > 1e-4).count()
    };
    let still = motion_at([4.0, 4.0]);
    let swaying = motion_at([4.0, 4.0 + 1.0 / 60.0]);
    eprintln!("moving pixels: {still} with the wind still, {swaying} with it blowing");
    assert_eq!(still, 0, "a still camera over a still meadow moves nothing");
    assert!(swaying > 2000, "the blades' sway is in the motion target: {swaying} pixels");
}

/// A pixel pops when its luma jumps by more than this for exactly one frame (SH-15).
const POP_LEVELS: f32 = 16.0;

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_swaying_meadow_under_taa_does_not_pop() {
    let Some(gpu) = gpu() else { return };
    let desc = meadow_desc(257, 0.5, flat_layers());
    let size = (480, 270);
    let mut rows = Vec::new();
    for preset in [QualityPreset::High, QualityPreset::Ultra] {
        let quality = steady(preset);
        let mut renderer = renderer(&gpu, size, &quality, false);
        renderer.set_terrain(&gpu, Some((&desc, 1))).expect("terrain");
        let view = scene(walker(&desc, 1.6));
        let mut frames = Vec::new();
        for k in 0..72u64 {
            renderer.set_frame_index(k);
            renderer.set_foliage_seconds(5.0 + k as f32 / 60.0);
            renderer.render(&gpu, &view, CullPath::Gpu).expect("frame");
            if k >= 24 {
                frames.push(lumas(&renderer.capture(&gpu).expect("capture")));
            }
        }
        let mut pops = 0usize;
        for f in 1..frames.len() - 1 {
            for (i, &b) in frames[f].iter().enumerate() {
                let (a, c) = (frames[f - 1][i], frames[f + 1][i]);
                if (b - a).abs() > POP_LEVELS && (b - c).abs() > POP_LEVELS && (a - c).abs() < POP_LEVELS {
                    pops += 1;
                }
            }
        }
        let share = pops as f64 / (f64::from(size.0 * size.1) * (frames.len() - 2) as f64);
        rows.push(format!("{}: {pops} one-frame pops over {} frames ({:.4}%)", preset.wire(), frames.len() - 2, share * 100.0));
        assert!(share <= 0.001, "{}: the swaying meadow pops on {:.4}% of its pixels a frame (bound 0.10%)", preset.wire(), share * 100.0);
    }
    eprintln!("{}", rows.join("\n"));
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_blades_cast_into_the_nearest_cascade_where_the_quality_casts() {
    let Some(gpu) = gpu() else { return };
    let desc = meadow_desc(257, 0.5, flat_layers());
    let size = (480, 270);
    // Looking down onto the meadow with the low sun beside: the ground between blades is where
    // their shadows fall.
    let view = scene(camera(Vec3::new(-6.0, desc.heights.height(-6.0, -10.0) + 2.5, -10.0), 0.4, 50f32.to_radians(), 50.0));
    let picture = |casts: bool| {
        let mut quality = steady(QualityPreset::High);
        quality.grass.casts = casts;
        quality.contact_shadows = false;
        let mut renderer = renderer(&gpu, size, &quality, false);
        renderer.set_terrain(&gpu, Some((&desc, 1))).expect("terrain");
        let capture = settled(&gpu, &mut renderer, &view, 16, 1.0);
        write_capture(&format!("casts-{}", if casts { "on" } else { "off" }), &capture);
        lumas(&capture)
    };
    let (on, off) = (picture(true), picture(false));
    let darker = on.iter().zip(&off).filter(|(a, b)| **b - **a > 8.0).count();
    let lighter = on.iter().zip(&off).filter(|(a, b)| **a - **b > 8.0).count();
    eprintln!("{darker} pixels darker with blades casting, {lighter} lighter");
    assert!(darker as f64 > 0.03 * on.len() as f64, "blades shadow the ground and each other: {darker} pixels");
    assert!(lighter * 10 < darker.max(1), "casting only darkens: {lighter} lighter");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_low_sun_behind_the_meadow_lights_the_blades_through() {
    let Some(gpu) = gpu() else { return };
    let desc = meadow_desc(257, 0.5, flat_layers());
    let quality = steady(QualityPreset::High);
    let view = scene(walker(&desc, 1.2));
    let picture = |transmission: f32| {
        let mut lit = desc.clone();
        for layer in &mut lit.layers {
            if let Some(grass) = layer.grass.as_mut() {
                grass.transmission = transmission;
            }
        }
        let mut renderer = renderer(&gpu, (480, 270), &quality, false);
        renderer.set_terrain(&gpu, Some((&lit, 1))).expect("terrain");
        let capture = settled(&gpu, &mut renderer, &view, 16, 1.0);
        write_capture(&format!("through-{transmission}"), &capture);
        lumas(&capture)
    };
    let (through, none) = (picture(0.8), picture(0.0));
    // The meadow: the frame's lower half (the sky above the horizon is the same in both).
    let half = through.len() / 2;
    let sum = |lumas: &[f32]| lumas[half..].iter().map(|l| f64::from(*l)).sum::<f64>();
    let gain = sum(&through) / sum(&none) - 1.0;
    let brighter = through[half..].iter().zip(&none[half..]).filter(|(a, b)| **a > **b + 1.0).count();
    let darker = through[half..].iter().zip(&none[half..]).filter(|(a, b)| **b > **a + 1.0).count();
    eprintln!("the meadow is {:.1}% brighter with the light through the blades ({brighter} pixels brighter, {darker} darker)", gain * 100.0);
    assert!(gain > 0.04, "the back-lit blades glow: {:.1}%", gain * 100.0);
    assert!(darker * 20 < brighter.max(1), "transmission only adds light: {darker} darker");
}

/// The grass's budget on desktop `high` at 1440p (plan A.8 acceptance).
const GRASS_HIGH_MS_MAX: f32 = 1.5;
/// The mobile proxy's share of a 60 Hz interval for the grass at the phones' density.
const GRASS_MOBILE_MS_MAX: f32 = 16.667 / 8.0;

/// GPU milliseconds of whole frames of each renderer drawing its scene, rounds interleaved,
/// median per renderer; None without timestamp queries.
fn frame_ms(gpu: &Gpu, runs: &mut [(Renderer, Scene)]) -> Option<Vec<f32>> {
    let mut landed: Vec<Vec<f32>> = vec![Vec::new(); runs.len()];
    for round in 0..6u64 {
        for (k, (renderer, scene)) in runs.iter_mut().enumerate() {
            for frame in 0..48u64 {
                let times = renderer.arm_frame_timer(&gpu.queue)?;
                if round > 0 && frame >= 8 {
                    landed[k].extend(times);
                }
                renderer.set_frame_index(frame);
                renderer.set_foliage_seconds(frame as f32 / 60.0);
                renderer.render(gpu, scene, CullPath::Gpu).expect("frame");
                renderer.finish_frame_timer();
                let _ = gpu.device.poll(wgpu::PollType::wait_indefinitely());
            }
        }
    }
    Some(
        landed
            .into_iter()
            .map(|mut times| {
                times.sort_by(f32::total_cmp);
                times[times.len() / 2]
            })
            .collect(),
    )
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_grass_costs_at_most_1_5_ms_at_high_1440p() {
    let Some(gpu) = gpu() else { return };
    if !gpu.device.features().contains(wgpu::Features::TIMESTAMP_QUERY) {
        eprintln!("skipped: no timestamp queries");
        return;
    }
    let desc = meadow_desc(513, 0.5, flat_layers());
    let mut rows = Vec::new();
    let cases = [
        ("medium-1440p", preset_quality(QualityPreset::Medium, desktop_high()), (2560, 1440), f32::INFINITY),
        ("high-1440p", preset_quality(QualityPreset::High, desktop_high()), (2560, 1440), GRASS_HIGH_MS_MAX),
        ("ultra-1440p", preset_quality(QualityPreset::Ultra, desktop_high()), (2560, 1440), f32::INFINITY),
        ("mobile-high-proxy", preset_quality(QualityPreset::High, DeviceClass::new(FormFactor::Mobile, PerformanceTier::High)), (1280, 590), GRASS_MOBILE_MS_MAX),
    ];
    for (name, quality, size, budget) in cases {
        let mut with = renderer(&gpu, size, &quality, false);
        with.set_terrain(&gpu, Some((&desc, 1))).expect("terrain");
        let mut without = renderer(&gpu, size, &quality, false);
        without.set_terrain(&gpu, Some((&bare(&desc), 2))).expect("bare terrain");
        let view = scene(walker(&desc, 1.6));
        let Some(ms) = frame_ms(&gpu, &mut [(with, view.clone()), (without, view)]) else {
            eprintln!("skipped: no frame timer");
            return;
        };
        let cost = ms[0] - ms[1];
        let row = format!("{name}: {:.3} ms with the grass, {:.3} ms without: grass {cost:.3} ms (budget {budget})", ms[0], ms[1]);
        eprintln!("{row}");
        rows.push((row, cost, budget));
    }
    if let Some(path) = std::env::var_os("GENEX_PERF_OUT") {
        let lines: String = rows.iter().map(|(row, cost, _)| format!("{}\n", serde_json::json!({ "row": "grass-cost", "detail": row, "ms": cost }))).collect();
        std::fs::write(path, lines).expect("perf rows written");
    }
    for (row, cost, budget) in rows {
        assert!(cost <= budget, "{row}");
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_budget_ledger_holds_the_grass_and_lets_it_go() {
    use genex_render::budget::BudgetKind;
    let Some(gpu) = gpu() else { return };
    let desc = meadow_desc(129, 0.5, flat_layers());
    let mut renderer = renderer(&gpu, (64, 64), &steady(QualityPreset::High), false);
    let row = |renderer: &Renderer| renderer.buffer_ledger().entries().iter().find(|entry| entry.label == genex_render::foliage::GRASS_LEDGER_LABEL).map(|entry| (entry.kind, entry.bytes));
    renderer.set_terrain(&gpu, Some((&bare(&desc), 1))).expect("bare terrain");
    renderer.render(&gpu, &scene(walker(&desc, 1.6)), CullPath::Gpu).expect("frame");
    assert_eq!(row(&renderer), None, "a bare terrain grows no grass");
    renderer.set_terrain(&gpu, Some((&desc, 2))).expect("terrain");
    renderer.render(&gpu, &scene(walker(&desc, 1.6)), CullPath::Gpu).expect("frame");
    let (kind, bytes) = row(&renderer).expect("the grass's row");
    assert_eq!(kind, BudgetKind::Buffers);
    let stats = renderer.grass_stats().expect("grass drawn");
    let blades = u64::from(stats.tiles * stats.tiles) * u64::from(genex_render::foliage::GRASS_TILE_CELLS);
    assert!(bytes >= blades * 20, "a record and an order slot a candidate: {bytes} bytes for {blades}");
    renderer.set_terrain(&gpu, None).expect("no terrain");
    assert_eq!(row(&renderer), None);
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_meadow_shots_for_the_look_review() {
    let Some(gpu) = gpu() else { return };
    let desc = meadow_desc(513, 0.5, flat_layers());
    for preset in [QualityPreset::Medium, QualityPreset::High, QualityPreset::Ultra] {
        let quality = preset_quality(preset, desktop_high());
        let mut renderer = renderer(&gpu, (1280, 720), &quality, false);
        renderer.set_terrain(&gpu, Some((&desc, 1))).expect("terrain");
        for (shot, height) in [("walk", 1.6), ("low", 0.5)] {
            let capture = settled(&gpu, &mut renderer, &scene(walker(&desc, height)), 24, 2.0);
            write_capture(&format!("look-{}-{shot}", preset.wire()), &capture);
        }
    }
}
