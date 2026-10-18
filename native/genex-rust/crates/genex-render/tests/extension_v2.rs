//! Extension ladder level 2, API v2 (RQ1.3): `[[wgsl]] api` admission against the v2 preludes,
//! the declared inputs a source's bindings ask the frame graph for, the game's group 2 (one
//! uniform, textures from asset handles, two samplers), post-pass stages `hdr` and `ldr`, and the
//! v1 degrade: a v1 material in an HDR-requested frame draws the frame LDR (`material-v1-in-hdr`).
//!
//! The CPU rows run everywhere. The GPU rows are `#[ignore]`d and every name contains `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked -- --ignored metal
//!
//! Golden rows compare against `tests/fixtures/render-goldens/extension-v2/<name>.bgra` (raw BGRA,
//! top row first); `GENEX_RENDER_GOLDEN_UPDATE=1` rewrites them instead (review the diff).

use std::path::{Path, PathBuf};

use genex_render::abi::{ABI_V1, ABI_V2, RenderInputs};
use genex_render::capture::Capture;
use genex_render::extension::{
    CustomDraw, CustomMaterials, EnvironmentViews, ExtensionContext, ExtensionFault, ExtensionKind, FrameFacts, GAME_SAMPLER_FIRST_BINDING,
    GAME_TEXTURE_FIRST_BINDING, PostFrame, PostPasses, PostStage, validate, validate_api, written_for_api,
};
use genex_render::immediate::ImmediateFrame;
use genex_render::presets::preset_quality;
use genex_render::scene::{CameraDesc, Material, MeshId, Scene, scaled, translation};
use genex_render::settings::{QualityPreset, RenderSettings};
use genex_render::texture::TextureData;
use genex_render::{CullPath, Gpu, LdrReason, Quality, RenderCode, RenderError, Renderer, WORLD_FORMAT};

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

fn goldens_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../tests/fixtures/render-goldens")
}

/// Compare `capture` with the golden `<set>/<name>`, or rewrite it under
/// `GENEX_RENDER_GOLDEN_UPDATE=1` (only in this file's own set, `extension-v2`).
fn check_golden_in(set: &str, name: &str, capture: &Capture) {
    assert_eq!((capture.width(), capture.height()), (WIDTH, HEIGHT));
    if let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") {
        let dir = PathBuf::from(dir);
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join(format!("{set}-{name}.bgra")), capture.bgra()).expect("evidence");
    }
    let dir = goldens_root().join(set);
    let path = dir.join(format!("{name}.bgra"));
    let updating = std::env::var("GENEX_RENDER_GOLDEN_UPDATE").is_ok_and(|v| v == "1");
    if updating && set == "extension-v2" {
        std::fs::create_dir_all(&dir).expect("goldens folder");
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
    assert!(outliers <= GOLDEN_OUTLIER_PIXELS, "{set}/{name}: {outliers} pixels differ from the golden by more than {GOLDEN_CHANNEL_TOLERANCE} (worst {worst})");
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

fn fault(error: &RenderError) -> Option<ExtensionFault> {
    ExtensionFault::of(error)
}

/// The part-2 base frame (`golden_part2.rs`'s `base_frame`): what the v1 golden
/// `part2/custom-material` was drawn from, with its wall.
fn base_frame() -> ImmediateFrame {
    let mut frame = ImmediateFrame::new(camera(), [20, 24, 32, 255]);
    frame.mesh(MeshId::CUBE, scaled([0.0, -0.05, 0.0], [8.0, 0.1, 8.0]), Material::color([110, 110, 120, 255]));
    frame.cube(translation(-1.5, 0.5, 0.0), [200, 60, 50, 255]);
    frame.sphere([1.5, 0.6, 0.0], 0.6, [60, 160, 220, 255]);
    frame
}

fn base_scene() -> Scene {
    base_frame().scene().clone()
}

/// The custom-material row's draw: a 1.5 m cube in the middle, half behind a wall.
fn centre_draw(material: genex_render::extension::CustomMaterialId) -> CustomDraw {
    CustomDraw { id: None, mesh: MeshId::CUBE, model: scaled([0.0, 0.75, 1.0], [1.5, 1.5, 1.5]), material, tint: [240, 240, 240, 255] }
}

/// The base frame with the custom-material row's wall in front of the centre cube's left half.
fn walled_scene() -> Scene {
    let mut frame = base_frame();
    frame.cube(scaled([-0.9, 0.75, 2.8], [1.2, 2.0, 0.2]), [40, 200, 90, 255]);
    frame.scene().clone()
}

/// What the frame's camera and sizes say for v2 sources (the legacy LDR scene).
fn facts(renderer: &Renderer) -> FrameFacts {
    FrameFacts::new(renderer.size(), renderer.render_size()).with_camera(camera())
}

// ---------------------------------------------------------------------------------------------
// Sources

/// v1: the stripes of the part-2 golden (sRGB-encoded output).
const STRIPES_V1: &str = "
struct Params { color: vec4<f32>, stripes: vec4<f32> }
@group(2) @binding(0) var<uniform> params: Params;

@fragment
fn fs_material(in: GxMaterialIn) -> @location(0) vec4<f32> {
    let band = step(0.5, fract(in.uv.x * params.stripes.x));
    return vec4<f32>(mix(params.color.rgb, in.tint.rgb, band), 1.0);
}
";

fn stripes_uniforms() -> Vec<u8> {
    bytemuck::cast_slice(&[0.9f32, 0.1, 0.1, 1.0, 4.0, 0.0, 0.0, 0.0]).to_vec()
}

/// v2: a surface of the uniform's colour times the tint, shaded by the renderer's own lighting.
const SHADED_V2: &str = "
struct Params { color: vec4<f32> }
@group(2) @binding(0) var<uniform> params: Params;

@fragment
fn fs_material(in: GxMaterialInV2) -> @location(0) vec4<f32> {
    let s = gx_surface_v2(in.world_position, in.normal, params.color.rgb * in.tint.rgb, 0.0, 0.5);
    return vec4<f32>(gx_shade_pbr(s), 1.0);
}
";

fn shaded_uniforms() -> Vec<u8> {
    bytemuck::cast_slice(&[0.85f32, 0.55, 0.2, 1.0]).to_vec()
}

/// v2: the game's texture at binding 1 through the nearest sampler at binding 6, unlit.
const TEXTURED_V2: &str = "
@group(2) @binding(1) var albedo: texture_2d<f32>;
@group(2) @binding(6) var crisp: sampler;

@fragment
fn fs_material(in: GxMaterialInV2) -> @location(0) vec4<f32> {
    let texel = textureSample(albedo, crisp, in.uv);
    return vec4<f32>(gx_expose(texel.rgb), 1.0);
}
";

/// v2 post: the raw depth input at the first texel, in red.
const DEPTH_V2: &str = "
@fragment
fn fs_post(in: GxPostInV2) -> @location(0) vec4<f32> {
    let depth = textureLoad(gx_depth, vec2<i32>(0, 0), 0);
    return vec4<f32>(depth, 0.0, 0.0, 1.0);
}
";

/// v2 post: a warm grade of the scene in scene units, with a vignette from `gx_scene_uv`.
const GRADE_V2: &str = "
struct Grade { warm: vec4<f32> }
@group(2) @binding(0) var<uniform> grade: Grade;

@fragment
fn fs_post(in: GxPostInV2) -> @location(0) vec4<f32> {
    let uv = gx_scene_uv(in.position);
    let scene = textureSampleLevel(gx_scene, gx_sampler, uv, 0.0).rgb;
    let edge = distance(uv, vec2<f32>(0.5)) * 1.2;
    let vignette = clamp(1.0 - edge * edge, 0.0, 1.0);
    return vec4<f32>(scene * grade.warm.rgb * vignette, 1.0);
}
";

fn grade_uniforms() -> Vec<u8> {
    bytemuck::cast_slice(&[1.15f32, 1.0, 0.8, 0.0]).to_vec()
}

/// v2 post: the uv `gx_scene_uv` gives in red and green, the scene's blue in blue.
const UV_V2: &str = "
@fragment
fn fs_post(in: GxPostInV2) -> @location(0) vec4<f32> {
    let uv = gx_scene_uv(in.position);
    let scene = textureSampleLevel(gx_scene, gx_sampler, uv, 0.0);
    return vec4<f32>(uv.x, uv.y, scene.b, 1.0);
}
";

/// v1 post: the identity.
const IDENTITY_V1: &str = "
@fragment
fn fs_post(in: GxPostIn) -> @location(0) vec4<f32> {
    return textureSampleLevel(gx_source, gx_sampler, in.uv, 0.0);
}
";

// ---------------------------------------------------------------------------------------------
// Admission (CPU)

#[test]
fn a_v2_material_reading_gx_shade_pbr_is_admitted_at_api_2_and_v1_sources_keep_api_1() {
    let v2 = validate_api(ExtensionKind::Material, ABI_V2, SHADED_V2, &core()).expect("a v2 material against the v2 prelude");
    assert_eq!(v2.api_version(), ABI_V2, "the admitted api is the declared one");
    assert_eq!(v2.uniform_bytes(), Some(16));
    // RQ2 flipped this from NONE: `gx_shade_pbr` lights with the baked environment (IBL), so a
    // material calling it reads the environment input and nothing else.
    assert_eq!(v2.inputs(), RenderInputs::ENVIRONMENT, "gx_shade_pbr reads the environment from RQ2 on");
    let v1 = validate(ExtensionKind::Material, STRIPES_V1, &core()).expect("v1 stays loadable");
    assert_eq!(v1.api_version(), ABI_V1, "validate admits at api 1");
    let same = validate_api(ExtensionKind::Material, ABI_V1, STRIPES_V1, &core()).expect("v1 through validate_api");
    assert_eq!(same, v1);
}

#[test]
fn a_v2_source_asks_for_the_inputs_its_bindings_read_and_nothing_else() {
    let depth = validate_api(ExtensionKind::PostPass, ABI_V2, DEPTH_V2, &core()).expect("depth post");
    assert_eq!(depth.inputs(), RenderInputs::DEPTH, "reading gx_depth asks for depth");
    let grade = validate_api(ExtensionKind::PostPass, ABI_V2, GRADE_V2, &core()).expect("grade post");
    assert_eq!(grade.inputs(), RenderInputs::HDR_SCENE, "only gx_scene: declared, not every prelude binding");
    let both = "
@fragment
fn fs_post(in: GxPostInV2) -> @location(0) vec4<f32> {
    let m = textureLoad(gx_motion, vec2<i32>(0, 0), 0).xy;
    let n = textureLoad(gx_normals, vec2<i32>(0, 0), 0).xy;
    return vec4<f32>(m, n);
}
";
    let read = validate_api(ExtensionKind::PostPass, ABI_V2, both, &core()).expect("motion and normals");
    assert_eq!(read.inputs(), RenderInputs::MOTION | RenderInputs::NORMALS);
}

#[test]
fn a_v2_source_binding_an_undeclared_slot_is_refused_with_the_v2_layout_named() {
    let material = "\n@fragment fn fs_material(in: GxMaterialInV2) -> @location(0) vec4<f32> { return in.tint; }\n";
    let post = "\n@fragment fn fs_post(in: GxPostInV2) -> @location(0) vec4<f32> { return vec4<f32>(1.0); }\n";
    let rows: &[(&str, ExtensionKind, &str)] = &[
        ("a renderer slot past the map", ExtensionKind::Material, "@group(0) @binding(40) var t: texture_2d<f32>;"),
        ("a second draw binding", ExtensionKind::Material, "@group(1) @binding(1) var<uniform> u: vec4<f32>;"),
        ("the reserved group 3", ExtensionKind::Material, "@group(3) @binding(0) var<uniform> u: vec4<f32>;"),
        ("a game texture past the four", ExtensionKind::Material, "@group(2) @binding(9) var t: texture_2d<f32>;"),
        ("a uniform where a game texture goes", ExtensionKind::Material, "@group(2) @binding(2) var<uniform> u: vec4<f32>;"),
        ("a texture where a game sampler goes", ExtensionKind::Material, "@group(2) @binding(5) var t: texture_2d<f32>;"),
        ("a storage buffer where the game uniform goes", ExtensionKind::Material, "@group(2) @binding(0) var<storage, read> s: array<u32>;"),
        ("a comparison sampler in the game group", ExtensionKind::Material, "@group(2) @binding(6) var s: sampler_comparison;"),
        ("a post pass binding the reserved group 1", ExtensionKind::PostPass, "@group(1) @binding(0) var<uniform> u: vec4<f32>;"),
        ("a post pass renderer slot past the map", ExtensionKind::PostPass, "@group(0) @binding(11) var t: texture_2d<f32>;"),
    ];
    for (name, kind, declaration) in rows {
        let entry = if *kind == ExtensionKind::Material { material } else { post };
        let source = format!("{declaration}{entry}");
        let error = validate_api(*kind, ABI_V2, &source, &core()).expect_err(name);
        assert_eq!(error.code(), RenderCode::WgslTooLarge, "{name}");
        assert_eq!(fault(&error), Some(ExtensionFault::LayoutMismatch), "{name}: {error}");
        assert_eq!(written_for_api(*kind, &source, &core()), None, "{name}: the source admits at no api");
    }
}

#[test]
fn a_source_declared_at_the_other_api_or_an_unknown_api_is_refused_typed() {
    let error = validate_api(ExtensionKind::Material, ABI_V2, STRIPES_V1, &core()).expect_err("a v1 source admitted as v2");
    assert_eq!(fault(&error), Some(ExtensionFault::LayoutMismatch), "{error}");
    assert_eq!(written_for_api(ExtensionKind::Material, STRIPES_V1, &core()), Some(ABI_V1), "the api the source is written for");
    let error = validate_api(ExtensionKind::Material, ABI_V1, SHADED_V2, &core()).expect_err("a v2 source admitted as v1");
    assert_eq!(fault(&error), Some(ExtensionFault::LayoutMismatch), "{error}");
    assert_eq!(written_for_api(ExtensionKind::Material, SHADED_V2, &core()), Some(ABI_V2));
    let error = validate_api(ExtensionKind::PostPass, ABI_V2, IDENTITY_V1, &core()).expect_err("a v1 post pass admitted as v2");
    assert_eq!(fault(&error), Some(ExtensionFault::LayoutMismatch), "{error}");
    for api in [0, 3, 99] {
        let error = validate_api(ExtensionKind::Material, api, SHADED_V2, &core()).expect_err("an api this renderer does not serve");
        assert_eq!(error.code(), RenderCode::WgslTooLarge);
        assert_eq!(fault(&error), Some(ExtensionFault::LayoutMismatch), "{error}");
        assert!(!genex_render::extension::EXTENSION_APIS.contains(&api), "{api} is not served");
    }
    let broken = "@fragment fn fs_material(in: GxMaterialInV2) -> @location(0) vec4<f32> { return in.tint }";
    let error = validate_api(ExtensionKind::Material, ABI_V2, broken, &core()).expect_err("a parse error");
    assert_eq!(fault(&error), Some(ExtensionFault::Invalid), "a source valid at no api stays invalid: {error}");
}

#[test]
fn game_textures_bind_from_binding_1_and_samplers_from_binding_5() {
    assert_eq!((GAME_TEXTURE_FIRST_BINDING, GAME_SAMPLER_FIRST_BINDING), (1, 5));
    let textured = validate_api(ExtensionKind::Material, ABI_V2, TEXTURED_V2, &core()).expect("textured");
    assert_eq!(textured.game_textures(), 1);
    textured.check_textures(1).expect("one texture for one binding");
    for wrong in [0, 2] {
        let error = textured.check_textures(wrong).expect_err("textures must match the bindings");
        assert_eq!(fault(&error), Some(ExtensionFault::LayoutMismatch), "{error}");
    }
    let sparse = "
@group(2) @binding(1) var a: texture_2d<f32>;
@group(2) @binding(3) var c: texture_2d<f32>;
@group(2) @binding(5) var linear_repeat: sampler;
@fragment
fn fs_post(in: GxPostInV2) -> @location(0) vec4<f32> {
    return textureSample(a, linear_repeat, in.uv) + textureSample(c, linear_repeat, in.uv);
}
";
    let post = validate_api(ExtensionKind::PostPass, ABI_V2, sparse, &core()).expect("a post pass with game textures");
    assert_eq!(post.game_textures(), 3, "textures fill bindings 1 up to the highest declared");
}

#[test]
fn post_stages_spell_hdr_and_ldr() {
    assert_eq!(PostStage::ALL.map(PostStage::wire), ["hdr", "ldr"]);
    assert_eq!(PostStage::from_wire("hdr"), Some(PostStage::Hdr));
    assert_eq!(PostStage::from_wire("post-hdr"), None);
}

// ---------------------------------------------------------------------------------------------
// On the GPU

/// Draw `scene` with `materials`' draws through the part-1 renderer and read the frame back.
fn draw_with(gpu: &Gpu, renderer: &mut Renderer, materials: &mut CustomMaterials, scene: &Scene, draws: &[CustomDraw]) -> Capture {
    materials.set_frame_facts(facts(renderer));
    materials.prepare(gpu, draws, 0.0, renderer.library()).expect("draws admitted");
    renderer.render_staged(gpu, scene, CullPath::Gpu, materials).expect("frame");
    renderer.capture(gpu).expect("capture")
}

/// Run `ids` at `stage` over `renderer`'s world target.
fn post(gpu: &Gpu, renderer: &Renderer, posts: &mut PostPasses, ids: &[genex_render::extension::PostPassId], stage: PostStage) -> Capture {
    let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("post v2 test") });
    let frame = PostFrame::new(renderer.size(), 0.0);
    posts.encode_stage(gpu, &mut encoder, (renderer.world_texture(), renderer.world_view()), ids, stage, &frame);
    gpu.queue.submit([encoder.finish()]);
    renderer.capture(gpu).expect("capture")
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_golden_a_v2_material_shaded_by_gx_shade_pbr_renders() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = Renderer::new(&gpu, WIDTH, HEIGHT).expect("renderer");
    let mut materials = CustomMaterials::new(&gpu.device, core(), renderer.sample_count());
    let shaded = materials.add_api(&gpu, ABI_V2, SHADED_V2, &shaded_uniforms(), &[]).expect("a v2 material");
    let capture = draw_with(&gpu, &mut renderer, &mut materials, &walled_scene(), &[centre_draw(shaded)]);
    assert_eq!(materials.ldr_reason(), None, "a v2 material never degrades the frame");
    let lit = pixel(&capture, 72, 34);
    assert!(lit[2] > lit[0] && lit[2] > 60, "the orange cube is lit where it faces the camera (BGRA {lit:?})");
    assert_ne!(pixel(&capture, 72, 34), pixel(&capture, 72, 22), "the top and the front face are shaded apart");
    check_golden_in("extension-v2", "material", &capture);
}

/// Look-integration L2 (B.4): a v2 material built to read the AO term as one with screen-space GI
/// (`GX_AO_GI`, the renderer's own switch) draws the same picture on a frame whose AO does not run:
/// the term bound there reads as full visibility and no light (a white texel read as GI lit every
/// custom surface with its own albedo).
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_v2_material_reading_ssgi_draws_the_same_picture_where_ao_does_not_run() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = Renderer::new(&gpu, WIDTH, HEIGHT).expect("renderer");
    let mut materials = CustomMaterials::new(&gpu.device, core(), renderer.sample_count());
    let shaded = materials.add_api(&gpu, ABI_V2, SHADED_V2, &shaded_uniforms(), &[]).expect("a v2 material");
    let without = draw_with(&gpu, &mut renderer, &mut materials, &walled_scene(), &[centre_draw(shaded)]);
    assert!(materials.set_ao_gi(true), "the v2 pipelines are built again");
    assert!(!materials.set_ao_gi(true), "and only once");
    let with = draw_with(&gpu, &mut renderer, &mut materials, &walled_scene(), &[centre_draw(shaded)]);
    assert_eq!(pixel(&with, 72, 34), pixel(&without, 72, 34), "the lit face reads no GI light where AO does not run");
    assert_eq!(with.digest(), without.digest(), "the same picture");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_v1_material_in_an_hdr_frame_degrades_to_ldr_and_renders_its_v1_golden() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = Renderer::new(&gpu, WIDTH, HEIGHT).expect("renderer");
    let mut materials = CustomMaterials::new(&gpu.device, core(), renderer.sample_count());
    let stripes = materials.add(&gpu, STRIPES_V1, &stripes_uniforms()).expect("a v1 material");
    let mut hdr = Quality::off();
    hdr.hdr = true;
    let requested = RenderSettings::off().with_quality(genex_render::settings::PresetChoice::Off, hdr).frame_config((WIDTH, HEIGHT), 1.0, 0, true);
    assert!(requested.hdr, "the frame asks for HDR");
    materials.prepare(&gpu, &[centre_draw(stripes)], 0.0, renderer.library()).expect("draws");
    assert_eq!(materials.ldr_reason(), Some(LdrReason::MaterialV1InHdr));
    let drawn = materials.frame_config(requested);
    assert!(!drawn.hdr && !drawn.depth_reversed, "the frame is drawn LDR with standard Z");
    assert_eq!(drawn.ldr_reason, Some(LdrReason::MaterialV1InHdr));
    assert_eq!(drawn.ldr_reason.map(LdrReason::wire), Some("material-v1-in-hdr"));
    hdr.hdr = drawn.hdr;
    renderer.set_quality(&hdr);
    let capture = draw_with(&gpu, &mut renderer, &mut materials, &walled_scene(), &[centre_draw(stripes)]);
    check_golden_in("part2", "custom-material", &capture);
    // The degrade is the session's (pipelines are fixed per session): it holds while a v1 material
    // is held, drawn this frame or not, and a renderer holding only v2 materials never degrades.
    materials.prepare(&gpu, &[], 0.0, renderer.library()).expect("no draws");
    assert_eq!(materials.ldr_reason(), Some(LdrReason::MaterialV1InHdr));
    let mut v2_only = CustomMaterials::new(&gpu.device, core(), renderer.sample_count());
    v2_only.add_api(&gpu, ABI_V2, SHADED_V2, &shaded_uniforms(), &[]).expect("v2");
    assert_eq!(v2_only.frame_config(requested), requested);
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_v2_material_sampling_a_game_texture_renders() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = Renderer::new(&gpu, WIDTH, HEIGHT).expect("renderer");
    let mut materials = CustomMaterials::new(&gpu.device, core(), renderer.sample_count());
    let red_blue = TextureData::rgba8(2, 1, vec![255, 0, 0, 255, 0, 0, 255, 255]).expect("a 2x1 texture");
    let error = materials.add_api(&gpu, ABI_V2, TEXTURED_V2, &[], &[]).expect_err("its texture binding has no texture");
    assert_eq!(fault(&error), Some(ExtensionFault::LayoutMismatch), "{error}");
    let textured = materials.add_api(&gpu, ABI_V2, TEXTURED_V2, &[], std::slice::from_ref(&red_blue)).expect("a textured v2 material");
    let capture = draw_with(&gpu, &mut renderer, &mut materials, &base_scene(), &[centre_draw(textured)]);
    let near = |p: [u8; 4], bgr: [u8; 3]| p[..3].iter().zip(bgr).all(|(a, b)| a.abs_diff(b) <= 3);
    let pixels: Vec<[u8; 4]> = capture.bgra().chunks(4).map(|p| [p[0], p[1], p[2], p[3]]).collect();
    assert!(pixels.iter().any(|p| near(*p, [0, 0, 255])), "the texture's red texel shows");
    assert!(pixels.iter().any(|p| near(*p, [255, 0, 0])), "the texture's blue texel shows");
}

/// v2: the game's texture at binding 1 tiled 64 times across each face through the linear,
/// repeating sampler at binding 5, unlit.
const TILED_V2: &str = "
@group(2) @binding(1) var albedo: texture_2d<f32>;
@group(2) @binding(5) var linear_repeat: sampler;

@fragment
fn fs_material(in: GxMaterialInV2) -> @location(0) vec4<f32> {
    let texel = textureSample(albedo, linear_repeat, in.uv * 64.0);
    return vec4<f32>(gx_expose(texel.rgb), 1.0);
}
";

/// A game texture tiled far smaller than a pixel reads its mips: a one-texel black and white
/// checker averages to mid grey (half the light: sRGB 188) instead of aliasing to black and white
/// texels (a texture of one level, the renderer's before game textures had mips).
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_minified_game_texture_reads_its_mips_instead_of_aliasing() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = Renderer::new(&gpu, WIDTH, HEIGHT).expect("renderer");
    let mut materials = CustomMaterials::new(&gpu.device, core(), renderer.sample_count());
    let side = 64u32;
    let checker: Vec<u8> = (0..side * side).flat_map(|i| if (i % side + i / side).is_multiple_of(2) { [0, 0, 0, 255] } else { [255; 4] }).collect();
    let texture = TextureData::rgba8(side, side, checker).expect("a 64x64 checker");
    let tiled = materials.add_api(&gpu, ABI_V2, TILED_V2, &[], std::slice::from_ref(&texture)).expect("a tiled v2 material");
    let capture = draw_with(&gpu, &mut renderer, &mut materials, &base_scene(), &[centre_draw(tiled)]);
    let reds: Vec<u8> = (60..68).flat_map(|x| (34..42).map(move |y| (x, y))).map(|(x, y)| pixel(&capture, x, y)[2]).collect();
    let (low, high) = (reds.iter().min().copied().unwrap_or(0), reds.iter().max().copied().unwrap_or(0));
    assert!(high - low <= 12, "a minified checker is one even grey, not black and white texels: {low}..{high}");
    assert!(low.abs_diff(188) <= 10 && high.abs_diff(188) <= 10, "the grey is the checker's average light: {low}..{high}");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_v2_post_pass_reading_gx_depth_before_rq4_reads_the_neutral_far_depth() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = Renderer::new(&gpu, WIDTH, HEIGHT).expect("renderer");
    let mut posts = PostPasses::new(&gpu.device, core()).expect("posts");
    let depth = posts.add_api(&gpu, ABI_V2, PostStage::Ldr, DEPTH_V2, &[], &[]).expect("a v2 depth post");
    renderer.render(&gpu, &base_scene(), CullPath::Gpu).expect("frame");
    let capture = post(&gpu, &renderer, &mut posts, &[depth], PostStage::Ldr);
    assert_eq!(pixel(&capture, 3, 3), [0, 0, 255, 255], "the neutral depth is the far plane, 1.0 under standard Z");
    assert_eq!(pixel(&capture, 100, 60), [0, 0, 255, 255]);
    assert_eq!(posts.inputs(), RenderInputs::DEPTH, "what the graph is asked to produce");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_golden_a_v2_post_pass_at_stage_hdr_grades_the_scene() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = Renderer::new(&gpu, WIDTH, HEIGHT).expect("renderer");
    let mut posts = PostPasses::new(&gpu.device, core()).expect("posts");
    let grade = posts.add_api(&gpu, ABI_V2, PostStage::Hdr, GRADE_V2, &grade_uniforms(), &[]).expect("a v2 hdr post");
    let error = posts.add_api(&gpu, ABI_V1, PostStage::Hdr, IDENTITY_V1, &[], &[]).expect_err("a v1 post pass at stage hdr");
    assert_eq!(fault(&error), Some(ExtensionFault::LayoutMismatch), "v1 post passes run at ldr only: {error}");
    renderer.render(&gpu, &base_scene(), CullPath::Gpu).expect("frame");
    let plain = renderer.capture(&gpu).expect("capture");
    let ldr_only = post(&gpu, &renderer, &mut posts, &[grade], PostStage::Ldr);
    assert_eq!(ldr_only.bgra(), plain.bgra(), "an hdr-stage pass does not run at ldr");
    let graded = post(&gpu, &renderer, &mut posts, &[grade], PostStage::Hdr);
    assert_ne!(graded.bgra(), plain.bgra());
    assert!(pixel(&graded, 0, 0)[2] < pixel(&plain, 0, 0)[2].max(1), "the vignette darkens the corner");
    check_golden_in("extension-v2", "post-hdr", &graded);
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_v2_post_pass_at_scale_step_half_gives_the_scale_1_image_within_the_upscaler_tolerance() {
    let Some(gpu) = gpu() else { return };
    let mut images = Vec::new();
    for scale in [1.0, 0.5] {
        let mut renderer = Renderer::new(&gpu, WIDTH, HEIGHT).expect("renderer");
        renderer.set_render_scale(scale);
        let mut posts = PostPasses::new(&gpu.device, core()).expect("posts");
        let uv = posts.add_api(&gpu, ABI_V2, PostStage::Hdr, UV_V2, &[], &[]).expect("a uv post");
        renderer.render(&gpu, &base_scene(), CullPath::Gpu).expect("frame");
        let scene = renderer.capture(&gpu).expect("scene");
        images.push((scene, post(&gpu, &renderer, &mut posts, &[uv], PostStage::Hdr)));
    }
    let (scene_full, post_full) = &images[0];
    let (scene_half, post_half) = &images[1];
    let blue_drift = |a: &Capture, b: &Capture| a.bgra().chunks(4).zip(b.bgra().chunks(4)).map(|(x, y)| x[0].abs_diff(y[0])).max().unwrap_or(0);
    for (a, b) in post_full.bgra().chunks(4).zip(post_half.bgra().chunks(4)) {
        assert!(a[1].abs_diff(b[1]) <= 1 && a[2].abs_diff(b[2]) <= 1, "gx_scene_uv maps the same pixel to the same uv at both scales");
    }
    assert!(blue_drift(post_full, post_half) <= blue_drift(scene_full, scene_half), "the pass adds nothing to the upscaler's own difference");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_v2_pipelines_follow_the_scene_format_and_a_v1_post_keeps_the_world_format() {
    let Some(gpu) = gpu() else { return };
    let renderer = Renderer::new(&gpu, WIDTH, HEIGHT).expect("renderer");
    let mut materials = CustomMaterials::new(&gpu.device, core(), renderer.sample_count());
    let shaded = materials.add_api(&gpu, ABI_V2, SHADED_V2, &shaded_uniforms(), &[]).expect("v2");
    assert_eq!(materials.scene_format(), WORLD_FORMAT, "the legacy scene until the presenter hands over the HDR facts");
    let mut high = preset_quality(QualityPreset::High, genex_render::device_class::DeviceClass::new(
        genex_render::device_class::FormFactor::Desktop,
        genex_render::device_class::PerformanceTier::High,
    ));
    high.hdr = true;
    let config = RenderSettings::off().with_quality(genex_render::settings::PresetChoice::Off, high).frame_config((WIDTH, HEIGHT), 1.0, 0, true);
    let hdr = genex_render::custom_pass::PipelineFacts::for_frame(&config, renderer.sample_count(), wgpu::TextureFormat::Rgba16Float);
    assert_eq!((hdr.scene_format, hdr.depth_reversed), (wgpu::TextureFormat::Rgba16Float, true));
    materials.set_pipeline_facts(&gpu, hdr).expect("pipelines rebuilt for the HDR scene");
    assert_eq!(materials.scene_format(), wgpu::TextureFormat::Rgba16Float);
    let mut posts = PostPasses::new(&gpu.device, core()).expect("posts");
    posts.set_pipeline_facts(&gpu, hdr).expect("posts rebuilt");
    let v1 = posts.add(&gpu, IDENTITY_V1, &[]).expect("a v1 post pass");
    assert_eq!(posts.target_format(v1), Some(WORLD_FORMAT), "a v1 (ldr) post pass keeps the world target's format");
    let v2 = posts.add_api(&gpu, ABI_V2, PostStage::Hdr, GRADE_V2, &grade_uniforms(), &[]).expect("a v2 hdr post");
    assert_eq!(posts.target_format(v2), Some(wgpu::TextureFormat::Rgba16Float), "an hdr-stage pass draws on the scene");
    let _ = shaded;
}

// ---------------------------------------------------------------------------------------------
// RQ4.5: v2 post passes read the prepass's depth and normals

/// Writes a horizontal depth gradient, `(x + 0.5) / 128` at pixel column `x`.
const DEPTH_GRADIENT: &str = "
struct VsOut { @builtin(position) position: vec4<f32> }

@vertex
fn vs_main(@builtin(vertex_index) i: u32) -> VsOut {
    let uv = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
    var out: VsOut;
    out.position = vec4<f32>(uv * 2.0 - 1.0, 0.5, 1.0);
    return out;
}

@fragment
fn fs_main(in: VsOut) -> @builtin(frag_depth) f32 {
    return in.position.x / 128.0;
}
";

/// Stand-in prepass targets at the test size: depth is [`DEPTH_GRADIENT`], every octahedral
/// normal is (0.25, 0.75).
fn synthetic_prepass(gpu: &Gpu) -> (wgpu::TextureView, wgpu::TextureView) {
    let target = |label, format| {
        gpu.device.create_texture(&wgpu::TextureDescriptor {
            label: Some(label),
            size: wgpu::Extent3d { width: WIDTH, height: HEIGHT, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        })
    };
    let depth = target("synthetic prepass depth", genex_render::renderer::DEPTH_FORMAT).create_view(&Default::default());
    let normals = target("synthetic prepass normals", genex_render::prepass::NORMALS_FORMAT).create_view(&Default::default());
    let module = gpu.device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("depth gradient"), source: wgpu::ShaderSource::Wgsl(DEPTH_GRADIENT.into()) });
    let pipeline = gpu.device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("depth gradient"),
        layout: None,
        vertex: wgpu::VertexState { module: &module, entry_point: Some("vs_main"), compilation_options: Default::default(), buffers: &[] },
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: Some(wgpu::DepthStencilState {
            format: genex_render::renderer::DEPTH_FORMAT,
            depth_write_enabled: Some(true),
            depth_compare: Some(wgpu::CompareFunction::Always),
            stencil: Default::default(),
            bias: Default::default(),
        }),
        multisample: wgpu::MultisampleState::default(),
        fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some("fs_main"), compilation_options: Default::default(), targets: &[] }),
        multiview_mask: None,
        cache: None,
    });
    let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("synthetic prepass") });
    {
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("synthetic prepass depth"),
            color_attachments: &[],
            depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                view: &depth,
                depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(1.0), store: wgpu::StoreOp::Store }),
                stencil_ops: None,
            }),
            ..Default::default()
        });
        pass.set_pipeline(&pipeline);
        pass.draw(0..3, 0..1);
    }
    drop(encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some("synthetic prepass normals"),
        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
            view: &normals,
            depth_slice: None,
            resolve_target: None,
            ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color { r: 0.25, g: 0.75, b: 0.0, a: 0.0 }), store: wgpu::StoreOp::Store },
        })],
        ..Default::default()
    }));
    gpu.queue.submit([encoder.finish()]);
    (depth, normals)
}

/// The fog colour [`DEPTH_FOG_V2`] blends towards.
const FOG_RGB: [f64; 3] = [0.6, 0.7, 0.8];

/// v2 post: depth fog, the scene blended towards [`FOG_RGB`] by the raw depth; alpha carries the
/// normal's second lane, so the pass shows it read `gx_normals` too.
const DEPTH_FOG_V2: &str = "
@fragment
fn fs_post(in: GxPostInV2) -> @location(0) vec4<f32> {
    let uv = gx_scene_uv(in.position);
    let size = vec2<i32>(textureDimensions(gx_depth));
    let texel = min(vec2<i32>(in.position.xy), size - vec2<i32>(1));
    let fog = textureLoad(gx_depth, texel, 0);
    let normal = textureLoad(gx_normals, min(texel, vec2<i32>(textureDimensions(gx_normals)) - vec2<i32>(1)), 0).xy;
    let scene = textureSampleLevel(gx_scene, gx_sampler, uv, 0.0).rgb;
    return vec4<f32>(mix(scene, vec3<f32>(0.6, 0.7, 0.8), fog), normal.y);
}
";

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_v2_depth_fog_post_pass_renders_the_gradient_of_the_prepass_depth_it_is_handed() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = Renderer::new(&gpu, WIDTH, HEIGHT).expect("renderer");
    let mut posts = PostPasses::new(&gpu.device, core()).expect("posts");
    let fog = posts.add_api(&gpu, ABI_V2, PostStage::Ldr, DEPTH_FOG_V2, &[], &[]).expect("a v2 depth-fog post");
    assert_eq!(posts.inputs(), RenderInputs::DEPTH | RenderInputs::NORMALS | RenderInputs::HDR_SCENE);
    renderer.render(&gpu, &base_scene(), CullPath::Gpu).expect("frame");
    let scene = renderer.capture(&gpu).expect("scene");
    let (depth, normals) = synthetic_prepass(&gpu);
    let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("depth fog") });
    let frame = PostFrame { depth: Some(&depth), normals: Some(&normals), ..PostFrame::new(renderer.size(), 0.0) };
    posts.encode_stage(&gpu, &mut encoder, (renderer.world_texture(), renderer.world_view()), &[fog], PostStage::Ldr, &frame);
    gpu.queue.submit([encoder.finish()]);
    let fogged = renderer.capture(&gpu).expect("fogged");
    for (x, y) in [(2, 10), (30, 40), (64, 36), (100, 60), (125, 5)] {
        let t = (f64::from(x) + 0.5) / 128.0;
        let before = pixel(&scene, x, y);
        let after = pixel(&fogged, x, y);
        // BGRA: blue, green, red against the fog's rgb.
        for (lane, fog_lane) in [(0, FOG_RGB[2]), (1, FOG_RGB[1]), (2, FOG_RGB[0])] {
            let expected = (f64::from(before[lane]) * (1.0 - t) + fog_lane * 255.0 * t).round() as u8;
            assert!(after[lane].abs_diff(expected) <= 3, "({x}, {y}) lane {lane}: {} expected {expected} (depth {t:.3})", after[lane]);
        }
        assert!(after[3].abs_diff(191) <= 2, "({x}, {y}): gx_normals is the prepass normals (alpha {})", after[3]);
    }
}

/// Whether the game frame runs the depth/normal prepass for what its Level-2 v2 sources bind
/// (RQ4.5's frame-renderer seam): the frame rows below need it, and say so instead of passing
/// vacuously.
fn prepass_served() -> bool {
    let served = genex_render::prepass::LANDED && genex_render::custom_pass::PREPASS_SERVED;
    if !served {
        eprintln!("pending: the frame renderer does not run the prepass for v2 sources yet (custom_pass::PREPASS_SERVED, RQ4.5)");
    }
    served
}

/// v2 post: the camera's vertical focal length (`gx_frame.proj[1][1]`, about 1.7 at the rows'
/// field of view) over four, in red: 0 when `gx_frame` is the neutral zero row.
const FRAME_PROJ_POST_V2: &str = "
@fragment
fn fs_post(in: GxPostInV2) -> @location(0) vec4<f32> {
    return vec4<f32>(clamp(abs(gx_frame.proj[1][1]) * 0.25, 0.0, 1.0), 0.0, 0.0, 1.0);
}
";

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_v2_post_pass_in_a_frame_without_v2_materials_reads_the_frames_own_gx_frame() {
    use genex_render::immediate::FrameRenderer;
    let Some(gpu) = gpu() else { return };
    let focal = 1.0 / libm::tanf(camera().fovy_degrees.to_radians() * 0.5);
    let expected = (focal * 0.25 * 255.0).round() as u8;
    let hdr = ibl_frame_renderer(&gpu, &genex_render::settings::Environment::Color, None);
    let mut scenes = vec![("the HDR scene", hdr)];
    // The legacy LDR scene runs its post passes in node 23 through the same seam as the prepass.
    if prepass_served() {
        scenes.push(("the legacy LDR scene", FrameRenderer::new(&gpu, WIDTH, HEIGHT, genex_render::RenderOptions::default()).expect("renderer")));
    }
    for (name, mut frames) in scenes {
        let probe = frames.add_post_pass_api(&gpu, ABI_V2, PostStage::Ldr, FRAME_PROJ_POST_V2, &[], &[]).expect("a v2 post reading gx_frame");
        let mut frame = base_frame();
        frame.post_pass(probe);
        frames.render(&gpu, &frame, CullPath::Gpu, None).expect("frame");
        let red = pixel(&frames.capture(&gpu).expect("capture"), 64, 36)[2];
        assert!(red.abs_diff(expected) <= 2, "{name}: gx_frame.proj is the camera's (red {red}, expected {expected}), not the neutral zero row");
    }
}

/// v2 post: distance fog from the prepass's linear depth (`gx_linear_depth`), towards [`FOG_RGB`].
const DISTANCE_FOG_V2: &str = "
@fragment
fn fs_post(in: GxPostInV2) -> @location(0) vec4<f32> {
    let uv = gx_scene_uv(in.position);
    let fog = 1.0 - exp(-gx_linear_depth(uv) * 0.12);
    let scene = textureSampleLevel(gx_scene, gx_sampler, uv, 0.0).rgb;
    return vec4<f32>(mix(scene, vec3<f32>(0.6, 0.7, 0.8), fog), 1.0);
}
";

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_v2_distance_fog_post_pass_in_a_frame_fogs_by_the_frames_own_prepass_depth_with_the_switch_off() {
    use genex_render::immediate::FrameRenderer;
    use genex_render::prepass::PrepassConsumers;
    if !prepass_served() {
        return;
    }
    let Some(gpu) = gpu() else { return };
    let mut frames = FrameRenderer::new(&gpu, WIDTH, HEIGHT, genex_render::RenderOptions::default()).expect("renderer");
    assert!(!frames.renderer().quality().prepass, "the legacy quality's prepass switch is off: only the pass asks");
    let fog = frames.add_post_pass_api(&gpu, ABI_V2, PostStage::Ldr, DISTANCE_FOG_V2, &[], &[]).expect("a v2 distance-fog post");
    frames.render(&gpu, &base_frame(), CullPath::Gpu, None).expect("frame");
    let scene = frames.capture(&gpu).expect("scene");
    assert_eq!(frames.renderer().last_prepass(), None, "a frame without the pass asks nothing of the prepass");
    let mut fogged_frame = base_frame();
    fogged_frame.post_pass(fog);
    frames.render(&gpu, &fogged_frame, CullPath::Gpu, None).expect("frame");
    let fogged = frames.capture(&gpu).expect("fogged");
    let ran = frames.renderer().last_prepass().expect("the source's gx_depth ran the prepass");
    assert!(ran.consumers.contains(PrepassConsumers::EXTENSION), "{:?}", ran.consumers.wires());
    let fog_bgra = [FOG_RGB[2], FOG_RGB[1], FOG_RGB[0]].map(|c| (c * 255.0).round() as u8);
    let sky = pixel(&fogged, 2, 1);
    assert!((0..3).all(|lane| sky[lane].abs_diff(fog_bgra[lane]) <= 2), "the sky is wholly fogged (BGRA {sky:?})");
    // The floor in front of the camera: a few units away, so partly fogged, between its own
    // colour and the fog's (the neutral far plane would fog it wholly).
    let (before, after) = (pixel(&scene, 64, 60), pixel(&fogged, 64, 60));
    for lane in 0..3 {
        let (low, high) = (before[lane].min(fog_bgra[lane]), before[lane].max(fog_bgra[lane]));
        assert!(after[lane] > low.saturating_add(4) && after[lane] + 4 < high, "lane {lane}: the floor is partly fogged ({before:?} -> {after:?})");
    }
}

/// v2: [`PBR_V2`]'s surface through `gx_shade_pbr`, which applies the built-in fog
/// (`gx_apply_fog`, on linear radiance before the exposure) as the forward pass does. Applying
/// `gx_apply_fog` again to its exposed result would fog the surface twice.
const PBR_FOGGED_V2: &str = "
struct Params { pbr: vec4<f32> }
@group(2) @binding(0) var<uniform> params: Params;

@fragment
fn fs_material(in: GxMaterialInV2) -> @location(0) vec4<f32> {
    let s = gx_surface_v2(in.world_position, in.normal, in.tint.rgb, params.pbr.x, params.pbr.y);
    return vec4<f32>(gx_shade_pbr(s), 1.0);
}
";

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_v2_material_through_gx_shade_pbr_is_fogged_as_the_built_in_surface() {
    use genex_render::settings::Fog;
    if !genex_render::fog::LANDED {
        eprintln!("pending: the forward pass does not draw the built-in fog yet (fog::LANDED)");
        return;
    }
    let Some(gpu) = gpu() else { return };
    let (map, environment) = (showcase_map(), showcase_environment());
    let (_maps, views) = baked_environment(&gpu, &environment, &map);
    let fogged_renderer = |fog: Fog| {
        let mut renderer = ibl_renderer(&gpu, &environment, &map);
        let mut quality = ibl_quality();
        quality.fog = true;
        renderer.set_quality(&quality);
        renderer.set_look(renderer.look().with_fog(fog));
        renderer
    };
    // Uniform distance fog thick enough to hide about half of the sphere 2.4 units away.
    let fog = Fog::default().with_density(0.3).with_height(0.0, 0.0).with_color([0.7, 0.75, 0.8]);
    let (metallic, roughness) = (0.0, 0.5);
    let built_in = |fog: Fog| {
        let mut renderer = fogged_renderer(fog);
        let mut scene = sphere_backdrop();
        scene.draw(MeshId::SPHERE, sphere_model(), Material::color(SPHERE_TINT).with_pbr(metallic, roughness));
        let mut none = CustomMaterials::new(&gpu.device, core(), renderer.sample_count());
        hdr_scene_with(&gpu, &mut renderer, &mut none, &scene, &[])
    };
    let custom = {
        let mut renderer = fogged_renderer(fog);
        let mut materials = CustomMaterials::new(&gpu.device, core(), renderer.sample_count());
        let pbr = materials.add_api(&gpu, ABI_V2, PBR_FOGGED_V2, &pbr_uniforms(metallic, roughness), &[]).expect("a v2 fogged material");
        materials.set_environment(Some(views.clone()));
        let draw = CustomDraw { id: None, mesh: MeshId::SPHERE, model: sphere_model(), material: pbr, tint: SPHERE_TINT };
        hdr_scene_with(&gpu, &mut renderer, &mut materials, &sphere_backdrop(), &[draw])
    };
    let (clear, foggy) = (built_in(Fog::default()), built_in(fog));
    let disk = lit_disk(&clear);
    assert!(disk.len() > 400, "the sphere fills the frame's middle ({} pixels)", disk.len());
    let moved = radiance_outliers(&clear, &foggy, &disk).len();
    assert!(moved > disk.len() / 2, "the fog changes the built-in sphere ({moved} of {} pixels)", disk.len());
    let over = radiance_outliers(&foggy, &custom, &disk);
    assert!(over.len() <= RADIANCE_OUTLIERS, "{} sphere pixels of the fogged v2 material differ from the fogged built-in surface: {:?}", over.len(), &over[..over.len().min(8)]);
}

// ---------------------------------------------------------------------------------------------
// The environment (RQ2.5): v2 materials and post passes read the renderer's real environment

/// The CC0 showcase HDRI (RQ2.3).
const SHOWCASE_HDRI: &str = "../../examples/showcase/game/assets/env/kloofendal_43d_clear_puresky_1k.hdr";
/// The environment rows' sphere colour (sRGB).
const SPHERE_TINT: [u8; 4] = [200, 170, 140, 255];
/// The environment rows' sphere (a unit sphere scaled to fill the frame's middle).
const SPHERE_SCALE: f32 = 0.6;
/// A sphere pixel of the v2 material matches the built-in surface within this share of its
/// radiance (plus [`RADIANCE_FLOOR`]): the two are one shading, rounded apart by the half-float scene.
const RADIANCE_SHARE: f32 = 0.02;
const RADIANCE_FLOOR: f32 = 2e-3;
/// Sphere pixels allowed past that (rasterization along the silhouette), of the eroded disk.
const RADIANCE_OUTLIERS: usize = 6;

/// v2: the draw's (linear) tint with the uniform's metallic (x) and roughness (y), shaded by
/// `gx_shade_pbr`: what a built-in `Material::color(tint).with_pbr(metallic, roughness)` writes.
const PBR_V2: &str = "
struct Params { pbr: vec4<f32> }
@group(2) @binding(0) var<uniform> params: Params;

@fragment
fn fs_material(in: GxMaterialInV2) -> @location(0) vec4<f32> {
    let s = gx_surface_v2(in.world_position, in.normal, in.tint.rgb, params.pbr.x, params.pbr.y);
    return vec4<f32>(gx_shade_pbr(s), 1.0);
}
";

/// v2 post: the environment's SH9 L0 term (`gx_env_sh`, its mean radiance) over the frame.
const ENV_SH_POST_V2: &str = "
@fragment
fn fs_post(in: GxPostInV2) -> @location(0) vec4<f32> {
    return vec4<f32>(clamp(gx_env_sh.coefficients[0].rgb * 0.282095, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}
";

fn pbr_uniforms(metallic: f32, roughness: f32) -> Vec<u8> {
    bytemuck::cast_slice(&[metallic, roughness, 0.0f32, 0.0]).to_vec()
}

fn showcase_map() -> genex_render::hdri::HdriImage {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(SHOWCASE_HDRI);
    let bytes = std::fs::read(&path).unwrap_or_else(|error| panic!("the showcase HDRI {path:?}: {error}"));
    genex_render::hdri::decode(&bytes).expect("the showcase HDRI decodes")
}

fn showcase_environment() -> genex_render::settings::Environment {
    genex_render::settings::Environment::hdri("env/kloofendal_43d_clear_puresky_1k.hdr")
}

/// The HDR path (`rgba16float`, single-sampled, so the scene reads back linear) with the high
/// preset's IBL, no sky background, a fixed exposure of 1.
fn ibl_quality() -> Quality {
    let class = genex_render::device_class::DeviceClass::from_wire("desktop-high").expect("class");
    let mut quality = Quality::off();
    quality.hdr = true;
    quality.tonemap = true;
    quality.exposure = true;
    quality.environment = preset_quality(QualityPreset::High, class).environment;
    quality.environment.ibl = true;
    quality.environment.sky = false;
    quality
}

/// A renderer lit by `environment` (its map baked from `map`) on [`ibl_quality`].
fn ibl_renderer(gpu: &Gpu, environment: &genex_render::settings::Environment, map: &genex_render::hdri::HdriImage) -> Renderer {
    use genex_render::settings::{ExposureMode, Look, SceneFormat, Tonemapper};
    let mut renderer = Renderer::with_options(gpu, WIDTH, HEIGHT, genex_render::RenderOptions { msaa: false }).expect("renderer");
    renderer.set_scene_format(SceneFormat::Rgba16Float);
    renderer.set_quality(&ibl_quality());
    let mut look = Look::default();
    look.tonemapper = Tonemapper::KhronosNeutral;
    look.exposure = ExposureMode::Manual;
    look.ev_compensation = 0.0;
    renderer.set_look(look);
    renderer.set_environment(environment);
    renderer.set_environment_map(gpu, map).expect("the map uploads");
    renderer
}

/// The environment `environment`'s map bakes to under [`ibl_quality`], baked outside a renderer the
/// way graph node 11 bakes it: what a v2 source binds once the renderer hands over its own.
fn baked_environment(gpu: &Gpu, environment: &genex_render::settings::Environment, map: &genex_render::hdri::HdriImage) -> (genex_render::ibl::EnvironmentMaps, EnvironmentViews) {
    use genex_render::ibl::{BakeRequest, EnvironmentMaps};
    let quality = ibl_quality();
    let mut maps = EnvironmentMaps::new(&gpu.device, &gpu.queue);
    maps.set_environment(environment);
    maps.set_map(&gpu.device, &gpu.queue, map).expect("the map uploads");
    let mut encoder = genex_render::graph::FrameEncoder::new(&gpu.device, &gpu.queue, "baked environment");
    let request = BakeRequest { environment, quality: &quality.environment, frame_index: 0, settle: true, sun_dir: [0.0, 1.0, 0.0], sun_color: [1.0; 3] };
    maps.bake(&mut encoder, &request, None);
    encoder.submit();
    let _ = gpu.device.poll(wgpu::PollType::wait_indefinitely());
    assert!(maps.baked(), "the map baked whole");
    let views = EnvironmentViews::of(&maps).expect("the baked maps bind");
    (maps, views)
}

fn sphere_model() -> [f32; 16] {
    scaled([0.0, 0.0, 0.0], [SPHERE_SCALE; 3])
}

/// The environment rows' frame: the sphere's camera over black, the default sun.
fn sphere_backdrop() -> Scene {
    Scene::new(CameraDesc::look_at([0.0, 0.0, 2.4], [0.0, 0.0, 0.0]), [0, 0, 0, 255])
}

/// The linear scene of `renderer` drawing `scene` with `materials`' `draws` on the HDR path, after
/// two frames (the first bakes the environment cold).
fn hdr_scene_with(gpu: &Gpu, renderer: &mut Renderer, materials: &mut CustomMaterials, scene: &Scene, draws: &[CustomDraw]) -> Vec<[f32; 4]> {
    let path = renderer.next_scene(None);
    assert!(path.hdr && path.format == wgpu::TextureFormat::Rgba16Float, "the rows draw the linear HDR scene");
    materials
        .set_pipeline_facts(gpu, genex_render::custom_pass::PipelineFacts::for_scene(&path, renderer.sample_count()))
        .expect("pipelines follow the HDR scene");
    // The frame's fog as the frame renderer hands it to v2 sources (`FrameFacts::fog`, RQ4.6).
    let facts = FrameFacts {
        depth_reversed: path.depth_reversed,
        scene_ldr: false,
        pre_exposure: path.pre_exposure,
        fog: renderer.frame_fog(),
        ..FrameFacts::new(renderer.size(), renderer.render_size())
    };
    materials.set_frame_facts(facts.with_camera(scene.camera));
    for _ in 0..2 {
        materials.prepare(gpu, draws, 0.0, renderer.library()).expect("draws admitted");
        renderer.render_staged(gpu, scene, CullPath::Gpu, materials).expect("frame");
    }
    renderer.read_scene(gpu).expect("the HDR scene reads back")
}

/// The pixels well inside the lit object of `texels` (one-pixel erosion of the lit mask).
fn lit_disk(texels: &[[f32; 4]]) -> Vec<usize> {
    let lit = |i: usize| texels.get(i).is_some_and(|t| t[0].max(t[1]).max(t[2]) > 1e-3);
    let w = WIDTH as usize;
    (0..texels.len()).filter(|&i| i % w > 0 && i % w + 1 < w && i > w && lit(i) && lit(i - 1) && lit(i + 1) && lit(i - w) && lit(i + w)).collect()
}

/// Sphere pixels of `b` farther from `a` than [`RADIANCE_SHARE`] (with their radiance).
fn radiance_outliers(a: &[[f32; 4]], b: &[[f32; 4]], disk: &[usize]) -> Vec<(usize, [f32; 3], [f32; 3])> {
    disk.iter()
        .filter(|&&i| (0..3).any(|c| (a[i][c] - b[i][c]).abs() > RADIANCE_SHARE * a[i][c].abs().max(b[i][c].abs()) + RADIANCE_FLOOR))
        .map(|&i| (i, [a[i][0], a[i][1], a[i][2]], [b[i][0], b[i][1], b[i][2]]))
        .collect()
}

fn summed(texels: &[[f32; 4]], disk: &[usize]) -> f32 {
    disk.iter().map(|&i| texels[i][0] + texels[i][1] + texels[i][2]).sum()
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_v2_material_under_an_hdri_shades_like_the_built_in_surface_and_unlike_the_neutral_environment() {
    let Some(gpu) = gpu() else { return };
    let (map, environment) = (showcase_map(), showcase_environment());
    let (_maps, views) = baked_environment(&gpu, &environment, &map);
    for (metallic, roughness) in [(0.0, 0.5), (1.0, 0.25)] {
        let built_in = {
            let mut renderer = ibl_renderer(&gpu, &environment, &map);
            let mut scene = sphere_backdrop();
            scene.draw(MeshId::SPHERE, sphere_model(), Material::color(SPHERE_TINT).with_pbr(metallic, roughness));
            let mut none = CustomMaterials::new(&gpu.device, core(), renderer.sample_count());
            hdr_scene_with(&gpu, &mut renderer, &mut none, &scene, &[])
        };
        let custom = |environment_views: Option<EnvironmentViews>| {
            let mut renderer = ibl_renderer(&gpu, &environment, &map);
            let mut materials = CustomMaterials::new(&gpu.device, core(), renderer.sample_count());
            let pbr = materials.add_api(&gpu, ABI_V2, PBR_V2, &pbr_uniforms(metallic, roughness), &[]).expect("a v2 material");
            materials.set_environment(environment_views);
            let draw = CustomDraw { id: None, mesh: MeshId::SPHERE, model: sphere_model(), material: pbr, tint: SPHERE_TINT };
            hdr_scene_with(&gpu, &mut renderer, &mut materials, &sphere_backdrop(), &[draw])
        };
        let disk = lit_disk(&built_in);
        assert!(disk.len() > 400, "metallic {metallic}: the sphere fills the frame's middle ({} pixels)", disk.len());
        let real = custom(Some(views.clone()));
        let neutral = custom(None);
        let over = radiance_outliers(&built_in, &real, &disk);
        assert!(
            over.len() <= RADIANCE_OUTLIERS,
            "metallic {metallic}, roughness {roughness}: {} sphere pixels of the v2 material differ from the built-in surface under the HDRI: {:?}",
            over.len(),
            &over[..over.len().min(8)]
        );
        let (lit, unlit) = (summed(&real, &disk), summed(&neutral, &disk));
        assert!(lit > unlit * 1.25, "metallic {metallic}: the HDRI lights the v2 sphere beyond the neutral environment ({lit} vs {unlit})");
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_v2_post_pass_reads_the_environment_it_is_handed() {
    let Some(gpu) = gpu() else { return };
    let (map, environment) = (showcase_map(), showcase_environment());
    let (_maps, views) = baked_environment(&gpu, &environment, &map);
    let mut posts = PostPasses::new(&gpu.device, core()).expect("posts");
    let probe = posts.add_api(&gpu, ABI_V2, PostStage::Ldr, ENV_SH_POST_V2, &[], &[]).expect("a v2 post reading the environment");
    assert_eq!(posts.inputs(), RenderInputs::ENVIRONMENT, "it reads the environment and nothing else");
    let mut renderer = Renderer::new(&gpu, WIDTH, HEIGHT).expect("renderer");
    renderer.render(&gpu, &base_scene(), CullPath::Gpu).expect("frame");
    let mut run = |environment: Option<&EnvironmentViews>| {
        let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("env post") });
        let frame = PostFrame { environment, ..PostFrame::new(renderer.size(), 0.0) };
        posts.encode_stage(&gpu, &mut encoder, (renderer.world_texture(), renderer.world_view()), &[probe], PostStage::Ldr, &frame);
        gpu.queue.submit([encoder.finish()]);
        pixel(&renderer.capture(&gpu).expect("capture"), 64, 36)
    };
    assert_eq!(run(None)[..3], [0, 0, 0], "the neutral environment holds no light");
    let sky = run(Some(&views));
    assert!(sky[..3].iter().all(|channel| *channel > 8), "the HDRI's mean radiance reaches the pass (BGRA {sky:?})");
}

/// Level 3, API v2 (RQ2.5): the environment's SH9 L0 term read from the v2 tables
/// (`gx_env_sh`, left half) and from the environment group (`gx_env_sh` there, times the BRDF
/// LUT's scale at a grazing, rough sample: right half).
const ENV_PASS_V2: &str = "
@group(0) @binding(7) var<uniform> tables_sh: GxEnvSh;
@group(1) @binding(1) var<uniform> gx_env_sh: GxEnvSh;
@group(1) @binding(2) var gx_brdf_lut: texture_2d<f32>;
@group(1) @binding(3) var gx_env_sampler: sampler;

struct VsOut { @builtin(position) position: vec4<f32> }

@vertex
fn vs_main(@builtin(vertex_index) i: u32) -> VsOut {
    let uv = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
    var out: VsOut;
    out.position = vec4<f32>(uv * 2.0 - 1.0, 0.0, 1.0);
    return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    let lut = textureSampleLevel(gx_brdf_lut, gx_env_sampler, vec2<f32>(0.5, 0.5), 0.0).x;
    var mean = tables_sh.coefficients[0].rgb;
    if in.position.x > 64.0 {
        mean = gx_env_sh.coefficients[0].rgb * select(0.0, 1.0, lut > 0.0);
    }
    return vec4<f32>(clamp(mean * 0.282095, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}
";

/// A v2 `post` pass drawing [`ENV_PASS_V2`] over the world target with the tables at group 0 and
/// the environment group at group 1.
#[derive(Default)]
struct EnvPassV2 {
    pipeline: Option<wgpu::RenderPipeline>,
    had_environment: Vec<bool>,
}

impl genex_render::custom_pass::CustomPass for EnvPassV2 {
    fn rebuild(&mut self, setup: &mut genex_render::custom_pass::PassSetup<'_>) -> Result<(), RenderError> {
        let environment = setup.environment_layout().expect("a v2 pass gets the environment layout");
        let module = setup.create_shader("env v2", ENV_PASS_V2)?;
        let layout = setup.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("env v2"),
            bind_group_layouts: &[Some(setup.tables_layout()), Some(environment)],
            immediate_size: 0,
        });
        let targets = [Some(wgpu::ColorTargetState { format: setup.world_format(), blend: None, write_mask: wgpu::ColorWrites::ALL })];
        self.pipeline = Some(setup.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("env v2"),
            layout: Some(&layout),
            vertex: wgpu::VertexState { module: &module, entry_point: Some("vs_main"), compilation_options: Default::default(), buffers: &[] },
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some("fs_main"), compilation_options: Default::default(), targets: &targets }),
            multiview_mask: None,
            cache: None,
        }));
        Ok(())
    }

    fn encode(&mut self, frame: &mut genex_render::custom_pass::PassFrame<'_>) {
        let Some(pipeline) = self.pipeline.clone() else { return };
        let tables = frame.tables().clone();
        let Some(environment) = frame.environment().cloned() else {
            self.had_environment.push(false);
            return;
        };
        self.had_environment.push(true);
        let Some(view) = frame.world_view().cloned() else { return };
        let Some(encoder) = frame.encoder() else { return };
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("env v2"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store },
            })],
            ..Default::default()
        });
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &tables, &[]);
        pass.set_bind_group(1, &environment, &[]);
        pass.draw(0..3, 0..1);
    }

    fn api(&self) -> u32 {
        ABI_V2
    }

    fn inputs(&self) -> RenderInputs {
        RenderInputs::ENVIRONMENT
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_level_3_v2_pass_reads_the_neutral_environment_under_the_flat_colour_whatever_it_was_handed() {
    use genex_render::custom_pass::{CustomPass, CustomPasses, ENVIRONMENT_BINDINGS, PassStage};
    use genex_render::immediate::FrameRenderer;
    let Some(gpu) = gpu() else { return };
    assert_eq!(ENVIRONMENT_BINDINGS.iter().map(|row| row.name).collect::<Vec<_>>(), ["gx_env_specular", "gx_env_sh", "gx_brdf_lut", "gx_env_sampler"]);
    let (map, environment) = (showcase_map(), showcase_environment());
    let (_maps, views) = baked_environment(&gpu, &environment, &map);
    let mut renderer = FrameRenderer::new(&gpu, WIDTH, HEIGHT, genex_render::RenderOptions::default()).expect("renderer");
    let mut passes = CustomPasses::new(&gpu, renderer.renderer(), wgpu::Features::empty());
    let mut probe = EnvPassV2::default();
    passes.register(&gpu, "env", PassStage::Post, &mut probe).expect("a v2 post pass reading the environment");
    let mut draw = |passes: &mut CustomPasses, probe: &mut EnvPassV2, tick: u64| {
        let mut list: [&mut dyn CustomPass; 1] = [probe];
        let mut run = passes.frame(&gpu, &mut list, tick).expect("frame passes");
        renderer.render_with(&gpu, &base_frame(), CullPath::Gpu, None, &mut run).expect("frame");
        drop(run);
        renderer.capture(&gpu).expect("capture")
    };
    let neutral = draw(&mut passes, &mut probe, 1);
    for x in [20, 100] {
        assert_eq!(pixel(&neutral, x, 36)[..3], [0, 0, 0], "x {x}: without the renderer's environment the pass reads the neutral one");
    }
    // A caller may hand an environment over, but a frame renderer hands over its own each frame:
    // this one lights with the flat colour, so its passes read the neutral environment again.
    passes.set_environment(Some(views.clone()));
    assert_eq!(passes.environment(), Some(&views));
    let again = draw(&mut passes, &mut probe, 2);
    assert!(passes.refusals().is_empty(), "{:?}", passes.refusals());
    assert_eq!(probe.had_environment, [true, true], "a v2 pass always gets an environment group");
    assert_eq!(passes.environment(), renderer.renderer().environment_views().as_ref(), "the renderer's own environment won");
    for x in [20, 100] {
        assert_eq!(pixel(&again, x, 36)[..3], [0, 0, 0], "x {x}: the flat colour's renderer binds the neutral environment");
    }
}

// ---------------------------------------------------------------------------------------------
// The frame renderer hands its own environment over (RQ2.5): no caller wiring, the cold bake
// bound the frame it lands

/// A frame renderer on [`ibl_quality`] (exposure 1, Khronos neutral) lit by `environment`, its
/// map baked from `map` when it is an HDRI. The sky turns the sky on (its LUTs are what it bakes
/// from) and is drawn behind the scene.
fn ibl_frame_renderer(gpu: &Gpu, environment: &genex_render::settings::Environment, map: Option<&genex_render::hdri::HdriImage>) -> genex_render::immediate::FrameRenderer {
    use genex_render::settings::{ExposureMode, Look, SceneFormat, Tonemapper};
    let mut frames = genex_render::immediate::FrameRenderer::new(gpu, WIDTH, HEIGHT, genex_render::RenderOptions { msaa: false }).expect("renderer");
    let renderer = frames.renderer_mut();
    renderer.set_scene_format(SceneFormat::Rgba16Float);
    let mut quality = ibl_quality();
    quality.environment.sky = matches!(environment, genex_render::settings::Environment::Sky(_));
    renderer.set_quality(&quality);
    let mut look = Look::default();
    look.tonemapper = Tonemapper::KhronosNeutral;
    look.exposure = ExposureMode::Manual;
    look.ev_compensation = 0.0;
    renderer.set_look(look);
    renderer.set_environment(environment);
    if let Some(map) = map {
        renderer.set_environment_map(gpu, map).expect("the map uploads");
    }
    frames
}

/// The sphere frame: the built-in surface `Material::color(tint).with_pbr(..)`, or `material`'s
/// draw of the same sphere.
fn sphere_frame(material: Option<genex_render::extension::CustomMaterialId>, metallic: f32, roughness: f32) -> ImmediateFrame {
    let mut frame = ImmediateFrame::new(CameraDesc::look_at([0.0, 0.0, 2.4], [0.0, 0.0, 0.0]), [0, 0, 0, 255]);
    match material {
        Some(material) => frame.custom(MeshId::SPHERE, sphere_model(), material, SPHERE_TINT),
        None => frame.mesh(MeshId::SPHERE, sphere_model(), Material::color(SPHERE_TINT).with_pbr(metallic, roughness)),
    };
    frame
}

/// The linear HDR scene of ONE frame of `frame` (the environment bakes cold in it).
fn one_frame(gpu: &Gpu, frames: &mut genex_render::immediate::FrameRenderer, frame: &ImmediateFrame) -> Vec<[f32; 4]> {
    frames.render(gpu, frame, CullPath::Gpu, None).expect("frame");
    assert!(frames.renderer().last_scene().is_some_and(|scene| scene.hdr), "the rows draw the linear HDR scene");
    frames.renderer().read_scene(gpu).expect("the HDR scene reads back")
}

/// The sphere `material` (None: the built-in surface) draws in one frame under `environment`.
fn sphere_under(
    gpu: &Gpu,
    environment: &genex_render::settings::Environment,
    map: Option<&genex_render::hdri::HdriImage>,
    v2: bool,
    (metallic, roughness): (f32, f32),
) -> Vec<[f32; 4]> {
    let mut frames = ibl_frame_renderer(gpu, environment, map);
    let material = v2.then(|| frames.add_material_api(gpu, ABI_V2, PBR_V2, &pbr_uniforms(metallic, roughness), &[]).expect("a v2 material"));
    one_frame(gpu, &mut frames, &sphere_frame(material, metallic, roughness))
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_v2_material_gets_the_renderer_s_environment_and_shades_like_the_built_in_surface_under_the_sky_and_an_hdri() {
    use genex_render::settings::Environment;
    let Some(gpu) = gpu() else { return };
    let map = showcase_map();
    let lit: [(Environment, Option<&genex_render::hdri::HdriImage>); 2] = [(Environment::sky(), None), (showcase_environment(), Some(&map))];
    for (metallic, roughness) in [(0.0, 0.5), (1.0, 0.25)] {
        // An HDRI with no map: image-based lighting replaces the flat ambient with no light at all.
        let unlit = sphere_under(&gpu, &Environment::hdri("env/none.hdr"), None, true, (metallic, roughness));
        let disk = lit_disk(&sphere_under(&gpu, &Environment::Color, None, false, (metallic, roughness)));
        assert!(disk.len() > 400, "metallic {metallic}: the sphere fills the frame's middle ({} pixels)", disk.len());
        for (environment, map) in &lit {
            let kind = environment.kind();
            let built_in = sphere_under(&gpu, environment, *map, false, (metallic, roughness));
            let v2 = sphere_under(&gpu, environment, *map, true, (metallic, roughness));
            let over = radiance_outliers(&built_in, &v2, &disk);
            assert!(
                over.len() <= RADIANCE_OUTLIERS,
                "{kind:?}, metallic {metallic}, roughness {roughness}: {} sphere pixels of the v2 material differ from the built-in surface: {:?}",
                over.len(),
                &over[..over.len().min(8)]
            );
            let (lit, dark) = (summed(&v2, &disk), summed(&unlit, &disk));
            assert!(lit > dark * 1.25, "{kind:?}, metallic {metallic}: the environment lights the v2 sphere beyond no environment ({lit} vs {dark})");
        }
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_v2_post_pass_in_a_frame_reads_the_renderer_s_environment() {
    use genex_render::settings::Environment;
    let Some(gpu) = gpu() else { return };
    let map = showcase_map();
    let probe = |environment: &Environment, map: Option<&genex_render::hdri::HdriImage>| {
        let mut frames = ibl_frame_renderer(&gpu, environment, map);
        let post = frames.add_post_pass_api(&gpu, ABI_V2, PostStage::Ldr, ENV_SH_POST_V2, &[], &[]).expect("a v2 post reading the environment");
        let mut frame = sphere_frame(None, 0.0, 0.5);
        frame.post_pass(post);
        frames.render(&gpu, &frame, CullPath::Gpu, None).expect("frame");
        pixel(&frames.capture(&gpu).expect("capture"), 8, 8)
    };
    assert_eq!(probe(&Environment::Color, None)[..3], [0, 0, 0], "the flat colour: no environment light");
    let sky = probe(&Environment::sky(), None);
    let hdri = probe(&showcase_environment(), Some(&map));
    assert!(sky[..3].iter().all(|channel| *channel > 8), "the sky's mean radiance reaches the pass (BGRA {sky:?})");
    assert!(hdri[..3].iter().all(|channel| *channel > 8), "the HDRI's mean radiance reaches the pass (BGRA {hdri:?})");
    assert_ne!(sky, hdri, "each its own environment");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_level_3_v2_pass_gets_the_renderer_s_environment_without_being_handed_one() {
    use genex_render::custom_pass::{CustomPass, CustomPasses, PassStage};
    let Some(gpu) = gpu() else { return };
    let map = showcase_map();
    let mut frames = ibl_frame_renderer(&gpu, &showcase_environment(), Some(&map));
    let mut passes = CustomPasses::new(&gpu, frames.renderer(), wgpu::Features::empty());
    let mut probe = EnvPassV2::default();
    passes.register(&gpu, "env", PassStage::Post, &mut probe).expect("a v2 post pass reading the environment");
    let mut list: [&mut dyn CustomPass; 1] = [&mut probe];
    let mut run = passes.frame(&gpu, &mut list, 1).expect("frame passes");
    frames.render_with(&gpu, &sphere_frame(None, 0.0, 0.5), CullPath::Gpu, None, &mut run).expect("frame");
    drop(run);
    let lit = frames.capture(&gpu).expect("capture");
    assert!(passes.refusals().is_empty(), "{:?}", passes.refusals());
    assert_eq!(passes.environment(), frames.renderer().environment_views().as_ref(), "the registry holds the renderer's own environment");
    let (tables, group) = (pixel(&lit, 20, 36), pixel(&lit, 100, 36));
    assert!(tables[..3].iter().all(|channel| *channel > 8), "the tables' gx_env_sh is the HDRI's, baked this frame (BGRA {tables:?})");
    assert_eq!(tables, group, "the tables and the environment group bind one environment");
}

/// v2: [`PBR_V2`]'s surface filtered against specular aliasing (`gx_filter_specular_v2`, the
/// derivatives taken in uniform control flow), as a built-in surface is on the HDR scene.
const PBR_V2_FILTERED: &str = "
struct Params { pbr: vec4<f32> }
@group(2) @binding(0) var<uniform> params: Params;

@fragment
fn fs_material(in: GxMaterialInV2) -> @location(0) vec4<f32> {
    let n = normalize(in.normal);
    let s = gx_filter_specular_v2(gx_surface_v2(in.world_position, n, in.tint.rgb, params.pbr.x, params.pbr.y), dpdx(n), dpdy(n));
    return vec4<f32>(gx_shade_pbr(s), 1.0);
}
";

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_v2_material_filters_specular_aliasing_as_the_built_in_surface_does_when_it_asks() {
    // Contract review: v2 materials got no geometric specular AA while the docs said they shade as
    // a built-in surface does. `gx_surface_v2` still takes no derivatives (callers may branch);
    // `gx_filter_specular_v2` widens the roughness as the forward pass does.
    let Some(gpu) = gpu() else { return };
    let (map, environment) = (showcase_map(), showcase_environment());
    let (_maps, views) = baked_environment(&gpu, &environment, &map);
    let (metallic, roughness) = (1.0, 0.04);
    let renderer_with_aa = || {
        let mut renderer = ibl_renderer(&gpu, &environment, &map);
        let mut quality = ibl_quality();
        quality.specular_aa = true;
        renderer.set_quality(&quality);
        renderer
    };
    let built_in = {
        let mut renderer = renderer_with_aa();
        let mut scene = sphere_backdrop();
        scene.draw(MeshId::SPHERE, sphere_model(), Material::color(SPHERE_TINT).with_pbr(metallic, roughness));
        let mut none = CustomMaterials::new(&gpu.device, core(), renderer.sample_count());
        hdr_scene_with(&gpu, &mut renderer, &mut none, &scene, &[])
    };
    let custom = |source: &str| {
        let mut renderer = renderer_with_aa();
        let mut materials = CustomMaterials::new(&gpu.device, core(), renderer.sample_count());
        let pbr = materials.add_api(&gpu, ABI_V2, source, &pbr_uniforms(metallic, roughness), &[]).expect("a v2 material");
        materials.set_environment(Some(views.clone()));
        let draw = CustomDraw { id: None, mesh: MeshId::SPHERE, model: sphere_model(), material: pbr, tint: SPHERE_TINT };
        hdr_scene_with(&gpu, &mut renderer, &mut materials, &sphere_backdrop(), &[draw])
    };
    let disk = lit_disk(&built_in);
    assert!(disk.len() > 400, "the sphere fills the frame's middle ({} pixels)", disk.len());
    let filtered = radiance_outliers(&built_in, &custom(PBR_V2_FILTERED), &disk);
    let plain = radiance_outliers(&built_in, &custom(PBR_V2), &disk);
    assert!(filtered.len() <= RADIANCE_OUTLIERS, "{} pixels of the filtered v2 mirror differ from the built-in one: {:?}", filtered.len(), &filtered[..filtered.len().min(8)]);
    assert!(plain.len() > 4 * RADIANCE_OUTLIERS.max(1), "unfiltered, the v2 mirror differs where the built-in filter widens it ({} pixels)", plain.len());
}

// ---------------------------------------------------------------------------------------------
// The sun's shadows on v2 materials (RQ3 review)

/// v2: a rough dielectric of the tint, shaded by the renderer's own lighting (the shadow rows'
/// ground).
const ROUGH_V2: &str = "
@fragment
fn fs_material(in: GxMaterialInV2) -> @location(0) vec4<f32> {
    let s = gx_surface_v2(in.world_position, in.normal, in.tint.rgb, 0.0, 1.0);
    return vec4<f32>(gx_shade_pbr(s), 1.0);
}
";

/// The shadow rows' frame size.
const SHADOW_ROW_SIZE: (u32, u32) = (320, 180);
/// The ground's tint (sRGB).
const GROUND_TINT: [u8; 4] = [200, 200, 190, 255];

/// A field seen from 7 m up under a sun 25 degrees high: rows of 4 m poles every 4 m out to 70 m,
/// so their shadows fall in every cascade of every preset; the ground built in or, with `custom`,
/// drawn with that v2 material.
fn pole_field(custom: Option<genex_render::extension::CustomMaterialId>) -> ImmediateFrame {
    let mut camera = CameraDesc::look_at([-4.0, 7.0, 6.0], [0.0, 0.0, -24.0]);
    camera.fovy_degrees = 50.0;
    let mut frame = ImmediateFrame::new(camera, [120, 160, 210, 255]);
    frame.lighting_mut().sun_dir = glam::Vec3::new(0.80, 0.42, 0.10).normalize().to_array();
    let ground = scaled([0.0, -0.1, -40.0], [120.0, 0.2, 120.0]);
    match custom {
        Some(material) => frame.custom(MeshId::CUBE, ground, material, GROUND_TINT),
        None => frame.mesh(MeshId::CUBE, ground, Material::color(GROUND_TINT).with_pbr(0.0, 1.0)),
    };
    for row in 0..18 {
        let z = -2.0 - row as f32 * 4.0;
        for x in [-6.0f32, 0.0, 6.0] {
            frame.mesh(MeshId::CUBE, scaled([x, 2.0, z], [0.25, 4.0, 0.25]), Material::color([60, 60, 70, 255]));
        }
    }
    frame
}

/// The pole field under `quality`, its ground built in or a v2 material.
fn pole_field_frame(gpu: &Gpu, quality: &Quality, custom_ground: bool) -> Capture {
    let mut renderer = genex_render::FrameRenderer::new(gpu, SHADOW_ROW_SIZE.0, SHADOW_ROW_SIZE.1, genex_render::RenderOptions::default()).expect("renderer");
    renderer.renderer_mut().set_quality(quality);
    let material = custom_ground.then(|| renderer.add_material_api(gpu, ABI_V2, ROUGH_V2, &[], &[]).expect("a v2 material"));
    for _ in 0..3 {
        renderer.render(gpu, &pole_field(material), CullPath::Gpu, None).expect("frame");
    }
    renderer.capture(gpu).expect("capture")
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_v2_material_is_shadowed_as_the_built_in_surface_beside_it_on_every_preset_and_cascade() {
    use genex_render::device_class::{DeviceClass, FormFactor, PerformanceTier};
    let Some(gpu) = gpu() else { return };
    let desktop = DeviceClass::new(FormFactor::Desktop, PerformanceTier::Ultra);
    for preset in [QualityPreset::Low, QualityPreset::Medium, QualityPreset::High, QualityPreset::Ultra] {
        // With the presets' contact shadows on (high and ultra): the v2 map binds the mask at
        // `contact_shadow_mask` (RQ4 review), so they reach the v2 ground as the built-in one.
        let quality = preset_quality(preset, desktop);
        let built_in = pole_field_frame(&gpu, &quality, false);
        let custom = pole_field_frame(&gpu, &quality, true);
        write_capture_evidence(&format!("v2-shadows-{}-built-in", preset.wire()), &built_in);
        write_capture_evidence(&format!("v2-shadows-{}-custom", preset.wire()), &custom);
        let mut unshadowed = quality;
        unshadowed.shadows.enabled = false;
        let open = pole_field_frame(&gpu, &unshadowed, false);
        let sum = |p: &[u8]| i32::from(p[0]) + i32::from(p[1]) + i32::from(p[2]);
        let shadowed = built_in.bgra().chunks(4).zip(open.bgra().chunks(4)).filter(|(s, o)| sum(s) * 10 < sum(o) * 8).count();
        assert!(shadowed > 500, "{preset:?}: the poles shadow the ground ({shadowed} pixels)");
        let differ = built_in.bgra().chunks(4).zip(custom.bgra().chunks(4)).filter(|(a, b)| a.iter().zip(b.iter()).any(|(x, y)| x.abs_diff(*y) > 6)).count();
        let pixels = SHADOW_ROW_SIZE.0 * SHADOW_ROW_SIZE.1;
        eprintln!("{preset:?}: {differ} of {pixels} pixels differ between the built-in and the v2 ground ({shadowed} shadowed)");
        // Before the RQ3 review: 99 / 297 / 824 differed at low / medium / high (3x3 PCF at every
        // preset, no band or end fade, two cascades); before the RQ4 review's contact-shadow slot
        // 242 / 181 at high / ultra (the built-in ground's contact shadows only); now about 1 in 15
        // of the shadowed pixels or fewer (the v2 surface keys its tap rotation to its pixel).
        assert!(differ * 12 <= shadowed, "{preset:?}: {differ} pixels of the v2 ground are shadowed otherwise than the built-in one ({shadowed} shadowed)");
    }
}

/// Write `capture`'s BGRA under `GENEX_RENDER_EVIDENCE_DIR` (evidence, never compared).
fn write_capture_evidence(name: &str, capture: &Capture) {
    if let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") {
        let dir = PathBuf::from(dir);
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join(format!("{name}.bgra")), capture.bgra()).expect("evidence");
    }
}

/// Hills of ground out to a few kilometres under the physical sky, seen from just above it: the
/// ground built in or, with `custom`, drawn with that v2 material.
fn far_ground(custom: Option<genex_render::extension::CustomMaterialId>) -> ImmediateFrame {
    let mut camera = CameraDesc::look_at([0.0, 30.0, 40.0], [0.0, 0.0, -2000.0]);
    camera.far = 8000.0;
    let mut frame = ImmediateFrame::new(camera, [120, 160, 210, 255]);
    frame.lighting_mut().sun_dir = glam::Vec3::new(0.5, 0.35, -0.6).normalize().to_array();
    let ground = scaled([0.0, -0.1, -2500.0], [6000.0, 0.2, 6000.0]);
    match custom {
        Some(material) => frame.custom(MeshId::CUBE, ground, material, GROUND_TINT),
        None => frame.mesh(MeshId::CUBE, ground, Material::color(GROUND_TINT).with_pbr(0.0, 1.0)),
    };
    frame
}

/// The far ground on the medium preset (the aerial perspective on) under the physical sky, with
/// the look's aerial perspective `air` and its ground built in or a v2 material.
fn far_ground_frame(gpu: &Gpu, air: bool, custom_ground: bool) -> Capture {
    use genex_render::device_class::{DeviceClass, FormFactor, PerformanceTier};
    use genex_render::settings::{Environment, Fog, SceneFormat};
    let class = DeviceClass::new(FormFactor::Desktop, PerformanceTier::Ultra);
    let quality = preset_quality(QualityPreset::Medium, class);
    let options = genex_render::RenderOptions { msaa: genex_render::renderer::landed_samples(quality.anti_aliasing) > 1 };
    let mut renderer = genex_render::FrameRenderer::new(gpu, SHADOW_ROW_SIZE.0, SHADOW_ROW_SIZE.1, options).expect("renderer");
    let part1 = renderer.renderer_mut();
    part1.set_scene_format(SceneFormat::Rgba16Float);
    part1.set_device_class(class);
    part1.set_quality(&quality);
    part1.set_look(part1.look().with_fog(Fog::default().with_aerial_perspective(air)));
    part1.set_environment(&Environment::sky());
    let material = custom_ground.then(|| renderer.add_material_api(gpu, ABI_V2, ROUGH_V2, &[], &[]).expect("a v2 material"));
    for _ in 0..3 {
        renderer.render(gpu, &far_ground(material), CullPath::Gpu, None).expect("frame");
    }
    renderer.capture(gpu).expect("capture")
}

/// RQ4 review (contract 2): a v2 material reaches the aerial perspective as a built-in surface
/// does (its prelude binds the renderer's volume at `aerial_perspective` and `gx_shade_pbr` hazes
/// through `gx_apply_fog_aerial`): under the physical sky on medium, far ground drawn with a v2
/// material is hazed like the built-in ground (red before: the v2 map bound a texel of no air and
/// `gx_shade_pbr` applied the height fog alone).
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_v2_material_under_the_physical_sky_is_hazed_as_the_built_in_surface() {
    let Some(gpu) = gpu() else { return };
    let (built_in, custom, clear) = (far_ground_frame(&gpu, true, false), far_ground_frame(&gpu, true, true), far_ground_frame(&gpu, false, false));
    write_capture_evidence("v2-aerial-built-in", &built_in);
    write_capture_evidence("v2-aerial-custom", &custom);
    write_capture_evidence("v2-aerial-clear", &clear);
    let pixels = (SHADOW_ROW_SIZE.0 * SHADOW_ROW_SIZE.1) as usize;
    let differing = |a: &Capture, b: &Capture, by: u8| a.bgra().chunks(4).zip(b.bgra().chunks(4)).filter(|(x, y)| x.iter().zip(y.iter()).take(3).any(|(p, q)| p.abs_diff(*q) > by)).count();
    // Any level counts (renderer pass 2 SI-04 flipped this from "more than a level"): with the air's
    // transmittance per channel the warm ground's red is no longer dimmed by the blue channel's
    // extinction, so the haze over it is the sky's blue in-scatter alone, one level at 2 km.
    let (hazed, apart) = (differing(&built_in, &clear, 0), differing(&built_in, &custom, 0));
    eprintln!("far ground: the air moves {hazed} of {pixels} pixels; the v2 ground differs from the built-in in {apart}");
    assert!(hazed > 1000, "the aerial perspective hazes the far ground ({hazed} pixels)");
    assert!(apart * 20 <= hazed, "the v2 ground is hazed otherwise than the built-in one in {apart} pixels ({hazed} hazed)");
}

// ---------------------------------------------------------------------------------------------
// RX-5 (RQ5.5): the prepass's motion reaches Level-2 v2 post passes and Level-3 v2 passes

/// An orthographic camera whose pixels are 0.1 world units on the 128x72 target (tests/motion.rs).
fn motion_camera() -> CameraDesc {
    CameraDesc::look_at([0.0, 0.0, 10.0], [0.0, 0.0, 0.0]).orthographic(HEIGHT as f32 * 0.1)
}

/// World units a cube moves right between the two motion frames: four pixels.
const CUBE_STEP: f32 = 0.4;
/// The cube's NDC motion: four pixels of 128 across NDC's width of 2.
const CUBE_MOTION_NDC: f32 = 4.0 * 2.0 / WIDTH as f32;
/// How far a probe's encoded motion may sit from the motion target's (f16 storage, 8-bit output).
const MOTION_LEVELS: u8 = 2;

/// A 2 m cube named "cube" at `x`, under [`motion_camera`].
fn cube_at(x: f32) -> Scene {
    let mut scene = Scene::new(motion_camera(), [0, 0, 0, 255]);
    scene.lighting.shadows = false;
    scene.set_id(Some(genex_render::motion::DrawId::from("cube")));
    scene.draw(MeshId::CUBE, scaled([x, 0.0, 0.0], [2.0, 2.0, 2.0]), Material::color([180, 180, 180, 255]));
    scene
}

/// The prepass's motion of the named cube moving [`CUBE_STEP`] right, drawn by the RQ5.1 motion
/// node (the second frame, matched by its id), uploaded as the frame's `rg16float` motion target.
fn moving_cube_motion(gpu: &Gpu) -> (wgpu::TextureView, Vec<[f32; 2]>) {
    use genex_render::motion::{MOTION_FORMAT, MotionFrameInput, motion_images};
    let library = genex_render::scene::MeshLibrary::new();
    let frames = [
        MotionFrameInput { scene: cube_at(0.0), jitter_px: [0.0; 2], reset: true },
        MotionFrameInput { scene: cube_at(CUBE_STEP), jitter_px: [0.0; 2], reset: false },
    ];
    let images = motion_images(gpu, &library, (WIDTH, HEIGHT), true, &frames).expect("motion");
    let motion = images[1].motion.clone();
    let at = (HEIGHT as usize / 2) * WIDTH as usize + WIDTH as usize / 2 + 2;
    assert!((motion[at][0] - CUBE_MOTION_NDC).abs() < 1e-3, "the motion node moved the cube right ({:?})", motion[at]);
    let halves: Vec<u16> = motion.iter().flat_map(|m| m.map(genex_render::post::tonemap::f32_to_f16)).collect();
    let texture = gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("moving cube motion"),
        size: wgpu::Extent3d { width: WIDTH, height: HEIGHT, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: MOTION_FORMAT,
        usage: genex_render::motion::MOTION_USAGE | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    gpu.queue.write_texture(
        texture.as_image_copy(),
        bytemuck::cast_slice(&halves),
        wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(WIDTH * 4), rows_per_image: Some(HEIGHT) },
        texture.size(),
    );
    (texture.create_view(&Default::default()), motion)
}

/// A motion texel as the probes encode it: 0.5 + 4 × NDC in red and green.
fn encoded_motion(motion: [f32; 2]) -> [u8; 2] {
    motion.map(|m| ((0.5 + 4.0 * m).clamp(0.0, 1.0) * 255.0).round() as u8)
}

/// Assert `capture`'s red and green are `motion` encoded, everywhere, and that the cube moved.
fn assert_reads_motion(what: &str, capture: &Capture, motion: &[[f32; 2]]) {
    let mut off = 0;
    for y in 0..HEIGHT {
        for x in 0..WIDTH {
            let [_, g, r, _] = pixel(capture, x, y);
            let [er, eg] = encoded_motion(motion[(y * WIDTH + x) as usize]);
            if r.abs_diff(er) > MOTION_LEVELS || g.abs_diff(eg) > MOTION_LEVELS {
                off += 1;
            }
        }
    }
    let [_, _, centre, _] = pixel(capture, WIDTH / 2 + 2, HEIGHT / 2);
    let moved = encoded_motion([CUBE_MOTION_NDC, 0.0])[0];
    assert!(centre.abs_diff(moved) <= MOTION_LEVELS, "{what}: the cube's pixels read its motion (red {centre}, expected {moved}; 128 is no motion)");
    assert_eq!(off, 0, "{what}: {off} pixels differ from the motion target");
}

/// v2 post: the motion it reads at its pixel, encoded 0.5 + 4 × NDC in red and green.
const MOTION_POST_V2: &str = "
@fragment
fn fs_post(in: GxPostInV2) -> @location(0) vec4<f32> {
    let size = vec2<i32>(textureDimensions(gx_motion));
    let m = textureLoad(gx_motion, min(vec2<i32>(in.position.xy), size - vec2<i32>(1)), 0).xy;
    return vec4<f32>(clamp(vec2<f32>(0.5) + 4.0 * m, vec2<f32>(0.0), vec2<f32>(1.0)), 0.0, 1.0);
}
";

/// RQ5.5 red first: a v2 post pass reading `gx_motion` sees the moving cube's motion the frame hands
/// it ([`PostFrame::motion`]), not the neutral zero.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_v2_post_pass_reading_gx_motion_sees_the_moving_cubes_motion() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = Renderer::new(&gpu, WIDTH, HEIGHT).expect("renderer");
    let mut posts = PostPasses::new(&gpu.device, core()).expect("posts");
    let probe = posts.add_api(&gpu, ABI_V2, PostStage::Ldr, MOTION_POST_V2, &[], &[]).expect("a v2 post reading gx_motion");
    assert_eq!(posts.inputs(), RenderInputs::MOTION);
    renderer.render(&gpu, &base_scene(), CullPath::Gpu).expect("frame");
    let (view, motion) = moving_cube_motion(&gpu);
    write_motion_evidence("v2-post-gx-motion-target", &motion);
    let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("motion probe") });
    let frame = PostFrame { motion: Some(&view), ..PostFrame::new(renderer.size(), 0.0) };
    posts.encode_stage(&gpu, &mut encoder, (renderer.world_texture(), renderer.world_view()), &[probe], PostStage::Ldr, &frame);
    gpu.queue.submit([encoder.finish()]);
    let read = renderer.capture(&gpu).expect("capture");
    write_capture_evidence("v2-post-gx-motion-read", &read);
    assert_reads_motion("the v2 post pass", &read, &motion);
}

/// Write `motion` under `GENEX_RENDER_EVIDENCE_DIR` as raw BGRA8 (red and green 0.5 + 4 × NDC).
fn write_motion_evidence(name: &str, motion: &[[f32; 2]]) {
    let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") else { return };
    let dir = PathBuf::from(dir);
    let _ = std::fs::create_dir_all(&dir);
    let bytes: Vec<u8> = motion.iter().flat_map(|m| {
        let [r, g] = encoded_motion(*m);
        [0, g, r, 255]
    }).collect();
    std::fs::write(dir.join(format!("{name}.bgra")), bytes).expect("evidence");
}

/// A Level-3 v2 probe: the motion its tables' `gx_motion` hold, encoded as [`MOTION_POST_V2`]
/// does; it also checks [`PassFrame::prepass_motion`] answers the target.
const MOTION_PROBE_V2: &str = "
@group(0) @binding(5) var gx_motion: texture_2d<f32>;

struct VsOut { @builtin(position) position: vec4<f32> }

@vertex
fn vs_main(@builtin(vertex_index) i: u32) -> VsOut {
    let uv = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
    var out: VsOut;
    out.position = vec4<f32>(uv * 2.0 - 1.0, 0.0, 1.0);
    return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    let size = vec2<i32>(textureDimensions(gx_motion));
    let m = textureLoad(gx_motion, min(vec2<i32>(in.position.xy), size - vec2<i32>(1)), 0).xy;
    return vec4<f32>(clamp(vec2<f32>(0.5) + 4.0 * m, vec2<f32>(0.0), vec2<f32>(1.0)), 0.0, 1.0);
}
";

/// A v2 pass at `post-hdr` declaring motion, drawing [`MOTION_PROBE_V2`] over the scene target.
#[derive(Default)]
struct MotionProbe {
    pipeline: Option<wgpu::RenderPipeline>,
    /// Whether [`PassFrame::prepass_motion`] answered a target in the last frame.
    handed: bool,
}

impl genex_render::custom_pass::CustomPass for MotionProbe {
    fn rebuild(&mut self, setup: &mut genex_render::custom_pass::PassSetup<'_>) -> Result<(), RenderError> {
        let module = setup.create_shader("motion probe", MOTION_PROBE_V2)?;
        let layout = setup.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("motion probe"), bind_group_layouts: &[Some(setup.tables_layout())], immediate_size: 0 });
        let targets = [Some(wgpu::ColorTargetState { format: setup.world_format(), blend: None, write_mask: wgpu::ColorWrites::ALL })];
        self.pipeline = Some(setup.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("motion probe"),
            layout: Some(&layout),
            vertex: wgpu::VertexState { module: &module, entry_point: Some("vs_main"), compilation_options: Default::default(), buffers: &[] },
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some("fs_main"), compilation_options: Default::default(), targets: &targets }),
            multiview_mask: None,
            cache: None,
        }));
        Ok(())
    }

    fn encode(&mut self, frame: &mut genex_render::custom_pass::PassFrame<'_>) {
        self.handed = frame.prepass_motion().is_some();
        let Some(pipeline) = self.pipeline.clone() else { return };
        let tables = frame.tables().clone();
        let Some(view) = frame.world_view().cloned() else { return };
        let Some(encoder) = frame.encoder() else { return };
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("motion probe"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store },
            })],
            ..Default::default()
        });
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &tables, &[]);
        pass.draw(0..3, 0..1);
    }

    fn api(&self) -> u32 {
        2
    }

    fn inputs(&self) -> RenderInputs {
        // Declaring motion alone asks the renderer for no depth/normal prepass of its own, so the
        // targets handed to the stage below are the ones bound.
        RenderInputs::MOTION
    }
}

/// RQ5.5: a Level-3 v2 pass declaring motion reads the frame's motion target in its v2 tables
/// (`gx_motion`) and through [`PassFrame::prepass_motion`] once the frame handed it over
/// ([`CustomStage::prepass_motion`]).
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_level_3_v2_pass_declaring_motion_reads_the_motion_target_it_was_handed() {
    use genex_render::custom_pass::{CustomPass, CustomPasses, CustomStage, PassStage, PrepassViews, render_scene};
    let Some(gpu) = gpu() else { return };
    let mut renderer = Renderer::new(&gpu, WIDTH, HEIGHT).expect("renderer");
    let mut passes = CustomPasses::new(&gpu, &renderer, wgpu::Features::empty());
    let mut probe = MotionProbe::default();
    passes.register(&gpu, "motion probe", PassStage::PostHdr, &mut probe).expect("a v2 post-hdr pass reading motion");
    let (view, motion) = moving_cube_motion(&gpu);
    let (depth, normals) = synthetic_prepass(&gpu);
    let mut list: [&mut dyn CustomPass; 1] = [&mut probe];
    let mut run = passes.frame(&gpu, &mut list, 2).expect("frame passes");
    run.prepass_motion(&view);
    run.after_prepass(&PrepassViews { depth, normals });
    render_scene(&mut renderer, &gpu, &base_scene(), CullPath::Gpu, &mut run).expect("frame");
    drop(run);
    assert!(passes.refusals().is_empty(), "{:?}", passes.refusals());
    assert!(probe.handed, "PassFrame::prepass_motion answers the frame's motion target");
    let read = renderer.capture(&gpu).expect("capture");
    write_capture_evidence("l3-v2-gx-motion-read", &read);
    assert_reads_motion("the Level-3 v2 pass", &read, &motion);
}

// ---------------------------------------------------------------------------------------------
// The v2 frame under TAA (RQ5 review): the remap jittered `view_proj` and `proj` but kept the CPU's
// unjittered inverse, so `view_proj × inv_view_proj` was not the identity and depth-to-world was
// off by up to half a pixel, differently every frame; `prev_jitter` and `GxPostV2::jitter` were
// always 0.

/// The jitter of a TAA frame and its previous frame, NDC (as `jitter::offset_ndc` gives them).
const FRAME_JITTER: [f32; 2] = [0.0078125, -0.0046296];
const PREV_JITTER: [f32; 2] = [-0.0039062, 0.0092593];

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_v2_frame_under_taa_inverts_its_jittered_projection_and_carries_both_jitters() {
    let Some(gpu) = gpu() else { return };
    let mut frame_v2 = genex_render::extension::FrameV2::new(&gpu.device).expect("v2 frame");
    let camera = camera();
    let facts = FrameFacts { depth_reversed: true, scene_ldr: false, history_reset: false, ..FrameFacts::new((WIDTH, HEIGHT), (WIDTH, HEIGHT)) };
    frame_v2.write(&gpu.queue, &facts.with_camera(camera), 0.0);
    let view_proj = camera.view_proj_reversed(WIDTH as f32 / HEIGHT as f32);
    let uniforms = genex_render::layout::GpuFrame {
        view_proj: view_proj.to_cols_array(),
        jitter: [FRAME_JITTER[0], FRAME_JITTER[1], PREV_JITTER[0], PREV_JITTER[1]],
        ..Default::default()
    };
    let source = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("frame uniforms"),
        size: size_of::<genex_render::layout::GpuFrame>() as u64,
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    gpu.queue.write_buffer(&source, 0, bytemuck::bytes_of(&uniforms));
    let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("remap") });
    frame_v2.refresh(&gpu.device, &mut encoder, &source);
    gpu.queue.submit([encoder.finish()]);
    let frame = frame_v2.read_back(&gpu).expect("read back");
    assert_eq!((frame.jitter, frame.prev_jitter), (FRAME_JITTER, PREV_JITTER), "this frame's jitter and last frame's");
    let product = glam::Mat4::from_cols_array(&frame.view_proj) * glam::Mat4::from_cols_array(&frame.inv_view_proj);
    assert!(product.abs_diff_eq(glam::Mat4::IDENTITY, 1e-4), "view_proj × inv_view_proj is the identity under jitter: {product:?}");
    let unjittered = glam::Mat4::from_cols_array(&frame.unjittered_view_proj);
    assert!(!unjittered.abs_diff_eq(glam::Mat4::from_cols_array(&frame.view_proj), 1e-6), "view_proj is the jittered one");
}

const JITTER_V2: &str = r#"
@fragment
fn fs_post(in: GxPostInV2) -> @location(0) vec4<f32> {
    return vec4<f32>(0.5 + gx_post.jitter.x * 32.0, 0.5 + gx_post.jitter.y * 32.0, 0.0, 1.0);
}
"#;

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_v2_post_pass_reads_the_frames_jitter() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = Renderer::new(&gpu, WIDTH, HEIGHT).expect("renderer");
    let mut posts = PostPasses::new(&gpu.device, core()).expect("posts");
    let id = posts.add_api(&gpu, ABI_V2, PostStage::Ldr, JITTER_V2, &[], &[]).expect("a v2 post");
    renderer.render(&gpu, &base_scene(), CullPath::Gpu).expect("frame");
    let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("post jitter") });
    let frame = PostFrame { jitter: FRAME_JITTER, ..PostFrame::new(renderer.size(), 0.0) };
    posts.encode_stage(&gpu, &mut encoder, (renderer.world_texture(), renderer.world_view()), &[id], PostStage::Ldr, &frame);
    gpu.queue.submit([encoder.finish()]);
    let shot = renderer.capture(&gpu).expect("capture");
    let [b, g, r, _] = pixel(&shot, WIDTH / 2, HEIGHT / 2);
    let expected = |jitter: f32| ((0.5 + jitter * 32.0) * 255.0).round() as i32;
    assert!((i32::from(r) - expected(FRAME_JITTER[0])).abs() <= 1 && (i32::from(g) - expected(FRAME_JITTER[1])).abs() <= 1, "rgb {r} {g} {b}");
}

// ---------------------------------------------------------------------------------------------
// Renderer pass 2, P2-0.14 (RC-01, RC-16 row 1): the hdr and ldr post stages each write their own
// rows. Both stages' rows used to be written into one buffer by `queue.write_buffer` before the
// frame's one submission, so the ldr stage's (the output's size) overwrote the hdr stage's (the
// render size): below scale 1 an hdr pass sampled a cropped scene.

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_an_hdr_post_pass_keeps_its_render_size_rows_when_an_ldr_pass_runs_in_the_frame() {
    let Some(gpu) = gpu() else { return };
    let mut images = Vec::new();
    for with_ldr in [false, true] {
        let mut frames = ibl_frame_renderer(&gpu, &genex_render::settings::Environment::Color, None);
        frames.renderer_mut().set_render_scale(0.5);
        let uv = frames.add_post_pass_api(&gpu, ABI_V2, PostStage::Hdr, UV_V2, &[], &[]).expect("a v2 hdr post writing gx_scene_uv");
        let identity = frames.add_post_pass_api(&gpu, ABI_V1, PostStage::Ldr, IDENTITY_V1, &[], &[]).expect("a v1 ldr identity post");
        let mut frame = base_frame();
        frame.post_pass(uv);
        if with_ldr {
            frame.post_pass(identity);
        }
        frames.render(&gpu, &frame, CullPath::Gpu, None).expect("frame");
        assert_eq!(frames.renderer().render_size(), (WIDTH / 2, HEIGHT / 2), "drawn at scale 0.5");
        images.push(frames.capture(&gpu).expect("capture"));
    }
    let (alone, beside_ldr) = (&images[0], &images[1]);
    let worst = alone.bgra().chunks(4).zip(beside_ldr.bgra().chunks(4)).map(|(a, b)| a[..3].iter().zip(&b[..3]).map(|(x, y)| x.abs_diff(*y)).max().unwrap_or(0)).max().unwrap_or(0);
    let corner = |capture: &Capture| pixel(capture, WIDTH - 2, HEIGHT - 2);
    assert!(worst <= 1, "the hdr pass beside an ldr pass reads other rows: worst channel {worst}, far corner {:?} against {:?} alone", corner(beside_ldr), corner(alone));
}

// ---------------------------------------------------------------------------------------------
// Renderer pass 2, P2-0.14 (RC-04, RC-16 row 3): a Level-2 pipeline compiles inside error scopes,
// so a source naga accepts but the pipeline cannot take is a typed refusal, never a panic of the
// device's uncaptured-error handler on a compile thread raised again at the first draw.

/// v2 material that naga accepts: an unsigned colour, which the float scene target cannot take
/// (the pipeline fails, not the source).
const UNSIGNED_MATERIAL_V2: &str = "
@fragment
fn fs_material(in: GxMaterialInV2) -> @location(0) vec4<u32> {
    return vec4<u32>(1u, 2u, 3u, 4u);
}
";

/// v2 post pass with the same unsigned output.
const UNSIGNED_POST_V2: &str = "
@fragment
fn fs_post(in: GxPostInV2) -> @location(0) vec4<u32> {
    return vec4<u32>(1u, 2u, 3u, 4u);
}
";

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_level_2_source_whose_pipeline_fails_after_naga_accepts_it_is_refused_typed() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = Renderer::new(&gpu, WIDTH, HEIGHT).expect("renderer");
    validate_api(ExtensionKind::Material, ABI_V2, UNSIGNED_MATERIAL_V2, &core()).expect("naga accepts the material");
    validate_api(ExtensionKind::PostPass, ABI_V2, UNSIGNED_POST_V2, &core()).expect("naga accepts the post pass");
    let mut materials = CustomMaterials::new(&gpu.device, core(), renderer.sample_count());
    let error = materials.add_api(&gpu, ABI_V2, UNSIGNED_MATERIAL_V2, &[], &[]).expect_err("the material's pipeline fails");
    assert_eq!(fault(&error), Some(ExtensionFault::Invalid), "a typed refusal: {error}");
    let mut posts = PostPasses::new(&gpu.device, core()).expect("posts");
    let error = posts.add_api(&gpu, ABI_V2, PostStage::Ldr, UNSIGNED_POST_V2, &[], &[]).expect_err("the post pass's pipeline fails");
    assert_eq!(fault(&error), Some(ExtensionFault::Invalid), "a typed refusal: {error}");
    // Nothing was admitted: the renderer and both registries keep drawing.
    assert!(materials.is_empty() && posts.is_empty());
    let shaded = materials.add_api(&gpu, ABI_V2, SHADED_V2, &shaded_uniforms(), &[]).expect("a good material after the refusal");
    let frame = draw_with(&gpu, &mut renderer, &mut materials, &walled_scene(), &[centre_draw(shaded)]);
    assert_eq!((frame.width(), frame.height()), (WIDTH, HEIGHT));
}
