//! The HDR path through the [`FrameRenderer`] (RQ1.7 integration): what the presenter draws every
//! facade frame with. Particles, Level-2 materials and post passes follow the session's scene
//! format; a v1 material keeps the frame on the legacy LDR scene and says why; `hdr`-stage post
//! passes and Level-3 `post-hdr` passes run on the HDR scene at graph node 18, before the tonemap.
//!
//! Every row needs a GPU: they are `#[ignore]`d and every name contains `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked -- --ignored metal

use genex_render::abi::ABI_V2;
use genex_render::capture::Capture;
use genex_render::custom_pass::{CustomPass, CustomPasses, PassFrame, PassSetup, PassStage};
use genex_render::extension::PostStage;
use genex_render::immediate::ImmediateFrame;
use genex_render::particles::EmitterDesc;
use genex_render::post::tonemap::MsaaResolve;
use genex_render::scene::{CameraDesc, Material, MeshId, PointLight, scaled, translation};
use genex_render::settings::{SceneFormat, Tonemapper};
use genex_render::{CullPath, FrameRenderer, Gpu, LdrReason, Quality, RenderError, RenderOptions};

const WIDTH: u32 = 128;
const HEIGHT: u32 = 72;

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

fn camera() -> CameraDesc {
    CameraDesc::look_at([0.0, 3.0, 8.0], [0.0, 0.5, 0.0])
}

fn base_frame() -> ImmediateFrame {
    let mut frame = ImmediateFrame::new(camera(), [20, 24, 32, 255]);
    frame.mesh(MeshId::CUBE, scaled([0.0, -0.05, 0.0], [8.0, 0.1, 8.0]), Material::color([110, 110, 120, 255]));
    frame.cube(translation(-1.5, 0.5, 0.0), [200, 60, 50, 255]);
    frame
}

/// A renderer on the HDR path: the quality asks for HDR and the session's scene format is HDR.
fn hdr_renderer(gpu: &Gpu) -> FrameRenderer {
    let mut renderer = FrameRenderer::new(gpu, WIDTH, HEIGHT, RenderOptions::default()).expect("renderer");
    let mut quality = Quality::off();
    quality.hdr = true;
    quality.tonemap = true;
    renderer.renderer_mut().set_quality(&quality);
    renderer.renderer_mut().set_scene_format(SceneFormat::Rgba16Float);
    renderer
}

fn draw(gpu: &Gpu, renderer: &mut FrameRenderer, frame: &ImmediateFrame) -> Capture {
    renderer.render(gpu, frame, CullPath::Gpu, None).expect("frame");
    renderer.capture(gpu).expect("capture")
}

/// v1: a flat sRGB colour.
const FLAT_V1: &str = "
@fragment
fn fs_material(in: GxMaterialIn) -> @location(0) vec4<f32> {
    return vec4<f32>(0.8, 0.2, 0.2, 1.0);
}
";

/// v2: the renderer's own shading of a warm surface.
const SHADED_V2: &str = "
@fragment
fn fs_material(in: GxMaterialInV2) -> @location(0) vec4<f32> {
    let s = gx_surface_v2(in.world_position, in.normal, vec3<f32>(0.85, 0.55, 0.2) * in.tint.rgb, 0.0, 0.5);
    return vec4<f32>(gx_shade_pbr(s), 1.0);
}
";

/// v2 post at stage hdr: a red far brighter than display white, written into the HDR scene.
const BLINDING_RED_V2: &str = "
@fragment
fn fs_post(in: GxPostInV2) -> @location(0) vec4<f32> {
    return vec4<f32>(4.0, 0.0, 0.0, 1.0);
}
";

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_particles_draw_on_the_hdr_scene() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = hdr_renderer(&gpu);
    let emitter = renderer.add_emitter(&gpu, EmitterDesc::fountain([0.0, 0.5, 0.0], 7)).expect("emitter");
    let mut frame = base_frame();
    frame.particles(emitter, 30);
    let plain = draw(&gpu, &mut renderer, &base_frame());
    let with_particles = draw(&gpu, &mut renderer, &frame);
    let path = renderer.renderer().last_scene().expect("a frame");
    assert!(path.hdr, "particles never keep a frame off the HDR path: {path:?}");
    assert_ne!(with_particles.digest(), plain.digest(), "the particles drew into the HDR scene");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_v1_material_keeps_the_frame_ldr_and_a_v2_one_draws_hdr() {
    let Some(gpu) = gpu() else { return };
    let mut v1 = hdr_renderer(&gpu);
    let flat = v1.add_material(&gpu, FLAT_V1, &[]).expect("a v1 material");
    let mut frame = base_frame();
    frame.custom(MeshId::CUBE, translation(1.5, 0.5, 0.0), flat, [255, 255, 255, 255]);
    draw(&gpu, &mut v1, &frame);
    let path = v1.renderer().last_scene().expect("a frame");
    assert!(!path.hdr && !path.depth_reversed, "a v1 material keeps the legacy scene: {path:?}");
    assert_eq!(path.ldr_reason, Some(LdrReason::MaterialV1InHdr));
    assert_eq!(v1.ldr_reason(), Some(LdrReason::MaterialV1InHdr), "the renderer names why its frames stay LDR");

    let mut v2 = hdr_renderer(&gpu);
    let shaded = v2.add_material_api(&gpu, ABI_V2, SHADED_V2, &[], &[]).expect("a v2 material");
    let mut frame = base_frame();
    frame.custom(MeshId::CUBE, translation(1.5, 0.5, 0.0), shaded, [255, 255, 255, 255]);
    let plain = draw(&gpu, &mut v2, &base_frame());
    let drawn = draw(&gpu, &mut v2, &frame);
    let path = v2.renderer().last_scene().expect("a frame");
    assert!(path.hdr && path.depth_reversed, "a v2 material draws on the HDR scene: {path:?}");
    assert_eq!(v2.ldr_reason(), None);
    assert_ne!(drawn.digest(), plain.digest(), "the v2 material drew");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_an_hdr_stage_post_pass_writes_the_scene_before_the_tonemap() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = hdr_renderer(&gpu);
    let mut look = *renderer.renderer().look();
    look.tonemapper = Tonemapper::Agx;
    renderer.renderer_mut().set_look(look);
    let red = renderer.add_post_pass_api(&gpu, ABI_V2, PostStage::Hdr, BLINDING_RED_V2, &[], &[]).expect("a v2 hdr post pass");
    let mut frame = base_frame();
    frame.post_pass(red);
    let capture = draw(&gpu, &mut renderer, &frame);
    assert!(renderer.renderer().last_scene().is_some_and(|path| path.hdr));
    let [b, g, r, _] = capture.bgra()[(36 * WIDTH as usize + 64) * 4..][..4] else { panic!("pixel") };
    // Clamped on the world target the red would read (255, 0, 0); through AgX it is a tonemapped
    // highlight: below full red or lifted towards white.
    assert!(r > 150 && (r < 255 || g > 0 || b > 0), "the pass ran before the tonemap (BGRA {b} {g} {r})");
}

/// A v2 `post-hdr` pass that notes the target it was handed (format, depth convention, size).
#[derive(Default)]
struct SeesScene {
    seen: Vec<(wgpu::TextureFormat, bool, (u32, u32))>,
}

impl CustomPass for SeesScene {
    fn rebuild(&mut self, _setup: &mut PassSetup<'_>) -> Result<(), RenderError> {
        Ok(())
    }

    fn encode(&mut self, frame: &mut PassFrame<'_>) {
        if let Some(target) = frame.world_texture() {
            self.seen.push((target.format(), frame.depth_reversed(), frame.render_size()));
        }
    }

    fn api(&self) -> u32 {
        2
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_post_hdr_pass_sees_the_hdr_scene_at_node_eighteen() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = hdr_renderer(&gpu);
    renderer.renderer_mut().set_render_scale(0.5);
    let mut passes = CustomPasses::new(&gpu, renderer.renderer(), wgpu::Features::empty());
    let mut sees = SeesScene::default();
    passes.register(&gpu, "sees", PassStage::PostHdr, &mut sees).expect("a v2 post-hdr pass");
    let facts = renderer.pipeline_facts(passes.ldr_reason());
    assert_eq!((facts.scene_format, facts.depth_reversed), (wgpu::TextureFormat::Rgba16Float, true), "the next frame draws HDR");
    passes.set_pipeline_facts(&gpu, &mut [&mut sees], facts).expect("facts");
    passes.set_render_size(renderer.renderer().render_size());
    let mut list: [&mut dyn CustomPass; 1] = [&mut sees];
    let mut run = passes.frame(&gpu, &mut list, 3).expect("frame passes");
    renderer.render_with(&gpu, &base_frame(), CullPath::Gpu, None, &mut run).expect("frame");
    drop(run);
    assert!(passes.refusals().is_empty(), "{:?}", passes.refusals());
    let half = (WIDTH / 2, HEIGHT / 2);
    assert_eq!(sees.seen, vec![(wgpu::TextureFormat::Rgba16Float, true, half)], "post-hdr ran once, on the HDR scene at render size");
}

/// v2: an emissive far past the half-float limit, written through the prelude's exposure helper.
const BLINDING_EMISSIVE_V2: &str = "
@fragment
fn fs_material(in: GxMaterialInV2) -> @location(0) vec4<f32> {
    return vec4<f32>(gx_expose(vec3<f32>(1.0e6)), 1.0);
}
";

/// v2 post at stage hdr: the whole scene far past the half-float limit, through `gx_expose`.
const BLINDING_POST_V2: &str = "
@fragment
fn fs_post(in: GxPostInV2) -> @location(0) vec4<f32> {
    return vec4<f32>(gx_expose(vec3<f32>(1.0e6)), 1.0);
}
";

/// v2: the renderer's own shading of the draw's (linear) tint, metallic 0, roughness 0.5: what a
/// built-in `Material::color(tint).with_pbr(0.0, 0.5)` surface writes.
const BUILT_IN_V2: &str = "
@fragment
fn fs_material(in: GxMaterialInV2) -> @location(0) vec4<f32> {
    let s = gx_surface_v2(in.world_position, in.normal, in.tint.rgb, 0.0, 0.5);
    return vec4<f32>(gx_shade_pbr(s), 1.0);
}
";

/// The centre cube's colour (sRGB) in the built-in and v2 rows.
const CUBE_TINT: [u8; 4] = [220, 150, 70, 255];

/// The base frame with a warm point light beside the centre and a slab over it shading the cube's
/// top from the sun (the light and the shadow both reach a lit surface).
fn lit_frame(light: bool, slab: bool) -> ImmediateFrame {
    let mut frame = base_frame();
    if light {
        frame.lighting_mut().points.push(PointLight { position: [0.9, 1.4, 1.2], range: 4.0, color: [255, 190, 120], intensity: 6.0 });
    }
    if slab {
        frame.cube(scaled([0.8, 3.0, 0.6], [2.4, 0.1, 2.4]), [90, 90, 90, 255]);
    }
    frame
}

/// Pixels inside `mask` (eroded by one pixel: silhouettes rasterize their coverage apart).
fn inside(mask: &[bool], i: usize) -> bool {
    let (x, y, w) = (i % WIDTH as usize, i / WIDTH as usize, WIDTH as usize);
    let at = |x: usize, y: usize| mask.get(y * w + x).copied().unwrap_or(false);
    x > 0 && y > 0 && at(x, y) && at(x - 1, y) && at(x + 1, y) && at(x, y - 1) && at(x, y + 1)
}

/// The summed channels of `capture` over `mask`.
fn brightness(capture: &Capture, mask: &[bool]) -> u64 {
    capture.bgra().chunks(4).enumerate().filter(|(i, _)| inside(mask, *i)).map(|(_, p)| p[..3].iter().map(|c| u64::from(*c)).sum::<u64>()).sum()
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_v2_material_shades_like_the_built_in_surface_with_lights_and_shadows() {
    let Some(gpu) = gpu() else { return };
    let centre = scaled([0.0, 0.75, 0.0], [1.5, 1.5, 1.5]);
    let built_in = |light: bool, slab: bool| {
        let mut renderer = hdr_renderer(&gpu);
        let mut frame = lit_frame(light, slab);
        frame.mesh(MeshId::CUBE, centre, Material::color(CUBE_TINT).with_pbr(0.0, 0.5));
        draw(&gpu, &mut renderer, &frame)
    };
    let custom = |light: bool, slab: bool| {
        let mut renderer = hdr_renderer(&gpu);
        let shaded = renderer.add_material_api(&gpu, ABI_V2, BUILT_IN_V2, &[], &[]).expect("a v2 material");
        let mut frame = lit_frame(light, slab);
        frame.custom(MeshId::CUBE, centre, shaded, CUBE_TINT);
        let capture = draw(&gpu, &mut renderer, &frame);
        assert!(renderer.renderer().last_scene().is_some_and(|path| path.hdr), "drawn on the HDR scene");
        capture
    };
    // The cube's pixels: where the custom cube changes the frame (custom materials cast no shadow,
    // so nothing else changes).
    let empty = draw(&gpu, &mut hdr_renderer(&gpu), &lit_frame(false, false));
    let plain = custom(false, false);
    let mask: Vec<bool> = empty.bgra().chunks(4).zip(plain.bgra().chunks(4)).map(|(p, q)| p != q).collect();
    assert!((0..mask.len()).filter(|i| inside(&mask, *i)).count() > 200, "the cube covers the middle of the frame");
    // The point light and the slab's shadow reach the v2 material.
    assert!(brightness(&custom(true, false), &mask) > brightness(&plain, &mask) * 11 / 10, "the point light lights the v2 cube");
    assert!(brightness(&custom(false, true), &mask) * 10 / 9 < brightness(&plain, &mask), "the slab shades the v2 cube from the sun");
    // And they light it as they light a built-in surface of the same material.
    for (light, slab) in [(false, false), (true, false), (false, true), (true, true)] {
        let (a, b) = (built_in(light, slab), custom(light, slab));
        let over: Vec<(usize, u8)> = a
            .bgra()
            .chunks(4)
            .zip(b.bgra().chunks(4))
            .enumerate()
            .filter(|(i, _)| inside(&mask, *i))
            .map(|(i, (p, q))| (i, p.iter().zip(q).map(|(x, y)| x.abs_diff(*y)).max().unwrap_or(0)))
            .filter(|(_, diff)| *diff > 3)
            .collect();
        assert!(over.len() <= 8, "light {light}, slab {slab}: {} cube pixels differ from the built-in surface by more than 3 levels: {over:?}", over.len());
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_v2_sources_past_the_half_float_limit_write_no_inf_or_nan() {
    let Some(gpu) = gpu() else { return };
    for resolve in [MsaaResolve::Hardware, MsaaResolve::Weighted] {
        let mut renderer = hdr_renderer(&gpu);
        renderer.renderer_mut().set_msaa_resolve(Some(resolve));
        let blinding = renderer.add_material_api(&gpu, ABI_V2, BLINDING_EMISSIVE_V2, &[], &[]).expect("a v2 material");
        let mut frame = base_frame();
        frame.custom(MeshId::CUBE, scaled([0.0, 0.75, 0.0], [1.5, 1.5, 1.5]), blinding, [255, 255, 255, 255]);
        let capture = draw(&gpu, &mut renderer, &frame);
        let at = (36 * WIDTH as usize + 64) * 4;
        let centre = &capture.bgra()[at..at + 3];
        // inf / inf in the resolve, or inf through the curve, is NaN: written as black.
        assert!(centre.iter().all(|c| *c >= 240), "{resolve:?}: the blinding cube reads white, not NaN black ({centre:?})");
    }
    let mut renderer = hdr_renderer(&gpu);
    let post = renderer.add_post_pass_api(&gpu, ABI_V2, PostStage::Hdr, BLINDING_POST_V2, &[], &[]).expect("a v2 hdr post pass");
    let mut frame = base_frame();
    frame.post_pass(post);
    let capture = draw(&gpu, &mut renderer, &frame);
    let darkest = capture.bgra().chunks(4).map(|p| p[..3].iter().copied().min().unwrap_or(0)).min().unwrap_or(0);
    assert!(darkest >= 240, "every pixel of the blinding post reads white, none NaN black (darkest channel {darkest})");
}

/// A v2 pass at `before-cull` that notes the history each frame hands it.
#[derive(Default)]
struct NotesHistory {
    seen: Vec<(u64, bool)>,
}

impl CustomPass for NotesHistory {
    fn rebuild(&mut self, _setup: &mut PassSetup<'_>) -> Result<(), RenderError> {
        Ok(())
    }

    fn encode(&mut self, frame: &mut PassFrame<'_>) {
        self.seen.push((frame.frame_index(), frame.history_reset()));
    }

    fn api(&self) -> u32 {
        2
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_level_2_and_level_3_v2_sources_read_one_history_across_a_camera_cut() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = hdr_renderer(&gpu);
    let shaded = renderer.add_material_api(&gpu, ABI_V2, SHADED_V2, &[], &[]).expect("a v2 material");
    let mut passes = CustomPasses::new(&gpu, renderer.renderer(), wgpu::Features::empty());
    let mut notes = NotesHistory::default();
    passes.register(&gpu, "notes", PassStage::BeforeCull, &mut notes).expect("a v2 before-cull pass");
    let facts = renderer.pipeline_facts(passes.ldr_reason());
    passes.set_pipeline_facts(&gpu, &mut [&mut notes], facts).expect("facts");
    let mut material_saw = Vec::new();
    let mut renderer_saw = Vec::new();
    for tick in 1..=6u64 {
        let mut frame = base_frame();
        frame.set_tick(tick);
        frame.custom(MeshId::CUBE, translation(1.5, 0.5, 0.0), shaded, [255, 255, 255, 255]);
        if tick == 5 {
            frame.camera_cut();
        }
        let mut list: [&mut dyn CustomPass; 1] = [&mut notes];
        let mut run = passes.frame(&gpu, &mut list, tick).expect("frame passes");
        renderer.render_with(&gpu, &frame, CullPath::Gpu, None, &mut run).expect("frame");
        drop(run);
        let facts = renderer.material_frame_facts();
        material_saw.push((facts.frame_index, facts.history_reset));
        let history = renderer.last_history().expect("a drawn frame");
        renderer_saw.push((history.frame_index, history.history_reset()));
    }
    assert!(renderer_saw[4].1, "the camera cut reset Live's history: {renderer_saw:?}");
    assert_eq!(notes.seen, renderer_saw, "a Level-3 pass reads the frame's history");
    assert_eq!(material_saw, renderer_saw, "a Level-2 material reads the frame's history");
}

/// A frame renderer on the HDR path with auto exposure.
fn auto_exposed(gpu: &Gpu) -> FrameRenderer {
    let mut renderer = hdr_renderer(gpu);
    let mut quality = *renderer.renderer().quality();
    quality.exposure = true;
    renderer.renderer_mut().set_quality(&quality);
    let mut look = *renderer.renderer().look();
    look.exposure = genex_render::settings::ExposureMode::Auto;
    renderer.renderer_mut().set_look(look);
    renderer
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_under_auto_exposure_the_background_is_exposed_with_the_geometry() {
    let Some(gpu) = gpu() else { return };
    // No sky pass: the clear colour is the background. A blinding sun meters the scene far down;
    // the background must darken with everything else, as a Live frame converged on it shows.
    let corner = |capture: &Capture| capture.bgra()[..3].to_vec();
    let frame_under = |sun: f32| {
        let mut frame = ImmediateFrame::new(camera(), [128, 128, 128, 255]);
        frame.mesh(MeshId::CUBE, scaled([0.0, -0.05, 0.0], [8.0, 0.1, 8.0]), Material::color([110, 110, 120, 255]));
        frame.lighting_mut().sun_intensity = sun;
        frame
    };
    let settled = |sun: f32| {
        let mut renderer = auto_exposed(&gpu);
        let frames = genex_render::settle::settle_frames(renderer.renderer().quality(), renderer.renderer().look(), true);
        renderer.render_settled(&gpu, &frame_under(sun), CullPath::Gpu, None, frames).expect("settled");
        renderer.capture(&gpu).expect("capture")
    };
    let (dim, blinding) = (settled(1.0), settled(60.0));
    assert!(corner(&blinding)[1] + 20 < corner(&dim)[1], "the background darkens with the metered scene: {:?} vs {:?}", corner(&blinding), corner(&dim));
    // A Live frame converged over many ticks shows the same background as the settled capture.
    let mut live = auto_exposed(&gpu);
    let mut frame = frame_under(60.0);
    for tick in 1..=900u64 {
        frame.set_tick(tick);
        live.render(&gpu, &frame, CullPath::Gpu, None).expect("live");
    }
    let converged = live.capture(&gpu).expect("capture");
    let differ = corner(&converged).iter().zip(corner(&blinding)).map(|(a, b)| a.abs_diff(b)).max().unwrap_or(0);
    assert!(differ <= 2, "Live converged {:?} against the settled capture {:?}", corner(&converged), corner(&blinding));
}

/// v2: the renderer's shading of a game texture's colour.
const TEXTURED_V2: &str = "
@group(2) @binding(1) var tex: texture_2d<f32>;
@group(2) @binding(5) var tex_sampler: sampler;

@fragment
fn fs_material(in: GxMaterialInV2) -> @location(0) vec4<f32> {
    let albedo = gx_srgb_to_linear(textureSample(tex, tex_sampler, in.uv).rgb);
    return vec4<f32>(gx_shade_pbr(gx_surface_v2(in.world_position, in.normal, albedo, 0.0, 0.6)), 1.0);
}
";

/// v2 post at stage hdr: a warm grade of the scene, exposure-aware.
const WARM_V2: &str = "
@fragment
fn fs_post(in: GxPostInV2) -> @location(0) vec4<f32> {
    let c = textureLoad(gx_scene, vec2<i32>(in.position.xy), 0).rgb;
    return vec4<f32>(c * vec3<f32>(1.1, 1.0, 0.85) + gx_expose(vec3<f32>(0.01, 0.005, 0.0)), 1.0);
}
";

/// What the presenter hands the renderer every frame: the HDR scene, its quality and an auto-exposure look.
fn apply_hdr_auto(renderer: &mut FrameRenderer) {
    let mut quality = Quality::off();
    quality.hdr = true;
    quality.tonemap = true;
    quality.exposure = true;
    renderer.renderer_mut().set_quality(&quality);
    renderer.renderer_mut().set_scene_format(SceneFormat::Rgba16Float);
    let mut look = *renderer.renderer().look();
    look.exposure = genex_render::settings::ExposureMode::Auto;
    renderer.renderer_mut().set_look(look);
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_device_loss_replays_v2_sources_with_their_api_stage_and_textures_on_the_hdr_path() {
    let Some(gpu) = gpu() else { return };
    let mut resilient = genex_render::device_loss::Resilient::new(gpu, WIDTH, HEIGHT, RenderOptions::default(), Gpu::headless).expect("resilient");
    let checker = genex_render::texture::TextureData::rgba8(2, 2, vec![230, 80, 40, 255, 40, 80, 230, 255, 40, 80, 230, 255, 230, 80, 40, 255]).expect("checker");
    let textured = resilient.add_material_api(ABI_V2, TEXTURED_V2, &[], std::slice::from_ref(&checker)).expect("a v2 material with a game texture");
    let warm = resilient.add_post_pass_api(ABI_V2, PostStage::Hdr, WARM_V2, &[], &[]).expect("a v2 post pass at stage hdr");
    let build = || {
        let mut frame = base_frame();
        frame.custom(MeshId::CUBE, scaled([0.0, 0.75, 0.0], [1.5, 1.5, 1.5]), textured, [255, 255, 255, 255]);
        frame.post_pass(warm);
        frame
    };
    let settled = |resilient: &mut genex_render::device_loss::Resilient| {
        let (gpu, renderer) = resilient.parts_mut();
        apply_hdr_auto(renderer);
        let frames = genex_render::settle::settle_frames(renderer.renderer().quality(), renderer.renderer().look(), true);
        renderer.render_settled(gpu, &build(), CullPath::Gpu, None, frames).expect("settled");
        let path = renderer.renderer().last_scene().expect("a frame");
        assert!(path.hdr, "the v2 sources keep the frame on the HDR scene: {path:?}");
        assert_eq!(renderer.ldr_reason(), None, "the material is still api 2: no v1 degrade");
        resilient.capture().expect("capture")
    };
    let before = settled(&mut resilient);
    resilient.force_device_loss();
    assert!(resilient.recover().expect("recovered"), "a lost device is re-created");
    let after = settled(&mut resilient);
    assert_eq!(after.digest(), before.digest(), "the replayed api, stage and texture draw the identical settled capture");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_post_pass_scratch_copy_counts_in_the_held_bytes() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = hdr_renderer(&gpu);
    let red = renderer.add_post_pass_api(&gpu, ABI_V2, PostStage::Hdr, BLINDING_RED_V2, &[], &[]).expect("a v2 hdr post pass");
    draw(&gpu, &mut renderer, &base_frame());
    let pooled = renderer.renderer().targets().ledger().total();
    assert_eq!(renderer.held_bytes(), pooled, "no post pass ran: nothing beside the pool");
    let mut frame = base_frame();
    frame.post_pass(red);
    draw(&gpu, &mut renderer, &frame);
    let pooled = renderer.renderer().targets().ledger().total();
    let scratch = u64::from(WIDTH) * u64::from(HEIGHT) * 8;
    assert_eq!(renderer.held_bytes(), pooled + scratch, "the hdr-stage pass's rgba16float copy of the scene is held");
}

// ---------------------------------------------------------------------------------------------
// Renderer pass 2, P2-0.14 (RC-02, RC-16 row 2; LG-08/S9).

/// A `before-cull` pass that records nothing: its stage alone used to submit the frame's v1/v2
/// refresh ahead of the frame encoder that copies the adapted exposure into the frame uniforms.
#[derive(Default)]
struct Idle;

impl CustomPass for Idle {
    fn rebuild(&mut self, _setup: &mut PassSetup<'_>) -> Result<(), RenderError> {
        Ok(())
    }

    fn encode(&mut self, _frame: &mut PassFrame<'_>) {}

    fn api(&self) -> u32 {
        2
    }
}

/// v2 `post-hdr`: `gx_frame.pre_exposure` in green over the scene's first 2 x 2 texels (the
/// metering barely sees them).
const PRE_EXPOSURE_V2: &str = "
@group(0) @binding(0) var<uniform> gx_frame: GxFrameV2;

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
    if in.position.x > 2.0 || in.position.y > 2.0 {
        discard;
    }
    return vec4<f32>(0.0, gx_frame.pre_exposure, 0.0, 1.0);
}
";

/// A v2 `post-hdr` pass drawing [`PRE_EXPOSURE_V2`] into the scene it is handed.
#[derive(Default)]
struct PreExposureProbe {
    pipeline: Option<wgpu::RenderPipeline>,
}

impl CustomPass for PreExposureProbe {
    fn rebuild(&mut self, setup: &mut PassSetup<'_>) -> Result<(), RenderError> {
        let module = setup.create_shader("pre-exposure probe", PRE_EXPOSURE_V2)?;
        let layout = setup.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("pre-exposure probe"),
            bind_group_layouts: &[Some(setup.tables_layout())],
            immediate_size: 0,
        });
        let targets = [Some(wgpu::ColorTargetState { format: setup.world_format(), blend: None, write_mask: wgpu::ColorWrites::ALL })];
        self.pipeline = Some(setup.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("pre-exposure probe"),
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

    fn encode(&mut self, frame: &mut PassFrame<'_>) {
        let Some(pipeline) = self.pipeline.clone() else { return };
        let tables = frame.tables().clone();
        let Some(view) = frame.world_view().cloned() else { return };
        let Some(encoder) = frame.encoder() else { return };
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("pre-exposure probe"),
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
}

/// The `gx_frame.pre_exposure` a v2 `post-hdr` pass reads after `ticks` frames of a scene under a
/// blinding sun with auto exposure, with or without a `before-cull` pass registered.
fn pre_exposure_seen(gpu: &Gpu, before_cull: bool, ticks: u64) -> f32 {
    let mut renderer = auto_exposed(gpu);
    let mut passes = CustomPasses::new(gpu, renderer.renderer(), wgpu::Features::empty());
    let (mut probe, mut idle) = (PreExposureProbe::default(), Idle);
    passes.register(gpu, "probe", PassStage::PostHdr, &mut probe).expect("a v2 post-hdr probe");
    if before_cull {
        passes.register(gpu, "idle", PassStage::BeforeCull, &mut idle).expect("a v2 before-cull pass");
    }
    let facts = renderer.pipeline_facts(passes.ldr_reason());
    let mut frame = ImmediateFrame::new(camera(), [128, 128, 128, 255]);
    frame.mesh(MeshId::CUBE, scaled([0.0, -0.05, 0.0], [8.0, 0.1, 8.0]), Material::color([110, 110, 120, 255]));
    frame.lighting_mut().sun_intensity = 60.0;
    {
        let mut list: Vec<&mut dyn CustomPass> = if before_cull { vec![&mut probe, &mut idle] } else { vec![&mut probe] };
        passes.set_pipeline_facts(gpu, &mut list[..], facts).expect("facts");
    }
    passes.set_render_size(renderer.renderer().render_size());
    for tick in 1..=ticks {
        frame.set_tick(tick);
        let mut list: Vec<&mut dyn CustomPass> = if before_cull { vec![&mut probe, &mut idle] } else { vec![&mut probe] };
        let mut run = passes.frame(gpu, &mut list[..], tick).expect("frame passes");
        renderer.render_with(gpu, &frame, CullPath::Gpu, None, &mut run).expect("frame");
        drop(run);
    }
    assert!(passes.refusals().is_empty(), "{:?}", passes.refusals());
    renderer.renderer().read_scene(gpu).expect("the HDR scene")[0][1]
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_before_cull_pass_leaves_v2_passes_the_adapted_pre_exposure() {
    let Some(gpu) = gpu() else { return };
    let alone = pre_exposure_seen(&gpu, false, 60);
    assert!(alone > 0.0 && alone < 0.5, "auto exposure adapted down under the blinding sun: {alone}");
    let beside_before_cull = pre_exposure_seen(&gpu, true, 60);
    assert!(
        (beside_before_cull - alone).abs() <= alone * 0.01,
        "a before-cull pass gave the v2 frame pre-exposure {beside_before_cull} against {alone} without it (the CPU's 1.0 is the refresh read before the exposure copy)"
    );
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_particles_draw_under_a_camera_looking_straight_down() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = hdr_renderer(&gpu);
    let emitter = renderer.add_emitter(&gpu, EmitterDesc::fountain([0.0, 0.5, 0.0], 7)).expect("emitter");
    // A top-down camera whose up is the world's -z: forward is straight down the world's y axis.
    let mut camera = CameraDesc::look_at([0.0, 9.0, 0.0], [0.0, 0.0, 0.0]);
    camera.up = [0.0, 0.0, -1.0];
    let ground = |camera: CameraDesc, particles: bool| {
        let mut frame = ImmediateFrame::new(camera, [20, 24, 32, 255]);
        frame.mesh(MeshId::CUBE, scaled([0.0, -0.05, 0.0], [8.0, 0.1, 8.0]), Material::color([110, 110, 120, 255]));
        if particles {
            frame.particles(emitter, 30);
        }
        frame
    };
    let plain = draw(&gpu, &mut renderer, &ground(camera, false));
    let with_particles = draw(&gpu, &mut renderer, &ground(camera, true));
    // Pixels a billboard covers (more than the frame-keyed dither moves).
    let covered = |a: &Capture, b: &Capture| a.bgra().chunks(4).zip(b.bgra().chunks(4)).filter(|(x, y)| (0..3).any(|c| x[c].abs_diff(y[c]) > 8)).count();
    let changed = covered(&plain, &with_particles);
    // The same fountain from a camera a little off the vertical, where the old basis held.
    camera.eye = [0.0, 9.0, 0.9];
    let tilted = draw(&gpu, &mut renderer, &ground(camera, true));
    let tilted_plain = draw(&gpu, &mut renderer, &ground(camera, false));
    let tilted_changed = covered(&tilted_plain, &tilted);
    eprintln!("straight down: {changed} pixels changed; tilted: {tilted_changed}");
    assert!(tilted_changed > 20 && changed * 2 > tilted_changed, "the fountain's billboards draw seen from straight above ({changed} pixels changed, {tilted_changed} from a tilted camera)");
}
