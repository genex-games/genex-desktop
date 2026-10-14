//! Renderer V1 part 2 (M2.6): counted immediate primitives, the 2D camera, the HUD overlay stage,
//! the WGSL extension points (`Material::custom`, `post_pass`) with their versioned layouts and
//! naga admission, GPU particles, device-loss recovery, HiDPI sizing and pacing, world labels.
//!
//! The CPU rows run everywhere. The GPU rows are `#[ignore]`d and every name contains `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked -- --ignored metal
//!
//! Golden rows compare against `tests/fixtures/render-goldens/part2/<name>.bgra` (raw BGRA, top
//! row first); `GENEX_RENDER_GOLDEN_UPDATE=1` rewrites them instead (review the diff).

use std::path::{Path, PathBuf};

use genex_render::camera2d::Camera2d;
use genex_render::capture::Capture;
use genex_render::device_loss::{DeviceWatch, Resilient};
use genex_render::extension::{
    EXTENSION_API_VERSION, ExtensionContext, ExtensionFault, ExtensionKind, native_features, read_extension_source, validate,
};
use genex_render::immediate::{FrameRenderer, GpuCounters, HUD_TAG, ImmediateFrame, Rect2d, WORLD_TAG};
use genex_render::limits::{EXTENSION_UNIFORM_MAX_BYTES, IMMEDIATE_QUADS_MAX, PARTICLES_PER_EMITTER_MAX, POST_PASSES_MAX};
use genex_render::overlay::OverlayPainter;
use genex_render::pacing::{FramePacer, capture_logical, physical_world_size, present_mode, render_scale};
use genex_render::particles::EmitterDesc;
use genex_render::scene::{CameraDesc, MeshId, scaled, translation};
use genex_render::texture::{TextureData, TextureKind};
use genex_render::world_text::{WorldLabel, project_labels};
use genex_render::{CullPath, Gpu, RenderCode, RenderOptions, WGSL_MAX_BYTES};

const WIDTH: u32 = 128;
const HEIGHT: u32 = 72;
/// A golden pixel may differ by this much per channel (another Apple GPU family rounds differently).
const GOLDEN_CHANNEL_TOLERANCE: u8 = 2;
/// Pixels allowed beyond the channel tolerance (rasterization on edges), of 9216.
const GOLDEN_OUTLIER_PIXELS: usize = 46;

// ---------------------------------------------------------------------------------------------
// Fixtures

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

fn goldens_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../tests/fixtures/render-goldens/part2")
}

/// Compare `capture` with the golden `name`, or rewrite it under `GENEX_RENDER_GOLDEN_UPDATE=1`.
fn check_golden(name: &str, capture: &Capture) {
    assert_eq!((capture.width(), capture.height()), (WIDTH, HEIGHT));
    if let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") {
        let dir = PathBuf::from(dir);
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join(format!("{name}.bgra")), capture.bgra()).expect("evidence");
    }
    let path = goldens_dir().join(format!("{name}.bgra"));
    if std::env::var("GENEX_RENDER_GOLDEN_UPDATE").is_ok_and(|v| v == "1") {
        std::fs::create_dir_all(goldens_dir()).expect("goldens folder");
        std::fs::write(&path, capture.bgra()).expect("golden written");
        return;
    }
    let golden = std::fs::read(&path)
        .unwrap_or_else(|error| panic!("golden {path:?} missing ({error}); render it with GENEX_RENDER_GOLDEN_UPDATE=1"));
    assert_eq!(golden.len(), capture.bgra().len(), "{name}: golden size");
    let mut outliers = 0;
    let mut worst = 0u8;
    for (a, b) in golden.chunks(4).zip(capture.bgra().chunks(4)) {
        let diff = a.iter().zip(b).map(|(x, y)| x.abs_diff(*y)).max().unwrap_or(0);
        worst = worst.max(diff);
        if diff > GOLDEN_CHANNEL_TOLERANCE {
            outliers += 1;
        }
    }
    assert!(outliers <= GOLDEN_OUTLIER_PIXELS, "{name}: {outliers} pixels differ from the golden by more than {GOLDEN_CHANNEL_TOLERANCE} (worst {worst})");
}

fn pixel(capture: &Capture, x: u32, y: u32) -> [u8; 4] {
    let i = ((y * capture.width() + x) * 4) as usize;
    capture.bgra()[i..i + 4].try_into().expect("pixel")
}

fn camera() -> CameraDesc {
    CameraDesc::look_at([0.0, 3.0, 8.0], [0.0, 0.5, 0.0])
}

fn core() -> ExtensionContext {
    ExtensionContext::core()
}

/// A material that stripes its mesh with its uniforms' colour and the draw's tint.
const STRIPES: &str = "
struct Params { color: vec4<f32>, stripes: vec4<f32> }
@group(2) @binding(0) var<uniform> params: Params;

@fragment
fn fs_material(in: GxMaterialIn) -> @location(0) vec4<f32> {
    let band = step(0.5, fract(in.uv.x * params.stripes.x));
    return vec4<f32>(mix(params.color.rgb, in.tint.rgb, band), 1.0);
}
";

/// The stripes' uniforms: red, four stripes.
fn stripes_uniforms() -> Vec<u8> {
    bytemuck::cast_slice(&[0.9f32, 0.1, 0.1, 1.0, 4.0, 0.0, 0.0, 0.0]).to_vec()
}

/// A post pass that inverts the frame.
const INVERT: &str = "
@fragment
fn fs_post(in: GxPostIn) -> @location(0) vec4<f32> {
    let c = textureLoad(gx_source, vec2<i32>(in.position.xy), 0);
    return vec4<f32>(1.0 - c.rgb, 1.0);
}
";

/// A material whose fragment stage needs subgroups (a native-enhanced feature).
const SUBGROUP_MATERIAL: &str = "
@fragment
fn fs_material(in: GxMaterialIn) -> @location(0) vec4<f32> {
    let lanes = subgroupAdd(1.0);
    return vec4<f32>(in.tint.rgb, lanes);
}
";

fn fault(error: &genex_render::RenderError) -> Option<ExtensionFault> {
    ExtensionFault::of(error)
}

// ---------------------------------------------------------------------------------------------
// WGSL extensions: versioned layouts, naga admission, caps (CPU)

#[test]
fn the_extension_api_version_is_the_hosts_and_is_recorded_on_every_admitted_extension() {
    let fixture = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../tests/fixtures/native-wire-v2.json"))
        .expect("native-wire-v2.json");
    let wire: serde_json::Value = serde_json::from_str(&fixture).expect("fixture json");
    assert_eq!(wire["extensionApi"].as_u64(), Some(u64::from(EXTENSION_API_VERSION)), "the host's NATIVE_EXTENSION_API_VERSION");
    let material = validate(ExtensionKind::Material, STRIPES, &core()).expect("stripes validate against core");
    // `validate` admits at API v1: an extension records the api it was admitted under (RQ1.3), not
    // the highest one served.
    assert_eq!(material.api_version(), genex_render::abi::ABI_V1);
    assert!(genex_render::EXTENSION_APIS.contains(&material.api_version()));
    assert_eq!(material.uniform_bytes(), Some(32));
    assert!(material.native_features().is_empty(), "core needs no native feature");
    let post = validate(ExtensionKind::PostPass, INVERT, &core()).expect("invert validates against core");
    assert_eq!(post.uniform_bytes(), None);
    assert_eq!(post.kind(), ExtensionKind::PostPass);
    // genex.toml's `[[wgsl]] kind` spellings (the facade's and the host's `WgslKind`).
    assert_eq!((ExtensionKind::Material.wire(), ExtensionKind::PostPass.wire()), ("material", "post"));
}

#[test]
fn a_shader_over_wgsl_max_bytes_is_refused_before_naga_parses_it() {
    let padding = " ".repeat(WGSL_MAX_BYTES + 1 - INVERT.len());
    let oversize = format!("{INVERT}{padding}");
    assert_eq!(oversize.len(), WGSL_MAX_BYTES + 1);
    let error = validate(ExtensionKind::PostPass, &oversize, &core()).expect_err("oversize refused");
    assert_eq!(error.code(), RenderCode::WgslTooLarge);
    assert_eq!(fault(&error), Some(ExtensionFault::TooLarge));
    let exactly = format!("{INVERT}{}", " ".repeat(WGSL_MAX_BYTES - INVERT.len()));
    validate(ExtensionKind::PostPass, &exactly, &core()).expect("exactly WGSL_MAX_BYTES is admitted");
}

#[test]
fn an_extension_with_a_non_matching_bind_layout_is_refused_at_naga_validation() {
    let fragment = "\n@fragment fn fs_material(in: GxMaterialIn) -> @location(0) vec4<f32> { return in.tint; }\n";
    let post_fragment = "\n@fragment fn fs_post(in: GxPostIn) -> @location(0) vec4<f32> { return vec4<f32>(1.0); }\n";
    let too_big = format!("struct Big {{ v: array<vec4<f32>, {}> }}", EXTENSION_UNIFORM_MAX_BYTES / 16 + 1);
    let rows: &[(&str, ExtensionKind, String)] = &[
        ("a texture in the renderer's frame group", ExtensionKind::Material, "@group(0) @binding(5) var t: texture_2d<f32>;".to_owned()),
        ("a second binding in the uniforms group", ExtensionKind::Material, "@group(2) @binding(1) var<uniform> u: vec4<f32>;".to_owned()),
        ("a storage buffer where the uniforms go", ExtensionKind::Material, "@group(2) @binding(0) var<storage, read_write> s: array<u32>;".to_owned()),
        ("a group past the layout", ExtensionKind::Material, "@group(3) @binding(0) var<uniform> u: vec4<f32>;".to_owned()),
        ("a sampler where the uniforms go", ExtensionKind::Material, "@group(2) @binding(0) var s: sampler;".to_owned()),
        ("uniforms above the cap", ExtensionKind::Material, format!("{too_big}\n@group(2) @binding(0) var<uniform> u: Big;")),
        ("a post pass binding in the material's group", ExtensionKind::PostPass, "@group(2) @binding(0) var<uniform> u: vec4<f32>;".to_owned()),
        ("a post pass texture beside the source", ExtensionKind::PostPass, "@group(0) @binding(3) var t: texture_2d<f32>;".to_owned()),
    ];
    for (name, kind, declaration) in rows {
        let entry = if *kind == ExtensionKind::Material { fragment } else { post_fragment };
        let source = format!("{declaration}{entry}");
        let error = validate(*kind, &source, &core()).expect_err(name);
        assert_eq!(error.code(), RenderCode::WgslTooLarge, "{name}: naga's refusal code");
        assert_eq!(fault(&error), Some(ExtensionFault::LayoutMismatch), "{name}: {error}");
    }
}

#[test]
fn an_extension_without_its_entry_point_or_with_stray_ones_or_bad_wgsl_is_refused() {
    let rows: &[(&str, ExtensionKind, &str, ExtensionFault)] = &[
        ("no fs_material", ExtensionKind::Material, "@fragment fn main(in: GxMaterialIn) -> @location(0) vec4<f32> { return in.tint; }", ExtensionFault::EntryPoint),
        ("no fs_post", ExtensionKind::PostPass, "fn helper() -> f32 { return 1.0; }", ExtensionFault::EntryPoint),
        (
            "a compute entry point",
            ExtensionKind::PostPass,
            "@fragment fn fs_post(in: GxPostIn) -> @location(0) vec4<f32> { return vec4<f32>(1.0); }\n@compute @workgroup_size(1) fn spin() {}",
            ExtensionFault::EntryPoint,
        ),
        ("a parse error", ExtensionKind::Material, "@fragment fn fs_material(in: GxMaterialIn) -> @location(0) vec4<f32> { return in.tint }", ExtensionFault::Invalid),
        ("a redefined prelude name", ExtensionKind::Material, "struct GxMaterialIn { x: f32 }", ExtensionFault::Invalid),
        ("a type error", ExtensionKind::PostPass, "@fragment fn fs_post(in: GxPostIn) -> @location(0) vec4<f32> { return 1u; }", ExtensionFault::Invalid),
    ];
    for (name, kind, source, expected) in rows {
        let error = validate(*kind, source, &core()).expect_err(name);
        assert_eq!(error.code(), RenderCode::WgslTooLarge, "{name}");
        assert_eq!(fault(&error), Some(*expected), "{name}: {error}");
    }
}

#[test]
fn an_extension_using_an_undeclared_native_feature_is_refused_native_feature_missing() {
    let error = validate(ExtensionKind::Material, SUBGROUP_MATERIAL, &core()).expect_err("subgroups are not core");
    assert_eq!(error.code(), RenderCode::NativeFeatureMissing, "{error}");
    let subgroup = native_features(&["subgroup"]).expect("a known feature");
    assert_eq!(subgroup, wgpu::Features::SUBGROUP);
    let declared_not_offered = ExtensionContext::new(subgroup, wgpu::Features::empty());
    let error = declared_not_offered.check_device().expect_err("the device lacks a declared feature");
    assert_eq!(error.code(), RenderCode::NativeFeatureMissing);
    let error = validate(ExtensionKind::Material, SUBGROUP_MATERIAL, &declared_not_offered).expect_err("declared but not offered");
    assert_eq!(error.code(), RenderCode::NativeFeatureMissing);
    let offered_not_declared = ExtensionContext::new(wgpu::Features::empty(), subgroup);
    let error = validate(ExtensionKind::Material, SUBGROUP_MATERIAL, &offered_not_declared).expect_err("offered but not declared");
    assert_eq!(error.code(), RenderCode::NativeFeatureMissing, "undeclared features are never requested");
    let both = ExtensionContext::new(subgroup, subgroup);
    both.check_device().expect("declared and offered");
    let admitted = validate(ExtensionKind::Material, SUBGROUP_MATERIAL, &both).expect("declared and offered");
    assert_eq!(admitted.native_features(), subgroup);
    let more = native_features(&["subgroup", "texture-binding-array"]).expect("known features");
    let admitted = validate(ExtensionKind::Material, SUBGROUP_MATERIAL, &ExtensionContext::new(more, more)).expect("a superset");
    assert_eq!(admitted.native_features(), subgroup, "only the features the source needs");
    let core_source = validate(ExtensionKind::Material, STRIPES, &ExtensionContext::new(more, more)).expect("core source");
    assert!(core_source.native_features().is_empty(), "a core source needs nothing however much is declared");
    let unknown = native_features(&["subgroup", "warp-drive"]).expect_err("an unknown feature name");
    assert_eq!(unknown.code(), RenderCode::NativeFeatureMissing);
}

#[test]
fn extension_sources_resolve_inside_the_game_root_as_regular_files_only() {
    let root = std::env::temp_dir().join(format!("genex-render-ext-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let outside = root.with_extension("outside");
    std::fs::create_dir_all(root.join("shaders")).expect("root");
    std::fs::create_dir_all(&outside).expect("outside");
    std::fs::write(root.join("shaders/invert.wgsl"), INVERT).expect("source");
    std::fs::write(outside.join("secret.wgsl"), INVERT).expect("outside source");
    std::fs::write(root.join("shaders/huge.wgsl"), " ".repeat(WGSL_MAX_BYTES + 1)).expect("huge");
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(outside.join("secret.wgsl"), root.join("shaders/link.wgsl")).expect("symlink");
        std::os::unix::fs::symlink(&outside, root.join("escape")).expect("dir symlink");
    }
    assert_eq!(read_extension_source(&root, "shaders/invert.wgsl").expect("inside"), INVERT);
    let hostile: &[(&str, ExtensionFault)] = &[
        ("../outside/secret.wgsl", ExtensionFault::PathRefused),
        ("shaders/../../outside/secret.wgsl", ExtensionFault::PathRefused),
        ("/etc/hosts", ExtensionFault::PathRefused),
        ("", ExtensionFault::PathRefused),
        ("shaders", ExtensionFault::PathRefused),
        ("shaders/missing.wgsl", ExtensionFault::PathRefused),
        ("shaders/link.wgsl", ExtensionFault::PathRefused),
        ("escape/secret.wgsl", ExtensionFault::PathRefused),
        ("shaders/huge.wgsl", ExtensionFault::TooLarge),
    ];
    for (path, expected) in hostile {
        let error = read_extension_source(&root, path).expect_err(path);
        assert_eq!(error.code(), RenderCode::WgslTooLarge, "{path}");
        assert_eq!(fault(&error), Some(*expected), "{path}: {error}");
    }
    // No side effect: the tree is as it was.
    assert_eq!(std::fs::read_to_string(outside.join("secret.wgsl")).expect("untouched"), INVERT);
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&outside);
}

#[test]
fn the_part2_gpu_structs_equal_the_wgsl_sizes_naga_computes() {
    for gpu in genex_render::immediate::PART2_GPU_STRUCTS {
        assert!(gpu.rust_align <= 4, "{} holds no glam-aligned field", gpu.wgsl);
        let mut found = 0;
        for (shader, source) in genex_render::shaders::SHADERS {
            let module = naga::front::wgsl::parse_str(source).unwrap_or_else(|e| panic!("{shader}: {}", e.emit_to_string(source)));
            let mut layouter = naga::proc::Layouter::default();
            layouter.update(module.to_ctx()).expect("layout");
            for (handle, ty) in module.types.iter() {
                if ty.name.as_deref() == Some(gpu.wgsl) {
                    assert_eq!(layouter[handle].size as usize, gpu.rust_size, "{} in {shader}", gpu.wgsl);
                    found += 1;
                }
            }
        }
        assert!(found > 0, "{} is declared by some shader", gpu.wgsl);
    }
}

// ---------------------------------------------------------------------------------------------
// Immediate primitives and the tagged draw counter (CPU)

#[test]
fn the_tagged_draw_counter_counts_logical_draws_per_tag_in_first_use_order() {
    let mut frame = ImmediateFrame::new(camera(), [0, 0, 0, 255]);
    frame.cube(translation(0.0, 0.5, 0.0), [200, 40, 40, 255]);
    frame.sphere([1.5, 0.5, 0.0], 0.5, [40, 200, 40, 255]);
    frame.instanced(MeshId::CUBE, &[translation(-2.0, 0.0, 0.0), translation(-3.0, 0.0, 0.0), translation(-4.0, 0.0, 0.0)], [90, 90, 90, 255]);
    frame.tag("debug");
    frame.line([0.0, 0.0, 0.0], [0.0, 2.0, 0.0], [255, 255, 0, 255]);
    frame.tag("ui");
    for i in 0..10 {
        frame.rect(Rect2d::new(4.0 + i as f32 * 6.0, 4.0, 4.0, 4.0), [255, 255, 255, 255]);
    }
    frame.line2d([0.0, 70.0], [127.0, 70.0], 2.0, [0, 128, 255, 255]);
    frame.tag(WORLD_TAG);
    frame.cube(translation(0.0, 2.0, 0.0), [10, 10, 10, 255]);
    let tags: Vec<(&str, u32)> = frame.tags().iter().map(|(tag, n)| (tag.as_str(), *n)).collect();
    assert_eq!(tags, vec![(WORLD_TAG, 4), ("debug", 1), ("ui", 11)]);
    assert_eq!(frame.draw_calls(), 16);
    assert_eq!(frame.scene().logical_draws(), 5, "the 3D draws reach the scene's own counter, one per call");
    assert_eq!(frame.quads(), 11);
}

#[test]
fn immediate_quads_above_the_cap_are_refused_upload_budget_when_rendered() {
    let mut frame = ImmediateFrame::new(camera(), [0, 0, 0, 255]);
    for _ in 0..=IMMEDIATE_QUADS_MAX {
        frame.rect(Rect2d::new(0.0, 0.0, 1.0, 1.0), [255, 255, 255, 255]);
    }
    let error = frame.check_caps().expect_err("one quad over the cap");
    assert_eq!(error.code(), RenderCode::UploadBudget);
}

#[test]
fn the_volatile_gpu_counters_serialize_under_their_wire_names() {
    let counters = GpuCounters { encoder_draws: 3, dispatches: 2, passes: 5 };
    assert_eq!(counters.to_json(), r#"{"encoderDraws":3,"dispatches":2,"passes":5}"#);
}

// ---------------------------------------------------------------------------------------------
// 2D camera (CPU)

fn close(a: [f32; 2], b: [f32; 2]) -> bool {
    (a[0] - b[0]).abs() < 1e-4 && (a[1] - b[1]).abs() < 1e-4
}

#[test]
fn the_2d_camera_maps_world_to_screen_and_back() {
    assert!(close(Camera2d::SCREEN.world_to_screen([12.0, 34.0]), [12.0, 34.0]));
    let camera = Camera2d { target: [100.0, 50.0], offset: [64.0, 36.0], rotation_degrees: 90.0, zoom: 2.0 };
    assert!(close(camera.world_to_screen([100.0, 50.0]), [64.0, 36.0]), "the target lands on the offset");
    // +x in the world turns to +y on screen at 90° (screen y points down), twice as long.
    assert!(close(camera.world_to_screen([101.0, 50.0]), [64.0, 38.0]));
    for point in [[0.0, 0.0], [17.5, -3.25], [100.0, 50.0], [-40.0, 90.0]] {
        assert!(close(camera.screen_to_world(camera.world_to_screen(point)), point), "{point:?} round trips");
    }
    let view_proj = glam::Mat4::from_cols_array(&Camera2d::SCREEN.view_proj((WIDTH, HEIGHT)));
    let ndc = |x: f32, y: f32| {
        let p = view_proj * glam::Vec4::new(x, y, 0.0, 1.0);
        [p.x / p.w, p.y / p.w]
    };
    assert!(close(ndc(0.0, 0.0), [-1.0, 1.0]), "the top-left pixel corner is NDC (-1, 1)");
    assert!(close(ndc(WIDTH as f32, HEIGHT as f32), [1.0, -1.0]), "the bottom-right corner is NDC (1, -1)");
}

// ---------------------------------------------------------------------------------------------
// HiDPI and pacing (CPU)

#[test]
fn the_world_target_scales_by_the_device_pixel_ratio_up_to_two() {
    let rows: &[(f64, f32)] = &[(f64::NAN, 1.0), (f64::INFINITY, 1.0), (-1.0, 1.0), (0.0, 1.0), (0.5, 1.0), (1.0, 1.0), (1.5, 1.5), (2.0, 2.0), (3.0, 2.0)];
    for (dpr, scale) in rows {
        assert_eq!(render_scale(*dpr), *scale, "dpr {dpr}");
    }
    assert_eq!(physical_world_size((640, 360), 2.0), (1280, 720));
    assert_eq!(physical_world_size((640, 360), 1.5), (960, 540));
    assert_eq!(physical_world_size((3000, 2000), 2.0), (4096, 4000), "each side stays within MAX_WORLD_PX");
}

#[test]
fn presentation_is_fifo_and_the_sim_runs_60_hz_with_repeated_frames_at_higher_refresh() {
    use wgpu::PresentMode;
    assert_eq!(present_mode(&[PresentMode::Mailbox, PresentMode::Fifo, PresentMode::Immediate]), PresentMode::Fifo);
    assert_eq!(present_mode(&[PresentMode::Immediate]), PresentMode::AutoVsync);
    let mut pacer = FramePacer::default();
    let frames: Vec<(u32, bool)> = (0..8).map(|_| pacer.display_frame(1000.0 / 120.0)).map(|f| (f.ticks, f.repeat)).collect();
    assert_eq!(frames.iter().map(|f| f.0).sum::<u32>(), 4, "eight 120 Hz frames run four 60 Hz ticks");
    assert!(frames.iter().all(|(ticks, repeat)| (*ticks == 0) == *repeat), "a frame with no tick repeats the last one");
    let mut pacer = FramePacer::default();
    assert_eq!(pacer.display_frame(1000.0 / 60.0).ticks, 1);
    assert_eq!(pacer.display_frame(1000.0 / 30.0).ticks, 2, "a slow display runs two ticks a frame");
}

// ---------------------------------------------------------------------------------------------
// World labels (CPU)

#[test]
fn world_labels_project_to_world_pixels_far_to_near_and_drop_what_is_behind_or_outside() {
    let view_proj = camera().view_proj(WIDTH as f32 / HEIGHT as f32);
    let labels = vec![
        WorldLabel::new([0.0, 0.5, 0.0], "centre", [255, 255, 255, 255]),
        WorldLabel::new([0.0, 0.5, 20.0], "behind", [255, 255, 255, 255]),
        WorldLabel::new([400.0, 0.5, 0.0], "outside", [255, 255, 255, 255]),
        WorldLabel::new([0.0, 0.5, -10.0], "far", [255, 255, 255, 255]),
    ];
    let projected = project_labels(&labels, view_proj.to_cols_array(), (WIDTH, HEIGHT));
    let names: Vec<&str> = projected.iter().map(|p| p.text.as_str()).collect();
    assert_eq!(names, vec!["far", "centre"], "far first, so nearer labels paint over it");
    let centre = &projected[1];
    assert!((centre.x - WIDTH as f32 / 2.0).abs() < 0.5 && (centre.y - HEIGHT as f32 / 2.0).abs() < 0.5, "{centre:?}");
}

// ---------------------------------------------------------------------------------------------
// Particles (CPU)

#[test]
fn an_emitter_holds_rate_times_lifetime_slots_within_the_cap() {
    let desc = EmitterDesc::fountain([0.0, 0.0, 0.0], 7);
    assert_eq!(desc.slots(), desc.rate_per_tick * desc.lifetime_ticks);
    let too_many = EmitterDesc { rate_per_tick: PARTICLES_PER_EMITTER_MAX, lifetime_ticks: 2, ..desc };
    assert_eq!(too_many.check().expect_err("over the cap").code(), RenderCode::BufferTooLarge);
    let none = EmitterDesc { rate_per_tick: 0, ..desc };
    assert_eq!(none.check().expect_err("an empty emitter").code(), RenderCode::BufferTooLarge);
}

// ---------------------------------------------------------------------------------------------
// GPU rows

/// A test HUD: one load-and-store pass over the target, reporting `primitives` painted (the
/// overlay stage counts what the painter reports; egui's painter is genex-hud's).
struct CountingOverlay {
    primitives: u32,
}

impl OverlayPainter for CountingOverlay {
    fn paint(&mut self, _gpu: &Gpu, encoder: &mut wgpu::CommandEncoder, target: &wgpu::TextureView, _size: [u32; 2]) -> u32 {
        let _pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("test overlay"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: target,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store },
            })],
            ..Default::default()
        });
        self.primitives
    }
}

fn base_frame() -> ImmediateFrame {
    let mut frame = ImmediateFrame::new(camera(), [20, 24, 32, 255]);
    frame.mesh(MeshId::CUBE, scaled([0.0, -0.05, 0.0], [8.0, 0.1, 8.0]), genex_render::scene::Material::color([110, 110, 120, 255]));
    frame.cube(translation(-1.5, 0.5, 0.0), [200, 60, 50, 255]);
    frame.sphere([1.5, 0.6, 0.0], 0.6, [60, 160, 220, 255]);
    frame
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_tagged_draw_count_equals_logical_draws_not_gpu_encoder_draws() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = FrameRenderer::new(&gpu, WIDTH, HEIGHT, RenderOptions::default()).expect("renderer");
    let mut frame = base_frame();
    let models: Vec<[f32; 16]> = (0..40).map(|i| translation(-4.0 + (i % 8) as f32, 0.2, -2.0 - (i / 8) as f32)).collect();
    frame.instanced(MeshId::CUBE, &models, [180, 180, 60, 255]);
    frame.tag("ui");
    for i in 0..100 {
        frame.rect(Rect2d::new((i % 20) as f32 * 6.0, (i / 20) as f32 * 6.0, 4.0, 4.0), [255, 255, 255, 255]);
    }
    let mut hud = CountingOverlay { primitives: 2 };
    let report = renderer.render(&gpu, &frame, CullPath::Gpu, Some(&mut hud)).expect("frame");
    assert_eq!(report.draw_calls, 4 + 100 + 2, "world 4 (ground, cube, sphere, one instanced call), ui 100, hud 2");
    let tags: Vec<(&str, u32)> = report.tags.iter().map(|(tag, n)| (tag.as_str(), *n)).collect();
    assert_eq!(tags, vec![(WORLD_TAG, 4), ("ui", 100), (HUD_TAG, 2)]);
    assert_ne!(report.gpu.encoder_draws, report.draw_calls, "the GPU encoder count is not the logical count");
    assert!(report.gpu.encoder_draws <= 6, "one multi-draw for the batches, one 2D batch, two HUD: {:?}", report.gpu);
    assert!(report.gpu.dispatches >= 1, "the compute cull ran");
    let culled = renderer.render(&gpu, &frame, CullPath::Cpu, None).expect("cpu frame");
    assert_eq!(culled.draw_calls, report.draw_calls - 2, "culling and the cull path never change the logical count");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_golden_immediate_2d_under_the_2d_camera() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = FrameRenderer::new(&gpu, WIDTH, HEIGHT, RenderOptions::default()).expect("renderer");
    let checker = TextureData::rgba8(8, 8, (0..64).flat_map(|i| if (i % 8 + i / 8) % 2 == 0 { [255, 255, 255, 255] } else { [30, 30, 30, 255] }).collect())
        .expect("checker");
    let texture = renderer.add_texture(&gpu, &checker, TextureKind::Color).expect("texture");
    let mut frame = base_frame();
    frame.camera2d(Camera2d { target: [64.0, 36.0], offset: [64.0, 36.0], rotation_degrees: 15.0, zoom: 1.25 });
    frame.rect(Rect2d::new(8.0, 8.0, 24.0, 12.0), [255, 200, 0, 255]);
    frame.rect(Rect2d::new(20.0, 14.0, 24.0, 12.0), [0, 120, 255, 128]);
    frame.sprite(texture, Rect2d::new(80.0, 10.0, 32.0, 32.0), [255, 255, 255, 255]);
    frame.line2d([10.0, 60.0], [118.0, 50.0], 3.0, [255, 60, 200, 255]);
    renderer.render(&gpu, &frame, CullPath::Gpu, None).expect("frame");
    let capture = renderer.capture(&gpu).expect("capture");
    check_golden("immediate-2d", &capture);
    let mut screen = base_frame();
    screen.rect(Rect2d::new(0.0, 0.0, 4.0, 4.0), [255, 0, 0, 255]);
    renderer.render(&gpu, &screen, CullPath::Gpu, None).expect("frame");
    let capture = renderer.capture(&gpu).expect("capture");
    assert_eq!(pixel(&capture, 1, 1), [0, 0, 255, 255], "a rect at the screen camera covers its pixels (BGRA red)");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_golden_custom_material_is_depth_tested_against_the_world() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = FrameRenderer::new(&gpu, WIDTH, HEIGHT, RenderOptions::default()).expect("renderer");
    let stripes = renderer.add_material(&gpu, STRIPES, &stripes_uniforms()).expect("material admitted");
    let mut frame = base_frame();
    frame.custom(MeshId::CUBE, scaled([0.0, 0.75, 1.0], [1.5, 1.5, 1.5]), stripes, [240, 240, 240, 255]);
    // A wall in front of half of it: the material must be hidden behind the world's depth.
    frame.cube(scaled([-0.9, 0.75, 2.8], [1.2, 2.0, 0.2]), [40, 200, 90, 255]);
    let report = renderer.render(&gpu, &frame, CullPath::Gpu, None).expect("frame");
    assert_eq!(report.draw_calls, 5);
    let capture = renderer.capture(&gpu).expect("capture");
    check_golden("custom-material", &capture);
    let error = renderer.add_material(&gpu, STRIPES, &[0u8; 16]).expect_err("uniforms of the wrong size");
    assert_eq!(error.code(), RenderCode::WgslTooLarge);
    assert_eq!(fault(&error), Some(ExtensionFault::LayoutMismatch));
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_golden_post_pass_inverts_the_frame_before_the_hud() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = FrameRenderer::new(&gpu, WIDTH, HEIGHT, RenderOptions::default()).expect("renderer");
    let invert = renderer.add_post_pass(&gpu, INVERT, &[]).expect("post pass admitted");
    let frame = base_frame();
    renderer.render(&gpu, &frame, CullPath::Gpu, None).expect("frame");
    let plain = renderer.capture(&gpu).expect("capture");
    let mut inverted_frame = base_frame();
    inverted_frame.post_pass(invert);
    let report = renderer.render(&gpu, &inverted_frame, CullPath::Gpu, None).expect("frame");
    assert_eq!(report.draw_calls, 4, "a post pass is one logical draw");
    let inverted = renderer.capture(&gpu).expect("capture");
    for (a, b) in plain.bgra().chunks(4).zip(inverted.bgra().chunks(4)) {
        assert_eq!([255 - a[0], 255 - a[1], 255 - a[2], 255], [b[0], b[1], b[2], b[3]]);
    }
    check_golden("post-invert", &inverted);
    for _ in 1..POST_PASSES_MAX {
        renderer.add_post_pass(&gpu, INVERT, &[]).expect("within the cap");
    }
    let error = renderer.add_post_pass(&gpu, INVERT, &[]).expect_err("one post pass over the cap");
    assert_eq!(error.code(), RenderCode::WgslTooLarge);
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_an_extension_needing_an_undeclared_native_feature_is_refused_on_the_device() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = FrameRenderer::new(&gpu, WIDTH, HEIGHT, RenderOptions::default()).expect("renderer");
    let error = renderer.add_material(&gpu, SUBGROUP_MATERIAL, &[]).expect_err("subgroups were never declared");
    assert_eq!(error.code(), RenderCode::NativeFeatureMissing);
    // The device is opened with core only: a game declaring a feature it was not opened with is refused.
    let error = FrameRenderer::with_native_features(&gpu, WIDTH, HEIGHT, RenderOptions::default(), wgpu::Features::SUBGROUP)
        .err()
        .expect("declared but not on the device");
    assert_eq!(error.code(), RenderCode::NativeFeatureMissing);
}

/// Particles never reach the simulation: the renderer takes an emitter and a tick and nothing of a
/// game's state, so the state checksum cannot depend on them. That holds by the API's shape, not by
/// a run; the checksum rows that drive a real simulation with GPU work every frame are the facade's
/// (`genex::gpu` and the custom-pass example's 600-tick rows), and particles join them when the
/// facade draws emitters.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_golden_particles_draw_as_a_pure_function_of_the_emitter_and_the_tick() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = FrameRenderer::new(&gpu, WIDTH, HEIGHT, RenderOptions::default()).expect("renderer");
    let emitter = renderer.add_emitter(&gpu, EmitterDesc::fountain([0.0, 0.2, 1.0], 7)).expect("emitter");
    renderer.render(&gpu, &base_frame(), CullPath::Gpu, None).expect("frame");
    let without = renderer.capture(&gpu).expect("capture");
    let mut last = None;
    for tick in [30u64, 60, 90] {
        let mut frame = base_frame();
        frame.particles(emitter, tick);
        let report = renderer.render(&gpu, &frame, CullPath::Gpu, None).expect("frame");
        assert_eq!(report.draw_calls, 4, "an emitter is one logical draw");
        last = Some(renderer.capture(&gpu).expect("capture"));
    }
    let with = last.expect("a particle frame");
    assert_ne!(with.digest(), without.digest(), "the particles drew");
    check_golden("particles", &with);
    // Particles are a pure function of (emitter, tick): a fresh renderer drawing tick 90 directly
    // matches the one that drew 30 and 60 first (Live and capture agree whatever came before).
    let mut fresh = FrameRenderer::new(&gpu, WIDTH, HEIGHT, RenderOptions::default()).expect("renderer");
    let emitter = fresh.add_emitter(&gpu, EmitterDesc::fountain([0.0, 0.2, 1.0], 7)).expect("emitter");
    let mut frame = base_frame();
    frame.particles(emitter, 90);
    fresh.render(&gpu, &frame, CullPath::Gpu, None).expect("frame");
    assert_eq!(fresh.capture(&gpu).expect("capture").digest(), with.digest());
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_forced_device_loss_answers_device_lost_then_recovers_with_an_identical_digest() {
    let Some(gpu) = gpu() else { return };
    let mut resilient = Resilient::new(gpu, WIDTH, HEIGHT, RenderOptions::default(), Gpu::headless).expect("resilient renderer");
    let checker = TextureData::rgba8(2, 2, vec![255, 255, 255, 255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255]).expect("checker");
    let texture = resilient.add_texture(&checker, TextureKind::Color).expect("texture");
    let stripes = resilient.add_material(STRIPES, &stripes_uniforms()).expect("material");
    let invert = resilient.add_post_pass(INVERT, &[]).expect("post pass");
    let emitter = resilient.add_emitter(EmitterDesc::fountain([0.0, 0.2, 1.0], 3)).expect("emitter");
    // Changed uniforms are what the replay restores, not the ones the material was added with.
    let blue: Vec<u8> = bytemuck::cast_slice(&[0.1f32, 0.2, 0.9, 1.0, 6.0, 0.0, 0.0, 0.0]).to_vec();
    resilient.set_material_uniforms(stripes, &blue).expect("uniforms");
    let build = || {
        let mut frame = base_frame();
        frame.custom(MeshId::SPHERE, translation(0.0, 1.5, 0.0), stripes, [255, 255, 255, 255]);
        frame.sprite(texture, Rect2d::new(4.0, 4.0, 16.0, 16.0), [255, 255, 255, 255]);
        frame.particles(emitter, 45);
        frame.post_pass(invert);
        frame
    };
    resilient.render(&build(), CullPath::Gpu, None).expect("frame");
    let before = resilient.capture().expect("capture");
    assert_eq!(resilient.generation(), 0);
    resilient.force_device_loss();
    let refused = resilient.capture().expect_err("capture while the device is lost");
    assert_eq!(refused.code(), RenderCode::DeviceLost);
    assert_eq!(resilient.render(&build(), CullPath::Gpu, None).expect_err("a frame while lost").code(), RenderCode::DeviceLost);
    assert!(resilient.recover().expect("recovered"), "a lost device is re-created");
    assert_eq!(resilient.generation(), 1, "the Live sender re-announces a new ring generation");
    resilient.render(&build(), CullPath::Gpu, None).expect("frame after recovery");
    let after = resilient.capture().expect("capture after recovery");
    assert_eq!(after.digest(), before.digest(), "the re-uploaded CPU cache draws the identical frame");
    assert!(!resilient.recover().expect("nothing to do"), "a healthy device is left alone");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_device_watch_sees_a_destroyed_device_as_lost() {
    let Some(gpu) = gpu() else { return };
    let watch = DeviceWatch::attach(&gpu);
    assert!(!watch.is_lost());
    watch.force_loss(&gpu);
    assert!(watch.is_lost());
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_hidpi_world_target_captures_at_the_logical_world_size() {
    let Some(gpu) = gpu() else { return };
    // The 2D camera scales the world by the render scale, so the same frame lands on twice the pixels.
    let flat = |view: Camera2d| {
        let mut frame = ImmediateFrame::new(camera(), [40, 80, 120, 255]);
        frame.camera2d(view);
        frame.rect(Rect2d::new(0.0, 0.0, 64.0, 72.0), [200, 100, 50, 255]);
        frame.rect(Rect2d::new(80.0, 10.0, 16.0, 30.0), [20, 220, 90, 255]);
        frame
    };
    let mut logical = FrameRenderer::new(&gpu, WIDTH, HEIGHT, RenderOptions::default()).expect("renderer");
    logical.render(&gpu, &flat(Camera2d::SCREEN), CullPath::Gpu, None).expect("frame");
    let one = logical.capture(&gpu).expect("capture");
    let (w, h) = physical_world_size((WIDTH, HEIGHT), 2.0);
    assert_eq!((w, h), (2 * WIDTH, 2 * HEIGHT));
    let mut hidpi = FrameRenderer::new(&gpu, w, h, RenderOptions::default()).expect("renderer");
    hidpi.render(&gpu, &flat(Camera2d { zoom: 2.0, ..Camera2d::SCREEN }), CullPath::Gpu, None).expect("frame");
    let two = capture_logical(hidpi.renderer(), &gpu, (WIDTH, HEIGHT)).expect("logical capture");
    assert_eq!((two.width(), two.height()), (WIDTH, HEIGHT));
    let differing = one.bgra().chunks(4).zip(two.bgra().chunks(4)).filter(|(a, b)| a != b).count();
    assert_eq!(differing, 0, "flat colours downsample to the logical frame exactly");
    assert_eq!(two.digest(), one.digest());
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_part2_shaders_compile_on_the_device() {
    let Some(gpu) = gpu() else { return };
    for (name, source) in genex_render::shaders::SHADERS {
        genex_render::renderer::shader(&gpu.device, name, source).unwrap_or_else(|e| panic!("{name}: {e}"));
    }
}
