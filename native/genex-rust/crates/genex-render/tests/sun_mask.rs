//! Renderer pass 2, B.7 (SH-04): the sun's soft shadow edges hold still under a moving camera.
//! The forward pass evaluated PCSS inline with a tap pattern the frame key turns under TAA and left
//! the noise to the colour TAA, whose clip box holds a shadow edge badly over textured ground: the
//! penumbrae boiled on a still camera, crept on a creeping one and popped for single frames on a
//! pan. The rows draw a fence of thin posts and a lintel under a low, 1.5 degree sun over gravel
//! at desktop high and ultra, against the same frames with the sun's shadows off, and hold,
//! over the flat ground (away from every silhouette in the shadowless frame, where TAA's jitter
//! flickers a sunlit post's edge whatever the shadows do):
//!
//! - the shadows' flicker on a creeping camera at high and ultra no greater than at medium (static
//!   3x3 PCF under MSAA; B.7's acceptance and the GB1 gate's "shadow-mask flicker <= medium");
//! - the same on a still camera, pixel for pixel (the inline path's red row: 0.0051% at high and
//!   0.0106% at ultra; the mask leaves 0.0004% and 0.0014%, still over medium's none);
//! - zero one-frame shadow pops on a 2 px a frame pan at high and ultra (owner decision D9).
//!
//! The CPU rows run everywhere. The GPU rows are `#[ignore]`d and every name contains `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked --test sun_mask -- --ignored metal --test-threads 1
//!
//! `GENEX_RENDER_EVIDENCE_DIR` receives each row's record (JSON) and the last frame of each run
//! with the shadow-attributed pops painted magenta (raw BGRA).

use std::path::PathBuf;

use genex_render::capture::Capture;
use genex_render::device_class::{DeviceClass, FormFactor, PerformanceTier};
use genex_render::presets::preset_quality;
use genex_render::scene::{CameraDesc, Material, MeshId, Scene, scaled};
use genex_render::settings::{AntiAliasing, AoResolution, Environment, Quality, QualityPreset, SceneFormat, SkyParams};
use genex_render::texture::{TextureData, TextureId, TextureKind};
use genex_render::{CullPath, Gpu, RenderOptions, Renderer};
use glam::Vec3;

const WIDTH: u32 = 640;
const HEIGHT: u32 = 360;
/// Frames drawn on the first pose before a row measures (TAA, the mask's history settle).
const WARM_FRAMES: u64 = 40;
/// Frames each path measures.
const PATH_FRAMES: u64 = 60;
/// A pixel pops when its luma jumps by more than this for exactly one frame (SH-15).
const POP_LEVELS: f32 = 16.0;
/// The luma change above which a pixel counts as flickering between two frames.
const FLICKER_LEVELS: f32 = 3.0;
/// The creep and the pan, pixels a frame at the screen's centre.
const CREEP_PX: f32 = 0.02;
const PAN_PX: f32 = 2.0;
/// How far each path carries a value in a frame, pixels: the envelope's radius.
const STILL_RADIUS: usize = 0;
const CREEP_RADIUS: usize = 1;
const PAN_RADIUS: usize = 3;
/// The camera's vertical field of view, degrees.
const FOVY_DEGREES: f32 = 45.0;
/// A low sun (about 12 degrees) from the left and behind the fence: long, wide penumbrae towards
/// the camera.
const SUN: [f32; 3] = [-0.75, 0.22, -0.62];
/// The sun's angular radius, degrees: a soft sky's (the real sun's 0.27 draws penumbrae a pixel
/// wide here), so PCSS spreads its taps over many texels.
const SUN_DEGREES: f32 = 1.5;
/// A pixel is flat ground when the shadowless frame's luma varies by less than this many levels
/// within [`FLAT_RADIUS`] (the showcase's drifting-lake row's test).
const FLAT_LEVELS: f32 = 12.0;
const FLAT_RADIUS: usize = 2;
const EYE: Vec3 = Vec3::new(0.0, 2.2, 7.0);
const TARGET: Vec3 = Vec3::new(0.0, 0.0, -1.0);

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

fn evidence_dir() -> Option<PathBuf> {
    let dir = PathBuf::from(std::env::var_os("GENEX_RENDER_EVIDENCE_DIR")?);
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

fn desktop_high() -> DeviceClass {
    DeviceClass::new(FormFactor::Desktop, PerformanceTier::High)
}

/// `preset` on desktop-high with the features that keep their own noise or meter the picture off
/// (AO, bloom, auto exposure), so a frame's change is the camera's and the shadows' alone; the
/// sun's shadows (and contact shadows) as `shadows` says.
fn quality(preset: QualityPreset, shadows: bool) -> Quality {
    let mut quality = preset_quality(preset, desktop_high());
    quality.ao.resolution = AoResolution::Off;
    quality.bloom.enabled = false;
    quality.exposure = false;
    quality.shadows.enabled = shadows;
    quality.contact_shadows &= shadows;
    quality
}

/// The ground's tiles: [`GROUND_TILES`] a side, [`GROUND_TILE_M`] metres each, every one wearing
/// the gravel texture once (a material has no UV scale).
const GROUND_TILES: i32 = 24;
const GROUND_TILE_M: f32 = 2.0;
/// The gravel texture's side, texels, and its luma spread either side of the ground's colour.
const GRAVEL_TEXELS: u32 = 64;
const GRAVEL_SPREAD: f32 = 12.0;

/// A gravel texture: hashed value noise at two scales around a light grey, so the colour TAA's box
/// over the ground is as wide as over real textured ground (SH-04: the noise of the turning taps
/// passes a wide box and was clipped at the shadow's edges on flat colour).
fn gravel() -> TextureData {
    let hash = |x: u32, y: u32| {
        let h = (x.wrapping_mul(374_761_393) ^ y.wrapping_mul(668_265_263)).wrapping_mul(1_274_126_177);
        ((h >> 16) & 0xff) as f32 / 255.0 - 0.5
    };
    let rgba = (0..GRAVEL_TEXELS * GRAVEL_TEXELS)
        .flat_map(|i| {
            let (x, y) = (i % GRAVEL_TEXELS, i / GRAVEL_TEXELS);
            let noise = 0.6 * hash(x, y) + 0.4 * hash(x / 4 + 1000, y / 4);
            let value = (200.0 + noise * 2.0 * GRAVEL_SPREAD).clamp(0.0, 255.0) as u8;
            [value, value, value, 255]
        })
        .collect();
    TextureData::rgba8(GRAVEL_TEXELS, GRAVEL_TEXELS, rgba).expect("gravel")
}

/// The fence: a ground of gravel tiles, eight thin posts 2 m tall, a lintel across them and a ball
/// on a post, under the low sun. Their shadows' penumbrae widen with the distance from the casters.
fn scene(camera: CameraDesc, ground: TextureId) -> Scene {
    let mut scene = Scene::new(camera, [120, 160, 210, 255]);
    scene.lighting.sun_dir = Vec3::from(SUN).normalize().to_array();
    scene.lighting.shadow_distance = 40.0;
    let tile = Material::color([196, 190, 176, 255]).with_base_texture(ground);
    for i in 0..GROUND_TILES * GROUND_TILES {
        let (col, row) = (i % GROUND_TILES - GROUND_TILES / 2, i / GROUND_TILES - GROUND_TILES / 2);
        let centre = [(col as f32 + 0.5) * GROUND_TILE_M, -0.1, (row as f32 + 0.5) * GROUND_TILE_M];
        scene.draw(MeshId::CUBE, scaled(centre, [GROUND_TILE_M, 0.2, GROUND_TILE_M]), tile);
    }
    for k in 0..8 {
        let x = -3.5 + k as f32;
        scene.draw(MeshId::CUBE, scaled([x, 1.0, -2.0], [0.06, 2.0, 0.06]), Material::color([110, 90, 70, 255]));
    }
    scene.draw(MeshId::CUBE, scaled([0.0, 2.05, -2.0], [7.2, 0.1, 0.08]), Material::color([110, 90, 70, 255]));
    scene.draw(MeshId::SPHERE, scaled([2.5, 2.4, -2.0], [0.3, 0.3, 0.3]), Material::color([160, 60, 50, 255]));
    scene
}

/// The yaw one pixel at the screen's centre turns, radians.
fn pixel_angle() -> f32 {
    2.0 * libm::tanf(FOVY_DEGREES.to_radians() * 0.5) / HEIGHT as f32
}

/// A camera path: the camera at measured frame `k` (negative while warming).
type Path = fn(f32) -> CameraDesc;

fn looking(eye: Vec3, target: Vec3) -> CameraDesc {
    let mut camera = CameraDesc::look_at(eye.to_array(), target.to_array());
    camera.fovy_degrees = FOVY_DEGREES;
    camera
}

fn still(_k: f32) -> CameraDesc {
    looking(EYE, TARGET)
}

/// Sideways at [`CREEP_PX`] a frame at the target's distance.
fn creep(k: f32) -> CameraDesc {
    let metres = k.max(0.0) * CREEP_PX * pixel_angle() * (TARGET - EYE).length();
    let side = Vec3::X * metres;
    looking(EYE + side, TARGET + side)
}

/// Turning about the eye at [`PAN_PX`] a frame.
fn pan(k: f32) -> CameraDesc {
    let angle = k.max(0.0) * PAN_PX * pixel_angle();
    let ahead = TARGET - EYE;
    let (s, c) = (libm::sinf(angle), libm::cosf(angle));
    looking(EYE, EYE + Vec3::new(ahead.x * c - ahead.z * s, ahead.y, ahead.x * s + ahead.z * c))
}

/// Rec. 709 luma (0..255) of every pixel.
fn lumas(capture: &Capture) -> Vec<f32> {
    capture.bgra().chunks(4).map(|p| 0.0722 * f32::from(p[0]) + 0.7152 * f32::from(p[1]) + 0.2126 * f32::from(p[2])).collect()
}

/// Per pixel, the least and the most value within a radius (the motion envelope).
type Envelope = (Vec<f32>, Vec<f32>);

/// The box minimum and maximum of `values` over `radius` (the motion envelope).
fn envelope(values: &[f32], radius: usize) -> Envelope {
    let (width, height) = (WIDTH as usize, HEIGHT as usize);
    let pick = |pick: fn(f32, f32) -> f32| {
        let mut out = vec![0.0; values.len()];
        for y in 0..height {
            let (y0, y1) = (y.saturating_sub(radius), (y + radius).min(height - 1));
            for x in 0..width {
                let (x0, x1) = (x.saturating_sub(radius), (x + radius).min(width - 1));
                out[y * width + x] = (y0..=y1).flat_map(|row| values[row * width + x0..=row * width + x1].iter().copied()).reduce(pick).unwrap_or(0.0);
            }
        }
        out
    };
    (pick(f32::min), pick(f32::max))
}

/// What a run of frames did: per frame, the pixels that flickered in from the frame before and the
/// pixels that popped for one frame.
struct Run {
    flickers: Vec<Vec<u32>>,
    pops: Vec<Vec<u32>>,
    /// Per measured frame, whether each pixel is flat (no silhouette within [`FLAT_RADIUS`]).
    flat: Vec<Vec<bool>>,
    last: Option<Capture>,
}

fn holds(env: &Envelope, i: usize, value: f32, levels: f32) -> bool {
    env.0[i] - value <= levels && value - env.1[i] <= levels
}

/// The scene drawn along `path` under `quality`: [`WARM_FRAMES`] on the first pose, then
/// [`PATH_FRAMES`] measured with an envelope of `radius`.
fn run(gpu: &Gpu, quality: &Quality, path: Path, radius: usize) -> Run {
    let msaa = quality.anti_aliasing == AntiAliasing::Msaa4;
    let mut renderer = Renderer::with_options(gpu, WIDTH, HEIGHT, RenderOptions { msaa }).expect("renderer");
    renderer.set_scene_format(SceneFormat::Rgba16Float);
    renderer.set_device_class(desktop_high());
    renderer.set_quality(quality);
    renderer.set_environment(&Environment::Sky(SkyParams::default().with_sun_angular_radius_degrees(SUN_DEGREES)));
    let ground = renderer.add_texture(gpu, &gravel(), TextureKind::Color).expect("the gravel");
    let mut frames: Vec<(Vec<f32>, Envelope)> = Vec::new();
    let mut out = Run { flickers: Vec::new(), pops: Vec::new(), flat: Vec::new(), last: None };
    for index in 0..WARM_FRAMES + PATH_FRAMES {
        renderer.set_frame_index(index);
        renderer.render(gpu, &scene(path(index as f32 - WARM_FRAMES as f32), ground), CullPath::Gpu).expect("frame");
        if index < WARM_FRAMES {
            continue;
        }
        let capture = renderer.capture(gpu).expect("capture");
        let luma = lumas(&capture);
        let env = envelope(&luma, radius);
        let (least, most) = envelope(&luma, FLAT_RADIUS);
        out.flat.push(least.iter().zip(&most).map(|(l, m)| m - l < FLAT_LEVELS).collect());
        if let Some((_, previous)) = frames.last() {
            out.flickers.push((0..luma.len()).filter(|i| !holds(previous, *i, luma[*i], FLICKER_LEVELS)).map(|i| i as u32).collect());
        }
        if let [.., (before, before_env), (now, _)] = frames.as_slice() {
            let popped = (0..luma.len())
                .filter(|i| {
                    let i = *i;
                    let value = now[i];
                    let came_back = holds(&env, i, before[i], POP_LEVELS) || holds(before_env, i, luma[i], POP_LEVELS);
                    !holds(before_env, i, value, POP_LEVELS) && !holds(&env, i, value, POP_LEVELS) && came_back
                })
                .map(|i| i as u32)
                .collect();
            out.pops.push(popped);
        }
        frames.push((luma, env));
        if frames.len() > 2 {
            frames.remove(0);
        }
        out.last = Some(capture);
    }
    out
}

/// What `on` adds over `off` in each frame (pixel for pixel: one scene, one path), on the pixels
/// `flat` (per frame, from the shadowless run) calls flat ground. `flat` holds every measured frame;
/// `on` and `off` start `skip` frames in (a flicker compares a frame with the one before it, a pop
/// needs one either side).
fn attributed(on: &[Vec<u32>], off: &[Vec<u32>], flat: &[Vec<bool>], skip: usize) -> Vec<Vec<u32>> {
    on.iter()
        .zip(off)
        .zip(&flat[skip..])
        .map(|((on, off), flat)| {
            let off: std::collections::BTreeSet<u32> = off.iter().copied().collect();
            on.iter().copied().filter(|i| !off.contains(i) && flat[*i as usize]).collect()
        })
        .collect()
}

/// A row's numbers: the shadows' mean flicker share, their worst single-frame pops and the sum.
#[derive(Clone, Copy, Debug)]
struct Row {
    flicker_mean: f64,
    flicker_max: f64,
    worst_pops: usize,
    pops: usize,
}

fn measure(gpu: &Gpu, name: &str, preset: QualityPreset, path: Path, radius: usize) -> Row {
    let on = run(gpu, &quality(preset, true), path, radius);
    let off = run(gpu, &quality(preset, false), path, radius);
    let pixels = f64::from(WIDTH * HEIGHT);
    let flickered = attributed(&on.flickers, &off.flickers, &off.flat, 1);
    let flicker: Vec<f64> = flickered.iter().map(|f| f.len() as f64 / pixels).collect();
    let pops = attributed(&on.pops, &off.pops, &off.flat, 1);
    let row = Row {
        flicker_mean: flicker.iter().sum::<f64>() / flicker.len().max(1) as f64,
        flicker_max: flicker.iter().copied().fold(0.0, f64::max),
        worst_pops: pops.iter().map(Vec::len).max().unwrap_or(0),
        pops: pops.iter().map(Vec::len).sum(),
    };
    let label = format!("{name}-{}", preset.wire());
    let record = format!(
        "{{\"row\": \"{label}\", \"frames\": {PATH_FRAMES}, \"radiusPx\": {radius}, \"shadowFlickerMean\": {:.6}, \"shadowFlickerMax\": {:.6}, \"worstShadowPops\": {}, \"shadowPops\": {}, \"flickerPerFrame\": {:?}}}",
        row.flicker_mean, row.flicker_max, row.worst_pops, row.pops, flickered.iter().map(Vec::len).collect::<Vec<_>>()
    );
    eprintln!("{record}");
    if let Some(dir) = evidence_dir() {
        std::fs::write(dir.join(format!("sun-mask-{label}.json")), format!("{record}\n")).expect("record");
        if let Some(last) = &on.last {
            let mut bgra = last.bgra().to_vec();
            // Cyan where the shadows flickered in any frame, magenta where they popped.
            for i in flickered.iter().flatten() {
                bgra[*i as usize * 4..*i as usize * 4 + 4].copy_from_slice(&[255, 255, 0, 255]);
            }
            for i in pops.iter().flatten() {
                bgra[*i as usize * 4..*i as usize * 4 + 4].copy_from_slice(&[255, 0, 255, 255]);
            }
            std::fs::write(dir.join(format!("sun-mask-{label}-{WIDTH}x{HEIGHT}.bgra")), bgra).expect("evidence");
        }
    }
    row
}

#[test]
fn the_fence_scene_draws_soft_shadows_at_high_and_ultra_and_static_pcf_at_medium() {
    use genex_render::settings::ShadowFilter;
    assert_eq!(quality(QualityPreset::High, true).shadows.filter, ShadowFilter::PcssLite);
    assert_eq!(quality(QualityPreset::Ultra, true).shadows.filter, ShadowFilter::Pcss);
    assert_eq!(quality(QualityPreset::Medium, true).shadows.filter, ShadowFilter::Pcf5x5);
    assert_eq!(quality(QualityPreset::Medium, true).anti_aliasing, AntiAliasing::Msaa4);
    assert!(quality(QualityPreset::High, true).anti_aliasing.temporal());
    assert!(!quality(QualityPreset::High, false).shadows.enabled && !quality(QualityPreset::High, false).contact_shadows);
}

/// The rows of `path` (`name`, envelope `radius`) at high and ultra whose shadows flicker on more
/// pixels a frame than medium's.
fn flicker_over_medium(gpu: &Gpu, name: &str, path: Path, radius: usize) -> Vec<String> {
    let medium = measure(gpu, name, QualityPreset::Medium, path, radius);
    let mut problems = Vec::new();
    for preset in [QualityPreset::High, QualityPreset::Ultra] {
        let row = measure(gpu, name, preset, path, radius);
        if row.flicker_mean > medium.flicker_mean {
            problems.push(format!("{name} {}: the shadows flicker on {:.4}% of pixels a frame, medium {:.4}%", preset.wire(), row.flicker_mean * 100.0, medium.flicker_mean * 100.0));
        }
    }
    problems
}

/// Every constant set the visibility pass compiles with: both soft filters, with and without the
/// soft cascade edges, one to four cascades.
fn every_key() -> Vec<genex_render::post::sun_mask::SunMaskKey> {
    use genex_render::post::sun_mask::SunMaskKey;
    use genex_render::settings::ShadowFilter;
    let mut keys = Vec::new();
    for filter in [ShadowFilter::PcssLite, ShadowFilter::Pcss] {
        for soft_edges in [false, true] {
            keys.extend((1..=4).map(|cascades| SunMaskKey { filter, soft_edges, cascades }));
        }
    }
    keys
}

/// `source` (`name`) validated against WebGPU core and written as HLSL SM 5.1, MSL 2.4 and SPIR-V
/// 1.3 with `constants` (the tests/layout.rs row every renderer shader passes).
fn emits_everywhere(name: &str, source: &str, constants: &[(&str, f64)]) {
    use naga::back::{hlsl, msl, spv};
    let module = naga::front::wgsl::parse_str(source).unwrap_or_else(|error| panic!("{name}: {}", error.emit_to_string(source)));
    // WebGPU core reads cube arrays (A.3's probes bind the specular cube as one, and the mask's
    // visibility pass is appended to the forward module); compatibility mode does not.
    let core = naga::valid::Capabilities::CUBE_ARRAY_TEXTURES;
    let info = naga::valid::Validator::new(naga::valid::ValidationFlags::all(), core)
        .validate(&module)
        .unwrap_or_else(|error| panic!("{name} needs more than WebGPU core: {error:?}"));
    let constants: naga::back::PipelineConstants = constants.iter().map(|(key, value)| ((*key).to_owned(), *value)).collect();
    let (module, info) = naga::back::pipeline_constants::process_overrides(&module, &info, None, &constants).unwrap_or_else(|error| panic!("{name}: overrides: {error:?}"));
    let mut hlsl_source = String::new();
    let options = hlsl::Options { shader_model: hlsl::ShaderModel::V5_1, ..Default::default() };
    hlsl::Writer::new(&mut hlsl_source, &options, &hlsl::PipelineOptions::default()).write(&module, &info, None).unwrap_or_else(|error| panic!("{name}: HLSL: {error:?}"));
    let options = msl::Options { lang_version: (2, 4), ..Default::default() };
    msl::write_string(&module, &info, &options, &msl::PipelineOptions::default()).unwrap_or_else(|error| panic!("{name}: MSL: {error:?}"));
    let options = spv::Options { lang_version: (1, 3), ..Default::default() };
    spv::write_vec(&module, &info, &options, None).unwrap_or_else(|error| panic!("{name}: SPIR-V: {error:?}"));
}

#[test]
fn the_mask_s_passes_emit_hlsl_msl_and_spirv_for_every_key() {
    use genex_render::post::sun_mask::{DENOISE, visibility_constants, visibility_source};
    let visibility = visibility_source();
    for key in every_key() {
        emits_everywhere(&format!("sun mask visibility {key:?}"), &visibility, &visibility_constants(key));
    }
    emits_everywhere("sun mask denoise", DENOISE, &[]);
}

#[test]
fn the_forward_pass_and_the_v2_prelude_both_offer_the_screen_shadow_accessor() {
    use genex_render::shaders::{FORWARD, MATERIAL_V2_PRELUDE};
    let functions = |source: &str| -> Vec<String> {
        let module = naga::front::wgsl::parse_str(source).unwrap_or_else(|error| panic!("{}", error.emit_to_string(source)));
        module.functions.iter().filter_map(|(_, f)| f.name.clone()).collect()
    };
    let v2 = format!("{MATERIAL_V2_PRELUDE}\n@fragment fn fs_material(in: GxMaterialInV2) -> @location(0) vec4<f32> {{ return in.tint; }}");
    for (name, offered) in [("forward", functions(FORWARD)), ("material v2", functions(&v2))] {
        assert!(offered.iter().any(|f| f == "gx_sun_screen_shadow"), "{name} offers gx_sun_screen_shadow");
    }
}

#[test]
fn every_mask_target_is_one_webgpu_core_guarantees() {
    for desc in genex_render::post::sun_mask::targets((1920, 1080)) {
        assert_eq!(genex_render::target_pool::validate(&desc), Ok(()), "{} {:?}", desc.label, desc.format);
    }
}

/// B.7 acceptance: on a creeping camera the soft shadows flicker no more at high and ultra than
/// medium's static 3x3 PCF does.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_soft_shadow_edges_flicker_no_more_at_high_and_ultra_than_at_medium_while_the_camera_creeps() {
    let Some(gpu) = gpu() else { return };
    let problems = flicker_over_medium(&gpu, "creep", creep, CREEP_RADIUS);
    assert!(problems.is_empty(), "{problems:#?}");
}

/// The same on a still camera, pixel for pixel. The inline path flickered on 0.0051% of pixels a
/// frame at high and 0.0106% at ultra; the mask leaves 0.0004% and 0.0014%, a pixel or three a
/// frame along the thin post shadows near their feet, so the row stays red (open): the mask's
/// texels change by an LSB or two a frame there, and a mask frozen after its first frame still
/// flickers (more: its first frame is noisier), so what is left is TAA's resolve of the mask's sharp
/// per-pixel steps.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_soft_shadow_edges_flicker_no_more_at_high_and_ultra_than_at_medium_on_a_still_camera() {
    let Some(gpu) = gpu() else { return };
    let problems = flicker_over_medium(&gpu, "still", still, STILL_RADIUS);
    assert!(problems.is_empty(), "{problems:#?}");
}

/// D9 on the fence: the soft shadows pop no pixel for a single frame on a 2 px a frame pan at high
/// and ultra.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_soft_shadows_pop_no_pixel_on_a_pan_at_high_and_ultra() {
    let Some(gpu) = gpu() else { return };
    let mut problems = Vec::new();
    for preset in [QualityPreset::High, QualityPreset::Ultra] {
        let row = measure(&gpu, "pan", preset, pan, PAN_RADIUS);
        if row.worst_pops > 0 {
            problems.push(format!("pan {}: the shadows pop {} pixels for one frame ({} over the path)", preset.wire(), row.worst_pops, row.pops));
        }
    }
    assert!(problems.is_empty(), "{problems:#?}");
}

/// The mask's budget at 1080p (TIER-AB plan B.7), GPU ms: its denoise and the visibility pass's
/// reads (the PCSS it evaluates is what the forward pass no longer does).
const MASK_BUDGET_MS: f32 = 0.5;
/// Samples the cost row takes.
const COST_SAMPLES: u32 = 30;

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_sun_mask_costs_at_most_half_a_millisecond_at_1080p() {
    use genex_render::post::sun_mask::{SunMaskKey, sun_mask_gpu_ms};
    use genex_render::settings::ShadowFilter;
    let Some(gpu) = gpu() else { return };
    let key = SunMaskKey { filter: ShadowFilter::Pcss, soft_edges: true, cascades: 4 };
    let Some(mut costs) = sun_mask_gpu_ms(&gpu, (1920, 1080), key, COST_SAMPLES).expect("cost row") else {
        eprintln!("skipped: no TIMESTAMP_QUERY");
        return;
    };
    costs.sort_by(f32::total_cmp);
    let (p50, p95) = (costs[costs.len() / 2], costs[costs.len() * 95 / 100]);
    let record = format!("{{\"row\": \"sun-mask-cost-1080p\", \"samples\": {}, \"p50Ms\": {p50:.4}, \"p95Ms\": {p95:.4}, \"budgetMs\": {MASK_BUDGET_MS}}}", costs.len());
    eprintln!("{record}");
    if let Some(dir) = evidence_dir() {
        std::fs::write(dir.join("sun-mask-cost.json"), format!("{record}\n")).expect("record");
    }
    assert!(p50 <= MASK_BUDGET_MS, "the mask costs {p50:.3} ms at 1080p (p50), over {MASK_BUDGET_MS}");
}
