//! WP-9: the explicit resolution tiers (`presets::ResolutionPreset`). Native 4K draws every one of
//! 3840x2160 pixels at `ultra` with the 4096 texture class; the cinematic tier every one of
//! 7680x4320 with the 8192 class. A native desktop takes the tier as named; a browser and a phone
//! hold it to their own caps.
//!
//! The CPU rows run everywhere. The GPU row is `#[ignore]`d and its name contains `metal`; it draws
//! a sunlit yard of boxes and spheres on a 4096-textured ground at each tier's output, times the
//! GPU per frame (timestamp queries) and prints one JSON row per tier:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --release --offline --locked --test resolution_presets -- --ignored metal --test-threads=1
//!
//! `GENEX_RENDER_EVIDENCE_DIR` receives each tier's last frame (raw BGRA, `<tier>-WxH.bgra`).

use genex_render::device_class::{DeviceClass, DeviceFacts, FormFactor, PerformanceTier, TargetOs};
use genex_render::presets::{ClassOverride, RenderOverrides, ResolutionPreset, profile, render_scale_max, step_size};
use genex_render::scene::{CameraDesc, Material, MeshId, Scene};
use genex_render::settings::{QualityPreset, RENDER_SCALE_SUPERSAMPLE_MAX, RenderSettings, SceneFormat, TextureClass};
use genex_render::texture::{TextureData, TextureKind};
use genex_render::{CullPath, Gpu, RenderOptions, Renderer};
use glam::{Mat4, Vec3};

const GIB: u64 = 1024 * 1024 * 1024;
/// Frames drawn before timing: a whole ultra jitter cycle and the auto exposure's settle.
const WARM_FRAMES: u32 = 24;
/// Frames timed per tier.
const TIMED_FRAMES: u32 = 40;
/// Frames drawn after the last timed one so its timestamps land.
const LANDING_FRAMES: u32 = 4;

fn ultra() -> DeviceClass {
    DeviceClass::new(FormFactor::Desktop, PerformanceTier::Ultra)
}

/// A 36 GB Apple-silicon Mac (Metal recommends about 27 GB).
fn mac() -> DeviceFacts {
    DeviceFacts::new(TargetOs::MacOs, wgpu::Backend::Metal, wgpu::DeviceType::IntegratedGpu).with_gpu_visible_memory(Some(27 * GIB))
}

/// `tier` as a game's every-class table, on `facts` as `class`.
fn at_tier(facts: &DeviceFacts, class: DeviceClass, tier: ResolutionPreset) -> genex_render::presets::RenderProfile {
    let game = RenderOverrides { classes: vec![(class, tier.class_override())], ..RenderOverrides::default() };
    profile(facts, class, &game, None)
}

#[test]
fn a_tier_is_ultra_at_scale_one_with_its_texture_class_and_rate_on_a_native_desktop() {
    for tier in ResolutionPreset::ALL {
        let resolved = at_tier(&mac(), ultra(), tier);
        assert_eq!(resolved.preset, QualityPreset::Ultra, "{}", tier.wire());
        assert_eq!(resolved.quality.render_scale, 1.0, "{}", tier.wire());
        assert_eq!(resolved.quality.textures.max_class, tier.texture_class(), "{}", tier.wire());
        assert_eq!(resolved.target_fps, tier.target_fps(), "{}", tier.wire());
        assert_eq!(ResolutionPreset::from_wire(tier.wire()), Some(tier));
        let (width, height) = tier.output();
        assert!(width <= genex_render::caps::MAX_WORLD_PX && height <= genex_render::caps::MAX_WORLD_PX, "{}: a native target holds it", tier.wire());
    }
    assert_eq!(ResolutionPreset::Native4k.output(), (3840, 2160));
    assert_eq!(ResolutionPreset::Cinematic8k.output(), (7680, 4320));
    assert_eq!(ResolutionPreset::from_wire("8k"), None);
}

#[test]
fn a_browser_and_a_phone_hold_a_tier_to_their_own_texture_caps() {
    let hints = genex_render::device_class::WebHints { device_memory_gb: Some(8.0), hardware_concurrency: Some(8), ..Default::default() };
    let browser = DeviceFacts::new(TargetOs::Web, wgpu::Backend::BrowserWebGpu, wgpu::DeviceType::Other).with_web(hints);
    let phone = DeviceFacts::new(TargetOs::Ios, wgpu::Backend::Metal, wgpu::DeviceType::IntegratedGpu);
    let mobile = DeviceClass::new(FormFactor::Mobile, PerformanceTier::High);
    for tier in ResolutionPreset::ALL {
        assert_eq!(at_tier(&browser, ultra(), tier).quality.textures.max_class, TextureClass::S2048, "{}", tier.wire());
        assert_eq!(at_tier(&phone, mobile, tier).quality.textures.max_class, TextureClass::S1024, "{}", tier.wire());
    }
}

// Supersampling (WP-9: render scale up to 2.0 on a native desktop-ultra).
#[test]
fn only_a_native_desktop_ultra_supersamples_up_to_twice_the_output() {
    let twice = ClassOverride { render_scale: Some(3.0), ..ClassOverride::default() };
    let hints = genex_render::device_class::WebHints { device_memory_gb: Some(8.0), hardware_concurrency: Some(8), ..Default::default() };
    let browser = DeviceFacts::new(TargetOs::Web, wgpu::Backend::BrowserWebGpu, wgpu::DeviceType::Other).with_web(hints);
    let high = DeviceClass::new(FormFactor::Desktop, PerformanceTier::High);
    let rows = [(mac(), ultra(), RENDER_SCALE_SUPERSAMPLE_MAX), (mac(), high, 1.0), (browser.clone(), ultra(), 1.0)];
    for (facts, class, most) in rows {
        assert_eq!(render_scale_max(class, facts.os), most, "{} on {:?}", class.wire(), facts.os);
        let resolved = profile(&facts, class, &RenderOverrides::default(), Some(&twice));
        assert_eq!(resolved.quality.render_scale, most, "{} on {:?}: held to its most", class.wire(), facts.os);
    }
    assert_eq!(RENDER_SCALE_SUPERSAMPLE_MAX, 2.0);
}

#[test]
fn a_supersampled_frame_draws_twice_the_output_a_side_within_the_target_cap() {
    let config = |output: (u32, u32), scale: f32| RenderSettings::off().frame_config(output, scale, 0, false).render_size;
    assert_eq!(config((1920, 1080), 2.0), (3840, 2160));
    assert_eq!(config((1920, 1080), 1.5), (2880, 1620));
    assert_eq!(config((1920, 1080), 9.0), (3840, 2160), "never past twice");
    assert_eq!(config((6000, 3000), 2.0), (genex_render::caps::MAX_WORLD_PX, 6000), "never past the target cap");
    assert_eq!(config((1920, 1080), 0.5), (960, 540), "below 1 as before");
    assert_eq!(config((1920, 1080), f32::NAN), (1920, 1080));
    assert_eq!(step_size((1920, 1080), 2.0), (3840, 2160), "the DRS steps' sizes follow");
    assert_eq!(step_size((1920, 1080), 0.75), (1440, 810));
}

// ---------------------------------------------------------------------------------------------
// GPU

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

fn transform(at: Vec3, yaw: f32, scale: Vec3) -> [f32; 16] {
    (Mat4::from_translation(at) * Mat4::from_rotation_y(yaw) * Mat4::from_scale(scale)).to_cols_array()
}

/// A 4096 ground texture: a fine two-tone weave over a coarse tile grid, so the top mip shows.
fn ground_texture() -> TextureData {
    const SIDE: u32 = 4096;
    let mut rgba = Vec::with_capacity((SIDE * SIDE * 4) as usize);
    for y in 0..SIDE {
        for x in 0..SIDE {
            let weave = ((x / 2) ^ (y / 2)) & 1 == 0;
            let grout = x % 512 < 6 || y % 512 < 6;
            let level: u8 = if grout { 40 } else if weave { 182 } else { 150 };
            rgba.extend([level, level - 12, level - 30, 255]);
        }
    }
    TextureData::rgba8(SIDE, SIDE, rgba).expect("ground texture")
}

/// A yard: the textured ground, 60 boxes and 20 spheres under a low sun.
fn yard(ground: Material) -> Scene {
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 3.2, 12.0], [0.0, 0.8, 0.0]), [130, 160, 200, 255]);
    scene.lighting.sun_dir = Vec3::new(-0.45, 0.55, 0.35).normalize().to_array();
    scene.draw(MeshId::CUBE, transform(Vec3::new(0.0, -0.05, 0.0), 0.0, Vec3::new(60.0, 0.1, 60.0)), ground);
    let boxes: Vec<[f32; 16]> =
        (0..60).map(|i| transform(Vec3::new((i % 10) as f32 * 2.2 - 10.0, 0.5, -(i / 10) as f32 * 2.5), i as f32 * 0.37, Vec3::new(0.8, 1.0, 0.8))).collect();
    scene.draw_instanced(MeshId::CUBE, &boxes, Material::color([170, 120, 90, 255]).with_pbr(0.0, 0.5));
    let spheres: Vec<[f32; 16]> = (0..20).map(|i| transform(Vec3::new((i % 5) as f32 * 3.0 - 6.0, 0.6, 3.0 - (i / 5) as f32 * 4.0), 0.0, Vec3::splat(1.2))).collect();
    scene.draw_instanced(MeshId::SPHERE, &spheres, Material::color([200, 205, 215, 255]).with_pbr(1.0, 0.25));
    scene
}

/// The `p`-th percentile of `samples` (sorted in place).
fn percentile(samples: &mut [f32], p: f32) -> f32 {
    samples.sort_by(f32::total_cmp);
    let at = ((samples.len() - 1) as f32 * p).round() as usize;
    samples[at]
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_each_resolution_tier_draws_its_whole_output_natively_and_reports_its_gpu_time() {
    let Some(gpu) = gpu() else { return };
    let texture = ground_texture();
    let receipt = gpu.receipt();
    for tier in ResolutionPreset::ALL {
        let resolved = at_tier(&mac(), ultra(), tier);
        let (width, height) = tier.output();
        let mut renderer = Renderer::with_options(&gpu, width, height, RenderOptions { msaa: false }).expect("renderer");
        renderer.set_scene_format(SceneFormat::Rgba16Float);
        renderer.set_device_class(ultra());
        renderer.set_quality(&resolved.quality);
        renderer.set_render_scale(1.0);
        let ground = renderer.add_texture(&gpu, &texture, TextureKind::Color).expect("ground texture");
        assert_eq!(ground.class(), TextureClass::S4096, "{}: the 4096 map keeps its side", tier.wire());
        let scene = yard(Material::color([255, 255, 255, 255]).with_base_texture(ground).with_pbr(0.0, 0.8));
        for _ in 0..WARM_FRAMES {
            renderer.render(&gpu, &scene, CullPath::Gpu).expect("warm frame");
        }
        let mut gpu_ms = Vec::new();
        for frame in 0..TIMED_FRAMES + LANDING_FRAMES {
            let landed = renderer.arm_frame_timer(&gpu.queue);
            if frame >= LANDING_FRAMES {
                gpu_ms.extend(landed.unwrap_or_default());
            }
            renderer.render(&gpu, &scene, CullPath::Gpu).expect("timed frame");
            renderer.finish_frame_timer();
            let _ = gpu.device.poll(wgpu::PollType::wait_indefinitely());
        }
        let capture = renderer.capture(&gpu).expect("capture");
        assert_eq!((capture.width(), capture.height()), (width, height), "{}: the whole output is drawn", tier.wire());
        let lit = capture.bgra().as_chunks::<4>().0.iter().filter(|p| p[1] > 8).count();
        assert!(lit > (width * height / 2) as usize, "{}: the frame is drawn ({lit} lit pixels)", tier.wire());
        if let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") {
            std::fs::create_dir_all(&dir).expect("evidence folder");
            std::fs::write(std::path::Path::new(&dir).join(format!("{}-{width}x{height}.bgra", tier.wire())), capture.bgra()).expect("evidence written");
        }
        let timed = gpu_ms.len();
        let (p50, p95) = if timed == 0 { (f32::NAN, f32::NAN) } else { (percentile(&mut gpu_ms, 0.5), percentile(&mut gpu_ms, 0.95)) };
        eprintln!(
            "{{\"row\":\"wp9-resolution-tier\",\"tier\":\"{}\",\"output\":[{width},{height}],\"preset\":\"{}\",\"textures\":{},\"backend\":\"{}\",\"adapter\":\"{}\",\"frames\":{timed},\"gpuMsP50\":{p50:.3},\"gpuMsP95\":{p95:.3}}}",
            tier.wire(),
            resolved.preset.wire(),
            resolved.quality.textures.max_class.side(),
            receipt.backend,
            receipt.adapter
        );
        if gpu.device.features().contains(wgpu::Features::TIMESTAMP_QUERY) {
            assert!(timed > 0, "{}: frames timed where timestamps are offered", tier.wire());
        }
    }
}

/// Luma (0-255) of each pixel of a BGRA capture.
fn lumas(bgra: &[u8]) -> Vec<f32> {
    bgra.as_chunks::<4>().0.iter().map(|p| 0.0722 * f32::from(p[0]) + 0.7152 * f32::from(p[1]) + 0.2126 * f32::from(p[2])).collect()
}

/// `luma` (`width` wide) averaged over 2x2 blocks.
fn box_down(luma: &[f32], width: usize) -> Vec<f32> {
    let height = luma.len() / width;
    (0..height / 2).flat_map(|y| (0..width / 2).map(move |x| (x, y))).map(|(x, y)| {
        let at = |dx: usize, dy: usize| luma[(2 * y + dy) * width + 2 * x + dx];
        (at(0, 0) + at(1, 0) + at(0, 1) + at(1, 1)) / 4.0
    }).collect()
}

fn mean_abs(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| (x - y).abs()).sum::<f32>() / a.len() as f32
}

/// Thin geometry against the sky: 200 posts a centimetre wide, aliasing at 1x.
fn posts() -> Scene {
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 1.2, 8.0], [0.0, 1.0, 0.0]), [130, 160, 200, 255]);
    scene.lighting.sun_dir = Vec3::new(-0.45, 0.55, 0.35).normalize().to_array();
    let posts: Vec<[f32; 16]> = (0..200).map(|i| transform(Vec3::new(i as f32 * 0.07 - 7.0, 1.0, -(i % 7) as f32 * 0.4), 0.3, Vec3::new(0.012, 2.0, 0.012))).collect();
    scene.draw_instanced(MeshId::CUBE, &posts, Material::color([40, 35, 30, 255]).with_pbr(0.0, 0.6));
    scene
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_frame_at_scale_two_matches_the_box_filtered_frame_of_twice_the_output() {
    let Some(gpu) = gpu() else { return };
    const OUTPUT: (u32, u32) = (480, 270);
    let quality = at_tier(&mac(), ultra(), ResolutionPreset::Native4k).quality;
    let draw = |output: (u32, u32), scale: f32| {
        let mut renderer = Renderer::with_options(&gpu, output.0, output.1, RenderOptions { msaa: false }).expect("renderer");
        renderer.set_scene_format(SceneFormat::Rgba16Float);
        renderer.set_device_class(ultra());
        renderer.set_quality(&quality);
        renderer.set_render_scale(scale);
        for _ in 0..WARM_FRAMES {
            renderer.render(&gpu, &posts(), CullPath::Gpu).expect("frame");
        }
        renderer.capture(&gpu).expect("capture")
    };
    let supersampled = draw(OUTPUT, 2.0);
    let native = draw(OUTPUT, 1.0);
    let reference = draw((OUTPUT.0 * 2, OUTPUT.1 * 2), 1.0);
    assert_eq!((supersampled.width(), supersampled.height()), OUTPUT, "the output keeps its size");
    let reference = box_down(&lumas(reference.bgra()), (OUTPUT.0 * 2) as usize);
    let (ss, one) = (mean_abs(&lumas(supersampled.bgra()), &reference), mean_abs(&lumas(native.bgra()), &reference));
    if let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") {
        std::fs::create_dir_all(&dir).expect("evidence folder");
        std::fs::write(std::path::Path::new(&dir).join(format!("supersampled-{}x{}.bgra", OUTPUT.0, OUTPUT.1)), supersampled.bgra()).expect("evidence");
        std::fs::write(std::path::Path::new(&dir).join(format!("native-{}x{}.bgra", OUTPUT.0, OUTPUT.1)), native.bgra()).expect("evidence");
    }
    eprintln!("{{\"row\":\"wp9-supersample\",\"meanAbsVsBox2x\":{ss:.3},\"nativeMeanAbsVsBox2x\":{one:.3}}}");
    assert!(ss < one, "scale 2 is nearer the 2x frame box-filtered ({ss}) than scale 1 is ({one})");
    assert!(ss < 3.0, "within 3 levels of it ({ss})");
}
