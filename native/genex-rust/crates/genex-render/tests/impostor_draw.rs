//! The impostor draw (game systems LOD-14, `genex_render::impostor::draw`). Shader rows validate
//! the draw module against WebGPU core, emit it for every back end, keep `frag_depth` to desktop
//! high and ultra and hold the impostor pipelines within core beside the forward frame group.
//! Real-GPU rows (`#[ignore]`d, every name contains `metal`) bake a cube's impostor through the
//! renderer and hold it to the mesh it stands in for at the switch:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --release --offline --locked --test impostor_draw -- --ignored metal
//!
//! With `GENEX_RENDER_EVIDENCE_DIR` the rows write their captures there (raw BGRA).

use genex_render::device_class::{DeviceClass, FormFactor, PerformanceTier};
use genex_render::impostor::draw::{
    FORWARD_FRAGMENT, GpuImpostorInstance, IMPOSTOR_DRAW, IMPOSTOR_SPECIES_MAX, ImpostorInstance, MOTION_FRAGMENT, PREPASS_FRAGMENT, class_of, impostor_layout_entries, writes_depth,
};
use genex_render::impostor::{ImpostorClass, ImpostorLayout, impostor_class};
use genex_render::settings::QualityPreset;
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
fn the_impostor_draw_validates_against_core_and_emits_every_variant() {
    let module = parse("impostor draw", IMPOSTOR_DRAW);
    let info = validated("impostor draw", &module);
    let variants: [&[(&str, f64)]; 3] = [&[], &[("GX_IMPOSTOR_PARALLAX", 0.0)], &[("GX_SCENE_HDR", 1.0), ("GX_ENVIRONMENT_LIGHT", 1.0), ("GX_SSR", 1.0)]];
    for variant in variants {
        emit("impostor draw", &module, &info, variant);
    }
    for entry in [FORWARD_FRAGMENT, PREPASS_FRAGMENT, MOTION_FRAGMENT].concat() {
        assert!(module.entry_points.iter().any(|point| point.name == entry), "{entry} is an entry point");
    }
}

/// Whether fragment entry `name` of `module` writes `frag_depth`.
fn writes_frag_depth(module: &naga::Module, name: &str) -> bool {
    let point = module.entry_points.iter().find(|point| point.name == name).unwrap_or_else(|| panic!("{name}"));
    let Some(result) = point.function.result.as_ref() else { return false };
    let depth = |binding: &Option<naga::Binding>| matches!(binding, Some(naga::Binding::BuiltIn(naga::BuiltIn::FragDepth)));
    if depth(&result.binding) {
        return true;
    }
    match &module.types[result.ty].inner {
        naga::TypeInner::Struct { members, .. } => members.iter().any(|member| depth(&member.binding)),
        _ => false,
    }
}

#[test]
fn no_frag_depth_below_desktop_high() {
    let module = parse("impostor draw", IMPOSTOR_DRAW);
    for entries in [FORWARD_FRAGMENT, PREPASS_FRAGMENT, MOTION_FRAGMENT] {
        assert!(!writes_frag_depth(&module, entries[0]), "{}: the flat entry keeps early depth testing", entries[0]);
        assert!(writes_frag_depth(&module, entries[1]), "{}: the depth entry writes the surface's", entries[1]);
    }
    let tiers = [PerformanceTier::Low, PerformanceTier::Mid, PerformanceTier::High, PerformanceTier::Ultra];
    let presets = [QualityPreset::Low, QualityPreset::Medium, QualityPreset::High, QualityPreset::Ultra];
    for form in [FormFactor::Desktop, FormFactor::Mobile] {
        for tier in tiers {
            for preset in presets {
                let class = impostor_class(preset, DeviceClass::new(form, tier));
                let depth = writes_depth(class);
                let high_or_ultra = form == FormFactor::Desktop && matches!(preset, QualityPreset::High | QualityPreset::Ultra);
                assert_eq!(depth, high_or_ultra, "{form:?} {tier:?} {preset:?} takes {class:?}");
                for entries in [FORWARD_FRAGMENT, PREPASS_FRAGMENT, MOTION_FRAGMENT] {
                    assert_eq!(writes_frag_depth(&module, entries[usize::from(depth)]), high_or_ultra, "{form:?} {tier:?} {preset:?}");
                }
            }
        }
    }
    for class in ImpostorClass::ALL {
        assert_eq!(class_of(&class.spec()), Some(class), "every class's sizes name it");
    }
}

/// A layout's binding counts in `stage`: uniform buffers, storage buffers, sampled textures,
/// samplers (WebGPU counts every visible entry of every group of a pipeline layout).
fn stage_counts(entries: &[wgpu::BindGroupLayoutEntry], stage: wgpu::ShaderStages) -> [u32; 4] {
    let mut counts = [0u32; 4];
    for entry in entries.iter().filter(|entry| entry.visibility.contains(stage)) {
        let at = match entry.ty {
            wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, .. } => 0,
            wgpu::BindingType::Buffer { .. } => 1,
            wgpu::BindingType::Texture { .. } => 2,
            wgpu::BindingType::Sampler(_) => 3,
            _ => continue,
        };
        counts[at] += 1;
    }
    counts
}

#[test]
fn the_impostor_pipelines_fit_webgpu_core_and_add_no_forward_binding() {
    let core = wgpu::Limits::defaults();
    let forward = genex_render::renderer::frame_layout_entries();
    let frame = genex_render::renderer::impostor_frame_layout_entries();
    let impostor = impostor_layout_entries();
    // The impostor frame group is the forward one without its eight material arrays, entry for
    // entry (the frame bind group's resources, so one set of tables serves both).
    assert!(frame.iter().all(|entry| forward.contains(entry)), "a subset of the forward frame group");
    assert_eq!(forward.len() - frame.len(), 8, "the class-0 pair and the six larger size classes' arrays");
    let pass = [wgpu::BindGroupLayoutEntry {
        binding: 0,
        visibility: wgpu::ShaderStages::VERTEX,
        ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: true, min_binding_size: None },
        count: None,
    }];
    let all: Vec<wgpu::BindGroupLayoutEntry> = frame.iter().chain(&pass).chain(&impostor).copied().collect();
    for stage in [wgpu::ShaderStages::VERTEX, wgpu::ShaderStages::FRAGMENT] {
        let [uniforms, storage, textures, samplers] = stage_counts(&all, stage);
        assert!(uniforms <= core.max_uniform_buffers_per_shader_stage, "{stage:?}: {uniforms} uniform buffers");
        assert!(storage <= core.max_storage_buffers_per_shader_stage, "{stage:?}: {storage} storage buffers");
        assert!(textures <= core.max_sampled_textures_per_shader_stage, "{stage:?}: {textures} sampled textures");
        assert!(samplers <= core.max_samplers_per_shader_stage, "{stage:?}: {samplers} samplers");
    }
    // The impostor group adds no storage buffer to the fragment stage (the forward one holds 7 of 8).
    assert_eq!(stage_counts(&impostor, wgpu::ShaderStages::FRAGMENT)[1], 0);
    assert_eq!(stage_counts(&frame, wgpu::ShaderStages::FRAGMENT), {
        let [u, s, t, m] = stage_counts(&forward, wgpu::ShaderStages::FRAGMENT);
        [u, s, t - 8, m]
    });
}

fn wgsl_struct_size(source: &str, name: &str) -> usize {
    let module = parse(name, source);
    let mut layouter = naga::proc::Layouter::default();
    layouter.update(module.to_ctx()).expect("layout");
    module.types.iter().find(|(_, ty)| ty.name.as_deref() == Some(name)).map(|(handle, _)| layouter[handle].size as usize).unwrap_or_else(|| panic!("no struct {name}"))
}

#[test]
fn the_draw_rows_are_the_sizes_naga_lays_out() {
    assert_eq!(wgsl_struct_size(IMPOSTOR_DRAW, "GxImpostorInstance"), size_of::<GpuImpostorInstance>());
    assert_eq!(wgsl_struct_size(IMPOSTOR_DRAW, "GxImpostor"), size_of::<genex_render::impostor::GpuImpostor>());
    assert!(IMPOSTOR_SPECIES_MAX as u32 >= ImpostorClass::ALL.iter().map(|class| class.spec().species_cap).max().unwrap_or(0), "every class's cap is addressable");
}

#[test]
fn an_instance_that_cannot_be_drawn_is_skipped_never_drawn_inside_out() {
    let model = genex_render::scene::translation(1.0, 2.0, 3.0);
    let row = GpuImpostorInstance::of(&ImpostorInstance::new(model, 0)).expect("a translation");
    let inverse = glam::Mat4::from_cols_array(&row.inverse);
    assert!(inverse.abs_diff_eq(glam::Mat4::from_translation(glam::Vec3::new(-1.0, -2.0, -3.0)), 1e-6));
    let hostile: [[f32; 16]; 4] = [[0.0; 16], [f32::NAN; 16], [f32::INFINITY; 16], glam::Mat4::from_scale(glam::Vec3::new(1.0, 0.0, 1.0)).to_cols_array()];
    for model in hostile {
        assert_eq!(GpuImpostorInstance::of(&ImpostorInstance::new(model, 0)), None, "{model:?}");
    }
    let fades = [(f32::NAN, 1.0), (2.0, 1.0), (-3.0, -1.0), (0.25, 0.25), (-0.25, -0.25)];
    for (fade, kept) in fades {
        let row = GpuImpostorInstance::of(&ImpostorInstance { model, species: 0, fade }).expect("drawable");
        assert_eq!(row.fade, kept, "fade {fade}");
    }
}

// --- Real-GPU rows -------------------------------------------------------------------------

use genex_render::presets::preset_quality;
use genex_render::scene::{CameraDesc, Material, MeshId, Scene};
use genex_render::settings::{AoResolution, Environment, Fog, Look, Quality, SceneFormat, SkyParams};
use genex_render::{CullPath, Gpu, RenderOptions, Renderer};

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

fn write_capture(name: &str, width: u32, height: u32, bgra: &[u8]) {
    let Some(dir) = std::env::var_os("GENEX_RENDER_EVIDENCE_DIR").map(std::path::PathBuf::from) else { return };
    std::fs::create_dir_all(&dir).expect("evidence dir");
    std::fs::write(dir.join(format!("{name}-{width}x{height}.bgra")), bgra).expect("evidence written");
}

fn desktop_high() -> DeviceClass {
    DeviceClass::new(FormFactor::Desktop, PerformanceTier::High)
}

/// The capture side.
const SIDE: u32 = 256;
/// The cube's colour (sRGB bytes).
const CUBE: [u8; 4] = [204, 77, 51, 255];
/// The sun: up and to one side, so three faces show three levels.
const SUN: [f32; 3] = [0.45, 0.8, 0.35];

/// Desktop high without the features that keep their own noise or meter the picture (AO, bloom,
/// auto exposure), its fog `fog`.
fn steady(fog: Fog) -> (Quality, Look) {
    let mut quality = preset_quality(QualityPreset::High, desktop_high());
    quality.ao.resolution = AoResolution::Off;
    quality.bloom.enabled = false;
    quality.exposure = false;
    (quality, Look::default().with_fog(fog))
}

/// The light a case draws under.
#[derive(Clone, Copy, Debug)]
enum Light {
    /// The sun and the flat ambient.
    Sun,
    /// The sun under the physical sky (its image-based light).
    SkyIbl,
    /// The sky with height and distance fog.
    SkyFog,
}

/// A renderer drawing desktop high under `light`, its prepass depth and motion kept, with an
/// impostor of the cube baked under each layout (species 0 hemi, 1 sphere).
fn renderer(gpu: &Gpu, light: Light) -> Renderer {
    let mut renderer = Renderer::with_options(gpu, SIDE, SIDE, RenderOptions { msaa: false }).expect("renderer");
    renderer.set_scene_format(SceneFormat::Rgba16Float);
    renderer.set_device_class(desktop_high());
    let fog = match light {
        Light::SkyFog => Fog::default().with_density(0.04).with_range(0.0, 1.0).with_color([0.55, 0.65, 0.8]),
        _ => Fog::default(),
    };
    let (quality, look) = steady(fog);
    renderer.set_quality(&quality);
    renderer.set_look(look);
    if !matches!(light, Light::Sun) {
        renderer.set_environment(&Environment::Sky(SkyParams::default()));
    }
    renderer.set_depth_readback(true);
    // One frame uploads the material table: the cube's colour is row 0.
    renderer.render(gpu, &scene(camera_at(0.0, 3.2), true), CullPath::Gpu).expect("frame");
    for layout in [ImpostorLayout::Hemi, ImpostorLayout::Sphere] {
        renderer.bake_impostor(gpu, &[(MeshId::CUBE, 0)], layout, ImpostorClass::High).expect("bake").expect("under the cap");
    }
    renderer
}

/// The camera on a circle of `distance` round the cube at yaw `yaw`, 25 degrees up.
fn camera_at(yaw: f32, distance: f32) -> CameraDesc {
    let pitch = 25f32.to_radians();
    let eye = [distance * libm::cosf(pitch) * libm::sinf(yaw + 0.6), distance * libm::sinf(pitch), distance * libm::cosf(pitch) * libm::cosf(yaw + 0.6)];
    CameraDesc::look_at(eye, [0.0, 0.0, 0.0])
}

fn scene(camera: CameraDesc, mesh: bool) -> Scene {
    let mut scene = Scene::new(camera, [20, 24, 32, 255]);
    scene.lighting.sun_dir = glam::Vec3::from(SUN).normalize().to_array();
    if mesh {
        scene.draw(MeshId::CUBE, genex_render::scene::translation(0.0, 0.0, 0.0), Material::color(CUBE));
    }
    scene
}

/// What a frame draws in the cube's place.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Subject {
    Nothing,
    Mesh,
    Impostor(u32),
}

/// `subject` drawn `frames` times at `camera` (TAA's history settles), captured.
fn settled(gpu: &Gpu, renderer: &mut Renderer, camera: CameraDesc, subject: Subject, frames: u64) -> Vec<u8> {
    let instances: Vec<ImpostorInstance> = match subject {
        Subject::Impostor(species) => vec![ImpostorInstance::new(genex_render::scene::translation(0.0, 0.0, 0.0), species)],
        _ => Vec::new(),
    };
    renderer.set_impostors(&instances).expect("placed");
    let view = scene(camera, subject == Subject::Mesh);
    for k in 0..frames {
        renderer.set_frame_index(k);
        renderer.render(gpu, &view, CullPath::Gpu).expect("frame");
    }
    renderer.capture(gpu).expect("capture").bgra().to_vec()
}

fn luma(p: &[u8]) -> f32 {
    0.0722 * f32::from(p[0]) + 0.7152 * f32::from(p[1]) + 0.2126 * f32::from(p[2])
}

/// The pixels where `frame` differs from the empty frame `empty` (the subject's silhouette).
fn silhouette(frame: &[u8], empty: &[u8]) -> Vec<bool> {
    frame.chunks(4).zip(empty.chunks(4)).map(|(a, b)| (0..3).map(|c| (i32::from(a[c]) - i32::from(b[c])).abs()).sum::<i32>() > SILHOUETTE_LEVELS).collect()
}

/// A pixel is the subject's where it differs from the empty frame by more than this (summed over
/// the three channels): about half of the cube's darkest face against the backdrop.
const SILHOUETTE_LEVELS: i32 = 24;

fn iou(a: &[bool], b: &[bool]) -> f32 {
    let both = a.iter().zip(b).filter(|(a, b)| **a && **b).count();
    let either = a.iter().zip(b).filter(|(a, b)| **a || **b).count();
    both as f32 / either.max(1) as f32
}

/// Pixels inside `mask` with all four neighbours inside (the silhouette's edge left out).
fn interior(mask: &[bool]) -> Vec<bool> {
    let side = SIDE as usize;
    (0..mask.len())
        .map(|at| {
            let (x, y) = (at % side, at / side);
            let inside = |dx: isize, dy: isize| {
                let (nx, ny) = (x as isize + dx, y as isize + dy);
                nx >= 0 && ny >= 0 && (nx as usize) < side && (ny as usize) < side && mask[ny as usize * side + nx as usize]
            };
            mask[at] && inside(1, 0) && inside(-1, 0) && inside(0, 1) && inside(0, -1)
        })
        .collect()
}

/// Distances from the cube (metres) the rows take: the switch band of a 1 m object on desktop
/// high, its silhouette 80 to 30 pixels across at 256 px and 45 degrees.
const DISTANCES: [f32; 2] = [3.2, 6.0];
/// The frames a still view settles over (TAA's 8-frame jitter cycle, twice).
const SETTLE_FRAMES: u64 = 16;
/// The least silhouette IoU of an impostor against its mesh at the switch (LOD-14).
const IOU_MIN: f32 = 0.95;

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_impostor_vs_mesh_at_the_switch_silhouette_iou_at_least_0_95() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = renderer(&gpu, Light::SkyIbl);
    let mut worst = 1.0f32;
    for distance in DISTANCES {
        for yaw in [0.0f32, 0.9, 2.3] {
            let camera = camera_at(yaw, distance);
            let empty = settled(&gpu, &mut renderer, camera, Subject::Nothing, SETTLE_FRAMES);
            let mesh = settled(&gpu, &mut renderer, camera, Subject::Mesh, SETTLE_FRAMES);
            let mesh_mask = silhouette(&mesh, &empty);
            for (species, layout) in [(0, "hemi"), (1, "sphere")] {
                let impostor = settled(&gpu, &mut renderer, camera, Subject::Impostor(species), SETTLE_FRAMES);
                let impostor_mask = silhouette(&impostor, &empty);
                let score = iou(&mesh_mask, &impostor_mask);
                let pixels = mesh_mask.iter().filter(|m| **m).count();
                eprintln!("distance {distance} yaw {yaw} {layout}: IoU {score:.4} over {pixels} mesh pixels");
                write_capture(&format!("impostor-{layout}-{distance}-{yaw}"), SIDE, SIDE, &impostor);
                write_capture(&format!("mesh-{distance}-{yaw}"), SIDE, SIDE, &mesh);
                write_capture(&format!("empty-{distance}-{yaw}"), SIDE, SIDE, &empty);
                assert!(pixels > 200, "the cube is in view ({pixels} pixels)");
                worst = worst.min(score);
            }
        }
    }
    assert!(worst >= IOU_MIN, "the worst view's IoU {worst} < {IOU_MIN}");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_luminance_within_the_taa_floor_under_sun_ibl_fog() {
    let Some(gpu) = gpu() else { return };
    let floor = genex_render::settings::DEFAULT_TAA_ALPHA_MIN;
    for light in [Light::Sun, Light::SkyIbl, Light::SkyFog] {
        let mut renderer = renderer(&gpu, light);
        for yaw in [0.0f32, 2.3] {
            let camera = camera_at(yaw, DISTANCES[0]);
            let empty = settled(&gpu, &mut renderer, camera, Subject::Nothing, SETTLE_FRAMES);
            let mesh = settled(&gpu, &mut renderer, camera, Subject::Mesh, SETTLE_FRAMES);
            for (species, layout) in [(0, "hemi"), (1, "sphere")] {
                let impostor = settled(&gpu, &mut renderer, camera, Subject::Impostor(species), SETTLE_FRAMES);
                let both: Vec<bool> = interior(&silhouette(&mesh, &empty)).iter().zip(interior(&silhouette(&impostor, &empty))).map(|(a, b)| *a && b).collect();
                let count = both.iter().filter(|b| **b).count();
                let mean = |frame: &[u8]| frame.chunks(4).zip(&both).filter(|(_, b)| **b).map(|(p, _)| luma(p)).sum::<f32>() / count.max(1) as f32;
                let (mesh_luma, impostor_luma) = (mean(&mesh), mean(&impostor));
                let step = (impostor_luma - mesh_luma).abs() / mesh_luma.max(1.0);
                eprintln!("{light:?} yaw {yaw} {layout}: mesh luma {mesh_luma:.2}, impostor {impostor_luma:.2}, step {step:.4} over {count} pixels (floor {floor})");
                if yaw == 0.0 {
                    write_capture(&format!("luma-{light:?}-{layout}-impostor"), SIDE, SIDE, &impostor);
                    write_capture(&format!("luma-{light:?}-mesh"), SIDE, SIDE, &mesh);
                }
                assert!(count > 500, "{light:?}: the cube's inside is in view ({count})");
                assert!(step <= floor, "{light:?} yaw {yaw} {layout}: the switch steps the mean luma by {step} > {floor}");
            }
        }
    }
}

/// The motion row's pan: the camera turns this far round the cube between the two frames.
const PAN_RADIANS: f32 = 0.08;
/// The most the impostor's motion may differ from its mesh's at a pixel both cover, in pixels
/// (median), and the share of such pixels allowed past a pixel.
const MOTION_MEDIAN_PX: f32 = 0.1;
const MOTION_OUTLIER_SHARE: f32 = 0.05;

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_impostor_motion_vectors_reproject_a_panning_camera() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = renderer(&gpu, Light::SkyIbl);
    let mut motion_of = |subject: Subject| {
        let instances: Vec<ImpostorInstance> = match subject {
            Subject::Impostor(species) => vec![ImpostorInstance::new(genex_render::scene::translation(0.0, 0.0, 0.0), species)],
            _ => Vec::new(),
        };
        renderer.set_impostors(&instances).expect("placed");
        renderer.set_frame_index(0);
        renderer.render(&gpu, &scene(camera_at(0.0, DISTANCES[0]), subject == Subject::Mesh), CullPath::Gpu).expect("first frame");
        renderer.set_frame_index(1);
        renderer.render(&gpu, &scene(camera_at(PAN_RADIANS, DISTANCES[0]), subject == Subject::Mesh), CullPath::Gpu).expect("second frame");
        let depth = renderer.read_prepass_depth(&gpu).expect("depth");
        (renderer.read_motion(&gpu).expect("motion"), depth)
    };
    let (mesh, mesh_depth) = motion_of(Subject::Mesh);
    let background = mesh_depth[0];
    for (species, layout) in [(0, "hemi"), (1, "sphere")] {
        let (impostor, impostor_depth) = motion_of(Subject::Impostor(species));
        let half = SIDE as f32 / 2.0;
        let mut errors: Vec<f32> = mesh
            .iter()
            .zip(&impostor)
            .zip(mesh_depth.iter().zip(&impostor_depth))
            .filter(|(_, (a, b))| **a != background && **b != background)
            .map(|((m, i), _)| libm::hypotf((m[0] - i[0]) * half, (m[1] - i[1]) * half))
            .collect();
        errors.sort_by(f32::total_cmp);
        let pan: f32 = {
            let moving: Vec<f32> = mesh.iter().zip(&mesh_depth).filter(|(_, d)| **d != background).map(|(m, _)| libm::hypotf(m[0] * half, m[1] * half)).collect();
            moving.iter().sum::<f32>() / moving.len().max(1) as f32
        };
        assert!(errors.len() > 500, "{layout}: both cover the cube ({} pixels)", errors.len());
        let median = errors[errors.len() / 2];
        let outliers = errors.iter().filter(|e| **e > 1.0).count() as f32 / errors.len() as f32;
        eprintln!("{layout}: the mesh moves {pan:.2} px; impostor against mesh: median {median:.3} px, {outliers:.4} past a pixel, over {} pixels", errors.len());
        assert!(pan > 2.0, "the pan moves the cube on screen ({pan} px)");
        assert!(median <= MOTION_MEDIAN_PX, "{layout}: median motion error {median} px");
        assert!(outliers <= MOTION_OUTLIER_SHARE, "{layout}: {outliers} of the pixels are more than a pixel off");
    }
}
